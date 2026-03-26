"""
Base scraper infrastructure for PNW College Baseball data collection.

Supports multiple data source formats:
- HTML table scraping (GNAC, NWC)
- PrestoSports API (NWAC, NAIA)
- Sidearm/SIDEARMSports (D1 schools)

Each scraper extends BaseScraper and implements source-specific parsing.
"""

import time
import random
import logging
import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
from pathlib import Path

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

# Respect rate limits
MIN_REQUEST_DELAY = 2.0  # seconds between requests
MAX_REQUEST_DELAY = 5.0


@dataclass
class ScrapeResult:
    """Result from a scraping operation."""
    source_url: str
    source_type: str  # 'roster', 'batting', 'pitching', 'fielding', 'standings'
    team_id: Optional[int] = None
    conference_id: Optional[int] = None
    season: Optional[int] = None
    status: str = "pending"  # 'success', 'failed', 'partial'
    records: list = field(default_factory=list)
    error_message: Optional[str] = None
    scraped_at: datetime = field(default_factory=datetime.now)

    @property
    def records_found(self) -> int:
        return len(self.records)


class BaseScraper(ABC):
    """
    Base class for all data scrapers.

    Provides:
    - Rate-limited HTTP requests with retries
    - User-agent rotation
    - Response caching
    - Error handling and logging
    - HTML parsing helpers
    """

    USER_AGENTS = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ]

    def __init__(self, cache_dir: Optional[str] = None):
        self.session = requests.Session()
        self.last_request_time = 0
        self.cache_dir = Path(cache_dir) if cache_dir else Path(__file__).parent.parent.parent / "data" / "cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _get_headers(self) -> dict:
        return {
            "User-Agent": random.choice(self.USER_AGENTS),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate",
            "Connection": "keep-alive",
        }

    def _rate_limit(self):
        """Enforce minimum delay between requests."""
        elapsed = time.time() - self.last_request_time
        delay = random.uniform(MIN_REQUEST_DELAY, MAX_REQUEST_DELAY)
        if elapsed < delay:
            time.sleep(delay - elapsed)
        self.last_request_time = time.time()

    def _cache_key(self, url: str) -> str:
        return hashlib.md5(url.encode()).hexdigest()

    def _get_cached(self, url: str, max_age_hours: int = 24) -> Optional[str]:
        """Return cached response if fresh enough."""
        cache_file = self.cache_dir / f"{self._cache_key(url)}.html"
        if cache_file.exists():
            age = time.time() - cache_file.stat().st_mtime
            if age < max_age_hours * 3600:
                return cache_file.read_text(encoding="utf-8")
        return None

    def _set_cache(self, url: str, content: str):
        cache_file = self.cache_dir / f"{self._cache_key(url)}.html"
        cache_file.write_text(content, encoding="utf-8")

    def fetch(self, url: str, use_cache: bool = True, max_retries: int = 3) -> Optional[str]:
        """
        Fetch a URL with rate limiting, caching, and retries.
        Returns HTML content or None on failure.
        """
        if use_cache:
            cached = self._get_cached(url)
            if cached:
                logger.debug(f"Cache hit: {url}")
                return cached

        for attempt in range(max_retries):
            try:
                self._rate_limit()
                response = self.session.get(
                    url,
                    headers=self._get_headers(),
                    timeout=30,
                )
                response.raise_for_status()
                content = response.text

                if use_cache:
                    self._set_cache(url, content)

                logger.info(f"Fetched: {url} ({len(content)} bytes)")
                return content

            except requests.RequestException as e:
                logger.warning(f"Attempt {attempt + 1}/{max_retries} failed for {url}: {e}")
                if attempt < max_retries - 1:
                    time.sleep(2 ** attempt)  # Exponential backoff

        logger.error(f"All retries failed for {url}")
        return None

    def parse_html(self, content: str) -> BeautifulSoup:
        """Parse HTML content into BeautifulSoup."""
        return BeautifulSoup(content, "html.parser")

    def extract_table(self, soup: BeautifulSoup, table_id: Optional[str] = None,
                      table_class: Optional[str] = None, index: int = 0) -> list[dict]:
        """
        Extract data from an HTML table into a list of dicts.

        Args:
            soup: Parsed HTML
            table_id: HTML id attribute of the table
            table_class: CSS class of the table
            index: If multiple tables match, which one to use
        """
        if table_id:
            table = soup.find("table", {"id": table_id})
        elif table_class:
            tables = soup.find_all("table", {"class": table_class})
            table = tables[index] if index < len(tables) else None
        else:
            tables = soup.find_all("table")
            table = tables[index] if index < len(tables) else None

        if not table:
            return []

        # Get headers
        headers = []
        header_row = table.find("thead")
        if header_row:
            headers = [th.get_text(strip=True) for th in header_row.find_all(["th", "td"])]
        else:
            first_row = table.find("tr")
            if first_row:
                headers = [cell.get_text(strip=True) for cell in first_row.find_all(["th", "td"])]

        # Normalize headers
        headers = [self._normalize_header(h) for h in headers]

        # Get rows
        rows = []
        tbody = table.find("tbody") or table
        for tr in tbody.find_all("tr"):
            cells = tr.find_all(["td", "th"])
            if len(cells) == len(headers):
                row = {}
                for i, cell in enumerate(cells):
                    # Check for links (player name links)
                    link = cell.find("a")
                    value = cell.get_text(strip=True)
                    row[headers[i]] = value
                    if link and link.get("href"):
                        row[f"{headers[i]}_link"] = link["href"]
                rows.append(row)

        return rows

    @staticmethod
    def _normalize_header(header: str) -> str:
        """Normalize a stat header to our standard naming."""
        mappings = {
            "AVG": "batting_avg", "BA": "batting_avg",
            "OBP": "obp", "OB%": "obp",
            "SLG": "slg", "SLG%": "slg",
            "OPS": "ops",
            "G": "games", "GP": "games",
            "GS": "games_started",
            "AB": "at_bats",
            "R": "runs",
            "H": "hits",
            "2B": "doubles",
            "3B": "triples",
            "HR": "home_runs", "HRs": "home_runs",
            "RBI": "rbi",
            "BB": "walks",
            "SO": "strikeouts", "K": "strikeouts",
            "HBP": "hit_by_pitch",
            "SF": "sacrifice_flies",
            "SH": "sacrifice_bunts", "SAC": "sacrifice_bunts",
            "SB": "stolen_bases",
            "CS": "caught_stealing",
            "GDP": "grounded_into_dp", "GIDP": "grounded_into_dp",
            "PA": "plate_appearances",
            "TB": "total_bases",
            "IBB": "intentional_walks",
            "IP": "innings_pitched",
            "W": "wins",
            "L": "losses",
            "SV": "saves",
            "CG": "complete_games",
            "SHO": "shutouts",
            "HA": "hits_allowed",
            "ER": "earned_runs",
            "ERA": "era",
            "WHIP": "whip",
            "WP": "wild_pitches",
            "BK": "balks",
            "BF": "batters_faced", "TBF": "batters_faced",
            "HLD": "holds",
            "QS": "quality_starts",
            "PO": "putouts",
            "A": "assists",
            "E": "errors",
            "DP": "double_plays",
            "FLD%": "fielding_pct", "FPCT": "fielding_pct",
            "PB": "passed_balls",
        }
        normalized = header.strip().upper()
        return mappings.get(normalized, header.lower().replace(" ", "_").replace(".", "").replace("/", "_"))

    @abstractmethod
    def scrape_batting(self, team_id: int, season: int, url: str) -> ScrapeResult:
        """Scrape batting stats for a team/season."""
        ...

    @abstractmethod
    def scrape_pitching(self, team_id: int, season: int, url: str) -> ScrapeResult:
        """Scrape pitching stats for a team/season."""
        ...

    @abstractmethod
    def scrape_roster(self, team_id: int, season: int, url: str) -> ScrapeResult:
        """Scrape roster information for a team/season."""
        ...


class HTMLTableScraper(BaseScraper):
    """Scraper for sites that use plain HTML tables (GNAC, NWC conferences)."""

    def scrape_batting(self, team_id: int, season: int, url: str) -> ScrapeResult:
        result = ScrapeResult(source_url=url, source_type="batting",
                              team_id=team_id, season=season)
        content = self.fetch(url)
        if not content:
            result.status = "failed"
            result.error_message = "Failed to fetch URL"
            return result

        soup = self.parse_html(content)
        rows = self.extract_table(soup)

        if not rows:
            result.status = "failed"
            result.error_message = "No table data found"
            return result

        result.records = rows
        result.status = "success"
        return result

    def scrape_pitching(self, team_id: int, season: int, url: str) -> ScrapeResult:
        result = ScrapeResult(source_url=url, source_type="pitching",
                              team_id=team_id, season=season)
        content = self.fetch(url)
        if not content:
            result.status = "failed"
            result.error_message = "Failed to fetch URL"
            return result

        soup = self.parse_html(content)
        rows = self.extract_table(soup)

        if not rows:
            result.status = "failed"
            result.error_message = "No table data found"
            return result

        result.records = rows
        result.status = "success"
        return result

    def scrape_roster(self, team_id: int, season: int, url: str) -> ScrapeResult:
        result = ScrapeResult(source_url=url, source_type="roster",
                              team_id=team_id, season=season)
        content = self.fetch(url)
        if not content:
            result.status = "failed"
            result.error_message = "Failed to fetch URL"
            return result

        soup = self.parse_html(content)
        rows = self.extract_table(soup)

        if not rows:
            result.status = "failed"
            result.error_message = "No roster table found"
            return result

        result.records = rows
        result.status = "success"
        return result


class PrestoSportsScraper(BaseScraper):
    """
    Scraper for PrestoSports-based sites (NWAC, NAIA).
    PrestoSports uses a consistent URL pattern and HTML structure.
    """

    def _build_stats_url(self, base_url: str, season: int, stat_type: str = "batting") -> str:
        """Build a PrestoSports stats URL."""
        # Typical pattern: /sports/bsb/{season}/teams/{team}?view=lineup&r=0&pos=h
        # or conference-wide: /sports/bsb/{season-1}-{season % 100}/overall_stats
        season_str = f"{season - 1}-{str(season)[2:]}"
        if stat_type == "batting":
            return f"{base_url}/sports/bsb/{season_str}/overall_stats?view=batting"
        elif stat_type == "pitching":
            return f"{base_url}/sports/bsb/{season_str}/overall_stats?view=pitching"
        elif stat_type == "fielding":
            return f"{base_url}/sports/bsb/{season_str}/overall_stats?view=fielding"
        return base_url

    def scrape_batting(self, team_id: int, season: int, url: str) -> ScrapeResult:
        stats_url = self._build_stats_url(url, season, "batting")
        result = ScrapeResult(source_url=stats_url, source_type="batting",
                              team_id=team_id, season=season)

        content = self.fetch(stats_url)
        if not content:
            result.status = "failed"
            result.error_message = "Failed to fetch URL"
            return result

        soup = self.parse_html(content)
        # PrestoSports typically uses class="pointed_table" or "pointed-table"
        rows = self.extract_table(soup, table_class="pointed_table")
        if not rows:
            rows = self.extract_table(soup)  # Fallback to first table

        result.records = rows
        result.status = "success" if rows else "failed"
        if not rows:
            result.error_message = "No batting data found in table"
        return result

    def scrape_pitching(self, team_id: int, season: int, url: str) -> ScrapeResult:
        stats_url = self._build_stats_url(url, season, "pitching")
        result = ScrapeResult(source_url=stats_url, source_type="pitching",
                              team_id=team_id, season=season)

        content = self.fetch(stats_url)
        if not content:
            result.status = "failed"
            result.error_message = "Failed to fetch URL"
            return result

        soup = self.parse_html(content)
        rows = self.extract_table(soup, table_class="pointed_table")
        if not rows:
            rows = self.extract_table(soup)

        result.records = rows
        result.status = "success" if rows else "failed"
        if not rows:
            result.error_message = "No pitching data found in table"
        return result

    def scrape_roster(self, team_id: int, season: int, url: str) -> ScrapeResult:
        # PrestoSports roster URL pattern
        season_str = f"{season - 1}-{str(season)[2:]}"
        roster_url = f"{url}/sports/bsb/{season_str}/roster"
        result = ScrapeResult(source_url=roster_url, source_type="roster",
                              team_id=team_id, season=season)

        content = self.fetch(roster_url)
        if not content:
            result.status = "failed"
            result.error_message = "Failed to fetch roster URL"
            return result

        soup = self.parse_html(content)
        rows = self.extract_table(soup)

        result.records = rows
        result.status = "success" if rows else "failed"
        if not rows:
            result.error_message = "No roster data found"
        return result


class SidearmScraper(BaseScraper):
    """
    Scraper for Sidearm Sports sites (most D1 athletics sites).
    These sites are JavaScript-heavy but often have a stats endpoint.
    """

    def scrape_batting(self, team_id: int, season: int, url: str) -> ScrapeResult:
        result = ScrapeResult(source_url=url, source_type="batting",
                              team_id=team_id, season=season)

        content = self.fetch(url)
        if not content:
            result.status = "failed"
            result.error_message = "Failed to fetch URL"
            return result

        soup = self.parse_html(content)

        # Sidearm often has stats in tables with specific classes
        # Try several common patterns
        for cls in ["sidearm-table", "sidearm-stats-table", None]:
            if cls:
                rows = self.extract_table(soup, table_class=cls)
            else:
                rows = self.extract_table(soup)
            if rows:
                break

        result.records = rows
        result.status = "success" if rows else "partial"
        if not rows:
            result.error_message = (
                "No batting table found - site may require JavaScript rendering. "
                "Consider using Selenium or Playwright for this source."
            )
        return result

    def scrape_pitching(self, team_id: int, season: int, url: str) -> ScrapeResult:
        result = ScrapeResult(source_url=url, source_type="pitching",
                              team_id=team_id, season=season)

        content = self.fetch(url)
        if not content:
            result.status = "failed"
            result.error_message = "Failed to fetch URL"
            return result

        soup = self.parse_html(content)
        for cls in ["sidearm-table", "sidearm-stats-table", None]:
            if cls:
                rows = self.extract_table(soup, table_class=cls)
            else:
                rows = self.extract_table(soup, index=1)  # Pitching is often 2nd table
            if rows:
                break

        result.records = rows
        result.status = "success" if rows else "partial"
        return result

    def scrape_roster(self, team_id: int, season: int, url: str) -> ScrapeResult:
        roster_url = url.replace("/stats", "/roster")
        result = ScrapeResult(source_url=roster_url, source_type="roster",
                              team_id=team_id, season=season)

        content = self.fetch(roster_url)
        if not content:
            result.status = "failed"
            result.error_message = "Failed to fetch roster URL"
            return result

        soup = self.parse_html(content)
        rows = self.extract_table(soup, table_class="sidearm-roster-table")
        if not rows:
            rows = self.extract_table(soup)

        result.records = rows
        result.status = "success" if rows else "partial"
        return result


# Factory to get the right scraper based on stats format
SCRAPER_REGISTRY = {
    "html_table": HTMLTableScraper,
    "prestosports": PrestoSportsScraper,
    "sidearm": SidearmScraper,
}


def get_scraper(stats_format: str, **kwargs) -> BaseScraper:
    """Get the appropriate scraper for a stats source format."""
    scraper_class = SCRAPER_REGISTRY.get(stats_format, HTMLTableScraper)
    return scraper_class(**kwargs)
