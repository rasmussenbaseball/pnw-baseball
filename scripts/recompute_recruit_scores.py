#!/usr/bin/env python3
"""One-off: recompute recruit_score under the current compute_score model
WITHOUT re-running the full scraper (which would overwrite the PDF-ingested
pbr_state_rank values, since PBR's full rankings are paywalled).

It fetches only the live BBNW ranking index, then for each 2026 recruit:
  * fills bbnw_state_rank when the player is BBNW-ranked but stored unranked
    (Keegan Matson: PBR-discovered Oregon St commit, BBNW WA #34),
  * scores from the RANKING state, not the hometown (Anthony Karis: ID
    resident ranked on Washington's list),
  * leaves pbr_state_rank and every other column untouched.

Run on the server (needs SCRAPER_API_KEY + DATABASE_URL):
    PYTHONPATH=backend python3 scripts/recompute_recruit_scores.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scrape_recruits as sr  # noqa: E402
from app.models.database import get_connection  # noqa: E402
from app import recruit_scoring as _rs  # noqa: E402

# BBNW only ranks WA/OR/ID, so the index only needs those state pages.
BBNW_STATES = ["WA", "OR", "ID"]


def main():
    bbnw_index, _ = sr.fetch_state_indexes(2026, BBNW_STATES)
    print(f"BBNW index: {len(bbnw_index)} ranked players (WA/OR/ID)")

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT id, first_name, last_name, state, bbnw_state_rank,
                      pbr_state_rank, recruit_score
               FROM recruits WHERE grad_year = 2026"""
        )
        rows = cur.fetchall()
        filled, rescored = 0, 0
        for r in rows:
            nk = sr.norm_name(f"{r['first_name']} {r['last_name']}")
            br = bbnw_index.get(nk)
            bbnw_rank = r["bbnw_state_rank"]
            if br and not bbnw_rank:        # fill a missing BBNW rank (Matson)
                bbnw_rank = br["rank"]
                filled += 1
            rank_state = br["state"] if br else None  # WA for Karis
            cur.execute(
                "UPDATE recruits SET bbnw_state_rank = %s, "
                "bbnw_rank_state = COALESCE(%s, bbnw_rank_state) WHERE id = %s",
                (bbnw_rank, rank_state, r["id"]),
            )
            rescored += 1
        # Scores come from the one national model (backend/app/recruit_scoring.py).
        _rs.rescore_class(cur, 2026)
        conn.commit()
        print(f"rescored {rescored} recruits; filled {filled} missing BBNW rank(s)")


if __name__ == "__main__":
    main()
