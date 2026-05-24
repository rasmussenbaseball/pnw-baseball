/**
 * Outbound transfers — your players entering the portal.
 *
 * Timing model:
 *   Mid-offseason (weeks 2-6 after season ends): dramatic events. Stars
 *     get poached by D1s. Disgruntled bench players surface.
 *   End-of-year cleanup (week 8+): the remaining "I'm leaving" decisions
 *     for less-attached players.
 *
 * Star vulnerability: even high-OVR players with good playing time can be
 * stolen by better D1 programs. This was Nate's specific direction.
 */

import { makeRng } from './rng'
import { playerOverall, playerPotentialOverall } from './playerRating'

/** @typedef {import('./types.js').Player} Player */

// Named D1 programs that can poach players. Mix of West Coast (more relevant
// to PNW NAIA) and a handful of national names. We pick weighted by region.
const D1_DESTINATIONS_WEST = [
  'Oregon State', 'Oregon', 'Washington', 'Washington State', 'Gonzaga',
  'Portland', 'Seattle U', 'Stanford', 'Cal', 'UCLA', 'USC',
  'Arizona', 'Arizona State', 'Long Beach State', 'San Diego State',
]
const D1_DESTINATIONS_NATIONAL = [
  'Texas Tech', 'TCU', 'Tennessee', 'LSU', 'Vanderbilt', 'Florida',
  'Arkansas', 'Oklahoma State', 'Kentucky', 'North Carolina', 'Wake Forest',
  'NC State', 'Virginia', 'Florida State', 'Mississippi State',
]
const D2_D3_FLAVOR = [
  'a Cal-Pac D2 program', 'a GNAC D2 program', 'a Northwest Conference D3 school',
  'a Pacific West D2 program', 'a SCIAC D3 school',
]
const NAIA_RIVAL_FLAVOR = [
  'a Mid-South Conference NAIA program', 'a Cascade Conference rival',
  'a Sooner Athletic Conference NAIA program', 'an NAIA southern program',
]

function pickD1Destination(playerState, rng) {
  // West coast players more likely to go to west coast D1s
  const westStates = ['WA', 'OR', 'CA', 'ID', 'NV', 'AZ', 'UT', 'MT']
  if (westStates.includes(playerState) && rng.chance(0.75)) {
    return rng.pick(D1_DESTINATIONS_WEST)
  }
  return rng.chance(0.5) ? rng.pick(D1_DESTINATIONS_WEST) : rng.pick(D1_DESTINATIONS_NATIONAL)
}

/**
 * Evaluate a player's transfer decision.
 *
 * Destinations are RELATIVE to the user's program level (per Nate). A D1 user
 * can have players transfer to a BETTER D1 program (D1_UP), a peer D1 (D1_LAT),
 * or DOWN to D2/D3 — but never "up to D1" because they're already there.
 *
 * @param {Player} player
 * @param {{ paShare: number, ipShare: number, userLevel?: string, teamPerformance?: number }} ctx
 *   userLevel — 'D1' | 'D2' | 'D3' | 'NAIA' | 'NWAC'
 *   teamPerformance — win% (0-1). Strong teams retain more players.
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @param {'MID_OFFSEASON' | 'LATE_OFFSEASON'} phase
 * @returns {{ transferring: boolean, destination: string | null, isStar: boolean, isD1: boolean }}
 */
export function evaluateTransfer(player, ctx, rng, phase = 'LATE_OFFSEASON') {
  if (player.classYear === 'SR') return { transferring: false, destination: null, isStar: false, isD1: false }
  if (!player.hidden) return { transferring: false, destination: null, isStar: false, isD1: false }

  const ovr = playerOverall(player)
  const potOvr = playerPotentialOverall(player)
  const loyalty = player.hidden.loyalty ?? 60
  const playingTime = player.isPitcher ? ctx.ipShare : ctx.paShare
  const userLevel = ctx.userLevel || 'NAIA'
  const winPct = typeof ctx.teamPerformance === 'number' ? ctx.teamPerformance : 0.5

  // STAR vulnerability — even with good playing time, top players can leave
  // for a bigger program (e.g. mid-D1 → blue-blood D1).
  const isStarLevel = ovr >= 85 || (ovr >= 78 && potOvr >= 88)

  // PERFORMANCE retention bonus: a winning team keeps more players. A team
  // at .700 retains a lot of guys; a team at .300 loses more. Symmetric.
  const perfMult = clampN(1 + (0.5 - winPct) * 0.9, 0.55, 1.4)

  // Pick a destination weighted-relative to userLevel.
  // For D1 user:
  //   STAR going up → D1_UP (a better D1 program)
  //   Decent + uppy → D1_LAT (lateral D1) or D1_DOWN (lower-tier D1)
  //   Bench / bad     → D1_DOWN, D2, D3
  // For D2/D3/NAIA users, fall back to legacy NAIA-perspective destinations.
  function pickDest(scenario) {
    if (userLevel === 'D1') {
      switch (scenario) {
        case 'STAR_UP':   return rng.weighted(['D1_UP', 'D1_LAT'], [80, 20])
        case 'GOOD_UP':   return rng.weighted(['D1_UP', 'D1_LAT', 'D1_DOWN'], [30, 50, 20])
        case 'MID_UP':    return rng.weighted(['D1_LAT', 'D1_DOWN', 'D2'], [40, 45, 15])
        case 'DOWN':      return rng.weighted(['D1_DOWN', 'D2', 'D3', 'JUCO'], [25, 40, 25, 10])
        case 'QUIT_TIER': return rng.weighted(['D1_DOWN', 'D2', 'D3', 'JUCO', 'QUIT'], [15, 25, 25, 25, 10])
      }
    }
    if (userLevel === 'D2') {
      switch (scenario) {
        case 'STAR_UP':   return rng.weighted(['D1', 'D2_UP'], [70, 30])
        case 'GOOD_UP':   return rng.weighted(['D1', 'D2_UP', 'D2_LAT'], [25, 45, 30])
        case 'MID_UP':    return rng.weighted(['D2_LAT', 'NAIA', 'D3'], [45, 35, 20])
        case 'DOWN':      return rng.weighted(['D2_LAT', 'D3', 'NAIA', 'JUCO'], [20, 40, 30, 10])
        case 'QUIT_TIER': return rng.weighted(['D3', 'NAIA', 'JUCO', 'QUIT'], [30, 30, 30, 10])
      }
    }
    if (userLevel === 'D3') {
      switch (scenario) {
        case 'STAR_UP':   return rng.weighted(['D1', 'D2'], [40, 60])
        case 'GOOD_UP':   return rng.weighted(['D2', 'D3_LAT', 'NAIA'], [40, 35, 25])
        case 'MID_UP':    return rng.weighted(['D3_LAT', 'NAIA', 'JUCO'], [50, 35, 15])
        case 'DOWN':      return rng.weighted(['D3_LAT', 'JUCO', 'NAIA'], [40, 35, 25])
        case 'QUIT_TIER': return rng.weighted(['JUCO', 'NAIA', 'QUIT'], [40, 30, 30])
      }
    }
    // NAIA + others — original behavior
    switch (scenario) {
      case 'STAR_UP':   return rng.weighted(['D1'], [100])
      case 'GOOD_UP':   return rng.weighted(['D1', 'NAIA', 'D2'], [55, 30, 15])
      case 'MID_UP':    return rng.weighted(['D1', 'NAIA', 'D2', 'D3'], [20, 50, 20, 10])
      case 'DOWN':      return rng.weighted(['NAIA', 'D2', 'D3', 'JUCO'], [50, 25, 15, 10])
      case 'QUIT_TIER': return rng.weighted(['NAIA', 'D2', 'D3', 'JUCO', 'QUIT'], [30, 25, 20, 15, 10])
    }
  }

  // Dramatic mid-offseason: stars poached + visible departures
  if (phase === 'MID_OFFSEASON') {
    // Star poaching: high-OVR players have a chance to leave for a bigger
    // program. ~12% baseline minus loyalty modifier, scaled by team-perf
    // (good seasons retain stars better — Nate's request).
    if (isStarLevel) {
      const baseProb = (0.12 - (loyalty / 1000)) * perfMult
      if (rng.chance(baseProb)) {
        const dest = pickDest('STAR_UP')
        return { transferring: true, destination: dest, isStar: true, isD1: dest.startsWith('D1') }
      }
    }
    // Highly disgruntled bench guys exit early
    const playingTimeFactor = playingTime < 0.15 && ovr >= 65 && loyalty < 50
    if (playingTimeFactor && rng.chance(0.18 * perfMult)) {
      const upAppeal = ovr >= 78 ? 0.5 : ovr >= 68 ? 0.25 : 0.05
      const dest = pickDest(rng.chance(upAppeal) ? 'GOOD_UP' : 'MID_UP')
      return { transferring: true, destination: dest, isStar: false, isD1: dest.startsWith('D1') }
    }
    return { transferring: false, destination: null, isStar: false, isD1: false }
  }

  // LATE_OFFSEASON — cleanup phase. Less dramatic, broader churn.
  let transferProb = 0
  const upAppeal = (ovr - 70) * 1.5 + (potOvr - ovr) * 1.0 + (playingTime < 0.3 ? 8 : 0)
  if (upAppeal >= 25 && !isStarLevel) transferProb = 0.10  // stars already evaluated in MID
  else if (upAppeal >= 10) transferProb = 0.25
  else if (upAppeal <= -5 && playingTime < 0.2 && loyalty < 50) transferProb = 0.22
  else transferProb = 0.04
  transferProb *= perfMult

  if (!rng.chance(transferProb)) return { transferring: false, destination: null, isStar: false, isD1: false }

  let destination
  if (upAppeal >= 25) destination = pickDest('GOOD_UP')
  else if (upAppeal >= 10) destination = pickDest('MID_UP')
  else if (upAppeal >= -5) destination = pickDest('DOWN')
  else destination = pickDest('QUIT_TIER')
  return {
    transferring: true,
    destination,
    isStar: false,
    isD1: destination.startsWith('D1') && destination !== 'D1_DOWN' ? true : (destination === 'D1' || destination === 'D1_UP'),
  }
}

function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

/**
 * Run transfer evaluation for one phase. Mutates state.
 *
 * @param {import('./types.js').SaveState} state
 * @param {'MID_OFFSEASON' | 'LATE_OFFSEASON'} phase
 * @returns {{ transferred: any[] }}
 */
export function runOutboundTransfers(state, phase = 'LATE_OFFSEASON') {
  const userTeam = state.teams[state.userSchoolId]
  if (!userTeam) return { transferred: [] }
  const rosterIds = userTeam.rosterPlayerIds
  const rng = makeRng('outTrans', state.userSchoolId, state.calendar.year, state.rngSeed, phase)

  const totalPA = Object.values(state.playerStats || {}).reduce((s, x) => s + (x.pa || 0), 0)
  const totalIP = Object.values(state.playerStats || {}).reduce((s, x) => s + (x.ip || 0), 0)
  function playingTime(player) {
    const key = player.isPitcher ? `p_${player.id}` : `b_${player.id}`
    const stats = state.playerStats?.[key]
    if (!stats) return 0.05
    if (player.isPitcher) return stats.ip / Math.max(1, totalIP / 5)
    return stats.pa / Math.max(1, totalPA / 9)
  }

  // Team performance — used to dampen transfers when the program is winning.
  // Per Nate: a strong, well-performing program holds onto more players.
  const userLevel = state.level || state.schools?.[state.userSchoolId]?.level || 'NAIA'
  const wins = userTeam.wins ?? userTeam._lastSeason?.wins ?? 0
  const losses = userTeam.losses ?? userTeam._lastSeason?.losses ?? 0
  const totalGames = wins + losses
  const teamPerformance = totalGames > 0 ? wins / totalGames : 0.5

  const transferred = []
  for (const id of [...rosterIds]) {
    const player = state.players[id]
    if (!player || player.eligibilityStatus === 'graduated' || player.eligibilityStatus === 'transferred') continue
    const result = evaluateTransfer(player, {
      paShare: player.isPitcher ? 0 : playingTime(player),
      ipShare: player.isPitcher ? playingTime(player) : 0,
      userLevel,
      teamPerformance,
    }, rng, phase)
    if (!result.transferring) continue

    userTeam.rosterPlayerIds = userTeam.rosterPlayerIds.filter(x => x !== id)
    state.players[id] = { ...player, eligibilityStatus: 'transferred', transferredTo: result.destination }
    transferred.push({ player, destination: result.destination, isStar: result.isStar, isD1: result.isD1 })
  }

  // News events — named destinations where possible
  for (const t of transferred) {
    let destText
    if (t.destination === 'D1') {
      const dest = pickD1Destination(t.player.hometown.state, rng)
      destText = `committed to ${dest} (D1)`
    } else if (t.destination === 'D1_UP') {
      // Player going UP to a bigger D1 (SEC / ACC / Big-12 blue blood)
      const dest = rng.pick(D1_DESTINATIONS_NATIONAL)
      destText = `transferred up to ${dest} (D1)`
    } else if (t.destination === 'D1_LAT') {
      // Lateral D1 move (similar tier)
      const dest = pickD1Destination(t.player.hometown.state, rng)
      destText = `transferred to ${dest} (D1)`
    } else if (t.destination === 'D1_DOWN') {
      // Stepping down to a smaller D1 program
      destText = `transferred to a smaller D1 program`
    } else if (t.destination === 'D2_UP') {
      destText = `transferred to a top-tier D2 program`
    } else if (t.destination === 'D2_LAT') {
      destText = `transferred to ${rng.pick(D2_D3_FLAVOR)}`
    } else if (t.destination === 'D3_LAT') {
      destText = `transferred to a peer D3 program`
    } else if (t.destination === 'NAIA') {
      destText = `transferred to ${rng.pick(NAIA_RIVAL_FLAVOR)}`
    } else if (t.destination === 'D2' || t.destination === 'D3') {
      destText = `transferred to ${rng.pick(D2_D3_FLAVOR)}`
    } else if (t.destination === 'JUCO') {
      destText = 'dropped to JUCO'
    } else if (t.destination === 'QUIT') {
      destText = 'left baseball'
    } else {
      destText = 'entered the portal'
    }
    const prefix = t.isStar ? '' : ''
    state.newsfeed.unshift({
      id: `out_${t.player.id}_${state.calendar.year}_${phase}`,
      year: state.calendar.year,
      week: state.calendar.weekOfYear,
      type: 'TRANSFER_OUT',
      headline: `${prefix} ${t.player.firstName} ${t.player.lastName} (${t.player.classYear}, ${t.player.primaryPosition}) ${destText}.`,
      payload: { destination: t.destination, playerId: t.player.id, isStar: t.isStar },
    })
  }
  if (transferred.length > 0) {
    // Capture departures for a Dashboard popup so the user always sees who they
    // lost (not just a buried news line).
    state._newDepartures = [...(state._newDepartures || []), ...transferred.map(t => ({
      id: t.player.id,
      name: `${t.player.firstName} ${t.player.lastName}`,
      classYear: t.player.classYear,
      pos: t.player.primaryPosition,
      dest: t.destination,
      isStar: !!t.isStar,
    }))]
    state.newsfeed.unshift({
      id: `out_summary_${state.calendar.year}_${phase}`,
      year: state.calendar.year,
      week: state.calendar.weekOfYear,
      type: 'TRANSFER_OUT',
      headline: phase === 'MID_OFFSEASON'
        ? `Early portal activity: ${transferred.length} player${transferred.length === 1 ? '' : 's'} leaving the program.`
        : `Late offseason: ${transferred.length} more player${transferred.length === 1 ? '' : 's'} entered the portal.`,
      payload: { count: transferred.length, phase },
    })
  }

  return { transferred }
}
