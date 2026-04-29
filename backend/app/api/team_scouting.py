"""
Team Scouting page backend.

Aggregates EVERY team-level stat (offense, pitching, plate discipline,
batted-ball, situational) for a single team plus per-player breakdowns,
each with percentile rank within the team's CONFERENCE (so NAIA teams
get compared to NAIA, D3 to D3, etc.).

Phase A scope:
  - Team header + last-10 record
  - Team stats with conference percentiles
  - Hitters (>=30 PA), Starters (>=15 IP, GS>0), Relievers (>=5 IP, GS=0)
  - Per-player strengths/weaknesses (top-2 / bottom-2 by percentile)
  - Auto-generated team writeup (template-based, picks top strengths/weaknesses)

Phase B (deferred): situational splits, reliever-usage tracker, trends.
"""

from __future__ import annotations

import math
from typing import Optional

# Reuse the lineup helper's PBP-stats-per-hitter bulk fetcher.
from .lineup_helper import _fetch_pbp_stats_bulk as _fetch_hitter_pbp_bulk


# ─────────────────────────────────────────────────────────────────
# Stat catalog
#   key         : column name in batting_stats / pitching_stats / our agg
#   label       : human-readable display name
#   group       : which panel this lives in (offense / pitching / plate_discipline / batted_ball)
#   direction   : 'higher_better' or 'lower_better' (drives the color flip)
#   format      : 'rate' (3 decimals .350), 'pct' (37.0%), 'int', 'era' (3.45), 'war' (1.7)
# ─────────────────────────────────────────────────────────────────

TEAM_OFFENSE_STATS = [
    {'key': 'batting_avg',  'label': 'AVG',    'direction': 'higher_better', 'format': 'rate'},
    {'key': 'on_base_pct',  'label': 'OBP',    'direction': 'higher_better', 'format': 'rate'},
    {'key': 'slugging_pct', 'label': 'SLG',    'direction': 'higher_better', 'format': 'rate'},
    {'key': 'ops',          'label': 'OPS',    'direction': 'higher_better', 'format': 'rate'},
    {'key': 'iso',          'label': 'ISO',    'direction': 'higher_better', 'format': 'rate'},
    {'key': 'woba',         'label': 'wOBA',   'direction': 'higher_better', 'format': 'rate'},
    {'key': 'wrc_plus',     'label': 'wRC+',   'direction': 'higher_better', 'format': 'int'},
    {'key': 'bb_pct',       'label': 'BB%',    'direction': 'higher_better', 'format': 'pct'},
    {'key': 'k_pct',        'label': 'K%',     'direction': 'lower_better',  'format': 'pct'},
    {'key': 'home_runs',    'label': 'HR',     'direction': 'higher_better', 'format': 'int'},
    {'key': 'hr_per_pa',    'label': 'HR/PA',  'direction': 'higher_better', 'format': 'pct'},
    {'key': 'stolen_bases', 'label': 'SB',     'direction': 'higher_better', 'format': 'int'},
    {'key': 'babip',        'label': 'BABIP',  'direction': 'higher_better', 'format': 'rate'},
    {'key': 'runs_per_game','label': 'R/G',    'direction': 'higher_better', 'format': 'era'},
]

TEAM_PITCHING_STATS = [
    {'key': 'era',          'label': 'ERA',     'direction': 'lower_better',  'format': 'era'},
    {'key': 'fip',          'label': 'FIP',     'direction': 'lower_better',  'format': 'era'},
    {'key': 'siera',        'label': 'SIERA',   'direction': 'lower_better',  'format': 'era'},
    {'key': 'whip',         'label': 'WHIP',    'direction': 'lower_better',  'format': 'era'},
    {'key': 'k_pct',        'label': 'K%',      'direction': 'higher_better', 'format': 'pct'},
    {'key': 'bb_pct',       'label': 'BB%',     'direction': 'lower_better',  'format': 'pct'},
    {'key': 'k_bb_ratio',   'label': 'K/BB',    'direction': 'higher_better', 'format': 'era'},
    {'key': 'hr_per_9',     'label': 'HR/9',    'direction': 'lower_better',  'format': 'era'},
    {'key': 'opp_avg',      'label': 'opp AVG', 'direction': 'lower_better',  'format': 'rate'},
    {'key': 'ra_per_game',  'label': 'RA/G',    'direction': 'lower_better',  'format': 'era'},
    # Pitcher-side PBP — these come from the pbp_pitching group
    {'key': 'strike_pct',   'label': 'Strike%', 'direction': 'higher_better', 'format': 'pct', 'group': 'pbp_pitching'},
    {'key': 'whiff_pct',    'label': 'Whiff%',  'direction': 'higher_better', 'format': 'pct', 'group': 'pbp_pitching'},
    {'key': 'fps_pct',      'label': 'FPS%',    'direction': 'higher_better', 'format': 'pct', 'group': 'pbp_pitching'},
    {'key': 'putaway_pct',  'label': 'Putaway%','direction': 'higher_better', 'format': 'pct', 'group': 'pbp_pitching'},
]

# Plate Discipline = the team's HITTERS' approach. No pitcher-side metrics here.
TEAM_PBP_DISCIPLINE_STATS = [
    {'key': 'contact_pct',         'label': 'Contact%',    'direction': 'higher_better', 'format': 'pct', 'group': 'pbp_offense'},
    {'key': 'swing_pct',           'label': 'Swing%',      'direction': 'higher_better', 'format': 'pct', 'group': 'pbp_offense'},
    {'key': 'first_pitch_swing_pct','label': 'First Pitch Swing%','direction': 'neutral','format': 'pct','group': 'pbp_offense'},
    {'key': 'zero_zero_bip_pct',   'label': '0-0 BIP%',    'direction': 'higher_better', 'format': 'pct', 'group': 'pbp_offense'},
]

TEAM_PBP_BATTED_BALL_STATS = [
    {'key': 'gb_pct',           'label': 'GB%',      'direction': 'neutral',       'format': 'pct', 'group': 'pbp_offense'},
    {'key': 'ld_pct',           'label': 'LD%',      'direction': 'higher_better', 'format': 'pct', 'group': 'pbp_offense'},
    {'key': 'fb_pct',           'label': 'FB%',      'direction': 'neutral',       'format': 'pct', 'group': 'pbp_offense'},
    {'key': 'pu_pct',           'label': 'PU%',      'direction': 'lower_better',  'format': 'pct', 'group': 'pbp_offense'},
    {'key': 'air_pull_pct',     'label': 'AIRPULL%', 'direction': 'higher_better', 'format': 'pct', 'group': 'pbp_offense'},
    {'key': 'opp_gb_pct',       'label': 'opp GB%',  'direction': 'higher_better', 'format': 'pct', 'group': 'pbp_pitching'},
    {'key': 'opp_ld_pct',       'label': 'opp LD%',  'direction': 'lower_better',  'format': 'pct', 'group': 'pbp_pitching'},
    {'key': 'opp_fb_pct',       'label': 'opp FB%',  'direction': 'neutral',       'format': 'pct', 'group': 'pbp_pitching'},
]

# Per-player strength/weakness candidate stats. We pick top-2 percentile and
# bottom-2 percentile from these per player.
HITTER_FLAG_STATS = [
    {'key': 'on_base_pct',  'label': 'OBP',      'direction': 'higher_better'},
    {'key': 'slugging_pct', 'label': 'SLG',      'direction': 'higher_better'},
    {'key': 'iso',          'label': 'ISO',      'direction': 'higher_better'},
    {'key': 'woba',         'label': 'wOBA',     'direction': 'higher_better'},
    {'key': 'wrc_plus',     'label': 'wRC+',     'direction': 'higher_better'},
    {'key': 'bb_pct',       'label': 'BB%',      'direction': 'higher_better'},
    {'key': 'k_pct',        'label': 'K%',       'direction': 'lower_better'},
    {'key': 'hr_per_pa',    'label': 'HR/PA',    'direction': 'higher_better'},
    {'key': 'contact_pct',  'label': 'Contact%', 'direction': 'higher_better'},
    {'key': 'air_pull_pct', 'label': 'AIRPULL%', 'direction': 'higher_better'},
]

PITCHER_FLAG_STATS = [
    {'key': 'era',          'label': 'ERA',      'direction': 'lower_better'},
    {'key': 'fip',          'label': 'FIP',      'direction': 'lower_better'},
    {'key': 'k_pct',        'label': 'K%',       'direction': 'higher_better'},
    {'key': 'bb_pct',       'label': 'BB%',      'direction': 'lower_better'},
    {'key': 'whip',         'label': 'WHIP',     'direction': 'lower_better'},
    {'key': 'hr_per_9',     'label': 'HR/9',     'direction': 'lower_better'},
    {'key': 'babip_against','label': 'BABIP',    'direction': 'lower_better'},
    {'key': 'whiff_pct',    'label': 'Whiff%',   'direction': 'higher_better'},
    {'key': 'fps_pct',      'label': 'FPS%',     'direction': 'higher_better'},
    {'key': 'putaway_pct',  'label': 'Putaway%', 'direction': 'higher_better'},
]


# ─────────────────────────────────────────────────────────────────
# Percentile + color helpers
# ─────────────────────────────────────────────────────────────────

def percentile_rank(value, all_values, direction):
    """Rank `value` against `all_values` and return percentile (0-100).
    For direction='higher_better', higher value = higher percentile.
    For 'lower_better', lower value = higher percentile.
    For 'neutral', returns a standard "higher value = higher percentile" so the
    bar still has a position to render at, but the color bucket is neutral.
    """
    if value is None:
        return None
    vals = [v for v in all_values if v is not None]
    if len(vals) < 2:
        return 50.0
    if direction == 'lower_better':
        below = sum(1 for v in vals if v > value)
    else:
        # 'higher_better' or 'neutral' — both rank by raw value
        below = sum(1 for v in vals if v < value)
    equal = sum(1 for v in vals if v == value)
    pct = ((below + equal * 0.5) / len(vals)) * 100.0
    return round(pct, 1)


def percentile_to_color(p, direction='higher_better'):
    """Bucket percentile into a color label. Neutral stats stay gray
    regardless of percentile — the bar still shows position but doesn't
    imply good/bad."""
    if p is None:
        return 'neutral'
    if direction == 'neutral':
        return 'neutral'
    if p >= 90: return 'elite'
    if p >= 70: return 'good'
    if p >= 30: return 'avg'
    if p >= 10: return 'poor'
    return 'bad'


def rank_within(value, all_values, direction):
    """Return (rank, total) where rank=1 is best for directional stats.
    For 'neutral', rank reflects raw ordering (high value = rank 1) so we
    can still show "5 of 8" context without implying good/bad."""
    if value is None:
        return None, len(all_values)
    vals = [v for v in all_values if v is not None]
    if not vals:
        return None, 0
    if direction == 'lower_better':
        better = sum(1 for v in vals if v < value)
    else:
        # 'higher_better' or 'neutral'
        better = sum(1 for v in vals if v > value)
    return better + 1, len(vals)


# ─────────────────────────────────────────────────────────────────
# Team-level aggregations
# ─────────────────────────────────────────────────────────────────

def _aggregate_team_offense(cur, team_id, season):
    """Aggregate batting_stats for one team into a single row of team-level
    rate stats. Recomputes rates from sums (don't average rates)."""
    cur.execute("""
        SELECT
          SUM(plate_appearances) AS pa,
          SUM(at_bats)           AS ab,
          SUM(hits)              AS h,
          SUM(doubles)           AS db,
          SUM(triples)           AS tp,
          SUM(home_runs)         AS hr,
          SUM(walks)             AS bb,
          SUM(intentional_walks) AS ibb,
          SUM(hit_by_pitch)      AS hbp,
          SUM(strikeouts)        AS so,
          SUM(stolen_bases)      AS sb,
          SUM(caught_stealing)   AS cs,
          SUM(sacrifice_flies)   AS sf,
          SUM(sacrifice_bunts)   AS sh,
          SUM(runs)              AS r,
          SUM(rbi)               AS rbi
        FROM batting_stats
        WHERE team_id = %s AND season = %s
    """, (team_id, season))
    r = cur.fetchone()
    if not r or not r['pa']:
        return None
    pa, ab, h, db, tp, hr, bb, ibb, hbp, so, sb, cs, sf, sh = (
        r['pa'], r['ab'], r['h'], r['db'], r['tp'], r['hr'],
        r['bb'], r['ibb'], r['hbp'], r['so'], r['sb'], r['cs'],
        r['sf'], r['sh']
    )
    bb_total = (bb or 0) + (ibb or 0)
    singles = (h or 0) - (db or 0) - (tp or 0) - (hr or 0)
    tb = singles + 2*(db or 0) + 3*(tp or 0) + 4*(hr or 0)

    avg = h / ab if ab else 0
    obp = (h + bb_total + (hbp or 0)) / (ab + bb_total + (hbp or 0) + (sf or 0)) if (ab + bb_total + (hbp or 0) + (sf or 0)) else 0
    slg = tb / ab if ab else 0
    iso = slg - avg
    bb_pct = bb_total / pa if pa else 0
    k_pct = (so or 0) / pa if pa else 0
    hr_per_pa = (hr or 0) / pa if pa else 0
    babip_denom = (ab - so - hr + sf) if (ab and so is not None and hr is not None) else 0
    babip = (h - hr) / babip_denom if babip_denom else 0

    # wOBA from D3/NAIA-style linear weights (close enough for percentile use).
    # We're not computing perfect college wRC+ here — use the avg of player wOBAs
    # weighted by PA from batting_stats instead.
    cur.execute("""
        SELECT
          SUM(woba * plate_appearances) / NULLIF(SUM(plate_appearances), 0) AS team_woba,
          SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
            / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0) AS team_wrc_plus
        FROM batting_stats
        WHERE team_id = %s AND season = %s
    """, (team_id, season))
    woba_row = cur.fetchone() or {}

    return {
        'pa': pa, 'ab': ab, 'hits': h, 'home_runs': hr, 'stolen_bases': sb,
        'runs': r['r'], 'rbi': r['rbi'],
        'batting_avg': avg, 'on_base_pct': obp, 'slugging_pct': slg,
        'ops': obp + slg, 'iso': iso, 'babip': babip,
        'bb_pct': bb_pct, 'k_pct': k_pct, 'hr_per_pa': hr_per_pa,
        'woba': float(woba_row.get('team_woba') or 0),
        'wrc_plus': float(woba_row.get('team_wrc_plus') or 100),
    }


def _aggregate_team_pitching(cur, team_id, season):
    """Aggregate pitching_stats for one team."""
    cur.execute("""
        SELECT
          SUM(games)              AS g,
          SUM(innings_pitched)    AS ip,
          SUM(earned_runs)        AS er,
          SUM(hits_allowed)       AS h,
          SUM(walks)              AS bb,
          SUM(strikeouts)         AS so,
          SUM(home_runs_allowed)  AS hr,
          SUM(hit_batters)        AS hbp,
          SUM(batters_faced)      AS bf
        FROM pitching_stats
        WHERE team_id = %s AND season = %s
    """, (team_id, season))
    r = cur.fetchone()
    if not r or not r['ip']:
        return None
    ip, er, h, bb, so, hr, bf = (
        float(r['ip']), float(r['er'] or 0), float(r['h'] or 0),
        float(r['bb'] or 0), float(r['so'] or 0), float(r['hr'] or 0),
        float(r['bf'] or 0),
    )
    era = (er * 9 / ip) if ip else 0
    whip = (h + bb) / ip if ip else 0
    k_per_9 = (so * 9 / ip) if ip else 0
    bb_per_9 = (bb * 9 / ip) if ip else 0
    hr_per_9 = (hr * 9 / ip) if ip else 0
    k_bb_ratio = (so / bb) if bb else (so if so else 0)
    k_pct = (so / bf) if bf else 0
    bb_pct = (bb / bf) if bf else 0
    opp_avg = (h / (bf - bb - r.get('hbp', 0))) if (bf - bb - (r.get('hbp') or 0)) > 0 else 0

    # Team-level FIP/SIERA: weighted avg of player FIP / SIERA by IP
    cur.execute("""
        SELECT
          SUM(fip * innings_pitched) FILTER (WHERE fip IS NOT NULL)
            / NULLIF(SUM(innings_pitched) FILTER (WHERE fip IS NOT NULL), 0) AS team_fip,
          SUM(siera * innings_pitched) FILTER (WHERE siera IS NOT NULL)
            / NULLIF(SUM(innings_pitched) FILTER (WHERE siera IS NOT NULL), 0) AS team_siera
        FROM pitching_stats
        WHERE team_id = %s AND season = %s
    """, (team_id, season))
    f = cur.fetchone() or {}

    return {
        'g': r['g'], 'ip': ip, 'er': er, 'so': so, 'bb': bb, 'hr': hr,
        'era': era, 'whip': whip,
        'k_per_9': k_per_9, 'bb_per_9': bb_per_9, 'hr_per_9': hr_per_9,
        'k_bb_ratio': k_bb_ratio, 'k_pct': k_pct, 'bb_pct': bb_pct,
        'opp_avg': opp_avg,
        'fip': float(f.get('team_fip') or 0),
        'siera': float(f.get('team_siera') or 0),
    }


def _aggregate_team_pbp_offense(cur, team_id, season):
    """Aggregate game_events for the team's HITTERS (batting_team_id).
    All metrics here are about the team's hitters."""
    cur.execute("""
        SELECT
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))) AS k_pitches,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))) AS f_pitches,
          SUM(LENGTH(pitch_sequence)) AS seq_total,
          COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play,
          COUNT(*) FILTER (WHERE bb_type = 'GB') AS gb,
          COUNT(*) FILTER (WHERE bb_type = 'FB') AS fb,
          COUNT(*) FILTER (WHERE bb_type = 'LD') AS ld,
          COUNT(*) FILTER (WHERE bb_type = 'PU') AS pu,
          COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
          COUNT(*) FILTER (
            WHERE bb_type IN ('LD','FB')
              AND ((UPPER(p.bats) = 'R' AND field_zone = 'LEFT')
                OR (UPPER(p.bats) = 'L' AND field_zone = 'RIGHT'))
          ) AS air_pull,
          COUNT(*) FILTER (WHERE balls_before = 0 AND strikes_before = 0
                           AND was_in_play) AS first_pitch_in_play,
          -- First-pitch swings: batter offered at the first pitch
          --   - Sequence starts with K (swing-and-miss) or F (foul ball)
          --   - OR sequence empty and was_in_play (1-pitch ball in play)
          --   - OR sequence empty and result was a swinging K (1-pitch swinging K)
          COUNT(*) FILTER (
            WHERE (LENGTH(pitch_sequence) > 0 AND LEFT(pitch_sequence, 1) IN ('K','F'))
               OR (LENGTH(pitch_sequence) = 0 AND was_in_play)
               OR (LENGTH(pitch_sequence) = 0
                   AND ge.result_type = 'strikeout_swinging')
          ) AS first_pitch_swings,
          COUNT(*) AS pa
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        LEFT JOIN players p ON p.id = ge.batter_player_id
        WHERE ge.batting_team_id = %s AND g.season = %s
          AND ge.result_type IS NOT NULL
    """, (team_id, season))
    r = cur.fetchone() or {}
    k_p = float(r.get('k_pitches') or 0)
    f_p = float(r.get('f_pitches') or 0)
    seq = float(r.get('seq_total') or 0)
    in_play = float(r.get('in_play') or 0)
    bb_total = float(r.get('bb_total') or 0)
    pa = float(r.get('pa') or 0)

    swings = k_p + f_p + in_play
    contact = f_p + in_play
    total_pitches = seq + in_play

    def _safe(num, denom):
        return float(num) / float(denom) if denom else None

    return {
        'contact_pct':              _safe(contact, swings),
        'swing_pct':                _safe(swings, total_pitches),
        'first_pitch_swing_pct':    _safe(r.get('first_pitch_swings') or 0, pa),
        'gb_pct':                   _safe(r.get('gb') or 0, bb_total),
        'fb_pct':                   _safe(r.get('fb') or 0, bb_total),
        'ld_pct':                   _safe(r.get('ld') or 0, bb_total),
        'pu_pct':                   _safe(r.get('pu') or 0, bb_total),
        'air_pull_pct':             _safe(r.get('air_pull') or 0, bb_total),
        'zero_zero_bip_pct':        _safe(r.get('first_pitch_in_play') or 0, pa),
    }


def _aggregate_team_pbp_pitching(cur, team_id, season):
    """Aggregate game_events for the team's PITCHERS (defending_team_id).
    Metrics here describe what their pitchers do to opposing batters.
    """
    cur.execute("""
        SELECT
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))) AS k_pitches,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))) AS s_pitches,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))) AS f_pitches,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'B', ''))) AS b_pitches,
          SUM(pitches_thrown) AS pitches_total,
          COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play,
          -- First-pitch strike: K/S/F first char, OR 1-pitch in-play. The
          -- pitches_thrown=1 guard excludes PAs whose box score didn't
          -- capture pitch counts (otherwise every empty-seq + was_in_play
          -- looks like a 1-pitch strike and inflates the rate).
          COUNT(*) FILTER (
            WHERE (LENGTH(pitch_sequence) > 0 AND LEFT(pitch_sequence, 1) IN ('K','S','F'))
               OR (LENGTH(pitch_sequence) = 0 AND was_in_play AND pitches_thrown = 1)
          ) AS first_pitch_strikes,
          COUNT(*) FILTER (WHERE pitches_thrown IS NOT NULL AND pitches_thrown >= 1) AS fps_pa_known,
          COUNT(*) FILTER (WHERE strikes_before >= 2
                           AND ge.result_type IN ('strikeout_swinging','strikeout_looking')) AS putaway_k,
          COUNT(*) FILTER (WHERE strikes_before >= 2) AS two_strike_pa,
          COUNT(*) FILTER (WHERE bb_type = 'GB') AS gb,
          COUNT(*) FILTER (WHERE bb_type = 'FB') AS fb,
          COUNT(*) FILTER (WHERE bb_type = 'LD') AS ld,
          COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
          COUNT(*) AS pa
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        WHERE ge.defending_team_id = %s AND g.season = %s
          AND ge.result_type IS NOT NULL
    """, (team_id, season))
    r = cur.fetchone() or {}
    k_p = float(r.get('k_pitches') or 0)
    s_p = float(r.get('s_pitches') or 0)
    f_p = float(r.get('f_pitches') or 0)
    in_play = float(r.get('in_play') or 0)
    bb_total = float(r.get('bb_total') or 0)
    pa = float(r.get('pa') or 0)
    pitches_total = float(r.get('pitches_total') or 0)
    swings = k_p + f_p + in_play

    # Strike% — count all strike letters in the sequence (K=swing+miss,
    # S=called strike, F=foul) PLUS in-play pitches (the terminal pitch
    # of any batted ball is a strike by definition). Strikeouts have
    # the terminal K already in pitch_sequence, so don't add it again.
    # Pitches denominator is the parser's stored pitches_thrown sum.
    strikes = k_p + s_p + f_p + in_play

    def _safe(num, denom):
        return float(num) / float(denom) if denom else None

    return {
        'strike_pct':   _safe(strikes, pitches_total),
        'whiff_pct':    _safe(k_p, swings),
        'fps_pct':      _safe(r.get('first_pitch_strikes') or 0, r.get('fps_pa_known') or 0),
        'putaway_pct':  _safe(r.get('putaway_k') or 0, r.get('two_strike_pa') or 0),
        'opp_gb_pct':   _safe(r.get('gb') or 0, bb_total),
        'opp_fb_pct':   _safe(r.get('fb') or 0, bb_total),
        'opp_ld_pct':   _safe(r.get('ld') or 0, bb_total),
    }


def _team_runs_for_against(cur, team_id, season):
    """Compute team runs scored / allowed and games played."""
    cur.execute("""
        SELECT
          COUNT(*) AS g,
          SUM(CASE WHEN home_team_id = %s THEN home_score ELSE away_score END) AS rf,
          SUM(CASE WHEN home_team_id = %s THEN away_score ELSE home_score END) AS ra
        FROM games
        WHERE season = %s AND status = 'final'
          AND home_score IS NOT NULL AND away_score IS NOT NULL
          AND (home_team_id = %s OR away_team_id = %s)
    """, (team_id, team_id, season, team_id, team_id))
    r = cur.fetchone() or {}
    g = r.get('g') or 0
    rf = r.get('rf') or 0
    ra = r.get('ra') or 0
    return {
        'games': g,
        'runs_for': rf,
        'runs_against': ra,
        'runs_per_game': (rf / g) if g else 0,
        'ra_per_game':   (ra / g) if g else 0,
    }


def aggregate_team_stats(cur, team_id, season):
    """All team-level stats merged into one dict."""
    out = {}
    o = _aggregate_team_offense(cur, team_id, season) or {}
    p = _aggregate_team_pitching(cur, team_id, season) or {}
    pbp_o = _aggregate_team_pbp_offense(cur, team_id, season) or {}
    pbp_p = _aggregate_team_pbp_pitching(cur, team_id, season) or {}
    rfra = _team_runs_for_against(cur, team_id, season)
    # Pitching runs-allowed-per-game replaces the simple value from rfra
    p['ra_per_game'] = rfra['ra_per_game']
    out.update({f'{k}': v for k, v in o.items()})  # offense raw keys
    out['runs_per_game'] = rfra['runs_per_game']
    # Prefix-shifting: pitching stats kept under their own keys but we collide
    # on 'k_pct' and 'bb_pct' (both offense and pitching). Use namespacing.
    out['offense'] = o
    out['pitching'] = p
    out['pbp_offense'] = pbp_o
    out['pbp_pitching'] = pbp_p
    out['rfra'] = rfra
    return out


# ─────────────────────────────────────────────────────────────────
# Team-level splits (vs LHP / vs RHP / w RISP for hitters,
# vs LHH / vs RHH / w RISP for pitchers).
#
# Each split returns: woba, iso, contact_pct, k_pct, bb_pct (for hitters),
# fip_raw, k_pct, bb_pct, whiff_pct (for pitchers).
# ─────────────────────────────────────────────────────────────────

# RISP filter: runner on 2nd or 3rd. bases_before is a 3-char string '000'
# to '111' where idx 0 = 1B, idx 1 = 2B, idx 2 = 3B (Postgres SUBSTRING is
# 1-indexed so position 2 = 2B and position 3 = 3B).
_RISP_FILTER = (
    "AND (SUBSTRING(bases_before, 2, 1) = '1' "
    "  OR SUBSTRING(bases_before, 3, 1) = '1')"
)


def _aggregate_team_hitter_split(cur, team_id, season, extra_where, extra_params=()):
    """Aggregate one hitter-side split for a team. Returns dict of woba,
    iso, contact_pct, k_pct, bb_pct (or all None if no data)."""
    sql = f"""
        SELECT
          COUNT(*) AS pa,
          COUNT(*) FILTER (WHERE result_type IN
            ('single','double','triple','home_run',
             'strikeout_swinging','strikeout_looking',
             'ground_out','fly_out','line_out','pop_out',
             'fielders_choice','error','double_play','other')) AS ab,
          COUNT(*) FILTER (WHERE result_type = 'single') AS singles,
          COUNT(*) FILTER (WHERE result_type = 'double') AS doubles,
          COUNT(*) FILTER (WHERE result_type = 'triple') AS triples,
          COUNT(*) FILTER (WHERE result_type = 'home_run') AS hr,
          COUNT(*) FILTER (WHERE result_type IN ('walk','intentional_walk')) AS bb,
          COUNT(*) FILTER (WHERE result_type = 'hbp') AS hbp,
          COUNT(*) FILTER (WHERE result_type = 'sac_fly') AS sf,
          COUNT(*) FILTER (WHERE result_type IN ('strikeout_swinging','strikeout_looking')) AS k,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))) AS k_pitches,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))) AS f_pitches,
          COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        LEFT JOIN players pp ON pp.id = ge.pitcher_player_id
        WHERE ge.batting_team_id = %s
          AND g.season = %s
          AND ge.result_type IS NOT NULL
          {extra_where}
    """
    cur.execute(sql, (team_id, season, *extra_params))
    r = cur.fetchone() or {}
    pa = r.get('pa') or 0
    ab = r.get('ab') or 0
    if pa == 0 or ab == 0:
        return {'woba': None, 'iso': None, 'contact_pct': None, 'k_pct': None, 'bb_pct': None, 'pa': pa}
    singles = r.get('singles') or 0
    doubles = r.get('doubles') or 0
    triples = r.get('triples') or 0
    hr = r.get('hr') or 0
    bb = r.get('bb') or 0
    hbp = r.get('hbp') or 0
    sf = r.get('sf') or 0
    k = r.get('k') or 0
    h = singles + doubles + triples + hr
    tb = singles + 2 * doubles + 3 * triples + 4 * hr
    avg = h / ab if ab else 0
    slg = tb / ab if ab else 0
    iso = slg - avg
    # Approximate wOBA with D3/NAIA-ish weights
    woba_num = 0.69 * bb + 0.72 * hbp + 0.88 * singles + 1.24 * doubles + 1.56 * triples + 2.0 * hr
    woba_denom = ab + bb + sf + hbp
    woba = woba_num / woba_denom if woba_denom else 0

    k_p = float(r.get('k_pitches') or 0)
    f_p = float(r.get('f_pitches') or 0)
    in_play = float(r.get('in_play') or 0)
    swings = k_p + f_p + in_play
    contact = f_p + in_play
    contact_pct = (contact / swings) if swings else None

    return {
        'woba': woba,
        'iso': iso,
        'contact_pct': contact_pct,
        'k_pct': k / pa if pa else 0,
        'bb_pct': bb / pa if pa else 0,
        'pa': pa,
    }


def _aggregate_team_pitcher_split(cur, team_id, season, extra_where, extra_params=()):
    """Aggregate one pitcher-side split for a team. Returns fip_raw, k_pct,
    bb_pct, whiff_pct."""
    sql = f"""
        SELECT
          COUNT(*) AS bf,
          COUNT(*) FILTER (WHERE result_type = 'home_run') AS hr,
          COUNT(*) FILTER (WHERE result_type IN ('walk','intentional_walk')) AS bb,
          COUNT(*) FILTER (WHERE result_type = 'hbp') AS hbp,
          COUNT(*) FILTER (WHERE result_type IN ('strikeout_swinging','strikeout_looking')) AS k,
          -- Outs estimator (close enough for FIP; see comments above)
          SUM(CASE
            WHEN result_type IN ('strikeout_swinging','strikeout_looking') THEN 1
            WHEN result_type IN ('ground_out','fly_out','line_out','pop_out',
                                 'sac_fly','sac_bunt','fielders_choice') THEN 1
            WHEN result_type = 'double_play' THEN 2
            WHEN result_type = 'triple_play' THEN 3
            ELSE 0
          END) AS outs,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))) AS k_pitches,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))) AS f_pitches,
          COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        LEFT JOIN players pb ON pb.id = ge.batter_player_id
        WHERE ge.defending_team_id = %s
          AND g.season = %s
          AND ge.result_type IS NOT NULL
          {extra_where}
    """
    cur.execute(sql, (team_id, season, *extra_params))
    r = cur.fetchone() or {}
    bf = r.get('bf') or 0
    if bf == 0:
        return {'fip': None, 'k_pct': None, 'bb_pct': None, 'whiff_pct': None, 'bf': bf}
    hr = r.get('hr') or 0
    bb = r.get('bb') or 0
    hbp = r.get('hbp') or 0
    k = r.get('k') or 0
    outs = r.get('outs') or 0
    ip = outs / 3.0 if outs else 0
    # FIP-raw: (13*HR + 3*(BB+HBP) - 2*K)/IP. We don't add the FIP constant
    # since the percentile baseline is the same conference; relative ranks
    # are unchanged.
    fip_raw = (13 * hr + 3 * (bb + hbp) - 2 * k) / ip if ip else 0
    # Add a typical FIP constant for D3/NAIA so the displayed number
    # looks ERA-like (~3.0 to 6.0). Constant ~3.20 covers most leagues.
    fip = fip_raw + 3.20

    k_p = float(r.get('k_pitches') or 0)
    f_p = float(r.get('f_pitches') or 0)
    in_play = float(r.get('in_play') or 0)
    swings = k_p + f_p + in_play
    whiff_pct = (k_p / swings) if swings else None

    return {
        'fip': fip,
        'k_pct': k / bf if bf else 0,
        'bb_pct': bb / bf if bf else 0,
        'whiff_pct': whiff_pct,
        'bf': bf,
    }


def compute_team_hitter_splits(cur, team_id, season):
    """Returns list of {label, stats} for vs LHP, vs RHP, w/ RISP."""
    return [
        {'label': 'vs LHP',  'stats': _aggregate_team_hitter_split(cur, team_id, season, "AND pp.throws = 'L'")},
        {'label': 'vs RHP',  'stats': _aggregate_team_hitter_split(cur, team_id, season, "AND pp.throws = 'R'")},
        {'label': 'w/ RISP', 'stats': _aggregate_team_hitter_split(cur, team_id, season, _RISP_FILTER)},
    ]


def compute_team_pitcher_splits(cur, team_id, season):
    """Returns list of {label, stats} for vs LHH, vs RHH, w/ RISP."""
    return [
        {'label': 'vs LHH',  'stats': _aggregate_team_pitcher_split(cur, team_id, season, "AND pb.bats = 'L'")},
        {'label': 'vs RHH',  'stats': _aggregate_team_pitcher_split(cur, team_id, season, "AND pb.bats = 'R'")},
        {'label': 'w/ RISP', 'stats': _aggregate_team_pitcher_split(cur, team_id, season, _RISP_FILTER)},
    ]


# ─────────────────────────────────────────────────────────────────
# Per-player splits (used by the table filter UI)
# ─────────────────────────────────────────────────────────────────

def _bulk_hitter_split(cur, player_ids, season, extra_where):
    """Aggregate per-hitter split. Returns {pid: {woba, iso, contact_pct, k_pct, bb_pct, pa}}."""
    if not player_ids:
        return {}
    sql = f"""
        SELECT
          ge.batter_player_id AS pid,
          COUNT(*) AS pa,
          COUNT(*) FILTER (WHERE result_type IN
            ('single','double','triple','home_run',
             'strikeout_swinging','strikeout_looking',
             'ground_out','fly_out','line_out','pop_out',
             'fielders_choice','error','double_play','other')) AS ab,
          COUNT(*) FILTER (WHERE result_type = 'single') AS singles,
          COUNT(*) FILTER (WHERE result_type = 'double') AS doubles,
          COUNT(*) FILTER (WHERE result_type = 'triple') AS triples,
          COUNT(*) FILTER (WHERE result_type = 'home_run') AS hr,
          COUNT(*) FILTER (WHERE result_type IN ('walk','intentional_walk')) AS bb,
          COUNT(*) FILTER (WHERE result_type = 'hbp') AS hbp,
          COUNT(*) FILTER (WHERE result_type = 'sac_fly') AS sf,
          COUNT(*) FILTER (WHERE result_type IN ('strikeout_swinging','strikeout_looking')) AS k,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))) AS k_pitches,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))) AS f_pitches,
          COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        LEFT JOIN players pp ON pp.id = ge.pitcher_player_id
        WHERE ge.batter_player_id = ANY(%s)
          AND g.season = %s
          AND ge.result_type IS NOT NULL
          {extra_where}
        GROUP BY ge.batter_player_id
    """
    cur.execute(sql, (player_ids, season))
    out = {}
    for r in cur.fetchall():
        pid = r['pid']
        pa = r.get('pa') or 0
        ab = r.get('ab') or 0
        if pa == 0:
            continue
        singles = r.get('singles') or 0
        doubles = r.get('doubles') or 0
        triples = r.get('triples') or 0
        hr = r.get('hr') or 0
        bb = r.get('bb') or 0
        hbp = r.get('hbp') or 0
        sf = r.get('sf') or 0
        k = r.get('k') or 0
        h = singles + doubles + triples + hr
        tb = singles + 2 * doubles + 3 * triples + 4 * hr
        avg = h / ab if ab else 0
        slg = tb / ab if ab else 0
        iso = slg - avg
        woba_num = 0.69 * bb + 0.72 * hbp + 0.88 * singles + 1.24 * doubles + 1.56 * triples + 2.0 * hr
        woba_denom = ab + bb + sf + hbp
        woba = woba_num / woba_denom if woba_denom else 0

        k_p = float(r.get('k_pitches') or 0)
        f_p = float(r.get('f_pitches') or 0)
        in_play = float(r.get('in_play') or 0)
        swings = k_p + f_p + in_play
        contact = f_p + in_play
        contact_pct = (contact / swings) if swings else None

        out[pid] = {
            'pa': pa,
            'woba': woba,
            'iso': iso,
            'contact_pct': contact_pct,
            'k_pct': k / pa if pa else 0,
            'bb_pct': bb / pa if pa else 0,
            'batting_avg': avg,
            'slugging_pct': slg,
        }
    return out


def _bulk_pitcher_split(cur, player_ids, season, extra_where):
    """Aggregate per-pitcher split. Returns {pid: {fip, k_pct, bb_pct, whiff_pct, bf}}."""
    if not player_ids:
        return {}
    sql = f"""
        SELECT
          ge.pitcher_player_id AS pid,
          COUNT(*) AS bf,
          COUNT(*) FILTER (WHERE result_type = 'home_run') AS hr,
          COUNT(*) FILTER (WHERE result_type IN ('walk','intentional_walk')) AS bb,
          COUNT(*) FILTER (WHERE result_type = 'hbp') AS hbp,
          COUNT(*) FILTER (WHERE result_type IN ('strikeout_swinging','strikeout_looking')) AS k,
          SUM(CASE
            WHEN result_type IN ('strikeout_swinging','strikeout_looking') THEN 1
            WHEN result_type IN ('ground_out','fly_out','line_out','pop_out',
                                 'sac_fly','sac_bunt','fielders_choice') THEN 1
            WHEN result_type = 'double_play' THEN 2
            WHEN result_type = 'triple_play' THEN 3
            ELSE 0
          END) AS outs,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))) AS k_pitches,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))) AS f_pitches,
          COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        LEFT JOIN players pb ON pb.id = ge.batter_player_id
        WHERE ge.pitcher_player_id = ANY(%s)
          AND g.season = %s
          AND ge.result_type IS NOT NULL
          {extra_where}
        GROUP BY ge.pitcher_player_id
    """
    cur.execute(sql, (player_ids, season))
    out = {}
    for r in cur.fetchall():
        pid = r['pid']
        bf = r.get('bf') or 0
        if bf == 0:
            continue
        hr = r.get('hr') or 0
        bb = r.get('bb') or 0
        hbp = r.get('hbp') or 0
        k = r.get('k') or 0
        outs = r.get('outs') or 0
        ip = outs / 3.0 if outs else 0
        fip_raw = (13 * hr + 3 * (bb + hbp) - 2 * k) / ip if ip else 0
        fip = fip_raw + 3.20

        k_p = float(r.get('k_pitches') or 0)
        f_p = float(r.get('f_pitches') or 0)
        in_play = float(r.get('in_play') or 0)
        swings = k_p + f_p + in_play
        whiff_pct = (k_p / swings) if swings else None

        out[pid] = {
            'bf': bf,
            'fip': fip,
            'k_pct': k / bf if bf else 0,
            'bb_pct': bb / bf if bf else 0,
            'whiff_pct': whiff_pct,
            'innings_pitched': ip,
        }
    return out


def compute_player_hitter_splits(cur, player_ids, season):
    """Returns {pid: {vs_rhp: {...}, vs_lhp: {...}, risp: {...}}}."""
    vs_rhp = _bulk_hitter_split(cur, player_ids, season, "AND pp.throws = 'R'")
    vs_lhp = _bulk_hitter_split(cur, player_ids, season, "AND pp.throws = 'L'")
    risp   = _bulk_hitter_split(cur, player_ids, season, _RISP_FILTER)
    out = {}
    for pid in player_ids:
        out[pid] = {
            'vs_rhp': vs_rhp.get(pid, {}),
            'vs_lhp': vs_lhp.get(pid, {}),
            'risp':   risp.get(pid, {}),
        }
    return out


def compute_player_pitcher_splits(cur, player_ids, season):
    """Returns {pid: {vs_rhh: {...}, vs_lhh: {...}, risp: {...}}}."""
    vs_rhh = _bulk_pitcher_split(cur, player_ids, season, "AND pb.bats = 'R'")
    vs_lhh = _bulk_pitcher_split(cur, player_ids, season, "AND pb.bats = 'L'")
    risp   = _bulk_pitcher_split(cur, player_ids, season, _RISP_FILTER)
    out = {}
    for pid in player_ids:
        out[pid] = {
            'vs_rhh': vs_rhh.get(pid, {}),
            'vs_lhh': vs_lhh.get(pid, {}),
            'risp':   risp.get(pid, {}),
        }
    return out


# ─────────────────────────────────────────────────────────────────
# Recent form (last 10 games)
# ─────────────────────────────────────────────────────────────────

def fetch_last_10_games(cur, team_id, season):
    """Return last 10 final games as a list with W/L tagging."""
    cur.execute("""
        SELECT g.id, g.game_date, g.home_team_id, g.away_team_id,
               g.home_score, g.away_score,
               t_home.short_name AS home_short, t_away.short_name AS away_short
        FROM games g
        LEFT JOIN teams t_home ON t_home.id = g.home_team_id
        LEFT JOIN teams t_away ON t_away.id = g.away_team_id
        WHERE g.season = %s AND g.status = 'final'
          AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
          AND (g.home_team_id = %s OR g.away_team_id = %s)
          AND COALESCE(g.is_postseason, FALSE) = FALSE
        ORDER BY g.game_date DESC, g.id DESC
        LIMIT 10
    """, (season, team_id, team_id))
    rows = list(cur.fetchall())
    games = []
    wins = 0
    losses = 0
    for r in rows:
        d = dict(r)
        is_home = d['home_team_id'] == team_id
        my_score = d['home_score'] if is_home else d['away_score']
        opp_score = d['away_score'] if is_home else d['home_score']
        opp_short = d['away_short'] if is_home else d['home_short']
        if my_score > opp_score:
            result = 'W'; wins += 1
        elif my_score < opp_score:
            result = 'L'; losses += 1
        else:
            result = 'T'
        games.append({
            'date': d['game_date'].isoformat() if d['game_date'] else None,
            'home_away': 'vs' if is_home else '@',
            'opponent': opp_short,
            'score': f"{my_score}-{opp_score}",
            'result': result,
        })
    return {
        'record': f"{wins}-{losses}",
        'wins': wins, 'losses': losses,
        'games': list(reversed(games)),  # oldest-first for chart-ready order
    }


# ─────────────────────────────────────────────────────────────────
# Conference baseline — pull all teams in the same conference and
# aggregate each one's team-level stats so we can rank our team.
# ─────────────────────────────────────────────────────────────────

def fetch_conference_team_ids(cur, conference_id):
    cur.execute("""
        SELECT id FROM teams
        WHERE conference_id = %s AND is_active = 1
    """, (conference_id,))
    return [r['id'] for r in cur.fetchall()]


def build_conference_baseline(cur, conference_team_ids, season):
    """Aggregate team-level stats for every team in the conference.
    Returns: {team_id: aggregate_dict}.
    """
    out = {}
    for tid in conference_team_ids:
        out[tid] = aggregate_team_stats(cur, tid, season)
    return out


def _stat_value(team_agg, group, key):
    """Pull a stat from the team_agg dict at the right group nesting."""
    g = team_agg.get(group) or {}
    return g.get(key)


def _build_panel(catalog, default_group, our_team_id, baseline):
    """For each stat in `catalog`, compute our value, conf rank, percentile, color.

    Each stat may override the default group via `spec.get('group')`. Stats not
    found in the group (or top-level) get NULL value/rank.
    """
    rows = []
    for spec in catalog:
        key = spec['key']
        group = spec.get('group') or default_group
        all_values = [
            _stat_value(baseline.get(tid, {}), group, key)
            for tid in baseline.keys()
        ]
        # Fallback: try top-level keys (for stats stored flat like runs_per_game)
        if all(v is None for v in all_values):
            all_values = [
                baseline.get(tid, {}).get(key)
                for tid in baseline.keys()
            ]
            our_val = baseline.get(our_team_id, {}).get(key)
        else:
            our_val = _stat_value(baseline.get(our_team_id, {}), group, key)
        pct = percentile_rank(our_val, all_values, spec['direction'])
        rank, total = rank_within(our_val, all_values, spec['direction'])
        rows.append({
            'key': key,
            'label': spec['label'],
            'value': our_val,
            'format': spec['format'],
            'direction': spec['direction'],
            'rank': rank,
            'total': total,
            'percentile': pct,
            'color': percentile_to_color(pct, spec['direction']),
        })
    return rows


def build_team_panels(our_team_id, baseline):
    """Build the four team-stats panels."""
    return {
        'offense':         _build_panel(TEAM_OFFENSE_STATS,         'offense',      our_team_id, baseline),
        'pitching':        _build_panel(TEAM_PITCHING_STATS,        'pitching',     our_team_id, baseline),
        'plate_discipline': _build_panel(
            TEAM_PBP_DISCIPLINE_STATS,
            'pbp_offense',  # most stats; opp_X stats live in pbp_pitching
            our_team_id, baseline,
        ),
        'batted_ball':     _build_panel(TEAM_PBP_BATTED_BALL_STATS, 'pbp_offense',  our_team_id, baseline),
    }


# ─────────────────────────────────────────────────────────────────
# Per-player PBP stats — for the comprehensive player tables.
# ─────────────────────────────────────────────────────────────────

def _fetch_pitcher_pbp_bulk(cur, player_ids, season):
    """Pitch-level + batted-ball stats for every pitcher in `player_ids`.
    Returns {player_id: {strike_pct, whiff_pct, contact_pct, swing_pct,
    fps_pct, putaway_pct, opp_gb_pct, opp_ld_pct, opp_fb_pct, opp_pu_pct,
    opp_air_pull_pct, opp_iso, hr_pct, bf}}."""
    if not player_ids:
        return {}
    cur.execute("""
        SELECT
          ge.pitcher_player_id AS pid,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))) AS k_pitches,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))) AS s_pitches,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))) AS f_pitches,
          SUM(pitches_thrown) AS pitches_total,
          COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play,
          -- See _aggregate_team_pbp_pitching for the parser-convention
          -- explanation. Strike rate counts K + S + F in seq plus
          -- in-play (terminal pitch). Don't add a separate
          -- terminal_strikes count — strikeouts already include the
          -- K in pitch_sequence.
          COUNT(*) FILTER (
            WHERE (LENGTH(pitch_sequence) > 0 AND LEFT(pitch_sequence, 1) IN ('K','S','F'))
               OR (LENGTH(pitch_sequence) = 0 AND was_in_play AND pitches_thrown = 1)
          ) AS first_pitch_strikes,
          COUNT(*) FILTER (WHERE pitches_thrown IS NOT NULL AND pitches_thrown >= 1) AS fps_pa_known,
          COUNT(*) FILTER (WHERE strikes_before >= 2
                           AND ge.result_type IN ('strikeout_swinging','strikeout_looking')) AS putaway_k,
          COUNT(*) FILTER (WHERE strikes_before >= 2) AS two_strike_pa,
          COUNT(*) FILTER (WHERE bb_type = 'GB') AS gb,
          COUNT(*) FILTER (WHERE bb_type = 'FB') AS fb,
          COUNT(*) FILTER (WHERE bb_type = 'LD') AS ld,
          COUNT(*) FILTER (WHERE bb_type = 'PU') AS pu,
          COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
          COUNT(*) FILTER (
            WHERE bb_type IN ('LD','FB')
              AND ((UPPER(pb.bats) = 'R' AND field_zone = 'LEFT')
                OR (UPPER(pb.bats) = 'L' AND field_zone = 'RIGHT'))
          ) AS opp_air_pull,
          COUNT(*) FILTER (WHERE ge.result_type = 'home_run') AS hr,
          COUNT(*) AS bf
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        LEFT JOIN players pb ON pb.id = ge.batter_player_id
        WHERE ge.pitcher_player_id = ANY(%s)
          AND g.season = %s
          AND ge.result_type IS NOT NULL
        GROUP BY ge.pitcher_player_id
    """, (player_ids, season))

    out = {}
    for r in cur.fetchall():
        pid = r['pid']
        k_p = float(r['k_pitches'] or 0)
        s_p = float(r['s_pitches'] or 0)
        f_p = float(r['f_pitches'] or 0)
        in_play = float(r['in_play'] or 0)
        bb_total = float(r['bb_total'] or 0)
        bf = float(r['bf'] or 0)
        pitches_total = float(r['pitches_total'] or 0)
        swings = k_p + f_p + in_play
        contact = f_p + in_play
        # All strikes from sequence + the in-play pitch (terminal of any
        # batted ball is a strike). K + S + F + in_play.
        strikes = k_p + s_p + f_p + in_play

        def _safe(num, denom):
            return float(num) / float(denom) if denom else None

        out[pid] = {
            'strike_pct':   _safe(strikes, pitches_total),
            'swing_pct':    _safe(swings, pitches_total),
            'whiff_pct':    _safe(k_p, swings),
            'contact_pct':  _safe(contact, swings),
            'fps_pct':      _safe(r['first_pitch_strikes'] or 0, r['fps_pa_known'] or 0),
            'putaway_pct':  _safe(r['putaway_k'] or 0, r['two_strike_pa'] or 0),
            'opp_gb_pct':   _safe(r['gb'] or 0, bb_total),
            'opp_fb_pct':   _safe(r['fb'] or 0, bb_total),
            'opp_ld_pct':   _safe(r['ld'] or 0, bb_total),
            'opp_pu_pct':   _safe(r['pu'] or 0, bb_total),
            'opp_air_pull_pct': _safe(r['opp_air_pull'] or 0, bb_total),
            'hr_per_pa':    _safe(r['hr'] or 0, bf),
            'bf': bf,
        }
    return out


# ─────────────────────────────────────────────────────────────────
# Player roster + per-player percentiles + strengths/weaknesses
# ─────────────────────────────────────────────────────────────────

def fetch_hitters(cur, conference_team_ids, season, min_pa=30):
    """Return all hitters in the conference with min_pa PAs.
    Used for both the team's roster AND the percentile baseline."""
    cur.execute("""
        SELECT bs.*, p.first_name, p.last_name, p.position, p.year_in_school,
               p.bats, p.team_id, t.short_name AS team_short, t.logo_url AS team_logo
        FROM batting_stats bs
        JOIN players p ON p.id = bs.player_id
        JOIN teams t ON t.id = p.team_id
        WHERE bs.season = %s
          AND p.team_id = ANY(%s)
          AND bs.plate_appearances >= %s
        ORDER BY bs.woba DESC NULLS LAST
    """, (season, conference_team_ids, min_pa))
    return [dict(r) for r in cur.fetchall()]


def fetch_pitchers(cur, conference_team_ids, season, min_ip=5):
    """Return all pitchers in the conference with min_ip innings."""
    cur.execute("""
        SELECT ps.*, p.first_name, p.last_name, p.position, p.year_in_school,
               p.throws, p.team_id, t.short_name AS team_short, t.logo_url AS team_logo
        FROM pitching_stats ps
        JOIN players p ON p.id = ps.player_id
        JOIN teams t ON t.id = p.team_id
        WHERE ps.season = %s
          AND p.team_id = ANY(%s)
          AND ps.innings_pitched >= %s
        ORDER BY ps.fip ASC NULLS LAST
    """, (season, conference_team_ids, min_ip))
    return [dict(r) for r in cur.fetchall()]


def player_percentile(player, pool, key, direction):
    """Percentile rank of `player[key]` within `pool` (list of dicts)."""
    val = player.get(key)
    if val is None:
        return None
    pool_vals = [p.get(key) for p in pool if p.get(key) is not None]
    return percentile_rank(val, pool_vals, direction)


def flag_player(player, pool, flag_stats):
    """Return (strengths, weaknesses) — top 2 / bottom 2 percentile flags."""
    flags = []
    for spec in flag_stats:
        pct = player_percentile(player, pool, spec['key'], spec['direction'])
        if pct is None:
            continue
        flags.append({'key': spec['key'], 'label': spec['label'],
                      'value': player.get(spec['key']), 'percentile': pct})
    flags.sort(key=lambda x: x['percentile'], reverse=True)
    strengths = [f for f in flags[:2] if f['percentile'] >= 70]
    weaknesses = [f for f in reversed(flags[-2:]) if f['percentile'] <= 30]
    return strengths, weaknesses


def decorate_hitters_for_team(team_id, hitters_pool):
    """Pick our team's hitters out of the pool and tag each with strengths/weaknesses."""
    pool = hitters_pool  # full conference pool for percentile baseline
    out = []
    for h in pool:
        if h['team_id'] != team_id:
            continue
        strengths, weaknesses = flag_player(h, pool, HITTER_FLAG_STATS)
        # Build a percentile snapshot for every flag stat (for color-coding the row)
        percentiles = {}
        for spec in HITTER_FLAG_STATS:
            percentiles[spec['key']] = player_percentile(h, pool, spec['key'], spec['direction'])
        out.append({
            **h,
            'strengths': strengths,
            'weaknesses': weaknesses,
            'percentiles': percentiles,
        })
    out.sort(key=lambda r: r.get('plate_appearances') or 0, reverse=True)
    return out


def decorate_pitchers_for_team(team_id, pitchers_pool, role):
    """role: 'starter' or 'reliever' — filters by games_started."""
    pool = pitchers_pool
    out = []
    for p in pool:
        if p['team_id'] != team_id:
            continue
        # We don't have a games_started column, so use the heuristic:
        # starters: IP >= 15 AND avg IP/game >= 4
        # relievers: GS == 0 (not stored) — fall back to IP < 15
        ip = float(p.get('innings_pitched') or 0)
        g = float(p.get('games') or 0) or 1
        avg_ip_per_game = ip / g
        is_starter_like = avg_ip_per_game >= 3.5 and ip >= 15
        if role == 'starter' and not is_starter_like:
            continue
        if role == 'reliever' and is_starter_like:
            continue
        if role == 'reliever' and ip < 5:
            continue
        if role == 'starter' and ip < 15:
            continue
        strengths, weaknesses = flag_player(p, pool, PITCHER_FLAG_STATS)
        percentiles = {}
        for spec in PITCHER_FLAG_STATS:
            percentiles[spec['key']] = player_percentile(p, pool, spec['key'], spec['direction'])
        out.append({
            **p,
            'strengths': strengths,
            'weaknesses': weaknesses,
            'percentiles': percentiles,
        })
    out.sort(key=lambda r: r.get('innings_pitched') or 0, reverse=True)
    return out


# ─────────────────────────────────────────────────────────────────
# Auto-generated team writeup
# ─────────────────────────────────────────────────────────────────

def generate_writeup(team_name, panels, recent):
    """Build a 3-paragraph scouting narrative from the percentile-ranked panels."""
    # Collect strengths / weaknesses across all panels
    strengths = []
    weaknesses = []
    for panel_key in ('offense', 'pitching', 'plate_discipline', 'batted_ball'):
        for row in panels.get(panel_key, []):
            if row['percentile'] is None:
                continue
            entry = {**row, 'panel': panel_key}
            if row['percentile'] >= 80:
                strengths.append(entry)
            elif row['percentile'] <= 20:
                weaknesses.append(entry)

    strengths.sort(key=lambda r: r['percentile'], reverse=True)
    weaknesses.sort(key=lambda r: r['percentile'])

    def _fmt_value(row):
        v = row['value']
        if v is None:
            return '?'
        f = row['format']
        if f == 'rate':
            return f"{v:.3f}".lstrip('0') if v < 1 else f"{v:.3f}"
        if f == 'pct':
            return f"{v*100:.1f}%"
        if f == 'era':
            return f"{v:.2f}"
        if f == 'int':
            return f"{int(round(v))}"
        return str(v)

    def _fmt_pct(p):
        return f"{round(p)}th percentile"

    # Paragraph 1: offense
    offense_lines = []
    off_strengths = [s for s in strengths if s['panel'] == 'offense'][:2]
    off_weaknesses = [w for w in weaknesses if w['panel'] == 'offense'][:2]
    if off_strengths:
        for s in off_strengths:
            offense_lines.append(f"{s['label']} {_fmt_value(s)} ({_fmt_pct(s['percentile'])} in CCC)")
    if off_weaknesses:
        for w in off_weaknesses:
            offense_lines.append(f"struggle in {w['label']} ({_fmt_value(w)}, {_fmt_pct(w['percentile'])})")

    if off_strengths or off_weaknesses:
        bits = []
        if off_strengths:
            bits.append("strong " + " and ".join(s['label'] + ' ' + _fmt_value(s) for s in off_strengths))
        if off_weaknesses:
            bits.append("but weak in " + " and ".join(w['label'] + ' ' + _fmt_value(w) for w in off_weaknesses))
        para1 = f"Offensively, {team_name} has " + ', '.join(bits) + "."
    else:
        para1 = f"Offensively, {team_name} sits roughly in the middle of the conference across the board."

    # Paragraph 2: pitching
    pit_strengths = [s for s in strengths if s['panel'] == 'pitching'][:2]
    pit_weaknesses = [w for w in weaknesses if w['panel'] == 'pitching'][:2]
    if pit_strengths or pit_weaknesses:
        bits = []
        if pit_strengths:
            bits.append("staff excels at " + " and ".join(s['label'] + ' ' + _fmt_value(s) for s in pit_strengths))
        if pit_weaknesses:
            bits.append("vulnerable in " + " and ".join(w['label'] + ' ' + _fmt_value(w) for w in pit_weaknesses))
        para2 = f"On the mound, the {bits[0]}" + (("; " + bits[1]) if len(bits) > 1 else "") + "."
    else:
        para2 = "The pitching staff grades out as conference-average."

    # Paragraph 3: discipline / batted ball + recent form
    disc_strengths = [s for s in strengths if s['panel'] in ('plate_discipline', 'batted_ball')][:2]
    bits3 = []
    if disc_strengths:
        bits3.append(
            "they show "
            + " and ".join(s['label'] + ' ' + _fmt_value(s) + ' (' + _fmt_pct(s['percentile']) + ')'
                           for s in disc_strengths)
        )
    rec = recent.get('record') if recent else None
    if rec:
        bits3.append(f"have gone {rec} over their last 10 games")
    if bits3:
        para3 = "At the pitch level, " + ', and '.join(bits3) + "."
    else:
        para3 = ""

    paragraphs = [para1, para2]
    if para3:
        paragraphs.append(para3)
    return "\n\n".join(paragraphs)


# ─────────────────────────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────────────────────────

def compute_team_scouting(cur, team_id, season):
    """Build the full scouting report for a team."""
    # Team metadata
    cur.execute("""
        SELECT t.id, t.name, t.short_name, t.logo_url, t.city, t.state,
               c.id AS conference_id, c.name AS conference_name,
               c.abbreviation AS conference_abbrev,
               d.id AS division_id, d.name AS division_name, d.level AS division_level
        FROM teams t
        JOIN conferences c ON c.id = t.conference_id
        JOIN divisions d ON d.id = c.division_id
        WHERE t.id = %s
    """, (team_id,))
    team_row = cur.fetchone()
    if not team_row:
        return {'error': f'Team {team_id} not found'}
    team = dict(team_row)

    # Team season record
    cur.execute("""
        SELECT wins, losses, ties, conference_wins, conference_losses
        FROM team_season_stats
        WHERE team_id = %s AND season = %s
    """, (team_id, season))
    ts = cur.fetchone()
    if ts:
        team.update(dict(ts))

    # Conference baseline
    conf_team_ids = fetch_conference_team_ids(cur, team['conference_id'])
    baseline = build_conference_baseline(cur, conf_team_ids, season)

    # Recent form
    recent = fetch_last_10_games(cur, team_id, season)

    # Team panels
    panels = build_team_panels(team_id, baseline)

    # Writeup
    writeup = generate_writeup(team['short_name'] or team['name'], panels, recent)

    # Player tables (full conference pool for percentiles)
    hitters_pool = fetch_hitters(cur, conf_team_ids, season, min_pa=30)
    pitchers_pool = fetch_pitchers(cur, conf_team_ids, season, min_ip=5)

    # Bulk PBP fetch for everyone in the conference pool — needed both for
    # this team's player rows AND for percentile baselines.
    hitter_pbp = _fetch_hitter_pbp_bulk(cur, [h['player_id'] for h in hitters_pool], season)
    pitcher_pbp = _fetch_pitcher_pbp_bulk(cur, [p['player_id'] for p in pitchers_pool], season)
    for h in hitters_pool:
        h.update(hitter_pbp.get(h['player_id'], {}))
    for p in pitchers_pool:
        p.update(pitcher_pbp.get(p['player_id'], {}))

    hitters = decorate_hitters_for_team(team_id, hitters_pool)
    starters = decorate_pitchers_for_team(team_id, pitchers_pool, role='starter')
    relievers = decorate_pitchers_for_team(team_id, pitchers_pool, role='reliever')

    # Per-player splits (for the player-table filter UI)
    our_hitter_ids   = [h['player_id'] for h in hitters]
    our_pitcher_ids  = [p['player_id'] for p in (starters + relievers)]
    hitter_splits    = compute_player_hitter_splits(cur, our_hitter_ids, season)
    pitcher_splits   = compute_player_pitcher_splits(cur, our_pitcher_ids, season)
    for h in hitters:
        h['splits'] = hitter_splits.get(h['player_id'], {})
    for p in starters:
        p['splits'] = pitcher_splits.get(p['player_id'], {})
    for p in relievers:
        p['splits'] = pitcher_splits.get(p['player_id'], {})

    # Team-level splits (rendered as a separate panel per role)
    team_hitter_splits  = compute_team_hitter_splits(cur, team_id, season)
    team_pitcher_splits = compute_team_pitcher_splits(cur, team_id, season)

    return {
        'team': team,
        'season': season,
        'recent': recent,
        'panels': panels,
        'writeup': writeup,
        'hitters': hitters,
        'starters': starters,
        'relievers': relievers,
        'team_hitter_splits':  team_hitter_splits,
        'team_pitcher_splits': team_pitcher_splits,
        'conference_team_count': len(conf_team_ids),
    }

