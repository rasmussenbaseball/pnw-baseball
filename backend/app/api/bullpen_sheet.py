"""
Bullpen Sheet backend.

Builds a single-page coaching report for managing a pitching staff —
two main blocks:

  1. PITCHER ROSTER TABLE
     Every pitcher on the team with their season + PBP-derived stats:
       IP, ERA, K%, BB%, Whiff%, GB%, HR/PA, BAA, Strike%, FPS%,
       Putaway%, wOBA vs LHH / vs RHH / w RISP, plus the pitch count
       from their most recent outing.

  2. SITUATIONAL LEADERBOARDS — "Who's best in X"
     Per situation, top 5 pitchers ranked by wOBA-allowed:
       home / road, vs LHH / vs RHH, bases empty / runners on,
       late & close (inning >= 7, score within 1)

Computed live from game_events + pitching_stats so a coach can rebuild
the report at any time during the season.
"""

from __future__ import annotations


# ─────────────────────────────────────────────────────────────────
# Aggregation helpers
# ─────────────────────────────────────────────────────────────────

# Default wOBA constants — D3/NAIA-ish weights, same as elsewhere.
WOBA_BB = 0.69
WOBA_HBP = 0.72
WOBA_1B = 0.88
WOBA_2B = 1.24
WOBA_3B = 1.56
WOBA_HR = 2.00


def _slash_from_counts(c):
    """Build a slash + advanced rate stat dict from pre-aggregated count
    columns (singles, doubles, triples, hr, bb, hbp, sf, k, ab, pa)."""
    pa = c.get('pa') or 0
    ab = c.get('ab') or 0
    if pa == 0:
        return {'pa': 0, 'woba': None, 'k_pct': None, 'bb_pct': None,
                'avg': None, 'iso': None}
    singles = c.get('singles') or 0
    doubles = c.get('doubles') or 0
    triples = c.get('triples') or 0
    hr = c.get('hr') or 0
    bb = c.get('bb') or 0
    hbp = c.get('hbp') or 0
    sf = c.get('sf') or 0
    k = c.get('k') or 0
    h = singles + doubles + triples + hr
    tb = singles + 2 * doubles + 3 * triples + 4 * hr
    avg = (h / ab) if ab else 0
    slg = (tb / ab) if ab else 0
    iso = slg - avg
    woba_num = (WOBA_BB * bb + WOBA_HBP * hbp + WOBA_1B * singles +
                WOBA_2B * doubles + WOBA_3B * triples + WOBA_HR * hr)
    woba_denom = ab + bb + sf + hbp
    woba = (woba_num / woba_denom) if woba_denom else 0
    return {
        'pa': pa, 'ab': ab, 'h': h, 'hr': hr, 'bb': bb, 'k': k,
        'avg': avg, 'iso': iso, 'woba': woba,
        'k_pct': (k / pa) if pa else 0,
        'bb_pct': (bb / pa) if pa else 0,
    }


# Common SQL: counts per pitcher in a given filter context.
_PA_AGG_SQL = """
    SELECT
      ge.pitcher_player_id AS pid,
      COUNT(*) AS pa,
      COUNT(*) FILTER (WHERE result_type IN
        ('single','double','triple','home_run',
         'strikeout_swinging','strikeout_looking',
         'ground_out','fly_out','line_out','pop_out',
         'fielders_choice','error','double_play','other')) AS ab,
      COUNT(*) FILTER (WHERE result_type = 'single')   AS singles,
      COUNT(*) FILTER (WHERE result_type = 'double')   AS doubles,
      COUNT(*) FILTER (WHERE result_type = 'triple')   AS triples,
      COUNT(*) FILTER (WHERE result_type = 'home_run') AS hr,
      COUNT(*) FILTER (WHERE result_type IN ('walk','intentional_walk')) AS bb,
      COUNT(*) FILTER (WHERE result_type = 'hbp') AS hbp,
      COUNT(*) FILTER (WHERE result_type = 'sac_fly') AS sf,
      COUNT(*) FILTER (WHERE result_type IN ('strikeout_swinging','strikeout_looking')) AS k,
      -- Pitch-level totals (for whiff rate / strike rate / etc.)
      SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))) AS k_pitches,
      SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))) AS s_pitches,
      SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))) AS f_pitches,
      SUM(pitches_thrown) AS pitches_total,
      COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play
    FROM game_events ge
    JOIN games g ON g.id = ge.game_id
    {extra_join}
    WHERE ge.pitcher_player_id = ANY(%s)
      AND g.season = %s
      AND ge.result_type IS NOT NULL
      {extra_where}
    GROUP BY ge.pitcher_player_id
"""


def _aggregate_pitcher_split(cur, player_ids, season, extra_where, extra_params=(),
                             extra_join=""):
    """Run _PA_AGG_SQL with a custom filter, returning {pid: {slash + pbp rates}}."""
    if not player_ids:
        return {}
    sql = _PA_AGG_SQL.format(extra_where=extra_where, extra_join=extra_join)
    cur.execute(sql, (player_ids, season, *extra_params))
    out = {}
    for r in cur.fetchall():
        slash = _slash_from_counts(r)
        # Pitch-level extras
        k_p = float(r['k_pitches'] or 0)
        s_p = float(r['s_pitches'] or 0)
        f_p = float(r['f_pitches'] or 0)
        in_play = float(r['in_play'] or 0)
        pitches_total = float(r['pitches_total'] or 0)
        swings = k_p + f_p + in_play
        strikes = k_p + s_p + f_p + in_play
        slash['whiff_pct'] = (k_p / swings) if swings else None
        slash['strike_pct'] = (strikes / pitches_total) if pitches_total else None
        out[r['pid']] = slash
    return out


# ─────────────────────────────────────────────────────────────────
# Per-pitcher: full season aggregate + key splits
# ─────────────────────────────────────────────────────────────────

def _fetch_pitcher_overall(cur, player_ids, season):
    """Pull each pitcher's full-season stats from pitching_stats + PBP-derived
    extras. Returns {pid: stats_dict}."""
    if not player_ids:
        return {}
    cur.execute(
        """
        SELECT
          ps.player_id, ps.team_id,
          p.first_name, p.last_name, p.jersey_number, p.throws, p.position,
          p.year_in_school,
          ps.innings_pitched, ps.batters_faced, ps.strikeouts, ps.walks,
          ps.hits_allowed, ps.home_runs_allowed, ps.hit_batters,
          ps.era, ps.fip, ps.siera, ps.whip,
          ps.k_pct AS ks_kpct, ps.bb_pct AS ks_bbpct
        FROM pitching_stats ps
        JOIN players p ON p.id = ps.player_id
        WHERE ps.player_id = ANY(%s) AND ps.season = %s
        """,
        (player_ids, season),
    )
    out = {}
    for r in cur.fetchall():
        bf = r['batters_faced'] or 0
        bb = r['walks'] or 0
        hbp = r['hit_batters'] or 0
        h = r['hits_allowed'] or 0
        baa_denom = bf - bb - hbp
        baa = (h / baa_denom) if baa_denom > 0 else None
        out[r['player_id']] = {
            'player_id': r['player_id'],
            'team_id': r['team_id'],
            'first_name': r['first_name'],
            'last_name': r['last_name'],
            'jersey_number': r['jersey_number'],
            'throws': r['throws'],
            'position': r['position'],
            'year_in_school': r['year_in_school'],
            'ip': float(r['innings_pitched']) if r['innings_pitched'] is not None else None,
            'bf': bf,
            'k': r['strikeouts'],
            'bb': bb,
            'h': h,
            'hr': r['home_runs_allowed'],
            'era': float(r['era']) if r['era'] is not None else None,
            'fip': float(r['fip']) if r['fip'] is not None else None,
            'siera': float(r['siera']) if r['siera'] is not None else None,
            'whip': float(r['whip']) if r['whip'] is not None else None,
            'k_pct': float(r['ks_kpct']) if r['ks_kpct'] is not None else None,
            'bb_pct': float(r['ks_bbpct']) if r['ks_bbpct'] is not None else None,
            'hr_per_pa': (r['home_runs_allowed'] / bf) if bf else None,
            'baa': baa,
        }
    return out


def _fetch_pbp_overall(cur, player_ids, season):
    """Per-pitcher whiff%/strike%/FPS%/Putaway%/GB% from game_events.
    Returns {pid: {whiff_pct, strike_pct, fps_pct, putaway_pct, gb_pct,
    hr_pa_pct, opp_woba}}."""
    if not player_ids:
        return {}
    cur.execute(
        """
        SELECT
          ge.pitcher_player_id AS pid,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))) AS k_p,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))) AS s_p,
          SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))) AS f_p,
          SUM(pitches_thrown) AS pitches_total,
          COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play,
          COUNT(*) FILTER (
            WHERE (LENGTH(pitch_sequence) > 0 AND LEFT(pitch_sequence, 1) IN ('K','S','F'))
               OR (LENGTH(pitch_sequence) = 0 AND was_in_play AND pitches_thrown = 1)
          ) AS first_pitch_strikes,
          COUNT(*) FILTER (WHERE pitches_thrown IS NOT NULL AND pitches_thrown >= 1) AS fps_pa_known,
          COUNT(*) FILTER (WHERE strikes_before >= 2) AS two_strike_pa,
          COUNT(*) FILTER (WHERE strikes_before >= 2
                           AND ge.result_type IN ('strikeout_swinging','strikeout_looking')) AS putaway_k,
          COUNT(*) FILTER (WHERE bb_type = 'GB') AS gb,
          COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
          COUNT(*) AS pa,
          COUNT(*) FILTER (WHERE result_type = 'home_run') AS hr_count,
          -- Slash counts for opp_woba
          COUNT(*) FILTER (WHERE result_type IN
            ('single','double','triple','home_run',
             'strikeout_swinging','strikeout_looking',
             'ground_out','fly_out','line_out','pop_out',
             'fielders_choice','error','double_play','other')) AS ab,
          COUNT(*) FILTER (WHERE result_type = 'single')   AS singles,
          COUNT(*) FILTER (WHERE result_type = 'double')   AS doubles,
          COUNT(*) FILTER (WHERE result_type = 'triple')   AS triples,
          COUNT(*) FILTER (WHERE result_type = 'home_run') AS hr,
          COUNT(*) FILTER (WHERE result_type IN ('walk','intentional_walk')) AS bb,
          COUNT(*) FILTER (WHERE result_type = 'hbp') AS hbp,
          COUNT(*) FILTER (WHERE result_type = 'sac_fly') AS sf
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
        k_p = float(r['k_p'] or 0)
        s_p = float(r['s_p'] or 0)
        f_p = float(r['f_p'] or 0)
        in_play = float(r['in_play'] or 0)
        pitches_total = float(r['pitches_total'] or 0)
        swings = k_p + f_p + in_play
        strikes = k_p + s_p + f_p + in_play
        bb_total = float(r['bb_total'] or 0)
        pa = float(r['pa'] or 0)
        two_strike = r['two_strike_pa'] or 0
        slash = _slash_from_counts(r)
        out[r['pid']] = {
            'whiff_pct':   (k_p / swings) if swings else None,
            'strike_pct':  (strikes / pitches_total) if pitches_total else None,
            'fps_pct':     ((r['first_pitch_strikes'] or 0) / r['fps_pa_known']) if r['fps_pa_known'] else None,
            'putaway_pct': ((r['putaway_k'] or 0) / two_strike) if two_strike else None,
            'gb_pct':      ((r['gb'] or 0) / bb_total) if bb_total else None,
            'hr_pa_pct':   ((r['hr_count'] or 0) / pa) if pa else None,
            'opp_woba':    slash['woba'],
        }
    return out


def _fetch_last_outing_pitches(cur, player_ids, season):
    """For each pitcher, find their most recent outing and its pitch count.
    Returns {pid: {last_game_date, last_game_pitches, last_game_opp_short}}."""
    if not player_ids:
        return {}
    # Aggregate pitches_thrown per (pitcher, game) and take the latest game
    # per pitcher via DISTINCT ON.
    cur.execute(
        """
        WITH per_game AS (
          SELECT
            ge.pitcher_player_id AS pid,
            g.id AS game_id,
            g.game_date,
            g.home_team_id, g.away_team_id,
            ge.defending_team_id,
            COALESCE(SUM(ge.pitches_thrown), 0) AS pitches
          FROM game_events ge
          JOIN games g ON g.id = ge.game_id
          WHERE ge.pitcher_player_id = ANY(%s)
            AND g.season = %s
          GROUP BY ge.pitcher_player_id, g.id, g.game_date,
                   g.home_team_id, g.away_team_id, ge.defending_team_id
        )
        SELECT DISTINCT ON (pid)
          pid, game_id, game_date, pitches,
          home_team_id, away_team_id, defending_team_id,
          ht.short_name AS home_short, at.short_name AS away_short
        FROM per_game pg
        JOIN teams ht ON ht.id = pg.home_team_id
        JOIN teams at ON at.id = pg.away_team_id
        ORDER BY pid, game_date DESC
        """,
        (player_ids, season),
    )
    out = {}
    for r in cur.fetchall():
        # Opponent = whichever team the pitcher's team WASN'T on
        is_home_pitching = (r['defending_team_id'] == r['home_team_id'])
        opp = r['away_short'] if is_home_pitching else r['home_short']
        out[r['pid']] = {
            'last_game_date': r['game_date'].isoformat() if r['game_date'] else None,
            'last_game_pitches': int(r['pitches']) if r['pitches'] is not None else None,
            'last_game_opp_short': opp,
        }
    return out


# ─────────────────────────────────────────────────────────────────
# Per-pitcher splits — vs LHH / vs RHH / RISP / Home / Road / etc.
# Reused both by the roster table and the situational leaderboards.
# ─────────────────────────────────────────────────────────────────

# Each split is (key, label, extra_where_sql, extra_params, extra_join_sql).
# extra_join is rare — only home/road need it (to look up game home/away
# vs the pitcher's defending team).
def _split_definitions(team_id):
    return [
        ('vs_lhh', 'vs LHH',
            "AND ge.batter_player_id IN (SELECT id FROM players WHERE UPPER(bats) = 'L')",
            (), ""),
        ('vs_rhh', 'vs RHH',
            "AND ge.batter_player_id IN (SELECT id FROM players WHERE UPPER(bats) = 'R')",
            (), ""),
        ('risp', 'w/ RISP',
            "AND bases_before IS NOT NULL AND "
            "(SUBSTRING(bases_before, 2, 1) = '1' OR SUBSTRING(bases_before, 3, 1) = '1')",
            (), ""),
        ('bases_empty', 'Bases empty',
            "AND bases_before IS NOT NULL AND bases_before = '000'",
            (), ""),
        ('runners_on', 'Runners on',
            "AND bases_before IS NOT NULL AND bases_before <> '000'",
            (), ""),
        ('home', 'Home',
            f"AND g.home_team_id = {int(team_id)} AND ge.defending_team_id = g.home_team_id",
            (), ""),
        ('road', 'Road',
            f"AND g.away_team_id = {int(team_id)} AND ge.defending_team_id = g.away_team_id",
            (), ""),
        ('late_close', 'Late & close',
            "AND inning >= 7 AND bat_score_before IS NOT NULL "
            "AND ABS(bat_score_before - fld_score_before) <= 1",
            (), ""),
    ]


def _fetch_all_splits(cur, player_ids, season, team_id):
    """Run every split aggregation in parallel and return:
    {split_key: {pid: stats_dict}}."""
    out = {}
    for key, label, where_sql, params, join_sql in _split_definitions(team_id):
        out[key] = _aggregate_pitcher_split(
            cur, player_ids, season, where_sql, params, join_sql,
        )
    return out


# ─────────────────────────────────────────────────────────────────
# Public entry point
# ─────────────────────────────────────────────────────────────────

def build_bullpen_sheet(cur, team_id, season):
    """Compose the full Bullpen Sheet payload for one team."""
    # Team meta
    cur.execute(
        """
        SELECT t.id, t.name, t.short_name, t.logo_url, t.conference_id,
               c.name AS conference_name, c.abbreviation AS conference_abbrev,
               d.level AS division_level
        FROM teams t
        LEFT JOIN conferences c ON c.id = t.conference_id
        LEFT JOIN divisions d ON d.id = c.division_id
        WHERE t.id = %s
        """,
        (team_id,),
    )
    team = cur.fetchone()
    if not team:
        return None
    team = dict(team)

    # Pitchers on this team with non-zero IP this season
    cur.execute(
        """
        SELECT ps.player_id
        FROM pitching_stats ps
        JOIN players p ON p.id = ps.player_id
        WHERE p.team_id = %s AND ps.season = %s
          AND COALESCE(ps.innings_pitched, 0) > 0
        """,
        (team_id, season),
    )
    player_ids = [r['player_id'] for r in cur.fetchall()]

    if not player_ids:
        return {
            'team': {
                'id': team['id'], 'name': team['name'], 'short_name': team['short_name'],
                'logo_url': team['logo_url'],
                'conference_abbrev': team['conference_abbrev'],
                'division_level': team['division_level'],
            },
            'season': season,
            'pitchers': [],
            'leaderboards': {},
        }

    # Overall season stats per pitcher
    overall = _fetch_pitcher_overall(cur, player_ids, season)
    pbp = _fetch_pbp_overall(cur, player_ids, season)
    last_outing = _fetch_last_outing_pitches(cur, player_ids, season)

    # All split aggregations
    splits = _fetch_all_splits(cur, player_ids, season, team_id)

    # Build per-pitcher rows
    pitchers = []
    for pid in player_ids:
        ov = overall.get(pid) or {}
        pb = pbp.get(pid) or {}
        lo = last_outing.get(pid) or {}
        # Pull per-pitcher splits for the table
        woba_vs_lhh = (splits.get('vs_lhh', {}).get(pid) or {}).get('woba')
        woba_vs_rhh = (splits.get('vs_rhh', {}).get(pid) or {}).get('woba')
        woba_risp = (splits.get('risp', {}).get(pid) or {}).get('woba')
        pa_vs_lhh = (splits.get('vs_lhh', {}).get(pid) or {}).get('pa') or 0
        pa_vs_rhh = (splits.get('vs_rhh', {}).get(pid) or {}).get('pa') or 0
        pa_risp = (splits.get('risp', {}).get(pid) or {}).get('pa') or 0

        pitchers.append({
            **ov,
            **pb,
            **lo,
            'woba_vs_lhh': woba_vs_lhh,
            'woba_vs_rhh': woba_vs_rhh,
            'woba_risp': woba_risp,
            'pa_vs_lhh': pa_vs_lhh,
            'pa_vs_rhh': pa_vs_rhh,
            'pa_risp': pa_risp,
        })

    # Sort the roster by IP descending — workhorses up top
    pitchers.sort(key=lambda r: r.get('ip') or 0, reverse=True)

    # Build leaderboards: top 5 per situation by lowest opp_woba.
    # Min PA so a 1-PA outlier doesn't claim #1. We use a higher
    # threshold (15) for most splits to keep the leaderboards
    # meaningful, but vs LHH gets a softer 5 PA floor — most college
    # bullpens see way more righties than lefties, and a strict 15
    # would empty the vs-LHH card on most teams.
    MIN_PA_DEFAULT = 15
    MIN_PA_VS_LHH = 5
    # Most leaderboards show top 5; the L/R-handed splits get 10
    # because identifying the deeper bullpen options for matchup-based
    # decisions matters more than a pick-3-over-the-others podium.
    LIMIT_DEFAULT = 5
    LIMIT_VS_HAND = 10
    leaderboards = {}
    name_lookup = {p['player_id']: p for p in pitchers}
    for split_key in ['home', 'road', 'vs_lhh', 'vs_rhh',
                      'bases_empty', 'runners_on', 'late_close']:
        rows = []
        split_data = splits.get(split_key, {})
        min_pa = MIN_PA_VS_LHH if split_key == 'vs_lhh' else MIN_PA_DEFAULT
        limit = LIMIT_VS_HAND if split_key in ('vs_lhh', 'vs_rhh') else LIMIT_DEFAULT
        for pid, stats in split_data.items():
            if (stats.get('pa') or 0) < min_pa:
                continue
            if stats.get('woba') is None:
                continue
            base = name_lookup.get(pid)
            if not base:
                continue
            rows.append({
                'player_id': pid,
                'first_name': base.get('first_name'),
                'last_name': base.get('last_name'),
                'jersey_number': base.get('jersey_number'),
                'throws': base.get('throws'),
                'pa': stats.get('pa') or 0,
                'woba': stats.get('woba'),
                'k_pct': stats.get('k_pct'),
                'bb_pct': stats.get('bb_pct'),
                'whiff_pct': stats.get('whiff_pct'),
                'strike_pct': stats.get('strike_pct'),
            })
        # Sort ascending by wOBA — best at suppressing offense first.
        rows.sort(key=lambda r: r['woba'])
        leaderboards[split_key] = rows[:limit]

    return {
        'team': {
            'id': team['id'],
            'name': team['name'],
            'short_name': team['short_name'],
            'logo_url': team['logo_url'],
            'conference_abbrev': team['conference_abbrev'],
            'division_level': team['division_level'],
        },
        'season': season,
        'pitchers': pitchers,
        'leaderboards': leaderboards,
        'thresholds': {
            'min_pa_default': MIN_PA_DEFAULT,
            'min_pa_vs_lhh': MIN_PA_VS_LHH,
        },
    }
