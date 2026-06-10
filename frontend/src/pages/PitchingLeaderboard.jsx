import { useState } from 'react'
import FilterBar from '../components/FilterBar'
import StatsTable from '../components/StatsTable'
import StatPresetBar from '../components/StatPresetBar'
import StatsLastUpdated from '../components/StatsLastUpdated'
import ExportCSVButton from '../components/ExportCSVButton'
import {
  usePitchingLeaderboard, usePitchingPbpLeaderboard,
  useDivisions, useConferences,
} from '../hooks/useApi'
import {
  PITCHING_COLUMNS, PITCHING_PRESETS, PITCHING_PRESET_FILTERS,
  PITCHING_PBP_COLUMNS, PITCHING_PBP_PRESETS,
} from '../utils/stats'
import { usePersistedState } from '../hooks/usePersistedState'
import { CURRENT_SEASON } from '../lib/seasons'

// PBP lives inside the View: pill bar as another preset alongside
// Standard / Advanced / Strikeouts / Relievers.
const ALL_PRESETS = { ...PITCHING_PRESETS, PBP: PITCHING_PBP_PRESETS.PBP }

export default function PitchingLeaderboard() {
  const [filters, setFilters] = usePersistedState('pit_lb_filters', {
    season: CURRENT_SEASON,
    min_ip: 20,
    _type: 'pitching',
  })
  const [sortBy, setSortBy] = usePersistedState('pit_lb_sortBy', 'era')
  const [sortDir, setSortDir] = usePersistedState('pit_lb_sortDir', 'asc')
  const [pbpSortBy, setPbpSortBy] = usePersistedState('pit_lb_pbp_sortBy', 'strike_pct')
  const [pbpSortDir, setPbpSortDir] = usePersistedState('pit_lb_pbp_sortDir', 'desc')
  const [preset, setPreset] = usePersistedState('pit_lb_preset', 'Standard')
  const [page, setPage] = useState(0)
  const limit = 50

  const { data: divisions } = useDivisions()
  const { data: conferences } = useConferences()

  // A previously-persisted preset that no longer exists (we retired the
  // "Relievers" view in favor of the dedicated /relievers page) falls
  // back to Standard so the table never renders with undefined columns.
  const effectivePreset = ALL_PRESETS[preset] ? preset : 'Standard'

  const isPbp = effectivePreset === 'PBP'

  const presetFilters = PITCHING_PRESET_FILTERS[effectivePreset] || {}

  const apiParams = {
    season: filters.season,
    division_id: filters.division_id,
    conference_id: filters.conference_id,
    state: filters.state,
    min_ip: filters.min_ip || 0,
    qualified: filters.qualified || false,
    conference_only: filters.conference_only || false,
    year_in_school: filters.year_in_school,
    sort_by: sortBy,
    sort_dir: sortDir,
    limit,
    offset: page * limit,
    ...presetFilters,
  }

  const pbpParams = {
    season: filters.season,
    division_id: filters.division_id,
    conference_id: filters.conference_id,
    state: filters.state,
    year_in_school: filters.year_in_school,
    min_bf: filters.pbp_min_bf ?? 40,
    sort_by: pbpSortBy,
    sort_dir: pbpSortDir,
    limit,
    offset: page * limit,
  }

  const standardResp = usePitchingLeaderboard(apiParams)
  const pbpResp = usePitchingPbpLeaderboard(pbpParams)
  const { data: result, loading } = isPbp ? pbpResp : standardResp

  const handleSort = (key, dir) => {
    if (isPbp) { setPbpSortBy(key); setPbpSortDir(dir) }
    else { setSortBy(key); setSortDir(dir) }
    setPage(0)
  }

  const handlePresetChange = (p) => {
    setPreset(p)
    setPage(0)
  }

  const columns = isPbp ? PITCHING_PBP_COLUMNS : PITCHING_COLUMNS
  const visibleCols = ALL_PRESETS[effectivePreset]
  const sortKey = isPbp ? pbpSortBy : sortBy
  const sortDirVal = isPbp ? pbpSortDir : sortDir
  const exportEndpoint = isPbp ? '/api/v1/leaderboards/pitching-pbp'
                               : '/api/v1/leaderboards/pitching'
  const exportParams = isPbp ? pbpParams : apiParams

  return (
    <div>
      <h1 className="text-lg sm:text-2xl font-bold text-nw-teal dark:text-gray-100 mb-3 sm:mb-4">Pitching Leaders</h1>

      <FilterBar
        filters={filters}
        onChange={(f) => { setFilters(f); setPage(0) }}
        divisions={divisions}
        conferences={conferences}
      />

      <StatPresetBar
        presets={ALL_PRESETS}
        activePreset={preset}
        onSelect={handlePresetChange}
      />

      <div className="mb-2 flex items-center justify-between gap-2">
        <StatsLastUpdated />
        <ExportCSVButton
          data={result?.data || []}
          columns={columns}
          filename={`nwbb_pitching_${isPbp ? 'pbp_' : ''}${filters.season}`}
          fetchAll={async () => {
            const qs = new URLSearchParams({
              ...Object.fromEntries(
                Object.entries(exportParams).filter(([, v]) =>
                  v !== undefined && v !== null && v !== ''
                )
              ),
              limit: 10000,
              offset: 0,
            })
            const r = await fetch(`${exportEndpoint}?${qs}`)
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            const j = await r.json()
            return j.data || []
          }}
        />
      </div>

      <StatsTable
        data={result?.data || []}
        columns={columns}
        visibleColumns={visibleCols}
        sortBy={sortKey}
        sortDir={sortDirVal}
        onSort={handleSort}
        loading={loading}
        offset={page * limit}
      />

      {result && result.total > limit && (
        <div className="flex justify-between items-center mt-3 sm:mt-4 text-xs sm:text-sm text-gray-600 dark:text-gray-400">
          <span>
            {page * limit + 1}-{Math.min((page + 1) * limit, result.total)} of {result.total}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1 rounded border disabled:opacity-50 hover:bg-gray-100 dark:hover:bg-gray-700 dark:border-gray-600"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={(page + 1) * limit >= result.total}
              className="px-3 py-1 rounded border disabled:opacity-50 hover:bg-gray-100 dark:hover:bg-gray-700 dark:border-gray-600"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
