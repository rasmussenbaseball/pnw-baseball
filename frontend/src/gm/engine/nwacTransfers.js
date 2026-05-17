/**
 * NWAC sophomore transfer destinations.
 *
 * When an NWAC SO completes their 2-year career, real life: they
 * commit to a 4-year program. This module picks a believable
 * destination based on the kid's talent.
 *
 * Pattern (matches what actually happens to NWAC alumni):
 *   - Best players (85+ OVR): SEC / ACC / Big Ten / Big 12 (P5 D1)
 *     Some go far away (Vanderbilt, LSU). Some stay regional (Oregon, UW).
 *   - Solid players (75-84): mid-D1 (WCC / Sun Belt / WAC), occasionally
 *     a P5 walk-on offer. Mostly regional preference.
 *   - Good players (65-74): top D2 / strong NAIA. Stay PNW most of the time
 *     (NNU, CWU, Western Oregon, Lewis-Clark State, College of Idaho).
 *   - Average (55-64): D2, D3, NAIA. Heavy PNW preference (the kid wants to
 *     stay close to home).
 *   - Below avg (45-54): smaller NAIA / D3. PNW only.
 *   - <45: career typically ends — labeled "graduated, did not transfer"
 *
 * Destination is purely cosmetic — the transferred player doesn't appear
 * on the receiving team's roster (we'd need a full nationwide engine to
 * simulate that). It's a newsfeed flourish + a NWAC alumni tracking pane.
 */

import nonNaiaRaw from '../data/non_naia_teams.json'
import pearNaia from '../data/pear_ratings_2026.json'

// ─── Build lookup tables once ───────────────────────────────────────────

/** Flat list of non-NAIA teams keyed by id. */
const ALL_NON_NAIA = (() => {
  const out = []
  for (const div of nonNaiaRaw.divisions || []) {
    for (const t of div.teams || []) {
      out.push({ ...t, division: div.id })
    }
  }
  return out
})()

/** D1 P5 conferences — elite destinations for top talent. */
const P5_CONFERENCES = new Set([
  'SEC', 'ACC', 'Big Ten', 'Big 12',
])

/** PNW + nearby state codes. */
const PNW_STATES = new Set(['WA', 'OR', 'ID', 'MT', 'BC'])
const WEST_STATES = new Set(['WA', 'OR', 'ID', 'MT', 'BC', 'CA', 'NV', 'AZ', 'UT', 'CO'])

// Filter helpers ----------------------------------------------------------

function d1Programs() {
  return ALL_NON_NAIA.filter(t => t.division === 'D1')
}
function d2Programs() {
  return ALL_NON_NAIA.filter(t => t.division === 'D2')
}
function d3Programs() {
  return ALL_NON_NAIA.filter(t => t.division === 'D3')
}

function p5Programs() {
  return d1Programs().filter(t => P5_CONFERENCES.has(t.pearConference))
}

function nonP5D1Programs() {
  return d1Programs().filter(t => !P5_CONFERENCES.has(t.pearConference))
}

/** NAIA destination pool — pulled from pear_ratings_2026.json. */
function naiaPrograms() {
  const stats = pearNaia?.stats || []
  return stats.map(t => ({
    id: 'naia-' + (t.Team || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: t.Team,
    state: extractStateFromName(t.Team),
    division: 'NAIA',
    pearConference: t.Conference,
    rating: t.Rating,
  }))
}

function extractStateFromName(name) {
  const m = name?.match(/\(([A-Z]{2})\)\s*$/)
  return m ? m[1] : null
}

// ─── Talent tier classification ──────────────────────────────────────────

function tierForOvr(ovr) {
  if (ovr >= 85) return 'ELITE'      // SEC / ACC / Big Ten / Big 12
  if (ovr >= 75) return 'HIGH'       // mid-D1 (WCC, Sun Belt, ACC etc.)
  if (ovr >= 65) return 'MID'        // top D2 / strong NAIA
  if (ovr >= 55) return 'AVG'        // D2 / D3 / NAIA mid-tier
  if (ovr >= 45) return 'LOW'        // small NAIA / D3
  return 'WALKON'                    // didn't get picked up
}

// Weights for tier → bucket-pool selection
const TIER_WEIGHTS = {
  ELITE:  { p5: 60, nonP5_D1: 30, d2: 8,  d3: 0, naia: 2 },
  HIGH:   { p5: 12, nonP5_D1: 55, d2: 20, d3: 0, naia: 13 },
  MID:    { p5: 1,  nonP5_D1: 18, d2: 38, d3: 6, naia: 37 },
  AVG:    { p5: 0,  nonP5_D1: 5,  d2: 25, d3: 18, naia: 52 },
  LOW:    { p5: 0,  nonP5_D1: 0,  d2: 8,  d3: 30, naia: 62 },
}

// Distance preference (per tier): chance the destination is PNW
const PNW_PREFERENCE = {
  ELITE:  0.30,    // elite kids go where the opportunity is
  HIGH:   0.50,
  MID:    0.65,
  AVG:    0.75,
  LOW:    0.80,
}

// ─── Main picker ─────────────────────────────────────────────────────────

/**
 * Pick a destination for an NWAC sophomore transferring out.
 *
 * @param {{ ovr: number, hometown?: { state?: string } }} player
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @returns {{ tier: string, division: string, name: string, state: string|null, conference: string|null, id: string|null } | null}
 */
export function pickNwacTransferDestination(player, rng) {
  const ovr = Math.max(20, Math.min(99, player.ovr ?? 60))
  const tier = tierForOvr(ovr)
  if (tier === 'WALKON') {
    return {
      tier, division: 'NONE',
      name: 'Career ended — no 4-yr offer',
      state: null, conference: null, id: null,
    }
  }

  // Pick which pool the kid lands in
  const weights = TIER_WEIGHTS[tier]
  const bucketKey = rng.weighted(
    ['p5', 'nonP5_D1', 'd2', 'd3', 'naia'],
    [weights.p5, weights.nonP5_D1, weights.d2, weights.d3, weights.naia],
  )

  let pool = []
  if (bucketKey === 'p5') pool = p5Programs()
  else if (bucketKey === 'nonP5_D1') pool = nonP5D1Programs()
  else if (bucketKey === 'd2') pool = d2Programs()
  else if (bucketKey === 'd3') pool = d3Programs()
  else if (bucketKey === 'naia') pool = naiaPrograms()

  if (pool.length === 0) return null

  // Regional preference filter — try PNW first based on tier preference,
  // fall back to anything in the pool if no PNW match.
  const preferPnw = rng.chance(PNW_PREFERENCE[tier])
  let candidates = pool
  if (preferPnw) {
    const pnwOnly = pool.filter(t => PNW_STATES.has(t.state))
    if (pnwOnly.length > 0) candidates = pnwOnly
  } else if (tier !== 'ELITE') {
    // Mid-tier kids who don't pick PNW often go to a nearby West state
    const westOnly = pool.filter(t => WEST_STATES.has(t.state))
    if (westOnly.length > 0 && rng.chance(0.6)) candidates = westOnly
  }

  // Strength-weighted pick — better players pick higher-strength destinations
  // within the chosen pool. We bias by strength but keep randomness.
  candidates = candidates.filter(t => typeof t.strength === 'number' || t.rating != null)
  if (candidates.length === 0) candidates = pool
  candidates.sort((a, b) =>
    (b.strength ?? b.rating ?? 0) - (a.strength ?? a.rating ?? 0),
  )

  // Top half of the sorted candidates is the realistic range. Sample with
  // exponential-weighted bias toward higher-strength destinations.
  const topHalf = candidates.slice(0, Math.max(1, Math.ceil(candidates.length / 2)))
  const idx = Math.floor(Math.pow(rng.next(), 2) * topHalf.length)
  const pick = topHalf[idx] || topHalf[0] || candidates[0]

  return {
    tier,
    division: pick.division,
    name: pick.name,
    state: pick.state || null,
    conference: pick.pearConference || null,
    id: pick.id || null,
  }
}

/**
 * Run transfer-destination picking for every player on the user's roster
 * who's transferring out at end of year (NWAC SO). Stores results on the
 * player record AND on state.nwacAlumni[year] for the Dashboard widget.
 *
 * @param {object} state
 */
export function assignNwacTransferDestinations(state) {
  if (state.level !== 'NWAC') return
  const rng = makePersistentRng(state)
  if (!state.nwacAlumni) state.nwacAlumni = {}
  const year = state.calendar?.year ?? 0
  if (!state.nwacAlumni[year]) state.nwacAlumni[year] = []

  const userTeam = state.teams?.[state.userSchoolId]
  if (!userTeam) return

  // Find all just-transferred players (set by runDevelopment when SO → GRAD)
  // We re-scan the players map by transferred status + classYear === 'SO'
  for (const p of Object.values(state.players || {})) {
    if (p.eligibilityStatus !== 'transferred') continue
    if (p.classYear !== 'SO') continue
    if (p._nwacTransferDest) continue   // already picked

    const ovr = computePlayerOvr(p)
    const dest = pickNwacTransferDestination({ ovr, hometown: p.hometown }, rng)
    p._nwacTransferDest = dest

    state.nwacAlumni[year].push({
      playerId: p.id,
      playerName: `${p.firstName} ${p.lastName}`,
      ovr,
      position: p.primaryPosition,
      hometown: p.hometown,
      destination: dest,
    })

    // Newsfeed line — call out the best transfers
    if (dest && dest.division !== 'NONE') {
      const headline = ovr >= 85
        ? `${p.firstName} ${p.lastName} (NWAC ${p.primaryPosition}, ${ovr} OVR) commits to ${dest.name}${dest.state ? ` (${dest.state})` : ''}!`
        : `${p.firstName} ${p.lastName} transfers to ${dest.name}${dest.division ? ` (${dest.division})` : ''}.`
      state.newsfeed.unshift({
        id: `nwac_xfer_${p.id}_${year}`,
        year, week: state.calendar?.week ?? 0, type: 'TRANSFER_OUT',
        headline,
        payload: { playerId: p.id, destination: dest, ovr },
        big: ovr >= 80,
      })
    }
  }
}

function makePersistentRng(state) {
  // Use rngSeed + year so each year produces a stable transfer crop
  const seed = (state.rngSeed || 1) ^ (state.calendar?.year || 2026) << 4
  let s = Math.abs(seed) || 1
  return {
    next() {
      s = (s * 1664525 + 1013904223) % 4294967296
      return s / 4294967296
    },
    chance(p) { return this.next() < p },
    weighted(items, weights) {
      const total = weights.reduce((a, b) => a + b, 0)
      let r = this.next() * total
      for (let i = 0; i < items.length; i++) {
        r -= weights[i]
        if (r <= 0) return items[i]
      }
      return items[items.length - 1]
    },
  }
}

function computePlayerOvr(p) {
  if (p.isPitcher && p.pitcher) {
    const v = [
      p.pitcher.stuff, p.pitcher.control, p.pitcher.command,
      p.pitcher.stamina, p.pitcher.vs_l, p.pitcher.vs_r,
    ].filter(x => typeof x === 'number')
    if (v.length === 0) return 60
    return Math.round(v.reduce((a, b) => a + b, 0) / v.length)
  }
  if (p.hitter) {
    const v = [
      p.hitter.contact_l, p.hitter.contact_r,
      p.hitter.power_l, p.hitter.power_r,
      p.hitter.discipline, p.hitter.speed,
      p.hitter.fielding, p.hitter.arm,
    ].filter(x => typeof x === 'number')
    if (v.length === 0) return 60
    return Math.round(v.reduce((a, b) => a + b, 0) / v.length)
  }
  return 60
}
