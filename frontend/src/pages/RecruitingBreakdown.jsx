import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useRecruitingBreakdown } from '../hooks/useApi'

const LEVELS = ['All', 'D1', 'D2', 'D3', 'NAIA', 'JUCO']

const COLUMNS = [
  { key: 'short_name', label: 'Team', sortable: false },
  { key: 'division', label: 'Div', sortable: true },
  { key: 'record', label: 'Record', sortable: false },
  { key: 'win_pct', label: 'W-L%', sortable: true },
  { key: 'trend', label: 'Trend', sortable: true, tooltip: 'Change in W-L% vs. prior 2-year average' },
  { key: 'fr_pa_pct', label: 'Fr PA%', sortable: true, tooltip: 'Freshman plate appearances as % of team total' },
  { key: 'fr_ip_pct', label: 'Fr IP%', sortable: true, tooltip: 'Freshman innings pitched as % of team total' },
  { key: 'war_per_game', label: 'WAR/G', sortable: true, tooltip: 'Total team WAR per game played' },
  { key: 'team_wrc_plus', label: 'wRC+', sortable: true, tooltip: 'Team avg wRC+ (PA-weighted)' },
  { key: 'team_fip', label: 'FIP', sortable: true, tooltip: 'Team avg FIP (IP-weighted)' },
]

function TrendArrow({ trend, prev1, prev2 }) {
  if (trend === null || trend === undefined) {
    return <span className="text-gray-300">—</span>
  }

  const abs = Math.abs(trend)
  let color, arrow, bg

  if (trend >= 0.05) {
    color = 'text-emerald-600'
    bg = 'bg-emerald-50'
    arrow = '▲'
  } else if (trend >= 0.02) {
    color = 'text-emerald-500'
    bg = 'bg-emerald-50'
    arrow = '▲'
  } else if (trend > -0.02) {
    color = 'text-gray-400'
    bg = 'bg-gray-50'
    arrow = '▸'
  } else if (trend > -0.05) {
    color = 'text-red-400'
    bg = 'bg-red-50'
    arrow = '▼'
  } else {
    color = 'text-red-500'
    bg = 'bg-red-50'
    arrow = '▼'
  }

  // Build tooltip showing prior seasons
  const parts = []
  if (prev2 !== null && prev2 !== undefined) parts.push(`'24: ${prev2.toFixed(3)}`)
  if (prev1 !== null && prev1 !== undefined) parts.push(`'25: ${prev1.toFixed(3)}`)
  const tip = parts.length > 0 ? parts.join(' → ') : ''

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold ${color} ${bg}`}
      title={tip}
    >
      <span className="text-[10px]">{arrow}</span>
      {trend > 0 ? '+' : ''}{(trend * 100).toFixed(0)}%
    </span>
  )
}

export default function RecruitingBreakdown() {
  const { data, loading, error } = useRecruitingBreakdown(2026)
  const [level, setLevel] = useState('All')
  const [sortKey, setSortKey] = useState('win_pct')
  const [sortDir, setSortDir] = useState('desc')

  const handleSort = (key) => {
    if (!COLUMNS.find(c => c.key === key)?.sortable) return
    if (sortKey === key) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    } else {
      setSortKey(key)
      // Default sort direction based on stat
      setSortDir(key === 'team_fip' ? 'asc' : 'desc')
    }
  }

  const filtered = useMemo(() => {
    if (!data) return []
    let rows = [...data]
    if (level !== 'All') {
      rows = rows.filter(r => r.division === level)
    }
    rows.sort((a, b) => {
      let aVal = a[sortKey]
      let bVal = b[sortKey]
      // Handle nulls — push to bottom
      if (aVal === null || aVal === undefined) return 1
      if (bVal === null || bVal === undefined) return -1
      if (sortDir === 'desc') return bVal - aVal
      return aVal - bVal
    })
    return rows
  }, [data, level, sortKey, sortDir])

  if (loading) return <div className="text-center py-12 text-gray-400">Loading breakdown...</div>
  if (error) return <div className="text-center py-12 text-red-400">Error: {error}</div>

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Recruiting Breakdown</h1>
      <p className="text-sm text-gray-500 mb-4">
        Team-level recruiting metrics for the 2026 season. Compare programs side-by-side — who's trending up, who plays freshmen, and where the talent is.
      </p>

      {/* Level filter */}
      <div className="flex gap-1 mb-4 overflow-x-auto pb-1">
        {LEVELS.map(l => (
          <button
            key={l}
            onClick={() => setLevel(l)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              level === l
                ? 'bg-nw-teal text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {COLUMNS.map(col => (
                <th
                  key={col.key}
                  onClick={() => col.sortable && handleSort(col.key)}
                  className={`px-3 py-2 text-[10px] uppercase tracking-wider font-semibold whitespace-nowrap ${
                    col.sortable ? 'cursor-pointer hover:bg-gray-100 select-none' : ''
                  } ${col.key === 'short_name' ? 'text-left sticky left-0 bg-gray-50 z-10' : 'text-center'}`}
                  title={col.tooltip || ''}
                >
                  <span className={sortKey === col.key ? 'text-nw-teal' : 'text-gray-500'}>
                    {col.label}
                    {sortKey === col.key && (
                      <span className="ml-0.5">{sortDir === 'desc' ? '↓' : '↑'}</span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((team, i) => (
              <tr
                key={team.team_id}
                className={`border-b border-gray-100 hover:bg-blue-50/40 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}
              >
                {/* Team */}
                <td className="px-3 py-2 sticky left-0 bg-inherit z-10">
                  <Link
                    to={`/team/${team.team_id}`}
                    className="flex items-center gap-2 hover:text-nw-teal transition-colors"
                  >
                    {team.logo_url ? (
                      <img
                        src={team.logo_url}
                        alt=""
                        className="w-5 h-5 object-contain shrink-0"
                        onError={(e) => { e.target.style.display = 'none' }}
                      />
                    ) : (
                      <div className="w-5 h-5 shrink-0" />
                    )}
                    <span className="text-xs font-semibold text-gray-800 whitespace-nowrap">
                      {team.short_name}
                    </span>
                  </Link>
                </td>

                {/* Division */}
                <td className="px-3 py-2 text-center">
                  <span className="text-[10px] font-bold text-gray-400 uppercase">{team.division}</span>
                </td>

                {/* Record */}
                <td className="px-3 py-2 text-center text-xs text-gray-600 whitespace-nowrap">
                  {team.wins}-{team.losses}
                </td>

                {/* W-L% */}
                <td className="px-3 py-2 text-center text-xs font-semibold text-gray-800">
                  {team.win_pct.toFixed(3)}
                </td>

                {/* Trend */}
                <td className="px-3 py-2 text-center">
                  <TrendArrow trend={team.trend} prev1={team.prev1_win_pct} prev2={team.prev2_win_pct} />
                </td>

                {/* Fr PA% */}
                <td className="px-3 py-2 text-center text-xs text-gray-600">
                  {team.fr_pa_pct.toFixed(1)}%
                </td>

                {/* Fr IP% */}
                <td className="px-3 py-2 text-center text-xs text-gray-600">
                  {team.fr_ip_pct.toFixed(1)}%
                </td>

                {/* WAR/G */}
                <td className="px-3 py-2 text-center text-xs font-semibold text-gray-800">
                  {team.war_per_game.toFixed(2)}
                </td>

                {/* wRC+ */}
                <td className="px-3 py-2 text-center text-xs text-gray-600">
                  {team.team_wrc_plus != null ? team.team_wrc_plus.toFixed(0) : '—'}
                </td>

                {/* FIP */}
                <td className="px-3 py-2 text-center text-xs text-gray-600">
                  {team.team_fip != null ? team.team_fip.toFixed(2) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="mt-4 px-1 text-[10px] text-gray-400 space-y-1">
        <p><strong>Trend</strong> — Change in W-L% compared to the average of the prior two seasons (2024-2025). <span className="text-emerald-500">▲ Green = improving</span>, <span className="text-red-400">▼ Red = declining</span>, <span className="text-gray-400">▸ Gray = steady</span>. Hover for year-by-year W-L%.</p>
        <p><strong>Fr PA% / Fr IP%</strong> — Freshman (Fr + R-Fr) plate appearances or innings pitched as a percentage of the team total. Higher = more freshman playing time.</p>
        <p><strong>WAR/G</strong> — Total team WAR (offensive + pitching) divided by games played. Measures overall roster talent density.</p>
        <p><strong>wRC+</strong> — PA-weighted team average wRC+. 100 = league average. <strong>FIP</strong> — IP-weighted team average FIP. Lower is better.</p>
        <p className="italic">2026 season is in progress. Stats reflect games played to date.</p>
      </div>
    </div>
  )
}
