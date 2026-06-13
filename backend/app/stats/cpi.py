"""
Composite Power Index (CPI) — a predictive team power rating.

Replaces the old PPI (a descriptive within-division z-score blend) with a
forward-looking rating built the way modern sabermetric systems work. It is
DATA-SOURCE AGNOSTIC: callers pass in games + team offense/pitching aggregates,
so the same engine powers WCL summer ball today and spring college ball later.

Three ingredients, blended predictive-first:

  1. Talent (the predictive core, ~65%). Expected run differential per game from
     UNDERLYING performance — PA-weighted team wRC+ for offense and IP-weighted
     team FIP for pitching. These strip out sequencing/clutch luck, so they're
     more stable and more predictive than raw W-L in a short season. Both are
     regressed toward league average by sample size (PA / IP).

  2. Results (~35%). Capped run margins plus a strength-of-schedule adjustment,
     so beating strong opponents counts more. By default the SoS comes from an
     internal Simple Rating System (SRS) solved iteratively over the cohort's
     games; callers may instead supply external_sos (runs/game above an average
     opponent) when a better schedule signal exists outside the cohort's game
     graph (e.g. PEAR-derived SoS for spring NCAA/NAIA divisions whose teams
     play mostly national opponents). Regressed hard toward zero by games
     played — a 9-game record tells you little.

  3. Blend -> one run-differential-per-game number, converted to a projected
     win % (Pythagenpat) and an expected record, and scaled to a readable index
     centered at 100 (league average), higher = better.

Everything is exposed as components (offense / pitching / schedule / luck) so the
rating is explainable, not a black box.
"""

# ── Tunables ───────────────────────────────────────────────
TALENT_WEIGHT = 0.65          # predictive-first: lean on underlying talent
RESULTS_WEIGHT = 0.35
MARGIN_CAP = 8.0              # cap run margin per game so blowouts don't dominate
RESULTS_REGRESS_GAMES = 30    # add this many league-average games to the record
OFF_REGRESS_PA = 150          # shrink team wRC+ toward 100 by this many PA
PIT_REGRESS_IP = 40           # shrink team FIP toward league FIP by this many IP
CPI_SCALE = 13.0             # index points per run/game of blended differential
FIP_INDEX_SCALE = 12.0
SOS_INDEX_SCALE = 10.0
DEFAULT_SEASON_GAMES = 54     # WCL regular season length, for expected record

# Full-season game counts per spring college division. Only used to scale the
# DISPLAYED expected record (exp_w/exp_l); the rating itself doesn't use them.
# Values are the typical scheduled season length per the 2026 data (median
# games played at season end: D1 ~55, D2 ~51, D3 ~40, NAIA ~51, NWAC ~47).
SEASON_GAMES_BY_LEVEL = {
    "D1": 56,
    "D2": 50,
    "D3": 40,
    "NAIA": 50,
    "JUCO": 45,
}


def _solve_srs(team_ids, games_by_team, iterations=100):
    """Iteratively solve SRS = own capped margin + average opponent rating.
    Returns (rating, own_margin) dicts. SoS for a team = rating - own_margin."""
    own = {}
    for t in team_ids:
        gs = games_by_team.get(t, [])
        own[t] = (sum(max(-MARGIN_CAP, min(MARGIN_CAP, d)) for _, d in gs) / len(gs)) if gs else 0.0
    rating = dict(own)
    for _ in range(iterations):
        nxt = {}
        for t in team_ids:
            gs = games_by_team.get(t, [])
            opp = (sum(rating.get(o, 0.0) for o, _ in gs) / len(gs)) if gs else 0.0
            nxt[t] = own[t] + opp
        # damp to guarantee convergence
        if max(abs(nxt[t] - rating[t]) for t in team_ids) < 1e-6:
            rating = nxt
            break
        rating = nxt
    return rating, own


def _pythagenpat_winpct(rs_pg, ra_pg):
    rs_pg = max(0.01, rs_pg)
    ra_pg = max(0.01, ra_pg)
    exp = (rs_pg + ra_pg) ** 0.287
    return rs_pg ** exp / (rs_pg ** exp + ra_pg ** exp)


def compute_cpi(team_ids, games_by_team, offense, pitching, *,
                season_games=DEFAULT_SEASON_GAMES, external_sos=None):
    """Compute CPI for one league-season.

    team_ids: iterable of team ids that played games
    games_by_team: {tid: [(opponent_id, run_margin), ...]}
    offense: {tid: {"pa": int, "wrc_sum": float}}   wrc_sum = sum(wrc_plus * PA)
    pitching: {tid: {"ip": float, "fip_sum": float}} fip_sum = sum(fip * IP)
    external_sos: optional {tid: sos_runs_per_game} — schedule strength in the
        engine's native units (runs/game above a league-average opponent,
        harder schedule = positive). When provided, it replaces the internal
        SRS opponent adjustment in the results component AND the displayed
        sos_index/sos_runs; teams missing from the dict get 0.0 (an average
        schedule). When None, the internal SRS path is used and behavior is
        identical to before this parameter existed. The engine stays
        data-source agnostic: how external_sos is derived (e.g. PEAR) lives
        in the caller/adapter, not here.

    Returns {tid: {...rating + components...}} (unranked; caller sorts).
    """
    team_ids = list(team_ids)
    if not team_ids:
        return {}

    # League context
    total_rf = total_g = 0
    wins = {}
    for t in team_ids:
        gs = games_by_team.get(t, [])
        total_g += len(gs)
        w = sum(1 for _, d in gs if d > 0)
        wins[t] = (w, len(gs) - w)
        total_rf += sum(d for _, d in gs)  # net cancels league-wide; recompute below
    # league runs/game from offense side: approximate via average team scoring.
    # We don't have raw RS here, so derive league FIP and use it as the run env.
    fip_ip = [(pitching[t]["fip_sum"], pitching[t]["ip"]) for t in team_ids
              if pitching.get(t, {}).get("ip")]
    lg_fip = (sum(s for s, _ in fip_ip) / sum(ip for _, ip in fip_ip)) if fip_ip else 4.5
    lg_rpg = lg_fip + 0.55  # FIP omits unearned + some context; nudge to true R/G env

    srs, own_margin = _solve_srs(team_ids, games_by_team)

    out = {}
    for t in team_ids:
        gp = len(games_by_team.get(t, []))
        # ── Talent: regressed team wRC+ and FIP ──
        o = offense.get(t, {})
        pa = o.get("pa", 0) or 0
        wrc = (o.get("wrc_sum", 0) + 100 * OFF_REGRESS_PA) / (pa + OFF_REGRESS_PA) if (pa + OFF_REGRESS_PA) else 100.0
        p = pitching.get(t, {})
        ip = p.get("ip", 0) or 0
        fip = (p.get("fip_sum", 0) + lg_fip * PIT_REGRESS_IP) / (ip + PIT_REGRESS_IP) if (ip + PIT_REGRESS_IP) else lg_fip
        off_rd = (wrc / 100.0 - 1.0) * lg_rpg          # runs/game above avg, offense
        pit_rd = (lg_fip - fip)                         # runs/game above avg, pitching (FIP ~ R/9)
        talent_rd = off_rd + pit_rd

        # ── Results: own capped margin + SoS, regressed hard toward 0 ──
        if external_sos is not None:
            sos = float(external_sos.get(t, 0.0))   # avg opponent strength (runs/game)
            results_full = own_margin[t] + sos
        else:
            sos = srs[t] - own_margin[t]  # average opponent strength (runs/game)
            results_full = srs[t]         # = own_margin + internal-SRS SoS
        results_rd = results_full * gp / (gp + RESULTS_REGRESS_GAMES) if gp else 0.0

        final_rd = TALENT_WEIGHT * talent_rd + RESULTS_WEIGHT * results_rd

        proj = _pythagenpat_winpct(lg_rpg + final_rd / 2, lg_rpg - final_rd / 2)
        w, l = wins[t]
        actual = w / gp if gp else None

        out[t] = {
            "cpi": round(100 + final_rd * CPI_SCALE),
            "cpi_raw": round(100 + final_rd * CPI_SCALE, 1),
            "proj_winpct": round(proj, 4),
            "exp_w": round(proj * season_games),
            "exp_l": round((1 - proj) * season_games),
            "actual_w": w, "actual_l": l,
            "actual_winpct": round(actual, 4) if actual is not None else None,
            "luck": round((actual - proj), 4) if actual is not None else None,
            "off_wrc": round(wrc),
            "pit_fip": round(fip, 2),
            "off_index": round(100 + off_rd * CPI_SCALE),
            "pit_index": round(100 + (lg_fip - fip) * FIP_INDEX_SCALE),
            "sos_index": round(100 + sos * SOS_INDEX_SCALE),
            "sos_runs": round(sos, 2),
            "run_diff_pg": round(final_rd, 2),
            "games": gp,
        }
    return out


# ── PEAR-based SoS for the spring adapter ──────────────────
# PEAR (national_ratings, source='pear') publishes a strength-of-schedule value
# per team where a LOWER value means a HARDER schedule. Verified empirically on
# the 2026 data: corr(sos, sos_rank) is +0.97 to +0.999 within every division,
# and sos_rank 1 is the toughest schedule, so value and rank point the same
# way (low = tough). We convert each division cohort's values to z-scores
# oriented harder = positive, then scale to the engine's native runs/game.
#
# Calibration (PEAR_SOS_RUNS_PER_SD = 1.0): the internal dense-graph SoS for
# NWAC — the one cohort whose teams play ONLY cohort opponents, so the SRS
# solve sees the complete schedule — spreads ~0.56 runs/game SD across 28
# teams (2026), and the undersampled D1 internal graph ~0.66. The PEAR cohorts
# span genuinely national schedule differences the internal graph can't see
# (the 2026 D1 cohort covers national SoS ranks 45 to 182 of 308), so 1.0
# run/SD — slightly above the dense-graph spread, at the conservative end of
# the plausible 0.75-1.5 range — keeps the results component from being
# whipsawed by z-scores computed over small (5-9 team) cohorts.
PEAR_SOS_RUNS_PER_SD = 1.0
PEAR_MIN_COVERED = 3          # need at least this many PEAR rows in a cohort


def _pear_external_sos(cur, team_ids, season):
    """Build {team_id: sos_runs_per_game} from PEAR SoS for one division
    cohort, or None when the cohort has no usable PEAR coverage (NWAC/JUCO —
    those fall back to the engine's internal SRS SoS, which is genuinely good
    there because NWAC teams only play NWAC teams).

    Latest scraped_at row per team+season wins. Teams in the cohort without a
    PEAR row are simply omitted: the engine treats them as 0.0 = the cohort
    mean schedule.
    """
    cur.execute(
        """SELECT DISTINCT ON (team_id) team_id, sos
           FROM national_ratings
           WHERE season = %s AND source = 'pear'
             AND team_id = ANY(%s) AND sos IS NOT NULL
           ORDER BY team_id, scraped_at DESC NULLS LAST""",
        (season, list(team_ids)),
    )
    vals = {r["team_id"]: float(r["sos"]) for r in cur.fetchall()}
    if len(vals) < PEAR_MIN_COVERED or len(vals) * 2 < len(team_ids):
        return None
    mean = sum(vals.values()) / len(vals)
    sd = (sum((v - mean) ** 2 for v in vals.values()) / len(vals)) ** 0.5
    if sd < 1e-9:
        return None
    # lower PEAR value = harder schedule, so (mean - value) makes harder positive
    return {t: (mean - v) / sd * PEAR_SOS_RUNS_PER_SD for t, v in vals.items()}


def compute_cpi_for_division(cur, division_team_ids, season, *,
                             season_games=DEFAULT_SEASON_GAMES):
    """Spring-college adapter: gather one division cohort's inputs and run
    compute_cpi. Mirrors the /summer/cpi endpoint but reads the spring tables.

    - games: final games where BOTH sides are in the cohort, so every SRS
      opponent has a rating. Cross-division and out-of-region games are
      excluded on purpose (the rating is within-division, like PPI was).
    - batting_stats: PA-weighted team wRC+ aggregates.
    - pitching_stats: IP-weighted team FIP aggregates. innings_pitched is
      baseball notation (6.2 = 6 2/3) but is only a weighting term here, so
      the small notation error is acceptable (same call as the summer side).
    - SoS: divisions with PEAR coverage (D1/D2/D3/NAIA) get external_sos from
      PEAR's national SoS via _pear_external_sos, because their teams play
      mostly opponents the cohort-internal game graph never sees. NWAC/JUCO
      has no PEAR rows, so _pear_external_sos returns None and the internal
      SRS SoS is used — appropriate there since NWAC teams only play NWAC.

    Returns a list of row dicts, one per team id passed in (teams with no
    cohort games regress to ~100), sorted best-first with a 1-based "rank"
    within the division. Fields match the summer CPI endpoint: cpi, cpi_raw,
    rank, proj_winpct, exp_w/exp_l, actual_w/actual_l (cohort games only),
    luck, off_wrc, pit_fip, off_index, pit_index, sos_index, sos_runs,
    run_diff_pg, games, team_id.
    """
    from collections import defaultdict

    team_ids = [int(t) for t in division_team_ids]
    if not team_ids:
        return []

    cur.execute(
        """SELECT home_team_id h, away_team_id a, home_score hs, away_score a_s
           FROM games
           WHERE season = %s AND status = 'final'
             AND home_score IS NOT NULL AND away_score IS NOT NULL
             AND home_team_id = ANY(%s) AND away_team_id = ANY(%s)""",
        (season, team_ids, team_ids),
    )
    games_by_team = defaultdict(list)
    for g in cur.fetchall():
        margin = float(g["hs"] - g["a_s"])
        games_by_team[g["h"]].append((g["a"], margin))
        games_by_team[g["a"]].append((g["h"], -margin))

    cur.execute(
        """SELECT team_id, SUM(plate_appearances) pa,
                  SUM(wrc_plus * plate_appearances) wsum
           FROM batting_stats
           WHERE season = %s AND team_id = ANY(%s)
             AND plate_appearances > 0 AND wrc_plus IS NOT NULL
           GROUP BY team_id""", (season, team_ids))
    offense = {r["team_id"]: {"pa": int(r["pa"]), "wrc_sum": float(r["wsum"])}
               for r in cur.fetchall()}

    cur.execute(
        """SELECT team_id, SUM(innings_pitched) ip, SUM(fip * innings_pitched) fsum
           FROM pitching_stats
           WHERE season = %s AND team_id = ANY(%s)
             AND innings_pitched > 0 AND fip IS NOT NULL
           GROUP BY team_id""", (season, team_ids))
    pitching = {r["team_id"]: {"ip": float(r["ip"]), "fip_sum": float(r["fsum"])}
                for r in cur.fetchall()}

    external_sos = _pear_external_sos(cur, team_ids, season)

    ratings = compute_cpi(team_ids, games_by_team, offense, pitching,
                          season_games=season_games, external_sos=external_sos)
    rows = [{**r, "team_id": tid} for tid, r in ratings.items()]
    rows.sort(key=lambda x: -x["cpi_raw"])
    for i, row in enumerate(rows, 1):
        row["rank"] = i
    return rows
