#!/usr/bin/env python3
"""
Fix orphan game_batting rows that have player_name but no player_id.

These rows were created when box scores were parsed but the player name
couldn't be matched to a roster player (often due to mangled names like
'bC. Rohlmeier' instead of 'C. Rohlmeier').

This script:
1. Finds all orphan batting/pitching rows (player_id IS NULL, player_name IS NOT NULL)
2. Cleans the player_name (strips parsing artifacts)
3. Matches to roster players by last name + first initial
4. Sets the player_id

Usage:
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/fix_orphan_batting.py
"""

import sys
import os
import re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection


def clean_name(raw_name):
    """Clean parsing artifacts from player names.

    Common issues:
    - Leading lowercase letter(s) from position bleed: 'bC. Rohlmeier' -> 'C. Rohlmeier'
    - Leading digits from batting order: '3C. Rohlmeier' -> 'C. Rohlmeier'
    - Extra whitespace
    """
    if not raw_name:
        return None, None

    name = raw_name.strip()

    # Strip leading lowercase letters or digits (parsing artifacts)
    name = re.sub(r'^[a-z0-9]+', '', name).strip()

    # Now parse: could be "First Last", "F. Last", "Last, First", etc.
    # Try "Last, First" format first
    if ',' in name:
        parts = name.split(',', 1)
        last = parts[0].strip()
        first = parts[1].strip()
    else:
        parts = name.split()
        if len(parts) >= 2:
            first = parts[0].strip()
            last = ' '.join(parts[1:]).strip()
        elif len(parts) == 1:
            last = parts[0].strip()
            first = ''
        else:
            return None, None

    return first, last


def match_player(first, last, roster_players):
    """Match a cleaned name to a roster player.

    Tries multiple strategies:
    1. Exact last name + first name match
    2. Exact last name + first initial match
    3. Last name only (if unique)
    """
    if not last:
        return None

    last_lower = last.lower()
    first_lower = first.lower() if first else ''
    first_initial = first_lower[0] if first_lower else ''

    # Strip period from first initial (e.g., "C." -> "c")
    first_clean = re.sub(r'\.', '', first_lower).strip()
    first_initial = first_clean[0] if first_clean else ''

    # Find candidates by last name
    candidates = [p for p in roster_players if p['last_name'].lower() == last_lower]

    if not candidates:
        # Try fuzzy: last name contains or is contained
        candidates = [p for p in roster_players
                      if last_lower in p['last_name'].lower() or p['last_name'].lower() in last_lower]

    if len(candidates) == 1:
        return candidates[0]['id']

    if len(candidates) > 1 and first_initial:
        # Narrow by first initial
        initial_matches = [p for p in candidates
                          if p['first_name'] and p['first_name'][0].lower() == first_initial]
        if len(initial_matches) == 1:
            return initial_matches[0]['id']

        # Try full first name match
        if first_clean and len(first_clean) > 1:
            full_matches = [p for p in candidates
                          if p['first_name'] and p['first_name'].lower().startswith(first_clean.rstrip('.'))]
            if len(full_matches) == 1:
                return full_matches[0]['id']

    return None


def fix_orphans_for_table(cur, table_name, team_id, roster_players):
    """Fix orphan rows in a specific table (game_batting or game_pitching)."""
    cur.execute(f"""
        SELECT DISTINCT {table_name}.id, {table_name}.player_name, {table_name}.game_id
        FROM {table_name}
        JOIN games g ON g.id = {table_name}.game_id
        WHERE {table_name}.team_id = %s
          AND {table_name}.player_id IS NULL
          AND {table_name}.player_name IS NOT NULL
          AND g.season = 2026
    """, (team_id,))
    orphans = cur.fetchall()

    if not orphans:
        return 0, 0

    matched = 0
    unmatched_names = set()

    for row in orphans:
        first, last = clean_name(row['player_name'])
        if not last:
            unmatched_names.add(row['player_name'])
            continue

        player_id = match_player(first, last, roster_players)
        if player_id:
            cur.execute(f"""
                UPDATE {table_name} SET player_id = %s
                WHERE id = %s AND player_id IS NULL
            """, (player_id, row['id']))
            matched += 1
        else:
            unmatched_names.add(f"{row['player_name']} -> {first} {last}")

    if unmatched_names:
        print(f"    Unmatched ({len(unmatched_names)}): {list(unmatched_names)[:10]}")

    return len(orphans), matched


def main():
    with get_connection() as conn:
        cur = conn.cursor()

        # Get all teams
        cur.execute("SELECT id, short_name, name FROM teams WHERE is_active = 1 ORDER BY short_name")
        teams = cur.fetchall()

        total_orphans = 0
        total_matched = 0

        for team in teams:
            team_id = team['id']
            team_name = team['short_name'] or team['name']

            # Get roster for this team
            cur.execute("""
                SELECT id, first_name, last_name FROM players
                WHERE team_id = %s
            """, (team_id,))
            roster = cur.fetchall()
            if not roster:
                continue

            # Fix batting
            bat_orphans, bat_matched = fix_orphans_for_table(cur, 'game_batting', team_id, roster)
            # Fix pitching
            pit_orphans, pit_matched = fix_orphans_for_table(cur, 'game_pitching', team_id, roster)

            if bat_orphans > 0 or pit_orphans > 0:
                print(f"  {team_name}: batting {bat_matched}/{bat_orphans} matched, pitching {pit_matched}/{pit_orphans} matched")
                total_orphans += bat_orphans + pit_orphans
                total_matched += bat_matched + pit_matched

        conn.commit()
        print(f"\nTotal: {total_matched}/{total_orphans} orphan rows matched to players")


if __name__ == "__main__":
    main()
