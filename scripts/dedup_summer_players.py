"""Merge duplicate summer_players rows (same name + same team).

Re-scrapes created multiple rows for the same WCL/PIL player on a team (e.g.
Cooper Mullens x2 on the Drifters), splitting stats across them. For each
(lower(first), lower(last), team_id) group with >1 row, pick ONE canonical row
and repoint every child row (season stats, game lines, events, fielding,
trackman, link, portal) onto it, then delete the extras.

Canonical pick: linked-to-spring first, then most child rows, then lowest id
(oldest / original).

Usage:
    PYTHONPATH=backend python3 scripts/dedup_summer_players.py            # dry run
    PYTHONPATH=backend python3 scripts/dedup_summer_players.py --commit   # execute
"""
import sys
from collections import defaultdict
from app.models.database import get_connection

COMMIT = "--commit" in sys.argv

# child tables that reference summer_players.id by a single player column
REPOINT = [
    ("summer_game_batting", "player_id"),
    ("summer_game_pitching", "player_id"),
    ("summer_game_events", "batter_player_id"),
    ("summer_game_events", "pitcher_player_id"),
    ("trackman_pitches", "summer_player_id"),
]
# unique stat tables: drop dup rows that would collide with canonical on the
# listed key, then repoint the rest.
UNIQUE_STATS = [
    ("summer_batting_stats", "team_id, season"),
    ("summer_pitching_stats", "team_id, season"),
    ("summer_fielding_stats", "team_id, season, COALESCE(position, '')"),
]


def main():
    with get_connection() as conn:
        _run(conn)


def _run(conn):
    cur = conn.cursor()

    cur.execute("""
        SELECT lower(trim(first_name)) fn, lower(trim(last_name)) ln, team_id,
               array_agg(id ORDER BY id) ids
        FROM summer_players
        GROUP BY 1,2,3 HAVING COUNT(*) > 1
    """)
    groups = cur.fetchall()

    # child-row counts + linked flag for canonical scoring
    all_ids = [i for g in groups for i in g["ids"]]
    counts = defaultdict(int)
    linked = set()
    for tbl, col in REPOINT + [(t, "player_id") for t, _ in UNIQUE_STATS]:
        cur.execute(f"SELECT {col} pid, COUNT(*) n FROM {tbl} WHERE {col} = ANY(%s) GROUP BY 1", (all_ids,))
        for r in cur.fetchall():
            counts[r["pid"]] += r["n"]
    cur.execute("SELECT summer_player_id pid FROM summer_player_links WHERE summer_player_id = ANY(%s)", (all_ids,))
    for r in cur.fetchall():
        linked.add(r["pid"])

    merged_groups = 0
    deleted_rows = 0
    repointed = 0
    for g in groups:
        ids = g["ids"]
        # canonical: linked desc, child-count desc, id asc
        canon = sorted(ids, key=lambda i: (i not in linked, -counts[i], i))[0]
        dups = [i for i in ids if i != canon]
        merged_groups += 1
        for d in dups:
            # Backfill any field the canonical row is missing from the dup (the
            # roster scrape and the stats scrape often populate different fields).
            cur.execute(
                """UPDATE summer_players cn SET
                       position        = COALESCE(NULLIF(cn.position, ''), dp.position),
                       year_in_school  = COALESCE(NULLIF(cn.year_in_school, ''), dp.year_in_school),
                       jersey_number   = COALESCE(NULLIF(cn.jersey_number, ''), dp.jersey_number),
                       hometown        = COALESCE(NULLIF(cn.hometown, ''), dp.hometown),
                       college         = COALESCE(NULLIF(cn.college, ''), dp.college),
                       bats            = COALESCE(NULLIF(cn.bats, ''), dp.bats),
                       throws          = COALESCE(NULLIF(cn.throws, ''), dp.throws),
                       headshot_url    = COALESCE(NULLIF(cn.headshot_url, ''), dp.headshot_url),
                       assigned_school = COALESCE(cn.assigned_school, dp.assigned_school),
                       assigned_school_team_id = COALESCE(cn.assigned_school_team_id, dp.assigned_school_team_id)
                   FROM summer_players dp
                   WHERE cn.id = %s AND dp.id = %s""",
                (canon, d),
            )
            # season-unique stat tables: delete colliding dup rows, repoint rest
            for tbl, keys in UNIQUE_STATS:
                cur.execute(
                    f"""DELETE FROM {tbl} WHERE player_id = %s
                        AND ({keys}) IN (SELECT {keys} FROM {tbl} WHERE player_id = %s)""",
                    (d, canon),
                )
                cur.execute(f"UPDATE {tbl} SET player_id = %s WHERE player_id = %s", (canon, d))
                repointed += cur.rowcount
            for tbl, col in REPOINT:
                cur.execute(f"UPDATE {tbl} SET {col} = %s WHERE {col} = %s", (canon, d))
                repointed += cur.rowcount
            # link: keep canonical's; else move dup's onto canonical
            cur.execute("SELECT 1 FROM summer_player_links WHERE summer_player_id = %s", (canon,))
            if cur.fetchone():
                cur.execute("DELETE FROM summer_player_links WHERE summer_player_id = %s", (d,))
            else:
                cur.execute("UPDATE summer_player_links SET summer_player_id = %s WHERE summer_player_id = %s", (canon, d))
            # WCL portal membership
            cur.execute("SELECT 1 FROM wcl_portal_members WHERE summer_player_id = %s", (canon,))
            if cur.fetchone():
                cur.execute("DELETE FROM wcl_portal_members WHERE summer_player_id = %s", (d,))
            else:
                cur.execute("UPDATE wcl_portal_members SET summer_player_id = %s WHERE summer_player_id = %s", (canon, d))
            cur.execute("DELETE FROM summer_players WHERE id = %s", (d,))
            deleted_rows += 1

    print(f"groups merged: {merged_groups}")
    print(f"duplicate player rows deleted: {deleted_rows}")
    print(f"child rows repointed: {repointed}")
    if COMMIT:
        conn.commit()
        print("COMMITTED")
    else:
        conn.rollback()
        print("DRY RUN (rolled back) — re-run with --commit to apply")


if __name__ == "__main__":
    main()
