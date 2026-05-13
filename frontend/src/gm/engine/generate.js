/**
 * Player generator.
 *
 * Generates a 35-man roster for a given school, scaled to the school's
 * `programHistory` (which is seeded from PEAR rating). Stronger programs
 * produce rosters with higher mean ratings and higher mean potentials.
 *
 * See ../docs/attributes.md for the rating model.
 */

import { makeRng } from './rng'
import { pickFullName } from './names'
import { initialAcademicState } from './academics'
import { pickCityForState } from './cities'

/** @typedef {import('./types.js').Player} Player */
/** @typedef {import('./types.js').Position} Position */
/** @typedef {import('./types.js').School} School */
/** @typedef {import('./types.js').HitterRatings} HitterRatings */
/** @typedef {import('./types.js').PitcherRatings} PitcherRatings */
/** @typedef {import('./types.js').ClassYear} ClassYear */

// ─── Class distribution targets ──────────────────────────────────────────────

// Roughly 25% FR / 28% SO / 25% JR / 22% SR — sums to a base of 45. Actual
// roster size varies 40-50 (small jitter applied per school).
const CLASS_TARGETS = { FR: 12, SO: 12, JR: 11, SR: 10 }

// Minimum-roster targets per spec: 4 C, 21 P, 8 IF, 7 OF. We exceed those
// minimums in the base counts and pad the rest with bench hitters.
const POSITION_TARGETS = {
  // Catchers — 4 mandatory
  C: 4,
  // Infield — 8 total (2 per spot)
  '1B': 2, '2B': 2, SS: 2, '3B': 2,
  // Outfield — 7 total
  LF: 2, CF: 3, RF: 2,
  // DH
  DH: 1,
  // Pitchers — 21 total: 9 SP + 12 RP
  SP: 9, RP: 12,
  // Remaining slots padded with bench position players later
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * Mean rating per "slot tier" — most NAIA STARTERS sit in 60-90 OVR;
 * depth/bench guys can range 45-65; redshirts/bottom-of-roster around 40-55.
 *
 * @param {number} programHistory   0-100
 * @param {'starter'|'bench'|'depth'} slotTier
 */
function meanRatingFor(programHistory, slotTier = 'bench') {
  // Program strength shifts by ±8 (elite vs SHOESTRING)
  const programShift = (programHistory - 50) * 0.16   // -8 to +8
  if (slotTier === 'starter') return 70 + programShift   // 62-78 for typical bushnell starter
  if (slotTier === 'bench')   return 60 + programShift
  return 52 + programShift                                // depth
}

/**
 * Potential gap by class year. Freshmen have huge potential gaps; seniors barely.
 */
function potentialGapFor(classYear) {
  return { FR: 14, SO: 10, JR: 5, SR: 1 }[classYear]
}

/**
 * Apply a "star-player" outlier bump to a slot's mean rating. ~8% of starters
 * across the league are blue-chip prospects with elite ratings regardless of
 * their program's overall strength. Bushnell may not field a 75+ overall as
 * its #5, but every team should occasionally produce a stud.
 */
function applyStarBump(mean, slotTier, rng) {
  if (slotTier !== 'starter') return mean
  // 8% chance of a star (mean 84 → 78-90 range)
  if (rng.chance(0.08)) return Math.max(mean, 84)
  // 18% chance of a quality starter (mean 76)
  if (rng.chance(0.18)) return Math.max(mean, 76)
  return mean
}

/**
 * Generate a HitterRatings block.
 */
function generateHitterRatings(programHistory, classYear, isPureHitter, slotTier, rng) {
  let mean = meanRatingFor(programHistory, slotTier) - (isPureHitter ? 0 : 10)
  mean = applyStarBump(mean, slotTier, rng)
  const stddev = slotTier === 'starter' ? 7 : 9
  const r = () => Math.round(clamp(rng.gaussian(mean, stddev), 30, 95))
  return {
    contact_l: r(), contact_r: r(),
    power_l:   r(), power_r:   r(),
    discipline: r(), speed:    r(),
    fielding:  r(), arm:       r(),
  }
}

function generatePitcherRatings(programHistory, classYear, isPurePitcher, slotTier, rng) {
  let mean = meanRatingFor(programHistory, slotTier) - (isPurePitcher ? 0 : 10)
  mean = applyStarBump(mean, slotTier, rng)
  const stddev = slotTier === 'starter' ? 7 : 9
  const r = () => Math.round(clamp(rng.gaussian(mean, stddev), 30, 95))

  // Stamina: bias upward so most pitchers can throw 4+ innings; pure
  // 1-inning relievers are rarer. Then apply a velocity-driven penalty
  // (high velo trades off stamina unless the pitcher is elite).
  const stuff = r()
  const control = r()
  const command = r()
  const baseStamina = Math.round(clamp(rng.gaussian(mean + 10, stddev - 1), 30, 95))

  // Velocity: 75-96 mph range, mean 84-85, narrow per-pitcher band 4-5 mph.
  // Heat correlates loosely with stuff; truly elite pitchers can have both
  // velocity and stamina.
  const stuffBoost = (stuff - 60) * 0.20      // stuff 60 → 0, stuff 90 → +6
  const veloMean = clamp(83.5 + stuffBoost + rng.gaussian(0, 1.6), 75, 96)
  const velocity_avg = Math.round(veloMean * 10) / 10
  const veloSpread = clamp(rng.gaussian(2, 0.6), 1, 4)
  const velocity_min = Math.round((veloMean - veloSpread) * 10) / 10
  const velocity_max = Math.round((veloMean + veloSpread) * 10) / 10

  // Stamina penalty: high velo → cost. Elites (stuff 85+) exempt.
  let stamina = baseStamina
  if (stuff < 85) {
    const veloPenalty = Math.max(0, (velocity_avg - 88) * 3.5)  // velocity 88+ starts costing stamina
    stamina = clamp(baseStamina - veloPenalty, 25, 95)
  }
  stamina = Math.round(stamina)

  return {
    stuff, control, command,
    stamina,
    vs_l: r(), vs_r: r(),
    composure: r(), durability: r(),
    velocity_avg, velocity_min, velocity_max,
  }
}

/**
 * Derive potential ratings by bumping each current rating by a class-dependent
 * gap. Velocity-related fields are not 0-99 ratings; skip them.
 *
 * Adds occasional "raw prospect" outliers: ~12% of FR/SO get a much bigger
 * potential gap (+25 to +40), so the league has low-OVR/high-pot dev
 * targets. Without this, OVR and potential were too tightly coupled.
 */
function generatePotential(currentRatings, classYear, rng) {
  const baseGap = potentialGapFor(classYear)
  const isRawProspect = (classYear === 'FR' || classYear === 'SO') && rng.chance(0.12)
  const gap = isRawProspect ? baseGap + rng.int(15, 25) : baseGap
  const out = {}
  for (const [k, v] of Object.entries(currentRatings)) {
    if (k.startsWith('velocity')) { out[k] = v; continue }   // not a rating
    const bump = Math.round(rng.gaussian(gap, 5))
    out[k] = clamp(v + Math.max(0, bump), v, 99)
  }
  return out
}

// ─── Birth date / hometown helpers ───────────────────────────────────────────

/**
 * Birthdate for a player given their class year. Plausible college baseball age range.
 * @param {ClassYear} classYear
 * @param {number} currentYear
 */
function generateBirthdate(classYear, currentYear, rng) {
  // FR ≈ 18-19, SO ≈ 19-20, JR ≈ 20-22 (JUCO transfer common), SR ≈ 21-23
  const ageRanges = { FR: [18, 19], SO: [19, 20], JR: [20, 22], SR: [21, 23] }
  const [minAge, maxAge] = ageRanges[classYear]
  const age = rng.int(minAge, maxAge)
  const birthYear = currentYear - age - 1  // -1 because most CB players' birthdays are mid-year
  const month = rng.int(1, 12)
  const day = rng.int(1, 28)
  return `${birthYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Pick a hometown. 65% chance of in-state (regional realism), 35% chance elsewhere
 * with a bias toward the school's region.
 */
function generateHometown(school, rng) {
  const regionalStates = {
    NW: ['WA', 'OR', 'ID', 'MT'],
    W:  ['CA', 'NV', 'AZ', 'UT'],
    SW: ['TX', 'OK', 'NM', 'AR', 'LA'],
    MW: ['IL', 'IN', 'IA', 'MO', 'KS', 'NE', 'MI', 'OH', 'WI', 'MN'],
    SE: ['FL', 'GA', 'AL', 'MS', 'TN', 'NC', 'SC', 'KY'],
    NE: ['NY', 'PA', 'NJ', 'CT', 'MA'],
  }
  const inState = rng.chance(0.55)
  const state = inState
    ? school.state
    : rng.pick(regionalStates[school.region] || ['IL'])
  return { city: pickCityForState(state, rng), state }
}

// ─── Roster generation ───────────────────────────────────────────────────────

/**
 * Build the class year sequence for the 35-man roster.
 */
function makeClassYearList() {
  /** @type {ClassYear[]} */
  const out = []
  for (const [yr, count] of Object.entries(CLASS_TARGETS)) {
    for (let i = 0; i < count; i++) out.push(yr)
  }
  return out
}

/**
 * Build a list of 35 (position, isPitcher) tuples for the roster.
 */
function makeRosterPositionList(rng) {
  const list = []
  for (const [pos, count] of Object.entries(POSITION_TARGETS)) {
    for (let i = 0; i < count; i++) {
      const isPitcher = pos === 'SP' || pos === 'RP'
      list.push({ position: pos, isPitcher })
    }
  }
  while (list.length < 50) {
    list.push({ position: rng.pick(['1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF']), isPitcher: false })
  }
  // CRITICAL: interleave so the first 14 (starter tier) get both hitters
  // AND pitchers. Was: all hitters first, then pitchers → no pitcher ever
  // landed in the 'starter' tier and their OVRs were systematically lower.
  // Now: 9 starting hitters (C/1B/2B/SS/3B/LF/CF/RF/DH) + 5 SP rotation up
  // front, then the rest.
  const startingHitters = []
  const startingPitchers = []
  const rest = []
  const startingPitcherTaken = { SP: 0 }
  const startingHitterPosTaken = {}
  const STARTING_HITTER_POSITIONS = ['C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF', 'DH']
  for (const slot of list) {
    if (slot.position === 'SP' && startingPitchers.length < 5) {
      startingPitchers.push(slot)
    } else if (!slot.isPitcher && STARTING_HITTER_POSITIONS.includes(slot.position) &&
               !startingHitterPosTaken[slot.position]) {
      startingHitters.push(slot)
      startingHitterPosTaken[slot.position] = true
    } else {
      rest.push(slot)
    }
    if (startingHitters.length >= 9 && startingPitchers.length >= 5) {
      // Already have the starting lineup + rotation; everything else is bench/depth
      // but we still need to add remaining slots
    }
  }
  return [...startingHitters, ...startingPitchers, ...rest]
}

/**
 * Generate a single Player.
 * @param {School} school
 * @param {{ position: Position, isPitcher: boolean, classYear: ClassYear, slotTier?: 'starter'|'bench'|'depth' }} slot
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @param {number} currentYear
 * @param {number} idx
 * @returns {Player}
 */
export function generatePlayer(school, slot, rng, currentYear, idx) {
  const region = school.region
  const { first, last } = pickFullName(rng, region)
  const isPitcher = slot.isPitcher
  const isHitter = !isPitcher
  const seasonsUsedMap = { FR: 0, SO: 1, JR: 2, SR: 3 }
  const slotTier = slot.slotTier || 'bench'

  const hitter = generateHitterRatings(school.programHistory, slot.classYear, !isPitcher, slotTier, rng)
  const pitcher = generatePitcherRatings(school.programHistory, slot.classYear, isPitcher, slotTier, rng)

  // Raw-prospect chance: ~12% of FR/SO get an additional current-rating
  // suppression. This widens the gap between current rating and potential
  // — so the league has low-OVR/high-pot dev targets you can develop.
  if ((slot.classYear === 'FR' || slot.classYear === 'SO') && rng.chance(0.12)) {
    const drop = rng.int(8, 18)
    for (const k of Object.keys(hitter)) hitter[k] = clamp(hitter[k] - drop, 25, 99)
    for (const k of Object.keys(pitcher)) {
      if (!k.startsWith('velocity')) pitcher[k] = clamp(pitcher[k] - drop, 25, 99)
    }
  }

  const potential_hitter = generatePotential(hitter, slot.classYear, rng)
  const potential_pitcher = generatePotential(pitcher, slot.classYear, rng)

  const hidden = {
    potential_hitter,
    potential_pitcher,
    work_ethic: rng.int(40, 95),
    clutch: rng.int(30, 90),
    injury_prone: rng.int(20, 80),
    loyalty: rng.int(30, 90),
    // Aptitude calibrated so team-mean GPA lands ~2.8-3.2: gaussian mean 70,
    // sd 14, clamped 30-99. With initialAcademicState's 0.5 + (apt/99)*3.0
    // map, mean ~2.6-3.0 per player; high-side outliers push team avg up.
    academic_aptitude: Math.round(clamp(rng.gaussian(70, 14), 30, 99)),
  }
  const academic = initialAcademicState({ hidden }, rng)

  return {
    id: `${school.id}_p_${idx}_${rng.int(1000, 9999)}`,
    firstName: first,
    lastName: last,
    birthDate: generateBirthdate(slot.classYear, currentYear, rng),
    hometown: generateHometown(school, rng),
    schoolId: school.id,
    previousSchoolName: null,
    previousLeagueId: null,
    classYear: slot.classYear,
    seasonsUsed: seasonsUsedMap[slot.classYear],
    semestersUsed: seasonsUsedMap[slot.classYear] * 2,
    eligibilityStatus: 'eligible',
    primaryPosition: slot.position,
    positions: [slot.position],
    bats: rng.weighted(['R', 'L', 'S'], [70, 22, 8]),
    throws: rng.weighted(['R', 'L'], [80, 20]),
    isPitcher,
    isHitter,
    hitter,
    pitcher,
    hidden,
    scholarship: {
      annualAmount: estimateScholarship(school, hitter, pitcher, isPitcher, potential_hitter, potential_pitcher, rng),
      yearsCommitted: rng.int(1, 4),
    },
    gpa: academic.gpa,
    academicStanding: academic.academicStanding,
  }
}

/**
 * Realistic scholarship $ — weighted toward POTENTIAL (what the coach saw
 * during recruiting) more than current rating. Recruits commit before their
 * college reps; their scholarship $ reflects projection, not what they
 * happen to be RIGHT NOW. Imperfect correlation: every roster has some
 * busts on real money and some bargains.
 *
 * Calibration: Bushnell (MID) mean ~$5K/player; tier multipliers spread
 * D1_LITE to SHOESTRING.
 */
function estimateScholarship(school, hitter, pitcher, isPitcher, potentialHitter, potentialPitcher, rng) {
  const block = isPitcher ? pitcher : hitter
  const potBlock = isPitcher ? (potentialPitcher || pitcher) : (potentialHitter || hitter)
  const avgRatings = (b) => {
    const vals = Object.values(b).filter(v => typeof v === 'number' && v < 100)
    return vals.reduce((a, b) => a + b, 0) / vals.length
  }
  const cur = avgRatings(block)
  const pot = avgRatings(potBlock)
  // 70% potential, 30% current — coach pays for projection
  const projectedAvg = pot * 0.7 + cur * 0.3
  // Heavy randomness so the same projection produces a spread of offers
  const noisy = projectedAvg + rng.gaussian(0, 8)
  const tierMult = { D1_LITE: 1.5, WELL_FUNDED: 1.1, MID: 0.85, SHOESTRING: 0.5 }[school.resourceTier] || 1.0
  let baseAmount
  if (noisy >= 80)      baseAmount = 11000 + (noisy - 80) * 550
  else if (noisy >= 70) baseAmount = 6000 + (noisy - 70) * 500
  else if (noisy >= 60) baseAmount = 3000 + (noisy - 60) * 300
  else if (noisy >= 50) baseAmount = 800 + (noisy - 50) * 220
  else                  baseAmount = 0
  return Math.max(0, Math.round(baseAmount * tierMult))
}

/**
 * Generate a roster for a school. Total size varies 40–50 (per-school jitter).
 *
 * Slot tiers determine rating distribution:
 *   - First 14 players are STARTERS (~60-90 OVR — the everyday lineup + rotation)
 *   - Next ~15 are BENCH (~50-70 OVR — fill-ins, middle relief)
 *   - Remainder are DEPTH (~40-60 OVR — redshirts, walk-ons)
 *
 * @param {School} school
 * @param {number} seed   master save seed
 * @param {number} [currentYear=2026]
 * @returns {Player[]}
 */
export function generateRoster(school, seed, currentYear = 2026) {
  const rng = makeRng('roster', school.id, seed)
  const rosterSize = rng.int(40, 50)
  const positions = makeRosterPositionList(rng)
  const classYears = makeClassYearList()
  shuffleInPlace(classYears, rng)
  // makeClassYearList sums to 45; extend with random class years if rosterSize > 45.
  while (classYears.length < rosterSize) {
    classYears.push(rng.weighted(['FR', 'SO', 'JR', 'SR'], [12, 12, 11, 10]))
  }

  /** @type {Player[]} */
  const roster = []
  for (let i = 0; i < rosterSize; i++) {
    const slotTier = i < 14 ? 'starter' : i < 29 ? 'bench' : 'depth'
    const slot = { ...positions[i], classYear: classYears[i], slotTier }
    roster.push(generatePlayer(school, slot, rng, currentYear, i))
  }
  return roster
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}
