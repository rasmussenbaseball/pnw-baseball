#!/usr/bin/env python3
"""Debug v6: Extract INDIVIDUAL player pitching stats from Nuxt payload."""
import requests, json
from bs4 import BeautifulSoup

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
resp = requests.get("https://gohuskies.com/sports/baseball/stats/2026", headers={"User-Agent": UA}, timeout=30)
soup = BeautifulSoup(resp.text, "html.parser")
nuxt = soup.find("script", id="__NUXT_DATA__")
data = json.loads(nuxt.string)

def resolve(idx, depth=0):
    if depth > 5 or not isinstance(idx, int) or idx >= len(data):
        return idx  # return as-is if not a valid index
    val = data[idx]
    if isinstance(val, (str, int, float, bool)) or val is None:
        return val
    if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str) and val[0] in ("ShallowReactive", "Reactive", "ShallowRef"):
        return resolve(val[1], depth + 1)
    return val

# Find individual player pitching stats (have BOTH playerName AND earnedRunAverage)
player_pitching = []
for idx, item in enumerate(data):
    if isinstance(item, dict) and "playerName" in item and "earnedRunAverage" in item:
        player_pitching.append((idx, item))

print(f"Found {len(player_pitching)} individual player pitching stat objects\n")

if player_pitching:
    # Show ALL keys of first NON-footer one
    for idx, obj in player_pitching:
        is_footer = resolve(obj.get("isAFooterStat", 0))
        if is_footer:
            continue
        print(f"Sample player object at [{idx}] — ALL {len(obj)} keys:")
        for k, v in obj.items():
            resolved = resolve(v)
            print(f"  {k:35s} -> ref[{v}] = {repr(resolved)[:80]}")
        break

    # Print all resolved player rows
    print(f"\n{'='*100}")
    print(f"{'Player':25s} {'ERA':>7s} {'WHIP':>7s} {'W':>3s} {'L':>3s} {'APP':>4s} {'GS':>3s} {'IP':>7s} {'H':>4s} {'ER':>4s} {'BB':>4s} {'SO':>4s} {'HR':>4s} {'SV':>3s} {'HBP':>4s} {'CG':>3s}")
    print(f"{'='*100}")
    for idx, obj in player_pitching:
        is_footer = resolve(obj.get("isAFooterStat", 0))
        if is_footer:
            continue
        name = resolve(obj.get("playerName", 0)) or "?"
        era = resolve(obj.get("earnedRunAverage", 0)) or "0"
        whip = resolve(obj.get("whip", 0)) or "0"
        w = resolve(obj.get("wins", 0)) or "0"
        l = resolve(obj.get("losses", 0)) or "0"
        app = resolve(obj.get("gamesPlayed", 0)) or "0"
        gs = resolve(obj.get("gamesStarted", 0)) or "0"
        ip = resolve(obj.get("inningsPitched", 0)) or "0"
        h = resolve(obj.get("hitsAllowed", 0)) or "0"
        er = resolve(obj.get("earnedRuns", 0)) or "0"
        bb = resolve(obj.get("walks", 0)) or "0"
        so = resolve(obj.get("strikeouts", 0)) or "0"
        hr = resolve(obj.get("homeRunsAllowed", 0)) or "0"
        sv = resolve(obj.get("saves", 0)) or "0"
        hbp = resolve(obj.get("hitBatters", 0)) or resolve(obj.get("hitByPitch", 0)) or "0"
        cg = resolve(obj.get("completeGames", 0)) or "0"
        print(f"  {str(name):25s} {str(era):>7s} {str(whip):>7s} {str(w):>3s} {str(l):>3s} {str(app):>4s} {str(gs):>3s} {str(ip):>7s} {str(h):>4s} {str(er):>4s} {str(bb):>4s} {str(so):>4s} {str(hr):>4s} {str(sv):>3s} {str(hbp):>4s} {str(cg):>3s}")

# Also find individual batting stats for comparison
player_batting = []
for idx, item in enumerate(data):
    if isinstance(item, dict) and "playerName" in item and "battingAverage" in item and "atBats" in item:
        player_batting.append((idx, item))
print(f"\n\nFound {len(player_batting)} individual player batting stat objects")
if player_batting:
    for idx, obj in player_batting:
        is_footer = resolve(obj.get("isAFooterStat", 0))
        if is_footer:
            continue
        print(f"Sample batting object keys: {list(obj.keys())}")
        break

print("\nDone!")
