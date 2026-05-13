import { useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import {
  fundraise, simProspectCamp, predictCampTurnout,
  CAMP_MIN_ATTENDEES, CAMP_MAX_ATTENDEES,
} from '../../gm/engine/recruits'

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
    const result = simProspectCamp(
      save.recruits || {}, save.userSchoolId, [], campFee,
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

  const campPredict = predictCampTurnout(
    save.recruits || {}, save.userSchoolId, [],
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
