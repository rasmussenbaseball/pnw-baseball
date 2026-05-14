import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import {
  generateHiringCandidates, OPTIONAL_ROLES, STARTING_ROLES, ROLE_DESCRIPTIONS,
  FIRST_YEAR_REQUIRED_ROLES,
  OPTIONAL_HIRE_META, generateOptionalHire, optionalHireBoosts,
} from '../../gm/engine/coaches'
import { ARCHETYPES, inferArchetype, staffRatings } from '../../gm/engine/archetypes'
import { makeRng } from '../../gm/engine/rng'
import { prettyLabel } from '../../gm/engine/format'
import { ensureUnifiedCalendar } from '../../gm/engine/gameYear'
import AttrTooltip from '../../gm/components/AttrTooltip'

const INTERVIEW_AP_COST = 20
const FIRE_AP_COST = 20

// Reference "average" coaching-staff payroll for a MID-tier NAIA program.
// Used purely as guidance — there's no hard cap. Spending past this means
// less $ available for facilities, travel, scholarships, etc.
const AVERAGE_COACHING_PAYROLL = 45_000

// Minimum number of assistants on every staff. The user must always have at
// least three filled (Pitching, Hitting, Bench).
const MIN_ASSISTANTS = 3

export default function Coaches() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => {
    const s = loadDynasty(userId, slot)
    if (s) ensureUnifiedCalendar(s)
    return s
  })
  const [interviewing, setInterviewing] = useState(null)
  const [candidates, setCandidates] = useState([])

  if (!save) return <Navigate to="/gm" replace />

  const userTeam = save.teams[save.userSchoolId]
  const userSchool = save.schools[save.userSchoolId]
  const headCoach = save.coaches[userTeam.headCoachId]
  const assistants = userTeam.assistantCoachIds.map(id => save.coaches[id]).filter(Boolean)

  const realAssistants = assistants.filter(c => !c.isSupportStaff)
  const filledRoles = new Set([headCoach.role, ...assistants.map(c => c.role)])
  const missingStarting = STARTING_ROLES.filter(r => !filledRoles.has(r))
  const optionalAvailable = OPTIONAL_ROLES.filter(r => !filledRoles.has(r))
  const hasAnalyticsMgr = filledRoles.has('DATA_ANALYTICS_MANAGER')

  // ── Wk 2 tutorial gating ────────────────────────────────────────────────
  // In Wk 2 the AP is locked at 0, so interviews must be FREE during the
  // tutorial. Optional support roles only unlock in Wk 4+.
  const weekOfYear = save.calendar?.weekOfYear ?? 1
  const isFirstYear = (save.dynastyYear ?? 1) === 1
  const isTutorialHireWeek = weekOfYear === 2
  const optionalLocked = weekOfYear < 4
  // Payroll excludes support staff (their salary is 0 anyway, but be explicit).
  const currentPayroll = realAssistants.reduce((s, c) => s + (c.salary || 0), 0)
  const overAverage = currentPayroll - AVERAGE_COACHING_PAYROLL

  const missingRequired = FIRST_YEAR_REQUIRED_ROLES.filter(r => !filledRoles.has(r))
  const allRequiredFilled = missingRequired.length === 0
  const showConfirmStaff = !isFirstYear && weekOfYear === 2 &&
    save.hiringConfirmed?.year !== save.calendar?.year

  function confirmStaffForYear() {
    save.hiringConfirmed = { year: save.calendar?.year }
    save.newsfeed.unshift({
      id: `staff_confirm_${save.calendar?.year}`,
      year: save.calendar?.year, week: save.calendar?.week, type: 'COACH_HIRED',
      headline: `🧢 Rolled forward your coaching staff for ${save.calendar?.year}.`,
      payload: {},
    })
    saveDynasty(save); setSave({ ...save })
  }

  function startInterview(role) {
    // Wk 2 tutorial: hires are FREE (AP is locked at 0 for wks 1-3). After
    // tutorial, the standard 20 AP / interview cost applies.
    const cost = isTutorialHireWeek ? 0 : INTERVIEW_AP_COST
    if (save.ap.currentWeek < cost) {
      alert(`Interviewing costs ${cost} AP — not enough this week.`)
      return
    }
    if (optionalLocked && !FIRST_YEAR_REQUIRED_ROLES.includes(role)) {
      alert('Optional coach roles unlock in Week 4. For now you can only hire your three required assistants.')
      return
    }
    save.ap.currentWeek -= cost
    save.ap.spentThisWeek += cost
    save.ap.spentByCategory.staff = (save.ap.spentByCategory.staff || 0) + cost
    const rng = makeRng('interview', save.userSchoolId, role, Date.now())
    const slate = generateHiringCandidates(userSchool, role, rng)
    setCandidates(slate)
    setInterviewing(role)
    saveDynasty(save)
    setSave({ ...save })
  }

  function hireOptionalSupport(role) {
    // Support-staff hire: 20 AP, no $ cost, no candidate slate. 1-year
    // contract that auto-expires at year-end (handled elsewhere via
    // contractYearsRemaining).
    const cost = INTERVIEW_AP_COST
    if (optionalLocked) {
      alert('Optional support-staff hires unlock Week 4.')
      return
    }
    if (save.ap.currentWeek < cost) {
      alert(`Hiring this support role costs ${cost} AP — not enough this week.`)
      return
    }
    save.ap.currentWeek -= cost
    save.ap.spentThisWeek += cost
    save.ap.spentByCategory.staff = (save.ap.spentByCategory.staff || 0) + cost
    const hire = generateOptionalHire(userSchool, role)
    save.coaches[hire.id] = hire
    userTeam.assistantCoachIds = [...userTeam.assistantCoachIds, hire.id]
    save.newsfeed.unshift({
      id: `opt_hire_${hire.id}_${save.calendar.year}`,
      year: save.calendar.year, week: save.calendar.week, type: 'COACH_HIRED',
      headline: `🧑‍💼 Brought on a ${OPTIONAL_HIRE_META[role]?.label || prettyLabel(role)} (1-yr contract).`,
      payload: { coachId: hire.id },
    })
    saveDynasty(save); setSave({ ...save })
  }

  function hireCoach(candidate) {
    save.coaches[candidate.id] = candidate
    userTeam.assistantCoachIds = [...userTeam.assistantCoachIds, candidate.id]
    save.newsfeed.unshift({
      id: `hire_${candidate.id}_${save.calendar.year}`,
      year: save.calendar.year, week: save.calendar.week,
      type: 'COACH_HIRED',
      headline: `🧢 Hired ${candidate.firstName} ${candidate.lastName} as ${prettyLabel(candidate.role)} ($${(candidate.salary / 1000).toFixed(0)}K/yr).`,
      payload: { coachId: candidate.id },
    })
    setInterviewing(null)
    setCandidates([])
    saveDynasty(save)
    setSave({ ...save })
  }

  function fireCoach(coach) {
    if (save.ap.currentWeek < FIRE_AP_COST) {
      alert(`Firing costs ${FIRE_AP_COST} AP — not enough this week.`)
      return
    }
    const buyout = Math.round(coach.salary * (coach.contractYearsRemaining || 1) * 0.5)
    if (!confirm(`Fire ${coach.firstName} ${coach.lastName}? Costs ${FIRE_AP_COST} AP + $${(buyout / 1000).toFixed(0)}K buyout. This will hurt team morale briefly.`)) return
    save.ap.currentWeek -= FIRE_AP_COST
    save.ap.spentThisWeek += FIRE_AP_COST
    save.ap.spentByCategory.staff = (save.ap.spentByCategory.staff || 0) + FIRE_AP_COST
    userTeam.assistantCoachIds = userTeam.assistantCoachIds.filter(id => id !== coach.id)
    save.budget.totalAthleticBudget = Math.max(0, (save.budget.totalAthleticBudget || 0) - buyout)
    save.newsfeed.unshift({
      id: `fire_${coach.id}_${save.calendar.year}`,
      year: save.calendar.year, week: save.calendar.week,
      type: 'COACH_LEFT',
      headline: `🔥 Fired ${coach.firstName} ${coach.lastName}. $${(buyout / 1000).toFixed(0)}K buyout charged.`,
      payload: { coachId: coach.id, buyout },
    })
    saveDynasty(save)
    setSave({ ...save })
  }

  const totalPayroll = (headCoach.salary || 0) + realAssistants.reduce((s, c) => s + (c.salary || 0), 0)

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="mb-6 flex justify-between items-start">
        <div>
          <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Dashboard</Link>
          <h1 className="text-3xl font-bold text-pnw-slate mt-1">Coaching Staff</h1>
          <p className="text-sm text-gray-600">
            {realAssistants.length + 1} coach{realAssistants.length + 1 === 1 ? '' : 'es'}
            {assistants.length > realAssistants.length && ` · ${assistants.length - realAssistants.length} support staff`}
            {' '}• Total payroll <span className="font-semibold">${(totalPayroll / 1000).toFixed(0)}K</span>
            {' '}• Interview costs {INTERVIEW_AP_COST} AP
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-pnw-green">{save.ap.currentWeek} AP</div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500">This week</div>
        </div>
      </div>

      {/* Wk 2 tutorial banner — year 1 forced hire */}
      {isTutorialHireWeek && isFirstYear && !allRequiredFilled && (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4 mb-4">
          <div className="text-[11px] uppercase tracking-wider text-amber-700 font-bold mb-1">
            Week 2 — Hire Your Assistants
          </div>
          <div className="text-sm text-amber-900 leading-snug">
            <strong>First year of your dynasty.</strong> You must hire all three required assistants
            (Pitching, Hitting, Bench coach) before advancing to Wk 3 budgeting.
            Interviews are <strong>FREE</strong> this week — AP is locked until Wk 4.
            <div className="mt-2 text-xs">
              The more you pay your coaches, the better they are — but every dollar
              here is a dollar you can't spend on facilities, travel, equipment, or
              scholarships in Wk 3. A typical NAIA program pays about <strong>${(AVERAGE_COACHING_PAYROLL / 1000).toFixed(0)}K total</strong> for
              their assistants combined.
            </div>
          </div>
        </div>
      )}

      {/* Payroll meter — always visible while hiring is happening */}
      {(isTutorialHireWeek || weekOfYear >= 2) && (
        <div className={'rounded-xl p-3 mb-4 border-2 ' +
          (overAverage > 20_000 ? 'border-red-300 bg-red-50'
           : overAverage > 0 ? 'border-amber-300 bg-amber-50'
           : 'border-green-300 bg-green-50')}>
          <div className="flex justify-between items-baseline text-xs">
            <span className="text-gray-700">
              <strong>Assistant payroll:</strong>{' '}
              <span className="font-mono font-bold text-base">${(currentPayroll / 1000).toFixed(1)}K</span>
              {' '}<span className="text-gray-500">/ ${(AVERAGE_COACHING_PAYROLL / 1000).toFixed(0)}K avg</span>
            </span>
            <span className={overAverage > 20_000 ? 'text-red-700 font-bold'
              : overAverage > 0 ? 'text-amber-700 font-bold' : 'text-green-700 font-bold'}>
              {overAverage > 0
                ? `+$${(overAverage / 1000).toFixed(1)}K over avg`
                : `$${(-overAverage / 1000).toFixed(1)}K under avg`}
            </span>
          </div>
          <div className="text-[11px] mt-1 text-gray-600">
            {overAverage > 20_000
              ? '⚠ Significantly over average — will eat into your Wk 3 budget for everything else.'
              : overAverage > 0
                ? 'Slightly over the typical NAIA spend.'
                : 'Within typical NAIA spend — leaves $ for facilities, travel, scholarships.'}
          </div>
        </div>
      )}

      {/* Minimum-assistants warning — support staff don't count */}
      {weekOfYear >= 2 && realAssistants.length < MIN_ASSISTANTS && (
        <div className="bg-red-50 border border-red-300 rounded-xl p-3 mb-4 text-sm text-red-900">
          <strong>⚠ Below the {MIN_ASSISTANTS}-assistant minimum.</strong> NAIA programs are required to
          carry at least three assistants (Pitching, Hitting, Bench). Hire to fill before sim.
        </div>
      )}
      {isTutorialHireWeek && isFirstYear && allRequiredFilled && (
        <div className="bg-green-50 border-2 border-green-300 rounded-xl p-3 mb-4 text-sm text-green-900">
          ✓ All three required assistants hired. Head back to the dashboard to advance to Wk 3 (budget).
        </div>
      )}

      {/* Year 2+ "Confirm staff" shortcut */}
      {showConfirmStaff && (
        <div className="bg-pnw-cream border-2 border-pnw-green/40 rounded-xl p-4 mb-4 flex justify-between items-center">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-pnw-green font-bold mb-1">
              Week 2 — Returning Year
            </div>
            <div className="text-sm text-pnw-slate">
              Happy with your current staff? Confirm and skip hiring this year. You can still
              fire / re-hire individual coaches if needed.
            </div>
          </div>
          <button
            onClick={confirmStaffForYear}
            className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold hover:opacity-90 shrink-0 ml-3"
          >
            Confirm staff ✓
          </button>
        </div>
      )}

      {/* Combined staff ratings — synergy panel */}
      <StaffRatingsPanel headCoach={headCoach} assistants={assistants} />

      {!hasAnalyticsMgr && weekOfYear >= 4 && (
        <div className="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-900 mb-4">
          💡 Hire a <strong>Data & Analytics Manager</strong> to unlock advanced stats (FIP, wOBA, wRC+, WAR) across the league.
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
        <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Head Coach (you)</div>
        <CoachCard coach={headCoach} />
      </div>

      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mt-6 mb-2">Assistants</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {assistants.filter(c => !c.isSupportStaff).map(c => (
          <div key={c.id} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <div className="flex justify-between items-start mb-2">
              <div>
                <div className="text-xs uppercase tracking-wider text-gray-500">{prettyLabel(c.role)}</div>
              </div>
              <button onClick={() => fireCoach(c)} className="text-xs text-red-700 hover:underline">Fire</button>
            </div>
            <CoachCard coach={c} compact />
          </div>
        ))}
      </div>

      {/* Active support staff — separate row so users see them as boosts, not coaches */}
      {assistants.some(c => c.isSupportStaff) && (
        <>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mt-6 mb-2">Active Support Staff</h2>
          <ActiveBoostsPanel team={userTeam} coaches={save.coaches} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            {assistants.filter(c => c.isSupportStaff).map(c => {
              const meta = OPTIONAL_HIRE_META[c.role]
              return (
                <div key={c.id} className="bg-white rounded-xl border border-pnw-green/30 p-3 shadow-sm">
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex items-start gap-2 flex-1 min-w-0">
                      <div className="text-xl shrink-0">{meta?.icon || '👤'}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs uppercase tracking-wider text-gray-500">{meta?.label || prettyLabel(c.role)}</div>
                        <div className="text-[11px] font-bold text-pnw-green mt-0.5">{meta?.effectLabel}</div>
                        <div className="text-[10px] text-gray-500 mt-0.5">{c.contractYearsRemaining || 1} yr left · free</div>
                      </div>
                    </div>
                    <button onClick={() => fireCoach(c)} className="text-xs text-red-700 hover:underline shrink-0">Release</button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {missingStarting.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-amber-900 mb-2">
            ⚠ {isTutorialHireWeek && isFirstYear ? 'Required hires' : 'Missing standard staff'}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {missingStarting.map(role => (
              <HireButton
                key={role}
                role={role}
                apCurrent={save.ap.currentWeek}
                cost={isTutorialHireWeek ? 0 : INTERVIEW_AP_COST}
                onClick={() => startInterview(role)}
              />
            ))}
          </div>
        </div>
      )}

      {optionalAvailable.length > 0 && (
        <div className={'rounded-xl border p-5 shadow-sm ' +
          (optionalLocked ? 'bg-gray-50 border-gray-200 opacity-70' : 'bg-white border-gray-200')}>
          <div className="flex justify-between items-baseline mb-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
                Optional Support Staff {optionalLocked && '🔒'}
              </h2>
              <p className="text-[11px] text-gray-500 mt-0.5">
                One-year contracts. Pay <strong>{INTERVIEW_AP_COST} AP</strong> — no salary, no negotiation.
                Effects apply while the role is filled.
              </p>
            </div>
            {optionalLocked && (
              <span className="text-[10px] text-gray-500 italic">
                Unlocks Week 4 — focus on required assistants first.
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {optionalAvailable.map(role => (
              <SupportStaffCard
                key={role}
                role={role}
                apCurrent={save.ap.currentWeek}
                apCost={INTERVIEW_AP_COST}
                disabled={optionalLocked}
                onHire={() => hireOptionalSupport(role)}
              />
            ))}
          </div>
        </div>
      )}

      {interviewing && candidates.length > 0 && (
        <InterviewModal
          role={interviewing}
          candidates={candidates}
          onHire={hireCoach}
          onClose={() => { setInterviewing(null); setCandidates([]) }}
        />
      )}
    </div>
  )
}

function ActiveBoostsPanel({ team, coaches }) {
  const boosts = useMemo(() => optionalHireBoosts(team.assistantCoachIds, coaches), [team, coaches])
  const items = []
  if (boosts.apBonus > 0) items.push({ label: `+${boosts.apBonus} AP / week`, color: 'text-pnw-green' })
  if (boosts.injuryMult < 1.0) items.push({ label: `−${Math.round((1 - boosts.injuryMult) * 100)}% injury risk`, color: 'text-green-700' })
  if (boosts.durabilityBump > 0) items.push({ label: `+${boosts.durabilityBump} durability`, color: 'text-pnw-green' })
  if (boosts.budgetBonus > 0) items.push({ label: `+$${(boosts.budgetBonus / 1000).toFixed(0)}K budget`, color: 'text-emerald-700' })
  if (boosts.advancedStats) items.push({ label: 'Advanced stats unlocked', color: 'text-blue-700' })
  if (items.length === 0) return null
  return (
    <div className="bg-pnw-cream/50 border border-pnw-green/30 rounded-lg p-3 mb-3">
      <div className="text-[10px] uppercase tracking-wider text-pnw-slate font-bold mb-1">Active staff boosts</div>
      <div className="flex flex-wrap gap-2">
        {items.map((it, i) => (
          <span key={i} className={'text-xs font-semibold bg-white px-2 py-1 rounded ' + it.color}>{it.label}</span>
        ))}
      </div>
    </div>
  )
}

function SupportStaffCard({ role, apCurrent, apCost, disabled, onHire }) {
  const meta = OPTIONAL_HIRE_META[role]
  const cantAfford = apCurrent < apCost
  return (
    <div className={'border rounded-lg p-3 ' +
      (disabled ? 'border-gray-200 bg-gray-50 opacity-60' : 'border-gray-200 hover:border-pnw-green hover:bg-pnw-cream/40 transition')}>
      <div className="flex items-start gap-3">
        <div className="text-2xl shrink-0">{meta?.icon || '👤'}</div>
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-baseline gap-2">
            <div className="font-semibold text-sm text-pnw-slate">{meta?.label || prettyLabel(role)}</div>
            <span className="text-[10px] uppercase tracking-wider text-pnw-green font-bold whitespace-nowrap">
              {meta?.effectLabel}
            </span>
          </div>
          <div className="text-[11px] text-gray-600 mt-1 leading-snug">{meta?.blurb}</div>
          <button
            onClick={onHire}
            disabled={disabled || cantAfford}
            className="mt-2 px-3 py-1.5 bg-pnw-green text-white rounded text-xs font-semibold w-full hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Hire — {apCost} AP · 1-yr
          </button>
        </div>
      </div>
    </div>
  )
}

function HireButton({ role, apCurrent, cost = 20, disabled = false, onClick }) {
  const desc = ROLE_DESCRIPTIONS[role]
  const cantAfford = apCurrent < cost
  return (
    <button
      onClick={onClick}
      disabled={disabled || cantAfford}
      className="text-left p-3 border border-gray-200 rounded hover:border-pnw-green hover:bg-pnw-cream disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <div className="flex justify-between items-baseline">
        <span className="font-semibold text-sm">{prettyLabel(role)}</span>
        <span className={'text-xs px-2 py-0.5 rounded ' + (cost === 0 ? 'bg-green-600 text-white' : 'bg-pnw-green text-white')}>
          {cost === 0 ? 'FREE' : `${cost} AP`}
        </span>
      </div>
      <div className="text-[11px] text-gray-500 mt-1">{desc}</div>
    </button>
  )
}

function InterviewModal({ role, candidates, onHire, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto p-6">
        <div className="flex justify-between items-start mb-3">
          <div>
            <h3 className="text-xl font-bold text-pnw-slate">Interview — {prettyLabel(role)}</h3>
            <div className="text-xs text-gray-500 mt-1">{ROLE_DESCRIPTIONS[role]}</div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        <div className="space-y-3">
          {candidates.map(c => (
            <div key={c.id} className="border border-gray-200 rounded p-3 flex items-start gap-4">
              <div className="flex-1">
                <CoachCard coach={c} compact hideStats />
              </div>
              <button
                onClick={() => onHire(c)}
                className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold whitespace-nowrap"
              >
                {c.salary > 0 ? `Hire $${(c.salary / 1000).toFixed(0)}K` : 'Hire (free)'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function CoachCard({ coach, compact, hideStats }) {
  // For prospective hires we deliberately blind 2 of the 4 metrics so the
  // user can't just always pick the best — adds uncertainty to interviews.
  // Choice is deterministic per coach.id so the same hidden pair shows on
  // every render.
  const visibleStats = useMemo(() => {
    if (!hideStats) return new Set(['developer', 'motivator', 'recruiter', 'tactician'])
    const all = ['developer', 'motivator', 'recruiter', 'tactician']
    // Tiny stable hash from coach id
    let h = 0
    const s = coach.id || ''
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
    // Pick 2 distinct indices
    const a = h % 4
    let b = (h >> 4) % 4
    if (b === a) b = (b + 1) % 4
    return new Set([all[a], all[b]])
  }, [coach.id, hideStats])

  function stat(key, label) {
    const reveal = visibleStats.has(key)
    return (
      <AttrTooltip attr={reveal ? key : null} text={reveal ? null : 'Hidden until hired'}>
        <div className="bg-gray-50 rounded p-1.5 cursor-help">
          <div className={'font-bold ' + (reveal ? 'text-pnw-green' : 'text-gray-400')}>
            {reveal ? coach[key] : '?'}
          </div>
          <div className="text-[9px] uppercase text-gray-500">{label}</div>
        </div>
      </AttrTooltip>
    )
  }

  const arcKey = coach.archetype || inferArchetype(coach)
  const arc = ARCHETYPES[arcKey] || ARCHETYPES.GENERALIST
  return (
    <div>
      <div className={'font-semibold ' + (compact ? '' : 'text-lg')}>{coach.firstName} {coach.lastName}</div>
      <div className="text-xs text-gray-500 mb-1">
        Age {coach.age} • <span className={'font-semibold ' + arc.color}>{arc.label}</span>
      </div>
      <div className="text-[11px] text-gray-500 mb-2">
        Regions: {(coach.regions || []).join(', ') || 'home state'}
      </div>
      <div className="grid grid-cols-4 gap-2 text-center text-xs">
        {stat('developer', 'Dev')}
        {stat('motivator', 'Mot')}
        {stat('recruiter', 'Rec')}
        {stat('tactician', 'Tac')}
      </div>
      <div className="text-xs text-gray-500 mt-2">
        {coach.salary > 0
          ? `Salary $${(coach.salary / 1000).toFixed(0)}K/yr • ${coach.contractYearsRemaining || 1} yr${coach.contractYearsRemaining === 1 ? '' : 's'} left`
          : `Unpaid GA position • 1 yr term`}
      </div>
    </div>
  )
}

function StaffRatingsPanel({ headCoach, assistants }) {
  const r = useMemo(() => staffRatings(headCoach, assistants), [headCoach, assistants])
  const hcArc = ARCHETYPES[r.hcArchetype] || ARCHETYPES.GENERALIST
  const synergyColor = r.synergy > 1.03 ? 'text-green-700'
    : r.synergy > 1.0 ? 'text-pnw-green'
    : r.synergy < 1.0 ? 'text-red-700' : 'text-gray-700'
  return (
    <div className="bg-pnw-cream/60 rounded-xl border border-pnw-green/40 p-4 mb-4">
      <div className="flex justify-between items-start mb-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-pnw-slate font-bold">Coaching Staff Ratings</div>
          <div className="text-[11px] text-gray-600 mt-0.5">
            Combined averages across all coaches × synergy. Drives team-wide effects in sim + recruiting.
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-bold text-pnw-green leading-none">{r.overall}</div>
          <div className="text-[10px] uppercase text-gray-500">Staff OVR</div>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2 text-center mb-3">
        <RatingTile label="Dev" v={r.developer} />
        <RatingTile label="Mot" v={r.motivator} />
        <RatingTile label="Rec" v={r.recruiter} />
        <RatingTile label="Tac" v={r.tactician} />
      </div>
      <div className="bg-white rounded p-2 text-xs">
        <span className="text-gray-500">HC archetype:</span>{' '}
        <span className={'font-semibold ' + hcArc.color}>{hcArc.label}</span>
        <span className="ml-2 text-gray-500">→ Synergy:</span>{' '}
        <span className={'font-mono font-semibold ' + synergyColor}>
          {((r.synergy - 1) * 100 > 0 ? '+' : '') + ((r.synergy - 1) * 100).toFixed(0)}%
        </span>
        <div className="text-[11px] text-gray-600 mt-0.5">{r.synergyLabel}</div>
      </div>
    </div>
  )
}

function RatingTile({ label, v }) {
  return (
    <div className="bg-white rounded p-2">
      <div className="text-lg font-bold text-pnw-green leading-none">{v}</div>
      <div className="text-[9px] uppercase text-gray-500">{label}</div>
    </div>
  )
}
