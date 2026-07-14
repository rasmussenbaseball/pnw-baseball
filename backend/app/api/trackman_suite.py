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
    """Session list + workspace totals for the suite home. Also detects the
    coach's PRIMARY team: the modal team code across their uploads (their
    own program hosts the sessions, so it dominates) — every view defaults
    its team selector to this so opponents never mix into the roster lists."""
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
            cur.execute(
                """SELECT team, COUNT(*) AS n FROM (
                       SELECT pitcher_team AS team FROM tm_pitches WHERE owner_user_id = %s AND pitcher_team IS NOT NULL
                       UNION ALL
                       SELECT batter_team FROM tm_pitches WHERE owner_user_id = %s AND batter_team IS NOT NULL
                   ) t GROUP BY team ORDER BY n DESC""",
                (owner, owner),
            )
            team_rows = cur.fetchall()
        except Exception:
            conn.rollback()
            return {"sessions": [], "totals": {"sessions": 0, "pitches": 0, "bbe": 0},
                    "teams": [], "primary_team": None}
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
        # SIM_UNI is TrackMan's simulated-opponent placeholder, never a program.
        teams = [r["team"] for r in team_rows if r["team"] != "SIM_UNI"]
        return {"sessions": sessions, "totals": totals,
                "teams": teams, "primary_team": teams[0] if teams else None}


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


# ── Phase 2: Player Lab + Leaderboards ───────────────────────────
# Player Lab = Savant-style single-pitcher deep dive: raw points for the
# movement/release plots, per-session velo trend, location bins per pitch
# type, count-state usage, and percentile ranks computed against every
# OTHER pitcher in this coach's corpus (their own "league").

_PCTL_METRICS = [
    # (key, sql expr, higher_is_better)
    ("velo", "AVG(rel_speed)", True),
    ("ivb", "AVG(ivb)", True),
    ("spin", "AVG(spin_rate)", True),
    ("extension", "AVG(extension)", True),
    ("zone_pct", "AVG(CASE WHEN is_in_zone THEN 1.0 WHEN is_in_zone IS FALSE THEN 0.0 END)", True),
    ("whiff_pct", "CASE WHEN SUM(CASE WHEN is_swing THEN 1 ELSE 0 END) >= 20 THEN "
                  "SUM(CASE WHEN is_whiff THEN 1 ELSE 0 END)::float / NULLIF(SUM(CASE WHEN is_swing THEN 1 ELSE 0 END),0) END", True),
    ("chase_pct", "CASE WHEN SUM(CASE WHEN is_in_zone IS FALSE THEN 1 ELSE 0 END) >= 20 THEN "
                  "SUM(CASE WHEN is_chase THEN 1 ELSE 0 END)::float / NULLIF(SUM(CASE WHEN is_in_zone IS FALSE THEN 1 ELSE 0 END),0) END", True),
    ("csw_pct", "AVG(CASE WHEN pitch_call IN ('StrikeCalled','StrikeSwinging') THEN 1.0 ELSE 0.0 END)", True),
    ("ev_against", "CASE WHEN SUM(CASE WHEN exit_speed IS NOT NULL THEN 1 ELSE 0 END) >= 10 THEN AVG(exit_speed) END", False),
]


@router.get("/trackman/pitchers/detail")
def trackman_pitcher_detail(
    pitcher: str = Query(...),
    team: str | None = Query(None),
    context: str = Query("live"),
    conf: str = Query("all"),
    owner: str = Depends(_gate),
):
    """Everything the Player Lab needs for one pitcher, in one call:
    per-pitch points (movement, release, location, velo), session velo
    trend, count-state usage, and corpus percentiles (min 50 pitches to
    qualify for the percentile pool)."""
    extra, params = _context_clause(context)
    team_sql = " AND p.pitcher_team = %s" if team else ""
    tparams = [team] if team else []
    with get_connection() as conn:
        cur = conn.cursor()
        # Raw per-pitch points (kept lean for the plots)
        # Strict confidence: drop pitches TrackMan flagged Low on movement or
        # location (keeps the plots honest; full sample stays the default).
        conf_sql = (" AND COALESCE(p.mov_conf,'') <> 'Low' AND COALESCE(p.loc_conf,'') <> 'Low'"
                    if conf == "strict" else "")
        cur.execute(
            f"""SELECT COALESCE(p.tagged_pitch_type, p.auto_pitch_type) AS ptype,
                       p.rel_speed, p.ivb, p.horz_break, p.spin_rate,
                       p.rel_height, p.rel_side, p.extension,
                       p.plate_loc_height, p.plate_loc_side,
                       p.balls, p.strikes, p.batter_side, p.pitch_call,
                       p.exit_speed, p.launch_angle, p.play_result,
                       p.inning, p.top_bottom, p.pa_of_inning, p.pitch_of_pa,
                       s.session_date, s.id AS session_id
                FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                WHERE p.owner_user_id = %s AND p.pitcher = %s
                  AND COALESCE(p.tagged_pitch_type, p.auto_pitch_type) IS NOT NULL
                  {extra}{team_sql}{conf_sql}
                ORDER BY s.session_date, p.pitch_no""",
            [owner, pitcher] + params + tparams,
        )
        pitches = [dict(r) for r in cur.fetchall()]
        for p in pitches:
            p["session_date"] = p["session_date"].isoformat() if p["session_date"] else None
        if not pitches:
            raise HTTPException(status_code=404, detail="No pitches for that pitcher in this context.")

        # Percentile pool: every pitcher in this corpus with 50+ pitches
        cols = ", ".join(f"{expr} AS {key}" for key, expr, _ in _PCTL_METRICS)
        cur.execute(
            f"""SELECT p.pitcher, COUNT(*) AS n, {cols}
                FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                WHERE p.owner_user_id = %s AND p.pitcher IS NOT NULL {extra}
                GROUP BY p.pitcher HAVING COUNT(*) >= 50""",
            [owner] + params,
        )
        pool = [dict(r) for r in cur.fetchall()]

    me = next((r for r in pool if r["pitcher"] == pitcher), None)
    percentiles = {}
    if me and len(pool) >= 5:
        for key, _, higher in _PCTL_METRICS:
            mine = me.get(key)
            vals = [r[key] for r in pool if r.get(key) is not None]
            if mine is None or len(vals) < 5:
                continue
            below = sum(1 for v in vals if (v < mine) == higher and v != mine)
            pct = round(100 * (below + 0.5 * sum(1 for v in vals if v == mine)) / len(vals))
            percentiles[key] = {"value": round(float(mine), 3), "pctl": max(1, min(99, pct)),
                                "pool": len(vals)}

    # Count-state usage matrix: pitch type share per (balls, strikes)
    usage = defaultdict(lambda: defaultdict(int))
    for p in pitches:
        if p["balls"] is not None and p["strikes"] is not None:
            usage[f"{p['balls']}-{p['strikes']}"][p["ptype"]] += 1
    count_usage = {
        c: {"total": sum(tp.values()),
            "types": {t: round(100 * n / sum(tp.values()), 1) for t, n in tp.items()}}
        for c, tp in usage.items()
    }

    # Session velo trend per pitch type
    trend = defaultdict(lambda: defaultdict(list))
    for p in pitches:
        if p["rel_speed"] is not None and p["session_date"]:
            trend[p["ptype"]][p["session_date"]].append(p["rel_speed"])
    velo_trend = {
        t: [{"date": d, "velo": round(sum(v) / len(v), 1), "n": len(v)}
            for d, v in sorted(dates.items())]
        for t, dates in trend.items()
    }

    return {
        "pitcher": pitcher,
        "pitch_count": len(pitches),
        "pitches": pitches,
        "percentiles": percentiles,
        "count_usage": count_usage,
        "velo_trend": velo_trend,
    }


_LB_CATS_PITCHING = {
    "velo": ("Avg fastball velo", "AVG(rel_speed) FILTER (WHERE COALESCE(tagged_pitch_type, auto_pitch_type) IN ('Fastball','Four-Seam','Sinker'))", True, 30),
    "max_velo": ("Max velo", "MAX(rel_speed)", True, 30),
    "ivb": ("Fastball IVB", "AVG(ivb) FILTER (WHERE COALESCE(tagged_pitch_type, auto_pitch_type) IN ('Fastball','Four-Seam'))", True, 30),
    "spin": ("Avg spin", "AVG(spin_rate)", True, 50),
    "extension": ("Extension", "AVG(extension)", True, 50),
    "whiff_pct": ("Whiff%", "100.0 * SUM(CASE WHEN is_whiff THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN is_swing THEN 1 ELSE 0 END), 0)", True, 50),
    "csw_pct": ("CSW%", "100.0 * AVG(CASE WHEN pitch_call IN ('StrikeCalled','StrikeSwinging') THEN 1.0 ELSE 0.0 END)", True, 50),
    "zone_pct": ("Zone%", "100.0 * AVG(CASE WHEN is_in_zone THEN 1.0 WHEN is_in_zone IS FALSE THEN 0.0 END)", True, 50),
    "chase_pct": ("Chase%", "100.0 * SUM(CASE WHEN is_chase THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN is_in_zone IS FALSE THEN 1 ELSE 0 END), 0)", True, 50),
    "two_strike_whiff": ("2K whiff%", "100.0 * SUM(CASE WHEN is_whiff AND strikes = 2 THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN is_swing AND strikes = 2 THEN 1 ELSE 0 END), 0)", True, 30),
    "ev_against": ("EV against", "AVG(exit_speed)", False, 15),
}
_LB_CATS_HITTING = {
    "avg_ev": ("Avg EV", "AVG(exit_speed)", True, 15),
    "max_ev": ("Max EV", "MAX(exit_speed)", True, 10),
    "hard_hit_pct": ("Hard-hit%", "100.0 * SUM(CASE WHEN exit_speed >= 90 THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN exit_speed IS NOT NULL THEN 1 ELSE 0 END), 0)", True, 15),
    "sweet_spot": ("Sweet-spot%", "100.0 * SUM(CASE WHEN exit_speed IS NOT NULL AND launch_angle BETWEEN 8 AND 32 THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN exit_speed IS NOT NULL THEN 1 ELSE 0 END), 0)", True, 15),
    "zone_contact": ("Zone contact%", "100.0 * SUM(CASE WHEN is_contact AND is_in_zone THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN is_swing AND is_in_zone THEN 1 ELSE 0 END), 0)", True, 25),
    "whiff_pct": ("Whiff%", "100.0 * SUM(CASE WHEN is_whiff THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN is_swing THEN 1 ELSE 0 END), 0)", False, 25),
    "chase_pct": ("Chase%", "100.0 * SUM(CASE WHEN is_chase THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN is_in_zone IS FALSE THEN 1 ELSE 0 END), 0)", False, 25),
    "max_dist": ("Max distance", "MAX(distance)", True, 10),
}


@router.get("/trackman/leaderboards")
def trackman_leaderboards(
    side: str = Query("pitching"),
    context: str = Query("live"),
    team: str | None = Query(None),
    owner: str = Depends(_gate),
):
    """Corpus leaderboards with per-category minimum-sample gates. Each
    category returns the full qualified ranking (the UI shows top N)."""
    cats = _LB_CATS_PITCHING if side == "pitching" else _LB_CATS_HITTING
    who = "pitcher" if side == "pitching" else "batter"
    hand = "pitcher_throws" if side == "pitching" else "batter_side"
    team_col = f"{who}_team"
    extra, params = _context_clause(context)
    team_sql = f" AND p.{team_col} = %s" if team else ""
    tparams = [team] if team else []

    boards = {}
    with get_connection() as conn:
        cur = conn.cursor()
        for key, (label, expr, higher, min_n) in cats.items():
            # Sample gate: pitches for rate stats, BBE for contact-quality stats
            gate = ("SUM(CASE WHEN exit_speed IS NOT NULL THEN 1 ELSE 0 END)"
                    if "exit_speed" in expr or "distance" in expr else "COUNT(*)")
            try:
                cur.execute(
                    f"""SELECT p.{who} AS name, p.{hand} AS hand, p.{team_col} AS team,
                               COUNT(*) AS pitches, {gate} AS sample, {expr} AS val
                        FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                        WHERE p.owner_user_id = %s AND p.{who} IS NOT NULL {extra}{team_sql}
                        GROUP BY p.{who}, p.{hand}, p.{team_col}
                        HAVING {gate} >= {min_n} AND {expr} IS NOT NULL
                        ORDER BY {expr} {'DESC' if higher else 'ASC'}
                        LIMIT 25""",
                    [owner] + params + tparams,
                )
                boards[key] = {
                    "label": label,
                    "higher_is_better": higher,
                    "min_sample": min_n,
                    "rows": [
                        {"name": r["name"], "hand": r["hand"], "team": r["team"],
                         "sample": r["sample"], "value": round(float(r["val"]), 1)}
                        for r in cur.fetchall()
                    ],
                }
            except Exception:
                conn.rollback()
                boards[key] = {"label": label, "higher_is_better": higher,
                               "min_sample": min_n, "rows": []}
    return {"side": side, "boards": boards}


# ── Phase 2.5/3: Hitter Lab, Session Review, Catching ────────────

_BATTER_PCTL = [
    ("avg_ev", "AVG(exit_speed)", True),
    ("max_ev", "MAX(exit_speed)", True),
    ("hard_hit_pct", "CASE WHEN SUM(CASE WHEN exit_speed IS NOT NULL THEN 1 ELSE 0 END) >= 10 THEN "
                     "SUM(CASE WHEN exit_speed >= 90 THEN 1 ELSE 0 END)::float / NULLIF(SUM(CASE WHEN exit_speed IS NOT NULL THEN 1 ELSE 0 END),0) END", True),
    ("sweet_spot_pct", "CASE WHEN SUM(CASE WHEN exit_speed IS NOT NULL THEN 1 ELSE 0 END) >= 10 THEN "
                       "SUM(CASE WHEN exit_speed IS NOT NULL AND launch_angle BETWEEN 8 AND 32 THEN 1 ELSE 0 END)::float / NULLIF(SUM(CASE WHEN exit_speed IS NOT NULL THEN 1 ELSE 0 END),0) END", True),
    ("whiff_pct", "CASE WHEN SUM(CASE WHEN is_swing THEN 1 ELSE 0 END) >= 15 THEN "
                  "SUM(CASE WHEN is_whiff THEN 1 ELSE 0 END)::float / NULLIF(SUM(CASE WHEN is_swing THEN 1 ELSE 0 END),0) END", False),
    ("chase_pct", "CASE WHEN SUM(CASE WHEN is_in_zone IS FALSE THEN 1 ELSE 0 END) >= 15 THEN "
                  "SUM(CASE WHEN is_chase THEN 1 ELSE 0 END)::float / NULLIF(SUM(CASE WHEN is_in_zone IS FALSE THEN 1 ELSE 0 END),0) END", False),
    ("zone_contact_pct", "CASE WHEN SUM(CASE WHEN is_swing AND is_in_zone THEN 1 ELSE 0 END) >= 15 THEN "
                         "SUM(CASE WHEN is_contact AND is_in_zone THEN 1 ELSE 0 END)::float / NULLIF(SUM(CASE WHEN is_swing AND is_in_zone THEN 1 ELSE 0 END),0) END", True),
]


@router.get("/trackman/batters/detail")
def trackman_batter_detail(
    batter: str = Query(...),
    team: str | None = Query(None),
    context: str = Query("all"),
    conf: str = Query("all"),
    owner: str = Depends(_gate),
):
    """Everything the Hitter Lab needs: every pitch SEEN (locations + swing
    decisions), every BBE (EV/LA/spray from Direction+Distance), and
    percentiles vs the other bats in this corpus (30+ pitches seen)."""
    extra, params = _context_clause(context)
    team_sql = " AND p.batter_team = %s" if team else ""
    tparams = [team] if team else []
    conf_sql = (" AND COALESCE(p.hit_launch_conf,'') <> 'Low'" if conf == "strict" else "")
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            f"""SELECT COALESCE(p.tagged_pitch_type, p.auto_pitch_type) AS ptype,
                       p.pitch_call, p.is_swing, p.is_whiff, p.is_contact, p.is_chase, p.is_in_zone,
                       p.plate_loc_height, p.plate_loc_side, p.balls, p.strikes,
                       p.pitcher_throws, p.exit_speed, p.launch_angle, p.distance,
                       p.direction, p.bearing, p.play_result, p.tagged_hit_type,
                       s.session_type, s.session_date
                FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                WHERE p.owner_user_id = %s AND p.batter = %s {extra}{team_sql}{conf_sql}
                ORDER BY s.session_date, p.pitch_no""",
            [owner, batter] + params + tparams,
        )
        pitches = [dict(r) for r in cur.fetchall()]
        for p in pitches:
            p["session_date"] = p["session_date"].isoformat() if p["session_date"] else None
        if not pitches:
            raise HTTPException(status_code=404, detail="No pitches for that batter in this context.")

        cols = ", ".join(f"{expr} AS {key}" for key, expr, _ in _BATTER_PCTL)
        cur.execute(
            f"""SELECT p.batter, COUNT(*) AS n, {cols}
                FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                WHERE p.owner_user_id = %s AND p.batter IS NOT NULL {extra}{conf_sql}
                GROUP BY p.batter HAVING COUNT(*) >= 30""",
            [owner] + params,
        )
        pool = [dict(r) for r in cur.fetchall()]

    me = next((r for r in pool if r["batter"] == batter), None)
    percentiles = {}
    if me and len(pool) >= 5:
        for key, _, higher in _BATTER_PCTL:
            mine = me.get(key)
            vals = [r[key] for r in pool if r.get(key) is not None]
            if mine is None or len(vals) < 5:
                continue
            below = sum(1 for v in vals if (v < mine) == higher and v != mine)
            pct = round(100 * (below + 0.5 * sum(1 for v in vals if v == mine)) / len(vals))
            percentiles[key] = {"value": round(float(mine), 3), "pctl": max(1, min(99, pct)),
                                "pool": len(vals)}

    return {"batter": batter, "pitch_count": len(pitches),
            "pitches": pitches, "percentiles": percentiles}


@router.get("/trackman/sessions/{session_id}/review")
def trackman_session_review(session_id: int, owner: str = Depends(_gate)):
    """One session's story: header, per-pitcher lines (grouped by team),
    hardest-hit balls, and team discipline totals."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM tm_sessions WHERE id = %s AND owner_user_id = %s",
                    (session_id, owner))
        sess = cur.fetchone()
        if not sess:
            raise HTTPException(status_code=404, detail="Session not found.")

        cur.execute(
            """SELECT pitcher, pitcher_throws, pitcher_team, COUNT(*) AS pitches,
                      COUNT(DISTINCT (inning, top_bottom, pa_of_inning)) AS bf,
                      AVG(rel_speed) AS velo, MAX(rel_speed) AS max_velo,
                      SUM(CASE WHEN is_whiff THEN 1 ELSE 0 END) AS whiffs,
                      SUM(CASE WHEN pitch_call IN ('StrikeCalled','StrikeSwinging') THEN 1 ELSE 0 END) AS csw,
                      SUM(CASE WHEN k_or_bb = 'Strikeout' THEN 1 ELSE 0 END) AS k,
                      SUM(CASE WHEN k_or_bb = 'Walk' THEN 1 ELSE 0 END) AS bb,
                      AVG(CASE WHEN is_in_zone THEN 1.0 WHEN is_in_zone IS FALSE THEN 0.0 END) AS zone,
                      AVG(exit_speed) AS ev_against,
                      SUM(CASE WHEN exit_speed IS NOT NULL THEN 1 ELSE 0 END) AS bbe
               FROM tm_pitches WHERE session_id = %s AND owner_user_id = %s AND pitcher IS NOT NULL
               GROUP BY pitcher, pitcher_throws, pitcher_team
               ORDER BY pitcher_team, COUNT(*) DESC""",
            (session_id, owner),
        )
        lines = []
        for r in cur.fetchall():
            d = dict(r)
            for k in ("velo", "max_velo", "ev_against"):
                d[k] = round(d[k], 1) if d[k] is not None else None
            d["zone_pct"] = round(100 * d.pop("zone"), 1) if d["zone"] is not None else None
            d["csw_pct"] = round(100 * d["csw"] / d["pitches"], 1) if d["pitches"] else None
            lines.append(d)

        cur.execute(
            """SELECT batter, batter_team, pitcher, exit_speed, launch_angle, distance,
                      play_result, tagged_hit_type, inning
               FROM tm_pitches WHERE session_id = %s AND owner_user_id = %s
                 AND exit_speed IS NOT NULL
               ORDER BY exit_speed DESC LIMIT 10""",
            (session_id, owner),
        )
        top_bbe = [dict(r) for r in cur.fetchall()]
        for b in top_bbe:
            for k in ("exit_speed", "launch_angle"):
                b[k] = round(b[k], 1) if b[k] is not None else None
            b["distance"] = round(b["distance"]) if b["distance"] is not None else None

        sess = dict(sess)
        for k in ("session_date", "created_at"):
            sess[k] = sess[k].isoformat() if sess.get(k) else None
        sess.pop("owner_user_id", None)
    return {"session": sess, "pitcher_lines": lines, "top_bbe": top_bbe}


@router.get("/trackman/catching")
def trackman_catching(owner: str = Depends(_gate)):
    """Catcher throw metrics: pop time, exchange, throw speed. TrackMan only
    records these on tracked throws (steal attempts / pickoffs)."""
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute(
                """SELECT catcher, catcher_team, COUNT(*) AS throws,
                          AVG(pop_time) AS avg_pop, MIN(pop_time) AS best_pop,
                          AVG(exchange_time) AS avg_exchange,
                          AVG(throw_speed) AS avg_throw, MAX(throw_speed) AS max_throw
                   FROM tm_pitches
                   WHERE owner_user_id = %s AND catcher IS NOT NULL AND pop_time IS NOT NULL
                   GROUP BY catcher, catcher_team
                   ORDER BY AVG(pop_time)""",
                (owner,),
            )
            rows = []
            for r in cur.fetchall():
                d = dict(r)
                for k in ("avg_pop", "best_pop", "avg_exchange"):
                    d[k] = round(d[k], 2) if d[k] is not None else None
                for k in ("avg_throw", "max_throw"):
                    d[k] = round(d[k], 1) if d[k] is not None else None
                rows.append(d)
        except Exception:
            conn.rollback()
            rows = []
    return {"catchers": rows}
