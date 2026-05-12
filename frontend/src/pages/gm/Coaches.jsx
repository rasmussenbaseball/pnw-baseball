import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import { generateCoach } from '../../gm/engine/coaches'
import { makeRng } from '../../gm/engine/rng'
import AttrTooltip from '../../gm/components/AttrTooltip'

const ROLES = [
  'PITCHING_COACH', 'HITTING_COACH', 'BENCH_COACH',
  'RECRUITING_COORDINATOR', 'STRENGTH_CONDITIONING', 'DIRECTOR_OF_OPERATIONS',
]

export default function Coaches() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => loadDynasty(userId, slot))
  const [interviewing, setInterviewing] = useState(null)   // role being interviewed
  const [candidates, setCandidates] = useState([])

  if (!save) return <Navigate to="/gm" replace />

  const userTeam = save.teams[save.userSchoolId]
  const userSchool = save.schools[save.userSchoolId]
  const headCoach = save.coaches[userTeam.headCoachId]
  const assistants = userTeam.assistantCoachIds.map(id => save.coaches[id]).filter(Boolean)

  function startInterview(role) {
    if (save.ap.currentWeek < 3) {
      alert('Interviewing costs 3 AP — not enough this week.')
      return
    }
    save.ap.currentWeek -= 3
    save.ap.spentThisWeek += 3
    save.ap.spentByCategory.staff = (save.ap.spentByCategory.staff || 0) + 3
    const rng = makeRng('interview', save.userSchoolId, role, Date.now())
    const slate = []
    for (let i = 0; i < 4; i++) {
      slate.push(generateCoach(userSchool, role, rng, { idPrefix: `cand_${role}_${i}` }))
    }
    setCandidates(slate)
    setInterviewing(role)
    saveDynasty(save)
    setSave({ ...save })
  }

  function hireCoach(candidate) {
    // Add to roster
    save.coaches[candidate.id] = candidate
    userTeam.assistantCoachIds = [...userTeam.assistantCoachIds, candidate.id]
    // Deduct salary from coaching budget allocation (informational; doesn't gate hiring)
    save.newsfeed.unshift({
      id: `hire_${candidate.id}_${save.calendar.year}`,
      year: save.calendar.year, week: save.calendar.week,
      type: 'COACH_HIRED',
      headline: `🧢 Hired ${candidate.firstName} ${candidate.lastName} as ${roleLabel(candidate.role)} ($${(candidate.salary / 1000).toFixed(0)}K/yr).`,
      payload: { coachId: candidate.id },
    })
    setInterviewing(null)
    setCandidates([])
    saveDynasty(save)
    setSave({ ...save })
  }

  function fireCoach(coach) {
    if (!confirm(`Fire ${coach.firstName} ${coach.lastName}? Buyout: $${(coach.salary * coach.contractYearsRemaining * 0.5 / 1000).toFixed(0)}K. This will hurt team morale briefly.`)) return
    const buyout = Math.round(coach.salary * coach.contractYearsRemaining * 0.5)
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

  // Roles you don't have an assistant for yet
  const filledRoles = new Set(assistants.map(c => c.role))
  const openRoles = ROLES.filter(r => !filledRoles.has(r))

  return (
    <div className="max-w-4xl mx-auto py-8">
      <div className="mb-6 flex justify-between items-start">
        <div>
          <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Dashboard</Link>
          <h1 className="text-3xl font-bold text-pnw-slate mt-1">Coaching Staff</h1>
          <p className="text-sm text-gray-600">{assistants.length + 1} coaches total • Interview costs 3 AP per role</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-pnw-green">{save.ap.currentWeek} AP</div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500">This week</div>
        </div>
      </div>

      {/* Head coach */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
        <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Head Coach (you)</div>
        <CoachCard coach={headCoach} />
      </div>

      {/* Current assistants */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {assistants.map(c => (
          <div key={c.id} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <div className="flex justify-between items-start mb-2">
              <div className="text-xs uppercase tracking-wider text-gray-500">{roleLabel(c.role)}</div>
              <button onClick={() => fireCoach(c)} className="text-xs text-red-700 hover:underline">Fire</button>
            </div>
            <CoachCard coach={c} compact />
          </div>
        ))}
      </div>

      {/* Open roles */}
      {openRoles.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-3">Open roles</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {openRoles.map(role => (
              <button
                key={role}
                onClick={() => startInterview(role)}
                disabled={save.ap.currentWeek < 3}
                className="text-left p-3 border border-gray-200 rounded hover:border-pnw-green hover:bg-pnw-cream disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <div className="flex justify-between">
                  <span className="font-semibold text-sm">{roleLabel(role)}</span>
                  <span className="text-xs bg-pnw-green text-white px-2 py-0.5 rounded">3 AP</span>
                </div>
                <div className="text-[10px] text-gray-500 mt-1">Interview 4 candidates</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {interviewing && candidates.length > 0 && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto p-6">
            <div className="flex justify-between items-start mb-3">
              <h3 className="text-xl font-bold text-pnw-slate">Interview — {roleLabel(interviewing)}</h3>
              <button onClick={() => { setInterviewing(null); setCandidates([]) }} className="text-gray-400">✕</button>
            </div>
            <div className="space-y-3">
              {candidates.map(c => (
                <div key={c.id} className="border border-gray-200 rounded p-3 flex items-start gap-4">
                  <div className="flex-1">
                    <CoachCard coach={c} compact />
                  </div>
                  <button
                    onClick={() => hireCoach(c)}
                    className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold whitespace-nowrap"
                  >
                    Hire ${(c.salary / 1000).toFixed(0)}K
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CoachCard({ coach, compact }) {
  return (
    <div>
      <div className={'font-semibold ' + (compact ? '' : 'text-lg')}>{coach.firstName} {coach.lastName}</div>
      <div className="text-xs text-gray-500 mb-2">
        Age {coach.age} • {coach.recruiter_type?.replace(/_/g, ' ')} • {(coach.regions || []).join(', ')}
      </div>
      <div className="text-xs text-gray-500 mb-2">Pipelines: {(coach.pipelines || []).join(', ') || 'none'}</div>
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
      <div className="text-xs text-gray-500 mt-2">Salary ${(coach.salary / 1000).toFixed(0)}K/yr • {coach.contractYearsRemaining} yr{coach.contractYearsRemaining === 1 ? '' : 's'} left</div>
    </div>
  )
}

function roleLabel(role) {
  return role.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, l => l.toUpperCase())
}
