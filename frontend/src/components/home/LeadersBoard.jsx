/**
 * Wide "Stat Leaders" board for the top of the homepage. Top 3 in each of
 * 9 hitting + 9 pitching categories, filterable by division. Two full-width
 * rows (hitting, then pitching) so every category column is wide enough to
 * read; team logos identify each leader. Data: /api/v1/home/leaders.
 */
import { useState } from 'react'
import { useApi } from '../../hooks/useApi'
import { WidgetCard } from './WidgetShell'

const DIVISIONS = ['all', 'D1', 'D2', 'D3', 'NAIA', 'NWAC']

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
        {cat.leaders.length === 0 && <div className="text-xs text-gray-300 dark:text-gray-600">—</div>}
        {cat.leaders.map((l, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs leading-tight">
            <span className="text-gray-400 dark:text-gray-500 w-2 shrink-0 text-[10px]">{i + 1}</span>
            {l.logo
              ? <img src={l.logo} alt="" className="w-4 h-4 object-contain shrink-0" onError={(e) => { e.target.style.visibility = 'hidden' }} />
              : <span className="w-4 shrink-0" />}
            <span className="font-medium text-pnw-slate dark:text-gray-200 truncate" title={l.name}>{abbr(l.name)}</span>
            <span className="ml-auto font-bold tabular-nums text-gray-700 dark:text-gray-300 shrink-0">{l.display}</span>
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
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-9 gap-x-4 gap-y-3">
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
    <WidgetCard title="Stat Leaders" to="/stat-leaders" linkLabel="Full leaders" controls={pills}>
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
