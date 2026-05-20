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
import { applyRecruitingAction, ACTION_TYPES, setLiveOffer, withdrawOffer, simProspectCamp, fundraise, generateRecruitPool } from './recruits'
import { WEEKLY_ACTIONS, applyWeeklyAction, isActionAvailable, isActionUsedThisWeek, markActionUsedThisWeek, PERM_AP, TEMP_AP } from './weeklyActions'
import { phaseForWeek } from './gameYear'
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

  // 2. Prune stale offers BEFORE scouting + AP spend — frees scholarship $$
  // for fresher targets the AP-loop is about to scout. Doesn't fire unless
  // the recruit pool already exists.
  if (save.recruits && Object.keys(save.recruits).length > 0) {
    autoPullStagnantOffers(save, summary)
  }

  // 3. Required action for this week
  const req = requiredActionForWeek(save, week)
  if (req && !req.isComplete(save)) {
    autoFulfillRequiredAction(save, req, summary)
  }

  // 4. Prospect-camp invites in Wks 5 & 9 (the October turn anchor;
  // independent of required action)
  if (week === 5 || week === 9) {
    autoSendCampInvites(save, week, summary)
  }

  // 5. Weekly AP — only spend if user has AP this week and hasn't touched it
  const ap = save.ap?.currentWeek ?? 0
  if (ap > 0 && week >= 4) {
    autoSpendAP(save, summary)
  }

  return summary
}

/**
 * Pull live offers that have been sitting for 10+ weeks with no commitment
 * (and no fresh strong interest). Frees scholarship $$ so the auto-recruit
 * pass can extend offers to fresher targets that are actually engaging.
 */
function autoPullStagnantOffers(save, summary) {
  const userSchoolId = save.userSchoolId
  if (!userSchoolId) return
  let pulled = 0
  for (const r of Object.values(save.recruits || {})) {
    if (!r.liveOffer || r.liveOffer.schoolId !== userSchoolId) continue
    if (r.status !== 'open') continue
    const weeksOut = r.liveOffer.weeksOutstanding || 0
    if (weeksOut < 10) continue
    // Don't pull if they're showing strong renewed interest — they may
    // still commit. The cutoff is 75 (above the "I'd offer" threshold).
    const interest = r.scoutGrades?.[userSchoolId]?.interest || 0
    if (interest >= 75) continue
    try { withdrawOffer(r, userSchoolId) ; pulled++ } catch (e) {}
  }
  if (pulled > 0) {
    summary.actionsTaken.push(`Pulled ${pulled} stale offer${pulled === 1 ? '' : 's'} (>10 wk no commit)`)
  }
}

/** How many recruits currently hold a live offer from the user's program. */
function countActiveOffers(save, userSchoolId) {
  let n = 0
  for (const r of Object.values(save.recruits || {})) {
    if (r.liveOffer && r.liveOffer.schoolId === userSchoolId) n++
  }
  return n
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
    { level: save.level || 'NAIA' },
  )
  save.recruits = pool
}

export function autoFulfillProspectCamp(save, summary = { actionsTaken: [] }) {
  // Wk 13 — run the camp at a mid-tier fee. Use already-invited recruits +
  // walk-ons. The simProspectCamp function returns revenue.
  const userSchoolId = save.userSchoolId
  const invitedIds = save.prospectCamp?.invitedIds || []
  const recruits = save.recruits || {}
  const headCoach = save.coaches?.[save.teams?.[userSchoolId]?.headCoachId]
  const coachRecruiter = headCoach?.recruiter ?? 55
  const programMomentum = save.teams?.[userSchoolId]?.programMomentum ?? 50
  const fee = 100   // fixed $100/attendee
  const programHistory = save.schools?.[userSchoolId]?.programHistory ?? 50

  // Need to pass a working `recruits`set even if there's nothing here yet
  const result = simProspectCamp(
    recruits, userSchoolId, invitedIds, fee,
    coachRecruiter, programMomentum,
    save.calendar?.year, save.seed || 1, programHistory,
  )
  if (!save.prospectCamp) save.prospectCamp = {}
  // Store the SAME shape the manual WeeklyActions path uses so the
  // "Held this year" results view (which reads attendeeIds / attendees /
  // fee) renders auto-run camps correctly instead of "No attendees recorded."
  const attendeeIds = result?.attendeeIds || []
  save.prospectCamp.year = save.calendar?.year
  save.prospectCamp.attendeeIds = attendeeIds
  save.prospectCamp.attendees = attendeeIds.length
  save.prospectCamp.fee = fee
  save.prospectCamp.revenue = result?.revenue || 0
  save.prospectCamp.held = true
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

  // PRIORITY ORDER (May 2026 per Nate):
  //   The MAIN two AP sinks are RECRUITING and PLAYER DEVELOPMENT (team
  //   boosts like practice drills, 1-on-1 dev). Study hall is a SITUATIONAL
  //   priority — only when team GPA is at risk. Fundraising is a LAST resort,
  //   only fired when the program is short on scholarship $ relative to its
  //   commitments.
  //
  //   1. Study hall — only if GPA at risk (team avg < 2.5 or anyone < 2.1)
  //   2. Fundraising — only if scholarship pool is critically low
  //   3. Recruiting — primary sink, absorbs most weekly AP
  //   4. Team dev boosts — small per-week practice bumps via weekly actions
  //   5. Final recruiting pass — soak up any remaining AP on cheap actions

  // 1. Conditional study hall — only fires when GPA is meaningfully at risk.
  // Tiering:
  //   - team avg < 2.3 OR any player < 1.9: TUTORING GROUP (pinpoint 3 worst)
  //   - team avg < 2.5 OR any player < 2.1: EXTRA study hall (bigger bonus)
  //   - else default standard study hall once per week
  if (!forceAllOnRecruiting && shouldSpendOnStudyHall(save, ap) && gpaAtRisk(save)) {
    const tier = academicSeverity(save)
    let spent = 0
    if (tier === 'CRITICAL') {
      spent = spendTutoringGroup(save) || spendExtraStudyHall(save) || spendStudyHall(save)
      if (spent > 0) summary.actionsTaken.push(`Tutoring group (critical GPA) — ${spent} AP`)
    } else if (tier === 'SEVERE') {
      spent = spendExtraStudyHall(save) || spendStudyHall(save)
      if (spent > 0) summary.actionsTaken.push(`Extra study hall (GPA bad) — ${spent} AP`)
    } else {
      spent = spendStudyHall(save)
      if (spent > 0) summary.actionsTaken.push(`Study hall (team GPA at risk) — ${spent} AP`)
    }
    if (spent > 0) ap -= spent
  }

  // 2. Conditional fundraise — only if scholarship $ is truly low. Old
  // version fired anytime AP >= 15 which was way too aggressive.
  if (!forceAllOnRecruiting && ap >= 10 && scholarshipPoolCritical(save)) {
    const spent = spendFundraise(save)
    if (spent > 0) {
      ap -= spent
      summary.actionsTaken.push(`Fundraised (scholarships low) — ${spent} AP`)
    }
  }

  // 3. Weekly practice action — rotate hitting/pitching/defensive drills
  // through a variety of stats across weeks. Fires only in practice-eligible
  // phases (Fall Camp, Spring Season, etc.). This is the lever Nate
  // specifically called out as missing: "Where is the practice/weekly
  // actions? Sometimes we need to mix in some other actions like training
  // players." Auto now fires one TEMPORARY weekly action per practice week.
  if (!forceAllOnRecruiting && ap >= TEMP_AP) {
    const spent = spendWeeklyPractice(save, summary)
    if (spent > 0) ap -= spent
  }

  // 4. Recruiting — the primary sink
  if (ap > 0 && hasRecruitingNeeds(save)) {
    const spent = spendRecruiting(save, ap)
    if (spent > 0) {
      ap -= spent
      summary.actionsTaken.push(`Spent ${spent} AP on recruiting board`)
    }
  }

  // 5. Team development boost — fallback if we still have AP and no weekly
  // practice happened. Spends 8 AP if we have it.
  if (!forceAllOnRecruiting && ap >= 8) {
    const spent = spendTeamDevBoost(save)
    if (spent > 0) {
      ap -= spent
      summary.actionsTaken.push(`Team dev boost — ${spent} AP`)
    }
  }

  // 5. Final recruiting pass — cheaper TEXT actions on whoever's left
  if (ap >= 1 && hasRecruitingNeeds(save)) {
    const spent = spendRecruiting(save, ap)
    if (spent > 0) {
      ap -= spent
      summary.actionsTaken.push(`Additional recruiting — ${spent} AP`)
    }
  }
}

/**
 * Auto-fire one weekly practice action — rotates through the WEEKLY_ACTIONS
 * catalog so hitters, pitchers, and defenders all get attention across the
 * year. Uses the TEMPORARY variant (10 AP for +5 to a rating for 4 weeks)
 * since it's cheaper than PERMANENT and the short-term boost shows up in
 * the very next game week. Only fires in practice-eligible phases; skipped
 * outside those (December break, postseason, summer recruiting).
 */
function spendWeeklyPractice(save, summary) {
  const wk = save.calendar?.weekOfYear ?? 0
  const phase = phaseForWeek(wk)
  if (!phase?.practice) return 0
  if (!phase?.devAllowed) return 0
  // Variant choice (Nate's rule): TEMPORARY boosts only during the spring
  // season — they wear off in 4 weeks, so they're only worth it when there
  // are games that count NOW. Outside the season (offseason practice/dev
  // weeks) use PERMANENT boosts so the rating gains actually stick.
  const inSeason = !!phase?.inSeason
  const variant = inSeason ? 'TEMPORARY' : 'PERMANENT'
  const cost = inSeason ? TEMP_AP : PERM_AP
  const ap = save.ap?.currentWeek ?? 0
  if (ap < cost) return 0
  // Offseason PERMANENT drills cost 15 AP and crowd out recruiting if fired
  // every single week. Per Nate, do them every OTHER week so most weeks the
  // AP goes to the recruiting board. (In-season TEMPORARY boosts still fire
  // every week — they're cheaper + only matter while games are live.)
  const counter0 = (save.calendar?.week ?? save.calendar?.weekOfYear ?? 0)
  if (!inSeason && (counter0 % 2 !== 0)) return 0
  // 11-action rotation balances hitting / pitching / defensive work. Cycles
  // by overall counter so consecutive weeks hit different stats.
  const ROTATION = [
    'CONTACT_R', 'STUFF_WORK', 'POWER_R', 'CONTROL_WORK',
    'PLATE_DISCIPLINE', 'STAMINA_WORK', 'FIELDING_DRILLS',
    'SPEED_CAMP', 'CONTACT_L', 'THROWING_DRILLS', 'POWER_L',
  ]
  const counter = (save.calendar?.week ?? wk) || 1
  // Find the first action in the rotation that isn't already used this week.
  let actionKey = null
  for (let i = 0; i < ROTATION.length; i++) {
    const candidate = ROTATION[(counter + i) % ROTATION.length]
    if (!isActionUsedThisWeek(save, candidate)) { actionKey = candidate; break }
  }
  if (!actionKey) return 0
  const actionDef = WEEKLY_ACTIONS[actionKey]
  if (!actionDef) return 0
  // Mark + spend before applying so re-entrant calls during the same week
  // don't double-fire.
  applyWeeklyAction(save, actionDef, variant)
  markActionUsedThisWeek(save, actionKey)
  save.ap.currentWeek -= cost
  save.ap.spentThisWeek = (save.ap.spentThisWeek || 0) + cost
  const amt = inSeason ? `+${actionDef.tempAmount} temp` : `+${actionDef.permAmount} perm`
  summary.actionsTaken.push(`${actionDef.label} (${amt}) — ${cost} AP`)
  return cost
}

/**
 * Team-development boost — applies a small practice-derived rating bump
 * across the roster via the existing applyWeeklyAction infrastructure.
 * For now this is a placeholder that mimics what users would do manually
 * in Weekly Actions; spends 8 AP if available + applies a small +0.5 to
 * 1 rating on a few players. Returns AP spent.
 */
function spendTeamDevBoost(save) {
  const cost = 8
  const ap = save.ap?.currentWeek ?? 0
  if (ap < cost) return 0
  // Pick a random core rating to develop this week — rotate so we don't
  // hammer the same one. Cycle by week-of-year mod 4.
  const ROT = ['contact_r', 'power_r', 'discipline', 'fielding']
  const wk = save.calendar?.weekOfYear ?? 0
  const ratingKey = ROT[wk % ROT.length]
  const team = save.teams[save.userSchoolId]
  const players = (team?.rosterPlayerIds || [])
    .map(id => save.players[id])
    .filter(p => p && !p.isPitcher
      && p.eligibilityStatus !== 'cut' && p.eligibilityStatus !== 'dismissed')
  let bumped = 0
  for (const p of players) {
    if (!p.hitter) continue
    const cur = p.hitter[ratingKey] ?? 50
    if (cur >= 95) continue   // already capped
    // 35% chance per player of a +0.5 bump
    if (Math.random() < 0.35) {
      p.hitter[ratingKey] = Math.min(99, cur + 0.5)
      bumped++
    }
  }
  if (bumped === 0) return 0
  save.ap.currentWeek -= cost
  save.ap.spentThisWeek = (save.ap.spentThisWeek || 0) + cost
  return cost
}

/** Team GPA is at risk if the team average is below 2.5 OR anyone is below 2.1. */
function gpaAtRisk(save) {
  const team = save.teams[save.userSchoolId]
  if (!team) return false
  const players = (team.rosterPlayerIds || [])
    .map(id => save.players[id])
    .filter(p => p && typeof p.gpa === 'number')
  if (players.length === 0) return false
  const avg = players.reduce((s, p) => s + p.gpa, 0) / players.length
  if (avg < 2.5) return true
  if (players.some(p => p.gpa < 2.1)) return true
  return false
}

/**
 * Scholarship pool is "critical" if the team has < 5% of the school's
 * annual scholarship budget free, OR pending offers exceed available $.
 * Fundraising auto-fires when this is true, otherwise the AI co-GM
 * doesn't waste AP on it.
 */
function scholarshipPoolCritical(save) {
  const team = save.teams[save.userSchoolId]
  const school = save.schools[save.userSchoolId]
  if (!team || !school) return false
  const pool = school.scholarshipPool || 200000
  // Committed = sum of all roster players' scholarships
  const committed = (team.rosterPlayerIds || [])
    .map(id => save.players[id]?.scholarship?.annualAmount || 0)
    .reduce((s, n) => s + n, 0)
  const available = pool - committed
  return available < pool * 0.05    // < 5% slack
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
  save.studyHall.cumulativeBonus = Math.min(0.60, (save.studyHall.cumulativeBonus || 0) + STUDY_HALL_BONUS)
  return STUDY_HALL_AP
}

/**
 * Extra study hall — 6 AP for 0.05 GPA. The auto co-GM fires this when team
 * GPA is "severe" (below 2.5 OR anyone below 2.1). Costs more but moves the
 * needle 2.5x as fast.
 */
function spendExtraStudyHall(save) {
  const COST = 6
  const BONUS = 0.05
  const ap = save.ap?.currentWeek ?? 0
  if (ap < COST) return 0
  // Mirror the user-facing UI: only fires if there's still cumulative
  // headroom under the +0.60 term cap.
  const stacked = save.studyHall?.cumulativeBonus ?? 0
  if (stacked >= 0.55) return 0
  save.ap.currentWeek -= COST
  save.ap.spentThisWeek = (save.ap.spentThisWeek || 0) + COST
  if (!save.studyHall) save.studyHall = { cumulativeBonus: 0 }
  save.studyHall.cumulativeBonus = Math.min(0.60, stacked + BONUS)
  // Apply immediately to every player's GPA for parity with the UI button
  const team = save.teams[save.userSchoolId]
  if (team) {
    for (const id of team.rosterPlayerIds) {
      const p = save.players[id]
      if (!p) continue
      p.gpa = Math.min(4.0, Math.round((p.gpa + BONUS) * 100) / 100)
    }
  }
  return COST
}

/**
 * Tutoring group — 5 AP, pinpoint +0.20 GPA bump for the 3 worst-GPA
 * players. Auto-fires when team GPA is "critical" (any player < 1.9 OR
 * team avg < 2.3). Cheaper than extra study hall and HUGE per-player
 * lift; ideal for pulling guys back off ineligibility.
 */
function spendTutoringGroup(save) {
  const COST = 5
  const BOOST = 0.20
  const ap = save.ap?.currentWeek ?? 0
  if (ap < COST) return 0
  if (isTutoringUsedThisWeek(save)) return 0
  const team = save.teams[save.userSchoolId]
  if (!team) return 0
  const candidates = (team.rosterPlayerIds || [])
    .map(id => save.players[id])
    .filter(p => p && typeof p.gpa === 'number'
      && p.eligibilityStatus !== 'cut' && p.eligibilityStatus !== 'dismissed')
    .sort((a, b) => a.gpa - b.gpa)
    .slice(0, 3)
  if (candidates.length < 3) return 0
  for (const p of candidates) {
    p.gpa = Math.min(4.0, Math.round((p.gpa + BOOST) * 100) / 100)
  }
  save.ap.currentWeek -= COST
  save.ap.spentThisWeek = (save.ap.spentThisWeek || 0) + COST
  markTutoringUsedThisWeek(save)
  return COST
}

function isTutoringUsedThisWeek(save) {
  const list = save.weeklyActionsUsed || []
  return list.some(x => x === 'TUTORING_GROUP' || x?.key === 'TUTORING_GROUP')
}
function markTutoringUsedThisWeek(save) {
  if (!save.weeklyActionsUsed) save.weeklyActionsUsed = []
  save.weeklyActionsUsed.push('TUTORING_GROUP')
}

/**
 * 3-tier severity check used to choose between standard study hall,
 * extra study hall, and tutoring group.
 *   CRITICAL  — anyone GPA < 1.9 OR team avg < 2.3 (use tutoring)
 *   SEVERE    — anyone GPA < 2.1 OR team avg < 2.5 (use extra study hall)
 *   AT_RISK   — anyone GPA < 2.3 OR team avg < 2.7 (use standard)
 */
function academicSeverity(save) {
  const team = save.teams[save.userSchoolId]
  if (!team) return 'AT_RISK'
  const players = (team.rosterPlayerIds || [])
    .map(id => save.players[id])
    .filter(p => p && typeof p.gpa === 'number')
  if (players.length === 0) return 'AT_RISK'
  const avg = players.reduce((s, p) => s + p.gpa, 0) / players.length
  const lowest = Math.min(...players.map(p => p.gpa))
  if (avg < 2.3 || lowest < 1.9) return 'CRITICAL'
  if (avg < 2.5 || lowest < 2.1) return 'SEVERE'
  return 'AT_RISK'
}

function hasRecruitingNeeds(save) {
  const recruits = Object.values(save.recruits || {})
  return recruits.some(r => r.status === 'open')
}

function spendRecruiting(save, apBudget) {
  // Work the recruiting board until the AP budget is used up. MULTI-PASS:
  // re-scores + re-touches the top recruits each pass so a big monthly AP
  // budget (the condensed Oct/Nov/Dec turns hand auto ~100 AP) actually digs
  // deep on the top targets instead of one shallow touch each. Offers go out
  // aggressively — by January a program should have several commits.
  const userSchoolId = save.userSchoolId
  if (Object.values(save.recruits || {}).filter(r => r.status === 'open').length === 0) return 0
  const rng = makeRng('autoRecruit', save.calendar?.year, save.calendar?.weekOfYear, save.seed || 1)
  let spent = 0
  let safety = 0
  while (spent < apBudget && safety < 500) {
    safety++
    const open = Object.values(save.recruits || {}).filter(r => r.status === 'open')
    if (open.length === 0) break
    const scored = open.map(r => {
      const grade = r.scoutGrades?.[userSchoolId]
      const interest = grade?.interest ?? 0
      const fog = grade?.noise ?? 15
      const ovr = avgEstOvr(r)
      return { r, interest, fog, ovr, score: ovr * 1.0 + interest * 0.6 + fog * 0.25 }
    }).sort((a, b) => b.score - a.score)
    const top = scored.slice(0, 25)
    let didSomething = false
    for (const { r, interest, fog, ovr } of top) {
      if (apBudget - spent < 1) break
      // Action ladder: clear the fog first, then build interest, then close.
      let action
      if (fog >= 8 && apBudget - spent >= ACTION_TYPES.SCOUT_TRIP.apCost) action = ACTION_TYPES.SCOUT_TRIP
      else if (interest >= 70 && apBudget - spent >= ACTION_TYPES.CAMPUS_VISIT.apCost) action = ACTION_TYPES.CAMPUS_VISIT
      else if (interest >= 45 && apBudget - spent >= ACTION_TYPES.HOME_VISIT.apCost) action = ACTION_TYPES.HOME_VISIT
      else if (apBudget - spent >= ACTION_TYPES.ASSISTANT_TALK.apCost) action = ACTION_TYPES.ASSISTANT_TALK
      else action = ACTION_TYPES.TEXT
      if (apBudget - spent < action.apCost) continue
      // Skip already-applied one-shot actions; TEXT is always repeatable.
      const grade = r.scoutGrades?.[userSchoolId]
      if ((grade?.actionsApplied || []).includes(action.key)) {
        action = ACTION_TYPES.TEXT
        if (apBudget - spent < action.apCost) continue
      }
      try {
        applyRecruitingAction(r, userSchoolId, action, rng)
        save.ap.currentWeek -= action.apCost
        save.ap.spentThisWeek = (save.ap.spentThisWeek || 0) + action.apCost
        spent += action.apCost
        didSomething = true
      } catch (err) {
        continue
      }
      // OFFER — loosened a lot. We extend a scholarship once a fit recruit
      // shows real interest OR we've invested enough scouting to know they're
      // worth it. Fog is about how much we KNOW, not whether to commit $, so
      // it no longer gates the offer. Costs $$ from the pool, not AP.
      const pg = r.scoutGrades?.[userSchoolId]
      const pInterest = pg?.interest ?? interest
      const apOnThem = pg?.apSpent ?? 0
      if (!r.liveOffer && ovr >= 50 && countActiveOffers(save, userSchoolId) < 25) {
        if (pInterest >= 45 || apOnThem >= 6 || (pInterest >= 35 && ovr >= 68)) {
          const offerAmount = computeAutoOffer(save, r, ovr)
          if (offerAmount > 0) {
            try { setLiveOffer(r, userSchoolId, offerAmount) } catch (err) { /* pool tapped */ }
          }
        }
      }
    }
    if (!didSomething) break
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
