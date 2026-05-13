/**
 * Player development.
 *
 * Two paths into player rating progression:
 *   1. simulateSeasonDev() — annual end-of-season pass: each player's R moves
 *      toward P modulated by playing time + work ethic + coach.developer +
 *      facility/meals investment.
 *   2. applyScrimmageDev() — small per-scrimmage bump for the players who
 *      actually played in the scrimmage. Lets coaches use fall ball to
 *      develop bench players.
 */

import { makeRng } from './rng'

/** @typedef {import('./types.js').Player} Player */
/** @typedef {import('./types.js').HitterRatings} HitterRatings */
/** @typedef {import('./types.js').PitcherRatings} PitcherRatings */

const HITTER_KEYS = ['contact_l', 'contact_r', 'power_l', 'power_r', 'discipline', 'speed', 'fielding', 'arm']
const PITCHER_KEYS = ['stuff', 'control', 'command', 'stamina', 'vs_l', 'vs_r', 'composure', 'durability']

/**
 * Move each rating toward potential by a small amount.
 * @param {Object<string,number>} current
 * @param {Object<string,number>} potential
 * @param {number} magnitude  // multiplier on the bump
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @returns {Object<string,number>}
 */
function bumpTowardPotential(current, potential, magnitude, rng) {
  const out = { ...current }
  for (const k of Object.keys(current)) {
    const gap = (potential?.[k] ?? current[k]) - current[k]
    if (gap <= 0) continue
    // Each rating has independent dice roll
    if (!rng.chance(0.5)) continue
    const bump = Math.max(0, Math.round(rng.gaussian(1.5 * magnitude, 0.6 * magnitude)))
    out[k] = Math.min(99, current[k] + Math.min(bump, gap))
  }
  return out
}

/**
 * Scrimmage development boost — only for players selected to play.
 * Smaller magnitude than season-end progression.
 *
 * @param {Player[]} playersInScrimmage
 * @param {string} scrimmageSeriesId      // for deterministic seeding
 * @returns {Player[]}  shallow-copied players with bumped ratings
 */
export function applyScrimmageDev(playersInScrimmage, scrimmageSeriesId) {
  return playersInScrimmage.map((p, i) => {
    const rng = makeRng('scrimDev', p.id, scrimmageSeriesId, i)
    const magnitude = 0.35   // ~1/3 of a full season-end pass per scrimmage
    const newHitter = p.isHitter && p.hidden?.potential_hitter
      ? bumpTowardPotential(p.hitter, p.hidden.potential_hitter, magnitude, rng)
      : p.hitter
    const newPitcher = p.isPitcher && p.hidden?.potential_pitcher
      ? bumpTowardPotential(p.pitcher, p.hidden.potential_pitcher, magnitude, rng)
      : p.pitcher
    return { ...p, hitter: newHitter, pitcher: newPitcher }
  })
}

/**
 * Convert a player's accumulated season stats into a "performance score" 0-1.
 * Heavy minimum-PA threshold so a 5-AB part-timer doesn't get a 0 or 1 from noise.
 *
 * @param {Player} player
 * @param {{ ab?: number, h?: number, hr?: number, bb?: number, k?: number, ip?: number, er?: number } | null} stats
 * @returns {number}   0.0 = poor, 0.5 = average, 1.0 = elite
 */
function performanceScore(player, stats) {
  if (!stats) return 0.4   // no playing time → below-average development signal
  if (player.isPitcher) {
    if ((stats.ip || 0) < 10) return 0.4
    const era = stats.er * 9 / Math.max(0.1, stats.ip)
    const kbb = (stats.k || 0) / Math.max(1, stats.bb || 0)
    // NAIA average ERA ~5.5, average K/BB ~2.0
    const eraScore = clamp(1 - (era - 2.5) / 6, 0, 1)
    const kbbScore = clamp((kbb - 1) / 4, 0, 1)
    return eraScore * 0.6 + kbbScore * 0.4
  }
  if ((stats.ab || 0) < 20) return 0.4
  const avg = stats.h / Math.max(1, stats.ab)
  const obp = (stats.h + stats.bb) / Math.max(1, stats.ab + stats.bb)
  const slg = (stats.h - stats.d - stats.t - stats.hr + 2*stats.d + 3*stats.t + 4*stats.hr) / Math.max(1, stats.ab)
  // NAIA averages — AVG ~.300, OBP ~.380, SLG ~.450
  const avgScore = clamp((avg - 0.220) / 0.180, 0, 1)
  const obpScore = clamp((obp - 0.300) / 0.180, 0, 1)
  const slgScore = clamp((slg - 0.330) / 0.220, 0, 1)
  return avgScore * 0.3 + obpScore * 0.35 + slgScore * 0.35
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

/**
 * End-of-season development pass — every player gets a chance to grow.
 *
 * Combines:
 *   - Age/class: FR/SO grow faster than JR/SR by default
 *   - Potential gap: how much room they have to grow
 *   - Coach developer + player work ethic
 *   - Playing time
 *   - **Performance**: a player putting up great stats develops MORE than a
 *     player riding the bench, regardless of age. A SR who hits .380 keeps
 *     improving; a SR who hit .220 stagnates.
 *   - Budget — facility/medical investment helps development
 *
 * @param {Player} player
 * @param {{
 *   coachDeveloper: number, paShare: number, ipShare: number,
 *   budgetEffects: any, seasonStats?: any
 * }} ctx
 * @param {number} seed
 * @returns {Player}
 */
export function endOfSeasonDevelopment(player, ctx, seed) {
  const rng = makeRng('eosDev', player.id, seed)
  const workEthic = player.hidden?.work_ethic ?? 60
  const coachDev = ctx.coachDeveloper ?? 55

  // Base scales with class year — but seniors aren't shut out anymore
  // because performance can rescue them
  const classBase = { FR: 1.0, SO: 0.85, JR: 0.65, SR: 0.40 }[player.classYear] ?? 0.5

  // Playing-time multiplier
  const playingTime = player.isPitcher ? ctx.ipShare : ctx.paShare
  const ptMult = Math.max(0.4, Math.min(1.4, playingTime * 2))

  // Coach + work-ethic multipliers
  const coachMult = 0.7 + (coachDev / 100) * 0.6
  const ethicMult = 0.7 + (workEthic / 100) * 0.6

  // Budget effects: prefer the explicit devMultiplier from extendedBudget-
  // Effects (facilities-driven), fall back to the legacy facilitiesDrift
  // computation for older callers.
  const budgetMult = ctx.budgetEffects?.devMultiplier
    ?? (1 + ((ctx.budgetEffects?.facilitiesDrift ?? 0) / 30))

  // PERFORMANCE multiplier — key new lever per Nate
  // 0.5 = poor stats; 1.0 = average; 1.7 = elite
  const perfScore = performanceScore(player, ctx.seasonStats)
  const perfMult = 0.5 + perfScore * 1.2

  const magnitude = classBase * ptMult * coachMult * ethicMult * budgetMult * perfMult

  let newHitter = player.hitter
  let newPitcher = player.pitcher
  let totalGain = 0   // for news event reporting
  if (player.isHitter && player.hidden?.potential_hitter) {
    const before = avgRatings(player.hitter)
    newHitter = bumpTowardPotential(player.hitter, player.hidden.potential_hitter, magnitude, rng)
    totalGain += avgRatings(newHitter) - before
  }
  if (player.isPitcher && player.hidden?.potential_pitcher) {
    const before = avgRatings(player.pitcher)
    newPitcher = bumpTowardPotential(player.pitcher, player.hidden.potential_pitcher, magnitude, rng)
    totalGain += avgRatings(newPitcher) - before

    // Stamina also grows from sheer workload — pitchers who throw more
    // build more stamina. Scales with innings pitched share.
    if (typeof newPitcher.stamina === 'number') {
      const workloadStaminaGain = clamp(ctx.ipShare * 4 * ethicMult, 0, 5)
      newPitcher = { ...newPitcher, stamina: Math.min(99, newPitcher.stamina + workloadStaminaGain) }
    }
  }

  return { ...player, hitter: newHitter, pitcher: newPitcher, _devGain: totalGain }
}

function avgRatings(block) {
  const vals = Object.values(block)
  return vals.reduce((a, b) => a + b, 0) / vals.length
}
