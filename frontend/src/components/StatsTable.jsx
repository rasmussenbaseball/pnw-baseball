import { useState } from 'react'
import { Link } from 'react-router-dom'
import { formatStat, divisionBadgeClass } from '../utils/stats'

/**
 * StatsTable - sortable, configurable stats table.
 * Used for both batting and pitching leaderboards.
 */
export default function StatsTable({
  data = [],
  columns = [],
  visibleColumns = null,
  sortBy,
  sortDir,
  onSort,
  loading = false,
  offset = 0,
}) {
  // Filter to visible columns if specified
  const displayColumns = visibleColumns
    ? columns.filter(c => visibleColumns.includes(c.key) || c.sortable === false)
    : columns

  const handleHeaderClick = (col) => {
    if (col.sortable === false) return
    if (sortBy === col.key) {
      onSort?.(col.key, sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      // Default sort direction based on stat type
      const defaultDesc = ['home_runs', 'rbi', 'hits', 'runs', 'stolen_bases',
        'batting_avg', 'on_base_pct', 'slugging_pct', 'ops', 'woba', 'wrc_plus',
        'iso', 'offensive_war', 'strikeouts', 'k_per_9', 'k_bb_ratio',
        'pitching_war', 'wins', 'saves', 'lob_pct', 'fip_plus']
      const dir = defaultDesc.includes(col.key) ? 'desc' : 'asc'
      onSort?.(col.key, dir)
    }
  }

  const renderCell = (row, col, rowIndex) => {
    // Special column renderers
    if (col.key === 'rank') {
      return offset + rowIndex + 1
    }

    if (col.key === 'name' || col.render) {
      const name = col.render ? col.render(row) : `${row.first_name} ${row.last_name}`
      return (
        <Link to={`/player/${row.player_id || row.id}`} className="player-link">
          {name}
        </Link>
      )
    }

    if (col.key === 'division_level') {
      return (
        <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-bold ${divisionBadgeClass(row.division_level)}`}>
          {row.division_level}
        </span>
      )
    }

    if (col.key === 'team_short') {
      return (
        <Link to={`/team/${row.team_id}`} className="text-gray-700 hover:text-pnw-sky flex items-center gap-1.5">
          {row.logo_url && (
            <img
              src={row.logo_url}
              alt=""
              className="w-5 h-5 object-contain shrink-0"
              loading="lazy"
              onError={(e) => { e.target.style.display = 'none' }}
            />
          )}
          {row.team_short || row.team_name}
        </Link>
      )
    }

    // Format stat value
    const value = row[col.key]
    return formatStat(value, col.format)
  }

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow-sm border p-8 text-center text-gray-400">
        <div className="animate-pulse">Loading stats...</div>
      </div>
    )
  }

  if (!data.length) {
    return (
      <div className="bg-white rounded-lg shadow-sm border p-8 text-center text-gray-500">
        No data found. Try adjusting your filters or check back when data has been loaded.
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border overflow-x-auto">
      <table className="stat-table">
        <thead>
          <tr>
            {displayColumns.map(col => (
              <th
                key={col.key}
                onClick={() => handleHeaderClick(col)}
                className={`${sortBy === col.key ? 'sorted' : ''} ${col.sortable === false ? 'cursor-default' : ''}`}
                style={{ minWidth: col.width }}
                title={col.tooltip || col.label}
              >
                <div className="flex items-center gap-1">
                  {col.label}
                  {sortBy === col.key && (
                    <span className="text-xs">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={row.id || row.player_id || i}>
              {displayColumns.map(col => (
                <td key={col.key} className={col.format === 'avg' || col.format === 'era' || col.format === 'war' ? 'font-mono text-right' : ''}>
                  {renderCell(row, col, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
