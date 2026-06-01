import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { usePersistedState } from '../hooks/usePersistedState'
import { formatStat } from '../utils/stats'
import StatsLastUpdated from '../components/StatsLastUpdated'

/**
 * Transfer Portal Tracker — PNW four-year (non-JUCO) college players who
 * have entered the transfer portal. Same look as the JUCO Tracker; the
 * curated list is served by /players/transfer-portal.
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
  { key: 'bat_k_pct',      label: 'K%',      format: 'pct', mono: true },
  { key: 'bat_bb_pct',     label: 'BB%',     format: 'pct', mono: true },
  { key: 'contact_pct',    label: 'Contact%',format: 'pct', mono: true },
  { key: 'swing_pct',      label: 'Swing%',  format: 'pct', mono: true },
  { key: 'air_pull_pct',   label: 'AIRPULL%',format: 'pct', mono: true },
  { key: 'batter_wpa',     label: 'WPA',     format: 'wpa', mono: true },
  { key: 'offensive_war',  label: 'oWAR', format: 'war',  mono: true },
]

const PITCHING_COLS = [
  { key: 'era',            label: 'ERA',  format: 'era',  mono: true },
  { key: 'fip',            label: 'FIP',  format: 'era',  mono: true },
  { key: 'fip_plus',       label: 'FIP+', format: 'int',  mono: true },
  { key: 'siera',          label: 'SIERA',format: 'era',  mono: true },
  { key: 'baa',            label: 'BAA',  format: 'avg',  mono: true },
  { key: 'pitch_k_pct',    label: 'K%',   format: 'pct',  mono: true },
  { key: 'pitch_bb_pct',   label: 'BB%',  format: 'pct',  mono: true },
  { key: 'whiff_pct',      label: 'Whiff%',  format: 'pct', mono: true },
  { key: 'strike_pct',     label: 'Strike%', format: 'pct', mono: true },
  { key: 'first_pitch_strike_pct', label: 'FPS%', format: 'pct', mono: true },
  { key: 'innings_pitched', label: 'IP',   format: 'ip' },
  { key: 'pitcher_wpa',    label: 'WPA',  format: 'wpa',  mono: true },
  { key: 'pitching_war',   label: 'pWAR', format: 'war',  mono: true },
]

const STAT_COLS = [
  { key: 'total_war', label: 'WAR', format: 'war', mono: true },
  ...BATTING_COLS,
  ...PITCHING_COLS,
]

const SORTABLE = new Set([
  'total_war', 'offensive_war', 'pitching_war',
  'batting_avg', 'on_base_pct', 'slugging_pct', 'ops',
  'woba', 'wrc_plus', 'home_runs', 'rbi', 'stolen_bases',
  'plate_appearances', 'era', 'fip', 'fip_plus', 'innings_pitched',
])

const ASC_DEFAULT = new Set(['era', 'fip'])

export default function TransferPortalTracker() {
  const [season, setSeason] = usePersistedState('tp_season', 2026)
  const [position, setPosition] = usePersistedState('tp_position', '')
  const [sortBy, setSortBy] = usePersistedState('tp_sortBy', 'total_war')
  const [sortDir, setSortDir] = usePersistedState('tp_sortDir', 'desc')
  const [bats, setBats] = usePersistedState('tp_bats', '')
  const [throws_, setThrows] = usePersistedState('tp_throws', '')

  const { data, loading } = useApi('/transfer-portal', {
    season,
    position: position || undefined,
    sort_by: sortBy,
    sort_dir: sortDir,
    bats: bats || undefined,
    throws: throws_ || undefined,
  }, [season, position, sortBy, sortDir, bats, throws_])

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
    if (col.format === 'wpa') return val != null ? (val >= 0 ? '+' : '') + Number(val).toFixed(2) : '-'
    if (col.format) return formatStat(val, col.format)
    return val ?? '-'
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-2">Transfer Portal Tracker</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Pacific Northwest four-year college players who have entered the transfer portal.
      </p>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-3 mb-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Season</label>
            <select
              value={season}
              onChange={(e) => setSeason(parseInt(e.target.value))}
              className="rounded border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-sm"
            >
              {[2026, 2025, 2024].map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Position</label>
            <select
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              className="rounded border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-sm"
            >
              <option value="">All</option>
              {positions.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Bats</label>
            <select
              value={bats}
              onChange={(e) => setBats(e.target.value)}
              className="rounded border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-sm"
            >
              <option value="">All</option>
              <option value="L">LHH</option>
              <option value="R">RHH</option>
              <option value="S">SHH</option>
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Throws</label>
            <select
              value={throws_}
              onChange={(e) => setThrows(e.target.value)}
              className="rounded border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-sm"
            >
              <option value="">All</option>
              <option value="L">LHP</option>
              <option value="R">RHP</option>
            </select>
          </div>
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-8 text-center text-gray-400 dark:text-gray-500 animate-pulse">
          Loading transfer portal...
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border overflow-x-auto relative">
          <table className="w-full text-[11px] leading-tight border-collapse">
            <thead>
              {/* Category header row */}
              <tr className="sticky top-0 z-20 bg-pnw-slate">
                <th colSpan={7} style={{width:478,minWidth:478,maxWidth:478}} className="sticky left-0 z-30 bg-pnw-slate text-white text-[10px] font-semibold tracking-wider uppercase px-2 py-1 text-left border-r border-white/10">
                  Player Info
                </th>
                <th className="bg-pnw-slate text-white text-[10px] font-semibold tracking-wider uppercase px-2 py-1 border-r border-white/10"></th>
                <th colSpan={BATTING_COLS.length} className="bg-pnw-slate text-white text-[10px] font-semibold tracking-wider uppercase px-2 py-1 text-center border-r border-white/10">
                  Batting
                </th>
                <th colSpan={PITCHING_COLS.length} className="bg-pnw-slate text-white text-[10px] font-semibold tracking-wider uppercase px-2 py-1 text-center">
                  Pitching
                </th>
              </tr>
              {/* Column header row */}
              <tr className="sticky top-[25px] z-20 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
                <th style={{width:28,minWidth:28,maxWidth:28}} className="sticky left-0 z-30 bg-gray-50 dark:bg-gray-900/40 px-1 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-right border-r border-gray-100 dark:border-gray-700">#</th>
                <th style={{width:110,minWidth:110,maxWidth:110}} className="sticky left-[28px] z-30 bg-gray-50 dark:bg-gray-900/40 px-1.5 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-left">Player</th>
                <th style={{width:90,minWidth:90,maxWidth:90}} className="sticky left-[138px] z-30 bg-gray-50 dark:bg-gray-900/40 px-1.5 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-left">School</th>
                <th style={{width:60,minWidth:60,maxWidth:60}} className="sticky left-[228px] z-30 bg-gray-50 dark:bg-gray-900/40 px-1 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-left">Pos</th>
                <th style={{width:32,minWidth:32,maxWidth:32}} className="sticky left-[288px] z-30 bg-gray-50 dark:bg-gray-900/40 px-1 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-left">B/T</th>
                <th style={{width:28,minWidth:28,maxWidth:28}} className="sticky left-[320px] z-30 bg-gray-50 dark:bg-gray-900/40 px-1 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-left">Yr</th>
                <th style={{width:130,minWidth:130,maxWidth:130}} className="sticky left-[348px] z-30 bg-gray-50 dark:bg-gray-900/40 px-1.5 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-left border-r border-gray-200 dark:border-gray-700">Committed To</th>
                {STAT_COLS.map(col => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className={`px-1.5 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-right whitespace-nowrap ${
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
                <tr key={row.id} className={`border-b border-gray-50 hover:bg-teal-50/30 ${i % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/40'}`}>
                  <td style={{width:28,minWidth:28,maxWidth:28}} className="sticky left-0 z-10 bg-inherit px-1 py-1 text-gray-400 dark:text-gray-500 text-right text-[10px] border-r border-gray-100 dark:border-gray-700">{i + 1}</td>
                  <td style={{width:110,minWidth:110,maxWidth:110}} className="sticky left-[28px] z-10 bg-inherit px-1.5 py-1 font-medium overflow-hidden">
                    <Link to={`/player/${row.id}`} className="text-nw-teal hover:underline whitespace-nowrap block truncate">
                      {row.first_name} {row.last_name}
                    </Link>
                  </td>
                  <td style={{width:90,minWidth:90,maxWidth:90}} className="sticky left-[138px] z-10 bg-inherit px-1.5 py-1 overflow-hidden">
                    <div className="flex items-center gap-1 max-w-full">
                      {row.logo_url && (
                        <img src={row.logo_url} alt="" className="w-4 h-4 object-contain shrink-0"
                          onError={(e) => { e.target.style.display = 'none' }} />
                      )}
                      <span className="text-gray-600 dark:text-gray-400 truncate">{row.team_short || row.team_name}</span>
                    </div>
                  </td>
                  <td style={{width:60,minWidth:60,maxWidth:60}} className="sticky left-[228px] z-10 bg-inherit px-1 py-1 text-gray-500 dark:text-gray-400 truncate overflow-hidden">{row.position || '-'}</td>
                  <td style={{width:32,minWidth:32,maxWidth:32}} className="sticky left-[288px] z-10 bg-inherit px-1 py-1 text-gray-500 dark:text-gray-400 truncate overflow-hidden">{row.bats || '-'}/{row.throws || '-'}</td>
                  <td style={{width:28,minWidth:28,maxWidth:28}} className="sticky left-[320px] z-10 bg-inherit px-1 py-1 text-gray-500 dark:text-gray-400 truncate overflow-hidden">{row.year_in_school || '-'}</td>
                  <td style={{width:130,minWidth:130,maxWidth:130}} className="sticky left-[348px] z-10 bg-inherit px-1.5 py-1 border-r border-gray-200 dark:border-gray-700 overflow-hidden">
                    {row.committed_to ? (
                      <span title={row.committed_to} className="inline-block px-1.5 py-0.5 text-[10px] font-bold bg-emerald-100 text-emerald-700 rounded truncate max-w-full">{row.committed_to}</span>
                    ) : (
                      <span className="text-gray-400 dark:text-gray-500">-</span>
                    )}
                  </td>
                  {STAT_COLS.map(col => (
                    <td
                      key={col.key}
                      className={`px-1.5 py-1 text-right whitespace-nowrap ${
                        col.mono ? 'font-mono' : ''
                      } ${sortBy === col.key ? 'bg-teal-50/50 font-semibold' : 'text-gray-600 dark:text-gray-400'}`}
                    >
                      {fmtCell(row, col)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {data && (
            <div className="px-3 py-1.5 text-[11px] text-gray-400 dark:text-gray-500 border-t">
              Showing {data.length} players
            </div>
          )}
        </div>
      )}

      <StatsLastUpdated levels={['D1', 'D2', 'D3', 'NAIA']} className="mt-3" />
    </div>
  )
}
