// RelieverLeaderboard — bullpen leaders from play-by-play.
//   /relievers
//
// The relief-role companion to the Pitching leaderboard. Headlines are
// Goose Eggs (clean high-leverage innings) and reliever WPA, with broken
// eggs + goose opportunities so the board rewards quality, not usage.
// Spring only (D1-NAIA) — the stats come from game_events, which carries
// the base/out/score state + WPA that summer PBP doesn't have yet.

import { useState } from 'react'
import FilterBar from '../components/FilterBar'
import StatsTable from '../components/StatsTable'
import StatPresetBar from '../components/StatPresetBar'
import StatsLastUpdated from '../components/StatsLastUpdated'
import ExportCSVButton from '../components/ExportCSVButton'
import InternCredit from '../components/InternCredit'
import { useRelieverLeaderboard, useDivisions, useConferences } from '../hooks/useApi'
import { RELIEVER_COLUMNS, RELIEVER_PRESETS } from '../utils/stats'
import { usePersistedState } from '../hooks/usePersistedState'
import { CURRENT_SEASON } from '../lib/seasons'

export default function RelieverLeaderboard() {
  const [filters, setFilters] = usePersistedState('rel_lb_filters', {
    season: CURRENT_SEASON,
    min_bf: 20,
    _type: 'pitching',
  })
  const [sortBy, setSortBy] = usePersistedState('rel_lb_sortBy', 'wpa')
  const [sortDir, setSortDir] = usePersistedState('rel_lb_sortDir', 'desc')
  const [preset, setPreset] = usePersistedState('rel_lb_preset', 'Clutch')
  const [page, setPage] = useState(0)
  const limit = 50

  const { data: divisions } = useDivisions()
  const { data: conferences } = useConferences()

  const apiParams = {
    season: filters.season,
    division_id: filters.division_id,
    conference_id: filters.conference_id,
    state: filters.state,
    year_in_school: filters.year_in_school,
    min_bf: filters.min_bf || 20,
    sort_by: sortBy,
    sort_dir: sortDir,
    limit,
    offset: page * limit,
  }

  const { data: result, loading } = useRelieverLeaderboard(apiParams)

  const handleSort = (key, dir) => {
    setSortBy(key)
    setSortDir(dir)
    setPage(0)
  }

  const visibleCols = RELIEVER_PRESETS[preset]

  return (
    <div>
      <h1 className="text-lg sm:text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">
        Reliever Leaders
      </h1>
      <p className="text-xs sm:text-sm text-gray-600 dark:text-gray-400 mb-3 max-w-3xl">
        Bullpen value from play-by-play. <span className="font-semibold">Goose Eggs (GEG)</span> reward
        clean high-leverage innings (7th or later, team not trailing, with the lead small or the tying run on base);
        <span className="font-semibold"> Broken Eggs (BRK)</span> are the ones that got away, and{' '}
        <span className="font-semibold">WPA</span> is the win-probability swing a reliever added. Spring D1–NAIA.
      </p>

      <InternCredit names="Nate Petz" className="mb-3" />

      <FilterBar
        filters={filters}
        onChange={(f) => { setFilters(f); setPage(0) }}
        divisions={divisions}
        conferences={conferences}
      />

      <StatPresetBar
        presets={RELIEVER_PRESETS}
        activePreset={preset}
        onSelect={(p) => { setPreset(p); setPage(0) }}
      />

      <div className="mb-2 flex items-center justify-between gap-2">
        <StatsLastUpdated />
        <ExportCSVButton
          data={result?.data || []}
          columns={RELIEVER_COLUMNS}
          filename={`nwbb_relievers_${filters.season}`}
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
            const r = await fetch(`/api/v1/leaderboards/relievers?${qs}`)
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            const j = await r.json()
            return j.data || []
          }}
        />
      </div>

      <StatsTable
        data={result?.data || []}
        columns={RELIEVER_COLUMNS}
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
