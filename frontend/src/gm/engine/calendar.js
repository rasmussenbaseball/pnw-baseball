/**
 * Calendar utilities — map offseason/season weeks to real dates and human
 * labels. The dynasty starts the first week of August of the start year
 * (e.g. 2026). Each tick advances 7 days.
 *
 * Offseason structure (Aug → Jan):
 *   Wk 1-5    Aug             Summer wind-down, recruit-board opens, prospect camp planning
 *   Wk 6-9    Sep             Prospect camp window, fall ball begins
 *   Wk 10-13  Oct             Fall ball / fall scrimmages
 *   Wk 14-17  Nov             Late prospect camp, recruiting heat-up
 *   Wk 18-21  Dec             Dead period (limited recruiting), academics term ends
 *   Wk 22-25  Jan             Spring practice begins, season prep
 *   Wk 26     Late Jan/Feb    Spring scrimmages, season opens
 *
 * Season runs Feb-May (16 weeks). Postseason runs late May.
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
 * Human label for the offseason phase that contains this offseason week.
 */
export function offseasonPhase(offseasonWeek) {
  if (offseasonWeek <= 5)  return 'Summer Workouts'
  if (offseasonWeek <= 9)  return 'Fall Camp Opens'
  if (offseasonWeek <= 13) return 'Fall Ball'
  if (offseasonWeek <= 17) return 'Late Fall'
  if (offseasonWeek <= 21) return 'Dead Period'
  if (offseasonWeek <= 25) return 'Spring Practice'
  return 'Pre-Season'
}

/**
 * Where in the offseason are we for recruiting purposes? Different phases
 * have different rules (HS LOIs lock in late, dead period limits actions).
 */
export function recruitingWindow(offseasonWeek) {
  if (offseasonWeek <= 5)  return 'INITIAL_CONTACT'
  if (offseasonWeek <= 13) return 'PRIMARY'             // most actions allowed
  if (offseasonWeek <= 17) return 'EARLY_SIGNING'        // late HS commits
  if (offseasonWeek <= 21) return 'DEAD_PERIOD'          // limited
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
  if (calendar.mode === 'OFFSEASON' && calendar.offseasonWeek) {
    const startYear = calendar.startYear ?? calendar.year
    const d = offseasonWeekDate(startYear, calendar.offseasonWeek)
    return formatShortDate(d) + ', ' + d.getFullYear()
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
