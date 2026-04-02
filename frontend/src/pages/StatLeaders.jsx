import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStatLeaders } from '../hooks/useApi'

const BADGE_COLORS = {
  D1: 'bg-red-600 text-white',
  D2: 'bg-blue-600 text-white',
  D3: 'bg-green-600 text-white',
  NAIA: 'bg-purple-600 text-white',
  JUCO: 'bg-amber-700 text-white',
}

function formatValue(value, format) {
  if (value == null) return '-'
  switch (format) {
    case 'int':
      return Math.round(value).toString()
    case 'float1':
      return value.toFixed(1)
    case 'float2':
      return value.toFixed(2)
    case 'avg':
      return value >= 1 ? value.toFixed(3) : value.toFixed(3).replace(/^0/, '')
    case 'pct':
      return (value * 100).toFixed(1) + '%'
    default:
      return value.toString()
  }
}

// ─── Single leader card for one stat category ───
function LeaderCard({ category }) {
  const { label, format, leaders } = category

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Stat header */}
      <div className="px-3 py-2 border-b border-gray-100 bg-gray-50">
        <h3 className="text-sm font-bold text-gray-800">{label}</h3>
      </div>

      {/* Leader rows */}
      <div className="divide-y divide-gray-50">
        {leaders.map((player, i) => {
          const badgeClass = BADGE_COLORS[player.division_level] || 'bg-gray-500 text-white'
          return (
            <div
              key={player.player_id}
              className={`flex items-center gap-2 px-3 py-2 hover:bg-teal-50/50 transition-colors ${i === 0 ? 'bg-amber-50/40' : ''} ${player.is_qualified === false ? 'italic text-gray-500' : ''}`}
            >
              {/* Rank */}
              <span className={`text-xs font-bold w-5 text-center shrink-0 ${i === 0 ? 'text-amber-600' : 'text-gray-400'}`}>
                {i + 1}
              </span>

              {/* Team logo */}
              {player.logo_url && (
                <img
                  src={player.logo_url}
                  alt=""
                  className="w-5 h-5 object-contain shrink-0"
                  onError={(e) => { e.target.style.display = 'none' }}
                />
              )}

              {/* Player info */}
              <div className="flex-1 min-w-0">
                <Link
                  to={`/player/${player.player_id}`}
                  className="text-xs font-semibold text-gray-800 hover:text-nw-teal transition-colors truncate block"
                >
                  {player.first_name} {player.last_name}
                </Link>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`text-[8px] font-bold px-1 py-0 rounded ${badgeClass}`}>
                    {player.division_level}
                  </span>
                  <span className="text-[10px] text-gray-400 truncate">{player.short_name}</span>
                  {player.position && (
                    <span className="text-[10px] text-gray-400">· {player.position}</span>
                  )}
                </div>
              </div>

              {/* Stat value */}
              <span className={`text-sm font-bold tabular-nums shrink-0 ${i === 0 ? 'text-nw-teal' : 'text-gray-700'}`}>
                {formatValue(player.value, format)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Main Page ───
const LEVELS = ['All', 'D1', 'D2', 'D3', 'NAIA', 'JUCO']
const SPLITS = ['All', 'Home', 'Road']

export default function StatLeaders() {
  const [qualified, setQualified] = useState(true)
  const [level, setLevel] = useState('All')
  const [split, setSplit] = useState('All')
  const { data, loading, error } = useStatLeaders(2026, 5, qualified, level === 'All' ? null : level, split === 'All' ? null : split.toLowerCase())

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-nw-teal border-t-transparent" />
      </div>
    )
  }

  if (error) {
    return <div className="text-center text-red-600 py-10">Error loading stat leaders: {error}</div>
  }

  const batting = data?.batting || []
  const pitching = data?.pitching || []

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-pnw-slate mb-1">Stat Leaders</h1>
          <p className="text-sm text-gray-500">Top 5 in key categories · 2026 season{split !== 'All' ? ` · ${split} games` : ''}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            {LEVELS.map(l => (
              <button
                key={l}
                onClick={() => setLevel(l)}
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                  level === l
                    ? 'bg-nw-teal text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {SPLITS.map(s => (
              <button
                key={s}
                onClick={() => setSplit(s)}
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                  split === s
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={qualified}
              onChange={(e) => setQualified(e.target.checked)}
              className="rounded border-gray-300 text-pnw-teal focus:ring-pnw-sky h-4 w-4"
            />
            <span className="text-sm font-medium text-gray-700">Qualified</span>
          </label>
        </div>
      </div>

      {/* Batting Leaders */}
      <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-2">Hitting</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
        {batting.map(cat => (
          <LeaderCard key={cat.key} category={cat} />
        ))}
      </div>

      {/* Pitching Leaders */}
      <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-2">Pitching</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {pitching.map(cat => (
          <LeaderCard key={cat.key} category={cat} />
        ))}
      </div>
    </div>
  )
}
