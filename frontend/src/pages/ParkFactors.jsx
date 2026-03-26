import { useState, useMemo } from 'react'
import { useParkFactors } from '../hooks/useApi'
import { useDivisions, useConferences } from '../hooks/useApi'
import { Link } from 'react-router-dom'

/**
 * Offensive Rating gauge — circular badge showing 0-100 rating.
 */
function OffensiveRatingBadge({ rating, size = 'md' }) {
  if (rating == null) return null

  const getColor = (r) => {
    if (r >= 70) return { text: 'text-red-600', bg: 'bg-red-50', ring: 'ring-red-200', label: 'Hitter-Friendly' }
    if (r >= 60) return { text: 'text-orange-600', bg: 'bg-orange-50', ring: 'ring-orange-200', label: 'Above Avg' }
    if (r >= 40) return { text: 'text-gray-600', bg: 'bg-gray-50', ring: 'ring-gray-200', label: 'Neutral' }
    if (r >= 30) return { text: 'text-blue-600', bg: 'bg-blue-50', ring: 'ring-blue-200', label: 'Below Avg' }
    return { text: 'text-indigo-700', bg: 'bg-indigo-50', ring: 'ring-indigo-200', label: 'Pitcher-Friendly' }
  }

  const c = getColor(rating)
  const isLg = size === 'lg'

  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className={`${isLg ? 'w-14 h-14' : 'w-11 h-11'} rounded-full ${c.bg} ring-2 ${c.ring} flex items-center justify-center`}>
        <span className={`${isLg ? 'text-xl' : 'text-base'} font-bold ${c.text}`}>{rating}</span>
      </div>
      <span className={`${isLg ? 'text-[11px]' : 'text-[9px]'} font-medium ${c.text}`}>{c.label}</span>
    </div>
  )
}

/**
 * Runs +/- badge — shows predicted extra runs per game.
 */
function RunsPlusMinus({ value }) {
  if (value == null) return <span className="text-gray-400 text-xs">—</span>
  const isPositive = value > 0
  const color = value >= 1 ? 'text-red-600' : value >= 0.3 ? 'text-orange-500' : value > -0.3 ? 'text-gray-600' : value > -1 ? 'text-blue-600' : 'text-indigo-700'
  return (
    <span className={`text-sm font-bold ${color}`}>
      {isPositive ? '+' : ''}{value.toFixed(1)} R/G
    </span>
  )
}

/**
 * Elevation bar — visual indicator of elevation relative to max (~4100ft).
 */
function ElevationBar({ elevation }) {
  const max = 4200
  const pct = Math.min((elevation / max) * 100, 100)
  const color =
    elevation >= 2000 ? 'bg-red-500' :
    elevation >= 1000 ? 'bg-amber-500' :
    elevation >= 500  ? 'bg-yellow-400' :
                        'bg-emerald-400'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-semibold text-gray-700 w-14 text-right">
        {elevation.toLocaleString()}ft
      </span>
    </div>
  )
}

/**
 * Small stat pill used in park cards.
 */
function StatPill({ label, value, unit = '', color = 'gray' }) {
  const bgMap = {
    gray: 'bg-gray-50 text-gray-700',
    blue: 'bg-blue-50 text-blue-700',
    green: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    red: 'bg-red-50 text-red-700',
    teal: 'bg-teal-50 text-teal-700',
  }
  return (
    <div className={`px-2.5 py-1.5 rounded-md ${bgMap[color] || bgMap.gray}`}>
      <div className="text-[10px] uppercase tracking-wider font-medium opacity-70">{label}</div>
      <div className="text-sm font-bold">{value}{unit}</div>
    </div>
  )
}

/**
 * Field dimensions diamond graphic.
 */
function DiamondGraphic({ dimensions }) {
  if (!dimensions || (!dimensions.lf && !dimensions.cf && !dimensions.rf)) {
    return (
      <div className="text-[10px] text-gray-400 italic text-center py-3">
        Dimensions not available
      </div>
    )
  }
  return (
    <div className="relative w-32 h-28 mx-auto">
      <svg viewBox="0 0 120 100" className="w-full h-full">
        <path d="M 10 80 Q 60 5, 110 80" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeDasharray="4 2" />
        <line x1="60" y1="95" x2="10" y2="80" stroke="#9ca3af" strokeWidth="1" />
        <line x1="60" y1="95" x2="110" y2="80" stroke="#9ca3af" strokeWidth="1" />
        <line x1="60" y1="95" x2="60" y2="20" stroke="#9ca3af" strokeWidth="0.5" strokeDasharray="3 3" />
        <circle cx="60" cy="95" r="3" fill="#00687a" />
      </svg>
      {dimensions.lf && (
        <div className="absolute left-0 top-[60%] text-[10px] font-bold text-gray-600">{dimensions.lf}'</div>
      )}
      {dimensions.cf && (
        <div className="absolute left-1/2 -translate-x-1/2 top-1 text-[10px] font-bold text-gray-600">{dimensions.cf}'</div>
      )}
      {dimensions.rf && (
        <div className="absolute right-0 top-[60%] text-[10px] font-bold text-gray-600">{dimensions.rf}'</div>
      )}
    </div>
  )
}

/**
 * Division badge.
 */
function DivisionBadge({ name }) {
  const colorMap = {
    'NCAA Division I': 'bg-red-600', 'NCAA Division II': 'bg-blue-600',
    'NCAA Division III': 'bg-green-600', 'NAIA': 'bg-purple-600', 'JUCO': 'bg-amber-700',
  }
  const bg = colorMap[name] || 'bg-gray-500'
  const short = name?.replace('NCAA ', '') || ''
  return <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded text-white ${bg}`}>{short}</span>
}

/**
 * Surface type badge.
 */
function SurfaceBadge({ surface }) {
  const isNatural = surface?.toLowerCase().includes('natural') || (surface?.toLowerCase().includes('grass') && !surface?.toLowerCase().includes('turf'))
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
      isNatural ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
    }`}>
      {surface || 'Unknown'}
    </span>
  )
}

/**
 * Individual park card — now with offensive rating prominently displayed.
 */
function ParkCard({ park }) {
  const [expanded, setExpanded] = useState(false)

  const precipColor =
    park.annual_precip_in >= 60 ? 'blue' :
    park.annual_precip_in >= 40 ? 'teal' :
    park.annual_precip_in >= 20 ? 'green' : 'amber'

  const tempColor =
    park.march_avg_temp_f >= 47 ? 'green' :
    park.march_avg_temp_f >= 43 ? 'teal' :
    park.march_avg_temp_f >= 39 ? 'amber' : 'blue'

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow">
      {/* Header with offensive rating */}
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Link
              to={`/teams/${park.team_id}`}
              className="text-base font-bold text-gray-800 hover:text-nw-teal transition-colors"
            >
              {park.team_name || park.short_name}
            </Link>
            <div className="text-xs text-gray-500 mt-0.5 truncate">{park.stadium}</div>
            <div className="text-[11px] text-gray-400 mt-0.5">
              {park.city}, {park.state} · {park.climate_zone}
            </div>
            <div className="flex items-center gap-1.5 mt-1.5">
              {park.division_name && <DivisionBadge name={park.division_name} />}
              <SurfaceBadge surface={park.surface} />
            </div>
          </div>
          <OffensiveRatingBadge rating={park.offensive_rating} />
        </div>
      </div>

      {/* Park factor summary */}
      <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
        <div>
          <span className="text-[10px] text-gray-400 uppercase tracking-wider">Predicted Impact</span>
          <div className="flex items-center gap-2">
            <RunsPlusMinus value={park.predicted_runs_plus_minus} />
            {park.park_factor_pct != null && (
              <span className={`text-[10px] font-medium ${park.park_factor_pct >= 0 ? 'text-red-500' : 'text-blue-500'}`}>
                ({park.park_factor_pct >= 0 ? '+' : ''}{park.park_factor_pct}%)
              </span>
            )}
          </div>
        </div>
        <div className="text-right">
          <span className="text-[10px] text-gray-400 uppercase tracking-wider">Air Density</span>
          <div className="text-sm font-semibold text-gray-700">{park.air_density_pct}%</div>
        </div>
        {park.actual_runs_per_game && (
          <div className="text-right">
            <span className="text-[10px] text-gray-400 uppercase tracking-wider">Actual R/G</span>
            <div className="text-sm font-semibold text-gray-700">{park.actual_runs_per_game}</div>
          </div>
        )}
      </div>

      {/* Key stats */}
      <div className="px-4 py-3">
        <div className="mb-2.5">
          <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Elevation</div>
          <ElevationBar elevation={park.elevation_ft} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <StatPill label="March Temp" value={park.march_avg_temp_f || '—'} unit="°F" color={tempColor} />
          <StatPill label="Precip" value={park.annual_precip_in} unit="″" color={precipColor} />
        </div>
      </div>

      {/* Expandable details */}
      <div className="border-t border-gray-100">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-4 py-2 text-[11px] text-gray-500 hover:text-gray-700 hover:bg-gray-50 flex items-center justify-between transition-colors"
        >
          <span>Field details & notes</span>
          <svg
            className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {expanded && (
          <div className="px-4 pb-3 space-y-2">
            <DiamondGraphic dimensions={park.dimensions} />
            {park.dimensions && (park.dimensions.lf || park.dimensions.cf || park.dimensions.rf) && (
              <div className="flex justify-center gap-4 text-[10px] text-gray-500">
                {park.dimensions.lf && <span>LF: {park.dimensions.lf}'</span>}
                {park.dimensions.cf && <span>CF: {park.dimensions.cf}'</span>}
                {park.dimensions.rf && <span>RF: {park.dimensions.rf}'</span>}
              </div>
            )}
            {park.notes && (
              <p className="text-xs text-gray-600 leading-relaxed">{park.notes}</p>
            )}
            {park.conference_name && (
              <div className="text-[10px] text-gray-400">Conference: {park.conference_name}</div>
            )}
            {park.actual_games > 0 && (
              <div className="text-[10px] text-gray-400">Sample: {park.actual_games} games (2026)</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}


/**
 * Summary stats bar at top of page — now with offensive rating highlights.
 */
function SummaryBar({ teams }) {
  const stats = useMemo(() => {
    if (!teams?.length) return null
    const elevations = teams.map(t => t.elevation_ft).filter(Boolean)
    const withRating = teams.filter(t => t.offensive_rating != null)
    const turf = teams.filter(t => {
      const s = (t.surface || '').toLowerCase()
      return !s.includes('natural') && (s.includes('turf') || s.includes('astro') || s.includes('artificial') || s.includes('synthetic') || s.includes('fieldturf'))
    }).length
    const grass = teams.length - turf

    const mostHitterFriendly = withRating.reduce((a, b) => (a.offensive_rating || 0) > (b.offensive_rating || 0) ? a : b, withRating[0])
    const mostPitcherFriendly = withRating.reduce((a, b) => (a.offensive_rating || 100) < (b.offensive_rating || 100) ? a : b, withRating[0])
    const avgRating = Math.round(withRating.reduce((sum, t) => sum + t.offensive_rating, 0) / withRating.length)

    return {
      highest: teams.reduce((a, b) => (a.elevation_ft || 0) > (b.elevation_ft || 0) ? a : b),
      avgElev: Math.round(elevations.reduce((a, b) => a + b, 0) / elevations.length),
      wettest: teams.reduce((a, b) => (a.annual_precip_in || 0) > (b.annual_precip_in || 0) ? a : b),
      driest: teams.reduce((a, b) => (a.annual_precip_in || 999) < (b.annual_precip_in || 999) ? a : b),
      turf, grass, total: teams.length,
      mostHitterFriendly, mostPitcherFriendly, avgRating,
    }
  }, [teams])

  if (!stats) return null

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4">
      <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Regional Overview</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
        <div>
          <div className="text-[10px] text-gray-400 uppercase">Most Hitter-Friendly</div>
          <div className="text-sm font-bold text-red-600">{stats.mostHitterFriendly?.short_name}</div>
          <div className="text-[10px] text-gray-500">Rating: {stats.mostHitterFriendly?.offensive_rating}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400 uppercase">Most Pitcher-Friendly</div>
          <div className="text-sm font-bold text-indigo-600">{stats.mostPitcherFriendly?.short_name}</div>
          <div className="text-[10px] text-gray-500">Rating: {stats.mostPitcherFriendly?.offensive_rating}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400 uppercase">Avg Rating</div>
          <div className="text-sm font-bold text-gray-800">{stats.avgRating}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400 uppercase">Highest Elevation</div>
          <div className="text-sm font-bold text-amber-600">{stats.highest.short_name}</div>
          <div className="text-[10px] text-gray-500">{stats.highest.elevation_ft.toLocaleString()}ft</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400 uppercase">Wettest</div>
          <div className="text-sm font-bold text-blue-600">{stats.wettest.short_name}</div>
          <div className="text-[10px] text-gray-500">{stats.wettest.annual_precip_in}"/yr</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400 uppercase">Driest</div>
          <div className="text-sm font-bold text-amber-600">{stats.driest.short_name}</div>
          <div className="text-[10px] text-gray-500">{stats.driest.annual_precip_in}"/yr</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400 uppercase">Surfaces</div>
          <div className="text-sm font-bold text-gray-800">
            <span className="text-green-600">{stats.grass}</span>{' / '}<span className="text-blue-600">{stats.turf}</span>
          </div>
          <div className="text-[10px] text-gray-500">Grass / Turf</div>
        </div>
      </div>
    </div>
  )
}


/**
 * ParkFactors — main page component.
 */
export default function ParkFactors() {
  const [stateFilter, setStateFilter] = useState('')
  const [divisionFilter, setDivisionFilter] = useState('')
  const [conferenceFilter, setConferenceFilter] = useState('')
  const [sortBy, setSortBy] = useState('rating')
  const [searchQuery, setSearchQuery] = useState('')

  const { data: divisions } = useDivisions()
  const { data: conferences } = useConferences()

  const params = {}
  if (stateFilter) params.state = stateFilter
  if (divisionFilter) params.division_id = parseInt(divisionFilter)
  if (conferenceFilter) params.conference_id = parseInt(conferenceFilter)

  const { data, loading, error } = useParkFactors(params)

  const states = ['WA', 'OR', 'ID', 'MT']

  // Sort and filter teams
  const sortedTeams = useMemo(() => {
    if (!data?.teams) return []
    let teams = [...data.teams]

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      teams = teams.filter(t =>
        (t.team_name || t.short_name || '').toLowerCase().includes(q) ||
        (t.stadium || '').toLowerCase().includes(q) ||
        (t.city || '').toLowerCase().includes(q) ||
        (t.conference_name || '').toLowerCase().includes(q)
      )
    }

    const sortFns = {
      rating: (a, b) => (b.offensive_rating || 50) - (a.offensive_rating || 50),
      rating_asc: (a, b) => (a.offensive_rating || 50) - (b.offensive_rating || 50),
      elevation: (a, b) => (b.elevation_ft || 0) - (a.elevation_ft || 0),
      runs: (a, b) => (b.predicted_runs_plus_minus || 0) - (a.predicted_runs_plus_minus || 0),
      temp: (a, b) => (b.march_avg_temp_f || b.avg_spring_temp_f || 0) - (a.march_avg_temp_f || a.avg_spring_temp_f || 0),
      precip: (a, b) => (b.annual_precip_in || 0) - (a.annual_precip_in || 0),
      name: (a, b) => (a.team_name || a.short_name || '').localeCompare(b.team_name || b.short_name || ''),
    }
    teams.sort(sortFns[sortBy] || sortFns.rating)
    return teams
  }, [data, sortBy, searchQuery])

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-nw-teal border-t-transparent" />
      </div>
    )
  }

  if (error) {
    return <div className="text-center text-red-600 py-10">Error loading park factors: {error}</div>
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Park Factors</h1>
      <p className="text-sm text-gray-500 mb-4">
        Offensive ratings and ballpark characteristics for every PNW college baseball venue. Ratings combine air density physics (elevation + temperature) with actual 2026 run environments.
      </p>

      {/* Summary bar */}
      <SummaryBar teams={data?.teams} />

      {/* Filters and controls */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">Search</label>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Team, stadium, city..."
              className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky focus:border-transparent w-48"
            />
          </div>

          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">State</label>
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
            >
              <option value="">All States</option>
              {states.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">Division</label>
            <select
              value={divisionFilter}
              onChange={(e) => { setDivisionFilter(e.target.value); setConferenceFilter('') }}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
            >
              <option value="">All Levels</option>
              {divisions?.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">Conference</label>
            <select
              value={conferenceFilter}
              onChange={(e) => setConferenceFilter(e.target.value)}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
            >
              <option value="">All Conferences</option>
              {conferences
                ?.filter(c => !divisionFilter || c.division_id === parseInt(divisionFilter))
                .map(c => <option key={c.id} value={c.id}>{c.name}</option>)
              }
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">Sort by</label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
            >
              <option value="rating">Offensive Rating (highest)</option>
              <option value="rating_asc">Offensive Rating (lowest)</option>
              <option value="runs">Predicted Runs +/- (most)</option>
              <option value="elevation">Elevation (highest)</option>
              <option value="temp">March Temp (warmest)</option>
              <option value="precip">Precipitation (wettest)</option>
              <option value="name">Team Name (A-Z)</option>
            </select>
          </div>

          <button
            onClick={() => { setStateFilter(''); setDivisionFilter(''); setConferenceFilter(''); setSortBy('rating'); setSearchQuery('') }}
            className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 rounded hover:bg-gray-100"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Results count */}
      <div className="text-xs text-gray-400 mb-3">
        Showing {sortedTeams.length} of {data?.total || 0} ballparks
      </div>

      {/* Park cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {sortedTeams.map(park => (
          <ParkCard key={park.team_id} park={park} />
        ))}
      </div>

      {sortedTeams.length === 0 && (
        <div className="text-center text-gray-400 py-10">
          No ballparks match the current filters.
        </div>
      )}

      {/* Methodology explanation */}
      {data?.park_factor_methodology && (
        <div className="mt-6 bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">
            Methodology
          </h2>
          <p className="text-xs text-gray-600 leading-relaxed mb-3">
            {data.park_factor_methodology.description}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-gray-600 leading-relaxed">
            <div>
              <h3 className="font-semibold text-gray-700 mb-1">Air Density Model</h3>
              <p>{data.park_factor_methodology.components?.air_density_model}</p>
            </div>
            <div>
              <h3 className="font-semibold text-gray-700 mb-1">Actual Run Environment</h3>
              <p>{data.park_factor_methodology.components?.actual_run_environment}</p>
            </div>
            <div>
              <h3 className="font-semibold text-gray-700 mb-1">Blending</h3>
              <p>{data.park_factor_methodology.components?.blending}</p>
            </div>
            <div>
              <h3 className="font-semibold text-gray-700 mb-1">Limitations</h3>
              <ul className="list-disc list-inside space-y-0.5">
                {data.park_factor_methodology.limitations?.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* How factors affect play */}
      {data?.qualification_notes && (
        <div className="mt-4 bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">
            How Park Factors Affect Play
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-gray-600 leading-relaxed">
            <div>
              <h3 className="font-semibold text-gray-700 mb-1">Elevation</h3>
              <p>{data.qualification_notes.elevation_impact}</p>
            </div>
            <div>
              <h3 className="font-semibold text-gray-700 mb-1">Precipitation</h3>
              <p>{data.qualification_notes.precipitation_impact}</p>
            </div>
            <div>
              <h3 className="font-semibold text-gray-700 mb-1">Temperature</h3>
              <p>{data.qualification_notes.temperature_impact}</p>
            </div>
            <div>
              <h3 className="font-semibold text-gray-700 mb-1">Wind</h3>
              <p>{data.qualification_notes.wind_impact}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
