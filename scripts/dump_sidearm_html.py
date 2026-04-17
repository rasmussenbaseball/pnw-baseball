"""
Dump the raw HTML of the batting table(s) for a single game's box score so we
can see how Sidearm marks starters vs substitutes. No DB writes.

Prints each <tr> on its own, with tag, class list, first-cell raw text,
and the full raw inner HTML of the row. That should show us whether subs
have a CSS class, an indentation char, a nested structure, etc.

Usage (on Mac, from repo root):
    PYTHONPATH=backend python3 scripts/dump_sidearm_html.py <game_id>
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from bs4 import BeautifulSoup  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from scrape_boxscores import fetch_page, _find_stat_tables  # noqa: E402

from app.models.database import get_connection  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("game_id", type=int)
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, game_date, source_url FROM games WHERE id = %s",
            (args.game_id,),
        )
        g = cur.fetchone()
        if not g:
            print(f"No game id={args.game_id}")
            return
        g = dict(g)

    print(f"Game {args.game_id}: {g['game_date']}")
    print(f"URL: {g['source_url']}\n")

    html = fetch_page(g["source_url"], retries=2, delay_range=(1.0, 2.0))
    if not html:
        print("FAILED to fetch HTML.")
        return

    soup = BeautifulSoup(html, "html.parser")
    tables = _find_stat_tables(soup, stat_type="batting")
    print(f"Found {len(tables)} batting table(s).\n")

    for t_idx, table in enumerate(tables):
        print(f"\n{'=' * 70}")
        print(f"TABLE #{t_idx + 1}")
        print(f"  class={table.get('class')}  id={table.get('id')}")
        print("=" * 70)

        # First, dump a summary header row
        rows = table.find_all("tr")
        print(f"\n  {len(rows)} rows total.\n")

        for r_idx, tr in enumerate(rows):
            classes = tr.get("class") or []
            cells = tr.find_all(["td", "th"])

            print(
                f"  row {r_idx:>2}  tr.class={classes}  cells={len(cells)}"
            )
            # Dump the first TWO cells in full — position (cell 0) and player
            # name (cell 1) are where any indent/sub markers would live.
            for c_idx in (0, 1):
                if c_idx >= len(cells):
                    continue
                c = cells[c_idx]
                c_text = c.get_text(strip=False)
                c_class = c.get("class")
                c_raw = str(c)[:300]
                print(
                    f"        cell[{c_idx}].class={c_class}"
                )
                print(f"        cell[{c_idx}].text (repr): {repr(c_text)[:160]}")
                print(f"        cell[{c_idx}].html       : {c_raw}")
            print()


if __name__ == "__main__":
    main()
