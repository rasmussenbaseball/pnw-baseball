/**
 * Roster cuts.
 *
 * Once a year — the first week after the user's playoff run ends — the user
 * gets to cut 1-2 players from the roster. Cuts open the door for new signees
 * + transfers and let the user shed dead weight. AD trust gates how many you
 * get: do well, build trust, get more cuts; struggle and the AD pulls them.
 *
 * Trust tiers (driven by job security + recent wins):
 *   - LIMITED   ≤24 JS or losing-record streak → 0 cuts (the AD won't burn
 *                more scholarship $ on transition during a rough patch)
 *   - STANDARD  25-64 JS → 1 cut/year
 *   - TRUSTED   65+ JS → 2 cuts/year
 *   - VAULTED   85+ JS AND multi-year postseason streak → 3 cuts (rare)
 *
 * The "first week after playoffs end" varies by team:
 *   - User missed conf tournament → window opens Wk 40 (3 extra summer weeks)
 *   - User was in conf tournament but not opening round → Wk 41
 *   - User in opening round, no WS → Wk 42
 *   - User in NAIA WS → Wk 43
 *
 * State shape:
 *   state.cuts = {
 *     year: 2027,
 *     openedAtWeek: 41,
 *     allowed: 2,
 *     used: 0,
 *     history: [{ year, playerId, week }],
 *     trustNote: 'STANDARD',
 *   }
 */

/** AD trust tier from job security + the last few seasons. */
export function cutTrustTier(state) {
  const js = state.budget?.jobSecurity ?? 50
  const team = state.teams?.[state.userSchoolId]
  const lastWins = team?._lastSeason?.wins ?? team?.wins ?? 0
  const lastLosses = team?._lastSeason?.losses ?? team?.losses ?? 0
  const winPct = (lastWins + lastLosses) > 0
    ? lastWins / (lastWins + lastLosses)
    : 0.5
  // Hot streak: built up if recent postseason appearance + high JS
  const recentPostseason = !!state.postseason?.userQualified
  if (js >= 85 && winPct >= 0.6 && recentPostseason) {
    return { key: 'VAULTED', allowed: 3, label: 'Vaulted', note: 'AD has full faith in you. 3 cuts.' }
  }
  if (js >= 65) {
    return { key: 'TRUSTED', allowed: 2, label: 'Trusted', note: 'AD trusts your roster decisions. 2 cuts.' }
  }
  if (js >= 25) {
    return { key: 'STANDARD', allowed: 1, label: 'Standard', note: '1 cut allowed. Build trust with wins to earn more.' }
  }
  return { key: 'LIMITED', allowed: 0, label: 'Limited', note: 'AD has pulled cut privileges. Win some games to earn them back.' }
}

/**
 * When does the user's cuts window open this year? Depends on how far they
 * went in the postseason. Returning Wk 40 means "open right after reg season"
 * for teams that didn't make conf tournament.
 *
 * @param {any} state
 * @returns {number}  weekOfYear
 */
export function cutsOpenAtWeek(state) {
  const ps = state.postseason || {}
  // ps.eliminatedAt is set by the postseason runner — values:
  // 'REG_SEASON' (missed conf tournament), 'CONF_TOURNAMENT', 'OPENING_ROUND',
  // 'WORLD_SERIES'. Default to REG_SEASON if we have no record.
  const stage = ps.userEliminatedAt || (ps.userQualified ? 'OPENING_ROUND' : 'REG_SEASON')
  switch (stage) {
    case 'REG_SEASON':       return 40   // 3 extra offseason weeks
    case 'CONF_TOURNAMENT':  return 41
    case 'OPENING_ROUND':    return 42
    case 'WORLD_SERIES':     return 43
    default:                 return 43
  }
}

/**
 * Initialize state.cuts for the current dynasty year. Idempotent.
 */
export function ensureCutsState(state) {
  const year = state.calendar?.year
  if (!state.cuts || state.cuts.year !== year) {
    const tier = cutTrustTier(state)
    state.cuts = {
      year,
      openedAtWeek: cutsOpenAtWeek(state),
      allowed: tier.allowed,
      used: 0,
      history: state.cuts?.history || [],
      trustNote: tier.key,
    }
  }
  return state
}

/**
 * Is the cuts window currently open for the user? Checks the week number
 * against the year's open week, and ensures the user hasn't used all their
 * cuts yet.
 */
export function cutsWindowOpen(state) {
  ensureCutsState(state)
  const week = state.calendar?.weekOfYear ?? 1
  // Window opens at openedAtWeek and stays open until end of offseason (52).
  return week >= state.cuts.openedAtWeek
    && week <= 52
    && state.cuts.used < state.cuts.allowed
}

/**
 * Cut a player from the user's roster. Mutates state. Returns { ok, error }.
 *
 * @param {any} state
 * @param {string} playerId
 */
export function cutPlayer(state, playerId) {
  ensureCutsState(state)
  if (!cutsWindowOpen(state)) {
    return { ok: false, error: 'Cuts window is closed or you have no cuts left this year.' }
  }
  const team = state.teams?.[state.userSchoolId]
  if (!team || !team.rosterPlayerIds.includes(playerId)) {
    return { ok: false, error: 'Player not on your roster.' }
  }
  const player = state.players[playerId]
  if (!player) return { ok: false, error: 'Player not found.' }
  if (player.classYear === 'SR') {
    // Don't waste a cut on a senior — they're already gone.
    return { ok: false, error: `${player.firstName} ${player.lastName} is a senior; they\'ll graduate naturally. Save the cut.` }
  }
  team.rosterPlayerIds = team.rosterPlayerIds.filter(id => id !== playerId)
  player.eligibilityStatus = 'cut'
  player.cutAt = { year: state.calendar?.year, week: state.calendar?.weekOfYear }
  state.cuts.used++
  state.cuts.history.push({
    year: state.calendar?.year,
    week: state.calendar?.weekOfYear,
    playerId,
  })
  // Small job-security cost — the AD is OK with cuts, but each is a small
  // black mark since you're admitting a recruiting / dev mistake.
  if (state.budget) {
    state.budget.jobSecurity = Math.max(0, (state.budget.jobSecurity || 50) - 1)
  }
  state.newsfeed.unshift({
    id: `cut_${state.calendar?.year}_${playerId}`,
    year: state.calendar?.year, week: state.calendar?.weekOfYear, type: 'AWARD',
    headline: `✂ Cut ${player.firstName} ${player.lastName} (${player.classYear} ${player.primaryPosition}) from the roster.`,
    payload: { playerId },
  })
  return { ok: true }
}
