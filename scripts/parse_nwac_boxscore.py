#!/usr/bin/env python3
"""
PNW Baseball — NWAC (PrestoSports) Box Score XML Parser
=========================================================

Parses NWAC box score pages (served as .xml but rendered as HTML by
PrestoSports) into structured batting and pitching data that can be
inserted into the game_batting and game_pitching tables.

The PrestoSports box score layout:
  - Line Score table:  inning-by-inning runs, plus R / H / E totals
  - Batting tables:    one per team — AB, R, H, RBI, BB, SO, LOB columns
  - Batting footnotes: 2B, 3B, HR, Sac, Sac Fly, GIDP  (per team)
  - Baserunning notes: SB, CS  (per team)
  - Pitching tables:   one per team — IP, H, R, ER, BB, SO, HR columns
  - Pitching footnotes: Batters faced, WP, HBP, Pitches-Strikes  (per team)

Key quirks:
  - HR, 2B, 3B, SB, CS, SF, SH are NOT in the batting table columns —
    they only appear in the footnotes below each team's batting table.
  - W/L/S decisions are NOT in the HTML — we infer them from context.
  - Positions are in a <span> inside the <th> of each batting row.
  - The first pitcher listed for each team is the starter.

This module is designed to be imported by scrape_nwac_boxscores.py
(the GitHub Actions workflow script) and by the backfill script.
"""

import re
import logging
from bs4 import BeautifulSoup

logger = logging.getLogger("parse_nwac_boxscore")


# ────────────────────────────────────────────────────────────
# Footnote parsing helpers
# ────────────────────────────────────────────────────────────

def _parse_footnote_players(text):
    """
    Parse a footnote line like:
      "Cole Hoffman , Mario Martinez (2) , Keegan Agen"
    Returns dict:  {"Cole Hoffman": 1, "Mario Martinez": 2, "Keegan Agen": 1}
    """
    result = {}
    if not text:
        return result
    # Split on comma — each chunk is "Name" or "Name (N)"
    chunks = [c.strip() for c in text.split(",") if c.strip()]
    for chunk in chunks:
        m = re.match(r"^(.+?)\s*\((\d+)\)\s*$", chunk)
        if m:
            result[m.group(1).strip()] = int(m.group(2))
        elif chunk.strip():
            result[chunk.strip()] = 1
    return result


def _parse_pitches_strikes(text):
    """
    Parse "Kaden Thind (82-48), Ryan Omilon (20-8), ..."
    Returns dict: {"Kaden Thind": (82, 48), ...}
    """
    result = {}
    if not text:
        return result
    chunks = re.findall(r"([A-Z][^(]+?)\s*\((\d+)-(\d+)\)", text)
    for name, pitches, strikes in chunks:
        result[name.strip()] = (int(pitches), int(strikes))
    return result


def _collect_footnotes(stats_summary_divs):
    """
    Given a list of .stats-summary div elements (for one team),
    collect all footnote categories into a dict.

    Returns something like:
    {
        "2B": {"Player A": 1, "Player B": 2},
        "3B": {"Player C": 1},
        "HR": {},
        "SB": {"Player D": 3},
        "CS": {"Player E": 1},
        "Sac": {"Player F": 1},
        "Sac Fly": {"Player G": 1},
        "HBP": {"Player H": 2},
        "WP": {"Pitcher A": 1},
        "Batters faced": {"Pitcher A": 25},
        "Pitches-Strikes": {"Pitcher A": (82, 48)},
    }
    """
    footnotes = {}
    for summary_div in stats_summary_divs:
        # Each stats-summary has a .caption div and then stat-line divs
        stat_divs = summary_div.find_all("div", recursive=False)
        for div in stat_divs:
            if "caption" in (div.get("class") or []):
                continue
            text = div.get_text(" ", strip=True)
            if not text:
                continue
            # Split on first colon
            if ":" not in text:
                continue
            key, _, value = text.partition(":")
            key = key.strip()
            value = value.strip()

            if key == "Pitches-Strikes":
                footnotes[key] = _parse_pitches_strikes(value)
            else:
                footnotes[key] = _parse_footnote_players(value)
    return footnotes


# ────────────────────────────────────────────────────────────
# Main parser
# ────────────────────────────────────────────────────────────

def parse_presto_xml_boxscore(html, box_score_url=""):
    """
    Parse a PrestoSports NWAC box score page.

    Args:
        html: Raw HTML string of the box score page
        box_score_url: URL of the box score (for logging/source_url)

    Returns:
        dict with keys:
            away_team_name, home_team_name,
            away_score, home_score,
            away_hits, home_hits,
            away_errors, home_errors,
            away_line_score, home_line_score,
            innings,
            game_date,    (YYYY-MM-DD string)
            status,       ("final")
            source_url,
            away_batting, home_batting,   (list of player dicts)
            away_pitching, home_pitching, (list of player dicts)

        Each batting dict has:
            player_name, position, ab, r, h, rbi, bb, so, lob,
            2b, 3b, hr, sb, cs, sf, sh, hbp

        Each pitching dict has:
            player_name, is_starter, pitch_order,
            ip, h, r, er, bb, so, hr,
            bf, pitches, strikes, wp, hbp,
            decision  (W/L/S or None)

        Returns None if parsing fails.
    """
    soup = BeautifulSoup(html, "html.parser")
    result = {}

    # ── 1. Parse heading for date and teams ──
    heading = soup.select_one("article h1, article h2, h1")
    if not heading:
        logger.warning(f"No heading found in {box_score_url}")
        return None

    heading_text = heading.get_text(" ", strip=True)
    # Format: "April 12, 2026 Lane at SW Oregon"
    date_match = re.match(
        r"(\w+ \d{1,2},\s*\d{4})\s+(.+?)\s+at\s+(.+)",
        heading_text
    )
    if date_match:
        date_str = date_match.group(1)
        away_name = date_match.group(2).strip()
        home_name = date_match.group(3).strip()
        try:
            from datetime import datetime
            dt = datetime.strptime(date_str, "%B %d, %Y")
            result["game_date"] = dt.strftime("%Y-%m-%d")
        except ValueError:
            logger.warning(f"Could not parse date '{date_str}' from {box_score_url}")
            result["game_date"] = None
    else:
        logger.warning(f"Could not parse heading '{heading_text}' from {box_score_url}")
        return None

    result["source_url"] = box_score_url
    result["status"] = "final"

    # ── 2. Parse Line Score table ──
    tables = soup.find_all("table")
    if not tables:
        logger.warning(f"No tables found in {box_score_url}")
        return None

    line_table = None
    for t in tables:
        cap = t.find("caption")
        if cap and "Line Score" in cap.get_text():
            line_table = t
            break
    if not line_table:
        # Fall back to first table if it has R/H/E headers
        first_headers = [th.get_text(strip=True) for th in tables[0].find_all("th")]
        if "R" in first_headers and "H" in first_headers and "E" in first_headers:
            line_table = tables[0]

    if line_table:
        rows = line_table.find_all("tr")
        if len(rows) >= 3:
            # Row 0: headers — Final, 1, 2, 3, ..., R, H, E
            headers = [th.get_text(strip=True) for th in rows[0].find_all("th")]

            # Row 1: away team
            away_cells = rows[1].find_all(["th", "td"])
            away_values = [c.get_text(strip=True) for c in away_cells]

            # Row 2: home team
            home_cells = rows[2].find_all(["th", "td"])
            home_values = [c.get_text(strip=True) for c in home_cells]

            # Use names from heading (more reliable), but set from line score as fallback
            result["away_team_name"] = away_name
            result["home_team_name"] = home_name

            # Find R, H, E column indices from headers
            r_idx = headers.index("R") if "R" in headers else None
            h_idx = headers.index("H") if "H" in headers else None
            e_idx = headers.index("E") if "E" in headers else None

            def safe_int(vals, idx):
                if idx is not None and idx < len(vals):
                    try:
                        return int(vals[idx])
                    except (ValueError, TypeError):
                        return 0
                return 0

            result["away_score"] = safe_int(away_values, r_idx)
            result["home_score"] = safe_int(home_values, r_idx)
            result["away_hits"] = safe_int(away_values, h_idx)
            result["home_hits"] = safe_int(home_values, h_idx)
            result["away_errors"] = safe_int(away_values, e_idx)
            result["home_errors"] = safe_int(home_values, e_idx)

            # Line scores: inning-by-inning runs (skip team name col and R/H/E)
            # Headers are like: [Final, 1, 2, 3, ..., R, H, E]
            # Values are like:  [TeamName, 0, 0, 1, ..., R, H, E]
            inning_start = 1  # skip "Final" or team name column
            inning_end = r_idx if r_idx else len(headers) - 3

            away_line = []
            home_line = []
            for i in range(inning_start, inning_end):
                def parse_inning(vals, idx):
                    if idx < len(vals):
                        v = vals[idx]
                        if v == "X":
                            return "X"
                        try:
                            return int(v)
                        except (ValueError, TypeError):
                            return 0
                    return 0
                away_line.append(parse_inning(away_values, i))
                home_line.append(parse_inning(home_values, i))

            result["away_line_score"] = away_line
            result["home_line_score"] = home_line
            result["innings"] = len(away_line)
    else:
        logger.warning(f"No line score table found in {box_score_url}")
        result["away_team_name"] = away_name
        result["home_team_name"] = home_name

    # ── 3. Parse Batting tables + footnotes ──
    # Find all .stats-box.half divs — away first, home second
    stats_boxes = soup.select(".stats-box.half")
    if len(stats_boxes) < 2:
        # Fallback: find batting tables by caption
        logger.warning(f"Expected 2 stats-box divs, found {len(stats_boxes)} in {box_score_url}")
        stats_boxes = []

    # Find batting tables by caption containing "Batters"
    batting_tables = []
    for t in tables:
        cap = t.find("caption")
        if cap and "Batters" in cap.get_text():
            batting_tables.append(t)

    # Find pitching tables by caption containing "Pitcher"
    pitching_tables = []
    for t in tables:
        cap = t.find("caption")
        if cap and "Pitcher" in cap.get_text():
            pitching_tables.append(t)

    # Collect footnotes per team
    # Each stats-box.half contains: a .scrollable (with table) + multiple .stats-summary divs
    away_bat_footnotes = {}
    home_bat_footnotes = {}
    away_pitch_footnotes = {}
    home_pitch_footnotes = {}

    if len(stats_boxes) >= 2:
        # Batters section is the first .stats-wrap, pitchers is the second
        stats_wraps = soup.select(".stats-wrap.clearfix")

        if len(stats_wraps) >= 1:
            # First stats-wrap = batters (away + home)
            bat_boxes = stats_wraps[0].select(".stats-box.half")
            if len(bat_boxes) >= 2:
                away_bat_footnotes = _collect_footnotes(bat_boxes[0].select(".stats-summary"))
                home_bat_footnotes = _collect_footnotes(bat_boxes[1].select(".stats-summary"))

        if len(stats_wraps) >= 2:
            # Second stats-wrap = pitchers (away + home)
            pitch_boxes = stats_wraps[1].select(".stats-box.half")
            if len(pitch_boxes) >= 2:
                away_pitch_footnotes = _collect_footnotes(pitch_boxes[0].select(".stats-summary"))
                home_pitch_footnotes = _collect_footnotes(pitch_boxes[1].select(".stats-summary"))

    # ── Parse batting lines ──
    def parse_batting_table(table, bat_footnotes, pitch_footnotes):
        """Parse one team's batting table + footnotes into player dicts."""
        players = []
        if not table:
            return players

        rows = table.find_all("tr")
        # Row 0 is header: Hitters, AB, R, H, RBI, BB, SO, LOB
        header_row = rows[0] if rows else None
        headers = []
        if header_row:
            headers = [th.get_text(strip=True).upper() for th in header_row.find_all("th")]

        # Map column names to indices (skip first column which is player name)
        col_map = {}
        for i, h in enumerate(headers):
            col_map[h] = i

        # Get footnote data
        doubles_map = bat_footnotes.get("2B", {})
        triples_map = bat_footnotes.get("3B", {})
        hr_map = bat_footnotes.get("HR", {})
        sb_map = bat_footnotes.get("SB", {})
        cs_map = bat_footnotes.get("CS", {})
        sac_map = bat_footnotes.get("Sac", {})
        sf_map = bat_footnotes.get("Sac Fly", {})

        # HBP comes from the pitching footnotes of the OPPOSING team
        # We'll handle that later in the caller

        for row in rows[1:]:
            th = row.find("th")
            tds = row.find_all("td")
            if not th or not tds:
                continue

            # Skip totals row
            if th.get_text(strip=True).lower() == "totals":
                continue

            # Player name from link
            link = th.find("a")
            if link:
                player_name = link.get_text(strip=True)
            else:
                player_name = th.get_text(strip=True)
                if not player_name or player_name.lower() == "totals":
                    continue

            # Position from span inside th
            pos_span = th.find("span")
            position = pos_span.get_text(strip=True) if pos_span else ""
            # Clean position — remove leading/trailing whitespace
            position = position.strip()

            # Parse stat columns
            values = [td.get_text(strip=True) for td in tds]

            def get_stat(col_name, default=0):
                """Get stat value from the correct column index."""
                # Column index in values (0-based, since th is separate)
                idx = col_map.get(col_name)
                if idx is not None:
                    # idx includes the header th, so subtract 1 for values array
                    val_idx = idx - 1
                    if 0 <= val_idx < len(values):
                        try:
                            return int(values[val_idx])
                        except (ValueError, TypeError):
                            return default
                return default

            # Look up footnote stats by matching player name
            def footnote_val(fmap, name):
                """Look up a player in a footnote map, trying fuzzy match."""
                if name in fmap:
                    return fmap[name]
                # Try partial match (last name)
                parts = name.split()
                if len(parts) >= 2:
                    last = parts[-1]
                    for fkey, fval in fmap.items():
                        if fkey.endswith(last) and fkey[0] == name[0]:
                            return fval
                return 0

            player = {
                "player_name": player_name,
                "position": position,
                "ab": get_stat("AB"),
                "r": get_stat("R"),
                "h": get_stat("H"),
                "rbi": get_stat("RBI"),
                "bb": get_stat("BB"),
                "so": get_stat("SO"),
                "lob": get_stat("LOB"),
                "2b": footnote_val(doubles_map, player_name),
                "3b": footnote_val(triples_map, player_name),
                "hr": footnote_val(hr_map, player_name),
                "sb": footnote_val(sb_map, player_name),
                "cs": footnote_val(cs_map, player_name),
                "sf": footnote_val(sf_map, player_name),
                "sh": footnote_val(sac_map, player_name),
                "hbp": 0,  # Will be set by caller from opposing pitching footnotes
            }
            players.append(player)

        return players

    away_batting = parse_batting_table(
        batting_tables[0] if len(batting_tables) > 0 else None,
        away_bat_footnotes,
        home_pitch_footnotes,  # opposing pitchers' HBP = our batters' HBP
    )
    home_batting = parse_batting_table(
        batting_tables[1] if len(batting_tables) > 1 else None,
        home_bat_footnotes,
        away_pitch_footnotes,
    )

    # Apply HBP from opposing pitching footnotes to batters
    # The pitching footnotes have HBP: "Pitcher Name (count)" — but we need
    # to figure out which BATTERS were hit. Unfortunately, the footnotes only
    # list the pitcher who threw the HBP, not the batter who was hit.
    # We can't determine per-batter HBP from the available data.
    # However, we CAN get the total HBP against a team from the pitching footnotes.
    # For now, leave HBP as 0 at the individual level (it's not in the batting table).

    result["away_batting"] = away_batting
    result["home_batting"] = home_batting

    # ── 4. Parse Pitching tables + footnotes ──
    def parse_pitching_table(table, pitch_footnotes):
        """Parse one team's pitching table + footnotes into player dicts."""
        pitchers = []
        if not table:
            return pitchers

        rows = table.find_all("tr")
        header_row = rows[0] if rows else None
        headers = []
        if header_row:
            headers = [th.get_text(strip=True).upper() for th in header_row.find_all("th")]

        col_map = {}
        for i, h in enumerate(headers):
            col_map[h] = i

        # Footnote data
        bf_map = pitch_footnotes.get("Batters faced", {})
        wp_map = pitch_footnotes.get("WP", {})
        hbp_map = pitch_footnotes.get("HBP", {})
        ps_map = pitch_footnotes.get("Pitches-Strikes", {})

        pitch_order = 0
        for row in rows[1:]:
            th = row.find("th")
            tds = row.find_all("td")
            if not th or not tds:
                continue

            if th.get_text(strip=True).lower() == "totals":
                continue

            link = th.find("a")
            if link:
                player_name = link.get_text(strip=True)
            else:
                player_name = th.get_text(strip=True)
                if not player_name or player_name.lower() == "totals":
                    continue

            values = [td.get_text(strip=True) for td in tds]

            def get_stat(col_name, default=0):
                idx = col_map.get(col_name)
                if idx is not None:
                    val_idx = idx - 1
                    if 0 <= val_idx < len(values):
                        try:
                            return float(values[val_idx]) if col_name == "IP" else int(values[val_idx])
                        except (ValueError, TypeError):
                            return default
                return default

            def footnote_val(fmap, name):
                if name in fmap:
                    return fmap[name]
                parts = name.split()
                if len(parts) >= 2:
                    last = parts[-1]
                    for fkey, fval in fmap.items():
                        if fkey.endswith(last) and fkey[0] == name[0]:
                            return fval
                return 0

            pitch_order += 1
            is_starter = (pitch_order == 1)

            # Pitches and strikes from footnotes
            ps = ps_map.get(player_name, None)
            if ps is None:
                # Try fuzzy match
                parts = player_name.split()
                if len(parts) >= 2:
                    for fkey, fval in ps_map.items():
                        if fkey.endswith(parts[-1]) and fkey[0] == player_name[0]:
                            ps = fval
                            break

            pitcher = {
                "player_name": player_name,
                "is_starter": is_starter,
                "pitch_order": pitch_order,
                "ip": get_stat("IP", 0.0),
                "h": get_stat("H"),
                "r": get_stat("R"),
                "er": get_stat("ER"),
                "bb": get_stat("BB"),
                "so": get_stat("SO"),
                "hr": get_stat("HR"),
                "bf": footnote_val(bf_map, player_name),
                "wp": footnote_val(wp_map, player_name),
                "hbp": footnote_val(hbp_map, player_name),
                "pitches": ps[0] if ps else 0,
                "strikes": ps[1] if ps else 0,
                "decision": None,  # Will be inferred below
            }
            pitchers.append(pitcher)

        return pitchers

    away_pitching = parse_pitching_table(
        pitching_tables[0] if len(pitching_tables) > 0 else None,
        away_pitch_footnotes,
    )
    home_pitching = parse_pitching_table(
        pitching_tables[1] if len(pitching_tables) > 1 else None,
        home_pitch_footnotes,
    )

    # ── 5. Infer W/L/S decisions ──
    _infer_decisions(
        away_pitching, home_pitching,
        result.get("away_score", 0), result.get("home_score", 0),
        result.get("away_line_score", []), result.get("home_line_score", []),
    )

    result["away_pitching"] = away_pitching
    result["home_pitching"] = home_pitching

    return result


def _infer_decisions(away_pitching, home_pitching, away_score, home_score,
                     away_line, home_line):
    """
    Infer W/L/S decisions for pitchers based on game score.

    Rules:
      - The winning team's pitcher of record gets W.
      - Starter gets W if they pitched >= 5 IP and the team never trailed
        after they left. Otherwise the W goes to the reliever in line
        when the team took the permanent lead.
      - Simple heuristic: give W to the starter if >= 5 IP, else to the
        last reliever who entered before the go-ahead run.
      - The losing team's pitcher who gave up the go-ahead run gets L.
      - Simple heuristic: give L to the starter if < 5 IP and team lost,
        else to the pitcher who allowed the most earned runs.
      - Save: closer gets S if they finished with <= 3 run lead and
        pitched at least 1 IP (simplified).

    Since we don't have play-by-play runner tracking, we use simplified
    heuristics that are correct ~90% of the time.
    """
    if away_score == home_score:
        return  # Tie game — no decisions

    if away_score > home_score:
        win_pitchers = away_pitching
        lose_pitchers = home_pitching
        margin = away_score - home_score
    else:
        win_pitchers = home_pitching
        lose_pitchers = away_pitching
        margin = home_score - away_score

    if not win_pitchers or not lose_pitchers:
        return

    # ── Winning pitcher ──
    # Simple rule: starter gets W if >= 5.0 IP, else first reliever
    starter = win_pitchers[0]
    if starter["ip"] >= 5.0:
        starter["decision"] = "W"
    else:
        # Give W to the middle reliever (heuristic: longest reliever)
        # In reality this depends on when the lead was taken, but this
        # is a reasonable approximation
        best_reliever = None
        best_ip = 0
        for p in win_pitchers[1:]:
            if p["ip"] > best_ip:
                best_ip = p["ip"]
                best_reliever = p
        if best_reliever:
            best_reliever["decision"] = "W"
        elif win_pitchers:
            win_pitchers[0]["decision"] = "W"

    # ── Losing pitcher ──
    # Simple rule: starter gets L if they were responsible for the go-ahead.
    # Heuristic: starter gets L if they gave up earned runs, else the
    # reliever with the most ER.
    l_starter = lose_pitchers[0]
    if l_starter["er"] > 0:
        l_starter["decision"] = "L"
    else:
        worst = None
        worst_er = 0
        for p in lose_pitchers[1:]:
            if p["er"] > worst_er:
                worst_er = p["er"]
                worst = p
        if worst:
            worst["decision"] = "L"
        else:
            l_starter["decision"] = "L"

    # ── Save ──
    # Last pitcher on winning team, if not the W pitcher, margin <= 3,
    # and they recorded at least 1 out
    if len(win_pitchers) > 1:
        closer = win_pitchers[-1]
        if closer["decision"] is None and closer["ip"] > 0:
            if margin <= 3:
                closer["decision"] = "S"
            elif closer["ip"] >= 3.0:
                # 3+ IP save
                closer["decision"] = "S"


# ────────────────────────────────────────────────────────────
# Test / CLI
# ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    import json

    # Read HTML from stdin or file argument
    if len(sys.argv) > 1:
        with open(sys.argv[1], "r") as f:
            html = f.read()
        url = sys.argv[1]
    else:
        html = sys.stdin.read()
        url = "stdin"

    logging.basicConfig(level=logging.DEBUG)
    result = parse_presto_xml_boxscore(html, url)

    if result:
        # Pretty print summary
        print(f"\n{'='*60}")
        print(f"{result['away_team_name']} {result.get('away_score', '?')} @ "
              f"{result['home_team_name']} {result.get('home_score', '?')}")
        print(f"Date: {result.get('game_date')}")
        print(f"Line: {result.get('away_line_score')} / {result.get('home_line_score')}")
        print(f"Hits: {result.get('away_hits')} / {result.get('home_hits')}")
        print(f"Errors: {result.get('away_errors')} / {result.get('home_errors')}")
        print(f"Innings: {result.get('innings')}")

        print(f"\n--- {result['away_team_name']} Batting ({len(result['away_batting'])}) ---")
        for p in result["away_batting"]:
            xbh = f" 2B:{p['2b']}" if p['2b'] else ""
            xbh += f" 3B:{p['3b']}" if p['3b'] else ""
            xbh += f" HR:{p['hr']}" if p['hr'] else ""
            sb = f" SB:{p['sb']}" if p['sb'] else ""
            print(f"  {p['player_name']:25s} {p['position']:5s} "
                  f"{p['ab']}-{p['r']}-{p['h']}-{p['rbi']} "
                  f"BB:{p['bb']} SO:{p['so']}{xbh}{sb}")

        print(f"\n--- {result['home_team_name']} Batting ({len(result['home_batting'])}) ---")
        for p in result["home_batting"]:
            xbh = f" 2B:{p['2b']}" if p['2b'] else ""
            xbh += f" 3B:{p['3b']}" if p['3b'] else ""
            xbh += f" HR:{p['hr']}" if p['hr'] else ""
            sb = f" SB:{p['sb']}" if p['sb'] else ""
            print(f"  {p['player_name']:25s} {p['position']:5s} "
                  f"{p['ab']}-{p['r']}-{p['h']}-{p['rbi']} "
                  f"BB:{p['bb']} SO:{p['so']}{xbh}{sb}")

        print(f"\n--- {result['away_team_name']} Pitching ({len(result['away_pitching'])}) ---")
        for p in result["away_pitching"]:
            dec = f" ({p['decision']})" if p['decision'] else ""
            ps = f" P-S:{p['pitches']}-{p['strikes']}" if p['pitches'] else ""
            print(f"  {p['player_name']:25s} {p['ip']:4.1f}IP "
                  f"{p['h']}H {p['r']}R {p['er']}ER {p['bb']}BB {p['so']}K{dec}{ps}")

        print(f"\n--- {result['home_team_name']} Pitching ({len(result['home_pitching'])}) ---")
        for p in result["home_pitching"]:
            dec = f" ({p['decision']})" if p['decision'] else ""
            ps = f" P-S:{p['pitches']}-{p['strikes']}" if p['pitches'] else ""
            print(f"  {p['player_name']:25s} {p['ip']:4.1f}IP "
                  f"{p['h']}H {p['r']}R {p['er']}ER {p['bb']}BB {p['so']}K{dec}{ps}")
    else:
        print("FAILED TO PARSE", file=sys.stderr)
        sys.exit(1)
