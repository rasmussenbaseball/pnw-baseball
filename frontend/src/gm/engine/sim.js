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

const BASE_RATES = {
  K:       0.22,
  BB:      0.105,
  HBP:     0.015,
  HR:      0.032,
  TRIPLE:  0.006,
  DOUBLE:  0.05,
  SINGLE:  0.175,
  ERROR:   0.010,   // batter reaches on E
  OUT:     0.387,   // includes potential sacrifices, GIDP, regular outs
}

const ALPHA = 0.6   // ratings dominance vs random variance

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
export function fastSimGame(home, away, seedKey) {
  const rng = makeRng('fast', seedKey)
  // Expected runs from offense - opposing pitching diff
  const homeExp = clamp(5 + (home.offense_rating - away.pitching_rating) * 1.8 + 0.3, 0, 25)
  const awayExp = clamp(5 + (away.offense_rating - home.pitching_rating) * 1.8, 0, 25)
  // Sample with Poisson-ish noise
  const homeRuns = Math.max(0, Math.round(rng.gaussian(homeExp, 3)))
  const awayRuns = Math.max(0, Math.round(rng.gaussian(awayExp, 3)))
  // Avoid ties — extra innings shouldn't be a regular outcome
  if (homeRuns === awayRuns) {
    return rng.chance(0.5)
      ? { homeRuns: homeRuns + 1, awayRuns }
      : { homeRuns, awayRuns: awayRuns + 1 }
  }
  return { homeRuns, awayRuns }
}

// ─── PA-level full sim ───────────────────────────────────────────────────────

/**
 * Sim a single PA. Returns an outcome.
 * @param {Player} batter
 * @param {Player} pitcher
 * @param {{ leverage: number, defenders?: Player[], coachMotivator?: number }} ctx
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @returns {{ outcome: string, type?: string }}
 */
export function simPA(batter, pitcher, ctx, rng) {
  const hand = pitcher.throws === 'L' ? 'l' : 'r'
  const oppHand = batter.bats === 'L' ? 'l' : batter.bats === 'S' ? (hand === 'l' ? 'r' : 'l') : 'r'
  // Pull ratings — fallback to neutral 50 if missing
  const contact = batter.hitter[`contact_${oppHand}`] ?? 50
  const power = batter.hitter[`power_${oppHand}`] ?? 50
  const discipline = batter.hitter.discipline ?? 50
  const speed = batter.hitter.speed ?? 50

  const stuff = pitcher.pitcher.stuff ?? 50
  const control = pitcher.pitcher.control ?? 50
  const command = pitcher.pitcher.command ?? 50
  const vsBatter = pitcher.pitcher[`vs_${oppHand}`] ?? 50

  // Adjustments (each logit-style). All centered around 50, normalized.
  // Pitcher control drives BB AND HBP — bad control = more free bases.
  // Pitcher command separately drives HR rate suppression.
  const adj = {
    K:    (-(discipline - 50) + (contact - 50) * -0.3 - (stuff - 50) - (vsBatter - 50)) / 50,
    BB:   ((discipline - 50) - (control - 50) * 1.2) / 50,
    HBP:  (-(control - 50) * 0.9) / 50,                                 // bumped — control matters a lot for HBP
    HR:   ((power - 50) - (command - 50) * 1.1 - (stuff - 50) * 0.5) / 50,
    SINGLE: ((contact - 50) + (speed - 50) * 0.2 - (stuff - 50) * 0.5) / 50,
    DOUBLE: ((power - 50) * 0.4 + (speed - 50) * 0.3) / 50,
    TRIPLE: ((speed - 50) * 0.5 + (power - 50) * 0.2) / 50,
    ERROR: 0,    // not rating-driven — uses defender fielding (handled at runner-advance time)
    OUT: 0,
  }

  // Apply ratings to baseline probabilities (multiplicative log-odds shift)
  /** @type {Object<string,number>} */
  const probs = {}
  for (const [k, base] of Object.entries(BASE_RATES)) {
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
    const t = rng.weighted(['groundout', 'flyout', 'lineout', 'popout'], [45, 35, 15, 5])
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
 * @param {Object} homeLineup   {batters: Player[9], pitcherRotation: Player[]}
 * @param {Object} awayLineup
 * @param {{ homeMotivator?: number, awayMotivator?: number }} ctx
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
    homePitcherIdx: 0,
    awayPitcherIdx: 0,
    homePAs: 0,
    awayPAs: 0,
    log: [],
  }

  // Per-player stat trackers — populated in this game
  /** @type {Object<string, {ab:number,h:number,d:number,t:number,hr:number,bb:number,k:number,rbi:number,pa:number}>} */
  const batterStats = {}
  /** @type {Object<string, {ip:number,h:number,bb:number,k:number,er:number,outs:number,pa:number}>} */
  const pitcherStats = {}
  function bStat(id) { if (!batterStats[id]) batterStats[id] = {ab:0,h:0,d:0,t:0,hr:0,bb:0,k:0,rbi:0,pa:0,hbp:0,sf:0,sac:0,gidp:0,roe:0}; return batterStats[id] }
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
    let result = simPA(batter, pitcher, { leverage, coachMotivator: motivator }, rng)
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

    // Check pitcher fatigue — naive: swap after ~25 PAs
    const pas = state.top ? state.awayPAs : state.homePAs   // PAs faced (rough)
    if (pas > 25 + pitcherIdx * 12) {
      if (state.top) state.homePitcherIdx = Math.min(state.homePitcherIdx + 1, defending.pitcherRotation.length - 1)
      else state.awayPitcherIdx = Math.min(state.awayPitcherIdx + 1, defending.pitcherRotation.length - 1)
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

  // Finalize: convert outs → innings pitched (IP = outs/3)
  for (const id of Object.keys(pitcherStats)) {
    pitcherStats[id].ip = pitcherStats[id].outs / 3
  }

  return {
    homeRuns: state.homeRuns,
    awayRuns: state.awayRuns,
    innings: state.inning,
    log: state.log,
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
