/**
 * State-pair proximity scoring. Used to rank opponents by closeness so we
 * default people toward scheduling nearby teams (especially for fall games,
 * where travel budget is tight).
 *
 * Approach: lightweight adjacency list (which states physically border which)
 * + region grouping fallback. Cheaper than real lat/lng math and good enough
 * for "show me the closest 10 teams" UX.
 *
 * Score interpretation: LOWER is closer.
 *   0  same state
 *   1  bordering / immediately adjacent
 *   2  same region (2-hop)
 *   3  adjacent region
 *   4  far region
 */

import { STATE_TO_REGION } from './regions'

// Land-bordering states. Bidirectional below in the build step.
const ADJ_PAIRS = [
  // PNW + Mountain
  ['WA', 'OR'], ['WA', 'ID'], ['WA', 'BC'],
  ['OR', 'ID'], ['OR', 'CA'], ['OR', 'NV'],
  ['ID', 'MT'], ['ID', 'WY'], ['ID', 'UT'], ['ID', 'NV'],
  ['MT', 'ND'], ['MT', 'SD'], ['MT', 'WY'],
  // Mountain / Plains
  ['CA', 'NV'], ['CA', 'AZ'],
  ['NV', 'UT'], ['NV', 'AZ'],
  ['UT', 'WY'], ['UT', 'CO'], ['UT', 'AZ'], ['UT', 'NM'],
  ['AZ', 'NM'],
  ['WY', 'CO'], ['WY', 'NE'], ['WY', 'SD'],
  ['CO', 'NM'], ['CO', 'OK'], ['CO', 'KS'], ['CO', 'NE'],
  ['NM', 'TX'], ['NM', 'OK'],
  // Plains
  ['ND', 'SD'], ['ND', 'MN'],
  ['SD', 'NE'], ['SD', 'IA'], ['SD', 'MN'],
  ['NE', 'IA'], ['NE', 'MO'], ['NE', 'KS'],
  ['KS', 'MO'], ['KS', 'OK'],
  ['OK', 'TX'], ['OK', 'AR'], ['OK', 'MO'],
  ['TX', 'AR'], ['TX', 'LA'],
  // Midwest
  ['MN', 'IA'], ['MN', 'WI'],
  ['IA', 'WI'], ['IA', 'IL'], ['IA', 'MO'],
  ['WI', 'IL'], ['WI', 'MI'],
  ['IL', 'IN'], ['IL', 'MO'], ['IL', 'KY'],
  ['IN', 'OH'], ['IN', 'MI'], ['IN', 'KY'],
  ['MI', 'OH'],
  ['OH', 'PA'], ['OH', 'WV'], ['OH', 'KY'],
  ['MO', 'AR'], ['MO', 'KY'], ['MO', 'TN'],
  // South / Southeast
  ['AR', 'LA'], ['AR', 'MS'], ['AR', 'TN'],
  ['LA', 'MS'],
  ['MS', 'AL'], ['MS', 'TN'],
  ['AL', 'GA'], ['AL', 'FL'], ['AL', 'TN'],
  ['TN', 'KY'], ['TN', 'GA'], ['TN', 'NC'], ['TN', 'VA'],
  ['KY', 'WV'], ['KY', 'VA'],
  ['GA', 'FL'], ['GA', 'SC'], ['GA', 'NC'],
  ['SC', 'NC'],
  ['NC', 'VA'],
  ['VA', 'WV'], ['VA', 'MD'], ['VA', 'DC'], ['VA', 'NC'],
  ['WV', 'PA'], ['WV', 'MD'],
  ['MD', 'DE'], ['MD', 'PA'], ['MD', 'DC'],
  ['DE', 'PA'], ['DE', 'NJ'],
  // Northeast
  ['PA', 'NJ'], ['PA', 'NY'],
  ['NJ', 'NY'],
  ['NY', 'CT'], ['NY', 'MA'], ['NY', 'VT'],
  ['CT', 'MA'], ['CT', 'RI'],
  ['MA', 'NH'], ['MA', 'VT'], ['MA', 'RI'],
  ['VT', 'NH'],
  ['NH', 'ME'],
]

const ADJ = (() => {
  const m = new Map()
  function add(a, b) {
    if (!m.has(a)) m.set(a, new Set())
    m.get(a).add(b)
  }
  for (const [a, b] of ADJ_PAIRS) { add(a, b); add(b, a) }
  return m
})()

// Region adjacency — which regions are next-door to which (for the 2/3 score
// gap when states aren't directly bordering each other).
const REGION_NEIGHBORS = {
  NW:    ['SW', 'MW'],
  SW:    ['NW', 'MW', 'South'],
  MW:    ['NW', 'SW', 'South', 'SE', 'NE'],
  South: ['SW', 'MW', 'SE'],
  SE:    ['MW', 'South', 'NE'],
  NE:    ['MW', 'SE'],
}

/**
 * Closeness score between two US states (2-letter codes). Lower = closer.
 * Returns 4 if either state is unknown.
 */
export function stateProximity(a, b) {
  if (!a || !b) return 4
  if (a === b) return 0
  if (ADJ.get(a)?.has(b)) return 1
  const rA = STATE_TO_REGION[a]
  const rB = STATE_TO_REGION[b]
  if (!rA || !rB) return 4
  if (rA === rB) return 2
  if (REGION_NEIGHBORS[rA]?.includes(rB)) return 3
  return 4
}

/**
 * Sort an array of opponent records by proximity to the user's home state.
 * Each record must have a `.state`field.
 */
export function sortByProximity(userState, opponents) {
  return [...opponents].sort((a, b) => {
    const da = stateProximity(userState, a.state)
    const db = stateProximity(userState, b.state)
    if (da !== db) return da - db
    // Tiebreak: alphabetical by name, if present
    return (a.name || '').localeCompare(b.name || '')
  })
}

/** Pretty label for a proximity score. */
export function proximityLabel(score) {
  if (score === 0) return 'In-state'
  if (score === 1) return 'Border'
  if (score === 2) return 'Same region'
  if (score === 3) return 'Adjacent region'
  return 'Far'
}
