#!/usr/bin/env python3
"""
Debug v3: Find where D1 Sidearm sites load pitching data from.
Check for embedded JSON data, API endpoints in script tags, and
try known Sidearm API patterns.
"""
import requests
import time
import re
import json
from bs4 import BeautifulSoup

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"

def fetch(url):
    try:
        resp = requests.get(url, headers={"User-Agent": UA}, timeout=30)
        return resp
    except Exception as e:
        return None

# ============================================================
# 1. Check UW page for embedded data / API endpoints
# ============================================================
print("=" * 70)
print("1. Scanning UW stats page for data sources")
print("=" * 70)

resp = fetch("https://gohuskies.com/sports/baseball/stats/2026")
if resp and resp.status_code == 200:
    html = resp.text
    soup = BeautifulSoup(html, "html.parser")

    # Look for JSON embedded in script tags
    scripts = soup.find_all("script")
    print(f"\n  Found {len(scripts)} <script> tags")

    for i, script in enumerate(scripts):
        src = script.get("src", "")
        text = script.string or ""

        # Check for stats-related data in inline scripts
        if text and any(kw in text.lower() for kw in ["pitching", "era", "innings", "pitcher", "stats_data", "statsdata", "individual"]):
            snippet = text[:300].replace("\n", " ").strip()
            print(f"\n  Script #{i} (inline, {len(text)} chars) — CONTAINS PITCHING KEYWORDS:")
            print(f"    {snippet}...")

        # Check for stats-related JS files
        if src and any(kw in src.lower() for kw in ["stat", "baseball", "sport"]):
            print(f"\n  Script #{i} src: {src}")

    # Look for API endpoints in the HTML
    print("\n  Searching for API/AJAX endpoints in page HTML...")
    api_patterns = re.findall(r'["\'](/(?:api|services|data|ajax)[^"\']*)["\']', html)
    if api_patterns:
        print(f"  Found {len(api_patterns)} potential API paths:")
        for p in set(api_patterns):
            print(f"    {p}")

    # Look for fetch/axios/XMLHttpRequest URLs
    fetch_urls = re.findall(r'(?:fetch|axios|\.get|\.post|\.ajax)\s*\(\s*["\']([^"\']+)["\']', html)
    if fetch_urls:
        print(f"\n  Found {len(fetch_urls)} fetch/ajax calls:")
        for u in set(fetch_urls):
            print(f"    {u}")

    # Look for data attributes on stats containers
    stat_divs = soup.find_all(["div", "section"], attrs={"data-url": True})
    if stat_divs:
        print(f"\n  Found {len(stat_divs)} elements with data-url:")
        for d in stat_divs:
            print(f"    tag={d.name} id={d.get('id','')} data-url={d.get('data-url','')}")

    # Check for React/Vue data stores
    for pattern in [r'__NEXT_DATA__', r'window\.__data', r'window\.initialState', r'preloadedState',
                    r'window\.SIDEARM', r'sidearm\.stats', r'statsData']:
        matches = re.findall(rf'({pattern}\s*=\s*)', html)
        if matches:
            # Get the value
            full_match = re.search(rf'{pattern}\s*=\s*(\{{[^;]+\}}|"[^"]*"|\'[^\']*\'|\[[^\]]+\])', html)
            if full_match:
                print(f"\n  Found {pattern} data store ({len(full_match.group(1))} chars):")
                print(f"    {full_match.group(1)[:200]}...")
            else:
                print(f"\n  Found {pattern} reference but couldn't extract value")

time.sleep(2)

# ============================================================
# 2. Try common Sidearm API endpoints
# ============================================================
print("\n" + "=" * 70)
print("2. Probing Sidearm API endpoints on gohuskies.com")
print("=" * 70)

api_tries = [
    "/services/statistics.ashx?sport_id=1&year=2026",
    "/services/statistics.ashx?sport=baseball&year=2026",
    "/api/stats/baseball/2026",
    "/api/v1/stats/baseball/2026",
    "/sports/baseball/stats/2026?format=json",
    "/sports/baseball/stats/2026.json",
    "/feeds/stats/baseball",
]

for path in api_tries:
    url = f"https://gohuskies.com{path}"
    resp = fetch(url)
    if resp:
        ct = resp.headers.get("content-type", "")
        print(f"  {resp.status_code:3d} | {ct[:40]:40s} | {path}")
        if resp.status_code == 200 and "json" in ct.lower():
            print(f"       JSON RESPONSE ({len(resp.text)} bytes): {resp.text[:200]}")
    else:
        print(f"  ERR |                                         | {path}")
    time.sleep(1)

# ============================================================
# 3. Check Seattle U site structure
# ============================================================
print("\n" + "=" * 70)
print("3. Checking Seattle U site")
print("=" * 70)

resp = fetch("https://goseattleu.com/sports/baseball")
if resp and resp.status_code == 200:
    soup = BeautifulSoup(resp.text, "html.parser")
    # Find stats link
    stats_links = soup.find_all("a", href=re.compile(r"stat", re.I))
    print(f"  Found {len(stats_links)} links with 'stat' in href:")
    for link in stats_links[:10]:
        print(f"    {link.get('href', '')} — {link.get_text(strip=True)[:40]}")

    # Check page title / platform
    title = soup.find("title")
    print(f"\n  Page title: {title.get_text(strip=True) if title else 'N/A'}")

    # Check for Sidearm indicators
    if "sidearm" in resp.text.lower():
        print("  Platform: Sidearm Sports")
    elif "prestosports" in resp.text.lower() or "presto" in resp.text.lower():
        print("  Platform: PrestoSports")
    else:
        print("  Platform: Unknown")
else:
    print(f"  HTTP {resp.status_code if resp else 'ERR'} for /sports/baseball")

print("\nDone!")
