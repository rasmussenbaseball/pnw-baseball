import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useTeamStatsAgg } from '../hooks/useApi'
import {
  TEAM_BATTING_COLUMNS, TEAM_PITCHING_COLUMNS,
  TEAM_BATTING_PRESETS, TEAM_PITCHING_PRESETS,
  formatStat, divisionBadgeClass,
} from '../utils/stats'
import StatPresetBar from '../components/StatPresetBar'
import StatsLastUpdated from '../components/StatsLastUpdated'

const LEVELS = ['All', 'D1', 'D2', 'D3', 'NAIA', 'NWAC']

export default function TeamStatsPage() {
  const [statType, setStatType] = useState('hitting')
  const [level, setLevel] = useState('All')
  const [preset, setPreset] = useState('Standard')
  const [sortBy, setSortBy] = useState(null)
  const [sortDir, setSortDir] = useState('desc')
  const season = 2026

  const params = {
    season,
    stat_type: statType,
    level: level === 'All' ? 'all' : level === 'NWAC' ? 'JUCO' : level,
  }

  const { data: rawData, loading } = useTeamStatsAgg(params)

  // Get columns and presets based on stat type
  const columns = statType === 'hitting' ? TEAM_BATTING_COLUMNS : TEAM_PITCHING_COLUMNS
  const presets = statType === 'hitting' ? TEAM_BATTING_PRESETS : TEAM_PITCHING_PRESETS

  // Filter visible columns by preset
  const visibleKeys = presets[preset] || presets['Standard']
  const displayColumns = columns.filter(
    c => visibleKeys.includes(c.key) || c.sortable === false
  )

  // Add record field to data and handle sorting
  const data = useMemo(() => {
    if (!rawData) return []
    let rows = rawData.map(r => ({
      ...r,
      record: `${r.wins || 0}-${r.losses || 0}`,
    }))

    // Sort
    const key = sortBy || (statType === 'hitting' ? 'avg' : 'era')
    const dir = sortBy ? sortDir : (statType === 'hitting' ? 'desc' : 'asc')

    rows.sort((a, b) => {
      const av = a[key], bv = b[key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return dir === 'asc' ? av - bv : bv - av
    })
    return rows
  }, [rawData, sortBy, sortDir, statType])

  const handleSort = (col) => {
    if (col.sortable === false) return
    if (sortBy === col.key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      // Default direction by stat type
      const ascStats = ['era', 'whip', 'fip', 'xfip', 'siera', 'bb_per_9', 'h_per_9',
        'hr_per_9', 'bb_pct', 'k_pct', 'so', 'opp_avg', 'babip']
      // For hitting, k_pct and so are "lower is better"
      const dir = statType === 'pitching'
        ? (ascStats.includes(col.key) ? 'asc' : 'desc')
        : (['k_pct', 'so', 'cs', 'gdp'].includes(col.key) ? 'asc' : 'desc')
      setSortBy(col.key)
      setSortDir(dir)
    }
  }

  const handleTypeChange = (type) => {
    setStatType(type)
    setPreset('Standard')
    setSortBy(null)
  }

  const renderCell = (row, col, idx) => {
    if (col.key === 'rank') return idx + 1

    if (col.key === 'team_name') {
      return (
        <Link to={`/team/${row.team_id}`} className="flex items-center gap-1.5 min-w-0">
          {row.logo_url && (
            <img src={row.logo_url} alt="" className="w-5 h-5 object-contain flex-shrink-0" />
          )}
          <span className="font-medium text-pnw-slate hover:text-pnw-green truncate">
            {row.team_name}
          </span>
        </Link>
      )
    }

    if (col.key === 'division_level') {
      return (
        <span className={`text-[9px] sm:text-[10px] px-1.5 py-0.5 rounded font-semibold ${divisionBadgeClass(row.division_level)}`}>
          {row.division_level}
        </span>
      )
    }

    if (col.key === 'record') return row.record

    const val = row[col.key]
    if (val === null || val === undefined) return '-'
    return formatStat(val, col.format)
  }

  return (
    <div>
      <h1 className="text-lg sm:text-2xl font-bold text-pnw-slate mb-3 sm:mb-4">Team Stats</h1>

      {/* Hitting / Pitching toggle */}
      <div className="flex flex-wrap gap-2 mb-3">
        <div className="flex rounded-lg overflow-hidden border border-gray-300">
          <button
            onClick={() => handleTypeChange('hitting')}
            className={`px-4 py-1.5 text-sm font-medium transition-colors
              ${statType === 'hitting'
                ? 'bg-pnw-slate text-white'
                : 'bg-white text-gray-600 hover:bg-gray-100'}`}
          >
            Hitting
          </button>
          <button
            onClick={() => handleTypeChange('pitching')}
            className={`px-4 py-1.5 text-sm font-medium transition-colors
              ${statType === 'pitching'
                ? 'bg-pnw-slate text-white'
                : 'bg-white text-gray-600 hover:bg-gray-100'}`}
          >
            Pitching
          </button>
        </div>

        {/* Level filter */}
        <div className="flex rounded-lg overflow-hidden border border-gray-300">
          {LEVELS.map(l => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={`px-3 py-1.5 text-xs sm:text-sm font-medium transition-colors
                ${level === l
                  ? 'bg-pnw-green text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-100'}`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Stat view presets */}
      <StatPresetBar presets={presets} activePreset={preset} onSelect={setPreset} />

      <StatsLastUpdated className="mb-2" />

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-xs sm:text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {displayColumns.map(col => {
                const isSorted = sortBy === col.key || (!sortBy && (
                  (statType === 'hitting' && col.key === 'avg') ||
                  (statType === 'pitching' && col.key === 'era')
                ))
                const isAsc = isSorted && (sortBy ? sortDir === 'asc' :
                  (statType === 'pitching' && col.key === 'era'))

                return (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col)}
                    className={`px-2 py-2 text-left font-semibold whitespace-nowrap
                      ${col.sortable !== false ? 'cursor-pointer hover:bg-gray-100' : ''}
                      ${isSorted ? 'text-pnw-green' : 'text-gray-600'}`}
                    title={col.tooltip || ''}
                    style={{ minWidth: col.width }}
                  >
                    {col.label}
                    {isSorted && (
                      <span className="ml-0.5 text-[10px]">{isAsc ? '▲' : '▼'}</span>
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={displayColumns.length} className="text-center py-8 text-gray-400">
                  Loading...
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={displayColumns.length} className="text-center py-8 text-gray-400">
                  No data available
                </td>
              </tr>
            ) : (
              data.map((row, idx) => (
                <tr
                  key={row.team_id}
                  className={`border-b border-gray-100 hover:bg-gray-50 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/30'}`}
                >
                  {displayColumns.map(col => (
                    <td
                      key={col.key}
                      className={`px-2 py-1.5 whitespace-nowrap
                        ${col.key === 'team_name' ? '' : 'tabular-nums'}
                        ${(sortBy === col.key || (!sortBy && (
                          (statType === 'hitting' && col.key === 'avg') ||
                          (statType === 'pitching' && col.key === 'era')
                        ))) ? 'font-semibold text-pnw-slate' : 'text-gray-700'}`}
                    >
                      {renderCell(row, col, idx)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
