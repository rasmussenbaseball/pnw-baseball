/**
 * Player overall rating utilities.
 *
 * Madden/MLB The Show style: every player has a single 0-99 OVR number that
 * summarizes all their ratings. Used for quick legibility on the roster,
 * recruiting boards, lineup decisions, and ranking comparisons.
 *
 * OVR is computed (not stored) — it derives from the raw component ratings,
 * weighted by position. A great-arm SS contributes differently than a great-arm RF.
 */

/** @typedef {import('./types.js').Player} Player */
/** @typedef {import('./types.js').HitterRatings} HitterRatings */
/** @typedef {import('./types.js').PitcherRatings} PitcherRatings */
/** @typedef {import('./types.js').Position} Position */

// ─── Position weights for HITTER OVR ─────────────────────────────────────────
//
// Higher value = "this rating matters more for this position." For example,
// catcher's `arm`matters a lot, but `power_l/r`matters less than for 1B.

const HITTER_POSITION_WEIGHTS = {
  C:  { contact: 1.0, power: 0.8, discipline: 1.0, speed: 0.4, fielding: 1.4, arm: 1.6 },
  '1B': { contact: 1.0, power: 1.5, discipline: 1.0, speed: 0.4, fielding: 0.7, arm: 0.5 },
  '2B': { contact: 1.0, power: 0.8, discipline: 1.0, speed: 1.1, fielding: 1.3, arm: 1.0 },
  SS:  { contact: 1.0, power: 0.7, discipline: 1.0, speed: 1.2, fielding: 1.5, arm: 1.4 },
  '3B': { contact: 1.0, power: 1.3, discipline: 1.0, speed: 0.7, fielding: 1.1, arm: 1.2 },
  LF:  { contact: 1.0, power: 1.3, discipline: 1.0, speed: 1.0, fielding: 0.8, arm: 0.8 },
  CF:  { contact: 1.0, power: 1.0, discipline: 1.0, speed: 1.4, fielding: 1.3, arm: 1.0 },
  RF:  { contact: 1.0, power: 1.4, discipline: 1.0, speed: 0.9, fielding: 0.8, arm: 1.2 },
  DH:  { contact: 1.2, power: 1.6, discipline: 1.1, speed: 0.2, fielding: 0.0, arm: 0.0 },
}

// ─── Pitcher weights ─────────────────────────────────────────────────────────
//
// Starters value stamina, RPs value stuff and composure more.

const PITCHER_WEIGHTS_SP = { stuff: 1.4, control: 1.2, command: 1.2, stamina: 1.3, vs_split: 1.0, composure: 0.9, durability: 0.6 }
const PITCHER_WEIGHTS_RP = { stuff: 1.5, control: 1.2, command: 1.0, stamina: 0.6, vs_split: 0.9, composure: 1.3, durability: 0.7 }

// ─── Hitter OVR ──────────────────────────────────────────────────────────────

/**
 * Compute hitter overall (0-99) using position-weighted ratings.
 * @param {Player} player
 * @returns {number}
 */
export function hitterOverall(player) {
  if (!player.isHitter || !player.hitter) return 0
  const pos = player.primaryPosition
  const weights = HITTER_POSITION_WEIGHTS[pos] || HITTER_POSITION_WEIGHTS.LF
  const h = player.hitter

  // Use the higher of L/R contact + power (the side they swing more often)
  const contact = Math.max(h.contact_l, h.contact_r) * 0.7 + Math.min(h.contact_l, h.contact_r) * 0.3
  const power = Math.max(h.power_l, h.power_r) * 0.7 + Math.min(h.power_l, h.power_r) * 0.3

  const weighted =
    contact * weights.contact +
    power * weights.power +
    h.discipline * weights.discipline +
    h.speed * weights.speed +
    h.fielding * weights.fielding +
    h.arm * weights.arm
  const totalWeight =
    weights.contact + weights.power + weights.discipline +
    weights.speed + weights.fielding + weights.arm

  return Math.round(weighted / totalWeight)
}

// ─── Pitcher OVR ─────────────────────────────────────────────────────────────

/**
 * Compute pitcher overall (0-99). Uses SP weights for starters and RP weights for relievers.
 * @param {Player} player
 * @returns {number}
 */
export function pitcherOverall(player) {
  if (!player.isPitcher || !player.pitcher) return 0
  const isReliever = player.primaryPosition === 'RP'
  const w = isReliever ? PITCHER_WEIGHTS_RP : PITCHER_WEIGHTS_SP
  const p = player.pitcher
  const split = Math.max(p.vs_l, p.vs_r) * 0.6 + Math.min(p.vs_l, p.vs_r) * 0.4

  const weighted =
    p.stuff * w.stuff +
    p.control * w.control +
    p.command * w.command +
    p.stamina * w.stamina +
    split * w.vs_split +
    p.composure * w.composure +
    p.durability * w.durability
  const total = w.stuff + w.control + w.command + w.stamina + w.vs_split + w.composure + w.durability
  return Math.round(weighted / total)
}

// ─── Combined OVR (for two-way players, takes the higher side) ──────────────

/**
 * Overall = whichever side they're better at. For two-way players, the
 * "primary" rating they'd be evaluated on.
 * @param {Player} player
 * @returns {number}
 */
export function playerOverall(player) {
  const h = player.isHitter ? hitterOverall(player) : 0
  const p = player.isPitcher ? pitcherOverall(player) : 0
  return Math.max(h, p)
}

/**
 * Potential overall (what they'd be at full development).
 * @param {Player} player
 * @returns {number}
 */
export function playerPotentialOverall(player) {
  if (!player.hidden) return playerOverall(player)
  // Build a shadow player using the potential ratings and recompute
  const shadow = {
    ...player,
    hitter: player.hidden.potential_hitter || player.hitter,
    pitcher: player.hidden.potential_pitcher || player.pitcher,
  }
  return playerOverall(shadow)
}

/**
 * OVR color class for UI. Closely matches Madden's color tiers.
 */
export function overallTier(ovr) {
  if (ovr >= 88) return { tier: 'elite', color: 'text-purple-700', bg: 'bg-purple-100' }
  if (ovr >= 80) return { tier: 'gold', color: 'text-yellow-700', bg: 'bg-yellow-100' }
  if (ovr >= 72) return { tier: 'silver', color: 'text-gray-700', bg: 'bg-gray-200' }
  if (ovr >= 64) return { tier: 'bronze', color: 'text-amber-700', bg: 'bg-amber-50' }
  return { tier: 'developmental', color: 'text-gray-500', bg: 'bg-gray-50' }
}

// ─── Position changes ────────────────────────────────────────────────────────
//
// Players can be moved to a new primary position. The new position uses its
// own OVR weights (so a CF moving to RF will weight power more, speed less)
// AND the player's fielding rating takes a hit because they're learning a
// new spot. Bigger transitions = bigger fielding drop:
//
//   - Same group, similar difficulty (LF RF, 1B 3B):  −3 fielding
//   - Same group, harder spot (1B SS, LF CF):         −6 to −8
//   - OF IF crossover:                                  −12
//   - Anything C (catcher):                             −22 (very hard)
//   - C anything else:                                  −16
//   - Anything DH (designated hitter):                    0 (no defense)
//
// Penalty applies as a permanent bump on the player's fielding rating.

const HITTER_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH']

function positionGroup(pos) {
  if (pos === 'C') return 'C'
  if (['1B', '2B', '3B', 'SS'].includes(pos)) return 'IF'
  if (['LF', 'CF', 'RF'].includes(pos)) return 'OF'
  if (pos === 'DH') return 'DH'
  return 'P'
}

function positionDifficulty(pos) {
  // 0 = easiest, higher = harder defensively
  switch (pos) {
    case 'DH': return 0
    case '1B': return 1
    case 'LF': return 2
    case 'RF': return 2
    case '3B': return 3
    case '2B': return 4
    case 'CF': return 5
    case 'SS': return 6
    case 'C':  return 9
    default:   return 3
  }
}

/**
 * Fielding-rating penalty for moving a player's primary position from
 * `from` `to`. Positive number = points to subtract from current fielding.
 * Returns 0 if the move is to DH (or no actual change).
 *
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
export function positionChangePenalty(from, to) {
  if (!from || !to || from === to) return 0
  if (to === 'DH') return 0   // DH has no defense — no learning cost
  if (to === 'C')  return 22  // huge — catcher is the hardest spot
  if (from === 'C') return 16 // any catcher learning anywhere else
  const gA = positionGroup(from)
  const gB = positionGroup(to)
  if (gA !== gB) return 12     // OF IF crossover
  // Same group — fee depends on whether new spot is harder
  const diff = positionDifficulty(to) - positionDifficulty(from)
  if (diff <= 0) return 3      // moving to easier or same spot
  return Math.min(10, 3 + diff * 2)
}

/** List of position keys a hitter can be moved to. Excludes pitcher slots. */
export const HITTER_POSITION_OPTIONS = HITTER_POSITIONS

/**
 * Aggregate team OVR — average top-9 hitter OVR + top-5 pitcher OVR.
 *
 * `team.ovrOffset` (set at dynasty creation) shifts every output by the
 * same amount so the in-game Team OVR matches the deterministic value
 * shown on the team-picker tile (expectedTeamOvr in programRating.js).
 * Without this, roster randomness moves the starting Team OVR by ±2-3
 * even for the same school. Subsequent roster changes (recruits,
 * transfers, development) still flow through normally — the offset is
 * a constant, not a hard pin.
 */
export function teamOverall(team, players) {
  const roster = team.rosterPlayerIds.map(id => players[id]).filter(Boolean)
  const hitters = roster.filter(p => p.isHitter).map(hitterOverall).sort((a, b) => b - a).slice(0, 9)
  const pitchers = roster.filter(p => p.isPitcher).map(pitcherOverall).sort((a, b) => b - a).slice(0, 5)
  const avg = arr => arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : 0
  const offset = team.ovrOffset ?? 0
  return {
    overall: Math.round(avg(hitters) * 0.55 + avg(pitchers) * 0.45) + offset,
    hitting: Math.round(avg(hitters)) + offset,
    pitching: Math.round(avg(pitchers)) + offset,
  }
}
