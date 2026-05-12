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
  }
  const bias = SPECIALIZATION[role]

  const ratings = {
    developer: Math.round(clamp(rng.gaussian(mean, stddev) + bias.developer, 30, 99)),
    motivator: Math.round(clamp(rng.gaussian(mean, stddev) + bias.motivator, 30, 99)),
    recruiter: Math.round(clamp(rng.gaussian(mean, stddev) + bias.recruiter, 30, 99)),
    tactician: Math.round(clamp(rng.gaussian(mean, stddev) + bias.tactician, 30, 99)),
    ...opts.overrideRatings,
  }

  const avg = (ratings.developer + ratings.motivator + ratings.recruiter + ratings.tactician) / 4

  // Salary scales with quality and role
  const baseSalary = salaryForQuality(avg)
  const salary = Math.round(baseSalary * (role === 'HEAD_COACH' ? 2.5 : ROLE_MULTIPLIER[role]))

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

function salaryForQuality(avg) {
  if (avg >= 80) return 100000
  if (avg >= 70) return 60000
  if (avg >= 60) return 35000
  if (avg >= 50) return 22000
  return 16000
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

// ─── Staff generation for a whole school ─────────────────────────────────────

/**
 * Decide how many assistants this program has, by tier.
 */
function staffSizeForTier(tier) {
  if (tier === 'D1_LITE') return 6      // HC + 5 assistants
  if (tier === 'WELL_FUNDED') return 4  // HC + 3 assistants
  if (tier === 'MID') return 3          // HC + 2 assistants
  return 2                              // HC + 1 assistant
}

const STAFF_ROLE_ORDER = [
  'PITCHING_COACH',
  'HITTING_COACH',
  'RECRUITING_COORDINATOR',
  'BENCH_COACH',
  'STRENGTH_CONDITIONING',
  'DIRECTOR_OF_OPERATIONS',
]

/**
 * Generate a full coaching staff (HC + assistants) for a school.
 * @param {School} school
 * @param {number} seed
 * @returns {{ headCoach: Coach, assistants: Coach[] }}
 */
export function generateStaff(school, seed) {
  const rng = makeRng('staff', school.id, seed)
  const headCoach = generateCoach(school, 'HEAD_COACH', rng, {
    idPrefix: 'hc_' + school.id,
  })

  const staffSize = staffSizeForTier(school.resourceTier)
  const numAssistants = staffSize - 1
  const assistants = []
  for (let i = 0; i < numAssistants; i++) {
    const role = STAFF_ROLE_ORDER[i]
    assistants.push(generateCoach(school, role, rng, { idPrefix: `ast_${school.id}_${i}` }))
  }
  return { headCoach, assistants }
}
