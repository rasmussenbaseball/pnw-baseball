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

const PITCH_CODE = {
  'Four Seam': 'FF', 'Sinker': 'SI', 'Cutter': 'FC', 'Slider': 'SL', 'Sweeper': 'SW',
  'Curveball': 'CU', 'Knuckle Curve': 'KC', 'Changeup': 'CH', 'Splitter': 'FS', 'Knuckleball': 'KN',
}
const code = (pt) => PITCH_CODE[pt] || (pt || '?').slice(0, 2).toUpperCase()

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
  const [view, setView] = useState('pitches')   // 'pitches' | 'arsenals'
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

  // Arsenal view: group graded pitches by pitcher, usage-weighted overall grade.
  const arsenals = useMemo(() => {
    const ql = q.trim().toLowerCase()
    const byP = {}
    for (const r of rows) {
      if (r.pitch_grade == null) continue
      const key = `${r.summer_player_id}-${r.season}`
      if (!byP[key]) byP[key] = { id: r.summer_player_id, player: r.player, team: r.team, throws: r.throws, pitches: [] }
      byP[key].pitches.push(r)
    }
    let out = Object.values(byP).map(a => {
      const tot = a.pitches.reduce((s, p) => s + (p.pitch_count || 0), 0)
      const wsum = a.pitches.reduce((s, p) => s + Number(p.pitch_grade) * (p.pitch_count || 0), 0)
      return {
        ...a,
        total: tot,
        nTypes: a.pitches.length,
        arsenal: tot > 0 ? wsum / tot : null,
        pitches: [...a.pitches].sort((x, y) => (Number(y.usage_pct) || 0) - (Number(x.usage_pct) || 0)),
      }
    })
    out = out.filter(a =>
      a.arsenal != null && a.total >= 20 && a.nTypes >= 2 &&
      (!team || a.team === team) && (!throws || a.throws === throws) &&
      (!ql || a.player.toLowerCase().includes(ql)) && (a.total >= minN))
    out.sort((x, y) => y.arsenal - x.arsenal)
    return out
  }, [rows, team, throws, q, minN])

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
        each type's whiff/chase outcomes. Click a column to sort. The
        <strong> Arsenals</strong> tab grades each pitcher's full mix (usage-weighted overall grade + per-pitch breakdown).
      </p>

      {/* Tabs */}
      <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden mb-3">
        {[['pitches', 'Pitches'], ['arsenals', 'Arsenals']].map(([k, label]) => (
          <button key={k} onClick={() => setView(k)}
            className={`px-4 py-1.5 text-sm font-semibold transition-colors ${view === k ? 'bg-nw-teal text-white' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center mb-3">
        <input className={SELECT + ' w-44'} placeholder="Search player…" value={q} onChange={e => setQ(e.target.value)} />
        <select className={SELECT} value={team} onChange={e => setTeam(e.target.value)}>
          <option value="">All teams</option>
          {(data?.teams || []).map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        {view === 'pitches' && (
          <select className={SELECT} value={pitch} onChange={e => setPitch(e.target.value)}>
            <option value="">All pitches</option>
            {(data?.pitch_types || []).map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
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
          {view === 'pitches' ? `${filtered.length} of ${rows.length} rows` : `${arsenals.length} pitchers`}
        </span>
      </div>

      {loading && <div className="py-16 text-center text-gray-400">Loading…</div>}
      {error && <div className="py-16 text-center text-red-500">Failed to load TrackMan data.</div>}

      {!loading && !error && view === 'pitches' && (
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

      {!loading && !error && view === 'arsenals' && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0">
              <tr className="bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                <th className="px-2 py-2 text-right font-semibold w-10">#</th>
                <th className="px-2 py-2 text-left font-semibold">Pitcher</th>
                <th className="px-2 py-2 text-left font-semibold">Team</th>
                <th className="px-2 py-2 text-center font-semibold">T</th>
                <th className="px-2 py-2 text-right font-semibold">Arsenal</th>
                <th className="px-2 py-2 text-right font-semibold whitespace-nowrap"># P</th>
                <th className="px-2 py-2 text-left font-semibold">Breakdown (by usage)</th>
              </tr>
            </thead>
            <tbody>
              {arsenals.map((a, i) => {
                const gc = gradeColor(a.arsenal)
                return (
                  <tr key={a.id} className="border-t border-gray-100 dark:border-gray-800 hover:bg-teal-50/40 dark:hover:bg-gray-800/40 text-gray-800 dark:text-gray-200">
                    <td className="px-2 py-2 text-right text-gray-400 tabular-nums">{i + 1}</td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <a className="font-semibold hover:text-nw-teal hover:underline" href={`/summer/players/${a.id}`}>{a.player}</a>
                    </td>
                    <td className="px-2 py-2 text-left text-gray-500 dark:text-gray-400 whitespace-nowrap">{a.team}</td>
                    <td className="px-2 py-2 text-center text-gray-500 dark:text-gray-400">{a.throws || ''}</td>
                    <td className="px-2 py-2 text-right">
                      <span className="inline-block min-w-[40px] px-2 py-1 rounded font-bold text-[15px] tabular-nums"
                            style={{ background: gc.bg, color: gc.fg }}>{Math.round(a.arsenal)}</span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-gray-500 dark:text-gray-400">{a.nTypes}</td>
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap gap-1.5">
                        {a.pitches.map((p, j) => {
                          const pc = gradeColor(p.pitch_grade)
                          return (
                            <span key={j} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 border border-gray-200 dark:border-gray-700 whitespace-nowrap">
                              <span className="inline-block w-2 h-2 rounded-full" style={{ background: dot(p.pitch_type) }} />
                              <span className="font-semibold text-gray-700 dark:text-gray-300">{code(p.pitch_type)}</span>
                              <span className="px-1 rounded font-bold tabular-nums" style={{ background: pc.bg, color: pc.fg }}>{Math.round(p.pitch_grade)}</span>
                              <span className="text-[10px] text-gray-400 tabular-nums">{p.usage_pct == null ? '' : `${Math.round(p.usage_pct)}%`}</span>
                            </span>
                          )
                        })}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {arsenals.length === 0 && (
                <tr><td colSpan={7} className="px-2 py-10 text-center text-gray-400">No pitchers match these filters (need 2+ graded pitches, 20+ tracked).</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
