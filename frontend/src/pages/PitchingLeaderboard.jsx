import { useState } from 'react'
import FilterBar from '../components/FilterBar'
import StatsTable from '../components/StatsTable'
import StatPresetBar from '../components/StatPresetBar'
import StatsLastUpdated from '../components/StatsLastUpdated'
import { usePitchingLeaderboard, useDivisions, useConferences } from '../hooks/useApi'
import { PITCHING_COLUMNS, PITCHING_PRESETS, PITCHING_PRESET_FILTERS } from '../utils/stats'
import { usePersistedState } from '../hooks/usePersistedState'

export default function PitchingLeaderboard() {
  const [filters, setFilters] = usePersistedState('pit_lb_filters', {
    season: 2026,
    min_ip: 20,
    _type: 'pitching',
  })
  const [sortBy, setSortBy] = usePersistedState('pit_lb_sortBy', 'era')
  const [sortDir, setSortDir] = usePersistedState('pit_lb_sortDir', 'asc')
  const [preset, setPreset] = usePersistedState('pit_lb_preset', 'Standard')
  const [page, setPage] = useState(0)
  const limit = 50

  const { data: divisions } = useDivisions()
  const { data: conferences } = useConferences()

  // Some presets apply extra backend filters (e.g. Relievers → max_gs=0)
  const presetFilters = PITCHING_PRESET_FILTERS[preset] || {}

  const apiParams = {
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

  const { data: result, loading } = usePitchingLeaderboard(apiParams)

  const handleSort = (key, dir) => {
    setSortBy(key)
    setSortDir(dir)
    setPage(0)
  }

  return (
    <div>
      <h1 className="text-lg sm:text-2xl font-bold text-pnw-slate mb-3 sm:mb-4">Pitching Leaders</h1>

      <FilterBar
        filters={filters}
        onChange={(f) => { setFilters(f); setPage(0) }}
        divisions={divisions}
        conferences={conferences}
      />

      <StatPresetBar
        presets={PITCHING_PRESETS}
        activePreset={preset}
        onSelect={(p) => { setPreset(p); setPage(0) }}
      />

      <StatsLastUpdated className="mb-2" />

      <StatsTable
        data={result?.data || []}
        columns={PITCHING_COLUMNS}
        visibleColumns={PITCHING_PRESETS[preset]}
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
