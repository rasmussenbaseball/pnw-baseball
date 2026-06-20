// TrackMan Data — PRIVATE dev-only stat-table hub over all trackman_pitches.
// Filter by team / player / pitch type / handedness / min pitches; sort any
// column. One row per (player, pitch type). Reached from Misc ▸ TrackMan Data,
// which is hidden from non-dev nav, and the route is wrapped in <RequireDev>.

import { useMemo, useState } from 'react'
import { useApi } from '../hooks/useApi'

const PITCH_COLOR = {
  'Four Seam': '#e8556e', 'Sinker': '#f0a05a', 'Cutter': '#9b7d4e',
  'Slider': '#e0c84a', 'Sweeper': '#b07bd0', 'Curveball': '#5d99c6',
  'Knuckle Curve': '#3f6fa0', 'Changeup': '#8cb84f', 'Splitter': '#4aa6a6',
  'Knuckleball': '#7a8a99', 'Undefined': '#9aa0a8',
}
const dot = (pt) => PITCH_COLOR[pt] || '#9aa0a8'

// Stuff+-style grade color: 100 neutral, >100 red (better), <100 blue (worse).
function gradeColor(g) {
  if (g == null) return { bg: 'transparent', fg: 'inherit' }
  const p = Math.max(50, Math.min(150, g))
  const t = (p - 100) / 50            // -1 .. +1
  if (t >= 0) return { bg: `rgba(214,62,62,${0.12 + 0.55 * t})`, fg: t > 0.5 ? '#fff' : 'inherit' }
  return { bg: `rgba(29,78,216,${0.12 + 0.55 * -t})`, fg: -t > 0.5 ? '#fff' : 'inherit' }
}

const COLS = [
  { key: 'player', label: 'Player', align: 'left', type: 'str' },
  { key: 'team', label: 'Team', align: 'left', type: 'str' },
  { key: 'throws', label: 'T', align: 'center', type: 'str' },
  { key: 'pitch_type', label: 'Pitch', align: 'left', type: 'str' },
  { key: 'pitch_grade', label: 'Grade', align: 'right', type: 'num', fmt: (v) => v == null ? '—' : Math.round(v) },
  { key: 'pitch_count', label: '#', align: 'right', type: 'num', fmt: (v) => v ?? '—' },
  { key: 'usage_pct', label: 'Usage', align: 'right', type: 'num', fmt: (v) => v == null ? '—' : `${(+v).toFixed(1)}%` },
  { key: 'velo', label: 'Velo', align: 'right', type: 'num', fmt: (v) => v == null ? '—' : (+v).toFixed(1) },
  { key: 'spin', label: 'Spin', align: 'right', type: 'num', fmt: (v) => v == null ? '—' : Math.round(v).toLocaleString() },
  { key: 'ivb', label: 'IVB', align: 'right', type: 'num', fmt: (v) => v == null ? '—' : (+v).toFixed(1) },
  { key: 'hb', label: 'HB', align: 'right', type: 'num', fmt: (v) => v == null ? '—' : (+v).toFixed(1) },
  { key: 'tilt', label: 'Tilt', align: 'right', type: 'str', fmt: (v) => v || '—' },
  { key: 'extension', label: 'Ext', align: 'right', type: 'num', fmt: (v) => v == null ? '—' : (+v).toFixed(2) },
  { key: 'rel_height', label: 'RelHt', align: 'right', type: 'num', fmt: (v) => v == null ? '—' : (+v).toFixed(2) },
  { key: 'rel_side', label: 'RelSide', align: 'right', type: 'num', fmt: (v) => v == null ? '—' : (+v).toFixed(2) },
  { key: 'est_vaa', label: 'est VAA', align: 'right', type: 'num', fmt: (v) => v == null ? '—' : (+v).toFixed(1) },
  { key: 'in_zone_pct', label: 'Zone%', align: 'right', type: 'num', fmt: (v) => v == null ? '—' : `${(+v).toFixed(1)}` },
  { key: 'whiff_pct', label: 'Whiff%', align: 'right', type: 'num', fmt: (v) => v == null ? '—' : `${(+v).toFixed(1)}` },
  { key: 'chase_pct', label: 'Chase%', align: 'right', type: 'num', fmt: (v) => v == null ? '—' : `${(+v).toFixed(1)}` },
]

const SELECT = 'rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm px-2 py-1.5'

export default function TrackManData() {
  const { data, loading, error } = useApi('/trackman/pitches')
  const [team, setTeam] = useState('')
  const [pitch, setPitch] = useState('')
  const [throws, setThrows] = useState('')
  const [q, setQ] = useState('')
  const [minN, setMinN] = useState(0)
  const [sortKey, setSortKey] = useState('pitch_grade')
  const [sortDir, setSortDir] = useState('desc')

  const rows = data?.pitches || []

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    let out = rows.filter(r =>
      (!team || r.team === team) &&
      (!pitch || r.pitch_type === pitch) &&
      (!throws || r.throws === throws) &&
      (!ql || r.player.toLowerCase().includes(ql)) &&
      ((r.pitch_count || 0) >= minN)
    )
    const col = COLS.find(c => c.key === sortKey)
    const dir = sortDir === 'asc' ? 1 : -1
    out = [...out].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1            // nulls always last
      if (bv == null) return -1
      if (col?.type === 'num') return (Number(av) - Number(bv)) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
    return out
  }, [rows, team, pitch, throws, q, minN, sortKey, sortDir])

  const onSort = (key) => {
    if (key === sortKey) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); return }
    setSortKey(key)
    setSortDir(COLS.find(c => c.key === key)?.type === 'num' ? 'desc' : 'asc')
  }

  return (
    <div className="max-w-[1400px] mx-auto px-3 sm:px-5 py-6">
      <div className="flex items-center gap-3 flex-wrap mb-1">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">TrackMan Data</h1>
        <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded"
              style={{ background: '#fde68a', color: '#92400e' }}>🔒 Dev only</span>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Every pitch-shape row we've ingested (5+ pitches). One row per pitcher per pitch type, averaged.
        <strong> Grade</strong> is a Stuff+-style score (100 = average for that pitch type, ~50–150 range) learned from
        each type's whiff/chase outcomes. Click a column to sort.
      </p>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center mb-3">
        <input className={SELECT + ' w-44'} placeholder="Search player…" value={q} onChange={e => setQ(e.target.value)} />
        <select className={SELECT} value={team} onChange={e => setTeam(e.target.value)}>
          <option value="">All teams</option>
          {(data?.teams || []).map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className={SELECT} value={pitch} onChange={e => setPitch(e.target.value)}>
          <option value="">All pitches</option>
          {(data?.pitch_types || []).map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className={SELECT} value={throws} onChange={e => setThrows(e.target.value)}>
          <option value="">RHP+LHP</option>
          <option value="R">RHP</option>
          <option value="L">LHP</option>
        </select>
        <label className="text-sm text-gray-600 dark:text-gray-300 flex items-center gap-1">
          min #
          <input type="number" min="0" className={SELECT + ' w-20'} value={minN}
                 onChange={e => setMinN(Number(e.target.value) || 0)} />
        </label>
        {(team || pitch || throws || q || minN) && (
          <button className="text-xs text-nw-teal underline"
                  onClick={() => { setTeam(''); setPitch(''); setThrows(''); setQ(''); setMinN(0) }}>
            clear
          </button>
        )}
        <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto tabular-nums">
          {filtered.length} of {rows.length} rows
        </span>
      </div>

      {loading && <div className="py-16 text-center text-gray-400">Loading…</div>}
      {error && <div className="py-16 text-center text-red-500">Failed to load TrackMan data.</div>}

      {!loading && !error && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full text-[12px] tabular-nums">
            <thead className="sticky top-0">
              <tr className="bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                {COLS.map(c => (
                  <th key={c.key} onClick={() => onSort(c.key)}
                      className={`px-2 py-2 font-semibold cursor-pointer select-none whitespace-nowrap hover:text-nw-teal ${c.align === 'left' ? 'text-left' : c.align === 'center' ? 'text-center' : 'text-right'}`}>
                    {c.label}{sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={i} className="border-t border-gray-100 dark:border-gray-800 hover:bg-teal-50/40 dark:hover:bg-gray-800/40 text-gray-800 dark:text-gray-200">
                  {COLS.map(c => {
                    if (c.key === 'pitch_grade') {
                      const gc = gradeColor(r.pitch_grade)
                      return (
                        <td key={c.key} className="px-2 py-1.5 text-right">
                          <span className="inline-block min-w-[34px] px-1.5 py-0.5 rounded font-bold tabular-nums"
                                style={{ background: gc.bg, color: gc.fg }}>
                            {c.fmt(r.pitch_grade)}
                          </span>
                        </td>
                      )
                    }
                    return (
                      <td key={c.key} className={`px-2 py-1.5 whitespace-nowrap ${c.align === 'left' ? 'text-left' : c.align === 'center' ? 'text-center' : 'text-right'} ${c.key === 'velo' ? 'font-semibold' : ''}`}>
                        {c.key === 'pitch_type'
                          ? <span><span className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle" style={{ background: dot(r.pitch_type) }} />{r.pitch_type}</span>
                          : c.key === 'player'
                            ? <a className="hover:text-nw-teal hover:underline" href={`/summer/players/${r.summer_player_id}`}>{r.player}</a>
                            : (c.fmt ? c.fmt(r[c.key]) : r[c.key])}
                      </td>
                    )
                  })}
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={COLS.length} className="px-2 py-10 text-center text-gray-400">No rows match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
