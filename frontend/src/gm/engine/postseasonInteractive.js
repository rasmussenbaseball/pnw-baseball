/**
 * Interactive NAIA postseason (May 2026).
 *
 * Replaces the old "sim the entire bracket at the 39→40 boundary" model with a
 * round-by-round flow the user actually plays:
 *
 *   Week 40 — Conference Tournament   (best-of-3 vs the conf's top other seed)
 *   Week 41 — NAIA Opening Round      (best-of-3 vs a seeded national opponent)
 *   Week 42 — NAIA World Series       (best-of-3 vs the other finalist)
 *
 * The user's series for each round is written into `state.schedule` with the
 * matching seasonWeek (14/15/16), so the EXISTING, battle-tested game-week +
 * Play + simWeek flow handles play/sim/box-scores — no parallel game engine.
 * Win the series to advance; lose and your season ends. Non-user results are
 * simmed in the background (rating-based) so a national champion is crowned for
 * display when the user doesn't go all the way.
 *
 * State shape (state.postseason when interactive):
 *   {
 *     year, level:'NAIA', interactive:true,
 *     stage: 'CONF'|'REGIONAL'|'WS'|'DONE',
 *     userQualified, userAlive,
 *     userEliminatedAt: null|'REG_SEASON'|'CONF'|'REGIONAL'|'WS',
 *     userChamp,        // won conf tournament
 *     userNatChamp,     // won the World Series
 *     nationalChampion, // schoolId (for display)
 *     rounds: { CONF:{...}, REGIONAL:{...}, WS:{...} },   // per-round series
 *   }
 *
 * Each round entry: { oppId, oppName, gameIds:[...], decided, won, wins, losses, host }
 */

import { seedFromPear } from './rankings'
import { fastSimGame } from './sim'
import { qualifierCountForConf } from './pnwPlayoffs'

const SERIES_LEN = 3        // best-of-3 every round
const NEEDED = 2            // 2 wins takes a best-of-3

function ratingOf(ratings, id) {
  return ratings[id] || { overall_rating: 0, offense_rating: 0, pitching_rating: 0 }
}

/** Background best-of-3 between two non-user teams. Returns the winner id. */
function simSeriesWinner(ratings, aId, bId, seedKey) {
  let aw = 0, bw = 0
  for (let i = 0; i < SERIES_LEN && aw < NEEDED && bw < NEEDED; i++) {
    const r = fastSimGame(ratingOf(ratings, aId), ratingOf(ratings, bId), `${seedKey}_g${i}`)
    if (r.homeRuns >= r.awayRuns) aw++; else bw++
  }
  return aw >= bw ? aId : bId
}

/** Date helper — postseason weeks land in mid/late May. Rough but ordered. */
function psDate(year, round) {
  const day = round === 'CONF' ? 12 : round === 'REGIONAL' ? 19 : 26
  return `${year}-05-${String(day).padStart(2, '0')}`
}

/**
 * Build the user's best-of-3 series for a round and push the games into the
 * schedule so the normal game-week/Play flow picks them up.
 *
 * @returns {string[]} the generated game ids
 */
function generateUserSeries(state, round, oppId, seasonWeek, userIsHome) {
  const userId = state.userSchoolId
  const year = state.calendar.year
  const ids = []
  if (!state.schedule) state.schedule = []
  const homeId = userIsHome ? userId : oppId
  const awayId = userIsHome ? oppId : userId
  const date = psDate(year, round)
  for (let i = 0; i < SERIES_LEN; i++) {
    const id = `ps_${year}_${round}_${userId}_g${i}`
    // Don't duplicate if regenerated.
    if (state.schedule.some(g => g.id === id)) { ids.push(id); continue }
    state.schedule.push({
      id,
      year,
      seasonWeek,
      weekOfYear: 39 + (seasonWeek - 13),   // 14→40, 15→41, 16→42
      date,
      homeId,
      awayId,
      type: 'POSTSEASON',
      postseasonRound: round,
      countsTowardRecord: false,   // tracked in state.postseason, not the regular W-L
      isDoubleheader: false,
      played: false,
      homeRuns: null,
      awayRuns: null,
    })
    ids.push(id)
  }
  return ids
}

/** Tally a finished user series from the played schedule games. */
function tallyUserSeries(state, gameIds) {
  const userId = state.userSchoolId
  let wins = 0, losses = 0, playedCount = 0
  for (const id of gameIds) {
    const g = state.schedule.find(x => x.id === id)
    if (!g || !g.played || g.homeRuns == null) continue
    playedCount++
    const userHome = g.homeId === userId
    const userRuns = userHome ? g.homeRuns : g.awayRuns
    const oppRuns = userHome ? g.awayRuns : g.homeRuns
    if (userRuns > oppRuns) wins++; else losses++
  }
  return { wins, losses, playedCount, won: wins > losses, complete: wins >= NEEDED || losses >= NEEDED || playedCount >= SERIES_LEN }
}

/** Conference standings (by conf record, then run diff) → seeded school ids. */
function seedConference(state, confId) {
  const conf = state.conferences?.[confId]
  if (!conf) return []
  return (conf.schoolIds || [])
    .map(id => ({ id, team: state.teams[id] }))
    .filter(x => x.team)
    .sort((a, b) => (b.team.confWins - a.team.confWins) || (b.team.runDiff - a.team.runDiff))
    .map(x => x.id)
}

/** Best non-user team in a conference by rating (the user's conf-final foe). */
function topOtherInConf(state, ratings, confId, excludeId) {
  const seeds = seedConference(state, confId).filter(id => id !== excludeId)
  if (seeds.length === 0) return null
  // Prefer the top SEED (record) but break near-ties by rating.
  return seeds[0]
}

/**
 * SET UP the postseason (fired once at the 39→40 transition). Determines
 * whether the user qualified for their conference tournament, generates their
 * conference-final series, and crowns every OTHER conference champion in the
 * background so the national field is known.
 */
export function setupInteractivePostseasonNAIA(state) {
  const userId = state.userSchoolId
  const year = state.calendar.year
  const ratings = seedFromPear(state.schools, state.conferences)
  const userConfId = state.schools?.[userId]?.conferenceId

  // Background: crown each conference champion (auto-bids). Top seed beats the
  // #2 in a quick series — coarse but fine for the national field display.
  const confChampions = {}
  for (const confId of Object.keys(state.conferences || {})) {
    const seeds = seedConference(state, confId)
    if (seeds.length === 0) continue
    if (seeds.length === 1) { confChampions[confId] = seeds[0]; continue }
    confChampions[confId] = simSeriesWinner(ratings, seeds[0], seeds[1], `cc_${year}_${confId}`)
  }

  // User qualification: did they finish in the top-N of their conference?
  const userSeeds = seedConference(state, userConfId)
  const fieldSize = qualifierCountForConf(userConfId) || 4
  const userSeedIdx = userSeeds.indexOf(userId)
  const userQualified = userSeedIdx >= 0 && userSeedIdx < fieldSize

  const ps = {
    year: year + 1,
    level: 'NAIA',
    interactive: true,
    stage: 'CONF',
    userQualified,
    userAlive: userQualified,
    userEliminatedAt: userQualified ? null : 'REG_SEASON',
    userChamp: false,
    userNatChamp: false,
    nationalChampion: null,
    confChampions,
    userConfId,
    rounds: { CONF: null, REGIONAL: null, WS: null },
  }

  if (userQualified) {
    const oppId = topOtherInConf(state, ratings, userConfId, userId)
    if (oppId) {
      // Higher seed hosts — user hosts if they're the top seed.
      const userIsHome = userSeedIdx === 0
      const gameIds = generateUserSeries(state, 'CONF', oppId, 14, userIsHome)
      ps.rounds.CONF = {
        oppId, oppName: state.schools[oppId]?.name || 'Opponent',
        gameIds, decided: false, won: false, wins: 0, losses: 0,
        label: `${state.conferences[userConfId]?.abbreviation || 'Conf'} Tournament Final`,
        host: userIsHome ? userId : oppId,
      }
    } else {
      // No opponent (tiny conf) — auto-champ.
      ps.userChamp = true
      confChampions[userConfId] = userId
    }
  }

  state.postseason = ps
  return ps
}

/**
 * ADVANCE the interactive postseason one round. Called at each 40→41, 41→42,
 * 42→43 transition (BEFORE the week number is used for anything else). Resolves
 * the round the user just played and sets up the next one (or finalizes).
 */
export function advanceInteractivePostseasonNAIA(state, leavingWeek) {
  const ps = state.postseason
  if (!ps || !ps.interactive) return
  const userId = state.userSchoolId
  const year = state.calendar.year
  const ratings = seedFromPear(state.schools, state.conferences)

  // leavingWeek = the postseason week we're advancing OUT of (40, 41, or 42).
  if (leavingWeek === 40) {
    resolveAndAdvance(state, ratings, 'CONF', 'REGIONAL', 15, year)
  } else if (leavingWeek === 41) {
    resolveAndAdvance(state, ratings, 'REGIONAL', 'WS', 16, year)
  } else if (leavingWeek === 42) {
    resolveFinal(state, ratings, year)
  }
}

function resolveAndAdvance(state, ratings, round, nextRound, nextSeasonWeek, year) {
  const ps = state.postseason
  const userId = state.userSchoolId
  const rd = ps.rounds[round]

  // Resolve the round the user just played (if they were alive in it).
  if (ps.userAlive && rd && rd.gameIds?.length) {
    const t = tallyUserSeries(state, rd.gameIds)
    rd.wins = t.wins; rd.losses = t.losses; rd.decided = true; rd.won = t.won
    if (round === 'CONF' && t.won) ps.userChamp = true
    if (!t.won) {
      ps.userAlive = false
      ps.userEliminatedAt = round
    } else {
      ps.confChampions[ps.userConfId] = userId   // user is their conf's auto-bid
    }
  } else if (ps.userAlive && !rd) {
    // user was alive but had no series (auto-advance / bye)
  }

  // Build the national field from conf champions (+ a few rating-based at-large
  // bids) so we can pick the user's next opponent + crown a champ if eliminated.
  const field = nationalField(state, ratings)

  if (ps.userAlive) {
    // Generate the user's next-round series vs the strongest available foe.
    const oppId = pickUserOpponent(state, ratings, field, userId, round)
    if (oppId) {
      const userIsHome = (ratings[userId]?.overall_rating ?? 0) >= (ratings[oppId]?.overall_rating ?? 0)
      const gameIds = generateUserSeries(state, nextRound, oppId, nextSeasonWeek, userIsHome)
      ps.rounds[nextRound] = {
        oppId, oppName: state.schools[oppId]?.name || 'Opponent',
        gameIds, decided: false, won: false, wins: 0, losses: 0,
        label: nextRound === 'REGIONAL' ? 'NAIA Opening Round' : 'NAIA World Series',
        host: userIsHome ? userId : oppId,
      }
      ps.userInField = true
    }
  }

  ps.stage = nextRound
}

function resolveFinal(state, ratings, year) {
  const ps = state.postseason
  const userId = state.userSchoolId
  const rd = ps.rounds.WS

  if (ps.userAlive && rd && rd.gameIds?.length) {
    const t = tallyUserSeries(state, rd.gameIds)
    rd.wins = t.wins; rd.losses = t.losses; rd.decided = true; rd.won = t.won
    if (t.won) {
      ps.userNatChamp = true
      ps.nationalChampion = userId
    } else {
      ps.userAlive = false
      ps.userEliminatedAt = 'WS'
    }
  }

  // Crown a national champion for display if the user didn't win it all.
  if (!ps.nationalChampion) {
    const field = nationalField(state, ratings)
    const others = field.filter(id => id !== userId)
    others.sort((a, b) => (ratings[b]?.overall_rating ?? 0) - (ratings[a]?.overall_rating ?? 0))
    // Sim a tiny bracket among the top 4 to crown someone plausible.
    const top = others.slice(0, 4)
    if (top.length >= 2) {
      const sf1 = simSeriesWinner(ratings, top[0], top[top.length - 1], `wsf1_${year}`)
      const sf2 = top.length >= 3 ? simSeriesWinner(ratings, top[1], top[2], `wsf2_${year}`) : top[0]
      ps.nationalChampion = simSeriesWinner(ratings, sf1, sf2, `wsfinal_${year}`)
    } else {
      ps.nationalChampion = top[0] || null
    }
  }

  ps.stage = 'DONE'
  // Newsfeed wrap-up.
  const champName = state.schools[ps.nationalChampion]?.name || 'Unknown'
  state.newsfeed = state.newsfeed || []
  state.newsfeed.unshift({
    id: `ps_done_${year}_${Math.random().toString(36).slice(2, 6)}`,
    year: year + 1, week: 16, type: 'POSTSEASON',
    headline: ps.userNatChamp
      ? `${state.schools[userId]?.name} WINS THE NAIA NATIONAL CHAMPIONSHIP!`
      : `${champName} are crowned NAIA national champions.`,
    big: ps.userNatChamp,
  })
}

/** Conference champions + a few at-large bids, by rating. */
function nationalField(state, ratings) {
  const ps = state.postseason
  // Only teams with a real roster row can be played/simmed as the user's
  // opponent, so restrict the field to those.
  const hasTeam = (id) => !!state.teams?.[id]
  const champs = Object.values(ps.confChampions || {}).filter(id => id && hasTeam(id))
  const set = new Set(champs)
  // At-large: top-rated teams not already in.
  const all = Object.keys(state.schools || {})
    .filter(id => !set.has(id) && hasTeam(id))
    .sort((a, b) => (ratings[b]?.overall_rating ?? 0) - (ratings[a]?.overall_rating ?? 0))
  for (const id of all.slice(0, 18)) set.add(id)
  return [...set]
}

/** Pick the user's next opponent — a strong field team they haven't faced. */
function pickUserOpponent(state, ratings, field, userId, justFinishedRound) {
  const faced = new Set()
  const ps = state.postseason
  for (const r of Object.values(ps.rounds || {})) {
    if (r?.oppId) faced.add(r.oppId)
  }
  const candidates = field
    .filter(id => id !== userId && !faced.has(id))
    .sort((a, b) => (ratings[b]?.overall_rating ?? 0) - (ratings[a]?.overall_rating ?? 0))
  if (candidates.length === 0) return null
  // Opening round = mid-strength foe; World Series = the strongest remaining.
  if (justFinishedRound === 'CONF') {
    // regional opponent: pick from the middle of the field for a fair draw
    const mid = Math.floor(candidates.length / 2)
    return candidates[Math.min(mid, candidates.length - 1)]
  }
  return candidates[0]   // WS: the best remaining team
}
