/**
 * PNW playoff format registry.
 *
 * Per Nate (May 2026): the GM game is PNW-only. We need playoff bracket
 * specs for every conference that contains a PNW program across all
 * levels (D1, D2, D3, NAIA, NWAC) so that if/when the user picks a
 * non-NAIA PNW team, the postseason flow Just Works.
 *
 * Data lives in `data/pnw_playoff_formats.json`. This module:
 *   - Re-exports the conferences / formats as easy lookups
 *   - Provides helpers (formatForConference, qualifierCountForConf, etc.)
 *   - Provides reusable bracket simulators (single-elim, double-elim,
 *     best-of-3, pool-play) that the higher-level postseason runner can
 *     call regardless of which division the user is in
 *
 * This file is engine-level scaffolding. The current NAIA postseason
 * (engine/tournament.js + engine/nationalTournament.js) keeps working
 * unchanged — it just doesn't go through this generic path yet. When we
 * add D1/D2/D3/NWAC support we'll route those through the runners here.
 */

import raw from '../data/pnw_playoff_formats.json'
import { makeRng } from './rng'

// ─── Constant lookups ─────────────────────────────────────────────────────

/** Conference by id. e.g. PNW_CONFERENCES.CCC */
export const PNW_CONFERENCES = raw.conferences || {}

/** Division → array of conference ids that contain PNW programs. */
export const PNW_DIVISIONS = raw.divisions || {}

/** Format type → explanation. Useful for tooltips. */
export const BRACKET_FORMATS = raw.bracketFormats || {}

/**
 * @param {string} confId
 * @returns {object|null} the conference + tournament format
 */
export function formatForConference(confId) {
  return PNW_CONFERENCES[confId] || null
}

/**
 * How many teams qualify for the conference tournament?
 * Falls back to 8 for unknown conferences.
 */
export function qualifierCountForConf(confId) {
  return PNW_CONFERENCES[confId]?.tournament?.fieldSize ?? 8
}

/**
 * Division-level national tournament spec (e.g. NCAA D1 Tournament + CWS).
 * @param {'D1'|'D2'|'D3'|'NAIA'|'NWAC'} level
 */
export function nationalSpecForLevel(level) {
  return PNW_DIVISIONS[level]?.national || null
}

/**
 * All PNW programs at a given level, flattened across the level's confs.
 * Each entry is enriched with strength + colors + nickname from
 * non_naia_teams.json so the New Dynasty picker can show real stars +
 * team-color logo circles instead of flat 2.5 stars + bland defaults.
 */
import nonNaiaForLookup from '../data/non_naia_teams.json'
const NON_NAIA_BY_ID = (() => {
  const out = {}
  for (const div of nonNaiaForLookup.divisions || []) {
    for (const t of div.teams || []) out[t.id] = t
  }
  return out
})()

export function pnwProgramsAtLevel(level) {
  const confIds = (PNW_DIVISIONS[level]?.pnwConferences) || []
  const out = []
  for (const id of confIds) {
    const conf = PNW_CONFERENCES[id]
    if (!conf) continue
    for (const m of (conf.pnwMembers || [])) {
      const enrich = NON_NAIA_BY_ID[m.id] || {}
      const strength = enrich.strength ?? 0
      // Pre-compute the same programHistory the dynasty-creation path
      // ultimately uses (buildSyntheticSchool in newDynastyMultiLevel.js)
      // so UIs that need to display expected Team OVR / star ratings
      // before dynasty creation get a stable value without spinning up
      // a roster. Mirrors the tierBase + strength × tierSlope formula —
      // keep these in sync with newDynastyMultiLevel.
      const TIER_BASE  = { D1: 74, D2: 47, D3: 41, NWAC: 44 }
      const TIER_SLOPE = { D1: 6.5, D2: 7.0, D3: 7.5, NWAC: 4.5 }
      const programHistory = Math.max(15, Math.min(99,
        Math.round((TIER_BASE[level] ?? 50) + strength * (TIER_SLOPE[level] ?? 2.0))))
      out.push({
        ...m,
        conferenceId: id,
        conferenceName: conf.name,
        level,
        strength,
        pearRank: enrich.pearRank ?? null,
        programHistory,
        // Prefer the colors set directly on the PNW member (pnw_playoff_formats),
        // then fall back to the PEAR-enriched colors (non_naia_teams.json). Means
        // NWAC schools that aren't in the national PEAR data can still ship with
        // hand-picked palettes via the playoff-formats file.
        colors: m.colors || enrich.colors || null,
        nickname: m.nickname || enrich.nickname || null,
        isIndependent: !!conf.isIndependent,
      })
    }
  }
  return out
}

// ─── Reusable bracket simulators ──────────────────────────────────────────
//
// Each sim takes a seeded list of team IDs + a `simGame(homeId, awayId, seed)`
// callback that returns `{ homeRuns, awayRuns }`. The caller wires simGame
// to either the full PA-level sim (user games) or fast-sim (non-user).
//
// All sims return a struct with `games[]`, `champion`, and any
// format-specific fields (e.g. `losersBracket` for double-elim).

/** Single-elim bracket. Teams must be a power of 2 (pad with byes if not). */
export function simSingleElim(teams, simGame, seedKey) {
  const rng = makeRng('se', seedKey)
  const games = []
  let alive = [...teams]
  let round = 0
  while (alive.length > 1) {
    round++
    const next = []
    for (let i = 0; i < alive.length; i += 2) {
      const homeId = alive[i]
      const awayId = alive[i + 1]
      if (!awayId) { next.push(homeId); continue }   // bye
      const r = simGame(homeId, awayId, `${seedKey}_r${round}_${i}`)
      const winner = r.homeRuns > r.awayRuns ? homeId : awayId
      games.push({ round, homeId, awayId, ...r, winner, label: `Round ${round}` })
      next.push(winner)
    }
    alive = next
  }
  return { games, champion: alive[0] || null, rounds: round }
}

/** Best-of-N series (default 3). */
export function simBestOfN(homeId, awayId, simGame, seedKey, bestOf = 3) {
  const needed = Math.ceil(bestOf / 2)
  const games = []
  let homeWins = 0, awayWins = 0, n = 0
  while (homeWins < needed && awayWins < needed) {
    n++
    const r = simGame(homeId, awayId, `${seedKey}_g${n}`)
    if (r.homeRuns > r.awayRuns) homeWins++
    else awayWins++
    games.push({ game: n, homeId, awayId, ...r, winner: r.homeRuns > r.awayRuns ? homeId : awayId })
  }
  return {
    games,
    champion: homeWins > awayWins ? homeId : awayId,
    homeWins, awayWins,
  }
}

/**
 * Generic double-elimination bracket for N teams. Handles 4, 5, 6, 7, 8
 * team brackets (the formats that show up in NAIA Opening Round, NCAA
 * regionals, conference tournaments).
 *
 * Teams arrive pre-seeded (index 0 = #1 seed). The simulator runs a
 * standard winners' bracket + losers' bracket. The losers' champion has
 * to beat the winners' champion TWICE in the final (the "if necessary"
 * game). Capped at 12 total rounds for safety.
 */
export function simDoubleElim(teams, simGame, seedKey) {
  const games = []
  let winnersBracket = [...teams]
  let losersBracket = []
  let round = 0

  while (winnersBracket.length + losersBracket.length > 1) {
    round++
    if (round > 30) break   // safety net

    // Play winners-bracket round
    const nextWinners = []
    const newLosers = []
    for (let i = 0; i < winnersBracket.length; i += 2) {
      const h = winnersBracket[i]
      const a = winnersBracket[i + 1]
      if (!a) { nextWinners.push(h); continue }   // bye
      const r = simGame(h, a, `${seedKey}_wbr${round}_${i}`)
      const winner = r.homeRuns > r.awayRuns ? h : a
      const loser = winner === h ? a : h
      games.push({ side: 'W', round, homeId: h, awayId: a, ...r, winner, label: `Winners R${round}` })
      nextWinners.push(winner)
      newLosers.push(loser)
    }

    // Play losers-bracket round — existing losers play first, then merge with new losers
    const lbAlive = [...losersBracket]
    const nextLosers = []
    for (let i = 0; i < lbAlive.length; i += 2) {
      const h = lbAlive[i]
      const a = lbAlive[i + 1]
      if (!a) { nextLosers.push(h); continue }
      const r = simGame(h, a, `${seedKey}_lbr${round}_${i}`)
      const winner = r.homeRuns > r.awayRuns ? h : a
      games.push({ side: 'L', round, homeId: h, awayId: a, ...r, winner, label: `Losers R${round}` })
      nextLosers.push(winner)
    }

    winnersBracket = nextWinners
    losersBracket = [...nextLosers, ...newLosers]
  }

  // If we wind up with one team in winners + one in losers, run the
  // championship — losers must win TWICE.
  let champion = null
  if (winnersBracket.length === 1 && losersBracket.length === 1) {
    const w = winnersBracket[0]
    const l = losersBracket[0]
    const g1 = simGame(w, l, `${seedKey}_final1`)
    const g1Winner = g1.homeRuns > g1.awayRuns ? w : l
    games.push({ side: 'F', round: round + 1, homeId: w, awayId: l, ...g1, winner: g1Winner, label: 'Championship 1' })
    if (g1Winner === w) {
      champion = w
    } else {
      const g2 = simGame(w, l, `${seedKey}_final2`)
      const g2Winner = g2.homeRuns > g2.awayRuns ? w : l
      games.push({ side: 'F', round: round + 2, homeId: w, awayId: l, ...g2, winner: g2Winner, label: 'Championship 2 (if necessary)' })
      champion = g2Winner
    }
  } else if (winnersBracket.length === 1) {
    champion = winnersBracket[0]
  } else if (losersBracket.length === 1) {
    champion = losersBracket[0]
  }

  return { games, champion }
}

/**
 * Pool play: M teams split into K pools, round-robin within each pool,
 * top N per pool advance. Returns the qualifiers + all pool games.
 * Used by the NAIA WS + ACC tournament. Tiebreaker: head-to-head, then
 * run diff, then random.
 */
export function simPoolPlay(pools, simGame, seedKey, advancePerPool = 2) {
  const games = []
  const records = {}   // teamId -> { wins, losses, runDiff }

  pools.forEach((pool, pi) => {
    for (const t of pool) records[t] = { wins: 0, losses: 0, runDiff: 0 }
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const r = simGame(pool[i], pool[j], `${seedKey}_p${pi}_${i}_${j}`)
        const winner = r.homeRuns > r.awayRuns ? pool[i] : pool[j]
        const loser = winner === pool[i] ? pool[j] : pool[i]
        records[winner].wins++
        records[loser].losses++
        records[pool[i]].runDiff += r.homeRuns - r.awayRuns
        records[pool[j]].runDiff += r.awayRuns - r.homeRuns
        games.push({ pool: pi, homeId: pool[i], awayId: pool[j], ...r, winner, label: `Pool ${pi + 1}` })
      }
    }
  })

  // Pick top N from each pool
  const qualifiers = pools.map(pool =>
    pool
      .map(id => ({ id, ...records[id] }))
      .sort((a, b) => b.wins - a.wins || b.runDiff - a.runDiff)
      .slice(0, advancePerPool)
      .map(x => x.id),
  )

  return { games, records, qualifiers }
}

// ─── High-level helper: run a conference tournament ───────────────────────

/**
 * Run a conference tournament given a conference id + seeded qualifiers.
 *
 * @param {string} confId
 * @param {string[]} seededTeams   in seed order (#1 first)
 * @param {(homeId: string, awayId: string, seedKey: string) => { homeRuns: number, awayRuns: number }} simGame
 * @param {string} seedKey
 * @returns {{ format: string, games: any[], champion: string|null, fieldSize: number }}
 */
export function runConferenceTournament(confId, seededTeams, simGame, seedKey) {
  const conf = PNW_CONFERENCES[confId]
  const fmt = conf?.tournament?.format || 'DOUBLE_ELIM'
  if (fmt === 'DOUBLE_ELIM') {
    const r = simDoubleElim(seededTeams, simGame, seedKey)
    return { format: fmt, games: r.games, champion: r.champion, fieldSize: seededTeams.length }
  }
  if (fmt === 'POOL_PLAY_SEMIS_CHAMPIONSHIP') {
    // Split into pools of ~3 (ACC) or use seededTeams as one pool
    const poolCount = Math.max(2, Math.floor(seededTeams.length / 3))
    const pools = Array.from({ length: poolCount }, () => [])
    seededTeams.forEach((t, i) => pools[i % poolCount].push(t))
    const pool = simPoolPlay(pools, simGame, seedKey, 1)
    const semifinalists = pool.qualifiers.flat()
    if (semifinalists.length < 2) return { format: fmt, games: pool.games, champion: semifinalists[0] || null, fieldSize: seededTeams.length }
    const se = simSingleElim(semifinalists, simGame, seedKey + '_se')
    return { format: fmt, games: [...pool.games, ...se.games], champion: se.champion, fieldSize: seededTeams.length }
  }
  // BUILT_INTO_NWAC_PLAYOFFS — handled at the division level, not conference
  if (fmt === 'BUILT_INTO_NWAC_PLAYOFFS') {
    return { format: fmt, games: [], champion: null, fieldSize: seededTeams.length, note: 'NWAC conferences feed super regionals — see runNwacPlayoffs' }
  }
  // Fallback to double-elim
  const r = simDoubleElim(seededTeams, simGame, seedKey)
  return { format: 'DOUBLE_ELIM', games: r.games, champion: r.champion, fieldSize: seededTeams.length }
}
