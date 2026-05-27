// FieldingLeaderboard — top defenders by division/conference/position
// with sortable columns and the existing CSV-export tier gate.
//
// Two filter "layers":
//   1. Position pill bar (Any / P / C / 1B / 2B / 3B / SS / LF / CF / RF)
//      — controls which row per player is included.
//   2. View preset pill bar (Standard / Catcher / Advanced) — controls
//      which columns are shown.
//
// Selecting Position=C auto-bumps the preset to Catcher (so PB/SBA/CS/CS%
// jump into view) unless the user has explicitly picked something else.

import { useState, useEffect } from 'react'
import FilterBar from '../components/FilterBar'
import StatsTable from '../components/StatsTable'
import StatPresetBar from '../components/StatPresetBar'
import StatsLastUpdated from '../components/StatsLastUpdated'
import ExportCSVButton from '../components/ExportCSVButton'
import { useFieldingLeaderboard, useDivisions, useConferences } from '../hooks/useApi'
import {
  FIELDING_COLUMNS, FIELDING_PRESETS, FIELDING_POSITIONS,
} from '../utils/stats'
import { usePersistedState } from '../hooks/usePersistedState'

export default function FieldingLeaderboard() {
  const [filters, setFilters] = usePersistedState('fld_lb_filters', {
    season: 2026,
    min_games: 10,
    _type: 'fielding',
  })
  const [position, setPosition] = usePersistedState('fld_lb_position', '')
  const [sortBy, setSortBy] = usePersistedState('fld_lb_sortBy', 'fielding_pct')
  const [sortDir, setSortDir] = usePersistedState('fld_lb_sortDir', 'desc')
  const [preset, setPreset] = usePersistedState('fld_lb_preset', 'Standard')
  // Tracks whether the user has manually picked a preset. Lets us
  // auto-swap to "Catcher" view on a position=C pick without ever
  // overriding their explicit choice.
  const [presetTouched, setPresetTouched] = useState(false)
  const [page, setPage] = useState(0)
  const limit = 50

  const { data: divisions } = useDivisions()
  const { data: conferences } = useConferences()

  // Auto-swap preset to Catcher when user picks position=C (and they
  // haven't already chosen a preset by hand).
  useEffect(() => {
    if (presetTouched) return
    if (position === 'C' && preset !== 'Catcher') setPreset('Catcher')
    else if (position !== 'C' && preset === 'Catcher') setPreset('Standard')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position])

  const apiParams = {
    season: filters.season,
    position,
    division_id: filters.division_id,
    conference_id: filters.conference_id,
    state: filters.state,
    year_in_school: filters.year_in_school,
    min_games: filters.min_games || 0,
    min_chances: filters.min_chances || 0,
    sort_by: sortBy,
    sort_dir: sortDir,
    limit,
    offset: page * limit,
  }

  const { data: result, loading } = useFieldingLeaderboard(apiParams)

  const handleSort = (key, dir) => {
    setSortBy(key)
    setSortDir(dir)
    setPage(0)
  }

  const handlePresetChange = (p) => {
    setPreset(p)
    setPresetTouched(true)
    setPage(0)
  }

  const handlePositionChange = (p) => {
    setPosition(p)
    setPage(0)
  }

  const visibleCols = FIELDING_PRESETS[preset]

  return (
    <div>
      <h1 className="text-lg sm:text-2xl font-bold text-pnw-slate dark:text-gray-100 mb-3 sm:mb-4">
        Fielding Leaders
      </h1>

      <FilterBar
        filters={filters}
        onChange={(f) => { setFilters(f); setPage(0) }}
        divisions={divisions}
        conferences={conferences}
      />

      {/* Position pill bar — primary discriminator. Drives which
          single row per player gets returned. */}
      <div className="mb-3 -mx-2 sm:mx-0 px-2 sm:px-0 overflow-x-auto">
        <div className="flex items-center gap-1.5 min-w-min">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mr-1 shrink-0">
            Position
          </span>
          {FIELDING_POSITIONS.map((p) => (
            <button
              key={p.value || 'any'}
              onClick={() => handlePositionChange(p.value)}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold whitespace-nowrap transition-colors ${
                position === p.value
                  ? 'bg-nw-teal text-white'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <StatPresetBar
        presets={FIELDING_PRESETS}
        activePreset={preset}
        onSelect={handlePresetChange}
      />

      <div className="mb-2 flex items-center justify-between gap-2">
        <StatsLastUpdated />
        <ExportCSVButton
          data={result?.data || []}
          columns={FIELDING_COLUMNS}
          filename={`nwbb_fielding_${position || 'any'}_${filters.season}`}
          fetchAll={async () => {
            const qs = new URLSearchParams({
              ...Object.fromEntries(
                Object.entries(apiParams).filter(([, v]) =>
                  v !== undefined && v !== null && v !== ''
                )
              ),
              limit: 10000,
              offset: 0,
            })
            const r = await fetch(`/api/v1/leaderboards/fielding?${qs}`)
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            const j = await r.json()
            return j.data || []
          }}
        />
      </div>

      <StatsTable
        data={result?.data || []}
        columns={FIELDING_COLUMNS}
        visibleColumns={visibleCols}
        sortBy={sortBy}
        sortDir={sortDir}
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
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1 rounded border disabled:opacity-50 hover:bg-gray-100 dark:hover:bg-gray-700 dark:border-gray-600"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
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
