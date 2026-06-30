#!/usr/bin/env python3
"""
Compute advanced stats (wOBA, wRC+, FIP, WAR) for summer league data.

Uses league-level averages from the actual data to calibrate all metrics.
Stores results in summer_batting_stats and summer_pitching_stats tables,
and caches league averages in summer_league_averages.

Usage:
    python scripts/compute_summer_advanced.py [--season 2025]
    python scripts/compute_summer_advanced.py --all   # compute all seasons
"""

import os
import sys
import argparse
import psycopg2
import psycopg2.extras

# Add project root so we can import the advanced stats module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from backend.app.stats.advanced import (
    BattingLine, PitchingLine, LinearWeights,
    compute_batting_advanced, compute_pitching_advanced,
    compute_fip_constant, _safe_div,
)

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    # Try loading from .env file
    env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if line.startswith('DATABASE_URL='):
                    DATABASE_URL = line.strip().split('=', 1)[1].strip('"').strip("'")
                    break


def get_connection():
    return psycopg2.connect(DATABASE_URL)


def load_park_factors():
    """
    Load WCL summer park factors → {summer_team_id: park_adjustment}.

    park_adjustment = 1 + (park_factor_pct / 100 * 0.50), the same convention
    spring uses in recalculate_league_adjusted.py (the 0.50 accounts for ~half
    of a team's games being at home). Only WCL parks are in the file, so teams
    not present (e.g. PIL) fall back to a neutral 1.0 at the call site.
    """
    import json
    pf_path = os.path.join(os.path.dirname(__file__), '..', 'data', 'park_factors_wcl.json')
    factors = {}
    try:
        with open(pf_path) as f:
            data = json.load(f)
        for team in data.get('teams', []):
            tid = team.get('team_id')
            pct = team.get('park_factor_pct', 0) or 0
            if tid is not None:
                factors[tid] = 1.0 + (pct / 100.0 * 0.50)
    except FileNotFoundError:
        print("  WARNING: park_factors_wcl.json not found — using neutral park factors")
    return factors


def compute_league_averages(conn, league_id, season):
    """Compute league-wide averages from raw batting/pitching data."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    # ----- Batting league averages -----
    cur.execute("""
        SELECT
            COALESCE(SUM(plate_appearances), 0) as total_pa,
            COALESCE(SUM(at_bats), 0) as total_ab,
            COALESCE(SUM(hits), 0) as total_h,
            COALESCE(SUM(doubles), 0) as total_2b,
            COALESCE(SUM(triples), 0) as total_3b,
            COALESCE(SUM(home_runs), 0) as total_hr,
            COALESCE(SUM(walks), 0) as total_bb,
            COALESCE(SUM(hit_by_pitch), 0) as total_hbp,
            COALESCE(SUM(sacrifice_flies), 0) as total_sf,
            COALESCE(SUM(strikeouts), 0) as total_k,
            COALESCE(SUM(intentional_walks), 0) as total_ibb,
            COALESCE(SUM(runs), 0) as total_r
        FROM summer_batting_stats sbs
        JOIN summer_teams st ON sbs.team_id = st.id
        WHERE sbs.season = %s AND st.league_id = %s
    """, (season, league_id))
    bat = dict(cur.fetchone())

    if bat['total_pa'] == 0:
        return None

    total_pa = bat['total_pa']
    total_ab = bat['total_ab']
    total_h = bat['total_h']
    total_1b = total_h - bat['total_2b'] - bat['total_3b'] - bat['total_hr']
    total_ubb = bat['total_bb'] - bat['total_ibb']

    # League batting avg, OBP, SLG
    lg_avg = _safe_div(total_h, total_ab)
    lg_obp = _safe_div(
        total_h + bat['total_bb'] + bat['total_hbp'],
        total_ab + bat['total_bb'] + bat['total_hbp'] + bat['total_sf']
    )
    total_tb = total_1b + 2*bat['total_2b'] + 3*bat['total_3b'] + 4*bat['total_hr']
    lg_slg = _safe_div(total_tb, total_ab)

    # Compute wOBA using standard college weights
    # Use D2-level weights as baseline for summer ball (similar competition)
    w_bb, w_hbp, w_1b, w_2b, w_3b, w_hr = 0.69, 0.72, 0.89, 1.25, 1.58, 2.02
    woba_scale = 1.22

    woba_num = (w_bb * total_ubb + w_hbp * bat['total_hbp'] +
                w_1b * total_1b + w_2b * bat['total_2b'] +
                w_3b * bat['total_3b'] + w_hr * bat['total_hr'])
    woba_denom = total_ab + total_ubb + bat['total_sf'] + bat['total_hbp']
    lg_woba = _safe_div(woba_num, woba_denom)

    runs_per_pa = _safe_div(bat['total_r'], total_pa)
    # Summer ball has fewer games, use 9.5 as runs_per_win
    runs_per_win = 9.5

    # ----- Pitching league averages -----
    cur.execute("""
        SELECT
            -- True decimal innings (ip_outs converts baseball-notation .1/.2 to
            -- outs; a plain SUM would undercount). See migrate_ip_helpers.sql.
            (COALESCE(SUM(ip_outs(innings_pitched)), 0) / 3.0)::float8 as total_ip,
            COALESCE(SUM(earned_runs), 0) as total_er,
            COALESCE(SUM(runs_allowed), 0) as total_r,
            COALESCE(SUM(home_runs_allowed), 0) as total_hr,
            COALESCE(SUM(walks), 0) as total_bb,
            COALESCE(SUM(hit_batters), 0) as total_hbp,
            COALESCE(SUM(strikeouts), 0) as total_k,
            COALESCE(SUM(batters_faced), 0) as total_bf,
            COALESCE(SUM(hits_allowed), 0) as total_ha
        FROM summer_pitching_stats sps
        JOIN summer_teams st ON sps.team_id = st.id
        WHERE sps.season = %s AND st.league_id = %s
    """, (season, league_id))
    pit = dict(cur.fetchone())

    # total_ip is already TRUE decimal innings (ip_outs(...)/3 in the SQL above),
    # so use it directly — do NOT re-convert baseball notation here.
    ip_decimal = pit['total_ip'] if pit['total_ip'] and pit['total_ip'] > 0 else 1

    lg_era = _safe_div(pit['total_er'] * 9, ip_decimal)

    # Compute FIP constant (compute_fip_constant expects true decimal innings)
    fip_const = compute_fip_constant(
        lg_era, pit['total_hr'], pit['total_bb'],
        pit['total_hbp'], pit['total_k'], ip_decimal
    )

    # League FIP
    lg_fip = ((13 * pit['total_hr'] + 3 * (pit['total_bb'] + pit['total_hbp'])
               - 2 * pit['total_k']) / ip_decimal) + fip_const

    # League HR/FB rate estimate
    total_bip = pit['total_bf'] - pit['total_k'] - pit['total_bb'] - pit['total_hbp']
    est_fb = total_bip * 0.35 if total_bip > 0 else 1
    lg_hr_fb = _safe_div(pit['total_hr'], est_fb, 0.10)

    lg_k9 = _safe_div(pit['total_k'] * 9, ip_decimal)
    lg_bb9 = _safe_div(pit['total_bb'] * 9, ip_decimal)
    lg_hr9 = _safe_div(pit['total_hr'] * 9, ip_decimal)

    averages = {
        'league_id': league_id,
        'season': season,
        'avg_batting_avg': round(lg_avg, 3),
        'avg_obp': round(lg_obp, 3),
        'avg_slg': round(lg_slg, 3),
        'avg_ops': round(lg_obp + lg_slg, 3),
        'avg_woba': round(lg_woba, 3),
        'avg_runs_per_game': None,  # Would need game count
        'avg_hr_per_fb': round(lg_hr_fb, 3),
        'woba_scale': woba_scale,
        'runs_per_pa': round(runs_per_pa, 4),
        'runs_per_win': runs_per_win,
        'avg_era': round(lg_era, 2),
        'avg_fip': round(lg_fip, 2),
        'avg_k_per_9': round(lg_k9, 2),
        'avg_bb_per_9': round(lg_bb9, 2),
        'avg_hr_per_9': round(lg_hr9, 2),
        'fip_constant': round(fip_const, 2),
    }

    # Store in summer_league_averages table
    cur.execute("""
        INSERT INTO summer_league_averages (
            league_id, season, avg_batting_avg, avg_obp, avg_slg, avg_ops,
            avg_woba, avg_runs_per_game, avg_hr_per_fb, woba_scale,
            runs_per_pa, runs_per_win, avg_era, avg_fip, avg_k_per_9,
            avg_bb_per_9, avg_hr_per_9, fip_constant
        ) VALUES (
            %(league_id)s, %(season)s, %(avg_batting_avg)s, %(avg_obp)s,
            %(avg_slg)s, %(avg_ops)s, %(avg_woba)s, %(avg_runs_per_game)s,
            %(avg_hr_per_fb)s, %(woba_scale)s, %(runs_per_pa)s,
            %(runs_per_win)s, %(avg_era)s, %(avg_fip)s, %(avg_k_per_9)s,
            %(avg_bb_per_9)s, %(avg_hr_per_9)s, %(fip_constant)s
        )
        ON CONFLICT (league_id, season) DO UPDATE SET
            avg_batting_avg = EXCLUDED.avg_batting_avg,
            avg_obp = EXCLUDED.avg_obp,
            avg_slg = EXCLUDED.avg_slg,
            avg_ops = EXCLUDED.avg_ops,
            avg_woba = EXCLUDED.avg_woba,
            avg_runs_per_game = EXCLUDED.avg_runs_per_game,
            avg_hr_per_fb = EXCLUDED.avg_hr_per_fb,
            woba_scale = EXCLUDED.woba_scale,
            runs_per_pa = EXCLUDED.runs_per_pa,
            runs_per_win = EXCLUDED.runs_per_win,
            avg_era = EXCLUDED.avg_era,
            avg_fip = EXCLUDED.avg_fip,
            avg_k_per_9 = EXCLUDED.avg_k_per_9,
            avg_bb_per_9 = EXCLUDED.avg_bb_per_9,
            avg_hr_per_9 = EXCLUDED.avg_hr_per_9,
            fip_constant = EXCLUDED.fip_constant
    """, averages)
    conn.commit()

    print(f"  League averages: AVG={lg_avg:.3f}, OBP={lg_obp:.3f}, "
          f"wOBA={lg_woba:.3f}, ERA={lg_era:.2f}, FIP={lg_fip:.2f}, "
          f"FIP_const={fip_const:.2f}, R/PA={runs_per_pa:.4f}")

    return averages


def compute_batting(conn, league_id, season, avgs, park_factors=None):
    """Compute advanced batting stats for all players in a league/season."""
    park_factors = park_factors or {}
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    weights = LinearWeights(
        w_bb=0.69, w_hbp=0.72, w_1b=0.89, w_2b=1.25, w_3b=1.58, w_hr=2.02,
        woba_scale=avgs['woba_scale'],
        runs_per_pa=avgs['runs_per_pa'],
        runs_per_win=avgs['runs_per_win'],
    )

    cur.execute("""
        SELECT sbs.id, sbs.team_id, sbs.plate_appearances, sbs.at_bats, sbs.hits,
               sbs.doubles, sbs.triples, sbs.home_runs, sbs.walks,
               sbs.intentional_walks, sbs.hit_by_pitch, sbs.sacrifice_flies,
               sbs.sacrifice_bunts, sbs.strikeouts, sbs.stolen_bases,
               sbs.caught_stealing, sbs.grounded_into_dp
        FROM summer_batting_stats sbs
        JOIN summer_teams st ON sbs.team_id = st.id
        WHERE sbs.season = %s AND st.league_id = %s
    """, (season, league_id))

    rows = cur.fetchall()
    updated = 0

    for row in rows:
        line = BattingLine(
            pa=row['plate_appearances'] or 0,
            ab=row['at_bats'] or 0,
            hits=row['hits'] or 0,
            doubles=row['doubles'] or 0,
            triples=row['triples'] or 0,
            hr=row['home_runs'] or 0,
            bb=row['walks'] or 0,
            ibb=row['intentional_walks'] or 0,
            hbp=row['hit_by_pitch'] or 0,
            sf=row['sacrifice_flies'] or 0,
            sh=row['sacrifice_bunts'] or 0,
            k=row['strikeouts'] or 0,
            sb=row['stolen_bases'] or 0,
            cs=row['caught_stealing'] or 0,
            gidp=row['grounded_into_dp'] or 0,
        )

        adv = compute_batting_advanced(
            line, weights=weights,
            league_woba=avgs['avg_woba'],
            league_obp=avgs['avg_obp'],
            park_factor=park_factors.get(row['team_id'], 1.0),
        )

        cur.execute("""
            UPDATE summer_batting_stats SET
                woba = %s, wraa = %s, wrc = %s, wrc_plus = %s,
                iso = %s, babip = %s, bb_pct = %s, k_pct = %s,
                offensive_war = %s, wobacon = %s
            WHERE id = %s
        """, (
            round(adv.woba, 3), round(adv.wraa, 1), round(adv.wrc, 1),
            round(adv.wrc_plus, 0), round(adv.iso, 3), round(adv.babip, 3),
            round(adv.bb_pct, 3), round(adv.k_pct, 3),
            round(adv.off_war, 1), round(adv.wobacon, 3),
            row['id'],
        ))
        updated += 1

    conn.commit()
    print(f"  Updated {updated} batting records")
    return updated


def compute_pitching(conn, league_id, season, avgs, park_factors=None):
    """Compute advanced pitching stats for all players in a league/season."""
    park_factors = park_factors or {}
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    cur.execute("""
        SELECT sps.id, sps.team_id, sps.innings_pitched, sps.hits_allowed, sps.earned_runs,
               sps.runs_allowed, sps.walks, sps.strikeouts,
               sps.home_runs_allowed, sps.hit_batters, sps.batters_faced,
               sps.wild_pitches, sps.wins, sps.losses, sps.saves,
               sps.games, sps.games_started, sps.era
        FROM summer_pitching_stats sps
        JOIN summer_teams st ON sps.team_id = st.id
        WHERE sps.season = %s AND st.league_id = %s
    """, (season, league_id))

    rows = cur.fetchall()
    updated = 0

    for row in rows:
        ip_raw = row['innings_pitched'] or 0
        h = row['hits_allowed'] or 0
        bb = row['walks'] or 0
        hbp = row['hit_batters'] or 0
        k = row['strikeouts'] or 0
        bf = row['batters_faced'] or 0

        # Always estimate BF from pitching line — Pointstreak BF data is unreliable
        # (often reports per-game appearances or other wrong values)
        # BF ≈ outs + hits + walks + HBP (slightly undercounts due to missing SF/SH)
        baa_val = None
        if ip_raw > 0:
            ip_full = int(ip_raw)
            ip_partial = round((ip_raw - ip_full) * 10)
            outs = ip_full * 3 + ip_partial
            bf = outs + h + bb + hbp
            # BAA = hits / at-bats-against. AB-against ≈ outs + hits (walks/HBP
            # aren't at-bats), the same shape as the BF estimate above.
            ab_against = outs + h
            baa_val = round(h / ab_against, 3) if ab_against > 0 else None

        line = PitchingLine(
            ip=ip_raw,
            hits=h,
            er=row['earned_runs'] or 0,
            runs=row['runs_allowed'] or 0,
            bb=bb,
            ibb=0,  # Not tracked in summer stats
            k=k,
            hr=row['home_runs_allowed'] or 0,
            hbp=hbp,
            bf=bf,
            wp=row['wild_pitches'] or 0,
            wins=row['wins'] or 0,
            losses=row['losses'] or 0,
            saves=row['saves'] or 0,
            games=row['games'] or 0,
            gs=row['games_started'] or 0,
        )

        adv = compute_pitching_advanced(
            line,
            fip_constant=avgs['fip_constant'],
            league_hr_fb_rate=avgs['avg_hr_per_fb'],
            league_era=avgs['avg_era'],
            league_fip=avgs['avg_fip'],
            runs_per_win=avgs['runs_per_win'],
        )

        # League- and park-adjusted (100 = league average, higher is better).
        # Dividing the pitcher's ERA/FIP by his home park factor credits arms in
        # hitter parks and discounts arms in pitcher parks (same convention as
        # spring). park factor defaults to neutral 1.0 for teams without one.
        pf = park_factors.get(row['team_id'], 1.0)
        era_val = row['era']
        era_plus = round(100.0 * avgs['avg_era'] / (era_val / pf)) if era_val and era_val > 0 else None
        fip_plus = round(100.0 * avgs['avg_fip'] / (adv.fip / pf)) if adv.fip and adv.fip > 0 else None
        k_bb_pct = round(adv.k_pct - adv.bb_pct, 3)

        cur.execute("""
            UPDATE summer_pitching_stats SET
                fip = %s, babip_against = %s,
                k_pct = %s, bb_pct = %s,
                k_per_9 = %s, bb_per_9 = %s,
                h_per_9 = %s, hr_per_9 = %s,
                k_bb_ratio = %s, pitching_war = %s,
                xfip = %s, siera = %s, lob_pct = %s,
                era_plus = %s, fip_plus = %s, k_bb_pct = %s, baa = %s
            WHERE id = %s
        """, (
            round(adv.fip, 2), round(adv.babip_against, 3),
            round(adv.k_pct, 3), round(adv.bb_pct, 3),
            round(adv.k_per_9, 2), round(adv.bb_per_9, 2),
            round(adv.h_per_9, 2), round(adv.hr_per_9, 2),
            round(adv.k_bb_ratio, 2), round(adv.pitching_war, 1),
            round(adv.xfip, 2), round(adv.siera, 2), round(adv.lob_pct, 4),
            era_plus, fip_plus, k_bb_pct, baa_val,
            row['id'],
        ))
        updated += 1

    conn.commit()
    print(f"  Updated {updated} pitching records")
    return updated


def process_season(conn, season):
    """Process all leagues for a given season."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    cur.execute("SELECT id, name, abbreviation FROM summer_leagues ORDER BY id")
    leagues = cur.fetchall()

    for league in leagues:
        print(f"\n{'='*50}")
        print(f"Processing {league['name']} ({league['abbreviation']}) — {season}")
        print(f"{'='*50}")

        avgs = compute_league_averages(conn, league['id'], season)
        if avgs is None:
            print(f"  No data found, skipping")
            continue

        park_factors = load_park_factors()
        print(f"  Loaded {len(park_factors)} park factors "
              f"(applied to teams present; others neutral)")
        compute_batting(conn, league['id'], season, avgs, park_factors)
        compute_pitching(conn, league['id'], season, avgs, park_factors)


def main():
    parser = argparse.ArgumentParser(description="Compute summer advanced stats")
    parser.add_argument('--season', type=int, default=None, help="Season year (e.g. 2025)")
    parser.add_argument('--all', action='store_true', help="Compute for all seasons")
    args = parser.parse_args()

    if not DATABASE_URL:
        print("ERROR: DATABASE_URL not set. Export it or add to .env")
        sys.exit(1)

    conn = get_connection()

    if args.all:
        cur = conn.cursor()
        cur.execute("SELECT DISTINCT season FROM summer_batting_stats ORDER BY season")
        seasons = [r[0] for r in cur.fetchall()]
        print(f"Computing advanced stats for seasons: {seasons}")
        for s in seasons:
            process_season(conn, s)
    elif args.season:
        process_season(conn, args.season)
    else:
        # Default to most recent season
        cur = conn.cursor()
        cur.execute("SELECT MAX(season) FROM summer_batting_stats")
        latest = cur.fetchone()[0]
        if latest:
            print(f"Computing advanced stats for latest season: {latest}")
            process_season(conn, latest)
        else:
            print("No summer stats found in database")

    conn.close()
    print("\nDone!")


if __name__ == "__main__":
    main()
