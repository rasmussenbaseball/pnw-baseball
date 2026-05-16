/**
 * Player academics — GPA, eligibility, study hall.
 *
 * Each player has:
 *   - hidden.academic_aptitude (0-99): drives baseline GPA + risk profile
 *   - gpa: current term GPA (0.0-4.0)
 *   - academicStanding: 'eligible' | 'probation' | 'ineligible' | 'dismissed'
 *
 * Eligibility rules (NAIA Article V — simplified):
 *   GPA ≥ 2.0      eligible
 *   GPA 1.5-1.99   academic probation (eligible but flagged)
 *   GPA < 1.5      ineligible for the next term
 *   GPA < 1.0 OR 2nd consecutive ineligible term dismissed (fails out of school,
 *                                                              transfers, sits out)
 *
 * Study hall mandate: coach AP action that boosts entire roster's GPA next term.
 * Low team GPA hurts the coach's job security.
 */

import { makeRng } from './rng'

/** @typedef {import('./types.js').Player} Player */

/**
 * Initialize a player's academic state at generation time.
 * GPA biased by academic_aptitude (0.5 + aptitude/40 0.5-2.97 baseline) + noise.
 */
export function initialAcademicState(player, rng) {
  const aptitude = player.hidden?.academic_aptitude ?? 60
  // Baseline mapping recalibrated so team-mean GPA at game start lands
  // in the 2.8-3.2 band for typical aptitude distributions:
  //   aptitude 30 ~1.8 GPA, 60 ~2.9, 75 ~3.3, 90 ~3.7
  const baseline = 1.0 + (aptitude / 99) * 2.7
  const gpa = clamp(rng.gaussian(baseline, 0.35), 0.0, 4.0)
  const academicStanding = gpaToStanding(gpa)
  return { gpa: Math.round(gpa * 100) / 100, academicStanding }
}

/**
 * End-of-term GPA update.
 *
 * @param {Player} player
 * @param {{ studyHallBonus: number, coachMotivator: number, budgetEffects: any }} ctx
 *        studyHallBonus — direct cumulative GPA boost applied to every player
 *        (e.g. +0.30 = the term included 6 weeks of regular study hall).
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @returns {Player}
 */
export function updateAcademics(player, ctx, rng) {
  const aptitude = player.hidden?.academic_aptitude ?? 60
  const baseline = 1.0 + (aptitude / 99) * 2.7
  let newGpa = rng.gaussian(baseline, 0.35)
  newGpa += Math.min(0.6, ctx.studyHallBonus || 0)
  if (ctx.coachMotivator) newGpa += (ctx.coachMotivator - 50) / 250
  newGpa = clamp(newGpa, 0.0, 4.0)

  // Track consecutive sub-2.0 semesters. Two in a row triggers dismissal.
  const prevStreak = player.belowTwoStreak || 0
  const newStreak = newGpa < 2.0 ? prevStreak + 1 : 0
  const standing = gpaToStanding(newGpa, newStreak)
  return {
    ...player,
    gpa: Math.round(newGpa * 100) / 100,
    academicStanding: standing,
    belowTwoStreak: newStreak,
  }
}

/**
 * Determine new standing from a GPA, considering the consecutive-sub-2.0
 * streak. Rules (May 2026 per Nate):
 *   - GPA >= 2.25       eligible
 *   - GPA 2.00 - 2.249  probation  (eligible but on warning)
 *   - GPA < 2.00        ineligible (can't play the next semester)
 *   - 2nd consecutive   dismissed  (failed out — auto-cut from roster)
 *     sub-2.0 semester
 *
 * @param {number} gpa
 * @param {number} streak  consecutive sub-2.0 semesters INCLUDING this one
 *                         if gpa < 2.0
 */
function gpaToStanding(gpa, streak = 0) {
  if (gpa < 2.0 && streak >= 2) return 'dismissed'
  if (gpa < 2.0) return 'ineligible'
  if (gpa < 2.25) return 'probation'
  return 'eligible'
}

// Exported for the GPA Tracker UI so the rules display matches the engine
export const GPA_THRESHOLDS = {
  eligible: 2.25,
  probation: 2.0,
  ineligible: 0.0,
  dismissAt: 2,    // consecutive sub-2.0 semesters that trigger dismissal
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

/**
 * Compute team GPA + counts.
 *
 * @param {Player[]} players
 * @returns {{ teamGpa: number, eligible: number, probation: number, ineligible: number, dismissed: number }}
 */
/**
 * Weekly team-GPA dynamics — small per-week drift based on:
 *   - AP utilization the prior week (using all +, sitting on it −)
 *   - Mean team happiness (happy +, upset −)
 *   - Recent W/L proxy via happiness performance signal
 *
 * Skipped during tutorial weeks (1-3) when AP is locked. Stores
 * state._lastTeamGpa + state._currentTeamGpa so the dashboard can show
 * an up/down arrow next to the GPA number.
 *
 * @param {import('./types.js').SaveState} state
 */
export function tickTeamGPAWeekly(state) {
  const wk = state.calendar?.weekOfYear ?? 0
  // GPA only moves during academic semesters. Per Nate (May 2026):
  //   Wks 1-4   summer / preseason no school in session, no GPA change
  //   Wks 5-18  Fall semester (fall camp through first week of Dec)
  //   Wks 19-22 winter break (no classes)
  //   Wks 23-42 Spring semester (January practice through end of season)
  //   Wks 43-52 summer break (no classes)
  const inFallSemester = wk >= 5 && wk <= 18
  const inSpringSemester = wk >= 23 && wk <= 42
  if (!inFallSemester && !inSpringSemester) return
  const team = state.teams?.[state.userSchoolId]
  if (!team) return
  const players = team.rosterPlayerIds.map(id => state.players[id]).filter(Boolean)
  if (players.length === 0) return

  const baseline = state.ap?.baseline ?? 25
  const spent = state._lastWeekApSpent ?? 0
  const apFrac = Math.min(1, spent / Math.max(1, baseline))
  const happyAvg = players.reduce((s, p) => s + (p.happiness?.value ?? 60), 0) / players.length

  // Composite signal — typical range ±0.015 GPA per week
  const happyZ = (happyAvg - 60) / 100     // ~ -0.6 .. +0.4
  const apZ = apFrac - 0.7                  // < 70% spent = negative

  // Aggregate delta per player, plus small per-player noise so distributions
  // breathe without being chaotic.
  const rng = makeRng('gpaWk', state.userSchoolId, state.calendar.year, wk)
  for (const p of players) {
    if (typeof p.gpa !== 'number') continue
    const delta = happyZ * 0.012 + apZ * 0.010 + rng.gaussian(0, 0.006)
    p.gpa = Math.max(0.5, Math.min(4.0, Math.round((p.gpa + delta) * 100) / 100))
  }

  // Snapshot team GPA for arrow display
  const teamGpa = players.reduce((s, p) => s + (p.gpa || 0), 0) / players.length
  state._lastTeamGpa = state._currentTeamGpa ?? teamGpa
  state._currentTeamGpa = Math.round(teamGpa * 100) / 100
}

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
  const studyHallBonus = state.studyHall?.cumulativeBonus ?? 0
  const rng = makeRng('acad', state.userSchoolId, state.calendar.year, state.rngSeed)

  const dismissedPlayers = []
  const newlyIneligible = []

  for (const id of userTeam.rosterPlayerIds) {
    const p = state.players[id]
    if (!p) continue
    const updated = updateAcademics(p, { studyHallBonus, coachMotivator }, rng)
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
      headline: `${d.firstName} ${d.lastName} (${d.classYear}, ${d.primaryPosition}) failed out — academically dismissed.`,
      payload: { playerId: d.id, gpa: d.gpa },
    })
  }
  for (const n of newlyIneligible) {
    state.newsfeed.unshift({
      id: `acad_inelig_${n.id}_${state.calendar.year}`,
      year: state.calendar.year + 1, week: 0,
      type: 'AWARD',
      headline: `${n.firstName} ${n.lastName} (${n.classYear}, ${n.primaryPosition}) is academically INELIGIBLE for next semester (GPA ${n.gpa.toFixed(2)}). Mandate study hall to help recover.`,
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
    headline: `Team GPA: ${summary.teamGpa.toFixed(2)}. ${summary.eligible} eligible, ${summary.probation} probation, ${summary.ineligible} ineligible, ${summary.dismissed} dismissed.`,
    payload: summary,
  })

  // Reset study hall counters for new term
  state.studyHall = { cumulativeBonus: 0 }

  return { summary, dismissedPlayers }
}
