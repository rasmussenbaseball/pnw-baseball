/**
 * Program-strength rating expressed as a 0-5 star scale, derived from each
 * school's national ranking (PEAR-seeded for a fresh dynasty).
 *
 * Used on the New Dynasty + GMHome screens so users can quickly see "is
 * this a top-15 program or a bottom-50 program?" without parsing the
 * underlying PEAR number.
 */

import { seedFromPear } from './rankings'

/**
 * Compute a 0-5 star score for a given national rank (1 = best, ~199 = last).
 * Top 5 → 5★, top 15 → 4.5★, top 30 → 4★, mid → 3★, bottom-tier → 1★.
 */
export function nationalRankToStars(rank, totalTeams = 199) {
  if (rank == null || rank < 1) return 2.5
  // Piecewise curve so the top tier gets visibly differentiated and the
  // bottom doesn't slam into 0.5 stars.
  if (rank <= 5)   return 5.0
  if (rank <= 15)  return 4.5
  if (rank <= 30)  return 4.0
  if (rank <= 60)  return 3.5
  if (rank <= 100) return 3.0
  if (rank <= 140) return 2.5
  if (rank <= 170) return 2.0
  if (rank <= 185) return 1.5
  return 1.0
}

/**
 * Build a map of schoolId → { nationalRank, stars } for all NAIA programs.
 * Cached on the result of seedFromPear; cheap to recompute since the
 * underlying PEAR ratings are static input data.
 */
export function buildProgramRatings(schools, conferences) {
  const ratings = seedFromPear(schools, conferences)
  const out = {}
  for (const r of Object.values(ratings)) {
    out[r.schoolId] = {
      nationalRank: r.nationalRank,
      stars: nationalRankToStars(r.nationalRank, Object.keys(ratings).length),
    }
  }
  return out
}

/**
 * Pretty star bar — 5 filled + half + empty positions. Returns an array of
 * 5 entries: each is 'full' | 'half' | 'empty'.
 */
export function starsToBar(stars) {
  const full = Math.floor(stars)
  const hasHalf = (stars - full) >= 0.5
  const out = []
  for (let i = 0; i < 5; i++) {
    if (i < full) out.push('full')
    else if (i === full && hasHalf) out.push('half')
    else out.push('empty')
  }
  return out
}
