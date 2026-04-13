#!/usr/bin/env python3
"""
Diagnostic script to identify why conference game counts are imbalanced.

Core rule: For every team in a conference,
(conference wins + conference losses) + conference games remaining = SAME number for all teams

If this is violated, identifies which games are causing the imbalance.
"""

import json
import sqlite3
from pathlib import Path
from collections import defaultdict

# ============================================================
# Load Data
# ============================================================

db_path = Path(__file__).parent / "backend" / "data" / "pnw_baseball.db"
future_schedules_path = Path(__file__).parent / "backend" / "data" / "future_schedules.json"

# Load future schedules
print("Loading future_schedules.json...")
with open(future_schedules_path) as f:
    future_data = json.load(f)

future_games = future_data.get("games", [])
print(f"Total future games in file: {len(future_games)}")
print(f"Last updated: {future_data.get('last_updated')}")

# Load database
print("\nLoading teams from database...")
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

# Get all teams with their conference
cur.execute("""
    SELECT t.id, t.short_name, t.name, c.id as conference_id, c.name as conference_name,
           c.abbreviation as conference_abbrev, d.level as division_level
    FROM teams t
    JOIN conferences c ON t.conference_id = c.id
    JOIN divisions d ON c.division_id = d.id
    WHERE t.is_active = 1
    ORDER BY c.name, t.short_name
""")

teams = {}
for row in cur.fetchall():
    teams[row["id"]] = {
        "short_name": row["short_name"],
        "name": row["name"],
        "conference_id": row["conference_id"],
        "conference_name": row["conference_name"],
        "conference_abbrev": row["conference_abbrev"],
        "division_level": row["division_level"],
    }

# Get current season stats
cur.execute("""
    SELECT t.id, t.short_name,
           COALESCE(s.conference_wins, 0) as conf_wins,
           COALESCE(s.conference_losses, 0) as conf_losses
    FROM teams t
    LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = 2026
    WHERE t.is_active = 1
""")

current_stats = {}
for row in cur.fetchall():
    current_stats[row["id"]] = {
        "conf_wins": row["conf_wins"],
        "conf_losses": row["conf_losses"],
    }

conn.close()

print(f"Total active teams: {len(teams)}")

# ============================================================
# Analyze Conference Games
# ============================================================

print("\n" + "="*80)
print("ANALYZING CONFERENCE GAMES")
print("="*80)

# Build team name -> id lookup
name_to_id = {}
for tid, team_info in teams.items():
    name_to_id[team_info["short_name"]] = tid

# Group teams by conference
conf_teams = defaultdict(list)
for tid, team_info in teams.items():
    conf_name = team_info["conference_name"]
    conf_teams[conf_name].append(tid)

# For each conference, analyze games
for conf_name in sorted(conf_teams.keys()):
    team_ids = conf_teams[conf_name]
    print(f"\n{'='*80}")
    print(f"CONFERENCE: {conf_name}")
    print(f"{'='*80}")
    print(f"Teams ({len(team_ids)}):")
    for tid in sorted(team_ids):
        team = teams[tid]
        stats = current_stats[tid]
        print(f"  - {team['short_name']:15} (ID: {tid})")

    # Count conference games remaining for each team
    conf_games_remaining = defaultdict(int)
    conf_games_list = defaultdict(list)  # team_id -> list of games

    for game in future_games:
        home_id = game.get("home_team_id")
        away_id = game.get("away_team_id")
        is_conf = game.get("is_conference", False)

        if not is_conf:
            continue

        # Resolve by name if IDs missing
        if not home_id:
            home_id = name_to_id.get(game.get("home_team"))
        if not away_id:
            away_id = name_to_id.get(game.get("away_team"))

        # Both teams must be in this conference
        home_in_conf = home_id in team_ids if home_id else False
        away_in_conf = away_id in team_ids if away_id else False

        if not (home_in_conf and away_in_conf):
            continue

        # This is a conference game for this conference
        if home_id:
            conf_games_remaining[home_id] += 1
            conf_games_list[home_id].append({
                "game_date": game["game_date"],
                "opponent": teams[away_id]["short_name"] if away_id in teams else game["away_team"],
                "home": True,
            })
        if away_id:
            conf_games_remaining[away_id] += 1
            conf_games_list[away_id].append({
                "game_date": game["game_date"],
                "opponent": teams[home_id]["short_name"] if home_id in teams else game["home_team"],
                "home": False,
            })

    # Report on this conference
    print(f"\nConference games remaining analysis:")
    if not conf_games_remaining:
        print("  NO CONFERENCE GAMES FOUND in future_schedules.json")
    else:
        # Find min and max
        remaining_counts = sorted(conf_games_remaining.values())
        min_games = min(remaining_counts)
        max_games = max(remaining_counts)

        if min_games == max_games:
            print(f"  BALANCED: All teams have {min_games} conference games remaining")
        else:
            print(f"  IMBALANCED: Teams have {min_games} to {max_games} games (DIFF: {max_games - min_games})")

        # Detail by team
        print(f"\n  Details:")
        for tid in sorted(team_ids):
            stats = current_stats[tid]
            team_info = teams[tid]
            conf_w = stats["conf_wins"]
            conf_l = stats["conf_losses"]
            games_rem = conf_games_remaining.get(tid, 0)
            total = conf_w + conf_l + games_rem

            status = "OK" if games_rem == min_games else "IMBALANCED"
            print(f"    {team_info['short_name']:15} | W:{conf_w:2} L:{conf_l:2} Rem:{games_rem:2} | Total:{total:2} | {status}")

        # If imbalanced, show which games are causing it
        if min_games != max_games:
            print(f"\n  Teams with fewer games ({min_games}):")
            for tid in sorted(team_ids):
                games_rem = conf_games_remaining.get(tid, 0)
                if games_rem == min_games:
                    team_info = teams[tid]
                    print(f"    - {team_info['short_name']}")

            print(f"\n  Teams with more games ({max_games}):")
            for tid in sorted(team_ids):
                games_rem = conf_games_remaining.get(tid, 0)
                if games_rem == max_games:
                    team_info = teams[tid]
                    print(f"    - {team_info['short_name']}")

            # List the extra games
            print(f"\n  Extra games (causing imbalance):")
            imbalance_games = []
            for game in future_games:
                home_id = game.get("home_team_id") or name_to_id.get(game.get("home_team"))
                away_id = game.get("away_team_id") or name_to_id.get(game.get("away_team"))
                is_conf = game.get("is_conference", False)

                if not is_conf:
                    continue

                home_in_conf = home_id in team_ids if home_id else False
                away_in_conf = away_id in team_ids if away_id else False

                if not (home_in_conf and away_in_conf):
                    continue

                # Check if either team has max games (is in the group with imbalance)
                home_games = conf_games_remaining.get(home_id, 0)
                away_games = conf_games_remaining.get(away_id, 0)

                if home_games > min_games or away_games > min_games:
                    imbalance_games.append({
                        "date": game["game_date"],
                        "home": (teams[home_id]["short_name"] if home_id in teams else game["home_team"]),
                        "away": (teams[away_id]["short_name"] if away_id in teams else game["away_team"]),
                        "home_id": home_id,
                        "away_id": away_id,
                        "home_games_rem": home_games,
                        "away_games_rem": away_games,
                    })

            # Sort by date
            imbalance_games.sort(key=lambda x: x["date"])

            for g in imbalance_games:
                print(f"    {g['date']} | {g['away']:15} @ {g['home']:15} | " +
                      f"{g['away']} has {g['away_games_rem']} games, {g['home']} has {g['home_games_rem']} games")

print("\n" + "="*80)
print("SUMMARY")
print("="*80)

# Check all conferences
imbalanced_conferences = []
for conf_name in sorted(conf_teams.keys()):
    team_ids = conf_teams[conf_name]
    conf_games_remaining = {}

    for game in future_games:
        home_id = game.get("home_team_id") or name_to_id.get(game.get("home_team"))
        away_id = game.get("away_team_id") or name_to_id.get(game.get("away_team"))
        is_conf = game.get("is_conference", False)

        if not is_conf:
            continue

        home_in_conf = home_id in team_ids if home_id else False
        away_in_conf = away_id in team_ids if away_id else False

        if not (home_in_conf and away_in_conf):
            continue

        conf_games_remaining[home_id] = conf_games_remaining.get(home_id, 0) + 1
        conf_games_remaining[away_id] = conf_games_remaining.get(away_id, 0) + 1

    if conf_games_remaining:
        counts = list(conf_games_remaining.values())
        if min(counts) != max(counts):
            imbalanced_conferences.append((conf_name, min(counts), max(counts)))

if imbalanced_conferences:
    print("IMBALANCED CONFERENCES:")
    for conf_name, min_games, max_games in imbalanced_conferences:
        print(f"  - {conf_name}: {min_games} to {max_games} games (diff: {max_games - min_games})")
else:
    print("All conferences have balanced conference game counts!")

print(f"\nDatabase path: {db_path}")
print(f"Future schedules path: {future_schedules_path}")
