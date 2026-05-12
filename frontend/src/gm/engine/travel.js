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
 */
export function milesBetween(stateA, stateB) {
  const a = STATE_CENTROIDS[stateA]
  const b = STATE_CENTROIDS[stateB]
  if (!a || !b) return 800   // unknown — assume mid-range
  if (stateA === stateB) return 100   // in-state, ~100mi nominal
  return Math.round(haversine(a, b))
}

// ─── Cost model ──────────────────────────────────────────────────────────────

const ROSTER_SIZE_FOR_TRAVEL = 30   // travel squad
const DAILY_PER_DIEM = 60
const HOTEL_PER_NIGHT_DOUBLE = 90   // 2 to a room
const BUS_COST_PER_MILE = 6
const FLIGHT_BASE = 800
const FLIGHT_PER_PASSENGER_LONG = 350   // > 1000 mi
const FLIGHT_PER_PASSENGER_MEDIUM = 200 // 500-1000 mi

/**
 * @param {number} miles
 * @returns {'bus'|'flight'}
 */
function travelMode(miles) {
  return miles >= 600 ? 'flight' : 'bus'
}

/**
 * Estimate travel cost for an away series of N games over D days.
 * @returns {{ totalCost: number, mode: 'bus'|'flight', miles: number, breakdown: object }}
 */
export function estimateAwaySeriesCost(homeState, awayState, gameCount, daysAway) {
  const miles = milesBetween(homeState, awayState)
  const mode = travelMode(miles)
  let transit = 0
  if (mode === 'bus') {
    transit = miles * BUS_COST_PER_MILE * 2   // round trip
  } else {
    const perPax = miles >= 1500 ? FLIGHT_PER_PASSENGER_LONG : FLIGHT_PER_PASSENGER_MEDIUM
    transit = FLIGHT_BASE + perPax * ROSTER_SIZE_FOR_TRAVEL
  }
  const hotelRooms = Math.ceil(ROSTER_SIZE_FOR_TRAVEL / 2)
  const hotel = hotelRooms * HOTEL_PER_NIGHT_DOUBLE * (daysAway - 1)
  const food = ROSTER_SIZE_FOR_TRAVEL * DAILY_PER_DIEM * daysAway
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
export function estimateMidweekCost(homeState, awayState) {
  const miles = milesBetween(homeState, awayState)
  const mode = travelMode(miles)
  let transit = 0
  if (mode === 'bus') {
    transit = miles * BUS_COST_PER_MILE * 2
  } else {
    const perPax = miles >= 1500 ? FLIGHT_PER_PASSENGER_LONG : FLIGHT_PER_PASSENGER_MEDIUM
    transit = FLIGHT_BASE + perPax * ROSTER_SIZE_FOR_TRAVEL
  }
  const food = ROSTER_SIZE_FOR_TRAVEL * DAILY_PER_DIEM
  // 1 night hotel if > 200 miles
  const hotel = miles > 200 ? Math.ceil(ROSTER_SIZE_FOR_TRAVEL / 2) * HOTEL_PER_NIGHT_DOUBLE : 0
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

  for (const g of schedule) {
    if (g.homeId === schoolId) continue   // home games — no travel cost
    if (g.awayId !== schoolId) continue
    if (g.type === 'BYE') continue
    const oppId = g.homeId
    const opp = schools[oppId] || nonNaiaLookup?.[oppId]
    if (!opp) continue
    const oppState = opp.state || 'OR'

    if (g.type === 'D1_MIDWEEK') {
      total += estimateMidweekCost(homeState, oppState).totalCost
    } else if (g.seriesId) {
      if (seriesSeen.has(g.seriesId)) continue
      seriesSeen.add(g.seriesId)
      // 4-game series → typically 3 days; 3-game → 3 days
      const seriesGames = schedule.filter(x => x.seriesId === g.seriesId).length
      const daysAway = Math.min(4, Math.max(2, seriesGames))
      total += estimateAwaySeriesCost(homeState, oppState, seriesGames, daysAway).totalCost
    } else {
      // Single game (scrimmage or one-off)
      total += estimateMidweekCost(homeState, oppState).totalCost
    }
  }
  return Math.round(total)
}
