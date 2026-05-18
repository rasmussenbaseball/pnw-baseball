/**
 * Multi-level dynasty bootstrap (D1/D2/D3/NWAC).
 *
 * The original newDynasty.js is NAIA-only — it loads the full 200-school
 * NAIA universe + CCC schedule. This module is the equivalent for the
 * non-NAIA paths: when the user picks a PNW D1/D2/D3/NWAC program we build
 * a save state shaped like the NAIA one but populated from the
 * pnw_playoff_formats.json conference definitions.
 *
 * The state shape is intentionally identical to the NAIA path so the rest
 * of the engine (sim, ratings, dashboard, etc.) works without per-level
 * branching. Conferences/schools maps just contain a smaller universe
 * (the user's conference + non-NAIA opponents elsewhere are reachable
 * via non_naia_teams.json as before).
 *
 * MVP scope this session:
 *   - State creation works (no crashes)
 *   - User team gets a real roster respecting level eligibility
 *   - Conference round-robin schedule generated (fewer games for D3/NWAC)
 *   - Coach staff hires deferred (same Wk 2 tutorial flow)
 *   - Recruiting + postseason: stubs / "Coming Soon" gates added elsewhere
 */

import { generateRoster } from './generate'
import { generateStaff, computeCoachSalary } from './coaches'
import { makeRng, hashSeed } from './rng'
import { defaultBudgetForSchool } from './budget'
import {
  CONF_CONFIG, LEVEL_CONFIG, findNonNaia,
  classYearsForLevel, rosterCapForLevel, seasonGamesForLevel,
} from './levelHelpers'
import { applyRealFinancials } from './schoolFinancials'
import { buildInitialCareer } from './storyMode'
import nonNaiaRaw from '../data/non_naia_teams.json'

/**
 * Build a fresh save state for a non-NAIA dynasty.
 *
 * @param {object} input  same shape as newDynasty.NewDynastyInput plus level/conferenceId
 * @returns {import('./types.js').SaveState}
 */
export function newDynastyMultiLevel(input) {
  const { level, conferenceId } = input
  const seed = input.seed ?? hashSeed(input.userSupabaseId, input.saveSlot, Date.now())
  const rng = makeRng('newDynastyML', seed)
  const conf = CONF_CONFIG[conferenceId]
  if (!conf) throw new Error(`Unknown PNW conference: ${conferenceId}`)
  const levelCfg = LEVEL_CONFIG[level] || {}

  // 1. Build the schools map — the user's conference's full member list.
  //    Each member is a "lite" school object with enough fields for the
  //    engine to render + sim. Strength comes from non_naia_teams.json
  //    when available; otherwise default to 0 (PEAR-median).
  /** @type {Object<string, any>} */
  const schools = {}
  for (const m of (conf.pnwMembers || [])) {
    const fromPool = findNonNaia(m.id)
    const synthetic = buildSyntheticSchool({
      id: m.id,
      name: m.name,
      city: m.city,
      state: m.state,
      nickname: m.nickname || (fromPool?.nickname ?? ''),
      conferenceId,
      strength: fromPool?.strength ?? 0,
      level,
      colors: fromPool?.colors || null,
    })
    // Layer in researched real-world financials for PNW programs we have
    // data for (every D1/D2/D3/NAIA member of these confs is in the file).
    applyRealFinancials(synthetic)
    schools[m.id] = synthetic
  }

  // 2. Build the conferences map — single conference for now (user's).
  /** @type {Object<string, any>} */
  const conferences = {
    [conferenceId]: {
      id: conferenceId,
      name: conf.name,
      abbreviation: conferenceAbbreviation(conferenceId),
      level,
      schoolIds: Object.keys(schools),
      tournament: conf.tournament,
    },
  }

  // 3. Generate the user's coach. In STORY mode the user is an ASSISTANT
  //    at the program (role passed via input.storyRole), not the HC.
  //    A separate auto-generated coach takes the HC slot.
  const userSchool = schools[input.userSchoolId]
  if (!userSchool) throw new Error(`User school ${input.userSchoolId} not in conference ${conferenceId}`)
  const isStoryMode = input.gameOptions?.storyMode === 'STORY'
  const userStoryRole = input.storyRole || 'BENCH_COACH'
  const userHC = buildUserHeadCoach(input.userCoach, userSchool, isStoryMode ? userStoryRole : 'HEAD_COACH')

  // 4. Generate full staffs + rosters for every team in the conference
  /** @type {Object<string, any>} */
  const coaches = {}
  /** @type {Object<string, any>} */
  const teams = {}
  /** @type {Object<string, any>} */
  const players = {}

  // In Story Mode Custom, the user can pick HEAD_COACH directly. We need
  // to treat that case as the REGULAR-mode flow (user IS the HC) rather
  // than the assistant-injection path.
  const isStoryAsAssistant = isStoryMode && userStoryRole !== 'HEAD_COACH'

  for (const school of Object.values(schools)) {
    let headCoach
    let assistants
    if (school.id === input.userSchoolId) {
      if (isStoryAsAssistant) {
        // Story mode + non-HC role: NPC HC + user injected as assistant.
        const generated = generateStaff(school, seed)
        headCoach = generated.headCoach
        const baseAssistants = generated.assistants.filter(a => a.role !== userStoryRole)
        assistants = [userHC, ...baseAssistants].slice(0, generated.assistants.length || 3)
      } else {
        // Regular mode OR story mode w/ HEAD_COACH start: user IS the HC.
        headCoach = userHC
        const generated = generateStaff(school, seed)
        assistants = generated.assistants
      }
    } else {
      const generated = generateStaff(school, seed)
      headCoach = generated.headCoach
      assistants = generated.assistants
    }
    coaches[headCoach.id] = headCoach
    for (const a of assistants) coaches[a.id] = a

    // Roster — respect level eligibility (NWAC = FR/SO only)
    const allowedClassYears = classYearsForLevel(level)
    const roster = generateRoster(school, seed, 2026, { allowedClassYears, level })
    const rosterIds = []
    const cap = rosterCapForLevel(level)
    for (let i = 0; i < Math.min(roster.length, cap); i++) {
      const p = roster[i]
      players[p.id] = p
      rosterIds.push(p.id)
    }

    const isUserSchool = school.id === input.userSchoolId
    // Story-as-assistant: KEEP the auto-generated staff (user is part of it).
    // Story-as-HC (Custom HEAD_COACH) or REGULAR: strip the auto-generated
    // assistants for the user's program so the Wk-2 hiring tutorial has
    // slots to fill.
    let teamAssistants
    if (isUserSchool) {
      teamAssistants = isStoryAsAssistant ? assistants : []
      if (!isStoryAsAssistant) {
        for (const a of assistants) delete coaches[a.id]
      }
    } else {
      teamAssistants = assistants
    }
    teams[school.id] = {
      schoolId: school.id,
      rosterPlayerIds: rosterIds,
      headCoachId: headCoach.id,
      assistantCoachIds: teamAssistants.map(a => a.id),
      wins: 0, losses: 0, confWins: 0, confLosses: 0, runDiff: 0,
    }
  }

  // 5. Schedule — conference round-robin scaled to level's seasonGames
  const schedule = buildLevelSchedule(conferenceId, schools, level, 2027, seed)

  // 6. Calendar — same dynasty-start cadence as NAIA
  const calendar = {
    year: 2026, startYear: 2026,
    week: 1, weekOfYear: 1,
    mode: 'OFFSEASON',
    seasonWeek: null,
    offseasonWeek: 1,
    forcedPauseReason: null,
  }

  // 7. AP + budget
  const userTeam = teams[input.userSchoolId]
  const initialAP = 22   // base; will refresh weekly once coaches are hired

  /** @type {import('./types.js').SaveState} */
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
      mode: 'TRADITIONAL', difficulty: 'NORMAL',
      injuriesEnabled: true, coachFiringEnabled: false,
      transferPortalEnabled: true, budgetConstraintsEnabled: true,
    },
    calendar,
    schools,
    conferences,
    players,
    coaches,
    teams,
    recruits: {},
    schedule,
    dynastyYear: 1,
    level,                   // NEW: surface level on state for the rest of the engine
    isPreviewDynasty: true,  // flag so UI surfaces "PREVIEW" warnings
    ap: {
      currentWeek: 0,
      baseline: initialAP,
      spentThisWeek: 0,
      spentByCategory: { recruiting: 0, development: 0, team_boost: 0, program: 0, staff: 0 },
    },
    budget: defaultBudgetForSchool(
      userSchool,
      coaches[userTeam.headCoachId].salary +
      userTeam.assistantCoachIds.reduce((s, id) => s + (coaches[id]?.salary || 0), 0),
    ),
    rngSeed: seed,
    newsfeed: [{
      id: 'dyn_start',
      year: 2026, week: 1, type: 'AWARD',
      headline: isStoryMode
        ? `${input.userCoach.firstName} ${input.userCoach.lastName} hired as ${userStoryRole.replace(/_/g, ' ').toLowerCase()} at ${userSchool.name}. The climb starts here.`
        : `${input.userCoach.firstName} ${input.userCoach.lastName} named head coach at ${userSchool.name}.`,
      payload: {},
      big: true,
    }, {
      id: 'preview_notice',
      year: 2026, week: 1, type: 'AWARD',
      headline: `${level} preview: non-NAIA engine integration is in progress. Schedule + sim work; recruiting + postseason use NAIA-equivalent stubs for now.`,
      payload: {},
    }],
  }

  // Story-mode career state. Stamps the starting school/role/level on the
  // trajectory log; the offer engine takes over from there each offseason.
  if (isStoryMode) {
    state.career = buildInitialCareer({
      difficulty: input.gameOptions?.difficulty || 'NORMAL',
      schoolName: userSchool.name,
      level,
      role: userStoryRole,
      year: 2026,
    })
    state.career.trajectory[0].schoolId = input.userSchoolId
  }
  return state
}

// ─── Building blocks ──────────────────────────────────────────────────────

function buildUserHeadCoach(uc, school, role = 'HEAD_COACH') {
  const qualityAvg = (uc.developer + uc.motivator + uc.recruiter + uc.tactician) / 4
  return {
    id: `hc_user_${school.id}`,
    firstName: uc.firstName,
    lastName: uc.lastName,
    age: role === 'GRADUATE_ASSISTANT' ? 24 : role === 'BENCH_COACH' ? 28 : 35,
    schoolId: school.id,
    role,
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
    salary: computeCoachSalary(school.resourceTier, role, qualityAvg),
    contractYearsRemaining: role === 'HEAD_COACH' ? 4 : 2,
    ambition: 50,
    loyalty: 99,
    isUser: true,
  }
}

/**
 * Build a synthetic School object for a non-NAIA program. Fields like
 * programHistory / scholarshipPool / facilityRating are estimated from
 * the level + strength so the rest of the engine doesn't see undefined.
 */
function buildSyntheticSchool({ id, name, city, state, nickname, conferenceId, strength, level, colors }) {
  // Universal-strength projection per the same mapping nwbbRating uses
  const tierBase = { D1: 78, D2: 55, D3: 40, NWAC: 50 }[level] ?? 50
  const programHistory = Math.max(15, Math.min(99, Math.round(tierBase + (strength || 0) * 2.0)))

  // Resource tier per level (rough budget proxy)
  const resourceTier = level === 'D1' ? 'D1_LITE'
    : level === 'D2' ? 'WELL_FUNDED'
    : level === 'D3' ? 'MID'
    : level === 'NWAC' ? 'SHOESTRING'
    : 'MID'

  // === Tuition realistically varies per level ===
  // D1 (private + state):  $30K-$60K
  // D1 publics in-state:   $15K-$30K  (Big Ten state schools, in-state rate)
  // D2:                    $20K-$40K
  // D3:                    $45K-$70K  (private LACs are expensive)
  // NAIA:                  $25K-$45K
  // NWAC:                  $4K-$8K    (JUCO — way cheaper)
  // Plus jitter by program prestige (top D1s are more expensive — Stanford
  // vs Wichita State pricing reality).
  const tuitionJitter = (programHistory - 50) * 80   // +/- $3K typical
  let tuition
  if (level === 'D1')      tuition = 38000 + tuitionJitter
  else if (level === 'D2') tuition = 28000 + tuitionJitter * 0.5
  else if (level === 'D3') tuition = 55000 + tuitionJitter * 0.6   // D3 LACs are expensive
  else if (level === 'NWAC') tuition = 5500 + tuitionJitter * 0.1
  else tuition = 32000 + tuitionJitter * 0.4   // NAIA

  // === Scholarship pool — per-level realism ===
  //   D1 baseball gets 11.7 NCAA scholarships split across ~30 players.
  //     At top-tier programs that's ~$700K-$1.2M in tuition equivalency.
  //     Bottom D1 maybe $200K-$400K.
  //   D2: 9 NCAA scholarships → ~$200K-$500K.
  //   D3: ZERO athletic scholarships. Some academic aid through normal
  //     admissions; pool is $0 for athletic recruiting purposes.
  //   NAIA: 12 scholarships per roster → ~$120K-$280K.
  //   NWAC (JUCO): no formal athletic scholarships, occasional tuition
  //     waiver. Pool $0 for our model (tuition cost is so low it doesn't
  //     dominate decisions anyway).
  let scholarshipPool
  if (level === 'D1') {
    scholarshipPool = programHistory >= 75 ? 1_000_000
      : programHistory >= 60 ? 550_000
      : 280_000
  } else if (level === 'D2') {
    scholarshipPool = programHistory >= 65 ? 480_000 : 220_000
  } else if (level === 'D3' || level === 'NWAC') {
    scholarshipPool = 0
  } else {
    // NAIA
    scholarshipPool = programHistory >= 65 ? 280_000 : 140_000
  }

  // === Coaching budget per level ===
  let coachingBudget
  if (level === 'D1') coachingBudget = programHistory >= 75 ? 2_500_000 : 800_000
  else if (level === 'D2') coachingBudget = 350_000
  else if (level === 'D3') coachingBudget = 200_000
  else if (level === 'NWAC') coachingBudget = 80_000
  else coachingBudget = 150_000   // NAIA

  return {
    id,
    name,
    city: city || '',
    state: state || '',
    nickname,
    colors,
    conferenceId,
    resourceTier,
    tuitionPerYear: Math.round(tuition),
    roomAndBoardPerYear: level === 'NWAC' ? 0 : 14000,   // JUCOs are commuter heavy
    scholarshipPool,
    coachingBudget,
    facilityRating: clamp(50 + (strength || 0) * 1.5, 30, 95),
    programHistory,
    academicReputation: 60,
    region: stateToRegion(state),
    metroSize: 'small',
    pearRating: strength || 0,
    level,
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
function stateToRegion(state) {
  if (!state) return 'NW'
  if (['WA','OR','ID','MT','BC'].includes(state)) return 'NW'
  if (['CA'].includes(state)) return 'W'
  if (['AZ','NV','UT','NM','CO','WY'].includes(state)) return 'W'
  if (['TX','OK','AR','LA','KS','NE','SD','ND','MN','MO','IA'].includes(state)) return 'MW'
  if (['TN','MS','AL','GA','FL','SC','NC','VA','WV','KY'].includes(state)) return 'SE'
  if (['IL','IN','OH','MI','WI'].includes(state)) return 'MW'
  return 'NE'
}

/**
 * Build a level-aware conference round-robin schedule.
 *
 * Game-count target per level (from data file): D1 56, D2 50, D3 40, NWAC 36.
 * For an N-team conference, each team plays every other team multiple
 * times. Sequence: 3-game weekend series at home/away alternating, padded
 * with midweek games to reach the level's target.
 *
 * This is intentionally simpler than the NAIA buildConferenceSchedule —
 * NAIA has nuanced double-up partner rotation. For other levels we use a
 * straightforward round-robin × N rotation until we hit the target.
 */
export function buildLevelSchedule(conferenceId, schools, level, year, seed) {
  const rng = makeRng('level_sched', conferenceId, seed)
  const teamIds = Object.keys(schools)
  const targetGames = seasonGamesForLevel(level)

  // INDEPENDENT path — a single-school "conference" (Oregon State Indep
  // is the canonical case). No conference games, no conference tournament.
  // Schedule a full season of non-conference series against random D1
  // opponents pulled from the non_naia universe. The user can still earn
  // an at-large NCAA Regional bid but never a conference auto-bid.
  if (teamIds.length < 2 || conferenceId === 'INDEPENDENT_D1') {
    return buildIndependentSchedule(teamIds[0], level, year, rng, targetGames)
  }

  const games = []

  // Each pair plays at least a 3-game series. Add more series until we hit target.
  // Roughly: each team has (N-1) opponents × seriesCount × 3 games per series.
  // seriesCount = ceil(targetGames / ((N-1) * 3)) — at least 1.
  const N = teamIds.length
  const seriesPerPair = Math.max(1, Math.ceil(targetGames / Math.max(1, (N - 1) * 3)))

  // Build pairwise series. Weekend slot starts in late Feb (week 26) and
  // each series takes 1 week. We have ~14 weeks of regular season slots.
  let seriesIdx = 0
  const seasonStartWeek = 27   // regular season starts week 27 of game year
  for (let s = 0; s < seriesPerPair; s++) {
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        // Alternate home/away across series rounds
        const homeFirst = (s % 2) === 0
        const homeId = homeFirst ? teamIds[i] : teamIds[j]
        const awayId = homeFirst ? teamIds[j] : teamIds[i]
        const wk = seasonStartWeek + (seriesIdx % 14)
        const seriesId = `${conferenceId}_${year}_${seriesIdx}`
        // 3-game series — Fri/Sat/Sun
        for (let g = 0; g < 3; g++) {
          games.push({
            id: `${seriesId}_g${g}`,
            year,
            seasonWeek: (seriesIdx % 14) + 1,
            weekOfYear: wk,
            date: dateForWeek(year, wk, g),
            homeId, awayId,
            type: 'CONFERENCE',
            seriesId,
            countsTowardRecord: true,
            isDoubleheader: false,
            played: false,
            homeRuns: null, awayRuns: null,
          })
        }
        seriesIdx++
      }
    }
  }
  return games
}

// Approximate ISO date for a given (year, weekOfYear, dayOffset). The
// engine uses date strings only for display + ordering — exact calendar
// alignment isn't required.
function dateForWeek(year, weekOfYear, dayOffset) {
  const startMs = Date.UTC(year, 0, 1) + (weekOfYear - 1) * 7 * 86400000 + dayOffset * 86400000
  const d = new Date(startMs)
  return d.toISOString().slice(0, 10)
}

// Cheap conference-name → 3-4 char abbreviation
function conferenceAbbreviation(confId) {
  const map = {
    BIG_TEN: 'B1G', ACC: 'ACC', WCC: 'WCC', WAC: 'WAC',
    INDEPENDENT_D1: 'IND',
    GNAC: 'GNAC', NWC: 'NWC', CCC: 'CCC', FRONTIER: 'FRC',
    NWAC_NORTH: 'NWAC-N', NWAC_SOUTH: 'NWAC-S', NWAC_EAST: 'NWAC-E', NWAC_WEST: 'NWAC-W',
  }
  return map[confId] || confId.slice(0, 6)
}

// ─── Independent-program scheduling ─────────────────────────────────────
//
// D1 independents (e.g. Oregon State after Pac-12 collapse) have no
// conference and therefore no conference tournament. Their entire season
// is non-conference games. This builder synthesizes a full slate against
// random national D1 opponents, alternating home/road, with realistic
// pacing (weekend 3-game series + 1 midweek per week).

function buildIndependentSchedule(userSchoolId, level, year, rng, targetGames) {
  if (!userSchoolId) return []
  // Build opponent pool — every D1 team in the non-NAIA universe that
  // ISN'T the user. Bias toward mid+ teams (skip the bottom 50) so the
  // schedule has some teeth.
  const allD1 = (nonNaiaRaw.divisions || []).find(d => d.id === 'D1')?.teams || []
  const opponents = allD1
    .filter(t => t.id !== userSchoolId)
    .sort((a, b) => (b.strength || 0) - (a.strength || 0))
    .slice(0, 220)
  if (opponents.length === 0) return []

  // ~13 weekends of regular-season slots starting wk 27.
  const games = []
  const seasonStartWeek = 27
  const numWeekends = 13
  // Each weekend = a 3-game series. Plus a midweek game most weeks.
  let oppIdx = 0
  for (let w = 0; w < numWeekends; w++) {
    if (games.length >= targetGames) break
    const opponent = opponents[oppIdx % opponents.length]
    oppIdx++
    const wk = seasonStartWeek + w
    const homeFirst = (w % 2) === 0   // alternate home/away each weekend
    const homeId = homeFirst ? userSchoolId : opponent.id
    const awayId = homeFirst ? opponent.id : userSchoolId
    const seriesId = `indep_${year}_w${w}`
    for (let g = 0; g < 3; g++) {
      games.push({
        id: `${seriesId}_g${g}`,
        year,
        seasonWeek: w + 1,
        weekOfYear: wk,
        date: dateForWeek(year, wk, g + 4),   // Fri/Sat/Sun
        homeId, awayId,
        type: 'NON_CONFERENCE',
        seriesId,
        countsTowardRecord: true,
        isDoubleheader: false,
        played: false,
        homeRuns: null, awayRuns: null,
      })
    }
    // Midweek game (Tuesday) — pick a different random opponent
    if (games.length < targetGames && w > 0) {
      const midOpp = opponents[(oppIdx * 7 + w) % opponents.length]
      oppIdx++
      games.push({
        id: `indep_mid_${year}_w${w}`,
        year,
        seasonWeek: w + 1,
        weekOfYear: wk,
        date: dateForWeek(year, wk, 1),
        homeId: w % 3 === 0 ? midOpp.id : userSchoolId,
        awayId: w % 3 === 0 ? userSchoolId : midOpp.id,
        type: 'D1_MIDWEEK',
        seriesId: null,
        countsTowardRecord: true,
        isDoubleheader: false,
        played: false,
        homeRuns: null, awayRuns: null,
      })
    }
  }
  return games
}
