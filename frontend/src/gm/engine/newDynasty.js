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
import { generateStaff, computeCoachSalary } from './coaches'
import { makeRng, hashSeed } from './rng'
import { buildAllConferenceSchedules } from './schedule'
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

  // Normalize generated player scholarships so the team's total equals ~92% of
  // the school's pool — i.e. the program starts the cycle nearly fully
  // committed, with only a thin margin of free $ (small unsigned reserves /
  // late attrition). New scholarship $ each year comes from departing seniors.
  function normalizeRosterScholarships(team, school, playersMap) {
    const target = Math.round(school.scholarshipPool * 0.92)
    const ids = team.rosterPlayerIds
    const current = ids.reduce((s, id) => s + (playersMap[id]?.scholarship?.annualAmount || 0), 0)
    if (current <= 0) return
    const factor = target / current
    for (const id of ids) {
      const p = playersMap[id]
      if (!p) continue
      p.scholarship.annualAmount = Math.max(0, Math.round(p.scholarship.annualAmount * factor))
    }
  }

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
    normalizeRosterScholarships(teams[school.id], school, players)
  }

  // 4. Calendar — dynasty starts first week of August 2026 (offseason) → fall
  // ball → spring 2027 season. Offseason has 26 weeks; first season game lands
  // around mid/late February.
  /** @type {import('./types.js').Calendar} */
  const calendar = {
    year: 2026,
    startYear: 2026,        // remembered so date math doesn't drift
    week: 1,
    mode: 'OFFSEASON',
    seasonWeek: null,
    offseasonWeek: 1,
    forcedPauseReason: null,
  }

  // 4a. Generate the conference schedule only — weekend 4-game series.
  // Non-conference games are now USER-BUILT on the Schedule page (midweeks +
  // pre-conference weeks 1-3). The auto-filler used to add Mid-South / SAC
  // opponents during conference weeks which violated the conf-weekends-only
  // rule; that's gone.
  const confSchedule = buildAllConferenceSchedules(conferences, schools, 2027, seed)
  /** @type {import('./schedule.js').Game[]} */
  const schedule = [...confSchedule]

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
    budget: defaultBudgetForSchool(
      userSchool,
      coaches[userTeam.headCoachId].salary +
      userTeam.assistantCoachIds.reduce((s, id) => s + (coaches[id]?.salary || 0), 0),
    ),
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
  const qualityAvg = (uc.developer + uc.motivator + uc.recruiter + uc.tactician) / 4
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
    salary: computeCoachSalary(school.resourceTier, 'HEAD_COACH', qualityAvg),
    contractYearsRemaining: 4,
    ambition: 50,
    loyalty: 99,
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

