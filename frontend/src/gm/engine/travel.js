/**
 * Travel costs.
 *
 * Real NAIA travel reality: Week-1 cross-country trips are budget killers.
 * Southern teams won't travel to Oregon in February; Northern teams can't
 * afford to fly to Florida every year. This file models that as a per-trip
 * dollar cost the user's budget eats.
 *
 * Approach: pre-built state-to-state distance buckets. Cost = bus or flight
 * tier × team size × nights.
 *
 * v1.5 simplifying assumption: only the AWAY team pays travel. Home team
 * gets gate revenue + free housing.
 */

// ─── State centroids (rough lat/lng) ─────────────────────────────────────────

const STATE_CENTROIDS = {
  WA: [47.5, -120.5], OR: [44.0, -120.5], ID: [44.0, -114.5], MT: [47.0, -110.0],
  BC: [54.0, -125.0],   // British Columbia
  CA: [37.0, -119.5], NV: [39.0, -117.0], AZ: [34.0, -112.0], UT: [39.5, -112.0],
  WY: [43.0, -107.5], CO: [39.0, -105.5], NM: [34.5, -106.0], TX: [31.0, -100.0],
  OK: [35.5, -98.5], AR: [35.0, -92.5], LA: [31.0, -92.0], ND: [47.5, -100.5],
  SD: [44.5, -100.5], NE: [41.5, -100.0], KS: [38.5, -98.5], MN: [46.0, -94.0],
  IA: [42.0, -93.5], MO: [38.5, -92.5], WI: [44.5, -89.5], IL: [40.0, -89.0],
  IN: [40.0, -86.0], MI: [44.0, -85.0], OH: [40.5, -82.5], KY: [37.5, -85.0],
  TN: [35.8, -86.5], MS: [33.0, -89.5], AL: [33.0, -86.5], GA: [33.0, -83.5],
  FL: [28.5, -82.0], SC: [34.0, -81.0], NC: [35.5, -79.5], VA: [37.5, -78.5],
  WV: [38.5, -80.5], PA: [40.5, -77.5], NY: [42.5, -75.5], NJ: [40.0, -74.5],
  MA: [42.0, -71.5], CT: [41.5, -72.5], ME: [45.0, -69.0], NH: [43.5, -71.5],
  VT: [44.0, -72.5], RI: [41.5, -71.5], DE: [39.0, -75.5], MD: [39.0, -76.5],
  DC: [39.0, -77.0],
}

const EARTH_RADIUS_MI = 3958.8

/**
 * Haversine distance in miles between two [lat, lng] points.
 */
function haversine([lat1, lon1], [lat2, lon2]) {
  const toRad = d => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a))
}

/**
 * Approximate miles between two schools by state centroid.
 *
 * If EITHER state is missing or unknown (which is the case for most of the
 * PEAR-imported D1/D2/D3 teams — PEAR's API doesn't expose locations), we
 * return a fixed "average road trip" distance so every unknown-location
 * opponent costs the same to travel to. 1100 mi ≈ a typical multi-region
 * flight trip; produces ~$7-9K series / ~$4K midweek costs.
 */
const UNKNOWN_LOCATION_MILES = 1100

export function milesBetween(stateA, stateB) {
  const a = STATE_CENTROIDS[stateA]
  const b = STATE_CENTROIDS[stateB]
  if (!a || !b) return UNKNOWN_LOCATION_MILES
  if (stateA === stateB) return 100   // in-state, ~100mi nominal
  return Math.round(haversine(a, b))
}

/**
 * Was this miles value generated from the unknown-location fallback?
 * Useful for the UI to show "estimated" labels.
 */
export function isUnknownLocation(stateA, stateB) {
  return !STATE_CENTROIDS[stateA] || !STATE_CENTROIDS[stateB]
}

// ─── Cost model ──────────────────────────────────────────────────────────────

// NAIA travel reality is cheaper than these numbers were suggesting. Calibrated
// down so a typical CCC schedule (10 series, ~5 away within PNW) comes in
// around $25-40K — matches what the AD-side accounting tends to look like.
const ROSTER_SIZE_FOR_TRAVEL = 28   // travel squad — smaller for NAIA budgets
const DAILY_PER_DIEM = 35           // per diem, not full hotel meals
const HOTEL_PER_NIGHT_DOUBLE = 75
const BUS_COST_PER_MILE = 3.25      // charter rate is ~$3-4/mi all-in
const FLIGHT_BASE = 600
const FLIGHT_PER_PASSENGER_LONG = 280   // > 1500 mi
const FLIGHT_PER_PASSENGER_MEDIUM = 160 // 600-1500 mi

/**
 * @param {number} miles
 * @returns {'bus'|'flight'}
 */
function travelMode(miles) {
  return miles >= 600 ? 'flight' : 'bus'
}

/**
 * Estimate travel cost for an away series of N games over D days.
 * Pass opts.level to apply level-specific rules (per Nate, May 2026):
 *   NWAC — JUCO bus-only, day trips. No hotels, half per-diem, never flights.
 *
 * @returns {{ totalCost: number, mode: 'bus'|'flight', miles: number, breakdown: object }}
 */
export function estimateAwaySeriesCost(homeState, awayState, gameCount, daysAway, opts = {}) {
  const miles = milesBetween(homeState, awayState)
  const isNwac = opts.level === 'NWAC'
  // NWAC is a commuter JUCO league — bus only, never flights regardless of
  // distance. Per Nate: "within 60 miles you aren't staying in hotels."
  const mode = isNwac ? 'bus' : travelMode(miles)
  let transit = 0
  if (mode === 'bus') {
    transit = miles * BUS_COST_PER_MILE * 2   // round trip
  } else {
    const perPax = miles >= 1500 ? FLIGHT_PER_PASSENGER_LONG : FLIGHT_PER_PASSENGER_MEDIUM
    transit = FLIGHT_BASE + perPax * ROSTER_SIZE_FOR_TRAVEL
  }
  // NWAC: zero overnight hotels. Half per-diem (kids eat at home / pack
  // lunch since they're commuting from campus). Effectively 1-day trips.
  let hotel, food
  if (isNwac) {
    hotel = 0
    food = ROSTER_SIZE_FOR_TRAVEL * (DAILY_PER_DIEM * 0.5)
  } else {
    const hotelRooms = Math.ceil(ROSTER_SIZE_FOR_TRAVEL / 2)
    hotel = hotelRooms * HOTEL_PER_NIGHT_DOUBLE * (daysAway - 1)
    food = ROSTER_SIZE_FOR_TRAVEL * DAILY_PER_DIEM * daysAway
  }
  const total = Math.round(transit + hotel + food)
  return {
    totalCost: total,
    mode,
    miles,
    breakdown: {
      transit: Math.round(transit),
      hotel: Math.round(hotel),
      food: Math.round(food),
    },
  }
}

/**
 * Estimate travel cost for a single midweek game (one-day trip).
 */
export function estimateMidweekCost(homeState, awayState, opts = {}) {
  const miles = milesBetween(homeState, awayState)
  const isNwac = opts.level === 'NWAC'
  const mode = isNwac ? 'bus' : travelMode(miles)
  let transit = 0
  if (mode === 'bus') {
    transit = miles * BUS_COST_PER_MILE * 2
  } else {
    const perPax = miles >= 1500 ? FLIGHT_PER_PASSENGER_LONG : FLIGHT_PER_PASSENGER_MEDIUM
    transit = FLIGHT_BASE + perPax * ROSTER_SIZE_FOR_TRAVEL
  }
  const food = ROSTER_SIZE_FOR_TRAVEL * (isNwac ? DAILY_PER_DIEM * 0.5 : DAILY_PER_DIEM)
  // 1 night hotel if > 200 miles — but never for NWAC (commuter league).
  const hotel = (!isNwac && miles > 200) ? Math.ceil(ROSTER_SIZE_FOR_TRAVEL / 2) * HOTEL_PER_NIGHT_DOUBLE : 0
  const total = Math.round(transit + food + hotel)
  return { totalCost: total, mode, miles, breakdown: { transit: Math.round(transit), food, hotel } }
}

/**
 * Sum total annual travel cost for a school's schedule (all away games).
 */
export function totalAnnualTravelCost(schoolId, schedule, schools, nonNaiaLookup) {
  let total = 0
  // Group away games into series (by seriesId) so we don't double-count
  const seriesSeen = new Set()
  const homeState = schools[schoolId]?.state || 'OR'
  const level = schools[schoolId]?.level
  const opts = { level }

  for (const g of schedule) {
    if (g.homeId === schoolId) continue   // home games — no travel cost
    if (g.awayId !== schoolId) continue
    if (g.type === 'BYE') continue
    const oppId = g.homeId
    const opp = schools[oppId] || nonNaiaLookup?.[oppId]
    if (!opp) continue
    const oppState = opp.state || 'OR'

    if (g.type === 'D1_MIDWEEK') {
      total += estimateMidweekCost(homeState, oppState, opts).totalCost
    } else if (g.seriesId) {
      if (seriesSeen.has(g.seriesId)) continue
      seriesSeen.add(g.seriesId)
      // 4-game series typically 3 days; 3-game 3 days. NWAC is always
      // 1-day (commuter — series-level option zeroes out hotels).
      const seriesGames = schedule.filter(x => x.seriesId === g.seriesId).length
      const daysAway = level === 'NWAC' ? 1 : Math.min(4, Math.max(2, seriesGames))
      total += estimateAwaySeriesCost(homeState, oppState, seriesGames, daysAway, opts).totalCost
    } else {
      // Single game (scrimmage or one-off)
      total += estimateMidweekCost(homeState, oppState, opts).totalCost
    }
  }
  return Math.round(total)
}
