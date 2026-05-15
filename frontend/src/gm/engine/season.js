/**
 * Season loop — runs a single week (or all remaining weeks) of games,
 * updates standings, recomputes rankings, ticks pitcher rest.
 *
 * Two tiers of fidelity (see sim.md):
 *   - Full PA-level sim for games involving the user's team
 *   - Fast monte-carlo sim for all other games in the league
 */

import { simGame, fastSimGame, defaultLineup } from './sim'
import { resolveLineupForGame, lineupPlayerIds, getSavedLineup } from './lineups'
import { computeFromSeason, seedFromPear } from './rankings'
import { applyScrimmageDev } from './development'
import { simAllConferenceTournaments } from './tournament'
import { runNationalTournament } from './nationalTournament'
import { playerOverall } from './playerRating'
import { tickHappiness } from './happiness'
import { tickTeamGPAWeekly } from './academics'
import { runEventsForWeek } from './events'
import { buildAllConferenceSchedules, autoScheduleFallGames, dateToWeekOfYear } from './schedule'
import { OFFSEASON_WEEKS } from './calendar'
import { WEEKS_PER_YEAR, modeForWeek, seasonWeekForWeek, ensureUnifiedCalendar } from './gameYear'
import { rollGameInjury, rollPracticeInjury, tickInjuries, applyInjury, isInjured, clearAllInjuriesForNewSeason } from './injuries'
import { makeRng } from './rng'
import nonNaiaRaw from '../data/non_naia_teams.json'

function zeroStats(isPitcher) {
  if (isPitcher) return { ip: 0, h: 0, bb: 0, k: 0, er: 0, outs: 0, pa: 0, gamesPlayed: 0 }
  return { ab: 0, h: 0, d: 0, t: 0, hr: 0, bb: 0, k: 0, rbi: 0, pa: 0, gamesPlayed: 0 }
}

// Build a one-time lookup table for non-NAIA opponents (D1/D2/D3/JUCO)
// keyed by their team id. Each entry has a strength rating used as a
// fallback when one of these teams appears in the schedule.
const NON_NAIA_LOOKUP = (() => {
  const out = {}
  for (const div of nonNaiaRaw.divisions) {
    for (const t of div.teams) {
      out[t.id] = { ...t, division: div.id }
    }
  }
  return out
})()

/** @typedef {import('./types.js').SaveState} SaveState */
/** @typedef {import('./schedule.js').Game} Game */

/**
 * Sim a single week of games.
 * Mutates the SaveState in place. Returns a summary.
 *
 * @param {SaveState} state
 * @param {Game[]} schedule
 * @param {import('./types.js').TeamRating} [ratings]   // current ratings (used for fast sim)
 * @returns {{ gamesPlayed: number, userResults: Array }}
 */
export function simWeek(state, schedule, ratings) {
  const targetWeek = state.calendar.seasonWeek
  const targetWeekOfYear = state.calendar.weekOfYear
  const userSchoolId = state.userSchoolId
  const userResults = []
  let gamesPlayed = 0

  for (const g of schedule) {
    if (g.played) continue
    // Match by seasonWeek (regular-season + postseason games) OR by
    // weekOfYear (fall scrimmages live in offseason wks 9-13 where
    // seasonWeek is null). Legacy games without weekOfYear fall through to
    // seasonWeek matching.
    const matchesSeason = targetWeek != null && g.seasonWeek === targetWeek
    let gameWeekOfYear = g.weekOfYear
    if (gameWeekOfYear == null && g.date && g.type === 'FALL_SCRIMMAGE') {
      // Derive on the fly for old saves
      gameWeekOfYear = dateToWeekOfYear(g.date, state.calendar.year)
    }
    const matchesWeekOfYear = gameWeekOfYear != null && targetWeekOfYear != null
      && gameWeekOfYear === targetWeekOfYear
    if (!matchesSeason && !matchesWeekOfYear) continue
    if (g.type === 'BYE') { g.played = true; continue }   // bye weeks just tick through

    const isUserGame = g.homeId === userSchoolId || g.awayId === userSchoolId
    const homeTeam = state.teams[g.homeId]
    const awayTeam = state.teams[g.awayId]

    // If neither side is the user and either team is missing (e.g. a non-NAIA
    // opponent we don't simulate), skip — only user games can involve non-NAIA.
    if (!isUserGame && (!homeTeam || !awayTeam)) continue
    // For user games involving a non-NAIA opponent, the user's side has a
    // real team; the other side is a static strength rating.

    let result
    if (isUserGame && homeTeam && awayTeam) {
      // Both sides are real NAIA teams — full sim. Use the user's saved
      // lineup if they set one (fall scrimmages, regular-season games they
      // micromanaged); otherwise fall back to defaultLineup (top-9 + top-5).
      const homeLineup = g.homeId === userSchoolId
        ? resolveLineupForGame(state, userSchoolId, g.id)
        : defaultLineup(homeTeam, state.players)
      const awayLineup = g.awayId === userSchoolId
        ? resolveLineupForGame(state, userSchoolId, g.id)
        : defaultLineup(awayTeam, state.players)
      const homeHC = state.coaches[homeTeam.headCoachId]
      const awayHC = state.coaches[awayTeam.headCoachId]
      result = simGame(homeLineup, awayLineup, {
        homeMotivator: homeHC?.motivator ?? 50,
        awayMotivator: awayHC?.motivator ?? 50,
      }, g.id)
    } else if (isUserGame) {
      // User vs. non-NAIA opponent — fast sim against static strength
      const userIsHome = g.homeId === userSchoolId
      const userRating = ratings?.[userSchoolId] ?? { overall_rating: 0, offense_rating: 0, pitching_rating: 0 }
      const nonNaiaId = userIsHome ? g.awayId : g.homeId
      const nonNaiaInfo = NON_NAIA_LOOKUP[nonNaiaId]
      const oppRating = {
        overall_rating: nonNaiaInfo?.strength ?? 0,
        offense_rating: (nonNaiaInfo?.strength ?? 0) * 0.5,
        pitching_rating: (nonNaiaInfo?.strength ?? 0) * 0.5,
      }
      result = userIsHome
        ? fastSimGame(userRating, oppRating, g.id)
        : fastSimGame(oppRating, userRating, g.id)
    } else {
      result = fastSimGame(
        ratings?.[g.homeId] ?? { overall_rating: 0, offense_rating: 0, pitching_rating: 0 },
        ratings?.[g.awayId] ?? { overall_rating: 0, offense_rating: 0, pitching_rating: 0 },
        g.id,
      )
    }

    g.homeRuns = result.homeRuns
    g.awayRuns = result.awayRuns
    g.played = true
    gamesPlayed++

    // Accumulate per-player season stats from this game's boxscore.
    // Fall scrimmages go into a separate state.fallStats[year] bucket so
    // they don't pollute the official spring stat line, but still surface
    // in the post-fall report.
    if (result.boxscore?.batterStats) {
      const isFall = g.type === 'FALL_SCRIMMAGE'
      const isSpring = g.type === 'SPRING_SCRIMMAGE'
      if (isFall) {
        if (!state.fallStats) state.fallStats = {}
        const yr = state.calendar?.year ?? g.year
        if (!state.fallStats[yr]) state.fallStats[yr] = {}
      } else {
        if (!state.playerStats) state.playerStats = {}
      }
      const accumulate = (statsObj, isPitcher) => {
        for (const [pid, s] of Object.entries(statsObj)) {
          const key = isPitcher ? `p_${pid}` : `b_${pid}`
          let target
          if (isFall) {
            const yr = state.calendar?.year ?? g.year
            if (!state.fallStats[yr][key]) state.fallStats[yr][key] = { playerId: pid, isPitcher, ...zeroStats(isPitcher) }
            target = state.fallStats[yr][key]
          } else {
            if (!state.playerStats[key]) state.playerStats[key] = { playerId: pid, isPitcher, ...zeroStats(isPitcher) }
            target = state.playerStats[key]
            // Spring scrimmages still count toward spring playerStats per
            // existing behavior (only fall is split off).
          }
          for (const k of Object.keys(s)) target[k] = (target[k] || 0) + s[k]
          // gamesPlayed: a single appearance in this game counts as 1.
          target.gamesPlayed = (target.gamesPlayed || 0) + 1
        }
      }
      accumulate(result.boxscore.batterStats, false)
      accumulate(result.boxscore.pitcherStats, true)
    }

    // ── Injury rolls — only for the user's team players who appeared in
    // the game. Non-user teams skip injury rolls to keep state small +
    // perf high. Game injuries are surfaced via state._newInjuriesThisWeek
    // so the dashboard WeekRecap can highlight them.
    if (isUserGame && result.boxscore) {
      const rngInj = makeRng('injury', g.id, state.rngSeed)
      const userTeamForInj = state.teams[userSchoolId]
      if (!state._newInjuriesThisWeek) state._newInjuriesThisWeek = []
      const battersThisGame = result.boxscore.batterStats || {}
      const pitchersThisGame = result.boxscore.pitcherStats || {}
      // Hitter rolls
      for (const pid of Object.keys(battersThisGame)) {
        if (!userTeamForInj.rosterPlayerIds.includes(pid)) continue
        const player = state.players[pid]
        if (!player) continue
        const s = battersThisGame[pid]
        const template = rollGameInjury(player, { gamePa: s.pa || 0 }, rngInj)
        if (template) {
          const injury = applyInjury(player, template, {
            context: g.type === 'FALL_SCRIMMAGE' ? 'FALL_SCRIMMAGE' : 'GAME',
            week: state.calendar?.weekOfYear,
            year: state.calendar?.year,
            rng: rngInj,
          })
          state._newInjuriesThisWeek.push({ playerId: pid, injury })
          state.newsfeed.unshift({
            id: `inj_${pid}_${state.calendar?.year}_${state.calendar?.weekOfYear}`,
            year: state.calendar?.year, week: state.calendar?.week, type: 'INJURY',
            headline: `🩼 ${player.firstName} ${player.lastName} — ${injury.label} (${injury.totalWeeks} wk${injury.totalWeeks === 1 ? '' : 's'}). ${injury.blurb}`,
            payload: { playerId: pid, injuryType: injury.type, weeks: injury.totalWeeks },
          })
        }
      }
      // Pitcher rolls
      for (const pid of Object.keys(pitchersThisGame)) {
        if (!userTeamForInj.rosterPlayerIds.includes(pid)) continue
        const player = state.players[pid]
        if (!player) continue
        const s = pitchersThisGame[pid]
        const template = rollGameInjury(player, { gameIp: s.ip || 0 }, rngInj)
        if (template) {
          const injury = applyInjury(player, template, {
            context: g.type === 'FALL_SCRIMMAGE' ? 'FALL_SCRIMMAGE' : 'GAME',
            week: state.calendar?.weekOfYear,
            year: state.calendar?.year,
            rng: rngInj,
          })
          state._newInjuriesThisWeek.push({ playerId: pid, injury })
          state.newsfeed.unshift({
            id: `inj_${pid}_${state.calendar?.year}_${state.calendar?.weekOfYear}`,
            year: state.calendar?.year, week: state.calendar?.week, type: 'INJURY',
            headline: `🩼 ${player.firstName} ${player.lastName} — ${injury.label} (${injury.totalWeeks} wk${injury.totalWeeks === 1 ? '' : 's'}). ${injury.blurb}`,
            payload: { playerId: pid, injuryType: injury.type, weeks: injury.totalWeeks },
          })
        }
      }
    }

    // Scrimmage dev bonus — players in the user's scrimmage get small bumps.
    // If the user set an explicit lineup for this game, ONLY those players
    // earn the boost (that's how lineup choices drive development). Otherwise
    // we fall back to defaultLineup so untouched games still develop someone.
    if (isUserGame && (g.type === 'FALL_SCRIMMAGE' || g.type === 'SPRING_SCRIMMAGE')) {
      const userTeam = state.teams[userSchoolId]
      if (userTeam) {
        const saved = getSavedLineup(state, g.id)
        let playersIn
        if (saved) {
          const ids = lineupPlayerIds(state, g.id)
          playersIn = ids.map(id => state.players[id]).filter(Boolean)
        } else {
          const lineup = defaultLineup(userTeam, state.players)
          playersIn = [...lineup.batters, ...lineup.pitcherRotation]
        }
        const bumped = applyScrimmageDev(playersIn, g.seriesId || g.id)
        for (const p of bumped) state.players[p.id] = p
      }
    }

    // Update W-L only for record-counting games (scrimmages don't count)
    const counts = g.countsTowardRecord !== false
    if (counts && homeTeam && awayTeam) {
      if (result.homeRuns > result.awayRuns) {
        homeTeam.wins++; awayTeam.losses++
        if (g.type === 'CONFERENCE') { homeTeam.confWins++; awayTeam.confLosses++ }
      } else {
        awayTeam.wins++; homeTeam.losses++
        if (g.type === 'CONFERENCE') { awayTeam.confWins++; homeTeam.confLosses++ }
      }
      homeTeam.runDiff += result.homeRuns - result.awayRuns
      awayTeam.runDiff += result.awayRuns - result.homeRuns
    } else if (counts && (homeTeam || awayTeam)) {
      // One side is user (or another NAIA in user game), other side is non-NAIA
      const realTeam = homeTeam || awayTeam
      const realIsHome = !!homeTeam
      const realRuns = realIsHome ? result.homeRuns : result.awayRuns
      const oppRuns = realIsHome ? result.awayRuns : result.homeRuns
      if (realRuns > oppRuns) realTeam.wins++
      else realTeam.losses++
      realTeam.runDiff += realRuns - oppRuns
    }

    if (isUserGame) {
      const oppId = g.homeId === userSchoolId ? g.awayId : g.homeId
      const oppSchool = state.schools[oppId] || NON_NAIA_LOOKUP[oppId]
      const userWon = (g.homeId === userSchoolId && result.homeRuns > result.awayRuns) ||
                       (g.awayId === userSchoolId && result.awayRuns > result.homeRuns)
      userResults.push({
        gameId: g.id,
        opponent: oppSchool?.name || 'Unknown',
        homeAway: g.homeId === userSchoolId ? 'home' : 'away',
        result: userWon ? 'W' : 'L',
        score: `${Math.max(result.homeRuns, result.awayRuns)}-${Math.min(result.homeRuns, result.awayRuns)}`,
      })
    }
  }

  return { gamesPlayed, userResults }
}

/**
 * Run the postseason: conference tournaments. Returns a summary of all
 * tournament results + a list of teams that earned auto-bids. Stores
 * results in state.postseason.
 *
 * @param {SaveState} state
 * @returns {{ tournaments: any[], autoBids: string[], userResult: any }}
 */
export function runPostseason(state) {
  const ratings = seedFromPear(state.schools, state.conferences)

  // 1. Conference tournaments
  const tournaments = simAllConferenceTournaments(state, ratings, state.userSchoolId)
  const autoBids = tournaments.flatMap(t => t.autoBids).filter(Boolean)
  const userConf = state.schools[state.userSchoolId]?.conferenceId
  const userResult = tournaments.find(t => t.conferenceId === userConf)
  const userChamp = userResult?.champion === state.userSchoolId

  // 2. National tournament: Opening Round + World Series
  const national = runNationalTournament(autoBids, state, ratings, state.userSchoolId)
  const userInField = national.field46.includes(state.userSchoolId)
  const userWSChamp = national.nationalChampion === state.userSchoolId

  // 3. Find user's national-tournament path
  let userORSite = null
  let userORWon = false
  let userInWS = false
  if (userInField) {
    userORSite = national.openingRound.sites.find(s => s.teams.some(t => t.id === state.userSchoolId))
    userORWon = userORSite?.winner === state.userSchoolId
    userInWS = national.openingRound.winners.includes(state.userSchoolId)
  }

  state.postseason = {
    year: state.calendar.year + 1,
    tournaments,
    autoBids,
    userChamp,
    userQualified: autoBids.includes(state.userSchoolId),
    national,
    userInField,
    userORWon,
    userInWS,
    userWSChamp,
  }

  // Headline news — ordered most recent first; multiple events
  const news = []
  const userTeam = state.teams[state.userSchoolId]
  const userName = state.schools[state.userSchoolId].name

  // National champion
  if (userWSChamp) {
    news.push({ type: 'POSTSEASON', headline: `🏆🏆🏆 ${userName} wins the NAIA NATIONAL CHAMPIONSHIP at Avista NAIA World Series, Harris Field, Lewiston ID!`, big: true })
  } else if (userInWS) {
    const wsChamp = state.schools[national.nationalChampion]?.name
    news.push({ type: 'POSTSEASON', headline: `Advanced to Avista NAIA World Series. ${wsChamp} won the national title.`, big: true })
  } else if (userORWon) {
    news.push({ type: 'POSTSEASON', headline: `✓ Won Opening Round at ${state.schools[userORSite?.host]?.name}! Headed to Lewiston for the NAIA World Series.` })
  } else if (userInField) {
    const winner = state.schools[userORSite?.winner]?.name
    news.push({ type: 'POSTSEASON', headline: `Opening Round at ${state.schools[userORSite?.host]?.name}: eliminated. ${winner} advanced to the WS.` })
    news.push({ type: 'POSTSEASON', headline: `Made the 46-team NAIA national tournament. Season ends.` })
  }

  // Conference tournament
  if (userChamp) {
    news.push({ type: 'POSTSEASON', headline: `🏆 ${userName} wins the ${state.conferences[userConf].name} Tournament! Auto-bid to NAIA national tournament secured.`, big: true })
  } else if (userResult?.qualifiers.find(q => q.schoolId === state.userSchoolId)) {
    news.push({ type: 'POSTSEASON', headline: `Conference tournament: eliminated. ${state.schools[userResult.champion]?.name} won the ${state.conferences[userConf].abbreviation}.` })
  } else {
    news.push({ type: 'POSTSEASON', headline: `Missed the ${state.conferences[userConf].abbreviation} tournament. Season over.` })
  }

  // National champion (if not us)
  if (national.nationalChampion && national.nationalChampion !== state.userSchoolId) {
    news.push({ type: 'POSTSEASON', headline: `${state.schools[national.nationalChampion]?.name} crowned ${state.calendar.year + 1} NAIA national champions.` })
  }

  // Push in REVERSE so newest appears first in the feed
  for (const n of news.reverse()) {
    state.newsfeed.unshift({
      id: `ps_${state.calendar.year}_${Math.random().toString(36).slice(2, 7)}`,
      year: state.calendar.year + 1,
      week: 17,
      ...n,
      payload: {},
    })
  }

  return { tournaments, autoBids, userResult, national }
}

/**
 * Run the minimal end-of-year transition. Heavy work (development, transfers,
 * draft, portal pool, academics, budget review) is NO LONGER done here —
 * instead it's queued onto specific offseason weeks via events.js so each
 * weekly tick stays fast (< 500ms) and the user gets visible progress as
 * each event fires.
 *
 * This function:
 *   1. Archives last season's W-L + playerStats so deferred events can read them
 *   2. Flips calendar to OFFSEASON week 1
 *   3. Resets team W-L
 *   4. Clears the schedule + active playerStats
 *
 * Total work: tiny. Tick should complete in a few ms.
 *
 * @param {SaveState} state
 */
export function runEndOfYear(state) {
  // Archive what the deferred events will need
  state._archivedPlayerStats = state.playerStats || {}
  const userTeam = state.teams[state.userSchoolId]
  if (userTeam) {
    userTeam._lastSeason = {
      wins: userTeam.wins, losses: userTeam.losses,
      runDiff: userTeam.runDiff,
    }
  }

  // Calendar transition
  state.calendar.year++
  state.calendar.mode = 'OFFSEASON'
  state.calendar.offseasonWeek = 1
  state.calendar.seasonWeek = null
  state.calendar.week = 1

  // Reset W-L for all teams
  for (const team of Object.values(state.teams)) {
    team.wins = 0; team.losses = 0
    team.confWins = 0; team.confLosses = 0
    team.runDiff = 0
  }
  state.schedule = []
  state.playerStats = {}
  state.prospectCamp = null
  // Heal everyone for the new season — SEASON-ending injuries already had
  // their rating penalty applied; we just clear the active injury flags so
  // players start fall fresh. (Stat penalty stays.)
  clearAllInjuriesForNewSeason(state)
  // Reset the "viewed" flag for fall stats so next year's report fires.
  state.fallStatsViewed = null
  // Year-over-year: dynastyYear counter ticks. Year 1 = tutorial; Year 2+
  // can use the "confirm my staff" shortcut to skip required hiring.
  state.dynastyYear = (state.dynastyYear || 1) + 1
  // Clear last-year's locked budget / hiring confirmation so the new year's
  // tutorial weeks can run cleanly.
  if (state.budget?.locked) state.budget.locked = null
  state.hiringConfirmed = null

  // Build the new year's conference schedule + auto-fall games up front so
  // they appear in the calendar before the user reaches Wk 1.
  rebuildScheduleForYear(state)

  // Surface a "season wrapped, here's what's coming" newsfeed entry so the
  // user sees the calendar is now ticking through deferred events.
  state.newsfeed.unshift({
    id: `eoy_${state.calendar.year}`,
    year: state.calendar.year, week: 0, type: 'AWARD',
    headline: `📅 Postseason wrapped. Budget review, draft, transfers, and development run over the next few offseason weeks. Watch the calendar.`,
    payload: {}, big: true,
  })

}

// Roster cap. NAIA programs are limited to 50 active scholarship + walk-on
// players. Lowered from 60 to 50 (May 2026) — previous value let rosters
// balloon to unrealistic sizes after multiple recruiting classes signed.
export const ROSTER_CAP_MAX = 50

/**
 * Refresh weekly AP — same formula as newDynasty.computeInitialAP, kept in
 * sync. Called when a week ticks over so the user gets a fresh AP budget.
 */
/**
 * Reset the per-week "used" list and step any temporary boosts toward
 * expiry. Called from advanceOffseasonWeek + advanceWeek (season).
 */
function tickWeeklyBookkeeping(state) {
  state.weeklyActionsUsed = []
  // Drop permanent-bump records older than 2 weeks (arrows fade out)
  if (Array.isArray(state.permanentBumps)) {
    state.permanentBumps = state.permanentBumps.filter(
      b => (state.calendar.week - (b.weekApplied || 0)) <= 2,
    )
  }
  // Decrement temporary-boost timers and reverse expired ones
  if (Array.isArray(state.tempBoosts)) {
    const expired = []
    const remaining = []
    for (const b of state.tempBoosts) {
      const next = (b.weeksRemaining || 0) - 1
      if (next <= 0) expired.push(b)
      else remaining.push({ ...b, weeksRemaining: next })
    }
    for (const b of expired) {
      const p = state.players[b.playerId]
      if (!p) continue
      const block = b.side === 'pitcher' ? p.pitcher : p.hitter
      if (block && typeof block[b.ratingKey] === 'number') {
        block[b.ratingKey] = Math.max(20, block[b.ratingKey] - b.amount)
      }
    }
    state.tempBoosts = remaining
  }

  // Happiness — smooth toward target + apply mild GPA/rating drift
  tickHappiness(state)
}

function refreshWeeklyAP(state) {
  const team = state.teams[state.userSchoolId]
  if (!team) return

  // AP is LOCKED during weeks 1-3 of every year (scheduling / hiring /
  // budgeting tutorial). Unlocks in wk 4 (scouting opens). This is enforced
  // here so every code path that bumps a week gets the right value.
  const wk = state.calendar?.weekOfYear ?? 0
  if (wk >= 1 && wk <= 3) {
    state.ap.currentWeek = 0
    state.ap.spentThisWeek = 0
    state.ap.spentByCategory = {
      recruiting: 0, development: 0, team_boost: 0, program: 0, staff: 0,
    }
    return
  }

  const school = state.schools[state.userSchoolId]
  const hc = state.coaches[team.headCoachId]
  const assistants = team.assistantCoachIds.map(id => state.coaches[id]).filter(Boolean)
  const ROLE_MULTIPLIER = {
    HEAD_COACH: 0.8, PITCHING_COACH: 0.4, HITTING_COACH: 0.4,
    BENCH_COACH: 0.3, RECRUITING_COORDINATOR: 0.6,
    STRENGTH_CONDITIONING: 0.3, DIRECTOR_OF_OPERATIONS: 0.3,
    DATA_ANALYTICS_MANAGER: 0.4, GRADUATE_ASSISTANT: 0.2,
  }
  const TIER_BONUS = { D1_LITE: 3, WELL_FUNDED: 1, MID: 0, SHOESTRING: -1 }
  // Experience bonus — every year at school (capped at 8) adds 1 AP, so a
  // veteran coach can push toward the 50 AP cap.
  const yearsAtSchool = state.budget?.yearsAtSchool ?? 0
  const experienceBonus = Math.min(8, yearsAtSchool)
  const contribution = (c) => {
    const avg = (c.developer + c.motivator + c.recruiter + c.tactician) / 4
    return (avg - 50) * 0.12 * (ROLE_MULTIPLIER[c.role] ?? 0.3)
  }
  let total = 22
  if (hc) total += contribution(hc)
  for (const a of assistants) total += contribution(a)
  total += TIER_BONUS[school?.resourceTier] || 0
  total += experienceBonus
  state.ap.currentWeek = Math.max(20, Math.min(50, Math.round(total)))
  state.ap.spentThisWeek = 0
  state.ap.spentByCategory = {
    recruiting: 0, development: 0, team_boost: 0, program: 0, staff: 0,
  }
}

/**
 * Unified weekly tick — handles all 52 weeks of the game year.
 *
 *   - Bumps weekOfYear (wraps 52 → 1, year++)
 *   - Re-derives mode + offseasonWeek + seasonWeek (back-compat)
 *   - Refreshes AP (locked = 0 for weeks 1-3)
 *   - Ticks bookkeeping (boosts, happiness)
 *   - Fires scheduled events for the new week (events.js)
 *   - Runs the full postseason bracket on the wk 39 → 40 transition
 *   - Runs minimal end-of-year on the wk 52 → 1 transition
 *
 * @param {SaveState} state
 */
export function advanceOneWeek(state) {
  ensureUnifiedCalendar(state)
  const prevWeek = state.calendar.weekOfYear ?? 1

  // Tick the unified counter
  let nextWeek = prevWeek + 1
  let yearRolled = false
  if (nextWeek > WEEKS_PER_YEAR) {
    nextWeek = 1
    state.calendar.year++
    yearRolled = true
  }
  state.calendar.weekOfYear = nextWeek
  state.calendar.week = (state.calendar.week || 0) + 1   // overall counter (never resets)

  // Re-derive mode + week-of-mode for legacy consumers
  state.calendar.mode = modeForWeek(nextWeek)
  state.calendar.seasonWeek = seasonWeekForWeek(nextWeek)
  if (state.calendar.mode === 'OFFSEASON') {
    // Offseason "weeks 1-26" run Aug-Jan in the new model; weeks 43-52 are
    // post-postseason offseason (Jun-Jul). Both map back to a single offseason
    // counter for the old code, but the canonical source is weekOfYear.
    state.calendar.offseasonWeek = nextWeek <= 26 ? nextWeek : 26 + (nextWeek - 42)
  } else {
    state.calendar.offseasonWeek = null
  }

  // Year rollover: tiny EOY transition (heavy work was already done by
  // deferred events earlier in offseason — wks 43-51).
  if (yearRolled) {
    runEndOfYear(state)
  }

  // Postseason: fires once when we enter wk 40 (conference tournament).
  // The bracket runs all three rounds (conf, opening, WS) in one call.
  if (nextWeek === 40 && prevWeek === 39) {
    runPostseason(state)
  }

  // Capture last-week AP spend BEFORE the refresh resets it — used by the
  // weekly team-GPA dynamic (lower utilization → GPA drifts down).
  state._lastWeekApSpent = state.ap?.spentThisWeek ?? 0

  // Refresh AP and tick boosts. AP is LOCKED (= 0) during weeks 1-3 per the
  // new tutorial flow; refreshWeeklyAP enforces that.
  refreshWeeklyAP(state)
  tickWeeklyBookkeeping(state)
  tickTeamGPAWeekly(state)

  // Reset the per-week new-injuries collector that simWeek pushes into. The
  // WeekRecap reads this BEFORE we clear it — only fully reset on the NEXT
  // advance. (simWeek runs after advanceOneWeek for week-of-the-game weeks,
  // so we initialize the bucket here and let simWeek append; the recap reads
  // and clears at the end of its render cycle.)
  state._newInjuriesThisWeek = []

  // Decrement injury counters on every player; surfaces newly-healed
  // players for the WeekRecap.
  const healResult = tickInjuries(state)
  if (healResult.newlyHealed.length > 0) {
    state._newlyHealedThisWeek = healResult.newlyHealed.map(p => ({
      playerId: p.id,
      name: `${p.firstName} ${p.lastName}`,
      severity: p._recentReturn?.severity || 'MINOR',
    }))
    for (const p of healResult.newlyHealed) {
      state.newsfeed.unshift({
        id: `heal_${p.id}_${state.calendar?.year}_${state.calendar?.weekOfYear}`,
        year: state.calendar?.year, week: state.calendar?.week, type: 'INJURY',
        headline: `🟢 ${p.firstName} ${p.lastName} cleared from injury. ${
          p._recentReturn?.severity && p._recentReturn.severity !== 'MINOR'
            ? `Some lingering rating impact applied — see player page.`
            : `Back in action.`
        }`,
        payload: { playerId: p.id },
      })
    }
  } else {
    state._newlyHealedThisWeek = []
  }

  // Practice / training injuries — low base rate, only in non-game weeks.
  // Game weeks roll inside simWeek, so we skip those to avoid double-rolling.
  const mode = state.calendar.mode
  const isGameWeek = mode === 'SEASON' || mode === 'POSTSEASON'
    || (nextWeek >= 5 && nextWeek <= 13)   // fall scrimmage weeks
  if (!isGameWeek && state.teams?.[state.userSchoolId]) {
    const userTeam = state.teams[state.userSchoolId]
    const rngPrac = makeRng('practice_inj', state.rngSeed, state.calendar?.year, nextWeek)
    if (!state._newInjuriesThisWeek) state._newInjuriesThisWeek = []
    for (const pid of userTeam.rosterPlayerIds) {
      const player = state.players[pid]
      if (!player) continue
      const template = rollPracticeInjury(player, rngPrac)
      if (template) {
        const injury = applyInjury(player, template, {
          context: 'PRACTICE',
          week: nextWeek,
          year: state.calendar?.year,
          rng: rngPrac,
        })
        state._newInjuriesThisWeek.push({ playerId: pid, injury })
        state.newsfeed.unshift({
          id: `inj_prac_${pid}_${state.calendar?.year}_${nextWeek}`,
          year: state.calendar?.year, week: state.calendar?.week, type: 'INJURY',
          headline: `🩼 ${player.firstName} ${player.lastName} — ${injury.label} (${injury.totalWeeks} wk${injury.totalWeeks === 1 ? '' : 's'}). Practice incident.`,
          payload: { playerId: pid, injuryType: injury.type, weeks: injury.totalWeeks, context: 'PRACTICE' },
        })
      }
    }
  }

  // Fire events for the new week (budget review, draft, portal opens, etc.)
  runEventsForWeek(state, nextWeek)

  // Sim any fall scrimmages whose weekOfYear matches the new week. Lets us
  // unify the scrimmage + game-week paths — they all flow through simWeek
  // and update boxscores / playerStats the same way. Skip the user's games
  // (those go through the live-play modal); auto-fall games NOT involving
  // the user are simulated quickly.
  simScrimmagesForCurrentWeek(state)
}

/**
 * Sim only the offseason FALL_SCRIMMAGE games for the current week that the
 * user is NOT a participant in. User scrimmages flow through Play / live or
 * the dashboard "Sim Game(s)" CTA so the user has explicit control.
 */
function simScrimmagesForCurrentWeek(state) {
  if (state.calendar.mode !== 'OFFSEASON') return
  const wk = state.calendar.weekOfYear
  const userId = state.userSchoolId
  const ratings = seedFromPear(state.schools, state.conferences)
  for (const g of state.schedule || []) {
    if (g.played) continue
    if (g.type !== 'FALL_SCRIMMAGE') continue
    let gw = g.weekOfYear
    if (gw == null && g.date) gw = dateToWeekOfYear(g.date, state.calendar.year)
    if (gw !== wk) continue
    if (g.homeId === userId || g.awayId === userId) continue  // user's slate routes through UI
    // Fast-sim non-user fall scrimmages — they affect no records but help
    // populate dev / stats for other programs.
    const home = ratings[g.homeId] ?? { overall_rating: 0, offense_rating: 0, pitching_rating: 0 }
    const away = ratings[g.awayId] ?? { overall_rating: 0, offense_rating: 0, pitching_rating: 0 }
    const result = fastSimGame(home, away, g.id)
    g.homeRuns = result.homeRuns
    g.awayRuns = result.awayRuns
    g.played = true
  }
}

// ─── Back-compat wrappers ──────────────────────────────────────────────────
// Existing callers import these names — they delegate to advanceOneWeek now.

/** Legacy: advance one offseason week. */
export function advanceOffseasonWeek(state) {
  if (state.calendar.mode !== 'OFFSEASON') return
  advanceOneWeek(state)
}

/** Legacy: advance one season week. Schedule arg ignored (sim is separate). */
export function advanceWeek(state, _schedule) {
  advanceOneWeek(state)
}

// ─── Per-year schedule builder ──────────────────────────────────────────────
// Called on year rollover (runEndOfYear) + can be re-called manually. Builds
// the conference round-robin AND the auto-scheduled fall games up front; the
// user fills in non-conference weekends from the Schedule page.

export function rebuildScheduleForYear(state) {
  const year = state.calendar.year
  const flatNonNaia = nonNaiaRaw.divisions.flatMap(div =>
    div.teams.map(t => ({ ...t, division: div.id }))
  )
  const confSchedule = buildAllConferenceSchedules(state.conferences, state.schools, year, state.rngSeed)
  const fallGames = autoScheduleFallGames(
    state.userSchoolId, state.schools, flatNonNaia, year - 1, state.rngSeed + year
  )
  state.schedule = [...confSchedule, ...fallGames]
}
