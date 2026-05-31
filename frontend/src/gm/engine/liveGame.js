/**
 * Stepwise live-game sim. Same PA-level engine as simGame, but exposed as a
 * state object you can step through one PA / one inning / to end-of-game.
 *
 * This is what drives the GameChanger-style "Enter Game" UI: you see each
 * plate appearance described in text (count's not modeled — just the result),
 * with outs, runners, and score updated after each PA. Between batters you
 * can make pitching changes or pinch-hits.
 *
 * Mutates its internal `state`object as PAs are simmed. Once the game ends,
 * `isOver()`returns true and the final result is in `getResult()`.
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
  // Field-position assignment: prefer the lineup's per-slot batterPositions
  // (set by the LineupEditor — players may be playing OUT OF position) and
  // fall back to each batter's primaryPosition for legacy/default lineups.
  // First-match-wins per slot.
  function deriveFielders(lineup, pitcher) {
    const out = {}
    const positions = lineup.batterPositions || lineup.batters.map(b => b?.primaryPosition)
    for (let i = 0; i < lineup.batters.length; i++) {
      const b = lineup.batters[i]
      const pos = positions[i] || b?.primaryPosition
      if (!b || !pos || pos === 'DH') continue
      if (!out[pos]) out[pos] = b
    }
    if (pitcher) out['P'] = pitcher
    return out
  }
  // Per-side bench = roster players not in starting lineup or bullpen.
  // Filled later by Play.jsx when we know the full roster; default empty.
  const state = {
    inning: 1,
    top: true,
    outs: 0,
    bases: [null, null, null],
    balls: 0,            // pitch count this PA (running ball count for the batter)
    strikes: 0,
    homeRuns: 0,
    awayRuns: 0,
    homeHits: 0,
    awayHits: 0,
    homeErrors: 0,
    awayErrors: 0,
    homePAIndex: 0,
    awayPAIndex: 0,
    homePAs: 0,
    awayPAs: 0,
    // Per-inning linescore — index N = runs in inning N+1 for that side.
    // Buckets are added at the START of each half-inning (top of N starts
    // a new away bucket; bottom of N starts a new home bucket). We seed
    // with just the top-of-1 away bucket here; everything else flows from
    // flipHalfInning() pushing the NEXT half's bucket on entry. Avoids the
    // off-by-one that previously put bottom-of-8 runs in the inning-9 box.
    linescore: { home: [], away: [0] },
    // Active lineup snapshots (mutable — subs swap entries)
    homeBatters: [...homeLineup.batters],
    awayBatters: [...awayLineup.batters],
    homePitcher: homeLineup.pitcherRotation[0],
    awayPitcher: awayLineup.pitcherRotation[0],
    homeBullpen: homeLineup.pitcherRotation.slice(1),
    awayBullpen: awayLineup.pitcherRotation.slice(1),
    homeBench: [...(homeLineup.bench || [])],
    awayBench: [...(awayLineup.bench || [])],
    homeFielders: deriveFielders(homeLineup, homeLineup.pitcherRotation[0]),
    awayFielders: deriveFielders(awayLineup, awayLineup.pitcherRotation[0]),
    // Per-pitcher live state. Pitch count, fatigue, confidence track the
    // CURRENT pitcher only — when a pitching change happens these reset.
    homePitcherBF: 0,
    awayPitcherBF: 0,
    homePitches: 0,       // estimated pitch count for current home pitcher
    awayPitches: 0,
    homeFatigue: 0,       // 0..100. Higher = more tired. 100 = gassed.
    awayFatigue: 0,
    homeConfidence: 50,   // 0..100. Anchored to composure; ±10-15 from events.
    awayConfidence: 50,
    // Per-pitcher line so far (in-game): IP, H, R, ER, BB, K, HR, HBP, BF
    homePitcherLine: zeroPitcherLine(),
    awayPitcherLine: zeroPitcherLine(),
    events: [],
    isOver: false,
    final: null,
  }
  // Composure-anchored confidence baseline
  state.homeConfidence = state.homePitcher?.pitcher?.composure ?? 50
  state.awayConfidence = state.awayPitcher?.pitcher?.composure ?? 50

  // Per-player accumulators (mirror simGame's structure)
  const batterStats = {}
  const pitcherStats = {}
  function bStat(id) {
    if (!batterStats[id]) batterStats[id] = { ab:0,h:0,d:0,t:0,hr:0,bb:0,k:0,rbi:0,pa:0,hbp:0,sf:0,sac:0,gidp:0,roe:0,sb:0,cs:0 }
    return batterStats[id]
  }
  function pStat(id) {
    if (!pitcherStats[id]) pitcherStats[id] = { ip:0,h:0,bb:0,k:0,er:0,outs:0,pa:0,hbp:0,hr:0 }
    return pitcherStats[id]
  }

  function pushEvent(ev) { state.events.push(ev) }

  function currentBatter() {
    const order = state.top ? state.awayBatters : state.homeBatters
    const idx = state.top ? state.awayPAIndex : state.homePAIndex
    if (!order || order.length === 0) return null
    // Defensive: if the indexed slot is empty (a short/holey order slipped
    // through lineup construction), scan forward for the next real batter
    // rather than ending the game. Only return null if the whole order is
    // empty. Pairs with the 9-man padding in lineups.autoLineup.
    const direct = order[idx % order.length]
    if (direct) return direct
    for (let i = 1; i < order.length; i++) {
      const b = order[(idx + i) % order.length]
      if (b) return b
    }
    return null
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
      // Pass through the lineups (including pitcherRotation + bench) so the
      // box-score modal can build a player-id → name map for synthetic
      // opponents that aren't in save.players.
      homeLineup, awayLineup,
    }
    pushEvent({ kind: 'GAME_END', inning: state.inning, top: state.top, text: `Final: ${ctx.awayTeamName || 'Away'} ${state.awayRuns}, ${ctx.homeTeamName || 'Home'} ${state.homeRuns}.${reason ? ' ' + reason : ''}` })
  }

  function flipHalfInning() {
    state.outs = 0
    state.bases = [null, null, null]
    // Reset the per-PA pitch count tracker (we keep cumulative pitches on the
    // current pitcher, but the balls/strikes display resets each PA naturally)
    state.balls = 0
    state.strikes = 0
    // Partial fatigue recovery between innings — a tired pitcher gets a
    // breather sitting in the dugout. Reduced to -3 (was -6) so the recovery
    // doesn't completely cancel out per-pitch fatigue gain. With the new
    // fatigue rate (~1.0/pitch), -3/inning leaves a clear arc: a starter
    // climbs from Fresh → OK → Tiring → Gassed across a 7-inning outing.
    const sideKey = state.top ? 'home' : 'away'   // the side that just finished pitching
    state[`${sideKey}Fatigue`] = Math.max(0, state[`${sideKey}Fatigue`] - 3)

    // Confidence drifts gently back toward the pitcher's composure baseline
    // between innings (a small mental reset in the dugout). Bias is +1/3 of
    // the gap toward composure, capped at ±4 per inning — so a rattled
    // pitcher (down at 20 with composure 50) ticks up ~4 each frame, but
    // a hot one above their baseline cools slightly. Never RESETS, only
    // drifts: a guy who gave up 6 runs still walks back out shaken.
    const currentPitcher = sideKey === 'home' ? state.homePitcher : state.awayPitcher
    const baseline = currentPitcher?.pitcher?.composure ?? 50
    const conf = state[`${sideKey}Confidence`]
    const gap = baseline - conf
    const drift = Math.max(-4, Math.min(4, gap / 3))
    state[`${sideKey}Confidence`] = Math.max(0, Math.min(100, conf + drift))

    // Opponent-side auto-sub. If the opposing pitcher (NOT the user's) is
    // gassed (fatigue ≥ 75) or has thrown a clearly-too-many pitches (≥ 95)
    // and the bullpen has fresh arms, the AI brings in a reliever. This
    // stops the previous bug where opponent CG'd at 200 pitches because the
    // engine had no AI sub logic.
    const oppSide = ctx.userSide === 'home' ? 'away' : 'home'
    if (sideKey === oppSide) {
      const oppFatigue = state[`${oppSide}Fatigue`]
      const oppPitches = state[`${oppSide}Pitches`]
      const bullpen = state[`${oppSide}Bullpen`]
      if ((oppFatigue >= 75 || oppPitches >= 95) && bullpen.length > 0) {
        const next = bullpen[0]
        // Manual inline swap (we're already inside flipHalfInning so we can't
        // call pitchingChange which posts a SUB event mid-flow — but we can
        // mirror its effect here, then push the event).
        const prev = state[`${oppSide}Pitcher`]
        state[`${oppSide}Pitcher`] = next
        state[`${oppSide}PitcherBF`] = 0
        state[`${oppSide}Pitches`] = 0
        state[`${oppSide}Fatigue`] = 0
        state[`${oppSide}Confidence`] = next?.pitcher?.composure ?? 50
        state[`${oppSide}PitcherLine`] = zeroPitcherLine()
        state[`${oppSide}Fielders`]['P'] = next
        state[`${oppSide}Bullpen`] = bullpen.filter(p => p.id !== next.id)
        pushEvent({
          kind: 'PITCHING_CHANGE',
          inning: state.inning, top: state.top,
          text: `${oppSide === 'home' ? (ctx.homeTeamName || 'Home') : (ctx.awayTeamName || 'Away')} pulls ${prev?.firstName} ${prev?.lastName} for ${next.firstName} ${next.lastName}.`,
        })
      }
    }
    const wasTop = state.top
    if (wasTop) {
      // College 10-run rule: home leads by 10+ after 7+ complete innings →
      // home doesn't bat, game over.
      if (state.inning >= 7 && (state.homeRuns - state.awayRuns) >= 10) {
        finalize('Run rule — home leads by 10+ after 7.')
        return
      }
      if (state.inning >= 9 && state.homeRuns > state.awayRuns) {
        finalize('Home wins — bottom of 9 not required.')
        return
      }
      state.top = false
      // Start a new home-half inning bucket in the linescore
      state.linescore.home.push(0)
      pushEvent({ kind: 'HALF_END', inning: state.inning, top: true, text: `End of top ${state.inning}. ${ctx.awayTeamName || 'Away'} ${state.awayRuns}, ${ctx.homeTeamName || 'Home'} ${state.homeRuns}.` })
    } else {
      // College 10-run rule: either team leading by 10+ after 7+ complete
      // innings ends the game.
      if (state.inning >= 7 && Math.abs(state.homeRuns - state.awayRuns) >= 10) {
        finalize('Run rule — 10-run lead after 7.')
        return
      }
      if (state.inning >= 9 && state.homeRuns !== state.awayRuns) {
        finalize('')
        return
      }
      state.top = true
      state.inning++
      // Start a new away-half inning bucket
      state.linescore.away.push(0)
      pushEvent({ kind: 'HALF_END', inning: state.inning - 1, top: false, text: `End of ${state.inning - 1}. ${ctx.awayTeamName || 'Away'} ${state.awayRuns}, ${ctx.homeTeamName || 'Home'} ${state.homeRuns}.` })
      // No inning cap — play to a winner. 30-inning bound is an infinite-loop
      // safety valve only (real games never reach it).
      if (state.inning > 30) {
        finalize('Game called after 30 innings.')
      }
    }
  }

  /**
   * Attempt a steal of 2nd if there's a runner on 1B with 2B empty and
   * fewer than 2 outs. Probability:
   *   - 1B runner's speed: high speed = more likely to GO
   *   - Catcher's arm + fielding: drives the throwout rate
   * NAIA SB averages: ~1.2 attempts/game, ~72% success rate.
   * Calibration: at speed=50 / catcher arm=50 / fielding=50:
   *   ~10% per-PA chance of an attempt, ~70% success rate.
   */
  function maybeAttemptSteal() {
    if (state.outs >= 2) return            // not stealing with 2 outs (high downside)
    const r1 = state.bases[0]
    if (!r1) return
    if (state.bases[1]) return             // 2B occupied, can't steal into it
    const runnerSpeed = r1.hitter?.speed ?? 50
    // Attempt probability scales with speed AND with the runner's odds of
    // success — slow guys don't attempt, fast guys go often. Previously the
    // attempt rate at avg speed was 10% regardless of success odds, so
    // mid-speed runners on slow rosters got thrown out a lot. Now requires
    // a real green light: only attempt when speed > 55, and probability
    // ramps up sharply with speed.
    if (runnerSpeed < 55) return
    const attemptProb = Math.max(0, Math.min(0.45, (runnerSpeed - 55) * 0.012))
    if (!rng.chance(attemptProb)) return

    // Defending catcher
    const defendingFielders = state.top ? state.homeFielders : state.awayFielders
    const catcher = defendingFielders?.['C']
    const catcherArm = catcher?.hitter?.arm ?? 50
    const catcherFld = catcher?.hitter?.fielding ?? 50
    // Catcher's pop time proxy: weighted blend of arm (60%) + fielding (40%)
    const catcherPop = catcherArm * 0.6 + catcherFld * 0.4
    // Pitcher hold — small contribution from pitcher's command + composure
    const stealPitcher = currentPitcher()
    const pitchHold = ((stealPitcher?.pitcher?.command ?? 50) * 0.5 + (stealPitcher?.pitcher?.composure ?? 50) * 0.5)
    // Success probability — anchored at real-world college baseline (~75%
    // success on stolen-base attempts). Was 70% before but compounded with
    // a steep swing on (speed - pop), which left mid-speed runners getting
    // caught most of the time vs decent catchers. New formula: higher base
    // + gentler swing.
    const successBase = 0.78 + (runnerSpeed - catcherPop) * 0.003 - (pitchHold - 50) * 0.0008
    const successProb = Math.max(0.45, Math.min(0.95, successBase))
    const successful = rng.chance(successProb)
    const runnerName = nm(r1)
    if (successful) {
      state.bases[1] = r1
      state.bases[0] = null
      // Stat: stolen base for runner
      const bsObj = bStat(r1.id)
      bsObj.sb = (bsObj.sb || 0) + 1
      pushEvent({
        kind: 'STEAL',
        inning: state.inning, top: state.top,
        text: `${runnerName} steals 2B!`,
        outs: state.outs, score: { home: state.homeRuns, away: state.awayRuns },
      })
    } else {
      state.bases[0] = null
      state.outs++
      const bsObj = bStat(r1.id)
      bsObj.cs = (bsObj.cs || 0) + 1
      pushEvent({
        kind: 'STEAL',
        inning: state.inning, top: state.top,
        text: `${runnerName} caught stealing — ${nm(catcher) || 'C'} throws him out.`,
        outs: state.outs, score: { home: state.homeRuns, away: state.awayRuns },
      })
      // Inning end?
      if (state.outs >= 3) {
        flipHalfInning()
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

    // STEAL ATTEMPTS — happen BEFORE the PA when a runner on 1B + 2B
    // empty + outs < 2 + speedy runner. Multiple steals can chain (a
    // double-steal from R1+R3 would be modeled separately; for now we
    // only attempt the lead runner). One steal attempt per PA max.
    maybeAttemptSteal()
    if (state.outs >= 3) {
      flipHalfInning()
      return null
    }

    const motivator = state.top ? ctx.awayMotivator : ctx.homeMotivator
    const leverage = computeLeverage(state)
    const preRuns = state.top ? state.awayRuns : state.homeRuns
    // Defenders = the fielding side's 9 starters + their played positions
    // (so the sim can apply the out-of-position fielding penalty). Build the
    // parallel arrays from the fielders map.
    const fielderMap = state.top ? state.homeFielders : state.awayFielders
    const defenders = []
    const defenderPositions = []
    for (const [pos, p] of Object.entries(fielderMap)) {
      if (!p || pos === 'P') continue
      defenders.push(p)
      defenderPositions.push(pos)
    }
    const batterEnergy = ctx.getEnergy ? ctx.getEnergy(batter.id) : 100
    // Combine CROSS-GAME energy (drained between games) with IN-GAME fatigue
    // (accumulated per-pitch this game). Before this, only cross-game energy
    // reached simPA, so a starter could throw 100 pitches in one game with
    // zero in-engine drop-off (Zack's "complete game every time" report).
    // Treat in-game fatigue as up to -50 energy at the gassed cap (100), so
    // a 90-pitch starter at "gassed" effectively pitches at ~50 energy →
    // ~14% rating regression toward 50.
    const inGameFatigue = state.top ? state.homeFatigue : state.awayFatigue
    const baseEnergy = ctx.getEnergy ? ctx.getEnergy(pitcher.id) : 100
    const pitcherEnergy = Math.max(0, Math.min(100, baseEnergy - inGameFatigue * 0.5))
    let result = simPA(batter, pitcher, {
      leverage,
      coachMotivator: motivator,
      defenders,
      defenderPositions,
      batterEnergy,
      pitcherEnergy,
    }, rng)
    if (result.outcome === 'OUT') result = resolveOutSubtype(result, state, batter, rng)

    // Stats
    const b = bStat(batter.id)
    const p = pStat(pitcher.id)
    b.pa++; p.pa++
    state[state.top ? 'awayPAs' : 'homePAs']++
    if (state.top) state.homePitcherBF++; else state.awayPitcherBF++
    // Pitch count, fatigue, confidence — applied to the CURRENT pitcher on
    // the defensive side. estimatePitchesForPA gives a believable count from
    // the outcome (Ks are longer ABs, BBs longer still, BIP shorter).
    const pitchesThisPA = estimatePitchesForPA(result.outcome, rng)
    const fatigueDelta = computeFatigueDelta(pitcher, pitchesThisPA)
    const confidenceShift = computeConfidenceShift(result.outcome)
    const sideKey = state.top ? 'home' : 'away'
    state[`${sideKey}Pitches`] += pitchesThisPA
    state[`${sideKey}Fatigue`] = Math.max(0, Math.min(100, state[`${sideKey}Fatigue`] + fatigueDelta))
    state[`${sideKey}Confidence`] = Math.max(0, Math.min(100, state[`${sideKey}Confidence`] + confidenceShift))
    // Pitcher in-game line
    const pLine = state[`${sideKey}PitcherLine`]
    pLine.bf++
    pLine.pitches = state[`${sideKey}Pitches`]
    if (result.outcome === 'K') { b.ab++; b.k++; p.k++; p.outs++; pLine.k++; pLine.outs++ }
    else if (result.outcome === 'OUT') { b.ab++; p.outs++; pLine.outs++ }
    else if (result.outcome === 'BB') { b.bb++; p.bb++; pLine.bb++ }
    else if (result.outcome === 'HBP') { b.hbp++; p.hbp++; pLine.hbp++ }
    else if (result.outcome === 'SINGLE') { b.ab++; b.h++; p.h++; pLine.h++; bumpHits(state) }
    else if (result.outcome === 'DOUBLE') { b.ab++; b.h++; b.d++; p.h++; pLine.h++; bumpHits(state) }
    else if (result.outcome === 'TRIPLE') { b.ab++; b.h++; b.t++; p.h++; pLine.h++; bumpHits(state) }
    else if (result.outcome === 'HR') { b.ab++; b.h++; b.hr++; p.h++; p.hr++; pLine.h++; pLine.hr++; bumpHits(state) }
    else if (result.outcome === 'SAC_FLY') { b.sf++; p.outs++; pLine.outs++ }
    else if (result.outcome === 'SAC_BUNT') { b.sac++; p.outs++; pLine.outs++ }
    else if (result.outcome === 'GIDP') { b.ab++; b.gidp++; p.outs += 2; pLine.outs += 2 }
    else if (result.outcome === 'ERROR') {
      b.ab++; b.roe++
      // Charge an error to the FIELDING side
      state[state.top ? 'homeErrors' : 'awayErrors']++
    }

    applyOutcome(state, result, batter)
    const postRuns = state.top ? state.awayRuns : state.homeRuns
    if (postRuns > preRuns) {
      b.rbi += (postRuns - preRuns)
      p.er += (postRuns - preRuns)
      // In-game pitcher line tracks earned + total runs against
      const pLine = state[state.top ? 'homePitcherLine' : 'awayPitcherLine']
      pLine.er += (postRuns - preRuns)
      pLine.r += (postRuns - preRuns)
      // Also tick the per-inning linescore for the batting side
      const battingSide = state.top ? 'away' : 'home'
      const curIdx = state.linescore[battingSide].length - 1
      state.linescore[battingSide][curIdx] += (postRuns - preRuns)
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
      // Auto-pull the USER's pitcher when gassed during sim-to-end. Without
      // this, clicking "Sim to end" with a tired starter rode them through
      // all 9 innings regardless of how badly it was going (Zack's report).
      // Mirrors the opponent auto-sub logic in flipHalfInning, only it
      // fires on the user side during simRest. PAuto-pull thresholds:
      //   - Fatigue ≥ 80 (gassed)         OR
      //   - Pitches ≥ 100 (over a typical CG cap) OR
      //   - ER ≥ 5 on the current line (blow-up)
      // Plus a guard so we only pull when there's a real reliever
      // (stamina < 65) available — don't yank a starter for another starter.
      const us = ctx.userSide
      if (us === 'home' || us === 'away') {
        const fatigue = state[`${us}Fatigue`]
        const pitches = state[`${us}Pitches`]
        const line = state[`${us}PitcherLine`]
        const er = line?.er ?? 0
        const bullpen = state[`${us}Bullpen`]
        const overworked = fatigue >= 80 || pitches >= 100 || er >= 5
        if (overworked && Array.isArray(bullpen) && bullpen.length > 0) {
          const reliever = bullpen.find(p => (p.pitcher?.stamina ?? 50) < 65) || bullpen[0]
          if (reliever) pitchingChange(reliever)
        }
      }
      step()
      safety++
    }
    if (!state.isOver) finalize('Step cap hit — engine forced end.')
  }

  /** Pinch-hit: replace the next batter at a given lineup spot for the team on offense. */
  function pinchHit(side, spotIdx, newPlayer) {
    if (state.isOver) return
    const arr = side === 'home' ? state.homeBatters : state.awayBatters
    const bench = side === 'home' ? state.homeBench : state.awayBench
    if (spotIdx < 0 || spotIdx > 8) return
    const prev = arr[spotIdx]
    arr[spotIdx] = newPlayer
    // Remove the new player from the bench (they're now active)
    const benchIdx = bench.findIndex(p => p.id === newPlayer.id)
    if (benchIdx >= 0) bench.splice(benchIdx, 1)
    pushEvent({ kind: 'SUB', inning: state.inning, top: state.top, text: `${side === 'home' ? (ctx.homeTeamName || 'Home') : (ctx.awayTeamName || 'Away')} change: ${newPlayer.firstName} ${newPlayer.lastName} pinch-hits for ${prev.firstName} ${prev.lastName}.` })
  }

  /**
   * Pinch-run: swap the runner on a given base (0=1B, 1=2B, 2=3B) for a
   * bench player. The pinch runner inherits the runner-on-base flag (so they
   * score / advance normally) and becomes the active batter at that lineup
   * spot for future PAs.
   */
  function pinchRun(side, baseIdx, newPlayer) {
    if (state.isOver) return
    if (baseIdx < 0 || baseIdx > 2) return
    const runner = state.bases[baseIdx]
    if (!runner) return
    // Replace the runner on base
    state.bases[baseIdx] = newPlayer
    // Replace at the lineup spot too — pinch runner inherits the bat
    const arr = side === 'home' ? state.homeBatters : state.awayBatters
    const bench = side === 'home' ? state.homeBench : state.awayBench
    const spotIdx = arr.findIndex(b => b.id === runner.id)
    if (spotIdx >= 0) arr[spotIdx] = newPlayer
    const benchIdx = bench.findIndex(p => p.id === newPlayer.id)
    if (benchIdx >= 0) bench.splice(benchIdx, 1)
    const baseLabel = baseIdx === 0 ? '1B' : baseIdx === 1 ? '2B' : '3B'
    pushEvent({ kind: 'SUB', inning: state.inning, top: state.top, text: `${side === 'home' ? (ctx.homeTeamName || 'Home') : (ctx.awayTeamName || 'Away')} pinch-runner: ${newPlayer.firstName} ${newPlayer.lastName} for ${runner.firstName} ${runner.lastName} at ${baseLabel}.` })
  }

  /**
   * Defensive sub — swap a fielder at a given position. If the displaced
   * fielder is still on the batting roster, they're moved to the bench;
   * if the incoming player was in the batting order, their lineup spot
   * is updated to the new fielder.
   */
  function defensiveSub(side, position, newPlayer) {
    if (state.isOver) return
    const fieldersKey = side === 'home' ? 'homeFielders' : 'awayFielders'
    const battersKey = side === 'home' ? 'homeBatters' : 'awayBatters'
    const benchKey = side === 'home' ? 'homeBench' : 'awayBench'
    const prev = state[fieldersKey][position]
    state[fieldersKey][position] = newPlayer
    // Swap the lineup spot if the displaced fielder was in the batting order
    if (prev) {
      const spotIdx = state[battersKey].findIndex(b => b.id === prev.id)
      if (spotIdx >= 0) state[battersKey][spotIdx] = newPlayer
      // The displaced player heads to the bench
      state[benchKey].push(prev)
    }
    // Remove the incoming player from the bench
    const benchIdx = state[benchKey].findIndex(p => p.id === newPlayer.id)
    if (benchIdx >= 0) state[benchKey].splice(benchIdx, 1)
    pushEvent({
      kind: 'SUB',
      inning: state.inning, top: state.top,
      text: `${side === 'home' ? (ctx.homeTeamName || 'Home') : (ctx.awayTeamName || 'Away')} defensive sub: ${newPlayer.firstName} ${newPlayer.lastName} in at ${position}${prev ? ` for ${prev.firstName} ${prev.lastName}` : ''}.`,
    })
  }

  /** Pitching change for the team currently pitching (defense). */
  function pitchingChange(newPitcher) {
    if (state.isOver) return
    const defendingSide = state.top ? 'home' : 'away'
    const prev = defendingSide === 'home' ? state.homePitcher : state.awayPitcher
    if (defendingSide === 'home') {
      state.homePitcher = newPitcher
      state.homePitcherBF = 0
      state.homePitches = 0
      state.homeFatigue = 0
      state.homeConfidence = newPitcher?.pitcher?.composure ?? 50
      state.homePitcherLine = zeroPitcherLine()
      state.homeFielders['P'] = newPitcher
      state.homeBullpen = state.homeBullpen.filter(p => p.id !== newPitcher.id)
    } else {
      state.awayPitcher = newPitcher
      state.awayPitcherBF = 0
      state.awayPitches = 0
      state.awayFatigue = 0
      state.awayConfidence = newPitcher?.pitcher?.composure ?? 50
      state.awayPitcherLine = zeroPitcherLine()
      state.awayFielders['P'] = newPitcher
      state.awayBullpen = state.awayBullpen.filter(p => p.id !== newPitcher.id)
    }
    pushEvent({
      kind: 'PITCHING_CHANGE',
      inning: state.inning, top: state.top,
      text: `${defendingSide === 'home' ? (ctx.homeTeamName || 'Home') : (ctx.awayTeamName || 'Away')} pitching change: ${newPitcher.firstName} ${newPitcher.lastName} replaces ${prev.firstName} ${prev.lastName}.`,
    })
  }

  /** Live mini-line for a batter — returns AB / H / 2B / 3B / HR / RBI / BB / K from in-game stats. */
  function batterTodayLine(playerId) {
    return batterStats[playerId] || { ab: 0, h: 0, d: 0, t: 0, hr: 0, rbi: 0, bb: 0, k: 0 }
  }

  return {
    state,
    step,
    simHalfInning,
    simRest,
    pinchHit,
    pinchRun,
    defensiveSub,
    pitchingChange,
    isOver: () => state.isOver,
    getResult: () => state.final,
    currentBatter,
    currentPitcher,
    batterTodayLine,
    getBoxscore: () => ({ batterStats, pitcherStats }),
  }
}

// ─── In-game pitcher/fatigue helpers ───────────────────────────────────────

function zeroPitcherLine() {
  return { bf: 0, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, hbp: 0, pitches: 0 }
}

function bumpHits(state) {
  state[state.top ? 'awayHits' : 'homeHits']++
}

/**
 * Estimate the number of pitches in a PA from the outcome. Real-world avg
 * is ~3.9 pitches per PA. Ks tend to take longer (5-6), BBs longest (4-5),
 * BIP shortest (2-3). Adds small noise so successive PAs don't read
 * identical pitch counts.
 */
function estimatePitchesForPA(outcome, rng) {
  const r = rng.next()
  switch (outcome) {
    case 'K':       return 4 + Math.floor(r * 4)        // 4-7
    case 'BB':      return 4 + Math.floor(r * 3)        // 4-6
    case 'HBP':     return 2 + Math.floor(r * 3)        // 2-4
    case 'HR':      return 2 + Math.floor(r * 4)        // 2-5
    case 'SINGLE':  return 2 + Math.floor(r * 4)
    case 'DOUBLE':  return 2 + Math.floor(r * 4)
    case 'TRIPLE':  return 2 + Math.floor(r * 4)
    case 'GIDP':    return 1 + Math.floor(r * 3)        // first pitch swinging often
    case 'SAC_FLY': return 2 + Math.floor(r * 3)
    case 'SAC_BUNT': return 1 + Math.floor(r * 3)
    case 'ERROR':   return 2 + Math.floor(r * 3)
    case 'OUT':     return 2 + Math.floor(r * 4)
    default:        return 4
  }
}

/**
 * How much fatigue does this PA add to the current pitcher? Driven by:
 *  - pitches thrown
 *  - inverse stamina (60-stamina arm tires twice as fast as 85-stamina)
 *  - inverse durability (small contribution)
 *
 * Returns a non-negative delta to apply to fatigue (0..100 scale).
 */
function computeFatigueDelta(pitcher, pitchesThisPA) {
  const stamina = pitcher?.pitcher?.stamina ?? 50
  const durability = pitcher?.pitcher?.durability ?? 50
  // staminaMult: stamina 50 → 1.0×, stamina 80 → 0.7×, stamina 30 → 1.35×
  const staminaMult = Math.max(0.55, 1.5 - (stamina / 100))
  const durabilityMult = Math.max(0.85, 1.15 - (durability / 200))
  // ~1.4 fatigue per pitch at stamina 50. Previous tuning at 1.0/pitch was
  // STILL too gentle — user reported a pitcher at 90 pitches reading "OK"
  // at fatigue 30. Math check: 90 pitches at stamina 60 (probably user's
  // starter) × 0.9 mult ≈ 81 fatigue gross; minus 9 inning-ends × 3
  // recovery ≈ 27; net ~54 → "Tiring." With the new 1.4 rate: 90 × 1.4 ×
  // 0.9 ≈ 113 gross, minus 27 = 86 → "Gassed." Aligns with how a real
  // 90-pitch college starter should feel.
  return pitchesThisPA * 1.4 * staminaMult * durabilityMult
}

/**
 * Confidence drifts based on outcomes. Tuned so a bad inning visibly tanks
 * confidence (real-world: a pitcher who gives up 6 in an inning is RATTLED).
 * Previous values were too gentle — user reported 6 runs allowed in an
 * inning with confidence still at 80. Roughly: an inning that yields ≥4
 * runs drops the pitcher into the "Cracking" zone.
 */
function computeConfidenceShift(outcome) {
  switch (outcome) {
    case 'K':       return +2
    case 'OUT':     return +0.5
    case 'SAC_FLY': return -1       // they got out but a run scored
    case 'SAC_BUNT': return 0
    case 'GIDP':    return +5       // two outs on one pitch — huge boost
    case 'HR':      return -14
    case 'TRIPLE':  return -7
    case 'DOUBLE':  return -5
    case 'SINGLE':  return -4
    case 'BB':      return -3
    case 'HBP':     return -3
    case 'ERROR':   return -2
    default:        return 0
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
  HR:      (b)    => `${nm(b)} HOMERS!`,
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
    ? `${runsScored} run${runsScored === 1 ? '' : 's'} score.`
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
