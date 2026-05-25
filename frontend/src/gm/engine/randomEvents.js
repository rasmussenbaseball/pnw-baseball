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
import { playerOverall } from './playerRating'

// ─── Level + level-fit helpers ─────────────────────────────────────────────
// Used by event conditions to gate events that don't make sense at a level.
// E.g. NWAC teams don't fly (bus-only per Nate), so PLANE_DELAYED and
// CHARTER_FLIGHT_OFFER should never fire for an NWAC user.

function isNwacUser(state) { return state.level === 'NWAC' }
function isD1User(state) { return state.level === 'D1' }
function isFourYearUser(state) {
  return ['D1', 'D2', 'D3', 'NAIA'].includes(state.level)
}
/** Programs that realistically charter flights. NWAC + D3 + small NAIA = bus. */
function isFlyingProgram(state) {
  return state.level === 'D1' || state.level === 'D2'
}
/** Format a player for popup bodies — name + class year + position + OVR. */
function playerLabel(player) {
  if (!player) return 'Unknown player'
  const ovr = Math.round(playerOverall(player) || 50)
  const yr = player.classYear || 'FR'
  const pos = player.primaryPosition || 'OF'
  return `${player.firstName} ${player.lastName} (${yr} ${pos}, ${ovr} OVR)`
}

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

/**
 * Pick the top N best players on the user's roster by OVR. Used by
 * events that should affect "captains" / "best players" specifically —
 * e.g. the paintball outing where the BEST players (the captains who
 * pushed for it) are most disappointed when it's denied. Returns named
 * players so the outcome modal can surface a specific "Captain Smith
 * happiness -8" line rather than a generic team-wide morale tick.
 */
function topNRosterPlayers(state, n, predicate) {
  const team = state.teams?.[state.userSchoolId]
  if (!team) return []
  const roster = (team.rosterPlayerIds || [])
    .map(id => state.players?.[id])
    .filter(p => p && (!predicate || predicate(p)))
  roster.sort((a, b) => (playerOverall(b) || 0) - (playerOverall(a) || 0))
  return roster.slice(0, n)
}

/**
 * Apply a happiness delta to each of the user's top-N best players AND
 * push a named outcome line per player to the newsfeed (so the outcome
 * modal shows "Captain X happiness -8" instead of a generic team-wide
 * average shift). `reason` is the short flavor phrase that fills the
 * outcome line.
 */
function applyCaptainMorale(state, delta, reason, n = 3, predicate) {
  const captains = topNRosterPlayers(state, n, predicate)
  if (captains.length === 0) return
  const sign = delta > 0 ? '+' : ''
  for (const c of captains) {
    applyPlayerMorale(c, delta)
    pushNews(state, `${c.firstName} ${c.lastName} (${c.classYear} ${c.primaryPosition}, ${Math.round(playerOverall(c))} OVR) happiness ${sign}${delta} — ${reason}.`)
  }
}

/**
 * Pick a real SIGNED recruit (status='signed', signedTo === userSchoolId)
 * from state.recruits. Used by events like "Signed Recruit Tore His ACL"
 * that need to reference an actual person the coach has committed to —
 * not a randomly invented name. Returns null if there are no signed
 * recruits yet (e.g. early in the offseason before commits roll in).
 */
function pickSignedRecruit(state, rng, predicate) {
  const userId = state.userSchoolId
  const signed = Object.values(state.recruits || {})
    .filter(r => r && r.status === 'signed' && r.signedTo === userId)
    .filter(r => !predicate || predicate(r))
  if (signed.length === 0) return null
  return rng.pick(signed)
}

/**
 * Pick a recruit the user has a LIVE OFFER on (status='active',
 * liveOffer.schoolId === userSchoolId). Used by events like
 * "Top Recruit on the Fence" + "Top Commit Off-Field Incident"
 * that should fire ONLY when the user has open offers in play.
 */
function pickActiveOffer(state, rng, predicate) {
  const userId = state.userSchoolId
  const open = Object.values(state.recruits || {})
    .filter(r => r && r.liveOffer?.schoolId === userId && r.status !== 'signed' && r.status !== 'lost')
    .filter(r => !predicate || predicate(r))
  if (open.length === 0) return null
  return rng.pick(open)
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

function isPostseasonWeek(state) {
  const wk = state.calendar?.weekOfYear || 0
  return wk >= 40 && wk <= 42
}

/**
 * Add a real walk-on player to the user's roster. Used by event apply()s
 * that "land" a player (walk-on tryout success, juco gem signing, etc.).
 * Uses the engine's standard player shape so Roster + Stats pages render
 * the kid correctly.
 */
function addWalkOnPlayer(state, displayName, primaryPos, rng) {
  const team = state.teams?.[state.userSchoolId]
  if (!team) return null
  const id = `walkon_${state.calendar?.year || 2026}_${Math.random().toString(36).slice(2, 8)}`
  const [firstName, ...lastParts] = displayName.split(' ')
  const lastName = lastParts.join(' ') || 'Walker'
  const isPitcher = primaryPos === 'P' || primaryPos === 'RHP' || primaryPos === 'LHP'
  // Walk-on rating spread — mostly fillers, but a small chance of a real find.
  const baseMean = rng.chance(0.2) ? 60 : 48
  const roll = (k, mean = baseMean) => Math.max(20, Math.min(99, Math.round(mean + rng.gaussian(0, 8))))
  const hitter = isPitcher ? null : {
    contact_l: roll('contact_l'), contact_r: roll('contact_r'),
    power_l: roll('power_l'), power_r: roll('power_r'),
    discipline: roll('discipline'), speed: roll('speed'),
    fielding: roll('fielding'), arm: roll('arm'),
    composure: roll('composure'), durability: roll('durability'),
  }
  const pitcher = !isPitcher ? null : {
    stuff: roll('stuff'), control: roll('control'), command: roll('command'),
    stamina: roll('stamina'), vs_l: roll('vs_l'), vs_r: roll('vs_r'),
    composure: roll('composure'), durability: roll('durability'),
  }
  state.players[id] = {
    id, firstName, lastName,
    birthDate: `${(state.calendar?.year || 2026) - 19}-08-15`,
    bats: rng.pick(['R', 'L', 'R', 'R', 'S']),
    throws: rng.pick(['R', 'R', 'R', 'L']),
    primaryPosition: primaryPos,
    positions: [primaryPos],
    classYear: 'FR',
    seasonsUsed: 0, semestersUsed: 0, redshirtUsed: false,
    hometown: 'Local',
    schoolId: state.userSchoolId,
    isHitter: !isPitcher, isPitcher,
    hitter, pitcher,
    hidden: {
      potential_hitter: hitter, potential_pitcher: pitcher,
      work_ethic: 70, clutch: 50, injury_prone: 45, loyalty: 70,
      academic_aptitude: 65, quirks: [],
    },
    injury: null,
    gpa: 3.0, academicStanding: 'eligible',
    eligibilityStatus: 'eligible',
    scholarship: { annualAmount: 0, yearsCommitted: 4 },
    happiness: { value: 70, lastWeek: 70 },
    signedAt: state.calendar?.year,
  }
  team.rosterPlayerIds = team.rosterPlayerIds || []
  team.rosterPlayerIds.push(id)
  return id
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
        body: `${playerLabel(player)} was ${offense}. The story is on its way to the local paper. How do you handle it?`,
        playerId: player.id,
        choices: [
          {
            id: 'suspend-three',
            label: 'Suspend three games',
            blurb: 'Hard discipline. Veterans appreciate it; the player resents you.',
            apply: (state) => {
              applyPlayerMorale(player, -12)
              applyTeamMorale(state, +2)
              pushNews(state, `Outcome: ${player.firstName} ${player.lastName} (${player.classYear}) SUSPENDED 3 games. Available to return for next series.`)
              player.suspended = { weeks: 3, year: state.calendar.year }
            },
          },
          {
            id: 'private-warning',
            label: 'Private warning, no public action',
            blurb: '~65% it stays quiet. ~35% media breaks the cover-up.',
            apply: (state, rng) => {
              applyPlayerMorale(player, +4)
              applyTeamMorale(state, -3)
              if (rng.chance(0.35)) {
                pushNews(state, `Outcome: COVER-UP EXPOSED. Local paper broke the story on ${player.firstName} ${player.lastName} (${player.classYear}). AD furious.`)
                applyJobSecurity(state, -10)
              } else {
                pushNews(state, `Outcome: ${player.firstName} ${player.lastName} (${player.classYear}) received private warning. Stayed quiet. Player remains available.`)
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
              pushNews(state, `Outcome: ${player.firstName} ${player.lastName} (${player.classYear}) DISMISSED — removed from the roster. Coach: 'Standards are non-negotiable.'`, 'AWARD', true)
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
    // NWAC + D3 + small NAIA bus everywhere — no flights to delay.
    condition: (state) => isSeasonWeek(state) && isFlyingProgram(state),
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
            blurb: 'Team +1 durability (rested arms). No game added.',
            apply: (state) => {
              applyTeamDurability(state, +1)
              pushNews(state, `Coach declined the midweek vs ${opponentName}. Arms stay fresh for the weekend series.`)
            },
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
            blurb: '~70% he reschedules. ~30% he drifts to another school.',
            apply: (state, rng) => {
              if (rng.chance(0.7)) pushNews(state, 'Recruit rescheduled the visit for the following weekend. Pipeline intact.')
              else { applyJobSecurity(state, -1); pushNews(state, 'Recruit lost interest after the reschedule and committed elsewhere.') }
            },
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
          { id: 'internal-discipline', label: 'Handle internally, no public report', blurb: '60% it stays quiet. 40% it leaks and the AD comes down hard.',
            apply: (state, rng) => {
              if (rng.chance(0.4)) {
                applyJobSecurity(state, -18)
                pushNews(state, 'Hazing cover-up exposed by an anonymous source. Compliance hammers the program.', 'AWARD', true)
              } else {
                applyJobSecurity(state, +1)
                applyTeamMorale(state, -2)
                pushNews(state, 'Hazing handled internally. Quiet suspensions, no public attention.')
              }
            },
          },
          { id: 'deny-deny-deny', label: 'Deny everything', blurb: '40% you skate. 60% NCAA opens a formal investigation.',
            apply: (state, rng) => {
              if (rng.chance(0.6)) {
                applyJobSecurity(state, -25)
                pushNews(state, 'NCAA opens formal investigation into hazing denials.', 'AWARD', true)
              } else {
                applyJobSecurity(state, +3)
                pushNews(state, 'Hazing allegations went away — no proof, no story, no fallout.')
              }
            },
          },
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
        body: `${playerLabel(player)}'s professor caught him using AI to write a 10-page paper. Academic affairs is recommending a 1-semester suspension.`,
        playerId: player.id,
        choices: [
          { id: 'fight-it', label: 'Advocate for him with academic affairs', blurb: '50% reduced to a warning. 50% suspension stands.',
            apply: (state, rng) => {
              if (rng.chance(0.5)) {
                applyPlayerMorale(player, +10)
                pushNews(state, `Outcome: Advocacy succeeded — ${player.firstName} ${player.lastName} (${player.classYear}) received only an academic warning. NO suspension. Eligibility intact.`)
              } else {
                applyJobSecurity(state, -3)
                player.eligibilityStatus = 'ineligible'
                pushNews(state, `Outcome: Advocacy failed — ${player.firstName} ${player.lastName} (${player.classYear}) SUSPENDED one full semester. Marked ineligible.`)
              }
            },
          },
          { id: 'accept-suspension', label: 'Accept the suspension', blurb: 'Player marked ineligible all spring. Sends a clear message.',
            apply: (state) => {
              player.eligibilityStatus = 'ineligible'
              applyTeamMorale(state, +1)
              pushNews(state, `Outcome: ${player.firstName} ${player.lastName} (${player.classYear}) SUSPENDED — marked ineligible for the season. Team got the message.`)
            },
          },
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
        body: `Compliance flagged ${playerLabel(player)} for placing DraftKings bets — including a parlay on a college baseball game (not yours). They want a sit-down interview.`,
        playerId: player.id,
        choices: [
          { id: 'lawyer-up', label: 'Get him a lawyer + cooperate', blurb: '6-game suspension. Reputation intact.',
            apply: (state) => {
              applyJobSecurity(state, +2)
              player.suspended = { weeks: 2, year: state.calendar.year }
              pushNews(state, `Outcome: ${player.firstName} ${player.lastName} (${player.classYear}) SUSPENDED 6 games per NCAA gambling rules.`)
            },
          },
          { id: 'stall', label: 'Tell him to lawyer up but stall the meeting', blurb: 'Buys him weeks. AD will absolutely hear about it.',
            apply: (state) => {
              applyJobSecurity(state, -8)
              pushNews(state, `Outcome: Coach stalled NCAA on ${player.firstName} ${player.lastName} (${player.classYear}). AD furious about the foot-dragging.`)
            },
          },
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
          { id: 'rest-week', label: 'Sit him a week to be safe', blurb: 'Player happiness +5. Misses next 1 week.',
            apply: (state) => {
              applyPlayerMorale(player, +5)
              player._minorInjuryFlag = { weeks: 1, year: state.calendar.year }
              pushNews(state, `${player.firstName} ${player.lastName} (${player.classYear}) sat out a week to be safe. Player happiness +5; available again next series.`)
            } },
          { id: 'play-if-able', label: 'Play if the trainer clears him', blurb: '~70% he plays through. ~30% the soreness flares mid-game.',
            apply: (state, rng) => {
              if (rng.chance(0.7)) pushNews(state, `Trainer cleared ${player.firstName} ${player.lastName} (${player.classYear}). Played through the soreness.`)
              else { player._minorInjuryFlag = { weeks: 1, year: state.calendar.year }; applyPlayerMorale(player, -4); pushNews(state, `${player.firstName} ${player.lastName} (${player.classYear}) re-aggravated the sore arm mid-game. Out a week.`) }
            } },
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
    // NWAC is bus-only, no overnight road trips per Nate — skip them.
    condition: (state) => isSeasonWeek(state) && !isNwacUser(state),
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
      const POS_OPTIONS = ['C', 'SS', '2B', '3B', 'CF', 'LF', 'RF', '1B']
      const currentPos = player.primaryPosition || 'OF'
      const candidates = POS_OPTIONS.filter(p => p !== currentPos)
      const newPos = rng.pick(candidates)
      const POS_LABEL = { C: 'catcher', SS: 'shortstop', '2B': 'second base', '3B': 'third base',
        CF: 'center field', LF: 'left field', RF: 'right field', '1B': 'first base' }
      return {
        id: `evt_POSREQ_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'POSITION_CHANGE_REQUEST',
        title: 'Player Wants a Position Change',
        body: `${player.firstName} ${player.lastName} (currently ${POS_LABEL[currentPos] || currentPos}) asked to move to ${POS_LABEL[newPos]}. He thinks he projects better there and wants more reps in fall ball.`,
        playerId: player.id,
        choices: [
          { id: 'allow', label: `Allow the move to ${POS_LABEL[newPos]}`, blurb: 'Player actually switches positions. Some fielding regression near-term.',
            apply: (state) => {
              // Actually change the player's position (per Nate — if you say yes
              // they need to literally switch).
              const old = player.primaryPosition
              player.primaryPosition = newPos
              // Add the new pos + drop the old one from the positions array.
              const posList = Array.isArray(player.positions) ? [...player.positions] : [old || 'OF']
              if (!posList.includes(newPos)) posList.unshift(newPos)
              player.positions = posList.filter(p => p !== old).slice(0, 3)
              if (!player.positions.includes(newPos)) player.positions.unshift(newPos)
              // Fielding regression for the new role (learning curve).
              if (player.hitter) player.hitter.fielding = Math.max(20, (player.hitter.fielding || 60) - 3)
              applyPlayerMorale(player, +8)
              pushNews(state, `${player.firstName} ${player.lastName} moved from ${POS_LABEL[old] || old} to ${POS_LABEL[newPos]}. Fielding will need time to catch up.`)
            },
          },
          { id: 'compromise', label: 'Fall reps at the new spot, decide in spring', blurb: 'No position change yet — he gets the look without committing.',
            apply: (state) => {
              applyPlayerMorale(player, +4)
              pushNews(state, `${player.firstName} ${player.lastName} will get fall reps at ${POS_LABEL[newPos]} but stays at ${POS_LABEL[currentPos] || currentPos} for now.`)
            },
          },
          { id: 'decline', label: 'Decline — he\'s needed where he is', blurb: 'No move. Player is unhappy and feels stuck.',
            apply: (state) => {
              applyPlayerMorale(player, -8)
              pushNews(state, `${player.firstName} ${player.lastName} denied the position change. Tension brewing.`)
            },
          },
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
        body: `${playerLabel(player)} has had three straight breakthrough practices. The hitting coach swears he's a different player. Promote him to a starting role?`,
        playerId: player.id,
        choices: [
          { id: 'start-him', label: 'Move him into the starting lineup', blurb: 'Reward the work. Big morale boost; small team-chemistry risk.',
            apply: (state) => {
              applyPlayerMorale(player, +12); applyTeamMorale(state, -1)
              pushNews(state, `Outcome: ${player.firstName} ${player.lastName} (${player.classYear}) PROMOTED to starting lineup. Other guys noticed the leap.`)
            },
          },
          { id: 'keep-developing', label: 'Keep him in development reps', blurb: 'No promotion. +2 to his headline ratings instead.',
            apply: (state) => {
              if (player.hitter) {
                player.hitter.contact_r = Math.min(99, (player.hitter.contact_r || 50) + 2)
                player.hitter.contact_l = Math.min(99, (player.hitter.contact_l || 50) + 2)
              }
              if (player.pitcher) player.pitcher.stuff = Math.min(99, (player.pitcher.stuff || 50) + 2)
              pushNews(state, `Outcome: Kept ${player.firstName} ${player.lastName} (${player.classYear}) in development. Contact/Stuff +2 from the focused reps.`)
            },
          },
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
        body: `${playerLabel(player)} is 2-for-32 over his last 8 games. Confidence is shot. Vets are starting to notice.`,
        playerId: player.id,
        choices: [
          { id: 'bench-reset', label: 'Bench him a week to reset', blurb: '65% he returns hungry. 35% confidence breaks fully.',
            apply: (state, rng) => {
              if (rng.chance(0.65)) {
                applyPlayerMorale(player, +6)
                pushNews(state, `Outcome: Reset worked — ${player.firstName} ${player.lastName} (${player.classYear}) returned hungry after a week off.`)
              } else {
                applyPlayerMorale(player, -10)
                pushNews(state, `Outcome: Reset failed — ${player.firstName} ${player.lastName} (${player.classYear}) returned even more in his head. Slump worsens.`)
              }
            },
          },
          { id: 'extra-cage-work', label: 'Hitting-coach 1-on-1 work', blurb: 'No bench. +1 contact rating, slow morale climb.',
            apply: (state) => {
              applyPlayerMorale(player, +4)
              if (player.hitter) player.hitter.contact_r = Math.min(99, (player.hitter.contact_r || 50) + 1)
              pushNews(state, `Outcome: ${player.firstName} ${player.lastName} (${player.classYear}) got extra cage work. Contact +1; slowly climbing back.`)
            },
          },
          { id: 'just-play', label: 'Keep running him out there', blurb: '50/50: faith builds him up or destroys him.',
            apply: (state, rng) => {
              if (rng.chance(0.5)) {
                applyPlayerMorale(player, +3)
                pushNews(state, `Outcome: ${player.firstName} ${player.lastName} (${player.classYear}) appreciated the trust. Slowly came back around.`)
              } else {
                applyPlayerMorale(player, -6)
                pushNews(state, `Outcome: ${player.firstName} ${player.lastName} (${player.classYear}) pressed harder and harder. Slump getting worse.`)
              }
            },
          },
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
        body: `${playerLabel(player)} told his position coach he\'s entering the portal if things don\'t change. A bigger program has been DM\'ing him.`,
        playerId: player.id,
        choices: [
          { id: 'meet-and-promise', label: 'Sit down, promise more touches', blurb: 'Player STAYS. Now you have to deliver on the touches.',
            apply: (state) => {
              applyPlayerMorale(player, +8)
              pushNews(state, `Outcome: ${player.firstName} ${player.lastName} (${player.classYear}) STAYED — accepted the promise of more PT. He\'s expecting you to deliver.`)
            },
          },
          { id: 'call-his-bluff', label: 'Call his bluff', blurb: '50% he stays put. 50% he LEAVES the roster.',
            apply: (state, rng) => {
              if (rng.chance(0.5)) {
                // Bluff successfully called — player stays.
                applyPlayerMorale(player, +4)
                pushNews(state, `Outcome: ${player.firstName} ${player.lastName} (${player.classYear}) STAYED — your bluff worked. He didn\'t enter the portal.`)
              } else {
                // Player actually enters the portal — remove from roster.
                const team = state.teams[state.userSchoolId]
                if (team) team.rosterPlayerIds = (team.rosterPlayerIds || []).filter(id => id !== player.id)
                player.eligibilityStatus = 'transferred'
                applyPlayerMorale(player, -15)
                pushNews(state, `Outcome: ${player.firstName} ${player.lastName} (${player.classYear}) LEFT — entered the transfer portal. Removed from roster.`, 'AWARD', true)
              }
            },
          },
          { id: 'bump-scholarship', label: 'Bump his scholarship $1K', blurb: 'Player STAYS. Costs $1K from next year\'s pool.',
            apply: (state) => {
              applyPlayerMorale(player, +12)
              if (state.budget?.allocations) state.budget.allocations.scholarships = Math.max(0, (state.budget.allocations.scholarships || 0) - 1000)
              pushNews(state, `Outcome: ${player.firstName} ${player.lastName} (${player.classYear}) STAYED — accepted the $1K scholarship bump. -$1K from next year\'s pool.`)
            },
          },
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
        { id: 'team-vote', label: 'Let the team vote', blurb: 'Team +5. Top 3 vets get +6 happiness (they ran the locker room and earned the votes).',
          apply: (state) => {
            applyTeamMorale(state, +5)
            applyCaptainMorale(state, +6, 'won the team captain vote', 3, p => p.classYear === 'SR' || p.classYear === 'JR')
          } },
        { id: 'coach-pick', label: 'You pick the captains', blurb: 'Team -2 happiness. Job sec +1. Vets you skipped lose -10 happiness.',
          apply: (state) => {
            applyTeamMorale(state, -2)
            applyJobSecurity(state, +1)
            // The "skipped" captains — vets who would have won the vote
            // but didn't get named. Penalize the 2 highest-OVR seniors
            // by name so the user sees the locker-room cost.
            applyCaptainMorale(state, -10, 'expected to be named captain and was passed over', 2, p => p.classYear === 'SR')
          } },
        { id: 'hybrid', label: 'Team votes from a list you approve', blurb: 'Team +3. Top vet on your list +5 happiness.',
          apply: (state) => {
            applyTeamMorale(state, +3)
            applyCaptainMorale(state, +5, 'won captain vote off coach\'s approved list', 2, p => p.classYear === 'SR' || p.classYear === 'JR')
          } },
      ],
    }),
  },

  WALK_ON_TRYOUT: {
    id: 'WALK_ON_TRYOUT',
    weight: 0.35,
    condition: (state) => isOffseasonWeek(state) && (state.calendar?.weekOfYear || 0) <= 13,
    builder: (state, rng) => {
      const name = rng.pick([
        'Tyler Brennan', 'Jake Morris', 'Carter Reynolds', 'Mason Pierce',
        'Dylan Walsh', 'Ryan Cole', 'Brandon Hayes', 'Connor Whitley',
      ])
      const pos = rng.pick(['OF', '3B', '2B', 'C', 'P'])
      return {
        id: `evt_WALKON_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'WALK_ON_TRYOUT',
        title: 'Late Walk-On Tryout Request',
        body: `${name}, a local ${pos === 'P' ? 'pitcher' : pos + ' prospect'} overlooked in HS recruiting, is asking for a fall tryout. His travel coach swears he\'s a sleeper. You have an open roster spot.`,
        choices: [
          { id: 'give-tryout', label: 'Hold a tryout', blurb: '~55% chance: legit prospect. ~45% chance: roster filler.',
            apply: (state, rng) => {
              if (rng.chance(0.55)) {
                // Build a real player and add to roster.
                addWalkOnPlayer(state, name, pos, rng)
                pushNews(state, `Walk-on tryout landed a hidden gem — ${name} joins the roster.`)
                applyTeamMorale(state, +2)
              } else {
                pushNews(state, `Walk-on tryout was a swing-and-miss. ${name} couldn\'t keep up. Spot still open.`)
              }
            },
          },
          { id: 'pass', label: 'Pass — focus on signed recruits', blurb: 'Skip the distraction. No change to roster.',
            apply: (state) => { pushNews(state, `Passed on the ${name} tryout. Staying focused on the signed class.`) } },
        ],
      }
    },
  },

  // ────────────────────────────────────────────────────────────────────
  // RECRUITING
  // ────────────────────────────────────────────────────────────────────
  TOP_RECRUIT_DECOMMIT: {
    id: 'TOP_RECRUIT_DECOMMIT',
    weight: 0.3,
    // Only fire if the user has a real signed recruit. Was inventing
    // fake "top commit" names before — per Nate, May 2026.
    condition: (state) => {
      if (!isOffseasonWeek(state) || (state.calendar?.weekOfYear || 0) < 14) return false
      const userId = state.userSchoolId
      return Object.values(state.recruits || {})
        .some(r => r && r.status === 'signed' && r.signedTo === userId)
    },
    builder: (state, rng) => {
      // Pick the user's HIGHEST-rated signed recruit (the realistic
      // "top commit" target for a power-conf flip).
      const userId = state.userSchoolId
      const signed = Object.values(state.recruits || {})
        .filter(r => r && r.status === 'signed' && r.signedTo === userId)
      if (signed.length === 0) return null
      signed.sort((a, b) => (b.scoutedOvr || 0) - (a.scoutedOvr || 0))
      const recruit = signed[0]
      const name = `${recruit.firstName} ${recruit.lastName}`
      const pos = recruit.primaryPosition || '?'
      const ovr = Math.round(recruit.scoutedOvr || recruit.trueOvr || 70)
      return {
        id: `evt_DECOMMIT_${recruit.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'TOP_RECRUIT_DECOMMIT',
        title: 'Top Recruit on the Fence',
        body: `${name} (${pos}, ${ovr} OVR), your highest-rated commit, just got a late offer from a power-conference D1. He says he\'s thinking. What\'s your play?`,
        choices: [
          { id: 'home-visit', label: 'Drive to his house this weekend', blurb: '-$1K recruiting. 65% he holds firm.',
            apply: (state, rng) => {
              if (state.budget?.allocations) state.budget.allocations.recruiting = Math.max(0, (state.budget.allocations.recruiting || 0) - 1000)
              if (rng.chance(0.65)) pushNews(state, `${name} held firm after the home visit. Crisis averted.`)
              else { recruit.status = 'lost'; recruit.signedTo = null; applyJobSecurity(state, -3); pushNews(state, `${name} flipped to a D1 despite the home visit. Lost the commit.`) }
            } },
          { id: 'bump-scholarship', label: 'Increase his scholarship offer', blurb: '-$3K from pool. 75% he stays.',
            apply: (state, rng) => {
              if (state.budget?.allocations) state.budget.allocations.scholarships = Math.max(0, state.budget.allocations.scholarships - 3000)
              if (rng.chance(0.75)) {
                if (recruit.liveOffer) recruit.liveOffer.amount = (recruit.liveOffer.amount || 0) + 3000
                pushNews(state, `${name} signed after the $3K scholarship bump.`)
              } else { recruit.status = 'lost'; recruit.signedTo = null; pushNews(state, `${name} flipped despite the bump. $3K wasted; commit lost.`) }
            } },
          { id: 'let-him-decide', label: 'Let him decide on his own', blurb: 'No cost. 35% he stays out of respect for not chasing.',
            apply: (state, rng) => {
              if (rng.chance(0.35)) pushNews(state, `${name} appreciated the no-pressure approach. Stayed firm.`)
              else { recruit.status = 'lost'; recruit.signedTo = null; applyJobSecurity(state, -4); pushNews(state, `${name} flipped. Coach didn\'t chase; fans are mad.`) }
            } },
        ],
      }
    },
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
    // Only fire when the user has at least one signed recruit — was
    // inventing a fake "#1 verbal commit" otherwise (per Nate, May 2026).
    condition: (state) => {
      if (!isOffseasonWeek(state)) return false
      const userId = state.userSchoolId
      return Object.values(state.recruits || {})
        .some(r => r && r.status === 'signed' && r.signedTo === userId)
    },
    builder: (state, rng) => {
      const recruit = pickSignedRecruit(state, rng)
      if (!recruit) return null
      const name = `${recruit.firstName} ${recruit.lastName}`
      const pos = recruit.primaryPosition || '?'
      const scholarship = recruit.liveOffer?.amount || recruit.scholarshipOffered || 0
      return {
        id: `evt_RECINCID_${recruit.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'RECRUIT_INCIDENT',
        title: 'Top Recruit Off-Field Incident',
        body: `${name} (${pos}, your $${(scholarship / 1000).toFixed(1)}K commit) got picked up at a HS party. Local paper has it. Do you stand by him or pull the offer?`,
        choices: [
          { id: 'stand-by', label: 'Stand by the commit', blurb: '70% he locks in. 30% he gets in MORE trouble (job sec -6).',
            apply: (state, rng) => {
              if (rng.chance(0.7)) pushNews(state, `${name} thanked the coach for the loyalty. Bond strengthened.`)
              else { applyJobSecurity(state, -6); pushNews(state, `${name} got in MORE trouble. Coach\'s loyalty looks bad now.`) }
            } },
          { id: 'pull-offer', label: 'Pull the offer', blurb: `Job sec +3. +$${(scholarship / 1000).toFixed(1)}K freed. Recruit released.`,
            apply: (state) => {
              applyJobSecurity(state, +3)
              if (state.budget?.allocations) state.budget.allocations.scholarships = (state.budget.allocations.scholarships || 0) + scholarship
              recruit.status = 'lost'
              recruit.signedTo = null
              pushNews(state, `Coach pulled ${name}\'s scholarship. Standards reinforced; -$${(scholarship / 1000).toFixed(1)}K freed.`)
            } },
        ],
      }
    },
  },

  TRANSFER_PORTAL_GEM: {
    id: 'TRANSFER_PORTAL_GEM',
    weight: 0.45,
    // SEC/Big-12 portal kids don't drop to NWAC — 4-year programs only.
    condition: (state) => isOffseasonWeek(state) && (state.calendar?.weekOfYear || 0) >= 14 && isFourYearUser(state),
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
          { id: 'pass', label: 'Pass — too expensive', blurb: 'Job sec +1 (AD likes the budget discipline). No scholarship spent.',
            apply: (state) => { applyJobSecurity(state, +1); pushNews(state, `Passed on the ${fromSchool} portal gem. AD respects the budget restraint.`) } },
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
        { id: 'decline-keep-options', label: 'Decline — preserve options', blurb: 'No facility, no extension. Career flexibility intact.',
          apply: (state) => { pushNews(state, 'Coach declined the 2-year extension. No facility upgrade. Free to take outside offers next offseason.') } },
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
        { id: 'decline-politely', label: 'Decline — too risky', blurb: 'No upside, no risk. Producer notes the snub.',
          apply: (state) => { applyJobSecurity(state, -1); pushNews(state, 'Coach declined the podcast invite. Show host mentioned the snub on a later episode.') } },
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
        body: `${playerLabel(player)}\'s dad wrote a multi-page email complaining about pitch counts. He CC\'d the AD and the trainer.`,
        playerId: player.id,
        choices: [
          { id: 'professional-response', label: 'Send a professional, data-backed reply', blurb: 'Slow but bulletproof. Sets a precedent.',
            apply: (state) => { applyJobSecurity(state, +2); pushNews(state, `Outcome: Coach sent a data-backed reply re: ${player.firstName} ${player.lastName} (${player.classYear}). Dad backed off. AD impressed.`) } },
          { id: 'phone-call', label: 'Call the dad directly', blurb: '60% it works. 40% gets recorded and shared.',
            apply: (state, rng) => {
              if (rng.chance(0.6)) { applyJobSecurity(state, +3); pushNews(state, `Outcome: Direct call to ${player.firstName}'s dad worked. Defused.`) }
              else { applyJobSecurity(state, -3); pushNews(state, `Outcome: ${player.firstName}'s dad recorded the phone call and shared it. Embarrassing for the program.`) }
            },
          },
          { id: 'ad-handles', label: 'Let the AD handle it', blurb: 'Pass the buck. AD doesn\'t love it.',
            apply: (state) => { applyJobSecurity(state, -2); pushNews(state, `Outcome: Punted ${player.firstName}'s dad to the AD. AD noted it as duck-the-tough-call.`) } },
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
        { id: 'let-them-sing', label: 'Let them celebrate', blurb: 'Team +5. Captains +8 each — they led the push.',
          apply: (state) => {
            applyTeamMorale(state, +5)
            applyCaptainMorale(state, +8, 'captain ran the postgame bus celebration', 3)
            pushNews(state, 'Bus rolled home with the music on. Vibes electric.')
          } },
        { id: 'cooldown-first', label: 'Cooldown first, then celebrate', blurb: 'Team +3. Captains +4 each (got the celebration eventually).',
          apply: (state) => {
            applyTeamMorale(state, +3)
            applyCaptainMorale(state, +4, 'captain appreciated the post-cooldown celebration', 3)
            pushNews(state, 'Coach made the team cool down first, THEN gave them the music. Veteran move.')
          } },
        { id: 'keep-routine', label: 'Stick to routine, no music', blurb: 'Team -2. Captains -7 each (they pitched for it).',
          apply: (state) => {
            applyTeamMorale(state, -2)
            applyCaptainMorale(state, -7, 'captain pitched the celebration and got shut down', 3)
            pushNews(state, 'Coach said no music — routine wins. Captains are pissed.')
          } },
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
        { id: 'decline', label: 'Decline — focus on team', blurb: 'No $, no profile bump. Clinic board notes you said no.',
          apply: (state) => { applyJobSecurity(state, -1); pushNews(state, 'Coach declined the clinic keynote. Other coaches snagged the slot.') } },
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
        { id: 'send-assistant', label: 'Send your bench coach', blurb: '+1 to bench coach\'s tactician rating. No personal upside.',
          apply: (state) => {
            const team = state.teams?.[state.userSchoolId]
            const bench = (team?.assistantCoachIds || [])
              .map(id => state.coaches?.[id])
              .find(c => c?.role === 'BENCH_COACH') || (team?.assistantCoachIds || []).map(id => state.coaches?.[id]).filter(Boolean)[0]
            if (bench) {
              bench.tactician = Math.min(99, (bench.tactician || 60) + 1)
              pushNews(state, `${bench.firstName || 'Bench'} ${bench.lastName || 'coach'} attended the sabermetrics conference. Tactician +1.`)
            } else pushNews(state, 'No assistant available to send. Conference slot wasted.')
          } },
        { id: 'pass', label: 'Pass — stick with practice', blurb: 'No rating bump. Practice volume preserved.',
          apply: (state) => { applyTeamMorale(state, +1); pushNews(state, 'Coach passed on the conference. Extra practice reps booked instead.') } },
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
        { id: 'no-comment', label: 'No public comment', blurb: 'Job sec +1 (no political risk taken).',
          apply: (state) => { applyJobSecurity(state, +1); pushNews(state, 'Coach gave the realignment "no comment". AD respected the discretion.') } },
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
        { id: 'wait-see', label: 'Wait and see how others adapt', blurb: '50/50: late mover wins (job sec +2) OR you fall behind (job sec -3).',
          apply: (state, rng) => {
            if (rng.chance(0.5)) { applyJobSecurity(state, +2); pushNews(state, 'Wait-and-see paid off. Other coaches over-corrected; your steady hand looked smart.') }
            else { applyJobSecurity(state, -3); pushNews(state, 'Other programs adapted faster. Coach got caught flat-footed.') }
          } },
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
        { id: 'decline', label: 'Decline entirely', blurb: '-$500 recruiting budget (lost touchpoint). Job sec -1 (station noticed).',
          apply: (state) => {
            if (state.budget?.allocations) state.budget.allocations.recruiting = Math.max(0, (state.budget.allocations.recruiting || 0) - 500)
            applyJobSecurity(state, -1)
            pushNews(state, 'Coach declined the TV sit-down. Station ran the story without him; recruiting touchpoint lost.')
          } },
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
            apply: (state) => {
              if (state.budget?.allocations) state.budget.allocations.equipment = Math.max(0, (state.budget.allocations.equipment || 0) - 8000)
              applyTeamMorale(state, -2)
              pushNews(state, `Signed exclusive ${brand} bat deal. -$8K equipment cost, some hitters grumbling.`)
            },
          },
          { id: 'decline-exclusive', label: 'Decline — let players pick', blurb: 'Player flexibility. No free gear.',
            apply: (state) => { applyTeamMorale(state, +2); pushNews(state, `Declined the ${brand} exclusive. Players keep choosing their own bats.`) } },
        ],
      }
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // ── 30 NEW PROMPTS (per Nate, May 2026) ─────────────────────────────
  // Every choice mutates real state + pushes a clear news line so the
  // EventOutcomeModal can report what happened. Probabilistic outcomes
  // use rng.chance() with explicit branches that always emit news.
  // ════════════════════════════════════════════════════════════════════

  // ── In-Season Game Decisions ────────────────────────────────────────
  PITCHER_SHORT_REST: {
    id: 'PITCHER_SHORT_REST', weight: 0.4,
    condition: (state) => isSeasonWeek(state),
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng, p => p && p.isPitcher)
      if (!player) return null
      return {
        id: `evt_SHORTREST_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'PITCHER_SHORT_REST',
        title: 'Ace Wants to Pitch on Short Rest',
        body: `${player.firstName} ${player.lastName} wants the ball tomorrow on 3 days rest for the rubber game of a big series. Trainer recommends against it.`,
        playerId: player.id,
        choices: [
          { id: 'let-him-throw', label: 'Let him throw on short rest', blurb: '40% you steal the game. 60% he gets hurt or gets shelled.',
            apply: (state, rng) => {
              if (rng.chance(0.4)) { applyPlayerMorale(player, +10); pushNews(state, `${player.firstName} ${player.lastName} dealt on short rest — series won.`) }
              else {
                if (player.pitcher) { player.pitcher.stamina = Math.max(20, (player.pitcher.stamina || 60) - 4); player.pitcher.control = Math.max(20, (player.pitcher.control || 60) - 2) }
                applyPlayerMorale(player, -4)
                pushNews(state, `${player.firstName} ${player.lastName} got rocked on short rest. Arm fatigue lingering.`)
              }
            },
          },
          { id: 'follow-trainer', label: 'Follow the trainer — bullpen game', blurb: 'Safe. Bullpen game has its own risks.',
            apply: (state) => { applyTeamDurability(state, +1); pushNews(state, 'Coach went bullpen-by-committee for the rubber game. Arms healthy.') },
          },
        ],
      }
    },
  },

  STORM_DELAY: {
    id: 'STORM_DELAY', weight: 0.45,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_STORM_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'STORM_DELAY',
      title: 'Lightning Delay in the 4th',
      body: 'You\'re up 3-1 in the 4th when lightning halts the game. Forecast is 50/50 on resuming tonight. Conference rules: 5 innings makes it official.',
      choices: [
        { id: 'wait-it-out', label: 'Wait it out — finish the game', blurb: '55% you complete it. 45% it gets called anyway. Players sitting idle.',
          apply: (state, rng) => {
            if (rng.chance(0.55)) { pushNews(state, 'Storm passed. Game resumed and finished — win in the books.'); applyTeamMorale(state, +2) }
            else { pushNews(state, 'Game called after a 90-min delay. Won\'t count — replay required.') }
          } },
        { id: 'call-it', label: 'Push for the umps to call it', blurb: 'You\'re up 3-1 — but it\'s only 3.5 innings, no official win.',
          apply: (state) => { pushNews(state, 'Game called early. Stats and result vacated — neither side keeps the score.') } },
      ],
    }),
  },

  DUGOUT_OUTBURST: {
    id: 'DUGOUT_OUTBURST', weight: 0.4,
    condition: (state) => isSeasonWeek(state),
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_OUTBURST_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'DUGOUT_OUTBURST',
        title: 'Dugout Outburst',
        body: `${player.firstName} ${player.lastName} hurled a helmet, kicked the cooler, and screamed at the bench coach after striking out. The TV cameras got it.`,
        playerId: player.id,
        choices: [
          { id: 'bench-game', label: 'Bench him next game', blurb: 'Visible discipline. Veterans respect it, player simmers.',
            apply: (state) => { applyPlayerMorale(player, -8); applyTeamMorale(state, +2); pushNews(state, `${player.firstName} ${player.lastName} benched for next game. Message sent.`) },
          },
          { id: 'private-talk', label: 'Private dressing-down after the game', blurb: 'No public action. Most players take it well.',
            apply: (state, rng) => {
              if (rng.chance(0.7)) { applyPlayerMorale(player, +3); pushNews(state, `${player.firstName} ${player.lastName} took the talking-to. Pledged to lock in.`) }
              else { applyPlayerMorale(player, -4); pushNews(state, `${player.firstName} ${player.lastName} didn\'t take the conversation well. Tension lingering.`) }
            },
          },
          { id: 'media-spin', label: 'Tell media he\'s a passionate competitor', blurb: 'Defuse the optics. Costs nothing externally.',
            apply: (state) => { applyJobSecurity(state, -1); applyPlayerMorale(player, +5); pushNews(state, 'Coach defended the outburst as competitive fire. Player loved it; old-timers rolled their eyes.') },
          },
        ],
      }
    },
  },

  CATCHER_KNEE: {
    id: 'CATCHER_KNEE', weight: 0.35,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_CATCHKNEE_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'CATCHER_KNEE',
      title: 'Starting Catcher Tweaked His Knee',
      body: 'Your starting catcher\'s knee is barking. Trainer says he\'s 70%. Backup is a freshman who\'s caught 4 college innings. Big rivalry weekend ahead.',
      choices: [
        { id: 'play-starter', label: 'Play him at 70%', blurb: 'Risk further injury, but he\'s your best bat.',
          apply: (state, rng) => {
            if (rng.chance(0.4)) { applyTeamDurability(state, -2); pushNews(state, 'Starting catcher\'s knee got worse mid-series. 4-week injury.') }
            else { pushNews(state, 'Starter gutted it out at 70%. Got through the weekend.'); applyTeamMorale(state, +2) }
          },
        },
        { id: 'play-freshman', label: 'Start the freshman backup', blurb: 'Defensive downgrade but starter rests.',
          apply: (state) => { applyTeamMorale(state, -1); pushNews(state, 'Freshman caught the rivalry series. Starter rested — comes back at 100%.') },
        },
        { id: 'split-time', label: 'Catch the freshman in day games, starter at night', blurb: 'Reasonable hybrid. Both get reps.',
          apply: (state) => { applyTeamMorale(state, +1); pushNews(state, 'Coach split catching duties. Both catchers got needed work.') },
        },
      ],
    }),
  },

  UMP_INCIDENT: {
    id: 'UMP_INCIDENT', weight: 0.4,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_UMP_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'UMP_INCIDENT',
      title: 'You Got Ejected Arguing a Call',
      body: 'A blown call at home plate cost you a run in the 7th. You went ballistic, got tossed, conference says they\'ll review it.',
      choices: [
        { id: 'apologize-publicly', label: 'Public apology', blurb: 'Smart PR. AD appreciates the maturity.',
          apply: (state) => { applyJobSecurity(state, +2); pushNews(state, 'Coach apologized publicly for the ejection. AD nodded.') } },
        { id: 'double-down', label: 'Double down — that call was awful', blurb: 'Players love it. Conference fines you $1K.',
          apply: (state) => { if (state.budget) state.budget.totalAthleticBudget -= 1000; applyTeamMorale(state, +4); applyJobSecurity(state, -2); pushNews(state, 'Coach refused to apologize. Conference fined the program $1K.') } },
        { id: 'no-comment', label: 'No comment, move on', blurb: 'Neutral. Story dies in 48 hours.',
          apply: (state) => { pushNews(state, 'Coach said nothing about the ejection. Story faded.') } },
      ],
    }),
  },

  MERCY_RULE_OPPORTUNITY: {
    id: 'MERCY_RULE_OPPORTUNITY', weight: 0.35,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_MERCY_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'MERCY_RULE_OPPORTUNITY',
      title: 'Up Big in the 7th',
      body: 'You\'re up 14-2 in the 7th of a non-conference game. You can run-rule it, empty the bench for reps, or pile on for run differential.',
      choices: [
        { id: 'mercy-rule', label: 'Let the run rule end it', blurb: 'Sportsmanlike. Bench guys disappointed.',
          apply: (state) => { applyJobSecurity(state, +1); pushNews(state, 'Coach ran the mercy rule. Opposing team thanked him.') } },
        { id: 'empty-bench', label: 'Empty the bench for reps', blurb: 'Reserves get college innings. Good for development.',
          apply: (state) => { applyTeamMorale(state, +4); pushNews(state, 'Reserves got run-rule reps. Walk-ons got their first college AB.') } },
        { id: 'pile-on', label: 'Pile on for run-diff seeding', blurb: 'Helps postseason seeding. Bad look.',
          apply: (state) => { applyJobSecurity(state, -3); pushNews(state, 'Coach piled on with starters in a blowout. Opposing AD wrote a letter.') } },
      ],
    }),
  },

  HOME_FAN_DOUBT: {
    id: 'HOME_FAN_DOUBT', weight: 0.3,
    condition: (state) => {
      if (!isSeasonWeek(state)) return false
      const team = state.teams?.[state.userSchoolId]
      const games = (team?.wins || 0) + (team?.losses || 0)
      return games >= 8 && (team.wins / Math.max(1, games)) < 0.45
    },
    builder: (state) => ({
      id: `evt_HOMEFAN_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'HOME_FAN_DOUBT',
      title: 'Home Fans Booing Your Team',
      body: 'Home crowd booed after a 4-run inning by the visitors. Captains are asking if you\'ll address it before next homestand.',
      choices: [
        { id: 'fire-up-speech', label: 'Closed-door fire-up speech', blurb: 'Old-school. 65% it lights a fire; 35% it lands flat.',
          apply: (state, rng) => {
            if (rng.chance(0.65)) { applyTeamMorale(state, +6); pushNews(state, 'Coach\'s speech lit a fire. Team came out swinging next homestand.') }
            else { applyTeamMorale(state, -2); pushNews(state, 'Coach\'s speech didn\'t land. Veterans looked disengaged.') }
          } },
        { id: 'engage-fans', label: 'Public statement engaging the fans', blurb: 'Shows accountability. AD likes the optics.',
          apply: (state) => { applyJobSecurity(state, +3); pushNews(state, 'Coach published an open letter to fans owning the slump. AD impressed.') } },
        { id: 'ignore', label: 'Ignore — fans will be fans', blurb: 'Save the time. Booing may continue.',
          apply: (state) => { applyJobSecurity(state, -2); pushNews(state, 'Coach ignored the booing. Local talk radio is feasting.') } },
      ],
    }),
  },

  RAINOUT_RESCHEDULE: {
    id: 'RAINOUT_RESCHEDULE', weight: 0.4,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_RAINOUT_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'RAINOUT_RESCHEDULE',
      title: 'Conference Game Rained Out',
      body: 'Saturday\'s conference game is washed. Three options: stack DH on Sunday, move it to a neutral site next Tuesday, or call it a no-contest.',
      choices: [
        { id: 'sunday-dh', label: 'Sunday doubleheader', blurb: 'Pitching gets stretched. Easiest logistics.',
          apply: (state) => { applyTeamDurability(state, -2); pushNews(state, 'Saturday game pushed to Sunday DH. Bullpen will be thin Monday.') } },
        { id: 'neutral-tuesday', label: 'Neutral-site Tuesday midweek', blurb: '-$3K travel, but arms get a break.',
          apply: (state) => { if (state.budget?.allocations) state.budget.allocations.travel = (state.budget.allocations.travel || 0) + 3000; pushNews(state, 'Game pushed to a neutral midweek site. +$3K travel cost absorbed.') } },
        { id: 'no-contest', label: 'No-contest the game', blurb: 'Conference allows it. Both teams take the no-decision.',
          apply: (state) => { pushNews(state, 'Coaches agreed to a no-contest. Standings unchanged.') } },
      ],
    }),
  },

  // ── Recruiting / Roster ─────────────────────────────────────────────
  JUCO_VISIT: {
    id: 'JUCO_VISIT', weight: 0.4,
    condition: (state) => {
      if (!isOffseasonWeek(state)) return false
      const level = state.schools?.[state.userSchoolId]?.level
      return level !== 'NWAC'   // 4-yr schools recruit JUCO transfers
    },
    builder: (state, rng) => {
      const fromSchool = rng.pick(['Lower Columbia', 'Yakima Valley', 'Linn-Benton', 'Treasure Valley', 'Spokane'])
      return {
        id: `evt_JUCOVISIT_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'JUCO_VISIT',
        title: 'Top JUCO Prospect Wants a Visit',
        body: `A 2nd-year SS from ${fromSchool} is in the portal — he\'s scheduled visits with you and two other schools. Hosting him costs $1.5K (travel + meals + facility tour).`,
        choices: [
          { id: 'pull-out-stops', label: 'Roll out the red carpet', blurb: '-$1.5K. 60% close. Best chance to land him.',
            apply: (state, rng) => {
              if (state.budget?.allocations) state.budget.allocations.recruiting = Math.max(0, (state.budget.allocations.recruiting || 0) - 1500)
              if (rng.chance(0.6)) { addWalkOnPlayer(state, `${fromSchool.split(' ')[0]} JUCO Transfer`, 'SS', rng); pushNews(state, `JUCO transfer SS from ${fromSchool} committed after the visit. Joins the roster.`) }
              else pushNews(state, `JUCO transfer from ${fromSchool} chose a different school. $1.5K spent, nothing to show.`)
            } },
          { id: 'simple-visit', label: 'Simple unofficial visit', blurb: 'Save the money. 30% close.',
            apply: (state, rng) => {
              if (rng.chance(0.3)) { addWalkOnPlayer(state, `${fromSchool.split(' ')[0]} JUCO Transfer`, 'SS', rng); pushNews(state, `JUCO transfer SS from ${fromSchool} surprisingly committed after a low-key visit.`) }
              else pushNews(state, `JUCO transfer from ${fromSchool} signed elsewhere. Cheap miss.`)
            } },
          { id: 'pass', label: 'Pass — focus on HS class', blurb: 'No cost. Recruit signs elsewhere.',
            apply: (state) => pushNews(state, `Passed on the ${fromSchool} JUCO visit. Staying focused on high schoolers.`),
          },
        ],
      }
    },
  },

  COMMITTED_RECRUIT_INJURY: {
    id: 'COMMITTED_RECRUIT_INJURY', weight: 0.25,
    // Only fire when the user has ACTUALLY signed at least one recruit
    // (per Nate, May 2026 — "this player doesn\'t exist yet"). Without
    // this gate the event invented a fake "top signee" name in week 2
    // before the user had even opened recruiting.
    condition: (state) => {
      if (!isOffseasonWeek(state)) return false
      const userId = state.userSchoolId
      return Object.values(state.recruits || {})
        .some(r => r && r.status === 'signed' && r.signedTo === userId)
    },
    builder: (state, rng) => {
      const recruit = pickSignedRecruit(state, rng)
      if (!recruit) return null
      const name = `${recruit.firstName} ${recruit.lastName}`
      const pos = recruit.primaryPosition || '?'
      // Compute the actual scholarship $ committed so the choices show
      // the real freed amount, not a placeholder.
      const scholarship = recruit.liveOffer?.amount || recruit.scholarshipOffered || 0
      const halfScholarship = Math.round(scholarship / 2)
      return {
        id: `evt_COMMITINJ_${recruit.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'COMMITTED_RECRUIT_INJURY',
        title: 'Signed Recruit Tore His ACL',
        body: `${name} (${pos}, your signed recruit at $${(scholarship / 1000).toFixed(1)}K) tore his ACL playing HS football. He\'ll miss most of next spring. Compliance says you can pull the scholarship or honor it.`,
        choices: [
          { id: 'honor-scholarship', label: 'Honor the scholarship', blurb: 'Job sec +5. Big loyalty signal. Recruiting reputation soars.',
            apply: (state) => {
              applyJobSecurity(state, +5)
              pushNews(state, `Honored ${name}\'s scholarship despite the ACL. Recruiting network noticed.`)
            } },
          { id: 'reduce-scholarship', label: 'Reduce the offer 50%', blurb: `+$${(halfScholarship / 1000).toFixed(1)}K freed from pool. He accepts the cut.`,
            apply: (state) => {
              if (state.budget?.allocations) state.budget.allocations.scholarships = (state.budget.allocations.scholarships || 0) + halfScholarship
              if (recruit.liveOffer) recruit.liveOffer.amount = scholarship - halfScholarship
              pushNews(state, `Reduced ${name}\'s scholarship 50%. -$${(halfScholarship / 1000).toFixed(1)}K freed. He accepted.`)
            } },
          { id: 'pull-scholarship', label: 'Pull the scholarship entirely', blurb: `Job sec -8. +$${(scholarship / 1000).toFixed(1)}K freed. Recruit released from commitment.`,
            apply: (state) => {
              applyJobSecurity(state, -8)
              if (state.budget?.allocations) state.budget.allocations.scholarships = (state.budget.allocations.scholarships || 0) + scholarship
              // Release the recruit so they no longer count as signed.
              recruit.status = 'lost'
              recruit.signedTo = null
              pushNews(state, `Pulled ${name}\'s scholarship after the ACL. -$${(scholarship / 1000).toFixed(1)}K freed; recruit released. Local HS coaches are furious.`)
            } },
        ],
      }
    },
  },

  LATE_BLOOMER: {
    id: 'LATE_BLOOMER', weight: 0.3,
    condition: (state) => isOffseasonWeek(state) && (state.calendar?.weekOfYear || 0) >= 5,
    builder: (state, rng) => {
      const name = rng.pick(['Wyatt Frazier', 'Levi Hartman', 'Easton Becker', 'Maddox Pruitt'])
      return {
        id: `evt_LATEBLOOM_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'LATE_BLOOMER',
        title: 'Sleeper HS Player Had a Breakout Summer',
        body: `${name}, a kid no school recruited, jumped 8 mph on his fastball this summer. His travel coach is calling around. You have one open roster spot.`,
        choices: [
          { id: 'offer-now', label: 'Make an immediate offer', blurb: 'Be first. 70% he commits to you.',
            apply: (state, rng) => {
              if (rng.chance(0.7)) { addWalkOnPlayer(state, name, 'P', rng); pushNews(state, `${name} committed — a steal of a sleeper recruit at the wire.`) }
              else pushNews(state, `${name} took a Power-5 walk-on offer instead. The right school won.`)
            } },
          { id: 'invite-camp', label: 'Invite him to fall camp', blurb: 'Cheap evaluation. 40% he commits afterward.',
            apply: (state, rng) => {
              if (rng.chance(0.4)) { addWalkOnPlayer(state, name, 'P', rng); pushNews(state, `${name} aced the camp and signed on the spot.`) }
              else pushNews(state, `${name} performed well at camp but committed elsewhere.`)
            } },
          { id: 'pass', label: 'Pass — too risky', blurb: 'No cost. Stay disciplined with the class.',
            apply: (state) => pushNews(state, `Passed on the ${name} flier. Staying with the signed class.`),
          },
        ],
      }
    },
  },

  // ── Booster / Money ─────────────────────────────────────────────────
  BOOSTER_DINNER: {
    id: 'BOOSTER_DINNER', weight: 0.4,
    condition: () => true,
    builder: (state) => ({
      id: `evt_BOOSTDIN_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'BOOSTER_DINNER',
      title: 'Two Boosters, One Night',
      body: 'Two major donors are hosting dinners on the same night. One is a board-of-trustees member ($20K/year giver). The other is a younger tech millionaire pledging to fund a new strength facility.',
      choices: [
        { id: 'trustee-dinner', label: 'Choose the trustee dinner', blurb: 'Political safety. Trustee gives extra. Tech millionaire offended.',
          apply: (state) => { if (state.budget) state.budget.totalAthleticBudget += 10000; applyJobSecurity(state, +4); pushNews(state, 'Trustee donated $10K after dinner. Tech millionaire took his money to a rival.') } },
        { id: 'tech-dinner', label: 'Choose the tech millionaire dinner', blurb: 'Bigger upside. Trustee miffed.',
          apply: (state) => { if (state.budget) state.budget.totalAthleticBudget += 25000; applyJobSecurity(state, -2); pushNews(state, 'Tech millionaire committed $25K for facilities. Trustee called the AD to complain.') } },
        { id: 'split-it', label: 'Quick stops at both', blurb: 'Diplomatic but neither feels prioritized.',
          apply: (state) => { if (state.budget) state.budget.totalAthleticBudget += 8000; pushNews(state, 'Coach split the night between both dinners. Each donor gave a token $4K.') } },
      ],
    }),
  },

  MILLION_DOLLAR_DONOR: {
    id: 'MILLION_DOLLAR_DONOR', weight: 0.1,
    condition: (state) => isOffseasonWeek(state),
    builder: (state) => ({
      id: `evt_MILDONOR_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'MILLION_DOLLAR_DONOR',
      title: 'Million-Dollar Donor Wants Naming Rights',
      body: 'A booster will donate $1M if you name the new pitching lab after his son (a former walk-on). AD wants your read.',
      choices: [
        { id: 'accept-naming', label: 'Accept the naming + the million', blurb: '+$1M budget. Some alums grumble about precedent.',
          apply: (state) => { if (state.budget) state.budget.totalAthleticBudget += 1_000_000; applyJobSecurity(state, +8); pushNews(state, '$1M donor secured — pitching lab will bear his son\'s name. AD overjoyed.') } },
        { id: 'counter', label: 'Counter — donor wall plaque only', blurb: '50% he accepts. 50% he walks.',
          apply: (state, rng) => {
            if (rng.chance(0.5)) { if (state.budget) state.budget.totalAthleticBudget += 1_000_000; applyJobSecurity(state, +5); pushNews(state, 'Donor accepted the counter — $1M secured, only a plaque required.') }
            else { applyJobSecurity(state, -2); pushNews(state, 'Donor walked. Took the money to a rival school instead.') }
          } },
        { id: 'reject', label: 'Reject — bad precedent', blurb: 'Principled. Donor takes it personally.',
          apply: (state) => { applyJobSecurity(state, -4); pushNews(state, 'Donor was rejected. Took the money to a rival school. AD livid.') } },
      ],
    }),
  },

  // ── Locker Room / Morale ────────────────────────────────────────────
  TEAM_OUTING: {
    id: 'TEAM_OUTING', weight: 0.4,
    condition: (state) => isOffseasonWeek(state),
    builder: (state) => ({
      id: `evt_OUTING_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'TEAM_OUTING',
      title: 'Captains Propose a Team Paintball Day',
      body: 'Captains want a Saturday paintball outing to build chemistry. Costs $2K from the team account; injury risk is low but non-zero.',
      choices: [
        { id: 'approve', label: 'Approve the outing', blurb: '-$2K. Team +7 happiness, captains +10 each. ~15% one player tweaks something.',
          apply: (state, rng) => {
            if (state.budget) state.budget.totalAthleticBudget = Math.max(0, state.budget.totalAthleticBudget - 2000)
            applyTeamMorale(state, +5)
            applyCaptainMorale(state, +10, 'captain pushed for the outing and loved the green light', 3)
            if (rng.chance(0.15)) { applyTeamDurability(state, -1); pushNews(state, 'Paintball outing rocked — but one player tweaked his shoulder.') }
            else pushNews(state, 'Paintball outing was a huge bonding day. Team chemistry through the roof.')
          } },
        { id: 'deny', label: 'Deny — injury risk too high', blurb: 'Team -2 happiness. Captains -8 each (they led the push).',
          apply: (state) => {
            applyTeamMorale(state, -2)
            applyCaptainMorale(state, -8, 'captain led the paintball push and feels shut down', 3)
            pushNews(state, 'Coach denied the paintball outing. Captains rolled their eyes; vets are quietly annoyed.')
          } },
        { id: 'counter-bowling', label: 'Counter-propose: bowling night', blurb: '-$800. Team +3 happiness, captains +4 each.',
          apply: (state) => {
            if (state.budget) state.budget.totalAthleticBudget -= 800
            applyTeamMorale(state, +3)
            applyCaptainMorale(state, +4, 'captain appreciated the bowling compromise', 3)
            pushNews(state, 'Bowling night replaced paintball. Tame but fun.')
          } },
      ],
    }),
  },

  VET_ROOKIE_TENSION: {
    id: 'VET_ROOKIE_TENSION', weight: 0.4,
    condition: () => true,
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_VETROOK_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'VET_ROOKIE_TENSION',
        title: 'Vets vs Rookies Tension',
        body: `Seniors are complaining about ${player.firstName} ${player.lastName} and other freshmen — say they\'re entitled and don\'t respect the program\'s grind.`,
        playerId: player.id,
        choices: [
          { id: 'side-with-vets', label: 'Make freshmen do extra grunt work', blurb: 'Job sec +1. Top vets +6 happiness, top freshmen -8.',
            apply: (state) => {
              applyJobSecurity(state, +1)
              applyCaptainMorale(state, +6, 'vets felt heard by the coach', 2, p => p.classYear === 'SR' || p.classYear === 'JR')
              applyCaptainMorale(state, -8, 'freshman stuck with extra grunt work', 2, p => p.classYear === 'FR')
              pushNews(state, 'Coach sided with the vets. Freshmen on bus-loading + equipment duty for 2 weeks.')
            } },
          { id: 'address-team', label: 'Address the team as one unit', blurb: 'Team +4 happiness. Top vets +3, top freshmen +3 (everyone feels heard).',
            apply: (state) => {
              applyTeamMorale(state, +3)
              applyCaptainMorale(state, +3, 'team meeting defused the tension', 2, p => p.classYear === 'SR' || p.classYear === 'JR')
              applyCaptainMorale(state, +3, 'freshman felt defended in the team meeting', 2, p => p.classYear === 'FR')
              pushNews(state, 'Coach addressed the team about respect and unity. Tension defused.')
            } },
          { id: 'side-with-rookies', label: 'Tell the vets to stop hazing', blurb: 'Job sec -1. Top freshmen +6, top vets -8.',
            apply: (state) => {
              applyJobSecurity(state, -1)
              applyCaptainMorale(state, +6, 'freshman felt protected by the coach', 2, p => p.classYear === 'FR')
              applyCaptainMorale(state, -8, 'vet got publicly told to back off — feels disrespected', 2, p => p.classYear === 'SR' || p.classYear === 'JR')
              pushNews(state, 'Coach defended the freshmen. Senior leaders are quietly seething.')
            } },
        ],
      }
    },
  },

  PLAYER_ENGAGEMENT: {
    id: 'PLAYER_ENGAGEMENT', weight: 0.2,
    condition: (state) => isSeasonWeek(state),
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng, p => p && (p.classYear === 'SR' || p.classYear === 'JR'))
      if (!player) return null
      return {
        id: `evt_ENGAGE_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'PLAYER_ENGAGEMENT',
        title: 'Senior Just Got Engaged',
        body: `${player.firstName} ${player.lastName} got engaged over the weekend. He\'s asking to skip Friday\'s travel for a Saturday rehearsal dinner; he\'d fly in for the Saturday game.`,
        playerId: player.id,
        choices: [
          { id: 'grant-permission', label: 'Grant the exception', blurb: 'Life > baseball moment. +Loyalty.',
            apply: (state) => { applyPlayerMorale(player, +12); applyTeamMorale(state, +1); pushNews(state, `Coach gave ${player.firstName} ${player.lastName} the engagement-weekend exception. Team applauded the call.`) } },
          { id: 'no-exceptions', label: 'No exceptions — team policy', blurb: 'Old-school. Player + fiancée upset.',
            apply: (state) => { applyPlayerMorale(player, -15); pushNews(state, `Coach denied the engagement-weekend exception. Player\'s fiancée called the AD.`) } },
        ],
      }
    },
  },

  // ── Academic / Compliance ───────────────────────────────────────────
  MAJOR_CHANGE_REQUEST: {
    id: 'MAJOR_CHANGE_REQUEST', weight: 0.3,
    condition: (state) => isOffseasonWeek(state),
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      const newMajor = rng.pick(['Engineering', 'Nursing', 'Pre-Med', 'Architecture'])
      return {
        id: `evt_MAJOR_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'MAJOR_CHANGE_REQUEST',
        title: 'Player Wants to Change Major',
        body: `${player.firstName} ${player.lastName} wants to switch to ${newMajor}. The schedule conflicts with afternoon practice 2x a week. He says he\'ll quit baseball before he gives up the major.`,
        playerId: player.id,
        choices: [
          { id: 'allow-flex', label: 'Allow flexible practice schedule', blurb: 'Player buys in. Other guys notice the special treatment.',
            apply: (state) => { applyPlayerMorale(player, +12); applyTeamMorale(state, -2); pushNews(state, `${player.firstName} ${player.lastName} got a flex schedule for ${newMajor}. Vets noticed.`) } },
          { id: 'no-exception', label: 'Practice attendance is mandatory', blurb: '50% he stays, 50% he quits.',
            apply: (state, rng) => {
              if (rng.chance(0.5)) { applyPlayerMorale(player, -8); pushNews(state, `${player.firstName} ${player.lastName} chose ${newMajor} over baseball. Off the roster.`); const t = state.teams[state.userSchoolId]; t.rosterPlayerIds = (t.rosterPlayerIds || []).filter(id => id !== player.id); player.eligibilityStatus = 'quit' }
              else { applyPlayerMorale(player, -5); pushNews(state, `${player.firstName} ${player.lastName} grudgingly stayed in his current major to keep playing.`) }
            } },
        ],
      }
    },
  },

  STUDY_HALL_SKIPS: {
    id: 'STUDY_HALL_SKIPS', weight: 0.3,
    condition: (state) => isSeasonWeek(state) || isOffseasonWeek(state),
    builder: (state) => ({
      id: `evt_STUDY_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'STUDY_HALL_SKIPS',
      title: '6 Players Skipping Study Hall',
      body: 'Academic advisor says six players have skipped mandatory study hall multiple times. GPAs are slipping. AD wants accountability.',
      choices: [
        { id: 'team-suspension', label: 'Suspend all 6 for a game', blurb: 'Hard line. Vets respect it.',
          apply: (state) => { applyTeamMorale(state, -3); applyJobSecurity(state, +3); pushNews(state, '6 players suspended one game for skipping study hall. Message sent.') } },
        { id: 'extra-study-hall', label: 'Mandatory 6 AM study hall for a month', blurb: 'Painful but no game-day cost.',
          apply: (state) => { applyTeamMorale(state, -1); pushNews(state, 'Six study-hall skippers now have mandatory 6 AM study sessions. They hate it.') } },
        { id: 'individual-talks', label: 'Individual conversations', blurb: 'Person-to-person. 70% it sticks.',
          apply: (state, rng) => {
            if (rng.chance(0.7)) { applyJobSecurity(state, +1); pushNews(state, 'Individual study-hall talks landed. Attendance corrected.') }
            else { applyJobSecurity(state, -2); pushNews(state, 'Individual talks didn\'t stick. Two of the six failed midterms.') }
          } },
      ],
    }),
  },

  // ── Travel / Weather / Facilities ───────────────────────────────────
  CHARTER_FLIGHT_OFFER: {
    id: 'CHARTER_FLIGHT_OFFER', weight: 0.25,
    // Charters only make sense at flying programs (D1/D2).
    condition: (state) => isSeasonWeek(state) && isFlyingProgram(state),
    builder: (state) => ({
      id: `evt_CHARTER_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'CHARTER_FLIGHT_OFFER',
      title: 'Booster Offers $30K Toward a Charter',
      body: 'A booster offers to cover $30K of a $50K charter for your toughest road trip — but only if you publicly thank him at the next home game.',
      choices: [
        { id: 'accept', label: 'Accept + public thank-you', blurb: '-$20K travel, +rest day for players. Booster gets the spotlight.',
          apply: (state) => { if (state.budget?.allocations) state.budget.allocations.travel = (state.budget.allocations.travel || 0) + 20000; applyTeamDurability(state, +2); applyJobSecurity(state, +2); pushNews(state, 'Booster\'s charter offer accepted. Team flies in style; booster got his public moment.') } },
        { id: 'decline', label: 'Decline — stay on the bus', blurb: 'Save the money. Players grumble.',
          apply: (state) => { applyTeamMorale(state, -2); pushNews(state, 'Coach declined the charter offer. Booster will remember.') } },
      ],
    }),
  },

  TURF_INSTALL: {
    id: 'TURF_INSTALL', weight: 0.15,
    // $400K turf install only fits programs with the budget — D3 + NWAC budgets are too small.
    condition: (state) => isOffseasonWeek(state) && (state.level === 'D1' || state.level === 'D2' || state.level === 'NAIA'),
    builder: (state) => ({
      id: `evt_TURF_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'TURF_INSTALL',
      title: 'AD Asking About Turf Install',
      body: 'AD proposes installing turf instead of grass. $400K upfront cost — funded over 3 years from your budget. Cuts groundskeeping cost; some traditionalists hate it.',
      choices: [
        { id: 'support', label: 'Support the turf install', blurb: '-$130K/yr for 3 years. Long-term savings + fewer rainouts.',
          apply: (state) => { if (state.budget) state.budget.totalAthleticBudget -= 130000; applyJobSecurity(state, +3); pushNews(state, 'Turf install approved. -$130K this year, but fewer rainouts ahead.') } },
        { id: 'oppose', label: 'Oppose — keep grass', blurb: 'Traditionalist call. AD frustrated.',
          apply: (state) => { applyJobSecurity(state, -3); pushNews(state, 'Coach opposed the turf install. AD overruled — went with grass for now.') } },
      ],
    }),
  },

  EXTREME_HEAT: {
    id: 'EXTREME_HEAT', weight: 0.3,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_HEAT_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'EXTREME_HEAT',
      title: 'Heat Advisory for Game Day',
      body: 'Forecast: 102°F at first pitch. Trainer wants you to push the start to 6 PM. Conference says it\'s your call but you\'ll absorb any costs.',
      choices: [
        { id: 'push-late', label: 'Push to 6 PM', blurb: '-$1.5K stadium ops. Safer for players.',
          apply: (state) => { if (state.budget) state.budget.totalAthleticBudget -= 1500; applyTeamDurability(state, +2); pushNews(state, 'Coach pushed first pitch to 6 PM. Players grateful; staff overtime cost absorbed.') } },
        { id: 'play-on-time', label: 'Play on time — toughen up', blurb: 'Higher cramp/injury risk.',
          apply: (state, rng) => {
            if (rng.chance(0.5)) { applyTeamDurability(state, -2); pushNews(state, 'Played the heat game on time. Three players cramped, one DH\'d out.') }
            else pushNews(state, 'Played through 102°F heat. Everyone survived.')
          } },
      ],
    }),
  },

  // ── Career / Staff ──────────────────────────────────────────────────
  PROMOTION_RUMOR: {
    id: 'PROMOTION_RUMOR', weight: 0.3,
    condition: (state) => isOffseasonWeek(state),
    builder: (state) => ({
      id: `evt_PROMOTRUM_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'PROMOTION_RUMOR',
      title: 'Reporter Asks About a Higher-Level Job',
      body: 'A local reporter heard you\'re being considered for a higher-level HC job. Asks if you\'d ever leave. Your players might be reading this.',
      choices: [
        { id: 'fully-committed', label: 'Say you\'re fully committed here', blurb: 'Reassures the team. Might bite you if you do leave.',
          apply: (state) => { applyTeamMorale(state, +4); applyJobSecurity(state, +2); pushNews(state, 'Coach publicly recommitted to the school. Team applauded.') } },
        { id: 'classy-deflect', label: 'Deflect — "I\'m focused on next year"', blurb: 'Vague. Leaves options open.',
          apply: (state) => pushNews(state, 'Coach gave the standard "focused on next year" deflection. Reporter ran with it anyway.') },
        { id: 'admit-flattered', label: 'Admit you\'re flattered', blurb: 'Honest. Team will wonder.',
          apply: (state) => { applyTeamMorale(state, -3); applyJobSecurity(state, -1); pushNews(state, 'Coach admitted being flattered by interest. Locker room is murmuring.') } },
      ],
    }),
  },

  AD_PRESSURE: {
    id: 'AD_PRESSURE', weight: 0.3,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_ADPRESS_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'AD_PRESSURE',
      title: 'AD Wants a Quick Meeting',
      body: 'AD pulled you into his office. Wants a specific roster decision — bench a struggling veteran the AD doesn\'t personally like.',
      choices: [
        { id: 'cave', label: 'Cave to the AD\'s wishes', blurb: 'Politically smart. Veteran is furious.',
          apply: (state) => { applyJobSecurity(state, +5); applyTeamMorale(state, -4); pushNews(state, 'Coach benched the veteran at AD\'s suggestion. Team noticed the political call.') } },
        { id: 'push-back', label: 'Push back — the call is yours', blurb: 'Big risk. AD respects strength or fires you.',
          apply: (state, rng) => {
            if (rng.chance(0.5)) { applyJobSecurity(state, +5); pushNews(state, 'Coach told the AD to back off lineup decisions. AD respected it.') }
            else { applyJobSecurity(state, -10); pushNews(state, 'Coach\'s pushback to the AD turned cold. Job security tanking.') }
          } },
      ],
    }),
  },

  GA_HIRE: {
    id: 'GA_HIRE', weight: 0.25,
    condition: (state) => isOffseasonWeek(state),
    builder: (state, rng) => {
      const name = rng.pick(['Drew Halverson', 'Marcus Tate', 'Eli Sosa', 'Brandon Petty'])
      return {
        id: `evt_GAHIRE_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'GA_HIRE',
        title: 'Graduate Assistant Application',
        body: `${name}, a sharp grad assistant candidate, would join for $5K/yr. Frees up your time, helps with film + scouting.`,
        choices: [
          { id: 'hire', label: `Hire ${name}`, blurb: '-$5K, +AP each week, +developer rating long-term.',
            apply: (state) => { if (state.budget?.allocations) state.budget.allocations.coachingSalaries = (state.budget.allocations.coachingSalaries || 0) + 5000; if (state.ap) state.ap.weeklyBaseline = (state.ap.weeklyBaseline || 30) + 3; applyJobSecurity(state, +2); pushNews(state, `${name} hired as GA. Weekly AP +3.`) } },
          { id: 'pass', label: 'Pass — stretch staff handles it', blurb: 'Save the money.',
            apply: (state) => pushNews(state, `Passed on the GA candidate. Staff stays small.`),
          },
        ],
      }
    },
  },

  // ── Medical / Injury ────────────────────────────────────────────────
  PLAYER_GOFUNDME: {
    id: 'PLAYER_GOFUNDME', weight: 0.2,
    condition: () => true,
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_GOFUND_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'PLAYER_GOFUNDME',
        title: 'Player Started a GoFundMe',
        body: `${player.firstName} ${player.lastName}\'s mom is undergoing cancer treatment. He started a GoFundMe — team is asking what to do.`,
        playerId: player.id,
        choices: [
          { id: 'team-rally', label: 'Coach + team donate publicly', blurb: '-$2K team account, +huge morale.',
            apply: (state) => { if (state.budget) state.budget.totalAthleticBudget -= 2000; applyTeamMorale(state, +8); applyPlayerMorale(player, +20); applyJobSecurity(state, +4); pushNews(state, `Team raised $2K for ${player.firstName} ${player.lastName}\'s family. Locker room bonded.`) } },
          { id: 'share-quietly', label: 'Share quietly with staff', blurb: 'Private support, no team-wide push.',
            apply: (state) => { applyPlayerMorale(player, +6); pushNews(state, `Coaching staff donated privately to ${player.firstName} ${player.lastName}\'s GoFundMe.`) } },
          { id: 'stay-out', label: 'Stay out — NCAA rules tricky', blurb: 'Compliance-safe. Player feels alone.',
            apply: (state) => { applyPlayerMorale(player, -10); pushNews(state, `Coach stayed out of ${player.firstName} ${player.lastName}\'s GoFundMe over compliance worry. Player feels unsupported.`) } },
        ],
      }
    },
  },

  CONCUSSION_PROTOCOL: {
    id: 'CONCUSSION_PROTOCOL', weight: 0.3,
    condition: (state) => isSeasonWeek(state),
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_CONCUSS_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'CONCUSSION_PROTOCOL',
        title: 'Possible Concussion',
        body: `${player.firstName} ${player.lastName} took a fastball off the helmet. Says he\'s fine but trainer\'s tests are inconclusive. Big game tomorrow.`,
        playerId: player.id,
        choices: [
          { id: 'protocol', label: 'Full concussion protocol — 7 days out', blurb: 'Safest. Player misses the rivalry game.',
            apply: (state) => { applyPlayerMorale(player, +5); applyJobSecurity(state, +2); pushNews(state, `${player.firstName} ${player.lastName} placed in concussion protocol. Out 7 days.`); player._minorInjuryFlag = { weeks: 1, year: state.calendar.year } } },
          { id: 'play-if-clear', label: 'Re-test tomorrow, play if cleared', blurb: '50% he passes. 50% protocol kicks in late.',
            apply: (state, rng) => {
              if (rng.chance(0.5)) pushNews(state, `${player.firstName} ${player.lastName} passed re-test. Cleared for the rivalry game.`)
              else { player._minorInjuryFlag = { weeks: 1, year: state.calendar.year }; pushNews(state, `Failed re-test next morning. ${player.firstName} ${player.lastName} ruled out late.`) }
            } },
          { id: 'play-no-protocol', label: 'Play him — he says he\'s fine', blurb: 'Big optics + medical risk.',
            apply: (state, rng) => {
              if (rng.chance(0.25)) { applyJobSecurity(state, -10); applyPlayerMorale(player, -5); pushNews(state, `${player.firstName} ${player.lastName}\'s symptoms returned mid-game. Pulled. Compliance is asking questions.`) }
              else pushNews(state, `${player.firstName} ${player.lastName} played through. No symptoms. Lucky.`)
            } },
        ],
      }
    },
  },

  // ── PR / Media ──────────────────────────────────────────────────────
  BEAT_REPORTER_BOOK: {
    id: 'BEAT_REPORTER_BOOK', weight: 0.2,
    condition: (state) => isOffseasonWeek(state),
    builder: (state) => ({
      id: `evt_BOOK_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'BEAT_REPORTER_BOOK',
      title: 'Beat Reporter Writing a Book',
      body: 'The veteran beat reporter is writing a book on the program\'s history. Wants 6 hours of your time + locker-room access. Could be great PR; could backfire.',
      choices: [
        { id: 'full-access', label: 'Full cooperation', blurb: 'Big upside if the book is positive. Real downside if not.',
          apply: (state, rng) => {
            if (rng.chance(0.6)) { applyJobSecurity(state, +6); pushNews(state, 'Beat reporter\'s book launched. Coach comes off looking great.') }
            else { applyJobSecurity(state, -5); pushNews(state, 'Beat reporter\'s book had unflattering quotes from past assistants. Bad week.') }
          } },
        { id: 'limited-access', label: 'Interviews only — no locker room', blurb: 'Safer. Reporter respects the line.',
          apply: (state) => { applyJobSecurity(state, +2); pushNews(state, 'Coach gave the beat reporter on-the-record interviews. Book was balanced.') } },
        { id: 'decline', label: 'Decline entirely', blurb: 'Reporter writes it anyway, with rumors.',
          apply: (state) => { applyJobSecurity(state, -3); pushNews(state, 'Coach declined cooperation. Reporter\'s book ran with rival-source quotes.') } },
      ],
    }),
  },

  HIGH_SCHOOL_CLINIC: {
    id: 'HIGH_SCHOOL_CLINIC', weight: 0.3,
    condition: (state) => isOffseasonWeek(state),
    builder: (state) => ({
      id: `evt_HSCLINIC_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'HIGH_SCHOOL_CLINIC',
      title: 'High School Clinic Invite',
      body: 'A local HS wants you to run a Saturday clinic for their varsity. Free, but eats a weekend. Builds recruiting pipeline.',
      choices: [
        { id: 'run-clinic', label: 'Run the clinic', blurb: '+$2K recruiting budget bump; +relationships with HS coaches.',
          apply: (state) => { if (state.budget?.allocations) state.budget.allocations.recruiting = (state.budget.allocations.recruiting || 0) + 2000; applyJobSecurity(state, +2); pushNews(state, 'Coach ran the HS clinic. Local pipeline strengthened.') } },
        { id: 'send-assistants', label: 'Send your assistants', blurb: 'Cheap delegation. Half the upside.',
          apply: (state) => { applyJobSecurity(state, +1); pushNews(state, 'Assistants ran the HS clinic. Decent reception.') } },
        { id: 'decline', label: 'Decline — focused on team', blurb: 'Save the time. Local HS coaches notice.',
          apply: (state) => { applyJobSecurity(state, -1); pushNews(state, 'Coach declined the HS clinic. Local HS coaches noted it.') } },
      ],
    }),
  },

  // ── Big Picture / Wild Cards ────────────────────────────────────────
  PLAYER_NIL_BACKLASH: {
    id: 'PLAYER_NIL_BACKLASH', weight: 0.2,
    condition: (state) => state.schools?.[state.userSchoolId]?.level === 'D1',
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      return {
        id: `evt_NILBACK_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'PLAYER_NIL_BACKLASH',
        title: 'NIL Backlash from Teammates',
        body: `${player.firstName} ${player.lastName}\'s $40K NIL deal has the rest of the locker room frustrated. Vets feel he\'s acting bigger than the team.`,
        playerId: player.id,
        choices: [
          { id: 'team-meeting', label: 'Team meeting about NIL', blurb: 'Defuse the tension head-on.',
            apply: (state) => { applyTeamMorale(state, +4); pushNews(state, 'Coach held a team meeting about NIL realities. Tension defused.') } },
          { id: 'pull-aside', label: 'Pull NIL star aside privately', blurb: 'Quiet correction. Player either grows up or sulks.',
            apply: (state, rng) => {
              if (rng.chance(0.65)) { applyPlayerMorale(player, +5); pushNews(state, `${player.firstName} ${player.lastName} took the talk well — re-engaged with vets.`) }
              else { applyPlayerMorale(player, -10); applyTeamMorale(state, -3); pushNews(state, `${player.firstName} ${player.lastName} didn\'t take the talk well. Tension worse.`) }
            } },
          { id: 'let-it-ride', label: 'Let it ride — NIL is part of the game', blurb: 'Hands-off. Tension may fester.',
            apply: (state) => { applyTeamMorale(state, -5); pushNews(state, 'Coach stayed out of the NIL backlash. Locker room is splintered.') } },
        ],
      }
    },
  },

  POSTSEASON_FREE_BOOZE: {
    id: 'POSTSEASON_FREE_BOOZE', weight: 0.3,
    condition: (state) => isPostseasonWeek(state),
    builder: (state) => ({
      id: `evt_POSTBOOZE_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'POSTSEASON_FREE_BOOZE',
      title: 'Boosters Buy the Team Drinks',
      body: 'After a postseason win, a booster paid the bar tab for the seniors at the team hotel. Curfew is in 30 minutes. Trainer is concerned.',
      choices: [
        { id: 'allow-one', label: 'One drink each, then curfew', blurb: 'Reasonable compromise. Most players appreciate it.',
          apply: (state) => { applyTeamMorale(state, +5); pushNews(state, 'Coach allowed one drink each before curfew. Seniors loved it; trainer kept the peace.') } },
        { id: 'shut-it-down', label: 'Shut it down — postseason discipline', blurb: 'Strict but professional.',
          apply: (state) => { applyTeamMorale(state, -2); applyJobSecurity(state, +2); pushNews(state, 'Coach shut down the postseason drinks. Seniors grumbled.') } },
        { id: 'look-other-way', label: 'Look the other way', blurb: 'Risky. Curfew breakers + possible hangovers.',
          apply: (state, rng) => {
            if (rng.chance(0.5)) { applyTeamDurability(state, -2); pushNews(state, 'Looked the other way on postseason drinks. Two players were hungover the next morning.') }
            else { applyTeamMorale(state, +6); pushNews(state, 'Coach looked the other way. Seniors bonded over a great night, no consequences.') }
          } },
      ],
    }),
  },

  SCANDAL_RUMOR: {
    id: 'SCANDAL_RUMOR', weight: 0.15,
    condition: () => true,
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng)
      if (!player) return null
      const rumor = rng.pick([
        'using performance-enhancing supplements', 'gambling on his own team', 'taking improper benefits from a booster',
      ])
      return {
        id: `evt_SCANDAL_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'SCANDAL_RUMOR',
        title: 'Anonymous Tip on a Player',
        body: `An anonymous email to compliance accuses ${player.firstName} ${player.lastName} of ${rumor}. Compliance asks how you want to handle it.`,
        playerId: player.id,
        choices: [
          { id: 'investigate-internally', label: 'Investigate internally first', blurb: '50% the tip is bogus. 50% it\'s real and you\'ll have to act.',
            apply: (state, rng) => {
              if (rng.chance(0.5)) { applyJobSecurity(state, +3); pushNews(state, `Internal investigation cleared ${player.firstName} ${player.lastName}. Tip was bogus.`) }
              else { applyJobSecurity(state, -8); player.eligibilityStatus = 'ineligible'; pushNews(state, `Internal investigation confirmed the tip. ${player.firstName} ${player.lastName} now ineligible.`) }
            } },
          { id: 'send-to-ncaa', label: 'Report to NCAA immediately', blurb: 'Maximum transparency. Lose the player guaranteed if true.',
            apply: (state, rng) => {
              if (rng.chance(0.5)) pushNews(state, `NCAA cleared ${player.firstName} ${player.lastName}. Coach earned compliance credibility.`)
              else { player.eligibilityStatus = 'ineligible'; applyJobSecurity(state, +1); pushNews(state, `NCAA confirmed the tip. ${player.firstName} ${player.lastName} ineligible. Coach\'s transparency noted.`) }
            } },
          { id: 'ignore-tip', label: 'Ignore the anonymous tip', blurb: 'Risky if true. Compliance might find out later.',
            apply: (state, rng) => {
              if (rng.chance(0.6)) pushNews(state, `Tip ignored, never resurfaced. Quiet outcome.`)
              else { applyJobSecurity(state, -15); pushNews(state, `Ignored tip resurfaced 3 weeks later — coach in hot water for not following protocol.`) }
            } },
        ],
      }
    },
  },

  TRANSFER_PORTAL_BIG_LOSS: {
    id: 'TRANSFER_PORTAL_BIG_LOSS', weight: 0.25,
    condition: (state) => isOffseasonWeek(state) && (state.calendar?.weekOfYear || 0) >= 14,
    builder: (state, rng) => {
      const player = pickRandomRosterPlayer(state, rng, p => p && p.classYear !== 'SR' && p.classYear !== 'FR')
      if (!player) return null
      return {
        id: `evt_PORTOUT_${player.id}_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'TRANSFER_PORTAL_BIG_LOSS',
        title: 'Star is Visiting Other Schools',
        body: `${player.firstName} ${player.lastName}, your starter at his position, is in the portal taking visits. He\'s asking what you can offer to bring him back.`,
        playerId: player.id,
        choices: [
          { id: 'big-counter', label: 'Counter with $5K scholarship + role', blurb: 'Expensive. 70% he stays.',
            apply: (state, rng) => {
              if (state.budget?.allocations) state.budget.allocations.scholarships = Math.max(0, (state.budget.allocations.scholarships || 0) - 5000)
              if (rng.chance(0.7)) { applyPlayerMorale(player, +10); pushNews(state, `${player.firstName} ${player.lastName} pulled his name out of the portal — returning.`) }
              else { const t = state.teams[state.userSchoolId]; t.rosterPlayerIds = (t.rosterPlayerIds || []).filter(id => id !== player.id); player.eligibilityStatus = 'transferred'; pushNews(state, `${player.firstName} ${player.lastName} took a better offer elsewhere. -$5K spent, still gone.`) }
            } },
          { id: 'fair-warning', label: 'Wish him well — no counter', blurb: 'Save the scholarship money. Probably lose him.',
            apply: (state, rng) => {
              if (rng.chance(0.85)) { const t = state.teams[state.userSchoolId]; t.rosterPlayerIds = (t.rosterPlayerIds || []).filter(id => id !== player.id); player.eligibilityStatus = 'transferred'; pushNews(state, `${player.firstName} ${player.lastName} transferred out. Coach wished him well.`) }
              else pushNews(state, `${player.firstName} ${player.lastName} surprisingly came back without a counter. Loyalty win.`)
            } },
          { id: 'guilt-trip', label: 'Lay on the loyalty pressure', blurb: '30% effective. Bad look if it leaks.',
            apply: (state, rng) => {
              if (rng.chance(0.3)) { applyPlayerMorale(player, -5); pushNews(state, `${player.firstName} ${player.lastName} reluctantly stayed. Relationship strained.`) }
              else { const t = state.teams[state.userSchoolId]; t.rosterPlayerIds = (t.rosterPlayerIds || []).filter(id => id !== player.id); player.eligibilityStatus = 'transferred'; applyJobSecurity(state, -3); pushNews(state, `${player.firstName} ${player.lastName} went public about the guilt-trip tactics. Bad look.`) }
            } },
        ],
      }
    },
  },

  POSITION_BATTLE_DRAMA: {
    id: 'POSITION_BATTLE_DRAMA', weight: 0.35,
    condition: (state) => isOffseasonWeek(state) && (state.calendar?.weekOfYear || 0) >= 18,
    builder: (state, rng) => {
      const p1 = pickRandomRosterPlayer(state, rng)
      const p2 = pickRandomRosterPlayer(state, rng, p => p && p.id !== p1?.id)
      if (!p1 || !p2) return null
      return {
        id: `evt_POSBATTLE_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'POSITION_BATTLE_DRAMA',
        title: 'Spring Position Battle Got Personal',
        body: `Two of your guys — ${p1.firstName} ${p1.lastName} and ${p2.firstName} ${p2.lastName} — are competing for the same starting spot. It\'s gotten tense. Locker room is taking sides.`,
        choices: [
          { id: 'open-competition', label: 'Open competition through spring', blurb: 'Fair. Loser will not be happy.',
            apply: (state, rng) => {
              const winner = rng.chance(0.5) ? p1 : p2
              const loser = winner === p1 ? p2 : p1
              applyPlayerMorale(winner, +6); applyPlayerMorale(loser, -8)
              pushNews(state, `Open spring competition decided in favor of ${winner.firstName} ${winner.lastName}. ${loser.firstName} ${loser.lastName} stewing.`)
            } },
          { id: 'decide-now', label: 'Decide now — pick a starter', blurb: 'Avoid the drama. Other guy may transfer.',
            apply: (state, rng) => {
              const winner = rng.chance(0.5) ? p1 : p2
              const loser = winner === p1 ? p2 : p1
              applyPlayerMorale(winner, +10); applyPlayerMorale(loser, -15)
              if (rng.chance(0.3)) { const t = state.teams[state.userSchoolId]; t.rosterPlayerIds = (t.rosterPlayerIds || []).filter(id => id !== loser.id); loser.eligibilityStatus = 'transferred'; pushNews(state, `${winner.firstName} ${winner.lastName} given the job. ${loser.firstName} ${loser.lastName} transferred out.`) }
              else pushNews(state, `${winner.firstName} ${winner.lastName} given the job early. ${loser.firstName} ${loser.lastName} unhappy but staying.`)
            } },
          { id: 'platoon', label: 'Platoon them by handedness', blurb: 'Both get reps. Neither feels fully established.',
            apply: (state) => { applyPlayerMorale(p1, -2); applyPlayerMorale(p2, -2); pushNews(state, `${p1.firstName} ${p1.lastName} and ${p2.firstName} ${p2.lastName} platooning. Neither thrilled.`) } },
        ],
      }
    },
  },

  TRAINER_BURNOUT: {
    id: 'TRAINER_BURNOUT', weight: 0.15,
    condition: (state) => isSeasonWeek(state),
    builder: (state) => ({
      id: `evt_TRAINER_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'TRAINER_BURNOUT',
      title: 'Head Trainer is Burned Out',
      body: 'Your head trainer says he\'s drowning — 17-hour days, three injured starters, and the AD won\'t approve a 2nd trainer. He\'s threatening to quit mid-season.',
      choices: [
        { id: 'lobby-AD', label: 'Lobby the AD for a 2nd trainer', blurb: '60% AD approves. -$6K coaching salaries.',
          apply: (state, rng) => {
            if (rng.chance(0.6)) { if (state.budget?.allocations) state.budget.allocations.coachingSalaries = (state.budget.allocations.coachingSalaries || 0) + 6000; applyTeamDurability(state, +2); pushNews(state, 'AD approved a 2nd trainer. Workload eased.') }
            else { applyJobSecurity(state, -1); pushNews(state, 'AD denied the 2nd trainer. Head trainer fuming.') }
          } },
        { id: 'private-bonus', label: 'Pay him a $3K bonus from your budget', blurb: 'Personal gesture. -$3K.',
          apply: (state) => { if (state.budget) state.budget.totalAthleticBudget = Math.max(0, state.budget.totalAthleticBudget - 3000); applyTeamMorale(state, +3); pushNews(state, 'Trainer got a $3K personal bonus. Stayed on. Coach\'s loyalty noted.') } },
        { id: 'tough-love', label: 'Tell him to grind through it', blurb: 'High risk he walks.',
          apply: (state, rng) => {
            if (rng.chance(0.4)) { applyTeamDurability(state, -3); applyJobSecurity(state, -5); pushNews(state, 'Head trainer quit mid-season. Players are getting taped by interns.') }
            else pushNews(state, 'Trainer grumbled but stayed. Bad blood.')
          } },
      ],
    }),
  },

  WILDCARD_SCOUT_OFFER: {
    id: 'WILDCARD_SCOUT_OFFER', weight: 0.15,
    condition: (state) => isOffseasonWeek(state),
    builder: (state) => ({
      id: `evt_SCOUT_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'WILDCARD_SCOUT_OFFER',
      title: 'MLB Scout Asks for Inside Access',
      body: 'An MLB regional scout wants pre-draft access to your top JR + SR. Will pay $5K in "consultant fees" to the program — borderline NCAA-legal.',
      choices: [
        { id: 'accept-quietly', label: 'Accept — funnel through the foundation', blurb: '+$5K. 40% NCAA notices.',
          apply: (state, rng) => {
            if (state.budget) state.budget.totalAthleticBudget += 5000
            if (rng.chance(0.4)) { applyJobSecurity(state, -10); pushNews(state, 'NCAA flagged the consultant fee arrangement. Compliance is investigating.') }
            else pushNews(state, '$5K consultant fee accepted quietly. Scout got his access.') },
          },
        { id: 'refuse', label: 'Refuse — too gray', blurb: 'Compliance-safe. Scout finds another school.',
          apply: (state) => { applyJobSecurity(state, +2); pushNews(state, 'Coach refused the consultant arrangement. Scout went to a rival school.') } },
      ],
    }),
  },

  FORMER_PLAYER_VISIT: {
    id: 'FORMER_PLAYER_VISIT', weight: 0.3,
    condition: (state) => isSeasonWeek(state) || (isOffseasonWeek(state) && (state.calendar?.weekOfYear || 0) >= 14),
    builder: (state, rng) => {
      const name = rng.pick(['Wade Carson', 'Trent Holloway', 'Brett Andrews', 'Sam Patel'])
      const league = rng.pick(['Triple-A', 'Double-A', 'the Mets organization', 'an indy ball team'])
      return {
        id: `evt_ALUMVISIT_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'FORMER_PLAYER_VISIT',
        title: 'Former Player Stops By',
        body: `${name}, an alum playing in ${league}, is in town for a few days. He wants to throw with the team and tell his story.`,
        choices: [
          { id: 'big-event', label: 'Make it a team event', blurb: 'Big morale boost. Alum feels respected.',
            apply: (state) => { applyTeamMorale(state, +6); applyJobSecurity(state, +2); pushNews(state, `Made ${name}\'s visit a team event. Players were locked in.`) } },
          { id: 'private-mentor', label: 'Pair him with 2-3 prospects privately', blurb: 'Smaller scope. Real mentoring.',
            apply: (state) => { applyTeamMorale(state, +2); pushNews(state, `${name} mentored 3 prospects privately. Quiet impact.`) } },
          { id: 'busy-week', label: 'Polite "we\'re too busy"', blurb: 'Pass. Alum is hurt.',
            apply: (state) => { applyJobSecurity(state, -2); pushNews(state, `Turned ${name} down. He posted a passive-aggressive tweet about it.`) } },
        ],
      }
    },
  },

  NCAA_AUDIT: {
    id: 'NCAA_AUDIT', weight: 0.12,
    condition: () => true,
    builder: (state) => ({
      id: `evt_AUDIT_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'NCAA_AUDIT',
      title: 'Random NCAA Compliance Audit',
      body: 'NCAA picked your program for a random recruiting-compliance audit. Three weeks of paperwork review and an on-site interview.',
      choices: [
        { id: 'full-cooperation', label: 'Full cooperation, all hands on deck', blurb: 'Slow + painful. Clean exit guaranteed.',
          apply: (state) => { applyJobSecurity(state, +5); applyTeamMorale(state, -1); pushNews(state, 'NCAA audit closed clean. Three weeks of paperwork worth it.') } },
        { id: 'delegate-to-compliance', label: 'Hand it off to the compliance office', blurb: 'Time-saver. 30% something gets missed.',
          apply: (state, rng) => {
            if (rng.chance(0.3)) { applyJobSecurity(state, -12); pushNews(state, 'NCAA audit found two minor recruiting violations. Program on probation.') }
            else { applyJobSecurity(state, +2); pushNews(state, 'Compliance handled the audit cleanly. Coach kept his focus on the team.') }
          } },
      ],
    }),
  },

  PRACTICE_FACILITY_DOUBLE_BOOK: {
    id: 'PRACTICE_FACILITY_DOUBLE_BOOK', weight: 0.25,
    condition: (state) => isOffseasonWeek(state),
    builder: (state) => ({
      id: `evt_FACBOOK_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'PRACTICE_FACILITY_DOUBLE_BOOK',
      title: 'Indoor Facility Double-Booked',
      body: 'The athletic department double-booked the indoor facility — your team and the soccer team both have it Saturday at 9 AM.',
      choices: [
        { id: 'demand-priority', label: 'Demand priority — you booked first', blurb: 'Hardline. AD will side with you, soccer is mad.',
          apply: (state) => { applyJobSecurity(state, +1); pushNews(state, 'Coach demanded priority for the indoor facility. Soccer coach is fuming.') } },
        { id: 'split-time', label: 'Split the time — 4 hours each', blurb: 'Diplomatic. Half the practice volume.',
          apply: (state) => { applyTeamMorale(state, -1); pushNews(state, 'Indoor facility split with soccer. Practice cut short.') } },
        { id: 'practice-outside', label: 'Practice outside in the rain', blurb: 'Old-school grit. Risk of cramps + minor injuries.',
          apply: (state, rng) => {
            if (rng.chance(0.3)) { applyTeamDurability(state, -1); pushNews(state, 'Outdoor practice in the rain — 2 players sick by Monday.') }
            else { applyTeamMorale(state, +3); pushNews(state, 'Outdoor practice in the rain became a bonding moment.') }
          } },
      ],
    }),
  },

  STRENGTH_COACH_OFFER: {
    id: 'STRENGTH_COACH_OFFER', weight: 0.2,
    condition: (state) => isOffseasonWeek(state),
    builder: (state, rng) => {
      const name = rng.pick(['Greg Tomas', 'Ryan Marburger', 'Jared Pinto'])
      return {
        id: `evt_SC_${state.calendar.year}_${state.calendar.weekOfYear}`,
        templateId: 'STRENGTH_COACH_OFFER',
        title: 'Big-Time Strength Coach Available',
        body: `${name}, a former MLB S&C coach, is on the market. He\'d cost $25K/year — 60% above what you pay your current guy. Could transform player durability.`,
        choices: [
          { id: 'hire', label: 'Hire him — fire the current guy', blurb: '-$25K coaching salaries. +Durability long-term.',
            apply: (state) => { if (state.budget?.allocations) state.budget.allocations.coachingSalaries = (state.budget.allocations.coachingSalaries || 0) + 25000; applyTeamDurability(state, +3); applyJobSecurity(state, +2); pushNews(state, `${name} hired as new S&C coach. Old guy let go. Players already noticing improvement.`) } },
          { id: 'negotiate', label: 'Try to bring him for $15K', blurb: '40% he accepts the lower rate.',
            apply: (state, rng) => {
              if (rng.chance(0.4)) { if (state.budget?.allocations) state.budget.allocations.coachingSalaries = (state.budget.allocations.coachingSalaries || 0) + 15000; applyTeamDurability(state, +2); pushNews(state, `${name} accepted the lower rate ($15K). Bargain hire.`) }
              else pushNews(state, `${name} declined the lower rate. Went to a Power-5 school.`)
            } },
          { id: 'pass', label: 'Pass — current guy is fine', blurb: 'Save the money.',
            apply: (state) => pushNews(state, `Passed on ${name}. Staying with current S&C staff.`),
          },
        ],
      }
    },
  },

  YEAR_END_AWARDS_BANQUET: {
    id: 'YEAR_END_AWARDS_BANQUET', weight: 0.3,
    condition: (state) => isOffseasonWeek(state) && (state.calendar?.weekOfYear || 0) <= 4,
    builder: (state) => ({
      id: `evt_AWARDS_${state.calendar.year}_${state.calendar.weekOfYear}`,
      templateId: 'YEAR_END_AWARDS_BANQUET',
      title: 'Year-End Awards Banquet',
      body: 'Annual team banquet planning. AD wants you to fund half of it ($4K), or skip it and save the budget.',
      choices: [
        { id: 'fund-banquet', label: 'Fund the banquet', blurb: '-$4K. Boosters love it. Players remember.',
          apply: (state) => { if (state.budget) state.budget.totalAthleticBudget = Math.max(0, state.budget.totalAthleticBudget - 4000); applyTeamMorale(state, +5); applyJobSecurity(state, +3); pushNews(state, 'Banquet fully funded. Boosters had a great night, players showcased.') } },
        { id: 'cheap-banquet', label: 'Lower-cost banquet ($1.5K)', blurb: 'Reasonable. Less glitzy.',
          apply: (state) => { if (state.budget) state.budget.totalAthleticBudget -= 1500; applyTeamMorale(state, +2); pushNews(state, 'Cheap-and-cheerful banquet. Boosters were polite.') } },
        { id: 'skip-banquet', label: 'Skip — pizza night only', blurb: 'Saves money. Tradition broken.',
          apply: (state) => { applyTeamMorale(state, -3); applyJobSecurity(state, -2); pushNews(state, 'Coach killed the year-end banquet. Boosters were not pleased.') } },
      ],
    }),
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
  let teamHitterDur = 0
  let teamPitcherDur = 0
  let happinessCount = 0
  let durCount = 0
  if (team) {
    for (const pid of (team.rosterPlayerIds || [])) {
      const p = state.players?.[pid]
      if (!p) continue
      if (p.happiness?.value != null) { teamHappiness += p.happiness.value; happinessCount++ }
      if (p.isPitcher && p.pitcher?.durability != null) { teamPitcherDur += p.pitcher.durability; durCount++ }
      else if (p.hitter?.durability != null) { teamHitterDur += p.hitter.durability; durCount++ }
    }
  }
  return {
    jobSecurity: state.budget?.jobSecurity ?? 50,
    totalBudget: state.budget?.totalAthleticBudget ?? 0,
    scholarships: state.budget?.allocations?.scholarships ?? 0,
    recruiting: state.budget?.allocations?.recruiting ?? 0,
    travel: state.budget?.allocations?.travel ?? 0,
    rosterSize: team?.rosterPlayerIds?.length ?? 0,
    teamHappinessAvg: happinessCount > 0 ? teamHappiness / happinessCount : 0,
    teamDurabilityAvg: durCount > 0 ? (teamHitterDur + teamPitcherDur) / durCount : 0,
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
  const durDelta = after.teamDurabilityAvg - before.teamDurabilityAvg
  if (Math.abs(durDelta) >= 0.3) {
    const d = durDelta
    out.push({ kind: 'TEAM_DURABILITY', delta: d, label: `Team durability ${d > 0 ? '+' : ''}${d.toFixed(1)}` })
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
    for (let i = 0; i < Math.min(addedCount, 8); i++) {
      const entry = state.newsfeed?.[i]
      if (entry?.headline) newNewsLines.push(entry.headline)
    }
  }

  // Stamp the outcome onto state so the UI can pop a clear results modal.
  // playerId carries over so the modal can show "John Smith (JR OF, 78 OVR)"
  // as a banner — the user always knows who the call was actually about.
  state._lastEventOutcome = {
    templateId: pending.templateId,
    eventTitle: pending.title,
    choiceLabel: choice.label,
    effects,
    narrative: newNewsLines,
    playerId: pending.playerId || null,
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
