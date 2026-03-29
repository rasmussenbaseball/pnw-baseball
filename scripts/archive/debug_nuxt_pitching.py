"""Debug script to extract pitching stats from Nuxt __NUXT_DATA__ payload."""
import requests
import json
from bs4 import BeautifulSoup

URL = "https://gohuskies.com/sports/baseball/stats/2026"
FALLBACK = "https://gohuskies.com/sports/baseball/stats"

headers = {"User-Agent": "Mozilla/5.0"}

for url in [URL, FALLBACK]:
    resp = requests.get(url, headers=headers, timeout=30)
    if resp.status_code != 200:
        continue

    soup = BeautifulSoup(resp.text, "html.parser")
    script_tag = soup.find("script", {"id": "__NUXT_DATA__"})
    if not script_tag or not script_tag.string:
        print("No __NUXT_DATA__ found")
        continue

    data = json.loads(script_tag.string)
    print(f"Array length: {len(data)}")

    # Find "pitching" key and its index reference
    for i, item in enumerate(data):
        if item == "pitching":
            ref = data[i + 1]  # Next item is usually the index reference
            print(f"\n'pitching' found at index {i}, references index {ref}")
            # Show what's at the referenced index
            if isinstance(ref, int) and ref < len(data):
                pitching_obj = data[ref]
                print(f"  data[{ref}] = {json.dumps(pitching_obj)[:500] if not isinstance(pitching_obj, int) else pitching_obj}")
                # If it's another reference, follow it
                if isinstance(pitching_obj, int):
                    print(f"  data[{pitching_obj}] = {json.dumps(data[pitching_obj])[:500]}")

    # Let's find the stats structure more broadly
    # Look for player-like objects with ERA, IP, etc.
    print("\n\nSearching for ERA-related data...")
    for i, item in enumerate(data):
        if item == "earnedRunAverage":
            print(f"\n'earnedRunAverage' at index {i}")
            # Show surrounding context (10 items before and after)
            start = max(0, i - 5)
            end = min(len(data), i + 10)
            for j in range(start, end):
                marker = " <<< " if j == i else ""
                print(f"  [{j}]: {json.dumps(data[j])[:120]}{marker}")

    # Look for "ip" or "inningsPitched"
    print("\n\nSearching for innings pitched field names...")
    for i, item in enumerate(data):
        if isinstance(item, str) and item.lower() in ["ip", "inningspitched", "innings_pitched", "inningspitched"]:
            print(f"  [{i}]: {item}")
            start = max(0, i - 3)
            end = min(len(data), i + 5)
            for j in range(start, end):
                print(f"    [{j}]: {json.dumps(data[j])[:120]}")

    # Look for the actual pitching player data
    # Find where individual pitching stats start
    print("\n\nLooking for pitching stat column headers...")
    for i, item in enumerate(data):
        if item == "INNINGS PITCHED":
            print(f"  'INNINGS PITCHED' at [{i}]")
        if item == "ERA":
            print(f"  'ERA' at [{i}]")
        if item == "EARNED RUN AVG":
            print(f"  'EARNED RUN AVG' at [{i}]")

    # Dump the area around index 3951 (where "pitching" pointed)
    print("\n\nData around index 3951 (pitching reference):")
    for j in range(3945, min(len(data), 4020)):
        val = data[j]
        if isinstance(val, str) and len(val) > 100:
            val = val[:100] + "..."
        print(f"  [{j}]: {json.dumps(val)}")

    break
