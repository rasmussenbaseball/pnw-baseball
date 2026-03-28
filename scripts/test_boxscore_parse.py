"""Quick diagnostic: test box score parsing for a single Sidearm game."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

import requests
from bs4 import BeautifulSoup
import re

url = "https://wildcatsports.com/sports/baseball/stats/2026/stanislaus-state/boxscore/11046"
print(f"Fetching: {url}")
r = requests.get(url, timeout=15)
print(f"Status: {r.status_code}, HTML length: {len(r.text)}")

soup = BeautifulSoup(r.text, "html.parser")
tables = soup.find_all("table")
print(f"\nTotal tables found by BeautifulSoup: {len(tables)}\n")

for i, t in enumerate(tables[:10]):
    thead = t.find("thead") or t.find("tr")
    if not thead:
        ht = "NONE"
    else:
        ht = thead.get_text(strip=True).lower()[:80]
    role = t.get("role", "none")
    rows = len(t.find_all("tr"))
    has_ab = "ab" in ht
    has_ip = "ip" in ht
    has_era = "era" in ht
    print(f"Table {i}: role={role}, rows={rows}, hasAB={has_ab}, hasIP={has_ip}, hasERA={has_era}")
    print(f"  header: {ht[:70]}")
    print()

# Now test _find_stat_tables logic
print("=" * 60)
print("Testing _find_stat_tables for 'batting':")
print("=" * 60)

# Method 1
batting_m1 = []
for header in soup.find_all(["h2", "h3", "h4", "caption"]):
    text = header.get_text(strip=True).lower()
    if "batting" in text:
        next_table = header.find_next("table")
        if next_table and next_table not in batting_m1:
            batting_m1.append(next_table)
            print(f"  Method1 found table via header: '{text[:50]}'")

if batting_m1:
    print(f"  Method1 found {len(batting_m1)} tables")
else:
    print("  Method1 found NOTHING, falling through to Method2...")

    batting_m2 = []
    for j, table in enumerate(tables):
        thead = table.find("thead") or table.find("tr")
        if not thead:
            continue
        header_text = thead.get_text(strip=True).lower()
        if any(kw in header_text for kw in ["ab", "at bat", "batting"]):
            if "ip" not in header_text and "era" not in header_text:
                batting_m2.append((j, table))
                print(f"  Method2 found table index {j}: header='{header_text[:60]}'")

    print(f"  Method2 found {len(batting_m2)} tables")

    if batting_m2:
        # Parse first batting table
        from scrape_boxscores import _parse_batting_table
        for idx, (j, tbl) in enumerate(batting_m2[:2]):
            players = _parse_batting_table(tbl)
            side = "away" if idx == 0 else "home"
            print(f"\n  {side} batting ({len(players)} players):")
            for p in players[:3]:
                print(f"    {p}")

print()
print("=" * 60)
print("Testing _find_stat_tables for 'pitching':")
print("=" * 60)

pitching_m1 = []
for header in soup.find_all(["h2", "h3", "h4", "caption"]):
    text = header.get_text(strip=True).lower()
    if "pitching" in text:
        next_table = header.find_next("table")
        if next_table and next_table not in pitching_m1:
            pitching_m1.append(next_table)
            print(f"  Method1 found table via header: '{text[:50]}'")

print(f"  Method1 found {len(pitching_m1)} tables")
