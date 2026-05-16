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

/** state-code region. Covers all 50 states + DC. */
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

/** region array of state codes (inverse of STATE_TO_REGION). */
export const REGION_STATES = (() => {
  const out = { NW: [], SW: [], South: [], MW: [], SE: [], NE: [] }
  for (const [state, region] of Object.entries(STATE_TO_REGION)) {
    if (out[region]) out[region].push(state)
  }
  return out
})()

/**
 * Approximate state population weights for prospect distribution. Big states
 * produce many more HS / JUCO ballplayers than small ones — CA + TX + FL
 * combined dwarf the entire Mountain West. Values are relative weights, NOT
 * actual populations. Tuned so the most-prospect-rich state (CA) sits ~20×
 * the least-prospect-rich states (WY, ND, etc.).
 *
 * Unlisted states default to 1.0. Multiplied onto the coach-region boost.
 */
export const STATE_PROSPECT_WEIGHTS = {
  // Big baseball states
  CA: 10, TX: 8,  FL: 7,
  GA: 5,  NY: 4,  IL: 4,  PA: 4,  OH: 4,  NC: 4,
  AZ: 4,  VA: 3,  TN: 3,  IN: 3,  WA: 3,  MO: 3,
  // Mid-tier
  MI: 3,  NJ: 3,  MD: 2,  SC: 2,  AL: 2,  CO: 2,
  KY: 2,  LA: 2,  MN: 2,  WI: 2,  CT: 1.5, MA: 1.5,
  OR: 1.5, OK: 1.5, KS: 1.5, AR: 1.5, IA: 1.5,
  // Small + sparse
  NV: 1,  NM: 1,  UT: 1,  MS: 1,  NE: 1,  WV: 1,
  MT: 0.6, ID: 0.8, NH: 0.6, ME: 0.6, RI: 0.5,
  HI: 0.6, AK: 0.3,
  // Smallest baseball pools
  WY: 0.4, ND: 0.5, SD: 0.5, VT: 0.4, DE: 0.5, DC: 0.4,
}

/**
 * Weighted state pool for recruiting. Combines:
 *   1. State population weight (CA way more than WY)
 *   2. Coach's chosen `regions[]`get a 3x boost
 *
 * @param {string[]} coachRegions  Region codes the coach prioritizes
 * @returns {Record<string, number>}  state -> weight
 */
export function stateWeightsForRegions(coachRegions = []) {
  const boost = new Set(coachRegions)
  const out = {}
  for (const [state, region] of Object.entries(STATE_TO_REGION)) {
    const popWeight = STATE_PROSPECT_WEIGHTS[state] ?? 1
    out[state] = popWeight * (boost.has(region) ? 3 : 1)
  }
  return out
}
