/**
 * Calendar utilities — map weeks to real dates and human labels.
 *
 * The full year is now a unified 52-week cycle starting Aug 1.
 * See gameYear.js for the canonical phase/event mapping. This module
 * retains the date-math primitives and a few legacy labels still in use.
 *
 * 52-week cycle (Aug 1 late July):
 *   Wk 1     Aug 1         Schedule (tutorial)
 *   Wk 2     Aug 8         Hire assistants (tutorial)
 *   Wk 3     Aug 15        Budget (tutorial)
 *   Wk 4     Aug 22        Scouting opens — 100 AP board-building budget
 *   Wk 5-12  Sep-Oct       Fall Camp
 *   Wk 13-22 Nov-mid Jan   Training Period (no Dec dead period anymore)
 *   Wk 23-26 mid Jan       Spring Practice
 *   Wk 27-29 Feb           Non-conference
 *   Wk 30-39 Mar-May       Conference play (10 series)
 *   Wk 40    late May      Conference Tournament
 *   Wk 41    early Jun     NAIA Opening Round
 *   Wk 42    mid Jun       NAIA World Series
 *   Wk 43-51 late Jun-Jul  Transfer Portal + recruiting active
 *   Wk 48    early Jul     MLB Draft
 *   Wk 52    late Jul      Recruiting class finalized
 */

const DYNASTY_START_MONTH = 7   // 0-indexed: August
const DYNASTY_START_DAY = 1

/**
 * Given the dynasty start year and a 0-indexed offseason week number,
 * returns a Date for the first day of that week.
 *
 * Week 1 = first week of August of the start year.
 */
export function offseasonWeekDate(startYear, offseasonWeek) {
  const base = new Date(startYear, DYNASTY_START_MONTH, DYNASTY_START_DAY)
  base.setDate(base.getDate() + (offseasonWeek - 1) * 7)
  return base
}

/**
 * Legacy phase label for an offseason week. Kept for back-compat with old
 * UI code that calls this directly. Prefer phaseForWeek(week) from
 * gameYear.js for new code — it covers all 52 weeks and matches the spine.
 *
 * Note: "Dead Period" was removed by user request; Dec weeks now collapse
 * into Training Period.
 */
export function offseasonPhase(offseasonWeek) {
  if (offseasonWeek <= 4)  return 'Summer'
  if (offseasonWeek <= 8)  return 'Fall Camp'
  // October, November, December are each a single condensed turn (wks 9/13/18).
  if (offseasonWeek <= 12) return 'October'
  if (offseasonWeek <= 17) return 'November'
  if (offseasonWeek <= 22) return 'December'
  return 'Spring Practice'
}

/**
 * Where in the offseason are we for recruiting purposes? Different phases
 * have different rules. (Dead Period removed — recruiting stays open through
 * December.)
 */
export function recruitingWindow(offseasonWeek) {
  if (offseasonWeek <= 4)  return 'INITIAL_CONTACT'
  if (offseasonWeek <= 13) return 'PRIMARY'
  if (offseasonWeek <= 22) return 'EARLY_SIGNING'
  return 'LATE_RECRUITING'
}

/**
 * Render a Date as 'Mon Aug 4'.
 */
export function formatShortDate(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}`
}

/**
 * Render the calendar's current date as a friendly string.
 *
 * @param {import('./types.js').Calendar & { startYear?: number }} calendar
 */
export function calendarDateLabel(calendar) {
  if (calendar.mode === 'OFFSEASON') {
    // Prefer the unified 52-week counter. The legacy offseasonWeek path only
    // handled weeks 1-26 (Aug-Jan); summer weeks 43-52 mapped to offseasonWeek
    // 27+ and produced nonsense dates like "Sat Jan 30" in June. weekOfYear
    // maps cleanly across the whole Aug→Jul cycle.
    if (typeof calendar.weekOfYear === 'number') {
      // Wk 1 = Aug 1 of the current academic year. calendar.year IS that
      // August start year and increments every rollover, so use it directly.
      // (calendar.startYear is the ORIGINAL dynasty start and goes stale after
      // year 1, so it must NOT be used for the live date.)
      const d = offseasonWeekDate(calendar.year, calendar.weekOfYear)
      return formatShortDate(d) + ', ' + d.getFullYear()
    }
    if (calendar.offseasonWeek) {
      const startYear = calendar.startYear ?? calendar.year
      const d = offseasonWeekDate(startYear, calendar.offseasonWeek)
      return formatShortDate(d) + ', ' + d.getFullYear()
    }
  }
  if (calendar.mode === 'SEASON' && calendar.seasonWeek) {
    return `Season Wk ${calendar.seasonWeek}, ${calendar.year + 1}`
  }
  if (calendar.mode === 'POSTSEASON') {
    return `Postseason, ${calendar.year + 1}`
  }
  return ''
}

/** Total weeks of offseason before season starts. */
export const OFFSEASON_WEEKS = 26
