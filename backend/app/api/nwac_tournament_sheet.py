"""
NWAC Championship Tournament Sheet backend.

A cross-team scouting board for the 8 teams in the NWAC Championships
(Longview, WA). Unlike the per-team scouting sheet, this pools EVERY
hitter and EVERY pitcher across all 8 teams into two ranked boards:

  PITCHERS (ranked by WAR):
    Team, #, Name, Yr, Ht, Wt, Commitment,
    WAR, IP, GS, ERA, FIP, SIERA, BAA, K%, BB%, Whiff%, Strike%, Putaway%

  HITTERS (ranked by WAR):
    Team, #, Name, Yr, Ht, Wt, Commitment,
    WAR, wRC+, AVG, OBP, SLG, SB, HR, K%, BB%, ISO, Swing%, Contact%

Every stat cell is percentile-shaded GREEN→WHITE→RED against the
field — i.e. ranked only within the 8 championship teams, so a coach
sees who is elite *in this bracket*. Sub-qualifier players are shown
(full rosters) but rendered with neutral gray cells and excluded from
the percentile cohort so tiny samples don't skew the ramp.

Reuses the PBP helpers from scouting_sheet / lineup_helper for the
plate-discipline rates (Whiff/Strike/Putaway, Swing/Contact); the
rest comes straight off batting_stats / pitching_stats.
"""

from __future__ import annotations

from .lineup_helper import _fetch_pbp_stats_bulk as _fetch_hitter_pbp_bulk
from .scouting_sheet import (
    _fetch_pitcher_pbp_bulk,
    _percentile_rank,
)


# ─────────────────────────────────────────────────────────────────
# The 8 championship teams. Kept in sync with
# projections.NWAC_2026_CHAMP_SEEDS — imported so there's one source
# of truth and 2027 only updates the projections constant.
# ─────────────────────────────────────────────────────────────────

def _champ_team_ids():
    try:
        from app.stats.projections import NWAC_2026_CHAMP_SEEDS
        return list(NWAC_2026_CHAMP_SEEDS.values())
    except Exception:
        # Fallback to the hardcoded 2026 field if the import shape changes.
        return [28, 44, 35, 52, 30, 38, 43, 27]


# ─────────────────────────────────────────────────────────────────
# Percentile directions
#   higher_better → big number is good (green)
#   lower_better  → small number is good (green)
#   neutral       → no color (gray) — role/context stat, not good/bad
# ─────────────────────────────────────────────────────────────────
HITTER_PCT_DIRS = {
    'offensive_war': 'higher_better',
    'wrc_plus':      'higher_better',
    'batting_avg':   'higher_better',
    'on_base_pct':   'higher_better',
    'slugging_pct':  'higher_better',
    'sb':            'higher_better',
    'hr':            'higher_better',
    'k_pct':         'lower_better',
    'bb_pct':        'higher_better',
    'iso':           'higher_better',
    'swing_pct':     'higher_better',  # Nate: aggressive ABs are a positive
    'contact_pct':   'higher_better',
}

PITCHER_PCT_DIRS = {
    'pitching_war': 'higher_better',
    'ip':           'higher_better',
    'gs':           'neutral',         # role indicator, not good/bad
    'era':          'lower_better',
    'fip':          'lower_better',
    'siera':        'lower_better',
    'baa':          'lower_better',
    'k_pct':        'higher_better',
    'bb_pct':       'lower_better',
    'whiff_pct':    'higher_better',
    'strike_pct':   'higher_better',
    'putaway_pct':  'higher_better',
}

# Sample-size qualifiers — below these, a player is shown on the board
# but rendered neutral-gray and excluded from the percentile cohort.
HITTER_MIN_PA = 25
PITCHER_MIN_IP = 5.0


# ─────────────────────────────────────────────────────────────────
# Roster + bio fetch
# ─────────────────────────────────────────────────────────────────

def _fetch_team_meta(cur, team_ids):
    if not team_ids:
        return {}
    cur.execute(
        """
        SELECT t.id, t.name, t.short_name, t.logo_url,
               c.abbreviation AS conference_abbrev
        FROM teams t
        LEFT JOIN conferences c ON c.id = t.conference_id
        WHERE t.id = ANY(%s)
        """,
        (team_ids,),
    )
    return {r['id']: dict(r) for r in cur.fetchall()}


def _commitment_label(is_committed, committed_to):
    if is_committed and committed_to:
        return committed_to
    return None


def _fetch_hitters(cur, team_ids, season):
    if not team_ids:
        return []
    cur.execute(
        """
        SELECT
          p.id              AS player_id,
          p.team_id         AS team_id,
          p.first_name,
          p.last_name,
          p.jersey_number,
          p.position,
          p.bats,
          p.height,
          p.weight,
          p.year_in_school,
          p.is_committed,
          p.committed_to,
          bs.plate_appearances AS pa,
          bs.stolen_bases      AS sb,
          bs.home_runs         AS hr,
          bs.walks             AS bb,
          bs.intentional_walks AS ibb,
          bs.strikeouts        AS so,
          bs.batting_avg,
          bs.on_base_pct,
          bs.slugging_pct,
          bs.wrc_plus,
          bs.iso,
          bs.offensive_war
        FROM players p
        JOIN batting_stats bs ON bs.player_id = p.id AND bs.season = %s
        WHERE p.team_id = ANY(%s)
          AND COALESCE(bs.plate_appearances, 0) > 0
        """,
        (season, team_ids),
    )
    return [dict(r) for r in cur.fetchall()]


def _fetch_pitchers(cur, team_ids, season):
    if not team_ids:
        return []
    cur.execute(
        """
        SELECT
          p.id              AS player_id,
          p.team_id         AS team_id,
          p.first_name,
          p.last_name,
          p.jersey_number,
          p.position,
          p.throws,
          p.height,
          p.weight,
          p.year_in_school,
          p.is_committed,
          p.committed_to,
          ps.innings_pitched   AS ip,
          ps.games_started     AS gs,
          ps.batters_faced     AS bf,
          ps.strikeouts        AS so,
          ps.walks             AS bb,
          ps.hits_allowed      AS h_allowed,
          ps.hit_batters       AS hbp_allowed,
          ps.era,
          ps.fip,
          ps.siera,
          ps.pitching_war
        FROM players p
        JOIN pitching_stats ps ON ps.player_id = p.id AND ps.season = %s
        WHERE p.team_id = ANY(%s)
          AND COALESCE(ps.innings_pitched, 0) > 0
        """,
        (season, team_ids),
    )
    return [dict(r) for r in cur.fetchall()]


# ─────────────────────────────────────────────────────────────────
# Row builders
# ─────────────────────────────────────────────────────────────────

def _f(v):
    """Coerce Decimal/None to float|None."""
    return float(v) if v is not None else None


def _build_hitter_rows(raw, pbp, team_meta):
    out = []
    for h in raw:
        pid = h['player_id']
        pa = h['pa'] or 0
        bb_total = (h['bb'] or 0) + (h['ibb'] or 0)
        k_pct = (h['so'] / pa) if pa else None
        bb_pct = (bb_total / pa) if pa else None
        pbp_row = pbp.get(pid, {})
        tm = team_meta.get(h['team_id'], {})
        out.append({
            'player_id': pid,
            'team_id': h['team_id'],
            'team_short': tm.get('short_name'),
            'team_logo': tm.get('logo_url'),
            'first_name': h['first_name'],
            'last_name': h['last_name'],
            'jersey_number': h['jersey_number'],
            'position': h['position'],
            'bats': h['bats'],
            'height': h['height'],
            'weight': h['weight'],
            'year_in_school': h['year_in_school'],
            'commitment': _commitment_label(h['is_committed'], h['committed_to']),

            'pa': pa,
            'offensive_war': _f(h['offensive_war']),
            'wrc_plus':      _f(h['wrc_plus']),
            'batting_avg':   _f(h['batting_avg']),
            'on_base_pct':   _f(h['on_base_pct']),
            'slugging_pct':  _f(h['slugging_pct']),
            'sb':            h['sb'] or 0,
            'hr':            h['hr'] or 0,
            'k_pct':         k_pct,
            'bb_pct':        bb_pct,
            'iso':           _f(h['iso']),
            'swing_pct':     pbp_row.get('swing_pct'),
            'contact_pct':   pbp_row.get('contact_pct'),
        })
    return out


def _build_pitcher_rows(raw, pbp, team_meta):
    out = []
    for p in raw:
        pid = p['player_id']
        bf = p['bf'] or 0
        so = p['so'] or 0
        bb = p['bb'] or 0
        hbp = p['hbp_allowed'] or 0
        h_allowed = p['h_allowed'] or 0
        k_pct = (so / bf) if bf else None
        bb_pct = (bb / bf) if bf else None
        # BAA ≈ H / (BF - BB - HBP). Good enough; SF/SH unavailable here.
        baa_denom = bf - bb - hbp
        baa = (h_allowed / baa_denom) if baa_denom > 0 else None
        pbp_row = pbp.get(pid, {})
        tm = team_meta.get(p['team_id'], {})
        out.append({
            'player_id': pid,
            'team_id': p['team_id'],
            'team_short': tm.get('short_name'),
            'team_logo': tm.get('logo_url'),
            'first_name': p['first_name'],
            'last_name': p['last_name'],
            'jersey_number': p['jersey_number'],
            'position': p['position'],
            'throws': p['throws'],
            'height': p['height'],
            'weight': p['weight'],
            'year_in_school': p['year_in_school'],
            'commitment': _commitment_label(p['is_committed'], p['committed_to']),

            'ip':           _f(p['ip']),
            'gs':           p['gs'] or 0,
            'pitching_war': _f(p['pitching_war']),
            'era':          _f(p['era']),
            'fip':          _f(p['fip']),
            'siera':        _f(p['siera']),
            'baa':          baa,
            'k_pct':        k_pct,
            'bb_pct':       bb_pct,
            'whiff_pct':    pbp_row.get('whiff_pct'),
            'strike_pct':   pbp_row.get('strike_pct'),
            'putaway_pct':  pbp_row.get('putaway_pct'),
        })
    return out


# ─────────────────────────────────────────────────────────────────
# Percentiles (within the 8-team field)
# ─────────────────────────────────────────────────────────────────

def _attach_percentiles(rows, dir_map, qualifier_fn):
    if not rows:
        return
    qualified = [r for r in rows if qualifier_fn(r)]
    cohort = {k: [r.get(k) for r in qualified] for k in dir_map.keys()}
    for r in rows:
        is_q = qualifier_fn(r)
        r['low_sample'] = not is_q
        if is_q:
            r['percentiles'] = {
                k: _percentile_rank(r.get(k), cohort[k], direction)
                for k, direction in dir_map.items()
            }
        else:
            r['percentiles'] = {k: None for k in dir_map.keys()}


def _hitter_qualified(row):
    return (row.get('pa') or 0) >= HITTER_MIN_PA


def _pitcher_qualified(row):
    ip = row.get('ip')
    if ip is None:
        return False
    return float(ip) >= PITCHER_MIN_IP


def _sort_by_war(rows, war_key):
    # WAR descending; None last; tiebreak by name.
    return sorted(
        rows,
        key=lambda r: (
            -(r.get(war_key) if r.get(war_key) is not None else -999),
            (r.get('last_name') or ''),
        ),
    )


# ─────────────────────────────────────────────────────────────────
# Public entry point
# ─────────────────────────────────────────────────────────────────

def build_nwac_tournament_sheet(cur, season):
    """Build the cross-team NWAC championship board payload.

    Returns:
      {
        'season': int,
        'teams': [{id, short_name, logo_url, conference_abbrev}, ...],
        'pitchers': [...],   # ranked by WAR desc
        'hitters':  [...],   # ranked by WAR desc
        'thresholds': {hitter_min_pa, pitcher_min_ip},
        'cohort_size': {...},
      }
    """
    team_ids = _champ_team_ids()
    team_meta = _fetch_team_meta(cur, team_ids)

    raw_hitters = _fetch_hitters(cur, team_ids, season)
    raw_pitchers = _fetch_pitchers(cur, team_ids, season)

    hitter_pids = [r['player_id'] for r in raw_hitters]
    pitcher_pids = [r['player_id'] for r in raw_pitchers]

    pbp_h = _fetch_hitter_pbp_bulk(cur, hitter_pids, season)
    pbp_p = _fetch_pitcher_pbp_bulk(cur, pitcher_pids, season)

    hitters = _build_hitter_rows(raw_hitters, pbp_h, team_meta)
    pitchers = _build_pitcher_rows(raw_pitchers, pbp_p, team_meta)

    _attach_percentiles(hitters, HITTER_PCT_DIRS, _hitter_qualified)
    _attach_percentiles(pitchers, PITCHER_PCT_DIRS, _pitcher_qualified)

    hitters = _sort_by_war(hitters, 'offensive_war')
    pitchers = _sort_by_war(pitchers, 'pitching_war')

    # Attach a rank (1-based) for display.
    for i, r in enumerate(pitchers):
        r['rank'] = i + 1
    for i, r in enumerate(hitters):
        r['rank'] = i + 1

    # Teams list ordered by seed (the constant's insertion order).
    teams_ordered = [
        {
            'id': tid,
            'short_name': team_meta.get(tid, {}).get('short_name'),
            'name': team_meta.get(tid, {}).get('name'),
            'logo_url': team_meta.get(tid, {}).get('logo_url'),
            'conference_abbrev': team_meta.get(tid, {}).get('conference_abbrev'),
        }
        for tid in team_ids
    ]

    return {
        'season': season,
        'teams': teams_ordered,
        'pitchers': pitchers,
        'hitters': hitters,
        'thresholds': {
            'hitter_min_pa': HITTER_MIN_PA,
            'pitcher_min_ip': PITCHER_MIN_IP,
        },
        'cohort_size': {
            'hitters': len(hitters),
            'pitchers': len(pitchers),
            'hitters_qualified': sum(1 for r in hitters if _hitter_qualified(r)),
            'pitchers_qualified': sum(1 for r in pitchers if _pitcher_qualified(r)),
        },
    }
