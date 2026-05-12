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
 * @param {Player} player
 * @param {{ paShare: number, ipShare: number }} ctx
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

  // STAR vulnerability — even with good playing time, top players can leave for D1
  const isStarLevel = ovr >= 85 || (ovr >= 78 && potOvr >= 88)

  // Dramatic mid-offseason: stars poached + visible departures
  if (phase === 'MID_OFFSEASON') {
    // Star poaching: high-OVR players have a chance to leave regardless of PT
    if (isStarLevel) {
      // Even playing every day, ~12% chance to be poached
      const baseProb = 0.12 - (loyalty / 1000)
      if (rng.chance(baseProb)) {
        return { transferring: true, destination: 'D1', isStar: true, isD1: true }
      }
    }
    // Highly disgruntled bench guys exit early
    const playingTimeFactor = playingTime < 0.15 && ovr >= 65 && loyalty < 50
    if (playingTimeFactor && rng.chance(0.18)) {
      const upAppeal = ovr >= 78 ? 0.5 : ovr >= 68 ? 0.25 : 0.05
      return rng.chance(upAppeal)
        ? { transferring: true, destination: 'D1', isStar: false, isD1: true }
        : { transferring: true, destination: 'NAIA', isStar: false, isD1: false }
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

  if (!rng.chance(transferProb)) return { transferring: false, destination: null, isStar: false, isD1: false }

  let destination
  if (upAppeal >= 25) destination = rng.weighted(['D1', 'NAIA', 'D2'], [55, 30, 15])
  else if (upAppeal >= 10) destination = rng.weighted(['D1', 'NAIA', 'D2', 'D3'], [20, 50, 20, 10])
  else if (upAppeal >= -5) destination = rng.weighted(['NAIA', 'D2', 'D3', 'JUCO'], [50, 25, 15, 10])
  else destination = rng.weighted(['NAIA', 'D2', 'D3', 'JUCO', 'QUIT'], [30, 25, 20, 15, 10])
  return {
    transferring: true,
    destination,
    isStar: false,
    isD1: destination === 'D1',
  }
}

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

  const transferred = []
  for (const id of [...rosterIds]) {
    const player = state.players[id]
    if (!player || player.eligibilityStatus === 'graduated' || player.eligibilityStatus === 'transferred') continue
    const result = evaluateTransfer(player, {
      paShare: player.isPitcher ? 0 : playingTime(player),
      ipShare: player.isPitcher ? playingTime(player) : 0,
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
    const prefix = t.isStar ? '🌟📤' : '📤'
    state.newsfeed.unshift({
      id: `out_${t.player.id}_${state.calendar.year}_${phase}`,
      year: state.calendar.year + 1,
      week: phase === 'MID_OFFSEASON' ? 3 : 18,
      type: 'TRANSFER_OUT',
      headline: `${prefix} ${t.player.firstName} ${t.player.lastName} (${t.player.classYear}, ${t.player.primaryPosition}) ${destText}.`,
      payload: { destination: t.destination, playerId: t.player.id, isStar: t.isStar },
    })
  }
  if (transferred.length > 0) {
    state.newsfeed.unshift({
      id: `out_summary_${state.calendar.year}_${phase}`,
      year: state.calendar.year + 1,
      week: phase === 'MID_OFFSEASON' ? 3 : 18,
      type: 'TRANSFER_OUT',
      headline: phase === 'MID_OFFSEASON'
        ? `Early portal activity: ${transferred.length} player${transferred.length === 1 ? '' : 's'} leaving the program.`
        : `Late offseason: ${transferred.length} more player${transferred.length === 1 ? '' : 's'} entered the portal.`,
      payload: { count: transferred.length, phase },
    })
  }

  return { transferred }
}
