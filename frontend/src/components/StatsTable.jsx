import { useState } from 'react'
import { Link } from 'react-router-dom'
import { formatStat, divisionBadgeClass } from '../utils/stats'
import { useAffiliatedTeam } from '../context/AffiliationContext'

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
  // "Your team" highlight — Coach/Dev users who've designated a team
  // get their players' rows tinted amber across every StatsTable on
  // the site (leaderboards, summer, etc).
  const { team: affiliatedTeam } = useAffiliatedTeam()
  const affiliatedTeamId = affiliatedTeam?.id ?? null
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
      // On rosters / team-page stat tables the "#" column should show the
      // player's actual jersey number, not a positional rank. We detect that
      // by the row carrying a `jersey_number` field (team-page responses do;
      // leaderboards don't). Fall back to the row index everywhere else so
      // global leaderboards keep their natural 1, 2, 3, ... ranking.
      if ('jersey_number' in row) {
        const j = row.jersey_number
        return (j === null || j === undefined || j === '') ? '—' : j
      }
      return offset + rowIndex + 1
    }

    if (col.key === 'name' || col.render) {
      const name = col.render ? col.render(row) : `${row.first_name} ${row.last_name}`
      if (col.noLink) {
        return <span className="font-medium text-gray-900">{name}</span>
      }
      // linkKey: use an alternate row field for the player ID (e.g. spring_player_id for summer players)
      const linkId = col.linkKey ? row[col.linkKey] : (row.player_id || row.id)
      if (!linkId) {
        return <span className="font-medium text-gray-900">{name}</span>
      }
      return (
        <Link to={`/player/${linkId}`} className="player-link">
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
      const teamContent = (
        <span className={`flex items-center gap-1.5 ${col.noLink ? 'text-gray-700' : 'text-gray-700 hover:text-pnw-sky'}`}>
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
        </span>
      )
      if (col.noLink) return teamContent
      return <Link to={`/team/${row.team_id}`}>{teamContent}</Link>
    }

    // Format stat value
    const value = row[col.key]
    return formatStat(value, col.format)
  }

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700
                      p-8 text-center text-gray-400 dark:text-gray-500">
        <div className="animate-pulse">Loading stats...</div>
      </div>
    )
  }

  if (!data.length) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700
                      p-8 text-center text-gray-500 dark:text-gray-400">
        No data found. Try adjusting your filters or check back when data has been loaded.
      </div>
    )
  }

  // Determine which columns should be sticky (rank + name on mobile)
  // We track cumulative left offsets for sticky positioning
  const stickyKeys = ['rank', 'name']
  let cumulativeLeft = 0
  const stickyMeta = {}
  displayColumns.forEach(col => {
    if (stickyKeys.includes(col.key)) {
      stickyMeta[col.key] = { left: cumulativeLeft }
      // Use compact widths for sticky cols on mobile
      const w = col.key === 'rank' ? 28 : 110
      cumulativeLeft += w
    }
  })

  const stickyStyle = (col, isHeader = false) => {
    if (!stickyMeta[col.key]) return {}
    return {
      position: 'sticky',
      left: stickyMeta[col.key].left,
      zIndex: isHeader ? 20 : 10,
      minWidth: col.key === 'rank' ? 28 : 110,
      maxWidth: col.key === 'rank' ? 28 : 160,
    }
  }

  const stickyClass = (col, isHeader = false) => {
    if (!stickyMeta[col.key]) return ''
    // Shadow on the last sticky column to indicate scroll boundary
    const isLast = col.key === stickyKeys[stickyKeys.length - 1]
    return `sticky-col ${isLast ? 'sticky-col-last' : ''}`
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-auto max-h-[80vh]">
      <table className="stat-table">
        <thead className="sticky top-0 z-30">
          <tr>
            {displayColumns.map(col => (
              <th
                key={col.key}
                onClick={() => handleHeaderClick(col)}
                className={`${sortBy === col.key ? 'sorted' : ''} ${col.sortable === false ? 'cursor-default' : ''} ${stickyClass(col, true)}`}
                style={{ ...( stickyMeta[col.key] ? stickyStyle(col, true) : { minWidth: col.width }), ...(stickyMeta[col.key] ? { zIndex: 40 } : {}) }}
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
          {data.map((row, i) => {
            const isMyTeam = (
              affiliatedTeamId
              && (row.team_id === affiliatedTeamId
                  || row.tm_id === affiliatedTeamId)
            )
            const rowClasses = [
              row.is_qualified === false ? 'italic text-gray-500' : '',
              // Subtle amber tint + thicker left accent for the user's
              // affiliated team. Visible in both light + dark mode.
              isMyTeam
                ? 'bg-amber-50/70 dark:bg-amber-900/20 border-l-4 border-l-amber-400'
                : '',
            ].filter(Boolean).join(' ')
            return (
              <tr key={row.id || row.player_id || i} className={rowClasses}>
                {displayColumns.map(col => (
                  <td
                    key={col.key}
                    className={`${col.format === 'avg' || col.format === 'era' || col.format === 'war' || col.format === 'pct' || col.format === 'pctRaw' || col.format === 'int' || col.format === 'ip' ? 'font-mono text-right' : ''} ${stickyClass(col)}`}
                    style={stickyMeta[col.key] ? stickyStyle(col) : undefined}
                  >
                    {renderCell(row, col, i)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
