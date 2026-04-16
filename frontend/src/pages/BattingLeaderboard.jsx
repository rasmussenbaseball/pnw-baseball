import { useState } from 'react'
import FilterBar from '../components/FilterBar'
import StatsTable from '../components/StatsTable'
import StatPresetBar from '../components/StatPresetBar'
import StatsLastUpdated from '../components/StatsLastUpdated'
import { useBattingLeaderboard, useDivisions, useConferences } from '../hooks/useApi'
import { BATTING_COLUMNS, BATTING_PRESETS } from '../utils/stats'
import { usePersistedState } from '../hooks/usePersistedState'

export default function BattingLeaderboard() {
  const [filters, setFilters] = usePersistedState('bat_lb_filters', {
    season: 2026,
    min_pa: 50,
    _type: 'batting',
  })
  const [sortBy, setSortBy] = usePersistedState('bat_lb_sortBy', 'batting_avg')
  const [sortDir, setSortDir] = usePersistedState('bat_lb_sortDir', 'desc')
  const [preset, setPreset] = usePersistedState('bat_lb_preset', 'Standard')
  const [page, setPage] = useState(0)
  const limit = 50

  const { data: divisions } = useDivisions()
  const { data: conferences } = useConferences()

  const apiParams = {
    season: filters.season,
    division_id: filters.division_id,
    conference_id: filters.conference_id,
    state: filters.state,
    min_pa: filters.min_pa || 0,
    qualified: filters.qualified || false,
    conference_only: filters.conference_only || false,
    year_in_school: filters.year_in_school,
    position_group: filters.position_group,
    sort_by: sortBy,
    sort_dir: sortDir,
    limit,
    offset: page * limit,
  }

  const { data: result, loading } = useBattingLeaderboard(apiParams)

  const handleSort = (key, dir) => {
    setSortBy(key)
    setSortDir(dir)
    setPage(0)
  }

  return (
    <div>
      <h1 className="text-lg sm:text-2xl font-bold text-pnw-slate mb-3 sm:mb-4">Hitting Leaders</h1>

      <FilterBar
        filters={filters}
        onChange={(f) => { setFilters(f); setPage(0) }}
        divisions={divisions}
        conferences={conferences}
      />

      <StatPresetBar
        presets={BATTING_PRESETS}
        activePreset={preset}
        onSelect={setPreset}
      />

      <StatsLastUpdated className="mb-2" />

      <StatsTable
        data={result?.data || []}
        columns={BATTING_COLUMNS}
        visibleColumns={BATTING_PRESETS[preset]}
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
