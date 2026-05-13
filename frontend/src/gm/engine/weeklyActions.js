/**
 * Weekly team-wide actions the head coach can spend AP on.
 *
 * Each category exposes TWO variants:
 *   - Permanent: smaller bump applied permanently to the rating
 *   - Temporary: bigger bump that wears off after 4 weeks
 *
 * The temporary boost is recorded on save.tempBoosts; season.js ticks down
 * the weeksRemaining counter each week and reverses the bump on expiry.
 */

import { makeRng } from './rng'

const TEMP_WEEKS = 4

/**
 * @typedef {Object} WeeklyActionDef
 * @property {string} key
 * @property {string} label
 * @property {string} emoji
 * @property {number} permAp
 * @property {number} tempAp
 * @property {number} permAmount      avg permanent rating bump
 * @property {number} tempAmount      avg temporary rating bump (larger)
 * @property {string[]} ratingKeys    keys on hitter/pitcher block to bump
 * @property {'hitters'|'pitchers'|'all'} target
 * @property {string[]} availableIn   phase names or 'any'
 * @property {string} blurb
 * @property {boolean} [velocity]     if true, bumps pitcher.velocity_avg instead
 */

/** @type {Record<string, WeeklyActionDef>} */
export const WEEKLY_ACTIONS = {
  RECOVERY: {
    key: 'RECOVERY', label: 'Recovery Day', emoji: '🛌',
    permAp: 2, tempAp: 3,
    permAmount: 0.5, tempAmount: 1.2,
    ratingKeys: ['durability'], target: 'all',
    availableIn: ['any'],
    blurb: 'Light practice + treatment.',
  },
  HARD_PRACTICE: {
    key: 'HARD_PRACTICE', label: 'Hard Practice', emoji: '💪',
    permAp: 3, tempAp: 4,
    permAmount: 0.3, tempAmount: 0.7,
    ratingKeys: ['contact_l', 'contact_r', 'power_l', 'power_r', 'fielding', 'stuff', 'control'],
    target: 'all',
    availableIn: ['Fall Camp', 'Training Period', 'Spring Practice'],
    blurb: 'High-intensity all-around workout.',
  },
  TEAM_DINNER: {
    key: 'TEAM_DINNER', label: 'Team Dinner', emoji: '🍽',
    permAp: 1, tempAp: 2,
    permAmount: 0.4, tempAmount: 1.0,
    ratingKeys: ['composure'], target: 'all',
    availableIn: ['any'],
    blurb: 'Chemistry builder. Bumps composure across the roster.',
  },
  SPEED_CAMP: {
    key: 'SPEED_CAMP', label: 'Speed Camp', emoji: '⚡',
    permAp: 3, tempAp: 4,
    permAmount: 0.7, tempAmount: 1.6,
    ratingKeys: ['speed'], target: 'hitters',
    availableIn: ['Fall Camp', 'Training Period', 'Spring Practice'],
    blurb: 'Sprint + baserunning work.',
  },
  POWER_WORKOUT: {
    key: 'POWER_WORKOUT', label: 'Power Workout', emoji: '🏋️',
    permAp: 3, tempAp: 4,
    permAmount: 0.6, tempAmount: 1.4,
    ratingKeys: ['power_l', 'power_r'], target: 'hitters',
    availableIn: ['Fall Camp', 'Training Period', 'Spring Practice'],
    blurb: 'Weight-room emphasis.',
  },
  HR_DERBY: {
    key: 'HR_DERBY', label: 'HR Derby', emoji: '💥',
    permAp: 2, tempAp: 3,
    permAmount: 0.5, tempAmount: 1.2,
    ratingKeys: ['power_l', 'power_r'], target: 'hitters',
    availableIn: ['Summer', 'Fall Camp', 'Training Period', 'Spring Practice'],
    blurb: 'Reps + competition.',
  },
  BULLPEN_SESSIONS: {
    key: 'BULLPEN_SESSIONS', label: 'Bullpen Sessions', emoji: '⚾',
    permAp: 3, tempAp: 4,
    permAmount: 0.5, tempAmount: 1.3,
    ratingKeys: ['stuff', 'control'], target: 'pitchers',
    availableIn: ['Fall Camp', 'Training Period', 'Spring Practice'],
    blurb: 'Pitching coach drills.',
  },
  VELOCITY: {
    key: 'VELOCITY', label: 'Velocity Program', emoji: '🚀',
    permAp: 4, tempAp: 5,
    permAmount: 0.2, tempAmount: 0.7,
    ratingKeys: ['__velocity'], target: 'pitchers',
    availableIn: ['Fall Camp', 'Training Period'],
    blurb: 'Long-toss + weighted balls (boosts velocity).',
    velocity: true,
  },
  DEFENSIVE_DRILLS: {
    key: 'DEFENSIVE_DRILLS', label: 'Defensive Drills', emoji: '🧤',
    permAp: 2, tempAp: 3,
    permAmount: 0.5, tempAmount: 1.2,
    ratingKeys: ['fielding', 'arm'], target: 'hitters',
    availableIn: ['Fall Camp', 'Training Period', 'Spring Practice'],
    blurb: 'Fielding + arm work.',
  },
  PLATE_DISCIPLINE: {
    key: 'PLATE_DISCIPLINE', label: 'Plate Discipline', emoji: '🎯',
    permAp: 2, tempAp: 3,
    permAmount: 0.6, tempAmount: 1.4,
    ratingKeys: ['discipline'], target: 'hitters',
    availableIn: ['Fall Camp', 'Training Period', 'Spring Practice'],
    blurb: 'Pitch-tracking work in the cage.',
  },
  FILM_STUDY: {
    key: 'FILM_STUDY', label: 'Film Study', emoji: '🎥',
    permAp: 2, tempAp: 3,
    permAmount: 0.5, tempAmount: 1.2,
    ratingKeys: ['composure'], target: 'all',
    availableIn: ['any'],
    blurb: 'Mental reps. Bumps composure.',
  },
}

/**
 * Apply a weekly action to the user's roster.
 *
 * @param {import('./types.js').SaveState} state
 * @param {WeeklyActionDef} action
 * @param {'PERMANENT'|'TEMPORARY'} variant
 * @returns {{ playersAffected: number, perPlayerBump: number, kind: string }}
 */
export function applyWeeklyAction(state, action, variant) {
  const team = state.teams[state.userSchoolId]
  if (!team) return { playersAffected: 0, perPlayerBump: 0, kind: variant }
  const rng = makeRng('weekly', action.key, variant, state.calendar.year, state.calendar.week, Date.now())
  const isTemp = variant === 'TEMPORARY'
  const amount = isTemp ? action.tempAmount : action.permAmount

  const target = action.target
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

    // Velocity is a special case: only the velocity_avg field (and we bump
    // min/max in lock-step).
    if (action.velocity && p.isPitcher) {
      const bump = Math.max(0, rng.gaussian(amount, amount * 0.25))
      const newAvg = Math.min(96, (p.pitcher.velocity_avg || 84) + bump)
      const spread = (p.pitcher.velocity_max - p.pitcher.velocity_min) / 2 || 2
      p.pitcher.velocity_avg = Math.round(newAvg * 10) / 10
      p.pitcher.velocity_min = Math.round((newAvg - spread) * 10) / 10
      p.pitcher.velocity_max = Math.round((newAvg + spread) * 10) / 10
      if (isTemp) {
        state.tempBoosts.push({
          playerId: id, ratingKey: 'velocity_avg', side: 'pitcher',
          amount: bump, weeksRemaining: TEMP_WEEKS,
        })
      }
      continue
    }

    for (const key of action.ratingKeys) {
      if (typeof block[key] !== 'number') continue
      const bump = Math.max(0, rng.gaussian(amount, amount * 0.25))
      if (bump <= 0) continue
      const ceiling = side === 'pitcher'
        ? (p.hidden?.potential_pitcher?.[key] ?? 99)
        : (p.hidden?.potential_hitter?.[key] ?? 99)
      const newValue = Math.min(99, block[key] + bump)
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
  }

  // (Recent permanent bumps for the green-arrow indicator are recorded
  // inside the per-key loop above via state.permanentBumps.)

  return { playersAffected, perPlayerBump: amount, kind: variant }
}

export function isActionAvailable(action, currentPhase) {
  if (!action.availableIn || action.availableIn.includes('any')) return true
  return action.availableIn.includes(currentPhase)
}

/**
 * Has the user run any variant of this action this week?
 */
export function isActionUsedThisWeek(state, actionKey) {
  return (state.weeklyActionsUsed || []).includes(actionKey)
}

export function markActionUsedThisWeek(state, actionKey) {
  if (!state.weeklyActionsUsed) state.weeklyActionsUsed = []
  if (!state.weeklyActionsUsed.includes(actionKey)) state.weeklyActionsUsed.push(actionKey)
}
