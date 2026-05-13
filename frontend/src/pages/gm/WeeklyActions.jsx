import { useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import {
  fundraise, simProspectCamp, predictCampTurnout,
  CAMP_MIN_ATTENDEES, CAMP_MAX_ATTENDEES,
} from '../../gm/engine/recruits'
import { WEEKLY_ACTIONS, applyWeeklyAction, isActionAvailable } from '../../gm/engine/weeklyActions'
import { offseasonPhase } from '../../gm/engine/calendar'

const STUDY_HALL_AP = 3
const FUNDRAISE_MIN_AP = 1
const FUNDRAISE_MAX_AP = 15
const CAMP_MIN_FEE = 25
const CAMP_MAX_FEE = 300

export default function WeeklyActions() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => loadDynasty(userId, slot))
  const [fundAp, setFundAp] = useState(5)
  const [campFee, setCampFee] = useState(125)

  if (!save) return <Navigate to="/gm" replace />

  const userTeam = save.teams[save.userSchoolId]
  const userSchool = save.schools[save.userSchoolId]
  const userHC = save.coaches[userTeam.headCoachId]

  const ap = save.ap.currentWeek
  const studyHallActive = save.studyHall?.active === true
  const weeksActive = save.studyHall?.weeksActive || 0
  const currentPhase = save.calendar.mode === 'OFFSEASON'
    ? offseasonPhase(save.calendar.offseasonWeek)
    : 'In Season'
  const [actionReceipt, setActionReceipt] = useState(null)

  function doAction(action) {
    if (ap < action.apCost) { alert(`Need ${action.apCost} AP`); return }
    if (!isActionAvailable(action, save.calendar, currentPhase)) {
      alert(`Not available during ${currentPhase}.`)
      return
    }
    const result = applyWeeklyAction(save, action)
    spendAP('team_boost', action.apCost)
    save.newsfeed.unshift({
      id: `act_${action.key}_${save.calendar.year}_${save.calendar.week}_${Math.random().toString(36).slice(2, 5)}`,
      year: save.calendar.year, week: save.calendar.week,
      type: 'AWARD',
      headline: `${action.emoji} ${action.label} — ${result.playersAffected} player${result.playersAffected === 1 ? '' : 's'} bumped${result.injuries ? `, ${result.injuries} minor injury` : ''}.`,
      payload: result,
    })
    saveDynasty(save); setSave({ ...save })
    setActionReceipt(`${action.label}: bumped ${result.playersAffected} players (+${result.totalBumps} total ratings)${result.injuries ? `, ${result.injuries} minor injury` : ''}.`)
    setTimeout(() => setActionReceipt(null), 4000)
  }
  const campOpen = save.calendar.mode === 'OFFSEASON' &&
    save.calendar.offseasonWeek >= 1 && save.calendar.offseasonWeek <= 17
  const campAlreadyHeld = save.prospectCamp?.year === save.calendar.year

  function spendAP(cat, n) {
    save.ap.currentWeek -= n
    save.ap.spentThisWeek = (save.ap.spentThisWeek || 0) + n
    save.ap.spentByCategory = save.ap.spentByCategory || {}
    save.ap.spentByCategory[cat] = (save.ap.spentByCategory[cat] || 0) + n
  }

  function doStudyHall() {
    if (studyHallActive || ap < STUDY_HALL_AP) return
    spendAP('program', STUDY_HALL_AP)
    save.studyHall = { ...save.studyHall, active: true, weeksActive }
    saveDynasty(save); setSave({ ...save })
  }

  function doFundraise() {
    if (ap < fundAp) return
    const raised = fundraise(fundAp, userHC.motivator, userSchool.programHistory)
    save.budget.totalAthleticBudget = (save.budget.totalAthleticBudget || 0) + raised
    spendAP('program', fundAp)
    save.newsfeed.unshift({
      id: `fund_${save.calendar.year}_${save.calendar.week}_${Math.random().toString(36).slice(2, 5)}`,
      year: save.calendar.year, week: save.calendar.week,
      type: 'AWARD',
      headline: `💰 Fundraised ${fundAp} AP → +$${(raised / 1000).toFixed(1)}K to budget.`,
      payload: { raised },
    })
    saveDynasty(save); setSave({ ...save })
  }

  function doCamp() {
    if (!campOpen) { alert('Prospect camp runs Aug–Nov only.'); return }
    if (campAlreadyHeld) { alert('You\'ve already held this year\'s camp.'); return }
    const momentum = Math.round(
      ((userTeam.wins / Math.max(1, userTeam.wins + userTeam.losses)) || 0.5) * 100
    )
    const invitedIds = Object.values(save.recruits || {})
      .filter(r => r.campInvited && r.status !== 'signed' && r.status !== 'lost')
      .map(r => r.id)
    const result = simProspectCamp(
      save.recruits || {}, save.userSchoolId, invitedIds, campFee,
      userHC.recruiter, momentum, save.calendar.year, save.rngSeed + save.calendar.year,
    )
    if (result.cancelled) { alert(result.reason); return }
    save.recruits = result.recruits
    save.prospectCamp = { fee: campFee, attendees: result.attendeeIds.length, revenue: result.revenue, year: save.calendar.year }
    save.budget.totalAthleticBudget = (save.budget.totalAthleticBudget || 0) + result.revenue
    save.newsfeed.unshift({
      id: `camp_${save.calendar.year}`,
      year: save.calendar.year, week: save.calendar.week,
      type: 'AWARD',
      headline: `🏟 Prospect camp — ${result.attendeeIds.length} attendees at $${campFee} → +$${(result.revenue / 1000).toFixed(1)}K.`,
      payload: { fee: campFee, attendees: result.attendeeIds.length },
    })
    saveDynasty(save); setSave({ ...save })
  }

  const invitedIds = Object.values(save.recruits || {})
    .filter(r => r.campInvited && r.status !== 'signed' && r.status !== 'lost')
    .map(r => r.id)
  const campPredict = predictCampTurnout(
    save.recruits || {}, save.userSchoolId, invitedIds,
    campFee, userHC.recruiter,
    Math.round(((userTeam.wins / Math.max(1, userTeam.wins + userTeam.losses)) || 0.5) * 100),
  )
  const fundEstimate = fundraise(fundAp, userHC.motivator, userSchool.programHistory)

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <div className="mb-6 flex justify-between items-start">
        <div>
          <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Dashboard</Link>
          <h1 className="text-3xl font-bold text-pnw-slate mt-1">Weekly Actions</h1>
          <p className="text-sm text-gray-600">Spend your AP on program-wide actions outside of recruiting individual players.</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-pnw-green">{ap} AP</div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500">This week</div>
        </div>
      </div>

      {actionReceipt && (
        <div className="mb-4 bg-green-50 border border-green-200 rounded p-2 text-xs text-green-800">
          ✓ {actionReceipt}
        </div>
      )}

      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mt-6 mb-3">Team Practice / Development</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        {Object.values(WEEKLY_ACTIONS).map(a => {
          const available = isActionAvailable(a, save.calendar, currentPhase)
          const disabled = !available || ap < a.apCost
          return (
            <div key={a.key} className={'rounded-lg border p-3 ' + (disabled ? 'border-gray-200 bg-gray-50 opacity-60' : 'border-gray-200 bg-white hover:border-pnw-green')}>
              <div className="flex justify-between items-start mb-1">
                <div className="text-sm font-semibold text-pnw-slate">{a.emoji} {a.label}</div>
                <button
                  onClick={() => doAction(a)}
                  disabled={disabled}
                  className="px-2 py-1 text-xs rounded font-semibold bg-pnw-green text-white disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {a.apCost} AP
                </button>
              </div>
              <div className="text-[11px] text-gray-600">{a.blurb}</div>
              {!available && (
                <div className="text-[10px] text-amber-700 mt-1">Available: {a.availableIn.join(' / ')}</div>
              )}
            </div>
          )
        })}
      </div>

      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-3">Academics / Fundraising / Camp</h2>

      {/* Study Hall */}
      <ActionCard
        title="Mandate Study Hall"
        subtitle={`Lock in a +0.025 GPA bonus per active week (caps at +0.35). ${weeksActive} week${weeksActive === 1 ? '' : 's'} accrued this term.`}
        active={studyHallActive}
        disabled={studyHallActive || ap < STUDY_HALL_AP}
        actionLabel={studyHallActive ? 'Active' : `Mandate (${STUDY_HALL_AP} AP)`}
        onClick={doStudyHall}
      />

      {/* Fundraise */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
        <div className="flex justify-between items-start mb-2">
          <div>
            <div className="text-sm font-semibold text-pnw-slate">Fundraise</div>
            <div className="text-xs text-gray-500">
              Donor calls, alumni outreach, community events. Coach motivator + program history drive yield.
            </div>
          </div>
          <button
            onClick={doFundraise}
            disabled={ap < fundAp}
            className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Raise (${(fundEstimate / 1000).toFixed(1)}K est)
          </button>
        </div>
        <div className="flex items-center gap-3 mt-2">
          <span className="text-xs text-gray-500 w-12">{fundAp} AP</span>
          <input
            type="range"
            min={FUNDRAISE_MIN_AP} max={Math.min(FUNDRAISE_MAX_AP, ap)} step={1}
            value={fundAp}
            onChange={e => setFundAp(parseInt(e.target.value, 10))}
            className="flex-1"
          />
          <span className="text-xs font-mono w-20 text-right text-pnw-green">~${(fundEstimate / 1000).toFixed(1)}K</span>
        </div>
      </div>

      {/* Prospect Camp */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
        <div className="flex justify-between items-start mb-2">
          <div>
            <div className="text-sm font-semibold text-pnw-slate">Prospect Camp</div>
            <div className="text-xs text-gray-500">
              HS-only invite event. Min {CAMP_MIN_ATTENDEES} • max {CAMP_MAX_ATTENDEES} attendees. Aug–Nov window only.
              <span className="block mt-1">
                Currently invited: <strong>{invitedIds.length}</strong> recruits — manage via the
                {' '}<Link to={`/gm/recruiting?slot=${slot}`} className="text-pnw-green hover:underline">Recruiting → Camp Invites</Link> tab.
              </span>
            </div>
          </div>
          <button
            onClick={doCamp}
            disabled={!campOpen || campAlreadyHeld}
            className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
            title={campAlreadyHeld ? 'Already held this year' : !campOpen ? 'Out of window (Aug–Nov)' : ''}
          >
            {campAlreadyHeld ? 'Held' : 'Run camp'}
          </button>
        </div>
        <div className="flex items-center gap-3 mt-2">
          <span className="text-xs text-gray-500 w-14">${campFee} fee</span>
          <input
            type="range"
            min={CAMP_MIN_FEE} max={CAMP_MAX_FEE} step={5}
            value={campFee}
            onChange={e => setCampFee(parseInt(e.target.value, 10))}
            className="flex-1"
            disabled={!campOpen || campAlreadyHeld}
          />
          <span className="text-xs font-mono w-32 text-right text-gray-700">
            ~{campPredict.predictedAttendees} attendees<br/>
            ~${((campPredict.predictedAttendees * campFee) / 1000).toFixed(1)}K
          </span>
        </div>
        {campAlreadyHeld && (
          <div className="text-[11px] text-gray-500 mt-2">
            Held this year: {save.prospectCamp.attendees} attended @ ${save.prospectCamp.fee} → ${(save.prospectCamp.revenue / 1000).toFixed(1)}K.
          </div>
        )}
      </div>
    </div>
  )
}

function ActionCard({ title, subtitle, active, disabled, actionLabel, onClick }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4 flex justify-between items-start">
      <div>
        <div className="text-sm font-semibold text-pnw-slate">{title}</div>
        <div className="text-xs text-gray-500 max-w-md">{subtitle}</div>
      </div>
      <button
        onClick={onClick}
        disabled={disabled}
        className={'px-4 py-2 rounded text-sm font-semibold ' +
          (active ? 'bg-green-100 text-green-700 cursor-default'
            : 'bg-pnw-green text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed')
        }
      >
        {actionLabel}
      </button>
    </div>
  )
}
