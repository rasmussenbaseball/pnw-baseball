#!/usr/bin/env python3
"""
Quick diagnostic: dump all HTML tables found on D1 stats pages
to see why pitching tables aren't being detected.
"""
import requests
import time
import random
from bs4 import BeautifulSoup

URLS = {
    "UW": "https://gohuskies.com/sports/baseball/stats/2026",
    "Gonzaga": "https://gozags.com/sports/baseball/stats/2026",  # This one WORKS for comparison
    "Seattle U (new)": "https://goseattleu.com/sports/baseball/stats/season/2026",
}

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"

for label, url in URLS.items():
    print(f"\n{'='*70}")
    print(f"  {label}: {url}")
    print(f"{'='*70}")
    try:
        resp = requests.get(url, headers={"User-Agent": UA}, timeout=30)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        tables = soup.find_all("table")
        print(f"\n  Found {len(tables)} <table> elements total\n")

        for i, table in enumerate(tables):
            # Get heading context
            heading = ""
            caption = table.find("caption")
            if caption:
                heading = caption.get_text(strip=True)[:80]
            if not heading:
                prev = table.find_previous(["h2", "h3", "h4", "caption", "div"])
                if prev:
                    heading = prev.get_text(strip=True)[:80]

            # Get header row
            thead = table.find("thead")
            if thead:
                headers = [c.get_text(strip=True) for c in thead.find_all(["th", "td"])]
            else:
                first_row = table.find("tr")
                headers = [c.get_text(strip=True) for c in first_row.find_all(["th", "td"])] if first_row else []

            # Count rows
            tbody = table.find("tbody")
            row_count = len(tbody.find_all("tr")) if tbody else len(table.find_all("tr")) - 1

            # Check our detection criteria
            header_text = " ".join(headers).lower()
            is_batting = "avg" in header_text and "ab" in header_text and "era" not in header_text
            is_pitching = "era" in header_text and "ip" in header_text

            tag = ""
            if is_batting:
                tag = " *** BATTING ***"
            elif is_pitching:
                tag = " *** PITCHING ***"

            print(f"  Table #{i}: {row_count} rows | heading: '{heading[:60]}'")
            print(f"    Headers: {headers[:15]}")
            print(f"    Detection: batting={is_batting} pitching={is_pitching}{tag}")
            print()

        # Also check for sections/divs that might contain stats in non-table format
        pitching_sections = soup.find_all(["section", "div"], id=lambda x: x and "pitch" in x.lower() if x else False)
        if pitching_sections:
            print(f"  Found {len(pitching_sections)} sections with 'pitch' in id:")
            for sec in pitching_sections:
                print(f"    id='{sec.get('id')}' class='{' '.join(sec.get('class', []))}'")
                inner_tables = sec.find_all("table")
                print(f"    Contains {len(inner_tables)} tables")

        # Check for sections by class name
        pitch_class_sections = soup.find_all(["section", "div"], class_=lambda x: x and any("pitch" in c.lower() for c in x) if x else False)
        if pitch_class_sections:
            print(f"  Found {len(pitch_class_sections)} sections with 'pitch' in class:")
            for sec in pitch_class_sections[:3]:
                print(f"    tag={sec.name} class='{' '.join(sec.get('class', []))}' id='{sec.get('id', '')}'")

    except Exception as e:
        print(f"  ERROR: {e}")

    time.sleep(2)

print("\n\nDone!")
