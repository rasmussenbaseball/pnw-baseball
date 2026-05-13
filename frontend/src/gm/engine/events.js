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
import { annualReview } from './budget'
import { runOutboundTransfers } from './outboundTransfers'
import { applyHsAttrition, generatePortalPool } from './recruits'
import { simMlbDraft, summarizeDraft } from './draft'
import { endOfSeasonDevelopment } from './development'
import { budgetCategoryEffects } from './budget'

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
}

// ─── Offseason event schedule ──────────────────────────────────────────────
//
// Map offseasonWeek → which events fire that week. End-of-year heavy work is
// spread across weeks 1–6 so no single tick is expensive.

export const OFFSEASON_EVENT_SCHEDULE = {
  // ── June / July equivalent (post-postseason transition) ──
  1: ['BUDGET_REVIEW', 'END_OF_TERM_ACADEMICS'],
  2: ['PLAYER_DEVELOPMENT'],                              // heaviest single op
  3: ['MLB_DRAFT', 'HS_ATTRITION'],
  4: ['OUTBOUND_TRANSFERS_MID', 'PORTAL_OPEN'],
  5: ['OUTBOUND_TRANSFERS_LATE'],
  6: ['SET_SCHEDULE'],                                    // user-facing reminder
  7: ['LAST_DAY_RECRUITING'],
  // ── Fall (Sept-Oct, weeks 5-13) ──
  9: ['FALL_CAMP_START'],
  10: ['FALL_SCRIM_FRIDAY'],
  11: ['FALL_SCRIM_FRIDAY'],
  12: ['FALL_SCRIM_FRIDAY'],
  13: ['FALL_SCRIM_FRIDAY'],
  // ── November (Training, weeks 14-17) ──
  14: ['TRAINING_PERIOD', 'PROSPECT_CAMP', 'HS_NLI_EARLY'],
  // ── December (Dead, weeks 18-21) ──
  18: ['DEAD_PERIOD'],
  // ── January (Spring Practice, weeks 22-26) ──
  22: ['SPRING_PRACTICE'],
}

// In-season events — fire when seasonWeek hits these numbers.
export const SEASON_EVENT_SCHEDULE = {
  1: ['SEASON_OPEN'],
  4: ['CONF_OPEN'],
  13: ['REG_SEASON_END'],
  14: ['CONF_TOURNAMENT'],
  15: ['OPENING_ROUND'],
  16: ['WORLD_SERIES'],
}

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
    default:                         return null
  }
}

/**
 * Run all events scheduled for the current offseason week. Caller should
 * already have advanced the calendar to the new week.
 */
export function runEventsForOffseasonWeek(state, offseasonWeek) {
  const events = OFFSEASON_EVENT_SCHEDULE[offseasonWeek] || []
  const ran = []
  for (const key of events) {
    const result = runEvent(state, key)
    if (result) ran.push({ key, ...result })
  }
  return ran
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
  const budgetEffects = budgetCategoryEffects(state.budget)
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
