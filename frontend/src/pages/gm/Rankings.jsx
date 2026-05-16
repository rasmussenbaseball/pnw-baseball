import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import { seedFromPear, computeFromSeason } from '../../gm/engine/rankings'
import TeamLogo from '../../gm/components/TeamLogo'
import GMShell from '../../gm/components/GMShell'

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

  // SOS rank — sort descending by sos_index, then assign rank (1 = hardest).
  const sosRankById = useMemo(() => {
    const byHardness = Object.values(ratings)
      .sort((a, b) => b.sos_index - a.sos_index)
    const out = {}
    byHardness.forEach((r, i) => { out[r.schoolId] = i + 1 })
    return out
  }, [ratings])

  const sorted = useMemo(() => {
    return Object.values(ratings)
      .sort((a, b) => {
        // For SOS sort, lower rank (1) wins
        if (sortPillar === 'sos_index') return b.sos_index - a.sos_index
        return b[sortPillar] - a[sortPillar]
      })
  }, [ratings, sortPillar])

  const userSchool = save.schools[save.userSchoolId]
  return (
    <GMShell schoolName={userSchool?.name} schoolColors={userSchool?.colors}>
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">NATIONAL RANKINGS</h1>
        <p className="font-pixel text-base text-[#a8a8c8]">All NAIA programs ranked. SOS rank = 1 means hardest schedule.</p>
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
        <div className="text-xs text-gray-500">All {sorted.length} programs</div>
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
              <th title="Strength of Schedule rank — 1 = hardest schedule in NAIA">SOS Rank</th>
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
                  <td className="font-mono text-xs">#{sosRankById[r.schoolId]}</td>
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

function ratingColor(v) {
  if (v >= 3) return 'text-green-700'
  if (v >= 1) return 'text-pnw-green'
  if (v >= -1) return 'text-gray-700'
  if (v >= -3) return 'text-gray-500'
  return 'text-gray-400'
}
