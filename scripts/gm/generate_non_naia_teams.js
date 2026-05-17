#!/usr/bin/env node
/**
 * Build frontend/src/gm/data/non_naia_teams.json from real PEAR rating data
 * cached in scripts/gm/pear_cache/{d1,d2,d3,naia}.json.
 *
 * PEAR is the same engine that drives our NAIA ratings in
 * frontend/src/gm/data/pear_ratings_2026.json. It also publishes for D1, D2,
 * D3 — this script pulls all three from their API:
 *   D1:   https://pearatings.com/api/cbase/ratings
 *   D2:   https://pearatings.com/api/d2-cbase/ratings
 *   D3:   https://pearatings.com/api/d3-cbase/ratings
 *   NAIA: https://pearatings.com/api/naia-cbase/ratings
 *
 * Per-team fields PEAR gives us: Team, Conference, power_rating, NET, SOS,
 * SOR, ELO, RPI, PRR, RQI. We use Team + Conference + power_rating to fill
 * the GM game's non-NAIA opponent pool.
 *
 * power_rating is per-division (Georgia Tech D1 ~7.4 is best D1; LC State
 * NAIA ~7.9 is best NAIA — they're not on the same scale). Our cross-
 * division rating engine (nwbbRating.nonNaiaToUniversal) handles the
 * tier-aware translation to a universal 0-100 scale, so we store
 * power_rating verbatim as `strength`.
 *
 * What we DON'T get from PEAR: city, state, nickname, colors. Those are
 * preserved from the previously hand-tuned PNW + national-powers list
 * (existing JSON) when names match. Unmatched teams get blank metadata.
 *
 * NAIA is loaded separately by rankings.js from pear_ratings_2026.json so
 * we don't write it here — but the script verifies the count matches.
 *
 * Run:  node scripts/gm/generate_non_naia_teams.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const CACHE_DIR = path.join(__dirname, 'pear_cache')
const OUT_PATH = path.join(ROOT, 'frontend', 'src', 'gm', 'data', 'non_naia_teams.json')

// ─── Slug helper ──────────────────────────────────────────────────────────

function slugify(name) {
  return name.toLowerCase()
    .replace(/'/g, '')              // drop apostrophes
    .replace(/&/g, 'and')
    .replace(/\./g, '')             // drop periods: "St. John's" → "stjohns"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ─── Hand-curated metadata: city, state, nickname, colors for prominent
//     programs. Looked up by team name (normalized) so PEAR's name variants
//     resolve correctly. Anything not in this table gets blank metadata
//     (still works in-game — proximity / colors are decorative for
//     non-NAIA opponents).
//
//     Extend this list any time you want richer metadata on a program.
// ──────────────────────────────────────────────────────────────────────────

const META = {
  // ===== D1 power programs =====
  'lsu':              { city: 'Baton Rouge',     state: 'LA', nickname: 'Tigers',       colors: { primary: '#461D7C', secondary: '#FDD023' } },
  'tennessee':        { city: 'Knoxville',       state: 'TN', nickname: 'Volunteers',   colors: { primary: '#FF8200', secondary: '#FFFFFF' } },
  'vanderbilt':       { city: 'Nashville',       state: 'TN', nickname: 'Commodores',   colors: { primary: '#000000', secondary: '#866D4B' } },
  'arkansas':         { city: 'Fayetteville',    state: 'AR', nickname: 'Razorbacks',   colors: { primary: '#9D2235', secondary: '#FFFFFF' } },
  'florida':          { city: 'Gainesville',     state: 'FL', nickname: 'Gators',       colors: { primary: '#0021A5', secondary: '#FA4616' } },
  'texas':            { city: 'Austin',          state: 'TX', nickname: 'Longhorns',    colors: { primary: '#BF5700', secondary: '#FFFFFF' } },
  'texas-aandm':      { city: 'College Station', state: 'TX', nickname: 'Aggies',       colors: { primary: '#500000', secondary: '#FFFFFF' } },
  'mississippi-st':   { city: 'Starkville',      state: 'MS', nickname: 'Bulldogs',     colors: { primary: '#660000', secondary: '#FFFFFF' } },
  'ole-miss':         { city: 'Oxford',          state: 'MS', nickname: 'Rebels',       colors: { primary: '#CE1126', secondary: '#14213D' } },
  'auburn':           { city: 'Auburn',          state: 'AL', nickname: 'Tigers',       colors: { primary: '#0C2340', secondary: '#E87722' } },
  'georgia':          { city: 'Athens',          state: 'GA', nickname: 'Bulldogs',     colors: { primary: '#BA0C2F', secondary: '#000000' } },
  'kentucky':         { city: 'Lexington',       state: 'KY', nickname: 'Wildcats',     colors: { primary: '#0033A0', secondary: '#FFFFFF' } },
  'south-carolina':   { city: 'Columbia',        state: 'SC', nickname: 'Gamecocks',    colors: { primary: '#73000A', secondary: '#000000' } },
  'alabama':          { city: 'Tuscaloosa',      state: 'AL', nickname: 'Crimson Tide', colors: { primary: '#9E1B32', secondary: '#FFFFFF' } },
  'oklahoma':         { city: 'Norman',          state: 'OK', nickname: 'Sooners',      colors: { primary: '#841617', secondary: '#FDF9D8' } },
  'missouri':         { city: 'Columbia',        state: 'MO', nickname: 'Tigers',       colors: { primary: '#F1B82D', secondary: '#000000' } },
  'florida-st':       { city: 'Tallahassee',     state: 'FL', nickname: 'Seminoles',    colors: { primary: '#782F40', secondary: '#CEB888' } },
  'wake-forest':      { city: 'Winston-Salem',   state: 'NC', nickname: 'Demon Deacons',colors: { primary: '#9E7E38', secondary: '#000000' } },
  'virginia':         { city: 'Charlottesville', state: 'VA', nickname: 'Cavaliers',    colors: { primary: '#232D4B', secondary: '#F84C1E' } },
  'nc-state':         { city: 'Raleigh',         state: 'NC', nickname: 'Wolfpack',     colors: { primary: '#CC0000', secondary: '#000000' } },
  'stanford':         { city: 'Stanford',        state: 'CA', nickname: 'Cardinal',     colors: { primary: '#8C1515', secondary: '#FFFFFF' } },
  'clemson':          { city: 'Clemson',         state: 'SC', nickname: 'Tigers',       colors: { primary: '#F56600', secondary: '#522D80' } },
  'miami-fl':         { city: 'Coral Gables',    state: 'FL', nickname: 'Hurricanes',   colors: { primary: '#F47321', secondary: '#005030' } },
  'unc':              { city: 'Chapel Hill',     state: 'NC', nickname: 'Tar Heels',    colors: { primary: '#7BAFD4', secondary: '#FFFFFF' } },
  'north-carolina':   { city: 'Chapel Hill',     state: 'NC', nickname: 'Tar Heels',    colors: { primary: '#7BAFD4', secondary: '#FFFFFF' } },
  'duke':             { city: 'Durham',          state: 'NC', nickname: 'Blue Devils',  colors: { primary: '#003087', secondary: '#FFFFFF' } },
  'louisville':       { city: 'Louisville',      state: 'KY', nickname: 'Cardinals',    colors: { primary: '#AD0000', secondary: '#000000' } },
  'virginia-tech':    { city: 'Blacksburg',      state: 'VA', nickname: 'Hokies',       colors: { primary: '#861F41', secondary: '#E5751F' } },
  'georgia-tech':     { city: 'Atlanta',         state: 'GA', nickname: 'Yellow Jackets',colors: { primary: '#B3A369', secondary: '#003057' } },
  'notre-dame':       { city: 'Notre Dame',      state: 'IN', nickname: 'Fighting Irish',colors: { primary: '#0C2340', secondary: '#C99700' } },
  'pittsburgh':       { city: 'Pittsburgh',      state: 'PA', nickname: 'Panthers',     colors: { primary: '#003594', secondary: '#FFB81C' } },
  'pitt':             { city: 'Pittsburgh',      state: 'PA', nickname: 'Panthers',     colors: { primary: '#003594', secondary: '#FFB81C' } },
  'boston-college':   { city: 'Chestnut Hill',   state: 'MA', nickname: 'Eagles',       colors: { primary: '#8B2332', secondary: '#BC9B6A' } },
  'california':       { city: 'Berkeley',        state: 'CA', nickname: 'Golden Bears', colors: { primary: '#003262', secondary: '#FDB515' } },
  'cal':              { city: 'Berkeley',        state: 'CA', nickname: 'Golden Bears', colors: { primary: '#003262', secondary: '#FDB515' } },
  'smu':              { city: 'University Park', state: 'TX', nickname: 'Mustangs',     colors: { primary: '#0033A0', secondary: '#C8102E' } },
  'oklahoma-st':      { city: 'Stillwater',      state: 'OK', nickname: 'Cowboys',      colors: { primary: '#FF7300', secondary: '#000000' } },
  'tcu':              { city: 'Fort Worth',      state: 'TX', nickname: 'Horned Frogs', colors: { primary: '#4D1979', secondary: '#A3A9AC' } },
  'arizona':          { city: 'Tucson',          state: 'AZ', nickname: 'Wildcats',     colors: { primary: '#CC0033', secondary: '#003366' } },
  'arizona-st':       { city: 'Tempe',           state: 'AZ', nickname: 'Sun Devils',   colors: { primary: '#8C1D40', secondary: '#FFC627' } },
  'baylor':           { city: 'Waco',            state: 'TX', nickname: 'Bears',        colors: { primary: '#003015', secondary: '#FECB00' } },
  'byu':              { city: 'Provo',           state: 'UT', nickname: 'Cougars',      colors: { primary: '#002E5D', secondary: '#FFFFFF' } },
  'texas-tech':       { city: 'Lubbock',         state: 'TX', nickname: 'Red Raiders',  colors: { primary: '#CC0000', secondary: '#000000' } },
  'west-virginia':    { city: 'Morgantown',      state: 'WV', nickname: 'Mountaineers', colors: { primary: '#002855', secondary: '#EAAA00' } },
  // ===== Pac-12/Big Ten west coast =====
  'oregon':           { city: 'Eugene',          state: 'OR', nickname: 'Ducks',         colors: { primary: '#154733', secondary: '#FEE123' } },
  'oregon-st':        { city: 'Corvallis',       state: 'OR', nickname: 'Beavers',       colors: { primary: '#DC4405', secondary: '#000000' } },
  'oregon-state':     { city: 'Corvallis',       state: 'OR', nickname: 'Beavers',       colors: { primary: '#DC4405', secondary: '#000000' } },
  'washington':       { city: 'Seattle',         state: 'WA', nickname: 'Huskies',       colors: { primary: '#4B2E83', secondary: '#B7A57A' } },
  'washington-st':    { city: 'Pullman',         state: 'WA', nickname: 'Cougars',       colors: { primary: '#981E32', secondary: '#5E6A71' } },
  'washington-state': { city: 'Pullman',         state: 'WA', nickname: 'Cougars',       colors: { primary: '#981E32', secondary: '#5E6A71' } },
  'gonzaga':          { city: 'Spokane',         state: 'WA', nickname: 'Bulldogs',      colors: { primary: '#041E42', secondary: '#C8102E' } },
  'portland':         { city: 'Portland',        state: 'OR', nickname: 'Pilots',        colors: { primary: '#502D7F', secondary: '#FFFFFF' } },
  'seattle-u':        { city: 'Seattle',         state: 'WA', nickname: 'Redhawks',      colors: { primary: '#AA0000', secondary: '#000000' } },
  'ucla':             { city: 'Los Angeles',     state: 'CA', nickname: 'Bruins',        colors: { primary: '#2774AE', secondary: '#FFD100' } },
  'usc':              { city: 'Los Angeles',     state: 'CA', nickname: 'Trojans',       colors: { primary: '#990000', secondary: '#FFCC00' } },
  // ===== D2 PNW =====
  'central-washington':{city: 'Ellensburg',      state: 'WA', nickname: 'Wildcats',     colors: { primary: '#A50E25', secondary: '#000000' } },
  'saint-martins':    { city: 'Lacey',           state: 'WA', nickname: 'Saints',       colors: { primary: '#A50034', secondary: '#000000' } },
  'msu-billings':     { city: 'Billings',        state: 'MT', nickname: 'Yellowjackets',colors: { primary: '#FFB81C', secondary: '#000000' } },
  'western-oregon':   { city: 'Monmouth',        state: 'OR', nickname: 'Wolves',       colors: { primary: '#B61E2E', secondary: '#FFFFFF' } },
  'northwest-nazarene':{city: 'Nampa',           state: 'ID', nickname: 'Nighthawks',   colors: { primary: '#001E62', secondary: '#A6192E' } },
  // ===== D3 PNW =====
  'puget-sound':      { city: 'Tacoma',          state: 'WA', nickname: 'Loggers',      colors: { primary: '#760023', secondary: '#000000' } },
  'pacific-lutheran': { city: 'Tacoma',          state: 'WA', nickname: 'Lutes',        colors: { primary: '#000000', secondary: '#FFB81C' } },
  'whitman':          { city: 'Walla Walla',     state: 'WA', nickname: 'Blues',        colors: { primary: '#FFD200', secondary: '#003B5C' } },
  'whitworth':        { city: 'Spokane',         state: 'WA', nickname: 'Pirates',      colors: { primary: '#C20430', secondary: '#000000' } },
  'linfield':         { city: 'McMinnville',     state: 'OR', nickname: 'Wildcats',     colors: { primary: '#5B0F1C', secondary: '#7C7E80' } },
  'lewis-and-clark':  { city: 'Portland',        state: 'OR', nickname: 'Pioneers',     colors: { primary: '#FE5000', secondary: '#000000' } },
  'willamette':       { city: 'Salem',           state: 'OR', nickname: 'Bearcats',     colors: { primary: '#9D2235', secondary: '#FFC72C' } },
  'pacific-or':       { city: 'Forest Grove',    state: 'OR', nickname: 'Boxers',       colors: { primary: '#A6192E', secondary: '#000000' } },
  'george-fox':       { city: 'Newberg',         state: 'OR', nickname: 'Bruins',       colors: { primary: '#003366', secondary: '#FFD700' } },
}

// ─── Bulk state lookup (slugified PEAR name → 2-letter state) ────────────
// Covers most D1 + a chunk of D2/D3 so travel cost calculations can use
// real distances. Teams not in this table fall back to a flat travel cost
// in travel.js. Easy to extend — just add more `'slug': 'XX'` entries.

const TEAM_STATE = {
  // ===== D1 SEC =====
  'lsu': 'LA', 'tennessee': 'TN', 'vanderbilt': 'TN', 'arkansas': 'AR',
  'florida': 'FL', 'texas': 'TX', 'texas-aandm': 'TX', 'mississippi-st': 'MS',
  'ole-miss': 'MS', 'auburn': 'AL', 'georgia': 'GA', 'kentucky': 'KY',
  'south-carolina': 'SC', 'alabama': 'AL', 'oklahoma': 'OK', 'missouri': 'MO',
  // ===== D1 ACC =====
  'florida-st': 'FL', 'wake-forest': 'NC', 'virginia': 'VA', 'nc-state': 'NC',
  'stanford': 'CA', 'clemson': 'SC', 'miami-fl': 'FL', 'north-carolina': 'NC',
  'duke': 'NC', 'louisville': 'KY', 'virginia-tech': 'VA', 'georgia-tech': 'GA',
  'notre-dame': 'IN', 'pittsburgh': 'PA', 'pitt': 'PA', 'boston-college': 'MA',
  'california': 'CA', 'smu': 'TX',
  // ===== D1 Big 12 =====
  'oklahoma-st': 'OK', 'tcu': 'TX', 'arizona': 'AZ', 'arizona-st': 'AZ',
  'baylor': 'TX', 'byu': 'UT', 'texas-tech': 'TX', 'houston': 'TX',
  'cincinnati': 'OH', 'ucf': 'FL', 'west-virginia': 'WV', 'kansas': 'KS',
  'kansas-st': 'KS', 'utah': 'UT', 'colorado': 'CO',
  // ===== D1 Big Ten =====
  'oregon': 'OR', 'oregon-st': 'OR', 'ucla': 'CA', 'usc': 'CA',
  'southern-california': 'CA', 'washington': 'WA', 'indiana': 'IN',
  'maryland': 'MD', 'michigan': 'MI', 'michigan-st': 'MI', 'illinois': 'IL',
  'iowa': 'IA', 'minnesota': 'MN', 'nebraska': 'NE', 'ohio-st': 'OH',
  'penn-st': 'PA', 'purdue': 'IN', 'rutgers': 'NJ', 'northwestern': 'IL',
  // ===== D1 WCC =====
  'gonzaga': 'WA', 'portland': 'OR', 'lmu-ca': 'CA', 'pepperdine': 'CA',
  'san-diego': 'CA', 'santa-clara': 'CA', 'saint-marys-ca': 'CA',
  'san-francisco': 'CA', 'pacific': 'CA',
  // ===== D1 Big West =====
  'uc-irvine': 'CA', 'uc-santa-barbara': 'CA', 'cal-st-fullerton': 'CA',
  'long-beach-st': 'CA', 'uc-davis': 'CA', 'uc-riverside': 'CA',
  'uc-san-diego': 'CA', 'csu-bakersfield': 'CA', 'csun': 'CA', 'hawaii': 'HI',
  'cal-poly': 'CA',
  // ===== D1 Sun Belt =====
  'coastal-carolina': 'SC', 'east-carolina': 'NC', 'troy': 'AL',
  'south-alabama': 'AL', 'louisiana': 'LA', 'ulm': 'LA', 'texas-st': 'TX',
  'arkansas-st': 'AR', 'ga-southern': 'GA', 'georgia-st': 'GA',
  'app-state': 'NC', 'marshall': 'WV', 'old-dominion': 'VA',
  'james-madison': 'VA', 'southern-miss': 'MS',
  // ===== D1 C-USA =====
  'dbu': 'TX', 'utsa': 'TX', 'fla-atlantic': 'FL', 'fiu': 'FL',
  'liberty': 'VA', 'louisiana-tech': 'LA', 'middle-tenn': 'TN',
  'new-mexico-st': 'NM', 'utep': 'TX', 'western-ky': 'KY',
  'kennesaw-st': 'GA', 'sam-houston': 'TX', 'jacksonville-st': 'AL',
  // ===== D1 AAC =====
  'tulane': 'LA', 'memphis': 'TN', 'south-fla': 'FL', 'north-texas': 'TX',
  'uab': 'AL', 'wichita-st': 'KS', 'charlotte': 'NC', 'rice': 'TX',
  'temple': 'PA', 'tulsa': 'OK',
  // ===== D1 ASUN =====
  'lipscomb': 'TN', 'fgcu': 'FL', 'jacksonville': 'FL', 'north-ala': 'AL',
  'stetson': 'FL', 'north-florida': 'FL', 'bellarmine': 'KY',
  'central-ark': 'AR', 'eastern-ky': 'KY', 'west-ga': 'GA', 'queens-nc': 'NC',
  'austin-peay': 'TN',
  // ===== D1 Big South =====
  'high-point': 'NC', 'charleston-so': 'SC', 'gardner-webb': 'NC',
  'longwood': 'VA', 'presbyterian': 'SC', 'radford': 'VA', 'winthrop': 'SC',
  'unc-asheville': 'NC', 'usc-upstate': 'SC',
  // ===== D1 SoCon =====
  'mercer': 'GA', 'wofford': 'SC', 'furman': 'SC', 'samford': 'AL',
  'the-citadel': 'SC', 'unc-greensboro': 'NC', 'western-caro': 'NC',
  'etsu': 'TN', 'vmi': 'VA',
  // ===== D1 Big East =====
  'uconn': 'CT', 'creighton': 'NE', 'xavier': 'OH', 'villanova': 'PA',
  'seton-hall': 'NJ', 'georgetown': 'DC', 'butler': 'IN', 'depaul': 'IL',
  'providence': 'RI', 'st-johns-ny': 'NY',
  // ===== D1 MWC =====
  'air-force': 'CO', 'fresno-st': 'CA', 'nevada': 'NV', 'new-mexico': 'NM',
  'san-diego-st': 'CA', 'san-jose-st': 'CA', 'unlv': 'NV',
  // ===== D1 WAC =====
  'grand-canyon': 'AZ', 'utah-valley': 'UT', 'tarleton-st': 'TX',
  'abilene-christian': 'TX', 'sfa': 'TX', 'southern-utah': 'UT', 'seattle-u': 'WA',
  'utah-tech': 'UT', 'uiw': 'TX', 'utrgv': 'TX',
  // ===== D1 Atlantic 10 =====
  'saint-josephs': 'PA', 'dayton': 'OH', 'vcu': 'VA', 'davidson': 'NC',
  'fordham': 'NY', 'george-mason': 'VA', 'george-washington': 'DC',
  'la-salle': 'PA', 'loyola-chicago': 'IL', 'massachusetts': 'MA',
  'rhode-island': 'RI', 'richmond': 'VA', 'saint-louis': 'MO',
  'st-bonaventure': 'NY',
  // ===== D1 America East =====
  'maine': 'ME', 'umbc': 'MD', 'binghamton': 'NY', 'bryant': 'RI',
  'ualbany': 'NY', 'umass-lowell': 'MA',
  // ===== D1 CAA =====
  'col-of-charleston': 'SC', 'uncw': 'NC', 'northeastern': 'MA',
  'william-and-mary': 'VA', 'towson': 'MD', 'hofstra': 'NY', 'delaware': 'DE',
  'elon': 'NC', 'stony-brook': 'NY', 'monmouth': 'NJ', 'nc-aandt': 'NC',
  // ===== D1 Patriot =====
  'army-west-point': 'NY', 'navy': 'MD', 'lehigh': 'PA', 'bucknell': 'PA',
  'holy-cross': 'MA', 'lafayette': 'PA',
  // ===== D1 Ivy =====
  'harvard': 'MA', 'yale': 'CT', 'princeton': 'NJ', 'columbia': 'NY',
  'penn': 'PA', 'cornell': 'NY', 'dartmouth': 'NH', 'brown': 'RI',
  // ===== D1 Horizon =====
  'wright-st': 'OH', 'oakland': 'MI', 'youngstown-st': 'OH',
  'northern-ky': 'KY', 'milwaukee': 'WI', 'uic': 'IL',
  // ===== D1 MAAC =====
  'fairfield': 'CT', 'canisius': 'NY', 'iona': 'NY', 'manhattan': 'NY',
  'marist': 'NY', 'mount-st-marys': 'MD', 'niagara': 'NY', 'quinnipiac': 'CT',
  'rider': 'NJ', 'saint-peters': 'NJ', 'siena': 'NY',
  // ===== D1 MAC =====
  'central-mich': 'MI', 'eastern-mich': 'MI', 'western-mich': 'MI',
  'niu': 'IL', 'ball-st': 'IN', 'bowling-green': 'OH', 'kent-st': 'OH',
  'miami-oh': 'OH', 'ohio': 'OH', 'toledo': 'OH',
  // ===== D1 NEC =====
  'le-moyne': 'NY', 'sacred-heart': 'CT', 'wagner': 'NY', 'liu': 'NY',
  'stonehill': 'MA', 'central-conn-st': 'CT', 'fdu': 'NJ', 'merrimack': 'MA',
  // ===== D1 OVC =====
  'tennessee-tech': 'TN', 'belmont': 'TN', 'morehead-st': 'KY',
  'southeast-mo-st': 'MO', 'murray-st': 'KY', 'siue': 'IL',
  'ut-martin': 'TN', 'western-ill': 'IL', 'lindenwood': 'MO',
  'eastern-ill': 'IL', 'tennessee-st': 'TN',
  // ===== D1 Southland =====
  'mcneese': 'LA', 'nicholls': 'LA', 'northwestern-st': 'LA',
  'southeastern-la': 'LA', 'houston-christian': 'TX', 'lamar-university': 'TX',
  'new-orleans': 'LA', 'aandm-corpus-christi': 'TX', 'ut-arlington': 'TX',
  // ===== D1 Summit =====
  'north-dakota-st': 'ND', 'south-dakota-st': 'SD', 'oral-roberts': 'OK',
  'omaha': 'NE', 'st-thomas-mn': 'MN', 'northern-colo': 'CO',
  // ===== D1 SWAC =====
  'alabama-st': 'AL', 'bethune-cookman': 'FL', 'florida-aandm': 'FL',
  'grambling': 'LA', 'jackson-st': 'MS', 'mississippi-val': 'MS',
  'prairie-view': 'TX', 'southern-u': 'LA', 'texas-southern': 'TX',
  'alabama-aandm': 'AL', 'alcorn': 'MS', 'ark-pine-bluff': 'AR',
  // ===== D1 MEAC =====
  'coppin-st': 'MD', 'delaware-st': 'DE', 'howard': 'DC', 'norfolk-st': 'VA',
  'umes': 'MD',
  // ===== Misc D1 =====
  'akron': 'OH', 'bradley': 'IL', 'indiana-st': 'IN', 'evansville': 'IN',
  'illinois-st': 'IL', 'missouri-st': 'MO', 'southern-ill': 'IL',
  'southern-ind': 'IN', 'sacramento-st': 'CA', 'valparaiso': 'IN',
  'campbell': 'NC', 'njit': 'NJ', 'little-rock': 'AR',
  // ===== D2 highlights (PNW + national powers) =====
  'central-washington': 'WA', 'saint-martins': 'WA', 'msu-billings': 'MT',
  'western-oregon': 'OR', 'northwest-nazarene': 'ID', 'tampa': 'FL',
  'north-greenville': 'SC', 'angelo-st': 'TX', 'west-florida': 'FL',
  'augustana-sd': 'SD', 'central-missouri': 'MO', 'pittsburg-st': 'KS',
  'mount-olive': 'NC', 'west-texas-aandm': 'TX', 'colorado-mesa': 'CO',
  'cal-poly-pomona': 'CA', 'nova-southeastern': 'FL', 'lynn': 'FL',
  'wingate': 'NC', 'concordia-ca': 'CA', 'francis-marion': 'SC',
  'embry-riddle': 'FL', 'saint-leo': 'FL', 'eckerd': 'FL', 'barry': 'FL',
  'florida-southern': 'FL', 'palm-beach-atlantic': 'FL', 'florida-tech': 'FL',
  'chico-st': 'CA', 'csu-stanislaus': 'CA', 'csu-dominguez-hills': 'CA',
  'csu-los-angeles': 'CA', 'csu-east-bay': 'CA',
  'cal-st-monterey-bay': 'CA', 'cal-st-san-marcos': 'CA', 'point-loma': 'CA',
  'san-francisco-st': 'CA', 'sonoma-st': 'CA',
  // ===== D3 highlights (PNW + national powers) =====
  'puget-sound': 'WA', 'pacific-lutheran': 'WA', 'whitman': 'WA',
  'whitworth': 'WA', 'linfield': 'OR', 'lewis-and-clark': 'OR',
  'willamette': 'OR', 'pacific-or': 'OR', 'george-fox': 'OR',
  'salisbury': 'MD', 'cortland': 'NY', 'wpi': 'MA', 'johns-hopkins': 'MD',
  'wis-whitewater': 'WI', 'trinity-tx': 'TX', 'lynchburg': 'VA',
  'christopher-newport': 'VA', 'washington-and-jefferson': 'PA',
  'misericordia': 'PA', 'north-central-il': 'IL', 'cal-lutheran': 'CA',
  'redlands': 'CA', 'chapman': 'CA', 'claremont-mudd-scripps': 'CA',
  'denison': 'OH', 'amherst': 'MA', 'tufts': 'MA', 'williams': 'MA',
  'bowdoin': 'ME', 'bates': 'ME', 'colby': 'ME', 'middlebury': 'VT',
  'wesleyan': 'CT', 'trinity-ct': 'CT', 'hamilton': 'NY',
  'connecticut-college': 'CT',
}

// PEAR uses some name variants ("Mississippi St." instead of "Mississippi State")
// — normalize to a slug for META lookup. CRITICAL: parenthetical-named teams
// like "California (PA)" must NOT match the non-parenthetical "California"
// META entry. Those are different schools.
function lookupMeta(rawName) {
  const hasParens = /\([^)]+\)/.test(rawName)
  // First try raw slug
  const direct = slugify(rawName)
  if (META[direct]) return META[direct]
  // Try with "st." → "state"
  const expanded = slugify(rawName.replace(/\bSt\.?\b/g, 'State'))
  if (META[expanded]) return META[expanded]
  // Only fall back to "strip parenthetical" if there are NO parens in the
  // raw name — otherwise we'd cross-match "California (PA)" to Cal Berkeley.
  if (!hasParens) {
    const noParens = slugify(rawName.replace(/\s*\([^)]*\)/g, ''))
    if (META[noParens]) return META[noParens]
  }
  return null
}

// ─── Load PEAR data ────────────────────────────────────────────────────────

function loadPear(div) {
  const p = path.join(CACHE_DIR, `${div}.json`)
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  return raw.teams || []
}

// ─── Build a team entry from a PEAR row + the division code ───────────────

function mkTeam(pearRow, divisionCode) {
  const name = pearRow.Team
  const meta = lookupMeta(name) || {}
  const id = slugify(name) + '-' + divisionCode.toLowerCase()
  // State resolution priority:
  //   1. Full META entry (which carries city/nickname/colors too)
  //   2. Bulk TEAM_STATE table (state-only, covers ~250 more programs)
  //   3. Empty — falls back to flat travel cost in travel.js
  const slug = slugify(name)
  const state = meta.state || TEAM_STATE[slug] || ''
  return {
    id,
    name,
    city: meta.city || '',
    state,
    nickname: meta.nickname || '',
    // PEAR's power_rating is per-division. nwbbRating.nonNaiaToUniversal
    // adds the division's tier base when computing the universal 0-100 rating.
    strength: typeof pearRow.power_rating === 'number' ? pearRow.power_rating : 0,
    pearRank: pearRow.PRR ?? null,
    pearConference: pearRow.Conference ?? null,
    colors: meta.colors || null,
  }
}

// ─── Load NWAC teams + PPI from the NWBB stats backend cache ──────────────
//
// Sourced from https://nwbaseballstats.com/api/v1/team-ratings?division_level=JUCO
// — the same engine that drives the public NWAC rankings on nwbaseballstats.com.
// PPI is a 0-100ish power index. Cache lives in scripts/gm/nwac_ppi_cache.json;
// refresh by re-running the cache pull (see the cache file's _meta).

function loadNwacFromPpiCache() {
  const ppiPath = path.join(__dirname, 'nwac_ppi_cache.json')
  if (!fs.existsSync(ppiPath)) return null
  const raw = JSON.parse(fs.readFileSync(ppiPath, 'utf8'))
  const list = raw.teams || []
  // Map PPI (range ~30..75) to our -15..+15 strength scale.
  //   PPI 50 → strength 0  (median NWAC)
  //   PPI 75 → strength 7.5 (top NWAC — Everett-tier)
  //   PPI 30 → strength -6  (bottom NWAC)
  // Slope: (ppi - 50) * 0.3
  return list.map(t => ({
    id: 'nwac-' + slugify(t.short_name),
    name: t.short_name,
    city: t.city || '',
    state: t.state || '',
    nickname: '',
    strength: Math.round(((t.ppi ?? 50) - 50) * 0.3 * 10) / 10,
    ppi: t.ppi,
    ppiRank: t.ppi_rank,
    subConference: t.conference_abbrev,   // NWAC-N / NWAC-S / NWAC-E / NWAC-W
    colors: null,
  }))
}

function loadExistingNwac() {
  // Prefer the live PPI feed (28 teams w/ real ratings). Falls back to the
  // existing static list if the cache isn't present.
  const ppiList = loadNwacFromPpiCache()
  if (ppiList && ppiList.length > 0) return ppiList
  try {
    const existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'))
    return (existing.divisions || []).find(d => d.id === 'JUCO_NWAC')?.teams || []
  } catch (e) {
    return []
  }
}

// ─── Assemble final JSON ──────────────────────────────────────────────────

const d1Pear = loadPear('d1')
const d2Pear = loadPear('d2')
const d3Pear = loadPear('d3')
const naiaPear = loadPear('naia')

const d1Teams = d1Pear.map(r => mkTeam(r, 'd1'))
const d2Teams = d2Pear.map(r => mkTeam(r, 'd2'))
const d3Teams = d3Pear.map(r => mkTeam(r, 'd3'))

const out = {
  _meta: {
    purpose: 'Non-NAIA programs (D1/D2/D3 + JUCOs). Pulled directly from PEAR (pearatings.com).',
    scope: 'Comprehensive — every D1/D2/D3 baseball program tracked by PEAR + the existing PNW JUCO list.',
    fields: 'strength = PEAR power_rating (per-division). nwbbRating.nonNaiaToUniversal() adds the tier base when computing universal cross-division ratings.',
    sourceNotes: 'PEAR API: /api/cbase/ratings (D1), /api/d2-cbase/ratings, /api/d3-cbase/ratings, /api/naia-cbase/ratings. Cached in scripts/gm/pear_cache/ — refresh by re-running this script.',
    naiaSource: 'NAIA teams live in frontend/src/gm/data/pear_ratings_2026.json (loaded separately by engine/rankings.js). Verified count: ' + naiaPear.length + ' NAIA teams from PEAR.',
    generated: new Date().toISOString().slice(0, 10),
    counts: { D1: d1Teams.length, D2: d2Teams.length, D3: d3Teams.length, NAIA_via_pear_ratings_2026: naiaPear.length },
  },
  divisions: [
    { id: 'D1', name: 'NCAA Division I',  teams: d1Teams },
    { id: 'D2', name: 'NCAA Division II', teams: d2Teams },
    { id: 'D3', name: 'NCAA Division III', teams: d3Teams },
    { id: 'JUCO_NWAC', name: 'Northwest Athletic Conference (JUCO)', teams: loadExistingNwac() },
  ],
}

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2))
console.log(`Wrote ${OUT_PATH}`)
console.log(`  D1: ${d1Teams.length}`)
console.log(`  D2: ${d2Teams.length}`)
console.log(`  D3: ${d3Teams.length}`)
console.log(`  JUCO_NWAC: ${out.divisions[3].teams.length}`)
console.log(`  TOTAL non-NAIA: ${d1Teams.length + d2Teams.length + d3Teams.length + out.divisions[3].teams.length}`)
console.log(`  NAIA in pear_ratings_2026.json (separate file): ${naiaPear.length}`)
console.log(`  GRAND TOTAL accessible to rating engine: ${d1Teams.length + d2Teams.length + d3Teams.length + out.divisions[3].teams.length + naiaPear.length}`)
