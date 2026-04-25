#!/usr/bin/env python3
"""
PBP coverage scan — sample 2026 Sidearm box scores by host domain
=================================================================

Hits ~5 random games from each Sidearm host domain in our 2026 game
list, checks whether `<section id="play-by-play">` is present, and
reports the rate per domain. Lets us decide whether the missing-PBP
problem is a per-school setting (some sites just don't publish it) or a
per-game accident (occasional missing scorer file).

Run from the project root:
  PYTHONPATH=backend python3 scripts/scan_pbp_coverage.py

Output: per-domain summary plus a final coverage % across the whole
sample. No database writes.
"""

import random
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

import requests

# Allow running with `PYTHONPATH=backend python3 scripts/scan_pbp_coverage.py`
from app.models.database import get_connection


SAMPLES_PER_DOMAIN = 5
MAX_WORKERS = 12  # concurrent fetches — each domain sees only ~5 requests
USER_AGENT = "Mozilla/5.0 (compatible; pnw-baseball-pbp-scan/0.1)"


def has_pbp(html):
    # Cheap substring check rather than parsing the full HTML for each page.
    return 'id="play-by-play"' in html


def main():
    random.seed(20260424)

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT source_url
            FROM games
            WHERE season = 2026
              AND source_url LIKE 'https://%/sports/baseball/stats/%/boxscore/%'
        """)
        urls_by_domain = defaultdict(list)
        for r in cur.fetchall():
            host = urlparse(r["source_url"]).netloc
            urls_by_domain[host].append(r["source_url"])

    # Sample SAMPLES_PER_DOMAIN games per domain (or all if fewer available).
    sample = []
    for host, urls in urls_by_domain.items():
        picks = random.sample(urls, min(SAMPLES_PER_DOMAIN, len(urls)))
        for u in picks:
            sample.append((host, u))

    print(f"Sampling {len(sample)} games across {len(urls_by_domain)} domains "
          f"({SAMPLES_PER_DOMAIN}/domain, {MAX_WORKERS} concurrent)")
    print()

    results = defaultdict(list)  # host -> [(url, has_pbp_bool, status_code)]
    headers = {"User-Agent": USER_AGENT}

    def fetch_one(item):
        host, url = item
        try:
            resp = requests.get(url, headers=headers, timeout=30)
            return host, url, has_pbp(resp.text), resp.status_code
        except Exception as e:
            return host, url, False, f"ERR:{type(e).__name__}"

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = [ex.submit(fetch_one, item) for item in sample]
        for i, fut in enumerate(as_completed(futures), 1):
            host, url, ok, status = fut.result()
            results[host].append((url, ok, status))
            mark = "PBP" if ok else f"no  ({status})"
            print(f"  [{i:3}/{len(sample)}] {host:40} {mark}")

    # ── Per-domain summary ──
    print()
    print("=" * 70)
    print(f"{'DOMAIN':40} {'PBP':>5} {'TOTAL':>6} {'%':>5}")
    print("=" * 70)
    full_pct_total = 0
    full_pct_count = 0
    for host in sorted(results.keys()):
        rows = results[host]
        n_pbp = sum(1 for _, ok, _ in rows if ok)
        n = len(rows)
        pct = (100 * n_pbp / n) if n else 0
        print(f"{host:40} {n_pbp:>5} {n:>6} {pct:>4.0f}%")
        full_pct_total += n_pbp
        full_pct_count += n
    print("=" * 70)
    overall = (100 * full_pct_total / full_pct_count) if full_pct_count else 0
    print(f"{'OVERALL':40} {full_pct_total:>5} {full_pct_count:>6} {overall:>4.0f}%")


if __name__ == "__main__":
    main()
