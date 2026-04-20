"""
Generate weekly Top Performers social media graphic.

Pulls real leaderboard data from the API, injects it into the HTML template,
renders it as a PNG via Playwright, and optionally posts to X (Twitter).

Usage:
    # Generate graphic only (saves to frontend/public/social-templates/output/)
    PYTHONPATH=backend python3 scripts/generate_social_graphic.py

    # Generate and post to X
    PYTHONPATH=backend python3 scripts/generate_social_graphic.py --post-x

    # Custom season
    PYTHONPATH=backend python3 scripts/generate_social_graphic.py --season 2026
"""

import os
import sys
import json
import argparse
import asyncio
from datetime import datetime, timedelta
from pathlib import Path

# Add backend to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

from app.models.database import get_connection


# ─── Config ───
PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_DIR = PROJECT_ROOT / 'frontend' / 'public' / 'social-templates'
OUTPUT_DIR = TEMPLATE_DIR / 'output'
TEMPLATE_PATH = TEMPLATE_DIR / 'top-performers.html'

# Batting: wRC+ main, extras: PA, K%, BB%, HR, XBH (2B+3B), BB+HBP, SB, AVG
# Pitching: FIP main, extras: IP, K%, BB%, ERA, H, BB+HBP

MIN_PA = 10
MIN_IP = 4.0
TOP_N = 5
SEASON = 2026


def fetch_batting_leaders(season=SEASON, limit=TOP_N):
    """Fetch top batting performers by wRC+."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT
                p.first_name, p.last_name, p.headshot_url,
                t.short_name AS team_short, t.logo_url,
                d.name AS division_level,
                bs.plate_appearances AS pa,
                bs.k_pct,
                bs.bb_pct,
                bs.home_runs AS hr,
                (bs.doubles + bs.triples) AS xbh,
                (bs.walks + bs.hit_by_pitch) AS bb_hbp,
                bs.stolen_bases AS sb,
                bs.batting_avg AS avg,
                bs.wrc_plus
            FROM batting_stats bs
            JOIN players p ON p.id = bs.player_id
            JOIN teams t ON t.id = bs.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE bs.season = %s
              AND bs.plate_appearances >= %s
              AND bs.wrc_plus IS NOT NULL
            ORDER BY bs.wrc_plus DESC
            LIMIT %s
        """, (season, MIN_PA, limit))

        # RealDictCursor returns dicts already
        return cur.fetchall()


def fetch_pitching_leaders(season=SEASON, limit=TOP_N):
    """Fetch top pitching performers by FIP (lower is better)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT
                p.first_name, p.last_name, p.headshot_url,
                t.short_name AS team_short, t.logo_url,
                d.name AS division_level,
                ps.innings_pitched AS ip,
                ps.k_pct,
                ps.bb_pct,
                ps.era,
                ps.hits_allowed AS h,
                (ps.walks + ps.hit_batters) AS bb_hbp,
                ps.fip
            FROM pitching_stats ps
            JOIN players p ON p.id = ps.player_id
            JOIN teams t ON t.id = ps.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE ps.season = %s
              AND ps.innings_pitched >= %s
              AND ps.fip IS NOT NULL
            ORDER BY ps.fip ASC
            LIMIT %s
        """, (season, MIN_IP, limit))

        return cur.fetchall()


def fmt_avg(val):
    """Format batting average: .412"""
    if val is None:
        return '-'
    return f'.{int(round(val * 1000)):03d}' if val < 1 else f'{val:.3f}'


def fmt_pct(val):
    """Format percentage: 14.3
    Handles both 0-1 (decimal) and 0-100 (already percentage) formats.
    """
    if val is None:
        return '-'
    # If stored as decimal (0-1), multiply by 100
    if val <= 1.0:
        val = val * 100
    return f'{val:.1f}'


def fmt_era(val):
    """Format ERA/FIP: 1.42"""
    if val is None:
        return '-'
    return f'{val:.2f}'


def fmt_ip(val):
    """Format innings pitched in baseball notation: 62.1 = 62 and 1/3 innings.
    Database stores as decimal (e.g., 6.66667 = 6 and 2/3 innings = 6.2 in baseball).
    """
    if val is None:
        return '-'
    whole = int(val)
    fraction = val - whole
    # Convert fraction to outs (thirds)
    if fraction < 0.17:
        outs = 0
    elif fraction < 0.5:
        outs = 1
    else:
        outs = 2
    if outs == 0:
        return str(whole)
    return f'{whole}.{outs}'


def fmt_int(val):
    """Format integer stat."""
    if val is None:
        return '-'
    return str(int(val))


def get_division_abbrev(division_level):
    """Convert division name to short label."""
    if not division_level:
        return ''
    dl = division_level.upper()
    if 'DIVISION I' in dl and 'II' not in dl and 'III' not in dl:
        return 'D1'
    if 'DIVISION II' in dl and 'III' not in dl:
        return 'D2'
    if 'DIVISION III' in dl:
        return 'D3'
    if 'NAIA' in dl:
        return 'NAIA'
    if 'NWAC' in dl or 'NJCAA' in dl:
        return 'NWAC'
    return division_level[:4]


def get_initials(first, last):
    """Get player initials for headshot placeholder."""
    f = first[0].upper() if first else '?'
    l = last[0].upper() if last else '?'
    return f'{f}{l}'


def get_week_range():
    """Get the Monday-to-Sunday range for the current week."""
    today = datetime.now()
    # Find last Monday
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)

    mon_str = monday.strftime('%B %d').replace(' 0', ' ')
    sun_str = sunday.strftime('%B %d').replace(' 0', ' ')

    return f'Week of {mon_str} — {sun_str}'


def build_batting_row_html(player, rank):
    """Build HTML for one batting player row."""
    r_class = f'r{rank}' if rank <= 5 else 'r5'
    initials = get_initials(player['first_name'], player['last_name'])
    name = f"{player['first_name']} {player['last_name']}"
    team = player['team_short'] or ''
    div = get_division_abbrev(player.get('division_level', ''))
    logo = player.get('logo_url', '')

    # Build headshot - use actual image if available
    headshot_url = player.get('headshot_url')
    if headshot_url:
        headshot_inner = f'<img src="../../{headshot_url.lstrip("/")}" alt="">'
    else:
        headshot_inner = f'<span class="headshot-initials">{initials}</span>'

    # Logo src
    if logo and not logo.startswith('http'):
        logo_src = f'../../{logo.lstrip("/")}'
    elif logo:
        logo_src = logo
    else:
        logo_src = ''

    logo_img = f'<img class="team-logo" src="{logo_src}" alt="">' if logo_src else ''

    return f'''
      <div class="p-row {r_class}">
        <div class="row-left">
          <div class="rank-num">{rank}</div>
          <div class="headshot">{headshot_inner}</div>
          <div class="info">
            <div class="name">{name}</div>
            <div class="meta">{logo_img}<span class="team">{team}</span><span class="div-pill">{div}</span></div>
          </div>
        </div>
        <div class="stats-area">
          <div class="sv">{fmt_int(player['pa'])}</div>
          <div class="sv">{fmt_pct(player['k_pct'])}</div>
          <div class="sv">{fmt_pct(player['bb_pct'])}</div>
          <div class="sv">{fmt_int(player['hr'])}</div>
          <div class="sv">{fmt_int(player['xbh'])}</div>
          <div class="sv">{fmt_int(player['bb_hbp'])}</div>
          <div class="sv">{fmt_int(player['sb'])}</div>
          <div class="sv">{fmt_avg(player['avg'])}</div>
          <div class="sv main">{fmt_int(player['wrc_plus'])}</div>
        </div>
      </div>'''


def build_pitching_row_html(player, rank):
    """Build HTML for one pitching player row."""
    r_class = f'r{rank}' if rank <= 5 else 'r5'
    initials = get_initials(player['first_name'], player['last_name'])
    name = f"{player['first_name']} {player['last_name']}"
    team = player['team_short'] or ''
    div = get_division_abbrev(player.get('division_level', ''))
    logo = player.get('logo_url', '')

    headshot_url = player.get('headshot_url')
    if headshot_url:
        headshot_inner = f'<img src="../../{headshot_url.lstrip("/")}" alt="">'
    else:
        headshot_inner = f'<span class="headshot-initials">{initials}</span>'

    if logo and not logo.startswith('http'):
        logo_src = f'../../{logo.lstrip("/")}'
    elif logo:
        logo_src = logo
    else:
        logo_src = ''

    logo_img = f'<img class="team-logo" src="{logo_src}" alt="">' if logo_src else ''

    return f'''
      <div class="p-row {r_class}">
        <div class="row-left">
          <div class="rank-num">{rank}</div>
          <div class="headshot">{headshot_inner}</div>
          <div class="info">
            <div class="name">{name}</div>
            <div class="meta">{logo_img}<span class="team">{team}</span><span class="div-pill">{div}</span></div>
          </div>
        </div>
        <div class="stats-area">
          <div class="sv">{fmt_ip(player['ip'])}</div>
          <div class="sv">{fmt_pct(player['k_pct'])}</div>
          <div class="sv">{fmt_pct(player['bb_pct'])}</div>
          <div class="sv">{fmt_era(player['era'])}</div>
          <div class="sv">{fmt_int(player['h'])}</div>
          <div class="sv">{fmt_int(player['bb_hbp'])}</div>
          <div class="sv main">{fmt_era(player['fip'])}</div>
        </div>
      </div>'''


def build_full_html(batting_rows_html, pitching_rows_html, season, week_range):
    """Read the template and inject real data rows."""
    template = TEMPLATE_PATH.read_text()

    # We'll rebuild the dynamic portions by reading the template CSS and structure,
    # then generating a complete HTML with real data

    # Read the template to get the CSS (everything up to <body>)
    css_start = template.find('<style>')
    css_end = template.find('</style>') + len('</style>')
    css_block = template[css_start:css_end]

    # Get font links
    font_links = '''<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow+Condensed:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400;1,500;1,600;1,700;1,800&family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">'''

    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
{font_links}
{css_block}
</head>
<body>

<div class="card" id="graphic">
  <div class="bg-grid"></div>
  <div class="bg-glow-top"></div>
  <div class="bg-glow-bottom"></div>
  <div class="top-bar"></div>

  <div class="header">
    <div class="header-left">
      <div class="logo-mark">NW</div>
      <div>
        <div class="brand-name">NW Baseball Stats</div>
        <div class="brand-url">nwbaseballstats.com</div>
      </div>
    </div>
    <div class="header-right">
      <div class="season-badge">{season} Season</div>
      <div class="date-text">{week_range}</div>
    </div>
  </div>

  <div class="title-area">
    <h2>Top Performers</h2>
    <div class="title-sub">Weekly leaders across all PNW divisions</div>
  </div>
  <div class="divider"></div>

  <!-- BATTING -->
  <div class="section">
    <div class="section-header">
      <div class="section-dot"></div>
      <span class="section-text">Batting — wRC+ Leaders</span>
    </div>
    <div class="stats-table">
      <div class="col-headers">
        <div class="col-left"><span>Player</span></div>
        <div class="stats-area">
          <span class="sh">PA</span>
          <span class="sh">K%</span>
          <span class="sh">BB%</span>
          <span class="sh">HR</span>
          <span class="sh">XBH</span>
          <span class="sh">BB+HBP</span>
          <span class="sh">SB</span>
          <span class="sh">AVG</span>
          <span class="sh main">wRC+</span>
        </div>
      </div>
{batting_rows_html}
    </div>
  </div>

  <!-- PITCHING -->
  <div class="section">
    <div class="section-header">
      <div class="section-dot"></div>
      <span class="section-text">Pitching — FIP Leaders</span>
    </div>
    <div class="stats-table">
      <div class="col-headers">
        <div class="col-left"><span>Player</span></div>
        <div class="stats-area">
          <span class="sh">IP</span>
          <span class="sh">K%</span>
          <span class="sh">BB%</span>
          <span class="sh">ERA</span>
          <span class="sh">H</span>
          <span class="sh">BB+HBP</span>
          <span class="sh main">FIP</span>
        </div>
      </div>
{pitching_rows_html}
    </div>
  </div>

  <div class="footer">
    <div class="footer-brand">nwbaseballstats.com</div>
    <div class="footer-info">All Divisions &middot; Min {MIN_PA} PA / {int(MIN_IP)} IP &middot; {season} Season</div>
  </div>
</div>

</body>
</html>'''

    return html


async def render_png(html_content, output_path):
    """Render HTML to PNG using Playwright."""
    from playwright.async_api import async_playwright

    # Write temp HTML file
    temp_html = output_path.with_suffix('.html')
    temp_html.write_text(html_content)

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1080, 'height': 1080})
        await page.goto(f'file://{temp_html}')
        await page.wait_for_load_state('networkidle')

        card = page.locator('#graphic')
        await card.screenshot(path=str(output_path))

        await browser.close()

    # Clean up temp HTML
    try:
        temp_html.unlink(missing_ok=True)
    except (PermissionError, OSError):
        pass  # Non-critical cleanup

    print(f'  Graphic saved to: {output_path}')
    return output_path


def post_to_x(image_path, tweet_text):
    """Post a tweet with an image to X (Twitter)."""
    import requests
    from requests_oauthlib import OAuth1

    # Load credentials from environment
    auth = OAuth1(
        os.environ['X_CONSUMER_KEY'],
        os.environ['X_CONSUMER_SECRET'],
        os.environ['X_ACCESS_TOKEN'],
        os.environ['X_ACCESS_TOKEN_SECRET'],
    )

    # Step 1: Upload image via v1.1 media upload
    print('  Uploading image to X...')
    upload_url = 'https://upload.twitter.com/1.1/media/upload.json'

    with open(image_path, 'rb') as img_file:
        files = {'media': img_file}
        resp = requests.post(upload_url, auth=auth, files=files)

    if resp.status_code != 200:
        print(f'  ERROR: Media upload failed ({resp.status_code}): {resp.text}')
        return False

    media_id = resp.json()['media_id_string']
    print(f'  Media uploaded: {media_id}')

    # Step 2: Post tweet via v2 with media
    print('  Posting tweet...')
    tweet_url = 'https://api.twitter.com/2/tweets'

    payload = {
        'text': tweet_text,
        'media': {
            'media_ids': [media_id]
        }
    }

    resp = requests.post(
        tweet_url,
        auth=auth,
        json=payload,
        headers={'Content-Type': 'application/json'}
    )

    if resp.status_code in (200, 201):
        tweet_data = resp.json()
        tweet_id = tweet_data.get('data', {}).get('id', 'unknown')
        print(f'  Tweet posted! ID: {tweet_id}')
        print(f'  https://x.com/NWBBstats/status/{tweet_id}')
        return True
    else:
        print(f'  ERROR: Tweet failed ({resp.status_code}): {resp.text}')
        return False


def main():
    parser = argparse.ArgumentParser(description='Generate weekly Top Performers graphic')
    parser.add_argument('--season', type=int, default=SEASON, help='Season year')
    parser.add_argument('--post-x', action='store_true', help='Post to X (Twitter)')
    parser.add_argument('--tweet-text', type=str, default=None, help='Custom tweet text')
    args = parser.parse_args()

    print(f'\n=== Generating Top Performers Graphic ({args.season}) ===\n')

    # Fetch data
    print('Fetching batting leaders...')
    batters = fetch_batting_leaders(season=args.season)
    print(f'  Found {len(batters)} batting leaders')

    print('Fetching pitching leaders...')
    pitchers = fetch_pitching_leaders(season=args.season)
    print(f'  Found {len(pitchers)} pitching leaders')

    if not batters or not pitchers:
        print('ERROR: No data found. Check season and database.')
        sys.exit(1)

    # Build HTML
    print('Building graphic...')
    batting_html = '\n'.join(
        build_batting_row_html(b, i + 1) for i, b in enumerate(batters)
    )
    pitching_html = '\n'.join(
        build_pitching_row_html(p, i + 1) for i, p in enumerate(pitchers)
    )

    week_range = get_week_range()
    full_html = build_full_html(batting_html, pitching_html, args.season, week_range)

    # Render PNG
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    date_str = datetime.now().strftime('%Y-%m-%d')
    output_path = OUTPUT_DIR / f'top-performers-{date_str}.png'

    print('Rendering PNG...')
    asyncio.run(render_png(full_html, output_path))

    # Post to X
    if args.post_x:
        tweet_text = args.tweet_text or (
            f"This week's Top Performers across PNW college baseball\n\n"
            f"wRC+ and FIP leaders — all divisions, {args.season} season\n\n"
            f"Full leaderboards at nwbaseballstats.com\n\n"
            f"#CollegeBaseball #PNWBaseball #D1Baseball"
        )

        print('\nPosting to X...')
        success = post_to_x(output_path, tweet_text)
        if not success:
            sys.exit(1)

    print('\nDone!')


if __name__ == '__main__':
    main()
