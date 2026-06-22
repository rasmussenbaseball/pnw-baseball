"""Rapsodo pitch-profiling API — a private, per-coach workspace.

Every endpoint is gated to the `coach` tier and scoped to the authenticated
uploader: a coach only ever sees rows where owner_user_id = their Supabase UUID.
Players are keyed by Rapsodo's own Player ID (no roster matching). Parsing logic
lives in app.stats.rapsodo_parse. See RAPSODO_TOOL_DESIGN.md.
"""
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from ..models.database import get_connection
from ..stats.rapsodo_parse import parse_text, aggregate_arsenal
from ..stats.rapsodo_suggest import generate_suggestions
from .auth import require_tier

router = APIRouter(tags=["rapsodo"])

# pitch columns inserted per row, in order (mirrors normalize_pitch output)
_PITCH_FIELDS = [
    "pitch_no", "thrown_at", "raw_label", "pitch", "quality", "velo", "total_spin",
    "active_spin", "spin_eff", "spin_confidence", "gyro", "ivb", "hb_raw", "arm_hb",
    "movement_basis", "tilt", "tilt_deg", "rel_height", "rel_side", "extension",
    "rel_angle", "horiz_angle", "vaa", "haa", "sz_side", "sz_height",
    "bauer", "intent", "is_strike",
]


def _ingest(cur, owner, parsed):
    """Write one parsed session under `owner`. Idempotent: re-uploading the same
    filename for the same player replaces the prior session. Returns a summary."""
    rapsodo_pid = parsed.get("rapsodo_player_id") or f"name:{parsed.get('player_name') or 'unknown'}"

    cur.execute(
        """INSERT INTO rapsodo_players (owner_user_id, rapsodo_player_id, player_name, handedness)
           VALUES (%s, %s, %s, %s)
           ON CONFLICT (owner_user_id, rapsodo_player_id) DO UPDATE
             SET player_name = EXCLUDED.player_name,
                 handedness = COALESCE(EXCLUDED.handedness, rapsodo_players.handedness),
                 updated_at = now()
           RETURNING id""",
        (owner, rapsodo_pid, parsed.get("player_name"), parsed.get("handedness")),
    )
    player_db_id = cur.fetchone()["id"]

    # replace any prior upload of this same file for this player
    cur.execute(
        "DELETE FROM rapsodo_sessions WHERE owner_user_id=%s AND rapsodo_player_id=%s AND source_file=%s",
        (owner, rapsodo_pid, parsed.get("source_file")),
    )

    qc = parsed.get("qc", {})
    cur.execute(
        """INSERT INTO rapsodo_sessions
             (owner_user_id, player_db_id, rapsodo_player_id, session_date, device_serial,
              device_generation, intent_tags, fastball_velo, n_pitches,
              qc_ok, qc_low_confidence, qc_partial, qc_failed, qc_warmup, source_file)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           RETURNING id""",
        (owner, player_db_id, rapsodo_pid, parsed.get("session_date"),
         parsed.get("device_serial"), parsed.get("device_generation"),
         ", ".join(parsed.get("intent_tags") or []) or None, parsed.get("fastball_velo"),
         parsed.get("n_pitches"), qc.get("ok", 0), qc.get("low_confidence", 0),
         qc.get("partial", 0), qc.get("failed", 0), qc.get("warmup", 0),
         parsed.get("source_file")),
    )
    session_id = cur.fetchone()["id"]

    cols = "session_id, owner_user_id, player_db_id, " + ", ".join(_PITCH_FIELDS)
    ph = "%s, %s, %s, " + ", ".join(["%s"] * len(_PITCH_FIELDS))
    cur.executemany(
        f"INSERT INTO rapsodo_pitches ({cols}) VALUES ({ph})",
        [(session_id, owner, player_db_id, *[p.get(f) for f in _PITCH_FIELDS])
         for p in parsed.get("pitches", [])],
    )

    return {
        "session_id": session_id,
        "rapsodo_player_id": rapsodo_pid,
        "player_name": parsed.get("player_name"),
        "handedness": parsed.get("handedness"),
        "session_date": parsed.get("session_date"),
        "device_generation": parsed.get("device_generation"),
        "n_pitches": parsed.get("n_pitches"),
        "qc": qc,
        "arsenal": parsed.get("arsenal"),
    }


@router.post("/portal/rapsodo/upload")
async def upload_rapsodo(
    files: list[UploadFile] = File(...),
    owner: str = Depends(require_tier("coach")),
):
    """Upload one or many Rapsodo session CSVs. Each file is parsed, quality-
    checked, re-classified, and stored under the uploading coach. Returns a
    per-file report (and per-file errors for anything unparseable)."""
    results, errors = [], []
    with get_connection() as conn:
        cur = conn.cursor()
        for f in files:
            try:
                raw = await f.read()
                text = raw.decode("utf-8-sig", errors="replace")
                parsed = parse_text(text, f.filename or "upload.csv")
                results.append(_ingest(cur, owner, parsed))
            except Exception as e:  # noqa: BLE001 — surface per-file, don't abort the batch
                errors.append({"file": f.filename, "error": str(e)})
        conn.commit()
    return {"uploaded": len(results), "results": results, "errors": errors}


@router.get("/rapsodo/players")
def list_rapsodo_players(owner: str = Depends(require_tier("coach"))):
    """The coach's private roster: every Rapsodo player they've uploaded, with
    session count, latest session date, and total pitches."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT rp.id, rp.rapsodo_player_id, rp.player_name, rp.handedness,
                      rp.team_id, rp.players_id,
                      COUNT(DISTINCT rs.id)            AS session_count,
                      MAX(rs.session_date)             AS last_session,
                      COALESCE(SUM(rs.n_pitches), 0)   AS total_pitches
               FROM rapsodo_players rp
               LEFT JOIN rapsodo_sessions rs ON rs.player_db_id = rp.id
               WHERE rp.owner_user_id = %s
               GROUP BY rp.id
               ORDER BY MAX(rs.session_date) DESC NULLS LAST, rp.player_name""",
            (owner,),
        )
        return {"players": [dict(r) for r in cur.fetchall()]}


@router.get("/rapsodo/players/{rapsodo_player_id}")
def rapsodo_player_profile(rapsodo_player_id: str, owner: str = Depends(require_tier("coach"))):
    """Full cross-session profile for one player: the aggregated arsenal (centroids
    over all reliable pitches), the movement-plot points, the session list, and a
    simple per-session velocity trend."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM rapsodo_players WHERE owner_user_id=%s AND rapsodo_player_id=%s",
            (owner, rapsodo_player_id),
        )
        player = cur.fetchone()
        if not player:
            raise HTTPException(status_code=404, detail="Player not found")
        player = dict(player)

        cur.execute(
            """SELECT id, session_date, device_generation, intent_tags, fastball_velo,
                      n_pitches, qc_ok, qc_low_confidence, qc_partial, qc_failed, qc_warmup,
                      source_file
               FROM rapsodo_sessions
               WHERE owner_user_id=%s AND player_db_id=%s
               ORDER BY session_date DESC NULLS LAST, id DESC""",
            (owner, player["id"]),
        )
        sessions = [dict(r) for r in cur.fetchall()]

        cur.execute(
            """SELECT pitch, quality, velo, total_spin, spin_eff, ivb, hb_raw, arm_hb,
                      gyro, tilt, rel_height, rel_side, extension, rel_angle, horiz_angle,
                      vaa, sz_side, sz_height, is_strike, thrown_at, session_id
               FROM rapsodo_pitches
               WHERE owner_user_id=%s AND player_db_id=%s
               ORDER BY thrown_at""",
            (owner, player["id"]),
        )
        rows = [dict(r) for r in cur.fetchall()]

    ok = [r for r in rows if r["quality"] == "ok" and r["pitch"]]
    arsenal = aggregate_arsenal(ok)

    # movement-plot points: reliable pitches with a shape (ok + low_confidence)
    plot = [
        {
            "pitch": r["pitch"],
            "velo": _ff(r["velo"]),
            "ivb": _ff(r["ivb"]),
            "arm_hb": _ff(r["arm_hb"]),
            "quality": r["quality"],
        }
        for r in rows
        if r["pitch"] and r["arm_hb"] is not None and r["ivb"] is not None
        and r["quality"] in ("ok", "low_confidence")
    ]

    # location map: plate-crossing point per reliable pitch
    locations = [
        {
            "pitch": r["pitch"],
            "sz_side": _ff(r["sz_side"]),
            "sz_height": _ff(r["sz_height"]),
            "is_strike": r["is_strike"],
        }
        for r in rows
        if r["sz_side"] is not None and r["sz_height"] is not None
        and r["quality"] in ("ok", "low_confidence") and r["pitch"]
    ]

    trend = [
        {"session_date": str(s["session_date"]) if s["session_date"] else None,
         "fastball_velo": _ff(s["fastball_velo"]), "n_pitches": s["n_pitches"]}
        for s in sorted(sessions, key=lambda s: (s["session_date"] is None, s["session_date"]))
    ]

    return {
        "player": player,
        "sessions": sessions,
        "arsenal": arsenal,
        "plot": plot,
        "locations": locations,
        "trend": trend,
        "n_sessions": len(sessions),
        "suggestions": generate_suggestions(arsenal, player.get("handedness"), len(ok)),
    }


@router.get("/rapsodo/sessions/{session_id}")
def rapsodo_session_detail(session_id: int, owner: str = Depends(require_tier("coach"))):
    """One bullpen: header, QC, re-classified arsenal, and its pitches."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM rapsodo_sessions WHERE id=%s AND owner_user_id=%s",
            (session_id, owner),
        )
        session = cur.fetchone()
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        session = dict(session)
        cur.execute(
            """SELECT pitch_no, thrown_at, raw_label, pitch, quality, velo, total_spin,
                      spin_eff, gyro, ivb, hb_raw, arm_hb, movement_basis, tilt,
                      rel_height, rel_side, extension, vaa, intent, is_strike
               FROM rapsodo_pitches WHERE session_id=%s ORDER BY pitch_no""",
            (session_id,),
        )
        rows = [dict(r) for r in cur.fetchall()]

    ok = [r for r in rows if r["quality"] == "ok" and r["pitch"]]
    return {"session": session, "arsenal": aggregate_arsenal(ok), "pitches": rows}


@router.delete("/rapsodo/sessions/{session_id}")
def delete_rapsodo_session(session_id: int, owner: str = Depends(require_tier("coach"))):
    """Remove a session (and its pitches) the coach owns. Lets them undo a bad
    upload. Orphaned players (no sessions left) are cleaned up."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM rapsodo_sessions WHERE id=%s AND owner_user_id=%s RETURNING player_db_id",
            (session_id, owner),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Session not found")
        cur.execute(
            """DELETE FROM rapsodo_players rp
               WHERE rp.id=%s AND NOT EXISTS
                 (SELECT 1 FROM rapsodo_sessions s WHERE s.player_db_id=rp.id)""",
            (row["player_db_id"],),
        )
        conn.commit()
    return {"status": "ok", "deleted_session": session_id}


def _ff(v):
    return float(v) if v is not None else None
