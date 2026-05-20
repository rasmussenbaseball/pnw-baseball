/**
 * Plate-appearance-level simulation engine.
 *
 * Two tiers:
 *   - Full PA-by-PA sim for games involving teams we care about
 *   - Fast monte-carlo sim from team strength for the bulk of league games
 *
 * See ../docs/sim.md.
 */

import { makeRng } from './rng'
import { effectiveFielding } from './positions'
import { energyMultiplier } from './energy'

/** @typedef {import('./types.js').Player} Player */
/** @typedef {import('./types.js').Team} Team */
/** @typedef {import('./schedule.js').Game} Game */

// ─── League baseline outcome distribution ─────────────────────────────────────
//
// Calibrated to NAIA 2025 averages:
//   BA ~.295, OBP ~.385, SLG ~.460
//   R/G ~7.5, ERA ~5.5
//   K% ~22%, BB% ~12%, HBP% ~1.5%
//   HR/PA ~3.2%, 2B/PA ~5%, 3B/PA ~0.6%
//   GIDP/G ~0.7, Sac fly/G ~0.4, Sac bunt/G ~0.3
//
// SAC_FLY and SAC_BUNT are productive outs (advance/score runners, batter is out)
// ERROR reaches a runner safely (BABIP boost from fielding errors)

// Legacy NAIA-shaped baseline. Kept as a fallback for any code path that
// doesn't pass a level. The level-aware table below is the source of truth
// for any sim call that knows what league it's in.
const BASE_RATES = {
  K:       0.22,
  BB:      0.105,
  HBP:     0.015,
  HR:      0.032,
  TRIPLE:  0.006,
  DOUBLE:  0.05,
  SINGLE:  0.175,
  ERROR:   0.010,   // batter reaches on E
  OUT:     0.387,
}

/**
 * Per-level league-average outcome rates (calibrated against real 2025
 * NWBB Stats data — see leagueStats.js LEVEL_BASELINES for the targets).
 * Each row sums to 1.0 across the 9 PA outcomes.
 *
 * These represent the "rating 50 plays rating 50" outcome at each level.
 * Player ratings shift outcomes from this baseline.
 *
 * D1   — high K%, high HR, average BABIP
 * D2   — moderate K%, lower HR, slightly elevated BABIP
 * D3   — moderate K%, moderate HR, mostly singles
 * NAIA — hitter's league, balanced
 * NWAC — lowest HR rate (wood-bat-ish JUCO), low contact, more outs
 */
const BASE_RATES_BY_LEVEL = {
  D1:   { K: 0.250, BB: 0.115, HBP: 0.013, HR: 0.030, TRIPLE: 0.005, DOUBLE: 0.046, SINGLE: 0.145, ERROR: 0.010, OUT: 0.386 },
  D2:   { K: 0.180, BB: 0.090, HBP: 0.015, HR: 0.024, TRIPLE: 0.006, DOUBLE: 0.050, SINGLE: 0.180, ERROR: 0.011, OUT: 0.444 },
  D3:   { K: 0.190, BB: 0.100, HBP: 0.017, HR: 0.026, TRIPLE: 0.006, DOUBLE: 0.044, SINGLE: 0.170, ERROR: 0.012, OUT: 0.435 },
  NAIA: { K: 0.220, BB: 0.090, HBP: 0.017, HR: 0.024, TRIPLE: 0.004, DOUBLE: 0.044, SINGLE: 0.150, ERROR: 0.010, OUT: 0.441 },
  NWAC: { K: 0.200, BB: 0.110, HBP: 0.017, HR: 0.012, TRIPLE: 0.005, DOUBLE: 0.040, SINGLE: 0.155, ERROR: 0.014, OUT: 0.447 },
}

function baseRatesForLevel(level) {
  return BASE_RATES_BY_LEVEL[level] || BASE_RATES
}

// ALPHA = dispersion of rating effects around the league baseline. Lowered
// May 2026 (0.6 → 0.45) to keep elite hitter slash lines REALISTIC for NAIA:
// a 95-rating contact + power + discipline triple-stack was producing .500+
// AVGs because every dimension was getting multiplicatively boosted at once.
// At 0.45 elite hitters cap around .395-.420 AVG, which matches real NAIA
// leaderboards (Cordova led NAIA 2024 at .445 — the single tip of the curve,
// not the routine outcome we were producing).
const ALPHA = 0.45

/**
 * Average fielding rating across an array of defenders. The catcher counts
 * full weight; infielders + OF count full; pitcher excluded (their fielding
 * doesn't really track on this scale for PA outcomes — they affect plays
 * via stuff/movement). Treats missing fielding values as 50 (neutral).
 *
 * If `playedPositions` is provided (parallel array of position strings),
 * each defender's fielding is dropped per the out-of-position penalty —
 * a SS playing 1B keeps NEAR-natural fielding, a 1B playing C tanks.
 * See engine/positions.js for the penalty model.
 */
function averageFielding(defenders, playedPositions) {
  if (!defenders || defenders.length === 0) return 50
  let sum = 0
  let count = 0
  for (let i = 0; i < defenders.length; i++) {
    const d = defenders[i]
    if (!d || d.isPitcher) continue
    const pos = playedPositions ? playedPositions[i] : null
    // effectiveFielding clamps and falls back to 50 for missing data; if no
    // position was provided we use the raw fielding (back-compat).
    const fld = pos ? effectiveFielding(d, pos) : (d.hitter?.fielding ?? 50)
    sum += fld
    count++
  }
  if (count === 0) return 50
  return sum / count
}

// Hit-outcome slope dampener — applied ONLY to SINGLE / DOUBLE / TRIPLE / HR
// adj values. K / BB / HBP keep their full slope so elite plate discipline +
// great stuff still drive realistic K%/BB% spreads. This separates the two
// concerns: rate-stat dispersion (K%/BB%, kept wide) vs hit-quality dispersion
// (BABIP/SLG, compressed so we don't get .500 hitters).
//
// Lowered again 0.60 → 0.48 (May 2026): the FULL sim (user games) was running
// way hot vs the light sim (rest of NAIA) — a strong team posted a .364 team
// AVG and a 7.6 ERA. A flatter hit slope compresses both elite offenses AND
// the run environment toward the league baseline, closing the gap with the
// light sim (which centers ~.270 / ~5 ERA).
const HIT_SLOPE = 0.48

// Home-field edge for the full per-PA sim. Applied as a small swing on hit
// outcomes for the batting team (positive when home is batting, negative when
// away is batting), so the home club both scores a bit more AND allows a bit
// less — netting ~0.6-0.7 runs/game and an ~58% home win rate (per Nate).
const HOME_PA_EDGE = 0.05

/**
 * Pick the next reliever from a rotation by LEVERAGE. The bullpen isn't used
 * top-down: a manager saves the best arms for the closest games and burns
 * mop-up guys in blowouts. Returns the rotation index to bring in, or null if
 * no fresh arm is available.
 *
 *   tier 'HIGH' (close + late)  → best available arm (the closer/setup)
 *   tier 'MED'  (one-score-ish) → a middle arm
 *   tier 'LOW'  (blowout)       → the WORST available arm (mop-up; saves the
 *                                 good arms for games that matter)
 *
 * Gassed arms (energy < 25) are filtered out unless everyone's gassed.
 */
function pickReliever(rotation, usedSet, tier, getEnergy) {
  const cands = []
  for (let i = 0; i < rotation.length; i++) {
    if (usedSet.has(i)) continue
    const p = rotation[i]
    if (!p || !p.pitcher) continue
    const score = ((p.pitcher.stuff ?? 50) + (p.pitcher.control ?? 50) + (p.pitcher.command ?? 50)) / 3
    cands.push({ i, score, energy: getEnergy ? getEnergy(p.id) : 100 })
  }
  if (cands.length === 0) return null
  const fresh = cands.filter(c => c.energy >= 25)
  const pool = fresh.length > 0 ? fresh : cands
  pool.sort((a, b) => b.score - a.score)   // best arm first
  if (tier === 'HIGH') return pool[0].i
  if (tier === 'LOW') return pool[pool.length - 1].i
  return pool[Math.floor(pool.length / 2)].i
}

// ─── Fast sim (team-strength based) ──────────────────────────────────────────

/**
 * Fast sim from team ratings. Returns a final score and basic boxscore.
 * Used for the bulk of league games not involving teams we're tracking
 * in detail.
 *
 * @param {{ overall_rating: number, offense_rating: number, pitching_rating: number }} home
 * @param {{ overall_rating: number, offense_rating: number, pitching_rating: number }} away
 * @param {string} seedKey
 * @returns {{ homeRuns: number, awayRuns: number }}
 */
export function fastSimGame(home, away, seedKey, opts = {}) {
  const rng = makeRng('fast', seedKey)
  // Expected runs from offense - opposing pitching diff. Differential effect
  // softened (1.8 → 1.3) and the clamp tightened (was 0-25 → 1-15) so even a
  // dominant team doesn't routinely hang 18-20 — that's what produced absurd
  // undefeated/.560 teams. Most games now land in a realistic 3-10 run band.
  // Home-field edge — calibrated so league home teams win ~58% (per Nate).
  // With each team's runs ~N(exp, 2.4), the run-difference SD is ~3.4, so a
  // ~0.68-run home bump puts P(home win) near 0.58. Neutral-site games (e.g.
  // postseason at a neutral park) get no edge.
  const homeBonus = opts.neutral ? 0 : 0.68
  const homeExp = clamp(5.5 + (home.offense_rating - away.pitching_rating) * 1.3 + homeBonus, 1.5, 15)
  const awayExp = clamp(5.5 + (away.offense_rating - home.pitching_rating) * 1.3, 1.5, 15)
  // Sample with Poisson-ish noise (σ trimmed 3 → 2.4 to reduce extreme games)
  let homeRuns = Math.max(0, Math.round(rng.gaussian(homeExp, 2.4)))
  let awayRuns = Math.max(0, Math.round(rng.gaussian(awayExp, 2.4)))
  // Avoid ties — extra innings shouldn't be a regular outcome
  if (homeRuns === awayRuns) {
    if (rng.chance(0.5)) homeRuns++; else awayRuns++
  }
  // When lineups are supplied, also fabricate a lightweight per-player
  // boxscore so league leaderboards + weekly awards + season stats reflect
  // every game that gets fast-simmed (non-user games and user-vs-non-NAIA).
  // Without this, only games routed through full simGame produce stats and
  // the league looks like a one-team show. The numbers are coarse on a
  // per-game basis but accumulate cleanly over a season.
  if (opts.homeLineup && opts.awayLineup) {
    // Rotate the starting pitcher by the game's position in the series so the
    // ace doesn't "start" all 3 games of a weekend (the old bug: 12+ IP in a
    // single weekend). The game id ends in _g0 / _g1 / _g2 for series games.
    const m = String(seedKey).match(/_g(\d+)$/)
    const gameIdx = m ? parseInt(m[1], 10) : 0
    const boxscore = buildLightBoxscore(opts.homeLineup, opts.awayLineup, homeRuns, awayRuns, rng, gameIdx)
    return { homeRuns, awayRuns, boxscore }
  }
  return { homeRuns, awayRuns }
}

/**
 * Lightweight per-player boxscore for fast-simmed games. Distributes the
 * already-decided runs/hits across each lineup using player ratings so the
 * top hitters / aces accumulate stats roughly in line with their skill.
 * Doesn't run a PA-by-PA sim — just splits totals.
 *
 * Returned shape mirrors what simGame.boxscore produces so the accumulation
 * code in season.js (state.playerStats/state.fallStats) doesn't care which
 * sim engine produced it.
 */
function buildLightBoxscore(homeLineup, awayLineup, homeRuns, awayRuns, rng, gameIdx = 0) {
  const batterStats = {}
  const pitcherStats = {}

  function distributeBatters(lineup, runs, oppRuns) {
    // Use the lineup's batters array; if absent fall back to 9 generic slots.
    const batters = (lineup.batters || []).slice(0, 9).filter(Boolean)
    if (batters.length === 0) return
    // Total hits ≈ runs × 1.55. CRITICAL: clamp the team's per-game hit total to
    // a believable batting-average band. Without this, a blowout (a strong team
    // hanging 14 on a weak one) translated directly into ~24 hits → a .60 team
    // game and absurd season AVGs (the .564 / undefeated teams). Real teams hang
    // crooked numbers via HRs + walks + efficiency, not 24 hits — so we cap the
    // game's hits at ~.42 of at-bats and floor at ~.15, which keeps season team
    // averages in a realistic .230-.340 range no matter how lopsided the score.
    const pasPerBatter = 4
    const estAB = batters.length * pasPerBatter + Math.min(3, batters.length) - 3   // ≈ AB after a few walks
    const maxHits = Math.round(estAB * 0.42)
    const minHits = Math.round(estAB * 0.15)
    // ratio 1.8 centers the light-sim league average around ~.270-.285, in
    // line with the full sim (the user's team), so the comparison page isn't a
    // 130-point mismatch. The .42 cap above still keeps blowout games from
    // inflating season averages.
    let totalHits = Math.round(runs * 1.8 + rng.gaussian(0, 1))
    totalHits = Math.max(Math.min(runs, minHits), Math.min(totalHits, maxHits))
    // Weights for hit allocation = contact rating, FLATTENED so the best bat
    // doesn't hog a game's hits and post a .500 line. `30 + c*0.7` compresses
    // the spread (a 90-contact bat gets ~1.4× a 50-contact bat's share instead
    // of 1.8×), which keeps individual league averages believable.
    const hitWeights = batters.map(b => {
      const c = ((b.hitter?.contact_r ?? 50) + (b.hitter?.contact_l ?? b.hitter?.contact_r ?? 50)) / 2
      return 30 + c * 0.7
    })
    const wSum = hitWeights.reduce((s, n) => s + n, 0) || 1
    let hitsRemaining = totalHits
    let rbiRemaining = runs   // RBIs total ≈ runs scored
    let hrRemaining = Math.max(0, Math.min(runs, Math.round(rng.gaussian(runs * 0.22, 1))))
    for (let i = 0; i < batters.length; i++) {
      const b = batters[i]
      const pa = pasPerBatter + (i < 3 ? 1 : 0)   // top of order gets 5
      const bbChance = ((b.hitter?.discipline ?? 50) - 40) / 600   // ~0.05-0.15
      const bb = Math.max(0, Math.round(pa * bbChance + rng.gaussian(0, 0.3)))
      const hbp = rng.chance(0.02) ? 1 : 0
      const ab = Math.max(0, pa - bb - hbp)
      // Hits this player gets ≈ totalHits × their weight / sum, but
      // capped at remaining hits and ab.
      const fairShare = totalHits * hitWeights[i] / wSum
      const noisyShare = Math.max(0, Math.round(fairShare + rng.gaussian(0, 0.4)))
      const h = Math.min(ab, hitsRemaining, noisyShare)
      hitsRemaining -= h
      // Split hits into doubles/triples/HR based on power; rest singles.
      const power = (b.hitter?.power_r ?? 50) + (b.hitter?.power_l ?? b.hitter?.power_r ?? 50)
      const powerScore = power / 2
      let hr = 0
      if (h > 0 && hrRemaining > 0 && rng.chance(Math.min(0.5, powerScore / 200))) {
        hr = 1; hrRemaining--
      }
      const d = (h - hr) > 0 && rng.chance(Math.min(0.35, powerScore / 220)) ? 1 : 0
      const t = (h - hr - d) > 0 && rng.chance(0.03) ? 1 : 0
      // Strikeouts inverse-correlate with contact
      const kChance = (90 - (b.hitter?.contact_r ?? 50)) / 320   // ~0.08-0.18
      const k = Math.max(0, Math.round(ab * kChance + rng.gaussian(0, 0.5)))
      // RBI: HR brings in ≥ 1 already, plus a small share of remaining runs
      let rbi = hr
      if (rbiRemaining > 0 && h > hr && rng.chance(0.35)) {
        rbi += 1; rbiRemaining -= 1
      }
      // Runs scored: small chance per hit/walk
      const r = h + bb > 0 && rng.chance(0.30) ? 1 : 0
      // Stolen bases: speed-weighted, cheap
      const speed = b.hitter?.speed ?? 50
      const sb = (h - hr) > 0 && rng.chance(Math.max(0, (speed - 65) / 200)) ? 1 : 0
      const cs = sb && rng.chance(0.15) ? 1 : 0
      batterStats[b.id] = {
        pa, ab, h, d, t, hr, bb, hbp, k, rbi, r, sb, cs,
        sf: 0, sac: 0, gidp: 0, roe: 0,
      }
    }
  }

  function distributePitchers(lineup, runsAllowed, oppHits) {
    // Accept either shape: synthetic lineups use `pitchers`, real lineups
    // (autoLineup / resolveLineupForGame) use `pitcherRotation` already
    // ordered so index 0 is today's starter (rotation handled upstream).
    const allP = (lineup.pitcherRotation || lineup.pitchers || []).filter(Boolean)
    if (allP.length === 0) return
    const starter = allP[0]
    const bullpen = allP.slice(1, 4)
    // Starter goes ~5.2 IP unless they got hammered
    const hammered = runsAllowed >= 8
    const starterOuts = hammered ? 9 + Math.floor(rng.chance(0.5) ? 0 : 3) : 15 + Math.floor(rng.gaussian(2, 1))
    const totalOuts = 27   // assume 9 innings; close enough for fast sim
    const relieverOuts = Math.max(0, totalOuts - starterOuts)
    const starterRunShare = clamp(starterOuts / totalOuts, 0.4, 0.85)
    const starterRuns = Math.round(runsAllowed * starterRunShare)
    const relieverRuns = Math.max(0, runsAllowed - starterRuns)
    const starterHits = Math.round(oppHits * starterRunShare)
    const relieverHits = Math.max(0, oppHits - starterHits)
    // Starter line
    const sStuff = starter.pitcher?.stuff ?? 50
    const sControl = starter.pitcher?.control ?? 50
    const sK = Math.max(0, Math.round((starterOuts / 27) * 9 * (sStuff - 35) / 50 + rng.gaussian(0, 1)))
    const sBB = Math.max(0, Math.round((starterOuts / 27) * 3 * (75 - sControl) / 40 + rng.gaussian(0, 0.5)))
    const sHr = Math.max(0, Math.round(starterRuns * 0.20 + rng.gaussian(0, 0.5)))
    pitcherStats[starter.id] = {
      ip: starterOuts / 3,
      outs: starterOuts,
      h: Math.max(starterHits, 0),
      bb: sBB, hbp: 0, k: sK, hr: sHr,
      er: starterRuns,
      pa: Math.max(starterOuts + starterHits + sBB, 0),
    }
    // Bullpen — distribute remaining outs among up to 3 relievers
    if (bullpen.length > 0 && relieverOuts > 0) {
      const perRelOuts = Math.floor(relieverOuts / Math.min(bullpen.length, 3))
      let outsLeft = relieverOuts
      let runsLeft = relieverRuns
      let hitsLeft = relieverHits
      const usable = bullpen.slice(0, 3)
      for (let i = 0; i < usable.length; i++) {
        const p = usable[i]
        const isLast = i === usable.length - 1
        const o = isLast ? outsLeft : perRelOuts
        outsLeft -= o
        const r = isLast ? runsLeft : Math.round(runsLeft * (o / Math.max(1, relieverOuts)))
        runsLeft -= r
        const h = isLast ? hitsLeft : Math.round(hitsLeft * (o / Math.max(1, relieverOuts)))
        hitsLeft -= h
        const pStuff = p.pitcher?.stuff ?? 50
        const pCtrl = p.pitcher?.control ?? 50
        pitcherStats[p.id] = {
          ip: o / 3,
          outs: o,
          h: Math.max(h, 0),
          bb: Math.max(0, Math.round((o / 27) * 3 * (75 - pCtrl) / 40)),
          hbp: 0,
          k: Math.max(0, Math.round((o / 27) * 9 * (pStuff - 35) / 50)),
          hr: Math.max(0, Math.round(r * 0.2)),
          er: r,
          pa: Math.max(o + h, 0),
        }
      }
    }
  }

  // Compute opp hits per side (needed by distributePitchers) by using the
  // same R-to-H ratio we used for batters.
  const homeHits = Math.round(homeRuns * 1.7)
  const awayHits = Math.round(awayRuns * 1.7)
  distributeBatters(homeLineup, homeRuns, awayRuns)
  distributeBatters(awayLineup, awayRuns, homeRuns)
  distributePitchers(homeLineup, awayRuns, awayHits)
  distributePitchers(awayLineup, homeRuns, homeHits)
  return { batterStats, pitcherStats }
}

// ─── PA-level full sim ───────────────────────────────────────────────────────

/**
 * Sim a single PA. Returns an outcome.
 * @param {Player} batter
 * @param {Player} pitcher
 * @param {{ leverage: number, defenders?: Player[], defenderPositions?: string[], coachMotivator?: number, batterEnergy?: number, pitcherEnergy?: number }} ctx
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @returns {{ outcome: string, type?: string }}
 */
export function simPA(batter, pitcher, ctx, rng) {
  const hand = pitcher.throws === 'L' ? 'l' : 'r'
  const oppHand = batter.bats === 'L' ? 'l' : batter.bats === 'S' ? (hand === 'l' ? 'r' : 'l') : 'r'
  // Energy regression — tired stars play closer to 50. Applied as a
  // dampener on the (rating - 50) deviation. See energy.js.
  const batMult = energyMultiplier(ctx.batterEnergy ?? 100)
  const pitMult = energyMultiplier(ctx.pitcherEnergy ?? 100)
  // Energy regression: tired stars' (rating - 50) deviation shrinks
  // toward 50. At 100 energy reg = identity, at 0 energy ~28% compressed.
  const reg = (raw, mult) => 50 + (raw - 50) * mult
  // Pull ratings — fallback to neutral 50 if missing. Apply energy dampener.
  const contact = reg(batter.hitter[`contact_${oppHand}`] ?? 50, batMult)
  const power = reg(batter.hitter[`power_${oppHand}`] ?? 50, batMult)
  const discipline = reg(batter.hitter.discipline ?? 50, batMult)
  const speed = reg(batter.hitter.speed ?? 50, batMult)

  const stuff = reg(pitcher.pitcher.stuff ?? 50, pitMult)
  const control = reg(pitcher.pitcher.control ?? 50, pitMult)
  const command = reg(pitcher.pitcher.command ?? 50, pitMult)
  const vsBatter = reg(pitcher.pitcher[`vs_${oppHand}`] ?? 50, pitMult)

  // Velocity (mph spread) — separate from stuff. Higher velo:
  //   - drives K rate up (hard to catch up to a heater)
  //   - suppresses hard contact (HR + DOUBLE)
  //   - doesn't help with command/control issues — flamethrowers still walk guys
  // NAIA-calibrated: 87 mph is league-average, 92+ is plus, 95+ is elite.
  // Treated as a separate (mph - 87) signal worth ~30% as much per mph as a
  // rating point on the 0-99 scale.
  const velo = pitcher.pitcher.velocity_avg ?? pitcher.measurables?.fbVeloMph ?? 87
  const veloEdge = (velo - 87) / 50   // +0.10 at 92mph, +0.16 at 95mph

  // Defense — average fielding rating of the defending side (computed from
  // ctx.defenders if passed; else neutral 50). Drives:
  //   - ERROR rate (better defense = fewer errors)
  //   - BABIP suppression (better defense = more BIP outs, fewer hits)
  // NAIA fielding %: ~.965-.970 league avg → ~1-1.5 errors/game. We anchor
  // the engine at the 50-rating defense producing ~1.0% PA-error rate.
  const defenseAvg = ctx.defenders && ctx.defenders.length > 0
    ? averageFielding(ctx.defenders, ctx.defenderPositions)
    : 50
  const defenseEdge = (defenseAvg - 50) / 50    // -1 .. +1 around league avg

  // Adjustments (each logit-style). All centered around 50, normalized.
  // Hit-outcome adj is dampened by HIT_SLOPE so elite hitter slash lines
  // stay realistic for NAIA (.400 elite ceiling, not .500+).
  const adj = {
    // Strikeouts RISE with pitcher stuff / platoon edge / velocity and FALL
    // with batter discipline + contact. The signs on stuff/vsBatter/velo were
    // previously inverted (good, hard-throwing pitchers struck out FEWER —
    // user staffs sat at ~4.9 K/9 vs a ~7.6 league avg). Coefficients on the
    // pitcher terms are dampened so an elite arm lands ~10 K/9, an average arm
    // ~8, not a 40%+ K rate.
    K:    ((stuff - 50) * 0.5 + (vsBatter - 50) * 0.25 - (discipline - 50) - (contact - 50) * 0.3) / 50 + veloEdge * 0.6,
    BB:   ((discipline - 50) - (control - 50) * 1.2) / 50,
    HBP:  (-(control - 50) * 0.9) / 50,
    HR:     HIT_SLOPE * (((power - 50) - (command - 50) * 1.1 - (stuff - 50) * 0.5) / 50 - veloEdge * 0.5),
    // BIP hits suppressed by defense edge (better defense = fewer BABIP hits)
    SINGLE: HIT_SLOPE * (((contact - 50) + (speed - 50) * 0.2 - (stuff - 50) * 0.5) / 50 - veloEdge * 0.3 - defenseEdge * 0.30),
    DOUBLE: HIT_SLOPE * (((power - 50) * 0.4 + (speed - 50) * 0.3) / 50 - veloEdge * 0.4 - defenseEdge * 0.35),
    TRIPLE: HIT_SLOPE * (((speed - 50) * 0.5 + (power - 50) * 0.2) / 50 - defenseEdge * 0.40),
    // Error rate flips with defense — elite defense commits ~40% fewer errors
    ERROR: -defenseEdge * 0.7,
    OUT: 0,
  }

  // Apply ratings to per-level baseline probabilities. The level is passed
  // via ctx.level (added when the caller sets up simGame for a given save).
  // Falls back to the legacy NAIA-shaped BASE_RATES if no level provided.
  const baseRates = baseRatesForLevel(ctx.level)
  /** @type {Object<string,number>} */
  const probs = {}
  for (const [k, base] of Object.entries(baseRates)) {
    const logitShift = adj[k] * ALPHA
    // logit transform & back
    const p = base * Math.exp(logitShift)
    probs[k] = p
  }
  // Composure / clutch in high leverage (small shift toward K for poor composure)
  if (ctx.leverage && ctx.leverage > 1.5) {
    const composure = pitcher.pitcher.composure ?? 50
    const clutch = batter.hidden?.clutch ?? 50
    const shift = (composure - clutch) / 200
    probs.K *= (1 + shift)
    probs.HR *= (1 - shift)
  }
  // Coach motivator small bump
  if (ctx.coachMotivator) {
    const bump = (ctx.coachMotivator - 50) / 500
    probs.SINGLE *= (1 + bump)
    probs.HR *= (1 + bump * 0.5)
  }
  // Home-field edge — lift hits (and trim Ks) for the home batting team, the
  // reverse for the away team. Drives the ~58% home win rate.
  if (ctx.siteEdge) {
    const e = ctx.siteEdge
    probs.SINGLE *= (1 + e)
    probs.DOUBLE *= (1 + e)
    probs.TRIPLE *= (1 + e)
    probs.HR *= (1 + e * 0.8)
    probs.K *= (1 - e * 0.4)
  }

  // Normalize and sample
  const total = Object.values(probs).reduce((a, b) => a + b, 0)
  let r = rng.next() * total
  for (const k of Object.keys(probs)) {
    r -= probs[k]
    if (r <= 0) return outcomeFor(k, rng)
  }
  return outcomeFor('OUT', rng)
}

function outcomeFor(key, rng) {
  if (key === 'OUT') {
    // Real NAIA out distribution (per the few public BIP datasets — small
    // school baseball trends slightly more GB than D1 because of aluminum
    // bats + lower velo): ~48% GB, 30% FB, 16% LD, 6% PU.
    const t = rng.weighted(['groundout', 'flyout', 'lineout', 'popout'], [48, 30, 16, 6])
    return { outcome: 'OUT', type: t }
  }
  return { outcome: key }
}

// Sub-outcome resolvers — called after the basic outcome is chosen, to convert
// some OUTs into sac flies / sac bunts / GIDP based on the base/out state.
function resolveOutSubtype(result, state, batter, rng) {
  const outs = state.outs
  if (outs >= 2) return result   // 2 outs — no productive out math
  const r1 = state.bases[0], r2 = state.bases[1], r3 = state.bases[2]

  // Sac fly: flyout with R3 (~25% conversion rate)
  if (result.type === 'flyout' && r3 && rng.chance(0.28)) {
    return { ...result, outcome: 'SAC_FLY' }
  }
  // Sac bunt: small-ball with R1/R2 and contact-oriented batter
  // Rough: 4% of groundouts with R1 or R2 are sac bunts
  if (result.type === 'groundout' && (r1 || r2) && rng.chance(0.05)) {
    return { ...result, outcome: 'SAC_BUNT' }
  }
  // GIDP: groundout with R1 and < 2 outs — ~12% conversion (lower if speedy)
  if (result.type === 'groundout' && r1 && rng.chance(0.12)) {
    return { ...result, outcome: 'GIDP' }
  }
  return result
}

// ─── Full game sim ───────────────────────────────────────────────────────────

/**
 * Sim a full game with PA-level fidelity.
 *
 * @param {Object} homeLineup   {batters: Player[9], batterPositions?: string[9], pitcherRotation: Player[]}
 * @param {Object} awayLineup
 * @param {{ homeMotivator?: number, awayMotivator?: number, getEnergy?: (id:string)=>number }} ctx
 * @param {string} seedKey
 * @returns {{ homeRuns: number, awayRuns: number, innings: number, log: string[], boxscore: object }}
 */
export function simGame(homeLineup, awayLineup, ctx, seedKey) {
  const rng = makeRng('game', seedKey)
  const state = {
    inning: 1,
    top: true,
    outs: 0,
    bases: [null, null, null],  // R1, R2, R3
    homeRuns: 0,
    awayRuns: 0,
    homePAIndex: 0,
    awayPAIndex: 0,
    // Starting pitcher = rotation slot for THIS game in the series, so a
    // 3-game weekend rotates through the staff instead of starting the ace
    // all three days (the old 12+ IP/weekend bug).
    homePitcherIdx: ctx.homeStarterIdx ?? 0,
    awayPitcherIdx: ctx.awayStarterIdx ?? 0,
    homePAs: 0,
    awayPAs: 0,
    // Leverage-aware bullpen management: track PAs faced by the CURRENT pitcher
    // (reset on each change) + which rotation slots have already been used, so
    // we can pull on a per-outing leash and bring in the right arm for the spot.
    homeCurPAs: 0,
    awayCurPAs: 0,
    homeUsed: new Set([ctx.homeStarterIdx ?? 0]),
    awayUsed: new Set([ctx.awayStarterIdx ?? 0]),
    log: [],
  }

  // Per-player stat trackers — populated in this game
  /** @type {Object<string, {ab:number,h:number,d:number,t:number,hr:number,bb:number,k:number,rbi:number,pa:number}>} */
  const batterStats = {}
  /** @type {Object<string, {ip:number,h:number,bb:number,k:number,er:number,outs:number,pa:number}>} */
  const pitcherStats = {}
  function bStat(id) { if (!batterStats[id]) batterStats[id] = {ab:0,h:0,d:0,t:0,hr:0,bb:0,k:0,rbi:0,pa:0,hbp:0,sf:0,sac:0,gidp:0,roe:0,sb:0,cs:0}; return batterStats[id] }
  function pStat(id) { if (!pitcherStats[id]) pitcherStats[id] = {ip:0,h:0,bb:0,k:0,er:0,outs:0,pa:0,hbp:0,hr:0}; return pitcherStats[id] }

  while (state.inning <= 9 || state.homeRuns === state.awayRuns) {
    if (state.inning > 12) break   // call it after 12 innings — extras rare in sim

    const batting = state.top ? awayLineup : homeLineup
    const defending = state.top ? homeLineup : awayLineup
    const pitcherIdx = state.top ? state.homePitcherIdx : state.awayPitcherIdx
    const pitcher = defending.pitcherRotation[pitcherIdx] || defending.pitcherRotation[0]
    const batterIdx = state.top ? state.awayPAIndex % 9 : state.homePAIndex % 9
    const batter = batting.batters[batterIdx]

    if (!batter || !pitcher) break

    const motivator = state.top ? ctx.awayMotivator : ctx.homeMotivator
    const leverage = computeLeverage(state)

    const preRuns = state.top ? state.awayRuns : state.homeRuns
    const batterEnergy = ctx.getEnergy ? ctx.getEnergy(batter.id) : 100
    const pitcherEnergy = ctx.getEnergy ? ctx.getEnergy(pitcher.id) : 100
    // Home-field edge: home batting gets a small lift, away batting a small
    // dip. Zero at a neutral site.
    const siteEdge = ctx.neutralSite ? 0 : (state.top ? -HOME_PA_EDGE : HOME_PA_EDGE)
    let result = simPA(batter, pitcher, {
      leverage,
      coachMotivator: motivator,
      defenders: defending.batters,
      defenderPositions: defending.batterPositions,
      batterEnergy,
      pitcherEnergy,
      siteEdge,
      level: ctx.level,           // per-level BASE_RATES
    }, rng)
    // Apply sub-outcome resolution (SAC_FLY, SAC_BUNT, GIDP) for OUTs
    if (result.outcome === 'OUT') result = resolveOutSubtype(result, state, batter, rng)
    state[state.top ? 'awayPAs' : 'homePAs']++

    // Track per-player stats
    const b = bStat(batter.id)
    const p = pStat(pitcher.id)
    b.pa++; p.pa++
    if (result.outcome === 'K') { b.ab++; b.k++; p.k++; p.outs++ }
    else if (result.outcome === 'OUT') { b.ab++; p.outs++ }
    else if (result.outcome === 'BB') { b.bb++; p.bb++ }
    else if (result.outcome === 'HBP') { b.hbp++; p.hbp++ }
    else if (result.outcome === 'SINGLE') { b.ab++; b.h++; p.h++ }
    else if (result.outcome === 'DOUBLE')  { b.ab++; b.h++; b.d++; p.h++ }
    else if (result.outcome === 'TRIPLE')  { b.ab++; b.h++; b.t++; p.h++ }
    else if (result.outcome === 'HR')      { b.ab++; b.h++; b.hr++; p.h++; p.hr++ }
    else if (result.outcome === 'SAC_FLY') { b.sf++; p.outs++ }   // SF not an AB
    else if (result.outcome === 'SAC_BUNT'){ b.sac++; p.outs++ }  // SH not an AB
    else if (result.outcome === 'GIDP')    { b.ab++; b.gidp++; p.outs += 2 }
    else if (result.outcome === 'ERROR')   { b.ab++; b.roe++ }    // reaches on error

    applyOutcome(state, result)

    // RBIs: any runs scored on this PA go to the batter (rough — doesn't capture sacrifice nuance)
    const postRuns = state.top ? state.awayRuns : state.homeRuns
    if (postRuns > preRuns) b.rbi += (postRuns - preRuns)
    // Earned runs: charged to pitcher on this PA
    if (postRuns > preRuns) p.er += (postRuns - preRuns)

    // Advance batter
    if (state.top) state.awayPAIndex++; else state.homePAIndex++

    // ── Bullpen management — leverage + confidence + fatigue ───────────────
    // The defending pitcher just faced a batter; tick their per-outing PA count.
    if (state.top) state.homeCurPAs++; else state.awayCurPAs++
    const curPAs = state.top ? state.homeCurPAs : state.awayCurPAs
    const usedSet = state.top ? state.homeUsed : state.awayUsed
    const starterIdx = state.top ? (ctx.homeStarterIdx ?? 0) : (ctx.awayStarterIdx ?? 0)
    const isStarter = pitcherIdx === starterIdx
    const curEr = pStat(pitcher.id).er
    // Game leverage tier from score margin + inning.
    const margin = Math.abs(state.homeRuns - state.awayRuns)
    let tier
    if (margin >= 6) tier = 'LOW'                       // blowout → mop-up
    else if (margin <= 2) tier = state.inning >= 6 ? 'HIGH' : 'MED'  // tight/late → best arms
    else tier = 'MED'
    // Leash (PAs for THIS outing). Starters ride longer when cruising and get a
    // quick hook when struggling — especially in a tight late game. Relievers
    // run a short leash in close games (matchup arms) and a long one in
    // blowouts (eat innings, save the good arms). A reliever who coughs up runs
    // in a non-blowout is pulled immediately.
    let leash
    if (isStarter) {
      leash = curEr >= 4 ? 18 : curEr <= 1 ? 30 : 25
      if (tier === 'HIGH' && curEr >= 3) leash -= 4
    } else {
      leash = tier === 'LOW' ? 12 : tier === 'HIGH' ? 6 : 8
      if (curEr >= 2 && tier !== 'LOW') leash = Math.min(leash, curPAs)
    }
    if (curPAs >= leash) {
      const nextIdx = pickReliever(defending.pitcherRotation, usedSet, tier, ctx.getEnergy)
      if (nextIdx != null) {
        usedSet.add(nextIdx)
        if (state.top) { state.homePitcherIdx = nextIdx; state.homeCurPAs = 0 }
        else { state.awayPitcherIdx = nextIdx; state.awayCurPAs = 0 }
      }
    }

    // Check inning end
    if (state.outs >= 3) {
      state.outs = 0
      state.bases = [null, null, null]
      if (state.top) {
        state.top = false
      } else {
        state.top = true
        state.inning++
      }
    }
  }

  // Finalize: convert outs innings pitched (IP = outs/3)
  for (const id of Object.keys(pitcherStats)) {
    pitcherStats[id].ip = pitcherStats[id].outs / 3
  }

  // Build per-game appearance list so the caller can deduct energy. Each
  // hitter who saw a PA + each pitcher who threw counts. Pitchers carry
  // pitchesThrown (estimated ~3.9 per BF) for the energy calc.
  const appearances = []
  for (let i = 0; i < 9; i++) {
    const b = homeLineup.batters[i]
    if (b && batterStats[b.id]) {
      appearances.push({
        playerId: b.id,
        position: homeLineup.batterPositions?.[i] || b.primaryPosition,
        teamId: 'home',
      })
    }
  }
  for (let i = 0; i < 9; i++) {
    const b = awayLineup.batters[i]
    if (b && batterStats[b.id]) {
      appearances.push({
        playerId: b.id,
        position: awayLineup.batterPositions?.[i] || b.primaryPosition,
        teamId: 'away',
      })
    }
  }
  for (const id of Object.keys(pitcherStats)) {
    const ps = pitcherStats[id]
    // ~3.9 pitches per BF as a rough proxy
    const pitchesThrown = Math.round((ps.pa || 0) * 3.9)
    appearances.push({ playerId: id, pitchesThrown, isPitcher: true })
  }

  return {
    homeRuns: state.homeRuns,
    awayRuns: state.awayRuns,
    innings: state.inning,
    log: state.log,
    appearances,
    boxscore: {
      homePAs: state.homePAs,
      awayPAs: state.awayPAs,
      batterStats,
      pitcherStats,
    },
  }
}

function applyOutcome(state, result) {
  const team = state.top ? 'away' : 'home'
  if (result.outcome === 'OUT' || result.outcome === 'K') {
    state.outs++
    return
  }
  if (result.outcome === 'BB' || result.outcome === 'HBP') {
    walkRunner(state, team)
    return
  }
  if (result.outcome === 'SINGLE') { advance(state, team, 1); return }
  if (result.outcome === 'DOUBLE') { advance(state, team, 2); return }
  if (result.outcome === 'TRIPLE') { advance(state, team, 3); return }
  if (result.outcome === 'HR') {
    const runs = state.bases.filter(b => b).length + 1
    state.bases = [null, null, null]
    score(state, team, runs)
    return
  }
  if (result.outcome === 'ERROR') {
    // Reach on error — same as a single for runner-advancement purposes
    advance(state, team, 1)
    return
  }
  if (result.outcome === 'SAC_FLY') {
    // Batter is out; R3 scores
    state.outs++
    if (state.bases[2]) {
      state.bases[2] = null
      score(state, team, 1)
    }
    return
  }
  if (result.outcome === 'SAC_BUNT') {
    // Batter is out; runners advance 1 base
    state.outs++
    if (state.bases[2]) { state.bases[2] = null; score(state, team, 1) }
    if (state.bases[1]) { state.bases[2] = state.bases[1]; state.bases[1] = null }
    if (state.bases[0]) { state.bases[1] = state.bases[0]; state.bases[0] = null }
    return
  }
  if (result.outcome === 'GIDP') {
    // Double play — batter out + lead runner out
    state.outs += 2
    state.bases[0] = null   // R1 is the lead-runner out (most common GIDP outcome)
    return
  }
}

function walkRunner(state, team) {
  // Force advancement: bases fill from 1B
  if (state.bases[0]) {
    if (state.bases[1]) {
      if (state.bases[2]) {
        score(state, team, 1)
      }
      state.bases[2] = state.bases[1]
    }
    state.bases[1] = state.bases[0]
  }
  state.bases[0] = 'R'
}

function advance(state, team, basesAdvanced) {
  // Score runners that round home
  let runsScored = 0
  // R3
  if (state.bases[2]) { runsScored++; state.bases[2] = null }
  // R2
  if (state.bases[1]) {
    if (basesAdvanced >= 2) { runsScored++; state.bases[1] = null }
    else { state.bases[2] = state.bases[1]; state.bases[1] = null }
  }
  // R1
  if (state.bases[0]) {
    if (basesAdvanced >= 3) { runsScored++; state.bases[0] = null }
    else if (basesAdvanced === 2) { state.bases[2] = state.bases[0]; state.bases[0] = null }
    else { state.bases[1] = state.bases[0]; state.bases[0] = null }
  }
  // Batter
  if (basesAdvanced === 1) state.bases[0] = 'R'
  else if (basesAdvanced === 2) state.bases[1] = 'R'
  else if (basesAdvanced === 3) state.bases[2] = 'R'
  if (runsScored > 0) score(state, team, runsScored)
}

function score(state, team, n) {
  if (team === 'home') state.homeRuns += n
  else state.awayRuns += n
}

function computeLeverage(state) {
  // Simple LI proxy: late innings + close score = high leverage
  const inningWeight = state.inning >= 7 ? 1.5 : 1.0
  const scoreDiff = Math.abs(state.homeRuns - state.awayRuns)
  const closeWeight = scoreDiff <= 1 ? 1.6 : scoreDiff <= 3 ? 1.0 : 0.5
  return inningWeight * closeWeight
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// ─── Team lineup builders ────────────────────────────────────────────────────

/**
 * Build a default lineup from a team's roster — top 9 hitters + top 5 pitchers.
 *
 * @param {Team} team
 * @param {Object<string,Player>} players
 * @returns {{ batters: Player[], pitcherRotation: Player[] }}
 */
export function defaultLineup(team, players) {
  // Injured players are filtered out — they can't appear in the boxscore
  // and any dev hooks should skip them. The lineup builder doesn't import
  // injuries.js to avoid circular dep; we just check the flag directly.
  const isInjured = p => (p?.injury?.weeksRemaining || 0) > 0
  const roster = team.rosterPlayerIds.map(id => players[id]).filter(p => p && !isInjured(p))
  // Hitters: best 9 non-pitchers by avg contact + power
  const hitters = roster
    .filter(p => !p.isPitcher)
    .map(p => ({
      p,
      score: (p.hitter.contact_l + p.hitter.contact_r + p.hitter.power_l + p.hitter.power_r) / 4,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 9)
    .map(x => x.p)

  // Pitchers: best 5 by stuff + control
  const pitchers = roster
    .filter(p => p.isPitcher)
    .map(p => ({
      p,
      score: (p.pitcher.stuff + p.pitcher.control + p.pitcher.stamina) / 3,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(x => x.p)

  return { batters: hitters, pitcherRotation: pitchers }
}
