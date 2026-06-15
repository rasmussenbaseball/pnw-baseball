"""Ingest a transcribed TrackMan session-report JSON into trackman_pitches.

Workflow (per PDF the user sends):
  1. scripts/trackman/render_pages.py <pdf>   -> 1300px header+table crops
  2. transcribe each crop (vision) into a JSON like data/wenatchee_2026.json
  3. python3 scripts/trackman/ingest.py scripts/trackman/data/<file>.json [--commit]

Matching: resolve team by name against summer_teams, then for each pitcher
match (first, last) within that team, preferring the row that has pitching
stats for the report season, then roster_year == season. A hyphenated-surname
truncation fallback handles cases like "Crowley" -> "Crowley-Koehler".

Without --commit it's a dry run (prints the match report only).
"""
import argparse
import json
import sys

from app.models.database import get_connection

COLS = ["pitch_type", "pitch_count", "usage_pct", "velo", "spin", "ivb", "hb",
        "tilt", "extension", "rel_height", "rel_side", "in_zone_pct", "whiff_pct", "chase_pct"]


def resolve_team(cur, name):
    cur.execute("""SELECT id, name FROM summer_teams
                   WHERE name ILIKE %s OR short_name ILIKE %s
                   ORDER BY (name ILIKE %s) DESC LIMIT 1""",
                (name, name, name))
    r = cur.fetchone()
    return (r["id"], r["name"]) if r else (None, None)


def match_player(cur, team_id, first, last, season):
    """Return (player_id, note) or (None, reason)."""
    # candidate set: exact first+last, else first + lastname-prefix (hyphen truncation)
    cur.execute("""SELECT id, first_name, last_name, roster_year FROM summer_players
                   WHERE team_id=%s AND lower(first_name)=lower(%s)
                     AND (lower(last_name)=lower(%s) OR lower(last_name) LIKE lower(%s))""",
                (team_id, first, last, last + "%"))
    cands = cur.fetchall()
    if not cands:
        # last-resort: lastname-prefix only (first name may differ in nickname)
        cur.execute("""SELECT id, first_name, last_name, roster_year FROM summer_players
                       WHERE team_id=%s AND lower(last_name) LIKE lower(%s)""",
                    (team_id, last + "%"))
        cands = cur.fetchall()
        if not cands:
            return None, "NO MATCH"
    if len(cands) == 1:
        c = cands[0]
        note = "" if c["last_name"].lower() == last.lower() else f"~{c['first_name']} {c['last_name']}"
        return c["id"], note
    # multiple candidates -> prefer one with pitching stats for the season, then roster_year
    ids = [c["id"] for c in cands]
    cur.execute("""SELECT player_id FROM summer_pitching_stats
                   WHERE season=%s AND player_id = ANY(%s)""", (season, ids))
    with_stats = {r["player_id"] for r in cur.fetchall()}
    cands.sort(key=lambda c: (c["id"] not in with_stats,
                              c["roster_year"] != season,
                              c["id"]))
    c = cands[0]
    return c["id"], f"chose id{c['id']} of {ids} (season-stats={c['id'] in with_stats})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json")
    ap.add_argument("--commit", action="store_true")
    a = ap.parse_args()

    data = json.load(open(a.json))
    team_name, season = data["team"], data["season"]
    src = data.get("_source", a.json)

    with get_connection() as conn:
        cur = conn.cursor()
        team_id, resolved = resolve_team(cur, team_name)
        if not team_id:
            print(f"FATAL: could not resolve team '{team_name}'"); sys.exit(1)
        print(f"Team '{team_name}' -> id {team_id} ({resolved}), season {season}\n")

        matched, missed, rows_to_write = 0, [], []
        for p in data["players"]:
            pid, note = match_player(cur, team_id, p["first"], p["last"], season)
            if not pid:
                missed.append(f"{p['first']} {p['last']}")
                print(f"  MISS  {p['first']} {p['last']}  ({note})")
                continue
            matched += 1
            flag = f"   <- {note}" if note else ""
            print(f"  ok    {p['first']} {p['last']}  -> id{pid} ({len(p['pitches'])} pitches){flag}")
            for pr in p["pitches"]:
                row = dict(zip(COLS, pr))
                rows_to_write.append((pid, team_id, season, row, src))

        print(f"\nmatched {matched}/{len(data['players'])} players, "
              f"{len(rows_to_write)} pitch rows" + (f"; MISSED: {missed}" if missed else ""))

        if not a.commit:
            print("\nDRY RUN — re-run with --commit to write."); return

        for pid, tid, seas, row, source in rows_to_write:
            cur.execute("""
                INSERT INTO trackman_pitches
                  (summer_player_id, team_id, season, pitch_type, pitch_count, usage_pct,
                   velo, spin, ivb, hb, tilt, extension, rel_height, rel_side,
                   in_zone_pct, whiff_pct, chase_pct, source_file, updated_at)
                VALUES (%(pid)s,%(tid)s,%(seas)s,%(pitch_type)s,%(pitch_count)s,%(usage_pct)s,
                   %(velo)s,%(spin)s,%(ivb)s,%(hb)s,%(tilt)s,%(extension)s,%(rel_height)s,%(rel_side)s,
                   %(in_zone_pct)s,%(whiff_pct)s,%(chase_pct)s,%(source)s, now())
                ON CONFLICT (summer_player_id, season, pitch_type) DO UPDATE SET
                   pitch_count=EXCLUDED.pitch_count, usage_pct=EXCLUDED.usage_pct,
                   velo=EXCLUDED.velo, spin=EXCLUDED.spin, ivb=EXCLUDED.ivb, hb=EXCLUDED.hb,
                   tilt=EXCLUDED.tilt, extension=EXCLUDED.extension, rel_height=EXCLUDED.rel_height,
                   rel_side=EXCLUDED.rel_side, in_zone_pct=EXCLUDED.in_zone_pct,
                   whiff_pct=EXCLUDED.whiff_pct, chase_pct=EXCLUDED.chase_pct,
                   team_id=EXCLUDED.team_id, source_file=EXCLUDED.source_file, updated_at=now()
            """, {"pid": pid, "tid": tid, "seas": seas, "source": source, **row})
        conn.commit()
        print(f"COMMITTED {len(rows_to_write)} rows.")


if __name__ == "__main__":
    main()
