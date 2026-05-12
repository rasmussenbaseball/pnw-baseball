import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import { simWeek, advanceWeek } from '../../gm/engine/season'
import { seedFromPear } from '../../gm/engine/rankings'
import { teamOverall } from '../../gm/engine/playerRating'
import { teamAcademicSummary } from '../../gm/engine/academics'
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

  if (!save) return <Navigate to="/gm" replace />

  const school = save.schools[save.userSchoolId]
  const conf = save.conferences[school.conferenceId]
  const team = save.teams[save.userSchoolId]
  const headCoach = save.coaches[team.headCoachId]
  const assistants = team.assistantCoachIds.map(id => save.coaches[id])

  // Find next user game
  const nextGame = useMemo(() => {
    return (save.schedule || [])
      .filter(g => !g.played && (g.homeId === save.userSchoolId || g.awayId === save.userSchoolId))
      .sort((a, b) => a.seasonWeek - b.seasonWeek)[0]
  }, [save])

  function simNextWeek() {
    setBusy(true)
    if (save.calendar.mode !== 'SEASON') {
      save.calendar.mode = 'SEASON'
      save.calendar.seasonWeek = 1
      save.calendar.offseasonWeek = null
    }
    const ratings = seedFromPear(save.schools, save.conferences)
    const summary = simWeek(save, save.schedule, ratings)
    advanceWeek(save, save.schedule)
    saveDynasty(save)
    setSave({ ...save })
    setBusy(false)
    if (summary.userResults.length) {
      const msg = `Week ${save.calendar.seasonWeek - 1} complete.\n` +
        summary.userResults.map(r => `  ${r.result}  ${r.score}  ${r.homeAway === 'home' ? 'vs' : '@'} ${r.opponent}`).join('\n')
      alert(msg)
    }
  }

  return (
    <div className="max-w-6xl mx-auto py-8">
      <div className="flex justify-between items-start mb-6">
        <div className="flex gap-4 items-start">
          <TeamLogo school={school} size={64} />
          <div>
            <Link to="/gm" className="text-sm text-pnw-green hover:underline">← Dynasties</Link>
            <h1 className="text-3xl font-bold text-pnw-slate mt-1">{school.name}</h1>
            <p className="text-sm text-gray-600">{school.city}, {school.state} • {conf.name}</p>
            <p className="text-xs text-gray-500 mt-1">
              {save.dynastyName} • {save.calendar.year} {save.calendar.mode} {save.calendar.mode === 'SEASON' ? `Wk ${save.calendar.seasonWeek}` : `Wk ${save.calendar.offseasonWeek}`}
              {save.gameOptions && ` • ${save.gameOptions.mode}${save.gameOptions.difficulty !== 'NORMAL' ? '/' + save.gameOptions.difficulty : ''}`}
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-bold text-pnw-green">{save.ap.currentWeek}</div>
          <div className="text-xs uppercase tracking-wider text-gray-500">AP this week</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-6 gap-3 mb-4">
        <StatCard label="Team OVR" value={teamOverall(team, save.players).overall} />
        <StatCard label="Record" value={`${team.wins}-${team.losses}`} />
        <StatCard label="Conference" value={`${team.confWins}-${team.confLosses}`} />
        <StatCard label="Run Diff" value={(team.runDiff > 0 ? '+' : '') + team.runDiff} />
        <StatCard label="Team GPA" value={teamAcademicSummary(team.rosterPlayerIds.map(id => save.players[id]).filter(Boolean)).teamGpa.toFixed(2)} />
        <StatCard label="Job Security" value={save.budget?.jobSecurity ?? 50} suffix="/100" />
      </div>

      {/* Study Hall mandate */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm mb-4 flex justify-between items-center">
        <div>
          <div className="text-sm font-semibold text-pnw-slate">Study Hall Mandate</div>
          <div className="text-xs text-gray-500">
            {save.studyHall?.active
              ? '✅ Active this term — team GPA gets +0.30 boost at year-end.'
              : 'Mandate study hall (5 AP) to boost team GPA, reduce eligibility risk, and protect job security.'}
          </div>
        </div>
        <button
          disabled={save.studyHall?.active || save.ap.currentWeek < 5}
          onClick={() => {
            save.ap.currentWeek -= 5
            save.ap.spentThisWeek += 5
            save.ap.spentByCategory.program = (save.ap.spentByCategory.program || 0) + 5
            save.studyHall = { active: true, week: save.calendar.week }
            saveDynasty(save)
            setSave({ ...save })
          }}
          className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          {save.studyHall?.active ? 'Active' : 'Mandate (5 AP)'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <StatCard label="Resource Tier" value={school.resourceTier.replace('_', ' ')} />
        <StatCard label="Program History" value={school.programHistory} suffix="/100" />
        <StatCard label="Facility Rating" value={school.facilityRating} suffix="/100" />
        <StatCard label="Scholarship Pool" value={'$' + (school.scholarshipPool / 1000).toFixed(0) + 'K'} />
        <StatCard label="Coaching Budget" value={'$' + (school.coachingBudget / 1000).toFixed(0) + 'K'} />
        <StatCard label="Tuition + R&B" value={'$' + ((school.tuitionPerYear + school.roomAndBoardPerYear) / 1000).toFixed(0) + 'K'} />
      </div>

      {nextGame && (
        <div className="bg-pnw-slate text-white rounded-xl p-5 mb-6 flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wider opacity-70">Next Game — Week {nextGame.seasonWeek}</div>
            <div className="text-lg font-semibold mt-1">
              {nextGame.homeId === save.userSchoolId ? 'vs' : '@'} {(() => {
                const oid = nextGame.homeId === save.userSchoolId ? nextGame.awayId : nextGame.homeId
                return (save.schools[oid] || NON_NAIA_DISPLAY[oid])?.name
              })()}
            </div>
            <div className="text-xs opacity-70">{nextGame.type === 'NON_CONFERENCE' ? 'Non-conference' : 'Conference'} • {nextGame.date}</div>
          </div>
          <button
            onClick={simNextWeek}
            disabled={busy}
            className="px-6 py-3 bg-pnw-green rounded font-semibold text-sm hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Simming…' : 'Sim Next Week →'}
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h2 className="text-lg font-semibold mb-3">Head Coach</h2>
          <div className="text-sm space-y-1">
            <div className="font-medium">{headCoach.firstName} {headCoach.lastName}</div>
            <div className="text-gray-600 text-xs">{headCoach.recruiter_type} • Regions: {headCoach.regions.join(', ')}</div>
            <div className="text-gray-600 text-xs">Pipelines: {headCoach.pipelines.join(', ') || 'none'}</div>
            <div className="grid grid-cols-4 gap-2 mt-3 text-center text-xs">
              <CoachRating label="DEV" value={headCoach.developer} />
              <CoachRating label="MOT" value={headCoach.motivator} />
              <CoachRating label="REC" value={headCoach.recruiter} />
              <CoachRating label="TAC" value={headCoach.tactician} />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h2 className="text-lg font-semibold mb-3">Staff ({assistants.length} assistants)</h2>
          <div className="space-y-1.5 text-sm">
            {assistants.map(c => (
              <div key={c.id} className="flex justify-between text-xs">
                <span className="text-gray-700"><span className="font-medium">{c.firstName} {c.lastName}</span> — {c.role.replace(/_/g, ' ').toLowerCase()}</span>
                <span className="text-gray-500 font-mono">${(c.salary / 1000).toFixed(0)}K</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <NavTile to={`/gm/roster?slot=${slot}`} title="Roster" sub={`${team.rosterPlayerIds.length} players`} />
        <NavTile to={`/gm/schedule?slot=${slot}`} title="Schedule" sub="View + sim games" />
        <NavTile to={`/gm/standings?slot=${slot}`} title="Standings" sub={conf.abbreviation} />
        <NavTile to={`/gm/rankings?slot=${slot}`} title="Rankings" sub="National top 50" />
        <NavTile to={`/gm/budget?slot=${slot}`} title="Budget" sub={`$${(save.budget?.totalAthleticBudget / 1000).toFixed(0)}K`} />
        <NavTile to={`/gm/recruiting?slot=${slot}`} title="Recruiting" sub={save.recruits ? `${Object.keys(save.recruits).length} prospects` : 'Open board'} />
        <NavTile to={`/gm/coaches?slot=${slot}`} title="Staff" sub={`${1 + (team.assistantCoachIds?.length || 0)} coaches`} />
        {save.postseason && (
          <NavTile to={`/gm/postseason?slot=${slot}`} title="Postseason" sub={save.postseason.userWSChamp ? '🏆 National Champ' : save.postseason.userInWS ? 'World Series' : save.postseason.userInField ? 'Opening Round' : save.postseason.userChamp ? '🏆 Conf Champ' : 'Missed'} />
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h2 className="text-lg font-semibold mb-2">News</h2>
        <div className="space-y-1 text-sm">
          {save.newsfeed.slice(0, 5).map(n => (
            <div key={n.id} className="text-gray-700">
              <span className="text-xs text-gray-400 mr-2">Wk {n.week}</span>
              {n.headline}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, suffix = '' }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
      <div className="text-xl font-bold text-pnw-slate">{value}<span className="text-sm text-gray-500">{suffix}</span></div>
      <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">{label}</div>
    </div>
  )
}

function CoachRating({ label, value }) {
  return (
    <div>
      <div className="text-lg font-bold text-pnw-green">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
    </div>
  )
}

function NavTile({ to, title, sub }) {
  return (
    <Link to={to} className="block bg-white rounded-xl border border-gray-200 p-4 shadow-sm hover:border-pnw-green transition">
      <div className="font-semibold text-pnw-slate">{title}</div>
      <div className="text-xs text-gray-500 mt-1">{sub}</div>
    </Link>
  )
}
