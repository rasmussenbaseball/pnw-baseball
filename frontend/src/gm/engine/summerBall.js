/**
 * Summer ball.
 *
 * Players spend their summers in collegiate wood-bat leagues. Real NCAA / NAIA
 * programs use these leagues for face-the-best dev reps, scout exposure, and
 * draft buzz. The user assigns players to leagues each year in two passes:
 *
 *   1. PLANNING — November of the dynasty year (Wk 14). User builds the
 *      tentative roster of summer assignments.
 *   2. CONFIRM — first week after the user's season ends. User can REMOVE
 *      players but cannot ADD new ones (signing windows are already past).
 *   3. RESOLVE — fires mid-summer (Wk 47). League games sim out, players get
 *      dev boosts / poach risk / injury rolls / draft buzz based on their
 *      league + their spring usage. News headlines surface what happened.
 *
 * Rules:
 *   - Seniors CAN'T play summer ball — they're graduating / going pro.
 *   - Each league has a min OVR. Cape Cod = 90+ (best league, only elite
 *     players invited). Cascade Collegiate = 45-70 (developmental tier).
 *   - Better leagues = lower injury risk + higher draft buzz + better dev,
 *     but also higher poach risk if the player shines.
 *   - Pitchers with heavy spring IP have elevated injury risk if they keep
 *     pitching all summer.
 *   - Players who didn't play much in the spring get extra dev — these are
 *     the "had reps in summer" stories.
 *
 * State shape on the save:
 *   state.summerBall = {
 *     year: 2027,
 *     status: 'PLANNING'|'CONFIRMED'|'RESOLVED',
 *     assignments: {
 *       [playerId]: {
 *         leagueKey: 'CAPE_COD',
 *         plannedAt: 14,     // weekOfYear when planned
 *         confirmed: true,
 *         removed: false,
 *       },
 *     },
 *     lastResolved: 2027,    // year the engine last resolved a summer
 *   }
 */

import { makeRng } from './rng'
import { playerOverall } from './playerRating'

/** @typedef {{
 *   key: string,
 *   label: string,
 *   short: string,
 *   blurb: string,
 *   region: string,
 *   prestige: number,         // 1-10, drives draft buzz + poach + recruit reputation
 *   minOvr: number,
 *   maxOvr: number|null,      // null = no upper bound
 *   devFocus: string,         // free-text 'contact + speed' etc
 *   devBuckets: string[],     // rating keys this league develops faster
 *   devMagnitude: number,     // 0.5 (low) - 1.8 (high) multiplier on dev points
 *   injuryRisk: number,       // 0..1 base chance of an injury event
 *   poachChance: number,      // 0..1 base chance D1 poaches if player thrives
 *   draftBuzzMult: number,    // multiplier on effective OVR for next year's draft
 *   color: string,            // tailwind class for badges
 * }} SummerLeague */

/** @type {Object<string,SummerLeague>} */
export const SUMMER_LEAGUES = {
  CAPE_COD: {
    key: 'CAPE_COD',
    label: 'Cape Cod League',
    short: 'CCBL',
    blurb: 'The premier summer league in the country. Wooden bats, MLB scouts at every game, only invites elite talent. Lowest injury risk because rosters are managed carefully; highest poach risk because every D1 wants your guy after a strong summer.',
    region: 'Northeast',
    prestige: 10,
    minOvr: 90,
    maxOvr: null,
    devFocus: 'Polishes elite tools across the board',
    devBuckets: ['discipline', 'composure', 'command', 'control'],
    devMagnitude: 1.6,
    injuryRisk: 0.05,
    poachChance: 0.35,
    draftBuzzMult: 1.25,
    color: 'bg-purple-100 text-purple-800',
  },
  NORTHWOODS: {
    key: 'NORTHWOODS',
    label: 'Northwoods League',
    short: 'NWL',
    blurb: 'Long bus rides through Wisconsin / Minnesota. 70+ game grind builds toughness and stamina. High-quality opponents — second only to the Cape. Great showcase but the workload can lead to injuries.',
    region: 'Upper Midwest',
    prestige: 8,
    minOvr: 82,
    maxOvr: null,
    devFocus: 'Stamina + durability under load',
    devBuckets: ['stamina', 'durability', 'contact_l', 'contact_r'],
    devMagnitude: 1.35,
    injuryRisk: 0.14,
    poachChance: 0.22,
    draftBuzzMult: 1.15,
    color: 'bg-indigo-100 text-indigo-800',
  },
  WESTERN_CANADIAN: {
    key: 'WESTERN_CANADIAN',
    label: 'Western Canadian Baseball League',
    short: 'WCBL',
    blurb: 'Strong wood-bat league across the prairies. Solid pitching dev environment — pitcher-friendly parks and high-quality coaching staffs. Pro scouts attend regularly.',
    region: 'Prairie Provinces',
    prestige: 7,
    minOvr: 70,
    maxOvr: 85,
    devFocus: 'Pitcher command + arm health',
    devBuckets: ['command', 'control', 'stuff', 'discipline'],
    devMagnitude: 1.2,
    injuryRisk: 0.09,
    poachChance: 0.18,
    draftBuzzMult: 1.10,
    color: 'bg-rose-100 text-rose-800',
  },
  WEST_COAST: {
    key: 'WEST_COAST',
    label: 'West Coast League',
    short: 'WCL',
    blurb: 'PNW + California talent stays close to home. Pacific-coast pitcher-friendly parks. Good showcase for PNW programs without sending players cross-country.',
    region: 'PNW + N. California',
    prestige: 7,
    minOvr: 75,
    maxOvr: null,
    devFocus: 'All-around polish',
    devBuckets: ['contact_l', 'contact_r', 'control', 'fielding'],
    devMagnitude: 1.15,
    injuryRisk: 0.10,
    poachChance: 0.16,
    draftBuzzMult: 1.08,
    color: 'bg-blue-100 text-blue-800',
  },
  WILD_WEST: {
    key: 'WILD_WEST',
    label: 'Wild Wild West League',
    short: 'WWWL',
    blurb: 'Mid-tier independent league in the Mountain West. Erratic coaching quality, but real innings against real opponents. Boom-or-bust — strong players can shoot up draft boards, weak ones can pick up bad habits.',
    region: 'Mountain West',
    prestige: 5,
    minOvr: 60,
    maxOvr: 75,
    devFocus: 'High-variance development',
    devBuckets: ['power_l', 'power_r', 'stuff'],
    devMagnitude: 1.30,
    injuryRisk: 0.18,
    poachChance: 0.10,
    draftBuzzMult: 1.05,
    color: 'bg-amber-100 text-amber-800',
  },
  CASCADE: {
    key: 'CASCADE',
    label: 'Cascade Collegiate League',
    short: 'CCL',
    blurb: 'PNW developmental league. Designed for players who need reps more than a showcase. Steady at-bats, plenty of innings, low risk environment. Great for younger players who didn\'t play much in the spring.',
    region: 'PNW',
    prestige: 3,
    minOvr: 45,
    maxOvr: 70,
    devFocus: 'Reps for bench players',
    devBuckets: ['contact_l', 'contact_r', 'control', 'fielding', 'discipline'],
    devMagnitude: 1.10,
    injuryRisk: 0.08,
    poachChance: 0.04,
    draftBuzzMult: 1.0,
    color: 'bg-emerald-100 text-emerald-800',
  },
  PACIFIC_INT: {
    key: 'PACIFIC_INT',
    label: 'Pacific International League',
    short: 'PIL',
    blurb: 'Loose, semi-pro vibe across WA / OR / ID. Mix of college kids and ex-pros. Older competition forces players to grow up fast, but injury risk is higher and dev quality varies by team.',
    region: 'PNW',
    prestige: 4,
    minOvr: 45,
    maxOvr: 70,
    devFocus: 'Plate discipline + game smarts',
    devBuckets: ['discipline', 'composure', 'tactician'],
    devMagnitude: 1.05,
    injuryRisk: 0.16,
    poachChance: 0.06,
    draftBuzzMult: 1.02,
    color: 'bg-slate-100 text-slate-700'
  },
}

export const SUMMER_LEAGUE_KEYS = Object.keys(SUMMER_LEAGUES)
  // Ordered roughly best → developmental for UI display.
  .sort((a, b) => SUMMER_LEAGUES[b].prestige - SUMMER_LEAGUES[a].prestige)

// ─── Eligibility ────────────────────────────────────────────────────────────

/**
 * Is the player eligible for ANY summer league? Seniors are out (graduating /
 * going pro). The player must also be on the user's active roster and have
 * remaining eligibility.
 *
 * @param {import('./types.js').Player} player
 * @returns {boolean}
 */
export function isPlayerEligibleForSummerBall(player) {
  if (!player) return false
  if (player.classYear === 'SR' || player.classYear === 'GRAD') return false
  if (player.eligibilityStatus === 'graduated' || player.eligibilityStatus === 'dismissed') return false
  return true
}

/**
 * Return the set of league keys a specific player qualifies for, based on
 * their current OVR + class year.
 *
 * @param {import('./types.js').Player} player
 * @returns {string[]}  list of league keys
 */
export function leaguesForPlayer(player) {
  if (!isPlayerEligibleForSummerBall(player)) return []
  const ovr = playerOverall(player)
  return SUMMER_LEAGUE_KEYS.filter(k => {
    const lg = SUMMER_LEAGUES[k]
    if (ovr < lg.minOvr) return false
    if (lg.maxOvr != null && ovr > lg.maxOvr) return false
    return true
  })
}

// ─── State setup ────────────────────────────────────────────────────────────

/**
 * Initialize or migrate summerBall state on a save. Idempotent — safe to call
 * on every page load. Returns the same state for chaining.
 */
export function ensureSummerBallState(state) {
  if (!state.summerBall) {
    state.summerBall = {
      year: state.calendar?.year || null,
      status: 'PLANNING',
      assignments: {},
      lastResolved: null,
    }
  }
  if (state.summerBall.year !== state.calendar?.year && state.calendar?.year != null) {
    // New dynasty year → reset assignments to PLANNING. Old year's results
    // are already realized; we throw away the old record. Caller should
    // archive if it wants history.
    state.summerBall = {
      year: state.calendar.year,
      status: 'PLANNING',
      assignments: {},
      lastResolved: state.summerBall.lastResolved || null,
    }
  }
  return state
}

// ─── User actions ───────────────────────────────────────────────────────────

/**
 * Add a player to summer ball during the PLANNING window. League must be in
 * the player's eligible list. Returns { ok, error } so the UI can surface
 * validation failures cleanly.
 *
 * @param {any} state
 * @param {string} playerId
 * @param {string} leagueKey
 */
export function planSummerAssignment(state, playerId, leagueKey) {
  ensureSummerBallState(state)
  const player = state.players[playerId]
  if (!player) return { ok: false, error: 'Player not found.' }
  if (state.summerBall.status !== 'PLANNING') {
    return { ok: false, error: 'Planning is closed. You can only remove players now — no new sign-ups.' }
  }
  const eligible = leaguesForPlayer(player)
  if (!eligible.includes(leagueKey)) {
    const lg = SUMMER_LEAGUES[leagueKey]
    return { ok: false, error: `${player.firstName} ${player.lastName} doesn't qualify for the ${lg.label}.` }
  }
  state.summerBall.assignments[playerId] = {
    leagueKey,
    plannedAt: state.calendar?.weekOfYear || null,
    confirmed: false,
    removed: false,
  }
  return { ok: true }
}

/** Remove an assignment outright (planning window only). */
export function removeSummerAssignment(state, playerId) {
  ensureSummerBallState(state)
  if (state.summerBall.status === 'RESOLVED') return { ok: false, error: 'Already resolved.' }
  delete state.summerBall.assignments[playerId]
  return { ok: true }
}

/**
 * Confirm window: marks an assignment as confirmed OR removes it. No NEW
 * assignments can be added once the planning window has closed.
 */
export function confirmOrRemoveAssignment(state, playerId, keep) {
  ensureSummerBallState(state)
  const a = state.summerBall.assignments[playerId]
  if (!a) return { ok: false, error: 'Not assigned.' }
  if (keep) {
    a.confirmed = true
    a.removed = false
  } else {
    a.confirmed = false
    a.removed = true
  }
  return { ok: true }
}

/**
 * Close the planning window. Called when the calendar reaches the post-season
 * confirm marker. Auto-confirms any unconfirmed assignments so users who
 * never opened the page in the planning week still get their pre-existing
 * picks. (Removed players stay removed.)
 */
export function closePlanningWindow(state) {
  ensureSummerBallState(state)
  if (state.summerBall.status !== 'PLANNING') return state
  state.summerBall.status = 'CONFIRMED'
  for (const a of Object.values(state.summerBall.assignments)) {
    if (!a.removed) a.confirmed = true
  }
  return state
}

// ─── Resolution (mid-summer) ────────────────────────────────────────────────

/**
 * Run the summer ball sim. Applies dev boosts / injury rolls / poach checks /
 * draft buzz across all confirmed assignments. Mutates state. Returns an
 * array of news entries the caller pushes onto state.newsfeed.
 *
 * @param {any} state
 */
export function resolveSummerBall(state) {
  ensureSummerBallState(state)
  if (state.summerBall.status === 'RESOLVED') return []
  state.summerBall.status = 'RESOLVED'
  state.summerBall.lastResolved = state.calendar?.year

  const news = []
  const year = state.calendar?.year
  const seed = state.rngSeed || 1234

  const team = state.teams?.[state.userSchoolId]
  if (!team) return news

  for (const [playerId, a] of Object.entries(state.summerBall.assignments)) {
    if (!a.confirmed || a.removed) continue
    const player = state.players[playerId]
    if (!player) continue
    const lg = SUMMER_LEAGUES[a.leagueKey]
    if (!lg) continue

    const rng = makeRng('summerBall', year, playerId, a.leagueKey, seed)
    const ovrBefore = playerOverall(player)

    // ── Spring usage → dev modifier ────────────────────────────────────
    // Players who didn't play much in the spring get a bigger boost because
    // they're hungry for reps. Heavy-usage starters get less boost (they
    // need rest more than reps).
    const statsKey = player.isPitcher ? `p_${playerId}` : `b_${playerId}`
    const stats = state.playerStats?.[statsKey] || state._archivedPlayerStats?.[statsKey] || {}
    const springUsage = player.isPitcher
      ? (stats.ip || 0) / 60        // 60 IP ≈ full SP workload
      : (stats.pa || stats.ab || 0) / 200    // 200 PA ≈ everyday starter
    const usageBoost = Math.max(0.6, Math.min(1.6, 1.4 - springUsage * 0.8))
    // ── League dev magnitude × usage boost → final dev points ──────────
    const devPoints = Math.round(rng.gaussian(lg.devMagnitude * usageBoost * 3, 1))
    const ratingDelta = applySummerDev(player, lg.devBuckets, devPoints, rng)

    // ── Injury roll — pitcher overuse hits harder ─────────────────────
    let injuryRisk = lg.injuryRisk
    if (player.isPitcher && springUsage > 1.0) injuryRisk += 0.10
    const injured = rng.chance(injuryRisk)
    if (injured) {
      const injurySeverity = rng.weighted(['MINOR', 'MODERATE', 'MAJOR'], [6, 3, 1])
      const dur = { MINOR: 1, MODERATE: 3, MAJOR: 10 }[injurySeverity]
      player._summerInjury = { severity: injurySeverity, weeks: dur, year }
      // Minor injuries leak ~2 points of durability; majors take 6.
      const durDrop = { MINOR: 2, MODERATE: 4, MAJOR: 6 }[injurySeverity]
      if (player.isPitcher && player.pitcher) {
        player.pitcher.durability = Math.max(20, (player.pitcher.durability || 60) - durDrop)
      } else if (player.hitter) {
        player.hitter.durability = Math.max(20, (player.hitter.durability || 60) - durDrop)
      }
      news.push({
        id: `sb_inj_${year}_${playerId}`,
        year, week: 47, type: 'INJURY',
        headline: `🩼 ${player.firstName} ${player.lastName} suffered a ${injurySeverity.toLowerCase()} injury at the ${lg.short}. Recovery ~${dur} wk${dur === 1 ? '' : 's'}.`,
        payload: { playerId, leagueKey: a.leagueKey, severity: injurySeverity },
      })
    }

    // ── Poach roll — D1 sniffing around a hot player ──────────────────
    // Only triggers if the player developed nicely AND the league has scouts.
    const ovrAfter = playerOverall(player)
    const moved = ovrAfter - ovrBefore
    let poached = false
    if (!injured && moved >= 2 && rng.chance(lg.poachChance * (moved / 3))) {
      // Don't actually remove them — flag as "interest" for now. A future
      // pass can wire this into outboundTransfers.
      player._summerPoachInterest = { league: a.leagueKey, year }
      news.push({
        id: `sb_poach_${year}_${playerId}`,
        year, week: 47, type: 'TRANSFER_RUMOR',
        headline: `📞 D1 programs calling for ${player.firstName} ${player.lastName} after a hot ${lg.short} summer. Watch the portal.`,
        payload: { playerId, leagueKey: a.leagueKey },
      })
      poached = true
    }

    // ── Draft buzz — bumps next year's effective draft OVR ────────────
    if (lg.draftBuzzMult > 1.0 && moved >= 1) {
      player._summerDraftBuzz = {
        leagueKey: a.leagueKey,
        mult: lg.draftBuzzMult,
        year,
      }
    }

    // ── Headline for the player's summer ───────────────────────────────
    if (!injured && !poached) {
      const verdict = moved >= 3
        ? `crushed it`
        : moved >= 1.5
          ? `had a strong summer`
          : moved >= 0
            ? `held their own`
            : `struggled`
      news.push({
        id: `sb_${year}_${playerId}`,
        year, week: 47, type: 'PLAYER_BOOST',
        headline: `☀️ ${player.firstName} ${player.lastName} ${verdict} in the ${lg.short} (+${Math.max(0, moved).toFixed(1)} OVR).`,
        payload: { playerId, leagueKey: a.leagueKey, ovrDelta: moved },
      })
    }
  }

  return news
}

/**
 * Apply per-rating development bumps to a player's hitter / pitcher block
 * focused on the league's emphasis buckets. Each bucket gets ~1/(n) of the
 * total dev points, capped so a single summer can't 99 anyone.
 *
 * @param {import('./types.js').Player} player
 * @param {string[]} buckets
 * @param {number} totalPoints
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 */
function applySummerDev(player, buckets, totalPoints, rng) {
  if (totalPoints <= 0) return 0
  const block = player.isPitcher ? player.pitcher : player.hitter
  if (!block) return 0
  const applicable = buckets.filter(k => k in block)
  if (applicable.length === 0) return 0
  let applied = 0
  for (const k of applicable) {
    const share = totalPoints / applicable.length
    const jitter = rng.gaussian(0, 0.5)
    const bump = Math.max(0, Math.round(share + jitter))
    if (bump > 0) {
      const before = block[k]
      block[k] = Math.min(99, before + bump)
      applied += block[k] - before
    }
  }
  return applied
}
