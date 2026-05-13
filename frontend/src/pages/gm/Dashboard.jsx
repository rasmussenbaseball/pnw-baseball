import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import { simWeek, advanceWeek, advanceOffseasonWeek } from '../../gm/engine/season'
import { seedFromPear } from '../../gm/engine/rankings'
import { teamOverall, playerOverall } from '../../gm/engine/playerRating'
import { teamAcademicSummary } from '../../gm/engine/academics'
import { scholarshipSnapshot } from '../../gm/engine/scholarshipAccounting'
import { openNonConfWeeks } from '../../gm/engine/schedule'
import {
  calendarDateLabel, offseasonPhase, offseasonWeekDate, formatShortDate,
  OFFSEASON_WEEKS,
} from '../../gm/engine/calendar'
import { prettyLabel } from '../../gm/engine/format'
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
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => loadDynasty(userId, slot))
  const [busy, setBusy] = useState(false)
  const [lastWeekRecap, setLastWeekRecap] = useState(null)

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

  // Next game (season mode only)
  const nextGame = useMemo(() => {
    if (mode !== 'SEASON') return null
    return (save.schedule || [])
      .filter(g => !g.played && (g.homeId === save.userSchoolId || g.awayId === save.userSchoolId))
      .sort((a, b) => a.seasonWeek - b.seasonWeek)[0]
  }, [save, mode])

  // ─── Sim actions ───────────────────────────────────────────────────────────
  function simNextWeek() {
    setBusy(true)
    setLastWeekRecap(null)
    if (mode === 'OFFSEASON') {
      const prevWeek = save.calendar.offseasonWeek
      advanceOffseasonWeek(save)
      saveDynasty(save)
      setSave({ ...save })
      setLastWeekRecap({
        kind: 'offseason',
        from: prevWeek,
        to: save.calendar.offseasonWeek,
        phase: offseasonPhase(save.calendar.offseasonWeek),
      })
    } else if (mode === 'SEASON') {
      const ratings = seedFromPear(save.schools, save.conferences)
      const summary = simWeek(save, save.schedule, ratings)
      advanceWeek(save, save.schedule)
      saveDynasty(save)
      setSave({ ...save })
      setLastWeekRecap({ kind: 'season', results: summary.userResults })
    }
    setBusy(false)
  }


  // ─── UI ────────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl mx-auto py-6 px-4">
      {/* Top bar — identity + date + AP */}
      <div className="bg-gradient-to-r from-pnw-slate to-pnw-green text-white rounded-xl p-5 mb-4 flex justify-between items-center shadow">
        <div className="flex gap-4 items-center">
          <TeamLogo school={school} size={64} />
          <div>
            <Link to="/gm" className="text-xs opacity-70 hover:underline">← Dynasties</Link>
            <div className="text-2xl font-bold leading-tight">{school.name}</div>
            <div className="text-xs opacity-80">{school.city}, {school.state} • {conf.name}</div>
            <div className="text-[11px] opacity-70 mt-0.5">
              {headCoach.firstName} {headCoach.lastName}, head coach
              {save.gameOptions && ` • ${save.gameOptions.mode}${save.gameOptions.difficulty !== 'NORMAL' ? '/' + save.gameOptions.difficulty : ''}`}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wider opacity-80">{dateLabel}</div>
          <div className="text-3xl font-bold mt-1">{save.ap.currentWeek}<span className="text-sm opacity-70"> AP</span></div>
          <div className="text-[11px] opacity-70">{inOffseason ? offseasonPhase(save.calendar.offseasonWeek) : `Season Week ${save.calendar.seasonWeek}`}</div>
        </div>
      </div>

      {/* Sim action bar */}
      <SimActionBar
        mode={mode}
        inOffseason={inOffseason}
        nextGame={nextGame}
        userSchoolId={save.userSchoolId}
        save={save}
        busy={busy}
        onSim={simNextWeek}
        recap={lastWeekRecap}
        offseasonWeek={save.calendar.offseasonWeek}
        startYear={save.calendar.startYear || save.calendar.year}
      />

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-4">
        <KpiCard label="Team OVR" value={teamOvr.overall} accent />
        <KpiCard label="Record" value={`${team.wins}-${team.losses}`} />
        <KpiCard label="Conference" value={`${team.confWins}-${team.confLosses}`} sub={conf.abbreviation} />
        <KpiCard label="Run Diff" value={(team.runDiff > 0 ? '+' : '') + team.runDiff} />
        <KpiCard label="Team GPA" value={acad.teamGpa.toFixed(2)} />
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

          <Panel title="Scholarships" actionTo={`/gm/budget?slot=${slot}`} actionLabel="Budget →">
            <ScholarshipBar snapshot={scholarship} />
            <div className="text-xs mt-3 grid grid-cols-2 gap-x-2 gap-y-1">
              <div className="text-gray-500">Total pool</div>
              <div className="text-right font-mono">${(scholarship.pool / 1000).toFixed(1)}K</div>
              <div className="text-gray-500">Committed (roster)</div>
              <div className="text-right font-mono">${(scholarship.committedPlayers / 1000).toFixed(1)}K</div>
              {scholarship.signedRecruits > 0 && (<>
                <div className="text-gray-500">Signed recruits</div>
                <div className="text-right font-mono">${(scholarship.signedRecruits / 1000).toFixed(1)}K</div>
              </>)}
              {scholarship.pendingOffers > 0 && (<>
                <div className="text-gray-500">Pending offers</div>
                <div className="text-right font-mono text-amber-700">${(scholarship.pendingOffers / 1000).toFixed(1)}K</div>
              </>)}
              <div className="text-gray-500 font-semibold border-t pt-1">Available</div>
              <div className="text-right font-mono font-bold border-t pt-1 text-pnw-green">${(scholarship.available / 1000).toFixed(1)}K</div>
            </div>
            <div className="text-[11px] text-gray-400 mt-2 leading-snug">
              New scholarship $ comes from departing players (graduation, transfers). The pool tops up automatically each year.
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
            <div className="space-y-1.5 text-sm">
              {(save.newsfeed || []).slice(0, 6).map(n => (
                <div key={n.id} className="leading-tight">
                  <span className="text-[10px] text-gray-400 mr-1.5 uppercase">Wk {n.week}</span>
                  <span className="text-gray-700">{n.headline}</span>
                </div>
              ))}
              {(save.newsfeed || []).length === 0 && (
                <div className="text-xs text-gray-400">No news yet. Take an action or sim a week.</div>
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
              <NavTile to={`/gm/schedule?slot=${slot}`} title="Schedule" sub="Games + sim" />
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

function SimActionBar({ mode, inOffseason, nextGame, userSchoolId, save, busy, onSim, recap, offseasonWeek, startYear }) {
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
          disabled={busy}
          className="px-6 py-3 bg-pnw-green rounded font-semibold text-sm hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Simming…' : (inOffseason ? 'Advance Week →' : 'Sim Next Week →')}
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
      <td className="py-1 text-gray-500 w-10">{p.classYear}</td>
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

function KpiCard({ label, value, suffix = '', sub, accent }) {
  return (
    <div className={'rounded-lg border p-3 ' + (accent ? 'bg-pnw-green text-white border-pnw-green' : 'bg-white border-gray-200')}>
      <div className={'text-xl font-bold ' + (accent ? '' : 'text-pnw-slate')}>
        {value}<span className={'text-xs ' + (accent ? 'opacity-80' : 'text-gray-500')}>{suffix}</span>
      </div>
      <div className={'text-[10px] uppercase tracking-wider ' + (accent ? 'opacity-80' : 'text-gray-500')}>
        {label}{sub && <span className="ml-1">{sub}</span>}
      </div>
    </div>
  )
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
    <Link to={to} className="block bg-gray-50 hover:bg-pnw-green hover:text-white border border-gray-200 rounded-lg p-2.5 transition">
      <div className="font-semibold text-sm">{title}</div>
      <div className="text-[11px] opacity-70">{sub}</div>
    </Link>
  )
}

function postseasonSub(ps) {
  if (ps.userWSChamp) return '🏆 National Champ'
  if (ps.userInWS) return 'World Series'
  if (ps.userInField) return 'Opening Round'
  if (ps.userChamp) return '🏆 Conf Champ'
  return 'Missed'
}
