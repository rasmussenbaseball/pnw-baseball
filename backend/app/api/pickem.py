"""
WCL Pick 'Em — weekly confidence pool (SERIES edition).

WCL teams play 3-game series (Tue–Thu, Fri–Sun), so the pool is by SERIES, not
by individual game: each week you pick a series winner for every WCL series and
rank them 1..N (no repeats). A correct series pick earns its confidence value.

Schedule + results come straight from `summer_games` (our own scraper), grouped
into series on the fly. Only WCL-vs-WCL series count (exhibition games against
non-WCL clubs are filtered out). A 3-game series clinches at 2 wins; a tie/split
(e.g. a rained-out 1-1) is a push (0 points, no penalty).

Design choices (v1):
  - Identity = Supabase Auth user_id; display_name denormalized on each pick.
  - A series locks by DATE at its first game (summer_games has no first-pitch
    time). Whole-week model: submit your full card before the week's first
    series locks; after that it's view-only.
  - Other players' picks are hidden in /entries until that series locks.
  - Scoring is server-side from real results.
"""

from datetime import date, datetime
from typing import List, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..models.database import get_connection
from .auth import get_current_user, get_optional_user
from .summer import compute_summer_cpi

router = APIRouter(prefix="/pickem", tags=["pickem"])

PT = ZoneInfo("America/Los_Angeles")
LEAGUE = "WCL"
DEFAULT_SEASON = 2026

_ensured = False


def _ensure_table():
    global _ensured
    if _ensured:
        return
    with get_connection() as conn:
        cur = conn.cursor()
        # One-time auto-migration: the original schema keyed picks by game_id.
        # The pool is series-based now; the table was empty, so drop+recreate.
        cur.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_name='pickem_picks' AND column_name='game_id'"
        )
        if cur.fetchone():
            cur.execute("DROP TABLE pickem_picks")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS pickem_picks (
                id           BIGSERIAL PRIMARY KEY,
                user_id      TEXT NOT NULL,
                display_name TEXT NOT NULL,
                season       INT  NOT NULL,
                series_id    TEXT NOT NULL,
                pick_team_id INT  NOT NULL,
                confidence   INT  NOT NULL,
                submitted_at TIMESTAMPTZ DEFAULT now(),
                UNIQUE (user_id, series_id)
            );
            """
        )
        cur.execute("CREATE INDEX IF NOT EXISTS idx_pickem_season ON pickem_picks(season);")
        conn.commit()
    _ensured = True


def _today_pt() -> date:
    return datetime.now(PT).date()


def _iso_week_key(d: date) -> str:
    iso = d.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def _fmt_label(start: date, end: date) -> str:
    s = start.strftime("%b %-d")
    e = end.strftime("%-d") if start.month == end.month else end.strftime("%b %-d")
    return f"{s}–{e}"


def _wcl_team_ids(cur) -> set:
    cur.execute(
        """
        SELECT t.id FROM summer_teams t
        JOIN summer_leagues l ON l.id = t.league_id
        WHERE l.abbreviation = %s AND t.is_active
        """,
        (LEAGUE,),
    )
    return {r["id"] for r in cur.fetchall()}


def _fetch_games(cur, season: int):
    cur.execute(
        """
        SELECT g.id, g.game_date, g.status,
               g.away_team_id, g.home_team_id, g.away_score, g.home_score,
               at.name AS away_name, at.short_name AS away_short, at.logo_url AS away_logo,
               ht.name AS home_name, ht.short_name AS home_short, ht.logo_url AS home_logo
        FROM summer_games g
        JOIN summer_leagues l ON l.id = g.league_id
        LEFT JOIN summer_teams at ON at.id = g.away_team_id
        LEFT JOIN summer_teams ht ON ht.id = g.home_team_id
        WHERE l.abbreviation = %s AND g.season = %s
          AND g.away_team_id IS NOT NULL AND g.home_team_id IS NOT NULL
        ORDER BY g.game_date, g.id
        """,
        (LEAGUE, season),
    )
    return [dict(r) for r in cur.fetchall()]


def _build_series(games, wcl_ids):
    """Group games into series: same matchup (away,home), date-contiguous (gap
    <= 1 day), both teams real WCL clubs. Returns a list of series dicts."""
    from collections import defaultdict
    by_match = defaultdict(list)
    for g in games:
        if g["away_team_id"] in wcl_ids and g["home_team_id"] in wcl_ids:
            by_match[(g["away_team_id"], g["home_team_id"])].append(g)

    series = []
    for (aid, hid), gs in by_match.items():
        gs.sort(key=lambda g: (g["game_date"], g["id"]))
        # split into contiguous runs (a new series if the date gap > 1 day)
        run = [gs[0]]
        for prev, cur_g in zip(gs, gs[1:]):
            if (cur_g["game_date"] - prev["game_date"]).days > 1:
                series.append(_make_series(run))
                run = [cur_g]
            else:
                run.append(cur_g)
        series.append(_make_series(run))
    series.sort(key=lambda s: (s["start"], s["away_name"]))
    return series


def _make_series(run):
    g0 = run[0]
    start = run[0]["game_date"]
    end = run[-1]["game_date"]
    total = len(run)
    finals = [g for g in run if g["status"] == "final" and g["away_score"] is not None and g["home_score"] is not None]
    away_wins = sum(1 for g in finals if g["away_score"] > g["home_score"])
    home_wins = sum(1 for g in finals if g["home_score"] > g["away_score"])
    all_final = all(g["status"] == "final" for g in run)
    need = total // 2 + 1  # games needed to clinch (2 of 3, 2 of 2)
    winner = None
    decided = False
    if away_wins >= need:
        winner, decided = g0["away_team_id"], True
    elif home_wins >= need:
        winner, decided = g0["home_team_id"], True
    elif all_final:
        decided = True  # series over; winner stays None on a tie/split = push

    if decided:
        status = "final"
    elif any(g["status"] in ("final", "in_progress", "live") for g in run):
        status = "in_progress"
    else:
        status = "upcoming"

    return {
        "id": f"{g0['away_team_id']}-{g0['home_team_id']}-{start.isoformat()}",
        "week": _iso_week_key(start),
        "start": start,
        "end": end,
        "away_team_id": g0["away_team_id"],
        "home_team_id": g0["home_team_id"],
        "away_name": g0["away_name"] or g0["away_short"] or "Away",
        "home_name": g0["home_name"] or g0["home_short"] or "Home",
        "away_logo": g0["away_logo"],
        "home_logo": g0["home_logo"],
        "away_wins": away_wins,
        "home_wins": home_wins,
        "winner_team_id": winner,
        "is_push": decided and winner is None,
        "status": status,
        "games": [
            {
                "date": g["game_date"].strftime("%a %-d"),
                "status": g["status"],
                "away_score": g["away_score"],
                "home_score": g["home_score"],
            }
            for g in run
        ],
        "_run": run,
    }


def _series_locked(s, today: date) -> bool:
    if any(g["status"] in ("final", "in_progress", "live") for g in s["_run"]):
        return True
    return s["start"] <= today


def _team_meta(season):
    """Per-team record + CPI rank + a couple power stats, keyed by team_id.
    Reuses the Composite Power Index engine (cached). Best-effort: returns {} if
    CPI can't be built (e.g. preseason with no finals yet)."""
    try:
        cpi = compute_summer_cpi(LEAGUE, season)
    except Exception:
        return {}
    out = {}
    for r in (cpi.get("teams") or []):
        out[r["team_id"]] = {
            "cpi_rank": r.get("rank"),
            "wins": r.get("actual_w"),
            "losses": r.get("actual_l"),
            "off_index": r.get("off_index"),
            "pit_index": r.get("pit_index"),
            "run_diff_pg": r.get("run_diff_pg"),
        }
    return out


def _series_payload(s, today: date, tmeta=None):
    tmeta = tmeta or {}
    return {
        "id": s["id"],
        "label": _fmt_label(s["start"], s["end"]),
        "away_team_id": s["away_team_id"],
        "home_team_id": s["home_team_id"],
        "away_name": s["away_name"],
        "home_name": s["home_name"],
        "away_logo": s["away_logo"],
        "home_logo": s["home_logo"],
        "away_wins": s["away_wins"],
        "home_wins": s["home_wins"],
        "winner_team_id": s["winner_team_id"],
        "is_push": s["is_push"],
        "status": s["status"],
        "games": s["games"],
        "locked": _series_locked(s, today),
        # home_team_id already says who hosts; the frontend badges it.
        "away_meta": tmeta.get(s["away_team_id"]),
        "home_meta": tmeta.get(s["home_team_id"]),
    }


def _all_series(cur, season):
    return _build_series(_fetch_games(cur, season), _wcl_team_ids(cur))


def _compute_weeks(series):
    from collections import defaultdict
    buckets = defaultdict(list)
    for s in series:
        buckets[s["week"]].append(s)
    weeks = []
    for k in sorted(buckets):
        ss = buckets[k]
        starts = [s["start"] for s in ss]
        ends = [s["end"] for s in ss]
        weeks.append({
            "key": k,
            "label": _fmt_label(min(starts), max(ends)),
            "start": min(starts).isoformat(),
            "end": max(ends).isoformat(),
            "seriesCount": len(ss),
        })
    return weeks


def _current_week_key(weeks, today: date):
    today_key = _iso_week_key(today)
    keys = [w["key"] for w in weeks]
    if today_key in keys:
        return today_key
    for w in weeks:
        if date.fromisoformat(w["start"]) >= today:
            return w["key"]
    return keys[-1] if keys else None


def _week_series(series, week_key):
    return [s for s in series if s["week"] == week_key]


# ── Weeks ───────────────────────────────────────────────────────────
@router.get("/weeks")
def pickem_weeks(season: int = Query(DEFAULT_SEASON)):
    _ensure_table()
    with get_connection() as conn:
        series = _all_series(conn.cursor(), season)
    weeks = _compute_weeks(series)
    return {"season": season, "weeks": weeks, "current": _current_week_key(weeks, _today_pt())}


# ── Series for a week ───────────────────────────────────────────────
@router.get("/series")
def pickem_series(season: int = Query(DEFAULT_SEASON), week: Optional[str] = Query(None)):
    _ensure_table()
    today = _today_pt()
    with get_connection() as conn:
        series = _all_series(conn.cursor(), season)
    weeks = _compute_weeks(series)
    wk = week or _current_week_key(weeks, today)
    ws = _week_series(series, wk)
    tmeta = _team_meta(season)
    return {"season": season, "week": wk, "series": [_series_payload(s, today, tmeta) for s in ws]}


# ── My picks ────────────────────────────────────────────────────────
@router.get("/my-picks")
def pickem_my_picks(
    season: int = Query(DEFAULT_SEASON),
    week: Optional[str] = Query(None),
    user_id: str = Depends(get_current_user),
):
    _ensure_table()
    today = _today_pt()
    with get_connection() as conn:
        cur = conn.cursor()
        series = _all_series(cur, season)
        weeks = _compute_weeks(series)
        wk = week or _current_week_key(weeks, today)
        wk_ids = {s["id"] for s in _week_series(series, wk)}
        cur.execute(
            "SELECT series_id, pick_team_id, confidence FROM pickem_picks WHERE user_id=%s AND season=%s",
            (user_id, season),
        )
        picks = {
            r["series_id"]: {"pick_team_id": r["pick_team_id"], "confidence": r["confidence"]}
            for r in cur.fetchall()
            if r["series_id"] in wk_ids
        }
    return {"season": season, "week": wk, "picks": picks}


# ── Submit ──────────────────────────────────────────────────────────
class PickItem(BaseModel):
    series_id: str
    pick_team_id: int
    confidence: int


class SubmitBody(BaseModel):
    season: int = DEFAULT_SEASON
    week: str
    display_name: str
    picks: List[PickItem]


@router.post("/picks")
def pickem_submit(body: SubmitBody, user_id: str = Depends(get_current_user)):
    _ensure_table()
    name = (body.display_name or "").strip()[:40]
    if not name:
        raise HTTPException(status_code=400, detail="A display name is required.")
    if not body.picks:
        raise HTTPException(status_code=400, detail="No picks submitted.")

    today = _today_pt()
    with get_connection() as conn:
        cur = conn.cursor()
        series = _all_series(cur, body.season)
        smap = {s["id"]: s for s in series}
        wk_series = _week_series(series, body.week)
        wk_ids = {s["id"] for s in wk_series}

        seen_conf = set()
        for p in body.picks:
            s = smap.get(p.series_id)
            if not s or p.series_id not in wk_ids:
                raise HTTPException(status_code=400, detail=f"Series {p.series_id} is not in week {body.week}.")
            if _series_locked(s, today):
                raise HTTPException(status_code=400, detail="One of these series has already started — refresh and try again.")
            if p.pick_team_id not in (s["away_team_id"], s["home_team_id"]):
                raise HTTPException(status_code=400, detail="Invalid team for a series.")
            if p.confidence in seen_conf:
                raise HTTPException(status_code=400, detail="Each confidence number can only be used once.")
            seen_conf.add(p.confidence)

        n = len(body.picks)
        if seen_conf != set(range(1, n + 1)):
            raise HTTPException(status_code=400, detail=f"Rank every series 1–{n} with no repeats.")

        for p in body.picks:
            cur.execute(
                """
                INSERT INTO pickem_picks (user_id, display_name, season, series_id, pick_team_id, confidence)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (user_id, series_id)
                DO UPDATE SET pick_team_id=EXCLUDED.pick_team_id,
                              confidence=EXCLUDED.confidence,
                              display_name=EXCLUDED.display_name,
                              submitted_at=now()
                """,
                (user_id, name, body.season, p.series_id, p.pick_team_id, p.confidence),
            )
        conn.commit()
    return {"status": "ok", "saved": len(body.picks)}


# ── Leaderboard ─────────────────────────────────────────────────────
@router.get("/leaderboard")
def pickem_leaderboard(
    season: int = Query(DEFAULT_SEASON),
    user_id: Optional[str] = Depends(get_optional_user),
):
    _ensure_table()
    with get_connection() as conn:
        cur = conn.cursor()
        series = _all_series(cur, season)
        smap = {s["id"]: s for s in series}
        cur.execute(
            "SELECT user_id, display_name, series_id, pick_team_id, confidence FROM pickem_picks WHERE season=%s",
            (season,),
        )
        rows = [dict(r) for r in cur.fetchall()]

    standings = {}
    for r in rows:
        u = r["user_id"]
        st = standings.setdefault(u, {"name": r["display_name"], "total": 0, "correct": 0, "wrong": 0, "pending": 0, "is_me": u == user_id})
        st["name"] = r["display_name"]
        s = smap.get(r["series_id"])
        if not s:
            continue
        if s["status"] != "final":
            st["pending"] += 1
        elif s["is_push"]:
            pass  # push: no points, not counted W or L
        elif r["pick_team_id"] == s["winner_team_id"]:
            st["total"] += r["confidence"]
            st["correct"] += 1
        else:
            st["wrong"] += 1

    out = sorted(standings.values(), key=lambda s: (-s["total"], -s["correct"]))
    return {"season": season, "standings": out}


# ── All entries for a week (hidden until each series locks) ─────────
@router.get("/entries")
def pickem_entries(
    season: int = Query(DEFAULT_SEASON),
    week: Optional[str] = Query(None),
    user_id: Optional[str] = Depends(get_optional_user),
):
    _ensure_table()
    today = _today_pt()
    with get_connection() as conn:
        cur = conn.cursor()
        series = _all_series(cur, season)
        weeks = _compute_weeks(series)
        wk = week or _current_week_key(weeks, today)
        wk_series = _week_series(series, wk)
        smap = {s["id"]: s for s in wk_series}
        ids = list(smap.keys())
        rows = []
        if ids:
            cur.execute(
                "SELECT user_id, display_name, series_id, pick_team_id, confidence FROM pickem_picks WHERE season=%s AND series_id = ANY(%s)",
                (season, ids),
            )
            rows = [dict(r) for r in cur.fetchall()]

    entries = {}
    for r in rows:
        u = r["user_id"]
        e = entries.setdefault(u, {"name": r["display_name"], "is_me": u == user_id, "points": 0, "picks": {}})
        e["name"] = r["display_name"]
        s = smap[r["series_id"]]
        locked = _series_locked(s, today)
        reveal = locked or u == user_id
        result = "pend"
        if s["status"] == "final":
            if s["is_push"]:
                result = "push"
            elif r["pick_team_id"] == s["winner_team_id"]:
                result = "win"; e["points"] += r["confidence"]
            else:
                result = "loss"
        e["picks"][r["series_id"]] = {
            "pick_team_id": r["pick_team_id"] if reveal else None,
            "confidence": r["confidence"] if reveal else None,
            "hidden": not reveal,
            "result": result,
        }

    tmeta = _team_meta(season)
    series_payload = [_series_payload(s, today, tmeta) for s in wk_series]
    out = sorted(entries.values(), key=lambda e: -e["points"])
    return {"season": season, "week": wk, "series": series_payload, "entries": out}
