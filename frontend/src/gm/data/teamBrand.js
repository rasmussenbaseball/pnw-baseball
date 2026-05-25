/**
 * Master PNW team brand map — 2-letter abbreviation + primary/secondary
 * hex colors for every PNW program tracked by the GM game.
 *
 * Used by TeamLogo.jsx to render the pixelated 2-letter monogram logos.
 * Non-PNW teams are NOT in this map — they fall back to a generic
 * single-white-letter logo (per Nate's directive — 1,100+ non-PNW teams
 * shouldn't carry team-specific branding).
 *
 * Colors corrected by Nate, May 2026 — keyed off the NW Baseball Stats
 * (nwbaseballstats.com) team-color reference.
 *
 * Keyed by school.id (matches state.schools[id]).
 */

export const TEAM_BRAND = {
  // ─── D1 (7 PNW programs) ─────────────────────────────────────────────
  'oregon-d1':              { abbr: 'UO', primary: '#154733', secondary: '#FEE123' },  // green / yellow
  'washington-d1':          { abbr: 'UW', primary: '#4B2E83', secondary: '#B7A57A' },  // purple / gold
  'oregon-st-d1':           { abbr: 'OSU', primary: '#DC4405', secondary: '#000000' },  // orange / black
  'washington-state-d1':    { abbr: 'WSU', primary: '#981E32', secondary: '#5E6A71' },  // crimson / gray
  'gonzaga-d1':             { abbr: 'GU', primary: '#041E42', secondary: '#C8102E' },  // navy / red
  'portland-d1':            { abbr: 'UP', primary: '#502D7F', secondary: '#FFFFFF' },  // purple / white
  'seattle-u-d1':           { abbr: 'SU', primary: '#AA0000', secondary: '#000000' },  // red / black

  // ─── D2 (5 PNW programs) ─────────────────────────────────────────────
  'central-washington-d2':  { abbr: 'CWU', primary: '#A8002A', secondary: '#000000' },  // crimson / black
  'saint-martins-d2':       { abbr: 'SMU', primary: '#A50034', secondary: '#000000' },  // red / black
  'western-oregon-d2':      { abbr: 'WOU', primary: '#C8102E', secondary: '#000000' },  // red / black
  'northwest-nazarene-d2':  { abbr: 'NNU', primary: '#A6192E', secondary: '#000000' },  // red / black
  'msu-billings-d2':        { abbr: 'MSB', primary: '#003D7C', secondary: '#FFD200' },  // light navy / golden yellow

  // ─── D3 (9 PNW programs) ─────────────────────────────────────────────
  'puget-sound-d3':         { abbr: 'UPS', primary: '#760023', secondary: '#FFFFFF' },  // maroon / white
  'pacific-lutheran-d3':    { abbr: 'PLU', primary: '#000000', secondary: '#FFD200' },  // black / yellow
  'whitman-d3':             { abbr: 'WU',  primary: '#FFD200', secondary: '#003B5C' },  // yellow / navy — COLLIDES with Willamette
  'whitworth-d3':           { abbr: 'WW',  primary: '#C20430', secondary: '#000000' },  // red / black — COLLIDES with NWAC Walla Walla
  'linfield-d3':            { abbr: 'LU',  primary: '#5B0F1C', secondary: '#7C7E80' },  // maroon / silver
  'lewis-and-clark-d3':     { abbr: 'L&C', primary: '#FE5000', secondary: '#000000' },  // orange / black
  'willamette-d3':          { abbr: 'WU',  primary: '#9D2235', secondary: '#FFC72C' },  // cardinal / gold — COLLIDES with Whitman
  'pacific-or-d3':          { abbr: 'PU',  primary: '#A6192E', secondary: '#FFFFFF' },  // red / white
  'george-fox-d3':          { abbr: 'GF',  primary: '#003366', secondary: '#FFD700' },  // navy / gold

  // ─── NAIA (8 PNW programs — Cascade Conference) ─────────────────────
  'lewis-clark-state':      { abbr: 'LC', primary: '#00205B', secondary: '#FFC72C' },  // navy / gold
  'bushnell':               { abbr: 'BU', primary: '#1D3D6F', secondary: '#FFC72C' },  // navy / gold
  'college-of-idaho':       { abbr: 'COI', primary: '#582C83', secondary: '#FFFFFF' },  // purple / white
  'corban':                 { abbr: 'CR',  primary: '#FFD200', secondary: '#003B5C' },  // yellow / navy
  'eastern-oregon':         { abbr: 'EOU', primary: '#003B5C', secondary: '#B5A363' },  // blue / dark gold
  'oregon-tech':            { abbr: 'OIT', primary: '#003F87', secondary: '#FFD200' },  // blue / yellow
  'warner-pacific':         { abbr: 'WP',  primary: '#008080', secondary: '#000000' },  // teal / black
  'british-columbia':       { abbr: 'UBC', primary: '#002145', secondary: '#FFB81C' },  // navy / gold

  // ─── NWAC (28 PNW programs — JUCO) ───────────────────────────────────
  'nwac-bellevue':          { abbr: 'BV', primary: '#003B5C', secondary: '#C8102E' },  // navy / red
  'nwac-edmonds':           { abbr: 'ED', primary: '#00B5D8', secondary: '#FFFFFF' },  // aqua / white
  'nwac-everett':           { abbr: 'EV', primary: '#C8102E', secondary: '#000000' },  // red / black
  'nwac-shoreline':         { abbr: 'SH', primary: '#1B5E3F', secondary: '#000000' },  // green / black
  'nwac-skagit-valley':     { abbr: 'SV', primary: '#C8102E', secondary: '#FFFFFF' },  // red / white
  'nwac-douglas':           { abbr: 'DG', primary: '#1B5E3F', secondary: '#A0A2A4' },  // green / grey
  'nwac-olympic':           { abbr: 'OL', primary: '#C8102E', secondary: '#000000' },  // red / black
  'nwac-linn-benton':       { abbr: 'LB', primary: '#1F3A68', secondary: '#FFC72C' },  // navy / gold
  'nwac-mt-hood':           { abbr: 'MH', primary: '#C8102E', secondary: '#000000' },  // red / black
  'nwac-umpqua':            { abbr: 'UM', primary: '#1B5E3F', secondary: '#FFFFFF' },  // green / white
  'nwac-lower-columbia':    { abbr: 'LO', primary: '#7B0828', secondary: '#003B5C' },  // dark red / navy
  'nwac-clackamas':         { abbr: 'CK', primary: '#C8102E', secondary: '#1F3A68' },  // red / navy
  'nwac-chemeketa':         { abbr: 'CH', primary: '#1B5E3F', secondary: '#A0A2A4' },  // green / grey
  'nwac-lane':              { abbr: 'LN', primary: '#003F87', secondary: '#FFD200' },  // blue / yellow
  'nwac-sw-oregon':         { abbr: 'SO', primary: '#1F3A68', secondary: '#C8102E' },  // navy / red
  'nwac-spokane':           { abbr: 'SP', primary: '#5BA5E0', secondary: '#1F3A68' },  // baby blue / navy
  'nwac-walla-walla':       { abbr: 'WW', primary: '#FFD200', secondary: '#000000' },  // yellow / black
  'nwac-wenatchee-valley':  { abbr: 'WV', primary: '#FFFFFF', secondary: '#000000' },  // white / black
  'nwac-yakima-valley':     { abbr: 'YV', primary: '#C8102E', secondary: '#FFC72C' },  // red / gold
  'nwac-big-bend':          { abbr: 'BB', primary: '#002145', secondary: '#1B5E3F' },  // navy / green
  'nwac-blue-mountain':     { abbr: 'BM', primary: '#005A9C', secondary: '#FFFFFF' },  // blue / white
  'nwac-columbia-basin':    { abbr: 'CB', primary: '#6CB4EE', secondary: '#002145' },  // baby blue / navy
  'nwac-treasure-valley':   { abbr: 'TV', primary: '#FF6A13', secondary: '#1F3A68' },  // orange / blue
  'nwac-centralia':         { abbr: 'CN', primary: '#FFD200', secondary: '#003F87' },  // yellow / blue
  'nwac-grays-harbor':      { abbr: 'GH', primary: '#003B5C', secondary: '#000000' },  // blue / black
  'nwac-pierce':            { abbr: 'PI', primary: '#7B0828', secondary: '#FFFFFF' },  // maroon / white
  'nwac-tacoma':            { abbr: 'TC', primary: '#1F3A68', secondary: '#FFFFFF' },  // blue / white
  'nwac-clark':             { abbr: 'CL', primary: '#003366', secondary: '#000000' },  // blue / black
}

/** True if this school id is a tracked PNW program with a brand entry. */
export function isPnwProgram(schoolId) {
  return schoolId in TEAM_BRAND
}

/** Get the 2-letter abbr for a PNW team, else fall back to first letter of name. */
export function brandAbbr(schoolId, schoolName) {
  const b = TEAM_BRAND[schoolId]
  if (b) return b.abbr
  if (!schoolName) return '?'
  // Non-PNW fallback — single uppercase first letter (skip articles).
  const cleaned = String(schoolName)
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(the|of|at|in|st\.?|saint|university|college|state)\b/gi, '')
    .trim()
  const firstWord = cleaned.split(/\s+/).filter(Boolean)[0] || schoolName
  return (firstWord[0] || '?').toUpperCase()
}
