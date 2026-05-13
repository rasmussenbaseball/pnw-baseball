import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import { seedFromPear, computeFromSeason } from '../../gm/engine/rankings'
import TeamLogo from '../../gm/components/TeamLogo'

const PILLAR_LABELS = {
  overall_rating: 'Overall',
  offense_rating: 'Offense',
  pitching_rating: 'Pitching',
  defense_rating: 'Defense',
  sos_index: 'SOS',
}

export default function Rankings() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const save = useMemo(() => loadDynasty(userId, slot), [userId, slot])
  const [sortPillar, setSortPillar] = useState('overall_rating')
  const [limit, setLimit] = useState(50)

  const ratings = useMemo(() => {
    if (!save) return {}
    // For Year 1 / no games played, use PEAR seed
    const anyPlayed = (save.schedule || []).some(g => g.played)
    if (!anyPlayed) return seedFromPear(save.schools, save.conferences)
    // Otherwise compute from simulated season
    const games = save.schedule
      .filter(g => g.played)
      .map(g => ({
        homeId: g.homeId, awayId: g.awayId,
        homeRuns: g.homeRuns, awayRuns: g.awayRuns,
        homePA: 40, awayPA: 40,
      }))
    return computeFromSeason(save.schools, save.conferences, games, seedFromPear(save.schools, save.conferences))
  }, [save])

  if (!save) return <Navigate to="/gm" replace />

  const sorted = useMemo(() => {
    return Object.values(ratings)
      .sort((a, b) => b[sortPillar] - a[sortPillar])
      .slice(0, limit)
  }, [ratings, sortPillar, limit])

  return (
    <div className="max-w-6xl mx-auto py-8">
      <div className="mb-6">
        <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Dashboard</Link>
        <h1 className="text-3xl font-bold text-pnw-slate mt-1">National Rankings</h1>
        <p className="text-sm text-gray-600">Predictive, SOS-adjusted national poll. Recomputes from in-game results.</p>
      </div>

      <div className="flex justify-between items-center mb-3">
        <div className="flex gap-2">
          {Object.entries(PILLAR_LABELS).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSortPillar(key)}
              className={'px-3 py-1.5 rounded text-xs font-semibold ' +
                (sortPillar === key ? 'bg-pnw-green text-white' : 'bg-gray-100 text-gray-700')
              }
            >
              {label}
            </button>
          ))}
        </div>
        <select className="border rounded px-2 py-1 text-sm" value={limit} onChange={e => setLimit(parseInt(e.target.value, 10))}>
          <option value={25}>Top 25</option>
          <option value={50}>Top 50</option>
          <option value={100}>Top 100</option>
          <option value={250}>All</option>
        </select>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left text-xs text-gray-500 uppercase">
              <th className="py-2 px-3">#</th>
              <th></th>
              <th>Program</th>
              <th>Conference</th>
              <th>Overall</th>
              <th>Offense</th>
              <th>Pitching</th>
              <th>Defense</th>
              <th>SOS</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => {
              const school = save.schools[r.schoolId]
              const isUser = r.schoolId === save.userSchoolId
              return (
                <tr key={r.schoolId} className={'border-t ' + (isUser ? 'bg-pnw-cream font-medium' : 'hover:bg-gray-50')}>
                  <td className="py-2 px-3 text-gray-600">{i + 1}</td>
                  <td><TeamLogo school={school} size={24} /></td>
                  <td className="font-medium">{school?.name || r.schoolId}</td>
                  <td className="text-gray-500 text-xs">{save.conferences[school?.conferenceId]?.abbreviation}</td>
                  <td className={'font-mono font-bold ' + ratingColor(r.overall_rating)}>{r.overall_rating.toFixed(2)}</td>
                  <td className={'font-mono ' + ratingColor(r.offense_rating)}>{r.offense_rating.toFixed(2)}</td>
                  <td className={'font-mono ' + ratingColor(r.pitching_rating)}>{r.pitching_rating.toFixed(2)}</td>
                  <td className={'font-mono ' + ratingColor(r.defense_rating)}>{r.defense_rating.toFixed(2)}</td>
                  <td className="font-mono text-xs">{r.sos_index.toFixed(0)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ratingColor(v) {
  if (v >= 3) return 'text-green-700'
  if (v >= 1) return 'text-pnw-green'
  if (v >= -1) return 'text-gray-700'
  if (v >= -3) return 'text-gray-500'
  return 'text-gray-400'
}
