import { useState } from 'react'
import FilterBar from '../components/FilterBar'
import { useWarLeaderboard, useDivisions, useConferences } from '../hooks/useApi'
import { formatStat, divisionBadgeClass } from '../utils/stats'
import { Link } from 'react-router-dom'

const COLUMNS = [
  // WAR cluster
  { key: 'total_war', label: 'WAR', width: 58, title: 'Total WAR (oWAR + pWAR)', bold: true },
  { key: 'offensive_war', label: 'oWAR', width: 58, title: 'Offensive WAR', needs: 'batting' },
  { key: 'pitching_war', label: 'pWAR', width: 58, title: 'Pitching WAR', needs: 'pitching' },
  { key: 'war_per_pa', label: 'WAR/PA', width: 62, title: 'Offensive WAR per Plate Appearance', accent: true, needs: 'batting' },
  { key: 'war_per_ip', label: 'WAR/IP', width: 62, title: 'Pitching WAR per Inning Pitched', accent: true, needs: 'pitching' },
  // Batting cluster
  { key: 'plate_appearances', label: 'PA', width: 50, needs: 'batting', format: 'int' },
  { key: 'batting_avg', label: 'AVG', width: 50, needs: 'batting', format: 'avg' },
  { key: 'woba', label: 'wOBA', width: 50, needs: 'batting', format: 'avg' },
  { key: 'wrc_plus', label: 'wRC+', width: 50, needs: 'batting', format: 'int' },
  // Pitching cluster
  { key: 'innings_pitched', label: 'IP', width: 50, needs: 'pitching', format: 'ip' },
  { key: 'era', label: 'ERA', width: 50, needs: 'pitching', format: 'era' },
  { key: 'fip', label: 'FIP', width: 50, needs: 'pitching', format: 'era' },
  { key: 'fip_plus', label: 'FIP+', width: 50, needs: 'pitching', format: 'int' },
  { key: 'whip', label: 'WHIP', width: 50, needs: 'pitching', format: 'era' },
  { key: 'k_per_9', label: 'K/9', width: 50, needs: 'pitching', format: 'era' },
  { key: 'wins', label: 'W-L', width: 50, needs: 'pitching', sortable: true, renderFn: 'wl' },
]

// Stats where lower = better → default sort ASC
const LOWER_IS_BETTER = new Set(['era', 'whip', 'fip'])

export default function WarLeaderboard() {
  const [filters, setFilters] = useState({ season: 2026 })
  const [page, setPage] = useState(0)
  const [sortBy, setSortBy] = useState('total_war')
  const [sortDir, setSortDir] = useState('desc')
  const limit = 50

  const { data: divisions } = useDivisions()
  const { data: conferences } = useConferences()

  const { data: result, loading } = useWarLeaderboard({
    season: filters.season,
    division_id: filters.division_id,
    conference_id: filters.conference_id,
    position_group: filters.position_group,
    min_pa: filters.min_pa ?? 30,
    min_ip: filters.min_ip ?? 10,
    qualified: filters.qualified || false,
    sort_by: sortBy,
    sort_dir: sortDir,
    limit,
    offset: page * limit,
  })

  const handleSort = (key) => {
    if (key === sortBy) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    } else {
      setSortBy(key)
      setSortDir(LOWER_IS_BETTER.has(key) ? 'asc' : 'desc')
    }
    setPage(0)
  }

  const sortIndicator = (key) => {
    if (key !== sortBy) return ''
    return sortDir === 'desc' ? ' ▼' : ' ▲'
  }

  const renderCell = (col, row) => {
    const hasBatting = row.plate_appearances > 0
    const hasPitching = row.innings_pitched > 0

    // Check if this column applies to the player
    if (col.needs === 'batting' && !hasBatting) return '-'
    if (col.needs === 'pitching' && !hasPitching) return '-'

    // Special W-L render
    if (col.renderFn === 'wl') return `${row.wins}-${row.losses}`

    // WAR/PA and WAR/IP custom format
    if (col.key === 'war_per_pa' || col.key === 'war_per_ip') {
      const val = row[col.key]
      return val != null ? val.toFixed(3) : '-'
    }

    const val = row[col.key]
    if (val === null || val === undefined) return '-'

    // WAR columns
    if (col.key === 'total_war' || col.key === 'offensive_war' || col.key === 'pitching_war') {
      return formatStat(val, 'war')
    }

    if (col.format) return formatStat(val, col.format)
    return val
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-2">WAR Leaderboard</h1>
      <p className="text-sm text-gray-500 mb-4">
        Custom college WAR combining offensive value (wRAA-based) and pitching value (FIP-based).
        Two-way players have both components summed. Click any stat column to sort.
      </p>

      <FilterBar
        filters={{ ...filters, _type: 'war' }}
        onChange={(f) => { setFilters(f); setPage(0) }}
        divisions={divisions}
        conferences={conferences}
      />

      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border p-8 text-center text-gray-400 animate-pulse">
          Loading WAR data...
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border overflow-auto max-h-[80vh]">
          <table className="stat-table">
            <thead className="sticky top-0 z-30">
              <tr>
                <th className="sticky-col" style={{ width: 28, minWidth: 28, position: 'sticky', left: 0, zIndex: 40 }}>#</th>
                <th className="sticky-col sticky-col-last" style={{ width: 110, minWidth: 110, maxWidth: 160, position: 'sticky', left: 28, zIndex: 40 }}>Player</th>
                <th style={{ width: 75 }}>Team</th>
                <th style={{ width: 44 }}>Lvl</th>
                <th style={{ width: 36 }}>Yr</th>
                <th style={{ width: 44 }}>Pos</th>
                {COLUMNS.map(col => (
                  <th
                    key={col.key}
                    style={{ width: col.width, cursor: 'pointer', userSelect: 'none' }}
                    title={col.title || col.label}
                    className={`${col.accent ? 'text-blue-700' : ''} ${col.key === sortBy ? 'bg-gray-100' : ''} hover:bg-gray-50`}
                    onClick={() => handleSort(col.key)}
                  >
                    {col.label}{sortIndicator(col.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(result?.data || []).map((row, i) => (
                <tr key={row.player_id} className={row.is_qualified === false ? 'italic text-gray-500' : ''}>
                  <td className="sticky-col" style={{ position: 'sticky', left: 0, zIndex: 10 }}>{page * limit + i + 1}</td>
                  <td className="sticky-col sticky-col-last" style={{ position: 'sticky', left: 28, zIndex: 10 }}>
                    <Link to={`/player/${row.player_id}`} className="player-link">
                      {row.first_name} {row.last_name}
                    </Link>
                  </td>
                  <td>
                    <Link to={`/team/${row.team_id || ''}`} className="text-gray-700 hover:text-pnw-sky flex items-center gap-1">
                      {row.logo_url && (
                        <img src={row.logo_url} alt="" className="w-4 h-4 object-contain shrink-0" loading="lazy"
                          onError={(e) => { e.target.style.display = 'none' }} />
                      )}
                      {row.team_short || row.team_name}
                    </Link>
                  </td>
                  <td>
                    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-bold ${divisionBadgeClass(row.division_level)}`}>
                      {row.division_level}
                    </span>
                  </td>
                  <td>{row.year_in_school || '-'}</td>
                  <td>{row.position}</td>
                  {COLUMNS.map(col => (
                    <td
                      key={col.key}
                      className={`font-mono text-right ${col.bold ? 'font-bold' : ''} ${col.accent ? 'text-blue-700 font-semibold' : ''} ${col.key === sortBy ? 'bg-blue-50' : ''}`}
                    >
                      {renderCell(col, row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
