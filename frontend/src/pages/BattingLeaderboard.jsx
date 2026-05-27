import { useState } from 'react'
import FilterBar from '../components/FilterBar'
import StatsTable from '../components/StatsTable'
import StatPresetBar from '../components/StatPresetBar'
import StatsLastUpdated from '../components/StatsLastUpdated'
import ExportCSVButton from '../components/ExportCSVButton'
import {
  useBattingLeaderboard, useBattingPbpLeaderboard,
  useDivisions, useConferences,
} from '../hooks/useApi'
import {
  BATTING_COLUMNS, BATTING_PRESETS,
  BATTING_PBP_COLUMNS, BATTING_PBP_PRESETS,
} from '../utils/stats'
import { usePersistedState } from '../hooks/usePersistedState'

export default function BattingLeaderboard() {
  const [filters, setFilters] = usePersistedState('bat_lb_filters', {
    season: 2026,
    min_pa: 50,
    _type: 'batting',
  })
  // statView: 'standard' (existing leaderboard) or 'pbp' (plate-discipline).
  // The PBP view sources from a separate endpoint, uses a different column
  // set, and has its own sort defaults — but reuses the same filter bar.
  const [statView, setStatView] = usePersistedState('bat_lb_statView', 'standard')
  const [sortBy, setSortBy] = usePersistedState('bat_lb_sortBy', 'batting_avg')
  const [sortDir, setSortDir] = usePersistedState('bat_lb_sortDir', 'desc')
  const [pbpSortBy, setPbpSortBy] = usePersistedState('bat_lb_pbp_sortBy', 'whiff_pct')
  const [pbpSortDir, setPbpSortDir] = usePersistedState('bat_lb_pbp_sortDir', 'asc')
  const [preset, setPreset] = usePersistedState('bat_lb_preset', 'Standard')
  const [page, setPage] = useState(0)
  const limit = 50

  const { data: divisions } = useDivisions()
  const { data: conferences } = useConferences()

  const isPbp = statView === 'pbp'

  // ── Params for the standard endpoint ──
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

  // ── Params for the PBP endpoint ──
  // PBP doesn't expose conference_only / qualified / position_group; it
  // uses min_pa as a tracked-PA floor (default 30) with its own sort
  // defaults pointing at whiff%.
  const pbpParams = {
    season: filters.season,
    division_id: filters.division_id,
    conference_id: filters.conference_id,
    state: filters.state,
    year_in_school: filters.year_in_school,
    min_pa: filters.pbp_min_pa ?? 30,
    sort_by: pbpSortBy,
    sort_dir: pbpSortDir,
    limit,
    offset: page * limit,
  }

  // Always call both hooks (React rules: hook order can't change between
  // renders). The inactive one fires a cheap cached fetch in the
  // background — backend caches batting endpoints for 30 minutes.
  const standardResp = useBattingLeaderboard(apiParams)
  const pbpResp = useBattingPbpLeaderboard(pbpParams)
  const { data: result, loading } = isPbp ? pbpResp : standardResp

  const handleSort = (key, dir) => {
    if (isPbp) { setPbpSortBy(key); setPbpSortDir(dir) }
    else { setSortBy(key); setSortDir(dir) }
    setPage(0)
  }

  const columns = isPbp ? BATTING_PBP_COLUMNS : BATTING_COLUMNS
  const presets = isPbp ? BATTING_PBP_PRESETS : BATTING_PRESETS
  const activePreset = isPbp ? 'PBP' : preset
  const sortKey = isPbp ? pbpSortBy : sortBy
  const sortDirVal = isPbp ? pbpSortDir : sortDir
  const exportEndpoint = isPbp ? '/api/v1/leaderboards/batting-pbp'
                               : '/api/v1/leaderboards/batting'
  const exportParams = isPbp ? pbpParams : apiParams

  return (
    <div>
      <h1 className="text-lg sm:text-2xl font-bold text-pnw-slate mb-3 sm:mb-4">Hitting Leaders</h1>

      <FilterBar
        filters={filters}
        onChange={(f) => { setFilters(f); setPage(0) }}
        divisions={divisions}
        conferences={conferences}
      />

      {/* Stat-source toggle: Standard vs PBP */}
      <div className="mb-3 inline-flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden text-sm">
        <button
          onClick={() => { setStatView('standard'); setPage(0) }}
          className={`px-3 sm:px-4 py-1.5 font-medium transition ${
            !isPbp
              ? 'bg-nw-teal text-white'
              : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}
        >
          Standard Stats
        </button>
        <button
          onClick={() => { setStatView('pbp'); setPage(0) }}
          title="Plate discipline & pitch-level stats from per-PA play-by-play"
          className={`px-3 sm:px-4 py-1.5 font-medium transition ${
            isPbp
              ? 'bg-nw-teal text-white'
              : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}
        >
          PBP
        </button>
      </div>

      {!isPbp && (
        <StatPresetBar
          presets={BATTING_PRESETS}
          activePreset={preset}
          onSelect={setPreset}
        />
      )}

      <div className="mb-2 flex items-center justify-between gap-2">
        <StatsLastUpdated />
        <ExportCSVButton
          data={result?.data || []}
          columns={columns}
          filename={`nwbb_hitting_${isPbp ? 'pbp_' : ''}${filters.season}`}
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
        visibleColumns={presets[activePreset]}
        sortBy={sortKey}
        sortDir={sortDirVal}
        onSort={handleSort}
        loading={loading}
        offset={page * limit}
      />

      {/* Pagination */}
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
