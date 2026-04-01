# Backfill Roster & Coaching Script

**Location:** `scripts/backfill_roster_coaching.py`

## Overview

Complete production-ready script for scraping and backfilling:
1. **Roster bio data** - updates existing player records with hometown, height, weight, high_school, previous_school
2. **Coaching staff** - scrapes coaching data and populates the `coaches` table (auto-creates if missing)

## Features

- **Three parsing strategies** for each data type (roster/coaches):
  1. JSON endpoint (fastest, most reliable)
  2. HTML parsing with BeautifulSoup
  3. Nuxt 3 devalue payload parsing (for modern SSR sites)

- **Smart fallback chain** - tries JSON first, falls back to HTML, then Nuxt payload
- **Nuxt devalue resolution** - full recursive index resolution for Nuxt `__NUXT_DATA__` payloads (copied from `scrape_d1.py`)
- **Rate limiting** - 2-3 second delays between requests, rotating user agents
- **Graceful error handling** - logs warnings but continues processing
- **Non-destructive updates** - only updates player fields that are currently NULL
- **On-conflict upsert** - coaches table supports updates on duplicate (team_id, name, season)

## Usage

### Run all teams, both roster and coaches
```bash
cd pnw-baseball
PYTHONPATH=backend python3 scripts/backfill_roster_coaching.py
```

### Roster only (skip coaches)
```bash
PYTHONPATH=backend python3 scripts/backfill_roster_coaching.py --roster-only
```

### Coaches only (skip roster)
```bash
PYTHONPATH=backend python3 scripts/backfill_roster_coaching.py --coaches-only
```

### Single team
```bash
PYTHONPATH=backend python3 scripts/backfill_roster_coaching.py --team Oregon
PYTHONPATH=backend python3 scripts/backfill_roster_coaching.py --team Oregon --coaches-only
```

### Custom season
```bash
PYTHONPATH=backend python3 scripts/backfill_roster_coaching.py --season 2025
```

## Database Schema

### Coaches Table (auto-created)
```sql
CREATE TABLE coaches (
    id SERIAL PRIMARY KEY,
    team_id INTEGER REFERENCES teams(id),
    name TEXT NOT NULL,
    title TEXT,
    role TEXT,  -- 'head_coach', 'assistant', 'pitching', 'hitting', 'volunteer'
    photo_url TEXT,
    email TEXT,
    phone TEXT,
    bio TEXT,
    alma_mater TEXT,
    years_at_school INTEGER,
    season INTEGER DEFAULT 2026,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(team_id, name, season)
);
```

### Player Updates
The script updates these columns if NULL:
- `hometown` - extracted from roster bio
- `height` - formatted as "5-10"
- `weight` - integer
- `high_school` - high school name
- `previous_school` - college transfer school name

## Implementation Details

### Roster Parsing (14 functions)

**Nuxt parsing:** `parse_nuxt_roster(html, base_url)`
- Extracts from `__NUXT_DATA__` script tag
- Uses `_nuxt_resolve()` for index-based reference deref
- Returns dict of {name_lower: {hometown, height, weight, high_school, previous_school}}

**HTML parsing:** `parse_roster_html(html, base_url)`
- Looks for `.sidearm-roster*` class containers
- Searches for text labels like "hometown", "high school"
- Parses "5-10, 185" format for height/weight

**JSON fallback:** `fetch_json()` + JSON parsing
- Tries `{roster_url}/{season}?json` endpoint
- Handles both list and `{"roster": [...]}` formats

### Coaching Parsing (14 functions)

**Nuxt parsing:** `parse_nuxt_coaches(html, base_url)`
- Finds coach objects in `__NUXT_DATA__` (have firstName/lastName but NOT batting/pitching stats)
- Infers role from title (head_coach, pitching, hitting, assistant, volunteer)
- Resolves relative photo URLs to absolute

**HTML parsing:** `parse_coaches_html(html, base_url)`
- Looks for `.sidearm*coach*` or `.coach*card` classes
- Extracts email from `mailto:` links, phone from `tel:` links
- Parses title to infer role

**JSON fallback:** Tries `{coaches_url}?json` endpoint

### Database Operations

**`create_coaches_table()`**
- Creates coaches table with UNIQUE constraint on (team_id, name, season)
- Uses ON CONFLICT DO UPDATE for upserts

**`upsert_coaches(team_id, coaches_list, season)`**
- Inserts or updates coaches
- Updates all fields except team_id/name/season on conflict

**`update_player_roster_fields(team_id, roster_dict, season)`**
- Updates player records with bio data
- Only updates NULL fields (non-destructive)
- Returns counts: (hometown_updated, dimensions_updated, school_updated)

## HTTP Handling

- **Session pooling** - reuses `requests.Session()` for connection pooling
- **Rate limiting** - global `_rate_limit()` enforces 2-3 second delays
- **User-agent rotation** - randomly picks from 3 common user agents
- **Retries** - 3 retries with exponential backoff for fetches
- **Timeouts** - 30-second timeout per request

## Error Handling

- **Graceful failures** - logs warnings but continues processing
- **Missing fields** - None values are safe (stored as NULL in DB)
- **Parsing errors** - wrapped in try/except, logs debug info
- **Network errors** - retried 3 times, then skipped
- **Duplicate coaches** - checked with `seen_names` set to avoid duplicates within page

## Output

Prints summary:
```
[1/50] University of Washington
  Scraping roster from https://gohuskies.com/sports/baseball/roster/2026
    JSON: found 40 players
  Updated 25 players with hometown data
  Updated 30 players with height/weight
  Scraping coaches from https://gohuskies.com/sports/baseball/coaches
    JSON: found 8 coaches

...

============================================================
SUMMARY:
  Updated 1200 players with hometown data
  Updated 1300 players with height/weight
  Updated 800 players with high school data
  Scraped/updated 320 coaches
============================================================
```

## Limitations & Notes

- **Roster matching** - matches players by `{first} {last}`.lower(), so names must be reasonably standard
- **Photo URLs** - automatically converts relative URLs (`/image/...`) to absolute using base_url
- **Role inference** - inferred from title text (may need manual correction for non-standard titles)
- **Rate limiting** - 2-3 second delays to respect server resources
- **Nuxt payloads** - only dereferences simple values (strings, ints, bools); complex objects are skipped

## Testing

Dry-run a single team:
```bash
PYTHONPATH=backend python3 scripts/backfill_roster_coaching.py --team UW --coaches-only
```

Then check results:
```sql
SELECT COUNT(*) FROM coaches WHERE team_id = (SELECT id FROM teams WHERE short_name = 'UW');
```

## Future Enhancements

- Add `--dry-run` flag to preview changes without committing
- Cache Nuxt payloads for faster iteration
- Add `--force-overwrite` to update non-NULL fields
- Parse alma_mater from coach bios with regex
- Auto-detect role more intelligently (title keywords + organizational position)
