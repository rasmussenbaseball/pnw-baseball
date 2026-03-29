"""Debug script to inspect what HTML tables and data sources are available on D1 stats pages."""
import requests
import json
from bs4 import BeautifulSoup

URL = "https://gohuskies.com/sports/baseball/stats/2026"
FALLBACK = "https://gohuskies.com/sports/baseball/stats"

headers = {"User-Agent": "Mozilla/5.0"}

for url in [URL, FALLBACK]:
    print(f"\n{'='*60}")
    print(f"Fetching: {url}")
    resp = requests.get(url, headers=headers, timeout=30)
    print(f"Status: {resp.status_code}")
    if resp.status_code != 200:
        continue

    html = resp.text
    soup = BeautifulSoup(html, "html.parser")

    # Check for HTML tables
    tables = soup.find_all("table")
    print(f"\nHTML <table> elements found: {len(tables)}")
    for i, table in enumerate(tables):
        thead = table.find("thead")
        if thead:
            ths = [th.get_text(strip=True) for th in thead.find_all("th")]
            print(f"  Table {i}: headers = {ths[:15]}...")
        else:
            print(f"  Table {i}: no <thead>")
        tbody = table.find("tbody")
        if tbody:
            rows = tbody.find_all("tr")
            print(f"    Body rows: {len(rows)}")

    # Check for __NUXT_DATA__ script
    nuxt_tag = soup.find("script", {"id": "__NUXT_DATA__"})
    if nuxt_tag:
        print(f"\n__NUXT_DATA__ script found, length: {len(nuxt_tag.string or '')}")
        try:
            data = json.loads(nuxt_tag.string)
            print(f"  Parsed JSON array length: {len(data)}")
            # Look for pitching-related strings
            pitching_indices = []
            for i, item in enumerate(data):
                if isinstance(item, str) and any(k in item.lower() for k in ["era", "pitching", "ip", "innings"]):
                    pitching_indices.append((i, item[:80]))
            print(f"  Pitching-related strings found: {len(pitching_indices)}")
            for idx, val in pitching_indices[:20]:
                print(f"    [{idx}]: {val}")
        except Exception as e:
            print(f"  Parse error: {e}")
    else:
        print("\nNo __NUXT_DATA__ script found")

    # Check for Sidearm JSON/API patterns
    # Look for script tags that might contain stats data
    scripts = soup.find_all("script")
    print(f"\nTotal <script> tags: {len(scripts)}")
    for i, script in enumerate(scripts):
        src = script.get("src", "")
        if "stats" in src.lower() or "wmt" in src.lower():
            print(f"  Script {i} src: {src}")
        text = script.string or ""
        if "pitching" in text.lower() and len(text) > 50:
            print(f"  Script {i} contains 'pitching', length: {len(text)}")
            # Show a snippet around "pitching"
            idx = text.lower().find("pitching")
            start = max(0, idx - 100)
            end = min(len(text), idx + 200)
            print(f"    Snippet: ...{text[start:end]}...")

    # Check for API-style fetch URLs in the HTML
    import re
    api_urls = re.findall(r'https?://[^\s"\']+(?:stats|pitching|baseball)[^\s"\']*', html)
    if api_urls:
        print(f"\nAPI-like URLs found in HTML:")
        for u in set(api_urls)[:10]:
            print(f"  {u}")

    break  # Only check first successful URL
