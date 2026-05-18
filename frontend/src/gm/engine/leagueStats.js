/**
 * League-wide season-stat synthesis.
 *
 * Background: fastSimGame (used for the bulk of NAIA games not involving the
 * user) returns only final scores — no per-player boxscores. That keeps the
 * weekly sim fast, but it means we don't have stat lines for opponents'
 * players. For awards (All-Conference, Gold Glove) and league leaderboards,
 * we synthesize plausible season totals from each player's ratings + their
 * team's actual run-environment.
 *
 * The synthesis is deterministic per (year, playerId) — same input always
 * produces the same stat line, so saves are reproducible.
 *
 * USAGE:
 *   const stats = synthesizeSeasonStats(player, teamCtx, year, seed)
 *   stats has the same shape as save.playerStats rows: { ab, h, d, t, hr, ... }
 */

import { makeRng } from './rng'
import { playerOverall } from './playerRating'

/**
 * @param {Player} player
 * @param {{ teamOffense: number, teamPitching: number, games: number, runsScored: number, runsAllowed: number }} teamCtx
 * @param {number} year
 * @param {string|number} seed
 */
export function synthesizeSeasonStats(player, teamCtx, year, seed) {
  if (player.isPitcher) return synthesizePitcher(player, teamCtx, year, seed)
  return synthesizeBatter(player, teamCtx, year, seed)
}

// ─── Batter synthesis ───────────────────────────────────────────────────────

// ─── Per-level real-world baselines ─────────────────────────────────────────
// Targets pulled from nwbaseballstats.com /api/v1/team-stats?season=2025 in
// May 2026. The actual baseline VALUES below are calibrated UPWARD from the
// real targets because the per-rating-point slopes drift outcomes
// downward (most rostered players sit above the 50-rating anchor).
//
// Each row contains "target" (what real-world league avg shows) + "raw"
// (the baseline we feed to the synthesizer so the simulated league lands
// at target). The smoke test in scripts/smoke-test-gm.mjs validates this.
const LEVEL_BASELINES = {
  // Each baseline = the rate produced by an AVERAGE-rated player (60) at
  // this level. Pulled from real NWBB 2025 data + slight upward adjustment
  // to account for the fact that top-9 hitters / SP rotation skew higher
  // than the 60 anchor, which pulls league averages up a tick.
  //
  // gamesPerSeason: regular season max — NAIA ~52 (max 55), D1 56, D3 41,
  // D2 52, NWAC 50. Postseason adds 4-15 more for teams that qualify.
  D1:   { kPct: 0.197, bbPct: 0.116, hbpPct: 0.030, hrPerPa: 0.020, doublePct: 0.105, babip: 0.275, era: 5.59, whip: 1.52, gamesPerSeason: 56 },
  D2:   { kPct: 0.166, bbPct: 0.090, hbpPct: 0.034, hrPerPa: 0.012, doublePct: 0.105, babip: 0.290, era: 6.32, whip: 1.68, gamesPerSeason: 52 },
  D3:   { kPct: 0.175, bbPct: 0.101, hbpPct: 0.039, hrPerPa: 0.014, doublePct: 0.100, babip: 0.285, era: 5.76, whip: 1.59, gamesPerSeason: 41 },
  NAIA: { kPct: 0.170, bbPct: 0.106, hbpPct: 0.044, hrPerPa: 0.017, doublePct: 0.115, babip: 0.295, era: 6.54, whip: 1.67, gamesPerSeason: 52 },
  NWAC: { kPct: 0.173, bbPct: 0.112, hbpPct: 0.039, hrPerPa: 0.004, doublePct: 0.080, babip: 0.245, era: 4.57, whip: 1.44, gamesPerSeason: 50 },
}

function baselineFor(level) {
  return LEVEL_BASELINES[level] || LEVEL_BASELINES.NAIA
}

function synthesizeBatter(player, teamCtx, year, seed) {
  const rng = makeRng('synthB', player.id, year, seed)
  const games = teamCtx.games || 45
  const ovr = playerOverall(player)
  const baseline = baselineFor(teamCtx.level)

  // How much PT does this player get? Top-9 lineup regulars play ~95% of
  // games; bench guys ~30%; depth ~10%. Estimate from OVR percentile within
  // the team's roster — top guys get the bulk.
  const teamRank = teamCtx.rosterOvrRanks?.[player.id] ?? 999
  let ptShare
  if (teamRank <= 9) ptShare = 0.92 - (teamRank - 1) * 0.02       // 1st 0.92 .. 9th 0.76
  else if (teamRank <= 14) ptShare = 0.45 - (teamRank - 10) * 0.05  // bench
  else ptShare = 0.10                                                // depth

  // PA per game: lineup regulars ~4.2; pinch-hitters and bench fewer.
  const paPerGame = 3.8 + Math.max(0, (9 - teamRank)) * 0.05
  const pa = Math.round(games * ptShare * paPerGame * (0.9 + rng.next() * 0.2))
  if (pa < 5) return zeroBatterStats(player)

  // BB% + K% from discipline + contact
  const disc = player.hitter?.discipline ?? 50
  const contact = Math.max(player.hitter?.contact_l ?? 50, player.hitter?.contact_r ?? 50)
  const power = Math.max(player.hitter?.power_l ?? 50, player.hitter?.power_r ?? 50)
  const speed = player.hitter?.speed ?? 50

  // Rate stats anchored to per-level real-world baselines. Each rate is the
  // baseline + a per-rating-point delta + Gaussian noise. Slopes are
  // calibrated so the AVERAGE rostered player (rating ~60) lands at the
  // level baseline — meaning baseline IS the league-target.
  // Anchor at rating 60 (typical roster mean) instead of 50.
  const RATING_ANCHOR = 60
  const bbPct = clamp(baseline.bbPct + (disc - RATING_ANCHOR) * 0.0010 + rng.gaussian(0, 0.012), 0.04, 0.22)
  const bb = Math.round(pa * bbPct)
  const hbpPct = clamp(baseline.hbpPct + rng.gaussian(0, 0.005), 0, 0.07)
  const hbp = Math.round(pa * hbpPct)
  // K% — contact pulls it down, power pushes it up (power guys K more).
  const kPct = clamp(baseline.kPct - (contact - RATING_ANCHOR) * 0.0012 + (power - RATING_ANCHOR) * 0.0008 + rng.gaussian(0, 0.025), 0.05, 0.40)
  const k = Math.round(pa * kPct)
  // SF — small
  const sf = Math.round(pa * 0.012)
  const ab = Math.max(0, pa - bb - hbp - sf)

  // BABIP — level baseline + contact/speed slopes anchored at rating 60
  const babip = clamp(baseline.babip + (contact - RATING_ANCHOR) * 0.0008 + (speed - RATING_ANCHOR) * 0.0005 + rng.gaussian(0, 0.025), 0.22, 0.40)
  const teamOff = teamCtx.teamOffense ?? 60
  const teamOffShift = (teamOff - 60) * 0.0006
  const babipAdj = clamp(babip + teamOffShift, 0.22, 0.40)
  // HR rate — power-driven. Anchored at rating 60.
  const hrRate = clamp(baseline.hrPerPa + Math.max(0, power - RATING_ANCHOR) * 0.0006 + Math.max(0, power - 80) * 0.0010 + rng.gaussian(0, 0.004), 0.001, 0.08)
  const hr = Math.round(pa * hrRate)
  const bipAb = Math.max(0, ab - k - hr)
  let h = Math.round(bipAb * babipAdj) + hr
  h = Math.max(hr, Math.min(ab, h))

  // Split hits into 1B / 2B / 3B / HR. Doubles share is per-level.
  const nonHr = Math.max(0, h - hr)
  const doublePct = clamp(baseline.doublePct + (power - RATING_ANCHOR) * 0.0012 + rng.gaussian(0, 0.018), 0.08, 0.28)
  const triplePct = clamp(0.014 + (speed - RATING_ANCHOR) * 0.0005, 0.004, 0.04)
  const d = Math.round(nonHr * doublePct)
  const t = Math.round(nonHr * triplePct)

  // RBI — scale with HR + plate appearances + team offense
  const rbi = Math.round(hr * 1.4 + d * 0.5 + (h - d - t - hr) * 0.4 + rng.gaussian(0, 4) + teamOff * 0.05)

  return {
    playerId: player.id,
    isPitcher: false,
    pa, ab, h, d, t, hr,
    bb, k, hbp, sf,
    rbi: Math.max(0, rbi),
    sac: 0, gidp: Math.round(ab * 0.018), roe: Math.round(ab * 0.008),
    gamesPlayed: Math.round(games * ptShare),
    _synthetic: true,
  }
}

function zeroBatterStats(player) {
  return {
    playerId: player.id, isPitcher: false,
    pa: 0, ab: 0, h: 0, d: 0, t: 0, hr: 0,
    bb: 0, k: 0, hbp: 0, sf: 0, rbi: 0,
    sac: 0, gidp: 0, roe: 0,
    gamesPlayed: 0, _synthetic: true,
  }
}

// ─── Pitcher synthesis ──────────────────────────────────────────────────────

function synthesizePitcher(player, teamCtx, year, seed) {
  const rng = makeRng('synthP', player.id, year, seed)
  const games = teamCtx.games || 45
  const stuff = player.pitcher?.stuff ?? 50
  const control = player.pitcher?.control ?? 50
  const stamina = player.pitcher?.stamina ?? 50
  const velo = player.pitcher?.velocity_avg ?? player.measurables?.fbVeloMph ?? 87
  const ovr = playerOverall(player)
  const baseline = baselineFor(teamCtx.level)

  // IP allocation: top 4 SP each get ~85 IP, 5th SP ~55, top RP 30, mid RP 15.
  // Bench arms 5-10 IP. Estimate from pitcher's rank within team's pitching staff.
  const stuffRank = teamCtx.pitcherStuffRanks?.[player.id] ?? 999
  let ipTarget
  if (stuffRank <= 4) ipTarget = 85 - (stuffRank - 1) * 5
  else if (stuffRank === 5) ipTarget = 60
  else if (stuffRank <= 8) ipTarget = 30 - (stuffRank - 6) * 5      // closer / setup
  else if (stuffRank <= 14) ipTarget = 18 - (stuffRank - 9) * 2     // middle relief
  else ipTarget = 5
  const ipNoise = rng.gaussian(0, ipTarget * 0.15)
  const decimalIp = Math.max(0, ipTarget + ipNoise) * (games / 50)
  const outs = Math.round(decimalIp * 3)
  if (outs < 6) return zeroPitcherStats(player)

  // BF estimated from outs + WHIP-ish
  const bfPerOut = 1.34 + rng.gaussian(0, 0.05)
  const bf = Math.round(outs * bfPerOut)

  // Anchor at stuff/control 60 (typical staff mean rating) so the
  // baseline IS the league target for an average-quality pitcher.
  const RATING_ANCHOR = 60
  const kPct = clamp(baseline.kPct + (stuff - RATING_ANCHOR) * 0.0014 + (velo - 87) * 0.002 + rng.gaussian(0, 0.02), 0.05, 0.40)
  const k = Math.round(bf * kPct)
  const bbPct = clamp(baseline.bbPct - (control - RATING_ANCHOR) * 0.0014 + rng.gaussian(0, 0.018), 0.04, 0.22)
  const bb = Math.round(bf * bbPct)
  const hbpPct = clamp(baseline.hbpPct - (control - RATING_ANCHOR) * 0.0003 + rng.gaussian(0, 0.005), 0.004, 0.06)
  const hbp = Math.round(bf * hbpPct)
  // HR rate: derived from level baseline HR/PA (per-pitcher HR/9 backs out
  // from that) and suppressed by stuff + velo.
  const hr9Baseline = baseline.hrPerPa * (bf / Math.max(1, outs / 3)) * 9
  const hr9 = clamp(hr9Baseline - (stuff - RATING_ANCHOR) * 0.008 - (velo - 87) * 0.025 + rng.gaussian(0, 0.18), 0.05, 3.0)
  const ip = outs / 3
  const hr = Math.round(hr9 * ip / 9)

  // BABIP against — slight stuff suppression
  const babipAg = clamp(0.30 - (stuff - 50) * 0.001 + rng.gaussian(0, 0.020), 0.22, 0.38)
  const bipAtBats = bf - k - bb - hbp - hr
  const h = hr + Math.round(Math.max(0, bipAtBats) * babipAg)

  // ER from FIP-like component plus BABIP luck. Calibrated against
  // smoke-test → real-world: original 0.65 gave ERA 3.0, 0.85 gave 4.2,
  // 1.15 lands league ERA in the 5.2-5.9 band (D1 5.2 / NAIA 5.8 / D3 5.95).
  // Hit coefficient also bumped slightly since base hits → runs is
  // higher than FIP alone implies (baserunners convert at higher rates
  // in college than MLB due to weaker bullpens + more bunting/sacrifice).
  const expectedER = (h * 0.52 + bb * 0.45 + hbp * 0.42 + hr * 1.0) * 1.05
  const er = Math.max(0, Math.round(expectedER + rng.gaussian(0, expectedER * 0.10)))

  return {
    playerId: player.id,
    isPitcher: true,
    outs, ip,
    h, bb, k, er, hr, hbp,
    pa: bf,
    gamesPlayed: Math.round(games * (decimalIp / 70)),
    _synthetic: true,
  }
}

function zeroPitcherStats(player) {
  return {
    playerId: player.id, isPitcher: true,
    outs: 0, ip: 0, h: 0, bb: 0, k: 0, er: 0, hr: 0, hbp: 0,
    pa: 0, gamesPlayed: 0, _synthetic: true,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * Build the per-team context object the synthesizer needs. Walks the team's
 * roster, ranks position players by OVR (drives PT share) and pitchers by
 * stuff (drives IP share).
 */
export function buildTeamSynthesisContext(state, teamId) {
  const team = state.teams?.[teamId]
  if (!team) return null
  const roster = (team.rosterPlayerIds || [])
    .map(id => state.players[id])
    .filter(Boolean)
  const playedGames = (team.wins || 0) + (team.losses || 0)
  // Level-aware full-season game count, pulled from real NWBB Stats 2025
  // data (May 2026): D1 56, D2 52, D3 41, NAIA 45, NWAC 47. Used when the
  // team hasn't actually played yet (W-L still 0).
  const level = state.schools?.[teamId]?.level || 'NAIA'
  const expected = (LEVEL_BASELINES[level] || LEVEL_BASELINES.NAIA).gamesPerSeason
  const games = playedGames > 0 ? playedGames : expected
  const teamOffense = state.schools?.[teamId]?.programHistory ?? 50

  const positionPlayers = roster
    .filter(p => !p.isPitcher && p.eligibilityStatus !== 'cut' && p.eligibilityStatus !== 'dismissed')
    .map(p => ({ p, ovr: playerOverall(p) }))
    .sort((a, b) => b.ovr - a.ovr)
  const rosterOvrRanks = {}
  positionPlayers.forEach(({ p }, i) => { rosterOvrRanks[p.id] = i + 1 })

  const pitchers = roster
    .filter(p => p.isPitcher && p.eligibilityStatus !== 'cut' && p.eligibilityStatus !== 'dismissed')
    .map(p => ({ p, stuff: (p.pitcher?.stuff ?? 0) + (p.pitcher?.stamina ?? 0) * 0.3 }))
    .sort((a, b) => b.stuff - a.stuff)
  const pitcherStuffRanks = {}
  pitchers.forEach(({ p }, i) => { pitcherStuffRanks[p.id] = i + 1 })

  return {
    games,
    level,
    teamOffense,
    teamPitching: teamOffense,    // proxy until we have a real pitching rating
    rosterOvrRanks,
    pitcherStuffRanks,
  }
}

/**
 * Build a stats map for an entire team (synthesized for non-user teams, REAL
 * for the user's team if they have stats already).
 *
 * Returns: { 'b_xxxx': {...}, 'p_yyyy': {...} } same shape as save.playerStats.
 */
export function synthesizeTeamStats(state, teamId, year, seed) {
  const team = state.teams?.[teamId]
  if (!team) return {}
  const ctx = buildTeamSynthesisContext(state, teamId)
  if (!ctx) return {}
  const isUserTeam = teamId === state.userSchoolId
  const out = {}
  for (const pid of (team.rosterPlayerIds || [])) {
    const p = state.players[pid]
    if (!p) continue
    if (p.eligibilityStatus === 'cut' || p.eligibilityStatus === 'dismissed') continue
    const key = p.isPitcher ? `p_${pid}` : `b_${pid}`
    // Prefer REAL stats for the user's team
    if (isUserTeam && state.playerStats?.[key]) {
      out[key] = state.playerStats[key]
      continue
    }
    out[key] = synthesizeSeasonStats(p, ctx, year, seed)
  }
  return out
}

/**
 * Synthesize stats for every team in a given conference. Returns a flat map
 * of statKey → row, same as state.playerStats. Used to feed awards + the
 * Team Stats page.
 */
export function synthesizeConferenceStats(state, conferenceId, year, seed) {
  const conf = state.conferences?.[conferenceId]
  if (!conf) return {}
  const out = {}
  for (const teamId of (conf.schoolIds || [])) {
    const teamStats = synthesizeTeamStats(state, teamId, year, seed)
    for (const [k, v] of Object.entries(teamStats)) out[k] = v
  }
  return out
}

/**
 * Synthesize stats for the entire NAIA league. Heavier — walks every team.
 * Used for national-leader rankings on the Team Stats page.
 */
export function synthesizeLeagueStats(state, year, seed) {
  const out = {}
  for (const teamId of Object.keys(state.teams || {})) {
    const teamStats = synthesizeTeamStats(state, teamId, year, seed)
    for (const [k, v] of Object.entries(teamStats)) out[k] = v
  }
  return out
}

/**
 * Aggregate a team's stats from a stat map (per-player rows → team totals).
 * Used by the Team Stats page to compare your team to conference/NAIA avg.
 */
export function aggregateTeamStats(stateOrTeamRoster, statsMap) {
  const totals = {
    pa: 0, ab: 0, h: 0, d: 0, t: 0, hr: 0, bb: 0, k: 0, hbp: 0, sf: 0, rbi: 0,
    outs: 0, p_h: 0, p_bb: 0, p_k: 0, p_er: 0, p_hr: 0, p_hbp: 0, p_bf: 0,
  }
  const rosterIds = Array.isArray(stateOrTeamRoster)
    ? stateOrTeamRoster
    : (stateOrTeamRoster?.teams?.[stateOrTeamRoster.userSchoolId]?.rosterPlayerIds || [])
  for (const pid of rosterIds) {
    const b = statsMap[`b_${pid}`]
    if (b) {
      totals.pa += b.pa || 0
      totals.ab += b.ab || 0
      totals.h += b.h || 0
      totals.d += b.d || 0
      totals.t += b.t || 0
      totals.hr += b.hr || 0
      totals.bb += b.bb || 0
      totals.k += b.k || 0
      totals.hbp += b.hbp || 0
      totals.sf += b.sf || 0
      totals.rbi += b.rbi || 0
    }
    const p = statsMap[`p_${pid}`]
    if (p) {
      totals.outs += p.outs || 0
      totals.p_h += p.h || 0
      totals.p_bb += p.bb || 0
      totals.p_k += p.k || 0
      totals.p_er += p.er || 0
      totals.p_hr += p.hr || 0
      totals.p_hbp += p.hbp || 0
      totals.p_bf += p.pa || 0
    }
  }
  return totals
}
