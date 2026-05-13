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
import jucoTeamsRaw from '../data/juco_teams.json'

// Recruit pool sizes
const HS_POOL_SIZE = 500
const JUCO_POOL_SIZE = 200
const PORTAL_POOL_SIZE = 80
const D1_PORTAL_SIZE = 80          // bumped way up — lots of D1 transfers each year
const D2_PORTAL_SIZE = 40
const D3_PORTAL_SIZE = 35

const ALL_JUCO_TEAMS = jucoTeamsRaw.leagues.flatMap(l => l.teams.map(t => ({ ...t, leagueId: l.id, pipelineFlag: l.pipelineFlag })))

const POSITIONS = ['C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF', 'SP', 'RP']

// ─── Geographic distribution ─────────────────────────────────────────────────
//
// Most NAIA recruits to Bushnell come from the PNW + West Coast. Geographic
// reach extends east only via coach pipelines or for the rare exotic
// recruit. This map weights the recruit pool's home-state distribution so
// the user's recruiting board feels regional.

const HOME_REGION_WEIGHTS_PNW = {
  // Heavy: PNW + adjacent
  WA: 18, OR: 18, ID: 10, MT: 4, BC: 4,
  // Moderate: West Coast
  CA: 18, NV: 4, AZ: 5, UT: 3,
  // Light: Mountain West + adjacent
  WY: 1, CO: 2, NM: 1, TX: 3, OK: 1,
  // Rare: Midwest + South + East
  ND: 0.5, SD: 0.5, NE: 0.5, KS: 0.5, MN: 0.5, IA: 0.5, MO: 0.5,
  IL: 0.5, IN: 0.5, MI: 0.5, OH: 0.5, WI: 0.5,
  FL: 0.5, GA: 0.5, AL: 0.5, MS: 0.5, TN: 0.5, NC: 0.5, SC: 0.5, KY: 0.5,
  PA: 0.2, NY: 0.2, NJ: 0.2, MA: 0.2, CT: 0.2,
  AR: 0.5, LA: 0.5, VA: 0.3, WV: 0.2,
}

/**
 * Apply coach pipelines to bump up specific regions / states for this coach's recruit board.
 * E.g. coach has TEXAS_JUCO pipeline → TX weight ×8.
 */
function pipelineWeightBoosts(coach) {
  if (!coach) return {}
  const boosts = {}
  for (const p of coach.pipelines || []) {
    if (p === 'TEXAS_JUCO') { boosts.TX = 8; boosts.OK = 3; boosts.LA = 3 }
    if (p === 'CALIFORNIA_JUCO') { boosts.CA = 5; boosts.AZ = 2 }
    if (p === 'NWAC') { boosts.WA = 3; boosts.OR = 3; boosts.ID = 2; boosts.BC = 2 }
    if (p === 'FLORIDA_JUCO') { boosts.FL = 8; boosts.GA = 3 }
    if (p === 'MIDWEST_JUCO') { boosts.IL = 4; boosts.IN = 3; boosts.IA = 3; boosts.MO = 3; boosts.KS = 3 }
    if (p === 'D1_PORTAL') { /* affects only NAIA_TRANSFER pool with D1_TRANSFER pool */ }
    if (p === 'HBCU') { boosts.GA = 4; boosts.AL = 4; boosts.MS = 3 }
    if (p === 'DOMINICAN_REPUBLIC') { /* international not yet modeled in v1.5 */ }
  }
  // Also boost coach's explicit regions
  for (const state of coach.regions || []) {
    boosts[state] = Math.max(boosts[state] || 0, 4)
  }
  return boosts
}

/**
 * Compose final state weights for a coach. Multiplies pipeline boosts onto the
 * baseline PNW-heavy distribution.
 */
function stateWeightsForCoach(coach) {
  const boosts = pipelineWeightBoosts(coach)
  const out = {}
  for (const [state, baseWeight] of Object.entries(HOME_REGION_WEIGHTS_PNW)) {
    const boost = boosts[state] || 1
    out[state] = baseWeight * boost
  }
  return out
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
export function generateRecruitPool(year, seed, coach = null) {
  /** @type {Object<string, import('./types.js').Recruit>} */
  const pool = {}
  const rng = makeRng('recruitPool', year, seed)
  const stateWeights = stateWeightsForCoach(coach)

  for (let i = 0; i < HS_POOL_SIZE; i++) {
    const r = makeRecruit('HS_SR', i, year, rng, stateWeights)
    pool[r.id] = r
  }
  for (let i = 0; i < JUCO_POOL_SIZE; i++) {
    const r = makeRecruit('JUCO', i, year, rng, stateWeights)
    pool[r.id] = r
  }
  // Portal pool is generated separately when portal phase opens
  return pool
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

  const primaryPosition = rng.pick(POSITIONS)
  const isPitcher = primaryPosition === 'SP' || primaryPosition === 'RP'

  // Rating distribution per pool. NAIA reality:
  //   - HS SR: mean 50, capped ~88 (no 92-rated HS kids in NAIA recruiting board —
  //     those guys go straight to D1)
  //   - JUCO: proven mid-grade
  //   - NAIA portal: average; sometimes mid-grade unhappy players
  //   - D1 portal split: UNDERUSED = good (mean 76), YOUNG = lower current but
  //     higher potential (mean 56, high pot)
  //   - D2/D3: middle and lower
  // CAPS: HS capped at 88, JUCO/NAIA at 88, D1_UNDERUSED at 94, D1_YOUNG at 80
  let meanRating, stddev, cap
  if (pool === 'HS_SR')       { meanRating = 50; stddev = 10; cap = 88 }
  else if (pool === 'JUCO')   { meanRating = 58; stddev = 9;  cap = 88 }
  else if (pool === 'NAIA_TRANSFER') { meanRating = 56; stddev = 10; cap = 88 }
  else if (pool === 'D1_TRANSFER' && subtype === 'D1_UNDERUSED') { meanRating = 76; stddev = 6; cap = 94 }
  else if (pool === 'D1_TRANSFER' && subtype === 'D1_YOUNG')     { meanRating = 56; stddev = 8; cap = 80 }
  else if (pool === 'D1_TRANSFER') { meanRating = 68; stddev = 8;  cap = 92 }
  else if (pool === 'D2_TRANSFER') { meanRating = 60; stddev = 9;  cap = 88 }
  else if (pool === 'D3_TRANSFER') { meanRating = 52; stddev = 9;  cap = 82 }
  else                             { meanRating = 55; stddev = 10; cap = 88 }

  const ratingFn = () => Math.round(clamp(rng.gaussian(meanRating, stddev), 30, cap))
  const trueHitter = {
    contact_l: ratingFn(), contact_r: ratingFn(),
    power_l: ratingFn(), power_r: ratingFn(),
    discipline: ratingFn(), speed: ratingFn(),
    fielding: ratingFn(), arm: ratingFn(),
  }
  const truePitcher = {
    stuff: ratingFn(), control: ratingFn(), command: ratingFn(),
    stamina: ratingFn(), vs_l: ratingFn(), vs_r: ratingFn(),
    composure: ratingFn(), durability: ratingFn(),
  }
  // Potential — D1 transfers have the HIGHEST potential gaps (especially YOUNG D1s
  // who entered the portal early after limited reps).
  let potBump
  if (pool === 'HS_SR') potBump = 14
  else if (pool === 'JUCO') potBump = 8
  else if (pool === 'D1_TRANSFER' && subtype === 'D1_YOUNG') potBump = 18    // huge upside
  else if (pool === 'D1_TRANSFER' && subtype === 'D1_UNDERUSED') potBump = 8 // already developed
  else if (pool === 'D1_TRANSFER') potBump = 12
  else if (pool === 'D2_TRANSFER') potBump = 6
  else if (pool === 'D3_TRANSFER') potBump = 9
  else potBump = 5
  const bump = (r) => Math.min(99, r + Math.round(rng.gaussian(potBump, 4)))
  const potHitter = Object.fromEntries(Object.entries(trueHitter).map(([k, v]) => [k, bump(v)]))
  const potPitcher = Object.fromEntries(Object.entries(truePitcher).map(([k, v]) => [k, bump(v)]))

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
    hometown: { city: state + ' area', state },
    pool,
    previousSchoolName,
    previousLeagueId,
    primaryPosition,
    positions: [primaryPosition],
    bats: rng.weighted(['R', 'L', 'S'], [70, 22, 8]),
    throws: rng.weighted(['R', 'L'], [80, 20]),
    trueHitter,
    truePitcher,
    truePotentialHitter: potHitter,
    truePotentialPitcher: potPitcher,
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
 *   30 → 1.5,  50 → 2.5,  60 → 2.9,  75 → 3.5,  90 → 3.9,  99 → 4.0
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
 *   4.0       → 50% of tuition
 *   3.8-3.99  → 45%
 *   3.5-3.79  → 40%
 *   3.0-3.49  → 30%
 *   2.5-2.99  → 20%
 *   2.0-2.49  → 10%
 *   < 2.0     → 0%
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

const STATE_TO_REGION = {
  WA: 'NW', OR: 'NW', ID: 'NW', BC: 'NW', MT: 'NW',
  CA: 'W', NV: 'W', AZ: 'W', UT: 'W', HI: 'W',
  TX: 'SW', OK: 'SW', NM: 'SW', AR: 'SW', LA: 'SW',
  FL: 'SE', GA: 'SE', AL: 'SE', MS: 'SE', TN: 'SE', NC: 'SE', SC: 'SE', KY: 'SE', VA: 'SE', WV: 'SE',
  IL: 'MW', IN: 'MW', IA: 'MW', MO: 'MW', KS: 'MW', NE: 'MW', OH: 'MW', MI: 'MW', WI: 'MW', MN: 'MW',
  ND: 'MW', SD: 'MW',
  WY: 'NW', CO: 'W',
  NY: 'NE', PA: 'NE', NJ: 'NE', MA: 'NE', CT: 'NE',
}

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
  SCOUT_TRIP: {
    key: 'SCOUT_TRIP',
    label: 'Scout Trip',
    apCost: 3,
    interestGain: 3,
    fogReduction: 6,
    prefRevealChance: 0.10,
    blurb: 'See them play. Big fog reduction.',
  },
  CAMP_INVITE: {
    key: 'CAMP_INVITE',
    label: 'Invite to Camp',
    apCost: 4,
    interestGain: 8,
    fogReduction: 8,
    prefRevealChance: 0.30,
    blurb: 'Big-time impact. Recruit sees facilities + coaches firsthand.',
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
      noise: 15,                  // initial sight = ±15 rating noise
      revealedPreferences: [],
      actionsApplied: [],
    }
  }
  const grade = recruit.scoutGrades[userSchoolId]
  grade.interest = Math.min(100, grade.interest + action.interestGain)
  grade.noise = Math.max(2, grade.noise - action.fogReduction)
  grade.actionsApplied.push(action.key)

  // Add school to interested list if not yet
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

  // Reveal suitors after a meaningful action (scout trip, home visit, camp visit, etc.)
  // — coaches learn about competition by talking to the player + family + HS coach.
  const REVEALING_ACTIONS = new Set(['SCOUT_TRIP', 'HOME_VISIT', 'CAMPUS_VISIT', 'CAMP_INVITE', 'ASSISTANT_TALK'])
  if (REVEALING_ACTIONS.has(action.key)) {
    recruit.suitorsRevealed = true
  }

  return { recruit, interestGain: action.interestGain, revealed }
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
 */
export function noisyRating(trueRating, noise, rng) {
  const adj = rng.gaussian(0, noise / 3)   // noise = 3σ band
  return Math.max(20, Math.min(99, Math.round(trueRating + adj)))
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
  // Portal opens after postseason wraps. In our calendar, postseason is week
  // 17+ of season mode. By the time we re-enter OFFSEASON (next year), portal
  // is open. The first "PORTAL_OPEN" phase happens after the first season has
  // completed at least once.
  if (calendar.mode === 'OFFSEASON' && calendar.year >= 2027) return 'PORTAL_OPEN'
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
// per attendee. Higher fees → fewer attendees. Better-rated recruits are
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
export const CAMP_MAX_WALKONS = 25       // Cap walk-on attendance to keep camp coach-driven

/**
 * Predict prospect camp turnout.
 *
 * Calibration target: Bushnell at $125 fee with average coach + neutral
 * program → 30-40 attendees. Hard cap at 100, floor at 20 (otherwise camp
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
      r.scoutGrades[userSchoolId].interest = Math.min(100, r.scoutGrades[userSchoolId].interest + 25)
      r.scoutGrades[userSchoolId].noise = Math.max(2, r.scoutGrades[userSchoolId].noise - 6)
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

  if (attendeeIds.length < CAMP_MIN_ATTENDEES) {
    return { attendeeIds: [], revenue: 0, recruits, cancelled: true, reason: `Only ${attendeeIds.length} would attend. Camp needs ${CAMP_MIN_ATTENDEES} minimum — cancelled. Try lowering the fee or inviting more players.` }
  }

  const revenue = attendeeIds.length * feePerAttendee
  return { attendeeIds, revenue, recruits }
}

// ─── Fundraising (AP → $) ────────────────────────────────────────────────────

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
  // Base: $800/AP, scales 0.7×–1.6× by motivator, 0.7×–1.6× by program history
  const motivatorMult = 0.7 + (coachMotivator / 100) * 0.9
  const historyMult = 0.7 + (programHistory / 100) * 0.9
  return Math.round(apSpent * 800 * motivatorMult * historyMult)
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
 *   - Few suitors (0-1) → sign fast (high % per week)
 *   - Many suitors (5+) → take time (low % per week, more shopping around)
 *
 * @param {import('./types.js').Recruit} recruit
 * @param {string} userSchoolId
 * @param {import('./types.js').School} school
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @returns {string | null}   the school they signed with, or null
 */
export function tryAdvanceRecruit(recruit, userSchoolId, school, rng) {
  if (recruit.status === 'signed' || recruit.status === 'lost') return null
  const grade = recruit.scoutGrades[userSchoolId]
  if (!grade) return null
  if (grade.interest < 45) return null
  if (!recruit.liveOffer || recruit.liveOffer.schoolId !== userSchoolId) return null

  const fitScore = computeFitScore(recruit, school, grade.interest)
  const suitorCount = totalSuitors(recruit)

  // Offer competitiveness — average rival offer is ~$8K-$15K; if our offer is meaningfully above that, helps
  const avgRivalOffer = 8000 + suitorCount * 1500
  const offerAdvantage = (recruit.liveOffer.amount - avgRivalOffer) / 5000   // -2 to +3 typically

  // Base sign probability scales with fit + offer; suitor count divides it
  const baseProb = (fitScore / 200 + grade.interest / 400 + offerAdvantage * 0.15)
  const suitorDivisor = 1 + suitorCount * 0.7   // 1 suitor: ÷1.7; 5 suitors: ÷4.5

  const signProb = clamp(baseProb / suitorDivisor, 0.02, 0.85)
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
 * Compute a fit score for a (recruit, school) pair using their revealed +
 * hidden preferences. v1.5 uses all preferences (game owner has visibility);
 * future v could limit to revealed only.
 */
function computeFitScore(recruit, school, interest) {
  const prefs = recruit.preferences
  let score = 0
  // Interest is a direct multiplier
  score += interest * 0.5
  // Proximity: same region = good
  const recruitRegion = STATE_TO_REGION[recruit.hometown.state]
  if (recruitRegion === school.region) score += prefs.proximity * 4
  // Program history
  score += (school.programHistory / 100) * prefs.program_history * 4
  // Facilities
  score += (school.facilityRating / 100) * prefs.facilities * 4
  // Academics
  score += (school.academicReputation / 100) * prefs.academics * 4
  return score
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
