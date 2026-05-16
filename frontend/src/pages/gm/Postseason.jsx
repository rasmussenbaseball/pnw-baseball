import { useMemo } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import TeamLogo from '../../gm/components/TeamLogo'
import GMShell from '../../gm/components/GMShell'

export default function Postseason() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const save = useMemo(() => loadDynasty(userId, slot), [userId, slot])
  if (!save) return <Navigate to="/gm" replace />
  const userSchool = save.schools[save.userSchoolId]
  if (!save.postseason) {
    return (
      <GMShell schoolName={userSchool?.name} schoolColors={userSchool?.colors}>
      <div className="max-w-3xl mx-auto">
        <h1 className="font-pixel-display text-xl tracking-widest text-white">POSTSEASON</h1>
        <p className="font-pixel text-base text-[#a8a8c8] mt-3">No postseason results yet. Finish a season to see conference tournaments and the NAIA Opening Round.</p>
      </div>
      </GMShell>
    )
  }

  const ps = save.postseason
  const userConfId = save.schools[save.userSchoolId]?.conferenceId
  const userTournament = ps.tournaments.find(t => t.conferenceId === userConfId)

  return (
    <GMShell schoolName={userSchool?.name} schoolColors={userSchool?.colors}>
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">{ps.year} POSTSEASON</h1>
        <p className="text-sm text-gray-600">
          {ps.userChamp ? ' You won your conference!' : ps.userQualified ? ' You qualified for your conference tournament.' : ' You missed the conference tournament.'}
        </p>
      </div>

      {userTournament && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
          <h2 className="text-lg font-semibold mb-3">
            {save.conferences[userConfId].name} Tournament
          </h2>
          <div className="mb-3">
            <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">Qualifiers (seeds)</div>
            <div className="space-y-1">
              {userTournament.qualifiers.map(q => {
                const school = save.schools[q.schoolId]
                const isUser = q.schoolId === save.userSchoolId
                return (
                  <div key={q.schoolId} className={'flex items-center gap-2 text-sm ' + (isUser ? 'font-bold text-pnw-green' : '')}>
                    <span className="w-6 text-gray-500">#{q.seed}</span>
                    <TeamLogo school={school} size={20} />
                    <span>{school?.name}</span>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="mb-2">
            <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">Games</div>
            <div className="space-y-1.5">
              {userTournament.games.map((g, i) => {
                const home = save.schools[g.homeId]
                const away = save.schools[g.awayId]
                const homeWon = g.winner === g.homeId
                const userInGame = g.homeId === save.userSchoolId || g.awayId === save.userSchoolId
                return (
                  <div key={g.id || i} className={'border rounded p-2 ' + (userInGame ? 'border-pnw-green bg-pnw-cream' : 'border-gray-200')}>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{g.label}</div>
                    <div className="flex justify-between items-center text-sm">
                      <div className={'flex items-center gap-2 ' + (homeWon ? 'font-bold' : 'text-gray-500')}>
                        <TeamLogo school={home} size={20} />
                        <span>{home?.name}</span>
                      </div>
                      <div className="font-mono text-sm">
                        <span className={homeWon ? 'font-bold' : ''}>{g.homeRuns}</span>
                        <span className="mx-1">–</span>
                        <span className={!homeWon ? 'font-bold' : ''}>{g.awayRuns}</span>
                      </div>
                      <div className={'flex items-center gap-2 ' + (!homeWon ? 'font-bold' : 'text-gray-500')}>
                        <span>{away?.name}</span>
                        <TeamLogo school={away} size={20} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {userTournament.champion && (
            <div className="mt-4 pt-3 border-t text-sm">
              <strong>Champion:</strong> {save.schools[userTournament.champion]?.name}
              {' '}<span className="text-xs text-gray-500">(auto-bid to NAIA Opening Round)</span>
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h2 className="text-lg font-semibold mb-3">All 21 Conference Champions</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
          {ps.tournaments.map(t => {
            const conf = save.conferences[t.conferenceId]
            const champ = save.schools[t.champion]
            return (
              <div key={t.conferenceId} className="border border-gray-200 rounded p-2">
                <div className="text-[10px] uppercase tracking-wider text-gray-500">{conf?.abbreviation}</div>
                <div className="flex items-center gap-2 mt-1">
                  <TeamLogo school={champ} size={16} />
                  <span className="font-medium">{champ?.name || '—'}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {ps.national && (
        <NationalSection ps={ps} save={save} />
      )}
    </div>
    </GMShell>
  )
}

function NationalSection({ ps, save }) {
  const nat = ps.national
  const userSite = ps.userInField
    ? nat.openingRound.sites.find(s => s.teams.some(t => t.id === save.userSchoolId))
    : null

  return (
    <>
      <div className="mt-6 bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h2 className="text-lg font-semibold mb-3">NAIA National Tournament — Opening Round</h2>
        <p className="text-xs text-gray-500 mb-4">46-team field across 10 host sites. Winners advance to Avista NAIA World Series at Harris Field, Lewiston ID.</p>

        {userSite && (
          <div className="mb-4 border border-pnw-green bg-pnw-cream rounded p-3">
            <div className="text-xs uppercase tracking-wider text-pnw-green mb-1">Your site (hosted by {save.schools[userSite.host]?.name})</div>
            <div className="space-y-1 text-xs">
              {userSite.teams.map(t => (
                <div key={t.id} className={'flex items-center gap-2 ' + (t.id === save.userSchoolId ? 'font-bold' : '')}>
                  <span className="w-5 text-gray-500">#{t.seed}</span>
                  <TeamLogo school={save.schools[t.id]} size={16} />
                  <span>{save.schools[t.id]?.name}</span>
                  {userSite.winner === t.id && <span className="text-pnw-green font-bold">Advanced</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Opening Round winners (advance to WS)</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 text-xs">
          {nat.openingRound.sites.map((site, i) => {
            const winner = save.schools[site.winner]
            const isUser = site.winner === save.userSchoolId
            return (
              <div key={i} className={'flex items-center gap-2 p-1.5 rounded ' + (isUser ? 'bg-pnw-cream font-bold' : '')}>
                <span className="text-gray-500 w-12">Site {i + 1}</span>
                <TeamLogo school={winner} size={16} />
                <span>{winner?.name || '—'}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="mt-4 bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h2 className="text-lg font-semibold mb-3">Avista NAIA World Series</h2>
        <p className="text-xs text-gray-500 mb-4">Harris Field, Lewiston ID. 10 teams, two pools of 5, top 2 from each pool advance to semis.</p>

        {nat.worldSeries?.champion && (
          <div className="mb-4 p-3 bg-gradient-to-r from-yellow-100 to-amber-100 border border-amber-300 rounded">
            <div className="text-xs uppercase tracking-wider text-amber-900"> {ps.year} National Champion</div>
            <div className="flex items-center gap-2 mt-1">
              <TeamLogo school={save.schools[nat.worldSeries.champion]} size={28} />
              <div className="text-xl font-bold text-pnw-slate">{save.schools[nat.worldSeries.champion]?.name}</div>
            </div>
          </div>
        )}

        {nat.worldSeries?.games?.length > 0 && (
          <>
            <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">All games</div>
            <div className="space-y-1 text-xs">
              {nat.worldSeries.games.map((g, i) => {
                const home = save.schools[g.homeId]
                const away = save.schools[g.awayId]
                const homeWon = g.winner === g.homeId
                const userIn = g.homeId === save.userSchoolId || g.awayId === save.userSchoolId
                return (
                  <div key={i} className={'flex items-center justify-between p-1.5 rounded ' + (userIn ? 'bg-pnw-cream' : '')}>
                    <span className="text-gray-500 w-32">{g.label}</span>
                    <span className={homeWon ? 'font-bold' : 'text-gray-500'}>{home?.name}</span>
                    <span className="font-mono">{g.homeRuns}–{g.awayRuns}</span>
                    <span className={!homeWon ? 'font-bold' : 'text-gray-500'}>{away?.name}</span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </>
  )
}
