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

import { useEffect, useMemo, useRef, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { supabase } from '../lib/supabase'
import { usePortalTeam } from '../context/PortalTeamContext'
import ReportActions from '../components/ReportActions'
import StaffManager from '../components/portal/StaffManager'
import TrackmanGlossary from '../components/portal/TrackmanGlossary'
import { toneAttr } from '../lib/reportExport'
import { Link } from 'react-router-dom'

const fmt = (v, d = 1) => (v === null || v === undefined ? '–' : Number(v).toFixed(d))

// ── Percentile heat (Savant's color language: red hot, blue cold) ─
// Shading is WITHIN the shown cohort; data-tone rides along so the
// black-&-white export swaps color for bold/italic.
function pctlOf(v, vals, higher = true) {
  if (v == null || !vals || vals.length < 5) return null
  const x = Number(v)
  const below = vals.filter(o => (higher ? o < x : o > x)).length
  const eq = vals.filter(o => o === x).length
  return Math.round((100 * (below + 0.5 * eq)) / vals.length)
}
function heatCls(p) {
  if (p == null) return ''
  if (p >= 80) return 'bg-[#d22d49]/15 font-semibold'
  if (p >= 65) return 'bg-[#d22d49]/[0.06]'
  if (p <= 20) return 'bg-[#3661ad]/15 font-semibold'
  if (p <= 35) return 'bg-[#3661ad]/[0.06]'
  return ''
}
// Right-aligned table cell with within-cohort percentile shading.
function HeatCell({ v, vals, higher = true, dec = 1, plus = false, extra = '' }) {
  const p = pctlOf(v, vals, higher)
  const disp = v == null ? '–' : `${plus && v > 0 ? '+' : ''}${Number(v).toFixed(dec)}`
  return (
    <td className={`px-2 py-1.5 text-right tabular-nums ${heatCls(p)} ${extra}`} {...toneAttr(p)}>
      {disp}
    </td>
  )
}
const PITCH_COLORS = {
  Fastball: '#ef4444', 'Four-Seam': '#ef4444', Sinker: '#f59e0b', Cutter: '#8b5cf6',
  Slider: '#3b82f6', Sweeper: '#14b8a6', Curveball: '#22c55e', ChangeUp: '#ec4899',
  Changeup: '#ec4899', Splitter: '#0891b2', Knuckleball: '#78716c',
}
const TYPE_META = {
  game: { label: 'Game', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' },
  scrimmage: { label: 'Scrimmage', cls: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300' },
  intrasquad: { label: 'Intrasquad', cls: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300' },
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
  // Team context: "my team" comes from the PORTAL's focus team (the school
  // the coach picked at the portal gate), mapped to its TrackMan code —
  // e.g. Bushnell -> BUS_BEA, Warner Pacific -> WAR_PAC. Falls back to the
  // most-common code in the uploads. Team FILTERS never redefine identity
  // (that was the bug where browsing WAR_PAC made it "my team").
  const { team: portalTeam } = usePortalTeam()
  const teams = overview?.teams || []
  useEffect(() => { localStorage.removeItem('tmMyTeam') }, [])  // clear the old, buggy override
  const primary = useMemo(() => {
    const words = `${portalTeam?.name || ''} ${portalTeam?.short_name || ''} ${portalTeam?.school_name || ''}`
      .toLowerCase().split(/[^a-z]+/).filter(Boolean)
    let best = null, bestScore = 0
    for (const code of teams) {
      const parts = code.toLowerCase().split(/[^a-z]+/).filter(Boolean)
      const score = parts.filter(part => words.some(w => w.startsWith(part))).length
      if (score > bestScore) { best = code; bestScore = score }
    }
    return best || overview?.primary_team || ''
  }, [teams.join(','), portalTeam?.id, overview?.primary_team])
  const teamCtx = { teams, primary }

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-5 py-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">TrackMan Suite</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 max-w-2xl">
            Upload your program's TrackMan game CSVs and turn them into arsenals, contact
            quality, and practice-to-game answers. Private to your staff; re-uploads never
            double count.
          </p>
        </div>
        <div className="pt-1.5 shrink-0"><TrackmanGlossary /></div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 mb-4 flex-wrap">
        {[['overview', 'Overview & Upload'], ['pitching', 'Pitching'], ['hitting', 'Hitting'],
          ['lab', 'Pitcher Lab'], ['hlab', 'Hitter Lab'], ['leaders', 'Leaderboards'],
          ['sessions', 'Session Review'], ['catching', 'Catching'], ['defense', 'Defense'], ['values', 'Values'], ['board', 'Coach Board']].map(([k, label]) => (
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
      {tab === 'pitching' && (hasData ? <PitchingTab key={teamCtx.primary} teamCtx={teamCtx} onOpenLab={(name) => { setLabPitcher(name); setTab('lab') }} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'hitting' && (hasData ? <HittingTab key={teamCtx.primary} teamCtx={teamCtx} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'lab' && (hasData ? <PlayerLabTab key={teamCtx.primary} pitcher={labPitcher} setPitcher={setLabPitcher} teamCtx={teamCtx} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'hlab' && (hasData ? <HitterLabTab key={teamCtx.primary} teamCtx={teamCtx} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'leaders' && (hasData ? <LeaderboardsTab key={teamCtx.primary} teamCtx={teamCtx} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'sessions' && (hasData ? <SessionsTab overview={overview} sessionId={reviewSession} setSessionId={setReviewSession} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'catching' && (hasData ? <CatchingTab key={teamCtx.primary} teamCtx={teamCtx} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'defense' && (hasData ? <DefenseTab key={teamCtx.primary} teamCtx={teamCtx} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'values' && (hasData ? <ValuesTab key={teamCtx.primary} teamCtx={teamCtx} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'board' && (hasData ? <CoachBoardTab key={teamCtx.primary} teamCtx={teamCtx} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
    </div>
  )
}

// Date-range filter: quick chips + custom inputs. Value: {from, to}.
function DateRange({ value, onChange }) {
  const today = new Date()
  const iso = (d) => d.toISOString().slice(0, 10)
  const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return iso(d) }
  const chips = [
    ['All', {}],
    ['Last 30d', { from: daysAgo(30) }],
    ['Last 14d', { from: daysAgo(14) }],
  ]
  const activeChip = chips.find(([, v]) => (v.from || '') === (value.from || '') && !value.to)?.[0]
  return (
    <span className="flex items-center gap-1.5 flex-wrap">
      {chips.map(([label, v]) => (
        <button key={label} onClick={() => onChange(v)}
          className={`px-2 py-1 rounded-full text-[11px] font-semibold ${
            activeChip === label ? 'bg-portal-purple text-white'
              : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
          {label}
        </button>
      ))}
      <input type="date" value={value.from || ''} onChange={e => onChange({ ...value, from: e.target.value || undefined })}
        className="rounded border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-1.5 py-0.5 text-[11px]" />
      <span className="text-[11px] text-gray-400">to</span>
      <input type="date" value={value.to || ''} onChange={e => onChange({ ...value, to: e.target.value || undefined })}
        className="rounded border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-1.5 py-0.5 text-[11px]" />
    </span>
  )
}

// Team selector: coach's team pre-selected, opponents + All available.
function TeamSelect({ teamCtx, value, onChange, allowAll = true }) {
  const { teams, primary } = teamCtx
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
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

  async function reclassifySession(id, session_type) {
    await fetch(`/api/v1/trackman/sessions/${id}/type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ session_type }),
    })
    refetch()
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
          ['Game / Scrim / Intra / BP', `${totals.by_type?.game || 0} / ${totals.by_type?.scrimmage || 0} / ${totals.by_type?.intrasquad || 0} / ${totals.by_type?.bp || 0}`],
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
                {(() => {
                  const pos = (report.results || []).reduce((a2, r) => a2 + (r.positioned || 0), 0)
                  return pos > 0 ? ` ${pos.toLocaleString()} fielder-positioning rows linked to their games.` : ''
                })()}
              </span>
            )}
            {(report.errors || []).map((e, i) => (
              <div key={i} className="text-rose-600 dark:text-rose-400 mt-1">{e.file}: {e.error}</div>
            ))}
          </div>
        )}
      </div>

      <StaffManager />

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
                  <th className="px-2 py-2 text-right">BBE</th>
                  <th className="px-2 py-2 text-right" title="Pitches with fielder-positioning data (playerpositioning CSV) — powers the Defense tab">Positioning</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {sessions.map(s => {
                  const t = TYPE_META[s.session_type] || TYPE_META.scrimmage
                  return (
                    <tr key={s.id}>
                      <td className="px-4 py-2 whitespace-nowrap text-gray-700 dark:text-gray-200">{s.session_date || '–'}</td>
                      <td className="px-2 py-2">
                        {/* reclassify in place: the auto-detector can't tell a
                            scrimmage from an intrasquad */}
                        <select value={s.session_type || 'scrimmage'}
                          onChange={e => reclassifySession(s.id, e.target.value)}
                          className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full border-0 cursor-pointer appearance-none ${t.cls}`}>
                          <option value="game">Game</option>
                          <option value="scrimmage">Scrimmage</option>
                          <option value="intrasquad">Intrasquad</option>
                          <option value="bp">BP</option>
                        </select>
                      </td>
                      <td className="px-2 py-2 text-gray-500 dark:text-gray-400">
                        {s.session_type === 'bp' ? (s.stadium || 'BP') : `${s.away_team || '?'} @ ${s.home_team || '?'}`}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{s.pitch_count}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{s.bbe_count}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap">
                        {s.positioned_count > 0 ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 rounded-full px-2 py-0.5"
                            title={`${s.positioned_count} of ${s.pitch_count} pitches have fielder positions`}>
                            ▦ {s.positioned_count}
                          </span>
                        ) : s.session_type !== 'bp' ? (
                          <span className="text-[10px] text-gray-300 dark:text-gray-600"
                            title="No positioning file yet — upload this game's playerpositioning CSV to unlock the Defense tab for it">
                            none
                          </span>
                        ) : <span className="text-[10px] text-gray-300 dark:text-gray-600">—</span>}
                      </td>
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

const CONTEXTS = [['live', 'All live'], ['game', 'Games only'], ['scrimmage', 'Scrimmages'], ['intrasquad', 'Intrasquads'], ['all', 'Everything']]

function PitchingTab({ onOpenLab, teamCtx }) {
  const [context, setContext] = useState('live')
  const [ptype, setPtype] = useState('')
  const [vsSide, setVsSide] = useState('')
  const { data, loading } = useApi('/trackman/pitching',
    { context, ...(vsSide ? { side: vsSide } : {}) }, [context, vsSide])
  const pitchers = data?.pitchers || []
  const [team, setTeam] = useState(teamCtx.primary)
  const allTypes = useMemo(() => [...new Set(pitchers.flatMap(p => p.arsenal.map(a => a.pitch_type)))].sort(), [pitchers])
  const shown = (team ? pitchers.filter(p => p.team === team) : pitchers)
    .map(p => ptype ? { ...p, arsenal: p.arsenal.filter(a => a.pitch_type === ptype) } : p)
    .filter(p => p.arsenal.length > 0)
  // heat cohorts: every shown arsenal row, per column
  const cohort = useMemo(() => {
    const rows = shown.flatMap(p => p.arsenal)
    const grab = k => rows.map(a => a[k]).filter(v => v != null).map(Number)
    return { rv100: grab('rv100'), shadow: grab('shadow_pct'), whiff: grab('whiff_pct'),
             csw: grab('csw_pct'), ev: grab('ev_against'), chase: grab('chase_pct') }
  }, [shown])

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
        <div className="w-px h-5 bg-gray-200 dark:bg-gray-700" />
        {[['', 'All bats'], ['L', 'vs LHH'], ['R', 'vs RHH']].map(([k, label]) => (
          <button key={k} onClick={() => setVsSide(k)}
            className={`px-2.5 py-1 rounded-full text-[12px] font-semibold ${
              vsSide === k ? 'bg-emerald-600 text-white'
                : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
            {label}
          </button>
        ))}
        <select value={ptype} onChange={e => setPtype(e.target.value)}
          className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1 text-sm">
          <option value="">All pitch types</option>
          {allTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
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
              {p.rv != null && (
                <span className={`text-[11px] font-bold tabular-nums px-1.5 py-0.5 rounded ${
                  p.rv > 0 ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : p.rv < 0 ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
                      : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}
                  title="Total run value: count-based runs saved vs the average pitch in your data">
                  {p.rv > 0 ? `+${p.rv}` : p.rv} RV
                </span>
              )}
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
                    <th className="px-2 py-1.5 text-right" title="Site-standard Stuff (WCL-trained TrackMan model, same as the Rapsodo Lab). Inputs are PHYSICAL traits only: velo, movement, spin, extension, and separation off the fastball. Whiff+chase is what the model was trained to predict, never an input. 100 = average for the pitch type, ~25 per SD; elite shapes reach the 150s-170s; not comparable across types.">Stuff</th>
                    <th className="px-2 py-1.5 text-right" title="Site-standard Location+: edge presence + pitch-type height targets (shared with the Rapsodo Lab). 100 = average.">Loc+</th>
                    <th className="px-2 py-1.5 text-right">Use%</th>
                    <th className="px-2 py-1.5 text-right">Velo</th>
                    <th className="px-2 py-1.5 text-right">Max</th>
                    <th className="px-2 py-1.5 text-right">Spin</th>
                    <th className="px-2 py-1.5 text-right">IVB</th>
                    <th className="px-2 py-1.5 text-right">HB</th>
                    <th className="px-2 py-1.5 text-right">Ext</th>
                    <th className="px-2 py-1.5 text-right">Zone%</th>
                    <th className="px-2 py-1.5 text-right" title="Share of this pitch landing in the shadow band around the zone edges — edge-living score">Shdw%</th>
                    <th className="px-2 py-1.5 text-right">Whiff%</th>
                    <th className="px-2 py-1.5 text-right">Chase%</th>
                    <th className="px-2 py-1.5 text-right">CSW%</th>
                    <th className="px-2 py-1.5 text-right">EV agn</th>
                    <th className="px-2 py-1.5 text-right" title="Run value: count-based runs saved vs the average pitch in your data (positive = good)">RV</th>
                    <th className="px-2 py-1.5 text-right" title="Run value per 100 pitches — the rate version (min 15 priced pitches)">RV/100</th>
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
                      <HeatCell v={a.shadow_pct} vals={cohort.shadow} />
                      <HeatCell v={a.whiff_pct} vals={cohort.whiff} extra="font-semibold" />
                      <HeatCell v={a.chase_pct} vals={cohort.chase} />
                      <HeatCell v={a.csw_pct} vals={cohort.csw} />
                      <HeatCell v={a.ev_against} vals={cohort.ev} higher={false} />
                      <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${
                        a.rv == null ? 'text-gray-300' : a.rv > 0 ? 'text-emerald-600 dark:text-emerald-400' : a.rv < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                        {a.rv == null ? '–' : a.rv > 0 ? `+${a.rv}` : a.rv}
                      </td>
                      <HeatCell v={a.rv100} vals={cohort.rv100} dec={2} plus extra="font-semibold" />
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

const PITCH_TYPE_OPTIONS = ['Fastball', 'Sinker', 'Cutter', 'Slider', 'Sweeper', 'Curveball', 'ChangeUp', 'Splitter']

function HittingTab({ teamCtx }) {
  const [ptype, setPtype] = useState('')
  const [vsThrows, setVsThrows] = useState('')
  const { data, loading } = useApi('/trackman/hitting',
    { pitch_type: ptype || undefined, ...(vsThrows ? { throws: vsThrows } : {}) }, [ptype, vsThrows])
  const batters = data?.batters || []
  const [team, setTeam] = useState(teamCtx.primary)
  const shown = team ? batters.filter(b => b.team === team) : batters
  const cohort = useMemo(() => {
    const grab = k => shown.map(b => b.live?.[k]).filter(v => v != null).map(Number)
    return { ev: grab('avg_ev'), max: grab('max_ev'), hh: grab('hard_hit_pct'),
             whiff: grab('whiff_pct'), chase: grab('chase_pct') }
  }, [shown])

  const Cell = ({ v, suffix = '' }) => <td className="px-2 py-1.5 text-right tabular-nums">{v == null ? '–' : `${v}${suffix}`}</td>

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Live = games, scrimmages, and intrasquads. Transfer gap = live hard-hit% minus BP hard-hit% (negative means the BP swing isn't carrying into games).
        </p>
        {[['', 'All arms'], ['L', 'vs LHP'], ['R', 'vs RHP']].map(([k, label]) => (
          <button key={k} onClick={() => setVsThrows(k)}
            className={`px-2.5 py-1 rounded-full text-[12px] font-semibold ${
              vsThrows === k ? 'bg-emerald-600 text-white'
                : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
            {label}
          </button>
        ))}
        <select value={ptype} onChange={e => setPtype(e.target.value)}
          className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1 text-sm">
          <option value="">All pitch types</option>
          {PITCH_TYPE_OPTIONS.map(t => <option key={t} value={t}>vs {t}</option>)}
        </select>
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
                <HeatCell v={b.live?.avg_ev} vals={cohort.ev} />
                <HeatCell v={b.live?.max_ev} vals={cohort.max} />
                <HeatCell v={b.live?.hard_hit_pct} vals={cohort.hh} />
                <HeatCell v={b.live?.whiff_pct} vals={cohort.whiff} higher={false} />
                <HeatCell v={b.live?.chase_pct} vals={cohort.chase} higher={false} />
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
// Dots are clickable when onPick is provided (per-pitch re-tagging).
function MovementPlot({ pitches, onPick, selectedId, arm }) {
  const W = 300, H = 300, R = 25 // inches range
  const sx = (hb) => W / 2 + (hb / R) * (W / 2 - 16)
  const sy = (ivb) => H / 2 - (ivb / R) * (H / 2 - 16)
  const byType = {}
  pitches.forEach(p => {
    if (p.horz_break == null || p.ivb == null) return
    ;(byType[p.ptype] = byType[p.ptype] || []).push(p)
  })
  // Arm-slot axis: the movement direction the arm angle predicts. Over the
  // top -> pure ride (straight up); sidearm -> pure arm-side run. Fastballs
  // should live near this line; distance OFF it = seam/cut effects the
  // slot alone doesn't explain.
  let axis = null
  if (arm?.arm_angle != null) {
    const fbTypes = ['Fastball', 'Four-Seam', 'Sinker']
    let fb = pitches.filter(p => fbTypes.includes(p.ptype) && p.horz_break != null)
    if (!fb.length) fb = pitches.filter(p => p.horz_break != null)
    if (fb.length) {
      const sign = fb.reduce((a, p) => a + p.horz_break, 0) >= 0 ? 1 : -1
      const th = (arm.arm_angle * Math.PI) / 180
      axis = { x: sign * Math.cos(th), y: Math.sin(th) }
    }
  }
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
      {axis && (
        <g>
          <line x1={sx(-axis.x * R)} y1={sy(-axis.y * R)} x2={sx(axis.x * R)} y2={sy(axis.y * R)}
            stroke="#8b5cf6" strokeWidth="1.5" strokeDasharray="7 5" opacity="0.55" />
          <text x={sx(axis.x * R * 0.8)} y={sy(axis.y * R * 0.8) - 7} textAnchor="middle"
            fontSize="8.5" fontWeight="700" fill="#8b5cf6" opacity="0.9">
            arm slot ~{arm.arm_angle}°
          </text>
          <title>Expected fastball movement axis from the arm angle — distance off this line is movement the slot alone doesn't explain (seam effects, cut, sink)</title>
        </g>
      )}
      {Object.entries(byType).map(([t, ps]) => ps.map((p, i) => (
        <circle key={t + i} cx={sx(Math.max(-R, Math.min(R, p.horz_break)))} cy={sy(Math.max(-R, Math.min(R, p.ivb)))}
          r={p.pitch_id === selectedId ? 5 : 3} fill={cFor(t)}
          opacity={p.pitch_id === selectedId ? 1 : 0.35}
          stroke={p.pitch_id === selectedId ? '#111' : (p.override_pitch_type ? '#111' : 'none')}
          strokeWidth={p.pitch_id === selectedId ? 1.5 : 0.8}
          style={onPick ? { cursor: 'pointer' } : undefined}
          onClick={onPick ? () => onPick(p) : undefined} />
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

// Location plot, Rapsodo Lab style: one small dot per pitch (catcher's view)
// with the K-zone box — not shaded bins.
function LocationHeatmap({ pitches, title }) {
  const XMIN = -1.7, XMAX = 1.7, YMIN = 0.8, YMAX = 4.2
  const W = 150, H = 150
  const zx = (v) => ((Math.max(XMIN, Math.min(XMAX, v)) - XMIN) / (XMAX - XMIN)) * W
  const zy = (v) => ((YMAX - Math.max(YMIN, Math.min(YMAX, v))) / (YMAX - YMIN)) * H
  const pts = pitches.filter(p => p.plate_loc_side != null && p.plate_loc_height != null)
  return (
    <div>
      <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-300 mb-1 flex items-center gap-1.5">
        <span className="inline-block w-2 h-2 rounded-full" style={{ background: cFor(title) }} />
        {title} <span className="text-gray-400 font-normal">({pts.length})</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded bg-gray-50 dark:bg-gray-900/40">
        <rect x={zx(-0.83)} y={zy(3.5)} width={zx(0.83) - zx(-0.83)} height={zy(1.5) - zy(3.5)}
          fill="none" stroke="currentColor" className="text-gray-400 dark:text-gray-500" strokeWidth="1.2" />
        {/* 9-box guides inside the zone */}
        {[1 / 3, 2 / 3].map(f => (
          <g key={f}>
            <line x1={zx(-0.83 + f * 1.66)} y1={zy(3.5)} x2={zx(-0.83 + f * 1.66)} y2={zy(1.5)}
              stroke="currentColor" className="text-gray-200 dark:text-gray-700" strokeWidth="0.7" />
            <line x1={zx(-0.83)} y1={zy(1.5 + f * 2.0)} x2={zx(0.83)} y2={zy(1.5 + f * 2.0)}
              stroke="currentColor" className="text-gray-200 dark:text-gray-700" strokeWidth="0.7" />
          </g>
        ))}
        {pts.map((p, i) => (
          <circle key={i} cx={zx(p.plate_loc_side)} cy={zy(p.plate_loc_height)} r="2.6"
            fill={cFor(title)} opacity="0.55" stroke="#fff" strokeWidth="0.5" />
        ))}
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

// Generic per-session trend line with a metric toggle. trend: [{date, ...}],
// metrics: [[key, label, decimals]] — first metric with data wins as default.
function SessionTrendCard({ trend, metrics, title }) {
  const [mi, setMi] = useState(0)
  const rows = trend || []
  const [key, label, dec] = metrics[mi] || metrics[0]
  const pts = rows.filter(r => r[key] != null)
  const W = 560, H = 170
  let body
  if (pts.length < 2) {
    body = <div className="text-xs text-gray-400 p-4 text-center">Need 2+ sessions with this metric.</div>
  } else {
    const vals = pts.map(p => Number(p[key]))
    const vmin = Math.min(...vals), vmax = Math.max(...vals)
    const pad = Math.max((vmax - vmin) * 0.15, 0.001)
    const lo = vmin - pad, hi = vmax + pad
    const sx = (i) => 40 + (i / Math.max(1, pts.length - 1)) * (W - 56)
    const sy = (v) => H - 22 - ((v - lo) / (hi - lo)) * (H - 40)
    body = (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {[lo, (lo + hi) / 2, hi].map((v, i) => (
          <g key={i}>
            <line x1="40" y1={sy(v)} x2={W - 12} y2={sy(v)} stroke="currentColor" className="text-gray-100 dark:text-gray-700" />
            <text x="36" y={sy(v) + 3} textAnchor="end" fontSize="9" fill="#9ca3af">{v.toFixed(dec)}</text>
          </g>
        ))}
        <polyline points={pts.map((p, i) => `${sx(i)},${sy(Number(p[key]))}`).join(' ')}
          fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={sx(i)} cy={sy(Number(p[key]))} r="3.5" fill="#7c3aed" />
            <title>{p.date}: {Number(p[key]).toFixed(dec)}</title>
          </g>
        ))}
        {pts.map((p, i) => (i % Math.ceil(pts.length / 6) === 0 &&
          <text key={p.date} x={sx(i)} y={H - 8} textAnchor="middle" fontSize="8" fill="#9ca3af">{(p.date || '').slice(5)}</text>
        ))}
      </svg>
    )
  }
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">{title}</span>
        <div className="flex rounded-lg overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700">
          {metrics.map(([k, l], i) => (
            <button key={k} onClick={() => setMi(i)}
              className={`px-2 py-0.5 text-[11px] font-bold ${mi === i
                ? 'bg-portal-purple text-white' : 'bg-white dark:bg-gray-800 text-gray-500'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {body}
    </div>
  )
}

// Count-leverage results, computed from the lab's per-pitch rows.
function CountResults({ pitches, mode }) {
  const tiles = useMemo(() => {
    const ps = (pitches || []).filter(p => p.pitch_call)
    const rate = (num, den) => den ? `${(100 * num / den).toFixed(1)}%` : null
    const isBall = c => ['BallCalled', 'BallinDirt', 'BallIntentional', 'HitByPitch'].includes(c)
    const first = ps.filter(p => p.balls === 0 && p.strikes === 0)
    const twoK = ps.filter(p => p.strikes === 2)
    const ahead = ps.filter(p => p.strikes > p.balls)      // pitcher ahead
    const behind = ps.filter(p => p.balls > p.strikes)
    const csw = arr => arr.filter(p => p.pitch_call === 'StrikeCalled' || p.pitch_call === 'StrikeSwinging').length
    if (mode === 'pitcher') {
      const threeBall = ps.filter(p => p.balls === 3)
      return [
        ['First-pitch strike%', rate(first.filter(p => !isBall(p.pitch_call)).length, first.length), first.length,
         'Strike-getting on 0-0: called, swung, fouled, or put in play'],
        ['Putaway% at 2K', rate(twoK.filter(p => p.k_or_bb === 'Strikeout').length, twoK.length), twoK.length,
         'Two-strike pitches that finished the strikeout'],
        ['CSW% ahead', rate(csw(ahead), ahead.length), ahead.length, 'Called + swinging strikes when ahead in the count'],
        ['CSW% behind', rate(csw(behind), behind.length), behind.length, 'Called + swinging strikes when behind — can he win from behind?'],
        ['Zone% at 3 balls', rate(threeBall.filter(p => p.is_in_zone).length, threeBall.filter(p => p.is_in_zone != null).length),
         threeBall.length, 'Does he fill it up when he has to?'],
      ]
    }
    // hitter: ahead/behind flip perspective
    const hAhead = behind, hBehind = ahead
    const evOn = arr => {
      const evs = arr.map(p => p.exit_speed).filter(v => v != null)
      return evs.length ? `${(evs.reduce((a, b) => a + b, 0) / evs.length).toFixed(1)} mph` : null
    }
    return [
      ['First-pitch swing%', rate(first.filter(p => p.is_swing).length, first.length), first.length,
       'How often the 0-0 pitch draws a swing'],
      ['2K contact%', rate(twoK.filter(p => p.is_swing && !p.is_whiff).length, twoK.filter(p => p.is_swing).length),
       twoK.filter(p => p.is_swing).length, 'Contact per swing with two strikes — the battle skill'],
      ['Chase% behind', rate(hBehind.filter(p => p.is_chase).length, hBehind.filter(p => p.is_in_zone === false).length),
       hBehind.length, 'Expanding the zone when the pitcher is ahead'],
      ['EV when ahead', evOn(hAhead.filter(p => p.exit_speed != null)), hAhead.filter(p => p.exit_speed != null).length,
       'Damage in hitter counts — is he cashing in the advantage?'],
    ]
  }, [pitches, mode])

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Count leverage</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
        {tiles.map(([label, val, n, tip]) => (
          <div key={label} className="rounded-lg bg-gray-50 dark:bg-gray-900/40 px-3 py-2" title={tip}>
            <div className="text-[9px] font-bold uppercase tracking-wider text-gray-400">{label}</div>
            <div className="text-[16px] font-bold tabular-nums text-gray-900 dark:text-gray-100">{val ?? '–'}</div>
            <div className="text-[10px] text-gray-400 tabular-nums">{n} pitches</div>
          </div>
        ))}
      </div>
    </div>
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
  velo: ['Fastball velo', ' mph', 1], ivb: ['Fastball ride (IVB)', '"', 1], spin: ['Spin rate', ' rpm', 0],
  extension: ['Extension', ' ft', 1], zone_pct: ['Zone%', '%', 1], whiff_pct: ['Whiff%', '%', 1],
  chase_pct: ['Chase%', '%', 1], csw_pct: ['CSW%', '%', 1], ev_against: ['EV against', ' mph', 1],
}

function PlayerLabTab({ pitcher, setPitcher, teamCtx }) {
  const exportRef = useRef(null)
  const [context, setContext] = useState('live')
  const [dates, setDates] = useState({})
  const [picked, setPicked] = useState(null)  // pitch selected for re-tagging
  const [team, setTeam] = useState(teamCtx.primary)
  const [conf, setConf] = useState('all')
  const [vsSide, setVsSide] = useState('')
  const { data: list } = useApi('/trackman/pitching', { context: 'all' })
  const roster = (list?.pitchers || []).filter(p => !team || p.team === team)
  const names = roster.map(p => p.pitcher)
  const active = names.includes(pitcher) ? pitcher : (names[0] || '')
  const { data, loading, error, refetch } = useApi(
    active ? '/trackman/pitchers/detail' : null,
    { pitcher: active, context, conf, team: team || undefined,
      side: vsSide || undefined,
      date_from: dates.from, date_to: dates.to })

  async function overridePitch(pitchType) {
    if (!picked) return
    await fetch(`/api/v1/trackman/pitches/${picked.pitch_id}/type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ pitch_type: pitchType }),
    })
    setPicked(null)
    refetch()
  }

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
        {[['', 'All bats'], ['L', 'vs LHH'], ['R', 'vs RHH']].map(([k, label]) => (
          <button key={k} onClick={() => setVsSide(k)}
            className={`px-2.5 py-1 rounded-full text-[12px] font-semibold ${
              vsSide === k ? 'bg-emerald-600 text-white'
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
        <DateRange value={dates} onChange={setDates} />
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

          <ArsenalStatTable pitches={data.pitches} rvByType={data.rv_by_type} />

          <CountResults pitches={data.pitches} mode="pitcher" />

          <div className="grid md:grid-cols-2 gap-3">
            <ArmProfileCard arm={data.arm} />
            <TunnelingCard tunneling={data.tunneling} />
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Movement (catcher's view)</span>
                <span className="text-[10px] text-gray-400">Click a dot to re-tag a pitch</span>
              </div>
              <MovementPlot pitches={data.pitches} selectedId={picked?.pitch_id} arm={data.arm}
                onPick={(p) => setPicked(picked?.pitch_id === p.pitch_id ? null : p)} />
              <div className="flex flex-wrap gap-2 mt-1">
                {Object.keys(byType).map(t => (
                  <span key={t} className="text-[11px] text-gray-500 dark:text-gray-400 flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full inline-block" style={{ background: cFor(t) }} />{t}
                  </span>
                ))}
              </div>
              {picked && (
                <div className="mt-2 rounded-lg bg-gray-50 dark:bg-gray-900/40 p-2.5">
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1.5">
                    Selected: <b>{picked.ptype}</b>
                    {picked.rel_speed != null && ` · ${Number(picked.rel_speed).toFixed(1)} mph`}
                    {picked.ivb != null && ` · ${Number(picked.ivb).toFixed(1)}" IVB`}
                    {picked.tagged_pitch_type && picked.tagged_pitch_type !== picked.ptype &&
                      ` · tagged ${picked.tagged_pitch_type}`}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {['Fastball', 'Sinker', 'Cutter', 'Slider', 'Sweeper', 'Curveball', 'ChangeUp', 'Splitter'].map(t => (
                      <button key={t} onClick={() => overridePitch(t)}
                        className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ring-1 ${
                          t === picked.ptype ? 'bg-portal-purple text-white ring-portal-purple'
                            : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 ring-gray-200 dark:ring-gray-700 hover:ring-portal-purple'}`}>
                        {t}
                      </button>
                    ))}
                    {picked.override_pitch_type && (
                      <button onClick={() => overridePitch(null)}
                        className="px-2 py-0.5 rounded-full text-[11px] font-semibold text-rose-600 ring-1 ring-rose-200 dark:ring-rose-800">
                        Clear override
                      </button>
                    )}
                  </div>
                </div>
              )}
              <p className="text-[10px] text-gray-400 mt-2">
                Types come from the site's shape classifier (each pitch judged vs this arm's own fastball),
                then consolidated against this pitcher's own movement profile so near-identical clusters
                read as one pitch. Overrides win everywhere. The dashed line is the arm-slot axis: where
                the release angle says the fastball should move — distance off it is seam-and-grip movement
                the slot alone doesn't explain.
              </p>
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
            <SessionTrendCard trend={data.session_trend}
              metrics={[['stuff', 'Stuff+', 0], ['rv100', 'RV/100', 2], ['fb_velo', 'FB velo', 1]]}
              title="Session trend — is he getting better?" />
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Two-pitch sequences (result on the 2nd pitch)</div>
            <SequencingTable pitches={data.pitches} />
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
  const [dates, setDates] = useState({})
  const [team, setTeam] = useState(teamCtx.primary)
  const [batter, setBatter] = useState('')
  const [context, setContext] = useState('all')
  const [conf, setConf] = useState('all')
  const [vsThrows, setVsThrows] = useState('')
  const { data: list } = useApi('/trackman/hitting')
  const roster = (list?.batters || []).filter(b => !team || b.team === team)
  const names = roster.map(b => b.batter)
  const active = names.includes(batter) ? batter : (names[0] || '')
  const { data, loading, error } = useApi(
    active ? '/trackman/batters/detail' : null,
    { batter: active, context, conf, team: team || undefined,
      throws: vsThrows || undefined,
      date_from: dates.from, date_to: dates.to })

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
        {[['', 'All arms'], ['L', 'vs LHP'], ['R', 'vs RHP']].map(([k, label]) => (
          <button key={k} onClick={() => setVsThrows(k)}
            className={`px-2.5 py-1 rounded-full text-[12px] font-semibold ${
              vsThrows === k ? 'bg-emerald-600 text-white'
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
        <DateRange value={dates} onChange={setDates} />
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

          {data.xstats && <XStatsCard x={data.xstats} />}

          <div className="grid md:grid-cols-2 gap-3">
            {data.swing_take && <SwingTakeCard st={data.swing_take} />}
            <SessionTrendCard trend={data.trend}
              metrics={[['xwobacon', 'xwOBAcon', 3], ['avg_ev', 'Avg EV', 1], ['hard_hit_pct', 'Hard-hit%', 1]]}
              title="Session trend — contact quality over time" />
          </div>

          <CountResults pitches={pitches} mode="hitter" />

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

// Mini framing map: the zone with its four shadow-edge bands colored by
// SAE (green = stealing strikes there, red = losing them).
function ShadowZoneMap({ c }) {
  const e = c.edges || {}
  const col = v => v > 0.4 ? '#059669' : v < -0.4 ? '#e11d48' : '#9ca3af'
  const op = v => Math.min(0.75, 0.18 + Math.abs(v || 0) * 0.1)
  const W = 120, H = 140, bx = 24, by = 26            // zone box inset
  const zw = W - 2 * bx, zh = H - 2 * by
  const bands = [
    ['high', bx, 6, zw, by - 10],
    ['low', bx, H - by + 4, zw, by - 10],
    ['left', 4, by, bx - 8, zh],
    ['right', W - bx + 4, by, bx - 8, zh],
  ]
  const lbl = { high: [W / 2, 16], low: [W / 2, H - 12], left: [12, H / 2], right: [W - 12, H / 2] }
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 p-2.5 text-center">
      <div className="text-[11px] font-bold text-gray-800 dark:text-gray-100 truncate">{c.catcher}</div>
      <div className="text-[9px] text-gray-400 mb-1">{c.sae > 0 ? `+${c.sae}` : c.sae} SAE · {c.shadow_taken} takes</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[130px] mx-auto">
        {bands.map(([k, x, y, w, h]) => {
          const sae = e[k]?.sae ?? 0
          const vertical = k === 'left' || k === 'right'
          const [tx, ty] = lbl[k]
          return (
            <g key={k} {...toneAttr(sae > 0.4 ? 80 : sae < -0.4 ? 20 : 50)}>
              <rect x={x} y={y} width={w} height={h} rx="3" fill={col(sae)} opacity={op(sae)} />
              <text x={tx} y={ty + 3} textAnchor="middle" fontSize="8.5" fontWeight="700"
                fill={col(sae)} transform={vertical ? `rotate(-90 ${tx} ${ty})` : undefined}>
                {sae > 0 ? `+${sae}` : sae}
              </text>
              <title>{k} edge: {sae > 0 ? '+' : ''}{sae} strikes above expected</title>
            </g>
          )
        })}
        <rect x={bx} y={by} width={zw} height={zh} rx="2" fill="none" stroke="currentColor"
          strokeWidth="1.5" className="text-gray-600 dark:text-gray-300" />
      </svg>
    </div>
  )
}

function CatchingTab({ teamCtx }) {
  const exportRef = useRef(null)
  const [team, setTeam] = useState(teamCtx.primary)
  const { data, loading } = useApi('/trackman/catching', team ? { team } : {}, [team])
  const rows = data?.catchers || []
  const pct = v => v != null ? `${Math.round(v * 100)}%` : '—'
  const runs = v => v == null ? '—' : (
    <span className={`font-bold ${v > 0 ? 'text-emerald-600 dark:text-emerald-400' : v < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
      {v > 0 ? `+${v}` : v}
    </span>
  )
  const framers = rows.filter(c => c.sae != null && (c.shadow_taken || 0) >= 20)
  return (
    <div className="space-y-3" ref={exportRef}>
      <div className="flex justify-end items-center gap-2">
        <ReportActions targetRef={exportRef} filename="trackman_catching" />
        <TeamSelect teamCtx={teamCtx} value={team} onChange={setTeam} />
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
        <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Catcher value board</span>
          <span className="text-[10px] text-gray-400">framing + arm runs · sorted by total value</span>
        </div>
        {loading ? <div className="p-6 text-center text-sm text-gray-400">Loading…</div> :
         rows.length === 0 ? <div className="p-8 text-center text-sm text-gray-400">No catcher data yet.</div> : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
                <th className="px-4 py-2">Catcher</th><th className="px-2 py-2">Team</th>
                <th className="px-2 py-2 text-right" title="Framing runs + arm runs">Value</th>
                <th className="px-2 py-2 text-right" title="Strikes Above Expected x 0.125 runs">Framing</th>
                <th className="px-2 py-2 text-right" title="Called strikes above the corpus-average expectation on edge pitches">SAE</th>
                <th className="px-2 py-2 text-right" title="Taken pitches within ~4 inches of the zone edge">Edge takes</th>
                <th className="px-2 py-2 text-right">Edge K%</th>
                {['High', 'Low', 'Left', 'Right'].map(h => (
                  <th key={h} className="px-2 py-2 text-right" title={`SAE on the ${h.toLowerCase()} edge`}>{h}</th>
                ))}
                <th className="px-2 py-2 text-right" title="Blended arm value: pop-time expectation as the prior, actual throw-outs update it; runs vs the corpus CS rate on real attempts">Arm</th>
                <th className="px-2 py-2 text-right" title="Actual stolen bases against - caught stealing (site season stats)">SB-CS</th>
                <th className="px-2 py-2 text-right" title="Blended CS%: actual record regressed toward the pop-time expectation">CS%</th>
                <th className="px-2 py-2 text-right" title="Estimated CS% from average pop time alone">est CS%</th>
                <th className="px-2 py-2 text-right">Pop</th>
                <th className="px-2 py-2 text-right">Best</th>
                <th className="px-2 py-2 text-right">Exch</th>
                <th className="px-2 py-2 text-right">Arm velo</th>
                <th className="px-2 py-2 text-right">Throws</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {rows.map(c => (
                <tr key={c.catcher + c.catcher_team}>
                  <td className="px-4 py-1.5 font-semibold whitespace-nowrap">{c.catcher}</td>
                  <td className="px-2 py-1.5 text-xs text-gray-400">{c.catcher_team}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{runs(c.total_runs)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{runs(c.framing_runs)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{c.sae != null ? (c.sae > 0 ? `+${c.sae}` : c.sae) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{c.shadow_taken ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{pct(c.shadow_strike_pct)}</td>
                  {['high', 'low', 'left', 'right'].map(e => (
                    <td key={e} className="px-2 py-1.5 text-right tabular-nums text-xs text-gray-500">
                      {c.edges?.[e] ? (c.edges[e].sae > 0 ? `+${c.edges[e].sae}` : c.edges[e].sae) : '—'}
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {runs(c.arm_runs)}
                    {c.arm_basis === 'est' && c.arm_runs != null &&
                      <span className="text-[9px] text-gray-400 ml-0.5" title="No season throw-out record found — pop-time estimate only">e</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">
                    {c.attempts ? `${c.sba}-${c.cs_actual}` : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{pct(c.blended_cs_pct ?? null)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-400">{pct(c.est_cs_pct)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-bold">{c.avg_pop ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{c.best_pop ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{c.avg_exchange ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{c.avg_throw ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{c.throws ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {framers.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
          <div className="flex items-baseline justify-between mb-2.5">
            <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Framing map — where each catcher wins and loses calls</span>
            <span className="text-[10px] text-gray-400">strikes above expected on each zone edge · 20+ edge takes</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
            {framers.map(c => <ShadowZoneMap key={c.catcher + c.catcher_team} c={c} />)}
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
        <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Blocking workload</span>
          <span className="text-[10px] text-gray-400">TrackMan records dirt balls, not whether they were kept in front — workload, not runs</span>
        </div>
        {rows.filter(c => c.pitches_caught).length ? (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
                <th className="px-4 py-2">Catcher</th><th className="px-2 py-2">Team</th>
                <th className="px-2 py-2 text-right">Pitches caught</th>
                <th className="px-2 py-2 text-right">Dirt balls</th>
                <th className="px-2 py-2 text-right">Per 100</th>
                <th className="px-2 py-2 text-right" title="Share of dirt balls that were breaking/offspeed">Offspeed%</th>
                <th className="px-2 py-2 text-right" title="Actual passed balls from the site's season fielding stats">PB (season)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {[...rows].filter(c => c.pitches_caught).sort((a, b) => (b.dirt_per_100 || 0) - (a.dirt_per_100 || 0)).map(c => (
                <tr key={c.catcher + c.catcher_team}>
                  <td className="px-4 py-1.5 font-semibold whitespace-nowrap">{c.catcher}</td>
                  <td className="px-2 py-1.5 text-xs text-gray-400">{c.catcher_team}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{c.pitches_caught}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-bold">{c.dirt_balls}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{c.dirt_per_100 ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{pct(c.dirt_offspeed_pct)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{c.passed_balls ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="p-6 text-center text-sm text-gray-400">No pitches tracked yet.</div>}
      </div>

      <p className="text-[10.5px] text-gray-400 leading-snug max-w-3xl">
        Framing: on taken pitches within about 4 inches of the zone edge, a location model sets the
        expected called-strike rate, calibrated so your whole corpus nets zero — SAE reads relative to
        the average catcher and umpire in your own data, at 0.125 runs per strike. Arm: the pop-time
        expectation acts as a prior worth about 15 attempts, and the catcher's ACTUAL season throw-out
        record (from the site's fielding stats) updates it — value accrues on real attempts against
        the corpus CS rate. An 'e' marks catchers with no season record, priced on pop time alone.
        Blocking stays workload-only (TrackMan doesn't record blocks), but season passed balls are
        shown alongside. All of it compares players within your data, not to MLB numbers.
      </p>
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

// ── Pitcher Lab: full per-pitch stat table ───────────────────────

function ArsenalStatTable({ pitches, rvByType }) {
  const rows = useMemo(() => {
    const g = {}
    pitches.forEach(p => { (g[p.ptype] = g[p.ptype] || []).push(p) })
    const total = pitches.length
    const avg = (arr, k) => {
      const v = arr.map(x => x[k]).filter(x => x != null)
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
    }
    return Object.entries(g).map(([t, ps]) => {
      const swings = ps.filter(p => p.is_swing).length
      const whiffs = ps.filter(p => p.is_whiff).length
      const outZone = ps.filter(p => p.is_in_zone === false).length
      const chases = ps.filter(p => p.is_chase).length
      const inZone = ps.filter(p => p.is_in_zone === true).length
      const csw = ps.filter(p => p.pitch_call === 'StrikeCalled' || p.pitch_call === 'StrikeSwinging').length
      const evs = ps.map(p => p.exit_speed).filter(v => v != null)
      return {
        t, n: ps.length, usage: 100 * ps.length / total,
        velo: avg(ps, 'rel_speed'), max: Math.max(...ps.map(p => p.rel_speed).filter(v => v != null), 0) || null,
        ivb: avg(ps, 'ivb'), hb: avg(ps, 'horz_break'), spin: avg(ps, 'spin_rate'),
        ext: avg(ps, 'extension'), vaa: avg(ps, 'vaa'),
        zone: (inZone + outZone) ? 100 * inZone / (inZone + outZone) : null,
        whiff: swings ? 100 * whiffs / swings : null,
        chase: outZone ? 100 * chases / outZone : null,
        csw: 100 * csw / ps.length,
        ev: evs.length ? evs.reduce((a, b) => a + b, 0) / evs.length : null,
      }
    }).sort((a, b) => b.n - a.n)
  }, [pitches])

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 text-[11px] font-bold uppercase tracking-wide text-gray-400">
        Pitch metrics (this view's filters applied)
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
            <th className="px-4 py-1.5">Pitch</th>
            <th className="px-2 py-1.5 text-right">N</th>
            <th className="px-2 py-1.5 text-right">Use%</th>
            <th className="px-2 py-1.5 text-right">Velo</th>
            <th className="px-2 py-1.5 text-right">Max</th>
            <th className="px-2 py-1.5 text-right">IVB</th>
            <th className="px-2 py-1.5 text-right">HB</th>
            <th className="px-2 py-1.5 text-right">Spin</th>
            <th className="px-2 py-1.5 text-right">Ext</th>
            <th className="px-2 py-1.5 text-right" title="Vertical approach angle at the plate">VAA</th>
            <th className="px-2 py-1.5 text-right">Zone%</th>
            <th className="px-2 py-1.5 text-right" title="Share landing in the shadow band around the zone edges">Shdw%</th>
            <th className="px-2 py-1.5 text-right">Whiff%</th>
            <th className="px-2 py-1.5 text-right">Chase%</th>
            <th className="px-2 py-1.5 text-right">CSW%</th>
            <th className="px-2 py-1.5 text-right">EV agn</th>
            <th className="px-2 py-1.5 text-right" title="Run value: count-based runs saved vs the average pitch in your data">RV</th>
            <th className="px-2 py-1.5 text-right" title="Run value per 100 pitches (min 15 priced)">RV/100</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
          {rows.map(r => (
            <tr key={r.t}>
              <td className="px-4 py-1.5 font-semibold whitespace-nowrap">
                <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: cFor(r.t) }} />
                {r.t}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">{r.n}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.usage)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{fmt(r.velo)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-gray-400">{fmt(r.max)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.ivb)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.hb)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{r.spin ? Math.round(r.spin) : '–'}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.ext)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.vaa, 1)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.zone)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(rvByType?.[r.t]?.shadow_pct)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{fmt(r.whiff)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.chase)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.csw)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.ev)}</td>
              <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${
                rvByType?.[r.t]?.rv == null ? 'text-gray-300'
                  : rvByType[r.t].rv > 0 ? 'text-emerald-600 dark:text-emerald-400'
                    : rvByType[r.t].rv < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                {rvByType?.[r.t]?.rv == null ? '–'
                  : rvByType[r.t].rv > 0 ? `+${rvByType[r.t].rv}` : rvByType[r.t].rv}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums font-semibold">
                {rvByType?.[r.t]?.rv100 == null ? '–'
                  : `${rvByType[r.t].rv100 > 0 ? '+' : ''}${rvByType[r.t].rv100}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Hitter Lab: swing/take by attack zone (Savant's regions) ─────

const ZONE_META = {
  heart: ['Heart', 'the middle two-thirds of the zone'],
  shadow: ['Shadow', 'the edges, in and just off the plate'],
  chase: ['Chase', 'clearly off, but close enough to tempt'],
  waste: ['Waste', 'noncompetitive'],
}

function SwingTakeCard({ st }) {
  const order = ['heart', 'shadow', 'chase', 'waste']
  const rvColor = v => v > 0.05 ? '#059669' : v < -0.05 ? '#e11d48' : '#9ca3af'
  // concentric zones, sized like the classifier (0.67 / 1.33 / 2.0 half-widths)
  const W = 150, H = 168, cx = W / 2, cy = H / 2
  const rects = [
    ['waste', W, H], ['chase', W * 0.66, H * 0.66], ['shadow', W * 0.44, H * 0.44], ['heart', W * 0.22, H * 0.22],
  ]
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Swing / take runs by attack zone</span>
        <span className={`text-[13px] font-bold tabular-nums ${st.total_rv > 0 ? 'text-emerald-600 dark:text-emerald-400' : st.total_rv < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-gray-500'}`}
          title="Total run value of every swing decision, centered on your corpus">
          {st.total_rv > 0 ? `+${st.total_rv}` : st.total_rv} runs
        </span>
      </div>
      <div className="flex gap-4 items-center">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-28 shrink-0">
          {rects.map(([z, w, h]) => (
            <g key={z}>
              <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx="4"
                fill={rvColor(st[z]?.rv ?? 0)} opacity={z === 'waste' ? 0.15 : z === 'chase' ? 0.25 : z === 'shadow' ? 0.35 : 0.5} />
              <title>{ZONE_META[z][0]}: {st[z]?.rv > 0 ? '+' : ''}{st[z]?.rv} runs</title>
            </g>
          ))}
          <rect x={cx - W * 0.33} y={cy - H * 0.33} width={W * 0.66} height={H * 0.66} rx="2"
            fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-700 dark:text-gray-200" />
        </svg>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-[9px] uppercase tracking-wide text-gray-400">
              <th className="py-1">Zone</th><th className="py-1 text-right">Seen</th>
              <th className="py-1 text-right">Swing%</th>
              <th className="py-1 text-right" title="Run value earned on swings in this zone">Swing RV</th>
              <th className="py-1 text-right" title="Run value earned on takes in this zone">Take RV</th>
              <th className="py-1 text-right">Runs</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {order.map(z => {
              const r = st[z] || {}
              const rv = v => v == null ? '–' : (
                <span className={v > 0.05 ? 'text-emerald-600 dark:text-emerald-400' : v < -0.05 ? 'text-rose-600 dark:text-rose-400' : 'text-gray-500'}>
                  {v > 0 ? `+${v}` : v}
                </span>
              )
              return (
                <tr key={z} title={ZONE_META[z][1]}>
                  <td className="py-1 font-semibold">{ZONE_META[z][0]}</td>
                  <td className="py-1 text-right tabular-nums text-gray-500">{r.pitches ?? '–'}</td>
                  <td className="py-1 text-right tabular-nums">{r.swing_pct != null ? `${r.swing_pct}%` : '–'}</td>
                  <td className="py-1 text-right tabular-nums">{rv(r.swing_rv)}</td>
                  <td className="py-1 text-right tabular-nums">{rv(r.take_rv)}</td>
                  <td className="py-1 text-right tabular-nums font-bold">{rv(r.rv)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-gray-400 mt-2">
        Every called pitch is priced with count-based run values, split by swing vs take.
        Good takes on chase pitches earn real runs; swings at waste give them back.
      </p>
    </div>
  )
}

// ── Hitter Lab: expected stats ───────────────────────────────────

function XStatsCard({ x }) {
  const Stat = ({ label, actual, expected }) => {
    const diff = expected != null && actual != null ? expected - actual : null
    return (
      <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 px-3 py-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
        <div className="flex items-baseline gap-2 mt-0.5">
          <span className="text-xl font-bold tabular-nums text-portal-purple dark:text-gray-100">{expected?.toFixed(3) ?? '–'}</span>
          <span className="text-[11px] text-gray-400 tabular-nums">actual {actual?.toFixed(3) ?? '–'}</span>
          {diff != null && Math.abs(diff) >= 0.02 && (
            <span className={`text-[11px] font-bold tabular-nums ${diff > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {diff > 0 ? 'unlucky' : 'over-performing'}
            </span>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
      <div className="flex items-baseline justify-between mb-2.5">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
          Expected stats (from exit velo + launch angle)
        </span>
        <span className="text-[10px] text-gray-400 tabular-nums">
          {x.pa} PA · {x.tracked_bip}/{x.bip} BIP tracked{x.coverage_pct != null ? ` (${x.coverage_pct}%)` : ''}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        <Stat label="xAVG" actual={x.avg} expected={x.xavg} />
        <Stat label="xSLG" actual={x.slg} expected={x.xslg} />
        <Stat label="xwOBA" actual={null} expected={x.xwoba} />
      </div>
      <p className="text-[10px] text-gray-400 mt-2">
        Contact values from a Statcast-shaped EV/LA surface; untracked balls in play use their actual result.
        Strikeouts count as outs; walks and HBP feed xwOBA.
      </p>
    </div>
  )
}

// ── Rapsodo Lab ports: arm profile + tunneling ───────────────────

function ArmProfileCard({ arm }) {
  if (!arm) return null
  const band = arm.arm_angle != null
    ? `${Math.round(arm.arm_angle / 5) * 5 - 5}–${Math.round(arm.arm_angle / 5) * 5 + 5}°`
    : null
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Arm & release profile</div>
      <div className="grid grid-cols-2 gap-2">
        {[
          ['Slot', arm.slot || '–'],
          ['Est. arm angle', band ? `~${band}` : '–'],
          ['Release', `${arm.rel_height ?? '–'} ft high · ${arm.rel_side ?? '–'} ft side`],
          ['Consistency', arm.consistency || '–'],
          ['Extension', arm.extension != null ? `${arm.extension} ft` : '–'],
          ['Approach angle', arm.vaa != null ? `${arm.vaa}°` : '–'],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg bg-gray-50 dark:bg-gray-900/40 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
            <div className="text-sm font-bold text-gray-800 dark:text-gray-100">{value}</div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-gray-400 mt-2">
        Arm angle is a geometric estimate from release point (~10° band), same method as the Rapsodo Lab.
        Release SD: ±{arm.rel_height_sd ?? '–'} ft height, ±{arm.rel_side_sd ?? '–'} ft side over {arm.n} pitches.
      </p>
    </div>
  )
}

function TunnelingCard({ tunneling }) {
  const anchor = tunneling?.default_anchor
  const pairs = (tunneling?.by_anchor || {})[anchor] || []
  if (!anchor || !pairs.length) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
        <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Tunneling</div>
        <p className="text-xs text-gray-400">Needs 2+ established pitch types to compute tunnel pairs.</p>
      </div>
    )
  }
  const cap = (t) => t ? t[0].toUpperCase() + t.slice(1) : t
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
          Tunneling off the {cap(anchor)}
        </span>
        {tunneling.best_pair && (
          <span className="text-[10px] text-gray-400">
            Best pair: {cap(tunneling.best_pair.anchor || anchor)} + {cap(tunneling.best_pair.pitch)}
          </span>
        )}
      </div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
            <th className="py-1">Pitch</th>
            <th className="py-1 text-right" title="Separation at the hitter's commit point (in) — smaller tunnels better">Tunnel</th>
            <th className="py-1 text-right" title="Movement separation at the plate (in) — bigger is better">Plate</th>
            <th className="py-1 text-right" title="Break that shows up AFTER the commit point (in)">Late</th>
            <th className="py-1 text-right" title="Late break per inch of tunnel separation">Ratio</th>
            <th className="py-1 text-right">Grade</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
          {pairs.map(pr => (
            <tr key={pr.pitch}>
              <td className="py-1 font-semibold">
                <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: cFor(cap(pr.pitch) === 'Changeup' ? 'ChangeUp' : cap(pr.pitch)) }} />
                {cap(pr.pitch)}
              </td>
              <td className="py-1 text-right tabular-nums">{pr.tunnel_diff}"</td>
              <td className="py-1 text-right tabular-nums">{pr.plate_diff}"</td>
              <td className="py-1 text-right tabular-nums font-semibold">{pr.post_break}"</td>
              <td className="py-1 text-right tabular-nums">{pr.break_tunnel_ratio ?? '–'}</td>
              <td className={`py-1 text-right tabular-nums font-bold ${pr.grade >= 60 ? 'text-emerald-600 dark:text-emerald-400' : pr.grade <= 40 ? 'text-rose-600 dark:text-rose-400' : ''}`}>{pr.grade}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-gray-400 mt-2">
        Same tunneling math as the Rapsodo Lab: release + commit-point separation vs late break.
      </p>
    </div>
  )
}

// ── Defense — OF catch probability + IF range from positioning CSVs ──

function DefenseFieldMap({ avgPositions, plays }) {
  const W = 460, H = 300
  const ox = W / 2, oy = H - 16
  const maxR = 380
  const R = H - 40
  const pt = (x, z) => {
    const r = Math.hypot(x, z), a = Math.atan2(z, Math.max(x, 0.001))
    const rr = (Math.min(r, maxR) / maxR) * R
    return [ox + rr * Math.sin(a), oy - rr * Math.cos(a)]
  }
  const foul = a => {
    const rad = (a * Math.PI) / 180
    return [ox + R * Math.sin(rad), oy - R * Math.cos(rad)]
  }
  const ofPlays = (plays || []).filter(p => p.type === 'OF' && p.land_x != null)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <rect x="0" y="0" width={W} height={H} rx="8" fill="#f8f7f4" />
      <path d={`M ${ox} ${oy} L ${foul(-45)[0]} ${foul(-45)[1]} A ${R} ${R} 0 0 1 ${foul(45)[0]} ${foul(45)[1]} Z`}
        fill="#ffffff" stroke="#d1d5db" />
      {[150, 250, 350].map(d => {
        const r = (d / maxR) * R
        const [x1, y1] = [ox + r * Math.sin(-Math.PI / 4), oy - r * Math.cos(-Math.PI / 4)]
        const [x2, y2] = [ox + r * Math.sin(Math.PI / 4), oy - r * Math.cos(Math.PI / 4)]
        return <path key={d} d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`} fill="none" stroke="#eceef2" />
      })}
      {ofPlays.map((p, i) => {
        const [cx, cy] = pt(p.land_x, p.land_z)
        return <circle key={i} cx={cx} cy={cy} r="3.4"
          fill={p.made ? '#059669' : '#dc2626'} opacity="0.65" />
      })}
      {Object.entries(avgPositions || {}).map(([pos, a]) => {
        const [cx, cy] = pt(a.x, a.z)
        return (
          <g key={pos}>
            <circle cx={cx} cy={cy} r="10" fill="#1d1f4d" />
            <text x={cx} y={cy + 3} textAnchor="middle" style={{ fontSize: 8, fontWeight: 700, fill: '#fff' }}>{pos}</text>
          </g>
        )
      })}
      <rect x={ox - 3} y={oy - 3} width="6" height="6" transform={`rotate(45 ${ox} ${oy})`} fill="#1d1f4d" />
    </svg>
  )
}

function DirCell({ d }) {
  if (!d) return <td className="px-2 py-1.5 text-right text-xs text-gray-300">—</td>
  const tone = d.oae > 0 ? 'text-emerald-600 dark:text-emerald-400' : d.oae < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-gray-500'
  return (
    <td className={`px-2 py-1.5 text-right tabular-nums text-xs font-semibold ${tone}`}>
      {d.oae > 0 ? `+${d.oae}` : d.oae} <span className="text-gray-400 font-normal">({d.opps})</span>
    </td>
  )
}

function BucketCells({ b }) {
  // conversion by difficulty: made/opps per star bucket, hardest first
  return ['5star', '4star', '3star', '2star', 'routine'].map(k => (
    <td key={k} className="px-2 py-1.5 text-right tabular-nums text-xs">
      {b[k][0] ? `${b[k][1]}/${b[k][0]}` : '—'}
    </td>
  ))
}

// Range rose: a player's OAE split by movement direction, as four petals.
// Green petal = above expectation moving that way, red = below.
function DirRose({ r }) {
  const dirs = r.dirs || {}
  const W = 120, H = 120, cx = W / 2, cy = H / 2
  // screen positions: back = up, in = down, left (1B side) = left, right = right
  const pts = { back: [0, -1], in: [0, 1], left: [-1, 0], right: [1, 0] }
  const col = v => v > 0.05 ? '#059669' : v < -0.05 ? '#e11d48' : '#9ca3af'
  const len = d => 14 + Math.min(28, Math.abs(d?.oae ?? 0) * 9 + (d?.opps ?? 0) * 0.8)
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 p-2.5 text-center">
      <div className="text-[11px] font-bold text-gray-800 dark:text-gray-100 truncate">{r.player}</div>
      <div className="text-[9px] text-gray-400 mb-0.5">
        {(r.positions || [r.pos]).filter(Boolean).join('/')} · {r.oae > 0 ? `+${r.oae}` : r.oae} OAE · {r.opps} ch
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[110px] mx-auto">
        {Object.entries(pts).map(([k, [dx, dy]]) => {
          const d = dirs[k]
          const L = d ? len(d) : 10
          const tipX = cx + dx * L, tipY = cy + dy * L
          const perp = 7
          return (
            <g key={k} {...toneAttr(d == null ? null : d.oae > 0.05 ? 80 : d.oae < -0.05 ? 20 : 50)}>
              <polygon points={`${cx + dy * perp},${cy + dx * perp} ${cx - dy * perp},${cy - dx * perp} ${tipX},${tipY}`}
                fill={d ? col(d.oae) : '#d1d5db'} opacity={d ? 0.75 : 0.25} />
              {d && (
                <text x={cx + dx * (L + 11)} y={cy + dy * (L + 11) + 3} textAnchor="middle"
                  fontSize="8.5" fontWeight="700" fill={col(d.oae)}>
                  {d.oae > 0 ? `+${d.oae}` : d.oae}
                </text>
              )}
              <title>{k}: {d ? `${d.oae > 0 ? '+' : ''}${d.oae} OAE on ${d.opps} chances` : 'no chances'}</title>
            </g>
          )
        })}
        <circle cx={cx} cy={cy} r="4" fill="currentColor" className="text-gray-500 dark:text-gray-300" />
        <text x={cx} y="9" textAnchor="middle" fontSize="7" fill="#9ca3af">BACK</text>
        <text x={cx} y={H - 3} textAnchor="middle" fontSize="7" fill="#9ca3af">IN</text>
      </svg>
    </div>
  )
}

function DefenseTab({ teamCtx }) {
  const exportRef = useRef(null)
  const [team, setTeam] = useState(teamCtx.primary)
  const [context, setContext] = useState('all')
  const [rankPos, setRankPos] = useState('SS')
  const { data, loading } = useApi('/trackman/defense',
    { context, ...(team ? { team } : {}) }, [context, team])
  const d = data || {}
  const gems = (d.plays || []).filter(p => p.made).slice(0, 8)
  const misses = (d.plays || []).filter(p => !p.made).sort((a, b) => b.prob - a.prob).slice(0, 8)

  const statTable = (title, rows, note, ranked = false) => (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">{title}</span>
        <span className="text-[10px] text-gray-400">{note}</span>
      </div>
      {rows?.length ? (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
              <th className="px-4 py-2">{ranked ? '# / Player' : 'Player'}</th><th className="px-2 py-2">Pos</th>
              <th className="px-2 py-2 text-right">Opps</th>
              <th className="px-2 py-2 text-right">Outs</th>
              <th className="px-2 py-2 text-right">xOuts</th>
              <th className="px-2 py-2 text-right">OAE</th>
              <th className="px-2 py-2 text-right">Conv%</th>
              <th className="px-2 py-2 text-right">xConv%</th>
              <th className="px-2 py-2 text-right" title="Reached the ball but no out (scored an error): glove or throw">E</th>
              <th className="px-2 py-2 text-right" title="Ball got past without an error: range">Thru</th>
              {['In', 'Back', 'Left', 'Right'].map(h => (
                <th key={h} className="px-2 py-2 text-right whitespace-nowrap" title="Outs Above Expected when moving this direction (chances)">{h}</th>
              ))}
              {['5★', '4★', '3★', '2★', 'Routine'].map(h => (
                <th key={h} className="px-2 py-2 text-right whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {rows.map((r, i) => (
              <tr key={r.player + (r.pos || '')}>
                <td className="px-4 py-1.5 font-semibold whitespace-nowrap">
                  {ranked && <span className="text-gray-400 font-normal tabular-nums mr-1.5">{i + 1}.</span>}
                  {r.player}
                </td>
                <td className="px-2 py-1.5 text-xs text-gray-400">{r.positions ? r.positions.join('/') : r.pos}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.opps}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.outs}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.x_outs}</td>
                <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${r.oae > 0 ? 'text-emerald-600 dark:text-emerald-400' : r.oae < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                  {r.oae > 0 ? `+${r.oae}` : r.oae}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.conv_pct != null ? `${Math.round(r.conv_pct * 100)}%` : '—'}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-400">{r.x_conv_pct != null ? `${Math.round(r.x_conv_pct * 100)}%` : '—'}</td>
                <td className={`px-2 py-1.5 text-right tabular-nums ${r.errors ? 'text-rose-600 font-semibold' : 'text-gray-400'}`}>{r.errors || '—'}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{r.through || '—'}</td>
                {['in', 'back', 'left', 'right'].map(d => <DirCell key={d} d={r.dirs?.[d]} />)}
                <BucketCells b={r.buckets} />
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="p-8 text-center text-sm text-gray-400">No qualifying opportunities yet.</div>}
    </div>
  )

  const playRow = (p, i) => (
    <div key={i} className="flex items-center justify-between py-1 border-b border-gray-100 dark:border-gray-700 last:border-0 text-[12px]">
      <span className="font-semibold truncate">{p.fielder} <span className="text-gray-400 font-normal">({p.pos})</span></span>
      <span className="text-gray-500 whitespace-nowrap ml-2">
        {p.dir && <span className="uppercase text-[9px] font-bold text-gray-400 mr-1.5">{p.dir}</span>}
        {p.result === 'Error' && <span className="text-[9px] font-bold text-rose-500 mr-1.5">E</span>}
        {p.type === 'OF' ? `${p.dist} ft run · ${p.hang}s hang` : `${p.dist} ft range · ${p.ev} EV`}
        <span className={`ml-2 font-bold ${p.made ? 'text-emerald-600' : 'text-rose-600'}`}>
          {Math.round(p.prob * 100)}%
        </span>
      </span>
    </div>
  )

  return (
    <div className="space-y-3" ref={exportRef}>
      <div className="flex flex-wrap justify-between items-center gap-2">
        <div className="text-[11px] text-gray-400">
          {d.positioned_pitches || 0} positioned pitches · {d.positioned_bbe || 0} batted balls with positioning
        </div>
        <div className="flex gap-2 items-center">
          <ReportActions targetRef={exportRef} filename="trackman_defense" />
          <select value={context} onChange={e => setContext(e.target.value)}
            className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1 text-xs">
            {CONTEXTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <TeamSelect teamCtx={teamCtx} value={team} onChange={setTeam} />
        </div>
      </div>

      {loading ? <div className="p-8 text-center text-sm text-gray-400">Loading…</div> :
       !d.positioned_bbe ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-8 text-center text-sm text-gray-400">
          No positioning data yet. Upload TrackMan's <span className="font-mono text-xs">playerpositioning</span> CSVs
          (they come alongside the game export) in the Overview tab and the defensive metrics
          build automatically from fielder starting spots + ball flight.
        </div>
      ) : (
        <>
          {/* metric leaders */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {(() => {
              const all = [...(d.outfield || []), ...(d.infield || [])]
              const starMade = p => (p.buckets?.['5star']?.[1] || 0) + (p.buckets?.['4star']?.[1] || 0)
              const minOpps = all.filter(p => p.opps >= 5)
              const cards = [
                ['Total OAE leader', [...all].sort((a, b) => b.oae - a.oae)[0], p => `${p.oae > 0 ? '+' : ''}${p.oae}`],
                ['Best OF', (d.outfield || [])[0], p => `${p.oae > 0 ? '+' : ''}${p.oae} OAE`],
                ['Best IF', (d.infield || [])[0], p => `${p.oae > 0 ? '+' : ''}${p.oae} OAE`],
                ['Most star plays (4★+5★)', [...all].sort((a, b) => starMade(b) - starMade(a))[0], p => `${starMade(p)} made`],
              ]
              return cards.map(([label, p, fmt2]) => (
                <div key={label} className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 px-3 py-2.5">
                  <div className="text-[9px] font-bold uppercase tracking-wider text-gray-400">{label}</div>
                  {p ? (
                    <>
                      <div className="text-[14px] font-bold text-portal-purple dark:text-portal-accent-light truncate">{p.player}</div>
                      <div className="text-[12px] tabular-nums text-gray-500">{fmt2(p)} · {p.opps} chances</div>
                    </>
                  ) : <div className="text-sm text-gray-400">—</div>}
                </div>
              ))
            })()}
          </div>

          {/* range shapes: OAE by movement direction */}
          {(() => {
            const shapes = [...(d.outfield || []), ...(d.infield || [])]
              .filter(p => p.opps >= 8 && p.dirs && Object.keys(p.dirs).length)
              .sort((a, b) => b.opps - a.opps).slice(0, 10)
            return shapes.length > 0 && (
              <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
                <div className="flex items-baseline justify-between mb-2.5">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Range shapes — OAE by movement direction</span>
                  <span className="text-[10px] text-gray-400">petal length = workload, color = above/below expectation · left = 1B side</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
                  {shapes.map(p => <DirRose key={p.player} r={p} />)}
                </div>
              </div>
            )
          })()}

          {statTable('Outfield — overall (all positions combined)', d.outfield,
            'OAE = outs made minus expected · star buckets = made/chances by difficulty')}
          {statTable('Infield — overall (all positions combined)', d.infield,
            'OAE = outs made minus expected on grounders in range plus popups and bloops')}

          {/* per-position rankings: only chances AT that position */}
          <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Position rankings</span>
              <div className="flex rounded-lg overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700">
                {['SS', '2B', '3B', '1B', 'LF', 'CF', 'RF'].map(p => (
                  <button key={p} onClick={() => setRankPos(p)}
                    className={`px-2.5 py-1 text-xs font-bold ${rankPos === p
                      ? 'bg-portal-purple text-white'
                      : 'bg-white dark:bg-gray-800 text-gray-500'}`}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
            {statTable(`${rankPos} — ranked by OAE at ${rankPos} only`,
              d.by_position?.[rankPos] || [],
              'Chances at this position only; time at other spots is excluded', true)}
          </div>

          {/* game-by-game breakdown */}
          <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
            <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Game by game</span>
              <span className="text-[10px] text-gray-400">team defensive chances per session</span>
            </div>
            {(d.games || []).length ? (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
                    <th className="px-4 py-2">Date</th><th className="px-2 py-2">Matchup</th>
                    <th className="px-2 py-2 text-right">Chances</th>
                    <th className="px-2 py-2 text-right">Outs</th>
                    <th className="px-2 py-2 text-right">xOuts</th>
                    <th className="px-2 py-2 text-right">Team OAE</th>
                    <th className="px-2 py-2">Best play</th>
                    <th className="px-2 py-2">Toughest miss</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {d.games.map(g => (
                    <tr key={g.session_id}>
                      <td className="px-4 py-1.5 whitespace-nowrap">{g.date || '—'}</td>
                      <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">{g.matchup}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{g.opps}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{g.outs}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{g.x_outs}</td>
                      <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${g.oae > 0 ? 'text-emerald-600 dark:text-emerald-400' : g.oae < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                        {g.oae > 0 ? `+${g.oae}` : g.oae}
                      </td>
                      <td className="px-2 py-1.5 text-xs whitespace-nowrap">
                        {g.best_play ? `${g.best_play.fielder} (${Math.round(g.best_play.prob * 100)}%)` : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-xs whitespace-nowrap text-gray-500">
                        {g.worst_miss ? `${g.worst_miss.fielder} (${Math.round(g.worst_miss.prob * 100)}%)` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="p-6 text-center text-sm text-gray-400">No positioned games yet.</div>}
          </div>

          <p className="text-[10.5px] text-gray-400 leading-snug max-w-3xl">
            How it works: every positioning CSV records each fielder's starting spot at pitch release.
            We pair that with the ball's landing point and hang time (air balls, credited to the
            nearest fielder, infielders included) or its path and exit velocity (ground balls) to
            estimate how likely an average college defender makes the play, then
            compare to what actually happened. In / Back / Left / Right split each player's OAE by the
            direction they had to move (left = the 1B side, right = the 3B side, from the fielder's
            view facing the plate). E counts plays the scorer ruled an error, meaning the fielder
            REACHED the ball and the glove or throw failed; Thru counts balls that got past cleanly,
            which is range or positioning. The data can't separate a bobble from a bad throw within an
            error. Physics-based estimates, best used to compare players within your own data, not
            against MLB numbers.
          </p>
        </>
      )}
    </div>
  )
}

// ── Values — one run-value ledger per player ──

function ValuesTab({ teamCtx }) {
  const exportRef = useRef(null)
  const [team, setTeam] = useState(teamCtx.primary)
  const [posAdj, setPosAdj] = useState(false)
  const [shrink, setShrink] = useState(false)
  const { data, loading } = useApi('/trackman/values',
    { ...(team ? { team } : {}), pos_adj: posAdj, shrink },
    [team, posAdj, shrink])
  const rows = data?.players || []
  const rv = v => v == null ? <span className="text-gray-300 dark:text-gray-600">—</span> : (
    <span className={`font-semibold tabular-nums ${v > 0.05 ? 'text-emerald-600 dark:text-emerald-400' : v < -0.05 ? 'text-rose-600 dark:text-rose-400' : 'text-gray-500'}`}>
      {v > 0 ? `+${v}` : v}
    </span>
  )
  const COLS = [
    ['off_runs', 'Offense', 'wRAA: season wOBA vs the division average, per PA'],
    ['bsr_runs', 'Baserun', 'SB x 0.2 - CS x 0.4 from season steals'],
    ['if_runs', 'Infield', 'Defense-tab OAE at infield positions x 0.70 runs/out'],
    ['of_runs', 'Outfield', 'Defense-tab OAE at outfield positions x 0.80 runs/out'],
    ['catch_runs', 'Catching', 'Framing runs + blended arm runs from the Catching tab'],
    ['pitch_runs', 'Pitching', '(division avg FIP - FIP) / 9 x IP'],
  ]
  const leaders = COLS.map(([k, label]) => {
    const best = [...rows].filter(r => r[k] != null).sort((a, b) => b[k] - a[k])[0]
    return [label, best, k]
  })
  return (
    <div className="space-y-3" ref={exportRef}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-gray-400">
          Every column is average-relative: 0 = an average player in the division. Season stats + tracked
          data combined. Rough rule: about 10 runs = 1 win.
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <ReportActions targetRef={exportRef} filename="trackman_values" />
          <button onClick={() => setPosAdj(v => !v)}
            title="WAR-style premium-position credit: C +4.5, SS +2.5, CF/2B/3B +1.0, LF/RF -2.5, 1B -4.5 runs per full season, scaled by playing time"
            className={`text-[11px] font-bold px-2.5 py-1 rounded-full ring-1 ${posAdj
              ? 'bg-portal-purple text-white ring-portal-purple'
              : 'bg-white dark:bg-gray-800 text-gray-500 ring-gray-200 dark:ring-gray-700'}`}>
            Position adjustment {posAdj ? 'on' : 'off'}
          </button>
          <button onClick={() => setShrink(v => !v)}
            title="Regresses small-sample tracked values toward zero (defense by chances, framing by takes) so a hot week doesn't outrank a solid season"
            className={`text-[11px] font-bold px-2.5 py-1 rounded-full ring-1 ${shrink
              ? 'bg-portal-purple text-white ring-portal-purple'
              : 'bg-white dark:bg-gray-800 text-gray-500 ring-gray-200 dark:ring-gray-700'}`}>
            Small-sample stabilizer {shrink ? 'on' : 'off'}
          </button>
          <TeamSelect teamCtx={teamCtx} value={team} onChange={setTeam} />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        {leaders.map(([label, best, k]) => (
          <div key={label} className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 px-3 py-2.5">
            <div className="text-[9px] font-bold uppercase tracking-wider text-gray-400">{label} leader</div>
            {best ? (
              <>
                <div className="text-[13px] font-bold text-portal-purple dark:text-portal-accent-light truncate">{best.player}</div>
                <div className="text-[12px] tabular-nums">{rv(best[k])} runs</div>
              </>
            ) : <div className="text-sm text-gray-400">—</div>}
          </div>
        ))}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
        <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Player run values</span>
          <span className="text-[10px] text-gray-400">sorted by total value</span>
        </div>
        {loading ? <div className="p-6 text-center text-sm text-gray-400">Loading…</div> :
         rows.length === 0 ? <div className="p-8 text-center text-sm text-gray-400">No matched players yet.</div> : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
                <th className="px-4 py-2"># / Player</th>
                <th className="px-2 py-2">Team</th>
                <th className="px-2 py-2 text-right" title="Season PA / IP behind the numbers">PA · IP</th>
                {COLS.map(([k, label, tip]) => (
                  <th key={k} className="px-2 py-2 text-right" title={tip}>{label}</th>
                ))}
                <th className="px-2 py-2 text-right" title="Pitch-level run value from tracked TrackMan sessions (count-based, centered on your corpus). Same innings as the Pitching column, different lens — informational, never summed into Total">RV (trk)</th>
                {posAdj && <th className="px-2 py-2 text-right" title="Positional adjustment at the player's primary tracked position">Pos adj</th>}
                <th className="px-2 py-2 text-right font-bold" title="Sum of every component">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {rows.map((r, i) => (
                <tr key={r.player}>
                  <td className="px-4 py-1.5 font-semibold whitespace-nowrap">
                    <span className="text-gray-400 font-normal tabular-nums mr-1.5">{i + 1}.</span>
                    {r.player_id
                      ? <Link to={`/player/${r.player_id}`} className="hover:underline text-portal-purple dark:text-indigo-300">{r.player}</Link>
                      : r.player}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-gray-400 whitespace-nowrap">{r.site_team || r.tm_team}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-xs text-gray-400 whitespace-nowrap">
                    {[r.pa && `${r.pa} PA`, r.ip && `${r.ip} IP`].filter(Boolean).join(' · ') || '—'}
                  </td>
                  {COLS.map(([k]) => (
                    <td key={k} className="px-2 py-1.5 text-right">{rv(r[k])}</td>
                  ))}
                  <td className="px-2 py-1.5 text-right text-xs opacity-75">{rv(r.tracked_rv)}</td>
                  {posAdj && (
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      {r.pos && <span className="text-[10px] text-gray-400 mr-1">{r.pos}</span>}
                      {rv(r.pos_adj_runs ?? null)}
                    </td>
                  )}
                  <td className={`px-2 py-1.5 text-right tabular-nums font-bold text-[14px] ${r.total_runs > 0 ? 'text-emerald-700 dark:text-emerald-400' : r.total_runs < 0 ? 'text-rose-700 dark:text-rose-400' : ''}`}>
                    {r.total_runs > 0 ? `+${r.total_runs}` : r.total_runs}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-[10.5px] text-gray-400 leading-snug max-w-3xl">
        Offense and pitching come from the site's real season stats (wOBA and FIP against
        division averages, so a D3 bat is measured against D3, not D1). Baserunning uses standard
        stolen-base run weights. Infield, outfield, and catching come from the suite's tracked-data
        models (positioning + pitch calls + pop times), which cover only positioned games — those
        columns grow as more positioning files are uploaded. Players missing a column simply have
        no data there yet; totals sum whatever exists. The position-adjustment toggle adds the
        WAR-style premium-spot credit (catchers and shortstops carry defensive burdens raw numbers
        miss; first basemen give some back), scaled by playing time. The stabilizer regresses
        small tracked samples toward zero so one hot weekend can't outrank a full season.
      </p>
    </div>
  )
}
