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

// Phase flags drive cross-cutting behavior:
//   - practice:     full team practice happens this week (drives skill dev)
//   - conditioning: strength + speed work happens (slower skill dev)
//   - devAllowed:   weekly stats-driven development can fire
//   - devRateMult:  optional multiplier on weekly dev rate (1.0 default)
//   - inSeason:     games are played this week
//   - season:       human-readable umbrella period (shown as a banner)
export const PHASES = {
  // ── August: late-summer setup (Wks 1-4) ─────────────────────────────────
  TUTORIAL_SCHEDULE: { key: 'TUTORIAL_SCHEDULE', label: 'Set Schedule',     blurb: 'Lock in your non-conference weekends. Conference series are auto-generated.',
    season: 'Late Summer', practice: false, conditioning: false, devAllowed: false },
  TUTORIAL_HIRE:     { key: 'TUTORIAL_HIRE',     label: 'Hire Assistants',  blurb: '$40K assistant pool. Pitching / hitting / bench coach.',
    season: 'Late Summer', practice: false, conditioning: false, devAllowed: false },
  TUTORIAL_BUDGET:   { key: 'TUTORIAL_BUDGET',   label: 'Set Budget',       blurb: 'Travel is locked from your schedule. Allocate the rest.',
    season: 'Late Summer', practice: false, conditioning: false, devAllowed: false },
  TUTORIAL_SCOUT:    { key: 'TUTORIAL_SCOUT',    label: 'Open Scouting',    blurb: "AP unlocks with a big one-time scouting budget — build out your recruiting board for next year's class.",
    season: 'Late Summer', practice: false, conditioning: false, devAllowed: false },
  // ── September-October: fall camp (Wks 5-13) ─────────────────────────────
  FALL_CAMP:         { key: 'FALL_CAMP',         label: 'Fall Camp',        blurb: 'Full team practice. Skills develop normally — spend AP on drills + recruiting.',
    season: 'Fall Camp', practice: true, conditioning: true, devAllowed: true },
  // ── October: ONE turn (Wks 9-12). No games — condensed like Nov/Dec. ──
  OCTOBER:           { key: 'OCTOBER',           label: 'October',          blurb: 'The whole month in one turn. A full month of AP for fall practice + recruiting — then advance to November.',
    season: 'October', practice: true, conditioning: true, devAllowed: true },
  // ── November: ONE turn (Wks 13-17). A full month of AP, no games. ──
  NOVEMBER:          { key: 'NOVEMBER',          label: 'November',         blurb: 'The whole month in one turn. Spend a full month of AP on recruiting + development — then advance straight to December.',
    season: 'November', practice: true, conditioning: true, devAllowed: true, devRateMult: 0.5 },
  // ── December: ONE turn (Wks 18-22). A full month of AP, no games. ──
  DECEMBER:          { key: 'DECEMBER',          label: 'December',         blurb: 'The whole month in one turn. Spend a full month of AP on recruiting + winter development — then advance to January.',
    season: 'December', practice: true, conditioning: true, devAllowed: true, devRateMult: 0.5 },
  // ── January: pre-season practice (Wks 23-26) ────────────────────────────
  WINTER_PRACTICE:   { key: 'WINTER_PRACTICE',   label: 'Winter Practice',  blurb: 'Pre-season ramp-up. Final roster prep. Last chance to dial in lineups before opening day.',
    season: 'January', practice: true, conditioning: true, devAllowed: true },
  // ── February-April: spring season (Wks 27-39) ───────────────────────────
  NON_CONFERENCE:    { key: 'NON_CONFERENCE',    label: 'Non-Conf Season',  blurb: 'Opening weekends — Friday/Saturday/Sunday series.',
    season: 'Spring Season', practice: true, conditioning: false, devAllowed: true, inSeason: true },
  CONFERENCE:        { key: 'CONFERENCE',        label: 'Conference Play',  blurb: 'Conference play — 10 series across 10 weeks, no byes.',
    season: 'Spring Season', practice: true, conditioning: false, devAllowed: true, inSeason: true },
  // ── May: postseason (Wks 40-42) ─────────────────────────────────────────
  // `blurbByLevel` overrides the default blurb per league when the level
  // differs from NAIA's flow. Used by the PhaseTransitionModal to swap in
  // level-correct copy (NWAC: regional super regional NWAC Championship
  // at Longview; D1: CWS; etc.).
  CONF_TOURNAMENT:   { key: 'CONF_TOURNAMENT',   label: 'Conf Tournament',  blurb: 'Double-elim bracket. Winner gets the NAIA auto-bid.',
    blurbByLevel: {
      D1:   'Double-elim conference tournament. Winner gets an auto-bid to the NCAA Regionals.',
      D2:   'Double-elim conference tournament. Winner gets an auto-bid to the NCAA D-II Regionals.',
      D3:   'Double-elim conference tournament. Winner gets an auto-bid to the NCAA D-III Regionals.',
      NWAC: 'NWAC playoffs begin. Top-4 per region advance; #2 seeds host super regionals.',
    },
    season: 'Postseason', practice: true, conditioning: false, devAllowed: false, inSeason: true },
  OPENING_ROUND:     { key: 'OPENING_ROUND',     label: 'Opening Round',    blurb: 'Regional brackets — double-elimination.',
    blurbByLevel: {
      D1:   'NCAA Regionals — 4-team double-elim brackets. Winners advance to Super Regionals.',
      D2:   'NCAA D-II Regionals — 4-team double-elim brackets.',
      D3:   'NCAA D-III Regionals — 4-team double-elim brackets.',
      NWAC: 'NWAC super regionals — top regional seeds host best-of-3 series.',
    },
    season: 'Postseason', practice: true, conditioning: false, devAllowed: false, inSeason: true },
  SUPER_REGIONAL:    { key: 'SUPER_REGIONAL',    label: 'Super Regional',   blurb: 'Best-of-3 series. Winner advances to the World Series.',
    blurbByLevel: {
      D1:   'Super Regionals — best-of-3 series. Winners advance to the College World Series.',
      D2:   'D-II Super Regionals — best-of-3. Winners go to the D-II World Series.',
      D3:   'D-III Super Regionals — best-of-3. Winners go to the D-III World Series.',
      NWAC: 'NWAC Championship at Longview — 8-team double-elim. The winner is your champion.',
    },
    season: 'Postseason', practice: true, conditioning: false, devAllowed: false, inSeason: true },
  WORLD_SERIES:      { key: 'WORLD_SERIES',      label: 'World Series',     blurb: 'National finals.',
    blurbByLevel: {
      D1:   'College World Series at Omaha — two 4-team double-elim brackets + best-of-3 final.',
      D2:   'D-II World Series — national champion crowned.',
      D3:   'D-III World Series — national champion crowned.',
      NAIA: 'Avista NAIA World Series at Lewiston — national champion crowned.',
      NWAC: 'NWAC Championship at Longview — title round.',
    },
    season: 'Postseason', practice: true, conditioning: false, devAllowed: false, inSeason: true },
  // ── June-July: portal + draft (Wks 43-52) ───────────────────────────────
  PORTAL:            { key: 'PORTAL',            label: 'Summer Recruiting', blurb: 'Inbound + outbound transfers. Recruit from the portal. Summer ball runs in the background.',
    season: 'Summer Recruiting', practice: false, conditioning: false, devAllowed: false },
  MLB_DRAFT_WEEK:    { key: 'MLB_DRAFT_WEEK',    label: 'MLB Draft Week',   blurb: '5-12 NAIA players selected over 20 rounds.',
    season: 'Summer Recruiting', practice: false, conditioning: false, devAllowed: false },
  RECRUIT_FINALIZE:  { key: 'RECRUIT_FINALIZE',  label: 'Class Finalize',   blurb: 'Signees join the roster. Full ratings revealed.',
    season: 'Summer Recruiting', practice: false, conditioning: false, devAllowed: false },
}

/**
 * Per-LEVEL postseason layout. Most leagues run 3 playoff rounds in weeks
 * 40-42 (regular season ends wk39). Leagues with a FOURTH round (a conference
 * tournament PLUS regionals + super regionals + World Series — e.g. NCAA D2)
 * start the postseason a week earlier (wk39), so their regular season ends a
 * week sooner (wk38). NAIA + any unrecognized level keep the 3-round layout.
 *
 *   confTourney → regional → (superRegional) → ws
 */
export function postseasonLayout(level) {
  // 4-round leagues (D1 + D2 + D3) end the regular season a week earlier so
  // the conf tournament → regional → super regional → WS sequence fits in
  // wk39-42. Same calendar shape across all three — only the WS format and
  // field sizes differ.
  if (level === 'D1' || level === 'D2' || level === 'D3') {
    return { seasonEnd: 38, confTourney: 39, regional: 40, superRegional: 41, ws: 42, start: 39, rounds: 4 }
  }
  // NWAC is a 2-round playoff (regionals + final 8 at Longview) per Nate.
  // 13-week regular season (ends wk39 = season wk 13), then playoffs
  // immediately:
  //   wk 40 (season wk 14) = NWAC regionals (super regional bo3)
  //   wk 41 (season wk 15) = NWAC Championship at Longview
  // Postseason wraps wk 41 — offseason proper starts wk 42.
  if (level === 'NWAC') {
    return { seasonEnd: 39, confTourney: null, regional: 40, superRegional: null, ws: 41, start: 40, rounds: 2 }
  }
  // NAIA (and any other unrecognized level) keeps the 3-round window.
  return { seasonEnd: 39, confTourney: 40, regional: 41, superRegional: null, ws: 42, start: 40, rounds: 3 }
}

/**
 * Phase for a given week number (1–52). Source of truth for "what is week N
 * about?" — used by Dashboard, Calendar page, sim gating, etc. `level` shifts
 * the postseason window for 4-round leagues (see postseasonLayout).
 */
export function phaseForWeek(week, level) {
  const L = postseasonLayout(level)
  if (week === 1) return PHASES.TUTORIAL_SCHEDULE
  if (week === 2) return PHASES.TUTORIAL_HIRE
  if (week === 3) return PHASES.TUTORIAL_BUDGET
  if (week === 4) return PHASES.TUTORIAL_SCOUT
  if (week >= 5 && week <= 8) return PHASES.FALL_CAMP            // September — weekly
  // October = wks 9-12 collapsed into one turn.
  if (week >= 9 && week <= 12) return PHASES.OCTOBER
  // November = wks 13-17 collapsed into one turn.
  if (week >= 13 && week <= 17) return PHASES.NOVEMBER
  // December = wks 18-22 collapsed into one turn.
  if (week >= 18 && week <= 22) return PHASES.DECEMBER
  if (week >= 23 && week <= 26) return PHASES.WINTER_PRACTICE     // January
  if (week >= 27 && week <= 29) return PHASES.NON_CONFERENCE
  if (week >= 30 && week <= L.seasonEnd) return PHASES.CONFERENCE
  if (week === L.confTourney) return PHASES.CONF_TOURNAMENT
  if (week === L.regional) return PHASES.OPENING_ROUND
  if (L.superRegional && week === L.superRegional) return PHASES.SUPER_REGIONAL
  if (week === L.ws) return PHASES.WORLD_SERIES
  if (week === 48) return PHASES.MLB_DRAFT_WEEK
  if (week === 52) return PHASES.RECRUIT_FINALIZE
  if (week >= 43 && week <= 51) return PHASES.PORTAL
  return PHASES.PORTAL   // safety fallback
}

/**
 * Season-level umbrella for a week — used as the prominent banner label on
 * the dashboard. Multiple phases roll up into one season ("Fall Camp",
 * "November", "Postseason", etc.).
 */
export function seasonForWeek(week) {
  return phaseForWeek(week)?.season || 'Offseason'
}

/**
 * Has the phase changed compared to a prior week? Used by Dashboard to fire
 * a one-time popup when the user crosses a phase boundary.
 */
export function isPhaseTransition(prevWeek, nextWeek) {
  if (prevWeek == null || nextWeek == null) return false
  if (prevWeek === nextWeek) return false
  return phaseForWeek(prevWeek)?.key !== phaseForWeek(nextWeek)?.key
}

/**
 * Calendar mode derived from week — kept for back-compat with existing code
 * that reads `state.calendar.mode`.
 */
export function modeForWeek(week, level) {
  const L = postseasonLayout(level)
  if (week >= 27 && week <= L.seasonEnd) return 'SEASON'
  if (week >= L.start && week <= L.ws) return 'POSTSEASON'
  return 'OFFSEASON'
}

/** seasonWeek (regular 1..N, then postseason) — null in offseason. */
export function seasonWeekForWeek(week, level) {
  const L = postseasonLayout(level)
  if (week >= 27 && week <= L.ws) return week - 26
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
  blurb: 'Lock in your non-conference weekends for the coming spring. Conference series are auto-generated.',
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
  blurb: 'AP unlocks with a big one-time scouting budget (100 AP). Pour it into scouting recruits for next year\'s class — add them to your board, run scout trips, campus + home visits, and start extending offers to your top targets.',
  route: '/gm/recruiting',
  isComplete: (state) => (state.ap?.currentWeek ?? 0) === 0,
  doneText: ' AP spent on scouting',
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
