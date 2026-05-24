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
import { teamOverall } from './playerRating'
import { expectedTeamOvr, phForTargetOvr, ovrForLevelRank } from './programRating'
import { makeRng, hashSeed } from './rng'
import { defaultBudgetForSchool } from './budget'
import {
  CONF_CONFIG, LEVEL_CONFIG, findNonNaia,
  classYearsForLevel, rosterCapForLevel, seasonGamesForLevel,
} from './levelHelpers'
import { applyRealFinancials } from './schoolFinancials'
import { dateForWeek as unifiedDateForWeek, postseasonLayout } from './gameYear'
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
  // Display name per conference id (so the conferences map + Rankings show
  // "Mid-America Intercollegiate" etc. for the non-user conferences).
  /** @type {Object<string,string>} */
  const confNameById = {}
  if (level === 'NWAC') {
    for (const divId of NWAC_DIVS) {
      const divConf = CONF_CONFIG[divId]
      if (!divConf) continue
      confNameById[divId] = divConf.name
      for (const m of (divConf.pnwMembers || [])) {
        allMembers.push({ ...m, _divId: divId })
      }
    }
  } else {
    // D1/D2/D3: build the FULL division so every team plays every week with a
    // real roster — true NAIA parity (per Nate). Teams are grouped into their
    // real conferences by pearConference; the user's conference keeps its
    // CONF_CONFIG id/name/tournament, all others get a slugged id + name.
    const slugConf = (name) => 'CONF_' + String(name || 'IND').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase().slice(0, 24)
    let userPearConf = null
    for (const m of (conf.pnwMembers || [])) {
      const t = findNonNaia(m.id)
      if (t?.pearConference) { userPearConf = t.pearConference; break }
    }
    const confIdFor = (pearConf) => (pearConf && pearConf === userPearConf) ? conferenceId : slugConf(pearConf)
    confNameById[conferenceId] = conf.name
    const divisionTeams = (nonNaiaRaw.divisions || []).find(d => d.id === level)?.teams || []
    const pnwById = {}
    for (const m of (conf.pnwMembers || [])) pnwById[m.id] = m
    const seen = new Set()
    for (const t of divisionTeams) {
      const cid = confIdFor(t.pearConference)
      if (cid !== conferenceId) confNameById[cid] = t.pearConference
      const pnw = pnwById[t.id]
      allMembers.push({
        id: t.id,
        name: pnw?.name || t.name,
        city: t.city, state: t.state,
        nickname: pnw?.nickname || t.nickname,
        colors: pnw?.colors || t.colors || null,
        _divId: cid,
      })
      seen.add(t.id)
    }
    // Safety net: ensure every one of the user's PNW members exists even if a
    // particular id is missing from the national pool.
    for (const m of (conf.pnwMembers || [])) {
      if (seen.has(m.id)) continue
      allMembers.push({ ...m, _divId: conferenceId })
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
      pearRank: fromPool?.pearRank ?? null,
      // NWAC schools use ppiRank (set on the member entry in
      // pnw_playoff_formats.json) since they aren't in non_naia_teams' PEAR
      // dataset. Other levels ignore this.
      ppiRank: m.ppiRank ?? null,
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
    // One conference per distinct conferenceId now present in `schools`
    // (the user's conf + every other conference in the division).
    const byConf = {}
    for (const id of Object.keys(schools)) {
      const cid = schools[id].conferenceId
      ;(byConf[cid] || (byConf[cid] = [])).push(id)
    }
    for (const cid of Object.keys(byConf)) {
      const isUser = cid === conferenceId
      conferences[cid] = {
        id: cid,
        name: confNameById[cid] || (isUser ? conf.name : cid),
        abbreviation: isUser ? conferenceAbbreviation(conferenceId) : (confNameById[cid] || cid),
        level,
        schoolIds: byConf[cid],
        tournament: isUser ? conf.tournament : null,
      }
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
    // Team OVR pin. scaleRosterToTarget shifts ratings to hit the expected
    // OVR, but ratings clamp at 99 — for top-bucket teams (D1 PH=99) that
    // clamp prevents reaching OVR 98 because top players saturate the
    // ceiling before the full delta is applied. Compute the residual gap
    // and stash it as ovrOffset so the displayed Team OVR exactly matches
    // expectedTeamOvr (i.e. the team-picker tile value).
    const expectedOvr = expectedTeamOvr(school)
    const naturalOvr = teamOverall(teams[school.id], players).overall
    const residual = expectedOvr - naturalOvr
    if (Math.abs(residual) >= 1) teams[school.id].ovrOffset = residual
  }

  // 5. Schedule. D1/D2/D3 build the FULL division (every conference plays a
  // round-robin + front-week non-conf fillers so the whole league plays every
  // week — true NAIA parity). NWAC + single-team independents keep the
  // simpler per-conference builder. D2 ends a week early (postseason starts
  // wk39), so drop any regular-season games in seasonWeek 13+.
  let schedule
  if (level === 'NWAC' || Object.keys(schools).length < 2) {
    schedule = buildLevelSchedule(conferenceId, schools, level, 2027, seed)
  } else if (conferenceId === 'INDEPENDENT_D1') {
    // Independent D1 (e.g. Oregon State): the user has NO conference games and
    // NO pre-filled non-conf slate at dynasty creation (per Nate: filling the
    // entire slate auto-decided opponents — and only top-25 ones at that).
    // The user fills the schedule game-by-game on the Schedule page, or hits
    // the Auto Create Schedule button which uses the parity-aware
    // autoCreateSchedule. The rest of D1 still plays its full conference
    // round-robins so the whole league has records every week.
    schedule = buildFullDivisionSchedule(conferences, schools, level, 2027, seed, input.userSchoolId)
  } else {
    schedule = buildFullDivisionSchedule(conferences, schools, level, 2027, seed, input.userSchoolId)
  }
  // 4-round leagues (D1 + D2 + D3) end the regular season a week early — keep
  // seasonWeek <= 12 (wk38) so wk39 is free for the conference tournament.
  if (level === 'D1' || level === 'D2' || level === 'D3') {
    schedule = schedule.filter(g => !(typeof g.seasonWeek === 'number' && g.seasonWeek > 12))
  }

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
function buildSyntheticSchool({ id, name, city, state, nickname, conferenceId, strength, pearRank, ppiRank, level, colors }) {
  // PROGRAM HISTORY computation — drives Team OVR via expectedTeamOvr().
  //
  // D1 uses RANK-BASED PH so the 308-team field spreads EVENLY across the
  // OVR window. Per Nate (May 2026): "it needs to be an even spread of
  // overalls from 98 to 88." With expectedTeamOvr = round(75 + (ph-15)*0.27)
  // for D1, mapping rank 1→PH 99 and rank 308→PH 63 lands every team in the
  // OVR 88-98 band with ~28 teams per integer OVR value.
  //
  // Other levels still use the strength-slope formula since the PNW Team OVR
  // hierarchy there is well-calibrated:
  //   D2   best ~83 (NN Nazarene), worst ~67 (Saint Martin's)
  //   D3   best ~81 (Whitworth), worst ~65 (Willamette)
  //   NWAC best ~75 (Everett), worst ~62 (Grays Harbor)
  // RANK-BUCKETED PH (May 2026 — per Nate). Every level (D1/D2/D3/NWAC)
  // now gets an even OVR spread by mapping rank-in-level → target OVR via
  // ovrForLevelRank(), then back-calculating the PH that yields it from
  // expectedTeamOvr's formula. Each level has its own OVR window:
  //   D1   80-98 (308 teams)
  //   D2   60-84 (256 teams)
  //   D3   58-82 (384 teams)
  //   NWAC 51-75 (25 teams — 1 per OVR, unique)
  // For NWAC the input field is ppiRank (NWBB Stats Power Index), not pearRank.
  let programHistory
  const rankInLevel = level === 'NWAC' ? ppiRank : pearRank
  if (typeof rankInLevel === 'number' && rankInLevel > 0) {
    const targetOvr = ovrForLevelRank(level, rankInLevel)
    if (typeof targetOvr === 'number') {
      programHistory = phForTargetOvr(level, targetOvr)
    }
  }
  if (programHistory == null) {
    // Fallback — no rank available (legacy / custom data). Use the
    // strength-slope formula. Clamp lifted from [15, 99] → [0, 99] so
    // very-low-rated teams aren't artificially floored.
    const tierBase  = { D1: 74, D2: 46, D3: 30, NWAC: 44 }[level] ?? 50
    const tierSlope = { D1: 3.5, D2: 9.0, D3: 11.0, NWAC: 4.5 }[level] ?? 2.0
    programHistory = Math.max(0, Math.min(99, Math.round(tierBase + (strength || 0) * tierSlope)))
  }

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
    // Rank within level — surface on the school so expectedTeamOvr can do
    // its rank-bucketed lookup at any call site (picker, scaleRosterToTarget,
    // recompute on roster change, etc.). pearRank for D1/D2/D3 from PEAR data;
    // ppiRank for NWAC from playoff_formats data. Both surface as `pearRank`
    // since expectedTeamOvr reads a single field — NWAC level gates the
    // ppiRank lookup separately.
    pearRank: pearRank ?? ppiRank ?? null,
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
  // Reserve the first couple of weeks for NON-conference play (the user fills
  // them via auto-create / manual scheduling). The conference round-robin then
  // leans to the BACK of the season and runs THROUGH the final regular-season
  // week — so the year ends on conference games, not non-conf filler.
  const FRONT_NONCONF = maxWeeks > 4 ? 2 : 0
  const rounds = roundRobinRounds(teamIds)                       // N-1 (even) / N (odd) matchings
  const games = []
  const playCount = new Map()   // pairKey → times played (drives home/away alternation)
  const seasonStartWeek = 27
  for (let w = FRONT_NONCONF; w < maxWeeks; w++) {
    if (rounds.length === 0) break
    const round = rounds[(w - FRONT_NONCONF) % rounds.length]
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

// Build a single Game record (3-game series day g uses dayOffset g+4 → weekend).
function mkSeriesGame(seriesId, g, year, seasonWeek, weekOfYear, homeId, awayId, type) {
  return {
    id: `${seriesId}_g${g}`,
    year,
    seasonWeek,
    weekOfYear,
    date: dateForWeek(year, weekOfYear, g + 4),
    homeId, awayId,
    type,
    seriesId,
    countsTowardRecord: true,
    isDoubleheader: false,
    played: false,
    homeRuns: null, awayRuns: null,
  }
}

/**
 * Full-division schedule (D1/D2/D3). Every conference plays a circle-method
 * round-robin in the BACK of the season (weeks FRONT+1..maxWeeks), and every
 * NON-user team gets non-conference filler series in the reserved front weeks
 * so the WHOLE league plays every week and accrues records/stats — true NAIA
 * parity. The user's front weeks stay open (they self-schedule via auto-create).
 */
export function buildFullDivisionSchedule(conferences, schools, level, year, seed, userSchoolId) {
  const layout = postseasonLayout(level)
  const maxWeeks = Math.max(1, (layout.seasonEnd ?? 39) - 26)
  const FRONT_NONCONF = maxWeeks > 4 ? 2 : 0
  const seasonStartWeek = 27
  const games = []

  // 1. Per-conference round-robin in the back of the season.
  for (const cid of Object.keys(conferences)) {
    const teamIds = (conferences[cid].schoolIds || []).filter(id => schools[id])
    if (teamIds.length < 2) continue
    const rounds = roundRobinRounds(teamIds)
    if (rounds.length === 0) continue
    const playCount = new Map()
    for (let w = FRONT_NONCONF; w < maxWeeks; w++) {
      const round = rounds[(w - FRONT_NONCONF) % rounds.length]
      const wk = seasonStartWeek + w
      for (let i = 0; i < round.length; i++) {
        const [t1, t2] = round[i]
        const key = t1 < t2 ? `${t1}|${t2}` : `${t2}|${t1}`
        const n = playCount.get(key) || 0
        playCount.set(key, n + 1)
        // The circle method puts the "pivot" team at index 0 in every round —
        // so without rotation it would host every match. Flip pair order based
        // on (round + position) so each team plays ~half its conference series
        // at home and half on the road. Repeat-pair plays alternate via n%2.
        const flip = ((w - FRONT_NONCONF) + i) % 2 === 1
        const [first, second] = flip ? [t2, t1] : [t1, t2]
        const homeId = (n % 2) === 0 ? first : second
        const awayId = (n % 2) === 0 ? second : first
        const seriesId = `${cid}_${year}_w${w}_${homeId}`
        for (let g = 0; g < 3; g++) {
          games.push(mkSeriesGame(seriesId, g, year, w + 1, wk, homeId, awayId, 'CONFERENCE'))
        }
      }
    }
  }

  // 2. Front-week non-conference fillers for every NON-user team (the user
  //    self-schedules their own front weeks). Pair the league two-by-two,
  //    rotating the order each front week so pairings vary.
  if (FRONT_NONCONF > 0) {
    const pool = Object.keys(schools).filter(id => id !== userSchoolId)
    for (let w = 0; w < FRONT_NONCONF; w++) {
      const order = [...pool]
      for (let i = 0; i < w; i++) order.push(order.shift())   // rotate
      const wk = seasonStartWeek + w
      for (let i = 0; i + 1 < order.length; i += 2) {
        const homeId = order[i]
        const awayId = order[i + 1]
        const seriesId = `ncfill_${year}_w${w}_${homeId}`
        for (let g = 0; g < 3; g++) {
          games.push(mkSeriesGame(seriesId, g, year, w + 1, wk, homeId, awayId, 'NON_CONFERENCE'))
        }
      }
    }
  }

  return games
}

/**
 * NWAC schedule builder (rewritten May 2026 per Nate's spec):
 *
 *   - 4-GAME WEEKEND SERIES every week. Friday doubleheader (g0, g1) +
 *     Saturday doubleheader (g2, g3). No midweek games at any time —
 *     NWAC teams travel to a single opponent + play 4 games over Fri/Sat.
 *   - Weeks 1-3: OUT-OF-REGION NWAC opponents (everyone gets 3 cross-
 *     region "preseason" series before conference play starts).
 *   - Weeks 4-13: IN-REGION conference games via circle-method round-
 *     robin. Each team plays every region peer once.
 *   - For undersized regions (NWAC_WEST has 5 teams = 4 conf rounds),
 *     remaining weeks 4-13 fill with cross-region series too. Teams in
 *     larger regions naturally have fewer/zero fill weeks.
 *
 * Per Nate: region champ = conf record. Final 8 bracket lives in
 * pnwPlayoffs — this builder is regular-season only.
 */
function buildNwacSchedule(schools, year, rng) {
  // Group teams by region (their conferenceId).
  const byDiv = {}
  for (const id of Object.keys(schools)) {
    const div = schools[id].conferenceId || 'NWAC_NORTH'
    if (!byDiv[div]) byDiv[div] = []
    byDiv[div].push(id)
  }
  const games = []
  const seasonStartWeek = 27
  const TOTAL_WEEKS = 13      // NAIA/NWAC regular season is 13 spring weeks
  const CROSS_REGION_WEEKS = 3   // first 3 weeks reserved for cross-region

  // Helper — build a 4-game weekend series (Fri DH + Sat DH) between two teams.
  function pushFourGameSeries(seriesId, type, weekIdx, homeId, awayId) {
    const wk = seasonStartWeek + (weekIdx - 1)
    const seasonWeek = weekIdx
    // dayOffset 4 = Fri, 5 = Sat (matches dateForWeek convention used elsewhere).
    const slots = [
      { day: 4, sub: 0, dh: false },   // Fri Game 1
      { day: 4, sub: 1, dh: true },    // Fri Game 2 (DH cap)
      { day: 5, sub: 0, dh: false },   // Sat Game 1
      { day: 5, sub: 1, dh: true },    // Sat Game 2 (DH cap)
    ]
    slots.forEach((s, idx) => {
      games.push({
        id: `${seriesId}_g${idx}`,
        year,
        seasonWeek,
        weekOfYear: wk,
        date: dateForWeek(year, wk, s.day),
        homeId, awayId,
        type,
        seriesId,
        countsTowardRecord: true,
        isDoubleheader: s.dh,
        played: false,
        homeRuns: null, awayRuns: null,
      })
    })
  }

  // Shuffle helper using the seeded rng (deterministic per dynasty).
  function shuffle(arr) {
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }

  // ── Step 1: build per-team week-by-week assignments ─────────────────
  // We assign each team an opponent for each of the 13 weeks. Slots that
  // are still empty after region round-robin scheduling get filled with
  // cross-region opponents.
  const allIds = Object.keys(schools)
  /** week → { teamId → oppId } */
  const weekly = {}
  for (let w = 1; w <= TOTAL_WEEKS; w++) weekly[w] = {}

  // ── Step 2: region round-robin (circle method) for weeks 4-13 ───────
  // Per Nate (May 2026 spec): regions with fewer teams play each conf
  // peer TWICE (home-and-home) so we fill more of the 10 conf-window
  // weeks with region games. NORTH (6 teams) → 5 rounds × 2 = 10 H&H;
  // EAST/SOUTH (8 teams) → 7 single rounds + 3 cross-region fillers.
  function circleMethodRounds(teams) {
    const arr = [...teams]
    if (arr.length < 2) return []
    if (arr.length % 2 === 1) arr.push('__BYE__')
    const n = arr.length
    const rounds = []
    for (let r = 0; r < n - 1; r++) {
      const pairs = []
      for (let i = 0; i < n / 2; i++) {
        const a = arr[i], b = arr[n - 1 - i]
        if (a !== '__BYE__' && b !== '__BYE__') pairs.push([a, b])
      }
      rounds.push(pairs)
      arr.splice(1, 0, arr.pop())
    }
    return rounds
  }
  const playCount = new Map()   // pairKey → count (alternates home/away)
  function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}` }
  const confWeeks = TOTAL_WEEKS - CROSS_REGION_WEEKS    // 10 conf-window weeks

  for (const div of Object.keys(byDiv)) {
    const teams = byDiv[div]
    const baseRounds = circleMethodRounds(teams)
    // Decide how many full round-robin passes fit in the conf window.
    // 6 teams → 5 rounds; 2 passes = 10 weeks (H&H exactly fills the
    // window). 8 teams → 7 rounds; 1 pass leaves 3 weeks for cross-
    // region fillers. Single round-robin for any region whose round
    // count already exceeds confWeeks.
    let passes = 1
    if (baseRounds.length * 2 <= confWeeks) passes = 2
    // (Could extend to 3 passes for 4-team regions if NWAC ever shrinks
    // a division. Not needed today — smallest region is 6 teams.)

    let weekCursor = CROSS_REGION_WEEKS + 1   // first conf-window week (= 4)
    for (let pass = 0; pass < passes; pass++) {
      for (let r = 0; r < baseRounds.length; r++) {
        if (weekCursor > TOTAL_WEEKS) break
        const week = weekCursor++
        for (const [t1, t2] of baseRounds[r]) {
          const pk = pairKey(t1, t2)
          const n = playCount.get(pk) || 0
          playCount.set(pk, n + 1)
          // Alternates home/away across home-and-home rematches.
          const homeId = (n % 2) === 0 ? t1 : t2
          const awayId = (n % 2) === 0 ? t2 : t1
          const seriesId = `${div}_${year}_w${week}_${homeId}_p${pass}`
          pushFourGameSeries(seriesId, 'CONFERENCE', week, homeId, awayId)
          weekly[week][t1] = t2
          weekly[week][t2] = t1
        }
      }
    }
  }

  // ── Step 3: fill cross-region weeks (1-3) + any open weeks 4-13 ───
  // Per Nate: in fill weeks, each team should face a DIFFERENT cross-
  // region opponent — same team shouldn't appear 3 weeks in a row. We
  // track per-team opponent history and prefer never-faced peers.
  /** teamId → Set<opponentId> already faced in cross-region this season */
  const xRegHistory = {}
  for (const id of allIds) xRegHistory[id] = new Set()

  let xRegSeriesIdx = 0
  for (let w = 1; w <= TOTAL_WEEKS; w++) {
    // Shuffle so the pairing order varies year-over-year.
    const unassigned = shuffle(allIds.filter(t => !weekly[w][t]))
    const used = new Set()
    for (const t of unassigned) {
      if (used.has(t)) continue
      const myRegion = schools[t].conferenceId
      // Prefer a cross-region partner the team HASN'T faced yet this
      // season. Fall back to anyone cross-region if all options have
      // been faced already (rare — pool of 22+ teams).
      let partner = unassigned.find(o =>
        o !== t
        && !used.has(o)
        && schools[o].conferenceId !== myRegion
        && !xRegHistory[t].has(o),
      )
      if (!partner) {
        partner = unassigned.find(o =>
          o !== t && !used.has(o) && schools[o].conferenceId !== myRegion,
        )
      }
      if (!partner) continue   // odd one out — sits this week
      used.add(t)
      used.add(partner)
      xRegHistory[t].add(partner)
      xRegHistory[partner].add(t)
      const homeFirst = rng.chance(0.5)
      const homeId = homeFirst ? t : partner
      const awayId = homeFirst ? partner : t
      const seriesId = `NWAC_XREG_${year}_w${w}_${xRegSeriesIdx++}`
      pushFourGameSeries(seriesId, 'NON_CONFERENCE', w, homeId, awayId)
      weekly[w][t] = partner
      weekly[w][partner] = t
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
  // ISN'T the user. PARITY FIX (per Nate): previously sorted by strength desc
  // + walked from the top, so the user ended up playing only top-25 teams.
  // Now we keep the whole D1 universe (~310 teams) and shuffle deterministically
  // so the slate has a mix — couple of marquees, several mid-tier, a couple of
  // weaker programs.
  const allD1 = (nonNaiaRaw.divisions || []).find(d => d.id === 'D1')?.teams || []
  const candidates = allD1.filter(t => t.id !== userSchoolId)
  if (candidates.length === 0) return []
  // Build 3 strength buckets — top quartile, middle half, bottom quartile —
  // and draw a realistic mix. Real-world OSU 2025 had ~25% marquee, ~50% mid,
  // ~25% bottom (e.g. Indiana St. + UC Santa Barbara + Sacramento St.).
  const byStrength = [...candidates].sort((a, b) => (b.strength || 0) - (a.strength || 0))
  const q1 = byStrength.slice(0, Math.floor(byStrength.length * 0.25))    // top
  const q2 = byStrength.slice(Math.floor(byStrength.length * 0.25), Math.floor(byStrength.length * 0.75))   // mid
  const q3 = byStrength.slice(Math.floor(byStrength.length * 0.75))       // bottom
  // Shuffle each bucket via the seeded rng so it's not the same team every yr.
  function shuffle(arr) {
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i--) {
      const j = rng.int(0, i)
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  // Interleave: 1 marquee → 2 mid → 1 bottom → 2 mid → ... so the user gets
  // a believable mix across the season's weekends.
  const sQ1 = shuffle(q1), sQ2 = shuffle(q2), sQ3 = shuffle(q3)
  const pattern = ['Q1', 'Q2', 'Q2', 'Q3', 'Q2', 'Q1', 'Q2', 'Q3', 'Q2', 'Q1', 'Q2', 'Q3', 'Q2']
  const opponents = []
  let i1 = 0, i2 = 0, i3 = 0
  for (const p of pattern) {
    let pick = null
    if (p === 'Q1') pick = sQ1[i1++ % sQ1.length]
    else if (p === 'Q3') pick = sQ3[i3++ % sQ3.length]
    else pick = sQ2[i2++ % sQ2.length]
    if (pick) opponents.push(pick)
  }

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
