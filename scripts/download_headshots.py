#!/usr/bin/env python3
"""
Download all player headshots locally so they load reliably.

Instead of linking to external school athletics sites (which go down frequently),
this script downloads each headshot image to frontend/public/headshots/{player_id}.jpg
and updates the database to point to the local path /headshots/{player_id}.jpg.

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/download_headshots.py
    PYTHONPATH=backend python3 scripts/download_headshots.py --division D1
    PYTHONPATH=backend python3 scripts/download_headshots.py --force  # re-download even if local file exists

Run this AFTER backfill_headshots.py has populated headshot_url with external URLs.
Safe to run repeatedly — only downloads missing headshots unless --force is used.
"""
import sys
import os
import argparse
import time
import logging
from pathlib import Path
from PIL import Image
from io import BytesIO

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import requests
from app.models.database import get_connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("download_headshots")

# Where to save headshots.
# On the server, use /opt/headshots/ (outside git repo — survives deploys).
# Locally, fall back to frontend/public/headshots/ (Vite copies public/ → dist/ on build).
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
HEADSHOT_DIR_SERVER = Path("/opt/headshots")
HEADSHOT_DIR_LOCAL = PROJECT_ROOT / "frontend" / "public" / "headshots"
HEADSHOT_DIR = HEADSHOT_DIR_SERVER if HEADSHOT_DIR_SERVER.exists() else HEADSHOT_DIR_LOCAL

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

# Max image dimensions (resize large images to save space/bandwidth)
MAX_WIDTH = 400
MAX_HEIGHT = 400
JPEG_QUALITY = 85


def download_and_save(url, dest_path):
    """Download an image URL, resize if needed, and save as JPEG."""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15, stream=True)
        resp.raise_for_status()

        # Check content type
        content_type = resp.headers.get("content-type", "")
        if "text/html" in content_type:
            # Got an HTML page instead of an image (redirect to login, 404 page, etc.)
            return False

        img_data = resp.content
        if len(img_data) < 500:
            # Too small — probably a placeholder or error
            return False

        # Open with Pillow, resize, save as JPEG
        img = Image.open(BytesIO(img_data))

        # Convert RGBA/P to RGB for JPEG
        if img.mode in ("RGBA", "P", "LA"):
            bg = Image.new("RGB", img.size, (255, 255, 255))
            if img.mode == "P":
                img = img.convert("RGBA")
            bg.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else None)
            img = bg
        elif img.mode != "RGB":
            img = img.convert("RGB")

        # Resize if too large
        if img.width > MAX_WIDTH or img.height > MAX_HEIGHT:
            img.thumbnail((MAX_WIDTH, MAX_HEIGHT), Image.LANCZOS)

        img.save(dest_path, "JPEG", quality=JPEG_QUALITY, optimize=True)
        return True

    except Exception as e:
        logger.debug(f"    Failed to download {url}: {e}")
        return False


def main(division=None, force=False, four_year_only=True):
    """Download all player headshots locally."""
    HEADSHOT_DIR.mkdir(parents=True, exist_ok=True)

    with get_connection() as conn:
        cur = conn.cursor()

        # Get players with external headshot URLs (not already local)
        query = """
            SELECT p.id, p.first_name, p.last_name, p.headshot_url,
                   t.short_name as team_name, d.level as division
            FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE p.headshot_url IS NOT NULL
              AND p.headshot_url != ''
              AND t.is_active = 1
        """
        params = []

        if four_year_only:
            query += " AND d.level != 'JUCO'"

        if division:
            query += " AND d.level = %s"
            params.append(division)

        query += " ORDER BY d.level, t.short_name, p.last_name"
        cur.execute(query, params)
        players = cur.fetchall()

        logger.info(f"Found {len(players)} players with headshot URLs")

        # Separate into already-local and needs-download
        to_download = []
        already_local = 0
        for p in players:
            url = p["headshot_url"]
            local_path = HEADSHOT_DIR / f"{p['id']}.jpg"

            if url.startswith("/headshots/"):
                # Already pointing to local path
                if local_path.exists():
                    already_local += 1
                    continue
                else:
                    # DB says local but file is missing — need to re-scrape
                    # We can't download from a local path, skip for now
                    logger.warning(f"  {p['first_name']} {p['last_name']} ({p['team_name']}) — local path set but file missing")
                    continue

            if not force and local_path.exists():
                # File exists locally but DB still points to external URL — update DB
                local_url = f"/headshots/{p['id']}.jpg"
                cur.execute(
                    "UPDATE players SET headshot_url = %s WHERE id = %s",
                    (local_url, p["id"]),
                )
                already_local += 1
                continue

            to_download.append(p)

        logger.info(f"Already local: {already_local}, to download: {len(to_download)}")
        conn.commit()

        # Download headshots
        downloaded = 0
        failed = 0
        current_team = None

        for i, p in enumerate(to_download):
            team = f"[{p['division']}] {p['team_name']}"
            if team != current_team:
                current_team = team
                logger.info(f"\n  {team}")

            url = p["headshot_url"]
            local_path = HEADSHOT_DIR / f"{p['id']}.jpg"
            local_url = f"/headshots/{p['id']}.jpg"

            success = download_and_save(url, local_path)

            if success:
                # Update database to point to local path
                cur.execute(
                    "UPDATE players SET headshot_url = %s WHERE id = %s",
                    (local_url, p["id"]),
                )
                downloaded += 1
                logger.info(f"    ✓ {p['first_name']} {p['last_name']}")
            else:
                failed += 1
                logger.debug(f"    ✗ {p['first_name']} {p['last_name']} — {url}")

            # Commit every 50 players
            if (i + 1) % 50 == 0:
                conn.commit()
                logger.info(f"  ... {i+1}/{len(to_download)} processed")

            # Be polite to servers
            time.sleep(0.2)

        conn.commit()

        # Also handle players with NO headshot_url — they need backfill_headshots.py first
        cur.execute("""
            SELECT COUNT(*) as cnt FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE (p.headshot_url IS NULL OR p.headshot_url = '')
              AND t.is_active = 1 AND d.level != 'JUCO'
        """)
        missing = cur.fetchone()["cnt"]

        logger.info(f"\n{'='*60}")
        logger.info(f"HEADSHOT DOWNLOAD COMPLETE")
        logger.info(f"  Already local: {already_local}")
        logger.info(f"  Downloaded: {downloaded}")
        logger.info(f"  Failed: {failed}")
        logger.info(f"  4-year players with no headshot URL: {missing}")
        if missing > 0:
            logger.info(f"  → Run backfill_headshots.py first to populate external URLs, then re-run this script")
        logger.info(f"{'='*60}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Download player headshots locally")
    parser.add_argument("--division", help="Only process this division (e.g., D1)")
    parser.add_argument("--force", action="store_true", help="Re-download even if local file exists")
    parser.add_argument("--include-juco", action="store_true", help="Also download JUCO headshots")
    args = parser.parse_args()
    main(division=args.division, force=args.force, four_year_only=not args.include_juco)
