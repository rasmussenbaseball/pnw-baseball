#!/usr/bin/env python3
"""
Consolidate intra-team SUMMER duplicate players.

The summer box-score resolver sometimes minted a bare first-initial row
(e.g. "T Mallari", no college/class/bats) for a game line it couldn't tie
to the team's actual roster entry ("Tristan Mallari", which carries the
college). When BOTH rows exist on the same summer team with the same last
name + first initial, they are the same person split in two: a roster row
(rich bio, season-stat rollup) and a box-score artifact (game lines).

This merges the box-score artifact (SRC) INTO the roster row (DST):
  - Season stats (batting/pitching/fielding): keep DST's line for any season
    DST already has (the official Pointstreak rollup is authoritative); move
    SRC's line only for seasons DST lacks. NEVER sum the two.
  - Per-game rows (game_batting/game_pitching): keep DST's row for any game
    DST already has; move SRC's only for games DST lacks.
  - PBP events: repoint SRC -> DST (one batter/pitcher per event, no dup risk).
  - Links: drop SRC's summer_player_links (re-run link_summer_to_spring.py
    afterward so DST gets a college-corroborated link).
  - Delete the SRC summer_players row.

Only UNIQUE pairs are touched: exactly one roster full-name player on that
team shares the last name + first initial. Ambiguous teams are skipped.

    PYTHONPATH=backend python3 scripts/consolidate_summer_dups.py            # dry run
    PYTHONPATH=backend python3 scripts/consolidate_summer_dups.py --commit   # execute
"""
import argparse
import re
from collections import defaultdict

from app.models.database import get_connection


def _norm(s):
    return re.sub(r"[^a-z]", "", (s or "").lower())


def find_pairs(cur):
    """Return [(src_row, dst_row)] unique intra-team initial->fullname pairs."""
    cur.execute(
        """
        SELECT id, first_name, last_name, team_id
        FROM summer_players
        WHERE length(regexp_replace(lower(first_name), '[^a-z]', '', 'g')) = 1
        """
    )
    inits = [dict(r) for r in cur.fetchall()]
    cur.execute(
        """
        SELECT sp.id, sp.first_name, sp.last_name, sp.team_id, sp.college,
               t.short_name AS team_short
        FROM summer_players sp JOIN summer_teams t ON t.id = sp.team_id
        WHERE length(regexp_replace(lower(sp.first_name), '[^a-z]', '', 'g')) > 1
        """
    )
    full = defaultdict(list)
    teamname = {}
    for r in cur.fetchall():
        full[(r["team_id"], _norm(r["last_name"]))].append(dict(r))
        teamname[r["id"]] = r["team_short"]
    pairs = []
    for s in inits:
        cands = [c for c in full.get((s["team_id"], _norm(s["last_name"])), [])
                 if _norm(c["first_name"])[:1] == _norm(s["first_name"])[:1]]
        if len(cands) == 1:
            s["team_short"] = teamname.get(cands[0]["id"], "")
            pairs.append((s, cands[0]))
    return pairs


def _seasons(cur, table, pid):
    cur.execute(f"SELECT season FROM {table} WHERE player_id = %s", (pid,))
    return {r["season"] for r in cur.fetchall()}


def _season_pos(cur, pid):
    cur.execute("SELECT season, position FROM summer_fielding_stats WHERE player_id = %s", (pid,))
    return {(r["season"], r["position"]) for r in cur.fetchall()}


def _game_ids(cur, table, pid):
    cur.execute(f"SELECT game_id FROM {table} WHERE player_id = %s", (pid,))
    return {r["game_id"] for r in cur.fetchall()}


def _count(cur, sql, params):
    cur.execute(sql, params)
    return cur.fetchone()["n"]


def plan(cur, src, dst):
    sid, did = src["id"], dst["id"]
    p = {}
    for tbl, key in (("summer_batting_stats", "bat"), ("summer_pitching_stats", "pit")):
        s_seasons = _seasons(cur, tbl, sid)
        d_seasons = _seasons(cur, tbl, did)
        p[f"{key}_move"] = len(s_seasons - d_seasons)
        p[f"{key}_drop"] = len(s_seasons & d_seasons)
    s_fp = _season_pos(cur, sid)
    d_fp = _season_pos(cur, did)
    p["fld_move"] = len(s_fp - d_fp)
    p["fld_drop"] = len(s_fp & d_fp)
    for tbl, key in (("summer_game_batting", "gb"), ("summer_game_pitching", "gp")):
        s_g = _game_ids(cur, tbl, sid)
        d_g = _game_ids(cur, tbl, did)
        p[f"{key}_move"] = len(s_g - d_g)
        p[f"{key}_drop"] = len(s_g & d_g)
    p["ev"] = _count(cur,
                     "SELECT count(*) n FROM summer_game_events WHERE batter_player_id=%s OR pitcher_player_id=%s",
                     (sid, sid))
    p["src_link"] = _count(cur, "SELECT count(*) n FROM summer_player_links WHERE summer_player_id=%s", (sid,)) > 0
    p["dst_link"] = _count(cur, "SELECT count(*) n FROM summer_player_links WHERE summer_player_id=%s", (did,)) > 0
    return p


def execute_merge(cur, src, dst):
    sid, did = src["id"], dst["id"]
    # Season stats: drop SRC rows whose season DST already has, move the rest.
    for tbl in ("summer_batting_stats", "summer_pitching_stats"):
        cur.execute(f"""DELETE FROM {tbl} s WHERE s.player_id=%s
                        AND EXISTS (SELECT 1 FROM {tbl} d WHERE d.player_id=%s AND d.season=s.season)""",
                    (sid, did))
        cur.execute(f"UPDATE {tbl} SET player_id=%s WHERE player_id=%s", (did, sid))
    # Fielding: dedup on (season, position).
    cur.execute("""DELETE FROM summer_fielding_stats s WHERE s.player_id=%s
                   AND EXISTS (SELECT 1 FROM summer_fielding_stats d
                               WHERE d.player_id=%s AND d.season=s.season
                                 AND COALESCE(d.position,'')=COALESCE(s.position,''))""",
                (sid, did))
    cur.execute("UPDATE summer_fielding_stats SET player_id=%s WHERE player_id=%s", (did, sid))
    # Per-game rows: dedup on game_id.
    for tbl in ("summer_game_batting", "summer_game_pitching"):
        cur.execute(f"""DELETE FROM {tbl} s WHERE s.player_id=%s
                        AND EXISTS (SELECT 1 FROM {tbl} d WHERE d.player_id=%s AND d.game_id=s.game_id)""",
                    (sid, did))
        cur.execute(f"UPDATE {tbl} SET player_id=%s WHERE player_id=%s", (did, sid))
    # PBP events: repoint batter + pitcher.
    cur.execute("UPDATE summer_game_events SET batter_player_id=%s WHERE batter_player_id=%s", (did, sid))
    cur.execute("UPDATE summer_game_events SET pitcher_player_id=%s WHERE pitcher_player_id=%s", (did, sid))
    # Links: drop SRC's (DST gets re-linked with college afterward).
    cur.execute("DELETE FROM summer_player_links WHERE summer_player_id=%s", (sid,))
    # Remove the box-score artifact row.
    cur.execute("DELETE FROM summer_players WHERE id=%s", (sid,))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="Execute the merges (default: dry run)")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        pairs = find_pairs(cur)
        print(f"\n=== {len(pairs)} unique intra-team duplicate pair(s) ===")
        print("(SRC = box-score initial artifact  →  DST = roster full-name row)\n")
        tot = defaultdict(int)
        both_stats = 0
        for src, dst in pairs:
            p = plan(cur, src, dst)
            for k, v in p.items():
                if isinstance(v, int):
                    tot[k] += v
            # "both have season stats" = at least one season-stat drop happened
            if p["bat_drop"] or p["pit_drop"]:
                both_stats += 1
            print(
                f"  [{src['id']}] {src['first_name']} {src['last_name']} ({src.get('team_short','')})"
                f"  ->  [{dst['id']}] {dst['first_name']} {dst['last_name']}"
                f"  college={dst.get('college') or '—'}\n"
                f"        bat +{p['bat_move']}/-{p['bat_drop']}  pit +{p['pit_move']}/-{p['pit_drop']}"
                f"  fld +{p['fld_move']}/-{p['fld_drop']}  gb +{p['gb_move']}/-{p['gb_drop']}"
                f"  gp +{p['gp_move']}/-{p['gp_drop']}  ev {p['ev']}"
                f"  link[src={'Y' if p['src_link'] else 'n'} dst={'Y' if p['dst_link'] else 'n'}]"
            )
        print(f"\n--- summary ---")
        print(f"  pairs: {len(pairs)}  (with overlapping season stats needing dedup: {both_stats})")
        print(f"  season-stat rows: move {tot['bat_move']+tot['pit_move']+tot['fld_move']}, "
              f"DROP-as-dup {tot['bat_drop']+tot['pit_drop']+tot['fld_drop']}")
        print(f"  per-game rows:    move {tot['gb_move']+tot['gp_move']}, "
              f"DROP-as-dup {tot['gb_drop']+tot['gp_drop']}")
        print(f"  PBP events repointed: {tot['ev']}")
        print(f"  SRC artifact rows to delete: {len(pairs)}")

        if args.commit:
            for src, dst in pairs:
                execute_merge(cur, src, dst)
            conn.commit()
            print(f"\nCOMMITTED: merged {len(pairs)} duplicates. "
                  f"Re-run scripts/link_summer_to_spring.py --all-seasons to relink DSTs with college.")
        else:
            print("\nDry run. Re-run with --commit to merge.")
        cur.close()


if __name__ == "__main__":
    main()
