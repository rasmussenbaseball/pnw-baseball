/**
 * Player academics — GPA, eligibility, study hall.
 *
 * Each player has:
 *   - hidden.academic_aptitude (0-99): drives baseline GPA + risk profile
 *   - gpa: current term GPA (0.0-4.0)
 *   - academicStanding: 'eligible' | 'probation' | 'ineligible' | 'dismissed'
 *
 * Eligibility rules (NAIA Article V — simplified):
 *   GPA ≥ 2.0      → eligible
 *   GPA 1.5-1.99   → academic probation (eligible but flagged)
 *   GPA < 1.5      → ineligible for the next term
 *   GPA < 1.0 OR 2nd consecutive ineligible term → dismissed (fails out of school,
 *                                                              transfers, sits out)
 *
 * Study hall mandate: coach AP action that boosts entire roster's GPA next term.
 * Low team GPA hurts the coach's job security.
 */

import { makeRng } from './rng'

/** @typedef {import('./types.js').Player} Player */

/**
 * Initialize a player's academic state at generation time.
 * GPA biased by academic_aptitude (0.5 + aptitude/40 → 0.5-2.97 baseline) + noise.
 */
export function initialAcademicState(player, rng) {
  const aptitude = player.hidden?.academic_aptitude ?? 60
  // Baseline: aptitude 30 → ~1.5 GPA, aptitude 60 → ~2.7, aptitude 90 → ~3.7
  const baseline = 0.5 + (aptitude / 99) * 3.0
  const gpa = clamp(rng.gaussian(baseline, 0.4), 0.0, 4.0)
  const academicStanding = gpaToStanding(gpa)
  return { gpa: Math.round(gpa * 100) / 100, academicStanding }
}

/**
 * End-of-term GPA update. Influenced by:
 *   - Player academic aptitude (baseline)
 *   - Cumulative study hall weeks (each week active = +0.025 GPA, max +0.35)
 *   - Coach motivator (small effect)
 *   - Random per-term variance (±0.4)
 *
 * @param {Player} player
 * @param {{ studyHallWeeks: number, coachMotivator: number, budgetEffects: any }} ctx
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @returns {Player}
 */
export function updateAcademics(player, ctx, rng) {
  const aptitude = player.hidden?.academic_aptitude ?? 60
  const baseline = 0.5 + (aptitude / 99) * 3.0
  let newGpa = rng.gaussian(baseline, 0.45)
  const studyHallWeeks = ctx.studyHallWeeks || 0
  newGpa += Math.min(0.35, studyHallWeeks * 0.025)
  if (ctx.coachMotivator) newGpa += (ctx.coachMotivator - 50) / 250    // ±0.2
  newGpa = clamp(newGpa, 0.0, 4.0)

  const standing = gpaToStanding(newGpa, player.academicStanding)
  return {
    ...player,
    gpa: Math.round(newGpa * 100) / 100,
    academicStanding: standing,
  }
}

/**
 * Determine new standing from a GPA, considering previous standing.
 */
function gpaToStanding(gpa, prev) {
  if (gpa < 1.0) return 'dismissed'
  if (gpa < 1.5) {
    // 2nd consecutive ineligible term → dismissed
    if (prev === 'ineligible') return 'dismissed'
    return 'ineligible'
  }
  if (gpa < 2.0) return 'probation'
  return 'eligible'
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

/**
 * Compute team GPA + counts.
 *
 * @param {Player[]} players
 * @returns {{ teamGpa: number, eligible: number, probation: number, ineligible: number, dismissed: number }}
 */
export function teamAcademicSummary(players) {
  if (players.length === 0) return { teamGpa: 0, eligible: 0, probation: 0, ineligible: 0, dismissed: 0 }
  let total = 0
  const counts = { eligible: 0, probation: 0, ineligible: 0, dismissed: 0 }
  for (const p of players) {
    total += p.gpa || 0
    counts[p.academicStanding || 'eligible']++
  }
  return {
    teamGpa: Math.round((total / players.length) * 100) / 100,
    ...counts,
  }
}

/**
 * Run end-of-term academics for the user's team. Tracks study hall flag,
 * generates news for dismissed/ineligible players, and returns a summary.
 *
 * @param {import('./types.js').SaveState} state
 * @returns {{ summary: any, dismissedPlayers: Player[] }}
 */
export function runEndOfTermAcademics(state) {
  const userTeam = state.teams[state.userSchoolId]
  if (!userTeam) return { summary: null, dismissedPlayers: [] }
  const hc = state.coaches[userTeam.headCoachId]
  const coachMotivator = hc?.motivator ?? 50
  const studyHallWeeks = state.studyHall?.weeksActive ?? 0
  const rng = makeRng('acad', state.userSchoolId, state.calendar.year, state.rngSeed)

  const dismissedPlayers = []
  const newlyIneligible = []

  for (const id of userTeam.rosterPlayerIds) {
    const p = state.players[id]
    if (!p) continue
    const updated = updateAcademics(p, { studyHallWeeks, coachMotivator }, rng)
    if (updated.academicStanding === 'dismissed') dismissedPlayers.push(updated)
    if (updated.academicStanding === 'ineligible' && p.academicStanding !== 'ineligible') {
      newlyIneligible.push(updated)
    }
    state.players[id] = updated
  }

  // Remove dismissed players from active roster
  if (dismissedPlayers.length > 0) {
    const ids = new Set(dismissedPlayers.map(d => d.id))
    userTeam.rosterPlayerIds = userTeam.rosterPlayerIds.filter(x => !ids.has(x))
  }

  // News
  for (const d of dismissedPlayers) {
    state.newsfeed.unshift({
      id: `acad_dismiss_${d.id}_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 0,
      type: 'AWARD',
      headline: `📚❌ ${d.firstName} ${d.lastName} (${d.classYear}, ${d.primaryPosition}) failed out — academically dismissed.`,
      payload: { playerId: d.id, gpa: d.gpa },
    })
  }
  for (const n of newlyIneligible) {
    state.newsfeed.unshift({
      id: `acad_inelig_${n.id}_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 0,
      type: 'AWARD',
      headline: `⚠️ ${n.firstName} ${n.lastName} (${n.classYear}, ${n.primaryPosition}) is academically INELIGIBLE for next semester (GPA ${n.gpa.toFixed(2)}). Mandate study hall to help recover.`,
      payload: { playerId: n.id, gpa: n.gpa },
    })
  }

  // Team summary
  const roster = userTeam.rosterPlayerIds.map(id => state.players[id]).filter(Boolean)
  const summary = teamAcademicSummary(roster)
  state.newsfeed.unshift({
    id: `acad_summary_${state.calendar.year}`,
    year: state.calendar.year + 1, week: 0,
    type: 'AWARD',
    headline: `📚 Team GPA: ${summary.teamGpa.toFixed(2)}. ${summary.eligible} eligible, ${summary.probation} probation, ${summary.ineligible} ineligible, ${summary.dismissed} dismissed.`,
    payload: summary,
  })

  // Reset study hall counters for new term
  state.studyHall = { active: false, weeksActive: 0 }

  return { summary, dismissedPlayers }
}
