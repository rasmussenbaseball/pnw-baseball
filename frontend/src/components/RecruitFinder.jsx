// RecruitFinder — search uncommitted NWAC / transfer-portal / WCL-portal players by
// position + predictive-stat archetypes or custom value/percentile filters.
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { finderMeta, finderSearch } from '../lib/recruitingBoards'
import AddToBoardButton from './AddToBoardButton'

const POSITIONS = [
  ['any', 'Any hitter'], ['c', 'Catcher'], ['if', 'Infield (any)'],
  ['1b', '1B'], ['2b', '2B'], ['ss', 'SS'], ['3b', '3B'],
  ['mid_if', 'Middle IF (2B/SS)'], ['corner_if', 'Corner IF (1B/3B)'],
  ['of', 'Outfield (any)'], ['corner_of', 'Corner OF (LF/RF)'], ['cf', 'CF'],
]

// stats shown in every result row (compact predictive set)
const SHOWN = ['wrc_plus', 'iso', 'wobacon', 'k_pct', 'bb_pct', 'air_pull_pct', 'contact_pct', 'sb']
const PCT_STATS = new Set(['k_pct', 'bb_pct', 'air_pull_pct', 'contact_pct', 'whiff_pct', 'gb_pct'])
const RATE3 = new Set(['iso', 'wobacon', 'avg', 'obp', 'slg', 'ops', 'woba', 'babip'])

function fmtStat(key, v) {
  if (v == null) return '–'
  if (PCT_STATS.has(key)) return (v * 100).toFixed(1) + '%'
  if (RATE3.has(key)) return v.toFixed(3).replace(/^0/, '')
  if (key === 'wrc_plus') return Math.round(v)
  return v
}

function pctColor(p) {
  if (p == null) return undefined
  // teal scale: low gray -> strong teal
  if (p >= 80) return '#0f766e'
  if (p >= 60) return '#14b8a6'
  if (p >= 40) return '#6b7280'
  return '#9ca3af'
}

export default function RecruitFinder() {
  const [meta, setMeta] = useState(null)
  const [position, setPosition] = useState('any')
  const [bats, setBats] = useState('any')
  const [archetype, setArchetype] = useState('')
  const [filters, setFilters] = useState([])
  const [results, setResults] = useState(null)
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { finderMeta().then(setMeta).catch(e => setError(e.message)) }, [])

  function addFilter() {
    setFilters(f => [...f, { stat: 'air_pull_pct', mode: 'percentile', op: 'min', value: 75 }])
  }
  function setFilter(i, k, v) { setFilters(f => f.map((x, j) => j === i ? { ...x, [k]: v } : x)) }
  function rmFilter(i) { setFilters(f => f.filter((_, j) => j !== i)) }

  async function run() {
    setLoading(true); setError(''); setResults(null)
    try {
      const body = {
        position, bats,
        archetype: archetype || null,
        filters: filters.filter(f => f.value !== '' && f.value != null)
          .map(f => ({ ...f, value: parseFloat(f.value) })),
        limit: 80,
      }
      const d = await finderSearch(body)
      setResults(d.results || [])
      setInfo({ count: d.count, pool: d.pool_size, archetype: d.archetype })
    } catch (e) { setError(e.message || 'Search failed.') }
    finally { setLoading(false) }
  }

  const archetypes = meta?.archetypes || []
  const allStats = meta?.stats || []

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Labeled label="Position">
            <select value={position} onChange={e => setPosition(e.target.value)} className={SEL}>
              {POSITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Labeled>
          <Labeled label="Bats">
            <select value={bats} onChange={e => setBats(e.target.value)} className={SEL}>
              <option value="any">Any</option><option value="L">Left</option>
              <option value="R">Right</option><option value="S">Switch</option>
            </select>
          </Labeled>
          <Labeled label="Archetype">
            <select value={archetype} onChange={e => setArchetype(e.target.value)} className={SEL}>
              <option value="">None (custom / best available)</option>
              {archetypes.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
            </select>
          </Labeled>
          <button onClick={run} disabled={loading}
            className="ml-auto rounded-lg bg-nw-teal text-white text-sm font-semibold px-5 py-2 hover:bg-nw-teal-dark disabled:opacity-50">
            {loading ? 'Searching…' : 'Find recruits'}
          </button>
        </div>

        {archetype && (
          <p className="mt-2 text-[12px] text-gray-500">
            {archetypes.find(a => a.key === archetype)?.label} ranks by a blend of{' '}
            {(archetypes.find(a => a.key === archetype)?.stats || [])
              .map(s => allStats.find(m => m.key === s)?.label || s).join(', ')}.
          </p>
        )}

        {/* Custom filters */}
        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Filters (optional)</span>
            <button onClick={addFilter} className="text-[12px] font-semibold text-nw-teal hover:underline">+ Add filter</button>
          </div>
          {filters.length === 0 && (
            <p className="text-[12px] text-gray-400">
              e.g. Air-Pull% · percentile · min · 75, or AVG · value · min · 0.300
            </p>
          )}
          <div className="space-y-1.5">
            {filters.map((f, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5">
                <select value={f.stat} onChange={e => setFilter(i, 'stat', e.target.value)} className={SEL}>
                  {allStats.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                <select value={f.mode} onChange={e => setFilter(i, 'mode', e.target.value)} className={SEL}>
                  <option value="value">value</option><option value="percentile">percentile</option>
                </select>
                <select value={f.op} onChange={e => setFilter(i, 'op', e.target.value)} className={SEL}>
                  <option value="min">at least</option><option value="max">at most</option>
                </select>
                <input type="number" step="any" value={f.value}
                  onChange={e => setFilter(i, 'value', e.target.value)}
                  className={SEL + ' w-24'}
                  placeholder={f.mode === 'percentile' ? '75' : '.300'} />
                {f.mode === 'percentile' && <span className="text-[11px] text-gray-400">th pctile</span>}
                <button onClick={() => rmFilter(i)} className="text-gray-300 hover:text-red-500 text-lg leading-none">×</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-900/20 rounded px-3 py-2">{error}</div>}

      {/* Results */}
      {results && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 text-[12px] text-gray-500">
            {info.count} match{info.count === 1 ? '' : 'es'} from {info.pool} uncommitted players
            {info.count > results.length && ` · showing top ${results.length}`}
          </div>
          {results.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-400">No players match those filters. Try loosening them.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-gray-400 border-b border-gray-100 dark:border-gray-700">
                    <th className="text-left font-semibold px-3 py-2">Player</th>
                    <th className="text-left font-semibold px-2 py-2">Pos</th>
                    <th className="text-left font-semibold px-2 py-2">B</th>
                    <th className="text-left font-semibold px-2 py-2">Source</th>
                    {info.archetype && <th className="text-right font-semibold px-2 py-2">Fit</th>}
                    {SHOWN.map(s => <th key={s} className="text-right font-semibold px-2 py-2">{meta?.stats.find(m => m.key === s)?.label || s}</th>)}
                    <th className="px-2 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {results.map(r => (
                    <tr key={r.player_id} className="border-b border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Link to={`/player/${r.player_id}`} className="font-semibold text-nw-teal hover:underline">{r.name}</Link>
                        <span className="text-[11px] text-gray-400 ml-1.5">{r.team}</span>
                      </td>
                      <td className="px-2 py-2 text-gray-600 dark:text-gray-300">{r.position}</td>
                      <td className="px-2 py-2 text-gray-500">{r.bats}</td>
                      <td className="px-2 py-2">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${r.source === 'NWAC' ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300' : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'}`}>{r.source}</span>
                      </td>
                      {info.archetype && (
                        <td className="px-2 py-2 text-right font-bold tabular-nums" style={{ color: pctColor(r.score) }}>{r.score ?? '–'}</td>
                      )}
                      {SHOWN.map(s => (
                        <td key={s} className="px-2 py-2 text-right tabular-nums" style={{ color: pctColor(r.pcts?.[s]) }}>
                          {fmtStat(s, r.stats?.[s])}
                        </td>
                      ))}
                      <td className="px-2 py-2 text-right">
                        <AddToBoardButton player={{ id: r.player_id, name: r.name, position: r.position, team_name: r.team }}
                          className="!px-2 !py-1 !text-[12px]" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const SEL = 'rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-nw-teal focus:border-transparent'

function Labeled({ label, children }) {
  return (
    <label className="block">
      <span className="block text-[10.5px] font-semibold uppercase tracking-wide text-gray-400 mb-1">{label}</span>
      {children}
    </label>
  )
}
