"""
Recruiting guide, program guide PDF, NWAC advancement, recruiting breakdown.

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
from ..stats.cpi import compute_cpi_for_division, SEASON_GAMES_BY_LEVEL
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

router = APIRouter()

@router.get("/recruiting/guide/{team_id}")
def get_recruiting_guide(team_id: int):
    """
    Comprehensive recruiting guide for a team.

    Returns:
    - Basic team info with division/conference
    - 5-year W-L trend
    - 5-year team stats (ERA, batting avg, OPS, runs)
    - Roster overview and class breakdown
    - Freshman production metrics
    - Roster turnover rates
    - Redshirt rate
    - Four-year retention (for 4-year schools)
    - Average physical attributes by position
    - Player hometowns
    - Hometown breakdown by state and metro area
    - Top 10 all-time players by WAR
    - Team WAR by season
    - Placeholder for user-submitted ratings
    """
    try:
        with get_connection() as conn:
            cur = conn.cursor()

            # ============ TEAM INFO ============
            cur.execute("""
                SELECT t.id, t.name, t.school_name, t.short_name, t.mascot,
                       t.city, t.state, t.logo_url, t.stats_url, t.roster_url,
                       c.name as conference_name, d.name as division_name
                FROM teams t
                LEFT JOIN conferences c ON t.conference_id = c.id
                LEFT JOIN divisions d ON c.division_id = d.id
                WHERE t.id = %s
            """, (team_id,))
            team_row = cur.fetchone()
            if not team_row:
                return JSONResponse(content={"error": "Team not found"}, status_code=404)

            team_info = dict(team_row)

            # ============ SEASON RECORDS (All years) ============
            # Only show seasons where the team actually had players with stats,
            # to filter out fake/bad data for programs that didn't exist yet
            cur.execute("""
                SELECT tss.season, tss.wins, tss.losses, tss.ties,
                       COALESCE(tss.conference_wins, 0) as conf_wins,
                       COALESCE(tss.conference_losses, 0) as conf_losses
                FROM team_season_stats tss
                WHERE tss.team_id = %s
                  AND (
                    EXISTS (SELECT 1 FROM batting_stats WHERE team_id = %s AND season = tss.season)
                    OR EXISTS (SELECT 1 FROM pitching_stats WHERE team_id = %s AND season = tss.season)
                  )
                ORDER BY season DESC
            """, (team_id, team_id, team_id))
            season_records = [dict(r) for r in cur.fetchall()]
            season_records.reverse()

            # ============ SEASON STATS (All years) ============
            cur.execute("""
                SELECT season, team_era, team_batting_avg, team_ops,
                       runs_scored, runs_allowed
                FROM team_season_stats
                WHERE team_id = %s
                ORDER BY season DESC
            """, (team_id,))
            season_stats = [dict(r) for r in cur.fetchall()]
            season_stats.reverse()

            # ============ CURRENT ROSTER OVERVIEW ============
            # Get the most recent season with stats for this team
            cur.execute("""
                SELECT MAX(season) as max_season FROM (
                    SELECT MAX(season) as season FROM batting_stats WHERE team_id = %s
                    UNION ALL
                    SELECT MAX(season) as season FROM pitching_stats WHERE team_id = %s
                ) s
            """, (team_id, team_id))
            max_season_row = cur.fetchone()
            current_season = max_season_row['max_season'] if max_season_row else CURRENT_SEASON

            # Use roster_year to identify current roster players.
            # If roster_year is populated, use it; otherwise fall back to
            # players with stats in the current season.
            cur.execute("""
                SELECT COUNT(*) as cnt FROM players
                WHERE team_id = %s AND roster_year = %s
            """, (team_id, current_season))
            roster_year_count = cur.fetchone()['cnt']

            if roster_year_count > 0:
                # Use roster_year filter (preferred)
                cur.execute("""
                    SELECT DISTINCT p.id, p.position, p.year_in_school
                    FROM players p
                    WHERE p.team_id = %s AND p.roster_year = %s
                    ORDER BY p.id
                """, (team_id, current_season))
            else:
                # Fallback: players with stats in current season
                cur.execute("""
                    SELECT DISTINCT p.id, p.position, p.year_in_school
                    FROM players p
                    WHERE p.team_id = %s
                      AND p.id IN (
                        SELECT DISTINCT player_id FROM batting_stats
                        WHERE team_id = %s AND season = %s
                        UNION
                        SELECT DISTINCT player_id FROM pitching_stats
                        WHERE team_id = %s AND season = %s
                      )
                    ORDER BY p.id
                """, (team_id, team_id, current_season, team_id, current_season))
            all_roster_rows = cur.fetchall()

            total_players = len(all_roster_rows)

            # Pitcher detection: check for exact position matches
            pitcher_positions = {'P', 'RHP', 'LHP', 'SP', 'RP'}
            pitcher_count = 0
            for r in all_roster_rows:
                pos = r['position'] or ''
                # Split on "/" or "," to handle multi-position like "RHP/1B"
                pos_parts = [p.strip() for p in pos.replace(',', '/').split('/')]
                if any(pp in pitcher_positions for pp in pos_parts):
                    pitcher_count += 1
            hitter_count = total_players - pitcher_count

            # Class breakdown - map redshirt classes to their base class
            # R-Fr → Fr, R-So → So, R-Jr → Jr, R-Sr → Sr, Gr → Sr
            # Players with NULL year_in_school counted as "Unknown"
            class_map = {
                "Fr": "Fr", "So": "So", "Jr": "Jr", "Sr": "Sr",
                "R-Fr": "Fr", "R-So": "So", "R-Jr": "Jr", "R-Sr": "Sr",
                "Gr": "Sr", "GR": "Sr",
            }
            class_breakdown = {"Fr": 0, "So": 0, "Jr": 0, "Sr": 0, "Unknown": 0}
            for r in all_roster_rows:
                year = r['year_in_school']
                if year:
                    mapped = class_map.get(year.strip(), "Unknown")
                    class_breakdown[mapped] += 1
                else:
                    class_breakdown["Unknown"] += 1

            # Count players who appeared in at least one game in the most recent season
            cur.execute("""
                SELECT COUNT(DISTINCT player_id) as appeared
                FROM (
                    SELECT DISTINCT player_id FROM batting_stats
                    WHERE team_id = %s AND season = (SELECT MAX(season) FROM batting_stats WHERE team_id = %s)
                    UNION
                    SELECT DISTINCT player_id FROM pitching_stats
                    WHERE team_id = %s AND season = (SELECT MAX(season) FROM pitching_stats WHERE team_id = %s)
                ) AS combined
            """, (team_id, team_id, team_id, team_id))
            appeared_result = cur.fetchone()
            players_appeared = appeared_result['appeared'] if appeared_result else 0

            roster_overview = {
                "total_players": total_players,
                "pitcher_count": pitcher_count,
                "hitter_count": hitter_count,
                "players_appeared": players_appeared,
                "by_class": class_breakdown,
                "season": current_season
            }

            # ====== CLASS-YEAR SETUP (freshman + transfer production) ======
            # Prefer TRUE per-season class from player_seasons (scraped from each
            # year's roster). Fall back to back-calculating from a player's current
            # year_in_school only where the roster wasn't captured. (Back-calc is
            # wrong for redshirts, transfers, and players who've left, so the
            # scraped per-season class is strongly preferred.)
            class_to_offset = {
                "Fr": 0, "R-Fr": 0, "So": 1, "R-So": 1, "Jr": 2, "R-Jr": 2,
                "Sr": 3, "R-Sr": 3, "Gr": 4, "GR": 4,
            }
            FRESH_CLASSES = ("Fr", "R-Fr")

            cur.execute("""
                SELECT DISTINCT season FROM batting_stats WHERE team_id = %s
                UNION
                SELECT DISTINCT season FROM pitching_stats WHERE team_id = %s
                ORDER BY season DESC LIMIT 5
            """, (team_id, team_id))
            seasons = [r['season'] for r in cur.fetchall()]
            seasons.sort()

            # True per-season class from archived rosters: (season, player_id) -> class
            cur.execute("SELECT season, player_id, year_in_school FROM player_seasons WHERE team_id = %s", (team_id,))
            ps_class = {(r['season'], r['player_id']): (r['year_in_school'] or '').strip() for r in cur.fetchall()}

            # Back-calc fallback: player_id -> computed freshman season
            cur.execute("""
                SELECT p.id, p.year_in_school,
                       COALESCE(p.roster_year, (
                           SELECT MAX(season) FROM (
                               SELECT season FROM batting_stats WHERE player_id = p.id AND team_id = %s
                               UNION
                               SELECT season FROM pitching_stats WHERE player_id = p.id AND team_id = %s
                           ) s
                       )) as ref_year
                FROM players p
                WHERE p.team_id = %s AND p.year_in_school IS NOT NULL
            """, (team_id, team_id, team_id))
            player_fresh_season = {}
            for r in cur.fetchall():
                off = class_to_offset.get((r['year_in_school'] or '').strip())
                if off is not None and r['ref_year']:
                    player_fresh_season[r['id']] = int(r['ref_year']) - off

            # Players with stats per season (the rows the production charts weight)
            players_by_season = {}
            for s in seasons:
                cur.execute("""
                    SELECT DISTINCT player_id FROM batting_stats WHERE team_id = %s AND season = %s
                    UNION
                    SELECT DISTINCT player_id FROM pitching_stats WHERE team_id = %s AND season = %s
                """, (team_id, s, team_id, s))
                players_by_season[s] = set(r['player_id'] for r in cur.fetchall())

            def _fresh_in(season, pid):
                cl = ps_class.get((season, pid))
                if cl:
                    return cl in FRESH_CLASSES
                return player_fresh_season.get(pid) == season  # fallback

            # First season each player appears at this team (for transfer origin)
            cur.execute("""
                SELECT player_id, MIN(season) AS fs FROM (
                    SELECT player_id, season FROM batting_stats WHERE team_id = %s
                    UNION
                    SELECT player_id, season FROM pitching_stats WHERE team_id = %s
                ) x GROUP BY player_id
            """, (team_id, team_id))
            first_season = {r['player_id']: r['fs'] for r in cur.fetchall()}
            # "Homegrown" = ever a Fr/R-Fr here. "Transfer" = arrived as an upperclassman.
            homegrown_ids = {pid for (s, pid), cl in ps_class.items() if cl in FRESH_CLASSES}

            def _is_transfer(pid):
                if pid in homegrown_ids:
                    return False
                fs = first_season.get(pid)
                cl = ps_class.get((fs, pid)) if fs else None
                if cl:
                    return cl not in FRESH_CLASSES
                fy = player_fresh_season.get(pid)
                if fy is not None and fs is not None:
                    return fs > fy  # arrived after their computed freshman year => transfer
                return False

            freshmen_by_season = {s: {pid for pid in players_by_season.get(s, set()) if _fresh_in(s, pid)} for s in seasons}
            transfers_by_season = {s: {pid for pid in players_by_season.get(s, set()) if _is_transfer(pid)} for s in seasons}

            # Team PA/IP denominators per season (computed once).
            team_totals = {}
            for season in seasons:
                cur.execute("SELECT SUM(plate_appearances) AS pa FROM batting_stats WHERE team_id = %s AND season = %s", (team_id, season))
                tpa = (cur.fetchone() or {}).get('pa') or 0
                cur.execute("SELECT (SUM(ip_outs(innings_pitched)) / 3.0)::float8 AS ip FROM pitching_stats WHERE team_id = %s AND season = %s", (team_id, season))
                tip = (cur.fetchone() or {}).get('ip') or 0
                team_totals[season] = (tpa, tip)

            def _cohort_production(season, ids):
                """Share of team PA, share of team IP, and total WAR for a set of player_ids."""
                tpa, tip = team_totals.get(season, (0, 0))
                ids = list(ids)
                if not ids:
                    return (0, 0, 0)
                ph = ','.join(['%s'] * len(ids))
                cur.execute(f"SELECT SUM(plate_appearances) AS pa FROM batting_stats WHERE team_id = %s AND season = %s AND player_id IN ({ph})", [team_id, season] + ids)
                pa = (cur.fetchone() or {}).get('pa') or 0
                cur.execute(f"SELECT (SUM(ip_outs(innings_pitched)) / 3.0)::float8 AS ip FROM pitching_stats WHERE team_id = %s AND season = %s AND player_id IN ({ph})", [team_id, season] + ids)
                ip = (cur.fetchone() or {}).get('ip') or 0
                cur.execute(f"""
                    SELECT COALESCE(SUM(COALESCE(owar,0)+COALESCE(pwar,0)),0) AS war FROM (
                        SELECT offensive_war AS owar, NULL AS pwar FROM batting_stats WHERE team_id=%s AND season=%s AND player_id IN ({ph})
                        UNION ALL
                        SELECT NULL AS owar, pitching_war AS pwar FROM pitching_stats WHERE team_id=%s AND season=%s AND player_id IN ({ph})
                    ) s
                """, [team_id, season] + ids + [team_id, season] + ids)
                war = (cur.fetchone() or {}).get('war') or 0
                return (
                    round(pa / tpa, 4) if tpa else 0,
                    round(ip / tip, 4) if tip else 0,
                    round(war, 2),
                )

            freshman_production = []
            transfer_production = []
            for season in seasons:
                f_pa, f_ip, f_war = _cohort_production(season, freshmen_by_season.get(season, set()))
                freshman_production.append({"season": season, "fresh_pa_pct": f_pa, "fresh_ip_pct": f_ip, "total_war": f_war})
                t_pa, t_ip, t_war = _cohort_production(season, transfers_by_season.get(season, set()))
                transfer_production.append({"season": season, "transfer_pa_pct": t_pa, "transfer_ip_pct": t_ip, "total_war": t_war})

            # ============ ROSTER COMPOSITION ============
            # Per season: returners (on this team last year), freshmen, transfers.
            # Freshman vs transfer uses true per-season class (player_seasons) via
            # _fresh_in; players_by_season / player_fresh_season built above.
            roster_composition = []
            for s in seasons:
                roster = players_by_season.get(s, set())
                total = len(roster)
                if total == 0 or (s - 1) not in players_by_season:
                    continue
                prev = players_by_season.get(s - 1, set())
                returners = roster & prev
                new_players = roster - prev
                freshmen = {pid for pid in new_players if _fresh_in(s, pid)}
                transfers = new_players - freshmen
                roster_composition.append({
                    "season": s,
                    "total": total,
                    "returners": len(returners),
                    "freshmen": len(freshmen),
                    "transfers": len(transfers),
                    "returner_pct": round(len(returners) / total, 4),
                    "freshman_pct": round(len(freshmen) / total, 4),
                    "transfer_pct": round(len(transfers) / total, 4),
                })

            # ============ REDSHIRT RATE ============
            cur.execute("""
                SELECT COUNT(*) as redshirt_count
                FROM players
                WHERE team_id = %s AND year_in_school LIKE %s
            """, (team_id, 'R-%'))
            redshirt_count = (cur.fetchone() or {}).get('redshirt_count') or 0

            redshirt_rate = {
                "redshirt_count": redshirt_count,
                "total": total_players,
                "rate": round(redshirt_count / total_players, 4) if total_players > 0 else 0
            }

            # (Four-year retention removed)

            # ============ AVERAGE SIZE BY POSITION ============
            position_groups = {
                "Catcher": {"C"},
                "Middle Infield": {"SS", "2B"},
                "Corner Infield": {"1B", "3B"},
                "Outfield": {"OF", "CF", "LF", "RF"},
                "Pitcher": {"P", "RHP", "LHP", "SP", "RP"}
            }

            # Fetch current roster players only, then group in Python with exact matching
            if roster_year_count > 0:
                cur.execute("""
                    SELECT p.position, p.height, p.weight FROM players p
                    WHERE p.team_id = %s AND p.roster_year = %s
                      AND p.position IS NOT NULL AND p.position != ''
                """, (team_id, current_season))
            else:
                cur.execute("""
                    SELECT p.position, p.height, p.weight FROM players p
                    WHERE p.team_id = %s AND p.position IS NOT NULL AND p.position != ''
                      AND p.id IN (
                        SELECT DISTINCT player_id FROM batting_stats
                        WHERE team_id = %s AND season = %s
                        UNION
                        SELECT DISTINCT player_id FROM pitching_stats
                        WHERE team_id = %s AND season = %s
                      )
                """, (team_id, team_id, current_season, team_id, current_season))
            all_players_for_size = cur.fetchall()

            def get_pos_parts(pos_str):
                """Split position like 'RHP/1B' or 'C, OF' into individual parts."""
                return [p.strip() for p in pos_str.replace(',', '/').split('/')]

            avg_size_by_position = []
            for group_name, valid_positions in position_groups.items():
                players_in_group = [
                    p for p in all_players_for_size
                    if any(pp in valid_positions for pp in get_pos_parts(p['position']))
                ]

                if players_in_group:
                    heights_inches = []
                    weights = []
                    for p in players_in_group:
                        h, w = p['height'], p['weight']
                        if h:
                            # Handle formats like "6 2", "6-2", "6'2"
                            match = re.match(r"(\d+)['\s\-]+(\d+)", str(h))
                            if match:
                                try:
                                    feet, inches = int(match.group(1)), int(match.group(2))
                                    heights_inches.append(feet * 12 + inches)
                                except Exception:
                                    # Narrowed from bare `except:`; skips a
                                    # malformed row without swallowing signals.
                                    pass
                        if w:
                            try:
                                weights.append(int(str(w).replace('lbs', '').strip()))
                            except Exception:
                                # Narrowed from bare `except:`; skips a
                                # malformed weight string.
                                pass

                    avg_height = sum(heights_inches) / len(heights_inches) if heights_inches else None
                    avg_weight = sum(weights) / len(weights) if weights else None

                    avg_size_by_position.append({
                        "position_group": group_name,
                        "avg_height_inches": round(avg_height, 1) if avg_height else None,
                        "avg_weight": round(avg_weight, 1) if avg_weight else None,
                        "count": len(players_in_group)
                    })

            # ============ PLAYER HOMETOWNS ============
            if roster_year_count > 0:
                cur.execute("""
                    SELECT p.id, p.first_name, p.last_name, p.hometown, p.height, p.weight
                    FROM players p
                    WHERE p.team_id = %s AND p.roster_year = %s
                      AND p.hometown IS NOT NULL AND p.hometown != ''
                    ORDER BY p.last_name, p.first_name
                """, (team_id, current_season))
            else:
                cur.execute("""
                    SELECT p.id, p.first_name, p.last_name, p.hometown, p.height, p.weight
                    FROM players p
                    WHERE p.team_id = %s AND p.hometown IS NOT NULL AND p.hometown != ''
                      AND p.id IN (
                        SELECT DISTINCT player_id FROM batting_stats
                        WHERE team_id = %s AND season = %s
                        UNION
                        SELECT DISTINCT player_id FROM pitching_stats
                        WHERE team_id = %s AND season = %s
                      )
                    ORDER BY p.last_name, p.first_name
                """, (team_id, team_id, current_season, team_id, current_season))

            player_hometowns = []
            for p in cur.fetchall():
                player_hometowns.append({
                    "name": f"{p['first_name']} {p['last_name']}",
                    "hometown": p['hometown'],
                    "state": None,
                    "lat": None,
                    "lng": None
                })

            # ============ HOMETOWN BREAKDOWN ============
            metro_keywords = {
                "Seattle Metro": {
                    "keywords": ["Seattle"],
                    "cities": ["Bellevue", "Tacoma", "Kent", "Renton", "Auburn", "Federal Way",
                              "Kirkland", "Redmond", "Bothell", "Issaquah", "Sammamish", "Woodinville",
                              "Lynnwood", "Edmonds", "Shoreline", "Burien", "Tukwila", "Mercer Island",
                              "Kenmore", "Lake Stevens", "Marysville", "Everett", "Snohomish", "Monroe",
                              "Mukilteo", "Mountlake Terrace", "Mill Creek"],
                    "state": "WA"
                },
                "Portland Metro": {
                    "keywords": ["Portland"],
                    "cities": ["Beaverton", "Hillsboro", "Gresham", "Lake Oswego", "Tigard", "Tualatin",
                              "West Linn", "Oregon City", "Milwaukie", "Clackamas", "Happy Valley",
                              "Sherwood", "Wilsonville", "Canby", "Troutdale", "Camas", "Washougal",
                              "Vancouver"],
                    "state": "OR"
                },
                "Boise Metro": {
                    "keywords": ["Boise"],
                    "cities": ["Meridian", "Nampa", "Caldwell", "Eagle", "Kuna", "Star"],
                    "state": "ID"
                },
                "Spokane Metro": {
                    "keywords": ["Spokane"],
                    "cities": ["Liberty Lake", "Cheney", "Airway Heights", "Medical Lake"],
                    "state": "WA"
                }
            }

            hometown_by_state = {}
            hometown_by_metro = {}

            for p in player_hometowns:
                hometown = p['hometown']
                # Extract the state: the chunk right after the city (first comma),
                # cut at any parenthetical / transfer chain so hometowns like
                # "Brentwood, Calif. (Heritage HS/Chabot CC)" reduce to "CALIF."
                # rather than a unique per-player string.
                state = None
                if ", " in hometown:
                    after = hometown.split(", ", 1)[1]
                    for sep in ("(", "/"):
                        cut = after.find(sep)
                        if cut != -1:
                            after = after[:cut]
                    after = after.split(",")[0].strip().upper()  # drop trailing ", Country" etc.
                    state = after or None

                # Count by state
                if state:
                    hometown_by_state[state] = hometown_by_state.get(state, 0) + 1

                # Assign to metro area
                metro = "Other"
                for metro_name, metro_data in metro_keywords.items():
                    for keyword in metro_data["keywords"]:
                        if keyword in hometown:
                            metro = metro_name
                            break
                    if metro != "Other":
                        break
                    for city in metro_data["cities"]:
                        if city in hometown and state == metro_data["state"]:
                            metro = metro_name
                            break
                    if metro != "Other":
                        break

                hometown_by_metro[metro] = hometown_by_metro.get(metro, 0) + 1

            hometown_breakdown = {
                "by_state": [{"state": s, "count": c} for s, c in sorted(hometown_by_state.items(), key=lambda x: -x[1])],
                "by_metro": [{"metro": m, "count": c} for m, c in sorted(hometown_by_metro.items(), key=lambda x: -x[1])]
            }

            # ============ BEST PLAYERS (Top 10 by WAR) ============
            # Offensive WAR
            cur.execute("""
                SELECT p.id, p.first_name, p.last_name, p.position,
                       SUM(bs.offensive_war) as total_war,
                       STRING_AGG(DISTINCT bs.season::text, ',') as seasons
                FROM players p
                LEFT JOIN batting_stats bs ON p.id = bs.player_id AND bs.team_id = %s
                WHERE p.team_id = %s AND bs.offensive_war IS NOT NULL
                GROUP BY p.id, p.first_name, p.last_name, p.position
                ORDER BY total_war DESC
                LIMIT 10
            """, (team_id, team_id))
            offensive_top_10 = [
                {
                    "name": f"{r['first_name']} {r['last_name']}",
                    "position": r['position'],
                    "seasons": sorted(r['seasons'].split(',')) if r['seasons'] else [],
                    "total_war": round(r['total_war'], 2)
                } for r in cur.fetchall()
            ]

            # Pitching WAR
            cur.execute("""
                SELECT p.id, p.first_name, p.last_name, p.position,
                       SUM(ps.pitching_war) as total_war,
                       STRING_AGG(DISTINCT ps.season::text, ',') as seasons
                FROM players p
                LEFT JOIN pitching_stats ps ON p.id = ps.player_id AND ps.team_id = %s
                WHERE p.team_id = %s AND ps.pitching_war IS NOT NULL
                GROUP BY p.id, p.first_name, p.last_name, p.position
                ORDER BY total_war DESC
                LIMIT 10
            """, (team_id, team_id))
            pitching_top_10 = [
                {
                    "name": f"{r['first_name']} {r['last_name']}",
                    "position": r['position'],
                    "seasons": sorted(r['seasons'].split(',')) if r['seasons'] else [],
                    "total_war": round(r['total_war'], 2)
                } for r in cur.fetchall()
            ]

            best_players = {
                "batting": offensive_top_10,
                "pitching": pitching_top_10
            }

            # ============ WAR BY SEASON ============
            war_by_season = []
            for season in seasons:
                cur.execute("""
                    SELECT COALESCE(SUM(offensive_war), 0) as total_owar
                    FROM batting_stats
                    WHERE team_id = %s AND season = %s
                """, (team_id, season))
                owar_result = cur.fetchone()
                total_owar = owar_result['total_owar'] if owar_result else 0

                cur.execute("""
                    SELECT COALESCE(SUM(pitching_war), 0) as total_pwar
                    FROM pitching_stats
                    WHERE team_id = %s AND season = %s
                """, (team_id, season))
                pwar_result = cur.fetchone()
                total_pwar = pwar_result['total_pwar'] if pwar_result else 0

                war_by_season.append({
                    "season": season,
                    "total_owar": round(float(total_owar), 2),
                    "total_pwar": round(float(total_pwar), 2),
                    "total_war": round(float(total_owar) + float(total_pwar), 2)
                })

            # ============ COACHING STAFF ============
            coaching_staff = []
            try:
                cur.execute("SAVEPOINT coaches_sp")
                cur.execute("""
                    SELECT name, title, role, photo_url, email, alma_mater, years_at_school, bio
                    FROM coaches
                    WHERE team_id = %s
                    ORDER BY
                        CASE WHEN role = 'head_coach' THEN 0
                             WHEN role = 'pitching' THEN 1
                             WHEN role = 'hitting' THEN 2
                             WHEN role = 'assistant' THEN 3
                             ELSE 4 END,
                        name
                """, (team_id,))
                coaching_staff = [dict(r) for r in cur.fetchall()]
                cur.execute("RELEASE SAVEPOINT coaches_sp")
            except Exception:
                cur.execute("ROLLBACK TO SAVEPOINT coaches_sp")  # Keep transaction usable

            # ============ RATINGS PLACEHOLDER ============
            ratings = {
                "field": None,
                "coaching": None,
                "facilities": None,
                "academics": None,
                "fan_support": None,
                "location": None,
                "competitiveness": None
            }

            # ============ PROGRAM PROFILE (curated recruiting intel) ============
            # Off-field program data hand-researched into recruiting_programs.
            # Wrapped in a savepoint so the endpoint still works if the table
            # hasn't been migrated yet (returns program=None).
            program = None
            try:
                cur.execute("SAVEPOINT prog_sp")
                cur.execute("""
                    SELECT school_name, division, conference, profile, updated_at
                    FROM recruiting_programs WHERE team_id = %s
                """, (team_id,))
                prow = cur.fetchone()
                if prow:
                    program = dict(prow)
                cur.execute("RELEASE SAVEPOINT prog_sp")
            except Exception:
                cur.execute("ROLLBACK TO SAVEPOINT prog_sp")

            # ============ ASSEMBLE RESPONSE ============
            return {
                "team_info": team_info,
                "program": program,
                "season_records": season_records,
                "season_stats": season_stats,
                "roster_overview": roster_overview,
                "freshman_production": freshman_production,
                "transfer_production": transfer_production,
                "roster_composition": roster_composition,
                "redshirt_rate": redshirt_rate,
                "avg_size_by_position": avg_size_by_position,
                "player_hometowns": player_hometowns,
                "hometown_breakdown": hometown_breakdown,
                "best_players": best_players,
                "war_by_season": war_by_season,
                "coaching_staff": coaching_staff,
                "ratings": ratings
            }

    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(content={"error": str(e)}, status_code=500)


@router.put("/recruiting/programs/{team_id}")
def upsert_recruiting_program(
    team_id: int,
    payload: dict = Body(...),
    _admin: str = Depends(require_admin),
):
    """ADMIN: create or update the curated recruiting profile for a team.

    Body: { "profile": { ...all curated fields... } }. Identity columns
    (school_name / division / conference) are resolved from the teams table when
    a row is first created; subsequent edits only touch the profile JSONB.
    """
    profile = payload.get("profile")
    if not isinstance(profile, dict):
        raise HTTPException(status_code=400, detail="Body must include a 'profile' object.")
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT t.school_name, t.name, c.name AS conference, d.name AS division
            FROM teams t
            LEFT JOIN conferences c ON c.id = t.conference_id
            LEFT JOIN divisions d ON d.id = c.division_id
            WHERE t.id = %s
        """, (team_id,))
        trow = cur.fetchone()
        if not trow:
            raise HTTPException(status_code=404, detail="Team not found.")
        cur.execute("""
            INSERT INTO recruiting_programs
                (team_id, school_name, division, conference, profile, updated_at)
            VALUES (%s, %s, %s, %s, %s, now())
            ON CONFLICT (team_id) DO UPDATE SET
                profile = EXCLUDED.profile,
                updated_at = now()
            RETURNING team_id, school_name, division, conference, profile, updated_at
        """, (team_id, trow["school_name"] or trow["name"],
              trow["division"], trow["conference"], Json(profile)))
        row = dict(cur.fetchone())
    return {"ok": True, "program": row}


# ============================================================
# RECRUITING PROGRAM GUIDE (PDF)
# ============================================================
# Premium-gated PDF of all 57 PNW program profiles. Served inline (not as an
# attachment) and only with a valid premium token — the raw URL returns 401
# without auth, so it can't be opened/downloaded directly. The frontend renders
# it page-by-page to canvas (no download/print UI, no text layer).
PROGRAM_GUIDE_PATH = "/opt/program_guide.pdf"


# Total freshmen (Fr / R-Fr) ON each four-year program's roster for a season,
# counted from the archived roster pages. This is a curated constant on purpose:
# rostered-but-didn't-play freshmen (redshirts, deep bench) never get a row in our
# stats DB, so "how many were rostered" can't be derived from a live query — it has
# to come from the roster text. Regenerate with scripts/count_rostered_freshmen.py
# when a season's rosters finalize. NWAC is absent (its rosters don't publish class).
FRESHMAN_ROSTERED = {
    2026: {"D1": 74, "D2": 59, "NAIA": 98, "D3": 50},
}


@router.get("/recruiting/freshman-by-division")
def recruiting_freshman_by_division(season: int = CURRENT_SEASON, _user: str = Depends(require_tier("premium"))):
    """Average freshman batting + pitching line per division (D1/D2/NAIA/D3/JUCO).
    Freshman = true Fr/R-Fr class from player_seasons at four-year schools; for
    NWAC (JUCO, where we lack reliable class data) a freshman is a player whose
    first season in our data is this one (a debut/first-year). Playing-time
    averages (PA/AB/IP) use everyone who appeared; rate stats (AVG/OPS/wRC+/ERA)
    use a reps floor so they're meaningful."""
    order = ['D1', 'D2', 'NAIA', 'D3', 'JUCO']
    fresh_cte = """
      WITH fresh AS (
        SELECT ps.player_id FROM player_seasons ps WHERE ps.season=%s AND ps.year_in_school IN ('Fr','R-Fr')
        UNION
        SELECT b.player_id FROM batting_stats b
          JOIN teams t ON b.team_id=t.id JOIN conferences c ON t.conference_id=c.id JOIN divisions d ON c.division_id=d.id
          WHERE b.season=%s AND d.level='JUCO' AND NOT EXISTS (SELECT 1 FROM batting_stats b2 WHERE b2.player_id=b.player_id AND b2.season<%s)
        UNION
        SELECT p.player_id FROM pitching_stats p
          JOIN teams t ON p.team_id=t.id JOIN conferences c ON t.conference_id=c.id JOIN divisions d ON c.division_id=d.id
          WHERE p.season=%s AND d.level='JUCO' AND NOT EXISTS (SELECT 1 FROM pitching_stats p2 WHERE p2.player_id=p.player_id AND p2.season<%s)
      )"""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(fresh_cte + """
          SELECT d.level,
            COUNT(*) FILTER (WHERE bs.plate_appearances>=1) n_hitters,
            ROUND(AVG(bs.plate_appearances) FILTER (WHERE bs.plate_appearances>=1),1) avg_pa,
            ROUND(AVG(bs.at_bats) FILTER (WHERE bs.plate_appearances>=1),1) avg_ab,
            COUNT(*) FILTER (WHERE bs.plate_appearances>=25) n_reps,
            ROUND(AVG(bs.hits::numeric/NULLIF(bs.at_bats,0)) FILTER (WHERE bs.plate_appearances>=25),3) avg_avg,
            ROUND(AVG(bs.ops) FILTER (WHERE bs.plate_appearances>=25)::numeric,3) avg_ops,
            ROUND(AVG(bs.wrc_plus) FILTER (WHERE bs.plate_appearances>=25)) avg_wrc
          FROM batting_stats bs JOIN fresh f ON bs.player_id=f.player_id AND bs.season=%s
          JOIN teams t ON bs.team_id=t.id JOIN conferences c ON t.conference_id=c.id JOIN divisions d ON c.division_id=d.id
          GROUP BY d.level
        """, (season, season, season, season, season, season))
        bat = {r['level']: r for r in cur.fetchall()}

        cur.execute(fresh_cte + """
          SELECT d.level,
            COUNT(*) FILTER (WHERE ip_outs(ps.innings_pitched)>=3) n_pitchers,
            ROUND((AVG(ip_outs(ps.innings_pitched)/3.0) FILTER (WHERE ip_outs(ps.innings_pitched)>=3))::numeric,1) avg_ip,
            ROUND((SUM(ps.earned_runs) FILTER (WHERE ip_outs(ps.innings_pitched)>=30)*9.0
                   / NULLIF(SUM(ip_outs(ps.innings_pitched)/3.0) FILTER (WHERE ip_outs(ps.innings_pitched)>=30),0))::numeric,2) avg_era
          FROM pitching_stats ps JOIN fresh f ON ps.player_id=f.player_id AND ps.season=%s
          JOIN teams t ON ps.team_id=t.id JOIN conferences c ON t.conference_id=c.id JOIN divisions d ON c.division_id=d.id
          GROUP BY d.level
        """, (season, season, season, season, season, season))
        pit = {r['level']: r for r in cur.fetchall()}

        # Freshmen who actually appeared (batted OR pitched) — the union, so a
        # two-way player counts once. Lets us report rostered - played = sat.
        cur.execute(fresh_cte + """, played AS (
            SELECT bs.player_id, d.level FROM batting_stats bs JOIN fresh f ON bs.player_id=f.player_id
              JOIN teams t ON bs.team_id=t.id JOIN conferences c ON t.conference_id=c.id JOIN divisions d ON c.division_id=d.id
              WHERE bs.season=%s AND bs.plate_appearances>=1
            UNION
            SELECT ps.player_id, d.level FROM pitching_stats ps JOIN fresh f ON ps.player_id=f.player_id
              JOIN teams t ON ps.team_id=t.id JOIN conferences c ON t.conference_id=c.id JOIN divisions d ON c.division_id=d.id
              WHERE ps.season=%s AND ip_outs(ps.innings_pitched)>=1
          )
          SELECT level, COUNT(DISTINCT player_id) n_played FROM played GROUP BY level
        """, (season, season, season, season, season, season, season))
        played = {r['level']: r['n_played'] for r in cur.fetchall()}

    def f(v):
        return float(v) if v is not None else None
    rows = []
    for lvl in order:
        b, p = bat.get(lvl), pit.get(lvl)
        if not b and not p:
            continue
        rostered = (FRESHMAN_ROSTERED.get(season) or {}).get(lvl)
        played_n = played.get(lvl)
        didnt = (max(0, rostered - played_n)
                 if (rostered is not None and played_n is not None) else None)
        rows.append({
            "level": lvl,
            "rostered": rostered,          # total Fr on rosters (4-year only; None for NWAC)
            "played": played_n,            # freshmen who batted or pitched
            "didnt_play": didnt,           # rostered - played (None where rostered unknown)
            "hitters": (b or {}).get('n_hitters') or 0,
            "avg_pa": f((b or {}).get('avg_pa')),
            "avg_ab": f((b or {}).get('avg_ab')),
            "avg_avg": f((b or {}).get('avg_avg')),
            "avg_ops": f((b or {}).get('avg_ops')),
            "avg_wrc": (int(b['avg_wrc']) if b and b.get('avg_wrc') is not None else None),
            "pitchers": (p or {}).get('n_pitchers') or 0,
            "avg_ip": f((p or {}).get('avg_ip')),
            "avg_era": f((p or {}).get('avg_era')),
        })
    return {"season": season, "divisions": rows}


# NWAC advancement: where JUCO players move on to, from cross-team player_links.
_ADV_FOUR = ("D1", "D2", "D3", "NAIA")
_ADV_WEIGHT = {"D1": 4, "D2": 3, "NAIA": 2, "D3": 1}

# Division level for committed schools we can't resolve from the teams table
# (out-of-region programs that never played a PNW team, plus a few PNW name
# variants). Keyed by lowercased committed_to. Add new schools here as commits
# come in; anything still unresolved shows as a four-year commit without a level.
_COMMIT_LEVEL_OVERRIDES = {
    "washington": "D1", "university of pacific": "D1", "bradley": "D1",
    "east carolina": "D1", "old dominion": "D1", "western kentucky": "D1",
    "akron": "D1", "saint louis university": "D1", "charleston southern": "D1",
    "marshall": "D1", "fairleigh dickinson": "D1", "alcorn state": "D1",
    "wofford": "D1",
    "montana state billings": "D2", "rogers state": "D2",
    # Vanguard + Jessup moved from NAIA (GSAC) to D2 (PacWest) — flagged 2026-06-15.
    "vanguard university": "D2", "jessup university": "D2", "jessup": "D2",
    "oregon tech": "NAIA", "tabor college": "NAIA",
    "freed-hardeman": "NAIA", "ottawa": "NAIA", "missouri baptist": "NAIA",
    "southwestern christian (oklahoma)": "NAIA", "union commonwealth": "NAIA",
    "friends university": "NAIA", "bellevue university": "NAIA",
    "ave maria": "NAIA", "arizona christian": "NAIA",
    # Corrections where our teams table has the destination mis-leveled:
    "tennessee wesleyan": "NAIA",
    "bethany lutheran": "D3",
}


def _resolve_committed_levels(cur, names):
    """committed_to school string -> division level. Override map first, then a
    four-year team match in our DB. Returns {lower(stripped name): level|None}.
    Shared by the JUCO tracker and the NWAC advancement graphic so a commitment
    shows the same level in both, and any new commitment resolves automatically."""
    out, todo = {}, []
    for n in names:
        if not n:
            continue
        key = n.strip().lower()
        if key in out:
            continue
        ov = _COMMIT_LEVEL_OVERRIDES.get(key)
        if ov:
            out[key] = ov
        else:
            out[key] = None
            todo.append(n)
    if todo:
        cur.execute(
            r"""SELECT lower(trim(x.name)) AS key, dd.level
                FROM unnest(%s::text[]) AS x(name)
                JOIN teams dest ON (
                   lower(dest.school_name)=lower(x.name) OR lower(dest.name)=lower(x.name)
                   OR lower(dest.short_name)=lower(x.name)
                   OR regexp_replace(lower(dest.school_name),'\s+(university|college)$','')
                      = regexp_replace(lower(trim(x.name)),'\s+(university|college|u)$','')
                   OR lower(dest.short_name)=regexp_replace(lower(trim(x.name)),'\s+(university|college|u)$',''))
                JOIN conferences cc ON dest.conference_id=cc.id JOIN divisions dd ON cc.division_id=dd.id
                WHERE dd.level <> 'JUCO'""",
            (todo,),
        )
        for r in cur.fetchall():
            if not out.get(r["key"]):
                out[r["key"]] = r["level"]
    return out


@router.get("/recruiting/nwac-advancement")
def recruiting_nwac_advancement(season: int = CURRENT_SEASON, _user: str = Depends(require_tier("premium"))):
    """Where NWAC (JUCO) players advance to, derived from cross-team player_links.

    Captures transfers to the PNW 4-year programs we track: a Bellevue -> Bushnell
    move shows up; Bellevue -> UCLA does not (UCLA isn't in our DB). A NWAC team's
    "advancement" = a linked player whose JUCO stint is followed by a stint at a
    four-year PNW school; the destination is the earliest such four-year stop.
    Also surfaces NWAC players with a committed school on file (thin data).
    """
    from collections import defaultdict
    with get_connection() as conn:
        cur = conn.cursor()
        # union-find clusters from player_links
        cur.execute("SELECT canonical_id, linked_id FROM player_links")
        parent = {}

        def find(x):
            parent.setdefault(x, x)
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        link_ids = set()
        for r in cur.fetchall():
            parent[find(r["canonical_id"])] = find(r["linked_id"])
            link_ids.add(r["canonical_id"])
            link_ids.add(r["linked_id"])

        members = {}
        if link_ids:
            cur.execute(
                """SELECT p.id, p.first_name, p.last_name, t.short_name AS team,
                          t.logo_url AS logo, d.level
                   FROM players p JOIN teams t ON t.id=p.team_id
                   JOIN conferences c ON t.conference_id=c.id
                   JOIN divisions d ON c.division_id=d.id
                   WHERE p.id = ANY(%s) AND COALESCE(p.is_phantom,false)=false""",
                (list(link_ids),),
            )
            members = {r["id"]: dict(r) for r in cur.fetchall()}
            lo, hi = defaultdict(lambda: 9999), defaultdict(int)
            for tbl in ("batting_stats", "pitching_stats"):
                cur.execute(
                    f"SELECT player_id, MIN(season) lo, MAX(season) hi FROM {tbl} "
                    "WHERE player_id = ANY(%s) GROUP BY player_id", (list(link_ids),),
                )
                for r in cur.fetchall():
                    lo[r["player_id"]] = min(lo[r["player_id"]], r["lo"])
                    hi[r["player_id"]] = max(hi[r["player_id"]], r["hi"])
            for pid, m in members.items():
                m["hi"] = hi[pid]
                m["lo"] = lo[pid] if hi[pid] else None

        clusters = defaultdict(list)
        for pid in members:
            clusters[find(pid)].append(pid)

        advances = []
        for root, ids in clusters.items():
            ms = [members[i] for i in ids]
            juco = [m for m in ms if m["level"] == "JUCO" and m["hi"]]
            four = [m for m in ms if m["level"] in _ADV_FOUR and m["hi"]]
            if not juco or not four:
                continue
            juco_last = max(m["hi"] for m in juco)
            dests = [m for m in four if (m["lo"] or 9999) >= juco_last]
            if not dests:
                continue
            dest = min(dests, key=lambda m: ((m["lo"] or 9999), -_ADV_WEIGHT[m["level"]]))
            origin = max(juco, key=lambda m: m["hi"])
            nm = members.get(root, dest)
            advances.append({
                "player": f"{nm['first_name']} {nm['last_name']}",
                "origin_team": origin["team"], "origin_logo": origin["logo"],
                "dest_team": dest["team"], "dest_logo": dest["logo"],
                "dest_level": dest["level"], "dest_season": dest["lo"],
            })

        # per-NWAC-team aggregation (seed with every active NWAC team)
        cur.execute(
            """SELECT t.short_name team, t.logo_url logo FROM teams t
               JOIN conferences c ON t.conference_id=c.id JOIN divisions d ON c.division_id=d.id
               WHERE d.level='JUCO' AND COALESCE(t.is_active,1)=1""")
        teams = {}
        for r in cur.fetchall():
            teams[r["team"]] = {"team": r["team"], "logo": r["logo"], "total": 0,
                                "d1": 0, "d2": 0, "naia": 0, "d3": 0, "score": 0,
                                "soph_count": 0, "dests": {}, "committed": []}

        dest_overall = {}
        for a in advances:
            t = teams.setdefault(a["origin_team"], {"team": a["origin_team"], "logo": a["origin_logo"],
                                                    "total": 0, "d1": 0, "d2": 0, "naia": 0, "d3": 0,
                                                    "score": 0, "soph_count": 0, "dests": {}, "committed": []})
            t["total"] += 1
            t[a["dest_level"].lower()] += 1
            t["score"] += _ADV_WEIGHT[a["dest_level"]]
            d = t["dests"].setdefault(a["dest_team"], {"team": a["dest_team"], "logo": a["dest_logo"],
                                                       "level": a["dest_level"], "count": 0})
            d["count"] += 1
            o = dest_overall.setdefault(a["dest_team"], {"team": a["dest_team"], "logo": a["dest_logo"],
                                                         "level": a["dest_level"], "count": 0})
            o["count"] += 1

        # Committed NWAC players (the current commit class). Resolve each
        # committed school's level: match a four-year team in our DB, else the
        # override map. This is the real "to D1 in 2026" cohort.
        cur.execute(
            r"""SELECT t.short_name team, t.logo_url nwac_logo, p.first_name, p.last_name,
                       p.committed_to, p.year_in_school, dt.level dest_level, dt.logo dest_logo
               FROM players p JOIN teams t ON t.id=p.team_id JOIN conferences c ON t.conference_id=c.id
               JOIN divisions d ON c.division_id=d.id
               LEFT JOIN LATERAL (
                 SELECT dd.level, dest.logo_url AS logo FROM teams dest
                 JOIN conferences cc ON dest.conference_id=cc.id JOIN divisions dd ON cc.division_id=dd.id
                 WHERE dd.level <> 'JUCO' AND (
                    lower(dest.school_name)=lower(p.committed_to) OR lower(dest.name)=lower(p.committed_to)
                    OR lower(dest.short_name)=lower(p.committed_to)
                    OR regexp_replace(lower(dest.school_name),'\s+(university|college)$','')
                       = regexp_replace(lower(trim(p.committed_to)),'\s+(university|college|u)$','')
                    OR lower(dest.short_name)=regexp_replace(lower(trim(p.committed_to)),'\s+(university|college|u)$',''))
                 LIMIT 1
               ) dt ON true
               WHERE d.level='JUCO' AND COALESCE(p.is_committed,0)=1
                 AND p.committed_to IS NOT NULL AND p.committed_to <> ''""")
        commits = []
        for r in cur.fetchall():
            level = _COMMIT_LEVEL_OVERRIDES.get((r["committed_to"] or "").strip().lower()) or r["dest_level"]
            entry = {"player": f"{r['first_name']} {r['last_name']}", "nwac_team": r["team"],
                     "nwac_logo": r["nwac_logo"], "dest": r["committed_to"], "dest_level": level,
                     "dest_logo": r["dest_logo"], "year": r["year_in_school"]}
            commits.append(entry)
            t = teams.get(r["team"])
            if t is not None:
                t["committed"].append({"player": entry["player"], "dest": r["committed_to"],
                                       "level": level, "year": r["year_in_school"]})

        # Current (2026) sophomore counts per team — the denominator for "what
        # share of this year's sophomores are moving on."
        cur.execute(
            """SELECT t.short_name team, COUNT(*) soph
               FROM players p JOIN teams t ON t.id=p.team_id JOIN conferences c ON t.conference_id=c.id
               JOIN divisions d ON c.division_id=d.id
               WHERE d.level='JUCO' AND COALESCE(p.is_phantom,false)=false
                 AND p.year_in_school IN ('So','R-So')
                 AND (p.roster_year=%s
                      OR EXISTS(SELECT 1 FROM batting_stats b WHERE b.player_id=p.id AND b.season=%s)
                      OR EXISTS(SELECT 1 FROM pitching_stats ps WHERE ps.player_id=p.id AND ps.season=%s))
               GROUP BY t.short_name""",
            (CURRENT_SEASON, CURRENT_SEASON, CURRENT_SEASON))
        for r in cur.fetchall():
            if r["team"] in teams:
                teams[r["team"]]["soph_count"] = r["soph"]

        cur.execute("SELECT LEAST((SELECT MIN(season) FROM batting_stats),"
                    "(SELECT MIN(season) FROM pitching_stats)) AS earliest")
        tracking_since = cur.fetchone()["earliest"]

    _lvl_rank = {"D1": 0, "D2": 1, "NAIA": 2, "D3": 3, None: 4}
    commits.sort(key=lambda c: (_lvl_rank.get(c["dest_level"], 4), c["nwac_team"], c["player"]))
    commit_counts = {lv: sum(1 for c in commits if c["dest_level"] == lv) for lv in ("D1", "D2", "NAIA", "D3")}
    commit_counts["other"] = sum(1 for c in commits if not c["dest_level"])
    commit_counts["total"] = len(commits)

    team_rows = []
    for t in teams.values():
        t["distinct_dests"] = len(t["dests"])
        t["destinations"] = sorted(t["dests"].values(),
                                   key=lambda d: (-_ADV_WEIGHT[d["level"]], -d["count"]))
        del t["dests"]
        t["committed_count"] = len(t["committed"])
        team_rows.append(t)
    team_rows.sort(key=lambda t: (-t["total"], -t["score"]))

    d1_arrivals = sorted(
        [a for a in advances if a["dest_level"] == "D1" and a["dest_season"] == season],
        key=lambda a: a["origin_team"],
    )
    totals = {
        "advanced": len(advances),
        "d1": sum(1 for a in advances if a["dest_level"] == "D1"),
        "d2": sum(1 for a in advances if a["dest_level"] == "D2"),
        "naia": sum(1 for a in advances if a["dest_level"] == "NAIA"),
        "d3": sum(1 for a in advances if a["dest_level"] == "D3"),
        "teams_sending": sum(1 for t in team_rows if t["total"] > 0),
    }
    top_destinations = sorted(dest_overall.values(),
                              key=lambda d: (-d["count"], -_ADV_WEIGHT[d["level"]]))[:20]
    return {"season": season, "tracking_since": tracking_since, "totals": totals,
            "commits": commits, "commit_counts": commit_counts, "d1_arrivals": d1_arrivals,
            "teams": team_rows, "top_destinations": top_destinations}


@router.get("/recruiting/program-guide")
def recruiting_program_guide(_user: str = Depends(require_tier("premium"))):
    if not os.path.exists(PROGRAM_GUIDE_PATH):
        raise HTTPException(status_code=404, detail="Program guide not available")
    return FileResponse(
        PROGRAM_GUIDE_PATH,
        media_type="application/pdf",
        headers={
            "Content-Disposition": "inline; filename=nwbb-program-guide.pdf",
            "Cache-Control": "private, max-age=3600",
        },
    )


# ============================================================
# RECRUITING BREAKDOWN
# ============================================================

@router.get("/recruiting/breakdown")
@cached_endpoint(ttl_seconds=3600)  # keyed per-user via the tier dependency arg; data changes daily at most
def recruiting_breakdown(
    season: int = CURRENT_SEASON,
    _user: str = Depends(require_tier("premium")),
):
    """
    Team-level recruiting breakdown table.
    Returns per-team: record, W-L%, 3-year trend, freshman PA%, freshman IP%,
    WAR/G, team wRC+, team FIP, with division info.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # 1) Current season records + W-L% for current and prior 2 seasons
        cur.execute("""
            SELECT tss.team_id, t.name, t.short_name, t.logo_url,
                   d.level AS division,
                   tss.season, tss.wins, tss.losses
            FROM team_season_stats tss
            JOIN teams t ON tss.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE tss.season BETWEEN %s AND %s
              AND t.is_active = 1
              AND t.state IN ('WA', 'OR', 'ID', 'MT', 'BC')
            ORDER BY tss.team_id, tss.season
        """, (season - 2, season))
        records_rows = cur.fetchall()

        # Build per-team record data
        team_records = {}  # team_id -> {season -> {wins, losses}}
        team_info = {}     # team_id -> {name, short_name, logo_url, division}
        for r in records_rows:
            tid = r["team_id"]
            if tid not in team_info:
                team_info[tid] = {
                    "team_id": tid,
                    "name": r["name"],
                    "short_name": r["short_name"],
                    "logo_url": r["logo_url"],
                    "division": r["division"],
                }
            if tid not in team_records:
                team_records[tid] = {}
            s = r["season"]
            w, l = r["wins"] or 0, r["losses"] or 0
            team_records[tid][s] = {"wins": w, "losses": l, "win_pct": round(w / (w + l), 3) if (w + l) > 0 else 0}

        # Only include teams that have current season data
        active_teams = [tid for tid in team_records if season in team_records[tid]]

        if not active_teams:
            return []

        placeholders = ",".join(["%s"] * len(active_teams))

        # 2) Freshman PA% - Fr + R-Fr plate appearances as % of team total
        cur.execute(f"""
            SELECT bs.team_id,
                   SUM(CASE WHEN p.year_in_school IN ('Fr', 'R-Fr') THEN bs.plate_appearances ELSE 0 END) AS fr_pa,
                   SUM(bs.plate_appearances) AS total_pa
            FROM batting_stats bs
            JOIN players p ON bs.player_id = p.id
            WHERE bs.season = %s AND bs.team_id IN ({placeholders})
            GROUP BY bs.team_id
        """, [season] + active_teams)
        fr_pa_data = {r["team_id"]: {"fr_pa": r["fr_pa"] or 0, "total_pa": r["total_pa"] or 0} for r in cur.fetchall()}

        # 3) Freshman IP% - Fr + R-Fr innings as % of team total
        cur.execute(f"""
            SELECT ps.team_id,
                   (SUM(CASE WHEN p.year_in_school IN ('Fr', 'R-Fr') THEN ip_outs(ps.innings_pitched) ELSE 0 END) / 3.0)::float8 AS fr_ip,
                   (SUM(ip_outs(ps.innings_pitched)) / 3.0)::float8 AS total_ip
            FROM pitching_stats ps
            JOIN players p ON ps.player_id = p.id
            WHERE ps.season = %s AND ps.team_id IN ({placeholders})
            GROUP BY ps.team_id
        """, [season] + active_teams)
        fr_ip_data = {r["team_id"]: {"fr_ip": float(r["fr_ip"] or 0), "total_ip": float(r["total_ip"] or 0)} for r in cur.fetchall()}

        # 4) Team WAR totals (offensive + pitching) and games played
        cur.execute(f"""
            SELECT bs.team_id, SUM(COALESCE(bs.offensive_war, 0)) AS total_owar,
                   MAX(tss.wins) + MAX(tss.losses) AS games
            FROM batting_stats bs
            JOIN team_season_stats tss ON bs.team_id = tss.team_id AND bs.season = tss.season
            WHERE bs.season = %s AND bs.team_id IN ({placeholders})
            GROUP BY bs.team_id
        """, [season] + active_teams)
        owar_data = {r["team_id"]: {"owar": float(r["total_owar"] or 0), "games": r["games"] or 0} for r in cur.fetchall()}

        cur.execute(f"""
            SELECT ps.team_id, SUM(COALESCE(ps.pitching_war, 0)) AS total_pwar
            FROM pitching_stats ps
            WHERE ps.season = %s AND ps.team_id IN ({placeholders})
            GROUP BY ps.team_id
        """, [season] + active_teams)
        pwar_data = {r["team_id"]: float(r["total_pwar"] or 0) for r in cur.fetchall()}

        # 5) Team avg wRC+ (weighted by PA)
        cur.execute(f"""
            SELECT bs.team_id,
                   SUM(bs.wrc_plus * bs.plate_appearances) / NULLIF(SUM(bs.plate_appearances), 0) AS avg_wrc_plus
            FROM batting_stats bs
            WHERE bs.season = %s AND bs.team_id IN ({placeholders})
              AND bs.plate_appearances >= 20
              AND bs.wrc_plus IS NOT NULL
            GROUP BY bs.team_id
        """, [season] + active_teams)
        wrc_data = {r["team_id"]: round(float(r["avg_wrc_plus"]), 1) if r["avg_wrc_plus"] else None for r in cur.fetchall()}

        # 6) Team avg FIP (weighted by IP)
        cur.execute(f"""
            SELECT ps.team_id,
                   SUM(ps.fip * ip_outs(ps.innings_pitched)) / NULLIF(SUM(ip_outs(ps.innings_pitched)), 0) AS avg_fip
            FROM pitching_stats ps
            WHERE ps.season = %s AND ps.team_id IN ({placeholders})
              AND ps.innings_pitched >= 5
              AND ps.fip IS NOT NULL
            GROUP BY ps.team_id
        """, [season] + active_teams)
        fip_data = {r["team_id"]: round(float(r["avg_fip"]), 2) if r["avg_fip"] else None for r in cur.fetchall()}

        # 7) National composite rankings (D1/D2/D3/NAIA)
        cur.execute(f"""
            SELECT team_id, composite_rank
            FROM composite_rankings
            WHERE season = %s AND team_id IN ({placeholders})
        """, [season] + active_teams)
        rank_data = {r["team_id"]: int(r["composite_rank"]) if r["composite_rank"] else None for r in cur.fetchall()}

        # 8) CPI rankings for NWAC (no national rankings available).
        #    Within-JUCO Composite Power Index rank (SoS-adjusted, predictive).
        juco_teams = [tid for tid in active_teams if team_info[tid]["division"] == "JUCO"]
        cpi_data = {}
        if juco_teams:
            juco_ranked = compute_cpi_for_division(
                cur, juco_teams, season,
                season_games=SEASON_GAMES_BY_LEVEL["JUCO"])
            cpi_data = {t["team_id"]: t["rank"] for t in juco_ranked}

        # Build the response
        results = []
        for tid in active_teams:
            info = team_info[tid]
            rec = team_records[tid]
            curr = rec.get(season, {})
            prev1 = rec.get(season - 1, {})
            prev2 = rec.get(season - 2, {})

            # 3-year trend: weighted linear trend of W-L%
            # Use simple difference: current - average of prior 2 (if available)
            trend_seasons = []
            if prev2 and prev2.get("wins", 0) + prev2.get("losses", 0) > 0:
                trend_seasons.append(prev2["win_pct"])
            if prev1 and prev1.get("wins", 0) + prev1.get("losses", 0) > 0:
                trend_seasons.append(prev1["win_pct"])

            trend = None
            if trend_seasons:
                prior_avg = sum(trend_seasons) / len(trend_seasons)
                trend = round(curr.get("win_pct", 0) - prior_avg, 3)

            # Freshman PA%
            fpa = fr_pa_data.get(tid, {})
            fr_pa_pct = round(fpa.get("fr_pa", 0) / fpa["total_pa"] * 100, 1) if fpa.get("total_pa", 0) > 0 else 0

            # Freshman IP%
            fip_ip = fr_ip_data.get(tid, {})
            fr_ip_pct = round(fip_ip.get("fr_ip", 0) / fip_ip["total_ip"] * 100, 1) if fip_ip.get("total_ip", 0) > 0 else 0

            # WAR/G
            owar_info = owar_data.get(tid, {"owar": 0, "games": 0})
            pwar_val = pwar_data.get(tid, 0)
            total_war = owar_info["owar"] + pwar_val
            games = owar_info["games"]
            war_per_game = round(total_war / games, 2) if games > 0 else 0

            results.append({
                "team_id": tid,
                "name": info["name"],
                "short_name": info["short_name"],
                "logo_url": info["logo_url"],
                "division": info["division"],
                "wins": curr.get("wins", 0),
                "losses": curr.get("losses", 0),
                "win_pct": curr.get("win_pct", 0),
                "prev1_win_pct": prev1.get("win_pct") if prev1 else None,
                "prev2_win_pct": prev2.get("win_pct") if prev2 else None,
                "trend": trend,
                "fr_pa_pct": fr_pa_pct,
                "fr_ip_pct": fr_ip_pct,
                "war_per_game": war_per_game,
                "team_wrc_plus": wrc_data.get(tid),
                "team_fip": fip_data.get(tid),
                "games": games,
                "total_war": round(total_war, 1),
                "national_rank": rank_data.get(tid),
                "cpi_rank": cpi_data.get(tid),
            })

        # Sort by win_pct descending by default
        results.sort(key=lambda x: x["win_pct"], reverse=True)
        return results


# ════════════════════════════════════════════════════════════════════
# RECRUITING CLASSES — HS commits to our PNW schools (from BBNW/PBR)
# ════════════════════════════════════════════════════════════════════
# Data lives in the `recruits` table (scripts/scrape_recruits.py). Each row
# is a HS player committed to one of our schools (committed_team_id), with
# the better of the BBNW/PBR per-state rank → recruit_score (0-100). A
# school's class_score is the SUM of its commits' scores (rewards landing
# more good players); we also expose the average and the top commit.

_PNW_STATES = ('WA', 'OR', 'ID', 'MT', 'BC')


def _recruit_row(r):
    """Shape one recruit row for the API (used by class detail + team page)."""
    return {
        "id": r["id"],
        "name": f'{r["first_name"]} {r["last_name"]}'.strip(),
        "first_name": r["first_name"],
        "last_name": r["last_name"],
        "position": r["position"],
        "grad_year": r["grad_year"],
        "high_school": r["high_school"],
        "city": r["city"],
        "state": r["state"],
        "height": r["height"],
        "weight": r["weight"],
        # Single public "State Rank" = the rounded average of the source
        # ranks we hold. We deliberately do NOT expose which outlets these
        # came from (per Nate).
        "state_rank": _combined_rank(r["bbnw_state_rank"], r["pbr_state_rank"]),
        "recruit_score": float(r["recruit_score"]) if r["recruit_score"] is not None else None,
        "is_ranked": r["bbnw_state_rank"] is not None or r["pbr_state_rank"] is not None,
        "headshot_url": r["headshot_url"],
    }


def _combined_rank(bbnw_rank, pbr_rank):
    """Average the source ranks into one whole-number State Rank (no
    fractions). #10 + #20 -> 15. One source -> that rank. None -> None."""
    ranks = [x for x in (bbnw_rank, pbr_rank) if x is not None]
    if not ranks:
        return None
    return int(sum(ranks) / len(ranks) + 0.5)


# A class needs at least this many ranked-state commits to earn a competitive
# class_rank — keeps a school that landed one elite player off the top of the
# board on a 1-man sample. Smaller classes still return (with their commits),
# just without a rank.
_MIN_RANKED_FOR_CLASS = 3


def _class_summary_rows(cur, grad_year, limit=None):
    """Per-school class summary. class_score is the AVERAGE recruit_score over
    commits from states we have rankings for (recruit_score IS NOT NULL) — so
    landing more players never inflates a class, and commits from no-ranking
    states (per recruiting_constants.RANKED_STATES) are excluded, not
    penalized. Ranked by that average. Shared by the premium board + teaser."""
    cur.execute(
        """
        SELECT t.id AS team_id, t.name, t.short_name, t.logo_url,
               d.level AS division,
               COUNT(*) AS commits,
               COUNT(r.recruit_score) AS scored_commits,
               COUNT(*) FILTER (WHERE r.bbnw_state_rank IS NOT NULL
                                   OR r.pbr_state_rank IS NOT NULL) AS ranked,
               ROUND(AVG(r.recruit_score), 1)::float8 AS class_score,
               MAX(r.recruit_score) AS top_score
        FROM recruits r
        JOIN teams t ON r.committed_team_id = t.id
        JOIN conferences c ON t.conference_id = c.id
        JOIN divisions d ON c.division_id = d.id
        WHERE r.grad_year = %s AND t.state IN %s
        GROUP BY t.id, t.name, t.short_name, t.logo_url, d.level
        ORDER BY (COUNT(r.recruit_score) >= %s) DESC,
                 class_score DESC NULLS LAST, ranked DESC
        """,
        (grad_year, _PNW_STATES, _MIN_RANKED_FOR_CLASS),
    )
    rows = [dict(r) for r in cur.fetchall()]

    # Attach each class's top commit (name + position) in one extra query.
    if rows:
        team_ids = [r["team_id"] for r in rows]
        ph = ",".join(["%s"] * len(team_ids))
        cur.execute(
            f"""
            SELECT DISTINCT ON (committed_team_id)
                   committed_team_id AS tid, first_name, last_name, position,
                   bbnw_state_rank, pbr_state_rank
            FROM recruits
            WHERE grad_year = %s AND committed_team_id IN ({ph})
            ORDER BY committed_team_id, recruit_score DESC
            """,
            [grad_year] + team_ids,
        )
        top = {r["tid"]: r for r in cur.fetchall()}
        for row in rows:
            t = top.get(row["team_id"])
            row["top_commit"] = (
                {"name": f'{t["first_name"]} {t["last_name"]}'.strip(),
                 "position": t["position"],
                 "rank": t["bbnw_state_rank"] or t["pbr_state_rank"]}
                if t else None
            )
            row["class_score"] = round(row["class_score"], 1) if row["class_score"] is not None else None
            row["top_score"] = float(row["top_score"]) if row["top_score"] is not None else None

    # Only classes with enough ranked-state commits get a competitive rank.
    rank = 0
    for row in rows:
        if row["scored_commits"] >= _MIN_RANKED_FOR_CLASS and row["class_score"] is not None:
            rank += 1
            row["class_rank"] = rank
        else:
            row["class_rank"] = None
    return rows[:limit] if limit else rows


@router.get("/recruiting/classes")
@cached_endpoint(ttl_seconds=3600)
def recruiting_classes(
    grad_year: int = Query(2026, description="Recruiting class year"),
    _user: str = Depends(require_tier("premium")),
):
    """Per-school incoming-class leaderboard ranked by class_score."""
    with get_connection() as conn:
        cur = conn.cursor()
        return {"grad_year": grad_year, "classes": _class_summary_rows(cur, grad_year)}


@router.get("/recruiting/classes/top")
@cached_endpoint(ttl_seconds=3600)
def recruiting_classes_top(
    grad_year: int = Query(2026, description="Recruiting class year"),
    limit: int = Query(5, ge=1, le=15),
):
    """PUBLIC teaser: the top recruiting classes (drives signups to the
    premium board). Same summary shape, capped to `limit`."""
    with get_connection() as conn:
        cur = conn.cursor()
        return {"grad_year": grad_year, "classes": _class_summary_rows(cur, grad_year, limit=limit)}


@router.get("/recruiting/classes/{team_id}")
@cached_endpoint(ttl_seconds=3600)
def recruiting_class_detail(
    team_id: int,
    grad_year: int = Query(2026, description="Recruiting class year"),
    _user: str = Depends(require_tier("premium")),
):
    """One school's full incoming class: every commit with ranks + score."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT t.id, t.name, t.short_name, t.logo_url, d.level AS division
               FROM teams t
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE t.id = %s""",
            (team_id,),
        )
        team = cur.fetchone()
        if not team:
            raise HTTPException(status_code=404, detail="Team not found")
        cur.execute(
            """SELECT * FROM recruits
               WHERE committed_team_id = %s AND grad_year = %s
               ORDER BY recruit_score DESC, last_name""",
            (team_id, grad_year),
        )
        commits = [_recruit_row(r) for r in cur.fetchall()]
        # class_score = AVERAGE over commits from ranked states (recruit_score
        # not null); volume-neutral, no-ranking-state commits excluded.
        scored = [c["recruit_score"] for c in commits if c["recruit_score"] is not None]
        return {
            "team": dict(team),
            "grad_year": grad_year,
            "commit_count": len(commits),
            "ranked_count": sum(1 for c in commits if c["is_ranked"]),
            "scored_count": len(scored),
            "class_score": round(sum(scored) / len(scored), 1) if scored else None,
            "commits": commits,
        }


@router.get("/teams/{team_id}/recruits")
@cached_endpoint(ttl_seconds=3600)
def team_recruits(
    team_id: int,
    grad_year: int = Query(2026, description="Recruiting class year"),
):
    """PUBLIC: a team's incoming HS commits, for the team-page section."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT * FROM recruits
               WHERE committed_team_id = %s AND grad_year = %s
               ORDER BY recruit_score DESC, last_name""",
            (team_id, grad_year),
        )
        commits = [_recruit_row(r) for r in cur.fetchall()]
        scored = [c["recruit_score"] for c in commits if c["recruit_score"] is not None]
        return {
            "team_id": team_id,
            "grad_year": grad_year,
            "commit_count": len(commits),
            "scored_count": len(scored),
            "class_score": round(sum(scored) / len(scored), 1) if scored else None,
            "commits": commits,
        }


# ── Transfers (JUCO + portal commits) → Recruiting Classes "Transfers" view ──
# HS recruits live in the `recruits` table; transfers do NOT — they are existing
# college players who committed to a PNW program. Two sources feed them:
#   * JUCO tracker: players.is_committed = 1 + players.committed_to (free text)
#   * Portal tracker: backend/data/transfer_portal.json (curated, committed_to)
# We resolve each commitment string to one of the 57 PNW programs we feature (the
# recruit_school_map universe) via the shared team_matching resolver, dropping
# out-of-region / OOC destinations, and group by destination team. Ratings for
# transfers come later — for now they are listed, not scored.

_TRANSFER_PORTAL_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "data",
                                     "transfer_portal.json")
_RECRUIT_SCHOOL_MAP_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "data",
                                        "recruit_school_map.json")


def _pnw_program_ids():
    """team_ids of the PNW programs the recruiting board covers (the 57 schools in
    recruit_school_map). Used to drop transfer destinations that resolve to a
    non-PNW or out-of-conference team (San Diego, Bradley, OOC placeholders)."""
    try:
        with open(_RECRUIT_SCHOOL_MAP_PATH) as f:
            return {int(k) for k in json.load(f).keys()}
    except (OSError, ValueError):
        return set()


def _load_transfer_portal():
    try:
        with open(_TRANSFER_PORTAL_PATH) as f:
            return json.load(f).get("players", [])
    except (OSError, ValueError):
        return []


def _resolve_committed_team_id(cur, name, cache, pnw_ids):
    """committed_to string -> a PNW program team_id, or None. Uses the shared
    team_matching resolver (aliases, Pacific D1/D3 disambiguation, no row
    creation) then keeps only teams that sit on the recruiting board."""
    if not name:
        return None
    key = name.strip().lower()
    if key in cache:
        return cache[key]
    try:
        from team_matching import get_team_id_by_school  # scripts/, lazy
    except ImportError:
        import sys
        scripts = os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts")
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        from team_matching import get_team_id_by_school
    tid = get_team_id_by_school(cur, name)
    if tid not in pnw_ids:
        tid = None
    cache[key] = tid
    return tid


def _transfer_commits(cur):
    """Every committed transfer (JUCO + portal) that landed at a PNW program, as
    flat dicts ready to group by dest_team_id."""
    pnw_ids = _pnw_program_ids()
    cache = {}
    out = []

    # JUCO tracker — players.is_committed + committed_to (free-text school).
    cur.execute(
        """SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school,
                  p.committed_to, p.headshot_url, t.short_name AS prev_school
           FROM players p
           JOIN teams t ON t.id = p.team_id
           JOIN conferences c ON t.conference_id = c.id
           JOIN divisions d ON c.division_id = d.id
           WHERE d.level = 'JUCO' AND COALESCE(p.is_committed, 0) = 1
             AND p.committed_to IS NOT NULL AND p.committed_to <> ''""")
    for r in cur.fetchall():
        tid = _resolve_committed_team_id(cur, r["committed_to"], cache, pnw_ids)
        if not tid:
            continue
        out.append({
            "player_id": r["id"],
            "name": f'{r["first_name"]} {r["last_name"]}'.strip(),
            "position": r["position"], "year": r["year_in_school"],
            "previous_school": r["prev_school"], "headshot_url": r["headshot_url"],
            "dest_team_id": tid, "source": "juco",
        })

    # Portal tracker — committed entries from the curated JSON. Entries WITH a
    # player_id are PNW players we track (stats → WAR). Entries WITHOUT one are
    # incoming transfers from outside our DB (out-of-region commits to a PNW
    # school); they carry inline name/from and have no stats, so they list
    # unrated.
    portal_entries = [p for p in _load_transfer_portal() if p.get("committed_to")]
    pid_list = [p["player_id"] for p in portal_entries if p.get("player_id")]
    prow = {}
    if pid_list:
        cur.execute(
            """SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school,
                      p.headshot_url, t.short_name AS prev_school
               FROM players p JOIN teams t ON t.id = p.team_id
               WHERE p.id = ANY(%s)""", (pid_list,))
        prow = {r["id"]: r for r in cur.fetchall()}
    for pj in portal_entries:
        tid = _resolve_committed_team_id(cur, pj["committed_to"], cache, pnw_ids)
        if not tid:
            continue
        pid = pj.get("player_id")
        r = prow.get(pid) if pid else None
        full = f'{r["first_name"]} {r["last_name"]}'.strip() if r else None
        out.append({
            "player_id": pid,
            "name": pj.get("name") or full or "Unknown",
            "position": pj.get("position") or (r["position"] if r else None),
            "year": r["year_in_school"] if r else None,
            "previous_school": pj.get("from") or (r["prev_school"] if r else None),
            "headshot_url": r["headshot_url"] if r else None,
            "dest_team_id": tid, "source": "portal",
        })
    return out


# A D1 player dropping to D2/D3/NAIA has outsized impact at the new level, so we
# double his WAR in the transfer rating (per Nate). Same season-WAR basis as the
# JUCO / portal trackers: offensive_war + pitching_war for the current season.
_TRANSFER_DROP_DOWN_LEVELS = {"D2", "D3", "NAIA"}
_PITCHER_POSITIONS = {"P", "RHP", "LHP", "SP", "RP", "PITCHER"}


def _war_pool_ranks(cur, pids, season, war_table, war_col, juco):
    """player_id -> rank within a full division pool by a single WAR column.
    juco=True ranks among ALL NWAC (JUCO) players; juco=False among all the
    four-year players we track. Returned only for the players in `pids`, but the
    rank reflects the WHOLE pool — so the #1 hitter overall is rank 1 even if he
    isn't a transfer (Karsten Hansen anchors the NWAC hitter scale)."""
    op = "=" if juco else "<>"
    cur.execute(
        f"""SELECT player_id, rnk FROM (
                SELECT s.player_id,
                       RANK() OVER (ORDER BY s.{war_col} DESC) AS rnk
                FROM {war_table} s
                JOIN players p ON p.id = s.player_id
                JOIN teams t ON t.id = p.team_id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                WHERE d.level {op} 'JUCO' AND s.season = %s
                  AND s.{war_col} IS NOT NULL
            ) z WHERE player_id = ANY(%s)""", (season, pids))
    return {r["player_id"]: r["rnk"] for r in cur.fetchall()}


def _enrich_transfer_war(cur, commits, season):
    """Attach season WAR + league rank to each transfer. Mutates `commits`,
    adding war (offense+pitching, matching the trackers), war_adjusted (×2 for a
    D1→lower portal move), boosted, player_type ('hitter'/'pitcher' by dominant
    WAR), and pool_rank — the player's standing among ALL players in his pool
    (NWAC for JUCO commits, four-year for portal), ranked by his side's WAR.
    Hitting and pitching are ranked separately (never combined)."""
    if not commits:
        return
    pids = [c["player_id"] for c in commits if c["player_id"] is not None]
    cur.execute(
        """SELECT p.id, d.level AS origin_level,
                  bs.offensive_war AS owar, ps.pitching_war AS pwar
           FROM players p
           JOIN teams t ON t.id = p.team_id
           JOIN conferences c ON t.conference_id = c.id
           JOIN divisions d ON c.division_id = d.id
           LEFT JOIN batting_stats bs ON bs.player_id = p.id AND bs.season = %s
           LEFT JOIN pitching_stats ps ON ps.player_id = p.id AND ps.season = %s
           WHERE p.id = ANY(%s)""", (season, season, pids))
    info = {r["id"]: (r["owar"], r["pwar"], r["origin_level"]) for r in cur.fetchall()}
    dids = sorted({c["dest_team_id"] for c in commits})
    cur.execute(
        """SELECT t.id, d.level FROM teams t
           JOIN conferences c ON t.conference_id = c.id
           JOIN divisions d ON c.division_id = d.id
           WHERE t.id = ANY(%s)""", (dids,))
    dest_level = {r["id"]: r["level"] for r in cur.fetchall()}

    # Full-pool WAR leaderboards (split hitting / pitching) for both divisions.
    juco_hit = _war_pool_ranks(cur, pids, season, "batting_stats", "offensive_war", True)
    juco_pit = _war_pool_ranks(cur, pids, season, "pitching_stats", "pitching_war", True)
    four_hit = _war_pool_ranks(cur, pids, season, "batting_stats", "offensive_war", False)
    four_pit = _war_pool_ranks(cur, pids, season, "pitching_stats", "pitching_war", False)

    NEG = float("-inf")
    for c in commits:
        owar, pwar, origin = info.get(c["player_id"], (None, None, None))
        o = float(owar) if owar is not None else None
        p = float(pwar) if pwar is not None else None
        # "rated" = we have season stats for him. Out-of-region incoming commits
        # (no DB stats) are unrated: shown, but left out of the WAR average so a
        # team isn't penalized for a transfer we simply can't measure.
        c["rated"] = o is not None or p is not None
        if not c["rated"]:
            c["war"] = c["war_adjusted"] = c["pool_rank"] = None
            c["boosted"] = False
            c["player_type"] = ("pitcher" if (c.get("position") or "").upper()
                                in _PITCHER_POSITIONS else "hitter")
            continue
        war = (o or 0.0) + (p or 0.0)
        is_pitcher = (p if p is not None else NEG) > (o if o is not None else NEG)
        boosted = (c["source"] == "portal" and origin == "D1"
                   and dest_level.get(c["dest_team_id"]) in _TRANSFER_DROP_DOWN_LEVELS)
        c["war"] = round(war, 1)
        c["war_adjusted"] = round(war * 2 if boosted else war, 1)
        c["boosted"] = boosted
        c["player_type"] = "pitcher" if is_pitcher else "hitter"
        if c["source"] == "juco":
            pool = (juco_pit if is_pitcher else juco_hit)
        else:
            pool = (four_pit if is_pitcher else four_hit)
        c["pool_rank"] = pool.get(c["player_id"])


@router.get("/recruiting/transfers")
@cached_endpoint(ttl_seconds=300)
def recruiting_transfers(
    grad_year: int = Query(2026, description="Cycle year (transfers are the current incoming class)"),
    _user: str = Depends(require_tier("premium")),
):
    """Transfer commits (JUCO + portal) grouped by destination PNW program, for the
    Recruiting Classes "Transfers" / "Combined" views. Each transfer carries its
    season WAR (portal D1→lower doubled) and its league rank (among ALL NWAC
    players for JUCO commits, hitting and pitching ranked separately); a program's
    transfer rating is the sum of its transfers' WAR floored at 0 (a below-
    replacement transfer never hurts). Read live from the DB on every cache miss,
    so a newly-flagged commitment appears within the short cache window."""
    with get_connection() as conn:
        cur = conn.cursor()
        commits = _transfer_commits(cur)
        _enrich_transfer_war(cur, commits, CURRENT_SEASON)
        teams = {}
        ids = sorted({c["dest_team_id"] for c in commits})
        if ids:
            cur.execute(
                """SELECT t.id, t.name, t.short_name, t.logo_url, d.level AS division
                   FROM teams t JOIN conferences c ON t.conference_id = c.id
                   JOIN divisions d ON c.division_id = d.id
                   WHERE t.id = ANY(%s)""", (ids,))
            for r in cur.fetchall():
                teams[r["id"]] = {"team_id": r["id"], "name": r["name"],
                                  "short_name": r["short_name"], "logo_url": r["logo_url"],
                                  "division": r["division"], "transfers": []}
        for c in commits:
            t = teams.get(c["dest_team_id"])
            if t is not None:
                t["transfers"].append({k: c[k] for k in (
                    "player_id", "name", "position", "year", "previous_school",
                    "headshot_url", "source", "war", "war_adjusted", "boosted",
                    "player_type", "pool_rank", "rated")})
        rows = list(teams.values())
        for t in rows:
            t["transfer_count"] = len(t["transfers"])
            # Average over RATED transfers only (we have WAR for them). The
            # rating is the AVERAGE WAR per transfer (volume-neutral, like the HS
            # class rating): 7 transfers worth 7 WAR rate at 1.0, not 7. Unrated
            # out-of-region commits are shown but excluded here, not penalized.
            rated = [max(0.0, x["war_adjusted"]) for x in t["transfers"] if x["rated"]]
            t["rated_count"] = len(rated)
            t["transfer_total"] = round(sum(rated), 1)
            t["transfer_rating"] = round(sum(rated) / len(rated), 2) if rated else 0.0
            # Best (rated) transfers first; unrated commits sort to the end.
            t["transfers"].sort(key=lambda x: (not x["rated"], -(x["war_adjusted"] or 0)))
        # Rank programs by average transfer WAR (the NWAC/portal class quality).
        rows.sort(key=lambda t: (-t["transfer_rating"], -t["transfer_count"], t["name"]))
        return {
            "grad_year": grad_year, "teams": rows,
            "totals": {
                "transfers": len(commits), "teams": len(rows),
                "juco": sum(1 for c in commits if c["source"] == "juco"),
                "portal": sum(1 for c in commits if c["source"] == "portal"),
            },
        }
