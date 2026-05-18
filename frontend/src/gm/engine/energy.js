/**
 * Player energy / fatigue system.
 *
 * Each player's energy is a 0-100 number stored on state.playerEnergy[playerId].
 *   100 = fresh, ready to play full strength
 *    50 = noticeably tired — small skill hit, modest injury risk bump
 *    20 = gassed — meaningful skill hit + 2× injury risk
 *     0 = empty tank — heavy skill hit + huge injury risk
 *
 * The model is realistic-baseball-shaped, not strict-physiology:
 *
 *   - Per game costs (subtracted right after the game ends):
 *       Catcher                       30  pts
 *       Position player (IF/OF)       12  pts
 *       DH / pinch-only appearance     5  pts
 *       Pitcher: 0.55 pts per pitch    (~50 pts for a 90-pitch start)
 *
 *   - Doubleheader doubles up: if the same player appears in BOTH games of
 *     a doubleheader, game 2 burns the same cost again on TOP of whatever
 *     game 1 cost. Plus a flat -5 "second game of the day" multiplier-style
 *     extra hit so catchers / starters who do back-to-back are visibly cooked.
 *
 *   - Daily recovery happens once per week tick (the game loop's smallest
 *     unit is a week). Recovery scales with conditioning / durability:
 *       Position player:  +55 / week  (fully resets in 2 weeks even if cooked)
 *       Pitcher:          +35 / week  (slower — sore arms take longer)
 *       Bonus from durability rating: ±10 swing across the rating range
 *
 *   - Stamina (pitchers) also drives pitcher recovery — a 90-stamina arm
 *     bounces back faster than a 50-stamina arm.
 *
 * Sim impact (computed via energyMultiplier — see below):
 *   - Energy 100 → 1.00× ratings (no effect)
 *   - Energy  60 → 0.94× ratings
 *   - Energy  30 → 0.84× ratings
 *   - Energy   0 → 0.72× ratings  (28% across-the-board drop)
 *
 *   Specifically the (rating - 50) deviation is multiplied by the energy
 *   factor in the sim, so tired stars play more like average players and
 *   tired benchwarmers stay roughly the same (closer to 50).
 *
 * Injury risk multiplier:
 *   Energy 100 → 1.00× base risk
 *   Energy  50 → 1.45× base risk
 *   Energy   0 → 2.20× base risk
 */

const DEFAULT_ENERGY = 100

/** Bucketed cost when a player appears in a non-pitcher role for one game. */
function appearanceCost(player, position) {
  if (!player) return 0
  if (player.isPitcher) return 0          // pitcher cost handled by pitch count
  if (position === 'C') return 30
  if (position === 'DH') return 5
  if (position) return 12
  return 12
}

/** Pitcher cost, driven by pitches thrown this game. */
function pitchingCost(pitchesThrown, stamina = 50, durability = 50) {
  if (!pitchesThrown || pitchesThrown <= 0) return 0
  // 0.85 base (was 0.55). Calibrated so a 100-pitch outing at stamina 50
  // costs ~85 energy — leaves the pitcher near "done for ~5 days" rather
  // than the previous ~55 cost that let starters look fresh after 5 IP.
  const staminaMult = Math.max(0.75, 1.45 - (stamina / 100))   // 80 sta → 0.85, 30 sta → 1.30
  const durMult = Math.max(0.85, 1.15 - (durability / 200))
  return pitchesThrown * 0.85 * staminaMult * durMult
}

/**
 * Ensure the energy bag exists. Backward-compat: any player without an entry
 * is treated as fresh (100).
 */
export function ensureEnergyState(state) {
  if (!state.playerEnergy) state.playerEnergy = {}
}

export function getEnergy(state, playerId) {
  if (!state || !playerId) return DEFAULT_ENERGY
  if (!state.playerEnergy) return DEFAULT_ENERGY
  const v = state.playerEnergy[playerId]
  return typeof v === 'number' ? v : DEFAULT_ENERGY
}

export function setEnergy(state, playerId, value) {
  ensureEnergyState(state)
  state.playerEnergy[playerId] = Math.max(0, Math.min(100, value))
}

export function adjustEnergy(state, playerId, delta) {
  setEnergy(state, playerId, getEnergy(state, playerId) + delta)
}

/**
 * Apply energy costs after a game ends, given a "who played what" snapshot.
 *
 * @param {object} state             save state
 * @param {{ playerId: string, position?: string, pitchesThrown?: number, isSecondGameOfDay?: boolean }[]} appearances
 * @param {object} [opts]
 *   @param {object} [opts.players]  state.players (for stamina/durability lookups)
 */
export function applyGameEnergyCosts(state, appearances, opts = {}) {
  if (!Array.isArray(appearances) || appearances.length === 0) return
  ensureEnergyState(state)
  const players = opts.players || state.players || {}
  for (const a of appearances) {
    const p = players[a.playerId]
    if (!p) continue
    let cost = 0
    if (p.isPitcher && (a.pitchesThrown || 0) > 0) {
      cost = pitchingCost(a.pitchesThrown, p.pitcher?.stamina ?? 50, p.pitcher?.durability ?? 50)
    } else {
      cost = appearanceCost(p, a.position)
    }
    // Second-game-of-day surcharge — players who already played once
    // today are extra cooked. Catchers especially.
    if (a.isSecondGameOfDay) {
      cost += a.position === 'C' ? 12 : 5
    }
    adjustEnergy(state, a.playerId, -cost)
  }
}

/**
 * Daily recovery — run once per week tick for every player on the user's
 * roster. Recovery is asymmetric: pitchers recover more slowly than
 * position players because arm fatigue lingers.
 *
 * @param {object} state
 * @param {string[]} rosterPlayerIds
 */
export function tickWeeklyRecovery(state, rosterPlayerIds) {
  if (!Array.isArray(rosterPlayerIds)) return
  ensureEnergyState(state)
  const players = state.players || {}
  for (const pid of rosterPlayerIds) {
    const p = players[pid]
    if (!p) continue
    const current = getEnergy(state, pid)
    if (current >= 100) continue
    let recovery
    if (p.isPitcher) {
      const stamina = p.pitcher?.stamina ?? 50
      const dur = p.pitcher?.durability ?? 50
      // 25..55 range across rating spectrum
      recovery = 25 + (stamina - 50) * 0.30 + (dur - 50) * 0.10
      recovery = Math.max(15, Math.min(55, recovery))
    } else {
      const dur = p.hitter?.durability ?? 50
      // 45..70 range
      recovery = 45 + (dur - 50) * 0.20
      recovery = Math.max(30, Math.min(70, recovery))
    }
    setEnergy(state, pid, current + recovery)
  }
}

/**
 * Multi-day recovery between two games on the same date. Pitchers should
 * still be deep in the hole after a same-day start; position players bounce
 * back a small amount between games.
 */
export function tickIntraDayRecovery(state, rosterPlayerIds) {
  if (!Array.isArray(rosterPlayerIds)) return
  ensureEnergyState(state)
  const players = state.players || {}
  for (const pid of rosterPlayerIds) {
    const p = players[pid]
    if (!p) continue
    const current = getEnergy(state, pid)
    if (current >= 100) continue
    const recovery = p.isPitcher ? 5 : 18
    setEnergy(state, pid, current + recovery)
  }
}

/**
 * Multiplier applied to (rating - 50) deviation in the sim. At 100 energy
 * = 1.0. At 0 energy = 0.72. Tired stars regress toward 50.
 */
export function energyMultiplier(energy) {
  const e = Math.max(0, Math.min(100, energy ?? 100))
  // Linear: 1.0 at 100, 0.72 at 0
  return 0.72 + (e / 100) * 0.28
}

/** Injury-risk multiplier — exhausted = 2.2× base risk. */
export function energyInjuryMultiplier(energy) {
  const e = Math.max(0, Math.min(100, energy ?? 100))
  // Linear: 1.0 at 100, 2.2 at 0
  return 1.0 + (1 - e / 100) * 1.2
}

/** Human-readable label for the UI. */
export function energyLabel(energy) {
  const e = Math.max(0, Math.min(100, energy ?? 100))
  if (e >= 85) return 'Fresh'
  if (e >= 65) return 'Ready'
  if (e >= 45) return 'A little tired'
  if (e >= 25) return 'Tired'
  if (e >= 10) return 'Worn out'
  return 'Gassed'
}

/** Tailwind color helper for the energy chip. */
export function energyColorClass(energy) {
  const e = Math.max(0, Math.min(100, energy ?? 100))
  if (e >= 75) return 'text-emerald-400'
  if (e >= 50) return 'text-amber-300'
  if (e >= 25) return 'text-orange-400'
  return 'text-red-400'
}
