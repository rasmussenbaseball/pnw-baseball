/**
 * Season loop — runs a single week (or all remaining weeks) of games,
 * updates standings, recomputes rankings, ticks pitcher rest.
 *
 * Two tiers of fidelity (see sim.md):
 *   - Full PA-level sim for games involving the user's team
 *   - Fast monte-carlo sim for all other games in the league
 */

import { simGame, fastSimGame, defaultLineup } from './sim'
import { resolveLineupForGame, lineupPlayerIds, getSavedLineup, autoLineup } from './lineups'
import { computeFromSeason, seedFromPear } from './rankings'
import { applyScrimmageDev, applyWeeklyDevelopment, applyOffseasonPracticeDev } from './development'
import { runEndOfRegularSeasonAwards } from './awards'
import { setupInteractivePostseasonNAIA, advanceInteractivePostseasonNAIA, tickInteractivePostseason, setupInteractivePostseasonD2, advanceInteractivePostseasonD2, setupInteractivePostseasonD3, advanceInteractivePostseasonD3, setupInteractivePostseasonD1, advanceInteractivePostseasonD1, setupInteractivePostseasonNWAC, advanceInteractivePostseasonNWAC } from './postseasonInteractive'
import { awardForGameResult } from './coachProgression'
import { simAllConferenceTournaments } from './tournament'
import { runNationalTournament } from './nationalTournament'
import { playerOverall } from './playerRating'
import { tickHappiness } from './happiness'
import { tickTeamGPAWeekly } from './academics'
import { runEventsForWeek, advanceClassYearsAndExits } from './events'
import { buildSeasonRecap } from './seasonRecap'
import { maybeFireRandomEvent } from './randomEvents'
import { tryAdvanceRecruit, rollSignedSteal } from './recruits'
import { recomputeNwbbRatings } from './nwbbRating'
import { computeWeeklyAwards, revealWeeklyAwards } from './weeklyAwards'
import { runConferenceTournament, nationalSpecForLevel, qualifierCountForConf, runNwacPlayoffs, summarizeNwacUserPath, runNationalBracketFull, summarizeNationalUserPath } from './pnwPlayoffs'
import { runNationalChampionsTracking } from './nationalChampions'
import nonNaiaTeamsData from '../data/non_naia_teams.json'
import { buildAllConferenceSchedules, buildNonConferenceFillers, dateToWeekOfYear } from './schedule'
import { buildFullDivisionSchedule } from './newDynastyMultiLevel'
import { OFFSEASON_WEEKS } from './calendar'
import { WEEKS_PER_YEAR, modeForWeek, seasonWeekForWeek, ensureUnifiedCalendar, phaseForWeek, postseasonLayout } from './gameYear'
import { rollGameInjury, rollPracticeInjury, tickInjuries, applyInjury, isInjured, clearAllInjuriesForNewSeason } from './injuries'
import { makeRng } from './rng'
import {
  ensureEnergyState, getEnergy, applyGameEnergyCosts, tickWeeklyRecovery,
  tickIntraDayRecovery, energyInjuryMultiplier,
} from './energy'
import nonNaiaRaw from '../data/non_naia_teams.json'

/**
 * Lightweight synthetic lineup for non-NAIA opponents. Used by simWeek so
 * fast-simmed user games against D1/D2/D3/NWAC opponents can produce a
 * boxscore (which is what makes the USER side's stats accumulate). The
 * synthetic player IDs are filtered out before stats hit playerStats — only
 * the user's real roster shows up on leaderboards.
 *
 * @param {string} schoolId — non-NAIA opp id, used as a deterministic seed
 * @param {number} strength — non_naia_teams.json strength rating (~-3..+8)
 */
function makeSynthLineup(schoolId, strength) {
  const mean = 60 + (strength || 0) * 4   // ratings centered ~46-76
  let seed = 0
  const key = String(schoolId || 'synth')
  for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) >>> 0
  function nextRand() { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 16) / 0xFFFF }
  function gauss(m, s) {
    const u = Math.max(1e-6, nextRand()); const v = nextRand()
    return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  function clampRating(v) { return Math.max(25, Math.min(99, Math.round(v))) }
  const batters = []
  for (let i = 0; i < 9; i++) {
    batters.push({
      id: `synth_${schoolId}_h${i}`,
      hitter: {
        contact_r: clampRating(gauss(mean, 9)),
        contact_l: clampRating(gauss(mean, 9)),
        power_r:   clampRating(gauss(mean - 2, 10)),
        power_l:   clampRating(gauss(mean - 2, 10)),
        discipline: clampRating(gauss(mean, 8)),
        speed:     clampRating(gauss(mean, 10)),
      },
    })
  }
  const pitchers = []
  for (let i = 0; i < 4; i++) {
    pitchers.push({
      id: `synth_${schoolId}_p${i}`,
      pitcher: {
        stuff:   clampRating(gauss(mean, 9)),
        control: clampRating(gauss(mean, 8)),
      },
    })
  }
  return { batters, pitchers }
}

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
 * Tick down story-mode game-week holds — suspensions + minor injuries
 * stamped by random events (PLAYER_INCIDENT, CAR_ACCIDENT, GAMBLING,
 * CONCUSSION_PROTOCOL, etc.). autoLineup reads these flags to exclude
 * the player from the lineup + rotation. We decrement once per simWeek
 * call so a "3-game suspension" actually expires after 3 simmed
 * weekends (mirrors real baseball week granularity).
 *
 * Stamped year check: holds only count when they were set in the
 * CURRENT year. Mid-offseason flags from a previous year are stale
 * and ignored (don't carry over a 1-week sit through 30 offseason ticks).
 */
function decrementStoryHolds(state) {
  const curYear = state.calendar?.year ?? 0
  for (const pid of Object.keys(state.players || {})) {
    const p = state.players[pid]
    if (!p) continue
    if (p.suspended && p.suspended.year === curYear && (p.suspended.weeks || 0) > 0) {
      p.suspended.weeks -= 1
      if (p.suspended.weeks <= 0) delete p.suspended
    }
    if (p._minorInjuryFlag && p._minorInjuryFlag.year === curYear && (p._minorInjuryFlag.weeks || 0) > 0) {
      p._minorInjuryFlag.weeks -= 1
      if (p._minorInjuryFlag.weeks <= 0) delete p._minorInjuryFlag
    }
  }
}

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
  // Decrement story-mode game-week holds (suspensions + minor injuries).
  // These flags are READ by autoLineup() to keep flagged players out of
  // the lineup + rotation; here we tick them down by 1 week so a
  // "suspended 3 games" hold actually expires after 3 weeks of play
  // (instead of lasting forever, which was the launch-audit lying-
  // outcome bug — per Nate, May 2026).
  decrementStoryHolds(state)
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

  // ── Double-booking guard ──────────────────────────────────────────────
  // A team should play ONE series per week. But the user's non-conference
  // opponents can end up double-booked: the early-week non-conference fillers
  // are built at year-rollover (before the user schedules), so an opponent the
  // user later adds may already have a filler that same week. Left unchecked,
  // that team plays ~6 games and racks up impossible weekly lines (16+ IP,
  // 28 AB) that win Player of the Week. Pre-pass: for THIS week's games, drop
  // any NON_CONFERENCE *filler* series (no user side) whose teams are already
  // playing another series this week.
  {
    const inWeek = (g) => !g.played && g.type !== 'BYE'
      && ((targetWeek != null && g.seasonWeek === targetWeek)
        || (g.weekOfYear != null && targetWeekOfYear != null && g.weekOfYear === targetWeekOfYear))
    const weekGames = sortedSchedule.filter(inWeek)
    const seriesByTeam = {}
    for (const g of weekGames) {
      for (const tid of [g.homeId, g.awayId]) {
        if (!seriesByTeam[tid]) seriesByTeam[tid] = new Set()
        seriesByTeam[tid].add(g.seriesId || g.id)
      }
    }
    for (const g of weekGames) {
      if (g.type !== 'NON_CONFERENCE') continue
      if (g.homeId === userSchoolId || g.awayId === userSchoolId) continue   // never drop a user game
      const homeMulti = (seriesByTeam[g.homeId]?.size || 0) > 1
      const awayMulti = (seriesByTeam[g.awayId]?.size || 0) > 1
      if (homeMulti || awayMulti) g.played = true   // cancel this filler game (consumed, no sim)
    }
  }

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
      // Both sides are real NAIA teams — full sim. The user's side uses their
      // saved lineup if set, else a smart auto lineup; the opponent uses a
      // smart auto lineup too (positional, rotates a role player in).
      const homeLineup = g.homeId === userSchoolId
        ? resolveLineupForGame(state, userSchoolId, g.id)
        : autoLineup(state, g.homeId, g.id)
      const awayLineup = g.awayId === userSchoolId
        ? resolveLineupForGame(state, userSchoolId, g.id)
        : autoLineup(state, g.awayId, g.id)
      const homeHC = state.coaches[homeTeam.headCoachId]
      const awayHC = state.coaches[awayTeam.headCoachId]
      // MIDWEEK pitcher exclusion (per Nate): for D1_MIDWEEK games, the top
      // 4 arms by skill (the weekend rotation — Fri/Sat/Sun SPs + the
      // swingman) are NEVER allowed to throw. Real teams pitch deep bullpen
      // arms on Tuesdays and save their Fri/Sat/Sun SPs for the weekend
      // series. We enforce that here by slicing the top 4 off both
      // pitcherRotation arrays before sim — leaving only slots 4+ as the
      // entire available staff for the midweek game. simGame then picks
      // rotation[0] (now the 5th-best arm overall) as the starter and uses
      // the rest as relief.
      // Honor either the explicit isMidweek flag (set by buildMidweekSingle
      // for manually-added Tuesday games at any level) OR the legacy
      // D1_MIDWEEK type (used by the auto-scheduler + NAIA-vs-D1 path).
      // Both signal "no weekend SPs on this Tuesday."
      const isMidweekGame = g.isMidweek === true || g.type === 'D1_MIDWEEK'
      if (isMidweekGame) {
        homeLineup.pitcherRotation = (homeLineup.pitcherRotation || []).slice(4)
        awayLineup.pitcherRotation = (awayLineup.pitcherRotation || []).slice(4)
      }
      // ROTATE STARTER BY GAME-IN-SERIES (per Nate, May 2026 — POTW
      // always going to user fix). Parse the _g\d+ suffix on the game id
      // so a 4-game weekend uses pitchers #0/#1/#2/#3 instead of
      // starting the #1 SP four times in a row. Without this, the user
      // (and every other team) accumulates 60+ weekly outs on their
      // ace — which the POTW selector disqualifies (>25 outs cap),
      // leaving relievers to win pitcher-of-the-week. Midweek games
      // already sliced the top 4 arms off, so slot 0 is the deep arm.
      const seriesMatch = String(g.id).match(/_g(\d+)$/)
      const gameInSeries = seriesMatch ? parseInt(seriesMatch[1], 10) : 0
      const homeRotLen = (homeLineup.pitcherRotation || []).length
      const awayRotLen = (awayLineup.pitcherRotation || []).length
      const homeStarterIdx = isMidweekGame
        ? 0
        : (gameInSeries % Math.max(1, homeRotLen))
      const awayStarterIdx = isMidweekGame
        ? 0
        : (gameInSeries % Math.max(1, awayRotLen))
      result = simGame(homeLineup, awayLineup, {
        homeMotivator: homeHC?.motivator ?? 50,
        awayMotivator: awayHC?.motivator ?? 50,
        homeStarterIdx,
        awayStarterIdx,
        // Team OVR offsets — bring the sim in line with the displayed
        // Team OVR. Without this, a 98-OVR team whose roster naturally
        // landed at 95 (due to 99 rating clamps) was simming as a 95.
        homeOvrOffset: homeTeam.ovrOffset ?? 0,
        awayOvrOffset: awayTeam.ovrOffset ?? 0,
        getEnergy: energyAccessor,
        neutralSite: !!g.neutralSite,   // postseason neutral-site games get no home edge
        level: state.level || state.schools?.[userSchoolId]?.level || 'NAIA',
      }, g.id)
    } else if (isUserGame) {
      // User vs. non-NAIA opponent — fast sim against static strength,
      // but pass the user's lineup + a synthetic opp lineup so fastSimGame
      // can produce a lightweight boxscore. Without this the user's fall
      // games against D2/D3 opponents would accumulate ZERO season stats.
      const userIsHome = g.homeId === userSchoolId
      const userRating = ratings?.[userSchoolId] ?? { overall_rating: 0, offense_rating: 0, pitching_rating: 0 }
      const nonNaiaId = userIsHome ? g.awayId : g.homeId
      const nonNaiaInfo = NON_NAIA_LOOKUP[nonNaiaId]
      const oppRating = {
        overall_rating: nonNaiaInfo?.strength ?? 0,
        offense_rating: (nonNaiaInfo?.strength ?? 0) * 0.5,
        pitching_rating: (nonNaiaInfo?.strength ?? 0) * 0.5,
      }
      const userLineup = resolveLineupForGame(state, userSchoolId, g.id)
      const synthLineup = makeSynthLineup(nonNaiaId, nonNaiaInfo?.strength ?? 0)
      const homeLineup = userIsHome ? userLineup : synthLineup
      const awayLineup = userIsHome ? synthLineup : userLineup
      result = userIsHome
        ? fastSimGame(userRating, oppRating, g.id, { homeLineup, awayLineup })
        : fastSimGame(oppRating, userRating, g.id, { homeLineup, awayLineup })
    } else {
      // Non-user game. Generate lineup-based boxscores for EVERY game where
      // both teams are real (i.e. every team in the user's league plays + puts
      // up stats every week) so weekly awards + leaderboards aren't a one-team
      // show. Both teams must exist in state.teams (same-level league members).
      const wantBoxscore = !!(homeTeam && awayTeam)
      const opts = wantBoxscore ? {
        homeLineup: autoLineup(state, g.homeId, g.id),
        awayLineup: autoLineup(state, g.awayId, g.id),
      } : undefined
      result = fastSimGame(
        ratings?.[g.homeId] ?? { overall_rating: 0, offense_rating: 0, pitching_rating: 0 },
        ratings?.[g.awayId] ?? { overall_rating: 0, offense_rating: 0, pitching_rating: 0 },
        g.id,
        opts,
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
      // EQUAL FOOTING: charge the OPPONENT's lineup the same per-game energy
      // costs. simGame applies the energy dampener to BOTH sides via getEnergy,
      // but previously only the user accrued fatigue — opponents always played
      // at 100 energy (full strength) while the user's stars tired across a
      // series. That silently weakened ONLY the user, dragging a top-rated team
      // to ~.500. Fatiguing the opponent too makes the head-to-head symmetric.
      const oppAppearances = result.appearances
        .filter(a => {
          if (a.isPitcher) return !userTeam?.rosterPlayerIds.includes(a.playerId)
          return a.teamId !== userSide
        })
        .map(a => ({ ...a, isSecondGameOfDay: isSecond }))
      applyGameEnergyCosts(state, oppAppearances)
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
    // Fall games were removed (May 2026), so everything flows into the
    // single state.playerStats bucket. Spring scrimmages still count.
    if (result.boxscore?.batterStats) {
      if (!state.playerStats) state.playerStats = {}
      const accumulate = (statsObj, isPitcher) => {
        for (const [pid, s] of Object.entries(statsObj)) {
          // Skip synthetic opponents — they aren't in save.players so they'd
          // pollute playerStats with phantom rows that no UI can resolve to
          // a name. fastSimGame's lightweight boxscore generates these for
          // non-NAIA opponents in user games + non-conference NAIA games.
          if (!state.players[pid]) continue
          const key = isPitcher ? `p_${pid}` : `b_${pid}`
          if (!state.playerStats[key]) state.playerStats[key] = { playerId: pid, isPitcher, ...zeroStats(isPitcher) }
          const target = state.playerStats[key]
          for (const k of Object.keys(s)) target[k] = (target[k] || 0) + s[k]
          // gamesPlayed: a single appearance in this game counts as 1.
          target.gamesPlayed = (target.gamesPlayed || 0) + 1
          // Mirror into weeklyStats for weekly awards — exclude spring
          // scrimmages (they don't count toward awards). Cleared at the top
          // of simWeek; read by weeklyAwards.computeWeeklyAwards at the end.
          if (g.type !== 'SPRING_SCRIMMAGE') {
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
      const hi = Math.max(result.homeRuns, result.awayRuns)
      const lo = Math.min(result.homeRuns, result.awayRuns)
      userResults.push({
        gameId: g.id,
        opponent: oppSchool?.name || 'Unknown',
        homeAway: g.homeId === userSchoolId ? 'home' : 'away',
        result: userWon ? 'W' : 'L',
        score: `${hi}-${lo}`,
      })
      // Newsfeed entry — so the News tab + multi-week sim recap show the
      // result alongside other weekly events. Tag fall scrim / spring scrim
      // explicitly so users can scan game type at a glance.
      state.newsfeed = state.newsfeed || []
      const ha = g.homeId === userSchoolId ? 'vs' : '@'
      const tag = g.type === 'FALL_SCRIMMAGE' ? ' (fall scrim)'
        : g.type === 'SPRING_SCRIMMAGE' ? ' (spring scrim)'
        : ''
      state.newsfeed.unshift({
        id: `game_${g.id}`,
        year: state.calendar?.year,
        week: state.calendar?.weekOfYear ?? state.calendar?.offseasonWeek ?? 1,
        type: 'GAME',
        headline: `${userWon ? 'W' : 'L'} ${hi}-${lo} ${ha} ${oppSchool?.name || 'Unknown'}${tag}`,
      })
    }
  }

  // ── Weekly awards (Conf + NAIA Hitter / Pitcher of the Week) ──────────
  // Computed from state.weeklyStats (populated above during simWeek). Posts
  // to newsfeed and bumps the user's player stats + coach upgrade points
  // when the user's roster wins one.
  // Player-of-the-Week is announced a week LATE (per Nate): reveal LAST week's
  // queued POTW now — every game-week tick, including the first postseason week
  // so the final regular-season award still surfaces. Then compute THIS week's
  // (regular season only — no playoff POTW) and queue it for next week's reveal.
  revealWeeklyAwards(state)
  if (gamesPlayed > 0 && state.calendar?.mode === 'SEASON') {
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

  // Interactive postseason: after the user's pending bracket game is simmed,
  // advance the bracket (generate the next single game, or resolve the round).
  if (state.postseason?.interactive && state.postseason.stage !== 'DONE') {
    try { tickInteractivePostseason(state) } catch (err) { console.error('postseason tick failed:', err) }
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
  // advanceOneWeek already ticked state.calendar.year on the 52→1 rollover
  // BEFORE calling runEndOfYear, so the season that just finished is (year-1).
  // Archive under that finished year, not the new one.
  const archivedYear = (state.calendar?.year ?? 1) - 1
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
  // Win-or-die promise resolution (from AD_MEETING). If the user took the
  // "Promise immediate results" choice, check that promise against the
  // just-finished year's record. Below the threshold → big job sec hit +
  // news line. Above → drop the flag silently (kept their word).
  if (state._winOrDiePromise && state._winOrDiePromise.year === archivedYear) {
    const ut = state.teams[state.userSchoolId]
    const games = (ut?.wins || 0) + (ut?.losses || 0)
    const winPct = games > 0 ? ut.wins / games : 0
    const threshold = state._winOrDiePromise.winThreshold ?? 0.5
    if (winPct < threshold) {
      if (state.budget) state.budget.jobSecurity = Math.max(0, (state.budget.jobSecurity || 50) - 15)
      state.newsfeed?.unshift({
        id: `wod_fail_${archivedYear}`,
        year: archivedYear, week: 52, type: 'AWARD', big: true,
        headline: `AD recap: you promised immediate results and finished ${ut?.wins || 0}-${ut?.losses || 0} (${(winPct * 100).toFixed(0)}%). Job security -15.`,
        payload: {},
      })
    } else {
      state.newsfeed?.unshift({
        id: `wod_kept_${archivedYear}`,
        year: archivedYear, week: 52, type: 'AWARD',
        headline: `You kept the "win-or-die" promise to the AD. Trust earned.`,
        payload: {},
      })
    }
    state._winOrDiePromise = null
  }

  const userTeam = state.teams[state.userSchoolId]
  if (userTeam) {
    userTeam._lastSeason = {
      wins: userTeam.wins, losses: userTeam.losses,
      runDiff: userTeam.runDiff,
    }
  }

  // Year-rollover class advancement + roster exits (per Nate, May 2026).
  // Moved out of the wk-44 PLAYER_DEVELOPMENT hook because flipping FRs to
  // SOs and graduating seniors mid-offseason broke the "open spots" math
  // throughout the entire recruiting window. We do this BEFORE the season
  // recap so the recap shows next year's class structure correctly.
  // Also advances opponent classes + freshman backfill + refits non-user
  // ovrOffsets to keep displayed team strength pinned to PEAR/PPI rank.
  try {
    advanceClassYearsAndExits(state)
  } catch (err) {
    console.warn('class-advance step failed:', err)
  }

  // Build the comprehensive Season Recap BEFORE we clear postseason / recruits
  // / playerStats below — Dashboard pops the recap modal the first time the
  // user advances into the new year. See engine/seasonRecap.js.
  try {
    state.lastSeasonRecap = buildSeasonRecap(state)
  } catch (err) {
    console.warn('season recap build failed:', err)
    state.lastSeasonRecap = null
  }

  // Carry the FINAL NWBB ratings forward as next year's preseason seed, so the
  // Rankings page starts the new season where this one ended (per Nate) instead
  // of resetting to the static PEAR preseason numbers. buildPreseasonSeeds()
  // reads state.carriedRatings on the next recompute.
  if (state.nwbbRatings) {
    state.carriedRatings = {}
    for (const [tid, r] of Object.entries(state.nwbbRatings)) {
      // Only carry NAIA teams (non-NAIA are reseeded to their fixed strength).
      if (state.schools?.[tid] && typeof r?.rating === 'number') {
        state.carriedRatings[tid] = r.rating
      }
    }
  }

  // Calendar transition. NOTE: advanceOneWeek already incremented
  // state.calendar.year when it wrapped weekOfYear 52→1, so we must NOT
  // increment again here (doing so double-counted the year and pushed the
  // new season a full year into the future). Just normalize the legacy
  // mode/week fields.
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
  // Fresh recruiting board for the new cycle. Signed recruits have already
  // joined the roster (class finalize, wk52), so the OLD board must be wiped —
  // otherwise last year's signees linger (the "16 players signed" carryover)
  // and their stale live offers re-commit during the new year's weeks 1-3.
  // The fall recruiting board lazily regenerates (ensureRecruitPool) once
  // scouting opens in week 4.
  state.recruits = {}
  state._newCommitRecruits = []
  // Fresh energy for everyone — players shouldn't carry last season's (or the
  // postseason's) fatigue into fall. Without this, arms that threw in the WS
  // start the new year gassed and the energy dampener skews early sims.
  state.playerEnergy = {}
  // Saved lineups are keyed by game id; the schedule is rebuilt below with NEW
  // ids, so last year's lineups are orphaned dead weight — drop them.
  state.lineups = {}
  // Clear last season's postseason bracket so nothing stale lingers until the
  // new postseason is set up (wk39→40).
  state.postseason = null
  // POTW reveal buffers don't carry across seasons.
  state._pendingPotw = null
  state._potwUserWinners = []
  // Fresh summer-ball state. Last year's RESOLVED assignments lingered, so the
  // wk18 auto-assign saw assignedBefore > 0 and SKIPPED — nobody got assigned
  // to summer ball in year 2. Clearing it lets ensureSummerBallState rebuild a
  // clean PLANNING slate for the new year.
  state.summerBall = null
  // Re-prompt the user to set their non-conference weekends for the new year.
  // rebuildScheduleForYear auto-generates the conference round-robin, but the
  // user's own non-conf games don't carry over, so without this they'd start
  // the season with a half-empty schedule.
  state.scheduleComplete = false
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

  // simGame callback — use fast monte-carlo against the universal rating.
  // Defined first so the NWAC branch (which doesn't go through the conf-
  // tournament path) can use the same callback.
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

  // NWAC postseason: skips the per-conference tournament entirely. The NWAC
  // playoff structure IS the postseason — regular-season conf record seeds
  // the divisions, top 4 from each div feed super regionals + championship
  // (see runNwacPlayoffs in pnwPlayoffs.js). Each conference doesn't run a
  // separate tournament; the conf record IS the bid.
  if (level === 'NWAC') {
    const nwacResult = runNwacPlayoffs(state, simGame, `nwac_${state.calendar.year}`)
    const userPath = summarizeNwacUserPath(nwacResult, state.userSchoolId)

    // Apply W/L from the user's games to the user team (record only)
    const userGamesFromResult = []
    if (userPath.qualified && userPath.superRegional) {
      const sr = userPath.superRegional
      if (sr.playInGame && (sr.playInA === state.userSchoolId || sr.playInB === state.userSchoolId)) {
        userGamesFromResult.push({
          homeId: sr.playInA, awayId: sr.playInB,
          homeRuns: sr.playInGame.homeRuns, awayRuns: sr.playInGame.awayRuns,
        })
      }
      for (const g of (sr.bo3Games || [])) {
        if (g.homeId === state.userSchoolId || g.awayId === state.userSchoolId) userGamesFromResult.push(g)
      }
    }
    if (userPath.qualified && nwacResult.championship) {
      for (const g of (nwacResult.championship.games || [])) {
        if (g.homeId === state.userSchoolId || g.awayId === state.userSchoolId) userGamesFromResult.push(g)
      }
    }
    for (const g of userGamesFromResult) {
      const userHome = g.homeId === state.userSchoolId
      const userRuns = userHome ? g.homeRuns : g.awayRuns
      const oppRuns = userHome ? g.awayRuns : g.homeRuns
      state.teams[state.userSchoolId].runDiff += userRuns - oppRuns
    }

    state.postseason = {
      year: state.calendar.year + 1,
      level,
      nwac: nwacResult,
      nwacUserPath: userPath,
      tournaments: [],
      autoBids: nwacResult.championship?.qualifiers || [],
      userChamp: userPath.wonChampionship,
      userQualified: userPath.qualified,
      userInField: userPath.inChampionship,
      userORWon: userPath.wonSuperRegional,
      userInWS: userPath.inChampionship,
      userWSChamp: userPath.wonChampionship,
    }

    // News headlines for the NWAC postseason path
    const userName = state.schools[state.userSchoolId]?.name
    const champName = state.schools[nwacResult.nwacChampion]?.name || 'TBD'
    if (userPath.wonChampionship) {
      state.newsfeed.unshift({
        id: `nwac_champ_${state.calendar.year}`,
        year: state.calendar.year + 1, week: 42, type: 'POSTSEASON',
        headline: `${userName} WINS THE NWAC CHAMPIONSHIP at Longview, WA!`,
        big: true,
      })
    } else if (userPath.inChampionship) {
      state.newsfeed.unshift({
        id: `nwac_finals_${state.calendar.year}`,
        year: state.calendar.year + 1, week: 42, type: 'POSTSEASON',
        headline: `Advanced to the 8-team NWAC Championship in Longview, WA. ${champName} took the title.`,
        big: true,
      })
    } else if (userPath.wonSuperRegional) {
      state.newsfeed.unshift({
        id: `nwac_sr_${state.calendar.year}`,
        year: state.calendar.year + 1, week: 41, type: 'POSTSEASON',
        headline: `Won NWAC Super Regional — Longview-bound!`,
      })
    } else if (userPath.qualified) {
      const where = userPath.hadBye ? '#1 seed bye (but lost championship)' : `seeded #${userPath.seed} (eliminated)`
      state.newsfeed.unshift({
        id: `nwac_exit_${state.calendar.year}`,
        year: state.calendar.year + 1, week: 41, type: 'POSTSEASON',
        headline: `NWAC playoff run ends — ${where}. ${champName} won it all.`,
      })
    } else {
      state.newsfeed.unshift({
        id: `nwac_miss_${state.calendar.year}`,
        year: state.calendar.year + 1, week: 40, type: 'POSTSEASON',
        headline: `Missed the NWAC playoffs (top 4 in division required). ${champName} won the NWAC.`,
      })
    }

    runNationalChampionsTracking(state, level)
    return state.postseason
  }

  // Non-NWAC multi-level (D1/D2/D3): single-conference tournament + stub
  // national bracket. The conference-tournament path below is unchanged.
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

  // ── Full national bracket (D1/D2/D3) ────────────────────────────────
  // Real bracket sim: every conference produces an auto-bid champion,
  // at-large bids fill the field by NWBB rating / PEAR strength, then we
  // run regionals → super regionals (D1/D3) → 8-team double-elim World
  // Series. The user's team is plugged in at its true overall seed if it
  // qualified (auto-bid by winning their conf tournament, or at-large by
  // rating). Uses the full team universe in non_naia_teams.json.
  const levelTeams = (nonNaiaTeamsData.divisions || []).find(d => d.id === level)?.teams || []
  // simGame for the national bracket — strength-aware ratings, user gets
  // their nwbbRating-derived line.
  const userRatingForNat = state.nwbbRatings?.[state.userSchoolId]?.rating ?? 60
  const ratingCache = {}
  const natRng = makeRng('natratings', state.rngSeed, state.calendar.year, level)
  const ratingForNat = (sid) => {
    if (ratingCache[sid]) return ratingCache[sid]
    let r
    if (sid === state.userSchoolId) {
      r = { overall_rating: (userRatingForNat - 60) / 5, offense_rating: (userRatingForNat - 60) / 10, pitching_rating: (userRatingForNat - 60) / 10 }
    } else {
      const t = levelTeams.find(x => x.id === sid)
      const s = (t?.strength ?? 0) + (natRng.next() - 0.5) * 1.5
      r = { overall_rating: s, offense_rating: s * 0.5, pitching_rating: s * 0.5 }
    }
    ratingCache[sid] = r
    return r
  }
  const natSimGame = (h, a, key) => fastSimGame(ratingForNat(h), ratingForNat(a), key)

  // If the user won their conf tournament they hold an auto-bid; otherwise
  // they may still earn an at-large via rating (handled inside the runner).
  const national = runNationalBracketFull(state, level, levelTeams, natSimGame, `nat_${state.calendar.year}_${level}`)
  const userNatPath = summarizeNationalUserPath(national, state.userSchoolId)

  // Apply the user's national-bracket game W/L to their record (run diff).
  if (userNatPath.qualified && national) {
    const userGames = []
    if (userNatPath.region) for (const g of (userNatPath.region.games || [])) {
      if (g.homeId === state.userSchoolId || g.awayId === state.userSchoolId) userGames.push(g)
    }
    if (userNatPath.superPair) for (const g of (userNatPath.superPair.games || [])) {
      if (g.homeId === state.userSchoolId || g.awayId === state.userSchoolId) userGames.push(g)
    }
    if (national.worldSeries) for (const g of (national.worldSeries.games || [])) {
      if (g.homeId === state.userSchoolId || g.awayId === state.userSchoolId) userGames.push(g)
    }
    for (const g of userGames) {
      const userHome = g.homeId === state.userSchoolId
      const userRuns = userHome ? g.homeRuns : g.awayRuns
      const oppRuns = userHome ? g.awayRuns : g.homeRuns
      state.teams[state.userSchoolId].runDiff += userRuns - oppRuns
    }
  }

  const natSpec = nationalSpecForLevel(level)
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
    autoBids: (national?.field?.autoBids || []).map(t => t.id),
    atLargeBids: (national?.field?.atLargeBids || []).map(t => t.id),
    userChamp,
    userQualified: userNatPath.qualified,
    national,
    nationalUserPath: userNatPath,
    nationalSpec: natSpec,
    nationalChampion: national?.nationalChampion || null,
    userInField: userNatPath.qualified,
    userORWon: userNatPath.wonRegion ?? false,
    userInWS: userNatPath.inWS ?? false,
    userWSChamp: userNatPath.wonWS ?? false,
  }

  // National-conf-champion tracking — sims every level-relevant conference's
  // champion + builds the full national field. Cached on
  // state.nationalChamps[year][level] for the Postseason page.
  runNationalChampionsTracking(state, level)

  // Newsfeed lines — conference + national bracket outcome.
  const userName = state.schools[state.userSchoolId].name
  const wsName = natSpec?.name || 'national tournament'
  const champName = state.schools[national?.nationalChampion]?.name
    || levelTeams.find(t => t.id === national?.nationalChampion)?.name
    || 'TBD'
  if (userChamp) {
    state.newsfeed.unshift({
      id: `confchamp_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 17, type: 'POSTSEASON',
      headline: `${userName} wins the ${conf.name}! Auto-bid to the ${wsName}.`,
      payload: {}, big: true,
    })
  } else if (state.postseason.userQualified) {
    state.newsfeed.unshift({
      id: `atlarge_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 17, type: 'POSTSEASON',
      headline: `${userName} earns an AT-LARGE bid to the ${wsName} (seed #${userNatPath.seed}).`,
      payload: {}, big: true,
    })
  }
  // National-run headlines
  if (userNatPath.wonWS) {
    state.newsfeed.unshift({
      id: `natchamp_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 19, type: 'POSTSEASON',
      headline: `${userName} ARE NATIONAL CHAMPIONS — wins the ${wsName}!`,
      payload: {}, big: true,
    })
  } else if (userNatPath.inWS) {
    state.newsfeed.unshift({
      id: `natws_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 19, type: 'POSTSEASON',
      headline: `Reached the ${wsName}! ${champName} won the national title.`,
      payload: {}, big: true,
    })
  } else if (userNatPath.wonSuper) {
    state.newsfeed.unshift({
      id: `natsuper_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 18, type: 'POSTSEASON',
      headline: `Won the Super Regional — advancing to the ${wsName}!`,
      payload: {},
    })
  } else if (userNatPath.wonRegion) {
    state.newsfeed.unshift({
      id: `natreg_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 18, type: 'POSTSEASON',
      headline: `Won the Regional! ${national?.superRegionals ? 'On to the Super Regional.' : `Headed to the ${wsName}.`}`,
      payload: {},
    })
  } else if (userNatPath.qualified) {
    state.newsfeed.unshift({
      id: `natexit_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 18, type: 'POSTSEASON',
      headline: `Eliminated in Regionals (seed #${userNatPath.seed}). ${champName} won the ${wsName}.`,
      payload: {},
    })
  } else if (!userChamp) {
    state.newsfeed.unshift({
      id: `natmiss_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 17, type: 'POSTSEASON',
      headline: `Missed the ${wsName} field. ${champName} won the national title.`,
      payload: {},
    })
  }
  return { tournaments: state.postseason.tournaments, autoBids: state.postseason.autoBids }
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

  // AP is LOCKED during weeks 1-3 (tutorial) AND during the postseason weeks
  // 40-42. Postseason is all about playing/managing playoff games — there are
  // no recruiting/development levers to spend AP on, so it's zeroed out (and
  // playoff teams are the only ones doing anything those weeks anyway).
  const wk = state.calendar?.weekOfYear ?? 0
  if ((wk >= 1 && wk <= 3) || (wk >= 40 && wk <= 42)) {
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
  // Story-mode GA hire (from the GA_HIRE event) — +3 AP/week while the
  // GA is still on staff (3 dynasty years from the hire year).
  if (state.flags?.gaHelperUntilYear && (state.calendar?.year ?? 0) <= state.flags.gaHelperUntilYear) {
    total += 3
  }
  let weekly = Math.max(20, Math.min(50, Math.round(total)))
  // Difficulty actually bites in a regular dynasty now: it scales your weekly
  // AP, so harder = fewer Action Points to spend on recruiting + development.
  const DIFF_AP_MULT = { EASY: 1.25, NORMAL: 1.0, HARD: 0.85, BRUTAL: 0.70 }
  const diff = state.gameOptions?.difficulty || 'NORMAL'
  weekly = Math.round(weekly * (DIFF_AP_MULT[diff] ?? 1.0))
  // October (wk 9), November (wk 13), December (wk 18) are single "month"
  // turns — grant a full month of AP (4× the weekly value) so the user can
  // do a month's worth of recruiting + development in that one turn.
  if (wk === 9 || wk === 13 || wk === 18) weekly *= 4
  // Week 4 is the FIRST recruiting week (scouting opens). Grant a big one-time
  // board-building budget (100 AP) so the user can fully scout + start
  // courting their recruiting board right away. This replaced the old
  // prospect-camp mechanic (removed May 2026).
  if (wk === 4) weekly = Math.max(weekly, 100)
  // SUMMER RECRUITING WINDOW (wks 43-52). Per Nate: rosters drop after the
  // draft + portal-out wave, and there are only ~9 weeks to refill. Players
  // are filling spots from D1 transfer portal which moves fast in real life.
  // DOUBLE the weekly AP to give the user enough lever to actually rebuild.
  // Cap stays sane — 100 max so a coach with a strong staff doesn't drown.
  if (wk >= 43 && wk <= 52) weekly = Math.min(100, weekly * 2)
  state.ap.currentWeek = weekly
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

  // Re-derive mode + week-of-mode for legacy consumers (level-aware: 4-round
  // leagues like D2 start the postseason a week earlier).
  state.calendar.mode = modeForWeek(nextWeek, state.level)
  state.calendar.seasonWeek = seasonWeekForWeek(nextWeek, state.level)
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

  // ── Postseason ──────────────────────────────────────────────────────
  // Interactive, round-by-round: the user's games for each round are generated
  // into the schedule and PLAYED via the normal game-week flow. NAIA = 3 rounds
  // (conf tourney wk40 → regionals wk41 → WS wk42). D2 = 4 rounds, starting a
  // week earlier (conf tourney wk39 → regional wk40 → super regional wk41 → WS
  // wk42). Other levels still use the all-at-once runPostseason for now.
  const isNaia = !state.level || state.level === 'NAIA'
  const isD1 = state.level === 'D1'
  const isD2 = state.level === 'D2'
  const isD3 = state.level === 'D3'
  const L = postseasonLayout(state.level)
  // Postseason START (regular season just ended → first playoff round).
  if (nextWeek === L.start && prevWeek === L.seasonEnd) {
    // Snapshot the user's roster for the season-end Stats archive (before
    // offseason graduations/transfers strip players who played that spring).
    {
      const ut = state.teams?.[state.userSchoolId]
      if (ut) {
        if (!state.rosterArchive) state.rosterArchive = {}
        state.rosterArchive[state.calendar.year] = [...(ut.rosterPlayerIds || [])]
      }
    }
    // All-Conference + Gold Glove awards based on regular-season stats.
    runEndOfRegularSeasonAwards(state)
    if (isNaia) {
      try { setupInteractivePostseasonNAIA(state) }
      catch (err) { console.error('interactive postseason setup failed:', err); runPostseason(state) }
    } else if (isD2) {
      try { setupInteractivePostseasonD2(state) }
      catch (err) { console.error('D2 postseason setup failed:', err); runPostseason(state) }
    } else if (isD3) {
      try { setupInteractivePostseasonD3(state) }
      catch (err) { console.error('D3 postseason setup failed:', err); runPostseason(state) }
    } else if (isD1) {
      try { setupInteractivePostseasonD1(state) }
      catch (err) { console.error('D1 postseason setup failed:', err); runPostseason(state) }
    } else if (state.level === 'NWAC') {
      try { setupInteractivePostseasonNWAC(state) }
      catch (err) { console.error('NWAC postseason setup failed:', err); runPostseason(state) }
    } else {
      runPostseason(state)
    }
  }
  // Round transitions: resolve the round just played + set up the next one.
  if (state.postseason?.interactive) {
    if (isNaia) {
      if (nextWeek === 41 && prevWeek === 40) advanceInteractivePostseasonNAIA(state, 40)
      else if (nextWeek === 42 && prevWeek === 41) advanceInteractivePostseasonNAIA(state, 41)
      else if (nextWeek === 43 && prevWeek === 42) advanceInteractivePostseasonNAIA(state, 42)
    } else if (isD2) {
      if (nextWeek === 40 && prevWeek === 39) advanceInteractivePostseasonD2(state, 39)
      else if (nextWeek === 41 && prevWeek === 40) advanceInteractivePostseasonD2(state, 40)
      else if (nextWeek === 42 && prevWeek === 41) advanceInteractivePostseasonD2(state, 41)
      else if (nextWeek === 43 && prevWeek === 42) advanceInteractivePostseasonD2(state, 42)
    } else if (isD3) {
      if (nextWeek === 40 && prevWeek === 39) advanceInteractivePostseasonD3(state, 39)
      else if (nextWeek === 41 && prevWeek === 40) advanceInteractivePostseasonD3(state, 40)
      else if (nextWeek === 42 && prevWeek === 41) advanceInteractivePostseasonD3(state, 41)
      else if (nextWeek === 43 && prevWeek === 42) advanceInteractivePostseasonD3(state, 42)
    } else if (isD1) {
      if (nextWeek === 40 && prevWeek === 39) advanceInteractivePostseasonD1(state, 39)
      else if (nextWeek === 41 && prevWeek === 40) advanceInteractivePostseasonD1(state, 40)
      else if (nextWeek === 42 && prevWeek === 41) advanceInteractivePostseasonD1(state, 41)
      else if (nextWeek === 43 && prevWeek === 42) advanceInteractivePostseasonD1(state, 42)
    } else if (state.level === 'NWAC') {
      // NWAC postseason is 2 weeks: regionals wk40, championship wk41.
      // Setup of wk40's regionals happens via the POSTSEASON START hook
      // (setupInteractivePostseasonNWAC) — runs when crossing wk 39 → 40.
      // This block handles the round-to-round transitions:
      //   40 → 41 : regionals resolved → set up Longview championship
      //   41 → 42 : championship resolved → finalize
      if (nextWeek === 41 && prevWeek === 40) advanceInteractivePostseasonNWAC(state, 40)
      else if (nextWeek === 42 && prevWeek === 41) advanceInteractivePostseasonNWAC(state, 41)
    }
  }

  // Capture last-week AP spend BEFORE the refresh resets it — used by the
  // weekly team-GPA dynamic (lower utilization GPA drifts down).
  state._lastWeekApSpent = state.ap?.spentThisWeek ?? 0

  // Refresh AP and tick boosts. AP is LOCKED (= 0) during weeks 1-3 per the
  // new tutorial flow; refreshWeeklyAP enforces that.
  refreshWeeklyAP(state)
  tickWeeklyBookkeeping(state)
  tickTeamGPAWeekly(state)

  // Energy recovery — every player who accrued fatigue bounces back each
  // week. Covers the user's roster PLUS any opponent players who got
  // charged energy facing the user (symmetric-fatigue change in simWeek).
  //
  // IN-SEASON FULL RESET (May 2026 — per Nate): during the spring season
  // we FULLY reset every player's energy to 100 between weeks. The intent:
  // Tue midweek + Fri/Sat/Sun weekend should not compound fatigue across
  // weeks — each weekly cycle starts fresh so the auto-manager can ride
  // the same Fri/Sat/Sun rotation + same midweek bullpen pool. Combined
  // with the "midweek excludes top-4 SPs" rule (in simWeek), this means
  // weekend SPs are NEVER asked to throw Tuesday and the deep bullpen has
  // 3 days to recover before Friday.
  const isSpringSeason = state.calendar?.mode === 'SEASON'
  const energyIds = Object.keys(state.playerEnergy || {})
  if (isSpringSeason) {
    // Full reset to 100 — wipe the whole energy map so any straggler is
    // implicitly at the DEFAULT_ENERGY when read.
    state.playerEnergy = {}
  } else if (energyIds.length > 0) {
    tickWeeklyRecovery(state, energyIds)
  } else {
    const userTeamForRecovery = state.teams?.[state.userSchoolId]
    if (userTeamForRecovery) tickWeeklyRecovery(state, userTeamForRecovery.rosterPlayerIds || [])
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
  // (Fall scrimmages removed May 2026 — no offseason game sim hook needed.)

  // Month-collapse (May 2026): November + December are each a SINGLE turn.
  // November is anchored at wk 13 (prospect camp + a month of AP), December
  // at wk 18. The in-between weeks (14-17, 19-22) are "fold" weeks: if a
  // single advance lands on one, immediately advance again so the user only
  // ever stops on the anchor. Each folded week still runs full bookkeeping
  // above (dev, recruiting decisions, events) — they just don't get a turn.
  if (isFoldWeek(state.calendar.weekOfYear)) {
    advanceOneWeek(state)
  }
}

/**
 * Weeks that fold into the month-anchor turns:
 *   October  anchor = 9  (folds 10-12)
 *   November anchor = 13 (folds 14-17)
 *   December anchor = 18 (folds 19-22)
 */
function isFoldWeek(week) {
  return (week >= 10 && week <= 12)
    || (week >= 14 && week <= 17)
    || (week >= 19 && week <= 22)
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
  // SUMMER PORTAL (weeks 43+): the post-season recruiting window is short, the
  // user has just lost players to outbound transfers, and replacements must be
  // signed in only ~9 turns. Make commits noticeably easier + faster — lower
  // the interest gate and boost sign probability so the user can actually
  // backfill the roster (per Nate: "make committing players in the summer
  // easier, players decide quicker after week 43").
  // BUFFED May 2026 round 2 — user reported roster stuck at 28 in year-2
  // because summer commit speed wasn't keeping up with portal-out + draft.
  // Lowered the gate further (24 → 18) and bumped signMultiplier (2.3 → 3.5)
  // so the same recruiting AP spend converts to more commits before wk52
  // class-finalize.
  const isSummer = (state.calendar?.weekOfYear ?? 0) >= 43
  const advanceOpts = isSummer ? { gateOverride: 18, signMultiplier: 3.5 } : {}
  const committedThisTick = []   // recruit ids that committed — for the popup
  for (const r of Object.values(state.recruits)) {
    // 1. Tick weeksOutstanding on user's live offers
    if (r.liveOffer?.schoolId === userId) {
      r.liveOffer.weeksOutstanding = (r.liveOffer.weeksOutstanding || 0) + 1
    }
    // 2. Sign roll on open recruits with a user offer
    if (r.status === 'open' && r.liveOffer?.schoolId === userId) {
      const signed = tryAdvanceRecruit(r, userId, userSchool, rng, state, advanceOpts)
      if (signed) {
        newSigns++
        committedThisTick.push(r.id)
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
  // Accumulate committed recruit ids across the whole advance (a single advance
  // can fold several weeks). The Dashboard reads + clears this to pop a full
  // signing-profile modal for each new commit.
  if (committedThisTick.length > 0) {
    state._newCommitRecruits = [...(state._newCommitRecruits || []), ...committedThisTick]
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
  // calendar.year is the AUGUST start year; the SPRING season the schedule
  // covers is year+1. The dynasty-start build (newDynasty), the Schedule page,
  // and autoFulfillSchedule all use year+1 — this MUST match, or the year-2
  // conference schedule is built for the wrong year and the auto-filled
  // non-conference games (year+1) won't line up with it.
  const year = state.calendar.year + 1
  // D1/D2/D3 full-division dynasties rebuild with the same builder used at
  // creation (circle-method round-robin + front-week fillers) so year 2+ keeps
  // the whole league playing every week. NAIA + NWAC keep their builders.
  const level = state.level
  if (level && level !== 'NAIA' && level !== 'NWAC') {
    state.schedule = capRegularSeasonForLevel(
      buildFullDivisionSchedule(state.conferences, state.schools, level, year, state.rngSeed, state.userSchoolId),
      level,
    )
    return
  }
  const confSchedule = buildAllConferenceSchedules(state.conferences, state.schools, year, state.rngSeed)
  // Early-week non-conference fillers for non-user teams so the whole league
  // plays + accrues stats from week 1 (user self-schedules their non-conf).
  const fillers = buildNonConferenceFillers(confSchedule, state.conferences, state.schools, year, state.userSchoolId)
  state.schedule = capRegularSeasonForLevel([...confSchedule, ...fillers], state.level)
}

/**
 * 4-round leagues (D2) end the regular season a week early (wk38 = seasonWeek
 * 12) so wk39 is free for the conference tournament. Drop any regular-season
 * series in seasonWeek 13.
 */
export function capRegularSeasonForLevel(schedule, level) {
  const L = postseasonLayout(level)
  const lastSeasonWeek = L.seasonEnd - 26   // NAIA 13, D2 12
  if (lastSeasonWeek >= 13) return schedule
  return schedule.filter(g => !(typeof g.seasonWeek === 'number' && g.seasonWeek > lastSeasonWeek))
}

/**
 * Mid-season self-heal: when a non-user team's CURRENT-year schedule turned
 * out too thin (round-robin gap, save predating the buildFullDivisionSchedule
 * thin-pad, or any other root cause), pad the rest of the season with
 * non-conf series in their open future weeks so the standings don't show
 * 0-3 records all year while the user plays a full slate.
 *
 * Only operates on D1/D2/D3 (NAIA + NWAC have their own builders). Safe to
 * run every session; idempotent (won't pad teams that are already at quota,
 * won't touch played games).
 */
export function repairLeagueSchedule(state) {
  if (!state?.schedule) return { padded: 0 }
  const level = state.level
  if (!level || level === 'NAIA' || level === 'NWAC' || level === 'INDEPENDENT_D1') return { padded: 0 }
  const userSchoolId = state.userSchoolId
  const layout = postseasonLayout(level)
  const maxWeeks = Math.max(1, (layout.seasonEnd ?? 39) - 26)
  const MIN_SERIES = Math.max(6, maxWeeks - 2)
  const seasonStartWeek = 27
  // Derive the target year from existing in-season games. Fall back to
  // calendar.year + 1 (the spring year for an Aug-start calendar.year).
  let year = null
  for (const g of state.schedule) {
    if (typeof g.year === 'number' && (g.type === 'CONFERENCE' || g.type === 'NON_CONFERENCE')) {
      year = g.year
      break
    }
  }
  if (year == null) year = (state.calendar?.year ?? 0) + 1
  // Build per-team series-week sets (one entry per series via _g0 marker).
  // We count both played and unplayed; the pad only ADDS new series, never
  // removes anything, and never touches played games.
  const allTeams = Object.keys(state.schools || {}).filter(id => id !== userSchoolId)
  const seriesByTeamWeek = {}
  for (const g of state.schedule) {
    if (g.type !== 'CONFERENCE' && g.type !== 'NON_CONFERENCE') continue
    if (g.homeId === userSchoolId || g.awayId === userSchoolId) continue
    if (g.year != null && g.year !== year) continue
    if (!String(g.id || '').endsWith('_g0')) continue
    for (const tid of [g.homeId, g.awayId]) {
      if (!seriesByTeamWeek[tid]) seriesByTeamWeek[tid] = new Set()
      if (typeof g.seasonWeek === 'number') seriesByTeamWeek[tid].add(g.seasonWeek)
    }
  }
  const curSeasonWeek = state.calendar?.seasonWeek ?? 1
  // Open FUTURE weeks per team (skip weeks already past + weeks already used).
  const openByTeam = {}
  for (const id of allTeams) {
    const used = seriesByTeamWeek[id] || new Set()
    const open = new Set()
    for (let sw = Math.max(1, curSeasonWeek); sw <= maxWeeks; sw++) {
      if (!used.has(sw)) open.add(sw)
    }
    openByTeam[id] = open
  }
  const thin = allTeams.filter(id => (seriesByTeamWeek[id]?.size || 0) < MIN_SERIES)
  if (thin.length < 2) return { padded: 0 }
  let padded = 0
  let madeProgress = true
  let safety = 0
  while (madeProgress && safety++ < 200) {
    madeProgress = false
    const sortedThin = thin
      .filter(id => (seriesByTeamWeek[id]?.size || 0) < MIN_SERIES)
      .sort((a, b) => (seriesByTeamWeek[a]?.size || 0) - (seriesByTeamWeek[b]?.size || 0))
    for (const id of sortedThin) {
      if ((seriesByTeamWeek[id]?.size || 0) >= MIN_SERIES) continue
      const myOpen = openByTeam[id]
      if (!myOpen || myOpen.size === 0) continue
      let partner = null, weekSw = null
      for (const other of sortedThin) {
        if (other === id) continue
        if ((seriesByTeamWeek[other]?.size || 0) >= MIN_SERIES) continue
        const theirOpen = openByTeam[other]
        if (!theirOpen) continue
        for (const sw of myOpen) {
          if (theirOpen.has(sw)) { partner = other; weekSw = sw; break }
        }
        if (partner) break
      }
      if (!partner) continue
      const wk = seasonStartWeek + (weekSw - 1)
      const homeId = id < partner ? id : partner
      const awayId = id < partner ? partner : id
      const seriesId = `selfheal_${year}_w${weekSw}_${homeId}`
      // Inline minimal series builder (3 weekend games). Mirrors mkSeriesGame.
      for (let g = 0; g < 3; g++) {
        const date = isoDateForWeek(year, wk, g + 4)
        state.schedule.push({
          id: `${seriesId}_g${g}`,
          year,
          seasonWeek: weekSw,
          weekOfYear: wk,
          date,
          homeId, awayId,
          type: 'NON_CONFERENCE',
          seriesId,
          countsTowardRecord: true,
          isDoubleheader: false,
          played: false,
          homeRuns: null, awayRuns: null,
        })
      }
      for (const tid of [id, partner]) {
        if (!seriesByTeamWeek[tid]) seriesByTeamWeek[tid] = new Set()
        seriesByTeamWeek[tid].add(weekSw)
        openByTeam[tid].delete(weekSw)
      }
      padded++
      madeProgress = true
    }
  }
  return { padded }
}

// Local helper for repairLeagueSchedule's date stamps. Mirrors dateForWeek
// used by mkSeriesGame so the series shows up on the correct Fri/Sat/Sun.
function isoDateForWeek(year, weekOfYear, dayOffset) {
  // weekOfYear 27 = first week of August school year (matches dateForWeek in
  // newDynastyMultiLevel). Spring weeks land Feb-May. Use the spring year
  // (= games' year field) for the Date constructor.
  const base = new Date(Date.UTC(year - 1, 7, 1))   // Aug 1 of the prior calendar year
  base.setUTCDate(base.getUTCDate() + (weekOfYear - 1) * 7 + dayOffset)
  return base.toISOString().slice(0, 10)
}
