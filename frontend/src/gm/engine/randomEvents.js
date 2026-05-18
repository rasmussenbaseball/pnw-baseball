/**
 * Random events — popup-driven story moments that interrupt the user's
 * weekly advance with a decision. Each event is a template:
 *   - condition: returns true if it COULD fire this week.
 *   - builder:   produces the user-facing card (title, body, choices).
 *   - choices:   each has an `apply(state, rng)` mutator + a blurb.
 *
 * Pacing:
 *   - Story mode is the only mode that triggers these (Regular dynasty
 *     stays clean — no surprise popups).
 *   - One event has a chance to fire each week. The rate is tuned per
 *     phase: regular season ~15%, postseason 5%, offseason 8%.
 *   - The same event can't fire twice in a row (cooldown tracked).
 *
 * State shape (added):
 *   state.pendingEvent     — { id, templateId, title, body, choices } or null
 *   state.eventHistory     — { templateId, year, weekOfYear, choiceId, result }[]
 *   state.eventCooldown    — { lastFiredWeek, recentTemplateIds }
 *
 * Resolution:
 *   The UI surfaces state.pendingEvent as a modal. User clicks a choice;
 *   resolveEvent() runs the matching apply() and clears the pending slot.
 */

import { makeRng } from './rng'

// ─── Helpers reusable by event apply()s ────────────────────────────────────

function applyJobSecurity(state, delta) {
  if (!state.budget) return
  state.budget.jobSecurity = Math.max(0, Math.min(100, (state.budget.jobSecurity || 50) + delta))
}

function applyTeamMorale(state, delta) {
  // Bump every roster player's happiness by `delta`. Bound 0-100.
  const team = state.teams?.[state.userSchoolId]
  if (!team) return
  for (const pid of team.rosterPlayerIds || []) {
    const p = state.players?.[pid]
    if (!p || !p.happiness) continue
    const next = Math.max(0, Math.min(100, (p.happiness.value || 65) + delta))
    p.happiness.value = next
  }
}

function applyPlayerMorale(player, delta) {
  if (!player || !player.happiness) return
  player.happiness.value = Math.max(0, Math.min(100, (player.happiness.value || 65) + delta))
}

function applyTeamDurability(state, delta) {
  // Apply small durability bump/cut across the roster. Useful when a sweep
  // celebration costs you on the back end.
  const team = state.teams?.[state.userSchoolId]
  if (!team) return
  for (const pid of team.rosterPlayerIds || []) {
    const p = state.players?.[pid]
    if (!p) continue
    if (p.isPitcher && p.pitcher) {
      p.pitcher.durability = Math.max(20, Math.min(99, (p.pitcher.durability || 60) + delta))
    } else if (p.hitter) {
      p.hitter.durability = Math.max(20, Math.min(99, (p.hitter.durability || 60) + delta))
    }
  }
}

function pushNews(state, headline, type = 'AWARD', big = false) {
  state.newsfeed?.unshift({
    id: `evt_${state.calendar?.year}_${state.calendar?.weekOfYear}_${Math.random().toString(36).slice(2, 6)}`,
    year: state.calendar?.year, week: state.calendar?.week, type, big, headline,
    payload: {},
  })
}

function pickRandomRosterPlayer(state, rng, predicate) {
  const team = state.teams?.[state.userSchoolId]
  if (!team) return null
  const pool = (team.rosterPlayerIds || [])
    .map(id => state.players?.[id])
    .filter(p => p && (!predicate || predicate(p)))
  if (pool.length === 0) return null
  return rng.pick(pool)
}

function isSeasonWeek(state) {
  return state.calendar?.mode === 'SEASON' &&
    (state.calendar?.weekOfYear || 0) >= 27 &&
    (state.calendar?.weekOfYear || 0) <= 39
}

function isOffseasonWeek(state) {
  return state.calendar?.mode === 'OFFSEASON'
}

// ─── Event catalog ─────────────────────────────────────────────────────────

export const EVENT_CATALOG = {
  // ── Off-field discipline ────────────────────────────────────────────
  PLAYER_INCIDENT: {
    id: 'PLAYER_INCIDENT',
    weight: 1.0,
    condition: () => true,
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      const offense = rng.pick([
        'arrested late Friday night for an MIP', 'caught at a party with underage drinkers',
        'failed a random drug test', 'got in a public altercation downtown',
      ])
      return {
        id: `evt_PLAYER_INCIDENT_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'PLAYER_INCIDENT',
        title: 'Off-Field Incident',
        body: `${player.firstName} ${player.lastName} was ${offense}. The story is on its way to the local paper. How do you handle it?`,
        playerId: player.id,
        choices: [
          {
            id: 'suspend-three',
            label: 'Suspend three games',
            blurb: 'Hard discipline. Veterans appreciate it; the player resents you.',
            apply: (state) => {
              applyPlayerMorale(player, -12)
              applyTeamMorale(state, +2)
              pushNews(state, `${player.firstName} ${player.lastName} suspended 3 games for an off-field incident.`)
              player.suspended = { weeks: 3, year: state.calendar.year }
            },
          },
          {
            id: 'private-warning',
            label: 'Private warning, no public action',
            blurb: 'Player stays available. Risk: media finds out anyway.',
            apply: (state, rng) => {
              applyPlayerMorale(player, +4)
              applyTeamMorale(state, -3)
              if (rng.chance(0.35)) {
                pushNews(state, `Local paper broke the cover-up of ${player.firstName} ${player.lastName}'s off-field incident. AD furious.`)
                applyJobSecurity(state, -10)
              }
            },
          },
          {
            id: 'kick-off-team',
            label: 'Cut him from the roster',
            blurb: 'Extreme. Sets a hard line. Team is shaken.',
            apply: (state) => {
              const team = state.teams[state.userSchoolId]
              team.rosterPlayerIds = (team.rosterPlayerIds || []).filter(id => id !== player.id)
              player.eligibilityStatus = 'dismissed'
              applyTeamMorale(state, -6)
              pushNews(state, `${player.firstName} ${player.lastName} dismissed from the team. Coach says: 'Our standards are non-negotiable.'`, 'AWARD', true)
              applyJobSecurity(state, +3)
            },
          },
        ],
      }
    },
  },

  // ── Travel disruption ────────────────────────────────────────────────
  PLANE_DELAYED: {
    id: 'PLANE_DELAYED',
    weight: 0.6,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_PLANE_DELAYED_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'PLANE_DELAYED',
      title: 'Flight Delayed 8 Hours',
      body: 'Weather grounded your flight to this weekend\'s series. Team is stuck at the airport. The opposing AD wants to know your call.',
      choices: [
        {
          id: 'play-anyway',
          label: 'Push through — play tired',
          blurb: 'Sleep-deprived team for Game 1. -2 durability all week; chance of in-game injury bump.',
          apply: (state) => {
            applyTeamDurability(state, -2)
            applyTeamMorale(state, -3)
            pushNews(state, 'Team played through an 8-hour travel delay. Heads down, grind through it.')
          },
        },
        {
          id: 'reschedule',
          label: 'Reschedule Game 1, play DH Saturday',
          blurb: 'Easier on bodies but doubleheader fatigue is real. Travel cost ticks up.',
          apply: (state) => {
            applyTeamMorale(state, +2)
            if (state.budget?.allocations) {
              state.budget.allocations.travel = (state.budget.allocations.travel || 0) + 3000
            }
            pushNews(state, 'Pushed Game 1 of road series to a Saturday DH. Extra travel cost absorbed.')
          },
        },
      ],
    }),
  },

  // ── Opponent cancels midweek ─────────────────────────────────────────
  OPPONENT_CANCELS: {
    id: 'OPPONENT_CANCELS',
    weight: 0.6,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_OPPONENT_CANCELS_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'OPPONENT_CANCELS',
      title: 'Midweek Opponent Cancels',
      body: 'Tomorrow\'s midweek opponent just called — their AD cancelled. You can scramble for a sub, lock in a closed intrasquad, or just give the guys a day.',
      choices: [
        {
          id: 'pickup-game',
          label: 'Find a pickup opponent',
          blurb: 'Hustle. Lock in a JUCO scrimmage. Team gets a tune-up but you eat the travel cost.',
          apply: (state) => {
            if (state.budget?.allocations) {
              state.budget.allocations.travel = (state.budget.allocations.travel || 0) + 2000
            }
            applyTeamMorale(state, +2)
            pushNews(state, 'Picked up a midweek scrimmage on short notice. Coach\'s hustle is noticed.')
          },
        },
        {
          id: 'intrasquad',
          label: 'Closed intrasquad scrimmage',
          blurb: 'Quiet day. Borderline reps but no spotlight.',
          apply: (state) => {
            applyTeamMorale(state, +1)
          },
        },
        {
          id: 'day-off',
          label: 'Give the team the day off',
          blurb: 'Players love it. The grinders on the staff hate it.',
          apply: (state) => {
            applyTeamMorale(state, +5)
            applyJobSecurity(state, -2)
          },
        },
      ],
    }),
  },

  // ── Optional midweek invite ──────────────────────────────────────────
  MIDWEEK_INVITE: {
    id: 'MIDWEEK_INVITE',
    weight: 0.6,
    condition: (state) => isSeasonWeek(state),
    builder: (state, rng) => {
      const opponentName = rng.pick(['George Fox', 'Concordia', 'Linfield', 'Pacific Lutheran', 'Saint Martin\'s', 'Whitworth'])
      return {
        id: `evt_MIDWEEK_INVITE_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'MIDWEEK_INVITE',
        title: 'Midweek Game Invite',
        body: `${opponentName} called — they have an open Tuesday and want to add a midweek with us. Extra reps in front of fans, but a tired roster going into the weekend series.`,
        choices: [
          {
            id: 'accept-midweek',
            label: 'Accept — add the midweek',
            blurb: 'Extra at-bats + innings. Slight durability hit going into the weekend.',
            apply: (state) => {
              applyTeamDurability(state, -1)
              applyTeamMorale(state, +1)
              pushNews(state, `Added a midweek game vs ${opponentName}. Bullpen will be thin Friday.`)
            },
          },
          {
            id: 'decline-midweek',
            label: 'Decline — rest is more important',
            blurb: 'Keep the legs fresh for conference weekend.',
            apply: () => {},
          },
        ],
      }
    },
  },

  // ── Star injured ─────────────────────────────────────────────────────
  STAR_INJURED: {
    id: 'STAR_INJURED',
    weight: 0.7,
    condition: (state) => isSeasonWeek(state),
    builder: (state, rng) => {
      // Pick the highest-OVR player on the team as the "star".
      const team = state.teams?.[state.userSchoolId]
      if (!team) return null
      const players = (team.rosterPlayerIds || []).map(id => state.players?.[id]).filter(Boolean)
      if (players.length === 0) return null
      const star = players.sort((a, b) => {
        const ovrA = a.isPitcher ? (a.pitcher?.stuff || 0) : (a.hitter?.contact_r || 0)
        const ovrB = b.isPitcher ? (b.pitcher?.stuff || 0) : (b.hitter?.contact_r || 0)
        return ovrB - ovrA
      })[0]
      return {
        id: `evt_STAR_INJURED_${star.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'STAR_INJURED',
        title: 'Your Star Just Tweaked Something',
        body: `${star.firstName} ${star.lastName} felt a pull in pregame and the trainer wants an MRI. Three local reporters already asking. How do you frame it?`,
        playerId: star.id,
        choices: [
          {
            id: 'shutdown',
            label: 'Shut him down — protect the player',
            blurb: 'Pull him for 2-3 weeks. Long-term thinking. Player loves you.',
            apply: (state) => {
              star._minorInjuryFlag = { weeks: 3, year: state.calendar.year }
              applyPlayerMorale(star, +8)
              applyTeamMorale(state, +1)
              pushNews(state, `${star.firstName} ${star.lastName} shut down 2-3 weeks as a precaution. 'Player health first,' coach says.`)
            },
          },
          {
            id: 'play-through',
            label: 'Push him to play through it',
            blurb: 'Star plays this weekend. Real risk of a worse injury. Win-now move.',
            apply: (state, rng) => {
              if (rng.chance(0.40)) {
                star._minorInjuryFlag = { weeks: 6, year: state.calendar.year }
                pushNews(state, `${star.firstName} ${star.lastName} aggravated the injury in Game 1 — out 6 weeks. Coach faces backlash.`, 'INJURY', true)
                applyPlayerMorale(star, -15)
                applyTeamMorale(state, -5)
                applyJobSecurity(state, -8)
              } else {
                pushNews(state, `${star.firstName} ${star.lastName} gutted through. Looked rusty but stayed on the field.`)
                applyPlayerMorale(star, -3)
              }
            },
          },
          {
            id: 'public-uncertain',
            label: 'Day-to-day publicly, evaluate Friday',
            blurb: 'Buy yourself time. Maximum optionality.',
            apply: (state) => {
              applyPlayerMorale(star, +1)
              pushNews(state, `${star.firstName} ${star.lastName} listed as day-to-day. Coach: 'We\'ll see how he warms up.'`)
            },
          },
        ],
      }
    },
  },

  // ── Sweep aftermath: cancel early lift? ──────────────────────────────
  SWEEP_LIFT_DECISION: {
    id: 'SWEEP_LIFT_DECISION',
    weight: 0.5,
    condition: (state) => {
      // Only fires when the team is on a hot streak — proxy: 4+ wins in
      // the last week of games or a sweep flag from sim. Cheap heuristic:
      // win% > 0.65 in the season so far.
      if (!isSeasonWeek(state)) return false
      const team = state.teams?.[state.userSchoolId]
      const games = (team?.wins || 0) + (team?.losses || 0)
      if (games < 6) return false
      return (team.wins / games) > 0.62
    },
    builder: (state) => ({
      id: `evt_SWEEP_LIFT_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'SWEEP_LIFT_DECISION',
      title: 'Sweep Sunday — Cancel Tomorrow\'s 6am Lift?',
      body: 'Team just swept the weekend. Captains are floating the idea of cancelling the Monday 6am lift to celebrate. Your call.',
      choices: [
        {
          id: 'cancel-lift',
          label: 'Cancel the lift — let them breathe',
          blurb: 'Team loves you. Small durability dip from the missed work.',
          apply: (state) => {
            applyTeamMorale(state, +6)
            applyTeamDurability(state, -1)
          },
        },
        {
          id: 'keep-lift',
          label: 'Lift goes on as scheduled',
          blurb: 'The grinders nod. The guys who hate 6am don\'t.',
          apply: (state) => {
            applyTeamMorale(state, -2)
            applyTeamDurability(state, +1)
          },
        },
        {
          id: 'lift-but-late',
          label: 'Move lift to 10am — compromise',
          blurb: 'Best of both worlds. Minor positive.',
          apply: (state) => {
            applyTeamMorale(state, +3)
          },
        },
      ],
    }),
  },

  // ── Booster wants to fund something ──────────────────────────────────
  BOOSTER_OFFER: {
    id: 'BOOSTER_OFFER',
    weight: 0.4,
    condition: (state) => isOffseasonWeek(state),
    builder: (state, rng) => {
      const amount = rng.pick([15000, 25000, 50000])
      const project = rng.pick(['a new batting cage', 'an indoor turf upgrade', 'recruiting visit budget', 'travel-meal upgrade'])
      return {
        id: `evt_BOOSTER_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'BOOSTER_OFFER',
        title: 'Booster With Strings',
        body: `A local booster is offering $${(amount/1000).toFixed(0)}K toward ${project} — but they want their son added to the program as a walk-on next year. He's nowhere near the talent bar.`,
        choices: [
          {
            id: 'accept-strings',
            label: 'Accept the money + the kid',
            blurb: 'Easy program upgrade. AD approves. Vets will resent the favoritism.',
            apply: (state) => {
              if (state.budget) state.budget.totalAthleticBudget += amount
              applyTeamMorale(state, -4)
              applyJobSecurity(state, +2)
            },
          },
          {
            id: 'decline-politely',
            label: 'Decline — politely',
            blurb: 'Sticking to standards. Booster takes their money elsewhere.',
            apply: (state) => {
              applyTeamMorale(state, +2)
              applyJobSecurity(state, -1)
            },
          },
          {
            id: 'counter-no-roster',
            label: 'Take the money — kid gets a manager role, not a roster spot',
            blurb: 'Smart middle ground. Booster grumbles but agrees.',
            apply: (state) => {
              if (state.budget) state.budget.totalAthleticBudget += Math.round(amount * 0.5)
              applyTeamMorale(state, +1)
            },
          },
        ],
      }
    },
  },

  // ── Recruit visit drama ──────────────────────────────────────────────
  RECRUIT_VISIT_ISSUE: {
    id: 'RECRUIT_VISIT_ISSUE',
    weight: 0.5,
    condition: (state) => isOffseasonWeek(state) && (state.calendar?.weekOfYear || 0) >= 14,
    builder: (state, rng) => {
      const recruitName = rng.pick(['the top arm', 'a top-25 outfielder', 'a switch-hitting middle infielder'])
      return {
        id: `evt_RECRUIT_VISIT_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'RECRUIT_VISIT_ISSUE',
        title: 'Recruit Visit Issue',
        body: `${recruitName} just texted that his planned official visit conflicts with his AAU showcase. He's asking to reschedule, or for you to fly out to watch him play instead.`,
        choices: [
          {
            id: 'fly-out',
            label: 'Fly out to the showcase',
            blurb: 'Costs the program. Shows commitment. AP +5 toward this recruit, recruiting budget -$4K.',
            apply: (state) => {
              if (state.budget?.allocations) {
                state.budget.allocations.recruiting = Math.max(0, (state.budget.allocations.recruiting || 0) - 4000)
              }
              pushNews(state, `Flew out to scout a top recruit personally. Real impression made.`)
            },
          },
          {
            id: 'reschedule',
            label: 'Reschedule his visit',
            blurb: 'Standard play. Small risk he drifts to another program.',
            apply: () => {},
          },
          {
            id: 'pass',
            label: 'Pass — too much hassle, pursue someone else',
            blurb: 'Save the resources for a sure thing.',
            apply: (state) => {
              applyJobSecurity(state, -1)
            },
          },
        ],
      }
    },
  },

  // ── Player calls coach out publicly ──────────────────────────────────
  PLAYER_PUBLIC_CRITICISM: {
    id: 'PLAYER_PUBLIC_CRITICISM',
    weight: 0.3,
    condition: (state) => isSeasonWeek(state),
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_CRITICISM_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'PLAYER_PUBLIC_CRITICISM',
        title: 'Player Vented to a Reporter',
        body: `${player.firstName} ${player.lastName} ripped your in-game decisions on a podcast that just dropped. The locker room is reading it.`,
        playerId: player.id,
        choices: [
          {
            id: 'public-firm',
            label: 'Address it publicly — firm',
            blurb: 'Reassert leadership. Player resents you but team falls in line.',
            apply: (state) => {
              applyPlayerMorale(player, -10)
              applyTeamMorale(state, +2)
            },
          },
          {
            id: 'closed-door',
            label: 'Closed-door meeting, no public response',
            blurb: 'Defuse quietly. Player respects the discretion.',
            apply: (state) => {
              applyPlayerMorale(player, +4)
              applyTeamMorale(state, +1)
            },
          },
          {
            id: 'ignore',
            label: 'Ignore it entirely',
            blurb: 'Risky. Team chemistry takes a hit.',
            apply: (state) => {
              applyTeamMorale(state, -4)
            },
          },
        ],
      }
    },
  },

  // ── AD pulls you into a meeting ──────────────────────────────────────
  AD_MEETING: {
    id: 'AD_MEETING',
    weight: 0.4,
    condition: (state) => {
      const js = state.budget?.jobSecurity ?? 50
      return js < 35   // only fires when you're already on the AD's radar
    },
    builder: (state) => ({
      id: `evt_AD_MEETING_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'AD_MEETING',
      title: 'AD Wants a Meeting',
      body: 'The AD asked you to swing by their office Thursday. Word is they want a "state of the program" check-in. Your job security has been slipping.',
      choices: [
        {
          id: 'multi-year-pitch',
          label: 'Pitch the multi-year plan',
          blurb: 'Show the long view. AD respects the prep. Small JS boost.',
          apply: (state) => {
            applyJobSecurity(state, +6)
          },
        },
        {
          id: 'win-or-die',
          label: 'Promise immediate results',
          blurb: 'Risky — sets a hard short-term standard. Higher upside if you deliver.',
          apply: (state) => {
            applyJobSecurity(state, +3)
            state._winOrDiePromise = { year: state.calendar.year }
          },
        },
        {
          id: 'request-resources',
          label: 'Ask for more budget',
          blurb: 'AD respects the candor — sometimes. Other times they bristle.',
          apply: (state, rng) => {
            if (rng.chance(0.5)) {
              if (state.budget) state.budget.totalAthleticBudget += 15000
              pushNews(state, 'AD approved a $15K budget bump after a good meeting.')
            } else {
              applyJobSecurity(state, -3)
              pushNews(state, 'AD didn\'t love the ask for more money. Notes were taken.')
            }
          },
        },
      ],
    }),
  },
}

const EVENT_TEMPLATE_KEYS = Object.keys(EVENT_CATALOG)

// ─── Event firing ──────────────────────────────────────────────────────────

/**
 * Per-week chance an event fires. Story mode only; regular dynasties
 * stay clean.
 */
const FIRE_RATE_BY_MODE = {
  SEASON:    0.18,
  POSTSEASON: 0.06,
  OFFSEASON: 0.10,
}

/**
 * Roll for a random event this week. Returns true if one was queued.
 * The pending event is stored on state.pendingEvent — the UI surfaces it
 * as a modal and the user resolves it via resolveEvent().
 */
export function maybeFireRandomEvent(state) {
  if (!state.career || !state.career.enabled) return false
  if (state.pendingEvent) return false   // already one queued
  const mode = state.calendar?.mode || 'OFFSEASON'
  const rate = FIRE_RATE_BY_MODE[mode] ?? 0.1
  const rng = makeRng('randomEvent', state.calendar?.year, state.calendar?.weekOfYear, state.rngSeed || 1)
  if (rng.next() > rate) return false

  // Filter to templates whose condition matches + that aren't on cooldown.
  state.eventCooldown = state.eventCooldown || { recentTemplateIds: [] }
  const cooldown = new Set(state.eventCooldown.recentTemplateIds || [])
  const candidates = EVENT_TEMPLATE_KEYS
    .map(k => EVENT_CATALOG[k])
    .filter(t => !cooldown.has(t.id) && (t.condition ? t.condition(state) : true))
  if (candidates.length === 0) return false

  // Weighted random pick
  const totalWeight = candidates.reduce((s, t) => s + (t.weight || 1), 0)
  let pick = null
  let roll = rng.next() * totalWeight
  for (const t of candidates) {
    roll -= (t.weight || 1)
    if (roll <= 0) { pick = t; break }
  }
  if (!pick) pick = candidates[0]

  let card
  try {
    card = pick.builder(state, rng)
  } catch (err) {
    console.warn('Event builder threw:', err)
    return false
  }
  if (!card) return false

  state.pendingEvent = card
  state.eventCooldown.recentTemplateIds = [pick.id, ...(state.eventCooldown.recentTemplateIds || [])].slice(0, 3)
  return true
}

/**
 * Resolve the currently-pending event by choice id. Looks up the choice on
 * the template's catalog entry (choices are statically defined on the
 * builder output, but apply() refs were stored there) and runs it.
 */
export function resolveEvent(state, choiceId) {
  const pending = state.pendingEvent
  if (!pending) return { ok: false, error: 'No pending event.' }
  const choice = (pending.choices || []).find(c => c.id === choiceId)
  if (!choice) return { ok: false, error: 'Choice not found.' }
  const rng = makeRng('eventResolve', pending.id, state.rngSeed || 1)
  try {
    choice.apply(state, rng)
  } catch (err) {
    console.warn('Event apply threw:', err)
  }
  // Log to history
  state.eventHistory = state.eventHistory || []
  state.eventHistory.unshift({
    templateId: pending.templateId,
    year: state.calendar?.year,
    weekOfYear: state.calendar?.weekOfYear,
    title: pending.title,
    choiceId,
    choiceLabel: choice.label,
  })
  state.eventHistory = state.eventHistory.slice(0, 50)
  state.pendingEvent = null
  return { ok: true }
}
