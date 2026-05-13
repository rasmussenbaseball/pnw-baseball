/**
 * Calendar utilities — map offseason/season weeks to real dates and human
 * labels. The dynasty starts the first week of August. Each tick = 7 days.
 *
 * Offseason structure (Aug 1 → mid-Feb):
 *   Wk 1-4    Aug         Summer — coaches free to recruit + plan schedule
 *   Wk 5-13   Sep + Oct   Fall Camp — practices, scrimmages, prospect camp window
 *   Wk 14-17  Nov         Training Period — no games, position/skill work
 *   Wk 18-21  Dec         Dead Period — limited recruiting, academics term ends
 *   Wk 22-26  Jan         Spring Practice — pre-season ramp, late scrimmages
 *
 * Season runs Feb-May (14 weeks). Postseason runs late May → June.
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
  if (offseasonWeek <= 4)  return 'Summer'
  if (offseasonWeek <= 13) return 'Fall Camp'
  if (offseasonWeek <= 17) return 'Training Period'
  if (offseasonWeek <= 21) return 'Dead Period'
  return 'Spring Practice'
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
