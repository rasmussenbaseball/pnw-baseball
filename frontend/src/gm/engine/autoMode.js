/**
 * Auto Mode — the AI co-GM.
 *
 * When auto mode is on, the user's recurring week-to-week decisions get made
 * for them. The user can flip back to manual at any time and resume hands-on
 * control. Auto mode does NOT play games for the user — they still choose
 * Enter Game vs Sim from the GameWeekModal. It only fills in:
 *
 *   1. Required actions that gate the week (schedule, hire, budget, scout,
 *      prospect camp, mandatory cuts) — picked sensibly so the user can
 *      still beat sim into Wk 5 even if they haven't touched the menus.
 *   2. Leftover weekly AP spent on the highest-priority lever:
 *        - GPA dropping study hall
 *        - Recruiting class still open + AP available work the board
 *        - Otherwise fundraise + team boost
 *   3. Prospect camp invites in Wks 5 & 10.
 *   4. Mandatory cuts when over the 50-player cap.
 *
 * Architecture: a single entry point `runAutoActions(save)`is called from
 * Dashboard right before sim advances. It mutates save in place — same
 * pattern the rest of the engine uses.
 */

import { autoCreateSchedule } from './schedule'
import { applyBudgetPreset, lockBudgetForYear, BUDGET_PRESETS } from './budget'
import { applyRecruitingAction, ACTION_TYPES, setLiveOffer, simProspectCamp, fundraise, generateRecruitPool } from './recruits'
import { makeRng } from './rng'
import { requiredActionForWeek } from './gameYear'
import { cutPlayer, ensureCutsState } from './cuts'
import { playerOverall } from './playerRating'
import { generateCoach } from './coaches'
import nonNaiaRaw from '../data/non_naia_teams.json'

// ─── Toggle helpers ─────────────────────────────────────────────────────────

export function isAutoMode(state) {
  return !!state?.flags?.autoMode
}

export function setAutoMode(state, on) {
  if (!state.flags) state.flags = {}
  state.flags.autoMode = !!on
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Run every auto action that should happen for the CURRENT week before the
 * user clicks Sim Next Week. Idempotent — safe to call multiple times.
 *
 * Returns a summary { actionsTaken: string[] } for the news feed / UI.
 */
export function runAutoActions(save) {
  const summary = { actionsTaken: [] }
  if (!isAutoMode(save)) return summary
  const week = save.calendar?.weekOfYear ?? 1

  // 1. Mandatory cuts ALWAYS take precedence (cap overage gates everything)
  if (save.mandatoryCuts?.needed > 0 && save.mandatoryCuts.year === save.calendar?.year) {
    autoMandatoryCuts(save, summary)
  }

  // 2. Required action for this week
  const req = requiredActionForWeek(save, week)
  if (req && !req.isComplete(save)) {
    autoFulfillRequiredAction(save, req, summary)
  }

  // 3. Prospect-camp invites in Wks 5 & 10 (independent of required action)
  if (week === 5 || week === 10) {
    autoSendCampInvites(save, week, summary)
  }

  // 4. Weekly AP — only spend if user has AP this week and hasn't touched it
  const ap = save.ap?.currentWeek ?? 0
  if (ap > 0 && week >= 4) {
    autoSpendAP(save, summary)
  }

  return summary
}

// ─── Required-action fulfillment ────────────────────────────────────────────

function autoFulfillRequiredAction(save, req, summary) {
  switch (req.key) {
    case 'SCHEDULE':       return autoFulfillSchedule(save, summary)
    case 'HIRE':           return autoFulfillHire(save, summary)
    case 'BUDGET':         return autoFulfillBudget(save, summary)
    case 'SCOUT':          return autoFulfillScouting(save, summary)
    case 'PROSPECT_CAMP':  return autoFulfillProspectCamp(save, summary)
    case 'MANDATORY_CUTS': return autoMandatoryCuts(save, summary)
    default: return
  }
}

function autoFulfillSchedule(save, summary) {
  // The auto-schedule generator returns a list of new games to add — same
  // one the "Auto Create Schedule" button on the Schedule page exposes.
  const userSchoolId = save.userSchoolId
  const conf = save.schools[userSchoolId]?.conferenceId
  if (!conf) return
  const flatNonNaia = nonNaiaRaw.divisions.flatMap(div =>
    div.teams.map(t => ({ ...t, division: div.id })),
  )
  const result = autoCreateSchedule(
    userSchoolId, conf, save.schools, flatNonNaia,
    save.schedule || [], save.calendar.year + 1, save.seed || 1,
  )
  if (result?.games?.length > 0) {
    if (!save.schedule) save.schedule = []
    save.schedule.push(...result.games)
    summary.actionsTaken.push(`Auto-scheduled the ${save.calendar.year + 1} season (${result.games.length} games added)`)
  }
  save.scheduleComplete = true
}

function autoFulfillHire(save, summary) {
  // Wk 2: actually HIRE missing required assistants (Pitching / Hitting /
  // Bench). Year 1 the user starts with NO assistants — autoCoaches existed
  // before but were stripped at dynasty creation so the user could pick
  // theirs. Auto mode rebuilds a baseline staff so the user can advance.
  const userSchoolId = save.userSchoolId
  const team = save.teams?.[userSchoolId]
  const school = save.schools?.[userSchoolId]
  if (!team || !school) return
  if (!save.coaches) save.coaches = {}
  const REQUIRED = ['PITCHING_COACH', 'HITTING_COACH', 'BENCH_COACH']
  const currentAssistants = (team.assistantCoachIds || [])
    .map(id => save.coaches[id])
    .filter(Boolean)
  const filledRoles = new Set(currentAssistants.map(c => c.role))
  let hired = 0
  const rng = makeRng('autoHire', userSchoolId, save.calendar?.year, save.seed || 1)
  for (const role of REQUIRED) {
    if (filledRoles.has(role)) continue
    // Generate a competent mid-tier coach for the missing role
    const coach = generateCoach(school, role, rng, {
      idPrefix: `ast_auto_${userSchoolId}_${role}_${save.calendar?.year}`,
    })
    save.coaches[coach.id] = coach
    if (!team.assistantCoachIds) team.assistantCoachIds = []
    team.assistantCoachIds.push(coach.id)
    hired++
  }
  if (!save.hiringConfirmed) save.hiringConfirmed = {}
  save.hiringConfirmed.year = save.calendar?.year
  if (hired > 0) {
    summary.actionsTaken.push(`Hired ${hired} assistant coach${hired === 1 ? '' : 'es'} (pitching / hitting / bench as needed)`)
  } else {
    summary.actionsTaken.push('Confirmed current assistant staff')
  }
}

function autoFulfillBudget(save, summary) {
  // Pick BALANCED as the safe default. The applyBudgetPreset helper handles
  // travel-locked allocations + scholarship pool.
  const preset = BUDGET_PRESETS.find(p => p.key === 'BALANCED') || BUDGET_PRESETS[0]
  if (!save.budget) return
  save.budget = applyBudgetPreset(save.budget, preset)
  save.budget = lockBudgetForYear(save.budget, save.calendar?.year)
  summary.actionsTaken.push(`Locked ${preset.label} budget`)
}

function autoFulfillScouting(save, summary) {
  // Wk 4 — must spend AP on recruiting. The pool is normally lazy-generated
  // when the user first visits the Recruiting page; auto mode never does
  // that, so we have to generate it here BEFORE trying to spend.
  ensureRecruitPool(save)
  autoSpendAP(save, summary, /* forceAllOnRecruiting */ true)
}

/**
 * Lazy-generate the upcoming recruit class if it doesn't exist yet. Mirrors
 * the lazy init in Recruiting.jsx so auto mode can spend AP on recruits
 * without the user ever opening the page.
 */
function ensureRecruitPool(save) {
  if (save.recruits && Object.keys(save.recruits).length > 0) return
  const userHC = save.coaches?.[save.teams?.[save.userSchoolId]?.headCoachId]
  const pool = generateRecruitPool(
    (save.calendar?.year ?? 2026) + 1,
    save.rngSeed || save.seed || 1,
    userHC,
    save.userSchoolId,
  )
  save.recruits = pool
}

function autoFulfillProspectCamp(save, summary) {
  // Wk 13 — run the camp at a mid-tier fee. Use already-invited recruits +
  // walk-ons. The simProspectCamp function returns revenue.
  const userSchoolId = save.userSchoolId
  const invitedIds = save.prospectCamp?.invitedIds || []
  const recruits = save.recruits || {}
  const headCoach = save.coaches?.[save.teams?.[userSchoolId]?.headCoachId]
  const coachRecruiter = headCoach?.recruiter ?? 55
  const programMomentum = save.teams?.[userSchoolId]?.programMomentum ?? 50
  const fee = 100   // mid-tier — caps revenue but maxes turnout

  // Need to pass a working `recruits`set even if there's nothing here yet
  const result = simProspectCamp(
    recruits, userSchoolId, invitedIds, fee,
    coachRecruiter, programMomentum,
    save.calendar?.year, save.seed || 1,
  )
  if (!save.prospectCamp) save.prospectCamp = {}
  save.prospectCamp.year = save.calendar?.year
  save.prospectCamp.attendees = result?.attendeeIds || []
  save.prospectCamp.revenue = result?.revenue || 0
  if (result?.cancelled) {
    summary.actionsTaken.push('Prospect camp had no takers — skipped')
  } else {
    summary.actionsTaken.push(`Ran prospect camp — ${result.attendeeIds?.length || 0} attended, $${result.revenue || 0} raised`)
  }
}

// ─── Mandatory cuts ─────────────────────────────────────────────────────────

function autoMandatoryCuts(save, summary) {
  // Cut the lowest-OVR players until we're back at 50. Prefer cutting non-
  // pitchers first since most over-recruits are extra position players.
  const userSchoolId = save.userSchoolId
  const team = save.teams[userSchoolId]
  ensureCutsState(save)
  const roster = (team.rosterPlayerIds || [])
    .map(id => save.players[id])
    .filter(Boolean)
    .map(p => ({ p, ovr: playerOverall(p) }))
    .sort((a, b) => a.ovr - b.ovr)   // worst first
  const need = save.mandatoryCuts?.needed ?? 0
  let cut = 0
  for (const { p } of roster) {
    if (cut >= need) break
    const result = cutPlayer(save, p.id)
    if (result?.ok !== false) cut++
  }
  if (cut > 0) summary.actionsTaken.push(`Mandatory cuts: trimmed ${cut} bottom-OVR players`)
}

// ─── Camp invites ───────────────────────────────────────────────────────────

function autoSendCampInvites(save, week, summary) {
  // Wks 5 & 10 — invite top HS targets we have any interest in.
  if (!save.prospectCamp) save.prospectCamp = { invitedIds: [], year: save.calendar?.year }
  if (!save.prospectCamp.invitedIds) save.prospectCamp.invitedIds = []
  const userSchoolId = save.userSchoolId
  const recruits = Object.values(save.recruits || {})
  // Take top ~40 HS prospects by est. OVR
  const targets = recruits
    .filter(r => r.pool === 'HS_SR' && r.status === 'open')
    .map(r => ({ r, ovr: avgEstOvr(r) }))
    .sort((a, b) => b.ovr - a.ovr)
    .slice(0, 40)
  const already = new Set(save.prospectCamp.invitedIds)
  let added = 0
  for (const { r } of targets) {
    if (already.has(r.id)) continue
    save.prospectCamp.invitedIds.push(r.id)
    added++
  }
  if (added > 0) summary.actionsTaken.push(`Invited ${added} top HS targets to prospect camp`)
}

function avgEstOvr(r) {
  const block = r.isPitcher ? r.truePitcher : r.trueHitter
  if (!block) return 50
  const vals = Object.values(block).filter(v => typeof v === 'number' && v < 100)
  if (vals.length === 0) return 50
  return vals.reduce((s, v) => s + v, 0) / vals.length
}

// ─── Weekly AP allocation ───────────────────────────────────────────────────

function autoSpendAP(save, summary, forceAllOnRecruiting = false) {
  let ap = save.ap?.currentWeek ?? 0
  if (ap <= 0) return
  const userSchoolId = save.userSchoolId
  const team = save.teams?.[userSchoolId]
  if (!team) return

  // Make sure the recruit pool exists — auto mode can't otherwise spend AP
  // on recruits (the pool is lazy-generated when the user opens Recruiting).
  ensureRecruitPool(save)

  // PRIORITY ORDER (May 2026 per Nate's feedback):
  //   1. Recruiting — biggest single lever in the game; always take it first
  //   2. Study hall — small, one-per-week, only during semesters
  //   3. Fundraising — last resort, only when nothing else productive remains
  // Fundraising should NEVER beat recruiting. Old order had study hall first
  // which was harmless, but fundraising was kicking in even when recruiting
  // could have absorbed the AP.

  // 1. Recruiting — eats up most of the AP via multiple per-recruit actions
  if (ap > 0 && hasRecruitingNeeds(save)) {
    const spent = spendRecruiting(save, ap)
    if (spent > 0) {
      ap -= spent
      summary.actionsTaken.push(`Spent ${spent} AP on recruiting board`)
    }
  }

  // 2. Study hall (1× this week, if appropriate). Skipped in forced mode.
  if (!forceAllOnRecruiting && shouldSpendOnStudyHall(save, ap)) {
    const spent = spendStudyHall(save)
    if (spent > 0) {
      ap -= spent
      summary.actionsTaken.push(`Spent ${spent} AP on study hall`)
    }
  }

  // 3. More recruiting if anything was left untouched — second pass.
  // Common when first pass exhausted the top-30 list but cheaper TEXT
  // actions are still available on the broader board.
  if (ap >= 1 && hasRecruitingNeeds(save)) {
    const spent = spendRecruiting(save, ap)
    if (spent > 0) {
      ap -= spent
      summary.actionsTaken.push(`Spent ${spent} AP on additional recruiting`)
    }
  }

  // 4. Fundraise — ONLY if there's a meaningful chunk left AND we're not
  //    in scouting-required mode AND scholarship $ is genuinely needed.
  //    Default: skip if remaining AP is < 15 (fundraise costs 10).
  if (!forceAllOnRecruiting && ap >= 15) {
    const spent = spendFundraise(save)
    if (spent > 0) {
      ap -= spent
      summary.actionsTaken.push(`Fundraised with ${spent} AP`)
    }
  }
}

function shouldSpendOnStudyHall(save, ap) {
  if (ap < 2) return false
  const team = save.teams[save.userSchoolId]
  // Reuse the cumulativeBonus signal — if it's already maxed (>0.20), skip.
  const stacked = save.studyHall?.cumulativeBonus ?? 0
  if (stacked >= 0.16) return false
  // Only bother in academic-active weeks (5-18 Fall, 23-42 Spring)
  const wk = save.calendar?.weekOfYear ?? 0
  const inSchool = (wk >= 5 && wk <= 18) || (wk >= 23 && wk <= 42)
  return inSchool
}

function spendStudyHall(save) {
  const STUDY_HALL_AP = 2
  const STUDY_HALL_BONUS = 0.02
  const ap = save.ap?.currentWeek ?? 0
  if (ap < STUDY_HALL_AP) return 0
  save.ap.currentWeek -= STUDY_HALL_AP
  save.ap.spentThisWeek = (save.ap.spentThisWeek || 0) + STUDY_HALL_AP
  if (!save.studyHall) save.studyHall = { cumulativeBonus: 0 }
  save.studyHall.cumulativeBonus = Math.min(0.20, (save.studyHall.cumulativeBonus || 0) + STUDY_HALL_BONUS)
  return STUDY_HALL_AP
}

function hasRecruitingNeeds(save) {
  const recruits = Object.values(save.recruits || {})
  return recruits.some(r => r.status === 'open')
}

function spendRecruiting(save, ap) {
  // Pick the recruit that's most worth touching this week. Score combines:
  //   - estimated OVR (skill-weighted)
  //   - existing interest with us
  //   - inverse of scouting fog (we want to clarify cloudy players)
  // Then apply the cheapest impactful action we can afford.
  const userSchoolId = save.userSchoolId
  const recruits = Object.values(save.recruits || {})
    .filter(r => r.status === 'open')
  if (recruits.length === 0) return 0
  const scored = recruits.map(r => {
    const grade = r.scoutGrades?.[userSchoolId]
    const interest = grade?.interest ?? 0
    const fog = grade?.noise ?? 15
    const ovr = avgEstOvr(r)
    // Higher OVR + decent fit interest = priority. Add fog so we're nudged
    // to scout the unknowns. Penalize already-signed elsewhere recruits.
    return { r, score: ovr * 1.0 + interest * 0.5 + fog * 0.4 }
  }).sort((a, b) => b.score - a.score)
  const top = scored.slice(0, 30)
  const rng = makeRng('autoRecruit', save.calendar?.year, save.calendar?.weekOfYear, save.seed || 1)

  let spent = 0
  for (const { r } of top) {
    if (ap - spent < 1) break
    const grade = r.scoutGrades?.[userSchoolId]
    const interest = grade?.interest ?? 0
    const fog = grade?.noise ?? 15
    const ovr = avgEstOvr(r)
    // Pick the action. The dollar cost is in AP only.
    //   high fog (≥10) + AP ≥ 4 SCOUT_TRIP
    //   high fog (≥10) + AP < 4 CALL
    //   low fog + interest < 50 + AP ≥ 2 ASSISTANT_TALK
    //   low fog + interest 50-80 + AP ≥ 5 HOME_VISIT
    //   low fog + interest 80+ + AP ≥ 6 CAMPUS_VISIT (the closer)
    //   default TEXT (1 AP)
    let action
    if (fog >= 10 && ap - spent >= ACTION_TYPES.SCOUT_TRIP.apCost) action = ACTION_TYPES.SCOUT_TRIP
    else if (interest >= 80 && ap - spent >= ACTION_TYPES.CAMPUS_VISIT.apCost) action = ACTION_TYPES.CAMPUS_VISIT
    else if (interest >= 50 && ap - spent >= ACTION_TYPES.HOME_VISIT.apCost) action = ACTION_TYPES.HOME_VISIT
    else if (interest < 50 && ap - spent >= ACTION_TYPES.ASSISTANT_TALK.apCost) action = ACTION_TYPES.ASSISTANT_TALK
    else action = ACTION_TYPES.TEXT
    if (ap - spent < action.apCost) continue
    // Don't repeat the same action on the same recruit (engine already
    // enforces, but checking here saves a wasted call)
    const alreadyApplied = (grade?.actionsApplied || []).includes(action.key)
    if (alreadyApplied) {
      // Fall back to TEXT (which has no one-shot constraint in practice)
      action = ACTION_TYPES.TEXT
      if (ap - spent < action.apCost) continue
    }
    try {
      applyRecruitingAction(r, userSchoolId, action, rng)
      save.ap.currentWeek -= action.apCost
      save.ap.spentThisWeek = (save.ap.spentThisWeek || 0) + action.apCost
      spent += action.apCost
    } catch (err) {
      // Action couldn't apply — skip this recruit
      continue
    }
    // Extend an offer on a clear win (full-scout + good fit) — costs $, not AP
    if (interest >= 70 && fog <= 4 && ovr >= 60 && !r.liveOffer) {
      const offerAmount = computeAutoOffer(save, r, ovr)
      if (offerAmount > 0) {
        try {
          setLiveOffer(r, userSchoolId, offerAmount)
        } catch (err) {
          // Pool exhausted — silent skip
        }
      }
    }
  }
  return spent
}

function computeAutoOffer(save, recruit, ovr) {
  // Simple offer scale: higher OVR + better academic rating more $
  // Capped to leave room for the rest of the class.
  const userSchoolId = save.userSchoolId
  const team = save.teams[userSchoolId]
  const remainingPool = team?.scholarshipPool ?? 0
  if (remainingPool < 2000) return 0
  let amt
  if (ovr >= 80) amt = 12000
  else if (ovr >= 70) amt = 7000
  else if (ovr >= 60) amt = 4000
  else amt = 1500
  // Stretch for in-state PNW kids — small home discount works
  if (recruit.hometown?.state === 'OR' || recruit.hometown?.state === 'WA') amt = Math.round(amt * 0.95)
  return Math.min(amt, Math.floor(remainingPool * 0.15))
}

function spendFundraise(save) {
  const FUNDRAISE_AP = 10
  const ap = save.ap?.currentWeek ?? 0
  if (ap < FUNDRAISE_AP) return 0
  const userSchoolId = save.userSchoolId
  const headCoach = save.coaches?.[save.teams?.[userSchoolId]?.headCoachId]
  const motivator = headCoach?.motivator ?? 55
  const programHistory = save.schools?.[userSchoolId]?.programHistory ?? 50
  const dollars = fundraise(FUNDRAISE_AP, motivator, programHistory)
  save.ap.currentWeek -= FUNDRAISE_AP
  save.ap.spentThisWeek = (save.ap.spentThisWeek || 0) + FUNDRAISE_AP
  if (!save.fundraisingThisYear) save.fundraisingThisYear = 0
  save.fundraisingThisYear += dollars
  if (save.budget) {
    save.budget.totalAthleticBudget = (save.budget.totalAthleticBudget || 0) + dollars
  }
  return FUNDRAISE_AP
}
