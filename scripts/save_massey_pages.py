#!/usr/bin/env python3
"""
Save Massey Ratings page text for offline parsing.

Massey uses Cloudflare protection which blocks automated requests.
This script opens each Massey page in your default browser and provides
instructions for saving the page text.

Alternatively, if you have selenium installed, it can save automatically.

Usage:
    cd pnw-baseball
    python3 scripts/save_massey_pages.py
    python3 scripts/save_massey_pages.py --auto   # requires selenium + chromedriver

The saved files go into massey_data/ directory, then run:
    python3 scripts/scrape_national_ratings.py --season 2026 --massey-dir massey_data
"""

import os
import sys
import time
import argparse
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
OUTPUT_DIR = PROJECT_ROOT / "massey_data"

MASSEY_URLS = {
    "d1": "https://masseyratings.com/cbase/d1/ratings",
    "d2": "https://masseyratings.com/cbase/d2/ratings",
    "d3": "https://masseyratings.com/cbase/d3/ratings",
    "naia": "https://masseyratings.com/cbase/naia/ratings",
}


def save_with_selenium():
    """Use Selenium to automatically save page text."""
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
    except ImportError:
        print("ERROR: selenium not installed. Run: pip install selenium")
        print("Also need chromedriver: brew install chromedriver")
        return False

    OUTPUT_DIR.mkdir(exist_ok=True)

    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")

    try:
        driver = webdriver.Chrome(options=options)
    except Exception as e:
        print(f"ERROR: Could not start Chrome: {e}")
        print("Make sure chromedriver is installed: brew install chromedriver")
        return False

    for div, url in MASSEY_URLS.items():
        print(f"\n  Fetching Massey {div.upper()}: {url}")
        try:
            driver.get(url)
            # Wait for the page to load (Massey renders server-side, so just need Cloudflare)
            time.sleep(5)

            # Get the page text
            body = driver.find_element(By.TAG_NAME, "body")
            text = body.text

            if len(text) < 500:
                print(f"  WARNING: Page text too short ({len(text)} chars), may be blocked")
                continue

            filepath = OUTPUT_DIR / f"massey_{div}.txt"
            filepath.write_text(text, encoding="utf-8")
            print(f"  Saved {len(text)} chars to {filepath}")
        except Exception as e:
            print(f"  ERROR: {e}")

    driver.quit()
    print(f"\nDone! Files saved to {OUTPUT_DIR}/")
    return True


def save_manually():
    """Guide user through manually saving page text."""
    import webbrowser

    OUTPUT_DIR.mkdir(exist_ok=True)

    print("=" * 60)
    print("SAVE MASSEY RATINGS PAGE TEXT")
    print("=" * 60)
    print()
    print("For each division, I'll open the Massey page in your browser.")
    print("Then:")
    print("  1. Wait for the page to fully load")
    print("  2. Press Cmd+A (Select All)")
    print("  3. Press Cmd+C (Copy)")
    print("  4. Open a text editor, paste, and save as the filename shown")
    print()

    for div, url in MASSEY_URLS.items():
        filepath = OUTPUT_DIR / f"massey_{div}.txt"
        print(f"\n--- {div.upper()} ---")
        print(f"  URL: {url}")
        print(f"  Save as: {filepath}")

        input(f"  Press Enter to open {div.upper()} page in browser...")
        webbrowser.open(url)
        input(f"  After saving the text to {filepath.name}, press Enter to continue...")

        if filepath.exists():
            size = filepath.stat().st_size
            print(f"  ✓ Found {filepath.name} ({size} bytes)")
        else:
            print(f"  ✗ File not found yet: {filepath}")
            print(f"    You can save it later and re-run the scraper.")

    print(f"\nDone! Now run:")
    print(f"  python3 scripts/scrape_national_ratings.py --season 2026 --massey-dir massey_data")


def main():
    parser = argparse.ArgumentParser(description="Save Massey Ratings pages for offline parsing")
    parser.add_argument("--auto", action="store_true",
                       help="Use Selenium to save automatically (requires selenium + chromedriver)")
    args = parser.parse_args()

    if args.auto:
        if not save_with_selenium():
            print("\nFalling back to manual mode...")
            save_manually()
    else:
        save_manually()


if __name__ == "__main__":
    main()
