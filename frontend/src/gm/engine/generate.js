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
import { composePlayerProfile, enforceArchetypeFloors } from './playerArchetypes'
import { hitterOverall, pitcherOverall } from './playerRating'
import { expectedTeamOvr } from './programRating'

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

// Minimum-roster targets per spec: 4 C, 21 P, 8 IF, 8 OF. DH was dropped —
// every player gets a real defensive position. DH is a lineup-day decision
// the coach makes, not a generated role. The freed slot now goes to OF.
const POSITION_TARGETS = {
  // Catchers — 4 mandatory
  C: 4,
  // Infield — 8 total (2 per spot)
  '1B': 2, '2B': 2, SS: 2, '3B': 2,
  // Outfield — 8 total (was 7; +1 from removed DH slot)
  LF: 2, CF: 3, RF: 3,
  // Pitchers — 21 total: 9 SP + 12 RP
  SP: 9, RP: 12,
  // Remaining slots padded with bench position players later
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * Mean rating per "slot tier", scaled so team OVR (top 9 hitters + top 5
 * pitchers averaged) lands at the user's intuitive expectations:
 *   #1 nationally  (programHistory ~86) → team OVR ~83-85
 *   Bushnell rank ~30 (PH ~63)           → team OVR ~78-80
 *   Mid-pack rank ~100 (PH ~50)          → team OVR ~73
 *   Worst program (PH ~15)               → team OVR ~62-64
 *
 * Star bumps (applyStarBump) layer on top of these means for the 'starter'
 * tier only — about 26% of starters land at a mean of 76+ which pulls the
 * top-9 average up another 2-3 pts above the slot-tier mean.
 *
 * @param {number} programHistory   0-100 (15 worst, 86 top)
 * @param {'starter'|'bench'|'depth'} slotTier
 */
function meanRatingFor(programHistory, slotTier = 'bench', level = 'NAIA') {
  // Slope tuned so PH 15 → 60 starter mean, PH 86 → 79 starter mean.
  const ph = Math.max(15, Math.min(99, programHistory))
  let mean
  if (slotTier === 'starter')      mean = 60 + (ph - 15) * 0.27   // 60..81
  else if (slotTier === 'bench')   mean = 52 + (ph - 15) * 0.18   // 52..67
  else                              mean = 44 + (ph - 15) * 0.12   // 44..54

  // Level shift on the mean — keeps the program's RELATIVE strength
  // (PH-driven) but anchors the absolute level. D1 starters average
  // ~6 OVR above an NAIA equivalent; D3 averages ~4 below.
  // Level-shift on the rating mean. Calibrated against the user's expected
  // Team OVR hierarchy: top D1 ~94, top NAIA ~85, top D3 ~80, top NWAC ~75,
  // worst NWAC ~62. D2 + D3 pushed lower in May 2026 so the bottom of those
  // conferences (Saint Martin's, Willamette) sit below the NAIA floor —
  // the worst D2/D3 programs should feel weaker than the worst NAIA.
  const LEVEL_SHIFT = { D1: 8, D2: 0, NAIA: 0, D3: -4, NWAC: -10 }
  return mean + (LEVEL_SHIFT[level] ?? 0)
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
  // 8% chance of a star (mean 84 78-90 range)
  if (rng.chance(0.08)) return Math.max(mean, 84)
  // 18% chance of a quality starter (mean 76)
  if (rng.chance(0.18)) return Math.max(mean, 76)
  return mean
}

/**
 * Pick a "side dominance" for L/R splits. Tightened May 2026 — old code
 * could spit out power_L 90 / power_R 30 monsters that were basically
 * unplayable. Realistic spread: most hitters within 6 pts side-to-side;
 * a few true platoon guys at 8-10.
 */
function pickSideDominance(rng) {
  return rng.weighted([1, 2, 3, 5, 8], [25, 30, 25, 15, 5])
}

/**
 * Pick which side a hitter is BETTER against based on handedness. Real
 * platoon norms (May 2026 per Nate):
 *   - Right-handed hitters do slightly better vs LHP (~70% of the time)
 *   - Left-handed hitters do better vs RHP (~75% — more pronounced)
 *   - Switch hitters: even split
 *   - REVERSE SPLITS: ~12% of hitters defy the norm (LHH crushes LHP,
 *     RHH crushes RHP). Real-world examples exist for both sides — flag
 *     it on the player so scouting can surface it.
 * Returns { dominantSide, reverseSplit }.
 */
function pickPlatoonDominantSide(bats, rng) {
  // Switch hitters always balanced — no reverse-split concept for them.
  if (bats === 'S') return { dominantSide: rng.chance(0.5) ? 'L' : 'R', reverseSplit: false }
  // 12% of one-side hitters are reverse-split guys.
  const reverseSplit = rng.chance(0.12)
  if (reverseSplit) {
    // Reverse: LHH hits L better, RHH hits R better.
    return { dominantSide: bats === 'L' ? 'L' : 'R', reverseSplit: true }
  }
  // Traditional split.
  if (bats === 'R') return { dominantSide: rng.chance(0.7) ? 'L' : 'R', reverseSplit: false }
  return { dominantSide: rng.chance(0.75) ? 'R' : 'L', reverseSplit: false }
}

/**
 * Generate a HitterRatings block. Uses an archetype profile to bias the
 * means by rating key (so a "Power Bat" actually has high power, not just
 * a high uniform mean). Correlates L/R splits so a player's power_l and
 * power_r live in the same neighborhood.
 *
 * @param {number} programHistory
 * @param {string} classYear
 * @param {boolean} isPureHitter
 * @param {'starter'|'bench'|'depth'} slotTier
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @param {ReturnType<import('./playerArchetypes.js').composePlayerProfile>} [profile]
 */
function generateHitterRatings(programHistory, classYear, isPureHitter, slotTier, rng, profile = null, bats = 'R', level = 'NAIA') {
  let mean = meanRatingFor(programHistory, slotTier, level) - (isPureHitter ? 0 : 10)
  mean = applyStarBump(mean, slotTier, rng)
  // NWAC keeps a modest spread bonus (+2 vs +5 before) — weak JUCO rosters
  // shouldn't have D1-prospect walk-ons floating their Team OVR back into
  // the 70s. The previous +5 was raising Grays Harbor / Douglas etc. to
  // a soft floor in the high 60s; the user reported "the really bad NWAC
  // schools should be closer to 60-65."
  const baseStddev = slotTier === 'starter' ? 9 : 11
  const stddev = level === 'NWAC' ? baseStddev + 2 : baseStddev
  const biases = profile?.biases || {}
  const rollKey = (key, extra = 0) => Math.round(clamp(
    rng.gaussian(mean + (biases[key] || 0) + extra, stddev),
    25, 99,
  ))

  // L/R correlation tied to PLATOON HANDEDNESS — most RHH hit slightly
  // better vs LHP, most LHH hit better vs RHP. ~12% of hitters are reverse
  // split (LHH crushes LHP, RHH crushes RHP) — real-world thing, makes
  // scouting more interesting. Dominance avg ~3 pts, max ~8. Caller reads
  // .__reverseSplit__ off the return then deletes it before persisting.
  const { dominantSide, reverseSplit } = pickPlatoonDominantSide(bats, rng)
  const dominance = pickSideDominance(rng)
  const lDelta = dominantSide === 'L' ? dominance : -dominance
  const rDelta = dominantSide === 'R' ? dominance : -dominance

  const block = {
    contact_l: rollKey('contact_l', lDelta),
    contact_r: rollKey('contact_r', rDelta),
    power_l:   rollKey('power_l',   lDelta),
    power_r:   rollKey('power_r',   rDelta),
    discipline: rollKey('discipline'),
    speed:     rollKey('speed'),
    fielding:  rollKey('fielding'),
    arm:       rollKey('arm'),
    composure: rollKey('composure'),
    durability: rollKey('durability'),
  }
  // Non-enumerable so generatePotential / enforceArchetypeFloors don't see it
  Object.defineProperty(block, '__reverseSplit__', {
    value: reverseSplit, enumerable: false, configurable: true, writable: true,
  })
  return block
}

function generatePitcherRatings(programHistory, classYear, isPurePitcher, slotTier, rng, profile = null, level = 'NAIA') {
  let mean = meanRatingFor(programHistory, slotTier, level) - (isPurePitcher ? 0 : 10)
  mean = applyStarBump(mean, slotTier, rng)
  const baseStddev = slotTier === 'starter' ? 9 : 11
  const stddev = level === 'NWAC' ? baseStddev + 5 : baseStddev
  const biases = profile?.biases || {}
  const rollKey = (key, extra = 0) => Math.round(clamp(
    rng.gaussian(mean + (biases[key] || 0) + extra, stddev),
    25, 99,
  ))

  const stuff = rollKey('stuff')
  const control = rollKey('control')
  const command = rollKey('command')
  // Stamina: bench gets a +10 bias by default. Archetypes (CLOSER_PROFILE)
  // already cut stamina via biases; WORKHORSE bumps it.
  const baseStamina = Math.round(clamp(
    rng.gaussian(mean + 10 + (biases.stamina || 0), stddev - 1),
    25, 99,
  ))

  // VELOCITY DECOUPLED FROM STUFF (May 2026 per Nate).
  //   - Stuff = pitch shape / movement / whiff quality (0-99 rating)
  //   - Velo  = raw mph spread (separate measurable)
  // They were previously linked (high stuff implied high velo, FLAMETHROWER
  // bumped stuff +18). Now an archetype carries an explicit `velocityBias`
  // (mph delta) and stuff is its own rating. A "Crafty Lefty" can throw 84
  // with plus stuff; a "Flamethrower" can throw 96 with average stuff.
  //
  // College baseline velo: 87 mph. Archetype bias shifts that (FLAMETHROWER
  // +5, SOFT_TOSS -8). Body size adds a small additional boost so 6'4+ arms
  // play up. Small stuff correlation kept (+0.05/pt) since high-stuff guys
  // do trend faster in real life, but the link is much weaker than before.
  const velocityBias = profile?.archetype?.velocityBias ?? 0
  const stuffCorrelation = (stuff - 50) * 0.05   // ~+2 mph for stuff 90 vs avg
  const baseVelo = 87 + velocityBias + stuffCorrelation
  const veloMean = clamp(baseVelo + rng.gaussian(0, 1.7), 76, 99)
  const velocity_avg = Math.round(veloMean * 10) / 10
  const veloSpread = clamp(rng.gaussian(2, 0.6), 1, 4)
  const velocity_min = Math.round((veloMean - veloSpread) * 10) / 10
  const velocity_max = Math.round((veloMean + veloSpread) * 10) / 10

  // Stamina velo penalty: hard throwers wear down faster. Velo-only check
  // now (was: gated on stuff <85, but stuff and velo are decoupled).
  let stamina = baseStamina
  const veloPenalty = Math.max(0, (velocity_avg - 91) * 3.0)
  stamina = clamp(baseStamina - veloPenalty, 25, 99)
  stamina = Math.round(stamina)

  return {
    stuff, control, command, stamina,
    vs_l: rollKey('vs_l'),
    vs_r: rollKey('vs_r'),
    composure: rollKey('composure'),
    durability: rollKey('durability'),
    velocity_avg, velocity_min, velocity_max,
  }
}

/**
 * Derive potential ratings — DECOUPLED from current. Every player gets an
 * INDEPENDENT ceiling roll, which can be much higher than their current
 * rating regardless of how good they look right now.
 *
 * This means a 42-OVR walk-on freshman might actually have a 90-OVR ceiling.
 * The user has no way to know without scouting. That's where the "hidden gem"
 * scouting reward comes from.
 *
 * Process per rating key:
 *   1. Roll a CEILING from the league-wide potential distribution
 *      (mean 70, stddev 14 — produces real spread, occasional 95+)
 *   2. Apply a class-year haircut to seniors (less time to develop)
 *   3. Apply a late-bloomer bonus from the archetype if set
 *   4. Floor at current rating (potential can't be BELOW current)
 *
 * Velocity-related fields are not 0-99 ratings; pass through.
 *
 * @param {Object<string,number>} currentRatings
 * @param {string} classYear
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @param {ReturnType<import('./playerArchetypes.js').composePlayerProfile>} [profile]
 */
function generatePotential(currentRatings, classYear, rng, profile = null) {
  // Each player has an overall "ceiling tier" rolled once — controls how
  // high the average ceiling lands across their ratings.
  //   FRANCHISE  (8%):  mean ~90 ceiling — future stars
  //   BLUECHIP  (16%):  mean ~82 ceiling — solid pros
  //   STANDARD  (76%):  mean ~67 ±10 — most players
  // Tuned May 2026 per Nate — more high-potential hidden gems in the pool.
  const tierRoll = rng.chance(0.08) ? 'FRANCHISE' : rng.chance(0.16) ? 'BLUECHIP' : 'STANDARD'
  let tierMean
  if (tierRoll === 'FRANCHISE') tierMean = 90
  else if (tierRoll === 'BLUECHIP') tierMean = 82
  else tierMean = rng.gaussian(67, 10)

  // Senior haircut: SR ceilings cap closer to current (limited time left).
  const seniorHaircut = classYear === 'SR' ? -8 : classYear === 'JR' ? -2 : 0
  // Late bloomer bonus: archetype tag +10 ceiling (was +8)
  const lateBloom = profile?.isLateBloomer ? 10 : 0

  const out = {}
  for (const [k, v] of Object.entries(currentRatings)) {
    if (k.startsWith('velocity')) { out[k] = v; continue }
    // Per-rating jitter widened to 12 (was 8) so a single elite tool is more
    // common — a 70-OVR ceiling guy might have 92 power but 55 contact,
    // making hidden gems easier to spot if you scout for the right stat.
    const ceiling = clamp(
      Math.round(rng.gaussian(tierMean + seniorHaircut + lateBloom, 12)),
      v,    // floor at current
      99,
    )
    out[k] = ceiling
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
  // AND pitchers. Was: all hitters first, then pitchers no pitcher ever
  // landed in the 'starter' tier and their OVRs were systematically lower.
  // Now: 9 starting hitters (C/1B/2B/SS/3B/LF/CF/RF/DH) + 5 SP rotation up
  // front, then the rest.
  const startingHitters = []
  const startingPitchers = []
  const rest = []
  const startingPitcherTaken = { SP: 0 }
  const startingHitterPosTaken = {}
  // DH dropped — every player gets a real defensive position. The coach
  // picks a DH per game from the position-player pool at lineup time.
  const STARTING_HITTER_POSITIONS = ['C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF']
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

  // Compose archetype/frame/quirks first — drives rating profile + measurables.
  const profile = composePlayerProfile({
    position: slot.position, isPitcher, slotTier, rng,
  })

  // Decide handedness FIRST so the rating generator can apply platoon-aware
  // L/R splits (most RHH hit better vs LHP, LHH better vs RHP).
  const bats = rng.weighted(['R', 'L', 'S'], [70, 22, 8])
  const throws = rng.weighted(['R', 'L'], [80, 20])

  const level = school.level || 'NAIA'
  const hitter = generateHitterRatings(school.programHistory, slot.classYear, !isPitcher, slotTier, rng, profile, bats, level)
  const pitcher = generatePitcherRatings(school.programHistory, slot.classYear, isPitcher, slotTier, rng, profile, level)

  // Late-bloomer current-rating suppression: archetype tag drops current
  // ratings ~8-14 points. Combined with the +8 potential bonus this gives
  // late bloomers a real "buy low" feel without burying them.
  if (profile.isLateBloomer) {
    const drop = rng.int(8, 14)
    for (const k of Object.keys(hitter)) hitter[k] = clamp(hitter[k] - drop, 25, 99)
    for (const k of Object.keys(pitcher)) {
      if (!k.startsWith('velocity')) pitcher[k] = clamp(pitcher[k] - drop, 25, 99)
    }
  }

  // Enforce archetype signature-rating floors. A "Defensive Wizard" can't
  // have 55 fielding; a "Power Bat" can't have 50 power. After the random
  // roll, bring weak signature stats up to a believable floor that matches
  // the label the player carries.
  enforceArchetypeFloors(profile.archetype.key, hitter, pitcher)

  const potential_hitter = generatePotential(hitter, slot.classYear, rng, profile)
  const potential_pitcher = generatePotential(pitcher, slot.classYear, rng, profile)

  // ── Measurables ────────────────────────────────────────────────────────
  const measurables = {
    heightInches: profile.measurables.heightInches,
    weightLbs: profile.measurables.weightLbs,
    targetMatureWeightLbs: profile.measurables.targetMatureWeightLbs,
  }
  // Body-size boost: bigger frame higher velo + max EV (long levers).
  const ht = profile.measurables.heightInches
  const sizeBoost = Math.max(0, (ht - 70) * 0.4)
  if (isHitter) {
    const sp = hitter.speed
    // 60-yard: speed 50 7.0 (avg), speed 99 6.41 (elite).
    measurables.sixtyYardSec = Math.round((7.0 - (sp - 50) * 0.012 + rng.gaussian(0, 0.06)) * 100) / 100
    if (slot.position === 'C') {
      // Pop time uses arm (60%) + fielding (40%).
      const blended = hitter.arm * 0.6 + hitter.fielding * 0.4
      measurables.popTimeSec = Math.round((2.10 - (blended - 50) * 0.0075 + rng.gaussian(0, 0.04)) * 100) / 100
    }
    // Max EV: power 30 ~90, power 50 ~96 (avg college), power 70 ~102,
    // power 95+ pushes 110+. College players sit ~+2 mph above HS recruits.
    // Floor at 88 mph — even bench D-tier players cleared NAIA recruiting.
    const pw = Math.max(hitter.power_l, hitter.power_r)
    const maxEvBase = 91 + (pw - 50) * 0.30 + sizeBoost
    measurables.maxEvMph = Math.max(88, Math.round((maxEvBase + rng.gaussian(0, 1.3)) * 10) / 10)
  } else {
    measurables.fbVeloMph = pitcher.velocity_avg
    measurables.fbVeloMinMph = pitcher.velocity_min
    measurables.fbVeloMaxMph = pitcher.velocity_max
  }

  const hidden = {
    potential_hitter,
    potential_pitcher,
    work_ethic: rng.int(40, 95),
    clutch: rng.int(30, 90),
    injury_prone: rng.int(20, 80),
    loyalty: rng.int(30, 90),
    academic_aptitude: Math.round(clamp(rng.gaussian(70, 14), 30, 99)),
    // Archetype + quirks are partially hidden by design — only revealed via
    // extra scouting. Save here so the reveal logic can look them up.
    archetype: profile.archetype.key,
    bodyFrame: profile.frame.key,
    quirks: profile.quirks.map(q => q.key),
    // ~12% of one-side hitters defy the standard platoon norm (LHH crushes
    // LHP, RHH crushes RHP). Hidden so scouting AP can surface it.
    reverseSplit: !!hitter.__reverseSplit__,
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
    bats,
    throws,
    isPitcher,
    isHitter,
    hitter,
    pitcher,
    hidden,
    measurables,
    archetypeKey: profile.archetype.key,    // visible label for the role (e.g. "Power bat")
    bodyFrameKey: profile.frame.key,         // visible body type label
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
export function generateRoster(school, seed, currentYear = 2026, opts = {}) {
  const rng = makeRng('roster', school.id, seed)
  const allowedClassYears = opts.allowedClassYears || ['FR', 'SO', 'JR', 'SR']
  // NWAC + level-aware: when only FR/SO are eligible (JUCO), rosters are
  // smaller than 4-year levels but per Nate (May 2026) must land in the
  // 28-38 band — both sides hard-capped. Was rng.int(24, 30); Everett
  // was generating only 24 players which is short of a real NWAC roster.
  const isJuco = allowedClassYears.length === 2 && !allowedClassYears.includes('JR')
  // Caller can pin the size (used by expansion teams to start lean per Nate
  // June 2026: "it takes time to build up from nothing"). Clamps so we never
  // generate a roster too thin to play games or too fat for the level.
  const rosterSize = opts.targetSize
    ? Math.max(isJuco ? 25 : 28, Math.min(opts.targetSize, isJuco ? 38 : 50))
    : (isJuco ? rng.int(28, 38) : rng.int(40, 50))
  const positions = makeRosterPositionList(rng)
  let classYears
  if (isJuco) {
    // Roughly 50/50 FR/SO
    classYears = []
    for (let i = 0; i < rosterSize; i++) {
      classYears.push(i < rosterSize / 2 ? 'FR' : 'SO')
    }
    shuffleInPlace(classYears, rng)
  } else {
    classYears = makeClassYearList()
    shuffleInPlace(classYears, rng)
    while (classYears.length < rosterSize) {
      classYears.push(rng.weighted(['FR', 'SO', 'JR', 'SR'], [12, 12, 11, 10]))
    }
    // Filter to allowed (no-op for default 4-year levels)
    if (allowedClassYears.length < 4) {
      classYears = classYears.map(cy =>
        allowedClassYears.includes(cy) ? cy : allowedClassYears[rng.int(0, allowedClassYears.length - 1)],
      )
    }
  }

  /** @type {Player[]} */
  const roster = []
  for (let i = 0; i < rosterSize; i++) {
    const slotTier = i < 14 ? 'starter' : i < 29 ? 'bench' : 'depth'
    const slot = { ...positions[i], classYear: classYears[i], slotTier }
    roster.push(generatePlayer(school, slot, rng, currentYear, i))
  }
  // Anchor the roster's natural Team OVR to the program's expected OVR so the
  // in-game hitting / pitching / overall numbers are HONEST (no display-time
  // offset fudge). See scaleRosterToTarget.
  scaleRosterToTarget(roster, school)
  return roster
}

// Rating sub-fields that feed hitterOverall / pitcherOverall. Shifting all of
// them by a constant shifts the computed OVR by that same constant (both are
// weighted averages).
const HITTER_OVR_FIELDS = ['contact_l', 'contact_r', 'power_l', 'power_r', 'discipline', 'speed', 'fielding', 'arm']
const PITCHER_OVR_FIELDS = ['stuff', 'control', 'command', 'stamina', 'vs_l', 'vs_r', 'composure', 'durability']

function shiftRatingBlock(block, fields, delta) {
  if (!block) return
  for (const f of fields) {
    if (typeof block[f] === 'number') {
      block[f] = Math.max(25, Math.min(99, Math.round(block[f] + delta)))
    }
  }
}

/**
 * Shift a freshly-generated roster so its natural Team OVR — top-9 hitters
 * weighted .55 + top-5 pitchers .45, the exact formula teamOverall() uses —
 * equals the program's expected Team OVR (the number shown on the team
 * picker). This keeps hitting / pitching / overall honestly consistent with
 * the assigned team rating instead of patching only `overall` with a hidden
 * offset. Current AND potential blocks shift together so current<=potential
 * stays intact. Works for every level (expectedTeamOvr is level-aware).
 */
function scaleRosterToTarget(roster, school) {
  if (!roster || roster.length === 0 || !school) return
  const target = expectedTeamOvr(school)
  const avg = arr => (arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : 0)
  // Iterate until the team OVR converges on the target. shiftRatingBlock
  // clamps each rating at 99, so for a high-target team (OSU at 96, Georgia
  // Tech at 98) the first shift saturates top players' ratings and loses
  // some of the delta — that's why the loaded team showed 94 even though
  // the picker said 96. Re-measuring and re-shifting picks up the slack.
  // Cap at 4 passes — convergence is typically 1-2; 4 is a safety net.
  for (let pass = 0; pass < 4; pass++) {
    const hitters = roster.filter(p => p.isHitter).map(hitterOverall).sort((a, b) => b - a).slice(0, 9)
    const pitchers = roster.filter(p => p.isPitcher).map(pitcherOverall).sort((a, b) => b - a).slice(0, 5)
    const natural = Math.round(avg(hitters) * 0.55 + avg(pitchers) * 0.45)
    if (!natural) return
    const delta = target - natural
    if (delta === 0) return
    for (const p of roster) {
      if (p.isHitter) {
        shiftRatingBlock(p.hitter, HITTER_OVR_FIELDS, delta)
        shiftRatingBlock(p.hidden?.potential_hitter, HITTER_OVR_FIELDS, delta)
      }
      if (p.isPitcher) {
        shiftRatingBlock(p.pitcher, PITCHER_OVR_FIELDS, delta)
        shiftRatingBlock(p.hidden?.potential_pitcher, PITCHER_OVR_FIELDS, delta)
      }
    }
  }
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}
