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
import { saveNodeAsPdf, saveNodesAsPdf, saveNodeAsCsv, downloadCsvText } from '../lib/reportExport'
import StaffManager from '../components/portal/StaffManager'
import TrackmanGlossary from '../components/portal/TrackmanGlossary'
import StatTip, { StatAvgContext } from '../components/portal/StatTip'
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
  bullpen: { label: 'Bullpen', cls: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300' },
}

// TrackMan seasons run July 1 - June 30: June games close the spring
// season, July starts the next cycle (2025 = the 2025-26 season).
const seasonOf = (d) => {
  if (!d) return null
  const y = +d.slice(0, 4), m = +d.slice(5, 7)
  return m >= 7 ? y : y - 1
}
const seasonLabel = (y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`

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

  // Season selector: seasons present in the uploads, defaulting to the
  // NEWEST one with data — two seasons never blend unless 'All' is picked.
  const seasonsAvail = useMemo(() => {
    const set = new Set((overview?.sessions || []).map(s => seasonOf(s.session_date)).filter(v => v != null))
    if (!set.size) {
      const now = new Date()
      set.add(now.getMonth() + 1 >= 7 ? now.getFullYear() : now.getFullYear() - 1)
    }
    return [...set].sort((a, b) => b - a)
  }, [overview])
  const [seasonSel, setSeasonSel] = useState(null)   // null = auto (latest)
  const season = seasonSel === 'all' ? undefined : (seasonSel ?? seasonsAvail[0])

  // Corpus averages behind every hover card. One fetch for the whole suite;
  // surfaces that show a filtered cohort pass their own average instead.
  const { data: avgData } = useApi(hasData ? '/trackman/stat-averages' : null,
    { context: 'all', ...(primary ? { team: primary } : {}), season }, [primary, season])
  const statAvg = useMemo(() => ({ averages: avgData?.averages || {} }), [avgData])

  return (
    <StatAvgContext.Provider value={statAvg}>
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
        <div className="pt-1.5 shrink-0 flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Season</span>
            {seasonsAvail.map(y => (
              <button key={y} onClick={() => setSeasonSel(y)}
                className={`px-2.5 py-1 rounded-full text-[12px] font-bold ${
                  season === y ? 'bg-portal-purple text-white'
                    : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
                {seasonLabel(y)}
              </button>
            ))}
            {seasonsAvail.length > 1 && (
              <button onClick={() => setSeasonSel('all')}
                className={`px-2.5 py-1 rounded-full text-[12px] font-bold ${
                  season === undefined ? 'bg-portal-purple text-white'
                    : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
                All
              </button>
            )}
          </div>
          <TrackmanGlossary />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 mb-4 flex-wrap">
        {[['overview', 'Overview & Upload'], ['pitching', 'Pitching'], ['hitting', 'Hitting'],
          ['lab', 'Pitcher Lab'], ['hlab', 'Hitter Lab'], ['leaders', 'Leaderboards'],
          ['sessions', 'Session Review'], ['catching', 'Catching'], ['defense', 'Defense'], ['values', 'Values'], ['board', 'Coach Board'], ['reports', 'Custom Reporting']].map(([k, label]) => (
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

      {tab === 'overview' && <OverviewTab overview={overview} refetch={refetch} season={season} onReview={(id) => { setReviewSession(id); setTab('sessions') }} />}
      {tab === 'pitching' && (hasData ? <PitchingTab key={`${teamCtx.primary}-${season}`} teamCtx={teamCtx} season={season} onOpenLab={(name) => { setLabPitcher(name); setTab('lab') }} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'hitting' && (hasData ? <HittingTab key={`${teamCtx.primary}-${season}`} teamCtx={teamCtx} season={season} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'lab' && (hasData ? <PlayerLabTab key={`${teamCtx.primary}-${season}`} pitcher={labPitcher} setPitcher={setLabPitcher} teamCtx={teamCtx} season={season} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'hlab' && (hasData ? <HitterLabTab key={`${teamCtx.primary}-${season}`} teamCtx={teamCtx} season={season} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'leaders' && (hasData ? <LeaderboardsTab key={`${teamCtx.primary}-${season}`} teamCtx={teamCtx} season={season} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'sessions' && (hasData ? <SessionsTab overview={overview} season={season} sessionId={reviewSession} setSessionId={setReviewSession} teamCtx={teamCtx} onOpenLab={(name) => { setLabPitcher(name); setTab('lab') }} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'catching' && (hasData ? <CatchingTab key={`${teamCtx.primary}-${season}`} teamCtx={teamCtx} season={season} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'defense' && (hasData ? <DefenseTab key={`${teamCtx.primary}-${season}`} teamCtx={teamCtx} season={season} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'values' && (hasData ? <ValuesTab key={`${teamCtx.primary}-${season}`} teamCtx={teamCtx} season={season} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'reports' && (hasData ? <CustomReportTab key={`${teamCtx.primary}`} teamCtx={teamCtx} season={season} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
      {tab === 'board' && (hasData ? <CoachBoardTab key={`${teamCtx.primary}-${season}`} teamCtx={teamCtx} season={season} /> : <EmptyNudge onGo={() => setTab('overview')} />)}
    </div>
    </StatAvgContext.Provider>
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

function OverviewTab({ overview, refetch, onReview, season }) {
  const libRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState(null)
  const inputRef = useRef(null)
  const totals = overview?.totals || { sessions: 0, pitches: 0, bbe: 0, by_type: {} }
  const sessions = (overview?.sessions || []).filter(x => !season || seasonOf(x.session_date) === season)

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
      <div ref={libRef} className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Session library</span>
          <button onClick={() => saveNodeAsCsv(libRef.current, 'trackman_sessions')}
            className="text-[12px] font-semibold text-portal-purple dark:text-indigo-300 hover:underline">
            Save CSV
          </button>
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
                          <option value="bullpen">Bullpen</option>
                        </select>
                      </td>
                      <td className="px-2 py-2 text-gray-500 dark:text-gray-400">
                        {s.session_type === 'bp' ? (s.stadium || 'BP')
                          : s.session_type === 'bullpen' ? `Bullpen · ${s.stadium || '?'}`
                          : `${s.away_team || '?'} @ ${s.home_team || '?'}`}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{s.pitch_count}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{s.bbe_count}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap">
                        {s.positioned_count > 0 ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 rounded-full px-2 py-0.5"
                            title={`${s.positioned_count} of ${s.pitch_count} pitches have fielder positions`}>
                            ▦ {s.positioned_count}
                          </span>
                        ) : s.session_type !== 'bp' && s.session_type !== 'bullpen' ? (
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

const CONTEXTS = [['live', 'All live'], ['game', 'Games only'], ['scrimmage', 'Scrimmages'], ['intrasquad', 'Intrasquads'], ['bullpen', 'Bullpens'], ['all', 'Everything']]
// Session-type options for the fielding/value surfaces. Bullpens are left
// out: no batted balls and a placeholder batter, so nothing to field or value.
const DEF_CONTEXTS = CONTEXTS.filter(([k]) => k !== 'bullpen')

// ── Pitch shape read (slot-frame verdict from the backend) ─────────
// Every arsenal row carries a shape note ("gyro", "sweepy", "kick / low-spin")
// and, when the pitch's shape clearly argues for another name, a suggestion
// the coach can apply with one click. The operator's tag is never renamed
// by code; this is the human-in-the-loop half of "never mess up a pitch type".
async function retagGroup(pitcher, team, fromType, toType) {
  const r = await fetch('/api/v1/trackman/pitchers/retag-group', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ pitcher, team: team || null, from_type: fromType, to_type: toType }),
  })
  return r.ok
}

function ShapeChip({ note, suggest, pitchType, pitcher, team, onDone }) {
  const [busy, setBusy] = useState(false)
  if (!note && !suggest) return null
  return (
    <span className="ml-1.5 inline-flex items-center gap-1 align-middle font-normal">
      {note && <span className="text-[10px] text-gray-400">{note}</span>}
      {suggest && (
        <button disabled={busy}
          onClick={async (e) => {
            e.stopPropagation()
            if (!window.confirm(`Rename every ${pitchType} from ${pitcher} to ${suggest}? Shape says it is a ${suggest.toLowerCase()}. You can change any pitch back in the Player Lab.`)) return
            setBusy(true)
            const ok = await retagGroup(pitcher, team, pitchType, suggest)
            setBusy(false)
            if (ok && onDone) onDone()
          }}
          title="The shape of this pitch (velocity gap, ride and sweep relative to his fastball, spin) reads as a different type. Click to rename every one of these pitches; the operator's tag stays on file."
          className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-200 dark:ring-amber-800">
          shape says {suggest} · apply
        </button>
      )}
    </span>
  )
}

function SlotChip({ slot }) {
  if (!slot) return null
  return (
    <span className="text-[11px] text-gray-500 bg-gray-100 dark:bg-gray-700 dark:text-gray-300 rounded px-1.5 py-0.5"
      title="Arm slot read from the fastball's movement direction (degrees above horizontal). Every pitch type below is judged relative to this fastball, so a sidearmer's slider is not called a sweeper just because it sweeps.">
      {slot.label} · {slot.deg}°
    </span>
  )
}

function PitchingTab({ onOpenLab, teamCtx, season }) {
  const exportRef = useRef(null)
  const [context, setContext] = useState('live')
  const [ptype, setPtype] = useState('')
  const [vsSide, setVsSide] = useState('')
  const [view, setView] = useState('cards')   // cards (by pitch type) | board (every arm, one table)
  const { data, loading, refetch } = useApi('/trackman/pitching',
    { context, ...(vsSide ? { side: vsSide } : {}), season }, [context, vsSide])
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
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-full ring-1 ring-gray-200 dark:ring-gray-700 overflow-hidden text-[12px] font-semibold">
            {[['cards', 'By pitch type'], ['board', 'Team board']].map(([k, label]) => (
              <button key={k} onClick={() => setView(k)}
                className={`px-2.5 py-1 ${view === k ? 'bg-portal-purple text-white' : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400'}`}>
                {label}
              </button>
            ))}
          </div>
          <ReportActions csv targetRef={exportRef} filename={`trackman_pitching_${view}_${context}`} />
          <TeamSelect teamCtx={teamCtx} value={team} onChange={setTeam} />
        </div>
      </div>

      {loading ? <div className="text-sm text-gray-400 p-6 text-center">Loading…</div> : view === 'board' ? (
        <div ref={exportRef}>
          <PitcherBoard pitchers={team ? pitchers.filter(p => p.team === team) : pitchers} context={context} onOpenLab={onOpenLab} />
        </div>
      ) : (
        <div ref={exportRef} className="space-y-3">
        {shown.map(p => (
          <div key={`${p.pitcher}-${p.team}`} className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-hidden">
            <div className="px-4 py-2.5 flex items-center gap-2 border-b border-gray-100 dark:border-gray-700">
              <span className="font-bold text-gray-900 dark:text-gray-100">{p.pitcher}</span>
              <span className="text-[11px] font-bold text-gray-500 bg-gray-100 dark:bg-gray-700 rounded px-1.5 py-0.5">
                {p.throws === 'Left' ? 'LHP' : p.throws === 'Right' ? 'RHP' : '–'}
              </span>
              <SlotChip slot={p.slot} />
              <span className="text-xs text-gray-400">{p.team}</span>
              {p.rv != null && context !== 'bullpen' && (
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
                    <th className="px-2 py-1.5 text-right" title="Tracked pitches of this type — weigh every grade by it">N</th>
                    <th className="px-2 py-1.5 text-right"><StatTip k="stuff" group="pitching" label="Stuff" /></th>
                    <th className="px-2 py-1.5 text-right"><StatTip k="loc" group="pitching" label="Loc+" /></th>
                    <th className="px-2 py-1.5 text-right"><StatTip k="usage_pct" group="pitching" label="Use%" /></th>
                    <th className="px-2 py-1.5 text-right"><StatTip k="velo" group="pitching" label="Velo" /></th>
                    <th className="px-2 py-1.5 text-right"><StatTip k="max_velo" group="pitching" label="Max" /></th>
                    <th className="px-2 py-1.5 text-right"><StatTip k="spin" group="pitching" label="Spin" /></th>
                    <th className="px-2 py-1.5 text-right"><StatTip k="ivb" group="pitching" label="IVB" /></th>
                    <th className="px-2 py-1.5 text-right"><StatTip k="hb" group="pitching" label="HB" /></th>
                    <th className="px-2 py-1.5 text-right"><StatTip k="extension" group="pitching" label="Ext" /></th>
                    <th className="px-2 py-1.5 text-right"><StatTip k="zone_pct" group="pitching" label="Zone%" /></th>
                    {context !== 'bullpen' && (<>
                      <th className="px-2 py-1.5 text-right"><StatTip k="shadow_pct" group="pitching" label="Shdw%" /></th>
                      <th className="px-2 py-1.5 text-right"><StatTip k="whiff_pct" group="pitching" label="Whiff%" /></th>
                      <th className="px-2 py-1.5 text-right"><StatTip k="chase_pct" group="pitching" label="Chase%" /></th>
                      <th className="px-2 py-1.5 text-right"><StatTip k="csw_pct" group="pitching" label="CSW%" /></th>
                      <th className="px-2 py-1.5 text-right"><StatTip k="ev_against" group="pitching" label="EV agn" /></th>
                      <th className="px-2 py-1.5 text-right"><StatTip k="rv" group="pitching" label="RV" /></th>
                      <th className="px-2 py-1.5 text-right"><StatTip k="rv100" group="pitching" label="RV/100" /></th>
                    </>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                  {p.arsenal.map(a => (
                    <tr key={a.pitch_type}>
                      <td className="px-4 py-1.5 font-semibold whitespace-nowrap">
                        <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: PITCH_COLORS[a.pitch_type] || '#9ca3af' }} />
                        {a.pitch_type}
                        <ShapeChip note={a.shape_note} suggest={a.suggest} pitchType={a.pitch_type}
                          pitcher={p.pitcher} team={p.team} onDone={refetch} />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-gray-400">{a.count}</td>
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
                      {context !== 'bullpen' && (<>
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
                      </>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {context !== 'bullpen' && <PitcherLineStrip line={p.line} compact />}
          </div>
        ))}
        </div>)}
      {!loading && shown.length === 0 && (
        <div className="text-sm text-gray-400 p-6 text-center">No pitching data in this context.</div>
      )}
    </div>
  )
}

// ── Hitting ──────────────────────────────────────────────────────

const PITCH_TYPE_OPTIONS = ['Fastball', 'Sinker', 'Cutter', 'Slider', 'Sweeper', 'Curveball', 'ChangeUp', 'Splitter']

const HB_CONTEXTS = [['live', 'All live'], ['game', 'Games'], ['scrimmage', 'Scrimmages'],
  ['intrasquad', 'Intrasquads'], ['bp', 'BP']]

// column defs: [label, key, tip, {higher, dec, kind}]
const HB_EV_ZONES = [['EV Up', 'zev_up'], ['EV Down', 'zev_down'], ['EV In', 'zev_in'],
  ['EV Out', 'zev_out'], ['EV Mid', 'zev_mid']]
const HB_RV_ZONES = [['RV Up', 'zrv_up'], ['RV Down', 'zrv_down'], ['RV In', 'zrv_in'],
  ['RV Out', 'zrv_out']]
const HB_FULL = [
  ['Pitches', 'pitches', 'Pitches seen', { plain: true, dec: 0 }],
  ['BBE', 'bbe', 'Tracked batted balls', { plain: true, dec: 0 }],
  ['Swing%', 'swing_pct', 'Swings per pitch seen', {}],
  ['Z-Sw%', 'zone_swing_pct', 'Zone swing: swings per pitch IN the zone. Low here is passivity on hittable pitches', {}],
  ['Contact%', 'contact_pct', 'Contact per swing', {}],
  ['Z-Ct%', 'zone_contact_pct', 'Zone contact: contact per swing at pitches IN the zone. The bat-to-ball skill that matters most, since these are the pitches he should handle', {}],
  ['O-Ct%', 'ozone_contact_pct', 'Out-of-zone contact: contact per swing at pitches OUT of the zone. High here is not always good — weak contact on pitchers\u2019 pitches turns balls into outs', {}],
  ['Chase%', 'chase_pct', 'Swings at pitches out of the zone', { higher: false }],
  ['FP Sw%', 'fp_swing_pct', 'First-pitch swing rate', { plain: true }],
  ['2K Ct%', 'k2_contact_pct', 'Contact per swing with two strikes', {}],
  ['K%', 'k_pct', 'Strikeouts per completed plate appearance', { higher: false }],
  ['BB%', 'bb_pct', 'Walks per completed plate appearance', {}],
  ['Avg EV', 'avg_ev', 'Average exit velocity', {}],
  ['90th EV', 'p90_ev', '90th percentile exit velo, the steadiest top-end bat speed read', {}],
  ['Max EV', 'max_ev', null, {}],
  ['Avg LA', 'avg_la', 'Average launch angle', { plain: true }],
  ['HH%', 'hh_pct', 'Hard-hit: 90+ mph', {}],
  ['Brl%', 'barrel_pct', 'College-scaled barrel: 95+ mph in the 8-32 degree window', {}],
  ['GB%', 'gb_pct', 'Launch under 10 degrees', { higher: false }],
  ['LD%', 'ld_pct', 'Launch 10-25 degrees', {}],
  ['FB%', 'fb_pct', 'Launch 25-50 degrees', { plain: true }],
  ['AirPull%', 'airpull_pct', 'Pulled share of air balls (10+ degrees)', {}],
  ['Depth', 'depth', 'Avg contact depth (ft toward the pitcher). Green = the measured 1.3-2.7 ft damage window', { kind: 'depth', dec: 2 }],
  ['xAVG', 'xavg', 'Expected AVG from EV + launch + spray, college-calibrated', { dec: 3 }],
  ['xSLG', 'xslg', null, { dec: 3 }],
  ['xwOBA', 'xwoba', null, { dec: 3 }],
  ['xwOBAcon', 'xwobacon', 'Expected wOBA on contact only', { dec: 3 }],
  ['RV', 'rv', 'Total run value of his swing decisions, centered on your corpus', { plus: true }],
  ['Heart RV', 'heart_rv', 'Run value on pitches in the heart of the zone', { plus: true }],
  ['Shdw RV', 'shadow_rv', 'Run value on the zone edges', { plus: true }],
  ['Chase RV', 'chase_rv', 'Run value on chase + waste pitches (good takes earn here)', { plus: true }],
  ['Transfer', 'transfer', 'Live hard-hit% minus BP hard-hit% this season', { plus: true }],
  ...HB_RV_ZONES.map(([l, k]) => [l, k, 'Run value earned on heart+shadow pitches in this part of the zone (swings and takes, min 8 priced); in/out are relative to the batter. The middle is already covered by Heart RV', { plus: true }]),
  // box-score line from the same CSVs (scorer result fields), least important, last
  ['PA', 'pa', 'Plate appearances', { plain: true, dec: 0 }],
  ['AB', 'ab', 'At-bats', { plain: true, dec: 0 }],
  ['H', 'h', 'Hits', { plain: true, dec: 0 }],
  ['2B', 'd2', 'Doubles', { plain: true, dec: 0 }],
  ['3B', 'd3', 'Triples', { plain: true, dec: 0 }],
  ['HR', 'hr', 'Home runs', { plain: true, dec: 0 }],
  ['BB', 'bb', 'Walks', { plain: true, dec: 0 }],
  ['K', 'k', 'Strikeouts', { plain: true, dec: 0 }],
  ['HBP', 'hbp', 'Hit by pitch', { plain: true, dec: 0 }],
  ['AVG', 'avg', 'Batting average', { dec: 3 }],
  ['OBP', 'obp', 'On-base percentage', { dec: 3 }],
  ['SLG', 'slg', 'Slugging', { dec: 3 }],
  ['OPS', 'ops', 'OBP + SLG', { dec: 3 }],
  ['ISO', 'iso', 'Isolated power: SLG minus AVG', { dec: 3 }],
  ['BABIP', 'babip', 'Batting average on balls in play', { dec: 3 }],
  ['wOBA', 'woba', 'Weighted on-base average (actual results)', { dec: 3 }],
  ['wRC+', 'wrc_plus', 'Runs created vs the hitters in this view; 100 = average', { dec: 0 }],
]

// ── Box-score line strip (pitchers) ──────────────────────────────
const PITCHER_LINE = [
  ['IP', 'ip_str', 'ip'], ['BF', 'bf', 'bf'], ['H', 'h', 'h_allowed'], ['R', 'r', 'r_allowed'],
  ['HR', 'hr', 'hr_allowed'], ['BB', 'bb', 'bb_allowed'], ['K', 'k', 'k_pitched'], ['HBP', 'hbp', 'hbp_allowed'],
  ['WHIP', 'whip', 'whip'], ['BAA', 'baa', 'baa'], ['FIP', 'fip', 'fip'], ['K/9', 'k9', 'k9'], ['BB/9', 'bb9', 'bb9'],
  ['RA/9', 'ra9', 'ra9'],
]
function PitcherLineStrip({ line, compact }) {
  if (!line) return null
  const fmtV = (k, v) => v == null ? '–' : (k === 'baa' ? v.toFixed(3).replace(/^0/, '') : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(k === 'whip' || k === 'fip' || k === 'ra9' ? 2 : 1) : v)
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${compact ? 'px-4 py-2 border-t border-gray-100 dark:border-gray-700' : ''}`}>
      <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Line</span>
      {PITCHER_LINE.map(([label, k, tipKey]) => (
        <span key={k} className="text-[12px] tabular-nums">
          <span className="text-[10px] uppercase tracking-wide text-gray-400 mr-1"><StatTip k={tipKey} group="pitching" label={label} /></span>
          <span className="font-semibold text-gray-800 dark:text-gray-100">{fmtV(k, line[k])}</span>
        </span>
      ))}
    </div>
  )
}


// ── Team pitching board: one row per arm, every pitch type combined ──
// Mirrors the hitting board: sortable, shaded against the arms shown.
const PB_COLS = [
  ['Pitches', 'pitches', 'Pitches thrown in this view', { plain: true, dec: 0 }],
  ['IP', 'ip_str', 'Innings, rebuilt from results (strikeouts, outs, fielder\u2019s choices, sacrifices; double plays and pickoffs use the recorded count). Intrasquad innings are pitch-count innings', { plain: true, str: true }],
  ['BF', 'bf', 'Batters faced', { plain: true, dec: 0 }],
  ['Stuff', 'stuff', 'Pitch-weighted Stuff+ across his arsenal', { dec: 0 }],
  ['Loc+', 'loc', 'Pitch-weighted Location+ across his arsenal', { dec: 0 }],
  ['FB velo', 'fb_velo', 'Average fastball-family velocity', {}],
  ['FB max', 'fb_max', 'Top fastball velocity', { plain: true }],
  ['Strike%', 'strike_pct', 'Strikes (called, swinging, foul, in play) per pitch', {}],
  ['Zone%', 'zone_pct', 'Pitches in the strike zone', {}],
  ['Shdw%', 'shadow_pct', 'Shadow rate: living on the edges', {}],
  ['Whiff%', 'whiff_pct', 'Whiffs per swing, all pitches', {}],
  ['Chase%', 'chase_pct', 'Swings induced on pitches out of the zone', {}],
  ['CSW%', 'csw_pct', 'Called strikes plus whiffs per pitch', {}],
  ['K%', 'k_pct', 'Strikeouts per batter faced', {}],
  ['BB%', 'bb_pct', 'Walks per batter faced', { higher: false }],
  ['EV agn', 'ev_against', 'Average exit velocity allowed', { higher: false }],
  ['HH% agn', 'hh_pct', 'Hard-hit (90+) share of batted balls allowed', { higher: false }],
  ['GB% agn', 'gb_pct', 'Ground-ball share of batted balls allowed (launch under 10)', {}],
  ['RV', 'rv', 'Run value: runs saved vs the average pitch in your data', { plus: true }],
  ['RV/100', 'rv100', 'Run value per 100 pitches', { plus: true, dec: 2 }],
  ['H', 'h', 'Hits allowed', { plain: true, dec: 0 }],
  ['R', 'r', 'Runs allowed (TrackMan does not score earned runs)', { plain: true, dec: 0 }],
  ['HR', 'hr', 'Home runs allowed', { plain: true, dec: 0 }],
  ['BB', 'bb', 'Walks', { plain: true, dec: 0 }],
  ['K', 'k', 'Strikeouts', { plain: true, dec: 0 }],
  ['HBP', 'hbp', 'Hit batters', { plain: true, dec: 0 }],
  ['WHIP', 'whip', 'Walks plus hits per inning', { higher: false, dec: 2 }],
  ['BAA', 'baa', 'Batting average against', { higher: false, dec: 3 }],
  ['FIP', 'fip', 'Fielding-independent pitching on this corpus\u2019s RA/9 scale', { higher: false, dec: 2 }],
  ['K/9', 'k9', 'Strikeouts per nine', {}],
  ['BB/9', 'bb9', 'Walks per nine', { higher: false }],
  ['RA/9', 'ra9', 'Runs allowed per nine (R, not ER)', { higher: false, dec: 2 }],
]
const PB_TIP_KEY = { h: 'h_allowed', r: 'r_allowed', hr: 'hr_allowed', bb: 'bb_allowed', k: 'k_pitched', hbp: 'hbp_allowed', ip_str: 'ip' }

function PitcherBoard({ pitchers, context, onOpenLab }) {
  const [sortK, setSortK] = useState('pitches')
  const [sortD, setSortD] = useState(-1)
  const rows = useMemo(() => {
    const r = pitchers.map(p => ({
      pitcher: p.pitcher, throws: p.throws, team: p.team, pitches: p.pitches,
      rv: p.rv, rv100: p.rv100, shadow_pct: p.shadow_pct,
      ...(p.totals || {}), ...(p.line || {}),
      ip: p.line?.ip ?? null, ip_str: p.line?.ip_str ?? null,
    }))
    r.sort((a, b) => {
      const key = sortK === 'ip_str' ? 'ip' : sortK
      const x = a[key] ?? -1e9, y = b[key] ?? -1e9
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sortD
    })
    return r
  }, [pitchers, sortK, sortD])
  const clickSort = (k) => {
    if (sortK === k) setSortD(d => -d)
    else { setSortK(k); setSortD(k === 'pitcher' ? 1 : -1) }
  }
  const cohort = useMemo(() => {
    const m = {}
    PB_COLS.forEach(([, k, , o = {}]) => { m[k] = o.str ? [] : rows.map(b => b[k]).filter(v => v != null).map(Number) })
    return m
  }, [rows])
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
          Pitching board — {CONTEXTS.find(c => c[0] === context)?.[1]} · {rows.length} arms
        </span>
        <span className="text-[10px] text-gray-400">every pitch type combined · click a column to sort · click a pitcher for his lab · shading compares the arms shown</span>
      </div>
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-left text-[9.5px] uppercase tracking-wide text-gray-400">
            <th className="px-3 py-2 cursor-pointer whitespace-nowrap sticky left-0 bg-white dark:bg-gray-800"
              onClick={() => clickSort('pitcher')}>
              Pitcher{sortK === 'pitcher' ? (sortD > 0 ? ' ▲' : ' ▼') : ''}
            </th>
            {PB_COLS.map(([label, k, tip]) => {
              const vals = cohort[k] || []
              const mean = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null
              return (
                <th key={k} onClick={() => clickSort(k)}
                  className={`px-1.5 py-2 text-right cursor-pointer select-none whitespace-nowrap ${
                    sortK === k ? 'text-portal-purple dark:text-indigo-300' : ''}`}>
                  <StatTip k={PB_TIP_KEY[k] || k} group="pitching" label={label} fallback={tip}
                    avg={mean} n={vals.length} />
                  {sortK === k ? (sortD > 0 ? ' ▲' : ' ▼') : ''}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
          {rows.map(b => (
            <tr key={`${b.pitcher}-${b.team}`} className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
              <td className="px-3 py-1.5 font-semibold whitespace-nowrap sticky left-0 bg-white dark:bg-gray-800 cursor-pointer"
                onClick={() => onOpenLab?.(b.pitcher)}>
                {b.pitcher}
                <span className="ml-1.5 text-[10px] font-bold text-gray-400">{b.throws === 'Left' ? 'L' : b.throws === 'Right' ? 'R' : ''}</span>
              </td>
              {PB_COLS.map(([, k, , opts = {}]) => {
                if (opts.plain) return (
                  <td key={k} className="px-1.5 py-1.5 text-right tabular-nums text-gray-500">
                    {b[k] == null ? '–' : opts.str ? b[k] : Number(b[k]).toFixed(opts.dec ?? 1)}
                  </td>
                )
                if (opts.dec === 3) return (
                  <td key={k} className="px-1.5 py-1.5 text-right tabular-nums">
                    {b[k] == null ? '–' : Number(b[k]).toFixed(3).replace(/^0/, '')}
                  </td>
                )
                return <HeatCell key={k} v={b[k]} vals={cohort[k]}
                  higher={opts.higher !== false} dec={opts.dec ?? 1} plus={!!opts.plus} />
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const HITTER_LINE = [
  ['PA', 'pa'], ['AB', 'ab'], ['H', 'h'], ['2B', 'd2'], ['3B', 'd3'], ['HR', 'hr'], ['BB', 'bb'], ['K', 'k'], ['HBP', 'hbp'],
  ['AVG', 'avg'], ['OBP', 'obp'], ['SLG', 'slg'], ['OPS', 'ops'], ['ISO', 'iso'], ['BABIP', 'babip'], ['wOBA', 'woba'], ['wRC+', 'wrc_plus'],
]
function HitterLineCard({ line }) {
  if (!line) return null
  const fmtV = (k, v) => v == null ? '–' : (['avg', 'obp', 'slg', 'ops', 'iso', 'babip', 'woba'].includes(k) ? v.toFixed(3).replace(/^0/, '') : v)
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Box line (this view's filters applied)</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {HITTER_LINE.map(([label, k]) => (
          <span key={k} className="text-[13px] tabular-nums">
            <span className="text-[10px] uppercase tracking-wide text-gray-400 mr-1"><StatTip k={k} group="hitting" label={label} /></span>
            <span className="font-semibold text-gray-800 dark:text-gray-100">{fmtV(k, line[k])}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
const HB_BP = [
  ['Pitches', 'pitches', 'Machine pitches thrown', { plain: true, dec: 0 }],
  ['InPlay/P', 'contact_per_pitch', 'Balls put in play per machine pitch. NOT contact%: BP files tag every pitch Undefined (no swing or take calls), so swings are unknowable and contact per swing cannot be computed', {}],
  ['BBE', 'bbe', null, { plain: true, dec: 0 }],
  ['Avg EV', 'avg_ev', null, {}],
  ['90th EV', 'p90_ev', '90th percentile exit velo', {}],
  ['Max EV', 'max_ev', null, {}],
  ['Avg LA', 'avg_la', null, { plain: true }],
  ['HH%', 'hh_pct', 'Hard-hit: 90+ mph', {}],
  ['Brl%', 'barrel_pct', '95+ mph in the 8-32 degree window', {}],
  ['GB%', 'gb_pct', null, { higher: false }],
  ['LD%', 'ld_pct', null, {}],
  ['FB%', 'fb_pct', null, { plain: true }],
  ['AirPull%', 'airpull_pct', 'Pulled share of air balls', {}],
  ['Depth', 'depth', 'Avg contact depth; green = the 1.3-2.7 ft damage window', { kind: 'depth', dec: 2 }],
  ['O-Ct%', 'oz_contact_pct', 'Share of batted balls that came on pitches OUT of the zone. A floor on chasing, not true chase% (BP has no swing calls, so takes and whiffs are invisible)', { higher: false }],
  ['Max dist', 'max_dist', null, { dec: 0 }],
  ...HB_EV_ZONES.map(([l, k]) => [l, k, 'Avg EV on heart+shadow pitches in this part of the zone (min 3 BBE)', {}]),
]

function HittingTab({ teamCtx, season }) {
  const exportRef = useRef(null)
  const [context, setContext] = useState('live')
  const [vsThrows, setVsThrows] = useState('')
  const [ptype, setPtype] = useState('')
  const [dates, setDates] = useState({})
  const [team, setTeam] = useState(teamCtx.primary)
  const [sortK, setSortK] = useState('avg_ev')
  const [sortD, setSortD] = useState(-1)
  const [sel, setSel] = useState(null)
  const { data, loading } = useApi('/trackman/hitting-board',
    { context, team: team || undefined, throws: vsThrows || undefined,
      pitch_type: ptype || undefined, season,
      date_from: dates.from, date_to: dates.to },
    [context, team, vsThrows, ptype, dates.from, dates.to])

  const isBp = context === 'bp'
  const COLSET = isBp ? HB_BP : HB_FULL
  const batters = useMemo(() => {
    const rows = (data?.batters || []).map(b => ({
      ...b,
      zev_up: b.zone_ev?.up ?? null, zev_down: b.zone_ev?.down ?? null,
      zev_in: b.zone_ev?.in ?? null, zev_out: b.zone_ev?.out ?? null,
      zev_mid: b.zone_ev?.mid ?? null,
      zrv_up: b.zone_rv?.up ?? null, zrv_down: b.zone_rv?.down ?? null,
      zrv_in: b.zone_rv?.in ?? null, zrv_out: b.zone_rv?.out ?? null,
    }))
    rows.sort((a, b2) => {
      let x = a[sortK] ?? -1e9, y = b2[sortK] ?? -1e9
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sortD
    })
    return rows
  }, [data, sortK, sortD])
  const clickSort = (k) => {
    if (sortK === k) setSortD(d => -d)
    else { setSortK(k); setSortD(k === 'batter' ? 1 : -1) }
  }
  const cohort = useMemo(() => {
    const m = {}
    COLSET.forEach(([, k]) => { m[k] = batters.map(b => b[k]).filter(v => v != null).map(Number) })
    return m
  }, [batters, COLSET])
  const selRow = batters.find(b => b.batter === sel) || batters[0] || null

  const leader = (k, fmt2) => {
    const best = batters.filter(b => b[k] != null).sort((a, b2) => b2[k] - a[k])[0]
    return best ? [best.batter, fmt2(best[k])] : null
  }
  const cards = isBp ? [
    ['Hardest hit', leader('max_ev', v => `${v} mph`)],
    ['Best 90th pct EV', leader('p90_ev', v => `${v} mph`)],
    ['Longest ball', leader('max_dist', v => `${v} ft`)],
    ['Best barrel%', leader('barrel_pct', v => `${v}%`)],
  ] : [
    ['Best run value', leader('rv', v => `${v > 0 ? '+' : ''}${v} runs`)],
    ['Best xwOBA', leader('xwoba', v => v?.toFixed(3))],
    ['Best 90th pct EV', leader('p90_ev', v => `${v} mph`)],
    ['Best barrel%', leader('barrel_pct', v => `${v}%`)],
  ]

  return (
    <div className="space-y-3" ref={exportRef}>
      <div className="flex items-center gap-2 flex-wrap">
        {HB_CONTEXTS.map(([k, label]) => (
          <button key={k} onClick={() => setContext(k)}
            className={`px-2.5 py-1 rounded-full text-[12px] font-semibold ${
              context === k ? 'bg-portal-purple text-white'
                : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
            {label}
          </button>
        ))}
        <div className="w-px h-5 bg-gray-200 dark:bg-gray-700" />
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
        <DateRange value={dates} onChange={setDates} />
        <div className="ml-auto flex items-center gap-2">
          <ReportActions csv targetRef={exportRef} filename={`hitting_${context}_${dates.from || 'all'}`} />
          <TeamSelect teamCtx={teamCtx} value={team} onChange={setTeam} />
        </div>
      </div>

      {isBp && data?.sessions?.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.sessions.map(s => (
            <button key={s.id} onClick={() => setDates({ from: s.date, to: s.date })}
              title="Click to focus this BP day"
              className={`text-[11px] rounded-full px-2.5 py-1 ring-1 tabular-nums ${
                dates.from === s.date && dates.to === s.date
                  ? 'bg-portal-purple text-white ring-portal-purple'
                  : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-gray-200 dark:ring-gray-700'}`}>
              {s.date} · {s.bbe} BBE
            </button>
          ))}
          {(dates.from || dates.to) && (
            <button onClick={() => setDates({})}
              className="text-[11px] rounded-full px-2.5 py-1 text-rose-500 ring-1 ring-rose-200 dark:ring-rose-800">
              Clear ×
            </button>
          )}
        </div>
      )}

      {loading ? <div className="p-8 text-center text-sm text-gray-400">Loading…</div> :
       !batters.length ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-10 text-center text-sm text-gray-400">
          No {isBp ? 'BP' : 'tracked'} sessions match these filters.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {cards.map(([label, v]) => (
              <div key={label} className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 px-3 py-2.5">
                <div className="text-[9px] font-bold uppercase tracking-wider text-gray-400">{label}</div>
                {v ? (
                  <>
                    <div className="text-[14px] font-bold text-portal-purple dark:text-portal-accent-light truncate">{v[0]}</div>
                    <div className="text-[12px] tabular-nums text-gray-500">{v[1]}</div>
                  </>
                ) : <div className="text-sm text-gray-400">—</div>}
              </div>
            ))}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
            <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
                Hitting board — {HB_CONTEXTS.find(c => c[0] === context)?.[1]}
                {data ? ` · ${data.totals.days} session${data.totals.days === 1 ? '' : 's'} · ${data.totals.bbe} BBE` : ''}
              </span>
              <span className="text-[10px] text-gray-400">click a column to sort · click a hitter for spray + launch detail · shading compares the hitters shown</span>
            </div>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-[9.5px] uppercase tracking-wide text-gray-400">
                  <th className="px-3 py-2 cursor-pointer whitespace-nowrap sticky left-0 bg-white dark:bg-gray-800"
                    onClick={() => clickSort('batter')}>
                    Batter{sortK === 'batter' ? (sortD > 0 ? ' ▲' : ' ▼') : ''}
                  </th>
                  {COLSET.map(([label, k, tip]) => {
                    const vals = cohort[k] || []
                    const mean = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null
                    return (
                      <th key={k} onClick={() => clickSort(k)}
                        className={`px-1.5 py-2 text-right cursor-pointer select-none whitespace-nowrap ${
                          sortK === k ? 'text-portal-purple dark:text-indigo-300' : ''}`}>
                        <StatTip k={k} group="hitting" label={label} fallback={tip}
                          avg={mean} n={vals.length} />
                        {sortK === k ? (sortD > 0 ? ' ▲' : ' ▼') : ''}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {batters.map(b => (
                  <tr key={b.batter + b.team} onClick={() => setSel(b.batter)}
                    className={`cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 ${selRow?.batter === b.batter ? 'bg-teal-50/60 dark:bg-teal-900/20' : ''}`}>
                    <td className="px-3 py-1.5 font-semibold whitespace-nowrap text-gray-900 dark:text-gray-100 sticky left-0 bg-white dark:bg-gray-800">
                      {b.batter}<span className="ml-1 text-[10px] font-normal text-gray-400">{b.side}</span>
                    </td>
                    {COLSET.map(([, k, , opts = {}]) => {
                      if (opts.kind === 'depth') return (
                        <td key={k} className={`px-1.5 py-1.5 text-right tabular-nums ${DEPTH_CLS[depthTone(b[k])] || ''}`}
                          {...toneAttr(depthTone(b[k]) === 'good' ? 80 : depthTone(b[k]) === 'bad' ? 20 : depthTone(b[k]) === 'mid' ? 50 : null)}>
                          {b[k] != null ? b[k].toFixed(2) : '–'}
                        </td>
                      )
                      if (opts.plain) return (
                        <td key={k} className="px-1.5 py-1.5 text-right tabular-nums text-gray-500">
                          {b[k] != null ? Number(b[k]).toFixed(opts.dec ?? 1) : '–'}
                        </td>
                      )
                      return <HeatCell key={k} v={b[k]} vals={cohort[k]}
                        higher={opts.higher !== false} dec={opts.dec ?? 1} plus={!!opts.plus} />
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selRow && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Hitter detail</span>
                <select value={selRow.batter} onChange={e => setSel(e.target.value)}
                  className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-sm font-semibold">
                  {batters.map(b => (
                    <option key={b.batter + b.team} value={b.batter}>{b.batter} · {b.bbe} BBE</option>
                  ))}
                </select>
                <span className="text-[11px] text-gray-400">or click any row · full breakdowns live in the Hitter Lab</span>
              </div>
              <div className="grid md:grid-cols-2 gap-3">
                <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">
                    {selRow.batter} — spray (colored by EV)
                  </div>
                  <SprayChart pitches={selRow.points} />
                </div>
                <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">
                    {selRow.batter} — exit velo vs launch angle
                  </div>
                  <EvLaScatter points={selRow.points} />
                </div>
              </div>
            </>
          )}

          <VeloBandBoard rows={batters} isBp={isBp} />

          <p className="text-[10.5px] text-gray-400 leading-snug max-w-3xl">
            {isBp
              ? 'BP files carry hitting metrics only: TrackMan tags every BP pitch Undefined, so swings, takes, whiffs, chase% and contact% cannot be measured. InPlay/P counts balls put in play per machine pitch, and O-Ct% is the share of batted balls that came on out-of-zone pitches (a floor on chasing). '
              : 'Decisions (swing, contact, chase, RV) come from called pitches; expected stats rebuild each plate appearance from the pitch sequence. '}
            Zone columns use heart and shadow pitches only, split up/down/in/out relative to the batter
            (RV zones for live contexts price swings AND takes there; the middle is covered by Heart RV;
            BP shows avg EV per zone instead since BP has no pitch calls). Every number shows at any
            sample size, so read the Pitches and BBE columns alongside them: a rate off three swings is
            real arithmetic but not yet a real trend. Save PDF exports this whole view.
          </p>
        </>
      )}
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

// Convex hull (monotone chain) of [x, y] screen points — the shaded
// outline drawn around each pitch type's movement cluster.
function hullOf(pts) {
  const P = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (P.length < 3) return null
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const q of P) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper = []
  for (let i = P.length - 1; i >= 0; i--) {
    const q = P[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
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
      {Object.entries(byType).map(([t, ps]) => {
        const pts = ps.map(q => [sx(Math.max(-R, Math.min(R, q.horz_break))), sy(Math.max(-R, Math.min(R, q.ivb)))])
        const hull = hullOf(pts)
        if (!hull) return null
        const cx = pts.reduce((a, q) => a + q[0], 0) / pts.length
        const cy = pts.reduce((a, q) => a + q[1], 0) / pts.length
        const padded = hull.map(([x, y]) => {
          const dx = x - cx, dy = y - cy
          const d = Math.hypot(dx, dy) || 1
          return `${x + (dx / d) * 7},${y + (dy / d) * 7}`
        }).join(' ')
        return <polygon key={'hull' + t} points={padded} fill={cFor(t)} opacity="0.12"
          stroke={cFor(t)} strokeOpacity="0.55" strokeWidth="1.5" strokeLinejoin="round" />
      })}
      {Object.entries(byType).map(([t, ps]) => ps.map((p, i) => (
        <circle key={t + i} cx={sx(Math.max(-R, Math.min(R, p.horz_break)))} cy={sy(Math.max(-R, Math.min(R, p.ivb)))}
          r={p.pitch_id === selectedId ? 5 : 3} fill={cFor(t)}
          opacity={p.pitch_id === selectedId ? 1 : 0.35}
          stroke={p.pitch_id === selectedId ? '#111' : (p.override_pitch_type ? '#111' : 'none')}
          strokeWidth={p.pitch_id === selectedId ? 1.5 : 0.8}
          style={onPick ? { cursor: 'pointer' } : undefined}
          onClick={onPick ? () => onPick(p) : undefined} />
      )))}
      <text x={W - 10} y={sy(0) - 6} textAnchor="end" fontSize="9" fill="#9ca3af">HB (in) →</text>
      <text x={sx(0) + 6} y="16" fontSize="9" fill="#9ca3af">IVB (in) ↑</text>
    </svg>
  )
}

// Release point, catcher's view.
function ReleasePlot({ pitches, zoom = false }) {
  const W = 300, H = 300
  const pts = pitches.filter(p => p.rel_side != null && p.rel_height != null)
  // zoom: a square window fit to THIS pitcher's release cluster (min 1.5 ft
  // across) instead of the fixed 10 x 8 ft frame, where a tight release is a
  // single smudge. Half-foot gridlines keep the scale readable.
  if (zoom && pts.length) {
    const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)] }
    const cx = med(pts.map(p => p.rel_side)), cy = med(pts.map(p => p.rel_height))
    // ignore the wildest 5% when sizing the window so one mistag cannot shrink everything
    const dev = pts.map(p => Math.max(Math.abs(p.rel_side - cx), Math.abs(p.rel_height - cy))).sort((a, b) => a - b)
    const half = Math.max(0.75, Math.ceil((dev[Math.floor(0.95 * (dev.length - 1))] + 0.2) * 4) / 4)
    const zx = (v) => 26 + ((v - (cx - half)) / (2 * half)) * (W - 36)
    const zy = (v) => (H - 22) - ((v - (cy - half)) / (2 * half)) * (H - 32)
    const ticks = (c) => { const out = []; for (let t = Math.ceil((c - half) * 2) / 2; t <= c + half + 1e-9; t += 0.5) out.push(Math.round(t * 2) / 2); return out }
    const byType = {}
    pts.forEach(p => { (byType[p.ptype] = byType[p.ptype] || []).push(p) })
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {ticks(cy).map(v => (
          <g key={`h${v}`}>
            <line x1="26" y1={zy(v)} x2={W - 10} y2={zy(v)} stroke="#e5e7eb" strokeWidth={Number.isInteger(v) ? 1.2 : 0.6} />
            <text x="22" y={zy(v) + 3.5} fontSize="10" fill="#9ca3af" textAnchor="end">{v.toFixed(1)}</text>
          </g>
        ))}
        {ticks(cx).map(v => (
          <g key={`v${v}`}>
            <line x1={zx(v)} y1="10" x2={zx(v)} y2={H - 22} stroke="#e5e7eb" strokeWidth={Number.isInteger(v) ? 1.2 : 0.6} />
            <text x={zx(v)} y={H - 9} fontSize="10" fill="#9ca3af" textAnchor="middle">{v.toFixed(1)}</text>
          </g>
        ))}
        {pts.map((p, i) => (
          <circle key={i} cx={Math.max(26, Math.min(W - 10, zx(p.rel_side)))} cy={Math.max(10, Math.min(H - 22, zy(p.rel_height)))}
            r="4.5" fill={cFor(p.ptype)} opacity="0.45" />
        ))}
        {Object.entries(byType).filter(([, ps]) => ps.length >= 2).map(([t, ps]) => {
          const mx = ps.reduce((a, p) => a + p.rel_side, 0) / ps.length, my = ps.reduce((a, p) => a + p.rel_height, 0) / ps.length
          return <circle key={t} cx={zx(mx)} cy={zy(my)} r="6.5" fill={cFor(t)} stroke="#111827" strokeWidth="1.4"><title>{t} average release</title></circle>
        })}
        <text x={W - 10} y="9" fontSize="9" fill="#9ca3af" textAnchor="end">feet · outlined dot = pitch average</text>
      </svg>
    )
  }
  const sx = (side) => W / 2 + (side / 5) * (W / 2 - 16)
  const sy = (h) => H - 20 - (h / 8) * (H - 40)
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
// Savant-style location heat: smoothed density, blue (rare) -> red (often).
function LocationHeatmap({ pitches, title }) {
  const XMIN = -1.7, XMAX = 1.7, YMIN = 0.8, YMAX = 4.2
  const NX = 14, NY = 14
  const W = 150, H = 150, cw = W / NX, ch = H / NY
  const zx = (v) => ((Math.max(XMIN, Math.min(XMAX, v)) - XMIN) / (XMAX - XMIN)) * W
  const zy = (v) => ((YMAX - Math.max(YMIN, Math.min(YMAX, v))) / (YMAX - YMIN)) * H
  const pts = pitches.filter(p => p.plate_loc_side != null && p.plate_loc_height != null)
  const grid = Array.from({ length: NY }, () => Array(NX).fill(0))
  pts.forEach(p => {
    const gx = Math.min(NX - 1, Math.max(0, Math.floor(((p.plate_loc_side - XMIN) / (XMAX - XMIN)) * NX)))
    const gy = Math.min(NY - 1, Math.max(0, Math.floor(((YMAX - p.plate_loc_height) / (YMAX - YMIN)) * NY)))
    // gaussian-ish splat: full weight in the cell, spill into neighbors
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = gx + dx, y = gy + dy
      if (x >= 0 && x < NX && y >= 0 && y < NY) grid[y][x] += (dx === 0 && dy === 0) ? 1 : 0.35
    }
  })
  const max = Math.max(0.01, ...grid.flat())
  const mix = (t) => {
    const c = (a, b) => Math.round(a + (b - a) * t)
    return `rgb(${c(54, 210)},${c(97, 45)},${c(173, 73)})`
  }
  return (
    <div>
      <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-300 mb-1 flex items-center gap-1.5">
        <span className="inline-block w-2 h-2 rounded-full" style={{ background: cFor(title) }} />
        {title} <span className="text-gray-400 font-normal">({pts.length})</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded bg-gray-50 dark:bg-gray-900/40">
        {grid.map((row, y) => row.map((v, x) => {
          if (!v) return null
          const t = v / max
          return <rect key={`${x}${y}`} x={x * cw} y={y * ch} width={cw + 0.5} height={ch + 0.5}
            fill={mix(t)} opacity={0.12 + 0.72 * t} />
        }))}
        <rect x={zx(-0.83)} y={zy(3.5)} width={zx(0.83) - zx(-0.83)} height={zy(1.5) - zy(3.5)}
          fill="none" stroke="currentColor" className="text-gray-700 dark:text-gray-200" strokeWidth="1.4" />
      </svg>
    </div>
  )
}

const COUNTS = [['0-0','0-1','0-2'],['1-0','1-1','1-2'],['2-0','2-1','2-2'],['3-0','3-1','3-2']]

// Attack-zone ring in JS (mirrors backend trackman_runvalue.attack_zone)
const zoneRing = (px, pz) => {
  if (px == null || pz == null) return null
  return Math.max(Math.abs(px) / 0.83, Math.abs(pz - 2.5))
}

function CountUsage({ pitches }) {
  const cells = useMemo(() => {
    const m = {}
    ;(pitches || []).forEach(p => {
      if (p.balls == null || p.strikes == null) return
      const c = `${p.balls}-${p.strikes}`
      const cell = (m[c] = m[c] || { total: 0, types: {}, zone_n: 0, zone_in: 0, loc_n: 0, shadow: 0 })
      cell.total += 1
      cell.types[p.ptype] = (cell.types[p.ptype] || 0) + 1
      if (p.is_in_zone === true) { cell.zone_n += 1; cell.zone_in += 1 }
      else if (p.is_in_zone === false) cell.zone_n += 1
      const r = zoneRing(p.plate_loc_side, p.plate_loc_height)
      if (r != null) { cell.loc_n += 1; if (r > 0.67 && r <= 1.33) cell.shadow += 1 }
    })
    return m
  }, [pitches])
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {COUNTS.flat().map(c => {
        const cell = cells[c]
        const top = cell ? Object.entries(cell.types).sort((a, b) => b[1] - a[1]).slice(0, 3) : []
        return (
          <div key={c} className="rounded-lg bg-gray-50 dark:bg-gray-900/40 p-2">
            <div className="text-[10px] font-bold text-gray-400 tabular-nums">{c} <span className="font-normal">· {cell?.total || 0} pitches</span></div>
            {top.map(([t, n]) => (
              <div key={t} className="flex items-center gap-1 mt-0.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cFor(t) }} />
                <span className="text-[10px] text-gray-600 dark:text-gray-300 truncate">{t}</span>
                <span className="ml-auto text-[10px] font-semibold tabular-nums">{Math.round(100 * n / cell.total)}%</span>
              </div>
            ))}
            {cell && cell.zone_n >= 5 && (
              <div className="mt-1 pt-1 border-t border-gray-200/70 dark:border-gray-700/70 flex justify-between text-[9.5px] tabular-nums">
                <span className="text-gray-500 dark:text-gray-400"
                  title="Share of these pitches inside the strike zone">
                  Zone <b>{Math.round(100 * cell.zone_in / cell.zone_n)}%</b>
                </span>
                <span className="text-gray-500 dark:text-gray-400"
                  title="Share landing in the shadow band around the zone edges">
                  Shdw <b>{cell.loc_n >= 5 ? Math.round(100 * cell.shadow / cell.loc_n) + '%' : '–'}</b>
                </span>
              </div>
            )}
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
  chase_pct: ['Chase%', '%', 1], csw_pct: ['CSW%', '%', 1], k_pct: ['K%', '%', 1], bb_pct: ['BB%', '%', 1],
  ev_against: ['EV against', ' mph', 1], hard_hit_against: ['Hard-hit% against', '%', 1],
}

function PlayerLabTab({ pitcher, setPitcher, teamCtx, season }) {
  const exportRef = useRef(null)
  const [context, setContext] = useState('live')
  const [dates, setDates] = useState({})
  const [picked, setPicked] = useState(null)  // pitch selected for re-tagging
  const [team, setTeam] = useState(teamCtx.primary)
  const [conf, setConf] = useState('all')
  const [vsSide, setVsSide] = useState('')
  // Bullpen-only arms never appear in the 'all' roster (it excludes pens),
  // so the dropdown must follow the selected context there.
  const { data: list } = useApi('/trackman/pitching', { context: context === 'bullpen' ? 'bullpen' : 'all', season })
  const roster = (list?.pitchers || []).filter(p => !team || p.team === team)
  const names = roster.map(p => p.pitcher)
  const active = names.includes(pitcher) ? pitcher : (names[0] || '')
  const { data, loading, error, refetch } = useApi(
    active ? '/trackman/pitchers/detail' : null,
    { pitcher: active, context, conf, team: team || undefined,
      side: vsSide || undefined, season,
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
        {data && <ReportActions csv targetRef={exportRef} filename={`trackman_${(active || 'pitcher').replace(/[^a-z]+/gi, '_').toLowerCase()}`} />}
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

          <ArsenalStatTable pitches={data.pitches} rvByType={data.rv_by_type} grades={data.grades} typeAvgs={data.type_avgs}
            slot={data.slot} pitcher={active} team={team || null} onRetag={refetch} />

          <CountResults pitches={data.pitches} mode="pitcher" />

          <div className="grid md:grid-cols-2 gap-3">
            <ArmProfileCard arm={data.arm} />
            <TunnelingCard tunneling={data.tunneling} />
          </div>

          <div className="grid md:grid-cols-3 gap-3">
            <div className="md:col-span-2 bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
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
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Pitch mix, zone and edge presence by count</div>
              <CountUsage pitches={data.pitches} />
            </div>
          </div>

          <PitcherZoneMaps pitches={data.pitches} />

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

          {data.line && (
            <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Box line (this view's filters applied; R not ER, TrackMan does not score earned runs)</div>
              <PitcherLineStrip line={data.line} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Leaderboards ─────────────────────────────────────────────────

function LeaderboardsTab({ teamCtx, season }) {
  const [side, setSide] = useState('pitching')
  const [context, setContext] = useState('live')
  const [team, setTeam] = useState(teamCtx.primary)
  const { data, loading } = useApi('/trackman/leaderboards', { side, context, team: team || undefined, season })
  const boards = data?.boards || {}

  function boardsCsv() {
    const esc = v => /[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '')
    const lines = []
    Object.values(boards).forEach(b => {
      lines.push(esc(b.label))
      lines.push('rank,name,team,value')
      ;(b.rows || []).forEach((r, i) => lines.push([i + 1, esc(r.name), esc(r.team), r.value].join(',')))
      lines.push('')
    })
    downloadCsvText(lines.join('\n'), `trackman_leaders_${side}_${context}`)
  }

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
        <div className="ml-auto flex items-center gap-2">
          <button onClick={boardsCsv}
            className="px-3 py-2 rounded-lg border border-nw-teal text-nw-teal text-sm font-semibold hover:bg-nw-teal/10">
            Save CSV
          </button>
          <TeamSelect teamCtx={teamCtx} value={team} onChange={setTeam} />
        </div>
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
  k_pct: ['K%', '%', 1], bb_pct: ['BB%', '%', 1],
}

// 5x5 zone map colored by a rate (swing% or contact%) per bin.
function ZoneRateMap({ pitches, num, den, title, sub }) {
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
      <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-300">{title}</div>
      {sub && <div className="text-[9px] text-gray-400 mb-1 leading-tight">{sub}</div>}
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

// 5x5 zone map colored by an average VALUE per bin (e.g. exit velo).
function ZoneValueMap({ pitches, value, title, sub, lo, hi, dec = 0, minN = 3 }) {
  const XMIN = -1.7, XMAX = 1.7, YMIN = 0.8, YMAX = 4.2, N = 5
  const sums = Array.from({ length: N }, () => Array(N).fill(0))
  const ns = Array.from({ length: N }, () => Array(N).fill(0))
  pitches.forEach(p => {
    const v = value(p)
    if (v == null || p.plate_loc_side == null || p.plate_loc_height == null) return
    const cx = Math.min(N - 1, Math.max(0, Math.floor(((p.plate_loc_side - XMIN) / (XMAX - XMIN)) * N)))
    const cy = Math.min(N - 1, Math.max(0, Math.floor(((YMAX - p.plate_loc_height) / (YMAX - YMIN)) * N)))
    sums[cy][cx] += v; ns[cy][cx] += 1
  })
  const W = 150, H = 150, cw = W / N, ch = H / N
  const zx = (v) => ((v - XMIN) / (XMAX - XMIN)) * W
  const zy = (v) => ((YMAX - v) / (YMAX - YMIN)) * H
  const mix = (t) => {  // blue #3661ad -> red #d22d49
    const c = (a, b) => Math.round(a + (b - a) * t)
    return `rgb(${c(54, 210)},${c(97, 45)},${c(173, 73)})`
  }
  return (
    <div>
      <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-300">{title}</div>
      {sub && <div className="text-[9px] text-gray-400 mb-1 leading-tight">{sub}</div>}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded">
        {ns.map((row, y) => row.map((n, x) => {
          if (n < minN) return <rect key={`${x}${y}`} x={x * cw} y={y * ch} width={cw} height={ch} fill="currentColor" className="text-gray-100 dark:text-gray-700" opacity="0.4" />
          const avg = sums[y][x] / n
          const t = Math.max(0, Math.min(1, (avg - lo) / (hi - lo)))
          return (
            <g key={`${x}${y}`}>
              <rect x={x * cw} y={y * ch} width={cw} height={ch} fill={mix(t)} opacity={0.25 + 0.6 * Math.abs(t - 0.5) * 2} />
              <text x={x * cw + cw / 2} y={y * ch + ch / 2 + 3} textAnchor="middle" fontSize="9"
                fill="#fff" fontWeight="700">{avg.toFixed(dec)}</text>
            </g>
          )
        }))}
        <rect x={zx(-0.83)} y={zy(3.5)} width={zx(0.83) - zx(-0.83)} height={zy(1.5) - zy(3.5)}
          fill="none" stroke="currentColor" className="text-gray-600 dark:text-gray-200" strokeWidth="1.5" />
      </svg>
    </div>
  )
}

// 5x5 density map: where the pitches in this slice actually go.
function ZoneDensityMap({ pitches, title, sub }) {
  const XMIN = -1.7, XMAX = 1.7, YMIN = 0.8, YMAX = 4.2, N = 5
  const ns = Array.from({ length: N }, () => Array(N).fill(0))
  let total = 0
  pitches.forEach(p => {
    if (p.plate_loc_side == null || p.plate_loc_height == null) return
    const cx = Math.min(N - 1, Math.max(0, Math.floor(((p.plate_loc_side - XMIN) / (XMAX - XMIN)) * N)))
    const cy = Math.min(N - 1, Math.max(0, Math.floor(((YMAX - p.plate_loc_height) / (YMAX - YMIN)) * N)))
    ns[cy][cx] += 1; total += 1
  })
  const max = Math.max(1, ...ns.flat())
  const W = 150, H = 150, cw = W / N, ch = H / N
  const zx = (v) => ((v - XMIN) / (XMAX - XMIN)) * W
  const zy = (v) => ((YMAX - v) / (YMAX - YMIN)) * H
  return (
    <div>
      <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-300">{title} <span className="text-gray-400 font-normal">({total})</span></div>
      {sub && <div className="text-[9px] text-gray-400 mb-1 leading-tight">{sub}</div>}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded">
        {ns.map((row, y) => row.map((n, x) => (
          <g key={`${x}${y}`}>
            <rect x={x * cw} y={y * ch} width={cw} height={ch} fill="#7c3aed" opacity={n ? 0.08 + 0.72 * (n / max) : 0} />
            {n > 0 && total >= 20 && (
              <text x={x * cw + cw / 2} y={y * ch + ch / 2 + 3} textAnchor="middle" fontSize="8.5"
                fill={n / max > 0.45 ? '#fff' : '#7c3aed'} fontWeight="700">{Math.round(100 * n / total)}</text>
            )}
          </g>
        )))}
        <rect x={zx(-0.83)} y={zy(3.5)} width={zx(0.83) - zx(-0.83)} height={zy(1.5) - zy(3.5)}
          fill="none" stroke="currentColor" className="text-gray-600 dark:text-gray-200" strokeWidth="1.5" />
      </svg>
    </div>
  )
}

// Pitcher Lab: results + intent by plate location, with a local pitch-type
// lens. All computed from the lab's fetched pitches (filters apply).
function PitcherZoneMaps({ pitches }) {
  const [sel, setSel] = useState('')
  const types = useMemo(() => {
    const c = {}
    pitches.forEach(p => { if (p.ptype) c[p.ptype] = (c[p.ptype] || 0) + 1 })
    return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([t]) => t)
  }, [pitches])
  const ps = sel ? pitches.filter(p => p.ptype === sel) : pitches
  const called = ps.filter(p => p.pitch_call)
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Development maps — results and intent by location</span>
        <div className="flex gap-1 flex-wrap">
          {['', ...types].map(t => (
            <button key={t || 'all'} onClick={() => setSel(t)}
              className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ring-1 ${
                sel === t ? 'bg-portal-purple text-white ring-portal-purple'
                  : 'bg-white dark:bg-gray-800 text-gray-500 ring-gray-200 dark:ring-gray-700'}`}>
              {t || 'All pitches'}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <ZoneRateMap pitches={called} title="Whiffs" sub="% of swings missed, per cell"
          den={(p) => p.is_swing} num={(p) => p.is_whiff} />
        <ZoneRateMap pitches={called} title="Strikes earned" sub="called + swinging strike %, per cell"
          den={() => true} num={(p) => p.pitch_call === 'StrikeCalled' || p.pitch_call === 'StrikeSwinging'} />
        <ZoneValueMap pitches={ps} title="Damage taken" sub="avg exit velo (mph) allowed, per cell" lo={72} hi={95}
          value={(p) => p.exit_speed} />
        <ZoneDensityMap pitches={called.filter(p => p.balls === 0 && p.strikes === 0)}
          title="Where he starts ABs" sub="% of 0-0 pitches thrown to each cell" />
        <ZoneDensityMap pitches={called.filter(p => p.balls > p.strikes)}
          title="Where he goes behind" sub="% of behind-in-count pitches, per cell" />
        <ZoneDensityMap pitches={called.filter(p => p.strikes === 2)}
          title="Where he finishes" sub="% of two-strike pitches, per cell" />
      </div>
      <p className="text-[10px] text-gray-400 mt-2">
        How to read: the number in a cell is that cell's stat (a 40 on the Whiffs map = 40% of swings
        there missed; an 86 on Damage = 86 mph average exit velo allowed there; a 12 on the count maps =
        12% of those pitches went there). Gray cells have fewer than 3 pitches. Red = more of the thing,
        blue = less. Use the pitch chips to isolate one offering — a slider whose whiffs live below the
        zone but whose two-strike map sits belt-high is a location fix, not a stuff problem.
      </p>
    </div>
  )
}

// Spray chart from Bearing (deg from CF, +=right) + Distance.
// ── Batted-ball hover card (spray + contact-point dots) ──────────
// One card for every dot in the Hitter Lab: what the ball did (result, EV,
// launch, distance, spray, contact depth) and what it was hit off (pitch
// type, velo, spin, movement, count, pitcher, location with a mini zone).
function fmtLoc(p) {
  if (p.plate_loc_side == null || p.plate_loc_height == null) return null
  const h = p.plate_loc_height, sd = p.plate_loc_side
  const vert = h > 3.1 ? 'up' : h < 1.9 ? 'down' : 'middle'
  const hand = (p.batter_side || '')[0]
  const rel = hand === 'R' ? sd : hand === 'L' ? -sd : sd
  const horiz = Math.abs(rel) < 0.28 ? 'middle' : rel > 0 ? 'in' : 'away'
  const inZone = Math.abs(sd) <= 0.83 && h >= 1.5 && h <= 3.5
  return `${vert === horiz ? 'middle-middle' : `${vert} and ${horiz}`}${inZone ? '' : ' (out of zone)'}`
}
function MiniZone({ p }) {
  if (p.plate_loc_side == null || p.plate_loc_height == null) return null
  // catcher's view, 3 ft wide x 3 ft tall window centered on the zone
  const W = 42, H = 42, x = (sd) => W / 2 + sd * (W / 3), y = (h) => H - (h - 1.0) * (H / 3)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-10 h-10 shrink-0">
      <rect x={x(-0.83)} y={y(3.5)} width={x(0.83) - x(-0.83)} height={y(1.5) - y(3.5)} fill="none" stroke="#9ca3af" strokeWidth="1" />
      <circle cx={Math.max(2, Math.min(W - 2, x(p.plate_loc_side)))} cy={Math.max(2, Math.min(H - 2, y(p.plate_loc_height)))} r="3" fill="#d22d49" />
    </svg>
  )
}
function PitchHoverCard({ hover }) {
  if (!hover) return null
  const { p, x, y } = hover
  const result = p.play_result || (p.k_or_bb) || (p.pitch_call === 'InPlay' ? 'In play' : p.pitch_call) || '–'
  const pullSide = (() => {
    if (p.direction == null) return null
    const hand = (p.batter_side || '')[0]
    const d = hand === 'L' ? -p.direction : p.direction
    return d <= -10 ? 'pulled' : d >= 10 ? 'oppo' : 'center'
  })()
  const f1 = (v, d = 1) => v == null ? '–' : Number(v).toFixed(d)
  const rows = [
    ['EV', p.exit_speed != null ? `${f1(p.exit_speed)} mph` : '–'],
    ['Launch', p.launch_angle != null ? `${f1(p.launch_angle)}°${p.tagged_hit_type ? ` · ${p.tagged_hit_type}` : ''}` : '–'],
    ['Distance', p.distance != null ? `${Math.round(p.distance)} ft${pullSide ? ` · ${pullSide}` : ''}` : (pullSide || '–')],
    ['Contact', p.contact_x != null ? `${f1(p.contact_x, 2)} ft out front${p.contact_y != null ? `, ${f1(p.contact_y, 1)} ft high` : ''}` : '–'],
  ]
  const pitchRows = [
    ['Pitch', `${p.session_type === 'bp' ? 'BP' : (p.ptype || '?')}${p.rel_speed != null ? ` · ${f1(p.rel_speed)} mph` : ''}${p.effective_velo != null && p.rel_speed == null ? ` · ${f1(p.effective_velo)} eff` : ''}`],
    ['Shape', (p.ivb != null || p.horz_break != null) ? `${f1(p.ivb)}" IVB · ${f1(p.horz_break)}" HB${p.spin_rate != null ? ` · ${Math.round(p.spin_rate)} rpm` : ''}` : '–'],
    ['Count', p.balls != null && p.strikes != null ? `${p.balls}-${p.strikes}` : '–'],
    ['From', p.pitcher ? `${p.pitcher}${p.pitcher_throws ? ` (${p.pitcher_throws === 'Left' ? 'LHP' : 'RHP'})` : ''}` : (p.pitcher_throws ? (p.pitcher_throws === 'Left' ? 'LHP' : 'RHP') : '–')],
    ['Location', fmtLoc(p) || '–'],
  ]
  return (
    <div className="pointer-events-none absolute z-40 w-64 rounded-lg bg-gray-900 text-gray-100 shadow-xl ring-1 ring-black/20 p-2.5 text-[11px] leading-snug"
      style={{ left: x + 14, top: y + 14 }}>
      <div className="flex items-center justify-between mb-1">
        <span className="font-bold text-[12px]">{result}</span>
        <span className="text-gray-400">{p.session_date || ''}</span>
      </div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-2"><span className="w-16 text-gray-400 shrink-0">{k}</span><span className="tabular-nums">{v}</span></div>
      ))}
      <div className="mt-1.5 pt-1.5 border-t border-gray-700 flex gap-2">
        <div className="flex-1">
          {pitchRows.map(([k, v]) => (
            <div key={k} className="flex gap-2"><span className="w-16 text-gray-400 shrink-0">{k}</span><span className="tabular-nums">{v}</span></div>
          ))}
        </div>
        <MiniZone p={p} />
      </div>
    </div>
  )
}
// Hover state + handlers for a dot chart: pass the wrapper ref so the card
// lands next to the cursor inside a position:relative container.
function useDotHover() {
  const wrapRef = useRef(null)
  const [hover, setHover] = useState(null)
  const onMove = (p) => (e) => {
    const r = wrapRef.current?.getBoundingClientRect()
    if (!r) return
    setHover({ p, x: e.clientX - r.left, y: e.clientY - r.top })
  }
  const onLeave = () => setHover(null)
  return { wrapRef, hover, onMove, onLeave }
}

function SprayChart({ pitches }) {
  const W = 300, H = 260, HOME_X = W / 2, HOME_Y = H - 18, MAXD = 420
  const pts = pitches.filter(p => p.bearing != null && p.distance != null && p.exit_speed != null)
  const px = (b, d) => HOME_X + (d / MAXD) * (H - 40) * Math.sin(b * Math.PI / 180)
  const py = (b, d) => HOME_Y - (d / MAXD) * (H - 40) * Math.cos(b * Math.PI / 180)
  const evColor = (ev) => ev >= 95 ? '#d22d49' : ev >= 85 ? '#f59e0b' : '#3661ad'
  const { wrapRef, hover, onMove, onLeave } = useDotHover()
  return (
    <div ref={wrapRef} className="relative">
    <PitchHoverCard hover={hover} />
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
          r={hover?.p === p ? 5 : 3.5} fill={evColor(p.exit_speed)} opacity={hover?.p === p ? 1 : 0.65}
          className="cursor-pointer" onMouseMove={onMove(p)} onMouseLeave={onLeave} />
      ))}
      <text x="10" y={H - 6} fontSize="8" fill="#9ca3af">EV: <tspan fill="#3661ad">&lt;85</tspan> <tspan fill="#f59e0b">85-95</tspan> <tspan fill="#d22d49">95+</tspan> · hover a dot</text>
    </svg>
    </div>
  )
}

function HitterLabTab({ teamCtx, season }) {
  const exportRef = useRef(null)
  const [dates, setDates] = useState({})
  const [team, setTeam] = useState(teamCtx.primary)
  const [batter, setBatter] = useState('')
  const [context, setContext] = useState('all')
  const [conf, setConf] = useState('all')
  const [vsThrows, setVsThrows] = useState('')
  const { data: list } = useApi('/trackman/hitting', { season })
  const roster = (list?.batters || []).filter(b => !team || b.team === team)
  const names = roster.map(b => b.batter)
  const active = names.includes(batter) ? batter : (names[0] || '')
  const { data, loading, error } = useApi(
    active ? '/trackman/batters/detail' : null,
    { batter: active, context, conf, team: team || undefined,
      throws: vsThrows || undefined, season,
      date_from: dates.from, date_to: dates.to })

  const pct = data?.percentiles || {}
  const pctKeys = Object.keys(HITTER_PCTL_LABELS).filter(k => pct[k])
  const pitches = data?.pitches || []
  const bbe = pitches.filter(p => p.exit_speed != null)
  // The same numbers the Hitting tab table shows, for THIS hitter, live only
  // (BP context has no decisions or results), under the lab's filters.
  const { data: board } = useApi(active && context !== 'bp' ? '/trackman/hitting-board' : null,
    { context: 'live', team: team || undefined, throws: vsThrows || undefined, season,
      date_from: dates.from, date_to: dates.to })
  const boardRow = useMemo(() => (board?.batters || []).find(b => b.batter === active) || null, [board, active])
  const boardCohort = useMemo(() => {
    const m = {}
    HB_FULL.forEach(([, k]) => { m[k] = (board?.batters || []).map(b => b[k]).filter(v => v != null).map(Number) })
    return m
  }, [board])

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
        {data && <ReportActions csv targetRef={exportRef} filename={`trackman_${(active || 'batter').replace(/[^a-z]+/gi, '_').toLowerCase()}`} />}
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

          {boardRow && <LiveBoardLine row={boardRow} cohort={boardCohort} pool={(board?.batters || []).length} />}

          {data.pt_results && <ResultsByPitchCard results={data.pt_results} />}

          {data.splits && <SplitsCard splits={data.splits} />}

          {data.velo && <VeloBandCard velo={data.velo} title={`${active} — against effective velocity`} />}

          <div className="grid md:grid-cols-2 gap-3">
            {data.swing_take && <SwingTakeCard st={data.swing_take} />}
            <SessionTrendCard trend={data.trend}
              metrics={[['xwobacon', 'xwOBAcon', 3], ['avg_ev', 'Avg EV', 1], ['hard_hit_pct', 'Hard-hit%', 1]]}
              title="Session trend — contact quality over time" />
          </div>

          <CountResults pitches={pitches} mode="hitter" />

          <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">
              Development maps — decisions and damage by location (min 3 per cell)
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <ZoneRateMap pitches={pitches} title="Swings" sub="% of pitches he offers at, per cell"
                den={(p) => p.pitch_call} num={(p) => p.is_swing} />
              <ZoneRateMap pitches={pitches} title="Whiffs" sub="% of his swings that miss, per cell"
                den={(p) => p.is_swing} num={(p) => p.is_whiff} />
              <ZoneValueMap pitches={pitches} title="Damage" sub="avg exit velo (mph) on contact, per cell" lo={72} hi={95}
                value={(p) => p.exit_speed} />
              <ZoneRateMap pitches={pitches} title="Hard contact" sub="% of batted balls 90+ mph, per cell"
                den={(p) => p.exit_speed != null} num={(p) => p.exit_speed >= 90} />
              <ZoneRateMap pitches={pitches} title="Called strikes on takes" sub="% of his takes called strikes, per cell"
                den={(p) => p.pitch_call && !p.is_swing} num={(p) => p.pitch_call === 'StrikeCalled'} />
            </div>
            <p className="text-[10px] text-gray-400 mt-2">
              How to read: the number in a cell is that cell's stat (a 44 on Swings = he offers at 44% of
              pitches there; an 88 on Damage = 88 mph average exit velo on contact there). Gray cells have
              fewer than 3 pitches. The first two maps are approach, the middle two are damage, the last is
              passivity — red cells INSIDE the box on "Called strikes on takes" are hittable pitches watched
              go by. The vs-hand chips and date range above re-cut every map.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Spray (colored by EV)</div>
              <SprayChart pitches={bbe} />
            </div>
            <ContactPointCard pitches={pitches} />
          </div>

          <HitterLineCard line={data.line} />
        </div>
      )}
    </div>
  )
}

// ── BP Review ────────────────────────────────────────────────────

// EV x LA scatter for a hitter's BP batted balls, sweet-spot band shaded.
function EvLaScatter({ points }) {
  const pts = (points || []).filter(p => p.ev != null && p.la != null)
  const W = 300, H = 210, L = 36, R = 10, T = 10, B = 26
  if (pts.length < 3) return <div className="text-xs text-gray-400 p-6 text-center">Not enough tracked contact.</div>
  const evLo = 55, evHi = Math.max(105, ...pts.map(p => p.ev)) + 2
  const laLo = -35, laHi = 55
  const X = v => L + (v - evLo) / (evHi - evLo) * (W - L - R)
  const Y = v => T + (laHi - v) / (laHi - laLo) * (H - T - B)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <rect x={L} y={Y(32)} width={W - L - R} height={Y(8) - Y(32)} fill="#059669" opacity="0.08" />
      <text x={W - R - 3} y={Y(32) + 9} fontSize="7.5" textAnchor="end" fill="#059669">sweet spot 8-32°</text>
      {[0, 20, 40].map(v => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="currentColor" className="text-gray-100 dark:text-gray-700" />
          <text x={L - 4} y={Y(v) + 3} fontSize="8" textAnchor="end" fill="#9ca3af">{v}°</text>
        </g>
      ))}
      {[70, 85, 100].map(v => (
        <text key={v} x={X(v)} y={H - 8} fontSize="8" textAnchor="middle" fill="#9ca3af">{v}</text>
      ))}
      <text x={(L + W - R) / 2} y={H - 0.5} fontSize="7.5" textAnchor="middle" fill="#9ca3af">exit velo (mph)</text>
      {pts.map((p, i) => (
        <circle key={i} cx={X(p.ev)} cy={Y(Math.max(laLo, Math.min(laHi, p.la)))} r="3.2"
          fill={p.ev >= 95 ? '#d22d49' : p.ev >= 85 ? '#f59e0b' : '#3661ad'} opacity="0.7" />
      ))}
    </svg>
  )
}

// ── Session Review ───────────────────────────────────────────────

// Plate-location dots (catcher's view) colored by pitch type, with the
// K-zone box and its thirds.
function LocScatter({ pitches }) {
  const W = 300, H = 300
  const sx = x => W / 2 + (x / 2.2) * (W / 2 - 12)
  const sy = z => H - 16 - ((z - 0.5) / 4.0) * (H - 32)
  const pts = (pitches || []).filter(p => p.x != null && p.z != null)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {[-0.28, 0.28].map((gx, i) => (
        <line key={i} x1={sx(gx)} y1={sy(3.5)} x2={sx(gx)} y2={sy(1.5)} stroke="currentColor" className="text-gray-200 dark:text-gray-600" />
      ))}
      {[2.17, 2.83].map((gz, i) => (
        <line key={i} x1={sx(-0.83)} y1={sy(gz)} x2={sx(0.83)} y2={sy(gz)} stroke="currentColor" className="text-gray-200 dark:text-gray-600" />
      ))}
      <rect x={sx(-0.83)} y={sy(3.5)} width={sx(0.83) - sx(-0.83)} height={sy(1.5) - sy(3.5)}
        fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-500 dark:text-gray-300" />
      {pts.map((p, i) => (
        <circle key={i} cx={sx(Math.max(-2.1, Math.min(2.1, p.x)))} cy={sy(Math.max(0.5, Math.min(4.4, p.z)))}
          r="3.5" fill={cFor(p.ptype)} opacity="0.55" />
      ))}
      <text x={W / 2} y={H - 3} fontSize="8" textAnchor="middle" fill="#9ca3af">catcher's view</text>
    </svg>
  )
}

function SessionChip({ label, value, pctl, vc = '' }) {
  const hc = heatCls(pctl)
  return (
    <div className={`rounded-lg px-2.5 py-1.5 text-center ${hc || 'bg-gray-50 dark:bg-gray-900/40'}`} {...toneAttr(pctl)}>
      <div className={`text-[15px] font-bold tabular-nums leading-none ${vc || 'text-gray-900 dark:text-gray-100'}`}>{value ?? '—'}</div>
      <div className="text-[9px] font-semibold uppercase tracking-wide text-gray-400 mt-1">{label}</div>
    </div>
  )
}

function TypeLegend({ types }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {types.map(t => (
        <span key={t.type} className="inline-flex items-center gap-1 text-[10px] font-semibold text-gray-500 dark:text-gray-400">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: cFor(t.type) }} />
          {t.type}
        </span>
      ))}
    </div>
  )
}

// One pitcher's full session sheet — sized to read as a one-page report.

// ── Count states: ahead / even / behind / 2 strikes, every number ─────
// `states` comes from the backend (stats/trackman_counts). Labels are the
// PITCHER's perspective in the data; the hitter view flips them so "Ahead"
// always means the player shown is ahead.
const CS_ROWS_P = [['ahead', 'Ahead'], ['even', 'Even'], ['behind', 'Behind'], ['two_k', '2 strikes'], ['first', 'First pitch'], ['three', '3 balls']]
const CS_ROWS_H = [['behind', 'Ahead'], ['even', 'Even'], ['ahead', 'Behind'], ['two_k', '2 strikes'], ['first', 'First pitch'], ['three', '3 balls']]
const CS_COLS_P = [['Pitches', 'pitches', 0], ['Share', 'share_pct', 1], ['Zone%', 'zone_pct', 1], ['Strike%', 'strike_pct', 1], ['Swing%', 'swing_pct', 1],
  ['Whiff%', 'whiff_pct', 1], ['Chase%', 'chase_pct', 1], ['CSW%', 'csw_pct', 1], ['BBE', 'bbe', 0], ['EV agn', 'avg_ev', 1], ['HH% agn', 'hh_pct', 1],
  ['xwOBAcon', 'xwobacon', 3], ['K', 'k', 0], ['BB', 'bb', 0], ['RV/100', 'rv100', 2, true]]
const CS_COLS_H = [['Pitches', 'pitches', 0], ['Share', 'share_pct', 1], ['Swing%', 'swing_pct', 1], ['Contact%', 'contact_pct', 1], ['Whiff%', 'whiff_pct', 1],
  ['Chase%', 'chase_pct', 1], ['Zone%', 'zone_pct', 1], ['BBE', 'bbe', 0], ['Avg EV', 'avg_ev', 1], ['HH%', 'hh_pct', 1], ['xwOBAcon', 'xwobacon', 3],
  ['K', 'k', 0], ['BB', 'bb', 0], ['RV/100', 'rv100', 2, true]]
const CS_LOWER_P = new Set(['avg_ev', 'hh_pct', 'xwobacon'])
const CS_LOWER_H = new Set(['whiff_pct', 'chase_pct'])

function CountStateTable({ states, mode, title }) {
  if (!states) return null
  const rows = (mode === 'pitcher' ? CS_ROWS_P : CS_ROWS_H).map(([k, label]) => ({ ...(states[k] || {}), k, label }))
  if (!rows.some(r => r.pitches)) return null
  const cols = mode === 'pitcher' ? CS_COLS_P : CS_COLS_H
  const lower = mode === 'pitcher' ? CS_LOWER_P : CS_LOWER_H
  // rv100 in the data is batter-perspective; flip for a pitcher
  const val = (r, k) => k === 'rv100' && r[k] != null && mode === 'pitcher' ? -r[k] : r[k]
  const cohort = Object.fromEntries(cols.map(([, k]) => [k, rows.slice(0, 3).map(r => val(r, k)).filter(v => v != null).map(Number)]))
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
      <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">{title || 'Count states'}</span>
        <span className="text-[10px] text-gray-400">{mode === 'pitcher' ? 'ahead = more strikes than balls' : 'ahead = more balls than strikes'} · 2 strikes, first pitch and 3 balls overlap the three states · shading compares ahead / even / behind</span>
      </div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[9.5px] uppercase tracking-wide text-gray-400">
            <th className="px-4 py-1.5">Count</th>
            {cols.map(([label, k]) => <th key={k} className="px-1.5 py-1.5 text-right whitespace-nowrap">{label}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
          {rows.map((r, i) => (
            <tr key={r.k} className={i === 3 ? 'border-t-2 border-gray-200 dark:border-gray-600' : ''}>
              <td className="px-4 py-1 font-semibold whitespace-nowrap">{r.label}</td>
              {cols.map(([, k, dec, plus]) => {
                const v = val(r, k)
                if (dec === 0 || dec === 3 || k === 'share_pct') return (
                  <td key={k} className="px-1.5 py-1 text-right tabular-nums text-gray-600 dark:text-gray-300">
                    {v == null ? '–' : dec === 3 ? Number(v).toFixed(3).replace(/^0/, '') : k === 'share_pct' ? `${Number(v).toFixed(0)}%` : Number(v).toFixed(dec)}
                  </td>
                )
                if (i >= 3) return <td key={k} className="px-1.5 py-1 text-right tabular-nums text-gray-600 dark:text-gray-300">{v == null ? '–' : `${plus && v > 0 ? '+' : ''}${Number(v).toFixed(dec)}`}</td>
                return <HeatCell key={k} v={v} vals={cohort[k]} higher={!lower.has(k)} dec={dec} plus={!!plus} />
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PitcherSessionCard({ p, sess, isPen, innerRef, onPdf, busy, onRetag }) {
  const [typeFilter, setTypeFilter] = useState(null)
  const [picked, setPicked] = useState(null)
  const allDots = p.pitches_detail || []
  const dots = typeFilter ? allDots.filter(d => d.ptype === typeFilter) : allDots

  async function retag(pitchType) {
    if (!picked) return
    await fetch(`/api/v1/trackman/pitches/${picked.pitch_id}/type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ pitch_type: pitchType }),
    })
    setPicked(null)
    if (onRetag) onRetag()
  }

  const chips = [
    ['Pitches', p.pitches],
    ...(!isPen && p.bf ? [['Batters faced', p.bf]] : []),
    ['FB velo', fmt(p.fb_velo)], ['FB max', fmt(p.fb_max)],
    ['Stuff+', p.stuff ?? '—'], ['Loc+', p.loc ?? '—'],
    ['Strike%', fmt(p.strike_pct)], ['Zone%', fmt(p.zone_pct)],
    ...(!isPen ? [
      ['CSW%', fmt(p.csw_pct)], ['Whiffs', p.whiffs], ['K', p.k], ['BB', p.bb],
      ['EV against', p.bbe ? fmt(p.ev_against) : '—'], ['Hard hit agn', p.bbe ? p.hh_against : '—'],
    ] : []),
  ]
  return (
    <div ref={innerRef} className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div>
          <span className="text-base font-bold text-gray-900 dark:text-gray-100">{p.pitcher}</span>
          <span className="text-xs text-gray-400 ml-2">{p.throws || ''} · {p.team}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400">{sess?.session_date} · {isPen ? 'Bullpen' : (TYPE_META[sess?.session_type] || {}).label || ''}</span>
          <button data-html2canvas-ignore="true" onClick={onPdf} disabled={busy}
            className="text-[11px] font-bold px-2 py-1 rounded-lg bg-portal-purple text-portal-cream hover:opacity-90 disabled:opacity-50">
            {busy ? '…' : 'PDF'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-12 gap-1.5">
        {chips.map(([l, v]) => <SessionChip key={l} label={l} value={v} />)}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-[9.5px] uppercase tracking-wide text-gray-400">
              <th className="py-1 pr-2">Pitch</th><th className="py-1 px-1.5 text-right">N</th>
              <th className="py-1 px-1.5 text-right"><StatTip k="stuff" group="pitching" label="Stuff+" /></th>
              <th className="py-1 px-1.5 text-right"><StatTip k="loc" group="pitching" label="Loc+" /></th>
              <th className="py-1 px-1.5 text-right">Use%</th><th className="py-1 px-1.5 text-right">Velo</th>
              <th className="py-1 px-1.5 text-right">Max</th><th className="py-1 px-1.5 text-right">Spin</th>
              <th className="py-1 px-1.5 text-right">IVB</th><th className="py-1 px-1.5 text-right">HB</th>
              <th className="py-1 px-1.5 text-right">Ext</th><th className="py-1 px-1.5 text-right">RelH</th>
              <th className="py-1 px-1.5 text-right">VAA</th><th className="py-1 px-1.5 text-right">Strike%</th>
              <th className="py-1 px-1.5 text-right">Zone%</th>
              {!isPen && <th className="py-1 px-1.5 text-right">CSW%</th>}
              {!isPen && <th className="py-1 px-1.5 text-right">Whiff%</th>}
              {!isPen && <th className="py-1 px-1.5 text-right">EV agn</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {(p.types || []).map(t => (
              <tr key={t.type}>
                <td className="py-1 pr-2 font-semibold whitespace-nowrap">
                  <span className="w-2 h-2 rounded-full inline-block mr-1.5" style={{ background: cFor(t.type) }} />
                  {t.type}
                </td>
                <td className="py-1 px-1.5 text-right tabular-nums">{t.n}</td>
                <td className={`py-1 px-1.5 text-right tabular-nums font-bold ${t.stuff == null ? 'text-gray-300' : t.stuff >= 110 ? 'text-[#d22d49]' : t.stuff <= 90 ? 'text-[#3661ad]' : ''}`}>{t.stuff ?? '–'}</td>
                <td className={`py-1 px-1.5 text-right tabular-nums ${t.loc == null ? 'text-gray-300' : t.loc >= 110 ? 'text-[#d22d49]' : t.loc <= 90 ? 'text-[#3661ad]' : ''}`}>{t.loc ?? '–'}</td>
                <td className="py-1 px-1.5 text-right tabular-nums">{fmt(t.usage)}</td>
                <td className="py-1 px-1.5 text-right tabular-nums font-semibold">{fmt(t.velo)}</td>
                <td className="py-1 px-1.5 text-right tabular-nums text-gray-400">{fmt(t.max_velo)}</td>
                <td className="py-1 px-1.5 text-right tabular-nums">{t.spin ?? '—'}</td>
                <td className="py-1 px-1.5 text-right tabular-nums">{fmt(t.ivb)}</td>
                <td className="py-1 px-1.5 text-right tabular-nums">{fmt(t.hb)}</td>
                <td className="py-1 px-1.5 text-right tabular-nums">{fmt(t.ext)}</td>
                <td className="py-1 px-1.5 text-right tabular-nums">{fmt(t.rel_h)}</td>
                <td className="py-1 px-1.5 text-right tabular-nums">{fmt(t.vaa)}</td>
                <td className="py-1 px-1.5 text-right tabular-nums">{fmt(t.strike_pct)}</td>
                <td className="py-1 px-1.5 text-right tabular-nums">{fmt(t.zone_pct)}</td>
                {!isPen && <td className="py-1 px-1.5 text-right tabular-nums">{fmt(t.csw_pct)}</td>}
                {!isPen && <td className="py-1 px-1.5 text-right tabular-nums">{fmt(t.whiff_pct)}</td>}
                {!isPen && <td className="py-1 px-1.5 text-right tabular-nums">{fmt(t.avg_ev)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div data-html2canvas-ignore="true" className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mr-1">Filter</span>
        {[null, ...(p.types || []).map(t => t.type)].map(t => (
          <button key={t || 'all'} onClick={() => setTypeFilter(t)}
            className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ring-1 inline-flex items-center gap-1 ${
              typeFilter === t ? 'bg-portal-purple text-white ring-portal-purple'
                : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 ring-gray-200 dark:ring-gray-700 hover:ring-portal-purple'}`}>
            {t && <span className="w-2 h-2 rounded-full inline-block" style={{ background: cFor(t) }} />}
            {t || 'All pitches'}
          </button>
        ))}
        <span className="text-[10px] text-gray-400 ml-auto">click a movement dot to re-tag</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[['Movement', <MovementPlot key="m" pitches={dots} selectedId={picked?.pitch_id}
            onPick={(d) => setPicked(picked?.pitch_id === d.pitch_id ? null : d)} />],
          ['Locations', <LocScatter key="l" pitches={dots} />],
          ['Release', <ReleasePlot key="r" pitches={dots} />]].map(([t, el]) => (
          <div key={t}>
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1 text-center">{t}</div>
            {el}
          </div>
        ))}
      </div>
      {picked && (
        <div data-html2canvas-ignore="true" className="rounded-lg bg-gray-50 dark:bg-gray-900/40 p-2.5">
          <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1.5">
            Selected: <b>{picked.ptype || '?'}</b>
            {picked.velo != null && ` · ${Number(picked.velo).toFixed(1)} mph`}
            {picked.ivb != null && ` · ${Number(picked.ivb).toFixed(1)}" IVB`}
            {picked.horz_break != null && ` · ${Number(picked.horz_break).toFixed(1)}" HB`}
            {picked.tagged_pitch_type && picked.tagged_pitch_type !== picked.ptype &&
              ` · tagged ${picked.tagged_pitch_type}`}
          </div>
          <div className="flex flex-wrap gap-1">
            {['Fastball', 'Sinker', 'Cutter', 'Slider', 'Sweeper', 'Curveball', 'ChangeUp', 'Splitter'].map(t => (
              <button key={t} onClick={() => retag(t)}
                className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ring-1 ${
                  t === picked.ptype ? 'bg-portal-purple text-white ring-portal-purple'
                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 ring-gray-200 dark:ring-gray-700 hover:ring-portal-purple'}`}>
                {t}
              </button>
            ))}
            {picked.override_pitch_type && (
              <button onClick={() => retag(null)}
                className="px-2 py-0.5 rounded-full text-[11px] font-semibold text-rose-600 ring-1 ring-rose-200 dark:ring-rose-800">
                Clear override
              </button>
            )}
          </div>
        </div>
      )}
      <TypeLegend types={p.types || []} />
      {!isPen && p.count_states && <CountStateTable states={p.count_states} mode="pitcher" title="Count states — this outing" />}
    </div>
  )
}

// One batter's session sheet: discipline + contact quality + every batted ball.
const GRADE_CLS = (g) => {
  const c = g?.[0]
  return c === 'A' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
    : c === 'B' ? 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300'
    : c === 'C' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
    : 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300'
}

function BatterSessionCard({ b, sess, innerRef, onPdf, busy, cohort, isBp }) {
  // Within-session cohort percentiles (this session's hitters), so a coach
  // can scan a wall of cards and see who had the good rounds.
  const co = fn => (cohort || []).map(fn).filter(v => v != null)
  const rate = c => (c.bbe ? 100 * c.hard_hit / c.bbe : null)
  const brate = c => (c.bbe ? 100 * c.barrels / c.bbe : null)
  const hhPct = b.bbe ? Math.round(100 * b.hard_hit / b.bbe) : null
  const brPct = b.bbe ? Math.round(100 * b.barrels / b.bbe) : null
  const P = {
    avg_ev: pctlOf(b.avg_ev, co(c => c.avg_ev)),
    max_ev: pctlOf(b.max_ev, co(c => c.max_ev)),
    hh: pctlOf(hhPct, co(rate)),
    br: pctlOf(brPct, co(brate)),
    whiff: pctlOf(b.whiff_pct, co(c => c.whiff_pct), false),
    chase: pctlOf(b.chase_pct, co(c => c.chase_pct), false),
    contact: pctlOf(b.contact_pct, co(c => c.contact_pct)),
    rv: pctlOf(b.rv, co(c => c.rv)),
  }
  P.airpull = pctlOf(b.airpull_pct, co(c => c.airpull_pct))
  const depthVc = DEPTH_CLS[depthTone(b.avg_depth)] || ''
  const laVc = b.avg_la == null ? ''
    : (b.avg_la >= 8 && b.avg_la <= 22) ? DEPTH_CLS.good
    : (b.avg_la >= 2 && b.avg_la <= 28) ? DEPTH_CLS.mid : DEPTH_CLS.bad
  const chips = isBp ? [
    ['Pitches', b.pitches], ['BBE', b.bbe],
    ['Avg EV', fmt(b.avg_ev), P.avg_ev], ['Max EV', fmt(b.max_ev), P.max_ev],
    ['HH%', hhPct != null ? hhPct : '—', P.hh],
    ['Barrels', b.bbe ? b.barrels : '—', P.br],
    ['AirPull%', fmt(b.airpull_pct), P.airpull],
    ['Avg LA', fmt(b.avg_la), null, laVc],
    ['GB/LD/FB', b.bbe ? `${b.gb}/${b.ld}/${b.fb}` : '—'],
    ['Depth', b.avg_depth != null ? b.avg_depth : '—', null, depthVc],
  ] : [
    ['PA', b.pa], ['Pitches', b.pitches], ['K', b.k], ['BB', b.bb],
    ['Swing%', fmt(b.swing_pct)], ['Whiff%', fmt(b.whiff_pct), P.whiff],
    ['Chase%', fmt(b.chase_pct), P.chase], ['Contact%', fmt(b.contact_pct), P.contact],
    ['BBE', b.bbe], ['Avg EV', fmt(b.avg_ev), P.avg_ev], ['Max EV', fmt(b.max_ev), P.max_ev],
    ['Hard hit', b.bbe ? b.hard_hit : '—', P.hh], ['Barrels', b.bbe ? b.barrels : '—', P.br],
    ['Avg LA', fmt(b.avg_la), null, laVc],
    ['GB/LD/FB', b.bbe ? `${b.gb}/${b.ld}/${b.fb}` : '—'],
    ['Depth', b.avg_depth != null ? b.avg_depth : '—', null, depthVc],
    ['RV', b.rv != null ? (b.rv > 0 ? `+${b.rv}` : b.rv) : '—', P.rv],
  ]
  const results = Object.entries(b.results || {}).filter(([k]) => k !== 'Undefined')
  return (
    <div ref={innerRef} className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div>
          <span className="text-base font-bold text-gray-900 dark:text-gray-100">{b.batter}</span>
          {b.bp_grade && (
            <span className={`text-sm font-black px-2 py-0.5 rounded-lg ml-2 align-middle ${GRADE_CLS(b.bp_grade.grade)}`}
              title={`BP round grade (score ${b.bp_grade.score}/100): avg EV 40%, hard-hit rate 30%, sweet-spot rate 30% — fixed scale, not curved within the session`}>
              {b.bp_grade.grade}
            </span>
          )}
          <span className="text-xs text-gray-400 ml-2">{b.side ? `${b.side[0]}HH` : ''} · {b.team}</span>
          {results.length > 0 && (
            <span className="text-[11px] text-gray-500 dark:text-gray-400 ml-3">
              {results.map(([k, v]) => `${v} ${k}`).join(' · ')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400">{sess?.session_date} · {(TYPE_META[sess?.session_type] || {}).label || ''}</span>
          <button data-html2canvas-ignore="true" onClick={onPdf} disabled={busy}
            className="text-[11px] font-bold px-2 py-1 rounded-lg bg-portal-purple text-portal-cream hover:opacity-90 disabled:opacity-50">
            {busy ? '…' : 'PDF'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
        {chips.map(([l, v, pc, vc]) => <SessionChip key={l} label={l} value={v} pctl={pc} vc={vc} />)}
      </div>
      {b.bbe > 0 && (
        <div className="grid sm:grid-cols-2 gap-3 items-start">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1 text-center">Spray</div>
            <SprayChart pitches={(b.bbe_list || []).map(x => ({ bearing: x.bearing, distance: x.dist, exit_speed: x.ev }))} />
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1 text-center">EV × Launch</div>
            <EvLaScatter points={(b.bbe_list || []).map(x => ({ ev: x.ev, la: x.la }))} />
          </div>
        </div>
      )}
      {!isBp && b.bbe > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[9.5px] uppercase tracking-wide text-gray-400">
                <th className="py-1 pr-2 text-right">EV</th><th className="py-1 px-1.5 text-right">LA</th>
                <th className="py-1 px-1.5 text-right">Dist</th><th className="py-1 px-1.5">Type</th>
                <th className="py-1 px-1.5">Result</th><th className="py-1 px-1.5">Pitch</th>
                <th className="py-1 px-1.5">vs Pitcher</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
              {(b.bbe_list || []).map((x, i) => (
                <tr key={i}>
                  <td className="py-1 pr-2 text-right tabular-nums font-bold">{fmt(x.ev)}</td>
                  <td className="py-1 px-1.5 text-right tabular-nums">{fmt(x.la)}</td>
                  <td className="py-1 px-1.5 text-right tabular-nums">{x.dist ?? '—'}</td>
                  <td className="py-1 px-1.5 text-xs">{x.hit_type || '—'}</td>
                  <td className="py-1 px-1.5 text-xs">{x.result || '—'}</td>
                  <td className="py-1 px-1.5 text-xs whitespace-nowrap">
                    <span className="w-2 h-2 rounded-full inline-block mr-1" style={{ background: cFor(x.ptype) }} />
                    {x.ptype || '—'}
                  </td>
                  <td className="py-1 px-1.5 text-xs text-gray-500">{x.pitcher || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!isBp && b.count_states && <CountStateTable states={b.count_states} mode="batter" title="Count states — this session" />}
    </div>
  )
}


// ── Team summary over a sample of sessions (Session Review) ───────
// How the staff and the lineup performed as UNITS over one day or many:
// process (strikes, zone, whiffs, chases, contact quality), value (RV) and
// the box line, plus every player's line over the same sample.
const TS_STAFF = [
  ['Pitches', 'pitches', 0], ['Arms', 'arms', 0], ['FB velo', 'fb_velo', 1], ['FB max', 'fb_max', 1],
  ['Strike%', 'strike_pct', 1], ['Zone%', 'zone_pct', 1], ['Whiff%', 'whiff_pct', 1], ['Chase%', 'chase_pct', 1], ['CSW%', 'csw_pct', 1],
  ['BBE', 'bbe', 0], ['EV agn', 'avg_ev', 1], ['HH% agn', 'hh_pct', 1], ['GB% agn', 'gb_pct', 1], ['xwOBAcon', 'xwobacon', 3],
  ['RV', 'rv', 1, true], ['RV/100', 'rv100', 2, true],
]
const TS_STAFF_LINE = [['IP', 'ip_str'], ['BF', 'bf', 0], ['H', 'h', 0], ['R', 'r', 0], ['HR', 'hr', 0], ['BB', 'bb', 0], ['K', 'k', 0], ['HBP', 'hbp', 0],
  ['K%', 'k_pct', 1], ['BB%', 'bb_pct', 1], ['WHIP', 'whip', 2], ['BAA', 'baa', 3], ['FIP', 'fip', 2], ['RA/9', 'ra9', 2]]
const TS_LINEUP = [
  ['Pitches', 'pitches', 0], ['Hitters', 'hitters', 0],
  ['Swing%', 'swing_pct', 1], ['Contact%', 'contact_pct', 1], ['Whiff%', 'whiff_pct', 1], ['Chase%', 'chase_pct', 1],
  ['BBE', 'bbe', 0], ['Avg EV', 'avg_ev', 1], ['Max EV', 'max_ev', 1], ['HH%', 'hh_pct', 1], ['Brl%', 'barrel_pct', 1],
  ['GB%', 'gb_pct', 1], ['LD%', 'ld_pct', 1], ['FB%', 'fb_pct', 1], ['Avg LA', 'avg_la', 1], ['xwOBAcon', 'xwobacon', 3],
  ['RV', 'rv', 1, true], ['RV/100', 'rv100', 2, true],
]
const TS_LINEUP_LINE = [['PA', 'pa', 0], ['AB', 'ab', 0], ['H', 'h', 0], ['2B', 'd2', 0], ['3B', 'd3', 0], ['HR', 'hr', 0], ['BB', 'bb', 0], ['K', 'k', 0], ['HBP', 'hbp', 0],
  ['AVG', 'avg', 3], ['OBP', 'obp', 3], ['SLG', 'slg', 3], ['OPS', 'ops', 3], ['ISO', 'iso', 3], ['BABIP', 'babip', 3], ['wOBA', 'woba', 3], ['xwOBA', 'xwoba', 3], ['wRC+', 'wrc_plus', 0]]
// lower is better for these when the row is a pitcher / a hitter
const TS_LOWER_PITCHER = new Set(['avg_ev', 'hh_pct', 'xwobacon'])
const TS_LOWER_HITTER = new Set(['whiff_pct', 'chase_pct', 'gb_pct'])

function tsFmt(v, dec, plus) {
  if (v == null) return '–'
  if (typeof v === 'string') return v
  const n = Number(v)
  const s = dec === 3 ? n.toFixed(3).replace(/^0/, '') : n.toFixed(dec ?? 1)
  return plus && n > 0 ? `+${s}` : s
}

function TeamStatStrip({ title, defs, obj, lineDefs, line }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2.5">{title}</div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {defs.map(([label, k, dec, plus]) => (
          <div key={k} className="min-w-[3.2rem]">
            <div className={`text-[17px] font-bold tabular-nums leading-none ${plus && obj?.[k] != null ? (obj[k] > 0 ? 'text-emerald-600 dark:text-emerald-400' : obj[k] < 0 ? 'text-rose-600 dark:text-rose-400' : '') : 'text-portal-purple dark:text-gray-100'}`}>
              {tsFmt(obj?.[k], dec, plus)}
            </div>
            <div className="text-[9.5px] font-semibold uppercase tracking-wide text-gray-400 mt-1">{label}</div>
          </div>
        ))}
      </div>
      {line && (
        <div className="mt-3 pt-2.5 border-t border-gray-100 dark:border-gray-700 flex flex-wrap gap-x-4 gap-y-1 text-[12px] tabular-nums">
          <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400 self-center">Line</span>
          {lineDefs.map(([label, k, dec]) => (
            <span key={k}><span className="text-gray-400 text-[10px] mr-1">{label}</span><span className="font-semibold">{tsFmt(line[k], dec)}</span></span>
          ))}
        </div>
      )}
    </div>
  )
}

function TeamPlayerTable({ rows, nameKey, defs, lineDefs, onOpen }) {
  const cols = [...defs.filter(([, k]) => !['arms', 'hitters'].includes(k)), ...lineDefs.map(([l, k, d]) => [l, `line.${k}`, d])]
  const get = (r, k) => k.startsWith('line.') ? r.line?.[k.slice(5)] : r[k]
  const lower = nameKey === 'pitcher' ? TS_LOWER_PITCHER : TS_LOWER_HITTER
  const [sortK, setSortK] = useState('pitches')
  const [sortD, setSortD] = useState(-1)
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const x = get(a, sortK), y = get(b, sortK)
    const xv = x == null ? -1e9 : typeof x === 'string' ? parseFloat(x) : x
    const yv = y == null ? -1e9 : typeof y === 'string' ? parseFloat(y) : y
    return (xv - yv) * sortD
  }), [rows, sortK, sortD])
  const cohort = useMemo(() => Object.fromEntries(cols.map(([, k]) => [k, rows.map(r => get(r, k)).filter(v => v != null && typeof v !== 'string').map(Number)])), [rows])
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[9.5px] uppercase tracking-wide text-gray-400">
            <th className="px-3 py-1.5 sticky left-0 bg-white dark:bg-gray-800">Player</th>
            {cols.map(([label, k]) => (
              <th key={k} onClick={() => { if (sortK === k) setSortD(d => -d); else { setSortK(k); setSortD(-1) } }}
                className={`px-1.5 py-1.5 text-right cursor-pointer select-none whitespace-nowrap ${sortK === k ? 'text-portal-purple dark:text-indigo-300' : ''}`}>
                {label}{sortK === k ? (sortD > 0 ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
          {sorted.map(r => (
            <tr key={r[nameKey]}>
              <td className="px-3 py-1 font-semibold whitespace-nowrap sticky left-0 bg-white dark:bg-gray-800 cursor-pointer" onClick={() => onOpen?.(r[nameKey])}>{r[nameKey]}</td>
              {cols.map(([, k, dec, plus]) => {
                const v = get(r, k)
                if (typeof v === 'string' || dec === 0 || dec === 3) return <td key={k} className="px-1.5 py-1 text-right tabular-nums text-gray-600 dark:text-gray-300">{tsFmt(v, dec, plus)}</td>
                return <HeatCell key={k} v={v} vals={cohort[k]} higher={!lower.has(k)} dec={dec ?? 1} plus={!!plus} />
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TeamSummaryPanel({ ids, team, onOpenPitcher, onOpenHitter }) {
  const { data, loading } = useApi(ids.length ? '/trackman/sessions/team-summary' : null,
    { ids: ids.join(','), team: team || undefined }, [ids.join(','), team])
  const [showPlayers, setShowPlayers] = useState('none')  // none | staff | lineup
  if (!ids.length) return null
  if (loading || !data) return <div className="text-sm text-gray-400 p-4 text-center">Building the team summary…</div>
  const label = data.sessions.length === 1
    ? `${data.sessions[0].session_date}`
    : `${data.sessions.length} sessions · ${data.sessions[0].session_date} to ${data.sessions[data.sessions.length - 1].session_date}`
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap text-[11px] text-gray-400">
        <span className="font-bold uppercase tracking-wide">Team summary — {data.team}</span>
        <span>{label} · {data.live_pitches} live pitches{data.total_pitches !== data.live_pitches ? ` (${data.total_pitches - data.live_pitches} BP / bullpen pitches excluded)` : ''}</span>
        <span className="ml-auto flex rounded-full ring-1 ring-gray-200 dark:ring-gray-700 overflow-hidden text-[11px] font-semibold">
          {[['none', 'Totals'], ['staff', 'Every arm'], ['lineup', 'Every hitter']].map(([k, l]) => (
            <button key={k} onClick={() => setShowPlayers(k)}
              className={`px-2.5 py-1 ${showPlayers === k ? 'bg-portal-purple text-white' : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400'}`}>{l}</button>
          ))}
        </span>
      </div>
      {data.staff ? <TeamStatStrip title="Pitching staff" defs={TS_STAFF} obj={data.staff} lineDefs={TS_STAFF_LINE} line={data.staff.line} />
        : <div className="text-xs text-gray-400 px-1">No live pitches thrown by {data.team} in this sample.</div>}
      {data.staff?.count_states && <CountStateTable states={data.staff.count_states} mode="pitcher" title="Staff by count state" />}
      {data.lineup ? <TeamStatStrip title="Lineup" defs={TS_LINEUP} obj={data.lineup} lineDefs={TS_LINEUP_LINE} line={data.lineup.line} />
        : <div className="text-xs text-gray-400 px-1">No live pitches seen by {data.team} in this sample.</div>}
      {data.lineup?.count_states && <CountStateTable states={data.lineup.count_states} mode="batter" title="Lineup by count state" />}
      {showPlayers === 'staff' && data.pitchers.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-700 text-[11px] font-bold uppercase tracking-wide text-gray-400">Every arm over this sample · click a name for his lab</div>
          <TeamPlayerTable rows={data.pitchers} nameKey="pitcher" defs={TS_STAFF} lineDefs={TS_STAFF_LINE} onOpen={onOpenPitcher} />
        </div>
      )}
      {showPlayers === 'lineup' && data.batters.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-700 text-[11px] font-bold uppercase tracking-wide text-gray-400">Every hitter over this sample · click a name for his lab</div>
          <TeamPlayerTable rows={data.batters} nameKey="batter" defs={TS_LINEUP} lineDefs={TS_LINEUP_LINE} onOpen={onOpenHitter} />
        </div>
      )}
    </div>
  )
}

function SessionsTab({ overview, season, sessionId, setSessionId, teamCtx, onOpenLab, onOpenHitterLab }) {
  const sessions = (overview?.sessions || []).filter(x => !season || seasonOf(x.session_date) === season)
  const active = sessionId || sessions[0]?.id
  const { data, loading, refetch } = useApi(active ? `/trackman/sessions/${active}/review` : null, {}, [active])
  const sess = data?.session
  const isPen = !!data?.is_bullpen
  const [mode, setMode] = useState('auto')   // 'auto' opens whichever side has data
  const view = isPen ? 'pitching'
    : mode !== 'auto' ? mode
    : (data && !(data.pitchers || []).length && (data.batters || []).length) ? 'hitting' : 'pitching' 
  const cardRefs = useRef({})
  const contentRef = useRef(null)
  // Multi-day sample for the team summary: empty = just the open session.
  const [sample, setSample] = useState([])
  const [picking, setPicking] = useState(false)
  const liveSessions = sessions.filter(x => x.session_type !== 'bp' && x.session_type !== 'bullpen')
  const summaryIds = sample.length ? sample : (active && !isPen && sess && sess.session_type !== 'bp' ? [active] : [])
  const toggleSample = (id) => setSample(cur => cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id])
  const [busyKey, setBusyKey] = useState(null)   // one player's PDF rendering
  const [bulk, setBulk] = useState(null)          // "3/8" while the all-PDF renders

  const players = view === 'pitching' ? (data?.pitchers || []) : (data?.batters || [])
  const keyOf = pl => pl.pitcher || pl.batter
  cardRefs.current = {}                            // refs re-register each render

  async function onePdf(pl) {
    const node = cardRefs.current[keyOf(pl)]
    if (!node) return
    setBusyKey(keyOf(pl))
    try {
      await saveNodeAsPdf(node, `${keyOf(pl).replace(/[^a-z0-9]+/gi, '_')}_${sess?.session_date || 'session'}`)
    } finally { setBusyKey(null) }
  }

  async function allPdf() {
    const nodes = players.map(pl => cardRefs.current[keyOf(pl)]).filter(Boolean)
    if (!nodes.length) return
    setBulk(`0/${nodes.length}`)
    try {
      await saveNodesAsPdf(nodes, `session_${sess?.session_date || active}_${view}`,
        (d, t) => setBulk(`${d}/${t}`))
    } finally { setBulk(null) }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <select value={active || ''} onChange={e => setSessionId(Number(e.target.value))}
          className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-sm font-semibold">
          {sessions.map(s => (
            <option key={s.id} value={s.id}>
              {s.session_date} · {(TYPE_META[s.session_type] || {}).label || s.session_type} · {
                s.session_type === 'bp' ? (s.stadium || 'BP')
                : s.session_type === 'bullpen' ? (s.stadium || 'Bullpen')
                : `${s.away_team} @ ${s.home_team}`}
            </option>
          ))}
        </select>
        {!isPen && (
          <div className="flex rounded-lg ring-1 ring-gray-200 dark:ring-gray-700 overflow-hidden">
            {[['pitching', 'Pitching'], ['hitting', 'Hitting']].map(([k, label]) => (
              <button key={k} onClick={() => setMode(k)}
                className={`px-3 py-1.5 text-sm font-semibold ${view === k
                  ? 'bg-portal-purple text-portal-cream'
                  : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
                {label}
              </button>
            ))}
          </div>
        )}
        {isPen && (
          <span className="text-[11px] font-bold px-2 py-1 rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
            Bullpen session · pitchers only
          </span>
        )}
        {sess && <span className="ml-auto text-xs text-gray-400 tabular-nums">{sess.pitch_count} pitches{isPen ? '' : ` · ${sess.bbe_count} BBE`}</span>}
        {players.length > 0 && (
          <button onClick={allPdf} disabled={!!bulk}
            className="px-3 py-1.5 rounded-lg bg-portal-purple text-portal-cream text-sm font-semibold hover:opacity-90 disabled:opacity-60">
            {bulk ? `Rendering ${bulk}…` : `All ${view === 'pitching' ? 'pitcher' : 'hitter'} PDFs`}
          </button>
        )}
        {players.length > 0 && (
          <button onClick={() => saveNodeAsCsv(contentRef.current, `session_${sess?.session_date || active}_${view}`)}
            className="px-3 py-1.5 rounded-lg border border-nw-teal text-nw-teal text-sm font-semibold hover:bg-nw-teal/10"
            title="Every table on the visible player cards, one CSV">
            Save CSV
          </button>
        )}
      </div>

      {/* Team summary: this session, or a hand-picked sample of days */}
      {liveSessions.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 px-4 py-2.5 flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Sample</span>
          <span className="text-[12px] text-gray-500">
            {sample.length ? `${sample.length} session${sample.length === 1 ? '' : 's'} selected` : 'this session only'}
          </span>
          <button onClick={() => setPicking(v => !v)}
            className="text-[12px] font-semibold text-portal-purple dark:text-indigo-300 hover:underline">
            {picking ? 'Done' : 'Pick days…'}
          </button>
          {sample.length > 0 && (
            <button onClick={() => setSample([])} className="text-[12px] text-rose-500 hover:underline">Clear (back to one session)</button>
          )}
          {sample.length === 0 && !picking && liveSessions.some(x => x.session_type === 'intrasquad') && (
            <button onClick={() => setSample(liveSessions.filter(x => x.session_type === 'intrasquad').map(x => x.id))}
              className="text-[11px] text-gray-400 hover:underline" title="Every intrasquad this season">all intrasquads</button>
          )}
          {sample.length === 0 && !picking && liveSessions.some(x => x.session_type === 'game') && (
            <button onClick={() => setSample(liveSessions.filter(x => x.session_type === 'game').map(x => x.id))}
              className="text-[11px] text-gray-400 hover:underline" title="Every game this season">all games</button>
          )}
          {picking && (
            <div className="w-full flex flex-wrap gap-1.5 pt-1">
              {liveSessions.map(x => (
                <button key={x.id} onClick={() => toggleSample(x.id)}
                  className={`text-[11px] rounded-full px-2.5 py-1 ring-1 tabular-nums ${
                    sample.includes(x.id) ? 'bg-portal-purple text-white ring-portal-purple'
                      : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-gray-200 dark:ring-gray-700'}`}>
                  {x.session_date} · {(TYPE_META[x.session_type] || {}).label || x.session_type}
                  {x.session_type !== 'intrasquad' ? ` · ${x.away_team} @ ${x.home_team}` : ''}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <TeamSummaryPanel ids={summaryIds} team={teamCtx?.primary} onOpenPitcher={onOpenLab} onOpenHitter={onOpenHitterLab} />

      {sample.length === 0 && (loading ? <div className="text-sm text-gray-400 p-6 text-center">Loading…</div> : data && (
        <div ref={contentRef} className="space-y-3">
          {view === 'pitching' && data.zone_report?.called > 20 && !isPen && (
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

          {players.length === 0 && (
            <div className="p-8 text-center text-sm text-gray-400">
              No {view === 'pitching' ? 'pitcher' : 'hitter'} data in this session.
            </div>
          )}
          {players.map(pl => view === 'pitching' ? (
            <PitcherSessionCard key={keyOf(pl)} p={pl} sess={sess} isPen={isPen}
              innerRef={el => { cardRefs.current[keyOf(pl)] = el }}
              onPdf={() => onePdf(pl)} busy={busyKey === keyOf(pl)} onRetag={refetch} />
          ) : (
            <BatterSessionCard key={keyOf(pl)} b={pl} sess={sess}
              cohort={data.batters} isBp={sess?.session_type === 'bp'}
              innerRef={el => { cardRefs.current[keyOf(pl)] = el }}
              onPdf={() => onePdf(pl)} busy={busyKey === keyOf(pl)} />
          ))}

          <p className="text-[10.5px] text-gray-400 leading-snug max-w-3xl">
            BP round grades are on a fixed scale calibrated to this corpus (avg EV 40%, hard-hit
            rate 30%, sweet-spot rate 30%; 5+ tracked balls required), so an A means a genuinely
            loud round, not just the best of that day. Avg LA colors green in the 8-22 degree band.
            Click any dot on a movement plot to re-tag that pitch — overrides win everywhere (labs,
            leaderboards, grades), not just here. Each card is one player's session sheet — the PDF button saves it as its own page, and the
            All-PDFs button renders every card into one document (one player per page). Bullpen sessions
            show pitch design only: TrackMan tags a placeholder hitter, so batter stats, whiffs and
            results are not real there. RV on hitter cards is corpus-centered run value for this
            session's pitches.
          </p>
        </div>
      ))}
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


// ── Coach catcher quick log (xlsx) ────────────────────────────────
// The hand chart a coach keeps every live game: blocks, steal attempts,
// throwdowns with pop times, a 1-5 grade. TrackMan has none of it, so it
// sits under the TrackMan catcher boards with block events matched back to
// the exact pitch (same date, catcher, inning, count) where possible.
function CatcherLogSection() {
  const fileRef = useRef(null)
  const [uploadDate, setUploadDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const [showEvents, setShowEvents] = useState(false)
  const { data, refetch } = useApi('/trackman/catcher-log', {})
  const catchers = data?.catchers || []
  const events = data?.events || []

  async function upload() {
    const f = fileRef.current?.files?.[0]
    if (!f) { setNote({ err: 'Choose the quick log workbook (.xlsx).' }); return }
    setBusy(true); setNote(null)
    try {
      const fd = new FormData()
      fd.append('file', f)
      if (uploadDate) fd.append('session_date', uploadDate)
      const res = await fetch('/api/v1/trackman/catcher-log/upload', { method: 'POST', body: fd, headers: await authHeaders() })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
      const j = await res.json()
      setNote({ ok: `Logged ${j.rows} events across ${j.games} game${j.games === 1 ? '' : 's'} for ${j.session_date}: ${j.catchers.join(', ')}` })
      if (fileRef.current) fileRef.current.value = ''
      refetch()
    } catch (e) { setNote({ err: e.message }) } finally { setBusy(false) }
  }
  async function removeDate(d) {
    if (!window.confirm(`Delete the ${d} catcher log?`)) return
    await fetch(`/api/v1/trackman/catcher-log/${d}`, { method: 'DELETE', headers: await authHeaders() })
    refetch()
  }
  const pct = v => v == null ? '—' : `${v.toFixed(0)}%`
  const outcomeCls = (o) => o === 'Block Success' || o === 'Caught Stealing' || o === 'Caught'
    ? 'text-emerald-700 bg-emerald-50 dark:bg-emerald-900/30 dark:text-emerald-300'
    : o === 'Block Miss' || o === 'Passed Ball' || o === 'Stolen Base'
      ? 'text-rose-700 bg-rose-50 dark:bg-rose-900/30 dark:text-rose-300'
      : 'text-gray-600 bg-gray-100 dark:bg-gray-700 dark:text-gray-300'

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between flex-wrap gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Coach quick log — blocks, steals, throwdowns</span>
        <span className="text-[10px] text-gray-400">hand-charted every live game · what TrackMan cannot see · block events matched to the exact pitch when the inning and count line up</span>
      </div>
      <div className="px-4 py-3 flex items-center gap-2 flex-wrap border-b border-gray-100 dark:border-gray-700">
        <input ref={fileRef} type="file" accept=".xlsx" className="text-xs" />
        <input type="date" value={uploadDate} onChange={e => setUploadDate(e.target.value)}
          className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1 text-xs" title="Game date (re-uploading a date replaces it)" />
        <button onClick={upload} disabled={busy}
          className="px-3 py-1 rounded-lg bg-portal-purple text-white text-xs font-semibold disabled:opacity-50">
          {busy ? 'Uploading…' : 'Upload quick log'}
        </button>
        {note?.ok && <span className="text-xs text-emerald-700 dark:text-emerald-300">{note.ok}</span>}
        {note?.err && <span className="text-xs text-rose-600">{note.err}</span>}
        {(data?.dates || []).length > 0 && (
          <span className="ml-auto flex items-center gap-1 flex-wrap">
            {data.dates.map(d => (
              <span key={d} className="text-[10px] rounded-full px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-300 tabular-nums">
                {d} <button onClick={() => removeDate(d)} className="text-rose-500 ml-0.5" title="Delete this date">×</button>
              </span>
            ))}
          </span>
        )}
      </div>
      {catchers.length === 0 ? (
        <div className="p-6 text-center text-sm text-gray-400">No quick logs uploaded yet. Upload the coach's .xlsx (the "Live Log" sheet) with the game date.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
                <th className="px-4 py-2">Catcher</th>
                <th className="px-2 py-2 text-right" title="Games in the log">G</th>
                <th className="px-2 py-2 text-right" title="Block chances charted">Block opps</th>
                <th className="px-2 py-2 text-right" title="Blocks kept in front / block chances">Block%</th>
                <th className="px-2 py-2 text-right">Miss</th>
                <th className="px-2 py-2 text-right" title="Passed balls">PB</th>
                <th className="px-2 py-2 text-right" title="Stolen bases against">SB</th>
                <th className="px-2 py-2 text-right" title="Caught stealing">CS</th>
                <th className="px-2 py-2 text-right" title="CS / steal attempts">CS%</th>
                <th className="px-2 py-2 text-right" title="Between-innings throwdowns charted">Throwdowns</th>
                <th className="px-2 py-2 text-right" title="Average charted pop time (throwdowns + steal throws)">Pop</th>
                <th className="px-2 py-2 text-right">Best</th>
                <th className="px-2 py-2 text-right" title="Average coach grade on charted events (1-5)">Grade</th>
                <th className="px-2 py-2">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {catchers.map(c => (
                <tr key={c.catcher}>
                  <td className="px-4 py-1.5 font-semibold whitespace-nowrap">{c.catcher}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{c.games}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{c.block_opps || '—'}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${c.block_pct == null ? 'text-gray-300' : c.block_pct >= 75 ? 'text-emerald-600' : c.block_pct < 50 ? 'text-rose-600' : ''}`}>{pct(c.block_pct)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{c.block_miss || '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{c.pb || '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{c.sb || '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{c.cs || '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{pct(c.cs_pct)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{c.throwdowns || '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-bold">{c.avg_pop != null ? `${c.avg_pop.toFixed(2)} (${c.pops_n})` : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{c.best_pop?.toFixed(2) ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{c.avg_grade != null ? `${c.avg_grade.toFixed(1)} (${c.grades_n})` : '—'}</td>
                  <td className="px-2 py-1.5 text-[11px] text-gray-500 max-w-xs truncate" title={c.notes.join(' · ')}>{c.notes.join(' · ') || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-700">
            <button onClick={() => setShowEvents(v => !v)} className="text-[12px] font-semibold text-portal-purple dark:text-indigo-300 hover:underline">
              {showEvents ? 'Hide' : 'Show'} every charted event ({events.length})
            </button>
          </div>
          {showEvents && (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
                  <th className="px-4 py-1.5">Date</th><th className="px-2 py-1.5">G</th><th className="px-2 py-1.5">Inn</th>
                  <th className="px-2 py-1.5">Catcher</th><th className="px-2 py-1.5">Count</th><th className="px-2 py-1.5">Event</th>
                  <th className="px-2 py-1.5">Outcome</th><th className="px-2 py-1.5 text-right">Pop</th><th className="px-2 py-1.5 text-right">Grade</th>
                  <th className="px-2 py-1.5">Note</th><th className="px-2 py-1.5">TrackMan pitch</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {events.map(e => (
                  <tr key={e.id}>
                    <td className="px-4 py-1 tabular-nums text-gray-500">{e.session_date}</td>
                    <td className="px-2 py-1 tabular-nums text-gray-400">{e.game_no}</td>
                    <td className="px-2 py-1 tabular-nums">{e.inning ?? '—'}</td>
                    <td className="px-2 py-1 font-semibold whitespace-nowrap">{e.catcher}</td>
                    <td className="px-2 py-1 tabular-nums">{e.count || '—'}</td>
                    <td className="px-2 py-1">{e.event || '—'}</td>
                    <td className="px-2 py-1"><span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${outcomeCls(e.outcome)}`}>{e.outcome || '—'}</span></td>
                    <td className="px-2 py-1 text-right tabular-nums">{e.pop_time?.toFixed(2) ?? '—'}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{e.grade ?? '—'}</td>
                    <td className="px-2 py-1 text-gray-500">{e.note && e.pop_time == null ? e.note : ''}</td>
                    <td className="px-2 py-1 text-gray-500 whitespace-nowrap">
                      {e.tm ? `${e.tm.ptype || '?'} ${e.tm.velo ?? ''} mph · ${e.tm.call} · ${e.tm.pitcher || ''}${e.tm.loc_height != null ? ` · ${e.tm.loc_height} ft` : ''}` : (e.event === 'Block' ? 'no unique match' : '')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

function CatchingTab({ teamCtx, season }) {
  const exportRef = useRef(null)
  const [team, setTeam] = useState(teamCtx.primary)
  const [context, setContext] = useState('all')
  const { data, loading } = useApi('/trackman/catching',
    { ...(team ? { team } : {}), season, context }, [team, context])
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
      <div className="flex justify-end items-center gap-2 flex-wrap">
        {DEF_CONTEXTS.map(([k, label]) => (
          <button key={k} onClick={() => setContext(k)}
            className={`px-2.5 py-1 rounded-full text-[12px] font-semibold ${
              context === k ? 'bg-portal-purple text-white'
                : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
            {label}
          </button>
        ))}
        <ReportActions csv targetRef={exportRef} filename="trackman_catching" />
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
                <th className="px-2 py-2 text-right"><StatTip k="total_runs" group="catching" label="Value" /></th>
                <th className="px-2 py-2 text-right"><StatTip k="framing_runs" group="catching" label="Framing" /></th>
                <th className="px-2 py-2 text-right"><StatTip k="sae" group="catching" label="SAE" /></th>
                <th className="px-2 py-2 text-right" title="Taken pitches within ~4 inches of the zone edge">Edge takes</th>
                <th className="px-2 py-2 text-right">Edge K%</th>
                {['High', 'Low', 'Left', 'Right'].map(h => (
                  <th key={h} className="px-2 py-2 text-right" title={`SAE on the ${h.toLowerCase()} edge`}>{h}</th>
                ))}
                <th className="px-2 py-2 text-right"><StatTip k="arm_runs" group="catching" label="Arm" /></th>
                <th className="px-2 py-2 text-right" title="Actual stolen bases against - caught stealing (site season stats)">SB-CS</th>
                <th className="px-2 py-2 text-right"><StatTip k="blended_cs_pct" group="catching" label="CS%" /></th>
                <th className="px-2 py-2 text-right" title="Estimated CS% from average pop time alone">est CS%</th>
                <th className="px-2 py-2 text-right"><StatTip k="avg_pop" group="catching" label="Pop" /></th>
                <th className="px-2 py-2 text-right"><StatTip k="best_pop" group="catching" label="Best" /></th>
                <th className="px-2 py-2 text-right"><StatTip k="avg_exchange" group="catching" label="Exch" /></th>
                <th className="px-2 py-2 text-right"><StatTip k="avg_throw" group="catching" label="Arm velo" /></th>
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

      <CatcherLogSection />
    </div>
  )
}


// ── Hitter Development (TrackMan x Blast) ────────────────────────

// Team quadrant map: bat speed (engine) vs exit velo (result). The gap
// between the two percentiles is the whole development story.
function QuadrantMap({ hitters, selected, onPick }) {
  const W = 480, H = 300, L = 40, R = 16, T = 18, B = 30
  const X = v => L + (v / 100) * (W - L - R)
  const Y = v => T + ((100 - v) / 100) * (H - T - B)
  const pts = hitters.filter(h => h.speed_pctl != null && h.ev_pctl != null)
  if (pts.length < 3) return null
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-2xl mx-auto">
      <rect x={X(50)} y={T} width={X(100) - X(50)} height={Y(50) - T} fill="#059669" opacity="0.05" />
      <line x1={X(50)} y1={T} x2={X(50)} y2={H - B} stroke="currentColor" className="text-gray-200 dark:text-gray-600" />
      <line x1={L} y1={Y(50)} x2={W - R} y2={Y(50)} stroke="currentColor" className="text-gray-200 dark:text-gray-600" />
      {[['Fast + Loud', X(75), T + 12], ['Slow + Loud', X(22), T + 12],
        ['Fast + Quiet', X(75), Y(4)], ['Developing', X(22), Y(4)]].map(([t, x, y]) => (
        <text key={t} x={x} y={y} fontSize="9" fontWeight="700" fill="#9ca3af" textAnchor="middle">{t}</text>
      ))}
      {pts.map(h => (
        <g key={h.batter} onClick={() => onPick(h.batter)} style={{ cursor: 'pointer' }}>
          <circle cx={X(h.speed_pctl)} cy={Y(h.ev_pctl)} r={selected === h.batter ? 6 : 4.5}
            fill={selected === h.batter ? '#7c3aed' : '#d22d49'} opacity={selected && selected !== h.batter ? 0.35 : 0.8}
            stroke="#fff" strokeWidth="1" />
          <text x={X(h.speed_pctl)} y={Y(h.ev_pctl) - 7} fontSize="8" textAnchor="middle"
            fill="currentColor" className="text-gray-500 dark:text-gray-300"
            opacity={selected && selected !== h.batter ? 0.4 : 1}>
            {h.batter.split(',')[0]}
          </text>
        </g>
      ))}
      <text x={(L + W - R) / 2} y={H - 8} fontSize="9" fill="#9ca3af" textAnchor="middle">bat speed percentile (Blast) →</text>
      <text x={12} y={(T + H - B) / 2} fontSize="9" fill="#9ca3af" textAnchor="middle" transform={`rotate(-90 12 ${(T + H - B) / 2})`}>exit velo percentile (TrackMan) →</text>
    </svg>
  )
}

const QUAD_CLS = {
  'Fast + Loud': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  'Fast + Quiet': 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  'Slow + Loud': 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  'Developing': 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
}

// "6'2", "6-2", "6 2" or plain inches -> inches; blank -> null.
function parseHeight(v) {
  const t = String(v || '').trim().replace(/"/g, '')
  if (!t) return null
  const m = t.match(/^(\d)\s*['\-\s]\s*(\d{1,2})$/)
  if (m) return Number(m[1]) * 12 + Number(m[2])
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? n : null
}
const fmtHeight = v => v == null ? '' : `${Math.floor(v / 12)}'${Math.round(v % 12)}"`

// Inline height/weight/speed editor feeding the size-aware dev rules.
function MeasurablesEditor({ hitters, onSaved }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState(null)   // {player: {ht, wt, run}} as strings
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  function start() {
    setRows(Object.fromEntries(hitters.map(h => [h.batter, {
      ht: h.height_in != null ? fmtHeight(h.height_in) : '',
      wt: h.weight_lb != null ? String(Math.round(h.weight_lb)) : '',
      run: h.thirty_yd != null ? String(h.thirty_yd) : '',
    }])))
    setOpen(true)
  }

  async function save() {
    setBusy(true); setNote('')
    try {
      const players = Object.entries(rows).map(([player, r]) => ({
        player,
        height_in: parseHeight(r.ht),
        weight_lb: r.wt ? Number(r.wt) || null : null,
        thirty_yd: r.run ? Number(r.run) || null : null,
      }))
      const res = await fetch('/api/v1/trackman/measurables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ players }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
      setNote('Saved'); setOpen(false)
      onSaved()
    } catch (e) { setNote(e.message) } finally { setBusy(false) }
  }

  if (!open) {
    return (
      <button data-html2canvas-ignore="true" onClick={start}
        className="text-[12px] font-semibold text-portal-purple dark:text-indigo-300 hover:underline">
        {note === 'Saved' ? 'Saved ✓ · ' : ''}Edit measurables
      </button>
    )
  }
  return (
    <div data-html2canvas-ignore="true" className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4 w-full">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
          Physical measurables — height, weight, 30-yd
        </span>
        <div className="flex items-center gap-2">
          {note && note !== 'Saved' && <span className="text-xs text-rose-600">{note}</span>}
          <button onClick={() => setOpen(false)} className="text-[12px] font-semibold text-gray-400 hover:underline">Cancel</button>
          <button onClick={save} disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-portal-purple text-portal-cream text-[12px] font-bold hover:opacity-90 disabled:opacity-50">
            {busy ? 'Saving…' : 'Save all'}
          </button>
        </div>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5">
        {hitters.map(h => (
          <div key={h.batter} className="flex items-center gap-1.5 text-[12px]">
            <span className="w-32 truncate font-semibold text-gray-700 dark:text-gray-200">{h.batter}</span>
            <input value={rows[h.batter]?.ht || ''} placeholder={'6\'2'}
              onChange={e => setRows(r => ({ ...r, [h.batter]: { ...r[h.batter], ht: e.target.value } }))}
              className="w-14 rounded border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-1.5 py-0.5 text-right" />
            <input value={rows[h.batter]?.wt || ''} placeholder="195"
              onChange={e => setRows(r => ({ ...r, [h.batter]: { ...r[h.batter], wt: e.target.value } }))}
              className="w-14 rounded border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-1.5 py-0.5 text-right" />
            <input value={rows[h.batter]?.run || ''} placeholder="3.9s"
              onChange={e => setRows(r => ({ ...r, [h.batter]: { ...r[h.batter], run: e.target.value } }))}
              className="w-14 rounded border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-1.5 py-0.5 text-right" />
          </div>
        ))}
      </div>
      <p className="text-[10px] text-gray-400 mt-2">
        Height accepts 6'2, 6-2 or plain inches; weight in pounds; 30-yd dash in seconds. Blanks are fine —
        weight is what powers the strength-to-size rules.
      </p>
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

const AREA_CLS = {
  Identity: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  Catching: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  Defense: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
}

function DevPlayerRow({ p, hd, initialOpen = false }) {
  const [open, setOpen] = useState(initialOpen)
  const strengths = p.points.filter(x => x.kind === 'strength').length
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full px-4 py-2.5 flex items-center gap-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40">
        <span className={`text-gray-400 text-xs transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        <span className="font-bold text-gray-900 dark:text-gray-100">{p.player}</span>
        <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
          {p.roles.filter(r => r !== 'defense').join(' · ') || 'position player'}
        </span>
        {hd?.quadrant && (
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${QUAD_CLS[hd.quadrant] || ''}`}>{hd.quadrant}</span>
        )}
        <span className="ml-auto flex gap-1">
          {[...new Set(p.points.map(x => x.area))].slice(0, 4).map(a => (
            <span key={a} className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full
              ${AREA_CLS[a] || 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300'}`}>
              {a}
            </span>
          ))}
        </span>
        <span className="text-[11px] text-gray-400 tabular-nums whitespace-nowrap">
          {p.points.length - strengths} focus · {strengths} strength
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 space-y-2 border-t border-gray-100 dark:border-gray-700">
          {p.points.map((pt, i) => (
            <div key={i} className="flex gap-2.5 items-start">
              <span className={`shrink-0 mt-0.5 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full
                ${pt.kind === 'strength' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                  : 'bg-portal-purple/10 text-portal-purple dark:bg-indigo-900/40 dark:text-indigo-300'}`}>
                {pt.kind === 'strength' ? '★ ' : ''}{pt.area}
              </span>
              <p className="text-[13px] leading-snug text-gray-700 dark:text-gray-300">{pt.note}</p>
            </div>
          ))}
          {hd && (hd.points?.length > 0 || hd.strength) && (
            <div className="pt-2 mt-1 border-t border-dashed border-gray-200 dark:border-gray-700 space-y-2">
              <div className="flex items-baseline justify-between flex-wrap gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Swing build — TrackMan × Blast</span>
                <span className="text-[10px] text-gray-400 tabular-nums">
                  {hd.height_in != null || hd.weight_lb != null
                    ? `${hd.height_in != null ? fmtHeight(hd.height_in) : ''}${hd.height_in != null && hd.weight_lb != null ? ' / ' : ''}${hd.weight_lb != null ? `${Math.round(hd.weight_lb)} lb` : ''} · `
                    : ''}
                  {hd.bat_speed != null ? `bat ${hd.bat_speed}${hd.peak_bat_speed ? `/${hd.peak_bat_speed}` : ''} mph · ` : ''}
                  {hd.smash != null ? `smash ${hd.smash} · ` : ''}
                  EV {hd.avg_ev ?? '–'} · LA {hd.avg_la ?? '–'} · GB {hd.gb_pct ?? '–'}%
                  {hd.ope != null ? ` · OPE ${hd.ope}%` : ''}
                </span>
              </div>
              {hd.strength && (
                <div className="flex gap-2.5 items-start">
                  <span className="shrink-0 mt-0.5 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">★ Lean on</span>
                  <p className="text-[13px] leading-snug text-gray-700 dark:text-gray-300">{hd.strength}</p>
                </div>
              )}
              {(hd.points || []).map((pt, i) => (
                <div key={i} className="flex gap-2.5 items-start">
                  <span className="shrink-0 mt-0.5 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-portal-purple/10 text-portal-purple dark:bg-indigo-900/40 dark:text-indigo-300">
                    {pt.area}
                  </span>
                  <p className="text-[13px] leading-snug text-gray-700 dark:text-gray-300">{pt.note}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CoachBoardTab({ teamCtx, season }) {
  const [team, setTeam] = useState(teamCtx.primary)
  const [selHitter, setSelHitter] = useState('')
  const { data, loading } = useApi('/trackman/insights', { team: team || undefined, season })
  const { data: dev, loading: devLoading } = useApi('/trackman/dev-notes', { team: team || undefined, season })
  const { data: hdData, refetch: refetchHd } = useApi('/trackman/hitter-dev', { ...(team ? { team } : {}), season }, [team])
  const flags = data?.flags || []
  const devPlayers = dev?.players || []
  const pitchers = devPlayers.filter(p => p.roles.includes('pitcher'))
  const hitters = devPlayers.filter(p => !p.roles.includes('pitcher'))
  const hdHitters = hdData?.hitters || []
  const hdByName = Object.fromEntries(hdHitters.map(h => [h.batter, h]))
  // hitter-dev qualifiers missing from dev-notes still get a card
  const extraHd = hdHitters.filter(h => !devPlayers.some(p => p.player === h.batter))

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-gray-500 dark:text-gray-400 max-w-xl">
          The development board: every tracked player with data-backed coaching points — a strength
          to lean on plus the highest-leverage focuses. Click a player to open their plan.
          Auto-flags (transfer gaps, velo dips, mix mismatches) follow below. Signals, not verdicts.
        </p>
        <div className="ml-auto"><TeamSelect teamCtx={teamCtx} value={team} onChange={setTeam} /></div>
      </div>

      {devLoading ? <div className="text-sm text-gray-400 p-6 text-center">Building development plans…</div> : (
        <>
          {pitchers.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 px-1">Pitchers ({pitchers.length})</div>
              {pitchers.map(p => <DevPlayerRow key={p.player} p={p} />)}
            </div>
          )}
          {(hitters.length > 0 || hdHitters.length > 0) && (
            <div className="space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 px-1">Position players ({hitters.length + extraHd.length})</div>
              {hdHitters.length >= 3 && (
                <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
                  <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
                      Engine vs result — bat speed (Blast) x exit velo (TrackMan)
                    </span>
                    <MeasurablesEditor hitters={hdHitters} onSaved={refetchHd} />
                  </div>
                  <QuadrantMap hitters={hdHitters} selected={selHitter}
                    onPick={n => setSelHitter(selHitter === n ? '' : n)} />
                  <p className="text-[10.5px] text-gray-400 mt-1 max-w-3xl mx-auto text-center">
                    Click a dot to open that hitter's plan. Fast + Quiet needs barrel accuracy, not strength;
                    Slow + Loud is an efficient mover whose ceiling is physical; Developing needs the weight
                    room and the tee. Each hitter's card below carries a Swing build section with the
                    TrackMan x Blast points.
                  </p>
                </div>
              )}
              {hitters.map(p => (
                <DevPlayerRow key={p.player + (selHitter === p.player ? '-open' : '')}
                  p={p} hd={hdByName[p.player]} initialOpen={selHitter === p.player} />
              ))}
              {extraHd.map(h => (
                <DevPlayerRow key={h.batter + (selHitter === h.batter ? '-open' : '')}
                  p={{ player: h.batter, roles: ['hitter'], points: [] }}
                  hd={h} initialOpen={selHitter === h.batter} />
              ))}
            </div>
          )}
        </>
      )}

      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 px-1 pt-2">Auto-flags</div>
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

function ArsenalStatTable({ pitches, rvByType, grades, typeAvgs, slot, pitcher, team, onRetag }) {
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
      const las = ps.filter(p => p.exit_speed != null && p.launch_angle != null)
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
        gb: las.length >= 5 ? 100 * las.filter(p => p.launch_angle < 10).length / las.length : null,
      }
    }).sort((a, b) => b.n - a.n)
  }, [pitches])

  // "vs avg" deltas against same-hand corpus centroids for the type
  const Delta = ({ v, base }) => {
    if (v == null || base == null) return null
    const d = v - base
    if (Math.abs(d) < 0.05) return null
    return <span className={`ml-0.5 text-[9px] font-semibold ${Math.abs(d) >= 2 ? 'text-portal-purple dark:text-indigo-300' : 'text-gray-400'}`}
      title="vs the average pitch of this type from this handedness in your data">
      {d > 0 ? `+${d.toFixed(0)}` : d.toFixed(0)}
    </span>
  }
  const gradeCls = (v) => v == null ? 'text-gray-300' : v >= 110 ? 'text-[#d22d49]' : v <= 90 ? 'text-[#3661ad]' : ''

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 text-[11px] font-bold uppercase tracking-wide text-gray-400 flex items-center gap-2">
        <span>Pitch metrics (this view's filters applied)</span>
        {slot && <span className="normal-case tracking-normal font-normal"><SlotChip slot={slot} /></span>}
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
            <th className="px-4 py-1.5">Pitch</th>
            <th className="px-2 py-1.5 text-right"><StatTip k="stuff" group="pitching" label="Stuff" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="loc" group="pitching" label="Loc+" /></th>
            <th className="px-2 py-1.5 text-right">N</th>
            <th className="px-2 py-1.5 text-right"><StatTip k="usage_pct" group="pitching" label="Use%" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="velo" group="pitching" label="Velo" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="max_velo" group="pitching" label="Max" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="ivb" group="pitching" label="IVB" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="hb" group="pitching" label="HB" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="spin" group="pitching" label="Spin" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="extension" group="pitching" label="Ext" /></th>
            <th className="px-2 py-1.5 text-right" title="Vertical approach angle at the plate">VAA</th>
            <th className="px-2 py-1.5 text-right" title="Ground-ball share of batted balls against">GB%</th>
            <th className="px-2 py-1.5 text-right"><StatTip k="zone_pct" group="pitching" label="Zone%" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="shadow_pct" group="pitching" label="Shdw%" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="whiff_pct" group="pitching" label="Whiff%" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="chase_pct" group="pitching" label="Chase%" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="csw_pct" group="pitching" label="CSW%" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="ev_against" group="pitching" label="EV agn" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="rv" group="pitching" label="RV" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="rv100" group="pitching" label="RV/100" /></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
          {rows.map(r => (
            <tr key={r.t}>
              <td className="px-4 py-1.5 font-semibold whitespace-nowrap">
                <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: cFor(r.t) }} />
                {r.t}
                <ShapeChip note={grades?.[r.t]?.shape_note} suggest={grades?.[r.t]?.suggest} pitchType={r.t}
                  pitcher={pitcher} team={team} onDone={onRetag} />
              </td>
              <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${gradeCls(grades?.[r.t]?.stuff)}`}>{grades?.[r.t]?.stuff ?? '–'}</td>
              <td className={`px-2 py-1.5 text-right tabular-nums ${gradeCls(grades?.[r.t]?.loc)}`}>{grades?.[r.t]?.loc ?? '–'}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{r.n}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.usage)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{fmt(r.velo)}<Delta v={r.velo} base={typeAvgs?.[r.t]?.velo} /></td>
              <td className="px-2 py-1.5 text-right tabular-nums text-gray-400">{fmt(r.max)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.ivb)}<Delta v={r.ivb} base={typeAvgs?.[r.t]?.ivb} /></td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.hb)}<Delta v={r.hb} base={typeAvgs?.[r.t]?.hb} /></td>
              <td className="px-2 py-1.5 text-right tabular-nums">{r.spin ? Math.round(r.spin) : '–'}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.ext)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.vaa, 1)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.gb)}</td>
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

// ── Hitter Lab: inline splits (vs hand, vs pitch type) ───────────

// ── Effective-velocity bands ─────────────────────────────────────
// TrackMan's effective velo is release speed adjusted for how far up the
// ball is released, i.e. what it PLAYS like. That makes it the only fair
// velo read in BP, where a slow machine pulled way in front of the rubber
// plays like real heat.
const VBANDS = [['soft', 'Under 79'], ['avg', '79-84'], ['firm', '84-88'], ['elite', '88+']]
const VELO_TIP = "Effective velocity: release speed adjusted for release distance — what the pitch plays like to the hitter. In BP the machine sits well in front of the rubber, so a 57 mph feed can play like upper-80s."

// One hitter's velo profile: EV bars per band with whiff% underneath.
function VeloBandCard({ velo, title = 'Against effective velocity' }) {
  const bands = velo?.bands || {}
  const shown = VBANDS.filter(([k]) => bands[k]?.bbe >= 3 || bands[k]?.swings >= 5)
  if (!shown.length) return null
  const evs = shown.map(([k]) => bands[k].avg_ev).filter(v => v != null)
  const lo = Math.min(70, ...evs) - 2, hi = Math.max(...evs, 95) + 2
  const gap = velo.ev_gap
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
      <div className="flex items-baseline justify-between mb-2 flex-wrap gap-1">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400" title={VELO_TIP}>{title}</span>
        {gap != null && (
          <span className={`text-[11px] font-bold tabular-nums px-2 py-0.5 rounded-full ${
            gap >= 1 ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
              : gap <= -3 ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}
            title="Avg EV on 84+ mph minus avg EV under 84. Negative means contact quality falls off as the ball speeds up.">
            {gap > 0 ? `+${gap}` : gap} EV vs velo
          </span>
        )}
      </div>
      <div className="space-y-1.5">
        {shown.map(([k, label]) => {
          const b = bands[k]
          const pct = b.avg_ev != null ? Math.max(2, Math.min(100, ((b.avg_ev - lo) / (hi - lo)) * 100)) : 0
          return (
            <div key={k} className="flex items-center gap-2 text-[11px]">
              <span className="w-16 shrink-0 font-semibold text-gray-600 dark:text-gray-300">{label}</span>
              <div className="flex-1 h-4 rounded bg-gray-100 dark:bg-gray-900/50 relative overflow-hidden">
                {b.avg_ev != null && (
                  <div className="h-full rounded" style={{
                    width: `${pct}%`,
                    background: b.avg_ev >= 90 ? '#d22d49' : b.avg_ev >= 85 ? '#f59e0b' : '#3661ad',
                    opacity: 0.75,
                  }} />
                )}
                <span className="absolute inset-y-0 left-1.5 flex items-center text-[10px] font-bold text-gray-700 dark:text-gray-100">
                  {b.avg_ev != null ? `${b.avg_ev} EV` : `${b.pitches} seen`}
                </span>
              </div>
              <span className="w-12 text-right tabular-nums text-gray-400">{b.bbe ? `${b.bbe} bbe` : '–'}</span>
              <span className="w-16 text-right tabular-nums font-semibold text-gray-600 dark:text-gray-300">
                {b.whiff_pct != null ? `${b.whiff_pct}% wh` : ''}
              </span>
            </div>
          )
        })}
      </div>
      <p className="text-[10px] text-gray-400 mt-2 leading-snug">
        Bands are effective velo (what the pitch plays like, not the radar reading). Counts next to each
        bar are the sample behind it.
      </p>
    </div>
  )
}

// Team view: every hitter's EV (and whiff%) by band, worst velo-gap first.
function VeloBandBoard({ rows, isBp }) {
  const [sortKey, setSortKey] = useState('ev_gap')
  const list = useMemo(() => {
    const withV = (rows || []).filter(r => r.velo && Object.keys(r.velo.bands || {}).length)
    const val = r => sortKey === 'ev_gap' ? (r.velo.ev_gap ?? 999)
      : sortKey === 'whiff_gap' ? -(r.velo.whiff_gap ?? -999)
        : -(r.velo.bands?.[sortKey]?.avg_ev ?? -999)
    return [...withV].sort((a, b) => val(a) - val(b))
  }, [rows, sortKey])
  if (!list.length) return null
  const anyWhiff = list.some(r => r.velo.whiff_gap != null)
  const gapVals = list.map(r => r.velo.ev_gap).filter(v => v != null)
  const Th = ({ k, children, tip }) => (
    <th onClick={() => k && setSortKey(k)} title={tip}
      className={`px-2 py-2 text-right ${k ? 'cursor-pointer hover:text-portal-purple dark:hover:text-indigo-300' : ''} ${sortKey === k ? 'text-portal-purple dark:text-indigo-300' : ''}`}>
      {children}{sortKey === k ? ' ▾' : ''}
    </th>
  )
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between flex-wrap gap-1">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400" title={VELO_TIP}>
          Who hits velocity — contact quality by effective velo band
        </span>
        <span className="text-[10px] text-gray-400">click a column to sort · worst velo gap first</span>
      </div>
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
            <th className="px-4 py-2">Hitter</th>
            {VBANDS.map(([k, label]) => <Th key={k} k={k} tip={`Avg EV when the pitch plays ${label} mph`}>{label}</Th>)}
            <Th k="ev_gap" tip="Avg EV on 84+ minus avg EV under 84. Negative = contact quality falls off against velo.">EV Gap</Th>
            {anyWhiff && <Th k={null} tip="Whiff% on swings at 84+ mph">Whiff 84+</Th>}
            {anyWhiff && <Th k="whiff_gap" tip="Whiff% at 84+ minus whiff% under 84. Positive = swings and misses climb with velo.">Whiff Gap</Th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
          {list.map(r => {
            const v = r.velo
            return (
              <tr key={r.batter + r.team}>
                <td className="px-4 py-1.5 font-semibold whitespace-nowrap">
                  {r.batter}{r.side ? <span className="text-[10px] text-gray-400 ml-1">{r.side[0]}</span> : null}
                </td>
                {VBANDS.map(([k]) => {
                  const b = v.bands?.[k]
                  return (
                    <td key={k} className="px-2 py-1.5 text-right tabular-nums">
                      {b?.avg_ev != null ? (
                        <>
                          <span className="font-semibold">{b.avg_ev}</span>
                          <span className="text-[9px] text-gray-400 ml-1">{b.bbe}</span>
                        </>
                      ) : <span className="text-gray-300 dark:text-gray-600">–</span>}
                    </td>
                  )
                })}
                <HeatCell v={v.ev_gap} vals={gapVals} plus extra="font-bold" />
                {anyWhiff && <td className="px-2 py-1.5 text-right tabular-nums">{v.whiff_hard != null ? `${v.whiff_hard}%` : '–'}</td>}
                {anyWhiff && (
                  <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${
                    v.whiff_gap == null ? 'text-gray-300 dark:text-gray-600'
                      : v.whiff_gap >= 6 ? 'text-rose-600 dark:text-rose-400'
                        : v.whiff_gap <= -2 ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>
                    {v.whiff_gap == null ? '–' : v.whiff_gap > 0 ? `+${v.whiff_gap}` : v.whiff_gap}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="px-4 py-2 text-[10px] text-gray-400 leading-snug">
        Effective velo is what the pitch plays like after adjusting for release distance, so it is the
        honest velo read in BP{isBp ? ' — the machine sits well in front of the rubber, so a 57 mph feed plays like upper-80s' : ''}.
        Small numbers next to each EV are tracked balls in that band; weigh every band by that count,
        since a one-ball band is a single swing, not a skill.
      </p>
    </div>
  )
}

// Every column of the Hitting tab's board, for one hitter, live only.
// Shading compares him with every other hitter on the board (same filters).
function LiveBoardLine({ row, cohort, pool }) {
  const groups = [
    ['Decisions', ['pitches', 'swing_pct', 'zone_swing_pct', 'contact_pct', 'zone_contact_pct', 'ozone_contact_pct', 'chase_pct', 'fp_swing_pct', 'k2_contact_pct', 'k_pct', 'bb_pct']],
    ['Contact', ['bbe', 'avg_ev', 'p90_ev', 'max_ev', 'avg_la', 'hh_pct', 'barrel_pct', 'gb_pct', 'ld_pct', 'fb_pct', 'airpull_pct', 'depth']],
    ['Value', ['xavg', 'xslg', 'xwoba', 'xwobacon', 'rv', 'heart_rv', 'shadow_rv', 'chase_rv', 'transfer']],
  ]
  const defs = Object.fromEntries(HB_FULL.map(d => [d[1], d]))
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Live numbers — the full Hitting board line</span>
        <span className="text-[10px] text-gray-400">games + scrimmages + intrasquads · this view's hand and date filters · shading vs the {pool} hitters on the board</span>
      </div>
      <div className="px-4 py-2 space-y-2">
        {groups.map(([g, keys]) => (
          <div key={g} className="flex items-stretch gap-0">
            <div className="w-16 shrink-0 text-[9.5px] font-bold uppercase tracking-wide text-gray-400 self-center">{g}</div>
            <table className="text-[12.5px]"><tbody>
              <tr className="text-[9.5px] uppercase tracking-wide text-gray-400">
                {keys.map(k => defs[k] && (
                  <th key={k} className="px-1.5 pb-0.5 text-right font-semibold whitespace-nowrap">
                    <StatTip k={k} group="hitting" label={defs[k][0]} fallback={defs[k][2]}
                      avg={cohort[k]?.length ? cohort[k].reduce((a, v) => a + v, 0) / cohort[k].length : null} n={cohort[k]?.length} />
                  </th>
                ))}
              </tr>
              <tr>
                {keys.map(k => {
                  const d = defs[k]
                  if (!d) return null
                  const opts = d[3] || {}
                  if (opts.kind === 'depth') return (
                    <td key={k} className={`px-1.5 py-1 text-right tabular-nums ${DEPTH_CLS[depthTone(row[k])] || ''}`}>{row[k] != null ? row[k].toFixed(2) : '–'}</td>
                  )
                  if (opts.plain) return <td key={k} className="px-1.5 py-1 text-right tabular-nums text-gray-500">{row[k] != null ? Number(row[k]).toFixed(opts.dec ?? 1) : '–'}</td>
                  return <HeatCell key={k} v={row[k]} vals={cohort[k]} higher={opts.higher !== false} dec={opts.dec ?? 1} plus={!!opts.plus} extra="font-semibold" />
                })}
              </tr>
            </tbody></table>
          </div>
        ))}
      </div>
    </div>
  )
}

// Results vs each pitch type in live pitching: the box line of the plate
// appearances that ENDED on that pitch, beside the process rates on every
// pitch of that type he saw.
function ResultsByPitchCard({ results }) {
  const rows = Object.entries(results || {})
  if (!rows.length) return null
  const grab = f => rows.map(([, s]) => f(s)).filter(v => v != null).map(Number)
  const cohort = { avg: grab(s => s.line?.avg), slg: grab(s => s.line?.slg), woba: grab(s => s.line?.woba), xw: grab(s => s.xwobacon),
                   whiff: grab(s => s.whiff_pct), chase: grab(s => s.chase_pct), ev: grab(s => s.avg_ev), hh: grab(s => s.hard_hit_pct), rv: grab(s => s.rv) }
  const f3 = v => v == null ? '–' : Number(v).toFixed(3).replace(/^0\./, '.')
  const n = v => v == null ? '–' : v
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Results vs pitch type — live pitching</span>
        <span className="text-[10px] text-gray-400">a PA counts on the pitch that ended it · 5+ seen · shading compares the pitch types</span>
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
            <th className="px-4 py-1.5">Pitch</th>
            <th className="px-2 py-1.5 text-right">Seen</th><th className="px-2 py-1.5 text-right">PA</th><th className="px-2 py-1.5 text-right">AB</th>
            <th className="px-2 py-1.5 text-right">H</th><th className="px-2 py-1.5 text-right">2B</th><th className="px-2 py-1.5 text-right">3B</th>
            <th className="px-2 py-1.5 text-right">HR</th><th className="px-2 py-1.5 text-right">BB</th><th className="px-2 py-1.5 text-right">K</th>
            <th className="px-2 py-1.5 text-right">AVG</th><th className="px-2 py-1.5 text-right">SLG</th><th className="px-2 py-1.5 text-right">wOBA</th>
            <th className="px-2 py-1.5 text-right" title="Expected wOBA on contact">xwOBAcon</th>
            <th className="px-2 py-1.5 text-right"><StatTip k="whiff_pct" group="hitting" label="Whiff%" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="chase_pct" group="hitting" label="Chase%" /></th>
            <th className="px-2 py-1.5 text-right">EV</th><th className="px-2 py-1.5 text-right">HH%</th>
            <th className="px-2 py-1.5 text-right"><StatTip k="rv" group="hitting" label="RV" /></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
          {rows.map(([t, s]) => {
            const l = s.line || {}
            return (
              <tr key={t}>
                <td className="px-4 py-1.5 font-semibold whitespace-nowrap">
                  <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: cFor(t) }} />vs {t}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{s.pitches}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{n(l.pa)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{n(l.ab)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{n(l.h)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{n(l.d2)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{n(l.d3)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{n(l.hr)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{n(l.bb)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{n(l.k)}</td>
                <HeatCell v={l.avg} vals={cohort.avg} dec={3} extra="font-semibold" />
                <HeatCell v={l.slg} vals={cohort.slg} dec={3} />
                <HeatCell v={l.woba} vals={cohort.woba} dec={3} extra="font-semibold" />
                <HeatCell v={s.xwobacon} vals={cohort.xw} dec={3} />
                <HeatCell v={s.whiff_pct} vals={cohort.whiff} higher={false} />
                <HeatCell v={s.chase_pct} vals={cohort.chase} higher={false} />
                <HeatCell v={s.avg_ev} vals={cohort.ev} />
                <HeatCell v={s.hard_hit_pct} vals={cohort.hh} />
                <HeatCell v={s.rv} vals={cohort.rv} plus extra="font-semibold" />
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SplitsCard({ splits }) {
  const hand = splits?.hand || {}
  const types = splits?.pitch_type || {}
  const rows = [
    ...(hand.L ? [['vs LHP', hand.L, null]] : []),
    ...(hand.R ? [['vs RHP', hand.R, null]] : []),
    ...Object.entries(types).map(([t, s]) => [`vs ${t}`, s, t]),
  ]
  if (rows.length < 2) return null
  const grab = k => rows.map(([, s]) => s[k]).filter(v => v != null).map(Number)
  const cohort = { swing: grab('swing_pct'), whiff: grab('whiff_pct'), chase: grab('chase_pct'),
                   ev: grab('avg_ev'), hh: grab('hard_hit_pct'), xw: grab('xwobacon'), rv: grab('rv') }
  const handRows = rows.filter(([, , t]) => t === null)
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Splits — by hand and by pitch seen</span>
        <span className="text-[10px] text-gray-400">this view's filters applied · pitch types need 10+ seen · shading compares the rows shown</span>
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
            <th className="px-4 py-1.5">Split</th>
            <th className="px-2 py-1.5 text-right">Seen</th>
            <th className="px-2 py-1.5 text-right">Swing%</th>
            <th className="px-2 py-1.5 text-right"><StatTip k="whiff_pct" group="hitting" label="Whiff%" /></th>
            <th className="px-2 py-1.5 text-right"><StatTip k="chase_pct" group="hitting" label="Chase%" /></th>
            <th className="px-2 py-1.5 text-right">BBE</th>
            <th className="px-2 py-1.5 text-right">EV</th>
            <th className="px-2 py-1.5 text-right">HH%</th>
            <th className="px-2 py-1.5 text-right" title="Expected wOBA on contact from EV + launch + spray, college-calibrated">xwOBAcon</th>
            <th className="px-2 py-1.5 text-right"><StatTip k="rv" group="hitting" label="RV" /></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
          {rows.map(([label, s, t], i) => (
            <tr key={label} className={t !== null && i === handRows.length ? 'border-t-2 border-gray-200 dark:border-gray-600' : ''}>
              <td className="px-4 py-1.5 font-semibold whitespace-nowrap">
                {t !== null && <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: cFor(t) }} />}
                {label}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{s.pitches}</td>
              <HeatCell v={s.swing_pct} vals={cohort.swing} />
              <HeatCell v={s.whiff_pct} vals={cohort.whiff} higher={false} />
              <HeatCell v={s.chase_pct} vals={cohort.chase} higher={false} />
              <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{s.bbe}</td>
              <HeatCell v={s.avg_ev} vals={cohort.ev} />
              <HeatCell v={s.hard_hit_pct} vals={cohort.hh} />
              <HeatCell v={s.xwobacon} vals={cohort.xw} dec={3} />
              <HeatCell v={s.rv} vals={cohort.rv} plus extra="font-semibold" />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Contact-depth damage window, MEASURED on this corpus (2,197 tracked
// contacts): EV/xwOBAcon peak at 1.5-2.5 ft (82.6 EV, .35-.42 xwOBAcon),
// collapse when jammed (<=0.5 ft: 76-78 EV, .23) or way out front
// (3.5 ft: 71 EV). Green = the window, amber = fringe, red = outside.
const DEPTH_LO = 1.3, DEPTH_HI = 2.7, DEPTH_FRINGE = 0.5
function depthTone(v) {
  if (v == null) return null
  if (v >= DEPTH_LO && v <= DEPTH_HI) return 'good'
  if (v >= DEPTH_LO - DEPTH_FRINGE && v <= DEPTH_HI + DEPTH_FRINGE) return 'mid'
  return 'bad'
}
const DEPTH_CLS = {
  good: 'text-emerald-600 dark:text-emerald-400 font-semibold',
  mid: 'text-amber-600 dark:text-amber-400',
  bad: 'text-rose-600 dark:text-rose-400 font-semibold',
}
const DEPTH_TIP = 'Measured on this corpus: damage peaks at 1.3-2.7 ft of depth (EV 82+, xwOBAcon .35-.42); under ~1 ft is jammed, past ~3 ft is off the end'

// ── Hitter Lab: point of contact (depth out front vs deep) ───────
// TrackMan ContactPosition frame: X = depth toward the pitcher in feet
// (0 = the back point of home plate, ~1.4 = the front edge), Y = height.
// Physics check on this corpus: pulled air averages ~2.1 ft out front,
// oppo air ~1.0 ft (over the plate) — the textbook timing relationship.
function ContactPointCard({ pitches }) {
  const { wrapRef, hover, onMove, onLeave } = useDotHover()
  const pts = (pitches || []).filter(p => p.contact_x != null && p.exit_speed != null)
  if (pts.length < 5) return null
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null
  const depth = avg(pts.map(p => p.contact_x))
  const hh = pts.filter(p => p.exit_speed >= 90)
  const hhDepth = hh.length >= 3 ? avg(hh.map(p => p.contact_x)) : null
  const pullSign = p => (p.direction != null && p.batter_side)
    ? p.direction * (p.batter_side === 'Left' ? 1 : -1) : null
  const pullAir = pts.filter(p => p.launch_angle >= 10 && pullSign(p) >= 10)
  const oppoAir = pts.filter(p => p.launch_angle >= 10 && pullSign(p) <= -10)
  const byType = {}
  pts.forEach(p => { if (p.ptype && p.ptype !== 'Mistag') (byType[p.ptype] = byType[p.ptype] || []).push(p.contact_x) })
  const typeRows = Object.entries(byType).filter(([, v]) => v.length >= 5)
    .map(([t, v]) => [t, avg(v), v.length]).sort((a, b) => b[2] - a[2]).slice(0, 5)

  // side-view scatter: depth (x) vs contact height (y)
  const W = 320, H = 200, L = 30, R = 10, T = 10, B = 26
  const xLo = -0.5, xHi = 4.5, yLo = 0.5, yHi = 4.5
  const X = v => L + (Math.max(xLo, Math.min(xHi, v)) - xLo) / (xHi - xLo) * (W - L - R)
  const Y = v => T + (yHi - Math.max(yLo, Math.min(yHi, v))) / (yHi - yLo) * (H - T - B)
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Point of contact — depth and height</span>
        <span className="text-[10px] text-gray-400 tabular-nums">{pts.length} tracked</span>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        {[
          ['Avg depth', depth, 'Average contact depth in feet toward the pitcher; 0 = back of the plate, 1.4 = front edge, bigger = further out front'],
          ['On hard contact', hhDepth, 'Average depth on 90+ mph contact — where his best swings meet the ball'],
          ['Pulled air', pullAir.length >= 3 ? avg(pullAir.map(p => p.contact_x)) : null, 'Depth on pulled balls in the air — pull power lives out front'],
          ['Oppo air', oppoAir.length >= 3 ? avg(oppoAir.map(p => p.contact_x)) : null, 'Depth on opposite-field air — letting it travel'],
        ].map(([lab, v, tip]) => (
          <div key={lab} className="rounded-lg bg-gray-50 dark:bg-gray-900/40 px-2.5 py-1.5"
            title={`${tip}. ${DEPTH_TIP}`}>
            <div className="text-[9px] font-bold uppercase tracking-wider text-gray-400">{lab}</div>
            <div className={`text-[15px] font-bold tabular-nums ${DEPTH_CLS[depthTone(v)] || 'text-gray-900 dark:text-gray-100'}`}
              {...toneAttr(depthTone(v) === 'good' ? 80 : depthTone(v) === 'bad' ? 20 : 50)}>
              {v == null ? '–' : `${v.toFixed(2)} ft`}
            </div>
          </div>
        ))}
      </div>
      <div ref={wrapRef} className="relative">
      <PitchHoverCard hover={hover} />
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {/* measured damage window (1.3-2.7 ft) */}
        <rect x={X(DEPTH_LO)} y={T} width={X(DEPTH_HI) - X(DEPTH_LO)} height={H - T - B}
          fill="#059669" opacity="0.08" />
        <text x={(X(DEPTH_LO) + X(DEPTH_HI)) / 2} y={T + 9} fontSize="7.5" textAnchor="middle"
          fill="#059669">damage window</text>
        {/* home plate slab, side view (0 to 1.42 ft deep, on the ground line) */}
        <rect x={X(0)} y={H - B - 5} width={X(1.42) - X(0)} height={5} rx="1.5"
          fill="currentColor" className="text-gray-300 dark:text-gray-500" />
        <text x={(X(0) + X(1.42)) / 2} y={H - B + 10} fontSize="7.5" textAnchor="middle" fill="#9ca3af">plate</text>
        <line x1={X(1.42)} y1={T} x2={X(1.42)} y2={H - B} stroke="currentColor"
          strokeDasharray="4 3" className="text-gray-300 dark:text-gray-600" />
        <text x={X(1.42) + 3} y={T + 8} fontSize="7.5" fill="#9ca3af">front edge</text>
        <text x={X(3.2)} y={H - B + 18} fontSize="8" textAnchor="middle" fill="#9ca3af">→ out front (toward pitcher)</text>
        {[1, 2, 3, 4].map(v => (
          <text key={v} x={L - 4} y={Y(v) + 3} fontSize="8" textAnchor="end" fill="#9ca3af">{v}'</text>
        ))}
        {pts.map((p, i) => (
          <circle key={i} cx={X(p.contact_x)} cy={Y(p.contact_y ?? 2.5)} r={hover?.p === p ? 4.5 : 3}
            fill={p.exit_speed >= 95 ? '#d22d49' : p.exit_speed >= 85 ? '#f59e0b' : '#3661ad'} opacity={hover?.p === p ? 1 : 0.6}
            className="cursor-pointer" onMouseMove={onMove(p)} onMouseLeave={onLeave} />
        ))}
      </svg>
      </div>
      {typeRows.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {typeRows.map(([t, v, n]) => (
            <span key={t} className="text-[11px] rounded-md bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-700 px-2 py-0.5 text-gray-500 dark:text-gray-400"
              title={`Average contact depth vs the ${t.toLowerCase()} (${n} tracked). ${DEPTH_TIP}`}>
              <span className="inline-block w-1.5 h-1.5 rounded-full mr-1" style={{ background: cFor(t) }} />
              {t} <b className={`tabular-nums ${DEPTH_CLS[depthTone(v)] || 'text-gray-900 dark:text-gray-100'}`}>{v.toFixed(2)} ft</b>
            </span>
          ))}
        </div>
      )}
      <p className="text-[10px] text-gray-400 mt-1.5 leading-snug">
        Side view: how far out front (horizontal) and how high (vertical) he meets the ball, colored by EV.
        Deep contact on offspeed with weak EV = getting fooled; everything out front with rollover grounders =
        cheating early. The per-pitch chips show timing by pitch type.
      </p>
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

function DefenseTab({ teamCtx, season }) {
  const exportRef = useRef(null)
  const [team, setTeam] = useState(teamCtx.primary)
  const [context, setContext] = useState('all')
  const [rankPos, setRankPos] = useState('SS')
  const { data, loading } = useApi('/trackman/defense',
    { context, ...(team ? { team } : {}), season }, [context, team])
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
              <th className="px-2 py-2 text-right"><StatTip k="oae" group="defense" label="OAE" /></th>
              <th className="px-2 py-2 text-right"><StatTip k="conv_pct" group="defense" label="Conv%" /></th>
              <th className="px-2 py-2 text-right"><StatTip k="x_conv_pct" group="defense" label="xConv%" /></th>
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
          <ReportActions csv targetRef={exportRef} filename="trackman_defense" />
          <select value={context} onChange={e => setContext(e.target.value)}
            className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1 text-xs">
            {DEF_CONTEXTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
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
                    <th className="px-2 py-2 text-right"><StatTip k="opps" group="defense" label="Chances" /></th>
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

function ValuesTab({ teamCtx, season }) {
  const exportRef = useRef(null)
  const [team, setTeam] = useState(teamCtx.primary)
  const [posAdj, setPosAdj] = useState(false)
  const [shrink, setShrink] = useState(false)
  const [context, setContext] = useState('all')
  const { data, loading } = useApi('/trackman/values',
    { ...(team ? { team } : {}), pos_adj: posAdj, shrink, season, context },
    [team, posAdj, shrink, context])
  const seasonOnly = context !== 'all' && context !== 'game'

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
        <div className="text-[11px] text-gray-400 max-w-xl">
          Every column is average-relative: 0 = an average player in the division. Season stats + tracked
          data combined. Rough rule: about 10 runs = 1 win.
          {seasonOnly && (
            <span className="block mt-0.5 text-amber-600 dark:text-amber-400">
              Offense, baserunning and pitching come from official season stats, so they stay blank in a
              scrimmage or intrasquad view. Fielding and catching are tracked, so they follow this filter.
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {DEF_CONTEXTS.map(([k, label]) => (
            <button key={k} onClick={() => setContext(k)}
              className={`px-2.5 py-1 rounded-full text-[12px] font-semibold ${
                context === k ? 'bg-portal-purple text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`}>
              {label}
            </button>
          ))}
          <ReportActions csv targetRef={exportRef} filename="trackman_values" />
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
                  <th key={k} className="px-2 py-2 text-right">
                    <StatTip k={k} group="values" label={label} fallback={tip} />
                  </th>
                ))}
                <th className="px-2 py-2 text-right"><StatTip k="tracked_rv" group="values" label="RV (trk)" /></th>
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

// ══════════════════════════════════════════════════════════════════
// Custom Reporting — build-your-own player reports, export PDF / PNG
// ══════════════════════════════════════════════════════════════════
// Pick WHO (any set of pitchers or hitters), WHAT DATA (session types x
// season / last N outings / date range / hand-picked days, vs-hand), WHICH
// BLOCKS (tables, plots, sprays, maps — ordered however you like, down to
// the individual numbers and arsenal columns) and type NOTES. Every player
// becomes one report; export all of them as a paged PDF or one PNG each.
// Layouts save as named presets in this browser.
const CR_STORE = 'tmCustomReport.v1'
const CR_PRESETS = 'tmCustomReportPresets.v1'
const CR_TYPES = {
  pitcher: [['game', 'Games'], ['scrimmage', 'Scrimmages'], ['intrasquad', 'Intrasquads'], ['bullpen', 'Bullpens']],
  hitter: [['game', 'Games'], ['scrimmage', 'Scrimmages'], ['intrasquad', 'Intrasquads'], ['bp', 'BP']],
}
// [id, label, half-width?, hint]
const CR_BLOCKS = {
  pitcher: [
    ['keystats', 'Key numbers', false, 'The handful of numbers you pick, as big tiles'],
    ['notes', 'Coach notes', false, 'Your typed notes (report-wide + per player)'],
    ['arsenal', 'Arsenal table', false, 'Per pitch type; choose the columns'],
    ['line', 'Box line', false, 'IP, K, BB, WHIP, FIP (live sessions only)'],
    ['percentiles', 'Percentile bars', false, 'Ranked against the whole staff'],
    ['plotsnotes', 'Small plots + big notes', false, 'Movement and release shrunk to one row beside a large notes box'],
    ['movement', 'Movement plot', true, 'IVB x HB, catcher view'],
    ['release', 'Release point', true, ''],
    ['locations', 'Locations by pitch', false, 'K-zone heatmap per pitch type'],
    ['locspray', 'Locations + opposing spray', false, 'Up to 5 pitch-type heatmaps with the spray chart of contact allowed beside them'],
    ['oppspray', 'Opposing spray chart', true, 'Where the balls in play against him went, colored by EV'],
    ['zonemaps', 'Zone maps', false, 'Whiffs, damage and usage by location'],
    ['countusage', 'Pitch mix by count', true, ''],
    ['countlev', 'Count leverage', false, 'First-pitch strike, putaway, CSW ahead/behind'],
    ['countstates', 'Count states', false, 'Ahead / even / behind / 2 strikes, every number'],
    ['velotrend', 'Velocity by session', true, ''],
    ['sessiontrend', 'Session trend', true, 'Stuff+, RV/100, FB velo over time'],
    ['arm', 'Arm / release profile', true, ''],
    ['tunneling', 'Tunneling', true, ''],
    ['sequencing', 'Two-pitch sequences', false, ''],
  ],
  hitter: [
    ['keystats', 'Key numbers', false, 'The handful of numbers you pick, as big tiles'],
    ['notes', 'Coach notes', false, 'Your typed notes (report-wide + per player)'],
    ['line', 'Box line', false, 'AVG / OBP / SLG / wRC+ (live sessions only)'],
    ['percentiles', 'Percentile bars', false, 'Ranked against the whole lineup'],
    ['xstats', 'Expected stats', false, 'xAVG, xSLG, xwOBA vs actual'],
    ['spray', 'Spray chart', true, 'Colored by exit velo'],
    ['contact', 'Point of contact', true, 'Depth and height (needs 5+ tracked)'],
    ['evla', 'EV x launch angle', true, ''],
    ['swingtake', 'Swing / take value', true, ''],
    ['zonemaps', 'Zone maps', false, 'Swings, whiffs, damage, hard contact, takes'],
    ['splits', 'Splits', false, 'By pitcher hand and pitch type'],
    ['velobands', 'Against velocity', false, 'Effective velo bands'],
    ['countlev', 'Count leverage', false, ''],
    ['countstates', 'Count states', false, 'Ahead / even / behind / 2 strikes, every number'],
    ['sessiontrend', 'Session trend', true, 'Contact quality over time'],
    ['battedballs', 'Batted ball log', false, 'Every tracked ball in the sample'],
  ],
}
const CR_KEYSTATS = {
  pitcher: [['pitches', 'Pitches', 0], ['fb_velo', 'FB velo', 1], ['fb_max', 'FB max', 1], ['stuff', 'Stuff+', 0], ['loc', 'Loc+', 0],
    ['strike_pct', 'Strike%', 1], ['zone_pct', 'Zone%', 1], ['whiff_pct', 'Whiff%', 1], ['chase_pct', 'Chase%', 1], ['csw_pct', 'CSW%', 1],
    ['ev_against', 'EV against', 1], ['hh_pct', 'Hard-hit% agn', 1], ['gb_pct', 'GB% agn', 1], ['rv', 'Run value', 1],
    ['ip_str', 'IP', null], ['bf', 'BF', 0], ['k', 'K', 0], ['bb', 'BB', 0], ['h', 'H', 0], ['r', 'R', 0],
    ['k_pct', 'K%', 1], ['bb_pct', 'BB%', 1], ['whip', 'WHIP', 2], ['baa', 'BAA', 3], ['fip', 'FIP', 2]],
  hitter: [['pitches', 'Pitches seen', 0], ['bbe', 'Batted balls', 0], ['avg_ev', 'Avg EV', 1], ['p90_ev', '90th EV', 1], ['max_ev', 'Max EV', 1],
    ['hh_pct', 'Hard-hit%', 1], ['barrel_pct', 'Barrel%', 1], ['sweet_pct', 'Sweet-spot%', 1], ['avg_la', 'Avg LA', 1], ['max_dist', 'Max dist', 0],
    ['swing_pct', 'Swing%', 1], ['contact_pct', 'Contact%', 1], ['zcontact_pct', 'Z-Contact%', 1], ['whiff_pct', 'Whiff%', 1], ['chase_pct', 'Chase%', 1],
    ['xavg', 'xAVG', 3], ['xslg', 'xSLG', 3], ['xwoba', 'xwOBA', 3],
    ['pa', 'PA', 0], ['avg', 'AVG', 3], ['obp', 'OBP', 3], ['slg', 'SLG', 3], ['ops', 'OPS', 3], ['hr', 'HR', 0], ['bb', 'BB', 0], ['k', 'K', 0],
    ['woba', 'wOBA', 3], ['wrc_plus', 'wRC+', 0]],
}
const CR_ARSENAL_COLS = [['n', 'N', 0], ['usage', 'Use%', 1], ['stuff', 'Stuff+', 0], ['loc', 'Loc+', 0], ['velo', 'Velo', 1], ['max', 'Max', 1],
  ['ivb', 'IVB', 1], ['hb', 'HB', 1], ['spin', 'Spin', 0], ['ext', 'Ext', 1], ['vaa', 'VAA', 1], ['zone', 'Zone%', 1], ['whiff', 'Whiff%', 1],
  ['chase', 'Chase%', 1], ['csw', 'CSW%', 1], ['ev', 'EV agn', 1], ['gb', 'GB%', 1], ['rv', 'RV', 1], ['rv100', 'RV/100', 2]]
const CR_DEFAULT = {
  role: 'pitcher', players: [], hand: '',
  types: { game: true, scrimmage: true, intrasquad: true, bp: false, bullpen: false },
  range: 'season', lastN: 2, dates: {}, picked: [],
  blocks: { pitcher: ['keystats', 'arsenal', 'movement', 'release', 'locations', 'notes'],
            hitter: ['keystats', 'line', 'spray', 'contact', 'zonemaps', 'notes'] },
  keyStats: { pitcher: ['pitches', 'fb_velo', 'fb_max', 'stuff', 'strike_pct', 'whiff_pct', 'csw_pct', 'ev_against'],
              hitter: ['pitches', 'bbe', 'avg_ev', 'max_ev', 'hh_pct', 'barrel_pct', 'chase_pct', 'contact_pct'] },
  arsenalCols: ['n', 'usage', 'stuff', 'velo', 'max', 'ivb', 'hb', 'spin', 'zone', 'whiff', 'csw', 'ev'],
  title: 'Player Report', notes: '', playerNotes: {}, showScope: true,
}
// Starter layouts (role + scope + blocks); players and notes stay yours.
const CR_STARTERS = [
  ['Post-game recap · pitcher', { role: 'pitcher', title: 'Post-Game Recap', range: 'lastN', lastN: 1,
    types: { game: true, scrimmage: true, intrasquad: true, bullpen: false, bp: false },
    // Nate's own layout (2026-09-19 Butcher report), with the plots shrunk into
    // one row so the notes box gets half the page
    blocks: ['keystats', 'line', 'arsenal', 'plotsnotes', 'locspray'],
    keyStats: ['pitches', 'fb_velo', 'fb_max', 'stuff', 'strike_pct', 'whiff_pct', 'csw_pct', 'ev_against', 'loc', 'zone_pct', 'chase_pct', 'rv'],
    arsenalCols: ['n', 'usage', 'stuff', 'loc', 'velo', 'max', 'ivb', 'hb', 'spin', 'ext', 'vaa', 'zone', 'whiff', 'chase', 'csw', 'ev', 'rv'] }],
  ['Post-game recap · hitter', { role: 'hitter', title: 'Post-Game Recap', range: 'lastN', lastN: 1,
    types: { game: true, scrimmage: true, intrasquad: true, bp: false, bullpen: false },
    blocks: ['keystats', 'notes', 'line', 'battedballs', 'spray', 'evla', 'countstates'],
    keyStats: ['pa', 'avg', 'ops', 'hr', 'bb', 'k', 'bbe', 'avg_ev', 'max_ev', 'hh_pct', 'contact_pct', 'chase_pct'] }],
  ['Pitcher · last outing quick sheet', { role: 'pitcher', range: 'lastN', lastN: 1, types: { game: true, scrimmage: true, intrasquad: true, bullpen: false, bp: false },
    blocks: ['keystats', 'arsenal', 'movement', 'locations', 'notes'] }],
  ['Pitcher · full season profile', { role: 'pitcher', range: 'season', types: { game: true, scrimmage: true, intrasquad: true, bullpen: false, bp: false },
    blocks: ['keystats', 'line', 'percentiles', 'arsenal', 'movement', 'release', 'locations', 'zonemaps', 'countusage', 'countlev', 'velotrend', 'sessiontrend', 'sequencing', 'notes'] }],
  ['Pitcher · bullpen design sheet', { role: 'pitcher', range: 'lastN', lastN: 1, types: { game: false, scrimmage: false, intrasquad: false, bullpen: true, bp: false },
    blocks: ['keystats', 'arsenal', 'movement', 'release', 'arm', 'tunneling', 'notes'],
    keyStats: ['pitches', 'fb_velo', 'fb_max', 'stuff', 'zone_pct'], arsenalCols: ['n', 'usage', 'stuff', 'velo', 'max', 'ivb', 'hb', 'spin', 'ext', 'vaa', 'zone'] }],
  ['Hitter · last 2 games', { role: 'hitter', range: 'lastN', lastN: 2, types: { game: true, scrimmage: true, intrasquad: true, bp: false, bullpen: false },
    blocks: ['keystats', 'line', 'spray', 'contact', 'battedballs', 'notes'] }],
  ['Hitter · BP report', { role: 'hitter', range: 'lastN', lastN: 1, types: { game: false, scrimmage: false, intrasquad: false, bp: true, bullpen: false },
    blocks: ['keystats', 'spray', 'evla', 'contact', 'battedballs', 'notes'],
    keyStats: ['bbe', 'avg_ev', 'p90_ev', 'max_ev', 'hh_pct', 'barrel_pct', 'sweet_pct', 'avg_la', 'max_dist'] }],
  ['Hitter · full season profile', { role: 'hitter', range: 'season', types: { game: true, scrimmage: true, intrasquad: true, bp: false, bullpen: false },
    blocks: ['keystats', 'line', 'percentiles', 'xstats', 'spray', 'contact', 'zonemaps', 'swingtake', 'sessiontrend', 'splits', 'velobands', 'countlev', 'notes'] }],
]

const crLoad = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fb } catch { return fb } }
const crSave = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } }
const crFair = (p) => p.exit_speed != null && (p.pitch_call === 'InPlay' || (p.pitch_call == null && (p.direction == null || Math.abs(p.direction) <= 45)))
const crPct = (n, d) => d ? 100 * n / d : null
const crAvg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null
const crFmt = (v, dec) => v == null ? '–' : dec == null ? String(v) : dec === 3 ? Number(v).toFixed(3).replace(/^0\./, '.') : Number(v).toFixed(dec)

// Session ids for one player under the current scope.
function crScopeIds(player, sessions, cfg, season) {
  const mine = sessions.filter(s => player.sessions[s.id] && cfg.types[s.session_type])   // newest first
  if (cfg.range === 'lastN') return mine.slice(0, Math.max(1, cfg.lastN || 1)).map(s => s.id)
  if (cfg.range === 'pick') return mine.filter(s => cfg.picked.includes(s.id)).map(s => s.id)
  if (cfg.range === 'dates') {
    return mine.filter(s => (!cfg.dates?.from || s.session_date >= cfg.dates.from) && (!cfg.dates?.to || s.session_date <= cfg.dates.to)).map(s => s.id)
  }
  return mine.filter(s => season == null || seasonOf(s.session_date) === season).map(s => s.id)
}

function crPitcherStats(data) {
  const ps = data.pitches || []
  const called = ps.filter(p => p.pitch_call)
  const sw = ps.filter(p => p.is_swing), oz = ps.filter(p => p.is_in_zone === false), zoned = ps.filter(p => p.is_in_zone != null)
  const fb = ps.filter(p => ['Fastball', 'Sinker', 'Cutter'].includes(p.ptype) && p.rel_speed != null).map(p => p.rel_speed)
  const bbe = ps.filter(crFair), la = bbe.filter(p => p.launch_angle != null)
  const strikes = called.filter(p => ['StrikeCalled', 'StrikeSwinging', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(p.pitch_call))
  const byType = {}
  ps.forEach(p => { byType[p.ptype] = (byType[p.ptype] || 0) + 1 })
  const wavg = (k) => {
    let num = 0, den = 0
    Object.entries(data.grades || {}).forEach(([t, g]) => { if (g?.[k] != null && byType[t]) { num += g[k] * byType[t]; den += byType[t] } })
    return den ? num / den : null
  }
  const rvs = Object.values(data.rv_by_type || {}).map(x => x.rv).filter(v => v != null)
  return {
    pitches: ps.length, fb_velo: crAvg(fb), fb_max: fb.length ? Math.max(...fb) : null, stuff: wavg('stuff'), loc: wavg('loc'),
    strike_pct: crPct(strikes.length, called.length), zone_pct: crPct(zoned.filter(p => p.is_in_zone).length, zoned.length),
    whiff_pct: crPct(sw.filter(p => p.is_whiff).length, sw.length), chase_pct: crPct(oz.filter(p => p.is_chase).length, oz.length),
    csw_pct: crPct(called.filter(p => p.pitch_call === 'StrikeCalled' || p.pitch_call === 'StrikeSwinging').length, called.length),
    ev_against: crAvg(bbe.map(p => p.exit_speed)), hh_pct: crPct(bbe.filter(p => p.exit_speed >= 90).length, bbe.length),
    gb_pct: crPct(la.filter(p => p.launch_angle < 10).length, la.length), rv: rvs.length ? rvs.reduce((a, b) => a + b, 0) : null,
    ...(data.line || {}),
  }
}

function crHitterStats(data) {
  const ps = data.pitches || []
  const called = ps.filter(p => p.pitch_call)
  const sw = called.filter(p => p.is_swing), oz = called.filter(p => p.is_in_zone === false), zsw = sw.filter(p => p.is_in_zone)
  const bbe = ps.filter(crFair), evs = bbe.map(p => p.exit_speed).sort((a, b) => a - b), la = bbe.filter(p => p.launch_angle != null)
  const dist = bbe.map(p => p.distance).filter(v => v != null)
  const x = data.xstats || {}
  return {
    pitches: ps.length, bbe: bbe.length, avg_ev: crAvg(evs), max_ev: evs.length ? evs[evs.length - 1] : null,
    p90_ev: evs.length >= 5 ? evs[Math.min(evs.length - 1, Math.floor(0.9 * evs.length))] : null,
    hh_pct: crPct(bbe.filter(p => p.exit_speed >= 90).length, bbe.length),
    barrel_pct: crPct(la.filter(p => p.exit_speed >= 95 && p.launch_angle >= 8 && p.launch_angle <= 32).length, la.length),
    sweet_pct: crPct(la.filter(p => p.launch_angle >= 8 && p.launch_angle <= 32).length, la.length),
    avg_la: crAvg(la.map(p => p.launch_angle)), max_dist: dist.length ? Math.max(...dist) : null,
    swing_pct: crPct(sw.length, called.length), contact_pct: crPct(sw.filter(p => !p.is_whiff).length, sw.length),
    zcontact_pct: crPct(zsw.filter(p => !p.is_whiff).length, zsw.length), whiff_pct: crPct(sw.filter(p => p.is_whiff).length, sw.length),
    chase_pct: crPct(oz.filter(p => p.is_chase ?? p.is_swing).length, oz.length),
    xavg: x.xavg, xslg: x.xslg, xwoba: x.xwoba,
    ...(data.line || {}),
  }
}

function CrCard({ title, sub, children }) {
  return (
    <div className="bg-white rounded-xl ring-1 ring-gray-200 p-4">
      {title && (
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">{title}</span>
          {sub && <span className="text-[10px] text-gray-400">{sub}</span>}
        </div>
      )}
      {children}
    </div>
  )
}

function CrArsenalTable({ data, cols }) {
  const rows = useMemo(() => {
    const g = {}
    ;(data.pitches || []).forEach(p => { (g[p.ptype] = g[p.ptype] || []).push(p) })
    const total = (data.pitches || []).length || 1
    const avg = (arr, k) => crAvg(arr.map(x => x[k]).filter(v => v != null))
    return Object.entries(g).map(([t, ps]) => {
      const called = ps.filter(p => p.pitch_call), sw = ps.filter(p => p.is_swing)
      const oz = ps.filter(p => p.is_in_zone === false), zoned = ps.filter(p => p.is_in_zone != null)
      const bbe = ps.filter(crFair), la = bbe.filter(p => p.launch_angle != null)
      const velos = ps.map(p => p.rel_speed).filter(v => v != null)
      return {
        t, n: ps.length, usage: 100 * ps.length / total, stuff: data.grades?.[t]?.stuff, loc: data.grades?.[t]?.loc,
        velo: crAvg(velos), max: velos.length ? Math.max(...velos) : null, ivb: avg(ps, 'ivb'), hb: avg(ps, 'horz_break'),
        spin: avg(ps, 'spin_rate'), ext: avg(ps, 'extension'), vaa: avg(ps, 'vaa'),
        zone: crPct(zoned.filter(p => p.is_in_zone).length, zoned.length), whiff: crPct(sw.filter(p => p.is_whiff).length, sw.length),
        chase: crPct(oz.filter(p => p.is_chase).length, oz.length),
        csw: crPct(called.filter(p => p.pitch_call === 'StrikeCalled' || p.pitch_call === 'StrikeSwinging').length, called.length),
        ev: crAvg(bbe.map(p => p.exit_speed)), gb: crPct(la.filter(p => p.launch_angle < 10).length, la.length),
        rv: data.rv_by_type?.[t]?.rv, rv100: data.rv_by_type?.[t]?.rv100,
      }
    }).sort((a, b) => b.n - a.n)
  }, [data])
  const show = CR_ARSENAL_COLS.filter(([k]) => cols.includes(k))
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
          <th className="py-1.5 pr-2">Pitch</th>
          {show.map(([k, l]) => <th key={k} className="px-1.5 py-1.5 text-right whitespace-nowrap">{l}</th>)}
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {rows.map(r => (
          <tr key={r.t}>
            <td className="py-1.5 pr-2 font-semibold whitespace-nowrap">
              <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: cFor(r.t) }} />{r.t}
            </td>
            {show.map(([k, , dec]) => (
              <td key={k} className={`px-1.5 py-1.5 text-right tabular-nums ${k === 'stuff' || k === 'loc'
                ? (r[k] == null ? 'text-gray-300' : r[k] >= 110 ? 'font-bold text-[#d22d49]' : r[k] <= 90 ? 'font-bold text-[#3661ad]' : 'font-bold') : ''}`}>
                {(k === 'rv' || k === 'rv100') && r[k] > 0 ? '+' : ''}{crFmt(r[k], dec)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function CrBattedBalls({ pitches }) {
  const rows = pitches.filter(crFair).slice(-40).reverse()
  if (!rows.length) return <div className="text-xs text-gray-400">No tracked batted balls in this sample.</div>
  return (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
          <th className="py-1">Date</th><th className="px-1.5 py-1 text-right">EV</th><th className="px-1.5 py-1 text-right">LA</th>
          <th className="px-1.5 py-1 text-right">Dist</th><th className="px-1.5 py-1">Result</th><th className="px-1.5 py-1">Off</th><th className="px-1.5 py-1">Pitcher</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {rows.map((p, i) => (
          <tr key={i}>
            <td className="py-1 tabular-nums text-gray-500">{p.session_date}</td>
            <td className={`px-1.5 py-1 text-right tabular-nums font-semibold ${p.exit_speed >= 95 ? 'text-[#d22d49]' : p.exit_speed < 80 ? 'text-[#3661ad]' : ''}`}>{crFmt(p.exit_speed, 1)}</td>
            <td className="px-1.5 py-1 text-right tabular-nums">{crFmt(p.launch_angle, 0)}</td>
            <td className="px-1.5 py-1 text-right tabular-nums">{crFmt(p.distance, 0)}</td>
            <td className="px-1.5 py-1">{p.play_result || p.tagged_hit_type || '–'}</td>
            <td className="px-1.5 py-1 text-gray-500">{p.session_type === 'bp' ? 'BP' : (p.ptype || '–')}{p.rel_speed != null ? ` ${Number(p.rel_speed).toFixed(0)}` : ''}</td>
            <td className="px-1.5 py-1 text-gray-500">{p.session_type === 'bp' ? '' : (p.pitcher || '')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// One player's report page. Fetches its own scoped detail.
// Click-to-type text that prints as plain text. Uncontrolled while focused
// (so the caret never jumps); saves on every input.
function CrEditable({ value, onChange, placeholder, className = '' }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current && ref.current.innerText !== value) ref.current.innerText = value
  }, [value])
  return (
    <div ref={ref} contentEditable suppressContentEditableWarning data-placeholder={placeholder}
      onInput={(e) => onChange(e.currentTarget.innerText.replace(/\n$/, ''))}
      className={`cr-editable min-h-[3.2em] text-[13px] leading-relaxed whitespace-pre-wrap outline-none rounded-md px-1 -mx-1 focus:bg-amber-50/60 focus:ring-1 focus:ring-amber-200 ${className}`} />
  )
}

function CrPlayerPage({ player, role, ids, cfg, team, season, sessions, innerRef, exporting, onNote }) {
  const isP = role === 'pitcher'
  const { data, loading, error } = useApi(
    ids.length ? (isP ? '/trackman/pitchers/detail' : '/trackman/batters/detail') : null,
    { [isP ? 'pitcher' : 'batter']: player.name, team: team || undefined, sessions: ids.join(','),
      context: isP ? 'live' : 'all', season, [isP ? 'side' : 'throws']: cfg.hand || undefined },
    [ids.join(','), cfg.hand])
  const used = sessions.filter(s => ids.includes(s.id))
  const scope = (() => {
    if (!used.length) return 'No sessions match this scope'
    const dates = used.map(s => s.session_date).sort()
    const kinds = [...new Set(used.map(s => (TYPE_META[s.session_type] || {}).label || s.session_type))].join(', ')
    const span = dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`
    return `${used.length} session${used.length === 1 ? '' : 's'} · ${kinds} · ${span}${cfg.hand ? ` · vs ${cfg.hand}H${isP ? 'H' : 'P'}` : ''}`
  })()
  const pitches = data?.pitches || []
  const stats = useMemo(() => data ? (isP ? crPitcherStats(data) : crHitterStats(data)) : {}, [data, isP])
  const byType = useMemo(() => {
    const g = {}
    pitches.forEach(p => { if (p.ptype) (g[p.ptype] = g[p.ptype] || []).push(p) })
    return Object.fromEntries(Object.entries(g).sort((a, b) => b[1].length - a[1].length))
  }, [pitches])
  const bbe = pitches.filter(p => p.exit_speed != null)
  const pct = data?.percentiles || {}
  const labels = isP ? PCTL_LABELS : HITTER_PCTL_LABELS
  const pctKeys = Object.keys(labels).filter(k => pct[k])
  const myNote = cfg.playerNotes?.[player.name]

  const render = (id) => {
    switch (id) {
      case 'keystats': {
        // in the order they were picked, so a layout controls what leads
        const defs = cfg.keyStats[role].map(k => CR_KEYSTATS[role].find(d => d[0] === k)).filter(Boolean)
        return (
          <CrCard>
            <div className="grid grid-cols-6 gap-x-4 gap-y-3">
              {defs.map(([k, label, dec]) => (
                <div key={k}>
                  <div className="text-[19px] font-bold tabular-nums leading-none text-portal-purple">{k === 'rv' && stats[k] > 0 ? '+' : ''}{crFmt(stats[k], dec)}</div>
                  <div className="text-[9.5px] font-semibold uppercase tracking-wide text-gray-400 mt-1">{label}</div>
                </div>
              ))}
            </div>
          </CrCard>
        )
      }
      case 'notes':
        // Typed right on the page. While exporting, an empty note prints nothing.
        if (exporting && !cfg.notes && !myNote) return null
        return (
          <CrCard title="Coach notes" sub={exporting ? null : 'click and type'}>
            {(!exporting || myNote) && (
              <CrEditable value={myNote || ''} placeholder={`Write ${player.name.split(',')[0]}'s note here…`}
                onChange={(v) => onNote(player.name, v)} className="text-gray-800" />
            )}
            {cfg.notes && <p className={`text-[13px] leading-relaxed text-gray-700 whitespace-pre-wrap ${myNote || !exporting ? 'mt-2 pt-2 border-t border-gray-100' : ''}`}>{cfg.notes}</p>}
          </CrCard>
        )
      case 'arsenal': return <CrCard title="Arsenal"><CrArsenalTable data={data} cols={cfg.arsenalCols} /></CrCard>
      case 'line':
        if (!data.line) return null
        return isP ? <CrCard title="Box line" sub="R not ER: TrackMan does not score earned runs"><PitcherLineStrip line={data.line} /></CrCard>
          : <HitterLineCard line={data.line} />
      case 'percentiles':
        if (!pctKeys.length) return null
        return (
          <CrCard title={`Percentiles vs your ${isP ? 'staff' : 'lineup'}`} sub={`${pct[pctKeys[0]]?.pool} in the pool`}>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2.5">
              {pctKeys.map(k => {
                const [label, unit, dec] = labels[k]
                const v = pct[k].value
                return <PctlBar key={k} label={label} value={k.endsWith('_pct') ? (v * 100).toFixed(dec) : v.toFixed(dec)} unit={unit} pctl={pct[k].pctl} />
              })}
            </div>
          </CrCard>
        )
      case 'plotsnotes':
        return (
          <div className="grid gap-3 items-stretch" style={{ gridTemplateColumns: '1.3fr 1fr 2.3fr' }}>
            <CrCard title="Movement">
              <MovementPlot pitches={pitches} arm={data.arm} onPick={() => {}} />
              <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-1">
                {Object.keys(byType).map(t => (
                  <span key={t} className="text-[9.5px] text-gray-500 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: cFor(t) }} />{t}
                  </span>
                ))}
              </div>
            </CrCard>
            <CrCard title="Release (zoomed)"><ReleasePlot pitches={pitches} zoom /></CrCard>
            <div className="bg-white rounded-xl ring-1 ring-gray-200 p-4 flex flex-col">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Coach notes</span>
                {!exporting && <span className="text-[10px] text-gray-400">click and type</span>}
              </div>
              {exporting && !myNote ? <div className="flex-1" /> : (
                <CrEditable value={myNote || ''} placeholder={`Write ${player.name.split(',')[0]}'s note here…`}
                  onChange={(v) => onNote(player.name, v)} className="text-gray-800 flex-1" />
              )}
              {cfg.notes && <p className="text-[13px] leading-relaxed text-gray-700 whitespace-pre-wrap mt-2 pt-2 border-t border-gray-100">{cfg.notes}</p>}
            </div>
          </div>
        )
      case 'movement':
        return (
          <CrCard title="Movement (catcher's view)">
            <MovementPlot pitches={pitches} arm={data.arm} onPick={() => {}} />
            <div className="flex flex-wrap gap-2 mt-1">
              {Object.keys(byType).map(t => (
                <span key={t} className="text-[11px] text-gray-500 flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full inline-block" style={{ background: cFor(t) }} />{t}
                </span>
              ))}
            </div>
          </CrCard>
        )
      case 'release': return <CrCard title="Release point (zoomed to his cluster)"><ReleasePlot pitches={pitches} zoom /></CrCard>
      case 'locations':
        return (
          <CrCard title="Locations by pitch">
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
              {Object.entries(byType).slice(0, 6).map(([t, ps]) => <LocationHeatmap key={t} pitches={ps} title={t} />)}
            </div>
          </CrCard>
        )
      case 'locspray': {
        const types = Object.entries(byType).slice(0, 5)
        return (
          <div className="grid gap-3 items-stretch" style={{ gridTemplateColumns: '2.5fr 1fr' }}>
            <CrCard title="Locations by pitch">
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(3, types.length)}, minmax(0, 1fr))` }}>
                {types.map(([t, ps]) => <LocationHeatmap key={t} pitches={ps} title={t} />)}
              </div>
            </CrCard>
            <CrCard title="Opposing spray" sub={`${pitches.filter(p => crFair(p) && p.bearing != null && p.distance != null).length} BIP`}>
              <SprayChart pitches={pitches.filter(crFair)} />
            </CrCard>
          </div>
        )
      }
      case 'oppspray': return <CrCard title="Opposing spray (colored by EV)"><SprayChart pitches={pitches.filter(crFair)} /></CrCard>
      case 'zonemaps':
        if (isP) return <PitcherZoneMaps pitches={pitches} />
        return (
          <CrCard title="Zone maps" sub="per cell, min 3">
            <div className="grid grid-cols-5 gap-3">
              <ZoneRateMap pitches={pitches} title="Swings" sub="% offered at" den={(p) => p.pitch_call} num={(p) => p.is_swing} />
              <ZoneRateMap pitches={pitches} title="Whiffs" sub="% of swings" den={(p) => p.is_swing} num={(p) => p.is_whiff} />
              <ZoneValueMap pitches={pitches} title="Damage" sub="avg EV" lo={72} hi={95} value={(p) => p.exit_speed} />
              <ZoneRateMap pitches={pitches} title="Hard contact" sub="% 90+ mph" den={(p) => p.exit_speed != null} num={(p) => p.exit_speed >= 90} />
              <ZoneRateMap pitches={pitches} title="Called K on takes" sub="% of takes" den={(p) => p.pitch_call && !p.is_swing} num={(p) => p.pitch_call === 'StrikeCalled'} />
            </div>
          </CrCard>
        )
      case 'countusage': return <CrCard title="Pitch mix by count"><CountUsage pitches={pitches} /></CrCard>
      case 'countlev': return <CountResults pitches={pitches} mode={isP ? 'pitcher' : 'hitter'} />
      case 'countstates': return data.count_states ? <CountStateTable states={data.count_states} mode={isP ? 'pitcher' : 'batter'} title="Count states" /> : null
      case 'velotrend': return <CrCard title="Velocity by session"><VeloTrend trend={data.velo_trend} /></CrCard>
      case 'sessiontrend':
        return isP
          ? <SessionTrendCard trend={data.session_trend} metrics={[['stuff', 'Stuff+', 0], ['rv100', 'RV/100', 2], ['fb_velo', 'FB velo', 1]]} title="Session trend" />
          : <SessionTrendCard trend={data.trend} metrics={[['xwobacon', 'xwOBAcon', 3], ['avg_ev', 'Avg EV', 1], ['hard_hit_pct', 'Hard-hit%', 1]]} title="Session trend" />
      case 'arm': return data.arm ? <ArmProfileCard arm={data.arm} /> : null
      case 'tunneling': return data.tunneling ? <TunnelingCard tunneling={data.tunneling} /> : null
      case 'sequencing': return <CrCard title="Two-pitch sequences (result on the 2nd pitch)"><SequencingTable pitches={pitches} /></CrCard>
      case 'xstats': return data.xstats ? <XStatsCard x={data.xstats} /> : null
      case 'spray': return <CrCard title="Spray (colored by EV)"><SprayChart pitches={bbe} /></CrCard>
      case 'contact': return <ContactPointCard pitches={pitches} />
      case 'evla': return <CrCard title="Exit velo x launch angle"><EvLaScatter points={bbe.filter(p => p.launch_angle != null).map(p => ({ ev: p.exit_speed, la: p.launch_angle }))} /></CrCard>
      case 'swingtake': return data.swing_take ? <SwingTakeCard st={data.swing_take} /> : null
      case 'splits': return data.splits ? <SplitsCard splits={data.splits} /> : null
      case 'velobands': return data.velo ? <VeloBandCard velo={data.velo} /> : null
      case 'battedballs': return <CrCard title="Batted ball log" sub="newest first, up to 40"><CrBattedBalls pitches={pitches} /></CrCard>
      default: return null
    }
  }

  // consecutive half-width blocks pair up side by side
  const halves = new Set(CR_BLOCKS[role].filter(b => b[2]).map(b => b[0]))
  const layout = []
  const order = cfg.blocks[role]
  for (let i = 0; i < order.length; i++) {
    if (halves.has(order[i]) && halves.has(order[i + 1])) { layout.push([order[i], order[i + 1]]); i++ } else layout.push([order[i]])
  }

  return (
    <div ref={innerRef} className="bg-[#f6f5f1] text-gray-900 p-5 space-y-3" style={{ width: 880 }}>
      <div data-report-block className="flex items-end justify-between border-b-2 border-portal-purple pb-2">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-400">{cfg.title || 'Player Report'}</div>
          <div className="text-[24px] font-bold leading-tight text-gray-900">
            {player.name}
            <span className="ml-2 text-[12px] font-bold text-gray-500 bg-white ring-1 ring-gray-200 rounded px-1.5 py-0.5 align-middle">
              {isP ? (player.hand === 'Left' ? 'LHP' : player.hand === 'Right' ? 'RHP' : 'P') : (player.hand === 'Left' ? 'LHH' : player.hand === 'Right' ? 'RHH' : player.hand === 'Switch' ? 'SH' : 'H')}
            </span>
          </div>
          {cfg.showScope && <div className="text-[11px] text-gray-500 mt-0.5">{scope}{data ? ` · ${pitches.length} pitches` : ''}</div>}
        </div>
        <div className="text-right text-[10px] text-gray-400 leading-snug">
          <div className="font-bold text-gray-500">{team || ''}</div>
          <div>{new Date().toLocaleDateString()}</div>
        </div>
      </div>
      {!ids.length && <div className="text-sm text-gray-400 p-6 text-center">No sessions for {player.name} in this scope.</div>}
      {loading && ids.length > 0 && <div className="text-sm text-gray-400 p-6 text-center">Loading {player.name}…</div>}
      {error && <div className="text-sm text-gray-400 p-6 text-center">No data for {player.name} in this scope.</div>}
      {data && layout.map((grp, gi) => {
        const cells = grp.map(id => [id, render(id)]).filter(([, el]) => el)
        if (!cells.length) return null
        return (
          <div key={gi} data-report-block className={cells.length === 2 ? 'grid grid-cols-2 gap-3' : ''}>
            {cells.map(([id, el]) => <div key={id} className="min-w-0">{el}</div>)}
          </div>
        )
      })}
      <div data-report-block className="flex justify-between text-[9px] text-gray-400 pt-1">
        <span>NW Baseball Stats · TrackMan Suite</span><span>nwbaseballstats.com</span>
      </div>
    </div>
  )
}

function CrSection({ title, right, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700">
      <button onClick={() => setOpen(o => !o)} className="w-full px-3.5 py-2.5 flex items-center justify-between text-left">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-300">{title}</span>
        <span className="text-[11px] text-gray-400">{right} {open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="px-3.5 pb-3.5">{children}</div>}
    </div>
  )
}

function CustomReportTab({ teamCtx, season }) {
  const [team, setTeam] = useState(teamCtx.primary)
  const { data: index, loading } = useApi('/trackman/reports/index', { team: team || undefined }, [team])
  const [cfg, setCfg] = useState(() => ({ ...CR_DEFAULT, ...crLoad(CR_STORE, {}) }))
  const [presets, setPresets] = useState(() => crLoad(CR_PRESETS, {}))
  const [presetName, setPresetName] = useState('')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(null)
  const [bw, setBw] = useState(false)
  const [notePlayer, setNotePlayer] = useState('')
  const [exporting, setExporting] = useState(false)
  const pageRefs = useRef({})
  useEffect(() => { crSave(CR_STORE, cfg) }, [cfg])
  const set = (patch) => setCfg(c => ({ ...c, ...patch }))

  const role = cfg.role
  const sessions = index?.sessions || []
  const roster = (role === 'pitcher' ? index?.pitchers : index?.batters) || []
  const typeOpts = CR_TYPES[role]
  // roster under the current type filter, busiest first
  const eligible = useMemo(() => roster
    .map(p => ({ ...p, total: sessions.filter(s => p.sessions[s.id] && cfg.types[s.session_type]).reduce((a, s) => a + p.sessions[s.id].n, 0) }))
    .filter(p => p.total > 0)
    .sort((a, b) => a.name.localeCompare(b.name)), [roster, sessions, cfg.types])
  const chosen = eligible.filter(p => cfg.players.includes(p.name))
  const shownRoster = eligible.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()))
  const togglePlayer = (n) => setCfg(c => ({ ...c, players: c.players.includes(n) ? c.players.filter(x => x !== n) : [...c.players, n] }))
  const pickable = sessions.filter(s => cfg.types[s.session_type] && (season == null || seasonOf(s.session_date) === season))

  const blocks = cfg.blocks[role]
  const setBlocks = (b) => set({ blocks: { ...cfg.blocks, [role]: b } })
  const moveBlock = (i, d) => { const b = [...blocks]; const j = i + d; if (j < 0 || j >= b.length) return; [b[i], b[j]] = [b[j], b[i]]; setBlocks(b) }
  const toggleBlock = (id) => setBlocks(blocks.includes(id) ? blocks.filter(x => x !== id) : [...blocks, id])
  const toggleIn = (key, id, scoped) => {
    const cur = scoped ? cfg[key][role] : cfg[key]
    const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]
    set({ [key]: scoped ? { ...cfg[key], [role]: next } : next })
  }
  const blockDefs = Object.fromEntries(CR_BLOCKS[role].map(b => [b[0], b]))

  const applyLayout = (l) => set({
    title: l.title || cfg.title,
    role: l.role, range: l.range, lastN: l.lastN ?? cfg.lastN, types: { ...cfg.types, ...l.types },
    blocks: { ...cfg.blocks, [l.role]: l.blocks },
    keyStats: l.keyStats ? { ...cfg.keyStats, [l.role]: l.keyStats } : cfg.keyStats,
    arsenalCols: l.arsenalCols || cfg.arsenalCols,
    players: l.role === cfg.role ? cfg.players : [],
  })
  const savePreset = () => {
    const name = presetName.trim()
    if (!name) return
    const { players, playerNotes, notes, ...layout } = cfg   // presets are layouts, not rosters or notes
    const next = { ...presets, [name]: layout }
    setPresets(next); crSave(CR_PRESETS, next); setPresetName('')
  }
  const dropPreset = (name) => { const next = { ...presets }; delete next[name]; setPresets(next); crSave(CR_PRESETS, next) }

  const nodes = () => chosen.map(p => pageRefs.current[p.name]).filter(Boolean)
  const fileBase = `${(cfg.title || 'report').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_${new Date().toISOString().slice(0, 10)}`
  async function exportAs(kind) {
    const list = nodes()
    if (!list.length) return
    setBusy(`0/${list.length}`)
    setExporting(true)                                  // drop empty note boxes + typing hints
    await new Promise(r => setTimeout(r, 120))
    if (bw) list.forEach(n => n.classList.add('bw-report'))
    try {
      if (kind === 'pdf') {
        // one PDF per player (named for him), zipped when there is more than one
        const { saveNodesAsPdfZip } = await import('../lib/reportExport')
        const sfx = `${fileBase}${bw ? '_bw' : ''}`
        await saveNodesAsPdfZip(list, chosen.map(p => `${p.name.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}_${sfx}`), sfx, (d, t) => setBusy(`${d}/${t}`))
      } else {
        const { saveNodeAsImage } = await import('../lib/reportExport')
        for (let i = 0; i < list.length; i++) {
          await saveNodeAsImage(list[i], `${chosen[i].name.replace(/[^a-z0-9]+/gi, '_')}_${fileBase}${bw ? '_bw' : ''}`)
          setBusy(`${i + 1}/${list.length}`)
        }
      }
    } catch (e) { console.error('report export failed', e) } finally {
      if (bw) list.forEach(n => n.classList.remove('bw-report'))
      setExporting(false)
      setBusy(null)
    }
  }

  const chip = (on) => `px-2.5 py-1 rounded-full text-[12px] font-semibold ${on ? 'bg-portal-purple text-white'
    : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 ring-1 ring-gray-200 dark:ring-gray-700'}`
  const small = (on) => `px-2 py-0.5 rounded-full text-[11px] font-semibold ${on ? 'bg-portal-purple text-white'
    : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-300'}`

  return (
    <div className="grid lg:grid-cols-[340px_minmax(0,1fr)] gap-4 items-start">
      {/* ── builder ── */}
      <div className="space-y-2.5 lg:sticky lg:top-3 lg:max-h-[calc(100vh-1.5rem)] lg:overflow-y-auto pr-0.5">
        <div className="bg-portal-purple/5 dark:bg-gray-800 rounded-xl ring-1 ring-portal-purple/20 dark:ring-gray-700 px-3.5 py-2.5">
          <div className="text-[11px] font-bold uppercase tracking-wide text-portal-purple dark:text-indigo-300 mb-1.5">Post-game recap</div>
          <div className="flex gap-1.5">
            <button onClick={() => applyLayout(CR_STARTERS[0][1])} className={chip(false)}>Pitchers</button>
            <button onClick={() => applyLayout(CR_STARTERS[1][1])} className={chip(false)}>Hitters</button>
          </div>
          <p className="text-[10.5px] text-gray-500 dark:text-gray-400 mt-1.5 leading-snug">
            Each player's last outing, his numbers, and a notes box you type straight into on his page.
            For a weekend series set "Last N sessions" to 3, or use Pick days.
          </p>
        </div>

        <CrSection title="1 · Who" right={`${chosen.length} selected`}>
          <div className="flex items-center gap-1.5 mb-2">
            {[['pitcher', 'Pitchers'], ['hitter', 'Hitters']].map(([k, l]) => (
              <button key={k} onClick={() => set({ role: k, players: [] })} className={chip(role === k)}>{l}</button>
            ))}
            <div className="ml-auto"><TeamSelect teamCtx={teamCtx} value={team} onChange={(t) => { setTeam(t); set({ players: [] }) }} /></div>
          </div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search players"
              className="flex-1 rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1 text-xs" />
            <button onClick={() => set({ players: eligible.map(p => p.name) })} className="text-[11px] font-semibold text-portal-purple dark:text-indigo-300">All</button>
            <button onClick={() => set({ players: [] })} className="text-[11px] text-gray-400">None</button>
          </div>
          <div className="max-h-44 overflow-y-auto flex flex-wrap gap-1">
            {loading && <span className="text-xs text-gray-400">Loading roster…</span>}
            {shownRoster.map(p => (
              <button key={p.name} onClick={() => togglePlayer(p.name)} className={small(cfg.players.includes(p.name))}
                title={`${p.total} pitches in the selected session types`}>{p.name}</button>
            ))}
            {!loading && !shownRoster.length && <span className="text-xs text-gray-400">No players with data in these session types.</span>}
          </div>
        </CrSection>

        <CrSection title="2 · Which data">
          <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Session types</div>
          <div className="flex flex-wrap gap-1 mb-2.5">
            {typeOpts.map(([k, l]) => (
              <button key={k} onClick={() => set({ types: { ...cfg.types, [k]: !cfg.types[k] } })} className={small(!!cfg.types[k])}>{l}</button>
            ))}
          </div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Time span</div>
          <div className="flex flex-wrap gap-1 mb-2">
            {[['season', season == null ? 'All seasons' : `Season ${seasonLabel(season)}`], ['lastN', 'Last N sessions'], ['dates', 'Date range'], ['pick', 'Pick days']].map(([k, l]) => (
              <button key={k} onClick={() => set({ range: k })} className={small(cfg.range === k)}>{l}</button>
            ))}
          </div>
          {cfg.range === 'season' && <p className="text-[11px] text-gray-400">Follows the season selector at the top of the suite.</p>}
          {cfg.range === 'lastN' && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              Each player's last
              <input type="number" min="1" max="30" value={cfg.lastN} onChange={e => set({ lastN: Math.max(1, +e.target.value || 1) })}
                className="w-14 rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1 text-xs" />
              session{cfg.lastN === 1 ? '' : 's'} he appeared in
            </div>
          )}
          {cfg.range === 'dates' && <DateRange value={cfg.dates} onChange={(d) => set({ dates: d })} />}
          {cfg.range === 'pick' && (
            <div className="max-h-40 overflow-y-auto flex flex-wrap gap-1">
              {pickable.map(s => (
                <button key={s.id} onClick={() => set({ picked: cfg.picked.includes(s.id) ? cfg.picked.filter(x => x !== s.id) : [...cfg.picked, s.id] })}
                  className={small(cfg.picked.includes(s.id))}>
                  {s.session_date} · {(TYPE_META[s.session_type] || {}).label}{s.session_type === 'game' || s.session_type === 'scrimmage' ? ` · ${s.away_team}@${s.home_team}` : ''}
                </button>
              ))}
            </div>
          )}
          <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mt-2.5 mb-1">{role === 'pitcher' ? 'Versus batter side' : 'Versus pitcher hand'}</div>
          <div className="flex gap-1">
            {[['', 'All'], ['L', 'vs Left'], ['R', 'vs Right']].map(([k, l]) => (
              <button key={k} onClick={() => set({ hand: k })} className={small(cfg.hand === k)}>{l}</button>
            ))}
          </div>
        </CrSection>

        <CrSection title="3 · What to show" right={`${blocks.length} blocks`}>
          <div className="space-y-1 mb-2">
            {blocks.map((id, i) => blockDefs[id] && (
              <div key={id} className="flex items-center gap-1.5 rounded-lg bg-gray-50 dark:bg-gray-900/40 px-2 py-1">
                <span className="text-[10px] tabular-nums text-gray-400 w-4">{i + 1}</span>
                <span className="text-[12px] font-semibold text-gray-700 dark:text-gray-200 flex-1">{blockDefs[id][1]}{blockDefs[id][2] ? <span className="ml-1 text-[9px] font-normal text-gray-400">half</span> : null}</span>
                <button onClick={() => moveBlock(i, -1)} className="text-gray-400 hover:text-portal-purple text-xs px-1" title="Move up">▲</button>
                <button onClick={() => moveBlock(i, 1)} className="text-gray-400 hover:text-portal-purple text-xs px-1" title="Move down">▼</button>
                <button onClick={() => toggleBlock(id)} className="text-rose-400 hover:text-rose-600 text-xs px-1" title="Remove">×</button>
              </div>
            ))}
            {!blocks.length && <p className="text-xs text-gray-400">Add blocks below.</p>}
          </div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Add a block</div>
          <div className="flex flex-wrap gap-1">
            {CR_BLOCKS[role].filter(b => !blocks.includes(b[0])).map(([id, label, , hint]) => (
              <button key={id} onClick={() => toggleBlock(id)} title={hint} className={small(false)}>+ {label}</button>
            ))}
          </div>
          <p className="text-[10px] text-gray-400 mt-1.5">Two "half" blocks in a row print side by side.</p>
          {blocks.includes('keystats') && (<>
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mt-3 mb-1">Key numbers to show</div>
            <div className="flex flex-wrap gap-1">
              {CR_KEYSTATS[role].map(([k, l]) => <button key={k} onClick={() => toggleIn('keyStats', k, true)} className={small(cfg.keyStats[role].includes(k))}>{l}</button>)}
            </div>
          </>)}
          {role === 'pitcher' && blocks.includes('arsenal') && (<>
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mt-3 mb-1">Arsenal columns</div>
            <div className="flex flex-wrap gap-1">
              {CR_ARSENAL_COLS.map(([k, l]) => <button key={k} onClick={() => toggleIn('arsenalCols', k, false)} className={small(cfg.arsenalCols.includes(k))}>{l}</button>)}
            </div>
          </>)}
        </CrSection>

        <CrSection title="4 · Title and notes">
          <input value={cfg.title} onChange={e => set({ title: e.target.value })} placeholder="Report title"
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1.5 text-sm font-semibold mb-2" />
          <textarea value={cfg.notes} onChange={e => set({ notes: e.target.value })} rows={4}
            placeholder="Notes for everyone in this report (focus for the week, what the numbers mean, next steps)…"
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1.5 text-xs" />
          {chosen.length > 0 && (<>
            <div className="flex items-center gap-1.5 mt-2 mb-1">
              <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Note for</span>
              <select value={notePlayer || chosen[0].name} onChange={e => setNotePlayer(e.target.value)}
                className="flex-1 rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1 text-xs">
                {chosen.map(p => <option key={p.name} value={p.name}>{p.name}{cfg.playerNotes?.[p.name] ? ' ✎' : ''}</option>)}
              </select>
            </div>
            <textarea rows={3} value={cfg.playerNotes?.[notePlayer || chosen[0].name] || ''}
              onChange={e => set({ playerNotes: { ...cfg.playerNotes, [notePlayer || chosen[0].name]: e.target.value } })}
              placeholder="A note only this player's page shows…"
              className="w-full rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1.5 text-xs" />
          </>)}
          {!blocks.includes('notes') && !blocks.includes('plotsnotes') && (cfg.notes || Object.values(cfg.playerNotes || {}).some(Boolean)) && (
            <button onClick={() => toggleBlock('notes')} className="text-[11px] font-semibold text-amber-700 mt-1">Notes are typed but the Coach notes block is off. Add it</button>
          )}
          <label className="flex items-center gap-1.5 text-[11px] text-gray-500 mt-2">
            <input type="checkbox" checked={cfg.showScope} onChange={e => set({ showScope: e.target.checked })} className="accent-portal-purple" />
            Print the data scope line under the name
          </label>
        </CrSection>

        <CrSection title="Layouts" defaultOpen={false} right={`${Object.keys(presets).length} saved`}>
          <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Starters</div>
          <div className="flex flex-wrap gap-1 mb-2.5">
            {CR_STARTERS.map(([name, l]) => <button key={name} onClick={() => applyLayout(l)} className={small(false)}>{name}</button>)}
          </div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Yours (saved in this browser)</div>
          <div className="space-y-1 mb-2">
            {Object.keys(presets).map(name => (
              <div key={name} className="flex items-center gap-1.5">
                <button onClick={() => setCfg(c => ({ ...c, ...presets[name], players: presets[name].role === c.role ? c.players : [] }))}
                  className="flex-1 text-left text-[12px] font-semibold text-portal-purple dark:text-indigo-300 hover:underline truncate">{name}</button>
                <button onClick={() => dropPreset(name)} className="text-rose-400 text-xs">×</button>
              </div>
            ))}
          </div>
          <div className="flex gap-1.5">
            <input value={presetName} onChange={e => setPresetName(e.target.value)} placeholder="Name this layout"
              className="flex-1 rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1 text-xs" />
            <button onClick={savePreset} className="px-2.5 py-1 rounded-lg bg-portal-purple text-white text-xs font-semibold">Save</button>
          </div>
        </CrSection>
      </div>

      {/* ── preview + export ── */}
      <div className="min-w-0 space-y-3">
        <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 px-4 py-2.5 flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Export</span>
          <button onClick={() => exportAs('pdf')} disabled={!!busy || !chosen.length}
            className="px-3 py-1.5 rounded-lg bg-portal-purple text-portal-cream text-sm font-semibold hover:opacity-90 disabled:opacity-50">
            {busy ? `Rendering ${busy}…` : chosen.length > 1 ? `Download PDFs (ZIP, ${chosen.length} players)` : 'Download PDF'}
          </button>
          <button onClick={() => exportAs('png')} disabled={!!busy || !chosen.length}
            className="px-3 py-1.5 rounded-lg border border-nw-teal text-nw-teal text-sm font-semibold hover:bg-nw-teal/10 disabled:opacity-50">
            {chosen.length > 1 ? 'Download images (one per player)' : 'Download image'}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 cursor-pointer" title="Strip color shading for mono printers">
            <input type="checkbox" checked={bw} onChange={e => setBw(e.target.checked)} className="h-3.5 w-3.5 accent-portal-purple" /> B&W
          </label>
          <span className="ml-auto text-[11px] text-gray-400">One PDF per player, named for him (zipped when there is more than one); long reports flow onto more pages without splitting a block.</span>
        </div>
        {!chosen.length ? (
          <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-10 text-center text-sm text-gray-400">
            Pick one or more {role === 'pitcher' ? 'pitchers' : 'hitters'} on the left to build the report. The preview below is exactly what exports.
          </div>
        ) : (
          <div className="overflow-x-auto space-y-5 pb-4">
            {chosen.map(p => (
              <div key={`${role}-${p.name}`} className="shadow-lg ring-1 ring-gray-200 w-fit mx-auto">
                <CrPlayerPage player={p} role={role} cfg={cfg} team={team} season={season} sessions={sessions}
                  exporting={exporting} onNote={(n, v) => setCfg(c => ({ ...c, playerNotes: { ...c.playerNotes, [n]: v } }))}
                  ids={crScopeIds(p, sessions, cfg, season)} innerRef={el => { pageRefs.current[p.name] = el }} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
