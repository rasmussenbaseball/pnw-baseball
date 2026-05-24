/**
 * Annual events engine.
 *
 * Real college baseball has things happen on specific dates — the MLB draft
 * is mid-July, the transfer portal opens after the season, fall scrimmages
 * are October Fridays, etc. Rather than
 * cramming all of that into a single end-of-year synchronous tick (which
 * locks the browser for 5–15 seconds), this module:
 *
 *   1. Defines the full year's event calendar (offseason + season)
 *   2. Queues deferred end-of-year work onto specific offseason weeks
 *   3. Provides a runner that fires whatever's due on this tick
 *   4. Powers the visual /gm/calendar page so users can see what's coming
 *
 * Heavy work runs ONE phase per week, distributed across early offseason.
 * No tick should ever block longer than ~500ms.
 */

import { runEndOfTermAcademics } from './academics'
import { annualReview, lockTravelAllocation, extendedBudgetEffects } from './budget'
import { seedFromPear } from './rankings'
import { runCareerReview } from './storyMode'
import { runOutboundTransfers } from './outboundTransfers'
import { applyHsAttrition, generatePortalPool, academicRatingToGpa } from './recruits'
import { simMlbDraft, summarizeDraft } from './draft'
import { endOfSeasonDevelopment, tickPotentialEOY, tickWeightFluctuation } from './development'
import { generatePlayer } from './generate'
import { expectedTeamOvr } from './programRating'
import { hitterOverall, pitcherOverall } from './playerRating'
import { makeRng } from './rng'
import { budgetCategoryEffects } from './budget'
import { totalAnnualTravelCost } from './travel'
import { closePlanningWindow, resolveSummerBall, ensureSummerBallState } from './summerBall'
import { ensureCutsState } from './cuts'
import { awardForEndOfYearHonors } from './coachProgression'
import { assignNwacTransferDestinations } from './nwacTransfers'
import nonNaiaRaw from '../data/non_naia_teams.json'

const NON_NAIA_LOOKUP = (() => {
  const out = {}
  for (const div of nonNaiaRaw.divisions) {
    for (const t of div.teams) out[t.id] = { ...t, division: div.id }
  }
  return out
})()

// ─── Event types ───────────────────────────────────────────────────────────

export const EVENT_TYPES = {
  // Deferred end-of-year work
  PLAYER_DEVELOPMENT:       { label: 'Summer Check-In', desc: 'Big EOY dev pass + potential drift. Combines class year, performance, coach, budget. Pairs with the in-season weekly dev that ran during the spring — half of yearly growth comes from each.' },
  BUDGET_REVIEW:            { label: 'Annual budget review', desc: 'AD reviews finances and adjusts your budget.' },
  END_OF_TERM_ACADEMICS:    { label: 'Spring term GPAs', desc: 'Spring semester grades posted, eligibility updated.' },
  MLB_DRAFT:                { label: 'MLB Draft', desc: '5–12 NAIA players selected over 20 rounds.' },
  HS_ATTRITION:             { label: 'HS class shakeup', desc: 'Some HS prospects commit elsewhere or drop out.' },
  PORTAL_OPEN:              { label: 'Transfer portal opens', desc: 'New transfer prospects appear on the board.' },
  OUTBOUND_TRANSFERS_MID:   { label: 'Outbound transfers (early)', desc: 'Disgruntled stars + bench players hit the portal.' },
  OUTBOUND_TRANSFERS_LATE:  { label: 'Outbound transfers (late)', desc: 'Final wave of portal departures.' },
  // Calendar markers (don't fire engine work, just shown on calendar)
  SET_SCHEDULE:             { label: 'Schedule deadline', desc: 'Lock in your non-conference schedule for next season.' },
  FALL_CAMP_START:          { label: 'Fall Camp opens', desc: 'Scrimmage Fridays in October — set lineups in Play.' },
  FALL_SCRIM_FRIDAY:        { label: 'Fall scrimmage', desc: 'Doubleheader vs a nearby school.' },
  TRAINING_PERIOD:          { label: 'Training Period', desc: 'No games — focused skill / position work.' },
  HS_NLI_EARLY:             { label: 'HS NLI early signing', desc: 'Top recruits start locking in commitments.' },
  DEAD_PERIOD:              { label: 'Dead Period (Dec)', desc: 'Recruiting contact restricted.' },
  SPRING_PRACTICE:          { label: 'Spring Practice', desc: 'Pre-season ramp-up.' },
  SEASON_OPEN:              { label: 'Opening Day', desc: 'Non-conference season begins.' },
  CONF_OPEN:                { label: 'Conference opens', desc: 'CCC play starts — Friday-Saturday-Sunday series.' },
  REG_SEASON_END:           { label: 'Regular season ends', desc: 'Last conference series; standings finalize.' },
  CONF_TOURNAMENT:          { label: 'Conference tournament', desc: 'Double-elimination bracket. Winner gets the auto-bid.' },
  OPENING_ROUND:            { label: 'NAIA Opening Round', desc: 'Regional brackets — 4-team double-elim.' },
  WORLD_SERIES:             { label: 'NAIA World Series', desc: 'Avista NAIA WS in Lewiston, ID.' },
  LAST_DAY_RECRUITING:      { label: 'Late recruiting closes', desc: 'Final HS commitments locked for this cycle.' },
  CLASS_FINALIZE:           { label: 'Class finalizes', desc: 'Signed recruits officially join the roster — ratings fully revealed.' },
  LOCK_TRAVEL_BUDGET:       { label: 'Travel budget locks', desc: 'Travel allocation set from your scheduled trips. Adjust other categories from here.' },
  SUMMER_BALL_PLANNING:     { label: 'Summer ball planning', desc: 'Decide who you\'ll send to summer leagues next summer. Final roster confirms after the season.' },
  SUMMER_BALL_CONFIRM:      { label: 'Summer ball confirm', desc: 'Lock in (or pull) your summer ball roster. You can REMOVE players but cannot add new ones now.' },
  SUMMER_BALL_RESOLVE:      { label: 'Summer ball wraps', desc: 'Mid-summer recap — dev gains, injuries, poach interest, draft buzz from every league.' },
  CUTS_WINDOW_OPENS:        { label: 'Cuts window opens', desc: 'Your AD has approved your roster cuts for the year. Use them within the offseason.' },
}

// ─── Event schedule — unified 52-week ──────────────────────────────────────
//
// Map weekOfYear which events fire that week. Heavy end-of-year work was
// previously crammed into a single tick; it's now distributed across the
// post-postseason offseason (wks 43-51).

export const WEEK_EVENT_SCHEDULE = {
  // ── Tutorial weeks (Aug 1-29) ──
  1: ['SET_SCHEDULE'],
  2: [],                                          // hiring is a UI requirement, no engine event
  3: ['LOCK_TRAVEL_BUDGET'],                      // travel cost locked from schedule
  4: [],                                          // scouting opens — AP unlocks, no engine event
  // ── Fall Camp (Sep-Oct, wks 5-12) ──
  5: ['FALL_CAMP_START'],
  // ── November turn (wk 13) ──
  13: ['HS_NLI_EARLY'],
  // ── December turn (wk 18) — summer ball planning opens here. (Wks 14-17
  // fold into the November turn, so this moved off wk 14 to a real turn.) ──
  18: ['SUMMER_BALL_PLANNING'],
  23: ['SPRING_PRACTICE'],
  // ── Season (wks 27-39) ──
  27: ['SEASON_OPEN'],
  30: ['CONF_OPEN'],
  39: ['REG_SEASON_END'],
  // ── Postseason (wks 40-42) — engine runs from advanceOneWeek hook ──
  40: ['CONF_TOURNAMENT'],
  41: ['OPENING_ROUND'],
  42: ['WORLD_SERIES'],
  // ── Post-postseason offseason (wks 43-52) — heavy work distributed ──
  43: ['PORTAL_OPEN', 'OUTBOUND_TRANSFERS_MID', 'END_OF_TERM_ACADEMICS',
       'SUMMER_BALL_CONFIRM', 'CUTS_WINDOW_OPENS'],
  44: ['PLAYER_DEVELOPMENT'],
  45: ['HS_ATTRITION'],
  46: ['BUDGET_REVIEW'],
  47: ['SUMMER_BALL_RESOLVE'],                    // mid-summer wrap
  48: ['MLB_DRAFT'],                              // early July
  51: ['CAREER_REVIEW'],                          // story-mode firing + offers
  52: ['LAST_DAY_RECRUITING', 'CLASS_FINALIZE'],  // recruits join roster
}

// ─── Back-compat exports (old code reads these) ────────────────────────────
// Kept as derived views over WEEK_EVENT_SCHEDULE so the calendar page + any
// stragglers keep working without churn.
export const OFFSEASON_EVENT_SCHEDULE = (() => {
  const out = {}
  for (const [wk, events] of Object.entries(WEEK_EVENT_SCHEDULE)) {
    const w = Number(wk)
    if (w >= 27 && w <= 42) continue
    // Map wk legacy offseason week (1-26 direct; 43-52 27-36)
    const offWk = w <= 26 ? w : 26 + (w - 42)
    out[offWk] = events
  }
  return out
})()
export const SEASON_EVENT_SCHEDULE = (() => {
  const out = {}
  for (const [wk, events] of Object.entries(WEEK_EVENT_SCHEDULE)) {
    const w = Number(wk)
    if (w < 27 || w > 42) continue
    out[w - 26] = events
  }
  return out
})()

// Markers — purely calendar-display, no engine action.
const MARKER_ONLY = new Set([
  'SET_SCHEDULE', 'FALL_CAMP_START', 'FALL_SCRIM_FRIDAY', 'TRAINING_PERIOD',
  'HS_NLI_EARLY', 'DEAD_PERIOD', 'SPRING_PRACTICE',
  'SEASON_OPEN', 'CONF_OPEN', 'REG_SEASON_END', 'CONF_TOURNAMENT',
  'OPENING_ROUND', 'WORLD_SERIES', 'LAST_DAY_RECRUITING',
  'SUMMER_BALL_PLANNING',
])

// ─── Event runners ─────────────────────────────────────────────────────────

/**
 * Run a single event on the given save state. Mutates state. Returns a
 * { label, news } record so callers can surface what just happened.
 */
export function runEvent(state, eventKey) {
  if (MARKER_ONLY.has(eventKey)) return { label: EVENT_TYPES[eventKey]?.label, news: null }

  switch (eventKey) {
    case 'BUDGET_REVIEW':            return runBudgetReview(state)
    case 'CAREER_REVIEW':            return runStoryCareerReview(state)
    case 'END_OF_TERM_ACADEMICS':    return runAcademics(state)
    case 'PLAYER_DEVELOPMENT':       return runDevelopment(state)
    case 'MLB_DRAFT':                return runDraft(state)
    case 'HS_ATTRITION':             return runHsAttrition(state)
    case 'PORTAL_OPEN':              return runPortalOpen(state)
    case 'OUTBOUND_TRANSFERS_MID':   return runOutbound(state, 'MID_OFFSEASON')
    case 'OUTBOUND_TRANSFERS_LATE':  return runOutbound(state, 'LATE_OFFSEASON')
    case 'CLASS_FINALIZE':           return runClassFinalize(state)
    case 'LOCK_TRAVEL_BUDGET':       return runLockTravelBudget(state)
    case 'SUMMER_BALL_CONFIRM':      return runSummerBallConfirm(state)
    case 'SUMMER_BALL_RESOLVE':      return runSummerBallResolve(state)
    case 'CUTS_WINDOW_OPENS':        return runCutsWindowOpens(state)
    default:                         return null
  }
}

/**
 * Wk 43 — close planning window for summer ball (no more new sign-ups).
 * User still has this week + onward to REMOVE players who shouldn't go.
 */
function runSummerBallConfirm(state) {
  closePlanningWindow(state)
  const confirmed = Object.values(state.summerBall?.assignments || {})
    .filter(a => a.confirmed && !a.removed).length
  state.newsfeed.unshift({
    id: `sb_confirm_${state.calendar.year}`,
    year: state.calendar.year, week: 43, type: 'AWARD',
    headline: `Summer ball roster confirmed (${confirmed} player${confirmed === 1 ? '' : 's'}). You can still REMOVE players, but no new signings.`,
    payload: {},
  })
  return { label: 'Summer ball confirmed', news: { confirmed } }
}

/**
 * Wk 47 — mid-summer leagues wrap. Apply dev / injury / poach / draft buzz.
 */
function runSummerBallResolve(state) {
  const news = resolveSummerBall(state)
  for (const n of news) {
    state.newsfeed.unshift(n)
  }
  return { label: 'Summer ball results', news }
}

/**
 * Wk 43 (or earlier for non-postseason teams) — cuts window opens. Just sets
 * up state.cuts so the dashboard / roster page can surface it.
 */
function runCutsWindowOpens(state) {
  ensureCutsState(state)
  const allowed = state.cuts?.allowed ?? 0
  state.newsfeed.unshift({
    id: `cuts_open_${state.calendar.year}`,
    year: state.calendar.year, week: state.calendar.weekOfYear || 43, type: 'AWARD',
    headline: allowed > 0
      ? `Cuts window open — your AD allows ${allowed} roster cut${allowed === 1 ? '' : 's'} this offseason.`
      : `No cuts this offseason — AD wants to see more wins before approving roster moves.`,
    payload: { allowed },
  })
  return { label: 'Cuts window opens', news: { allowed } }
}

/**
 * Wk 3 event — locks the travel budget allocation from the actual scheduled
 * games' travel costs. After this, the Budget UI shows travel as locked.
 */
function runLockTravelBudget(state) {
  if (!state.budget) return { label: 'No budget' }
  if (!state.schedule || state.schedule.length === 0) {
    return { label: 'No schedule yet — travel not locked' }
  }
  // totalAnnualTravelCost returns a plain number (not an object)
  const travelDollars = totalAnnualTravelCost(
    state.userSchoolId, state.schedule, state.schools, NON_NAIA_LOOKUP,
  ) || 0
  state.budget = lockTravelAllocation(state.budget, travelDollars)
  state.newsfeed.unshift({
    id: `lock_travel_${state.calendar.year}`,
    year: state.calendar.year, week: 3, type: 'AWARD',
    headline: `Travel budget locked at $${(travelDollars / 1000).toFixed(1)}K based on your scheduled trips.`,
    payload: { travelDollars },
  })
  return { label: 'Travel locked', news: { travelDollars } }
}

/**
 * Class finalization (Wk 52): every recruit marked as "signed" with the
 * user's program officially joins the active roster as a freshman, with
 * ratings fully revealed (scout fog cleared).
 */
function runClassFinalize(state) {
  if (!state.recruits) return { label: 'No recruits to finalize' }
  const userId = state.userSchoolId
  const team = state.teams[userId]
  if (!team) return { label: 'No user team' }
  let added = 0
  // Every signed recruit joins the active roster, even if doing so puts the
  // team over the 50-player cap. The user then has to make the cut-down
  // decisions in a phase-gate before advancing to the new year. This was
  // changed (May 2026) so coaches choose WHO gets cut — auto-dropping the
  // user's late signees was bad UX.
  const ROSTER_CAP = 50
  for (const r of Object.values(state.recruits)) {
    if (r.status !== 'signed' || r.signedTo !== userId) continue
    if (r.joinedAt && r.joinedAt === state.calendar.year) continue
    if (!state.players[r.id]) {
      state.players[r.id] = recruitToPlayer(r, state.calendar?.year, userId)
    }
    // Stamp signedAt so the year-rollover class-advance step knows to
    // SKIP this player (they're brand-new — they keep FR for the year
    // about to start instead of being bumped to SO immediately).
    state.players[r.id].signedAt = state.calendar.year
    if (!team.rosterPlayerIds.includes(r.id)) team.rosterPlayerIds.push(r.id)
    r.joinedAt = state.calendar.year
    r.scoutFogCleared = true
    added++
  }
  // If the combined roster (returners + new signees) is over the cap, flag
  // mandatory cuts AND hit job security. The AD is unhappy you didn't manage
  // your numbers; the user must cut down before the year rolls.
  const overflow = Math.max(0, team.rosterPlayerIds.length - ROSTER_CAP)
  if (overflow > 0) {
    state.mandatoryCuts = {
      needed: overflow,
      year: state.calendar.year,
      rosterAtFlag: team.rosterPlayerIds.length,
      overByAtFlag: overflow,
    }
    // Job security hit: -3 per overage player. Over-recruit by 5 -15 JS.
    const jsHit = overflow * 3
    if (state.budget) {
      state.budget.jobSecurity = Math.max(0, (state.budget.jobSecurity || 50) - jsHit)
    }
    state.newsfeed.unshift({
      id: `over_cap_${state.calendar.year}`,
      year: state.calendar.year, week: 52, type: 'AWARD',
      headline: `Over roster cap by ${overflow} player${overflow === 1 ? '' : 's'}. AD has docked you ${jsHit} job security. Cut down to 50 before the season rolls.`,
      payload: { overflow, jsHit },
      big: true,
    })
  }
  state.newsfeed.unshift({
    id: `class_finalize_${state.calendar.year}`,
    year: state.calendar.year, week: 52, type: 'AWARD',
    headline: `${added} signed recruit${added === 1 ? '' : 's'} joined the roster. Full ratings revealed.`,
    payload: {}, big: added > 0,
  })
  return { label: 'Class finalized', news: { added } }
}

/** Shape a Recruit into a Player. Inherits ratings + bio; resets stats. */
function recruitToPlayer(r, year, schoolId = null) {
  // GPA carryover: recruits hold their high-school grades as `academicRating`
  // (30-99 integer). Convert to a real 0-4.0 GPA via academicRatingToGpa so
  // the player keeps their HS GPA from the moment they sign — no more
  // everyone-starts-at-3.0 reset bug. Falls back to direct r.gpa if a
  // future code path sets it explicitly.
  const gpa = r.gpa != null
    ? r.gpa
    : (r.academicRating != null ? academicRatingToGpa(r.academicRating) : 3.0)
  // CRITICAL: recruits store ratings under trueHitter/truePitcher/
  // truePotentialHitter/truePotentialPitcher — NOT hitter/pitcher/hidden like
  // generated players. The old code read r.hitter (undefined), producing a
  // hitter with `hitter: null` + `isHitter: true`, which white-screened the
  // Roster page (`p.hitter.contact_l`) the first time a class enrolled in
  // season 2. Map the real fields and rebuild a full hidden block.
  const hitter = r.trueHitter || null
  const pitcher = r.truePitcher || null
  const hidden = {
    potential_hitter: r.truePotentialHitter || hitter,
    potential_pitcher: r.truePotentialPitcher || pitcher,
    // Recruits don't carry these hidden personality ratings; seed believable
    // defaults (downstream reads all guard with `?? <default>`).
    work_ethic: r.hidden?.work_ethic ?? 60,
    clutch: r.hidden?.clutch ?? 50,
    injury_prone: r.hidden?.injury_prone ?? 50,
    loyalty: r.hidden?.loyalty ?? 65,
    academic_aptitude: r.academicRating ?? 70,
    archetype: r.archetypeKey ?? null,
    bodyFrame: r.bodyFrameKey ?? null,
    quirks: [...(r.visibleQuirks || []), ...(r.hiddenQuirks || [])],
    reverseSplit: !!r.reverseSplit,
  }
  // FR birthdate — ~18-19 years old. Spring season `year` means they enroll
  // the prior fall, so born ~year-19. Stored ISO-style like generated players.
  const birthYear = (year || new Date().getFullYear()) - 19
  return {
    id: r.id,
    firstName: r.firstName, lastName: r.lastName,
    birthDate: `${birthYear}-08-15`,
    bats: r.bats, throws: r.throws,
    primaryPosition: r.primaryPosition,
    positions: r.positions || [r.primaryPosition],
    classYear: 'FR',
    seasonsUsed: 0,
    semestersUsed: 0,
    redshirtUsed: false,
    hometown: r.hometown,
    schoolId,
    previousSchoolName: r.previousSchoolName ?? null,
    previousLeagueId: r.previousLeagueId ?? null,
    isHitter: !r.isPitcher,
    isPitcher: !!r.isPitcher,
    hitter,
    pitcher,
    hidden,
    measurables: r.measurables || null,
    archetypeKey: r.archetypeKey ?? null,
    bodyFrameKey: r.bodyFrameKey ?? null,
    injury: null,
    gpa,
    academicRating: r.academicRating ?? null,   // keep raw 30-99 around for future academic events
    academicStanding: 'eligible',
    eligibilityStatus: 'eligible',
    scholarship: { annualAmount: r.liveOffer?.amount ?? r.scholarshipOffered ?? 0, yearsCommitted: 4 },
    happiness: { value: 65, lastWeek: 65 },   // fresh recruits start happy
  }
}

/**
 * Run all events scheduled for the given week (1-52). Caller should already
 * have advanced the calendar.
 */
export function runEventsForWeek(state, weekOfYear) {
  const events = WEEK_EVENT_SCHEDULE[weekOfYear] || []
  const ran = []
  for (const key of events) {
    const result = runEvent(state, key)
    if (result) ran.push({ key, ...result })
  }
  return ran
}

/** Back-compat — old callers used the offseason-week variant. */
export function runEventsForOffseasonWeek(state, offseasonWeek) {
  return runEventsForWeek(state, offseasonWeek)
}

// ─── Individual event implementations ──────────────────────────────────────

function runStoryCareerReview(state) {
  // Only fires when story mode is enabled — regular dynasties never see
  // career offers or firings beyond the existing budget-driven JS hits.
  if (!state.career || !state.career.enabled) {
    return { label: 'Career review skipped (regular mode)', news: null }
  }
  const result = runCareerReview(state)
  return {
    label: 'Career review',
    news: result,
  }
}

function runBudgetReview(state) {
  const userTeam = state.teams[state.userSchoolId]
  // Expectations: PRESEASON rank (PEAR program strength) vs how the season
  // actually FINISHED (live NWBB national rank). Drives the AD's judgment so a
  // preseason favorite that flops loses job security even with a winning record.
  let expectedRank = null
  try {
    const pear = seedFromPear(state.schools, state.conferences)
    const order = Object.values(pear).sort((a, b) => (b.overall_rating ?? 0) - (a.overall_rating ?? 0))
    const idx = order.findIndex(r => r.schoolId === state.userSchoolId)
    if (idx >= 0) expectedRank = idx + 1
  } catch (e) { /* ignore — expectation term just won't apply */ }
  const actualRank = state.nwbbRatings?.[state.userSchoolId]?.nationalRank || null
  const seasonResult = {
    wins: userTeam._lastSeason?.wins ?? userTeam.wins,
    losses: userTeam._lastSeason?.losses ?? userTeam.losses,
    confChampion: state.postseason?.userChamp || false,
    postseasonAppearance: state.postseason?.userQualified || false,
    expectedRank,
    actualRank,
  }
  const reviewResult = annualReview(state.budget, seasonResult)
  state.budget = reviewResult.newBudget
  for (const msg of reviewResult.news) {
    state.newsfeed.unshift({
      id: `review_${state.calendar.year}_${Math.random().toString(36).slice(2, 6)}`,
      year: state.calendar.year, week: 1, type: 'AWARD', headline: msg, payload: {},
    })
  }
  return { label: 'Budget review', news: reviewResult.news }
}

function runAcademics(state) {
  const result = runEndOfTermAcademics(state)
  if (result?.summary && result.summary.teamGpa < 2.5 && state.budget) {
    const penalty = Math.round((2.5 - result.summary.teamGpa) * 12)
    state.budget.jobSecurity = Math.max(0, (state.budget.jobSecurity || 50) - penalty)
    state.newsfeed.unshift({
      id: `acad_pen_${state.calendar.year}`,
      year: state.calendar.year, week: 1, type: 'AWARD',
      headline: `Team GPA of ${result.summary.teamGpa.toFixed(2)} below 2.5 — job security ${penalty} pts.`,
      payload: {},
    })
  }
  return { label: 'Spring GPAs posted' }
}

function runDevelopment(state) {
  const userTeam = state.teams[state.userSchoolId]
  const hc = state.coaches[userTeam.headCoachId]
  const coachDeveloper = hc?.developer ?? 55
  // Use extended effects so facilities devMultiplier actually drives
  // per-player gains. Falls back to base effects shape for any code path
  // that doesn't read the extended fields yet.
  const budgetEffects = extendedBudgetEffects(state.budget)
  const playerIds = userTeam.rosterPlayerIds
  const players = playerIds.map(id => state.players[id]).filter(Boolean)
  const hitters = players.filter(p => p.isHitter).sort((a, b) => (b.hitter.contact_r || 0) - (a.hitter.contact_r || 0))
  const pitchers = players.filter(p => p.isPitcher).sort((a, b) => (b.pitcher.stuff || 0) - (a.pitcher.stuff || 0))
  const top9 = new Set(hitters.slice(0, 9).map(p => p.id))
  const top5p = new Set(pitchers.slice(0, 5).map(p => p.id))
  const devReport = []
  for (const id of playerIds) {
    const p = state.players[id]
    if (!p) continue
    const statsKey = p.isPitcher ? `p_${id}` : `b_${id}`
    const seasonStats = state.playerStats?.[statsKey] ?? state._archivedPlayerStats?.[statsKey]
    const paShare = top9.has(id) ? 0.8 : 0.2
    const ipShare = top5p.has(id) ? 0.8 : 0.2
    // Injured players still gain a tiny bit but mostly skip the bump.
    const isHurt = (p.injury?.weeksRemaining || 0) > 0
    const updated = endOfSeasonDevelopment(p, {
      coachDeveloper,
      paShare: isHurt ? 0 : paShare,
      ipShare: isHurt ? 0 : ipShare,
      budgetEffects: isHurt ? { devMultiplier: 0 } : budgetEffects,
      seasonStats,
    }, state.rngSeed + state.calendar.year)
    const gain = updated._devGain || 0
    // Potential drift + weight fluctuation. Skipped for injured.
    if (!isHurt) {
      tickPotentialEOY(updated, seasonStats, state.rngSeed + state.calendar.year)
      tickWeightFluctuation(updated, state.rngSeed + state.calendar.year)
    }
    if (gain >= 1.5) devReport.push({ player: updated, gain })
    if (gain <= -1.5) devReport.push({ player: updated, gain })
    delete updated._devGain
    // NOTE (per Nate, May 2026 — roster-count bug): class year advancement
    // + redshirt + GRAD/transfer handling MOVED OUT of this wk-44 hook and
    // INTO advanceClassYears(), which runs at the year rollover (wk 52 →
    // wk 1) inside runEndOfYear. Bumping class years mid-offseason made
    // the recruiting "open spots" math wrong all the way from wk 44
    // through wk 52 — returning FRs already counted as SOs and seniors
    // had already left the roster while the user was still building
    // the next class. Keeping the class year fixed until rollover keeps
    // the offseason roster picture honest.
    state.players[id] = updated
  }
  // Sort with biggest gainers AND biggest droppers — surface both ends
  devReport.sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain))
  for (const r of devReport.slice(0, 5)) {
    const isGain = r.gain > 0
    state.newsfeed.unshift({
      id: `dev_${state.calendar.year}_${r.player.id}`,
      year: state.calendar.year, week: 2,
      type: isGain ? 'PLAYER_BOOST' : 'AWARD',
      headline: `${r.player.firstName} ${r.player.lastName} (${r.player.classYear}, ${r.player.primaryPosition}) ${
        isGain ? `developed +${r.gain.toFixed(1)} OVR` : `regressed ${r.gain.toFixed(1)} OVR`
      } over the summer.`,
      payload: { playerId: r.player.id, gain: r.gain },
    })
  }
  // Opponent class advancement + freshman backfill MOVED OUT of this
  // wk-44 hook into the year rollover (see advanceClassYearsAndExits()
  // below — called from season.js runEndOfYear). Without that split,
  // opposing teams already showed next year's class structure during
  // the user's offseason — which also broke the league-wide recruiting
  // / "spots open" math. Opponent rating drift + ovrOffset refit ride
  // along with the rollover too.

  return { label: 'Player development', news: devReport }
}

/**
 * Year-rollover roster transitions (per Nate, May 2026 — class-advance-too-
 * early bug). Runs from season.runEndOfYear when the calendar ticks
 * wk 52 → wk 1, AFTER state.calendar.year has already incremented to the
 * new year. Handles:
 *
 *   1. USER TEAM: advance every returning player's classYear (FR→SO→JR→
 *      SR→GRAD; NWAC: FR→SO→GRAD), apply auto-redshirt for low-GP players,
 *      mark GRAD/transferred exits, remove them from the roster.
 *      Recruits who just signed during the prior wk-52 CLASS_FINALIZE are
 *      skipped via the player.signedAt marker (recruitToPlayer stamps it).
 *
 *   2. NON-USER TEAMS: defer to ageOpponentRosters which both advances
 *      classes and backfills freshmen up to the level's target roster size.
 *
 *   3. OVR-OFFSET REFIT: re-pin each non-user team's displayed Team OVR to
 *      its PEAR/PPI rank target after the natural drift from class churn.
 *
 * Class advancement used to fire mid-offseason at wk 44 (inside
 * runDevelopment) — but that flipped every returning FR to SO and dropped
 * graduating seniors before the user finished recruiting, which broke the
 * "open spots on roster" math from wk 44 all the way to wk 52. Moving the
 * advance to year rollover keeps the offseason roster picture honest.
 */
export function advanceClassYearsAndExits(state) {
  const userId = state.userSchoolId
  const userTeam = state.teams?.[userId]
  const isNwac = state.level === 'NWAC'
  const isNaiaLevel = !state.level || state.level === 'NAIA'
  const REDSHIRT_GAME_LIMIT = isNaiaLevel ? 11 : 0
  // The calendar has already ticked to the new year by the time runEndOfYear
  // calls us; recruits signed at the prior wk-52 CLASS_FINALIZE have
  // signedAt === state.calendar.year - 1. Skip them so they stay FR.
  const recruitsSignedAt = state.calendar.year - 1

  // ── USER TEAM ────────────────────────────────────────────────────────────
  if (userTeam) {
    const playerIds = userTeam.rosterPlayerIds || []
    // The just-finished season's stats live on _archivedPlayerStats
    // (runEndOfYear archives playerStats into the year bucket BEFORE us).
    const lastSeasonStats = state._archivedPlayerStats || state.playerStats || {}
    for (const id of playerIds) {
      const p = state.players[id]
      if (!p) continue
      // Skip brand-new recruits — they keep their FR class for the upcoming year.
      if (p.signedAt === recruitsSignedAt) continue
      const nextClass = isNwac
        ? ({ FR: 'SO', SO: 'GRAD' }[p.classYear] || 'GRAD')
        : ({ FR: 'SO', SO: 'JR', JR: 'SR', SR: 'GRAD' }[p.classYear] || 'GRAD')
      const statsKey = p.isPitcher ? `p_${id}` : `b_${id}`
      const gp = lastSeasonStats[statsKey]?.gamesPlayed || 0
      const eligibleToRedshirt = !p.redshirtUsed && (p.seasonsUsed || 0) < 3
      const shouldRedshirt = eligibleToRedshirt && gp <= REDSHIRT_GAME_LIMIT
      if (nextClass === 'GRAD') {
        const exitStatus = isNwac && p.classYear === 'SO' ? 'transferred' : 'graduated'
        state.players[id] = { ...p, eligibilityStatus: exitStatus }
      } else if (shouldRedshirt) {
        state.players[id] = { ...p, redshirtUsed: true, semestersUsed: (p.semestersUsed || 0) + 2 }
        state.newsfeed.unshift({
          id: `rs_${state.calendar.year}_${id}`, year: state.calendar.year, week: 1, type: 'AWARD',
          headline: `${p.firstName} ${p.lastName} (${p.classYear} ${p.primaryPosition}) auto-redshirted — only ${gp} games played.`,
          payload: { playerId: id, games: gp },
        })
      } else {
        state.players[id] = {
          ...p,
          classYear: nextClass,
          seasonsUsed: (p.seasonsUsed || 0) + 1,
          semestersUsed: (p.semestersUsed || 0) + 2,
        }
      }
    }
    // NWAC sophomores transferring out — record 4-year destinations BEFORE
    // we strip exits from the roster, so each leaver gets a destination row.
    if (isNwac) {
      try { assignNwacTransferDestinations(state) } catch (e) { console.warn('nwac dest assignment failed:', e) }
    }
    // Drop graduated + transferred from the user roster.
    const exits = playerIds.filter(id => {
      const s = state.players[id]?.eligibilityStatus
      return s === 'graduated' || s === 'transferred'
    })
    if (exits.length > 0) {
      userTeam.rosterPlayerIds = userTeam.rosterPlayerIds.filter(id => !exits.includes(id))
      const exitVerb = isNwac
        ? `${exits.length} sophomore${exits.length === 1 ? '' : 's'} transferred out to 4-year programs`
        : `${exits.length} senior${exits.length === 1 ? '' : 's'} graduated`
      state.newsfeed.unshift({
        id: `roster_exits_${state.calendar.year}`,
        year: state.calendar.year, week: 1, type: 'AWARD',
        headline: `${exitVerb}. Roster down to ${userTeam.rosterPlayerIds.length}.`,
        payload: {},
      })
    }
  }

  // ── NON-USER TEAMS ───────────────────────────────────────────────────────
  // ageOpponentRosters handles class advance + freshman backfill in one pass.
  ageOpponentRosters(state)

  // ── OVR-OFFSET REFIT ─────────────────────────────────────────────────────
  refitNonUserOvrOffsets(state)
}

/**
 * Recompute team.ovrOffset for every non-user team so the displayed OVR
 * matches the team's expected target (from PEAR / PPI rank). Runs once
 * a year after roster turnover (aging + new freshmen) so the offset
 * absorbs the natural rating drift from class churn.
 */
function refitNonUserOvrOffsets(state) {
  const userId = state.userSchoolId
  const avg = arr => (arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : 0)
  for (const team of Object.values(state.teams || {})) {
    if (!team || team.schoolId === userId) continue
    const school = state.schools?.[team.schoolId]
    if (!school) continue
    const roster = (team.rosterPlayerIds || []).map(id => state.players?.[id]).filter(Boolean)
    if (roster.length === 0) continue
    const hitters = roster.filter(p => p.isHitter).map(hitterOverall).sort((a, b) => b - a).slice(0, 9)
    const pitchers = roster.filter(p => p.isPitcher).map(pitcherOverall).sort((a, b) => b - a).slice(0, 5)
    const natural = Math.round(avg(hitters) * 0.55 + avg(pitchers) * 0.45)
    if (!natural) continue
    const target = expectedTeamOvr(school)
    if (typeof target !== 'number' || !Number.isFinite(target)) continue
    team.ovrOffset = target - natural
  }
}

/**
 * Year-over-year aging + recruiting for every team that isn't the user's.
 * Each opponent team:
 *  - advances every player's class year (FR→SO→JR→SR→GRAD; NWAC: FR→SO→GRAD)
 *  - drops graduated/transferred players
 *  - applies a modest development bump to retained players
 *  - generates new freshmen to refill toward the level's typical roster size
 *
 * Cheaper than the full user-team dev pipeline (no per-player stat lookups,
 * no injury check, no academics) — this is meant to be aggregate enough to
 * keep opponent OVR distributions believable across a 5+ year save without
 * blowing up the offseason tick budget.
 */
function ageOpponentRosters(state) {
  const userId = state.userSchoolId
  const level = state.level || 'NAIA'
  const isNwac = level === 'NWAC'
  // Target rostered count after EOY attrition + freshman refill (per Nate):
  // 4-year baseball rosters should sit in the 36-50 range; bump non-NAIA to
  // 42 so post-attrition + in-season churn keeps every team comfortably above
  // the 36 floor. NWAC target raised 28 → 33 (midpoint of the 28-38 hard
  // cap) so post-attrition rosters don't sag below the new floor.
  const TARGET_ROSTER = isNwac ? 33 : level === 'NAIA' ? 45 : 42
  const rng = makeRng('ageOpp', state.rngSeed, state.calendar.year, level)
  let aged = 0
  let graduated = 0
  let newFreshmen = 0
  for (const team of Object.values(state.teams)) {
    if (!team || team.schoolId === userId) continue
    const rosterIds = team.rosterPlayerIds || []
    const kept = []
    for (const pid of rosterIds) {
      const p = state.players[pid]
      if (!p) continue
      // Determine next class year for this player
      const nextClass = isNwac
        ? ({ FR: 'SO', SO: 'GRAD' }[p.classYear] || 'GRAD')
        : ({ FR: 'SO', SO: 'JR', JR: 'SR', SR: 'GRAD' }[p.classYear] || 'GRAD')
      if (nextClass === 'GRAD') {
        graduated++
        // Mark as graduated but leave in state.players for stats history
        state.players[pid] = { ...p, eligibilityStatus: 'graduated' }
        continue
      }
      // Cheap dev bump: 0-2 OVR worth of small rating tweaks. Skips most of
      // the user-team complexity (PA share, coach developer, budget effects);
      // good enough to keep opponents from going stale.
      const bump = rng.int(-1, 2)
      const aged_p = { ...p, classYear: nextClass, seasonsUsed: (p.seasonsUsed || 0) + 1 }
      if (bump > 0) {
        // Apply bump to the player's primary rating block
        const block = aged_p.isPitcher ? aged_p.pitcher : aged_p.hitter
        if (block) {
          const keys = Object.keys(block).filter(k => typeof block[k] === 'number' && block[k] < 99)
          if (keys.length > 0) {
            const k = keys[rng.int(0, keys.length - 1)]
            block[k] = Math.min(99, block[k] + bump)
          }
        }
      }
      state.players[pid] = aged_p
      kept.push(pid)
      aged++
    }
    team.rosterPlayerIds = kept
    // Backfill freshmen up to target roster size
    const school = state.schools[team.schoolId]
    if (school) {
      const need = Math.max(0, TARGET_ROSTER - kept.length)
      for (let i = 0; i < need; i++) {
        try {
          const slot = i % 2 === 0 ? 'hitter' : 'pitcher'
          const newPlayer = generatePlayer(school, slot, rng, state.calendar.year, kept.length + i)
          // Mark as freshman recruit
          newPlayer.classYear = 'FR'
          newPlayer.seasonsUsed = 0
          newPlayer.semestersUsed = 0
          state.players[newPlayer.id] = newPlayer
          team.rosterPlayerIds.push(newPlayer.id)
          newFreshmen++
        } catch (e) {
          // generatePlayer can throw if school is incomplete; skip rather than
          // blow up the offseason for the user.
          break
        }
      }
    }
  }
  if (aged > 0 || graduated > 0 || newFreshmen > 0) {
    state.newsfeed.unshift({
      id: `opp_rosters_${state.calendar.year}`,
      year: state.calendar.year, week: 2, type: 'AWARD',
      headline: `League roster turnover: ${graduated} seniors graduated, ${aged} returners advanced a class, ${newFreshmen} new freshmen signed across PNW programs.`,
      payload: { aged, graduated, newFreshmen },
    })
  }
}

function runDraft(state) {
  const picks = simMlbDraft(state, state.calendar.year)
  if (!state.draftResults) state.draftResults = {}
  state.draftResults[state.calendar.year] = picks
  // Drafted players sign pro and LEAVE — remove them from their roster (the
  // user's complaint: a drafted player was still on the team). Frees their
  // scholarship immediately since they're off the roster.
  for (const pk of picks) {
    if (!pk?.playerId) continue
    const t = state.teams?.[pk.teamId]
    if (t) t.rosterPlayerIds = (t.rosterPlayerIds || []).filter(id => id !== pk.playerId)
    const player = state.players?.[pk.playerId]
    if (player) { player.eligibilityStatus = 'drafted'; player.draftedRound = pk.round }
  }
  const userConfId = state.schools[state.userSchoolId]?.conferenceId
  state.newsfeed.unshift({
    id: `draft_${state.calendar.year}`,
    year: state.calendar.year, week: 3, type: 'AWARD',
    headline: `${summarizeDraft(picks, userConfId, state.level)}`,
    payload: { year: state.calendar.year, picks },
  })
  const userPicks = picks.filter(p => p.teamId === state.userSchoolId)
  for (const pk of userPicks) {
    state.newsfeed.unshift({
      id: `draft_user_${state.calendar.year}_${pk.playerId}`,
      year: state.calendar.year, week: 3, type: 'AWARD',
      headline: `${pk.name} (${pk.pos}) drafted by MLB in Round ${pk.round}! Big win for the program.`,
      payload: { playerId: pk.playerId, round: pk.round }, big: true,
    })
  }
  // Capture YOUR draftees for a Dashboard popup so the draft can't be missed.
  if (userPicks.length > 0) {
    state._newDraftPicks = [...(state._newDraftPicks || []), ...userPicks.map(pk => ({
      name: pk.name, pos: pk.pos, round: pk.round,
    }))]
  }
  if (userPicks.length > 0 && state.budget) {
    state.budget.jobSecurity = Math.min(100, (state.budget.jobSecurity || 50) + userPicks.length * 3)
  }
  // HC progression — points for every program draft pick
  if (userPicks.length > 0) {
    awardForEndOfYearHonors(state, { firstTeam: 0, secondTeam: 0, goldGlove: 0, draftPicks: userPicks.length })
  }
  return { label: 'MLB Draft', news: picks }
}

function runHsAttrition(state) {
  if (state.recruits) applyHsAttrition(state.recruits, state.rngSeed + state.calendar.year)
  return { label: 'HS class shakeup' }
}

function runPortalOpen(state) {
  if (!state.recruits) state.recruits = {}
  const userHC = state.coaches[state.teams[state.userSchoolId]?.headCoachId]
  const portalPool = generatePortalPool(state.calendar.year, state.rngSeed, userHC, { level: state.level || 'NAIA' })
  Object.assign(state.recruits, portalPool)
  state.newsfeed.unshift({
    id: `portal_open_${state.calendar.year}`,
    year: state.calendar.year, week: 4, type: 'AWARD',
    headline: `NAIA Portal is OPEN. ${Object.values(portalPool).length} new transfer prospects on the recruiting board.`,
    payload: {},
  })
  return { label: 'Transfer portal opens' }
}

function runOutbound(state, phase) {
  return { label: 'Outbound transfers', news: runOutboundTransfers(state, phase) }
}
