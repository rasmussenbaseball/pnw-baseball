/**
 * Season loop — runs a single week (or all remaining weeks) of games,
 * updates standings, recomputes rankings, ticks pitcher rest.
 *
 * Two tiers of fidelity (see sim.md):
 *   - Full PA-level sim for games involving the user's team
 *   - Fast monte-carlo sim for all other games in the league
 */

import { simGame, fastSimGame, defaultLineup } from './sim'
import { computeFromSeason, seedFromPear } from './rankings'
import { applyScrimmageDev, endOfSeasonDevelopment } from './development'
import { simAllConferenceTournaments } from './tournament'
import { runNationalTournament } from './nationalTournament'
import { annualReview, budgetCategoryEffects } from './budget'
import { playerOverall } from './playerRating'
import { applyHsAttrition, generatePortalPool } from './recruits'
import { runOutboundTransfers } from './outboundTransfers'
import { runEndOfTermAcademics, teamAcademicSummary } from './academics'
import { tickHappiness } from './happiness'
import { simMlbDraft, summarizeDraft } from './draft'
import { OFFSEASON_WEEKS } from './calendar'
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
  const userSchoolId = state.userSchoolId
  const userResults = []
  let gamesPlayed = 0

  for (const g of schedule) {
    if (g.played) continue
    if (g.seasonWeek !== targetWeek) continue
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
      // Both sides are real NAIA teams — full sim
      const homeLineup = defaultLineup(homeTeam, state.players)
      const awayLineup = defaultLineup(awayTeam, state.players)
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

    // Accumulate per-player season stats from this game's boxscore
    if (result.boxscore?.batterStats) {
      if (!state.playerStats) state.playerStats = {}
      const accumulate = (statsObj, isPitcher) => {
        for (const [pid, s] of Object.entries(statsObj)) {
          const key = isPitcher ? `p_${pid}` : `b_${pid}`
          if (!state.playerStats[key]) state.playerStats[key] = { playerId: pid, isPitcher, ...zeroStats(isPitcher) }
          const target = state.playerStats[key]
          for (const k of Object.keys(s)) target[k] = (target[k] || 0) + s[k]
          // gamesPlayed: a single appearance in this game counts as 1, regardless
          // of how many PAs / outs they recorded. Drives the auto-redshirt rule.
          target.gamesPlayed = (target.gamesPlayed || 0) + 1
        }
      }
      accumulate(result.boxscore.batterStats, false)
      accumulate(result.boxscore.pitcherStats, true)
    }

    // Scrimmage dev bonus — players in the user's scrimmage get small bumps.
    // For v1.5 we apply to the default lineup (top-9 hitters + top-5 pitchers);
    // a future iteration lets the coach explicitly pick who plays.
    if (isUserGame && (g.type === 'FALL_SCRIMMAGE' || g.type === 'SPRING_SCRIMMAGE')) {
      const userTeam = state.teams[userSchoolId]
      if (userTeam) {
        const lineup = defaultLineup(userTeam, state.players)
        const playersIn = [...lineup.batters, ...lineup.pitcherRotation]
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
 * Run the end-of-year wrap: development pass on all players, annual budget
 * review, AP reset, calendar advance to next offseason.
 *
 * @param {SaveState} state
 */
export function runEndOfYear(state) {
  // 1. Player development for user's team (other teams handled implicitly)
  const userTeam = state.teams[state.userSchoolId]
  const hc = state.coaches[userTeam.headCoachId]
  const coachDeveloper = hc?.developer ?? 55
  const budgetEffects = budgetCategoryEffects(state.budget)

  // Compute playing time per player (rough — based on if they're top-9 hitter / top-5 pitcher)
  const playerIds = userTeam.rosterPlayerIds
  const players = playerIds.map(id => state.players[id]).filter(Boolean)
  const hitters = players.filter(p => p.isHitter).sort((a, b) => (b.hitter.contact_r || 0) - (a.hitter.contact_r || 0))
  const pitchers = players.filter(p => p.isPitcher).sort((a, b) => (b.pitcher.stuff || 0) - (a.pitcher.stuff || 0))
  const top9 = new Set(hitters.slice(0, 9).map(p => p.id))
  const top5p = new Set(pitchers.slice(0, 5).map(p => p.id))

  // Top dev performers we'll surface in the news
  const devReport = []

  for (const id of playerIds) {
    const p = state.players[id]
    if (!p) continue
    const paShare = top9.has(id) ? 0.8 : 0.2
    const ipShare = top5p.has(id) ? 0.8 : 0.2
    const statsKey = p.isPitcher ? `p_${id}` : `b_${id}`
    const seasonStats = state.playerStats?.[statsKey]
    const updated = endOfSeasonDevelopment(p, {
      coachDeveloper, paShare, ipShare, budgetEffects, seasonStats,
    }, state.rngSeed + state.calendar.year)
    const gain = updated._devGain || 0
    if (gain >= 1.5) devReport.push({ player: updated, gain })
    delete updated._devGain
    // Auto-redshirt rule (NAIA / NCAA standard): ≤ 11 games played → free
    // year of eligibility preserved, athletic class year does NOT advance.
    // One redshirt per career, and only available while they still have
    // headroom in the 5-years-for-4-seasons window (so seasonsUsed < 3).
    const REDSHIRT_GAME_LIMIT = 11
    const gp = state.playerStats?.[statsKey]?.gamesPlayed || 0
    const eligibleToRedshirt = !updated.redshirtUsed && (updated.seasonsUsed || 0) < 3
    const shouldRedshirt = eligibleToRedshirt && gp <= REDSHIRT_GAME_LIMIT
    const nextClass = { FR: 'SO', SO: 'JR', JR: 'SR', SR: 'GRAD' }[updated.classYear]

    if (nextClass === 'GRAD') {
      state.players[id] = { ...updated, eligibilityStatus: 'graduated' }
    } else if (shouldRedshirt) {
      // Classyear + seasonsUsed stay put; semestersUsed still ticks (academic
      // clock keeps moving). Player returns as a "RS-XX" next year.
      state.players[id] = {
        ...updated,
        redshirtUsed: true,
        semestersUsed: (updated.semestersUsed || 0) + 2,
      }
      state.newsfeed.unshift({
        id: `rs_${state.calendar.year}_${id}`,
        year: state.calendar.year + 1,
        week: 17,
        type: 'AWARD',
        headline: `🎓 ${updated.firstName} ${updated.lastName} (${updated.classYear} ${updated.primaryPosition}) auto-redshirted — only ${gp} games played. Year of eligibility preserved.`,
        payload: { playerId: id, games: gp },
      })
    } else {
      state.players[id] = { ...updated, classYear: nextClass, seasonsUsed: updated.seasonsUsed + 1, semestersUsed: updated.semestersUsed + 2 }
    }
  }

  // Surface the biggest developments in the news
  devReport.sort((a, b) => b.gain - a.gain)
  for (const r of devReport.slice(0, 3)) {
    state.newsfeed.unshift({
      id: `dev_${state.calendar.year}_${r.player.id}`,
      year: state.calendar.year + 1,
      week: 18,
      type: 'AWARD',
      headline: `${r.player.firstName} ${r.player.lastName} (${r.player.classYear}, ${r.player.primaryPosition}) developed +${r.gain.toFixed(1)} OVR over the season.`,
      payload: { playerId: r.player.id, gain: r.gain },
    })
  }

  // Remove graduated players from active roster (but keep their record in players for history)
  const grads = playerIds.filter(id => state.players[id]?.eligibilityStatus === 'graduated')
  if (grads.length > 0) {
    state.teams[state.userSchoolId].rosterPlayerIds = userTeam.rosterPlayerIds.filter(id => !grads.includes(id))
    state.newsfeed.unshift({
      id: `grad_${state.calendar.year}`,
      year: state.calendar.year + 1,
      week: 18,
      type: 'AWARD',
      headline: `${grads.length} senior${grads.length === 1 ? '' : 's'} graduated. Roster down to ${state.teams[state.userSchoolId].rosterPlayerIds.length}.`,
      payload: {},
    })
  }

  // MLB Draft — runs in July (week ~17 of the prior season's calendar).
  // 5–12 NAIA players picked, ~85% pitchers. User picks (if any) get a
  // jobSecurity / program-prestige bump.
  const draftPicks = simMlbDraft(state, state.calendar.year)
  if (!state.draftResults) state.draftResults = {}
  state.draftResults[state.calendar.year] = draftPicks
  const userConfId = state.schools[state.userSchoolId]?.conferenceId
  state.newsfeed.unshift({
    id: `draft_${state.calendar.year}`,
    year: state.calendar.year + 1,
    week: 17,
    type: 'AWARD',
    headline: `⚾ ${summarizeDraft(draftPicks, userConfId)}`,
    payload: { year: state.calendar.year, picks: draftPicks },
  })
  // Individual headlines for user players who got picked — these are big.
  const userPicks = draftPicks.filter(p => p.teamId === state.userSchoolId)
  for (const pk of userPicks) {
    state.newsfeed.unshift({
      id: `draft_user_${state.calendar.year}_${pk.playerId}`,
      year: state.calendar.year + 1,
      week: 17,
      type: 'AWARD',
      headline: `🌟 ${pk.name} (${pk.pos}) drafted by MLB in Round ${pk.round}! Big win for the program.`,
      payload: { playerId: pk.playerId, round: pk.round },
      big: true,
    })
  }
  if (userPicks.length > 0 && state.budget) {
    state.budget.jobSecurity = Math.min(100, (state.budget.jobSecurity || 50) + userPicks.length * 3)
  }

  // Outbound transfers — MID_OFFSEASON (dramatic: stars + disgruntled bench)
  runOutboundTransfers(state, 'MID_OFFSEASON')
  // Outbound transfers — LATE_OFFSEASON (cleanup: broader churn)
  runOutboundTransfers(state, 'LATE_OFFSEASON')

  // Academics — end of spring term GPA update + eligibility/dismissal
  const academicResult = runEndOfTermAcademics(state)
  // Low team GPA hurts coach job security
  if (academicResult.summary && academicResult.summary.teamGpa < 2.5 && state.budget) {
    const penalty = Math.round((2.5 - academicResult.summary.teamGpa) * 12)
    state.budget.jobSecurity = Math.max(0, (state.budget.jobSecurity || 50) - penalty)
    state.newsfeed.unshift({
      id: `acad_pen_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 0,
      type: 'AWARD',
      headline: `⚠️ Team GPA of ${academicResult.summary.teamGpa.toFixed(2)} is below 2.5 — AD docked your job security ${penalty} pts. Mandate study hall to recover.`,
      payload: {},
    })
  }

  // 2. Annual budget review
  const seasonResult = {
    wins: userTeam.wins,
    losses: userTeam.losses,
    confChampion: state.postseason?.userChamp || false,
    postseasonAppearance: state.postseason?.userQualified || false,
  }
  const reviewResult = annualReview(state.budget, seasonResult)
  state.budget = reviewResult.newBudget
  for (const msg of reviewResult.news) {
    state.newsfeed.unshift({
      id: `review_${state.calendar.year}_${Math.random().toString(36).slice(2, 6)}`,
      year: state.calendar.year + 1,
      week: 17,
      type: 'AWARD',
      headline: msg,
      payload: {},
    })
  }

  // 3. Reset for next year
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
  // Clear schedule + per-player stats
  state.schedule = []
  state.playerStats = {}

  // Open the portal — HS attrition + portal pool generation
  if (state.recruits) {
    applyHsAttrition(state.recruits, state.rngSeed + state.calendar.year)
    const userHC = state.coaches[state.teams[state.userSchoolId]?.headCoachId]
    const portalPool = generatePortalPool(state.calendar.year, state.rngSeed, userHC)
    Object.assign(state.recruits, portalPool)
    state.newsfeed.unshift({
      id: `portal_open_${state.calendar.year}`,
      year: state.calendar.year,
      week: 1,
      type: 'AWARD',
      headline: `NAIA Portal is now OPEN. ${Object.values(portalPool).length} new transfer prospects available on the recruiting board.`,
      payload: {},
    })
  }

  // Reset prospect camp flag for new year
  state.prospectCamp = null
}

export const ROSTER_CAP_MAX = 60

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
 * Advance one OFFSEASON week. Mutates state.
 *
 *   - Bumps offseasonWeek + week
 *   - Refreshes AP budget for the new week
 *   - Applies study-hall benefits accumulated this term
 *   - When we hit OFFSEASON_WEEKS+1 → flip into SEASON mode
 *
 * @param {SaveState} state
 */
export function advanceOffseasonWeek(state) {
  if (state.calendar.mode !== 'OFFSEASON') return
  state.calendar.offseasonWeek++
  state.calendar.week++

  // Refresh weekly AP and tick per-week bookkeeping
  refreshWeeklyAP(state)
  tickWeeklyBookkeeping(state)

  // Transition into season once offseason is over
  if (state.calendar.offseasonWeek > OFFSEASON_WEEKS) {
    state.calendar.mode = 'SEASON'
    state.calendar.offseasonWeek = null
    state.calendar.seasonWeek = 1
    state.newsfeed.unshift({
      id: `season_open_${state.calendar.year}`,
      year: state.calendar.year + 1,
      week: 1,
      type: 'AWARD',
      headline: `${state.calendar.year + 1} season is here. First pitch this week.`,
      payload: {},
    })
  }
}

/**
 * Advance the calendar to the next week. If we cross past week 16, trigger
 * the postseason + end-of-year flow automatically.
 *
 * @param {SaveState} state
 * @param {Game[]} schedule
 */
export function advanceWeek(state, schedule) {
  // Recompute ratings from accumulated game results
  const playedGames = schedule
    .filter(g => g.played)
    .map(g => ({
      homeId: g.homeId,
      awayId: g.awayId,
      homeRuns: g.homeRuns,
      awayRuns: g.awayRuns,
      homePA: 40,   // approximate; not used in current ratings calc
      awayPA: 40,
    }))
  // If we don't have ratings stored on state yet, this season is starting fresh
  // — we'll let the next-week tick recompute.
  // The actual rating store is held by the UI layer.

  state.calendar.week++
  if (state.calendar.mode === 'SEASON' && state.calendar.seasonWeek != null) {
    state.calendar.seasonWeek++
    refreshWeeklyAP(state)
    tickWeeklyBookkeeping(state)
    if (state.calendar.seasonWeek > 13) {
      // 13 weeks of regular season; postseason begins Week 14 (conference
      // tournament), Week 15 = Opening Round, Week 16 = NAIA World Series.
      state.calendar.mode = 'POSTSEASON'
      state.calendar.seasonWeek = null
      runPostseason(state)
      runEndOfYear(state)
    }
  }
}
