/**
 * Stepwise live-game sim. Same PA-level engine as simGame, but exposed as a
 * state object you can step through one PA / one inning / to end-of-game.
 *
 * This is what drives the GameChanger-style "Enter Game" UI: you see each
 * plate appearance described in text (count's not modeled — just the result),
 * with outs, runners, and score updated after each PA. Between batters you
 * can make pitching changes or pinch-hits.
 *
 * Mutates its internal `state` object as PAs are simmed. Once the game ends,
 * `isOver()` returns true and the final result is in `getResult()`.
 */

import { makeRng } from './rng'
import { simPA } from './sim'

/**
 * Build a live-game runner.
 *
 * @param {{ batters: Player[], pitcherRotation: Player[] }} homeLineup
 * @param {{ batters: Player[], pitcherRotation: Player[] }} awayLineup
 * @param {{ homeMotivator?: number, awayMotivator?: number, homeTeamName?: string, awayTeamName?: string }} ctx
 * @param {string} seedKey
 */
export function createLiveGame(homeLineup, awayLineup, ctx, seedKey) {
  const rng = makeRng('live', seedKey)
  const state = {
    inning: 1,
    top: true,
    outs: 0,
    bases: [null, null, null],  // each base holds either null or the batter who reached
    homeRuns: 0,
    awayRuns: 0,
    homePAIndex: 0,
    awayPAIndex: 0,
    homePAs: 0,
    awayPAs: 0,
    // Active lineup snapshots (mutable — pinch hits / pitching changes swap entries)
    homeBatters: [...homeLineup.batters],
    awayBatters: [...awayLineup.batters],
    homePitcher: homeLineup.pitcherRotation[0],
    awayPitcher: awayLineup.pitcherRotation[0],
    homeBullpen: homeLineup.pitcherRotation.slice(1),
    awayBullpen: awayLineup.pitcherRotation.slice(1),
    homePitcherBF: 0,   // batters faced by current home pitcher
    awayPitcherBF: 0,
    // Event log — every PA + every inning boundary + every sub appears here
    events: [],
    isOver: false,
    final: null,
  }

  // Per-player accumulators (mirror simGame's structure)
  const batterStats = {}
  const pitcherStats = {}
  function bStat(id) {
    if (!batterStats[id]) batterStats[id] = { ab:0,h:0,d:0,t:0,hr:0,bb:0,k:0,rbi:0,pa:0,hbp:0,sf:0,sac:0,gidp:0,roe:0 }
    return batterStats[id]
  }
  function pStat(id) {
    if (!pitcherStats[id]) pitcherStats[id] = { ip:0,h:0,bb:0,k:0,er:0,outs:0,pa:0,hbp:0,hr:0 }
    return pitcherStats[id]
  }

  function pushEvent(ev) { state.events.push(ev) }

  function currentBatter() {
    return state.top
      ? state.awayBatters[state.awayPAIndex % 9]
      : state.homeBatters[state.homePAIndex % 9]
  }
  function currentPitcher() {
    return state.top ? state.homePitcher : state.awayPitcher
  }
  function battingTeamName() {
    return state.top ? (ctx.awayTeamName || 'Away') : (ctx.homeTeamName || 'Home')
  }
  function pitchingTeamName() {
    return state.top ? (ctx.homeTeamName || 'Home') : (ctx.awayTeamName || 'Away')
  }

  function checkEnd() {
    // Regulation: 9 innings, walk-off if home leads after top of 9, or away wins after bot of 9.
    if (state.inning >= 9 && !state.top && state.homeRuns > state.awayRuns) {
      finalize('Walk-off! Home wins.')
      return true
    }
    if (state.inning > 9 && state.top === true && state.outs === 0 && state.homeRuns !== state.awayRuns) {
      // After flipping back to top of extras, if score isn't tied we should have ended earlier
    }
    if (state.inning > 9 && state.homeRuns !== state.awayRuns && state.top) {
      // top of 10+ already started with a score gap (away just batted in 10th and went ahead)
      // — handled in finishHalfInning instead.
    }
    return false
  }

  function finalize(reason) {
    state.isOver = true
    for (const id of Object.keys(pitcherStats)) {
      pitcherStats[id].ip = pitcherStats[id].outs / 3
    }
    state.final = {
      homeRuns: state.homeRuns,
      awayRuns: state.awayRuns,
      innings: state.inning,
      events: state.events,
      boxscore: { batterStats, pitcherStats },
    }
    pushEvent({ kind: 'GAME_END', inning: state.inning, top: state.top, text: `Final: ${ctx.awayTeamName || 'Away'} ${state.awayRuns}, ${ctx.homeTeamName || 'Home'} ${state.homeRuns}.${reason ? ' ' + reason : ''}` })
  }

  function flipHalfInning() {
    state.outs = 0
    state.bases = [null, null, null]
    const wasTop = state.top
    if (wasTop) {
      // End of top — flip to bottom. If after 9 and home already leads, game's over.
      if (state.inning >= 9 && state.homeRuns > state.awayRuns) {
        finalize('Home wins — bottom of 9 not required.')
        return
      }
      state.top = false
      pushEvent({ kind: 'HALF_END', inning: state.inning, top: true, text: `End of top ${state.inning}. ${ctx.awayTeamName || 'Away'} ${state.awayRuns}, ${ctx.homeTeamName || 'Home'} ${state.homeRuns}.` })
    } else {
      // End of bottom — advance inning. If 9+ and someone leads, game's over.
      if (state.inning >= 9 && state.homeRuns !== state.awayRuns) {
        finalize('')
        return
      }
      state.top = true
      state.inning++
      pushEvent({ kind: 'HALF_END', inning: state.inning - 1, top: false, text: `End of ${state.inning - 1}. ${ctx.awayTeamName || 'Away'} ${state.awayRuns}, ${ctx.homeTeamName || 'Home'} ${state.homeRuns}.` })
      // Hard cap: 12 innings
      if (state.inning > 12) {
        finalize('Game called after 12 innings.')
      }
    }
  }

  /** Step a single plate appearance. Returns the event pushed. */
  function step() {
    if (state.isOver) return null
    const batter = currentBatter()
    const pitcher = currentPitcher()
    if (!batter || !pitcher) {
      finalize('Lineup exhausted.')
      return null
    }
    const motivator = state.top ? ctx.awayMotivator : ctx.homeMotivator
    const leverage = computeLeverage(state)
    const preRuns = state.top ? state.awayRuns : state.homeRuns
    let result = simPA(batter, pitcher, { leverage, coachMotivator: motivator }, rng)
    if (result.outcome === 'OUT') result = resolveOutSubtype(result, state, batter, rng)

    // Stats
    const b = bStat(batter.id)
    const p = pStat(pitcher.id)
    b.pa++; p.pa++
    state[state.top ? 'awayPAs' : 'homePAs']++
    if (state.top) state.homePitcherBF++; else state.awayPitcherBF++
    if (result.outcome === 'K') { b.ab++; b.k++; p.k++; p.outs++ }
    else if (result.outcome === 'OUT') { b.ab++; p.outs++ }
    else if (result.outcome === 'BB') { b.bb++; p.bb++ }
    else if (result.outcome === 'HBP') { b.hbp++; p.hbp++ }
    else if (result.outcome === 'SINGLE') { b.ab++; b.h++; p.h++ }
    else if (result.outcome === 'DOUBLE') { b.ab++; b.h++; b.d++; p.h++ }
    else if (result.outcome === 'TRIPLE') { b.ab++; b.h++; b.t++; p.h++ }
    else if (result.outcome === 'HR') { b.ab++; b.h++; b.hr++; p.h++; p.hr++ }
    else if (result.outcome === 'SAC_FLY') { b.sf++; p.outs++ }
    else if (result.outcome === 'SAC_BUNT') { b.sac++; p.outs++ }
    else if (result.outcome === 'GIDP') { b.ab++; b.gidp++; p.outs += 2 }
    else if (result.outcome === 'ERROR') { b.ab++; b.roe++ }

    applyOutcome(state, result, batter)
    const postRuns = state.top ? state.awayRuns : state.homeRuns
    if (postRuns > preRuns) {
      b.rbi += (postRuns - preRuns)
      p.er += (postRuns - preRuns)
    }
    if (state.top) state.awayPAIndex++; else state.homePAIndex++

    // Walk-off check after the PA
    if (state.inning >= 9 && !state.top && state.homeRuns > state.awayRuns) {
      const event = describePA(state, batter, pitcher, result, postRuns - preRuns)
      pushEvent(event)
      finalize('Walk-off!')
      return event
    }

    const event = describePA(state, batter, pitcher, result, postRuns - preRuns)
    pushEvent(event)

    // Inning end?
    if (state.outs >= 3) {
      flipHalfInning()
    }
    return event
  }

  /** Step until the current half-inning ends. */
  function simHalfInning() {
    const startInning = state.inning
    const startTop = state.top
    let safety = 0
    while (!state.isOver && state.inning === startInning && state.top === startTop && safety < 50) {
      step()
      safety++
    }
  }

  /** Step until end of game. Will run unbounded — caller's responsibility to know it terminates. */
  function simRest() {
    let safety = 0
    while (!state.isOver && safety < 500) {
      step()
      safety++
    }
    if (!state.isOver) finalize('Step cap hit — engine forced end.')
  }

  /** Pinch-hit: replace the next batter at a given lineup spot for the team on offense. */
  function pinchHit(side, spotIdx, newPlayer) {
    if (state.isOver) return
    const arr = side === 'home' ? state.homeBatters : state.awayBatters
    if (spotIdx < 0 || spotIdx > 8) return
    const prev = arr[spotIdx]
    arr[spotIdx] = newPlayer
    pushEvent({ kind: 'SUB', inning: state.inning, top: state.top, text: `${pitchingTeamName()} change: ${newPlayer.firstName} ${newPlayer.lastName} pinch-hits for ${prev.firstName} ${prev.lastName}.` })
  }

  /** Pitching change for the team currently pitching (defense). */
  function pitchingChange(newPitcher) {
    if (state.isOver) return
    const defendingSide = state.top ? 'home' : 'away'
    const prev = defendingSide === 'home' ? state.homePitcher : state.awayPitcher
    if (defendingSide === 'home') {
      state.homePitcher = newPitcher
      state.homePitcherBF = 0
      state.homeBullpen = state.homeBullpen.filter(p => p.id !== newPitcher.id)
    } else {
      state.awayPitcher = newPitcher
      state.awayPitcherBF = 0
      state.awayBullpen = state.awayBullpen.filter(p => p.id !== newPitcher.id)
    }
    pushEvent({
      kind: 'PITCHING_CHANGE',
      inning: state.inning, top: state.top,
      text: `${defendingSide === 'home' ? (ctx.homeTeamName || 'Home') : (ctx.awayTeamName || 'Away')} pitching change: ${newPitcher.firstName} ${newPitcher.lastName} replaces ${prev.firstName} ${prev.lastName}.`,
    })
  }

  return {
    state,
    step,
    simHalfInning,
    simRest,
    pinchHit,
    pitchingChange,
    isOver: () => state.isOver,
    getResult: () => state.final,
    currentBatter,
    currentPitcher,
    getBoxscore: () => ({ batterStats, pitcherStats }),
  }
}

// ─── Helpers (lifted from sim.js — we keep them local so we can extend with
// runner names for the live readout) ───────────────────────────────────────

function computeLeverage(state) {
  const inningWeight = state.inning >= 7 ? 1.5 : 1.0
  const scoreDiff = Math.abs(state.homeRuns - state.awayRuns)
  const closeWeight = scoreDiff <= 1 ? 1.6 : scoreDiff <= 3 ? 1.0 : 0.5
  return inningWeight * closeWeight
}

function resolveOutSubtype(result, state, batter, rng) {
  const outs = state.outs
  if (outs >= 2) return result
  const r1 = state.bases[0], r2 = state.bases[1], r3 = state.bases[2]
  if (result.type === 'flyout' && r3 && rng.chance(0.28)) return { ...result, outcome: 'SAC_FLY' }
  if (result.type === 'groundout' && (r1 || r2) && rng.chance(0.05)) return { ...result, outcome: 'SAC_BUNT' }
  if (result.type === 'groundout' && r1 && rng.chance(0.12)) return { ...result, outcome: 'GIDP' }
  return result
}

function applyOutcome(state, result, batter) {
  const team = state.top ? 'away' : 'home'
  if (result.outcome === 'OUT' || result.outcome === 'K') { state.outs++; return }
  if (result.outcome === 'BB' || result.outcome === 'HBP') { walkRunner(state, team, batter); return }
  if (result.outcome === 'SINGLE') { advance(state, team, 1, batter); return }
  if (result.outcome === 'DOUBLE') { advance(state, team, 2, batter); return }
  if (result.outcome === 'TRIPLE') { advance(state, team, 3, batter); return }
  if (result.outcome === 'HR') {
    const runs = state.bases.filter(b => b).length + 1
    state.bases = [null, null, null]
    score(state, team, runs)
    return
  }
  if (result.outcome === 'ERROR') { advance(state, team, 1, batter); return }
  if (result.outcome === 'SAC_FLY') {
    state.outs++
    if (state.bases[2]) { state.bases[2] = null; score(state, team, 1) }
    return
  }
  if (result.outcome === 'SAC_BUNT') {
    state.outs++
    if (state.bases[2]) { state.bases[2] = null; score(state, team, 1) }
    if (state.bases[1]) { state.bases[2] = state.bases[1]; state.bases[1] = null }
    if (state.bases[0]) { state.bases[1] = state.bases[0]; state.bases[0] = null }
    return
  }
  if (result.outcome === 'GIDP') { state.outs += 2; state.bases[0] = null; return }
}

function walkRunner(state, team, batter) {
  if (state.bases[0]) {
    if (state.bases[1]) {
      if (state.bases[2]) { score(state, team, 1) }
      state.bases[2] = state.bases[1]
    }
    state.bases[1] = state.bases[0]
  }
  state.bases[0] = batter
}

function advance(state, team, basesAdvanced, batter) {
  let runsScored = 0
  if (state.bases[2]) { runsScored++; state.bases[2] = null }
  if (state.bases[1]) {
    if (basesAdvanced >= 2) { runsScored++; state.bases[1] = null }
    else { state.bases[2] = state.bases[1]; state.bases[1] = null }
  }
  if (state.bases[0]) {
    if (basesAdvanced >= 3) { runsScored++; state.bases[0] = null }
    else if (basesAdvanced === 2) { state.bases[2] = state.bases[0]; state.bases[0] = null }
    else { state.bases[1] = state.bases[0]; state.bases[0] = null }
  }
  if (basesAdvanced === 1) state.bases[0] = batter
  else if (basesAdvanced === 2) state.bases[1] = batter
  else if (basesAdvanced === 3) state.bases[2] = batter
  if (runsScored > 0) score(state, team, runsScored)
}

function score(state, team, n) {
  if (team === 'home') state.homeRuns += n
  else state.awayRuns += n
}

// ─── Human-readable PA descriptions ────────────────────────────────────────

const OUTCOME_PHRASES = {
  K:       (b, p) => `${nm(b)} strikes out swinging.`,
  BB:      (b)    => `${nm(b)} walks.`,
  HBP:     (b)    => `${nm(b)} is hit by the pitch.`,
  SINGLE:  (b)    => `${nm(b)} singles to the outfield.`,
  DOUBLE:  (b)    => `${nm(b)} doubles into the gap.`,
  TRIPLE:  (b)    => `${nm(b)} laces a triple to the corner.`,
  HR:      (b)    => `🚀 ${nm(b)} HOMERS!`,
  SAC_FLY: (b)    => `${nm(b)} hits a sac fly. Run scores.`,
  SAC_BUNT:(b)    => `${nm(b)} lays down a sacrifice bunt.`,
  GIDP:    (b)    => `${nm(b)} grounds into a double play.`,
  ERROR:   (b)    => `${nm(b)} reaches on an error.`,
  OUT:     (b, _, type) => {
    if (type === 'groundout') return `${nm(b)} grounds out.`
    if (type === 'flyout') return `${nm(b)} flies out.`
    if (type === 'lineout') return `${nm(b)} lines out.`
    if (type === 'popout') return `${nm(b)} pops out.`
    return `${nm(b)} is out.`
  },
}

function nm(p) { return p ? `${p.firstName} ${p.lastName}` : '???' }

function describePA(state, batter, pitcher, result, runsScored) {
  const phrase = (OUTCOME_PHRASES[result.outcome] || ((b) => `${nm(b)}: ${result.outcome}`))(batter, pitcher, result.type)
  const runsSuffix = runsScored > 0 && result.outcome !== 'HR' && result.outcome !== 'SAC_FLY'
    ? ` ${runsScored} run${runsScored === 1 ? '' : 's'} score.`
    : ''
  return {
    kind: 'PA',
    inning: state.inning,
    top: state.top,
    outs: state.outs,
    bases: state.bases.map(b => b ? { id: b.id, name: nm(b) } : null),
    score: { home: state.homeRuns, away: state.awayRuns },
    outcome: result.outcome,
    batterId: batter.id,
    pitcherId: pitcher.id,
    text: phrase + runsSuffix,
  }
}
