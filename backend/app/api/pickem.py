"""
WCL Pick 'Em — confidence pool API.

A site-wide game: logged-in users pick a winner for every WCL game in a week
and rank each pick 1..N (no repeats). Correct picks earn their confidence value.
Schedule + results come straight from `summer_games` (our own scraper keeps it
fresh), so there's no third-party proxy or HTML scraping.

Design choices (v1):
  - Identity = Supabase Auth user_id. display_name is denormalized on each pick.
  - Picks lock by game DATE: a game can't be picked once its date arrives
    (summer_games has no first-pitch time). Locked = date<=today(PT) or
    status in (final, in_progress/live).
  - Other players' picks are hidden in /entries until that game locks, so
    nobody can copy a sharper player mid-week.
  - Scoring is computed server-side from real results (never trust the client).
"""

from datetime import date, datetime
from typing import List, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..models.database import get_connection
from ..config import CURRENT_SEASON
from .auth import get_current_user, get_optional_user

router = APIRouter(prefix="/pickem", tags=["pickem"])

PT = ZoneInfo("America/Los_Angeles")
LEAGUE = "WCL"
# Summer ball runs in the prior calendar... no — WCL 2026 plays summer 2026.
# Use a dedicated default so the pool isn't tied to the spring CURRENT_SEASON.
DEFAULT_SEASON = 2026

_ensured = False


def _ensure_table():
    global _ensured
    if _ensured:
        return
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS pickem_picks (
                id           BIGSERIAL PRIMARY KEY,
                user_id      TEXT    NOT NULL,
                display_name TEXT    NOT NULL,
                season       INT     NOT NULL,
                game_id      BIGINT  NOT NULL,
                pick_team_id INT     NOT NULL,
                confidence   INT     NOT NULL,
                submitted_at TIMESTAMPTZ DEFAULT now(),
                UNIQUE (user_id, game_id)
            );
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_pickem_season ON pickem_picks(season);"
        )
        conn.commit()
    _ensured = True


def _today_pt() -> date:
    return datetime.now(PT).date()


def _iso_week_key(d: date) -> str:
    iso = d.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def _fmt_label(start: date, end: date) -> str:
    # "Jun 2–8" or "Jun 30–Jul 6"
    s = start.strftime("%b %-d")
    e = end.strftime("%-d") if start.month == end.month else end.strftime("%b %-d")
    return f"{s}–{e}"


def _winner_team_id(g) -> Optional[int]:
    if g["status"] != "final" or g["away_score"] is None or g["home_score"] is None:
        return None
    if g["away_score"] > g["home_score"]:
        return g["away_team_id"]
    if g["home_score"] > g["away_score"]:
        return g["home_team_id"]
    return None  # tie (shouldn't happen in baseball, but be safe)


def _is_locked(g, today: date) -> bool:
    if g["status"] in ("final", "in_progress", "live"):
        return True
    return g["game_date"] <= today


def _fetch_games(cur, season: int):
    """All WCL games for the season, with team names + logos."""
    cur.execute(
        """
        SELECT g.id, g.game_date, g.status,
               g.away_team_id, g.home_team_id,
               g.away_score, g.home_score,
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


def _compute_weeks(games):
    """Bucket games into ISO weeks (Mon start). Returns ordered week dicts."""
    buckets = {}
    for g in games:
        k = _iso_week_key(g["game_date"])
        buckets.setdefault(k, []).append(g)
    weeks = []
    for k in sorted(buckets):
        ds = [g["game_date"] for g in buckets[k]]
        weeks.append(
            {
                "key": k,
                "label": _fmt_label(min(ds), max(ds)),
                "start": min(ds).isoformat(),
                "end": max(ds).isoformat(),
                "gameCount": len(buckets[k]),
            }
        )
    return weeks


def _current_week_key(weeks, today: date):
    today_key = _iso_week_key(today)
    keys = [w["key"] for w in weeks]
    if today_key in keys:
        return today_key
    # else first upcoming week, else last
    for w in weeks:
        if date.fromisoformat(w["start"]) >= today:
            return w["key"]
    return keys[-1] if keys else None


def _game_payload(g, today: date):
    return {
        "id": g["id"],
        "date": g["game_date"].isoformat(),
        "dateLabel": g["game_date"].strftime("%a %b %-d"),
        "status": g["status"],
        "away_team_id": g["away_team_id"],
        "home_team_id": g["home_team_id"],
        "away_name": g["away_name"] or g["away_short"] or "Away",
        "home_name": g["home_name"] or g["home_short"] or "Home",
        "away_logo": g["away_logo"],
        "home_logo": g["home_logo"],
        "away_score": g["away_score"],
        "home_score": g["home_score"],
        "winner_team_id": _winner_team_id(g),
        "locked": _is_locked(g, today),
    }


# ── Schedule / weeks ────────────────────────────────────────────────
@router.get("/weeks")
def pickem_weeks(season: int = Query(DEFAULT_SEASON)):
    _ensure_table()
    with get_connection() as conn:
        cur = conn.cursor()
        games = _fetch_games(cur, season)
    weeks = _compute_weeks(games)
    return {"season": season, "weeks": weeks, "current": _current_week_key(weeks, _today_pt())}


def _week_games(games, week_key):
    return [g for g in games if _iso_week_key(g["game_date"]) == week_key]


@router.get("/games")
def pickem_games(season: int = Query(DEFAULT_SEASON), week: Optional[str] = Query(None)):
    _ensure_table()
    today = _today_pt()
    with get_connection() as conn:
        cur = conn.cursor()
        games = _fetch_games(cur, season)
    weeks = _compute_weeks(games)
    wk = week or _current_week_key(weeks, today)
    wg = _week_games(games, wk)
    return {"season": season, "week": wk, "games": [_game_payload(g, today) for g in wg]}


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
        games = _fetch_games(cur, season)
        weeks = _compute_weeks(games)
        wk = week or _current_week_key(weeks, today)
        wk_ids = {g["id"] for g in _week_games(games, wk)}
        cur.execute(
            "SELECT game_id, pick_team_id, confidence FROM pickem_picks WHERE user_id=%s AND season=%s",
            (user_id, season),
        )
        picks = {
            r["game_id"]: {"pick_team_id": r["pick_team_id"], "confidence": r["confidence"]}
            for r in cur.fetchall()
            if r["game_id"] in wk_ids
        }
    return {"season": season, "week": wk, "picks": picks}


# ── Submit picks ────────────────────────────────────────────────────
class PickItem(BaseModel):
    game_id: int
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
        games = _fetch_games(cur, body.season)
        gmap = {g["id"]: g for g in games}
        wk_games = _week_games(games, body.week)
        wk_ids = {g["id"] for g in wk_games}

        # Validate each pick: in this week, unlocked, team belongs to the game.
        seen_conf = set()
        for p in body.picks:
            g = gmap.get(p.game_id)
            if not g or p.game_id not in wk_ids:
                raise HTTPException(status_code=400, detail=f"Game {p.game_id} is not in week {body.week}.")
            if _is_locked(g, today):
                raise HTTPException(status_code=400, detail="One of these games has already locked — refresh and try again.")
            if p.pick_team_id not in (g["away_team_id"], g["home_team_id"]):
                raise HTTPException(status_code=400, detail=f"Invalid team for game {p.game_id}.")
            if p.confidence in seen_conf:
                raise HTTPException(status_code=400, detail="Each confidence number can only be used once.")
            seen_conf.add(p.confidence)

        # Confidence must be a clean 1..N set over the submitted picks.
        n = len(body.picks)
        if seen_conf != set(range(1, n + 1)):
            raise HTTPException(status_code=400, detail=f"Rank every pick 1–{n} with no repeats.")

        for p in body.picks:
            cur.execute(
                """
                INSERT INTO pickem_picks (user_id, display_name, season, game_id, pick_team_id, confidence)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (user_id, game_id)
                DO UPDATE SET pick_team_id=EXCLUDED.pick_team_id,
                              confidence=EXCLUDED.confidence,
                              display_name=EXCLUDED.display_name,
                              submitted_at=now()
                """,
                (user_id, name, body.season, p.game_id, p.pick_team_id, p.confidence),
            )
        conn.commit()
    return {"status": "ok", "saved": len(body.picks)}


# ── Leaderboard (all-time, this season) ─────────────────────────────
@router.get("/leaderboard")
def pickem_leaderboard(
    season: int = Query(DEFAULT_SEASON),
    user_id: Optional[str] = Depends(get_optional_user),
):
    _ensure_table()
    with get_connection() as conn:
        cur = conn.cursor()
        games = _fetch_games(cur, season)
        gmap = {g["id"]: g for g in games}
        cur.execute(
            "SELECT user_id, display_name, game_id, pick_team_id, confidence FROM pickem_picks WHERE season=%s",
            (season,),
        )
        rows = [dict(r) for r in cur.fetchall()]

    standings = {}
    for r in rows:
        u = r["user_id"]
        st = standings.setdefault(
            u, {"name": r["display_name"], "total": 0, "correct": 0, "wrong": 0, "pending": 0, "is_me": u == user_id}
        )
        st["name"] = r["display_name"]  # keep latest name
        g = gmap.get(r["game_id"])
        if not g:
            continue
        win = _winner_team_id(g)
        if win is None:
            st["pending"] += 1
        elif r["pick_team_id"] == win:
            st["total"] += r["confidence"]
            st["correct"] += 1
        else:
            st["wrong"] += 1

    out = sorted(standings.values(), key=lambda s: (-s["total"], -s["correct"]))
    return {"season": season, "standings": out}


# ── All entries for a week (picks hidden until each game locks) ─────
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
        games = _fetch_games(cur, season)
        weeks = _compute_weeks(games)
        wk = week or _current_week_key(weeks, today)
        wk_games = _week_games(games, wk)
        gmap = {g["id"]: g for g in wk_games}
        wk_ids = list(gmap.keys())
        rows = []
        if wk_ids:
            cur.execute(
                "SELECT user_id, display_name, game_id, pick_team_id, confidence FROM pickem_picks WHERE season=%s AND game_id = ANY(%s)",
                (season, wk_ids),
            )
            rows = [dict(r) for r in cur.fetchall()]

    # Group by user
    entries = {}
    for r in rows:
        u = r["user_id"]
        e = entries.setdefault(u, {"name": r["display_name"], "is_me": u == user_id, "points": 0, "picks": {}})
        e["name"] = r["display_name"]
        g = gmap[r["game_id"]]
        locked = _is_locked(g, today)
        win = _winner_team_id(g)
        # Hide the pick itself until the game locks (anti-copying); always count points.
        reveal = locked or u == user_id
        result = "pend"
        if win is not None:
            result = "win" if r["pick_team_id"] == win else "loss"
            if result == "win":
                e["points"] += r["confidence"]
        e["picks"][r["game_id"]] = {
            "pick_team_id": r["pick_team_id"] if reveal else None,
            "confidence": r["confidence"] if reveal else None,
            "hidden": not reveal,
            "result": result,
        }

    games_payload = [_game_payload(g, today) for g in wk_games]
    out = sorted(entries.values(), key=lambda e: -e["points"])
    return {"season": season, "week": wk, "games": games_payload, "entries": out}
