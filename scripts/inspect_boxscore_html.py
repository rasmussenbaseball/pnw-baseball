"""
Fetch the raw HTML of one game's box score and print every row of the
batting tables with its CSS class, attributes, and visible text. Purpose:
figure out how Sidearm marks substitute rows so we can teach the scraper
to distinguish starters from subs.

Usage:
    PYTHONPATH=backend python3 scripts/inspect_boxscore_html.py <game_id>
    PYTHONPATH=backend python3 scripts/inspect_boxscore_html.py --date 2026-04-12 --team Bushnell --gnum 1
"""
import sys
import os
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import requests
from bs4 import BeautifulSoup
from app.models.database import get_connection  # noqa: E402


def resolve_team(cur, arg):
    if arg.isdigit():
        cur.execute("SELECT id, name FROM teams WHERE id = %s", (int(arg),))
    else:
        cur.execute(
            "SELECT id, name FROM teams WHERE short_name ILIKE %s OR name ILIKE %s LIMIT 1",
            (arg, arg),
        )
    r = cur.fetchone()
    return dict(r) if r else None


def find_game(cur, date, team_id, gnum):
    cur.execute(
        """
        SELECT g.id, g.game_date, g.game_number, g.source_url,
               g.home_team_id, g.away_team_id,
               COALESCE(ht.short_name, ht.name) AS home_short,
               COALESCE(at2.short_name, at2.name) AS away_short
        FROM games g
        LEFT JOIN teams ht ON g.home_team_id = ht.id
        LEFT JOIN teams at2 ON g.away_team_id = at2.id
        WHERE g.game_date = %s
          AND (g.home_team_id = %s OR g.away_team_id = %s)
          AND g.game_number = %s
          AND g.status = 'final'
        LIMIT 1
        """,
        (date, team_id, team_id, gnum),
    )
    r = cur.fetchone()
    return dict(r) if r else None


def load_game_by_id(cur, gid):
    cur.execute(
        """
        SELECT g.id, g.game_date, g.game_number, g.source_url,
               COALESCE(ht.short_name, ht.name) AS home_short,
               COALESCE(at2.short_name, at2.name) AS away_short
        FROM games g
        LEFT JOIN teams ht ON g.home_team_id = ht.id
        LEFT JOIN teams at2 ON g.away_team_id = at2.id
        WHERE g.id = %s
        """,
        (gid,),
    )
    r = cur.fetchone()
    return dict(r) if r else None


def describe_row(tr):
    """Produce a compact description of a <tr> — classes on the row AND on
    the first cell — plus the raw text for every cell."""
    row_classes = " ".join(tr.get("class", []) or [])
    row_id = tr.get("id") or ""
    style = tr.get("style") or ""
    cells = tr.find_all(["td", "th"])
    cell_desc = []
    for c in cells:
        cls = " ".join(c.get("class", []) or [])
        txt = c.get_text(" ", strip=True)[:50]
        # Indent / leading-space is sometimes how subs get marked
        raw_inner = c.decode_contents()[:80]
        cell_desc.append(f"[{cls}]{txt!r}")
    return {
        "row_classes": row_classes,
        "row_id": row_id,
        "style": style,
        "n_cells": len(cells),
        "cells": cell_desc,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("game_id", nargs="?", type=int)
    ap.add_argument("--date")
    ap.add_argument("--team")
    ap.add_argument("--gnum", type=int, default=1)
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        if args.game_id:
            game = load_game_by_id(cur, args.game_id)
        else:
            if not (args.date and args.team):
                print("Provide either a game_id or --date and --team")
                return
            team = resolve_team(cur, args.team)
            if not team:
                print(f"No team matching: {args.team}")
                return
            game = find_game(cur, args.date, team["id"], args.gnum)

    if not game:
        print("No game found.")
        return

    print(f"Game id={game['id']} date={game['game_date']} g#{game.get('game_number')} "
          f"{game.get('away_short')} @ {game.get('home_short')}")
    print(f"Source: {game.get('source_url')}")
    if not game.get("source_url"):
        print("No source_url stored for this game.")
        return

    r = requests.get(game["source_url"], timeout=30, headers={
        "User-Agent": "Mozilla/5.0 (pnwbaseballstats diagnostic)"
    })
    r.raise_for_status()
    html = r.text
    print(f"Fetched {len(html)} bytes\n")

    soup = BeautifulSoup(html, "html.parser")

    # Strategy: find tables whose headers look like a batting box score.
    tables = soup.find_all("table")
    print(f"Found {len(tables)} <table> elements total\n")

    bat_tables = []
    for idx, table in enumerate(tables):
        header_text = ""
        thead = table.find("thead")
        if thead:
            header_text = thead.get_text(" ", strip=True).lower()
        else:
            first_row = table.find("tr")
            if first_row:
                header_text = first_row.get_text(" ", strip=True).lower()
        # Heuristic: has AB and H as columns — almost certainly batting
        if " ab " in f" {header_text} " and " h " in f" {header_text} " and " rbi " in f" {header_text} ":
            bat_tables.append((idx, table, header_text))

    print(f"Identified {len(bat_tables)} batting table(s)\n")

    for tidx, table, header in bat_tables[:2]:
        # Caption or preceding heading tells us which team
        caption = ""
        cap_el = table.find("caption")
        if cap_el:
            caption = cap_el.get_text(" ", strip=True)
        else:
            prev = table.find_previous(["h2", "h3", "h4", "legend"])
            if prev:
                caption = prev.get_text(" ", strip=True)

        print("═" * 90)
        print(f"Batting table index {tidx} — caption/heading: {caption!r}")
        print(f"Header text: {header}")
        print("═" * 90)

        rows = table.find_all("tr")
        for i, tr in enumerate(rows):
            d = describe_row(tr)
            print(f"\nRow {i}  classes={d['row_classes']!r}  id={d['row_id']!r}  style={d['style']!r}  cells={d['n_cells']}")
            for j, cd in enumerate(d["cells"]):
                print(f"   cell {j}: {cd}")
        print()


if __name__ == "__main__":
    main()
