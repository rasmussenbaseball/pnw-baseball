#!/usr/bin/env python3
"""
Audit box score gaps: compare season stats 'games' count vs actual game_batting rows.

Shows per-team summary and per-player detail for players with missing game logs.

Usage (on server):
    cd /opt/pnw-baseball
    python3 scripts/audit_boxscore_gaps.py --season 2026
    python3 scripts/audit_boxscore_gaps.py --season 2026 --team 53    # single team
    python3 scripts/audit_boxscore_gaps.py --season 2026 --detail     # show player-level gaps
"""

import argparse
import os
import sys

import psycopg2
import psycopg2.extras

# ── DB connection ──
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
DATABASE_URL = os.environ.get("DATABASE_URL")


def get_conn():
    url = DATABASE_URL
    if url and "sslmode" not in url:
        sep = "&" if "?" in url else "?"
        url = url + sep + "sslmode=require"
    conn = psycopg2.connect(url)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def run_audit(season, team_id=None, show_detail=False):
    conn = get_conn()
    cur = conn.cursor()

    # ── Team-level summary ──
    team_filter = ""
    params = [season, season]
    if team_id:
        team_filter = "AND t.id = %s"
        params.append(team_id)

    cur.execute(f"""
        WITH season_games AS (
            -- Sum of max(games) per player per team from batting_stats
            SELECT
                bs.team_id,
                SUM(bs.games) AS total_player_games,
                COUNT(*) AS num_players,
                MAX(bs.games) AS max_player_games
            FROM batting_stats bs
            WHERE bs.season = %s AND bs.games > 0
            GROUP BY bs.team_id
        ),
        gamelog_counts AS (
            -- Count of game_batting rows per team
            SELECT
                gb.team_id,
                COUNT(*) AS total_gamelogs,
                COUNT(DISTINCT gb.game_id) AS distinct_games
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            WHERE g.season = %s AND g.status = 'final'
            GROUP BY gb.team_id
        )
        SELECT
            t.id AS team_id,
            t.short_name,
            d.name AS division,
            sg.num_players,
            sg.max_player_games AS team_games_played,
            sg.total_player_games AS sum_season_games,
            COALESCE(gc.distinct_games, 0) AS boxscore_games,
            COALESCE(gc.total_gamelogs, 0) AS total_gamelogs,
            sg.total_player_games - COALESCE(gc.total_gamelogs, 0) AS gamelog_gap
        FROM season_games sg
        JOIN teams t ON t.id = sg.team_id
        LEFT JOIN divisions d ON d.id = t.division_id
        LEFT JOIN gamelog_counts gc ON gc.team_id = sg.team_id
        WHERE 1=1 {team_filter}
        ORDER BY (sg.total_player_games - COALESCE(gc.total_gamelogs, 0)) DESC
    """, params)

    rows = cur.fetchall()

    print(f"\n{'='*80}")
    print(f"  BOX SCORE GAP AUDIT — Season {season}")
    print(f"{'='*80}\n")
    print(f"{'Team':<20} {'Div':<8} {'Players':>8} {'TeamGP':>7} {'SeasonG':>8} {'BoxGames':>9} {'GameLogs':>9} {'Gap':>6}")
    print(f"{'-'*20} {'-'*8} {'-'*8} {'-'*7} {'-'*8} {'-'*9} {'-'*9} {'-'*6}")

    total_gap = 0
    teams_with_gaps = []
    for r in rows:
        gap = r["gamelog_gap"]
        total_gap += max(gap, 0)
        marker = " <<<" if gap > 10 else ""
        print(f"{r['short_name']:<20} {(r['division'] or '?'):<8} {r['num_players']:>8} {r['team_games_played']:>7} "
              f"{r['sum_season_games']:>8} {r['boxscore_games']:>9} {r['total_gamelogs']:>9} {gap:>6}{marker}")
        if gap > 0:
            teams_with_gaps.append(r)

    print(f"\nTotal gamelog gap across all teams: {total_gap}")
    print(f"Teams with gaps: {len(teams_with_gaps)}")

    # ── Player-level detail ──
    if show_detail:
        print(f"\n\n{'='*80}")
        print(f"  PLAYER-LEVEL GAPS (players missing 3+ game logs)")
        print(f"{'='*80}\n")

        detail_filter = ""
        detail_params = [season, season]
        if team_id:
            detail_filter = "AND bs.team_id = %s"
            detail_params.append(team_id)

        cur.execute(f"""
            SELECT
                p.id AS player_id,
                p.first_name || ' ' || p.last_name AS player_name,
                t.short_name AS team,
                bs.games AS season_games,
                COUNT(gb.id) AS gamelog_count,
                bs.games - COUNT(gb.id) AS missing
            FROM batting_stats bs
            JOIN players p ON p.id = bs.player_id
            JOIN teams t ON t.id = bs.team_id
            LEFT JOIN game_batting gb ON gb.player_id = bs.player_id
                AND gb.team_id = bs.team_id
                AND EXISTS (
                    SELECT 1 FROM games g
                    WHERE g.id = gb.game_id AND g.season = %s AND g.status = 'final'
                )
            WHERE bs.season = %s AND bs.games >= 3
            {detail_filter}
            GROUP BY p.id, p.first_name, p.last_name, t.short_name, bs.games
            HAVING bs.games - COUNT(gb.id) >= 3
            ORDER BY bs.games - COUNT(gb.id) DESC
            LIMIT 100
        """, detail_params)

        detail_rows = cur.fetchall()
        print(f"{'Player':<25} {'Team':<18} {'SeasonG':>8} {'Logs':>6} {'Missing':>8}")
        print(f"{'-'*25} {'-'*18} {'-'*8} {'-'*6} {'-'*8}")
        for r in detail_rows:
            print(f"{r['player_name']:<25} {r['team']:<18} {r['season_games']:>8} {r['gamelog_count']:>6} {r['missing']:>8}")

    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Audit box score gaps")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--team", type=int, help="Filter to a single team ID")
    parser.add_argument("--detail", action="store_true", help="Show player-level gaps")
    args = parser.parse_args()

    run_audit(args.season, args.team, args.detail)
