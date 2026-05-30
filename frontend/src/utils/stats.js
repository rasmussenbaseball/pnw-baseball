/**
 * Stat display configuration.
 * Defines how each stat column is labeled, formatted, and described.
 */

export const BATTING_COLUMNS = [
  { key: 'rank', label: '#', width: 40, sortable: false },
  { key: 'name', label: 'Player', width: 160, sortable: false,
    render: (row) => `${row.first_name} ${row.last_name}` },
  { key: 'team_short', label: 'Team', width: 80, sortable: false },
  { key: 'year_in_school', label: 'Yr', width: 40, sortable: false },
  { key: 'position', label: 'Pos', width: 50, sortable: false },
  { key: 'division_level', label: 'Lvl', width: 50, sortable: false },

  // Counting stats
  { key: 'games', label: 'G', width: 40, format: 'int' },
  { key: 'plate_appearances', label: 'PA', width: 45, format: 'int' },
  { key: 'at_bats', label: 'AB', width: 45, format: 'int' },
  { key: 'hits', label: 'H', width: 40, format: 'int' },
  { key: 'doubles', label: '2B', width: 40, format: 'int' },
  { key: 'triples', label: '3B', width: 40, format: 'int' },
  { key: 'home_runs', label: 'HR', width: 40, format: 'int' },
  { key: 'runs', label: 'R', width: 40, format: 'int' },
  { key: 'rbi', label: 'RBI', width: 45, format: 'int' },
  { key: 'walks', label: 'BB', width: 40, format: 'int' },
  { key: 'strikeouts', label: 'K', width: 40, format: 'int' },
  { key: 'stolen_bases', label: 'SB', width: 40, format: 'int' },

  // Traditional rates
  { key: 'batting_avg', label: 'AVG', width: 55, format: 'avg',
    tooltip: 'Batting Average = H/AB' },
  { key: 'on_base_pct', label: 'OBP', width: 55, format: 'avg',
    tooltip: 'On-Base Percentage' },
  { key: 'slugging_pct', label: 'SLG', width: 55, format: 'avg',
    tooltip: 'Slugging Percentage = TB/AB' },
  { key: 'ops', label: 'OPS', width: 55, format: 'avg',
    tooltip: 'On-base Plus Slugging' },

  // Advanced
  { key: 'woba', label: 'wOBA', width: 55, format: 'avg',
    tooltip: 'Weighted On-Base Average: weights each way of reaching base by its run value' },
  { key: 'wobacon', label: 'wOBACON', width: 65, format: 'avg',
    tooltip: 'wOBA on Contact: hitting quality on balls in play, excludes strikeouts and walks' },
  { key: 'wrc_plus', label: 'wRC+', width: 55, format: 'int',
    tooltip: 'Weighted Runs Created Plus: 100 = league average, adjusts for park and league' },
  { key: 'iso', label: 'ISO', width: 55, format: 'avg',
    tooltip: 'Isolated Power = SLG - AVG, measures raw power' },
  { key: 'babip', label: 'BABIP', width: 55, format: 'avg',
    tooltip: 'Batting Avg on Balls In Play: helps identify luck vs. skill' },
  { key: 'bb_pct', label: 'BB%', width: 55, format: 'pct',
    tooltip: 'Walk Rate = BB/PA' },
  { key: 'k_pct', label: 'K%', width: 55, format: 'pct',
    tooltip: 'Strikeout Rate = K/PA' },
  { key: 'offensive_war', label: 'oWAR', width: 55, format: 'war',
    tooltip: 'Offensive Wins Above Replacement' },
]

export const PITCHING_COLUMNS = [
  { key: 'rank', label: '#', width: 40, sortable: false },
  { key: 'name', label: 'Player', width: 160, sortable: false,
    render: (row) => `${row.first_name} ${row.last_name}` },
  { key: 'team_short', label: 'Team', width: 80, sortable: false },
  { key: 'year_in_school', label: 'Yr', width: 40, sortable: false },
  { key: 'division_level', label: 'Lvl', width: 50, sortable: false },

  // Traditional
  { key: 'wins', label: 'W', width: 35, format: 'int' },
  { key: 'losses', label: 'L', width: 35, format: 'int' },
  { key: 'saves', label: 'SV', width: 35, format: 'int' },
  { key: 'games', label: 'G', width: 35, format: 'int' },
  { key: 'games_started', label: 'GS', width: 35, format: 'int' },
  { key: 'quality_starts', label: 'QS', width: 35, format: 'int',
    tooltip: 'Quality Starts: 6+ IP and 3 or fewer ER' },
  { key: 'innings_pitched', label: 'IP', width: 50, format: 'ip' },
  { key: 'strikeouts', label: 'K', width: 40, format: 'int' },
  { key: 'walks', label: 'BB', width: 40, format: 'int' },
  { key: 'hits_allowed', label: 'H', width: 40, format: 'int' },
  { key: 'home_runs_allowed', label: 'HR', width: 40, format: 'int' },
  { key: 'earned_runs', label: 'ER', width: 40, format: 'int' },

  // Rate stats
  { key: 'era', label: 'ERA', width: 55, format: 'era',
    tooltip: 'Earned Run Average = (ER/IP) * 9' },
  { key: 'whip', label: 'WHIP', width: 55, format: 'era',
    tooltip: 'Walks + Hits per Innings Pitched' },
  { key: 'baa', label: 'BAA', width: 55, format: 'avg',
    tooltip: 'Batting Average Against = H / (BF - BB - HBP). Lower is better.' },
  { key: 'k_pct', label: 'K%', width: 55, format: 'pct',
    tooltip: 'Strikeout Rate = K/BF' },
  { key: 'bb_pct', label: 'BB%', width: 55, format: 'pct',
    tooltip: 'Walk Rate = BB/BF' },
  { key: 'k_bb_pct', label: 'K-BB%', width: 55, format: 'pct',
    tooltip: 'Strikeout minus Walk Rate: measures command advantage' },
  { key: 'k_bb_ratio', label: 'K/BB', width: 55, format: 'era',
    tooltip: 'Strikeout to Walk ratio' },

  // Advanced
  { key: 'fip', label: 'FIP', width: 55, format: 'era',
    tooltip: 'Fielding Independent Pitching: estimates ERA from K, BB, HBP, HR' },
  { key: 'fip_plus', label: 'FIP+', width: 55, format: 'int',
    tooltip: 'FIP+: 100 = league average, higher is better. League-adjusted for cross-division comparison' },
  { key: 'era_plus', label: 'ERA+', width: 55, format: 'int',
    tooltip: 'ERA+: 100 = league average, higher is better. League-adjusted for cross-division comparison' },
  { key: 'xfip', label: 'xFIP', width: 55, format: 'era',
    tooltip: 'Expected FIP: normalizes HR/FB ratio to league average' },
  { key: 'siera', label: 'SIERA', width: 55, format: 'era',
    tooltip: 'Skill-Interactive ERA: accounts for how K and BB interact' },
  { key: 'babip_against', label: 'BABIP', width: 55, format: 'avg',
    tooltip: 'BABIP Against: helps identify luck in hits allowed' },
  { key: 'lob_pct', label: 'LOB%', width: 55, format: 'pct',
    tooltip: 'Left On Base %: how often runners are stranded' },
  { key: 'pitching_war', label: 'WAR', width: 55, format: 'war',
    tooltip: 'Pitching Wins Above Replacement' },
]

/**
 * Format a stat value for display.
 */
export function formatStat(value, format) {
  if (value === null || value === undefined) return '-'

  switch (format) {
    case 'avg':
      // Show as .XXX (no leading zero)
      return value >= 1
        ? value.toFixed(3)
        : value.toFixed(3).replace('0.', '.')
    case 'era':
      return value.toFixed(2)
    case 'pct':
      return (value * 100).toFixed(1) + '%'
    case 'pctRaw':
      // Value already in percentage form (e.g. 12.5 means 12.5%)
      return value.toFixed(1) + '%'
    case 'war':
      return value.toFixed(1)
    case 'ip':
      // Innings pitched: integer part + .1/.2 for partial innings
      return value.toFixed(1)
    case 'int':
      return Math.round(value).toString()
    case 'wpa':
      // Signed decimal with 2 places, always show the sign so positive
      // and negative WPA totals are immediately distinguishable.
      return (value >= 0 ? '+' : '') + value.toFixed(2)
    default:
      return String(value)
  }
}

/**
 * Division level color classes.
 */
export function divisionBadgeClass(level) {
  const map = {
    'D1': 'badge-d1',
    'D2': 'badge-d2',
    'D3': 'badge-d3',
    'NAIA': 'badge-naia',
    'JUCO': 'badge-juco',
  }
  return map[level] || 'bg-gray-500 text-white'
}

/**
 * Stat category presets for quick filter buttons.
 */
export const BATTING_PRESETS = {
  'Standard': ['games', 'plate_appearances', 'at_bats', 'hits', 'doubles', 'triples', 'home_runs', 'runs', 'rbi', 'walks', 'strikeouts', 'stolen_bases', 'batting_avg', 'on_base_pct', 'slugging_pct', 'ops'],
  'Advanced': ['plate_appearances', 'batting_avg', 'on_base_pct', 'slugging_pct', 'woba', 'wobacon', 'wrc_plus', 'iso', 'babip', 'bb_pct', 'k_pct', 'offensive_war'],
  'Power': ['plate_appearances', 'home_runs', 'doubles', 'triples', 'slugging_pct', 'iso', 'wobacon', 'rbi'],
  'Discipline': ['plate_appearances', 'walks', 'strikeouts', 'bb_pct', 'k_pct', 'on_base_pct', 'woba'],
  'Speed': ['games', 'stolen_bases', 'caught_stealing', 'triples', 'batting_avg'],
}

export const PITCHING_PRESETS = {
  'Standard': ['wins', 'losses', 'saves', 'games', 'games_started', 'quality_starts', 'innings_pitched', 'strikeouts', 'walks', 'hits_allowed', 'earned_runs', 'era', 'whip', 'baa'],
  'Advanced': ['innings_pitched', 'quality_starts', 'era', 'era_plus', 'fip', 'fip_plus', 'xfip', 'siera', 'k_pct', 'bb_pct', 'k_bb_pct', 'babip_against', 'baa', 'lob_pct', 'pitching_war'],
  'Strikeouts': ['innings_pitched', 'strikeouts', 'k_pct', 'bb_pct', 'k_bb_pct', 'k_bb_ratio', 'walks'],
  // 'Relievers' view retired — see the dedicated /relievers leaderboard
  // (Goose Eggs + reliever WPA) instead.
}

// Presets that apply special backend filters. (Relievers view was retired
// in favor of the dedicated /relievers page.)
export const PITCHING_PRESET_FILTERS = {}


// ============================================================
// FIELDING LEADERBOARD
// ============================================================
//
// Rows come from /api/v1/leaderboards/fielding with these keys:
//   games, games_started, innings, putouts, assists, errors,
//   double_plays, triple_plays, total_chances, fielding_pct,
//   range_factor, passed_balls, stolen_bases_against,
//   caught_stealing_by, cs_pct, pickoffs, position
// plus the usual player + team meta (first_name, last_name,
// team_short, team_id, logo_url, division_level, etc).

export const FIELDING_COLUMNS = [
  { key: 'rank', label: '#', width: 40, sortable: false },
  { key: 'name', label: 'Player', width: 160, sortable: false,
    render: (row) => `${row.first_name} ${row.last_name}` },
  { key: 'team_short', label: 'Team', width: 90, sortable: false },
  { key: 'position', label: 'Pos', width: 50, sortable: false,
    render: (row) => row.position === 'ALL' ? '—' : row.position },
  { key: 'division_level', label: 'Lvl', width: 55, sortable: false },

  { key: 'games', label: 'G', width: 40, format: 'int' },
  { key: 'games_started', label: 'GS', width: 40, format: 'int' },
  { key: 'innings', label: 'INN', width: 55, format: 'era',
    tooltip: 'Innings on defense. Only available from D1 box scores.' },
  { key: 'putouts', label: 'PO', width: 45, format: 'int' },
  { key: 'assists', label: 'A', width: 45, format: 'int' },
  { key: 'errors', label: 'E', width: 45, format: 'int' },
  { key: 'double_plays', label: 'DP', width: 45, format: 'int' },
  { key: 'total_chances', label: 'TC', width: 50, format: 'int',
    tooltip: 'Total Chances = PO + A + E' },
  { key: 'fielding_pct', label: 'FLD%', width: 65, format: 'avg',
    tooltip: '(PO + A) / TC. Higher is better.' },
  { key: 'range_factor', label: 'RF/9', width: 60, format: 'era',
    tooltip: 'Range Factor per 9 innings = (PO + A) / IP * 9' },

  // Catcher-only — the FieldingTable on player pages renders an
  // em-dash when these are 0 for non-catchers; we do the same in
  // the leaderboard with a custom renderer.
  { key: 'passed_balls', label: 'PB', width: 45, format: 'int',
    render: (row) => row.passed_balls > 0 ? row.passed_balls : '—',
    tooltip: 'Passed Balls (catcher only)' },
  { key: 'stolen_bases_against', label: 'SBA', width: 50, format: 'int',
    render: (row) => row.stolen_bases_against > 0 ? row.stolen_bases_against : '—',
    tooltip: 'Stolen Bases Against (catcher only)' },
  { key: 'caught_stealing_by', label: 'CS', width: 45, format: 'int',
    render: (row) => row.caught_stealing_by > 0 ? row.caught_stealing_by : '—',
    tooltip: 'Runners Caught Stealing (catcher only)' },
  { key: 'cs_pct', label: 'CS%', width: 60, format: 'avg',
    render: (row) => row.cs_pct != null && row.cs_pct > 0
      ? (row.cs_pct >= 1 ? row.cs_pct.toFixed(3) : row.cs_pct.toFixed(3).replace('0.', '.'))
      : '—',
    tooltip: 'CS / (CS + SBA). Higher is better.' },
]

// Position selector options used by the page's pill bar.
export const FIELDING_POSITIONS = [
  { value: '',   label: 'Any' },
  { value: 'P',  label: 'P' },
  { value: 'C',  label: 'C' },
  { value: '1B', label: '1B' },
  { value: '2B', label: '2B' },
  { value: '3B', label: '3B' },
  { value: 'SS', label: 'SS' },
  { value: 'LF', label: 'LF' },
  { value: 'CF', label: 'CF' },
  { value: 'RF', label: 'RF' },
]

export const FIELDING_PRESETS = {
  'Standard': ['games', 'games_started', 'putouts', 'assists', 'errors', 'double_plays', 'total_chances', 'fielding_pct'],
  'Catcher':  ['games', 'putouts', 'assists', 'errors', 'fielding_pct', 'passed_balls', 'stolen_bases_against', 'caught_stealing_by', 'cs_pct'],
}

// ============================================================
// Reliever Columns (Goose Eggs + reliever WPA, from game_events)
// ============================================================
// Row shape comes from /api/v1/leaderboards/relievers. All relief-only,
// derived from play-by-play. GEG/BRK/OPP/Goose% are the clutch story;
// WPA is the headline value stat.
export const RELIEVER_COLUMNS = [
  { key: 'rank', label: '#', width: 40, sortable: false },
  { key: 'name', label: 'Player', width: 160, sortable: false,
    render: (row) => `${row.first_name} ${row.last_name}` },
  { key: 'team_short', label: 'Team', width: 90, sortable: false },
  { key: 'year_in_school', label: 'Yr', width: 40, sortable: false },
  { key: 'division_level', label: 'Lvl', width: 50, sortable: false },

  { key: 'app', label: 'App', width: 50, format: 'int', tooltip: 'Relief appearances' },
  { key: 'ip', label: 'IP', width: 55,
    render: (row) => { const o = row.outs || 0; return `${Math.floor(o / 3)}.${o % 3}` },
    tooltip: 'Relief innings pitched (outs / 3)' },
  { key: 'bf', label: 'BF', width: 50, format: 'int', tooltip: 'Batters faced in relief' },
  { key: 'k_pct', label: 'K%', width: 60, format: 'pct', tooltip: 'Strikeouts / batters faced' },
  { key: 'bb_pct', label: 'BB%', width: 60, format: 'pct', tooltip: 'Walks / batters faced (lower is better)' },
  { key: 'ra9', label: 'RA9', width: 60, format: 'era',
    tooltip: 'Runs allowed per 9 relief innings (from play-by-play; not earned-run adjusted)' },
  { key: 'whip', label: 'WHIP', width: 65, format: 'era', tooltip: '(Hits + Walks) / IP' },
  { key: 'wpa', label: 'WPA', width: 70,
    render: (row) => row.wpa == null ? '—' : `${row.wpa >= 0 ? '+' : ''}${Number(row.wpa).toFixed(2)}`,
    tooltip: 'Win Probability Added in relief. Sum of the win-prob swing on every play while pitching. Higher is better.' },

  { key: 'geg', label: 'GEG', width: 55, format: 'int',
    tooltip: 'Goose Eggs — clean high-leverage relief innings (7th+, team not trailing, lead <= 3 or tying run on base/at bat, no runs allowed).' },
  { key: 'brk', label: 'BRK', width: 55, format: 'int',
    tooltip: 'Broken Eggs — goose-window innings where a run scored (lower is better).' },
  { key: 'opp', label: 'OPP', width: 55, format: 'int',
    tooltip: 'Goose opportunities — high-leverage innings entered.' },
  { key: 'goose_pct', label: 'Goose%', width: 70, format: 'pct',
    tooltip: 'GEG / (GEG + BRK). How often he hangs the zero in a goose window.' },
]

export const RELIEVER_PRESETS = {
  'Clutch': ['app', 'ip', 'wpa', 'geg', 'brk', 'opp', 'goose_pct'],
  'Rates':  ['app', 'ip', 'bf', 'k_pct', 'bb_pct', 'ra9', 'whip', 'wpa'],
}

// ============================================================
// PBP (Plate Discipline / Pitch-Level) Columns
// ============================================================
//
// These power the "PBP" preset on the Hitting and Pitching
// leaderboards. The row shape comes from
//   /api/v1/leaderboards/batting-pbp
//   /api/v1/leaderboards/pitching-pbp
// and is intentionally NOT a superset of the normal batting/pitching
// rows — fewer columns, all derived from game_events aggregates.

export const BATTING_PBP_COLUMNS = [
  { key: 'rank', label: '#', width: 40, sortable: false },
  { key: 'name', label: 'Player', width: 160, sortable: false,
    render: (row) => `${row.first_name} ${row.last_name}` },
  { key: 'team_short', label: 'Team', width: 80, sortable: false },
  { key: 'year_in_school', label: 'Yr', width: 40, sortable: false },
  { key: 'position', label: 'Pos', width: 50, sortable: false },
  { key: 'division_level', label: 'Lvl', width: 50, sortable: false },

  // Sample-size columns
  { key: 'tracked_pa', label: 'PA', width: 50, format: 'int',
    title: 'Tracked plate appearances (PAs we have a pitch sequence for)' },
  { key: 'pitches', label: 'Pit', width: 55, format: 'int',
    title: 'Total pitches seen across tracked PAs' },

  // Plate discipline
  { key: 'swing_pct', label: 'Swing%', width: 70, format: 'pct',
    title: 'Swing% — swings divided by pitches seen' },
  { key: 'whiff_pct', label: 'Whiff%', width: 70, format: 'pct',
    title: 'Whiff% — swinging strikes divided by total swings (lower is better)' },
  { key: 'contact_pct', label: 'Contact%', width: 80, format: 'pct',
    title: 'Contact% — fouls + balls in play, divided by total swings' },

  // Batted-ball mix (subset of in-play BIPs with known type/zone)
  { key: 'fb_pct', label: 'FB%', width: 65, format: 'pct',
    title: 'Fly-Ball% — share of balls in play classified as fly balls' },
  { key: 'air_pull_pct', label: 'AirPull%', width: 80, format: 'pct',
    title: 'Air-Pull% — LD or FB pulled to the batter\'s pull side, divided by all batted balls (handedness known)' },

  // Two-strike survival
  { key: 'putaway_pct', label: 'PA-K%', width: 70, format: 'pct',
    title: 'Putaway% — 2-strike PAs that ended in a strikeout (lower is better for the hitter)' },

  // Efficiency
  { key: 'pitches_per_pa', label: 'P/PA', width: 60, format: 'era',
    title: 'Pitches per plate appearance' },
]

export const PITCHING_PBP_COLUMNS = [
  { key: 'rank', label: '#', width: 40, sortable: false },
  { key: 'name', label: 'Player', width: 160, sortable: false,
    render: (row) => `${row.first_name} ${row.last_name}` },
  { key: 'team_short', label: 'Team', width: 80, sortable: false },
  { key: 'year_in_school', label: 'Yr', width: 40, sortable: false },
  { key: 'division_level', label: 'Lvl', width: 50, sortable: false },

  // Sample-size columns (BF = batters faced for pitchers)
  { key: 'tracked_pa', label: 'BF', width: 50, format: 'int',
    title: 'Tracked batters faced (BFs we have a pitch sequence for)' },
  { key: 'pitches', label: 'Pit', width: 55, format: 'int',
    title: 'Total pitches thrown across tracked BFs' },

  // Strike-throwing
  { key: 'strike_pct', label: 'Str%', width: 70, format: 'pct',
    title: 'Strike% — every called/swinging/foul/in-play pitch divided by total pitches' },
  { key: 'first_pitch_strike_pct', label: 'F-Str%', width: 75, format: 'pct',
    title: 'First-Pitch Strike% — share of BFs that started 0-1' },
  { key: 'called_strike_pct', label: 'CSt%', width: 65, format: 'pct',
    title: 'Called-Strike% — called strikes divided by total pitches' },

  // Swing-and-miss
  { key: 'whiff_pct', label: 'Whiff%', width: 70, format: 'pct',
    title: 'Whiff% — swinging strikes divided by total swings against' },
  { key: 'contact_pct', label: 'Contact%', width: 80, format: 'pct',
    title: 'Contact% — fouls + balls in play, divided by total swings (lower is better)' },

  // Batted-ball mix allowed
  { key: 'gb_pct', label: 'GB%', width: 65, format: 'pct',
    title: 'Ground-Ball% — share of balls in play (with known type) classified as ground balls' },

  // Two-strike + efficiency
  { key: 'putaway_pct', label: 'Putaway%', width: 80, format: 'pct',
    title: 'Putaway% — 2-strike BFs that ended in a strikeout' },
  { key: 'on_or_out_3_pct', label: 'OO3%', width: 65, format: 'pct',
    title: 'On-or-Out-in-3% — share of BFs that ended in 1-3 pitches via hit-or-out' },
  { key: 'pitches_per_pa', label: 'P/BF', width: 60, format: 'era',
    title: 'Pitches per batter faced' },
]

export const BATTING_PBP_PRESETS = {
  'PBP': BATTING_PBP_COLUMNS.filter(c => c.sortable !== false).map(c => c.key),
}

export const PITCHING_PBP_PRESETS = {
  'PBP': PITCHING_PBP_COLUMNS.filter(c => c.sortable !== false).map(c => c.key),
}

// ============================================================
// Team Stats Columns & Presets
// ============================================================

export const TEAM_BATTING_COLUMNS = [
  { key: 'rank', label: '#', width: 40, sortable: false },
  { key: 'team_name', label: 'Team', width: 140, sortable: false },
  { key: 'division_level', label: 'Lvl', width: 50, sortable: false },
  { key: 'record', label: 'W-L', width: 60, sortable: false },

  // Counting
  { key: 'pa', label: 'PA', width: 45, format: 'int' },
  { key: 'ab', label: 'AB', width: 45, format: 'int' },
  { key: 'r', label: 'R', width: 40, format: 'int' },
  { key: 'h', label: 'H', width: 40, format: 'int' },
  { key: '2b', label: '2B', width: 40, format: 'int' },
  { key: '3b', label: '3B', width: 40, format: 'int' },
  { key: 'hr', label: 'HR', width: 40, format: 'int' },
  { key: 'rbi', label: 'RBI', width: 45, format: 'int' },
  { key: 'bb', label: 'BB', width: 40, format: 'int' },
  { key: 'so', label: 'K', width: 40, format: 'int' },
  { key: 'hbp', label: 'HBP', width: 40, format: 'int' },
  { key: 'sb', label: 'SB', width: 40, format: 'int' },
  { key: 'cs', label: 'CS', width: 40, format: 'int' },
  { key: 'gdp', label: 'GDP', width: 40, format: 'int' },
  { key: 'sf', label: 'SF', width: 40, format: 'int' },
  { key: 'sh', label: 'SH', width: 40, format: 'int' },

  // Rate
  { key: 'avg', label: 'AVG', width: 55, format: 'avg', tooltip: 'Team Batting Average' },
  { key: 'obp', label: 'OBP', width: 55, format: 'avg', tooltip: 'Team On-Base Percentage' },
  { key: 'slg', label: 'SLG', width: 55, format: 'avg', tooltip: 'Team Slugging Percentage' },
  { key: 'ops', label: 'OPS', width: 55, format: 'avg', tooltip: 'Team OPS' },
  { key: 'iso', label: 'ISO', width: 55, format: 'avg', tooltip: 'Team Isolated Power' },
  { key: 'babip', label: 'BABIP', width: 55, format: 'avg', tooltip: 'Team BABIP' },
  { key: 'bb_pct', label: 'BB%', width: 55, format: 'pctRaw', tooltip: 'Team Walk Rate' },
  { key: 'k_pct', label: 'K%', width: 55, format: 'pctRaw', tooltip: 'Team Strikeout Rate' },

  // Advanced
  { key: 'wrc_plus', label: 'wRC+', width: 55, format: 'int', tooltip: 'PA-weighted team wRC+' },
  { key: 'woba', label: 'wOBA', width: 55, format: 'avg', tooltip: 'PA-weighted team wOBA' },
  { key: 'wraa', label: 'wRAA', width: 55, format: 'war', tooltip: 'Team Weighted Runs Above Average' },
  { key: 'wrc', label: 'wRC', width: 55, format: 'war', tooltip: 'Team Weighted Runs Created' },
  { key: 'owar', label: 'oWAR', width: 55, format: 'war', tooltip: 'Team Offensive WAR' },
]

export const TEAM_PITCHING_COLUMNS = [
  { key: 'rank', label: '#', width: 40, sortable: false },
  { key: 'team_name', label: 'Team', width: 140, sortable: false },
  { key: 'division_level', label: 'Lvl', width: 50, sortable: false },
  { key: 'record', label: 'W-L', width: 60, sortable: false },

  // Counting
  { key: 'ip', label: 'IP', width: 50, format: 'ip' },
  { key: 'w', label: 'W', width: 35, format: 'int' },
  { key: 'l', label: 'L', width: 35, format: 'int' },
  { key: 'sv', label: 'SV', width: 35, format: 'int' },
  { key: 'g', label: 'G', width: 35, format: 'int' },
  { key: 'gs', label: 'GS', width: 35, format: 'int' },
  { key: 'cg', label: 'CG', width: 35, format: 'int' },
  { key: 'sho', label: 'SHO', width: 40, format: 'int' },
  { key: 'h', label: 'H', width: 40, format: 'int' },
  { key: 'r', label: 'R', width: 40, format: 'int' },
  { key: 'er', label: 'ER', width: 40, format: 'int' },
  { key: 'bb', label: 'BB', width: 40, format: 'int' },
  { key: 'so', label: 'K', width: 40, format: 'int' },
  { key: 'hr', label: 'HR', width: 40, format: 'int' },
  { key: 'hbp', label: 'HBP', width: 40, format: 'int' },
  { key: 'wp', label: 'WP', width: 40, format: 'int' },
  { key: 'bf', label: 'BF', width: 45, format: 'int' },

  // Rate
  { key: 'era', label: 'ERA', width: 55, format: 'era', tooltip: 'Team ERA' },
  { key: 'whip', label: 'WHIP', width: 55, format: 'era', tooltip: 'Team WHIP' },
  { key: 'k_per_9', label: 'K/9', width: 55, format: 'era', tooltip: 'Strikeouts per 9 innings' },
  { key: 'bb_per_9', label: 'BB/9', width: 55, format: 'era', tooltip: 'Walks per 9 innings' },
  { key: 'h_per_9', label: 'H/9', width: 55, format: 'era', tooltip: 'Hits per 9 innings' },
  { key: 'hr_per_9', label: 'HR/9', width: 55, format: 'era', tooltip: 'Home Runs per 9 innings' },
  { key: 'k_bb', label: 'K/BB', width: 55, format: 'era', tooltip: 'Strikeout to Walk ratio' },
  { key: 'k_pct', label: 'K%', width: 55, format: 'pctRaw', tooltip: 'Strikeout Rate' },
  { key: 'bb_pct', label: 'BB%', width: 55, format: 'pctRaw', tooltip: 'Walk Rate' },
  { key: 'opp_avg', label: 'OPP AVG', width: 65, format: 'avg', tooltip: 'Opponent Batting Average' },

  // Advanced
  { key: 'fip', label: 'FIP', width: 55, format: 'era', tooltip: 'IP-weighted team FIP' },
  { key: 'xfip', label: 'xFIP', width: 55, format: 'era', tooltip: 'IP-weighted team xFIP' },
  { key: 'siera', label: 'SIERA', width: 55, format: 'era', tooltip: 'IP-weighted team SIERA' },
  { key: 'babip', label: 'BABIP', width: 60, format: 'avg', tooltip: 'Team BABIP Against' },
  { key: 'pwar', label: 'WAR', width: 55, format: 'war', tooltip: 'Team Pitching WAR' },
]

export const TEAM_BATTING_PRESETS = {
  'Standard': ['pa', 'r', 'h', '2b', '3b', 'hr', 'rbi', 'bb', 'so', 'sb', 'avg', 'obp', 'slg', 'ops'],
  'Advanced': ['pa', 'avg', 'obp', 'slg', 'ops', 'woba', 'wrc_plus', 'iso', 'babip', 'bb_pct', 'k_pct', 'owar'],
  'Counting': ['pa', 'ab', 'r', 'h', '2b', '3b', 'hr', 'rbi', 'bb', 'so', 'hbp', 'sb', 'cs', 'gdp', 'sf', 'sh'],
}

export const TEAM_PITCHING_PRESETS = {
  'Standard': ['ip', 'w', 'l', 'sv', 'so', 'bb', 'h', 'er', 'hr', 'era', 'whip', 'opp_avg'],
  'Advanced': ['ip', 'era', 'fip', 'xfip', 'siera', 'whip', 'k_pct', 'bb_pct', 'k_bb', 'babip', 'opp_avg', 'pwar'],
  'Counting': ['ip', 'g', 'gs', 'w', 'l', 'sv', 'cg', 'sho', 'h', 'r', 'er', 'bb', 'so', 'hr', 'hbp', 'wp', 'bf'],
}

// ============================================================
// Summer League Stats
// ============================================================

export const SUMMER_BATTING_COLUMNS = [
  { key: 'rank', label: '#', width: 40, sortable: false },
  { key: 'name', label: 'Player', width: 160, sortable: false, linkKey: 'spring_player_id',
    render: (row) => `${row.first_name} ${row.last_name}` },
  { key: 'team_short', label: 'Team', width: 100, sortable: false, noLink: true },
  { key: 'league_abbrev', label: 'League', width: 55, sortable: false },

  // Counting stats
  { key: 'games', label: 'G', width: 40, format: 'int' },
  { key: 'plate_appearances', label: 'PA', width: 45, format: 'int' },
  { key: 'at_bats', label: 'AB', width: 45, format: 'int' },
  { key: 'hits', label: 'H', width: 40, format: 'int' },
  { key: 'doubles', label: '2B', width: 40, format: 'int' },
  { key: 'triples', label: '3B', width: 40, format: 'int' },
  { key: 'home_runs', label: 'HR', width: 40, format: 'int' },
  { key: 'runs', label: 'R', width: 40, format: 'int' },
  { key: 'rbi', label: 'RBI', width: 45, format: 'int' },
  { key: 'walks', label: 'BB', width: 40, format: 'int' },
  { key: 'strikeouts', label: 'K', width: 40, format: 'int' },
  { key: 'stolen_bases', label: 'SB', width: 40, format: 'int' },

  // Rates
  { key: 'batting_avg', label: 'AVG', width: 55, format: 'avg' },
  { key: 'on_base_pct', label: 'OBP', width: 55, format: 'avg' },
  { key: 'slugging_pct', label: 'SLG', width: 55, format: 'avg' },
  { key: 'ops', label: 'OPS', width: 55, format: 'avg' },

  // Advanced
  { key: 'woba', label: 'wOBA', width: 55, format: 'avg' },
  { key: 'wrc_plus', label: 'wRC+', width: 55, format: 'int' },
  { key: 'iso', label: 'ISO', width: 55, format: 'avg' },
  { key: 'babip', label: 'BABIP', width: 55, format: 'avg' },
  { key: 'bb_pct', label: 'BB%', width: 55, format: 'pct' },
  { key: 'k_pct', label: 'K%', width: 55, format: 'pct' },
  { key: 'offensive_war', label: 'oWAR', width: 55, format: 'era' },
]

export const SUMMER_BATTING_PRESETS = {
  'Standard': ['games', 'plate_appearances', 'at_bats', 'hits', 'doubles', 'triples', 'home_runs', 'runs', 'rbi', 'walks', 'strikeouts', 'stolen_bases', 'batting_avg', 'on_base_pct', 'slugging_pct', 'ops'],
  'Advanced': ['plate_appearances', 'batting_avg', 'on_base_pct', 'slugging_pct', 'woba', 'wrc_plus', 'iso', 'babip', 'bb_pct', 'k_pct', 'offensive_war'],
  'Power': ['plate_appearances', 'home_runs', 'doubles', 'triples', 'slugging_pct', 'iso', 'rbi'],
  'Discipline': ['plate_appearances', 'walks', 'strikeouts', 'bb_pct', 'k_pct', 'on_base_pct'],
  'Speed': ['games', 'stolen_bases', 'caught_stealing', 'triples', 'batting_avg'],
}

export const SUMMER_PITCHING_COLUMNS = [
  { key: 'rank', label: '#', width: 40, sortable: false },
  { key: 'name', label: 'Player', width: 160, sortable: false, linkKey: 'spring_player_id',
    render: (row) => `${row.first_name} ${row.last_name}` },
  { key: 'team_short', label: 'Team', width: 100, sortable: false, noLink: true },
  { key: 'league_abbrev', label: 'League', width: 55, sortable: false },

  // Traditional
  { key: 'wins', label: 'W', width: 35, format: 'int' },
  { key: 'losses', label: 'L', width: 35, format: 'int' },
  { key: 'saves', label: 'SV', width: 35, format: 'int' },
  { key: 'games', label: 'G', width: 35, format: 'int' },
  { key: 'games_started', label: 'GS', width: 35, format: 'int' },
  { key: 'innings_pitched', label: 'IP', width: 50, format: 'ip' },
  { key: 'strikeouts', label: 'K', width: 40, format: 'int' },
  { key: 'walks', label: 'BB', width: 40, format: 'int' },
  { key: 'hits_allowed', label: 'H', width: 40, format: 'int' },
  { key: 'earned_runs', label: 'ER', width: 40, format: 'int' },

  // Rates
  { key: 'era', label: 'ERA', width: 55, format: 'era' },
  { key: 'whip', label: 'WHIP', width: 55, format: 'era' },
  { key: 'k_per_9', label: 'K/9', width: 55, format: 'era' },
  { key: 'bb_per_9', label: 'BB/9', width: 55, format: 'era' },
  { key: 'k_bb_ratio', label: 'K/BB', width: 55, format: 'era' },
  { key: 'k_pct', label: 'K%', width: 55, format: 'pct' },
  { key: 'bb_pct', label: 'BB%', width: 55, format: 'pct' },
  { key: 'fip', label: 'FIP', width: 55, format: 'era' },
  { key: 'babip_against', label: 'BABIP', width: 55, format: 'avg' },
  { key: 'pitching_war', label: 'WAR', width: 55, format: 'era' },
]

export const SUMMER_PITCHING_PRESETS = {
  'Standard': ['wins', 'losses', 'saves', 'games', 'games_started', 'innings_pitched', 'strikeouts', 'walks', 'hits_allowed', 'earned_runs', 'era', 'whip'],
  'Advanced': ['innings_pitched', 'era', 'fip', 'whip', 'k_per_9', 'bb_per_9', 'k_bb_ratio', 'k_pct', 'bb_pct', 'babip_against', 'pitching_war'],
  'Strikeouts': ['innings_pitched', 'strikeouts', 'k_per_9', 'k_pct', 'bb_pct', 'k_bb_ratio', 'walks'],
}

// ════════════════════════════════════════════
// Game time formatter
// ════════════════════════════════════════════

/**
 * Normalize scraped game-time strings to a single display format.
 * Scrapers pull from several sources so raw values vary: "6 p.m.",
 * "6:00 p.m. PT", "2:30 PM", "2:30PM", "" / null, "TBD". This collapses
 * them to "H:MM AM/PM" (e.g. "2:30 PM", "6:00 PM").
 *
 * Returns '' for null/empty/TBD/unparseable input so callers can hide
 * the slot entirely rather than rendering literal "TBD".
 */
export function formatGameTime(raw) {
  if (raw == null) return ''
  const s = String(raw).trim()
  if (!s || /^tbd$/i.test(s)) return ''

  // Strip a trailing timezone token (PT, PST, ET, etc.)
  const stripped = s.replace(/\s+(?:[A-Z]{2,4}T|[A-Z]{2,3})$/, '').trim()

  // Match H, H:MM, with optional period-form am/pm
  const m = stripped.match(/^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]\.?$/)
  if (!m) return s  // Unparseable, render as-is rather than dropping data

  const hour = parseInt(m[1], 10)
  const minute = m[2] != null ? m[2] : '00'
  const ampm = m[3].toUpperCase() + 'M'
  if (hour < 1 || hour > 12) return s
  return `${hour}:${minute} ${ampm}`
}
