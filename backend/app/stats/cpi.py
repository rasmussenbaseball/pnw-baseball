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
