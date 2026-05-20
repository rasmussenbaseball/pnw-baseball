/**
 * Auto Mode — the AI co-GM.
 *
 * When auto mode is on, the user's recurring week-to-week decisions get made
 * for them. The user can flip back to manual at any time and resume hands-on
 * control. Auto mode does NOT play games for the user — they still choose
 * Enter Game vs Sim from the GameWeekModal. It only fills in:
 *
 *   1. Required actions that gate the week (schedule, hire, budget, scout,
 *      mandatory cuts) — picked sensibly so the user can
 *      still beat sim into Wk 5 even if they haven't touched the menus.
 *   2. Leftover weekly AP spent on the highest-priority lever:
 *        - GPA dropping study hall
 *        - Recruiting class still open + AP available work the board
 *        - Otherwise fundraise + team boost
 *   3. Mandatory cuts when over the 50-player cap.
 *
 * Architecture: a single entry point `runAutoActions(save)`is called from
 * Dashboard right before sim advances. It mutates save in place — same
 * pattern the rest of the engine uses.
 */

import { autoCreateSchedule } from './schedule'
import { applyBudgetPreset, lockBudgetForYear, BUDGET_PRESETS } from './budget'
import { applyRecruitingAction, ACTION_TYPES, setLiveOffer, withdrawOffer, fundraise, generateRecruitPool } from './recruits'
import { WEEKLY_ACTIONS, applyWeeklyAction, isActionAvailable, isActionUsedThisWeek, markActionUsedThisWeek, PERM_AP, TEMP_AP } from './weeklyActions'
import { phaseForWeek } from './gameYear'
import { makeRng } from './rng'
import { requiredActionForWeek } from './gameYear'
import { cutPlayer, ensureCutsState } from './cuts'
import { playerOverall } from './playerRating'
import { generateCoach } from './coaches'
import { rosterCapForLevel } from './levelHelpers'
import { scholarshipSnapshot } from './scholarshipAccounting'
import { autoAssignSummerBall } from './summerBall'
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

  // 4. Weekly AP — only spend if user has AP this week and hasn't touched it
  const ap = save.ap?.currentWeek ?? 0
  if (ap > 0 && week >= 4) {
    autoSpendAP(save, summary)
  }

  // 5. Summer ball — auto mode never assigned anyone (the planning popup is
  // suppressed in auto). Once planning opens (wk 18, the December turn), assign
  // the best/highest-upside players to summer leagues so the user actually has
  // a summer roster. Idempotent — only fills open slots.
  if (week >= 18 && save.summerBall?.status !== 'CONFIRMED') {
    const assignedBefore = Object.values(save.summerBall?.assignments || {}).filter(a => a && !a.removed).length
    if (assignedBefore === 0) {
      try {
        const res = autoAssignSummerBall(save)
        if (res?.assigned > 0) summary.actionsTaken.push(`Assigned ${res.assigned} players to summer ball leagues`)
      } catch (err) { /* ignore */ }
    }
  }

  return summary
}

/**
 * Pull live offers that have gone genuinely COLD — only the truly dead ones.
 *
 * Tuned way down (May 2026): the old rule pulled any offer >10 weeks old with
 * interest <75, which yanked warm offers constantly. Two things made it
 * over-fire: (1) the condensed Oct/Nov/Dec turns tick weeksOutstanding by
 * 4-5 per turn (fold weeks), so an offer ages to "10 weeks" in ~2 real turns,
 * and (2) interest <75 covers almost everyone the auto would ever offer. Now
 * we only pull offers that are BOTH old (>=18 weeks) AND clearly cold
 * (interest <40) — i.e. the recruit has effectively moved on. Everything
 * warmer rides until they sign or sign elsewhere.
 */
function autoPullStagnantOffers(save, summary) {
  const userSchoolId = save.userSchoolId
  if (!userSchoolId) return
  let pulled = 0
  for (const r of Object.values(save.recruits || {})) {
    if (!r.liveOffer || r.liveOffer.schoolId !== userSchoolId) continue
    if (r.status !== 'open') continue
    const weeksOut = r.liveOffer.weeksOutstanding || 0
    if (weeksOut < 18) continue
    // Only pull if interest has gone cold — a warm recruit may still commit.
    const interest = r.scoutGrades?.[userSchoolId]?.interest || 0
    if (interest >= 40) continue
    try { withdrawOffer(r, userSchoolId) ; pulled++ } catch (e) {}
  }
  if (pulled > 0) {
    summary.actionsTaken.push(`Pulled ${pulled} cold offer${pulled === 1 ? '' : 's'} (long-stale, no interest)`)
  }
}

// ─── Required-action fulfillment ────────────────────────────────────────────

function autoFulfillRequiredAction(save, req, summary) {
  switch (req.key) {
    case 'SCHEDULE':       return autoFulfillSchedule(save, summary)
    case 'HIRE':           return autoFulfillHire(save, summary)
    case 'BUDGET':         return autoFulfillBudget(save, summary)
    case 'SCOUT':          return autoFulfillScouting(save, summary)
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
export function ensureRecruitPool(save) {
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

function avgEstOvr(r) {
  const block = r.isPitcher ? r.truePitcher : r.trueHitter
  if (!block) return 50
  const vals = Object.values(block).filter(v => typeof v === 'number' && v < 100)
  if (vals.length === 0) return 50
  return vals.reduce((s, v) => s + v, 0) / vals.length
}

/**
 * What the auto WOULD perceive a recruit's OVR to be BEFORE scouting them.
 * The auto used to read true OVR directly (avgEstOvr), so it could perfectly
 * cherry-pick the best players sight-unseen — every auto-scouted recruit came
 * back in the same narrow 70-76 band, and it never "wasted" a look on a bust.
 * Real scouting is uncertain: the auto sees a NOISY impression (true ± the
 * recruit's current scouting fog) and decides whom to pursue from that. Some
 * pan out, some don't — exactly like the EST OVR range the user sees. The
 * bias is deterministic per recruit so the impression is stable across the
 * week's passes, and it shrinks as the recruit gets scouted (noise drops).
 */
function perceivedOvr(save, r) {
  return avgEstOvr(r) + noisyBias(save, r, 0)
}

/** Deterministic-but-noisy bias (-noise..+noise) for a recruit, scaled by the
 *  user's current scouting fog on them. `salt` lets us draw an independent
 *  bias for current-OVR vs potential so the two aren't perfectly correlated. */
function noisyBias(save, r, salt) {
  const noise = r.scoutGrades?.[save.userSchoolId]?.noise ?? 15
  const seed = String(r.id || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0) + salt
  const frac = ((seed * 9301 + 49297) % 233280) / 233280   // stable 0..1
  return (frac * 2 - 1) * noise
}

/** Average POTENTIAL (ceiling) across a recruit's rating block. */
function avgPotentialOf(r) {
  const block = r.isPitcher ? r.truePotentialPitcher : r.truePotentialHitter
  if (!block) return avgEstOvr(r)
  const vals = Object.values(block).filter(v => typeof v === 'number' && v < 100)
  if (vals.length === 0) return avgEstOvr(r)
  return vals.reduce((s, v) => s + v, 0) / vals.length
}

/**
 * A recruit's effective VALUE to a program, blending current ability with
 * ceiling. Freshmen (HS) are projects judged mostly on UPSIDE; JUCO are
 * ready-now arms/bats judged mostly on CURRENT ability; 4-yr transfers sit in
 * between. `perceived=true` uses the noisy pre-scouting impression (for
 * deciding whom to chase); `perceived=false` uses true ratings (for the offer
 * decision, after scouting has revealed them).
 */
function recruitEffValue(save, r, perceived) {
  const ovr = perceived ? avgEstOvr(r) + noisyBias(save, r, 0) : avgEstOvr(r)
  const pot = perceived ? avgPotentialOf(r) + noisyBias(save, r, 7) : avgPotentialOf(r)
  if (r.pool === 'HS_SR')        return 0.45 * ovr + 0.55 * pot   // freshman — bet on the ceiling
  if (r.pool === 'JUCO_TRANSFER') return 0.72 * ovr + 0.28 * pot  // JUCO — ready now
  return 0.6 * ovr + 0.4 * pot                                    // 4-yr transfer
}

/**
 * The bar a recruit is measured against = average OVR of the user's likely
 * contributors (top ~25 on the roster). A weak program's bar is low, so it
 * courts + offers 60-OVR players; a strong program's bar is high, so it holds
 * out for studs (but still gambles on high-upside freshmen, whose effValue
 * leans on potential). This is what makes the logic adapt to the user's team.
 */
function teamBaselineOvr(save) {
  const team = save.teams?.[save.userSchoolId]
  const players = (team?.rosterPlayerIds || []).map(id => save.players[id]).filter(Boolean)
  if (!players.length) return 60
  const ovrs = players.map(p => playerOverall(p)).sort((a, b) => b - a).slice(0, 25)
  return ovrs.reduce((s, v) => s + v, 0) / ovrs.length
}

/**
 * Roster spots open for the upcoming recruiting cycle = cap − returning
 * (non-graduating) − already-committed. Mirrors RosterSnapshotPanel.
 */
function recruitingSpotsAvailable(save) {
  const cap = rosterCapForLevel(save.level || 'NAIA')
  const team = save.teams?.[save.userSchoolId]
  if (!team) return 0
  const players = (team.rosterPlayerIds || []).map(id => save.players[id]).filter(Boolean)
  const isGrad = (p) => p.classYear === 'SR' && !(p.redshirtUsed === true && (p.seasonsUsed ?? 0) < 4)
  const returning = players.filter(p => !isGrad(p)).length
  const committed = Object.values(save.recruits || {}).filter(
    r => r.signedTo === save.userSchoolId && r.status === 'signed',
  ).length
  return Math.max(0, cap - returning - committed)
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
  // CONCENTRATE, don't spread. The old loop touched 25 recruits one shallow
  // action at a time, which (combined with the action ladder gating the big
  // interest actions behind interest thresholds the recruit couldn't reach)
  // left the whole board stuck in the mid-30s — below the sign threshold — so
  // NOBODY ever committed. This version courts a focused set of priority
  // targets HARD: it runs each one up the full courtship ladder until their
  // interest is genuinely high, then extends an offer. Fewer recruits, but the
  // ones it works actually sign.
  const userSchoolId = save.userSchoolId
  const openList = () => Object.values(save.recruits || {}).filter(r => r.status === 'open')
  if (openList().length === 0) return 0
  const rng = makeRng('autoRecruit', save.calendar?.year, save.calendar?.weekOfYear, save.seed || 1)
  let spent = 0
  const apLeft = () => apBudget - spent
  const apply = (r, action) => {
    if (apLeft() < action.apCost) return false
    try {
      applyRecruitingAction(r, userSchoolId, action, rng)
      save.ap.currentWeek -= action.apCost
      save.ap.spentThisWeek = (save.ap.spentThisWeek || 0) + action.apCost
      spent += action.apCost
      return true
    } catch (err) { return false }
  }

  // How many MORE recruits we want to sign this cycle. We deliberately leave a
  // PORTAL_BUFFER of spots open so the user isn't maxed out before the summer
  // transfer portal — the old logic offered until the roster was full. Once
  // the class is (nearly) full this drops to 0 and the auto stops extending
  // new offers (it still nudges existing ones toward a decision).
  const PORTAL_BUFFER = 3
  const spotsOpen = recruitingSpotsAvailable(save)
  const maxActiveOffers = Math.max(0, spotsOpen - PORTAL_BUFFER)

  // ── Budget awareness ──────────────────────────────────────────────────
  // HARD RULE: never let total scholarship commitments exceed the pool. We
  // track the remaining available $ and cap every offer to it, decrementing as
  // we go. When money is tight relative to the spots we still want to fill,
  // offers shrink automatically (e.g. $20K left over 8 spots → ~$2.5K offers,
  // not $5-10K) — start low and reassess, exactly as a real budget forces.
  const pool = save.schools?.[userSchoolId]?.scholarshipPool ?? 0
  let availBudget = Math.max(0, scholarshipSnapshot(save).nextYearAvailable)
  const spotsToFill = Math.max(1, maxActiveOffers)
  // Effective per-recruit average: the smaller of the program's normal slice
  // (pool/40) and what the remaining budget actually supports across the spots
  // we still want to fill. This is what makes offers drop when money is tight.
  const normalAvg = pool > 0 ? pool / 40 : 0
  const effAvg = pool > 0 ? Math.min(normalAvg, availBudget / spotsToFill) : 0

  // The bar this program recruits against — average OVR of its contributors.
  // Everything below adapts to it, so a low-OVR NWAC/D3 program chases the
  // 58-65 kids it can actually land while Bushnell holds out for studs +
  // high-upside freshmen.
  const bar = teamBaselineOvr(save)

  // Priority targets ranked by PERCEIVED effective value (a noisy pre-scouting
  // impression blending current ability + ceiling), NOT true ratings — so the
  // auto can't omnisciently cherry-pick only the best and instead pursues some
  // prospects who turn out worse than they looked, plus high-upside projects.
  // The floor is team-relative (bar − 12) so weak programs court lower and
  // strong programs don't waste looks on players far below their level.
  const courtFloor = Math.max(40, bar - 12)
  const targets = openList()
    .map(r => ({ r, perceived: recruitEffValue(save, r, /* perceived */ true) }))
    .filter(t => t.perceived >= courtFloor)
    .sort((a, b) => b.perceived - a.perceived)
    .slice(0, 18)

  // Courtship ladder. SCOUT_TRIP first to clear fog, then the high-value
  // interest actions, then repeatable touches. One-shots are skipped if
  // already applied; TEXT/CALL repeat.
  const LADDER = [
    ACTION_TYPES.SCOUT_TRIP,
    ACTION_TYPES.CAMPUS_VISIT,
    ACTION_TYPES.HOME_VISIT,
    ACTION_TYPES.FAMILY_ZOOM,
    ACTION_TYPES.ASSISTANT_TALK,
    ACTION_TYPES.CALL,
    ACTION_TYPES.TEXT,
  ]
  const interestOf = (r) => r.scoutGrades?.[userSchoolId]?.interest ?? 0
  const wasApplied = (r, key) => (r.scoutGrades?.[userSchoolId]?.actionsApplied || []).includes(key)
  // OUTSTANDING offers only (open recruits) — signed recruits already counted
  // against spotsOpen, so we must NOT double-count them here.
  const openOffersCount = () => Object.values(save.recruits || {}).filter(
    r => r.status === 'open' && r.liveOffer?.schoolId === userSchoolId,
  ).length

  // Only pursue NEW recruits while we still have spots to fill. Once the class
  // is full (minus the portal buffer) we stop spending AP courting new kids and
  // just nudge the offers already out (below).
  for (const { r } of (maxActiveOffers > 0 ? targets : [])) {
    if (apLeft() < 1) break
    if (openOffersCount() >= maxActiveOffers) break   // class is full enough — stop pursuing new kids
    for (const action of LADDER) {
      if (apLeft() < action.apCost) continue
      if (interestOf(r) >= 60) break   // courted enough — go offer
      const repeatable = action.key === 'TEXT' || action.key === 'CALL'
      if (!repeatable && wasApplied(r, action.key)) continue
      apply(r, action)
    }
    // Extend an offer once we've built interest — but only to recruits worth it
    // FOR THIS PROGRAM. Worthiness is team-relative: a recruit's true effective
    // value (current ability + ceiling, weighted by freshman vs JUCO) must be
    // within ~6 of the team's bar. So a 62-OVR flatliner isn't worth it for
    // Bushnell, but a 62/88 freshman (high ceiling) is — and for a weak NWAC
    // program the same 62 is a clear get. The offer $ is scaled to the team's
    // pool (best recruits ~2× the team average, depth gets a token / $0 for
    // no-money D3/NWAC). $0 is a valid roster offer for broke programs.
    const eff = recruitEffValue(save, r, /* perceived */ false)
    const worthOffer = eff >= bar - 6
    if (!r.liveOffer && worthOffer && interestOf(r) >= 28
        && openOffersCount() < maxActiveOffers) {
      // Talent-based amount scaled to the program's EFFECTIVE average (budget-
      // aware), then HARD-CAPPED to the remaining available $ so we can never
      // blow past the scholarship budget. A broke / no-money program offers $0
      // (a roster offer) and the recruit decides on non-financial factors.
      let amt = computeAutoOffer(save, r, effAvg)
      amt = Math.min(amt, Math.max(0, Math.round(availBudget)))
      try {
        setLiveOffer(r, userSchoolId, amt)
        availBudget -= amt
      } catch (err) { /* pool tapped */ }
    }
  }

  // Leftover AP: keep nudging already-offered recruits who are still short of
  // a confident commit, cheapest-touch first, so the board keeps moving.
  let safety = 0
  while (apLeft() >= ACTION_TYPES.TEXT.apCost && safety < 400) {
    safety++
    const warm = Object.values(save.recruits || {})
      .filter(r => r.status === 'open' && r.liveOffer?.schoolId === userSchoolId && interestOf(r) < 60)
      .sort((a, b) => interestOf(b) - interestOf(a))
    if (warm.length === 0) break
    let did = false
    for (const r of warm) {
      const action = apLeft() >= ACTION_TYPES.CALL.apCost ? ACTION_TYPES.CALL : ACTION_TYPES.TEXT
      if (apLeft() < action.apCost) break
      if (apply(r, action)) did = true
    }
    if (!did) break
  }
  return spent
}

function computeAutoOffer(save, recruit, effAvg) {
  // TEAM- AND BUDGET-RELATIVE offer scale. The dollar figure is anchored to the
  // program's EFFECTIVE average scholarship (`effAvg`, which already accounts
  // for how much money is actually left), then scaled by how much the recruit
  // out-classes the team's bar:
  //   - effAvg 0 (no money / broke) → $0 roster offer.
  //   - The best recruits (well above the team's bar) command ~2-2.4× the
  //     effective average; an average fit gets ~1×; a project / depth piece a
  //     token amount, so the big money goes to the studs.
  if (!effAvg || effAvg <= 0) return 0   // no athletic money to spend
  const eff = recruitEffValue(save, recruit, /* perceived */ false)
  const bar = teamBaselineOvr(save)
  const rel = eff - bar   // how far above/below the program's level the recruit is
  // rel +15 → ~2.2×, rel 0 → 1.0×, rel −8 → ~0.36×. Floor 0.12×, cap 2.4×.
  const mult = Math.max(0.12, Math.min(2.4, 1.0 + rel * 0.08))
  let amt = effAvg * mult
  // Small in-state PNW discount (kids closer to home take a touch less).
  if (recruit.hometown?.state === 'OR' || recruit.hometown?.state === 'WA') amt *= 0.95
  amt = Math.round(amt / 250) * 250   // round to nearest $250 so offers read clean
  return Math.max(0, amt)
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
