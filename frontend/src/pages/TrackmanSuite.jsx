// TrackmanSuite — Coach/Scout Portal workspace for TrackMan game data.
//
// Coaches upload raw TrackMan V3 game CSVs (the standard 167-column export
// from any TrackMan-equipped field) and get session-aware analysis:
//   Overview — upload + session library (games / scrimmages / BP)
//   Pitching — per-pitcher arsenals: usage, velo, shape (IVB/HB/spin),
//              zone%, whiff%, chase%, CSW%, contact allowed
//   Hitting  — per-batter contact quality with the live-vs-BP transfer gap
//
// All data is owner-scoped server-side (WHERE owner_user_id = you), so a
// coach only ever sees their own uploads. Re-uploads are always safe:
// pitches dedupe on TrackMan's global PitchUID. Phase 1 of the suite —
// roadmap in TRACKMAN_SUITE_DESIGN.md (outline by intern Trevor Kazahaya).

import { useMemo, useRef, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { supabase } from '../lib/supabase'
import InternCredit from '../components/InternCredit'

const fmt = (v, d = 1) => (v === null || v === undefined ? '–' : Number(v).toFixed(d))
const PITCH_COLORS = {
  Fastball: '#ef4444', 'Four-Seam': '#ef4444', Sinker: '#f59e0b', Cutter: '#8b5cf6',
  Slider: '#3b82f6', Sweeper: '#14b8a6', Curveball: '#22c55e', ChangeUp: '#ec4899',
  Changeup: '#ec4899', Splitter: '#0891b2', Knuckleball: '#78716c',
}
const TYPE_META = {
  game: { label: 'Game', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' },
  scrimmage: { label: 'Scrimmage', cls: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300' },
  bp: { label: 'BP', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
}

async function authHeaders() {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export default function TrackmanSuite() {
  const [tab, setTab] = useState('overview')
  const { data: overview, refetch } = useApi('/trackman/overview')
  const hasData = (overview?.totals?.pitches || 0) > 0

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-5 py-5">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">TrackMan Suite</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 max-w-2xl">
          Upload your program's TrackMan game CSVs and turn them into arsenals, contact
          quality, and practice-to-game answers. Private to your staff; re-uploads never
          double count.
        </p>
        <InternCredit names="Trevor Kazahaya" className="mt-1" />
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 mb-4">
        {[['overview', 'Overview & Upload'], ['pitching', 'Pitching'], ['hitting', 'Hitting']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
              tab === k
                ? 'bg-portal-purple text-white'
                : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 ring-1 ring-gray-200 dark:ring-gray-700 hover:ring-portal-purple/50'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab overview={overview} refetch={refetch} />}
      {tab === 'pitching' && (hasData ? <PitchingTab /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'hitting' && (hasData ? <HittingTab /> : <EmptyNudge onGo={() => setTab('overview')} />)}
    </div>
  )
}

function EmptyNudge({ onGo }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-10 text-center">
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">No TrackMan data yet. Upload your first session CSVs to get started.</p>
      <button onClick={onGo} className="rounded-lg bg-portal-purple text-white text-sm font-semibold px-4 py-2">
        Go to upload
      </button>
    </div>
  )
}

// ── Overview & Upload ────────────────────────────────────────────

function OverviewTab({ overview, refetch }) {
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState(null)
  const inputRef = useRef(null)
  const totals = overview?.totals || { sessions: 0, pitches: 0, bbe: 0, by_type: {} }
  const sessions = overview?.sessions || []

  async function handleFiles(fileList) {
    const files = [...fileList].filter(f => f.name.toLowerCase().endsWith('.csv'))
    if (!files.length) return
    setBusy(true); setReport(null)
    try {
      const fd = new FormData()
      files.forEach(f => fd.append('files', f))
      const res = await fetch('/api/v1/portal/trackman/upload', {
        method: 'POST', body: fd, headers: await authHeaders(),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
      setReport(await res.json())
      refetch()
    } catch (e) {
      setReport({ errors: [{ file: 'upload', error: e.message }], results: [], uploaded: 0 })
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function removeSession(id) {
    if (!confirm('Delete this session and all its pitches?')) return
    await fetch(`/api/v1/trackman/sessions/${id}`, { method: 'DELETE', headers: await authHeaders() })
    refetch()
  }

  const added = (report?.results || []).reduce((a, r) => a + (r.pitches_added || 0), 0)
  const skipped = (report?.results || []).reduce((a, r) => a + (r.duplicates_skipped || 0), 0)

  return (
    <div className="space-y-4">
      {/* Totals strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {[
          ['Sessions', totals.sessions],
          ['Tracked pitches', (totals.pitches || 0).toLocaleString()],
          ['Balls in play', (totals.bbe || 0).toLocaleString()],
          ['Games / Scrim / BP', `${totals.by_type?.game || 0} / ${totals.by_type?.scrimmage || 0} / ${totals.by_type?.bp || 0}`],
        ].map(([label, value]) => (
          <div key={label} className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 px-4 py-3">
            <div className="text-2xl font-bold text-portal-purple dark:text-gray-100 tabular-nums leading-none">{value}</div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mt-1.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Upload zone */}
      <div
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); handleFiles(e.dataTransfer.files) }}
        className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-dashed ring-gray-300 dark:ring-gray-600 p-6 text-center">
        <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          {busy ? 'Uploading & parsing…' : 'Drop TrackMan game CSVs here'}
        </p>
        <p className="text-xs text-gray-400 mt-0.5 mb-3">
          The standard V3 export (167 columns). Multiple files at once is fine; duplicates are skipped automatically.
        </p>
        <input ref={inputRef} type="file" accept=".csv" multiple className="hidden"
          onChange={e => handleFiles(e.target.files)} />
        <button onClick={() => inputRef.current?.click()} disabled={busy}
          className="rounded-lg bg-portal-purple text-white text-sm font-semibold px-4 py-2 disabled:opacity-50">
          {busy ? 'Working…' : 'Choose files'}
        </button>
        {report && (
          <div className="mt-3 text-xs">
            {report.results?.length > 0 && (
              <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                {report.uploaded} file{report.uploaded === 1 ? '' : 's'} in: {added.toLocaleString()} pitches added, {skipped.toLocaleString()} duplicates skipped.
              </span>
            )}
            {(report.errors || []).map((e, i) => (
              <div key={i} className="text-rose-600 dark:text-rose-400 mt-1">{e.file}: {e.error}</div>
            ))}
          </div>
        )}
      </div>

      {/* Session library */}
      <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 text-[11px] font-bold uppercase tracking-wide text-gray-400">
          Session library
        </div>
        {sessions.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">No sessions yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="px-4 py-2">Date</th><th className="px-2 py-2">Type</th>
                  <th className="px-2 py-2">Matchup</th><th className="px-2 py-2 text-right">Pitches</th>
                  <th className="px-2 py-2 text-right">BBE</th><th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {sessions.map(s => {
                  const t = TYPE_META[s.session_type] || TYPE_META.scrimmage
                  return (
                    <tr key={s.id}>
                      <td className="px-4 py-2 whitespace-nowrap text-gray-700 dark:text-gray-200">{s.session_date || '–'}</td>
                      <td className="px-2 py-2"><span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${t.cls}`}>{t.label}</span></td>
                      <td className="px-2 py-2 text-gray-500 dark:text-gray-400">
                        {s.session_type === 'bp' ? (s.stadium || 'BP') : `${s.away_team || '?'} @ ${s.home_team || '?'}`}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{s.pitch_count}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{s.bbe_count}</td>
                      <td className="px-2 py-2 text-right">
                        <button onClick={() => removeSession(s.id)}
                          className="text-[12px] text-gray-400 hover:text-rose-500">Delete</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Pitching ─────────────────────────────────────────────────────

const CONTEXTS = [['live', 'Games + Scrimmages'], ['game', 'Games only'], ['scrimmage', 'Scrimmages'], ['all', 'Everything']]

function PitchingTab() {
  const [context, setContext] = useState('live')
  const { data, loading } = useApi(`/trackman/pitching?context=${context}`)
  const pitchers = data?.pitchers || []
  const teams = useMemo(() => [...new Set(pitchers.map(p => p.team).filter(Boolean))].sort(), [pitchers])
  const [team, setTeam] = useState('')
  const shown = team ? pitchers.filter(p => p.team === team) : pitchers

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        {CONTEXTS.map(([k, label]) => (
          <button key={k} onClick={() => setContext(k)}
            className={`px-2.5 py-1 rounded-full text-[12px] font-semibold ${
              context === k ? 'bg-portal-purple text-white'
                : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
            {label}
          </button>
        ))}
        <select value={team} onChange={e => setTeam(e.target.value)}
          className="ml-auto rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1 text-sm">
          <option value="">All teams</option>
          {teams.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {loading ? <div className="text-sm text-gray-400 p-6 text-center">Loading…</div> :
        shown.map(p => (
          <div key={`${p.pitcher}-${p.team}`} className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-hidden">
            <div className="px-4 py-2.5 flex items-center gap-2 border-b border-gray-100 dark:border-gray-700">
              <span className="font-bold text-gray-900 dark:text-gray-100">{p.pitcher}</span>
              <span className="text-[11px] font-bold text-gray-500 bg-gray-100 dark:bg-gray-700 rounded px-1.5 py-0.5">
                {p.throws === 'Left' ? 'LHP' : p.throws === 'Right' ? 'RHP' : '–'}
              </span>
              <span className="text-xs text-gray-400">{p.team}</span>
              <span className="ml-auto text-xs text-gray-400 tabular-nums">{p.pitches} pitches</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
                    <th className="px-4 py-1.5">Pitch</th>
                    <th className="px-2 py-1.5 text-right">Use%</th>
                    <th className="px-2 py-1.5 text-right">Velo</th>
                    <th className="px-2 py-1.5 text-right">Max</th>
                    <th className="px-2 py-1.5 text-right">Spin</th>
                    <th className="px-2 py-1.5 text-right">IVB</th>
                    <th className="px-2 py-1.5 text-right">HB</th>
                    <th className="px-2 py-1.5 text-right">Ext</th>
                    <th className="px-2 py-1.5 text-right">Zone%</th>
                    <th className="px-2 py-1.5 text-right">Whiff%</th>
                    <th className="px-2 py-1.5 text-right">Chase%</th>
                    <th className="px-2 py-1.5 text-right">CSW%</th>
                    <th className="px-2 py-1.5 text-right">EV agn</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                  {p.arsenal.map(a => (
                    <tr key={a.pitch_type}>
                      <td className="px-4 py-1.5 font-semibold whitespace-nowrap">
                        <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: PITCH_COLORS[a.pitch_type] || '#9ca3af' }} />
                        {a.pitch_type}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(a.usage_pct)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{fmt(a.velo)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-gray-400">{fmt(a.max_velo)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{a.spin ?? '–'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(a.ivb)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(a.hb)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(a.extension, 1)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(a.zone_pct)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{fmt(a.whiff_pct)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(a.chase_pct)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(a.csw_pct)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(a.ev_against)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      {!loading && shown.length === 0 && (
        <div className="text-sm text-gray-400 p-6 text-center">No pitching data in this context.</div>
      )}
    </div>
  )
}

// ── Hitting ──────────────────────────────────────────────────────

function HittingTab() {
  const { data, loading } = useApi('/trackman/hitting')
  const batters = data?.batters || []
  const teams = useMemo(() => [...new Set(batters.map(b => b.team).filter(Boolean))].sort(), [batters])
  const [team, setTeam] = useState('')
  const shown = team ? batters.filter(b => b.team === team) : batters

  const Cell = ({ v, suffix = '' }) => <td className="px-2 py-1.5 text-right tabular-nums">{v == null ? '–' : `${v}${suffix}`}</td>

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Live = games + scrimmages. Transfer gap = live hard-hit% minus BP hard-hit% (negative means the BP swing isn't carrying into games).
        </p>
        <select value={team} onChange={e => setTeam(e.target.value)}
          className="ml-auto rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1 text-sm">
          <option value="">All teams</option>
          {teams.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
              <th className="px-4 py-2">Batter</th>
              <th className="px-2 py-2 text-right">Live BBE</th>
              <th className="px-2 py-2 text-right">EV</th>
              <th className="px-2 py-2 text-right">Max EV</th>
              <th className="px-2 py-2 text-right">HH%</th>
              <th className="px-2 py-2 text-right">Whiff%</th>
              <th className="px-2 py-2 text-right">Chase%</th>
              <th className="px-2 py-2 text-right border-l border-gray-100 dark:border-gray-700">BP BBE</th>
              <th className="px-2 py-2 text-right">BP EV</th>
              <th className="px-2 py-2 text-right">BP HH%</th>
              <th className="px-2 py-2 text-right">Transfer</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {loading ? (
              <tr><td colSpan={11} className="p-6 text-center text-gray-400">Loading…</td></tr>
            ) : shown.map(b => (
              <tr key={`${b.batter}-${b.team}`}>
                <td className="px-4 py-1.5 whitespace-nowrap">
                  <span className="font-semibold text-gray-900 dark:text-gray-100">{b.batter}</span>
                  <span className="text-[11px] text-gray-400 ml-1.5">{b.side === 'Left' ? 'L' : b.side === 'Right' ? 'R' : ''} · {b.team}</span>
                </td>
                <Cell v={b.live?.bbe} />
                <Cell v={b.live?.avg_ev} />
                <Cell v={b.live?.max_ev} />
                <Cell v={b.live?.hard_hit_pct} />
                <Cell v={b.live?.whiff_pct} />
                <Cell v={b.live?.chase_pct} />
                <td className="px-2 py-1.5 text-right tabular-nums border-l border-gray-100 dark:border-gray-700">{b.bp?.bbe ?? '–'}</td>
                <Cell v={b.bp?.avg_ev} />
                <Cell v={b.bp?.hard_hit_pct} />
                <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${
                  b.transfer_gap == null ? 'text-gray-300' : b.transfer_gap >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {b.transfer_gap == null ? '–' : (b.transfer_gap > 0 ? '+' : '') + b.transfer_gap}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
