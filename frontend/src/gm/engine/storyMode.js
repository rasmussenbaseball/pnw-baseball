/**
 * Story Mode — climb-the-ladder career engine.
 *
 * In REGULAR mode the user is locked to one program. They are the head
 * coach forever; their only loss-condition is "the dynasty stays".
 *
 * STORY mode treats the user like a real human coach with a career arc:
 *   - Start as a low-tier assistant (BENCH_COACH at a bottom-tier NWAC
 *     program by default). The HC of that program is auto-generated.
 *   - Each offseason, get OFFERS from other PNW programs to take roles
 *     ranging from same-level lateral moves up to massive promotions.
 *   - Accept = transition to the new program/role. Decline = stay.
 *   - Performance + tenure drives both offer quality and firing risk.
 *   - GOAL: become a Division I head coach. Tracked on state.career.
 *   - LOSS: get fired and don't accept any offer = career ends.
 *
 * State shape on save (added in this module):
 *   state.career = {
 *     enabled: true,
 *     difficulty: 'EASY'|'NORMAL'|'HARD',
 *     trajectory: [
 *       { year, schoolId, schoolName, level, role, wins, losses,
 *         result: 'started'|'hired'|'promoted'|'fired'|'declined-offers' }
 *     ],
 *     achievements: ['FIRST_PROMOTION', 'FIRST_HC', 'NAIA_HC', 'D2_HC', 'D1_HC', ...],
 *     currentOffers: [
 *       { id, fromSchoolId, fromSchoolName, level, role, salary, signingBonus,
 *         tierGain, expiresAtYear, blurb }
 *     ],
 *     pendingFiring: { year, severance, reason } | null,
 *     goalAchieved: false,
 *     careerEnded: false,
 *   }
 */

import { makeRng } from './rng'
import { computeCoachSalary } from './coaches'

// ─── Role + level career tiering ───────────────────────────────────────────

/**
 * A coach's "career tier" is a numeric ladder rank used by the offer engine
 * to pick realistic next steps. Higher = more prestige.
 *
 *   tier = ROLE_TIER[role] * 100 + LEVEL_TIER[level]
 *
 * That way an HC at D2 (10·100 + 4 = 1004) outranks a recruiting coord at
 * D1 (4·100 + 5 = 405), reflecting that being a top dog at a smaller
 * program is generally more prestigious than being a middle assistant at
 * a bigger one.
 */
const ROLE_TIER = {
  GRADUATE_ASSISTANT: 1,
  BENCH_COACH: 2,
  STRENGTH_CONDITIONING: 2,
  HITTING_COACH: 3,
  PITCHING_COACH: 3,
  RECRUITING_COORDINATOR: 4,
  DATA_ANALYTICS_MANAGER: 4,
  DIRECTOR_OF_OPERATIONS: 4,
  HEAD_COACH: 10,
}

const LEVEL_TIER = {
  NWAC: 1,
  D3:   2,
  NAIA: 3,
  D2:   4,
  D1:   5,
}

const ROLE_LABEL = {
  GRADUATE_ASSISTANT: 'Graduate Assistant',
  BENCH_COACH: 'Bench Coach',
  STRENGTH_CONDITIONING: 'Strength & Conditioning',
  HITTING_COACH: 'Hitting Coach',
  PITCHING_COACH: 'Pitching Coach',
  RECRUITING_COORDINATOR: 'Recruiting Coordinator',
  DATA_ANALYTICS_MANAGER: 'Director of Analytics',
  DIRECTOR_OF_OPERATIONS: 'Director of Operations',
  HEAD_COACH: 'Head Coach',
}

export function careerTier(role, level) {
  return (ROLE_TIER[role] || 1) * 100 + (LEVEL_TIER[level] || 1)
}

export function roleLabel(role) { return ROLE_LABEL[role] || role }

// ─── Difficulty tunings ────────────────────────────────────────────────────

/**
 * Every story-mode lever is difficulty-aware. EASY = forgiving (offers
 * come faster, firings rarely, even bad seasons don't terminate). HARD =
 * realistic. BRUTAL = unforgiving — get one losing season and you're out.
 */
export const DIFFICULTY_TUNING = {
  EASY: {
    baseOffersPerYear: 2.5,
    upgradeOfferChance: 0.55,
    firingThreshold: 8,      // jobSecurity below this fires you
    firingMinTenure: 3,      // years at school before firing eligible
    firstOfferAfterYears: 1,
    startingTierBoost: 1,    // EASY: start as PITCHING_COACH instead of BENCH_COACH
    severanceWeeksOffered: 6,
    label: 'Easy',
    blurb: 'Offers come quickly. Bad seasons are forgiven. Goal feels reachable in ~6 years.',
  },
  NORMAL: {
    baseOffersPerYear: 1.5,
    upgradeOfferChance: 0.35,
    firingThreshold: 15,
    firingMinTenure: 2,
    firstOfferAfterYears: 1,
    startingTierBoost: 0,
    severanceWeeksOffered: 4,
    label: 'Normal',
    blurb: 'Realistic pace. Offers track your performance. ~8-10 year arc to a D1 HC seat.',
  },
  HARD: {
    baseOffersPerYear: 0.9,
    upgradeOfferChance: 0.20,
    firingThreshold: 22,
    firingMinTenure: 1,
    firstOfferAfterYears: 2,
    startingTierBoost: 0,
    severanceWeeksOffered: 2,
    label: 'Hard',
    blurb: 'Coaching is a meat-grinder. Few offers. You will get fired. Expect a 12+ year arc.',
  },
  BRUTAL: {
    baseOffersPerYear: 0.5,
    upgradeOfferChance: 0.10,
    firingThreshold: 30,
    firingMinTenure: 0,
    firstOfferAfterYears: 3,
    startingTierBoost: -1,   // start as GRAD ASSISTANT
    severanceWeeksOffered: 0,
    label: 'Brutal',
    blurb: 'One losing season can end your career. Offers are rare. Reaching D1 is heroic.',
  },
}

export function tuningForDifficulty(d) {
  return DIFFICULTY_TUNING[d] || DIFFICULTY_TUNING.NORMAL
}

// ─── Story-mode bootstrap ──────────────────────────────────────────────────

/**
 * Pick a random STARTING program + role for story mode.
 *
 * Approach: filter to bottom-tier NWAC programs (smallest budgets), then
 * pick one at random. The user is the BENCH_COACH (or PITCHING_COACH on
 * EASY) at that program. The actual HC is an auto-generated coach.
 *
 * Returns { schoolId, level, role, conferenceId } the wizard can hand off.
 *
 * @param {object} nwacSchoolsById  map of all NWAC schools (id keyed)
 * @param {string} difficulty
 * @param {number} seed
 */
export function pickStoryStart(nwacSchoolsById, difficulty, seed) {
  const rng = makeRng('storyStart', seed)
  const tuning = tuningForDifficulty(difficulty)

  // Bottom-tier NWAC pool — smallest budgets, weakest programs.
  // Falls back to ANY NWAC school if the budget data isn't loaded yet.
  const candidates = Object.values(nwacSchoolsById || {})
  const bottomTier = candidates.filter(s => (s.totalAthleticBudget || 0) <= 50_000)
  const pool = bottomTier.length >= 3 ? bottomTier : candidates
  if (pool.length === 0) {
    throw new Error('No NWAC schools available for story-mode start')
  }
  const school = rng.pick(pool)

  // Role: BENCH_COACH default. EASY boosts to PITCHING_COACH; BRUTAL drops
  // to GRADUATE_ASSISTANT.
  let role = 'BENCH_COACH'
  if (tuning.startingTierBoost >= 1) role = 'PITCHING_COACH'
  if (tuning.startingTierBoost <= -1) role = 'GRADUATE_ASSISTANT'

  return {
    schoolId: school.id,
    level: 'NWAC',
    role,
    conferenceId: school.conferenceId || 'NWAC_NORTH',   // engine fallback
  }
}

/** Initial career-state block stored on the save. */
export function buildInitialCareer({ difficulty, schoolName, level, role, year }) {
  return {
    enabled: true,
    difficulty,
    trajectory: [{
      year,
      schoolId: null,    // filled by caller (state.userSchoolId)
      schoolName,
      level,
      role,
      wins: 0,
      losses: 0,
      result: 'started',
    }],
    achievements: [],
    currentOffers: [],
    pendingFiring: null,
    goalAchieved: false,
    careerEnded: false,
    startingRole: role,
    startingLevel: level,
  }
}

// ─── End-of-season hook ────────────────────────────────────────────────────

/**
 * Run the story-mode career review. Called from events.js after the budget
 * review at wk 51-52, only when state.career.enabled is true.
 *
 * Mutates state.career:
 *   - Records this year's W-L to trajectory.
 *   - Fires offer engine: generates 0-3 offers based on performance.
 *   - Fires firing check: if jobSecurity dropped below threshold AND tenure
 *     meets minimum AND coachFiringEnabled is true → flags pendingFiring.
 *
 * Returns { offers, firing } for the news feed.
 */
export function runCareerReview(state) {
  if (!state.career || !state.career.enabled) return null

  const tuning = tuningForDifficulty(state.career.difficulty)
  const team = state.teams[state.userSchoolId]
  const school = state.schools[state.userSchoolId]
  const userCoach = findUserCoach(state)
  if (!team || !school || !userCoach) return null

  const year = state.calendar?.year ?? 2026
  const wins = team._lastSeason?.wins ?? team.wins ?? 0
  const losses = team._lastSeason?.losses ?? team.losses ?? 0
  const gamesPlayed = wins + losses
  const winPct = gamesPlayed > 0 ? wins / gamesPlayed : 0.5
  const level = school.level || state.level || 'NAIA'
  const role = userCoach.role || 'HEAD_COACH'
  const currentTier = careerTier(role, level)

  // Mark this season in the trajectory.
  state.career.trajectory.push({
    year, schoolId: school.id, schoolName: school.name, level, role,
    wins, losses, result: 'completed',
  })

  // ── Firing check ──────────────────────────────────────────────────────
  const yearsAtSchool = countYearsAtSchool(state.career.trajectory, school.id)
  const jobSecurity = state.budget?.jobSecurity ?? 50
  const firingEnabled = state.gameOptions?.coachFiringEnabled !== false
  let firing = null
  if (firingEnabled &&
      yearsAtSchool >= tuning.firingMinTenure &&
      jobSecurity < tuning.firingThreshold) {
    firing = {
      year, severance: tuning.severanceWeeksOffered,
      reason: winPct < 0.35
        ? `Three straight bad seasons (${(winPct * 100).toFixed(0)}% win rate). AD decided to move on.`
        : `Job security collapsed to ${jobSecurity}. ${school.name} is going in a different direction.`,
    }
    state.career.pendingFiring = firing
    state.newsfeed?.unshift({
      id: `fired_${year}`,
      year, week: 51, type: 'AWARD', big: true,
      headline: `FIRED — ${userCoach.firstName} ${userCoach.lastName} let go by ${school.name}.`,
      payload: firing,
    })
  }

  // ── Offer generation ─────────────────────────────────────────────────
  const yearsAsCoach = state.career.trajectory.filter(t => t.result !== 'started').length
  const tooEarly = yearsAsCoach < tuning.firstOfferAfterYears
  // Facility-extension lock-in (FACILITY_UPGRADE_OFFER "sign-extension"
  // choice). If the user signed a 2-year contract extension within the
  // last 2 years, no outside offers come in — they're locked to the
  // school. Per Nate, May 2026 — the lock was previously stamped on
  // state._facilityExtension but never read. Now it actually means
  // something.
  const ext = state._facilityExtension
  const lockedByExtension = ext && (year - (ext.year || 0)) < (ext.years || 2)
  let offers = []
  if (!tooEarly && !lockedByExtension) {
    const rng = makeRng('careerOffers', year, state.rngSeed || 1)
    const careerWinPct = multiYearWinPct(state.career.trajectory)
    offers = generateOffersForYear({
      state, rng,
      currentTier,
      currentRole: role,
      currentLevel: level,
      winPct, careerWinPct,
      tuning, userCoach,
      currentSchoolId: school.id,
      year,
      isFired: !!firing,
    })
  }
  state.career.currentOffers = offers
  if (offers.length > 0) {
    state.newsfeed?.unshift({
      id: `career_offers_${year}`,
      year, week: 51, type: 'AWARD', big: true,
      headline: `${offers.length} coaching offer${offers.length === 1 ? '' : 's'} on the table. Decide before season prep starts.`,
      payload: { offerIds: offers.map(o => o.id) },
    })
  }

  return { offers, firing }
}

function findUserCoach(state) {
  // The user-controlled coach record. ID prefix matches what newDynasty +
  // newDynastyMultiLevel use; in story mode the user might be an assistant
  // rather than HC, so we also fall back to scanning for the user.
  for (const c of Object.values(state.coaches || {})) {
    if (c && c.id && c.id.startsWith('hc_user_')) return c
    if (c && c.isUser) return c
  }
  // Last resort: the team's head coach record
  const team = state.teams?.[state.userSchoolId]
  if (team?.headCoachId) return state.coaches[team.headCoachId]
  return null
}

function countYearsAtSchool(trajectory, schoolId) {
  return trajectory.filter(t => t.schoolId === schoolId && t.result !== 'started').length
}

// ─── Offer generation (tier-matched, performance-aware) ───────────────────
//
// The schools EVALUATE you each offseason and decide if you fit their
// opening. The window of schools you'll hear from is determined by:
//   1. Your career standing (currentTier).
//   2. Your last-season + multi-year track record (winPct + careerWinPct).
//   3. Your coach rating average (the "scout grade" — schools poach
//      higher-rated coaches at higher levels).
//
// The combined attractiveness score lives on [0, 1]:
//   attractiveness = 0.45*lastSeasonWinPct + 0.25*multiYearWinPct
//                  + 0.30*ratingScore (50→1.0 at avg 80)
//
// Maps to a target-tier ceiling:
//   target ceiling = currentTier + ⌊attractiveness * 250⌋ tier-points.
// A 0.0 attractiveness (terrible year, raw coach) → ceiling = currentTier
//   (best you can do is lateral). 1.0 (sweep season, elite coach) →
//   currentTier + 250 (e.g. an NWAC HC can leap up to a D2 HC seat).
//
// The floor — i.e. the WORST offer that comes in — scales the other way:
//   floor = currentTier - ⌊(1-attractiveness) * 150⌋
//   You can be offered a step DOWN if you stunk this year.

const ROLE_LADDER = [
  'GRADUATE_ASSISTANT',
  'BENCH_COACH',
  'STRENGTH_CONDITIONING',
  'HITTING_COACH',
  'PITCHING_COACH',
  'RECRUITING_COORDINATOR',
  'DATA_ANALYTICS_MANAGER',
  'DIRECTOR_OF_OPERATIONS',
  'HEAD_COACH',
]

function clamp01(x) { return Math.max(0, Math.min(1, x)) }

/**
 * Multi-year track record — average win% across the last 3 SEASONS the
 * user actually coached (skips 'started' + 'hired' + 'declined-offers' /
 * 'fired' entries). Returns 0.5 if no games on record yet.
 */
function multiYearWinPct(trajectory) {
  const completed = (trajectory || [])
    .filter(t => t.result === 'completed' && (t.wins || t.losses))
    .slice(-3)
  if (completed.length === 0) return 0.5
  let totalW = 0, totalL = 0
  for (const t of completed) { totalW += t.wins || 0; totalL += t.losses || 0 }
  const games = totalW + totalL
  return games > 0 ? totalW / games : 0.5
}

/**
 * Compute the user's attractiveness score on [0, 1]. Drives how high
 * up the ladder offers can reach this year.
 */
function attractivenessScore(userCoach, lastWinPct, careerWinPct) {
  const ratingAvg = ((userCoach.developer || 60) + (userCoach.motivator || 60) +
                     (userCoach.recruiter || 60) + (userCoach.tactician || 60)) / 4
  const ratingScore = clamp01((ratingAvg - 50) / 30)   // 50→0, 80→1
  return clamp01(
    0.45 * clamp01(lastWinPct) +
    0.25 * clamp01(careerWinPct) +
    0.30 * ratingScore
  )
}

/**
 * Pool of candidate schools whose tier-range INCLUDES the target tier.
 *
 * A school's tier is determined by (best available role at that level)
 * — for the purposes of offer matching we assume a school has openings
 * primarily for HC + the 3 main assistant roles. We compute the set of
 * (school, role) pairs whose careerTier falls within
 * [targetFloor, targetCeiling].
 */
function tierMatchedOffers({ state, currentSchoolId, targetFloor, targetCeiling }) {
  const ROLE_OPTIONS_BY_LEVEL = {
    D1:   ['HEAD_COACH', 'PITCHING_COACH', 'HITTING_COACH', 'RECRUITING_COORDINATOR', 'BENCH_COACH'],
    D2:   ['HEAD_COACH', 'PITCHING_COACH', 'HITTING_COACH', 'BENCH_COACH'],
    D3:   ['HEAD_COACH', 'PITCHING_COACH', 'HITTING_COACH', 'BENCH_COACH'],
    NAIA: ['HEAD_COACH', 'PITCHING_COACH', 'HITTING_COACH', 'BENCH_COACH'],
    NWAC: ['HEAD_COACH', 'BENCH_COACH'],
  }
  const candidates = []
  for (const school of Object.values(state.schools || {})) {
    if (school.id === currentSchoolId) continue
    const lvl = school.level || 'NAIA'
    const roleOptions = ROLE_OPTIONS_BY_LEVEL[lvl] || ROLE_OPTIONS_BY_LEVEL.NAIA
    for (const r of roleOptions) {
      const t = careerTier(r, lvl)
      if (t >= targetFloor && t <= targetCeiling) {
        candidates.push({ school, role: r, tier: t })
      }
    }
  }
  return candidates
}

/**
 * Generate the full slate of offers this offseason. Replaces the old
 * per-iteration generateOffer() — too random, didn't grind enough.
 *
 * Process:
 *   1. Compute attractiveness from last-season + multi-year + rating.
 *   2. Determine number of offers (attractiveness × tuning baseline).
 *   3. Compute [floor, ceiling] tier window.
 *   4. Build a pool of (school, role) candidates inside the window.
 *   5. Weight + sample N unique ones, prioritizing schools where the
 *      user's ratings actually match the role (e.g. high recruiter
 *      rating → boosts recruiting-coordinator offers).
 *
 * Returns an array of offer cards (possibly empty).
 */
function generateOffersForYear({ state, rng, currentTier, currentRole, currentLevel, winPct, careerWinPct, tuning, userCoach, currentSchoolId, year, isFired }) {
  const attract = attractivenessScore(userCoach, winPct, careerWinPct)

  // Number of offers — high attractiveness coaches get more interest,
  // low attractiveness barely get noticed. Fired coaches get a small
  // sympathy bump (people want to scoop a deal).
  const noiseRaw = rng.gaussian(0, 0.5)
  const sympathyBump = isFired ? 1.0 : 0
  const numOffers = Math.max(0, Math.min(4,
    Math.round(tuning.baseOffersPerYear + (attract - 0.4) * 4 + sympathyBump + noiseRaw)
  ))

  // Tier window: ceiling rises with attractiveness; floor drops if you stunk.
  // Promotion ceiling — capped so a 0-32 NWAC bench coach can't get a D1 HC
  // offer just because they have high ratings.
  const ceiling = currentTier + Math.round(attract * 220)
  // If fired, floor drops further (someone needs a body).
  const floor = currentTier - Math.round((1 - attract) * 150) - (isFired ? 75 : 0)

  if (numOffers === 0) return []

  // Build candidate pool inside the window.
  const pool = tierMatchedOffers({ state, currentSchoolId, targetFloor: floor, targetCeiling: ceiling })
  if (pool.length === 0) return []

  // Rank candidates by FIT to the user's coach skills + a small random
  // jitter, so the top schools are more likely to come calling.
  for (const c of pool) {
    c.fitScore = roleFitScore(userCoach, c.role) + rng.gaussian(0, 0.15)
  }
  pool.sort((a, b) => b.fitScore - a.fitScore)

  // Draw N unique school+role pairs from the top of the pool, biasing
  // toward better-fit schools. We pull from the top 3*numOffers slots.
  const used = new Set()
  const offers = []
  const draftWindow = pool.slice(0, Math.max(numOffers * 3, 6))
  while (offers.length < numOffers && draftWindow.length > 0) {
    const idx = Math.floor(rng.next() * Math.min(draftWindow.length, 5))
    const pick = draftWindow.splice(idx, 1)[0]
    if (!pick) continue
    const key = pick.school.id + ':' + pick.role
    if (used.has(key)) continue
    used.add(key)
    offers.push(buildOfferCard(pick, currentTier, userCoach, year, rng))
  }
  return offers
}

/**
 * Score how well the user's ratings match a target role. Higher = better fit.
 * Drives which schools actually call you about openings.
 */
function roleFitScore(c, role) {
  const dev = c.developer || 60
  const mot = c.motivator || 60
  const rec = c.recruiter || 60
  const tac = c.tactician || 60
  switch (role) {
    case 'HEAD_COACH':                return (dev + mot + rec + tac) / 4 / 100
    case 'PITCHING_COACH':            return (dev * 0.7 + tac * 0.3) / 100
    case 'HITTING_COACH':             return (dev * 0.7 + tac * 0.3) / 100
    case 'BENCH_COACH':               return (mot * 0.5 + tac * 0.5) / 100
    case 'RECRUITING_COORDINATOR':    return (rec * 0.8 + mot * 0.2) / 100
    case 'DATA_ANALYTICS_MANAGER':    return (tac * 0.7 + dev * 0.3) / 100
    case 'DIRECTOR_OF_OPERATIONS':    return (mot * 0.5 + tac * 0.5) / 100
    case 'STRENGTH_CONDITIONING':     return (dev * 0.8 + mot * 0.2) / 100
    case 'GRADUATE_ASSISTANT':        return (dev * 0.5 + mot * 0.5) / 100
    default:                          return 0.6
  }
}

function buildOfferCard(pick, currentTier, userCoach, year, rng) {
  const { school, role, tier } = pick
  const qualityAvg = ((userCoach.developer || 60) + (userCoach.motivator || 60) +
                      (userCoach.recruiter || 60) + (userCoach.tactician || 60)) / 4
  const salary = computeCoachSalary(school.resourceTier || 'MID', role, qualityAvg) || 50_000
  const signingBonus = Math.round(salary * (rng.next() * 0.15))
  const tierGain = tier - currentTier
  const lvl = school.level || 'NAIA'
  const isUpgrade = tierGain > 0
  const isStepDown = tierGain < 0
  const blurb = isUpgrade
    ? `${school.name} (${lvl}) wants you for ${roleLabel(role)}. Real step up from where you are.`
    : isStepDown
      ? `${school.name} (${lvl}) needs a ${roleLabel(role)}. Not glamorous, but a job is a job.`
      : `${school.name} (${lvl}) wants you for ${roleLabel(role)}. Lateral, but a fresh start.`
  return {
    id: `offer_${year}_${school.id}_${role}_${rng.next().toString(36).slice(2, 7)}`,
    fromSchoolId: school.id,
    fromSchoolName: school.name,
    level: lvl,
    role,
    salary, signingBonus,
    tierGain,
    expiresAtYear: year + 1,
    blurb,
  }
}

// ─── Offer acceptance ──────────────────────────────────────────────────────

/**
 * Accept an offer — transition the user to the new school/role.
 *
 * Implementation:
 *   1. Find the offer on state.career.currentOffers.
 *   2. Remove the user's old coach record from the old team's staff list.
 *   3. Add a new coach record for the user at the new school with the new
 *      role + salary. ID stays stable ('hc_user_<schoolId>') for save
 *      lookup convenience.
 *   4. Update state.userSchoolId to the new program.
 *   5. Append a trajectory entry with result='hired'.
 *   6. Clear pendingFiring + currentOffers.
 *   7. Reset jobSecurity to 50 (fresh start at new school).
 *   8. Check if this completes the D1 HC goal achievement.
 */
export function acceptCareerOffer(state, offerId) {
  if (!state.career) return { ok: false, error: 'Career mode not active.' }
  const offer = state.career.currentOffers.find(o => o.id === offerId)
  if (!offer) return { ok: false, error: 'Offer not found.' }

  const year = state.calendar?.year ?? 2026
  const oldUserCoach = findUserCoach(state)
  const oldSchoolId = state.userSchoolId
  const oldTeam = state.teams?.[oldSchoolId]

  // Detach from old team
  if (oldTeam && oldUserCoach) {
    oldTeam.assistantCoachIds = (oldTeam.assistantCoachIds || []).filter(id => id !== oldUserCoach.id)
    if (oldTeam.headCoachId === oldUserCoach.id) oldTeam.headCoachId = null
    delete state.coaches[oldUserCoach.id]
  }

  // Attach to new school. New ID + new role + new salary.
  const newSchool = state.schools?.[offer.fromSchoolId]
  if (!newSchool) return { ok: false, error: 'New school not found.' }
  const newCoachId = `hc_user_${offer.fromSchoolId}`
  /** @type {any} */
  const newCoach = {
    ...(oldUserCoach || {}),
    id: newCoachId,
    schoolId: offer.fromSchoolId,
    role: offer.role,
    salary: offer.salary,
    yearsAtSchool: 0,
    yearsInRole: 0,
    contractYearsRemaining: offer.role === 'HEAD_COACH' ? 4 : 3,
    isUser: true,
  }
  state.coaches[newCoachId] = newCoach

  // Wire into new team
  const newTeam = state.teams?.[offer.fromSchoolId]
  if (newTeam) {
    if (offer.role === 'HEAD_COACH') newTeam.headCoachId = newCoachId
    else {
      newTeam.assistantCoachIds = newTeam.assistantCoachIds || []
      if (!newTeam.assistantCoachIds.includes(newCoachId)) {
        newTeam.assistantCoachIds.push(newCoachId)
      }
    }
  }

  state.userSchoolId = offer.fromSchoolId
  // Some downstream code reads state.level — keep it in sync.
  state.level = newSchool.level || state.level

  // Friend report (June 2026): switching teams in story mode landed on
  // a school with 0 players. We can't call refillThinRosters here
  // because events.js already imports this file (circular dep). Instead,
  // reset the Dashboard self-heal's per-year flag so its roster-refill
  // useEffect re-fires on next Dashboard mount — which happens on the
  // very next navigation after the offer is accepted.
  if (state.flags) {
    delete state.flags.lastRosterRefillYear
    delete state.flags.lastOvrRefitYear
  }

  // Bookkeeping
  state.career.trajectory.push({
    year, schoolId: offer.fromSchoolId, schoolName: offer.fromSchoolName,
    level: offer.level, role: offer.role,
    wins: 0, losses: 0, result: 'hired',
  })
  state.career.currentOffers = []
  state.career.pendingFiring = null
  if (state.budget) state.budget.jobSecurity = 50

  // Achievement checks
  const ach = state.career.achievements
  if (!ach.includes('FIRST_PROMOTION')) ach.push('FIRST_PROMOTION')
  if (offer.role === 'HEAD_COACH') {
    if (!ach.includes('FIRST_HC')) ach.push('FIRST_HC')
    if (offer.level === 'NAIA' && !ach.includes('NAIA_HC')) ach.push('NAIA_HC')
    if (offer.level === 'D2' && !ach.includes('D2_HC')) ach.push('D2_HC')
    if (offer.level === 'D3' && !ach.includes('D3_HC')) ach.push('D3_HC')
    if (offer.level === 'D1') {
      if (!ach.includes('D1_HC')) ach.push('D1_HC')
      state.career.goalAchieved = true
    }
  }

  state.newsfeed?.unshift({
    id: `offer_accept_${year}_${offer.fromSchoolId}`,
    year, week: 52, type: 'AWARD', big: true,
    headline: `Hired as ${roleLabel(offer.role)} at ${offer.fromSchoolName} (${offer.level}).`,
    payload: { offerId, salary: offer.salary },
  })

  return { ok: true, schoolId: offer.fromSchoolId }
}

/**
 * Decline ALL current offers — stay where you are. Clears the offer slate.
 * If you were also pending-firing, this triggers the careerEnded state.
 */
export function declineAllCareerOffers(state) {
  if (!state.career) return { ok: false }
  const fired = !!state.career.pendingFiring
  state.career.currentOffers = []
  if (fired) {
    state.career.careerEnded = true
    state.career.pendingFiring = null
    state.newsfeed?.unshift({
      id: `career_ended_${state.calendar?.year}`,
      year: state.calendar?.year, week: 52, type: 'AWARD', big: true,
      headline: `Career ended. Without a new program, ${findUserCoach(state)?.firstName || 'Coach'}'s coaching career is over.`,
      payload: {},
    })
  } else {
    state.career.trajectory.push({
      year: state.calendar?.year, schoolId: state.userSchoolId,
      schoolName: state.schools?.[state.userSchoolId]?.name,
      level: state.schools?.[state.userSchoolId]?.level,
      role: findUserCoach(state)?.role,
      wins: 0, losses: 0, result: 'declined-offers',
    })
  }
  return { ok: true, careerEnded: state.career.careerEnded }
}
