"""
Scouting Sheet backend.

Builds a printable per-team roster sheet — every hitter on one page,
every pitcher on another — modeled after the 643 Charts scouting sheet
but powered by NWBB Stats data.

HITTER COLUMNS (13 stats):
  PA, wOBA vs RHP, wOBA vs LHP, GB% or FB% (whichever is higher),
  K%, BB%, ISO, SB/SBA, HR/FB, Contact%, First Pitch Swing%,
  Swing%, Putaway%

PITCHER COLUMNS (11 stats):
  IP, wOBA vs RHH, wOBA vs LHH, K%, BB%, Whiff%, ISO against,
  BAA against, GB% or FB% (whichever is higher), Strike%, First Pitch Strike%

Percentiles: each stat is ranked against every same-position player
(hitters vs all hitters, pitchers vs all pitchers) in the team's
CONFERENCE for the season. Output cells get a `percentile` (0-100)
and the frontend shades them on a Savant-style red→white→blue ramp.

Author note (2026-04-28): reuses lineup_helper._fetch_pbp_stats_bulk
and team_scouting._bulk_hitter_split for the heavy lifting; this
module only adds the bits those don't already give us (per-pitcher
PBP discipline, per-hitter putaway%, per-hitter first-pitch-swing%,
and pitcher wOBA splits).
"""

from __future__ import annotations

from .lineup_helper import _fetch_pbp_stats_bulk as _fetch_hitter_pbp_bulk
from .team_scouting import _bulk_hitter_split, _bulk_pitcher_split


# ─────────────────────────────────────────────────────────────────
# Per-player extras the existing helpers don't cover
# ─────────────────────────────────────────────────────────────────

def _bulk_hitter_extras(cur, player_ids, season):
    """Per-hitter First Pitch Swing% + Putaway%.

    First Pitch Swing% denominator note: we ONLY count PAs where the
    pitch info was actually captured (pitches_thrown IS NOT NULL).
    Box scores from some scorers have no per-pitch count — those
    rows arrive with seq='' and pitches_thrown=NULL even when many
    pitches were thrown. If we counted them in the denominator,
    every in-play hit (was_in_play=true) on a no-count row would
    look like a 1-pitch swing and inflate the rate dramatically.
    By filtering on pitches_thrown IS NOT NULL we use only the
    PAs where the answer is actually knowable.

    Returns: {pid: {'first_pitch_swing_pct': float|None,
                    'putaway_pct': float|None}}
    """
    if not player_ids:
        return {}
    cur.execute(
        """
        SELECT
          ge.batter_player_id AS pid,
          -- Numerator: PAs with confirmed first-pitch SWING.
          --   K = swing-and-miss, F = foul (both swings).
          --   Empty seq + was_in_play + pitches_thrown=1 = 1-pitch
          --   in-play (definitely a swing).  The pitches_thrown=1
          --   guard prevents counting unknown-count PAs.
          --   S = called strike (a TAKE) — deliberately excluded.
          COUNT(*) FILTER (
            WHERE (LENGTH(pitch_sequence) > 0 AND LEFT(pitch_sequence, 1) IN ('K','F'))
               OR (LENGTH(pitch_sequence) = 0 AND was_in_play AND pitches_thrown = 1)
          ) AS first_pitch_swings,
          -- Denominator: PAs where we actually know the pitch info.
          COUNT(*) FILTER (
            WHERE pitches_thrown IS NOT NULL AND pitches_thrown >= 1
          ) AS fps_pa_known,
          COUNT(*) FILTER (WHERE strikes_before >= 2) AS two_strike_pa,
          COUNT(*) FILTER (
            WHERE strikes_before >= 2
              AND ge.result_type IN ('strikeout_swinging','strikeout_looking')
          ) AS putaway_k
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        WHERE ge.batter_player_id = ANY(%s)
          AND g.season = %s
          AND ge.result_type IS NOT NULL
        GROUP BY ge.batter_player_id
        """,
        (player_ids, season),
    )
    out = {}
    for r in cur.fetchall():
        denom = r['fps_pa_known'] or 0
        two_strike = r['two_strike_pa'] or 0
        out[r['pid']] = {
            'first_pitch_swing_pct': (r['first_pitch_swings'] / denom) if denom else None,
            'putaway_pct': (r['putaway_k'] / two_strike) if two_strike else None,
        }
    return out


def _fetch_pitcher_pbp_bulk(cur, player_ids, season):
    """Per-pitcher PBP discipline + batted-ball + ISO against + BAA against.

    Returns:
      {pid: {whiff_pct, strike_pct, fps_pct, putaway_pct, gb_pct, fb_pct,
             iso_against, baa_against, bf_pbp}}

    PARSER CONVENTION (important for getting the strike% right):
      - pitch_sequence is a string of B/K/S/F/H letters where:
          B = ball, K = swinging strike, S = called strike,
          F = foul, H = hit-by-pitch
      - For strikeouts and walks, pitch_sequence INCLUDES the terminal
        pitch — so the K of a strikeout is already counted in the seq.
      - For balls put in play, pitch_sequence excludes the terminal
        pitch — so we add `+1` for each was_in_play row to count it.
      - pitches_thrown column = LEN(seq) + (1 if was_in_play else 0).

    Strike count therefore = K + S + F (from seq) + in_play (terminal).
    Don't add a separate "terminal_strikes" — that double-counts the K
    on strikeouts since the K is already in the seq.
    """
    if not player_ids:
        return {}
    cur.execute(
        """
        SELECT
          ge.pitcher_player_id AS pid,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))) AS k_pitches,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))) AS s_pitches,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))) AS f_pitches,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'B', ''))) AS b_pitches,
          SUM(pitches_thrown) AS pitches_total,
          COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play,
          -- First-pitch STRIKE: any first-pitch outcome the pitcher
          --   wants — K (swing+miss), S (called strike), F (foul),
          --   or 1-pitch in-play (a strike by definition).  Same
          --   pitches_thrown=1 guard as on the hitter side: PAs
          --   without captured pitch counts get excluded so they
          --   don't inflate the rate.
          COUNT(*) FILTER (
            WHERE (LENGTH(pitch_sequence) > 0 AND LEFT(pitch_sequence, 1) IN ('K','S','F'))
               OR (LENGTH(pitch_sequence) = 0 AND was_in_play AND pitches_thrown = 1)
          ) AS first_pitch_strikes,
          COUNT(*) FILTER (
            WHERE pitches_thrown IS NOT NULL AND pitches_thrown >= 1
          ) AS fps_pa_known,
          COUNT(*) FILTER (WHERE strikes_before >= 2) AS two_strike_pa,
          COUNT(*) FILTER (
            WHERE strikes_before >= 2
              AND ge.result_type IN ('strikeout_swinging','strikeout_looking')
          ) AS putaway_k,
          COUNT(*) FILTER (WHERE bb_type = 'GB') AS gb,
          COUNT(*) FILTER (WHERE bb_type = 'FB') AS fb,
          COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
          COUNT(*) AS pa,
          COUNT(*) FILTER (
            WHERE ge.result_type IN (
              'single','double','triple','home_run',
              'strikeout_swinging','strikeout_looking',
              'ground_out','fly_out','line_out','pop_out',
              'fielders_choice','error','double_play','other'
            )
          ) AS ab,
          COUNT(*) FILTER (WHERE ge.result_type = 'single')   AS singles,
          COUNT(*) FILTER (WHERE ge.result_type = 'double')   AS doubles,
          COUNT(*) FILTER (WHERE ge.result_type = 'triple')   AS triples,
          COUNT(*) FILTER (WHERE ge.result_type = 'home_run') AS hr
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        WHERE ge.pitcher_player_id = ANY(%s)
          AND g.season = %s
          AND ge.result_type IS NOT NULL
        GROUP BY ge.pitcher_player_id
        """,
        (player_ids, season),
    )
    out = {}
    for r in cur.fetchall():
        k_p = float(r['k_pitches'] or 0)
        s_p = float(r['s_pitches'] or 0)
        f_p = float(r['f_pitches'] or 0)
        in_play = float(r['in_play'] or 0)
        bb_total = float(r['bb_total'] or 0)
        pa = float(r['pa'] or 0)
        ab = float(r['ab'] or 0)
        # pitches_total comes straight from the parser (already the sum
        # of seq length + 1 for in_play rows), so it matches the
        # numerator's coverage exactly.
        pitches_total = float(r['pitches_total'] or 0)

        # Swings: only motions where the bat moved → K (whiff), F (foul),
        # in_play. Called strikes (S) are takes, not swings.
        swings = k_p + f_p + in_play
        # All strikes (for strike%): K + S + F from seq, plus in_play
        # (every batted ball counts as a strike). Strikeouts have the
        # final K already in the seq, so don't add it again.
        strikes = k_p + s_p + f_p + in_play

        singles = r['singles'] or 0
        doubles = r['doubles'] or 0
        triples = r['triples'] or 0
        hr = r['hr'] or 0
        h = singles + doubles + triples + hr
        tb = singles + 2 * doubles + 3 * triples + 4 * hr
        avg_against = (h / ab) if ab else None
        slg_against = (tb / ab) if ab else None
        iso_against = (slg_against - avg_against) if (slg_against is not None and avg_against is not None) else None

        def _safe(num, denom):
            return (float(num) / float(denom)) if denom else None

        two_strike = r['two_strike_pa'] or 0
        out[r['pid']] = {
            'whiff_pct':    _safe(k_p, swings),
            'strike_pct':   _safe(strikes, pitches_total),
            'fps_pct':      _safe(r['first_pitch_strikes'] or 0, r['fps_pa_known'] or 0),
            'putaway_pct':  _safe(r['putaway_k'] or 0, two_strike),
            'gb_pct':       _safe(r['gb'] or 0, bb_total),
            'fb_pct':       _safe(r['fb'] or 0, bb_total),
            'iso_against':  iso_against,
            'baa_against':  avg_against,
            'bf_pbp':       int(pa),
        }
    return out


def _bulk_pitcher_woba_split(cur, player_ids, season, extra_where, extra_params=()):
    """Per-pitcher wOBA in a split (vs LHH, vs RHH). Mirrors the
    team_scouting hitter split helper but on the defending side and
    keying on bats handedness.

    Returns: {pid: {woba: float|None, bf: int}}
    """
    if not player_ids:
        return {}
    sql = f"""
        SELECT
          ge.pitcher_player_id AS pid,
          COUNT(*) AS bf,
          COUNT(*) FILTER (WHERE result_type = 'single')   AS singles,
          COUNT(*) FILTER (WHERE result_type = 'double')   AS doubles,
          COUNT(*) FILTER (WHERE result_type = 'triple')   AS triples,
          COUNT(*) FILTER (WHERE result_type = 'home_run') AS hr,
          COUNT(*) FILTER (WHERE result_type IN ('walk','intentional_walk')) AS bb,
          COUNT(*) FILTER (WHERE result_type = 'hbp') AS hbp,
          COUNT(*) FILTER (WHERE result_type = 'sac_fly') AS sf,
          COUNT(*) FILTER (WHERE result_type IN
            ('single','double','triple','home_run',
             'strikeout_swinging','strikeout_looking',
             'ground_out','fly_out','line_out','pop_out',
             'fielders_choice','error','double_play','other')) AS ab
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        LEFT JOIN players pb ON pb.id = ge.batter_player_id
        WHERE ge.pitcher_player_id = ANY(%s)
          AND g.season = %s
          AND ge.result_type IS NOT NULL
          {extra_where}
        GROUP BY ge.pitcher_player_id
    """
    cur.execute(sql, (player_ids, season, *extra_params))
    out = {}
    for r in cur.fetchall():
        bf = r['bf'] or 0
        if bf == 0:
            continue
        ab = r['ab'] or 0
        singles = r['singles'] or 0
        doubles = r['doubles'] or 0
        triples = r['triples'] or 0
        hr = r['hr'] or 0
        bb = r['bb'] or 0
        hbp = r['hbp'] or 0
        sf = r['sf'] or 0
        # D3/NAIA-ish wOBA weights, same constants used elsewhere
        woba_num = 0.69 * bb + 0.72 * hbp + 0.88 * singles + 1.24 * doubles + 1.56 * triples + 2.0 * hr
        woba_denom = ab + bb + sf + hbp
        woba = (woba_num / woba_denom) if woba_denom else None
        out[r['pid']] = {'woba': woba, 'bf': bf}
    return out


# ─────────────────────────────────────────────────────────────────
# Percentile ranking
# ─────────────────────────────────────────────────────────────────

# direction: 'higher_better' | 'lower_better' | 'neutral'
HITTER_PCT_DIRS = {
    'pa':                    'higher_better',  # not really directional, but more is more
    'woba_vs_rhp':           'higher_better',
    'woba_vs_lhp':           'higher_better',
    'gb_or_fb_value':        'neutral',
    'k_pct':                 'lower_better',
    'bb_pct':                'higher_better',
    'iso':                   'higher_better',
    'sb_made':               'higher_better',
    'hr_per_fb':             'higher_better',
    'contact_pct':           'higher_better',
    'first_pitch_swing_pct': 'higher_better',  # Nate: aggressive at-bats are a positive
    'swing_pct':             'higher_better',
    'putaway_pct':           'lower_better',  # for HITTER, lower K% with 2 strikes = better
}

PITCHER_PCT_DIRS = {
    'ip':            'higher_better',
    'woba_vs_rhh':   'lower_better',
    'woba_vs_lhh':   'lower_better',
    'k_pct':         'higher_better',
    'bb_pct':        'lower_better',
    'whiff_pct':     'higher_better',
    'iso_against':   'lower_better',
    'baa_against':   'lower_better',
    'gb_or_fb_value':'neutral',
    'strike_pct':    'higher_better',
    'fps_pct':       'higher_better',
    'putaway_pct':   'higher_better',  # pitcher putaway = ability to finish ABs
}


def _percentile_rank(value, all_values, direction):
    """Return a 0-100 percentile rank. 'neutral' still returns a value
    (for ordering) but the frontend will render it as a gray bar."""
    if value is None:
        return None
    vals = [v for v in all_values if v is not None]
    if len(vals) < 2:
        return 50.0
    if direction == 'lower_better':
        below = sum(1 for v in vals if v > value)
    else:
        below = sum(1 for v in vals if v < value)
    equal = sum(1 for v in vals if v == value)
    pct = ((below + equal * 0.5) / len(vals)) * 100.0
    return round(pct, 1)


def _attach_percentiles(rows, dir_map, qualifier_fn):
    """For each row in `rows`, attach row['percentiles'] = {key: pct}.

    `qualifier_fn(row) -> bool` decides whether the row contributes to
    the percentile distribution. Low-sample rows are still kept in the
    output (the sheet shows everyone on the roster) but they:
      - get `row['low_sample'] = True`
      - get `row['percentiles']` filled entirely with None (so the
        frontend renders their cells in a neutral gray instead of
        green/red — they're visible but flagged)
    Qualified rows are ranked only against other qualified rows so a
    handful of 2-PA outliers can't distort everyone else's percentiles.
    """
    if not rows:
        return
    qualified = [r for r in rows if qualifier_fn(r)]
    cohort = {k: [r.get(k) for r in qualified] for k in dir_map.keys()}
    for r in rows:
        is_qualified = qualifier_fn(r)
        r['low_sample'] = not is_qualified
        if is_qualified:
            r['percentiles'] = {
                k: _percentile_rank(r.get(k), cohort[k], direction)
                for k, direction in dir_map.items()
            }
        else:
            r['percentiles'] = {k: None for k in dir_map.keys()}


# Sample-size qualifiers — a player below these thresholds is shown
# on the sheet with neutral gray cells and is excluded from the
# percentile cohort so their tiny-sample wOBA can't skew rankings.
HITTER_MIN_PA = 25
PITCHER_MIN_IP = 5.0


def _hitter_qualified(row):
    return (row.get('pa') or 0) >= HITTER_MIN_PA


def _pitcher_qualified(row):
    ip = row.get('ip')
    if ip is None:
        return False
    # innings_pitched is stored in baseball notation (6.2 = 6 2/3 IP).
    # For the qualifier we just need a rough total — int(ip) gets the
    # whole-innings part, which is fine at a 5 IP threshold.
    return float(ip) >= PITCHER_MIN_IP


# ─────────────────────────────────────────────────────────────────
# Roster fetch
# ─────────────────────────────────────────────────────────────────

def _fetch_team_meta(cur, team_id):
    cur.execute(
        """
        SELECT t.id, t.name, t.short_name, t.logo_url, t.conference_id,
               c.name AS conference_name, c.abbreviation AS conference_abbrev
        FROM teams t
        LEFT JOIN conferences c ON c.id = t.conference_id
        WHERE t.id = %s
        """,
        (team_id,),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def _fetch_conference_team_ids(cur, conference_id):
    if conference_id is None:
        return []
    cur.execute(
        "SELECT id FROM teams WHERE conference_id = %s AND is_active = 1",
        (conference_id,),
    )
    return [r['id'] for r in cur.fetchall()]


def _fetch_hitters(cur, team_ids, season):
    """Pull every hitter on the given teams who appears in batting_stats
    for the season (so we naturally get the active roster). Returns
    list of dicts with the season totals and player meta."""
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
          p.year_in_school,
          bs.plate_appearances AS pa,
          bs.at_bats           AS ab,
          bs.hits              AS h,
          bs.doubles           AS doubles,
          bs.triples           AS triples,
          bs.home_runs         AS hr,
          bs.walks             AS bb,
          bs.intentional_walks AS ibb,
          bs.hit_by_pitch      AS hbp,
          bs.strikeouts        AS so,
          bs.stolen_bases      AS sb,
          bs.caught_stealing   AS cs,
          bs.iso               AS iso
        FROM players p
        JOIN batting_stats bs ON bs.player_id = p.id AND bs.season = %s
        WHERE p.team_id = ANY(%s)
          AND COALESCE(bs.plate_appearances, 0) > 0
        ORDER BY p.team_id, p.jersey_number NULLS LAST, p.last_name
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
          p.year_in_school,
          ps.innings_pitched   AS ip,
          ps.batters_faced     AS bf,
          ps.strikeouts        AS so,
          ps.walks             AS bb,
          ps.hits_allowed      AS h_allowed,
          ps.home_runs_allowed AS hr_allowed,
          ps.hit_batters       AS hbp_allowed
        FROM players p
        JOIN pitching_stats ps ON ps.player_id = p.id AND ps.season = %s
        WHERE p.team_id = ANY(%s)
          AND COALESCE(ps.innings_pitched, 0) > 0
        ORDER BY p.team_id, p.jersey_number NULLS LAST, p.last_name
        """,
        (season, team_ids),
    )
    return [dict(r) for r in cur.fetchall()]


# ─────────────────────────────────────────────────────────────────
# Builders — turn raw rows + extras into final scouting-sheet rows
# ─────────────────────────────────────────────────────────────────

def _build_hitter_rows(raw_hitters, vs_rhp, vs_lhp, pbp, extras):
    """Merge raw batting_stats with PBP-derived stats into the final
    per-hitter row shape. Returns list of dicts; one per hitter."""
    out = []
    for h in raw_hitters:
        pid = h['player_id']
        pa = h['pa'] or 0
        bb_total = (h['bb'] or 0) + (h['ibb'] or 0)
        # Recompute K%/BB% from raw counts so they're consistent across teams
        k_pct = (h['so'] / pa) if pa else None
        bb_pct = (bb_total / pa) if pa else None
        sb = h['sb'] or 0
        cs = h['cs'] or 0
        sba = sb + cs
        sb_str = f"{sb}/{sba}" if sba else (f"{sb}/0" if sb else "0/0")

        pbp_row = pbp.get(pid, {})
        gb = pbp_row.get('gb_pct')
        fb = pbp_row.get('fb_pct')
        if gb is not None and fb is not None:
            if gb >= fb:
                gb_or_fb_type = 'GB'; gb_or_fb_value = gb
            else:
                gb_or_fb_type = 'FB'; gb_or_fb_value = fb
        elif gb is not None:
            gb_or_fb_type = 'GB'; gb_or_fb_value = gb
        elif fb is not None:
            gb_or_fb_type = 'FB'; gb_or_fb_value = fb
        else:
            gb_or_fb_type = None; gb_or_fb_value = None

        hr = h['hr'] or 0
        # HR/FB needs a count of FB events (not the fb_pct rate). The
        # _fetch_pbp_stats_bulk helper exposes bb_total but not FB count
        # directly; we have fb_pct and bb_total though, so reconstruct.
        fb_count = None
        bb_total_pbp = pbp_row.get('bb_total')
        if fb is not None and bb_total_pbp:
            fb_count = fb * bb_total_pbp
        hr_per_fb = (hr / fb_count) if (fb_count and fb_count > 0) else None

        ext = extras.get(pid, {})

        out.append({
            'player_id': pid,
            'team_id': h['team_id'],
            'first_name': h['first_name'],
            'last_name': h['last_name'],
            'jersey_number': h['jersey_number'],
            'position': h['position'],
            'bats': h['bats'],
            'year_in_school': h['year_in_school'],

            'pa': pa,
            'woba_vs_rhp': vs_rhp.get(pid, {}).get('woba'),
            'woba_vs_lhp': vs_lhp.get(pid, {}).get('woba'),
            'pa_vs_rhp':   vs_rhp.get(pid, {}).get('pa'),
            'pa_vs_lhp':   vs_lhp.get(pid, {}).get('pa'),
            'gb_or_fb_type':  gb_or_fb_type,
            'gb_or_fb_value': gb_or_fb_value,
            'k_pct': k_pct,
            'bb_pct': bb_pct,
            'iso': float(h['iso']) if h['iso'] is not None else None,
            'sb_made': sb,
            'sb_attempts': sba,
            'sb_str': sb_str,
            'hr_per_fb': hr_per_fb,
            'contact_pct': pbp_row.get('contact_pct'),
            'first_pitch_swing_pct': ext.get('first_pitch_swing_pct'),
            'swing_pct': pbp_row.get('swing_pct'),
            'putaway_pct': ext.get('putaway_pct'),
        })
    return out


def _build_pitcher_rows(raw_pitchers, vs_rhh, vs_lhh, pbp_pit):
    out = []
    for p in raw_pitchers:
        pid = p['player_id']
        bf = p['bf'] or 0
        so = p['so'] or 0
        bb = p['bb'] or 0
        hbp_allowed = p['hbp_allowed'] or 0
        h_allowed = p['h_allowed'] or 0
        k_pct = (so / bf) if bf else None
        bb_pct = (bb / bf) if bf else None
        # Computed BAA from raw counts: H / (BF - BB - HBP)
        baa_denom = bf - bb - hbp_allowed
        baa_computed = (h_allowed / baa_denom) if baa_denom > 0 else None

        pbp_row = pbp_pit.get(pid, {})
        gb = pbp_row.get('gb_pct')
        fb = pbp_row.get('fb_pct')
        if gb is not None and fb is not None:
            if gb >= fb:
                gb_or_fb_type = 'GB'; gb_or_fb_value = gb
            else:
                gb_or_fb_type = 'FB'; gb_or_fb_value = fb
        elif gb is not None:
            gb_or_fb_type = 'GB'; gb_or_fb_value = gb
        elif fb is not None:
            gb_or_fb_type = 'FB'; gb_or_fb_value = fb
        else:
            gb_or_fb_type = None; gb_or_fb_value = None

        out.append({
            'player_id': pid,
            'team_id': p['team_id'],
            'first_name': p['first_name'],
            'last_name': p['last_name'],
            'jersey_number': p['jersey_number'],
            'position': p['position'],
            'throws': p['throws'],
            'year_in_school': p['year_in_school'],

            'ip': float(p['ip']) if p['ip'] is not None else None,
            'woba_vs_rhh': vs_rhh.get(pid, {}).get('woba'),
            'woba_vs_lhh': vs_lhh.get(pid, {}).get('woba'),
            'bf_vs_rhh':   vs_rhh.get(pid, {}).get('bf'),
            'bf_vs_lhh':   vs_lhh.get(pid, {}).get('bf'),
            'k_pct': k_pct,
            'bb_pct': bb_pct,
            'whiff_pct':    pbp_row.get('whiff_pct'),
            'iso_against':  pbp_row.get('iso_against'),
            'baa_against':  pbp_row.get('baa_against') if pbp_row.get('baa_against') is not None
                            else baa_computed,
            'gb_or_fb_type':  gb_or_fb_type,
            'gb_or_fb_value': gb_or_fb_value,
            'strike_pct':   pbp_row.get('strike_pct'),
            'fps_pct':      pbp_row.get('fps_pct'),
            'putaway_pct':  pbp_row.get('putaway_pct'),
        })
    return out


# ─────────────────────────────────────────────────────────────────
# Team-level aggregation rows (for the totals row at the bottom of
# each table). We do a PA-weighted (or IP-weighted) average of each
# rate stat across the team's qualified players, then percentile-rank
# the team against OTHER TEAMS in the conference so the colored
# totals row is comparable peer-to-peer.
# ─────────────────────────────────────────────────────────────────

def _wavg(rows, value_key, weight_key):
    """Weighted average of `value_key` across `rows`, weighting by
    `weight_key`. Skips rows where either is None."""
    num = 0.0
    den = 0.0
    for r in rows:
        v = r.get(value_key)
        w = r.get(weight_key)
        if v is None or w is None or w <= 0:
            continue
        num += v * w
        den += w
    return (num / den) if den > 0 else None


def _team_groupings(all_rows):
    """Group rows by team_id."""
    groups = {}
    for r in all_rows:
        groups.setdefault(r['team_id'], []).append(r)
    return groups


def _aggregate_team_hitters(all_hitter_rows, target_team_id):
    """Build the team-level totals row for the hitters table. Returns a
    dict shaped like an individual hitter row (with 'percentiles' filled
    against the other teams in the conference)."""
    groups = _team_groupings(all_hitter_rows)
    team_aggs = {}
    for tid, rows in groups.items():
        total_pa = sum((r.get('pa') or 0) for r in rows)
        if total_pa == 0:
            continue
        agg = {
            'team_id': tid,
            'pa':                    total_pa,
            'woba_vs_rhp':           _wavg(rows, 'woba_vs_rhp', 'pa_vs_rhp'),
            'woba_vs_lhp':           _wavg(rows, 'woba_vs_lhp', 'pa_vs_lhp'),
            'k_pct':                 _wavg(rows, 'k_pct', 'pa'),
            'bb_pct':                _wavg(rows, 'bb_pct', 'pa'),
            'iso':                   _wavg(rows, 'iso', 'pa'),
            'hr_per_fb':             _wavg(rows, 'hr_per_fb', 'pa'),
            'contact_pct':           _wavg(rows, 'contact_pct', 'pa'),
            'first_pitch_swing_pct': _wavg(rows, 'first_pitch_swing_pct', 'pa'),
            'swing_pct':             _wavg(rows, 'swing_pct', 'pa'),
            'putaway_pct':           _wavg(rows, 'putaway_pct', 'pa'),
            'sb_made':               sum((r.get('sb_made') or 0)     for r in rows),
            'sb_attempts':           sum((r.get('sb_attempts') or 0) for r in rows),
        }
        agg['sb_str'] = f"{agg['sb_made']}/{agg['sb_attempts']}"
        # GB/FB pick at team level: pool the team's hitters' GB and FB rates,
        # PA-weighted, then pick whichever is higher.
        team_gb = _wavg(
            [r for r in rows if r.get('gb_or_fb_type') == 'GB'],
            'gb_or_fb_value', 'pa'
        )
        team_fb = _wavg(
            [r for r in rows if r.get('gb_or_fb_type') == 'FB'],
            'gb_or_fb_value', 'pa'
        )
        if team_gb is not None and team_fb is not None:
            if team_gb >= team_fb:
                agg['gb_or_fb_type'] = 'GB'; agg['gb_or_fb_value'] = team_gb
            else:
                agg['gb_or_fb_type'] = 'FB'; agg['gb_or_fb_value'] = team_fb
        elif team_gb is not None:
            agg['gb_or_fb_type'] = 'GB'; agg['gb_or_fb_value'] = team_gb
        elif team_fb is not None:
            agg['gb_or_fb_type'] = 'FB'; agg['gb_or_fb_value'] = team_fb
        else:
            agg['gb_or_fb_type'] = None; agg['gb_or_fb_value'] = None
        team_aggs[tid] = agg

    target = team_aggs.get(target_team_id)
    if not target:
        return None

    # Percentile rank target team vs other teams in the conference.
    cohort_lists = {k: [a.get(k) for a in team_aggs.values()] for k in HITTER_PCT_DIRS.keys()}
    target['percentiles'] = {
        k: _percentile_rank(target.get(k), cohort_lists[k], direction)
        for k, direction in HITTER_PCT_DIRS.items()
    }
    target['low_sample'] = False
    target['n_teams'] = len(team_aggs)
    return target


def _aggregate_team_pitchers(all_pitcher_rows, target_team_id):
    """Same as _aggregate_team_hitters but for pitching."""
    groups = _team_groupings(all_pitcher_rows)
    team_aggs = {}
    for tid, rows in groups.items():
        total_ip = sum(float(r.get('ip') or 0) for r in rows)
        if total_ip == 0:
            continue
        agg = {
            'team_id': tid,
            'ip':            total_ip,
            'woba_vs_rhh':   _wavg(rows, 'woba_vs_rhh', 'bf_vs_rhh'),
            'woba_vs_lhh':   _wavg(rows, 'woba_vs_lhh', 'bf_vs_lhh'),
            'k_pct':         _wavg(rows, 'k_pct', 'ip'),
            'bb_pct':        _wavg(rows, 'bb_pct', 'ip'),
            'whiff_pct':     _wavg(rows, 'whiff_pct', 'ip'),
            'iso_against':   _wavg(rows, 'iso_against', 'ip'),
            'baa_against':   _wavg(rows, 'baa_against', 'ip'),
            'strike_pct':    _wavg(rows, 'strike_pct', 'ip'),
            'fps_pct':       _wavg(rows, 'fps_pct', 'ip'),
            'putaway_pct':   _wavg(rows, 'putaway_pct', 'ip'),
        }
        team_gb = _wavg(
            [r for r in rows if r.get('gb_or_fb_type') == 'GB'],
            'gb_or_fb_value', 'ip'
        )
        team_fb = _wavg(
            [r for r in rows if r.get('gb_or_fb_type') == 'FB'],
            'gb_or_fb_value', 'ip'
        )
        if team_gb is not None and team_fb is not None:
            if team_gb >= team_fb:
                agg['gb_or_fb_type'] = 'GB'; agg['gb_or_fb_value'] = team_gb
            else:
                agg['gb_or_fb_type'] = 'FB'; agg['gb_or_fb_value'] = team_fb
        elif team_gb is not None:
            agg['gb_or_fb_type'] = 'GB'; agg['gb_or_fb_value'] = team_gb
        elif team_fb is not None:
            agg['gb_or_fb_type'] = 'FB'; agg['gb_or_fb_value'] = team_fb
        else:
            agg['gb_or_fb_type'] = None; agg['gb_or_fb_value'] = None
        team_aggs[tid] = agg

    target = team_aggs.get(target_team_id)
    if not target:
        return None

    cohort_lists = {k: [a.get(k) for a in team_aggs.values()] for k in PITCHER_PCT_DIRS.keys()}
    target['percentiles'] = {
        k: _percentile_rank(target.get(k), cohort_lists[k], direction)
        for k, direction in PITCHER_PCT_DIRS.items()
    }
    target['low_sample'] = False
    target['n_teams'] = len(team_aggs)
    return target


# ─────────────────────────────────────────────────────────────────
# Public entry point
# ─────────────────────────────────────────────────────────────────

def build_scouting_sheet(cur, team_id, season):
    """Build the full scouting-sheet payload for one team.

    Returns a dict:
      {
        'team': { id, name, short_name, logo_url,
                  conference_id, conference_name, conference_abbrev },
        'season': int,
        'hitters': [...],   # one row per hitter on the team
        'pitchers': [...],  # one row per pitcher on the team
      }

    Hitter and pitcher rows include a 'percentiles' subdict with each
    stat's 0-100 percentile vs the team's CONFERENCE cohort.
    """
    team = _fetch_team_meta(cur, team_id)
    if not team:
        return None

    conf_team_ids = _fetch_conference_team_ids(cur, team['conference_id'])
    if team_id not in conf_team_ids:
        # team is inactive or outside its own conference somehow — still
        # rank against itself so the page doesn't blow up
        conf_team_ids = [team_id]

    # Conference cohorts (for percentile ranking)
    raw_hitters_conf  = _fetch_hitters(cur, conf_team_ids, season)
    raw_pitchers_conf = _fetch_pitchers(cur, conf_team_ids, season)

    hitter_pids  = [r['player_id'] for r in raw_hitters_conf]
    pitcher_pids = [r['player_id'] for r in raw_pitchers_conf]

    # PBP-side aggregations across the entire conference cohort
    vs_rhp = _bulk_hitter_split(cur, hitter_pids, season, "AND pp.throws = 'R'")
    vs_lhp = _bulk_hitter_split(cur, hitter_pids, season, "AND pp.throws = 'L'")
    pbp_h  = _fetch_hitter_pbp_bulk(cur, hitter_pids, season)
    extras = _bulk_hitter_extras(cur, hitter_pids, season)

    vs_rhh = _bulk_pitcher_woba_split(cur, pitcher_pids, season, "AND pb.bats = 'R'")
    vs_lhh = _bulk_pitcher_woba_split(cur, pitcher_pids, season, "AND pb.bats = 'L'")
    pbp_p  = _fetch_pitcher_pbp_bulk(cur, pitcher_pids, season)

    # Build full conference rows (so percentiles rank against the whole conference)
    all_hitter_rows  = _build_hitter_rows(raw_hitters_conf, vs_rhp, vs_lhp, pbp_h, extras)
    all_pitcher_rows = _build_pitcher_rows(raw_pitchers_conf, vs_rhh, vs_lhh, pbp_p)

    _attach_percentiles(all_hitter_rows, HITTER_PCT_DIRS, _hitter_qualified)
    _attach_percentiles(all_pitcher_rows, PITCHER_PCT_DIRS, _pitcher_qualified)

    # Filter down to just this team's roster for the response
    team_hitters  = [r for r in all_hitter_rows  if r['team_id'] == team_id]
    team_pitchers = [r for r in all_pitcher_rows if r['team_id'] == team_id]

    # Team aggregate rows — sum the team's PAs/IP and roll up the rate
    # stats. Each rate stat gets a percentile vs OTHER TEAMS in the
    # conference (not vs individual players) so the colored team row
    # is interpretable.
    team_hitter_agg  = _aggregate_team_hitters(all_hitter_rows, team_id)
    team_pitcher_agg = _aggregate_team_pitchers(all_pitcher_rows, team_id)

    return {
        'team': {
            'id': team['id'],
            'name': team['name'],
            'short_name': team['short_name'],
            'logo_url': team['logo_url'],
            'conference_id': team['conference_id'],
            'conference_name': team['conference_name'],
            'conference_abbrev': team['conference_abbrev'],
        },
        'season': season,
        'hitters': team_hitters,
        'pitchers': team_pitchers,
        'team_hitter_totals':  team_hitter_agg,
        'team_pitcher_totals': team_pitcher_agg,
        'cohort_size': {
            'hitters': len(all_hitter_rows),
            'pitchers': len(all_pitcher_rows),
            'hitters_qualified':  sum(1 for r in all_hitter_rows  if _hitter_qualified(r)),
            'pitchers_qualified': sum(1 for r in all_pitcher_rows if _pitcher_qualified(r)),
        },
        'thresholds': {
            'hitter_min_pa':  HITTER_MIN_PA,
            'pitcher_min_ip': PITCHER_MIN_IP,
        },
    }
