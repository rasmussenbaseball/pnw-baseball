/**
 * Player happiness — tracks morale per player, drives transfer risk, GPA drift,
 * and small stat trends. Inputs: playing time vs expectation, performance,
 * coach motivator, and recent 1-on-1 meeting boosts.
 *
 * Smoothing: weekly value moves only 30% of the way toward its target each
 * tick, so trends emerge over 3–5 weeks instead of swinging from one game.
 *
 *   0–29  UPSET     (transfer risk, GPA + stats drift down)
 *  30–44  UNSURE
 *  45–64  NEUTRAL
 *  65–79  HAPPY     (GPA + stats drift up slightly)
 *  80–100 ECSTATIC
 */

import { playerOverall } from './playerRating'

export const HAPPINESS_LEVELS = ['UPSET', 'UNSURE', 'NEUTRAL', 'HAPPY', 'ECSTATIC']

export function happinessLevel(value) {
  if (value >= 80) return 'ECSTATIC'
  if (value >= 65) return 'HAPPY'
  if (value >= 45) return 'NEUTRAL'
  if (value >= 30) return 'UNSURE'
  return 'UPSET'
}

export const HAPPINESS_DISPLAY = {
  ECSTATIC: { label: 'Ecstatic', emoji: '😄', color: 'text-green-700',  bg: 'bg-green-100' },
  HAPPY:    { label: 'Happy',    emoji: '🙂', color: 'text-pnw-green',  bg: 'bg-pnw-cream' },
  NEUTRAL:  { label: 'Neutral',  emoji: '😐', color: 'text-gray-700',   bg: 'bg-gray-100' },
  UNSURE:   { label: 'Unsure',   emoji: '😕', color: 'text-amber-700',  bg: 'bg-amber-100' },
  UPSET:    { label: 'Upset',    emoji: '😠', color: 'text-red-700',    bg: 'bg-red-100' },
}

const SMOOTHING = 0.30        // 30% toward target each week
const INITIAL_VALUE = 60      // slight happy lean on a fresh dynasty

export function ensureHappiness(p) {
  if (!p.happiness) p.happiness = { value: INITIAL_VALUE, lastWeek: INITIAL_VALUE, coachBoost: null }
  return p.happiness
}

/** Expected playing time fraction (0–1) given roster rank within role group and class. */
function expectedPTFraction(rankInGroup, classYear) {
  // Top of the depth chart expects to play. Backups don't — except seniors
  // (last shot at PT) and except for established veterans who pay close
  // attention to where they sit.
  let base
  if (rankInGroup === 0) base = 0.85
  else if (rankInGroup === 1) base = 0.70
  else if (rankInGroup === 2) base = 0.55
  else if (rankInGroup === 3) base = 0.35
  else if (rankInGroup <= 5) base = 0.20
  else base = 0.08
  if (classYear === 'SR') base += 0.10
  else if (classYear === 'FR') base -= 0.05
  return Math.max(0.05, Math.min(0.95, base))
}

/** Actual playing time fraction this season — PA for hitters, IP for pitchers. */
function actualPTFraction(player, teamMaxPA, teamMaxIP, stats) {
  if (player.isPitcher) {
    if (!stats || !teamMaxIP) return 0
    return Math.min(1, (stats.outs / 3) / teamMaxIP)
  }
  if (!stats || !teamMaxPA) return 0
  return Math.min(1, stats.pa / teamMaxPA)
}

/**
 * Compute league-average OBP + ERA from the season's accumulated playerStats.
 * Used as the "performing at NAIA-average" baseline for happiness.
 *
 * Falls back to NAIA-typical defaults (OBP ~.380, ERA ~5.50) when there's not
 * enough sample yet — NAIA averages run noticeably higher than D1 or MLB.
 *
 * @param {import('./types.js').SaveState} state
 */
export function computeLeagueAverages(state) {
  let h = 0, bb = 0, hbp = 0, pa = 0
  let er = 0, outs = 0
  const stats = state.playerStats || {}
  for (const k of Object.keys(stats)) {
    const s = stats[k]
    if (s.isPitcher) {
      er += s.er || 0
      outs += s.outs || 0
    } else {
      h += s.h || 0
      bb += s.bb || 0
      hbp += s.hbp || 0
      pa += s.pa || 0
    }
  }
  const NAIA_DEFAULT_OBP = 0.380
  const NAIA_DEFAULT_ERA = 5.50
  const ip = outs / 3
  const obp = pa >= 500 ? (h + bb + hbp) / pa : NAIA_DEFAULT_OBP
  const era = ip >= 200 ? (er * 9) / ip : NAIA_DEFAULT_ERA
  return { obp, era }
}

/** Performance vs league-average baseline (computed per save). ±15 cap. */
function performanceDelta(player, stats, leagueAvg) {
  if (!stats) return 0
  if (player.isPitcher) {
    const ip = stats.outs / 3
    if (ip < 3) return 0
    const era = (stats.er * 9) / Math.max(1, ip)
    // At league avg → 0. 2.00 lower → +15. 2.00 higher → -15.
    return Math.max(-15, Math.min(15, (leagueAvg.era - era) * 7.5))
  }
  if (stats.pa < 15) return 0
  const obp = (stats.h + stats.bb + (stats.hbp || 0)) / Math.max(1, stats.pa)
  // At league avg → 0. .080 higher → +15. .080 lower → -15.
  return Math.max(-15, Math.min(15, (obp - leagueAvg.obp) * 188))
}

/** Compute target happiness for one player given full team context. */
export function computeHappinessTarget(player, ctx) {
  const stats = ctx.statsByPlayerId[player.id]
  let target = 50

  // Playing time vs expectation
  const isPitcher = player.isPitcher
  const group = ctx.teamPlayers
    .filter(q => q.isPitcher === isPitcher)
    .sort((a, b) => playerOverall(b) - playerOverall(a))
  const rankInGroup = group.findIndex(q => q.id === player.id)
  const expected = expectedPTFraction(rankInGroup, player.classYear)
  const actual = actualPTFraction(player, ctx.teamMaxPA, ctx.teamMaxIP, stats)
  let ptDelta = (actual - expected) * 30   // ±~25

  // Bad players don't expect to play, so they aren't crushed by sitting.
  // Cap their downside at -3 instead of full delta.
  const ovr = playerOverall(player)
  if (ptDelta < 0 && ovr < 55) ptDelta = Math.max(-3, ptDelta * 0.25)
  // Seniors not playing → last shot → feel it harder.
  if (ptDelta < 0 && player.classYear === 'SR') ptDelta *= 1.4
  target += ptDelta

  // Performance (vs current league averages)
  target += performanceDelta(player, stats, ctx.leagueAvg)

  // Coach motivator: -8 (cold) to +8 (warm)
  if (ctx.coachMotivator != null) target += ((ctx.coachMotivator - 50) / 50) * 8

  // Recent 1-on-1 boost
  const boost = player.happiness?.coachBoost
  if (boost && boost.weeksRemaining > 0) target += boost.amount

  return Math.max(0, Math.min(100, Math.round(target)))
}

/**
 * Weekly happiness update for the user's team. Mutates state.
 * - Smooths each player's value toward their target by 30%.
 * - Applies mild GPA + composure drift per band.
 * - Ticks down any active 1-on-1 boost.
 */
export function tickHappiness(state) {
  // Happiness is driven by playing time + on-field performance. Nothing in the
  // offseason moves either, so freezing values during offseason keeps the
  // signal honest. The 1-on-1 coach boost still ticks down by week count
  // below — we just don't recompute the target.
  if (state.calendar?.mode !== 'SEASON') return
  const team = state.teams[state.userSchoolId]
  if (!team) return
  const userHC = state.coaches[team.headCoachId]
  const teamPlayers = team.rosterPlayerIds.map(id => state.players[id]).filter(Boolean)

  const statsByPlayerId = {}
  let teamMaxPA = 0
  let teamMaxIP = 0
  for (const p of teamPlayers) {
    const key = p.isPitcher ? `p_${p.id}` : `b_${p.id}`
    const s = state.playerStats?.[key]
    if (!s) continue
    statsByPlayerId[p.id] = s
    if (p.isPitcher) teamMaxIP = Math.max(teamMaxIP, s.outs / 3)
    else teamMaxPA = Math.max(teamMaxPA, s.pa)
  }
  const leagueAvg = computeLeagueAverages(state)
  const ctx = { teamPlayers, statsByPlayerId, teamMaxPA, teamMaxIP, coachMotivator: userHC?.motivator, leagueAvg }

  for (const p of teamPlayers) {
    const h = ensureHappiness(p)
    h.lastWeek = h.value
    const target = computeHappinessTarget(p, ctx)
    h.value = Math.max(0, Math.min(100, Math.round(h.value + (target - h.value) * SMOOTHING)))

    // Tick down active boost
    if (h.coachBoost && h.coachBoost.weeksRemaining > 0) {
      h.coachBoost.weeksRemaining--
      if (h.coachBoost.weeksRemaining <= 0) h.coachBoost = null
    }

    applyHappinessConsequences(p, h)
  }
}

/** Mild GPA + mental-rating drift each week based on current happiness band. */
function applyHappinessConsequences(p, h) {
  const level = happinessLevel(h.value)

  // GPA drift
  const gpaDelta = { ECSTATIC: +0.01, HAPPY: +0.005, NEUTRAL: 0, UNSURE: -0.005, UPSET: -0.01 }[level]
  if (gpaDelta && typeof p.gpa === 'number') {
    p.gpa = Math.max(0.5, Math.min(4.0, Math.round((p.gpa + gpaDelta) * 100) / 100))
  }

  // Mental-rating drift — composure for pitchers, discipline for hitters.
  // Small enough that single-week swings rarely move the integer rating;
  // sustained upset/ecstatic over 6+ weeks shifts it by ~1 point.
  const drift = { ECSTATIC: +0.05, HAPPY: +0.025, NEUTRAL: 0, UNSURE: -0.025, UPSET: -0.05 }[level]
  if (drift) {
    if (p.isPitcher && p.pitcher && typeof p.pitcher.composure === 'number') {
      p.pitcher.composure = Math.max(20, Math.min(99, Math.round((p.pitcher.composure + drift) * 10) / 10))
    } else if (p.isHitter && p.hitter && typeof p.hitter.discipline === 'number') {
      p.hitter.discipline = Math.max(20, Math.min(99, Math.round((p.hitter.discipline + drift) * 10) / 10))
    }
  }
}

/**
 * Apply a 1-on-1 meeting boost to a player. Immediate small bump + a
 * multi-week target lift that decays.
 */
export function applyMeetingBoost(player, amount = 15, weeks = 4) {
  const h = ensureHappiness(player)
  h.coachBoost = { amount, weeksRemaining: weeks }
  // Immediate visible bump so the user sees their action register right away
  h.value = Math.max(0, Math.min(100, h.value + Math.round(amount * 0.4)))
}
