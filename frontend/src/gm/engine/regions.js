/**
 * Region system — single source of truth for the 6-region split that
 * replaced the old "regions + pipelines" pair.
 *
 * All 50 states + DC accounted for. Coaches pick up to 2 regions of
 * expertise at game start; recruits from those regions show stronger
 * baseline interest in the coach's program.
 */

export const REGIONS = ['NW', 'SW', 'South', 'MW', 'SE', 'NE']

export const REGION_LABELS = {
  NW: 'Northwest',
  SW: 'Southwest',
  South: 'South',
  MW: 'Midwest',
  SE: 'Southeast',
  NE: 'Northeast',
}

export const REGION_BLURBS = {
  NW: 'WA OR ID MT AK HI',
  SW: 'CA NV AZ UT NM CO WY',
  South: 'TX OK AR LA MS AL TN KY',
  MW: 'ND SD MN IA NE KS MO WI IL IN MI OH',
  SE: 'FL GA SC NC VA WV MD DE',
  NE: 'NY PA NJ MA CT ME NH VT RI DC',
}

/** state-code → region. Covers all 50 states + DC. */
export const STATE_TO_REGION = {
  // Northwest
  WA: 'NW', OR: 'NW', ID: 'NW', MT: 'NW', AK: 'NW', HI: 'NW',
  // Southwest
  CA: 'SW', NV: 'SW', AZ: 'SW', UT: 'SW', NM: 'SW', CO: 'SW', WY: 'SW',
  // South
  TX: 'South', OK: 'South', AR: 'South', LA: 'South', MS: 'South',
  AL: 'South', TN: 'South', KY: 'South',
  // Midwest
  ND: 'MW', SD: 'MW', MN: 'MW', IA: 'MW', NE: 'MW', KS: 'MW', MO: 'MW',
  WI: 'MW', IL: 'MW', IN: 'MW', MI: 'MW', OH: 'MW',
  // Southeast
  FL: 'SE', GA: 'SE', SC: 'SE', NC: 'SE', VA: 'SE', WV: 'SE', MD: 'SE', DE: 'SE',
  // Northeast
  NY: 'NE', PA: 'NE', NJ: 'NE', MA: 'NE', CT: 'NE', ME: 'NE', NH: 'NE',
  VT: 'NE', RI: 'NE', DC: 'NE',
  // Canada (BC commonly recruited from NAIA pacific schools)
  BC: 'NW',
}

/** region → array of state codes (inverse of STATE_TO_REGION). */
export const REGION_STATES = (() => {
  const out = { NW: [], SW: [], South: [], MW: [], SE: [], NE: [] }
  for (const [state, region] of Object.entries(STATE_TO_REGION)) {
    if (out[region]) out[region].push(state)
  }
  return out
})()

/**
 * Weighted state pool for recruiting. Default is even across all states
 * (~equal odds nationwide). The coach's chosen `regions[]` get a 3x boost
 * to the states in those regions.
 *
 * @param {string[]} coachRegions  Region codes the coach prioritizes
 * @returns {Record<string, number>}  state -> weight
 */
export function stateWeightsForRegions(coachRegions = []) {
  const boost = new Set(coachRegions)
  const out = {}
  for (const [state, region] of Object.entries(STATE_TO_REGION)) {
    out[state] = boost.has(region) ? 3 : 1
  }
  return out
}
