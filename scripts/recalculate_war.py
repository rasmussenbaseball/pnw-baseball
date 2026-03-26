#!/usr/bin/env python3
"""
Recalculate WAR for all players in the database using the current formula.

This script recomputes offensive WAR (with positional adjustments and
replacement level) and pitching WAR from the stored counting stats.
Run this after changing the WAR formula, positional adjustments, or
replacement level constants.

Usage:
    cd pnw-baseball/backend
    python -m scripts.recalculate_war --season 2026

Or from the project root:
    cd pnw-baseball
    PYTHONPATH=backend python scripts/recalculate_war.py --season 2026
"""

import sys
import os
import argparse

# Add backend to path so we can import app modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection
from app.stats.advanced import (
    BattingLine, PitchingLine, BattingAdvanced,
    compute_batting_advanced, compute_pitching_advanced, compute_college_war,
    normalize_position, DEFAULT_WEIGHTS,
)


def recalculate_all(season: int, verbose: bool = False):
    """Recalculate WAR for all players in the given season."""
    with get_connection() as conn:
        # ── Step 1: Normalize positions in the players table ──
        players = conn.execute(
            "SELECT id, position FROM players"
        ).fetchall()

        pos_changes = 0
        pos_stats = {}
        for p in players:
            raw = p["position"]
            norm = normalize_position(raw)
            if norm:
                pos_stats[norm] = pos_stats.get(norm, 0) + 1

        print(f"\nPosition distribution after normalization:")
        for pos, count in sorted(pos_stats.items(), key=lambda x: -x[1]):
            print(f"  {pos:>4s}: {count}")

        # ── Step 2: Recalculate batting WAR ──
        batters = conn.execute(
            """SELECT bs.id, bs.player_id, bs.plate_appearances, bs.at_bats,
                      bs.hits, bs.doubles, bs.triples, bs.home_runs, bs.walks,
                      COALESCE(bs.intentional_walks, 0) as intentional_walks,
                      COALESCE(bs.hit_by_pitch, 0) as hit_by_pitch,
                      COALESCE(bs.sacrifice_flies, 0) as sacrifice_flies,
                      COALESCE(bs.sacrifice_bunts, 0) as sacrifice_bunts,
                      bs.strikeouts,
                      COALESCE(bs.stolen_bases, 0) as stolen_bases,
                      COALESCE(bs.caught_stealing, 0) as caught_stealing,
                      COALESCE(bs.grounded_into_dp, 0) as grounded_into_dp,
                      p.position, p.first_name, p.last_name
               FROM batting_stats bs
               JOIN players p ON bs.player_id = p.id
               WHERE bs.season = ?""",
            (season,),
        ).fetchall()

        print(f"\nRecalculating WAR for {len(batters)} batters...")

        batting_updated = 0
        war_examples = []

        for b in batters:
            raw_pos = b["position"]
            norm_pos = normalize_position(raw_pos) or "UT"
            pa = b["plate_appearances"] or 0
            ab = b["at_bats"] or 0

            if pa == 0 and ab == 0:
                continue

            # Rebuild BattingLine from stored counting stats
            line = BattingLine(
                pa=pa, ab=ab,
                hits=b["hits"] or 0,
                doubles=b["doubles"] or 0,
                triples=b["triples"] or 0,
                hr=b["home_runs"] or 0,
                bb=b["walks"] or 0,
                ibb=b["intentional_walks"],
                hbp=b["hit_by_pitch"],
                sf=b["sacrifice_flies"],
                sh=b["sacrifice_bunts"],
                k=b["strikeouts"] or 0,
                sb=b["stolen_bases"],
                cs=b["caught_stealing"],
                gidp=b["grounded_into_dp"],
            )
            adv = compute_batting_advanced(line, division_level="JUCO")
            war = compute_college_war(
                batting=adv, position=norm_pos,
                plate_appearances=pa, division_level="JUCO",
            )

            conn.execute(
                """UPDATE batting_stats SET
                    batting_avg = ?, on_base_pct = ?, slugging_pct = ?, ops = ?,
                    woba = ?, wraa = ?, wrc = ?, wrc_plus = ?,
                    iso = ?, babip = ?, bb_pct = ?, k_pct = ?,
                    offensive_war = ?
                   WHERE id = ?""",
                (adv.batting_avg, adv.obp, adv.slg, adv.ops,
                 adv.woba, adv.wraa, adv.wrc, adv.wrc_plus,
                 adv.iso, adv.babip, adv.bb_pct, adv.k_pct,
                 war.offensive_war, b["id"]),
            )
            batting_updated += 1

            # Collect top WAR examples for verification
            if pa >= 100:
                war_examples.append({
                    "name": f"{b['first_name']} {b['last_name']}",
                    "pos": norm_pos,
                    "raw_pos": raw_pos,
                    "pa": pa,
                    "batting_runs": round(war.batting_runs, 2),
                    "pos_runs": round(war.positional_runs, 2),
                    "repl_runs": round(war.replacement_runs, 2),
                    "owar": round(war.offensive_war, 2),
                    "avg": round(adv.batting_avg, 3),
                    "woba": round(adv.woba, 3),
                })

        # ── Step 3: Recalculate pitching WAR ──
        pitchers = conn.execute(
            """SELECT ps.id, ps.innings_pitched, ps.earned_runs, ps.hits_allowed,
                      ps.walks, COALESCE(ps.intentional_walks, 0) as intentional_walks,
                      ps.strikeouts, ps.home_runs_allowed,
                      COALESCE(ps.hit_batters, 0) as hit_batters,
                      ps.batters_faced,
                      COALESCE(ps.wild_pitches, 0) as wild_pitches,
                      ps.wins, ps.losses, ps.saves,
                      ps.games, ps.games_started,
                      COALESCE(ps.runs_allowed, 0) as runs_allowed,
                      p.first_name, p.last_name
               FROM pitching_stats ps
               JOIN players p ON ps.player_id = p.id
               WHERE ps.season = ?""",
            (season,),
        ).fetchall()

        print(f"Recalculating WAR for {len(pitchers)} pitchers...")

        pitching_updated = 0
        pwar_examples = []

        for p in pitchers:
            ip = p["innings_pitched"] or 0
            if ip <= 0:
                continue

            line = PitchingLine(
                ip=ip,
                hits=p["hits_allowed"] or 0,
                er=p["earned_runs"] or 0,
                runs=p["runs_allowed"],
                bb=p["walks"] or 0,
                ibb=p["intentional_walks"],
                k=p["strikeouts"] or 0,
                hr=p["home_runs_allowed"] or 0,
                hbp=p["hit_batters"],
                bf=p["batters_faced"] or 0,
                wp=p["wild_pitches"],
                wins=p["wins"] or 0,
                losses=p["losses"] or 0,
                saves=p["saves"] or 0,
                games=p["games"] or 0,
                gs=p["games_started"] or 0,
            )
            adv = compute_pitching_advanced(line, division_level="JUCO")

            conn.execute(
                """UPDATE pitching_stats SET
                    era = ?, whip = ?, fip = ?, xfip = ?, siera = ?,
                    k_per_9 = ?, bb_per_9 = ?, h_per_9 = ?, hr_per_9 = ?,
                    k_bb_ratio = ?, k_pct = ?, bb_pct = ?,
                    babip_against = ?, lob_pct = ?, pitching_war = ?
                   WHERE id = ?""",
                (adv.era, adv.whip, adv.fip, adv.xfip, adv.siera,
                 adv.k_per_9, adv.bb_per_9, adv.h_per_9, adv.hr_per_9,
                 adv.k_bb_ratio, adv.k_pct, adv.bb_pct,
                 adv.babip_against, adv.lob_pct, adv.pitching_war,
                 p["id"]),
            )
            pitching_updated += 1

            if ip >= 20:
                pwar_examples.append({
                    "name": f"{p['first_name']} {p['last_name']}",
                    "ip": ip,
                    "era": round(adv.era, 2),
                    "fip": round(adv.fip, 2),
                    "pwar": round(adv.pitching_war, 2),
                })

        conn.commit()

    # ── Print results ──
    print(f"\n{'='*60}")
    print(f"WAR Recalculation Complete for {season}")
    print(f"  Batters updated:  {batting_updated}")
    print(f"  Pitchers updated: {pitching_updated}")

    # Show top offensive WAR
    war_examples.sort(key=lambda x: -x["owar"])
    print(f"\n{'='*60}")
    print(f"TOP 20 OFFENSIVE WAR (min 100 PA)")
    print(f"{'Name':<25s} {'Pos':>4s} {'PA':>4s} {'AVG':>6s} {'wOBA':>6s} {'BatR':>6s} {'PosR':>6s} {'RepR':>6s} {'oWAR':>6s}")
    print("-" * 85)
    for ex in war_examples[:20]:
        print(f"{ex['name']:<25s} {ex['pos']:>4s} {ex['pa']:>4d} {ex['avg']:>6.3f} {ex['woba']:>6.3f} "
              f"{ex['batting_runs']:>6.1f} {ex['pos_runs']:>6.2f} {ex['repl_runs']:>6.2f} {ex['owar']:>6.2f}")

    # Show bottom offensive WAR
    print(f"\nBOTTOM 10 OFFENSIVE WAR (min 100 PA)")
    print(f"{'Name':<25s} {'Pos':>4s} {'PA':>4s} {'AVG':>6s} {'wOBA':>6s} {'BatR':>6s} {'PosR':>6s} {'RepR':>6s} {'oWAR':>6s}")
    print("-" * 85)
    for ex in war_examples[-10:]:
        print(f"{ex['name']:<25s} {ex['pos']:>4s} {ex['pa']:>4d} {ex['avg']:>6.3f} {ex['woba']:>6.3f} "
              f"{ex['batting_runs']:>6.1f} {ex['pos_runs']:>6.02f} {ex['repl_runs']:>6.2f} {ex['owar']:>6.2f}")

    # Show top pitching WAR
    pwar_examples.sort(key=lambda x: -x["pwar"])
    print(f"\nTOP 15 PITCHING WAR (min 20 IP)")
    print(f"{'Name':<25s} {'IP':>6s} {'ERA':>6s} {'FIP':>6s} {'pWAR':>6s}")
    print("-" * 55)
    for ex in pwar_examples[:15]:
        print(f"{ex['name']:<25s} {ex['ip']:>6.1f} {ex['era']:>6.2f} {ex['fip']:>6.2f} {ex['pwar']:>6.2f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Recalculate WAR for all players")
    parser.add_argument("--season", type=int, required=True, help="Season year (e.g. 2026)")
    parser.add_argument("--verbose", action="store_true", help="Show detailed output")
    args = parser.parse_args()

    recalculate_all(args.season, verbose=args.verbose)
