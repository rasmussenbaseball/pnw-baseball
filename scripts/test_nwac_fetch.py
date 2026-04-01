#!/usr/bin/env python3
"""
Test: use Playwright with stealth to solve AWS WAF challenge,
then fetch stats directly from the browser.
"""
import sys
import os
import time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

BASE = "https://nwacsports.com"
SEASON = "2018-19"
SLUG = "lowercolumbia"

print("=== Approach: Playwright with stealth + direct page fetch ===\n")

with sync_playwright() as p:
    # Use full chromium (not headless shell) with stealth args
    browser = p.chromium.launch(
        headless=True,
        args=[
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
        ],
    )
    context = browser.new_context(
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        viewport={"width": 1920, "height": 1080},
        locale="en-US",
        timezone_id="America/Los_Angeles",
    )

    # Remove webdriver detection
    context.add_init_script("""
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = { runtime: {} };
    """)

    page = context.new_page()

    # Step 1: Visit the main season page to warm up
    print(f"1) Visiting {BASE}/sports/bsb/{SEASON} ...")
    page.goto(f"{BASE}/sports/bsb/{SEASON}", wait_until="domcontentloaded", timeout=30000)

    # Wait for WAF to resolve — check every second for up to 15 seconds
    for i in range(15):
        title = page.title()
        print(f"   [{i+1}s] Title: {title}")
        if "human verification" not in title.lower() and title != "":
            print(f"   WAF challenge solved!")
            break
        time.sleep(1)
    else:
        print("   WAF did not resolve in 15s — checking page content anyway...")

    cookies = context.cookies()
    print(f"   Cookies: {len(cookies)}")
    for c in cookies:
        print(f"     {c['name']}")

    # Step 2: Navigate directly to the template endpoint in the browser
    url = f"{BASE}/sports/bsb/{SEASON}/teams/{SLUG}?tmpl=brief-category-template&pos=h&r=0"
    print(f"\n2) Navigating to template endpoint: {url}")
    page.goto(url, wait_until="domcontentloaded", timeout=30000)

    # Wait for content
    for i in range(10):
        content = page.content()
        if "<table" in content:
            print(f"   [{i+1}s] Got table data!")
            break
        title = page.title()
        print(f"   [{i+1}s] Waiting... title={title}, size={len(content)}")
        time.sleep(1)

    html = page.content()
    print(f"   Final page size: {len(html)} bytes")
    has_table = "<table" in html
    print(f"   Has <table>? {'YES' if has_table else 'NO'}")

    if has_table:
        soup = BeautifulSoup(html, "html.parser")
        table = soup.find("table")
        tbody = table.find("tbody") if table else None
        rows = tbody.find_all("tr") if tbody else []
        print(f"   Players found: {len(rows)}")
        if rows:
            cells = rows[0].find_all(["td", "th"])
            name = cells[1].get_text(strip=True) if len(cells) > 1 else "?"
            print(f"   First player: {name}")

        # Step 3: Try a second team to make sure session persists
        url2 = f"{BASE}/sports/bsb/{SEASON}/teams/spokane?tmpl=brief-category-template&pos=h&r=0"
        print(f"\n3) Testing second team (Spokane): {url2}")
        page.goto(url2, wait_until="domcontentloaded", timeout=30000)
        time.sleep(2)
        html2 = page.content()
        has_table2 = "<table" in html2
        if has_table2:
            soup2 = BeautifulSoup(html2, "html.parser")
            table2 = soup2.find("table")
            tbody2 = table2.find("tbody") if table2 else None
            rows2 = tbody2.find_all("tr") if tbody2 else []
            print(f"   Spokane players found: {len(rows2)}")

        print("\n>>> SUCCESS!")
    else:
        print(f"\n   Snippet: {html[:300]}")
        print("\n>>> FAILED")

    browser.close()
