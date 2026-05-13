import { useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import {
  generateHiringCandidates, OPTIONAL_ROLES, STARTING_ROLES, ROLE_DESCRIPTIONS,
  FIRST_YEAR_REQUIRED_ROLES,
} from '../../gm/engine/coaches'
import { makeRng } from '../../gm/engine/rng'
import { prettyLabel } from '../../gm/engine/format'
import { ensureUnifiedCalendar } from '../../gm/engine/gameYear'
import AttrTooltip from '../../gm/components/AttrTooltip'

const INTERVIEW_AP_COST = 20
const FIRE_AP_COST = 20

// Assistant coach pool the user starts with each year (per spec). Drives the
// "stay in your means" feel of Wk 2.
const ASSISTANT_HIRE_POOL = 40_000

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
  const remainingHirePool = ASSISTANT_HIRE_POOL - assistants.reduce((s, c) => s + (c.salary || 0), 0)

  const missingRequired = FIRST_YEAR_REQUIRED_ROLES.filter(r => !filledRoles.has(r))
  const allRequiredFilled = missingRequired.length === 0
  const showConfirmStaff = !isFirstYear && weekOfYear === 2 &&
    save.hiringConfirmed?.year !== save.calendar?.year

  function confirmStaffForYear() {
    save.hiringConfirmed = { year: save.calendar?.year }
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

  const totalPayroll = (headCoach.salary || 0) + assistants.reduce((s, c) => s + (c.salary || 0), 0)

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="mb-6 flex justify-between items-start">
        <div>
          <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Dashboard</Link>
          <h1 className="text-3xl font-bold text-pnw-slate mt-1">Coaching Staff</h1>
          <p className="text-sm text-gray-600">{assistants.length + 1} coaches total • Total payroll <span className="font-semibold">${(totalPayroll / 1000).toFixed(0)}K</span> • Interview costs {INTERVIEW_AP_COST} AP</p>
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
          <div className="text-sm text-amber-900">
            <strong>First year of your dynasty.</strong> You must hire all three required assistants
            (Pitching, Hitting, Bench coach) before advancing to Wk 3 budgeting. Assistant pool:
            <strong> ${(ASSISTANT_HIRE_POOL / 1000).toFixed(0)}K</strong> annually
            ({assistants.length === 0
              ? 'nothing spent yet'
              : `$${(((ASSISTANT_HIRE_POOL - remainingHirePool) / 1000).toFixed(1))}K committed, $${(remainingHirePool / 1000).toFixed(1)}K left`}).
            Interviews are <strong>FREE</strong> this week — AP is locked until Wk 4.
          </div>
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
        {assistants.map(c => (
          <div key={c.id} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <div className="flex justify-between items-start mb-2">
              <div>
                <div className="text-xs uppercase tracking-wider text-gray-500">{prettyLabel(c.role)}</div>
                {c.role === 'DATA_ANALYTICS_MANAGER' && (
                  <div className="text-[10px] text-blue-700">📊 Advanced stats unlocked</div>
                )}
              </div>
              <button onClick={() => fireCoach(c)} className="text-xs text-red-700 hover:underline">Fire</button>
            </div>
            <CoachCard coach={c} compact />
          </div>
        ))}
      </div>

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
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
              Optional Hires {optionalLocked && '🔒'}
            </h2>
            {optionalLocked && (
              <span className="text-[10px] text-gray-500 italic">
                Unlocks Week 4 — focus on required assistants first.
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {optionalAvailable.map(role => (
              <HireButton
                key={role}
                role={role}
                apCurrent={save.ap.currentWeek}
                cost={isTutorialHireWeek ? 0 : INTERVIEW_AP_COST}
                disabled={optionalLocked}
                onClick={() => startInterview(role)}
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
                <CoachCard coach={c} compact />
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

function CoachCard({ coach, compact }) {
  return (
    <div>
      <div className={'font-semibold ' + (compact ? '' : 'text-lg')}>{coach.firstName} {coach.lastName}</div>
      <div className="text-xs text-gray-500 mb-2">
        Age {coach.age} • {prettyLabel(coach.recruiter_type)} • {(coach.regions || []).join(', ')}
      </div>
      <div className="text-xs text-gray-500 mb-2">Pipelines: {(coach.pipelines || []).map(prettyLabel).join(', ') || 'none'}</div>
      <div className="grid grid-cols-4 gap-2 text-center text-xs">
        <AttrTooltip attr="developer">
          <div className="bg-gray-50 rounded p-1.5 cursor-help">
            <div className="font-bold text-pnw-green">{coach.developer}</div>
            <div className="text-[9px] uppercase text-gray-500">Dev</div>
          </div>
        </AttrTooltip>
        <AttrTooltip attr="motivator">
          <div className="bg-gray-50 rounded p-1.5 cursor-help">
            <div className="font-bold text-pnw-green">{coach.motivator}</div>
            <div className="text-[9px] uppercase text-gray-500">Mot</div>
          </div>
        </AttrTooltip>
        <AttrTooltip attr="recruiter">
          <div className="bg-gray-50 rounded p-1.5 cursor-help">
            <div className="font-bold text-pnw-green">{coach.recruiter}</div>
            <div className="text-[9px] uppercase text-gray-500">Rec</div>
          </div>
        </AttrTooltip>
        <AttrTooltip attr="tactician">
          <div className="bg-gray-50 rounded p-1.5 cursor-help">
            <div className="font-bold text-pnw-green">{coach.tactician}</div>
            <div className="text-[9px] uppercase text-gray-500">Tac</div>
          </div>
        </AttrTooltip>
      </div>
      <div className="text-xs text-gray-500 mt-2">
        {coach.salary > 0
          ? `Salary $${(coach.salary / 1000).toFixed(0)}K/yr • ${coach.contractYearsRemaining || 1} yr${coach.contractYearsRemaining === 1 ? '' : 's'} left`
          : `Unpaid GA position • 1 yr term`}
      </div>
    </div>
  )
}
