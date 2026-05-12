/**
 * Load and hydrate schools data.
 *
 * Combines:
 *   - schools.json  → canonical NAIA program list (199 schools, 21 conferences)
 *   - pear_ratings_2026.json → real-world strength rating per program
 *   - Tier heuristics → tuition, room+board, scholarship pool, facility rating
 *
 * Output: a Map of School records ready for the engine.
 *
 * See ../docs/school_resources.md for the design.
 */

import schoolsRaw from '../data/schools.json'
import pearRaw from '../data/pear_ratings_2026.json'

// ─── PEAR ↔ schools.json name reconciliation ─────────────────────────────────
//
// PEAR names schools slightly differently than our schools.json. Examples:
//   schools.json: "Lewis-Clark State"   ↔  PEAR: "Lewis-Clark (ID)"
//   schools.json: "Tennessee Wesleyan"  ↔  PEAR: "Tennessee Wesleyan"
//   schools.json: "Saint Mary (KS)"     ↔  PEAR: "St. Mary (KS)"
//
// We do (1) exact match, then (2) normalized match (strip parens, "St."→"Saint", lowercase).
// Anything still unmatched gets a default "average" rating with a console.warn.

const PEAR_RATINGS = (pearRaw.stats || []).reduce((acc, row) => {
  acc[normalizeSchoolName(row.Team)] = row.Rating
  return acc
}, {})

function normalizeSchoolName(name) {
  return name
    .toLowerCase()
    .replace(/\bsaint\b/g, 'st.')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim()
}

function pearRatingForSchool(school) {
  const tries = [
    school.name,
    school.name.replace(/\bSaint\b/g, 'St.'),
    `${school.name} (${school.state})`,
  ]
  for (const t of tries) {
    const key = normalizeSchoolName(t)
    if (PEAR_RATINGS[key] != null) return PEAR_RATINGS[key]
  }
  return null  // unmatched
}

// ─── Hand-coded resource tiers for well-known programs ────────────────────────
//
// Override or add to this list as Nate provides better knowledge.
// Schools not in this map get an automatic tier by heuristic (see assignTier).

const HAND_CODED_TIERS = {
  // D1_LITE — historic powers, top facilities
  'lewis-clark-state':       { tier: 'D1_LITE',     tuition: 7000,  rb: 9500,  facility: 95, academic: 70 },
  'tennessee-wesleyan':      { tier: 'D1_LITE',     tuition: 28000, rb: 11000, facility: 90, academic: 72 },
  'oklahoma-city':           { tier: 'D1_LITE',     tuition: 30000, rb: 11000, facility: 88, academic: 75 },

  // WELL_FUNDED — strong programs, solid resources
  'hope-international':      { tier: 'WELL_FUNDED', tuition: 35000, rb: 13000, facility: 78, academic: 70 },
  'tabor':                   { tier: 'WELL_FUNDED', tuition: 30000, rb: 10500, facility: 75, academic: 70 },
  'faulkner':                { tier: 'WELL_FUNDED', tuition: 27000, rb: 10000, facility: 76, academic: 70 },
  'lsu-shreveport':          { tier: 'WELL_FUNDED', tuition: 8000,  rb: 9000,  facility: 80, academic: 72 },
  'lsu-alexandria':          { tier: 'WELL_FUNDED', tuition: 8000,  rb: 9000,  facility: 78, academic: 70 },
  'college-of-idaho':        { tier: 'WELL_FUNDED', tuition: 34000, rb: 13000, facility: 78, academic: 78 },
  'british-columbia':        { tier: 'WELL_FUNDED', tuition: 25000, rb: 13000, facility: 82, academic: 85 },
  'indiana-wesleyan':        { tier: 'WELL_FUNDED', tuition: 30000, rb: 11000, facility: 78, academic: 75 },
  'taylor':                  { tier: 'WELL_FUNDED', tuition: 38000, rb: 12000, facility: 80, academic: 82 },
  'georgia-gwinnett':        { tier: 'WELL_FUNDED', tuition: 5500,  rb: 9500,  facility: 82, academic: 70 },
  'cumberlands':             { tier: 'WELL_FUNDED', tuition: 26000, rb: 10000, facility: 77, academic: 72 },
  'bellevue':                { tier: 'WELL_FUNDED', tuition: 8000,  rb: 10000, facility: 75, academic: 70 },
  'kansas-wesleyan':         { tier: 'WELL_FUNDED', tuition: 33000, rb: 10000, facility: 75, academic: 70 },
  'southeastern-fl':         { tier: 'WELL_FUNDED', tuition: 28000, rb: 11000, facility: 76, academic: 70 },
  'texas-wesleyan':          { tier: 'WELL_FUNDED', tuition: 29000, rb: 10000, facility: 75, academic: 72 },

  // MID — solid programs, average resources
  'bushnell':                { tier: 'MID',         tuition: 32000, rb: 13000, facility: 70, academic: 72 },
  'corban':                  { tier: 'MID',         tuition: 33000, rb: 12000, facility: 70, academic: 72 },
  'oregon-tech':             { tier: 'MID',         tuition: 12000, rb: 11000, facility: 68, academic: 78 },
  'eastern-oregon':          { tier: 'MID',         tuition: 9500,  rb: 11000, facility: 65, academic: 70 },
  'warner-pacific':          { tier: 'MID',         tuition: 28000, rb: 12000, facility: 60, academic: 65 },
}

// ─── Tier heuristic (for everything not hand-coded) ──────────────────────────

function assignTier(school, pearRating) {
  // Strong PEAR rating → at least WELL_FUNDED
  if (pearRating != null && pearRating >= 4.0) return 'WELL_FUNDED'
  if (pearRating != null && pearRating >= 6.0) return 'D1_LITE'

  // Conference-based hints (top conferences trend higher)
  const topConfs = new Set(['mid-south', 'sooner-athletic', 'crossroads-league',
                            'kansas-collegiate-athletic', 'heart-of-america',
                            'great-plains-athletic'])
  if (topConfs.has(school.conferenceId)) {
    return pearRating != null && pearRating > 0 ? 'WELL_FUNDED' : 'MID'
  }

  // HBCU conference tends to be under-resourced
  if (school.conferenceId === 'hbcu-athletic') return 'SHOESTRING'

  // Default
  if (pearRating != null && pearRating < -5) return 'SHOESTRING'
  return 'MID'
}

const TIER_DEFAULTS = {
  D1_LITE:     { tuitionAvg: 25000, rbAvg: 11000, facilityAvg: 88, academicAvg: 72, equivalencies: 12.0 },
  WELL_FUNDED: { tuitionAvg: 28000, rbAvg: 11000, facilityAvg: 76, academicAvg: 70, equivalencies: 10.5 },
  MID:         { tuitionAvg: 25000, rbAvg: 10500, facilityAvg: 68, academicAvg: 65, equivalencies: 7.5 },
  SHOESTRING:  { tuitionAvg: 22000, rbAvg: 10000, facilityAvg: 58, academicAvg: 60, equivalencies: 4.0 },
}

// ─── State → region map ──────────────────────────────────────────────────────

const STATE_TO_REGION = {
  WA: 'NW', OR: 'NW', ID: 'NW', BC: 'NW', AK: 'NW',
  CA: 'W', NV: 'W', AZ: 'W', HI: 'W',
  MT: 'NW', WY: 'NW', UT: 'W', CO: 'W',
  ND: 'MW', SD: 'MW', NE: 'MW', KS: 'MW', MN: 'MW', IA: 'MW', MO: 'MW', WI: 'MW', IL: 'MW', IN: 'MW', MI: 'MW', OH: 'MW',
  TX: 'SW', OK: 'SW', NM: 'SW', AR: 'SW', LA: 'SW',
  AL: 'SE', MS: 'SE', TN: 'SE', GA: 'SE', FL: 'SE', SC: 'SE', NC: 'SE', KY: 'SE', VA: 'SE', WV: 'SE',
  ME: 'NE', NH: 'NE', VT: 'NE', MA: 'NE', RI: 'NE', CT: 'NE', NY: 'NE', NJ: 'NE', PA: 'NE', MD: 'NE', DE: 'NE', DC: 'NE',
}

// ─── Hydration ───────────────────────────────────────────────────────────────

/**
 * Convert PEAR rating (range ~-15 to +8, mean ~0) → programHistory (0-100).
 * We center on 50, with stddev mapping such that elite programs hit 85-95
 * and bottom programs hit 10-25.
 */
function pearToProgramHistory(pearRating) {
  if (pearRating == null) return 50
  // PEAR mean ≈ 0, stddev ≈ 4; map to 0-100 centered on 50 with stddev ≈ 18
  const value = 50 + (pearRating / 4) * 18
  return Math.max(5, Math.min(95, Math.round(value)))
}

/**
 * Build a single hydrated School from raw inputs.
 * @returns {import('./types.js').School}
 */
function hydrateSchool(rawSchool, conferenceId) {
  const pearRating = pearRatingForSchool(rawSchool)
  const handCoded = HAND_CODED_TIERS[rawSchool.id]
  const tier = handCoded?.tier || assignTier({ ...rawSchool, conferenceId }, pearRating)
  const tierDefault = TIER_DEFAULTS[tier]

  const tuition = handCoded?.tuition ?? tierDefault.tuitionAvg
  const rb = handCoded?.rb ?? tierDefault.rbAvg
  const facility = handCoded?.facility ?? tierDefault.facilityAvg
  const academic = handCoded?.academic ?? tierDefault.academicAvg

  const scholarshipPool = Math.round((tuition + rb) * tierDefault.equivalencies)
  // Coaching budget defaults to ~25% of athletic budget for a typical program.
  // Athletic budget is roughly scholarshipPool / 0.75 in our simple model.
  const coachingBudget = Math.round(scholarshipPool * 0.33)

  return {
    id: rawSchool.id,
    name: rawSchool.name,
    city: rawSchool.city,
    state: rawSchool.state,
    nickname: rawSchool.nickname ?? null,
    colors: rawSchool.colors ?? null,
    conferenceId,
    resourceTier: tier,
    tuitionPerYear: tuition,
    roomAndBoardPerYear: rb,
    scholarshipPool,
    coachingBudget,
    facilityRating: facility,
    programHistory: pearToProgramHistory(pearRating),
    academicReputation: academic,
    region: STATE_TO_REGION[rawSchool.state] ?? 'MW',
    metroSize: 'small',  // default; can override later
    pearRating: pearRating ?? 0,
  }
}

/**
 * Load all schools and conferences in one pass.
 * @returns {{
 *   schools: Object<string, import('./types.js').School>,
 *   conferences: Object<string, import('./types.js').Conference>,
 *   unmatchedFromPear: string[]
 * }}
 */
export function loadSchools() {
  /** @type {Object<string, import('./types.js').School>} */
  const schools = {}
  /** @type {Object<string, import('./types.js').Conference>} */
  const conferences = {}

  for (const conf of schoolsRaw.conferences) {
    const schoolIds = []
    for (const rawSchool of conf.schools) {
      const hydrated = hydrateSchool(rawSchool, conf.id)
      schools[hydrated.id] = hydrated
      schoolIds.push(hydrated.id)
    }
    conferences[conf.id] = {
      id: conf.id,
      name: conf.name,
      abbreviation: conf.abbreviation,
      sponsorsBaseball: conf.sponsorsBaseball,
      hasConferenceTournament: conf.hasConferenceTournament,
      typicalNationalQualifiers: conf.typicalNationalQualifiers ?? 1,
      schoolIds,
    }
  }

  // Track any PEAR teams we didn't match — useful for debugging
  const matchedKeys = new Set(
    Object.values(schools)
      .map(s => normalizeSchoolName(s.name))
      .concat(
        Object.values(schools).map(s => normalizeSchoolName(`${s.name} (${s.state})`))
      )
  )
  const unmatchedFromPear = (pearRaw.stats || [])
    .map(row => row.Team)
    .filter(team => !matchedKeys.has(normalizeSchoolName(team)))

  return { schools, conferences, unmatchedFromPear }
}
