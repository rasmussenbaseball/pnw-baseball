/**
 * NAIA National Tournament — Opening Round + Avista World Series.
 *
 *   Opening Round: 46-team field 10 host sites (6 brackets of 5 teams,
 *                  4 brackets of 4 teams). Double-elim at each site. 10
 *                  winners advance to the World Series.
 *
 *   Avista NAIA WS: 10 teams at Harris Field, Lewiston, ID. Two pools of 5,
 *                   round-robin within pool. Top 2 from each pool advance
 *                   to single-elim semis. Single-game championship.
 *
 * Selection: 30 auto-bids (conf tournament champs + reg-season champs of
 * conferences with 2 auto-bids); 16 at-large by our overall ranking.
 */

import { simGame, fastSimGame, defaultLineup } from './sim'

/** @typedef {import('./types.js').SaveState} SaveState */

const TOTAL_FIELD = 46
const AT_LARGE_TARGET = TOTAL_FIELD - 30
const OPENING_ROUND_SITES = 10   // 6×5 + 4×4 = 46
const FIVE_TEAM_SITES = 6
const FOUR_TEAM_SITES = 4

/**
 * Select the 46-team national field.
 *
 * @param {string[]} autoBids        teams already in via conf auto-bid
 * @param {Object<string,any>} ratings   national ratings (overall_rating used for at-large)
 * @returns {string[]} the 46-team field, ordered by overall ranking
 */
export function selectNationalField(autoBids, ratings) {
  // Auto-bids first (deduped) — these always make the field regardless of
  // how many came through (conf champs + reg-season champs from 2-bid
  // conferences). If for some reason there are MORE auto-bids than the
  // total field size (shouldn't happen in real NAIA — 21 confs × ≤2 = 42,
  // but we defend anyway), the top-rated auto-bids win the slots and the
  // bottom ones drop out.
  const uniqueAutoBids = [...new Set(autoBids.filter(Boolean))]
  const ratedAutoBids = uniqueAutoBids
    .map(id => ({ id, rating: ratings[id]?.overall_rating ?? -99 }))
    .sort((a, b) => b.rating - a.rating)

  // If auto-bids already meet/exceed the total field, just take the top
  // TOTAL_FIELD and skip the at-large pass.
  const inField = new Set()
  if (ratedAutoBids.length >= TOTAL_FIELD) {
    for (let i = 0; i < TOTAL_FIELD; i++) inField.add(ratedAutoBids[i].id)
  } else {
    for (const r of ratedAutoBids) inField.add(r.id)
    // Fill remaining slots with the top-rated teams not already in. Use
    // (TOTAL_FIELD - filled) instead of the fixed AT_LARGE_TARGET so a
    // conference that produced an unexpected auto-bid total (e.g. only
    // one champ when expected two) doesn't over- or under-fill the field.
    const remainingSlots = TOTAL_FIELD - inField.size
    const atLargeCandidates = Object.values(ratings)
      .filter(r => !inField.has(r.schoolId))
      .sort((a, b) => b.overall_rating - a.overall_rating)
      .slice(0, remainingSlots)
    for (const r of atLargeCandidates) inField.add(r.schoolId)
  }

  // Return as array ordered by overall rating, capped at TOTAL_FIELD as a
  // belt-and-suspenders guard (if Set deduping reduced below — unlikely).
  return [...inField]
    .map(id => ({ id, rating: ratings[id]?.overall_rating ?? -99 }))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, TOTAL_FIELD)
    .map(x => x.id)
}

/**
 * Distribute 46 teams across 10 sites with geographic/conference balancing.
 * - Top 10 seeds are the hosts (top 6 host 5-team brackets, next 4 host 4-team)
 * - Remaining 36 teams distributed by snake draft to balance bracket strength
 * - Conference protection: avoid two teams from same conference at same site when possible
 *
 * @returns {Array<{ host: string, seed: number, teams: Array<{id: string, seed: number}>, size: number }>}
 */
export function buildOpeningRoundSites(field46, schools, conferences) {
  const sites = []
  // Top 10 seeds = hosts
  for (let i = 0; i < OPENING_ROUND_SITES; i++) {
    const isFiveTeam = i < FIVE_TEAM_SITES
    sites.push({
      host: field46[i],
      hostSeed: i + 1,
      teams: [{ id: field46[i], seed: 1 }],   // host gets local seed 1
      size: isFiveTeam ? 5 : 4,
    })
  }
  // Snake-draft remaining 36 teams across sites
  const remaining = field46.slice(OPENING_ROUND_SITES)
  // Hard cap: 46-team field × 10 sites means 36 remaining slots. If the field
  // came in larger than expected (e.g. selection logic produced an oversized
  // bracket), drop the extras — better than hanging in the placement loop.
  const totalSlots = sites.reduce((s, x) => s + x.size, 0) - OPENING_ROUND_SITES
  const placeable = remaining.slice(0, totalSlots)

  let forward = true
  let siteIdx = 0
  for (const teamId of placeable) {
    // Skip sites that are full — bounded by 2 * sites.length to defend
    // against any pathological state where every site is full but we
    // still have teams to place (shouldn't happen given placeable cap).
    let skipsAllowed = sites.length * 2
    while (sites[siteIdx].teams.length >= sites[siteIdx].size) {
      siteIdx = forward ? siteIdx + 1 : siteIdx - 1
      if (siteIdx >= sites.length) { siteIdx = sites.length - 1; forward = false }
      if (siteIdx < 0) { siteIdx = 0; forward = true }
      if (--skipsAllowed <= 0) break
    }
    if (sites[siteIdx].teams.length >= sites[siteIdx].size) break   // safety
    // Conference protection: try not to put a team in a site that already has
    // a team from the same conference (unless all alternatives are also full)
    const conf = schools[teamId]?.conferenceId
    const altSite = sites.find(s =>
      s.teams.length < s.size &&
      !s.teams.some(t => schools[t.id]?.conferenceId === conf),
    )
    const target = altSite && altSite !== sites[siteIdx] ? altSite : sites[siteIdx]
    target.teams.push({ id: teamId, seed: target.teams.length + 1 })
    siteIdx = forward ? siteIdx + 1 : siteIdx - 1
    if (siteIdx >= sites.length) { siteIdx = sites.length - 1; forward = false }
    if (siteIdx < 0) { siteIdx = 0; forward = true }
  }
  return sites
}

// ─── Double-elim sim (reused, but inlined for clarity) ──────────────────────

function simSiteGame(homeId, awayId, save, userSchoolId, ratings, seedKey) {
  const homeTeam = save.teams[homeId]
  const awayTeam = save.teams[awayId]
  const isUserGame = homeId === userSchoolId || awayId === userSchoolId
  if (isUserGame && homeTeam && awayTeam) {
    const homeLineup = defaultLineup(homeTeam, save.players)
    const awayLineup = defaultLineup(awayTeam, save.players)
    return simGame(homeLineup, awayLineup, {
      homeMotivator: save.coaches[homeTeam.headCoachId]?.motivator ?? 50,
      awayMotivator: save.coaches[awayTeam.headCoachId]?.motivator ?? 50,
      level: save.level || save.schools?.[userSchoolId]?.level || 'NAIA',
    }, seedKey)
  }
  return fastSimGame(
    ratings?.[homeId] ?? { overall_rating: 0, offense_rating: 0, pitching_rating: 0 },
    ratings?.[awayId] ?? { overall_rating: 0, offense_rating: 0, pitching_rating: 0 },
    seedKey,
  )
}

/**
 * Sim a single Opening Round bracket (4 or 5 teams, double-elim).
 * Returns the winner + all games played.
 */
function simBracket(site, save, userSchoolId, ratings, seedBase) {
  const standing = site.teams.map(t => ({ ...t, losses: 0 }))
  const games = []
  let gameIdx = 0

  function playGame(aId, bId, label) {
    const aSeed = standing.find(s => s.id === aId)?.seed ?? 99
    const bSeed = standing.find(s => s.id === bId)?.seed ?? 99
    const homeId = aSeed <= bSeed ? aId : bId
    const awayId = aSeed <= bSeed ? bId : aId
    const result = simSiteGame(homeId, awayId, save, userSchoolId, ratings, `${seedBase}_g${gameIdx++}`)
    const winner = result.homeRuns > result.awayRuns ? homeId : awayId
    const loser = winner === homeId ? awayId : homeId
    standing.find(s => s.id === loser).losses++
    games.push({ homeId, awayId, homeRuns: result.homeRuns, awayRuns: result.awayRuns, winner, label })
    return winner
  }

  const active = () => standing.filter(s => s.losses < 2)

  // Generic double-elim flow
  if (standing.length === 5) {
    // 5-team: seed 4 vs 5 plays first
    const wb45 = playGame(standing[3].id, standing[4].id, '5-team play-in')
    let bracket = [standing[0].id, standing[1].id, standing[2].id, wb45]
    // From here it's effectively a 4-team double-elim
    runFourTeamFlow(bracket, playGame, active, standing)
  } else {
    // 4-team standard double-elim
    runFourTeamFlow(standing.map(s => s.id), playGame, active, standing)
  }

  const champion = active()[0]?.id || null
  return { games, champion }
}

function runFourTeamFlow(fourTeamIds, playGame, active, standing) {
  // WB Round 1: 1v4, 2v3
  const wbR1A = playGame(fourTeamIds[0], fourTeamIds[3], 'WB R1')
  const wbR1B = playGame(fourTeamIds[1], fourTeamIds[2], 'WB R1')
  // LB Round 1: losers of WB R1 face off
  const wbR1ALoser = wbR1A === fourTeamIds[0] ? fourTeamIds[3] : fourTeamIds[0]
  const wbR1BLoser = wbR1B === fourTeamIds[1] ? fourTeamIds[2] : fourTeamIds[1]
  const lbR1 = playGame(wbR1ALoser, wbR1BLoser, 'LB R1')
  // WB Final
  const wbFinal = playGame(wbR1A, wbR1B, 'WB Final')
  const wbFinalLoser = wbFinal === wbR1A ? wbR1B : wbR1A
  // LB Final: WB final loser vs LB R1 winner
  const lbFinal = playGame(wbFinalLoser, lbR1, 'LB Final')
  // Championship: WB winner vs LB winner
  const champA = playGame(wbFinal, lbFinal, 'Championship')
  // If LB team wins, "if necessary" rematch
  if (champA === lbFinal) {
    playGame(wbFinal, lbFinal, 'If-Necessary')
  }
}

/**
 * Simulate all 10 Opening Round sites.
 * @returns {{ sites: Array<{ host: string, teams: any[], games: any[], winner: string }>, winners: string[] }}
 */
export function simOpeningRound(field46, save, ratings, userSchoolId) {
  const sites = buildOpeningRoundSites(field46, save.schools, save.conferences)
  const detailed = sites.map((site, i) => {
    const seedBase = `or_${save.calendar.year}_${i}`
    const { games, champion } = simBracket(site, save, userSchoolId, ratings, seedBase)
    return { ...site, games, winner: champion }
  })
  const winners = detailed.map(s => s.winner).filter(Boolean)
  return { sites: detailed, winners }
}

// ─── Avista NAIA World Series ───────────────────────────────────────────────

/**
 * Sim the World Series at Harris Field, Lewiston, ID.
 *
 * Format used in v1.5:
 *   - Pool A: seeds 1, 3, 5, 7, 9    Pool B: seeds 2, 4, 6, 8, 10
 *   - Round-robin within each pool (each team plays 4 games)
 *   - Top 2 from each pool by W-L (tiebreaker: run diff)
 *   - Single-elim semis (cross-bracketed: A1 vs B2, B1 vs A2)
 *   - Championship game (single-game)
 *
 * Real NAIA WS varies between modified pool and double-elim per year — this
 * v1.5 format is close enough to feel real.
 */
export function simWorldSeries(winners10, save, ratings, userSchoolId) {
  if (winners10.length < 2) return { games: [], champion: winners10[0] || null }

  // Seed by overall rating (already in field order — they were brackets' top seeds)
  const seeded = winners10
    .map(id => ({ id, rating: ratings[id]?.overall_rating ?? 0 }))
    .sort((a, b) => b.rating - a.rating)
    .map((x, i) => ({ ...x, seed: i + 1 }))

  // Split into two pools (odd seeds A, even seeds B)
  const poolA = seeded.filter((_, i) => i % 2 === 0)
  const poolB = seeded.filter((_, i) => i % 2 === 1)

  const games = []

  function playWs(homeId, awayId, label) {
    const result = simSiteGame(homeId, awayId, save, userSchoolId, ratings, `ws_${save.calendar.year}_${label}_${homeId}_${awayId}`)
    const winner = result.homeRuns > result.awayRuns ? homeId : awayId
    games.push({ homeId, awayId, homeRuns: result.homeRuns, awayRuns: result.awayRuns, winner, label })
    return { winner, homeRuns: result.homeRuns, awayRuns: result.awayRuns }
  }

  function runPool(pool, name) {
    const records = pool.reduce((acc, t) => { acc[t.id] = { wins: 0, losses: 0, runDiff: 0 }; return acc }, {})
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const r = playWs(pool[i].id, pool[j].id, `Pool ${name}`)
        const winnerId = r.winner
        const loserId = winnerId === pool[i].id ? pool[j].id : pool[i].id
        records[winnerId].wins++
        records[loserId].losses++
        records[pool[i].id].runDiff += r.homeRuns - r.awayRuns
        records[pool[j].id].runDiff += r.awayRuns - r.homeRuns
      }
    }
    // Top 2
    return pool
      .map(t => ({ ...t, ...records[t.id] }))
      .sort((a, b) => b.wins - a.wins || b.runDiff - a.runDiff)
      .slice(0, 2)
  }

  const topA = runPool(poolA, 'A')
  const topB = runPool(poolB, 'B')

  // Semis: A1 vs B2, B1 vs A2
  const semi1 = playWs(topA[0].id, topB[1].id, 'Semifinal 1')
  const semi2 = playWs(topB[0].id, topA[1].id, 'Semifinal 2')

  // Championship
  const champGame = playWs(semi1.winner, semi2.winner, 'NAIA Championship')

  return {
    games,
    champion: champGame.winner,
    poolA: topA.map(t => t.id),
    poolB: topB.map(t => t.id),
    semis: [semi1.winner, semi2.winner],
  }
}

/**
 * Run the full national tournament: Opening Round WS.
 * @returns {{ field46: string[], openingRound: any, worldSeries: any, nationalChampion: string }}
 */
export function runNationalTournament(autoBids, save, ratings, userSchoolId) {
  const field46 = selectNationalField(autoBids, ratings)
  const openingRound = simOpeningRound(field46, save, ratings, userSchoolId)
  const worldSeries = simWorldSeries(openingRound.winners, save, ratings, userSchoolId)
  return {
    field46,
    openingRound,
    worldSeries,
    nationalChampion: worldSeries.champion,
  }
}
