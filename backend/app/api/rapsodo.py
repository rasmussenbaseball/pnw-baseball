"""Rapsodo pitch-profiling API — a private, per-coach workspace.

Every endpoint is gated to the `coach` tier and scoped to the authenticated
uploader: a coach only ever sees rows where owner_user_id = their Supabase UUID.
Players are keyed by Rapsodo's own Player ID (no roster matching). Parsing logic
lives in app.stats.rapsodo_parse. See RAPSODO_TOOL_DESIGN.md.
"""
import statistics
from collections import defaultdict

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from ..config import CURRENT_SEASON
from ..models.database import get_connection
from ..stats import rapsodo_stuff
from ..stats.rapsodo_arm import arm_profile
from ..stats.rapsodo_hand import platoon_profile, pronation_profile
from ..stats.rapsodo_parse import derive, parse_text, aggregate_arsenal, EXCLUDE
from ..stats.rapsodo_suggest import generate_suggestions
from ..stats.rapsodo_tunnel import tunnel_pairs, ssw_flags
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


def _ingest(cur, owner, parsed, mode="pnw"):
    """Write one parsed session under `owner`. Idempotent: re-uploading the same
    filename for the same player replaces the prior session. Returns a summary."""
    rapsodo_pid = parsed.get("rapsodo_player_id") or f"name:{parsed.get('player_name') or 'unknown'}"

    cur.execute(
        """INSERT INTO rapsodo_players (owner_user_id, rapsodo_player_id, player_name, handedness, mode)
           VALUES (%s, %s, %s, %s, %s)
           ON CONFLICT (owner_user_id, rapsodo_player_id) DO UPDATE
             SET player_name = EXCLUDED.player_name,
                 handedness = COALESCE(EXCLUDED.handedness, rapsodo_players.handedness),
                 mode = EXCLUDED.mode,
                 updated_at = now()
           RETURNING id""",
        (owner, rapsodo_pid, parsed.get("player_name"), parsed.get("handedness"), mode),
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
              qc_ok, qc_low_confidence, qc_partial, qc_failed, qc_warmup, source_file, mode)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           RETURNING id""",
        (owner, player_db_id, rapsodo_pid, parsed.get("session_date"),
         parsed.get("device_serial"), parsed.get("device_generation"),
         ", ".join(parsed.get("intent_tags") or []) or None, parsed.get("fastball_velo"),
         parsed.get("n_pitches"), qc.get("ok", 0), qc.get("low_confidence", 0),
         qc.get("partial", 0), qc.get("failed", 0), qc.get("warmup", 0),
         parsed.get("source_file"), mode),
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
    mode: str = Form("pnw"),
    owner: str = Depends(require_tier("coach")),
):
    """Upload one or many Rapsodo session CSVs. Each file is parsed, quality-
    checked, re-classified, and stored under the uploading coach. `mode` tags the
    use case ('pnw' college vs 'facility'). Returns a per-file report (and
    per-file errors for anything unparseable)."""
    mode = mode if mode in ("pnw", "facility") else "pnw"
    results, errors = [], []
    with get_connection() as conn:
        cur = conn.cursor()
        for f in files:
            try:
                raw = await f.read()
                text = raw.decode("utf-8-sig", errors="replace")
                parsed = parse_text(text, f.filename or "upload.csv")
                results.append(_ingest(cur, owner, parsed, mode))
            except Exception as e:  # noqa: BLE001 — surface per-file, don't abort the batch
                errors.append({"file": f.filename, "error": str(e)})
        conn.commit()
    return {"uploaded": len(results), "results": results, "errors": errors}


@router.get("/rapsodo/players")
def list_rapsodo_players(owner: str = Depends(require_tier("coach"))):
    """The coach's private roster / staff leaderboard: every Rapsodo player they've
    uploaded, with session count, latest session, total pitches, peak FB velo, and
    arsenal-derived comparison metrics (arsenal depth, best Stuff grade, best tunnel)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT rp.id, rp.rapsodo_player_id, rp.player_name, rp.handedness,
                      rp.team_id, rp.players_id,
                      COUNT(DISTINCT rs.id)            AS session_count,
                      MAX(rs.session_date)             AS last_session,
                      COALESCE(SUM(rs.n_pitches), 0)   AS total_pitches,
                      MAX(rs.fastball_velo)            AS top_fb_velo
               FROM rapsodo_players rp
               LEFT JOIN rapsodo_sessions rs ON rs.player_db_id = rp.id
               WHERE rp.owner_user_id = %s
               GROUP BY rp.id
               ORDER BY MAX(rs.session_date) DESC NULLS LAST, rp.player_name""",
            (owner,),
        )
        players = [dict(r) for r in cur.fetchall()]
        if not players:
            return {"players": []}

        # arsenal-derived comparison metrics: pull every reliable pitch once, group by
        # player, and compute arsenal depth + best Stuff + best tunnel per pitcher.
        ids = [p["id"] for p in players]
        cur.execute(
            "SELECT pi.* FROM rapsodo_pitches pi "
            "WHERE pi.player_db_id = ANY(%s) AND pi.quality = 'ok'",
            (ids,),
        )
        by_player = defaultdict(list)
        for r in cur.fetchall():
            by_player[r["player_db_id"]].append(dict(r))

        for p in players:
            arsenal = aggregate_arsenal(by_player.get(p["id"], []))
            rapsodo_stuff.annotate(arsenal, rapsodo_stuff.fb_from_arsenal(arsenal))
            est = [a for a in arsenal if (a.get("count") or 0) >= 2
                   and a["pitch"] != "unclassified"]
            p["arsenal_n"] = len(est)
            graded = [a for a in est if a.get("stuff") is not None]
            top = max(graded, key=lambda a: a["stuff"]) if graded else None
            p["top_stuff"] = top["stuff"] if top else None
            p["top_stuff_pitch"] = top["pitch"] if top else None
            bp = (tunnel_pairs(arsenal, p.get("handedness")) or {}).get("best_pair")
            p["best_tunnel"] = bp["grade"] if bp else None
            p["best_tunnel_pair"] = f"{bp['a']}/{bp['b']}" if bp else None
        return {"players": players}


@router.get("/rapsodo/players/{rapsodo_player_id}")
def rapsodo_player_profile(rapsodo_player_id: str, session_id: int | None = None,
                           owner: str = Depends(require_tier("coach"))):
    """Full cross-session profile for one player: the aggregated arsenal (centroids
    over all reliable pitches), the movement-plot points, the session list, and a
    simple per-session velocity trend.

    `session_id` (optional) scopes everything — arsenal, plots, locations, trend — to
    a single bullpen, so the downloadable report can show one session OR the combined
    profile. The session list is also narrowed to that session when scoped."""
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
            """SELECT id, pitch, manual_pitch, quality, velo, total_spin, spin_eff, ivb, hb_raw, arm_hb,
                      gyro, tilt, rel_height, rel_side, extension, rel_angle, horiz_angle,
                      vaa, sz_side, sz_height, is_strike, thrown_at, session_id
               FROM rapsodo_pitches
               WHERE owner_user_id=%s AND player_db_id=%s
               ORDER BY thrown_at""",
            (owner, player["id"]),
        )
        rows = [dict(r) for r in cur.fetchall()]

    # Scope to one bullpen for the per-session download (the live page never sets it).
    if session_id is not None:
        rows = [r for r in rows if r["session_id"] == session_id]
        sessions = [s for s in sessions if s["id"] == session_id]

    ok = [r for r in rows if r["quality"] == "ok" and r["pitch"]]
    arsenal = aggregate_arsenal(ok)
    rapsodo_stuff.annotate(arsenal, rapsodo_stuff.fb_from_arsenal(arsenal))

    # movement-plot points: reliable pitches with a shape (ok + low_confidence), PLUS
    # removed/misread pitches shown faintly so a coach can click to restore them.
    # `id` lets the coach click a dot to reclassify it; `manual` flags overrides.
    plot = []
    for r in rows:
        if r["arm_hb"] is None or r["ivb"] is None:
            continue
        excluded = r["quality"] in ("misread", "excluded")
        if not ((r["pitch"] and r["quality"] in ("ok", "low_confidence")) or excluded):
            continue
        plot.append({
            "id": r["id"],
            "pitch": r["pitch"] or r["quality"],     # 'misread' / 'excluded' as the label
            "velo": _ff(r["velo"]),
            "ivb": _ff(r["ivb"]),
            "arm_hb": _ff(r["arm_hb"]),
            "spin": _ff(r["total_spin"]),
            "quality": r["quality"],
            "manual": r["manual_pitch"] is not None,
            "excluded": excluded,
        })

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

    # development trend: per-session fastball metrics + release consistency
    by_sess = defaultdict(list)
    for r in rows:
        if r["quality"] == "ok":
            by_sess[r["session_id"]].append(r)

    def _avg(src, key):
        vals = [float(p[key]) for p in src if p[key] is not None]
        return round(sum(vals) / len(vals), 1) if vals else None

    def _sd_inches(src):
        h = [float(p["rel_height"]) for p in src if p["rel_height"] is not None]
        s = [float(p["rel_side"]) for p in src if p["rel_side"] is not None]
        worst = max(statistics.pstdev(h) if len(h) > 1 else 0.0,
                    statistics.pstdev(s) if len(s) > 1 else 0.0)
        return round(worst * 12, 1) if (h or s) else None

    trend = []
    for s in sorted(sessions, key=lambda s: (s["session_date"] is None, s["session_date"])):
        ps = by_sess.get(s["id"], [])
        fbps = [p for p in ps if p["pitch"] in ("fastball", "sinker")]
        trend.append({
            "session_id": s["id"],
            "session_date": str(s["session_date"]) if s["session_date"] else None,
            "fb_velo": _avg(fbps, "velo"),
            "fb_ivb": _avg(fbps, "ivb"),
            "fb_spin": _avg(fbps, "total_spin"),
            "rel_consistency_in": _sd_inches(ps),
            "n": len(ps),
        })

    hand_profile = pronation_profile(arsenal, player.get("handedness"))
    tunnel = tunnel_pairs(arsenal, player.get("handedness"))
    ssw = ssw_flags(arsenal, player.get("handedness"))
    return {
        "player": player,
        "sessions": sessions,
        "arsenal": arsenal,
        "plot": plot,
        "locations": locations,
        "arm": arm_profile(ok),
        "hand_profile": hand_profile,
        "platoon": platoon_profile(arsenal, player.get("handedness")),
        "tunnel": tunnel,
        "ssw": ssw,
        "trend": trend,
        "n_sessions": len(sessions),
        "stuff_version": rapsodo_stuff.VERSION,
        "suggestions": generate_suggestions(arsenal, player.get("handedness"), len(ok),
                                            (hand_profile or {}).get("lean"), tunnel),
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


@router.delete("/portal/rapsodo/players/{rapsodo_player_id}")
def delete_rapsodo_player(rapsodo_player_id: str, owner: str = Depends(require_tier("coach"))):
    """Delete a player and ALL their sessions + pitches (e.g. a bugged upload, or a
    file that turned out to be a different pitcher). Owner-scoped."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM rapsodo_players WHERE owner_user_id=%s AND rapsodo_player_id=%s",
                    (owner, rapsodo_player_id))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Player not found")
        pid = row["id"]
        cur.execute("DELETE FROM rapsodo_pitches WHERE player_db_id=%s AND owner_user_id=%s", (pid, owner))
        cur.execute("DELETE FROM rapsodo_sessions WHERE player_db_id=%s AND owner_user_id=%s", (pid, owner))
        cur.execute("DELETE FROM rapsodo_players WHERE id=%s AND owner_user_id=%s", (pid, owner))
        conn.commit()
    return {"status": "ok", "deleted_player": rapsodo_player_id}


@router.get("/rapsodo/pnw-teams")
def rapsodo_pnw_teams(owner: str = Depends(require_tier("coach"))):
    """PNW colleges a coach can pick as 'their school' — the teams we actually track
    rosters/stats for (excludes out-of-conference opponents)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT t.id, t.short_name, d.level
               FROM teams t
               JOIN conferences cf ON cf.id = t.conference_id
               JOIN divisions d ON d.id = cf.division_id
               WHERE EXISTS (SELECT 1 FROM batting_stats bs  WHERE bs.team_id=t.id AND bs.season >= %s)
                  OR EXISTS (SELECT 1 FROM pitching_stats ps WHERE ps.team_id=t.id AND ps.season >= %s)
               ORDER BY t.short_name""",
            (CURRENT_SEASON - 1, CURRENT_SEASON - 1),
        )
        return {"teams": [dict(r) for r in cur.fetchall()]}


class LinkBody(BaseModel):
    players_id: int | None = None      # None clears the link


@router.post("/portal/rapsodo/players/{rapsodo_player_id}/link")
def link_rapsodo_player(rapsodo_player_id: str, body: LinkBody,
                        owner: str = Depends(require_tier("coach"))):
    """Link a Rapsodo player to a site player profile so their spring + summer stats
    show on the Rapsodo page. `players_id: null` unlinks (e.g. an incoming freshman or
    redshirt who has no profile yet). Stamps the linked player's team_id too."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM rapsodo_players WHERE owner_user_id=%s AND rapsodo_player_id=%s",
                    (owner, rapsodo_player_id))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Player not found")
        team_id = None
        if body.players_id:
            cur.execute("SELECT team_id FROM players WHERE id=%s", (body.players_id,))
            pr = cur.fetchone()
            if not pr:
                raise HTTPException(status_code=400, detail="Unknown player")
            team_id = pr["team_id"]
        cur.execute(
            "UPDATE rapsodo_players SET players_id=%s, team_id=COALESCE(%s, team_id) WHERE id=%s",
            (body.players_id, team_id, row["id"]),
        )
        conn.commit()
    return {"status": "ok", "players_id": body.players_id}


_VALID_LABELS = {
    "fastball", "sinker", "cutter", "slider",
    "sweeper", "curveball", "changeup", "splitter", "unclassified",
}
_DERIVE_FIELDS = ("id, session_id, velo, total_spin, spin_eff, spin_confidence, gyro, "
                  "ivb, hb_raw, rel_angle, rel_height, sz_height, extension, manual_pitch")
# Types a coach can DECLARE for the guided arsenal (everything real, no catch-all)
_DECLARABLE = _VALID_LABELS - {"unclassified"}


def _arsenal_set(s):
    """Parse a stored arsenal_types string into a set of allowed types (or None)."""
    if not s:
        return None
    types = {t.strip() for t in s.split(",") if t.strip()}
    return types or None


def _rederive_player(cur, player_db_id, handedness, allowed):
    """Recompute pitch/quality/arm_hb/vaa for every pitch a player owns, honoring
    the declared arsenal + manual overrides, and write the results back."""
    cur.execute(f"SELECT {_DERIVE_FIELDS} FROM rapsodo_pitches WHERE player_db_id=%s",
                (player_db_id,))
    raw = [dict(r) for r in cur.fetchall()]
    dmap = {d["id"]: d for d in derive(raw, handedness, allowed)}
    for r in raw:
        d = dmap[r["id"]]
        cur.execute("UPDATE rapsodo_pitches SET pitch=%s, quality=%s, arm_hb=%s, vaa=%s WHERE id=%s",
                    (d["pitch"], d["quality"], d["arm_hb"], d["vaa"], r["id"]))


class LabelBody(BaseModel):
    pitch: str | None = None      # None / "" clears the override (revert to auto)


@router.post("/portal/rapsodo/pitches/{pitch_id}/label")
def relabel_pitch(pitch_id: int, body: LabelBody, owner: str = Depends(require_tier("coach"))):
    """Click-to-reclassify: set (or clear) a coach's manual pitch label on one
    pitch. The override persists forever — the auto classifier never overwrites it.
    Re-derives the player's pitches immediately so the profile reflects the change."""
    new = (body.pitch or "").strip() or None
    if new is not None and new != EXCLUDE and new not in _VALID_LABELS:
        raise HTTPException(status_code=400, detail=f"Unknown pitch type: {new}")
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT p.player_db_id, rp.handedness, rp.arsenal_types FROM rapsodo_pitches p
               JOIN rapsodo_players rp ON rp.id = p.player_db_id
               WHERE p.id=%s AND p.owner_user_id=%s""",
            (pitch_id, owner),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Pitch not found")
        cur.execute("UPDATE rapsodo_pitches SET manual_pitch=%s WHERE id=%s AND owner_user_id=%s",
                    (new, pitch_id, owner))
        # immediate re-derive of this player's pitches so the change shows now
        _rederive_player(cur, row["player_db_id"], row["handedness"],
                         _arsenal_set(row["arsenal_types"]))
        conn.commit()
    return {"status": "ok", "pitch_id": pitch_id, "pitch": new}


class ArsenalBody(BaseModel):
    types: list[str] = []         # the pitch types this pitcher actually throws


@router.post("/portal/rapsodo/players/{rapsodo_player_id}/arsenal")
def set_arsenal(rapsodo_player_id: str, body: ArsenalBody,
                owner: str = Depends(require_tier("coach"))):
    """Guided arsenal: the coach declares which pitch types a pitcher throws, and
    the classifier buckets every pitch into ONLY those types (snapping outliers to
    the nearest declared shape). An empty list clears it (back to auto). Re-derives
    immediately so the profile reflects the constraint. Manual per-pitch overrides
    still win."""
    types = [t for t in dict.fromkeys(t.strip() for t in body.types) if t in _DECLARABLE]
    val = ",".join(types) or None
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, handedness FROM rapsodo_players WHERE owner_user_id=%s AND rapsodo_player_id=%s",
            (owner, rapsodo_player_id),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Player not found")
        cur.execute("UPDATE rapsodo_players SET arsenal_types=%s WHERE id=%s", (val, row["id"]))
        _rederive_player(cur, row["id"], row["handedness"], _arsenal_set(val))
        conn.commit()
    return {"status": "ok", "arsenal_types": types}


def _ff(v):
    return float(v) if v is not None else None
