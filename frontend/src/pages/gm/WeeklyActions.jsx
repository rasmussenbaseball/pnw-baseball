import { useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import {
  fundraise, simProspectCamp, predictCampTurnout,
  CAMP_MIN_ATTENDEES, CAMP_MAX_ATTENDEES,
} from '../../gm/engine/recruits'
import { WEEKLY_ACTIONS, applyWeeklyAction, isActionAvailable, isActionUsedThisWeek, markActionUsedThisWeek } from '../../gm/engine/weeklyActions'
import { prettyLabel, displayClassYear } from '../../gm/engine/format'
import { offseasonPhase } from '../../gm/engine/calendar'
import { applyMeetingBoost, ensureHappiness, happinessLevel, HAPPINESS_DISPLAY } from '../../gm/engine/happiness'
import { playerOverall } from '../../gm/engine/playerRating'

const STUDY_HALL_AP = 2
const STUDY_HALL_BONUS = 0.02
const EXTRA_STUDY_HALL_AP = 6
const EXTRA_STUDY_HALL_BONUS = 0.05
const FUNDRAISE_AP = 10
const CAMP_MIN_FEE = 25
const CAMP_MAX_FEE = 300
const MEETING_AP_PER_PLAYER = 2
const MEETING_MAX_PLAYERS = 5
const MEETING_MIN_PLAYERS = 1
const MEETING_BOOST = 15
const MEETING_WEEKS = 4

export default function WeeklyActions() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => loadDynasty(userId, slot))
  const [campFee, setCampFee] = useState(125)
  const [meetingPicks, setMeetingPicks] = useState([])

  if (!save) return <Navigate to="/gm" replace />

  const userTeam = save.teams[save.userSchoolId]
  const userSchool = save.schools[save.userSchoolId]
  const userHC = save.coaches[userTeam.headCoachId]

  const ap = save.ap.currentWeek
  const studyHallBonus = save.studyHall?.cumulativeBonus || 0
  const currentPhase = save.calendar.mode === 'OFFSEASON'
    ? offseasonPhase(save.calendar.offseasonWeek)
    : 'In Season'
  const [actionReceipt, setActionReceipt] = useState(null)

  function doAction(action, variant) {
    const cost = variant === 'TEMPORARY' ? action.tempAp : action.permAp
    if (ap < cost) { alert(`Need ${cost} AP`); return }
    if (!isActionAvailable(action, currentPhase)) {
      alert(`Not available during ${currentPhase}.`)
      return
    }
    if (isActionUsedThisWeek(save, action.key)) {
      alert('Already done this week.')
      return
    }
    const result = applyWeeklyAction(save, action, variant)
    spendAP('team_boost', cost)
    markActionUsedThisWeek(save, action.key)
    const variantLabel = variant === 'TEMPORARY' ? 'temp 4-wk' : 'permanent'
    const bumpedKeys = action.ratingKey === '__velocity' ? 'velo' : prettyLabel(action.ratingKey)
    save.newsfeed.unshift({
      id: `act_${action.key}_${save.calendar.year}_${save.calendar.week}_${Math.random().toString(36).slice(2, 5)}`,
      year: save.calendar.year, week: save.calendar.week,
      type: 'AWARD',
      headline: `${action.emoji} ${action.label} (${variantLabel}) — bumped ${bumpedKeys} for ${result.playersAffected} players.`,
      payload: result,
    })
    saveDynasty(save); setSave({ ...save })
    setActionReceipt(`✓ ${action.label} (${variantLabel}) — +${result.perPlayerBump.toFixed(1)} avg ${bumpedKeys} on ${result.playersAffected} players.`)
    setTimeout(() => setActionReceipt(null), 5000)
  }
  // Prospect Camp is permanently the first week of November = offseasonWeek 14.
  const CAMP_WEEK = 14
  const campOpen = save.calendar.mode === 'OFFSEASON' &&
    save.calendar.offseasonWeek === CAMP_WEEK
  const campAlreadyHeld = save.prospectCamp?.year === save.calendar.year

  function spendAP(cat, n) {
    save.ap.currentWeek -= n
    save.ap.spentThisWeek = (save.ap.spentThisWeek || 0) + n
    save.ap.spentByCategory = save.ap.spentByCategory || {}
    save.ap.spentByCategory[cat] = (save.ap.spentByCategory[cat] || 0) + n
  }

  function doStudyHall(level = 'NORMAL') {
    const cost = level === 'EXTRA' ? EXTRA_STUDY_HALL_AP : STUDY_HALL_AP
    const bonus = level === 'EXTRA' ? EXTRA_STUDY_HALL_BONUS : STUDY_HALL_BONUS
    if (ap < cost) return
    if (wasUsedThisWeek('STUDY_HALL')) { alert('Already done this week.'); return }
    spendAP('program', cost)
    save.studyHall = {
      ...save.studyHall,
      cumulativeBonus: (save.studyHall?.cumulativeBonus || 0) + bonus,
    }
    // Apply the bonus to every player's GPA immediately so the change is
    // visible right away (was only applied at term-end before).
    const team = save.teams[save.userSchoolId]
    for (const id of team.rosterPlayerIds) {
      const p = save.players[id]
      if (!p) continue
      p.gpa = Math.min(4.0, Math.round((p.gpa + bonus) * 100) / 100)
    }
    markUsedThisWeek('STUDY_HALL')
    saveDynasty(save); setSave({ ...save })
  }

  function wasUsedThisWeek(key) {
    return isActionUsedThisWeek(save, key)
  }
  function markUsedThisWeek(key) {
    markActionUsedThisWeek(save, key)
  }

  function doMeetings() {
    if (meetingPicks.length < MEETING_MIN_PLAYERS) { alert('Pick at least 1 player.'); return }
    const cost = meetingPicks.length * MEETING_AP_PER_PLAYER
    if (ap < cost) { alert(`Need ${cost} AP for ${meetingPicks.length} meetings.`); return }
    if (wasUsedThisWeek('PLAYER_MEETINGS')) { alert('Already done this week.'); return }
    for (const pid of meetingPicks) {
      const p = save.players[pid]
      if (p) applyMeetingBoost(p, MEETING_BOOST, MEETING_WEEKS)
    }
    spendAP('program', cost)
    markUsedThisWeek('PLAYER_MEETINGS')
    save.newsfeed.unshift({
      id: `meet_${save.calendar.year}_${save.calendar.week}_${Math.random().toString(36).slice(2, 5)}`,
      year: save.calendar.year, week: save.calendar.week,
      type: 'AWARD',
      headline: `🗣 1-on-1 meetings — boosted morale for ${meetingPicks.length} player${meetingPicks.length === 1 ? '' : 's'}.`,
      payload: { ids: meetingPicks },
    })
    setMeetingPicks([])
    saveDynasty(save); setSave({ ...save })
  }

  function doFundraise() {
    if (ap < FUNDRAISE_AP) return
    if (wasUsedThisWeek('FUNDRAISE')) { alert('Already done this week.'); return }
    const raised = fundraise(FUNDRAISE_AP, userHC.motivator, userSchool.programHistory)
    save.budget.totalAthleticBudget = (save.budget.totalAthleticBudget || 0) + raised
    spendAP('program', FUNDRAISE_AP)
    markUsedThisWeek('FUNDRAISE')
    save.newsfeed.unshift({
      id: `fund_${save.calendar.year}_${save.calendar.week}_${Math.random().toString(36).slice(2, 5)}`,
      year: save.calendar.year, week: save.calendar.week,
      type: 'AWARD',
      headline: `💰 Fundraised ${FUNDRAISE_AP} AP → +$${(raised / 1000).toFixed(1)}K to budget.`,
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
    save.prospectCamp = {
      fee: campFee,
      year: save.calendar.year,
      attendeeIds: result.attendeeIds,
      attendees: result.attendeeIds.length,
      revenue: result.revenue,
    }
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
  const fundEstimate = fundraise(FUNDRAISE_AP, userHC.motivator, userSchool.programHistory)

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

      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mt-6 mb-1">Team Practice / Development</h2>
      <p className="text-[11px] text-gray-500 mb-3">Permanent boosts stick; Temporary boosts give a bigger bump but wear off after 4 weeks. Once per week each.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        {Object.values(WEEKLY_ACTIONS).map(a => {
          const available = isActionAvailable(a, currentPhase)
          const usedThisWeek = isActionUsedThisWeek(save, a.key)
          const baseDisabled = !available || usedThisWeek
          const targetLabel = a.target === 'hitters' ? 'hitters' : a.target === 'pitchers' ? 'pitchers' : 'all players'
          const keysLabel = a.ratingKey === '__velocity' ? 'Velocity' : prettyLabel(a.ratingKey)
          return (
            <div key={a.key} className={'rounded-lg border p-3 ' + (baseDisabled ? 'border-gray-200 bg-gray-50 opacity-70' : 'border-gray-200 bg-white')}>
              <div className="flex justify-between items-baseline mb-1">
                <div className="text-sm font-semibold text-pnw-slate">{a.emoji} {a.label}</div>
                {usedThisWeek && <span className="text-[10px] text-green-700 font-bold">✓ used this week</span>}
              </div>
              <div className="text-[11px] text-gray-600 mb-2">
                {a.blurb} • Targets <strong>{keysLabel}</strong> ({targetLabel}).
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => doAction(a, 'PERMANENT')}
                  disabled={baseDisabled || ap < a.permAp}
                  className="text-left p-2 border border-pnw-green/30 bg-pnw-cream rounded hover:bg-pnw-green hover:text-white disabled:opacity-40 disabled:cursor-not-allowed group"
                >
                  <div className="flex justify-between items-center">
                    <span className="text-[11px] font-semibold">Permanent</span>
                    <span className="text-[10px] bg-pnw-green text-white px-1.5 py-0.5 rounded group-hover:bg-white group-hover:text-pnw-green">{a.permAp} AP</span>
                  </div>
                  <div className="text-[10px] text-gray-600 group-hover:text-white">+{a.permAmount.toFixed(1)} per stat, permanent</div>
                </button>
                <button
                  onClick={() => doAction(a, 'TEMPORARY')}
                  disabled={baseDisabled || ap < a.tempAp}
                  className="text-left p-2 border border-blue-300 bg-blue-50 rounded hover:bg-blue-600 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed group"
                >
                  <div className="flex justify-between items-center">
                    <span className="text-[11px] font-semibold">Temporary (4 wks)</span>
                    <span className="text-[10px] bg-blue-600 text-white px-1.5 py-0.5 rounded group-hover:bg-white group-hover:text-blue-700">{a.tempAp} AP</span>
                  </div>
                  <div className="text-[10px] text-gray-600 group-hover:text-white">+{a.tempAmount.toFixed(1)} per stat, lasts 4 wk</div>
                </button>
              </div>
              {!available && (
                <div className="text-[10px] text-amber-700 mt-1">Available: {a.availableIn.join(' / ')}</div>
              )}
            </div>
          )
        })}
      </div>

      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-3">Player Morale</h2>
      <PlayerMeetings
        save={save}
        meetingPicks={meetingPicks}
        setMeetingPicks={setMeetingPicks}
        ap={ap}
        usedThisWeek={wasUsedThisWeek('PLAYER_MEETINGS')}
        onRun={doMeetings}
      />

      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-3 mt-6">Academics / Fundraising / Camp</h2>

      {/* Study Hall — two levels */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
        <div className="text-sm font-semibold text-pnw-slate mb-1">Study Hall</div>
        <div className="text-xs text-gray-500 mb-3">
          Boosts team GPA at term-end. Cumulative this term: <span className="font-semibold text-pnw-green">+{studyHallBonus.toFixed(2)} GPA</span> (cap +0.60).
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => doStudyHall('NORMAL')}
            disabled={ap < STUDY_HALL_AP || studyHallBonus >= 0.6}
            className="text-left p-3 border border-gray-200 rounded hover:border-pnw-green hover:bg-pnw-cream disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <div className="flex justify-between"><span className="font-semibold text-sm">Standard</span><span className="text-xs bg-pnw-green text-white px-2 py-0.5 rounded">{STUDY_HALL_AP} AP</span></div>
            <div className="text-[11px] text-gray-500 mt-1">+0.02 team GPA this term.</div>
          </button>
          <button
            onClick={() => doStudyHall('EXTRA')}
            disabled={ap < EXTRA_STUDY_HALL_AP || studyHallBonus >= 0.6}
            className="text-left p-3 border border-gray-200 rounded hover:border-pnw-green hover:bg-pnw-cream disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <div className="flex justify-between"><span className="font-semibold text-sm">Extra Study Hall</span><span className="text-xs bg-pnw-green text-white px-2 py-0.5 rounded">{EXTRA_STUDY_HALL_AP} AP</span></div>
            <div className="text-[11px] text-gray-500 mt-1">+0.05 team GPA this term. Bigger lift, costlier.</div>
          </button>
        </div>
      </div>

      {/* Fundraise — fixed 10 AP */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4 flex justify-between items-start">
        <div>
          <div className="text-sm font-semibold text-pnw-slate">Fundraise</div>
          <div className="text-xs text-gray-500 max-w-md">
            Donor calls, alumni outreach, community events. Coach motivator + program history drive the yield. ~${(fundEstimate / 1000).toFixed(1)}K estimated.
          </div>
        </div>
        <button
          onClick={doFundraise}
          disabled={ap < FUNDRAISE_AP || wasUsedThisWeek('FUNDRAISE')}
          className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {wasUsedThisWeek('FUNDRAISE') ? '✓ done this week' : `Raise (${FUNDRAISE_AP} AP)`}
        </button>
      </div>

      {/* Prospect Camp — fixed date: first week of November */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
        <div className="flex justify-between items-start mb-2">
          <div>
            <div className="text-sm font-semibold text-pnw-slate">Prospect Camp <span className="text-xs text-gray-500 font-normal">(annual, first week of November)</span></div>
            <div className="text-xs text-gray-500">
              HS-only event. Min {CAMP_MIN_ATTENDEES} • max {CAMP_MAX_ATTENDEES} attendees.
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
            title={campAlreadyHeld ? 'Already held this year' : !campOpen ? 'Camp window is the first week of November' : ''}
          >
            {campAlreadyHeld ? 'Held' : campOpen ? 'Run camp' : 'Locked'}
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
          <CampAttendees save={save} />
        )}
      </div>
    </div>
  )
}

function PlayerMeetings({ save, meetingPicks, setMeetingPicks, ap, usedThisWeek, onRun }) {
  const team = save.teams[save.userSchoolId]
  const players = team.rosterPlayerIds.map(id => save.players[id]).filter(Boolean)
  // Sort: unhappy first, then by OVR descending — surfaces the players who
  // need attention without burying the stars.
  const sorted = [...players].sort((a, b) => {
    const ha = ensureHappiness(a).value
    const hb = ensureHappiness(b).value
    if (ha !== hb) return ha - hb
    return playerOverall(b) - playerOverall(a)
  })

  const cost = meetingPicks.length * MEETING_AP_PER_PLAYER
  const canAfford = ap >= cost
  const maxedOut = meetingPicks.length >= MEETING_MAX_PLAYERS

  function toggle(id) {
    if (meetingPicks.includes(id)) {
      setMeetingPicks(meetingPicks.filter(x => x !== id))
    } else {
      if (meetingPicks.length >= MEETING_MAX_PLAYERS) return
      setMeetingPicks([...meetingPicks, id])
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
      <div className="flex justify-between items-start mb-2">
        <div>
          <div className="text-sm font-semibold text-pnw-slate">🗣 1-on-1 Meetings</div>
          <div className="text-xs text-gray-500 max-w-xl">
            Pull aside up to {MEETING_MAX_PLAYERS} players and check in. Each costs {MEETING_AP_PER_PLAYER} AP and bumps their happiness for {MEETING_WEEKS} weeks.
            Sorted with the most-unhappy players on top so you don't miss them.
          </div>
        </div>
        <button
          onClick={onRun}
          disabled={usedThisWeek || meetingPicks.length === 0 || !canAfford}
          className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {usedThisWeek
            ? '✓ done this week'
            : meetingPicks.length === 0
              ? 'Pick players first'
              : `Meet (${meetingPicks.length} player${meetingPicks.length === 1 ? '' : 's'} · ${cost} AP)`}
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto border border-gray-100 rounded mt-3">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-[10px] uppercase text-gray-500 sticky top-0">
            <tr>
              <th className="text-left px-2 py-1">Pick</th>
              <th className="text-left px-2 py-1">Name</th>
              <th className="text-left px-2 py-1">Pos</th>
              <th className="text-left px-2 py-1">Cls</th>
              <th className="text-left px-2 py-1">OVR</th>
              <th className="text-left px-2 py-1">Happiness</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(p => {
              const checked = meetingPicks.includes(p.id)
              const h = ensureHappiness(p)
              const level = happinessLevel(h.value)
              const d = HAPPINESS_DISPLAY[level]
              const disabled = !checked && (maxedOut || usedThisWeek)
              return (
                <tr key={p.id} className={'border-t ' + (checked ? 'bg-pnw-cream' : '')}>
                  <td className="px-2 py-1">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(p.id)}
                    />
                  </td>
                  <td className="px-2 py-1 font-medium">{p.firstName} {p.lastName}</td>
                  <td className="px-2 py-1 text-gray-600">{p.isPitcher ? 'P' : p.primaryPosition}</td>
                  <td className="px-2 py-1 text-gray-600">{displayClassYear(p)}</td>
                  <td className="px-2 py-1 font-mono text-gray-700">{playerOverall(p)}</td>
                  <td className="px-2 py-1">
                    <span className={'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ' + d.color + ' ' + d.bg}>
                      <span>{d.emoji}</span>
                      <span className="font-semibold">{d.label}</span>
                      <span className="text-gray-400 font-mono">{h.value}</span>
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CampAttendees({ save }) {
  const [open, setOpen] = useState(false)
  const camp = save.prospectCamp
  if (!camp) return null
  const ids = camp.attendeeIds || []
  return (
    <div className="text-[11px] text-gray-600 mt-3 border-t pt-2">
      <button onClick={() => setOpen(o => !o)} className="font-semibold text-pnw-slate hover:underline">
        {open ? '▾' : '▸'} Held this year: {camp.attendees} attended @ ${camp.fee} → ${(camp.revenue / 1000).toFixed(1)}K
      </button>
      {open && (
        <div className="mt-2 max-h-72 overflow-y-auto">
          {ids.length === 0 ? <div className="text-gray-400">No attendees recorded.</div> :
            <table className="w-full text-[11px]">
              <thead className="text-[10px] uppercase text-gray-500">
                <tr>
                  <th className="text-left py-0.5">Recruit</th>
                  <th>Pos</th>
                  <th>State</th>
                  <th>Interest</th>
                  <th>Scout fog</th>
                  <th>Priorities</th>
                </tr>
              </thead>
              <tbody>
                {ids.map(id => {
                  const r = save.recruits?.[id]
                  if (!r) return null
                  const g = r.scoutGrades?.[save.userSchoolId] || {}
                  return (
                    <tr key={id} className="border-t">
                      <td className="py-0.5">{r.firstName} {r.lastName}</td>
                      <td className="text-center">{r.isPitcher ? 'P' : r.primaryPosition}</td>
                      <td className="text-center">{r.hometown.state}</td>
                      <td className="text-center font-mono">{g.interest ?? 0}</td>
                      <td className="text-center font-mono">±{g.noise ?? 15}</td>
                      <td className="text-center">{(g.revealedPreferences || []).length}/8</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          }
        </div>
      )}
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
