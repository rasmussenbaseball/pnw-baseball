"""
Database schema and models for PNW College Baseball Analytics.

Covers all NCAA D1/D2/D3, NAIA, and NWAC programs in WA, OR, ID, MT.
Stores players, teams, conferences, batting/pitching stats, and computed advanced metrics.
"""

import sqlite3
import os
from contextlib import contextmanager
from pathlib import Path

DB_PATH = os.environ.get("PNW_BASEBALL_DB", str(Path(__file__).parent.parent.parent / "data" / "pnw_baseball.db"))

SCHEMA = """
-- ============================================================
-- CONFERENCES & TEAMS
-- ============================================================

CREATE TABLE IF NOT EXISTS divisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,          -- 'NCAA D1', 'NCAA D2', 'NCAA D3', 'NAIA', 'NWAC'
    level TEXT NOT NULL,                -- 'D1', 'D2', 'D3', 'NAIA', 'JUCO'
    governing_body TEXT NOT NULL        -- 'NCAA', 'NAIA', 'NWAC'
);

CREATE TABLE IF NOT EXISTS conferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    abbreviation TEXT,
    division_id INTEGER NOT NULL REFERENCES divisions(id),
    stats_url TEXT,                     -- Primary URL for scraping conference stats
    stats_format TEXT,                  -- 'html_table', 'prestosports', 'json_api', 'sidearm'
    UNIQUE(name, division_id)
);

CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,                 -- 'Oregon State Beavers'
    school_name TEXT NOT NULL,          -- 'Oregon State University'
    short_name TEXT,                    -- 'Oregon St.'
    mascot TEXT,                        -- 'Beavers'
    city TEXT,
    state TEXT NOT NULL,                -- 'WA', 'OR', 'ID', 'MT'
    conference_id INTEGER NOT NULL REFERENCES conferences(id),
    stats_url TEXT,                     -- Team-specific stats page
    roster_url TEXT,                    -- Team roster page
    logo_url TEXT,
    is_active INTEGER DEFAULT 1,
    UNIQUE(school_name, conference_id)
);

-- Track conference membership changes over time
CREATE TABLE IF NOT EXISTS team_conference_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    conference_id INTEGER NOT NULL REFERENCES conferences(id),
    season INTEGER NOT NULL,
    UNIQUE(team_id, season)
);

-- ============================================================
-- PLAYERS
-- ============================================================

CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    jersey_number TEXT,
    position TEXT,                      -- Primary position
    bats TEXT,                          -- 'L', 'R', 'S'
    throws TEXT,                        -- 'L', 'R'
    height TEXT,                        -- '6-2'
    weight INTEGER,                     -- lbs
    year_in_school TEXT,                -- 'Fr.', 'So.', 'Jr.', 'Sr.', 'R-Fr.', etc.
    eligibility_year INTEGER,           -- Years of eligibility remaining
    hometown TEXT,
    high_school TEXT,
    previous_school TEXT,               -- For transfers / JUCO guys
    is_committed INTEGER DEFAULT 0,     -- Whether JUCO player is committed to a 4-year
    committed_to TEXT,                  -- School they're committed to
    graduation_year INTEGER,            -- Expected graduation year
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Link duplicate player records that are actually the same person (transfers)
-- canonical_id is the "primary" record; linked_id points to the duplicate.
-- When displaying a player, all linked_ids' stats merge into the canonical.
CREATE TABLE IF NOT EXISTS player_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_id INTEGER NOT NULL REFERENCES players(id),
    linked_id INTEGER NOT NULL REFERENCES players(id),
    match_type TEXT DEFAULT 'auto',   -- 'auto' or 'manual'
    confidence REAL DEFAULT 1.0,      -- 0.0 to 1.0
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(linked_id)                 -- each player can only be linked once
);

-- Track players across seasons/teams (transfers, JUCO to 4-year, etc.)
CREATE TABLE IF NOT EXISTS player_seasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL REFERENCES players(id),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    season INTEGER NOT NULL,
    year_in_school TEXT,
    jersey_number TEXT,
    position TEXT,
    is_primary_team INTEGER DEFAULT 1,
    UNIQUE(player_id, team_id, season)
);

-- ============================================================
-- BATTING STATS (per season)
-- ============================================================

CREATE TABLE IF NOT EXISTS batting_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL REFERENCES players(id),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    season INTEGER NOT NULL,

    -- Counting stats
    games INTEGER DEFAULT 0,
    games_started INTEGER DEFAULT 0,
    plate_appearances INTEGER DEFAULT 0,
    at_bats INTEGER DEFAULT 0,
    runs INTEGER DEFAULT 0,
    hits INTEGER DEFAULT 0,
    doubles INTEGER DEFAULT 0,
    triples INTEGER DEFAULT 0,
    home_runs INTEGER DEFAULT 0,
    rbi INTEGER DEFAULT 0,
    walks INTEGER DEFAULT 0,
    strikeouts INTEGER DEFAULT 0,
    hit_by_pitch INTEGER DEFAULT 0,
    sacrifice_flies INTEGER DEFAULT 0,
    sacrifice_bunts INTEGER DEFAULT 0,
    stolen_bases INTEGER DEFAULT 0,
    caught_stealing INTEGER DEFAULT 0,
    grounded_into_dp INTEGER DEFAULT 0,
    intentional_walks INTEGER DEFAULT 0,
    reached_on_error INTEGER DEFAULT 0,

    -- Traditional rate stats (computed on insert/update)
    batting_avg REAL,
    on_base_pct REAL,
    slugging_pct REAL,
    ops REAL,

    -- Advanced stats (computed by stats engine)
    woba REAL,                          -- Weighted On-Base Average
    wraa REAL,                          -- Weighted Runs Above Average
    wrc REAL,                           -- Weighted Runs Created
    wrc_plus REAL,                      -- Weighted Runs Created Plus (park/league adjusted)
    iso REAL,                           -- Isolated Power
    babip REAL,                         -- Batting Average on Balls In Play
    bb_pct REAL,                        -- Walk rate
    k_pct REAL,                         -- Strikeout rate
    offensive_war REAL,                 -- Offensive WAR component

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_id, team_id, season)
);

-- ============================================================
-- PITCHING STATS (per season)
-- ============================================================

CREATE TABLE IF NOT EXISTS pitching_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL REFERENCES players(id),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    season INTEGER NOT NULL,

    -- Counting stats
    games INTEGER DEFAULT 0,
    games_started INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    saves INTEGER DEFAULT 0,
    complete_games INTEGER DEFAULT 0,
    shutouts INTEGER DEFAULT 0,
    innings_pitched REAL DEFAULT 0,     -- Stored as decimal (e.g., 6.1 = 6 1/3)
    hits_allowed INTEGER DEFAULT 0,
    runs_allowed INTEGER DEFAULT 0,
    earned_runs INTEGER DEFAULT 0,
    walks INTEGER DEFAULT 0,
    strikeouts INTEGER DEFAULT 0,
    home_runs_allowed INTEGER DEFAULT 0,
    hit_batters INTEGER DEFAULT 0,
    wild_pitches INTEGER DEFAULT 0,
    balks INTEGER DEFAULT 0,
    batters_faced INTEGER DEFAULT 0,
    intentional_walks INTEGER DEFAULT 0,
    holds INTEGER DEFAULT 0,
    quality_starts INTEGER DEFAULT 0,

    -- Traditional rate stats (computed on insert/update)
    era REAL,
    whip REAL,
    k_per_9 REAL,
    bb_per_9 REAL,
    h_per_9 REAL,
    hr_per_9 REAL,
    k_bb_ratio REAL,

    -- Advanced stats (computed by stats engine)
    fip REAL,                           -- Fielding Independent Pitching
    xfip REAL,                          -- Expected FIP
    siera REAL,                         -- Skill-Interactive ERA
    kwera REAL,                         -- K/W ERA estimator
    k_pct REAL,                         -- Strikeout rate (K/BF)
    bb_pct REAL,                        -- Walk rate (BB/BF)
    babip_against REAL,                 -- BABIP against
    lob_pct REAL,                       -- Left On Base %
    hr_fb_ratio REAL,                   -- HR/FB ratio (estimated)
    fip_plus REAL,                      -- FIP+ (100 = league avg, lower is better)
    era_minus REAL,                     -- ERA- (100 = league avg, lower is better)
    pitching_war REAL,                  -- Pitching WAR component

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_id, team_id, season)
);

-- ============================================================
-- FIELDING STATS (per season, per position)
-- ============================================================

CREATE TABLE IF NOT EXISTS fielding_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL REFERENCES players(id),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    season INTEGER NOT NULL,
    position TEXT NOT NULL,

    games INTEGER DEFAULT 0,
    games_started INTEGER DEFAULT 0,
    innings REAL DEFAULT 0,
    putouts INTEGER DEFAULT 0,
    assists INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    double_plays INTEGER DEFAULT 0,
    passed_balls INTEGER DEFAULT 0,     -- Catchers only
    stolen_bases_allowed INTEGER DEFAULT 0,  -- Catchers only
    caught_stealing_by INTEGER DEFAULT 0,    -- Catchers only

    fielding_pct REAL,
    range_factor REAL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_id, team_id, season, position)
);

-- ============================================================
-- TEAM STATS (aggregated per season)
-- ============================================================

CREATE TABLE IF NOT EXISTS team_season_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    season INTEGER NOT NULL,

    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    ties INTEGER DEFAULT 0,
    conference_wins INTEGER DEFAULT 0,
    conference_losses INTEGER DEFAULT 0,
    run_differential INTEGER DEFAULT 0,
    runs_scored INTEGER DEFAULT 0,
    runs_allowed INTEGER DEFAULT 0,

    team_batting_avg REAL,
    team_era REAL,
    team_fielding_pct REAL,
    team_ops REAL,
    team_whip REAL,

    pythagorean_win_pct REAL,          -- Expected win% from run differential

    UNIQUE(team_id, season)
);

-- ============================================================
-- LEAGUE AVERAGES (for park/league adjustments)
-- ============================================================

CREATE TABLE IF NOT EXISTS league_averages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    division_id INTEGER NOT NULL REFERENCES divisions(id),
    season INTEGER NOT NULL,

    -- Batting
    avg_batting_avg REAL,
    avg_obp REAL,
    avg_slg REAL,
    avg_ops REAL,
    avg_woba REAL,
    avg_runs_per_game REAL,
    avg_hr_per_fb REAL,
    woba_scale REAL,
    runs_per_pa REAL,
    runs_per_win REAL,

    -- Pitching
    avg_era REAL,
    avg_fip REAL,
    avg_k_per_9 REAL,
    avg_bb_per_9 REAL,
    avg_hr_per_9 REAL,

    -- FIP constant for the season
    fip_constant REAL,

    UNIQUE(division_id, season)
);

-- ============================================================
-- NATIONAL RATINGS (imported from external sources)
-- ============================================================

CREATE TABLE IF NOT EXISTS national_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    season INTEGER NOT NULL,
    source TEXT NOT NULL,                -- 'pear', 'massey', 'cbr'

    -- Ranking / rating values
    national_rank INTEGER,              -- Rank within their division nationally
    total_teams INTEGER,                -- Total teams ranked in that division
    rating REAL,                        -- Raw rating value from source
    sos REAL,                           -- Strength of schedule from source
    sos_rank INTEGER,                   -- SOS rank if available

    -- Extra source-specific fields (stored as JSON-compatible text)
    tsr REAL,                           -- Pear: Team Strength Rating
    rqi REAL,                           -- Pear: Resume Quality Index
    power_rating REAL,                  -- Massey: Pwr / CBR: CBR value
    sor REAL,                           -- CBR: Strength of Record
    wab REAL,                           -- CBR: Wins Above Bubble

    -- Source team name (for debugging name matching)
    source_team_name TEXT,

    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(team_id, season, source)
);

-- Composite rankings (computed from national_ratings)
CREATE TABLE IF NOT EXISTS composite_rankings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    season INTEGER NOT NULL,

    -- Composite values (averaged across sources)
    composite_rank REAL,                -- Average national rank
    composite_percentile REAL,          -- Percentile within division (0-100, higher=better)
    composite_sos REAL,                 -- Average SOS value
    composite_sos_rank REAL,            -- Average SOS rank
    num_sources INTEGER DEFAULT 0,      -- How many sources contributed

    -- Individual source ranks (for display)
    pear_rank INTEGER,
    massey_rank INTEGER,
    cbr_rank INTEGER,
    rpi_rank INTEGER,                   -- D1 only (from Pear)

    -- Individual source SOS
    pear_sos REAL,
    massey_sos REAL,
    cbr_sos REAL,

    -- Cross-division comparison
    national_percentile REAL,           -- Percentile within division nationally
    cross_division_score REAL,          -- Normalized 0-100 score for cross-division comparison

    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(team_id, season)
);

CREATE INDEX IF NOT EXISTS idx_national_ratings_team ON national_ratings(team_id, season);
CREATE INDEX IF NOT EXISTS idx_national_ratings_source ON national_ratings(source, season);
CREATE INDEX IF NOT EXISTS idx_composite_rankings_team ON composite_rankings(team_id, season);

-- ============================================================
-- SCRAPING METADATA
-- ============================================================

CREATE TABLE IF NOT EXISTS scrape_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT NOT NULL,
    source_type TEXT,                   -- 'roster', 'batting', 'pitching', 'fielding', 'standings'
    team_id INTEGER REFERENCES teams(id),
    conference_id INTEGER REFERENCES conferences(id),
    season INTEGER,
    status TEXT NOT NULL,               -- 'success', 'failed', 'partial'
    records_found INTEGER DEFAULT 0,
    records_inserted INTEGER DEFAULT 0,
    records_updated INTEGER DEFAULT 0,
    error_message TEXT,
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_players_name ON players(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_batting_season ON batting_stats(season);
CREATE INDEX IF NOT EXISTS idx_batting_player ON batting_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_batting_team_season ON batting_stats(team_id, season);
CREATE INDEX IF NOT EXISTS idx_pitching_season ON pitching_stats(season);
CREATE INDEX IF NOT EXISTS idx_pitching_player ON pitching_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_pitching_team_season ON pitching_stats(team_id, season);
CREATE INDEX IF NOT EXISTS idx_fielding_player ON fielding_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_team_season ON team_season_stats(team_id, season);
CREATE INDEX IF NOT EXISTS idx_player_seasons ON player_seasons(player_id, season);
"""


def get_db_path():
    """Get the database file path, creating parent directories if needed."""
    path = Path(DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    return str(path)


@contextmanager
def get_connection():
    """Context manager for database connections."""
    conn = sqlite3.connect(get_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    """Initialize database with schema."""
    with get_connection() as conn:
        conn.executescript(SCHEMA)
    print(f"Database initialized at {get_db_path()}")


def seed_divisions_and_conferences():
    """Seed the database with all PNW divisions, conferences, and teams."""
    with get_connection() as conn:
        # Divisions
        divisions = [
            ("NCAA D1", "D1", "NCAA"),
            ("NCAA D2", "D2", "NCAA"),
            ("NCAA D3", "D3", "NCAA"),
            ("NAIA", "NAIA", "NAIA"),
            ("NWAC", "JUCO", "NWAC"),
        ]
        for name, level, body in divisions:
            conn.execute(
                "INSERT OR IGNORE INTO divisions (name, level, governing_body) VALUES (?, ?, ?)",
                (name, level, body),
            )

        # Get division IDs
        div_ids = {}
        for row in conn.execute("SELECT id, name FROM divisions"):
            div_ids[row["name"]] = row["id"]

        # Conferences
        conferences = [
            # D1
            ("Big Ten Conference", "Big Ten", div_ids["NCAA D1"],
             "https://bigten.org/sports/baseball/stats", "sidearm"),
            ("Mountain West Conference", "MWC", div_ids["NCAA D1"],
             "https://mountainwest.com/sports/baseball/stats", "sidearm"),
            ("Pac-12 Conference", "Pac-12", div_ids["NCAA D1"],
             None, "sidearm"),  # OSU independent / remnant
            ("West Coast Conference", "WCC", div_ids["NCAA D1"],
             "https://wccsports.com/stats.aspx?path=baseball", "sidearm"),
            ("Western Athletic Conference", "WAC", div_ids["NCAA D1"],
             "https://wacsports.com/stats.aspx?path=baseball", "sidearm"),
            # D2
            ("Great Northwest Athletic Conference", "GNAC", div_ids["NCAA D2"],
             "https://gnacsports.com/stats.aspx?path=baseball", "html_table"),
            # D3
            ("Northwest Conference", "NWC", div_ids["NCAA D3"],
             "https://nwcsports.com/stats.aspx?path=baseball", "html_table"),
            # NAIA
            ("Cascade Collegiate Conference", "CCC", div_ids["NAIA"],
             "https://cascadeconference.org/stats.aspx?path=baseball", "sidearm"),
            # NWAC
            ("NWAC North Division", "NWAC-N", div_ids["NWAC"],
             "https://nwacsports.com/sports/bsb/index", "prestosports"),
            ("NWAC East Division", "NWAC-E", div_ids["NWAC"],
             "https://nwacsports.com/sports/bsb/index", "prestosports"),
            ("NWAC South Division", "NWAC-S", div_ids["NWAC"],
             "https://nwacsports.com/sports/bsb/index", "prestosports"),
            ("NWAC West Division", "NWAC-W", div_ids["NWAC"],
             "https://nwacsports.com/sports/bsb/index", "prestosports"),
        ]
        for name, abbrev, div_id, url, fmt in conferences:
            conn.execute(
                """INSERT OR IGNORE INTO conferences
                   (name, abbreviation, division_id, stats_url, stats_format)
                   VALUES (?, ?, ?, ?, ?)""",
                (name, abbrev, div_id, url, fmt),
            )

        # Get conference IDs
        conf_ids = {}
        for row in conn.execute("SELECT id, abbreviation FROM conferences"):
            conf_ids[row["abbreviation"]] = row["id"]

        # ============================================================
        # TEAMS - comprehensive list of all PNW programs
        # ============================================================
        teams = [
            # --- NCAA D1 ---
            ("Washington Huskies", "University of Washington", "UW", "Huskies",
             "Seattle", "WA", conf_ids["Big Ten"],
             "https://gohuskies.com/sports/baseball/stats"),
            ("Oregon Ducks", "University of Oregon", "Oregon", "Ducks",
             "Eugene", "OR", conf_ids["Big Ten"],
             "https://goducks.com/sports/baseball/stats"),
            ("Oregon State Beavers", "Oregon State University", "Oregon St.", "Beavers",
             "Corvallis", "OR", conf_ids["Pac-12"],
             "https://osubeavers.com/sports/baseball/stats"),
            ("Washington State Cougars", "Washington State University", "Wash. St.", "Cougars",
             "Pullman", "WA", conf_ids["MWC"],
             "https://wsucougars.com/sports/baseball/stats"),
            ("Portland Pilots", "University of Portland", "Portland", "Pilots",
             "Portland", "OR", conf_ids["WCC"],
             "https://portlandpilots.com/sports/baseball/stats"),
            ("Gonzaga Bulldogs", "Gonzaga University", "Gonzaga", "Bulldogs",
             "Spokane", "WA", conf_ids["WCC"],
             "https://gozags.com/sports/baseball/stats"),
            ("Seattle U Redhawks", "Seattle University", "Seattle U", "Redhawks",
             "Seattle", "WA", conf_ids["WCC"],
             "https://goseattleu.com/sports/baseball/stats"),

            # --- NCAA D2 (GNAC) ---
            ("Central Washington Wildcats", "Central Washington University", "CWU", "Wildcats",
             "Ellensburg", "WA", conf_ids["GNAC"],
             "https://wildcatsports.com/sports/baseball/stats"),
            ("Saint Martin's Saints", "Saint Martin's University", "SMU", "Saints",
             "Lacey", "WA", conf_ids["GNAC"],
             "https://smusaints.com/sports/baseball/stats"),
            ("MSU-Billings Yellowjackets", "Montana State University-Billings", "MSUB", "Yellowjackets",
             "Billings", "MT", conf_ids["GNAC"],
             "https://msubsports.com/sports/baseball/stats"),
            ("Western Oregon Wolves", "Western Oregon University", "WOU", "Wolves",
             "Monmouth", "OR", conf_ids["GNAC"],
             "https://wouwolves.com/sports/baseball/stats"),
            ("NNU Nighthawks", "Northwest Nazarene University", "NNU", "Nighthawks",
             "Nampa", "ID", conf_ids["GNAC"],
             "https://nnusports.com/sports/baseball/stats"),

            # --- NCAA D3 (NWC) ---
            ("Puget Sound Loggers", "University of Puget Sound", "UPS", "Loggers",
             "Tacoma", "WA", conf_ids["NWC"],
             "https://loggerathletics.com/sports/baseball/stats"),
            ("PLU Lutes", "Pacific Lutheran University", "PLU", "Lutes",
             "Tacoma", "WA", conf_ids["NWC"],
             "https://golutes.com/sports/baseball/stats"),
            ("Whitman Blues", "Whitman College", "Whitman", "Blues",
             "Walla Walla", "WA", conf_ids["NWC"],
             "https://athletics.whitman.edu/sports/baseball/stats"),
            ("Whitworth Pirates", "Whitworth University", "Whitworth", "Pirates",
             "Spokane", "WA", conf_ids["NWC"],
             "https://whitworthpirates.com/sports/baseball/stats"),
            ("Linfield Wildcats", "Linfield University", "Linfield", "Wildcats",
             "McMinnville", "OR", conf_ids["NWC"],
             "https://linfieldsports.com/sports/baseball/stats"),
            ("Lewis & Clark Pioneers", "Lewis & Clark College", "L&C", "Pioneers",
             "Portland", "OR", conf_ids["NWC"],
             "https://lcpioneers.com/sports/baseball/stats"),
            ("Willamette Bearcats", "Willamette University", "Willamette", "Bearcats",
             "Salem", "OR", conf_ids["NWC"],
             "https://willamette.edu/athletics/baseball/stats"),
            ("Pacific Boxers", "Pacific University", "Pacific", "Boxers",
             "Forest Grove", "OR", conf_ids["NWC"],
             "https://goboxers.com/sports/baseball/stats"),
            ("George Fox Bruins", "George Fox University", "GFU", "Bruins",
             "Newberg", "OR", conf_ids["NWC"],
             "https://gofoxes.com/sports/baseball/stats"),

            # --- NAIA (CCC) ---
            ("Eastern Oregon Mountaineers", "Eastern Oregon University", "EOU", "Mountaineers",
             "La Grande", "OR", conf_ids["CCC"],
             "https://eousports.com/sports/baseball/stats"),
            ("Oregon Tech Owls", "Oregon Institute of Technology", "OIT", "Owls",
             "Klamath Falls", "OR", conf_ids["CCC"],
             "https://oregontechowls.com/sports/baseball/stats"),
            ("College of Idaho Yotes", "College of Idaho", "C of I", "Yotes",
             "Caldwell", "ID", conf_ids["CCC"],
             "https://yoteathletics.com/sports/baseball/stats"),
            ("Lewis-Clark State Warriors", "Lewis-Clark State College", "LCSC", "Warriors",
             "Lewiston", "ID", conf_ids["CCC"],
             "https://lcwarriors.com/sports/baseball/stats"),
            ("Corban Warriors", "Corban University", "Corban", "Warriors",
             "Salem", "OR", conf_ids["CCC"],
             "https://corbanwarriors.com/sports/baseball/stats"),
            ("Bushnell Beacons", "Bushnell University", "Bushnell", "Beacons",
             "Eugene", "OR", conf_ids["CCC"],
             "https://bushnellbeacons.com/sports/baseball/stats"),
            ("Warner Pacific Knights", "Warner Pacific University", "Warner Pacific", "Knights",
             "Portland", "OR", conf_ids["CCC"],
             "https://wpuknights.com/sports/baseball/stats"),
            ("UBC Thunderbirds", "University of British Columbia", "UBC", "Thunderbirds",
             "Vancouver", "BC", conf_ids["CCC"],
             "https://gothunderbirds.ca/sports/baseball/stats"),

            # --- NWAC North ---
            ("Bellevue Bulldogs", "Bellevue College", "Bellevue", "Bulldogs",
             "Bellevue", "WA", conf_ids["NWAC-N"], None),
            ("Douglas Royals", "Douglas College", "Douglas", "Royals",
             "New Westminster", "BC", conf_ids["NWAC-N"], None),
            ("Edmonds Tritons", "Edmonds College", "Edmonds", "Tritons",
             "Lynnwood", "WA", conf_ids["NWAC-N"], None),
            ("Everett Trojans", "Everett Community College", "Everett", "Trojans",
             "Everett", "WA", conf_ids["NWAC-N"], None),
            # Olympic and Pierce are in the West Region, not North
            ("Shoreline Dolphins", "Shoreline Community College", "Shoreline", "Dolphins",
             "Shoreline", "WA", conf_ids["NWAC-N"], None),
            ("Skagit Valley Cardinals", "Skagit Valley College", "Skagit", "Cardinals",
             "Mount Vernon", "WA", conf_ids["NWAC-N"], None),

            # --- NWAC East ---
            ("Big Bend Vikings", "Big Bend Community College", "Big Bend", "Vikings",
             "Moses Lake", "WA", conf_ids["NWAC-E"], None),
            ("Columbia Basin Hawks", "Columbia Basin College", "Columbia Basin", "Hawks",
             "Pasco", "WA", conf_ids["NWAC-E"], None),
            ("Spokane Falls Bigfoot", "Spokane Falls Community College", "Spokane", "Bigfoot",
             "Spokane", "WA", conf_ids["NWAC-E"], None),
            ("Treasure Valley Chukars", "Treasure Valley Community College", "Treasure Valley", "Chukars",
             "Ontario", "OR", conf_ids["NWAC-E"], None),
            ("Walla Walla Warriors", "Walla Walla Community College", "Walla Walla", "Warriors",
             "Walla Walla", "WA", conf_ids["NWAC-E"], None),
            ("Wenatchee Valley Knights", "Wenatchee Valley College", "Wenatchee Valley", "Knights",
             "Wenatchee", "WA", conf_ids["NWAC-E"], None),
            ("Yakima Valley Yaks", "Yakima Valley College", "Yakima Valley", "Yaks",
             "Yakima", "WA", conf_ids["NWAC-E"], None),
            ("Blue Mountain Timberwolves", "Blue Mountain Community College", "Blue Mountain", "Timberwolves",
             "Pendleton", "OR", conf_ids["NWAC-E"], None),

            # --- NWAC South ---
            ("Chemeketa Storm", "Chemeketa Community College", "Chemeketa", "Storm",
             "Salem", "OR", conf_ids["NWAC-S"], None),
            ("Clackamas Cougars", "Clackamas Community College", "Clackamas", "Cougars",
             "Oregon City", "OR", conf_ids["NWAC-S"], None),
            ("Lane Titans", "Lane Community College", "Lane", "Titans",
             "Eugene", "OR", conf_ids["NWAC-S"], None),
            ("Linn-Benton Roadrunners", "Linn-Benton Community College", "Linn-Benton", "Roadrunners",
             "Albany", "OR", conf_ids["NWAC-S"], None),
            ("Mt. Hood Saints", "Mt. Hood Community College", "Mt. Hood", "Saints",
             "Gresham", "OR", conf_ids["NWAC-S"], None),
            ("SW Oregon Lakers", "Southwestern Oregon Community College", "SW Oregon", "Lakers",
             "Coos Bay", "OR", conf_ids["NWAC-S"], None),
            ("Umpqua Riverhawks", "Umpqua Community College", "Umpqua", "Riverhawks",
             "Roseburg", "OR", conf_ids["NWAC-S"], None),

            # --- NWAC West ---
            ("Centralia Blazers", "Centralia College", "Centralia", "Blazers",
             "Centralia", "WA", conf_ids["NWAC-W"], None),
            ("Clark Penguins", "Clark College", "Clark", "Penguins",
             "Vancouver", "WA", conf_ids["NWAC-W"], None),
            ("Grays Harbor Chokers", "Grays Harbor College", "Grays Harbor", "Chokers",
             "Aberdeen", "WA", conf_ids["NWAC-W"], None),
            # Green River no longer has a baseball program (discontinued ~2022)
            ("Olympic Rangers", "Olympic College", "Olympic", "Rangers",
             "Bremerton", "WA", conf_ids["NWAC-W"], None),
            ("Pierce Raiders", "Pierce College", "Pierce", "Raiders",
             "Puyallup", "WA", conf_ids["NWAC-W"], None),
            ("Lower Columbia Red Devils", "Lower Columbia College", "Lower Columbia", "Red Devils",
             "Longview", "WA", conf_ids["NWAC-W"], None),
            ("Tacoma Titans", "Tacoma Community College", "Tacoma", "Titans",
             "Tacoma", "WA", conf_ids["NWAC-W"], None),
        ]

        for team in teams:
            conn.execute(
                """INSERT OR IGNORE INTO teams
                   (name, school_name, short_name, mascot, city, state,
                    conference_id, stats_url)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                team,
            )

    print(f"Seeded {len(teams)} teams across {len(conferences)} conferences")


if __name__ == "__main__":
    init_db()
    seed_divisions_and_conferences()
