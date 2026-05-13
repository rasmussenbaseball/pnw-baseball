/**
 * Annual events engine.
 *
 * Real college baseball has things happen on specific dates — the MLB draft
 * is mid-July, the transfer portal opens after the season, fall scrimmages
 * are October Fridays, prospect camp is early November, etc. Rather than
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
import { runOutboundTransfers } from './outboundTransfers'
import { applyHsAttrition, generatePortalPool } from './recruits'
import { simMlbDraft, summarizeDraft } from './draft'
import { endOfSeasonDevelopment } from './development'
import { budgetCategoryEffects } from './budget'
import { totalAnnualTravelCost } from './travel'
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
  PLAYER_DEVELOPMENT:       { label: 'Player development', desc: 'Offseason rating gains for everyone on the roster.' },
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
  PROSPECT_CAMP:            { label: 'Prospect Camp', desc: 'Annual recruiting camp. Run it from Weekly Actions.' },
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
}

// ─── Event schedule — unified 52-week ──────────────────────────────────────
//
// Map weekOfYear → which events fire that week. Heavy end-of-year work was
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
  // Fall scrimmages auto-scheduled into wks 6-12 (8 games over ~4 weekends)
  // ── Prospect Camp (wk 13) ──
  13: ['PROSPECT_CAMP', 'HS_NLI_EARLY'],
  // ── Training Period + Spring Practice (wks 14-26) ──
  14: ['TRAINING_PERIOD'],
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
  43: ['PORTAL_OPEN', 'OUTBOUND_TRANSFERS_MID', 'END_OF_TERM_ACADEMICS'],
  44: ['PLAYER_DEVELOPMENT'],
  45: ['OUTBOUND_TRANSFERS_LATE', 'HS_ATTRITION'],
  46: ['BUDGET_REVIEW'],
  48: ['MLB_DRAFT'],                              // early July
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
    // Map wk → legacy offseason week (1-26 direct; 43-52 → 27-36)
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
  'PROSPECT_CAMP', 'HS_NLI_EARLY', 'DEAD_PERIOD', 'SPRING_PRACTICE',
  'SEASON_OPEN', 'CONF_OPEN', 'REG_SEASON_END', 'CONF_TOURNAMENT',
  'OPENING_ROUND', 'WORLD_SERIES', 'LAST_DAY_RECRUITING',
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
    case 'END_OF_TERM_ACADEMICS':    return runAcademics(state)
    case 'PLAYER_DEVELOPMENT':       return runDevelopment(state)
    case 'MLB_DRAFT':                return runDraft(state)
    case 'HS_ATTRITION':             return runHsAttrition(state)
    case 'PORTAL_OPEN':              return runPortalOpen(state)
    case 'OUTBOUND_TRANSFERS_MID':   return runOutbound(state, 'MID_OFFSEASON')
    case 'OUTBOUND_TRANSFERS_LATE':  return runOutbound(state, 'LATE_OFFSEASON')
    case 'CLASS_FINALIZE':           return runClassFinalize(state)
    case 'LOCK_TRAVEL_BUDGET':       return runLockTravelBudget(state)
    default:                         return null
  }
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
  const cost = totalAnnualTravelCost(
    state.userSchoolId, state.schedule, state.schools, NON_NAIA_LOOKUP,
  )
  const travelDollars = cost?.totalCost ?? 0
  state.budget = lockTravelAllocation(state.budget, travelDollars)
  state.newsfeed.unshift({
    id: `lock_travel_${state.calendar.year}`,
    year: state.calendar.year, week: 3, type: 'AWARD',
    headline: `🔒 Travel budget locked at $${(travelDollars / 1000).toFixed(1)}K based on your scheduled trips.`,
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
  for (const r of Object.values(state.recruits)) {
    if (r.status !== 'signed' || r.signedWith !== userId) continue
    if (r.joinedAt && r.joinedAt === state.calendar.year) continue   // already joined
    // Move recruit → player. We mark them on the roster; ratings are already
    // on the recruit object. A future pass can shape them into the canonical
    // Player schema with hitter/pitcher blocks.
    if (!state.players[r.id]) {
      state.players[r.id] = recruitToPlayer(r)
    }
    if (!team.rosterPlayerIds.includes(r.id)) team.rosterPlayerIds.push(r.id)
    r.joinedAt = state.calendar.year
    r.scoutFogCleared = true
    added++
  }
  state.newsfeed.unshift({
    id: `class_finalize_${state.calendar.year}`,
    year: state.calendar.year, week: 52, type: 'AWARD',
    headline: `🎓 ${added} signed recruit${added === 1 ? '' : 's'} joined the roster. Full ratings revealed.`,
    payload: {}, big: added > 0,
  })
  return { label: 'Class finalized', news: { added } }
}

/** Shape a Recruit into a Player. Inherits ratings + bio; resets stats. */
function recruitToPlayer(r) {
  return {
    id: r.id,
    firstName: r.firstName, lastName: r.lastName,
    bats: r.bats, throws: r.throws,
    primaryPosition: r.primaryPosition,
    positions: r.positions || [r.primaryPosition],
    classYear: 'FR',
    seasonsUsed: 0,
    semestersUsed: 0,
    redshirtUsed: false,
    hometown: r.hometown,
    isHitter: !r.isPitcher,
    isPitcher: !!r.isPitcher,
    hitter: r.hitter || null,
    pitcher: r.pitcher || null,
    hidden: r.hidden || {},
    gpa: r.gpa ?? 3.0,
    academicStanding: 'eligible',
    eligibilityStatus: 'eligible',
    scholarship: { annualAmount: r.scholarshipOffered ?? 0 },
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

function runBudgetReview(state) {
  const userTeam = state.teams[state.userSchoolId]
  const seasonResult = {
    wins: userTeam._lastSeason?.wins ?? userTeam.wins,
    losses: userTeam._lastSeason?.losses ?? userTeam.losses,
    confChampion: state.postseason?.userChamp || false,
    postseasonAppearance: state.postseason?.userQualified || false,
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
      headline: `⚠️ Team GPA of ${result.summary.teamGpa.toFixed(2)} below 2.5 — job security ${penalty} pts.`,
      payload: {},
    })
  }
  return { label: 'Spring GPAs posted' }
}

function runDevelopment(state) {
  const userTeam = state.teams[state.userSchoolId]
  const hc = state.coaches[userTeam.headCoachId]
  const coachDeveloper = hc?.developer ?? 55
  // Use extended effects so facilities → devMultiplier actually drives
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
    const updated = endOfSeasonDevelopment(p, {
      coachDeveloper, paShare, ipShare, budgetEffects, seasonStats,
    }, state.rngSeed + state.calendar.year)
    const gain = updated._devGain || 0
    if (gain >= 1.5) devReport.push({ player: updated, gain })
    delete updated._devGain
    // Class advance + redshirt — pulled from old runEndOfYear path
    const REDSHIRT_GAME_LIMIT = 11
    const gp = (state.playerStats?.[statsKey] ?? state._archivedPlayerStats?.[statsKey])?.gamesPlayed || 0
    const eligibleToRedshirt = !updated.redshirtUsed && (updated.seasonsUsed || 0) < 3
    const shouldRedshirt = eligibleToRedshirt && gp <= REDSHIRT_GAME_LIMIT
    const nextClass = { FR: 'SO', SO: 'JR', JR: 'SR', SR: 'GRAD' }[updated.classYear]
    if (nextClass === 'GRAD') {
      state.players[id] = { ...updated, eligibilityStatus: 'graduated' }
    } else if (shouldRedshirt) {
      state.players[id] = { ...updated, redshirtUsed: true, semestersUsed: (updated.semestersUsed || 0) + 2 }
      state.newsfeed.unshift({
        id: `rs_${state.calendar.year}_${id}`, year: state.calendar.year, week: 2, type: 'AWARD',
        headline: `🎓 ${updated.firstName} ${updated.lastName} (${updated.classYear} ${updated.primaryPosition}) auto-redshirted — only ${gp} games played.`,
        payload: { playerId: id, games: gp },
      })
    } else {
      state.players[id] = { ...updated, classYear: nextClass, seasonsUsed: updated.seasonsUsed + 1, semestersUsed: updated.semestersUsed + 2 }
    }
  }
  devReport.sort((a, b) => b.gain - a.gain)
  for (const r of devReport.slice(0, 3)) {
    state.newsfeed.unshift({
      id: `dev_${state.calendar.year}_${r.player.id}`, year: state.calendar.year, week: 2, type: 'AWARD',
      headline: `${r.player.firstName} ${r.player.lastName} (${r.player.classYear}, ${r.player.primaryPosition}) developed +${r.gain.toFixed(1)} OVR.`,
      payload: { playerId: r.player.id, gain: r.gain },
    })
  }
  // Remove graduated players from roster
  const grads = playerIds.filter(id => state.players[id]?.eligibilityStatus === 'graduated')
  if (grads.length > 0) {
    state.teams[state.userSchoolId].rosterPlayerIds = userTeam.rosterPlayerIds.filter(id => !grads.includes(id))
    state.newsfeed.unshift({
      id: `grad_${state.calendar.year}`, year: state.calendar.year, week: 2, type: 'AWARD',
      headline: `${grads.length} senior${grads.length === 1 ? '' : 's'} graduated. Roster down to ${state.teams[state.userSchoolId].rosterPlayerIds.length}.`,
      payload: {},
    })
  }
  return { label: 'Player development', news: devReport }
}

function runDraft(state) {
  const picks = simMlbDraft(state, state.calendar.year)
  if (!state.draftResults) state.draftResults = {}
  state.draftResults[state.calendar.year] = picks
  const userConfId = state.schools[state.userSchoolId]?.conferenceId
  state.newsfeed.unshift({
    id: `draft_${state.calendar.year}`,
    year: state.calendar.year, week: 3, type: 'AWARD',
    headline: `⚾ ${summarizeDraft(picks, userConfId)}`,
    payload: { year: state.calendar.year, picks },
  })
  const userPicks = picks.filter(p => p.teamId === state.userSchoolId)
  for (const pk of userPicks) {
    state.newsfeed.unshift({
      id: `draft_user_${state.calendar.year}_${pk.playerId}`,
      year: state.calendar.year, week: 3, type: 'AWARD',
      headline: `🌟 ${pk.name} (${pk.pos}) drafted by MLB in Round ${pk.round}! Big win for the program.`,
      payload: { playerId: pk.playerId, round: pk.round }, big: true,
    })
  }
  if (userPicks.length > 0 && state.budget) {
    state.budget.jobSecurity = Math.min(100, (state.budget.jobSecurity || 50) + userPicks.length * 3)
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
  const portalPool = generatePortalPool(state.calendar.year, state.rngSeed, userHC)
  Object.assign(state.recruits, portalPool)
  state.newsfeed.unshift({
    id: `portal_open_${state.calendar.year}`,
    year: state.calendar.year, week: 4, type: 'AWARD',
    headline: `📥 NAIA Portal is OPEN. ${Object.values(portalPool).length} new transfer prospects on the recruiting board.`,
    payload: {},
  })
  return { label: 'Transfer portal opens' }
}

function runOutbound(state, phase) {
  return { label: 'Outbound transfers', news: runOutboundTransfers(state, phase) }
}
