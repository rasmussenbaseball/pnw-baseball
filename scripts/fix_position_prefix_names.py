"""
Fix position-prefix player names in spring per-game box rows.

The Sidearm HTML box-score parser's single-letter prefix rule only stripped
c/b/p before Capital+lowercase, so sub/pinch entries with abbreviated names
kept the prefix: 'pW. Adams', 'cA. Romero', "pO'Connor, Quentin",
'cSMITH, Conner' (~7k game_batting rows, seasons 2023-2026). game_pitching
also has a handful of decision suffixes glued to names ('Owen Pike(L, 0-1)',
'T. Linster(Sv, 1)'). The parser is fixed (scrape_boxscores.py, 2026-07-04);
this script repairs the EXISTING rows:

  - game_batting.player_name: strip the leading position prefix (same regex
    family as the parser). Rows whose cleaned name would collide with an
    existing row in the same (game, team) are SKIPPED and reported.
  - game_pitching.player_name: strip prefix + trailing decision-shaped
    suffix (real nicknames like 'Travis (TJ) Hallsson' are preserved);
    when a decision was embedded and the row's decision is NULL, set it.

player_id re-resolution is intentionally left to the nightly
backfill_player_ids (daily_update.sh) — with clean names it can now match
rows that previously failed. Verified separately: resolved prefix rows point
at the CORRECT players (the resolver already fuzzy-matched through the
prefix), and no players-table names carry prefixes, so no phantom renames
are needed.

Usage:
    PYTHONPATH=backend python3 scripts/fix_position_prefix_names.py            # dry run
    PYTHONPATH=backend python3 scripts/fix_position_prefix_names.py --commit   # apply
"""
import re
import sys

from app.models.database import get_connection

MULTI = r'(?:dh|ph|pr|cr|eh|lf|cf|rf|ss|1b|2b|3b)'
ANYPOS = r'(?:dh|ph|pr|cr|eh|lf|cf|rf|ss|1b|2b|3b|c|b|p)'
PREFIX_RES = [
    re.compile(rf'^{MULTI}(?:/{ANYPOS})*\s*(?=[A-Z])'),
    re.compile(rf'^(?:c|b|p)/{ANYPOS}(?:/{ANYPOS})*\s*(?=[A-Z])'),
    re.compile(r'^[cbp](?=[A-Z])'),
]
DECISION_RE = re.compile(r'\s*\((W|L|S|Sv|SV|H|BS)\s*,?\s*[\d, -]*\)\s*$')


def clean_name(name):
    """Strip a leading position prefix; returns (cleaned, changed)."""
    for rx in PREFIX_RES:
        m = rx.match(name)
        if m:
            return name[m.end():].strip(), True
    return name, False


def run(commit=False):
    with get_connection() as conn:
        cur = conn.cursor()

        # ── game_batting: position prefixes ──
        cur.execute("""SELECT id, game_id, team_id, player_name FROM game_batting
                       WHERE player_name ~ '^(p|c|1b|2b|3b|ss|lf|cf|rf|dh)[A-Z]'""")
        rows = cur.fetchall()
        updated = skipped = 0
        for r in rows:
            new, changed = clean_name(r["player_name"])
            if not changed or not new:
                skipped += 1
                print(f"  SKIP (no clean form): gb#{r['id']} {r['player_name']!r}")
                continue
            cur.execute(
                """SELECT 1 FROM game_batting
                   WHERE game_id=%s AND team_id=%s AND player_name=%s AND id<>%s LIMIT 1""",
                (r["game_id"], r["team_id"], new, r["id"]),
            )
            if cur.fetchone():
                skipped += 1
                print(f"  SKIP (collision): gb#{r['id']} {r['player_name']!r} -> {new!r}")
                continue
            if commit:
                cur.execute("UPDATE game_batting SET player_name=%s WHERE id=%s", (new, r["id"]))
            updated += 1
        print(f"game_batting: {updated} names cleaned, {skipped} skipped (of {len(rows)})")

        # ── game_pitching: prefixes + decision suffixes ──
        cur.execute(r"""SELECT id, game_id, team_id, player_name, decision FROM game_pitching
                        WHERE player_name ~ '^(p|c|1b|2b|3b|ss|lf|cf|rf|dh)[A-Z]'
                           OR player_name ~ '\((W|L|S|Sv|SV|H|BS)\s*,?\s*[0-9, -]*\)\s*$'""")
        prow = cur.fetchall()
        p_updated = p_skipped = 0
        for r in prow:
            name = r["player_name"]
            dec = None
            m = DECISION_RE.search(name)
            if m:
                dec = m.group(1).upper()[0]
                name = name[:m.start()].strip()
            name, _ = clean_name(name)
            if not name:
                p_skipped += 1
                print(f"  SKIP (empty after clean): gp#{r['id']} {r['player_name']!r}")
                continue
            if name == r["player_name"]:
                continue
            if commit:
                cur.execute(
                    "UPDATE game_pitching SET player_name=%s, decision=COALESCE(decision, %s) WHERE id=%s",
                    (name, dec, r["id"]),
                )
            p_updated += 1
            if len(prow) <= 30:
                print(f"  gp#{r['id']} {r['player_name']!r} -> {name!r}" + (f" (dec {dec})" if dec else ""))
        print(f"game_pitching: {p_updated} names cleaned, {p_skipped} skipped (of {len(prow)})")

        if commit:
            conn.commit()
            print("COMMITTED")
        else:
            print("DRY RUN — re-run with --commit to apply.")


if __name__ == "__main__":
    run(commit="--commit" in sys.argv)
