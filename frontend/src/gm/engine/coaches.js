/**
 * Coach generator + staff helpers.
 * See ../docs/coaches.md.
 */

import { pickFullName } from './names'
import { makeRng } from './rng'
import { STATE_TO_REGION, REGIONS } from './regions'
import { applyArchetypeBias } from './archetypes'

/** @typedef {import('./types.js').Coach} Coach */
/** @typedef {import('./types.js').School} School */
/** @typedef {import('./types.js').CoachRole} CoachRole */
/** @typedef {import('./types.js').PipelineFlag} PipelineFlag */

/**
 * Pick up to 2 region codes for an AI coach. Heavily favors the school's
 * own region plus one adjacent region.
 */
function regionsForState(state, rng) {
  const home = STATE_TO_REGION[state] || 'MW'
  const ADJ = {
    NW: ['SW', 'MW'],
    SW: ['NW', 'South', 'MW'],
    South: ['SW', 'SE', 'MW'],
    MW: ['South', 'SE', 'NE', 'SW'],
    SE: ['South', 'NE', 'MW'],
    NE: ['SE', 'MW'],
  }
  const second = rng.pick(ADJ[home] || REGIONS.filter(r => r !== home))
  return [home, second]
}

/** Legacy regionsForState retained for backward compatibility (states). */
function legacyRegionsForState(state, rng) {
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

// Re-export archetype helpers so callers can use `import ... from 'coaches'`.
// Keeps the existing import shape stable while the new module is the source.
export { ARCHETYPES, ARCHETYPE_KEYS, inferArchetype, applyArchetypeBias, staffRatings } from './archetypes'

/**
 * Roles that MUST be filled in year 1 (the dynasty tutorial year) before
 * Wk 2 can be advanced past. Year 2+ exposes a "Confirm I'm keeping my
 * staff" button so the user can skip re-hiring if they're happy with what
 * they have.
 */
export const FIRST_YEAR_REQUIRED_ROLES = ['PITCHING_COACH', 'HITTING_COACH', 'BENCH_COACH']

/** Optional roles the user can choose to hire. */
export const OPTIONAL_ROLES = [
  'RECRUITING_COORDINATOR',
  'STRENGTH_CONDITIONING',
  'DIRECTOR_OF_OPERATIONS',
  'DATA_ANALYTICS_MANAGER',
  'GRADUATE_ASSISTANT',
]

/**
 * Optional roles that only become available to interview / hire starting
 * Wk 4 (after the tutorial gates clear). Wks 1-3 only show + allow the
 * three required assistant roles to keep the onboarding tight.
 */
export const ROLES_UNLOCKED_AT_WEEK_4 = OPTIONAL_ROLES

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

  // Archetype — pick before final ratings so the bias can shape them.
  // Weighted so generalists are common (40%) and the four specialists
  // each ~15%.
  const archetype = pickArchetype(rng)
  const biased = applyArchetypeBias(ratings, archetype)
  const avgBiased = (biased.developer + biased.motivator + biased.recruiter + biased.tactician) / 4
  const salaryBiased = computeCoachSalary(school.resourceTier, role, avgBiased)

  /** @type {Coach} */
  const coach = {
    id,
    firstName: first,
    lastName: last,
    age: rng.int(30, 64),
    schoolId: school.id,
    role,
    archetype,
    yearsAtSchool: rng.int(0, 8),
    yearsInRole: rng.int(0, 6),
    ...biased,
    recruiter_type: pickRecruiterType(school, rng),
    regions: regionsForState(school.state, rng),
    salary: salaryBiased,
    contractYearsRemaining: rng.int(1, 3),
    ambition: rng.int(20, 90),
    loyalty: rng.int(20, 90),
  }
  return coach
}

function pickArchetype(rng) {
  return rng.weighted(
    ['TEACHER', 'SHOWMAN', 'STRATEGIST', 'PLAYER_COACH', 'GENERALIST'],
    [15, 15, 15, 15, 40],
  )
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
    // Asst pool budget guidance: ~$40K total typical. Bases lowered + qual
    // bonuses widened so quality 30 cheaps out around $4-8K while quality
    // 85 pushes $20-25K. Combined with the ±40% salary noise in
    // generateHiringCandidates this produces a real $$$ spread.
    HITTING_COACH:          { base: 11000,  qualBonus: 14000, floor: 4500 },
    PITCHING_COACH:         { base: 11000,  qualBonus: 14000, floor: 4500 },
    BENCH_COACH:            { base: 5000,   qualBonus: 9000,  floor: 2500 },
    RECRUITING_COORDINATOR: { base: 12000,  qualBonus: 11000, floor: 6000 },
    STRENGTH_CONDITIONING:  { base: 9000,   qualBonus: 9000,  floor: 5000 },
    DIRECTOR_OF_OPERATIONS: { base: 7000,   qualBonus: 7000,  floor: 4000 },
    DATA_ANALYTICS_MANAGER: { base: 9000,   qualBonus: 8000,  floor: 5000 },
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

// ─── Optional support-role hires (no $$$, no ratings, just boosts) ──────────
//
// Optional roles are "support staff" hires. They don't carry archetype or
// the 4 dev/mot/rec/tac ratings — the role IS the value. User pays 20 AP
// for a 1-year contract; the boost is applied while the role is filled.
//
// Effects are surfaced via `optionalHireBoosts(team, state)` which reads the
// set of filled optional roles and returns the active boost object. Sim
// code reads from there.

/** @typedef {{
 *   label: string,
 *   blurb: string,
 *   effectLabel: string,
 *   icon: string,
 *   contractYears: number
 * }} OptionalHireMeta */

/** @type {Object<string, OptionalHireMeta>} */
export const OPTIONAL_HIRE_META = {
  RECRUITING_COORDINATOR: {
    label: 'Recruiting Coordinator',
    blurb: 'Adds +5 AP to your weekly recruiting AP pool, year-round.',
    effectLabel: '+5 recruiting AP/wk',
    icon: '🎯',
    contractYears: 1,
  },
  STRENGTH_CONDITIONING: {
    label: 'Strength & Conditioning Coach',
    blurb: 'Reduces injury risk by 20% and bumps player durability by +4.',
    effectLabel: '−20% injuries · +4 durability',
    icon: '💪',
    contractYears: 1,
  },
  DIRECTOR_OF_OPERATIONS: {
    label: 'Director of Operations',
    blurb: 'Logistics + travel efficiency adds +$50K to your annual athletic budget.',
    effectLabel: '+$50K to budget',
    icon: '📋',
    contractYears: 1,
  },
  DATA_ANALYTICS_MANAGER: {
    label: 'Data & Analytics Manager',
    blurb: 'Unlocks advanced stats league-wide (FIP, wOBA, wRC+, WAR).',
    effectLabel: 'Unlocks advanced stats',
    icon: '📊',
    contractYears: 1,
  },
  GRADUATE_ASSISTANT: {
    label: 'Graduate Assistant',
    blurb: 'Extra hands on deck. +3 AP to your weekly pool.',
    effectLabel: '+3 AP/wk',
    icon: '🎒',
    contractYears: 1,
  },
}

/**
 * Generate a stat-less optional support-staff coach. Salary = $0. No
 * archetype, no developer/motivator/recruiter/tactician — the role IS the
 * effect. Caller pays 20 AP for the 1-year contract.
 *
 * @param {School} school
 * @param {string} role     One of OPTIONAL_ROLES
 * @returns {Coach}
 */
export function generateOptionalHire(school, role) {
  const meta = OPTIONAL_HIRE_META[role] || OPTIONAL_HIRE_META.GRADUATE_ASSISTANT
  const id = `opt_${role}_${school.id}_${Math.floor(Math.random() * 1e9)}`
  return {
    id,
    firstName: meta.label.split(' ')[0],
    lastName: 'Staff',   // visually identifies as support staff, not a true coach
    age: 30,
    schoolId: school.id,
    role,
    archetype: null,
    isSupportStaff: true,
    yearsAtSchool: 0,
    yearsInRole: 0,
    developer: 0,
    motivator: 0,
    recruiter: 0,
    tactician: 0,
    recruiter_type: 'BALANCED',
    regions: [],
    salary: 0,
    contractYearsRemaining: meta.contractYears,
    ambition: 50,
    loyalty: 50,
  }
}

/**
 * Aggregate "active boost" object from the filled support-staff roles on a
 * team. Returns numeric deltas/multipliers that sim code can apply.
 *
 * @param {string[]} coachIds  team.assistantCoachIds
 * @param {Object<string,Coach>} coaches  save.coaches
 * @returns {{
 *   apBonus: number,             // AP added to weekly pool (Recruiting + GA)
 *   injuryMult: number,          // multiplier on injury risk (1.0 = baseline)
 *   durabilityBump: number,      // flat add to player durability
 *   budgetBonus: number,         // $ added to total athletic budget (DOO)
 *   advancedStats: boolean,      // analytics unlock
 *   filledRoles: Set<string>,    // for UI display
 * }}
 */
export function optionalHireBoosts(coachIds, coaches) {
  const filled = new Set()
  for (const id of coachIds || []) {
    const c = coaches?.[id]
    if (c?.isSupportStaff) filled.add(c.role)
  }
  return {
    apBonus: (filled.has('RECRUITING_COORDINATOR') ? 5 : 0) + (filled.has('GRADUATE_ASSISTANT') ? 3 : 0),
    injuryMult: filled.has('STRENGTH_CONDITIONING') ? 0.80 : 1.0,
    durabilityBump: filled.has('STRENGTH_CONDITIONING') ? 4 : 0,
    budgetBonus: filled.has('DIRECTOR_OF_OPERATIONS') ? 50_000 : 0,
    advancedStats: filled.has('DATA_ANALYTICS_MANAGER'),
    filledRoles: filled,
  }
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
  // WIDE spread of quality levels — sometimes the cheap option is the
  // diamond in the rough; sometimes the expensive guy is overpaid. Also
  // applies stochastic salary noise so even same-quality coaches negotiate
  // differently (ego, agent, market). Range targets 30-90 in ratings,
  // ~0.5x to ~1.8x base salary.
  const qualityTargets = [32, 50, 65, 80]
  const candidates = []
  for (let i = 0; i < qualityTargets.length; i++) {
    const target = qualityTargets[i]
    const stddev = 9     // wide per-rating noise so individual ratings vary
    const ratingOverride = {
      developer: clamp(Math.round(rng.gaussian(target, stddev)), 25, 95),
      motivator: clamp(Math.round(rng.gaussian(target, stddev)), 25, 95),
      recruiter: clamp(Math.round(rng.gaussian(target, stddev)), 25, 95),
      tactician: clamp(Math.round(rng.gaussian(target, stddev)), 25, 95),
    }
    const c = generateCoach(school, role, rng, {
      overrideRatings: ratingOverride,
      idPrefix: `cand_${role}_${i}`,
    })
    // Salary noise: ±40% so quality alone doesn't dictate price. A bad
    // coach with a hot agent might demand $20K; a great one might come
    // cheap because they want the gig. Adds the "have to overpay a
    // mediocre option" feeling.
    const noiseMult = clamp(rng.gaussian(1.0, 0.22), 0.45, 1.85)
    c.salary = Math.max(0, Math.round(c.salary * noiseMult))
    candidates.push(c)
  }
  return candidates
}
