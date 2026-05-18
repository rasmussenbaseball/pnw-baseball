import { useMemo } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import TeamLogo from '../../gm/components/TeamLogo'
import TeamRankChip from '../../gm/components/TeamRankChip'
import GMShell from '../../gm/components/GMShell'
import { ensureNwbbRatings } from '../../gm/engine/nwbbRating'

export default function Standings() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'
  const save = useMemo(() => loadDynasty(userId, slot), [userId, slot])

  if (!save) return <Navigate to="/gm" replace />

  // Make sure NWBB ratings are computed so the rank/SOS columns render
  const ratings = ensureNwbbRatings(save)

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
    <GMShell schoolName={userSchool.name} schoolColors={userSchool.colors}>
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">STANDINGS</h1>
        <p className="font-pixel text-base text-[#a8a8c8]">{userConf.name}</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="bg-gray-50">
            <tr className="text-left text-sm text-gray-700 uppercase">
              <th className="py-2 px-3">#</th>
              <th></th>
              <th>Team</th>
              <th title="National rank from the NWBB Rating engine — predictive 0-100 universal scale">National Rank</th>
              <th>Conference W-L</th>
              <th>Overall W-L</th>
              <th title="Run Differential — runs scored minus runs allowed">Run Diff.</th>
              <th title="Strength of Schedule rank — 1 = hardest schedule">Schedule Strength</th>
            </tr>
          </thead>
          <tbody>
            {confTeams.map(({ school, team }, i) => {
              const isUser = school.id === save.userSchoolId
              const r = ratings[school.id]
              return (
                <tr key={school.id} className={'border-t ' + (isUser ? 'bg-pnw-cream font-medium' : 'hover:bg-gray-50')}>
                  <td className="py-2 px-3 text-gray-600">{i + 1}</td>
                  <td><TeamLogo school={school} size={24} /></td>
                  <td className="font-medium">
                    {school.name}
                    <TeamRankChip save={save} schoolId={school.id} />
                  </td>
                  <td className="font-mono text-sm text-gray-700" title="National rank (NWBB Rating)">
                    {r ? `#${r.nationalRank}` : '—'}
                    {r && (
                      <span className="text-xs text-gray-500 ml-1" title="NWBB Rating — predictive 0-100 universal scale">
                        ({r.rating.toFixed(1)})
                      </span>
                    )}
                  </td>
                  <td className="font-mono">{team.confWins}-{team.confLosses}</td>
                  <td className="font-mono">{team.wins}-{team.losses}</td>
                  <td className={'font-mono ' + (team.runDiff > 0 ? 'text-green-700' : team.runDiff < 0 ? 'text-red-700' : 'text-gray-500')}>
                    {team.runDiff > 0 ? '+' : ''}{team.runDiff}
                  </td>
                  <td className="font-mono text-sm text-gray-700" title="Strength of Schedule rank — 1 = hardest schedule played. Empty until games are played.">
                    {r && r.gamesPlayed > 0 ? `#${r.sosRank}` : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
    </GMShell>
  )
}
