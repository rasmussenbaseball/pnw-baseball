/**
 * Postseason awards — All-Conference 1st & 2nd team, Gold Glove team.
 *
 * Trigger: end of regular season (Wk 39 → 40 transition), per-conference.
 * The user's conference is the focus for the UI; awards are still computed
 * for the other conferences (lightweight enough) so cross-conference player
 * pages can show "All-CCC 1st team 2027" badges.
 *
 * Selection rules:
 *   All-Conference 1st team: top WAR at each position (8 + 5 P)
 *                           catcher + 4 IF (1B/2B/SS/3B) + 3 OF + DH + 5 P
 *   All-Conference 2nd team: next-best at each position
 *   Gold Glove:              best fielding rating per position (qualified)
 *
 * Qualifying gates:
 *   Hitters: at least 80 PA across the regular season
 *   Pitchers: at least 30 IP
 *   (Lower than the real-world NCAA cutoffs because NAIA seasons are ~55 G,
 *    not 65; and bullpen arms otherwise wouldn't qualify.)
 */

import { synthesizeConferenceStats, buildTeamSynthesisContext, synthesizeSeasonStats } from './leagueStats'
import { leagueAverages, computeBatting, computePitching } from './advancedStats'

const HITTER_POSITIONS = ['C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF', 'DH']
const MIN_PA = 80
const MIN_IP = 30
const PITCHERS_PER_TEAM = 5    // 4 SP + 1 RP for All-Conference

/**
 * Compute and store all-conference + gold glove for every conference. Called
 * from end of regular season.
 *
 * Stores results in state.awardsHistory[year][conferenceId] = {
 *   firstTeam: [...], secondTeam: [...], goldGlove: [...]
 * }
 *
 * Each entry has { playerId, position, teamId, war, stats, schoolName, playerName }.
 */
export function runEndOfRegularSeasonAwards(state) {
  const year = state.calendar?.year
  if (!year) return
  if (!state.awardsHistory) state.awardsHistory = {}
  if (state.awardsHistory[year]) return   // idempotent — don't double-award

  const seed = state.seed || state.rngSeed || 1
  state.awardsHistory[year] = {}

  for (const conferenceId of Object.keys(state.conferences || {})) {
    const result = computeConferenceAwards(state, conferenceId, year, seed)
    if (!result) continue
    state.awardsHistory[year][conferenceId] = result

    // Newsfeed entries — only for the user's conference. Other confs get
    // computed silently so player pages can show badges retroactively.
    const userConfId = state.schools?.[state.userSchoolId]?.conferenceId
    if (conferenceId === userConfId) {
      const conf = state.conferences[conferenceId]
      const userTeamId = state.userSchoolId
      const userOnFirst = result.firstTeam.filter(p => p.teamId === userTeamId)
      const userOnSecond = result.secondTeam.filter(p => p.teamId === userTeamId)
      const userOnGG = result.goldGlove.filter(p => p.teamId === userTeamId)
      const totalUser = userOnFirst.length + userOnSecond.length + userOnGG.length
      state.newsfeed.unshift({
        id: `awards_${conferenceId}_${year}`,
        year, week: 40, type: 'AWARD',
        headline: `All-${conf.abbreviation || 'Conference'} teams announced — ${totalUser} of your players honored. Check the Awards page.`,
        payload: { conferenceId, year },
        big: totalUser > 0,
      })
      for (const p of userOnFirst) {
        state.newsfeed.unshift({
          id: `award_first_${p.playerId}_${year}`,
          year, week: 40, type: 'AWARD',
          headline: `${p.playerName} (${p.position}) named All-${conf.abbreviation || 'Conf'} FIRST team.`,
          payload: { playerId: p.playerId, year, kind: 'first' },
        })
      }
    }
  }
}

/**
 * Single-conference award computation. Returns { firstTeam, secondTeam, goldGlove }
 * or null if the conference is empty.
 */
function computeConferenceAwards(state, conferenceId, year, seed) {
  const conf = state.conferences[conferenceId]
  if (!conf || !conf.schoolIds || conf.schoolIds.length === 0) return null

  // Build a stat map covering every player on every conf team. For the user's
  // school we use REAL playerStats; everyone else is synthesized.
  const stats = synthesizeConferenceStats(state, conferenceId, year, seed)
  const lg = leagueAverages({ playerStats: stats })

  // Collect every qualifying hitter/pitcher with their team + position
  const hitters = []
  const pitchers = []
  for (const teamId of conf.schoolIds) {
    const team = state.teams?.[teamId]
    const school = state.schools?.[teamId]
    if (!team || !school) continue
    for (const pid of (team.rosterPlayerIds || [])) {
      const player = state.players?.[pid]
      if (!player) continue
      if (player.eligibilityStatus === 'cut' || player.eligibilityStatus === 'dismissed') continue
      if (player.isPitcher) {
        const row = stats[`p_${pid}`]
        if (!row) continue
        if ((row.ip || 0) < MIN_IP) continue
        const adv = computePitching(row, lg)
        pitchers.push({
          playerId: pid,
          playerName: `${player.firstName} ${player.lastName}`,
          position: 'P',
          teamId,
          schoolName: school.name,
          stats: row,
          war: adv.pWAR,
          fielding: player.hitter?.fielding ?? 50,
        })
      } else {
        const row = stats[`b_${pid}`]
        if (!row) continue
        if ((row.pa || 0) < MIN_PA) continue
        const adv = computeBatting(row, lg)
        hitters.push({
          playerId: pid,
          playerName: `${player.firstName} ${player.lastName}`,
          position: player.primaryPosition,
          teamId,
          schoolName: school.name,
          stats: row,
          war: adv.oWAR,
          fielding: player.hitter?.fielding ?? 50,
          arm: player.hitter?.arm ?? 50,
        })
      }
    }
  }

  // ── All-Conference 1st team: top WAR per position ─────────────────────
  // Position eligibility: a player at C only competes for the C slot, IFs
  // for their listed IF slot, OFs for theirs. DH slot gets the next-best
  // remaining bat that hasn't already been picked.
  const used = new Set()
  const firstTeam = []
  const secondTeam = []

  for (const pos of HITTER_POSITIONS) {
    // DH eligibility — fall back to remaining best hitter (not yet picked)
    const pool = pos === 'DH'
      ? hitters.filter(h => !used.has(h.playerId)).sort((a, b) => b.war - a.war)
      : hitters.filter(h => h.position === pos).sort((a, b) => b.war - a.war)
    if (pool[0]) {
      firstTeam.push(pool[0])
      used.add(pool[0].playerId)
    }
  }
  // Pitchers — top 5 by WAR
  const pitcherPool = pitchers.slice().sort((a, b) => b.war - a.war)
  for (let i = 0; i < PITCHERS_PER_TEAM && i < pitcherPool.length; i++) {
    firstTeam.push(pitcherPool[i])
    used.add(pitcherPool[i].playerId)
  }

  // Second team — next-best at each position not already on the first team
  for (const pos of HITTER_POSITIONS) {
    const pool = pos === 'DH'
      ? hitters.filter(h => !used.has(h.playerId)).sort((a, b) => b.war - a.war)
      : hitters.filter(h => h.position === pos && !used.has(h.playerId)).sort((a, b) => b.war - a.war)
    if (pool[0]) {
      secondTeam.push(pool[0])
      used.add(pool[0].playerId)
    }
  }
  for (let i = 0; i < PITCHERS_PER_TEAM; i++) {
    const next = pitcherPool.find(p => !used.has(p.playerId))
    if (!next) break
    secondTeam.push(next)
    used.add(next.playerId)
  }

  // ── Gold Glove: best fielding rating per defensive position ───────────
  // Catcher + 4 IF + 3 OF + 1 P. Pitchers use their hitter.fielding fallback
  // since pitchers don't have a separate fielding rating in this engine
  // (we treat their team's overall defense + pickoff stuff implicit). For
  // simplicity, P gold glove uses the pitcher with highest stuff among
  // qualified arms.
  const goldGlove = []
  const ggUsed = new Set()
  for (const pos of ['C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF']) {
    const pool = hitters.filter(h => h.position === pos && !ggUsed.has(h.playerId))
      .sort((a, b) => b.fielding - a.fielding || b.arm - a.arm)
    if (pool[0]) {
      goldGlove.push({ ...pool[0], _ggPos: pos, _category: 'GOLD_GLOVE' })
      ggUsed.add(pool[0].playerId)
    }
  }
  // Pitcher gold glove — use the pitcher whose team's defense supports them
  // most (best ERA-FIP gap, simplest proxy: lowest ERA among qualified).
  const ggPitcher = pitcherPool.length > 0
    ? [...pitcherPool].sort((a, b) => {
        const aEra = (a.stats.er * 9) / Math.max(0.1, a.stats.ip)
        const bEra = (b.stats.er * 9) / Math.max(0.1, b.stats.ip)
        return aEra - bEra
      })[0]
    : null
  if (ggPitcher) goldGlove.push({ ...ggPitcher, _ggPos: 'P', _category: 'GOLD_GLOVE' })

  return { firstTeam, secondTeam, goldGlove }
}
