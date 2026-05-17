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

/** Get the saved lineup for a game (or null). */
export function getSavedLineup(state, gameId) {
  return state.lineups?.[gameId] || null
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
  // Fall back to default — add bench (roster minus starting + bullpen)
  const def = defaultLineup(team, state.players)
  const activeIds = new Set([
    ...(def.batters || []).map(b => b.id),
    ...(def.pitcherRotation || []).map(p => p.id),
  ])
  const bench = players.filter(p => !activeIds.has(p.id))
  // Default positions = each batter's primaryPosition (no out-of-position penalty)
  const batterPositions = (def.batters || []).map(b => b.primaryPosition)
  return { ...def, batterPositions, bench, wasSaved: false }
}

/** List the IDs of players who appeared in this game's saved lineup. */
export function lineupPlayerIds(state, gameId) {
  const saved = getSavedLineup(state, gameId)
  if (!saved) return []
  return [saved.starterPitcherId, ...saved.batters, ...(saved.bullpenIds || [])].filter(Boolean)
}
