#!/usr/bin/env python3
"""
Download all NWAC team logos locally and update the database.
Run this from the project root: python scripts/download_nwac_logos.py
"""

import os
import sqlite3
import requests
import time

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_ROOT, "backend", "data", "pnw_baseball.db")
LOGO_DIR = os.path.join(PROJECT_ROOT, "frontend", "public", "logos", "nwac")

def main():
    os.makedirs(LOGO_DIR, exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    teams = conn.execute(
        "SELECT id, short_name, logo_url FROM teams WHERE logo_url LIKE '%nwacsports%'"
    ).fetchall()

    print(f"Found {len(teams)} NWAC teams to download logos for.\n")

    success = 0
    failed = []

    for team in teams:
        team_id = team["id"]
        short_name = team["short_name"]
        old_url = team["logo_url"]

        # Build a clean filename from the short_name
        filename = short_name.lower().replace(" ", "_").replace(".", "").replace("-", "_") + ".png"
        filepath = os.path.join(LOGO_DIR, filename)
        new_url = f"/logos/nwac/{filename}"

        print(f"  [{team_id}] {short_name}: ", end="")

        try:
            resp = requests.get(old_url, timeout=10, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
            })
            if resp.status_code == 200 and len(resp.content) > 100:
                with open(filepath, "wb") as f:
                    f.write(resp.content)
                # Update DB to use local path
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

        time.sleep(0.3)  # Be polite

    conn.commit()
    conn.close()

    print(f"\n{'='*50}")
    print(f"Done! {success}/{len(teams)} logos downloaded successfully.")

    if failed:
        print(f"\n{len(failed)} failed downloads:")
        for name, url, reason in failed:
            print(f"  - {name}: {reason}")
        print("\nFor failed logos, you may need to find alternative images.")
        print(f"Place them in: {LOGO_DIR}")
        print("Then update the DB manually or re-run this script.")
    else:
        print("All logos downloaded and database updated!")

if __name__ == "__main__":
    main()
