import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import { simWeek, advanceWeek, advanceOffseasonWeek } from '../../gm/engine/season'
import { simAhead, simPresets, phaseLabel, snapshotState, diffSnapshots } from '../../gm/engine/simAhead'
import { canAdvanceWeek, phaseForWeek, requiredActionForWeek, ensureUnifiedCalendar } from '../../gm/engine/gameYear'
import { seedFromPear } from '../../gm/engine/rankings'
import { teamOverall, playerOverall } from '../../gm/engine/playerRating'
import { teamAcademicSummary } from '../../gm/engine/academics'
import { scholarshipSnapshot } from '../../gm/engine/scholarshipAccounting'
import { openNonConfWeeks, fallScrimmagesRequired } from '../../gm/engine/schedule'
import {
  calendarDateLabel, offseasonPhase, offseasonWeekDate, formatShortDate,
  OFFSEASON_WEEKS,
} from '../../gm/engine/calendar'
import { prettyLabel, displayPosition, displayClassYear } from '../../gm/engine/format'
import TeamLogo from '../../gm/components/TeamLogo'
import nonNaiaRaw from '../../gm/data/non_naia_teams.json'

const NON_NAIA_DISPLAY = (() => {
  const out = {}
  for (const div of nonNaiaRaw.divisions) {
    for (const t of div.teams) out[t.id] = { ...t, division: div.id }
  }
  return out
})()

export default function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => {
    const s = loadDynasty(userId, slot)
    if (s) ensureUnifiedCalendar(s)
    return s
  })
  const [busy, setBusy] = useState(false)
  const [lastWeekRecap, setLastWeekRecap] = useState(null)
  const [simResult, setSimResult] = useState(null)   // multi-week sim diff bundle
  const [progress, setProgress] = useState(null)     // { title, step, pct } for heavy ticks
  const [gameWeekModal, setGameWeekModal] = useState(false)   // shown when entering a week with games

  if (!save) return <Navigate to="/gm" replace />

  const school = save.schools[save.userSchoolId]
  const conf = save.conferences[school.conferenceId]
  const team = save.teams[save.userSchoolId]
  const headCoach = save.coaches[team.headCoachId]
  const assistants = team.assistantCoachIds.map(id => save.coaches[id]).filter(Boolean)

  const mode = save.calendar.mode
  const inOffseason = mode === 'OFFSEASON'
  const dateLabel = calendarDateLabel(save.calendar)

  const players = team.rosterPlayerIds.map(id => save.players[id]).filter(Boolean)
  const teamOvr = teamOverall(team, save.players)
  const acad = teamAcademicSummary(players)
  const scholarship = scholarshipSnapshot(save)
  const totalCoachPayroll = (headCoach?.salary || 0) +
    assistants.reduce((s, c) => s + (c.salary || 0), 0)

  // Top performers (ratings-based stand-ins until in-season stats exist)
  const ratedPlayers = players.map(p => ({ p, ovr: playerOverall(p) })).sort((a, b) => b.ovr - a.ovr)
  const topHitters = ratedPlayers.filter(x => !x.p.isPitcher).slice(0, 5)
  const topPitchers = ratedPlayers.filter(x => x.p.isPitcher).slice(0, 5)

  // Next game (season mode only). Filters:
  //   - !g.played + actual matchup (not BYE / __BYE__ sentinel)
  //   - seasonWeek >= current week (avoids past-due scrimmages from the prior
  //     offseason whose seasonWeek=0 would sort before any in-season game)
  const nextGame = useMemo(() => {
    if (mode !== 'SEASON') return null
    const sw = save.calendar.seasonWeek ?? 1
    return (save.schedule || [])
      .filter(g => !g.played
        && g.type !== 'BYE'
        && g.awayId !== '__BYE__'
        && g.seasonWeek >= sw
        && (g.homeId === save.userSchoolId || g.awayId === save.userSchoolId))
      .sort((a, b) => a.seasonWeek - b.seasonWeek)[0]
  }, [save, mode])

  // Unplayed user games in the CURRENT week — includes both regular-season
  // games (matched by seasonWeek) AND offseason fall scrimmages (matched by
  // weekOfYear). The dashboard surfaces these via the GameWeekBanner.
  const thisWeekUnplayed = useMemo(() => {
    const sw = save.calendar.seasonWeek
    const wk = save.calendar.weekOfYear
    const userId = save.userSchoolId
    return (save.schedule || []).filter(g => {
      if (g.played) return false
      if (g.type === 'BYE' || g.awayId === '__BYE__') return false
      if (g.homeId !== userId && g.awayId !== userId) return false
      const matchSeason = sw != null && g.seasonWeek === sw
      const matchWeek = wk != null && g.weekOfYear === wk
      return matchSeason || matchWeek
    })
  }, [save])

  // Schedule completeness for the UPCOMING season (the one being scheduled in
  // offseason). If the user has open weekend slots, we hard-block sim until
  // they fill them in — otherwise their first season has gaps.
  const seasonYear = save.calendar.year + 1
  const openSlots = useMemo(
    () => openNonConfWeeks(save.userSchoolId, school.conferenceId, save.schedule || [], seasonYear),
    [save, seasonYear, school.conferenceId],
  )
  // Fall scrimmages: required during the offseason. Block sim once Fall Camp
  // opens (offseasonWeek >= 5) if the user hasn't scheduled the minimum.
  const fallScrimNeeded = useMemo(
    () => fallScrimmagesRequired(save.userSchoolId, save.schedule || []),
    [save],
  )
  const fallScrimBlocked = inOffseason && (save.calendar.offseasonWeek ?? 0) >= 5 && fallScrimNeeded > 0
  const scheduleBlocked = (inOffseason && openSlots.length > 0) || fallScrimBlocked

  // ── 52-week phase-gate ────────────────────────────────────────────────
  const weekOfYear = save.calendar.weekOfYear ?? save.calendar.offseasonWeek ?? 1
  const currentPhase = phaseForWeek(weekOfYear)
  const requiredAction = requiredActionForWeek(save, weekOfYear)
  const phaseGate = canAdvanceWeek(save)
  // Hard-block — phase requirement OR legacy schedule check
  const advanceBlocked = !phaseGate.ok || scheduleBlocked

  // ─── Sim actions ───────────────────────────────────────────────────────────
  function simNextWeek() {
    if (advanceBlocked) {
      if (requiredAction && !requiredAction.isComplete(save)) {
        alert(`Finish "${requiredAction.label}" first — ${requiredAction.blurb}`)
        return
      }
      if (scheduleBlocked) {
        alert(`Finish your schedule first — ${openSlots.length} open weekend slot${openSlots.length === 1 ? '' : 's'} remaining. Head to Schedule.`)
        return
      }
    }
    // Soft confirm if AP is unspent in a non-tutorial week. The tutorial
    // weeks (1-3) have ap=0 by design; wk 4 is its own gate; otherwise
    // every leftover AP would have boosted recruiting / development.
    const wk = save.calendar?.weekOfYear ?? 0
    const ap = save.ap?.currentWeek ?? 0
    if (ap > 0 && wk >= 5 && wk !== 4) {
      const ok = window.confirm(
        `You still have ${ap} AP unspent this week. Advance anyway? (Unused AP is lost — it doesn't carry over.)`
      )
      if (!ok) return
    }
    // Any unplayed user games this week (season OR fall scrim) → pop the
    // game-week modal so the user explicitly chooses "Enter Game" (live
    // PA-by-PA) or "Sim Games" (auto).
    if (thisWeekUnplayed.length > 0) {
      setGameWeekModal(true)
      return
    }
    setBusy(true)
    setLastWeekRecap(null)
    if (mode === 'OFFSEASON') {
      const prevWeek = save.calendar.offseasonWeek
      const beforeSnap = snapshotState(save)
      advanceOffseasonWeek(save)
      saveDynasty(save)
      setSave({ ...save })
      const afterSnap = snapshotState(save)
      const diff = diffSnapshots(beforeSnap, afterSnap)
      setLastWeekRecap({
        kind: 'offseason',
        from: prevWeek,
        to: save.calendar.offseasonWeek,
        phase: offseasonPhase(save.calendar.offseasonWeek),
        diff,
      })
    } else if (mode === 'SEASON') {
      const crossingIntoPostseason = (save.calendar.seasonWeek ?? 0) >= 13
      if (crossingIntoPostseason) {
        // Postseason tick is now lighter than before (the EOY heavy work moved
        // to deferred offseason events), but conference tournaments + national
        // tournament still run synchronously. Show a progress modal with the
        // phase label so users see it working, not "frozen."
        setProgress({ title: 'Running postseason', step: 'Conference tournaments…', pct: 10 })
        setTimeout(() => {
          try {
            setProgress(p => ({ ...p, step: 'National tournament…', pct: 40 }))
            const ratings = seedFromPear(save.schools, save.conferences)
            simWeek(save, save.schedule, ratings)
            setProgress(p => ({ ...p, step: 'Wrapping up year…', pct: 80 }))
            advanceWeek(save, save.schedule)
            setProgress(p => ({ ...p, step: 'Saving…', pct: 95 }))
            saveDynasty(save)
            setSave({ ...save })
            setLastWeekRecap({ kind: 'season', results: [] })
          } catch (err) {
            console.error('postseason failed:', err)
            alert('Postseason sim failed — see console. State was not saved.')
          }
          setProgress(null)
          setBusy(false)
        }, 30)
        return
      }
      setTimeout(() => {
        try {
          const beforeSnap = snapshotState(save)
          const ratings = seedFromPear(save.schools, save.conferences)
          const summary = simWeek(save, save.schedule, ratings)
          advanceWeek(save, save.schedule)
          saveDynasty(save)
          setSave({ ...save })
          const afterSnap = snapshotState(save)
          const diff = diffSnapshots(beforeSnap, afterSnap)
          setLastWeekRecap({ kind: 'season', results: summary.userResults, diff })
        } catch (err) {
          console.error('advanceWeek failed:', err)
          alert('Sim failed — see console for details. State was not saved.')
        }
        setBusy(false)
      }, 30)
      return
    }
    setBusy(false)
  }

  function runSimAhead(preset) {
    if (scheduleBlocked) {
      alert(`Finish your schedule first — ${openSlots.length} open weekend slot${openSlots.length === 1 ? '' : 's'} remaining. Head to Schedule.`)
      return
    }
    setBusy(true)
    setLastWeekRecap(null)
    const result = simAhead(save, { weeks: preset.weeks, untilFn: preset.untilFn })
    saveDynasty(save)
    setSave({ ...save })
    setSimResult({ preset: preset.label, ...result })
    setBusy(false)
  }


  // ─── UI ────────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl mx-auto py-6 px-4">
      {progress && <ProgressModal {...progress} />}
      {lastWeekRecap?.diff && (
        <WeekRecapModal
          recap={lastWeekRecap}
          save={save}
          onDismiss={() => setLastWeekRecap(null)}
        />
      )}
      {gameWeekModal && (
        <GameWeekModal
          games={thisWeekUnplayed}
          save={save}
          weekOfYear={weekOfYear}
          onEnter={() => { setGameWeekModal(false); navigate(`/gm/play?slot=${slot}`) }}
          onSim={() => {
            setGameWeekModal(false)
            setBusy(true)
            // Sim THIS week's games but stay on this week so the user can
            // spend remaining AP. They'll advance via the Sim Next Week
            // button when they're done.
            setTimeout(() => {
              try {
                const ratings = seedFromPear(save.schools, save.conferences)
                const summary = simWeek(save, save.schedule, ratings)
                saveDynasty(save)
                setSave({ ...save })
                setLastWeekRecap({ kind: 'season', results: summary.userResults })
              } catch (err) {
                console.error('week sim failed:', err)
                alert('Sim failed — see console.')
              }
              setBusy(false)
            }, 30)
          }}
          onCancel={() => setGameWeekModal(false)}
        />
      )}
      {/* HERO — team identity + dynasty year + AP. Two-row layout: top
          identity row, bottom accent strip with record + phase + dynasty year
          for at-a-glance status. */}
      <div className="bg-gradient-to-br from-pnw-slate via-pnw-slate to-pnw-green text-white rounded-xl mb-4 shadow-lg overflow-hidden">
        <div className="p-5 flex justify-between items-center">
          <div className="flex gap-4 items-center">
            <div className="bg-white/10 rounded-lg p-2 backdrop-blur-sm">
              <TeamLogo school={school} size={72} />
            </div>
            <div>
              <Link to="/gm" className="text-[11px] opacity-70 hover:underline">← Dynasties</Link>
              <div className="text-3xl font-bold leading-tight tracking-tight">{school.name}</div>
              <div className="text-xs opacity-80 mt-0.5">{school.city}, {school.state} · {conf.name}</div>
              <div className="text-[11px] opacity-70 mt-1">
                {headCoach.firstName} {headCoach.lastName} · head coach · Year {save.dynastyYear || 1}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider opacity-80">{dateLabel}</div>
            <div className="text-4xl font-bold mt-1 leading-none">
              {weekOfYear >= 1 && weekOfYear <= 3
                ? <span className="text-xl opacity-70">🔒 AP Locked</span>
                : <>{save.ap.currentWeek}<span className="text-base opacity-70"> AP</span></>}
            </div>
            <div className="text-[11px] opacity-70 mt-1">Wk {weekOfYear} · {currentPhase.label}</div>
          </div>
        </div>
        <div className="bg-black/20 px-5 py-2 flex justify-between items-center text-xs">
          <div className="flex gap-5">
            <div>
              <span className="opacity-70 uppercase tracking-wider">Record</span>{' '}
              <span className="font-mono font-bold">{team.wins}-{team.losses}</span>
            </div>
            <div>
              <span className="opacity-70 uppercase tracking-wider">{conf.abbreviation}</span>{' '}
              <span className="font-mono font-bold">{team.confWins}-{team.confLosses}</span>
            </div>
            <div>
              <span className="opacity-70 uppercase tracking-wider">Run Diff</span>{' '}
              <span className={'font-mono font-bold ' + (team.runDiff > 0 ? 'text-green-300' : team.runDiff < 0 ? 'text-red-300' : '')}>
                {team.runDiff > 0 ? '+' : ''}{team.runDiff}
              </span>
            </div>
          </div>
          <div className="opacity-80">
            {currentPhase.blurb}
          </div>
        </div>
      </div>

      {/* GAME WEEK BANNER — top-of-page when there are unplayed games */}
      {thisWeekUnplayed.length > 0 && (
        <GameWeekBanner
          games={thisWeekUnplayed}
          save={save}
          weekOfYear={weekOfYear}
          slot={slot}
          onSimNow={() => {
            // Sim the games but DON'T auto-advance the week — let the user
            // spend remaining AP first. If they have nothing to spend AP on
            // they can still click Sim Next Week from the main bar.
            setBusy(true)
            setTimeout(() => {
              try {
                const ratings = seedFromPear(save.schools, save.conferences)
                const summary = simWeek(save, save.schedule, ratings)
                saveDynasty(save)
                setSave({ ...save })
                setLastWeekRecap({ kind: 'season', results: summary.userResults })
              } catch (err) {
                console.error('week sim failed:', err)
                alert('Sim failed — see console.')
              }
              setBusy(false)
            }, 30)
          }}
        />
      )}

      {/* Camp invite window (Wks 5 & 10) — prominent reminder + count */}
      {(weekOfYear === 5 || weekOfYear === 10) && (
        <CampInviteBanner save={save} slot={slot} weekOfYear={weekOfYear} />
      )}

      {/* Phase-gate banner — required action this week */}
      {requiredAction && !requiredAction.isComplete(save) && (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4 mb-4 flex justify-between items-start">
          <div className="flex-1">
            <div className="text-[11px] uppercase tracking-wider text-amber-700 font-bold mb-1">
              Week {weekOfYear} — {currentPhase.label}
            </div>
            <div className="text-sm font-semibold text-amber-900">
              ⚠ Required: {requiredAction.label}
            </div>
            <div className="text-xs text-amber-800 mt-1 leading-snug">{requiredAction.blurb}</div>
          </div>
          <Link to={`${requiredAction.route}?slot=${slot}`} className="px-4 py-2 bg-amber-600 text-white rounded text-sm font-semibold hover:opacity-90 shrink-0 ml-3">
            Take care of it →
          </Link>
        </div>
      )}
      {requiredAction && requiredAction.isComplete(save) && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-2 mb-4 text-xs text-green-800 flex justify-between items-center">
          <span><strong>Week {weekOfYear}:</strong> {requiredAction.doneText || requiredAction.label} — ready to advance.</span>
        </div>
      )}

      {/* Legacy schedule-incomplete banner (separate concern from phase-gate) */}
      {scheduleBlocked && !requiredAction && (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-3 mb-4 flex justify-between items-center">
          <div className="text-sm text-amber-900">
            <strong>Schedule incomplete.</strong>{' '}
            {openSlots.length > 0 && (
              <>You have <strong>{openSlots.length}</strong> open weekend slot{openSlots.length === 1 ? '' : 's'} on the {seasonYear} schedule. </>
            )}
            {fallScrimBlocked && (
              <>You need to schedule <strong>{fallScrimNeeded}</strong> more fall scrimmage game{fallScrimNeeded === 1 ? '' : 's'}. </>
            )}
            Fix it before you can sim.
          </div>
          <Link to={`/gm/schedule?slot=${slot}`} className="px-3 py-1.5 bg-amber-600 text-white rounded text-xs font-semibold hover:opacity-90">
            Go to Schedule →
          </Link>
        </div>
      )}

      {/* Sim action bar — keep `busy` as the literal busy spinner state.
          Block separately so the button shows "Locked" instead of "Simming…"
          when the phase-gate is unsatisfied. */}
      <SimActionBar
        mode={mode}
        inOffseason={inOffseason}
        nextGame={nextGame}
        userSchoolId={save.userSchoolId}
        save={save}
        busy={busy}
        blocked={advanceBlocked}
        onSim={simNextWeek}
        recap={lastWeekRecap}
        offseasonWeek={save.calendar.offseasonWeek}
        startYear={save.calendar.startYear || save.calendar.year}
        thisWeekUnplayedCount={thisWeekUnplayed.length}
      />

      {/* Sim-ahead presets (also hard-blocked when phase-gate or schedule incomplete) */}
      {!advanceBlocked && <SimAheadBar save={save} busy={busy} onRun={runSimAhead} />}

      {/* Weekly diff readout — appears after a multi-week sim */}
      {simResult && <SimDiffPanel simResult={simResult} onDismiss={() => setSimResult(null)} />}

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-4">
        <KpiCard label="Team OVR" value={teamOvr.overall} accent />
        <KpiCard label="Record" value={`${team.wins}-${team.losses}`} />
        <KpiCard label="Conference" value={`${team.confWins}-${team.confLosses}`} sub={conf.abbreviation} />
        <KpiCard label="Run Diff" value={(team.runDiff > 0 ? '+' : '') + team.runDiff} />
        <KpiCard
          label="Team GPA"
          value={acad.teamGpa.toFixed(2)}
          trend={gpaTrend(save)}
        />
        <KpiCard label="Job Security" value={save.budget?.jobSecurity ?? 50} suffix="/100" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* LEFT column — staff + budget */}
        <div className="space-y-4">
          <Panel title="Coaching Staff" actionTo={`/gm/coaches?slot=${slot}`} actionLabel="Manage →">
            <div className="text-xs text-gray-500 mb-1">Head Coach</div>
            <div className="flex justify-between items-baseline mb-1">
              <div className="font-semibold">{headCoach.firstName} {headCoach.lastName}</div>
              <div className="text-sm font-mono text-gray-700">${(headCoach.salary / 1000).toFixed(0)}K</div>
            </div>
            <div className="flex gap-3 mb-2">
              <Rating label="DEV" v={headCoach.developer} />
              <Rating label="MOT" v={headCoach.motivator} />
              <Rating label="REC" v={headCoach.recruiter} />
              <Rating label="TAC" v={headCoach.tactician} />
            </div>
            <div className="text-[11px] text-gray-500 mb-3">{prettyLabel(headCoach.recruiter_type)} • {(headCoach.pipelines || []).slice(0, 3).map(prettyLabel).join(', ') || 'no pipelines'}</div>

            <div className="text-xs text-gray-500 mt-3 mb-1">Assistants ({assistants.length})</div>
            <div className="space-y-1">
              {assistants.map(c => (
                <div key={c.id} className="flex justify-between text-xs">
                  <span className="text-gray-700">{c.firstName} {c.lastName} <span className="text-gray-400">{prettyLabel(c.role)}</span></span>
                  <span className="font-mono text-gray-600">${(c.salary / 1000).toFixed(0)}K</span>
                </div>
              ))}
            </div>
            <div className="border-t mt-2 pt-2 flex justify-between text-xs">
              <span className="text-gray-600">Total payroll</span>
              <span className="font-mono font-bold">${(totalCoachPayroll / 1000).toFixed(1)}K</span>
            </div>
          </Panel>

          <Panel title="Scholarships (Next Year)" actionTo={`/gm/budget?slot=${slot}`} actionLabel="Budget →">
            <ScholarshipBar snapshot={scholarship} />
            <div className="text-xs mt-3 grid grid-cols-2 gap-x-2 gap-y-1">
              <div className="text-gray-500">Total pool</div>
              <div className="text-right font-mono">${(scholarship.pool / 1000).toFixed(1)}K</div>
              <div className="text-gray-500">Returning roster</div>
              <div className="text-right font-mono">${(scholarship.returningCommitted / 1000).toFixed(1)}K</div>
              <div className="text-gray-500">Graduating seniors ({scholarship.graduatingSeniors})</div>
              <div className="text-right font-mono text-pnw-green">−${(scholarship.graduatingDollars / 1000).toFixed(1)}K freed</div>
              {scholarship.signedRecruits > 0 && (<>
                <div className="text-gray-500">Signed recruits</div>
                <div className="text-right font-mono">${(scholarship.signedRecruits / 1000).toFixed(1)}K</div>
              </>)}
              {scholarship.pendingOffers > 0 && (<>
                <div className="text-gray-500">Pending offers</div>
                <div className="text-right font-mono text-amber-700">${(scholarship.pendingOffers / 1000).toFixed(1)}K</div>
              </>)}
              <div className="text-gray-500 font-semibold border-t pt-1">Available next yr</div>
              <div className="text-right font-mono font-bold border-t pt-1 text-pnw-green">${(scholarship.nextYearAvailable / 1000).toFixed(1)}K</div>
            </div>
            <div className="text-[11px] text-gray-400 mt-2 leading-snug">
              New $ comes from departing seniors. Money you offer recruits now is what's available for the FOLLOWING season.
            </div>
          </Panel>
        </div>

        {/* CENTER column — sim recap, top performers, news */}
        <div className="space-y-4">
          <Panel title="Top Players" actionTo={`/gm/roster?slot=${slot}`} actionLabel="Full roster →">
            <div className="text-xs text-gray-500 mb-1">Top 5 hitters</div>
            <table className="w-full text-xs mb-3">
              <tbody>
                {topHitters.map(({ p, ovr }) => (
                  <PlayerRow key={p.id} p={p} ovr={ovr} slot={slot} />
                ))}
              </tbody>
            </table>
            <div className="text-xs text-gray-500 mb-1">Top 5 pitchers</div>
            <table className="w-full text-xs">
              <tbody>
                {topPitchers.map(({ p, ovr }) => (
                  <PlayerRow key={p.id} p={p} ovr={ovr} slot={slot} />
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="News" actionTo={null}>
            <div className="space-y-2">
              {(save.newsfeed || []).slice(0, 8).map(n => (
                <NewsRow key={n.id} item={n} />
              ))}
              {(save.newsfeed || []).length === 0 && (
                <div className="text-xs text-gray-400 italic">No news yet. Take an action or sim a week.</div>
              )}
            </div>
          </Panel>
        </div>

        {/* RIGHT column — focus tasks, study hall, navigation */}
        <div className="space-y-4">
          <Panel title="This Week's Focus" actionTo={null}>
            <FocusTasks save={save} inOffseason={inOffseason} />
          </Panel>

          <Panel title="Navigate" actionTo={null}>
            <div className="grid grid-cols-2 gap-2">
              <NavTile to={`/gm/roster?slot=${slot}`} title="Roster" sub={`${team.rosterPlayerIds.length} players`} />
              <NavTile to={`/gm/depth?slot=${slot}`} title="Depth Chart" sub="Field + pitching staff" />
              <NavTile to={`/gm/schedule?slot=${slot}`} title="Schedule" sub="Games + sim" />
              <NavTile to={`/gm/play?slot=${slot}`} title="Play Games" sub="Set lineups + live sim" />
              <NavTile to={`/gm/calendar?slot=${slot}`} title="Calendar" sub="Year at a glance" />
              <NavTile to={`/gm/standings?slot=${slot}`} title="Standings" sub={conf.abbreviation} />
              <NavTile to={`/gm/rankings?slot=${slot}`} title="Rankings" sub="Top 50" />
              <NavTile to={`/gm/budget?slot=${slot}`} title="Budget" sub={`$${(save.budget?.totalAthleticBudget / 1000).toFixed(0)}K`} />
              <NavTile to={`/gm/recruiting?slot=${slot}`} title="Recruiting" sub={save.recruits && Object.keys(save.recruits).length > 0 ? `${Object.keys(save.recruits).length} on board` : 'Open board'} />
              <NavTile to={`/gm/weekly?slot=${slot}`} title="Weekly Actions" sub="Study hall, fundraise, camp" />
              <NavTile to={`/gm/coaches?slot=${slot}`} title="Staff" sub={`${1 + assistants.length} coaches`} />
              {save.postseason && (
                <NavTile to={`/gm/postseason?slot=${slot}`} title="Postseason" sub={postseasonSub(save.postseason)} />
              )}
            </div>
          </Panel>

          <Panel title="Program Profile" actionTo={null}>
            <div className="text-xs grid grid-cols-2 gap-y-1.5">
              <div className="text-gray-500">Resource Tier</div>
              <div className="text-right">{prettyLabel(school.resourceTier)}</div>
              <div className="text-gray-500">Program History</div>
              <div className="text-right">{school.programHistory}/100</div>
              <div className="text-gray-500">Facilities</div>
              <div className="text-right">{school.facilityRating}/100</div>
              <div className="text-gray-500">Academics</div>
              <div className="text-right">{school.academicReputation}/100</div>
              <div className="text-gray-500">Tuition + R&B</div>
              <div className="text-right font-mono">${((school.tuitionPerYear + school.roomAndBoardPerYear) / 1000).toFixed(0)}K/yr</div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────────

function SimActionBar({ mode, inOffseason, nextGame, userSchoolId, save, busy, blocked = false, onSim, recap, offseasonWeek, startYear, thisWeekUnplayedCount = 0 }) {
  const date = inOffseason
    ? offseasonWeekDate(startYear, offseasonWeek)
    : null

  let primary
  if (inOffseason) {
    primary = (
      <div>
        <div className="text-xs uppercase tracking-wider opacity-80">Offseason Week {offseasonWeek} of {OFFSEASON_WEEKS}</div>
        <div className="text-lg font-semibold mt-0.5">{offseasonPhase(offseasonWeek)} — {formatShortDate(date)}, {date.getFullYear()}</div>
        <div className="text-[11px] opacity-70 mt-0.5">Recruit, develop, fundraise, set rotation. Sim when you're done.</div>
      </div>
    )
  } else if (nextGame) {
    const opp = nextGame.homeId === userSchoolId ? nextGame.awayId : nextGame.homeId
    const oppName = (save.schools[opp] || NON_NAIA_DISPLAY[opp])?.name || 'TBD'
    primary = (
      <div>
        <div className="text-xs uppercase tracking-wider opacity-80">Next Game — Season Wk {nextGame.seasonWeek}</div>
        <div className="text-lg font-semibold mt-0.5">
          {nextGame.homeId === userSchoolId ? 'vs' : '@'} {oppName}
        </div>
        <div className="text-[11px] opacity-70">{nextGame.type === 'CONFERENCE' ? 'Conference' : 'Non-conference'} • {nextGame.date}</div>
      </div>
    )
  } else {
    primary = <div className="text-sm opacity-80">No upcoming game on the schedule.</div>
  }

  return (
    <div className="bg-pnw-slate text-white rounded-xl p-4 mb-4 flex items-center justify-between shadow">
      {primary}
      <div className="flex flex-col items-end gap-2">
        <button
          onClick={onSim}
          disabled={busy || blocked}
          className="px-6 py-3 bg-pnw-green rounded font-semibold text-sm hover:opacity-90 disabled:opacity-50"
        >
          {busy
            ? 'Simming…'
            : blocked
              ? '🔒 Complete required action'
              : inOffseason
                ? 'Advance Week →'
                : thisWeekUnplayedCount > 0
                  ? `▶ Play this week (${thisWeekUnplayedCount} game${thisWeekUnplayedCount === 1 ? '' : 's'})`
                  : 'Sim Next Week →'}
        </button>
        {recap?.kind === 'offseason' && (
          <div className="text-[11px] opacity-70">Advanced to Wk {recap.to} — {recap.phase}</div>
        )}
        {recap?.kind === 'season' && recap.results && recap.results.length > 0 && (
          <div className="text-[11px] opacity-90 text-right">
            {recap.results.map(r => (
              <div key={r.gameId}>{r.result} {r.score} {r.homeAway === 'home' ? 'vs' : '@'} {r.opponent}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FocusTasks({ save, inOffseason }) {
  const seasonYear = save.calendar.year + 1
  const userSchool = save.schools[save.userSchoolId]
  const openSchedSlots = openNonConfWeeks(save.userSchoolId, userSchool.conferenceId, save.schedule || [], seasonYear)

  // Build a list of priority tasks, ranked by importance
  const priorities = []

  if (openSchedSlots.length > 0) {
    priorities.push({
      text: `⚠ ${openSchedSlots.length} open weekend slot${openSchedSlots.length === 1 ? '' : 's'} on next season's schedule`,
      to: `/gm/schedule?slot=${save.saveSlot}`,
      urgent: true,
    })
  }

  if (inOffseason) {
    if (save.calendar.offseasonWeek <= 4) {
      priorities.push({ text: 'Sign top HS recruits before fall', to: `/gm/recruiting?slot=${save.saveSlot}` })
    }
    if (save.calendar.offseasonWeek >= 5 && save.calendar.offseasonWeek <= 13 && !save.prospectCamp?.year) {
      priorities.push({ text: 'Hold your prospect camp (Aug-Nov window)', to: `/gm/weekly?slot=${save.saveSlot}` })
    }
    if (!save.budget || save.budget.allocations?.scholarships === undefined) {
      priorities.push({ text: 'Review your annual budget', to: `/gm/budget?slot=${save.saveSlot}` })
    }
  } else {
    priorities.push({ text: 'Late-cycle recruiting open', to: `/gm/recruiting?slot=${save.saveSlot}` })
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-gray-600 space-y-1.5">
        <div className="font-semibold text-gray-700">Weekly priorities:</div>
        {priorities.length === 0 ? (
          <div className="text-gray-400">Nothing pressing — explore the dashboard.</div>
        ) : (
          priorities.map((p, i) => (
            <div key={i} className="flex justify-between items-center">
              <span className={p.urgent ? 'text-amber-700 font-semibold' : ''}>{p.text}</span>
              <Link to={p.to} className="text-pnw-green hover:underline shrink-0 ml-2">Go →</Link>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function PlayerRow({ p, ovr, slot }) {
  return (
    <tr className="border-b last:border-0 hover:bg-gray-50">
      <td className="py-1">
        <Link to={`/gm/player/${p.id}?slot=${slot}`} className="text-pnw-slate hover:text-pnw-green hover:underline">
          {p.firstName} {p.lastName}
        </Link>
      </td>
      <td className="py-1 text-gray-500 w-12">{displayPosition(p.primaryPosition)}</td>
      <td className="py-1 text-gray-500 w-10">{displayClassYear(p)}</td>
      <td className="py-1 text-right font-mono font-bold w-10">{ovr}</td>
    </tr>
  )
}

function ScholarshipBar({ snapshot }) {
  const pct = Math.min(1, snapshot.percentUsed)
  const committedPct = snapshot.pool > 0 ? snapshot.committedPlayers / snapshot.pool : 0
  const offerPct = snapshot.pool > 0 ? snapshot.pendingOffers / snapshot.pool : 0
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-600">${(snapshot.committed / 1000).toFixed(0)}K of ${(snapshot.pool / 1000).toFixed(0)}K committed</span>
        <span className="text-pnw-green font-semibold">${(snapshot.available / 1000).toFixed(0)}K avail</span>
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden flex">
        <div className="bg-pnw-slate h-full" style={{ width: `${committedPct * 100}%` }} />
        <div className="bg-amber-500 h-full" style={{ width: `${offerPct * 100}%` }} />
      </div>
    </div>
  )
}

function KpiCard({ label, value, suffix = '', sub, accent, trend }) {
  return (
    <div className={'rounded-xl border p-3 transition shadow-sm ' +
      (accent
        ? 'bg-gradient-to-br from-pnw-green to-pnw-slate text-white border-pnw-green'
        : 'bg-white border-gray-200 hover:border-gray-300')}>
      <div className={'text-[10px] uppercase tracking-wider font-semibold ' + (accent ? 'opacity-80' : 'text-gray-500')}>
        {label}
      </div>
      <div className={'text-2xl font-bold mt-1 flex items-baseline gap-1 leading-none ' + (accent ? '' : 'text-pnw-slate')}>
        <span>{value}</span>
        <span className={'text-xs ' + (accent ? 'opacity-80' : 'text-gray-500')}>{suffix}</span>
        {trend === 'up' && <span className={'text-xs font-bold leading-none ' + (accent ? 'text-green-300' : 'text-green-600')} title="trending up">↑</span>}
        {trend === 'down' && <span className={'text-xs font-bold leading-none ' + (accent ? 'text-red-300' : 'text-red-600')} title="trending down">↓</span>}
      </div>
      {sub && (
        <div className={'text-[10px] mt-0.5 ' + (accent ? 'opacity-80' : 'text-gray-400')}>{sub}</div>
      )}
    </div>
  )
}

// Compare current vs last week's team GPA snapshots. Threshold ±0.01 to
// avoid showing arrows for noise.
function gpaTrend(save) {
  const last = save._lastTeamGpa
  const curr = save._currentTeamGpa
  if (last == null || curr == null) return null
  const delta = curr - last
  if (delta > 0.01) return 'up'
  if (delta < -0.01) return 'down'
  return 'flat'
}

function Rating({ label, v }) {
  return (
    <div className="text-center">
      <div className="text-base font-bold text-pnw-green leading-none">{v}</div>
      <div className="text-[9px] uppercase tracking-wider text-gray-400">{label}</div>
    </div>
  )
}

function Panel({ title, actionTo, actionLabel, children }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
      <div className="flex justify-between items-baseline mb-2">
        <h2 className="text-sm font-semibold text-pnw-slate uppercase tracking-wider">{title}</h2>
        {actionTo && <Link to={actionTo} className="text-xs text-pnw-green hover:underline">{actionLabel || 'View →'}</Link>}
      </div>
      {children}
    </div>
  )
}

function NavTile({ to, title, sub }) {
  return (
    <Link
      to={to}
      className="group block bg-gray-50 hover:bg-pnw-green hover:text-white border border-gray-200 hover:border-pnw-green rounded-lg p-3 transition shadow-sm hover:shadow"
    >
      <div className="font-semibold text-sm flex justify-between items-center">
        <span>{title}</span>
        <span className="text-gray-300 group-hover:text-white opacity-70 group-hover:translate-x-0.5 transition">→</span>
      </div>
      <div className="text-[11px] opacity-70 mt-0.5">{sub}</div>
    </Link>
  )
}

function GameWeekBanner({ games, save, weekOfYear, slot, onSimNow }) {
  const userSchoolId = save.userSchoolId
  // Summarize: count + first opponent name
  const first = games[0]
  const oppId = first.homeId === userSchoolId ? first.awayId : first.homeId
  const oppName = save.schools[oppId]?.name || 'Opponent'
  const isHome = first.homeId === userSchoolId
  return (
    <div className="bg-pnw-green text-white rounded-xl p-4 mb-4 flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-3 shadow-lg">
      <div className="flex-1">
        <div className="text-[11px] uppercase tracking-wider opacity-90 font-bold">
          ⚾ Week {weekOfYear} — {games.length} Game{games.length === 1 ? '' : 's'} This Week
        </div>
        <div className="text-base font-semibold mt-0.5">
          {isHome ? 'vs' : '@'} {oppName}
          {games.length > 1 && <span className="text-sm opacity-80"> · {games.length}-game series</span>}
        </div>
        <div className="text-[11px] opacity-80 mt-0.5">
          Enter live to call subs and watch PA-by-PA, or sim the whole slate in one click.
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
        <Link
          to={`/gm/play?slot=${slot}`}
          className="px-4 py-2.5 bg-white text-pnw-green rounded font-semibold text-sm hover:opacity-90 whitespace-nowrap"
        >
          ▶ Enter Game
        </Link>
        <button
          onClick={onSimNow}
          className="px-4 py-2.5 bg-pnw-slate text-white rounded font-semibold text-sm hover:opacity-90 whitespace-nowrap"
        >
          ⏩ Sim Game{games.length === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  )
}

function CampInviteBanner({ save, slot, weekOfYear }) {
  const invited = Object.values(save.recruits || {}).filter(r => r.campInvited).length
  const MAX = 100
  const isSecondWindow = weekOfYear === 10
  return (
    <div className="bg-blue-50 border-2 border-blue-300 rounded-xl p-4 mb-4 flex justify-between items-start">
      <div className="flex-1">
        <div className="text-[11px] uppercase tracking-wider text-blue-700 font-bold mb-1">
          Week {weekOfYear} — {isSecondWindow ? 'Final' : 'First'} Camp Invite Window
        </div>
        <div className="text-sm text-blue-900 leading-snug">
          You can invite up to <strong>{MAX} HS recruits</strong> to your prospect camp (held Wk 13).
          Currently invited: <strong>{invited}/{MAX}</strong>. Invitees get a small interest boost
          immediately; attendees end up ~50% scouted.
          {isSecondWindow && <span className="block mt-1 text-amber-800 font-semibold">⚠ Last chance to invite or remove before camp.</span>}
        </div>
      </div>
      <Link to={`/gm/recruiting?slot=${slot}&board=INVITES`} className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-semibold hover:opacity-90 shrink-0 ml-3">
        Manage invites →
      </Link>
    </div>
  )
}

function GameWeekModal({ games, save, weekOfYear, onEnter, onSim, onCancel }) {
  const userSchoolId = save.userSchoolId
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-xl p-6 shadow-2xl w-full max-w-lg">
        <div className="flex justify-between items-start mb-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-pnw-green font-bold">
              Week {weekOfYear} — Game Week
            </div>
            <h3 className="text-xl font-bold text-pnw-slate mt-0.5">
              {games.length} game{games.length === 1 ? '' : 's'} this week
            </h3>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-700 text-xl leading-none">✕</button>
        </div>
        <div className="space-y-1 mb-4 max-h-40 overflow-y-auto text-sm">
          {games.map(g => {
            const isHome = g.homeId === userSchoolId
            const oppId = isHome ? g.awayId : g.homeId
            const opp = save.schools[oppId] || { name: oppId }
            return (
              <div key={g.id} className="flex justify-between text-xs text-gray-700 py-0.5">
                <span>{isHome ? 'vs' : '@'} {opp.name}</span>
                <span className="text-gray-400">{g.date}</span>
              </div>
            )
          })}
        </div>
        <p className="text-xs text-gray-500 mb-4 leading-snug">
          Choose how you want to handle this week's slate. Live games run plate appearance
          by plate appearance with sub options; sim auto-runs them in one shot and surfaces
          the results.
        </p>
        <div className="flex flex-col gap-2">
          <button onClick={onEnter} className="px-4 py-3 bg-pnw-green text-white rounded text-sm font-semibold hover:opacity-90">
            ▶ Enter Game (live, PA-by-PA)
          </button>
          <button onClick={onSim} className="px-4 py-3 bg-pnw-slate text-white rounded text-sm font-semibold hover:opacity-90">
            ⏩ Sim Game{games.length === 1 ? '' : 's'} (auto)
          </button>
          <button onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-700 mt-1">
            Wait, not yet
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Week Recap — appears after every single-week tick to show what changed.
 * Pulls from the snapshot diff (player OVR / happiness / GPA + record +
 * budget) plus the week's userResults if it was an in-season week.
 */
function WeekRecapModal({ recap, save, onDismiss }) {
  if (!recap) return null
  const diff = recap.diff
  const results = recap.results || []
  const ovrTop = (diff?.ovrChanges || []).slice(0, 6)
  const happyTop = (diff?.happinessChanges || []).slice(0, 5)
  const gpaTop = (diff?.gpaChanges || []).slice(0, 4)
  const recordDelta = diff?.recordDelta
  const isOffseason = recap.kind === 'offseason'
  const headerLabel = isOffseason
    ? `Offseason Wk ${recap.from} → ${recap.to} — ${recap.phase}`
    : `Game Week Recap`

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="bg-gradient-to-r from-pnw-slate to-pnw-green text-white p-4 rounded-t-xl flex justify-between items-start">
          <div>
            <div className="text-[11px] uppercase tracking-wider opacity-80">Week Recap</div>
            <h3 className="text-2xl font-bold mt-0.5">{headerLabel}</h3>
          </div>
          <button onClick={onDismiss} className="text-white/80 hover:text-white text-xl leading-none">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Game results */}
          {results.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-2">Game Results</div>
              <div className="space-y-1">
                {results.map(r => (
                  <div key={r.gameId} className={'flex justify-between items-center p-2 rounded ' +
                    (r.result === 'W' ? 'bg-green-50' : 'bg-red-50')}>
                    <div className="flex items-center gap-2 text-sm">
                      <span className={'inline-block w-6 h-6 flex items-center justify-center rounded font-bold text-white ' +
                        (r.result === 'W' ? 'bg-green-600' : 'bg-red-600')}>
                        {r.result}
                      </span>
                      <span className="text-gray-700">{r.homeAway === 'home' ? 'vs' : '@'} {r.opponent}</span>
                    </div>
                    <span className="font-mono text-sm font-bold">{r.score}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Record + run diff strip */}
          {recordDelta && (recordDelta.w > 0 || recordDelta.l > 0) && (
            <div className="grid grid-cols-3 gap-2">
              <RecapStat label="This Week" value={`${recordDelta.w}-${recordDelta.l}`} accent={recordDelta.w > recordDelta.l ? 'good' : 'bad'} />
              <RecapStat label="Run Diff" value={`${diff.runDiffDelta > 0 ? '+' : ''}${diff.runDiffDelta}`} accent={diff.runDiffDelta > 0 ? 'good' : diff.runDiffDelta < 0 ? 'bad' : null} />
              <RecapStat label="Job Sec" value={`${diff.jobSecurityDelta > 0 ? '+' : ''}${diff.jobSecurityDelta || 0}`} accent={diff.jobSecurityDelta > 0 ? 'good' : diff.jobSecurityDelta < 0 ? 'bad' : null} />
            </div>
          )}

          {/* Rating changes */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-2">
              Player Ratings {ovrTop.length === 0 && <span className="text-gray-400 normal-case ml-1">— no changes</span>}
            </div>
            {ovrTop.length > 0 && (
              <div className="space-y-1">
                {ovrTop.map(c => (
                  <div key={c.id} className="flex justify-between items-center p-2 bg-gray-50 rounded text-xs">
                    <span className="text-gray-700">{c.name} <span className="text-gray-400">({c.pos})</span></span>
                    <span className={'font-mono ' + (c.delta > 0 ? 'text-green-700 font-semibold' : 'text-red-700 font-semibold')}>
                      OVR {c.before} → {c.after} {c.delta > 0 ? '↑' : '↓'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Happiness shifts */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-2">
              Happiness Shifts {happyTop.length === 0 && <span className="text-gray-400 normal-case ml-1">— stable</span>}
            </div>
            {happyTop.length > 0 && (
              <div className="space-y-1">
                {happyTop.map(c => (
                  <div key={c.id} className="flex justify-between items-center p-2 bg-gray-50 rounded text-xs">
                    <span className="text-gray-700">{c.name} <span className="text-gray-400">({c.pos})</span></span>
                    <span className={'font-mono ' + (c.delta > 0 ? 'text-green-700 font-semibold' : 'text-red-700 font-semibold')}>
                      {c.before} → {c.after} {c.delta > 0 ? '↑' : '↓'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* GPA changes */}
          {gpaTop.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-2">GPA Changes</div>
              <div className="space-y-1">
                {gpaTop.map(c => (
                  <div key={c.id} className="flex justify-between items-center p-2 bg-gray-50 rounded text-xs">
                    <span className="text-gray-700">{c.name}</span>
                    <span className={'font-mono ' + (c.delta > 0 ? 'text-green-700 font-semibold' : 'text-red-700 font-semibold')}>
                      {c.before.toFixed(2)} → {c.after.toFixed(2)} {c.delta > 0 ? '↑' : '↓'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {ovrTop.length === 0 && happyTop.length === 0 && gpaTop.length === 0 && results.length === 0 && (
            <div className="text-center text-sm text-gray-400 py-6">
              Quiet week. Nothing meaningful changed.
            </div>
          )}
        </div>

        <div className="p-4 border-t bg-gray-50 rounded-b-xl flex justify-end">
          <button onClick={onDismiss} className="px-5 py-2 bg-pnw-green text-white rounded text-sm font-semibold hover:opacity-90">
            Got it →
          </button>
        </div>
      </div>
    </div>
  )
}

function NewsRow({ item }) {
  // Type → accent + icon mapping. The headline emoji is usually enough but
  // a left-bar accent ties the news visually to the kind of event.
  const accent = item.big ? 'border-pnw-green bg-pnw-cream/60'
    : item.type === 'TRANSFER_OUT' ? 'border-red-300 bg-red-50/40'
    : item.type === 'COACH_HIRED' ? 'border-blue-300 bg-blue-50/40'
    : item.type === 'AWARD' ? 'border-pnw-green/30 bg-pnw-cream/30'
    : 'border-gray-200 bg-white'
  return (
    <div className={'border-l-2 rounded-r pl-2 py-1 pr-2 text-xs ' + accent}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[10px] text-gray-400 uppercase font-mono shrink-0">Wk {item.week}</span>
        <span className="text-gray-700 leading-snug">{item.headline}</span>
      </div>
    </div>
  )
}

function RecapStat({ label, value, accent }) {
  const color = accent === 'good' ? 'text-green-700'
    : accent === 'bad' ? 'text-red-700'
    : 'text-pnw-slate'
  return (
    <div className="bg-gray-50 rounded p-2 text-center">
      <div className={'text-2xl font-bold ' + color}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
    </div>
  )
}

function ProgressModal({ title, step, pct }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div className="bg-white rounded-xl p-6 shadow-2xl w-full max-w-md">
        <h3 className="text-lg font-semibold text-pnw-slate mb-1">{title}</h3>
        <p className="text-sm text-gray-600 mb-4">{step}</p>
        <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
          <div
            className="bg-pnw-green h-3 transition-all duration-200"
            style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}
          />
        </div>
        <div className="text-[11px] text-gray-400 mt-2 text-right font-mono">{Math.round(pct ?? 0)}%</div>
      </div>
    </div>
  )
}

function postseasonSub(ps) {
  if (ps.userWSChamp) return '🏆 National Champ'
  if (ps.userInWS) return 'World Series'
  if (ps.userInField) return 'Opening Round'
  if (ps.userChamp) return '🏆 Conf Champ'
  return 'Missed'
}

// ────────────────────────────────────────────────────────────────────────────
// Sim-ahead UI
// ────────────────────────────────────────────────────────────────────────────

function SimAheadBar({ save, busy, onRun }) {
  const presets = simPresets(save)
  if (presets.length <= 1) return null
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-3 mb-4 shadow-sm flex flex-wrap items-center gap-2">
      <div className="text-xs uppercase tracking-wider text-gray-500 mr-2">Sim ahead:</div>
      {presets.map(p => (
        <button
          key={p.key}
          onClick={() => onRun(p)}
          disabled={busy}
          className="px-3 py-1.5 bg-pnw-cream text-pnw-slate hover:bg-pnw-green hover:text-white border border-pnw-green/30 rounded text-xs font-semibold disabled:opacity-40"
          title={p.est ? `~${p.est} weeks` : ''}
        >
          {p.label}{p.est ? ` (${p.est}w)` : ''}
        </button>
      ))}
      <div className="text-[11px] text-gray-500 ml-auto">Per-week diffs will appear below.</div>
    </div>
  )
}

function SimDiffPanel({ simResult, onDismiss }) {
  const { preset, weeksAdvanced, weeklyDiffs, aggregateDiff, stoppedReason } = simResult
  return (
    <div className="bg-white rounded-xl border border-pnw-green/40 p-4 mb-4 shadow-sm">
      <div className="flex justify-between items-baseline mb-3">
        <h2 className="text-sm font-semibold text-pnw-slate uppercase tracking-wider">
          📊 Sim Recap — {preset} ({weeksAdvanced} week{weeksAdvanced === 1 ? '' : 's'})
        </h2>
        <button onClick={onDismiss} className="text-xs text-gray-500 hover:text-pnw-green">Dismiss ✕</button>
      </div>

      {stoppedReason === 'postseason_boundary' && (
        <div className="mb-3 bg-amber-50 border border-amber-200 rounded p-2 text-xs text-amber-900">
          Stopped before the postseason transition. Week 13 (the last regular-season week)
          hasn't been played yet — click <strong>Advance Week →</strong> once more to play it and
          fire the postseason bracket + end-of-year wrap.
        </div>
      )}
      {stoppedReason === 'prospect_camp_boundary' && (
        <div className="mb-3 bg-red-50 border border-red-300 rounded p-2 text-xs text-red-900">
          <strong>⛔ Stopped before Prospect Camp (Wk 13).</strong> You can't skip this — head to
          Weekly Actions and run camp before advancing.
        </div>
      )}
      {stoppedReason === 'user_games_pending' && (
        <div className="mb-3 bg-pnw-cream border border-pnw-green/40 rounded p-2 text-xs text-pnw-slate">
          ⚾ <strong>Stopped on a game week.</strong> You have games this week — Enter Game live
          or Sim Game(s) from the top of the dashboard.
        </div>
      )}

      <DiffAggregate diff={aggregateDiff} />

      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-semibold text-pnw-slate hover:text-pnw-green">
          ▾ Week-by-week breakdown
        </summary>
        <div className="mt-2 space-y-3">
          {weeklyDiffs.map((d, i) => (
            <DiffWeek key={i} diff={d} index={i + 1} />
          ))}
        </div>
      </details>
    </div>
  )
}

function DiffAggregate({ diff }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
      <DiffStat
        label="Record"
        before={`${diff.recordDelta.w + diff.recordDelta.l === 0 ? 'no games' : `${diff.recordDelta.w}-${diff.recordDelta.l}`}`}
        delta={diff.recordDelta.w - diff.recordDelta.l}
        showSign
      />
      <DiffStat
        label="Budget"
        before={`$${(diff.budgetDelta / 1000).toFixed(1)}K`}
        delta={diff.budgetDelta}
        showSign
      />
      <DiffStat
        label="Job Security"
        before={`${diff.jobSecurityDelta > 0 ? '+' : ''}${diff.jobSecurityDelta}`}
        delta={diff.jobSecurityDelta}
        showSign
      />
      <div className="bg-gray-50 rounded p-2 text-center">
        <div className="text-[10px] text-gray-500 uppercase">Rating moves</div>
        <div className="font-mono font-bold text-pnw-slate">
          {diff.ovrChanges.length} player{diff.ovrChanges.length === 1 ? '' : 's'}
        </div>
      </div>
    </div>
  )
}

function DiffStat({ label, before, delta }) {
  const color = delta > 0 ? 'text-green-700' : delta < 0 ? 'text-red-700' : 'text-gray-500'
  return (
    <div className="bg-gray-50 rounded p-2 text-center">
      <div className="text-[10px] text-gray-500 uppercase">{label}</div>
      <div className={'font-mono font-bold ' + color}>{before}</div>
    </div>
  )
}

function DiffWeek({ diff, index }) {
  const big = diff.ovrChanges.slice(0, 6)
  const happyMovers = diff.happinessChanges.slice(0, 4)
  return (
    <div className="border border-gray-100 rounded-lg p-3 bg-gray-50/60">
      <div className="text-xs font-semibold text-pnw-slate mb-1.5">
        Week {index}: {diff.fromMode === 'OFFSEASON' ? `Offseason Wk ${diff.fromOffseasonWeek} → ${diff.toOffseasonWeek}` : `Season Wk ${diff.fromSeasonWeek} → ${diff.toSeasonWeek}`}
        {(diff.recordDelta.w + diff.recordDelta.l > 0) && (
          <span className="ml-2 font-normal text-gray-600">
            ({diff.recordDelta.w}W-{diff.recordDelta.l}L this week)
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] uppercase text-gray-500 mb-1">Rating changes</div>
          {big.length === 0 ? <div className="text-[11px] text-gray-400">— no rating moves this week</div> : (
            <ul className="text-[11px] space-y-0.5">
              {big.map(c => (
                <li key={c.id} className="flex justify-between">
                  <span className="text-gray-700">{c.name} <span className="text-gray-400">({c.pos})</span></span>
                  <span className={c.delta > 0 ? 'text-green-700 font-mono' : 'text-red-700 font-mono'}>
                    {c.before} → {c.after} {c.delta > 0 ? '↑' : '↓'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase text-gray-500 mb-1">Happiness shifts</div>
          {happyMovers.length === 0 ? <div className="text-[11px] text-gray-400">— no happiness moves this week</div> : (
            <ul className="text-[11px] space-y-0.5">
              {happyMovers.map(c => (
                <li key={c.id} className="flex justify-between">
                  <span className="text-gray-700">{c.name} <span className="text-gray-400">({c.pos})</span></span>
                  <span className={c.delta > 0 ? 'text-green-700 font-mono' : 'text-red-700 font-mono'}>
                    {c.before} → {c.after} {c.delta > 0 ? '↑' : '↓'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {diff.budgetDelta !== 0 && (
        <div className="text-[11px] mt-2 text-gray-600">
          Budget: <span className={diff.budgetDelta > 0 ? 'text-green-700 font-mono' : 'text-red-700 font-mono'}>
            {diff.budgetDelta > 0 ? '+' : ''}${(diff.budgetDelta / 1000).toFixed(1)}K
          </span>
        </div>
      )}
    </div>
  )
}
