/**
 * Park Factors physics + geo — ported verbatim from Kai Malloch's tool so the
 * native (themed) Builder / batted-ball lab / pitch lab / map produce identical
 * numbers to his original. First-order models calibrated to Statcast norms.
 */

// Games-weighted re-center shift so the builder's projected index matches the
// site leaderboard + the factors used in advanced stats.
export const RECENTER = 2.126

export const CONFIG = {
  leaderboard: { elevPer1000: 7.0, elevSatFt: 4000, dimPerFt: 0.16, tempPerDeg: 0.22, regressGames: 300 },
  builder: { elevPer1000: 7.0, elevSatFt: 4000, dimPerFt: 0.16, wind: { Calm: 0, Light: 0.3, Moderate: 0.7, Strong: 1.2 } },
}

const PHYS = {
  bb: { cd: 0.365, clBase: 0.08, clPerDeg: 0.0055, clMax: 0.26, launchH: 0.9, dt: 0.005,
        windCarryMph: { Calm: 0, Light: 2, Moderate: 4.5, Strong: 7 } },
  pitch: { calib: 0.78, flightFt: 55 },
}
export const WINDS = ['Calm', 'Light', 'Moderate', 'Strong']

const tempEffect = (avgTemp) => (avgTemp - 60) * CONFIG.leaderboard.tempPerDeg

// Projected (re-centered) index for a custom/real park configuration.
export function builderScore(elev, adof, temp, wind) {
  const B = CONFIG.builder
  const elevE = (B.elevSatFt / 1000) * B.elevPer1000 * Math.tanh(elev / B.elevSatFt)
  const dimE = (350 - adof) * B.dimPerFt
  const physics = elevE + dimE
  const tempE = tempEffect(temp)
  const windE = B.wind[wind] || 0
  return { score: 100 + physics + tempE + windE - RECENTER, elevE, dimE, tempE, windE }
}

// Standard-atmosphere air-density ratio at elevation + game temperature.
export function airDensityRatio(elevFt, tempF) {
  const pRel = Math.pow(1 - 6.875e-6 * elevFt, 5.2561)
  return pRel * (518.67 / (tempF + 459.67))
}

// 2D point-mass flight: drag + backspin lift, scaled by air density.
export function simulateBattedBall(evMph, laDeg, rhoRel, tailMph, fenceFt) {
  const P = PHYS.bb
  const m = 0.145, r = 0.0366, A = Math.PI * r * r, g = 9.81
  const rho = 1.225 * rhoRel
  const cl = Math.min(P.clMax, P.clBase + P.clPerDeg * laDeg)
  const th = (laDeg * Math.PI) / 180
  const wnd = tailMph * 0.44704
  const fenceM = fenceFt * 0.3048
  let vx = evMph * 0.44704 * Math.cos(th), vy = evMph * 0.44704 * Math.sin(th)
  let x = 0, y = P.launchH, t = 0, apex = y, hAtF = null, n = 0
  const path = [{ x: 0, y: P.launchH / 0.3048 }]
  while (y > 0 && t < 12) {
    const rvx = vx - wnd
    const sp = Math.sqrt(rvx * rvx + vy * vy) || 1e-6
    const q = (0.5 * rho * A * sp * sp) / m
    const ax = -q * P.cd * (rvx / sp) + q * cl * (-vy / sp)
    const ay = -g - q * P.cd * (vy / sp) + q * cl * (rvx / sp)
    const px = x
    vx += ax * P.dt; vy += ay * P.dt
    x += vx * P.dt; y += vy * P.dt; t += P.dt
    if (y > apex) apex = y
    if (hAtF === null && px < fenceM && x >= fenceM) hAtF = y
    if (++n % 6 === 0) path.push({ x: x / 0.3048, y: Math.max(0, y) / 0.3048 })
  }
  path.push({ x: x / 0.3048, y: 0 })
  return { carry: x / 0.3048, hang: t, apex: apex / 0.3048, hAtF: hAtF === null ? null : hAtF / 0.3048, path }
}

export function classifyBattedBall(b, fenceFt, wallFt, laDeg) {
  if (b.hAtF !== null && b.hAtF > wallFt)
    return { label: 'Home Run', tone: 'hitter', note: `clears the ${wallFt} ft wall by ${(b.hAtF - wallFt).toFixed(0)} ft` }
  if (b.hAtF !== null)
    return { label: 'Double', tone: 'teal', note: `off the wall, ${(wallFt - b.hAtF).toFixed(0)} ft below the top` }
  if (laDeg < 10)
    return b.carry < 120
      ? { label: 'Line Out', tone: 'pitcher', note: 'low liner, infield range' }
      : { label: 'Single', tone: 'white', note: 'low liner lands in front of the outfield' }
  if (laDeg < 22) {
    if (b.carry >= fenceFt - 30) return { label: 'Double', tone: 'teal', note: `gap shot, ${(fenceFt - b.carry).toFixed(0)} ft short of the fence` }
    if (b.hang < 2.7) return { label: 'Single', tone: 'white', note: 'drops in before the outfield closes' }
    return { label: 'Line Out', tone: 'pitcher', note: 'hangs long enough for an outfielder' }
  }
  if (laDeg <= 40)
    return b.carry >= fenceFt - 20
      ? { label: 'Fly Out', tone: 'pitcher', note: `warning track, ${(fenceFt - b.carry).toFixed(0)} ft short` }
      : { label: 'Fly Out', tone: 'pitcher', note: 'routine fly, outfielder camps under it' }
  return { label: 'Fly Out', tone: 'pitcher', note: 'popped up, too steep to carry' }
}

// Transverse Magnus movement (inches) over the flight to the plate.
export function pitchMovement(veloMph, rpm, eff, rhoRel) {
  const r = 0.0366, A = Math.PI * r * r, m = 0.145
  const v = veloMph * 0.44704
  const omegaT = (rpm * eff * 2 * Math.PI) / 60
  const S = (r * omegaT) / v
  const cl = 0.09 + 0.6 * S
  const a = (0.5 * (1.225 * rhoRel) * cl * A * v * v) / m
  const t = (PHYS.pitch.flightFt * 0.3048) / v
  return PHYS.pitch.calib * 0.5 * a * t * t * 39.3701
}

export function axisHint(deg) {
  const names = ['ride (backspin)', 'ride + arm-side', 'arm-side run', 'run + sink',
    'topspin (sink)', 'sink + sweep', 'glove-side sweep', 'sweep + ride']
  return names[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
}

// Team (full_name) -> [lat, lon] for the map.
export const GEO = {
  'Yakima Valley Yaks': [46.60, -120.51], 'Oregon Tech Owls': [42.22, -121.78],
  'Walla Walla Warriors': [46.06, -118.34], 'Eastern Oregon Mountaineers': [45.32, -118.09],
  'College of Idaho Yotes': [43.66, -116.69], 'Mt. Hood Saints': [45.50, -122.43],
  'Big Bend Vikings': [47.13, -119.28], 'Columbia Basin Hawks': [46.24, -119.10],
  'NNU Nighthawks': [43.58, -116.56], 'Whitworth Pirates': [47.75, -117.42],
  'Wenatchee Valley Knights': [47.42, -120.31], 'Corban Warriors': [44.99, -123.03],
  'MSU-Billings Yellowjackets': [45.78, -108.50], 'Washington State Cougars': [46.73, -117.18],
  'Central Washington Wildcats': [47.00, -120.55], 'Gonzaga Bulldogs': [47.67, -117.40],
  'Treasure Valley Chukars': [44.03, -116.96], 'UBC Thunderbirds': [49.26, -123.25],
  'Clackamas Cougars': [45.36, -122.60], 'Blue Mountain Timberwolves': [45.67, -118.79],
  'Lewis-Clark State Warriors': [46.42, -117.02], 'Chemeketa Storm': [44.94, -123.04],
  'Spokane Falls Bigfoot': [47.66, -117.43], 'Bellevue Bulldogs': [47.61, -122.20],
  'Everett Trojans': [47.98, -122.20], 'Lewis & Clark River Otters': [45.45, -122.67],
  'Bushnell Beacons': [44.05, -123.02], 'SW Oregon Lakers': [43.37, -124.22],
  'PLU Lutes': [47.14, -122.44], 'Whitman Blues': [46.07, -118.33],
  'Puget Sound Loggers': [47.26, -122.48], 'Warner Pacific Knights': [45.43, -122.63],
  'Washington Huskies': [47.65, -122.30], 'Portland Pilots': [45.57, -122.73],
  'Willamette Bearcats': [44.93, -123.03], 'Clark Penguins': [45.63, -122.66],
  'Oregon Ducks': [44.06, -123.07], 'Pacific Boxers': [45.52, -123.11],
  'Tacoma Titans': [47.25, -122.44], 'Linn-Benton Roadrunners': [44.64, -123.10],
  'Seattle U Redhawks': [47.58, -122.16], 'Skagit Valley Cardinals': [48.42, -122.33],
  'Oregon State Beavers': [44.57, -123.28], 'Centralia Blazers': [46.72, -122.95],
  'Pierce Raiders': [47.17, -122.52], 'Douglas Royals': [49.10, -122.83],
  'Shoreline Dolphins': [47.76, -122.34], "Saint Martin's Saints": [47.03, -122.82],
  'George Fox Bruins': [45.30, -122.97], 'Edmonds Tritons': [47.82, -122.31],
  'Lane Titans': [44.05, -123.07], 'Linfield Wildcats': [45.21, -123.20],
  'Western Oregon Wolves': [44.85, -123.23], 'Olympic Rangers': [47.57, -122.63],
  'Umpqua Riverhawks': [43.22, -123.35], 'Grays Harbor Chokers': [46.98, -123.89],
  'Lower Columbia Red Devils': [46.14, -122.94],
}

// Cascade crest longitude (rough) for the wet-side / dry-side split line.
export const CASCADE_LON = -121.3

// State outline polygons [lat, lon] for the map background.
export const MAP = {
  WA: [[49, -117.03], [47.76, -117.04], [46.43, -117.04], [46.34, -117.06], [46.17, -116.92], [45.99, -116.92], [46, -118.99], [45.93, -119.13], [45.91, -119.53], [45.82, -119.96], [45.73, -120.21], [45.7, -120.51], [45.75, -120.64], [45.6, -121.18], [45.67, -121.22], [45.73, -121.54], [45.71, -121.81], [45.55, -122.25], [45.66, -122.76], [45.96, -122.81], [46.08, -122.9], [46.19, -123.12], [46.17, -123.21], [46.15, -123.37], [46.26, -123.55], [46.3, -123.73], [46.24, -123.87], [46.33, -124.07], [46.46, -124.03], [46.54, -123.9], [46.74, -124.1], [47.29, -124.24], [47.36, -124.32], [47.74, -124.43], [47.89, -124.62], [48.18, -124.71], [48.38, -124.6], [48.29, -124.39], [48.16, -123.98], [48.17, -123.7], [48.12, -123.42], [48.17, -123.16], [48.08, -123.04], [48.09, -122.8], [47.87, -122.64], [47.88, -122.52], [47.59, -122.49], [47.32, -122.42], [47.35, -122.32], [47.58, -122.42], [47.8, -122.4], [48.03, -122.23], [48.12, -122.36], [48.29, -122.37], [48.47, -122.47], [48.6, -122.42], [48.75, -122.49], [48.78, -122.65], [48.89, -122.8], [49, -122.76], [49, -117.03]],
  OR: [[46.17, -123.21], [46.19, -123.12], [46.08, -122.9], [45.96, -122.81], [45.66, -122.76], [45.55, -122.25], [45.71, -121.81], [45.73, -121.54], [45.67, -121.22], [45.6, -121.18], [45.75, -120.64], [45.7, -120.51], [45.73, -120.21], [45.82, -119.96], [45.91, -119.53], [45.93, -119.13], [46, -118.99], [45.99, -116.92], [45.82, -116.78], [45.75, -116.55], [45.62, -116.46], [45.32, -116.67], [45.14, -116.73], [45.02, -116.85], [44.93, -116.83], [44.78, -116.93], [44.75, -117.04], [44.39, -117.24], [44.26, -117.17], [44.24, -116.98], [44.16, -116.9], [43.83, -117.03], [42, -117.03], [41.99, -118.7], [42, -120], [42, -121.04], [42.01, -122.38], [42.01, -123.23], [42, -124.21], [42.12, -124.36], [42.44, -124.43], [42.66, -124.42], [42.84, -124.55], [43, -124.45], [43.27, -124.38], [43.56, -124.24], [43.81, -124.17], [44.66, -124.06], [44.77, -124.08], [45.14, -123.98], [45.66, -123.94], [45.94, -123.99], [46.11, -123.95], [46.26, -123.55], [46.15, -123.37], [46.17, -123.21]],
  ID: [[49, -116.05], [47.98, -116.05], [47.7, -115.72], [47.42, -115.72], [47.3, -115.53], [47.26, -115.32], [47.19, -115.3], [46.92, -114.93], [46.81, -114.89], [46.71, -114.62], [46.64, -114.61], [46.65, -114.32], [46.27, -114.46], [46.04, -114.49], [45.88, -114.39], [45.77, -114.57], [45.67, -114.5], [45.56, -114.55], [45.46, -114.33], [45.59, -114.09], [45.7, -113.99], [45.6, -113.81], [45.52, -113.83], [45.33, -113.74], [45.13, -113.57], [45.06, -113.45], [44.87, -113.46], [44.78, -113.34], [44.77, -113.13], [44.45, -113], [44.39, -112.89], [44.49, -112.78], [44.48, -112.47], [44.57, -112.24], [44.52, -112.1], [44.56, -111.87], [44.51, -111.82], [44.55, -111.62], [44.76, -111.39], [44.58, -111.23], [44.48, -111.05], [42, -111.05], [42, -112.16], [42, -114.04], [42, -117.03], [43.83, -117.03], [44.16, -116.9], [44.24, -116.98], [44.26, -117.17], [44.39, -117.24], [44.75, -117.04], [44.78, -116.93], [44.93, -116.83], [45.02, -116.85], [45.14, -116.73], [45.32, -116.67], [45.62, -116.46], [45.75, -116.55], [45.82, -116.78], [45.99, -116.92], [46.17, -116.92], [46.34, -117.06], [46.43, -117.04], [47.76, -117.04], [49, -117.03], [49, -116.05]],
  MT: [[49, -104.05], [47.86, -104.04], [45.94, -104.05], [45, -104.04], [45, -104.06], [45, -105.92], [45, -109.08], [45, -111.05], [44.48, -111.05], [44.58, -111.23], [44.76, -111.39], [44.55, -111.62], [44.51, -111.82], [44.56, -111.87], [44.52, -112.1], [44.57, -112.24], [44.48, -112.47], [44.49, -112.78], [44.39, -112.89], [44.45, -113], [44.77, -113.13], [44.78, -113.34], [44.87, -113.46], [45.06, -113.45], [45.13, -113.57], [45.33, -113.74], [45.52, -113.83], [45.6, -113.81], [45.7, -113.99], [45.59, -114.09], [45.46, -114.33], [45.56, -114.55], [45.67, -114.5], [45.77, -114.57], [45.88, -114.39], [46.04, -114.49], [46.27, -114.46], [46.65, -114.32], [46.64, -114.61], [46.71, -114.62], [46.81, -114.89], [46.92, -114.93], [47.19, -115.3], [47.26, -115.32], [47.3, -115.53], [47.42, -115.72], [47.7, -115.72], [47.98, -116.05], [49, -116.05], [48.99, -111.5], [49, -109.45], [49, -104.05]],
  BC: [[49.9, -124.6], [49.9, -107.4], [49, -107.4], [49, -122.76], [49.05, -122.95], [49.28, -123.2], [49.5, -123.35], [49.68, -123.8], [49.9, -124.6]],
}
