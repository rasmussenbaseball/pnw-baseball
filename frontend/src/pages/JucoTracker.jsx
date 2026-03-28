import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { formatStat } from '../utils/stats'

/**
 * JUCO Tracker - the recruiting tool.
 * Shows uncommitted NWAC players with their stats,
 * so 4-year schools can identify transfer targets.
 */

const COLUMNS = [
  { key: 'player',         label: 'Player', format: null,   align: 'left' },
  { key: 'team',           label: 'Team',   format: null,   align: 'left' },
  { key: 'position',       label: 'Pos',    format: null,   align: 'left' },
  { key: 'year_in_school', label: 'Yr',     format: null,   align: 'left' },
  { key: 'committed_to',   label: 'Committed', format: null, align: 'left' },
  { key: 'hometown',       label: 'Hometown',  format: null, align: 'left' },
  { key: 'total_war',      label: 'WAR',   format: 'war',  align: 'right', mono: true },
  { key: 'batting_avg',    label: 'AVG',    format: 'avg',  align: 'right', mono: true },
  { key: 'on_base_pct',    label: 'OBP',    format: 'avg',  align: 'right', mono: true },
  { key: 'slugging_pct',   label: 'SLG',    format: 'avg',  align: 'right', mono: true },
  { key: 'woba',           label: 'wOBA',   format: 'avg',  align: 'right', mono: true },
  { key: 'wrc_plus',       label: 'wRC+',   format: 'int',  align: 'right', mono: true },
  { key: 'home_runs',      label: 'HR',     format: 'int',  align: 'right' },
  { key: 'rbi',            label: 'RBI',    format: 'int',  align: 'right' },
  { key: 'stolen_bases',   label: 'SB',     format: 'int',  align: 'right' },
  { key: 'plate_appearances', label: 'PA',  format: 'int',  align: 'right' },
  { key: 'offensive_war',  label: 'oWAR',   format: 'war',  align: 'right', mono: true },
  { key: 'era',            label: 'ERA',    format: 'era',  align: 'right', mono: true },
  { key: 'fip',            label: 'FIP',    format: 'era',  align: 'right', mono: true },
  { key: 'fip_plus',       label: 'FIP+',  format: 'int',  align: 'right', mono: true },
  { key: 'era_plus',      label: 'ERA+',  format: 'int',  align: 'right', mono: true },
  { key: 'innings_pitched', label: 'IP',    format: 'ip',   align: 'right' },
  { key: 'pitching_war',   label: 'pWAR',   format: 'war',  align: 'right', mono: true },
]

// Columns that can be sorted via the API
const SORTABLE = new Set([
  'total_war', 'offensive_war', 'pitching_war',
  'batting_avg', 'on_base_pct', 'slugging_pct', 'ops',
  'woba', 'wrc_plus', 'home_runs', 'rbi', 'stolen_bases',
  'plate_appearances', 'era', 'fip', 'fip_plus', 'era_plus', 'innings_pitched',
])

// Lower-is-better stats
const ASC_DEFAULT = new Set(['era', 'fip'])

export default function JucoTracker() {
  const [season, setSeason] = useState(2026)
  const [position, setPosition] = useState('')
  const [classYear, setClassYear] = useState('So')
  const [sortBy, setSortBy] = useState('total_war')
  const [sortDir, setSortDir] = useState('desc')
  const [minAb, setMinAb] = useState(0)
  const [minIp, setMinIp] = useState(0)

  const { data, loading } = useApi('/players/juco/uncommitted', {
    season,
    position: position || undefined,
    year_in_school: classYear || undefined,
    sort_by: sortBy,
    sort_dir: sortDir,
    min_ab: minAb || 0,
    min_ip: minIp || 0,
    limit: 500,
  }, [season, position, classYear, sortBy, sortDir, minAb, minIp])

  const positions = ['C', 'IF', '1B', '2B', '3B', 'SS', 'OF', 'LF', 'CF', 'RF', 'DH', 'P', 'UT']

  const handleSort = (key) => {
    if (!SORTABLE.has(key)) return
    if (sortBy === key) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    } else {
      setSortBy(key)
      setSortDir(ASC_DEFAULT.has(key) ? 'asc' : 'desc')
    }
  }

  const sortIndicator = (key) => {
    if (!SORTABLE.has(key)) return ''
    if (sortBy !== key) return ' ↕'
    return sortDir === 'desc' ? ' ↓' : ' ↑'
  }

  const formatCell = (row, col) => {
    const val = row[col.key]
    if (col.key === 'player') return null // handled separately
    if (col.key === 'team') return row.team_short || row.team_name
    if (col.key === 'committed_to') return row.committed_to || '-'
    if (col.key === 'hometown') return row.hometown || '-'
    if (col.key === 'position') return row.position || '-'
    if (col.key === 'year_in_school') return row.year_in_school || '-'
    if (col.key === 'total_war') return formatStat(row.total_war, 'war')
    if (col.format === 'int') return val != null ? Math.round(val) : '-'
    if (col.format === 'ip') return val ? formatStat(val, 'ip') : '-'
    if (col.format) return formatStat(val, col.format)
    return val ?? '-'
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-2">JUCO Tracker</h1>
      <p className="text-sm text-gray-500 mb-4">
        Uncommitted NWAC players available for transfer to 4-year programs.
        Click any column header to sort.
      </p>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm border p-4 mb-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">Season</label>
            <select
              value={season}
              onChange={(e) => setSeason(parseInt(e.target.value))}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            >
              {[2026, 2025, 2024].map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">Class</label>
            <select
              value={classYear}
              onChange={(e) => setClassYear(e.target.value)}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            >
              <option value="So">Sophomores</option>
              <option value="Fr">Freshmen</option>
              <option value="">All</option>
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">Position</label>
            <select
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            >
              <option value="">All Positions</option>
              {positions.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">Min AB</label>
            <input
              type="number"
              value={minAb}
              onChange={(e) => setMinAb(parseInt(e.target.value) || 0)}
              min={0}
              max={300}
              step={10}
              className="w-20 rounded border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>

          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">Min IP</label>
            <input
              type="number"
              value={minIp}
              onChange={(e) => setMinIp(parseInt(e.target.value) || 0)}
              min={0}
              max={150}
              step={5}
              className="w-20 rounded border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border p-8 text-center text-gray-400 animate-pulse">
          Loading JUCO players...
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border overflow-x-auto">
          <table className="stat-table">
            <thead>
              <tr>
                <th>#</th>
                {COLUMNS.map(col => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className={SORTABLE.has(col.key) ? 'cursor-pointer select-none hover:bg-gray-100' : ''}
                    style={{ textAlign: col.align }}
                  >
                    {col.label}{sortIndicator(col.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data || []).map((row, i) => (
                <tr key={row.id}>
                  <td>{i + 1}</td>
                  {COLUMNS.map(col => {
                    if (col.key === 'player') {
                      return (
                        <td key={col.key}>
                          <Link to={`/player/${row.id}`} className="player-link">
                            {row.first_name} {row.last_name}
                          </Link>
                        </td>
                      )
                    }
                    return (
                      <td
                        key={col.key}
                        className={[
                          col.mono ? 'font-mono' : '',
                          col.align === 'right' ? 'text-right' : '',
                          col.key === 'hometown' || col.key === 'committed_to' ? 'text-gray-500' : '',
                        ].filter(Boolean).join(' ')}
                      >
                        {formatCell(row, col)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {data && (
            <div className="px-4 py-2 text-sm text-gray-500 border-t">
              Showing {data.length} players
            </div>
          )}
        </div>
      )}
    </div>
  )
}
