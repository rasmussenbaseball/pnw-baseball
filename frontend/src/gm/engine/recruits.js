/**
 * Recruit pool generation + recruiting actions.
 *
 * 3 pools per offseason: HS seniors, JUCO transfers, NAIA portal.
 * Each recruit has 8 weighted preferences (financial, proximity, playing_time,
 * program_history, facilities, academics, coaching, pipeline_fit) and a hidden
 * interest level per school that builds via coach actions.
 *
 * See ../docs/recruiting.md.
 */

import { makeRng } from './rng'
import { pickFullName } from './names'
import { pickCityForState } from './cities'
import { stateWeightsForRegions, STATE_TO_REGION } from './regions'
import { composePlayerProfile, enforceArchetypeFloors } from './playerArchetypes'
import jucoTeamsRaw from '../data/juco_teams.json'

// Recruit pool sizes. Trimmed in v1.6 — each makeRecruit allocates a fully
// shaped recruit (ratings + scout grades + offers). Bigger pools = bigger
// end-of-year tick (this gets called inside runEndOfYear, which runs on the
// main thread synchronously and was browser-locking the postseason
// transition at the old sizes).
const HS_POOL_SIZE = 300
const JUCO_POOL_SIZE = 120
const PORTAL_POOL_SIZE = 40
const D1_PORTAL_SIZE = 40
const D2_PORTAL_SIZE = 20
const D3_PORTAL_SIZE = 15

const ALL_JUCO_TEAMS = jucoTeamsRaw.leagues.flatMap(l => l.teams.map(t => ({ ...t, leagueId: l.id, pipelineFlag: l.pipelineFlag })))

// All pitcher recruits show as "P" — the head coach decides SP vs RP role
// after they enroll based on stuff + stamina. Internally we still need an
// is-pitcher flag for sim purposes. DH never generated — every recruit has
// a real position; coach picks the DH at lineup time.
const POSITIONS = ['C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF', 'P', 'P', 'P']

// ─── Geographic distribution ─────────────────────────────────────────────────
//
// Recruit-pool home states are drawn evenly across the country, with a 3×
// boost on the coach's two chosen regions. No more PNW-overpower.

function stateWeightsForCoach(coach) {
  if (!coach) return stateWeightsForRegions([])
  // Prefer the new tiered form (primary + secondary). Fall back to legacy
  // regions[] for older saves.
  if (coach.primaryRegion || coach.secondaryRegion) {
    return stateWeightsForRegions({
      primaryRegion: coach.primaryRegion,
      secondaryRegion: coach.secondaryRegion,
    })
  }
  return stateWeightsForRegions(coach.regions || [])
}

function coachRegionList(coach) {
  if (!coach) return []
  if (coach.primaryRegion || coach.secondaryRegion) {
    return [coach.primaryRegion, coach.secondaryRegion].filter(Boolean)
  }
  return coach.regions || []
}

/**
 * Sample a state from the weighted distribution.
 */
function sampleHomeState(stateWeights, rng) {
  const states = Object.keys(stateWeights)
  const weights = states.map(s => stateWeights[s])
  return rng.weighted(states, weights)
}

/**
 * Recruits from the coach's two priority regions arrive on the board already
 * aware of the program — small interest seed (12) but NO priorities and NO
 * scout fog reduction; the coach still has to do the work to learn anything
 * about the player.
 */
function seedRegionInterest(recruit, userSchoolId, coach) {
  if (!coach) return
  const recruitRegion = STATE_TO_REGION[recruit.hometown.state]
  // Primary region recruits get a bigger initial interest seed than
  // secondary. Falls back to legacy flat region list with the old seed.
  const isPrimary = coach.primaryRegion === recruitRegion
  const isSecondary = coach.secondaryRegion === recruitRegion
  const inLegacyRegion = !coach.primaryRegion && !coach.secondaryRegion &&
    (coach.regions || []).includes(recruitRegion)
  if (!isPrimary && !isSecondary && !inLegacyRegion) return
  const interest = isPrimary ? 12 : (isSecondary ? 7 : 12)
  recruit.scoutGrades[userSchoolId] = {
    interest,
    noise: 10,
    revealedPreferences: [],
    actionsApplied: ['REGION_SEED'],
    apSpent: 0,
  }
  if (!recruit.interestedSchools.includes(userSchoolId)) {
    recruit.interestedSchools.push(userSchoolId)
  }
}

/**
 * Generate the full recruit pool for one offseason — geography-biased for the user's coach.
 *
 * The pool is generated ONCE per season but the coach's pipelines/regions
 * affect which recruits are even in the pool that's visible. (For non-user
 * teams we don't generate a separate pool; their interest in recruits is
 * decided implicitly when the recruit makes a decision.)
 *
 * @param {number} year
 * @param {number} seed
 * @param {import('./types.js').Coach | null} coach   user's head coach for pipeline biasing
 * @returns {Object<string, import('./types.js').Recruit>}
 */
export function generateRecruitPool(year, seed, coach = null, userSchoolId = null) {
  /** @type {Object<string, import('./types.js').Recruit>} */
  const pool = {}
  const rng = makeRng('recruitPool', year, seed)
  const stateWeights = stateWeightsForCoach(coach)

  for (let i = 0; i < HS_POOL_SIZE; i++) {
    const r = makeRecruit('HS_SR', i, year, rng, stateWeights)
    if (userSchoolId) seedRegionInterest(r, userSchoolId, coach)
    pool[r.id] = r
  }
  for (let i = 0; i < JUCO_POOL_SIZE; i++) {
    const r = makeRecruit('JUCO', i, year, rng, stateWeights)
    if (userSchoolId) seedRegionInterest(r, userSchoolId, coach)
    pool[r.id] = r
  }
  // Compute regional rankings for HS recruits. Top 25 per region get a
  // numeric rank (1-25); rest get null. Rankings loosely correlate with
  // average of true OVR + POT, but with noise so they're NOT a perfect
  // OVR sort. These guys will be the toughest to recruit — every program
  // will be after them.
  assignRegionalRankings(pool, rng)
  return pool
}

/**
 * Compute top-25-per-region rankings for the HS class. Uses a noisy
 * (OVR + POT)/2 score to order players, so the ranking isn't a perfect
 * mirror of pure OVR. Mutates each recruit to add `regionalRank` (number)
 * and `rankedRegion` (region code), or leaves them null if unranked.
 */
function assignRegionalRankings(pool, rng) {
  const byRegion = {}
  for (const r of Object.values(pool)) {
    if (r.pool !== 'HS_SR') continue
    const region = STATE_TO_REGION[r.hometown.state]
    if (!region) continue

    // Tool-weighted score. Mental stats (composure, durability) only count
    // HALF as much as visible tools — a 99-composure / 30-power slap hitter
    // shouldn't outrank a 75 power / 75 contact masher. Also computes the
    // player's BEST tool, used to gate ranking entirely.
    let toolScore, potScore, bestToolCurrent, bestToolPot
    if (r.isPitcher) {
      const b = r.truePitcher
      const pb = r.truePotentialPitcher || b
      // Stuff weighted heavier — it's the headline tool for pitchers
      toolScore = (b.stuff * 1.6 + b.control + b.command + b.stamina +
                   b.vs_l + b.vs_r + b.composure * 0.5 + b.durability * 0.5) / 7.6
      potScore = (pb.stuff * 1.6 + pb.control + pb.command + pb.stamina +
                  pb.vs_l + pb.vs_r + pb.composure * 0.5 + pb.durability * 0.5) / 7.6
      bestToolCurrent = Math.max(b.stuff, b.control, b.command, b.stamina, b.vs_l, b.vs_r)
      bestToolPot = Math.max(pb.stuff, pb.control, pb.command, pb.stamina, pb.vs_l, pb.vs_r)
    } else {
      const b = r.trueHitter
      const pb = r.truePotentialHitter || b
      // Tools: contact, power, discipline, speed, fielding, arm.
      // Mental: composure, durability — half weight.
      toolScore = (b.contact_l + b.contact_r + b.power_l + b.power_r +
                   b.discipline + b.speed + b.fielding + b.arm +
                   b.composure * 0.5 + b.durability * 0.5) / 9
      potScore = (pb.contact_l + pb.contact_r + pb.power_l + pb.power_r +
                  pb.discipline + pb.speed + pb.fielding + pb.arm +
                  pb.composure * 0.5 + pb.durability * 0.5) / 9
      // Best tool — max of contact/power/speed/fielding/arm (not discipline,
      // which is more of a profile thing than a "wow" tool).
      bestToolCurrent = Math.max(b.contact_l, b.contact_r, b.power_l, b.power_r,
                                 b.speed, b.fielding, b.arm)
      bestToolPot = Math.max(pb.contact_l, pb.contact_r, pb.power_l, pb.power_r,
                             pb.speed, pb.fielding, pb.arm)
    }

    // Regional rankings REQUIRE a standout tool — top-25 players should
    // always have at least ONE plus skill that scouts notice. Otherwise the
    // #1 PNW recruit could be a 5'6 grinder with no headline trait.
    const STANDOUT_THRESHOLD = 75
    if (bestToolCurrent < STANDOUT_THRESHOLD && bestToolPot < STANDOUT_THRESHOLD + 5) {
      continue   // unranked — solid all-around guy, no standout
    }

    if (!byRegion[region]) byRegion[region] = []
    const noise = rng.gaussian(0, 3.5)
    // Final score: 55% current tool score + 45% potential tool score
    const score = toolScore * 0.55 + potScore * 0.45 + noise
    byRegion[region].push({ recruit: r, score })
  }
  for (const region of Object.keys(byRegion)) {
    byRegion[region].sort((a, b) => b.score - a.score)
    const top25 = byRegion[region].slice(0, 25)
    top25.forEach((item, idx) => {
      item.recruit.regionalRank = idx + 1
      item.recruit.rankedRegion = region
    })
  }
}

/**
 * Generate the portal pool — opens AFTER the regular season ends.
 * Includes NAIA, D1, D2, and D3 transfers. All ratings vary by source:
 *   - NAIA portal: average to mid-grade (people unhappy at current spot)
 *   - D1 portal: rare, high-ish rated (failed D1 starters; mostly average to good)
 *   - D2 portal: mid-grade with some upside
 *   - D3 portal: lower rated; transferring up for development
 *
 * @returns {Object<string, import('./types.js').Recruit>}
 */
export function generatePortalPool(year, seed, coach = null) {
  /** @type {Object<string, import('./types.js').Recruit>} */
  const pool = {}
  const rng = makeRng('portalPool', year, seed)
  const stateWeights = stateWeightsForCoach(coach)

  for (let i = 0; i < PORTAL_POOL_SIZE; i++) {
    const r = makeRecruit('NAIA_TRANSFER', i, year, rng, stateWeights)
    pool[r.id] = r
  }
  // D1 portal — large pool with two sub-types
  for (let i = 0; i < D1_PORTAL_SIZE; i++) {
    // ~40% "underused good D1s" (high OVR, didn't play enough)
    // ~60% "young bad D1s" (lower OVR but high potential — they need development)
    const subtype = rng.chance(0.4) ? 'D1_UNDERUSED' : 'D1_YOUNG'
    const r = makeRecruit('D1_TRANSFER', i, year, rng, stateWeights, subtype)
    pool[r.id] = r
  }
  // D2 portal
  for (let i = 0; i < D2_PORTAL_SIZE; i++) {
    const r = makeRecruit('D2_TRANSFER', i, year, rng, stateWeights)
    pool[r.id] = r
  }
  // D3 portal
  for (let i = 0; i < D3_PORTAL_SIZE; i++) {
    const r = makeRecruit('D3_TRANSFER', i, year, rng, stateWeights)
    pool[r.id] = r
  }
  return pool
}

function makeRecruit(pool, idx, year, rng, stateWeights, subtype = null) {
  // Hometown — sample from weighted state distribution (PNW-biased + coach pipelines)
  const state = sampleHomeState(stateWeights || HOME_REGION_WEIGHTS_PNW, rng)
  const region = STATE_TO_REGION[state] || 'MW'
  const { first, last } = pickFullName(rng, region)

  // DH dropped — every recruit has a real position. Coach picks the DH at
  // lineup time from the position-player pool.
  const primaryPosition = rng.pick(POSITIONS)
  const isPitcher = primaryPosition === 'P'

  // Compose an archetype profile — drives rating biases + measurables. The
  // tier loosely maps to pool quality so D1 UNDERUSED transfers can pull
  // from star archetypes more easily. Pool tag controls physical maturity
  // (HS lighter, JUCO mid, transfers full frame).
  const profileTier = (pool === 'D1_TRANSFER' && subtype === 'D1_UNDERUSED') ? 'starter'
    : (pool === 'D1_TRANSFER' && subtype === 'D1_YOUNG') ? 'bench'
    : (pool === 'JUCO') ? 'bench'
    : 'depth'
  const profilePool = pool === 'HS_SR' ? 'HS_SR' : pool === 'JUCO' ? 'JUCO' : 'COLLEGE'
  const profile = composePlayerProfile({
    position: primaryPosition, isPitcher, slotTier: profileTier, rng,
    pool: profilePool,
  })

  // Rating distribution per pool. Means + caps raised May 2026 so the GM
  // game's recruit pools match the user's mental model: mid-tier players
  // live in the 60s, real impact guys hit 70+, and rare gems can top 85.
  // JUCO especially is bumped — those are seasoned college bats, not raw HS.
  let meanRating, stddev, cap
  if (pool === 'HS_SR')       { meanRating = 58; stddev = 12; cap = 92 }   // most HS land 45-70; top 1% hit 85
  else if (pool === 'JUCO')   { meanRating = 64; stddev = 11; cap = 95 }   // seasoned college bats, can produce a 90 OVR
  else if (pool === 'NAIA_TRANSFER') { meanRating = 60; stddev = 12; cap = 92 }
  else if (pool === 'D1_TRANSFER' && subtype === 'D1_UNDERUSED') { meanRating = 76; stddev = 7; cap = 97 }
  else if (pool === 'D1_TRANSFER' && subtype === 'D1_YOUNG')     { meanRating = 60; stddev = 10; cap = 85 }
  else if (pool === 'D1_TRANSFER') { meanRating = 70; stddev = 9;  cap = 95 }
  else if (pool === 'D2_TRANSFER') { meanRating = 62; stddev = 11; cap = 92 }
  else if (pool === 'D3_TRANSFER') { meanRating = 56; stddev = 11; cap = 88 }
  else                             { meanRating = 58; stddev = 12; cap = 92 }

  // L/R correlation TIED TO PLATOON HANDEDNESS + REVERSE SPLITS. Real
  // baseball: RHH hit slightly better vs LHP (~70%), LHH hit better vs
  // RHP (~75%). Switch hitters balanced. ~12% of one-side hitters are
  // reverse-split (LHH crushes LHP, RHH crushes RHP) — real-world thing,
  // makes scouting more interesting. Dominance max ~8 pts.
  const bats = rng.weighted(['R', 'L', 'S'], [70, 22, 8])
  let dominantSide, reverseSplit
  if (bats === 'S') {
    dominantSide = rng.chance(0.5) ? 'L' : 'R'
    reverseSplit = false
  } else if (rng.chance(0.12)) {
    // Reverse split
    dominantSide = bats === 'L' ? 'L' : 'R'
    reverseSplit = true
  } else if (bats === 'R') {
    dominantSide = rng.chance(0.7) ? 'L' : 'R'
    reverseSplit = false
  } else {
    dominantSide = rng.chance(0.75) ? 'R' : 'L'
    reverseSplit = false
  }
  const sideDom = rng.weighted([1, 2, 3, 5, 8], [25, 30, 25, 15, 5])
  const lDelta = dominantSide === 'L' ? sideDom : -sideDom
  const rDelta = dominantSide === 'R' ? sideDom : -sideDom
  const biases = profile.biases
  const rollKey = (key, extra = 0) => Math.round(clamp(
    rng.gaussian(meanRating + (biases[key] || 0) + extra, stddev),
    25, cap,
  ))

  const trueHitter = {
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
  const truePitcher = {
    stuff: rollKey('stuff'),
    control: rollKey('control'),
    command: rollKey('command'),
    stamina: rollKey('stamina'),
    vs_l: rollKey('vs_l'),
    vs_r: rollKey('vs_r'),
    composure: rollKey('composure'),
    durability: rollKey('durability'),
  }
  // Late-bloomer current-rating suppression — same as roster generation.
  if (profile.isLateBloomer) {
    const drop = rng.int(8, 14)
    for (const k of Object.keys(trueHitter)) trueHitter[k] = clamp(trueHitter[k] - drop, 25, 99)
    for (const k of Object.keys(truePitcher)) truePitcher[k] = clamp(truePitcher[k] - drop, 25, 99)
  }

  // Enforce archetype signature-rating floors so labels are believable
  // (Defensive Wizard always has plus fielding, etc.).
  enforceArchetypeFloors(profile.archetype.key, trueHitter, truePitcher)

  // Potential — DECOUPLED from current. Each player has a ceiling tier rolled
  // once that drives all their rating ceilings. Pool source affects tier
  // distribution (D1 YOUNG more likely to roll FRANCHISE; D3 transfer less so),
  // but a 42-OVR HS senior can absolutely have a 95 ceiling.
  // 5% franchise (mean 90), 12% blue-chip (mean 82), rest standard (mean 67±9)
  // Tier distribution (May 2026 per Nate — more high-potential gems):
  //   FRANCHISE  (8%):  mean 90  — future-star ceiling
  //   BLUECHIP  (16%):  mean 82  — solid pro
  //   STANDARD  (76%):  mean 67 ±10
  const tierRoll = pool === 'D1_TRANSFER' && subtype === 'D1_YOUNG' ? 'BLUECHIP'   // young D1s skew elite ceilings
    : rng.chance(0.12) ? 'FRANCHISE'                                                // 90+ ceilings shouldn't be ultra-rare
    : rng.chance(0.22) ? 'BLUECHIP'
    : 'STANDARD'
  let tierMean
  if (tierRoll === 'FRANCHISE') tierMean = 90
  else if (tierRoll === 'BLUECHIP') tierMean = 82
  else tierMean = rng.gaussian(67, 10)
  const lateBloom = profile.isLateBloomer ? 10 : 0
  // Per-stat jitter widened to 12 (was 8) so a single elite tool is more
  // common — a low-OVR recruit might have 92 power with everything else
  // average, becoming a recognizable hidden gem.
  const ceiling = (current) => clamp(
    Math.round(rng.gaussian(tierMean + lateBloom, 12)),
    current, 99,
  )
  const potHitter = Object.fromEntries(Object.entries(trueHitter).map(([k, v]) => [k, ceiling(v)]))
  const potPitcher = Object.fromEntries(Object.entries(truePitcher).map(([k, v]) => [k, ceiling(v)]))

  // ── Measurables ────────────────────────────────────────────────────────
  // Tuned per Nate (May 2026):
  //   60-yd: elite 6.4, avg 7.0. HS recruits barely improve in college so
  //          the floor for elite HS guys is 6.5; only college-aged recruits
  //          should clock 6.4.
  //   Max EV: NAIA recruit FLOOR ~90. Power hitters 100+; elites 105+.
  //   FB velo: HS avg ~83-84, top HS guys 91-92. JUCO slightly elevated
  //          (avg ~85-86, top 92-93). NAIA portal mid-pool similar to JUCO.
  //          D1 transfers + flamethrowers can hit 94-97.
  //   Body size boost: bigger frame higher velo + higher EV (long levers
  //          drive bat + arm speed). Use heightInches as the size proxy.
  const ht = profile.measurables.heightInches
  const sizeBoost = Math.max(0, (ht - 70) * 0.4)    // 70" 0, 76" +2.4, 80" +4.0

  const measurables = {
    heightInches: ht,
    weightLbs: profile.measurables.weightLbs,
    targetMatureWeightLbs: profile.measurables.targetMatureWeightLbs,
  }
  if (!isPitcher) {
    const sp = trueHitter.speed
    // 60-yard: elite 6.4, average 7.0. Formula: speed 50 7.0, speed 99 6.41.
    const sixtyBase = 7.0 - (sp - 50) * 0.012
    measurables.sixtyYardSec = Math.round((sixtyBase + rng.gaussian(0, 0.06)) * 100) / 100

    // Max EV (re-tune May 2026 per Nate):
    //   Average board player ~93-95 mph, hard floor ~88 mph (anything below
    //   wouldn't be recruited). Top hitters 100+. Best power bats 105+.
    // Formula targets:
    //   power 30 ~88 mph (recruiting floor — rarely below this on a board)
    //   power 50 ~94 mph (avg)
    //   power 70 ~100 mph (above-avg power)
    //   power 85 ~104 mph (#1 corner IF type)
    //   power 95+ 108+ mph (elite, top of D1 prospect class)
    const pw = Math.max(trueHitter.power_l, trueHitter.power_r)
    const poolEvBoost = pool === 'JUCO' ? 2.0
      : (pool === 'NAIA_TRANSFER' || pool === 'D2_TRANSFER' || pool === 'D3_TRANSFER') ? 1.5
      : (pool === 'D1_TRANSFER') ? 3.0
      : 0
    // Baseline 89 (was 86) + per-power-pt 0.30 (was 0.50). This compresses
    // the spread upward — even pw 30 lands ~88, and pw 50 (avg) hits 93-94.
    // Stronger power retains the same top-end (pw 85 ≈ 104, pw 95 ≈ 107).
    const maxEvBase = 89 + (pw - 50) * 0.30 + sizeBoost + poolEvBoost
    // Floor at 88 — boards never show sub-88 max EV.
    measurables.maxEvMph = Math.max(88, Math.round((maxEvBase + rng.gaussian(0, 1.3)) * 10) / 10)

    if (primaryPosition === 'C') {
      // Pop time depends on TRANSFER (fielding/glove work) + ARM (throw velo).
      // Real-world breakdown: ~40% transfer, ~60% arm. Targets:
      //   blended 50 2.10 (slow)
      //   blended 70 1.95 (above avg)
      //   blended 90 1.80 (elite D1 caliber)
      const arm = trueHitter.arm
      const fielding = trueHitter.fielding
      const blended = arm * 0.6 + fielding * 0.4
      measurables.popTimeSec = Math.round((2.10 - (blended - 50) * 0.0075 + rng.gaussian(0, 0.04)) * 100) / 100
    }
  } else {
    // ── Pitcher FB velo — DECOUPLED FROM STUFF (May 2026 per Nate) ─────
    // Velocity is now driven by:
    //   1. Pool baseline (HS 83 D1 transfer 89)
    //   2. Archetype velocityBias (FLAMETHROWER +5, SOFT_TOSS -8, etc.)
    //   3. Body-size boost (6'4+ arms play up — long levers)
    //   4. A small stuff correlation (+0.05 mph/pt) — kept weak so
    //      Crafty Lefties can still have plus movement at 84 mph.
    //
    // This means a 5'10" HS senior with FLAMETHROWER archetype can sit
    // 89-90, and a 6'4" college transfer with SOFT_TOSSING_VETERAN sits
    // 80-82. Stuff and velo are now their own metrics.
    const stuff = truePitcher.stuff
    const velocityBias = profile.archetype.velocityBias ?? 0
    const stuffCorrelation = (stuff - 50) * 0.05

    let poolBase
    if (pool === 'HS_SR') poolBase = 83.0
    else if (pool === 'JUCO') poolBase = 85.0
    else if (pool === 'NAIA_TRANSFER' || pool === 'D2_TRANSFER' || pool === 'D3_TRANSFER') poolBase = 86.0
    else poolBase = 89.0   // D1 transfer

    const baseMean = poolBase + velocityBias + stuffCorrelation + sizeBoost
    const baseSpread = 1.6

    // Pool caps — applied after archetype bias so FLAMETHROWER can blow
    // through them slightly. HS top 93 (was 92), JUCO 95, NAIA/D2/D3 96,
    // D1 transfer 99. SOFT_TOSSING_VETERAN has its own floor at ~78.
    const poolCap = pool === 'HS_SR' ? 93
      : pool === 'JUCO' ? 95
      : (pool === 'NAIA_TRANSFER' || pool === 'D2_TRANSFER' || pool === 'D3_TRANSFER') ? 96
      : 99
    const veloMean = clamp(baseMean + rng.gaussian(0, baseSpread), 75, poolCap)
    measurables.fbVeloMph = Math.round(veloMean * 10) / 10
    measurables.fbVeloMinMph = Math.round((veloMean - 2) * 10) / 10
    measurables.fbVeloMaxMph = Math.round((veloMean + 2) * 10) / 10
  }

  // Preferences — sum to ~40 across 8 dimensions (mean weight = 5)
  const preferences = {
    financial:       rng.int(2, 9),
    proximity:       rng.int(1, 9),
    playing_time:    rng.int(2, 9),
    program_history: rng.int(1, 9),
    facilities:      rng.int(0, 8),
    academics:       rng.int(0, 8),
    coaching:        rng.int(1, 8),
    pipeline_fit:    rng.int(0, 7),
  }

  // Previous school for JUCO/portal
  let previousSchoolName = null
  let previousLeagueId = null
  if (pool === 'JUCO') {
    const t = rng.pick(ALL_JUCO_TEAMS)
    previousSchoolName = t.name
    previousLeagueId = t.leagueId
  } else if (pool === 'NAIA_TRANSFER') {
    previousSchoolName = 'NAIA transfer'
    previousLeagueId = 'NAIA'
  } else if (pool === 'D1_TRANSFER') {
    previousSchoolName = 'D1 transfer'
    previousLeagueId = 'D1'
  } else if (pool === 'D2_TRANSFER') {
    previousSchoolName = 'D2 transfer'
    previousLeagueId = 'D2'
  } else if (pool === 'D3_TRANSFER') {
    previousSchoolName = 'D3 transfer'
    previousLeagueId = 'D3'
  }

  // Suitor count — how many other programs are after this player.
  // RECALIBRATED: D1 suitors are RARE in the NAIA recruiting world. Only true
  // elites (85+ OVR) get D1 looks. Most recruits are mid-tier guys NAIA
  // schools are competing over.
  const avgRating = (Object.values({ ...trueHitter, ...truePitcher }).reduce((a, b) => a + b, 0) / 16)
  // D1 portal recruits already left D1 — they typically don't have D1 suitors
  // (with rare exception — UNDERUSED D1s can attract a 2nd D1 look). Treat
  // D1 transfers as having very few D1 suitors.
  const isD1Pool = pool === 'D1_TRANSFER'
  const d1Base = isD1Pool ? 0 : Math.max(0, Math.round((avgRating - 85) / 4))   // 0 below 85, 1 at 89, 2 at 93
  const suitors = {
    d1: d1Base,                                                                  // rare for everyone
    topNaia: Math.max(0, Math.round((avgRating - 65) / 5)),                     // 0 below 65, more above
    otherNaia: Math.max(0, Math.round((avgRating - 45) / 6)),                   // most have some NAIA interest
    d2d3: Math.max(0, Math.round((avgRating - 55) / 8)),
  }

  // Academic rating — HS grades / GPA equivalent. Drives academic scholarship $.
  // Independent of athletic skill. Mean 60, stddev 18, range 30-99.
  // Players with 75+ academic ratings get meaningful academic aid that supplements
  // any athletic offer.
  const academicRating = Math.round(clamp(rng.gaussian(60, 18), 30, 99))

  return {
    id: `r_${pool}_${year}_${idx}`,
    firstName: first,
    lastName: last,
    hometown: { city: pickCityForState(state, rng), state },
    pool,
    previousSchoolName,
    previousLeagueId,
    primaryPosition,
    positions: [primaryPosition],
    bats,
    throws: rng.weighted(['R', 'L'], [80, 20]),
    trueHitter,
    truePitcher,
    truePotentialHitter: potHitter,
    truePotentialPitcher: potPitcher,
    measurables,
    archetypeKey: profile.archetype.key,    // visible archetype label
    bodyFrameKey: profile.frame.key,         // visible body frame
    hiddenQuirks: profile.quirks.filter(q => q.hidden).map(q => q.key),  // revealed via deep-scout
    visibleQuirks: profile.quirks.filter(q => !q.hidden).map(q => q.key),
    reverseSplit,                            // ~12% of one-side hitters defy traditional platoon norms

    preferences,
    scoutGrades: {},
    status: 'open',
    interestedSchools: [],
    verbalTo: null,
    signedTo: null,
    isPitcher,
    suitors,            // { d1, topNaia, otherNaia, d2d3 } — true rival interest (hidden until scouted)
    suitorsRevealed: false,  // becomes true after scout trip or visit
    academicRating,     // 30-99, HS grades / GPA equivalent — drives academic scholarship $
    liveOffer: null,    // { amount: $, weeksOutstanding: n } — user's persistent offer
    poolSubtype: subtype || null,  // 'D1_UNDERUSED' | 'D1_YOUNG' or null
  }
}

/**
 * Convert a 30-99 academicRating to a believable GPA.
 *   30 1.5,  50 2.5,  60 2.9,  75 3.5,  90 3.9,  99 4.0
 */
export function academicRatingToGpa(rating) {
  const r = rating ?? 60
  if (r >= 99) return 4.0
  if (r >= 90) return Math.round((3.7 + (r - 90) * 0.033) * 10) / 10   // 3.7-4.0
  if (r >= 75) return Math.round((3.3 + (r - 75) * 0.026) * 10) / 10   // 3.3-3.7
  if (r >= 60) return Math.round((2.8 + (r - 60) * 0.033) * 10) / 10   // 2.8-3.3
  if (r >= 50) return Math.round((2.4 + (r - 50) * 0.04) * 10) / 10    // 2.4-2.8
  return Math.round((1.5 + (r - 30) * 0.045) * 10) / 10                // 1.5-2.4
}

/**
 * GPA-tiered academic scholarship — % of tuition the recruit's GPA qualifies
 * them for at this school. Comes from the school's academic department, NOT
 * the athletic budget.
 *
 *   4.0       50% of tuition
 *   3.8-3.99  45%
 *   3.5-3.79  40%
 *   3.0-3.49  30%
 *   2.5-2.99  20%
 *   2.0-2.49  10%
 *   < 2.0     0%
 */
export function academicScholarshipPct(gpa) {
  if (gpa >= 4.0)  return 0.50
  if (gpa >= 3.8)  return 0.45
  if (gpa >= 3.5)  return 0.40
  if (gpa >= 3.0)  return 0.30
  if (gpa >= 2.5)  return 0.20
  if (gpa >= 2.0)  return 0.10
  return 0
}

/**
 * @param {import('./types.js').Recruit} recruit
 * @param {import('./types.js').School} school
 * @returns {number}
 */
export function academicScholarship(recruit, school) {
  const gpa = academicRatingToGpa(recruit.academicRating)
  const pct = academicScholarshipPct(gpa)
  return Math.round(school.tuitionPerYear * pct)
}

/**
 * Total suitor count (for UI display + sign-speed math).
 */
export function totalSuitors(recruit) {
  const s = recruit.suitors || {}
  return (s.d1 || 0) + (s.topNaia || 0) + (s.otherNaia || 0) + (s.d2d3 || 0)
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// (STATE_TO_REGION lives in regions.js — imported above.)

// ─── Recruiting actions ──────────────────────────────────────────────────────

/**
 * Each action has: AP cost, interest gain, scouting fog reduction, and
 * preference-reveal chance. Some actions only available with assistant
 * coaches on staff.
 *
 * @typedef ActionDef
 * @property {string} key
 * @property {string} label
 * @property {number} apCost
 * @property {number} interestGain
 * @property {number} fogReduction        // pts of noise reduction
 * @property {number} prefRevealChance    // 0-1, probability of revealing one pref dimension
 * @property {string} blurb
 */

/** @type {Record<string, ActionDef>} */
export const ACTION_TYPES = {
  TEXT: {
    key: 'TEXT',
    label: 'Text',
    apCost: 1,
    interestGain: 2,
    fogReduction: 0,
    prefRevealChance: 0,
    blurb: 'Quick, low-cost touch. Builds rapport.',
  },
  CALL: {
    key: 'CALL',
    label: 'Phone Call',
    apCost: 1,
    interestGain: 4,
    fogReduction: 1,
    prefRevealChance: 0.05,
    blurb: 'Hear them out. Small interest bump, hint at priorities.',
  },
  ASSISTANT_TALK: {
    key: 'ASSISTANT_TALK',
    label: 'Assistant Conversation',
    apCost: 2,
    interestGain: 5,
    fogReduction: 2,
    prefRevealChance: 0.15,
    blurb: 'Send an assistant to build the relationship. Often reveals a priority.',
  },
  FAMILY_ZOOM: {
    key: 'FAMILY_ZOOM',
    label: 'Family Zoom Call',
    apCost: 3,
    interestGain: 7,
    fogReduction: 1,
    prefRevealChance: 0.25,
    blurb: 'Group call with the recruit + parents. Wins families over.',
  },
  SCOUT_TRIP: {
    key: 'SCOUT_TRIP',
    label: 'Scout Trip',
    apCost: 4,
    interestGain: 3,
    fogReduction: 7,
    prefRevealChance: 0.10,
    blurb: 'See them play. Big fog reduction.',
  },
  HOME_VISIT: {
    key: 'HOME_VISIT',
    label: 'Home Visit',
    apCost: 5,
    interestGain: 12,
    fogReduction: 4,
    prefRevealChance: 0.40,
    blurb: 'High-touch. Wins families over. Often reveals priorities.',
  },
  CAMPUS_VISIT: {
    key: 'CAMPUS_VISIT',
    label: 'Schedule Campus Visit',
    apCost: 6,
    interestGain: 18,
    fogReduction: 10,
    prefRevealChance: 0.60,
    blurb: 'The closer. Recruit on campus, sees everything, reveals priorities.',
  },
  SCHOLARSHIP_OFFER: {
    key: 'SCHOLARSHIP_OFFER',
    label: 'Scholarship Offer',
    apCost: 0,
    interestGain: 15,
    fogReduction: 0,
    prefRevealChance: 0,
    blurb: 'Costs $ from your pool. Biggest interest bump.',
  },
}

/**
 * Apply an action to a recruit. Mutates the recruit's scoutGrade for this school.
 *
 * @param {import('./types.js').Recruit} recruit
 * @param {string} userSchoolId
 * @param {ActionDef} action
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @returns {{ recruit: any, interestGain: number, revealed?: string }}
 */
export function applyRecruitingAction(recruit, userSchoolId, action, rng) {
  if (!recruit.scoutGrades[userSchoolId]) {
    recruit.scoutGrades[userSchoolId] = {
      interest: 0,
      noise: 10,                  // initial sight = ±10 rating noise (tightened)
      revealedPreferences: [],
      actionsApplied: [],
      apSpent: 0,
    }
  }
  const grade = recruit.scoutGrades[userSchoolId]

  // One-shot rule: each scouting action can only be applied ONCE per
  // recruit. The caller should ideally already prevent the click, but we
  // re-check here so engine state stays consistent. SCHOLARSHIP_OFFER is
  // exempt because it's managed via setLiveOffer (live offers can change).
  if (action.key !== 'SCHOLARSHIP_OFFER' && grade.actionsApplied.includes(action.key)) {
    return { recruit, interestGain: 0, revealed: null, alreadyApplied: true }
  }

  grade.interest = Math.min(100, grade.interest + action.interestGain)
  grade.noise = Math.max(2, grade.noise - action.fogReduction)
  grade.actionsApplied.push(action.key)
  grade.apSpent = (grade.apSpent || 0) + (action.apCost || 0)

  if (!recruit.interestedSchools.includes(userSchoolId)) {
    recruit.interestedSchools.push(userSchoolId)
  }

  // Reveal a preference dimension probabilistically
  let revealed = null
  if (rng.chance(action.prefRevealChance)) {
    const allPrefs = Object.keys(recruit.preferences)
    const undisclosed = allPrefs.filter(p => !grade.revealedPreferences.includes(p))
    if (undisclosed.length > 0) {
      const sorted = undisclosed.sort((a, b) => recruit.preferences[b] - recruit.preferences[a])
      revealed = sorted[0]
      grade.revealedPreferences.push(revealed)
    }
  }

  const REVEALING_ACTIONS = new Set(['SCOUT_TRIP', 'HOME_VISIT', 'CAMPUS_VISIT', 'FAMILY_ZOOM', 'ASSISTANT_TALK'])
  if (REVEALING_ACTIONS.has(action.key)) {
    recruit.suitorsRevealed = true
  }

  // Full-scout milestone: 10+ AP spent AND a live offer in place everything
  // revealed + meaningful interest bump (recruit feels prioritized).
  applyFullScoutIfEligible(recruit, userSchoolId)

  return { recruit, interestGain: action.interestGain, revealed }
}

/**
 * Scouting progress (0-1) used for the progress bar on the recruiting list.
 * Combines AP spent (caps at 10) with whether a live offer exists.
 */
export function scoutingProgress(recruit, userSchoolId) {
  const grade = recruit.scoutGrades?.[userSchoolId]
  if (!grade) return 0
  const apPart = Math.min(1, (grade.apSpent || 0) / 10)
  const offerPart = recruit.liveOffer?.schoolId === userSchoolId ? 1 : 0
  return Math.min(1, apPart * 0.7 + offerPart * 0.3)
}

/** True once 10+ AP has been spent on the recruit (offer no longer required). */
export function isFullyScouted(recruit, userSchoolId) {
  const grade = recruit.scoutGrades?.[userSchoolId]
  if (!grade) return false
  return (grade.apSpent || 0) >= 10
}

// Legacy stub kept for back-compat — older callers may pass extra args.
function _legacyIsFullyScoutedWithOffer(recruit, userSchoolId) {
  const grade = recruit.scoutGrades?.[userSchoolId]
  if (!grade) return false
  return (grade.apSpent || 0) >= 10 && recruit.liveOffer?.schoolId === userSchoolId
}

function applyFullScoutIfEligible(recruit, userSchoolId) {
  if (!isFullyScouted(recruit, userSchoolId)) return
  const grade = recruit.scoutGrades[userSchoolId]
  if (grade.fullScoutApplied) return
  grade.fullScoutApplied = true
  // Fully scouted leaves a small residual ±3 band. Even with full intel, you
  // can never be 100% sure of the OVR — that's where surprise hits/busts
  // come from. (Hidden archetype quirks are also still hidden until you
  // spend extra "deep scout" AP.)
  grade.noise = 3
  // Reveal all visible preferences + visible quirks
  const allPrefs = Object.keys(recruit.preferences)
  grade.revealedPreferences = [...allPrefs]
  // Reveal suitors too
  recruit.suitorsRevealed = true
  // Big interest bump — recruit feels prioritized
  grade.interest = Math.min(100, grade.interest + 15)
}

/**
 * Get the suitor info a coach sees on a recruit — vague pre-scouting, exact after.
 *
 * @param {import('./types.js').Recruit} recruit
 * @returns {{ revealed: boolean, label: string, total: number, suitors: object | null }}
 */
export function visibleSuitors(recruit) {
  const total = totalSuitors(recruit)
  if (!recruit.suitorsRevealed) {
    // Vague label only
    let label
    if (total === 0) label = 'limited interest'
    else if (total <= 2) label = 'lightly recruited'
    else if (total <= 5) label = 'moderately recruited'
    else if (total <= 9) label = 'heavily recruited'
    else label = 'national attention'
    return { revealed: false, label, total, suitors: null }
  }
  // Full reveal
  return { revealed: true, label: null, total, suitors: recruit.suitors }
}

/**
 * Apply scouting fog to a recruit's true rating. Returns a noisy estimate.
 *
 * Distribution is UNIFORM within ±noise of the true rating — equal chance
 * of any value in the band. This was the user's explicit request: if a
 * player's spread is 52-77, each integer in that band should be equally
 * likely, not gaussian-centered on 64. Surprises stay surprising.
 */
export function noisyRating(trueRating, noise, rng) {
  if (!noise || noise <= 0) return Math.max(20, Math.min(99, Math.round(trueRating)))
  // Uniform integer in [-noise, +noise]
  const adj = rng.int(-noise, +noise)
  return Math.max(20, Math.min(99, Math.round(trueRating + adj)))
}

/**
 * Estimate the noisy potential ratings a coach sees on a recruit. Identical
 * shape to estimateRecruitRatings but reads from truePotentialHitter /
 * truePotentialPitcher. The noise band is widened by 1.5× because potential
 * is harder to read than current — even a great scout misses on ceiling.
 */
export function estimateRecruitPotential(recruit, userSchoolId, rng) {
  const grade = recruit.scoutGrades?.[userSchoolId]
  const baseNoise = grade?.noise ?? 10
  // POT is harder to project than current — but the old 1.5× multiplier
  // produced visible bands of "60-99" on initial scouting which were
  // basically useless. Tightened to 1.2× per Nate (May 2026).
  const noise = Math.round(baseNoise * 1.2)
  if (recruit.isPitcher) {
    const out = {}
    for (const [k, v] of Object.entries(recruit.truePotentialPitcher || {})) {
      out[k] = noisyRating(v, noise, rng)
    }
    return { type: 'pitcher', ratings: out, noise }
  }
  const out = {}
  for (const [k, v] of Object.entries(recruit.truePotentialHitter || {})) {
    out[k] = noisyRating(v, noise, rng)
  }
  return { type: 'hitter', ratings: out, noise }
}

// ─── Phase tracking ──────────────────────────────────────────────────────────

/**
 * Recruiting has two phases:
 *   PRE_PORTAL — HS + JUCO available, NAIA portal locked. Fall + winter +
 *                early spring. Most HS commitments lock during this phase.
 *   PORTAL_OPEN — After regular season + postseason ends. NAIA portal opens;
 *                  HS pool is mostly depleted (those still uncommitted are
 *                  either super-late risers or unsigned for a reason); JUCO
 *                  pool still active.
 *
 * @param {{ year: number, week: number, mode: string, offseasonWeek: number|null }} calendar
 * @returns {'PRE_PORTAL' | 'PORTAL_OPEN'}
 */
export function recruitingPhase(calendar) {
  // 52-week calendar: portal opens after postseason wraps (Wk 43) and stays
  // open through the recruiting cycle's final month (Wk 51). Wk 52 finalizes
  // the class; before Wk 43 and after Wk 51 portal recruits aren't visible.
  const wk = calendar?.weekOfYear ?? 0
  if (wk >= 43 && wk <= 51) return 'PORTAL_OPEN'
  return 'PRE_PORTAL'
}

/**
 * Filter the recruit pool by what's available in the current phase.
 * Also handles HS attrition: as the year progresses, more HS recruits "commit
 * elsewhere" and disappear from the user's board.
 */
export function visibleRecruits(allRecruits, calendar) {
  const phase = recruitingPhase(calendar)
  return Object.values(allRecruits).filter(r => {
    if (r.status === 'signed' || r.status === 'lost') return false
    if (r.pool === 'NAIA_TRANSFER' || r.pool === 'D1_TRANSFER') {
      return phase === 'PORTAL_OPEN'
    }
    // HS attrition — in PORTAL_OPEN phase, only ~25% of HS pool remains
    if (phase === 'PORTAL_OPEN' && r.pool === 'HS_SR' && !r._postSeasonAvailable) {
      return false
    }
    return true
  })
}

/**
 * When transitioning to PORTAL_OPEN, mark which HS recruits remain available.
 * Bias: lower-rated HS recruits more likely to still be uncommitted.
 */
export function applyHsAttrition(pool, seed) {
  const rng = makeRng('hsAttr', seed)
  for (const r of Object.values(pool)) {
    if (r.pool !== 'HS_SR') continue
    if (r.status === 'signed' || r.status === 'lost') continue
    // ~75% lose interest from your program (committed elsewhere)
    const avgRating = avgTrueRating(r)
    const keepChance = avgRating >= 70 ? 0.08 : avgRating >= 60 ? 0.18 : 0.35
    if (rng.chance(keepChance)) {
      r._postSeasonAvailable = true
    } else {
      r.status = 'lost'
    }
  }
}

function avgTrueRating(r) {
  const block = r.isPitcher ? r.truePitcher : r.trueHitter
  const vals = Object.values(block)
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

// ─── Prospect Camp ───────────────────────────────────────────────────────────
//
// Every program holds one prospect camp in the fall. The user sets a $ fee
// per attendee. Higher fees fewer attendees. Better-rated recruits are
// harder to lure to camp; they're already getting attention from D1.
//
// Attendees:
//   - Receive a small rating bump (development boost)
//   - Have their scout fog reduced for your school
//   - Earn money for your budget ($ fee × attendee count)
//   - Bump their interest in your program meaningfully

// Camp constants
export const CAMP_MIN_ATTENDEES = 20
export const CAMP_MAX_ATTENDEES = 100
export const CAMP_MAX_INVITES = 100      // user can invite up to 100 HS recruits
export const CAMP_MAX_WALKONS = 25

/**
 * Per-recruit camp attendance probability — exposed so the UI can show
 * RSVP predictions (Likely / Unsure / Probably not). Mirrors the math
 * inside simProspectCamp for invited players.
 *
 * @param {import('./types.js').Recruit} recruit
 * @param {string} userSchoolId
 * @param {number} feePerAttendee
 * @param {number} coachRecruiterRating
 * @param {number} programMomentum   0-100
 */
export function predictRecruitAttendance(recruit, userSchoolId, feePerAttendee, coachRecruiterRating, programMomentum) {
  if (recruit.pool !== 'HS_SR') return 0
  const feeMult = clamp(1.5 - (feePerAttendee - 50) / 200, 0.4, 1.6)
  const coachMult = 0.7 + (coachRecruiterRating / 100) * 0.7
  const momentumMult = 0.7 + (programMomentum / 100) * 0.7
  const avgRating = avgTrueRating(recruit)
  const existingInterest = recruit.scoutGrades?.[userSchoolId]?.interest ?? 0
  let prob
  if (avgRating >= 75) prob = 0.30
  else if (avgRating >= 65) prob = 0.55
  else if (avgRating >= 55) prob = 0.75
  else prob = 0.85
  prob *= feeMult * coachMult * momentumMult * (1 + existingInterest / 150)
  return clamp(prob, 0, 0.95)
}

export function rsvpLabel(prob) {
  if (prob >= 0.65) return { label: 'Likely', color: 'text-green-700', bg: 'bg-green-50' }
  if (prob >= 0.35) return { label: 'Unsure', color: 'text-amber-700', bg: 'bg-amber-50' }
  return { label: 'Probably not', color: 'text-gray-500', bg: 'bg-gray-50' }
}

/**
 * Predict prospect camp turnout.
 *
 * Calibration target: Bushnell at $125 fee with average coach + neutral
 * program 30-40 attendees. Hard cap at 100, floor at 20 (otherwise camp
 * doesn't run).
 *
 * Attendance sources:
 *   1. INVITED players — guaranteed-ish attendance (fee-modulated)
 *   2. WALK-ONS — players in the pool with high interest in your program
 *      show up uninvited (program-momentum-driven)
 *
 * Turnout factors (multipliers stack):
 *   - Fee: lower = more, higher = fewer
 *   - Coach recruiter rating
 *   - Program momentum (recent W-L, conf rankings)
 *   - Existing interest in your program
 *
 * @param {Object<string,import('./types.js').Recruit>} recruits
 * @param {string} userSchoolId
 * @param {string[]} invitedIds       recruit IDs the coach explicitly invited
 * @param {number} feePerAttendee
 * @param {number} coachRecruiterRating
 * @param {number} programMomentum    0-100, e.g. last season's win pct × 100
 * @returns {{ predictedAttendees: number, invitedAttendees: number, walkOns: number }}
 */
export function predictCampTurnout(recruits, userSchoolId, invitedIds, feePerAttendee, coachRecruiterRating, programMomentum) {
  // Fee multiplier — calibrated so $125 produces ~1.0×
  // ($50 ~1.5×, $125 1.0×, $200 ~0.6×)
  const feeMult = clamp(1.5 - (feePerAttendee - 50) / 200, 0.4, 1.6)
  // Coach + momentum multipliers (0.7–1.4× each)
  const coachMult = 0.7 + (coachRecruiterRating / 100) * 0.7
  const momentumMult = 0.7 + (programMomentum / 100) * 0.7

  const invitedSet = new Set(invitedIds)
  let invitedAttendees = 0
  let walkOns = 0

  for (const r of Object.values(recruits)) {
    // CAMP IS HS-ONLY per Nate's direction
    if (r.pool !== 'HS_SR') continue
    if (r.status === 'signed' || r.status === 'lost') continue

    const avgRating = avgTrueRating(r)
    const existingInterest = r.scoutGrades[userSchoolId]?.interest ?? 0

    if (invitedSet.has(r.id)) {
      let base
      if (avgRating >= 75) base = 0.30
      else if (avgRating >= 65) base = 0.55
      else if (avgRating >= 55) base = 0.75
      else base = 0.85
      base *= feeMult * coachMult * momentumMult
      base *= 1 + existingInterest / 150
      invitedAttendees += clamp(base, 0, 1)
    } else {
      const proximityBonus = r.hometown.state === 'OR' || r.hometown.state === 'WA' ? 1.5 : 1.0
      let base = (existingInterest / 100) * 0.4
      base *= feeMult * coachMult * momentumMult * proximityBonus
      const reputationFloor = (programMomentum / 100) * 0.015
      base += reputationFloor
      walkOns += clamp(base, 0, 0.6)
    }
  }

  // Cap walk-ons at CAMP_MAX_WALKONS
  const cappedWalkOns = Math.min(walkOns, CAMP_MAX_WALKONS)
  const predictedAttendees = Math.min(CAMP_MAX_ATTENDEES, Math.round(invitedAttendees + cappedWalkOns))
  return {
    predictedAttendees,
    invitedAttendees: Math.round(invitedAttendees),
    walkOns: Math.round(cappedWalkOns),
  }
}

/**
 * Simulate prospect camp attendance. Returns attendees + revenue, or null
 * if attendance falls below the 20-player minimum (camp cancelled).
 *
 * @returns {{ attendeeIds: string[], revenue: number, recruits: any, cancelled?: boolean, reason?: string }}
 */
export function simProspectCamp(recruits, userSchoolId, invitedIds, feePerAttendee, coachRecruiterRating, programMomentum, year, seed) {
  const rng = makeRng('camp', userSchoolId, year, seed)
  const attendeeIds = []
  const invitedSet = new Set(invitedIds || [])

  const feeMult = clamp(1.5 - (feePerAttendee - 50) / 200, 0.4, 1.6)
  const coachMult = 0.7 + (coachRecruiterRating / 100) * 0.7
  const momentumMult = 0.7 + (programMomentum / 100) * 0.7

  let walkOnsAccepted = 0
  for (const r of Object.values(recruits)) {
    // HS only per Nate's direction
    if (r.pool !== 'HS_SR') continue
    if (r.status === 'signed' || r.status === 'lost') continue
    if (attendeeIds.length >= CAMP_MAX_ATTENDEES) break

    const isInvited = invitedSet.has(r.id)
    // Enforce walk-on cap
    if (!isInvited && walkOnsAccepted >= CAMP_MAX_WALKONS) continue

    const avgRating = avgTrueRating(r)
    const existingInterest = r.scoutGrades[userSchoolId]?.interest ?? 0
    let prob

    if (isInvited) {
      if (avgRating >= 75) prob = 0.30
      else if (avgRating >= 65) prob = 0.55
      else if (avgRating >= 55) prob = 0.75
      else prob = 0.85
      prob *= feeMult * coachMult * momentumMult * (1 + existingInterest / 150)
    } else {
      const proximityBonus = (r.hometown.state === 'OR' || r.hometown.state === 'WA') ? 1.5 : 1.0
      prob = (existingInterest / 100) * 0.4
      prob *= feeMult * coachMult * momentumMult * proximityBonus
      prob += (programMomentum / 100) * 0.015
    }

    if (rng.chance(Math.min(prob, 0.95))) {
      if (!isInvited) walkOnsAccepted++
      attendeeIds.push(r.id)
      // Apply camp effects
      if (!r.scoutGrades[userSchoolId]) {
        r.scoutGrades[userSchoolId] = { interest: 0, noise: 15, revealedPreferences: [], actionsApplied: [] }
      }
      // Attending camp = ~50% scouted out of the gate. Bump apSpent to 5 so
      // the scouting progress bar shows it; drop noise to 7 (full-scout floor
      // is 2 once they have 10+ AP spent across actions).
      r.scoutGrades[userSchoolId].interest = Math.min(100, r.scoutGrades[userSchoolId].interest + 25)
      r.scoutGrades[userSchoolId].noise = Math.min(r.scoutGrades[userSchoolId].noise, 7)
      r.scoutGrades[userSchoolId].apSpent = Math.max(r.scoutGrades[userSchoolId].apSpent || 0, 5)
      r.scoutGrades[userSchoolId].actionsApplied.push('CAMP_ATTEND')
      const undisclosed = Object.keys(r.preferences).filter(
        p => !r.scoutGrades[userSchoolId].revealedPreferences.includes(p),
      )
      if (undisclosed.length > 0) {
        r.scoutGrades[userSchoolId].revealedPreferences.push(rng.pick(undisclosed))
      }
      // Small permanent rating bump
      const block = r.isPitcher ? r.truePitcher : r.trueHitter
      for (const k of Object.keys(block)) {
        if (rng.chance(0.25)) block[k] = Math.min(99, block[k] + 1)
      }
    }
  }

  // Per Nate (May 2026): camp ALWAYS runs. If natural turnout falls short of
  // CAMP_MIN_ATTENDEES, we top up with additional walk-ons (any remaining HS
  // recruit not already an attendee) until we hit the floor. The walk-on cap
  // is relaxed for this fill since the alternative is cancellation (worse
  // outcome than "the camp had some random extra kids show up").
  if (attendeeIds.length < CAMP_MIN_ATTENDEES) {
    const eligible = Object.values(recruits)
      .filter(r => r.pool === 'HS_SR' && r.status !== 'signed' && r.status !== 'lost')
      .filter(r => !attendeeIds.includes(r.id))
    // Prefer recruits with at least SOME existing interest, then by avg rating
    eligible.sort((a, b) => {
      const ai = a.scoutGrades?.[userSchoolId]?.interest ?? 0
      const bi = b.scoutGrades?.[userSchoolId]?.interest ?? 0
      if (ai !== bi) return bi - ai
      return avgTrueRating(b) - avgTrueRating(a)
    })
    for (const r of eligible) {
      if (attendeeIds.length >= CAMP_MIN_ATTENDEES) break
      attendeeIds.push(r.id)
      if (!r.scoutGrades[userSchoolId]) {
        r.scoutGrades[userSchoolId] = { interest: 0, noise: 15, revealedPreferences: [], actionsApplied: [] }
      }
      r.scoutGrades[userSchoolId].interest = Math.min(100, r.scoutGrades[userSchoolId].interest + 15)
      r.scoutGrades[userSchoolId].noise = Math.min(r.scoutGrades[userSchoolId].noise, 9)
      r.scoutGrades[userSchoolId].apSpent = Math.max(r.scoutGrades[userSchoolId].apSpent || 0, 3)
      r.scoutGrades[userSchoolId].actionsApplied.push('CAMP_ATTEND')
    }
  }

  const revenue = attendeeIds.length * feePerAttendee
  return { attendeeIds, revenue, recruits }
}

// ─── Fundraising (AP $) ────────────────────────────────────────────────────

/**
 * Spend AP on fundraising — donor calls, alumni outreach, community events.
 * Returns $ raised. Coach motivator + program prestige drive the rate.
 *
 * @param {number} apSpent
 * @param {number} coachMotivator
 * @param {number} programHistory
 * @returns {number}
 */
export function fundraise(apSpent, coachMotivator, programHistory) {
  // Base: $550/AP, scales 0.7×–1.6× by motivator, 0.7×–1.6× by program history.
  // At 10 AP, motivator=65, history=50 ~$8.1K. Top-end (90 / 70) ~$11K.
  // Never quite hits $13K to keep the lever from feeling overpowered.
  const motivatorMult = 0.7 + (coachMotivator / 100) * 0.9
  const historyMult = 0.7 + (programHistory / 100) * 0.9
  return Math.round(apSpent * 550 * motivatorMult * historyMult)
}

// ─── NLI signing logic ───────────────────────────────────────────────────────
//
// No fixed signing day. Instead:
//   - When user makes a scholarship offer + interest ≥ 50, recruit "considers"
//   - Each week, a recruit weighs interest + preferences + offer $ + competing
//     offers and may sign with the program they prefer most.
//   - Once signed, the player is bound by NAIA LOI. D1/D2 schools can swoop
//     in with rare probability (~3%/week until enrollment).

/**
 * Make or modify a live scholarship offer.
 * Offer stays live until withdrawn or recruit signs / commits elsewhere.
 *
 * @param {import('./types.js').Recruit} recruit
 * @param {string} userSchoolId
 * @param {number} amount   $ per year of scholarship
 */
export function setLiveOffer(recruit, userSchoolId, amount) {
  if (!recruit.scoutGrades[userSchoolId]) {
    recruit.scoutGrades[userSchoolId] = { interest: 0, noise: 15, revealedPreferences: [], actionsApplied: [] }
  }
  const existing = recruit.liveOffer
  if (!existing || existing.schoolId !== userSchoolId) {
    // First offer from this school
    recruit.liveOffer = {
      schoolId: userSchoolId,
      amount,
      weeksOutstanding: 0,
      changes: 1,
    }
    // Initial interest bump for first offer
    recruit.scoutGrades[userSchoolId].interest = Math.min(100, recruit.scoutGrades[userSchoolId].interest + 12)
    recruit.scoutGrades[userSchoolId].actionsApplied.push('SCHOLARSHIP_OFFER')
  } else {
    // Modification — bigger offer is a positive signal; smaller is negative
    const delta = amount - existing.amount
    if (delta > 0) {
      const bumpPct = Math.min(20, Math.round(delta / 1000))
      recruit.scoutGrades[userSchoolId].interest = Math.min(100, recruit.scoutGrades[userSchoolId].interest + bumpPct)
    } else if (delta < 0) {
      const dropPct = Math.min(15, Math.round(-delta / 1000))
      recruit.scoutGrades[userSchoolId].interest = Math.max(0, recruit.scoutGrades[userSchoolId].interest - dropPct)
    }
    existing.amount = amount
    existing.changes++
  }
  if (!recruit.interestedSchools.includes(userSchoolId)) {
    recruit.interestedSchools.push(userSchoolId)
  }
  applyFullScoutIfEligible(recruit, userSchoolId)
}

/**
 * Withdraw a live offer.
 */
export function withdrawOffer(recruit, userSchoolId) {
  if (recruit.liveOffer && recruit.liveOffer.schoolId === userSchoolId) {
    recruit.liveOffer = null
    if (recruit.scoutGrades[userSchoolId]) {
      recruit.scoutGrades[userSchoolId].interest = Math.max(0, recruit.scoutGrades[userSchoolId].interest - 20)
    }
  }
}

/**
 * Decide if a recruit signs this tick. Suitor-count aware:
 *   - Few suitors (0-1) sign fast (high % per week)
 *   - Many suitors (5+) take time (low % per week, more shopping around)
 *
 * @param {import('./types.js').Recruit} recruit
 * @param {string} userSchoolId
 * @param {import('./types.js').School} school
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @returns {string | null}   the school they signed with, or null
 */
export function tryAdvanceRecruit(recruit, userSchoolId, school, rng, state = null) {
  if (recruit.status === 'signed' || recruit.status === 'lost') return null
  const grade = recruit.scoutGrades[userSchoolId]
  if (!grade) return null
  if (grade.interest < 45) return null
  if (!recruit.liveOffer || recruit.liveOffer.schoolId !== userSchoolId) return null

  const suitorCount = totalSuitors(recruit)

  // Offer competitiveness — average rival offer is ~$8K-$15K; if our offer is meaningfully above that, helps
  const avgRivalOffer = 8000 + suitorCount * 1500
  const offerAdvantage = (recruit.liveOffer.amount - avgRivalOffer) / 5000   // -2 to +3 typically

  // Build per-preference context for the full 8-preference fit calculation.
  // state is optional — when missing, the missing-context prefs just don't
  // contribute (which preserves backwards-compat for callers that don't
  // pass state).
  const ctx = { offerAdvantage }
  if (state) {
    const team = state.teams?.[userSchoolId]
    const userHC = team ? state.coaches?.[team.headCoachId] : null
    if (userHC) ctx.coachDeveloper = userHC.developer ?? 55
    // Playing-time proxy: how thin are we at the recruit's position?
    if (team && state.players) {
      const pos = recruit.primaryPosition
      const sameSpot = team.rosterPlayerIds
        .map(id => state.players[id])
        .filter(p => p && !p.isPitcher === !recruit.isPitcher
          && (recruit.isPitcher ? p.isPitcher : p.primaryPosition === pos))
        .length
      // 0 returners 1.0 wide open, 4+ 0.1 jammed
      ctx.ptAvailability = clamp(1 - sameSpot * 0.22, 0.1, 1.0)
    }
    // Pipeline match: recruit's home region matches coach's primary or
    // secondary region (or legacy regions[] for older saves).
    if (userHC) {
      const recruitRegion = STATE_TO_REGION[recruit.hometown.state]
      ctx.pipelineMatch = coachRegionList(userHC).includes(recruitRegion)
    }
  }
  const fitScore = computeFitScore(recruit, school, grade.interest, ctx)

  // Base sign probability scales with fit + offer; suitor count divides it
  let baseProb = (fitScore / 200 + grade.interest / 400 + offerAdvantage * 0.15)

  // TOP-3 PRIORITIES BOOST — when your school nails the recruit's three
  // main priorities, they decide faster. Real-world parallel: a kid who
  // wants playing time + close to home + a good development coach makes
  // up his mind in weeks if a school checks all three boxes, even if a
  // bigger program is sniffing around.
  const fit3 = topPriorityFit(recruit, school, ctx)
  if (fit3 >= 75) baseProb *= 1.6        // hitting their top 3 → 60% faster decisions
  else if (fit3 >= 60) baseProb *= 1.25  // good fit → 25% faster
  else if (fit3 < 35) baseProb *= 0.55   // missing their priorities → much slower

  // Offer freshness bonus — recruits don't sit on offers forever; the longer
  // an offer's been out + relationship's been built, the more decisive they
  // get. After 4 weeks of consideration, +25% per the next 4 weeks.
  const weeksOut = recruit.liveOffer.weeksOutstanding || 0
  if (weeksOut >= 4) baseProb *= 1 + Math.min(0.4, (weeksOut - 4) * 0.07)

  const suitorDivisor = 1 + suitorCount * 0.7   // 1 suitor: ÷1.7; 5 suitors: ÷4.5

  const signProb = clamp(baseProb / suitorDivisor, 0.02, 0.92)
  if (rng.chance(signProb)) {
    recruit.status = 'signed'
    recruit.signedTo = userSchoolId
    return userSchoolId
  }
  return null
}

/**
 * D1 (and rarely D2) steal of a signed-but-not-yet-enrolled recruit.
 * Should be RARE for Bushnell (once every few years).
 * Probability scales with how desirable the recruit is.
 */
export function rollSignedSteal(recruit, rng) {
  if (recruit.status !== 'signed') return false
  // Steal probability per week. Tuned to ~0.2-0.5% per recruit per week.
  // For a typical signed class of 8-10 over 30 weeks, expected losses < 1 per year.
  const avgRating = avgTrueRating(recruit)
  // Higher-rated recruits more attractive to D1/D2 steals
  const baseProb = avgRating >= 75 ? 0.005 : avgRating >= 65 ? 0.002 : 0.0005
  if (rng.chance(baseProb)) {
    recruit.status = 'lost'
    recruit.stolenBy = avgRating >= 70 ? 'D1' : 'D2/D3'
    return true
  }
  return false
}

/**
 * Compute a fit score for a (recruit, school) pair using all 8 preference
 * weights. Higher fit = higher signing probability. Each preference scores
 * the school's standing in that area times the recruit's individual weight,
 * so a recruit who deeply cares about $ responds more to a generous offer,
 * a recruit who values playing time responds more to a thin depth chart,
 * etc.
 *
 * @param {*} recruit
 * @param {*} school
 * @param {number} interest
 * @param {{ offerAdvantage?: number, ptAvailability?: number, coachDeveloper?: number, pipelineMatch?: boolean }} [ctx]
 */
function computeFitScore(recruit, school, interest, ctx = {}) {
  const prefs = recruit.preferences
  let score = 0
  // Interest is a direct multiplier — base 50% of total
  score += interest * 0.5
  // Proximity: same region = good
  const recruitRegion = STATE_TO_REGION[recruit.hometown.state]
  if (recruitRegion === school.region) score += prefs.proximity * 4
  // Program history (wins, reputation)
  score += (school.programHistory / 100) * prefs.program_history * 4
  // Facilities
  score += (school.facilityRating / 100) * prefs.facilities * 4
  // Academics
  score += (school.academicReputation / 100) * prefs.academics * 4
  // Financial — offerAdvantage is the offer minus avg rival offer / 5000
  // (range roughly -3 to +3). Weighted by the recruit's $$$ priority.
  if (typeof ctx.offerAdvantage === 'number') {
    score += clamp(ctx.offerAdvantage, -3, 3) * prefs.financial * 2.5
  }
  // Playing time — ptAvailability 0-1 (0 = no spots open at position,
  // 1 = wide open). Weighted by recruit's playing-time priority.
  if (typeof ctx.ptAvailability === 'number') {
    score += ctx.ptAvailability * prefs.playing_time * 4
  }
  // Coaching — head coach's developer rating drives this. Recruit's
  // coaching priority weight applies.
  if (typeof ctx.coachDeveloper === 'number') {
    score += (ctx.coachDeveloper / 100) * prefs.coaching * 4
  }
  // Pipeline fit — coach has the recruit's region in their pipelines
  if (ctx.pipelineMatch) {
    score += prefs.pipeline_fit * 5
  }
  return score
}

// ─── Top-3 priorities + offer-reaction model ────────────────────────────────
//
// Recruits really only think about 3 things when picking a school. The 8
// preference weights still drive the underlying fit-score math (so we don't
// have to retune the engine), but the user-facing model is the top-3 list:
//
//   - We surface only the 3 highest-weight prefs as "priorities" in UI.
//   - The user gets a school-fit % across just those 3.
//   - When you make an offer, the recruit "reacts" based on (a) how the $
//     compares to market, and (b) how well your school satisfies their top
//     3 priorities.
//   - Once a recruit is fully scouted + you've made at least one offer,
//     we reveal the "commit price" — the $ that gets you to a 70%+ chance
//     of locking them up THIS week (or "Not realistic" when fit is broken).

/**
 * Top 3 priority keys for a recruit, highest weight first. Ties broken by
 * the canonical key order so the same recruit always shows the same 3.
 */
export function getTopPriorities(recruit) {
  if (!recruit?.preferences) return []
  const PREF_ORDER = ['financial', 'proximity', 'playing_time', 'program_history',
    'facilities', 'academics', 'coaching', 'pipeline_fit']
  return [...PREF_ORDER]
    .map(k => ({ key: k, weight: recruit.preferences[k] ?? 0 }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map(x => x.key)
}

/**
 * Per-priority "how good is YOUR school at this" score, returned as 0..100
 * so the UI can render a colored bar per priority.
 *
 * Each priority key reads the corresponding school dimension and clamps
 * to a 0-100 fit. `ctx` lets us account for live, per-pair signals like the
 * current offer amount or playing-time availability — same hooks the fit
 * score uses for sign probability.
 *
 * @returns {Object<string, number>}   priorityKey → 0..100 fit score
 */
export function priorityFitScores(recruit, school, ctx = {}) {
  if (!recruit || !school) return {}
  const recruitRegion = STATE_TO_REGION[recruit.hometown?.state]
  // Financial: how does the live offer compare to "market" ($8-15K typical)
  let financial = 50
  if (typeof ctx.offerAdvantage === 'number') {
    // offerAdvantage ranges roughly -3..+3
    financial = clamp(50 + ctx.offerAdvantage * 18, 0, 100)
  }
  return {
    financial,
    proximity: recruitRegion === school.region ? 90 : 35,
    playing_time: typeof ctx.ptAvailability === 'number'
      ? clamp(ctx.ptAvailability * 100, 0, 100)
      : 50,
    program_history: clamp(school.programHistory || 50, 0, 100),
    facilities: clamp(school.facilityRating || 50, 0, 100),
    academics: clamp(school.academicReputation || 50, 0, 100),
    coaching: typeof ctx.coachDeveloper === 'number'
      ? clamp(ctx.coachDeveloper, 0, 100)
      : 50,
    pipeline_fit: ctx.pipelineMatch ? 90 : 35,
  }
}

/**
 * 0-100 composite fit on a recruit's TOP 3 priorities only — the number
 * that drives offer reactions + commit proximity surfacing.
 */
export function topPriorityFit(recruit, school, ctx = {}) {
  const top = getTopPriorities(recruit)
  if (top.length === 0) return 50
  const scores = priorityFitScores(recruit, school, ctx)
  let total = 0
  let totalWeight = 0
  for (const key of top) {
    const w = recruit.preferences?.[key] ?? 5
    total += (scores[key] ?? 50) * w
    totalWeight += w
  }
  return totalWeight > 0 ? Math.round(total / totalWeight) : 50
}

/**
 * Build the recruit's reaction to the current live offer + how close to a
 * commit they are. Returns a struct the UI can render directly.
 *
 * Pass full `state` so we can read coach pipelines + roster depth.
 *
 * @returns {{
 *   hasOffer: boolean,
 *   offerReaction: 'INSULTED'|'LOWBALL'|'FAIR'|'STRONG'|'BLOWN_AWAY'|null,
 *   offerReactionLine: string,
 *   commitProximity: 'COLD'|'WARMING'|'WARM'|'LEANING_YOU'|'READY_TO_SIGN',
 *   commitLine: string,
 *   topPriorityFit: number,        // 0..100 on the user's top 3
 *   priorityScores: object,
 *   commitPrice: number|null,      // $ that would push to ~70% sign this week, or null
 *   commitPriceNote: string|null,  // helper text when no realistic price exists
 * }}
 */
export function buildRecruitFeedback(recruit, userSchoolId, state) {
  const school = state?.schools?.[userSchoolId]
  if (!recruit || !school) {
    return {
      hasOffer: false, offerReaction: null, offerReactionLine: '',
      commitProximity: 'COLD', commitLine: '',
      topPriorityFit: 50, priorityScores: {},
      commitPrice: null, commitPriceNote: null,
    }
  }
  const grade = recruit.scoutGrades?.[userSchoolId] || { interest: 0 }
  const hasOffer = recruit.liveOffer?.schoolId === userSchoolId

  // Build the same ctx the sign-probability path uses
  const team = state?.teams?.[userSchoolId]
  const userHC = team ? state?.coaches?.[team.headCoachId] : null
  const ctx = {}
  if (userHC) ctx.coachDeveloper = userHC.developer ?? 55
  if (team && state.players) {
    const pos = recruit.primaryPosition
    const sameSpot = team.rosterPlayerIds
      .map(id => state.players[id])
      .filter(p => p && !p.isPitcher === !recruit.isPitcher
        && (recruit.isPitcher ? p.isPitcher : p.primaryPosition === pos))
      .length
    ctx.ptAvailability = clamp(1 - sameSpot * 0.22, 0.1, 1.0)
  }
  if (userHC) {
    const recruitRegion = STATE_TO_REGION[recruit.hometown?.state]
    ctx.pipelineMatch = coachRegionList(userHC).includes(recruitRegion)
  }

  // Offer reaction — depends on $ vs market AND how generous the recruit
  // perceives it relative to peers
  const suitorCount = totalSuitors(recruit)
  const avgRivalOffer = 8000 + suitorCount * 1500
  let offerAdvantage = 0
  if (hasOffer) {
    offerAdvantage = (recruit.liveOffer.amount - avgRivalOffer) / 5000
    ctx.offerAdvantage = offerAdvantage
  }
  const priorityScores = priorityFitScores(recruit, school, ctx)
  const fit3 = topPriorityFit(recruit, school, ctx)

  let offerReaction = null
  let offerReactionLine = ''
  if (hasOffer) {
    if (offerAdvantage < -1.4) {
      offerReaction = 'INSULTED'
      offerReactionLine = '"Not even close. I expected more."'
    } else if (offerAdvantage < -0.4) {
      offerReaction = 'LOWBALL'
      offerReactionLine = '"It\'s a little light. Other schools are higher."'
    } else if (offerAdvantage < 0.6) {
      offerReaction = 'FAIR'
      offerReactionLine = '"Fair offer. About what I expected from a program like yours."'
    } else if (offerAdvantage < 1.6) {
      offerReaction = 'STRONG'
      offerReactionLine = '"Strong number. You\'re showing me you really want me."'
    } else {
      offerReaction = 'BLOWN_AWAY'
      offerReactionLine = '"Wow — that\'s a lot to leave on the table."'
    }
  }

  // Commit proximity — uses fit on top 3 + interest + offer + suitor count.
  // Mirrors tryAdvanceRecruit but as a discrete bucket.
  // signProb math (approximation): baseProb / (1 + suitors*0.7)
  const baseProb = (fit3 / 200) + (grade.interest / 400) + (offerAdvantage * 0.15)
  const proximityProb = clamp(baseProb / (1 + suitorCount * 0.7), 0, 0.95)
  let commitProximity = 'COLD'
  let commitLine = '"Just hearing you out for now."'
  if (proximityProb >= 0.55) {
    commitProximity = 'READY_TO_SIGN'
    commitLine = '"I\'m ready. If you call my name, I sign."'
  } else if (proximityProb >= 0.35) {
    commitProximity = 'LEANING_YOU'
    commitLine = '"You\'re my front-runner. Couple more conversations and I think we\'re there."'
  } else if (proximityProb >= 0.20) {
    commitProximity = 'WARM'
    commitLine = '"You\'re in the mix. Still seeing what else comes in."'
  } else if (proximityProb >= 0.08) {
    commitProximity = 'WARMING'
    commitLine = '"Getting more interested. Keep showing me you care."'
  }

  // Commit price reveal — only once recruit is fully scouted + we've made
  // at least one offer (so we have grounding in their reaction).
  let commitPrice = null
  let commitPriceNote = null
  if (hasOffer && isFullyScouted(recruit, userSchoolId)) {
    // Find the $ where signProb hits 0.70 — invert the baseProb formula.
    // Target: baseProb >= 0.70 * (1 + suitorCount * 0.7)
    const target = 0.70 * (1 + suitorCount * 0.7)
    // baseProb = fit3/200 + interest/400 + offerAdvantage*0.15
    // Solve for offerAdvantage:
    const headroom = target - (fit3 / 200) - (grade.interest / 400)
    if (headroom <= 0) {
      // Already enough fit + interest for current offer — quote the floor
      commitPrice = Math.max(0, recruit.liveOffer.amount)
      commitPriceNote = 'Current offer is already enough — sign window open.'
    } else {
      const requiredOfferAdv = headroom / 0.15
      const required$ = Math.round(avgRivalOffer + requiredOfferAdv * 5000)
      if (required$ > avgRivalOffer * 6) {
        // No realistic price — fit too low or too many suitors
        commitPrice = null
        commitPriceNote = 'No realistic price closes this — fit + interest are too low. Spend more on relationship-building (visits, calls) first.'
      } else {
        commitPrice = required$
        commitPriceNote = null
      }
    }
  }

  return {
    hasOffer, offerReaction, offerReactionLine,
    commitProximity, commitLine,
    topPriorityFit: fit3, priorityScores,
    commitPrice, commitPriceNote,
  }
}

/**
 * Estimate the noisy ratings a coach sees on a recruit.
 */
export function estimateRecruitRatings(recruit, userSchoolId, rng) {
  const grade = recruit.scoutGrades[userSchoolId]
  const noise = grade?.noise ?? 15
  if (recruit.isPitcher) {
    const out = {}
    for (const [k, v] of Object.entries(recruit.truePitcher)) {
      out[k] = noisyRating(v, noise, rng)
    }
    return { type: 'pitcher', ratings: out, noise }
  }
  const out = {}
  for (const [k, v] of Object.entries(recruit.trueHitter)) {
    out[k] = noisyRating(v, noise, rng)
  }
  return { type: 'hitter', ratings: out, noise }
}
