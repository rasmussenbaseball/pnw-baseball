/**
 * Player development system.
 *
 * TWO entry points by design — half of yearly dev comes in-season from real
 * performance, half from the post-season "Summer Check-In" at Wk 44.
 *
 *   1. applyWeeklyDevelopment(state) — runs in simWeek for each user player
 *      who appeared in games that week. Rate-based stat thresholds drive
 *      small per-week deltas. If you're not walking anyone, your command
 *      goes up. If you're striking out every other AB, your discipline drops.
 *      No randomness — every change has a real stats reason. Magnitudes
 *      are small (0.1-0.5 per stat per week) so a single bad week doesn't
 *      tank a player. Accumulates over 13 reg-season weeks.
 *
 *   2. endOfSeasonDevelopment(player, ctx) — the big "Summer Check-In" pass
 *      at Wk 44. Combines: class year, playing time, performance score,
 *      coach quality, budget. Potential rating acts as a SPEED MULTIPLIER
 *      (high pot = faster grower) — it is NOT a hard ceiling. Players can
 *      keep getting better past their potential rating if they keep
 *      producing.
 *
 *   3. tickPotentialEOY(player, seasonStats) — also at Wk 44. Adjusts the
 *      player's POTENTIAL rating itself based on the season:
 *        - Overperformance: +1 to +3 potential across ratings
 *        - Underperformance with playing time: -1 to -3
 *        - No play time: 0 change (you can't drop in potential for not
 *          getting reps)
 *      Most players see ±1-2 movement. Big swings rare.
 *
 *   4. applyScrimmageDev(playersInScrimmage, ...) — tiny per-scrimmage
 *      bump kept for fall ball dev mechanic. Same potential-as-speed model.
 *
 * Incoming recruits don't develop until they actually JOIN the roster
 * (handled by class finalize). Graduating seniors (eligibility=graduated)
 * don't develop in the EOY pass.
 */

import { makeRng } from './rng'

/** @typedef {import('./types.js').Player} Player */

const HITTER_KEYS = ['contact_l', 'contact_r', 'power_l', 'power_r', 'discipline', 'speed', 'fielding', 'arm', 'composure', 'durability']
const PITCHER_KEYS = ['stuff', 'control', 'command', 'stamina', 'vs_l', 'vs_r', 'composure', 'durability']

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// ─── Performance score (used by EOY dev + potential drift) ─────────────────

/**
 * Convert a player's season stats into a 0-1 performance score.
 * 0 = bad relative to NAIA average, 0.5 = average, 1 = elite.
 *
 * @param {Player} player
 * @param {object|null} stats
 */
export function performanceScore(player, stats) {
  if (!stats) return 0.4
  if (player.isPitcher) {
    if ((stats.ip || 0) < 10) return 0.4
    const era = (stats.er || 0) * 9 / Math.max(0.1, stats.ip)
    const kbb = (stats.k || 0) / Math.max(1, stats.bb || 0)
    const eraScore = clamp(1 - (era - 2.5) / 6, 0, 1)
    const kbbScore = clamp((kbb - 1) / 4, 0, 1)
    return eraScore * 0.6 + kbbScore * 0.4
  }
  if ((stats.ab || 0) < 20) return 0.4
  const avg = stats.h / Math.max(1, stats.ab)
  const obp = (stats.h + (stats.bb || 0)) / Math.max(1, stats.ab + (stats.bb || 0))
  const slg = (stats.h - (stats.d || 0) - (stats.t || 0) - (stats.hr || 0)
               + 2 * (stats.d || 0) + 3 * (stats.t || 0) + 4 * (stats.hr || 0))
              / Math.max(1, stats.ab)
  const avgScore = clamp((avg - 0.220) / 0.180, 0, 1)
  const obpScore = clamp((obp - 0.300) / 0.180, 0, 1)
  const slgScore = clamp((slg - 0.330) / 0.220, 0, 1)
  return avgScore * 0.3 + obpScore * 0.35 + slgScore * 0.35
}

// ─── Potential-as-speed multiplier ─────────────────────────────────────────

/**
 * Potential acts as a growth SPEED coefficient — not a ceiling.
 *   Potential 99 ~1.45× growth
 *   Potential 70 1.0×
 *   Potential 50 ~0.7×
 *   Potential 30 ~0.4×
 *
 * @param {number} potRating
 */
function potSpeedMult(potRating) {
  if (potRating == null) return 1.0
  return Math.max(0.35, Math.min(1.5, potRating / 70))
}

// ─── In-season weekly development ──────────────────────────────────────────

/**
 * Drive small per-week rating changes from real season-to-date stats. Runs
 * at the end of simWeek for every user player who appeared in any game this
 * week.
 *
 * Hitters — read AVG, K%, BB%, ISO against NAIA averages:
 *   AVG > .330 contact + 0.4 (good bat-to-ball)
 *   AVG < .230 contact - 0.3
 *   K%  < .15  discipline + 0.3
 *   K%  > .30  discipline - 0.2
 *   BB% > .12  discipline + 0.3
 *   ISO > .180 power     + 0.3
 *   ISO < .080 power     - 0.2 (no extra-base hits)
 *
 * Pitchers — read BB/9, K/9, HR/9, ERA, IP:
 *   BB/9 < 3   control + 0.4 (filling up zone)
 *   BB/9 > 5   control - 0.3
 *   K/9  > 10  stuff   + 0.3
 *   HR/9 < .5  command + 0.3
 *   HR/9 > 2   command - 0.3
 *   ERA  < 3   composure + 0.2
 *   ERA  > 7   composure - 0.2
 *   IP > 5 in week stamina + 0.1, durability + 0.1
 *
 * Magnitude modulated by:
 *   - potential rating (potSpeedMult — high pot grows faster)
 *   - class year (FR/SO learn faster than SR)
 *
 * Mutates player.hitter / player.pitcher and adds a `_weeklyDevSummary`
 * payload the WeekRecap can surface.
 *
 * @param {Player} player
 * @param {object} seasonStats   season-to-date totals
 */
export function applyWeeklyDevelopment(player, seasonStats) {
  if (!player || !seasonStats) return
  const classMult = { FR: 1.2, SO: 1.0, JR: 0.8, SR: 0.5 }[player.classYear] ?? 0.8

  const deltas = {}   // { ratingKey: delta }
  const reasons = []  // [{ rating, delta, reason }]
  function bump(rating, base, reason) {
    if (base === 0) return
    const block = player.isPitcher ? player.pitcher : player.hitter
    const pot = (player.isPitcher
      ? player.hidden?.potential_pitcher?.[rating]
      : player.hidden?.potential_hitter?.[rating])
    const speed = potSpeedMult(pot)
    // Growth scales with potential speed; declines are LESS modulated
    // (everyone declines at roughly the same rate from bad play).
    const mult = base > 0 ? speed * classMult : (0.5 + classMult * 0.3)
    const d = base * mult
    deltas[rating] = (deltas[rating] || 0) + d
    reasons.push({ rating, delta: d, reason })
  }

  if (player.isHitter && !player.isPitcher) {
    const ab = seasonStats.ab || 0
    if (ab >= 25) {
      const h = seasonStats.h || 0
      const k = seasonStats.k || 0
      const bb = seasonStats.bb || 0
      const xbh = (seasonStats.d || 0) + (seasonStats.t || 0) + (seasonStats.hr || 0)
      const pa = ab + bb + (seasonStats.hbp || 0) + (seasonStats.sf || 0)
      const avg = h / ab
      const kPct = pa > 0 ? k / pa : 0
      const bbPct = pa > 0 ? bb / pa : 0
      const iso = xbh / ab + (seasonStats.hr || 0) / ab    // approximate ISO

      // Contact (apply to whichever side is weaker so dominant side stays balanced)
      if (avg >= 0.330) { bump('contact_l', 0.4, `hitting ${avg.toFixed(3)}`); bump('contact_r', 0.4, '') }
      else if (avg <= 0.230) { bump('contact_l', -0.3, `hitting only ${avg.toFixed(3)}`); bump('contact_r', -0.3, '') }
      // Discipline
      if (kPct <= 0.15) bump('discipline', 0.3, `low K% (${(kPct*100).toFixed(0)}%)`)
      else if (kPct >= 0.30) bump('discipline', -0.2, `chasing — K% ${(kPct*100).toFixed(0)}%`)
      if (bbPct >= 0.12) bump('discipline', 0.3, `walking — BB% ${(bbPct*100).toFixed(0)}%`)
      // Power
      if (iso >= 0.180) { bump('power_l', 0.3, `ISO ${iso.toFixed(3)}`); bump('power_r', 0.3, '') }
      else if (iso <= 0.080) { bump('power_l', -0.2, `low ISO ${iso.toFixed(3)}`); bump('power_r', -0.2, '') }
    }
  } else if (player.isPitcher) {
    const ip = seasonStats.ip || 0
    if (ip >= 5) {
      const er = seasonStats.er || 0
      const bb = seasonStats.bb || 0
      const k = seasonStats.k || 0
      const hr = seasonStats.hr || 0
      const era = er * 9 / ip
      const bb9 = bb * 9 / ip
      const k9 = k * 9 / ip
      const hr9 = hr * 9 / ip

      if (bb9 <= 3.0) bump('control', 0.4, `BB/9 ${bb9.toFixed(1)} — filling up zone`)
      else if (bb9 >= 5.0) bump('control', -0.3, `BB/9 ${bb9.toFixed(1)} — wild`)
      if (k9 >= 10) bump('stuff', 0.3, `K/9 ${k9.toFixed(1)} — missing bats`)
      if (hr9 <= 0.5) bump('command', 0.3, `HR/9 ${hr9.toFixed(2)} — staying down`)
      else if (hr9 >= 2.0) bump('command', -0.3, `HR/9 ${hr9.toFixed(2)} — getting squared up`)
      if (era < 3.0) bump('composure', 0.2, `ERA ${era.toFixed(2)} — bearing down`)
      else if (era > 7.0) bump('composure', -0.2, `ERA ${era.toFixed(2)}`)
      // Workload-driven stamina + durability (per heavy outing)
      if (ip >= 12) {   // accumulated 12+ IP across all games this season
        bump('stamina', 0.1, '')
        bump('durability', 0.1, '')
      }
    }
  }

  // Apply deltas
  const block = player.isPitcher ? player.pitcher : player.hitter
  if (!block) return
  for (const [k, d] of Object.entries(deltas)) {
    if (typeof block[k] !== 'number') continue
    block[k] = clamp(Math.round((block[k] + d) * 10) / 10, 20, 99)
  }
  // Stash a brief summary on the player for any UI that wants it
  player._weeklyDev = { week: null, reasons: reasons.filter(r => Math.abs(r.delta) >= 0.1) }
}

// ─── End-of-year "Summer Check-In" development ─────────────────────────────

/**
 * The big EOY dev pass at Wk 44. Combines class year, playing time,
 * performance score, coach quality, and budget. Potential = SPEED multiplier
 * per rating, NOT a ceiling. Growth can push a rating PAST a player's
 * current potential value (the potential drift function handles updating
 * the potential rating itself afterward).
 *
 * @param {Player} player
 * @param {{
 *   coachDeveloper: number,
 *   paShare: number, ipShare: number,
 *   budgetEffects: any,
 *   seasonStats?: any,
 * }} ctx
 * @param {number} seed
 * @returns {Player}
 */
export function endOfSeasonDevelopment(player, ctx, seed) {
  const rng = makeRng('eosDev', player.id, seed)
  const workEthic = player.hidden?.work_ethic ?? 60
  const coachDev = ctx.coachDeveloper ?? 55
  const classBase = { FR: 1.0, SO: 0.85, JR: 0.65, SR: 0.40 }[player.classYear] ?? 0.5
  const playingTime = player.isPitcher ? (ctx.ipShare ?? 0) : (ctx.paShare ?? 0)
  const ptMult = Math.max(0.4, Math.min(1.4, playingTime * 2))
  const coachMult = 0.7 + (coachDev / 100) * 0.6
  const ethicMult = 0.7 + (workEthic / 100) * 0.6
  const budgetMult = ctx.budgetEffects?.devMultiplier
    ?? (1 + ((ctx.budgetEffects?.facilitiesDrift ?? 0) / 30))

  // Performance score — strong performers grow more even if they're an SR.
  const perfScore = performanceScore(player, ctx.seasonStats)
  const perfMult = 0.5 + perfScore * 1.2

  const magnitude = classBase * ptMult * coachMult * ethicMult * budgetMult * perfMult

  let totalGain = 0
  const block = player.isPitcher ? player.pitcher : player.hitter
  const potBlock = player.isPitcher
    ? player.hidden?.potential_pitcher
    : player.hidden?.potential_hitter
  if (!block) return { ...player, _devGain: 0 }

  // Per-rating growth, modulated by potential as a SPEED multiplier.
  // Magnitude budget ~ 6 across 8-10 ratings = ~0.6-0.8 per rating mean
  // gain (with variance + potential modulation). Bad performers can DROP.
  for (const k of Object.keys(block)) {
    if (k.startsWith('velocity')) continue
    const pot = potBlock?.[k] ?? 70
    const speed = potSpeedMult(pot)
    // Base growth per rating from magnitude — positive if magnitude > 1.0
    // (above-average season), negative if magnitude < ~0.6 (poor season).
    const center = (magnitude - 0.9) * 2   // -1.8 to +2.0 typical band
    const drawn = rng.gaussian(center, 0.7) * speed
    const change = Math.round(drawn * 10) / 10
    if (change === 0) continue
    const before = block[k]
    block[k] = clamp(Math.round((before + change) * 10) / 10, 20, 99)
    totalGain += (block[k] - before)
  }

  // Stamina workload growth — preserved from old code, pitchers who throw
  // a lot build stamina above their normal dev pace.
  if (player.isPitcher && typeof block.stamina === 'number') {
    const workloadStaminaGain = clamp((ctx.ipShare ?? 0) * 3 * ethicMult, 0, 4)
    block.stamina = clamp(Math.round((block.stamina + workloadStaminaGain) * 10) / 10, 20, 99)
  }

  return { ...player, _devGain: totalGain }
}

// ─── Potential drift ───────────────────────────────────────────────────────

/**
 * Adjust the player's POTENTIAL rating itself based on the season they had.
 * Most players sit still or move ±1-2; big swings rare.
 *
 *   - Great stats + meaningful playing time: +1 to +3 across all ratings
 *   - Above-average stats: +0 to +1
 *   - Below average: -1 to 0
 *   - Bad stats with meaningful playing time: -1 to -3
 *   - No play time: 0 change (can't lose potential for being on the bench)
 *
 * Mutates player.hidden.potential_* in place.
 *
 * @param {Player} player
 * @param {object|null} seasonStats
 * @param {number} seed
 */
export function tickPotentialEOY(player, seasonStats, seed) {
  if (!player?.hidden) return
  const rng = makeRng('potDrift', player.id, seed)
  const perfScore = performanceScore(player, seasonStats)
  // Playing-time gate — players who didn't play don't gain or lose potential
  const ip = seasonStats?.ip || 0
  const ab = seasonStats?.ab || 0
  const hasMeaningfulTime = player.isPitcher ? ip >= 20 : ab >= 40
  if (!hasMeaningfulTime) return

  // Drift direction + magnitude
  let driftMean
  if (perfScore >= 0.80) driftMean = 2.0       // crushed it
  else if (perfScore >= 0.65) driftMean = 0.8  // above average
  else if (perfScore >= 0.45) driftMean = 0.0  // average — no movement
  else if (perfScore >= 0.30) driftMean = -1.0 // below
  else driftMean = -2.0                         // terrible

  const block = player.isPitcher
    ? player.hidden.potential_pitcher
    : player.hidden.potential_hitter
  if (!block) return

  for (const k of Object.keys(block)) {
    // Per-rating jitter so not every stat moves the same amount
    const drift = Math.round(rng.gaussian(driftMean, 1.0))
    if (drift === 0) continue
    block[k] = clamp(block[k] + drift, 20, 99)
  }
}

// ─── Weight fluctuation (yearly drift toward mature target) ────────────────

/**
 * Drift the player's weight toward their `targetMatureWeightLbs`. Runs once
 * a year at the Summer Check-In. Most players gain weight in college as
 * they fill out; some lose weight if they came in over their target.
 *
 *   Gain (toward target if underweight)  +power/velo a bit
 *   Lose (toward target if overweight)   +speed / +stamina / +durability
 *   Already at target                    no change
 *
 * Drift is ~40% of the remaining gap each year, with noise. Some players
 * don't drift at all (10% chance — they're an outlier who never fills out
 * or never trims). Height never changes.
 *
 * @param {Player} player
 * @param {number} seed
 */
export function tickWeightFluctuation(player, seed) {
  if (!player?.measurables) return
  const cur = player.measurables.weightLbs
  const target = player.measurables.targetMatureWeightLbs
  if (cur == null || target == null) return
  const rng = makeRng('weightDrift', player.id, seed)
  // 10% of players don't drift at all this year
  if (rng.chance(0.10)) return
  const gap = target - cur
  if (Math.abs(gap) < 1.5) return   // already there
  // Drift ~40% of remaining gap + noise. Per-year delta typically ±2-6 lb.
  const drift = Math.round(gap * 0.4 + rng.gaussian(0, 1.5))
  if (Math.abs(drift) < 1) return
  player.measurables.weightLbs = cur + drift
  // Apply rating boosts based on direction. Magnitudes are small per year
  // so they compound over a 4-year career without being overwhelming.
  const block = player.isPitcher ? player.pitcher : player.hitter
  if (!block) return
  if (drift > 0) {
    // Gained weight — adds power / velo
    if (player.isPitcher) {
      if (typeof block.stuff === 'number') block.stuff = clamp(block.stuff + rng.gaussian(0.6, 0.3), 20, 99)
      // Also tick the velocity numbers if present
      if (typeof block.velocity_avg === 'number') {
        block.velocity_avg = Math.round((block.velocity_avg + rng.gaussian(0.5, 0.25)) * 10) / 10
        block.velocity_min = Math.round((block.velocity_min + rng.gaussian(0.5, 0.25)) * 10) / 10
        block.velocity_max = Math.round((block.velocity_max + rng.gaussian(0.5, 0.25)) * 10) / 10
      }
    } else {
      if (typeof block.power_l === 'number') block.power_l = clamp(block.power_l + rng.gaussian(0.7, 0.3), 20, 99)
      if (typeof block.power_r === 'number') block.power_r = clamp(block.power_r + rng.gaussian(0.7, 0.3), 20, 99)
      // Refresh max EV measurable
      const pw = Math.max(block.power_l || 0, block.power_r || 0)
      const ht = player.measurables.heightInches || 70
      const sizeBoost = Math.max(0, (ht - 70) * 0.4)
      player.measurables.maxEvMph = Math.round((88 + (pw - 50) * 0.5 + sizeBoost) * 10) / 10
    }
  } else {
    // Lost weight — adds speed, stamina, durability
    if (typeof block.stamina === 'number') block.stamina = clamp(block.stamina + rng.gaussian(0.5, 0.25), 20, 99)
    if (typeof block.durability === 'number') block.durability = clamp(block.durability + rng.gaussian(0.5, 0.25), 20, 99)
    if (!player.isPitcher && typeof block.speed === 'number') {
      block.speed = clamp(block.speed + rng.gaussian(0.6, 0.3), 20, 99)
      // Refresh 60-yard measurable
      player.measurables.sixtyYardSec = Math.round((7.0 - (block.speed - 50) * 0.012) * 100) / 100
    }
  }
}

// ─── Scrimmage dev (small per-scrimmage bump) ──────────────────────────────

/**
 * Per-scrimmage development bump — only for players who actually played.
 * Smaller magnitude than season-end progression. Uses potential as speed.
 *
 * @param {Player[]} playersInScrimmage
 * @param {string} scrimmageSeriesId      // for deterministic seeding
 * @returns {Player[]}  shallow-copied players with bumped ratings
 */
export function applyScrimmageDev(playersInScrimmage, scrimmageSeriesId) {
  return playersInScrimmage.map((p, i) => {
    const rng = makeRng('scrimDev', p.id, scrimmageSeriesId, i)
    const block = p.isPitcher ? { ...(p.pitcher || {}) } : { ...(p.hitter || {}) }
    const potBlock = p.isPitcher
      ? p.hidden?.potential_pitcher
      : p.hidden?.potential_hitter
    for (const k of Object.keys(block)) {
      if (k.startsWith('velocity')) continue
      const pot = potBlock?.[k] ?? 70
      const speed = potSpeedMult(pot)
      // Small chance to bump (~50%), magnitude 0.3-0.8 per stat
      if (!rng.chance(0.4)) continue
      const bump = Math.round(rng.gaussian(0.5, 0.2) * speed * 10) / 10
      block[k] = clamp(Math.round((block[k] + bump) * 10) / 10, 20, 99)
    }
    return p.isPitcher ? { ...p, pitcher: block } : { ...p, hitter: block }
  })
}

/**
 * Passive offseason practice / conditioning dev. Fires once per offseason
 * week from advanceOneWeek for players on the user's roster. Magnitude is
 * scaled by `rateMult` so we can have:
 *   - Fall Camp / Winter Practice: 1.0  (full practice)
 *   - Fall Conditioning (Nov):     0.5  (conditioning only — half rate)
 *   - December Break / Late Summer / Summer Recruiting: skipped at the call site
 *
 * Per-player magnitude is intentionally TINY (smaller than scrimmage dev
 * and far smaller than in-season weekly dev). It represents the small,
 * incremental gains that come from being in the gym + cage between games.
 *
 * @param {Player[]} players
 * @param {number} rateMult         multiplier on bump rate + magnitude
 * @param {string|number} seed      deterministic seed for the week
 */
export function applyOffseasonPracticeDev(players, rateMult, seed) {
  if (!players || players.length === 0 || rateMult <= 0) return 0
  let bumped = 0
  for (const p of players) {
    if (p.eligibilityStatus === 'graduated' || p.eligibilityStatus === 'cut' ||
        p.eligibilityStatus === 'dismissed') continue
    if ((p.injury?.weeksRemaining || 0) > 0) continue
    const rng = makeRng('offDev', p.id, seed)
    const block = p.isPitcher ? p.pitcher : p.hitter
    if (!block) continue
    const potBlock = p.isPitcher ? p.hidden?.potential_pitcher : p.hidden?.potential_hitter
    let anyBump = false
    for (const k of Object.keys(block)) {
      if (k.startsWith('velocity')) continue
      const cur = block[k]
      const pot = potBlock?.[k] ?? 70
      if (cur >= pot) continue   // already capped at potential
      const speed = potSpeedMult(pot)
      // ~20% chance per stat per week at full rate (so a player typically
      // gets 1-2 small bumps per offseason week). Conditioning-only halves
      // both rate and magnitude.
      if (!rng.chance(0.2 * rateMult)) continue
      const bump = Math.round(rng.gaussian(0.4, 0.15) * speed * rateMult * 10) / 10
      if (bump <= 0) continue
      block[k] = clamp(Math.round((cur + bump) * 10) / 10, 20, pot)
      anyBump = true
    }
    if (anyBump) bumped++
  }
  return bumped
}

// ─── Back-compat exports ───────────────────────────────────────────────────

// The performanceScore helper is needed externally by events.js
export { potSpeedMult }
