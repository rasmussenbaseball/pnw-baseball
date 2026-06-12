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

  2. Results (~35%). A Simple Rating System (SRS) on capped run margins, solved
     iteratively so beating strong opponents counts more (strength of schedule).
     Regressed hard toward zero by games played — a 9-game record tells you little.

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
                season_games=DEFAULT_SEASON_GAMES):
    """Compute CPI for one league-season.

    team_ids: iterable of team ids that played games
    games_by_team: {tid: [(opponent_id, run_margin), ...]}
    offense: {tid: {"pa": int, "wrc_sum": float}}   wrc_sum = sum(wrc_plus * PA)
    pitching: {tid: {"ip": float, "fip_sum": float}} fip_sum = sum(fip * IP)

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

        # ── Results: SRS regressed hard toward 0 ──
        results_rd = srs[t] * gp / (gp + RESULTS_REGRESS_GAMES) if gp else 0.0

        final_rd = TALENT_WEIGHT * talent_rd + RESULTS_WEIGHT * results_rd

        proj = _pythagenpat_winpct(lg_rpg + final_rd / 2, lg_rpg - final_rd / 2)
        w, l = wins[t]
        actual = w / gp if gp else None
        sos = srs[t] - own_margin[t]  # average opponent strength (runs/game)

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

    ratings = compute_cpi(team_ids, games_by_team, offense, pitching,
                          season_games=season_games)
    rows = [{**r, "team_id": tid} for tid, r in ratings.items()]
    rows.sort(key=lambda x: -x["cpi_raw"])
    for i, row in enumerate(rows, 1):
        row["rank"] = i
    return rows
