/**
 * Weekly team-wide actions the head coach can spend AP on outside of
 * recruiting individual players. Each has an AP cost, an availability
 * window (offseason phase), and a side effect applied to the roster.
 *
 * Effects are small per-player nudges. The point is choice — you can max
 * one attribute, balance broadly, or save AP for recruiting.
 */

import { makeRng } from './rng'

/**
 * @typedef {Object} ActionEffect
 * @property {string[]} [boost]      - rating keys to bump (small)
 * @property {number} [boostAmount]  - how much (typical 0.4-1.0)
 * @property {number} [boostChance]  - per-player probability (0-1)
 * @property {string[]} [target]     - which player groups: 'hitters' | 'pitchers' | 'all'
 * @property {number} [injuryRisk]   - 0-1 small bump
 * @property {number} [chemistry]    - team chemistry shift (-1 to +1)
 * @property {number} [recoveryDays] - cuts fatigue / boosts durability
 */

/**
 * @typedef {Object} WeeklyAction
 * @property {string} key
 * @property {string} label
 * @property {string} emoji
 * @property {number} apCost
 * @property {string} blurb
 * @property {string[]} availableIn  - calendar phase keys (or 'any')
 * @property {ActionEffect} effect
 */

/** @type {Record<string, WeeklyAction>} */
export const WEEKLY_ACTIONS = {
  RECOVERY_DAY: {
    key: 'RECOVERY_DAY',
    label: 'Recovery Day',
    emoji: '🛌',
    apCost: 2,
    blurb: 'Light practice + treatment. Reduces injury risk and boosts durability.',
    availableIn: ['any'],
    effect: { target: ['all'], boost: ['durability'], boostAmount: 0.6, boostChance: 0.5 },
  },
  HARD_PRACTICE: {
    key: 'HARD_PRACTICE',
    label: 'Hard Practice',
    emoji: '💪',
    apCost: 3,
    blurb: 'High-intensity workout. Boosts ratings broadly; small injury risk.',
    availableIn: ['Fall Camp', 'Training Period', 'Spring Practice'],
    effect: {
      target: ['all'],
      boost: ['contact_l', 'contact_r', 'power_l', 'power_r', 'fielding', 'arm', 'stuff', 'control', 'stamina'],
      boostAmount: 0.4, boostChance: 0.3,
      injuryRisk: 0.05,
    },
  },
  TEAM_DINNER: {
    key: 'TEAM_DINNER',
    label: 'Team Dinner',
    emoji: '🍽',
    apCost: 1,
    blurb: 'Cheap chemistry builder. Small boost to clutch + composure.',
    availableIn: ['any'],
    effect: { target: ['all'], boost: ['composure'], boostAmount: 0.5, boostChance: 0.4, chemistry: 0.5 },
  },
  SPEED_CAMP: {
    key: 'SPEED_CAMP',
    label: 'Speed Camp',
    emoji: '⚡',
    apCost: 3,
    blurb: 'Sprint drills + baserunning. Boosts speed for hitters.',
    availableIn: ['Fall Camp', 'Training Period', 'Spring Practice'],
    effect: { target: ['hitters'], boost: ['speed'], boostAmount: 0.9, boostChance: 0.5 },
  },
  POWER_WORKOUT: {
    key: 'POWER_WORKOUT',
    label: 'Power Workout',
    emoji: '🏋️',
    apCost: 3,
    blurb: 'Weight room emphasis. Boosts power for hitters.',
    availableIn: ['Fall Camp', 'Training Period', 'Spring Practice'],
    effect: { target: ['hitters'], boost: ['power_l', 'power_r'], boostAmount: 0.8, boostChance: 0.5 },
  },
  HR_DERBY: {
    key: 'HR_DERBY',
    label: 'HR Derby',
    emoji: '💥',
    apCost: 2,
    blurb: 'Fun competition. Reps tracking power + a little chemistry.',
    availableIn: ['Summer', 'Fall Camp', 'Training Period', 'Spring Practice'],
    effect: { target: ['hitters'], boost: ['power_l', 'power_r'], boostAmount: 0.5, boostChance: 0.4, chemistry: 0.3 },
  },
  BULLPEN_SESSIONS: {
    key: 'BULLPEN_SESSIONS',
    label: 'Bullpen Sessions',
    emoji: '⚾',
    apCost: 3,
    blurb: 'Pitching coach drills. Boosts stuff + control.',
    availableIn: ['Fall Camp', 'Training Period', 'Spring Practice'],
    effect: { target: ['pitchers'], boost: ['stuff', 'control'], boostAmount: 0.6, boostChance: 0.5 },
  },
  VELOCITY_PROGRAM: {
    key: 'VELOCITY_PROGRAM',
    label: 'Velocity Program',
    emoji: '🚀',
    apCost: 4,
    blurb: 'Long-toss + weighted balls. Bumps pitcher velocity (small).',
    availableIn: ['Fall Camp', 'Training Period'],
    effect: { target: ['pitchers'], velocityBump: 0.2, boostChance: 0.4 },
  },
  DEFENSIVE_DRILLS: {
    key: 'DEFENSIVE_DRILLS',
    label: 'Defensive Drills',
    emoji: '🧤',
    apCost: 2,
    blurb: 'Fielding + arm work. Tightens range and accuracy.',
    availableIn: ['Fall Camp', 'Training Period', 'Spring Practice'],
    effect: { target: ['hitters'], boost: ['fielding', 'arm'], boostAmount: 0.6, boostChance: 0.5 },
  },
  PLATE_DISCIPLINE: {
    key: 'PLATE_DISCIPLINE',
    label: 'Plate Discipline',
    emoji: '🎯',
    apCost: 2,
    blurb: 'Pitch-tracking work in the cage. Boosts discipline.',
    availableIn: ['Fall Camp', 'Training Period', 'Spring Practice'],
    effect: { target: ['hitters'], boost: ['discipline'], boostAmount: 0.7, boostChance: 0.5 },
  },
  FILM_STUDY: {
    key: 'FILM_STUDY',
    label: 'Film Study',
    emoji: '🎥',
    apCost: 2,
    blurb: 'Mental reps. Boosts composure across the team.',
    availableIn: ['any'],
    effect: { target: ['all'], boost: ['composure'], boostAmount: 0.6, boostChance: 0.4 },
  },
}

/**
 * Apply a weekly action's effect to the user's roster.
 *
 * @param {import('./types.js').SaveState} state
 * @param {WeeklyAction} action
 * @returns {{ playersAffected: number, totalBumps: number, injuries: number }}
 */
export function applyWeeklyAction(state, action) {
  const team = state.teams[state.userSchoolId]
  if (!team) return { playersAffected: 0, totalBumps: 0, injuries: 0 }
  const rng = makeRng('weekly', action.key, state.calendar.year, state.calendar.week, Date.now())
  const eff = action.effect
  const target = eff.target || ['all']
  const includeHit = target.includes('all') || target.includes('hitters')
  const includePit = target.includes('all') || target.includes('pitchers')

  let playersAffected = 0
  let totalBumps = 0
  let injuries = 0

  for (const id of team.rosterPlayerIds) {
    const p = state.players[id]
    if (!p) continue
    const matchesGroup = (includeHit && p.isHitter) || (includePit && p.isPitcher)
    if (!matchesGroup) continue

    // Probability-gate per player
    if (!rng.chance(eff.boostChance ?? 0.5)) continue
    playersAffected++

    // Apply rating boosts
    if (eff.boost && eff.boostAmount) {
      const block = (includePit && p.isPitcher) ? p.pitcher : p.hitter
      const ceiling = (includePit && p.isPitcher && p.hidden?.potential_pitcher) || p.hidden?.potential_hitter || {}
      for (const key of eff.boost) {
        if (typeof block[key] !== 'number') continue
        const cap = ceiling[key] ?? 99
        const bump = rng.gaussian(eff.boostAmount, 0.3)
        if (bump <= 0) continue
        const next = Math.min(cap, block[key] + bump)
        block[key] = Math.round(next * 10) / 10
        totalBumps += bump
      }
    }

    // Velocity bump (pitchers only)
    if (eff.velocityBump && p.isPitcher && typeof p.pitcher.velocity_avg === 'number') {
      const bump = eff.velocityBump * (0.5 + rng.gaussian(1, 0.3))
      const newAvg = Math.min(96, p.pitcher.velocity_avg + Math.max(0, bump))
      const spread = (p.pitcher.velocity_max - p.pitcher.velocity_min) / 2
      p.pitcher.velocity_avg = Math.round(newAvg * 10) / 10
      p.pitcher.velocity_min = Math.round((newAvg - spread) * 10) / 10
      p.pitcher.velocity_max = Math.round((newAvg + spread) * 10) / 10
    }

    // Injury risk
    if (eff.injuryRisk && rng.chance(eff.injuryRisk)) {
      injuries++
      // Lightweight: just nudge durability down a hair
      if (typeof p.pitcher?.durability === 'number') p.pitcher.durability = Math.max(20, p.pitcher.durability - 1)
    }
  }

  // Team-level chemistry tracked loosely
  if (eff.chemistry) {
    state.teamChemistry = Math.max(-10, Math.min(10, (state.teamChemistry || 0) + eff.chemistry))
  }

  return { playersAffected, totalBumps: Math.round(totalBumps * 10) / 10, injuries }
}

/**
 * Whether the given action is available in the current calendar phase.
 */
export function isActionAvailable(action, calendar, currentPhase) {
  if (!action.availableIn || action.availableIn.includes('any')) return true
  return action.availableIn.includes(currentPhase)
}
