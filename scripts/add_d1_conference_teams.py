#!/usr/bin/env python3
"""
Add non-PNW D1 teams to the database so conference standings show full conferences.
These teams won't have individual player stats — just team records for standings context.

Run: python3 scripts/add_d1_conference_teams.py
"""

import sqlite3
import os
from pathlib import Path

DB_PATH = os.environ.get(
    "PNW_BASEBALL_DB",
    str(Path(__file__).resolve().parent.parent / "data" / "pnw_baseball.db"),
)


def get_conf_id(conn, abbrev):
    row = conn.execute(
        "SELECT id FROM conferences WHERE abbreviation = ?", (abbrev,)
    ).fetchone()
    return row[0] if row else None


def add_teams(conn):
    """Add non-PNW D1 conference teams."""

    conf_ids = {}
    for abbrev in ["Big Ten", "Pac-12", "WCC", "MWC", "WAC"]:
        conf_ids[abbrev] = get_conf_id(conn, abbrev)

    # (name, school_name, short_name, mascot, city, state, conf_abbrev, logo_url)
    # These are the 2025-26 conference members for baseball
    non_pnw_teams = [
        # ── Big Ten (non-PNW members) ──
        # UW and Oregon are already in the DB
        ("Illinois Fighting Illini", "University of Illinois", "Illinois", "Fighting Illini",
         "Champaign", "IL", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/356.png"),
        ("Indiana Hoosiers", "Indiana University", "Indiana", "Hoosiers",
         "Bloomington", "IN", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/84.png"),
        ("Iowa Hawkeyes", "University of Iowa", "Iowa", "Hawkeyes",
         "Iowa City", "IA", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/2294.png"),
        ("Maryland Terrapins", "University of Maryland", "Maryland", "Terrapins",
         "College Park", "MD", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/120.png"),
        ("Michigan Wolverines", "University of Michigan", "Michigan", "Wolverines",
         "Ann Arbor", "MI", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/130.png"),
        ("Michigan State Spartans", "Michigan State University", "Michigan St.", "Spartans",
         "East Lansing", "MI", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/127.png"),
        ("Minnesota Golden Gophers", "University of Minnesota", "Minnesota", "Golden Gophers",
         "Minneapolis", "MN", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/135.png"),
        ("Nebraska Cornhuskers", "University of Nebraska", "Nebraska", "Cornhuskers",
         "Lincoln", "NE", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/158.png"),
        ("Northwestern Wildcats", "Northwestern University", "Northwestern", "Wildcats",
         "Evanston", "IL", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/77.png"),
        ("Ohio State Buckeyes", "The Ohio State University", "Ohio St.", "Buckeyes",
         "Columbus", "OH", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/194.png"),
        ("Penn State Nittany Lions", "Pennsylvania State University", "Penn St.", "Nittany Lions",
         "University Park", "PA", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/213.png"),
        ("Purdue Boilermakers", "Purdue University", "Purdue", "Boilermakers",
         "West Lafayette", "IN", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/2509.png"),
        ("Rutgers Scarlet Knights", "Rutgers University", "Rutgers", "Scarlet Knights",
         "Piscataway", "NJ", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/164.png"),
        ("UCLA Bruins", "University of California, Los Angeles", "UCLA", "Bruins",
         "Los Angeles", "CA", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/26.png"),
        ("USC Trojans", "University of Southern California", "USC", "Trojans",
         "Los Angeles", "CA", "Big Ten", "https://a.espncdn.com/i/teamlogos/ncaa/500/30.png"),

        # ── Pac-12 (non-PNW members) ──
        # Oregon State is already in the DB
        ("Arizona Wildcats", "University of Arizona", "Arizona", "Wildcats",
         "Tucson", "AZ", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/12.png"),
        ("Arizona State Sun Devils", "Arizona State University", "Arizona St.", "Sun Devils",
         "Tempe", "AZ", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/9.png"),
        ("Baylor Bears", "Baylor University", "Baylor", "Bears",
         "Waco", "TX", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/239.png"),
        ("BYU Cougars", "Brigham Young University", "BYU", "Cougars",
         "Provo", "UT", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/252.png"),
        ("Cincinnati Bearcats", "University of Cincinnati", "Cincinnati", "Bearcats",
         "Cincinnati", "OH", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/2132.png"),
        ("Colorado Buffaloes", "University of Colorado", "Colorado", "Buffaloes",
         "Boulder", "CO", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/38.png"),
        ("Houston Cougars", "University of Houston", "Houston", "Cougars",
         "Houston", "TX", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/248.png"),
        ("Iowa State Cyclones", "Iowa State University", "Iowa St.", "Cyclones",
         "Ames", "IA", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/66.png"),
        ("Kansas Jayhawks", "University of Kansas", "Kansas", "Jayhawks",
         "Lawrence", "KS", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/2305.png"),
        ("Kansas State Wildcats", "Kansas State University", "Kansas St.", "Wildcats",
         "Manhattan", "KS", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/2306.png"),
        ("Oklahoma State Cowboys", "Oklahoma State University", "Oklahoma St.", "Cowboys",
         "Stillwater", "OK", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/197.png"),
        ("TCU Horned Frogs", "Texas Christian University", "TCU", "Horned Frogs",
         "Fort Worth", "TX", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/2628.png"),
        ("Texas Tech Red Raiders", "Texas Tech University", "Texas Tech", "Red Raiders",
         "Lubbock", "TX", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/2641.png"),
        ("UCF Knights", "University of Central Florida", "UCF", "Knights",
         "Orlando", "FL", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/2116.png"),
        ("Utah Utes", "University of Utah", "Utah", "Utes",
         "Salt Lake City", "UT", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/254.png"),
        ("West Virginia Mountaineers", "West Virginia University", "West Virginia", "Mountaineers",
         "Morgantown", "WV", "Pac-12", "https://a.espncdn.com/i/teamlogos/ncaa/500/277.png"),

        # ── West Coast Conference (non-PNW members) ──
        # Portland, Gonzaga, Seattle U are already in the DB
        ("BYU Cougars WCC", "Brigham Young University WCC", "BYU", "Cougars",
         "Provo", "UT", "WCC", None),  # BYU may not be in WCC for baseball
        ("Loyola Marymount Lions", "Loyola Marymount University", "LMU", "Lions",
         "Los Angeles", "CA", "WCC", "https://a.espncdn.com/i/teamlogos/ncaa/500/2281.png"),
        ("Pacific Tigers", "University of the Pacific", "Pacific", "Tigers",
         "Stockton", "CA", "WCC", "https://a.espncdn.com/i/teamlogos/ncaa/500/279.png"),
        ("Pepperdine Waves", "Pepperdine University", "Pepperdine", "Waves",
         "Malibu", "CA", "WCC", "https://a.espncdn.com/i/teamlogos/ncaa/500/2492.png"),
        ("Saint Mary's Gaels", "Saint Mary's College", "Saint Mary's", "Gaels",
         "Moraga", "CA", "WCC", "https://a.espncdn.com/i/teamlogos/ncaa/500/2608.png"),
        ("San Diego Toreros", "University of San Diego", "San Diego", "Toreros",
         "San Diego", "CA", "WCC", "https://a.espncdn.com/i/teamlogos/ncaa/500/301.png"),
        ("San Francisco Dons", "University of San Francisco", "San Francisco", "Dons",
         "San Francisco", "CA", "WCC", "https://a.espncdn.com/i/teamlogos/ncaa/500/2608.png"),
        ("Santa Clara Broncos", "Santa Clara University", "Santa Clara", "Broncos",
         "Santa Clara", "CA", "WCC", "https://a.espncdn.com/i/teamlogos/ncaa/500/2541.png"),

        # ── Mountain West (non-PNW members) ──
        # Washington State is already in the DB
        ("Air Force Falcons", "United States Air Force Academy", "Air Force", "Falcons",
         "Colorado Springs", "CO", "MWC", "https://a.espncdn.com/i/teamlogos/ncaa/500/2005.png"),
        ("Fresno State Bulldogs", "California State University, Fresno", "Fresno St.", "Bulldogs",
         "Fresno", "CA", "MWC", "https://a.espncdn.com/i/teamlogos/ncaa/500/278.png"),
        ("Nevada Wolf Pack", "University of Nevada", "Nevada", "Wolf Pack",
         "Reno", "NV", "MWC", "https://a.espncdn.com/i/teamlogos/ncaa/500/2440.png"),
        ("New Mexico Lobos", "University of New Mexico", "New Mexico", "Lobos",
         "Albuquerque", "NM", "MWC", "https://a.espncdn.com/i/teamlogos/ncaa/500/167.png"),
        ("San Diego State Aztecs", "San Diego State University", "SDSU", "Aztecs",
         "San Diego", "CA", "MWC", "https://a.espncdn.com/i/teamlogos/ncaa/500/21.png"),
        ("San Jose State Spartans", "San Jose State University", "San Jose St.", "Spartans",
         "San Jose", "CA", "MWC", "https://a.espncdn.com/i/teamlogos/ncaa/500/23.png"),
        ("UNLV Rebels", "University of Nevada, Las Vegas", "UNLV", "Rebels",
         "Las Vegas", "NV", "MWC", "https://a.espncdn.com/i/teamlogos/ncaa/500/2439.png"),
        ("Utah State Aggies", "Utah State University", "Utah St.", "Aggies",
         "Logan", "UT", "MWC", "https://a.espncdn.com/i/teamlogos/ncaa/500/328.png"),

        # ── WAC (no PNW team currently — but keeping for completeness) ──
    ]

    PNW_STATES = {"WA", "OR", "ID", "MT"}
    added = 0
    skipped = 0

    for (name, school, short, mascot, city, state, conf_abbrev, logo) in non_pnw_teams:
        cid = conf_ids.get(conf_abbrev)
        if not cid:
            print(f"  SKIP {short} — conference '{conf_abbrev}' not found")
            skipped += 1
            continue

        # Check if already exists
        existing = conn.execute(
            "SELECT id FROM teams WHERE school_name = ? AND conference_id = ?",
            (school, cid),
        ).fetchone()
        if existing:
            skipped += 1
            continue

        conn.execute(
            """INSERT INTO teams (name, school_name, short_name, mascot, city, state,
                                  conference_id, logo_url, is_active)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)""",
            (name, school, short, mascot, city, state, cid, logo),
        )
        added += 1
        print(f"  + {short} ({conf_abbrev}) — {city}, {state}")

    print(f"\nDone: {added} teams added, {skipped} skipped (already exist or no conf)")


def main():
    print(f"Database: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Verify D1 conferences exist
    d1_confs = conn.execute("""
        SELECT c.id, c.abbreviation, c.name, COUNT(t.id) as team_count
        FROM conferences c
        JOIN divisions d ON c.division_id = d.id
        LEFT JOIN teams t ON t.conference_id = c.id
        WHERE d.level = 'D1'
        GROUP BY c.id
    """).fetchall()

    print("\nD1 conferences before:")
    for c in d1_confs:
        print(f"  {c['abbreviation']:10s} — {c['team_count']} teams — {c['name']}")

    print("\nAdding non-PNW D1 teams...")
    add_teams(conn)
    conn.commit()

    # Show updated counts
    d1_confs = conn.execute("""
        SELECT c.abbreviation, COUNT(t.id) as team_count
        FROM conferences c
        JOIN divisions d ON c.division_id = d.id
        LEFT JOIN teams t ON t.conference_id = c.id
        WHERE d.level = 'D1'
        GROUP BY c.id
    """).fetchall()
    print("\nD1 conferences after:")
    for c in d1_confs:
        print(f"  {c['abbreviation']:10s} — {c['team_count']} teams")

    conn.close()


if __name__ == "__main__":
    main()
