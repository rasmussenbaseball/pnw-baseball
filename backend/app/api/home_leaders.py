"""Home page "Leaders Board" — top-3 per stat across 9 hitting + 9 pitching
categories, filterable by division. Built for the wide homepage widget.

Conventions match the rest of the site so values line up with player pages /
leaderboards:
  - Qualified players only: PA >= 2.0 * team games, IP >= 0.75 * team games
    (team games = wins+losses+ties from team_season_stats; same as routes.py).
  - Pitch-level rates (Contact%, Air-pull%, Strike%, Whiff%, Putaway%) use the
    EXACT pitch_level.py logic: in-play counts only events with pitches_thrown
    set; Strike% denominator is SUM(pitches_thrown); swings = S(swinging) +
    F(foul) + in-play; whiff = S / swings. (Pitch letters: K=called strike,
    S=swinging strike, F=foul, B=ball.)
"""

import math
import time

from fastapi import APIRouter, Query

from app.models.database import get_connection
from app.config import CURRENT_SEASON

home_leaders_router = APIRouter(prefix="/home")

_CACHE = {}
_TTL = 1800

QUALIFIED_PA_PER_GAME = 2.0
QUALIFIED_IP_PER_GAME = 0.75
PBP_MIN_SEQ_BAT = 80     # min tracked sequence pitches for batter rates
PBP_MIN_SEQ_PIT = 120    # min tracked sequence pitches for pitcher rates

LEVEL_TO_DB = {"D1": "D1", "D2": "D2", "D3": "D3", "NAIA": "NAIA", "NWAC": "JUCO"}
DISPLAY_LEVEL = {"JUCO": "NWAC"}


def _pct(v):
    return None if v is None else f"{v * 100:.1f}%"


def _avg3(v):
    return None if v is None else f"{v:.3f}".replace("0.", ".", 1)


def _ip_real(ip):
    """Baseball-notation IP (6.2 = 6 2/3) -> real innings."""
    if ip is None:
        return 0.0
    whole = math.floor(ip)
    frac = round((ip - whole) * 10)
    return whole + frac / 3.0


def _build(rows, *, value, fmt, desc=True, qualify=None, n=3):
    pool = []
    for r in rows:
        if qualify is not None and r["player_id"] not in qualify:
            continue
        v = value(r)
        if v is None:
            continue
        pool.append((v, r))
    pool.sort(key=lambda x: x[0], reverse=desc)
    out = []
    for v, r in pool[:n]:
        out.append({
            "name": r["name"],
            "team": r.get("team_short") or "",
            "level": DISPLAY_LEVEL.get(r.get("db_level"), r.get("db_level")),
            "logo": r.get("logo"),
            "value": round(float(v), 4),
            "display": fmt(v),
        })
    return out


@home_leaders_router.get("/leaders")
def home_leaders(
    division: str = Query("all", description="all | D1 | D2 | D3 | NAIA | NWAC"),
    season: int = Query(CURRENT_SEASON),
):
    division = (division or "all").upper()
    ck = (division, season)
    hit = _CACHE.get(ck)
    if hit and (time.time() - hit[0]) < _TTL:
        return hit[1]

    db_level = LEVEL_TO_DB.get(division) if division != "ALL" else None
    level_sql = "AND d.level = %(lvl)s" if db_level else ""
    p = {"season": season, "lvl": db_level}

    with get_connection() as conn:
        cur = conn.cursor()

        # Team games played (wins+losses+ties) for qualification thresholds.
        cur.execute("""
            SELECT team_id, COALESCE(wins,0)+COALESCE(losses,0)+COALESCE(ties,0) AS g
            FROM team_season_stats WHERE season = %(season)s
        """, p)
        team_games = {r["team_id"]: r["g"] for r in cur.fetchall()}

        # ── Batting season rows ──
        cur.execute(f"""
            SELECT bs.player_id, bs.team_id,
                   p.first_name || ' ' || p.last_name AS name,
                   t.short_name AS team_short, t.logo_url AS logo, d.level AS db_level,
                   bs.plate_appearances AS pa, bs.offensive_war AS owar,
                   bs.wrc_plus, bs.batting_avg AS avg, bs.home_runs AS hr,
                   bs.stolen_bases AS sb, bs.rbi, bs.k_pct, bs.bb_pct
            FROM batting_stats bs
            JOIN players p ON p.id = bs.player_id
            JOIN teams t ON t.id = bs.team_id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE bs.season = %(season)s AND COALESCE(p.is_phantom, false) = false
              {level_sql}
        """, p)
        bat = cur.fetchall()

        # ── Pitching season rows ──
        cur.execute(f"""
            SELECT ps.player_id, ps.team_id,
                   p.first_name || ' ' || p.last_name AS name,
                   t.short_name AS team_short, t.logo_url AS logo, d.level AS db_level,
                   ps.innings_pitched AS ip, ps.pitching_war AS pwar,
                   ps.fip_plus, ps.era, ps.k_pct, ps.bb_pct,
                   ps.hits_allowed, ps.batters_faced, ps.walks, ps.hit_batters
            FROM pitching_stats ps
            JOIN players p ON p.id = ps.player_id
            JOIN teams t ON t.id = ps.team_id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE ps.season = %(season)s AND COALESCE(p.is_phantom, false) = false
              {level_sql}
        """, p)
        pit = cur.fetchall()

        # Qualified player sets (2 PA / 0.75 IP per team game).
        qbat = {r["player_id"] for r in bat
                if (r["pa"] or 0) >= QUALIFIED_PA_PER_GAME * team_games.get(r["team_id"], 0) > 0}
        qpit = {r["player_id"] for r in pit
                if _ip_real(r["ip"]) >= QUALIFIED_IP_PER_GAME * team_games.get(r["team_id"], 0) > 0}

        # ── Batter pitch-level aggregates (Contact%, Air-pull%) ──
        cur.execute(f"""
            SELECT p.id AS player_id,
                   p.first_name || ' ' || p.last_name AS name,
                   t.short_name AS team_short, t.logo_url AS logo, d.level AS db_level,
                   COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence,'S',''))),0) AS f_s,
                   COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence,'F',''))),0) AS f_f,
                   COALESCE(SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END),0) AS f_in_play,
                   COUNT(*) FILTER (WHERE bb_type IN ('LD','FB')
                        AND ((UPPER(p.bats)='R' AND field_zone='LEFT')
                          OR (UPPER(p.bats)='L' AND field_zone='RIGHT'))) AS air_pull_n,
                   COUNT(*) FILTER (WHERE bb_type IS NOT NULL AND UPPER(p.bats) IN ('L','R')) AS air_denom_n
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            JOIN players p ON p.id = ge.batter_player_id
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE g.season = %(season)s AND ge.batter_player_id IS NOT NULL
              AND ge.pitches_thrown >= 1
              AND COALESCE(p.is_phantom, false) = false {level_sql}
            GROUP BY p.id, p.first_name, p.last_name, t.short_name, t.logo_url, d.level
            HAVING SUM(LENGTH(pitch_sequence)) >= {PBP_MIN_SEQ_BAT}
        """, p)
        bat_pbp = []
        for r in cur.fetchall():
            if r["player_id"] not in qbat:
                continue
            swings = r["f_s"] + r["f_f"] + r["f_in_play"]
            r = {**r,
                 "contact": (r["f_f"] + r["f_in_play"]) / swings if swings else None,
                 "airpull": r["air_pull_n"] / r["air_denom_n"] if (r["air_denom_n"] or 0) >= 5 else None}
            bat_pbp.append(r)

        # ── Pitcher pitch-level aggregates (Strike%, Whiff%, Putaway%) ──
        cur.execute(f"""
            SELECT p.id AS player_id,
                   p.first_name || ' ' || p.last_name AS name,
                   t.short_name AS team_short, t.logo_url AS logo, d.level AS db_level,
                   COALESCE(SUM(pitches_thrown),0) AS pitches,
                   COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence,'K',''))),0) AS n_k,
                   COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence,'S',''))),0) AS f_s,
                   COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence,'F',''))),0) AS f_f,
                   COALESCE(SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END),0) AS p_inplay,
                   COALESCE(SUM(CASE WHEN strikes_before=2 THEN 1 ELSE 0 END),0) AS ts_pa,
                   COALESCE(SUM(CASE WHEN strikes_before=2 AND result_type IN
                        ('strikeout_swinging','strikeout_looking') THEN 1 ELSE 0 END),0) AS ts_k
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            JOIN players p ON p.id = ge.pitcher_player_id
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE g.season = %(season)s AND ge.pitcher_player_id IS NOT NULL
              AND ge.pitches_thrown >= 1
              AND COALESCE(p.is_phantom, false) = false {level_sql}
            GROUP BY p.id, p.first_name, p.last_name, t.short_name, t.logo_url, d.level
            HAVING SUM(LENGTH(pitch_sequence)) >= {PBP_MIN_SEQ_PIT}
        """, p)
        pit_pbp = []
        for r in cur.fetchall():
            if r["player_id"] not in qpit:
                continue
            swings = r["f_s"] + r["f_f"] + r["p_inplay"]
            strikes = r["n_k"] + r["f_s"] + r["f_f"] + r["p_inplay"]
            r = {**r,
                 "strike": strikes / r["pitches"] if r["pitches"] else None,
                 "whiff": r["f_s"] / swings if swings else None,
                 "putaway": r["ts_k"] / r["ts_pa"] if (r["ts_pa"] or 0) >= 5 else None}
            pit_pbp.append(r)

    def baa(r):
        denom = (r["batters_faced"] or 0) - (r["walks"] or 0) - (r["hit_batters"] or 0)
        return (r["hits_allowed"] / denom) if denom > 0 else None

    def kbb(r):
        if r["k_pct"] is None or r["bb_pct"] is None:
            return None
        return r["k_pct"] - r["bb_pct"]

    hitting = [
        {"key": "owar", "label": "oWAR", "leaders": _build(bat, value=lambda r: r["owar"], fmt=lambda v: f"{v:.1f}", qualify=qbat)},
        {"key": "wrc_plus", "label": "wRC+", "leaders": _build(bat, value=lambda r: r["wrc_plus"], fmt=lambda v: f"{v:.0f}", qualify=qbat)},
        {"key": "avg", "label": "AVG", "leaders": _build(bat, value=lambda r: r["avg"], fmt=_avg3, qualify=qbat)},
        {"key": "hr", "label": "HR", "leaders": _build(bat, value=lambda r: r["hr"], fmt=lambda v: f"{v:.0f}", qualify=qbat)},
        {"key": "sb", "label": "SB", "leaders": _build(bat, value=lambda r: r["sb"], fmt=lambda v: f"{v:.0f}", qualify=qbat)},
        {"key": "rbi", "label": "RBI", "leaders": _build(bat, value=lambda r: r["rbi"], fmt=lambda v: f"{v:.0f}", qualify=qbat)},
        {"key": "contact", "label": "Contact%", "leaders": _build(bat_pbp, value=lambda r: r["contact"], fmt=_pct)},
        {"key": "airpull", "label": "Air-Pull%", "leaders": _build(bat_pbp, value=lambda r: r["airpull"], fmt=_pct)},
        {"key": "kbb", "label": "K%-BB%", "leaders": _build(bat, value=kbb, fmt=_pct, desc=False, qualify=qbat)},
    ]
    pitching = [
        {"key": "pwar", "label": "pWAR", "leaders": _build(pit, value=lambda r: r["pwar"], fmt=lambda v: f"{v:.1f}", qualify=qpit)},
        {"key": "fip_plus", "label": "FIP+", "leaders": _build(pit, value=lambda r: r["fip_plus"], fmt=lambda v: f"{v:.0f}", qualify=qpit)},
        {"key": "era", "label": "ERA", "leaders": _build(pit, value=lambda r: r["era"], fmt=lambda v: f"{v:.2f}", desc=False, qualify=qpit)},
        {"key": "baa", "label": "BAA", "leaders": _build(pit, value=baa, fmt=_avg3, desc=False, qualify=qpit)},
        {"key": "k_pct", "label": "K%", "leaders": _build(pit, value=lambda r: r["k_pct"], fmt=_pct, qualify=qpit)},
        {"key": "bb_pct", "label": "BB%", "leaders": _build(pit, value=lambda r: r["bb_pct"], fmt=_pct, desc=False, qualify=qpit)},
        {"key": "strike", "label": "Strike%", "leaders": _build(pit_pbp, value=lambda r: r["strike"], fmt=_pct)},
        {"key": "whiff", "label": "Whiff%", "leaders": _build(pit_pbp, value=lambda r: r["whiff"], fmt=_pct)},
        {"key": "putaway", "label": "Putaway%", "leaders": _build(pit_pbp, value=lambda r: r["putaway"], fmt=_pct)},
    ]

    result = {"division": division, "season": season, "hitting": hitting, "pitching": pitching}
    _CACHE[ck] = (time.time(), result)
    return result
