import { useMemo } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import TeamLogo from '../../gm/components/TeamLogo'
import TeamRankChip from '../../gm/components/TeamRankChip'
import GMShell from '../../gm/components/GMShell'
import { ensureNwbbRatings } from '../../gm/engine/nwbbRating'

// Render one conference/region standings table.
function StandingsTable({ save, ratings, conf, userSchoolId }) {
  const teams = (conf.schoolIds || [])
    .map(id => ({ school: save.schools[id], team: save.teams[id] }))
    .filter(x => x.school && x.team)
    .sort((a, b) => {
      if (a.team.confWins !== b.team.confWins) return b.team.confWins - a.team.confWins
      if (a.team.confLosses !== b.team.confLosses) return a.team.confLosses - b.team.confLosses
      if (a.team.wins !== b.team.wins) return b.team.wins - a.team.wins
      return b.team.runDiff - a.team.runDiff
    })
  const userInThisGroup = teams.some(t => t.school.id === userSchoolId)
  return (
    <div className={'bg-white rounded-xl border shadow-sm overflow-x-auto ' + (userInThisGroup ? 'border-pnw-green' : 'border-gray-200')}>
      <div className={'px-4 py-2 text-sm font-pixel-display tracking-widest border-b ' + (userInThisGroup ? 'bg-pnw-green text-white' : 'bg-gray-50 text-gray-700')}>
        {conf.name}{userInThisGroup ? ' · YOUR REGION' : ''}
      </div>
      <table className="w-full text-sm min-w-[640px]">
        <thead className="bg-gray-50">
          <tr className="text-left text-sm text-gray-700 uppercase">
            <th className="py-2 px-3">#</th>
            <th></th>
            <th>Team</th>
            <th title="National rank from the NWBB Rating engine">National Rank</th>
            <th>Conf W-L</th>
            <th>Overall W-L</th>
            <th title="Run Differential">Run Diff.</th>
            <th title="Strength of Schedule rank — 1 = hardest">Schedule Strength</th>
          </tr>
        </thead>
        <tbody>
          {teams.map(({ school, team }, i) => {
            const isUser = school.id === userSchoolId
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
                    <span className="text-xs text-gray-500 ml-1" title="NWBB Rating — predictive 0-100">
                      ({r.rating.toFixed(1)})
                    </span>
                  )}
                </td>
                <td className="font-mono">{team.confWins}-{team.confLosses}</td>
                <td className="font-mono">{team.wins}-{team.losses}</td>
                <td className={'font-mono ' + (team.runDiff > 0 ? 'text-green-700' : team.runDiff < 0 ? 'text-red-700' : 'text-gray-500')}>
                  {team.runDiff > 0 ? '+' : ''}{team.runDiff}
                </td>
                <td className="font-mono text-sm text-gray-700" title="Strength of Schedule rank — 1 = hardest. Empty until games are played.">
                  {r && r.gamesPlayed > 0 ? `#${r.sosRank}` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

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

  // NWAC has 4 regions that together make up one conference. Per Nate:
  // show standings for the user's region AND the other 3 regions side by
  // side so the user can see how their region compares. For every other
  // level we keep the single-conference view.
  const isNwac = save.level === 'NWAC'
  const NWAC_REGIONS = ['NWAC_NORTH', 'NWAC_SOUTH', 'NWAC_EAST', 'NWAC_WEST']
  const nwacGroups = isNwac
    ? NWAC_REGIONS
        .map(rid => save.conferences[rid])
        .filter(Boolean)
        // User's region first, others after.
        .sort((a, b) => {
          if (a.id === userConfId) return -1
          if (b.id === userConfId) return 1
          return 0
        })
    : null

  return (
    <GMShell schoolName={userSchool.name} schoolColors={userSchool.colors}>
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">STANDINGS</h1>
        <p className="font-pixel text-base text-[#a8a8c8]">
          {isNwac ? 'NWAC · 4-region conference' : userConf.name}
        </p>
      </div>

      {isNwac ? (
        <div className="space-y-4">
          {nwacGroups.map(c => (
            <StandingsTable
              key={c.id}
              save={save}
              ratings={ratings}
              conf={c}
              userSchoolId={save.userSchoolId}
            />
          ))}
        </div>
      ) : (
        <StandingsTable
          save={save}
          ratings={ratings}
          conf={userConf}
          userSchoolId={save.userSchoolId}
        />
      )}
    </div>
    </GMShell>
  )
}
