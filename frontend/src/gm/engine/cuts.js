/**
 * Roster cuts.
 *
 * Once a year — the first week after the user's playoff run ends — the user
 * gets to cut 1-2 players from the roster. Cuts open the door for new signees
 * + transfers and let the user shed dead weight. AD trust gates how many you
 * get: do well, build trust, get more cuts; struggle and the AD pulls them.
 *
 * Trust tiers (driven by job security + recent wins):
 *   - LIMITED   ≤24 JS or losing-record streak 0 cuts (the AD won't burn
 *                more scholarship $ on transition during a rough patch)
 *   - STANDARD  25-64 JS 1 cut/year
 *   - TRUSTED   65+ JS 2 cuts/year
 *   - VAULTED   85+ JS AND multi-year postseason streak 3 cuts (rare)
 *
 * The "first week after playoffs end" varies by team:
 *   - User missed conf tournament window opens Wk 40 (3 extra summer weeks)
 *   - User was in conf tournament but not opening round Wk 41
 *   - User in opening round, no WS Wk 42
 *   - User in NAIA WS Wk 43
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
  // Cuts NEVER open during the postseason (wks 40-42) — that window is for
  // playing playoff games, not roster churn. The cuts window opens at wk 44
  // (after the World Series wraps + a buffer week) regardless of when the
  // user was eliminated, so it lands in the quiet early offseason.
  switch (stage) {
    case 'REG_SEASON':       return 44
    case 'CONF_TOURNAMENT':  return 44
    case 'OPENING_ROUND':    return 44
    case 'WORLD_SERIES':     return 45
    default:                 return 44
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
 * Is the cuts window currently open for the user? Two paths:
 *   1. Normal AD-trust cuts: open Wk (elimination+1) onward, limited by tier.
 *   2. Mandatory cuts (over 50-player cap at Wk 52): always open, regardless
 *      of AD trust, until the user gets back down to 50.
 *
 * @param {any} state
 */
export function cutsWindowOpen(state) {
  ensureCutsState(state)
  if (state.mandatoryCuts?.needed > 0 && state.mandatoryCuts.year === state.calendar?.year) {
    return true   // forced — must cut to advance
  }
  const week = state.calendar?.weekOfYear ?? 1
  return week >= state.cuts.openedAtWeek
    && week <= 52
    && state.cuts.used < state.cuts.allowed
}

/**
 * True if the user is in MANDATORY cut mode (over the 50-cap). The UI
 * surfaces a different banner + the cut counter behaves differently
 * (decrements mandatoryCuts.needed instead of the normal trust-tier
 * allowance).
 */
export function isMandatoryCutMode(state) {
  return !!(state.mandatoryCuts?.needed > 0 && state.mandatoryCuts.year === state.calendar?.year)
}

/**
 * Cut a player from the user's roster. Mutates state. Returns { ok, error }.
 *
 * @param {any} state
 * @param {string} playerId
 */
export function cutPlayer(state, playerId) {
  ensureCutsState(state)
  const mandatory = isMandatoryCutMode(state)
  if (!cutsWindowOpen(state)) {
    return { ok: false, error: 'Cuts window is closed or you have no cuts left this year.' }
  }
  const team = state.teams?.[state.userSchoolId]
  if (!team || !team.rosterPlayerIds.includes(playerId)) {
    return { ok: false, error: 'Player not on your roster.' }
  }
  const player = state.players[playerId]
  if (!player) return { ok: false, error: 'Player not found.' }
  if (player.classYear === 'SR' && !mandatory) {
    // Don't waste a normal AD-trust cut on a senior — they're already gone.
    // (Mandatory cuts allow seniors since you might have a 4-yr SR still
    // counting toward the cap.)
    return { ok: false, error: `${player.firstName} ${player.lastName} is a senior; they\'ll graduate naturally. Save the cut.` }
  }
  team.rosterPlayerIds = team.rosterPlayerIds.filter(id => id !== playerId)
  player.eligibilityStatus = 'cut'
  player.cutAt = { year: state.calendar?.year, week: state.calendar?.weekOfYear }

  if (mandatory) {
    // Mandatory-cut path: decrement the requirement counter, NOT the
    // trust-tier allowance. Mandatory cuts don't carry the -1 JS penalty
    // (the JS hit was already applied as a lump sum when the overage was
    // detected — don't double-charge).
    state.mandatoryCuts.needed = Math.max(0, state.mandatoryCuts.needed - 1)
    if (state.mandatoryCuts.needed === 0) {
      state.newsfeed.unshift({
        id: `mandatory_cuts_done_${state.calendar?.year}`,
        year: state.calendar?.year, week: state.calendar?.weekOfYear, type: 'AWARD',
        headline: `Roster trimmed back to 50. AD is satisfied.`,
        payload: {},
      })
    }
  } else {
    state.cuts.used++
    if (state.budget) {
      state.budget.jobSecurity = Math.max(0, (state.budget.jobSecurity || 50) - 1)
    }
  }
  state.cuts.history.push({
    year: state.calendar?.year,
    week: state.calendar?.weekOfYear,
    playerId,
    mandatory,
  })
  state.newsfeed.unshift({
    id: `cut_${state.calendar?.year}_${playerId}`,
    year: state.calendar?.year, week: state.calendar?.weekOfYear, type: 'AWARD',
    headline: `Cut ${player.firstName} ${player.lastName} (${player.classYear} ${player.primaryPosition}) from the roster.`,
    payload: { playerId, mandatory },
  })
  return { ok: true }
}
