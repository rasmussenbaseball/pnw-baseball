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
import { playerOverall, playerPotentialOverall } from './playerRating'

/** @typedef {{
 *   key: string,
 *   label: string,
 *   short: string,
 *   blurb: string,
 *   region: string,
 *   prestige: number,             // 1-10, drives draft buzz + poach + recruit reputation
 *   minOvr: number,
 *   maxOvr: number|null,          // null = no upper bound
 *   slotsPerProgram: number,      // hard cap of YOUR players in this league
 *   devFocusLabel: string,        // SHORT label of attribute buckets, e.g. "Power · Contact · Stuff"
 *   devFocusLong: string,         // 1-sentence narrative blurb on what improves
 *   devBuckets: string[],         // rating keys this league develops faster
 *   primaryBuckets: string[],     // top 2-3 high-leverage stats. Get double share.
 *   devMagnitude: number,         // raw dev-points multiplier on Gaussian(devMagnitude * 3, 1)
 *   devTier: 'ELITE'|'HIGH'|'STRONG'|'STEADY',  // display bucket
 *   injuryRisk: number,           // 0..1 base chance of an injury event
 *   poachChance: number,          // 0..1 BASE poach rate before retention factors
 *   draftBuzzMult: number,        // multiplier on effective OVR for next year's draft
 *   color: string,                // tailwind class for badges
 * }} SummerLeague */

// Human-readable labels for rating buckets we use in summer ball — used on the
// UI to clearly show what attributes get boosted instead of hiding behind a
// vague "devFocus" string.
export const RATING_LABEL = {
  power_l: 'Power vs LHP',
  power_r: 'Power vs RHP',
  contact_l: 'Contact vs LHP',
  contact_r: 'Contact vs RHP',
  speed: 'Speed',
  fielding: 'Fielding',
  arm: 'Arm',
  discipline: 'Plate Discipline',
  composure: 'Composure',
  durability: 'Durability',
  stamina: 'Stamina',
  // Pitchers
  stuff: 'Stuff',
  command: 'Command',
  control: 'Control',
  velocity: 'Velocity',
  slider: 'Slider',
  curveball: 'Curveball',
  changeup: 'Changeup',
  cutter: 'Cutter',
}

/** Format a list of attribute keys into a UI-friendly comma-joined label. */
export function describeDevBuckets(keys) {
  if (!keys || keys.length === 0) return '—'
  return keys.map(k => RATING_LABEL[k] || k).join(' · ')
}

/** @type {Object<string,SummerLeague>} */
export const SUMMER_LEAGUES = {
  // ── Elite tier: huge upside, real risk. Best players, best leagues.
  // Elite leagues develop SHOWCASE TOOLS — power, contact, stuff. They do NOT
  // boost durability or stamina; that growth lives in the developmental tier
  // where the long-grind workload actually trains those attributes. ──
  CAPE_COD: {
    key: 'CAPE_COD',
    label: 'Cape Cod League',
    short: 'CCBL',
    blurb: 'The premier summer league in the country. Wood bats, MLB scouts at every game, every D1 hovering over your roster. Polish every showcase tool against the best amateur arms + bats — but you have to be willing to risk losing them.',
    region: 'Cape Cod, MA',
    prestige: 10,
    minOvr: 90,
    maxOvr: null,
    slotsPerProgram: 1,
    devFocusLabel: 'Showcase tools (power · contact · stuff)',
    devFocusLong: 'Trains the big-five scout tools — power, contact, stuff, command, and velocity — against pro-quality competition.',
    devBuckets: ['power_l', 'power_r', 'contact_l', 'contact_r', 'stuff', 'command', 'velocity'],
    primaryBuckets: ['power_l', 'power_r', 'stuff'],
    devMagnitude: 2.4,
    devTier: 'ELITE',
    injuryRisk: 0.07,
    poachChance: 0.22,
    draftBuzzMult: 1.35,
    color: 'bg-purple-100 text-purple-800',
  },
  NORTHWOODS: {
    key: 'NORTHWOODS',
    label: 'Northwoods League',
    short: 'NWL',
    blurb: '72-game wood-bat grind across Wisconsin + Minnesota. Closest thing to a pro schedule any amateur sees. Big tools polished against high-end opposition — pitchers add velo, hitters add power-contact balance.',
    region: 'Upper Midwest',
    prestige: 8,
    minOvr: 82,
    maxOvr: null,
    slotsPerProgram: 1,
    devFocusLabel: 'Power · Contact · Velocity',
    devFocusLong: 'Big-stage at-bats and innings polish power, contact, and pitcher velocity. Long schedule means real injury exposure.',
    devBuckets: ['power_l', 'power_r', 'contact_l', 'contact_r', 'velocity', 'stuff', 'speed'],
    primaryBuckets: ['power_l', 'power_r', 'velocity'],
    devMagnitude: 2.0,
    devTier: 'HIGH',
    injuryRisk: 0.16,
    poachChance: 0.18,
    draftBuzzMult: 1.18,
    color: 'bg-indigo-100 text-indigo-800',
  },
  WEST_COAST: {
    key: 'WEST_COAST',
    label: 'West Coast League',
    short: 'WCL',
    blurb: 'PNW + California talent stays close to home. Pacific-coast pitcher-friendly parks + a real-deal scout following. Best place for west-coast NAIA arms to get pro looks without flying across the country.',
    region: 'PNW + N. California',
    prestige: 7,
    minOvr: 75,
    maxOvr: null,
    slotsPerProgram: 1,
    devFocusLabel: 'Contact · Command · Power',
    devFocusLong: 'Polished all-around game in front of west-coast scouts. Hitters refine contact + power; pitchers refine command + control.',
    devBuckets: ['contact_l', 'contact_r', 'power_l', 'power_r', 'command', 'control', 'speed'],
    primaryBuckets: ['contact_l', 'contact_r', 'command'],
    devMagnitude: 1.85,
    devTier: 'HIGH',
    injuryRisk: 0.09,
    poachChance: 0.15,
    draftBuzzMult: 1.12,
    color: 'bg-blue-100 text-blue-800',
  },
  WESTERN_CANADIAN: {
    key: 'WESTERN_CANADIAN',
    label: 'Western Canadian Baseball League',
    short: 'WCBL',
    blurb: 'Strong wood-bat league across the prairies. Pitcher-friendly parks + high-quality coaching make this the best mid-tier home for arms. MLB scouts attend regularly.',
    region: 'Prairie Provinces',
    prestige: 7,
    minOvr: 70,
    maxOvr: 85,
    slotsPerProgram: 1,
    devFocusLabel: 'Stuff · Command · Secondary pitches',
    devFocusLong: 'Pitcher-friendly league. Sharpens stuff, command, control, slider, and curveball. Hitters get fewer reps here.',
    devBuckets: ['stuff', 'command', 'control', 'slider', 'curveball', 'velocity'],
    primaryBuckets: ['stuff', 'command'],
    devMagnitude: 1.65,
    devTier: 'STRONG',
    injuryRisk: 0.09,
    poachChance: 0.10,
    draftBuzzMult: 1.08,
    color: 'bg-rose-100 text-rose-800',
  },

  // ── Mid / developmental tier — these are where bench players grow.
  // Higher dev magnitude on a smaller-profile player. Durability + stamina
  // training lives here, because grinding long innings with sub-par
  // opposition trains your body more than your skills. ──
  WILD_WEST: {
    key: 'WILD_WEST',
    label: 'Wild Wild West League',
    short: 'WWWL',
    blurb: 'Independent league in the Mountain West. Wood + metal hybrid, plenty of innings, plenty of swings. Mid-roster guys turn a summer here into a starting job. Boom-or-bust upside on power + speed.',
    region: 'Mountain West',
    prestige: 5,
    minOvr: 60,
    maxOvr: 75,
    slotsPerProgram: 1,
    devFocusLabel: 'Power · Speed · Stuff (boom-or-bust)',
    devFocusLong: 'Boom-or-bust upside. Power, speed, and raw stuff get pushed, but discipline does NOT — wild league for wild players.',
    devBuckets: ['power_l', 'power_r', 'stuff', 'speed', 'velocity'],
    primaryBuckets: ['power_l', 'power_r', 'speed'],
    devMagnitude: 2.0,
    devTier: 'HIGH',
    injuryRisk: 0.11,
    poachChance: 0.06,
    draftBuzzMult: 1.04,
    color: 'bg-amber-100 text-amber-800',
  },
  PACIFIC_INT: {
    key: 'PACIFIC_INT',
    label: 'Pacific International League',
    short: 'PIL',
    blurb: 'Loose, semi-pro vibe across WA / OR / ID. Mix of college kids and ex-pros. Older competition forces players to grow up fast. Best for mental side + fielding work.',
    region: 'PNW',
    prestige: 4,
    minOvr: 45,
    maxOvr: 70,
    slotsPerProgram: 1,
    devFocusLabel: 'Discipline · Composure · Fielding · Durability',
    devFocusLong: 'Game-smarts league. Plate discipline, composure, fielding, and durability get bumped — the mental + body fundamentals.',
    devBuckets: ['discipline', 'composure', 'fielding', 'control', 'durability'],
    primaryBuckets: ['discipline', 'composure'],
    devMagnitude: 1.7,
    devTier: 'STRONG',
    injuryRisk: 0.06,
    poachChance: 0.04,
    draftBuzzMult: 1.0,
    color: 'bg-slate-100 text-slate-700'
  },
  CASCADE: {
    key: 'CASCADE',
    label: 'Cascade Collegiate League',
    short: 'CCL',
    blurb: 'PNW developmental league — the safest summer-ball assignment in the game. Designed for younger players who need reps more than a showcase. Steady at-bats, full innings, low injury rate. Bench players blossom here.',
    region: 'PNW',
    prestige: 3,
    minOvr: 45,
    maxOvr: 70,
    slotsPerProgram: 1,
    devFocusLabel: 'Contact · Fielding · Durability · Stamina',
    devFocusLong: 'Pure reps. Builds contact, fielding, durability, and stamina through volume. Where bench players turn into starters.',
    devBuckets: ['contact_l', 'contact_r', 'fielding', 'control', 'discipline', 'durability', 'stamina', 'arm'],
    primaryBuckets: ['contact_l', 'contact_r', 'durability'],
    devMagnitude: 1.9,
    devTier: 'HIGH',
    injuryRisk: 0.03,
    poachChance: 0.02,
    draftBuzzMult: 1.0,
    color: 'bg-emerald-100 text-emerald-800',
  },
}

export const SUMMER_LEAGUE_KEYS = Object.keys(SUMMER_LEAGUES)
  // Ordered roughly best developmental for UI display.
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
  // Injured players can't go — they need to rehab. UI hides them; engine
  // resolution skips them as a safety net.
  if ((player.injury?.weeksRemaining || 0) > 0) return false
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

/**
 * Auto-assign summer ball placements for the user's roster. Walks players
 * best-OVR-first and slots each into the highest-prestige league they
 * qualify for that still has an open program slot. Used by the "auto-select"
 * choice on the planning-week popup + by Auto mode.
 *
 * @returns {{ assigned: number }}
 */
export function autoAssignSummerBall(state) {
  ensureSummerBallState(state)
  if (state.summerBall.status !== 'PLANNING') return { assigned: 0 }
  const team = state.teams?.[state.userSchoolId]
  if (!team) return { assigned: 0 }
  // Priority = current OVR + future ceiling (Nate: send the best + the
  // highest-potential). Weight OVR a bit more than potential.
  const roster = (team.rosterPlayerIds || [])
    .map(id => state.players[id])
    .filter(Boolean)
    .map(p => {
      const ovr = playerOverall(p)
      const pot = playerPotentialOverall(p)
      return { p, ovr, pot, score: ovr * 0.6 + pot * 0.4 }
    })
    .sort((a, b) => b.score - a.score)
  let assigned = 0
  const isOpen = (p) => {
    const e = state.summerBall.assignments[p.id]
    return !e || e.removed
  }
  for (const { p } of roster) {
    if (!isOpen(p)) continue
    // leaguesForPlayer is prestige-descending; take the first open slot.
    const eligible = leaguesForPlayer(p)
    for (const leagueKey of eligible) {
      const r = planSummerAssignment(state, p.id, leagueKey)
      if (r.ok) { assigned++; break }
    }
  }
  // GUARANTEE at least 4 players go out each year. If eligibility/slots left
  // us short, force the top unassigned players into any open league slot
  // (bypass the min-OVR gate — better to get reps than send nobody).
  if (assigned < 4) {
    for (const { p } of roster) {
      if (assigned >= 4) break
      if (!isOpen(p)) continue
      for (const leagueKey of SUMMER_LEAGUE_KEYS) {
        const lg = SUMMER_LEAGUES[leagueKey]
        const cap = lg?.slotsPerProgram ?? 1
        const occupants = Object.entries(state.summerBall.assignments)
          .filter(([pid, a]) => !a.removed && a.leagueKey === leagueKey && pid !== p.id).length
        if (occupants >= cap) continue
        state.summerBall.assignments[p.id] = {
          leagueKey, plannedAt: state.calendar?.weekOfYear || null, confirmed: false, removed: false,
        }
        if (p.happiness && typeof p.happiness.value === 'number' && !p._summerMoodApplied) {
          p.happiness.value = Math.min(100, p.happiness.value + 4 + Math.round((lg?.prestige ?? 5) * 0.6))
          p._summerMoodApplied = true
        }
        assigned++
        break
      }
    }
  }
  return { assigned }
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
    // New dynasty year reset assignments to PLANNING. Old year's results
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
  // ── ONE-PER-LEAGUE LIMIT ───────────────────────────────────────────
  // Each league has a hard cap (slotsPerProgram, default 1) on how many of
  // YOUR players can be sent. This forces real choices — you can't dump
  // your whole roster into Cape Cod. If a slot is taken, point the user at
  // the existing assignment so they know who to remove first.
  const lg = SUMMER_LEAGUES[leagueKey]
  const cap = lg?.slotsPerProgram ?? 1
  const occupants = Object.entries(state.summerBall.assignments)
    .filter(([pid, a]) => !a.removed && a.leagueKey === leagueKey && pid !== playerId)
  if (occupants.length >= cap) {
    const heldBy = occupants.map(([pid]) => {
      const p = state.players[pid]
      return p ? `${p.firstName} ${p.lastName}` : 'another player'
    }).join(', ')
    return {
      ok: false,
      error: `${lg.label} only allows ${cap} player per program — ${heldBy} is currently holding the slot. Remove them first to swap.`,
    }
  }
  state.summerBall.assignments[playerId] = {
    leagueKey,
    plannedAt: state.calendar?.weekOfYear || null,
    confirmed: false,
    removed: false,
  }
  // Players are thrilled to be sent to a summer league — the more
  // prestigious the league, the bigger the mood bump. Only apply once per
  // assignment (re-leaguing within the window doesn't stack endlessly).
  if (player.happiness && typeof player.happiness.value === 'number' && !player._summerMoodApplied) {
    const prestige = lg?.prestige ?? 5
    const bump = 4 + Math.round(prestige * 0.6)   // ~+5 (low) to ~+10 (Cape Cod)
    player.happiness.value = Math.min(100, player.happiness.value + bump)
    player._summerMoodApplied = true
  }
  return { ok: true }
}

/** Remove an assignment outright (planning window only). */
export function removeSummerAssignment(state, playerId) {
  ensureSummerBallState(state)
  if (state.summerBall.status === 'RESOLVED') return { ok: false, error: 'Already resolved.' }
  delete state.summerBall.assignments[playerId]
  // Allow the mood bump to re-apply if they're reassigned later.
  const p = state.players[playerId]
  if (p) delete p._summerMoodApplied
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
  // Per-player resolution log surfaces in the end-of-summer report UI.
  state.summerBall.results = []

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
    const resultEntry = {
      playerId,
      playerName: `${player.firstName} ${player.lastName}`,
      leagueKey: a.leagueKey,
      ovrBefore,
      ovrAfter: ovrBefore,
      ovrDelta: 0,
      ratingsApplied: 0,
      injured: null,
      poached: false,
      draftBuzz: false,
      verdict: 'held own',
    }

    // ── Spring usage dev modifier ────────────────────────────────────
    // Players who didn't play much in the spring get a bigger boost because
    // they're hungry for reps. Heavy-usage starters get less boost (they
    // need rest more than reps).
    const statsKey = player.isPitcher ? `p_${playerId}` : `b_${playerId}`
    const stats = state.playerStats?.[statsKey] || state._archivedPlayerStats?.[statsKey] || {}
    const springUsage = player.isPitcher
      ? (stats.ip || 0) / 60        // 60 IP ≈ full SP workload
      : (stats.pa || stats.ab || 0) / 200    // 200 PA ≈ everyday starter
    const usageBoost = Math.max(0.6, Math.min(1.6, 1.4 - springUsage * 0.8))
    // ── League dev magnitude × usage boost final dev points ──────────
    const devPoints = Math.round(rng.gaussian(lg.devMagnitude * usageBoost * 3, 1))
    const ratingDelta = applySummerDev(player, lg.devBuckets, lg.primaryBuckets || [], devPoints, rng)
    resultEntry.ratingsApplied = ratingDelta

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
      resultEntry.injured = { severity: injurySeverity, weeks: dur }
      news.push({
        id: `sb_inj_${year}_${playerId}`,
        year, week: 47, type: 'INJURY',
        headline: `${player.firstName} ${player.lastName} suffered a ${injurySeverity.toLowerCase()} injury at the ${lg.short}. Recovery ~${dur} wk${dur === 1 ? '' : 's'}.`,
        payload: { playerId, leagueKey: a.leagueKey, severity: injurySeverity },
      })
    }

    // ── Poach roll — D1 sniffing around a hot player ──────────────────
    // Only triggers if the player developed nicely AND the league has scouts.
    // The effective chance is base × movement × (1 − scholarship retention)
    // × (1 − team-quality retention) × level-vulnerability multiplier.
    // Big-money players on top programs almost never get poached; a star
    // on a bad D3 with no scholarship is the easiest target on the planet.
    const ovrAfter = playerOverall(player)
    const moved = ovrAfter - ovrBefore
    let poached = false
    const userSchool = state.schools?.[state.userSchoolId]
    const userTeamRating = state.nwbbRatings?.[state.userSchoolId]?.rating ?? 60
    const poachP = computePoachProbability({
      league: lg,
      moved,
      player,
      school: userSchool,
      teamRating: userTeamRating,
    })
    resultEntry.poachProb = poachP
    if (!injured && moved >= 2 && rng.chance(poachP)) {
      // Don't actually remove them — flag as "interest" for now. A future
      // pass can wire this into outboundTransfers.
      player._summerPoachInterest = { league: a.leagueKey, year }
      news.push({
        id: `sb_poach_${year}_${playerId}`,
        year, week: 47, type: 'TRANSFER_RUMOR',
        headline: `D1 programs calling for ${player.firstName} ${player.lastName} after a hot ${lg.short} summer. Watch the portal.`,
        payload: { playerId, leagueKey: a.leagueKey },
      })
      resultEntry.poached = true
      poached = true
    }

    // ── Draft buzz — bumps next year's effective draft OVR ────────────
    if (lg.draftBuzzMult > 1.0 && moved >= 1) {
      player._summerDraftBuzz = {
        leagueKey: a.leagueKey,
        mult: lg.draftBuzzMult,
        year,
      }
      resultEntry.draftBuzz = true
    }

    // ── Headline for the player's summer ───────────────────────────────
    const verdict = moved >= 3 ? 'crushed it'
      : moved >= 1.5 ? 'had a strong summer'
      : moved >= 0 ? 'held their own'
      : 'struggled'
    resultEntry.ovrAfter = ovrAfter
    resultEntry.ovrDelta = moved
    resultEntry.verdict = verdict
    state.summerBall.results.push(resultEntry)
    if (!injured && !poached) {
      news.push({
        id: `sb_${year}_${playerId}`,
        year, week: 47, type: 'PLAYER_BOOST',
        headline: `${player.firstName} ${player.lastName} ${verdict} in the ${lg.short} (+${Math.max(0, moved).toFixed(1)} OVR).`,
        payload: { playerId, leagueKey: a.leagueKey, ovrDelta: moved },
      })
    }
  }

  // Mark for the SummerBall page so a recap banner / modal can surface.
  state.summerBall.reportPending = true

  return news
}

/**
 * Apply per-rating development bumps to a player's hitter / pitcher block.
 * Primary buckets (league.primaryBuckets) get DOUBLE share — that's how a
 * league with focus "Power · Contact · Stuff" actually pushes power & stuff
 * harder than the secondary tools.
 *
 * @param {import('./types.js').Player} player
 * @param {string[]} buckets       all dev-eligible rating keys
 * @param {string[]} primary       subset that gets weight 2 instead of 1
 * @param {number} totalPoints
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 */
function applySummerDev(player, buckets, primary, totalPoints, rng) {
  if (totalPoints <= 0) return 0
  const block = player.isPitcher ? player.pitcher : player.hitter
  if (!block) return 0
  const applicable = buckets.filter(k => k in block)
  if (applicable.length === 0) return 0
  // Compute weighted total: primary buckets count 2x.
  const primarySet = new Set(primary || [])
  const totalWeight = applicable.reduce((s, k) => s + (primarySet.has(k) ? 2 : 1), 0)
  let applied = 0
  for (const k of applicable) {
    const weight = primarySet.has(k) ? 2 : 1
    const share = totalPoints * (weight / totalWeight)
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

// ─── Poach probability ──────────────────────────────────────────────────────

/**
 * Compute the effective chance a player gets poached after a summer breakout.
 *
 * Factors:
 *   - base = league.poachChance (drives by league prestige — Cape Cod 45%)
 *   - movement = max(0.3, moved/3) — bigger OVR jump = more interest
 *   - scholRetention = up to 70% retention from $30K+ scholarship
 *   - qualityRetention = up to 50% retention if your team's NWBB rating
 *     is 80+. A top-25 program holds players.
 *   - levelVuln = level vulnerability multiplier (D1 1.0, D3 1.20, NWAC 1.25)
 *
 * Returns a probability in [0, 0.70]. Clamped so it never feels unfair —
 * even the worst case caps out at ~70% poach.
 *
 * @param {{ league: any, moved: number, player: any, school: any, teamRating: number }} args
 * @returns {number}
 */
export function computePoachProbability({ league, moved, player, school, teamRating }) {
  if (!league) return 0
  const base = league.poachChance || 0
  const movement = Math.max(0.3, Math.min(2.5, moved / 3))

  // Scholarship retention: bigger $ → harder to pry the player loose.
  // Scales linearly to 70% retention at $30K. Capped so this single factor
  // can't fully eliminate poach risk on its own.
  const schol = player?.scholarship?.annualAmount || 0
  const scholRetention = Math.min(0.70, (schol / 30000) * 0.70)

  // Team-quality retention: a player on a top-25-rated program is less
  // likely to leave for a slight upgrade. Scales 0 → 50% between rating
  // 60 and 80.
  const tr = teamRating ?? 60
  const qualityRetention = Math.max(0, Math.min(0.50, ((tr - 60) / 20) * 0.50))

  // Level vulnerability — being on a D3 or NWAC team makes the player more
  // exposed (no athletic schol at D3 + JUCO is by design a stepping stone).
  const levelVuln = {
    D1: 0.95,
    D2: 1.00,
    NAIA: 1.10,
    D3: 1.20,
    NWAC: 1.25,
  }[school?.level || 'NAIA'] || 1.10

  const p = base * movement * (1 - scholRetention) * (1 - qualityRetention) * levelVuln
  // Hard ceiling of 25% — per Nate, poach rate should never exceed 25% even
  // for the most prestigious leagues (Cape Cod etc.). A 45% chance to lose
  // your best player felt punishing.
  return Math.max(0, Math.min(0.25, p))
}
