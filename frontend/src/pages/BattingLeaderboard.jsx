import { useState } from 'react'
import FilterBar from '../components/FilterBar'
import StatsTable from '../components/StatsTable'
import StatPresetBar from '../components/StatPresetBar'
import { useBattingLeaderboard, useSummerBattingLeaderboard, useDivisions, useConferences, useSummerLeagues, useSummerTeams } from '../hooks/useApi'
import { BATTING_COLUMNS, BATTING_PRESETS, SUMMER_BATTING_COLUMNS, SUMMER_BATTING_PRESETS } from '../utils/stats'

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
        value={filters.min_pa || 0}
        onChange={(e) => onChange({ ...filters, min_pa: Number(e.target.value) })}
        className="border rounded px-2 py-1"
      >
        <option value={0}>No Min PA</option>
        <option value={25}>25+ PA</option>
        <option value={50}>50+ PA</option>
        <option value={75}>75+ PA</option>
        <option value={100}>100+ PA</option>
      </select>
    </div>
  )
}

export default function BattingLeaderboard() {
  const [mode, setMode] = useState('spring')
  const [filters, setFilters] = useState({
    season: 2026,
    min_pa: 50,
    _type: 'batting',
  })
  const [summerFilters, setSummerFilters] = useState({
    season: 2025,
    min_pa: 50,
    league: null,
    team_id: null,
  })
  const [sortBy, setSortBy] = useState('batting_avg')
  const [sortDir, setSortDir] = useState('desc')
  const [preset, setPreset] = useState('Standard')
  const [page, setPage] = useState(0)
  const limit = 50

  const { data: divisions } = useDivisions()
  const { data: conferences } = useConferences()
  const { data: summerLeagues } = useSummerLeagues()
  const { data: summerTeams } = useSummerTeams(summerFilters.league)

  // Spring API params
  const springApiParams = {
    season: filters.season,
    division_id: filters.division_id,
    conference_id: filters.conference_id,
    state: filters.state,
    min_pa: filters.min_pa || 0,
    qualified: filters.qualified || false,
    year_in_school: filters.year_in_school,
    position_group: filters.position_group,
    sort_by: sortBy,
    sort_dir: sortDir,
    limit,
    offset: page * limit,
  }

  // Summer API params
  const summerApiParams = {
    season: summerFilters.season,
    league: summerFilters.league,
    team_id: summerFilters.team_id,
    min_pa: summerFilters.min_pa || 0,
    sort_by: sortBy,
    sort_dir: sortDir,
    limit,
    offset: page * limit,
  }

  const { data: springResult, loading: springLoading } = useBattingLeaderboard(
    mode === 'spring' ? springApiParams : { season: 2026, limit: 1 }
  )
  const { data: summerResult, loading: summerLoading } = useSummerBattingLeaderboard(
    mode === 'summer' ? summerApiParams : { season: 2025, limit: 1 }
  )

  const result = mode === 'spring' ? springResult : summerResult
  const loading = mode === 'spring' ? springLoading : summerLoading
  const columns = mode === 'spring' ? BATTING_COLUMNS : SUMMER_BATTING_COLUMNS
  const presets = mode === 'spring' ? BATTING_PRESETS : SUMMER_BATTING_PRESETS

  const handleSort = (key, dir) => {
    setSortBy(key)
    setSortDir(dir)
    setPage(0)
  }

  const handleModeChange = (newMode) => {
    setMode(newMode)
    setPage(0)
    setPreset('Standard')
    setSortBy('batting_avg')
    setSortDir('desc')
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-3 sm:mb-4">
        <h1 className="text-lg sm:text-2xl font-bold text-pnw-slate">Hitting Leaders</h1>
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
        onSelect={setPreset}
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

      {/* Pagination */}
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
