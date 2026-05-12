/**
 * New Dynasty bootstrap.
 *
 * Generates the entire simulated world from a single user choice (school + coach).
 * Returns a SaveState that's ready to drop into localStorage.
 *
 * Performance: generating 199 schools × 35 players + ~700 coaches ≈ 7000 players +
 * 1000 coaches. Should run in well under a second on a modern laptop.
 */

import { loadSchools } from './loadSchools'
import { generateRoster } from './generate'
import { generateStaff } from './coaches'
import { makeRng, hashSeed } from './rng'
import { buildAllConferenceSchedules, autoFillNonConference } from './schedule'
import { seedFromPear } from './rankings'
import { defaultBudgetForSchool } from './budget'

/** @typedef {import('./types.js').SaveState} SaveState */

/**
 * @typedef NewDynastyInput
 * @property {string} userSupabaseId
 * @property {number} saveSlot              // 1-3
 * @property {string} dynastyName
 * @property {string} userSchoolId          // which NAIA school the user is taking over
 * @property {{
 *   firstName: string,
 *   lastName: string,
 *   regions: string[],
 *   pipelines: string[],
 *   recruiter_type: string,
 *   developer: number,
 *   motivator: number,
 *   recruiter: number,
 *   tactician: number,
 * }} userCoach                            // user-defined head coach attributes
 * @property {number} [seed]                // optional, derives from userSupabaseId+slot if absent
 * @property {import('./types.js').GameOptions} [gameOptions]   // game-mode customization
 */

/**
 * Bootstrap a brand-new dynasty.
 * @param {NewDynastyInput} input
 * @returns {SaveState}
 */
export function newDynasty(input) {
  const seed = input.seed ?? hashSeed(input.userSupabaseId, input.saveSlot, Date.now())
  const rng = makeRng('newDynasty', seed)

  // 1. Load schools + conferences (already hydrated with PEAR / tier data)
  const { schools, conferences } = loadSchools()

  // 2. Generate the user's coach
  const userSchool = schools[input.userSchoolId]
  if (!userSchool) throw new Error(`Unknown schoolId: ${input.userSchoolId}`)
  const userHC = buildUserHeadCoach(input.userCoach, userSchool)

  // 3. Generate staffs for all 199 programs (AI coaches for everyone else)
  /** @type {Object<string, import('./types.js').Coach>} */
  const coaches = {}
  /** @type {Object<string, import('./types.js').Team>} */
  const teams = {}
  /** @type {Object<string, import('./types.js').Player>} */
  const players = {}

  for (const school of Object.values(schools)) {
    let headCoach
    let assistants
    if (school.id === input.userSchoolId) {
      headCoach = userHC
      // Generate AI assistants the user can inherit / fire / hire over
      const generated = generateStaff(school, seed)
      assistants = generated.assistants
    } else {
      const generated = generateStaff(school, seed)
      headCoach = generated.headCoach
      assistants = generated.assistants
    }
    coaches[headCoach.id] = headCoach
    for (const a of assistants) coaches[a.id] = a

    // Generate roster
    const roster = generateRoster(school, seed, 2026)
    const rosterIds = []
    for (const p of roster) {
      players[p.id] = p
      rosterIds.push(p.id)
    }

    teams[school.id] = {
      schoolId: school.id,
      rosterPlayerIds: rosterIds,
      headCoachId: headCoach.id,
      assistantCoachIds: assistants.map(a => a.id),
      wins: 0,
      losses: 0,
      confWins: 0,
      confLosses: 0,
      runDiff: 0,
    }
  }

  // 4. Calendar — dynasty starts summer 2026 offseason → fall ball → spring 2027 season
  /** @type {import('./types.js').Calendar} */
  const calendar = {
    year: 2026,
    week: 1,
    mode: 'OFFSEASON',
    seasonWeek: null,
    offseasonWeek: 1,
    forcedPauseReason: null,
  }

  // 4a. Generate the 2027 conference schedule (predetermined). Non-conference
  // games auto-filled with regional opponents; user can edit on the schedule page.
  const ratings2026 = seedFromPear(schools, conferences)
  const confSchedule = buildAllConferenceSchedules(conferences, schools, 2027, seed)
  // Auto-fill non-conf only for user school in v1 (other teams compute as-needed)
  const userNonConf = autoFillNonConference(
    input.userSchoolId, schools, conferences, confSchedule, ratings2026, 2027, seed,
  )
  /** @type {import('./schedule.js').Game[]} */
  const schedule = [...confSchedule, ...userNonConf]

  // 5. AP + budget initial state for the user's team
  const userTeam = teams[input.userSchoolId]
  const initialAP = computeInitialAP(userSchool, coaches[userTeam.headCoachId],
                                     userTeam.assistantCoachIds.map(id => coaches[id]))

  /** @type {SaveState} */
  const state = {
    saveVersion: 1,
    saveId: `save_${input.userSupabaseId}_${input.saveSlot}_${seed}`,
    dynastyName: input.dynastyName,
    userSupabaseId: input.userSupabaseId,
    userSchoolId: input.userSchoolId,
    saveSlot: input.saveSlot,
    createdAt: new Date().toISOString(),
    lastSavedAt: new Date().toISOString(),
    gameOptions: input.gameOptions ?? {
      mode: 'TRADITIONAL',
      difficulty: 'NORMAL',
      injuriesEnabled: true,
      coachFiringEnabled: false,
      transferPortalEnabled: true,
      budgetConstraintsEnabled: true,
    },
    calendar,
    schools,
    conferences,
    players,
    coaches,
    teams,
    recruits: {},      // populated when recruiting cycle opens
    schedule,
    ap: {
      currentWeek: initialAP,
      spentThisWeek: 0,
      spentByCategory: {
        recruiting: 0,
        development: 0,
        team_boost: 0,
        program: 0,
        staff: 0,
      },
    },
    budget: defaultBudgetForSchool(userSchool),
    rngSeed: seed,
    newsfeed: [{
      id: 'dyn_start',
      year: 2026,
      week: 1,
      type: 'AWARD',
      headline: `${input.userCoach.firstName} ${input.userCoach.lastName} named head coach at ${userSchool.name}.`,
      payload: {},
    }],
  }
  return state
}

/**
 * Build the user's head coach record from input + school context.
 */
function buildUserHeadCoach(uc, school) {
  return {
    id: `hc_user_${school.id}`,
    firstName: uc.firstName,
    lastName: uc.lastName,
    age: 35,
    schoolId: school.id,
    role: 'HEAD_COACH',
    yearsAtSchool: 0,
    yearsInRole: 0,
    developer: uc.developer,
    motivator: uc.motivator,
    recruiter: uc.recruiter,
    tactician: uc.tactician,
    recruiter_type: uc.recruiter_type,
    regions: uc.regions,
    pipelines: uc.pipelines,
    salary: 80000,
    contractYearsRemaining: 4,
    ambition: 50,
    loyalty: 99,    // the user doesn't get poached unwillingly in v1
  }
}

/**
 * Initial AP/week from action_points.md spec.
 */
function computeInitialAP(school, headCoach, assistants) {
  const ROLE_MULTIPLIER = {
    HEAD_COACH: 1.5,
    PITCHING_COACH: 1.0,
    HITTING_COACH: 1.0,
    BENCH_COACH: 0.8,
    RECRUITING_COORDINATOR: 1.0,
    STRENGTH_CONDITIONING: 0.7,
    DIRECTOR_OF_OPERATIONS: 0.6,
  }
  const TIER_BONUS = { D1_LITE: 4, WELL_FUNDED: 2, MID: 0, SHOESTRING: -2 }

  const contribution = (c) => {
    const avg = (c.developer + c.motivator + c.recruiter + c.tactician) / 4
    return (avg - 50) * 0.4 * ROLE_MULTIPLIER[c.role]
  }

  let total = 20  // base
  total += contribution(headCoach)
  for (const a of assistants) total += contribution(a)
  total += TIER_BONUS[school.resourceTier] || 0
  return Math.max(10, Math.min(80, Math.round(total)))
}

