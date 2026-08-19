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
from psycopg2.extras import execute_values, Json
from pydantic import BaseModel

from ..config import CURRENT_SEASON
from ..models.database import get_connection
from ..stats.trackman_parse import parse_text, TEXT_COLS, INT_COLS, FLOAT_COLS
from ..stats.trackman_stuff import grade_trackman, FB_FAMILY
from ..stats.rapsodo_location import location_plus
from ..stats.trackman_classify import reclassify_owner, SUITE_TYPES
from ..stats.rapsodo_arm import arm_profile
from ..stats.rapsodo_tunnel import tunnel_pairs
from ..stats.trackman_defense import (
    OF_POSITIONS, IF_POSITIONS, OUT_RESULTS, landing_xz,
    catch_probability, gb_out_probability, difficulty_bucket, move_direction,
)
from ..stats.trackman_runvalue import pitch_run_value, attack_zone

# Pitches flagged as mistagged-pitcher (wrong name on the TrackMan tablet,
# caught by release-point distance in trackman_classify.flag_mistags) are
# excluded from every PITCHER-facing view. Batter views keep them — the
# batter on the row is real regardless of whose name is on the mound.
_NO_MISTAG = (" AND COALESCE(p.override_pitch_type, p.class_pitch_type,"
              " p.tagged_pitch_type, p.auto_pitch_type) IS DISTINCT FROM 'Mistag'")
_NO_MISTAG_BARE = (" AND COALESCE(override_pitch_type, class_pitch_type,"
                   " tagged_pitch_type, auto_pitch_type) IS DISTINCT FROM 'Mistag'")


def _rv_baseline(cur, owner, context):
    """Mean batter-perspective run value per priced pitch across the whole
    corpus in this context. Subtracting it re-centers run values on THIS
    corpus (0 = the average pitch here) — the same philosophy as OAE and
    SAE: the MLB-derived count ladder sets the SHAPE, the coach's own data
    sets the level. Without this, a college corpus reads ~-1.5 RV/100 for
    every pitcher (more balls + walks than the MLB baseline expects)."""
    extra, params = _context_clause(context)
    cur.execute(
        f"""SELECT p.balls, p.strikes, p.pitch_call, p.play_result
            FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
            WHERE p.owner_user_id = %s {extra}""",
        [owner] + params,
    )
    tot, n = 0.0, 0
    for r in cur.fetchall():
        v = pitch_run_value(r["balls"], r["strikes"], r["pitch_call"], r["play_result"])
        if v is not None:
            tot += v
            n += 1
    return (tot / n) if n else 0.0
from .auth import require_tier

from fastapi import Request as _Request
from ._tracking_share import resolve_workspace, ensure_can_upload

router = APIRouter(tags=["trackman-suite"])

_tier_gate = require_tier("coach")


def _gate(request: _Request, owner: str = Depends(_tier_gate)) -> str:
    """Coach gate + workspace resolution: staff on a coach's share list
    (with no uploads of their own) act as that coach's workspace."""
    return resolve_workspace(request, owner)


def _write_gate(request: _Request, owner: str = Depends(_gate)) -> str:
    """Like _gate, but 403s staff members whose can_upload is off."""
    ensure_can_upload(request, owner)
    return owner

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
    cur.execute("ALTER TABLE tm_pitches ADD COLUMN IF NOT EXISTS class_pitch_type TEXT")
    cur.execute("ALTER TABLE tm_pitches ADD COLUMN IF NOT EXISTS override_pitch_type TEXT")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tmp_owner_session ON tm_pitches(owner_user_id, session_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tmp_owner_pitcher ON tm_pitches(owner_user_id, pitcher)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tmp_owner_batter ON tm_pitches(owner_user_id, batter)")


_POS_TABLE_READY = False


def _ensure_positioning_table(cur):
    global _POS_TABLE_READY
    if _POS_TABLE_READY:
        return
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tm_positioning (
            id            BIGSERIAL PRIMARY KEY,
            owner_user_id UUID NOT NULL,
            pitch_uid     TEXT NOT NULL,
            game_id       TEXT,
            shift         TEXT,
            fielders      JSONB NOT NULL,   -- {"CF": {"name":..., "x":..., "z":...}, ...}
            created_at    TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (owner_user_id, pitch_uid)
        )""")
    cur.execute("""SELECT relrowsecurity FROM pg_class WHERE relname = 'tm_positioning'""")
    row = cur.fetchone()
    if row is not None and not row.get("relrowsecurity"):
        cur.execute("ALTER TABLE tm_positioning ENABLE ROW LEVEL SECURITY")
    _POS_TABLE_READY = True


def _parse_positioning(text: str):
    """TrackMan player-positioning CSV -> rows for tm_positioning."""
    import csv as _csv
    import io as _io
    reader = _csv.DictReader(_io.StringIO(text))
    if "1B_PositionAtReleaseX" not in (reader.fieldnames or []):
        return None
    out = []
    for r in reader:
        fielders = {}
        for pos in OF_POSITIONS + IF_POSITIONS:
            try:
                x = float(r.get(f"{pos}_PositionAtReleaseX") or "")
                z = float(r.get(f"{pos}_PositionAtReleaseZ") or "")
            except ValueError:
                continue
            fielders[pos] = {"name": (r.get(f"{pos}_Name") or "").strip(), "x": x, "z": z}
        if fielders and r.get("PitchUID"):
            out.append({"pitch_uid": r["PitchUID"],
                        "game_id": (r.get("GameUID") or "")[:80],
                        "shift": r.get("DetectedShift") or None,
                        "fielders": fielders})
    return out


# ── Upload ───────────────────────────────────────────────────────

@router.post("/portal/trackman/upload")
async def upload_trackman(
    files: list[UploadFile] = File(...),
    owner: str = Depends(_write_gate),
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
                pos_rows = _parse_positioning(text)
                if pos_rows is not None:
                    _ensure_positioning_table(cur)
                    execute_values(cur, """
                        INSERT INTO tm_positioning (owner_user_id, pitch_uid, game_id, shift, fielders)
                        VALUES %s
                        ON CONFLICT (owner_user_id, pitch_uid) DO UPDATE
                            SET fielders = EXCLUDED.fielders, shift = EXCLUDED.shift
                    """, [(owner, r["pitch_uid"], r["game_id"], r["shift"], Json(r["fielders"]))
                          for r in pos_rows], page_size=500)
                    conn.commit()
                    results.append({"file": f.filename, "kind": "positioning",
                                    "pitches_added": 0, "positioned": len(pos_rows),
                                    "sessions": [], "duplicates_skipped": 0})
                    continue
                parsed = parse_text(text, f.filename or "upload.csv")
                results.append(_ingest(cur, owner, parsed, f.filename or "upload.csv"))
                conn.commit()   # per-file: a dropped connection keeps finished files
            except Exception as e:  # noqa: BLE001 — per-file, don't abort the batch
                conn.rollback()
                errors.append({"file": f.filename, "error": str(e)})
        # Auto-classify with the site's shape classifier (per pitcher, vs their
        # own fastball) so mis-tagged pitches never corrupt the Stuff grades.
        try:
            _, reclassified = reclassify_owner(cur, owner)
        except Exception:
            reclassified = 0
        conn.commit()
    return {"uploaded": len(results), "results": results, "errors": errors,
            "reclassified": reclassified}


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
    # One batched statement per file. The old per-pitch INSERT was a network
    # round-trip per row — a multi-file upload ran for minutes and the proxy
    # 504'd at 60s (Nate, 2026-08-18). RETURNING 1 counts actual inserts so
    # the dedupe report stays accurate.
    rows = [tuple([owner, session_ids[p["game_id"]]] + [p.get(c) for c in _PITCH_FIELDS])
            for p in parsed["pitches"]]
    inserted = skipped = 0
    if rows:
        returned = execute_values(
            cur,
            f"""INSERT INTO tm_pitches (owner_user_id, session_id, {cols})
                VALUES %s ON CONFLICT (owner_user_id, pitch_uid) DO NOTHING RETURNING 1""",
            rows, page_size=500, fetch=True)
        inserted = len(returned)
        skipped = len(rows) - inserted

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


SESSION_TYPES = ("game", "scrimmage", "intrasquad", "bp")


class SessionTypePatch(BaseModel):
    session_type: str


@router.patch("/trackman/sessions/{session_id}/type")
def set_session_type(session_id: int, body: SessionTypePatch, owner: str = Depends(_gate)):
    """Reclassify a session (the auto-detector can't tell a scrimmage vs an
    intrasquad, and mis-coded games happen). Affects every view's context
    filter immediately."""
    st = (body.session_type or "").strip().lower()
    if st not in SESSION_TYPES:
        raise HTTPException(status_code=400,
                            detail=f"session_type must be one of {', '.join(SESSION_TYPES)}.")
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE tm_sessions SET session_type = %s WHERE id = %s AND owner_user_id = %s",
                    (st, session_id, owner))
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Session not found.")
        conn.commit()
    return {"status": "ok", "session_type": st}


@router.get("/trackman/defense")
def trackman_defense(
    context: str = Query("all"),
    team: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    owner: str = Depends(_gate),
):
    """OF catch-probability / IF ground-ball range metrics from the
    player-positioning CSVs joined to batted-ball flight by PitchUID.
    Physics-informed estimates (see trackman_defense.py), branded Outs
    Above Expected — comparable within the corpus, not to MLB OAA."""
    ctx_sql, ctx_params = _context_clause(context)
    d_sql, d_params = _date_clause(date_from, date_to)
    team_sql, team_params = ("", [])
    if team:
        team_sql, team_params = " AND p.pitcher_team = %s", [team]
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_positioning_table(cur)
        cur.execute(f"""
            SELECT p.pitch_uid, p.batter, p.pitcher_team, p.play_result,
                   p.tagged_hit_type, p.exit_speed, p.launch_angle AS angle, p.direction,
                   p.bearing, p.distance, p.hang_time,
                   po.fielders, po.shift, s.session_date,
                   s.id AS session_id, s.home_team, s.away_team, s.session_type
            FROM tm_pitches p
            JOIN tm_positioning po ON po.owner_user_id = p.owner_user_id
                                  AND po.pitch_uid = p.pitch_uid
            JOIN tm_sessions s ON s.id = p.session_id
            WHERE p.owner_user_id = %s AND p.exit_speed IS NOT NULL
              {ctx_sql} {d_sql} {team_sql}
        """, [owner] + ctx_params + d_params + team_params)
        rows = cur.fetchall()
        # team-level positioning: every positioned pitch (not just BBE)
        cur.execute(f"""
            SELECT po.fielders, po.shift
            FROM tm_positioning po
            JOIN tm_pitches p ON p.owner_user_id = po.owner_user_id
                             AND p.pitch_uid = po.pitch_uid
            JOIN tm_sessions s ON s.id = p.session_id
            WHERE po.owner_user_id = %s {ctx_sql} {d_sql} {team_sql}
        """, [owner] + ctx_params + d_params + team_params)
        all_pos = cur.fetchall()
        conn.commit()

    def fnum(v):
        return float(v) if v is not None else None

    of_stats, if_stats = {}, {}
    plays = []

    def bump(store, name, pos):
        # keyed (player, position): per-position ratings only ever contain
        # chances AT that position; the overall boards merge these later.
        st = store.setdefault((name, pos), {
            "player": name, "pos": pos, "opps": 0, "outs": 0, "x_outs": 0.0,
            "errors": 0, "through": 0,
            "buckets": {"routine": [0, 0], "2star": [0, 0], "3star": [0, 0],
                        "4star": [0, 0], "5star": [0, 0]},
            "dirs": {d: [0, 0, 0.0] for d in ("in", "back", "left", "right")},
        })
        return st

    games = {}

    def game_bump(r):
        g = games.setdefault(r["session_id"], {
            "session_id": r["session_id"],
            "date": r["session_date"].isoformat() if r["session_date"] else None,
            "matchup": f"{r['away_team'] or '?'} @ {r['home_team'] or '?'}",
            "session_type": r["session_type"],
            "opps": 0, "outs": 0, "x_outs": 0.0,
            "best_play": None, "worst_miss": None,
        })
        return g

    def game_track(r, fielder, pos, prob, made):
        g = game_bump(r)
        g["opps"] += 1
        g["outs"] += 1 if made else 0
        g["x_outs"] += prob
        entry = {"fielder": fielder, "pos": pos, "prob": round(prob, 3)}
        if made and (g["best_play"] is None or prob < g["best_play"]["prob"]):
            g["best_play"] = entry
        if not made and (g["worst_miss"] is None or prob > g["worst_miss"]["prob"]):
            g["worst_miss"] = entry

    for r in rows:
        f = r["fielders"] or {}
        res = r["play_result"]
        made = res in OUT_RESULTS
        htype = (r["tagged_hit_type"] or "")
        angle = fnum(r["angle"])
        ev = fnum(r["exit_speed"])
        # ── outfield air balls ──
        is_air = (htype in ("FlyBall", "LineDrive", "Popup")
                  or (angle is not None and angle >= 10)) and res != "HomeRun"
        bearing, dist, hang = fnum(r["bearing"]), fnum(r["distance"]), fnum(r["hang_time"])
        # Air balls: EVERY fielder is a candidate and the best catch
        # probability wins responsibility — deep balls naturally go to the
        # outfield (their probability dominates), popups to the infield, and
        # bloops behind the infield to whoever truly has the best shot (which
        # is what fills the infield 'back' column). Balls landing inside
        # 60 ft are catcher/pitcher territory — neither is tracked in the
        # positioning file, so they're excluded.
        if (is_air and bearing is not None and dist is not None and dist >= 60
                and hang is not None and hang >= 1.3):
            lx, lz = landing_xz(bearing, dist)
            candidates = OF_POSITIONS + IF_POSITIONS
            best = None
            for pos in candidates:
                fd = f.get(pos)
                if not fd:
                    continue
                got = catch_probability(fd["x"], fd["z"], lx, lz, hang)
                if got and (best is None or got[0] > best[2]):
                    best = (pos, fd, got[0], got[1])
            if best:
                pos, fd, prob, run_dist = best
                # uncatchable-by-anyone balls aren't opportunities
                if prob >= 0.03:
                    group_of = pos in OF_POSITIONS
                    st = bump(of_stats if group_of else if_stats, fd["name"] or pos, pos)
                    st["opps"] += 1
                    st["outs"] += 1 if made else 0
                    st["x_outs"] += prob
                    if not made:
                        st["errors" if res == "Error" else "through"] += 1
                    bk = difficulty_bucket(prob)
                    st["buckets"][bk][0] += 1
                    st["buckets"][bk][1] += 1 if made else 0
                    mdir = move_direction(fd["x"], fd["z"], lx, lz)
                    dd = st["dirs"][mdir]
                    dd[0] += 1; dd[1] += 1 if made else 0; dd[2] += prob
                    game_track(r, fd["name"] or pos, pos, prob, made)
                    plays.append({
                        "type": "OF" if group_of else "IF", "fielder": fd["name"] or pos, "pos": pos,
                        "prob": round(prob, 3), "made": made, "dir": mdir,
                        "dist": round(run_dist), "hang": round(hang, 1),
                        "land_x": round(lx, 1), "land_z": round(lz, 1),
                        "result": res, "batter": r["batter"],
                        "date": r["session_date"].isoformat() if r["session_date"] else None,
                    })
        # ── infield ground balls ──
        direction = fnum(r["direction"])
        is_gb = htype == "GroundBall" or (angle is not None and angle < 10 and htype != "Bunt")
        if is_gb and direction is not None and ev is not None and abs(direction) <= 55:
            best = None
            for pos in IF_POSITIONS:
                fd = f.get(pos)
                if not fd:
                    continue
                got = gb_out_probability(fd["x"], fd["z"], direction, ev)
                if got and (best is None or got[0] > best[2]):
                    best = (pos, fd, got[0], got[1], got[3])
            if best:
                pos, fd, prob, d_perp, foot = best
                st = bump(if_stats, fd["name"] or pos, pos)
                st["opps"] += 1
                st["outs"] += 1 if made else 0
                st["x_outs"] += prob
                if not made:
                    # Error = the scorer says he REACHED it (glove or throw
                    # failed); anything else got through = range
                    st["errors" if res == "Error" else "through"] += 1
                bk = difficulty_bucket(prob)
                st["buckets"][bk][0] += 1
                st["buckets"][bk][1] += 1 if made else 0
                mdir = move_direction(fd["x"], fd["z"], foot[0], foot[1])
                dd = st["dirs"][mdir]
                dd[0] += 1; dd[1] += 1 if made else 0; dd[2] += prob
                game_track(r, fd["name"] or pos, pos, prob, made)
                plays.append({
                    "type": "IF", "fielder": fd["name"] or pos, "pos": pos,
                    "prob": round(prob, 3), "made": made, "dir": mdir,
                    "dist": round(d_perp), "ev": round(ev),
                    "land_x": None, "land_z": None,
                    "result": res, "batter": r["batter"],
                    "date": r["session_date"].isoformat() if r["session_date"] else None,
                })

    def _rates(st):
        st["x_outs"] = round(st["x_outs"], 1)
        st["oae"] = round(st["outs"] - st["x_outs"], 1)
        st["conv_pct"] = round(st["outs"] / st["opps"], 3) if st["opps"] else None
        st["x_conv_pct"] = round(st["x_outs"] / st["opps"], 3) if st["opps"] else None
        st["dirs"] = {d: {"opps": v[0], "outs": v[1],
                          "oae": round(v[1] - v[2], 1)} if v[0] else None
                      for d, v in st["dirs"].items()}
        return st

    def finish(store):
        """(player,pos) stations -> (overall merged by player, per-position)."""
        merged = {}
        for (name, pos), st in store.items():
            m = merged.setdefault(name, {
                "player": name, "positions": set(), "opps": 0, "outs": 0, "x_outs": 0.0,
                "errors": 0, "through": 0,
                "buckets": {k: [0, 0] for k in st["buckets"]},
                "dirs": {d: [0, 0, 0.0] for d in ("in", "back", "left", "right")},
            })
            m["positions"].add(pos)
            for k in ("opps", "outs", "x_outs", "errors", "through"):
                m[k] += st[k]
            for k, v in st["buckets"].items():
                m["buckets"][k][0] += v[0]; m["buckets"][k][1] += v[1]
            for d, v in st["dirs"].items():
                md = m["dirs"][d]
                md[0] += v[0]; md[1] += v[1]; md[2] += v[2]
        overall = []
        for m in merged.values():
            m["positions"] = sorted(m["positions"])
            overall.append(_rates(m))
        by_pos = {}
        for (name, pos), st in store.items():
            row = dict(st)
            row["buckets"] = {k: list(v) for k, v in st["buckets"].items()}
            row["dirs"] = {d: list(v) for d, v in st["dirs"].items()}
            by_pos.setdefault(pos, []).append(_rates(row))
        for pos in by_pos:
            by_pos[pos].sort(key=lambda x: -x["oae"])
        return sorted(overall, key=lambda x: -x["oae"]), by_pos

    # average start positions + shift usage
    pos_sum, shift_counts = {}, {}
    for r in all_pos:
        if r["shift"]:
            shift_counts[r["shift"]] = shift_counts.get(r["shift"], 0) + 1
        for pos, fd in (r["fielders"] or {}).items():
            a = pos_sum.setdefault(pos, [0.0, 0.0, 0])
            a[0] += fd["x"]; a[1] += fd["z"]; a[2] += 1
    avg_positions = {pos: {"x": round(a[0] / a[2], 1), "z": round(a[1] / a[2], 1), "n": a[2]}
                     for pos, a in pos_sum.items() if a[2]}

    plays.sort(key=lambda p: p["prob"])
    of_overall, of_by_pos = finish(of_stats)
    if_overall, if_by_pos = finish(if_stats)
    game_rows = []
    for g in sorted(games.values(), key=lambda x: (x["date"] or ""), reverse=True):
        g["x_outs"] = round(g["x_outs"], 1)
        g["oae"] = round(g["outs"] - g["x_outs"], 1)
        game_rows.append(g)
    return {
        "positioned_pitches": len(all_pos),
        "positioned_bbe": len(rows),
        "outfield": of_overall,
        "infield": if_overall,
        "by_position": {**of_by_pos, **if_by_pos},
        "games": game_rows,
        "plays": plays[:120],
        "avg_positions": avg_positions,
        "shifts": shift_counts,
    }


@router.get("/trackman/values")
def trackman_values(
    team: str | None = Query(None),
    pos_adj: bool = Query(False),
    shrink: bool = Query(False),
    owner: str = Depends(_gate),
):
    """The Values page: one run-value ledger per player, combining the
    suite's tracked-data models with the site's real season stats.

    OFFENSE   = wRAA from season wOBA vs the division average (PA-weighted,
                30+ PA qualifiers), divided by the division's wOBA scale.
    BASERUN   = SB x 0.2 - CS x 0.4 run weights from season steals.
    INFIELD   = Defense-tab OAE at IF positions x 0.70 runs per out.
    OUTFIELD  = Defense-tab OAE at OF positions x 0.80 runs per out.
    CATCHING  = framing runs + blended arm runs (Catching tab).
    PITCHING  = (division avg FIP - FIP) / 9 x IP (10+ IP qualifiers).
    Every component is average-relative, so 0 = an average player.

    pos_adj adds the WAR-style positional adjustment (premium spots get
    credit: C +4.5, SS +2.5, CF/2B/3B +1.0, LF/RF -2.5, 1B -4.5 runs per
    full college season) scaled by the player's playing time.
    shrink regresses SMALL-SAMPLE tracked values toward zero by chance
    count (defense: n/(n+15); framing: takes/(takes+150)). The arm value
    already regresses via its pop-time prior, so it is left alone."""
    from ..stats.advanced import DEFAULT_WEIGHTS

    def ip_to_decimal(ip):
        # baseball notation: 6.2 = 6 and 2/3
        if ip is None:
            return 0.0
        whole = int(ip)
        frac = round((float(ip) - whole) * 10)
        return whole + frac / 3.0

    # defensive + catching values from the existing computations
    dfs = trackman_defense(context="all", team=team, date_from=None, date_to=None, owner=owner)
    cat = trackman_catching(team=team, owner=owner)
    def _shrunk(oae, opps, k):
        return oae * (opps / (opps + k)) if shrink else oae

    if_runs = {r["player"]: round(_shrunk(r["oae"], r["opps"], 15) * 0.70, 1) for r in dfs["infield"]}
    of_runs = {r["player"]: round(_shrunk(r["oae"], r["opps"], 15) * 0.80, 1) for r in dfs["outfield"]}
    cat_runs = {}
    for c in cat["catchers"]:
        if c.get("total_runs") is None:
            continue
        fr = c.get("framing_runs") or 0
        if shrink and c.get("shadow_taken"):
            fr = fr * (c["shadow_taken"] / (c["shadow_taken"] + 150))
        cat_runs[c["catcher"]] = round(fr + (c.get("arm_runs") or 0), 1)

    # dominant defensive station per player (for the positional adjustment)
    prim_pos = {}
    for pos, lst in dfs.get("by_position", {}).items():
        for r in lst:
            cur_best = prim_pos.get(r["player"])
            if cur_best is None or r["opps"] > cur_best[1]:
                prim_pos[r["player"]] = (pos, r["opps"])
    for c in cat["catchers"]:
        if (c.get("shadow_taken") or 0) >= 20 or (c.get("throws") or 0) >= 3:
            prev = prim_pos.get(c["catcher"])
            weight = (c.get("shadow_taken") or 0) // 5
            if prev is None or weight > prev[1]:
                prim_pos[c["catcher"]] = ("C", weight)
    POS_ADJ = {"C": 4.5, "SS": 2.5, "CF": 1.0, "2B": 1.0, "3B": 1.0,
               "LF": -2.5, "RF": -2.5, "1B": -4.5}

    # everyone the suite knows about (with their TM team for filtering)
    with get_connection() as conn:
        cur = conn.cursor()
        names = {}
        for col, tcol in (("batter", "batter_team"), ("pitcher", "pitcher_team"),
                          ("catcher", "catcher_team")):
            cur.execute(f"""SELECT {col} AS n, {tcol} AS t, COUNT(*) AS c FROM tm_pitches
                            WHERE owner_user_id = %s AND {col} IS NOT NULL
                            GROUP BY {col}, {tcol}""", (owner,))
            for r in cur.fetchall():
                cur_best = names.get(r["n"])
                if cur_best is None or r["c"] > cur_best[1]:
                    names[r["n"]] = (r["t"], r["c"])
        if team:
            names = {n: v for n, v in names.items()
                     if v[0] == team or n in if_runs or n in of_runs or n in cat_runs}

        # Tracked pitch-level run values (live sessions) — shown alongside
        # the season-FIP pitching value, never summed into the total (they
        # overlap: same innings, two lenses).
        cur.execute(f"""SELECT p.pitcher AS n, p.balls, p.strikes, p.pitch_call, p.play_result
                       FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                       WHERE p.owner_user_id = %s AND p.pitcher IS NOT NULL{_NO_MISTAG}
                         AND s.session_type IN ('game','scrimmage','intrasquad')""", (owner,))
        trv = {}
        _gsum, _gn = 0.0, 0
        for r in cur.fetchall():
            v = pitch_run_value(r["balls"], r["strikes"], r["pitch_call"], r["play_result"])
            if v is not None:
                e = trv.setdefault(r["n"], [0.0, 0])
                e[0] -= v
                e[1] += 1
                _gsum += v
                _gn += 1
        # center on this corpus's average pitch (see _rv_baseline)
        _mean = (_gsum / _gn) if _gn else 0.0
        for e in trv.values():
            e[0] += e[1] * _mean

        # division baselines: PA-weighted wOBA and IP-weighted FIP
        cur.execute("""
            SELECT d.level, SUM(b.woba * b.plate_appearances) / NULLIF(SUM(b.plate_appearances), 0) AS lg_woba
            FROM batting_stats b
            JOIN players p ON p.id = b.player_id JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id JOIN divisions d ON d.id = c.division_id
            WHERE b.season = %s AND b.plate_appearances >= 30 AND b.woba IS NOT NULL
            GROUP BY d.level""", (CURRENT_SEASON,))
        lg_woba = {r["level"]: float(r["lg_woba"]) for r in cur.fetchall()}
        cur.execute("""
            SELECT d.level, SUM(ps.fip * ps.innings_pitched) / NULLIF(SUM(ps.innings_pitched), 0) AS lg_fip
            FROM pitching_stats ps
            JOIN players p ON p.id = ps.player_id JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id JOIN divisions d ON d.id = c.division_id
            WHERE ps.season = %s AND ps.innings_pitched >= 10 AND ps.fip IS NOT NULL
            GROUP BY d.level""", (CURRENT_SEASON,))
        lg_fip = {r["level"]: float(r["lg_fip"]) for r in cur.fetchall()}

        rows = []
        for name, (tm_team, _) in names.items():
            try:
                m = _match_player(cur, name)
            except Exception:
                m = None
            row = {"player": name, "tm_team": tm_team,
                   "player_id": m["player_id"] if m else None,
                   "site_team": m["team"] if m else None,
                   "off_runs": None, "bsr_runs": None, "pitch_runs": None,
                   "if_runs": if_runs.get(name), "of_runs": of_runs.get(name),
                   "catch_runs": cat_runs.get(name),
                   "tracked_rv": (round(trv[name][0], 1)
                                  if name in trv and trv[name][1] >= 30 else None)}
            if m:
                pid = m["player_id"]
                cur.execute("""
                    SELECT b.woba, b.plate_appearances, b.stolen_bases, b.caught_stealing, d.level
                    FROM batting_stats b
                    JOIN players p ON p.id = b.player_id JOIN teams t ON t.id = p.team_id
                    JOIN conferences c ON c.id = t.conference_id JOIN divisions d ON d.id = c.division_id
                    WHERE b.player_id = %s AND b.season = %s
                    ORDER BY b.plate_appearances DESC LIMIT 1""", (pid, CURRENT_SEASON))
                b = cur.fetchone()
                if b and b["woba"] is not None and (b["plate_appearances"] or 0) >= 10:
                    lvl = b["level"] or "D1"
                    w = DEFAULT_WEIGHTS.get(lvl, DEFAULT_WEIGHTS["D1"])
                    lg = lg_woba.get(lvl)
                    if lg:
                        row["off_runs"] = round(
                            (float(b["woba"]) - lg) / w.woba_scale * b["plate_appearances"], 1)
                    sb, cs = b["stolen_bases"] or 0, b["caught_stealing"] or 0
                    if sb or cs:
                        row["bsr_runs"] = round(sb * 0.2 - cs * 0.4, 1)
                    row["pa"] = b["plate_appearances"]
                cur.execute("""
                    SELECT ps.fip, ps.innings_pitched, d.level
                    FROM pitching_stats ps
                    JOIN players p ON p.id = ps.player_id JOIN teams t ON t.id = p.team_id
                    JOIN conferences c ON c.id = t.conference_id JOIN divisions d ON d.id = c.division_id
                    WHERE ps.player_id = %s AND ps.season = %s
                    ORDER BY ps.innings_pitched DESC LIMIT 1""", (pid, CURRENT_SEASON))
                pr = cur.fetchone()
                if pr and pr["fip"] is not None:
                    ip = ip_to_decimal(pr["innings_pitched"])
                    lvl = pr["level"] or "D1"
                    lg = lg_fip.get(lvl)
                    if lg and ip >= 5:
                        row["pitch_runs"] = round((lg - float(pr["fip"])) / 9.0 * ip, 1)
                        row["ip"] = round(ip, 1)
            if pos_adj:
                pp = prim_pos.get(name)
                if pp and pp[0] in POS_ADJ:
                    # scale by playing time: season PA share, or tracked
                    # chances as the fallback proxy for defense-only rows
                    if row.get("pa"):
                        share = min(1.0, row["pa"] / 200.0)
                    else:
                        share = min(1.0, pp[1] / 40.0)
                    row["pos"] = pp[0]
                    row["pos_adj_runs"] = round(POS_ADJ[pp[0]] * share, 1)
            vals = [row[k] for k in ("off_runs", "bsr_runs", "if_runs", "of_runs",
                                     "catch_runs", "pitch_runs", "pos_adj_runs")
                    if row.get(k) is not None]
            if not vals:
                continue
            row["total_runs"] = round(sum(vals), 1)
            rows.append(row)
        conn.commit()

    rows.sort(key=lambda r: -r["total_runs"])
    return {"players": rows, "league_woba": lg_woba, "league_fip": {k: round(v, 2) for k, v in lg_fip.items()}}


# ── Reads ────────────────────────────────────────────────────────

def _date_clause(date_from, date_to):
    sql, params = "", []
    if date_from:
        sql += " AND s.session_date >= %s"; params.append(date_from)
    if date_to:
        sql += " AND s.session_date <= %s"; params.append(date_to)
    return sql, params


def _context_clause(context):
    """WHERE fragment for the session-type filter every view shares."""
    if context in ("game", "scrimmage", "intrasquad", "bp"):
        return " AND s.session_type = %s", [context]
    if context == "live":  # anything with pitch calls
        return " AND s.session_type IN ('game','scrimmage','intrasquad')", []
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
            _ensure_positioning_table(cur)
            cur.execute(
                """SELECT s.id, s.game_id, s.session_date, s.session_type, s.stadium,
                          s.home_team, s.away_team, s.pitch_count, s.bbe_count,
                          s.created_at::date AS uploaded,
                          -- positioning rows joined to this session's pitches by
                          -- PitchUID (the positioning file's GameUID differs from
                          -- the session GameID, so the pitch is the link)
                          (SELECT COUNT(*) FROM tm_pitches p
                           JOIN tm_positioning po ON po.owner_user_id = p.owner_user_id
                                                 AND po.pitch_uid = p.pitch_uid
                           WHERE p.session_id = s.id) AS positioned_count
                   FROM tm_sessions s WHERE s.owner_user_id = %s
                   ORDER BY s.session_date DESC NULLS LAST, s.id DESC""",
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
def delete_trackman_session(session_id: int, owner: str = Depends(_write_gate)):
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
    side: str | None = Query(None),
    owner: str = Depends(_gate),
):
    """Per-pitcher arsenal rollup: every pitch type's usage, velo, shape, and
    results. Pitch type prefers the human tag, falls back to TrackMan's auto
    classification. context: all|live|game|scrimmage|bp; team filters by
    TrackMan team code (e.g. BUS_BEA); side=L|R keeps only pitches to that
    batter handedness (the platoon split)."""
    extra, params = _context_clause(context)
    if side in ("L", "R"):
        extra += " AND p.batter_side = %s"
        params = params + ["Left" if side == "L" else "Right"]
    team_sql = " AND p.pitcher_team = %s" if team else ""
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute(
                f"""SELECT p.pitcher, p.pitcher_throws, p.pitcher_team,
                           COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) AS ptype,
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
                    WHERE p.owner_user_id = %s AND p.pitcher IS NOT NULL{_NO_MISTAG}
                      AND COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) IS NOT NULL
                      {extra}{team_sql}
                    GROUP BY p.pitcher, p.pitcher_throws, p.pitcher_team,
                             COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type)
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

    # Site-standard grades. Stuff: the WCL-trained TrackMan whiff+chase
    # model (same model behind the Rapsodo Lab and summer TrackMan cards),
    # applied natively — these rows ARE TrackMan, so the real separations
    # and unadjusted measurements feed it. Location+: the shared Rapsodo
    # command score (edge presence + pitch-type height targets); plate
    # coordinates are device-independent, converted ft -> in.
    fb_ref = {}
    for r in rows:
        key = (r["pitcher"], r["pitcher_team"])
        cur_best = fb_ref.get(key)
        cand = (r["ptype"] == "Fastball", r["ptype"] in FB_FAMILY, r["n"] or 0)
        if cur_best is None or cand > cur_best[0]:
            fb_ref[key] = (cand, r)

    # Per-pitch pass (same filters): raw plate locations for Location+,
    # plus count-based run values and attack-zone rates per pitcher x type.
    cur_locs = defaultdict(list)
    rv_agg = defaultdict(lambda: {"rv": 0.0, "rv_n": 0, "shadow": 0, "heart": 0, "loc_n": 0})
    with get_connection() as conn:
        c2 = conn.cursor()
        try:
            c2.execute(
                f"""SELECT p.pitcher, p.pitcher_team,
                           COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) AS ptype,
                           p.plate_loc_side, p.plate_loc_height,
                           p.balls, p.strikes, p.pitch_call, p.play_result
                    FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                    WHERE p.owner_user_id = %s AND p.pitcher IS NOT NULL{_NO_MISTAG}
                      AND COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) IS NOT NULL
                      {extra}{team_sql}""",
                [owner] + params + ([team] if team else []),
            )
            for lr in c2.fetchall():
                key = (lr["pitcher"], lr["pitcher_team"], lr["ptype"])
                agg = rv_agg[key]
                if lr["plate_loc_side"] is not None and lr["plate_loc_height"] is not None:
                    cur_locs[key].append(
                        (lr["plate_loc_side"] * 12.0, lr["plate_loc_height"] * 12.0))
                    zone = attack_zone(lr["plate_loc_side"], lr["plate_loc_height"])
                    agg["loc_n"] += 1
                    if zone == "shadow":
                        agg["shadow"] += 1
                    elif zone == "heart":
                        agg["heart"] += 1
                rv = pitch_run_value(lr["balls"], lr["strikes"], lr["pitch_call"], lr["play_result"])
                if rv is not None:
                    agg["rv"] -= rv   # pitcher perspective: positive = runs saved
                    agg["rv_n"] += 1
            base = _rv_baseline(c2, owner, context)
            for agg in rv_agg.values():
                agg["rv"] += agg["rv_n"] * base   # center on this corpus
        except Exception:
            conn.rollback()

    def _grades(t):
        if (t["n"] or 0) < 15:
            return None, None
        fb = fb_ref.get((t["pitcher"], t["pitcher_team"]))
        stuff = grade_trackman(t, fb[1] if fb else t)
        locs = cur_locs.get((t["pitcher"], t["pitcher_team"], t["ptype"]), [])
        loc = location_plus(t["ptype"].lower(), locs) if len(locs) >= 15 else None
        return stuff, loc

    out = []
    for (name, throws, tteam), types in by_pitcher.items():
        total = sum(t["n"] for t in types)
        arsenal = []
        for t in sorted(types, key=lambda x: -x["n"]):
            swings, out_zone = t["swings"] or 0, t["out_zone"] or 0
            stuff, loc = _grades(t)
            agg = rv_agg.get((t["pitcher"], t["pitcher_team"], t["ptype"]),
                             {"rv": 0.0, "rv_n": 0, "shadow": 0, "heart": 0, "loc_n": 0})
            arsenal.append({
                "pitch_type": t["ptype"],
                "stuff": stuff,
                "loc": loc,
                "rv": round(agg["rv"], 1) if agg["rv_n"] else None,
                "rv100": round(100 * agg["rv"] / agg["rv_n"], 2) if agg["rv_n"] >= 15 else None,
                "shadow_pct": round(100 * agg["shadow"] / agg["loc_n"], 1) if agg["loc_n"] >= 15 else None,
                "heart_pct": round(100 * agg["heart"] / agg["loc_n"], 1) if agg["loc_n"] >= 15 else None,
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
        tot_rv = sum(a["rv"] for k, a in rv_agg.items() if k[0] == name and k[1] == tteam)
        tot_rv_n = sum(a["rv_n"] for k, a in rv_agg.items() if k[0] == name and k[1] == tteam)
        tot_shadow = sum(a["shadow"] for k, a in rv_agg.items() if k[0] == name and k[1] == tteam)
        tot_loc = sum(a["loc_n"] for k, a in rv_agg.items() if k[0] == name and k[1] == tteam)
        out.append({"pitcher": name, "throws": throws, "team": tteam,
                    "pitches": total, "arsenal": arsenal,
                    "rv": round(tot_rv, 1) if tot_rv_n else None,
                    "rv100": round(100 * tot_rv / tot_rv_n, 2) if tot_rv_n >= 30 else None,
                    "shadow_pct": round(100 * tot_shadow / tot_loc, 1) if tot_loc >= 30 else None})
    out.sort(key=lambda x: -x["pitches"])
    return {"pitchers": out}


@router.get("/trackman/hitting")
def trackman_hitting(
    team: str | None = Query(None),
    pitch_type: str | None = Query(None),
    throws: str | None = Query(None),
    owner: str = Depends(_gate),
):
    """Per-batter contact quality, split live (game+scrimmage) vs BP —
    the game-to-practice transfer gap. Hard-hit threshold: 90+ mph EV.
    throws=L|R keeps only pitches from that pitcher hand (platoon split)."""
    team_sql = " AND p.batter_team = %s" if team else ""
    pt_sql = " AND COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) = %s" if pitch_type else ""
    th_sql = " AND p.pitcher_throws = %s" if throws in ("L", "R") else ""
    th_params = ["Left" if throws == "L" else "Right"] if throws in ("L", "R") else []
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
                    WHERE p.owner_user_id = %s AND p.batter IS NOT NULL {team_sql}{pt_sql}{th_sql}
                    GROUP BY p.batter, p.batter_side, p.batter_team,
                             CASE WHEN s.session_type = 'bp' THEN 'bp' ELSE 'live' END""",
                [owner] + ([team] if team else []) + ([pitch_type] if pitch_type else []) + th_params,
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

_EFF_TYPE = "COALESCE(override_pitch_type, class_pitch_type, tagged_pitch_type, auto_pitch_type)"

_PCTL_METRICS = [
    # (key, sql expr, higher_is_better)
    # velo + IVB are FASTBALL-family only (matching the leaderboards) — an
    # arsenal-wide average punishes pitchers who throw lots of breaking
    # balls (Keamo's 16" fastball graded 9th pctl off his curveball-heavy
    # 7.3" blend, caught by Nate 2026-08-19).
    ("velo", f"AVG(rel_speed) FILTER (WHERE {_EFF_TYPE} IN ('Fastball','Four-Seam','Sinker'))", True),
    ("ivb", f"AVG(ivb) FILTER (WHERE {_EFF_TYPE} IN ('Fastball','Four-Seam'))", True),
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
    side: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    owner: str = Depends(_gate),
):
    """Everything the Player Lab needs for one pitcher, in one call:
    per-pitch points (movement, release, location, velo), session velo
    trend, count-state usage, and corpus percentiles (min 50 pitches to
    qualify for the percentile pool). side=L|R restricts to that batter
    handedness — the platoon view (percentiles compare same-split pools)."""
    extra, params = _context_clause(context)
    dsql, dparams = _date_clause(date_from, date_to)
    extra, params = extra + dsql, params + dparams
    if side in ("L", "R"):
        extra += " AND p.batter_side = %s"
        params = params + ["Left" if side == "L" else "Right"]
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
            f"""SELECT p.id AS pitch_id, p.tagged_pitch_type, p.override_pitch_type, p.pitcher_throws,
                       COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) AS ptype,
                       p.rel_speed, p.ivb, p.horz_break, p.spin_rate,
                       p.rel_height, p.rel_side, p.extension,
                       p.plate_loc_height, p.plate_loc_side, p.vaa,
                       p.is_in_zone, p.is_swing, p.is_whiff, p.is_chase,
                       p.balls, p.strikes, p.batter_side, p.pitch_call,
                       p.exit_speed, p.launch_angle, p.play_result, p.k_or_bb,
                       p.inning, p.top_bottom, p.pa_of_inning, p.pitch_of_pa,
                       s.session_date, s.id AS session_id
                FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                WHERE p.owner_user_id = %s AND p.pitcher = %s{_NO_MISTAG}
                  AND COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) IS NOT NULL
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
                WHERE p.owner_user_id = %s AND p.pitcher IS NOT NULL{_NO_MISTAG} {extra}
                GROUP BY p.pitcher HAVING COUNT(*) >= 50""",
            [owner] + params,
        )
        pool = [dict(r) for r in cur.fetchall()]
        rv_base = _rv_baseline(cur, owner, context)

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

    with get_connection() as conn:
        link = _match_player(conn.cursor(), pitcher)

    # Rapsodo Lab ports: arm/release profile + pairwise tunneling, fed from
    # this pitcher's TrackMan rows (arm-side HB normalized by throwing hand).
    arm = arm_profile([
        {"pitch": (x["ptype"] or "").lower(), "rel_height": x["rel_height"],
         "rel_side": x["rel_side"], "extension": x["extension"], "vaa": x.get("vaa")}
        for x in pitches
    ])
    hand = "L" if pitches[0].get("pitcher_throws") == "Left" else "R"
    sign = -1.0 if hand == "L" else 1.0
    cents = defaultdict(lambda: defaultdict(list))
    for x in pitches:
        for k, v in (("velo", x["rel_speed"]), ("ivb", x["ivb"]),
                     ("arm_hb", sign * x["horz_break"] if x["horz_break"] is not None else None),
                     ("rel_height", x["rel_height"]), ("rel_side", x["rel_side"]),
                     ("ext", x["extension"])):
            if v is not None:
                cents[x["ptype"]][k].append(float(v))
    arsenal_cents = []
    for t, vals in cents.items():
        if not t:
            continue
        c = {"pitch": t.lower(), "count": len(vals.get("velo", []))}
        for k, arr in vals.items():
            c[k] = sum(arr) / len(arr) if arr else None
        arsenal_cents.append(c)
    tunneling = tunnel_pairs(arsenal_cents, hand)

    # Run values + attack zones per pitch type (pitcher perspective:
    # positive = runs saved vs average).
    rv_types = defaultdict(lambda: {"rv": 0.0, "n": 0, "shadow": 0, "heart": 0, "loc": 0})
    for x in pitches:
        a = rv_types[x["ptype"]]
        v = pitch_run_value(x["balls"], x["strikes"], x["pitch_call"], x.get("play_result"))
        if v is not None:
            a["rv"] -= v
            a["n"] += 1
        z = attack_zone(x["plate_loc_side"], x["plate_loc_height"])
        if z is not None:
            a["loc"] += 1
            if z == "shadow":
                a["shadow"] += 1
            elif z == "heart":
                a["heart"] += 1
    rv_by_type = {
        t: {"rv": round(a["rv"] + a["n"] * rv_base, 1), "n": a["n"],
            "rv100": (round(100 * (a["rv"] + a["n"] * rv_base) / a["n"], 2)
                      if a["n"] >= 15 else None),
            "shadow_pct": round(100 * a["shadow"] / a["loc"], 1) if a["loc"] >= 15 else None,
            "heart_pct": round(100 * a["heart"] / a["loc"], 1) if a["loc"] >= 15 else None}
        for t, a in rv_types.items() if a["n"] or a["loc"]
    }

    # Per-session trend: fastball velo, pitch-weighted Stuff+, and RV/100
    # (the "is he getting better" chart).
    by_sess = defaultdict(list)
    for x in pitches:
        if x["session_date"]:
            by_sess[x["session_date"]].append(x)
    session_trend = []
    for d in sorted(by_sess):
        rows_ = by_sess[d]
        cents2 = defaultdict(lambda: defaultdict(list))
        for x in rows_:
            for k, v in (("velo", x["rel_speed"]), ("ivb", x["ivb"]), ("hb", x["horz_break"]),
                         ("spin", x["spin_rate"]), ("ext", x["extension"]),
                         ("rel_h", x["rel_height"]), ("rel_s", x["rel_side"])):
                if v is not None:
                    cents2[x["ptype"]][k].append(float(v))
        types = {}
        for t, vals in cents2.items():
            entry = {"ptype": t, "n": len(vals.get("velo", []))}
            for k, arr in vals.items():
                entry[k] = sum(arr) / len(arr) if arr else None
            types[t] = entry
        fb = None
        for t, e in types.items():
            cand = (t == "Fastball", t in FB_FAMILY, e["n"])
            if fb is None or cand > fb[0]:
                fb = (cand, e)
        stuff_w = stuff_n = 0
        for t, e in types.items():
            if e["n"] >= 5:
                g = grade_trackman(e, fb[1] if fb else e)
                if g is not None:
                    stuff_w += g * e["n"]
                    stuff_n += e["n"]
        rv = rvn = 0
        for x in rows_:
            v = pitch_run_value(x["balls"], x["strikes"], x["pitch_call"], x.get("play_result"))
            if v is not None:
                rv -= v
                rvn += 1
        rv += rvn * rv_base
        fbv = [x["rel_speed"] for x in rows_
               if x["rel_speed"] is not None and x["ptype"] in FB_FAMILY]
        session_trend.append({
            "date": d, "n": len(rows_),
            "fb_velo": round(sum(fbv) / len(fbv), 1) if fbv else None,
            "stuff": round(stuff_w / stuff_n) if stuff_n else None,
            "rv100": round(100 * rv / rvn, 2) if rvn >= 15 else None,
        })

    return {
        "pitcher": pitcher,
        "pitch_count": len(pitches),
        "pitches": pitches,
        "percentiles": percentiles,
        "count_usage": count_usage,
        "velo_trend": velo_trend,
        "profile": link,
        "arm": arm,
        "tunneling": tunneling,
        "rv_by_type": rv_by_type,
        "session_trend": session_trend,
    }


_LB_CATS_PITCHING = {
    "velo": ("Avg fastball velo", "AVG(rel_speed) FILTER (WHERE COALESCE(override_pitch_type, class_pitch_type, tagged_pitch_type, auto_pitch_type) IN ('Fastball','Four-Seam','Sinker'))", True, 30),
    "max_velo": ("Max velo", "MAX(rel_speed)", True, 30),
    "ivb": ("Fastball IVB", "AVG(ivb) FILTER (WHERE COALESCE(override_pitch_type, class_pitch_type, tagged_pitch_type, auto_pitch_type) IN ('Fastball','Four-Seam'))", True, 30),
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
    if side == "pitching":
        extra += _NO_MISTAG
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

        # Python-priced categories: run values need per-pitch count
        # transitions, so they can't live in the SQL loop above.
        per = {}
        try:
            cur.execute(
                f"""SELECT p.{who} AS name, p.{hand} AS hand, p.{team_col} AS team,
                           p.balls, p.strikes, p.pitch_call, p.play_result,
                           p.plate_loc_side AS px, p.plate_loc_height AS pz
                    FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                    WHERE p.owner_user_id = %s AND p.{who} IS NOT NULL {extra}{team_sql}""",
                [owner] + params + tparams,
            )
            for r in cur.fetchall():
                key = (r["name"], r["hand"], r["team"])
                a = per.setdefault(key, {"rv": 0.0, "rv_n": 0, "shadow": 0, "loc": 0})
                v = pitch_run_value(r["balls"], r["strikes"], r["pitch_call"], r["play_result"])
                if v is not None:
                    a["rv"] += (-v if side == "pitching" else v)
                    a["rv_n"] += 1
                z = attack_zone(r["px"], r["pz"])
                if z is not None:
                    a["loc"] += 1
                    if z == "shadow":
                        a["shadow"] += 1
            # center on the whole corpus in this context (NOT the team
            # slice) so RV matches the Pitching tab and labs exactly
            mean = _rv_baseline(cur, owner, context)
            for a in per.values():
                a["rv"] += a["rv_n"] * (mean if side == "pitching" else -mean)
        except Exception:
            conn.rollback()
            per = {}

    def _pyboard(key, label, rows, min_n, higher=True):
        rows.sort(key=lambda r: (-r["value"] if higher else r["value"]))
        boards[key] = {"label": label, "higher_is_better": higher,
                       "min_sample": min_n, "rows": rows[:25]}

    if side == "pitching":
        _pyboard("rv", "Run value", [
            {"name": k[0], "hand": k[1], "team": k[2], "sample": a["rv_n"], "value": round(a["rv"], 1)}
            for k, a in per.items() if a["rv_n"] >= 50], 50)
        _pyboard("rv100", "RV per 100", [
            {"name": k[0], "hand": k[1], "team": k[2], "sample": a["rv_n"],
             "value": round(100 * a["rv"] / a["rv_n"], 2)}
            for k, a in per.items() if a["rv_n"] >= 100], 100)
        _pyboard("shadow_pct", "Shadow zone%", [
            {"name": k[0], "hand": k[1], "team": k[2], "sample": a["loc"],
             "value": round(100 * a["shadow"] / a["loc"], 1)}
            for k, a in per.items() if a["loc"] >= 100], 100)
    else:
        _pyboard("swtk_rv", "Swing/take RV", [
            {"name": k[0], "hand": k[1], "team": k[2], "sample": a["rv_n"], "value": round(a["rv"], 1)}
            for k, a in per.items() if a["rv_n"] >= 50], 50)
    return {"side": side, "boards": boards}


def _match_player(cur, tm_name):
    """Best-effort link from TrackMan's 'Last, First' to our players table.
    Only returns a match when the name resolves to EXACTLY one active
    canonical player — ambiguity means no link (never guess)."""
    if not tm_name or "," not in tm_name:
        return None
    last, first = [x.strip() for x in tm_name.split(",", 1)]
    if not last or not first:
        return None
    try:
        cur.execute(
            """SELECT p.id, t.short_name AS team
               FROM players p LEFT JOIN teams t ON t.id = p.team_id
               WHERE LOWER(p.first_name) = LOWER(%s) AND LOWER(p.last_name) = LOWER(%s)
                 AND COALESCE(p.is_phantom, FALSE) = FALSE
                 AND NOT EXISTS (SELECT 1 FROM player_links pl WHERE pl.linked_id = p.id)
               LIMIT 3""",
            (first, last),
        )
        rows = cur.fetchall()
    except Exception:
        return None
    if len(rows) == 1:
        return {"player_id": rows[0]["id"], "team": rows[0]["team"]}
    return None


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
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    pitch_type: str | None = Query(None),
    throws: str | None = Query(None),
    owner: str = Depends(_gate),
):
    """Everything the Hitter Lab needs: every pitch SEEN (locations + swing
    decisions), every BBE (EV/LA/spray from Direction+Distance), and
    percentiles vs the other bats in this corpus (30+ pitches seen).
    throws=L|R restricts to that pitcher hand (the platoon view)."""
    extra, params = _context_clause(context)
    dsql, dparams = _date_clause(date_from, date_to)
    extra, params = extra + dsql, params + dparams
    if throws in ("L", "R"):
        extra += " AND p.pitcher_throws = %s"
        params = params + ["Left" if throws == "L" else "Right"]
    if pitch_type:
        extra += " AND COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) = %s"
        params = params + [pitch_type]
    team_sql = " AND p.batter_team = %s" if team else ""
    tparams = [team] if team else []
    conf_sql = (" AND COALESCE(p.hit_launch_conf,'') <> 'Low'" if conf == "strict" else "")
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            f"""SELECT COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) AS ptype,
                       p.pitch_call, p.is_swing, p.is_whiff, p.is_contact, p.is_chase, p.is_in_zone,
                       p.plate_loc_height, p.plate_loc_side, p.balls, p.strikes,
                       p.pitcher_throws, p.batter_side, p.exit_speed, p.launch_angle, p.distance,
                       p.direction, p.bearing, p.play_result, p.tagged_hit_type,
                       p.k_or_bb, p.inning, p.top_bottom, p.pa_of_inning, p.pitch_of_pa,
                       s.session_type, s.session_date, s.id AS session_id
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
        rv_base = _rv_baseline(cur, owner, context)

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

    # Expected stats: group pitches into PAs, take each PA's terminal pitch.
    from ..stats.trackman_xstats import batter_xstats
    pa_map = {}
    for x in pitches:
        key = (x["session_id"], x["inning"], x["top_bottom"], x["pa_of_inning"])
        best = pa_map.get(key)
        if best is None or (x["pitch_of_pa"] or 0) >= (best["pitch_of_pa"] or 0):
            pa_map[key] = x
    pas = []
    for x in pa_map.values():
        if x["k_or_bb"] == "Strikeout":
            o = "K"
        elif x["k_or_bb"] == "Walk":
            o = "BB"
        elif x["pitch_call"] == "HitByPitch":
            o = "HBP"
        elif x["play_result"] == "Sacrifice":
            o = "Sac"
        elif x["play_result"]:
            o = "InPlay"
        else:
            o = "Other"  # PA didn't end in this filtered slice
        pas.append({"outcome": o, "ev": x["exit_speed"], "la": x["launch_angle"],
                    "direction": x.get("direction"),
                    "side": (x.get("batter_side") or "")[:1] or None,
                    "play_result": x["play_result"]})
    xstats = batter_xstats(pas)

    # Swing/take ledger by attack zone (Savant's four regions): every
    # called pitch is priced with the count-based run values — swings and
    # takes separately, so chase damage and good takes both show up.
    zones = {z: {"pitches": 0, "swings": 0, "swing_rv": 0.0, "take_rv": 0.0,
                 "swing_n": 0, "take_n": 0}
             for z in ("heart", "shadow", "chase", "waste")}
    for x in pitches:
        if not x["pitch_call"]:      # BP rows carry no calls — not decisions
            continue
        z = attack_zone(x["plate_loc_side"], x["plate_loc_height"])
        if z is None:
            continue
        zt = zones[z]
        zt["pitches"] += 1
        swung = bool(x["is_swing"])
        if swung:
            zt["swings"] += 1
        rv = pitch_run_value(x["balls"], x["strikes"], x["pitch_call"], x["play_result"])
        if rv is None:
            continue
        if swung:
            zt["swing_rv"] += rv
            zt["swing_n"] += 1
        else:
            zt["take_rv"] += rv
            zt["take_n"] += 1
    swing_take = {}
    for z, zt in zones.items():
        # center each bucket on the corpus-average pitch (see _rv_baseline)
        s_rv = zt["swing_rv"] - zt["swing_n"] * rv_base
        t_rv = zt["take_rv"] - zt["take_n"] * rv_base
        swing_take[z] = {
            "pitches": zt["pitches"],
            "swing_pct": round(100 * zt["swings"] / zt["pitches"], 1) if zt["pitches"] else None,
            "swing_rv": round(s_rv, 1),
            "take_rv": round(t_rv, 1),
            "rv": round(s_rv + t_rv, 1),
        }
    swing_take["total_rv"] = round(sum(swing_take[z]["rv"] for z in zones), 1)

    # Per-session trend: contact quality over time (rolling-chart food).
    from ..stats.trackman_xstats import xwobacon
    sess_trend = {}
    for x in pitches:
        d = x["session_date"]
        if not d:
            continue
        t = sess_trend.setdefault(d, {"date": d, "pitches": 0, "bbe": 0,
                                      "ev_sum": 0.0, "hh": 0, "xw_sum": 0.0, "xw_n": 0})
        t["pitches"] += 1
        if x["exit_speed"] is not None:
            t["bbe"] += 1
            t["ev_sum"] += x["exit_speed"]
            if x["exit_speed"] >= 90:
                t["hh"] += 1
            if x["launch_angle"] is not None:
                t["xw_sum"] += xwobacon(x["exit_speed"], x["launch_angle"], x.get("direction"),
                                        (x.get("batter_side") or "")[:1] or None)
                t["xw_n"] += 1
    trend = []
    for d in sorted(sess_trend):
        t = sess_trend[d]
        trend.append({
            "date": d, "pitches": t["pitches"], "bbe": t["bbe"],
            "avg_ev": round(t["ev_sum"] / t["bbe"], 1) if t["bbe"] else None,
            "hard_hit_pct": round(100 * t["hh"] / t["bbe"], 1) if t["bbe"] else None,
            "xwobacon": round(t["xw_sum"] / t["xw_n"], 3) if t["xw_n"] else None,
        })

    # Inline splits: vs pitcher hand and vs pitch type, precomputed so the
    # lab shows the breakdown without touching a filter. Each line carries
    # decisions (swing/whiff/chase), contact (EV/hard-hit/xwOBAcon), and
    # corpus-centered run value.
    def _split_line(rows_s):
        called = [x for x in rows_s if x["pitch_call"]]
        swings = [x for x in called if x["is_swing"]]
        oz = [x for x in called if x["is_in_zone"] is False]
        bbe_s = [x for x in rows_s if x["exit_speed"] is not None]
        hh = sum(1 for x in bbe_s if x["exit_speed"] >= 90)
        xw = [xwobacon(x["exit_speed"], x["launch_angle"], x.get("direction"),
                       (x.get("batter_side") or "")[:1] or None)
              for x in bbe_s if x["launch_angle"] is not None]
        rv, rvn = 0.0, 0
        for x in called:
            v = pitch_run_value(x["balls"], x["strikes"], x["pitch_call"], x["play_result"])
            if v is not None:
                rv += v - rv_base
                rvn += 1
        return {
            "pitches": len(rows_s),
            "swing_pct": round(100 * len(swings) / len(called), 1) if called else None,
            "whiff_pct": (round(100 * sum(1 for x in swings if x["is_whiff"]) / len(swings), 1)
                          if swings else None),
            "chase_pct": (round(100 * sum(1 for x in oz if x["is_chase"]) / len(oz), 1)
                          if oz else None),
            "bbe": len(bbe_s),
            "avg_ev": round(sum(x["exit_speed"] for x in bbe_s) / len(bbe_s), 1) if bbe_s else None,
            "hard_hit_pct": round(100 * hh / len(bbe_s), 1) if bbe_s else None,
            "xwobacon": round(sum(xw) / len(xw), 3) if xw else None,
            "rv": round(rv, 1) if rvn else None,
        }

    splits = {"hand": {}, "pitch_type": {}}
    for hand, lbl in (("Left", "L"), ("Right", "R")):
        rows_h = [x for x in pitches if x["pitcher_throws"] == hand]
        if rows_h:
            splits["hand"][lbl] = _split_line(rows_h)
    by_pt = defaultdict(list)
    for x in pitches:
        if x["ptype"] and x["ptype"] != "Mistag":
            by_pt[x["ptype"]].append(x)
    for t, rows_t in sorted(by_pt.items(), key=lambda kv: -len(kv[1])):
        if len(rows_t) >= 10:
            splits["pitch_type"][t] = _split_line(rows_t)

    with get_connection() as conn:
        link = _match_player(conn.cursor(), batter)
    return {"batter": batter, "pitch_count": len(pitches),
            "pitches": pitches, "percentiles": percentiles, "profile": link,
            "xstats": xstats, "swing_take": swing_take, "trend": trend,
            "splits": splits}


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
            f"""SELECT pitcher, pitcher_throws, pitcher_team, COUNT(*) AS pitches,
                      COUNT(DISTINCT (inning, top_bottom, pa_of_inning)) AS bf,
                      AVG(rel_speed) AS velo, MAX(rel_speed) AS max_velo,
                      SUM(CASE WHEN is_whiff THEN 1 ELSE 0 END) AS whiffs,
                      SUM(CASE WHEN pitch_call IN ('StrikeCalled','StrikeSwinging') THEN 1 ELSE 0 END) AS csw,
                      SUM(CASE WHEN k_or_bb = 'Strikeout' THEN 1 ELSE 0 END) AS k,
                      SUM(CASE WHEN k_or_bb = 'Walk' THEN 1 ELSE 0 END) AS bb,
                      AVG(CASE WHEN is_in_zone THEN 1.0 WHEN is_in_zone IS FALSE THEN 0.0 END) AS zone,
                      AVG(exit_speed) AS ev_against,
                      SUM(CASE WHEN exit_speed IS NOT NULL THEN 1 ELSE 0 END) AS bbe
               FROM tm_pitches WHERE session_id = %s AND owner_user_id = %s AND pitcher IS NOT NULL{_NO_MISTAG_BARE}
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

        # Zone report: how the plate was called. Shadow band = within
        # 0.25 ft of the K-zone border (both sides). Accuracy = called
        # strikes in the box + called balls out of it.
        cur.execute(
            """SELECT pitch_call, plate_loc_height AS h, plate_loc_side AS x, is_in_zone
               FROM tm_pitches
               WHERE session_id = %s AND owner_user_id = %s
                 AND pitch_call IN ('StrikeCalled','BallCalled')
                 AND plate_loc_height IS NOT NULL AND plate_loc_side IS NOT NULL""",
            (session_id, owner),
        )
        called = cur.fetchall()
        B = 0.25
        def _shadow(r):
            dx = abs(r["x"]) - 0.83
            dyt = r["h"] - 3.5
            dyb = 1.5 - r["h"]
            return (abs(dx) <= B and r["h"] >= 1.5 - B and r["h"] <= 3.5 + B) or \
                   (abs(dyt) <= B and abs(r["x"]) <= 0.83 + B) or \
                   (abs(dyb) <= B and abs(r["x"]) <= 0.83 + B)
        n_called = len(called)
        correct = sum(1 for r in called if (r["pitch_call"] == "StrikeCalled") == bool(r["is_in_zone"]))
        shadow = [r for r in called if _shadow(r)]
        shadow_k = sum(1 for r in shadow if r["pitch_call"] == "StrikeCalled")
        zone_report = {
            "called": n_called,
            "accuracy_pct": round(100 * correct / n_called, 1) if n_called else None,
            "shadow_pitches": len(shadow),
            "shadow_strike_pct": round(100 * shadow_k / len(shadow), 1) if shadow else None,
        }

        sess = dict(sess)
        for k in ("session_date", "created_at"):
            sess[k] = sess[k].isoformat() if sess.get(k) else None
        sess.pop("owner_user_id", None)
    return {"session": sess, "pitcher_lines": lines, "top_bbe": top_bbe,
            "zone_report": zone_report}


@router.get("/trackman/catching")
def trackman_catching(team: str | None = Query(None), owner: str = Depends(_gate)):
    """Advanced catcher metrics.

    FRAMING: on TAKEN pitches (called strike/ball) near the zone edge, a
    location-based strike-probability curve gives expected called strikes,
    CALIBRATED so the whole corpus nets ~zero — Strikes Above Expected
    reads relative to the average catcher/umpire in your own data.
    SAE x 0.125 runs/strike = framing runs.

    THROWING: pop time -> estimated CS% (college-calibrated line), and
    arm runs = tracked attempts x (est CS% - corpus average) x 0.85
    runs per marginal caught steal. TrackMan doesn't record the runner's
    outcome, so this prices the ARM, not the results.

    BLOCKING: TrackMan flags balls in the dirt but NOT whether the
    catcher kept them in front, so blocking is reported as WORKLOAD
    (dirt balls received, rate, breaking-ball share) — never runs."""
    import math as _math
    team_sql, team_params = ("", [])
    if team:
        team_sql, team_params = " AND catcher_team = %s", [team]
    with get_connection() as conn:
        cur = conn.cursor()
        # ── throwing ──
        cur.execute(f"""
            SELECT catcher, catcher_team, COUNT(*) AS throws,
                   AVG(pop_time) AS avg_pop, MIN(pop_time) AS best_pop,
                   AVG(exchange_time) AS avg_exchange,
                   AVG(throw_speed) AS avg_throw, MAX(throw_speed) AS max_throw
            FROM tm_pitches
            WHERE owner_user_id = %s AND catcher IS NOT NULL AND pop_time IS NOT NULL
              {team_sql}
            GROUP BY catcher, catcher_team
        """, [owner] + team_params)
        throw_rows = {(r["catcher"], r["catcher_team"]): dict(r) for r in cur.fetchall()}
        # ── framing: taken pitches with locations ──
        cur.execute(f"""
            SELECT catcher, catcher_team, pitch_call,
                   plate_loc_side AS px, plate_loc_height AS pz
            FROM tm_pitches
            WHERE owner_user_id = %s AND catcher IS NOT NULL
              AND pitch_call IN ('StrikeCalled', 'BallCalled')
              AND plate_loc_side IS NOT NULL AND plate_loc_height IS NOT NULL
              {team_sql}
        """, [owner] + team_params)
        taken = cur.fetchall()
        # ── blocking workload + pitches caught ──
        cur.execute(f"""
            SELECT catcher, catcher_team,
                   COUNT(*) AS pitches,
                   COUNT(*) FILTER (WHERE pitch_call = 'BallinDirt') AS dirt,
                   COUNT(*) FILTER (WHERE pitch_call = 'BallinDirt' AND
                       COALESCE(override_pitch_type, class_pitch_type, tagged_pitch_type, auto_pitch_type)
                       IN ('Slider', 'Curveball', 'Sweeper', 'Splitter', 'ChangeUp')) AS dirt_offspeed
            FROM tm_pitches
            WHERE owner_user_id = %s AND catcher IS NOT NULL
              {team_sql}
            GROUP BY catcher, catcher_team
        """, [owner] + team_params)
        block_rows = {(r["catcher"], r["catcher_team"]): dict(r) for r in cur.fetchall()}
        conn.commit()

    # framing model: signed feet beyond the nearest zone edge
    HALF_W, Z_LO, Z_HI = 0.83, 1.5, 3.5
    BAND = 0.35           # only pitches within ~4 in of the edge carry information
    SCALE = 0.09          # logistic scale in feet (~1.1 in per step)
    RUNS_PER_STRIKE = 0.125

    def edge_dist(px, pz):
        dx = abs(px) - HALF_W
        dz = max(Z_LO - pz, pz - Z_HI)
        out_x, out_z = max(dx, 0.0), max(dz, 0.0)
        if out_x > 0 or out_z > 0:
            return _math.hypot(out_x, out_z)
        return max(dx, dz)   # inside: negative, closest edge

    frames = {}
    for r in taken:
        px, pz = float(r["px"]), float(r["pz"])
        d = edge_dist(px, pz)
        if abs(d) > BAND:
            continue
        p_strike = 1.0 / (1.0 + _math.exp(d / SCALE))
        key = (r["catcher"], r["catcher_team"])
        st = frames.setdefault(key, {"taken": 0, "strikes": 0, "x_strikes": 0.0,
                                     "edges": {"high": [0, 0.0], "low": [0, 0.0],
                                               "left": [0, 0.0], "right": [0, 0.0]}})
        got = 1 if r["pitch_call"] == "StrikeCalled" else 0
        st["taken"] += 1
        st["strikes"] += got
        st["x_strikes"] += p_strike
        # dominant edge for the split
        dx = abs(px) - HALF_W
        dz_hi, dz_lo = pz - Z_HI, Z_LO - pz
        edge = max(("high", dz_hi), ("low", dz_lo),
                   ("left" if px < 0 else "right", dx), key=lambda t: t[1])[0]
        e = st["edges"][edge]
        e[0] += got
        e[1] += p_strike

    # ── actual arm results from the site's season fielding stats ──
    # (Sidearm/NWAC fielding: SB against + CS by, at the catcher position.)
    actuals = {}
    with get_connection() as conn:
        cur = conn.cursor()
        for (name, cteam) in throw_rows:
            try:
                m = _match_player(cur, name)
                pid = m["player_id"] if m else None
            except Exception:
                pid = None
            if not pid:
                continue
            cur.execute(
                """SELECT stolen_bases_against, caught_stealing_by, passed_balls
                   FROM fielding_stats
                   WHERE player_id = %s AND season = %s AND position = 'C'
                   ORDER BY (stolen_bases_against + caught_stealing_by) DESC LIMIT 1""",
                (pid, CURRENT_SEASON))
            r = cur.fetchone()
            if r:
                sba = r["stolen_bases_against"] or 0
                csb = r["caught_stealing_by"] or 0
                actuals[(name, cteam)] = {"sba": sba, "cs": csb, "att": sba + csb,
                                          "pb": r["passed_balls"] or 0, "player_id": pid}

    # Calibrate expectations to THIS corpus: the location curve sets the
    # SHAPE of strike likelihood, but the overall level is scaled so the
    # corpus nets ~zero SAE — framing reads as strikes above the average
    # catcher/umpire environment in your own data (same philosophy as OAE).
    tot_s = sum(f["strikes"] for f in frames.values())
    tot_x = sum(f["x_strikes"] for f in frames.values())
    cal = (tot_s / tot_x) if tot_x else 1.0
    for f in frames.values():
        f["x_strikes"] *= cal
        for e in f["edges"].values():
            e[1] *= cal

    # corpus-average estimated CS% (weighted by attempts) for arm runs
    def est_cs(pop):
        return max(0.05, min(0.65, 0.30 + (2.10 - pop) * 0.6))

    tot_att = sum(r["throws"] for r in throw_rows.values())
    corpus_cs = (sum(est_cs(float(r["avg_pop"])) * r["throws"] for r in throw_rows.values()) / tot_att
                 if tot_att else 0.30)
    # baseline for the blended metric: the corpus's ACTUAL caught-stealing
    # rate when we have enough real attempts, else the pop-based average
    act_att = sum(a["att"] for a in actuals.values())
    act_cs = sum(a["cs"] for a in actuals.values())
    corpus_actual = (act_cs / act_att) if act_att >= 50 else corpus_cs
    ARM_PRIOR_ATT = 15   # the pop-time expectation is worth ~15 attempts of evidence

    catchers = {}
    for key in set(list(throw_rows) + list(frames) + list(block_rows)):
        name, cteam = key
        row = {"catcher": name, "catcher_team": cteam}
        t = throw_rows.get(key)
        if t:
            pop = float(t["avg_pop"])
            cs = est_cs(pop)
            row.update({
                "throws": t["throws"],
                "avg_pop": round(pop, 2), "best_pop": round(float(t["best_pop"]), 2),
                "avg_exchange": round(float(t["avg_exchange"]), 2) if t["avg_exchange"] is not None else None,
                "avg_throw": round(float(t["avg_throw"]), 1) if t["avg_throw"] is not None else None,
                "max_throw": round(float(t["max_throw"]), 1) if t["max_throw"] is not None else None,
                "est_cs_pct": round(cs, 3),
            })
            a = actuals.get(key)
            if a and a["att"] > 0:
                # empirical Bayes: the arm (pop time) is the prior, the real
                # throw-out record updates it; value accrues on REAL attempts
                blended = (a["cs"] + cs * ARM_PRIOR_ATT) / (a["att"] + ARM_PRIOR_ATT)
                row.update({
                    "sba": a["sba"], "cs_actual": a["cs"], "attempts": a["att"],
                    "actual_cs_pct": round(a["cs"] / a["att"], 3),
                    "blended_cs_pct": round(blended, 3),
                    "passed_balls": a["pb"],
                    "arm_basis": "blended",
                    "arm_runs": round(a["att"] * (blended - corpus_actual) * 0.85, 1),
                })
            else:
                row.update({
                    "arm_basis": "est",
                    "arm_runs": round(t["throws"] * (cs - corpus_cs) * 0.85, 1),
                })
        fr = frames.get(key)
        if fr and fr["taken"] >= 5:
            sae = fr["strikes"] - fr["x_strikes"]
            row.update({
                "shadow_taken": fr["taken"], "shadow_strikes": fr["strikes"],
                "x_strikes": round(fr["x_strikes"], 1),
                "sae": round(sae, 1),
                "framing_runs": round(sae * RUNS_PER_STRIKE, 1),
                "shadow_strike_pct": round(fr["strikes"] / fr["taken"], 3),
                "edges": {k: {"strikes": v[0], "x": round(v[1], 1), "sae": round(v[0] - v[1], 1)}
                          for k, v in fr["edges"].items()},
            })
        b = block_rows.get(key)
        if b:
            row.update({
                "pitches_caught": b["pitches"], "dirt_balls": b["dirt"],
                "dirt_per_100": round(b["dirt"] / b["pitches"] * 100, 1) if b["pitches"] else None,
                "dirt_offspeed_pct": round(b["dirt_offspeed"] / b["dirt"], 3) if b["dirt"] else None,
            })
        row["total_runs"] = round((row.get("framing_runs") or 0) + (row.get("arm_runs") or 0), 1)
        catchers[key] = row

    out = sorted(catchers.values(), key=lambda r: -(r.get("total_runs") or 0))
    return {"catchers": out, "corpus_cs_pct": round(corpus_cs, 3)}


# ── Staff notes + Coach Board insights ───────────────────────────



class SessionNotes(BaseModel):
    highlights: str | None = None
    concerns: str | None = None


@router.patch("/trackman/sessions/{session_id}/notes")
def save_session_notes(session_id: int, body: SessionNotes, owner: str = Depends(_gate)):
    """Staff highlights/concerns on a session (shown in Session Review and
    its exports)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("ALTER TABLE tm_sessions ADD COLUMN IF NOT EXISTS highlights TEXT")
        cur.execute("ALTER TABLE tm_sessions ADD COLUMN IF NOT EXISTS concerns TEXT")
        cur.execute(
            "UPDATE tm_sessions SET highlights = %s, concerns = %s WHERE id = %s AND owner_user_id = %s",
            (body.highlights, body.concerns, session_id, owner),
        )
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Session not found.")
        conn.commit()
        return {"status": "ok"}


@router.get("/trackman/insights")
def trackman_insights(team: str | None = Query(None), owner: str = Depends(_gate)):
    """Coach Board v1: read-only auto-flags surfaced from the data. Four
    detectors, all with sample gates so noise can't flag:
      - transfer_gap: live hard-hit% at least 10 pts under BP (15+ BBE each)
      - velo_drop: latest session's FB velo 1.5+ mph under the arm's prior
        average (3+ sessions)
      - usage_whiff: a 20%+ usage pitch whiffing 8+ pts under the corpus
        average for that pitch type, or a <15% usage pitch 10+ pts over it
        (30+ pitches on the pitch)
      - low_zone: arms with 50+ live pitches under 42% zone
    The approve/dismiss decision queue from Trevor's outline is a later
    phase; this ships the signal without the workflow."""
    flags = []
    team_b = " AND p.batter_team = %s" if team else ""
    team_p = " AND p.pitcher_team = %s" if team else ""
    tp = [team] if team else []
    with get_connection() as conn:
        cur = conn.cursor()

        # 1) Transfer gap
        cur.execute(
            f"""SELECT p.batter, p.batter_team,
                       SUM(CASE WHEN s.session_type <> 'bp' AND p.exit_speed IS NOT NULL THEN 1 ELSE 0 END) AS live_bbe,
                       SUM(CASE WHEN s.session_type = 'bp' AND p.exit_speed IS NOT NULL THEN 1 ELSE 0 END) AS bp_bbe,
                       AVG(CASE WHEN s.session_type <> 'bp' AND p.exit_speed IS NOT NULL THEN CASE WHEN p.exit_speed >= 90 THEN 1.0 ELSE 0.0 END END) AS live_hh,
                       AVG(CASE WHEN s.session_type = 'bp' AND p.exit_speed IS NOT NULL THEN CASE WHEN p.exit_speed >= 90 THEN 1.0 ELSE 0.0 END END) AS bp_hh
                FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                WHERE p.owner_user_id = %s AND p.batter IS NOT NULL {team_b}
                GROUP BY p.batter, p.batter_team
                HAVING SUM(CASE WHEN s.session_type <> 'bp' AND p.exit_speed IS NOT NULL THEN 1 ELSE 0 END) >= 15
                   AND SUM(CASE WHEN s.session_type = 'bp' AND p.exit_speed IS NOT NULL THEN 1 ELSE 0 END) >= 15""",
            [owner] + tp,
        )
        for r in cur.fetchall():
            gap = 100 * (float(r["live_hh"] or 0) - float(r["bp_hh"] or 0))
            if gap <= -10:
                flags.append({
                    "kind": "transfer_gap", "player": r["batter"], "team": r["batter_team"],
                    "headline": "BP swing isn't carrying into games",
                    "detail": f"Hard-hit {100 * float(r['bp_hh']):.0f}% in BP vs {100 * float(r['live_hh']):.0f}% live "
                              f"({gap:+.0f} pts, {r['bp_bbe']}/{r['live_bbe']} BBE). Add game-speed velo to BP blocks.",
                    "severity": round(-gap),
                })

        # 2) Velo drop: latest session vs prior average (fastballs)
        cur.execute(
            f"""SELECT p.pitcher, p.pitcher_team, s.session_date, AVG(p.rel_speed) AS velo, COUNT(*) AS n
                FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                WHERE p.owner_user_id = %s AND p.pitcher IS NOT NULL AND p.rel_speed IS NOT NULL
                  AND COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) IN ('Fastball','Sinker')
                  AND s.session_type <> 'bp' AND s.session_date IS NOT NULL {team_p}
                GROUP BY p.pitcher, p.pitcher_team, s.session_date
                HAVING COUNT(*) >= 8 ORDER BY p.pitcher, s.session_date""",
            [owner] + tp,
        )
        by_arm = defaultdict(list)
        for r in cur.fetchall():
            by_arm[(r["pitcher"], r["pitcher_team"])].append((r["session_date"], float(r["velo"])))
        for (name, tteam), sess in by_arm.items():
            if len(sess) < 3:
                continue
            prior = [v for _, v in sess[:-1]]
            last_date, last = sess[-1]
            drop = (sum(prior) / len(prior)) - last
            if drop >= 1.5:
                flags.append({
                    "kind": "velo_drop", "player": name, "team": tteam,
                    "headline": "Fastball velocity down in the latest session",
                    "detail": f"{last:.1f} mph on {last_date} vs {sum(prior)/len(prior):.1f} average over the prior "
                              f"{len(prior)} sessions ({-drop:+.1f}). Check workload before the next outing.",
                    "severity": round(drop * 10),
                })

        # 3) Usage vs whiff mismatch (vs corpus average whiff for the type)
        cur.execute(
            f"""SELECT p.pitcher, p.pitcher_team,
                       COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) AS ptype,
                       COUNT(*) AS n,
                       SUM(CASE WHEN p.is_swing THEN 1 ELSE 0 END) AS swings,
                       SUM(CASE WHEN p.is_whiff THEN 1 ELSE 0 END) AS whiffs
                FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                WHERE p.owner_user_id = %s AND p.pitcher IS NOT NULL{_NO_MISTAG}
                  AND s.session_type <> 'bp'
                  AND COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) IS NOT NULL {team_p}
                GROUP BY p.pitcher, p.pitcher_team, COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type)""",
            [owner] + tp,
        )
        rows = [dict(r) for r in cur.fetchall()]
        # corpus whiff baseline per type (unfiltered by team on purpose)
        type_whiff = defaultdict(lambda: [0, 0])
        for r in rows:
            type_whiff[r["ptype"]][0] += r["whiffs"] or 0
            type_whiff[r["ptype"]][1] += r["swings"] or 0
        totals = defaultdict(int)
        for r in rows:
            totals[(r["pitcher"], r["pitcher_team"])] += r["n"]
        for r in rows:
            n, swings = r["n"], r["swings"] or 0
            if n < 30 or swings < 12:
                continue
            usage = 100 * n / totals[(r["pitcher"], r["pitcher_team"])]
            whiff = 100 * (r["whiffs"] or 0) / swings
            tw = type_whiff[r["ptype"]]
            base = 100 * tw[0] / tw[1] if tw[1] else None
            if base is None:
                continue
            if usage >= 20 and whiff <= base - 8:
                flags.append({
                    "kind": "usage_whiff", "player": r["pitcher"], "team": r["pitcher_team"],
                    "headline": f"Leaning on a {r['ptype']} that isn't missing bats",
                    "detail": f"{usage:.0f}% usage but {whiff:.0f}% whiff vs {base:.0f}% corpus average for the pitch. "
                              f"Consider re-balancing the mix.",
                    "severity": round(base - whiff),
                })
            elif usage < 15 and whiff >= base + 10:
                flags.append({
                    "kind": "usage_whiff", "player": r["pitcher"], "team": r["pitcher_team"],
                    "headline": f"Under-using a bat-missing {r['ptype']}",
                    "detail": f"Only {usage:.0f}% usage at {whiff:.0f}% whiff vs {base:.0f}% corpus average. "
                              f"There may be more outs in this pitch.",
                    "severity": round(whiff - base),
                })

        # 4) Low zone%
        cur.execute(
            f"""SELECT p.pitcher, p.pitcher_team, COUNT(*) AS n,
                       AVG(CASE WHEN p.is_in_zone THEN 1.0 WHEN p.is_in_zone IS FALSE THEN 0.0 END) AS zone
                FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                WHERE p.owner_user_id = %s AND p.pitcher IS NOT NULL{_NO_MISTAG} AND s.session_type <> 'bp' {team_p}
                GROUP BY p.pitcher, p.pitcher_team HAVING COUNT(*) >= 50""",
            [owner] + tp,
        )
        for r in cur.fetchall():
            z = 100 * float(r["zone"] or 0)
            if z < 42:
                flags.append({
                    "kind": "low_zone", "player": r["pitcher"], "team": r["pitcher_team"],
                    "headline": "Living outside the zone",
                    "detail": f"{z:.0f}% zone rate over {r['n']} live pitches. Get-ahead work should anchor the next pen.",
                    "severity": round(42 - z),
                })

    flags.sort(key=lambda f: -f["severity"])
    return {"flags": flags}


# ── Per-pitch classification override (Pitcher Lab) ──────────────

from pydantic import BaseModel as _BM


class PitchTypeOverride(_BM):
    pitch_type: str | None = None  # null clears the override


@router.patch("/trackman/pitches/{pitch_id}/type")
def override_pitch_type(pitch_id: int, body: PitchTypeOverride, owner: str = Depends(_gate)):
    """Manually re-tag one pitch. Overrides win over the auto classifier and
    the TrackMan tags everywhere (arsenals, grades, labs, leaderboards)."""
    if body.pitch_type is not None and body.pitch_type not in SUITE_TYPES:
        raise HTTPException(status_code=400, detail=f"pitch_type must be one of {SUITE_TYPES} or null.")
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE tm_pitches SET override_pitch_type = %s WHERE id = %s AND owner_user_id = %s",
            (body.pitch_type, pitch_id, owner),
        )
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Pitch not found.")
        conn.commit()
    return {"status": "ok"}
