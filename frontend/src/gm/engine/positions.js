/**
 * Position-fit utilities — used by the lineup editor and the sim engine to:
 *
 *   1. Sort the player picker so guys at the slot's position float to the top,
 *      then "athletic neighbors" (small fielding drop), then everyone else.
 *   2. Apply a TEMPORARY fielding penalty when a player is forced out of
 *      position for a single game. The penalty isn't stored on the player —
 *      it's computed on the fly per-game so DH'ing a SS once doesn't follow
 *      him forever.
 *
 * Penalty model (per-game fielding hit):
 *   - 'NATIVE'    (primary, OR listed in player.positions): 0 points
 *   - 'NEIGHBOR'  (athletic-family neighbor): -6 fielding
 *   - 'STRETCH'   (corner-corner-ish, OF-OF, or 3B/1B-corner OF): -12 fielding
 *   - 'OUT'       (anything else): -22 fielding
 *
 * The C → anything-other-than-C is always at least STRETCH, even when the
 * player is athletic, because catching mechanics are too specific to pick up
 * in a single game. A position player thrown behind the plate is OUT (-22).
 *
 * DH is a free slot — never penalized. The penalty only applies when the
 * player is in the field at a position that isn't theirs.
 */

/** @typedef {'C'|'1B'|'2B'|'SS'|'3B'|'LF'|'CF'|'RF'|'DH'} FieldPosition */

/**
 * Adjacency map: which positions are "small drop" neighbors of each other.
 * Symmetric — if X is a neighbor of Y, Y is a neighbor of X.
 *
 * - 1B/3B share the corner-infield bucket (different but transferable).
 * - 2B/SS share the middle-infield bucket.
 * - LF/RF share the corner-outfield bucket.
 * - CF is a middle-infield-style athlete — also a neighbor of 2B/SS.
 * - 3B and SS share a side (left side of infield) — neighbor.
 * - 1B and corner OF — neighbor (slow-bat profile).
 * - C is intentionally isolated.
 */
const NEIGHBORS = {
  C:  [],
  '1B': ['3B', 'LF', 'RF'],
  '2B': ['SS', 'CF'],
  '3B': ['1B', 'SS'],
  SS:  ['2B', '3B', 'CF'],
  LF:  ['RF', 'CF', '1B'],
  CF:  ['LF', 'RF', '2B', 'SS'],
  RF:  ['LF', 'CF', '1B'],
}

/**
 * Anything-to-anything stretch: 1 step beyond NEIGHBOR. Used for ranking the
 * player picker. STRETCH = "guy CAN play here but he'll take a real defensive
 * hit". OUT = "this is a defensive trainwreck."
 *
 * Stretches:
 *  - All OF positions can stretch to all IF positions and vice versa
 *  - 1B can stretch to 2B/SS (he's an athlete-ish corner)
 *  - 3B can stretch to corner OF
 *
 * Catchers are still STRETCH at NOTHING — they go straight to OUT.
 */
const STRETCHES = {
  C:  ['1B'],
  '1B': ['2B', 'SS', 'CF'],
  '2B': ['3B', '1B', 'LF', 'RF'],
  '3B': ['2B', 'LF', 'RF', 'CF'],
  SS:  ['1B', 'LF', 'RF'],
  LF:  ['2B', '3B', 'SS'],
  CF:  ['1B', '3B'],
  RF:  ['2B', '3B', 'SS'],
}

/**
 * Classify how natural a position is for a player.
 *
 * @param {{ primaryPosition?: string, positions?: string[] }} player
 * @param {FieldPosition} pos
 * @returns {'NATIVE'|'NEIGHBOR'|'STRETCH'|'OUT'}
 */
export function positionFit(player, pos) {
  if (!player || !pos || pos === 'DH') return 'NATIVE'
  const owned = new Set([
    ...(player.primaryPosition ? [player.primaryPosition] : []),
    ...(player.positions || []),
  ])
  if (owned.has(pos)) return 'NATIVE'

  // C is special — non-C primary is always at least STRETCH for the C slot,
  // and a C primary asked to play elsewhere is at least STRETCH (catcher
  // skills don't transfer cleanly).
  if (pos === 'C' || player.primaryPosition === 'C') {
    if (owned.has(pos)) return 'NATIVE'
    return 'OUT'
  }

  // Try neighbor / stretch via the player's primary OR any listed position.
  for (const ownedPos of owned) {
    if ((NEIGHBORS[ownedPos] || []).includes(pos)) return 'NEIGHBOR'
  }
  for (const ownedPos of owned) {
    if ((STRETCHES[ownedPos] || []).includes(pos)) return 'STRETCH'
  }
  return 'OUT'
}

/**
 * Numeric ranking for sorting the player picker — lower = better fit.
 * Within the same fit bucket, sort by overall fielding desc.
 */
export function positionFitRank(player, pos) {
  switch (positionFit(player, pos)) {
    case 'NATIVE':   return 0
    case 'NEIGHBOR': return 1
    case 'STRETCH':  return 2
    case 'OUT':      return 3
    default:         return 9
  }
}

/**
 * Per-game fielding penalty (points subtracted from this defender's fielding
 * rating, ONLY for the duration of the current game). Returns 0 for DH (no
 * field) or NATIVE positions.
 */
export function fieldingPenalty(player, pos) {
  if (!player || !pos || pos === 'DH') return 0
  switch (positionFit(player, pos)) {
    case 'NATIVE':   return 0
    case 'NEIGHBOR': return 6
    case 'STRETCH':  return 12
    case 'OUT':      return 22
    default:         return 0
  }
}

/**
 * Short label for the lineup UI ("Native", "Neighbor", "Stretch", "Out").
 * Returns null for NATIVE (no badge shown).
 */
export function positionFitLabel(player, pos) {
  if (!player || !pos || pos === 'DH') return null
  const fit = positionFit(player, pos)
  if (fit === 'NATIVE') return null
  if (fit === 'NEIGHBOR') return 'Off-position (-6 DEF)'
  if (fit === 'STRETCH')  return 'Stretch position (-12 DEF)'
  if (fit === 'OUT')      return 'OUT OF POSITION (-22 DEF)'
  return null
}

/**
 * Compute the effective fielding rating for a player playing a given position
 * this game. Returns a clamped 0..99 number.
 */
export function effectiveFielding(player, pos) {
  if (!player) return 50
  const base = player.hitter?.fielding ?? 50
  const penalty = fieldingPenalty(player, pos)
  return Math.max(0, Math.min(99, base - penalty))
}
