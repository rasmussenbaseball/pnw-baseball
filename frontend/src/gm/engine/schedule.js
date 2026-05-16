/**
 * Schedule generation, v2.
 *
 * Big concepts:
 *
 *   1. Date-anchored calendar. Conference rules specify `confStartDate` /
 *      `confEndDate`as (month, day) targets. The engine snaps to the
 *      nearest Friday >= that date for the given season year. This means
 *      Feb 20, 2027 (a Saturday) opens conf on Feb 26 (the following Friday),
 *      while Feb 20, 2028 (a Sunday) opens Feb 25. Real calendar drift.
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
 *       NAIA vs D1   midweek only, hard cap of 2/year
 *       NAIA vs D2   series allowed
 *       NAIA vs D3   series allowed
 *       NAIA vs NWAC fall/spring scrimmages ONLY (doesn't count)
 *       NAIA vs JUCO fall/spring scrimmages ONLY
 *
 *   6. NAIA season cap = 55 record-counting games. Bye weeks and scrimmages
 *      don't count.
 */

import { makeRng, hashSeed } from './rng'
import { sortByProximity, stateProximity } from './proximity'
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
 * Convert a date string ("yyyy-mm-dd") + the game-year (the August year that
 * Wk 1 falls in) to a weekOfYear (1-52). Wk 1 starts Aug 1 of `gameYear`.
 *
 * @param {string} date  yyyy-mm-dd
 * @param {number} gameYear  the August year (state.calendar.year)
 */
export function dateToWeekOfYear(date, gameYear) {
  const start = new Date(Date.UTC(gameYear, 7, 1))  // Aug 1
  const d = typeof date === 'string' ? new Date(date + 'T00:00:00Z') : new Date(date)
  const diffMs = d - start
  const wk = Math.floor(diffMs / (1000 * 60 * 60 * 24 * 7)) + 1
  return Math.max(1, Math.min(52, wk))
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

  // 10 series per team total: 7 base round-robin + 3 double-up rounds.
  // No bye weeks during conference — every Friday from confStart through
  // (confStart + 9 weeks) gets a series. confWeekFridays must have ≥10.
  const TARGET_ROUNDS = 10
  const baseRounds = Math.min(possibleRounds, confWeekFridays.length, TARGET_ROUNDS)
  const doubleUpRoundsAvailable = Math.max(0, Math.min(TARGET_ROUNDS, confWeekFridays.length) - baseRounds)
  const doubleUpRounds = doubleUpRoundsAvailable

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

  // DOUBLE-UP ROUNDS — each team plays a rotating partner a SECOND time.
  // Continue rotating the circle so each doubleUp round uses a different
  // pairing (so any given team gets 3 different doubled opponents per year).
  for (let du = 0; du < doubleUpRounds; du++) {
    const fri = confWeekFridays[baseRounds + du]
    for (let i = 0; i < n / 2; i++) {
      const a = circleArr[i]
      const b = circleArr[n - 1 - i]
      if (a === '__BYE__' || b === '__BYE__') continue
      const homeFirst = ((baseRounds + du + year + 1) % 2) === 0
      const homeId = homeFirst ? a : b
      const awayId = homeFirst ? b : a
      const seriesId = `s_${conf.id}_${year}_du${du}_${homeId}_${awayId}`
      games.push(...buildSeriesGames(
        seriesId, homeId, awayId, fri, year,
        rules.seriesLength,
        rules.seriesLength === 4 ? 'FRI_SAT_DH_SUN' : 'FRI_SAT_SUN',
        'CONFERENCE',
      ))
    }
    // Rotate for next double-up
    const fixed = circleArr[0]
    const rest = circleArr.slice(1)
    rest.unshift(rest.pop())
    circleArr = [fixed, ...rest]
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

/**
 * Minimum required fall scrimmage games per year. One doubleheader (2 games)
 * keeps the floor low while still forcing the user to schedule SOMETHING
 * during Fall Camp — otherwise the scrimmage dev boost can't fire.
 */
export const REQUIRED_FALL_SCRIMMAGE_GAMES = 2

/** Count this school's fall scrimmage games (counts both legs of a DH). */
export function countFallScrimmages(schoolId, schedule) {
  return schedule.filter(g =>
    g.type === 'FALL_SCRIMMAGE' &&
    (g.homeId === schoolId || g.awayId === schoolId),
  ).length
}

/** How many more fall scrimmage games the user is required to schedule. */
export function fallScrimmagesRequired(schoolId, schedule) {
  return Math.max(0, REQUIRED_FALL_SCRIMMAGE_GAMES - countFallScrimmages(schoolId, schedule))
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

  // Standard non-conf series — ALWAYS 3 games (FRI_SAT_SUN). Real NAIA
  // non-conference series are almost always 3-game sets; 4-game series are
  // reserved for conference weekends.
  const seriesLength = 3
  if (countRecordGames(userSchoolId, schedule) + seriesLength > NAIA_GAME_CAP) {
    return { ok: false, error: `Cannot add — would exceed the ${NAIA_GAME_CAP}-game cap.` }
  }

  const userIsHome = opts.userIsHome ?? true
  const homeId = userIsHome ? userSchoolId : opponentSchoolId
  const awayId = userIsHome ? opponentSchoolId : userSchoolId
  const fri = seasonWeekFriday(week, year)
  const seriesId = `nc_${year}_${week}_${homeId}_${awayId}_${Math.random().toString(36).slice(2, 8)}`
  const games = buildSeriesGames(seriesId, homeId, awayId, fri, year, seriesLength, 'FRI_SAT_SUN', 'NON_CONFERENCE')
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

// ─── Auto-scheduled fall games ───────────────────────────────────────────────
//
// Teams play 8 fall scrimmages every year against 4 nearby D2/D3/JUCO
// opponents (2 games each, doubleheader format). No NAIA fall opponents —
// NAIA-on-NAIA contact in the fall isn't allowed in this game's world.
// Proximity-sorted so trips stay short.

/**
 * Build the auto-scheduled fall games for a single team. Returns 8 Game
 * records spread across 4 October Fridays.
 *
 * @param {string} userSchoolId
 * @param {Object<string,School>} schools  full NAIA school table
 * @param {Array} nonNaiaTeams              flattened D2/D3/JUCO opponents
 * @param {number} year                     fall year (the Aug-Jul cycle)
 * @param {number} seed
 * @returns {Game[]}
 */
export function autoScheduleFallGames(userSchoolId, schools, nonNaiaTeams, year, seed) {
  const school = schools[userSchoolId]
  if (!school) return []
  const userState = school.state

  // Filter to D2/D3/JUCO only — no NAIA fall games per game rules.
  const eligible = nonNaiaTeams.filter(t =>
    t.division === 'D2' || t.division === 'D3' || (t.division || '').startsWith('JUCO')
  )
  const sorted = sortByProximity(userState, eligible)
  if (sorted.length === 0) return []

  // Pick 4 opponents — top 8 by proximity, then random 4 with rng so it's
  // not always the same lineup. Stable per-(school, year) seed.
  const rng = makeRng('autoFall', userSchoolId, year, seed)
  const pool = sorted.slice(0, Math.max(8, sorted.length))
  const picks = []
  while (picks.length < 4 && pool.length > 0) {
    const idx = rng.int(0, Math.min(pool.length, 8) - 1)
    picks.push(pool[idx])
    pool.splice(idx, 1)
  }

  // 4 doubleheader Fridays across October. Each DH = 2 games = same date.
  const slots = fallScrimmageSlots(year)
  const games = []
  for (let i = 0; i < Math.min(4, picks.length, slots.length); i++) {
    const opp = picks[i]
    const slot = slots[i]
    // Home/away alternates so the user gets a balanced mix.
    const homeId = i % 2 === 0 ? userSchoolId : opp.id
    const awayId = i % 2 === 0 ? opp.id : userSchoolId
    const seriesId = `autofall_${year}_${slot.date}_${userSchoolId}_${opp.id}`
    // Tag with weekOfYear so the offseason sim hook knows which week to fire
    // each doubleheader on. October Fridays land in wks 9-13 in our calendar.
    const wkOfYear = dateToWeekOfYear(slot.date, year)
    games.push({
      id: `${seriesId}_0`, year, seasonWeek: 0, weekOfYear: wkOfYear, date: slot.date,
      homeId, awayId, type: 'FALL_SCRIMMAGE', seriesId,
      countsTowardRecord: false, isDoubleheader: true,
      played: false, homeRuns: null, awayRuns: null,
      autoScheduled: true,
    })
    games.push({
      id: `${seriesId}_1`, year, seasonWeek: 0, weekOfYear: wkOfYear, date: slot.date,
      homeId, awayId, type: 'FALL_SCRIMMAGE', seriesId,
      countsTowardRecord: false, isDoubleheader: true,
      played: false, homeRuns: null, awayRuns: null,
      autoScheduled: true,
    })
  }
  return games
}

// ─── Auto-create non-conference + midweek schedule (user-facing button) ─────
//
// One-click "build me a sensible non-conf slate + a couple midweeks." Picks
// opponents semi-randomly with these constraints:
//   - At least 2 in-region (same region as user) NAIA opponents
//   - At least 1 out-of-region NAIA opponent (variety + RPI quality)
//   - Mix of home / away so the user isn't on the road for every trip
//   - Prefer closer states for any away trips (travel cost realism)
//   - Add 1-2 midweek single games (D2/D3/JUCO or NAIA), home-only to keep
//     travel cheap. D1 midweeks are NOT auto-picked (high cost + risk).
//
// Returns the list of newly-added Game records (caller pushes onto schedule).

/**
 * @param {string} userSchoolId
 * @param {string} conferenceId
 * @param {Object<string,School>} schools           full NAIA schools table
 * @param {Array} nonNaiaTeams                       flat list of D1/D2/D3/JUCO opponents
 * @param {Game[]} existingSchedule
 * @param {number} year                              season year
 * @param {number} seed
 * @returns {{ games: Game[], summary: string }}
 */
export function autoCreateSchedule(userSchoolId, conferenceId, schools, nonNaiaTeams, existingSchedule, year, seed) {
  const userSchool = schools[userSchoolId]
  if (!userSchool) return { games: [], summary: 'No user school.' }
  const userState = userSchool.state
  const userRegion = userSchool.region

  const rng = makeRng('autoSched', userSchoolId, year, seed)

  // ── Pick non-conf opponents ────────────────────────────────────────────
  // Pool = NAIA only, not in user's conference. Bucket by in-region vs
  // out-of-region, then within each bucket order by proximity to user state
  // (with a small random jitter so it's not always the same picks).
  const naiaCandidates = Object.values(schools)
    .filter(s => s.id !== userSchoolId)
    .filter(s => s.conferenceId !== conferenceId)
    .map(s => ({
      id: s.id, name: s.name, state: s.state, region: s.region,
      proximity: stateProximity(userState, s.state),
    }))

  // In-region buckets — closer first. CA + PNW states get prioritized for
  // the user (e.g. Bushnell in OR CA + WA + ID candidates float up first).
  const PRIORITY_STATES = new Set(['CA', 'OR', 'WA', 'ID', 'NV', 'MT'])
  const inRegion = naiaCandidates
    .filter(c => c.region === userRegion)
    .sort((a, b) => {
      const aPri = PRIORITY_STATES.has(a.state) ? -1 : 0
      const bPri = PRIORITY_STATES.has(b.state) ? -1 : 0
      if (aPri !== bPri) return aPri - bPri
      if (a.proximity !== b.proximity) return a.proximity - b.proximity
      return rng.next() - 0.5
    })
  const outRegion = naiaCandidates
    .filter(c => c.region !== userRegion)
    .sort((a, b) => {
      if (a.proximity !== b.proximity) return a.proximity - b.proximity
      return rng.next() - 0.5
    })

  // Find which slots are open after conference is built. Auto-fills ONLY
  // weekend slots; doesn't touch any games already on the schedule.
  const openWeeks = openNonConfWeeks(userSchoolId, conferenceId, existingSchedule, year)
  if (openWeeks.length === 0) return { games: [], summary: 'No open weeks to fill.' }

  // Pick opponents: at least 2 in-region, at least 1 out-of-region. Shuffle
  // the in-region pool slightly so the user isn't seeing the same matchups
  // year after year.
  const targetInRegion = Math.max(2, Math.min(openWeeks.length - 1, openWeeks.length - 1))
  const wantedOutRegion = 1

  /** Working copy of pools */
  const inPool = [...inRegion]
  const outPool = [...outRegion]

  // Build the assignment: alternate home/away so the user has a mix. Half
  // home / half away by default, leaning home (saves $$ early dynasty).
  const newGames = []
  const used = new Set()
  let placedIn = 0
  let placedOut = 0
  let homeCount = 0

  /**
   * Try to add a non-conf series for a slot+opponent.
   * @param {number} week
   * @param {{id:string, state:string}} opp
   * @param {boolean} userIsHome
   * @param {string} division
   */
  function tryPlace(week, opp, userIsHome, division) {
    if (used.has(opp.id)) return false
    const result = tryAddNonConfGame(
      userSchoolId, opp.id, division, week, year,
      [...existingSchedule, ...newGames],
      { userIsHome },
    )
    if (!result.ok) return false
    newGames.push(...result.games)
    used.add(opp.id)
    return true
  }

  // Sort open weeks ascending; pick home/away pattern that lands at least
  // half home (so we're not on the road for every trip).
  const sortedOpenWeeks = [...openWeeks].sort((a, b) => a.week - b.week)
  const totalSlots = sortedOpenWeeks.length
  const targetHome = Math.ceil(totalSlots / 2)   // at least half home

  for (let i = 0; i < sortedOpenWeeks.length; i++) {
    const slot = sortedOpenWeeks[i]
    const homesLeft = targetHome - homeCount
    const slotsLeft = totalSlots - i
    // Be home if we're behind on the home quota, else lean away to add
    // variety. This keeps travel cost in check while not 100% home.
    const userIsHome = homesLeft >= slotsLeft ? true
      : homesLeft <= 0 ? false
      : rng.chance(0.55)   // mild home lean

    // Out-of-region first slot for variety (only if we still need to add one)
    let placed = false
    if (placedOut < wantedOutRegion && outPool.length > 0 && i === sortedOpenWeeks.length - 1) {
      const opp = outPool.shift()
      placed = tryPlace(slot.week, opp, userIsHome, 'NAIA')
      if (placed) placedOut++
    }
    if (!placed && placedIn < targetInRegion && inPool.length > 0) {
      // Rotate to bring some variety: peel off a random one from the top 5
      const topN = Math.min(5, inPool.length)
      const idx = rng.int(0, topN - 1)
      const opp = inPool.splice(idx, 1)[0]
      placed = tryPlace(slot.week, opp, userIsHome, 'NAIA')
      if (placed) placedIn++
    }
    if (!placed && outPool.length > 0) {
      const opp = outPool.shift()
      placed = tryPlace(slot.week, opp, userIsHome, 'NAIA')
      if (placed) placedOut++
    }
    if (!placed && inPool.length > 0) {
      const opp = inPool.shift()
      placed = tryPlace(slot.week, opp, userIsHome, 'NAIA')
      if (placed) placedIn++
    }
    if (placed && userIsHome) homeCount++
  }

  // ── Pick 1-2 midweek games (NAIA-vs-NAIA singles) ─────────────────────
  // Slot them into conference weeks so the user has midweek action between
  // weekend series. Avoid D1 (cost + cap). Always home for travel sanity.
  // BUG FIX: the old path called tryAddNonConfGame (which adds 3-game
  // weekend SERIES) and only fell through to a midweek single on error,
  // so successful calls overlapped a series onto a conf week instead of
  // producing the intended single midweek game. Now we go straight to
  // buildMidweekSingle.
  const confWeeks = new Set(
    [...existingSchedule, ...newGames]
      .filter(g => (g.homeId === userSchoolId || g.awayId === userSchoolId)
                 && (g.type === 'CONFERENCE' || g.type === 'NON_CONFERENCE'))
      .map(g => g.seasonWeek),
  )
  // Spread the midweek picks across more conference weeks so we reliably
  // hit 1-2 even with chance-based skips.
  const midweekTargets = Array.from(confWeeks).sort((a, b) => a - b).slice(2, 7)
  const midweekRng = makeRng('midweek', userSchoolId, year, seed + 7)
  const midweekPool = [...inRegion.filter(c => !used.has(c.id))]
  let midweeksAdded = 0
  // Target ~1.5 midweek games. 70% chance per eligible week, capped at 2.
  for (const week of midweekTargets) {
    if (midweeksAdded >= 2) break
    if (midweekPool.length === 0) break
    if (!midweekRng.chance(0.7)) continue
    const idx = midweekRng.int(0, Math.min(midweekPool.length, 4) - 1)
    const opp = midweekPool.splice(idx, 1)[0]
    const midweekGame = buildMidweekSingle(userSchoolId, opp.id, week, year, true)
    if (countRecordGames(userSchoolId, [...existingSchedule, ...newGames]) + 1 > NAIA_GAME_CAP) {
      continue
    }
    newGames.push(midweekGame)
    used.add(opp.id)
    midweeksAdded++
  }

  const summary = `Auto-built ${newGames.filter(g => g.type === 'NON_CONFERENCE').length} non-conf games` +
    ` (${placedIn} in-region, ${placedOut} out-of-region) and ${midweeksAdded} midweek game${midweeksAdded === 1 ? '' : 's'}.`
    return { games: newGames, summary }
}

/**
 * Build a single-game midweek NAIA-vs-NAIA contest (Wednesday of `week`).
 * Used by auto-create when a regular series can't fit into a conf week.
 */
function buildMidweekSingle(userSchoolId, opponentId, week, year, userIsHome) {
  const fri = seasonWeekFriday(week, year)
  const wed = new Date(fri)
  wed.setUTCDate(wed.getUTCDate() - 2)
  const homeId = userIsHome ? userSchoolId : opponentId
  const awayId = userIsHome ? opponentId : userSchoolId
  return {
    id: `mw_${year}_${week}_${homeId}_${awayId}_${Math.random().toString(36).slice(2, 8)}`,
    year,
    seasonWeek: week,
    date: isoDate(wed),
    homeId,
    awayId,
    type: 'NON_CONFERENCE',
    seriesId: null,
    countsTowardRecord: true,
    isDoubleheader: false,
    played: false,
    homeRuns: null,
    awayRuns: null,
  }
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
