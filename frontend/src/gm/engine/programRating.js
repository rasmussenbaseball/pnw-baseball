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
// Level-shift constants used by both expectedTeamOvr and the
// rank-bucketed PH helper. D1 = +10 puts top D1 at ~98 OVR; NAIA/D2 = 0;
// D3 = -4; NWAC = -10. Lower levels shift the absolute floor down.
export const LEVEL_OVR_SHIFT = { D1: 10, D2: 0, NAIA: 0, D3: -4, NWAC: -10 }

/**
 * Per-level OVR window — top + bottom for the rank-bucketed distribution.
 * Each level has a hand-picked OVR range Nate calibrated. Counts are the
 * total team pool per level used to bucket the rank → OVR mapping.
 */
export const LEVEL_OVR_WINDOW = {
  D1:   { top: 98, bottom: 80, totalTeams: 308 },
  D2:   { top: 84, bottom: 60, totalTeams: 256 },
  D3:   { top: 82, bottom: 58, totalTeams: 384 },
  NAIA: { top: 84, bottom: 60, totalTeams: 195 },
  NWAC: { top: 75, bottom: 51, totalTeams: 25 },   // 1 team per OVR (25 unique)
}

/**
 * Given a rank within a level (1 = best), return the target Team OVR.
 *
 * For NWAC (small pool — 25 teams), each rank maps to a UNIQUE OVR
 * (rank 1 → 75, rank 25 → 51). For larger levels we bucket evenly so the
 * pool spreads across the OVR window with ~equal teams per OVR.
 */
export function ovrForLevelRank(level, rank) {
  const cfg = LEVEL_OVR_WINDOW[level]
  if (!cfg || !rank || rank < 1) return null
  const r = Math.max(1, Math.min(cfg.totalTeams, rank))
  if (level === 'NWAC') {
    // 1 team per OVR — rank 1 → top, rank N → bottom.
    return cfg.top - (r - 1)
  }
  const ovrSpan = cfg.top - cfg.bottom + 1
  const bucket = Math.min(ovrSpan - 1,
    Math.floor((r - 1) * ovrSpan / cfg.totalTeams))
  return cfg.top - bucket
}

/**
 * PH value that, when fed into expectedTeamOvr, yields the target OVR.
 * Inverse of expectedTeamOvr's formula: OVR = round(60 + (PH-15)*0.27 +
 * LEVEL_SHIFT + 5) so PH ≈ 15 + (OVR - 65 - LEVEL_SHIFT) / 0.27. Adding 1.85
 * (~ 0.5/0.27) lands in the middle of the rounding window so noise doesn't
 * push the round to the wrong neighbor.
 */
export function phForTargetOvr(level, targetOvr) {
  const shift = LEVEL_OVR_SHIFT[level] ?? 0
  return Math.round(15 + (targetOvr - 65 - shift) / 0.27 + 1.85)
}

export function expectedTeamOvr(school) {
  if (!school) return 70
  // Rank-bucketed OVR is the primary path now. Each school is assigned a
  // pearRank within its level at dynasty creation; we look up the target
  // OVR for that rank. Falls through to the PH formula for any school that
  // somehow lacks a rank (legacy saves, custom schools, etc.).
  const rank = school.pearRank
  if (rank > 0 && LEVEL_OVR_WINDOW[school.level]) {
    const ovr = ovrForLevelRank(school.level, rank)
    if (typeof ovr === 'number') return ovr
  }
  // ── Fallback: PH-based formula ──────────────────────────────────────
  // Clamp lifted to [0, 99] (was [15, 99]) so the rank-bucketed PH lookups
  // for low-OVR D2/D3/NAIA/NWAC teams aren't artificially floored.
  const ph = Math.max(0, Math.min(99, school.programHistory ?? 50))
  const shift = LEVEL_OVR_SHIFT[school.level] ?? 0
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
