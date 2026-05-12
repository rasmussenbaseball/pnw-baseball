/**
 * Seeded PRNG for the GM engine.
 *
 * Using mulberry32 — small, fast, well-distributed for game purposes.
 * The whole sim is deterministic given a seed, which means we can:
 *   - Replay any sim that misbehaved for debugging
 *   - Compare two strategies on the same simulated season
 *   - Test reproducibly
 *
 * Convention: keys are constructed with `makeRng(saveId, season, day, gameId, paIndex)`
 * via the `hashSeed` helper so each game/PA gets its own deterministic stream.
 */

/**
 * Mulberry32 PRNG.
 * @param {number} seed
 * @returns {() => number}  function returning a float in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Hash a list of strings/numbers into a 32-bit seed.
 * Used to derive per-event seeds from a save's master seed.
 * @param  {...(string|number)} parts
 * @returns {number}
 */
export function hashSeed(...parts) {
  let h = 2166136261 >>> 0
  for (const p of parts) {
    const s = String(p)
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }
  return h >>> 0
}

/**
 * Convenience constructor. Pass any number of "key parts" — they're hashed
 * into a single deterministic seed.
 * @param  {...(string|number)} keyParts
 * @returns {{
 *   next: () => number,
 *   int: (min: number, max: number) => number,
 *   float: (min: number, max: number) => number,
 *   pick: <T>(arr: T[]) => T,
 *   weighted: <T>(items: T[], weights: number[]) => T,
 *   gaussian: (mean?: number, stddev?: number) => number,
 *   chance: (p: number) => boolean
 * }}
 */
export function makeRng(...keyParts) {
  const seed = hashSeed(...keyParts)
  const next = mulberry32(seed)

  return {
    next,

    /** integer in [min, max] inclusive */
    int(min, max) {
      return Math.floor(next() * (max - min + 1)) + min
    },

    /** float in [min, max) */
    float(min, max) {
      return next() * (max - min) + min
    },

    /** pick a uniform random element from arr */
    pick(arr) {
      return arr[Math.floor(next() * arr.length)]
    },

    /** weighted pick. weights[i] is non-negative; relative weights, not probs. */
    weighted(items, weights) {
      let total = 0
      for (const w of weights) total += w
      let r = next() * total
      for (let i = 0; i < items.length; i++) {
        r -= weights[i]
        if (r <= 0) return items[i]
      }
      return items[items.length - 1]
    },

    /** approximate gaussian via Box-Muller */
    gaussian(mean = 0, stddev = 1) {
      const u1 = Math.max(next(), 1e-12)
      const u2 = next()
      const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2)
      return mean + z * stddev
    },

    /** return true with probability p (clamped 0..1) */
    chance(p) {
      const clamped = Math.max(0, Math.min(1, p))
      return next() < clamped
    },
  }
}
