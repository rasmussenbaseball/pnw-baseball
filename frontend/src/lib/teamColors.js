// Primary school color for every PNW program, keyed by the DB short_name.
// Used by the homepage award cards. Sourced from the GM game's brand map
// (gm/data/teamBrand.js, colors corrected by hand in May 2026) and filled in
// for the handful of programs the GM map doesn't carry.
//
// teamColor() guarantees a color that white text reads on: very light
// brand colors (Walla Walla yellow, Wenatchee Valley white) fall back to
// the site teal rather than producing an unreadable card.

export const TEAM_PRIMARY = {
  // D1
  'Oregon': '#154733', 'UW': '#4B2E83', 'Oregon St.': '#DC4405', 'Wash. St.': '#981E32',
  'Gonzaga': '#041E42', 'Portland': '#502D7F', 'Seattle U': '#AA0000',
  // D2
  'CWU': '#A8002A', 'SMU': '#A50034', 'WOU': '#C8102E', 'NNU': '#A6192E', 'MSUB': '#003D7C',
  // D3
  'UPS': '#760023', 'PLU': '#000000', 'Whitman': '#003B5C', 'Whitworth': '#C20430',
  'Linfield': '#5B0F1C', 'L&C': '#FE5000', 'Willamette': '#9D2235', 'Pacific': '#B7312C', 'GFU': '#1E2A78',
  // NAIA
  'LCSC': '#C8102E', 'Bushnell': '#1D3D6F', 'C of I': '#582C83', 'EOU': '#003B5C', 'OIT': '#003F87',
  'UBC': '#002145', 'Corban': '#0F2D5A', 'Warner Pacific': '#1B3A6B',
  // NWAC
  'Bellevue': '#003B5C', 'Edmonds': '#00789A', 'Everett': '#C8102E', 'Shoreline': '#1B5E3F',
  'Skagit': '#C8102E', 'Douglas': '#1B5E3F', 'Olympic': '#C8102E', 'Linn-Benton': '#1F3A68',
  'Mt. Hood': '#C8102E', 'Umpqua': '#1B5E3F', 'Lower Columbia': '#7B0828', 'Clackamas': '#C8102E',
  'Chemeketa': '#1B5E3F', 'Lane': '#003F87', 'SW Oregon': '#1F3A68', 'Spokane': '#2E6FA8',
  'Walla Walla': '#2B4A7A', 'Wenatchee Valley': '#1D4F91', 'Yakima Valley': '#C8102E',
  'Big Bend': '#002145', 'Blue Mountain': '#005A9C', 'Columbia Basin': '#2F6B9A',
  'Treasure Valley': '#FF6A13', 'Centralia': '#8A6D00', 'Grays Harbor': '#003B5C',
  'Pierce': '#7B0828', 'Tacoma': '#1F3A68', 'Clark': '#003366',
}

const FALLBACK = '#00687a'

function luminance(hex) {
  const m = (hex || '').replace('#', '')
  if (m.length !== 6) return 0
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** Primary color for a team short_name, safe for white text. */
export function teamColor(shortName) {
  const c = TEAM_PRIMARY[shortName]
  if (!c || luminance(c) > 150) return FALLBACK
  return c
}

/** Darken a hex by amt (0-1). */
export function darken(hex, amt = 0.3) {
  const m = (hex || '').replace('#', '')
  if (m.length !== 6) return hex
  const f = (i) => Math.max(0, Math.round(parseInt(m.slice(i, i + 2), 16) * (1 - amt))).toString(16).padStart(2, '0')
  return `#${f(0)}${f(2)}${f(4)}`
}
