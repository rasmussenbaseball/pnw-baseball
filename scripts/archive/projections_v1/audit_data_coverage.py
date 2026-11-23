"""Data coverage audit for the player projections project.

Read-only. Answers: how much multi-season history, transfer pairs,
summer<->spring overlap, bio completeness, and PBP coverage do we
actually have to train a projection model on?

Run from repo root:  PYTHONPATH=backend python3 scripts/projections/audit_data_coverage.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "backend"))
from app.models.database import get_connection  # noqa: E402

MIN_PA = 50   # minimum PA for a batting season to count as a usable sample
MIN_BF = 50   # minimum batters faced for a pitching season


def section(title):
    print(f"\n{'=' * 70}\n{title}\n{'=' * 70}")


def run(cur, label, sql, params=None):
    cur.execute(sql, params or ())
    rows = cur.fetchall()
    print(f"\n--- {label} ---")
    for r in rows:
        print("  " + " | ".join(f"{k}={v}" for k, v in r.items()))
    return rows


# Canonical-id CTE: collapse linked (transfer) player records onto one id.
CANON = """
canon AS (
    SELECT linked_id AS player_id, canonical_id FROM player_links
),
bs AS (
    SELECT COALESCE(c.canonical_id, b.player_id) AS pid,
           b.season, b.plate_appearances AS pa, b.team_id,
           d.level
    FROM batting_stats b
    JOIN teams t ON t.id = b.team_id
    JOIN conferences cf ON cf.id = t.conference_id
    JOIN divisions d ON d.id = cf.division_id
    LEFT JOIN canon c ON c.player_id = b.player_id
),
ps AS (
    SELECT COALESCE(c.canonical_id, p.player_id) AS pid,
           p.season, p.batters_faced AS bf, p.team_id,
           d.level
    FROM pitching_stats p
    JOIN teams t ON t.id = p.team_id
    JOIN conferences cf ON cf.id = t.conference_id
    JOIN divisions d ON d.id = cf.division_id
    LEFT JOIN canon c ON c.player_id = p.player_id
)
"""


def main():
    with get_connection() as conn:
        cur = conn.cursor()

        section("1. SEASON COVERAGE BY DIVISION (batting)")
        run(cur, f"player-seasons with PA >= {MIN_PA}", f"""
            WITH {CANON}
            SELECT level, season, COUNT(*) AS n_seasons,
                   COUNT(DISTINCT pid) AS n_players,
                   ROUND(AVG(pa)) AS avg_pa
            FROM bs WHERE pa >= %s
            GROUP BY level, season ORDER BY level, season""", (MIN_PA,))

        section("2. SEASON COVERAGE BY DIVISION (pitching)")
        run(cur, f"player-seasons with BF >= {MIN_BF}", f"""
            WITH {CANON}
            SELECT level, season, COUNT(*) AS n_seasons,
                   COUNT(DISTINCT pid) AS n_players,
                   ROUND(AVG(bf)) AS avg_bf
            FROM ps WHERE bf >= %s
            GROUP BY level, season ORDER BY level, season""", (MIN_BF,))

        section("3. YEAR-OVER-YEAR PAIRS (the training set)")
        run(cur, "consecutive-season batting pairs, same division", f"""
            WITH {CANON}
            SELECT a.level, a.season AS yr1, COUNT(*) AS pairs
            FROM bs a JOIN bs b
              ON a.pid = b.pid AND b.season = a.season + 1 AND a.level = b.level
            WHERE a.pa >= %s AND b.pa >= %s
            GROUP BY a.level, a.season ORDER BY a.level, a.season""", (MIN_PA, MIN_PA))
        run(cur, "consecutive-season pitching pairs, same division", f"""
            WITH {CANON}
            SELECT a.level, a.season AS yr1, COUNT(*) AS pairs
            FROM ps a JOIN ps b
              ON a.pid = b.pid AND b.season = a.season + 1 AND a.level = b.level
            WHERE a.bf >= %s AND b.bf >= %s
            GROUP BY a.level, a.season ORDER BY a.level, a.season""", (MIN_BF, MIN_BF))

        section("4. CROSS-DIVISION TRANSFER PAIRS (level translation data)")
        run(cur, "batting: div A year N -> div B year N+1", f"""
            WITH {CANON}
            SELECT a.level AS from_div, b.level AS to_div, COUNT(*) AS pairs,
                   ROUND(AVG(a.pa)) AS avg_pa_before, ROUND(AVG(b.pa)) AS avg_pa_after
            FROM bs a JOIN bs b
              ON a.pid = b.pid AND b.season = a.season + 1 AND a.level <> b.level
            WHERE a.pa >= %s AND b.pa >= %s
            GROUP BY a.level, b.level ORDER BY pairs DESC""", (MIN_PA, MIN_PA))
        run(cur, "pitching: div A year N -> div B year N+1", f"""
            WITH {CANON}
            SELECT a.level AS from_div, b.level AS to_div, COUNT(*) AS pairs
            FROM ps a JOIN ps b
              ON a.pid = b.pid AND b.season = a.season + 1 AND a.level <> b.level
            WHERE a.bf >= %s AND b.bf >= %s
            GROUP BY a.level, b.level ORDER BY pairs DESC""", (MIN_BF, MIN_BF))

        section("5. SUMMER <-> SPRING OVERLAP")
        run(cur, "linked summer players with usable stats both places", """
            SELECT sb.season AS summer_season, COUNT(*) AS n_links,
                   COUNT(*) FILTER (WHERE sb.plate_appearances >= 50) AS summer_pa50,
                   COUNT(*) FILTER (WHERE sb.plate_appearances >= 50
                                    AND b.plate_appearances >= 50) AS both_pa50
            FROM summer_player_links l
            JOIN summer_batting_stats sb ON sb.player_id = l.summer_player_id
            LEFT JOIN batting_stats b
              ON b.player_id = l.spring_player_id AND b.season = sb.season + 1
            GROUP BY sb.season ORDER BY sb.season""")
        run(cur, "summer pitching links", """
            SELECT sp.season AS summer_season, COUNT(*) AS n_links,
                   COUNT(*) FILTER (WHERE sp.batters_faced >= 50
                                    AND p.batters_faced >= 50) AS both_bf50
            FROM summer_player_links l
            JOIN summer_pitching_stats sp ON sp.player_id = l.summer_player_id
            LEFT JOIN pitching_stats p
              ON p.player_id = l.spring_player_id AND p.season = sp.season + 1
            GROUP BY sp.season ORDER BY sp.season""")

        section("6. BIO DATA FILL RATES (players with a 2026 stat line)")
        run(cur, "non-null %, batting 2026 PA>=50", """
            SELECT d.level,
                   COUNT(*) AS n,
                   ROUND(100.0 * COUNT(p.height) / COUNT(*)) AS height_pct,
                   ROUND(100.0 * COUNT(p.weight) / COUNT(*)) AS weight_pct,
                   ROUND(100.0 * COUNT(p.bats) / COUNT(*)) AS bats_pct,
                   ROUND(100.0 * COUNT(p.throws) / COUNT(*)) AS throws_pct,
                   ROUND(100.0 * COUNT(p.year_in_school) / COUNT(*)) AS class_pct
            FROM batting_stats b
            JOIN players p ON p.id = b.player_id
            JOIN teams t ON t.id = b.team_id
            JOIN conferences cf ON cf.id = t.conference_id
            JOIN divisions d ON d.id = cf.division_id
            WHERE b.season = 2026 AND b.plate_appearances >= 50
            GROUP BY d.level ORDER BY d.level""")
        run(cur, "player_seasons class-year history coverage", """
            SELECT season, COUNT(*) AS rows,
                   COUNT(*) FILTER (WHERE year_in_school IS NOT NULL) AS with_class
            FROM player_seasons GROUP BY season ORDER BY season""")

        section("7. PBP COVERAGE (game_events)")
        run(cur, "events by season", """
            SELECT g.season, COUNT(*) AS events,
                   ROUND(100.0 * COUNT(e.bb_type) /
                       NULLIF(COUNT(*) FILTER (WHERE e.was_in_play), 0)) AS bb_type_pct_of_bip,
                   COUNT(DISTINCT e.batter_player_id) AS batters,
                   COUNT(DISTINCT e.pitcher_player_id) AS pitchers
            FROM game_events e JOIN games g ON g.id = e.game_id
            GROUP BY g.season ORDER BY g.season""")
        run(cur, "summer events by season", """
            SELECT g.season, COUNT(*) AS events,
                   COUNT(DISTINCT e.batter_player_id) AS batters
            FROM summer_game_events e JOIN summer_games g ON g.id = e.game_id
            GROUP BY g.season ORDER BY g.season""")


if __name__ == "__main__":
    main()
