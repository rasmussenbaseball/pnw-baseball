/**
 * Interactive NAIA postseason (May 2026, v2 — proper single-game brackets).
 *
 *   Week 40 — Conference Tournament   (double-elimination, single games)
 *   Week 41 — NAIA Opening Round      (4-team regional double-elim, single games)
 *   Week 42 — NAIA World Series        (single-elim among site winners)
 *
 * Each bracket is SINGLE GAMES (you face a team once per bracket node) — NOT a
 * best-of-3 series. The user plays through their bracket one game at a time:
 * the resumable bracket runner sims non-user games deterministically and PAUSES
 * whenever the user is due to play, generating that single game into the live
 * schedule (so the normal game-week/Play/sim flow handles it). After each user
 * game is played, `tickInteractivePostseason` re-runs the bracket, advancing the
 * user (winners bracket) or dropping them (losers bracket) until they win the
 * bracket or take their 2nd loss.
 *
 * state.postseason (interactive) shape:
 *   {
 *     year, level:'NAIA', interactive:true,
 *     stage:'CONF'|'REGIONAL'|'WS'|'DONE',
 *     userQualified, userAlive, userEliminatedAt,
 *     userChamp, userNatChamp, nationalChampion,
 *     rounds: { CONF:{...}, REGIONAL:{...}, WS:{...} },
 *   }
 *   round: { format, seeds:[], seedKey, label, resolved, userWon,
 *            pendingGameId, oppName, gameIds:[] }
 */

import { seedFromPear } from './rankings'
import { fastSimGame } from './sim'
import { makeRng } from './rng'
import { qualifierCountForConf } from './pnwPlayoffs'

const STAGE_WEEK = { CONF: 40, REGIONAL: 41, WS: 42 }
const STAGE_SEASONWEEK = { CONF: 14, REGIONAL: 15, WS: 16 }

function ratingOf(ratings, id) {
  return ratings[id] || { overall_rating: 0, offense_rating: 0, pitching_rating: 0 }
}

/** A deterministic non-user single game → winner id. */
function makeNonUserSim(ratings) {
  return (homeId, awayId, key) => {
    const r = fastSimGame(ratingOf(ratings, homeId), ratingOf(ratings, awayId), `psnu_${key}`)
    return r.homeRuns >= r.awayRuns ? homeId : awayId
  }
}

/**
 * Resumable single-game DOUBLE-ELIM. Returns either { champion } when the whole
 * bracket is decided, or { pending: { homeId, awayId, gameKey } } when it's the
 * user's turn to play a game that hasn't been played yet.
 *
 * @param {string[]} teams        seeded team ids (index 0 = top seed)
 * @param {string} userId
 * @param {(key:string)=>{homeRuns:number,awayRuns:number}|null} getUserResult
 * @param {(h:string,a:string,key:string)=>string} simNonUser  returns winner id
 */
function runResumableDoubleElim(teams, userId, getUserResult, simNonUser, seedKey) {
  let winners = [...teams]
  let losers = []
  let round = 0
  const play = (h, a, key) => {
    if (h === userId || a === userId) {
      const res = getUserResult(key)
      if (!res) return { pending: { homeId: h, awayId: a, gameKey: key } }
      return { winner: res.homeRuns > res.awayRuns ? h : a }
    }
    return { winner: simNonUser(h, a, key) }
  }
  while (winners.length + losers.length > 1) {
    round++
    if (round > 30) break
    const nextW = [], newL = []
    for (let i = 0; i < winners.length; i += 2) {
      const h = winners[i], a = winners[i + 1]
      if (a == null) { nextW.push(h); continue }
      const g = play(h, a, `${seedKey}_wbr${round}_${i}`)
      if (g.pending) return g
      nextW.push(g.winner); newL.push(g.winner === h ? a : h)
    }
    const lbAlive = [...losers]; const nextL = []
    for (let i = 0; i < lbAlive.length; i += 2) {
      const h = lbAlive[i], a = lbAlive[i + 1]
      if (a == null) { nextL.push(h); continue }
      const g = play(h, a, `${seedKey}_lbr${round}_${i}`)
      if (g.pending) return g
      nextL.push(g.winner)
    }
    winners = nextW
    losers = [...nextL, ...newL]
  }
  if (winners.length === 1 && losers.length === 1) {
    const w = winners[0], l = losers[0]
    const g1 = play(w, l, `${seedKey}_final1`)
    if (g1.pending) return g1
    if (g1.winner === w) return { champion: w }
    const g2 = play(w, l, `${seedKey}_final2`)
    if (g2.pending) return g2
    return { champion: g2.winner }
  }
  return { champion: winners[0] || losers[0] || null }
}

/** Resumable single-game SINGLE-ELIM (used for the World Series field). */
function runResumableSingleElim(teams, userId, getUserResult, simNonUser, seedKey) {
  let alive = [...teams]
  let round = 0
  const play = (h, a, key) => {
    if (h === userId || a === userId) {
      const res = getUserResult(key)
      if (!res) return { pending: { homeId: h, awayId: a, gameKey: key } }
      return { winner: res.homeRuns > res.awayRuns ? h : a }
    }
    return { winner: simNonUser(h, a, key) }
  }
  while (alive.length > 1) {
    round++
    if (round > 12) break
    const next = []
    for (let i = 0; i < alive.length; i += 2) {
      const h = alive[i], a = alive[i + 1]
      if (a == null) { next.push(h); continue }
      const g = play(h, a, `${seedKey}_r${round}_${i}`)
      if (g.pending) return g
      next.push(g.winner)
    }
    alive = next
  }
  return { champion: alive[0] || null }
}

// ── schedule game generation ────────────────────────────────────────────────

function userGameId(year, stage, gameKey) {
  return `ps_${year}_${stage}_${gameKey}`
}

function getUserResultFromSchedule(state, year, stage) {
  return (gameKey) => {
    const id = userGameId(year, stage, gameKey)
    const g = (state.schedule || []).find(x => x.id === id)
    if (!g || !g.played || g.homeRuns == null) return null
    return { homeRuns: g.homeRuns, awayRuns: g.awayRuns }
  }
}

/** Generate ONE user game into the schedule for the pending bracket matchup. */
function generatePendingGame(state, stage, pending) {
  const year = state.calendar.year
  const id = userGameId(year, stage, pending.gameKey)
  if ((state.schedule || []).some(g => g.id === id)) return id
  if (!state.schedule) state.schedule = []
  const seasonWeek = STAGE_SEASONWEEK[stage]
  state.schedule.push({
    id,
    year,
    seasonWeek,
    weekOfYear: STAGE_WEEK[stage],
    date: `${year}-05-${String(STAGE_WEEK[stage] === 40 ? 12 : STAGE_WEEK[stage] === 41 ? 19 : 26).padStart(2, '0')}`,
    homeId: pending.homeId,
    awayId: pending.awayId,
    type: 'POSTSEASON',
    postseasonStage: stage,
    countsTowardRecord: false,
    isDoubleheader: false,
    played: false,
    homeRuns: null,
    awayRuns: null,
  })
  return id
}

// ── seeding + fields ──────────────────────────────────────────────────────

function seedConference(state, confId) {
  const conf = state.conferences?.[confId]
  if (!conf) return []
  return (conf.schoolIds || [])
    .map(id => ({ id, team: state.teams[id] }))
    .filter(x => x.team)
    .sort((a, b) => (b.team.confWins - a.team.confWins) || (b.team.runDiff - a.team.runDiff))
    .map(x => x.id)
}

/** Seed an array of ids into standard 1-vs-N bracket order (1,N,...,mid). */
function bracketOrder(seeds) {
  // Simple standard ordering for 4: [1,4,2,3]; for others, snake it.
  const n = seeds.length
  if (n <= 2) return seeds
  const out = []
  let lo = 0, hi = n - 1
  while (lo <= hi) {
    out.push(seeds[lo]); if (lo !== hi) out.push(seeds[hi])
    lo++; hi--
  }
  return out
}

function confChampionsAll(state, ratings) {
  const champs = {}
  const sim = makeNonUserSim(ratings)
  for (const confId of Object.keys(state.conferences || {})) {
    const seeds = seedConference(state, confId)
    if (seeds.length === 0) continue
    if (seeds.length === 1) { champs[confId] = seeds[0]; continue }
    // Quick double-elim among the top few (all auto-simmed — no user here).
    const field = bracketOrder(seeds.slice(0, qualifierCountForConf(confId) || 4))
    const res = runResumableDoubleElim(field, '__none__', () => null, sim, `cc_${state.calendar.year}_${confId}`)
    champs[confId] = res.champion || seeds[0]
  }
  return champs
}

// ── public API ──────────────────────────────────────────────────────────────

export function setupInteractivePostseasonNAIA(state) {
  const userId = state.userSchoolId
  const year = state.calendar.year
  const ratings = seedFromPear(state.schools, state.conferences)
  const userConfId = state.schools?.[userId]?.conferenceId

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
    userConfId,
    confChampions: {},
    rounds: { CONF: null, REGIONAL: null, WS: null },
  }
  state.postseason = ps

  if (userQualified) {
    const field = bracketOrder(userSeeds.slice(0, fieldSize))
    ps.rounds.CONF = {
      format: 'DOUBLE_ELIM',
      seeds: field,
      seedKey: `conf_${year}_${userConfId}`,
      label: `${state.conferences[userConfId]?.abbreviation || 'Conf'} Tournament`,
      resolved: false, userWon: false, pendingGameId: null, oppName: '', gameIds: [],
    }
    tickInteractivePostseason(state)   // generate the user's first game
  } else {
    // Didn't qualify — crown the conf champ in the background for display.
    ps.confChampions = confChampionsAll(state, ratings)
  }
  return ps
}

/**
 * Generate the next user game for the CURRENT round, or resolve the round if the
 * user's bracket is complete. Called after EVERY user postseason game is played
 * (from simWeek + Play) so the bracket advances one game at a time.
 */
export function tickInteractivePostseason(state) {
  const ps = state.postseason
  if (!ps || !ps.interactive || ps.stage === 'DONE') return
  const stage = ps.stage
  const round = ps.rounds[stage]
  if (!round || round.resolved) return
  const userId = state.userSchoolId
  const year = state.calendar.year
  const ratings = seedFromPear(state.schools, state.conferences)
  const sim = makeNonUserSim(ratings)
  const getUserResult = getUserResultFromSchedule(state, year, stage)

  const runner = round.format === 'SINGLE_ELIM' ? runResumableSingleElim : runResumableDoubleElim
  const res = runner(round.seeds, userId, getUserResult, sim, round.seedKey)

  if (res.pending) {
    const id = generatePendingGame(state, stage, res.pending)
    round.pendingGameId = id
    if (!round.gameIds.includes(id)) round.gameIds.push(id)
    const oppId = res.pending.homeId === userId ? res.pending.awayId : res.pending.homeId
    round.oppName = state.schools[oppId]?.name || 'Opponent'
  } else {
    // Bracket complete for this round.
    round.resolved = true
    round.pendingGameId = null
    round.champion = res.champion
    round.userWon = res.champion === userId
    if (stage === 'CONF') {
      ps.userChamp = round.userWon
      ps.confChampions[ps.userConfId] = res.champion
    }
    if (!round.userWon) {
      ps.userAlive = false
      ps.userEliminatedAt = stage
    }
  }
}

/**
 * Week transition (40→41, 41→42, 42→43). Sets up the NEXT round if the user
 * advanced, or finalizes the postseason after the World Series week.
 */
export function advanceInteractivePostseasonNAIA(state, leavingWeek) {
  const ps = state.postseason
  if (!ps || !ps.interactive) return
  const userId = state.userSchoolId
  const year = state.calendar.year
  const ratings = seedFromPear(state.schools, state.conferences)

  if (leavingWeek === 40) {
    if (ps.userAlive && ps.rounds.CONF?.userWon) setupRound(state, ratings, 'REGIONAL')
    ps.stage = 'REGIONAL'
  } else if (leavingWeek === 41) {
    if (ps.userAlive && ps.rounds.REGIONAL?.userWon) setupRound(state, ratings, 'WS')
    ps.stage = 'WS'
  } else if (leavingWeek === 42) {
    finalize(state, ratings)
  }
}

function nationalField(state, ratings) {
  const ps = state.postseason
  // Ensure conf champions exist (the user's conf champ is set when CONF resolves).
  if (!ps.confChampions || Object.keys(ps.confChampions).length === 0) {
    ps.confChampions = confChampionsAll(state, ratings)
  }
  const hasTeam = (id) => !!state.teams?.[id]
  const set = new Set(Object.values(ps.confChampions).filter(id => id && hasTeam(id)))
  const all = Object.keys(state.schools || {})
    .filter(id => !set.has(id) && hasTeam(id))
    .sort((a, b) => (ratings[b]?.overall_rating ?? 0) - (ratings[a]?.overall_rating ?? 0))
  for (const id of all.slice(0, 24)) set.add(id)
  return [...set]
}

function setupRound(state, ratings, stage) {
  const ps = state.postseason
  const userId = state.userSchoolId
  const year = state.calendar.year
  const field = nationalField(state, ratings)
    .sort((a, b) => (ratings[b]?.overall_rating ?? 0) - (ratings[a]?.overall_rating ?? 0))

  // Pick a small bracket the user is part of.
  const others = field.filter(id => id !== userId)
  if (stage === 'REGIONAL') {
    // 4-team regional double-elim: user + 3 nearby-strength teams.
    const mid = Math.floor(others.length / 2)
    const picks = [others[mid], others[mid + 1], others[mid + 2]].filter(Boolean)
    const seeds = bracketOrder([userId, ...picks])
    ps.rounds.REGIONAL = {
      format: 'DOUBLE_ELIM', seeds, seedKey: `reg_${year}_${userId}`,
      label: 'NAIA Opening Round', resolved: false, userWon: false,
      pendingGameId: null, oppName: '', gameIds: [],
    }
  } else if (stage === 'WS') {
    // World Series: single-elim among the user + the strongest remaining teams.
    const picks = others.slice(0, 3)
    const seeds = bracketOrder([userId, ...picks])
    ps.rounds.WS = {
      format: 'SINGLE_ELIM', seeds, seedKey: `ws_${year}_${userId}`,
      label: 'NAIA World Series', resolved: false, userWon: false,
      pendingGameId: null, oppName: '', gameIds: [],
    }
  }
  tickInteractivePostseason(state)
}

function finalize(state, ratings) {
  const ps = state.postseason
  const userId = state.userSchoolId
  const year = state.calendar.year
  if (ps.userAlive && ps.rounds.WS?.userWon) {
    ps.userNatChamp = true
    ps.nationalChampion = userId
  }
  if (!ps.nationalChampion) {
    // Crown a plausible champion among the strongest field teams (background).
    const field = nationalField(state, ratings).filter(id => id !== userId)
      .sort((a, b) => (ratings[b]?.overall_rating ?? 0) - (ratings[a]?.overall_rating ?? 0))
    const sim = makeNonUserSim(ratings)
    const top = bracketOrder(field.slice(0, 4))
    if (top.length >= 2) {
      const res = runResumableSingleElim(top, '__none__', () => null, sim, `wsfinal_${year}`)
      ps.nationalChampion = res.champion || top[0]
    } else {
      ps.nationalChampion = top[0] || null
    }
  }
  ps.stage = 'DONE'
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
