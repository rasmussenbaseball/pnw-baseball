#!/usr/bin/env python3
"""
Master scraping script for PNW College Baseball.

Usage:
    python scripts/scrape_all.py --season 2026
    python scripts/scrape_all.py --season 2026 --division NWAC
    python scripts/scrape_all.py --season 2026 --team-id 15

This script:
1. Reads all teams from the database
2. Uses the appropriate scraper for each team's stats source
3. Parses batting, pitching, and roster data
4. Inserts/updates records in the database
5. Computes advanced stats for all players
6. Logs all scraping activity for debugging
"""

import sys
import os
import argparse
import logging
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from app.models.database import get_connection, init_db, seed_divisions_and_conferences
from app.scrapers.base import get_scraper
from app.stats.advanced import (
    BattingLine, PitchingLine,
    compute_batting_advanced, compute_pitching_advanced,
    DEFAULT_WEIGHTS,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("scrape_all")


def get_teams_to_scrape(division_level=None, team_id=None):
    """Get list of teams to scrape from database."""
    with get_connection() as conn:
        cur = conn.cursor()
        query = """
            SELECT t.id, t.name, t.short_name, t.stats_url, t.roster_url,
                   c.stats_url as conference_stats_url,
                   c.stats_format, c.abbreviation as conf_abbrev,
                   d.level as division_level
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.is_active = 1
        """
        params = []
        if division_level:
            query += " AND d.level = %s"
            params.append(division_level)
        if team_id:
            query += " AND t.id = %s"
            params.append(team_id)
        query += " ORDER BY d.id, c.id, t.name"
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


def insert_or_update_player(conn, player_data, team_id):
    """Insert a new player or update existing one. Returns player_id."""
    # Try to find existing player on same team by name
    cur = conn.cursor()
    cur.execute(
        "SELECT id FROM players WHERE first_name = %s AND last_name = %s AND team_id = %s",
        (player_data.get("first_name", ""), player_data.get("last_name", ""), team_id),
    )
    existing = cur.fetchone()

    if existing:
        player_id = existing["id"]
        cur.execute(
            """UPDATE players SET
               position = COALESCE(%s, position),
               year_in_school = COALESCE(%s, year_in_school),
               jersey_number = COALESCE(%s, jersey_number),
               bats = COALESCE(%s, bats),
               throws = COALESCE(%s, throws),
               updated_at = CURRENT_TIMESTAMP
               WHERE id = %s""",
            (
                player_data.get("position"),
                player_data.get("year_in_school"),
                player_data.get("jersey_number"),
                player_data.get("bats"),
                player_data.get("throws"),
                player_id,
            ),
        )
    else:
        cur.execute(
            """INSERT INTO players (first_name, last_name, team_id, position,
               year_in_school, jersey_number, bats, throws, hometown, high_school)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (
                player_data.get("first_name", "Unknown"),
                player_data.get("last_name", "Unknown"),
                team_id,
                player_data.get("position"),
                player_data.get("year_in_school"),
                player_data.get("jersey_number"),
                player_data.get("bats"),
                player_data.get("throws"),
                player_data.get("hometown"),
                player_data.get("high_school"),
            ),
        )
        player_id = cur.fetchone()["id"]

    return player_id


def parse_name(name_str):
    """Parse a name string into first/last name."""
    if not name_str:
        return "Unknown", "Unknown"
    parts = name_str.strip().split(",")
    if len(parts) == 2:
        # "Last, First" format
        return parts[1].strip(), parts[0].strip()
    parts = name_str.strip().split()
    if len(parts) >= 2:
        return parts[0], " ".join(parts[1:])
    return name_str.strip(), ""


def safe_int(val, default=0):
    """Safely convert to int."""
    try:
        return int(val)
    except (ValueError, TypeError):
        return default


def safe_float(val, default=0.0):
    """Safely convert to float."""
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def process_batting_record(conn, record, team_id, season, division_level):
    """Process a single batting stat row and insert into database."""
    # Parse player name
    name_field = record.get("name") or record.get("player") or record.get("Name") or record.get("Player") or ""
    first_name, last_name = parse_name(name_field)

    # Skip totals/team rows
    if last_name.lower() in ("totals", "total", "team", "opponents", "opponent"):
        return

    player_id = insert_or_update_player(conn, {
        "first_name": first_name,
        "last_name": last_name,
        "position": record.get("position") or record.get("pos"),
        "year_in_school": record.get("year_in_school") or record.get("yr") or record.get("cl"),
    }, team_id)

    # Extract counting stats
    pa = safe_int(record.get("plate_appearances") or record.get("pa"))
    ab = safe_int(record.get("at_bats") or record.get("ab"))
    h = safe_int(record.get("hits") or record.get("h"))
    doubles = safe_int(record.get("doubles") or record.get("2b"))
    triples = safe_int(record.get("triples") or record.get("3b"))
    hr = safe_int(record.get("home_runs") or record.get("hr"))
    r = safe_int(record.get("runs") or record.get("r"))
    rbi = safe_int(record.get("rbi"))
    bb = safe_int(record.get("walks") or record.get("bb"))
    k = safe_int(record.get("strikeouts") or record.get("so") or record.get("k"))
    hbp = safe_int(record.get("hit_by_pitch") or record.get("hbp"))
    sf = safe_int(record.get("sacrifice_flies") or record.get("sf"))
    sh = safe_int(record.get("sacrifice_bunts") or record.get("sh") or record.get("sac"))
    sb = safe_int(record.get("stolen_bases") or record.get("sb"))
    cs = safe_int(record.get("caught_stealing") or record.get("cs"))
    g = safe_int(record.get("games") or record.get("g") or record.get("gp"))
    ibb = safe_int(record.get("intentional_walks") or record.get("ibb"))
    gidp = safe_int(record.get("grounded_into_dp") or record.get("gdp") or record.get("gidp"))

    # Auto-compute PA if not provided
    if pa == 0 and ab > 0:
        pa = ab + bb + hbp + sf + sh

    # Compute advanced stats
    line = BattingLine(
        pa=pa, ab=ab, hits=h, doubles=doubles, triples=triples,
        hr=hr, bb=bb, ibb=ibb, hbp=hbp, sf=sf, sh=sh, k=k,
        sb=sb, cs=cs, gidp=gidp,
    )
    adv = compute_batting_advanced(line, division_level=division_level)

    # Upsert batting stats
    cur = conn.cursor()
    cur.execute(
        """INSERT INTO batting_stats
           (player_id, team_id, season, games, plate_appearances, at_bats,
            runs, hits, doubles, triples, home_runs, rbi, walks, strikeouts,
            hit_by_pitch, sacrifice_flies, sacrifice_bunts, stolen_bases,
            caught_stealing, grounded_into_dp, intentional_walks,
            batting_avg, on_base_pct, slugging_pct, ops,
            woba, wraa, wrc, wrc_plus, iso, babip, bb_pct, k_pct, offensive_war)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                   %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT(player_id, team_id, season) DO UPDATE SET
            games=excluded.games, plate_appearances=excluded.plate_appearances,
            at_bats=excluded.at_bats, runs=excluded.runs, hits=excluded.hits,
            doubles=excluded.doubles, triples=excluded.triples,
            home_runs=excluded.home_runs, rbi=excluded.rbi, walks=excluded.walks,
            strikeouts=excluded.strikeouts, hit_by_pitch=excluded.hit_by_pitch,
            sacrifice_flies=excluded.sacrifice_flies, stolen_bases=excluded.stolen_bases,
            caught_stealing=excluded.caught_stealing,
            batting_avg=excluded.batting_avg, on_base_pct=excluded.on_base_pct,
            slugging_pct=excluded.slugging_pct, ops=excluded.ops,
            woba=excluded.woba, wraa=excluded.wraa, wrc=excluded.wrc,
            wrc_plus=excluded.wrc_plus, iso=excluded.iso, babip=excluded.babip,
            bb_pct=excluded.bb_pct, k_pct=excluded.k_pct, offensive_war=excluded.offensive_war,
            updated_at=CURRENT_TIMESTAMP""",
        (
            player_id, team_id, season, g, pa, ab, r, h, doubles, triples, hr,
            rbi, bb, k, hbp, sf, sh, sb, cs, gidp, ibb,
            adv.batting_avg, adv.obp, adv.slg, adv.ops,
            adv.woba, adv.wraa, adv.wrc, adv.wrc_plus,
            adv.iso, adv.babip, adv.bb_pct, adv.k_pct, adv.off_war,
        ),
    )


def process_pitching_record(conn, record, team_id, season, division_level):
    """Process a single pitching stat row and insert into database."""
    name_field = record.get("name") or record.get("player") or record.get("Name") or record.get("Player") or ""
    first_name, last_name = parse_name(name_field)

    if last_name.lower() in ("totals", "total", "team", "opponents", "opponent"):
        return

    player_id = insert_or_update_player(conn, {
        "first_name": first_name,
        "last_name": last_name,
        "position": "P",
        "year_in_school": record.get("year_in_school") or record.get("yr") or record.get("cl"),
    }, team_id)

    ip = safe_float(record.get("innings_pitched") or record.get("ip"))
    k = safe_int(record.get("strikeouts") or record.get("so") or record.get("k"))
    bb = safe_int(record.get("walks") or record.get("bb"))
    hr = safe_int(record.get("home_runs_allowed") or record.get("hr") or record.get("hra"))
    er = safe_int(record.get("earned_runs") or record.get("er"))
    h = safe_int(record.get("hits_allowed") or record.get("h") or record.get("ha"))
    runs = safe_int(record.get("runs_allowed") or record.get("r"))
    hbp = safe_int(record.get("hit_batters") or record.get("hbp") or record.get("hb"))
    bf = safe_int(record.get("batters_faced") or record.get("bf") or record.get("tbf"))
    g = safe_int(record.get("games") or record.get("g") or record.get("gp") or record.get("app"))
    gs = safe_int(record.get("games_started") or record.get("gs"))
    w = safe_int(record.get("wins") or record.get("w"))
    l = safe_int(record.get("losses") or record.get("l"))
    sv = safe_int(record.get("saves") or record.get("sv"))
    cg = safe_int(record.get("complete_games") or record.get("cg"))
    sho = safe_int(record.get("shutouts") or record.get("sho"))
    wp = safe_int(record.get("wild_pitches") or record.get("wp"))
    ibb = safe_int(record.get("intentional_walks") or record.get("ibb"))

    # Estimate BF if not provided
    if bf == 0 and ip > 0:
        outs = int(ip) * 3 + int(round((ip - int(ip)) * 10))
        bf = outs + h + bb + hbp

    line = PitchingLine(
        ip=ip, hits=h, er=er, runs=runs, bb=bb, ibb=ibb,
        k=k, hr=hr, hbp=hbp, bf=bf, wp=wp,
        wins=w, losses=l, saves=sv, games=g, gs=gs,
    )
    adv = compute_pitching_advanced(line, division_level=division_level)

    cur = conn.cursor()
    cur.execute(
        """INSERT INTO pitching_stats
           (player_id, team_id, season, games, games_started, wins, losses, saves,
            complete_games, shutouts, innings_pitched, hits_allowed, runs_allowed,
            earned_runs, walks, strikeouts, home_runs_allowed, hit_batters,
            wild_pitches, batters_faced, intentional_walks,
            era, whip, k_per_9, bb_per_9, h_per_9, hr_per_9, k_bb_ratio,
            fip, xfip, siera, kwera, babip_against, lob_pct, pitching_war)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                   %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT(player_id, team_id, season) DO UPDATE SET
            games=excluded.games, games_started=excluded.games_started,
            wins=excluded.wins, losses=excluded.losses, saves=excluded.saves,
            innings_pitched=excluded.innings_pitched, hits_allowed=excluded.hits_allowed,
            earned_runs=excluded.earned_runs, walks=excluded.walks,
            strikeouts=excluded.strikeouts, home_runs_allowed=excluded.home_runs_allowed,
            era=excluded.era, whip=excluded.whip, k_per_9=excluded.k_per_9,
            bb_per_9=excluded.bb_per_9, k_bb_ratio=excluded.k_bb_ratio,
            fip=excluded.fip, xfip=excluded.xfip, siera=excluded.siera,
            babip_against=excluded.babip_against, lob_pct=excluded.lob_pct,
            pitching_war=excluded.pitching_war,
            updated_at=CURRENT_TIMESTAMP""",
        (
            player_id, team_id, season, g, gs, w, l, sv, cg, sho,
            ip, h, runs, er, bb, k, hr, hbp, wp, bf, ibb,
            adv.era, adv.whip, adv.k_per_9, adv.bb_per_9, adv.h_per_9,
            adv.hr_per_9, adv.k_bb_ratio,
            adv.fip, adv.xfip, adv.siera, adv.kwera,
            adv.babip_against, adv.lob_pct, adv.pitching_war,
        ),
    )


def scrape_team(team, season):
    """Scrape all data for a single team."""
    logger.info(f"Scraping {team['name']} ({team['division_level']}/{team['conf_abbrev']})")

    scraper = get_scraper(team["stats_format"])

    # Determine URL to scrape
    stats_url = team["stats_url"] or team["conference_stats_url"]
    if not stats_url:
        logger.warning(f"  No stats URL for {team['name']}, skipping")
        return

    # Scrape batting
    batting_result = scraper.scrape_batting(team["id"], season, stats_url)
    logger.info(f"  Batting: {batting_result.status} ({batting_result.records_found} records)")

    if batting_result.records:
        with get_connection() as conn:
            for record in batting_result.records:
                try:
                    process_batting_record(conn, record, team["id"], season, team["division_level"])
                except Exception as e:
                    logger.error(f"  Error processing batting record: {e}")

            # Log scrape
            cur = conn.cursor()
            cur.execute(
                """INSERT INTO scrape_log
                   (source_url, source_type, team_id, season, status, records_found)
                   VALUES (%s, 'batting', %s, %s, %s, %s)""",
                (batting_result.source_url, team["id"], season,
                 batting_result.status, batting_result.records_found),
            )

    # Scrape pitching
    pitching_result = scraper.scrape_pitching(team["id"], season, stats_url)
    logger.info(f"  Pitching: {pitching_result.status} ({pitching_result.records_found} records)")

    if pitching_result.records:
        with get_connection() as conn:
            for record in pitching_result.records:
                try:
                    process_pitching_record(conn, record, team["id"], season, team["division_level"])
                except Exception as e:
                    logger.error(f"  Error processing pitching record: {e}")

            cur = conn.cursor()
            cur.execute(
                """INSERT INTO scrape_log
                   (source_url, source_type, team_id, season, status, records_found)
                   VALUES (%s, 'pitching', %s, %s, %s, %s)""",
                (pitching_result.source_url, team["id"], season,
                 pitching_result.status, pitching_result.records_found),
            )


def main():
    parser = argparse.ArgumentParser(description="Scrape PNW college baseball stats")
    parser.add_argument("--season", type=int, required=True, help="Season year to scrape")
    parser.add_argument("--division", type=str, help="Filter by division level (D1, D2, D3, NAIA, JUCO)")
    parser.add_argument("--team-id", type=int, help="Scrape a specific team by ID")
    parser.add_argument("--init-db", action="store_true", help="Initialize database before scraping")
    args = parser.parse_args()

    if args.init_db:
        init_db()
        seed_divisions_and_conferences()
        logger.info("Database initialized and seeded")

    teams = get_teams_to_scrape(division_level=args.division, team_id=args.team_id)
    logger.info(f"Found {len(teams)} teams to scrape")

    success = 0
    failed = 0
    for team in teams:
        try:
            scrape_team(team, args.season)
            success += 1
        except Exception as e:
            logger.error(f"Failed to scrape {team['name']}: {e}")
            failed += 1

    logger.info(f"Done! Scraped {success} teams, {failed} failed")


if __name__ == "__main__":
    main()
