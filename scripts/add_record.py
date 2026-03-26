#!/usr/bin/env python3
"""
Manually add/update a team's W-L record.

Usage:
    python3 scripts/add_record.py --team "Oregon" --record 23-5 --conf 12-3
    python3 scripts/add_record.py --team "UW" --record 18-8
    python3 scripts/add_record.py --list          # show all current records
    python3 scripts/add_record.py --missing        # show teams without records
"""

import argparse
import re
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "backend" / "data" / "pnw_baseball.db"


def parse_record(s):
    m = re.match(r'(\d+)-(\d+)', s.strip())
    return (int(m.group(1)), int(m.group(2))) if m else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--team", type=str, help="Team short_name (e.g. 'Oregon', 'UW', 'GFU')")
    parser.add_argument("--record", type=str, help="Overall record (e.g. '23-5')")
    parser.add_argument("--conf", type=str, default="0-0", help="Conference record (e.g. '12-3')")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--list", action="store_true", help="List all current records")
    parser.add_argument("--missing", action="store_true", help="List teams without records")
    args = parser.parse_args()

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    if args.list:
        rows = conn.execute("""
            SELECT t.short_name, tss.wins, tss.losses, tss.conference_wins, tss.conference_losses
            FROM team_season_stats tss JOIN teams t ON tss.team_id = t.id
            WHERE tss.season = ? ORDER BY t.short_name
        """, (args.season,)).fetchall()
        print(f"\n{len(rows)} teams with {args.season} records:\n")
        for r in rows:
            conf = f" ({r['conference_wins']}-{r['conference_losses']})" if r['conference_wins'] or r['conference_losses'] else ""
            print(f"  {r['short_name']:20s} {r['wins']}-{r['losses']}{conf}")
        conn.close()
        return

    if args.missing:
        rows = conn.execute("""
            SELECT t.short_name, t.name, d.name as div
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.is_active = 1
              AND t.id NOT IN (SELECT team_id FROM team_season_stats WHERE season = ?)
            ORDER BY d.id, t.short_name
        """, (args.season,)).fetchall()
        print(f"\n{len(rows)} teams missing {args.season} records:\n")
        for r in rows:
            print(f"  {r['short_name']:20s} {r['name']:35s} {r['div']}")
        conn.close()
        return

    if not args.team or not args.record:
        parser.print_help()
        return

    overall = parse_record(args.record)
    conf = parse_record(args.conf)
    if not overall:
        print(f"Invalid record format: {args.record}")
        return

    # Find team
    team = conn.execute(
        "SELECT id, short_name, name FROM teams WHERE short_name = ? OR name LIKE ?",
        (args.team, f"%{args.team}%")
    ).fetchone()

    if not team:
        print(f"Team not found: {args.team}")
        print("Use --missing to see valid team names.")
        return

    w, l = overall
    cw, cl = conf or (0, 0)

    conn.execute("""
        INSERT INTO team_season_stats (team_id, season, wins, losses, conference_wins, conference_losses)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(team_id, season) DO UPDATE SET
            wins=excluded.wins, losses=excluded.losses,
            conference_wins=excluded.conference_wins, conference_losses=excluded.conference_losses
    """, (team["id"], args.season, w, l, cw, cl))
    conn.commit()
    conn.close()
    print(f"Saved: {team['short_name']} ({team['name']}) — {w}-{l} ({cw}-{cl})")


if __name__ == "__main__":
    main()
