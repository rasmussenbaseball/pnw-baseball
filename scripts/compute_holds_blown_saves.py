"""
Compute HOLDS and BLOWN SAVES from play-by-play state.

Box scores don't carry holds or blown saves, so we derive them from
game_events' per-event score state (Phase A):

  SAVE SITUATION (at a reliever's entry, MLB rule adapted):
      his team leads, AND (lead <= 3 OR the tying run is on base, at bat,
      or on deck — i.e. lead <= runners_on + 2).
      Starters can never be in a save situation.

  BLOWN SAVE: entered in a save situation and the lead was lost (game
      became tied or his team fell behind) while he was on the mound.
      Inherited runners count — the man on the mound wears it.

  HOLD: entered in a save situation, recorded at least one out, left
      with the lead intact, did NOT finish the game, and did not earn
      the win or save (a pitcher can't get a hold + W/S in one game).

Writes per-game flags to game_pitching.is_hold / is_blown_save, then
aggregates season totals into pitching_stats.holds / blown_saves.
Rows for games without derived PBP state stay NULL (the site renders
'-'), so totals honestly reflect PBP-covered games only (~80-85% of
finals per season).

Idempotent — recomputes every covered game for the season on each run.
Wired into daily_update.sh after compute_wpa.py; run manually after a
PBP rescrape:

    PYTHONPATH=backend python3 scripts/compute_holds_blown_saves.py --season 2026
"""

import argparse
from collections import defaultdict

from app.models.database import get_connection


def ensure_schema(cur):
    cur.execute("ALTER TABLE game_pitching ADD COLUMN IF NOT EXISTS is_hold BOOLEAN")
    cur.execute("ALTER TABLE game_pitching ADD COLUMN IF NOT EXISTS is_blown_save BOOLEAN")
    cur.execute("ALTER TABLE pitching_stats ADD COLUMN IF NOT EXISTS blown_saves INTEGER")
    # Frozen snapshot table mirrors pitching_stats (freeze copies shared
    # columns only, so this keeps holds/blown_saves in conference freezes).
    cur.execute("ALTER TABLE pitching_stats_frozen ADD COLUMN IF NOT EXISTS blown_saves INTEGER")


def fetch_events(cur, season):
    """All state-derived events for the season, in true game order."""
    cur.execute(
        """
        SELECT ge.game_id, ge.inning, ge.half, ge.sequence_idx,
               ge.defending_team_id, ge.pitcher_player_id,
               ge.bat_score_before, ge.fld_score_before,
               COALESCE(ge.runs_on_play, 0) AS runs_on_play,
               ge.outs_before, ge.outs_after,
               COALESCE(ge.bases_before, '') AS bases_before
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        WHERE g.season = %s
          AND g.status = 'final'
          AND ge.state_derived_at IS NOT NULL
        ORDER BY ge.game_id, ge.inning,
                 CASE WHEN ge.half = 'top' THEN 0 ELSE 1 END,
                 ge.sequence_idx
        """,
        (season,),
    )
    by_game = defaultdict(list)
    for r in cur.fetchall():
        by_game[r["game_id"]].append(r)
    return by_game


def analyze_game(events):
    """Return {(team_id, player_id): (is_hold_candidate, is_blown_save)}.

    is_hold_candidate still needs the W/S exclusion, applied at write
    time from game_pitching.decision.
    """
    # Defensive events per team, in game order.
    team_events = defaultdict(list)
    for ev in events:
        if ev["defending_team_id"] is not None:
            team_events[ev["defending_team_id"]].append(ev)

    out = {}
    for team_id, evs in team_events.items():
        if not evs:
            continue
        starter = evs[0]["pitcher_player_id"]
        # Events per pitcher, preserving order. NULL-pitcher events are
        # skipped for attribution but still count toward "last defensive
        # event of the game" via evs[-1].
        per_pitcher = defaultdict(list)
        for ev in evs:
            pid = ev["pitcher_player_id"]
            if pid is not None:
                per_pitcher[pid].append(ev)

        last_team_ev = evs[-1]
        for pid, pevs in per_pitcher.items():
            if pid == starter or starter is None:
                continue  # relief only
            entry = pevs[0]
            if entry["fld_score_before"] is None or entry["bat_score_before"] is None:
                continue
            lead_entry = entry["fld_score_before"] - entry["bat_score_before"]
            runners_on = entry["bases_before"].count("1")
            save_situation = lead_entry >= 1 and (
                lead_entry <= 3 or lead_entry <= runners_on + 2
            )
            if not save_situation:
                out[(team_id, pid)] = (False, False)
                continue

            blown = False
            for ev in pevs:
                if ev["fld_score_before"] is None or ev["bat_score_before"] is None:
                    continue
                lead_after = ev["fld_score_before"] - (
                    ev["bat_score_before"] + ev["runs_on_play"]
                )
                if lead_after <= 0:
                    blown = True
                    break

            outs_recorded = sum(
                max((ev["outs_after"] or 0) - (ev["outs_before"] or 0), 0)
                for ev in pevs
            )
            last = pevs[-1]
            exit_lead = last["fld_score_before"] - (
                last["bat_score_before"] + last["runs_on_play"]
            )
            finished_game = last is last_team_ev

            is_hold = (
                not blown
                and outs_recorded >= 1
                and exit_lead >= 1
                and not finished_game
            )
            out[(team_id, pid)] = (is_hold, blown)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        if not args.dry_run:
            ensure_schema(cur)

        by_game = fetch_events(cur, args.season)
        print(f"{len(by_game)} state-derived final games for {args.season}")

        flags = []  # (game_id, team_id, player_id, is_hold, is_blown_save)
        for game_id, events in by_game.items():
            for (team_id, pid), (hold, bs) in analyze_game(events).items():
                flags.append((game_id, team_id, pid, hold, bs))

        holds_n = sum(1 for f in flags if f[3])
        bs_n = sum(1 for f in flags if f[4])
        print(f"{len(flags)} relief appearances analyzed: "
              f"{holds_n} hold candidates, {bs_n} blown saves")

        if args.dry_run:
            print("dry run — nothing written")
            return

        # Reset flags for every covered game, then set computed values.
        game_ids = list(by_game.keys())
        cur.execute(
            "UPDATE game_pitching SET is_hold = FALSE, is_blown_save = FALSE "
            "WHERE game_id = ANY(%s)",
            (game_ids,),
        )
        # W/S exclusion happens here: never mark a hold on a row whose
        # box-score decision is a win or save.
        cur.executemany(
            """
            UPDATE game_pitching
            SET is_hold = (%s AND COALESCE(decision, '') NOT IN ('W', 'S')),
                is_blown_save = %s
            WHERE game_id = %s AND team_id = %s AND player_id = %s
            """,
            [(h, b, gid, tid, pid) for (gid, tid, pid, h, b) in flags if h or b],
        )

        # Aggregate into season totals. Ghost-row guard included. Pitchers
        # with zero PBP-covered appearances keep NULL (rendered as '-').
        cur.execute(
            """
            UPDATE pitching_stats ps
            SET holds = agg.h, blown_saves = agg.bs
            FROM (
                SELECT gp.player_id, gp.team_id, g.season,
                       COUNT(*) FILTER (WHERE gp.is_hold) AS h,
                       COUNT(*) FILTER (WHERE gp.is_blown_save) AS bs
                FROM game_pitching gp
                JOIN games g ON g.id = gp.game_id
                WHERE g.season = %s
                  AND gp.player_id IS NOT NULL
                  AND gp.is_hold IS NOT NULL
                  AND gp.team_id IN (g.home_team_id, g.away_team_id)
                GROUP BY gp.player_id, gp.team_id, g.season
            ) agg
            WHERE ps.player_id = agg.player_id
              AND ps.team_id = agg.team_id
              AND ps.season = agg.season
            """,
            (args.season,),
        )
        print(f"pitching_stats rows updated: {cur.rowcount}")
        conn.commit()
        print("done")


if __name__ == "__main__":
    main()
