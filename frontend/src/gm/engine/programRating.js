/**
 * Program-strength rating expressed as an expected starting Team OVR + a
 * 0.5-5 star count derived from that OVR. Used by the New Dynasty + GMHome
 * screens so users can scan-compare programs without launching a sim.
 *
 * "Team OVR" here is the same number the Roster page shows once a dynasty
 * is created: top-9 hitters × 0.55 + top-5 pitchers × 0.45 (see
 * teamOverall in playerRating.js). We derive it from the school's
 * programHistory + level without spinning up a full roster.
 */

import { seedFromPear } from './rankings'

/**
 * Estimated starting Team OVR for a school. Matches what the Roster page
 * displays after dynasty creation. Derived directly from programHistory +
 * level so it's stable + cheap (no roster gen needed).
 *
 * Math: roster generator anchors starter mean at 60 + (PH-15) × 0.27 plus a
 * per-level shift. Team OVR ≈ starter mean + ~5 (top-9 selection + star
 * bumps). Calibrated against scripts/pnw-team-ovr-report.mjs output.
 */
export function expectedTeamOvr(school) {
  if (!school) return 70
  const ph = Math.max(15, Math.min(99, school.programHistory ?? 50))
  // D1 LEVEL_SHIFT bumped 8 → 10 so the top D1 program (Georgia Tech-tier)
  // lands at ~98 OVR. Combined with the widened PH slope below, this gives
  // D1 the realistic 80 → 98 spread Nate is looking for between worst and
  // best D1 program (was 85 → 96, too compressed).
  const LEVEL_SHIFT = { D1: 10, D2: 0, NAIA: 0, D3: -4, NWAC: -10 }
  const shift = LEVEL_SHIFT[school.level] ?? 0
  // 60 baseline + per-PH slope + level shift + top-9 selection bonus (~5)
  // Empirically matches the OVR report at every level within ±1 OVR.
  return Math.round(60 + (ph - 15) * 0.27 + shift + 5)
}

/**
 * Convert a starting Team OVR to a 0.5-5 star count. Range tuned against
 * the full PNW team distribution — worst PNW program (Grays Harbor ~66)
 * lands at 0.5★, best PNW program (Oregon/Oregon St ~91) lands at 5★.
 *
 * Steps in half-star increments — roughly 3 OVR per half-star.
 */
export function teamOvrToStars(ovr) {
  if (ovr == null) return 2.5
  if (ovr >= 91) return 5.0
  if (ovr >= 88) return 4.5
  if (ovr >= 85) return 4.0
  if (ovr >= 82) return 3.5
  if (ovr >= 79) return 3.0
  if (ovr >= 76) return 2.5
  if (ovr >= 73) return 2.0
  if (ovr >= 70) return 1.5
  if (ovr >= 67) return 1.0
  return 0.5
}

/**
 * Build a map of schoolId → { teamOvr, stars, nationalRank } for every
 * school in the state. Used on team-picker UI.
 *
 * @param {Object<string, any>} schools  state.schools (all hydrated school objects)
 * @param {Object<string, any>} conferences  state.conferences (optional — used for NAIA nationalRank)
 */
export function buildProgramRatings(schools, conferences) {
  // NAIA national rank — preserved for backwards-compat UI elements.
  const naiaRatings = (() => {
    try { return seedFromPear(schools, conferences) } catch { return {} }
  })()
  const out = {}
  for (const school of Object.values(schools || {})) {
    const teamOvr = expectedTeamOvr(school)
    out[school.id] = {
      teamOvr,
      stars: teamOvrToStars(teamOvr),
      nationalRank: naiaRatings[school.id]?.nationalRank ?? null,
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
