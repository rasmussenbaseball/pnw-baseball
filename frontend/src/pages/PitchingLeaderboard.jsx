import { useState } from 'react'
import FilterBar from '../components/FilterBar'
import StatsTable from '../components/StatsTable'
import StatPresetBar from '../components/StatPresetBar'
import { usePitchingLeaderboard, useSummerPitchingLeaderboard, useDivisions, useConferences, useSummerLeagues, useSummerTeams } from '../hooks/useApi'
import { PITCHING_COLUMNS, PITCHING_PRESETS, PITCHING_PRESET_FILTERS, SUMMER_PITCHING_COLUMNS, SUMMER_PITCHING_PRESETS } from '../utils/stats'

function SeasonToggle({ mode, onChange }) {
  return (
    <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-sm mb-3">
      <button
        onClick={() => onChange('spring')}
        className={`px-4 py-1.5 font-medium transition-colors ${
          mode === 'spring'
            ? 'bg-pnw-blue text-white'
            : 'bg-white text-gray-600 hover:bg-gray-50'
        }`}
      >
        Spring
      </button>
      <button
        onClick={() => onChange('summer')}
        className={`px-4 py-1.5 font-medium transition-colors ${
          mode === 'summer'
            ? 'bg-pnw-blue text-white'
            : 'bg-white text-gray-600 hover:bg-gray-50'
        }`}
      >
        Summer
      </button>
    </div>
  )
}

function SummerFilterBar({ filters, onChange, leagues, teams }) {
  return (
    <div className="flex flex-wrap gap-2 mb-3 text-xs sm:text-sm">
      <select
        value={filters.season || 2025}
        onChange={(e) => onChange({ ...filters, season: Number(e.target.value) })}
        className="border rounded px-2 py-1"
      >
        {[2025, 2024, 2023, 2022, 2021, 2019].map(y => (
          <option key={y} value={y}>{y}</option>
        ))}
      </select>
      <select
        value={filters.league || ''}
        onChange={(e) => onChange({ ...filters, league: e.target.value || null, team_id: null })}
        className="border rounded px-2 py-1"
      >
        <option value="">All Leagues</option>
        {(leagues || []).map(l => (
          <option key={l.abbreviation} value={l.abbreviation}>{l.name}</option>
        ))}
      </select>
      <select
        value={filters.team_id || ''}
        onChange={(e) => onChange({ ...filters, team_id: e.target.value ? Number(e.target.value) : null })}
        className="border rounded px-2 py-1"
      >
        <option value="">All Teams</option>
        {(teams || []).map(t => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      <select
        value={filters.min_ip || 0}
        onChange={(e) => onChange({ ...filters, min_ip: Number(e.target.value) })}
        className="border rounded px-2 py-1"
      >
        <option value={0}>No Min IP</option>
        <option value={10}>10+ IP</option>
        <option value={20}>20+ IP</option>
        <option value={30}>30+ IP</option>
        <option value={50}>50+ IP</option>
      </select>
    </div>
  )
}

export default function PitchingLeaderboard() {
  const [mode, setMode] = useState('spring')
  const [filters, setFilters] = useState({
    season: 2026,
    min_ip: 20,
    _type: 'pitching',
  })
  const [summerFilters, setSummerFilters] = useState({
    season: 2025,
    min_ip: 10,
    league: null,
    team_id: null,
  })
  const [sortBy, setSortBy] = useState('era')
  const [sortDir, setSortDir] = useState('asc')
  const [preset, setPreset] = useState('Standard')
  const [page, setPage] = useState(0)
  const limit = 50

  const { data: divisions } = useDivisions()
  const { data: conferences } = useConferences()
  const { data: summerLeagues } = useSummerLeagues()
  const { data: summerTeams } = useSummerTeams(summerFilters.league)

  // Some presets apply extra backend filters (e.g. Relievers → max_gs=0)
  const presetFilters = PITCHING_PRESET_FILTERS[preset] || {}

  const springApiParams = {
    season: filters.season,
    division_id: filters.division_id,
    conference_id: filters.conference_id,
    state: filters.state,
    min_ip: filters.min_ip || 0,
    qualified: filters.qualified || false,
    year_in_school: filters.year_in_school,
    sort_by: sortBy,
    sort_dir: sortDir,
    limit,
    offset: page * limit,
    ...presetFilters,
  }

  const summerApiParams = {
    season: summerFilters.season,
    league: summerFilters.league,
    team_id: summerFilters.team_id,
    min_ip: summerFilters.min_ip || 0,
    sort_by: sortBy,
    sort_dir: sortDir,
    limit,
    offset: page * limit,
  }

  const { data: springResult, loading: springLoading } = usePitchingLeaderboard(
    mode === 'spring' ? springApiParams : { season: 2026, limit: 1 }
  )
  const { data: summerResult, loading: summerLoading } = useSummerPitchingLeaderboard(
    mode === 'summer' ? summerApiParams : { season: 2025, limit: 1 }
  )

  const result = mode === 'spring' ? springResult : summerResult
  const loading = mode === 'spring' ? springLoading : summerLoading
  const columns = mode === 'spring' ? PITCHING_COLUMNS : SUMMER_PITCHING_COLUMNS
  const presets = mode === 'spring' ? PITCHING_PRESETS : SUMMER_PITCHING_PRESETS

  const handleSort = (key, dir) => {
    setSortBy(key)
    setSortDir(dir)
    setPage(0)
  }

  const handleModeChange = (newMode) => {
    setMode(newMode)
    setPage(0)
    setPreset('Standard')
    setSortBy('era')
    setSortDir('asc')
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-3 sm:mb-4">
        <h1 className="text-lg sm:text-2xl font-bold text-pnw-slate">Pitching Leaders</h1>
        <SeasonToggle mode={mode} onChange={handleModeChange} />
      </div>

      {mode === 'spring' ? (
        <FilterBar
          filters={filters}
          onChange={(f) => { setFilters(f); setPage(0) }}
          divisions={divisions}
          conferences={conferences}
        />
      ) : (
        <SummerFilterBar
          filters={summerFilters}
          onChange={(f) => { setSummerFilters(f); setPage(0) }}
          leagues={summerLeagues}
          teams={summerTeams}
        />
      )}

      <StatPresetBar
        presets={presets}
        activePreset={preset}
        onSelect={(p) => { setPreset(p); setPage(0) }}
      />

      <StatsTable
        data={result?.data || []}
        columns={columns}
        visibleColumns={presets[preset]}
        sortBy={sortBy}
        sortDir={sortDir}
        onSort={handleSort}
        loading={loading}
        offset={page * limit}
      />

      {result && result.total > limit && (
        <div className="flex justify-between items-center mt-3 sm:mt-4 text-xs sm:text-sm text-gray-600">
          <span>
            {page * limit + 1}-{Math.min((page + 1) * limit, result.total)} of {result.total}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1 rounded border disabled:opacity-50 hover:bg-gray-100"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={(page + 1) * limit >= result.total}
              className="px-3 py-1 rounded border disabled:opacity-50 hover:bg-gray-100"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
