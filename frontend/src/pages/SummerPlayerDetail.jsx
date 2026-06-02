// SummerPlayerDetail — /summer/players/:id
//
// Data wrapper for the rich summer player profile. Fetches the payload
// (optionally for a selected ?season=), renders a season pill row, and
// delegates the layout to SummerPlayerProfile (which shares the spring
// profile's visual language: hero, percentile bars, radar, charts).

import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { usePlayerProfileTheme } from '../components/playerProfile/shared'
import SummerPlayerProfile from './SummerPlayerProfile'

function SeasonPills({ seasons, active, onSelect }) {
  const T = usePlayerProfileTheme()
  if (!seasons || seasons.length < 2) return null
  return (
    <div className="inline-flex gap-1 p-1 rounded-lg" style={{ background: T.card, border: `1px solid ${T.border}` }}>
      {seasons.slice().sort((a, b) => b - a).map(s => (
        <button
          key={s}
          onClick={() => onSelect(s)}
          className="px-2.5 py-1 rounded-md text-[11px] font-bold tracking-wide transition-colors tabular-nums"
          style={s === active ? { background: T.accent, color: '#fff' } : { background: T.track, color: T.textMuted }}>
          {s}
        </button>
      ))}
    </div>
  )
}

export default function SummerPlayerDetail() {
  const { id } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const seasonParam = searchParams.get('season')
  const { data, loading, error } = useApi(
    `/summer/players/${id}`,
    seasonParam ? { season: seasonParam } : {},
  )

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <div className="animate-spin h-8 w-8 border-4 border-nw-teal border-t-transparent rounded-full" />
      </div>
    )
  }
  if (error || !data?.player) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12 text-center text-gray-500 dark:text-gray-400">
        {error || 'Player not found.'}{' '}
        <Link to="/summer" className="text-nw-teal dark:text-teal-300 underline">Back to Summer Hub</Link>
      </div>
    )
  }

  const setSeason = (s) => {
    const next = new URLSearchParams(searchParams)
    next.set('season', String(s))
    setSearchParams(next)
  }

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4">
      <Link to="/summer" className="inline-block text-xs text-nw-teal dark:text-teal-300 hover:underline mb-3">
        ← Summer Hub
      </Link>
      <SummerPlayerProfile
        data={data}
        seasonSelector={<SeasonPills seasons={data.seasons} active={data.season} onSelect={setSeason} />}
      />
    </div>
  )
}
