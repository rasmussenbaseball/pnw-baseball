#!/usr/bin/env python3
"""
Download ALL external team logos locally and update the database.
Run from project root: python3 scripts/download_all_logos.py
"""

import os
import sqlite3
import requests
import time

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_ROOT, "backend", "data", "pnw_baseball.db")
LOGO_DIR = os.path.join(PROJECT_ROOT, "frontend", "public", "logos")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
}

def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Get all teams with external (non-local) logo URLs
    teams = conn.execute(
        "SELECT id, short_name, logo_url FROM teams WHERE logo_url NOT LIKE '/logos/%'"
    ).fetchall()

    print(f"Found {len(teams)} teams with external logo URLs.\n")

    # Create subdirectory for non-NWAC logos
    other_dir = os.path.join(LOGO_DIR, "teams")
    os.makedirs(other_dir, exist_ok=True)

    success = 0
    failed = []

    for team in teams:
        team_id = team["id"]
        short_name = team["short_name"]
        old_url = team["logo_url"]

        # Determine file extension from URL
        ext = ".png"
        if ".svg" in old_url:
            ext = ".svg"

        # Clean filename
        filename = short_name.lower().replace(" ", "_").replace(".", "").replace("&", "and").replace("'", "") + ext
        filepath = os.path.join(other_dir, filename)
        new_url = f"/logos/teams/{filename}"

        # Skip if already downloaded
        if os.path.exists(filepath) and os.path.getsize(filepath) > 100:
            conn.execute("UPDATE teams SET logo_url = ? WHERE id = ?", (new_url, team_id))
            print(f"  [{team_id}] {short_name}: SKIP (already exists) -> {new_url}")
            success += 1
            continue

        print(f"  [{team_id}] {short_name}: ", end="")

        try:
            resp = requests.get(old_url, timeout=15, headers=HEADERS)
            if resp.status_code == 200 and len(resp.content) > 100:
                with open(filepath, "wb") as f:
                    f.write(resp.content)
                conn.execute(
                    "UPDATE teams SET logo_url = ? WHERE id = ?",
                    (new_url, team_id)
                )
                print(f"OK ({len(resp.content)} bytes) -> {new_url}")
                success += 1
            else:
                print(f"FAILED (status {resp.status_code}, {len(resp.content)} bytes)")
                failed.append((short_name, old_url, f"status {resp.status_code}"))
        except Exception as e:
            print(f"ERROR: {e}")
            failed.append((short_name, old_url, str(e)))

        time.sleep(0.3)

    conn.commit()
    conn.close()

    print(f"\n{'='*50}")
    print(f"Done! {success}/{len(teams)} logos downloaded successfully.")

    if failed:
        print(f"\n{len(failed)} failed downloads:")
        for name, url, reason in failed:
            print(f"  - {name}: {reason}")
            print(f"    URL: {url}")
        print(f"\nFor failed logos, manually save images to: {other_dir}")
    else:
        print("All logos downloaded and database updated!")

if __name__ == "__main__":
    main()
