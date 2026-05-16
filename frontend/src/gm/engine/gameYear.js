/**
 * Unified 52-week game year.
 *
 * Week 1 = Aug 1 (start of new academic year)
 * Week 52 = last week of July (recruiting class finalizes)
 * Week 1 (next year) = Aug 1 again
 *
 * This module is the spine of the game. Every other system (events, sims,
 * UI, phase-gates) reads from here. Each week has:
 *
 *   - A PHASE label (display + drives what's enabled)
 *   - An optional REQUIRED ACTION (must be complete to advance — hard block)
 *   - Optional EVENT(s) (engine work that fires when the week starts)
 *
 * The required-action system gives Wks 1–4 their tutorial feel: the user is
 * walked through scheduling hiring budgeting scouting, and physically
 * cannot advance past a week until that week's task is done.
 */

import { offseasonWeekDate } from './calendar'

export const WEEKS_PER_YEAR = 52

// ─── Phase definitions (1-52) ──────────────────────────────────────────────
//
// Each phase is a contiguous run of weeks with the same label + behavior.
// `requiredAction` (if set) gates advancement out of that week.

/** @typedef {{ key: string, label: string, blurb: string }} Phase */

export const PHASES = {
  TUTORIAL_SCHEDULE: { key: 'TUTORIAL_SCHEDULE', label: 'Set Schedule',   blurb: 'Lock in your non-conf weekends. Fall scrimmages auto-fill.' },
  TUTORIAL_HIRE:     { key: 'TUTORIAL_HIRE',     label: 'Hire Assistants', blurb: '$40K assistant pool. Pitching / hitting / bench coach.' },
  TUTORIAL_BUDGET:   { key: 'TUTORIAL_BUDGET',   label: 'Set Budget',     blurb: 'Travel is locked from your schedule. Allocate the rest.' },
  TUTORIAL_SCOUT:    { key: 'TUTORIAL_SCOUT',    label: 'Open Scouting',  blurb: 'AP unlocks. Spend it all on next year\'s recruits.' },
  FALL_CAMP:         { key: 'FALL_CAMP',         label: 'Fall Camp',      blurb: 'Practice + 8 fall scrimmages vs nearby D2/D3/JUCO opponents.' },
  PROSPECT_CAMP:     { key: 'PROSPECT_CAMP',     label: 'Prospect Camp',  blurb: 'Annual recruiting camp. Run it from Weekly Actions.' },
  TRAINING:          { key: 'TRAINING',          label: 'Training Period', blurb: 'Skill + position work. AP available; no games.' },
  SPRING_PRACTICE:   { key: 'SPRING_PRACTICE',   label: 'Spring Practice', blurb: 'Pre-season ramp-up. Final roster prep.' },
  NON_CONFERENCE:    { key: 'NON_CONFERENCE',    label: 'Non-Conf',        blurb: 'Opening weekends — Friday/Saturday/Sunday series.' },
  CONFERENCE:        { key: 'CONFERENCE',        label: 'Conference',      blurb: 'CCC play. 10 series across 10 weeks, no byes.' },
  CONF_TOURNAMENT:   { key: 'CONF_TOURNAMENT',   label: 'Conf Tournament', blurb: 'Double-elim bracket. Winner gets the auto-bid.' },
  OPENING_ROUND:     { key: 'OPENING_ROUND',     label: 'Opening Round',   blurb: 'NAIA regional brackets — 4-team double-elim.' },
  WORLD_SERIES:      { key: 'WORLD_SERIES',      label: 'World Series',    blurb: 'Avista NAIA WS in Lewiston, ID.' },
  PORTAL:            { key: 'PORTAL',            label: 'Portal Open',     blurb: 'Inbound + outbound transfers. Recruit from the portal.' },
  MLB_DRAFT_WEEK:    { key: 'MLB_DRAFT_WEEK',    label: 'MLB Draft Week',  blurb: '5–12 NAIA players selected over 20 rounds.' },
  RECRUIT_FINALIZE:  { key: 'RECRUIT_FINALIZE',  label: 'Class Finalize',  blurb: 'Signees join the roster. Full ratings revealed.' },
}

/**
 * Phase for a given week number (1–52). This is the source of truth for
 * "what is week N about?" — used by Dashboard, Calendar page, sim gating, etc.
 */
export function phaseForWeek(week) {
  if (week === 1) return PHASES.TUTORIAL_SCHEDULE
  if (week === 2) return PHASES.TUTORIAL_HIRE
  if (week === 3) return PHASES.TUTORIAL_BUDGET
  if (week === 4) return PHASES.TUTORIAL_SCOUT
  if (week >= 5 && week <= 12) return PHASES.FALL_CAMP
  if (week === 13) return PHASES.PROSPECT_CAMP
  if (week >= 14 && week <= 22) return PHASES.TRAINING
  if (week >= 23 && week <= 26) return PHASES.SPRING_PRACTICE
  if (week >= 27 && week <= 29) return PHASES.NON_CONFERENCE
  if (week >= 30 && week <= 39) return PHASES.CONFERENCE
  if (week === 40) return PHASES.CONF_TOURNAMENT
  if (week === 41) return PHASES.OPENING_ROUND
  if (week === 42) return PHASES.WORLD_SERIES
  if (week === 48) return PHASES.MLB_DRAFT_WEEK
  if (week === 52) return PHASES.RECRUIT_FINALIZE
  if (week >= 43 && week <= 51) return PHASES.PORTAL
  return PHASES.PORTAL   // safety fallback
}

/**
 * Calendar mode derived from week — kept for back-compat with existing code
 * that reads `state.calendar.mode`.
 */
export function modeForWeek(week) {
  if (week >= 27 && week <= 39) return 'SEASON'
  if (week >= 40 && week <= 42) return 'POSTSEASON'
  return 'OFFSEASON'
}

/** seasonWeek (1–13 reg, 14–16 postseason) — null in offseason. */
export function seasonWeekForWeek(week) {
  if (week >= 27 && week <= 39) return week - 26
  if (week >= 40 && week <= 42) return week - 26   // 14, 15, 16
  return null
}

// ─── Required actions (phase-gate) ─────────────────────────────────────────
//
// Returns { key, label, route, completionCheck } for the week's required
// task — null if the week is free-form. Dashboard hard-blocks the Advance
// button until completionCheck(state) returns true.

/**
 * @typedef {Object} RequiredAction
 * @property {string} key        machine key (e.g. 'SCHEDULE')
 * @property {string} label      short user-facing label
 * @property {string} blurb      one-line description for the dashboard banner
 * @property {string} route      where to send the user to complete it
 * @property {(state: any) => boolean} isComplete  has the task been done?
 * @property {string} [doneText] optional " done" text to show when complete
 */

/** @returns {RequiredAction | null} */
export function requiredActionForWeek(state, week) {
  // Mandatory cuts (over the 50-player cap) supersede everything — fires
  // at Wk 52 after class finalize, blocks the year-rollover until resolved.
  if (state.mandatoryCuts?.needed > 0 && state.mandatoryCuts.year === state.calendar?.year) {
    return MANDATORY_CUTS_REQUIREMENT
  }
  switch (week) {
    case 1: return SCHEDULE_REQUIREMENT
    case 2: return HIRE_REQUIREMENT
    case 3: return BUDGET_REQUIREMENT
    case 4: return SCOUT_REQUIREMENT
    case 13: return PROSPECT_CAMP_REQUIREMENT
    default: return null
  }
}

const MANDATORY_CUTS_REQUIREMENT = {
  key: 'MANDATORY_CUTS',
  label: 'Cut down to 50 players',
  blurb: 'Your roster is over the 50-player cap after class finalization. Open the Roster page, enter cut mode, and trim the excess. Job security has already taken a hit for over-recruiting — keep your numbers in line next year.',
  route: '/gm/roster',
  isComplete: (state) => !(state.mandatoryCuts?.needed > 0 && state.mandatoryCuts.year === state.calendar?.year),
  doneText: ' Roster trimmed to 50',
}

const SCHEDULE_REQUIREMENT = {
  key: 'SCHEDULE',
  label: 'Set your schedule',
  blurb: 'Lock in non-conference weekends for the coming spring. Fall games auto-fill against nearby D2/D3/JUCO opponents.',
  route: '/gm/schedule',
  isComplete: (state) => isScheduleComplete(state),
  doneText: ' Schedule complete',
}

const HIRE_REQUIREMENT = {
  key: 'HIRE',
  label: 'Hire your assistants',
  blurb: 'Pitching / Hitting / Bench coach. First year of a dynasty requires all three; later years let you keep your staff in place.',
  route: '/gm/coaches',
  isComplete: (state) => isHiringComplete(state),
  doneText: ' Staff in place',
}

const BUDGET_REQUIREMENT = {
  key: 'BUDGET',
  label: 'Set your annual budget',
  blurb: 'Allocate program $ across travel (locked from your schedule), facilities, S&C, recruiting, etc. Pick a preset or build your own.',
  route: '/gm/budget',
  isComplete: (state) => isBudgetSet(state),
  doneText: ' Budget set',
}

const SCOUT_REQUIREMENT = {
  key: 'SCOUT',
  label: 'Open scouting & build your board',
  blurb: 'AP unlocks this week. Spend every point on scouting recruits for next year\'s class. Add them to your board, run trips, sign-of-interest visits.',
  route: '/gm/recruiting',
  isComplete: (state) => (state.ap?.currentWeek ?? 0) === 0,
  doneText: ' AP spent on scouting',
}

const PROSPECT_CAMP_REQUIREMENT = {
  key: 'PROSPECT_CAMP',
  label: 'Run your prospect camp',
  blurb: 'Once-a-year HS recruiting camp on your campus. Click below — there\'s a "Run Camp Now" panel at the top of Weekly Actions. Pick a fee, hit the button. (Invites were taken in Wks 5 & 10; if you missed those, you can still run it at lowest fee for revenue.)',
  route: '/gm/weekly',
  isComplete: (state) => state.prospectCamp?.year === state.calendar?.year,
  doneText: ' Camp held',
}

// ─── Per-week completion checks (kept here so gameYear.js owns the spine) ──

function isScheduleComplete(state) {
  // Schedule is considered complete when:
  //   1. There are no open non-conference weekend slots, AND
  //   2. The 8 auto-scheduled fall games exist (built by setup, can't be skipped)
  // For backwards compat with older saves, we accept either "no open slots"
  // OR "marked complete in state.scheduleComplete".
  if (state.scheduleComplete) return true
  if (!state.schedule || state.schedule.length === 0) return false
  // Light heuristic: at least one user game and zero open conference-window
  // weekend slots. We delegate the precise check to schedule.openNonConfWeeks
  // when called from the UI.
  return false
}

function isHiringComplete(state) {
  // ALL years: must have at least 3 assistants. NAIA programs are required
  // to carry pitching / hitting / bench coaches; the user can pick which
  // names + archetypes go in those roles each year.
  const team = state.teams?.[state.userSchoolId]
  if (!team) return false
  const required = ['PITCHING_COACH', 'HITTING_COACH', 'BENCH_COACH']
  const assistants = (team.assistantCoachIds || []).map(id => state.coaches?.[id]).filter(Boolean)
  const filledRoles = new Set(assistants.map(c => c.role))
  const hasMinThree = required.every(r => filledRoles.has(r))
  if (!hasMinThree) return false
  const isFirstYear = (state.dynastyYear ?? 1) === 1
  if (isFirstYear) return true
  // Year 2+ — user must explicitly confirm OR have done a new hire this year.
  return state.hiringConfirmed?.year === state.calendar?.year
}

function isBudgetSet(state) {
  return state.budget?.locked?.year === state.calendar?.year
}

/**
 * Top-level phase-gate check. Returns { ok, reason } — when ok=false, the
 * Dashboard advance button should be disabled.
 */
export function canAdvanceWeek(state) {
  const week = state.calendar?.weekOfYear ?? 1
  const req = requiredActionForWeek(state, week)
  if (!req) return { ok: true }
  if (req.isComplete(state)) return { ok: true }
  return { ok: false, reason: req.blurb, action: req }
}

// ─── Date math ─────────────────────────────────────────────────────────────

/**
 * Convert a (dynasty year, weekOfYear) pair real-world Date.
 *
 * Year semantics: `year`is the year ending the spring season. So year=2027
 * means Aug 2026 July 2027. Wk 1 starts Aug 1 of (year - 1).
 */
export function dateForWeek(year, weekOfYear) {
  // Wk 1 = Aug 1 of (year - 1). Wk 27 = ~Feb 1 of year.
  const startYear = year - 1
  return offseasonWeekDate(startYear, weekOfYear)
}

/**
 * @param {number} weekOfYear
 * @returns {string} short label e.g. "Aug 1", "Feb 8"
 */
export function shortDateLabel(year, weekOfYear) {
  const d = dateForWeek(year, weekOfYear)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`
}

// ─── Migration helper ──────────────────────────────────────────────────────
//
// Old saves have state.calendar = { mode, offseasonWeek | seasonWeek, year }.
// Map those to the unified `weekOfYear` 1–52 so we don't break dynasties on
// the version bump. Called lazily on load.

export function ensureUnifiedCalendar(state) {
  if (!state?.calendar) return state
  if (typeof state.calendar.weekOfYear === 'number') return state   // already migrated
  const cal = state.calendar
  let wk = 1
  if (cal.mode === 'OFFSEASON' && typeof cal.offseasonWeek === 'number') {
    // Old offseason ran 1-26 = Aug-Jan. Map directly.
    wk = Math.max(1, Math.min(26, cal.offseasonWeek))
  } else if (cal.mode === 'SEASON' && typeof cal.seasonWeek === 'number') {
    wk = 26 + Math.max(1, Math.min(13, cal.seasonWeek))   // 27-39
  } else if (cal.mode === 'POSTSEASON') {
    wk = 40   // best guess — conf tournament start
  }
  state.calendar.weekOfYear = wk
  return state
}
