"""
Quick inspection: pull HTML for one PBP-rich game and print every
italic narrative line from the play-by-play section. Pinch-runner /
courtesy-runner substitutions appear in italic text alongside
pitching changes and mound visits — we want to see the actual format
the scorers use so the regex patterns match real data.

Run on Mac (no DB writes):
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/sample_substitution_narratives.py
"""

from __future__ import annotations
import sys
import re
from html.parser import HTMLParser

import requests

from app.models.database import get_connection


SEASON = 2026


class ItalicExtractor(HTMLParser):
    """Pull every <span class="text-italic"> ... </span> body text from
    a page. That's where Sidearm puts substitution narratives."""

    def __init__(self):
        super().__init__()
        self.in_italic = 0
        self.current = []
        self.italic_lines = []

    def handle_starttag(self, tag, attrs):
        attrs_d = dict(attrs)
        cls = attrs_d.get("class", "") or ""
        if "text-italic" in cls or tag == "i" or tag == "em":
            self.in_italic += 1
            self.current = []

    def handle_endtag(self, tag):
        if self.in_italic > 0:
            self.in_italic -= 1
            if self.in_italic == 0:
                txt = "".join(self.current).strip()
                if txt:
                    self.italic_lines.append(txt)
                self.current = []

    def handle_data(self, data):
        if self.in_italic > 0:
            self.current.append(data)


def main() -> int:
    with get_connection() as conn:
        cur = conn.cursor()
        # Pick a few audit-clean games we know have rich PBP — anything
        # NCAA D2/D3/NAIA from a Sidearm site. Filter to games that
        # likely have pinch-runner subs (later innings, close scores).
        cur.execute("""
            SELECT g.id, g.source_url, g.game_date,
                   th.short_name AS home_short,
                   ta.short_name AS away_short
            FROM games g
            JOIN teams th ON th.id = g.home_team_id
            JOIN teams ta ON ta.id = g.away_team_id
            WHERE g.season = %s
              AND g.source_url IS NOT NULL
              AND g.source_url LIKE '%%/boxscore%%'
              AND g.source_url NOT LIKE '%%nwacsports%%'
              AND g.source_url NOT LIKE '%%wubearcats%%'
              AND ABS(g.home_score - g.away_score) <= 2
              AND g.id IN (SELECT DISTINCT game_id FROM game_events)
            ORDER BY g.game_date DESC
            LIMIT 3
        """, (SEASON,))
        games = list(cur.fetchall())
        if not games:
            print("No matching games found.")
            return 1

    for g in games:
        print()
        print("=" * 78)
        print(f"Game {g['id']}: {g['away_short']} @ {g['home_short']}  {g['game_date']}")
        print(f"URL: {g['source_url']}")
        print("=" * 78)
        try:
            resp = requests.get(
                g["source_url"],
                headers={"User-Agent": "Mozilla/5.0 (compatible; nwbb-stats/1.0)"},
                timeout=20,
            )
            html = resp.text
        except Exception as e:
            print(f"  fetch failed: {e}")
            continue

        # Extract italic text
        extractor = ItalicExtractor()
        extractor.feed(html)
        # Filter out pitching changes (they have a known format) and
        # show only the lines we'd otherwise be discarding.
        sub_like = []
        for line in extractor.italic_lines:
            if re.search(r"pitching change", line, re.I):
                continue
            if re.search(r"mound visit", line, re.I):
                # show these too for context
                pass
            sub_like.append(line)

        print(f"  {len(sub_like)} non-pitching-change italic lines:")
        for line in sub_like[:30]:
            print(f"    | {line}")
        if len(sub_like) > 30:
            print(f"    ... ({len(sub_like) - 30} more)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
