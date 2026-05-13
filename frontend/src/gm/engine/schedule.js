/**
 * Schedule generation, v2.
 *
 * Big concepts:
 *
 *   1. Date-anchored calendar. Conference rules specify `confStartDate` /
 *      `confEndDate` as (month, day) targets. The engine snaps to the
 *      nearest Friday >= that date for the given season year. This means
 *      Feb 20, 2027 (a Saturday) → opens conf on Feb 26 (the following Friday),
 *      while Feb 20, 2028 (a Sunday) → opens Feb 25. Real calendar drift.
 *
 *   2. Year-rotating conference round-robin. Every team plays every other
 *      team in a `seriesLength`-game series (3 or 4 games) once a year.
 *      Home/away flips year-to-year. The opening rotation uses the circle
 *      method with a season-year offset, so opponents shift each season.
 *
 *   3. Doubleheader formats. A series of 4 games can be played as:
 *       FRI_DH_SAT_DH    Fri DH + Sat DH (2 days)
 *       FRI_SAT_DH_SUN   Fri single + Sat DH + Sun single (3 days)
 *       FRI_SAT_SUN      3-game series, one per day (only for seriesLength=3)
 *      The home team picks (per series). Default is FRI_SAT_DH_SUN for 4-game.
 *
 *   4. Scrimmages. 10 total per year, played in fall (Sep-Nov) or spring
 *      pre-season ("week 0", typically late January). Doubleheaders only.
 *      Against any opponent. Don't count toward record.
 *
 *   5. Cross-division rules:
 *       NAIA vs D1   → midweek only, hard cap of 2/year
 *       NAIA vs D2   → series allowed
 *       NAIA vs D3   → series allowed
 *       NAIA vs NWAC → fall/spring scrimmages ONLY (doesn't count)
 *       NAIA vs JUCO → fall/spring scrimmages ONLY
 *
 *   6. NAIA season cap = 55 record-counting games. Bye weeks and scrimmages
 *      don't count.
 */

import { makeRng, hashSeed } from './rng'
import confRulesRaw from '../data/conference_rules.json'

/** @typedef {import('./types.js').Conference} Conference */
/** @typedef {import('./types.js').School} School */

/** @typedef Game
 *  @property {string} id
 *  @property {number} year
 *  @property {number} seasonWeek            // 1-N (computed from date)
 *  @property {string} date                  // yyyy-mm-dd
 *  @property {string} homeId
 *  @property {string} awayId
 *  @property {'CONFERENCE'|'NON_CONFERENCE'|'D1_MIDWEEK'|'FALL_SCRIMMAGE'|'SPRING_SCRIMMAGE'|'BYE'|'POSTSEASON'} type
 *  @property {string|null} seriesId
 *  @property {boolean} countsTowardRecord
 *  @property {boolean} isDoubleheader       // true for both halves of a DH
 *  @property {boolean} played
 *  @property {number|null} homeRuns
 *  @property {number|null} awayRuns
 */

// ─── Constants ───────────────────────────────────────────────────────────────

export const NAIA_GAME_CAP = confRulesRaw.naiaGameCap || 55
export const NAIA_SCRIMMAGE_CAP = confRulesRaw.naiaScrimmageCap || 10
export const NAIA_D1_MIDWEEK_CAP = confRulesRaw.naiaD1MidweekCap || 2

export function getConferenceRules(conferenceId) {
  return confRulesRaw.rules[conferenceId] || confRulesRaw.default
}

// ─── Date helpers ────────────────────────────────────────────────────────────
//
// ALL of the schedule's calendar math uses UTC. Mixing local and UTC was a
// real bug: across the US daylight-saving boundary (mid-March), a 35-day
// interval measured as ms drifted from 35 × 86,400,000 ms by 1 hour, which
// floor-divided by a week falls onto the previous bucket — so a Friday game
// after DST jumped backwards a week from the rest of its weekend series.
// Using UTC throughout removes any timezone shift.

/**
 * Build a UTC Date for given (year, month, day). 1-indexed month.
 */
function ymdDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day))
}

/**
 * Find the nearest Friday on or AFTER the target date. Used to snap a
 * "Feb 20" target to the next Fri of that calendar week.
 */
function snapToFriday(date) {
  const d = new Date(date)
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1)
  return d
}

/**
 * ISO yyyy-mm-dd from a Date.
 */
function isoDate(d) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Add N days to an ISO date string.
 */
function addDays(isoStr, n) {
  const d = new Date(isoStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return isoDate(d)
}

/**
 * For a conference rule + season year, return the start/end Fridays.
 */
function conferenceWindow(conferenceId, year) {
  const rules = getConferenceRules(conferenceId)
  const startTarget = ymdDate(year, rules.confStartDate.month, rules.confStartDate.day)
  const endTarget = ymdDate(year, rules.confEndDate.month, rules.confEndDate.day)
  const startFri = snapToFriday(startTarget)
  const endFri = snapToFriday(endTarget)
  return { startFri, endFri, rules }
}

/**
 * Season week 1 = first Friday on/after Feb 1 of the season year.
 * Week timeline:
 *   Wk 1-3   pre-conf non-conference
 *   Wk 4-13  conference regular season
 *   Wk 14    conference tournament
 *   Wk 15    Opening Round (regionals)
 *   Wk 16    NAIA World Series
 */
function seasonWeek1Friday(year) {
  return snapToFriday(ymdDate(year, 2, 1))
}

/** Last week of the regular season; postseason starts the following week. */
export const REGULAR_SEASON_LAST_WEEK = 13

/**
 * Compute season week (1-N) from a Date or ISO string. Both sides parsed
 * as UTC so DST shifts don't fold a Friday game into the previous week.
 */
export function dateToSeasonWeek(date, year) {
  const w1 = seasonWeek1Friday(year)
  const d = typeof date === 'string' ? new Date(date + 'T00:00:00Z') : new Date(date)
  const diffMs = d - w1
  return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 7)) + 1
}

/**
 * Get the Friday-of-week-N Date.
 */
function seasonWeekFriday(week, year) {
  const w1 = seasonWeek1Friday(year)
  const d = new Date(w1)
  d.setUTCDate(d.getUTCDate() + (week - 1) * 7)
  return d
}

/**
 * Public: get Friday of season week N as ISO string. Used by UI.
 */
export function weekToDateApprox(week, year) {
  return isoDate(seasonWeekFriday(week, year))
}

// ─── Series builder (handles doubleheader formats) ───────────────────────────

/**
 * Build the games of a single series given a start-Friday and format.
 *
 * @param {string} seriesId
 * @param {string} homeId
 * @param {string} awayId
 * @param {Date} startFri
 * @param {number} year
 * @param {number} seriesLength        // 3 or 4
 * @param {'FRI_DH_SAT_DH'|'FRI_SAT_DH_SUN'|'FRI_SAT_SUN'} format
 * @param {'CONFERENCE'|'NON_CONFERENCE'} type
 * @returns {Game[]}
 */
function buildSeriesGames(seriesId, homeId, awayId, startFri, year, seriesLength, format, type) {
  const startIso = isoDate(startFri)
  const out = []

  // Date offsets per game in the series (relative to Friday)
  let datesAndDH
  if (seriesLength === 3) {
    datesAndDH = [
      { offset: 0, isDH: false },   // Fri
      { offset: 1, isDH: false },   // Sat
      { offset: 2, isDH: false },   // Sun
    ]
  } else if (format === 'FRI_DH_SAT_DH') {
    datesAndDH = [
      { offset: 0, isDH: true },    // Fri G1
      { offset: 0, isDH: true },    // Fri G2
      { offset: 1, isDH: true },    // Sat G1
      { offset: 1, isDH: true },    // Sat G2
    ]
  } else {
    // FRI_SAT_DH_SUN (default for 4-game)
    datesAndDH = [
      { offset: 0, isDH: false },   // Fri
      { offset: 1, isDH: true },    // Sat G1
      { offset: 1, isDH: true },    // Sat G2
      { offset: 2, isDH: false },   // Sun
    ]
  }

  datesAndDH.forEach((slot, i) => {
    out.push({
      id: `g_${seriesId}_${i}`,
      year,
      seasonWeek: dateToSeasonWeek(addDays(startIso, slot.offset), year),
      date: addDays(startIso, slot.offset),
      homeId,
      awayId,
      type,
      seriesId,
      countsTowardRecord: type === 'CONFERENCE' || type === 'NON_CONFERENCE' || type === 'D1_MIDWEEK',
      isDoubleheader: slot.isDH,
      played: false,
      homeRuns: null,
      awayRuns: null,
    })
  })
  return out
}

// ─── Conference round-robin with year rotation ───────────────────────────────

/**
 * Build a single conference's full season schedule for a given year.
 *
 * Year-rotation:
 *   - Every team plays every other team in 1 series per year (base round-robin)
 *   - Each team ALSO plays one rotating "double-up" partner twice per year
 *     (so they face that opponent in 2 series — typical NAIA conf reality)
 *   - The double-up partner cycles year-to-year
 *   - Home/away flips year-to-year
 *
 * For an 8-team conference: 7 base series + 1 doubled series = 8 series total
 * (32 games at 4-game series length). Matches Bushnell's ~32 conf games.
 */
function buildConferenceSchedule(conf, schools, year, seed) {
  const teams = [...conf.schoolIds].filter(id => schools[id])
  if (teams.length < 2) return []
  const { startFri, endFri, rules } = conferenceWindow(conf.id, year)

  const confWeekFridays = []
  const cursor = new Date(startFri)
  while (cursor <= endFri) {
    confWeekFridays.push(new Date(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 7)
  }

  const list = [...teams]
  if (list.length % 2 === 1) list.push('__BYE__')
  const n = list.length
  const possibleRounds = n - 1

  // Year-offset rotation
  const yearOffset = Math.abs(year - 2027) % possibleRounds
  const arr = [...list]
  for (let r = 0; r < yearOffset; r++) {
    const fixed = arr[0]
    const rest = arr.slice(1)
    rest.unshift(rest.pop())
    arr.splice(0, arr.length, fixed, ...rest)
  }

  // We need possibleRounds + N/2 weeks to fit all base + double-up series.
  // (Each "double-up week" adds another full round of pairings.)
  const baseRounds = Math.min(possibleRounds, confWeekFridays.length)
  const doubleUpRoundsAvailable = Math.max(0, confWeekFridays.length - baseRounds)
  // Cap double-up to 1 round per pair per year (real-world common pattern)
  const doubleUpRounds = Math.min(doubleUpRoundsAvailable, 1)

  const games = []

  // BASE ROUND-ROBIN — each team plays every other team in 1 series
  let circleArr = [...arr]
  for (let round = 0; round < baseRounds; round++) {
    const fri = confWeekFridays[round]
    for (let i = 0; i < n / 2; i++) {
      const a = circleArr[i]
      const b = circleArr[n - 1 - i]
      if (a === '__BYE__' || b === '__BYE__') continue
      const homeFirst = ((round + year) % 2) === 0
      const homeId = homeFirst ? a : b
      const awayId = homeFirst ? b : a
      const seriesId = `s_${conf.id}_${year}_${round}_${homeId}_${awayId}`
      games.push(...buildSeriesGames(
        seriesId, homeId, awayId, fri, year,
        rules.seriesLength,
        rules.seriesLength === 4 ? 'FRI_SAT_DH_SUN' : 'FRI_SAT_SUN',
        'CONFERENCE',
      ))
    }
    // Rotate
    const fixed = circleArr[0]
    const rest = circleArr.slice(1)
    rest.unshift(rest.pop())
    circleArr = [fixed, ...rest]
  }

  // DOUBLE-UP ROUND — each team plays one rotating partner a SECOND time.
  // We use the rotation that occurs (year + possibleRounds) rounds in, so each
  // year's double-up matchups shift across the conference's pair list.
  if (doubleUpRounds > 0) {
    // After baseRounds of rotation, we've already advanced the circle. Take
    // the current matchup as the doubled series.
    const fri = confWeekFridays[baseRounds]
    for (let i = 0; i < n / 2; i++) {
      const a = circleArr[i]
      const b = circleArr[n - 1 - i]
      if (a === '__BYE__' || b === '__BYE__') continue
      // Home/away flip: opposite of what they did in base round
      // (so if A hosted B in base, B hosts A in double)
      const homeFirst = ((baseRounds + year + 1) % 2) === 0
      const homeId = homeFirst ? a : b
      const awayId = homeFirst ? b : a
      const seriesId = `s_${conf.id}_${year}_du_${homeId}_${awayId}`
      games.push(...buildSeriesGames(
        seriesId, homeId, awayId, fri, year,
        rules.seriesLength,
        rules.seriesLength === 4 ? 'FRI_SAT_DH_SUN' : 'FRI_SAT_SUN',
        'CONFERENCE',
      ))
    }
  }

  return games
}

/**
 * Generate the full conference schedule for every conference.
 * @returns {Game[]}
 */
export function buildAllConferenceSchedules(conferences, schools, year, seed) {
  const out = []
  for (const conf of Object.values(conferences)) {
    out.push(...buildConferenceSchedule(conf, schools, year, seed))
  }
  return out
}

// ─── Non-conference open windows ─────────────────────────────────────────────

/**
 * Find season weeks that are "open" for non-conference scheduling for a given team.
 * @param {string} schoolId
 * @param {string} conferenceId
 * @param {Game[]} schedule
 * @param {number} year
 * @returns {Array<{ week: number, date: string }>}
 */
export function openNonConfWeeks(schoolId, conferenceId, schedule, year) {
  const { startFri, endFri } = conferenceWindow(conferenceId, year)
  const confStartWeek = dateToSeasonWeek(startFri, year)
  const confEndWeek = dateToSeasonWeek(endFri, year)

  const occupied = new Set(
    schedule
      .filter(g => (g.homeId === schoolId || g.awayId === schoolId) && g.type !== 'D1_MIDWEEK')
      .map(g => g.seasonWeek),
  )
  // ANY week 1..REGULAR_SEASON_LAST_WEEK that doesn't already have a game is
  // open for non-conf scheduling. The conference series only fill 7-8 weeks
  // of the conference window; the remaining weeks (mid-week byes inside the
  // conference window, plus weeks after conference play wraps) can host
  // non-conf series or byes — same as real-world NAIA midweek byes.
  const out = []
  for (let w = 1; w <= REGULAR_SEASON_LAST_WEEK; w++) {
    if (!occupied.has(w)) out.push({ week: w, date: weekToDateApprox(w, year) })
  }
  return out
}

// ─── Cross-division eligibility ─────────────────────────────────────────────

/**
 * @returns {{ allowed: boolean, reason?: string, mustBeMidweek?: boolean, mustBeScrimmage?: boolean }}
 */
export function checkOpponentEligibility(opponentDivision) {
  if (opponentDivision === 'NAIA') return { allowed: true }
  if (opponentDivision === 'D1') {
    return {
      allowed: true,
      mustBeMidweek: true,
      reason: `NAIA vs D1 is midweek only — hard cap of ${NAIA_D1_MIDWEEK_CAP}/year.`,
    }
  }
  if (opponentDivision === 'D2' || opponentDivision === 'D3') {
    return { allowed: true }
  }
  if (opponentDivision === 'JUCO_NWAC' || opponentDivision.startsWith('JUCO')) {
    return {
      allowed: true,
      mustBeScrimmage: true,
      reason: 'NWAC/JUCO games are scrimmages only (fall or spring pre-season). Do not count toward record.',
    }
  }
  return { allowed: true }
}

// ─── Game-count helpers ──────────────────────────────────────────────────────

export function countRecordGames(schoolId, schedule) {
  return schedule.filter(g =>
    g.countsTowardRecord !== false &&
    (g.homeId === schoolId || g.awayId === schoolId),
  ).length
}

export function countD1Midweeks(schoolId, schedule) {
  return schedule.filter(g =>
    g.type === 'D1_MIDWEEK' &&
    (g.homeId === schoolId || g.awayId === schoolId),
  ).length
}

export function countScrimmages(schoolId, schedule) {
  return schedule.filter(g =>
    (g.type === 'FALL_SCRIMMAGE' || g.type === 'SPRING_SCRIMMAGE') &&
    (g.homeId === schoolId || g.awayId === schoolId),
  ).length
}

export function gamesRemaining(schoolId, schedule) {
  return Math.max(0, NAIA_GAME_CAP - countRecordGames(schoolId, schedule))
}

export function scrimmagesRemaining(schoolId, schedule) {
  return Math.max(0, NAIA_SCRIMMAGE_CAP - countScrimmages(schoolId, schedule))
}

export function d1MidweeksRemaining(schoolId, schedule) {
  return Math.max(0, NAIA_D1_MIDWEEK_CAP - countD1Midweeks(schoolId, schedule))
}

// ─── Non-conference adds ─────────────────────────────────────────────────────

/**
 * Add a non-conference game/series. Validates cross-division rules + caps.
 *
 * @param {string} userSchoolId
 * @param {string} opponentSchoolId
 * @param {string} opponentDivision
 * @param {number} week                  // season week
 * @param {number} year
 * @param {Game[]} schedule              // existing schedule, for cap checks
 * @param {{ userIsHome?: boolean, format?: 'FRI_DH_SAT_DH'|'FRI_SAT_DH_SUN'|'FRI_SAT_SUN', preferMidweek?: boolean }} [opts]
 * @returns {{ ok: boolean, games?: Game[], error?: string, info?: string }}
 */
export function tryAddNonConfGame(userSchoolId, opponentSchoolId, opponentDivision, week, year, schedule, opts = {}) {
  const elig = checkOpponentEligibility(opponentDivision)
  if (!elig.allowed) return { ok: false, error: elig.reason }

  // Scrimmage path (NWAC/JUCO)
  if (elig.mustBeScrimmage) {
    return { ok: false, error: 'Use the scrimmage scheduler for NWAC/JUCO opponents (fall or spring pre-season).' }
  }

  // D1 midweek path
  if (elig.mustBeMidweek) {
    if (d1MidweeksRemaining(userSchoolId, schedule) === 0) {
      return { ok: false, error: `D1 midweek cap reached (${NAIA_D1_MIDWEEK_CAP}/year).` }
    }
    return addD1Midweek(userSchoolId, opponentSchoolId, week, year, opts.userIsHome ?? true)
  }

  // Standard non-conf series (NAIA vs NAIA, NAIA vs D2/D3)
  // Cap check: don't allow series that pushes over 55
  const seriesLength = opts.format === 'FRI_SAT_SUN' ? 3 : 4
  if (countRecordGames(userSchoolId, schedule) + seriesLength > NAIA_GAME_CAP) {
    return { ok: false, error: `Cannot add — would exceed the ${NAIA_GAME_CAP}-game cap.` }
  }

  const userIsHome = opts.userIsHome ?? true
  const homeId = userIsHome ? userSchoolId : opponentSchoolId
  const awayId = userIsHome ? opponentSchoolId : userSchoolId
  const fri = seasonWeekFriday(week, year)
  const seriesId = `nc_${year}_${week}_${homeId}_${awayId}_${Math.random().toString(36).slice(2, 8)}`
  const format = opts.format || (seriesLength === 4 ? 'FRI_SAT_DH_SUN' : 'FRI_SAT_SUN')
  const games = buildSeriesGames(seriesId, homeId, awayId, fri, year, seriesLength, format, 'NON_CONFERENCE')
  return { ok: true, games }
}

/**
 * Add a single midweek D1 game (Tuesday or Wednesday).
 */
function addD1Midweek(userSchoolId, opponentSchoolId, week, year, userIsHome) {
  const fri = seasonWeekFriday(week, year)
  // Midweek = Wednesday of that week (Fri - 2 days)
  const wed = new Date(fri)
  wed.setUTCDate(wed.getUTCDate() - 2)

  const homeId = userIsHome ? userSchoolId : opponentSchoolId
  const awayId = userIsHome ? opponentSchoolId : userSchoolId
  const game = {
    id: `d1mw_${year}_${week}_${homeId}_${awayId}_${Math.random().toString(36).slice(2, 8)}`,
    year,
    seasonWeek: week,
    date: isoDate(wed),
    homeId,
    awayId,
    type: 'D1_MIDWEEK',
    seriesId: null,
    countsTowardRecord: true,
    isDoubleheader: false,
    played: false,
    homeRuns: null,
    awayRuns: null,
  }
  return { ok: true, games: [game], info: 'D1 midweek scheduled. Counts toward your 55-game cap.' }
}

// ─── Bye week ────────────────────────────────────────────────────────────────

export function addByeWeek(schoolId, week, year) {
  return {
    id: `bye_${schoolId}_${year}_${week}`,
    year,
    seasonWeek: week,
    date: weekToDateApprox(week, year),
    homeId: schoolId,
    awayId: '__BYE__',
    type: 'BYE',
    seriesId: null,
    countsTowardRecord: false,
    isDoubleheader: false,
    played: false,
    homeRuns: null,
    awayRuns: null,
  }
}

// ─── Scrimmage system ────────────────────────────────────────────────────────

/**
 * Default fall scrimmage dates: Fridays in October.
 * Doubleheaders against single opponents = 2 games per slot.
 */
export function fallScrimmageSlots(year) {
  // Friday(s) of October. Start at first Friday of October.
  const out = []
  const oct1 = ymdDate(year, 10, 1)
  const firstFri = snapToFriday(oct1)
  const cursor = new Date(firstFri)
  for (let i = 0; i < 5; i++) {   // up to 5 Fridays in October
    if (cursor.getUTCMonth() !== 9) break
    out.push({
      date: isoDate(cursor),
      label: `Oct DH ${i + 1}`,
    })
    cursor.setUTCDate(cursor.getUTCDate() + 7)
  }
  return out
}

/**
 * Default spring scrimmage slots: Saturday(s) of the last weekend(s) of January.
 */
export function springScrimmageSlots(year) {
  const out = []
  // Find Saturdays in mid-to-late January
  const jan15 = ymdDate(year, 1, 15)
  let cursor = snapToFriday(jan15)
  cursor.setUTCDate(cursor.getUTCDate() + 1) // Saturday
  for (let i = 0; i < 3; i++) {
    if (cursor.getUTCMonth() !== 0) break
    out.push({
      date: isoDate(cursor),
      label: `Jan DH ${i + 1}`,
    })
    cursor.setUTCDate(cursor.getUTCDate() + 7)
  }
  return out
}

/**
 * Add a fall or spring scrimmage doubleheader (2 games against the same opponent).
 *
 * @param {string} userSchoolId
 * @param {string} opponentId
 * @param {string} opponentDivision
 * @param {string} date            // yyyy-mm-dd
 * @param {number} year
 * @param {Game[]} schedule
 * @param {'FALL'|'SPRING'} season
 * @returns {{ ok: boolean, games?: Game[], error?: string }}
 */
export function tryAddScrimmage(userSchoolId, opponentId, opponentDivision, date, year, schedule, season) {
  const remaining = scrimmagesRemaining(userSchoolId, schedule)
  if (remaining < 2) {
    return { ok: false, error: `Only ${remaining} scrimmage(s) left. Doubleheaders need 2.` }
  }
  const type = season === 'FALL' ? 'FALL_SCRIMMAGE' : 'SPRING_SCRIMMAGE'
  const homeId = userSchoolId   // Scrimmages typically at home or alternating
  const awayId = opponentId
  const seriesId = `scrim_${year}_${date}_${userSchoolId}_${opponentId}`
  const games = [
    {
      id: `${seriesId}_0`,
      year,
      seasonWeek: 0,    // not a real season week
      date,
      homeId,
      awayId,
      type,
      seriesId,
      countsTowardRecord: false,
      isDoubleheader: true,
      played: false, homeRuns: null, awayRuns: null,
    },
    {
      id: `${seriesId}_1`,
      year,
      seasonWeek: 0,
      date,
      homeId,
      awayId,
      type,
      seriesId,
      countsTowardRecord: false,
      isDoubleheader: true,
      played: false, homeRuns: null, awayRuns: null,
    },
  ]
  return { ok: true, games }
}

// ─── Auto-fill (default starting schedule) ───────────────────────────────────

/**
 * Auto-fill non-conference series for the user team at dynasty creation.
 * Conservative — picks regional NAIA opponents for some open weeks.
 *
 * @param {string} schoolId
 * @param {Object<string,School>} schools
 * @param {Object<string,Conference>} conferences
 * @param {Game[]} confGames
 * @param {Object<string,import('./rankings.js').TeamRating>} ratings
 * @param {number} year
 * @param {number} seed
 * @returns {Game[]}
 */
export function autoFillNonConference(schoolId, schools, conferences, confGames, ratings, year, seed) {
  const school = schools[schoolId]
  if (!school) return []
  const rng = makeRng('nc', schoolId, year, seed)
  const myRating = ratings[schoolId]?.overall_rating ?? 0

  // Candidates: other NAIA programs (not from same conference), regional preferred
  const candidates = Object.values(schools)
    .filter(s => s.id !== schoolId)
    .filter(s => s.conferenceId !== school.conferenceId)
    .map(s => ({
      school: s,
      sameRegion: s.region === school.region,
      strengthDiff: Math.abs((ratings[s.id]?.overall_rating ?? 0) - myRating),
    }))
    .sort((a, b) => {
      if (a.sameRegion !== b.sameRegion) return a.sameRegion ? -1 : 1
      return a.strengthDiff - b.strengthDiff
    })
    .slice(0, 25)

  const openWeeks = openNonConfWeeks(schoolId, school.conferenceId, confGames, year)
  const out = []

  for (const slot of openWeeks) {
    if (candidates.length === 0) break
    if (countRecordGames(schoolId, [...confGames, ...out]) + 4 > NAIA_GAME_CAP) break
    const idx = rng.int(0, Math.min(candidates.length - 1, 5))
    const opp = candidates.splice(idx, 1)[0]
    const userIsHome = rng.chance(0.5)
    const result = tryAddNonConfGame(
      schoolId, opp.school.id, 'NAIA',
      slot.week, year, [...confGames, ...out],
      { userIsHome },
    )
    if (result.ok) out.push(...result.games)
  }
  return out
}
