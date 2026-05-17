/**
 * Ranking algorithm.
 *
 * Two modes:
 *   1. seedFromPear()  — Year 1, before any sim games — use PEAR ratings directly
 *   2. computeFromSeason(games)  — after each week (or end of year) — iterative
 *      SOS-adjusted recomputation from simulated game results
 *
 * See ../docs/rankings.md for the design.
 */

import pearRaw from '../data/pear_ratings_2026.json'

/** @typedef {import('./types.js').School} School */

/** @typedef TeamRating
 *  @property {string} schoolId
 *  @property {number} offense_rating   // z-score; mean 0, stddev ~1
 *  @property {number} pitching_rating
 *  @property {number} defense_rating
 *  @property {number} overall_rating
 *  @property {number} sos_index        // 0-100; 100 = hardest SOS
 *  @property {number} nationalRank     // 1 = best
 *  @property {string} confName
 */

// ─── Match PEAR teams to our schoolIds ───────────────────────────────────────

/**
 * Normalize a team name down to "core letters + digits" so two names that
 * are conceptually the same (e.g. "Lewis-Clark State" and "Lewis-Clark (ID)")
 * collapse to the same key.
 *
 * Steps:
 *  1. lowercase
 *  2. Saint ↔ St
 *  3. drop parenthetical suffix "(ID)" / "(MO)" / "(St. Louis)" etc.
 *  4. & → and
 *  5. drop common collegiate suffix words (state, university, college)
 *     so PEAR's truncated "Bismarck St" matches our "Bismarck State"
 *  6. strip everything else to letters/digits
 */
function normalize(name) {
  if (!name) return ''
  let s = name.toLowerCase()
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bst\.\b/g, 'st')         // "St." → "st"
    .replace(/\s*\([^)]*\)/g, '')       // strip parenthetical
    .replace(/&/g, 'and')
    .replace(/\bstate\b/g, '')          // "Bismarck State" → "Bismarck"
    .replace(/\buniversity\b/g, '')
    .replace(/\bcollege\b/g, '')
    .replace(/\bchristian\b/g, '')      // "Blue Mountain Christian" → "Blue Mountain"
    .replace(/\binternational\b/g, '')
  // Trailing " st" (State abbreviation) — drop it AFTER state was stripped.
  // Catches PEAR's "Bismarck St" / "Panhandle St" variant.
  s = s.replace(/\s+st\b/, '')
  return s.replace(/[^a-z0-9]/g, '').trim()
}

const PEAR_BY_NORMALIZED = (pearRaw.stats || []).reduce((acc, row) => {
  acc[normalize(row.Team)] = row
  return acc
}, {})

/**
 * Hand-curated aliases for the few teams whose normalized name still doesn't
 * match PEAR's representation (acronyms, "Nazarene" suffixes, etc.).
 */
const PEAR_ALIASES = {
  'mount-vernon-nazarene': 'Mount Vernon (OH)',
  'iu-east': 'Indiana East',
  'iu-southeast': 'Indiana Southeast',
  'iu-south-bend': 'IU South Bend',
  'loyola-no': 'Loyola (LA)',
  'oklahoma-panhandle': 'Panhandle State',
  'unoh': 'Northwestern (OH)',
  'columbia-international': 'CIU (SC)',
  'rochester-christian': 'Rochester (MI)',
  'hesston': 'Hesston College',
  'new-college-fl': 'New College (FL)',
  'webber-international': 'Webber (FL)',
  'blue-mountain-christian': 'Blue Mountain (MS)',
  'bismarck-state': 'Bismarck St',
  'calumet-st-joseph': 'Calumet (IN)',
  'our-lady-lake': 'Our Lady Lake',
  'voorhees': 'Voorhees University',
}

function pearForSchool(school) {
  if (!school) return null
  if (PEAR_ALIASES[school.id]) {
    const key = normalize(PEAR_ALIASES[school.id])
    if (PEAR_BY_NORMALIZED[key]) return PEAR_BY_NORMALIZED[key]
  }
  const tries = [
    school.name,
    school.name.replace(/\bSaint\b/g, 'St.'),
    `${school.name} (${school.state})`,
  ]
  for (const t of tries) {
    const key = normalize(t)
    if (PEAR_BY_NORMALIZED[key]) return PEAR_BY_NORMALIZED[key]
  }
  return null
}

/**
 * Seed ratings from PEAR's 2025-26 final values.
 * Used at the start of Year 1 of a dynasty (before any simulated games).
 *
 * @param {Object<string,School>} schools
 * @param {Object<string,import('./types.js').Conference>} conferences
 * @returns {Object<string, TeamRating>}
 */
export function seedFromPear(schools, conferences) {
  /** @type {Object<string, TeamRating>} */
  const out = {}

  for (const school of Object.values(schools)) {
    const pear = pearForSchool(school)
    const offense = pear?.oWAR_z ?? 0
    const pitching = pear?.pWAR_z ?? 0
    const fWAR = pear?.fWAR ?? 0
    // fWAR isn't z-scored, so normalize it ourselves (range ~-3 to +5)
    const defense = fWAR / 2.5

    const overall = pear?.Rating ?? 0 // already a composite; range -15 to +8

    const sos_raw = pear?.SOS ?? 100
    // SOS rank 1 = hardest. Convert to 0-100 where 100 = hardest.
    const sos_index = Math.max(0, 100 - (sos_raw / 200) * 100)

    out[school.id] = {
      schoolId: school.id,
      offense_rating: offense,
      pitching_rating: pitching,
      defense_rating: defense,
      overall_rating: overall,
      sos_index,
      nationalRank: 0,   // filled in after sort
      _prr: pear?.PRR ?? null,    // PEAR Rank straight from the data file
      confName: conferences[school.conferenceId]?.name || '',
    }
  }

  return assignRanks(out)
}

/**
 * After every team has a rating, sort by overall and assign nationalRank.
 * For PEAR-seeded year 1, we prefer the PRR field (PEAR Rank, the same
 * number shown on pearatings.com) so our rankings match the website
 * exactly. Falls back to Rating-sort for schools missing PRR.
 */
function assignRanks(ratings) {
  const sorted = Object.values(ratings).sort((a, b) => {
    // Use PRR (preserved on the rating via pearForSchool) if both have it
    const aprr = a._prr ?? null
    const bprr = b._prr ?? null
    if (aprr != null && bprr != null) return aprr - bprr   // 1 = best
    if (aprr != null) return -1
    if (bprr != null) return 1
    return b.overall_rating - a.overall_rating
  })
  sorted.forEach((r, i) => { r.nationalRank = i + 1 })
  return ratings
}

/**
 * Compute ratings iteratively from a season's worth of game results.
 * For Year 2+ of the dynasty (after we have our own simulated games).
 *
 * @param {Object<string,School>} schools
 * @param {Object<string,import('./types.js').Conference>} conferences
 * @param {Array<{ homeId: string, awayId: string, homeRuns: number, awayRuns: number, homePA: number, awayPA: number }>} games
 * @param {Object<string,TeamRating>} priorRatings   // last season's ratings as initial guess
 * @returns {Object<string, TeamRating>}
 */
export function computeFromSeason(schools, conferences, games, priorRatings) {
  /** @type {Object<string, { rs: number, ra: number, gp: number, pa_for: number, pa_against: number, opponents: string[] }>} */
  const agg = {}
  for (const id of Object.keys(schools)) {
    agg[id] = { rs: 0, ra: 0, gp: 0, pa_for: 0, pa_against: 0, opponents: [] }
  }

  for (const g of games) {
    if (!agg[g.homeId] || !agg[g.awayId]) continue
    agg[g.homeId].rs += g.homeRuns; agg[g.homeId].ra += g.awayRuns
    agg[g.homeId].pa_for += g.homePA; agg[g.homeId].pa_against += g.awayPA
    agg[g.homeId].gp += 1; agg[g.homeId].opponents.push(g.awayId)
    agg[g.awayId].rs += g.awayRuns; agg[g.awayId].ra += g.homeRuns
    agg[g.awayId].pa_for += g.awayPA; agg[g.awayId].pa_against += g.homePA
    agg[g.awayId].gp += 1; agg[g.awayId].opponents.push(g.homeId)
  }

  // Initial raw ratings
  /** @type {Object<string,TeamRating>} */
  const ratings = {}
  const all = Object.values(schools)
  const meanRpg = mean(all.map(s => agg[s.id].gp > 0 ? agg[s.id].rs / agg[s.id].gp : 5))
  const meanRapg = mean(all.map(s => agg[s.id].gp > 0 ? agg[s.id].ra / agg[s.id].gp : 5))
  const sdRpg = stddev(all.map(s => agg[s.id].gp > 0 ? agg[s.id].rs / agg[s.id].gp : meanRpg))
  const sdRapg = stddev(all.map(s => agg[s.id].gp > 0 ? agg[s.id].ra / agg[s.id].gp : meanRapg))

  for (const s of all) {
    const a = agg[s.id]
    const rpg = a.gp > 0 ? a.rs / a.gp : meanRpg
    const rapg = a.gp > 0 ? a.ra / a.gp : meanRapg
    const prior = priorRatings?.[s.id]
    ratings[s.id] = {
      schoolId: s.id,
      offense_rating: sdRpg > 0 ? (rpg - meanRpg) / sdRpg : (prior?.offense_rating ?? 0),
      pitching_rating: sdRapg > 0 ? (meanRapg - rapg) / sdRapg : (prior?.pitching_rating ?? 0),
      defense_rating: prior?.defense_rating ?? 0,  // defense needs FIP/BABIP; punt to v2
      overall_rating: 0,
      sos_index: 0,
      nationalRank: 0,
      confName: conferences[s.conferenceId]?.name || '',
    }
  }

  // Iterate: adjust each team's rating by SOS (opponent quality)
  const WEIGHT_SOS = 0.4
  const ITERATIONS = 15

  for (let i = 0; i < ITERATIONS; i++) {
    const updated = {}
    let maxDelta = 0

    for (const s of all) {
      const a = agg[s.id]
      if (a.gp === 0) {
        updated[s.id] = ratings[s.id]
        continue
      }
      // Avg opponent pitching/offense ratings
      const opPitching = mean(a.opponents.map(oid => ratings[oid]?.pitching_rating ?? 0))
      const opOffense = mean(a.opponents.map(oid => ratings[oid]?.offense_rating ?? 0))

      const sosOffense = -opPitching       // facing strong pitching = boost
      const sosPitching = -opOffense        // facing strong offense = boost

      const rpg = a.rs / a.gp
      const rapg = a.ra / a.gp
      const offense = sdRpg > 0
        ? (rpg - meanRpg) / sdRpg + sosOffense * WEIGHT_SOS
        : ratings[s.id].offense_rating
      const pitching = sdRapg > 0
        ? (meanRapg - rapg) / sdRapg + sosPitching * WEIGHT_SOS
        : ratings[s.id].pitching_rating

      const overall = offense + pitching + ratings[s.id].defense_rating * 0.5

      // SOS index for display: average of opponents' overall ratings, normalized
      const opOverall = mean(a.opponents.map(oid => ratings[oid]?.overall_rating ?? 0))
      const sos_index = clamp(50 + opOverall * 10, 0, 100)

      maxDelta = Math.max(maxDelta, Math.abs(overall - ratings[s.id].overall_rating))
      updated[s.id] = {
        ...ratings[s.id],
        offense_rating: offense,
        pitching_rating: pitching,
        overall_rating: overall,
        sos_index,
      }
    }
    for (const k of Object.keys(updated)) ratings[k] = updated[k]
    if (maxDelta < 0.001) break
  }

  return assignRanks(ratings)
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

function mean(arr) {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function stddev(arr) {
  if (arr.length < 2) return 0
  const m = mean(arr)
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length
  return Math.sqrt(variance)
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

/**
 * For UI display: rank a team's offense among all 200 schools.
 * Returns {1..N, total}.
 */
export function pillarRank(ratings, schoolId, pillar) {
  const sorted = Object.values(ratings).sort((a, b) => b[pillar] - a[pillar])
  const idx = sorted.findIndex(r => r.schoolId === schoolId)
  return { rank: idx + 1, total: sorted.length }
}
