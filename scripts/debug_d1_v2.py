#!/usr/bin/env python3
"""
Debug v2: Try alternate URL patterns for D1 pitching data.
"""
import requests
import time
from bs4 import BeautifulSoup

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"

def count_tables(url, label=""):
    try:
        resp = requests.get(url, headers={"User-Agent": UA}, timeout=30)
        if resp.status_code != 200:
            print(f"  {label:20} {url}  => HTTP {resp.status_code}")
            return
        soup = BeautifulSoup(resp.text, "html.parser")
        tables = soup.find_all("table")
        # Check for pitching table
        has_pitching = False
        pitching_rows = 0
        for t in tables:
            thead = t.find("thead")
            if thead:
                ht = " ".join(c.get_text(strip=True) for c in thead.find_all(["th","td"])).lower()
                if "era" in ht and "ip" in ht:
                    tbody = t.find("tbody")
                    pitching_rows = len(tbody.find_all("tr")) if tbody else 0
                    has_pitching = True
                    break
        batting_rows = 0
        for t in tables:
            thead = t.find("thead")
            if thead:
                ht = " ".join(c.get_text(strip=True) for c in thead.find_all(["th","td"])).lower()
                if "avg" in ht and "ab" in ht and "era" not in ht:
                    tbody = t.find("tbody")
                    batting_rows = len(tbody.find_all("tr")) if tbody else 0
                    break
        print(f"  {label:20} {url}")
        print(f"    => {len(tables)} tables | batting: {batting_rows} rows | pitching: {'YES ' + str(pitching_rows) + ' rows' if has_pitching else 'NO'}")
    except Exception as e:
        print(f"  {label:20} {url}  => ERROR: {e}")
    time.sleep(1.5)


print("=" * 70)
print("UW — trying URL variations")
print("=" * 70)
base = "https://gohuskies.com"
count_tables(f"{base}/sports/baseball/stats/2026", "default")
count_tables(f"{base}/sports/baseball/stats/2026?print=true", "print=true")
count_tables(f"{base}/sports/baseball/stats/2026?view=0", "view=0")
count_tables(f"{base}/sports/baseball/stats", "no year")

# Also try fetching with Accept header that might trigger full HTML
try:
    resp = requests.get(
        f"{base}/sports/baseball/stats/2026",
        headers={
            "User-Agent": UA,
            "Accept": "text/html",
            "X-Requested-With": "XMLHttpRequest",
        },
        timeout=30,
    )
    soup = BeautifulSoup(resp.text, "html.parser")
    tables = soup.find_all("table")
    print(f"  {'XHR request':20} => {len(tables)} tables")

    # Check what's INSIDE the pitching section
    sec = soup.find(id="individual-overall-pitching")
    if sec:
        inner_html = str(sec)
        print(f"\n  Pitching section HTML ({len(inner_html)} chars):")
        print(f"  {inner_html[:500]}")
        inner_tables = sec.find_all("table")
        print(f"\n  Tables inside section: {len(inner_tables)}")
        if inner_tables:
            for it in inner_tables:
                th = it.find("thead")
                if th:
                    headers = [c.get_text(strip=True) for c in th.find_all(["th","td"])]
                    print(f"    Headers: {headers[:10]}")
    else:
        print("  No section with id='individual-overall-pitching' found")
except Exception as e:
    print(f"  XHR request ERROR: {e}")

print()
print("=" * 70)
print("Seattle U — trying URL variations")
print("=" * 70)
base = "https://goseattleu.com"
count_tables(f"{base}/sports/baseball/stats/2026", "stats/2026")
count_tables(f"{base}/sports/baseball/stats/season/2026", "stats/season/2026")
count_tables(f"{base}/sports/baseball/stats", "stats (no year)")
count_tables(f"{base}/sports/bsb/stats/2026", "bsb/stats/2026")
count_tables(f"{base}/sports/bsb/stats", "bsb/stats")

print("\nDone!")
