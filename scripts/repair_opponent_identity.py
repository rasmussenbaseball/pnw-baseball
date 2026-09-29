#!/usr/bin/env python3
"""
One-off repair (2026-09-29): opponent-identity corruption in the games table.

Findings (see CLAUDE.md "Opponent identity" gotcha and scripts/merge_teams.py):

  A. Bare opponent names fuzzy-matched a LONGER school
       "Texas"   (Oregon, NCAA regional June 2026)  -> OOC row "Texas Tech"
       "Hawaii"  (Gonzaga Feb 2026, OSU Apr 2026)   -> "Hawaii Pacific"
       "LSU"     (OSU, June 2023 regional)          -> "LSU Shreveport"
       "Arizona" (Oregon/OSU/WSU 2023-2026, 22 g)   -> "Arizona State"
       "Ottawa University (Kan.)" (UBC 2026)        -> "Ottawa University Arizona"
       "Concordia (Mich.)" (LCSC 2023 NAIA WS)      -> "Concordia Texas"
     Oregon's site later served the Texas game under a second slug
     ("university-of-texas"), the resolver made a second OOC row, and the
     same game was inserted twice (games 8129 + 10271) -> every Oregon
     pitcher double-counted in box-score sums.

  B. Seattle U's WMT scraper resolved "Pacific" without a division hint,
     so the March 2026 WCC series (games 3630-3632) is filed under D3
     Pacific University (17) instead of University of the Pacific (32857).
     The box-score rows exist under BOTH ids.

  C. 68 "ghost" box-score rows in 2026 (team_id not in the game): stale
     copies left by an old name-only player match in backfill_player_ids.py.
     Every one has a correct twin row under the right team.

  D. ~40 OOC placeholder rows that are spelling variants of one school
     ("Cal State Monterey Bay" x4, "2-seed Portland", "BYU"/"Brigham
     Young", ...), including NCAA-regional "N-seed" rows that shadow REAL
     PNW teams (Portland, CWU, MSUB, WOU).

Everything runs in one transaction. Default is a dry run (executes, logs,
rolls back). Re-runnable: each step checks for the state it fixes.

    PYTHONPATH=backend python3 scripts/repair_opponent_identity.py            # dry run
    PYTHONPATH=backend python3 scripts/repair_opponent_identity.py --apply
    then: python3 scripts/dedup_games.py --season 2026 (and 2023-2025)
"""
import argparse
import logging
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.models.database import get_connection  # noqa: E402
from merge_teams import (  # noqa: E402
    repoint_games, fix_players_after_repoint, merge_team, rename_team,
    create_ooc_team, team_row, CHILD_TABLES,
)

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("repair")


def games_by_slug(cur, slug, wrong_tid):
    """Sidearm games whose opponent slug is `slug` and whose side is wrong_tid."""
    cur.execute(
        """SELECT id FROM games
           WHERE source_url ~ %s AND %s IN (home_team_id, away_team_id)
           ORDER BY game_date, id""",
        (f"/stats/[^/]+/{re.escape(slug)}/boxscore/", wrong_tid),
    )
    return [r["id"] for r in cur.fetchall()]


def repoint_slug(cur, slug, wrong_tid, right_tid, label):
    ids = games_by_slug(cur, slug, wrong_tid)
    log.info(f"\n[{label}] slug '{slug}': {len(ids)} games {wrong_tid} -> {right_tid}: {ids}")
    if not ids:
        return
    st = repoint_games(cur, ids, wrong_tid, right_tid)
    st.update(fix_players_after_repoint(cur, ids, wrong_tid, right_tid))
    log.info(f"  {st}")


def find_or_create(cur, name, school, short):
    cur.execute("SELECT id FROM teams WHERE LOWER(name) = LOWER(%s) OR LOWER(short_name) = LOWER(%s)",
                (name, short))
    r = cur.fetchone()
    if r:
        log.info(f"  team '{name}' already exists: {r['id']}")
        return r["id"]
    return create_ooc_team(cur, name, school, short)


def delete_ghost_rows(cur):
    """Rows whose team_id is not one of the game's teams AND that have a
    same-name twin under a valid team: pure leftovers, delete."""
    total = 0
    for tbl in ("game_batting", "game_pitching"):
        cur.execute(
            f"""
            DELETE FROM {tbl} x
            USING games g
            WHERE g.id = x.game_id
              AND x.team_id NOT IN (g.home_team_id, g.away_team_id)
              AND EXISTS (
                  SELECT 1 FROM {tbl} y
                  WHERE y.game_id = x.game_id AND y.id <> x.id
                    AND LOWER(y.player_name) = LOWER(x.player_name)
                    AND y.team_id IN (g.home_team_id, g.away_team_id)
              )
            """
        )
        log.info(f"  {tbl}: deleted {cur.rowcount} ghost rows with a valid twin")
        total += cur.rowcount
    cur.execute(
        """
        DELETE FROM game_fielding x
        USING games g
        WHERE g.id = x.game_id
          AND x.team_id NOT IN (g.home_team_id, g.away_team_id)
          AND EXISTS (SELECT 1 FROM game_fielding y
                      WHERE y.game_id = x.game_id AND y.id <> x.id
                        AND y.player_id = x.player_id
                        AND y.team_id IN (g.home_team_id, g.away_team_id))
        """
    )
    log.info(f"  game_fielding: deleted {cur.rowcount} ghost rows with a valid twin")
    total += cur.rowcount
    # A fielding ghost with no twin is a wrong player link (the row's player
    # belongs to a third team); the per-game fielding line is unrecoverable
    # from here, so drop it rather than leave a row no query can use.
    cur.execute(
        """DELETE FROM game_fielding x USING games g
           WHERE g.id = x.game_id AND x.team_id NOT IN (g.home_team_id, g.away_team_id)"""
    )
    log.info(f"  game_fielding: deleted {cur.rowcount} twin-less ghost rows")
    total += cur.rowcount
    return total


def ghost_report(cur):
    for tbl in ("game_batting", "game_pitching", "game_fielding"):
        cur.execute(
            f"""SELECT g.season, COUNT(*) AS c FROM {tbl} x JOIN games g ON g.id = x.game_id
                WHERE x.team_id NOT IN (g.home_team_id, g.away_team_id)
                GROUP BY g.season ORDER BY g.season"""
        )
        rows = cur.fetchall()
        log.info(f"  remaining ghost rows in {tbl}: " +
                 (", ".join(f"{r['season']}={r['c']}" for r in rows) if rows else "none"))


# (canonical, [duplicates], rename-or-None)
MERGES = [
    (33170, [33192, 33220, 33257, 33300],
     dict(name="Cal State Monterey Bay", school_name="California State University Monterey Bay", short_name="CSUMB")),
    (33207, [33168, 33330],
     dict(name="Cal State San Bernardino", school_name="California State University San Bernardino", short_name="CSUSB")),
    (33208, [33193],
     dict(name="Colorado State Pueblo", school_name="Colorado State University Pueblo", short_name="CSU Pueblo")),
    (33174, [33137, 33263],
     dict(name="Claremont-Mudd-Scripps", school_name="Claremont-Mudd-Scripps Colleges", short_name="CMS")),
    (33173, [33121, 33260],
     dict(name="Pomona-Pitzer", school_name="Pomona-Pitzer Colleges", short_name="Pomona-Pitzer")),
    (33210, [33106],
     dict(name="Arizona Christian", school_name="Arizona Christian University", short_name="Arizona Christian")),
    (33114, [33333],
     dict(name="Azusa Pacific", school_name="Azusa Pacific University", short_name="Azusa Pacific")),
    (33209, [33125], dict(name="Whittier", school_name="Whittier College", short_name="Whittier")),
    (33205, [33131], dict(name="La Verne", school_name="University of La Verne", short_name="La Verne")),
    (33194, [33211],
     dict(name="Benedictine Mesa", school_name="Benedictine University Mesa", short_name="Benedictine Mesa")),
    (33234, [33319], dict(name="Utah Valley", school_name="Utah Valley University", short_name="Utah Valley")),
    (33307, [33336],
     dict(name="Concordia Texas", school_name="Concordia University Texas", short_name="Concordia Texas")),
    (33309, [33312], dict(name="LSU Shreveport", school_name="LSU Shreveport", short_name="LSU Shreveport")),
    (33318, [33310], dict(name="Jessup", school_name="Jessup University", short_name="Jessup")),
    (33317, [33314],
     dict(name="Antelope Valley", school_name="University of Antelope Valley", short_name="Antelope Valley")),
    (33201, [33196],
     dict(name="Cal Lutheran", school_name="California Lutheran University", short_name="Cal Lutheran")),
    (33109, [33315], dict(name="Park Gilbert", school_name="Park University Gilbert", short_name="Park Gilbert")),
    (33245, [33161], dict(name="BYU", school_name="Brigham Young University", short_name="BYU")),
    (32867, [33143], None),                                    # "San Diego St." (WMT) -> SDSU
    (33141, [33128], dict(name="CSUN", school_name="Cal State Northridge", short_name="CSUN")),
    (33176, [33195], dict(name="MSOE", school_name="Milwaukee School of Engineering", short_name="MSOE")),
    (33115, [33184], dict(name="Ottawa Arizona", school_name="Ottawa University Arizona", short_name="OUAZ")),
    (32837, [33229], None),                                    # "UCLA UCLA"
    (5720, [33145], None),                                     # "British Colum." -> UBC
    (7, [33191, 33254, 33256], None),                          # MSUB spellings + regional seeds
    (33117, [33295],
     dict(name="Hawaii Pacific", school_name="Hawaii Pacific University", short_name="Hawaii Pacific")),
    (33175, [33178], dict(name="Denison", school_name="Denison University", short_name="Denison")),
    (33243, [33347],
     dict(name="Texas A&M-Corpus Christi", school_name="Texas A&M University-Corpus Christi",
          short_name="A&M-Corpus Christi")),
    (482, [33291], None),                                      # "2-seed Portland"
    (5, [33253, 33334], None),                                 # "3-seed Central Wash(ington)"
    (8, [33335, 33298], None),                                 # "1-seed Western Oregon", "2-seed Western Ore."
    (32860, [33248], None),                                    # "1-seed San Diego"
    (32859, [33247, 33225], None),                             # "N-seed Saint Mary's"
    (32861, [33226], None),                                    # "3-Seed San Francisco"
    (32862, [33328, 33290], None),                             # "N-seed Santa Clara"
    (33250, [33299],
     dict(name="San Francisco State", school_name="San Francisco State University", short_name="SF State")),
    (33224, [33255], None),                                    # "4-seed Point Loma"
]

RENAMES = [
    (33259, dict(name="Tampa", school_name="University of Tampa", short_name="Tampa")),
    (33258, dict(name="UT Tyler", school_name="University of Texas at Tyler", short_name="UT Tyler")),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        try:
            # ---- A0. the shadow copy of Oregon vs Texas ----------------------
            cur.execute("SELECT id FROM games WHERE id = 10271 AND source_url LIKE '%%university-of-texas/boxscore/24476'")
            if cur.fetchone():
                cur.execute("DELETE FROM games WHERE id = 10271")   # children cascade
                log.info("\n[A0] deleted shadow game 10271 (Oregon vs Texas 2026-06-06, second slug)")
            else:
                log.info("\n[A0] shadow game 10271 already gone")

            # ---- A. bare names -> right school -------------------------------
            t = team_row(cur, 33354)
            if t and t["short_name"] != "Texas":
                rename_team(cur, 33354, "Texas Longhorns", "University of Texas", "Texas")
            repoint_slug(cur, "texas", 33278, 33354, "A1 Texas")

            t = team_row(cur, 33237)
            if t and t["short_name"] != "Hawaii":
                rename_team(cur, 33237, "Hawaii Rainbow Warriors", "University of Hawaii", "Hawaii")
            repoint_slug(cur, "hawaii", 33117, 33237, "A2 Hawaii")

            lsu = find_or_create(cur, "LSU", "Louisiana State University", "LSU")
            repoint_slug(cur, "lsu", 33309, lsu, "A3 LSU")

            ariz = find_or_create(cur, "Arizona", "University of Arizona", "Arizona")
            repoint_slug(cur, "arizona", 33246, ariz, "A4 Arizona")

            ott = find_or_create(cur, "Ottawa University (Kan.)", "Ottawa University", "Ottawa (Kan.)")
            repoint_slug(cur, "ottawa-university-kan-", 33115, ott, "A5 Ottawa (Kan.)")

            cmich = find_or_create(cur, "Concordia (Mich.)", "Concordia University Ann Arbor", "Concordia (Mich.)")
            repoint_slug(cur, "concordia-mich-", 33307, cmich, "A6 Concordia (Mich.)")

            # ---- B. Seattle U vs Pacific: D3 (17) -> D1 (32857) ----------------
            cur.execute(
                """SELECT id FROM games WHERE 484 IN (home_team_id, away_team_id)
                   AND 17 IN (home_team_id, away_team_id) ORDER BY id"""
            )
            ids = [r["id"] for r in cur.fetchall()]
            log.info(f"\n[B] Seattle U vs Pacific games filed under D3 Pacific: {ids}")
            if ids:
                st = repoint_games(cur, ids, 17, 32857)
                st.update(fix_players_after_repoint(cur, ids, 17, 32857))
                log.info(f"  {st}")

            # ---- C. ghost rows ------------------------------------------------
            log.info("\n[C] ghost box-score rows")
            delete_ghost_rows(cur)
            ghost_report(cur)

            # ---- D. duplicate OOC rows ---------------------------------------
            log.info("\n[D] merging duplicate team rows")
            for canon, dups, rename in MERGES:
                if not team_row(cur, canon):
                    log.warning(f"  canonical team {canon} missing -- skipping {dups}")
                    continue
                for dup in dups:
                    merge_team(cur, canon, dup)
                if rename:
                    rename_team(cur, canon, **rename)
            for tid, rename in RENAMES:
                if team_row(cur, tid):
                    rename_team(cur, tid, **rename)

            # ---- report -------------------------------------------------------
            log.info("\n[report]")
            cur.execute(
                """SELECT g.id, g.game_date, th.short_name h, ta.short_name a, g.source_url
                   FROM games g JOIN teams th ON th.id = g.home_team_id JOIN teams ta ON ta.id = g.away_team_id
                   WHERE g.source_url LIKE '%%goducks.com%%boxscore/2447%%' ORDER BY g.id"""
            )
            for r in cur.fetchall():
                log.info(f"  g{r['id']} {r['game_date']} {r['h']} vs {r['a']}  {r['source_url']}")
            cur.execute(
                """SELECT p.id, p.first_name, p.last_name,
                          (SELECT COUNT(*) FROM game_pitching gp JOIN games g ON g.id = gp.game_id
                            WHERE gp.player_id = p.id AND g.season = 2026) AS apps,
                          (SELECT SUM(strikeouts) FROM game_pitching gp JOIN games g ON g.id = gp.game_id
                            WHERE gp.player_id = p.id AND g.season = 2026) AS k
                   FROM players p WHERE p.id = 3624"""
            )
            r = cur.fetchone()
            log.info(f"  Collin Clarke (3624) 2026 box-score appearances={r['apps']} K={r['k']}")
            ghost_report(cur)
            cur.execute("SELECT COUNT(*) AS c FROM teams WHERE id > 30000")
            log.info(f"  OOC-range team rows remaining: {cur.fetchone()['c']}")

            if args.apply:
                conn.commit()
                log.info("\nCOMMITTED.")
            else:
                conn.rollback()
                log.info("\nDRY RUN -- rolled back. Re-run with --apply to commit.")
        except Exception:
            conn.rollback()
            raise


if __name__ == "__main__":
    main()
