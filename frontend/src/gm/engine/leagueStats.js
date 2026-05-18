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

function synthesizeBatter(player, teamCtx, year, seed) {
  const rng = makeRng('synthB', player.id, year, seed)
  const games = teamCtx.games || 50
  const ovr = playerOverall(player)

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

  // BB% — 9% baseline + 0.15% per discipline pt over 50. Real college BB%
  // sits at 10-11%; older 4% baseline was MLB-shaped and undershot OBP.
  const bbPct = clamp(0.09 + (disc - 50) * 0.0015 + rng.gaussian(0, 0.012), 0.04, 0.22)
  const bb = Math.round(pa * bbPct)
  // HBP — 1.2% baseline (real college HBP rate is higher than MLB)
  const hbpPct = clamp(0.012 + rng.gaussian(0, 0.004), 0, 0.05)
  const hbp = Math.round(pa * hbpPct)
  // K% — 22% baseline (real college K% sits at 21-24%, was way under at 18%
  // which inflated AVG/OPS by putting too many balls in play).
  // -0.18% per contact pt, +0.10% per power pt (power guys K more).
  const kPct = clamp(0.22 - (contact - 50) * 0.0018 + (power - 50) * 0.001 + rng.gaussian(0, 0.025), 0.06, 0.45)
  const k = Math.round(pa * kPct)
  // SF — small
  const sf = Math.round(pa * 0.012)
  const ab = Math.max(0, pa - bb - hbp - sf)

  // BABIP — 0.300 baseline (real college BABIP runs .310-.320; we sit a tick
  // below average and let contact + speed nudge up). +0.0012/contact pt,
  // +0.0008/speed pt over 50.
  const babip = clamp(0.300 + (contact - 50) * 0.0012 + (speed - 50) * 0.0008 + rng.gaussian(0, 0.025), 0.22, 0.40)
  const teamOff = teamCtx.teamOffense ?? 60
  const teamOffShift = (teamOff - 60) * 0.0008
  const babipAdj = clamp(babip + teamOffShift, 0.22, 0.40)
  // HR rate — power-driven. Real college HR per PA: D1 ~1.5%, NAIA ~2%,
  // D3 ~1.8%. Previous formula baseline 1.2% + steep slope was producing
  // ~2.6% for average hitters. Tightened to 0.7% baseline + gentler slope.
  const hrRate = clamp(0.007 + Math.max(0, power - 50) * 0.0008 + Math.max(0, power - 75) * 0.0014 + rng.gaussian(0, 0.004), 0.001, 0.08)
  const hr = Math.round(pa * hrRate)
  const bipAb = Math.max(0, ab - k - hr)
  let h = Math.round(bipAb * babipAdj) + hr
  h = Math.max(hr, Math.min(ab, h))

  // Split hits into 1B / 2B / 3B / HR. Real college doubles rate is ~15%
  // of non-HR hits; previous 18% baseline + 0.3% slope was inflating SLG
  // by 0.05-0.08. Trimmed.
  const nonHr = Math.max(0, h - hr)
  const doublePct = clamp(0.14 + (power - 50) * 0.002 + rng.gaussian(0, 0.018), 0.08, 0.28)
  const triplePct = clamp(0.014 + (speed - 50) * 0.0006, 0.004, 0.04)
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
  const games = teamCtx.games || 50
  const stuff = player.pitcher?.stuff ?? 50
  const control = player.pitcher?.control ?? 50
  const stamina = player.pitcher?.stamina ?? 50
  const velo = player.pitcher?.velocity_avg ?? player.measurables?.fbVeloMph ?? 87
  const ovr = playerOverall(player)

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

  // K%, BB%, HR rate from ratings. Baselines tuned to real college numbers
  // (D1 K% ~24%, NAIA ~21%, NWAC ~22%, D3 ~19%) rather than MLB-ish values.
  // Stuff slope reduced from 0.0035 → 0.0022 so elite arms top out around
  // 30% K rate rather than 36%+ (previously was producing K/9 of 11-12).
  const kPct = clamp(0.21 + (stuff - 50) * 0.0022 + (velo - 87) * 0.003 + rng.gaussian(0, 0.02), 0.06, 0.40)
  const k = Math.round(bf * kPct)
  const bbPct = clamp(0.11 - (control - 50) * 0.0020 + rng.gaussian(0, 0.018), 0.04, 0.22)
  const bb = Math.round(bf * bbPct)
  const hbpPct = clamp(0.018 - (control - 50) * 0.0003 + rng.gaussian(0, 0.005), 0.004, 0.05)
  const hbp = Math.round(bf * hbpPct)
  // HR rate suppressed by stuff + velo + opposing team strength
  const hr9 = clamp(1.0 - (stuff - 50) * 0.013 - (velo - 87) * 0.04 + rng.gaussian(0, 0.2), 0.2, 3.0)
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
  // Level-aware full-season game count (D1: 56, D2: 50, D3: 40, NAIA: 55,
  // NWAC: 36). Used when the team hasn't actually played yet (W-L still 0)
  // so synthesized stats project a realistic full-season volume rather
  // than every team getting a generic 50 games.
  const level = state.schools?.[teamId]?.level || 'NAIA'
  const FULL_SEASON = { D1: 56, D2: 50, D3: 40, NAIA: 55, NWAC: 36 }
  const expected = FULL_SEASON[level] ?? 50
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
