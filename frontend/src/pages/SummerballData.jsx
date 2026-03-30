import { useState } from 'react'
import StatsTable from '../components/StatsTable'
import StatPresetBar from '../components/StatPresetBar'
import {
  useSummerBattingLeaderboard,
  useSummerPitchingLeaderboard,
  useSummerLeagues,
  useSummerTeams,
} from '../hooks/useApi'
import {
  SUMMER_BATTING_COLUMNS,
  SUMMER_BATTING_PRESETS,
  SUMMER_PITCHING_COLUMNS,
  SUMMER_PITCHING_PRESETS,
} from '../utils/stats'

const SEASONS = [2025, 2024, 2023, 2022, 2021, 2019]

function SummerFilterBar({ filters, onChange, leagues, teams, isBatting }) {
  return (
    <div className="flex flex-wrap gap-2 mb-3 text-xs sm:text-sm">
      <select
        value={filters.season || 2025}
        onChange={(e) => onChange({ ...filters, season: Number(e.target.value) })}
        className="border rounded px-2 py-1"
      >
        {SEASONS.map(y => (
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
      {isBatting ? (
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
      ) : (
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
      )}
    </div>
  )
}

export default function SummerballData() {
  const [tab, setTab] = useState('batting')
  const [battingFilters, setBattingFilters] = useState({
    season: 2025,
    min_pa: 50,
    league: null,
    team_id: null,
  })
  const [pitchingFilters, setPitchingFilters] = useState({
    season: 2025,
    min_ip: 10,
    league: null,
    team_id: null,
  })
  const [sortBy, setSortBy] = useState('batting_avg')
  const [sortDir, setSortDir] = useState('desc')
  const [preset, setPreset] = useState('Standard')
  const [page, setPage] = useState(0)
  const limit = 50

  const activeFilters = tab === 'batting' ? battingFilters : pitchingFilters
  const { data: summerLeagues } = useSummerLeagues()
  const { data: summerTeams } = useSummerTeams(activeFilters.league)

  const battingApiParams = {
    season: battingFilters.season,
    league: battingFilters.league,
    team_id: battingFilters.team_id,
    min_pa: battingFilters.min_pa || 0,
    sort_by: sortBy,
    sort_dir: sortDir,
    limit,
    offset: page * limit,
  }

  const pitchingApiParams = {
    season: pitchingFilters.season,
    league: pitchingFilters.league,
    team_id: pitchingFilters.team_id,
    min_ip: pitchingFilters.min_ip || 0,
    sort_by: sortBy,
    sort_dir: sortDir,
    limit,
    offset: page * limit,
  }

  const { data: battingResult, loading: battingLoading } = useSummerBattingLeaderboard(
    tab === 'batting' ? battingApiParams : { season: 2025, limit: 1 }
  )
  const { data: pitchingResult, loading: pitchingLoading } = useSummerPitchingLeaderboard(
    tab === 'pitching' ? pitchingApiParams : { season: 2025, limit: 1 }
  )

  const result = tab === 'batting' ? battingResult : pitchingResult
  const loading = tab === 'batting' ? battingLoading : pitchingLoading
  const columns = tab === 'batting' ? SUMMER_BATTING_COLUMNS : SUMMER_PITCHING_COLUMNS
  const presets = tab === 'batting' ? SUMMER_BATTING_PRESETS : SUMMER_PITCHING_PRESETS

  const handleSort = (key, dir) => {
    setSortBy(key)
    setSortDir(dir)
    setPage(0)
  }

  const handleTabChange = (newTab) => {
    setTab(newTab)
    setPage(0)
    setPreset('Standard')
    if (newTab === 'batting') {
      setSortBy('batting_avg')
      setSortDir('desc')
    } else {
      setSortBy('era')
      setSortDir('asc')
    }
  }

  return (
    <div>
      <h1 className="text-lg sm:text-2xl font-bold text-pnw-slate mb-1">Summerball Data</h1>
      <p className="text-xs sm:text-sm text-gray-500 mb-3">West Coast League & Pacific International League stats</p>

      {/* Batting / Pitching toggle */}
      <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-sm mb-3">
        <button
          onClick={() => handleTabChange('batting')}
          className={`px-4 py-1.5 font-medium transition-colors ${
            tab === 'batting'
              ? 'bg-pnw-blue text-white'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          Batting
        </button>
        <button
          onClick={() => handleTabChange('pitching')}
          className={`px-4 py-1.5 font-medium transition-colors ${
            tab === 'pitching'
              ? 'bg-pnw-blue text-white'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          Pitching
        </button>
      </div>

      <SummerFilterBar
        filters={activeFilters}
        onChange={(f) => {
          if (tab === 'batting') setBattingFilters(f)
          else setPitchingFilters(f)
          setPage(0)
        }}
        leagues={summerLeagues}
        teams={summerTeams}
        isBatting={tab === 'batting'}
      />

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
