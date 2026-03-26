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
    tooltip: 'Weighted On-Base Average — weights each way of reaching base by its run value' },
  { key: 'wrc_plus', label: 'wRC+', width: 55, format: 'int',
    tooltip: 'Weighted Runs Created Plus — 100 = league average, adjusts for park and league' },
  { key: 'iso', label: 'ISO', width: 55, format: 'avg',
    tooltip: 'Isolated Power = SLG - AVG, measures raw power' },
  { key: 'babip', label: 'BABIP', width: 55, format: 'avg',
    tooltip: 'Batting Avg on Balls In Play — helps identify luck vs. skill' },
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
  { key: 'k_pct', label: 'K%', width: 55, format: 'pct',
    tooltip: 'Strikeout Rate = K/BF' },
  { key: 'bb_pct', label: 'BB%', width: 55, format: 'pct',
    tooltip: 'Walk Rate = BB/BF' },
  { key: 'k_bb_pct', label: 'K-BB%', width: 55, format: 'pct',
    tooltip: 'Strikeout minus Walk Rate — measures command advantage' },
  { key: 'k_bb_ratio', label: 'K/BB', width: 55, format: 'era',
    tooltip: 'Strikeout to Walk ratio' },

  // Advanced
  { key: 'fip', label: 'FIP', width: 55, format: 'era',
    tooltip: 'Fielding Independent Pitching — estimates ERA from K, BB, HBP, HR' },
  { key: 'fip_plus', label: 'FIP+', width: 55, format: 'int',
    tooltip: 'FIP+ — 100 = league average, higher is better. League-adjusted for cross-division comparison' },
  { key: 'era_plus', label: 'ERA+', width: 55, format: 'int',
    tooltip: 'ERA+ — 100 = league average, higher is better. League-adjusted for cross-division comparison' },
  { key: 'xfip', label: 'xFIP', width: 55, format: 'era',
    tooltip: 'Expected FIP — normalizes HR/FB ratio to league average' },
  { key: 'siera', label: 'SIERA', width: 55, format: 'era',
    tooltip: 'Skill-Interactive ERA — accounts for how K and BB interact' },
  { key: 'babip_against', label: 'BABIP', width: 55, format: 'avg',
    tooltip: 'BABIP Against — helps identify luck in hits allowed' },
  { key: 'lob_pct', label: 'LOB%', width: 55, format: 'pct',
    tooltip: 'Left On Base % — how often runners are stranded' },
  { key: 'pitching_war', label: 'WAR', width: 55, format: 'war',
    tooltip: 'Pitching Wins Above Replacement' },
]

/**
 * Format a stat value for display.
 */
export function formatStat(value, format) {
  if (value === null || value === undefined) return '—'

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
    case 'war':
      return value.toFixed(1)
    case 'ip':
      // Innings pitched: integer part + .1/.2 for partial innings
      return value.toFixed(1)
    case 'int':
      return Math.round(value).toString()
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
  'Advanced': ['plate_appearances', 'batting_avg', 'on_base_pct', 'slugging_pct', 'woba', 'wrc_plus', 'iso', 'babip', 'bb_pct', 'k_pct', 'offensive_war'],
  'Power': ['plate_appearances', 'home_runs', 'doubles', 'triples', 'slugging_pct', 'iso', 'rbi'],
  'Discipline': ['plate_appearances', 'walks', 'strikeouts', 'bb_pct', 'k_pct', 'on_base_pct', 'woba'],
  'Speed': ['games', 'stolen_bases', 'caught_stealing', 'triples', 'batting_avg'],
}

export const PITCHING_PRESETS = {
  'Standard': ['wins', 'losses', 'saves', 'games', 'games_started', 'innings_pitched', 'strikeouts', 'walks', 'hits_allowed', 'earned_runs', 'era', 'whip'],
  'Advanced': ['innings_pitched', 'era', 'era_plus', 'fip', 'fip_plus', 'xfip', 'siera', 'k_pct', 'bb_pct', 'k_bb_pct', 'babip_against', 'lob_pct', 'pitching_war'],
  'Strikeouts': ['innings_pitched', 'strikeouts', 'k_pct', 'bb_pct', 'k_bb_pct', 'k_bb_ratio', 'walks'],
  'Relievers': ['games', 'saves', 'innings_pitched', 'era', 'era_plus', 'fip', 'fip_plus', 'whip', 'k_pct', 'bb_pct', 'k_bb_pct', 'pitching_war'],
}

// Presets that apply special backend filters (e.g. Relievers → max_gs=0)
export const PITCHING_PRESET_FILTERS = {
  'Relievers': { max_gs: 0, min_ip: 10 },
}
