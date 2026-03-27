"""
Shared utility for extracting and saving team W-L records.
Used by all division scrapers (D1, D2, D3, NAIA, NWAC).
"""

import re
import logging

logger = logging.getLogger(__name__)


def extract_record_from_html(html):
    """
    Extract overall and conference W-L records from a stats/schedule page HTML.
    Works with Sidearm, PrestoSports, and most college athletics sites.

    Returns: (overall, conference) where each is (wins, losses) or None
    """
    if not html:
        return None, None

    overall = None
    conference = None

    # Method 1: Look for "Overall: 23-5" / "Conf: 12-3" patterns (most common)
    om = re.search(r'overall\s*[:\s]+(\d+)\s*-\s*(\d+)', html, re.I)
    if om:
        overall = (int(om.group(1)), int(om.group(2)))

    cm = re.search(r'(?:conf(?:erence)?|league)\s*[:\s]+(\d+)\s*-\s*(\d+)', html, re.I)
    if cm:
        conference = (int(cm.group(1)), int(cm.group(2)))

    # Method 2: Sidearm record widget — often in a class like "sidearm-schedule-record"
    if not overall:
        # Pattern: "Record: 23-5 (12-3 Conf)" or similar
        rm = re.search(r'record\s*[:\s]+(\d+)\s*-\s*(\d+)', html, re.I)
        if rm:
            overall = (int(rm.group(1)), int(rm.group(2)))

    # Method 3: PrestoSports format — "Overall 23-5-0" with optional ties
    if not overall:
        pm = re.search(r'overall\s+(\d+)\s*-\s*(\d+)(?:\s*-\s*\d+)?', html, re.I)
        if pm:
            overall = (int(pm.group(1)), int(pm.group(2)))

    if not conference:
        pm2 = re.search(r'(?:conf(?:erence)?|league)\s+(\d+)\s*-\s*(\d+)(?:\s*-\s*\d+)?', html, re.I)
        if pm2:
            conference = (int(pm2.group(1)), int(pm2.group(2)))

    # Method 4: Sidearm JS variable — record = "(21-9, 11-1)";
    if not overall:
        jm = re.search(r'record\s*=\s*"\((\d+)-(\d+),\s*(\d+)-(\d+)\)"', html)
        if jm:
            overall = (int(jm.group(1)), int(jm.group(2)))
            conference = (int(jm.group(3)), int(jm.group(4)))
        else:
            # Also handle record with only overall: record = "(21-9)";
            jm2 = re.search(r'record\s*=\s*"\((\d+)-(\d+)\)"', html)
            if jm2:
                overall = (int(jm2.group(1)), int(jm2.group(2)))

    # Method 5: Nuxt Sidearm schedule page — record_wins'>10...record_losses'>14
    if not overall:
        nm = re.search(r"record_wins'>(\d+).*?record_losses'>(\d+)", html)
        if nm:
            overall = (int(nm.group(1)), int(nm.group(2)))
    # Conference from same Nuxt payload: "0.417","4-5","0.444"
    if overall and not conference:
        ncm = re.search(r"record_losses'>\d+.*?\"[\d.]+\",\"(\d+)-(\d+)\"", html)
        if ncm:
            conference = (int(ncm.group(1)), int(ncm.group(2)))

    # Method 6: PrestoSports unlabeled table — "20-4 (.833)" in <td> cells
    # First match = overall, second = conference (order on page)
    if not overall:
        unlabeled = re.findall(r'>(\d{1,3})\s*-\s*(\d{1,3})\s*\(\d*\.?\d+\)</td>', html)
        if len(unlabeled) >= 1:
            overall = (int(unlabeled[0][0]), int(unlabeled[0][1]))
        if len(unlabeled) >= 2 and not conference:
            conference = (int(unlabeled[1][0]), int(unlabeled[1][1]))

    return overall, conference


def save_team_record(cur, team_id, season, overall, conference=None):
    """
    Save a team's W-L record to team_season_stats.
    Uses upsert so it's safe to call multiple times.
    Accepts a psycopg2 cursor (cur).
    """
    if not overall:
        return False

    w, l = overall
    cw, cl = conference if conference else (0, 0)

    cur.execute("""
        INSERT INTO team_season_stats (team_id, season, wins, losses, conference_wins, conference_losses)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT(team_id, season) DO UPDATE SET
            wins=excluded.wins, losses=excluded.losses,
            conference_wins=excluded.conference_wins, conference_losses=excluded.conference_losses
    """, (team_id, season, w, l, cw, cl))

    logger.info(f"  Record: {w}-{l} ({cw}-{cl} conf)")
    return True
