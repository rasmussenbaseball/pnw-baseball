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
import { buildAllConferenceSchedules, buildNonConferenceFillers } from './schedule'
import { defaultBudgetForSchool } from './budget'
import { applyRealFinancials } from './schoolFinancials'
import { buildInitialCareer } from './storyMode'
import { teamOverall } from './playerRating'
import { expectedTeamOvr } from './programRating'

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

  // Apply researched real-world financials to every PNW NAIA school we
  // track. Non-PNW NAIA schools keep their synthetic defaults — they're
  // only used as opponents in stat sims, not user dynasties.
  for (const school of Object.values(schools)) {
    school.level = 'NAIA'   // tag for downstream helpers
    applyRealFinancials(school)
  }

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

    // Year-1 tutorial flow: the USER's program starts with ONLY the head
    // coach. They hire their three required assistants in Wk 2. Every OTHER
    // school in the league keeps its full auto-generated staff so league sims
    // run normally.
    const isUserSchool = school.id === input.userSchoolId
    const teamAssistants = isUserSchool ? [] : assistants
    // Drop the auto-generated assistants from the coaches map for the user
    // team so they don't appear elsewhere in the UI.
    if (isUserSchool) {
      for (const a of assistants) delete coaches[a.id]
    }
    teams[school.id] = {
      schoolId: school.id,
      rosterPlayerIds: rosterIds,
      headCoachId: headCoach.id,
      assistantCoachIds: teamAssistants.map(a => a.id),
      wins: 0,
      losses: 0,
      confWins: 0,
      confLosses: 0,
      runDiff: 0,
    }
    normalizeRosterScholarships(teams[school.id], school, players)
    // Pin starting Team OVR to the deterministic value shown on the program
    // tile so every new dynasty for a given school starts at the same number,
    // regardless of roster randomness. teamOverall() applies the offset.
    {
      const raw = teamOverall(teams[school.id], players).overall
      teams[school.id].ovrOffset = expectedTeamOvr({ ...school, level: 'NAIA' }) - raw
    }
  }

  // 4. Calendar — dynasty starts first week of August 2026 (offseason) fall
  // ball spring 2027 season. Offseason has 26 weeks; first season game lands
  // around mid/late February.
  /** @type {import('./types.js').Calendar} */
  const calendar = {
    // `year`is the AUGUST year — the year the offseason begins. Aug 2026 
    // year=2026; the spring season ending May 2027 is displayed as "2027"
    // via year+1 in legacy code (calendarDateLabel etc).
    year: 2026,
    startYear: 2026,        // remembered so date math doesn't drift
    week: 1,                // overall counter (never resets)
    weekOfYear: 1,          // 1-52 within the current year
    mode: 'OFFSEASON',
    seasonWeek: null,
    offseasonWeek: 1,       // legacy, kept in sync by advanceOneWeek
    forcedPauseReason: null,
  }

  // 4a. Generate the conference schedule only — weekend 4-game series.
  // Non-conference games are now USER-BUILT on the Schedule page (midweeks +
  // pre-conference weeks 1-3). The auto-filler used to add Mid-South / SAC
  // opponents during conference weeks which violated the conf-weekends-only
  // rule; that's gone.
  const confSchedule = buildAllConferenceSchedules(conferences, schools, 2027, seed)
  // Non-user teams get auto non-conference series in the early weeks so the
  // whole league plays + accrues stats from week 1 (the user self-schedules
  // their own non-conf, so they're excluded).
  const fillers = buildNonConferenceFillers(confSchedule, conferences, schools, 2027, input.userSchoolId)
  /** @type {import('./schedule.js').Game[]} */
  const schedule = [...confSchedule, ...fillers]

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
    // Year-1 dynasty marker — used by gameYear.requiredActionForWeek to know
    // we're in the tutorial year (mandatory full assistant hires, etc.).
    dynastyYear: 1,
    ap: {
      // Wk 1 starts with AP LOCKED (= 0). Unlocks in Wk 4 (scouting tutorial).
      // initialAP is preserved as a baseline for refreshWeeklyAP after Wk 3.
      currentWeek: 0,
      baseline: initialAP,
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
  // Story mode rarely lands here (it normally starts at NWAC via the
  // multi-level path), but if the wizard ever routes a story start through
  // the NAIA path we still want a career block on the save.
  if (input.gameOptions?.storyMode === 'STORY') {
    state.career = buildInitialCareer({
      difficulty: input.gameOptions?.difficulty || 'NORMAL',
      schoolName: userSchool.name,
      level: 'NAIA',
      role: 'HEAD_COACH',
      year: 2026,
    })
    state.career.trajectory[0].schoolId = input.userSchoolId
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
    archetype: uc.archetype || 'GENERALIST',
    yearsAtSchool: 0,
    yearsInRole: 0,
    developer: uc.developer,
    motivator: uc.motivator,
    recruiter: uc.recruiter,
    tactician: uc.tactician,
    recruiter_type: uc.recruiter_type,
    regions: uc.regions,
    primaryRegion: uc.primaryRegion,
    secondaryRegion: uc.secondaryRegion,
    lookId: uc.lookId ?? 0,
    pipelines: uc.pipelines,
    salary: computeCoachSalary(school.resourceTier, 'HEAD_COACH', qualityAvg),
    contractYearsRemaining: 4,
    ambition: 50,
    loyalty: 99,
  }
}

/**
 * Initial AP/week. Coaches START at 25 AP per week, scale up with experience
 * (years at school) toward a cap of 50 AP. Tier still nudges the floor.
 */
function computeInitialAP(school, headCoach, assistants) {
  const ROLE_MULTIPLIER = {
    HEAD_COACH: 0.8,
    PITCHING_COACH: 0.4,
    HITTING_COACH: 0.4,
    BENCH_COACH: 0.3,
    RECRUITING_COORDINATOR: 0.6,
    STRENGTH_CONDITIONING: 0.3,
    DIRECTOR_OF_OPERATIONS: 0.3,
    DATA_ANALYTICS_MANAGER: 0.4,
    GRADUATE_ASSISTANT: 0.2,
  }
  const TIER_BONUS = { D1_LITE: 3, WELL_FUNDED: 1, MID: 0, SHOESTRING: -1 }

  const contribution = (c) => {
    const avg = (c.developer + c.motivator + c.recruiter + c.tactician) / 4
    return (avg - 50) * 0.12 * (ROLE_MULTIPLIER[c.role] ?? 0.3)
  }

  let total = 22  // base — lands a typical Bushnell coach around 25 AP
  total += contribution(headCoach)
  for (const a of assistants) total += contribution(a)
  total += TIER_BONUS[school.resourceTier] || 0
  return Math.max(20, Math.min(50, Math.round(total)))
}
