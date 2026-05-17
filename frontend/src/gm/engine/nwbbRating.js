/**
 * NWBB Rating — proprietary predictive rating system for the GM game.
 *
 * Goals (per Nate, May 2026):
 *   - Predictive, not just historical (like Massey, KenPom — not RPI)
 *   - Strength-of-schedule adjusted iteratively to convergence
 *   - Rewards beating top teams, even in defeat (close losses to elite ≠ blowouts to bad)
 *   - Road wins worth more than home wins (small but real)
 *   - Margin of victory matters with diminishing returns (no incentive to run up the score)
 *   - Cross-division: beating a D1 means more than beating a bad D3
 *
 * Algorithm (Massey-style):
 *   For each team T, for each game G:
 *     opp_strength = current rating of opponent (or fixed strength for non-NAIA)
 *     margin = clamp(my_runs - opp_runs, -10, 10)         // diminishing returns
 *     home_adj = is_home ? -0.6 : +0.6                    // road wins worth more
 *     quality_bonus = (opp_strength >= 80 && won) ? +3    // beating a top team
 *     blowout_loss_penalty = (margin <= -8) ? -1          // got embarrassed
 *     game_performance = opp_strength + margin * 1.0 + home_adj + quality_bonus + blowout_loss_penalty
 *   new_rating = mean(performances) with sample-size anchoring to preseason seed
 *
 * Iterate until max delta < 0.05 (~15-20 iterations on a full schedule).
 *
 * The rating scale is 0-100 universal:
 *   95-99  elite D1 power
 *   85-94  good D1 / NAIA national title contender / top D2
 *   75-84  mid D1 / top NAIA / solid D2
 *   65-74  upper-mid NAIA / mid D2 / top D3
 *   55-64  median NAIA / mid D3 / NWAC
 *   45-54  lower NAIA / lower D3
 *   30-44  bottom of any tier
 *
 * Non-NAIA teams have FIXED ratings (preseason-set). They don't update from
 * simulated games because we don't run sim for the entire D1/D2/D3 universe.
 * Their rating still BENEFITS the NAIA opponents who play them (SOS boost,
 * quality-wins bonus).
 */

import pearRaw from '../data/pear_ratings_2026.json'
import nonNaiaRaw from '../data/non_naia_teams.json'
import { pearForSchoolWith, makePearLookup } from './pearLookup'

// ─── Cross-division universal strength seed ─────────────────────────────────

/**
 * Map a PEAR Rating (raw, roughly -10..+10 observed) to the universal 0-100
 * scale used by NWBB ratings. Calibrated so:
 *   PEAR  7.87 (LC State, NAIA #2)  →  ~83.6
 *   PEAR  0    (median NAIA)        →  60
 *   PEAR -5    (low NAIA)           →  45
 *   PEAR -10   (NAIA dregs)         →  30
 *
 * NAIA's top teams are roughly equivalent to mid-D1; they don't reach the
 * top-D1 ceiling (95+).
 */
export function pearToUniversal(pearRating) {
  if (pearRating == null) return 50
  return Math.max(20, Math.min(92, 60 + pearRating * 3.0))
}

/**
 * Map a non-NAIA team's `strength` field (currently 0-15 scale) to the
 * universal 0-100 scale. Tier-aware: a D1 with strength 10 is more imposing
 * than a D2 with strength 10. Calibrated so:
 *   D1   strength 10 → 88   (top-tier D1 — Oregon St kind of team)
 *   D1   strength 5  → 75   (mid D1)
 *   D2   strength 10 → 80   (top D2)
 *   D2   strength 5  → 67
 *   D3   strength 10 → 70
 *   D3   strength 5  → 57
 *   NWAC strength 10 → 72   (top JUCO — Wenatchee Valley etc.)
 *   NWAC strength 5  → 60
 */
export function nonNaiaToUniversal(team) {
  if (!team) return 50
  const s = team.strength ?? 0
  const tierBase = {
    D1:        78,
    D2:        65,
    D3:        55,
    JUCO_NWAC: 60,
    NWAC:      60,
    JUCO:      58,
  }[team.division] ?? 55
  return Math.max(25, Math.min(99, tierBase + s * 2.0))
}

// ─── Build preseason universal-strength seeds for everyone ────────────────

const PEAR_LOOKUP = makePearLookup(pearRaw)

const NON_NAIA_BY_ID = (() => {
  const out = {}
  for (const div of nonNaiaRaw.divisions || []) {
    for (const t of div.teams || []) {
      out[t.id] = { ...t, division: div.id }
    }
  }
  return out
})()

/**
 * Compute the preseason universal-strength seed for every school in the
 * world the user can play (NAIA via PEAR + non-NAIA via the curated table).
 *
 * @param {object<string, import('./types.js').School>} schools  NAIA schools
 * @returns {object<string, { rating: number, source: 'PEAR'|'NON_NAIA' }>}
 */
export function buildPreseasonSeeds(schools) {
  const out = {}
  // NAIA from PEAR
  for (const school of Object.values(schools || {})) {
    const pear = pearForSchoolWith(school, PEAR_LOOKUP)
    const rating = pear ? pearToUniversal(pear.Rating) : 50
    out[school.id] = { rating, source: 'PEAR' }
  }
  // Non-NAIA from static strength table
  for (const t of Object.values(NON_NAIA_BY_ID)) {
    out[t.id] = { rating: nonNaiaToUniversal(t), source: 'NON_NAIA' }
  }
  return out
}

// ─── Core ranking compute ────────────────────────────────────────────────

/**
 * Recompute NWBB ratings + SOS for every school using the games played so
 * far this year. Non-NAIA team ratings are held fixed (their preseason
 * universal-strength is the truth; we don't sim every D1 game).
 *
 * @param {object} state           the save state
 * @returns {object<string, NwbbRating>}
 *   NwbbRating: {
 *     teamId,                  // school.id
 *     rating,                  // universal 0-100 (predictive)
 *     sos,                     // mean opponent rating (0-100)
 *     sosRank,                 // 1 = hardest schedule
 *     gamesPlayed,             // count of games used in the calc
 *     pythagWinPct,            // Pythagorean expectation from RS/RA
 *     qualityWins,             // wins where opp_rating >= 80
 *     qualityWinsThreshold,    // dynamic threshold (top-25% of teams)
 *     roadWinPct,              // pct of road games won
 *     marginAvg,               // mean margin (capped) per game
 *     nationalRank,            // 1 = best NAIA
 *     isNonNaia,               // true for non-NAIA seeded teams
 *   }
 */
export function recomputeNwbbRatings(state) {
  const schools = state.schools || {}
  const seeds = buildPreseasonSeeds(schools)

  // Collect all played games. Cross-division ones count too.
  const games = (state.schedule || []).filter(g =>
    g.played
    && g.type !== 'BYE'
    && g.homeId
    && g.awayId
    && g.homeId !== '__BYE__'
    && g.awayId !== '__BYE__'
    && typeof g.homeRuns === 'number'
    && typeof g.awayRuns === 'number',
  )

  // Working ratings: start from seeds
  const ratings = {}
  for (const [tid, s] of Object.entries(seeds)) {
    ratings[tid] = s.rating
  }
  // Identify which teams update vs hold (non-NAIA = hold)
  const isNaia = (tid) => !!schools[tid]

  // Per-team game lists (computed once)
  const teamGames = {}
  for (const g of games) {
    if (!teamGames[g.homeId]) teamGames[g.homeId] = []
    if (!teamGames[g.awayId]) teamGames[g.awayId] = []
    teamGames[g.homeId].push({ ...g, isHome: true, oppId: g.awayId })
    teamGames[g.awayId].push({ ...g, isHome: false, oppId: g.homeId })
  }

  const MAX_ITER = 25
  const TOL = 0.05
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let maxDelta = 0
    const next = { ...ratings }
    for (const tid of Object.keys(ratings)) {
      if (!isNaia(tid)) continue   // hold non-NAIA at their seed
      const list = teamGames[tid] || []
      if (list.length === 0) continue   // no games → keep seed
      let sumPerf = 0
      for (const g of list) {
        const oppRating = ratings[g.oppId] ?? 50
        const myRuns = g.isHome ? g.homeRuns : g.awayRuns
        const oppRuns = g.isHome ? g.awayRuns : g.homeRuns
        const margin = clamp(myRuns - oppRuns, -10, 10)
        const homeAdj = g.isHome ? -0.6 : +0.6
        const won = myRuns > oppRuns
        const qualityBonus = won && oppRating >= 80 ? 3 : 0
        const blowoutLossPen = !won && margin <= -8 ? -1 : 0
        const perf = oppRating + margin * 1.0 + homeAdj + qualityBonus + blowoutLossPen
        sumPerf += perf
      }
      const meanPerf = sumPerf / list.length
      // Sample-size anchoring: blend with preseason seed until ~15 games played
      const seed = seeds[tid]?.rating ?? 50
      const sampleWeight = Math.min(1, list.length / 15)
      const newRating = sampleWeight * meanPerf + (1 - sampleWeight) * seed
      next[tid] = newRating
      maxDelta = Math.max(maxDelta, Math.abs(newRating - ratings[tid]))
    }
    Object.assign(ratings, next)
    if (maxDelta < TOL) break
  }

  // Quality-wins threshold = top-25% of NAIA ratings
  const naiaRatings = Object.entries(ratings)
    .filter(([tid]) => isNaia(tid))
    .map(([_, r]) => r)
    .sort((a, b) => b - a)
  const top25Idx = Math.floor(naiaRatings.length * 0.25)
  const qualityThreshold = naiaRatings[top25Idx] || 70

  // Build per-team result rows
  /** @type {Object<string, any>} */
  const out = {}
  for (const tid of Object.keys(ratings)) {
    const list = teamGames[tid] || []
    const oppRatings = list.map(g => ratings[g.oppId] ?? 50)
    const sos = oppRatings.length > 0
      ? oppRatings.reduce((a, b) => a + b, 0) / oppRatings.length
      : (seeds[tid]?.rating ?? 50)   // preseason proxy

    // RS / RA + Pythagorean
    let rs = 0, ra = 0, roadGames = 0, roadWins = 0, qualityWins = 0
    let totalMargin = 0
    for (const g of list) {
      const myRuns = g.isHome ? g.homeRuns : g.awayRuns
      const oppRuns = g.isHome ? g.awayRuns : g.homeRuns
      rs += myRuns; ra += oppRuns
      const margin = clamp(myRuns - oppRuns, -10, 10)
      totalMargin += margin
      if (!g.isHome) {
        roadGames++
        if (myRuns > oppRuns) roadWins++
      }
      if (myRuns > oppRuns && (ratings[g.oppId] ?? 50) >= qualityThreshold) {
        qualityWins++
      }
    }
    const pyth = rs + ra > 0
      ? Math.pow(rs, 1.83) / (Math.pow(rs, 1.83) + Math.pow(ra, 1.83))
      : 0.5

    out[tid] = {
      teamId: tid,
      rating: ratings[tid],
      sos,
      sosRank: 0,           // filled below
      gamesPlayed: list.length,
      pythagWinPct: pyth,
      qualityWins,
      qualityWinsThreshold: qualityThreshold,
      roadWinPct: roadGames > 0 ? roadWins / roadGames : null,
      roadGames,
      marginAvg: list.length > 0 ? totalMargin / list.length : 0,
      nationalRank: 0,      // filled below
      isNonNaia: !isNaia(tid),
      seedSource: seeds[tid]?.source || 'PEAR',
    }
  }

  // Assign nationalRank (NAIA only, lower rank = better rating)
  const naiaSorted = Object.values(out)
    .filter(r => !r.isNonNaia)
    .sort((a, b) => b.rating - a.rating)
  naiaSorted.forEach((r, i) => { r.nationalRank = i + 1 })

  // Assign sosRank (NAIA only, lower rank = harder schedule)
  const sosSorted = Object.values(out)
    .filter(r => !r.isNonNaia)
    .sort((a, b) => b.sos - a.sos)
  sosSorted.forEach((r, i) => { r.sosRank = i + 1 })

  return out
}

/**
 * Make sure state.nwbbRatings is populated. Cheap call — only does work
 * when the cache is missing. Use this on save-load (or before reads) to
 * guarantee display helpers always have a rating to read.
 */
export function ensureNwbbRatings(state) {
  if (state && !state.nwbbRatings) {
    state.nwbbRatings = recomputeNwbbRatings(state)
  }
  return state?.nwbbRatings || {}
}

/**
 * Look up a team's rank from the cached state.nwbbRatings map. Returns null
 * if no rating is available (e.g. brand new save before week 1 fires).
 */
export function teamRank(state, schoolId) {
  const r = state?.nwbbRatings?.[schoolId]
  return r?.nationalRank ?? null
}

/**
 * Format a rank for inline display ("#42", "—", or "NR" for "not ranked").
 * Non-NAIA teams return their division code with no number ("D1", "D3").
 */
export function rankLabel(state, schoolId) {
  const r = state?.nwbbRatings?.[schoolId]
  if (!r) return null
  if (r.isNonNaia) {
    const t = NON_NAIA_BY_ID[schoolId]
    return t?.division || null
  }
  return r.nationalRank ? `#${r.nationalRank}` : null
}

// ─── Stats helpers ────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
