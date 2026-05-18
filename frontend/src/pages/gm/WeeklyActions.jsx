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
import GMShell, { ContextBox } from '../../gm/components/GMShell'

const STUDY_HALL_AP = 2
const STUDY_HALL_BONUS = 0.02
const EXTRA_STUDY_HALL_AP = 6
const EXTRA_STUDY_HALL_BONUS = 0.05
// Targeted tutoring: pick exactly 3 players, spend a big chunk of AP, get a
// per-player GPA boost much larger than blanket study hall. Use this when
// you have a couple specific guys hovering near 2.0 / ineligibility.
const TUTORING_AP = 5
const TUTORING_PICKS = 3
const TUTORING_BOOST = 0.20    // +0.20 GPA per player picked
const FUNDRAISE_AP = 10
const CAMP_MIN_FEE = 25
const CAMP_MAX_FEE = 300
const MEETING_AP_PER_PLAYER = 2
const MEETING_MAX_PLAYERS = 5
const MEETING_MIN_PLAYERS = 1
const MEETING_BOOST = 12

// 1-on-1 development — pick a single player + a single rating; spend AP to
// bump that stat permanently (within the player's potential ceiling).
const ONE_ON_ONE_AP = 8
const ONE_ON_ONE_BUMP = 3   // points of rating per session

export default function WeeklyActions() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => loadDynasty(userId, slot))
  const [campFee, setCampFee] = useState(125)
  const [meetingPicks, setMeetingPicks] = useState([])
  const [tutoringPicks, setTutoringPicks] = useState([])
  const [oneOnOnePlayer, setOneOnOnePlayer] = useState('')
  const [oneOnOneRating, setOneOnOneRating] = useState('')

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
    setActionReceipt(`${action.label} (${variantLabel}) — +${result.perPlayerBump.toFixed(1)} avg ${bumpedKeys} on ${result.playersAffected} players.`)
    setTimeout(() => setActionReceipt(null), 5000)
  }
  // Prospect Camp runs at Week 13 (late October). The phase-gate at Wk 13 in
  // gameYear.js blocks the user from advancing until the camp has been held,
  // so this check MUST line up with that. (Old code checked offseasonWeek
  // === 14 which created a soft-lock — phase-gate said "run camp now," but
  // the Run Camp button stayed locked until Wk 14, which the user couldn't
  // reach. Fixed by switching to weekOfYear.)
  const CAMP_WEEK = 13
  const weekOfYear = save.calendar?.weekOfYear
    ?? (save.calendar?.mode === 'OFFSEASON' ? save.calendar?.offseasonWeek : null)
  const campOpen = weekOfYear === CAMP_WEEK
  const campAlreadyHeld = save.prospectCamp?.year === save.calendar.year
  const weeksUntilCamp = weekOfYear != null && weekOfYear < CAMP_WEEK
    ? CAMP_WEEK - weekOfYear
    : null

  function spendAP(cat, n) {
    save.ap.currentWeek -= n
    save.ap.spentThisWeek = (save.ap.spentThisWeek || 0) + n
    save.ap.spentByCategory = save.ap.spentByCategory || {}
    save.ap.spentByCategory[cat] = (save.ap.spentByCategory[cat] || 0) + n
  }

  function doStudyHall(level = 'NORMAL') {
    const cost = level === 'EXTRA' ? EXTRA_STUDY_HALL_AP : STUDY_HALL_AP
    const bonus = level === 'EXTRA' ? EXTRA_STUDY_HALL_BONUS : STUDY_HALL_BONUS
    // GPA only moves during academic semesters (fall Wks 5-18, spring 23-42).
    // Outside those windows school isn't in session, so study hall has no
    // effect — surface that explicitly instead of silently bumping GPAs in
    // the summer / preseason / winter break.
    const wkOfYear = save.calendar?.weekOfYear ?? 0
    const inSemester = (wkOfYear >= 5 && wkOfYear <= 18) || (wkOfYear >= 23 && wkOfYear <= 42)
    if (!inSemester) {
      alert('School\'s not in session. Study Hall only works during the fall semester (Wks 5-18) or spring semester (Wks 23-42).')
      return
    }
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

  function doTutoring() {
    if (tutoringPicks.length !== TUTORING_PICKS) {
      alert(`Pick exactly ${TUTORING_PICKS} players to send to the tutoring group.`)
      return
    }
    if (ap < TUTORING_AP) return
    if (wasUsedThisWeek('TUTORING_GROUP')) { alert('Tutoring group already ran this week.'); return }
    const wkOfYear = save.calendar?.weekOfYear ?? 0
    const inSemester = (wkOfYear >= 5 && wkOfYear <= 18) || (wkOfYear >= 23 && wkOfYear <= 42)
    if (!inSemester) {
      alert('School\'s not in session. Tutoring only works during the fall semester (Wks 5-18) or spring semester (Wks 23-42).')
      return
    }
    spendAP('program', TUTORING_AP)
    for (const pid of tutoringPicks) {
      const p = save.players[pid]
      if (!p) continue
      p.gpa = Math.min(4.0, Math.round((p.gpa + TUTORING_BOOST) * 100) / 100)
    }
    markUsedThisWeek('TUTORING_GROUP')
    save.newsfeed.unshift({
      id: `tutor_${save.calendar.year}_${save.calendar.week}_${Math.random().toString(36).slice(2, 5)}`,
      year: save.calendar.year, week: save.calendar.week, type: 'ACADEMIC',
      headline: `Tutoring group — ${tutoringPicks.length} players each got a +${TUTORING_BOOST.toFixed(2)} GPA boost.`,
      payload: { ids: [...tutoringPicks] },
    })
    setTutoringPicks([])
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
      if (p) applyMeetingBoost(p, MEETING_BOOST)
    }
    spendAP('program', cost)
    markUsedThisWeek('PLAYER_MEETINGS')
    save.newsfeed.unshift({
      id: `meet_${save.calendar.year}_${save.calendar.week}_${Math.random().toString(36).slice(2, 5)}`,
      year: save.calendar.year, week: save.calendar.week,
      type: 'AWARD',
      headline: `1-on-1 meetings — boosted morale for ${meetingPicks.length} player${meetingPicks.length === 1 ? '' : 's'}.`,
      payload: { ids: meetingPicks },
    })
    setMeetingPicks([])
    saveDynasty(save); setSave({ ...save })
  }

  function do1on1Dev() {
    if (!oneOnOnePlayer || !oneOnOneRating) {
      alert('Pick a player and a rating to develop.')
      return
    }
    if (ap < ONE_ON_ONE_AP) { alert(`Need ${ONE_ON_ONE_AP} AP.`); return }
    if (wasUsedThisWeek('ONE_ON_ONE_DEV')) { alert('Already done this week.'); return }
    const p = save.players[oneOnOnePlayer]
    if (!p) { alert('Player not found.'); return }
    const isPitcher = p.isPitcher
    const block = isPitcher ? p.pitcher : p.hitter
    if (!block || typeof block[oneOnOneRating] !== 'number') {
      alert('That rating doesn\'t apply to this player.')
      return
    }
    // Potential is no longer a hard CEILING — it's a SPEED multiplier for
    // dev. High-potential players get a bigger bump per session; low-potential
    // players grow slower but can still reach any rating if they keep working.
    // Hard cap is just the 99 max of the rating scale.
    const potRating = isPitcher
      ? (p.hidden?.potential_pitcher?.[oneOnOneRating] ?? 70)
      : (p.hidden?.potential_hitter?.[oneOnOneRating] ?? 70)
    // Potential 70 = 1.0× rate, 99 = ~1.4×, 50 = ~0.7×, 30 = ~0.4×
    const potMult = Math.max(0.35, Math.min(1.5, potRating / 70))
    const before = block[oneOnOneRating]
    const baseBump = ONE_ON_ONE_BUMP * potMult
    const actualBump = Math.min(baseBump, Math.max(0, 99 - before))
    if (actualBump <= 0) { alert('Player is already at 99 in this rating.'); return }
    block[oneOnOneRating] = Math.round((before + actualBump) * 10) / 10
    // Track as a permanent bump so the rating shows on Roster + PlayerDetail
    if (!save.permanentBumps) save.permanentBumps = []
    save.permanentBumps.push({
      playerId: p.id,
      ratingKey: oneOnOneRating,
      side: isPitcher ? 'pitcher' : 'hitter',
      amount: actualBump,
      weekApplied: save.calendar.week,
    })
    spendAP('development', ONE_ON_ONE_AP)
    markUsedThisWeek('ONE_ON_ONE_DEV')
    save.newsfeed.unshift({
      id: `1on1_${p.id}_${save.calendar.year}_${save.calendar.week}`,
      year: save.calendar.year, week: save.calendar.week,
      type: 'AWARD',
      headline: `1-on-1 dev — ${p.firstName} ${p.lastName} ${prettyLabel(oneOnOneRating)} +${actualBump.toFixed(1)}.`,
      payload: { playerId: p.id, rating: oneOnOneRating, amount: actualBump },
    })
    setOneOnOnePlayer('')
    setOneOnOneRating('')
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
      headline: `Fundraised ${FUNDRAISE_AP} AP +$${(raised / 1000).toFixed(1)}K to budget.`,
      payload: { raised },
    })
    saveDynasty(save); setSave({ ...save })
  }

  function doCamp() {
    if (!campOpen) { alert(`Prospect camp opens in Week ${CAMP_WEEK} (late October). Wait until then to run it.`); return }
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
      headline: `Prospect camp — ${result.attendeeIds.length} attendees at $${campFee} +$${(result.revenue / 1000).toFixed(1)}K.`,
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
    <GMShell schoolName={userSchool?.name} schoolColors={userSchool?.colors}>
    <div className="max-w-4xl mx-auto">
      <div className="mb-6 flex justify-between items-start">
        <div>
          <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">WEEKLY ACTIONS</h1>
          <p className="font-pixel text-base text-[#a8a8c8]">Spend your AP on program-wide actions outside of individual recruiting.</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-pnw-green">{ap} AP</div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500">This week</div>
        </div>
      </div>

      {actionReceipt && (
        <div className="mb-4 bg-green-50 border border-green-200 rounded p-2 text-xs text-green-800">
           {actionReceipt}
        </div>
      )}

      {/* HOW WEEKLY ACTIONS WORK — context box. Hidden after first read via
          flags.weeklyActionsHelp, but always reopenable from the tutorial. */}
      <ContextBox storageKey="weeklyActionsHelp" title="How weekly actions work">
        <ul className="list-disc list-inside space-y-1">
          <li><strong>Practice drills</strong> bump a chosen rating (contact, power, stuff, etc.) on every eligible player. <em>Temporary</em> variants cost less AP and last 4 weeks; <em>permanent</em> costs more and adds a +1 rating that sticks.</li>
          <li><strong>Velocity Program</strong> targets pitchers' FB velo — small permanent mph gain at the cost of 1-2 stamina pts.</li>
          <li><strong>1-on-1 Development</strong> picks a single player + single rating for a +3 bump. Expensive (8 AP) but precise — use it on a player who's close to a breakthrough.</li>
          <li><strong>Study Hall</strong> (2 AP) stacks a small permanent boost on every player's end-of-term GPA. Run it 6-8 weeks in a row to lift a struggling team out of probation.</li>
          <li><strong>Team Meeting</strong> rebuilds happiness on selected players. Costs 2 AP per player, +12 happiness each.</li>
          <li><strong>Fundraising</strong> (10 AP) raises ~$8K-$11K added straight to your annual budget. Best when you have AP to spare and need scholarship $.</li>
        </ul>
        <p className="mt-2 text-xs text-gray-300">Each action is one-per-week unless noted. Unspent AP at week's end is <strong>lost</strong> — it does not carry over.</p>
      </ContextBox>

      {/* TOP-OF-PAGE PROSPECT CAMP BANNER — shown only when camp week is active
          OR camp was already held this year. Pinned high so users who click
          through from the Dashboard phase-gate land on it immediately. */}
      {(campOpen || campAlreadyHeld) && (
        <ProspectCampBanner
          save={save}
          slot={slot}
          campOpen={campOpen}
          campAlreadyHeld={campAlreadyHeld}
          invitedCount={invitedIds.length}
          campFee={campFee}
          setCampFee={setCampFee}
          campPredict={campPredict}
          onRunCamp={doCamp}
        />
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
                {usedThisWeek && <span className="text-[10px] text-green-700 font-bold"> used this week</span>}
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

      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-3 mt-6">1-on-1 Development</h2>
      <OneOnOneDev
        save={save}
        ap={ap}
        playerId={oneOnOnePlayer}
        rating={oneOnOneRating}
        setPlayerId={setOneOnOnePlayer}
        setRating={setOneOnOneRating}
        cost={ONE_ON_ONE_AP}
        bump={ONE_ON_ONE_BUMP}
        usedThisWeek={wasUsedThisWeek('ONE_ON_ONE_DEV')}
        onRun={do1on1Dev}
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

      {/* Tutoring Group — pick exactly 3 players, big targeted boost */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
        <div className="flex justify-between items-start mb-1">
          <div>
            <div className="text-sm font-semibold text-pnw-slate">Tutoring Group ({TUTORING_AP} AP)</div>
            <div className="text-xs text-gray-500">
              Pick exactly {TUTORING_PICKS} players. Each gets <span className="font-semibold text-pnw-green">+{TUTORING_BOOST.toFixed(2)} GPA</span> immediately — much bigger lift than blanket study hall, for the guys you're actually worried about. Once per week.
            </div>
          </div>
          <button
            type="button"
            onClick={doTutoring}
            disabled={ap < TUTORING_AP || tutoringPicks.length !== TUTORING_PICKS || wasUsedThisWeek('TUTORING_GROUP')}
            className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            {wasUsedThisWeek('TUTORING_GROUP') ? 'Done this week' : `Run (${TUTORING_AP} AP)`}
          </button>
        </div>
        <TutoringPicker
          save={save}
          picks={tutoringPicks}
          setPicks={setTutoringPicks}
          max={TUTORING_PICKS}
          disabled={wasUsedThisWeek('TUTORING_GROUP')}
        />
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
          {wasUsedThisWeek('FUNDRAISE') ? ' done this week' : `Raise (${FUNDRAISE_AP} AP)`}
        </button>
      </div>

      {/* Prospect Camp info card — when camp ISN'T this week + hasn't been held.
          Live banner above handles the "do it now" + "results" states. */}
      {!campOpen && !campAlreadyHeld && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
          <div className="flex justify-between items-start gap-3">
            <div>
              <div className="text-sm font-semibold text-pnw-slate">
                 Prospect Camp <span className="text-xs text-gray-500 font-normal">— annual recruiting event (Week 13, late October)</span>
              </div>
              <div className="text-xs text-gray-600 mt-1 leading-snug max-w-2xl">
                Once a year, run a HS-only prospect camp on your campus. Invited recruits attend, you charge a fee
                ($25-$300 — higher = revenue, lower = bigger turnout), and every attendee leaves <strong>+5 interest</strong>
                in your program plus they get partially scouted automatically (~50%).
                Big-revenue swing day for any program.
              </div>
              <div className="text-xs text-gray-600 mt-2">
                <strong>How it works (3 steps):</strong>
                <ol className="list-decimal ml-4 mt-1 space-y-0.5">
                  <li><strong>Wks 5 & 10</strong> — invite up to 50 recruits each window from the <Link to={`/gm/recruiting?slot=${slot}`} className="text-pnw-green hover:underline">Recruiting</Link> page</li>
                  <li><strong>Wk 13</strong> — come back here, pick a fee, click <em>Run camp</em></li>
                  <li>Results post immediately — revenue is added to your budget, attendees show up partially scouted on your recruit board</li>
                </ol>
              </div>
              <div className="text-[11px] text-gray-500 mt-2">
                Currently invited: <strong>{invitedIds.length}</strong> recruit{invitedIds.length === 1 ? '' : 's'}.
                {weeksUntilCamp != null && weeksUntilCamp > 0 && (
                  <> · Camp runs in <strong>{weeksUntilCamp}</strong> week{weeksUntilCamp === 1 ? '' : 's'}.</>
                )}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[10px] uppercase tracking-wider text-gray-500">Status</div>
              <div className="font-bold text-gray-400"> Locked — Wk {CAMP_WEEK}</div>
            </div>
          </div>
        </div>
      )}
    </div>
    </GMShell>
  )
}

function ProspectCampBanner({ save, slot, campOpen, campAlreadyHeld, invitedCount, campFee, setCampFee, campPredict, onRunCamp }) {
  if (campAlreadyHeld) {
    const camp = save.prospectCamp
    return (
      <div className="bg-green-50 border-2 border-green-300 rounded-xl p-4 mb-4 shadow-sm">
        <div className="flex justify-between items-start gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-green-700 font-bold mb-1">
               Prospect Camp — held this year
            </div>
            <div className="text-sm text-green-900">
              <strong>{camp.attendees}</strong> attendees at <strong>${camp.fee}</strong> per head 
              <strong> +${(camp.revenue / 1000).toFixed(1)}K</strong> revenue added to your budget.
            </div>
            <div className="text-[11px] text-green-800 mt-1">
              Attendees gained +5 interest and ended up ~50% scouted on your board.
              Camp is done for the year — comes around again next October.
            </div>
          </div>
        </div>
        <CampAttendees save={save} />
      </div>
    )
  }

  // campOpen && !held — the live run-camp UI
  return (
    <div className="bg-amber-50 border-2 border-amber-400 rounded-xl p-5 mb-4 shadow-md">
      <div className="text-xs uppercase tracking-wider text-amber-700 font-bold mb-1">
         Required Action · Week 13
      </div>
      <div className="flex justify-between items-start gap-4">
        <div className="flex-1">
          <h2 className="text-lg font-bold text-amber-900"> Run your Prospect Camp</h2>
          <p className="text-sm text-amber-900 mt-1 leading-snug">
            This is the once-a-year recruiting camp on your campus. <strong>You must run it
            before you can advance to Week 14</strong> — pick a fee below and click <em>Run Camp Now</em>.
          </p>
          <div className="bg-white/70 rounded p-2 mt-2 text-xs text-amber-900">
            <strong className="text-amber-900">What this does:</strong> Every invited recruit ({invitedCount} on the list right now)
            gets ~50% scouted for free + <strong>+5 interest</strong> in you. Plus the fee × attendees = real revenue into your budget.
            <span className="block mt-1">
              <strong>Not enough invites?</strong> Bummer — you can\'t add more now. Invites were the
              {' '}<Link to={`/gm/recruiting?slot=${slot}`} className="underline font-semibold">Recruiting page</Link>{' '}
              in Wks 5 & 10. Still run camp at lowest fee for revenue + scouting on who you do have.
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4 bg-white rounded-lg p-3 border border-amber-300">
        <div className="flex items-center gap-3 mb-2">
          <div className="text-xs text-amber-900 font-semibold">Set the camp fee:</div>
          <span className="text-lg font-bold font-mono text-pnw-green">${campFee}</span>
          <span className="text-[10px] text-gray-500">per attendee</span>
        </div>
        <input
          type="range"
          min={CAMP_MIN_FEE} max={CAMP_MAX_FEE} step={5}
          value={campFee}
          onChange={e => setCampFee(parseInt(e.target.value, 10))}
          className="w-full"
        />
        <div className="flex justify-between text-[10px] text-gray-500 mt-0.5">
          <span>${CAMP_MIN_FEE} — bigger turnout</span>
          <span>${CAMP_MAX_FEE} — more revenue / smaller turnout</span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="bg-gray-50 rounded p-2">
            <div className="text-lg font-bold text-pnw-slate">{invitedCount}</div>
            <div className="text-[10px] uppercase text-gray-500">Invited</div>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <div className="text-lg font-bold text-pnw-slate">~{campPredict.predictedAttendees}</div>
            <div className="text-[10px] uppercase text-gray-500">Expected attendees</div>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <div className="text-lg font-bold text-green-700">${((campPredict.predictedAttendees * campFee) / 1000).toFixed(1)}K</div>
            <div className="text-[10px] uppercase text-gray-500">Est. revenue</div>
          </div>
        </div>
        <button
          onClick={onRunCamp}
          className="mt-4 w-full px-4 py-3 bg-pnw-green text-white rounded text-base font-bold hover:opacity-90"
        >
          Run Camp Now 
        </button>
      </div>
    </div>
  )
}

/**
 * 3-player picker for the targeted tutoring action. Pre-sorts by lowest
 * GPA so the at-risk guys float to the top — that's almost always who
 * the user wants to send.
 */
function TutoringPicker({ save, picks, setPicks, max, disabled }) {
  const team = save.teams[save.userSchoolId]
  const players = (team?.rosterPlayerIds || [])
    .map(id => save.players[id])
    .filter(p => p && p.eligibilityStatus !== 'cut' && p.eligibilityStatus !== 'dismissed')
    .sort((a, b) => (a.gpa ?? 4) - (b.gpa ?? 4))
  function toggle(id) {
    if (disabled) return
    if (picks.includes(id)) setPicks(picks.filter(x => x !== id))
    else if (picks.length < max) setPicks([...picks, id])
  }
  return (
    <div className="mt-3">
      <div className="text-[11px] text-gray-500 mb-1.5">
        {picks.length}/{max} selected · Lowest-GPA players listed first.
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5 max-h-56 overflow-y-auto pr-1">
        {players.slice(0, 30).map(p => {
          const on = picks.includes(p.id)
          const atRisk = (p.gpa ?? 4) < 2.5
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => toggle(p.id)}
              disabled={disabled || (!on && picks.length >= max)}
              className={
                'text-left text-xs px-2 py-1.5 rounded border transition ' +
                (on
                  ? 'border-pnw-green bg-pnw-green/10 text-pnw-slate'
                  : atRisk
                    ? 'border-amber-300 bg-amber-50 hover:bg-amber-100'
                    : 'border-gray-200 hover:bg-gray-50') +
                (disabled || (!on && picks.length >= max) ? ' opacity-50 cursor-not-allowed' : '')
              }
            >
              <div className="font-medium truncate">{p.firstName} {p.lastName}</div>
              <div className="text-[10px] text-gray-500 font-mono">
                GPA {p.gpa?.toFixed(2) ?? '—'} · {displayClassYear(p)}
                {atRisk && <span className="ml-1 text-amber-700 font-bold">AT RISK</span>}
              </div>
            </button>
          )
        })}
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
          <div className="text-sm font-semibold text-pnw-slate"> 1-on-1 Meetings</div>
          <div className="text-xs text-gray-500 max-w-xl">
            Pull aside up to {MEETING_MAX_PLAYERS} players and check in. Each costs {MEETING_AP_PER_PLAYER} AP and immediately bumps their happiness +{MEETING_BOOST}. The lift is permanent in the sense that nothing reverses it — but normal happiness drift still applies, so if their situation doesn't improve they'll drift back down.
            Sorted with the most-unhappy players on top so you don't miss them.
          </div>
        </div>
        <button
          onClick={onRun}
          disabled={usedThisWeek || meetingPicks.length === 0 || !canAfford}
          className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {usedThisWeek
            ? ' done this week'
            : meetingPicks.length === 0
              ? 'Pick players first'
              : `Meet (${meetingPicks.length} player${meetingPicks.length === 1 ? '' : 's'} · ${cost} AP)`}
        </button>
      </div>
      <div className="max-h-64 overflow-auto border border-gray-100 rounded mt-3">
        <table className="w-full text-xs min-w-[480px]">
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

function OneOnOneDev({ save, ap, playerId, rating, setPlayerId, setRating, cost, bump, usedThisWeek, onRun }) {
  const team = save.teams[save.userSchoolId]
  const players = team.rosterPlayerIds.map(id => save.players[id]).filter(Boolean)
  const sorted = [...players].sort((a, b) => playerOverall(b) - playerOverall(a))
  const player = playerId ? save.players[playerId] : null
  const isPitcher = player?.isPitcher
  // Available ratings depend on the picked player. Pitcher pitcher block keys;
  // hitter hitter block keys (skip velocity_* which aren't user-controlled).
  const ratingKeys = !player
    ? []
    : isPitcher
      ? Object.keys(player.pitcher || {}).filter(k => !k.startsWith('velocity'))
      : Object.keys(player.hitter || {})
  const potRating = !player ? null
    : isPitcher
      ? (player.hidden?.potential_pitcher?.[rating] ?? 70)
      : (player.hidden?.potential_hitter?.[rating] ?? 70)
  const current = !player || !rating ? null
    : isPitcher ? player.pitcher?.[rating] : player.hitter?.[rating]
  // Potential as SPEED multiplier (no ceiling). 70 = 1.0×, 99 = 1.4×, 30 = 0.4×.
  const potMult = potRating != null ? Math.max(0.35, Math.min(1.5, potRating / 70)) : null
  const expectedBump = potMult != null
    ? Math.min(bump * potMult, current != null ? Math.max(0, 99 - current) : bump)
    : null

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
      <div className="flex justify-between items-start mb-3">
        <div>
          <div className="text-sm font-semibold text-pnw-slate"> 1-on-1 Development</div>
          <div className="text-xs text-gray-500 max-w-xl">
            Pull a player aside and grind on one specific rating. Costs {cost} AP. The bump
            scales with the player\'s potential in that rating — high-potential guys grow
            faster, low-potential guys grow slower. Potential is NOT a ceiling; everyone
            can eventually reach 99 if you keep developing them.
          </div>
        </div>
        <button
          onClick={onRun}
          disabled={usedThisWeek || !playerId || !rating || ap < cost}
          className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed shrink-0 ml-3"
        >
          {usedThisWeek ? ' done this week' : `Develop (${cost} AP)`}
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="text-xs uppercase tracking-wider text-gray-500">Player</label>
          <select
            value={playerId}
            onChange={e => { setPlayerId(e.target.value); setRating('') }}
            className="block w-full mt-1 border rounded px-2 py-1.5 text-sm"
          >
            <option value="">— pick a player —</option>
            {sorted.map(p => (
              <option key={p.id} value={p.id}>
                {p.firstName} {p.lastName} · {p.isPitcher ? 'P' : p.primaryPosition} · {p.classYear} · OVR {playerOverall(p)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-gray-500">Rating to develop</label>
          <select
            value={rating}
            onChange={e => setRating(e.target.value)}
            disabled={!player}
            className="block w-full mt-1 border rounded px-2 py-1.5 text-sm"
          >
            <option value="">{player ? '— pick a rating —' : '— pick a player first —'}</option>
            {ratingKeys.map(k => (
              <option key={k} value={k}>{prettyLabel(k)}</option>
            ))}
          </select>
          {player && rating && (
            <div className="text-[11px] text-gray-500 mt-1">
              Current <strong>{current}</strong> · potential <strong>{potRating}</strong>
              {' (' + (potMult >= 1.2 ? 'fast grower' : potMult >= 0.9 ? 'normal' : 'slow grower') + ')'}
              {' · '}
              {current < 99
                ? <span className="text-green-700">+{expectedBump.toFixed(1)} expected this session</span>
                : <span className="text-amber-700">already at 99</span>}
            </div>
          )}
        </div>
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
        {open ? '▾' : '▸'} Held this year: {camp.attendees} attended @ ${camp.fee} ${(camp.revenue / 1000).toFixed(1)}K
      </button>
      {open && (
        <div className="mt-2 max-h-72 overflow-auto">
          {ids.length === 0 ? <div className="text-gray-400">No attendees recorded.</div> :
            <table className="w-full text-[11px] min-w-[500px]">
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
