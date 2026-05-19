/**
 * Weekly team-wide actions.
 *
 * Each action targets a SINGLE stat. Two variants per action:
 *   - Permanent: +1 rating, 15 AP, sticks forever
 *   - Temporary: +5 rating, 10 AP, wears off after 4 weeks
 *
 * Once per week — `state.weeklyActionsUsed`tracks the key.
 */

import { makeRng } from './rng'

const TEMP_WEEKS = 4
export const PERM_AP = 15
export const TEMP_AP = 10
export const PERM_BUMP = 1
export const TEMP_BUMP = 5

function action(key, label, emoji, target, ratingKey, availableIn, blurb, opts = {}) {
  return {
    key, label, emoji, target, ratingKey, availableIn, blurb,
    permAp: PERM_AP, tempAp: TEMP_AP,
    permAmount: PERM_BUMP, tempAmount: TEMP_BUMP,
    velocity: opts.velocity === true,
  }
}

/** @type {Record<string, ReturnType<typeof action>>} */
export const WEEKLY_ACTIONS = {
  // ─── Hitter — Contact ──────────────────────────────────────────────
  CONTACT_L: action('CONTACT_L', 'Contact Practice (vs LHP)', '', 'hitters', 'contact_l',
    ['Fall Camp', 'November', 'December', 'Spring Practice'],
    'Cage work facing left-handed flips/machines.'),
  CONTACT_R: action('CONTACT_R', 'Contact Practice (vs RHP)', '', 'hitters', 'contact_r',
    ['Fall Camp', 'November', 'December', 'Spring Practice'],
    'Cage work facing right-handed flips/machines.'),

  // ─── Hitter — Power ────────────────────────────────────────────────
  POWER_L: action('POWER_L', 'Lefty BP Power', '', 'hitters', 'power_l',
    ['Fall Camp', 'November', 'December', 'Spring Practice'],
    'Heavy power BP vs left-handers.'),
  POWER_R: action('POWER_R', 'Righty BP Power', '', 'hitters', 'power_r',
    ['Fall Camp', 'November', 'December', 'Spring Practice'],
    'Heavy power BP vs right-handers.'),

  // ─── Hitter — Other ────────────────────────────────────────────────
  PLATE_DISCIPLINE: action('PLATE_DISCIPLINE', 'Plate Discipline', '', 'hitters', 'discipline',
    ['Fall Camp', 'November', 'December', 'Spring Practice'],
    'Pitch-tracking work to sharpen zone awareness.'),
  SPEED_CAMP: action('SPEED_CAMP', 'Speed Camp', '', 'hitters', 'speed',
    ['Fall Camp', 'November', 'December', 'Spring Practice'],
    'Sprint mechanics + base-running.'),
  FIELDING_DRILLS: action('FIELDING_DRILLS', 'Fielding Drills', '', 'hitters', 'fielding',
    ['Fall Camp', 'November', 'December', 'Spring Practice'],
    'Ground balls, range, footwork.'),
  THROWING_DRILLS: action('THROWING_DRILLS', 'Arm Drills', '', 'hitters', 'arm',
    ['Fall Camp', 'November', 'December', 'Spring Practice'],
    'Throwing accuracy + arm strength.'),

  // ─── Pitcher ───────────────────────────────────────────────────────
  STUFF_WORK: action('STUFF_WORK', 'Stuff Bullpen', '', 'pitchers', 'stuff',
    ['Fall Camp', 'November', 'December', 'Spring Practice'],
    'Pitch design — break, movement, swing-and-miss reps.'),
  CONTROL_WORK: action('CONTROL_WORK', 'Command Work', '', 'pitchers', 'control',
    ['Fall Camp', 'November', 'December', 'Spring Practice'],
    'Throwing to a target consistently.'),
  STAMINA_WORK: action('STAMINA_WORK', 'Endurance Training', '', 'pitchers', 'stamina',
    ['Fall Camp', 'November', 'December', 'Spring Practice'],
    'Long-tossing + cardio — innings-per-outing capacity.'),
  VELOCITY_PROGRAM: action('VELOCITY_PROGRAM', 'Velocity Program', '', 'pitchers', '__velocity',
    ['Fall Camp', 'November', 'December'],
    'Weighted balls + long-toss — adds avg velocity.',
    { velocity: true }),

  // ─── Whole-team ────────────────────────────────────────────────────
  RECOVERY: action('RECOVERY', 'Recovery Day', '', 'all', 'durability',
    ['any'],
    'Light practice + treatment.'),
  FILM_STUDY: action('FILM_STUDY', 'Film Study', '', 'all', 'composure',
    ['any'],
    'Mental reps — situational awareness, opponent breakdowns.'),
}

/**
 * Apply a weekly action to the user's roster.
 *
 * @param {import('./types.js').SaveState} state
 * @param {ReturnType<typeof action>} actionDef
 * @param {'PERMANENT'|'TEMPORARY'} variant
 * @returns {{ playersAffected: number, perPlayerBump: number, kind: string }}
 */
export function applyWeeklyAction(state, actionDef, variant) {
  const team = state.teams[state.userSchoolId]
  if (!team) return { playersAffected: 0, perPlayerBump: 0, kind: variant }
  const rng = makeRng('weekly', actionDef.key, variant, state.calendar.year, state.calendar.week)
  const isTemp = variant === 'TEMPORARY'
  const amount = isTemp ? actionDef.tempAmount : actionDef.permAmount

  const target = actionDef.target
  const includeHit = target === 'all' || target === 'hitters'
  const includePit = target === 'all' || target === 'pitchers'

  let playersAffected = 0
  if (!state.tempBoosts) state.tempBoosts = []
  if (!state.permanentBumps) state.permanentBumps = []

  for (const id of team.rosterPlayerIds) {
    const p = state.players[id]
    if (!p) continue
    const matchesGroup = (includeHit && p.isHitter) || (includePit && p.isPitcher)
    if (!matchesGroup) continue
    playersAffected++

    const side = (includePit && p.isPitcher) ? 'pitcher' : 'hitter'
    const block = side === 'pitcher' ? p.pitcher : p.hitter
    if (!block) continue

    // Velocity special-case
    if (actionDef.velocity && p.isPitcher) {
      const newAvg = Math.min(96, (p.pitcher.velocity_avg || 84) + amount)
      const spread = (p.pitcher.velocity_max - p.pitcher.velocity_min) / 2 || 2
      p.pitcher.velocity_avg = Math.round(newAvg * 10) / 10
      p.pitcher.velocity_min = Math.round((newAvg - spread) * 10) / 10
      p.pitcher.velocity_max = Math.round((newAvg + spread) * 10) / 10
      if (isTemp) {
        state.tempBoosts.push({
          playerId: id, ratingKey: 'velocity_avg', side: 'pitcher',
          amount, weeksRemaining: TEMP_WEEKS,
        })
      } else {
        state.permanentBumps.push({
          playerId: id, ratingKey: 'velocity_avg', side: 'pitcher',
          amount, weekApplied: state.calendar.week,
        })
      }
      continue
    }

    const key = actionDef.ratingKey
    if (typeof block[key] !== 'number') continue
    const ceiling = side === 'pitcher'
      ? (p.hidden?.potential_pitcher?.[key] ?? 99)
      : (p.hidden?.potential_hitter?.[key] ?? 99)
    const newValue = Math.min(99, block[key] + amount)
    const actualBump = Math.min(newValue - block[key], ceiling - block[key])
    if (actualBump <= 0) continue
    block[key] = Math.round((block[key] + actualBump) * 10) / 10
    if (isTemp) {
      state.tempBoosts.push({
        playerId: id, ratingKey: key, side,
        amount: actualBump, weeksRemaining: TEMP_WEEKS,
      })
    } else {
      state.permanentBumps.push({
        playerId: id, ratingKey: key, side,
        amount: actualBump, weekApplied: state.calendar.week,
      })
    }
  }

  return { playersAffected, perPlayerBump: amount, kind: variant }
}

export function isActionAvailable(actionDef, currentPhase) {
  if (!actionDef.availableIn || actionDef.availableIn.includes('any')) return true
  return actionDef.availableIn.includes(currentPhase)
}

// The condensed month-turns (October wk 9, November wk 13, December wk 18)
// each simulate ~4 weeks, so any once-per-week action can be repeated up to
// 4 times during them. Every other turn keeps the standard 1-use cap.
const CONDENSED_MONTH_ANCHORS = new Set([9, 13, 18])

export function maxActionUsesThisTurn(state) {
  const wk = state?.calendar?.weekOfYear ?? 0
  return CONDENSED_MONTH_ANCHORS.has(wk) ? 4 : 1
}

/** How many times `actionKey` has been used this turn. */
export function actionUsesThisTurn(state, actionKey) {
  return (state.weeklyActionsUsed || []).filter(x => x === actionKey || x?.key === actionKey).length
}

/** Uses still available this turn for `actionKey`. */
export function actionUsesRemaining(state, actionKey) {
  return Math.max(0, maxActionUsesThisTurn(state) - actionUsesThisTurn(state, actionKey))
}

export function isActionUsedThisWeek(state, actionKey) {
  // "Used up" = no uses remaining this turn (1 normally, 4 in condensed months).
  return actionUsesRemaining(state, actionKey) <= 0
}

export function markActionUsedThisWeek(state, actionKey) {
  if (!state.weeklyActionsUsed) state.weeklyActionsUsed = []
  // Push every time so repeat uses are counted (condensed months allow 4).
  state.weeklyActionsUsed.push(actionKey)
}
