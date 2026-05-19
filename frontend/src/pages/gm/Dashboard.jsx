import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import { simWeek, advanceWeek, advanceOffseasonWeek } from '../../gm/engine/season'
import { snapshotState, diffSnapshots } from '../../gm/engine/simAhead'
import { canAdvanceWeek, phaseForWeek, requiredActionForWeek, ensureUnifiedCalendar, seasonForWeek, PHASES } from '../../gm/engine/gameYear'
import { seedFromPear } from '../../gm/engine/rankings'
import { teamOverall, playerOverall } from '../../gm/engine/playerRating'
import { teamAcademicSummary } from '../../gm/engine/academics'
import { scholarshipSnapshot } from '../../gm/engine/scholarshipAccounting'
import { openNonConfWeeks } from '../../gm/engine/schedule'
import {
  calendarDateLabel, offseasonPhase, offseasonWeekDate, formatShortDate,
  OFFSEASON_WEEKS,
} from '../../gm/engine/calendar'
import { prettyLabel, displayPosition, displayClassYear } from '../../gm/engine/format'
import { ARCHETYPES, inferArchetype, staffRatings } from '../../gm/engine/archetypes'
import { cutsWindowOpen, cutTrustTier, ensureCutsState, isMandatoryCutMode } from '../../gm/engine/cuts'
import { isAutoMode, setAutoMode, runAutoActions } from '../../gm/engine/autoMode'
import { spendCoachUpgradePoints } from '../../gm/engine/coachProgression'
import { resolveEvent } from '../../gm/engine/randomEvents'
import GMShell, { PixelCard, PixelButton, ModalCloseButton, useModalDismiss, gmToast } from '../../gm/components/GMShell'
import PixelHeadshot from '../../gm/components/PixelHeadshot'
import TutorialOverlay from '../../gm/components/TutorialOverlay'
import TeamLogo from '../../gm/components/TeamLogo'
import TeamRankChip from '../../gm/components/TeamRankChip'
import { ensureNwbbRatings } from '../../gm/engine/nwbbRating'
import nonNaiaRaw from '../../gm/data/non_naia_teams.json'

// Humanize a school-id slug as a last-resort fallback when neither save.schools
// nor NON_NAIA_DISPLAY have it. "nwac-linn-benton" → "Linn-Benton" (NWAC).
function humanizeId(id) {
  if (!id || typeof id !== 'string') return id
  const m = id.match(/^(d[123]|naia|nwac)[-_](.+?)(?:[-_](d[123]|naia|nwac))?$/i)
  if (!m) return id.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const prefix = m[1].toUpperCase()
  const core = m[2].replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return `${core} (${prefix})`
}

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
  const [progress, setProgress] = useState(null)     // { title, step, pct } for heavy ticks
  const [gameWeekModal, setGameWeekModal] = useState(false)   // shown when entering a week with games
  // Phase-transition popup. advanceOneWeek stamps state._phaseTransition
  // when the user crosses a phase boundary. Dashboard reads it here, opens
  // the modal, then clears the marker so the popup only fires once.
  const [phaseTransitionModal, setPhaseTransitionModal] = useState(null)
  // Tutorial overlay — auto-opens on first load (no flags.tutorialSeen).
  // Reopenable from the URL ?tutorial=1 query param so the nav menu can
  // surface it on demand.
  const [tutorialOpen, setTutorialOpen] = useState(() => {
    if (params.get('tutorial') === '1') return true
    if (!save) return false
    return !save.flags?.tutorialSeen
  })
  function dismissTutorial() {
    if (save) {
      if (!save.flags) save.flags = {}
      save.flags.tutorialSeen = true
      saveDynasty(save)
      setSave({ ...save })
    }
    setTutorialOpen(false)
    // Drop the ?tutorial=1 param if it was set
    if (params.get('tutorial')) {
      const url = new URL(window.location.href)
      url.searchParams.delete('tutorial')
      window.history.replaceState({}, '', url.toString())
    }
  }
  useEffect(() => {
    const t = save?._phaseTransition
    if (!t) return
    const toPhase = PHASES[t.to]
    if (!toPhase || t.from === t.to) {
      delete save._phaseTransition
      return
    }
    setPhaseTransitionModal({ from: PHASES[t.from], to: toPhase })
    delete save._phaseTransition
    saveDynasty(save)
  }, [save])

  if (!save) return <Navigate to="/gm" replace />

  // Make sure NWBB ratings are cached so rank chips render anywhere
  const nwbbRatings = ensureNwbbRatings(save)
  const userNwbb = nwbbRatings[save.userSchoolId]

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
  // Fall scrimmages were removed (May 2026) — schedule completeness now only
  // gates on unfilled spring non-conference weekend slots.
  const scheduleBlocked = inOffseason && openSlots.length > 0

  // ── 52-week phase-gate ────────────────────────────────────────────────
  const weekOfYear = save.calendar.weekOfYear ?? save.calendar.offseasonWeek ?? 1
  const currentPhase = phaseForWeek(weekOfYear)
  const requiredAction = requiredActionForWeek(save, weekOfYear)
  const phaseGate = canAdvanceWeek(save)
  // Auto-mode lifts the phase-gate. The AI co-GM (autoMode.js) will fill in
  // any required action before sim runs, so we don't block the user.
  const autoOn = isAutoMode(save)
  // Hard-block — phase requirement OR legacy schedule check (auto skips both)
  const advanceBlocked = !autoOn && (!phaseGate.ok || scheduleBlocked)

  function toggleAutoMode() {
    setAutoMode(save, !autoOn)
    saveDynasty(save)
    setSave({ ...save })
  }

  // ─── Sim actions ───────────────────────────────────────────────────────────
  function simNextWeek() {
    // Story mode pending event blocks every advance until the user makes a
    // choice. We surface a modal at the bottom of the page; this guard just
    // makes sure clicking the +Week button doesn't slip past it.
    if (save.pendingEvent) {
      gmToast('A program event is awaiting your decision. Scroll down and resolve it first.', 'warn')
      return
    }
    // Auto mode short-circuits the gate checks — runAutoActions resolves any
    // open required action before we get here.
    if (autoOn) {
      const auto = runAutoActions(save)
      if (auto.actionsTaken.length > 0) {
        save.newsfeed = save.newsfeed || []
        save.newsfeed.unshift({
          id: `auto_${save.calendar.year}_${save.calendar.weekOfYear}_${Math.random().toString(36).slice(2, 5)}`,
          year: save.calendar.year, week: save.calendar.weekOfYear, type: 'AWARD',
          headline: `Auto: ${auto.actionsTaken.join(' · ')}`,
        })
      }
      saveDynasty(save)
      setSave({ ...save })
    } else {
      if (advanceBlocked) {
        if (requiredAction && !requiredAction.isComplete(save)) {
          gmToast(`Finish "${requiredAction.label}" first — ${requiredAction.blurb}`, 'warn')
          return
        }
        if (scheduleBlocked) {
          gmToast(`Finish your schedule first — ${openSlots.length} open weekend slot${openSlots.length === 1 ? '' : 's'} remaining. Head to Schedule.`, 'warn')
          return
        }
      }
      // Soft confirm if AP is unspent in a non-tutorial week. Tutorial weeks
      // (1-3) have ap=0 by design; Wk 4 is its own gate; otherwise leftover
      // AP would have boosted recruiting / development.
      const wk = save.calendar?.weekOfYear ?? 0
      const ap = save.ap?.currentWeek ?? 0
      if (ap > 0 && wk >= 5 && wk !== 4) {
        const ok = window.confirm(
          `You still have ${ap} AP unspent this week. Advance anyway? (Unused AP is lost — it doesn't carry over.)`
        )
        if (!ok) return
      }
    }
    // Any unplayed user games this week (season OR fall scrim) pop the
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
            gmToast('Postseason sim failed — see console. State was not saved.', 'warn')
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
          gmToast('Sim failed — see console for details. State was not saved.', 'warn')
        }
        setBusy(false)
      }, 30)
      return
    }
    setBusy(false)
  }

  // ─── UI ────────────────────────────────────────────────────────────────────
  return (
    <GMShell schoolName={school.name} schoolColors={school.colors}>
    <div className="min-h-screen">
      {/* Story-mode random event — blocks all advance until resolved */}
      {save.pendingEvent && (
        <PendingEventModal
          event={save.pendingEvent}
          onResolve={(choiceId) => {
            resolveEvent(save, choiceId)
            saveDynasty(save)
            setSave({ ...save })
          }}
        />
      )}
      {progress && <ProgressModal {...progress} />}
      {tutorialOpen && (
        <TutorialOverlay school={school} level={save.level} onClose={dismissTutorial} />
      )}
      {phaseTransitionModal && (
        <PhaseTransitionModal
          from={phaseTransitionModal.from}
          to={phaseTransitionModal.to}
          onClose={() => setPhaseTransitionModal(null)}
        />
      )}
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
                gmToast('Sim failed — see console.', 'warn')
              }
              setBusy(false)
            }, 30)
          }}
          onCancel={() => setGameWeekModal(false)}
        />
      )}
      {/* HERO — team identity, dynasty year, current phase, AP, and quick
          stat strip. Pulled toward a sports-broadcast aesthetic: dark slate
          gradient, glowing accent stripe, big team logo, dense info on the
          right. */}
      <div className="relative bg-gradient-to-br from-pnw-slate via-pnw-slate to-pnw-green text-white rounded-2xl mb-4 shadow-2xl overflow-hidden">
        {/* Decorative diagonal accent stripe */}
        <div className="absolute inset-y-0 right-0 w-1/3 bg-gradient-to-l from-pnw-green/30 to-transparent pointer-events-none"></div>
        <div className="absolute top-0 left-0 w-2 h-full bg-pnw-green"></div>

        <div className="relative p-4 sm:p-6 flex flex-col md:flex-row md:justify-between md:items-stretch gap-4 md:gap-6">
          {/* Identity */}
          <div className="flex gap-3 sm:gap-5 items-center flex-1 min-w-0">
            <div className="bg-white/10 rounded-2xl p-2 sm:p-3 backdrop-blur-sm shadow-inner ring-1 ring-white/15 shrink-0">
              <TeamLogo school={school} size={64} />
            </div>
            <div className="min-w-0">
              <Link to="/gm" className="text-[10px] opacity-60 hover:underline tracking-wider uppercase">Dynasties</Link>
              <div className="text-2xl sm:text-3xl md:text-4xl font-extrabold leading-none tracking-tight mt-1 truncate flex items-baseline gap-2 flex-wrap">
                <span>{school.name}</span>
                {userNwbb && (
                  <span
                    className="text-base font-bold tracking-normal bg-amber-400 text-[#1a1a2e] px-2 py-0.5 rounded leading-none"
                    title={`NWBB Rating ${userNwbb.rating.toFixed(1)} · SOS #${userNwbb.sosRank}`}
                  >
                    #{userNwbb.nationalRank}
                  </span>
                )}
              </div>
              <div className="text-xs opacity-80 mt-1.5">{school.city}, {school.state} · {conf.name}</div>
              <div className="flex items-center gap-3 mt-2.5">
                <div className="bg-white/15 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold">
                  Year {save.dynastyYear || 1}
                </div>
                <div className="text-[11px] opacity-80">
                  {headCoach.firstName} {headCoach.lastName} · HC
                </div>
              </div>
            </div>
          </div>

          {/* Right: current week + AP + Auto toggle */}
          <div className="text-right md:border-l border-white/15 md:pl-6 flex flex-col justify-between border-t md:border-t-0 pt-3 md:pt-0">
            <div>
              <div className="text-[10px] uppercase tracking-wider opacity-60 font-semibold">{dateLabel}</div>
              <div className="text-base font-bold mt-0.5">{currentPhase.label}</div>
              <div className="text-[11px] opacity-70">Wk {weekOfYear} / 52</div>
            </div>
            <div className="mt-4 flex flex-col items-end gap-2">
              <div title="Weekly AP = 22 base + coaching bonus (avg of each coach's developer/motivator/recruiter/tactician — every point above 50 adds AP, scaled by role) + tier bonus (D1_LITE +3, WELL_FUNDED +1, MID 0, SHOESTRING -1) + tenure (+1 per year at school, capped at 8). Clamped to 20-50. Hire/develop better assistants to raise the cap.">
                <div className="text-[10px] uppercase tracking-wider opacity-60 font-semibold">Action Points</div>
                <div className="text-4xl font-extrabold mt-0.5 leading-none">
                  {weekOfYear >= 1 && weekOfYear <= 3
                    ? <span className="text-lg font-bold opacity-70"> Locked</span>
                    : <>{save.ap.currentWeek}<span className="text-base opacity-70 font-normal"> AP</span></>}
                </div>
                <div className="text-[9px] opacity-60 mt-0.5">Hover for formula</div>
              </div>
              <div className="flex flex-col items-end">
                <div className="text-[10px] uppercase tracking-wider opacity-60 font-semibold mb-1">Weekly tasks</div>
                <button
                  type="button"
                  onClick={toggleAutoMode}
                  className={
                    'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider transition border-2 ' +
                    (autoOn
                      ? 'bg-emerald-400 text-emerald-950 border-emerald-200 hover:bg-emerald-300'
                      : 'bg-white/10 text-white border-white/30 hover:bg-white/20')
                  }
                  title={autoOn
                    ? 'AI co-GM is handling required actions, AP, and recruiting each week. Click to switch back to managing it yourself.'
                    : 'You are picking every weekly action. Click to let the AI co-GM handle it for you.'}
                >
                  <span className={'w-2 h-2 rounded-full ' + (autoOn ? 'bg-emerald-900' : 'bg-white/60')}></span>
                  <span>{autoOn ? 'Auto: ON' : 'Auto: OFF'}</span>
                </button>
                <div className="text-[10px] opacity-70 mt-1 text-right max-w-[160px]">
                  {autoOn
                    ? 'AI is handling required actions + AP'
                    : 'Click to let AI handle weekly tasks'}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Status strip — record + conf + run diff + phase blurb */}
        <div className="relative bg-black/30 backdrop-blur-sm px-6 py-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs border-t border-white/10">
          <StatCell label="Overall" value={`${team.wins}-${team.losses}`} />
          <StatCell label={conf.abbreviation} value={`${team.confWins}-${team.confLosses}`} />
          <StatCell
            label="Run Diff"
            value={`${team.runDiff > 0 ? '+' : ''}${team.runDiff}`}
            color={team.runDiff > 0 ? 'text-green-300' : team.runDiff < 0 ? 'text-red-300' : ''}
          />
          <StatCell label="Team OVR" value={teamOvr.overall} />
        </div>
      </div>

      {/* SEASON PERIOD BANNER — prominent, color-coded indicator of which
          umbrella period we're in (Fall Camp / November / December / etc).
          Always visible directly below the hero so the user knows what
          rules govern this week at a glance. */}
      <SeasonPeriodBanner phase={currentPhase} weekOfYear={weekOfYear} />

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
                gmToast('Sim failed — see console.', 'warn')
              }
              setBusy(false)
            }, 30)
          }}
        />
      )}

      {/* Auto-mode hint banner — quick reassurance that AI is in charge */}
      {autoOn && (
        <div className="bg-emerald-950/40 border border-emerald-400/40 rounded-xl p-2 mb-4 text-xs text-emerald-200 flex justify-between items-center">
          <span>
            <strong className="text-emerald-300"> Auto mode is ON.</strong>{' '}
            Required actions, AP, prospect-camp invites, and recruiting are handled for you each week.
            You can still open any page and override decisions manually.
          </span>
          <button
            type="button"
            onClick={toggleAutoMode}
            className="px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider rounded bg-white/10 text-white hover:bg-white/20"
          >
            Switch to Manual
          </button>
        </div>
      )}

      {/* Camp invite window (Wks 5 & 10) — prominent reminder + count */}
      {(weekOfYear === 5 || weekOfYear === 10) && !autoOn && (
        <CampInviteBanner save={save} slot={slot} weekOfYear={weekOfYear} />
      )}

      {/* Cuts window — fires the first week after the user's season ends */}
      <CutsBanner save={save} slot={slot} />


      {/* Summer ball planning prompt — appears Wk 14 (hidden in auto mode) */}
      {weekOfYear === 14 && !autoOn && (
        <div className="bg-pnw-cream border-l-4 border-pnw-green text-pnw-slate p-4 rounded-r mb-4 flex justify-between items-center">
          <div>
            <div className="font-bold"> Summer ball planning is open</div>
            <div className="text-xs mt-1">
              Decide which players will play summer ball next summer. Free to add / remove now;
              once your season ends in spring, you can only REMOVE.
            </div>
          </div>
          <Link to={`/gm/summer?slot=${slot}`} className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold shrink-0 ml-3 hover:opacity-90">
            Plan summer 
          </Link>
        </div>
      )}

      {/* Phase-gate banner — required action this week (hidden in auto mode) */}
      {!autoOn && requiredAction && !requiredAction.isComplete(save) && (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4 mb-4 flex justify-between items-start">
          <div className="flex-1">
            <div className="text-[11px] uppercase tracking-wider text-amber-700 font-bold mb-1">
              Week {weekOfYear} — {currentPhase.label}
            </div>
            <div className="text-sm font-semibold text-amber-900">
               Required: {requiredAction.label}
            </div>
            <div className="text-xs text-amber-800 mt-1 leading-snug">{requiredAction.blurb}</div>
          </div>
          <Link to={`${requiredAction.route}?slot=${slot}`} className="px-4 py-2 bg-amber-600 text-white rounded text-sm font-semibold hover:opacity-90 shrink-0 ml-3">
            Take care of it 
          </Link>
        </div>
      )}
      {!autoOn && requiredAction && requiredAction.isComplete(save) && (
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
            Fix it before you can sim.
          </div>
          <Link to={`/gm/schedule?slot=${slot}`} className="px-3 py-1.5 bg-amber-600 text-white rounded text-xs font-semibold hover:opacity-90">
            Go to Schedule 
          </Link>
        </div>
      )}

      {/* Sim action bar — keep `busy`as the literal busy spinner state.
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
          to={`/gm/academics?slot=${slot}`}
        />
        <KpiCard label="Job Security" value={save.budget?.jobSecurity ?? 50} suffix="/100" />
      </div>

      {/* News — moved above the 3-column layout so the latest happenings are
          the first thing the user reads after sim controls + KPIs. Used to
          live in the center column where it was buried below team stats. */}
      <Panel title="News" actionTo={null} className="mb-4">
        <div className="space-y-2">
          {(save.newsfeed || []).slice(0, 8).map(n => (
            <NewsRow key={n.id} item={n} />
          ))}
          {(save.newsfeed || []).length === 0 && (
            <div className="text-xs text-gray-400 italic">No news yet. Take an action or sim a week.</div>
          )}
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* LEFT column — staff + budget */}
        <div className="space-y-4">
          <Panel title="Coaching Staff" actionTo={`/gm/coaches?slot=${slot}`} actionLabel="Manage ">
            <CoachingStaffCard headCoach={headCoach} assistants={assistants} totalPayroll={totalCoachPayroll} />
          </Panel>

          {/* Up Next — next 3 user games visualized as cards */}
          <UpcomingGames save={save} slot={slot} />

          <Panel title="Scholarships (Next Year)" actionTo={`/gm/budget?slot=${slot}`} actionLabel="Budget ">
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
          {/* Team stats + per-stat leaders — pulls from playerStats once games
              have been played. Hidden if there's nothing to show yet. */}
          <TeamStatsPanel save={save} slot={slot} />

          <Panel title="Top Players" actionTo={`/gm/roster?slot=${slot}`} actionLabel="Full roster ">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1.5 mt-0.5">Top Hitters</div>
            <div className="space-y-0.5 mb-4">
              {topHitters.map(({ p, ovr }) => (
                <PlayerRow key={p.id} p={p} ovr={ovr} slot={slot} />
              ))}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1.5 border-t pt-3">Top Pitchers</div>
            <div className="space-y-0.5">
              {topPitchers.map(({ p, ovr }) => (
                <PlayerRow key={p.id} p={p} ovr={ovr} slot={slot} />
              ))}
            </div>
          </Panel>

          {/* News panel moved to the top of the page (above the 3-column
              grid) per playtester feedback. Was buried at the bottom of
              the center column before. */}
        </div>

        {/* RIGHT column — focus tasks + conference standings widget */}
        <div className="space-y-4">
          <Panel title="This Week's Focus" actionTo={null}>
            <FocusTasks save={save} inOffseason={inOffseason} />
          </Panel>

          <CareerOffersWidget save={save} slot={slot} />
          <CoachUpgradeWidget save={save} onChange={() => { saveDynasty(save); setSave({ ...save }) }} />
          <ConferenceStandingsWidget save={save} slot={slot} />
          <PostseasonBracketWidget save={save} slot={slot} />
          <WeeklyAwardsWidget save={save} />
          <NwacAlumniWidget save={save} />
        </div>
      </div>
    </div>
    </GMShell>
  )
}

// ─── Season period banner (always visible below the hero) ─────────────────

const SEASON_PALETTE = {
  'Late Summer':       { bg: 'bg-amber-700/90',   text: 'text-amber-50',    accent: 'border-amber-400' },
  'Fall Camp':         { bg: 'bg-orange-700/90',  text: 'text-orange-50',   accent: 'border-orange-400' },
  'November':          { bg: 'bg-amber-900/90',   text: 'text-amber-100',   accent: 'border-amber-600' },
  'December':          { bg: 'bg-slate-800/90',   text: 'text-slate-100',   accent: 'border-slate-500' },
  'January':           { bg: 'bg-sky-800/90',     text: 'text-sky-50',      accent: 'border-sky-400' },
  'Spring Season':     { bg: 'bg-emerald-700/90', text: 'text-emerald-50',  accent: 'border-emerald-400' },
  'Postseason':        { bg: 'bg-rose-700/90',    text: 'text-rose-50',     accent: 'border-rose-400' },
  'Summer Recruiting': { bg: 'bg-yellow-700/90',  text: 'text-yellow-50',   accent: 'border-yellow-400' },
}

function SeasonPeriodBanner({ phase, weekOfYear }) {
  if (!phase) return null
  const season = phase.season || 'Offseason'
  const palette = SEASON_PALETTE[season] || SEASON_PALETTE['Late Summer']
  // Build a compact chip row showing what's active this period
  const chips = []
  if (phase.inSeason) chips.push('Games this week')
  if (phase.practice) chips.push('Practice')
  if (phase.conditioning && !phase.practice) chips.push('Conditioning only')
  if (phase.devAllowed) chips.push('Players can improve')
  else chips.push('No improvement')
  return (
    <div className={`${palette.bg} ${palette.text} rounded-xl mb-4 px-4 py-3 border-l-4 ${palette.accent} shadow-md`}>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-widest opacity-75 font-bold">Current period</div>
          <div className="text-lg font-extrabold leading-tight">{season} — {phase.label}</div>
          <div className="text-xs opacity-90 mt-1">{phase.blurb}</div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {chips.map(c => (
            <span key={c} className="bg-black/30 text-[10px] uppercase tracking-wider font-bold rounded px-2 py-1">
              {c}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function PhaseTransitionModal({ from, to, onClose }) {
  useModalDismiss(onClose)
  const palette = SEASON_PALETTE[to.season] || SEASON_PALETTE['Late Summer']
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center px-4" onClick={onClose}>
      <div
        className={`max-w-lg w-full ${palette.bg} ${palette.text} rounded-2xl shadow-2xl border-2 ${palette.accent} p-6`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[10px] uppercase tracking-widest opacity-70 font-bold">Now entering</div>
        <div className="text-3xl font-extrabold leading-tight mt-1">{to.season || to.label}</div>
        <div className="text-base font-semibold opacity-90 mt-0.5">{to.label}</div>
        <div className="mt-4 text-sm leading-relaxed">{to.blurb}</div>
        <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
          <PhaseFlag label="Practice"     active={!!to.practice} />
          <PhaseFlag label="Conditioning" active={!!to.conditioning} />
          <PhaseFlag label="Player dev"   active={!!to.devAllowed} muted={to.devRateMult ? `(${Math.round((to.devRateMult || 1) * 100)}% rate)` : null} />
          <PhaseFlag label="In season"    active={!!to.inSeason} />
        </div>
        <button
          onClick={onClose}
          className="mt-5 w-full bg-black/30 hover:bg-black/40 transition rounded-lg py-2 text-sm font-bold uppercase tracking-wider"
        >
          Got it
        </button>
      </div>
    </div>
  )
}

function PhaseFlag({ label, active, muted }) {
  return (
    <div className={'flex items-center gap-2 ' + (active ? '' : 'opacity-50')}>
      <span className={'inline-block w-2 h-2 rounded-full ' + (active ? 'bg-emerald-300' : 'bg-red-300')}></span>
      <span className="font-semibold">{label}</span>
      {muted && <span className="text-[10px] opacity-75">{muted}</span>}
    </div>
  )
}

function CoachUpgradeWidget({ save, onChange }) {
  const team = save.teams[save.userSchoolId]
  const coach = save.coaches[team?.headCoachId]
  if (!coach) return null
  const points = coach.upgradePoints || 0
  const earned = coach.upgradePointsEarned || 0
  function spend(ratingKey) {
    const result = spendCoachUpgradePoints(save, ratingKey, 1)
    if (!result.ok) { gmToast(result.error, 'error'); return }
    onChange?.()
  }
  // Show even if 0 points — surfaces the mechanic + lifetime earned so users
  // know what the system tracks. Hide entirely if never earned a point yet.
  if (earned === 0 && points === 0) return null
  return (
    <Panel title="Coach Development" actionTo={null}>
      <div className="text-xs text-gray-500 mb-2">
        You've earned <strong className="text-pnw-green">{earned}</strong> upgrade
        point{earned === 1 ? '' : 's'} this dynasty by winning games + producing
        award-winning players. Spend them to permanently bump your ratings.
      </div>
      <div className="bg-pnw-cream/40 rounded p-2 mb-2 text-center">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">Available to spend</div>
        <div className="text-2xl font-bold font-mono text-pnw-green">{points}</div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {[
          ['developer', 'Developer'],
          ['motivator', 'Motivator'],
          ['recruiter', 'Recruiter'],
          ['tactician', 'Tactician'],
        ].map(([key, label]) => {
          const cur = coach[key] ?? 50
          const canSpend = points > 0 && cur < 99
          return (
            <button
              key={key}
              onClick={() => canSpend && spend(key)}
              disabled={!canSpend}
              className={
                'text-left p-2 rounded border-2 transition ' +
                (canSpend
                  ? 'border-pnw-green text-pnw-slate bg-white hover:bg-pnw-cream cursor-pointer'
                  : 'border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed')
              }
            >
              <div className="flex justify-between items-baseline">
                <span className="text-[10px] uppercase tracking-wider font-bold">{label}</span>
                <span className="font-mono font-bold text-lg">{cur}</span>
              </div>
              <div className="text-[10px] text-gray-500 mt-0.5">
                {canSpend ? '+1 for 1 pt' : cur >= 99 ? 'Maxed' : 'No pts'}
              </div>
            </button>
          )
        })}
      </div>
      <div className="text-[10px] text-gray-400 italic mt-2">
        Earn points by: wins (+2-5), conference / postseason runs (+8 to +30), MLB draft picks (+5 each), All-Conference + Gold Glove honors (+2-3 each).
      </div>
    </Panel>
  )
}

/**
 * Postseason bracket widget — visible on the Dashboard once the postseason
 * has been simulated (Wk 40+). Shows three tiers of bracket info in order:
 *   1. Your conference tournament (qualifiers + bracket + champion)
 *   2. NAIA Opening Round (your site's 5-team double-elim — or "missed field")
 *   3. Avista NAIA World Series (pool play + semis + champion)
 *
 * Pre-postseason: widget hides itself entirely.
 */
function PostseasonBracketWidget({ save, slot }) {
  const ps = save.postseason
  if (!ps) return null
  const userId = save.userSchoolId
  const userConfId = save.schools?.[userId]?.conferenceId
  const conf = save.conferences?.[userConfId]
  const userTour = ps.tournaments?.find(t => t.conferenceId === userConfId)
  const nat = ps.national
  const userSite = ps.userInField
    ? nat?.openingRound?.sites?.find(s => s.teams.some(t => t.id === userId))
    : null
  const ws = nat?.worldSeries

  return (
    <Panel
      title={`${ps.year} Postseason`}
      actionTo={`/gm/postseason?slot=${slot}`}
      actionLabel="Full bracket"
    >
      {/* === ROUND 1: Conference tournament === */}
      {userTour && (
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-1.5">
            Round 1 — {conf?.abbreviation || 'Conf'} Tournament
          </div>
          <div className="space-y-1">
            {userTour.games.slice(-3).map((g, i) => (
              <BracketLine
                key={i}
                save={save}
                game={g}
                userId={userId}
              />
            ))}
          </div>
          <div className="mt-1.5 text-[11px]">
            <span className="text-gray-500">Champion: </span>
            <strong className={userTour.champion === userId ? 'text-pnw-green' : 'text-pnw-slate'}>
              {save.schools[userTour.champion]?.name || '—'}
            </strong>
            {userTour.champion === userId && <span className="text-pnw-green ml-1.5">[YOU]</span>}
          </div>
        </div>
      )}

      {/* === ROUND 2: NAIA Opening Round (your site only) === */}
      {nat && (
        <div className="mb-3 border-t pt-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-1.5">
            Round 2 — NAIA Opening Round (5-team site)
          </div>
          {!ps.userInField ? (
            <div className="text-[11px] text-gray-500 italic">Missed the 46-team national field.</div>
          ) : userSite ? (
            <div>
              <div className="text-[11px] text-gray-600 mb-1">
                Site host: <strong>{save.schools[userSite.host]?.name}</strong>
              </div>
              <div className="space-y-0.5">
                {userSite.teams.map(t => {
                  const isUser = t.id === userId
                  const advanced = userSite.winner === t.id
                  return (
                    <div
                      key={t.id}
                      className={'flex items-center gap-1.5 text-[11px] py-0.5 px-1.5 rounded ' + (isUser ? 'bg-pnw-cream font-bold' : '')}
                    >
                      <span className="w-4 text-gray-500 tabular-nums">#{t.seed}</span>
                      <span className="flex-1 truncate">{save.schools[t.id]?.name}</span>
                      {advanced && <span className="text-pnw-green text-[10px] font-semibold">→ WS</span>}
                      {isUser && !advanced && <span className="text-gray-500 text-[10px]">eliminated</span>}
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* === ROUND 3: World Series === */}
      {ws && (
        <div className="border-t pt-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-1.5">
            Round 3 — Avista NAIA World Series
          </div>
          {!ps.userInWS ? (
            <div className="text-[11px] text-gray-500 italic mb-1">
              {ps.userORWon ? 'Tracking your bracket below.' : "Didn't advance — Opening Round eliminated."}
            </div>
          ) : (
            <div className="text-[11px] mb-1">
              <span className="text-gray-600">Your run: </span>
              <strong className={ps.userWSChamp ? 'text-amber-700' : 'text-pnw-slate'}>
                {ps.userWSChamp ? 'NATIONAL CHAMPION!' : 'Advanced to WS'}
              </strong>
            </div>
          )}
          <div className="text-[11px]">
            <span className="text-gray-500">Champion: </span>
            <strong className={ws.champion === userId ? 'text-amber-700' : 'text-pnw-slate'}>
              {save.schools[ws.champion]?.name || '—'}
            </strong>
          </div>
        </div>
      )}
    </Panel>
  )
}

function BracketLine({ save, game, userId }) {
  const home = save.schools[game.homeId]
  const away = save.schools[game.awayId]
  const homeWon = game.winner === game.homeId
  const userIn = game.homeId === userId || game.awayId === userId
  return (
    <div className={'border rounded p-1.5 text-[11px] ' + (userIn ? 'border-pnw-green bg-pnw-cream/40' : 'border-gray-200')}>
      <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-0.5">{game.label}</div>
      <div className="flex justify-between items-center">
        <span className={'truncate flex-1 ' + (homeWon ? 'font-bold' : 'text-gray-500')}>
          {home?.name || '—'}
        </span>
        <span className="font-mono text-[10px] mx-1.5 tabular-nums">
          {game.homeRuns}–{game.awayRuns}
        </span>
        <span className={'truncate flex-1 text-right ' + (!homeWon ? 'font-bold' : 'text-gray-500')}>
          {away?.name || '—'}
        </span>
      </div>
    </div>
  )
}

/**
 * Weekly Awards widget — surfaces this week's POTW winners.
 * Hidden when no awards this week (offseason / no games).
 */
/**
 * NWAC Alumni — surfaces where this year's sophomores transferred to.
 * Only visible on NWAC dynasties + after a year rollover that produced
 * actual transfers. Sorted by player OVR (best transfers first).
 */
/**
 * Career Offers widget — alerts the user in story mode that offers are
 * pending. Hidden on regular dynasties. Hidden when no offers are open.
 *
 * Surfaces an "URGENT" red banner if you've been fired, so the user can't
 * miss the implicit deadline to accept a new offer or end their career.
 */
/**
 * PendingEventModal — overlay shown whenever a story-mode random event is
 * waiting on the user. Blocks the screen until the user picks a choice.
 * Each choice has a blurb describing the trade-off so the user can make
 * informed picks rather than rolling blind.
 */
function PendingEventModal({ event, onResolve }) {
  if (!event) return null
  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4">
      <div className="bg-white rounded-xl max-w-xl w-full max-h-[90vh] overflow-y-auto shadow-2xl border-4 border-amber-400">
        <div className="bg-amber-400 text-[#1a1a2e] px-4 py-2 font-pixel-display tracking-widest text-sm">
          PROGRAM EVENT — DECISION REQUIRED
        </div>
        <div className="p-5">
          <h2 className="text-lg font-bold text-pnw-slate mb-2">{event.title}</h2>
          <p className="text-sm text-gray-700 mb-4 leading-snug">{event.body}</p>
          <div className="space-y-2">
            {(event.choices || []).map(choice => (
              <button
                key={choice.id}
                onClick={() => onResolve(choice.id)}
                className="w-full text-left p-3 rounded-lg border-2 border-gray-200 hover:border-amber-400 hover:bg-amber-50 transition"
              >
                <div className="font-semibold text-sm text-pnw-slate">{choice.label}</div>
                {choice.blurb && (
                  <div className="text-[11px] text-gray-600 mt-1 leading-snug">{choice.blurb}</div>
                )}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-gray-400 mt-3 italic">
            You must resolve this event before you can advance another week.
          </p>
        </div>
      </div>
    </div>
  )
}

function CareerOffersWidget({ save, slot }) {
  const career = save?.career
  if (!career || !career.enabled) return null
  const offers = career.currentOffers || []
  const fired = !!career.pendingFiring
  if (offers.length === 0 && !fired) return null
  const urgent = fired
  return (
    <div className={
      'rounded-xl border-2 p-3 ' +
      (urgent ? 'bg-red-50 border-red-400' : 'bg-amber-50 border-amber-300')
    }>
      <div className={'text-[10px] uppercase tracking-widest font-bold mb-1 ' + (urgent ? 'text-red-700' : 'text-amber-700')}>
        {urgent ? 'CAREER URGENT' : 'Career Offers'}
      </div>
      <div className="text-sm text-pnw-slate font-bold mb-1">
        {urgent
          ? `You were fired by ${save.schools?.[save.userSchoolId]?.name || 'your program'}.`
          : `${offers.length} coaching offer${offers.length === 1 ? '' : 's'} waiting.`}
      </div>
      <div className="text-[11px] text-gray-700 mb-2 leading-snug">
        {urgent
          ? offers.length > 0
            ? `${offers.length} program${offers.length === 1 ? ' has' : 's have'} reached out. Pick one or end your career.`
            : 'No offers came in. Decide whether to keep waiting or end your dynasty.'
          : 'Each offseason brings new opportunities. Review the offer details before accepting.'}
      </div>
      <Link
        to={`/gm/career?slot=${slot}`}
        className={
          'inline-block px-3 py-1.5 rounded text-xs font-bold ' +
          (urgent ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-amber-500 text-white hover:bg-amber-600')
        }
      >
        Open Career →
      </Link>
    </div>
  )
}

function NwacAlumniWidget({ save }) {
  if (save.level !== 'NWAC') return null
  const hist = save.nwacAlumni || {}
  // Show the most recent year that has any entries
  const years = Object.keys(hist).map(Number).sort((a, b) => b - a)
  const year = years.find(y => (hist[y] || []).length > 0)
  if (!year) return null
  const list = [...hist[year]].sort((a, b) => (b.ovr || 0) - (a.ovr || 0))

  // Tier badge styling
  const tierStyles = {
    ELITE: 'bg-amber-400 text-[#1a1a2e] font-bold',
    HIGH:  'bg-emerald-500/80 text-white',
    MID:   'bg-blue-500/80 text-white',
    AVG:   'bg-gray-500/80 text-white',
    LOW:   'bg-gray-400/60 text-gray-900',
    WALKON:'bg-gray-300 text-gray-700',
  }

  return (
    <Panel title={`${year} NWAC → 4-Yr Transfers`} actionTo={null}>
      <div className="text-[10px] text-gray-500 mb-2">
        {list.length} sophomore{list.length === 1 ? '' : 's'} signed with 4-year programs this offseason.
      </div>
      <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
        {list.map((row, i) => {
          const tier = row.destination?.tier || 'WALKON'
          const div = row.destination?.division
          const cls = tierStyles[tier] || tierStyles.WALKON
          return (
            <div key={i} className="flex items-center justify-between gap-2 p-1.5 rounded bg-gray-50">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-pnw-slate truncate">{row.playerName}</div>
                <div className="text-[10px] text-gray-600">
                  {row.position} · {row.ovr} OVR
                  {row.hometown?.state && <span> · {row.hometown.city}, {row.hometown.state}</span>}
                </div>
                <div className="text-[11px] text-pnw-green truncate font-medium">
                  → {row.destination?.name || 'No 4-yr offer'}
                  {row.destination?.state && <span className="text-gray-500"> ({row.destination.state})</span>}
                </div>
              </div>
              <span className={'text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ' + cls}>
                {div || 'none'}
              </span>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

function WeeklyAwardsWidget({ save }) {
  const yr = save.calendar?.year
  const wk = save.calendar?.weekOfYear
  const list = save.weeklyAwardsHistory?.[yr]?.[wk] || []
  if (list.length === 0) return null
  // Surface user-conf + NAIA winners (skip other-conference noise)
  const userConfName = save.conferences?.[save.schools?.[save.userSchoolId]?.conferenceId]?.name
  const filtered = list.filter(a => a.scope === 'NAIA' || a.conferenceName === userConfName)
  if (filtered.length === 0) return null
  const userRoster = save.teams?.[save.userSchoolId]?.rosterPlayerIds || []
  return (
    <Panel title={`Wk ${wk} Awards`} actionTo={null}>
      <div className="space-y-1.5">
        {filtered.map((a, i) => {
          const isYours = userRoster.includes(a.playerId)
          const scopeLabel = a.scope === 'NAIA' ? 'NAIA' : 'Conf'
          const kindLabel = a.kind === 'HITTER' ? 'Hitter' : 'Pitcher'
          return (
            <div
              key={i}
              className={'p-1.5 rounded border ' + (isYours ? 'bg-amber-50 border-amber-300' : 'bg-gray-50 border-gray-200')}
            >
              <div className="text-[9px] uppercase tracking-wider font-bold text-amber-700">
                {scopeLabel} {kindLabel} of the Week {isYours && '· YOUR PLAYER'}
              </div>
              <div className="text-xs font-medium text-pnw-slate truncate">{a.playerName}</div>
              <div className="text-[10px] text-gray-600">{a.schoolName} · {a.statsLine}</div>
            </div>
          )
        })}
        {filtered.some(a => userRoster.includes(a.playerId)) && (
          <div className="text-[10px] text-amber-700 italic">
            Your player won — Conf POTW = +1 all stats / NAIA POTW = +3 all stats. Coach earned upgrade points.
          </div>
        )}
      </div>
    </Panel>
  )
}

function ConferenceStandingsWidget({ save, slot }) {
  const userSchool = save.schools[save.userSchoolId]
  const conf = save.conferences[userSchool.conferenceId]
  if (!conf) return null
  const rows = (conf.schoolIds || [])
    .map(id => ({ school: save.schools[id], team: save.teams[id] }))
    .filter(x => x.school && x.team)
    .sort((a, b) => {
      if (a.team.confWins !== b.team.confWins) return b.team.confWins - a.team.confWins
      if (a.team.confLosses !== b.team.confLosses) return a.team.confLosses - b.team.confLosses
      if (a.team.wins !== b.team.wins) return b.team.wins - a.team.wins
      return b.team.runDiff - a.team.runDiff
    })
  // Preseason / no-games yet — show a friendly note instead of all 0-0s
  const totalGames = rows.reduce((s, r) => s + r.team.wins + r.team.losses, 0)
  return (
    <Panel
      title={`${conf.abbreviation || 'Conf'} Standings`}
      actionTo={`/gm/standings?slot=${slot}`}
      actionLabel="Full "
    >
      {totalGames === 0 ? (
        <div className="text-xs text-gray-400 italic">Preseason — no conference results yet.</div>
      ) : (
        <div className="space-y-0.5">
          {rows.map((row, i) => {
            const isUser = row.school.id === save.userSchoolId
            return (
              <div
                key={row.school.id}
                className={'flex items-center gap-2 py-1 px-1.5 rounded text-xs ' + (isUser ? 'bg-pnw-cream/60 font-semibold' : 'hover:bg-gray-50')}
              >
                <div className="w-4 text-gray-500 text-[10px] tabular-nums text-right">{i + 1}.</div>
                <div className="flex-1 truncate flex items-center gap-x-0.5">
                  <span className="truncate">{row.school.name}</span>
                  <TeamRankChip save={save} schoolId={row.school.id} />
                </div>
                <div className="font-mono text-[11px] tabular-nums text-pnw-slate">
                  {row.team.confWins}-{row.team.confLosses}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────────

function SimActionBar({ mode, inOffseason, nextGame, userSchoolId, save, busy, blocked = false, onSim, recap, offseasonWeek, startYear, thisWeekUnplayedCount = 0 }) {
  const date = inOffseason
    ? offseasonWeekDate(startYear, offseasonWeek)
    : null

  // Icon for the period — surface a meaningful symbol so the chip isn't an
  // empty square. Offseason variants pick by what's happening that month
  // (summer / fall / winter / spring buildup); in-season is a baseball.
  function offseasonIcon(wk) {
    if (wk <= 4) return '☀️'      // Late Summer
    if (wk <= 13) return '🍂'    // Fall Camp
    if (wk <= 17) return '🏋️'    // November conditioning
    if (wk <= 21) return '❄️'    // December dead period
    return '🧤'                   // Winter Practice / Spring ramp
  }
  let primary
  if (inOffseason) {
    primary = (
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center text-2xl shrink-0">
          {offseasonIcon(offseasonWeek)}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider opacity-70 font-semibold">
            Offseason Wk {offseasonWeek}/{OFFSEASON_WEEKS} · {formatShortDate(date)}
          </div>
          <div className="text-sm font-semibold mt-0.5">{offseasonPhase(offseasonWeek)}</div>
        </div>
      </div>
    )
  } else if (nextGame) {
    const opp = nextGame.homeId === userSchoolId ? nextGame.awayId : nextGame.homeId
    const oppName = (save.schools[opp] || NON_NAIA_DISPLAY[opp])?.name || 'TBD'
    primary = (
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-pnw-green flex items-center justify-center text-2xl shrink-0">
          ⚾
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider opacity-70 font-semibold">
            Next Game · Wk {nextGame.seasonWeek}
          </div>
          <div className="text-sm font-semibold mt-0.5 flex items-center flex-wrap gap-x-1">
            {nextGame.homeId === userSchoolId ? 'vs' : '@'} {oppName}
            <TeamRankChip save={save} schoolId={opp} />
            <span className="text-[10px] opacity-70 ml-1 font-normal">{nextGame.type === 'CONFERENCE' ? 'Conf' : 'Non-conf'} · {nextGame.date}</span>
          </div>
        </div>
      </div>
    )
  } else {
    primary = <div className="text-sm opacity-80">No upcoming game on the schedule.</div>
  }

  return (
    <div className="bg-pnw-slate text-white rounded-xl px-4 py-3 mb-4 flex items-center justify-between shadow">
      {primary}
      <div className="flex flex-col items-end gap-2">
        <button
          onClick={onSim}
          disabled={busy || blocked}
          className="px-5 py-2.5 bg-pnw-green rounded-lg font-semibold text-sm hover:opacity-90 disabled:opacity-50 shadow-md"
        >
          {busy
            ? 'Simming…'
            : blocked
              ? ' Complete required action'
              : inOffseason
                ? 'Advance Week '
                : thisWeekUnplayedCount > 0
                  ? `▶ Play this week (${thisWeekUnplayedCount} game${thisWeekUnplayedCount === 1 ? '' : 's'})`
                  : 'Sim Next Week '}
        </button>
        {recap?.kind === 'offseason' && (
          <div className="text-[10px] opacity-70">Wk {recap.to} · {recap.phase}</div>
        )}
        {recap?.kind === 'season' && recap.results && recap.results.length > 0 && (
          <div className="text-[10px] opacity-90 text-right">
            {recap.results.slice(0, 3).map(r => (
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
      text: `${openSchedSlots.length} open weekend slot${openSchedSlots.length === 1 ? '' : 's'} on next season's schedule`,
      to: `/gm/schedule?slot=${save.saveSlot}`,
      urgent: true,
    })
  }

  if (inOffseason) {
    if (save.calendar.offseasonWeek <= 4) {
      priorities.push({ text: 'Sign top HS recruits before fall', to: `/gm/recruiting?slot=${save.saveSlot}` })
    }
    if (save.calendar.offseasonWeek >= 5 && save.calendar.offseasonWeek <= 13 && !save.prospectCamp?.year) {
      const wk = save.calendar.offseasonWeek
      const text = wk === 13
        ? 'Run your prospect camp NOW (Wk 13)'
        : wk === 5 || wk === 10
          ? `Invite recruits to prospect camp (Wk ${wk} invite window)`
          : `Prospect camp runs Wk 13 (${13 - wk} wk away)`
      priorities.push({ text, to: `/gm/weekly?slot=${save.saveSlot}` })
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
              <Link to={p.to} className="text-pnw-green hover:underline shrink-0 ml-2">Go </Link>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function PlayerRow({ p, ovr, slot }) {
  // Pixel headshot replaces the initials avatar. Tier badge still
  // communicates "this player is GOOD" at a glance.
  const tier = ovrTier(ovr)
  return (
    <Link
      to={`/gm/player/${p.id}?slot=${slot}`}
      className="flex items-center gap-3 py-1.5 px-1 rounded hover:bg-gray-50 transition group"
    >
      <PixelHeadshot playerId={p.id} size={36} />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm text-pnw-slate group-hover:text-pnw-green truncate">
          {p.firstName} {p.lastName}
        </div>
        <div className="text-[10px] text-gray-500">
          {displayPosition(p.primaryPosition)} · {displayClassYear(p)}
        </div>
      </div>
      <span className={'inline-block px-2 py-0.5 rounded font-bold text-sm shrink-0 ' + tier.classes}>
        {ovr}
      </span>
    </Link>
  )
}

// Tier classification used for OVR badges across the app.
function ovrTier(ovr) {
  if (ovr >= 85) return { label: 'Elite',  classes: 'bg-amber-100 text-amber-900 border border-amber-400' }
  if (ovr >= 75) return { label: 'Strong', classes: 'bg-emerald-100 text-emerald-900 border border-emerald-400' }
  if (ovr >= 65) return { label: 'Solid',  classes: 'bg-blue-100 text-blue-900 border border-blue-300' }
  if (ovr >= 55) return { label: 'Avg',    classes: 'bg-gray-100 text-gray-700 border border-gray-300' }
  return            { label: 'Depth',  classes: 'bg-gray-50 text-gray-500 border border-gray-200' }
}

// Deterministic avatar color from player id so initials don't all look the
// same. Picks from a small palette aligned with the site theme.
function avatarColor(p) {
  const colors = [
    'bg-pnw-green', 'bg-pnw-slate', 'bg-blue-600', 'bg-amber-700',
    'bg-emerald-700', 'bg-indigo-600', 'bg-rose-700', 'bg-cyan-700',
  ]
  let h = 0
  const s = p.id || (p.firstName + p.lastName)
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return colors[h % colors.length]
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

function UpcomingGames({ save, slot }) {
  const userId = save.userSchoolId
  const games = (save.schedule || [])
    .filter(g => !g.played && g.type !== 'BYE' && g.awayId !== '__BYE__'
      && (g.homeId === userId || g.awayId === userId))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .slice(0, 3)
  if (games.length === 0) return null
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
      <div className="flex justify-between items-baseline mb-2">
        <h2 className="text-sm font-semibold text-pnw-slate uppercase tracking-wider">Up Next</h2>
        <Link to={`/gm/schedule?slot=${slot}`} className="text-xs text-pnw-green hover:underline">Full schedule </Link>
      </div>
      <div className="space-y-2">
        {games.map(g => <UpcomingGameRow key={g.id} game={g} save={save} />)}
      </div>
    </div>
  )
}

function UpcomingGameRow({ game, save }) {
  const userId = save.userSchoolId
  const isHome = game.homeId === userId
  const oppId = isHome ? game.awayId : game.homeId
  const opp = save.schools[oppId] || NON_NAIA_DISPLAY[oppId] || { name: oppId, division: '?' }
  const typeBadge = {
    CONFERENCE: { label: 'Conf', bg: 'bg-pnw-green text-white' },
    NON_CONFERENCE: { label: 'NCAA', bg: 'bg-blue-600 text-white' },
    D1_MIDWEEK: { label: 'D1 mid', bg: 'bg-purple-600 text-white' },
    FALL_SCRIMMAGE: { label: 'Fall', bg: 'bg-amber-600 text-white' },
    SPRING_SCRIMMAGE: { label: 'Spring', bg: 'bg-amber-500 text-white' },
  }[game.type] || { label: game.type, bg: 'bg-gray-500 text-white' }
  const dateStr = game.date || ''
  const month = dateStr.slice(5, 7)
  const day = dateStr.slice(8, 10)
  return (
    <div className="flex items-center gap-3 p-2 rounded-lg border border-gray-100 hover:border-pnw-green/30 hover:bg-pnw-cream/30 transition">
      {/* Calendar tile */}
      <div className="w-12 h-12 flex flex-col items-center justify-center rounded-lg bg-pnw-slate text-white shrink-0">
        <div className="text-[8px] uppercase tracking-wider opacity-70 leading-none mt-1">
          {month === '01' ? 'Jan' : month === '02' ? 'Feb' : month === '03' ? 'Mar'
            : month === '04' ? 'Apr' : month === '05' ? 'May' : month === '06' ? 'Jun'
            : month === '07' ? 'Jul' : month === '08' ? 'Aug' : month === '09' ? 'Sep'
            : month === '10' ? 'Oct' : month === '11' ? 'Nov' : month === '12' ? 'Dec' : '?'}
        </div>
        <div className="text-lg font-bold leading-none">{day || '?'}</div>
      </div>
      {/* Matchup */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">{isHome ? 'vs' : '@'}</span>
          <span className="font-semibold text-pnw-slate text-sm truncate">{opp.name}</span>
        </div>
        <div className="text-[10px] text-gray-400 mt-0.5">{opp.city}, {opp.state}</div>
      </div>
      {/* Type badge */}
      <span className={'inline-block text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ' + typeBadge.bg}>
        {typeBadge.label}
      </span>
    </div>
  )
}

function CoachingStaffCard({ headCoach, assistants, totalPayroll }) {
  const staff = useMemo(() => staffRatings(headCoach, assistants), [headCoach, assistants])
  const hcArc = ARCHETYPES[headCoach.archetype || inferArchetype(headCoach)] || ARCHETYPES.GENERALIST
  const synergyColor = staff.synergy > 1.03 ? 'text-green-700 bg-green-50'
    : staff.synergy > 1.0 ? 'text-pnw-green bg-pnw-cream'
    : staff.synergy < 1.0 ? 'text-red-700 bg-red-50' : 'text-gray-600 bg-gray-50'

  return (
    <div>
      {/* HC tile */}
      <div className="bg-gradient-to-br from-pnw-cream to-white border border-pnw-green/30 rounded-lg p-3 mb-3">
        <div className="flex items-center gap-3 mb-2">
          <div className={'w-10 h-10 rounded-full flex items-center justify-center text-white font-bold ' + 'bg-pnw-green'}>
            {(headCoach.firstName?.[0] || '')}{(headCoach.lastName?.[0] || '')}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-pnw-slate font-semibold">Head Coach</div>
            <div className="font-bold text-pnw-slate text-sm truncate">{headCoach.firstName} {headCoach.lastName}</div>
          </div>
          <div className={'text-[10px] font-bold uppercase px-2 py-0.5 rounded ' + hcArc.color + ' bg-white border'}>
            {hcArc.label}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-1 text-center">
          <Rating label="DEV" v={headCoach.developer} />
          <Rating label="MOT" v={headCoach.motivator} />
          <Rating label="REC" v={headCoach.recruiter} />
          <Rating label="TAC" v={headCoach.tactician} />
        </div>
      </div>

      {/* Assistants */}
      {assistants.length > 0 ? (
        <div className="space-y-1.5 mb-3">
          {assistants.map(c => {
            const ac = ARCHETYPES[c.archetype || inferArchetype(c)] || ARCHETYPES.GENERALIST
            return (
              <div key={c.id} className="flex items-center gap-2 text-xs py-1">
                <div className="w-7 h-7 rounded-full bg-pnw-slate text-white flex items-center justify-center font-bold text-[10px]">
                  {(c.firstName?.[0] || '')}{(c.lastName?.[0] || '')}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-pnw-slate truncate">{c.firstName} {c.lastName}</div>
                  <div className="text-[10px] text-gray-500">
                    {prettyLabel(c.role)}
                    <span className={'ml-1 ' + ac.color}>· {ac.label}</span>
                  </div>
                </div>
                <span className="font-mono text-gray-600 shrink-0">${(c.salary / 1000).toFixed(0)}K</span>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="bg-amber-50 border border-amber-200 rounded p-2 text-[11px] text-amber-800 mb-3">
          No assistants yet — hire 3 in Wk 2 to clear the gate.
        </div>
      )}

      {/* Combined staff ratings */}
      <div className="border-t pt-2 mt-1">
        <div className="flex justify-between items-baseline mb-1.5">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Staff Rating</div>
          <div className="text-xl font-bold text-pnw-green leading-none">{staff.overall}</div>
        </div>
        <div className={'text-[10px] px-2 py-1 rounded ' + synergyColor}>
          {(staff.synergy - 1) * 100 >= 0 ? '+' : ''}{((staff.synergy - 1) * 100).toFixed(0)}% · {staff.synergyLabel}
        </div>
      </div>
      <div className="border-t mt-2 pt-2 flex justify-between text-xs">
        <span className="text-gray-600">Total payroll</span>
        <span className="font-mono font-bold">${(totalPayroll / 1000).toFixed(1)}K</span>
      </div>
    </div>
  )
}

function StatCell({ label, value, color = '' }) {
  return (
    <div className="flex flex-col">
      <div className="text-[9px] uppercase tracking-widest opacity-60 font-semibold">{label}</div>
      <div className={'font-mono font-bold text-base mt-0.5 ' + color}>{value}</div>
    </div>
  )
}

function KpiCard({ label, value, suffix = '', sub, accent, trend, to }) {
  const body = (
    <>
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
    </>
  )
  const className = 'rounded-xl border p-3 transition shadow-sm block ' +
    (accent
      ? 'bg-gradient-to-br from-pnw-green to-pnw-slate text-white border-pnw-green'
      : 'bg-white border-gray-200 hover:border-gray-300')
  if (to) {
    return <Link to={to} className={className + ' cursor-pointer hover:shadow-md'}>{body}</Link>
  }
  return <div className={className}>{body}</div>
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

function Panel({ title, actionTo, actionLabel, children, className = '' }) {
  return (
    <div className={'bg-white rounded-xl border border-gray-200 p-4 shadow-sm hover:shadow-md transition ' + className}>
      <div className="flex justify-between items-baseline mb-3 pb-2 border-b border-gray-100">
        <h2 className="text-xs font-bold text-pnw-slate uppercase tracking-widest">{title}</h2>
        {actionTo && (
          <Link to={actionTo} className="text-[11px] text-pnw-green hover:underline font-semibold">
            {actionLabel || 'View '}
          </Link>
        )}
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
  // Same fall-back chain as elsewhere: own-division → non-NAIA registry →
  // humanized slug. Don't fall through to the literal word "Opponent".
  const oppName = save.schools[oppId]?.name
    || NON_NAIA_DISPLAY[oppId]?.name
    || humanizeId(oppId)
  const isHome = first.homeId === userSchoolId
  return (
    <div className="bg-pnw-green text-white rounded-xl p-4 mb-4 flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-3 shadow-lg">
      <div className="flex-1">
        <div className="text-[11px] uppercase tracking-wider opacity-90 font-bold">
           Week {weekOfYear} — {games.length} Game{games.length === 1 ? '' : 's'} This Week
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
          Sim Game{games.length === 1 ? '' : 's'}
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
          {isSecondWindow && <span className="block mt-1 text-amber-800 font-semibold"> Last chance to invite or remove before camp.</span>}
        </div>
      </div>
      <Link to={`/gm/recruiting?slot=${slot}&board=INVITES`} className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-semibold hover:opacity-90 shrink-0 ml-3">
        Manage invites 
      </Link>
    </div>
  )
}

function GameWeekModal({ games, save, weekOfYear, onEnter, onSim, onCancel }) {
  const { backdropProps, stopProps } = useModalDismiss(onCancel)
  const userSchoolId = save.userSchoolId
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" {...backdropProps}>
      <div className="bg-white rounded-xl p-6 shadow-2xl w-full max-w-lg" {...stopProps}>
        <div className="flex justify-between items-start gap-3 mb-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-pnw-green font-bold">
              Week {weekOfYear} — Game Week
            </div>
            <h3 className="text-xl font-bold text-pnw-slate mt-0.5">
              {games.length} game{games.length === 1 ? '' : 's'} this week
            </h3>
          </div>
          <ModalCloseButton onClick={onCancel} />
        </div>
        <div className="space-y-1 mb-4 max-h-40 overflow-y-auto text-sm">
          {games.map(g => {
            const isHome = g.homeId === userSchoolId
            const oppId = isHome ? g.awayId : g.homeId
            // Check both save.schools (own division) and NON_NAIA_DISPLAY (other
            // levels) so cross-level opponents like fall NWAC scrimmages resolve
            // to a clean name instead of the raw ID (e.g. "nwac-linn-benton").
            const opp = save.schools[oppId] || NON_NAIA_DISPLAY[oppId] || { name: humanizeId(oppId) }
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
            Sim Game{games.length === 1 ? '' : 's'} (auto)
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
 * One row of the Player Ratings diff. Clickable to reveal per-stat changes
 * (so the user can see WHICH attributes drove the OVR move, not just the
 * net number).
 */
function RatingChangeRow({ c }) {
  const [open, setOpen] = useState(false)
  const hasDiff = (c.statDiffs || []).length > 0
  const arrow = c.delta > 0 ? '▲' : '▼'
  return (
    <div className="bg-gray-50 rounded text-xs">
      <button
        type="button"
        onClick={() => hasDiff && setOpen(o => !o)}
        className={
          'w-full flex justify-between items-center p-2 text-left ' +
          (hasDiff ? 'hover:bg-gray-100 cursor-pointer' : 'cursor-default')
        }
        disabled={!hasDiff}
      >
        <span className="text-gray-700 flex items-center gap-2">
          {hasDiff && (
            <span className="text-[9px] text-gray-400">{open ? '▾' : '▸'}</span>
          )}
          {c.name} <span className="text-gray-400">({c.pos})</span>
        </span>
        <span className={'font-mono ' + (c.delta > 0 ? 'text-green-700 font-semibold' : 'text-red-700 font-semibold')}>
          OVR {c.before} → {c.after} <span className="ml-1">{arrow} {c.delta > 0 ? '+' : ''}{c.delta}</span>
        </span>
      </button>
      {open && hasDiff && (
        <div className="border-t border-gray-200 px-3 py-2 bg-white">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1">Attributes changed</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {c.statDiffs.map(d => {
              const sign = d.delta > 0 ? '+' : ''
              const color = d.delta > 0 ? 'text-green-700' : 'text-red-700'
              return (
                <div key={d.stat} className="flex justify-between text-[11px]">
                  <span className="text-gray-600">{prettyStat(d.stat)}</span>
                  <span className={'font-mono ' + color}>
                    {d.before.toFixed(1)} → {d.after.toFixed(1)} ({sign}{d.delta.toFixed(1)})
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function prettyStat(key) {
  return {
    contact_l: 'Contact (vs LHP)',
    contact_r: 'Contact (vs RHP)',
    power_l: 'Power (vs LHP)',
    power_r: 'Power (vs RHP)',
    discipline: 'Discipline',
    speed: 'Speed',
    fielding: 'Fielding',
    arm: 'Arm',
    composure: 'Composure',
    durability: 'Durability',
    stuff: 'Stuff',
    control: 'Control',
    command: 'Command',
    stamina: 'Stamina',
    vs_l: 'vs LHB',
    vs_r: 'vs RHB',
  }[key] || key
}

/**
 * Week Recap — appears after every single-week tick to show what changed.
 * Pulls from the snapshot diff (player OVR / happiness / GPA + record +
 * budget) plus the week's userResults if it was an in-season week.
 */
function WeekRecapModal({ recap, save, onDismiss }) {
  const { backdropProps, stopProps } = useModalDismiss(recap ? onDismiss : null)
  if (!recap) return null
  const diff = recap.diff
  const results = recap.results || []
  const ovrTop = (diff?.ovrChanges || []).slice(0, 6)
  const happyTop = (diff?.happinessChanges || []).slice(0, 5)
  const gpaTop = (diff?.gpaChanges || []).slice(0, 4)
  const recordDelta = diff?.recordDelta
  const isOffseason = recap.kind === 'offseason'
  const headerLabel = isOffseason
    ? `Offseason Wk ${recap.from} ${recap.to} — ${recap.phase}`
    : `Game Week Recap`

  // Surface newsfeed events that fired this week — gives the recap real
  // "events that happened" content beyond raw stat diffs.
  const recentEvents = useMemo(() => {
    const items = save.newsfeed || []
    // Show items from the current calendar week or the week we just left.
    const curYear = save.calendar?.year
    const curWk = save.calendar?.week
    return items
      .filter(n => n.year === curYear && (n.week === curWk || n.week === curWk - 1))
      .slice(0, 8)
  }, [save])

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" {...backdropProps}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" {...stopProps}>
        <div className="bg-gradient-to-r from-pnw-slate to-pnw-green text-white p-4 rounded-t-xl flex justify-between items-start gap-3 sticky top-0 z-10">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider opacity-80">Week Recap</div>
            <h3 className="text-2xl font-bold mt-0.5">{headerLabel}</h3>
          </div>
          <ModalCloseButton onClick={onDismiss} dark className="!border-white/40 !text-white" />
        </div>

        <div className="p-5 space-y-4">
          {/* Events fired this week — hires, schedule completion, etc. */}
          {recentEvents.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-2">What happened this week</div>
              <div className="space-y-1">
                {recentEvents.map(ev => (
                  <div key={ev.id} className="text-xs flex items-start gap-2 p-2 bg-pnw-cream/40 rounded">
                    <span className="text-[10px] text-gray-500 uppercase font-mono shrink-0 mt-0.5">Wk {ev.week}</span>
                    <span className="text-gray-700 leading-snug">{ev.headline}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* New injuries this week */}
          {(save._newInjuriesThisWeek?.length > 0 || save._newlyHealedThisWeek?.length > 0) && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-2">Injuries & returns</div>
              <div className="space-y-1">
                {(save._newInjuriesThisWeek || []).map(inj => {
                  const p = save.players[inj.playerId]
                  if (!p) return null
                  const sev = inj.injury.severity
                  const sevColor = sev === 'SEASON' ? 'bg-red-100 text-red-800'
                    : sev === 'MAJOR' ? 'bg-orange-100 text-orange-800'
                    : sev === 'MODERATE' ? 'bg-amber-100 text-amber-800'
                    : 'bg-yellow-50 text-yellow-800'
                  return (
                    <div key={inj.playerId + inj.injury.type} className="flex items-start gap-2 p-2 bg-red-50 rounded">
                      <span className="text-red-700 font-bold text-xs shrink-0 mt-0.5">IL</span>
                      <div className="flex-1 text-sm">
                        <div className="font-medium text-pnw-slate">
                          {p.firstName} {p.lastName} — {inj.injury.label}
                        </div>
                        <div className="text-[11px] text-gray-600">{inj.injury.blurb}</div>
                      </div>
                      <span className={'text-[10px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ' + sevColor}>
                        {sev} · {inj.injury.totalWeeks} wk
                      </span>
                    </div>
                  )
                })}
                {(save._newlyHealedThisWeek || []).map(h => (
                  <div key={'heal_' + h.playerId} className="flex items-start gap-2 p-2 bg-green-50 rounded">
                    <span className="text-green-700 font-bold text-xs shrink-0 mt-0.5">OK</span>
                    <div className="flex-1 text-sm text-pnw-slate">
                      {h.name} — cleared from injury, back in action
                      {h.severity && h.severity !== 'MINOR' && (
                        <span className="text-[11px] text-gray-500 ml-1">(some lingering rating impact)</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

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

          {/* Rating changes — clickable to reveal per-stat diff */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-2">
              Player Ratings {ovrTop.length === 0 && <span className="text-gray-400 normal-case ml-1">— no changes</span>}
            </div>
            {ovrTop.length > 0 && (
              <div className="space-y-1">
                {ovrTop.map(c => <RatingChangeRow key={c.id} c={c} />)}
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
                      {c.before} {c.after} {c.delta > 0 ? '' : ''}
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
                      {c.before.toFixed(2)} {c.after.toFixed(2)} {c.delta > 0 ? '' : ''}
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
            Got it 
          </button>
        </div>
      </div>
    </div>
  )
}

function NewsRow({ item }) {
  // Type accent + icon mapping. The headline emoji is usually enough but
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
  if (ps.userWSChamp) return ' National Champ'
  if (ps.userInWS) return 'World Series'
  if (ps.userInField) return 'Opening Round'
  if (ps.userChamp) return ' Conf Champ'
  return 'Missed'
}

function TeamStatsPanel({ save, slot }) {
  const userId = save.userSchoolId
  const team = save.teams?.[userId]
  if (!team) return null
  const roster = team.rosterPlayerIds || []
  const playerStats = save.playerStats || {}

  // Aggregate spring/season stats only — fall games were removed (May 2026).
  function buildRows(statsBucket) {
    let tAb = 0, tH = 0, tIp = 0, tErP = 0, tHp = 0, tBbP = 0
    const batters = []
    const pitchers = []
    for (const pid of roster) {
      const p = save.players[pid]
      if (!p) continue
      const bs = statsBucket[`b_${pid}`]
      const ps = statsBucket[`p_${pid}`]
      if (bs && bs.ab > 0) {
        tAb += bs.ab; tH += bs.h
        const avg = bs.h / Math.max(1, bs.ab)
        const obp = (bs.h + bs.bb) / Math.max(1, bs.ab + bs.bb)
        const slg = (bs.h - bs.d - bs.t - bs.hr + bs.d * 2 + bs.t * 3 + bs.hr * 4) / Math.max(1, bs.ab)
        batters.push({ p, ab: bs.ab, h: bs.h, hr: bs.hr || 0, rbi: bs.rbi || 0, avg, ops: obp + slg })
      }
      if (ps && ps.ip > 0) {
        tIp += ps.ip; tErP += ps.er || 0; tHp += ps.h || 0; tBbP += ps.bb || 0
        const era = (ps.er || 0) * 9 / Math.max(0.1, ps.ip)
        const whip = ((ps.h || 0) + (ps.bb || 0)) / Math.max(0.1, ps.ip)
        pitchers.push({ p, ip: ps.ip, k: ps.k || 0, era, whip })
      }
    }
    return { batters, pitchers, tAb, tH, tIp, tErP, tHp, tBbP }
  }

  const spring = buildRows(playerStats)
  const hasSpring = spring.batters.length > 0 || spring.pitchers.length > 0

  const showing = hasSpring ? spring : null
  const statSourceLabel = hasSpring ? 'Spring season' : null

  // No stats at all yet show a "preseason preview" using ratings instead of
  // hiding the panel. Gives the user something useful on the home page from
  // day one.
  if (!showing) {
    return <PreseasonStatsPanel team={team} players={save.players} slot={slot} />
  }
  const { batters: battersWithStats, pitchers: pitchersWithStats, tAb: teamAb, tH: teamH, tIp: teamIp, tErP: teamErP, tHp: teamHp, tBbP: teamBbP } = showing

  const teamAvg = teamAb > 0 ? teamH / teamAb : 0
  const teamEra = teamIp > 0 ? teamErP * 9 / teamIp : 0
  const teamWhip = teamIp > 0 ? (teamHp + teamBbP) / teamIp : 0
  const fmt3 = n => n.toFixed(3).replace(/^0\./, '.')

  // Per-stat leaders (min thresholds to avoid 1-AB.500 fluke leaders)
  const sortedByAvg = [...battersWithStats].filter(x => x.ab >= 10).sort((a, b) => b.avg - a.avg)
  const sortedByHr  = [...battersWithStats].sort((a, b) => b.hr - a.hr)
  const sortedByOps = [...battersWithStats].filter(x => x.ab >= 10).sort((a, b) => b.ops - a.ops)
  const sortedByEra = [...pitchersWithStats].filter(x => x.ip >= 5).sort((a, b) => a.era - b.era)
  const sortedByK   = [...pitchersWithStats].sort((a, b) => b.k - a.k)

  return (
    <Panel title="Team Stats" actionTo={`/gm/roster?slot=${slot}`} actionLabel="Roster ">
      <div className="text-[10px] text-gray-500 -mt-2 mb-2 italic">{statSourceLabel}</div>
      {/* Team-level numbers strip */}
      <div className="grid grid-cols-3 gap-2 mb-3 text-center">
        <TeamStatTile label="Team AVG" value={fmt3(teamAvg)} />
        <TeamStatTile label="Team ERA" value={teamEra.toFixed(2)} good={teamEra < 4.5} />
        <TeamStatTile label="WHIP" value={teamWhip.toFixed(2)} good={teamWhip < 1.30} />
      </div>
      {/* Leader cards — show top 1-2 per category */}
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1.5">Hitting Leaders</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
        <LeaderCard label="AVG" leader={sortedByAvg[0]} valueKey="avg" fmt={fmt3} />
        <LeaderCard label="HR" leader={sortedByHr[0]} valueKey="hr" />
        <LeaderCard label="OPS" leader={sortedByOps[0]} valueKey="ops" fmt={fmt3} />
      </div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1.5 border-t pt-2">Pitching Leaders</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <LeaderCard label="ERA" leader={sortedByEra[0]} valueKey="era" fmt={v => v.toFixed(2)} />
        <LeaderCard label="K" leader={sortedByK[0]} valueKey="k" />
      </div>
    </Panel>
  )
}

function PreseasonStatsPanel({ team, players, slot }) {
  // No games yet — show a rating-based preview so the user gets value on
  // their home page before opening day. Top OVR per side + projected team
  // hitting / pitching strength.
  const roster = (team.rosterPlayerIds || []).map(id => players[id]).filter(Boolean)
  const hitters = roster.filter(p => !p.isPitcher)
    .map(p => ({ p, ovr: playerOverall(p) }))
    .sort((a, b) => b.ovr - a.ovr)
  const pitchers = roster.filter(p => p.isPitcher)
    .map(p => ({ p, ovr: playerOverall(p) }))
    .sort((a, b) => b.ovr - a.ovr)
  const avg = arr => arr.length ? Math.round(arr.reduce((s, x) => s + x.ovr, 0) / arr.length) : 0
  const hittingOvr = avg(hitters.slice(0, 9))
  const pitchingOvr = avg(pitchers.slice(0, 5))

  return (
    <Panel title="Team Preview" actionTo={`/gm/roster?slot=${slot}`} actionLabel="Roster ">
      <div className="text-[10px] text-gray-500 -mt-2 mb-2 italic">
        Preseason — no game stats yet. Showing projected strength from current ratings.
      </div>
      <div className="grid grid-cols-2 gap-2 text-center">
        <TeamStatTile label="Hitting OVR" value={hittingOvr} good={hittingOvr >= 70} />
        <TeamStatTile label="Pitching OVR" value={pitchingOvr} good={pitchingOvr >= 70} />
      </div>
      <div className="text-[11px] text-gray-400 italic mt-2">
        Real stats appear once the season starts.
      </div>
    </Panel>
  )
}

function PreviewCard({ label, leader, ratingFn }) {
  if (!leader) return <div className="bg-gray-50 rounded p-2 text-xs text-gray-400 italic">No qualifier</div>
  return (
    <div className="bg-pnw-cream/40 rounded p-2">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">Top {label.toLowerCase()}</div>
      <div className="text-sm font-bold text-pnw-slate truncate">{leader.p.firstName} {leader.p.lastName}</div>
      <div className="text-base font-mono font-bold text-pnw-green">{ratingFn(leader.p)}</div>
    </div>
  )
}

function TeamStatTile({ label, value, good }) {
  const cls = good === true ? 'text-emerald-700' : good === false ? 'text-red-700' : 'text-pnw-slate'
  return (
    <div className="bg-gray-50 rounded p-2">
      <div className={'text-xl font-bold font-mono leading-none ' + cls}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mt-1">{label}</div>
    </div>
  )
}

function LeaderCard({ label, leader, valueKey, fmt }) {
  if (!leader) {
    return (
      <div className="bg-gray-50 rounded p-2 text-center text-xs text-gray-400 italic">
        No qualifier yet
      </div>
    )
  }
  const raw = leader[valueKey]
  const display = fmt ? fmt(raw) : raw
  return (
    <div className="bg-pnw-cream/40 rounded p-2">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label} leader</div>
      <div className="text-sm font-bold text-pnw-slate truncate">{leader.p.firstName} {leader.p.lastName}</div>
      <div className="text-base font-mono font-bold text-pnw-green">{display}</div>
    </div>
  )
}

function CutsBanner({ save, slot }) {
  // Initialize state lazily so we know the right open week + allowance.
  ensureCutsState(save)
  const mandatory = isMandatoryCutMode(save)
  if (mandatory) {
    // Mandatory cuts at Wk 52 — this is a hard block, surface it HOT.
    const needed = save.mandatoryCuts.needed
    const overflow = save.mandatoryCuts.overByAtFlag
    return (
      <div className="bg-red-100 border-2 border-red-700 text-red-900 p-4 rounded mb-4 flex justify-between items-center shadow-lg">
        <div>
          <div className="font-bold text-base"> REQUIRED: Cut {needed} player{needed === 1 ? '' : 's'} to advance</div>
          <div className="text-xs mt-1 leading-snug">
            You signed a class that put your roster <strong>{overflow}</strong> over the 50-player cap.
            The AD already docked your job security ({overflow * 3} pts). You can't advance to the new year
            until you cut down to 50. (Mandatory cut mode lets you cut seniors too.)
          </div>
        </div>
        <Link to={`/gm/roster?slot=${slot}`} className="px-4 py-2 bg-red-700 text-white rounded text-sm font-semibold shrink-0 ml-3 hover:opacity-90">
          Cut down roster 
        </Link>
      </div>
    )
  }
  if (!cutsWindowOpen(save)) return null
  const remaining = (save.cuts?.allowed || 0) - (save.cuts?.used || 0)
  const tier = cutTrustTier(save)
  return (
    <div className="bg-red-50 border-l-4 border-red-500 text-red-900 p-4 rounded-r mb-4 flex justify-between items-center">
      <div>
        <div className="font-bold"> Roster cuts window OPEN</div>
        <div className="text-xs mt-1">
          You have <strong>{remaining}</strong> cut{remaining === 1 ? '' : 's'} remaining this offseason.
          AD trust tier: <strong>{tier.label}</strong>. {tier.note}
        </div>
      </div>
      <Link to={`/gm/roster?slot=${slot}`} className="px-4 py-2 bg-red-600 text-white rounded text-sm font-semibold shrink-0 ml-3 hover:opacity-90">
        Manage roster 
      </Link>
    </div>
  )
}

function summerBallSub(save) {
  const sb = save.summerBall
  if (!sb) return 'Plan now (Wk 14+)'
  const count = Object.values(sb.assignments || {}).filter(a => !a.removed).length
  if (sb.status === 'RESOLVED') return 'Results in newsfeed'
  if (sb.status === 'CONFIRMED') return `${count} confirmed`
  return count > 0 ? `${count} planned` : 'Plan now'
}

