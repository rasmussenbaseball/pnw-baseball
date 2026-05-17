/**
 * National conference champion tracking — every D1/D2/D3/NAIA conference,
 * not just the user's. Drives accurate national-tournament qualifier
 * seeding.
 *
 * Why this matters: the GM game only fully sims the user's conference.
 * Every OTHER conference in the country still produces a champion that
 * auto-bids into the national bracket. Without this, the national
 * tournament is just the user's conf champ floating alone — no
 * realistic 16-32-46-64 team field to feed regionals.
 *
 * Approach: at end of regular season, for every conference in PEAR's
 * full universe (308 D1 + 256 D2 + 384 D3 + 208 NAIA = 1,156 teams
 * across ~120 conferences), pick a champion using PEAR strength + a
 * dash of upset randomness. Cache on state.nationalChamps[year].
 *
 * The user's own conference's REAL simmed tournament champion overrides
 * the synthetic pick (the user's W-L is the canonical truth).
 *
 * National brackets:
 *   D1: 64-team field. ~30 conf champs auto-bid + at-large bids from
 *       PEAR-top non-champs. Total of 64 (16 regional sites of 4 teams).
 *   D2: 56-team field. Auto-bid conf champs + at-larges.
 *   D3: 60-team field. Same idea.
 *   NAIA: 46-team field (existing). 21 conf champs + 25 at-large.
 */

import nonNaiaRaw from '../data/non_naia_teams.json'
import pearNaia from '../data/pear_ratings_2026.json'

// ─── Build conference rosters once ────────────────────────────────────────

/**
 * Per-division map of conference name → list of teams.
 * Pulled from non_naia_teams.json (which has pearConference per team).
 */
const CONF_ROSTERS_BY_LEVEL = (() => {
  const out = { D1: {}, D2: {}, D3: {}, NAIA: {} }
  // Non-NAIA from PEAR-derived data
  for (const div of nonNaiaRaw.divisions || []) {
    const level = div.id   // 'D1' / 'D2' / 'D3' / 'JUCO_NWAC'
    if (!out[level]) continue
    for (const t of div.teams || []) {
      const conf = t.pearConference || 'Independent'
      if (!out[level][conf]) out[level][conf] = []
      out[level][conf].push({
        id: t.id, name: t.name, state: t.state,
        strength: t.strength ?? 0,
        prr: t.pearRank ?? null,
      })
    }
  }
  // NAIA from pear_ratings_2026.json
  for (const t of pearNaia.stats || []) {
    const conf = t.Conference || 'Independent'
    if (!out.NAIA[conf]) out.NAIA[conf] = []
    out.NAIA[conf].push({
      id: 'naia-' + (t.Team || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: t.Team,
      state: extractState(t.Team),
      strength: t.Rating ?? 0,
      prr: t.PRR ?? null,
    })
  }
  return out
})()

function extractState(name) {
  const m = name?.match(/\(([A-Z]{2})\)\s*$/)
  return m ? m[1] : null
}

// National-tournament field sizes per level
const NATIONAL_FIELD_SIZE = { D1: 64, D2: 56, D3: 60, NAIA: 46 }

// ─── Champion picker ──────────────────────────────────────────────────────

/**
 * Pick one champion for a conference. Heavily weighted toward top-strength
 * teams (best regular season = most likely tournament winner), with ~20%
 * upset chance to a top-3 non-favorite. Reflects real tourney variance.
 */
function pickConfChampion(teams, rng) {
  if (!teams || teams.length === 0) return null
  if (teams.length === 1) return teams[0]
  const sorted = [...teams].sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
  // 60% favorite wins, 25% 2nd seed wins, 10% 3rd seed, 5% 4-N upset
  const r = rng.next()
  if (r < 0.60) return sorted[0]
  if (r < 0.85) return sorted[1] || sorted[0]
  if (r < 0.95) return sorted[2] || sorted[0]
  // Deep upset — pick from rest
  const rest = sorted.slice(3)
  if (rest.length === 0) return sorted[0]
  return rest[Math.floor(rng.next() * rest.length)]
}

/**
 * Simulate every conference at a given level, returning champions.
 *
 * @param {'D1'|'D2'|'D3'|'NAIA'} level
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @returns {Array<{ conferenceName: string, championId: string, championName: string, state: string|null, strength: number }>}
 */
export function simAllConfChampions(level, rng) {
  const confs = CONF_ROSTERS_BY_LEVEL[level] || {}
  const out = []
  for (const [confName, teams] of Object.entries(confs)) {
    if (confName === 'Independent') continue   // skip indep teams; no auto-bid
    const champ = pickConfChampion(teams, rng)
    if (!champ) continue
    out.push({
      conferenceName: confName,
      championId: champ.id,
      championName: champ.name,
      state: champ.state,
      strength: champ.strength,
    })
  }
  return out
}

// ─── National field selection ─────────────────────────────────────────────

/**
 * Build the national-tournament field for a given level.
 * Auto-bids = every conference champion. At-large = top-rated remaining
 * teams (by strength) to fill out to fieldSize.
 *
 * @param {'D1'|'D2'|'D3'|'NAIA'} level
 * @param {Array} champions   from simAllConfChampions
 * @returns {{ autoBids: string[], atLarge: string[], field: Array }}
 */
export function buildNationalField(level, champions) {
  const fieldSize = NATIONAL_FIELD_SIZE[level] || 32
  const autoBidIds = new Set(champions.map(c => c.championId))

  // Pool of non-champion teams at this level, sorted by strength
  const allTeams = []
  for (const conf of Object.values(CONF_ROSTERS_BY_LEVEL[level] || {})) {
    for (const t of conf) allTeams.push(t)
  }
  const atLargePool = allTeams
    .filter(t => !autoBidIds.has(t.id))
    .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))

  const slotsForAtLarge = Math.max(0, fieldSize - champions.length)
  const atLarge = atLargePool.slice(0, slotsForAtLarge)
  const field = [
    ...champions.map(c => ({ id: c.championId, name: c.championName, state: c.state, strength: c.strength, viaAutoBid: true, conferenceName: c.conferenceName })),
    ...atLarge.map(t => ({ id: t.id, name: t.name, state: t.state, strength: t.strength, viaAutoBid: false, conferenceName: null })),
  ]
  return {
    autoBids: champions.map(c => c.championId),
    atLarge: atLarge.map(t => t.id),
    field,
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────

/**
 * Run the full national-bracket build for the user's level at end of
 * season. Stores everything on state.nationalChamps[year] so the
 * Postseason page can render the full national bracket field.
 *
 * Called from runPostseason / runPostseasonMultiLevel for the
 * user's level only (we don't need to track all 4 levels every year).
 *
 * @param {object} state
 * @param {'D1'|'D2'|'D3'|'NAIA'} level
 */
export function runNationalChampionsTracking(state, level) {
  const yearKey = state.calendar?.year ?? 0
  if (!state.nationalChamps) state.nationalChamps = {}
  if (state.nationalChamps[yearKey]?.[level]) return state.nationalChamps[yearKey][level]

  // Deterministic per-year seed so re-renders produce stable results
  const seed = (state.rngSeed || 1) ^ (yearKey * 7919) ^ levelSeed(level)
  const rng = makeRng(seed)

  const champions = simAllConfChampions(level, rng)

  // Inject the user's REAL conference champion (overrides synthetic pick
  // for their conference if the user simmed an actual bracket).
  const userConfId = state.schools?.[state.userSchoolId]?.conferenceId
  const userConf = state.conferences?.[userConfId]
  const userTournament = state.postseason?.tournaments?.find(t => t.conferenceId === userConfId)
  if (userTournament?.champion && userConf) {
    // Replace any synthetic pick for the conference NAME match
    const userConfName = userConf.name
    const userChampSchool = state.schools[userTournament.champion]
    const userChampEntry = {
      conferenceName: userConfName,
      championId: userTournament.champion,
      championName: userChampSchool?.name || 'User-side champion',
      state: userChampSchool?.state || null,
      strength: state.nwbbRatings?.[userTournament.champion]?.rating ?? 65,
      isUserChamp: state.userSchoolId === userTournament.champion,
    }
    const matchIdx = champions.findIndex(c =>
      c.conferenceName.toLowerCase().includes(userConfName.toLowerCase()) ||
      userConfName.toLowerCase().includes(c.conferenceName.toLowerCase()))
    if (matchIdx >= 0) champions[matchIdx] = userChampEntry
    else champions.push(userChampEntry)
  }

  const bracket = buildNationalField(level, champions)

  state.nationalChamps[yearKey] = state.nationalChamps[yearKey] || {}
  state.nationalChamps[yearKey][level] = {
    champions,
    autoBids: bracket.autoBids,
    atLarge: bracket.atLarge,
    field: bracket.field,
    fieldSize: NATIONAL_FIELD_SIZE[level],
  }
  return state.nationalChamps[yearKey][level]
}

// ─── Tiny inline RNG (avoids depending on rng.js stateful makeRng) ────────

function makeRng(seedRaw) {
  let s = Math.abs(seedRaw | 0) || 1
  return {
    next() { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 },
    chance(p) { return this.next() < p },
  }
}

function levelSeed(level) {
  return { D1: 11, D2: 22, D3: 33, NAIA: 44, NWAC: 55 }[level] || 0
}
