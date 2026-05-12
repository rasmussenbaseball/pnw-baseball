import { useMemo } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import TeamLogo from '../../gm/components/TeamLogo'

export default function Standings() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'
  const save = useMemo(() => loadDynasty(userId, slot), [userId, slot])

  if (!save) return <Navigate to="/gm" replace />

  const userSchool = save.schools[save.userSchoolId]
  const userConfId = userSchool.conferenceId
  const userConf = save.conferences[userConfId]

  const confTeams = userConf.schoolIds
    .map(id => ({ school: save.schools[id], team: save.teams[id] }))
    .filter(x => x.school && x.team)
    .sort((a, b) => {
      // Conf W-L first, then overall W-L, then run diff
      if (a.team.confWins !== b.team.confWins) return b.team.confWins - a.team.confWins
      if (a.team.confLosses !== b.team.confLosses) return a.team.confLosses - b.team.confLosses
      if (a.team.wins !== b.team.wins) return b.team.wins - a.team.wins
      return b.team.runDiff - a.team.runDiff
    })

  return (
    <div className="max-w-5xl mx-auto py-8">
      <div className="mb-6">
        <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Dashboard</Link>
        <h1 className="text-3xl font-bold text-pnw-slate mt-1">{userConf.name} Standings</h1>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left text-xs text-gray-500 uppercase">
              <th className="py-2 px-3">#</th>
              <th></th>
              <th>Team</th>
              <th>Conf W-L</th>
              <th>Overall</th>
              <th>Run Diff</th>
            </tr>
          </thead>
          <tbody>
            {confTeams.map(({ school, team }, i) => {
              const isUser = school.id === save.userSchoolId
              return (
                <tr key={school.id} className={'border-t ' + (isUser ? 'bg-pnw-cream font-medium' : 'hover:bg-gray-50')}>
                  <td className="py-2 px-3 text-gray-600">{i + 1}</td>
                  <td><TeamLogo school={school} size={24} /></td>
                  <td className="font-medium">{school.name}</td>
                  <td className="font-mono">{team.confWins}-{team.confLosses}</td>
                  <td className="font-mono">{team.wins}-{team.losses}</td>
                  <td className={'font-mono ' + (team.runDiff > 0 ? 'text-green-700' : team.runDiff < 0 ? 'text-red-700' : 'text-gray-500')}>
                    {team.runDiff > 0 ? '+' : ''}{team.runDiff}
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
