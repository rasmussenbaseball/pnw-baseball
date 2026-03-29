#!/usr/bin/env python3
"""Quick check of quality_starts data."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection

with get_connection() as conn:
    cur = conn.cursor()

    # Check pitching_stats quality_starts values
    cur.execute("""
        SELECT ps.quality_starts, COUNT(*) as cnt
        FROM pitching_stats ps
        WHERE ps.season = 2026
        GROUP BY ps.quality_starts
        ORDER BY ps.quality_starts DESC
    """)
    print("pitching_stats.quality_starts distribution (2026):")
    for row in cur.fetchall():
        print(f"  QS={row['quality_starts']}: {row['cnt']} players")

    # Check game_pitching player_id status
    cur.execute("SELECT COUNT(*) as cnt FROM game_pitching WHERE player_id IS NOT NULL")
    matched = cur.fetchone()["cnt"]
    cur.execute("SELECT COUNT(*) as cnt FROM game_pitching WHERE player_id IS NULL")
    unmatched = cur.fetchone()["cnt"]
    print(f"\ngame_pitching player_id: {matched} matched, {unmatched} unmatched")

    # Check game_pitching is_quality_start counts
    cur.execute("""
        SELECT gp.player_id, p.first_name, p.last_name,
               COUNT(*) FILTER (WHERE gp.is_quality_start = TRUE) as qs_count
        FROM game_pitching gp
        JOIN players p ON gp.player_id = p.id
        GROUP BY gp.player_id, p.first_name, p.last_name
        HAVING COUNT(*) FILTER (WHERE gp.is_quality_start = TRUE) > 0
        ORDER BY qs_count DESC
        LIMIT 10
    """)
    print("\nTop QS from game_pitching (matched players):")
    for row in cur.fetchall():
        print(f"  {row['first_name']} {row['last_name']}: {row['qs_count']} QS")

    # Check Coxen specifically
    cur.execute("""
        SELECT gp.player_name, gp.player_id, gp.is_quality_start, gp.innings_pitched, gp.earned_runs
        FROM game_pitching gp
        WHERE gp.player_name ILIKE '%coxen%'
    """)
    print("\nCoxen game_pitching entries:")
    for row in cur.fetchall():
        print(f"  name={row['player_name']}, pid={row['player_id']}, qs={row['is_quality_start']}, ip={row['innings_pitched']}, er={row['earned_runs']}")
