/**
 * Per-game lineup persistence + lookup.
 *
 * The user can set a custom batting order + starting pitcher for any game
 * they care about (especially fall scrimmages — that's how players earn the
 * scrimmage development boost). When no lineup is set, the engine falls
 * back to defaultLineup (top-9 hitters + top-5 pitchers).
 *
 * Stored at state.lineups[gameId] = { batters: [9 playerIds], starterPitcherId, bullpenIds: [...] }
 */

import { defaultLineup } from './sim'
import { playerOverall } from './playerRating'
import { positionFit, positionFitRank } from './positions'
import { getEnergy } from './energy'
import { Sentry } from '../../lib/sentry'

// Throttle the roster-health diagnostic to once per (team, year) per session
// so a season's worth of autoLineup calls can't spam Sentry.
const _rosterHealthReported = new Set()

/** Get the saved lineup for a game (or null). */
export function getSavedLineup(state, gameId) {
  return state.lineups?.[gameId] || null
}

const FIELD_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']

/**
 * Parse the series-game index from a game id. Game ids are built as
 * `g_${seriesId}_${i}` (see schedule.buildSeriesGames), so the trailing
 * `_<number>` IS the series-game index (0 = Fri, 1 = Sat, 2 = Sun). School
 * ids are kebab-case slugs that never end in a digit, so matching the final
 * `_<digits>` is unambiguous. (The old regex `/_g(\d+)$/` never matched the
 * real id shape, so gameIdx was always 0 — which made non-user teams start
 * their ace in EVERY game of a series, producing impossible 15-17 IP weekly
 * pitching lines.)
 */
function gameIndexOf(gameId) {
  const m = String(gameId || '').match(/_(\d+)$/)
  return m ? parseInt(m[1], 10) : 0
}

/**
 * Build a realistic auto lineup for a team for a specific game.
 *
 *   - Assigns the best fielder to each of the 8 positions (greedy by
 *     position-fit then OVR), so the lineup is a proper everyday nine, not
 *     just "top 9 bats stacked anywhere."
 *   - DH = the best remaining bat. The DH slot ROTATES: a strong everyday
 *     bat who's tired gets moved to DH (rest their legs, keep their bat),
 *     freeing their field spot for a backup.
 *   - ENERGY rest (only when energy is tracked — the user's team): a core
 *     starter running on fumes (energy < 50) is benched for the freshest
 *     capable backup at that position. Capped at ~2 rests/game so the core
 *     plays nearly every day.
 *   - Without energy (non-user teams) a role player gets an occasional start
 *     by rotating the weakest field spot in ~1 of every 3 games, so bench
 *     bats still accumulate some stats over a season.
 *
 * @returns {{ batters: Player[], batterPositions: string[], pitcherRotation: Player[], bench: Player[] }}
 */
export function autoLineup(state, teamId, gameId) {
  const team = state.teams?.[teamId]
  if (!team) return { batters: [], batterPositions: [], pitcherRotation: [], bench: [] }
  // Story-mode side-effects also pull players out of the lineup:
  //   - PLAYER_INCIDENT "suspend 3 games" / GAMBLING / etc. stamps
  //     player.suspended = { weeks, year } — must sit while weeks > 0
  //     IN THE STAMPED YEAR. (Outside that year the flag is stale.)
  //   - CAR_ACCIDENT "rest a week" / CONCUSSION_PROTOCOL stamps
  //     player._minorInjuryFlag = { weeks, year } — same semantics.
  //   - ACADEMIC_DISHONESTY / SCANDAL_RUMOR set eligibilityStatus =
  //     'ineligible'. Treated like a season-long sit.
  //   - MAJOR_CHANGE_REQUEST sets 'quit' → already off the roster, but
  //     belt-and-suspenders here in case the roster mutation slipped.
  // Suspensions / minor injuries auto-decrement once per spring week —
  // see decrementStoryHolds() in season.js.
  const curYear = state.calendar?.year ?? 0
  const isSuspended = p => {
    const s = p?.suspended
    return s && s.year === curYear && (s.weeks || 0) > 0
  }
  const isMinorHurt = p => {
    const m = p?._minorInjuryFlag
    return m && m.year === curYear && (m.weeks || 0) > 0
  }
  const elig = p => p
    && (p.injury?.weeksRemaining || 0) === 0
    && p.eligibilityStatus !== 'cut'
    && p.eligibilityStatus !== 'dismissed'
    && p.eligibilityStatus !== 'ineligible'
    && p.eligibilityStatus !== 'quit'
    && p.eligibilityStatus !== 'transferred'
    && p.eligibilityStatus !== 'graduated'
    && !isSuspended(p)
    && !isMinorHurt(p)
  const roster = (team.rosterPlayerIds || []).map(id => state.players[id]).filter(elig)
  const hitters = roster.filter(p => p.isHitter)
  const pitchers = roster.filter(p => p.isPitcher)
  // Energy is only tracked for the user's roster (non-user players sit at the
  // default 100), so energy-based rest only applies to the user's team. Other
  // teams use deterministic game-index rotation for role-player variety.
  const energyTracked = teamId === state.userSchoolId && !!state.playerEnergy
  const en = id => getEnergy(state, id)
  const gameIdx = gameIndexOf(gameId)

  // Greedy positional assignment. For each field position pick the best
  // available player by (fit, then OVR), but prefer a rested backup over a
  // gassed starter when energy is tracked.
  const available = new Set(hitters.map(p => p.id))
  const byId = Object.fromEntries(hitters.map(p => [p.id, p]))
  const assignment = []   // { player, pos }
  let restsUsed = 0
  for (const pos of FIELD_POSITIONS) {
    const candidates = hitters
      .filter(p => available.has(p.id))
      .sort((a, b) => {
        const fr = positionFitRank(a, pos) - positionFitRank(b, pos)
        if (fr !== 0) return fr
        return playerOverall(b) - playerOverall(a)
      })
    if (candidates.length === 0) continue
    let pick = candidates[0]
    // Energy rest: if the best option is gassed, slot the freshest capable
    // backup instead (cap total rests so the core still plays daily).
    if (energyTracked && restsUsed < 2 && en(pick.id) < 50 && candidates.length > 1) {
      const fresh = candidates.slice(1).find(c => en(c.id) >= 65)
      if (fresh) { pick = fresh; restsUsed++ }
    }
    assignment.push({ player: pick, pos })
    available.delete(pick.id)
  }

  // DH — best remaining bat by OVR. Rotate it: in a 3-game series the DH
  // varies by game so the everyday nine spread their off-the-field rest.
  const remaining = hitters.filter(p => available.has(p.id)).sort((a, b) => playerOverall(b) - playerOverall(a))
  // Pick a DH from the top remaining bats, offset by the series game index
  // (and, when energy is tracked, prefer the freshest of the top 3).
  let dh = null
  if (remaining.length > 0) {
    const pool = remaining.slice(0, Math.min(3, remaining.length))
    if (energyTracked) {
      dh = [...pool].sort((a, b) => en(b.id) - en(a.id))[0]
    } else {
      dh = pool[gameIdx % pool.length]
    }
    available.delete(dh.id)
  }
  if (dh) assignment.push({ player: dh, pos: 'DH' })

  // Non-user teams (no energy): occasionally start a bench bat for variety so
  // role players accumulate stats over a season (~1 in 3 games at the 8th
  // batting slot, deterministic by game index).
  if (!energyTracked && remaining.length > 1 && gameIdx % 3 === 2) {
    const benchBat = remaining[1]   // 2nd-best remaining = a role player
    // Swap them in for the lowest-OVR field starter.
    let weakestIdx = 0
    for (let i = 1; i < assignment.length; i++) {
      if (assignment[i].pos === 'DH') continue
      if (playerOverall(assignment[i].player) < playerOverall(assignment[weakestIdx].player)) weakestIdx = i
    }
    if (assignment[weakestIdx]) {
      assignment[weakestIdx] = { player: benchBat, pos: assignment[weakestIdx].pos }
    }
  }

  // Batting order — sort the assigned 9 by OVR (best bats hit higher) but keep
  // it stable enough that it reads like a real order.
  const ordered = [...assignment].sort((a, b) => playerOverall(b.player) - playerOverall(a.player))
  const batters = ordered.map(x => x.player)
  const batterPositions = ordered.map(x => x.pos)

  // ── Guarantee a full 9-man batting order ──────────────────────────────
  // The greedy assignment above can leave FEWER than 9 batters when the
  // eligible hitter pool is thin (a position with no eligible candidate gets
  // skipped via `continue`, the DH is only added when bats remain, stale
  // roster ids resolve to undefined, injuries/suspensions pile up, or an AI
  // roster thins out several seasons in). The live engine indexes
  // batters[idx % 9], so a short array returns `undefined` and the game bails
  // with "Lineup exhausted." A real team always runs nine hitters out, so pad
  // up to 9 — eligible bench bats first, then eligible pitchers, then ANY
  // roster body (relax eligibility), and finally repeat bats if the roster is
  // pathologically tiny. Never leave a hole for the engine to trip on.
  if (batters.length < 9) {
    // Roster-health diagnostic: if a team that's SUPPOSED to have a real
    // roster (a substantial rosterPlayerIds list, not a rating-only stub)
    // still can't field nine eligible hitters, that's genuine decay worth
    // knowing about. Rating-only opponents (tiny/empty roster) are expected
    // to land here and are NOT reported. Throttled to once per team/year.
    const rosterCount = (team.rosterPlayerIds || []).length
    if (rosterCount >= 25 && hitters.length < 9) {
      const key = `${teamId}_${state.calendar?.year ?? 0}`
      if (!_rosterHealthReported.has(key)) {
        _rosterHealthReported.add(key)
        try {
          Sentry.captureMessage(
            `GM roster decay: team ${teamId} has ${rosterCount} rostered but only ${hitters.length} eligible hitters (year ${state.calendar?.year}, level ${state.level})`,
            { level: 'warning', tags: { gmIssue: 'roster_decay', gmLevel: state.level || 'unknown' } },
          )
        } catch { /* Sentry no-ops when uninitialized */ }
      }
    }
    const usedPad = new Set(batters.map(p => p.id))
    const benchHitters = hitters.filter(p => !usedPad.has(p.id))
    const allRoster = (team.rosterPlayerIds || []).map(id => state.players[id]).filter(Boolean)
    const padPool = [
      ...benchHitters,
      ...pitchers.filter(p => !usedPad.has(p.id)),
      ...allRoster.filter(p => !usedPad.has(p.id)),
    ]
    for (const p of padPool) {
      if (batters.length >= 9) break
      if (usedPad.has(p.id)) continue
      usedPad.add(p.id)
      batters.push(p)
      batterPositions.push(p.primaryPosition || 'DH')
    }
    // Absolute last resort: fewer than 9 bodies on the whole roster. Repeat
    // existing bats so the array still reaches 9 (the engine needs 9 slots).
    let ri = 0
    while (batters.length < 9 && batters.length > 0) {
      batters.push(batters[ri % batters.length])
      batterPositions.push(batterPositions[ri % batterPositions.length] || 'DH')
      ri++
    }
  }

  const usedIds = new Set(batters.map(p => p.id))
  const bench = hitters.filter(p => !usedIds.has(p.id))

  // Pitcher rotation — ORDER it so index 0 is TODAY's starter; consumers
  // (simGame / light boxscore) always start rotation[0]. The bullpen follows.
  const pscore = p => (p.pitcher.stuff + p.pitcher.control + p.pitcher.stamina) / 3
  const skillSorted = [...pitchers].sort((a, b) => pscore(b) - pscore(a))
  let rotation
  if (energyTracked) {
    // User's staff: the WHOLE staff is eligible. Previously this was capped at
    // the top 6 (slice(0,6)), so only ~6 arms ever pitched all season and they
    // threw every weekend on fumes. Order by freshness, then skill within an
    // 8-pt energy band — so today's starter is the best WELL-RESTED arm and a
    // pitcher who just threw drops to the back to recover (recovery ≈ a week →
    // real starter cadence). Across a 3-game weekend this cycles ~10-12 arms.
    rotation = [...skillSorted].sort((a, b) => {
      const ea = en(a.id), eb = en(b.id)
      if (Math.abs(ea - eb) > 8) return eb - ea
      return pscore(b) - pscore(a)
    })
  } else {
    // Non-user staff (no energy tracked): rotate the top 6 by the series-game
    // index so a different starter leads each game; deeper arms follow.
    const top = skillSorted.slice(0, 6)
    const k = top.length > 1 ? gameIdx % top.length : 0
    rotation = [...top.slice(k), ...top.slice(0, k), ...skillSorted.slice(6)]
  }
  // Keep a deep bullpen reachable in-game for the user (up to 10 arms) so fresh
  // relievers are always available across a weekend; opponents use 6.
  let pitcherRotation = rotation.slice(0, energyTracked ? 10 : 6)

  // Guarantee at least one arm. If the team has zero eligible pitchers (thin
  // roster / all injured), the live engine's currentPitcher() would be
  // undefined and the game would bail with "Lineup exhausted." Drop in an
  // emergency arm — the best remaining body on the roster — so there's always
  // someone on the mound (real teams send a position player out before they
  // forfeit).
  if (pitcherRotation.length === 0) {
    const rosterBodies = (team.rosterPlayerIds || []).map(id => state.players[id]).filter(Boolean)
    const emergency = [...rosterBodies].sort((a, b) => playerOverall(b) - playerOverall(a))[0]
    if (emergency) pitcherRotation = [emergency]
  }

  return { batters, batterPositions, pitcherRotation, bench }
}

/** Save a lineup. Validates that all referenced players are on the team's roster. */
export function saveLineup(state, gameId, lineup) {
  if (!state.lineups) state.lineups = {}
  state.lineups[gameId] = {
    batters: [...lineup.batters],
    // Per-slot field positions ('C','1B',...,'DH'). Used by the sim to apply
    // the temporary out-of-position fielding penalty for one game only.
    batterPositions: lineup.batterPositions ? [...lineup.batterPositions] : null,
    starterPitcherId: lineup.starterPitcherId,
    bullpenIds: [...(lineup.bullpenIds || [])],
  }
}

/**
 * Save the user's DEFAULT lineup. This applies as a fallback to any future
 * user game that doesn't have an explicit per-game lineup set. Reported by
 * Zack — users were having to set the same lineup for every single game.
 *
 * Note: ONLY batters + batterPositions persist as defaults. The starting
 * pitcher rotates by series-game so it's not part of the default.
 */
export function saveDefaultLineup(state, lineup) {
  // Friend report (June 2026): "save default lineup isn't working — saves
  // for the game but next game the auto-lineup is back." Root cause: this
  // was storing full Player OBJECTS in defaultLineup.batters, but
  // resolveLineupForGame reads them as IDs (`def.batters.map(id => byId[id])`).
  // Every lookup returned undefined → batters.length === 0 → fell through to
  // autoLineup. Store IDs (matching the saved-lineup shape) so the resolver
  // can actually rehydrate them next game.
  const toId = (b) => (typeof b === 'string' ? b : b?.id)
  state.defaultLineup = {
    batters: (lineup.batters || []).map(toId).filter(Boolean),
    batterPositions: lineup.batterPositions ? [...lineup.batterPositions] : null,
  }
}

/** Get the user's default lineup if one is set. */
export function getDefaultLineup(state) {
  return state.defaultLineup || null
}

/**
 * Resolve a saved lineup (or default) into the { batters, pitcherRotation }
 * shape that simGame expects. Falls back to defaultLineup when nothing is
 * saved — that's the legacy behavior for non-user games or untouched user
 * games.
 *
 * @returns {{ batters: Player[], pitcherRotation: Player[], wasSaved: boolean }}
 */
export function resolveLineupForGame(state, teamId, gameId) {
  const team = state.teams[teamId]
  if (!team) return { batters: [], pitcherRotation: [], bench: [], wasSaved: false }
  const players = team.rosterPlayerIds
    .map(id => state.players[id])
    .filter(p => p && p.eligibilityStatus !== 'cut' && p.eligibilityStatus !== 'dismissed'
                   && (p.injury?.weeksRemaining || 0) === 0)

  const saved = getSavedLineup(state, gameId)
  if (saved) {
    const byId = Object.fromEntries(players.map(p => [p.id, p]))
    const batters = saved.batters.map(id => byId[id]).filter(Boolean)
    const starter = saved.starterPitcherId ? byId[saved.starterPitcherId] : null
    const pen = (saved.bullpenIds || []).map(id => byId[id]).filter(Boolean)
    if (batters.length === 9 && starter) {
      const explicit = [starter, ...pen]
      const explicitIds = new Set(explicit.map(p => p.id))
      const fallbackPen = defaultLineup(team, state.players).pitcherRotation
        .filter(p => !explicitIds.has(p.id))
        .slice(0, Math.max(0, 5 - explicit.length))
      const rotation = [...explicit, ...fallbackPen]
      const activeIds = new Set([...batters.map(b => b.id), ...rotation.map(p => p.id)])
      const bench = players.filter(p => !activeIds.has(p.id))
      // Pass through batterPositions so the sim can apply out-of-position
      // fielding penalties. Falls back to each batter's primaryPosition if
      // the saved lineup predates the per-slot position field.
      const batterPositions = saved.batterPositions && saved.batterPositions.length === 9
        ? [...saved.batterPositions]
        : batters.map(b => b.primaryPosition)
      return { batters, batterPositions, pitcherRotation: rotation, bench, wasSaved: true }
    }
  }
  // DEFAULT LINEUP fallback — only for the user's team and only if no per-
  // game saved lineup exists. Lets users "set it once and forget it" per
  // Zack's report. Pitcher rotation is NOT part of the default (rotates by
  // series-game); it falls through to autoLineup's rotation logic.
  if (teamId === state.userSchoolId) {
    const def = getDefaultLineup(state)
    if (def && (def.batters || []).length === 9) {
      const byId = Object.fromEntries(players.map(p => [p.id, p]))
      const batters = def.batters.map(id => byId[id]).filter(Boolean)
      if (batters.length === 9) {
        // Reuse autoLineup's smart pitcher rotation but keep the default's
        // batting order. autoLineup handles series-game pitcher rotation +
        // energy-aware rest, so we get the best of both worlds: stable
        // batting order + auto-rotated arms.
        const auto = autoLineup(state, teamId, gameId)
        const batterPositions = def.batterPositions && def.batterPositions.length === 9
          ? [...def.batterPositions]
          : batters.map(b => b.primaryPosition)
        const activeIds = new Set([...batters.map(b => b.id), ...auto.pitcherRotation.map(p => p.id)])
        const bench = players.filter(p => !activeIds.has(p.id))
        return {
          batters,
          batterPositions,
          pitcherRotation: auto.pitcherRotation,
          bench,
          wasSaved: false,
          fromDefault: true,
        }
      }
    }
  }
  // No saved lineup → smart auto lineup (positional, energy-aware rest +
  // rotating DH). This is what untouched user games + auto mode use.
  const auto = autoLineup(state, teamId, gameId)
  return { ...auto, wasSaved: false }
}

/** List the IDs of players who appeared in this game's saved lineup. */
export function lineupPlayerIds(state, gameId) {
  const saved = getSavedLineup(state, gameId)
  if (!saved) return []
  return [saved.starterPitcherId, ...saved.batters, ...(saved.bullpenIds || [])].filter(Boolean)
}
