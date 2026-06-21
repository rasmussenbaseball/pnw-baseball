/**
 * Wide "Stat Leaders" board for the top of the homepage. Top 3 in each of
 * 9 hitting + 9 pitching categories, filterable by division. Two full-width
 * rows (hitting, then pitching) so every category column is wide enough to
 * read; team logos identify each leader. Data: /api/v1/home/leaders.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../../hooks/useApi'
import { WidgetCard } from './WidgetShell'

const DIVISIONS = ['all', 'D1', 'D2', 'D3', 'NAIA', 'NWAC', 'WCL']

// "Jason Wright" -> "J. Wright"
function abbr(name) {
  const parts = (name || '').trim().split(/\s+/)
  if (parts.length < 2) return name
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`
}

function StatCell({ cat }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-bold uppercase tracking-wide text-nw-teal truncate border-b border-gray-100 dark:border-gray-700 pb-0.5 mb-1">
        {cat.label}
      </div>
      <div className="space-y-1">
        {cat.leaders.length === 0 && <div className="text-[11px] text-gray-300 dark:text-gray-600">—</div>}
        {cat.leaders.map((l, i) => (
          <div key={i} className="flex items-center gap-1 text-[11px] leading-tight tracking-tight">
            {l.logo
              ? <img src={l.logo} alt="" className="w-3.5 h-3.5 object-contain shrink-0" onError={(e) => { e.target.style.visibility = 'hidden' }} />
              : <span className="w-3.5 shrink-0" />}
            {l.player_id
              ? <Link to={`/player/${l.player_id}`} className="font-medium text-pnw-slate dark:text-gray-200 truncate hover:text-nw-teal dark:hover:text-nw-teal hover:underline" title={l.name}>{abbr(l.name)}</Link>
              : <span className="font-medium text-pnw-slate dark:text-gray-200 truncate" title={l.name}>{abbr(l.name)}</span>}
            <span className="ml-auto pl-0.5 font-bold tabular-nums text-gray-700 dark:text-gray-300 shrink-0">{l.display}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Side({ title, cats }) {
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">{title}</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-9 gap-x-2.5 gap-y-3">
        {cats.map((c) => <StatCell key={c.key} cat={c} />)}
      </div>
    </div>
  )
}

export function LeadersBoard() {
  const [division, setDivision] = useState('all')
  const { data, loading, error } = useApi('/home/leaders', { division }, [division])

  const pills = (
    <div className="flex gap-0.5">
      {DIVISIONS.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => setDivision(d)}
          className={`text-[11px] font-bold px-2 py-0.5 rounded transition-colors ${
            division === d ? 'bg-white text-nw-teal' : 'text-white/80 hover:bg-white/20'
          }`}
        >
          {d === 'all' ? 'All' : d}
        </button>
      ))}
    </div>
  )

  return (
    <WidgetCard title="Stat Leaders"
      to={division === 'WCL' ? '/summer/stats' : '/stat-leaders'}
      linkLabel={division === 'WCL' ? 'WCL leaders' : 'Full leaders'}
      controls={pills}>
      {loading && <div className="py-6 text-center text-xs text-gray-400 animate-pulse">Loading leaders…</div>}
      {error && <div className="py-6 text-center text-xs text-gray-400">Leaders are unavailable right now.</div>}
      {data && !loading && (
        <div className="space-y-3">
          <Side title="Hitting" cats={data.hitting} />
          <div className="h-px bg-gray-200 dark:bg-gray-700" />
          <Side title="Pitching" cats={data.pitching} />
        </div>
      )}
    </WidgetCard>
  )
}
