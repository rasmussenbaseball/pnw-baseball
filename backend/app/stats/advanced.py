"""
Advanced Baseball Statistics Engine for PNW College Baseball.

Computes FIP, xFIP, SIERA, wOBA, wRC+, and a custom college WAR.
All formulas are derived from public sabermetric research (FanGraphs, etc.)
and adapted for college baseball contexts where batted-ball data is unavailable.

Key differences from MLB calculations:
- No batted-ball data (FB%, GB%, LD%) → we estimate HR/FB from league averages
- No pitch-level data → SIERA is simplified
- WAR uses a custom replacement level calibrated per division
- Park factors are estimated from team run environments
"""

import math
from dataclasses import dataclass, field
from typing import Optional


# ============================================================
# wOBA LINEAR WEIGHTS
# These are calibrated for college baseball environments.
# Can be overridden per-division/per-season from league_averages table.
# ============================================================

@dataclass
class LinearWeights:
    """wOBA linear weights. Defaults are approximate college-level values."""
    w_bb: float = 0.69        # Unintentional walk
    w_hbp: float = 0.72       # Hit by pitch
    w_1b: float = 0.88        # Single
    w_2b: float = 1.24        # Double
    w_3b: float = 1.56        # Triple
    w_hr: float = 2.00        # Home run
    woba_scale: float = 1.21  # Scale factor to align wOBA with OBP
    runs_per_pa: float = 0.12 # League average runs per PA
    runs_per_win: float = 9.5 # Runs per win (lower in college due to fewer games)


# Default weights by division level (can be overridden by actual league data)
DEFAULT_WEIGHTS = {
    "D1": LinearWeights(w_bb=0.69, w_hbp=0.72, w_1b=0.88, w_2b=1.24, w_3b=1.56, w_hr=2.00,
                        woba_scale=1.21, runs_per_pa=0.125, runs_per_win=9.0),
    "D2": LinearWeights(w_bb=0.69, w_hbp=0.72, w_1b=0.89, w_2b=1.25, w_3b=1.58, w_hr=2.02,
                        woba_scale=1.22, runs_per_pa=0.130, runs_per_win=9.5),
    "D3": LinearWeights(w_bb=0.70, w_hbp=0.73, w_1b=0.89, w_2b=1.26, w_3b=1.59, w_hr=2.03,
                        woba_scale=1.23, runs_per_pa=0.135, runs_per_win=10.0),
    "NAIA": LinearWeights(w_bb=0.70, w_hbp=0.73, w_1b=0.90, w_2b=1.27, w_3b=1.60, w_hr=2.05,
                          woba_scale=1.24, runs_per_pa=0.135, runs_per_win=9.5),
    "JUCO": LinearWeights(w_bb=0.70, w_hbp=0.73, w_1b=0.90, w_2b=1.27, w_3b=1.60, w_hr=2.05,
                          woba_scale=1.24, runs_per_pa=0.140, runs_per_win=10.0),
}


def _safe_div(numerator: float, denominator: float, default: float = 0.0) -> float:
    """Safe division that returns default when denominator is zero."""
    if denominator == 0:
        return default
    return numerator / denominator


def innings_to_outs(ip: float) -> int:
    """Convert innings pitched (e.g., 6.2 = 6 2/3) to total outs."""
    full_innings = int(ip)
    partial = round((ip - full_innings) * 10)  # .1 = 1 out, .2 = 2 outs
    return full_innings * 3 + partial


def outs_to_innings(outs: int) -> float:
    """Convert total outs to innings pitched format."""
    full = outs // 3
    partial = outs % 3
    return full + partial / 10


# ============================================================
# BATTING ADVANCED STATS
# ============================================================

@dataclass
class BattingLine:
    """Raw batting stats input."""
    pa: int = 0
    ab: int = 0
    hits: int = 0
    doubles: int = 0
    triples: int = 0
    hr: int = 0
    bb: int = 0
    ibb: int = 0
    hbp: int = 0
    sf: int = 0
    sh: int = 0
    k: int = 0
    sb: int = 0
    cs: int = 0
    gidp: int = 0

    @property
    def singles(self) -> int:
        return self.hits - self.doubles - self.triples - self.hr

    @property
    def ubb(self) -> int:
        """Unintentional walks."""
        return self.bb - self.ibb

    @property
    def tb(self) -> int:
        """Total bases."""
        return self.singles + 2 * self.doubles + 3 * self.triples + 4 * self.hr


@dataclass
class BattingAdvanced:
    """Computed advanced batting stats."""
    batting_avg: float = 0.0
    obp: float = 0.0
    slg: float = 0.0
    ops: float = 0.0
    iso: float = 0.0       # Isolated Power (SLG - AVG)
    babip: float = 0.0     # BABIP
    bb_pct: float = 0.0    # Walk rate (BB/PA)
    k_pct: float = 0.0     # Strikeout rate (K/PA)
    woba: float = 0.0      # Weighted On-Base Average
    wobacon: float = 0.0   # wOBA on Contact (excludes K and BB/HBP)
    wraa: float = 0.0      # Weighted Runs Above Average
    wrc: float = 0.0       # Weighted Runs Created
    wrc_plus: float = 0.0  # wRC+ (league/park adjusted)
    off_war: float = 0.0   # Offensive WAR component


def compute_batting_advanced(
    line: BattingLine,
    weights: Optional[LinearWeights] = None,
    league_woba: float = 0.320,
    league_obp: float = 0.340,
    park_factor: float = 1.0,
    division_level: str = "D1",
) -> BattingAdvanced:
    """
    Compute all advanced batting metrics from a stat line.

    Args:
        line: Raw batting stats
        weights: Linear weights (defaults to division-level defaults)
        league_woba: League average wOBA for the season/division
        league_obp: League average OBP for the season/division
        park_factor: Park factor adjustment (1.0 = neutral)
        division_level: 'D1', 'D2', 'D3', 'NAIA', 'JUCO'
    """
    if weights is None:
        weights = DEFAULT_WEIGHTS.get(division_level, DEFAULT_WEIGHTS["D1"])

    result = BattingAdvanced()

    # Traditional stats
    result.batting_avg = _safe_div(line.hits, line.ab)
    result.obp = _safe_div(
        line.hits + line.bb + line.hbp,
        line.ab + line.bb + line.hbp + line.sf,
    )
    result.slg = _safe_div(line.tb, line.ab)
    result.ops = result.obp + result.slg
    result.iso = result.slg - result.batting_avg

    # BABIP = (H - HR) / (AB - K - HR + SF)
    babip_denom = line.ab - line.k - line.hr + line.sf
    result.babip = _safe_div(line.hits - line.hr, babip_denom)

    # Rate stats
    result.bb_pct = _safe_div(line.bb, line.pa)
    result.k_pct = _safe_div(line.k, line.pa)

    # wOBA
    woba_num = (
        weights.w_bb * line.ubb
        + weights.w_hbp * line.hbp
        + weights.w_1b * line.singles
        + weights.w_2b * line.doubles
        + weights.w_3b * line.triples
        + weights.w_hr * line.hr
    )
    woba_denom = line.ab + line.ubb + line.sf + line.hbp
    result.woba = _safe_div(woba_num, woba_denom)

    # wOBACON = wOBA on contact (balls in play only)
    # Numerator uses only hit-value weights (no BB, no HBP)
    # Denominator is AB - K + SF (all contact events, including outs in play)
    wobacon_num = (
        weights.w_1b * line.singles
        + weights.w_2b * line.doubles
        + weights.w_3b * line.triples
        + weights.w_hr * line.hr
    )
    wobacon_denom = line.ab - line.k + line.sf
    result.wobacon = _safe_div(wobacon_num, wobacon_denom)

    # wRAA = ((wOBA - lgwOBA) / wOBAScale) * PA
    result.wraa = ((result.woba - league_woba) / weights.woba_scale) * line.pa

    # wRC = (((wOBA - lgwOBA) / wOBAScale) + lgR/PA) * PA
    result.wrc = (
        ((result.woba - league_woba) / weights.woba_scale) + weights.runs_per_pa
    ) * line.pa

    # wRC+ = 100 * (wRAA/PA + lgR/PA) / (park_factor * lgR/PA)
    if line.pa > 0 and weights.runs_per_pa > 0:
        result.wrc_plus = 100 * (
            (result.wraa / line.pa + weights.runs_per_pa)
            / (park_factor * weights.runs_per_pa)
        )
    else:
        result.wrc_plus = 0

    # Offensive WAR (simplified: wRAA / runs_per_win, ignoring replacement level for now)
    # Full WAR adds position adjustment + baserunning + replacement level
    result.off_war = _safe_div(result.wraa, weights.runs_per_win)

    return result


# ============================================================
# PITCHING ADVANCED STATS
# ============================================================

@dataclass
class PitchingLine:
    """Raw pitching stats input."""
    ip: float = 0.0       # Innings pitched (e.g. 6.2 = 6 2/3 IP)
    hits: int = 0
    er: int = 0
    runs: int = 0
    bb: int = 0
    ibb: int = 0
    k: int = 0
    hr: int = 0
    hbp: int = 0
    bf: int = 0           # Batters faced
    wp: int = 0
    wins: int = 0
    losses: int = 0
    saves: int = 0
    games: int = 0
    gs: int = 0

    @property
    def total_outs(self) -> int:
        return innings_to_outs(self.ip)

    @property
    def ip_decimal(self) -> float:
        """Convert IP to true decimal (6.2 → 6.667)."""
        outs = self.total_outs
        return outs / 3.0


@dataclass
class PitchingAdvanced:
    """Computed advanced pitching stats."""
    era: float = 0.0
    whip: float = 0.0
    k_per_9: float = 0.0
    bb_per_9: float = 0.0
    h_per_9: float = 0.0
    hr_per_9: float = 0.0
    k_bb_ratio: float = 0.0
    k_pct: float = 0.0       # K% = K/BF
    bb_pct: float = 0.0      # BB% = BB/BF
    fip: float = 0.0         # Fielding Independent Pitching
    xfip: float = 0.0        # Expected FIP (normalize HR/FB)
    siera: float = 0.0       # Skill-Interactive ERA (simplified)
    kwera: float = 0.0       # Strikeout-Walk ERA estimator
    babip_against: float = 0.0
    lob_pct: float = 0.0     # Left On Base %
    pitching_war: float = 0.0


def compute_fip_constant(
    league_era: float,
    league_hr: int,
    league_bb: int,
    league_hbp: int,
    league_k: int,
    league_ip: float,
) -> float:
    """
    Compute the FIP constant for a league/season.
    FIP constant = lgERA - ((13*lgHR + 3*(lgBB+lgHBP) - 2*lgK) / lgIP)
    """
    ip_decimal = innings_to_outs(league_ip) / 3.0 if league_ip else 1
    return league_era - (
        (13 * league_hr + 3 * (league_bb + league_hbp) - 2 * league_k) / ip_decimal
    )


def compute_pitching_advanced(
    line: PitchingLine,
    fip_constant: float = 3.10,
    league_hr_fb_rate: float = 0.10,
    league_era: float = 4.50,
    league_fip: float = 4.20,
    runs_per_win: float = 9.5,
    division_level: str = "D1",
) -> PitchingAdvanced:
    """
    Compute all advanced pitching metrics from a stat line.

    Args:
        line: Raw pitching stats
        fip_constant: FIP constant for the league/season
        league_hr_fb_rate: League average HR/FB rate (for xFIP)
        league_era: League average ERA (for WAR calculation)
        league_fip: League average FIP (for WAR calculation)
        runs_per_win: Runs per win for WAR calculation
        division_level: Division level string
    """
    result = PitchingAdvanced()

    ip = line.ip_decimal  # True decimal innings

    # Traditional rate stats
    result.era = _safe_div(line.er * 9, ip)
    result.whip = _safe_div(line.hits + line.bb, ip)
    result.k_per_9 = _safe_div(line.k * 9, ip)
    result.bb_per_9 = _safe_div(line.bb * 9, ip)
    result.h_per_9 = _safe_div(line.hits * 9, ip)
    result.hr_per_9 = _safe_div(line.hr * 9, ip)
    result.k_bb_ratio = _safe_div(line.k, line.bb)

    # Percentage rates
    result.k_pct = _safe_div(line.k, line.bf)
    result.bb_pct = _safe_div(line.bb, line.bf)

    # FIP = ((13*HR + 3*(BB+HBP) - 2*K) / IP) + FIP_constant
    if ip > 0:
        result.fip = (
            (13 * line.hr + 3 * (line.bb + line.hbp) - 2 * line.k) / ip
        ) + fip_constant
    else:
        result.fip = 0

    # xFIP: Replace actual HR with expected HR using league HR/FB rate
    # Since we don't have FB data, we estimate FB from (IP * ~3 BF/IP * league FB%)
    # Simplified: xFIP replaces HR/IP with league HR/FB * estimated FB rate
    if ip > 0:
        # Estimate fly balls: roughly (BF - K - BB - HBP) * 0.35 (estimated FB%)
        estimated_bip = line.bf - line.k - line.bb - line.hbp if line.bf > 0 else ip * 3
        estimated_fb = estimated_bip * 0.35
        expected_hr = estimated_fb * league_hr_fb_rate
        result.xfip = (
            (13 * expected_hr + 3 * (line.bb + line.hbp) - 2 * line.k) / ip
        ) + fip_constant
    else:
        result.xfip = 0

    # SIERA (Simplified - without actual GB/FB/LD data)
    # Uses K%, BB%, and estimated GB% based on HR rate
    # Full SIERA formula from Matt Swartz, simplified here:
    # SIERA ≈ 6.145 - 16.986*(K%) + 11.434*(BB%) - 1.858*(estimated GB%)
    #          + 7.653*(K%)^2 + 6.664*(estimated GB%)^2 + 10.130*(BB%)^2
    #          - 5.195*(K%*estimated GB%) - (0.986 * level_adjustment)
    if line.bf > 0 and ip > 0:
        k_rate = line.k / line.bf
        bb_rate = (line.bb - line.ibb) / line.bf
        # Estimate GB% from WHIP and HR rate (higher HR rate → lower GB%)
        estimated_gb_rate = max(0.30, 0.50 - (line.hr / max(line.bf, 1)) * 5)

        result.siera = (
            6.145
            - 16.986 * k_rate
            + 11.434 * bb_rate
            - 1.858 * estimated_gb_rate
            + 7.653 * k_rate ** 2
            + 6.664 * estimated_gb_rate ** 2
            + 10.130 * bb_rate ** 2
            - 5.195 * (k_rate * estimated_gb_rate)
        )
        # Clamp to reasonable range
        result.siera = max(0.50, min(result.siera, 12.00))
    else:
        result.siera = 0

    # kwERA = 5.40 - 12*(K-BB)/PA
    if line.bf > 0:
        result.kwera = 5.40 - 12 * ((line.k - line.bb) / line.bf)
    else:
        result.kwera = 0

    # BABIP against = (H - HR) / (BF - K - HR - BB - HBP)
    # Guard: if the denominator is implausibly small relative to hits in play,
    # the source data is likely missing BF or HBP (common when a scraper fails
    # to capture HBP). Publishing a >1.0 BABIP is never physically meaningful,
    # so store 0.0 in that case rather than poisoning leaderboards & averages.
    bip = line.bf - line.k - line.bb - line.hbp - line.hr
    hits_in_play = line.hits - line.hr
    if bip <= 0 or hits_in_play < 0 or hits_in_play > bip:
        result.babip_against = 0.0
    else:
        result.babip_against = _safe_div(hits_in_play, bip)

    # LOB% = (H + BB + HBP - R) / (H + BB + HBP - 1.4*HR)
    lob_num = line.hits + line.bb + line.hbp - line.runs
    lob_denom = line.hits + line.bb + line.hbp - 1.4 * line.hr
    result.lob_pct = _safe_div(lob_num, lob_denom)
    result.lob_pct = max(0, min(result.lob_pct, 1.0))  # Clamp 0-1

    # Pitching WAR
    # WAR = (lgFIP - FIP) / runs_per_win * (IP / 9) + replacement_level_wins
    # Replacement level differs for starters vs relievers:
    #   Starters:  ~0.03 WAR per 9 IP (harder to replace)
    #   Relievers: ~0.02 WAR per 9 IP (easier to find replacement)
    # Blend based on GS/G ratio for pitchers who do both
    if ip > 0:
        gs_frac = line.gs / line.games if line.games > 0 else 0.5
        repl_per_9 = 0.03 * gs_frac + 0.02 * (1 - gs_frac)
        replacement_level = repl_per_9 * (ip / 9)
        result.pitching_war = (
            (league_fip - result.fip) / runs_per_win * (ip / 9)
        ) + replacement_level
    else:
        result.pitching_war = 0

    return result


# ============================================================
# POSITION NORMALIZER
# ============================================================
#
# NWAC roster data is wildly inconsistent - teams enter position
# data however they want. We normalize every raw position string
# into one of these primary defensive positions:
#   C, 1B, 2B, 3B, SS, LF, CF, RF, OF, IF, DH, UT, P
#
# Philosophy:
# - When a specific position is listed, use it (e.g. "SS/2B" → SS)
# - When only a generic group is listed (OF, INF), keep the group
# - Pure numbers (jersey #s leaking in) → None
# - Two-way combos like "RHP/OF" → OF (for batting WAR purposes)

# Priority order: when a player has multiple positions listed,
# pick the one highest on the defensive spectrum (hardest position)
_POSITION_PRIORITY = ["C", "SS", "CF", "2B", "3B", "RF", "LF", "OF", "IF", "1B", "DH", "UT", "P"]

# Map of all known raw position tokens → normalized position
_POS_TOKEN_MAP = {
    # Catchers
    "c": "C", "catcher": "C",
    # Infield specific
    "ss": "SS", "shortstop": "SS",
    "2b": "2B", "second": "2B", "secondbase": "2B",
    "3b": "3B", "third": "3B", "thirdbase": "3B", "thirdbaseman": "3B",
    "1b": "1B", "first": "1B", "firstbase": "1B", "1st": "1B", "1stbase": "1B",
    "firstbaseman": "1B",
    # Outfield specific
    "cf": "CF", "centerfield": "CF", "center": "CF", "centerfielder": "CF",
    "lf": "LF", "leftfield": "LF", "leftfielder": "LF",
    "rf": "RF", "rightfield": "RF", "rightfielder": "RF",
    # Generic groups
    "of": "OF", "outfield": "OF", "outfielder": "OF",
    "if": "IF", "inf": "IF", "infield": "IF", "infielder": "IF",
    "mif": "IF",  # middle infield - could be SS or 2B, use IF
    "cif": "IF",  # corner infield
    # Utility / DH
    "ut": "UT", "utl": "UT", "uti": "UT", "util": "UT", "utility": "UT",
    "dh": "DH",
    # Pitchers
    "p": "P", "pitcher": "P", "rhp": "P", "lhp": "P",
    # Two-way marker
    "2-way": "UT", "2way": "UT",
    # Noise words to ignore (prevents "right" → RF, "left" → LF in
    # compound strings like "Right-Handed Pitcher", "Left-Handed Pitcher")
    "handed": None, "hand": None, "right": None, "left": None,
}


def normalize_position(raw_pos: Optional[str]) -> Optional[str]:
    """
    Normalize a messy roster position string into a primary defensive position.

    Examples:
        "RHP/OF"     → "OF"   (two-way: batting position is OF)
        "SS/2B"      → "SS"   (multi-pos: pick highest on spectrum)
        "INF"        → "IF"
        "C/3B"       → "C"
        "Outfield"   → "OF"
        "34"         → None   (jersey number junk)
        "OF 1B LHP"  → "OF"  (pick highest defensive position)
        "-"          → None
        None         → None
    """
    if not raw_pos:
        return None

    cleaned = raw_pos.strip()
    if not cleaned or cleaned == "-":
        return None

    # Reject pure numbers (jersey numbers leaking in as positions)
    if cleaned.isdigit():
        return None

    # Check full string (lowered, stripped) against token map before splitting
    # This catches "2-Way" and similar compound tokens
    full_lower = cleaned.lower().replace(" ", "").replace("-", "").replace("/", "")
    if full_lower in _POS_TOKEN_MAP:
        return _POS_TOKEN_MAP[full_lower]

    # Split on common separators: / , - space
    # Handle formats like "RHP/OF", "C/3B", "SS 2B", "3B, OF", "P-3B"
    import re
    tokens = re.split(r'[/,\-\s]+', cleaned.lower().strip())

    # Map each token to a normalized position
    found_positions = []
    for token in tokens:
        token = token.strip()
        if not token:
            continue
        # Check if token is in the map
        if token not in _POS_TOKEN_MAP:
            continue
        mapped = _POS_TOKEN_MAP[token]
        if mapped is None:
            # Noise word (e.g., "handed", "right", "left") - skip
            continue
        if mapped != "P":
            # For batting WAR, we want the defensive position, not "P"
            found_positions.append(mapped)
        elif not found_positions:
            # Only use P if nothing else is found
            found_positions.append("P")

    if not found_positions:
        # If all tokens mapped to P or nothing, check if any was a pitcher
        for token in tokens:
            mapped = _POS_TOKEN_MAP.get(token.strip())
            if mapped == "P":
                return "P"
        return None

    # Pick the highest-priority position (hardest on the defensive spectrum)
    for priority_pos in _POSITION_PRIORITY:
        if priority_pos in found_positions:
            return priority_pos

    return found_positions[0] if found_positions else None


# ============================================================
# COMPOSITE WAR (Custom College WAR)
# ============================================================

@dataclass
class CollegeWAR:
    """
    Custom WAR implementation for college baseball.

    Components:
    - Batting runs: From wRAA (offensive production above average)
    - Positional adjustment: Based on defensive spectrum (FanGraphs-style)
    - Replacement level: Playing time credit for being on the field
    - Pitching WAR: From FIP-based runs prevented (separate component)

    WAR = (Batting Runs + Positional Adj + Replacement Level) / Runs Per Win
          + Pitching WAR

    This is necessarily less precise than MLB WAR since we lack
    pitch-level data, batted-ball data, and defensive metrics.
    Think of it as "box score WAR" - directionally useful for
    comparing players within the same division.
    """
    batting_runs: float = 0.0       # wRAA (runs above average from batting)
    positional_runs: float = 0.0    # positional adjustment in runs
    replacement_runs: float = 0.0   # replacement level in runs
    offensive_war: float = 0.0      # (batting + pos + replacement) / RPW
    pitching_war: float = 0.0
    total_war: float = 0.0


# ── Positional adjustments ──────────────────────────────────
#
# FanGraphs MLB values per 162 games (runs):
#   C: +12.5, SS: +7.5, CF: +2.5, 2B: +2.5, 3B: +2.0,
#   RF: -7.5, LF: -7.5, 1B: -12.5, DH: -17.5
#
# We apply TWO scale factors:
#   1. Season length: 45/162 ≈ 0.278 (NWAC vs MLB)
#   2. Confidence discount: 0.50 - because we only have roster
#      positions, NOT actual game-log defensive innings. A guy
#      listed as "OF" might play CF every day, or rotate corners.
#      Until we get game-by-game fielding data, we halve the
#      adjustments so they nudge WAR without dominating it.
#
# Net scale: 0.278 * 0.50 ≈ 0.139
#
# Division-specific season parameters:
# games = typical regular-season games, pa = full-season PA for a starter
DIVISION_SEASON = {
    "D1":   {"games": 56, "pa": 280},
    "D2":   {"games": 50, "pa": 250},
    "D3":   {"games": 40, "pa": 200},
    "NAIA": {"games": 50, "pa": 250},
    "NWAC": {"games": 45, "pa": 220},
    "JUCO": {"games": 45, "pa": 220},
}
_MLB_GAMES = 162

# Fallback for unknown divisions
FULL_SEASON_PA = 220  # default (NWAC/JUCO)
SEASON_SCALE = 45 / _MLB_GAMES  # default season ratio

# When we have actual game-log position data, we use full positional
# adjustments (no discount needed - the data is real).
# When falling back to roster-only positions, we halve the adjustment
# because roster positions are unreliable ("OF" might be CF or LF, etc.).
CONFIDENCE_FULL = 1.0    # game-log-derived positions - full weight
CONFIDENCE_ROSTER = 0.50 # roster-only fallback - halved

POS_SCALE_FULL = SEASON_SCALE * CONFIDENCE_FULL
POS_SCALE_ROSTER = SEASON_SCALE * CONFIDENCE_ROSTER

# MLB positional run values per 162 games (raw, before scaling)
_RAW_POS_RUNS = {
    "C":  12.5,
    "SS":  7.5,
    "CF":  2.5,
    "2B":  2.5,
    "3B":  2.0,
    "RF": -7.5,
    "LF": -7.5,
    "1B": -12.5,
    "DH": -17.5,
    "P":   0.0,
    "OF":  0.0,   # ambiguous - neutral
    "IF":  0.5,   # could be SS or 3B - slight positive
    "UT":  0.0,   # utility - neutral
}

# Full-confidence positional adjustments (used when game-log data available)
POSITION_ADJUSTMENTS_FULL = {k: v * POS_SCALE_FULL for k, v in _RAW_POS_RUNS.items()}

# Roster-only positional adjustments (fallback when no game logs)
POSITION_ADJUSTMENTS_ROSTER = {k: v * POS_SCALE_ROSTER for k, v in _RAW_POS_RUNS.items()}

# Default: use roster-based (backward compatible)
POSITION_ADJUSTMENTS = POSITION_ADJUSTMENTS_ROSTER

# Replacement level: 20 runs below average per 600 PA (MLB standard),
# scaled to college. A full-season JUCO starter (~220 PA) gets about
# 20 * (220/600) * (45/162) ≈ 2.0 runs of replacement-level credit.
REPLACEMENT_RUNS_PER_600_PA = 20.0


def compute_college_war(
    batting: Optional[BattingAdvanced] = None,
    pitching: Optional[PitchingAdvanced] = None,
    position: str = "DH",
    plate_appearances: int = 0,
    innings_pitched: float = 0,
    division_level: str = "D1",
    position_weights: Optional[dict] = None,
) -> CollegeWAR:
    """
    Compute custom College WAR for a player.

    Offensive WAR formula:
        batting_runs = wRAA (already computed in BattingAdvanced)
        positional_runs = weighted positional adjustment * (PA / FULL_SEASON_PA)
        replacement_runs = REPL_PER_600 * (PA / 600)
        oWAR = (batting_runs + positional_runs + replacement_runs) / runs_per_win

    position_weights: optional dict of {position: fraction} derived from game logs.
        e.g. {"2B": 0.9, "SS": 0.1} means 90% of games at 2B, 10% at SS.
        When provided, the positional adjustment is a weighted average using
        full-confidence values (no roster discount).
        When None, falls back to single roster position with halved discount.

    Pitching WAR is computed separately in compute_pitching_advanced()
    and passed through here.

    For two-way players, both components are summed.
    """
    weights = DEFAULT_WEIGHTS.get(division_level, DEFAULT_WEIGHTS["D1"])
    war = CollegeWAR()

    # Division-specific season parameters
    div_params = DIVISION_SEASON.get(division_level, DIVISION_SEASON.get("NWAC"))
    div_season_scale = div_params["games"] / _MLB_GAMES
    div_full_season_pa = div_params["pa"]

    # ── Offensive component ──
    if batting and plate_appearances > 0:
        # Batting runs = wRAA (runs above average from hitting)
        war.batting_runs = batting.wraa

        # Positional adjustment scaled by playing time
        if position_weights:
            # Game-log-derived: weighted average of raw position runs,
            # scaled by this division's season length
            pos_adj_full_season = sum(
                _RAW_POS_RUNS.get(pos, 0.0) * div_season_scale * CONFIDENCE_FULL * frac
                for pos, frac in position_weights.items()
            )
        else:
            # Roster fallback: single position with halved confidence
            pos_adj_full_season = _RAW_POS_RUNS.get(position, 0.0) * div_season_scale * CONFIDENCE_ROSTER

        pa_fraction = plate_appearances / div_full_season_pa
        war.positional_runs = pos_adj_full_season * pa_fraction

        # Replacement level: credit for being on the field
        war.replacement_runs = REPLACEMENT_RUNS_PER_600_PA * (plate_appearances / 600.0)

        # Convert runs → wins
        war.offensive_war = (
            war.batting_runs + war.positional_runs + war.replacement_runs
        ) / weights.runs_per_win

    # ── Pitching component ──
    if pitching and innings_pitched > 0:
        war.pitching_war = pitching.pitching_war

    war.total_war = war.offensive_war + war.pitching_war

    return war


# ============================================================
# BATCH COMPUTATION (for processing full team/league data)
# ============================================================

def compute_league_averages(batting_lines: list[BattingLine], pitching_lines: list[PitchingLine]) -> dict:
    """
    Compute league-wide averages from a collection of individual stat lines.
    Used to calibrate wOBA weights, FIP constant, and wRC+ for a division/season.
    """
    # Aggregate batting
    total_pa = sum(b.pa for b in batting_lines)
    total_ab = sum(b.ab for b in batting_lines)
    total_h = sum(b.hits for b in batting_lines)
    total_bb = sum(b.bb for b in batting_lines)
    total_hbp = sum(b.hbp for b in batting_lines)
    total_sf = sum(b.sf for b in batting_lines)
    total_hr = sum(b.hr for b in batting_lines)
    total_k = sum(b.k for b in batting_lines)
    total_2b = sum(b.doubles for b in batting_lines)
    total_3b = sum(b.triples for b in batting_lines)
    total_1b = total_h - total_2b - total_3b - total_hr

    # Aggregate pitching
    total_ip = sum(p.ip_decimal for p in pitching_lines)
    total_er = sum(p.er for p in pitching_lines)
    total_p_hr = sum(p.hr for p in pitching_lines)
    total_p_bb = sum(p.bb for p in pitching_lines)
    total_p_hbp = sum(p.hbp for p in pitching_lines)
    total_p_k = sum(p.k for p in pitching_lines)
    total_runs = sum(p.runs for p in pitching_lines)

    avg_obp = _safe_div(total_h + total_bb + total_hbp, total_ab + total_bb + total_hbp + total_sf)
    avg_slg = _safe_div(
        total_1b + 2 * total_2b + 3 * total_3b + 4 * total_hr, total_ab
    )
    avg_era = _safe_div(total_er * 9, total_ip)

    fip_const = compute_fip_constant(
        avg_era, total_p_hr, total_p_bb, total_p_hbp, total_p_k, total_ip
    ) if total_ip > 0 else 3.10

    return {
        "avg_batting_avg": _safe_div(total_h, total_ab),
        "avg_obp": avg_obp,
        "avg_slg": avg_slg,
        "avg_ops": avg_obp + avg_slg,
        "avg_era": avg_era,
        "avg_k_per_9": _safe_div(total_p_k * 9, total_ip),
        "avg_bb_per_9": _safe_div(total_p_bb * 9, total_ip),
        "avg_hr_per_9": _safe_div(total_p_hr * 9, total_ip),
        "avg_runs_per_game": _safe_div(total_runs, total_ip / 9) if total_ip > 0 else 0,
        "fip_constant": fip_const,
        "league_hr_fb_rate": 0.10,  # Default estimate; update when we have more data
    }
