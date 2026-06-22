#!/usr/bin/env python3
"""
Advanced stats for the out-of-region JUCO recruit tracker
=========================================================

Computes league-relative advanced stats for the juco_recruit_* tables from
season counting totals — NO play-by-play needed. League averages are computed
PER CONFERENCE, so wRC+/FIP+/ERA- read as "100 = average for THIS conference"
(the right yardstick for comparing recruits within a league).

Hitters : wOBA, wRC+, ISO, BABIP, BB%, K%, oWAR
Pitchers: FIP, xFIP, K%, BB%, K-BB%, FIP+, ERA-, pWAR

Reuses the same formulas the spring/NWAC pipeline uses
(app.stats.advanced + recalculate_league_adjusted.py). division_level='JUCO'
for run environment / linear weights; no park factors (pf = 1.0), since we
have none for these venues.

Usage:
    PYTHONPATH=backend python3 scripts/recompute_juco_recruit_advanced.py --season 2026
    PYTHONPATH=backend python3 scripts/recompute_juco_recruit_advanced.py --season 2026 --conference "Scenic West"
"""

import sys
import argparse
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from app.models.database import get_connection
from app.stats.advanced import (
    BattingLine, PitchingLine, DEFAULT_WEIGHTS,
    compute_batting_advanced, compute_pitching_advanced,
    compute_college_war, compute_fip_constant,
    innings_to_outs, normalize_position,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("recompute_juco_recruit_advanced")

LEVEL = "JUCO"   # run-environment / linear-weight scaling for these JUCO leagues


def conference_league_averages(cur, conference, season):
    """League-average wOBA / OBP / R-per-PA / ERA / FIP for one conference-season."""
    cur.execute(
        """
        SELECT SUM(b.plate_appearances) pa, SUM(b.at_bats) ab, SUM(b.hits) h,
               SUM(b.doubles) d2, SUM(b.triples) d3, SUM(b.home_runs) hr,
               SUM(b.runs) r, SUM(b.walks) bb, SUM(b.strikeouts) k,
               SUM(b.hit_by_pitch) hbp, SUM(b.sacrifice_flies) sf
        FROM juco_recruit_batting b
        JOIN juco_recruit_teams t ON t.id = b.team_id
        WHERE t.conference_name = %s AND b.season = %s
        """,
        (conference, season),
    )
    b = cur.fetchone()
    cur.execute(
        """
        SELECT SUM(p.innings_pitched) ip, SUM(p.earned_runs) er, SUM(p.walks) bb,
               SUM(p.strikeouts) k, SUM(p.home_runs_allowed) hr, SUM(p.hit_batters) hbp
        FROM juco_recruit_pitching p
        JOIN juco_recruit_teams t ON t.id = p.team_id
        WHERE t.conference_name = %s AND p.season = %s
        """,
        (conference, season),
    )
    p = cur.fetchone()

    weights = DEFAULT_WEIGHTS.get(LEVEL, DEFAULT_WEIGHTS["D1"])

    pa = float(b["pa"] or 1)
    ab = float(b["ab"] or 1)
    h = float(b["h"] or 0); d2 = float(b["d2"] or 0); d3 = float(b["d3"] or 0); hr = float(b["hr"] or 0)
    one_b = h - d2 - d3 - hr
    bb = float(b["bb"] or 0); hbp = float(b["hbp"] or 0); sf = float(b["sf"] or 0)
    runs = float(b["r"] or 0)

    lg_obp = (h + bb + hbp) / (ab + bb + hbp + sf) if (ab + bb + hbp + sf) else 0.340
    lg_r_per_pa = runs / pa
    woba_num = (weights.w_bb * bb + weights.w_hbp * hbp + weights.w_1b * one_b
                + weights.w_2b * d2 + weights.w_3b * d3 + weights.w_hr * hr)
    woba_denom = ab + bb + sf + hbp
    lg_woba = woba_num / woba_denom if woba_denom > 0 else 0.320

    # Pitching: innings stored in baseball notation (6.2 = 6 2/3) -> true decimal innings.
    ip_outs = sum(innings_to_outs(float(x)) for x in [p["ip"]] if x) if p["ip"] is not None else 0
    total_ip = ip_outs / 3.0 if ip_outs else 1.0
    p_er = float(p["er"] or 0); p_bb = float(p["bb"] or 0); p_k = float(p["k"] or 0)
    p_hr = float(p["hr"] or 0); p_hbp = float(p["hbp"] or 0)
    lg_era = (p_er * 9) / total_ip if total_ip > 0 else 4.50
    fip_const = compute_fip_constant(league_era=lg_era, league_hr=int(p_hr), league_bb=int(p_bb),
                                     league_hbp=int(p_hbp), league_k=int(p_k), league_ip=total_ip)
    lg_fip = ((13 * p_hr + 3 * (p_bb + p_hbp) - 2 * p_k) / total_ip) + fip_const

    return {
        "weights": weights, "lg_woba": lg_woba, "lg_obp": lg_obp,
        "lg_r_per_pa": lg_r_per_pa, "lg_era": lg_era, "lg_fip": lg_fip,
        "fip_constant": fip_const,
    }


def recompute_conference(cur, conference, season, verbose=False):
    avg = conference_league_averages(cur, conference, season)
    logger.info(f"  {conference} {season}: lg wOBA={avg['lg_woba']:.3f} OBP={avg['lg_obp']:.3f} "
                f"ERA={avg['lg_era']:.2f} FIP={avg['lg_fip']:.2f}")

    # ── Hitters ──
    cur.execute(
        """
        SELECT b.id, b.player_id, b.plate_appearances, b.at_bats, b.hits, b.doubles,
               b.triples, b.home_runs, b.walks, b.strikeouts, b.hit_by_pitch,
               b.sacrifice_flies, b.sacrifice_bunts, b.stolen_bases, b.caught_stealing,
               pl.position
        FROM juco_recruit_batting b
        JOIN juco_recruit_players pl ON pl.id = b.player_id
        JOIN juco_recruit_teams t ON t.id = b.team_id
        WHERE t.conference_name = %s AND b.season = %s
        """,
        (conference, season),
    )
    n_bat = 0
    for r in cur.fetchall():
        line = BattingLine(
            pa=r["plate_appearances"] or 0, ab=r["at_bats"] or 0, hits=r["hits"] or 0,
            doubles=r["doubles"] or 0, triples=r["triples"] or 0, hr=r["home_runs"] or 0,
            bb=r["walks"] or 0, ibb=0, hbp=r["hit_by_pitch"] or 0,
            sf=r["sacrifice_flies"] or 0, sh=r["sacrifice_bunts"] or 0, k=r["strikeouts"] or 0,
            sb=r["stolen_bases"] or 0, cs=r["caught_stealing"] or 0, gidp=0,
        )
        if line.ab == 0 and line.pa == 0:
            continue
        adv = compute_batting_advanced(line, weights=avg["weights"], league_woba=avg["lg_woba"],
                                       league_obp=avg["lg_obp"], division_level=LEVEL)
        # Use the built-in wRC+ (scaled off the league wOBA + the division's
        # stable run-environment constant). We deliberately do NOT derive it
        # from a league runs/PA computed off these tables: `runs` is sparsely
        # populated in the source stat pages, which would wildly inflate wRC+.
        wrc_plus = adv.wrc_plus if line.pa > 0 else None
        war = compute_college_war(batting=adv, position=normalize_position(r["position"]) or "UT",
                                  plate_appearances=line.pa, division_level=LEVEL)
        cur.execute(
            """UPDATE juco_recruit_batting SET
                 woba=%s, wrc_plus=%s, iso=%s, babip=%s, bb_pct=%s, k_pct=%s,
                 offensive_war=%s, updated_at=now()
               WHERE id=%s""",
            (adv.woba, wrc_plus, adv.iso, adv.babip, adv.bb_pct, adv.k_pct,
             war.offensive_war, r["id"]),
        )
        n_bat += 1

    # ── Pitchers ──
    cur.execute(
        """
        SELECT p.id, p.innings_pitched, p.hits_allowed, p.earned_runs, p.runs_allowed,
               p.walks, p.strikeouts, p.home_runs_allowed, p.hit_batters, p.wild_pitches,
               p.batters_faced, p.wins, p.losses, p.saves, p.games, p.games_started
        FROM juco_recruit_pitching p
        JOIN juco_recruit_teams t ON t.id = p.team_id
        WHERE t.conference_name = %s AND p.season = %s
        """,
        (conference, season),
    )
    n_pit = 0
    for r in cur.fetchall():
        ip = float(r["innings_pitched"] or 0)
        if ip == 0:
            continue
        # Sidearm season tables don't publish batters_faced; estimate it so K%/BB%
        # have a denominator: BF ~= outs + hits + walks + HBP.
        bf = r["batters_faced"]
        if not bf:
            bf = innings_to_outs(ip) + (r["hits_allowed"] or 0) + (r["walks"] or 0) + (r["hit_batters"] or 0)
        line = PitchingLine(
            ip=ip, hits=r["hits_allowed"] or 0, er=r["earned_runs"] or 0,
            runs=r["runs_allowed"] or 0, bb=r["walks"] or 0, ibb=0, k=r["strikeouts"] or 0,
            hr=r["home_runs_allowed"] or 0, hbp=r["hit_batters"] or 0, bf=bf,
            wp=r["wild_pitches"] or 0, wins=r["wins"] or 0, losses=r["losses"] or 0,
            saves=r["saves"] or 0, games=r["games"] or 0, gs=r["games_started"] or 0,
        )
        adv = compute_pitching_advanced(line, fip_constant=avg["fip_constant"],
                                        league_era=avg["lg_era"], league_fip=avg["lg_fip"],
                                        division_level=LEVEL)
        fip_plus = 100 * (avg["lg_fip"] / adv.fip) if adv.fip and adv.fip > 0 else None
        era_minus = 100 * (adv.era / avg["lg_era"]) if avg["lg_era"] > 0 else None
        k_bb = (adv.k_pct - adv.bb_pct) if (adv.k_pct is not None and adv.bb_pct is not None) else None
        cur.execute(
            """UPDATE juco_recruit_pitching SET
                 fip=%s, xfip=%s, k_pct=%s, bb_pct=%s, k_bb_pct=%s,
                 fip_plus=%s, era_minus=%s, pitching_war=%s, updated_at=now()
               WHERE id=%s""",
            (adv.fip, adv.xfip, adv.k_pct, adv.bb_pct, k_bb, fip_plus, era_minus,
             adv.pitching_war, r["id"]),
        )
        n_pit += 1

    logger.info(f"    -> {n_bat} hitters, {n_pit} pitchers updated")
    return n_bat, n_pit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--conference", help="Only this conference_name (default: all)")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        if args.conference:
            confs = [args.conference]
        else:
            cur.execute(
                """SELECT DISTINCT t.conference_name
                   FROM juco_recruit_teams t JOIN juco_recruit_batting b ON b.team_id = t.id
                   WHERE b.season = %s ORDER BY 1""",
                (args.season,),
            )
            confs = [r["conference_name"] for r in cur.fetchall()]
        if not confs:
            logger.error("No conferences with data for that season.")
            return
        logger.info(f"Recomputing advanced stats for {len(confs)} conference(s), season {args.season}")
        for c in confs:
            recompute_conference(cur, c, args.season, verbose=args.verbose)
        conn.commit()
        logger.info("Done.")


if __name__ == "__main__":
    main()
