import { useState, useMemo } from 'react'
import { useParkFactors } from '../hooks/useApi'
import { useDivisions } from '../hooks/useApi'
import { Link } from 'react-router-dom'

// ═══════════════════════════════════════════════════════════
// HELPER COMPONENTS
// ═══════════════════════════════════════════════════════════

function ParkFactorBadge({ pct }) {
  if (pct == null) return null
  const abs = Math.abs(pct)
  let color, label
  if (pct >= 5) { color = 'text-red-600 bg-red-50 ring-red-200'; label = 'Hitter-Friendly' }
  else if (pct >= 2) { color = 'text-orange-600 bg-orange-50 ring-orange-200'; label = 'Slight Hitter' }
  else if (pct > -2) { color = 'text-gray-600 bg-gray-50 ring-gray-200'; label = 'Neutral' }
  else if (pct > -5) { color = 'text-blue-600 bg-blue-50 ring-blue-200'; label = 'Slight Pitcher' }
  else { color = 'text-indigo-700 bg-indigo-50 ring-indigo-200'; label = 'Pitcher-Friendly' }

  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className={`w-14 h-14 rounded-full ring-2 flex items-center justify-center ${color}`}>
        <span className="text-lg font-bold">{pct >= 0 ? '+' : ''}{pct.toFixed(1)}</span>
      </div>
      <span className={`text-[10px] font-medium ${color.split(' ')[0]}`}>{label}</span>
    </div>
  )
}

function ComponentBar({ label, value, maxAbs = 10, color = 'teal' }) {
  const pct = Math.min(Math.abs(value) / maxAbs * 100, 100)
  const isPositive = value >= 0
  const barColor = isPositive ? 'bg-red-400' : 'bg-blue-400'
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-500 w-16 text-right shrink-0">{label}</span>
      <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden relative">
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-px h-full bg-gray-300" />
        </div>
        {isPositive ? (
          <div className="absolute top-0 left-1/2 h-full rounded-r-full bg-red-400" style={{ width: `${pct/2}%` }} />
        ) : (
          <div className="absolute top-0 h-full rounded-l-full bg-blue-400" style={{ width: `${pct/2}%`, right: '50%' }} />
        )}
      </div>
      <span className={`text-[10px] font-bold w-12 ${value >= 0 ? 'text-red-600' : 'text-blue-600'}`}>
        {value >= 0 ? '+' : ''}{value.toFixed(1)}%
      </span>
    </div>
  )
}

function ElevationBar({ elevation }) {
  const max = 4200
  const pct = Math.min((elevation / max) * 100, 100)
  const color = elevation >= 2000 ? 'bg-red-500' : elevation >= 1000 ? 'bg-amber-500' : elevation >= 500 ? 'bg-yellow-400' : 'bg-emerald-400'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-semibold text-gray-700 w-14 text-right">{elevation.toLocaleString()}ft</span>
    </div>
  )
}

function DiamondGraphic({ dimensions }) {
  if (!dimensions || (!dimensions.lf && !dimensions.cf && !dimensions.rf)) {
    return <div className="text-[10px] text-gray-400 italic text-center py-3">Dimensions not available</div>
  }
  const isEstimated = dimensions.status === 'estimated'
  return (
    <div className="relative w-32 h-28 mx-auto">
      <svg viewBox="0 0 120 100" className="w-full h-full">
        <path d="M 10 80 Q 60 5, 110 80" fill="none" stroke={isEstimated ? '#d1d5db' : '#9ca3af'} strokeWidth="1.5" strokeDasharray={isEstimated ? '4 2' : 'none'} />
        <line x1="60" y1="95" x2="10" y2="80" stroke="#9ca3af" strokeWidth="1" />
        <line x1="60" y1="95" x2="110" y2="80" stroke="#9ca3af" strokeWidth="1" />
        <line x1="60" y1="95" x2="60" y2="20" stroke="#9ca3af" strokeWidth="0.5" strokeDasharray="3 3" />
        <circle cx="60" cy="95" r="3" fill="#00687a" />
      </svg>
      <div className="absolute left-0 top-[60%] text-[10px] font-bold text-gray-600">{dimensions.lf}'</div>
      <div className="absolute left-1/2 -translate-x-1/2 top-1 text-[10px] font-bold text-gray-600">{dimensions.cf}'</div>
      <div className="absolute right-0 top-[60%] text-[10px] font-bold text-gray-600">{dimensions.rf}'</div>
      {isEstimated && (
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 text-[8px] text-gray-400 italic">est.</div>
      )}
    </div>
  )
}

function DivBadge({ name }) {
  const colorMap = {
    'NCAA D1': 'bg-red-600', 'NCAA D2': 'bg-blue-600', 'NCAA D3': 'bg-green-600',
    'NAIA': 'bg-purple-600', 'NWAC': 'bg-amber-700',
  }
  const bg = colorMap[name] || 'bg-gray-500'
  return <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded text-white ${bg}`}>{name}</span>
}

function SurfaceBadge({ surface }) {
  const isNatural = surface?.toLowerCase().includes('natural') || (surface?.toLowerCase().includes('grass') && !surface?.toLowerCase().includes('turf'))
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${isNatural ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
      {surface || 'Unknown'}
    </span>
  )
}

// ═══════════════════════════════════════════════════════════
// PARK CARD
// ═══════════════════════════════════════════════════════════

function ParkCard({ park }) {
  const [expanded, setExpanded] = useState(false)
  const dims = park.dimensions || {}
  const hr = park.home_road_split || {}

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-base font-bold text-gray-800">{park.team_name || park.short_name}</div>
            <div className="text-xs text-gray-500 mt-0.5 truncate">{park.stadium}</div>
            <div className="text-[11px] text-gray-400 mt-0.5">{park.city}, {park.state}</div>
            <div className="flex items-center gap-1.5 mt-1.5">
              {park.division_name && <DivBadge name={park.division_name} />}
              <SurfaceBadge surface={park.surface} />
            </div>
          </div>
          <ParkFactorBadge pct={park.park_factor_pct} />
        </div>
      </div>

      {/* Component breakdown */}
      <div className="px-4 py-3 space-y-1.5">
        <div className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold mb-1">Factor Breakdown</div>
        <ComponentBar label="Elevation" value={park.elevation_effect_pct || 0} maxAbs={8} />
        <ComponentBar label="Dimensions" value={park.dimension_effect_pct || 0} maxAbs={4} />
        <ComponentBar label="Temp" value={park.temperature_effect_pct || 0} maxAbs={2} />
        <ComponentBar label="H/R Split" value={hr.regressed_pct || 0} maxAbs={20} />
      </div>

      {/* Key stats row */}
      <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] text-gray-400">Elevation</div>
          <div className="text-xs font-bold text-gray-700">{(park.elevation_ft || 0).toLocaleString()} ft</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400">Avg OF Depth</div>
          <div className="text-xs font-bold text-gray-700">{dims.avg_of || '-'} ft</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400">Avg Temp</div>
          <div className="text-xs font-bold text-gray-700">
            {park.season_avg_temp_f ? `${park.season_avg_temp_f}°F` : park.march_avg_temp_f ? `${park.march_avg_temp_f}°F` : '-'}
          </div>
          {park.march_avg_temp_f && park.april_avg_temp_f && (
            <div className="text-[9px] text-gray-400">{park.march_avg_temp_f}° Mar / {park.april_avg_temp_f}° Apr</div>
          )}
        </div>
      </div>

      {/* Expandable details */}
      <div className="border-t border-gray-100">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-4 py-2 text-[11px] text-gray-500 hover:text-gray-700 hover:bg-gray-50 flex items-center justify-between transition-colors"
        >
          <span>Field details, home/road data & notes</span>
          <svg className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {expanded && (
          <div className="px-4 pb-3 space-y-3">
            <DiamondGraphic dimensions={dims} />
            <div className="flex justify-center gap-4 text-[10px] text-gray-500">
              <span>LF: {dims.lf}' </span><span>CF: {dims.cf}'</span><span>RF: {dims.rf}'</span>
              {dims.status === 'estimated' && <span className="italic text-gray-400">(estimated)</span>}
            </div>

            {/* Home/Road split details */}
            {hr.home_games > 0 && (
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold mb-2">Home/Road Split</div>
                <div className="grid grid-cols-2 gap-3 text-center">
                  <div>
                    <div className="text-[10px] text-gray-400">R/G at Home</div>
                    <div className="text-sm font-bold text-gray-800">{hr.rpg_at_park}</div>
                    <div className="text-[10px] text-gray-400">{hr.home_games} games</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-gray-400">R/G on Road</div>
                    <div className="text-sm font-bold text-gray-800">{hr.rpg_on_road}</div>
                    <div className="text-[10px] text-gray-400">{hr.away_games} games</div>
                  </div>
                </div>
                <div className="mt-2 text-center">
                  <span className="text-[10px] text-gray-400">Raw H/R ratio: </span>
                  <span className={`text-xs font-bold ${hr.raw_pct >= 0 ? 'text-red-600' : 'text-blue-600'}`}>
                    {hr.raw_pct >= 0 ? '+' : ''}{hr.raw_pct}%
                  </span>
                  {hr.regression_factor < 1 && (
                    <span className="text-[10px] text-gray-400 ml-1">(regressed ×{hr.regression_factor})</span>
                  )}
                </div>
              </div>
            )}

            {/* Additional details */}
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <div className="bg-gray-50 rounded p-2">
                <span className="text-gray-400">Air Density</span>
                <div className="font-bold text-gray-700">{park.air_density_pct}%</div>
              </div>
              {park.capacity && (
                <div className="bg-gray-50 rounded p-2">
                  <span className="text-gray-400">Capacity</span>
                  <div className="font-bold text-gray-700">{park.capacity.toLocaleString()}</div>
                </div>
              )}
            </div>

            {park.notes && <p className="text-xs text-gray-600 leading-relaxed">{park.notes}</p>}
          </div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SUMMARY BAR
// ═══════════════════════════════════════════════════════════

function SummaryBar({ teams }) {
  const stats = useMemo(() => {
    if (!teams?.length) return null
    const sorted = [...teams].sort((a, b) => (b.park_factor_pct || 0) - (a.park_factor_pct || 0))
    const highestElev = teams.reduce((a, b) => (a.elevation_ft || 0) > (b.elevation_ft || 0) ? a : b)
    const smallestField = teams.reduce((a, b) => {
      const aAvg = a.dimensions?.avg_of || 999
      const bAvg = b.dimensions?.avg_of || 999
      return aAvg < bAvg ? a : b
    })
    const largestField = teams.reduce((a, b) => {
      const aAvg = a.dimensions?.avg_of || 0
      const bAvg = b.dimensions?.avg_of || 0
      return aAvg > bAvg ? a : b
    })
    const confirmedDims = teams.filter(t => t.dimensions?.status === 'confirmed').length

    return {
      mostHitter: sorted[0],
      mostPitcher: sorted[sorted.length - 1],
      highestElev,
      smallestField,
      largestField,
      confirmedDims,
      total: teams.length,
    }
  }, [teams])

  if (!stats) return null

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4">
      <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Quick Stats</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div>
          <div className="text-[10px] text-gray-400 uppercase">Most Hitter-Friendly</div>
          <div className="text-sm font-bold text-red-600">{stats.mostHitter?.short_name}</div>
          <div className="text-[10px] text-gray-500">+{stats.mostHitter?.park_factor_pct}%</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400 uppercase">Most Pitcher-Friendly</div>
          <div className="text-sm font-bold text-blue-600">{stats.mostPitcher?.short_name}</div>
          <div className="text-[10px] text-gray-500">{stats.mostPitcher?.park_factor_pct}%</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400 uppercase">Highest Elevation</div>
          <div className="text-sm font-bold text-amber-600">{stats.highestElev?.short_name}</div>
          <div className="text-[10px] text-gray-500">{stats.highestElev?.elevation_ft?.toLocaleString()}ft</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400 uppercase">Smallest Field</div>
          <div className="text-sm font-bold text-red-600">{stats.smallestField?.short_name}</div>
          <div className="text-[10px] text-gray-500">{stats.smallestField?.dimensions?.avg_of}ft avg</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400 uppercase">Largest Field</div>
          <div className="text-sm font-bold text-blue-600">{stats.largestField?.short_name}</div>
          <div className="text-[10px] text-gray-500">{stats.largestField?.dimensions?.avg_of}ft avg</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400 uppercase">Field Dimensions</div>
          <div className="text-sm font-bold text-gray-800">{stats.confirmedDims} / {stats.total}</div>
          <div className="text-[10px] text-gray-500">confirmed</div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SORTABLE TABLE VIEW
// ═══════════════════════════════════════════════════════════

function TableView({ teams }) {
  const [sortKey, setSortKey] = useState('park_factor_pct')
  const [sortAsc, setSortAsc] = useState(false)

  const sorted = useMemo(() => {
    const s = [...teams]
    s.sort((a, b) => {
      let aVal, bVal
      if (sortKey === 'name') { aVal = a.short_name || ''; bVal = b.short_name || ''; return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal) }
      if (sortKey === 'dims') { aVal = a.dimensions?.avg_of || 0; bVal = b.dimensions?.avg_of || 0 }
      else { aVal = a[sortKey] || 0; bVal = b[sortKey] || 0 }
      return sortAsc ? aVal - bVal : bVal - aVal
    })
    return s
  }, [teams, sortKey, sortAsc])

  const toggleSort = (key) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(key === 'name') }
  }

  const SortHeader = ({ k, children, right }) => (
    <th
      className={`px-2 py-2 text-[10px] font-semibold text-gray-500 uppercase cursor-pointer hover:text-gray-700 whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}
      onClick={() => toggleSort(k)}
    >
      {children} {sortKey === k && (sortAsc ? '▲' : '▼')}
    </th>
  )

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <SortHeader k="name">Team</SortHeader>
              <th className="px-2 py-2 text-[10px] font-semibold text-gray-500 uppercase text-left">Div</th>
              <SortHeader k="park_factor_pct" right>PF%</SortHeader>
              <SortHeader k="elevation_effect_pct" right>Elev</SortHeader>
              <SortHeader k="dimension_effect_pct" right>Dims</SortHeader>
              <SortHeader k="temperature_effect_pct" right>Temp</SortHeader>
              <th className="px-2 py-2 text-[10px] font-semibold text-gray-500 uppercase text-right">H/R</th>
              <SortHeader k="elevation_ft" right>Elev ft</SortHeader>
              <SortHeader k="dims" right>OF Avg</SortHeader>
              <SortHeader k="season_avg_temp_f" right>Temp°F</SortHeader>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t, i) => {
              const hr = t.home_road_split || {}
              const pfColor = t.park_factor_pct >= 5 ? 'text-red-600 font-bold' : t.park_factor_pct >= 2 ? 'text-orange-600 font-bold' : t.park_factor_pct > -2 ? 'text-gray-700' : t.park_factor_pct > -5 ? 'text-blue-600 font-bold' : 'text-indigo-700 font-bold'
              return (
                <tr key={t.team_id} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                  <td className="px-2 py-1.5 whitespace-nowrap font-medium text-gray-800">{t.short_name}</td>
                  <td className="px-2 py-1.5"><DivBadge name={t.division_name || t.division} /></td>
                  <td className={`px-2 py-1.5 text-right ${pfColor}`}>
                    {t.park_factor_pct >= 0 ? '+' : ''}{t.park_factor_pct?.toFixed(1)}%
                  </td>
                  <td className="px-2 py-1.5 text-right text-xs text-gray-600">
                    {t.elevation_effect_pct >= 0 ? '+' : ''}{t.elevation_effect_pct?.toFixed(1)}%
                  </td>
                  <td className="px-2 py-1.5 text-right text-xs text-gray-600">
                    {t.dimension_effect_pct >= 0 ? '+' : ''}{t.dimension_effect_pct?.toFixed(1)}%
                  </td>
                  <td className="px-2 py-1.5 text-right text-xs text-gray-600">
                    {t.temperature_effect_pct >= 0 ? '+' : ''}{t.temperature_effect_pct?.toFixed(1)}%
                  </td>
                  <td className="px-2 py-1.5 text-right text-xs text-gray-500">
                    {hr.regressed_pct != null ? `${hr.regressed_pct >= 0 ? '+' : ''}${hr.regressed_pct?.toFixed(1)}%` : '-'}
                  </td>
                  <td className="px-2 py-1.5 text-right text-xs text-gray-600">{(t.elevation_ft || 0).toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-right text-xs text-gray-600">
                    {t.dimensions?.avg_of || '-'}{t.dimensions?.status === 'estimated' ? '*' : ''}
                  </td>
                  <td className="px-2 py-1.5 text-right text-xs text-gray-600">{t.season_avg_temp_f || t.march_avg_temp_f || '-'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════

export default function ParkFactors() {
  const [divisionFilter, setDivisionFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [viewMode, setViewMode] = useState('cards') // 'cards' or 'table'

  const { data: divisions } = useDivisions()

  const params = {}
  if (divisionFilter) params.division_id = parseInt(divisionFilter)
  const { data, loading, error } = useParkFactors(params)

  const filteredTeams = useMemo(() => {
    if (!data?.teams) return []
    let teams = [...data.teams]
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      teams = teams.filter(t =>
        (t.team_name || t.short_name || '').toLowerCase().includes(q) ||
        (t.full_name || '').toLowerCase().includes(q) ||
        (t.stadium || '').toLowerCase().includes(q) ||
        (t.city || '').toLowerCase().includes(q)
      )
    }
    return teams
  }, [data, searchQuery])

  if (loading) {
    return <div className="flex justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-2 border-nw-teal border-t-transparent" /></div>
  }
  if (error) return <div className="text-center text-red-600 py-10">Error loading park factors: {error}</div>

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Park Factors</h1>
      <p className="text-sm text-gray-500 mb-4">
        How each PNW ballpark affects run scoring - broken down by elevation, field size, temperature, and actual home/road data.
      </p>

      <SummaryBar teams={data?.teams} />

      {/* Controls */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3 mb-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">Search</label>
            <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Team, stadium, city..." className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-nw-teal focus:border-transparent w-48" />
          </div>
          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">Division</label>
            <select value={divisionFilter} onChange={(e) => setDivisionFilter(e.target.value)}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-nw-teal">
              <option value="">All</option>
              {divisions?.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="flex gap-1">
            <button onClick={() => setViewMode('cards')} className={`px-3 py-1.5 rounded text-xs font-medium ${viewMode === 'cards' ? 'bg-nw-teal text-white' : 'bg-gray-100 text-gray-600'}`}>Cards</button>
            <button onClick={() => setViewMode('table')} className={`px-3 py-1.5 rounded text-xs font-medium ${viewMode === 'table' ? 'bg-nw-teal text-white' : 'bg-gray-100 text-gray-600'}`}>Table</button>
          </div>
          <button onClick={() => { setDivisionFilter(''); setSearchQuery('') }}
            className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 rounded hover:bg-gray-100">Reset</button>
        </div>
      </div>

      <div className="text-xs text-gray-400 mb-3">
        Showing {filteredTeams.length} of {data?.total || 0} ballparks
        {data?.last_updated && <span className="ml-2">· Updated {data.last_updated}</span>}
      </div>

      {viewMode === 'table' ? (
        <TableView teams={filteredTeams} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filteredTeams.map(park => <ParkCard key={park.team_id} park={park} />)}
        </div>
      )}

      {filteredTeams.length === 0 && (
        <div className="text-center text-gray-400 py-10">No ballparks match the current filters.</div>
      )}

      {/* Methodology */}
      <div className="mt-6 bg-white rounded-lg shadow-sm border border-gray-200 p-5">
        <h2 className="text-sm font-bold text-gray-700 mb-3">Methodology</h2>
        <p className="text-xs text-gray-600 leading-relaxed mb-4">
          Park factors estimate how much a venue inflates or deflates run scoring compared to a neutral park.
          Our model is 80% physics-based and 20% actual game data, preventing team quality from dominating the results.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-gray-50 rounded-lg p-3">
            <h3 className="text-xs font-bold text-gray-700 mb-1">Elevation (biggest factor)</h3>
            <p className="text-[11px] text-gray-600 leading-relaxed">
              Higher elevation → less air density → less drag on the ball → more carry.
              Research shows approximately +1.8% more runs per 1,000 feet of elevation.
              Oregon Tech at 4,108ft is the highest park in the PNW - the ball genuinely carries further there.
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <h3 className="text-xs font-bold text-gray-700 mb-1">Field Dimensions</h3>
            <p className="text-[11px] text-gray-600 leading-relaxed">
              Smaller outfields mean more balls reach the fence and more hits fall in.
              We use 330/400/330 as the baseline and estimate +0.15% per foot smaller on average.
              Yakima Valley's 293-foot foul lines are the shortest in the PNW.
              {data?.teams && ` (${data.teams.filter(t => t.dimensions?.status === 'confirmed').length} of ${data.teams.length} fields have confirmed dimensions.)`}
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <h3 className="text-xs font-bold text-gray-700 mb-1">Temperature</h3>
            <p className="text-[11px] text-gray-600 leading-relaxed">
              Warmer air is less dense, so balls carry further in warm weather. We estimate
              approximately +1% per 10°F above a 60°F baseline. Temperature is calculated as the
              average of March and April highs for each city - the core of the PNW spring season.
              Most parks sit in the 56-65°F range, so this effect is small but real - and it
              slightly penalizes cold-weather parks like those in Montana and eastern Washington.
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <h3 className="text-xs font-bold text-gray-700 mb-1">Home/Road Splits (20% weight)</h3>
            <p className="text-[11px] text-gray-600 leading-relaxed">
              We compare total runs per game in a team's home games vs. their road games.
              This isolates the park effect from team quality - if a team scores more at home than away,
              their park may be hitter-friendly. Results are regressed toward neutral based on sample size
              (full trust at 100+ games) to avoid small-sample noise.
            </p>
          </div>
        </div>

        <div className="mt-4 text-[10px] text-gray-400">
          <strong>Formula:</strong> Park Factor = 80% × (Elevation Effect + Dimension Effect + Temperature Effect) + 20% × Home/Road Split (regressed).
          Positive = hitter-friendly, negative = pitcher-friendly. An asterisk (*) next to field dimensions means they are estimated from division averages.
        </div>
      </div>
    </div>
  )
}
