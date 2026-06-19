"""Home page "Leaders Board" — top-3 per stat across 9 hitting + 9 pitching
categories, filterable by division. Built for the wide homepage widget.

Column stats come straight from batting_stats/pitching_stats; BAA and K%-BB%
are simple arithmetic; the pitch-level rates (Contact%, Air-pull%, Strike%,
Whiff%, Putaway%) are aggregated from game_events using the same pitch-sequence
logic as the player pitch-level cards (K=called strike, S=swinging, F=foul).
"""

import time

from fastapi import APIRouter, Query

from app.models.database import get_connection
from app.config import CURRENT_SEASON

home_leaders_router = APIRouter(prefix="/home")

# Simple in-process TTL cache, keyed by (division, season). These leaders change
# at most once a day, but the page is hit often and the pitch-level aggregation
# is non-trivial, so cache for 30 min.
_CACHE = {}
_TTL = 1800

MIN_PA = 30          # rate-stat batting qualifier
MIN_IP = 20.0        # rate-stat pitching qualifier
PBP_MIN_PA = 40      # min tracked PAs for pitch-level rates
# Require real ball/strike sequence data, not just PA results — some players
# have PAs logged with empty pitch_sequence, which would make rates degenerate
# (e.g. 100% strike). These floors keep the pitch-level leaders credible.
PBP_MIN_SEQ_BAT = 80
PBP_MIN_SEQ_PIT = 120

LEVEL_TO_DB = {"D1": "D1", "D2": "D2", "D3": "D3", "NAIA": "NAIA", "NWAC": "JUCO"}
DISPLAY_LEVEL = {"JUCO": "NWAC"}


def _pct(v):
    return None if v is None else f"{v * 100:.1f}%"


def _avg3(v):
    return None if v is None else f"{v:.3f}".replace("0.", ".", 1)


def _build(rows, *, value, fmt, desc=True, min_filter=None, n=3):
    """Pick top-n rows by `value(row)`; format the display via `fmt(v)`."""
    pool = []
    for r in rows:
        if min_filter and not min_filter(r):
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

        # ── Batting season rows ──
        cur.execute(f"""
            SELECT p.first_name || ' ' || p.last_name AS name,
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
            SELECT p.first_name || ' ' || p.last_name AS name,
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

        # ── Batter pitch-level aggregates (Contact%, Air-pull%) ──
        cur.execute(f"""
            SELECT p.first_name || ' ' || p.last_name AS name,
                   t.short_name AS team_short, t.logo_url AS logo, d.level AS db_level,
                   COUNT(*) AS pa,
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
              AND COALESCE(p.is_phantom, false) = false {level_sql}
            GROUP BY p.id, p.first_name, p.last_name, t.short_name, t.logo_url, d.level
            HAVING COUNT(*) >= {PBP_MIN_PA} AND SUM(LENGTH(pitch_sequence)) >= {PBP_MIN_SEQ_BAT}
        """, p)
        bat_pbp = []
        for r in cur.fetchall():
            swings = r["f_s"] + r["f_f"] + r["f_in_play"]
            contact = (r["f_f"] + r["f_in_play"]) / swings if swings else None
            airpull = r["air_pull_n"] / r["air_denom_n"] if (r["air_denom_n"] or 0) >= 5 else None
            bat_pbp.append({**r, "contact": contact, "airpull": airpull})

        # ── Pitcher pitch-level aggregates (Strike%, Whiff%, Putaway%) ──
        cur.execute(f"""
            SELECT p.first_name || ' ' || p.last_name AS name,
                   t.short_name AS team_short, t.logo_url AS logo, d.level AS db_level,
                   COUNT(*) AS pa,
                   COALESCE(SUM(LENGTH(pitch_sequence)),0) AS seq_len,
                   COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence,'K',''))),0) AS n_k,
                   COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence,'S',''))),0) AS f_s,
                   COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence,'F',''))),0) AS f_f,
                   COALESCE(SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END),0) AS f_in_play,
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
              AND COALESCE(p.is_phantom, false) = false {level_sql}
            GROUP BY p.id, p.first_name, p.last_name, t.short_name, t.logo_url, d.level
            HAVING COUNT(*) >= {PBP_MIN_PA} AND SUM(LENGTH(pitch_sequence)) >= {PBP_MIN_SEQ_PIT}
        """, p)
        pit_pbp = []
        for r in cur.fetchall():
            swings = r["f_s"] + r["f_f"] + r["f_in_play"]
            # total pitches = sequence letters + the in-play contact pitch
            total_pitches = r["seq_len"] + r["f_in_play"]
            strikes = r["n_k"] + r["f_s"] + r["f_f"] + r["f_in_play"]
            strike = strikes / total_pitches if total_pitches else None
            whiff = r["f_s"] / swings if swings else None
            putaway = r["ts_k"] / r["ts_pa"] if (r["ts_pa"] or 0) >= 5 else None
            pit_pbp.append({**r, "strike": strike, "whiff": whiff, "putaway": putaway})

    qpa = lambda r: (r["pa"] or 0) >= MIN_PA
    qip = lambda r: (r["ip"] or 0) >= MIN_IP

    def baa(r):
        denom = (r["batters_faced"] or 0) - (r["walks"] or 0) - (r["hit_batters"] or 0)
        return (r["hits_allowed"] / denom) if denom > 0 else None

    hitting = [
        {"key": "owar", "label": "oWAR", "leaders": _build(bat, value=lambda r: r["owar"], fmt=lambda v: f"{v:.1f}", min_filter=qpa)},
        {"key": "wrc_plus", "label": "wRC+", "leaders": _build(bat, value=lambda r: r["wrc_plus"], fmt=lambda v: f"{v:.0f}", min_filter=qpa)},
        {"key": "avg", "label": "AVG", "leaders": _build(bat, value=lambda r: r["avg"], fmt=_avg3, min_filter=qpa)},
        {"key": "hr", "label": "HR", "leaders": _build(bat, value=lambda r: r["hr"], fmt=lambda v: f"{v:.0f}")},
        {"key": "sb", "label": "SB", "leaders": _build(bat, value=lambda r: r["sb"], fmt=lambda v: f"{v:.0f}")},
        {"key": "rbi", "label": "RBI", "leaders": _build(bat, value=lambda r: r["rbi"], fmt=lambda v: f"{v:.0f}")},
        {"key": "contact", "label": "Contact%", "leaders": _build(bat_pbp, value=lambda r: r["contact"], fmt=_pct)},
        {"key": "airpull", "label": "Air-Pull%", "leaders": _build(bat_pbp, value=lambda r: r["airpull"], fmt=_pct)},
        {"key": "kbb", "label": "K%-BB%", "leaders": _build(bat, value=lambda r: (None if r["k_pct"] is None or r["bb_pct"] is None else r["k_pct"] - r["bb_pct"]), fmt=_pct, desc=False, min_filter=qpa)},
    ]
    pitching = [
        {"key": "pwar", "label": "pWAR", "leaders": _build(pit, value=lambda r: r["pwar"], fmt=lambda v: f"{v:.1f}", min_filter=qip)},
        {"key": "fip_plus", "label": "FIP+", "leaders": _build(pit, value=lambda r: r["fip_plus"], fmt=lambda v: f"{v:.0f}", min_filter=qip)},
        {"key": "era", "label": "ERA", "leaders": _build(pit, value=lambda r: r["era"], fmt=lambda v: f"{v:.2f}", desc=False, min_filter=qip)},
        {"key": "baa", "label": "BAA", "leaders": _build(pit, value=baa, fmt=_avg3, desc=False, min_filter=qip)},
        {"key": "k_pct", "label": "K%", "leaders": _build(pit, value=lambda r: r["k_pct"], fmt=_pct, min_filter=qip)},
        {"key": "bb_pct", "label": "BB%", "leaders": _build(pit, value=lambda r: r["bb_pct"], fmt=_pct, desc=False, min_filter=qip)},
        {"key": "strike", "label": "Strike%", "leaders": _build(pit_pbp, value=lambda r: r["strike"], fmt=_pct)},
        {"key": "whiff", "label": "Whiff%", "leaders": _build(pit_pbp, value=lambda r: r["whiff"], fmt=_pct)},
        {"key": "putaway", "label": "Putaway%", "leaders": _build(pit_pbp, value=lambda r: r["putaway"], fmt=_pct)},
    ]

    result = {"division": division, "season": season, "hitting": hitting, "pitching": pitching}
    _CACHE[ck] = (time.time(), result)
    return result
