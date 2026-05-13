/**
 * Coach generator + staff helpers.
 * See ../docs/coaches.md.
 */

import { pickFullName } from './names'
import { makeRng } from './rng'

/** @typedef {import('./types.js').Coach} Coach */
/** @typedef {import('./types.js').School} School */
/** @typedef {import('./types.js').CoachRole} CoachRole */
/** @typedef {import('./types.js').PipelineFlag} PipelineFlag */

// ─── Pipeline assignment by geography ────────────────────────────────────────

/**
 * Default pipelines for a coach at the given state.
 * Always adds JUCO_GENERAL as a baseline pipeline.
 */
function pipelinesForState(state, region, rng) {
  /** @type {PipelineFlag[]} */
  const out = ['JUCO_GENERAL']

  // Geography-driven primary pipelines
  if (['WA', 'OR', 'ID', 'BC', 'AK', 'MT'].includes(state)) {
    out.push('NWAC')
  }
  if (['CA', 'NV', 'AZ', 'HI'].includes(state)) {
    out.push('CALIFORNIA_JUCO')
  }
  if (['TX', 'OK', 'NM', 'LA', 'AR'].includes(state)) {
    out.push('TEXAS_JUCO')
    if (rng.chance(0.25)) out.push('DOMINICAN_REPUBLIC')
  }
  if (['FL', 'GA', 'SC', 'NC', 'AL', 'MS', 'TN'].includes(state)) {
    out.push('FLORIDA_JUCO')
    if (rng.chance(0.2)) out.push('PUERTO_RICO')
    if (rng.chance(0.15)) out.push('DOMINICAN_REPUBLIC')
  }
  if (['IL', 'IN', 'IA', 'MO', 'KS', 'MI', 'OH', 'WI', 'MN', 'NE', 'SD', 'ND'].includes(state)) {
    out.push('MIDWEST_JUCO')
  }

  // Small chance of an exotic pipeline regardless of geography
  if (rng.chance(0.04)) out.push('AUSTRALIA')
  if (rng.chance(0.02)) out.push('JAPAN')
  if (rng.chance(0.05)) out.push('D1_PORTAL')

  return [...new Set(out)]  // dedupe
}

/**
 * Generate a list of 3-5 states for the coach's `regions[]`, anchored on
 * the school's state plus geographically adjacent ones.
 */
function regionsForState(state, rng) {
  const NEIGHBORS = {
    WA: ['OR', 'ID', 'MT'], OR: ['WA', 'ID', 'CA', 'NV'], ID: ['WA', 'OR', 'MT', 'WY', 'NV', 'UT'],
    CA: ['OR', 'NV', 'AZ'], NV: ['CA', 'OR', 'ID', 'UT', 'AZ'], AZ: ['NV', 'CA', 'UT', 'NM'],
    MT: ['ID', 'WY', 'ND', 'SD'], WY: ['MT', 'ID', 'CO', 'UT', 'NE', 'SD'],
    UT: ['ID', 'WY', 'CO', 'NV', 'AZ', 'NM'], CO: ['WY', 'NE', 'KS', 'OK', 'NM', 'UT'],
    NM: ['CO', 'TX', 'OK', 'AZ', 'UT'], TX: ['NM', 'OK', 'AR', 'LA'],
    OK: ['TX', 'NM', 'CO', 'KS', 'MO', 'AR'], KS: ['CO', 'NE', 'MO', 'OK'],
    NE: ['SD', 'IA', 'MO', 'KS', 'CO', 'WY'], SD: ['ND', 'MN', 'IA', 'NE', 'WY', 'MT'],
    ND: ['MT', 'MN', 'SD'], MN: ['ND', 'SD', 'IA', 'WI'], IA: ['MN', 'WI', 'IL', 'MO', 'NE', 'SD'],
    MO: ['IA', 'IL', 'KY', 'TN', 'AR', 'OK', 'KS', 'NE'], AR: ['MO', 'TN', 'MS', 'LA', 'TX', 'OK'],
    LA: ['TX', 'AR', 'MS'], MS: ['LA', 'AR', 'TN', 'AL'],
    TN: ['KY', 'VA', 'NC', 'GA', 'AL', 'MS', 'AR', 'MO'], KY: ['IL', 'IN', 'OH', 'WV', 'VA', 'TN', 'MO'],
    AL: ['MS', 'TN', 'GA', 'FL'], GA: ['AL', 'TN', 'NC', 'SC', 'FL'],
    FL: ['GA', 'AL'], SC: ['GA', 'NC'], NC: ['SC', 'GA', 'TN', 'VA'],
    VA: ['NC', 'TN', 'KY', 'WV', 'MD', 'DC'], WV: ['VA', 'KY', 'OH', 'PA', 'MD'],
    OH: ['PA', 'WV', 'KY', 'IN', 'MI'], IN: ['IL', 'KY', 'OH', 'MI'],
    IL: ['IA', 'MO', 'KY', 'IN', 'WI'], WI: ['MN', 'IA', 'IL', 'MI'],
    MI: ['OH', 'IN', 'WI'], BC: ['WA'],
  }
  const adj = NEIGHBORS[state] || []
  const count = rng.int(2, 4)
  const picked = new Set([state])
  for (let i = 0; i < count && i < adj.length; i++) {
    picked.add(rng.pick(adj))
  }
  return [...picked]
}

// ─── Role multipliers (mirror action_points.md) ─────────────────────────────

const ROLE_MULTIPLIER = {
  HEAD_COACH: 1.5,
  PITCHING_COACH: 1.0,
  HITTING_COACH: 1.0,
  BENCH_COACH: 0.8,
  RECRUITING_COORDINATOR: 1.0,
  STRENGTH_CONDITIONING: 0.7,
  DIRECTOR_OF_OPERATIONS: 0.6,
  GRADUATE_ASSISTANT: 0.4,
  DATA_ANALYTICS_MANAGER: 0.9,
}

/**
 * Required roles every program has at game start. User can fire any of these
 * but the program functions best when filled.
 */
export const STARTING_ROLES = ['HEAD_COACH', 'PITCHING_COACH', 'HITTING_COACH', 'BENCH_COACH']

/** Optional roles the user can choose to hire. */
export const OPTIONAL_ROLES = [
  'RECRUITING_COORDINATOR',
  'STRENGTH_CONDITIONING',
  'DIRECTOR_OF_OPERATIONS',
  'DATA_ANALYTICS_MANAGER',
  'GRADUATE_ASSISTANT',
]

export const ROLE_DESCRIPTIONS = {
  HEAD_COACH:             'Sets the program direction. AP, recruiting, in-game tactics.',
  PITCHING_COACH:         'Develops pitchers + pre-game rotation calls.',
  HITTING_COACH:          'Develops hitters + offensive game plan.',
  BENCH_COACH:            'Defensive positioning, base-running, scouting reports.',
  RECRUITING_COORDINATOR: 'Boosts recruiting AP + closing rate on verbals.',
  STRENGTH_CONDITIONING:  'Reduces injury risk, improves durability.',
  DIRECTOR_OF_OPERATIONS: 'Travel + logistics. Improves budget efficiency.',
  DATA_ANALYTICS_MANAGER: 'Unlocks advanced stats (FIP, wOBA, wRC+, WAR) across the league.',
  GRADUATE_ASSISTANT:     'Free hire — small AP boost. Limited contract.',
}

// ─── Rating distribution by program strength ─────────────────────────────────

/**
 * Strong programs tend to have strong coaches. Returns mean rating for the
 * core 4 stats given a school's programHistory (0-100).
 */
function meanRatingForProgram(programHistory) {
  // Programs scoring 80+ → mean ~70; programs at 50 → mean ~55; programs at 20 → mean ~42
  return 40 + (programHistory * 0.35)
}

/**
 * Generate a single coach for a given role at a given school.
 * @param {School} school
 * @param {CoachRole} role
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @param {{ overrideRatings?: Partial<Pick<Coach,'developer'|'motivator'|'recruiter'|'tactician'>>, idPrefix?: string }} [opts]
 * @returns {Coach}
 */
export function generateCoach(school, role, rng, opts = {}) {
  const { first, last } = pickFullName(rng, school.region)
  const mean = meanRatingForProgram(school.programHistory)
  const stddev = 8

  // Each rating drawn from gaussian, with one specialization bias per role
  const SPECIALIZATION = {
    HEAD_COACH:             { developer: +3, motivator: +5, recruiter: +3, tactician: +5 },
    PITCHING_COACH:         { developer: +8, motivator: 0,  recruiter: 0,  tactician: +2 },
    HITTING_COACH:          { developer: +8, motivator: +2, recruiter: 0,  tactician: +2 },
    BENCH_COACH:            { developer: 0,  motivator: +2, recruiter: 0,  tactician: +10 },
    RECRUITING_COORDINATOR: { developer: 0,  motivator: 0,  recruiter: +12, tactician: 0  },
    STRENGTH_CONDITIONING:  { developer: +6, motivator: +4, recruiter: 0,  tactician: 0  },
    DIRECTOR_OF_OPERATIONS: { developer: 0,  motivator: +2, recruiter: +4, tactician: 0  },
    GRADUATE_ASSISTANT:     { developer: +2, motivator: +2, recruiter: +2, tactician: 0  },
    DATA_ANALYTICS_MANAGER: { developer: +6, motivator: 0,  recruiter: 0,  tactician: +6 },
  }
  const bias = SPECIALIZATION[role] || { developer: 0, motivator: 0, recruiter: 0, tactician: 0 }

  const ratings = {
    developer: Math.round(clamp(rng.gaussian(mean, stddev) + bias.developer, 30, 99)),
    motivator: Math.round(clamp(rng.gaussian(mean, stddev) + bias.motivator, 30, 99)),
    recruiter: Math.round(clamp(rng.gaussian(mean, stddev) + bias.recruiter, 30, 99)),
    tactician: Math.round(clamp(rng.gaussian(mean, stddev) + bias.tactician, 30, 99)),
    ...opts.overrideRatings,
  }

  const avg = (ratings.developer + ratings.motivator + ratings.recruiter + ratings.tactician) / 4

  // Salary scales with school resource tier + role + quality
  const salary = computeCoachSalary(school.resourceTier, role, avg)

  const id = (opts.idPrefix || 'coach') + '_' + rng.int(100000, 999999)

  /** @type {Coach} */
  const coach = {
    id,
    firstName: first,
    lastName: last,
    age: rng.int(30, 64),
    schoolId: school.id,
    role,
    yearsAtSchool: rng.int(0, 8),
    yearsInRole: rng.int(0, 6),
    ...ratings,
    recruiter_type: pickRecruiterType(school, rng),
    regions: regionsForState(school.state, rng),
    pipelines: pipelinesForState(school.state, school.region, rng),
    salary,
    contractYearsRemaining: rng.int(1, 3),
    ambition: rng.int(20, 90),
    loyalty: rng.int(20, 90),
  }
  return coach
}

function pickRecruiterType(school, rng) {
  // Bias by resourceTier (see coaches.md generation rules)
  const tier = school.resourceTier
  const weights = {
    SHOESTRING:  { HS_GRINDER: 5, JUCO_HUNTER: 3, PORTAL_PRO: 1, BALANCED: 3 },
    MID:         { HS_GRINDER: 3, JUCO_HUNTER: 3, PORTAL_PRO: 2, BALANCED: 4 },
    WELL_FUNDED: { HS_GRINDER: 2, JUCO_HUNTER: 3, PORTAL_PRO: 3, BALANCED: 4 },
    D1_LITE:     { HS_GRINDER: 1, JUCO_HUNTER: 2, PORTAL_PRO: 5, BALANCED: 3 },
  }
  const w = weights[tier] || weights.MID
  const items = Object.keys(w)
  const weights_arr = items.map(k => w[k])
  return rng.weighted(items, weights_arr)
}

/**
 * Salary table by school tier + role.
 *
 *   base    = salary at quality avg 50
 *   qualBonus = adds linearly up to quality 90 (and slightly past 90)
 *   floor   = absolute minimum
 *
 * Calibration targets (per Nate, May 2026):
 *   Bushnell (MID) head coach ≈ $50K  + assistant pool ≈ $40K
 *   D1_LITE   head coach ≈ $130K-$180K
 *   SHOESTRING head coach ≈ $30K
 */
const SALARY_TABLE = {
  D1_LITE: {
    HEAD_COACH:             { base: 130000, qualBonus: 70000, floor: 90000 },
    PITCHING_COACH:         { base: 32000,  qualBonus: 22000, floor: 22000 },
    HITTING_COACH:          { base: 32000,  qualBonus: 22000, floor: 22000 },
    BENCH_COACH:            { base: 22000,  qualBonus: 14000, floor: 15000 },
    RECRUITING_COORDINATOR: { base: 28000,  qualBonus: 18000, floor: 20000 },
    STRENGTH_CONDITIONING:  { base: 22000,  qualBonus: 12000, floor: 15000 },
    DIRECTOR_OF_OPERATIONS: { base: 16000,  qualBonus: 9000,  floor: 12000 },
    DATA_ANALYTICS_MANAGER: { base: 22000,  qualBonus: 13000, floor: 15000 },
    GRADUATE_ASSISTANT:     { base: 0,      qualBonus: 0,     floor: 0     },
  },
  WELL_FUNDED: {
    HEAD_COACH:             { base: 78000,  qualBonus: 42000, floor: 55000 },
    PITCHING_COACH:         { base: 18000,  qualBonus: 14000, floor: 12000 },
    HITTING_COACH:          { base: 18000,  qualBonus: 14000, floor: 12000 },
    BENCH_COACH:            { base: 12000,  qualBonus: 9000,  floor: 8000 },
    RECRUITING_COORDINATOR: { base: 15000,  qualBonus: 12000, floor: 10000 },
    STRENGTH_CONDITIONING:  { base: 12000,  qualBonus: 8000,  floor: 8000 },
    DIRECTOR_OF_OPERATIONS: { base: 9000,   qualBonus: 6000,  floor: 7000 },
    DATA_ANALYTICS_MANAGER: { base: 13000,  qualBonus: 9000,  floor: 9000 },
    GRADUATE_ASSISTANT:     { base: 0,      qualBonus: 0,     floor: 0     },
  },
  MID: {
    HEAD_COACH:             { base: 48000,  qualBonus: 22000, floor: 35000 },
    PITCHING_COACH:         { base: 17000,  qualBonus: 9000,  floor: 12000 },
    HITTING_COACH:          { base: 17000,  qualBonus: 9000,  floor: 12000 },
    BENCH_COACH:            { base: 10000,  qualBonus: 6000,  floor: 7000 },
    RECRUITING_COORDINATOR: { base: 13000,  qualBonus: 8000,  floor: 9000 },
    STRENGTH_CONDITIONING:  { base: 10000,  qualBonus: 6000,  floor: 8000 },
    DIRECTOR_OF_OPERATIONS: { base: 8000,   qualBonus: 5000,  floor: 6000 },
    DATA_ANALYTICS_MANAGER: { base: 9000,   qualBonus: 6000,  floor: 7000 },
    GRADUATE_ASSISTANT:     { base: 0,      qualBonus: 0,     floor: 0     },
  },
  SHOESTRING: {
    HEAD_COACH:             { base: 30000,  qualBonus: 14000, floor: 22000 },
    PITCHING_COACH:         { base: 7000,   qualBonus: 5000,  floor: 5000 },
    HITTING_COACH:          { base: 7000,   qualBonus: 5000,  floor: 5000 },
    BENCH_COACH:            { base: 4000,   qualBonus: 3000,  floor: 3000 },
    RECRUITING_COORDINATOR: { base: 5000,   qualBonus: 4000,  floor: 4000 },
    STRENGTH_CONDITIONING:  { base: 4000,   qualBonus: 3000,  floor: 3000 },
    DIRECTOR_OF_OPERATIONS: { base: 3000,   qualBonus: 2000,  floor: 2500 },
    DATA_ANALYTICS_MANAGER: { base: 5000,   qualBonus: 4000,  floor: 3500 },
    GRADUATE_ASSISTANT:     { base: 0,      qualBonus: 0,     floor: 0     },
  },
}

export function computeCoachSalary(resourceTier, role, qualityAvg) {
  const tierTable = SALARY_TABLE[resourceTier] || SALARY_TABLE.MID
  const cell = tierTable[role] || tierTable.BENCH_COACH
  // Quality 50 → +0, quality 90 → +qualBonus, scales linearly past
  const qualityFactor = (qualityAvg - 50) / 40
  const computed = cell.base + cell.qualBonus * qualityFactor
  return Math.round(Math.max(cell.floor, computed))
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

// ─── Staff generation for a whole school ─────────────────────────────────────

/**
 * Default assistant roster — every program starts with these 3. The user can
 * fire and hire to swap them; optional roles (Recruiting Coord, S&C, DOO,
 * Analytics Mgr, GA) require a hire.
 */
const DEFAULT_ASSISTANT_ROLES = ['PITCHING_COACH', 'HITTING_COACH', 'BENCH_COACH']

/**
 * Generate a full coaching staff (HC + 3 default assistants) for a school.
 * @param {School} school
 * @param {number} seed
 * @returns {{ headCoach: Coach, assistants: Coach[] }}
 */
export function generateStaff(school, seed) {
  const rng = makeRng('staff', school.id, seed)
  const headCoach = generateCoach(school, 'HEAD_COACH', rng, {
    idPrefix: 'hc_' + school.id,
  })

  const assistants = []
  DEFAULT_ASSISTANT_ROLES.forEach((role, i) => {
    assistants.push(generateCoach(school, role, rng, { idPrefix: `ast_${school.id}_${i}` }))
  })
  return { headCoach, assistants }
}

/**
 * Generate N hiring candidates for a given role, spanning a range of quality
 * (and therefore salary). Returns at least 4 candidates with deliberately
 * varied quality so the user sees real $$$ tradeoffs.
 *
 * @param {School} school
 * @param {string} role
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @returns {Coach[]}
 */
export function generateHiringCandidates(school, role, rng) {
  // Force a spread of quality levels so candidates aren't all clustered
  const qualityTargets = [40, 55, 68, 78]
  const candidates = []
  for (let i = 0; i < qualityTargets.length; i++) {
    const target = qualityTargets[i]
    const ratingOverride = {
      developer: Math.max(30, Math.min(99, Math.round(rng.gaussian(target, 4)))),
      motivator: Math.max(30, Math.min(99, Math.round(rng.gaussian(target, 4)))),
      recruiter: Math.max(30, Math.min(99, Math.round(rng.gaussian(target, 4)))),
      tactician: Math.max(30, Math.min(99, Math.round(rng.gaussian(target, 4)))),
    }
    candidates.push(generateCoach(school, role, rng, {
      overrideRatings: ratingOverride,
      idPrefix: `cand_${role}_${i}`,
    }))
  }
  return candidates
}
