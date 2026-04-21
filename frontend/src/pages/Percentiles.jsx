import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { usePersistedState } from '../hooks/usePersistedState'
import StatsLastUpdated from '../components/StatsLastUpdated'

const LEVELS = ['D1', 'D2', 'D3', 'NAIA', 'JUCO']
const TYPES = [
  { key: 'hitter', label: 'Hitters' },
  { key: 'pitcher', label: 'Pitchers' },
]

// Baseball Savant palette: 100 = red (best), 50 = white, 0 = blue (worst)
function percentileColor(pct) {
  if (pct === null || pct === undefined) return '#ffffff'
  const p = Math.max(0, Math.min(100, pct))
  if (p >= 50) {
    // white -> red
    const t = (p - 50) / 50
    const r = Math.round(255 + (214 - 255) * t)
    const g = Math.round(255 + (62 - 255) * t)
    const b = Math.round(255 + (62 - 255) * t)
    return `rgb(${r}, ${g}, ${b})`
  }
  // blue -> white
  const t = p / 50
  const r = Math.round(29 + (255 - 29) * t)
  const g = Math.round(78 + (255 - 78) * t)
  const b = Math.round(216 + (255 - 216) * t)
  return `rgb(${r}, ${g}, ${b})`
}

// White text on deep red/blue, dark text on middle shades -- matches Savant
function textColorFor(pct) {
  if (pct === null || pct === undefined) return '#6b7280'
  return Math.abs(pct - 50) >= 25 ? '#ffffff' : '#111827'
}

function PercentileCell({ pct, highlighted }) {
  const bg = percentileColor(pct)
  const fg = textColorFor(pct)
  const display = pct === null || pct === undefined ? '' : pct
  return (
    <td
      className={`text-center p-0 align-middle ${
        highlighted ? 'ring-2 ring-inset ring-pnw-slate' : ''
      }`}
    >
      <div
        className="w-full h-full px-2 py-3 text-sm sm:text-base font-bold min-w-[60px]"
        style={{ backgroundColor: bg, color: fg }}
      >
        {display}
      </div>
    </td>
  )
}

export default function Percentiles() {
  const [season] = useState(2026)
  const [level, setLevel] = usePersistedState('pct_level', 'D1')
  const [type, setType] = usePersistedState('pct_type', 'hitter')
  const [sortKey, setSortKey] = usePersistedState('pct_sort', 'avg_pct')
  const [search, setSearch] = useState('')

  const { data, loading, error } = useApi(
    '/leaderboards/percentiles',
    { season, level, type },
    [season, level, type],
  )

  const players = data?.data || []
  const statOrder = data?.stat_order || []

  const sorted = useMemo(() => {
    const arr = [...players]
    arr.sort((a, b) => {
      const av = sortKey === 'avg_pct' ? a.avg_pct : a.percentiles?.[sortKey]
      const bv = sortKey === 'avg_pct' ? b.avg_pct : b.percentiles?.[sortKey]
      if (av === null || av === undefined) return 1
      if (bv === null || bv === undefined) return -1
      return bv - av
    })
    return arr
  }, [players, sortKey])

  const filtered = sorted.filter(p => {
    if (!search) return true
    const q = search.toLowerCase()
    const name = `${p.first_name} ${p.last_name}`.toLowerCase()
    const team = (p.team_name || '').toLowerCase()
    const short = (p.team_short || '').toLowerCase()
    return name.includes(q) || team.includes(q) || short.includes(q)
  })

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <h1 className="text-lg sm:text-2xl font-bold text-pnw-slate">Percentile Rankings</h1>
          <p className="text-xs sm:text-sm text-gray-600 mt-1">
            Every qualified player ranked against others at their division level.
            Red = best, blue = worst. The Avg column averages all percentiles in
            the row for a quick well-roundedness score. Click any column to sort.
          </p>
        </div>
        <StatsLastUpdated />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-4 mt-3">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden">
          {TYPES.map(t => (
            <button
              key={t.key}
              onClick={() => { setType(t.key); setSortKey('avg_pct') }}
              className={`px-4 py-1.5 text-sm font-semibold transition-colors ${
                type === t.key ? 'bg-pnw-green text-white' : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden">
          {LEVELS.map(lv => (
            <button
              key={lv}
              onClick={() => setLevel(lv)}
              className={`px-3 py-1.5 text-sm font-semibold transition-colors ${
                level === lv ? 'bg-pnw-slate text-white' : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              {lv}
            </button>
          ))}
        </div>

        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search player or team..."
          className="flex-1 min-w-[180px] px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-pnw-green/30"
        />
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-600 mb-3">
        <span>
          Ranked among {data?.qualified_count ?? 0} qualified {type === 'hitter' ? 'hitters' : 'pitchers'} in {level}.
        </span>
        <div className="flex items-center gap-1 ml-auto">
          <span>Worst</span>
          <div
            className="w-28 h-3 rounded border border-gray-200"
            style={{
              background: `linear-gradient(to right, ${percentileColor(0)}, ${percentileColor(50)}, ${percentileColor(100)})`,
            }}
          />
          <span>Best</span>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded">
          Failed to load percentiles: {error}
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-pnw-slate text-white sticky top-0 z-10">
            <tr>
              <th className="text-left px-2 py-2 font-semibold uppercase text-[11px] tracking-wider w-10">
                Rk
              </th>
              <th className="text-left px-3 py-2 font-semibold uppercase text-[11px] tracking-wider sticky left-0 bg-pnw-slate z-20 min-w-[200px]">
                Player
              </th>
              <th
                onClick={() => setSortKey('avg_pct')}
                className={`text-center px-2 py-2 font-semibold uppercase text-[11px] tracking-wider min-w-[64px] cursor-pointer hover:bg-pnw-green/30 ${
                  sortKey === 'avg_pct' ? 'bg-pnw-green' : ''
                }`}
              >
                Avg
              </th>
              {statOrder.map(s => (
                <th
                  key={s.key}
                  onClick={() => setSortKey(s.key)}
                  className={`text-center px-2 py-2 font-semibold uppercase text-[11px] tracking-wider min-w-[64px] cursor-pointer hover:bg-pnw-green/30 ${
                    sortKey === s.key ? 'bg-pnw-green' : ''
                  }`}
                >
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={statOrder.length + 3} className="p-6 text-center text-sm text-gray-500">
                  Loading...
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={statOrder.length + 3} className="p-6 text-center text-sm text-gray-500">
                  {players.length === 0
                    ? `No qualified ${type === 'hitter' ? 'hitters' : 'pitchers'} at this level yet.`
                    : 'No matches for your search.'}
                </td>
              </tr>
            )}
            {!loading && filtered.map((p, idx) => (
              <tr key={`${p.player_id}-${p.team_id}`} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                <td className={`px-2 py-2 text-center text-gray-500 text-xs font-mono ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                  {idx + 1}
                </td>
                <td className={`px-3 py-2 sticky left-0 z-10 min-w-[200px] ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                  <div className="flex items-center gap-2">
                    <Link to={`/team/${p.team_id}`} className="shrink-0">
                      {p.logo_url ? (
                        <img src={p.logo_url} alt={p.team_short || p.team_name} className="w-7 h-7 object-contain" />
                      ) : (
                        <div className="w-7 h-7 rounded bg-gray-100" />
                      )}
                    </Link>
                    <div className="min-w-0">
                      <Link
                        to={`/player/${p.player_id}`}
                        className="block font-semibold text-pnw-slate hover:text-pnw-green truncate text-sm"
                      >
                        {p.last_name}, {p.first_name}
                      </Link>
                      <div className="text-[10px] text-gray-500 truncate">
                        {p.team_short || p.team_name}
                        {p.position ? ` \u2022 ${p.position}` : ''}
                        {p.year_in_school ? ` \u2022 ${p.year_in_school}` : ''}
                      </div>
                    </div>
                  </div>
                </td>
                <PercentileCell pct={p.avg_pct} highlighted={sortKey === 'avg_pct'} />
                {statOrder.map(s => (
                  <PercentileCell
                    key={s.key}
                    pct={p.percentiles?.[s.key]}
                    highlighted={sortKey === s.key}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
