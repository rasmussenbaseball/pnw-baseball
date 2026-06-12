"""
Team stats aggregation + opponent trends + team scouting surfaces.

Extracted from routes.py (June 2026 split). Shared helpers that still
live in routes.py are imported as `from .routes import ...` — routes.py
never imports this module, so there is no circular import.
"""

import json
import math
import os
import re
import threading
from bisect import bisect_left, bisect_right
from datetime import datetime, date, timedelta

from fastapi import APIRouter, Depends, Query, HTTPException, Body
from fastapi.responses import JSONResponse, FileResponse
from psycopg2.extras import Json
from typing import Optional
from ..models.database import get_connection
from ..cache import cached_endpoint
from ..config import CURRENT_SEASON
from .auth import require_admin, require_tier
from .leverage import compute_li
from .lineup_helper import (
    compute_team_lineup_helper,
    compute_manual_lineup,
    compute_build_lineup,
)
from .team_scouting import compute_team_scouting

# Phase E: batted-ball + spray classifier (lives in scripts/ but is
# pure Python — import via path manipulation so the API can use it.)
import sys as _sys
import pathlib as _pathlib
_sys.path.insert(
    0,
    str(_pathlib.Path(__file__).resolve().parents[3] / "scripts"),
)
try:
    from classify_batted_ball import spray_for as _spray_for  # noqa: E402
except ImportError:
    _spray_for = lambda zone, bats: None  # noqa: E731
from ..stats.advanced import (
    BattingLine, PitchingLine,
    compute_batting_advanced, compute_pitching_advanced, compute_college_war,
    normalize_position, DEFAULT_WEIGHTS,
    POSITION_ADJUSTMENTS_FULL,
    compute_fip_constant, innings_to_outs,
)
from ..stats.tiebreakers import apply_head_to_head
from ..stats.projections import (
    load_future_schedules,
    project_remaining_games,
    run_monte_carlo,
    build_projected_standings,
    determine_playoff_fields,
    elo_win_prob,
    simulate_nwac_championship_odds,
    resolve_known_nwac_results,
    pct_to_american,
    NWAC_2026_CHAMP_SEEDS,
    NWAC_2026_CHAMP_HOST_ID,
    PLAYOFF_FORMATS,
    CONFERENCE_TO_FORMAT,
)

from .routes import ip_to_outs, outs_to_ip, era_from_outs

router = APIRouter()

# ============================================================
# Team Stats Aggregation
# ============================================================

@router.get("/team-stats")
@cached_endpoint(ttl_seconds=1800)
def team_stats_agg(
    season: int = Query(..., description="Season year"),
    stat_type: str = Query("hitting", description="'hitting' or 'pitching'"),
    level: str = Query("all", description="Division level filter: all, D1, D2, D3, NAIA, JUCO"),
):
    """
    Aggregated team-level stats for all teams in a season.
    Returns one row per team with all available stats.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        if stat_type == "hitting":
            cur.execute("""
                SELECT
                    t.id as team_id,
                    t.short_name as team_name,
                    t.logo_url,
                    c.name as conference_name,
                    c.abbreviation as conference_abbrev,
                    d.level as division_level,
                    COALESCE(s.wins, 0) as wins,
                    COALESCE(s.losses, 0) as losses,
                    -- Counting stats
                    SUM(b.games) as games,
                    SUM(b.plate_appearances) as pa,
                    SUM(b.at_bats) as ab,
                    SUM(b.runs) as r,
                    SUM(b.hits) as h,
                    SUM(b.doubles) as "2b",
                    SUM(b.triples) as "3b",
                    SUM(b.home_runs) as hr,
                    SUM(b.rbi) as rbi,
                    SUM(b.walks) as bb,
                    SUM(b.strikeouts) as so,
                    SUM(b.hit_by_pitch) as hbp,
                    SUM(b.sacrifice_flies) as sf,
                    SUM(b.sacrifice_bunts) as sh,
                    SUM(b.stolen_bases) as sb,
                    SUM(b.caught_stealing) as cs,
                    SUM(b.grounded_into_dp) as gdp,
                    -- Rate stats (weighted by PA or AB)
                    CASE WHEN SUM(b.at_bats) > 0
                         THEN ROUND(SUM(b.hits)::numeric / SUM(b.at_bats), 3)
                         ELSE NULL END as avg,
                    CASE WHEN SUM(b.plate_appearances) > 0
                         THEN ROUND((SUM(b.hits) + SUM(b.walks) + SUM(COALESCE(b.hit_by_pitch,0)))::numeric
                              / SUM(b.plate_appearances), 3)
                         ELSE NULL END as obp,
                    CASE WHEN SUM(b.at_bats) > 0
                         THEN ROUND((SUM(b.hits) + SUM(b.doubles) + 2*SUM(b.triples) + 3*SUM(b.home_runs))::numeric
                              / SUM(b.at_bats), 3)
                         ELSE NULL END as slg,
                    CASE WHEN SUM(b.at_bats) > 0 AND SUM(b.plate_appearances) > 0
                         THEN ROUND(
                              (SUM(b.hits) + SUM(b.walks) + SUM(COALESCE(b.hit_by_pitch,0)))::numeric / SUM(b.plate_appearances)
                              + (SUM(b.hits) + SUM(b.doubles) + 2*SUM(b.triples) + 3*SUM(b.home_runs))::numeric / SUM(b.at_bats),
                              3)
                         ELSE NULL END as ops,
                    CASE WHEN SUM(b.at_bats) > 0
                         THEN ROUND(
                              ((SUM(b.hits) + SUM(b.doubles) + 2*SUM(b.triples) + 3*SUM(b.home_runs))::numeric / SUM(b.at_bats))
                              - (SUM(b.hits)::numeric / SUM(b.at_bats)),
                              3)
                         ELSE NULL END as iso,
                    CASE WHEN (SUM(b.at_bats) - SUM(b.strikeouts) - SUM(b.home_runs) + SUM(COALESCE(b.sacrifice_flies,0))) > 0
                         THEN ROUND(
                              (SUM(b.hits) - SUM(b.home_runs))::numeric
                              / (SUM(b.at_bats) - SUM(b.strikeouts) - SUM(b.home_runs) + SUM(COALESCE(b.sacrifice_flies,0))),
                              3)
                         ELSE NULL END as babip,
                    CASE WHEN SUM(b.plate_appearances) > 0
                         THEN ROUND(SUM(b.walks)::numeric / SUM(b.plate_appearances) * 100, 1)
                         ELSE NULL END as bb_pct,
                    CASE WHEN SUM(b.plate_appearances) > 0
                         THEN ROUND(SUM(b.strikeouts)::numeric / SUM(b.plate_appearances) * 100, 1)
                         ELSE NULL END as k_pct,
                    -- Weighted advanced stats (PA-weighted averages with NULL guards).
                    -- Denominator CASE must ALSO require the stat IS NOT NULL, otherwise
                    -- NULL-stat rows add PA to the denominator only and deflate the mean.
                    CASE WHEN SUM(CASE WHEN b.plate_appearances >= 10 AND b.wrc_plus IS NOT NULL THEN b.plate_appearances ELSE 0 END) > 0
                         THEN ROUND(
                              SUM(CASE WHEN b.plate_appearances >= 10 AND b.wrc_plus IS NOT NULL THEN b.wrc_plus * b.plate_appearances ELSE 0 END)::numeric
                              / SUM(CASE WHEN b.plate_appearances >= 10 AND b.wrc_plus IS NOT NULL THEN b.plate_appearances ELSE 0 END),
                              1)
                         ELSE NULL END as wrc_plus,
                    CASE WHEN SUM(CASE WHEN b.plate_appearances >= 10 AND b.woba IS NOT NULL THEN b.plate_appearances ELSE 0 END) > 0
                         THEN ROUND(
                              SUM(CASE WHEN b.plate_appearances >= 10 AND b.woba IS NOT NULL THEN b.woba * b.plate_appearances ELSE 0 END)::numeric
                              / SUM(CASE WHEN b.plate_appearances >= 10 AND b.woba IS NOT NULL THEN b.plate_appearances ELSE 0 END),
                              3)
                         ELSE NULL END as woba,
                    ROUND(SUM(COALESCE(b.wraa, 0))::numeric, 1) as wraa,
                    ROUND(SUM(COALESCE(b.wrc, 0))::numeric, 1) as wrc,
                    ROUND(SUM(COALESCE(b.offensive_war, 0))::numeric, 1) as owar
                FROM teams t
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
                LEFT JOIN batting_stats b ON b.team_id = t.id AND b.season = %s
                WHERE t.is_active = 1
                  AND t.state IN ('WA', 'OR', 'ID', 'MT', 'BC')
                GROUP BY t.id, t.short_name, t.logo_url, c.name, c.abbreviation,
                         d.level, s.wins, s.losses
                HAVING SUM(b.plate_appearances) > 0
                ORDER BY t.short_name
            """, (season, season))
        else:
            # Pitching uses pitching_stats for COUNTING stats (cumulative
            # from league portal — most complete source). Two corrections
            # vs the prior straight-SUM approach:
            #   1. innings_pitched is stored in baseball notation (5.2 = 5 2/3),
            #      so naive SUM treats 5.2 as decimal and undercounts. true_ip
            #      below converts each row's notation before summing.
            #   2. earned_runs from pitching_stats can carry stale ER from
            #      before official scoring corrections. We LEFT JOIN
            #      game_pitching (with ghost-row guard) and prefer that ER
            #      when present, falling back to pitching_stats ER when no
            #      box-score coverage exists for a team-season.
            cur.execute("""
                WITH team_ps AS (
                    SELECT ps.team_id,
                           SUM(COALESCE(ps.games, 0))              AS g,
                           SUM(COALESCE(ps.games_started, 0))      AS gs,
                           SUM(COALESCE(ps.wins, 0))               AS w,
                           SUM(COALESCE(ps.losses, 0))             AS l,
                           SUM(COALESCE(ps.saves, 0))              AS sv,
                           SUM(COALESCE(ps.complete_games, 0))     AS cg,
                           SUM(COALESCE(ps.shutouts, 0))           AS sho,
                           -- True decimal IP (baseball notation 5.2 → 5 2/3)
                           -- via outs. FIP/xFIP/SIERA weighting below weights
                           -- by outs in both numerator and denominator.
                           (SUM(ip_outs(COALESCE(ps.innings_pitched, 0))) / 3.0)::float8 AS ip_decimal,
                           -- True IP (baseball notation 5.2 → 5 2/3 → 5.667)
                           SUM(
                             FLOOR(COALESCE(ps.innings_pitched, 0)) +
                             CASE
                               WHEN ROUND((COALESCE(ps.innings_pitched, 0)
                                          - FLOOR(COALESCE(ps.innings_pitched, 0)))::numeric * 10) = 1
                                 THEN 1.0/3.0
                               WHEN ROUND((COALESCE(ps.innings_pitched, 0)
                                          - FLOOR(COALESCE(ps.innings_pitched, 0)))::numeric * 10) = 2
                                 THEN 2.0/3.0
                               ELSE 0
                             END
                           ) AS ip,
                           SUM(COALESCE(ps.hits_allowed, 0))       AS h,
                           SUM(COALESCE(ps.runs_allowed, 0))       AS r,
                           SUM(COALESCE(ps.earned_runs, 0))        AS er_ps,
                           SUM(COALESCE(ps.walks, 0))              AS bb,
                           SUM(COALESCE(ps.strikeouts, 0))         AS k,
                           SUM(COALESCE(ps.home_runs_allowed, 0))  AS hr,
                           SUM(COALESCE(ps.hit_batters, 0))        AS hbp,
                           SUM(COALESCE(ps.wild_pitches, 0))       AS wp,
                           SUM(COALESCE(ps.batters_faced, 0))      AS bf,
                           ROUND(SUM(COALESCE(ps.pitching_war, 0))::numeric, 1) AS pwar,
                           -- IP-weighted advanced stat numerators and denominators
                           -- (weights by outs in both numerator and denominator
                           -- so the /3 conversion cancels in the ratio)
                           SUM(CASE WHEN ps.innings_pitched >= 3 AND ps.fip IS NOT NULL
                                    THEN ps.fip * ip_outs(ps.innings_pitched) ELSE 0 END) AS fip_num,
                           SUM(CASE WHEN ps.innings_pitched >= 3 AND ps.fip IS NOT NULL
                                    THEN ip_outs(ps.innings_pitched) ELSE 0 END) AS fip_den,
                           SUM(CASE WHEN ps.innings_pitched >= 3 AND ps.xfip IS NOT NULL
                                    THEN ps.xfip * ip_outs(ps.innings_pitched) ELSE 0 END) AS xfip_num,
                           SUM(CASE WHEN ps.innings_pitched >= 3 AND ps.xfip IS NOT NULL
                                    THEN ip_outs(ps.innings_pitched) ELSE 0 END) AS xfip_den,
                           SUM(CASE WHEN ps.innings_pitched >= 3 AND (ps.siera IS NOT NULL OR ps.fip IS NOT NULL)
                                    THEN COALESCE(ps.siera, ps.fip) * ip_outs(ps.innings_pitched) ELSE 0 END) AS siera_num,
                           SUM(CASE WHEN ps.innings_pitched >= 3 AND (ps.siera IS NOT NULL OR ps.fip IS NOT NULL)
                                    THEN ip_outs(ps.innings_pitched) ELSE 0 END) AS siera_den
                    FROM pitching_stats ps
                    WHERE ps.season = %s
                    GROUP BY ps.team_id
                ),
                team_gp_er AS (
                    SELECT gp.team_id,
                           SUM(gp.earned_runs) AS er_gp,
                           COUNT(*) AS n
                    FROM game_pitching gp
                    JOIN games g ON g.id = gp.game_id
                    WHERE g.season = %s
                      AND gp.team_id IN (g.home_team_id, g.away_team_id)
                    GROUP BY gp.team_id
                )
                SELECT
                    t.id as team_id,
                    t.short_name as team_name,
                    t.logo_url,
                    c.name as conference_name,
                    c.abbreviation as conference_abbrev,
                    d.level as division_level,
                    COALESCE(s.wins, 0) as wins,
                    COALESCE(s.losses, 0) as losses,
                    -- Counting stats
                    tp.g, tp.gs, tp.w, tp.l, tp.sv, tp.cg, tp.sho,
                    ROUND(tp.ip::numeric, 1) as ip,
                    tp.h, tp.r AS r,
                    -- ER: prefer per-game-derived (truth-tracking) over cumulative
                    -- (which can carry stale ER pre-scoring-corrections).
                    COALESCE(gp_er.er_gp, tp.er_ps) as er,
                    tp.bb, tp.k as so,
                    tp.hr, tp.hbp, tp.wp, tp.bf,
                    -- Rate stats: divide by true_ip (tp.ip), not the inflated
                    -- baseball-notation-as-decimal sum.
                    CASE WHEN tp.ip > 0
                         THEN ROUND((COALESCE(gp_er.er_gp, tp.er_ps) * 9.0 / tp.ip)::numeric, 2)
                         ELSE NULL END as era,
                    CASE WHEN tp.ip > 0
                         THEN ROUND(((tp.bb + tp.h)::numeric / tp.ip)::numeric, 2)
                         ELSE NULL END as whip,
                    CASE WHEN tp.ip > 0
                         THEN ROUND((tp.k * 9.0 / tp.ip)::numeric, 1)
                         ELSE NULL END as k_per_9,
                    CASE WHEN tp.ip > 0
                         THEN ROUND((tp.bb * 9.0 / tp.ip)::numeric, 1)
                         ELSE NULL END as bb_per_9,
                    CASE WHEN tp.ip > 0
                         THEN ROUND((tp.h * 9.0 / tp.ip)::numeric, 1)
                         ELSE NULL END as h_per_9,
                    CASE WHEN tp.ip > 0
                         THEN ROUND((tp.hr * 9.0 / tp.ip)::numeric, 2)
                         ELSE NULL END as hr_per_9,
                    CASE WHEN tp.bb > 0
                         THEN ROUND((tp.k::numeric / tp.bb)::numeric, 2)
                         ELSE NULL END as k_bb,
                    CASE WHEN tp.bf > 0
                         THEN ROUND(tp.k::numeric / tp.bf * 100, 1)
                         ELSE NULL END as k_pct,
                    CASE WHEN tp.bf > 0
                         THEN ROUND(tp.bb::numeric / tp.bf * 100, 1)
                         ELSE NULL END as bb_pct,
                    -- Opponent batting average (H / (BF - BB - HBP))
                    CASE WHEN (tp.bf - tp.bb - tp.hbp) > 0
                         THEN ROUND(tp.h::numeric / (tp.bf - tp.bb - tp.hbp), 3)
                         ELSE NULL END as opp_avg,
                    -- Weighted advanced stats (IP-weighted averages from pitching_stats)
                    CASE WHEN tp.fip_den > 0
                         THEN ROUND((tp.fip_num / tp.fip_den)::numeric, 2)
                         ELSE NULL END as fip,
                    CASE WHEN tp.xfip_den > 0
                         THEN ROUND((tp.xfip_num / tp.xfip_den)::numeric, 2)
                         ELSE NULL END as xfip,
                    CASE WHEN tp.siera_den > 0
                         THEN ROUND((tp.siera_num / tp.siera_den)::numeric, 2)
                         ELSE NULL END as siera,
                    -- Team BABIP-against from pitching_stats totals.
                    CASE WHEN (tp.bf - tp.bb - tp.hbp - tp.k - tp.hr) > 0
                           AND (tp.h - tp.hr) >= 0
                         THEN ROUND(((tp.h - tp.hr)::numeric
                              / (tp.bf - tp.bb - tp.hbp - tp.k - tp.hr))::numeric, 3)
                         ELSE NULL END as babip,
                    tp.pwar as pwar
                FROM teams t
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
                JOIN team_ps tp ON tp.team_id = t.id
                LEFT JOIN team_gp_er gp_er ON gp_er.team_id = t.id
                WHERE t.is_active = 1
                  AND t.state IN ('WA', 'OR', 'ID', 'MT', 'BC')
                  AND tp.ip > 0
                ORDER BY t.short_name
            """, (season, season, season))

        rows = cur.fetchall()

        # Apply level filter
        if level and level != "all":
            rows = [r for r in rows if r["division_level"] == level]

        return rows


# ── Opponent Trends (Coaching Tool) ─────────────────────────────────────

@router.get("/opponent-trends/{team_id}")
@cached_endpoint(ttl_seconds=1800)  # heavy game_events scouting compute
def opponent_trends(
    team_id: int,
    season: int = Query(CURRENT_SEASON, description="Season year"),
):
    """
    Comprehensive opponent scouting report.
    Builds best-guess starting lineups (unique 9 players) vs LHP/RHP and
    by game number (1-4).  Pitching: rotation, bullpen, predictions.
    Recent games weighted via exponential decay (half-life 10 games).
    """
    from collections import defaultdict, Counter
    import re

    def normalize_name(name):
        """Normalize player names to 'First Last' format.
        Handles: 'Last, First' → 'First Last'
        Strips extra whitespace.
        """
        if not name:
            return name
        name = name.strip()
        if ',' in name:
            parts = name.split(',', 1)
            name = parts[1].strip() + ' ' + parts[0].strip()
        return name

    def build_name_alias_map(names):
        """Build a mapping from abbreviated names (like 'A. Takuma')
        to their full version ('Aiden Takuma') when possible.
        Only maps when there's exactly one matching full name.
        """
        alias = {}
        full_names = [n for n in names if not re.match(r'^[A-Z]\.\s', n)]
        abbrev_names = [n for n in names if re.match(r'^[A-Z]\.\s', n)]
        for abbr in abbrev_names:
            initial = abbr[0]
            last = abbr.split(' ', 1)[1] if ' ' in abbr else ''
            matches = [fn for fn in full_names
                       if fn.startswith(initial) and fn.endswith(last)
                       and ' ' in fn and fn.split(' ', 1)[1] == last]
            if len(matches) == 1:
                alias[abbr] = matches[0]
        return alias

    with get_connection() as conn:
        cur = conn.cursor()

        # ── Team info ──
        cur.execute("""
            SELECT t.id, t.name, t.short_name, t.logo_url,
                   c.name as conference_name, c.abbreviation as conf_abbrev,
                   d.level as division_level
            FROM teams t
            LEFT JOIN conferences c ON t.conference_id = c.id
            LEFT JOIN divisions d ON c.division_id = d.id
            WHERE t.id = %s
        """, (team_id,))
        team = cur.fetchone()
        if not team:
            raise HTTPException(status_code=404, detail="Team not found")
        team = dict(team)

        # ── All final games for this team this season ──
        cur.execute("""
            SELECT g.id, g.game_date, g.game_number, g.home_team_id, g.away_team_id,
                   g.home_score, g.away_score, g.is_conference_game,
                   COALESCE(ht.short_name, ht.name) AS home_short,
                   COALESCE(at2.short_name, at2.name) AS away_short
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            WHERE (g.home_team_id = %s OR g.away_team_id = %s)
              AND g.season = %s AND g.status = 'final'
              AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
            ORDER BY g.game_date ASC, g.game_number ASC, g.id ASC
        """, (team_id, team_id, season))
        all_games = [dict(r) for r in cur.fetchall()]

        if not all_games:
            return {"team": team, "games_analyzed": 0,
                    "lineup_trends": None, "pitching_trends": None}

        game_ids = [g["id"] for g in all_games]

        # ── Enrich: opponent, series detection ──
        opp_games = defaultdict(list)
        for g in all_games:
            opp_id = g["away_team_id"] if g["home_team_id"] == team_id else g["home_team_id"]
            g["opponent_id"] = opp_id
            g["opponent_name"] = g["away_short"] if g["home_team_id"] == team_id else g["home_short"]
            g["is_home"] = g["home_team_id"] == team_id
            opp_games[opp_id].append(g)

        for opp_id, games in opp_games.items():
            games.sort(key=lambda gg: (gg["game_date"], gg.get("game_number") or 1, gg["id"]))
            cur_ser = [games[0]]
            for i in range(1, len(games)):
                if (games[i]["game_date"] - cur_ser[-1]["game_date"]).days > 4:
                    for idx, sg in enumerate(cur_ser):
                        sg["series_game_num"] = idx + 1
                        sg["series_length"] = len(cur_ser)
                    cur_ser = [games[i]]
                else:
                    cur_ser.append(games[i])
            for idx, sg in enumerate(cur_ser):
                sg["series_game_num"] = idx + 1
                sg["series_length"] = len(cur_ser)

        all_ge = []
        for games in opp_games.values():
            all_ge.extend(games)
        all_ge.sort(key=lambda gg: (gg["game_date"], gg.get("game_number") or 1))

        # ── Recency weights (half-life 7 games) ──
        # Tighter than before (was 10) so a player returning from injury
        # and playing the last 5-7 games outweighs a guy who started
        # earlier in the season.
        n_games = len(all_ge)
        gw = {}
        for i, g in enumerate(all_ge):
            gw[g["id"]] = 2 ** (-(n_games - 1 - i) / 7)

        # ── Bulk fetch batting — DEDUPLICATE per game ──
        ph = ",".join(["%s"] * len(game_ids))
        cur.execute(f"""
            SELECT gb.game_id, gb.player_id, gb.player_name, gb.team_id,
                   gb.batting_order, gb.position,
                   gb.at_bats, gb.hits, gb.runs, gb.rbi,
                   gb.doubles, gb.triples, gb.home_runs,
                   gb.walks, gb.strikeouts, gb.hit_by_pitch,
                   gb.stolen_bases, gb.caught_stealing,
                   gb.sacrifice_flies, gb.sacrifice_bunts
            FROM game_batting gb
            WHERE gb.game_id IN ({ph}) AND gb.team_id = %s
            ORDER BY gb.game_id, gb.batting_order
        """, game_ids + [team_id])
        raw_batting = [dict(r) for r in cur.fetchall()]

        # Normalize all player names in batting data
        for b in raw_batting:
            b["player_name"] = normalize_name(b["player_name"])

        # (Deduplication happens after alias resolution below)

        # ── Bulk fetch pitching ──
        cur.execute(f"""
            SELECT gp.game_id, gp.player_id, gp.player_name, gp.team_id,
                   gp.pitch_order, gp.is_starter, gp.innings_pitched,
                   gp.hits_allowed, gp.runs_allowed, gp.earned_runs,
                   gp.walks, gp.strikeouts, gp.home_runs_allowed,
                   gp.hit_batters, gp.batters_faced, gp.pitches_thrown,
                   gp.decision, gp.is_quality_start, gp.game_score
            FROM game_pitching gp
            WHERE gp.game_id IN ({ph}) AND gp.team_id = %s
            ORDER BY gp.game_id, gp.pitch_order
        """, game_ids + [team_id])
        raw_pitching = [dict(r) for r in cur.fetchall()]

        # Normalize all player names in pitching data
        for p in raw_pitching:
            p["player_name"] = normalize_name(p["player_name"])

        # (Deduplication happens after alias resolution below)

        # ── Opposing starters (for LHP/RHP) ──
        # Ghost-row guard matters here: team_id != X can match orphan rows
        # from teams that weren't either side of the game.
        cur.execute(f"""
            SELECT gp.game_id, gp.player_name, p.throws
            FROM game_pitching gp
            JOIN games g ON gp.game_id = g.id
            LEFT JOIN players p ON gp.player_id = p.id
            WHERE gp.game_id IN ({ph})
              AND gp.team_id != %s AND gp.is_starter = true
              AND gp.team_id IN (g.home_team_id, g.away_team_id)
        """, game_ids + [team_id])
        opp_starters = {}
        for r in cur.fetchall():
            opp_starters[r["game_id"]] = {
                "name": r["player_name"],
                "throws": (r["throws"] or "").upper() if r["throws"] else None,
            }

        # ── Pitcher names set (exclude from def subs) ──
        pitcher_names = set()
        for p in raw_pitching:
            pitcher_names.add(p["player_name"])  # already normalized

        # ── Player info ──
        cur.execute("SELECT id, throws, bats FROM players WHERE team_id = %s", (team_id,))
        player_info = {r["id"]: {"throws": r["throws"], "bats": r["bats"]}
                       for r in cur.fetchall()}

        # ── Canonicalize every row using player_id as the source of truth ──
        # The box-score scraper tags most rows with the correct player_id even
        # when the displayed name is abbreviated or reversed. Before any dedup
        # or aggregation, overwrite player_name with the canonical "First Last"
        # from the players table. Rows missing a player_id are fuzzy-matched
        # against the same canonical map so truncated/garbled names still
        # collapse into the real player. This kills the root cause of the
        # Mana Heffernan / M. Heffernan style duplicates.
        player_ids_seen = {b["player_id"] for b in raw_batting if b.get("player_id")}
        player_ids_seen.update(p["player_id"] for p in raw_pitching if p.get("player_id"))

        canonical_name_by_id = {}
        if player_ids_seen:
            ph_pid = ",".join(["%s"] * len(player_ids_seen))
            cur.execute(f"""
                SELECT id, first_name, last_name
                FROM players
                WHERE id IN ({ph_pid})
            """, list(player_ids_seen))
            for r in cur.fetchall():
                first = (r["first_name"] or "").strip()
                last = (r["last_name"] or "").strip()
                full = (first + " " + last).strip()
                if full:
                    canonical_name_by_id[r["id"]] = full

        def _strip_prefix_junk(s):
            """Strip leading non-letter characters (stray HTML, bullets, etc.)."""
            return re.sub(r'^[^A-Za-z]+', '', s or '').strip()

        def resolve_raw_name(raw_name):
            """Best-effort match of a raw name against canonical_name_by_id.
            Handles truncation ('Siniscalc' vs 'Siniscalchi'), initials
            ('L. Siniscalchi'), 'Last, First', and leading junk characters.
            Returns (player_id, full_name) or (None, None) if ambiguous."""
            if not raw_name or not canonical_name_by_id:
                return (None, None)
            name = _strip_prefix_junk(normalize_name(raw_name))
            if not name:
                return (None, None)
            nl = name.lower()
            # Exact match
            for pid, full in canonical_name_by_id.items():
                if full.lower() == nl:
                    return (pid, full)
            # "F. Last" / "F Last" form — allow last-name truncation on either side
            m = re.match(r'^([A-Za-z])\.?\s*(.+)$', name)
            if m:
                initial = m.group(1).lower()
                last_raw = m.group(2).strip().lower()
                matches = []
                for pid, full in canonical_name_by_id.items():
                    parts = full.split(None, 1)
                    if len(parts) < 2:
                        continue
                    f_first, f_last = parts[0].lower(), parts[1].lower()
                    if not f_first.startswith(initial):
                        continue
                    if f_last.startswith(last_raw) or last_raw.startswith(f_last):
                        matches.append((pid, full))
                if len(matches) == 1:
                    return matches[0]
            # Last-name-only prefix match (rare, but covers edge truncation)
            matches = []
            for pid, full in canonical_name_by_id.items():
                parts = full.split(None, 1)
                if len(parts) < 2:
                    continue
                f_last = parts[1].lower()
                if f_last.startswith(nl) or nl.startswith(f_last):
                    matches.append((pid, full))
            if len(matches) == 1:
                return matches[0]
            return (None, None)

        # Apply canonical names to every batting/pitching row in place
        for row in raw_batting:
            pid = row.get("player_id")
            if pid and pid in canonical_name_by_id:
                row["player_name"] = canonical_name_by_id[pid]
                continue
            rpid, rname = resolve_raw_name(row.get("player_name"))
            if rpid:
                row["player_id"] = rpid
                row["player_name"] = rname
            else:
                row["player_name"] = _strip_prefix_junk(normalize_name(row.get("player_name") or ""))
        for row in raw_pitching:
            pid = row.get("player_id")
            if pid and pid in canonical_name_by_id:
                row["player_name"] = canonical_name_by_id[pid]
                continue
            rpid, rname = resolve_raw_name(row.get("player_name"))
            if rpid:
                row["player_id"] = rpid
                row["player_name"] = rname
            else:
                row["player_name"] = _strip_prefix_junk(normalize_name(row.get("player_name") or ""))

        # Rebuild the pitcher_names set with canonical names
        pitcher_names = {p["player_name"] for p in raw_pitching if p.get("player_name")}

        # ── Player PRIMARY position (single best position this season) ──
        # Built in-memory from the now-canonicalized batting rows so every
        # name variant for the same player contributes to one bucket.
        #
        # Each game contributes its recency weight (gw), not a flat +1, so
        # a player's RECENT position wins over his older one. Example: a
        # player who started at SS for 20 early games and then moved to 3B
        # for the last 7 games is classified as 3B because the recent
        # games outweigh the older ones.
        _pos_counts = defaultdict(lambda: defaultdict(float))
        for b in raw_batting:
            if (b.get("batting_order") or 0) > 9:
                continue
            raw_pos = (b.get("position") or "").upper().strip()
            if raw_pos in ("PH", "PR", "CR", "P", ""):
                continue
            # Split slashed positions (e.g. "CF/RF") and take the primary
            primary_pos = raw_pos.split('/')[0].strip() if '/' in raw_pos else raw_pos
            w = gw.get(b["game_id"], 1.0)
            _pos_counts[b["player_name"]][primary_pos] += w
        player_primary_pos = {}
        for name, buckets in _pos_counts.items():
            if buckets:
                player_primary_pos[name] = max(buckets.items(), key=lambda kv: kv[1])[0]

        # Re-build deduplicated data after alias resolution
        batting_by_game = defaultdict(list)
        for b in raw_batting:
            batting_by_game[b["game_id"]].append(b)
        deduped_batting_by_game = defaultdict(list)
        for gid, batters in batting_by_game.items():
            seen_players = set()
            for b in sorted(batters, key=lambda x: x["batting_order"]):
                key = b["player_name"]
                if key in seen_players:
                    continue
                seen_players.add(key)
                deduped_batting_by_game[gid].append(b)

        pitching_by_game = defaultdict(list)
        for p in raw_pitching:
            pitching_by_game[p["game_id"]].append(p)
        deduped_pitching_by_game = defaultdict(list)
        for gid, pitchers in pitching_by_game.items():
            seen = set()
            for p in sorted(pitchers, key=lambda x: x["pitch_order"]):
                key = p["player_name"]
                if key in seen:
                    continue
                seen.add(key)
                deduped_pitching_by_game[gid].append(p)

        # ══════════════════════════════════════════════════════════════
        # CLASSIFY GAMES BY OPPOSING PITCHER HAND
        # ══════════════════════════════════════════════════════════════
        # Only classify when we KNOW the hand — don't lump unknown into RHP
        games_vs_rhp, games_vs_lhp, games_vs_unknown = [], [], []
        for g in all_ge:
            opp_sp = opp_starters.get(g["id"])
            hand = opp_sp["throws"] if opp_sp and opp_sp["throws"] else None
            g["opp_hand"] = hand
            if hand == "L":
                games_vs_lhp.append(g)
            elif hand == "R":
                games_vs_rhp.append(g)
            else:
                games_vs_unknown.append(g)

        # Games by series slot
        games_by_slot = defaultdict(list)
        for g in all_ge:
            slot = g.get("series_game_num", 1)
            if slot <= 4:
                games_by_slot[slot].append(g)

        # ══════════════════════════════════════════════════════════════
        # SMART LINEUP CONSTRUCTION — anchor dominant players first
        # ══════════════════════════════════════════════════════════════

        def build_best_lineup(game_list):
            """
            Build a best-guess starting 9 with UNIQUE players.

            Algorithm:
            1) For each player, find their most common lineup spot and
               how dominant they are there (% of starts at that spot).
            2) Sort by dominance — players who ALWAYS hit in one spot
               get locked in first (e.g. Fahland always 9th).
            3) Fill remaining spots with remaining players by weight.
            4) For each assigned row, compute alternates at the same
               defensive position. If the starter has < 65% share of
               that position's weighted starts, list up to 2 alts with
               >= 20% share ("Miyazawa/Richards" style).

            Excludes PH, PR, CR from lineup consideration.
            """
            if not game_list:
                return {"games_count": 0, "lineup": [], "bench": []}

            # Track: player -> spot -> weighted count
            player_spot_wt = defaultdict(lambda: defaultdict(float))
            player_total_wt = defaultdict(float)
            player_game_count = defaultdict(int)
            # position_wt[pos][name] = weighted starts at that defensive
            # position (across this game_list). Used AFTER the main
            # assignment to surface close position alternates.
            position_wt = defaultdict(lambda: defaultdict(float))

            for g in game_list:
                w = gw.get(g["id"], 1.0)
                seen_in_game = set()
                batters = deduped_batting_by_game.get(g["id"], [])
                for b in batters:
                    pos = (b["position"] or "").upper().strip()
                    if b["batting_order"] > 9 or pos in ("PH", "PR", "CR"):
                        continue
                    name = b["player_name"] or "Unknown"
                    if name in seen_in_game:
                        continue
                    seen_in_game.add(name)
                    spot = b["batting_order"]
                    player_spot_wt[name][spot] += w
                    player_total_wt[name] += w
                    player_game_count[name] += 1
                    # Track defensive-position starts (primary slot when
                    # the scraper recorded "CF/RF" we take CF).
                    if pos and pos != "P":
                        primary_pos = pos.split("/")[0].strip()
                        if primary_pos:
                            position_wt[primary_pos][name] += w

            if not player_spot_wt:
                return {"games_count": len(game_list), "lineup": [], "bench": []}

            # For each player, find their best spot and dominance score
            player_best = {}
            for name, spots in player_spot_wt.items():
                best_spot = max(spots, key=spots.get)
                best_wt = spots[best_spot]
                total = player_total_wt[name]
                dominance = best_wt / total if total > 0 else 0
                player_best[name] = {
                    "best_spot": best_spot,
                    "best_wt": best_wt,
                    "dominance": dominance,
                    "total_wt": total,
                    "games": player_game_count[name],
                }

            # Sort players by TOTAL WEIGHTED GAMES first — the guy who
            # started 39 of 42 games should be in the lineup, period,
            # even if he moves around the order. Tie-break by dominance
            # so a consistent player edges out a journeyman when they
            # have the same weighted game count.
            sorted_players = sorted(
                player_best.items(),
                key=lambda x: (x[1]["total_wt"], x[1]["dominance"]),
                reverse=True,
            )

            assigned = {}     # spot -> {name, pos, pct}
            used_players = set()
            # Enforce one player per defensive position (C, 1B, 2B, 3B,
            # SS, LF, CF, RF, DH). A team can only have one catcher in
            # the lineup, one shortstop, one DH, etc.
            used_positions = set()

            def spot_pct(name, spot, wt):
                spot_total = sum(
                    player_spot_wt[n][spot]
                    for n in player_spot_wt if spot in player_spot_wt[n]
                )
                return round(wt / spot_total * 100, 1) if spot_total else 0

            # Main pass: walk players best-to-worst by weighted starts,
            # and give each their best-remaining slot where the position
            # isn't already used. One pass, no phases.
            for name, info in sorted_players:
                if name in used_players:
                    continue
                pos = player_primary_pos.get(name, "")
                if pos and pos in used_positions:
                    continue

                # Candidate slots ranked by this player's weight at each
                slots_desc = sorted(
                    player_spot_wt[name].items(),
                    key=lambda kv: kv[1],
                    reverse=True,
                )
                for spot, wt in slots_desc:
                    if spot < 1 or spot > 9 or spot in assigned or wt <= 0:
                        continue
                    assigned[spot] = {
                        "player_name": name,
                        "position": pos,
                        "pct": spot_pct(name, spot, wt),
                    }
                    used_players.add(name)
                    if pos:
                        used_positions.add(pos)
                    break

            # Rescue pass: a high-start player may have been squeezed
            # out because every slot they've ever batted in got taken
            # (e.g. Stevens always DHs at slot 3, someone else took 3
            # in the few LHP games). Drop them into the best open slot
            # with an unused position so they still appear in the
            # lineup, at pct=0 to signal low confidence.
            if used_players:
                top_wt = sorted_players[0][1]["total_wt"]
            else:
                top_wt = 0
            for name, info in sorted_players:
                if name in used_players:
                    continue
                # Only rescue players who started a meaningful share of
                # games. 20% of the top guy's weighted starts catches
                # regulars who only played in, say, 4 of 20 games but
                # still clearly own their position.
                if info["total_wt"] < 0.2 * top_wt:
                    break
                pos = player_primary_pos.get(name, "")
                if pos and pos in used_positions:
                    continue
                open_slots = [s for s in range(1, 10) if s not in assigned]
                if not open_slots:
                    break
                spot = info["best_spot"] if info["best_spot"] in open_slots else open_slots[0]
                assigned[spot] = {
                    "player_name": name,
                    "position": pos,
                    "pct": 0,
                }
                used_players.add(name)
                if pos:
                    used_positions.add(pos)

            # Final fill pass: any still-empty slots get filled by the
            # remaining sub with the most weighted games whose primary
            # position is still open. Showing a low-sample backup at
            # pct=0 is more useful than leaving slot 8 blank — fans /
            # coaches can infer "we're not sure, but this is the most
            # likely body in that spot."
            open_slots = [s for s in range(1, 10) if s not in assigned]
            if open_slots:
                for name, info in sorted_players:
                    if not open_slots:
                        break
                    if name in used_players:
                        continue
                    pos = player_primary_pos.get(name, "")
                    if pos and pos in used_positions:
                        continue
                    spot = info["best_spot"] if info["best_spot"] in open_slots else open_slots[0]
                    assigned[spot] = {
                        "player_name": name,
                        "position": pos,
                        "pct": 0,
                    }
                    used_players.add(name)
                    if pos:
                        used_positions.add(pos)
                    open_slots = [s for s in range(1, 10) if s not in assigned]

            # ── Alternates at each defensive position ──
            # For each assigned slot, if the starter does NOT dominate
            # their defensive position (< 65% of weighted starts), show
            # up to 2 other players who have also put real innings there
            # (>= 20% share). Rendered as "Miyazawa/Richards" on the
            # lineup row so fans/coaches see the real committee.
            ALT_TOP_THRESHOLD = 0.65   # starter must clear this to hide alts
            ALT_MIN_SHARE = 0.20       # alt must clear this to show up
            MAX_ALTS = 2

            for spot, info in assigned.items():
                pos = info.get("position") or ""
                if not pos:
                    info["alts"] = []
                    continue
                starter_name = info["player_name"]
                pos_totals = position_wt.get(pos, {})
                total_at_pos = sum(pos_totals.values())
                if total_at_pos <= 0:
                    info["alts"] = []
                    continue
                starter_share = pos_totals.get(starter_name, 0) / total_at_pos
                if starter_share >= ALT_TOP_THRESHOLD:
                    info["alts"] = []
                    continue
                # Collect candidates who aren't the starter, aren't
                # already locked into another lineup slot, and clear
                # the minimum share bar.
                candidates = []
                for cand_name, cand_wt in pos_totals.items():
                    if cand_name == starter_name:
                        continue
                    if cand_name in used_players:
                        # Already occupying another lineup slot. Don't
                        # list them as a backup at a position they
                        # aren't actually playing tonight.
                        continue
                    share = cand_wt / total_at_pos
                    if share < ALT_MIN_SHARE:
                        continue
                    candidates.append({
                        "player_name": cand_name,
                        "pct": round(share * 100, 1),
                    })
                candidates.sort(key=lambda c: c["pct"], reverse=True)
                info["alts"] = candidates[:MAX_ALTS]

            lineup = []
            for spot in range(1, 10):
                if spot in assigned:
                    lineup.append({"spot": spot, **assigned[spot]})
                else:
                    lineup.append({"spot": spot, "player_name": "—",
                                   "position": "", "pct": 0, "alts": []})

            # Bench: starters not in the constructed lineup
            bench = []
            for name, info in sorted_players:
                if name in used_players:
                    continue
                bench.append({
                    "player_name": name,
                    "position": player_primary_pos.get(name, ""),
                    "games_started": info["games"],
                })
                if len(bench) >= 6:
                    break

            return {
                "games_count": len(game_list),
                "lineup": lineup,
                "bench": bench,
            }

        # ──────────────────────────────────────────────────────────────
        # Hitter splits: per-player breakdown by LINEUP SPOT and by
        # DEFENSIVE POSITION. Fans/coaches want to see "how does this
        # guy hit in the 5 hole vs the 1 hole" and "how does he hit
        # when he's in CF vs 1B". Built from the same game-log rows
        # used for the lineup construction so the universe of games
        # matches exactly.
        #
        # Thresholds:
        #   - Include a player if they have >= 10 total AB in the window
        #   - Include a bucket (spot or position) if it has >= 3 AB
        # ──────────────────────────────────────────────────────────────
        def _blank_bucket():
            return {
                "ab": 0, "h": 0, "bb": 0, "hbp": 0, "sf": 0,
                "doubles": 0, "triples": 0, "hr": 0, "rbi": 0,
                "k": 0, "r": 0, "g": 0,
            }

        def _finalize_bucket(b):
            """AVG/OBP/SLG/OPS out of the raw totals."""
            ab = b["ab"]
            bb = b["bb"]
            hbp = b["hbp"]
            sf = b["sf"]
            h = b["h"]
            singles = h - b["doubles"] - b["triples"] - b["hr"]
            tb = singles + 2 * b["doubles"] + 3 * b["triples"] + 4 * b["hr"]
            avg = round(h / ab, 3) if ab > 0 else None
            obp_den = ab + bb + hbp + sf
            obp = round((h + bb + hbp) / obp_den, 3) if obp_den > 0 else None
            slg = round(tb / ab, 3) if ab > 0 else None
            ops = round(obp + slg, 3) if (obp is not None and slg is not None) else None
            return {
                "ab": ab, "h": h, "hr": b["hr"], "rbi": b["rbi"],
                "bb": bb, "k": b["k"], "r": b["r"], "g": b["g"],
                "avg": avg, "obp": obp, "slg": slg, "ops": ops,
            }

        def build_hitter_splits():
            # player_name -> "spot" -> spot (1..9) -> bucket
            # player_name -> "pos"  -> position     -> bucket
            by_spot = defaultdict(lambda: defaultdict(_blank_bucket))
            by_pos = defaultdict(lambda: defaultdict(_blank_bucket))
            totals = defaultdict(_blank_bucket)

            for g in all_ge:
                batters = deduped_batting_by_game.get(g["id"], [])
                for b in batters:
                    name = b["player_name"] or "Unknown"
                    if name == "Unknown":
                        continue
                    raw_pos = (b["position"] or "").upper().strip()
                    # Ignore pure pinch-hit / pinch-run appearances
                    # in the position split — they aren't a defensive
                    # position. They still count in the spot split if
                    # the scraper gave them a batting order (rare).
                    spot = b["batting_order"] or 0
                    ab = b["at_bats"] or 0
                    bb = b["walks"] or 0
                    hbp = b["hit_by_pitch"] or 0
                    sf = b["sacrifice_flies"] or 0
                    h = b["hits"] or 0
                    d = b["doubles"] or 0
                    t = b["triples"] or 0
                    hr = b["home_runs"] or 0
                    rbi = b["rbi"] or 0
                    k = b["strikeouts"] or 0
                    r = b["runs"] or 0

                    def _add(bucket):
                        bucket["ab"] += ab
                        bucket["h"] += h
                        bucket["bb"] += bb
                        bucket["hbp"] += hbp
                        bucket["sf"] += sf
                        bucket["doubles"] += d
                        bucket["triples"] += t
                        bucket["hr"] += hr
                        bucket["rbi"] += rbi
                        bucket["k"] += k
                        bucket["r"] += r
                        bucket["g"] += 1

                    _add(totals[name])

                    if 1 <= spot <= 9 and raw_pos not in ("PH", "PR", "CR"):
                        _add(by_spot[name][spot])

                    if raw_pos and raw_pos not in ("PH", "PR", "CR", "P"):
                        # "CF/RF" -> bucket under CF (primary slot)
                        primary = raw_pos.split("/")[0].strip()
                        if primary:
                            _add(by_pos[name][primary])

            PLAYER_MIN_AB = 10
            BUCKET_MIN_AB = 3

            result = []
            for name, t in totals.items():
                if t["ab"] < PLAYER_MIN_AB:
                    continue
                spot_rows = []
                for spot in sorted(by_spot.get(name, {}).keys()):
                    bk = by_spot[name][spot]
                    if bk["ab"] < BUCKET_MIN_AB:
                        continue
                    spot_rows.append({"spot": spot, **_finalize_bucket(bk)})
                pos_rows = []
                raw_pos_map = by_pos.get(name, {})
                for pos, bk in sorted(
                    raw_pos_map.items(),
                    key=lambda kv: kv[1]["ab"],
                    reverse=True,
                ):
                    if bk["ab"] < BUCKET_MIN_AB:
                        continue
                    pos_rows.append({"position": pos, **_finalize_bucket(bk)})
                # Only return players who have at least one meaningful
                # bucket in EITHER view. A guy with 12 AB all in one
                # spot / one position has nothing to split, so skip.
                if not spot_rows and not pos_rows:
                    continue
                result.append({
                    "player_name": name,
                    "primary_position": player_primary_pos.get(name, ""),
                    "overall": _finalize_bucket(t),
                    "by_spot": spot_rows,
                    "by_position": pos_rows,
                })

            # Sort by overall AB desc so the regulars show up first.
            result.sort(key=lambda p: p["overall"]["ab"], reverse=True)
            return result

        # Build lineups — strict split: only games where we KNOW the opposing
        # starter's hand count toward vs_rhp/vs_lhp. Unknown games are excluded
        # so they don't pollute the split (they'd bias toward whatever the
        # team's "neutral" lineup is, which is not what a vs-hand split means).
        lineup_vs_rhp = build_best_lineup(games_vs_rhp)
        lineup_vs_lhp = build_best_lineup(games_vs_lhp)

        game_slot_lineups = {}
        for slot in range(1, 5):
            gl = games_by_slot.get(slot, [])
            if len(gl) >= 2:
                game_slot_lineups[str(slot)] = build_best_lineup(gl)

        # ── Pinch hitters, pinch runners ──
        ph_stats = defaultdict(lambda: {"apps": 0, "ab": 0, "h": 0,
                                         "rbi": 0, "bb": 0})
        pr_stats = defaultdict(lambda: {"apps": 0, "sb": 0, "r": 0, "cs": 0})

        for g in all_ge:
            seen_ph = set()
            seen_pr = set()
            batters = deduped_batting_by_game.get(g["id"], [])
            for b in batters:
                pos = (b["position"] or "").upper().strip()
                name = b["player_name"] or "Unknown"
                if pos == "PH" and name not in seen_ph:
                    seen_ph.add(name)
                    s = ph_stats[name]
                    s["apps"] += 1
                    s["ab"] += b["at_bats"] or 0
                    s["h"] += b["hits"] or 0
                    s["rbi"] += b["rbi"] or 0
                    s["bb"] += b["walks"] or 0
                elif pos in ("PR", "CR") and name not in seen_pr:
                    seen_pr.add(name)
                    s = pr_stats[name]
                    s["apps"] += 1
                    s["sb"] += b["stolen_bases"] or 0
                    s["r"] += b["runs"] or 0
                    s["cs"] += b["caught_stealing"] or 0

        pinch_hitters = sorted([
            {"name": n, "apps": s["apps"], "ab": s["ab"], "h": s["h"],
             "rbi": s["rbi"], "bb": s["bb"],
             "avg": round(s["h"] / s["ab"], 3) if s["ab"] > 0 else None}
            for n, s in ph_stats.items()
        ], key=lambda x: x["apps"], reverse=True)

        pinch_runners = sorted([
            {"name": n, "apps": s["apps"], "sb": s["sb"],
             "cs": s["cs"], "r": s["r"]}
            for n, s in pr_stats.items()
        ], key=lambda x: x["apps"], reverse=True)

        hitter_splits = build_hitter_splits()

        lineup_trends = {
            "vs_rhp": lineup_vs_rhp,
            "vs_lhp": lineup_vs_lhp,
            "by_game_number": game_slot_lineups,
            "pinch_hitters": pinch_hitters,
            "pinch_runners": pinch_runners,
            "hitter_splits": hitter_splits,
            "count_vs_rhp": len(games_vs_rhp),
            "count_vs_lhp": len(games_vs_lhp),
            "count_vs_unknown": len(games_vs_unknown),
        }

        # ══════════════════════════════════════════════════════════════
        # PITCHING TRENDS
        # ══════════════════════════════════════════════════════════════

        # FIP constant used for per-slot splits below. We repeat the value the
        # reliever section uses (3.50) so college ERAs and FIPs line up at the
        # league-average level.
        _SP_FIP_CONSTANT = 3.50

        # Reference point for the "inactive" icon — the team's most recent game.
        # Compare each pitcher's last outing against this to flag arms that
        # haven't been used in 2+ weeks.
        latest_team_date = all_ge[-1]["game_date"] if all_ge else None

        def _slot_totals():
            return {
                "starts": 0, "outs": 0, "er": 0,
                "k": 0, "bb": 0, "hr": 0, "hbp": 0,
                "wins": 0, "losses": 0,
            }

        starter_data = defaultdict(lambda: {
            "starts": 0, "total_outs": 0, "game_slots": Counter(),
            "recent_starts": [], "player_id": None, "throws": None,
            "wins": 0, "losses": 0, "qs": 0,
            "total_k": 0, "total_er": 0, "total_bb": 0,
            "slot_totals": defaultdict(_slot_totals),
        })

        for g in all_ge:
            pitchers = deduped_pitching_by_game.get(g["id"], [])
            for p in pitchers:
                if not p["is_starter"]:
                    continue
                name = p["player_name"] or "Unknown"
                s = starter_data[name]
                s["starts"] += 1
                raw_ip = p["innings_pitched"]
                outs_this = ip_to_outs(raw_ip)
                s["total_outs"] += outs_this
                s["player_id"] = p["player_id"]
                s["throws"] = player_info.get(p["player_id"], {}).get("throws")
                s["total_k"] += p["strikeouts"] or 0
                s["total_er"] += p["earned_runs"] or 0
                s["total_bb"] += p["walks"] or 0
                if p["decision"] == "W":
                    s["wins"] += 1
                elif p["decision"] == "L":
                    s["losses"] += 1
                if p["is_quality_start"]:
                    s["qs"] += 1
                slot = g.get("series_game_num", 1)
                s["game_slots"][slot] += 1
                # Per-slot accumulators (for "By Series Game" splits in UI)
                st = s["slot_totals"][slot]
                st["starts"] += 1
                st["outs"] += outs_this
                st["er"] += p["earned_runs"] or 0
                st["k"] += p["strikeouts"] or 0
                st["bb"] += p["walks"] or 0
                st["hr"] += p["home_runs_allowed"] or 0
                st["hbp"] += p["hit_batters"] or 0
                if p["decision"] == "W":
                    st["wins"] += 1
                elif p["decision"] == "L":
                    st["losses"] += 1
                s["recent_starts"].append({
                    "date": g["game_date"].isoformat() if hasattr(g["game_date"], "isoformat") else str(g["game_date"]),
                    "opp": g["opponent_name"],
                    "g": slot,
                    "ip": float(raw_ip or 0),
                    "k": p["strikeouts"] or 0,
                    "er": p["earned_runs"] or 0,
                    "dec": p["decision"],
                    "gs": p["game_score"],
                    "pc": p["pitches_thrown"],
                })

        starters_list = []
        for name, s in starter_data.items():
            if s["starts"] < 2:
                continue
            # avg IP uses real innings (outs/3) so it's mathematically sensible
            avg_ip = round(s["total_outs"] / s["starts"] / 3, 1) if s["starts"] else 0

            # Per-slot splits: GS, IP, IP/GS, ERA, FIP, K, BB, HR, Record
            slot_splits = {}
            for slot_num, st in s["slot_totals"].items():
                if st["starts"] == 0:
                    continue
                outs = st["outs"]
                ip_real = round(outs / 3.0, 2)
                slot_avg_ip = round(outs / st["starts"] / 3.0, 1) if st["starts"] else 0
                # FIP — None if no outs (divide-by-zero guard)
                if outs > 0:
                    ip_for_fip = outs / 3.0
                    fip_val = round(
                        (13 * st["hr"] + 3 * (st["bb"] + st["hbp"]) - 2 * st["k"]) / ip_for_fip
                        + _SP_FIP_CONSTANT,
                        2,
                    )
                else:
                    fip_val = None
                slot_splits[str(slot_num)] = {
                    "gs": st["starts"],
                    "ip": ip_real,
                    "avg_ip": slot_avg_ip,
                    "era": era_from_outs(st["er"], outs),
                    "fip": fip_val,
                    "k": st["k"],
                    "bb": st["bb"],
                    "hr": st["hr"],
                    "record": f"{st['wins']}-{st['losses']}",
                }

            # Icon flags for starters
            last2 = s["recent_starts"][-2:]
            er_2 = sum(a.get("er", 0) or 0 for a in last2)
            outs_2 = sum(ip_to_outs(a.get("ip", 0)) for a in last2)
            flag_hot = len(last2) >= 2 and outs_2 > 0 and (er_2 * 27 / outs_2) <= 2.00
            flag_cold = len(last2) >= 2 and (
                (outs_2 > 0 and (er_2 * 27 / outs_2) >= 7.00) or
                (outs_2 == 0 and er_2 > 0)
            )
            # Starters need a bigger sample for the K/9 flag (20 IP = 60 outs)
            flag_high_k = s["total_outs"] >= 60 and (s["total_k"] * 27 / s["total_outs"]) >= 10.0
            flag_inactive = False
            if latest_team_date and s["starts"] >= 3 and s["recent_starts"]:
                last_str = s["recent_starts"][-1]["date"]
                try:
                    last_dt = date.fromisoformat(last_str) if isinstance(last_str, str) else last_str
                    if (latest_team_date - last_dt).days >= 14:
                        flag_inactive = True
                except (ValueError, TypeError):
                    pass

            starters_list.append({
                "name": name,
                "player_id": s["player_id"],
                "throws": s["throws"],
                "starts": s["starts"],
                "avg_ip": avg_ip,
                "era": era_from_outs(s["total_er"], s["total_outs"]),
                "record": f"{s['wins']}-{s['losses']}",
                "qs": s["qs"],
                "k": s["total_k"],
                "bb": s["total_bb"],
                "slots": {str(k): v for k, v in s["game_slots"].most_common()},
                "slot_splits": slot_splits,
                "recent": s["recent_starts"][-6:],
                "flag_hot": flag_hot,
                "flag_cold": flag_cold,
                "flag_high_k": flag_high_k,
                "flag_inactive": flag_inactive,
            })
        starters_list.sort(key=lambda x: x["starts"], reverse=True)

        # ── Predicted rotation ──
        recent_series = []
        seen_series = set()
        for g in reversed(all_ge):
            if g.get("series_game_num") == 1 and g.get("series_length", 0) >= 2:
                s_id = (g["opponent_id"], str(g["game_date"]))
                if s_id not in seen_series:
                    seen_series.add(s_id)
                    sg_list = [
                        gg for gg in all_ge
                        if gg["opponent_id"] == g["opponent_id"]
                        and 0 <= (gg["game_date"] - g["game_date"]).days <= 4
                    ]
                    sg_list.sort(key=lambda x: (x["game_date"], x.get("game_number") or 1))
                    recent_series.append(sg_list)
                    if len(recent_series) >= 4:
                        break

        # Count how many of the recent series each pitcher started in
        # (not total games — we want "% of series where this pitcher got a start")
        pitcher_series_count = Counter()
        for series in recent_series:
            seen_in_series = set()
            for sg in series:
                pitchers = deduped_pitching_by_game.get(sg["id"], [])
                sp = next((p for p in pitchers if p["is_starter"]), None)
                if sp and sp["player_name"] not in seen_in_series:
                    seen_in_series.add(sp["player_name"])
                    pitcher_series_count[sp["player_name"]] += 1
        num_recent_series = len(recent_series) or 1

        predicted_rotation = []
        # Track pitchers already slotted into an earlier game so the same arm
        # can't be predicted twice in one series (e.g. the G2 starter also
        # winning G3 because he's the most common starter both slots). We
        # greedy-pick the highest-weight AVAILABLE pitcher for each slot.
        assigned_pitchers = set()
        for slot in range(1, 5):
            slot_starters = Counter()
            slot_wt = 0
            for s_idx, series in enumerate(recent_series):
                w = 2 ** (-s_idx)
                for sg in series:
                    if sg.get("series_game_num") == slot:
                        pitchers = deduped_pitching_by_game.get(sg["id"], [])
                        sp = next((p for p in pitchers if p["is_starter"]), None)
                        if sp:
                            slot_starters[sp["player_name"]] += w
                            slot_wt += w
            # Primary pick: most-likely unassigned pitcher who has actually
            # started THIS slot in recent series.
            top_pick = None
            top_w = 0
            pick_source = None
            if slot_starters:
                for name, w in slot_starters.most_common():
                    if name not in assigned_pitchers:
                        top_pick = name
                        top_w = w
                        pick_source = "slot"
                        break

            # Fallback: if every slot-specific candidate is already assigned
            # (e.g. team runs a 3-man rotation and both of its G3 starters
            # also own G1 and G2), grab the next most-used starter overall
            # who hasn't been placed yet. Better to surface a best-guess
            # 4th starter than to leave the slot blank on the site.
            if not top_pick:
                overall_ranked = sorted(
                    starter_data.items(),
                    key=lambda kv: kv[1].get("starts", 0),
                    reverse=True,
                )
                for name, _info in overall_ranked:
                    if name not in assigned_pitchers:
                        top_pick = name
                        top_w = 0  # signals 'fallback — no slot-specific weight'
                        pick_source = "fallback"
                        break

            if top_pick:
                assigned_pitchers.add(top_pick)
                sp_info = starter_data.get(top_pick, {})
                series_with_start = pitcher_series_count.get(top_pick, 0)
                # game_conf is slot-specific confidence. Only meaningful for
                # primary picks; fallback picks report 0 so the UI can show
                # uncertainty.
                if pick_source == "slot" and slot_wt:
                    game_conf = round(top_w / slot_wt * 100)
                else:
                    game_conf = 0
                predicted_rotation.append({
                    "game": slot,
                    "name": top_pick,
                    "throws": sp_info.get("throws"),
                    "game_conf": game_conf,
                    "week_pct": round(series_with_start / num_recent_series * 100),
                })

        # ── Relievers (deduplicated) ──
        reliever_data = defaultdict(lambda: {
            "apps": 0, "total_outs": 0, "saves": 0,
            "k": 0, "er": 0, "bb": 0, "hr": 0, "hbp": 0, "bf": 0,
            "player_id": None, "throws": None,
            "close_apps": 0, "multi_ip_apps": 0,
            "longest_outs": 0,
            "recent": [],
        })

        for g in all_ge:
            pitchers = deduped_pitching_by_game.get(g["id"], [])
            our = g["home_score"] if g["is_home"] else g["away_score"]
            their = g["away_score"] if g["is_home"] else g["home_score"]
            close = abs((our or 0) - (their or 0)) <= 3

            for p in pitchers:
                if p["is_starter"]:
                    continue
                name = p["player_name"] or "Unknown"
                r = reliever_data[name]
                raw_ip = p["innings_pitched"]
                outs = ip_to_outs(raw_ip)
                r["apps"] += 1
                r["total_outs"] += outs
                r["player_id"] = p["player_id"]
                r["throws"] = player_info.get(p["player_id"], {}).get("throws")
                r["k"] += p["strikeouts"] or 0
                r["er"] += p["earned_runs"] or 0
                r["bb"] += p["walks"] or 0
                r["hr"] += p["home_runs_allowed"] or 0
                r["hbp"] += p["hit_batters"] or 0
                r["bf"] += p["batters_faced"] or 0
                if p["decision"] == "S":
                    r["saves"] += 1
                if close:
                    r["close_apps"] += 1
                # multi-inning appearance = 4+ outs (1⅓ IP or more)
                if outs >= 4:
                    r["multi_ip_apps"] += 1
                if outs > r["longest_outs"]:
                    r["longest_outs"] = outs
                r["recent"].append({
                    "date": g["game_date"].isoformat() if hasattr(g["game_date"], "isoformat") else str(g["game_date"]),
                    "opp": g["opponent_name"],
                    "ip": float(raw_ip or 0),
                    "k": p["strikeouts"] or 0,
                    "er": p["earned_runs"] or 0, "dec": p["decision"],
                })

        # ── Reliever rating helpers ──
        # FIP constant picked so league-average FIP ≈ league-average ERA at
        # the college level. 3.10 is the standard MLB constant; college ERAs
        # run higher, so we use 3.50 as a rough neutral baseline.
        FIP_CONSTANT = 3.50

        def compute_fip(hr, bb, hbp, k, outs):
            if outs <= 0:
                return None
            ip = outs / 3.0
            return round((13 * hr + 3 * (bb + hbp) - 2 * k) / ip + FIP_CONSTANT, 2)

        def compute_k_bb_pct(k, bb, bf):
            if bf <= 0:
                return None
            return round((k - bb) * 100 / bf, 1)

        def reliever_tier(rating, apps):
            # "small_sample" relievers don't get a tier badge
            if apps < 3:
                return "small_sample"
            if rating is None:
                return "small_sample"
            if rating >= 15:
                return "elite"
            if rating >= 5:
                return "solid"
            if rating >= -5:
                return "average"
            return "struggling"

        relievers_list = []
        for name, r in reliever_data.items():
            # avg IP uses real innings (outs/3) so averaging is sensible
            avg_ip = round(r["total_outs"] / r["apps"] / 3, 1) if r["apps"] else 0
            era = era_from_outs(r["er"], r["total_outs"])
            total_ip_display = outs_to_ip(r["total_outs"])

            # Advanced stats
            fip = compute_fip(r["hr"], r["bb"], r["hbp"], r["k"], r["total_outs"])
            k_bb_pct = compute_k_bb_pct(r["k"], r["bb"], r["bf"])

            # Composite rating: combines command (K-BB%) and run prevention
            # (FIP). Higher is better. K-BB% is already a percentage; FIP is
            # subtracted from the baseline so low-FIP pitchers get a bonus.
            if k_bb_pct is not None and fip is not None:
                rating = round(k_bb_pct - (fip - FIP_CONSTANT) * 5, 1)
            else:
                rating = None

            tier = reliever_tier(rating, r["apps"])

            # Classify: closer / multi-inning / one-inning / mop-up
            # Thresholds use real innings via outs (3 outs = 1 IP)
            if r["saves"] >= 2:
                role = "closer"
            elif avg_ip >= 1.5 or r["multi_ip_apps"] >= r["apps"] * 0.4:
                role = "multi_inning"
            elif r["apps"] >= 3 and r["total_outs"] < 18 and (era is None or era > 12):
                role = "mop_up"
            elif r["total_outs"] < 9 and r["apps"] <= 2:
                role = "mop_up"
            else:
                role = "one_inning"

            # Icon flags: hot, cold, high_k, inactive
            # Hot/cold from last 2 appearances
            last2 = r["recent"][-2:]
            er_2 = sum(a.get("er", 0) or 0 for a in last2)
            outs_2 = sum(ip_to_outs(a.get("ip", 0)) for a in last2)
            flag_hot = len(last2) >= 2 and outs_2 > 0 and (er_2 * 27 / outs_2) <= 2.00
            flag_cold = len(last2) >= 2 and (
                (outs_2 > 0 and (er_2 * 27 / outs_2) >= 7.00) or
                (outs_2 == 0 and er_2 > 0)
            )
            # High-K: season K/9 >= 10, with at least 10 IP (30 outs)
            flag_high_k = r["total_outs"] >= 30 and (r["k"] * 27 / r["total_outs"]) >= 10.0
            # Inactive: hasn't pitched in 14+ days (only flag if 3+ apps — avoid flagging guys who just came back from injury)
            flag_inactive = False
            if latest_team_date and r["apps"] >= 3 and r["recent"]:
                last_str = r["recent"][-1]["date"]
                try:
                    last_dt = date.fromisoformat(last_str) if isinstance(last_str, str) else last_str
                    if (latest_team_date - last_dt).days >= 14:
                        flag_inactive = True
                except (ValueError, TypeError):
                    pass

            relievers_list.append({
                "name": name, "throws": r["throws"],
                "apps": r["apps"], "avg_ip": avg_ip, "era": era,
                "total_ip": total_ip_display,
                "longest_ip": outs_to_ip(r["longest_outs"]),
                "saves": r["saves"], "k": r["k"], "bb": r["bb"],
                "hr": r["hr"], "bf": r["bf"],
                "fip": fip, "k_bb_pct": k_bb_pct,
                "rating": rating, "tier": tier,
                "role": role,
                "leverage_pct": round(r["close_apps"] / r["apps"] * 100) if r["apps"] else 0,
                "recent": r["recent"][-5:],
                "flag_hot": flag_hot,
                "flag_cold": flag_cold,
                "flag_high_k": flag_high_k,
                "flag_inactive": flag_inactive,
            })

        # Mark the best 2 (highest rating, min 3 apps) as "top_reliever"
        qualified = [r for r in relievers_list if r["apps"] >= 3 and r["rating"] is not None]
        qualified.sort(key=lambda x: x["rating"], reverse=True)
        top_names = {r["name"] for r in qualified[:2]}
        for r in relievers_list:
            r["is_top"] = r["name"] in top_names

        # Sort by appearances for the main list display
        relievers_list.sort(key=lambda x: -x["apps"])

        # ── PBP tendencies (Phase D.5) ──
        # For every pitcher in starters+relievers, pull PBP-derived
        # tendencies from game_events: first-pitch strike rate, whiff
        # rate, putaway rate, ground-ball rate, opponent contact mix,
        # total WPA. One bulk query keyed on player_id, attach to each
        # pitcher entry. Keys default to None so the frontend can show
        # "—" for pitchers without enough PBP-tracked data.
        pitcher_pids = []
        for s in starters_list:
            if s.get("player_id"):
                pitcher_pids.append(s["player_id"])
        for r in relievers_list:
            if r.get("player_id"):
                pitcher_pids.append(r["player_id"])

        pitcher_tendencies = {}  # player_id -> tendencies dict
        if pitcher_pids:
            cur.execute("""
                SELECT
                    ge.pitcher_player_id AS pid,
                    COUNT(*) AS pa,
                    -- pitches_thrown >= 1, not just IS NOT NULL: parser
                    -- stamps pitches_thrown=0 on "(0-0)" PAs from sources
                    -- that don't ship a pitch sequence. Excluding those
                    -- avoids silently deflating that rate.
                    COUNT(*) FILTER (WHERE pitches_thrown >= 1) AS tracked_pa,
                    COALESCE(SUM(pitches_thrown), 0) AS pitches,
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS pK,
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))), 0) AS pS,
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS pF,
                    COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play,
                    COUNT(*) FILTER (
                        WHERE pitches_thrown >= 1 AND
                              (LEFT(pitch_sequence, 1) IN ('K', 'S', 'F')
                               OR (pitch_sequence = '' AND was_in_play))
                    ) AS f1_strikes,
                    COUNT(*) FILTER (WHERE strikes_before = 2) AS two_strike_pa,
                    COUNT(*) FILTER (
                        WHERE strikes_before = 2
                          AND result_type IN ('strikeout_swinging','strikeout_looking')
                    ) AS two_strike_k,
                    COUNT(*) FILTER (WHERE bb_type = 'GB') AS gb_n,
                    COUNT(*) FILTER (WHERE bb_type = 'FB') AS fb_n,
                    COUNT(*) FILTER (WHERE bb_type = 'LD') AS ld_n,
                    COUNT(*) FILTER (WHERE bb_type = 'PU') AS pu_n,
                    COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
                    COUNT(*) FILTER (WHERE result_type = 'home_run') AS hr,
                    SUM(ge.wpa_pitcher)        AS total_wpa,
                    COUNT(ge.wpa_pitcher)      AS wpa_pa
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                WHERE g.season = %s
                  AND ge.pitcher_player_id = ANY(%s)
                GROUP BY ge.pitcher_player_id
            """, (season, pitcher_pids))
            for r in cur.fetchall():
                pa = r["pa"] or 0
                tracked = r["tracked_pa"] or 0
                pitches = r["pitches"] or 0
                pk = r["pk"] or 0; ps = r["ps"] or 0; pf = r["pf"] or 0
                inp = r["in_play"] or 0
                swings = pk + pf + inp
                bb_total = r["bb_total"] or 0
                two_k_pa = r["two_strike_pa"] or 0
                pitcher_tendencies[r["pid"]] = {
                    "pa": pa,
                    "fps_pct": ((r["f1_strikes"] or 0) / tracked) if tracked > 0 else None,
                    "whiff_pct": (pk / swings) if swings > 0 else None,
                    "putaway_pct": ((r["two_strike_k"] or 0) / two_k_pa) if two_k_pa > 0 else None,
                    "strike_pct": ((pk + ps + pf + inp) / pitches) if pitches > 0 else None,
                    "gb_pct": ((r["gb_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "ld_pct": ((r["ld_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "fb_pct": ((r["fb_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "pu_pct": ((r["pu_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "hr_pa_pct": ((r["hr"] or 0) / pa) if pa > 0 else None,
                    "total_wpa": float(r["total_wpa"]) if r["total_wpa"] is not None else None,
                    "wpa_pa": int(r["wpa_pa"] or 0),
                }
        # Attach to each pitcher entry
        for s in starters_list:
            s["tendencies"] = pitcher_tendencies.get(s.get("player_id"))
        for r in relievers_list:
            r["tendencies"] = pitcher_tendencies.get(r.get("player_id"))

        # ── Hitter tendencies (Phase D.5) ──
        # Same idea for hitters in the lineup. Pull contact profile
        # (GB/LD/FB/PU + Pull/Center/Oppo), 2-strike approach, and
        # total WPA per hitter. Lets coaches plan how to attack each
        # batter.
        #
        # Lineup spots only carry `player_name`, not `player_id` —
        # build a name->id map from raw_batting (which has both),
        # then resolve each spot to a pid before querying tendencies.
        name_to_pid = {}
        for b in raw_batting:
            n = b.get("player_name")
            pid = b.get("player_id")
            if n and pid and n not in name_to_pid:
                name_to_pid[n] = pid

        def _walk_lineup_spots():
            """Yield (spot_dict) for every lineup spot in lineup_trends."""
            for hand_key in ("vs_rhp", "vs_lhp"):
                hand = lineup_trends.get(hand_key) or {}
                for s in (hand.get("lineup") or []):
                    yield s
            by_gn = lineup_trends.get("by_game_number") or {}
            for slot_data in by_gn.values():
                for s in (slot_data.get("lineup") or []):
                    yield s

        # Resolve spot.player_name to player_id, attach as spot.player_id
        # so the frontend can deep-link if needed.
        batter_pids = set()
        for spot in _walk_lineup_spots():
            n = spot.get("player_name")
            pid = name_to_pid.get(n)
            if pid:
                spot["player_id"] = pid
                batter_pids.add(pid)

        batter_tendencies = {}
        if batter_pids:
            cur.execute("""
                SELECT
                    ge.batter_player_id AS pid,
                    p.bats AS bats,
                    COUNT(*) AS pa,
                    COUNT(*) FILTER (WHERE bb_type = 'GB') AS gb_n,
                    COUNT(*) FILTER (WHERE bb_type = 'FB') AS fb_n,
                    COUNT(*) FILTER (WHERE bb_type = 'LD') AS ld_n,
                    COUNT(*) FILTER (WHERE bb_type = 'PU') AS pu_n,
                    COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
                    COUNT(*) FILTER (
                        WHERE bb_type IN ('LD','FB')
                          AND ((UPPER(p.bats) = 'R' AND field_zone = 'LEFT')
                            OR (UPPER(p.bats) = 'L' AND field_zone = 'RIGHT'))
                    ) AS air_pull,
                    COUNT(*) FILTER (
                        WHERE field_zone = 'LEFT' AND UPPER(p.bats) = 'R'
                           OR field_zone = 'RIGHT' AND UPPER(p.bats) = 'L'
                    ) AS pull_n,
                    COUNT(*) FILTER (WHERE field_zone = 'CENTER') AS center_n,
                    COUNT(*) FILTER (
                        WHERE field_zone = 'RIGHT' AND UPPER(p.bats) = 'R'
                           OR field_zone = 'LEFT' AND UPPER(p.bats) = 'L'
                    ) AS oppo_n,
                    COUNT(*) FILTER (WHERE field_zone IS NOT NULL) AS zone_total,
                    COUNT(*) FILTER (WHERE strikes_before = 2) AS two_strike_pa,
                    COUNT(*) FILTER (
                        WHERE strikes_before = 2
                          AND result_type IN ('strikeout_swinging','strikeout_looking')
                    ) AS two_strike_k,
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS pK,
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS pF,
                    COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play,
                    SUM(ge.wpa_batter)         AS total_wpa,
                    COUNT(ge.wpa_batter)       AS wpa_pa
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                JOIN players p ON p.id = ge.batter_player_id
                WHERE g.season = %s
                  AND ge.batter_player_id = ANY(%s)
                GROUP BY ge.batter_player_id, p.bats
            """, (season, list(batter_pids)))
            for r in cur.fetchall():
                bb_total = r["bb_total"] or 0
                zone_total = r["zone_total"] or 0
                two_k_pa = r["two_strike_pa"] or 0
                pk = r["pk"] or 0; pf = r["pf"] or 0; inp = r["in_play"] or 0
                swings = pk + pf + inp
                contact = pf + inp
                batter_tendencies[r["pid"]] = {
                    "pa": r["pa"] or 0,
                    "bats": r["bats"],
                    "gb_pct": ((r["gb_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "ld_pct": ((r["ld_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "fb_pct": ((r["fb_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "pu_pct": ((r["pu_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "pull_pct": ((r["pull_n"] or 0) / zone_total) if zone_total > 0 else None,
                    "center_pct": ((r["center_n"] or 0) / zone_total) if zone_total > 0 else None,
                    "oppo_pct": ((r["oppo_n"] or 0) / zone_total) if zone_total > 0 else None,
                    "air_pull_pct": ((r["air_pull"] or 0) / bb_total) if bb_total > 0 else None,
                    "putaway_pct": ((r["two_strike_k"] or 0) / two_k_pa) if two_k_pa > 0 else None,
                    "contact_pct": (contact / swings) if swings > 0 else None,
                    "whiff_pct": (pk / swings) if swings > 0 else None,
                    "total_wpa": float(r["total_wpa"]) if r["total_wpa"] is not None else None,
                    "wpa_pa": int(r["wpa_pa"] or 0),
                }

        # Attach hitter tendencies onto each lineup spot using the same
        # walker as the pid-resolution step above.
        for spot in _walk_lineup_spots():
            pid = spot.get("player_id")
            if pid:
                spot["tendencies"] = batter_tendencies.get(pid)

        return {
            "team": team,
            "games_analyzed": n_games,
            "lineup_trends": lineup_trends,
            "pitching_trends": {
                "starters": starters_list,
                "predicted_rotation": predicted_rotation,
                "relievers": relievers_list,
            },
        }


