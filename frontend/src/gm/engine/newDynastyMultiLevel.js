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
    schools[m.id] = buildSyntheticSchool({
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

  // 3. Generate the user's coach
  const userSchool = schools[input.userSchoolId]
  if (!userSchool) throw new Error(`User school ${input.userSchoolId} not in conference ${conferenceId}`)
  const userHC = buildUserHeadCoach(input.userCoach, userSchool)

  // 4. Generate full staffs + rosters for every team in the conference
  /** @type {Object<string, any>} */
  const coaches = {}
  /** @type {Object<string, any>} */
  const teams = {}
  /** @type {Object<string, any>} */
  const players = {}

  for (const school of Object.values(schools)) {
    let headCoach
    let assistants
    if (school.id === input.userSchoolId) {
      headCoach = userHC
      const generated = generateStaff(school, seed)
      assistants = generated.assistants
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
    const teamAssistants = isUserSchool ? [] : assistants
    if (isUserSchool) {
      for (const a of assistants) delete coaches[a.id]
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
      headline: `${input.userCoach.firstName} ${input.userCoach.lastName} named head coach at ${userSchool.name}.`,
      payload: {},
      big: true,
    }, {
      id: 'preview_notice',
      year: 2026, week: 1, type: 'AWARD',
      headline: `${level} preview: non-NAIA engine integration is in progress. Schedule + sim work; recruiting + postseason use NAIA-equivalent stubs for now.`,
      payload: {},
    }],
  }
  return state
}

// ─── Building blocks ──────────────────────────────────────────────────────

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
  // D3 has NO athletic scholarships — set pool to 0. NWAC = JUCO, no athletic
  // scholarships either (a few small academic awards).
  const scholarshipPool = level === 'D3' || level === 'NWAC' ? 0
    : level === 'D1' ? 800000
    : level === 'D2' ? 350000
    : 150000
  return {
    id,
    name,
    city: city || '',
    state: state || '',
    nickname,
    colors,
    conferenceId,
    resourceTier,
    tuitionPerYear: level === 'D1' ? 55000 : level === 'D2' ? 35000 : level === 'D3' ? 50000 : 12000,
    roomAndBoardPerYear: 14000,
    scholarshipPool,
    coachingBudget: level === 'D1' ? 1200000 : level === 'D2' ? 350000 : level === 'D3' ? 200000 : 100000,
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
  if (teamIds.length < 2) return []
  const targetGames = seasonGamesForLevel(level)
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
    GNAC: 'GNAC', NWC: 'NWC', CCC: 'CCC', FRONTIER: 'FRC',
    NWAC_NORTH: 'NWAC-N', NWAC_SOUTH: 'NWAC-S', NWAC_EAST: 'NWAC-E', NWAC_WEST: 'NWAC-W',
  }
  return map[confId] || confId.slice(0, 6)
}
