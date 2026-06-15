"""Ingest transcribed TrackMan session-report JSON(s) into trackman_pitches.

Handles MULTIPLE files at once and combines duplicates:
  * Fuzzy name matching (difflib) so misspellings map to the right roster
    player (e.g. "Dillan" -> roster "Dillon"). Tiers: exact first+last ->
    hyphen-truncation -> fuzzy full-name -> last-name-prefix.
  * Multiple TrackMan profiles for the SAME player (repeat pages, or two
    spellings that resolve to one player_id) are merged into ONE set of
    per-pitch-type rows via COUNT-WEIGHTED averaging. usage% is recomputed
    over the player's combined pitch total.

Per (player_id, season) the write is a REPLACE (delete then insert) so
re-running is idempotent and re-ingesting a corrected PDF self-heals.

Usage:
  python3 scripts/trackman/ingest.py data/yakima_2026.json data/victoria_2026.json ... [--commit]
Without --commit it prints the match + combine report only (dry run).
"""
import argparse
import json
import sys
from collections import defaultdict
from difflib import SequenceMatcher

from app.models.database import get_connection

COLS = ["pitch_type", "pitch_count", "usage_pct", "velo", "spin", "ivb", "hb",
        "tilt", "extension", "rel_height", "rel_side", "in_zone_pct", "whiff_pct", "chase_pct"]
# metrics that get count-weighted-averaged when combining instances
WAVG = ["velo", "spin", "ivb", "hb", "extension", "rel_height", "rel_side",
        "in_zone_pct", "whiff_pct", "chase_pct"]
FUZZY_THRESHOLD = 0.85


def _ratio(a, b):
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


def resolve_team(cur, name):
    cur.execute("""SELECT id, name FROM summer_teams
                   WHERE name ILIKE %s OR short_name ILIKE %s
                   ORDER BY (name ILIKE %s) DESC LIMIT 1""", (name, name, name))
    r = cur.fetchone()
    return (r["id"], r["name"]) if r else (None, None)


def _pick(cur, cands, season):
    """Among candidate rows for one person, prefer the row with pitching
    stats for the season, then roster_year==season, then lowest id."""
    if len(cands) == 1:
        return cands[0]
    ids = [c["id"] for c in cands]
    cur.execute("SELECT DISTINCT player_id FROM summer_pitching_stats "
                "WHERE season=%s AND player_id = ANY(%s)", (season, ids))
    with_stats = {r["player_id"] for r in cur.fetchall()}
    return sorted(cands, key=lambda c: (c["id"] not in with_stats,
                                        c["roster_year"] != season, c["id"]))[0]


def match_player(cur, team_id, first, last, season):
    """Return (player_id, how) or (None, reason)."""
    # 1) exact first+last (case-insensitive)
    cur.execute("""SELECT id, first_name, last_name, roster_year FROM summer_players
                   WHERE team_id=%s AND lower(first_name)=lower(%s) AND lower(last_name)=lower(%s)""",
                (team_id, first, last))
    ex = cur.fetchall()
    if ex:
        return _pick(cur, ex, season)["id"], "exact"
    # 2) hyphen / prefix truncation on last name, same first
    cur.execute("""SELECT id, first_name, last_name, roster_year FROM summer_players
                   WHERE team_id=%s AND lower(first_name)=lower(%s) AND lower(last_name) LIKE lower(%s)""",
                (team_id, first, last + "%"))
    hp = cur.fetchall()
    if hp:
        c = _pick(cur, hp, season)
        return c["id"], f"prefix~{c['first_name']} {c['last_name']}"
    # 3) fuzzy over the whole team roster
    cur.execute("SELECT id, first_name, last_name, roster_year FROM summer_players WHERE team_id=%s", (team_id,))
    roster = cur.fetchall()
    full = f"{first} {last}"
    best, best_sc = None, 0.0
    for r in roster:
        sc = _ratio(full, f"{r['first_name']} {r['last_name']}")
        if sc > best_sc:
            best, best_sc = r, sc
    if best and best_sc >= FUZZY_THRESHOLD:
        return best["id"], f"fuzzy {best_sc:.2f}~{best['first_name']} {best['last_name']}"
    # 4) last-name-prefix only (covers nickname first names like DJ/Dexter)
    cur.execute("""SELECT id, first_name, last_name, roster_year FROM summer_players
                   WHERE team_id=%s AND lower(last_name) LIKE lower(%s)""", (team_id, last + "%"))
    ln = cur.fetchall()
    if len(ln) == 1:
        c = ln[0]
        return c["id"], f"lastname~{c['first_name']} {c['last_name']}"
    return None, (f"NO MATCH (best fuzzy {best_sc:.2f}~{best['first_name']} {best['last_name']})"
                  if best else "NO MATCH")


def combine(instances):
    """instances: list of pitch-row dicts (possibly several per pitch_type).
    Returns one merged row per pitch_type, count-weighted; usage recomputed."""
    by_type = defaultdict(list)
    for row in instances:
        by_type[row["pitch_type"]].append(row)
    merged = {}
    for pt, rows in by_type.items():
        tot = sum((r["pitch_count"] or 0) for r in rows)
        out = {"pitch_type": pt, "pitch_count": tot}
        for m in WAVG:
            num = sum((r[m] * (r["pitch_count"] or 0)) for r in rows if r.get(m) is not None)
            den = sum((r["pitch_count"] or 0) for r in rows if r.get(m) is not None)
            out[m] = round(num / den, 2) if den else None
        out["spin"] = round(out["spin"]) if out["spin"] is not None else None
        # tilt from the highest-count instance
        out["tilt"] = max(rows, key=lambda r: (r["pitch_count"] or 0)).get("tilt")
        merged[pt] = out
    player_total = sum(o["pitch_count"] for o in merged.values()) or 1
    for o in merged.values():
        o["usage_pct"] = round(o["pitch_count"] / player_total * 100, 1)
    return list(merged.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json", nargs="+")
    ap.add_argument("--commit", action="store_true")
    a = ap.parse_args()

    # player_id -> {"season","team_id","label","instances":[rows], "sources":set}
    agg = defaultdict(lambda: {"instances": [], "sources": set(), "names": set()})
    misses = []

    with get_connection() as conn:
        cur = conn.cursor()
        for path in a.json:
            data = json.load(open(path))
            team_name, season, src = data["team"], data["season"], data.get("_source", path)
            team_id, resolved = resolve_team(cur, team_name)
            print(f"\n=== {team_name} -> id {team_id} ({resolved}), {season}  [{src}] ===")
            if not team_id:
                print("  FATAL: team not resolved"); continue
            for p in data["players"]:
                pid, how = match_player(cur, team_id, p["first"], p["last"], season)
                if not pid:
                    misses.append(f"{p['first']} {p['last']} ({team_name})")
                    print(f"  MISS  {p['first']} {p['last']}  [{how}]")
                    continue
                flag = "" if how == "exact" else f"   <- {how}"
                print(f"  ok    {p['first']} {p['last']:18} id{pid} ({len(p['pitches'])}p){flag}")
                e = agg[(pid, season)]
                e["team_id"] = team_id
                e["sources"].add(src)
                e["names"].add(f"{p['first']} {p['last']}")
                for pr in p["pitches"]:
                    e["instances"].append(dict(zip(COLS, pr)))

        # report combined (multi-instance) players
        combos = {k: v for k, v in agg.items() if len({id(i) for i in v["instances"]}) and
                  (len(v["names"]) > 1 or sum(1 for _ in v["instances"]) >
                   len({i["pitch_type"] for i in v["instances"]}))}
        print(f"\n=== matched {len(agg)} players across {len(a.json)} files; "
              f"{len(misses)} misses ===")
        if misses:
            print("  MISSES:", misses)
        multi = [(k, v) for k, v in agg.items() if len(v["names"]) > 1]
        if multi:
            print("  COMBINED (different spellings -> one player):")
            for (pid, _), v in multi:
                print(f"    id{pid}: {sorted(v['names'])}")

        if not a.commit:
            print("\nDRY RUN — re-run with --commit to write."); return

        nrows = 0
        for (pid, season), v in agg.items():
            rows = combine(v["instances"])
            cur.execute("DELETE FROM trackman_pitches WHERE summer_player_id=%s AND season=%s", (pid, season))
            src = "; ".join(sorted(v["sources"]))
            for row in rows:
                cur.execute("""
                    INSERT INTO trackman_pitches
                      (summer_player_id, team_id, season, pitch_type, pitch_count, usage_pct,
                       velo, spin, ivb, hb, tilt, extension, rel_height, rel_side,
                       in_zone_pct, whiff_pct, chase_pct, source_file, updated_at)
                    VALUES (%(pid)s,%(tid)s,%(seas)s,%(pitch_type)s,%(pitch_count)s,%(usage_pct)s,
                       %(velo)s,%(spin)s,%(ivb)s,%(hb)s,%(tilt)s,%(extension)s,%(rel_height)s,%(rel_side)s,
                       %(in_zone_pct)s,%(whiff_pct)s,%(chase_pct)s,%(source)s, now())
                """, {"pid": pid, "tid": v["team_id"], "seas": season, "source": src, **row})
                nrows += 1
        conn.commit()
        print(f"\nCOMMITTED {nrows} rows for {len(agg)} players.")


if __name__ == "__main__":
    main()
