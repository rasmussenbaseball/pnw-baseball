/**
 * Conference tournament simulator.
 *
 * Generates a bracket per conference based on the conference's tournament
 * format in conference_rules.json. Sims the full bracket (full-fidelity if
 * user's team is in it; fast sim otherwise). Returns:
 *   - the final bracket with all results
 *   - the auto-bid recipient(s)
 *
 * v1.5 supports:
 *   - 4dxe, 5dxe, 6dxe, 8dxe (N-team double-elim)
 *   - All others fall back to 4dxe for now (real formats land in v2)
 */

import { simGame, fastSimGame, defaultLineup } from './sim'
import { seedFromPear, computeFromSeason } from './rankings'
import confRulesRaw from '../data/conference_rules.json'

/** @typedef {import('./types.js').SaveState} SaveState */

/** @typedef BracketGame
 *  @property {string} id
 *  @property {number} round              // 1+ (winners-bracket rounds); negative numbers for losers bracket
 *  @property {string|null} homeId        // null = TBD
 *  @property {string|null} awayId
 *  @property {number|null} homeRuns
 *  @property {number|null} awayRuns
 *  @property {boolean} played
 *  @property {string|null} winner        // schoolId of winner
 *  @property {string} label              // human-readable, e.g. "WB-Round 1, Game 2"
 */

/**
 * Sim a single tournament game.
 */
function simTourneyGame(homeId, awayId, save, userSchoolId, ratings, seedKey) {
  const homeTeam = save.teams[homeId]
  const awayTeam = save.teams[awayId]
  const userIsHome = homeId === userSchoolId
  const userIsAway = awayId === userSchoolId
  if ((userIsHome || userIsAway) && homeTeam && awayTeam) {
    const homeLineup = defaultLineup(homeTeam, save.players)
    const awayLineup = defaultLineup(awayTeam, save.players)
    const homeHC = save.coaches[homeTeam.headCoachId]
    const awayHC = save.coaches[awayTeam.headCoachId]
    return simGame(homeLineup, awayLineup, {
      homeMotivator: homeHC?.motivator ?? 50,
      awayMotivator: awayHC?.motivator ?? 50,
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
 * Standings within a conference, sorted for tournament seeding.
 */
function standingsForConf(save, conferenceId) {
  const teams = save.conferences[conferenceId].schoolIds
    .map(id => ({ schoolId: id, team: save.teams[id] }))
    .filter(x => x.team)
  return teams.sort((a, b) => {
    if (a.team.confWins !== b.team.confWins) return b.team.confWins - a.team.confWins
    if (a.team.confLosses !== b.team.confLosses) return a.team.confLosses - b.team.confLosses
    return b.team.runDiff - a.team.runDiff
  })
}

/**
 * Pick the top N teams from a conference for the tournament.
 * Returns [{schoolId, seed (1-indexed)}].
 */
function selectQualifyingTeams(save, conferenceId, n) {
  const standings = standingsForConf(save, conferenceId)
  return standings.slice(0, n).map((s, i) => ({ schoolId: s.schoolId, seed: i + 1 }))
}

/**
 * Generic N-team double-elim simulator.
 *
 * Bracket layout (5-team example):
 *   Round 1 WB: (4) vs (5)    [single game; loser to LB elimination]
 *   Round 2 WB: Winner vs (1); (2) vs (3)
 *   Round 3 WB: WB final (winners advance, loser to LB)
 *   LB: ... (modified for 5-team — see code)
 *   Final: WB winner vs LB winner; if LB wins, "if necessary" game
 *
 * For simplicity in v1.5: we sim the bracket as a series of single games
 * with proper double-elim flow (lose twice = eliminated). Real-world
 * tournaments often have if-necessary games; we handle those.
 */
function simDoubleElim(qualifiers, save, userSchoolId, ratings, seedBase) {
  if (qualifiers.length < 2) return { games: [], winner: qualifiers[0]?.schoolId || null, autoBids: [] }

  // Each team tracks: schoolId, losses (0, 1, eliminated at 2)
  const standing = qualifiers.map(q => ({ ...q, losses: 0 }))
  /** @type {BracketGame[]} */
  const games = []
  let gameIdx = 0

  // Helper: simulate a game between two teams, push to games[], update losses
  function playGame(a, b, round, label) {
    if (!a || !b) return null
    // Higher seed hosts
    const aSeed = standing.find(s => s.schoolId === a)?.seed ?? 99
    const bSeed = standing.find(s => s.schoolId === b)?.seed ?? 99
    const homeId = aSeed <= bSeed ? a : b
    const awayId = aSeed <= bSeed ? b : a
    const result = simTourneyGame(homeId, awayId, save, userSchoolId, ratings, `${seedBase}_g${gameIdx++}`)
    const winner = result.homeRuns > result.awayRuns ? homeId : awayId
    const loser = winner === homeId ? awayId : homeId
    const loserStanding = standing.find(s => s.schoolId === loser)
    if (loserStanding) loserStanding.losses++
    games.push({
      id: `bg_${gameIdx}`,
      round,
      homeId, awayId,
      homeRuns: result.homeRuns, awayRuns: result.awayRuns,
      played: true,
      winner,
      label,
    })
    return winner
  }

  // Active teams = not yet eliminated
  function active() {
    return standing.filter(s => s.losses < 2)
  }

  // Run the WINNERS BRACKET — we pair top vs bottom seeds and advance winners
  // This is a simplified flow; works for 4/5/6/8-team brackets.
  let wbActive = [...standing]   // ordered by seed ascending

  // Special handling for 5-team: seeds 4 and 5 play first, winner faces 1
  if (wbActive.length === 5) {
    const winner4v5 = playGame(wbActive[3].schoolId, wbActive[4].schoolId, 1, 'WB R1 (4 vs 5)')
    wbActive = [wbActive[0], wbActive[1], wbActive[2], standing.find(s => s.schoolId === winner4v5)].filter(s => s && s.losses < 2)
  }

  // Now standard pairing: 1v4, 2v3 (or 1v3 + 2-bye for odd brackets)
  let wbRound = wbActive.length === 5 ? 2 : 1
  while (active().length > 1) {
    const liveTeams = active().filter(t => wbActive.find(w => w.schoolId === t.schoolId))
    if (liveTeams.length === 1) break
    if (liveTeams.length === 0) break

    const newWB = []
    const teams = liveTeams.sort((a, b) => a.seed - b.seed)
    if (teams.length === 1) { newWB.push(teams[0]); break }

    // Pair high vs low
    for (let i = 0; i < Math.floor(teams.length / 2); i++) {
      const a = teams[i]
      const b = teams[teams.length - 1 - i]
      const winner = playGame(a.schoolId, b.schoolId, wbRound, `WB R${wbRound}`)
      newWB.push(standing.find(s => s.schoolId === winner))
    }
    if (teams.length % 2 === 1) {
      newWB.push(teams[Math.floor(teams.length / 2)])
    }
    wbActive = newWB
    wbRound++

    // LB elimination round — every team with 1 loss faces another team with 1 loss
    const oneLossers = active().filter(t => !wbActive.find(w => w.schoolId === t.schoolId))
    if (oneLossers.length >= 2) {
      const sortedLB = [...oneLossers].sort((a, b) => a.seed - b.seed)
      for (let i = 0; i < Math.floor(sortedLB.length / 2); i++) {
        playGame(sortedLB[i].schoolId, sortedLB[sortedLB.length - 1 - i].schoolId, -wbRound, `LB R${wbRound}`)
      }
    }

    // Safety: bail if we're going forever
    if (wbRound > 20) break
  }

  // Final: best remaining from WB vs LB
  while (active().length > 1) {
    const ordered = active().sort((a, b) => a.losses - b.losses || a.seed - b.seed)
    const winner = playGame(ordered[0].schoolId, ordered[1].schoolId, 99, 'Championship')
    if (winner === ordered[1].schoolId) {
      // The LB team won — "if necessary" rematch
      const winner2 = playGame(ordered[0].schoolId, ordered[1].schoolId, 100, 'If-Necessary')
    }
  }

  const finalWinner = active()[0]?.schoolId || null

  return {
    games,
    winner: finalWinner,
    qualifiers,
  }
}

/**
 * Sim a conference tournament for one conference.
 *
 * @param {string} conferenceId
 * @param {SaveState} save
 * @param {Object<string,any>} ratings  team ratings for fast sim
 * @param {string} userSchoolId
 * @returns {{
 *   conferenceId: string,
 *   qualifiers: Array<{ schoolId: string, seed: number }>,
 *   games: BracketGame[],
 *   champion: string | null,
 *   regSeasonChamp: string,
 *   autoBids: string[],
 * }}
 */
export function simConferenceTournament(conferenceId, save, ratings, userSchoolId) {
  const rules = (confRulesRaw.tournamentRules || {})[conferenceId] || { qualifying: 4, autoBids: 1, format: '4dxe' }
  const qualifying = rules.qualifying || 4
  const qualifiers = selectQualifyingTeams(save, conferenceId, qualifying)
  if (qualifiers.length === 0) {
    return { conferenceId, qualifiers: [], games: [], champion: null, regSeasonChamp: null, autoBids: [] }
  }
  const regSeasonChamp = qualifiers[0].schoolId

  const seedBase = `tourney_${save.calendar.year}_${conferenceId}`
  const bracket = simDoubleElim(qualifiers, save, userSchoolId, ratings, seedBase)

  // Auto-bids: champion + (if rules.autoBids === 2) reg-season champ (or runner-up)
  const autoBids = [bracket.winner].filter(Boolean)
  if (rules.autoBids >= 2 && regSeasonChamp && !autoBids.includes(regSeasonChamp)) {
    autoBids.push(regSeasonChamp)
  } else if (rules.autoBids >= 2 && autoBids.length < 2) {
    // Find a second bid — the team that lost in the championship game
    const champGame = bracket.games.find(g => g.label === 'Championship' || g.label === 'If-Necessary')
    if (champGame) {
      const runnerUp = champGame.winner === champGame.homeId ? champGame.awayId : champGame.homeId
      if (runnerUp && !autoBids.includes(runnerUp)) autoBids.push(runnerUp)
    }
  }

  return {
    conferenceId,
    qualifiers,
    games: bracket.games,
    champion: bracket.winner,
    regSeasonChamp,
    autoBids,
  }
}

/**
 * Sim all 21 conference tournaments.
 * @returns {Array<ReturnType<simConferenceTournament>>}
 */
export function simAllConferenceTournaments(save, ratings, userSchoolId) {
  const out = []
  for (const confId of Object.keys(save.conferences)) {
    out.push(simConferenceTournament(confId, save, ratings, userSchoolId))
  }
  return out
}
