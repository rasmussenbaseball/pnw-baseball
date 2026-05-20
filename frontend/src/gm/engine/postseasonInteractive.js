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
import { nonNaiaToUniversal } from './nwbbRating'
import nonNaiaRaw from '../data/non_naia_teams.json'

// Abstract D2 universe (strength-only teams that fill the national field around
// the user's real GNAC program).
const D2_ABSTRACT = (nonNaiaRaw.divisions || []).find(d => d.id === 'D2')?.teams?.map(t => ({ ...t, division: 'D2' })) || []
const D2_ABSTRACT_BY_ID = Object.fromEntries(D2_ABSTRACT.map(t => [t.id, t]))

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
  if (n <= 2) {
    // 1-2 teams: a single decisive game (no real double-elim possible).
    return { graph: [{ key: 'wb1', a: 0, b: 1 }], wbChampKey: 'wb1', lbChampKey: 'wb1', single: true }
  }
  if (n === 3) {
    // 3-team double-elim: 1 gets a bye to the WB final.
    return {
      graph: [
        { key: 'wb1', a: 1, b: 2 },                       // 2 vs 3
        { key: 'wbf', a: 0, b: { win: 'wb1' } },          // 1 vs W(2v3)
        { key: 'lbf', a: { lose: 'wb1' }, b: { lose: 'wbf' } },
      ],
      wbChampKey: 'wbf', lbChampKey: 'lbf',
    }
  }
  if (n >= 8) {
    // Standard 8-team double-elim (used by D2/D3 regionals + NWAC + WS brackets).
    // Seeds 0..7. Cross-feeds in the losers bracket reduce immediate rematches.
    return {
      graph: [
        { key: 'wb1', a: 0, b: 7 },
        { key: 'wb2', a: 3, b: 4 },
        { key: 'wb3', a: 2, b: 5 },
        { key: 'wb4', a: 1, b: 6 },
        { key: 'wb5', a: { win: 'wb1' }, b: { win: 'wb2' } },
        { key: 'wb6', a: { win: 'wb3' }, b: { win: 'wb4' } },
        { key: 'wbf', a: { win: 'wb5' }, b: { win: 'wb6' } },
        { key: 'lb1', a: { lose: 'wb1' }, b: { lose: 'wb2' } },
        { key: 'lb2', a: { lose: 'wb3' }, b: { lose: 'wb4' } },
        { key: 'lb3', a: { lose: 'wb5' }, b: { win: 'lb2' } },
        { key: 'lb4', a: { lose: 'wb6' }, b: { win: 'lb1' } },
        { key: 'lb5', a: { win: 'lb3' }, b: { win: 'lb4' } },
        { key: 'lbf', a: { lose: 'wbf' }, b: { win: 'lb5' } },
      ],
      wbChampKey: 'wbf', lbChampKey: 'lbf',
    }
  }
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
  if (!seeds || seeds.length === 0) return { champion: null }
  if (seeds.length === 1) return { champion: seeds[0] }
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
      // Winner by TEAM ID using the schedule's recorded sides (which may have
      // been host-swapped), then map back to this match's h/a so the bracket
      // stays correct regardless of who was listed home.
      const winner = (res.homeId && res.awayId)
        ? (res.homeRuns > res.awayRuns ? res.homeId : res.awayId)
        : (res.homeRuns > res.awayRuns ? h : a)
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
  // Single decisive game (tiny field) — no winners-bracket/losers-bracket grand
  // final; the lone match decides it.
  if (spec.single) return { champion: results[spec.wbChampKey]?.winner || seeds[0] }
  const wb = results[spec.wbChampKey]?.winner
  const lb = results[spec.lbChampKey]?.winner
  if (!wb || !lb) return { champion: wb || lb || seeds[0] }
  // Best-of-3 final variant (D2 WS): the bracket only determines the two
  // FINALISTS — the caller runs a clean best-of-3 between them (no WB-champ
  // win-twice advantage). Return them instead of playing the grand final.
  if (spec.bestOf3Final) return { finalists: [wb, lb] }
  if (!results.GF1) { const r = play('GF1', wb, lb); if (r.pending) return r }
  if (results.GF1.winner === wb) return { champion: wb }
  if (!results.GF2) { const r = play('GF2', wb, lb); if (r.pending) return r }
  return { champion: results.GF2.winner }
}

/**
 * Resumable best-of-3 series (super regionals + WS finals). Returns
 * { champion } once a team reaches 2 wins, or { pending } for the next user
 * game. Higher seed (aId) hosts every game (simplification). gameKeys are
 * `${keyPrefix}_g1..g3`.
 */
function runBestOf3(aId, bId, userId, getUserResult, simNonUser, keyPrefix) {
  const wins = { [aId]: 0, [bId]: 0 }
  for (let g = 1; g <= 3; g++) {
    if (wins[aId] >= 2 || wins[bId] >= 2) break
    const key = `${keyPrefix}_g${g}`
    let w
    if (aId === userId || bId === userId) {
      const res = getUserResult(key)
      if (!res) return { pending: { homeId: aId, awayId: bId, gameKey: key } }
      w = (res.homeId && res.awayId)
        ? (res.homeRuns > res.awayRuns ? res.homeId : res.awayId)
        : (res.homeRuns > res.awayRuns ? aId : bId)
    } else {
      w = simNonUser(aId, bId, `${keyPrefix}_${g}`)
    }
    wins[w] = (wins[w] || 0) + 1
  }
  return { champion: wins[aId] >= 2 ? aId : bId }
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
    // Return the schedule's actual home/away ids too: generatePendingGame may
    // have swapped them so the host sits at home, so the bracket can't assume
    // homeRuns belongs to its own `h` team.
    return { homeRuns: g.homeRuns, awayRuns: g.awayRuns, homeId: g.homeId, awayId: g.awayId }
  }
}

function generatePendingGame(state, stage, pending, hostId = null) {
  const year = state.calendar.year
  const id = userGameId(year, stage, pending.gameKey)
  if ((state.schedule || []).some(g => g.id === id)) return id
  if (!state.schedule) state.schedule = []
  // Site rule (per Nate): the 1-seed HOSTS the conference tournament and the
  // regional, so any game involving the host is played at the host (host =
  // home). Every other matchup in those rounds — and ALL World Series games —
  // is a neutral-site game. We still pick a stable home/away for box-score
  // bookkeeping, but flag neutralSite so the UI can label it.
  let homeId = pending.homeId
  let awayId = pending.awayId
  const hostPlaying = hostId && (homeId === hostId || awayId === hostId)
  const neutralSite = !hostPlaying
  if (hostPlaying && awayId === hostId) {
    // Make the host the home team for display when they're listed as away.
    homeId = hostId
    awayId = pending.homeId
  }
  const woy = psWeekFor(state, stage)
  const dayOfMay = 5 + (woy - 39) * 7   // rough display date within May
  state.schedule.push({
    id, year,
    seasonWeek: woy - 26,
    weekOfYear: woy,
    date: `${year}-05-${String(Math.min(28, Math.max(5, dayOfMay))).padStart(2, '0')}`,
    homeId, awayId,
    type: 'POSTSEASON', postseasonStage: stage, neutralSite,
    countsTowardRecord: false, isDoubleheader: false,
    played: false, homeRuns: null, awayRuns: null,
  })
  return id
}

/**
 * The weekOfYear a given postseason stage falls on, per level. D2 runs four
 * rounds (CONF 39, REGIONAL 40, SUPER 41, WS 42); everyone else runs three
 * (CONF 40, REGIONAL 41, WS 42).
 */
function psWeekFor(state, stage) {
  if (state.level === 'D2') return ({ CONF: 39, REGIONAL: 40, SUPER: 41, WS: 42 })[stage] ?? 42
  return ({ CONF: 40, REGIONAL: 41, WS: 42 })[stage] ?? 42
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

/**
 * CURRENT-SEASON strength of a team (higher = better). Postseason seeding must
 * use how teams actually did THIS year — not the preseason PEAR ratings, which
 * was the bug that let a 56th-ranked, eliminated team "host" a regional. Prefer
 * the live NWBB national rank (recomputed weekly), then fall back to W-L + run
 * differential.
 */
function seasonScore(state, id) {
  const nr = state.nwbbRatings?.[id]?.nationalRank
  if (typeof nr === 'number' && nr > 0) return 100000 - nr   // rank 1 = highest
  const t = state.teams?.[id]
  if (!t) return -1e9
  return (t.wins || 0) * 1000 + (t.runDiff || 0)
}

function nationalField(state, ratings) {
  const ps = state.postseason
  // Always make sure EVERY conference has a champion in the field. Previously
  // this only computed confChampionsAll when confChampions was empty — but once
  // the user won their own conference tournament, confChampions held exactly ONE
  // entry (the user's), so the `length === 0` guard skipped computing all the
  // OTHER conferences. The national field then had just 1 auto-bid + 36
  // at-large = 37 teams, not enough to fill 10 regionals (46), and the user
  // could get squeezed out of a regional entirely. Merge: keep the user's
  // actual tournament result, backfill every other conference.
  const full = confChampionsAll(state, ratings)
  ps.confChampions = { ...full, ...(ps.confChampions || {}) }
  const hasTeam = (id) => !!state.teams?.[id]
  const set = new Set(Object.values(ps.confChampions).filter(id => id && hasTeam(id)))
  // At-large bids: the best teams BY CURRENT SEASON not already auto-bid in.
  const all = Object.keys(state.schools || {})
    .filter(id => !set.has(id) && hasTeam(id))
    .sort((a, b) => seasonScore(state, b) - seasonScore(state, a))
  for (const id of all.slice(0, 36)) set.add(id)
  return [...set].sort((a, b) => seasonScore(state, b) - seasonScore(state, a))
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
  // D2 background games use the D2 rating universe (real GNAC + abstract teams);
  // everyone else uses the PEAR-seeded NAIA universe.
  const sim = state.level === 'D2' ? makeD2Sim(state) : makeNonUserSim(ratings)
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
  if (round.format === 'BO3') {
    // Best-of-3 (D2 super regional). Higher seed (aId) hosts.
    const res = runBestOf3(round.aId, round.bId, userId, getUserResult, sim, round.seedKey)
    if (res.pending) {
      const id = generatePendingGame(state, stage, res.pending, round.aId)
      round.pendingGameId = id
      if (!round.gameIds.includes(id)) round.gameIds.push(id)
      const oppId = res.pending.homeId === userId ? res.pending.awayId : res.pending.homeId
      round.oppName = teamNameOf(state, oppId)
    } else {
      round.resolved = true; round.pendingGameId = null
      round.champion = res.champion
      round.userWon = res.champion === userId
      if (!round.userWon) { ps.userAlive = false; ps.userEliminatedAt = stage }
    }
    return
  }
  if (round.format === 'WS8') {
    tickD2WorldSeries(state, ps, round, userId, getUserResult, sim)
    return
  }
}

function applyDeResult(state, ps, stage, round, res) {
  const userId = state.userSchoolId
  if (res.pending) {
    // CONF + REGIONAL: 1-seed (seeds[0]) hosts; other matchups are neutral.
    const id = generatePendingGame(state, stage, res.pending, round.hostId ?? round.seeds?.[0])
    round.pendingGameId = id
    if (!round.gameIds.includes(id)) round.gameIds.push(id)
    const oppId = res.pending.homeId === userId ? res.pending.awayId : res.pending.homeId
    round.oppName = teamNameOf(state, oppId)
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
  // IMPORTANT: advance ps.stage BEFORE running setup. setupRegional/
  // setupWorldSeries call tickInteractivePostseason(), which reads
  // ps.rounds[ps.stage]. If the stage were still 'CONF' (resolved), the tick
  // would return early and NEVER generate the user's regional/WS game — the
  // exact bug where a CCC champion got no regional game and was dropped from
  // the World Series.
  if (leavingWeek === 40) {
    ps.stage = 'REGIONAL'
    setupRegional(state, ratings)
  } else if (leavingWeek === 41) {
    ps.stage = 'WS'
    setupWorldSeries(state, ratings)
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
    // If the user landed in the national field — as a conference champ OR an
    // AT-LARGE bid (a strong team that didn't win its conf tournament, like a
    // #45 6-seed) — they made the Opening Round and must PLAY it. Previously
    // only ps.userAlive teams were made interactive, so an at-large team showed
    // up in a regional but couldn't play and got auto-simmed a loss. Revive
    // them here so their regional is interactive.
    if (rg.seeds.includes(userId)) {
      rg.isUser = true
      ps.userAlive = true
      ps.userEliminatedAt = null
      continue
    }
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
  }
  // If the user ISN'T in the WS, we DON'T sim it now — week 42 IS the World
  // Series, so it shouldn't already be decided when you arrive. The field +
  // pools are shown; the games are simmed and the champion crowned when you
  // advance OUT of week 42 (finalize). The user-interactive case resolves as
  // they play their own games during the week.
}

function finalize(state, ratings) {
  const ps = state.postseason
  const userId = state.userSchoolId
  const year = state.calendar.year
  if (ps.userAlive && ps.rounds.WS?.userWon) { ps.userNatChamp = true; ps.nationalChampion = userId }
  // Spectator WS (user not in it): NOW (advancing out of wk42) play out the
  // World Series — pools + 4-team championship — and crown the champion.
  const ws = ps.national?.ws
  if (!ps.nationalChampion && ws && ws.poolA && ws.poolB) {
    const r = simFullWS(state, ratings, ws.poolA, ws.poolB, year)
    ws.poolAStandings = r.poolAStandings
    ws.poolBStandings = r.poolBStandings
    ws.championship = r.championship
    ws.champion = r.champion
    ps.nationalChampion = r.champion
  }
  if (!ps.nationalChampion) {
    // Last-ditch fallback if there was no WS structure at all.
    const field = nationalField(state, ratings).filter(id => id !== userId)
    const sim = makeNonUserSim(ratings)
    const seeds = field.slice(0, 4)
    ps.nationalChampion = seeds.length >= 4
      ? (runMatchGraph(seeds, deGraph(4), '__none__', () => null, sim, `wsfin_${year}`).champion || seeds[0])
      : (seeds[0] || null)
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

// ══ D2 interactive postseason ════════════════════════════════════════════════
// GNAC Conf Tournament (top 3, double-elim, wk39) → NCAA Regional (3-4 team
// double-elim, wk40) → Super Regional (best-of-3, wk41) → D2 World Series
// (8-team double-elim into a best-of-3 final, wk42). Real GNAC teams play full
// sims; the abstract national field is fast-simmed. Hosts + seeds by ranking.

/** Team display name for either a real school or an abstract D2 program. */
export function teamNameOf(state, id) {
  return state.schools?.[id]?.name || D2_ABSTRACT_BY_ID[id]?.name || 'Opponent'
}

/** Unified 0-100 rating for any D2 team (real → NWBB rating; abstract → PEAR). */
function d2RatingOf(state, id) {
  const r = state.nwbbRatings?.[id]?.rating
  if (typeof r === 'number') return r
  const ab = D2_ABSTRACT_BY_ID[id]
  return ab ? nonNaiaToUniversal(ab) : 50
}

/** Deterministic background-game sim for D2 (returns the winning team id). */
function makeD2Sim(state) {
  const mk = (x) => ({ overall_rating: (x - 60) / 5, offense_rating: (x - 60) / 10, pitching_rating: (x - 60) / 10 })
  return (h, a, key) => {
    const r = fastSimGame(mk(d2RatingOf(state, h)), mk(d2RatingOf(state, a)), `d2_${key}`)
    return r.homeRuns >= r.awayRuns ? h : a
  }
}

/** 56-team D2 national field, seeded best-first by rating (GNAC + abstract). */
function d2NationalField(state) {
  const real = Object.keys(state.schools || {}).filter(id => state.teams?.[id])
  const cands = [
    ...real.map(id => ({ id, rating: d2RatingOf(state, id) })),
    ...D2_ABSTRACT.map(t => ({ id: t.id, rating: nonNaiaToUniversal(t) })),
  ].sort((a, b) => b.rating - a.rating)
  return cands.slice(0, 56).map(c => c.id)
}

export function setupInteractivePostseasonD2(state) {
  const userId = state.userSchoolId
  const year = state.calendar.year
  const userConfId = state.schools?.[userId]?.conferenceId
  const userSeeds = seedConference(state, userConfId)   // GNAC, by confWins → runDiff
  const fieldSize = Math.min(3, userSeeds.length)        // GNAC tournament = top 3
  const userSeedIdx = userSeeds.indexOf(userId)
  const userInConfTourney = fieldSize >= 2 && userSeedIdx >= 0 && userSeedIdx < fieldSize
  const ps = {
    year: year + 1, level: 'D2', interactive: true, stage: 'CONF',
    userQualified: userInConfTourney, userAlive: userInConfTourney,
    userEliminatedAt: userInConfTourney ? null : 'REG_SEASON',
    userConfId, userChamp: false, userNatChamp: false, nationalChampion: null,
    confChampions: {}, rounds: { CONF: null, REGIONAL: null, SUPER: null, WS: null },
    national: { regionals: [], superRegionals: [], ws: null },
  }
  state.postseason = ps
  if (userInConfTourney) {
    const seeds = userSeeds.slice(0, fieldSize)
    ps.rounds.CONF = {
      format: 'DE', seeds, spec: deGraph(seeds.length), hostId: seeds[0],
      seedKey: `d2conf_${year}`,
      label: `${state.conferences[userConfId]?.abbreviation || 'GNAC'} Tournament (top ${fieldSize}, double-elim)`,
      resolved: false, userWon: false, pendingGameId: null, gameIds: [], champion: null,
    }
    tickInteractivePostseason(state)
  }
  return ps
}

export function advanceInteractivePostseasonD2(state, leavingWeek) {
  const ps = state.postseason
  if (!ps || !ps.interactive || ps.level !== 'D2') return
  if (leavingWeek === 39) { ps.stage = 'REGIONAL'; setupD2Regional(state) }
  else if (leavingWeek === 40) { ps.stage = 'SUPER'; setupD2Super(state) }
  else if (leavingWeek === 41) { ps.stage = 'WS'; setupD2WS(state) }
  else if (leavingWeek === 42) { finalizeD2(state) }
}

function setupD2Regional(state) {
  const ps = state.postseason
  const userId = state.userSchoolId
  const year = state.calendar.year
  const sim = makeD2Sim(state)
  let field = d2NationalField(state)
  // Auto-bid: a GNAC tournament champ who isn't already in the at-large field
  // still makes the regionals.
  if (ps.userChamp && !field.includes(userId)) field = [userId, ...field].slice(0, 56)
  field = field.slice(0, 56)
  // 16 sites: 8 of 4 teams + 8 of 3 = 56. Top 16 by rating host.
  const sizes = [4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3]
  const regionals = sizes.map((sz, i) => ({ idx: i, hostId: field[i], seeds: [field[i]], target: sz, champion: null }))
  let next = 16
  for (let pass = 0; pass < 4 && next < field.length; pass++) {
    for (let i = 0; i < 16 && next < field.length; i++) {
      if (regionals[i].seeds.length < regionals[i].target) regionals[i].seeds.push(field[next++])
    }
  }
  for (const rg of regionals) {
    if (rg.seeds.includes(userId)) {
      // At-large or auto-bid → the user PLAYS this regional interactively.
      rg.isUser = true; ps.userAlive = true; ps.userQualified = true; ps.userEliminatedAt = null; continue
    }
    rg.champion = runMatchGraph(rg.seeds, deGraph(rg.seeds.length), '__none__', () => null, sim, `d2reg_${year}_${rg.idx}`).champion || rg.seeds[0]
  }
  ps.national.regionals = regionals.map(rg => ({ idx: rg.idx, hostId: rg.hostId, seeds: rg.seeds, champion: rg.champion, isUser: !!rg.isUser }))
  const ureg = ps.national.regionals.find(r => r.isUser)
  if (ureg && ps.userAlive) {
    ps.rounds.REGIONAL = {
      format: 'DE', seeds: ureg.seeds, spec: deGraph(ureg.seeds.length),
      seedKey: `d2reg_${year}_${ureg.idx}`, regionalIdx: ureg.idx, hostId: ureg.seeds[0],
      label: `NCAA D2 Regional — ${ureg.seeds.length}-team double-elim`,
      resolved: false, userWon: false, pendingGameId: null, gameIds: [], champion: null,
    }
    tickInteractivePostseason(state)
  }
}

function setupD2Super(state) {
  const ps = state.postseason
  const userId = state.userSchoolId
  const year = state.calendar.year
  const sim = makeD2Sim(state)
  const champs = (ps.national.regionals || []).map(r => r.champion)
  // Pair the 16 regional champions 1v16, 2v15, … into 8 best-of-3 super regionals.
  const pairs = []
  for (let j = 0; j < 8; j++) pairs.push([champs[j], champs[15 - j]])
  ps.national.superRegionals = pairs.map((p, j) => ({ idx: j, a: p[0], b: p[1], champion: null, isUser: p.includes(userId) }))
  for (const sr of ps.national.superRegionals) {
    if (sr.isUser && ps.userAlive) continue
    sr.champion = runBestOf3(sr.a, sr.b, '__none__', () => null, sim, `d2sr_${year}_${sr.idx}`).champion
  }
  const usr = ps.national.superRegionals.find(s => s.isUser)
  if (usr && ps.userAlive) {
    // Higher-rated team hosts (aId).
    const aId = d2RatingOf(state, usr.a) >= d2RatingOf(state, usr.b) ? usr.a : usr.b
    const bId = aId === usr.a ? usr.b : usr.a
    ps.rounds.SUPER = {
      format: 'BO3', aId, bId, seedKey: `d2sr_${year}_${usr.idx}`, superIdx: usr.idx,
      label: 'NCAA D2 Super Regional — best-of-3', oppName: teamNameOf(state, aId === userId ? bId : aId),
      resolved: false, userWon: false, pendingGameId: null, gameIds: [], champion: null,
    }
    tickInteractivePostseason(state)
  }
}

function setupD2WS(state) {
  const ps = state.postseason
  const userId = state.userSchoolId
  const year = state.calendar.year
  // Record the user's super-regional champion before assembling the WS field.
  const usr = (ps.national.superRegionals || []).find(s => s.isUser)
  if (usr) usr.champion = ps.rounds.SUPER?.champion || (ps.userAlive ? userId : usr.a)
  const champs = (ps.national.superRegionals || []).map(s => s.champion).filter(Boolean).slice(0, 8)
  ps.national.ws = { seeds: champs, finalists: null, champion: null }
  const userInWS = ps.userAlive && champs.includes(userId)
  if (userInWS) {
    const seeded = [...champs].sort((a, b) => d2RatingOf(state, b) - d2RatingOf(state, a))
    ps.rounds.WS = {
      format: 'WS8', phase: 'BRACKET', seeds: seeded, spec: { ...deGraph(8), bestOf3Final: true },
      seedKey: `d2ws_${year}`, label: 'NCAA D2 World Series — 8-team double-elim → best-of-3 final',
      resolved: false, userWon: false, pendingGameId: null, gameIds: [], champion: null, finalists: null,
    }
    tickInteractivePostseason(state)
  }
}

function tickD2WorldSeries(state, ps, round, userId, getUserResult, sim) {
  if (round.phase === 'BRACKET') {
    const res = runMatchGraph(round.seeds, round.spec, userId, getUserResult, sim, round.seedKey)
    if (res.pending) {
      const id = generatePendingGame(state, 'WS', res.pending)   // WS = neutral site
      round.pendingGameId = id
      if (!round.gameIds.includes(id)) round.gameIds.push(id)
      const oppId = res.pending.homeId === userId ? res.pending.awayId : res.pending.homeId
      round.oppName = teamNameOf(state, oppId)
      return
    }
    round.finalists = res.finalists || (res.champion ? [res.champion] : [])
    round.phase = 'FINAL'
    ps.national.ws.finalists = round.finalists
    if (round.finalists.length < 2 || !round.finalists.includes(userId)) {
      // User didn't reach the final — sim the best-of-3 + crown the champion.
      ps.userAlive = false; ps.userEliminatedAt = 'WS'
      round.resolved = true
      const fr = round.finalists.length >= 2
        ? runBestOf3(round.finalists[0], round.finalists[1], '__none__', () => null, sim, `${round.seedKey}_final`)
        : { champion: round.finalists[0] }
      round.champion = fr.champion
      ps.national.ws.champion = fr.champion
      ps.nationalChampion = fr.champion
      return
    }
    tickD2WorldSeries(state, ps, round, userId, getUserResult, sim)
    return
  }
  // FINAL — best-of-3 between the two finalists.
  const [aId, bId] = round.finalists
  const res = runBestOf3(aId, bId, userId, getUserResult, sim, `${round.seedKey}_final`)
  if (res.pending) {
    const id = generatePendingGame(state, 'WS', res.pending)
    round.pendingGameId = id
    if (!round.gameIds.includes(id)) round.gameIds.push(id)
    const oppId = res.pending.homeId === userId ? res.pending.awayId : res.pending.homeId
    round.oppName = teamNameOf(state, oppId)
  } else {
    round.resolved = true; round.pendingGameId = null
    round.champion = res.champion
    round.userWon = res.champion === userId
    ps.national.ws.champion = res.champion
    ps.nationalChampion = res.champion
    if (round.userWon) ps.userNatChamp = true
    else { ps.userAlive = false; ps.userEliminatedAt = 'WS' }
  }
}

function finalizeD2(state) {
  const ps = state.postseason
  const userId = state.userSchoolId
  const year = state.calendar.year
  const sim = makeD2Sim(state)
  if (ps.userAlive && ps.rounds.WS?.userWon) { ps.userNatChamp = true; ps.nationalChampion = userId }
  if (!ps.nationalChampion) {
    // User not in the WS (or it wasn't resolved) — play it out now and crown.
    const champs = ps.national.ws?.seeds || []
    if (champs.length >= 2) {
      const seeded = [...champs].sort((a, b) => d2RatingOf(state, b) - d2RatingOf(state, a))
      const res = runMatchGraph(seeded, { ...deGraph(8), bestOf3Final: true }, '__none__', () => null, sim, `d2wsfin_${year}`)
      const finalists = res.finalists || (res.champion ? [res.champion] : [])
      ps.national.ws = ps.national.ws || {}
      ps.national.ws.finalists = finalists
      ps.nationalChampion = finalists.length >= 2
        ? runBestOf3(finalists[0], finalists[1], '__none__', () => null, sim, `d2wsfin_${year}_final`).champion
        : (finalists[0] || seeded[0])
      ps.national.ws.champion = ps.nationalChampion
    }
  }
  ps.stage = 'DONE'
  const champName = teamNameOf(state, ps.nationalChampion)
  state.newsfeed = state.newsfeed || []
  state.newsfeed.unshift({
    id: `d2_done_${year}_${Math.random().toString(36).slice(2, 6)}`,
    year: year + 1, week: 16, type: 'POSTSEASON',
    headline: ps.userNatChamp
      ? `${state.schools[userId]?.name} WINS THE NCAA DIVISION II NATIONAL CHAMPIONSHIP!`
      : `${champName} win the NCAA Division II title.`,
    big: ps.userNatChamp,
  })
}
