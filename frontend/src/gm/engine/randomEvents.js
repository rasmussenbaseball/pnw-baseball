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

  // ────────────────────────────────────────────────────────────────────
  // OFF-FIELD / DISCIPLINE (continued)
  // ────────────────────────────────────────────────────────────────────
  SOCIAL_MEDIA_VIRAL: {
    id: 'SOCIAL_MEDIA_VIRAL',
    weight: 0.5,
    condition: () => true,
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      const content = rng.pick(['a hot-mic moment ripping the coaching staff', 'an inappropriate TikTok at a teammate\'s house', 'a tweet mocking a rival school', 'a leaked group-chat screenshot'])
      return {
        id: `evt_VIRAL_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'SOCIAL_MEDIA_VIRAL',
        title: 'Social Media Blew Up',
        body: `${player.firstName} ${player.lastName} just went viral for ${content}. 50K views overnight. Your inbox is full.`,
        playerId: player.id,
        choices: [
          { id: 'force-apology', label: 'Force public apology', blurb: 'Quick reset. Player resents the optics work.',
            apply: (state) => { applyPlayerMorale(player, -8); applyTeamMorale(state, +1) } },
          { id: 'team-pr', label: 'Have the team PR rep handle it', blurb: 'Professional response. Slow but clean.',
            apply: (state) => { applyJobSecurity(state, +1) } },
          { id: 'use-as-fuel', label: 'Use it as bulletin-board material', blurb: 'Rally the team around your guy.',
            apply: (state) => { applyTeamMorale(state, +4); applyPlayerMorale(player, +5) } },
        ],
      }
    },
  },

  HAZING_INCIDENT: {
    id: 'HAZING_INCIDENT',
    weight: 0.3,
    condition: () => true,
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_HAZING_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'HAZING_INCIDENT',
        title: 'Hazing Allegation',
        body: `A freshman parent called Title IX. Upperclassmen including ${player.firstName} ${player.lastName} allegedly forced rookies to drink at the team house. Compliance wants to talk.`,
        playerId: player.id,
        choices: [
          { id: 'full-cooperation', label: 'Full cooperation, suspensions across the board', blurb: 'Clean it up by the book. Hits team morale hard but you survive.',
            apply: (state) => { applyTeamMorale(state, -10); applyJobSecurity(state, +5); pushNews(state, 'Multiple players suspended after hazing investigation. Coach earns AD trust.') } },
          { id: 'internal-discipline', label: 'Handle internally, no public report', blurb: 'Risky path. If it leaks the consequences are worse.',
            apply: (state, rng) => { if (rng.chance(0.4)) { applyJobSecurity(state, -18); pushNews(state, 'Hazing cover-up exposed by an anonymous source. Compliance hammers the program.', 'AWARD', true) } } },
          { id: 'deny-deny-deny', label: 'Deny everything', blurb: 'Worst case scenario play. Coach is rolling the dice.',
            apply: (state, rng) => { if (rng.chance(0.6)) { applyJobSecurity(state, -25); pushNews(state, 'NCAA opens formal investigation into hazing denials.', 'AWARD', true) } else { applyJobSecurity(state, +3) } } },
        ],
      }
    },
  },

  ACADEMIC_DISHONESTY: {
    id: 'ACADEMIC_DISHONESTY',
    weight: 0.3,
    condition: () => true,
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_ACADEMIC_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'ACADEMIC_DISHONESTY',
        title: 'Plagiarism Caught',
        body: `${player.firstName} ${player.lastName}'s professor caught him using AI to write a 10-page paper. Academic affairs is recommending a 1-semester suspension.`,
        playerId: player.id,
        choices: [
          { id: 'fight-it', label: 'Advocate for him with academic affairs', blurb: 'Coach uses his political capital. 50/50 chance of getting it reduced.',
            apply: (state, rng) => { if (rng.chance(0.5)) { applyPlayerMorale(player, +10); pushNews(state, `Coach successfully advocated for ${player.firstName} ${player.lastName}. Academic warning only.`) } else { applyJobSecurity(state, -3); player.eligibilityStatus = 'ineligible'; pushNews(state, `${player.firstName} ${player.lastName} suspended one semester for plagiarism.`) } } },
          { id: 'accept-suspension', label: 'Accept the suspension', blurb: 'Player rides the pine all spring. Sends a message.',
            apply: (state) => { player.eligibilityStatus = 'ineligible'; applyTeamMorale(state, +1) } },
        ],
      }
    },
  },

  GAMBLING_QUESTIONING: {
    id: 'GAMBLING_QUESTIONING',
    weight: 0.2,
    condition: () => true,
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_GAMBLING_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'GAMBLING_QUESTIONING',
        title: 'NCAA Compliance Knocks',
        body: `Compliance flagged ${player.firstName} ${player.lastName} for placing DraftKings bets — including a parlay on a college baseball game (not yours). They want a sit-down interview.`,
        playerId: player.id,
        choices: [
          { id: 'lawyer-up', label: 'Get him a lawyer + cooperate', blurb: 'By the book. Probably a 6-game suspension; reputation intact.',
            apply: (state) => { applyJobSecurity(state, +2); pushNews(state, `${player.firstName} ${player.lastName} suspended 6 games per NCAA gambling rules.`) } },
          { id: 'stall', label: 'Tell him to lawyer up but stall the meeting', blurb: 'Buy him a few weeks to play. AD will hear about the foot-dragging.',
            apply: (state) => { applyJobSecurity(state, -8) } },
        ],
      }
    },
  },

  TEAM_FIGHT: {
    id: 'TEAM_FIGHT',
    weight: 0.4,
    condition: () => true,
    builder: (state, rng) => {
      const p1 = pickRandomRosterPlayer(state, rng)
      const p2 = pickRandomRosterPlayer(state, rng, p => p && p.id !== p1?.id)
      if (!p1 || !p2) return null
      return {
        id: `evt_FIGHT_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'TEAM_FIGHT',
        title: 'Clubhouse Fight',
        body: `${p1.firstName} ${p1.lastName} and ${p2.firstName} ${p2.lastName} got in a shoving match in the cage after practice. Other players had to break it up.`,
        choices: [
          { id: 'team-run', label: 'Make the whole team run', blurb: 'Old-school. Veterans grumble; tone is set.',
            apply: (state) => { applyTeamMorale(state, -3); applyTeamDurability(state, +1) } },
          { id: 'sit-down', label: 'Sit down with both privately', blurb: 'Mature handling. Both players grow up a notch.',
            apply: (state) => { applyPlayerMorale(p1, +3); applyPlayerMorale(p2, +3) } },
          { id: 'suspend-both', label: 'Suspend both one game', blurb: 'Equal punishment. Team gets the message about discipline.',
            apply: (state) => { applyTeamMorale(state, +1); applyPlayerMorale(p1, -5); applyPlayerMorale(p2, -5) } },
        ],
      }
    },
  },

  CAR_ACCIDENT: {
    id: 'CAR_ACCIDENT',
    weight: 0.25,
    condition: () => true,
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_CARACC_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'CAR_ACCIDENT',
        title: 'Player in Car Accident',
        body: `${player.firstName} ${player.lastName} was in a minor accident on the way to practice. He's okay, but his arm is sore. He could play this weekend if needed.`,
        playerId: player.id,
        choices: [
          { id: 'rest-week', label: 'Sit him a week to be safe', blurb: 'Smart move. Player appreciates the patience.',
            apply: (state) => { applyPlayerMorale(player, +5); player._minorInjuryFlag = { weeks: 1, year: state.calendar.year } } },
          { id: 'play-if-able', label: 'Play if the trainer clears him', blurb: 'Standard process. Trust the medical staff.',
            apply: () => {} },
        ],
      }
    },
  },

  // ────────────────────────────────────────────────────────────────────
  // GAME-DAY / WEATHER / FACILITIES
  // ────────────────────────────────────────────────────────────────────
  WEATHER_DOUBLEHEADER: {
    id: 'WEATHER_DOUBLEHEADER',
    weight: 0.7,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_WEATHER_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'WEATHER_DOUBLEHEADER',
      title: 'Saturday Rain in the Forecast',
      body: 'Heavy rain coming in Saturday afternoon. You can play Friday night + Saturday doubleheader, or push to Sunday and stack two games in one day.',
      choices: [
        { id: 'friday-night', label: 'Friday night + Saturday DH', blurb: 'Pitchers throw 3 games in 36 hours. Tougher on arms.',
          apply: (state) => { applyTeamDurability(state, -2) } },
        { id: 'sunday-stack', label: 'Sunday DH + Sunday game', blurb: 'Long Sunday but better recovery for arms going into next weekend.',
          apply: (state) => { applyTeamMorale(state, -1) } },
      ],
    }),
  },

  FIELD_DAMAGE: {
    id: 'FIELD_DAMAGE',
    weight: 0.3,
    condition: () => true,
    builder: (state) => ({
      id: `evt_FIELD_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'FIELD_DAMAGE',
      title: 'Field Damage Overnight',
      body: 'Vandals tore up the infield grass after Sunday\'s game. Groundskeeper needs $4K of materials to patch it before the weekend.',
      choices: [
        { id: 'pay-from-budget', label: 'Pay from operations budget', blurb: 'Quick fix. -$4K from your budget.',
          apply: (state) => { if (state.budget) state.budget.totalAthleticBudget = Math.max(0, state.budget.totalAthleticBudget - 4000) } },
        { id: 'beg-AD', label: 'Ask the AD to cover it', blurb: '70% chance AD picks it up. 30% chance they say "your problem".',
          apply: (state, rng) => { if (rng.chance(0.7)) { pushNews(state, 'AD covered the field repair bill. Coach owes a favor.') } else { applyJobSecurity(state, -2); if (state.budget) state.budget.totalAthleticBudget -= 4000 } } },
        { id: 'play-on-damaged', label: 'Play on the damaged field', blurb: 'Higher injury risk all weekend. Looks unprofessional.',
          apply: (state) => { applyTeamDurability(state, -2); applyJobSecurity(state, -3) } },
      ],
    }),
  },

  EQUIPMENT_THEFT: {
    id: 'EQUIPMENT_THEFT',
    weight: 0.25,
    condition: () => true,
    builder: (state) => ({
      id: `evt_THEFT_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'EQUIPMENT_THEFT',
      title: 'Gear Stolen from the Bus',
      body: 'Someone broke into the team bus on the road and grabbed the equipment trunk. Lost ~$8K of bats + helmets. Insurance covers half.',
      choices: [
        { id: 'file-insurance', label: 'File the insurance claim, eat the rest', blurb: 'Standard play. -$4K from equipment budget.',
          apply: (state) => { if (state.budget?.allocations) state.budget.allocations.equipment = Math.max(0, (state.budget.allocations.equipment || 0) - 4000) } },
        { id: 'fundraise', label: 'Run a quick alumni fundraiser', blurb: 'Coach personally calls boosters. 60% chance of recouping it.',
          apply: (state, rng) => { if (rng.chance(0.6)) { if (state.budget) state.budget.totalAthleticBudget += 8000; pushNews(state, 'Alumni rally to cover stolen gear. Donors energized.') } else { applyJobSecurity(state, -1) } } },
      ],
    }),
  },

  LIGHTING_FAILURE: {
    id: 'LIGHTING_FAILURE',
    weight: 0.3,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_LIGHTS_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'LIGHTING_FAILURE',
      title: 'Stadium Lights Failed',
      body: 'Half the bank of stadium lights went out for tonight\'s game. You can play through, call the game, or reschedule.',
      choices: [
        { id: 'play-through', label: 'Play through — visibility marginal', blurb: 'Higher injury risk; might lose the broadcast feed.',
          apply: (state) => { applyTeamDurability(state, -1) } },
        { id: 'call-game', label: 'Call the game — safety first', blurb: 'Reschedule as Saturday DH. Frustrating but professional.',
          apply: (state) => { applyJobSecurity(state, +1) } },
      ],
    }),
  },

  FOOD_POISONING: {
    id: 'FOOD_POISONING',
    weight: 0.25,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_FOOD_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'FOOD_POISONING',
      title: 'Half the Team has Food Poisoning',
      body: 'Pregame meal at the hotel went sideways. 12 players threw up overnight. Today\'s opener is in 4 hours.',
      choices: [
        { id: 'forfeit', label: 'Forfeit the opener', blurb: 'Counts as a loss. Trainer says it\'s the safe call.',
          apply: (state) => { applyJobSecurity(state, -2); pushNews(state, 'Team forfeited an opener after food poisoning outbreak. Tough optics.') } },
        { id: 'play-shorthanded', label: 'Play shorthanded with the healthy guys', blurb: 'Likely loss but the team learns toughness.',
          apply: (state) => { applyTeamMorale(state, +3); applyTeamDurability(state, -1) } },
        { id: 'push-for-makeup', label: 'Negotiate a makeup with the opposing AD', blurb: 'Diplomacy. 60% chance they agree.',
          apply: (state, rng) => { if (rng.chance(0.6)) { pushNews(state, 'Opposing AD agreed to reschedule after food-poisoning outbreak.') } else { applyJobSecurity(state, -1) } } },
      ],
    }),
  },

  BUS_BREAKDOWN: {
    id: 'BUS_BREAKDOWN',
    weight: 0.3,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_BUS_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'BUS_BREAKDOWN',
      title: 'Bus Broke Down on I-5',
      body: 'You\'re 4 hours into a 6-hour road trip and the bus is dead on the shoulder. Game is tomorrow at noon.',
      choices: [
        { id: 'rent-suvs', label: 'Rent SUVs and finish the drive', blurb: '-$3K, players cramped, game proceeds.',
          apply: (state) => { if (state.budget) state.budget.totalAthleticBudget = Math.max(0, state.budget.totalAthleticBudget - 3000); applyTeamDurability(state, -1) } },
        { id: 'wait-for-tow', label: 'Wait for a tow + replacement bus', blurb: 'May not make first pitch — possible forfeit risk.',
          apply: (state, rng) => { if (rng.chance(0.4)) { pushNews(state, 'Team missed first pitch — opener forfeited.'); applyJobSecurity(state, -3) } } },
      ],
    }),
  },

  HOTEL_MIXUP: {
    id: 'HOTEL_MIXUP',
    weight: 0.25,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_HOTEL_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'HOTEL_MIXUP',
      title: 'Hotel Lost Your Reservations',
      body: 'The hotel double-booked. You have 8 rooms instead of 14. Need a call now — guys are tired.',
      choices: [
        { id: 'double-up', label: 'Pack guys in 4-to-a-room', blurb: 'Cheaper. Pitchers won\'t sleep well.',
          apply: (state) => { applyTeamMorale(state, -2); applyTeamDurability(state, -1) } },
        { id: 'pay-up', label: 'Pay rack-rate at a 2nd hotel', blurb: '-$2K travel, but the team is rested.',
          apply: (state) => { if (state.budget?.allocations) state.budget.allocations.travel += 2000 } },
      ],
    }),
  },

  // ────────────────────────────────────────────────────────────────────
  // PLAYER DEVELOPMENT
  // ────────────────────────────────────────────────────────────────────
  POSITION_CHANGE_REQUEST: {
    id: 'POSITION_CHANGE_REQUEST',
    weight: 0.4,
    condition: () => true,
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng, p => p && !p.isPitcher)
      if (!player) return null
      const newPos = rng.pick(['catcher', 'shortstop', 'outfield'])
      return {
        id: `evt_POSREQ_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'POSITION_CHANGE_REQUEST',
        title: 'Player Wants a Position Change',
        body: `${player.firstName} ${player.lastName} asked to move to ${newPos}. He thinks he projects better there and wants more reps in fall ball.`,
        playerId: player.id,
        choices: [
          { id: 'allow', label: 'Allow the move', blurb: 'Player buys in. Some fielding regression near-term.',
            apply: (state) => { applyPlayerMorale(player, +8); if (player.hitter) player.hitter.fielding = Math.max(20, (player.hitter.fielding || 60) - 3) } },
          { id: 'compromise', label: 'Fall reps at the new spot, decide in spring', blurb: 'Smart middle path. Costs you nothing.',
            apply: (state) => { applyPlayerMorale(player, +4) } },
          { id: 'decline', label: 'Decline — he\'s needed where he is', blurb: 'Player resents the lack of flexibility.',
            apply: (state) => { applyPlayerMorale(player, -8) } },
        ],
      }
    },
  },

  PLAYING_TIME_COMPLAINT: {
    id: 'PLAYING_TIME_COMPLAINT',
    weight: 0.5,
    condition: (state) => isSeasonWeek(state),
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_PT_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'PLAYING_TIME_COMPLAINT',
        title: 'Player Complaining About Playing Time',
        body: `${player.firstName} ${player.lastName} is pissed about his playing time. Says he should be starting. His dad called the AD.`,
        playerId: player.id,
        choices: [
          { id: 'give-start', label: 'Give him a start this weekend', blurb: 'Player happy. Other guys notice the squeaky wheel won.',
            apply: (state) => { applyPlayerMorale(player, +12); applyTeamMorale(state, -2) } },
          { id: 'honest-talk', label: 'Honest meeting about his weaknesses', blurb: 'Mature handling. Player either grows or sulks.',
            apply: (state, rng) => { if (rng.chance(0.6)) applyPlayerMorale(player, +5); else applyPlayerMorale(player, -8) } },
          { id: 'tell-dad', label: 'Tell the dad to stay out of it', blurb: 'Send a message. Worth it long-term but bumpy short-term.',
            apply: (state) => { applyPlayerMorale(player, -5); applyJobSecurity(state, +1) } },
        ],
      }
    },
  },

  BREAKTHROUGH: {
    id: 'BREAKTHROUGH',
    weight: 0.4,
    condition: () => true,
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_BREAK_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'BREAKTHROUGH',
        title: 'A Player Just Figured It Out',
        body: `${player.firstName} ${player.lastName} has had three straight breakthrough practices. The hitting coach swears he's a different player. Promote him to a starting role?`,
        playerId: player.id,
        choices: [
          { id: 'start-him', label: 'Move him into the starting lineup', blurb: 'Reward the work. Big morale boost; small team-chemistry risk.',
            apply: (state) => { applyPlayerMorale(player, +12); applyTeamMorale(state, -1) } },
          { id: 'keep-developing', label: 'Keep him in development reps', blurb: 'Stay patient. Player keeps growing.',
            apply: (state, rng) => { if (player.hitter) { player.hitter.contact_r = Math.min(99, (player.hitter.contact_r || 50) + 2); player.hitter.contact_l = Math.min(99, (player.hitter.contact_l || 50) + 2) } if (player.pitcher) player.pitcher.stuff = Math.min(99, (player.pitcher.stuff || 50) + 2) } },
        ],
      }
    },
  },

  SLUMP: {
    id: 'SLUMP',
    weight: 0.4,
    condition: (state) => isSeasonWeek(state),
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_SLUMP_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'SLUMP',
        title: 'Starter in a Deep Slump',
        body: `${player.firstName} ${player.lastName} is 2-for-32 over his last 8 games. Confidence is shot. Vets are starting to notice.`,
        playerId: player.id,
        choices: [
          { id: 'bench-reset', label: 'Bench him a week to reset', blurb: 'Tough love. He returns hungry — or breaks fully.',
            apply: (state, rng) => { if (rng.chance(0.65)) applyPlayerMorale(player, +6); else applyPlayerMorale(player, -10) } },
          { id: 'extra-cage-work', label: 'Hitting-coach 1-on-1 work', blurb: 'Show you have his back. Slow climb back.',
            apply: (state) => { applyPlayerMorale(player, +4); if (player.hitter) { player.hitter.contact_r = Math.min(99, (player.hitter.contact_r || 50) + 1) } } },
          { id: 'just-play', label: 'Keep running him out there', blurb: 'Faith builds character — or destroys it.',
            apply: (state, rng) => { applyPlayerMorale(player, rng.chance(0.5) ? +3 : -6) } },
        ],
      }
    },
  },

  TRANSFER_THREAT: {
    id: 'TRANSFER_THREAT',
    weight: 0.4,
    condition: () => true,
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_THREAT_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'TRANSFER_THREAT',
        title: 'Player Threatening to Transfer',
        body: `${player.firstName} ${player.lastName} told his pitching coach he\'s entering the portal if things don\'t change. A bigger program has been DM\'ing him.`,
        playerId: player.id,
        choices: [
          { id: 'meet-and-promise', label: 'Sit down, promise more touches', blurb: 'Defuse for now. You may not be able to deliver.',
            apply: (state) => { applyPlayerMorale(player, +8) } },
          { id: 'call-his-bluff', label: 'Call his bluff', blurb: 'High variance. Player either grows up or leaves.',
            apply: (state, rng) => { if (rng.chance(0.5)) { applyPlayerMorale(player, -15); pushNews(state, `${player.firstName} ${player.lastName} entered the transfer portal.`) } else applyPlayerMorale(player, +4) } },
          { id: 'bump-scholarship', label: 'Bump his scholarship $1K', blurb: 'Cost: $1K out of next year\'s pool. Player feels valued.',
            apply: (state) => { applyPlayerMorale(player, +12); if (state.budget?.allocations) state.budget.allocations.scholarships = Math.max(0, (state.budget.allocations.scholarships || 0) - 1000) } },
        ],
      }
    },
  },

  CAPTAIN_VOTE: {
    id: 'CAPTAIN_VOTE',
    weight: 0.3,
    condition: (state) => isOffseasonWeek(state),
    builder: (state) => ({
      id: `evt_CAPT_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'CAPTAIN_VOTE',
      title: 'Team Captain Vote',
      body: 'Time to name captains for the upcoming season. The team\'s expecting a vote, but you can override and pick yourself.',
      choices: [
        { id: 'team-vote', label: 'Let the team vote', blurb: 'Democratic. The popular vote may not pick your best leader.',
          apply: (state) => { applyTeamMorale(state, +5) } },
        { id: 'coach-pick', label: 'You pick the captains', blurb: 'Decisive. Some guys will resent it.',
          apply: (state) => { applyTeamMorale(state, -2); applyJobSecurity(state, +1) } },
        { id: 'hybrid', label: 'Team votes from a list you approve', blurb: 'Best of both. Diplomatic, slow.',
          apply: (state) => { applyTeamMorale(state, +3) } },
      ],
    }),
  },

  WALK_ON_TRYOUT: {
    id: 'WALK_ON_TRYOUT',
    weight: 0.35,
    condition: (state) => isOffseasonWeek(state) && (state.calendar?.weekOfYear || 0) <= 13,
    builder: (state) => ({
      id: `evt_WALKON_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'WALK_ON_TRYOUT',
      title: 'Late Walk-On Tryout Request',
      body: 'A local kid who was overlooked in HS recruiting is asking for a fall tryout. His travel coach swears he\'s a sleeper. You have one open roster spot.',
      choices: [
        { id: 'give-tryout', label: 'Hold a tryout', blurb: '50/50: legit prospect or roster filler. Worth the look.',
          apply: (state, rng) => { if (rng.chance(0.5)) pushNews(state, 'Walk-on tryout landed a hidden gem. Roster strengthened.'); else pushNews(state, 'Walk-on tryout was a swing-and-miss. Spot still open.') } },
        { id: 'pass', label: 'Pass — focus on signed recruits', blurb: 'Skip the distraction.',
          apply: () => {} },
      ],
    }),
  },

  // ────────────────────────────────────────────────────────────────────
  // RECRUITING
  // ────────────────────────────────────────────────────────────────────
  TOP_RECRUIT_DECOMMIT: {
    id: 'TOP_RECRUIT_DECOMMIT',
    weight: 0.3,
    condition: (state) => isOffseasonWeek(state) && (state.calendar?.weekOfYear || 0) >= 14,
    builder: (state) => ({
      id: `evt_DECOMMIT_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'TOP_RECRUIT_DECOMMIT',
      title: 'Top Recruit on the Fence',
      body: 'Your highest-rated commit just got a late offer from a power-conference D1. He says he\'s thinking. What\'s your play?',
      choices: [
        { id: 'home-visit', label: 'Drive to his house this weekend', blurb: '-$1K recruiting, but real loyalty signal.',
          apply: (state, rng) => { if (state.budget?.allocations) state.budget.allocations.recruiting = Math.max(0, (state.budget.allocations.recruiting || 0) - 1000); if (rng.chance(0.65)) pushNews(state, 'Top commit held firm after home visit. Crisis averted.'); else { pushNews(state, 'Top commit flipped to a D1 despite the home visit. Tough loss.'); applyJobSecurity(state, -3) } } },
          { id: 'bump-scholarship', label: 'Increase his scholarship offer', blurb: 'Cost: $3K of pool. Often works.',
          apply: (state, rng) => { if (state.budget?.allocations) state.budget.allocations.scholarships = Math.max(0, state.budget.allocations.scholarships - 3000); if (rng.chance(0.75)) pushNews(state, 'Top commit signed after a scholarship bump.'); else pushNews(state, 'Top commit flipped despite the bump. $3K wasted.') } },
        { id: 'let-him-decide', label: 'Let him decide on his own', blurb: 'Don\'t chase. If he wants to leave, let him.',
          apply: (state, rng) => { if (rng.chance(0.35)) pushNews(state, 'Top commit appreciated the lack of pressure. Stayed firm.'); else { pushNews(state, 'Top commit flipped. Coach didn\'t chase, fans are mad.'); applyJobSecurity(state, -4) } } },
      ],
    }),
  },

  COMMITMENT_AT_VISIT: {
    id: 'COMMITMENT_AT_VISIT',
    weight: 0.5,
    condition: (state) => isOffseasonWeek(state) && (state.calendar?.weekOfYear || 0) >= 13,
    builder: (state) => ({
      id: `evt_VISITCOMMIT_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'COMMITMENT_AT_VISIT',
      title: 'Recruit Wants to Commit on Visit',
      body: 'A mid-tier recruit on his visit says he\'s ready to commit on the spot. He\'s a B+ prospect; you have hotter irons in the fire.',
      choices: [
        { id: 'lock-in', label: 'Lock him in now', blurb: 'Safe pick. Spend less time chasing better recruits.',
          apply: (state) => { pushNews(state, 'Mid-tier recruit locked in on official visit.') } },
        { id: 'tell-him-wait', label: 'Tell him to think it over for a week', blurb: 'Risk losing him; chase the better targets.',
          apply: (state, rng) => { if (rng.chance(0.5)) pushNews(state, 'Recruit waited. Still committed a week later.'); else pushNews(state, 'Recruit flipped to a rival school after being asked to wait.') } },
      ],
    }),
  },

  RECRUIT_INCIDENT: {
    id: 'RECRUIT_INCIDENT',
    weight: 0.25,
    condition: (state) => isOffseasonWeek(state),
    builder: (state) => ({
      id: `evt_RECINCID_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'RECRUIT_INCIDENT',
      title: 'Top Recruit Off-Field Incident',
      body: 'Your #1 verbal commit got picked up at a HS party. Local paper has it. Do you stand by him or pull the offer?',
      choices: [
        { id: 'stand-by', label: 'Stand by the commit', blurb: 'Loyalty matters in recruiting. Could backfire badly.',
          apply: (state, rng) => { if (rng.chance(0.7)) pushNews(state, 'Top commit thanked the coach for the loyalty. Bond strengthened.'); else { applyJobSecurity(state, -6); pushNews(state, 'Top commit got in MORE trouble. Coach\'s loyalty looks bad now.') } } },
        { id: 'pull-offer', label: 'Pull the offer', blurb: 'Sends a hard message about standards. Recruit network notices.',
          apply: (state) => { applyJobSecurity(state, +3); pushNews(state, 'Coach pulled scholarship from troubled commit. Standards reinforced.') } },
      ],
    }),
  },

  TRANSFER_PORTAL_GEM: {
    id: 'TRANSFER_PORTAL_GEM',
    weight: 0.45,
    condition: (state) => isOffseasonWeek(state) && (state.calendar?.weekOfYear || 0) >= 14,
    builder: (state, rng) => {
      const fromSchool = rng.pick(['a Big 12 program', 'a SEC program', 'a Pac-12 program', 'a top JUCO'])
      return {
        id: `evt_PORTAL_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'TRANSFER_PORTAL_GEM',
        title: 'Portal Gem in Play',
        body: `A former starter at ${fromSchool} just entered the portal. Buried on the depth chart there, would start for you. He wants $8K of scholarship and an in-home visit.`,
        choices: [
          { id: 'all-in', label: 'In-home visit + full $8K offer', blurb: '-$8K from scholarship pool, -$1.5K travel. 60% close rate.',
            apply: (state, rng) => { if (state.budget?.allocations) { state.budget.allocations.scholarships = Math.max(0, state.budget.allocations.scholarships - 8000); state.budget.allocations.travel = (state.budget.allocations.travel || 0) + 1500 } if (rng.chance(0.6)) pushNews(state, 'Portal gem signed. Coach\'s pitch worked.'); else pushNews(state, 'Portal gem went elsewhere. $1.5K travel wasted.') } },
          { id: 'phone-only', label: 'Phone-only recruitment, lower offer', blurb: 'Cheap try. 25% close rate.',
            apply: (state, rng) => { if (rng.chance(0.25)) pushNews(state, 'Portal gem accepted the smaller deal. Steal of an offseason.'); else pushNews(state, 'Portal gem passed on the cheap offer.') } },
          { id: 'pass', label: 'Pass — too expensive', blurb: 'Stay disciplined with the budget.',
            apply: () => {} },
        ],
      }
    },
  },

  // ────────────────────────────────────────────────────────────────────
  // BOOSTER / MONEY / NIL
  // ────────────────────────────────────────────────────────────────────
  BIG_DONATION: {
    id: 'BIG_DONATION',
    weight: 0.3,
    condition: () => true,
    builder: (state, rng) => {
      const amount = rng.pick([20000, 35000, 75000])
      return {
        id: `evt_DONATION_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'BIG_DONATION',
        title: 'Unrestricted Donation',
        body: `An alum just wrote a check for $${(amount/1000).toFixed(0)}K with no strings. They want a tour of the facilities and a photo with the team. How do you handle the visit?`,
        choices: [
          { id: 'full-tour', label: 'Personal full tour + team meet', blurb: 'Boosters love the personal touch. Future donations more likely.',
            apply: (state) => { if (state.budget) state.budget.totalAthleticBudget += amount; applyJobSecurity(state, +3) } },
          { id: 'assistant-tour', label: 'Have your DOO handle it', blurb: 'Save your time. Donor might feel unappreciated.',
            apply: (state, rng) => { if (state.budget) state.budget.totalAthleticBudget += amount; if (rng.chance(0.3)) { pushNews(state, 'Donor complained about being passed off. AD noted.'); applyJobSecurity(state, -2) } } },
        ],
      }
    },
  },

  NIL_DEAL_OFFER: {
    id: 'NIL_DEAL_OFFER',
    weight: 0.3,
    condition: (state) => {
      const school = state.schools?.[state.userSchoolId]
      return school?.level === 'D1'   // NIL is realistically D1-only
    },
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      const amount = rng.pick([5000, 15000, 40000])
      return {
        id: `evt_NIL_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'NIL_DEAL_OFFER',
        title: 'NIL Collective Reached Out',
        body: `Boosters offering ${player.firstName} ${player.lastName} a $${(amount/1000).toFixed(0)}K NIL deal — but they want public team appearances at fundraisers. Time commitment is real.`,
        playerId: player.id,
        choices: [
          { id: 'approve', label: 'Approve the deal', blurb: 'Player happy + alumni engaged. Practice time hit.',
            apply: (state) => { applyPlayerMorale(player, +12); applyTeamMorale(state, +2); applyTeamDurability(state, -1) } },
          { id: 'negotiate-down', label: 'Negotiate fewer appearances', blurb: 'Coach gets in the middle. Looks meddlesome.',
            apply: (state) => { applyPlayerMorale(player, +6); applyJobSecurity(state, -1) } },
          { id: 'block-deal', label: 'Block — too distracting', blurb: 'Player is furious. NCAA limits what you can do anyway.',
            apply: (state) => { applyPlayerMorale(player, -15); applyJobSecurity(state, -2) } },
        ],
      }
    },
  },

  FACILITY_UPGRADE_OFFER: {
    id: 'FACILITY_UPGRADE_OFFER',
    weight: 0.2,
    condition: (state) => isOffseasonWeek(state),
    builder: (state) => ({
      id: `evt_FACUP_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'FACILITY_UPGRADE_OFFER',
      title: 'Indoor Facility Grant',
      body: 'A booster will fund a new indoor hitting facility ($150K) if you commit to a 2-year contract extension. AD likes the idea; you\'d be locked in.',
      choices: [
        { id: 'sign-extension', label: 'Sign the 2-year extension', blurb: '+Facility upgrade, +long-term job security. Can\'t leave for 2 years even if a D1 calls.',
          apply: (state) => { applyJobSecurity(state, +15); if (state.budget) state.budget.totalAthleticBudget += 30000; state._facilityExtension = { years: 2, year: state.calendar.year } } },
        { id: 'decline-keep-options', label: 'Decline — preserve options', blurb: 'No upgrade. Free to take offers next offseason.',
          apply: () => {} },
      ],
    }),
  },

  TICKET_REVENUE_BUMP: {
    id: 'TICKET_REVENUE_BUMP',
    weight: 0.3,
    condition: (state) => isSeasonWeek(state),
    builder: (state, rng) => {
      const amount = rng.pick([3000, 8000, 15000])
      return {
        id: `evt_TICKET_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'TICKET_REVENUE_BUMP',
        title: 'Surprise Ticket Surge',
        body: `Last weekend\'s rivalry series drew double the expected attendance. AD wants to know — reinvest the $${(amount/1000).toFixed(0)}K in the program or roll it to next year?`,
        choices: [
          { id: 'reinvest-now', label: 'Reinvest now in equipment', blurb: '+Equipment quality, mid-season bump.',
            apply: (state) => { if (state.budget?.allocations) state.budget.allocations.equipment += amount } },
          { id: 'reinvest-recruiting', label: 'Push it into recruiting', blurb: '+Recruiting budget, more AP next month.',
            apply: (state) => { if (state.budget?.allocations) state.budget.allocations.recruiting += amount } },
          { id: 'save-it', label: 'Save for next year\'s budget', blurb: 'Conservative. Rolls over to next year.',
            apply: (state) => { if (state.budget) state.budget.totalAthleticBudget += amount } },
        ],
      }
    },
  },

  // ────────────────────────────────────────────────────────────────────
  // STAFF / FAMILY / PERSONAL
  // ────────────────────────────────────────────────────────────────────
  ASSISTANT_POACHED: {
    id: 'ASSISTANT_POACHED',
    weight: 0.4,
    condition: (state) => {
      const team = state.teams?.[state.userSchoolId]
      return (team?.assistantCoachIds?.length || 0) > 0
    },
    builder: (state, rng) => {
      const team = state.teams?.[state.userSchoolId]
      const assistants = (team.assistantCoachIds || []).map(id => state.coaches?.[id]).filter(c => c && !c.isUser)
      if (assistants.length === 0) return null
      const assistant = rng.pick(assistants)
      return {
        id: `evt_ASSTOFFER_${assistant.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'ASSISTANT_POACHED',
        title: 'Your Assistant Got an Offer',
        body: `${assistant.firstName} ${assistant.lastName} got a higher-paying offer at a D1. They\'d stay for a $10K raise. What do you do?`,
        choices: [
          { id: 'match-raise', label: 'Match the raise — $10K out of your budget', blurb: 'Keep your guy. Costs from coaching salary line.',
            apply: (state) => { if (state.budget?.allocations) state.budget.allocations.coachingSalaries = (state.budget.allocations.coachingSalaries || 0) + 10000; if (assistant) assistant.salary = (assistant.salary || 50000) + 10000 } },
          { id: 'wish-well', label: 'Let them go — wish them well', blurb: 'Save the money. Now you need a hire mid-year.',
            apply: (state) => { team.assistantCoachIds = team.assistantCoachIds.filter(id => id !== assistant.id); delete state.coaches[assistant.id]; pushNews(state, `${assistant.firstName} ${assistant.lastName} left for a D1 job. Need a replacement.`) } },
          { id: 'promote-internal', label: 'Promote a GA to take their spot', blurb: 'Cheap solution. Quality of staff dips short-term.',
            apply: (state) => { team.assistantCoachIds = team.assistantCoachIds.filter(id => id !== assistant.id); delete state.coaches[assistant.id]; applyJobSecurity(state, -1); pushNews(state, 'Coach promoted internally to fill assistant vacancy.') } },
        ],
      }
    },
  },

  FAMILY_EMERGENCY: {
    id: 'FAMILY_EMERGENCY',
    weight: 0.2,
    condition: () => true,
    builder: (state, rng) => {
      const team = state.teams?.[state.userSchoolId]
      const assistants = (team?.assistantCoachIds || []).map(id => state.coaches?.[id]).filter(c => c && !c.isUser)
      if (assistants.length === 0) return null
      const assistant = rng.pick(assistants)
      return {
        id: `evt_FAMILY_${assistant.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'FAMILY_EMERGENCY',
        title: 'Assistant Coach Family Emergency',
        body: `${assistant.firstName} ${assistant.lastName}\'s mother is in the ICU. They need 2 weeks off, mid-season.`,
        choices: [
          { id: 'paid-leave', label: 'Paid leave, no questions', blurb: 'Right thing to do. Team morale boost.',
            apply: (state) => { applyTeamMorale(state, +3) } },
          { id: 'unpaid', label: 'Unpaid leave — by the book', blurb: 'Frugal. Coach will resent it.',
            apply: (state) => { applyTeamMorale(state, -3); applyJobSecurity(state, -2) } },
        ],
      }
    },
  },

  YOUR_HEALTH: {
    id: 'YOUR_HEALTH',
    weight: 0.15,
    condition: () => true,
    builder: (state) => ({
      id: `evt_HEALTH_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'YOUR_HEALTH',
      title: 'You Need Medical Attention',
      body: 'Your back went out at practice. Doctor wants 3 weeks of rest, including no game-day pacing. The team can run without you, but optics matter.',
      choices: [
        { id: 'take-rest', label: 'Follow doctor\'s orders, miss 3 weeks', blurb: 'Smart long-term. Assistant runs games.',
          apply: (state) => { applyJobSecurity(state, -2); pushNews(state, 'Coach taking a 3-week medical leave. Bench coach takes over.') } },
        { id: 'push-through', label: 'Push through — small risk', blurb: 'Optics great. Real risk of long-term injury.',
          apply: (state, rng) => { if (rng.chance(0.3)) { applyJobSecurity(state, -8); pushNews(state, 'Coach collapsed at practice. Now out 8 weeks instead of 3.') } } },
      ],
    }),
  },

  // ────────────────────────────────────────────────────────────────────
  // MEDIA / COMMUNITY
  // ────────────────────────────────────────────────────────────────────
  LOCAL_PODCAST_INVITE: {
    id: 'LOCAL_PODCAST_INVITE',
    weight: 0.4,
    condition: () => true,
    builder: (state) => ({
      id: `evt_PODCAST_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'LOCAL_PODCAST_INVITE',
      title: 'Local Baseball Podcast Invite',
      body: 'A popular regional baseball podcast wants you on as a guest for a 60-min sit-down. Format is loose; they\'re known for digging into rival coaches.',
      choices: [
        { id: 'go-on', label: 'Accept, talk shop honestly', blurb: 'Recruiting boost — high schoolers listen.',
          apply: (state) => { applyJobSecurity(state, +2); if (state.budget?.allocations) state.budget.allocations.recruiting += 1000; pushNews(state, 'Coach\'s podcast appearance got positive buzz. Recruiting bump.') } },
        { id: 'decline-politely', label: 'Decline — too risky', blurb: 'Safe. Boring.',
          apply: () => {} },
        { id: 'go-on-bash-rival', label: 'Accept and take shots at rival programs', blurb: 'Big risk. Big reward — or big consequences.',
          apply: (state, rng) => { if (rng.chance(0.4)) { applyJobSecurity(state, +5); pushNews(state, 'Coach\'s rival-bashing podcast went viral. Fan favorite.') } else { applyJobSecurity(state, -6); pushNews(state, 'Coach\'s rival comments backfired. AD furious.') } } },
      ],
    }),
  },

  CHARITY_REQUEST: {
    id: 'CHARITY_REQUEST',
    weight: 0.4,
    condition: () => true,
    builder: (state) => ({
      id: `evt_CHARITY_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'CHARITY_REQUEST',
      title: 'Charity Tournament Request',
      body: 'Local youth baseball charity wants the team to volunteer for a Saturday tournament. Costs you a Saturday practice; gets you community goodwill.',
      choices: [
        { id: 'volunteer', label: 'Volunteer the team', blurb: 'Lost practice = small skill cost. Big morale + community win.',
          apply: (state) => { applyTeamMorale(state, +5); applyJobSecurity(state, +2) } },
        { id: 'offer-coaches-only', label: 'Send coaches, not players', blurb: 'Half-measure. Less goodwill, no practice lost.',
          apply: (state) => { applyJobSecurity(state, +1) } },
        { id: 'decline', label: 'Decline — busy schedule', blurb: 'Saves practice time. Charity board notes it.',
          apply: (state) => { applyJobSecurity(state, -1) } },
      ],
    }),
  },

  FAN_COMPLAINT: {
    id: 'FAN_COMPLAINT',
    weight: 0.3,
    condition: () => true,
    builder: (state) => ({
      id: `evt_FAN_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'FAN_COMPLAINT',
      title: 'Season Ticket Holder Wrote a Letter',
      body: 'A 30-year season-ticket holder wrote the AD a 3-page letter complaining about your in-game decisions. The AD forwarded it to you with no comment.',
      choices: [
        { id: 'call-fan', label: 'Call him personally', blurb: 'Disarming. Fan becomes a defender.',
          apply: (state) => { applyJobSecurity(state, +2) } },
        { id: 'invite-meeting', label: 'Invite him to a coaches\' meeting', blurb: 'Shows transparency. Fan tells everyone he was treated like a VIP.',
          apply: (state) => { applyJobSecurity(state, +4) } },
        { id: 'ignore', label: 'Ignore — fans complain', blurb: 'Save the time. Fan will write more letters.',
          apply: (state) => { applyJobSecurity(state, -1) } },
      ],
    }),
  },

  PARENT_COMPLAINT: {
    id: 'PARENT_COMPLAINT',
    weight: 0.4,
    condition: (state) => isSeasonWeek(state),
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_PARENT_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'PARENT_COMPLAINT',
        title: 'Parent in Your Inbox',
        body: `${player.firstName} ${player.lastName}\'s dad wrote a multi-page email complaining about pitch counts. He CC\'d the AD and the trainer.`,
        playerId: player.id,
        choices: [
          { id: 'professional-response', label: 'Send a professional, data-backed reply', blurb: 'Slow but bulletproof. Sets a precedent.',
            apply: (state) => { applyJobSecurity(state, +2) } },
          { id: 'phone-call', label: 'Call the dad directly', blurb: 'Disarms quicker. Might get heated.',
            apply: (state, rng) => { if (rng.chance(0.6)) applyJobSecurity(state, +3); else { applyJobSecurity(state, -3); pushNews(state, 'Parent recorded the phone call and shared it. Embarrassing for the program.') } } },
          { id: 'ad-handles', label: 'Let the AD handle it', blurb: 'Pass the buck. AD doesn\'t love it.',
            apply: (state) => { applyJobSecurity(state, -2) } },
        ],
      }
    },
  },

  // ────────────────────────────────────────────────────────────────────
  // POST-SEASON RIDE / MOMENTUM
  // ────────────────────────────────────────────────────────────────────
  WALK_OFF_CELEBRATION: {
    id: 'WALK_OFF_CELEBRATION',
    weight: 0.4,
    condition: (state) => {
      if (!isSeasonWeek(state)) return false
      const team = state.teams?.[state.userSchoolId]
      const games = (team?.wins || 0) + (team?.losses || 0)
      return games >= 10 && (team.wins / Math.max(1, games)) >= 0.55
    },
    builder: (state) => ({
      id: `evt_WALKOFF_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'WALK_OFF_CELEBRATION',
      title: 'Players Want a Bus Sing-Along',
      body: 'After a walk-off win, the team wants to skip the cooldown and crank music for the bus ride home. Captains say it\'ll set the tone for the playoff run.',
      choices: [
        { id: 'let-them-sing', label: 'Let them celebrate', blurb: 'Vibe is everything. Big morale boost.',
          apply: (state) => { applyTeamMorale(state, +6) } },
        { id: 'cooldown-first', label: 'Cooldown first, then celebrate', blurb: 'Best of both. Veteran move.',
          apply: (state) => { applyTeamMorale(state, +3) } },
        { id: 'keep-routine', label: 'Stick to routine, no music', blurb: 'Discipline. Captains will lobby harder next time.',
          apply: (state) => { applyTeamMorale(state, -2) } },
      ],
    }),
  },

  RIVALRY_TRASH_TALK: {
    id: 'RIVALRY_TRASH_TALK',
    weight: 0.35,
    condition: (state) => isSeasonWeek(state),
    builder: (state, rng) => {
      const rival = rng.pick(['the conference rival\'s HC', 'the cross-state coach', 'a former assistant who left for another program'])
      return {
        id: `evt_RIVAL_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'RIVALRY_TRASH_TALK',
        title: 'Rival Coach Took a Shot at You',
        body: `${rival} talked about your program in his postgame presser — implied your recruiting tactics are sketchy. Phone is blowing up.`,
        choices: [
          { id: 'public-clapback', label: 'Public clap-back', blurb: 'Energize the team and base. Risk of pettiness perception.',
            apply: (state) => { applyTeamMorale(state, +5); applyJobSecurity(state, +1) } },
          { id: 'silent-treatment', label: 'No comment — let it go', blurb: 'Take the high road. Quiet wins.',
            apply: (state) => { applyJobSecurity(state, +2) } },
          { id: 'private-call', label: 'Call him privately and have it out', blurb: 'Old-school. Either resolves or escalates.',
            apply: (state, rng) => { if (rng.chance(0.5)) applyJobSecurity(state, +1); else applyJobSecurity(state, -3) } },
        ],
      }
    },
  },

  CLINIC_INVITATION: {
    id: 'CLINIC_INVITATION',
    weight: 0.3,
    condition: (state) => isOffseasonWeek(state),
    builder: (state) => ({
      id: `evt_CLINIC_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'CLINIC_INVITATION',
      title: 'Invited to Speak at Coaching Clinic',
      body: 'A regional coaches\' clinic wants you as a keynote speaker. Pays $2K, raises your profile, costs you a weekend with the team.',
      choices: [
        { id: 'accept', label: 'Accept the keynote', blurb: '+Visibility, +$2K, future job offers more likely.',
          apply: (state) => { if (state.budget) state.budget.totalAthleticBudget += 2000; applyJobSecurity(state, +2) } },
        { id: 'decline', label: 'Decline — focus on team', blurb: 'Boring but safe.',
          apply: () => {} },
      ],
    }),
  },

  PROFESSIONAL_DEVELOPMENT: {
    id: 'PROFESSIONAL_DEVELOPMENT',
    weight: 0.25,
    condition: (state) => isOffseasonWeek(state),
    builder: (state) => ({
      id: `evt_PROFDEV_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'PROFESSIONAL_DEVELOPMENT',
      title: 'Sabermetrics Conference Invite',
      body: 'A 3-day data + analytics conference is offering you a comp pass. You\'d miss a weekend of practice but pick up some new tools.',
      choices: [
        { id: 'attend', label: 'Attend the conference', blurb: '+1 to your tactician rating over time. Lost practice time.',
          apply: (state) => {
            const team = state.teams?.[state.userSchoolId]
            const user = state.coaches?.[team?.headCoachId] || Object.values(state.coaches || {}).find(c => c?.isUser)
            if (user) user.tactician = Math.min(99, (user.tactician || 60) + 1)
          },
        },
        { id: 'send-assistant', label: 'Send your bench coach', blurb: 'Cheap delegation. Less personal upside.',
          apply: () => {} },
        { id: 'pass', label: 'Pass — stick with practice', blurb: 'Old-school. Practice is everything.',
          apply: () => {} },
      ],
    }),
  },

  // ────────────────────────────────────────────────────────────────────
  // NCAA / CONFERENCE / BIG-PICTURE
  // ────────────────────────────────────────────────────────────────────
  CONFERENCE_REALIGNMENT_RUMOR: {
    id: 'CONFERENCE_REALIGNMENT_RUMOR',
    weight: 0.15,
    condition: (state) => isOffseasonWeek(state),
    builder: (state) => ({
      id: `evt_REALIGN_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'CONFERENCE_REALIGNMENT_RUMOR',
      title: 'Conference Realignment Rumors',
      body: 'Insider report says your conference is exploring adding 2 teams + a championship game. AD wants your input.',
      choices: [
        { id: 'support', label: 'Publicly support realignment', blurb: 'AD appreciates the team-player attitude.',
          apply: (state) => { applyJobSecurity(state, +3) } },
        { id: 'oppose', label: 'Oppose — current alignment is good', blurb: 'AD frustrated but baseball traditionalists love it.',
          apply: (state) => { applyJobSecurity(state, -3) } },
        { id: 'no-comment', label: 'No public comment', blurb: 'Politically safe.',
          apply: () => {} },
      ],
    }),
  },

  NCAA_RULE_CHANGE: {
    id: 'NCAA_RULE_CHANGE',
    weight: 0.15,
    condition: () => true,
    builder: (state) => ({
      id: `evt_RULE_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'NCAA_RULE_CHANGE',
      title: 'New NCAA Rule Drops',
      body: 'NCAA announced a new pitch-clock + shift restriction policy mid-season. Some teams are scrambling to adjust; others are pretending it doesn\'t exist.',
      choices: [
        { id: 'all-in', label: 'Restructure practices to adapt fast', blurb: 'Painful short-term, advantage long-term.',
          apply: (state) => { applyTeamMorale(state, -2); applyJobSecurity(state, +4) } },
        { id: 'wait-see', label: 'Wait and see how others adapt', blurb: 'Conservative. Late mover sometimes wins.',
          apply: () => {} },
      ],
    }),
  },

  SCHOLARSHIP_BOOST: {
    id: 'SCHOLARSHIP_BOOST',
    weight: 0.2,
    condition: (state) => isOffseasonWeek(state),
    builder: (state) => {
      const school = state.schools?.[state.userSchoolId]
      const noScholar = school?.level === 'D3' || school?.level === 'NWAC'
      if (noScholar) return null   // D3/NWAC have no scholarships, irrelevant
      return {
        id: `evt_SCHOL_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'SCHOLARSHIP_BOOST',
        title: 'Compliance Approved Extra Scholarship',
        body: 'A late academic-progress bonus from the registrar adds $5K to your scholarship pool this year only. Use it now or save it for next year?',
        choices: [
          { id: 'use-now', label: 'Use it on the current portal class', blurb: '+$5K scholarship pool right now.',
            apply: (state) => { if (state.budget?.allocations) state.budget.allocations.scholarships += 5000 } },
          { id: 'save', label: 'Save for next year\'s class', blurb: 'Conservative. Bigger play later.',
            apply: (state) => { if (state.budget) state.budget.totalAthleticBudget += 5000 } },
        ],
      }
    },
  },

  // ────────────────────────────────────────────────────────────────────
  // QUIRKY / FLAVOR
  // ────────────────────────────────────────────────────────────────────
  MASCOT_INCIDENT: {
    id: 'MASCOT_INCIDENT',
    weight: 0.2,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_MASCOT_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'MASCOT_INCIDENT',
      title: 'Mascot Got in a Fight with Rival Mascot',
      body: 'Pre-game, your mascot got physical with the opposing mascot. Conference is asking what you knew.',
      choices: [
        { id: 'fine', label: 'Fine the mascot, public apology', blurb: 'Standard professional response.',
          apply: (state) => { applyJobSecurity(state, +1) } },
        { id: 'lean-in', label: 'Embrace it — sell merch', blurb: 'Fan favorite move. Conference fines you instead.',
          apply: (state) => { if (state.budget) state.budget.totalAthleticBudget -= 2000; applyTeamMorale(state, +3) } },
      ],
    }),
  },

  TWITTER_DRAMA: {
    id: 'TWITTER_DRAMA',
    weight: 0.3,
    condition: () => true,
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_TWITTER_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'TWITTER_DRAMA',
        title: 'Player Subtweeting a Teammate',
        body: `${player.firstName} ${player.lastName} has been cryptically subtweeting another player. The locker room knows who. Tension is rising.`,
        playerId: player.id,
        choices: [
          { id: 'meeting', label: 'Force a team meeting', blurb: 'Air it out. Public reset.',
            apply: (state) => { applyTeamMorale(state, +2) } },
          { id: 'ban-social', label: 'Ban team-related social media posting', blurb: 'Heavy-handed. Cuts the drama and the personality.',
            apply: (state) => { applyTeamMorale(state, -3); applyJobSecurity(state, +1) } },
          { id: 'ignore', label: 'Ignore it — they\'ll work it out', blurb: 'Sometimes works. Sometimes festers.',
            apply: (state, rng) => { if (rng.chance(0.5)) applyTeamMorale(state, -4) } },
        ],
      }
    },
  },

  ALUMNI_GAME: {
    id: 'ALUMNI_GAME',
    weight: 0.3,
    condition: (state) => isOffseasonWeek(state) && (state.calendar?.weekOfYear || 0) >= 14,
    builder: (state) => ({
      id: `evt_ALUM_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'ALUMNI_GAME',
      title: 'Alumni Want a Spring Game',
      body: 'Former players want to come back for an alumni vs current team scrimmage in March. Fun, but takes a Saturday practice slot.',
      choices: [
        { id: 'host', label: 'Host the alumni game', blurb: 'Boosters and former players love it. Practice slot lost.',
          apply: (state) => { applyJobSecurity(state, +3); if (state.budget) state.budget.totalAthleticBudget += 4000 } },
        { id: 'decline', label: 'Decline — too much disruption', blurb: 'Alumni network will note this.',
          apply: (state) => { applyJobSecurity(state, -2) } },
      ],
    }),
  },

  TV_INTERVIEW_REQUEST: {
    id: 'TV_INTERVIEW_REQUEST',
    weight: 0.3,
    condition: () => true,
    builder: (state) => ({
      id: `evt_TV_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'TV_INTERVIEW_REQUEST',
      title: 'Regional TV Wants You',
      body: 'A regional sports-TV outlet wants a 5-minute sit-down on game day. Could be a recruiting tool. Could be a distraction.',
      choices: [
        { id: 'do-it', label: 'Do the interview', blurb: '+Visibility. Costs nothing if you stay disciplined.',
          apply: (state) => { applyJobSecurity(state, +2) } },
        { id: 'defer-postgame', label: 'Only postgame, never pre', blurb: 'Smart routine protection.',
          apply: (state) => { applyJobSecurity(state, +1) } },
        { id: 'decline', label: 'Decline entirely', blurb: 'Lost recruiting touch. Sometimes the right call.',
          apply: () => {} },
      ],
    }),
  },

  EQUIPMENT_SPONSORSHIP: {
    id: 'EQUIPMENT_SPONSORSHIP',
    weight: 0.25,
    condition: (state) => isOffseasonWeek(state),
    builder: (state, rng) => {
      const brand = rng.pick(['Rawlings', 'Marucci', 'Easton', 'Wilson'])
      return {
        id: `evt_SPONSOR_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'EQUIPMENT_SPONSORSHIP',
        title: 'Bat Brand Wants a Deal',
        body: `${brand} is offering a free-bat deal for the season in exchange for an exclusive equipment contract. Your players currently use a mix.`,
        choices: [
          { id: 'sign-exclusive', label: 'Sign the exclusive deal', blurb: 'Free bats all year (-$8K equipment cost). Some players unhappy with brand switch.',
            apply: (state) => { if (state.budget?.allocations) state.budget.allocations.equipment = Math.max(0, state.budget.allocations.equipment - 8000); applyTeamMorale(state, -2) } },
          { id: 'decline-exclusive', label: 'Decline — let players pick', blurb: 'Player flexibility. No free gear.',
            apply: (state) => { applyTeamMorale(state, +2) } },
        ],
      }
    },
  },
}

const EVENT_TEMPLATE_KEYS = Object.keys(EVENT_CATALOG)

// ─── Event firing ──────────────────────────────────────────────────────────

/**
 * Per-week chance an event fires. Story mode only; regular dynasties
 * stay clean.
 *
 * Spring season is BUSIEST (game-day drama is the heart of the story).
 * Postseason is intense but short. Offseason simmers with recruiting,
 * booster, and assistant-coach storylines.
 *
 * Calibration target: roughly 1 event every 1-2 in-season weeks, 1 every
 * 2-3 offseason weeks, at least one event in every postseason run.
 */
const FIRE_RATE_BY_MODE = {
  SEASON:    0.55,
  POSTSEASON: 0.45,
  OFFSEASON: 0.35,
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
 * Snapshot the state values that story-mode events most commonly touch.
 * Used to compute a before/after delta so the OutcomeModal can show the
 * user a clear "this is what your choice did" summary, instead of
 * relying on each apply() to construct a description manually.
 */
function snapshotEventState(state) {
  const team = state.teams?.[state.userSchoolId]
  let teamHappiness = 0
  let count = 0
  if (team) {
    for (const pid of (team.rosterPlayerIds || [])) {
      const p = state.players?.[pid]
      if (p?.happiness?.value != null) { teamHappiness += p.happiness.value; count++ }
    }
  }
  return {
    jobSecurity: state.budget?.jobSecurity ?? 50,
    totalBudget: state.budget?.totalAthleticBudget ?? 0,
    scholarships: state.budget?.allocations?.scholarships ?? 0,
    recruiting: state.budget?.allocations?.recruiting ?? 0,
    travel: state.budget?.allocations?.travel ?? 0,
    rosterSize: team?.rosterPlayerIds?.length ?? 0,
    teamHappinessAvg: count > 0 ? teamHappiness / count : 0,
    newsLen: state.newsfeed?.length ?? 0,
  }
}

function fmtMoney(n) {
  const abs = Math.abs(n)
  if (abs >= 1000) return `$${(abs / 1000).toFixed(abs >= 10_000 ? 0 : 1)}K`
  return `$${abs}`
}

/**
 * Diff a before/after snapshot into a user-friendly effects array. Each
 * entry is { kind, delta, label } — kind drives the icon/color, delta is
 * raw numeric change, label is the prebuilt human string.
 */
function buildEffectsFromDelta(before, after) {
  const out = []
  if (after.jobSecurity !== before.jobSecurity) {
    const d = after.jobSecurity - before.jobSecurity
    out.push({ kind: 'JOB_SECURITY', delta: d, label: `Job security ${d > 0 ? '+' : ''}${d}` })
  }
  if (after.totalBudget !== before.totalBudget) {
    const d = after.totalBudget - before.totalBudget
    out.push({ kind: 'BUDGET', delta: d, label: `Athletic budget ${d > 0 ? '+' : '−'}${fmtMoney(d)}` })
  }
  if (after.scholarships !== before.scholarships) {
    const d = after.scholarships - before.scholarships
    out.push({ kind: 'SCHOLARSHIPS', delta: d, label: `Scholarship pool ${d > 0 ? '+' : '−'}${fmtMoney(d)}` })
  }
  if (after.recruiting !== before.recruiting) {
    const d = after.recruiting - before.recruiting
    out.push({ kind: 'RECRUITING', delta: d, label: `Recruiting budget ${d > 0 ? '+' : '−'}${fmtMoney(d)}` })
  }
  if (after.travel !== before.travel) {
    const d = after.travel - before.travel
    out.push({ kind: 'TRAVEL', delta: d, label: `Travel budget ${d > 0 ? '+' : '−'}${fmtMoney(d)}` })
  }
  if (after.rosterSize !== before.rosterSize) {
    const d = after.rosterSize - before.rosterSize
    out.push({
      kind: 'ROSTER', delta: d,
      label: d > 0 ? `Added ${d} player${d === 1 ? '' : 's'} to the roster`
                   : `Lost ${Math.abs(d)} player${Math.abs(d) === 1 ? '' : 's'} from the roster`,
    })
  }
  const happDelta = after.teamHappinessAvg - before.teamHappinessAvg
  if (Math.abs(happDelta) >= 0.5) {
    const d = happDelta
    out.push({ kind: 'TEAM_HAPPINESS', delta: d, label: `Team happiness ${d > 0 ? '+' : ''}${d.toFixed(1)}` })
  }
  return out
}

/**
 * Resolve the currently-pending event by choice id. Looks up the choice on
 * the template's catalog entry (choices are statically defined on the
 * builder output, but apply() refs were stored there) and runs it.
 *
 * After the apply() mutates state, we diff a state snapshot to derive a
 * user-friendly effects list and stamp it onto state._lastEventOutcome.
 * The Dashboard's EventOutcomeModal reads that and shows the user a
 * clear "this is what your choice did" popup, so the chain is:
 *   PendingEvent modal → click choice → resolveEvent → Outcome modal.
 */
export function resolveEvent(state, choiceId) {
  const pending = state.pendingEvent
  if (!pending) return { ok: false, error: 'No pending event.' }
  const choice = (pending.choices || []).find(c => c.id === choiceId)
  if (!choice) return { ok: false, error: 'Choice not found.' }
  const rng = makeRng('eventResolve', pending.id, state.rngSeed || 1)

  // Snapshot state before applying the choice — we'll diff after.
  const before = snapshotEventState(state)
  try {
    choice.apply(state, rng)
  } catch (err) {
    console.warn('Event apply threw:', err)
  }
  const after = snapshotEventState(state)
  const effects = buildEffectsFromDelta(before, after)
  // Any newsfeed entries the apply() pushed are flavor lines for the
  // outcome popup. Capture them in order so the user sees the same
  // narrative the apply() recorded.
  const newNewsLines = []
  const addedCount = after.newsLen - before.newsLen
  if (addedCount > 0) {
    for (let i = 0; i < Math.min(addedCount, 4); i++) {
      const entry = state.newsfeed?.[i]
      if (entry?.headline) newNewsLines.push(entry.headline)
    }
  }

  // Stamp the outcome onto state so the UI can pop a clear results modal.
  state._lastEventOutcome = {
    templateId: pending.templateId,
    eventTitle: pending.title,
    choiceLabel: choice.label,
    effects,
    narrative: newNewsLines,
    year: state.calendar?.year,
    week: state.calendar?.weekOfYear,
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
    effects,
  })
  state.eventHistory = state.eventHistory.slice(0, 50)
  state.pendingEvent = null
  return { ok: true }
}
