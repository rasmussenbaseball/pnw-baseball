"""
Backfill team_season_stats from the games table and player stats.

For every team + season that has games or player stats but no team_season_stats row,
compute W-L (overall and conference) and insert.

Usage (Mac or server):
    cd ~/pnw-baseball   (or /opt/pnw-baseball on server)
    PYTHONPATH=backend python3 scripts/backfill_team_records.py
"""

import logging
from app.models.database import get_connection

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)


def main():
    with get_connection() as conn:
        cur = conn.cursor()
        inserted = 0

        # ── Step 1: Backfill from games table ──
        cur.execute("""
            WITH game_teams AS (
                SELECT home_team_id AS team_id, season FROM games
                WHERE home_score IS NOT NULL AND away_score IS NOT NULL
                UNION
                SELECT away_team_id AS team_id, season FROM games
                WHERE home_score IS NOT NULL AND away_score IS NOT NULL
                  AND away_team_id IS NOT NULL
            ),
            existing AS (
                SELECT team_id, season FROM team_season_stats
            )
            SELECT DISTINCT gt.team_id, gt.season
            FROM game_teams gt
            LEFT JOIN existing e ON e.team_id = gt.team_id AND e.season = gt.season
            WHERE e.team_id IS NULL
              AND gt.team_id IS NOT NULL
            ORDER BY gt.team_id, gt.season
        """)
        missing_games = cur.fetchall()
        log.info(f"Step 1: {len(missing_games)} team+season combos with games but no records")

        for row in missing_games:
            tid = row["team_id"]
            season = row["season"]

            cur.execute("""
                SELECT
                    COUNT(*) FILTER (WHERE
                        (home_team_id = %s AND home_score > away_score) OR
                        (away_team_id = %s AND away_score > home_score)
                    ) AS wins,
                    COUNT(*) FILTER (WHERE
                        (home_team_id = %s AND home_score < away_score) OR
                        (away_team_id = %s AND away_score < home_score)
                    ) AS losses,
                    COUNT(*) FILTER (WHERE
                        is_conference_game = true AND (
                            (home_team_id = %s AND home_score > away_score) OR
                            (away_team_id = %s AND away_score > home_score)
                        )
                    ) AS conf_wins,
                    COUNT(*) FILTER (WHERE
                        is_conference_game = true AND (
                            (home_team_id = %s AND home_score < away_score) OR
                            (away_team_id = %s AND away_score < home_score)
                        )
                    ) AS conf_losses
                FROM games
                WHERE (home_team_id = %s OR away_team_id = %s)
                  AND season = %s
                  AND home_score IS NOT NULL
                  AND away_score IS NOT NULL
            """, (tid, tid, tid, tid, tid, tid, tid, tid, tid, tid, season))
            stats = cur.fetchone()

            w, l = stats["wins"], stats["losses"]
            cw, cl = stats["conf_wins"], stats["conf_losses"]

            if w == 0 and l == 0:
                continue

            cur.execute("SELECT short_name FROM teams WHERE id = %s", (tid,))
            name = (cur.fetchone() or {}).get("short_name", f"ID {tid}")

            cur.execute("""
                INSERT INTO team_season_stats (team_id, season, wins, losses, conference_wins, conference_losses)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT(team_id, season) DO NOTHING
            """, (tid, season, w, l, cw, cl))
            log.info(f"  {name} {season}: {w}-{l} (Conf: {cw}-{cl})")
            inserted += 1

        conn.commit()
        log.info(f"Step 1 done: inserted {inserted} rows from games\n")

        # ── Step 2: Backfill from player stats (pitching W-L) ──
        cur.execute("""
            WITH player_seasons AS (
                SELECT DISTINCT team_id, season FROM batting_stats
                UNION
                SELECT DISTINCT team_id, season FROM pitching_stats
            ),
            existing AS (
                SELECT team_id, season FROM team_season_stats
            )
            SELECT ps.team_id, ps.season, t.short_name
            FROM player_seasons ps
            JOIN teams t ON t.id = ps.team_id
            LEFT JOIN existing e ON e.team_id = ps.team_id AND e.season = ps.season
            WHERE e.team_id IS NULL
            ORDER BY t.short_name, ps.season
        """)
        still_missing = cur.fetchall()
        log.info(f"Step 2: {len(still_missing)} team+season combos have player stats but no records")

        if still_missing:
            for r in still_missing:
                log.info(f"  {r['short_name']} {r['season']}")

            log.info("\nComputing records from pitching wins/losses...")
            inserted2 = 0
            for r in still_missing:
                tid = r["team_id"]
                season = r["season"]
                cur.execute("""
                    SELECT COALESCE(SUM(wins), 0) AS w, COALESCE(SUM(losses), 0) AS l
                    FROM pitching_stats
                    WHERE team_id = %s AND season = %s
                """, (tid, season))
                p = cur.fetchone()
                w, l_val = p["w"], p["l"]
                if w == 0 and l_val == 0:
                    continue
                cur.execute("""
                    INSERT INTO team_season_stats (team_id, season, wins, losses)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT(team_id, season) DO NOTHING
                """, (tid, season, w, l_val))
                log.info(f"  {r['short_name']} {season}: {w}-{l_val} (from pitching stats)")
                inserted2 += 1
            conn.commit()
            log.info(f"Step 2 done: inserted {inserted2} rows from pitching stats")
        else:
            log.info("No additional gaps found.")


if __name__ == "__main__":
    main()
