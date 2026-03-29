"""Debug script to find D1 pitching stats via JSON API or Nuxt individual players."""
import requests
import json
import re
from bs4 import BeautifulSoup

BASE = "https://gohuskies.com"
headers = {"User-Agent": "Mozilla/5.0"}

# --- Approach 1: Try ?json endpoint ---
print("=" * 60)
print("APPROACH 1: ?json endpoint")
for url in [f"{BASE}/sports/baseball/stats/2026?json", f"{BASE}/sports/baseball/stats?json"]:
    print(f"\nFetching: {url}")
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        print(f"Status: {resp.status_code}, Content-Type: {resp.headers.get('Content-Type', 'unknown')}")
        if resp.status_code == 200:
            try:
                data = resp.json()
                print(f"JSON keys: {list(data.keys()) if isinstance(data, dict) else f'array[{len(data)}]'}")
                if isinstance(data, dict):
                    for k, v in data.items():
                        if isinstance(v, list):
                            print(f"  '{k}': list[{len(v)}]")
                            if v and isinstance(v[0], dict):
                                print(f"    First item keys: {list(v[0].keys())[:15]}")
                        elif isinstance(v, dict):
                            print(f"  '{k}': dict with keys {list(v.keys())[:10]}")
                        else:
                            print(f"  '{k}': {str(v)[:80]}")
            except:
                print(f"Not JSON. First 200 chars: {resp.text[:200]}")
    except Exception as e:
        print(f"Error: {e}")

# --- Approach 2: Check Nuxt data for individual player pitching stats ---
print("\n" + "=" * 60)
print("APPROACH 2: Nuxt individual player pitching data")

resp = requests.get(f"{BASE}/sports/baseball/stats/2026", headers=headers, timeout=30)
if resp.status_code != 200:
    resp = requests.get(f"{BASE}/sports/baseball/stats", headers=headers, timeout=30)

soup = BeautifulSoup(resp.text, "html.parser")
script_tag = soup.find("script", {"id": "__NUXT_DATA__"})
if script_tag and script_tag.string:
    data = json.loads(script_tag.string)

    # Look for all objects that have "inningsPitched" key (individual pitcher stats)
    print("\nObjects with 'inningsPitched' key:")
    pitcher_objects = []
    for i, item in enumerate(data):
        if isinstance(item, dict) and "inningsPitched" in item:
            pitcher_objects.append((i, item))
    print(f"Found {len(pitcher_objects)} objects")
    for idx, obj in pitcher_objects[:3]:
        print(f"\n  [{idx}]: keys = {list(obj.keys())[:15]}")
        # Resolve a few values
        ip_ref = obj.get("inningsPitched")
        if isinstance(ip_ref, int) and ip_ref < len(data):
            print(f"    IP value: data[{ip_ref}] = {data[ip_ref]}")

    # Look for player names - search for objects with firstName/lastName or name
    print("\n\nObjects with 'firstName' or 'name' key:")
    name_objects = []
    for i, item in enumerate(data):
        if isinstance(item, dict):
            if "firstName" in item or "first_name" in item or "fullName" in item:
                name_objects.append((i, item))
    print(f"Found {len(name_objects)} objects")
    for idx, obj in name_objects[:5]:
        # Resolve name fields
        resolved = {}
        for k in ["firstName", "lastName", "first_name", "last_name", "fullName", "name", "number"]:
            if k in obj:
                ref = obj[k]
                if isinstance(ref, int) and ref < len(data):
                    resolved[k] = data[ref]
                else:
                    resolved[k] = ref
        print(f"  [{idx}]: {resolved}")

    # Look for the DISPLAY column headers - "INNINGS PITCHED" was at 4533
    # Check what's around it for a pitching stats table layout
    print(f"\n\nData around 'INNINGS PITCHED' (index 4533):")
    for j in range(4520, min(len(data), 4570)):
        val = data[j]
        if isinstance(val, str):
            print(f"  [{j}]: \"{val}\"")
        elif isinstance(val, dict):
            keys = list(val.keys())[:8]
            print(f"  [{j}]: dict({keys}...)")
        else:
            print(f"  [{j}]: {val}")

    # Look for WMT team ID in the HTML
    wmt_match = re.search(r'team_id["\s:=]+(\d{5,})', resp.text)
    if wmt_match:
        print(f"\n\nWMT team ID found: {wmt_match.group(1)}")
    else:
        # Try other patterns
        wmt_match = re.search(r'WMT\.teamId\s*=\s*["\']?(\d+)', resp.text)
        if wmt_match:
            print(f"\nWMT team ID found (alt pattern): {wmt_match.group(1)}")
        else:
            print("\nNo WMT team ID found in main patterns")
            # Check for any 6-digit numbers near "team"
            matches = re.findall(r'(?:team|teamId|team_id)[^\d]{0,20}(\d{5,7})', resp.text)
            if matches:
                print(f"Potential team IDs near 'team': {matches[:5]}")
