#!/usr/bin/env python3
"""
Recalculate league-adjusted stats (wRC+, FIP+, ERA-) for all players.

This script computes ACTUAL league averages from the database for each
division level, then recalculates wRC+ and FIP+ using those real averages
instead of hardcoded defaults. This makes cross-division comparisons fair:
a 120 wRC+ means "20% better than their league average" regardless of
whether the player is in D1, NAIA, or NWAC.

It also adds FIP+ (like ERA+ but for FIP) and ERA- (100 = league avg,
lower is better — matches FanGraphs convention).

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/recalculate_league_adjusted.py --season 2026
    PYTHONPATH=backend python3 scripts/recalculate_league_adjusted.py --season 2026 --verbose
"""

import sys
import os
import argparse
import math
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection
from app.stats.advanced import (
    BattingLine, PitchingLine, LinearWeights,
    compute_batting_advanced, compute_pitching_advanced,
    compute_college_war, compute_fip_constant,
    normalize_position, innings_to_outs,
    DEFAULT_WEIGHTS, _safe_div,
)


def load_park_factors(conn):
    """
    Load park factors from park_factors.json and build a team_id → park_factor mapping.

    The park factor represents how much the park inflates/deflates run scoring
    as a percentage (e.g., +15.0 means 15% more runs than neutral).

    Since ~50% of a team's games are at home, the effective park adjustment
    for season stats is: park_adjustment = 1 + (park_pct / 100 * 0.50)
    """
    pf_path = os.path.join(os.path.dirname(__file__), "..", "data", "park_factors.json")
    if not os.path.exists(pf_path):
        print("  WARNING: park_factors.json not found — using neutral park factors")
        return {}

    with open(pf_path) as f:
        pf_data = json.load(f)

    # Build short_name → park_factor_pct mapping
    name_to_pct = {}
    for team in pf_data.get("teams", []):
        name_to_pct[team["short_name"]] = team.get("park_factor_pct", 0)

    # Map team_id → effective park factor (1.0 = neutral)
    team_rows = conn.execute("SELECT id, short_name FROM teams").fetchall()
    park_factors = {}
    for row in team_rows:
        pct = name_to_pct.get(row["short_name"], 0)
        # 50% of games at home → half the park effect applies to season stats
        park_factors[row["id"]] = 1.0 + (pct / 100.0 * 0.50)

    return park_factors


def compute_league_averages(conn, season, multi_year=True):
    """
    Compute actual league averages from the database for each division level.

    When multi_year=True (default), averages across all seasons from 2022 to
    the current season. This produces a more stable run environment than using
    a single season, especially early in the year when sample sizes are small.

    Returns a dict keyed by division level ('D1', 'D2', etc.) with all the
    league-level stats needed for wRC+, FIP+, and ERA-.
    """
    if multi_year:
        season_filter = "bs.season BETWEEN 2022 AND ?"
        pit_season_filter = "ps.season BETWEEN 2022 AND ?"
        label = f"2022-{season}"
    else:
        season_filter = "bs.season = ?"
        pit_season_filter = "ps.season = ?"
        label = str(season)

    print(f"  Using run environment from: {label}")

    # ── Batting aggregates by division ──
    batting_rows = conn.execute(f"""
        SELECT d.level as division_level,
               COUNT(DISTINCT bs.player_id) as num_batters,
               SUM(bs.plate_appearances) as total_pa,
               SUM(bs.at_bats) as total_ab,
               SUM(bs.hits) as total_h,
               SUM(bs.doubles) as total_2b,
               SUM(bs.triples) as total_3b,
               SUM(bs.home_runs) as total_hr,
               SUM(bs.runs) as total_r,
               SUM(bs.walks) as total_bb,
               SUM(bs.intentional_walks) as total_ibb,
               SUM(bs.strikeouts) as total_k,
               SUM(bs.hit_by_pitch) as total_hbp,
               SUM(bs.sacrifice_flies) as total_sf,
               SUM(bs.sacrifice_bunts) as total_sh
        FROM batting_stats bs
        JOIN teams t ON bs.team_id = t.id
        JOIN conferences c ON t.conference_id = c.id
        JOIN divisions d ON c.division_id = d.id
        WHERE {season_filter} AND bs.plate_appearances >= 5
        GROUP BY d.level
    """, (season,)).fetchall()

    # ── Pitching aggregates by division ──
    pitching_rows = conn.execute(f"""
        SELECT d.level as division_level,
               COUNT(DISTINCT ps.player_id) as num_pitchers,
               SUM(ps.innings_pitched) as total_ip,
               SUM(ps.earned_runs) as total_er,
               SUM(ps.runs_allowed) as total_r,
               SUM(ps.hits_allowed) as total_h,
               SUM(ps.walks) as total_bb,
               SUM(ps.strikeouts) as total_k,
               SUM(ps.home_runs_allowed) as total_hr,
               SUM(ps.hit_batters) as total_hbp,
               SUM(ps.batters_faced) as total_bf
        FROM pitching_stats ps
        JOIN teams t ON ps.team_id = t.id
        JOIN conferences c ON t.conference_id = c.id
        JOIN divisions d ON c.division_id = d.id
        WHERE {pit_season_filter} AND ps.innings_pitched >= 1
        GROUP BY d.level
    """, (season,)).fetchall()

    pit_map = {r["division_level"]: dict(r) for r in pitching_rows}

    league_avgs = {}
    for r in batting_rows:
        level = r["division_level"]
        pit = pit_map.get(level, {})

        total_pa = r["total_pa"] or 1
        total_ab = r["total_ab"] or 1
        total_ip = pit.get("total_ip") or 1

        # ── Batting league averages ──
        lg_h = r["total_h"] or 0
        lg_2b = r["total_2b"] or 0
        lg_3b = r["total_3b"] or 0
        lg_hr = r["total_hr"] or 0
        lg_1b = lg_h - lg_2b - lg_3b - lg_hr
        lg_bb = r["total_bb"] or 0
        lg_ibb = r["total_ibb"] or 0
        lg_ubb = lg_bb - lg_ibb
        lg_hbp = r["total_hbp"] or 0
        lg_sf = r["total_sf"] or 0
        lg_k = r["total_k"] or 0
        lg_runs = r["total_r"] or 0

        lg_avg = lg_h / total_ab
        lg_obp = (lg_h + lg_bb + lg_hbp) / (total_ab + lg_bb + lg_hbp + lg_sf)
        lg_tb = lg_1b + 2 * lg_2b + 3 * lg_3b + 4 * lg_hr
        lg_slg = lg_tb / total_ab
        lg_r_per_pa = lg_runs / total_pa

        # Use the division's default linear weights for wOBA computation
        weights = DEFAULT_WEIGHTS.get(level, DEFAULT_WEIGHTS["D1"])

        # Compute league wOBA from actual totals
        woba_num = (
            weights.w_bb * lg_ubb
            + weights.w_hbp * lg_hbp
            + weights.w_1b * lg_1b
            + weights.w_2b * lg_2b
            + weights.w_3b * lg_3b
            + weights.w_hr * lg_hr
        )
        woba_denom = total_ab + lg_ubb + lg_sf + lg_hbp
        lg_woba = woba_num / woba_denom if woba_denom > 0 else 0.320

        # ── Pitching league averages ──
        pit_er = pit.get("total_er") or 0
        pit_h = pit.get("total_h") or 0
        pit_bb = pit.get("total_bb") or 0
        pit_k = pit.get("total_k") or 0
        pit_hr = pit.get("total_hr") or 0
        pit_hbp = pit.get("total_hbp") or 0

        lg_era = (pit_er * 9) / total_ip if total_ip > 0 else 4.50

        # FIP constant for this league
        fip_const = compute_fip_constant(
            league_era=lg_era,
            league_hr=pit_hr,
            league_bb=pit_bb,
            league_hbp=pit_hbp,
            league_k=pit_k,
            league_ip=total_ip,
        )

        # League FIP (for FIP+ calculation)
        ip_decimal = innings_to_outs(total_ip) / 3.0 if total_ip else 1
        lg_fip = (
            (13 * pit_hr + 3 * (pit_bb + pit_hbp) - 2 * pit_k) / ip_decimal
        ) + fip_const

        league_avgs[level] = {
            "lg_avg": lg_avg,
            "lg_obp": lg_obp,
            "lg_slg": lg_slg,
            "lg_woba": lg_woba,
            "lg_r_per_pa": lg_r_per_pa,
            "lg_era": lg_era,
            "lg_fip": lg_fip,
            "fip_constant": fip_const,
            "weights": weights,
            "num_batters": r["num_batters"],
            "num_pitchers": pit.get("num_pitchers", 0),
            "total_pa": total_pa,
            "total_ip": total_ip,
        }

    return league_avgs


def recalculate_all(season, verbose=False, multi_year=True):
    """Recalculate wRC+, FIP+, ERA-, and WAR for all players using real league averages."""

    with get_connection() as conn:
        # ── Step 0: Add columns if they don't exist ──
        try:
            conn.execute("ALTER TABLE pitching_stats ADD COLUMN fip_plus REAL")
            print("  Added fip_plus column to pitching_stats")
        except Exception:
            pass  # Column already exists

        try:
            conn.execute("ALTER TABLE pitching_stats ADD COLUMN era_minus REAL")
            print("  Added era_minus column to pitching_stats")
        except Exception:
            pass  # Column already exists

        # ── Step 0.5: Load park factors ──
        park_factors = load_park_factors(conn)
        if park_factors:
            sample = list(park_factors.items())[:3]
            print(f"  Loaded park factors for {len(park_factors)} teams (sample: {[(conn.execute('SELECT short_name FROM teams WHERE id=?', (tid,)).fetchone()[0], f'{pf:.3f}') for tid, pf in sample]})")
        else:
            print("  No park factors loaded — all parks treated as neutral")

        # ── Step 1: Compute real league averages ──
        print(f"\n=== Computing league averages for {season} ===\n")
        league_avgs = compute_league_averages(conn, season, multi_year=multi_year)

        for level, avgs in league_avgs.items():
            print(f"  {level}:")
            print(f"    Batters: {avgs['num_batters']}, Pitchers: {avgs['num_pitchers']}")
            print(f"    AVG={avgs['lg_avg']:.3f}, OBP={avgs['lg_obp']:.3f}, SLG={avgs['lg_slg']:.3f}")
            print(f"    wOBA={avgs['lg_woba']:.3f}, R/PA={avgs['lg_r_per_pa']:.4f}")
            print(f"    ERA={avgs['lg_era']:.2f}, FIP={avgs['lg_fip']:.2f}, FIP constant={avgs['fip_constant']:.2f}")
            print()

        # ── Step 2: Recalculate batting stats (wRC+, wOBA, wRAA, WAR) ──
        print("=== Recalculating batting stats ===\n")

        batters = conn.execute("""
            SELECT bs.*, p.position, p.first_name, p.last_name,
                   d.level as division_level
            FROM batting_stats bs
            JOIN players p ON bs.player_id = p.id
            JOIN teams t ON bs.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE bs.season = ?
        """, (season,)).fetchall()

        batting_updated = 0
        for b in batters:
            level = b["division_level"]
            avgs = league_avgs.get(level)
            if not avgs:
                continue

            line = BattingLine(
                pa=b["plate_appearances"] or 0,
                ab=b["at_bats"] or 0,
                hits=b["hits"] or 0,
                doubles=b["doubles"] or 0,
                triples=b["triples"] or 0,
                hr=b["home_runs"] or 0,
                bb=b["walks"] or 0,
                ibb=b["intentional_walks"] or 0,
                hbp=b["hit_by_pitch"] or 0,
                sf=b["sacrifice_flies"] or 0,
                sh=b["sacrifice_bunts"] or 0,
                k=b["strikeouts"] or 0,
                sb=b["stolen_bases"] or 0,
                cs=b["caught_stealing"] or 0,
                gidp=b["grounded_into_dp"] or 0,
            )

            if line.ab == 0 and line.pa == 0:
                continue

            # Compute with REAL league averages
            adv = compute_batting_advanced(
                line,
                weights=avgs["weights"],
                league_woba=avgs["lg_woba"],
                league_obp=avgs["lg_obp"],
                division_level=level,
            )

            # Override runs_per_pa with the real value for wRC+
            # wRC+ = 100 * (wRAA/PA + lg_R/PA) / (park_factor * lg_R/PA)
            # Park factor accounts for ~50% of games being at home
            pf = park_factors.get(b["team_id"], 1.0)
            if line.pa > 0 and avgs["lg_r_per_pa"] > 0:
                wrc_plus = 100 * (
                    (adv.wraa / line.pa + avgs["lg_r_per_pa"])
                    / (pf * avgs["lg_r_per_pa"])
                )
            else:
                wrc_plus = 0

            # Compute WAR with real league context
            norm_pos = normalize_position(b["position"]) or "UT"
            war = compute_college_war(
                batting=adv, position=norm_pos,
                plate_appearances=line.pa, division_level=level,
            )

            conn.execute("""
                UPDATE batting_stats SET
                    woba = ?, wraa = ?, wrc = ?, wrc_plus = ?,
                    iso = ?, babip = ?, bb_pct = ?, k_pct = ?,
                    batting_avg = ?, on_base_pct = ?, slugging_pct = ?, ops = ?,
                    offensive_war = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            """, (
                adv.woba, adv.wraa, adv.wrc, wrc_plus,
                adv.iso, adv.babip, adv.bb_pct, adv.k_pct,
                adv.batting_avg, adv.obp, adv.slg, adv.ops,
                war.offensive_war,
                b["id"],
            ))
            batting_updated += 1

            if verbose and line.pa >= 50:
                print(f"    {b['first_name']} {b['last_name']} ({level}): "
                      f"wOBA={adv.woba:.3f} wRC+={wrc_plus:.0f} "
                      f"(lg wOBA={avgs['lg_woba']:.3f})")

        print(f"  Updated {batting_updated} batters\n")

        # ── Step 3: Recalculate pitching stats (FIP, FIP+, ERA-, WAR) ──
        print("=== Recalculating pitching stats ===\n")

        pitchers = conn.execute("""
            SELECT ps.*, p.position, p.first_name, p.last_name,
                   d.level as division_level
            FROM pitching_stats ps
            JOIN players p ON ps.player_id = p.id
            JOIN teams t ON ps.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE ps.season = ?
        """, (season,)).fetchall()

        pitching_updated = 0
        for p in pitchers:
            level = p["division_level"]
            avgs = league_avgs.get(level)
            if not avgs:
                continue

            ip = p["innings_pitched"] or 0
            if ip == 0:
                continue

            line = PitchingLine(
                ip=ip,
                hits=p["hits_allowed"] or 0,
                er=p["earned_runs"] or 0,
                runs=p["runs_allowed"] or 0,
                bb=p["walks"] or 0,
                ibb=p["intentional_walks"] or 0,
                k=p["strikeouts"] or 0,
                hr=p["home_runs_allowed"] or 0,
                hbp=p["hit_batters"] or 0,
                bf=p["batters_faced"] or 0,
                wp=p["wild_pitches"] or 0,
                wins=p["wins"] or 0,
                losses=p["losses"] or 0,
                saves=p["saves"] or 0,
                games=p["games"] or 0,
                gs=p["games_started"] or 0,
            )

            # Compute with REAL league FIP constant and ERA
            adv = compute_pitching_advanced(
                line,
                fip_constant=avgs["fip_constant"],
                league_era=avgs["lg_era"],
                league_fip=avgs["lg_fip"],
                division_level=level,
            )

            # Park-adjusted FIP+ and ERA-
            # Park factor adjusts for ~50% of games at home
            pf = park_factors.get(p["team_id"], 1.0)

            # FIP+ = 100 * (league_FIP / (player_FIP / park_factor))
            # Dividing player FIP by park factor normalizes for park effects:
            # a pitcher in a hitter's park (pf > 1) gets credit, their FIP is deflated
            # Scale: 100 = average, >100 is better
            if adv.fip > 0 and pf > 0:
                fip_plus = 100 * (avgs["lg_fip"] / (adv.fip / pf))
            else:
                fip_plus = 0

            # ERA- = 100 * ((player_ERA / park_factor) / league_ERA)
            # Dividing by park factor normalizes: a pitcher in a hitter's park
            # gets their ERA reduced before comparison to league average
            # Scale: 100 = average, <100 is better
            if avgs["lg_era"] > 0 and pf > 0:
                era_minus = 100 * ((adv.era / pf) / avgs["lg_era"])
            else:
                era_minus = 0

            conn.execute("""
                UPDATE pitching_stats SET
                    era = ?, whip = ?, k_per_9 = ?, bb_per_9 = ?,
                    h_per_9 = ?, hr_per_9 = ?, k_bb_ratio = ?,
                    k_pct = ?, bb_pct = ?,
                    fip = ?, xfip = ?, siera = ?, kwera = ?,
                    babip_against = ?, lob_pct = ?,
                    fip_plus = ?, era_minus = ?,
                    pitching_war = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            """, (
                adv.era, adv.whip, adv.k_per_9, adv.bb_per_9,
                adv.h_per_9, adv.hr_per_9, adv.k_bb_ratio,
                adv.k_pct, adv.bb_pct,
                adv.fip, adv.xfip, adv.siera, adv.kwera,
                adv.babip_against, adv.lob_pct,
                fip_plus, era_minus,
                adv.pitching_war,
                p["id"],
            ))
            pitching_updated += 1

            if verbose and ip >= 20:
                print(f"    {p['first_name']} {p['last_name']} ({level}): "
                      f"FIP={adv.fip:.2f} FIP+={fip_plus:.0f} ERA-={era_minus:.0f} "
                      f"(lg ERA={avgs['lg_era']:.2f}, lg FIP={avgs['lg_fip']:.2f})")

        print(f"  Updated {pitching_updated} pitchers\n")

        # ── Step 4: Summary ──
        print("=== Verification: Top wRC+ by division ===\n")
        top_batters = conn.execute("""
            SELECT p.first_name, p.last_name, t.short_name, d.level,
                   bs.wrc_plus, bs.woba, bs.batting_avg, bs.plate_appearances
            FROM batting_stats bs
            JOIN players p ON bs.player_id = p.id
            JOIN teams t ON bs.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE bs.season = ? AND bs.plate_appearances >= 50
            ORDER BY bs.wrc_plus DESC
            LIMIT 15
        """, (season,)).fetchall()

        for b in top_batters:
            print(f"  {b['first_name']:12s} {b['last_name']:15s} {b['short_name']:18s} "
                  f"{b['level']:5s} wRC+={b['wrc_plus']:6.1f} wOBA={b['woba']:.3f} "
                  f"AVG={b['batting_avg']:.3f} PA={b['plate_appearances']}")

        print("\n=== Verification: Top FIP+ by division ===\n")
        top_pitchers = conn.execute("""
            SELECT p.first_name, p.last_name, t.short_name, d.level,
                   ps.fip_plus, ps.fip, ps.era, ps.era_minus, ps.innings_pitched
            FROM pitching_stats ps
            JOIN players p ON ps.player_id = p.id
            JOIN teams t ON ps.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE ps.season = ? AND ps.innings_pitched >= 20
            ORDER BY ps.fip_plus DESC
            LIMIT 15
        """, (season,)).fetchall()

        for pit in top_pitchers:
            print(f"  {pit['first_name']:12s} {pit['last_name']:15s} {pit['short_name']:18s} "
                  f"{pit['level']:5s} FIP+={pit['fip_plus']:6.1f} FIP={pit['fip']:.2f} "
                  f"ERA={pit['era']:.2f} ERA-={pit['era_minus']:.0f} IP={pit['innings_pitched']}")

    print("\n=== Done ===")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Recalculate league-adjusted stats")
    parser.add_argument("--season", type=int, required=True, help="Season year")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show per-player details")
    parser.add_argument("--single-year", action="store_true", help="Only use the current season for league averages (default: multi-year 2022+)")
    args = parser.parse_args()
    recalculate_all(args.season, verbose=args.verbose, multi_year=not args.single_year)
