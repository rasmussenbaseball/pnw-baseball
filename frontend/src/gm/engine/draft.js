/**
 * MLB Draft simulation — runs each July, after the NAIA World Series.
 *
 * Real-world reference: roughly 5–12 NAIA players get picked across the 20-round
 * MLB draft each summer. ~85% of those picks are pitchers (raw arms are what
 * pro orgs hunt at the NAIA level — bats face a quality-of-competition
 * skepticism). CCC typically lands 1–2, sometimes 0, occasionally 3–4.
 *
 * Eligibility: SR class (post-junior year if they returned), or JRs who
 * declared. We approximate by treating SR-and-above + JRs with high OVR
 * as the draft-eligible pool. Graduated players are also surfaced (their
 * SR season just finished).
 */

import { makeRng } from './rng'
import { playerOverall } from './playerRating'

/** Probability that a pitcher gets picked at any given pick (vs hitter). */
const PITCHER_BIAS = 0.85

/**
 * Simulate the MLB draft for a single year. Returns the picks (sorted by
 * round). Does NOT mutate state — caller decides whether to store on
 * state.draftResults[year] and which newsfeed lines to surface.
 *
 * @param {import('./types.js').SaveState} state
 * @param {number} year   draft year (e.g. 2027)
 * @returns {Array<{
 *   playerId: string,
 *   name: string,
 *   pos: string,
 *   isPitcher: boolean,
 *   ovr: number,
 *   teamId: string,
 *   teamName: string,
 *   conferenceId: string,
 *   round: number,
 *   pickInRound: number,
 *   overall: number,
 * }>}
 */
export function simMlbDraft(state, year) {
  const rng = makeRng('draft', year, state.rngSeed)

  // Build the draft-eligible pool: SRs across every NAIA team + JR standouts
  // (juniors with OVR ≥ 78 are the rare draft-eligible junior class).
  const pool = []
  for (const teamId of Object.keys(state.teams)) {
    const team = state.teams[teamId]
    const school = state.schools[teamId]
    if (!school) continue
    for (const pid of team.rosterPlayerIds) {
      const p = state.players[pid]
      if (!p) continue
      const ovr = playerOverall(p)
      const isSenior = p.classYear === 'SR' || p.eligibilityStatus === 'graduated'
      const isJrStandout = p.classYear === 'JR' && ovr >= 78
      if (!isSenior && !isJrStandout) continue
      // Summer-ball draft buzz — if the player came back from a high-prestige
      // summer league with positive growth, their effective OVR for the draft
      // gets a small bump. Set by resolveSummerBall() in the same year, so
      // we only honor buzz tagged with the current dynasty year.
      const buzz = (p._summerDraftBuzz && p._summerDraftBuzz.year === year)
        ? p._summerDraftBuzz : null
      const effectiveOvr = buzz ? Math.round(ovr * buzz.mult) : ovr
      pool.push({
        playerId: p.id,
        name: `${p.firstName} ${p.lastName}`,
        pos: p.isPitcher ? 'P' : p.primaryPosition,
        isPitcher: !!p.isPitcher,
        ovr: effectiveOvr,
        rawOvr: ovr,
        summerBuzz: !!buzz,
        teamId,
        teamName: school.name,
        conferenceId: school.conferenceId,
      })
    }
  }
  if (pool.length === 0) return []

  // Sort by OVR with a pitcher bias bump — pitchers with comparable OVR get
  // looked at first because pro orgs love NAIA arms.
  pool.sort((a, b) => {
    const aScore = a.ovr + (a.isPitcher ? 3 : 0)
    const bScore = b.ovr + (b.isPitcher ? 3 : 0)
    return bScore - aScore
  })

  // Total picks for the year: 5–12, weighted toward the middle (8 most common).
  const totalPicks = rng.weighted(
    [5, 6, 7, 8, 9, 10, 11, 12],
    [1, 2, 3, 4, 4, 3, 2, 1],
  )

  const picks = []
  const usedIds = new Set()
  // Spread across 20 rounds. Higher-OVR picks go earlier.
  for (let i = 0; i < totalPicks; i++) {
    const wantPitcher = rng.chance(PITCHER_BIAS)
    // Try to find the highest-rated remaining candidate matching the role
    // preference. Fall back to any role if none left.
    let idx = pool.findIndex(c => !usedIds.has(c.playerId) && c.isPitcher === wantPitcher)
    if (idx < 0) idx = pool.findIndex(c => !usedIds.has(c.playerId))
    if (idx < 0) break
    const c = pool[idx]
    usedIds.add(c.playerId)

    // Distribute picks across 20 rounds: pick #1 round 1, last pick round 20.
    const round = Math.max(1, Math.min(20, Math.round(1 + (i / Math.max(1, totalPicks - 1)) * 19)))
    picks.push({
      ...c,
      round,
      pickInRound: i + 1,
      overall: 30 * (round - 1) + (i + 1),    // ~30 teams per round in MLB
    })
  }

  return picks
}

/**
 * Format a one-line draft summary for the newsfeed. e.g.:
 *   "MLB Draft: 8 NAIA players picked — 6 P, 2 hitters. 2 from CCC."
 */
export function summarizeDraft(picks, userConferenceId, level = 'NAIA') {
  const lbl = (level && level !== 'NAIA') ? level : 'NAIA'
  if (!picks || picks.length === 0) return `0 ${lbl} players selected in this year's MLB Draft.`
  const pitchers = picks.filter(p => p.isPitcher).length
  const hitters = picks.length - pitchers
  const confCount = userConferenceId
    ? picks.filter(p => p.conferenceId === userConferenceId).length
    : 0
  let s = `MLB Draft: ${picks.length} ${lbl} player${picks.length === 1 ? '' : 's'} picked — ${pitchers} P, ${hitters} hitter${hitters === 1 ? '' : 's'}.`
  if (confCount > 0) s += ` ${confCount} from your conference.`
  return s
}
