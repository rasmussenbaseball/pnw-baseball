"""
PNW Power Index (PPI) — Phase 1: Within-Division Team Strength Rating.

Measures each team's talent level relative to their division peers.
Produces a 0–100 score where 50 is division average.

Components (weighted):
  - Team WAR        (35%) — total roster talent (oWAR + pWAR)
  - Offensive Rating (20%) — PA-weighted team wRC+
  - Pitching Rating  (20%) — IP-weighted team FIP (inverted: lower FIP = better)
  - Win Percentage   (15%) — actual results
  - Conference Win%  (10%) — performance against direct peers

Each component is z-score normalized within its division, then
converted to a 50-centered scale (mean=50, 1 SD=15) to produce
readable ratings where ~20 is very bad and ~80 is dominant.
"""

import math
from typing import Optional


# ── Component weights ──────────────────────────────────────
WEIGHTS = {
    "team_war":    0.35,
    "offense":     0.20,
    "pitching":    0.20,
    "win_pct":     0.15,
    "conf_win_pct": 0.10,
}

# Scale: mean=50, 1 SD = 15 points
PPI_MEAN = 50.0
PPI_SD = 15.0


def _z_score(value: float, mean: float, std: float) -> float:
    """Standard z-score. Returns 0 if std is 0 (all teams identical)."""
    if std == 0 or std is None:
        return 0.0
    return (value - mean) / std


def _std_dev(values: list[float]) -> float:
    """Population standard deviation."""
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    variance = sum((x - mean) ** 2 for x in values) / len(values)
    return math.sqrt(variance)


def _mean(values: list[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def compute_ppi_for_division(teams: list[dict]) -> list[dict]:
    """
    Compute PPI for a list of teams within the same division.

    Each team dict must have:
      - id, short_name, logo_url (display)
      - team_war (float): total oWAR + pWAR
      - team_owar, team_pwar (float): components
      - team_wrc_plus (float): PA-weighted team wRC+
      - team_fip (float): IP-weighted team FIP
      - win_pct (float): 0-1
      - conf_win_pct (float): 0-1
      - wins, losses, conf_wins, conf_losses (int)

    Returns the same list with added fields:
      - ppi (float): overall PPI score (0-100 scale, 50=avg)
      - ppi_rank (int): rank within division
      - component scores: war_score, off_score, pitch_score, win_score, conf_score
    """
    if not teams:
        return []

    # ── Extract raw component values ──
    wars = [t["team_war"] for t in teams]
    offenses = [t["team_wrc_plus"] for t in teams]
    # Invert FIP: lower FIP is better, so negate for z-score
    fips = [t["team_fip"] for t in teams]
    win_pcts = [t["win_pct"] for t in teams]
    # For conf win%, only use teams that actually play conference games
    conf_pcts_active = [t["conf_win_pct"] for t in teams if t["conf_wins"] + t["conf_losses"] > 0]
    conf_pcts = [t["conf_win_pct"] for t in teams]

    # ── Compute means and standard deviations ──
    war_mean, war_std = _mean(wars), _std_dev(wars)
    off_mean, off_std = _mean(offenses), _std_dev(offenses)
    fip_mean, fip_std = _mean(fips), _std_dev(fips)
    win_mean, win_std = _mean(win_pcts), _std_dev(win_pcts)
    # Use only conference-playing teams for conf stats
    conf_mean = _mean(conf_pcts_active) if conf_pcts_active else 0.0
    conf_std = _std_dev(conf_pcts_active) if conf_pcts_active else 0.0

    # ── Score each team ──
    for t in teams:
        # Z-scores for each component
        z_war = _z_score(t["team_war"], war_mean, war_std)
        z_off = _z_score(t["team_wrc_plus"], off_mean, off_std)
        z_fip = -_z_score(t["team_fip"], fip_mean, fip_std)  # inverted
        z_win = _z_score(t["win_pct"], win_mean, win_std)
        # Teams with no conference games get a neutral z-score (0) instead of being penalized
        has_conf_games = t["conf_wins"] + t["conf_losses"] > 0
        z_conf = _z_score(t["conf_win_pct"], conf_mean, conf_std) if has_conf_games else 0.0

        # Weighted composite z-score
        composite_z = (
            WEIGHTS["team_war"] * z_war
            + WEIGHTS["offense"] * z_off
            + WEIGHTS["pitching"] * z_fip
            + WEIGHTS["win_pct"] * z_win
            + WEIGHTS["conf_win_pct"] * z_conf
        )

        # Convert to 50-centered scale
        ppi = PPI_MEAN + PPI_SD * composite_z

        # Clamp to 0-100
        ppi = max(0, min(100, ppi))

        # Individual component scores (same 50-centered scale)
        t["war_score"] = round(max(0, min(100, PPI_MEAN + PPI_SD * z_war)), 1)
        t["off_score"] = round(max(0, min(100, PPI_MEAN + PPI_SD * z_off)), 1)
        t["pitch_score"] = round(max(0, min(100, PPI_MEAN + PPI_SD * z_fip)), 1)
        t["win_score"] = round(max(0, min(100, PPI_MEAN + PPI_SD * z_win)), 1)
        t["conf_score"] = round(max(0, min(100, PPI_MEAN + PPI_SD * z_conf)), 1)
        t["ppi"] = round(ppi, 1)

    # ── Rank ──
    teams.sort(key=lambda t: t["ppi"], reverse=True)
    for i, t in enumerate(teams):
        t["ppi_rank"] = i + 1

    return teams
