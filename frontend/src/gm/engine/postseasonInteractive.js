/**
 * Interactive NAIA postseason (May 2026, v3 — exact NAIA formats).
 *
 * Round 1 — CONFERENCE TOURNAMENT (wk40): standard 5-team double-elim.
 *   Winners bracket: 4v5 → winner vs 1; 2v3 → winner vs (winner of 4v5/1).
 *   Single games; you face a team once per bracket node; lose twice = out.
 *
 * Round 2 — NAIA OPENING ROUND / REGIONAL (wk41): your regional is a standard
 *   4- or 5-team double-elim (single games). Win the regional to reach the WS.
 *
 * Round 3 — NAIA WORLD SERIES (wk42): 10 teams, two pools of 5. Round-robin
 *   inside your pool (you play the other 4), top 2 from each pool advance to a
 *   4-team double-elim championship. Single games throughout.
 *
 * The user plays ONE game at a time. Their next game is generated into the live
 * schedule only after the previous one is played; they can't advance the week
 * until they're eliminated or every game in the round is done. Non-user games
 * are simmed deterministically so the bracket fills in around the user.
 */

import { seedFromPear } from './rankings'
import { fastSimGame } from './sim'

const STAGE_WEEK = { CONF: 40, REGIONAL: 41, WS: 42 }
const STAGE_SEASONWEEK = { CONF: 14, REGIONAL: 15, WS: 16 }

function ratingOf(ratings, id) {
  return ratings[id] || { overall_rating: 0, offense_rating: 0, pitching_rating: 0 }
}
function makeNonUserSim(ratings) {
  return (h, a, key) => {
    const r = fastSimGame(ratingOf(ratings, h), ratingOf(ratings, a), `psnu_${key}`)
    return r.homeRuns >= r.awayRuns ? h : a
  }
}

// ── double-elim match graphs (single games) ─────────────────────────────────
// Seeds are indices into the `seeds` array (0 = top seed). Refs: a number =
// seed index; { win:key } / { lose:key } = winner/loser of a prior match.

function deGraph(n) {
  if (n >= 5) {
    // 5-team: 4v5 → vs 1 ; 2v3 ; WB final
    return {
      graph: [
        { key: 'wb1', a: 3, b: 4 },                       // 4 vs 5
        { key: 'wb2', a: 0, b: { win: 'wb1' } },          // 1 vs W(4v5)
        { key: 'wb3', a: 1, b: 2 },                       // 2 vs 3
        { key: 'wbf', a: { win: 'wb2' }, b: { win: 'wb3' } },
        { key: 'lb1', a: { lose: 'wb1' }, b: { lose: 'wb3' } },
        { key: 'lb2', a: { win: 'lb1' }, b: { lose: 'wb2' } },
        { key: 'lbf', a: { win: 'lb2' }, b: { lose: 'wbf' } },
      ],
      wbChampKey: 'wbf', lbChampKey: 'lbf',
    }
  }
  // 4-team standard double-elim
  return {
    graph: [
      { key: 'wb1', a: 0, b: 3 },   // 1 vs 4
      { key: 'wb2', a: 1, b: 2 },   // 2 vs 3
      { key: 'wbf', a: { win: 'wb1' }, b: { win: 'wb2' } },
      { key: 'lb1', a: { lose: 'wb1' }, b: { lose: 'wb2' } },
      { key: 'lbf', a: { win: 'lb1' }, b: { lose: 'wbf' } },
    ],
    wbChampKey: 'wbf', lbChampKey: 'lbf',
  }
}

/**
 * Resumable double-elim over a match graph. Returns { champion } or
 * { pending:{ homeId, awayId, gameKey } }.
 */
function runMatchGraph(seeds, spec, userId, getUserResult, simNonUser, keyPrefix) {
  const results = {}
  const refTeam = (ref) => {
    if (typeof ref === 'number') return seeds[ref]
    if (ref && ref.win) return results[ref.win]?.winner
    if (ref && ref.lose) return results[ref.lose]?.loser
    return null
  }
  const play = (key, h, a) => {
    if (h === userId || a === userId) {
      const res = getUserResult(key)
      if (!res) return { pending: { homeId: h, awayId: a, gameKey: key } }
      const winner = res.homeRuns > res.awayRuns ? h : a
      results[key] = { winner, loser: winner === h ? a : h }
      return {}
    }
    const w = simNonUser(h, a, `${keyPrefix}_${key}`)
    results[key] = { winner: w, loser: w === h ? a : h }
    return {}
  }
  for (const m of spec.graph) {
    if (results[m.key]) continue
    const h = refTeam(m.a), a = refTeam(m.b)
    if (h == null || a == null) continue
    const r = play(m.key, h, a)
    if (r.pending) return r
  }
  const wb = results[spec.wbChampKey]?.winner
  const lb = results[spec.lbChampKey]?.winner
  if (!wb || !lb) return { champion: wb || lb || seeds[0] }
  if (!results.GF1) { const r = play('GF1', wb, lb); if (r.pending) return r }
  if (results.GF1.winner === wb) return { champion: wb }
  if (!results.GF2) { const r = play('GF2', wb, lb); if (r.pending) return r }
  return { champion: results.GF2.winner }
}

// ── round-robin pool (WS) ────────────────────────────────────────────────────

/**
 * Resumable round-robin within a pool. Returns { pending } (next user game) or
 * { standings:[{id,wins,losses},...] } sorted best-first.
 */
function runPool(pool, userId, getUserResult, simNonUser, keyPrefix) {
  const rec = {}
  for (const id of pool) rec[id] = { id, wins: 0, losses: 0, rd: 0 }
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const h = pool[i], a = pool[j]
      const key = `pool_${i}_${j}`
      if (h === userId || a === userId) {
        const res = getUserResult(key)
        if (!res) return { pending: { homeId: h, awayId: a, gameKey: key } }
        const hw = res.homeRuns > res.awayRuns
        rec[hw ? h : a].wins++; rec[hw ? a : h].losses++
        rec[h].rd += res.homeRuns - res.awayRuns; rec[a].rd += res.awayRuns - res.homeRuns
      } else {
        const w = simNonUser(h, a, `${keyPrefix}_${key}`)
        rec[w].wins++; rec[w === h ? a : h].losses++
      }
    }
  }
  const standings = Object.values(rec).sort((x, y) => (y.wins - x.wins) || (y.rd - x.rd))
  return { standings }
}

// ── schedule game generation ─────────────────────────────────────────────────

function userGameId(year, stage, gameKey) { return `ps_${year}_${stage}_${gameKey}` }

function getUserResultFromSchedule(state, year, stage) {
  return (gameKey) => {
    const g = (state.schedule || []).find(x => x.id === userGameId(year, stage, gameKey))
    if (!g || !g.played || g.homeRuns == null) return null
    return { homeRuns: g.homeRuns, awayRuns: g.awayRuns }
  }
}

function generatePendingGame(state, stage, pending) {
  const year = state.calendar.year
  const id = userGameId(year, stage, pending.gameKey)
  if ((state.schedule || []).some(g => g.id === id)) return id
  if (!state.schedule) state.schedule = []
  state.schedule.push({
    id, year,
    seasonWeek: STAGE_SEASONWEEK[stage],
    weekOfYear: STAGE_WEEK[stage],
    date: `${year}-05-${STAGE_WEEK[stage] === 40 ? 12 : STAGE_WEEK[stage] === 41 ? 19 : 26}`,
    homeId: pending.homeId, awayId: pending.awayId,
    type: 'POSTSEASON', postseasonStage: stage,
    countsTowardRecord: false, isDoubleheader: false,
    played: false, homeRuns: null, awayRuns: null,
  })
  return id
}

// ── seeding helpers ──────────────────────────────────────────────────────────

function seedConference(state, confId) {
  const conf = state.conferences?.[confId]
  if (!conf) return []
  return (conf.schoolIds || [])
    .map(id => ({ id, team: state.teams[id] }))
    .filter(x => x.team)
    .sort((a, b) => (b.team.confWins - a.team.confWins) || (b.team.runDiff - a.team.runDiff))
    .map(x => x.id)
}

/** Background conf champions for every conference (auto-bids / national field). */
function confChampionsAll(state, ratings) {
  const champs = {}
  const sim = makeNonUserSim(ratings)
  for (const confId of Object.keys(state.conferences || {})) {
    const seeds = seedConference(state, confId).slice(0, 5)
    if (seeds.length === 0) continue
    if (seeds.length < 4) { champs[confId] = seeds[0]; continue }
    const res = runMatchGraph(seeds, deGraph(seeds.length), '__none__', () => null, sim, `cc_${state.calendar.year}_${confId}`)
    champs[confId] = res.champion || seeds[0]
  }
  return champs
}

function nationalField(state, ratings) {
  const ps = state.postseason
  if (!ps.confChampions || Object.keys(ps.confChampions).length === 0) {
    ps.confChampions = confChampionsAll(state, ratings)
  }
  const hasTeam = (id) => !!state.teams?.[id]
  const set = new Set(Object.values(ps.confChampions).filter(id => id && hasTeam(id)))
  const all = Object.keys(state.schools || {})
    .filter(id => !set.has(id) && hasTeam(id))
    .sort((a, b) => (ratings[b]?.overall_rating ?? 0) - (ratings[a]?.overall_rating ?? 0))
  for (const id of all.slice(0, 36)) set.add(id)
  return [...set].sort((a, b) => (ratings[b]?.overall_rating ?? 0) - (ratings[a]?.overall_rating ?? 0))
}

// ── public API ──────────────────────────────────────────────────────────────

export function setupInteractivePostseasonNAIA(state) {
  const userId = state.userSchoolId
  const year = state.calendar.year
  const ratings = seedFromPear(state.schools, state.conferences)
  const userConfId = state.schools?.[userId]?.conferenceId

  const userSeeds = seedConference(state, userConfId)
  // Conference tournament field = top 5 (per NAIA / CCC). Needs >=4 for a real
  // double-elim; tiny conferences just hand the auto-bid to the top seed.
  const fieldSize = Math.min(5, userSeeds.length)
  const userSeedIdx = userSeeds.indexOf(userId)
  const userQualified = fieldSize >= 4 && userSeedIdx >= 0 && userSeedIdx < fieldSize

  const ps = {
    year: year + 1, level: 'NAIA', interactive: true, stage: 'CONF',
    userQualified, userAlive: userQualified,
    userEliminatedAt: userQualified ? null : 'REG_SEASON',
    userChamp: false, userNatChamp: false, nationalChampion: null,
    userConfId, confChampions: {}, rounds: { CONF: null, REGIONAL: null, WS: null },
  }
  state.postseason = ps

  if (userQualified) {
    const seeds = userSeeds.slice(0, fieldSize)
    ps.rounds.CONF = {
      format: 'DE', seeds, spec: deGraph(seeds.length),
      seedKey: `conf_${year}_${userConfId}`,
      label: `${state.conferences[userConfId]?.abbreviation || 'Conf'} Tournament (double-elim)`,
      resolved: false, userWon: false, pendingGameId: null, gameIds: [], champion: null,
    }
    tickInteractivePostseason(state)
  } else {
    ps.confChampions = confChampionsAll(state, ratings)
  }
  return ps
}

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

  if (round.format === 'DE') {
    const res = runMatchGraph(round.seeds, round.spec, userId, getUserResult, sim, round.seedKey)
    applyDeResult(state, ps, stage, round, res)
    return
  }
  if (round.format === 'WS') {
    tickWorldSeries(state, ps, round, userId, year, getUserResult, sim, ratings)
    return
  }
}

function applyDeResult(state, ps, stage, round, res) {
  const userId = state.userSchoolId
  if (res.pending) {
    const id = generatePendingGame(state, stage, res.pending)
    round.pendingGameId = id
    if (!round.gameIds.includes(id)) round.gameIds.push(id)
    const oppId = res.pending.homeId === userId ? res.pending.awayId : res.pending.homeId
    round.oppName = state.schools[oppId]?.name || 'Opponent'
  } else {
    round.resolved = true
    round.pendingGameId = null
    round.champion = res.champion
    round.userWon = res.champion === userId
    if (stage === 'CONF') {
      ps.userChamp = round.userWon
      ps.confChampions[ps.userConfId] = res.champion
    }
    if (stage === 'REGIONAL') {
      // Record the user's regional champion into the national bracket display.
      const ureg = (ps.national?.regionals || []).find(r => r.isUser)
      if (ureg) ureg.champion = res.champion
    }
    if (!round.userWon) { ps.userAlive = false; ps.userEliminatedAt = stage }
  }
}

function tickWorldSeries(state, ps, round, userId, year, getUserResult, sim, ratings) {
  if (round.phase === 'POOL') {
    const res = runPool(round.pool, userId, getUserResult, sim, round.seedKey + '_A')
    if (res.pending) {
      const id = generatePendingGame(state, 'WS', res.pending)
      round.pendingGameId = id
      if (!round.gameIds.includes(id)) round.gameIds.push(id)
      const oppId = res.pending.homeId === userId ? res.pending.awayId : res.pending.homeId
      round.oppName = state.schools[oppId]?.name || 'Opponent'
      return
    }
    // Pool complete. Determine the user's pool qualifiers + pool B qualifiers.
    const aTop = res.standings.slice(0, 2).map(s => s.id)
    // Pool B (the other 5 teams) — sim fully in the background.
    const poolBRes = runPool(round.poolB, '__none__', () => null, sim, round.seedKey + '_B')
    const bTop = poolBRes.standings.slice(0, 2).map(s => s.id)
    const userAdvanced = aTop.includes(userId)
    round.poolStandings = res.standings
    round.userInChamp = userAdvanced
    // Store standings for the national-bracket display.
    if (ps.national?.ws) {
      ps.national.ws.poolAStandings = res.standings
      ps.national.ws.poolBStandings = poolBRes.standings
    }
    round.champSeeds = [aTop[0], bTop[1], bTop[0], aTop[1]].filter(Boolean)
    round.champSeedKey = `wschamp_${year}`
    if (!userAdvanced) {
      round.resolved = true; round.pendingGameId = null
      round.userWon = false
      ps.userAlive = false; ps.userEliminatedAt = 'WS'
      // crown champ in background among the 4 qualifiers
      const r = runMatchGraph(round.champSeeds, deGraph(4), '__none__', () => null, sim, `wschamp_${year}`)
      ps.nationalChampion = r.champion
      if (ps.national?.ws) { ps.national.ws.championship = { seeds: round.champSeeds, champion: r.champion }; ps.national.ws.champion = r.champion }
      return
    }
    // User advanced → 4-team double-elim championship. Seed A1,B2,B1,A2.
    round.phase = 'CHAMP'
    if (ps.national?.ws) ps.national.ws.championship = { seeds: round.champSeeds, champion: null }
    tickWorldSeries(state, ps, round, userId, year, getUserResult, sim, ratings)
    return
  }
  // CHAMP phase — 4-team double-elim. Match keys ('wb1', 'lbf', ...) don't
  // collide with the pool keys ('pool_i_j'), so no prefix is needed — and the
  // generated game id MUST match the key getUserResult() looks up.
  const res = runMatchGraph(round.champSeeds, deGraph(4), userId, getUserResult, sim, round.champSeedKey)
  if (res.pending) {
    const id = generatePendingGame(state, 'WS', res.pending)
    round.pendingGameId = id
    if (!round.gameIds.includes(id)) round.gameIds.push(id)
    const oppId = res.pending.homeId === userId ? res.pending.awayId : res.pending.homeId
    round.oppName = state.schools[oppId]?.name || 'Opponent'
  } else {
    round.resolved = true; round.pendingGameId = null
    round.champion = res.champion
    round.userWon = res.champion === userId
    if (round.userWon) { ps.userNatChamp = true; ps.nationalChampion = userId }
    else { ps.userAlive = false; ps.userEliminatedAt = 'WS'; ps.nationalChampion = res.champion }
    if (ps.national?.ws) { ps.national.ws.championship = { seeds: round.champSeeds, champion: res.champion }; ps.national.ws.champion = res.champion }
  }
}

export function advanceInteractivePostseasonNAIA(state, leavingWeek) {
  const ps = state.postseason
  if (!ps || !ps.interactive) return
  const ratings = seedFromPear(state.schools, state.conferences)
  // ALWAYS build the national bracket so it's fully viewable even after the
  // user is eliminated. setupRegional/setupWorldSeries wire the user's portion
  // interactively only if they're still alive; otherwise everything is simmed.
  if (leavingWeek === 40) {
    setupRegional(state, ratings)
    ps.stage = 'REGIONAL'
  } else if (leavingWeek === 41) {
    setupWorldSeries(state, ratings)
    ps.stage = 'WS'
  } else if (leavingWeek === 42) {
    finalize(state, ratings)
  }
}

// Build the FULL national field: 46 teams in 10 regionals (6 five-team, 4 four-
// team), hosted by the top 10 seeds. Sims every non-user regional so the whole
// Opening Round is viewable; the user's regional (if they qualified) is wired
// up as the interactive round and its champion is filled in once they play it.
function buildNationalRegionals(state, ratings) {
  const ps = state.postseason
  const userId = state.userSchoolId
  const year = state.calendar.year
  const sim = makeNonUserSim(ratings)
  let field = nationalField(state, ratings)
  if (ps.userAlive && !field.includes(userId)) field = [userId, ...field]
  field = field.slice(0, 46)
  const sizes = [5, 5, 5, 5, 5, 5, 4, 4, 4, 4]   // 6×5 + 4×4 = 46
  const regionals = sizes.map((sz, i) => ({ idx: i, hostId: field[i], seeds: [field[i]], target: sz, champion: null }))
  // Fill seeds 11..46 across regionals, one tier per pass (2-seeds, then 3s…).
  let next = 10
  for (let pass = 0; pass < 5 && next < field.length; pass++) {
    for (let i = 0; i < 10 && next < field.length; i++) {
      if (regionals[i].seeds.length < regionals[i].target) regionals[i].seeds.push(field[next++])
    }
  }
  for (const rg of regionals) {
    if (ps.userAlive && rg.seeds.includes(userId)) { rg.isUser = true; continue }
    const res = runMatchGraph(rg.seeds, deGraph(rg.seeds.length), '__none__', () => null, sim, `reg_${year}_${rg.idx}`)
    rg.champion = res.champion || rg.seeds[0]
  }
  ps.national = ps.national || {}
  ps.national.regionals = regionals.map(rg => ({
    idx: rg.idx, hostId: rg.hostId, seeds: rg.seeds, champion: rg.champion, isUser: !!rg.isUser,
  }))
  return regionals
}

function setupRegional(state, ratings) {
  const ps = state.postseason
  const year = state.calendar.year
  const userId = state.userSchoolId
  buildNationalRegionals(state, ratings)
  const ureg = (ps.national.regionals || []).find(r => r.isUser)
  if (ureg && ps.userAlive) {
    ps.rounds.REGIONAL = {
      format: 'DE', seeds: ureg.seeds, spec: deGraph(ureg.seeds.length),
      seedKey: `reg_${year}_${ureg.idx}`, regionalIdx: ureg.idx,
      label: `NAIA Opening Round — ${ureg.seeds.length}-team regional (double-elim)`,
      resolved: false, userWon: false, pendingGameId: null, gameIds: [], champion: null,
    }
    tickInteractivePostseason(state)
  }
}

// Run a full pool + 4-team championship in the background (no user), returning
// { poolAStandings, poolBStandings, championship:{seeds,champion}, champion }.
function simFullWS(state, ratings, poolA, poolB, year) {
  const sim = makeNonUserSim(ratings)
  const a = runPool(poolA, '__none__', () => null, sim, `wsA_${year}`).standings
  const b = runPool(poolB, '__none__', () => null, sim, `wsB_${year}`).standings
  const champSeeds = [a[0]?.id, b[1]?.id, b[0]?.id, a[1]?.id].filter(Boolean)
  let champion = champSeeds[0]
  if (champSeeds.length >= 4) {
    champion = runMatchGraph(champSeeds, deGraph(4), '__none__', () => null, sim, `wschamp_${year}`).champion || champSeeds[0]
  }
  return { poolAStandings: a, poolBStandings: b, championship: { seeds: champSeeds, champion }, champion }
}

function setupWorldSeries(state, ratings) {
  const ps = state.postseason
  const userId = state.userSchoolId
  const year = state.calendar.year
  // The 10 regional champions are the WS field.
  let champs = (ps.national?.regionals || []).map(r => r.champion).filter(Boolean)
  if (champs.length < 10) {
    // pad from the field if any regional champ is missing
    const extra = nationalField(state, ratings).filter(id => !champs.includes(id))
    champs = [...champs, ...extra].slice(0, 10)
  }
  const userIsChamp = ps.userAlive && champs.includes(userId)
  let poolA, poolB
  if (userIsChamp) {
    const o = champs.filter(id => id !== userId)
    poolA = [userId, o[0], o[2], o[4], o[6]].filter(Boolean)
    poolB = [o[1], o[3], o[5], o[7]].filter(Boolean)
  } else {
    poolA = champs.slice(0, 5); poolB = champs.slice(5, 10)
  }
  ps.national = ps.national || {}
  ps.national.ws = { poolA, poolB, poolAStandings: null, poolBStandings: null, championship: null, champion: null }

  if (userIsChamp) {
    ps.rounds.WS = {
      format: 'WS', phase: 'POOL', pool: poolA, poolB,
      seedKey: `ws_${year}_${userId}`,
      label: 'NAIA World Series — pool play → 4-team championship',
      resolved: false, userWon: false, userInChamp: false,
      pendingGameId: null, gameIds: [], champion: null,
    }
    tickInteractivePostseason(state)
  } else {
    // User isn't in the WS — sim the whole thing for viewing.
    const r = simFullWS(state, ratings, poolA, poolB, year)
    ps.national.ws.poolAStandings = r.poolAStandings
    ps.national.ws.poolBStandings = r.poolBStandings
    ps.national.ws.championship = r.championship
    ps.national.ws.champion = r.champion
    if (!ps.nationalChampion) ps.nationalChampion = r.champion
  }
}

function finalize(state, ratings) {
  const ps = state.postseason
  const userId = state.userSchoolId
  const year = state.calendar.year
  if (ps.userAlive && ps.rounds.WS?.userWon) { ps.userNatChamp = true; ps.nationalChampion = userId }
  if (!ps.nationalChampion) {
    const field = nationalField(state, ratings).filter(id => id !== userId)
    const sim = makeNonUserSim(ratings)
    const seeds = field.slice(0, 4)
    if (seeds.length >= 4) {
      const r = runMatchGraph(seeds, deGraph(4), '__none__', () => null, sim, `wsfin_${year}`)
      ps.nationalChampion = r.champion || seeds[0]
    } else { ps.nationalChampion = seeds[0] || null }
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
