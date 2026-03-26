#!/usr/bin/env python3
"""Debug v5: Dump full pitching object keys and a resolved sample row."""
import requests, json
from bs4 import BeautifulSoup

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
resp = requests.get("https://gohuskies.com/sports/baseball/stats/2026", headers={"User-Agent": UA}, timeout=30)
soup = BeautifulSoup(resp.text, "html.parser")
nuxt = soup.find("script", id="__NUXT_DATA__")
data = json.loads(nuxt.string)

def resolve(idx, depth=0):
    """Resolve a devalue reference index to its actual value."""
    if depth > 5 or idx >= len(data):
        return None
    val = data[idx]
    if isinstance(val, (str, int, float, bool)) or val is None:
        return val
    if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str) and val[0] in ("ShallowReactive", "Reactive", "ShallowRef"):
        return resolve(val[1], depth + 1)
    return val

# Find ALL pitching stat objects (have earnedRunAverage key)
pitching_objects = []
for idx, item in enumerate(data):
    if isinstance(item, dict) and "earnedRunAverage" in item:
        pitching_objects.append((idx, item))

print(f"Found {len(pitching_objects)} pitching stat objects\n")

# Show FULL keys of first one
if pitching_objects:
    idx, obj = pitching_objects[0]
    print(f"Object at [{idx}] — ALL {len(obj)} keys:")
    for k, v in obj.items():
        resolved = resolve(v) if isinstance(v, int) else v
        print(f"  {k:30s} -> ref[{v}] = {repr(resolved)[:80]}")

    # Show all resolved pitching rows (non-footer)
    print(f"\n{'='*80}")
    print("All pitching rows:")
    print(f"{'='*80}")
    for idx, obj in pitching_objects:
        is_footer = resolve(obj.get("isAFooterStat", 0))
        if is_footer:
            continue
        name = resolve(obj.get("playerName", 0))
        era = resolve(obj.get("earnedRunAverage", 0))
        ip = resolve(obj.get("inningsPitched", 0))
        w = resolve(obj.get("wins", 0))
        l = resolve(obj.get("losses", 0))
        k = resolve(obj.get("strikeouts", 0))
        print(f"  {str(name):25s} ERA:{era:8s} IP:{ip:8s} W-L:{w}-{l} SO:{k}")

# Also check for batting stat objects
batting_objects = []
for idx, item in enumerate(data):
    if isinstance(item, dict) and "battingAverage" in item:
        batting_objects.append((idx, item))
print(f"\n\nFound {len(batting_objects)} batting stat objects")
if batting_objects:
    idx, obj = batting_objects[0]
    print(f"First batting object keys: {list(obj.keys())}")

print("\nDone!")
