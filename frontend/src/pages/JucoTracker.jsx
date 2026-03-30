import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { formatStat } from '../utils/stats'

/**
 * JUCO Tracker - the recruiting tool.
 * Shows uncommitted NWAC players with their stats,
 * so 4-year schools can identify transfer targets.
 */

const BATTING_COLS = [
  { key: 'batting_avg',    label: 'AVG',  format: 'avg',  mono: true },
  { key: 'on_base_pct',    label: 'OBP',  format: 'avg',  mono: true },
  { key: 'slugging_pct',   label: 'SLG',  format: 'avg',  mono: true },
  { key: 'woba',           label: 'wOBA', format: 'avg',  mono: true },
  { key: 'wrc_plus',       label: 'wRC+', format: 'int',  mono: true },
  { key: 'home_runs',      label: 'HR',   format: 'int' },
  { key: 'rbi',            label: 'RBI',  format: 'int' },
  { key: 'stolen_bases',   label: 'SB',   format: 'int' },
  { key: 'plate_appearances', label: 'PA', format: 'int' },
  { key: 'offensive_war',  label: 'oWAR', format: 'war',  mono: true },
]

const PITCHING_COLS = [
  { key: 'era',            label: 'ERA',  format: 'era',  mono: true },
  { key: 'fip',            label: 'FIP',  format: 'era',  mono: true },
  { key: 'fip_plus',       label: 'FIP+', format: 'int',  mono: true },
  { key: 'pitch_k_pct',    label: 'K%',   format: 'pct',  mono: true },
  { key: 'pitch_bb_pct',   label: 'BB%',  format: 'pct',  mono: true },
  { key: 'innings_pitched', label: 'IP',   format: 'ip' },
  { key: 'pitching_war',   label: 'pWAR', format: 'war',  mono: true },
]

// All stat columns in order
const STAT_COLS = [
  { key: 'total_war', label: 'WAR', format: 'war', mono: true },
  ...BATTING_COLS,
  ...PITCHING_COLS,
]

// Columns that can be sorted via the API
const SORTABLE = new Set([
  'total_war', 'offensive_war', 'pitching_war',
  'batting_avg', 'on_base_pct', 'slugging_pct', 'ops',
  'woba', 'wrc_plus', 'home_runs', 'rbi', 'stolen_bases',
  'plate_appearances', 'era', 'fip', 'fip_plus', 'innings_pitched',
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

  const sortArrow = (key) => {
    if (!SORTABLE.has(key)) return null
    if (sortBy !== key) return <span className="text-gray-300 ml-0.5">↕</span>
    return <span className="text-nw-teal ml-0.5">{sortDir === 'desc' ? '↓' : '↑'}</span>
  }

  const fmtCell = (row, col) => {
    const val = row[col.key]
    if (col.format === 'pct') return val != null ? (Number(val) * 100).toFixed(1) + '%' : '-'
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
      </p>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm border p-3 mb-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Season</label>
            <select
              value={season}
              onChange={(e) => setSeason(parseInt(e.target.value))}
              className="rounded border border-gray-300 px-2.5 py-1 text-sm"
            >
              {[2026, 2025, 2024].map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Class</label>
            <select
              value={classYear}
              onChange={(e) => setClassYear(e.target.value)}
              className="rounded border border-gray-300 px-2.5 py-1 text-sm"
            >
              <option value="So">Sophomores</option>
              <option value="Fr">Freshmen</option>
              <option value="">All</option>
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Position</label>
            <select
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              className="rounded border border-gray-300 px-2.5 py-1 text-sm"
            >
              <option value="">All</option>
              {positions.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Min AB</label>
            <input
              type="number"
              value={minAb}
              onChange={(e) => setMinAb(parseInt(e.target.value) || 0)}
              min={0} max={300} step={10}
              className="w-16 rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Min IP</label>
            <input
              type="number"
              value={minIp}
              onChange={(e) => setMinIp(parseInt(e.target.value) || 0)}
              min={0} max={150} step={5}
              className="w-16 rounded border border-gray-300 px-2 py-1 text-sm"
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
        <div className="bg-white rounded-lg shadow-sm border overflow-x-auto relative">
          <table className="w-full text-[11px] leading-tight border-collapse">
            <thead>
              {/* Category header row */}
              <tr className="sticky top-0 z-20 bg-pnw-slate">
                {/* Frozen info columns */}
                <th colSpan={6} className="sticky left-0 z-30 bg-pnw-slate text-white text-[10px] font-semibold tracking-wider uppercase px-2 py-1 text-left border-r border-white/10">
                  Player Info
                </th>
                {/* WAR */}
                <th className="bg-pnw-slate text-white text-[10px] font-semibold tracking-wider uppercase px-2 py-1 border-r border-white/10"></th>
                {/* Batting group */}
                <th colSpan={BATTING_COLS.length} className="bg-pnw-slate text-white text-[10px] font-semibold tracking-wider uppercase px-2 py-1 text-center border-r border-white/10">
                  Batting
                </th>
                {/* Pitching group */}
                <th colSpan={PITCHING_COLS.length} className="bg-pnw-slate text-white text-[10px] font-semibold tracking-wider uppercase px-2 py-1 text-center">
                  Pitching
                </th>
              </tr>
              {/* Column header row */}
              <tr className="sticky top-[25px] z-20 bg-gray-50 border-b border-gray-200">
                {/* Frozen: #, Player, Team, Pos, Yr, Committed */}
                <th className="sticky left-0 z-30 bg-gray-50 px-1.5 py-1.5 text-gray-500 font-semibold text-right w-7 border-r border-gray-100">#</th>
                <th className="sticky left-7 z-30 bg-gray-50 px-1.5 py-1.5 text-gray-500 font-semibold text-left min-w-[120px]">Player</th>
                <th className="sticky left-[127px] z-30 bg-gray-50 px-1.5 py-1.5 text-gray-500 font-semibold text-left min-w-[80px]">Team</th>
                <th className="sticky left-[207px] z-30 bg-gray-50 px-1.5 py-1.5 text-gray-500 font-semibold text-left w-8">Pos</th>
                <th className="sticky left-[239px] z-30 bg-gray-50 px-1.5 py-1.5 text-gray-500 font-semibold text-left w-7">Yr</th>
                <th className="sticky left-[262px] z-30 bg-gray-50 px-1.5 py-1.5 text-gray-500 font-semibold text-left min-w-[80px] border-r border-gray-200">Committed</th>
                {/* Stat columns */}
                {STAT_COLS.map(col => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className={`px-1.5 py-1.5 text-gray-500 font-semibold text-right whitespace-nowrap ${
                      SORTABLE.has(col.key) ? 'cursor-pointer select-none hover:text-nw-teal' : ''
                    } ${sortBy === col.key ? 'text-nw-teal bg-teal-50/50' : ''}`}
                  >
                    {col.label}{sortArrow(col.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data || []).map((row, i) => (
                <tr key={row.id} className={`border-b border-gray-50 hover:bg-teal-50/30 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}`}>
                  {/* Frozen columns */}
                  <td className="sticky left-0 z-10 bg-inherit px-1.5 py-1 text-gray-400 text-right text-[10px] border-r border-gray-100">{i + 1}</td>
                  <td className="sticky left-7 z-10 bg-inherit px-1.5 py-1 font-medium">
                    <Link to={`/player/${row.id}`} className="text-nw-teal hover:underline whitespace-nowrap">
                      {row.first_name} {row.last_name}
                    </Link>
                  </td>
                  <td className="sticky left-[127px] z-10 bg-inherit px-1.5 py-1">
                    <div className="flex items-center gap-1">
                      {row.logo_url && (
                        <img src={row.logo_url} alt="" className="w-4 h-4 object-contain shrink-0"
                          onError={(e) => { e.target.style.display = 'none' }} />
                      )}
                      <span className="text-gray-600 truncate">{row.team_short || row.team_name}</span>
                    </div>
                  </td>
                  <td className="sticky left-[207px] z-10 bg-inherit px-1.5 py-1 text-gray-500">{row.position || '-'}</td>
                  <td className="sticky left-[239px] z-10 bg-inherit px-1.5 py-1 text-gray-500">{row.year_in_school || '-'}</td>
                  <td className="sticky left-[262px] z-10 bg-inherit px-1.5 py-1 text-gray-400 border-r border-gray-200">{row.committed_to || '-'}</td>
                  {/* Stat columns */}
                  {STAT_COLS.map(col => (
                    <td
                      key={col.key}
                      className={`px-1.5 py-1 text-right whitespace-nowrap ${
                        col.mono ? 'font-mono' : ''
                      } ${sortBy === col.key ? 'bg-teal-50/50 font-semibold' : 'text-gray-600'}`}
                    >
                      {fmtCell(row, col)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {data && (
            <div className="px-3 py-1.5 text-[11px] text-gray-400 border-t">
              Showing {data.length} players
            </div>
          )}
        </div>
      )}
    </div>
  )
}
