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
import { dateForWeek as unifiedDateForWeek, postseasonLayout } from './gameYear'
import { buildInitialCareer } from './storyMode'
import { teamOverall } from './playerRating'
import { expectedTeamOvr } from './programRating'
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

  // 1. Build the schools map. For D1/D2/D3 dynasties we want the FULL
  //    conference (e.g. Oregon's Big Ten dynasty plays Indiana, UCLA, etc.,
  //    not just the other PNW Big Ten team). pnwMembers is the user-pickable
  //    PNW subset; the rest of the conference comes from non_naia_teams.json
  //    via pearConference matching.
  //
  //    For NWAC + NAIA + INDEPENDENT_D1 the existing behavior is right: only
  //    PNW members are in scope.
  /** @type {Object<string, any>} */
  const schools = {}

  // Map our internal conferenceId to the pearConference string used in
  // non_naia_teams.json. Lets us pull the full national conference roster.
  const PEAR_CONF_NAME = {
    BIG_TEN: 'Big Ten',
    WCC: 'West Coast',
    WAC: 'Western Athletic',
    // GNAC + NWC + NWAC are PNW-only — don't expand.
  }

  // Members from playoff data (PNW + tagged additions).
  // For NWAC dynasties we want ALL FOUR divisions in scope — Nate's spec:
  // NWAC teams only play other NWAC teams, conference games are within
  // division, non-conference games are cross-division NWAC. Tag each member
  // with the division they belong to so the schedule builder can split
  // conference vs non-conference correctly.
  const NWAC_DIVS = ['NWAC_NORTH', 'NWAC_SOUTH', 'NWAC_EAST', 'NWAC_WEST']
  /** @type {Array<{ id: string, name: string, city?: string, state?: string, nickname?: string, colors?: any, _divId: string }>} */
  const allMembers = []
  if (level === 'NWAC') {
    for (const divId of NWAC_DIVS) {
      const divConf = CONF_CONFIG[divId]
      if (!divConf) continue
      for (const m of (divConf.pnwMembers || [])) {
        allMembers.push({ ...m, _divId: divId })
      }
    }
  } else {
    for (const m of (conf.pnwMembers || [])) {
      allMembers.push({ ...m, _divId: conferenceId })
    }
  }
  // For D1 conferences with a non-NAIA mapping, append the rest of the
  // national conference roster from non_naia_teams.json.
  const peerName = PEAR_CONF_NAME[conferenceId]
  if (peerName && nonNaiaRaw.divisions) {
    const div = nonNaiaRaw.divisions.find(d => d.id === level)
    if (div) {
      const pnwIds = new Set(allMembers.map(m => m.id))
      for (const t of (div.teams || [])) {
        if (t.pearConference !== peerName) continue
        if (pnwIds.has(t.id)) continue   // already counted as a PNW member
        allMembers.push({
          id: t.id, name: t.name, city: t.city, state: t.state, nickname: t.nickname,
          _divId: conferenceId,
        })
      }
    }
  }

  for (const m of allMembers) {
    const fromPool = findNonNaia(m.id)
    // For NWAC, each team's conferenceId is its own division (NWAC_NORTH etc).
    // Other levels just use the user's conferenceId since the user's conf is
    // the only one populated.
    const memberConfId = m._divId || conferenceId
    const synthetic = buildSyntheticSchool({
      id: m.id,
      name: m.name,
      city: m.city,
      state: m.state,
      nickname: m.nickname || (fromPool?.nickname ?? ''),
      conferenceId: memberConfId,
      strength: fromPool?.strength ?? 0,
      level,
      // Prefer colors set directly on the PNW member (playoff_formats — used
      // for NWAC schools that aren't in PEAR's national dataset), fall back
      // to the non_naia_teams pool entry.
      colors: m.colors || fromPool?.colors || null,
    })
    // Layer in researched real-world financials for PNW programs we have
    // data for (every D1/D2/D3/NAIA member of these confs is in the file).
    applyRealFinancials(synthetic)
    schools[m.id] = synthetic
  }

  // 2. Build the conferences map. For NWAC we register all 4 divisions
  // (with each division's schoolIds) so the rest of the engine can iterate
  // them. For other levels there's just the user's conference.
  /** @type {Object<string, any>} */
  const conferences = {}
  if (level === 'NWAC') {
    for (const divId of NWAC_DIVS) {
      const divConf = CONF_CONFIG[divId]
      if (!divConf) continue
      const memberIds = (divConf.pnwMembers || []).map(m => m.id).filter(id => schools[id])
      conferences[divId] = {
        id: divId,
        name: divConf.name,
        abbreviation: conferenceAbbreviation(divId),
        level,
        schoolIds: memberIds,
        tournament: divConf.tournament,
      }
    }
  } else {
    conferences[conferenceId] = {
      id: conferenceId,
      name: conf.name,
      abbreviation: conferenceAbbreviation(conferenceId),
      level,
      schoolIds: Object.keys(schools),
      tournament: conf.tournament,
    }
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
    // Anchor the generated roster's scholarship commitments to the school's
    // actual pool. estimateScholarship sizes each offer off player ratings,
    // which for WELL_FUNDED D2 programs with full 40-50 rosters routinely
    // overshoots the pool — leaving a brand-new dynasty already over budget
    // with $0 to recruit (NN: $390K committed vs a $250K pool). Scale so the
    // full roster sits a hair under the pool; graduating seniors then free
    // real next-year money. Pool=0 (D3/NWAC: no athletic aid) → zero out.
    normalizeRosterScholarships(rosterIds, players, school.scholarshipPool)

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
    // Pin starting Team OVR to expectedTeamOvr so the in-game value matches
    // the deterministic OVR shown on the team-picker tile. Roster randomness
    // would otherwise move the starting Team OVR ±2-3 per new dynasty.
    {
      const raw = teamOverall(teams[school.id], players).overall
      teams[school.id].ovrOffset = expectedTeamOvr({ ...school, level }) - raw
    }
  }

  // 5. Schedule — conference round-robin scaled to level's seasonGames. D2 ends
  // a week early (postseason starts wk39), so drop any regular-season games in
  // seasonWeek 13+.
  let schedule = buildLevelSchedule(conferenceId, schools, level, 2027, seed)
  if (level === 'D2') schedule = schedule.filter(g => !(typeof g.seasonWeek === 'number' && g.seasonWeek > 12))

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
  // Universal-strength projection per the same mapping nwbbRating uses.
  // Tuned May 2026 to widen the gap between strong + weak programs within
  // each level so the Team OVR hierarchy matches real-world expectations:
  //   Top D1 → ~92 OVR, bottom D1 → ~84-86
  //   Top D2 → ~82 OVR, bottom D2 → ~73-75
  //   Top NWAC → ~75 OVR, bottom NWAC → ~60-65
  // Each level now uses a steeper strength slope and a slightly higher
  // tierBase. See scripts/pnw-team-ovr-report.mjs to verify hierarchy.
  // PH formula tuned for the PNW Team OVR hierarchy Nate wants:
  //   D1   best ~94 (Oregon St), worst ~85 (Seattle U)
  //   D2   best ~83 (NN Nazarene), worst ~67 (Saint Martin's)
  //   D3   best ~81 (Whitworth), worst ~65 (Willamette)
  //   NWAC best ~75 (Everett), worst ~62 (Grays Harbor)
  // D2 + D3 slopes widened May 2026 — bottom-of-conference programs now
  // dip below the NAIA floor (Eastern Oregon ~68) so the worst PNW D2/D3
  // teams feel meaningfully weaker than the worst NAIA team.
  const tierBase  = { D1: 74, D2: 46, D3: 30, NWAC: 44 }[level] ?? 50
  const tierSlope = { D1: 6.5, D2: 9.0, D3: 11.0, NWAC: 4.5 }[level] ?? 2.0
  const programHistory = Math.max(15, Math.min(99, Math.round(tierBase + (strength || 0) * tierSlope)))

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

/**
 * Scale a freshly-generated roster's per-player scholarship amounts so the
 * full commitment fits the school's pool. Keeps the relative spread (the
 * stud still gets the most) but caps the sum at ~92% of pool. Pool<=0
 * (D3/NWAC have no athletic scholarships) zeroes everything out.
 */
function normalizeRosterScholarships(rosterIds, players, pool) {
  if (!pool || pool <= 0) {
    for (const id of rosterIds) {
      if (players[id]?.scholarship) players[id].scholarship.annualAmount = 0
    }
    return
  }
  let total = 0
  for (const id of rosterIds) total += players[id]?.scholarship?.annualAmount || 0
  const target = pool * 0.92
  if (total <= target || total <= 0) return
  const factor = target / total
  for (const id of rosterIds) {
    const sch = players[id]?.scholarship
    if (sch && sch.annualAmount) sch.annualAmount = Math.round(sch.annualAmount * factor)
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

  // NWAC path — split by division. 1 series within division as CONFERENCE
  // games; each team plays ~3 cross-division series as NON_CONFERENCE
  // games against other NWAC teams (never non-NWAC). Per Nate: "NWAC teams
  // can NOT play any teams other than NWAC teams."
  if (level === 'NWAC') {
    return buildNwacSchedule(schools, year, rng)
  }

  // Proper round-robin via the circle method. Each generated "round" is a set
  // of pairings in which every team appears AT MOST once — so a team never
  // plays two series in the same week (the old seriesIdx%14 scheme did exactly
  // that). We lay one round per week starting wk 27 and cycle the rotation
  // until the level's regular-season window is full, alternating who hosts
  // each time a pair repeats.
  const layout = postseasonLayout(level)
  const maxWeeks = Math.max(1, (layout.seasonEnd ?? 39) - 26)   // D2 ends wk38 → 12 weeks
  const rounds = roundRobinRounds(teamIds)                       // N-1 (even) / N (odd) matchings
  const games = []
  const playCount = new Map()   // pairKey → times played (drives home/away alternation)
  const seasonStartWeek = 27
  for (let w = 0; w < maxWeeks; w++) {
    if (rounds.length === 0) break
    const round = rounds[w % rounds.length]
    const wk = seasonStartWeek + w
    for (const [t1, t2] of round) {
      const key = t1 < t2 ? `${t1}|${t2}` : `${t2}|${t1}`
      const n = playCount.get(key) || 0
      playCount.set(key, n + 1)
      const homeFirst = (n % 2) === 0
      const homeId = homeFirst ? t1 : t2
      const awayId = homeFirst ? t2 : t1
      const seriesId = `${conferenceId}_${year}_w${w}_${homeId}`
      // 3-game weekend series — Fri/Sat/Sun
      for (let g = 0; g < 3; g++) {
        games.push({
          id: `${seriesId}_g${g}`,
          year,
          seasonWeek: w + 1,
          weekOfYear: wk,
          date: dateForWeek(year, wk, g + 4),
          homeId, awayId,
          type: 'CONFERENCE',
          seriesId,
          countsTowardRecord: true,
          isDoubleheader: false,
          played: false,
          homeRuns: null, awayRuns: null,
        })
      }
    }
  }
  return games
}

/**
 * Round-robin pairings via the circle method. Returns an array of rounds;
 * each round is an array of [teamA, teamB] pairs in which every team appears
 * at most once. Odd team counts get a rotating bye. N-1 rounds for even N,
 * N rounds for odd N — a full single round-robin (everyone plays everyone).
 */
function roundRobinRounds(teamIds) {
  const arr = [...teamIds]
  if (arr.length < 2) return []
  if (arr.length % 2 === 1) arr.push('__BYE__')
  const n = arr.length
  const rounds = []
  for (let r = 0; r < n - 1; r++) {
    const pairs = []
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i]
      const b = arr[n - 1 - i]
      if (a !== '__BYE__' && b !== '__BYE__') pairs.push([a, b])
    }
    rounds.push(pairs)
    // Rotate everyone but the first element (standard circle-method rotation).
    arr.splice(1, 0, arr.pop())
  }
  return rounds
}

/**
 * NWAC schedule builder.
 *
 *   - Conference: 1 series (3 games) vs every team in the same division.
 *     Each division has a different team count so conf-game totals vary
 *     by team (~18-24 conf games).
 *   - Non-conference: 3 series vs randomly-drawn teams from OTHER NWAC
 *     divisions. Adds ~9 games, brings the total slate to ~27-33 games.
 *   - Never schedules a non-NWAC opponent.
 *
 * Per Nate: division/region champ = conf record. Final 8 bracket lives in
 * pnwPlayoffs — this builder is regular-season only.
 */
function buildNwacSchedule(schools, year, rng) {
  // Group teams by their conferenceId (division).
  const byDiv = {}
  for (const id of Object.keys(schools)) {
    const div = schools[id].conferenceId || 'NWAC_NORTH'
    if (!byDiv[div]) byDiv[div] = []
    byDiv[div].push(id)
  }
  const games = []
  let seriesIdx = 0
  const seasonStartWeek = 27   // matches buildLevelSchedule's regular-season window

  // 1. Within-division round-robin — 1 series per opponent pair.
  for (const div of Object.keys(byDiv)) {
    const teams = byDiv[div]
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        // Alternate home by deterministic index so it's not always the lower-
        // indexed team hosting.
        const homeFirst = (i + j) % 2 === 0
        const homeId = homeFirst ? teams[i] : teams[j]
        const awayId = homeFirst ? teams[j] : teams[i]
        const wk = seasonStartWeek + (seriesIdx % 14)
        const seriesId = `${div}_${year}_${seriesIdx}`
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

  // 2. Cross-division NWAC non-conference. Each team plays ~3 series
  // against a random non-division NWAC opponent. Track pairings to avoid
  // duplicate matchups within the cross-div pool.
  const SERIES_PER_TEAM = 3
  const seenPair = new Set()
  function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}` }
  const allTeamIds = Object.keys(schools)
  for (const teamId of allTeamIds) {
    const myDiv = schools[teamId].conferenceId
    // Candidates = NWAC teams NOT in my division
    const candidates = allTeamIds.filter(other =>
      other !== teamId
      && schools[other].conferenceId !== myDiv
      && !seenPair.has(pairKey(teamId, other))
    )
    // Shuffle deterministically using the rng
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1))
      ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
    }
    const opps = candidates.slice(0, SERIES_PER_TEAM)
    for (const oppId of opps) {
      seenPair.add(pairKey(teamId, oppId))
      const homeFirst = rng.chance(0.5)
      const homeId = homeFirst ? teamId : oppId
      const awayId = homeFirst ? oppId : teamId
      const wk = seasonStartWeek + (seriesIdx % 14)
      const seriesId = `NWAC_XDIV_${year}_${seriesIdx}`
      for (let g = 0; g < 3; g++) {
        games.push({
          id: `${seriesId}_g${g}`,
          year,
          seasonWeek: (seriesIdx % 14) + 1,
          weekOfYear: wk,
          date: dateForWeek(year, wk, g),
          homeId, awayId,
          type: 'NON_CONFERENCE',
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

  return games
}

// ISO date for a given (year, weekOfYear, dayOffset), anchored to the SAME
// unified calendar the rest of the engine uses: `year` is the spring-end
// year, Wk 1 = Aug 1 of (year-1), Wk 27 = ~late Jan/early Feb of `year`.
// (The old local version anchored to Jan 1 of `year`, which dropped spring
// conference games into July — the D2 schedule-date bug.)
function dateForWeek(year, weekOfYear, dayOffset = 0) {
  const base = unifiedDateForWeek(year, weekOfYear)   // Date at Aug1(year-1)+weeks
  const d = new Date(base.getTime() + dayOffset * 86400000)
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
