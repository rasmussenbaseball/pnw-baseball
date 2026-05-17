/**
 * Per-level (D1/D2/D3/NAIA/NWAC) configuration + lookup helpers.
 *
 * Used by:
 *   - newDynasty path to detect whether the user picked a non-NAIA program
 *     and route to the multi-level bootstrap
 *   - schedule generators to know game counts per level
 *   - roster generation to respect class-year eligibility (NWAC = 2 yrs)
 *   - postseason runner to pick the right bracket flow
 *
 * Single source of truth: data/pnw_playoff_formats.json. Anywhere else
 * that needs to know "what's a level mean?" should read it through here.
 */

import playoffData from '../data/pnw_playoff_formats.json'
import nonNaiaRaw from '../data/non_naia_teams.json'

// ─── Level constants ──────────────────────────────────────────────────────

export const LEVELS = ['D1', 'D2', 'D3', 'NAIA', 'NWAC']

/**
 * Per-level config object pulled straight from pnw_playoff_formats.json.
 * Each entry has eligibility, rosterCap, seasonGames, and pnwConferences.
 */
export const LEVEL_CONFIG = playoffData.divisions || {}

/**
 * Per-conference config — only PNW-touching conferences.
 */
export const CONF_CONFIG = playoffData.conferences || {}

// ─── Lookups ──────────────────────────────────────────────────────────────

/**
 * Look up a school by id across all available data sources. Returns
 * `{ school, level, conferenceId }` or null. Used by newDynasty to figure
 * out where a selected schoolId came from.
 *
 *   - NAIA: looks in schools.json's cascade-collegiate (the loaded
 *     state.schools map — caller passes it in via `naiaSchools`)
 *   - Non-NAIA: pulls from non_naia_teams.json by id, infers level from
 *     the division block, and matches the pnw_playoff_formats conference
 *     by name match. NWAC ids start with `nwac-` so we route those by prefix.
 */
export function getLevelForSchool(schoolId, naiaSchools = {}) {
  if (!schoolId) return null
  // NAIA via the loaded schools map
  if (naiaSchools[schoolId]) {
    return {
      school: naiaSchools[schoolId],
      level: 'NAIA',
      conferenceId: naiaSchools[schoolId].conferenceId,
    }
  }
  // NWAC by id prefix
  if (schoolId.startsWith('nwac-')) {
    const t = findNonNaia(schoolId)
    if (!t) return null
    // Find which NWAC sub-conf this team belongs to (by pnwMembers list)
    const confId = findPnwConfContaining(schoolId, ['NWAC_NORTH','NWAC_SOUTH','NWAC_EAST','NWAC_WEST'])
    return { school: t, level: 'NWAC', conferenceId: confId }
  }
  // D1/D2/D3 by id suffix
  for (const suffix of ['-d1', '-d2', '-d3']) {
    if (schoolId.endsWith(suffix)) {
      const t = findNonNaia(schoolId)
      if (!t) return null
      const level = suffix.slice(1).toUpperCase()   // 'D1' | 'D2' | 'D3'
      const confId = findPnwConfContaining(schoolId, LEVEL_CONFIG[level]?.pnwConferences || [])
      return { school: t, level, conferenceId: confId }
    }
  }
  return null
}

/**
 * Look up a non-NAIA team object by id from non_naia_teams.json.
 */
export function findNonNaia(schoolId) {
  for (const div of nonNaiaRaw.divisions || []) {
    for (const t of div.teams || []) {
      if (t.id === schoolId) return { ...t, division: div.id }
    }
  }
  return null
}

/**
 * Find the first PNW conference id (in the given candidate list) whose
 * pnwMembers includes the schoolId.
 */
export function findPnwConfContaining(schoolId, candidateConfIds) {
  for (const confId of candidateConfIds) {
    const conf = CONF_CONFIG[confId]
    if (!conf) continue
    if ((conf.pnwMembers || []).some(m => m.id === schoolId)) return confId
  }
  return null
}

// ─── Per-level config helpers ─────────────────────────────────────────────

/** Class years allowed at this level. NWAC = ['FR','SO']; others = all 4. */
export function classYearsForLevel(level) {
  return LEVEL_CONFIG[level]?.eligibility?.classYears || ['FR', 'SO', 'JR', 'SR']
}

export function maxSeasonsForLevel(level) {
  return LEVEL_CONFIG[level]?.eligibility?.maxSeasonsPerPlayer ?? 4
}

export function rosterCapForLevel(level) {
  return LEVEL_CONFIG[level]?.rosterCap ?? 45
}

export function seasonGamesForLevel(level) {
  return LEVEL_CONFIG[level]?.seasonGames ?? 55
}

/** Is this level still in PREVIEW (engine integration in progress)? */
export function isPreviewLevel(level) {
  return level !== 'NAIA'
}
