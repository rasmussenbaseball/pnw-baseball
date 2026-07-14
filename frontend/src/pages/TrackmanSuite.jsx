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
import ReportActions from '../components/ReportActions'
import { Link } from 'react-router-dom'

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
  const [labPitcher, setLabPitcher] = useState('')
  const [reviewSession, setReviewSession] = useState(null)
  const { data: overview, refetch } = useApi('/trackman/overview')
  const hasData = (overview?.totals?.pitches || 0) > 0
  // Team context: every roster view pre-selects the COACH'S team (the modal
  // team code across their uploads) so opponents never mix into their lists.
  // Persisted so a manual change sticks.
  const [myTeam, setMyTeamRaw] = useState(() => localStorage.getItem('tmMyTeam') || '')
  const teams = overview?.teams || []
  const primary = myTeam && teams.includes(myTeam) ? myTeam : (overview?.primary_team || '')
  const setMyTeam = (t) => { setMyTeamRaw(t); localStorage.setItem('tmMyTeam', t) }
  const teamCtx = { teams, primary, setMyTeam }

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
      <div className="flex gap-1.5 mb-4 flex-wrap">
        {[['overview', 'Overview & Upload'], ['pitching', 'Pitching'], ['hitting', 'Hitting'],
          ['lab', 'Pitcher Lab'], ['hlab', 'Hitter Lab'], ['leaders', 'Leaderboards'],
          ['sessions', 'Session Review'], ['catching', 'Catching'], ['board', 'Coach Board']].map(([k, label]) => (
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

      {tab === 'overview' && <OverviewTab overview={overview} refetch={refetch} onReview={(id) => { setReviewSession(id); setTab('sessions') }} />}
      {tab === 'pitching' && (hasData ? <PitchingTab teamCtx={teamCtx} onOpenLab={(name) => { setLabPitcher(name); setTab('lab') }} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'hitting' && (hasData ? <HittingTab teamCtx={teamCtx} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'lab' && (hasData ? <PlayerLabTab pitcher={labPitcher} setPitcher={setLabPitcher} teamCtx={teamCtx} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'hlab' && (hasData ? <HitterLabTab teamCtx={teamCtx} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'leaders' && (hasData ? <LeaderboardsTab teamCtx={teamCtx} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'sessions' && (hasData ? <SessionsTab overview={overview} sessionId={reviewSession} setSessionId={setReviewSession} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'catching' && (hasData ? <CatchingTab /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'board' && (hasData ? <CoachBoardTab teamCtx={teamCtx} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
    </div>
  )
}

// Team selector: coach's team pre-selected, opponents + All available.
function TeamSelect({ teamCtx, value, onChange, allowAll = true }) {
  const { teams, primary, setMyTeam } = teamCtx
  return (
    <select value={value} onChange={e => { onChange(e.target.value); if (e.target.value) setMyTeam(e.target.value) }}
      className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-sm font-semibold">
      {allowAll && <option value="">All teams</option>}
      {teams.map(t => (
        <option key={t} value={t}>{t}{t === primary ? ' (my team)' : ''}</option>
      ))}
    </select>
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

function OverviewTab({ overview, refetch, onReview }) {
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
                      <td className="px-2 py-2 text-right whitespace-nowrap">
                        <button onClick={() => onReview?.(s.id)}
                          className="text-[12px] font-semibold text-portal-purple dark:text-indigo-300 hover:underline mr-3">Review</button>
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

function PitchingTab({ onOpenLab, teamCtx }) {
  const [context, setContext] = useState('live')
  const { data, loading } = useApi('/trackman/pitching', { context })
  const pitchers = data?.pitchers || []
  const [team, setTeam] = useState(teamCtx.primary)
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
        <div className="ml-auto"><TeamSelect teamCtx={teamCtx} value={team} onChange={setTeam} /></div>
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
              <button onClick={() => onOpenLab?.(p.pitcher)}
                className="text-[12px] font-semibold text-portal-purple dark:text-indigo-300 hover:underline whitespace-nowrap">
                Player Lab →
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
                    <th className="px-4 py-1.5">Pitch</th>
                    <th className="px-2 py-1.5 text-right" title="Pitch quality vs every same-type pitch in your data. 100 = average, 10 pts per SD (velo, shape, spin, extension).">Stuff</th>
                    <th className="px-2 py-1.5 text-right" title="Zone presence vs same-type pitches in your data. 100 = average.">Loc</th>
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
                      <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${a.stuff == null ? 'text-gray-300' : a.stuff >= 110 ? 'text-[#d22d49]' : a.stuff <= 90 ? 'text-[#3661ad]' : ''}`}>{a.stuff ?? '–'}</td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${a.loc == null ? 'text-gray-300' : a.loc >= 110 ? 'text-[#d22d49]' : a.loc <= 90 ? 'text-[#3661ad]' : ''}`}>{a.loc ?? '–'}</td>
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

function HittingTab({ teamCtx }) {
  const { data, loading } = useApi('/trackman/hitting')
  const batters = data?.batters || []
  const [team, setTeam] = useState(teamCtx.primary)
  const shown = team ? batters.filter(b => b.team === team) : batters

  const Cell = ({ v, suffix = '' }) => <td className="px-2 py-1.5 text-right tabular-nums">{v == null ? '–' : `${v}${suffix}`}</td>

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Live = games + scrimmages. Transfer gap = live hard-hit% minus BP hard-hit% (negative means the BP swing isn't carrying into games).
        </p>
        <div className="ml-auto"><TeamSelect teamCtx={teamCtx} value={team} onChange={setTeam} /></div>
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

// ── Player Lab (Savant-style pitcher deep dive) ──────────────────

const cFor = (t) => PITCH_COLORS[t] || '#9ca3af'

// Savant-style percentile slider: blue (low) → red (high on the GOOD end).
function PctlBar({ label, value, pctl, unit = '' }) {
  const good = pctl >= 50
  const dot = good ? '#d22d49' : '#3661ad'
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-28 text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide shrink-0">{label}</span>
      <div className="relative flex-1 h-1.5 rounded-full bg-gradient-to-r from-[#3661ad] via-gray-200 dark:via-gray-600 to-[#d22d49] opacity-90">
        <span className="absolute -top-[7px] w-5 h-5 rounded-full text-[9px] font-bold text-white flex items-center justify-center ring-2 ring-white dark:ring-gray-800"
          style={{ left: `calc(${pctl}% - 10px)`, background: dot }}>
          {pctl}
        </span>
      </div>
      <span className="w-16 text-right text-[12px] font-bold tabular-nums text-gray-800 dark:text-gray-100 shrink-0">{value}{unit}</span>
    </div>
  )
}

// Movement plot, catcher's view: HB on x (arm-side +), IVB on y.
function MovementPlot({ pitches }) {
  const W = 300, H = 300, R = 25 // inches range
  const sx = (hb) => W / 2 + (hb / R) * (W / 2 - 16)
  const sy = (ivb) => H / 2 - (ivb / R) * (H / 2 - 16)
  const byType = {}
  pitches.forEach(p => {
    if (p.horz_break == null || p.ivb == null) return
    ;(byType[p.ptype] = byType[p.ptype] || []).push(p)
  })
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {[-20, -10, 10, 20].map(v => (
        <g key={v}>
          <line x1={sx(v)} y1="8" x2={sx(v)} y2={H - 8} stroke="currentColor" className="text-gray-100 dark:text-gray-700" strokeWidth="1" />
          <line x1="8" y1={sy(v)} x2={W - 8} y2={sy(v)} stroke="currentColor" className="text-gray-100 dark:text-gray-700" strokeWidth="1" />
        </g>
      ))}
      <line x1={sx(0)} y1="8" x2={sx(0)} y2={H - 8} stroke="currentColor" className="text-gray-300 dark:text-gray-500" strokeWidth="1.5" />
      <line x1="8" y1={sy(0)} x2={W - 8} y2={sy(0)} stroke="currentColor" className="text-gray-300 dark:text-gray-500" strokeWidth="1.5" />
      {Object.entries(byType).map(([t, ps]) => ps.map((p, i) => (
        <circle key={t + i} cx={sx(Math.max(-R, Math.min(R, p.horz_break)))} cy={sy(Math.max(-R, Math.min(R, p.ivb)))}
          r="3" fill={cFor(t)} opacity="0.35" />
      )))}
      {Object.entries(byType).map(([t, ps]) => {
        const mx = ps.reduce((a, p) => a + p.horz_break, 0) / ps.length
        const my = ps.reduce((a, p) => a + p.ivb, 0) / ps.length
        return (
          <g key={t}>
            <circle cx={sx(mx)} cy={sy(my)} r="7" fill={cFor(t)} stroke="#fff" strokeWidth="2" />
          </g>
        )
      })}
      <text x={W - 10} y={sy(0) - 6} textAnchor="end" fontSize="9" fill="#9ca3af">HB (in) →</text>
      <text x={sx(0) + 6} y="16" fontSize="9" fill="#9ca3af">IVB (in) ↑</text>
    </svg>
  )
}

// Release point, catcher's view.
function ReleasePlot({ pitches }) {
  const W = 300, H = 300
  const sx = (side) => W / 2 + (side / 5) * (W / 2 - 16)
  const sy = (h) => H - 20 - (h / 8) * (H - 40)
  const pts = pitches.filter(p => p.rel_side != null && p.rel_height != null)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <line x1="8" y1={H - 20} x2={W - 8} y2={H - 20} stroke="currentColor" className="text-gray-300 dark:text-gray-500" strokeWidth="1.5" />
      {[2, 4, 6].map(v => (
        <g key={v}>
          <line x1="8" y1={sy(v)} x2={W - 8} y2={sy(v)} stroke="currentColor" className="text-gray-100 dark:text-gray-700" />
          <text x="12" y={sy(v) - 3} fontSize="8" fill="#9ca3af">{v} ft</text>
        </g>
      ))}
      <line x1={sx(0)} y1="8" x2={sx(0)} y2={H - 20} stroke="currentColor" className="text-gray-200 dark:text-gray-600" strokeDasharray="3 3" />
      {pts.map((p, i) => (
        <circle key={i} cx={sx(Math.max(-5, Math.min(5, p.rel_side)))} cy={sy(Math.max(0, Math.min(8, p.rel_height)))}
          r="3" fill={cFor(p.ptype)} opacity="0.4" />
      ))}
    </svg>
  )
}

// Location heatmap: 5x5 bins over the hitting area with the K-zone box.
function LocationHeatmap({ pitches, title }) {
  const XMIN = -1.7, XMAX = 1.7, YMIN = 0.8, YMAX = 4.2, N = 5
  const bins = Array.from({ length: N }, () => Array(N).fill(0))
  let total = 0
  pitches.forEach(p => {
    if (p.plate_loc_side == null || p.plate_loc_height == null) return
    const cx = Math.min(N - 1, Math.max(0, Math.floor(((p.plate_loc_side - XMIN) / (XMAX - XMIN)) * N)))
    const cy = Math.min(N - 1, Math.max(0, Math.floor(((YMAX - p.plate_loc_height) / (YMAX - YMIN)) * N)))
    bins[cy][cx] += 1; total += 1
  })
  const max = Math.max(1, ...bins.flat())
  const W = 150, H = 150, cw = W / N, ch = H / N
  const zx = (v) => ((v - XMIN) / (XMAX - XMIN)) * W
  const zy = (v) => ((YMAX - v) / (YMAX - YMIN)) * H
  return (
    <div>
      <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-300 mb-1 flex items-center gap-1.5">
        <span className="inline-block w-2 h-2 rounded-full" style={{ background: cFor(title) }} />
        {title} <span className="text-gray-400 font-normal">({total})</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded">
        {bins.map((row, y) => row.map((n, x) => (
          <rect key={`${x}${y}`} x={x * cw} y={y * ch} width={cw} height={ch}
            fill={n === 0 ? 'transparent' : '#d22d49'} opacity={n === 0 ? 0 : 0.12 + 0.75 * (n / max)} />
        )))}
        <rect x={zx(-0.83)} y={zy(3.5)} width={zx(0.83) - zx(-0.83)} height={zy(1.5) - zy(3.5)}
          fill="none" stroke="currentColor" className="text-gray-500 dark:text-gray-300" strokeWidth="1.5" />
      </svg>
    </div>
  )
}

const COUNTS = [['0-0','0-1','0-2'],['1-0','1-1','1-2'],['2-0','2-1','2-2'],['3-0','3-1','3-2']]

function CountUsage({ usage }) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {COUNTS.flat().map(c => {
        const cell = usage[c]
        const top = cell ? Object.entries(cell.types).sort((a, b) => b[1] - a[1]).slice(0, 2) : []
        return (
          <div key={c} className="rounded-lg bg-gray-50 dark:bg-gray-900/40 p-2">
            <div className="text-[10px] font-bold text-gray-400 tabular-nums">{c} <span className="font-normal">· {cell?.total || 0}</span></div>
            {top.map(([t, pct]) => (
              <div key={t} className="flex items-center gap-1 mt-0.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cFor(t) }} />
                <span className="text-[10px] text-gray-600 dark:text-gray-300 truncate">{t}</span>
                <span className="ml-auto text-[10px] font-semibold tabular-nums">{Math.round(pct)}%</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function VeloTrend({ trend }) {
  const series = Object.entries(trend).filter(([, pts]) => pts.length >= 2)
  if (!series.length) return <div className="text-xs text-gray-400 p-4 text-center">Need 2+ sessions for a trend.</div>
  const dates = [...new Set(series.flatMap(([, pts]) => pts.map(p => p.date)))].sort()
  const vals = series.flatMap(([, pts]) => pts.map(p => p.velo))
  const vmin = Math.floor(Math.min(...vals)) - 1, vmax = Math.ceil(Math.max(...vals)) + 1
  const W = 560, H = 170
  const sx = (d) => 34 + (dates.indexOf(d) / Math.max(1, dates.length - 1)) * (W - 50)
  const sy = (v) => H - 22 - ((v - vmin) / (vmax - vmin)) * (H - 40)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {[vmin, Math.round((vmin + vmax) / 2), vmax].map(v => (
        <g key={v}>
          <line x1="34" y1={sy(v)} x2={W - 12} y2={sy(v)} stroke="currentColor" className="text-gray-100 dark:text-gray-700" />
          <text x="30" y={sy(v) + 3} textAnchor="end" fontSize="9" fill="#9ca3af">{v}</text>
        </g>
      ))}
      {series.map(([t, pts]) => (
        <g key={t}>
          <polyline points={pts.map(p => `${sx(p.date)},${sy(p.velo)}`).join(' ')}
            fill="none" stroke={cFor(t)} strokeWidth="2" strokeLinejoin="round" />
          {pts.map((p, i) => <circle key={i} cx={sx(p.date)} cy={sy(p.velo)} r="3" fill={cFor(t)} />)}
        </g>
      ))}
      {dates.map((d, i) => (i % Math.ceil(dates.length / 6) === 0 &&
        <text key={d} x={sx(d)} y={H - 8} textAnchor="middle" fontSize="8" fill="#9ca3af">{d.slice(5)}</text>
      ))}
    </svg>
  )
}

// Two-pitch sequencing: pairs within the same PA, ordered by PitchofPA.
function SequencingTable({ pitches }) {
  const pairs = {}
  const byPA = {}
  pitches.forEach(p => {
    if (p.pitch_of_pa == null) return
    const key = `${p.session_id}|${p.inning}|${p.top_bottom}|${p.pa_of_inning}`
    ;(byPA[key] = byPA[key] || []).push(p)
  })
  Object.values(byPA).forEach(pa => {
    pa.sort((a, b) => a.pitch_of_pa - b.pitch_of_pa)
    for (let i = 1; i < pa.length; i++) {
      const k = `${pa[i - 1].ptype} → ${pa[i].ptype}`
      const e = (pairs[k] = pairs[k] || { n: 0, swings: 0, whiffs: 0, csw: 0 })
      e.n += 1
      if (pa[i].is_swing) e.swings += 1
      if (pa[i].is_whiff) e.whiffs += 1
      if (pa[i].pitch_call === 'StrikeCalled' || pa[i].pitch_call === 'StrikeSwinging') e.csw += 1
    }
  })
  const rows = Object.entries(pairs).filter(([, e]) => e.n >= 8).sort((a, b) => b[1].n - a[1].n).slice(0, 10)
  if (!rows.length) return <div className="text-xs text-gray-400 p-4 text-center">Not enough in-PA sequences yet (needs 8+ of a combo).</div>
  return (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
          <th className="py-1">Sequence</th><th className="py-1 text-right">N</th>
          <th className="py-1 text-right" title="Whiffs per swing on the SECOND pitch of the combo">Whiff%</th>
          <th className="py-1 text-right" title="Called + swinging strikes on the second pitch">CSW%</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
        {rows.map(([k, e]) => (
          <tr key={k}>
            <td className="py-1 font-semibold">{k}</td>
            <td className="py-1 text-right tabular-nums">{e.n}</td>
            <td className="py-1 text-right tabular-nums font-semibold">{e.swings ? (100 * e.whiffs / e.swings).toFixed(1) : '–'}</td>
            <td className="py-1 text-right tabular-nums">{(100 * e.csw / e.n).toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const PCTL_LABELS = {
  velo: ['Velocity', ' mph', 1], ivb: ['Fastball ride (IVB)', '"', 1], spin: ['Spin rate', ' rpm', 0],
  extension: ['Extension', ' ft', 1], zone_pct: ['Zone%', '%', 1], whiff_pct: ['Whiff%', '%', 1],
  chase_pct: ['Chase%', '%', 1], csw_pct: ['CSW%', '%', 1], ev_against: ['EV against', ' mph', 1],
}

function PlayerLabTab({ pitcher, setPitcher, teamCtx }) {
  const exportRef = useRef(null)
  const [context, setContext] = useState('live')
  const [team, setTeam] = useState(teamCtx.primary)
  const [conf, setConf] = useState('all')
  const { data: list } = useApi('/trackman/pitching', { context: 'all' })
  const roster = (list?.pitchers || []).filter(p => !team || p.team === team)
  const names = roster.map(p => p.pitcher)
  const active = names.includes(pitcher) ? pitcher : (names[0] || '')
  const { data, loading, error } = useApi(
    active ? '/trackman/pitchers/detail' : null,
    { pitcher: active, context, conf, team: team || undefined })

  const byType = useMemo(() => {
    const m = {}
    ;(data?.pitches || []).forEach(p => { (m[p.ptype] = m[p.ptype] || []).push(p) })
    return Object.fromEntries(Object.entries(m).sort((a, b) => b[1].length - a[1].length))
  }, [data])

  const pct = data?.percentiles || {}
  const pctKeys = Object.keys(PCTL_LABELS).filter(k => pct[k])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <TeamSelect teamCtx={teamCtx} value={team} onChange={setTeam} allowAll={false} />
        <select value={active} onChange={e => setPitcher(e.target.value)}
          className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-sm font-semibold">
          {names.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        {CONTEXTS.map(([k, label]) => (
          <button key={k} onClick={() => setContext(k)}
            className={`px-2.5 py-1 rounded-full text-[12px] font-semibold ${
              context === k ? 'bg-portal-purple text-white'
                : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
            {label}
          </button>
        ))}
        <button onClick={() => setConf(conf === 'all' ? 'strict' : 'all')}
          title="Strict drops pitches TrackMan flagged low-confidence on movement or location"
          className={`px-2.5 py-1 rounded-full text-[12px] font-semibold ${
            conf === 'strict' ? 'bg-emerald-600 text-white'
              : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
          {conf === 'strict' ? 'High confidence only ✓' : 'All measurements'}
        </button>
        {data?.profile?.player_id && (
          <Link to={`/player/${data.profile.player_id}`}
            className="text-[12px] font-semibold text-portal-purple dark:text-indigo-300 hover:underline">
            Site profile →
          </Link>
        )}
        {data && <span className="ml-auto text-xs text-gray-400 tabular-nums">{data.pitch_count} pitches</span>}
        {data && <ReportActions targetRef={exportRef} filename={`trackman_${(active || 'pitcher').replace(/[^a-z]+/gi, '_').toLowerCase()}`} />}
      </div>

      {loading && <div className="text-sm text-gray-400 p-6 text-center">Loading…</div>}
      {error && <div className="text-sm text-gray-400 p-6 text-center">No data for this pitcher in this context.</div>}

      {data && (
        <div ref={exportRef} className="space-y-3">
          {/* Percentiles vs the corpus */}
          {pctKeys.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-3">
                Percentile vs your data ({pct[pctKeys[0]]?.pool} qualified arms, 50+ pitches)
              </div>
              <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2.5">
                {pctKeys.map(k => {
                  const [label, unit, dec] = PCTL_LABELS[k]
                  const v = pct[k].value
                  const disp = k.endsWith('_pct') ? (v * 100).toFixed(dec) : v.toFixed(dec)
                  return <PctlBar key={k} label={label} value={disp} unit={unit} pctl={pct[k].pctl} />
                })}
              </div>
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-3">
            <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Movement (catcher's view)</div>
              <MovementPlot pitches={data.pitches} />
              <div className="flex flex-wrap gap-2 mt-1">
                {Object.keys(byType).map(t => (
                  <span key={t} className="text-[11px] text-gray-500 dark:text-gray-400 flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full inline-block" style={{ background: cFor(t) }} />{t}
                  </span>
                ))}
              </div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Release point</div>
              <ReleasePlot pitches={data.pitches} />
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Locations by pitch (K-zone box)</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {Object.entries(byType).slice(0, 6).map(([t, ps]) => (
                  <LocationHeatmap key={t} pitches={ps} title={t} />
                ))}
              </div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Pitch selection by count</div>
              <CountUsage usage={data.count_usage} />
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Velocity by session</div>
              <VeloTrend trend={data.velo_trend} />
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Two-pitch sequences (result on the 2nd pitch)</div>
              <SequencingTable pitches={data.pitches} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Leaderboards ─────────────────────────────────────────────────

function LeaderboardsTab({ teamCtx }) {
  const [side, setSide] = useState('pitching')
  const [context, setContext] = useState('live')
  const [team, setTeam] = useState(teamCtx.primary)
  const { data, loading } = useApi('/trackman/leaderboards', { side, context, team: team || undefined })
  const boards = data?.boards || {}

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        {[['pitching', 'Pitching'], ['hitting', 'Hitting']].map(([k, label]) => (
          <button key={k} onClick={() => setSide(k)}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${
              side === k ? 'bg-portal-purple text-white'
                : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
            {label}
          </button>
        ))}
        <div className="w-px h-5 bg-gray-200 dark:bg-gray-700" />
        {CONTEXTS.map(([k, label]) => (
          <button key={k} onClick={() => setContext(k)}
            className={`px-2.5 py-1 rounded-full text-[12px] font-semibold ${
              context === k ? 'bg-portal-purple text-white'
                : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
            {label}
          </button>
        ))}
        <div className="ml-auto"><TeamSelect teamCtx={teamCtx} value={team} onChange={setTeam} /></div>
      </div>
      {loading ? <div className="text-sm text-gray-400 p-6 text-center">Loading…</div> : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Object.entries(boards).map(([key, b]) => (
            <div key={key} className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-hidden">
              <div className="px-3.5 py-2 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
                <span className="text-[12px] font-bold text-gray-800 dark:text-gray-100">{b.label}</span>
                <span className="text-[10px] text-gray-400">min {b.min_sample}</span>
              </div>
              {b.rows.length === 0 ? (
                <div className="p-4 text-center text-xs text-gray-400">No qualifiers.</div>
              ) : (
                <ul className="divide-y divide-gray-50 dark:divide-gray-700/50">
                  {b.rows.slice(0, 8).map((r, i) => (
                    <li key={r.name + r.team} className="px-3.5 py-1.5 flex items-center gap-2 text-[13px]">
                      <span className={`w-5 text-center text-[11px] font-bold rounded ${i === 0 ? 'bg-portal-purple text-white' : 'text-gray-400'}`}>{i + 1}</span>
                      <span className="font-semibold text-gray-800 dark:text-gray-100 truncate">{r.name}</span>
                      <span className="text-[10px] text-gray-400">{r.team}</span>
                      <span className="ml-auto font-bold tabular-nums">{r.value}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Hitter Lab ───────────────────────────────────────────────────

const HITTER_PCTL_LABELS = {
  avg_ev: ['Avg exit velo', ' mph', 1], max_ev: ['Max exit velo', ' mph', 1],
  hard_hit_pct: ['Hard-hit%', '%', 1], sweet_spot_pct: ['Sweet-spot%', '%', 1],
  whiff_pct: ['Whiff%', '%', 1], chase_pct: ['Chase%', '%', 1], zone_contact_pct: ['Zone contact%', '%', 1],
}

// 5x5 zone map colored by a rate (swing% or contact%) per bin.
function ZoneRateMap({ pitches, num, den, title }) {
  const XMIN = -1.7, XMAX = 1.7, YMIN = 0.8, YMAX = 4.2, N = 5
  const nums = Array.from({ length: N }, () => Array(N).fill(0))
  const dens = Array.from({ length: N }, () => Array(N).fill(0))
  pitches.forEach(p => {
    if (p.plate_loc_side == null || p.plate_loc_height == null) return
    const cx = Math.min(N - 1, Math.max(0, Math.floor(((p.plate_loc_side - XMIN) / (XMAX - XMIN)) * N)))
    const cy = Math.min(N - 1, Math.max(0, Math.floor(((YMAX - p.plate_loc_height) / (YMAX - YMIN)) * N)))
    if (den(p)) { dens[cy][cx] += 1; if (num(p)) nums[cy][cx] += 1 }
  })
  const W = 150, H = 150, cw = W / N, ch = H / N
  const zx = (v) => ((v - XMIN) / (XMAX - XMIN)) * W
  const zy = (v) => ((YMAX - v) / (YMAX - YMIN)) * H
  return (
    <div>
      <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-300 mb-1">{title}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded">
        {dens.map((row, y) => row.map((d, x) => {
          if (d < 3) return <rect key={`${x}${y}`} x={x * cw} y={y * ch} width={cw} height={ch} fill="currentColor" className="text-gray-100 dark:text-gray-700" opacity="0.4" />
          const rate = nums[y][x] / d
          return (
            <g key={`${x}${y}`}>
              <rect x={x * cw} y={y * ch} width={cw} height={ch} fill={rate >= 0.5 ? '#d22d49' : '#3661ad'}
                opacity={0.12 + 0.7 * Math.abs(rate - 0.25)} />
              <text x={x * cw + cw / 2} y={y * ch + ch / 2 + 3} textAnchor="middle" fontSize="9"
                fill="#fff" fontWeight="700">{Math.round(rate * 100)}</text>
            </g>
          )
        }))}
        <rect x={zx(-0.83)} y={zy(3.5)} width={zx(0.83) - zx(-0.83)} height={zy(1.5) - zy(3.5)}
          fill="none" stroke="currentColor" className="text-gray-600 dark:text-gray-200" strokeWidth="1.5" />
      </svg>
    </div>
  )
}

// Spray chart from Bearing (deg from CF, +=right) + Distance.
function SprayChart({ pitches }) {
  const W = 300, H = 260, HOME_X = W / 2, HOME_Y = H - 18, MAXD = 420
  const pts = pitches.filter(p => p.bearing != null && p.distance != null && p.exit_speed != null)
  const px = (b, d) => HOME_X + (d / MAXD) * (H - 40) * Math.sin(b * Math.PI / 180)
  const py = (b, d) => HOME_Y - (d / MAXD) * (H - 40) * Math.cos(b * Math.PI / 180)
  const evColor = (ev) => ev >= 95 ? '#d22d49' : ev >= 85 ? '#f59e0b' : '#3661ad'
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* foul lines + outfield arcs */}
      <line x1={HOME_X} y1={HOME_Y} x2={px(-45, 420)} y2={py(-45, 420)} stroke="currentColor" className="text-gray-300 dark:text-gray-600" />
      <line x1={HOME_X} y1={HOME_Y} x2={px(45, 420)} y2={py(45, 420)} stroke="currentColor" className="text-gray-300 dark:text-gray-600" />
      {[150, 250, 350].map(d => (
        <path key={d}
          d={`M ${px(-45, d)} ${py(-45, d)} A ${(d / MAXD) * (H - 40)} ${(d / MAXD) * (H - 40)} 0 0 1 ${px(45, d)} ${py(45, d)}`}
          fill="none" stroke="currentColor" className="text-gray-100 dark:text-gray-700" />
      ))}
      {pts.map((p, i) => (
        <circle key={i} cx={px(Math.max(-55, Math.min(55, p.bearing)), Math.min(MAXD, p.distance))}
          cy={py(Math.max(-55, Math.min(55, p.bearing)), Math.min(MAXD, p.distance))}
          r="3.5" fill={evColor(p.exit_speed)} opacity="0.65" />
      ))}
      <text x="10" y={H - 6} fontSize="8" fill="#9ca3af">EV: <tspan fill="#3661ad">&lt;85</tspan> <tspan fill="#f59e0b">85-95</tspan> <tspan fill="#d22d49">95+</tspan></text>
    </svg>
  )
}

function HitterLabTab({ teamCtx }) {
  const exportRef = useRef(null)
  const [team, setTeam] = useState(teamCtx.primary)
  const [batter, setBatter] = useState('')
  const [context, setContext] = useState('all')
  const [conf, setConf] = useState('all')
  const { data: list } = useApi('/trackman/hitting')
  const roster = (list?.batters || []).filter(b => !team || b.team === team)
  const names = roster.map(b => b.batter)
  const active = names.includes(batter) ? batter : (names[0] || '')
  const { data, loading, error } = useApi(
    active ? '/trackman/batters/detail' : null,
    { batter: active, context, conf, team: team || undefined })

  const pct = data?.percentiles || {}
  const pctKeys = Object.keys(HITTER_PCTL_LABELS).filter(k => pct[k])
  const pitches = data?.pitches || []
  const bbe = pitches.filter(p => p.exit_speed != null)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <TeamSelect teamCtx={teamCtx} value={team} onChange={setTeam} allowAll={false} />
        <select value={active} onChange={e => setBatter(e.target.value)}
          className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-sm font-semibold">
          {names.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        {[['all', 'Everything'], ['live', 'Games + Scrimmages'], ['bp', 'BP only']].map(([k, label]) => (
          <button key={k} onClick={() => setContext(k)}
            className={`px-2.5 py-1 rounded-full text-[12px] font-semibold ${
              context === k ? 'bg-portal-purple text-white'
                : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
            {label}
          </button>
        ))}
        <button onClick={() => setConf(conf === 'all' ? 'strict' : 'all')}
          className={`px-2.5 py-1 rounded-full text-[12px] font-semibold ${
            conf === 'strict' ? 'bg-emerald-600 text-white'
              : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
          {conf === 'strict' ? 'High confidence only ✓' : 'All measurements'}
        </button>
        {data?.profile?.player_id && (
          <Link to={`/player/${data.profile.player_id}`}
            className="text-[12px] font-semibold text-portal-purple dark:text-indigo-300 hover:underline">
            Site profile →
          </Link>
        )}
        {data && <span className="ml-auto text-xs text-gray-400 tabular-nums">{data.pitch_count} pitches seen · {bbe.length} BBE</span>}
        {data && <ReportActions targetRef={exportRef} filename={`trackman_${(active || 'batter').replace(/[^a-z]+/gi, '_').toLowerCase()}`} />}
      </div>

      {loading && <div className="text-sm text-gray-400 p-6 text-center">Loading…</div>}
      {error && <div className="text-sm text-gray-400 p-6 text-center">No data for this batter in this context.</div>}

      {data && (
        <div ref={exportRef} className="space-y-3">
          {pctKeys.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-3">
                Percentile vs your data ({pct[pctKeys[0]]?.pool} qualified bats, 30+ pitches seen)
              </div>
              <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2.5">
                {pctKeys.map(k => {
                  const [label, unit, dec] = HITTER_PCTL_LABELS[k]
                  const v = pct[k].value
                  const disp = k.endsWith('_pct') ? (v * 100).toFixed(dec) : v.toFixed(dec)
                  return <PctlBar key={k} label={label} value={disp} unit={unit} pctl={pct[k].pctl} />
                })}
              </div>
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-3">
            <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Spray (colored by EV)</div>
              <SprayChart pitches={bbe} />
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Swing decisions (rate per cell, min 3)</div>
              <div className="grid grid-cols-2 gap-3">
                <ZoneRateMap pitches={pitches} title="Swing%"
                  den={() => true} num={(p) => p.is_swing} />
                <ZoneRateMap pitches={pitches} title="Whiff% (of swings)"
                  den={(p) => p.is_swing} num={(p) => p.is_whiff} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Session Review ───────────────────────────────────────────────

function SessionsTab({ overview, sessionId, setSessionId }) {
  const exportRef = useRef(null)
  const sessions = overview?.sessions || []
  const active = sessionId || sessions[0]?.id
  const { data, loading } = useApi(active ? `/trackman/sessions/${active}/review` : null, {}, [active])
  const sess = data?.session

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <select value={active || ''} onChange={e => setSessionId(Number(e.target.value))}
          className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-sm font-semibold">
          {sessions.map(s => (
            <option key={s.id} value={s.id}>
              {s.session_date} · {(TYPE_META[s.session_type] || {}).label || s.session_type} · {s.session_type === 'bp' ? (s.stadium || 'BP') : `${s.away_team} @ ${s.home_team}`}
            </option>
          ))}
        </select>
        {sess && <span className="ml-auto text-xs text-gray-400 tabular-nums">{sess.pitch_count} pitches · {sess.bbe_count} BBE</span>}
        {data && <ReportActions targetRef={exportRef} filename={`trackman_session_${sess?.session_date || active}`} />}
      </div>

      {loading ? <div className="text-sm text-gray-400 p-6 text-center">Loading…</div> : data && (
        <div ref={exportRef} className="space-y-3">
          {data.zone_report?.called > 20 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {[
                ['Called pitches', data.zone_report.called],
                ['Call accuracy', data.zone_report.accuracy_pct != null ? `${data.zone_report.accuracy_pct}%` : '–'],
                ['Shadow-zone pitches', data.zone_report.shadow_pitches],
                ['Shadow strike rate', data.zone_report.shadow_strike_pct != null ? `${data.zone_report.shadow_strike_pct}%` : '–'],
              ].map(([label, value]) => (
                <div key={label} className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 px-4 py-3">
                  <div className="text-xl font-bold text-portal-purple dark:text-gray-100 tabular-nums leading-none">{value}</div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mt-1.5">{label}</div>
                </div>
              ))}
            </div>
          )}
          <SessionNotes key={active} sessionId={active} initial={sess} />

          <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
            <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 text-[11px] font-bold uppercase tracking-wide text-gray-400">
              Pitcher lines
            </div>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
                  <th className="px-4 py-1.5">Pitcher</th><th className="px-2 py-1.5">Team</th>
                  <th className="px-2 py-1.5 text-right">Pitches</th><th className="px-2 py-1.5 text-right">BF</th>
                  <th className="px-2 py-1.5 text-right">Velo</th><th className="px-2 py-1.5 text-right">Max</th>
                  <th className="px-2 py-1.5 text-right">K</th><th className="px-2 py-1.5 text-right">BB</th>
                  <th className="px-2 py-1.5 text-right">Whiffs</th><th className="px-2 py-1.5 text-right">CSW%</th>
                  <th className="px-2 py-1.5 text-right">Zone%</th><th className="px-2 py-1.5 text-right">EV agn</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {(data.pitcher_lines || []).map(l => (
                  <tr key={l.pitcher + l.pitcher_team}>
                    <td className="px-4 py-1.5 font-semibold whitespace-nowrap">{l.pitcher}</td>
                    <td className="px-2 py-1.5 text-xs text-gray-400">{l.pitcher_team}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{l.pitches}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{l.bf}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{fmt(l.velo)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-gray-400">{fmt(l.max_velo)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{l.k}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{l.bb}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{l.whiffs}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(l.csw_pct)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(l.zone_pct)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(l.ev_against)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
            <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 text-[11px] font-bold uppercase tracking-wide text-gray-400">
              Hardest-hit balls
            </div>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
                  <th className="px-4 py-1.5">Batter</th><th className="px-2 py-1.5">vs Pitcher</th>
                  <th className="px-2 py-1.5 text-right">EV</th><th className="px-2 py-1.5 text-right">LA</th>
                  <th className="px-2 py-1.5 text-right">Dist</th><th className="px-2 py-1.5">Type</th>
                  <th className="px-2 py-1.5">Result</th><th className="px-2 py-1.5 text-right">Inn</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {(data.top_bbe || []).map((b, i) => (
                  <tr key={i}>
                    <td className="px-4 py-1.5 font-semibold whitespace-nowrap">{b.batter} <span className="text-[10px] text-gray-400">{b.batter_team}</span></td>
                    <td className="px-2 py-1.5 text-xs text-gray-500">{b.pitcher}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-bold">{fmt(b.exit_speed)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(b.launch_angle)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{b.distance ?? '–'}</td>
                    <td className="px-2 py-1.5 text-xs">{b.tagged_hit_type || '–'}</td>
                    <td className="px-2 py-1.5 text-xs">{b.play_result || '–'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{b.inning ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Catching ─────────────────────────────────────────────────────

function CatchingTab() {
  const { data, loading } = useApi('/trackman/catching')
  const rows = data?.catchers || []
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Catcher throws (tracked steal/pickoff attempts)</span>
        <span className="text-[10px] text-gray-400">Sorted by avg pop time</span>
      </div>
      {loading ? <div className="p-6 text-center text-sm text-gray-400">Loading…</div> :
       rows.length === 0 ? <div className="p-8 text-center text-sm text-gray-400">No tracked catcher throws yet. TrackMan records pop times on steal attempts and pickoffs.</div> : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
              <th className="px-4 py-2">Catcher</th><th className="px-2 py-2">Team</th>
              <th className="px-2 py-2 text-right">Throws</th>
              <th className="px-2 py-2 text-right">Avg pop</th><th className="px-2 py-2 text-right">Best pop</th>
              <th className="px-2 py-2 text-right">Exchange</th>
              <th className="px-2 py-2 text-right">Arm avg</th><th className="px-2 py-2 text-right">Arm max</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {rows.map(c => (
              <tr key={c.catcher + c.catcher_team}>
                <td className="px-4 py-1.5 font-semibold whitespace-nowrap">{c.catcher}</td>
                <td className="px-2 py-1.5 text-xs text-gray-400">{c.catcher_team}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{c.throws}</td>
                <td className="px-2 py-1.5 text-right tabular-nums font-bold">{fmt(c.avg_pop, 2)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{fmt(c.best_pop, 2)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmt(c.avg_exchange, 2)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmt(c.avg_throw)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmt(c.max_throw)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Staff notes (Session Review) ─────────────────────────────────

function SessionNotes({ sessionId, initial }) {
  const [highlights, setHighlights] = useState(initial?.highlights || '')
  const [concerns, setConcerns] = useState(initial?.concerns || '')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      await fetch(`/api/v1/trackman/sessions/${sessionId}/notes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ highlights: highlights || null, concerns: concerns || null }),
      })
      setSaved(true); setTimeout(() => setSaved(false), 1800)
    } finally { setBusy(false) }
  }

  return (
    <div className="grid sm:grid-cols-2 gap-3">
      {[['Highlights', highlights, setHighlights, 'What went right (velo held late, zone command, hard contact...)'],
        ['Concerns', concerns, setConcerns, 'What needs attention before the next session...']].map(([label, val, set, ph]) => (
        <div key={label} className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Staff {label.toLowerCase()}</span>
            {label === 'Concerns' && (
              <button onClick={save} disabled={busy}
                className="text-[11px] font-bold text-portal-purple dark:text-indigo-300 hover:underline disabled:opacity-50">
                {saved ? 'Saved ✓' : busy ? 'Saving…' : 'Save notes'}
              </button>
            )}
          </div>
          <textarea value={val} onChange={e => set(e.target.value)} rows={2} placeholder={ph}
            className="w-full text-sm rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 resize-y" />
        </div>
      ))}
    </div>
  )
}

// ── Coach Board (auto-flags) ─────────────────────────────────────

const FLAG_META = {
  transfer_gap: { label: 'Transfer gap', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300' },
  velo_drop: { label: 'Velo watch', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
  usage_whiff: { label: 'Mix', cls: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300' },
  low_zone: { label: 'Zone', cls: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300' },
}

function CoachBoardTab({ teamCtx }) {
  const [team, setTeam] = useState(teamCtx.primary)
  const { data, loading } = useApi('/trackman/insights', { team: team || undefined })
  const flags = data?.flags || []

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-gray-500 dark:text-gray-400 max-w-xl">
          Auto-surfaced from your data with sample-size gates: practice-to-game transfer gaps,
          velocity dips, pitch-mix mismatches, and zone-command flags. Signals, not verdicts.
        </p>
        <div className="ml-auto"><TeamSelect teamCtx={teamCtx} value={team} onChange={setTeam} /></div>
      </div>
      {loading ? <div className="text-sm text-gray-400 p-6 text-center">Reading the data…</div> :
       flags.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-10 text-center text-sm text-gray-400">
          No flags right now. That's a good board.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {flags.map((f, i) => {
            const m = FLAG_META[f.kind] || { label: f.kind, cls: 'bg-gray-100 text-gray-600' }
            return (
              <div key={i} className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${m.cls}`}>{m.label}</span>
                  <span className="font-bold text-gray-900 dark:text-gray-100">{f.player}</span>
                  <span className="text-[11px] text-gray-400">{f.team}</span>
                </div>
                <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">{f.headline}</div>
                <p className="text-[13px] text-gray-500 dark:text-gray-400 mt-0.5">{f.detail}</p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
