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
import { applyScrimmageDev, applyWeeklyDevelopment, applyOffseasonPracticeDev } from './development'
import { runEndOfRegularSeasonAwards } from './awards'
import { awardForGameResult } from './coachProgression'
import { simAllConferenceTournaments } from './tournament'
import { runNationalTournament } from './nationalTournament'
import { playerOverall } from './playerRating'
import { tickHappiness } from './happiness'
import { tickTeamGPAWeekly } from './academics'
import { runEventsForWeek } from './events'
import { maybeFireRandomEvent } from './randomEvents'
import { tryAdvanceRecruit, rollSignedSteal } from './recruits'
import { recomputeNwbbRatings } from './nwbbRating'
import { computeWeeklyAwards } from './weeklyAwards'
import { runConferenceTournament, nationalSpecForLevel, qualifierCountForConf } from './pnwPlayoffs'
import { runNationalChampionsTracking } from './nationalChampions'
import nonNaiaTeamsData from '../data/non_naia_teams.json'
import { buildAllConferenceSchedules, autoScheduleFallGames, dateToWeekOfYear } from './schedule'
import { OFFSEASON_WEEKS } from './calendar'
import { WEEKS_PER_YEAR, modeForWeek, seasonWeekForWeek, ensureUnifiedCalendar, phaseForWeek } from './gameYear'
import { rollGameInjury, rollPracticeInjury, tickInjuries, applyInjury, isInjured, clearAllInjuriesForNewSeason } from './injuries'
import { makeRng } from './rng'
import {
  ensureEnergyState, getEnergy, applyGameEnergyCosts, tickWeeklyRecovery,
  tickIntraDayRecovery, energyInjuryMultiplier,
} from './energy'
import nonNaiaRaw from '../data/non_naia_teams.json'

/**
 * Is `game` the second (or later) game of a doubleheader for the user team?
 * Used by the energy system to charge an extra cost on back-to-back games.
 */
function isSecondGameOfDay(schedule, game, userSchoolId) {
  if (!game?.isDoubleheader || !game.date) return false
  const sameDay = (schedule || []).filter(g =>
    g.date === game.date
    && (g.homeId === userSchoolId || g.awayId === userSchoolId)
    && g.id !== game.id
  )
  // We're the second-game-of-day if any user game on the same date sorts
  // earlier (g.id suffix _0 < _1) AND was already played.
  for (const g of sameDay) {
    if (g.id < game.id && g.played) return true
  }
  return false
}

function zeroStats(isPitcher) {
  if (isPitcher) return { ip: 0, h: 0, bb: 0, k: 0, er: 0, outs: 0, pa: 0, hbp: 0, hr: 0, gamesPlayed: 0 }
  return { ab: 0, h: 0, d: 0, t: 0, hr: 0, bb: 0, k: 0, rbi: 0, pa: 0, hbp: 0, sf: 0, sac: 0, gidp: 0, roe: 0, sb: 0, cs: 0, gamesPlayed: 0 }
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

  ensureEnergyState(state)
  // Reset the weekly-stats accumulator at the start of every simWeek so
  // weeklyAwards has just THIS week's box scores to choose from.
  state.weeklyStats = {}
  // Energy lookup passed to simGame so PA-level outcomes reflect tired
  // bats / arms. Wrapped as a function (not a snapshot) because energy
  // can change between same-day games (intra-day recovery + game costs).
  const energyAccessor = (pid) => getEnergy(state, pid)
  // Sort the week's games by date so the energy + intra-day recovery
  // accounting runs in chronological order. Date string format is YYYY-MM-DD
  // so localeCompare gives the right order. Same-date games preserve their
  // insertion order (Game 1 before Game 2 in the doubleheader bucket).
  const sortedSchedule = [...schedule].sort((a, b) =>
    (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id),
  )
  let lastUserDate = null   // for overnight-rest recovery between non-DH days

  for (const g of sortedSchedule) {
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

    // Overnight rest: if this user game is on a different date than the
    // previous user game in this same week, apply intra-day recovery to
    // the user roster so a Friday-Sat-Sun series doesn't have everyone
    // play Sunday at 0 energy. ~18 pts back for hitters, ~5 for pitchers.
    if (isUserGame && lastUserDate && g.date && g.date !== lastUserDate) {
      const userT = state.teams[userSchoolId]
      if (userT) tickIntraDayRecovery(state, userT.rosterPlayerIds || [])
    }
    if (isUserGame && g.date) lastUserDate = g.date

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
        getEnergy: energyAccessor,
        level: state.level || state.schools?.[userSchoolId]?.level || 'NAIA',
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

    // Energy costs for the user's side after every user game. Doubleheaders
    // flag the second-game-of-day surcharge so the same catcher / starter
    // who appeared in game 1 takes an extra hit in game 2.
    if (isUserGame && result.appearances) {
      const isSecond = isSecondGameOfDay(schedule, g, userSchoolId)
      const userSide = g.homeId === userSchoolId ? 'home' : 'away'
      const userTeam = state.teams[userSchoolId]
      const userAppearances = result.appearances
        .filter(a => {
          if (a.isPitcher) return userTeam?.rosterPlayerIds.includes(a.playerId)
          return a.teamId === userSide
        })
        .map(a => ({ ...a, isSecondGameOfDay: isSecond }))
      applyGameEnergyCosts(state, userAppearances)
    } else if (isUserGame) {
      // Fast-sim user game (vs non-NAIA) — deduct a baseline cost for the
      // starting 9 + starter so doubleheader energy still drains.
      const userTeam = state.teams[userSchoolId]
      if (userTeam) {
        const lineup = resolveLineupForGame(state, userSchoolId, g.id)
        const isSecond = isSecondGameOfDay(schedule, g, userSchoolId)
        const apps = []
        ;(lineup.batters || []).forEach((b, i) => {
          if (!b) return
          apps.push({
            playerId: b.id,
            position: lineup.batterPositions?.[i] || b.primaryPosition,
            isSecondGameOfDay: isSecond,
          })
        })
        const starter = lineup.pitcherRotation?.[0]
        if (starter) {
          apps.push({ playerId: starter.id, pitchesThrown: 85, isPitcher: true, isSecondGameOfDay: isSecond })
        }
        applyGameEnergyCosts(state, apps)
      }
    }
    // Persist the per-game boxscore on the user's games so the Play page
    // can surface a Box Score button on completed games. Only user games
    // get the full PA-level boxscore — non-user games are fast-sim'd and
    // wouldn't have one anyway. We strip empty rows + cap save size.
    if (isUserGame && result.boxscore?.batterStats) {
      g.boxscore = {
        batterStats: result.boxscore.batterStats,
        pitcherStats: result.boxscore.pitcherStats || {},
        innings: result.boxscore.innings || null,
      }
    }
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
          // Mirror into weeklyStats — only for non-fall, non-scrim games
          // (regular-season + postseason). Cleared at the top of simWeek;
          // read by weeklyAwards.computeWeeklyAwards at the end.
          if (!isFall && g.type !== 'SPRING_SCRIMMAGE') {
            if (!state.weeklyStats[key]) {
              state.weeklyStats[key] = { playerId: pid, isPitcher, ...zeroStats(isPitcher) }
            }
            const wkTarget = state.weeklyStats[key]
            for (const k of Object.keys(s)) wkTarget[k] = (wkTarget[k] || 0) + s[k]
            wkTarget.gamesPlayed = (wkTarget.gamesPlayed || 0) + 1
          }
        }
      }
      accumulate(result.boxscore.batterStats, false)
      accumulate(result.boxscore.pitcherStats, true)
    }

    // ── Injury rolls — only for the user's team players who appeared in
    // the game. Non-user teams skip injury rolls to keep state small +
    // perf high. Game injuries are surfaced via state._newInjuriesThisWeek
    // so the dashboard WeekRecap can highlight them.
    // Custom-mode toggle: skip ALL game-injury rolls when injuriesEnabled
    // is explicitly false. Traditional mode + default Custom keep them on.
    const injuriesOn = state.gameOptions?.injuriesEnabled !== false
    if (isUserGame && result.boxscore && injuriesOn) {
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
        const energy = getEnergy(state, pid)
        const template = rollGameInjury(player, { gamePa: s.pa || 0, energyMult: energyInjuryMultiplier(energy) }, rngInj)
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
            headline: `${player.firstName} ${player.lastName} — ${injury.label} (${injury.totalWeeks} wk${injury.totalWeeks === 1 ? '' : 's'}). ${injury.blurb}`,
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
        const energy = getEnergy(state, pid)
        const template = rollGameInjury(player, { gameIp: s.ip || 0, energyMult: energyInjuryMultiplier(energy) }, rngInj)
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
            headline: `${player.firstName} ${player.lastName} — ${injury.label} (${injury.totalWeeks} wk${injury.totalWeeks === 1 ? '' : 's'}). ${injury.blurb}`,
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
      // Coach upgrade points for user wins. Opponent's national rank
      // boosts the grant (beating a top-25 team is worth more).
      if (isUserGame) {
        const userWon = (g.homeId === userSchoolId && result.homeRuns > result.awayRuns)
          || (g.awayId === userSchoolId && result.awayRuns > result.homeRuns)
        if (userWon) {
          const oppId = g.homeId === userSchoolId ? g.awayId : g.homeId
          const oppRank = ratings?.[oppId]?.nationalRank
          awardForGameResult(state, true, oppRank, g.type === 'CONFERENCE')
        }
      }
    } else if (counts && (homeTeam || awayTeam)) {
      // One side is user (or another NAIA in user game), other side is non-NAIA
      const realTeam = homeTeam || awayTeam
      const realIsHome = !!homeTeam
      const realRuns = realIsHome ? result.homeRuns : result.awayRuns
      const oppRuns = realIsHome ? result.awayRuns : result.homeRuns
      if (realRuns > oppRuns) realTeam.wins++
      else realTeam.losses++
      realTeam.runDiff += realRuns - oppRuns
      // Non-NAIA wins also award (smaller — no national rank context)
      if (realRuns > oppRuns && realTeam.schoolId === userSchoolId) {
        awardForGameResult(state, true, null, false)
      }
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

  // ── Weekly awards (Conf + NAIA Hitter / Pitcher of the Week) ──────────
  // Computed from state.weeklyStats (populated above during simWeek). Posts
  // to newsfeed and bumps the user's player stats + coach upgrade points
  // when the user's roster wins one.
  if (gamesPlayed > 0 && state.calendar?.mode !== 'OFFSEASON') {
    computeWeeklyAwards(state)
  }

  // ── In-season weekly development pass ────────────────────────────────
  // After all games are simmed for the week, run a small dev pass for every
  // user player whose season stats moved this week. Stats-driven — no
  // randomness. (See development.js applyWeeklyDevelopment for the rule
  // book.) Only fires for REGULAR-SEASON + POSTSEASON games, not fall
  // scrimmages (which have their own scrimmage-dev path).
  if (gamesPlayed > 0 && state.calendar?.mode !== 'OFFSEASON') {
    const userTeam = state.teams[userSchoolId]
    if (userTeam) {
      for (const pid of userTeam.rosterPlayerIds) {
        const player = state.players[pid]
        if (!player) continue
        // Skip graduating / cut / dismissed
        if (player.eligibilityStatus === 'graduated'
          || player.eligibilityStatus === 'cut'
          || player.eligibilityStatus === 'dismissed') continue
        // Skip injured (already excluded from lineup)
        if ((player.injury?.weeksRemaining || 0) > 0) continue
        const seasonStats = state.playerStats?.[player.isPitcher ? `p_${pid}` : `b_${pid}`]
        // Only call dev if they actually have stats this season
        if (!seasonStats) continue
        if (player.isPitcher && (seasonStats.ip || 0) < 5) continue
        if (!player.isPitcher && (seasonStats.ab || 0) < 25) continue
        applyWeeklyDevelopment(player, seasonStats)
      }
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
  // Multi-level branch: non-NAIA dynasties route through the generic
  // pnwPlayoffs runner. They get a conference tournament + a stubbed
  // national bracket (placeholder until full per-level WS sims ship).
  if (state.level && state.level !== 'NAIA') {
    return runPostseasonMultiLevel(state)
  }
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
    level: 'NAIA',
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

  // National-conf-champion tracking — sims every NAIA conference's
  // champion + builds the 46-team national field. Cached on
  // state.nationalChamps[year].NAIA for the Postseason page.
  runNationalChampionsTracking(state, 'NAIA')

  // Headline news — ordered most recent first; multiple events
  const news = []
  const userTeam = state.teams[state.userSchoolId]
  const userName = state.schools[state.userSchoolId].name

  // National champion
  if (userWSChamp) {
    news.push({ type: 'POSTSEASON', headline: `${userName} wins the NAIA NATIONAL CHAMPIONSHIP at Avista NAIA World Series, Harris Field, Lewiston ID!`, big: true })
  } else if (userInWS) {
    const wsChamp = state.schools[national.nationalChampion]?.name
    news.push({ type: 'POSTSEASON', headline: `Advanced to Avista NAIA World Series. ${wsChamp} won the national title.`, big: true })
  } else if (userORWon) {
    news.push({ type: 'POSTSEASON', headline: `Won Opening Round at ${state.schools[userORSite?.host]?.name}! Headed to Lewiston for the NAIA World Series.` })
  } else if (userInField) {
    const winner = state.schools[userORSite?.winner]?.name
    news.push({ type: 'POSTSEASON', headline: `Opening Round at ${state.schools[userORSite?.host]?.name}: eliminated. ${winner} advanced to the WS.` })
    news.push({ type: 'POSTSEASON', headline: `Made the 46-team NAIA national tournament. Season ends.` })
  }

  // Conference tournament
  if (userChamp) {
    news.push({ type: 'POSTSEASON', headline: `${userName} wins the ${state.conferences[userConf].name} Tournament! Auto-bid to NAIA national tournament secured.`, big: true })
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
  // Multi-year stats archive — powers the Career view on the Stats page.
  // state.statsArchive[year] holds the full playerStats snapshot for that
  // year's spring season. Keyed by the YEAR the spring took place in
  // (state.calendar.year before it ticks).
  if (!state.statsArchive) state.statsArchive = {}
  const archivedYear = state.calendar?.year
  if (archivedYear != null && state.playerStats) {
    state.statsArchive[archivedYear] = state.playerStats
    // Also archive team W-L for the year so career views can show context.
    if (!state.teamRecordArchive) state.teamRecordArchive = {}
    state.teamRecordArchive[archivedYear] = {}
    for (const [tid, team] of Object.entries(state.teams)) {
      state.teamRecordArchive[archivedYear][tid] = {
        wins: team.wins, losses: team.losses, runDiff: team.runDiff,
      }
    }
  }
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
    headline: `Postseason wrapped. Budget review, draft, transfers, and development run over the next few offseason weeks. Watch the calendar.`,
    payload: {}, big: true,
  })

}

// Roster cap. NAIA programs are limited to 50 active scholarship + walk-on
// players. Lowered from 60 to 50 (May 2026) — previous value let rosters
// balloon to unrealistic sizes after multiple recruiting classes signed.
/**
 * Multi-level postseason — used for D1/D2/D3/NWAC dynasties.
 *
 * Phase 1 (this session): run the conference tournament through the
 * generic pnwPlayoffs runner. Field is the top N from the user's
 * conference (by conf W-L). National bracket is STUBBED — surfaces
 * an info headline instead of simming, until per-level WS code ships.
 */
function runPostseasonMultiLevel(state) {
  const userConfId = state.schools[state.userSchoolId]?.conferenceId
  const conf = state.conferences[userConfId]
  if (!conf) return null
  const level = state.level

  // Seed conference qualifiers by conf W-L → run diff
  const standings = (conf.schoolIds || [])
    .map(id => ({ schoolId: id, team: state.teams[id] }))
    .filter(x => x.team)
    .sort((a, b) => {
      if (a.team.confWins !== b.team.confWins) return b.team.confWins - a.team.confWins
      return b.team.runDiff - a.team.runDiff
    })
  const fieldSize = qualifierCountForConf(userConfId)
  const seeded = standings.slice(0, fieldSize).map(x => x.schoolId)

  // simGame callback — use fast monte-carlo against the universal rating
  const ratingFor = (sid) => {
    const team = state.teams[sid]
    if (!team) return { overall_rating: 0, offense_rating: 0, pitching_rating: 0 }
    const winPct = (team.wins + team.losses) > 0
      ? team.wins / (team.wins + team.losses) : 0.5
    return {
      overall_rating: (winPct - 0.5) * 10,
      offense_rating: (winPct - 0.5) * 5,
      pitching_rating: (winPct - 0.5) * 5,
    }
  }
  const simGame = (h, a, key) => fastSimGame(ratingFor(h), ratingFor(a), key)

  const tourney = runConferenceTournament(userConfId, seeded, simGame, `pml_${state.calendar.year}_${userConfId}`)
  const userChamp = tourney.champion === state.userSchoolId

  // Apply W/L from tourney games to the user team only
  for (const g of (tourney.games || [])) {
    if (g.homeId !== state.userSchoolId && g.awayId !== state.userSchoolId) continue
    const userHome = g.homeId === state.userSchoolId
    const userRuns = userHome ? g.homeRuns : g.awayRuns
    const oppRuns = userHome ? g.awayRuns : g.homeRuns
    state.teams[state.userSchoolId].runDiff += userRuns - oppRuns
  }

  // National bracket — simplified deterministic sim. Conference champion
  // (if user) gets bracket spots through to the world series. We can't sim
  // every D1/D2/D3/NWAC program nationally (we don't track their game
  // results), so we use a per-level "fast" simulation against the host's
  // universal-strength rating from the non_naia_teams pool.
  const natSpec = nationalSpecForLevel(level)
  let national = null
  if (userChamp && natSpec) {
    national = simNationalBracketStub(state, level, natSpec)
  }

  state.postseason = {
    year: state.calendar.year + 1,
    level,
    tournaments: [{
      conferenceId: userConfId,
      qualifiers: seeded.map((sid, i) => ({ schoolId: sid, seed: i + 1 })),
      games: tourney.games,
      champion: tourney.champion,
      autoBids: userChamp ? [tourney.champion] : [],
    }],
    autoBids: userChamp ? [tourney.champion] : [],
    userChamp,
    userQualified: seeded.includes(state.userSchoolId),
    national,
    nationalSpec: natSpec,
    userInField: !!national,
    userORWon: national?.userORWon ?? false,
    userInWS: national?.userInWS ?? false,
    userWSChamp: national?.userWSChamp ?? false,
  }

  // National-conf-champion tracking — sims every level-relevant conference's
  // champion + builds the full national field. Cached on
  // state.nationalChamps[year][level] for the Postseason page.
  runNationalChampionsTracking(state, level)

  // Newsfeed lines
  const userName = state.schools[state.userSchoolId].name
  if (userChamp) {
    state.newsfeed.unshift({
      id: `confchamp_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 17, type: 'POSTSEASON',
      headline: `${userName} wins the ${conf.name}! Auto-bid earned (national bracket sim coming in a future engine update).`,
      payload: {}, big: true,
    })
  } else if (state.postseason.userQualified) {
    state.newsfeed.unshift({
      id: `confelim_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 17, type: 'POSTSEASON',
      headline: `Eliminated in the ${conf.name} tournament. ${state.schools[tourney.champion]?.name || ''} took the title.`,
      payload: {},
    })
  } else {
    state.newsfeed.unshift({
      id: `confmiss_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 17, type: 'POSTSEASON',
      headline: `Missed the ${conf.name} tournament.`,
      payload: {},
    })
  }
  return { tournaments: state.postseason.tournaments, autoBids: state.postseason.autoBids }
}

/**
 * Simulate the user's national bracket run AT A HIGH LEVEL for non-NAIA
 * dynasties. We don't track every D1/D2/D3/NWAC game in the country, so
 * this stub:
 *   - Builds a synthetic field of opponents (national PEAR-derived teams)
 *   - Sims each round as a single fast-sim game where the user's "team
 *     strength" is their universal NWBB rating
 *   - Reports the round the user got bounced + the eventual national champ
 *
 * The result is a believable "playoff run" without the engine needing to
 * carry 300 D1 schedules. Future enhancement: full PA-level WS sim.
 */
function simNationalBracketStub(state, level, natSpec) {
  const rngForSim = makeRng('natstub', state.rngSeed, state.calendar.year, level)
  const rounds = natSpec.rounds || []
  // User's universal rating — use their NWBB rating or fall back to a
  // mid-tier strength for the level
  const userRating = state.nwbbRatings?.[state.userSchoolId]?.rating ?? 65

  // Pull the top-rated non-NAIA teams at this level from non_naia_teams.json
  // (already imported via PEAR). Used to produce named opponents per round
  // and to pick a believable national champion when the user loses.
  const nonNaiaTeams = (() => {
    const div = (nonNaiaTeamsData.divisions || []).find(d => d.id === level)
    return (div?.teams || []).filter(t => t.id !== state.userSchoolId)
  })()

  // Strength → universal-scale rating. PEAR strength is roughly 0-8 (D1 top
  // = ~7.4). We map to a rating curve where the strongest team gets ~92
  // and median gets ~60. This matches how user's nwbb rating is scaled.
  function strengthToRating(strength) {
    if (typeof strength !== 'number') return 55
    return Math.max(35, Math.min(95, 60 + (strength - 3.5) * 5.2))
  }

  // Pool of opponent teams sorted strongest first. We pluck one per round.
  // For higher rounds, we pluck from the elite tier (top 10), for early
  // rounds from the broader top 60.
  const sortedTeams = [...nonNaiaTeams].sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))

  function pickOpponent(roundIdx) {
    if (sortedTeams.length === 0) return null
    // Final/championship rounds → pick from top 10. Super → top 25.
    // Regionals → top 60. Random within the slice.
    const slice = roundIdx >= 2 ? 10
      : roundIdx >= 1 ? 25
      : 60
    const max = Math.min(slice, sortedTeams.length)
    const idx = Math.floor(rngForSim.next() * max)
    return sortedTeams[idx]
  }

  const games = []
  let userAlive = true
  let lastRoundWon = null
  for (let r = 0; r < rounds.length; r++) {
    if (!userAlive) break
    const round = rounds[r]
    const opp = pickOpponent(r)
    const oppRating = opp ? strengthToRating(opp.strength) : userRating + (r * 3)
    // Fast sim — user wins with prob = logistic(userRating - oppRating)
    const diff = userRating - oppRating
    const winProb = 1 / (1 + Math.exp(-diff * 0.18))
    const userWon = rngForSim.chance(winProb)
    // Synthesize a plausible game line so UI can display it
    const userRuns = userWon ? 4 + Math.floor(rngForSim.next() * 6) : Math.floor(rngForSim.next() * 4)
    const oppRuns = userWon ? Math.floor(rngForSim.next() * userRuns) : userRuns + 1 + Math.floor(rngForSim.next() * 5)
    games.push({
      round: round.name,
      location: round.location || '',
      opponentId: opp?.id || null,
      opponentName: opp?.name || 'TBD',
      opponentNickname: opp?.nickname || null,
      userRuns,
      oppRuns,
      userWon,
      winProb: Math.round(winProb * 100),
    })
    if (userWon) lastRoundWon = round.name
    else userAlive = false
  }
  const userWSChamp = userAlive && rounds.length > 0
  const userInWS = games.some(g =>
    g.round.includes('World Series') || g.round.includes('CWS') || (g.userWon && g.round.includes('Super')))

  // Final-game champion (if user lost): the team that knocked the user out
  // continues through the bracket — at the championship level the strongest
  // remaining team is likely the eventual national champ.
  let nationalChampion = null
  let nationalChampionName = null
  if (userWSChamp) {
    nationalChampion = state.userSchoolId
    nationalChampionName = state.schools[state.userSchoolId]?.name || null
  } else if (sortedTeams.length > 0) {
    // Pick a believable national champion from the top 6 strongest teams,
    // weighted by strength.
    const elites = sortedTeams.slice(0, 6)
    const totalStrength = elites.reduce((sum, t) => sum + Math.max(0.1, t.strength ?? 0), 0)
    let r2 = rngForSim.next() * totalStrength
    for (const t of elites) {
      r2 -= Math.max(0.1, t.strength ?? 0)
      if (r2 <= 0) { nationalChampion = t.id; nationalChampionName = t.name; break }
    }
    if (!nationalChampion) {
      nationalChampion = elites[0]?.id || null
      nationalChampionName = elites[0]?.name || null
    }
  }

  // News headlines
  const schoolName = state.schools[state.userSchoolId]?.name
  const lastGame = games[games.length - 1]
  if (userWSChamp) {
    state.newsfeed.unshift({
      id: `natchamp_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 18, type: 'POSTSEASON',
      headline: `${schoolName} WINS THE ${natSpec.name}! National champions at ${rounds[rounds.length - 1]?.location || 'national tournament site'}!`,
      payload: {}, big: true,
    })
  } else if (lastRoundWon) {
    const knockedOutBy = lastGame?.opponentName ? ` Knocked out by ${lastGame.opponentName}.` : ''
    state.newsfeed.unshift({
      id: `natexit_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 18, type: 'POSTSEASON',
      headline: `${schoolName} eliminated after the ${lastRoundWon}.${knockedOutBy} Solid postseason run.`,
      payload: {},
    })
  } else {
    const knockedOutBy = lastGame?.opponentName ? ` Lost to ${lastGame.opponentName}.` : ''
    state.newsfeed.unshift({
      id: `natfirst_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 18, type: 'POSTSEASON',
      headline: `${schoolName} lost in the opening round of the ${natSpec.name}.${knockedOutBy}`,
      payload: {},
    })
  }

  // National champion headline (if user wasn't the champ)
  if (nationalChampionName && nationalChampion !== state.userSchoolId) {
    state.newsfeed.unshift({
      id: `natchampother_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 18, type: 'POSTSEASON',
      headline: `${nationalChampionName} crowned ${state.calendar.year + 1} ${level} national champions.`,
      payload: {},
    })
  }

  return {
    games,
    nationalChampion,
    nationalChampionName,
    userORWon: games[0]?.userWon ?? false,
    userInWS, userWSChamp,
    lastRoundWon,
  }
}

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
 *   - Bumps weekOfYear (wraps 52 1, year++)
 *   - Re-derives mode + offseasonWeek + seasonWeek (back-compat)
 *   - Refreshes AP (locked = 0 for weeks 1-3)
 *   - Ticks bookkeeping (boosts, happiness)
 *   - Fires scheduled events for the new week (events.js)
 *   - Runs the full postseason bracket on the wk 39 40 transition
 *   - Runs minimal end-of-year on the wk 52 1 transition
 *
 * @param {SaveState} state
 */
export function advanceOneWeek(state) {
  ensureUnifiedCalendar(state)
  const prevWeek = state.calendar.weekOfYear ?? 1
  const prevPhaseKey = phaseForWeek(prevWeek)?.key

  // Tick the unified counter
  let nextWeek = prevWeek + 1
  let yearRolled = false
  if (nextWeek > WEEKS_PER_YEAR) {
    nextWeek = 1
    state.calendar.year++
    yearRolled = true
  }
  state.calendar.weekOfYear = nextWeek

  // Stamp the phase-transition marker if we crossed a SEASON-umbrella
  // boundary (e.g. Fall Camp → November, Spring Season → Postseason). We
  // intentionally DON'T fire for within-season phase changes (PORTAL →
  // MLB_DRAFT_WEEK → PORTAL inside Summer Recruiting, for example) — those
  // would spam the user with popups for the same period.
  const prevPhase = phaseForWeek(prevWeek)
  const newPhase = phaseForWeek(nextWeek)
  const prevSeason = prevPhase?.season
  const newSeason = newPhase?.season
  if (newSeason && newSeason !== prevSeason) {
    state._phaseTransition = {
      from: prevPhaseKey,
      to: newPhase?.key,
      fromSeason: prevSeason,
      toSeason: newSeason,
      year: state.calendar.year,
    }
  }
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
    // All-Conference + Gold Glove awards based on regular-season stats.
    // Fires BEFORE runPostseason so the awards are tied to the season
    // that just ended, not the postseason that's about to.
    runEndOfRegularSeasonAwards(state)
    runPostseason(state)
  }

  // Capture last-week AP spend BEFORE the refresh resets it — used by the
  // weekly team-GPA dynamic (lower utilization GPA drifts down).
  state._lastWeekApSpent = state.ap?.spentThisWeek ?? 0

  // Refresh AP and tick boosts. AP is LOCKED (= 0) during weeks 1-3 per the
  // new tutorial flow; refreshWeeklyAP enforces that.
  refreshWeeklyAP(state)
  tickWeeklyBookkeeping(state)
  tickTeamGPAWeekly(state)

  // Energy recovery — every player on the user's roster bounces back some
  // each week. Pitchers recover slower than position players. See energy.js.
  const userTeamForRecovery = state.teams?.[state.userSchoolId]
  if (userTeamForRecovery) {
    tickWeeklyRecovery(state, userTeamForRecovery.rosterPlayerIds || [])
  }

  // Passive offseason practice / conditioning dev. Fires for the user's
  // roster during Fall Camp / Winter Practice (full rate) and Fall
  // Conditioning (half rate). December Break + Late Summer + Summer
  // Recruiting are dead periods — no bump. The phase definition itself
  // controls this via `phase.devAllowed` + `phase.devRateMult`. Reuses
  // newPhase already computed above for the phase-transition stamp.
  if (newPhase?.devAllowed && !newPhase.inSeason) {
    const rateMult = newPhase.devRateMult ?? 1.0
    const userTeam = state.teams?.[state.userSchoolId]
    if (userTeam) {
      const roster = (userTeam.rosterPlayerIds || [])
        .map(id => state.players[id])
        .filter(Boolean)
      applyOffseasonPracticeDev(roster, rateMult, `${state.calendar.year}_${nextWeek}`)
    }
  }

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
        headline: `${p.firstName} ${p.lastName} cleared from injury. ${
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
  const injuriesOn = state.gameOptions?.injuriesEnabled !== false
  if (!isGameWeek && state.teams?.[state.userSchoolId] && injuriesOn) {
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
          headline: `${player.firstName} ${player.lastName} — ${injury.label} (${injury.totalWeeks} wk${injury.totalWeeks === 1 ? '' : 's'}). ${injury.blurb}`,
          payload: { playerId: pid, injuryType: injury.type, weeks: injury.totalWeeks, context: 'PRACTICE' },
        })
      }
    }
  }

  // Fire events for the new week (budget review, draft, portal opens, etc.)
  runEventsForWeek(state, nextWeek)

  // Story-mode random events. Roll for a popup that interrupts the next
  // user advance (modal blocks the +1 Week button until they respond).
  // Skipped silently for regular dynasties.
  try {
    maybeFireRandomEvent(state)
  } catch (err) {
    console.warn('random event roll threw:', err)
  }

  // Weekly recruiting decisions — tick weeksOutstanding on every live offer
  // and check whether any recruit decides to commit this week. Without this
  // the user's offers sit forever and nobody signs until Wk 52 finalization.
  tickRecruitingDecisions(state)

  // Recompute NWBB Ratings + SOS now that this week's games are in the
  // books. Cached on state.nwbbRatings so display code can render rank
  // chips next to team names without recomputing every render.
  state.nwbbRatings = recomputeNwbbRatings(state)

  // Sim any fall scrimmages whose weekOfYear matches the new week. Lets us
  // unify the scrimmage + game-week paths — they all flow through simWeek
  // and update boxscores / playerStats the same way. Skip the user's games
  // (those go through the live-play modal); auto-fall games NOT involving
  // the user are simulated quickly.
  simScrimmagesForCurrentWeek(state)
}

/**
 * Per-week recruiting decision tick:
 *   1. Bump weeksOutstanding on every live offer.
 *   2. For every open recruit who has an offer from the user, roll a sign
 *      probability via tryAdvanceRecruit. High-fit recruits commit fast,
 *      low-fit ones stay open (or eventually go elsewhere).
 *   3. For every previously-signed recruit, roll the rare D1/D2 "steal".
 *
 * Posts a newsfeed line every time a recruit commits so the user has a
 * narrative trail rather than discovering it on the Signed tab cold.
 */
function tickRecruitingDecisions(state) {
  if (!state.recruits) return
  const userId = state.userSchoolId
  const userSchool = state.schools?.[userId]
  if (!userSchool) return
  const rng = makeRng('recruit_decisions', state.rngSeed, state.calendar?.year, state.calendar?.weekOfYear)
  let newSigns = 0
  let newSteals = 0
  for (const r of Object.values(state.recruits)) {
    // 1. Tick weeksOutstanding on user's live offers
    if (r.liveOffer?.schoolId === userId) {
      r.liveOffer.weeksOutstanding = (r.liveOffer.weeksOutstanding || 0) + 1
    }
    // 2. Sign roll on open recruits with a user offer
    if (r.status === 'open' && r.liveOffer?.schoolId === userId) {
      const signed = tryAdvanceRecruit(r, userId, userSchool, rng, state)
      if (signed) {
        newSigns++
        state.newsfeed.unshift({
          id: `sign_${r.id}_${state.calendar?.year}_${state.calendar?.weekOfYear}`,
          year: state.calendar?.year, week: state.calendar?.week, type: 'RECRUIT_VERBAL',
          headline: `${r.firstName} ${r.lastName} (${r.primaryPosition}, ${r.hometown.city}, ${r.hometown.state}) committed!`,
          payload: { recruitId: r.id, pool: r.pool },
        })
      }
    }
    // 3. Signed-steal roll — rare D1/D2 swoop on already-committed players
    if (r.status === 'signed' && r.signedTo === userId) {
      const stolen = rollSignedSteal(r, rng)
      if (stolen) {
        newSteals++
        state.newsfeed.unshift({
          id: `steal_${r.id}_${state.calendar?.year}_${state.calendar?.weekOfYear}`,
          year: state.calendar?.year, week: state.calendar?.week, type: 'RECRUIT_FLIPPED',
          headline: `${r.firstName} ${r.lastName} flipped — a ${r.stolenBy || 'higher-division'} program landed him after he committed to you.`,
          payload: { recruitId: r.id },
        })
      }
    }
  }
  if (newSigns > 0) state._newCommitsThisWeek = newSigns
  if (newSteals > 0) state._stealsThisWeek = newSteals
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
