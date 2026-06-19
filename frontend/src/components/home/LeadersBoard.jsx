/**
 * Wide, short "Stat Leaders" board for the top of the homepage. Top 3 in each
 * of 9 hitting + 9 pitching categories, filterable by division. Small text so
 * all 18 categories fit in a couple of rows. Data: /api/v1/home/leaders.
 */
import { useState } from 'react'
import { useApi } from '../../hooks/useApi'
import { WidgetCard } from './WidgetShell'
import { divisionBadgeClass } from '../../utils/stats'

const DIVISIONS = ['all', 'D1', 'D2', 'D3', 'NAIA', 'NWAC']

// "Jason Wright" -> "J. Wright"
function abbr(name) {
  const parts = (name || '').trim().split(/\s+/)
  if (parts.length < 2) return name
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`
}

function LevelChip({ level }) {
  if (!level) return null
  return (
    <span className={`text-[7px] font-bold leading-none px-1 py-px rounded ${divisionBadgeClass(level === 'NWAC' ? 'JUCO' : level)}`}>
      {level}
    </span>
  )
}

function StatCell({ cat, showLevel }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-bold uppercase tracking-wide text-nw-teal truncate">{cat.label}</div>
      <div className="mt-0.5 space-y-px">
        {cat.leaders.length === 0 && <div className="text-[10px] text-gray-300 dark:text-gray-600">—</div>}
        {cat.leaders.map((l, i) => (
          <div key={i} className="flex items-baseline gap-1 text-[10px] leading-tight">
            <span className="text-gray-400 dark:text-gray-500 w-2 shrink-0">{i + 1}</span>
            <span className="font-medium text-pnw-slate dark:text-gray-200 truncate">{abbr(l.name)}</span>
            {showLevel && <LevelChip level={l.level} />}
            <span className="ml-auto font-bold tabular-nums text-gray-700 dark:text-gray-300 shrink-0">{l.display}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Side({ title, cats, showLevel }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">{title}</div>
      <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-x-3 gap-y-2">
        {cats.map((c) => <StatCell key={c.key} cat={c} showLevel={showLevel} />)}
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
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded transition-colors ${
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
        <div className="flex flex-col lg:flex-row gap-4 lg:gap-6">
          <Side title="Hitting" cats={data.hitting} showLevel={division === 'all'} />
          <div className="hidden lg:block w-px bg-gray-200 dark:bg-gray-700 self-stretch" />
          <Side title="Pitching" cats={data.pitching} showLevel={division === 'all'} />
        </div>
      )}
    </WidgetCard>
  )
}
