#!/usr/bin/env python3
"""
Debug v4: Extract Nuxt payload data from UW stats page to understand
the pitching data structure.
"""
import requests
import json
import re
from bs4 import BeautifulSoup

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"

resp = requests.get("https://gohuskies.com/sports/baseball/stats/2026",
                     headers={"User-Agent": UA}, timeout=30)
soup = BeautifulSoup(resp.text, "html.parser")

# Find the Nuxt data payload
# Method 1: Look for <script id="__NUXT_DATA__" type="application/json">
nuxt_script = soup.find("script", id="__NUXT_DATA__")
if nuxt_script:
    print("Found __NUXT_DATA__ script tag")
    raw = nuxt_script.string
    print(f"Length: {len(raw)} chars")
    print(f"First 500: {raw[:500]}")
    print()

# Method 2: Find the big inline script with ShallowReactive
for i, script in enumerate(soup.find_all("script")):
    text = script.string or ""
    if len(text) > 10000 and "ShallowReactive" in text:
        print(f"Found large inline script #{i} ({len(text)} chars)")

        # Try to extract JSON array
        # Nuxt devalue format starts with [
        json_match = re.search(r'^\s*(\[.+\])\s*$', text, re.DOTALL)
        if json_match:
            try:
                data = json.loads(json_match.group(1))
                print(f"Parsed as JSON array with {len(data)} elements")

                # Find all string elements that look like pitching stats headers
                pitching_keywords = []
                for idx, item in enumerate(data):
                    if isinstance(item, str) and item.lower() in ("era", "whip", "ip", "so", "bb",
                            "w-l", "app-gs", "cg", "sho", "sv", "pitcher", "pitching"):
                        pitching_keywords.append((idx, item))

                print(f"\nPitching-related string elements:")
                for idx, val in pitching_keywords[:20]:
                    print(f"  [{idx}] = '{val}'")

                # Find what looks like player name patterns near pitching data
                # Look for "Last, First" patterns
                name_indices = []
                for idx, item in enumerate(data):
                    if isinstance(item, str) and "," in item and len(item) < 40:
                        # Could be a player name
                        parts = item.split(",")
                        if len(parts) == 2 and parts[0].strip().isalpha() and len(parts[1].strip()) > 1:
                            name_indices.append((idx, item))

                print(f"\nPotential player names ({len(name_indices)} found):")
                for idx, val in name_indices[:10]:
                    print(f"  [{idx}] = '{val}'")

                # Look for "Individual Overall Pitching" or similar section markers
                for idx, item in enumerate(data):
                    if isinstance(item, str) and "pitch" in item.lower() and len(item) < 100:
                        print(f"\n  Pitching section marker [{idx}] = '{item}'")

                # Try to find a data structure that looks like a stats table
                # Look for objects/dicts that have ERA-like float values
                print(f"\nSearching for stat-like objects...")
                for idx, item in enumerate(data):
                    if isinstance(item, dict):
                        keys = set(item.keys())
                        if any(k.lower() in ("era", "ip", "whip") for k in keys):
                            print(f"  [{idx}] dict with keys: {list(item.keys())[:15]}")
                            vals = {k: item[k] for k in list(item.keys())[:10]}
                            print(f"         values: {vals}")
                            break

                # Dump a section of data around the first "ERA" occurrence
                for idx, item in enumerate(data):
                    if isinstance(item, str) and item == "ERA":
                        start = max(0, idx - 5)
                        end = min(len(data), idx + 30)
                        print(f"\nData around first 'ERA' (indices {start}-{end}):")
                        for j in range(start, end):
                            print(f"  [{j}] = {repr(data[j])[:100]}")
                        break

            except json.JSONDecodeError as e:
                print(f"Failed to parse as JSON: {e}")

                # Try to find pitching data via regex in the raw text
                print("\nSearching raw text for pitching patterns...")
                era_matches = list(re.finditer(r'"ERA"', text))
                print(f"Found {len(era_matches)} 'ERA' occurrences")
                if era_matches:
                    pos = era_matches[0].start()
                    context = text[max(0,pos-200):pos+200]
                    print(f"Context around first ERA:\n{context}")

        else:
            # Not a simple JSON array — check what format it is
            print(f"Not a simple JSON array. First 300 chars:")
            print(text[:300])

            # Search for pitching data patterns
            era_positions = [m.start() for m in re.finditer(r'ERA', text)]
            print(f"\nFound 'ERA' at {len(era_positions)} positions")
            if era_positions:
                pos = era_positions[0]
                print(f"Context ({pos-100} to {pos+300}):")
                print(text[max(0,pos-100):pos+300])

        break

print("\nDone!")
