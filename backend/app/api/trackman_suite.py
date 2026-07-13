"""TrackMan Suite API — a private, per-coach TrackMan workspace.

Coaches upload raw TrackMan V3 game CSVs (the standard 167-column export)
and get session-aware analysis: pitching arsenals, hitting contact quality,
and game-vs-practice context splits. Mirrors the Rapsodo Lab ownership
model: every endpoint is coach-gated and scoped to owner_user_id (the
uploader's Supabase UUID), so each staff's data is private to them.

Parsing lives in app.stats.trackman_parse (validated against Bushnell's
2025-26 Hamlin SC corpus: 45 files, 10.5k unique pitches). Dedupe is by
TrackMan's global PitchUID, so re-uploading a file or uploading overlapping
re-downloads is always safe. See TRACKMAN_SUITE_DESIGN.md for the roadmap.
"""
from collections import defaultdict

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile

from ..models.database import get_connection
from ..stats.trackman_parse import parse_text, TEXT_COLS, INT_COLS, FLOAT_COLS
from .auth import require_tier

router = APIRouter(tags=["trackman-suite"])

_gate = require_tier("coach")

# All pitch columns in insert order: parser fields + derived flags.
_DERIVED = ["is_in_zone", "is_swing", "is_whiff", "is_contact", "is_chase"]
_PITCH_FIELDS = list(TEXT_COLS) + list(INT_COLS) + list(FLOAT_COLS) + _DERIVED


def _ensure_tables(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tm_sessions (
            id            SERIAL PRIMARY KEY,
            owner_user_id UUID NOT NULL,
            game_id       TEXT NOT NULL,
            session_date  DATE,
            session_type  TEXT,             -- game | scrimmage | bp
            stadium       TEXT,
            home_team     TEXT,
            away_team     TEXT,
            pitch_count   INTEGER DEFAULT 0,
            bbe_count     INTEGER DEFAULT 0,
            filenames     TEXT[] DEFAULT '{}',
            created_at    TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (owner_user_id, game_id)
        )""")
    text_cols = ",\n".join(f"{c} TEXT" for c in TEXT_COLS)
    int_cols = ",\n".join(f"{c} INTEGER" for c in INT_COLS)
    float_cols = ",\n".join(f"{c} DOUBLE PRECISION" for c in FLOAT_COLS)
    bool_cols = ",\n".join(f"{c} BOOLEAN" for c in _DERIVED)
    cur.execute(f"""
        CREATE TABLE IF NOT EXISTS tm_pitches (
            id            BIGSERIAL PRIMARY KEY,
            owner_user_id UUID NOT NULL,
            session_id    INTEGER NOT NULL REFERENCES tm_sessions(id) ON DELETE CASCADE,
            {text_cols},
            {int_cols},
            {float_cols},
            {bool_cols},
            created_at    TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (owner_user_id, pitch_uid)
        )""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tmp_owner_session ON tm_pitches(owner_user_id, session_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tmp_owner_pitcher ON tm_pitches(owner_user_id, pitcher)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tmp_owner_batter ON tm_pitches(owner_user_id, batter)")


# ── Upload ───────────────────────────────────────────────────────

@router.post("/portal/trackman/upload")
async def upload_trackman(
    files: list[UploadFile] = File(...),
    owner: str = Depends(_gate),
):
    """Upload one or many TrackMan game CSVs. Sessions are keyed by
    TrackMan's GameID (split files and re-downloads merge into the same
    session); pitches dedupe on PitchUID so re-uploads never double-count.
    Returns a per-file report and per-file errors."""
    results, errors = [], []
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        for f in files:
            try:
                raw = await f.read()
                text = raw.decode("utf-8-sig", errors="replace")
                parsed = parse_text(text, f.filename or "upload.csv")
                results.append(_ingest(cur, owner, parsed, f.filename or "upload.csv"))
            except Exception as e:  # noqa: BLE001 — per-file, don't abort the batch
                errors.append({"file": f.filename, "error": str(e)})
        conn.commit()
    return {"uploaded": len(results), "results": results, "errors": errors}


def _ingest(cur, owner, parsed, filename):
    """Insert sessions + pitches for one parsed file. Returns a report."""
    session_ids = {}
    for gid, m in parsed["sessions"].items():
        cur.execute(
            """INSERT INTO tm_sessions (owner_user_id, game_id, session_date, session_type,
                                        stadium, home_team, away_team, filenames)
               VALUES (%s, %s, %s, %s, %s, %s, %s, ARRAY[%s])
               ON CONFLICT (owner_user_id, game_id) DO UPDATE SET
                   filenames = (SELECT ARRAY(SELECT DISTINCT unnest(tm_sessions.filenames || ARRAY[%s])))
               RETURNING id""",
            (owner, gid, m["session_date"], m["session_type"], m["stadium"],
             m["home_team"], m["away_team"], filename, filename),
        )
        session_ids[gid] = cur.fetchone()["id"]

    cols = ", ".join(_PITCH_FIELDS)
    ph = ", ".join(["%s"] * (len(_PITCH_FIELDS) + 2))
    inserted = skipped = 0
    for p in parsed["pitches"]:
        vals = [owner, session_ids[p["game_id"]]] + [p.get(c) for c in _PITCH_FIELDS]
        cur.execute(
            f"""INSERT INTO tm_pitches (owner_user_id, session_id, {cols})
                VALUES ({ph}) ON CONFLICT (owner_user_id, pitch_uid) DO NOTHING""",
            vals,
        )
        inserted += cur.rowcount
        skipped += 1 - cur.rowcount

    # Refresh session counts from what's actually stored
    for gid, sid in session_ids.items():
        cur.execute(
            """UPDATE tm_sessions SET
                   pitch_count = (SELECT COUNT(*) FROM tm_pitches WHERE session_id = %s),
                   bbe_count   = (SELECT COUNT(*) FROM tm_pitches WHERE session_id = %s AND exit_speed IS NOT NULL)
               WHERE id = %s""",
            (sid, sid, sid),
        )
    return {"file": filename, "sessions": list(parsed["sessions"]),
            "pitches_added": inserted, "duplicates_skipped": skipped}


# ── Reads ────────────────────────────────────────────────────────

def _context_clause(context):
    """WHERE fragment for the session-type filter every view shares."""
    if context in ("game", "scrimmage", "bp"):
        return " AND s.session_type = %s", [context]
    if context == "live":  # game + scrimmage (anything with pitch calls)
        return " AND s.session_type IN ('game','scrimmage')", []
    return "", []


@router.get("/trackman/overview")
def trackman_overview(owner: str = Depends(_gate)):
    """Session list + workspace totals for the suite home."""
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute(
                """SELECT id, game_id, session_date, session_type, stadium,
                          home_team, away_team, pitch_count, bbe_count, created_at::date AS uploaded
                   FROM tm_sessions WHERE owner_user_id = %s
                   ORDER BY session_date DESC NULLS LAST, id DESC""",
                (owner,),
            )
            sessions = [dict(r) for r in cur.fetchall()]
        except Exception:
            conn.rollback()
            return {"sessions": [], "totals": {"sessions": 0, "pitches": 0, "bbe": 0}}
        for s in sessions:
            s["session_date"] = s["session_date"].isoformat() if s["session_date"] else None
            s["uploaded"] = s["uploaded"].isoformat() if s["uploaded"] else None
        totals = {
            "sessions": len(sessions),
            "pitches": sum(s["pitch_count"] or 0 for s in sessions),
            "bbe": sum(s["bbe_count"] or 0 for s in sessions),
            "by_type": {},
        }
        for s in sessions:
            totals["by_type"][s["session_type"]] = totals["by_type"].get(s["session_type"], 0) + 1
        return {"sessions": sessions, "totals": totals}


@router.delete("/trackman/sessions/{session_id}")
def delete_trackman_session(session_id: int, owner: str = Depends(_gate)):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM tm_sessions WHERE id = %s AND owner_user_id = %s",
                    (session_id, owner))
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Session not found.")
        conn.commit()
        return {"status": "ok"}


@router.get("/trackman/pitching")
def trackman_pitching(
    context: str = Query("live"),
    team: str | None = Query(None),
    owner: str = Depends(_gate),
):
    """Per-pitcher arsenal rollup: every pitch type's usage, velo, shape, and
    results. Pitch type prefers the human tag, falls back to TrackMan's auto
    classification. context: all|live|game|scrimmage|bp; team filters by
    TrackMan team code (e.g. BUS_BEA)."""
    extra, params = _context_clause(context)
    team_sql = " AND p.pitcher_team = %s" if team else ""
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute(
                f"""SELECT p.pitcher, p.pitcher_throws, p.pitcher_team,
                           COALESCE(p.tagged_pitch_type, p.auto_pitch_type) AS ptype,
                           COUNT(*) AS n,
                           AVG(p.rel_speed) AS velo, MAX(p.rel_speed) AS max_velo,
                           AVG(p.spin_rate) AS spin, AVG(p.ivb) AS ivb, AVG(p.horz_break) AS hb,
                           AVG(p.rel_height) AS rel_h, AVG(p.rel_side) AS rel_s,
                           AVG(p.extension) AS ext, AVG(p.vaa) AS vaa,
                           AVG(CASE WHEN p.is_in_zone THEN 1.0 ELSE 0.0 END) AS zone_pct,
                           SUM(CASE WHEN p.is_swing THEN 1 ELSE 0 END) AS swings,
                           SUM(CASE WHEN p.is_whiff THEN 1 ELSE 0 END) AS whiffs,
                           SUM(CASE WHEN p.is_chase THEN 1 ELSE 0 END) AS chases,
                           SUM(CASE WHEN p.is_in_zone IS FALSE THEN 1 ELSE 0 END) AS out_zone,
                           SUM(CASE WHEN p.pitch_call IN ('StrikeCalled','StrikeSwinging') THEN 1 ELSE 0 END) AS csw_n,
                           AVG(p.exit_speed) AS ev_against,
                           SUM(CASE WHEN p.exit_speed >= 90 THEN 1 ELSE 0 END) AS hard_hit,
                           SUM(CASE WHEN p.exit_speed IS NOT NULL THEN 1 ELSE 0 END) AS bbe
                    FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                    WHERE p.owner_user_id = %s AND p.pitcher IS NOT NULL
                      AND COALESCE(p.tagged_pitch_type, p.auto_pitch_type) IS NOT NULL
                      {extra}{team_sql}
                    GROUP BY p.pitcher, p.pitcher_throws, p.pitcher_team,
                             COALESCE(p.tagged_pitch_type, p.auto_pitch_type)
                    ORDER BY p.pitcher, n DESC""",
                [owner] + params + ([team] if team else []),
            )
            rows = [dict(r) for r in cur.fetchall()]
        except Exception:
            conn.rollback()
            return {"pitchers": []}

    by_pitcher = defaultdict(list)
    for r in rows:
        by_pitcher[(r["pitcher"], r["pitcher_throws"], r["pitcher_team"])].append(r)

    out = []
    for (name, throws, tteam), types in by_pitcher.items():
        total = sum(t["n"] for t in types)
        arsenal = []
        for t in sorted(types, key=lambda x: -x["n"]):
            swings, out_zone = t["swings"] or 0, t["out_zone"] or 0
            arsenal.append({
                "pitch_type": t["ptype"],
                "count": t["n"],
                "usage_pct": round(100 * t["n"] / total, 1),
                "velo": round(t["velo"], 1) if t["velo"] else None,
                "max_velo": round(t["max_velo"], 1) if t["max_velo"] else None,
                "spin": round(t["spin"]) if t["spin"] else None,
                "ivb": round(t["ivb"], 1) if t["ivb"] is not None else None,
                "hb": round(t["hb"], 1) if t["hb"] is not None else None,
                "rel_height": round(t["rel_h"], 2) if t["rel_h"] else None,
                "extension": round(t["ext"], 2) if t["ext"] else None,
                "vaa": round(t["vaa"], 2) if t["vaa"] is not None else None,
                "zone_pct": round(100 * t["zone_pct"], 1) if t["zone_pct"] is not None else None,
                "whiff_pct": round(100 * (t["whiffs"] or 0) / swings, 1) if swings else None,
                "chase_pct": round(100 * (t["chases"] or 0) / out_zone, 1) if out_zone else None,
                "csw_pct": round(100 * (t["csw_n"] or 0) / t["n"], 1),
                "ev_against": round(t["ev_against"], 1) if t["ev_against"] else None,
                "hard_hit": t["hard_hit"] or 0,
                "bbe": t["bbe"] or 0,
            })
        out.append({"pitcher": name, "throws": throws, "team": tteam,
                    "pitches": total, "arsenal": arsenal})
    out.sort(key=lambda x: -x["pitches"])
    return {"pitchers": out}


@router.get("/trackman/hitting")
def trackman_hitting(
    team: str | None = Query(None),
    owner: str = Depends(_gate),
):
    """Per-batter contact quality, split live (game+scrimmage) vs BP —
    the game-to-practice transfer gap. Hard-hit threshold: 90+ mph EV."""
    team_sql = " AND p.batter_team = %s" if team else ""
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute(
                f"""SELECT p.batter, p.batter_side, p.batter_team,
                           CASE WHEN s.session_type = 'bp' THEN 'bp' ELSE 'live' END AS ctx,
                           COUNT(*) AS pitches,
                           SUM(CASE WHEN p.is_swing THEN 1 ELSE 0 END) AS swings,
                           SUM(CASE WHEN p.is_whiff THEN 1 ELSE 0 END) AS whiffs,
                           SUM(CASE WHEN p.is_chase THEN 1 ELSE 0 END) AS chases,
                           SUM(CASE WHEN p.is_in_zone IS FALSE THEN 1 ELSE 0 END) AS out_zone,
                           SUM(CASE WHEN p.exit_speed IS NOT NULL THEN 1 ELSE 0 END) AS bbe,
                           AVG(p.exit_speed) AS avg_ev,
                           MAX(p.exit_speed) AS max_ev,
                           SUM(CASE WHEN p.exit_speed >= 90 THEN 1 ELSE 0 END) AS hard_hit,
                           AVG(p.launch_angle) AS avg_la,
                           MAX(p.distance) AS max_dist
                    FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                    WHERE p.owner_user_id = %s AND p.batter IS NOT NULL {team_sql}
                    GROUP BY p.batter, p.batter_side, p.batter_team,
                             CASE WHEN s.session_type = 'bp' THEN 'bp' ELSE 'live' END""",
                [owner] + ([team] if team else []),
            )
            rows = [dict(r) for r in cur.fetchall()]
        except Exception:
            conn.rollback()
            return {"batters": []}

    def fmt(r):
        if not r:
            return None
        swings, bbe, out_zone = r["swings"] or 0, r["bbe"] or 0, r["out_zone"] or 0
        return {
            "pitches": r["pitches"], "bbe": bbe,
            "avg_ev": round(r["avg_ev"], 1) if r["avg_ev"] else None,
            "max_ev": round(r["max_ev"], 1) if r["max_ev"] else None,
            "hard_hit_pct": round(100 * (r["hard_hit"] or 0) / bbe, 1) if bbe else None,
            "avg_la": round(r["avg_la"], 1) if r["avg_la"] is not None else None,
            "max_dist": round(r["max_dist"]) if r["max_dist"] else None,
            "whiff_pct": round(100 * (r["whiffs"] or 0) / swings, 1) if swings else None,
            "chase_pct": round(100 * (r["chases"] or 0) / out_zone, 1) if out_zone else None,
        }

    grouped = defaultdict(dict)
    for r in rows:
        grouped[(r["batter"], r["batter_side"], r["batter_team"])][r["ctx"]] = r

    out = []
    for (name, side, bteam), ctxs in grouped.items():
        live, bp = fmt(ctxs.get("live")), fmt(ctxs.get("bp"))
        gap = None
        if live and bp and live["hard_hit_pct"] is not None and bp["hard_hit_pct"] is not None:
            gap = round(live["hard_hit_pct"] - bp["hard_hit_pct"], 1)
        out.append({"batter": name, "side": side, "team": bteam,
                    "live": live, "bp": bp, "transfer_gap": gap})
    out.sort(key=lambda x: -((x["live"] or {}).get("bbe") or 0) - ((x["bp"] or {}).get("bbe") or 0))
    return {"batters": out}
