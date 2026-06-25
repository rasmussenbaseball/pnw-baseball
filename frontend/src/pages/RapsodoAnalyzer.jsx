// RapsodoAnalyzer — Coach/Scout Portal tool for breaking down Rapsodo bullpens.
//
// A private, per-coach workspace: upload Rapsodo session CSV(s), and the tool
// parses, quality-checks, re-classifies (ignoring Rapsodo's unreliable pitch
// labels), and profiles each player across all their sessions. Players are keyed
// by Rapsodo's own Player ID, so this works whether or not they exist anywhere
// else on the site. See RAPSODO_TOOL_DESIGN.md.
//
// All data is owner-scoped server-side (WHERE owner_user_id = you), so a coach
// only ever sees their own uploads.

import { useState, useEffect, useRef } from 'react'
import { useApi } from '../hooks/useApi'
import { supabase } from '../lib/supabase'

const PITCH_COLORS = {
  'fastball': '#ef4444',
  'sinker': '#f59e0b',
  'cutter': '#8b5cf6',
  'slider': '#3b82f6',
  'sweeper': '#14b8a6',
  'curveball': '#22c55e',
  'changeup': '#ec4899',
  'splitter': '#0891b2',
  'unclassified': '#9ca3af',
}
const colorFor = (p) => PITCH_COLORS[p] || '#9ca3af'
const fmt = (v, d = 1) => (v === null || v === undefined ? '–' : Number(v).toFixed(d))
const handLabel = (h) => ({ R: 'RHP', L: 'LHP' }[h] || '—')
// Arm angle is a rough estimate (no shoulder pose; rubber position shifts release
// data), so we present it as a ~10° band rather than a false-precision number.
const angleBand = (a) => {
  if (a == null) return null
  const c = Math.round(a / 5) * 5
  return { lo: c - 5, hi: c + 5, label: `${c - 5}–${c + 5}°` }
}

export default function RapsodoAnalyzer() {
  const [selected, setSelected] = useState(null)
  const [mode, setMode] = useState(() => localStorage.getItem('rapsodoMode') || 'pnw')
  const [school, setSchool] = useState(() => localStorage.getItem('rapsodoSchool') || '')
  const { data, loading, refetch } = useApi('/rapsodo/players')
  const players = data?.players || []
  const setModePersist = (m) => { setMode(m); localStorage.setItem('rapsodoMode', m) }
  const setSchoolPersist = (s) => { setSchool(s); s ? localStorage.setItem('rapsodoSchool', s) : localStorage.removeItem('rapsodoSchool') }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      {selected ? (
        // Player data page: just the profile (it has its own "← Back to players").
        <PlayerProfile rapsodoId={selected} school={mode === 'pnw' ? school : ''} onBack={() => setSelected(null)} />
      ) : (
        // Landing page: upload CSVs, pick a mode, choose a player.
        <>
          <header className="mb-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-3xl font-bold text-portal-purple dark:text-portal-accent">
                  Rapsodo Lab
                </h1>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  Upload your bullpen sessions. We clean the data, re-classify every pitch by its
                  actual shape, and build a profile for each of your players.
                </p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <ModeToggle mode={mode} onChange={setModePersist} />
                {mode === 'pnw' && <SchoolSelector value={school} onChange={setSchoolPersist} />}
              </div>
            </div>
          </header>

          <UploadZone mode={mode} onDone={refetch} />

          <Roster players={players} loading={loading} onPick={setSelected} />
        </>
      )}
    </div>
  )
}

const PITCH_TYPES = ['fastball', 'sinker', 'cutter', 'slider', 'sweeper', 'curveball', 'changeup', 'splitter']

function ModeToggle({ mode, onChange }) {
  const opt = (val, label, sub) => (
    <button
      type="button"
      onClick={() => onChange(val)}
      className={`px-3 py-1.5 rounded-lg text-left transition-colors ${mode === val
        ? 'bg-portal-purple text-white'
        : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:border-portal-purple'}`}
    >
      <div className="text-sm font-medium">{label}</div>
      <div className={`text-[11px] ${mode === val ? 'text-white/80' : 'text-gray-400'}`}>{sub}</div>
    </button>
  )
  return (
    <div className="flex gap-2 shrink-0">
      {opt('pnw', 'PNW college', 'Our rosters & benchmarks')}
      {opt('facility', 'Facility / personal', 'Standalone workspace')}
    </div>
  )
}

// Your-school picker (PNW mode). Scopes the player→site-profile link search to your
// roster so you can pull each pitcher's spring + summer stats onto their Rapsodo page.
function SchoolSelector({ value, onChange }) {
  const { data } = useApi('/rapsodo/pnw-teams')
  const teams = data?.teams || []
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 max-w-[220px]">
      <option value="">Your school (optional)…</option>
      {teams.map((t) => <option key={t.id} value={t.id}>{t.short_name} ({t.level})</option>)}
    </select>
  )
}

// ───────────── Linked spring/summer profile (PNW college mode) ─────────────
function latestRow(rows) {
  if (!rows || !rows.length) return null
  return [...rows].sort((a, b) => Number(b.season || 0) - Number(a.season || 0))[0]
}

function StatStrip({ label, pit, bat }) {
  const row = pit || bat
  if (!row) return null
  const chips = pit
    ? [['ERA', fmt(row.era, 2)], ['IP', fmt(row.innings_pitched, 1)], ['K/9', fmt(row.k_per_9, 1)],
       ['BB/9', fmt(row.bb_per_9, 1)], ['FIP', fmt(row.fip, 2)], ['WHIP', fmt(row.whip, 2)]]
    : [['AVG', fmt(row.batting_avg, 3)], ['OBP', fmt(row.on_base_pct, 3)], ['OPS', fmt(row.ops, 3)],
       ['wOBA', fmt(row.woba, 3)], ['wRC+', fmt(row.wrc_plus, 0)], ['ISO', fmt(row.iso, 3)]]
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 px-3 py-2">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
        {label} · {row.season} {pit ? 'pitching' : 'hitting'}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {chips.map(([k, v]) => (
          <span key={k} className="text-xs"><span className="text-gray-400">{k}</span>{' '}
            <span className="font-semibold text-gray-800 dark:text-gray-200">{v}</span></span>
        ))}
      </div>
    </div>
  )
}

function PlayerLinkSearch({ defaultQuery, teamId, saving, onPick }) {
  const [q, setQ] = useState(defaultQuery || '')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const debRef = useRef(null)
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    clearTimeout(debRef.current)
    debRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const teamQ = teamId ? `&team_id=${teamId}` : ''
        const r = await fetch(`/api/v1/players/search?q=${encodeURIComponent(q.trim())}${teamQ}&limit=10`)
          .then((r) => r.json()).catch(() => [])
        setResults(Array.isArray(r) ? r : (r.players || []))
      } finally { setLoading(false) }
    }, 300)
    return () => clearTimeout(debRef.current)
  }, [q, teamId])
  return (
    <div>
      <div className="flex items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search NWBB players…"
          className="w-full max-w-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm" />
        {loading && <span className="text-xs text-gray-400">…</span>}
      </div>
      {results.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {results.map((p) => (
            <button key={p.id} type="button" disabled={saving} onClick={() => onPick(p)}
              className="px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-700 dark:text-gray-300 hover:border-portal-purple disabled:opacity-50">
              {p.first_name} {p.last_name}{' '}
              <span className="text-gray-400">{p.team_short}{p.division_level ? ` · ${p.division_level}` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SpringSummerCard({ rapsodoId, player, school, onChange }) {
  const playersId = player.players_id
  const { data } = useApi(playersId ? `/players/${playersId}` : null, {}, [playersId])
  const [saving, setSaving] = useState(false)

  async function setLink(pid) {
    setSaving(true)
    try {
      const { data: sess } = await supabase.auth.getSession()
      const token = sess?.session?.access_token
      await fetch(`/api/v1/portal/rapsodo/players/${rapsodoId}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ players_id: pid }),
      })
      onChange()
    } finally { setSaving(false) }
  }

  if (!playersId) {
    return (
      <div className="mb-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
        <div className="mb-1 text-sm font-semibold text-gray-700 dark:text-gray-300">Spring &amp; summer stats</div>
        <p className="mb-2 text-xs text-gray-400">
          Link this pitcher to their NWBB profile to pull their spring + summer (WCL) stats in here.
          Incoming freshmen or redshirts may not have a profile yet — that's fine, just leave it unlinked.
        </p>
        <PlayerLinkSearch defaultQuery={player.player_name} teamId={school} saving={saving} onPick={(p) => setLink(p.id)} />
      </div>
    )
  }

  const sp = data?.player
  const name = sp ? `${sp.first_name || ''} ${sp.last_name || ''}`.trim() : `Player #${playersId}`
  const springP = latestRow(data?.pitching_stats)
  const springB = latestRow(data?.batting_stats)
  const summerP = latestRow(data?.summer_pitching)
  const summerB = latestRow(data?.summer_batting)
  const hasSpring = springP || springB
  const hasSummer = summerP || summerB
  return (
    <div className="mb-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="text-gray-400">Linked profile: </span>
          <a href={`/player/${playersId}`} target="_blank" rel="noreferrer"
            className="font-semibold text-portal-purple dark:text-portal-accent hover:underline">{name}</a>
          {sp?.team_short && <span className="text-gray-400"> · {sp.team_short}</span>}
        </div>
        <button onClick={() => setLink(null)} disabled={saving}
          className="text-xs text-gray-400 hover:text-red-500 disabled:opacity-50">unlink</button>
      </div>
      {hasSpring || hasSummer ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {hasSpring && <StatStrip label="Spring" pit={springP} bat={springB} />}
          {hasSummer && <StatStrip label="Summer (WCL)" pit={summerP} bat={summerB} />}
        </div>
      ) : (
        <p className="text-xs text-gray-400">Linked, but no spring or summer stats on file yet.</p>
      )}
    </div>
  )
}

// ─────────────────────────────── Upload ───────────────────────────────
function UploadZone({ mode, onDone }) {
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState(null)
  const [err, setErr] = useState(null)

  async function submit() {
    if (!files.length) return
    setBusy(true)
    setErr(null)
    setReport(null)
    try {
      const fd = new FormData()
      files.forEach((f) => fd.append('files', f))
      fd.append('mode', mode || 'pnw')
      const { data } = await supabase.auth.getSession()
      const token = data?.session?.access_token
      const res = await fetch('/api/v1/portal/rapsodo/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      })
      if (!res.ok) throw new Error(`Upload failed (${res.status})`)
      const json = await res.json()
      setReport(json)
      setFiles([])
      onDone?.()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-8 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <label className="cursor-pointer rounded-lg bg-portal-purple px-4 py-2 text-white text-sm font-medium hover:opacity-90">
          Choose CSV files
          <input
            type="file"
            accept=".csv"
            multiple
            className="hidden"
            onChange={(e) => setFiles(Array.from(e.target.files || []))}
          />
        </label>
        <span className="text-sm text-gray-600 dark:text-gray-400">
          {files.length ? `${files.length} file${files.length > 1 ? 's' : ''} selected` : 'No files chosen'}
        </span>
        <button
          onClick={submit}
          disabled={!files.length || busy}
          className="ml-auto rounded-lg bg-portal-accent px-4 py-2 text-sm font-semibold text-gray-900 disabled:opacity-40"
        >
          {busy ? 'Uploading…' : 'Upload & analyze'}
        </button>
      </div>

      {err && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{err}</p>}

      {report && (
        <div className="mt-4 text-sm">
          <p className="font-medium text-gray-800 dark:text-gray-200">
            Processed {report.uploaded} session{report.uploaded === 1 ? '' : 's'}:
          </p>
          <ul className="mt-1 space-y-1">
            {report.results.map((r, i) => (
              <li key={i} className="text-gray-600 dark:text-gray-400">
                <span className="font-medium text-gray-800 dark:text-gray-200">{r.player_name}</span>{' '}
                ({handLabel(r.handedness)}) — {r.session_date}, {r.n_pitches} pitches,{' '}
                {r.qc?.ok || 0} clean{r.qc?.warmup ? `, ${r.qc.warmup} warmup` : ''} /{' '}
                {(r.qc?.low_confidence || 0) + (r.qc?.partial || 0) + (r.qc?.failed || 0)} flagged
              </li>
            ))}
            {report.errors?.map((e, i) => (
              <li key={`e${i}`} className="text-red-600 dark:text-red-400">
                {e.file}: {e.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────── Roster ───────────────────────────────
function Roster({ players, loading, onPick }) {
  if (loading) return <p className="text-gray-500">Loading your players…</p>
  if (!players.length) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 p-10 text-center text-gray-500">
        No players yet. Upload a Rapsodo session CSV above to get started.
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 dark:bg-gray-800 text-left text-gray-500 dark:text-gray-400">
          <tr>
            <th className="px-4 py-2 font-medium">Player</th>
            <th className="px-4 py-2 font-medium">Throws</th>
            <th className="px-4 py-2 font-medium">Sessions</th>
            <th className="px-4 py-2 font-medium">Last session</th>
            <th className="px-4 py-2 font-medium">Pitches</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {players.map((p) => (
            <tr
              key={p.rapsodo_player_id}
              onClick={() => onPick(p.rapsodo_player_id)}
              className="cursor-pointer bg-white dark:bg-gray-900 hover:bg-portal-cream dark:hover:bg-gray-800"
            >
              <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{p.player_name}</td>
              <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{handLabel(p.handedness)}</td>
              <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{p.session_count}</td>
              <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{p.last_session || '—'}</td>
              <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{p.total_pitches}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─────────────────────────────── Profile ───────────────────────────────
function PlayerProfile({ rapsodoId, school, onBack }) {
  const { data, loading, refetch } = useApi(`/rapsodo/players/${rapsodoId}`)
  const [relabel, setRelabel] = useState(null)   // the plot point being reclassified
  const [saving, setSaving] = useState(false)
  const [arsenalOpen, setArsenalOpen] = useState(false)
  const [savingArsenal, setSavingArsenal] = useState(false)
  const [tab, setTab] = useState('data')   // 'data' | 'notes'

  async function postJson(url, body) {
    const { data: sess } = await supabase.auth.getSession()
    const token = sess?.session?.access_token
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  }

  async function applyLabel(id, newPitch) {
    setSaving(true)
    try {
      await postJson(`/api/v1/portal/rapsodo/pitches/${id}/label`, { pitch: newPitch })
      setRelabel(null)
      refetch()
    } finally {
      setSaving(false)
    }
  }

  async function applyArsenal(types) {
    setSavingArsenal(true)
    try {
      await postJson(`/api/v1/portal/rapsodo/players/${rapsodoId}/arsenal`, { types })
      setArsenalOpen(false)
      refetch()
    } finally {
      setSavingArsenal(false)
    }
  }

  async function delJson(url) {
    const { data: sess } = await supabase.auth.getSession()
    const token = sess?.session?.access_token
    return fetch(url, { method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {} })
  }

  async function deletePlayer() {
    if (!window.confirm('Delete this player and all of their sessions? This cannot be undone.')) return
    await delJson(`/api/v1/portal/rapsodo/players/${rapsodoId}`)
    onBack()
  }

  async function deleteSession(id) {
    if (!window.confirm('Delete this session and its pitches?')) return
    await delJson(`/api/v1/rapsodo/sessions/${id}`)
    refetch()
  }

  if (loading) return <p className="mt-6 text-gray-500">Loading profile…</p>
  if (!data) return null
  const { player, arsenal, plot, locations, arm, hand_profile, platoon, trend, sessions, n_sessions, suggestions } = data

  return (
    <div className="mt-2">
      <button onClick={onBack} className="mb-4 text-sm text-portal-purple dark:text-portal-accent hover:underline">
        ← Back to players
      </button>

      <div className="flex flex-wrap items-baseline gap-3 mb-5">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{player.player_name}</h2>
        <span className="rounded-full bg-portal-purple/10 dark:bg-portal-accent/20 px-3 py-1 text-sm font-medium text-portal-purple dark:text-portal-accent">
          {handLabel(player.handedness)}
        </span>
        {hand_profile && (
          <span className="rounded-full bg-gray-100 dark:bg-gray-800 px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 capitalize">
            {hand_profile.lean}
          </span>
        )}
        <span className="text-sm text-gray-500">
          {n_sessions} session{n_sessions === 1 ? '' : 's'} · {plot.length} reliable pitches
        </span>
        <button onClick={deletePlayer}
          className="ml-auto text-xs font-medium text-red-600 dark:text-red-400 hover:underline">
          Delete player
        </button>
      </div>

      <div className="mb-5 flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {[['data', 'Data'], ['notes', `Coaching notes${suggestions?.length ? ` (${suggestions.length})` : ''}`]].map(([k, lbl]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${tab === k
              ? 'border-portal-purple text-portal-purple dark:border-portal-accent dark:text-portal-accent'
              : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}>
            {lbl}
          </button>
        ))}
      </div>

      {tab === 'notes' ? (
        <div className="space-y-6">
          <PlatoonCard platoon={platoon} />
          <CoachingNotes suggestions={suggestions} />
          <PronationCard profile={hand_profile} />
        </div>
      ) : (
      <>
      {player.mode !== 'facility' && (
        <SpringSummerCard rapsodoId={rapsodoId} player={player} school={school} onChange={refetch} />
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Movement profile</h3>
          <MovementPlot points={plot} arsenal={arsenal} onPitchClick={(p) => setRelabel(p)}
            activeId={relabel?.id} armAngle={arm?.arm_angle} hand={player.handedness}
            relabel={relabel} saving={saving}
            onPick={(label) => applyLabel(relabel.id, label)}
            onCloseRelabel={() => setRelabel(null)} />
          <p className="mt-2 text-xs text-gray-400">
            Pitcher's view, ride ↑. Shaded blobs = movement by pitch type, dots = individual pitches.
            The diagonal is the arm-angle axis — a fastball matching the slot sits along it; pitches
            off it are deviating. Rings = lower-confidence reads. Click a dot to reclassify it.
          </p>
        </div>

        <div className="lg:col-span-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              Arsenal <span className="font-normal normal-case">
                ({player.arsenal_types ? 'guided' : 're-classified by shape'})
              </span>
            </h3>
            <button onClick={() => setArsenalOpen((v) => !v)}
              className="text-xs font-medium text-portal-purple dark:text-portal-accent hover:underline">
              {player.arsenal_types ? 'Edit arsenal' : 'Set arsenal'}
            </button>
          </div>
          {arsenalOpen && (
            <ArsenalPicker current={player.arsenal_types} saving={savingArsenal}
              onApply={applyArsenal} onClose={() => setArsenalOpen(false)} />
          )}
          <ArsenalTable arsenal={arsenal} />
        </div>
      </div>

      <div className="mt-6">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Location</h3>
        <div className="flex flex-col gap-6 lg:flex-row">
          <div className="shrink-0">
            <StrikeZonePlot points={locations} />
            <p className="mt-2 max-w-[330px] text-xs text-gray-400">
              All pitches (catcher's view). Box = nominal strike zone. Warmups excluded.
            </p>
          </div>
          <LocationHeatmaps locations={locations} arsenal={arsenal} />
        </div>
      </div>

      <div className="mt-6">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Sessions</h3>
        <SessionList sessions={sessions} onDelete={deleteSession} />
      </div>

      <DevelopmentTrends trend={trend} />

      <ArmSlotPanel arm={arm} hand={player.handedness} />

      <p className="mt-6 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 px-4 py-3 text-xs text-amber-800 dark:text-amber-300">
        Shapes are tendencies, not verdicts. Pitch labels are inferred from velocity, movement,
        spin efficiency and gyro (v1), so atypical pitches can be mislabeled. Low-confidence and
        failed reads are excluded from the averages. Rapsodo infers movement from spin, so it can
        under-read seam-shifted-wake pitches (e.g. heavy sinkers).
      </p>
      </>
      )}
    </div>
  )
}

function TrendChart({ title, unit, points, color = '#378ADD', decimals = 1 }) {
  const vals = points.map((p) => p.value).filter((v) => v != null)
  const W = 240, H = 130, PAD = 26
  const n = points.length
  if (!vals.length) {
    return (
      <div>
        <div className="text-[11px] text-gray-500 mb-1">{title}</div>
        <div className="flex h-[110px] items-center justify-center rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-[11px] text-gray-400">no data</div>
      </div>
    )
  }
  const min = Math.min(...vals), max = Math.max(...vals)
  const span = (max - min) || 1
  const sx = (i) => (n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - 2 * PAD))
  const sy = (v) => H - PAD - ((v - min) / span) * (H - 2 * PAD)
  const coords = points.map((p, i) => (p.value == null ? null : [sx(i), sy(p.value)])).filter(Boolean)
  const d = coords.map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ')
  const latest = vals[vals.length - 1]
  const delta = vals.length > 1 ? latest - vals[0] : null
  return (
    <div>
      <div className="text-[11px] text-gray-500 mb-1">{title}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[260px] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        {coords.length > 1 && <path d={d} fill="none" stroke={color} strokeWidth="2" />}
        {points.map((p, i) => (p.value == null ? null : (
          <circle key={i} cx={sx(i)} cy={sy(p.value)} r="3.5" fill={color} />
        )))}
        <text x={4} y={PAD - 8} className="fill-gray-400 text-[9px]">{max.toFixed(decimals)}</text>
        <text x={4} y={H - PAD + 12} className="fill-gray-400 text-[9px]">{min.toFixed(decimals)}</text>
      </svg>
      <div className="mt-1 text-[12px] text-gray-700 dark:text-gray-300">
        latest <span className="font-medium">{latest.toFixed(decimals)}</span>{unit ? ` ${unit}` : ''}
        {delta != null && (
          <span className={`ml-1 ${delta > 0 ? 'text-green-600 dark:text-green-400' : delta < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400'}`}>
            ({delta > 0 ? '+' : ''}{delta.toFixed(decimals)})
          </span>
        )}
      </div>
    </div>
  )
}

function DevelopmentTrends({ trend }) {
  if (!trend?.length) return null
  const series = [
    { title: 'Fastball velo', unit: 'mph', key: 'fb_velo', color: '#ef4444', decimals: 1 },
    { title: 'Fastball ride (IVB)', unit: 'in', key: 'fb_ivb', color: '#378ADD', decimals: 1 },
    { title: 'Fastball spin', unit: 'rpm', key: 'fb_spin', color: '#8b5cf6', decimals: 0 },
    { title: 'Release spread (lower better)', unit: 'in', key: 'rel_consistency_in', color: '#1D9E75', decimals: 1 },
  ]
  return (
    <div className="mt-6">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Development
        {trend.length < 2 && (
          <span className="font-normal normal-case text-gray-400"> — add more sessions to track trends over time</span>
        )}
      </h3>
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {series.map((s) => (
          <TrendChart key={s.key} title={s.title} unit={s.unit} color={s.color} decimals={s.decimals}
            points={trend.map((t) => ({ date: t.session_date, value: t[s.key] }))} />
        ))}
      </div>
    </div>
  )
}

function PlatoonCard({ platoon }) {
  if (!platoon) return null
  const barColor = (s) => (s >= 75 ? '#16a34a' : s >= 55 ? '#d97706' : '#dc2626')
  const Bar = ({ label, score }) => (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>
        <span className="text-lg font-bold" style={{ color: barColor(score) }}>{score}</span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-gray-100 dark:bg-gray-800">
        <div className="h-2.5 rounded-full" style={{ width: `${score}%`, background: barColor(score) }} />
      </div>
    </div>
  )
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
      <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-gray-500">Platoon coverage</h3>
      <p className="mb-3 text-xs text-gray-400">
        How well the arsenal plays vs right- and left-handed hitters (0–100). More pitches that
        work against a side score higher — offspeed (changeup/splitter) carries opposite-handed bats,
        breaking balls bury same-handed ones, and ride fastballs &amp; cutters cover the opposite side.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Bar label="vs RHH" score={platoon.vs_rhh} />
        <Bar label="vs LHH" score={platoon.vs_lhh} />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {platoon.pitches.map((p) => {
          const d = p.vs_rhh - p.vs_lhh
          const tag = Math.abs(d) <= 15 ? 'both sides' : d > 0 ? 'vs RHH' : 'vs LHH'
          return (
            <span key={p.pitch} className="rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-0.5 text-[11px] text-gray-700 dark:text-gray-300">
              <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: colorFor(p.pitch) }} />
              {p.pitch} <span className="text-gray-400">· {tag}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

function PronationCard({ profile }) {
  if (!profile) return null
  const dotColor = (d) => (d === 'sup' ? 'bg-blue-500' : 'bg-orange-500')
  return (
    <div className="mt-6">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Pronation &amp; supination <span className="font-normal normal-case text-gray-400">(estimate)</span>
      </h3>
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-lg font-semibold capitalize text-gray-900 dark:text-gray-100">{profile.lean}</span>
          <span className="text-xs text-gray-400">
            ← pronator · {profile.score > 0 ? '+' : ''}{profile.score} · supinator →
          </span>
        </div>
        {profile.signals?.length ? (
          <ul className="space-y-1">
            {profile.signals.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                <span className={`mt-1.5 inline-block w-2 h-2 rounded-full shrink-0 ${dotColor(s.dir)}`} />
                {s.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">Not enough arsenal variety to read a lean yet.</p>
        )}
        <p className="mt-2 text-[11px] text-gray-400">
          Inferred from fastball shape, breaking-ball type, and changeup spin. Supinators pick up
          sweepers naturally; pronators pick up sinkers and kill-spin changeups.
        </p>
      </div>
    </div>
  )
}

function CoachingNotes({ suggestions }) {
  if (!suggestions?.length) return null
  const style = {
    flag: 'border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-900/20',
    strength: 'border-green-300 dark:border-green-700/60 bg-green-50 dark:bg-green-900/20',
    note: 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40',
  }
  const dot = { flag: 'bg-amber-500', strength: 'bg-green-500', note: 'bg-gray-400' }
  const label = { flag: 'Fix', strength: 'Strength', note: 'Note' }
  return (
    <div className="mb-6">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Coaching notes</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {suggestions.map((s, i) => (
          <div key={i} className={`rounded-xl border px-4 py-3 ${style[s.kind] || style.note}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className={`inline-block w-2 h-2 rounded-full ${dot[s.kind] || dot.note}`} />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label[s.kind] || label.note}</span>
              <span className="font-semibold text-gray-900 dark:text-gray-100">{s.title}</span>
            </div>
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-snug">{s.detail}</p>
            {s.caveat && <p className="mt-1.5 text-xs italic text-gray-500 dark:text-gray-400">{s.caveat}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}

function ArsenalTable({ arsenal }) {
  if (!arsenal?.length) return <p className="text-sm text-gray-500">No reliable pitches yet.</p>
  const H = 'px-2 py-1.5 font-medium'
  const C = 'px-2 py-1.5 text-right text-gray-600 dark:text-gray-400'
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 dark:bg-gray-800 text-left text-gray-500 dark:text-gray-400">
          <tr>
            <th className={H}>Pitch</th>
            <th className={`${H} text-right`}>#</th>
            <th className={`${H} text-right`}>Velo</th>
            <th className={`${H} text-right`}>Max</th>
            <th className={`${H} text-right`}>Spin</th>
            <th className={`${H} text-right`}>Eff</th>
            <th className={`${H} text-right`}>IVB</th>
            <th className={`${H} text-right`}>HB</th>
            <th className={`${H} text-right`}>VAA</th>
            <th className={H}>Tilt</th>
            <th className={`${H} text-right`}>Zone</th>
            <th className={`${H} text-right`}>Loc+†</th>
            <th className={`${H} text-right`}>Stuff*</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {arsenal.map((a) => (
            <tr key={a.pitch} className="bg-white dark:bg-gray-900">
              <td className="px-2 py-1.5 font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">
                <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: colorFor(a.pitch) }} />
                {a.pitch}
              </td>
              <td className={C}>{a.count}</td>
              <td className={C}>{fmt(a.velo)}</td>
              <td className={C}>{fmt(a.velo_max)}</td>
              <td className={C}>{a.total_spin ?? '–'}</td>
              <td className={C}>{fmt(a.spin_eff, 0)}</td>
              <td className={C}>{fmt(a.ivb)}</td>
              <td className={C}>{fmt(a.arm_hb)}</td>
              <td className={C}>{a.vaa == null ? '–' : `${fmt(a.vaa)}°`}</td>
              <td className="px-2 py-1.5 text-gray-600 dark:text-gray-400 whitespace-nowrap">{a.tilt || '–'}</td>
              <td className={C}>{a.zone_pct == null ? '–' : `${a.zone_pct}%`}</td>
              <td className={`px-2 py-1.5 text-right font-medium ${a.loc_plus == null ? 'text-gray-400' : a.loc_plus >= 100 ? 'text-green-600 dark:text-green-400' : 'text-gray-600 dark:text-gray-400'}`}>
                {a.loc_plus ?? '–'}
              </td>
              <td
                title={a.stuff_components ? Object.entries(a.stuff_components).map(([k, v]) => `${k}: ${v > 0 ? '+' : ''}${v}`).join('\n') : ''}
                className={`px-2 py-1.5 text-right font-medium ${a.stuff == null ? 'text-gray-400' : a.stuff >= 100 ? 'text-green-600 dark:text-green-400' : 'text-gray-600 dark:text-gray-400'}`}>
                {a.stuff ?? '–'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-[11px] text-gray-400">
        * Stuff: graded by our WCL TrackMan model (trained on whiff + chase vs good college
        competition), with bandages for Rapsodo's measurement differences. 100 = WCL average
        <em>for that pitch type</em>; not comparable across types; ignores command. Hover a score
        for its breakdown. The same model grades TrackMan and Rapsodo across the site.
      </p>
      <p className="px-3 pb-2 text-[11px] text-gray-400">
        † Loc+ (v1): a command score, 100 = provisional average. Rewards hitting each pitch
        type's height target (fastball up, breaking ball down, etc.) and living on the zone
        edges; penalizes middle-middle and non-competitive misses. No hitter/count in a bullpen,
        so horizontal is judged as edge-vs-heart, not in/out. Tunes as data grows.
      </p>
    </div>
  )
}

function SessionList({ sessions, onDelete }) {
  if (!sessions?.length) return null
  return (
    <ul className="space-y-2">
      {sessions.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm">
          <span className="font-medium text-gray-900 dark:text-gray-100">{s.session_date || 'undated'}</span>
          <span className="text-gray-500">{s.device_generation}</span>
          {s.intent_tags && <span className="rounded bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-300">{s.intent_tags}</span>}
          <span className="text-gray-500">FB ~{fmt(s.fastball_velo)} mph</span>
          <span className="ml-auto text-xs text-gray-400">
            {s.qc_ok} clean
            {s.qc_warmup ? ` · ${s.qc_warmup} warmup` : ''}
            {' · '}{s.qc_low_confidence + s.qc_partial + s.qc_failed} flagged · {s.n_pitches} total
          </span>
          {onDelete && (
            <button onClick={() => onDelete(s.id)} title="Delete session"
              className="text-xs text-gray-400 hover:text-red-600 dark:hover:text-red-400">✕</button>
          )}
        </li>
      ))}
    </ul>
  )
}

// ─────────────────────────── Guided arsenal picker ─────────────────────────
function ArsenalPicker({ current, saving, onApply, onClose }) {
  const initial = current ? current.split(',').map((s) => s.trim()).filter(Boolean) : []
  const [sel, setSel] = useState(new Set(initial))
  const toggle = (t) => setSel((prev) => {
    const n = new Set(prev)
    n.has(t) ? n.delete(t) : n.add(t)
    return n
  })
  return (
    <div className="mb-3 rounded-xl border border-portal-purple/40 dark:border-portal-accent/40 bg-white dark:bg-gray-900 p-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300">Which pitches does he throw?</div>
        <button type="button" onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
      </div>
      <p className="mb-2 text-xs text-gray-400">
        Tick every pitch in his arsenal. The model then buckets each pitch into only those types
        (snapping outliers to the nearest one). Manual per-pitch fixes still win.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {PITCH_TYPES.map((t) => (
          <button key={t} type="button" disabled={saving} onClick={() => toggle(t)}
            className={`px-2 py-1 rounded text-xs border ${sel.has(t) ? 'border-portal-purple bg-portal-purple/10 text-gray-900 dark:text-gray-100' : 'border-gray-200 dark:border-gray-700 hover:border-portal-purple text-gray-600 dark:text-gray-400'} disabled:opacity-50`}>
            <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: colorFor(t) }} />{t}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" disabled={saving || sel.size === 0} onClick={() => onApply([...sel])}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-portal-purple text-white hover:bg-portal-purple/90 disabled:opacity-40">
          {saving ? 'Applying…' : `Apply (${sel.size})`}
        </button>
        {current && (
          <button type="button" disabled={saving} onClick={() => onApply([])}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-500 hover:border-gray-400 disabled:opacity-50">
            ↺ Clear (auto-classify)
          </button>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────── Movement plot (SVG) ───────────────────────────
function MovementPlot({ points, arsenal, onPitchClick, activeId, armAngle, hand, relabel, saving, onPick, onCloseRelabel }) {
  const W = 380, H = 380, PAD = 30, DOM = 26
  const sx = (v) => PAD + ((v + DOM) / (2 * DOM)) * (W - 2 * PAD)
  const sy = (v) => PAD + ((DOM - v) / (2 * DOM)) * (H - 2 * PAD)
  const ticks = [-20, -10, 0, 10, 20]
  // Real horizontal break: RHP arm side to the right, LHP arm side to the left.
  // (`arm_hb` is arm-normalized, so flip lefties back to true orientation.)
  const hbSign = hand === 'L' ? -1 : 1
  const dx = (armhb) => sx(armhb * hbSign)

  // Movement blobs: one large, lightly shaded circle per pitch type, sized to the
  // cluster's spread, so the eye reads pitch-type movement separately from the dots.
  const groups = {}
  for (const p of points) {
    if (p.quality === 'ok' && p.pitch && p.pitch !== 'unclassified' && p.arm_hb != null && p.ivb != null) {
      (groups[p.pitch] ||= []).push(p)
    }
  }
  const blobs = Object.entries(groups).filter(([, ps]) => ps.length >= 2).map(([pitch, ps]) => {
    const cxx = ps.reduce((s, p) => s + dx(p.arm_hb), 0) / ps.length
    const cyy = ps.reduce((s, p) => s + sy(p.ivb), 0) / ps.length
    const rms = Math.sqrt(ps.reduce((s, p) => s + (dx(p.arm_hb) - cxx) ** 2 + (sy(p.ivb) - cyy) ** 2, 0) / ps.length)
    return { pitch, cxx, cyy, r: Math.max(15, Math.min(72, rms * 1.5)) }
  })

  // Arm-angle axis: line through the origin at the arm angle, into the arm-side/ride
  // quadrant. A spin-efficient fastball for this slot lands along it.
  let axis = null
  if (armAngle != null) {
    const th = (armAngle * Math.PI) / 180
    const ax = hbSign * DOM * Math.cos(th), ay = DOM * Math.sin(th)
    axis = { x1: sx(-ax), y1: sy(-ay), x2: sx(ax), y2: sy(ay), label: `arm slot ${angleBand(armAngle).label}` }
  }

  // On-graph reclassify popup: anchored at the clicked dot, growing toward the
  // plot center so it stays in bounds.
  let pop = null
  if (relabel && relabel.arm_hb != null && relabel.ivb != null) {
    const lp = (sx(relabel.arm_hb * hbSign) / W) * 100
    const tp = (sy(relabel.ivb) / H) * 100
    pop = {
      left: `${lp}%`, top: `${tp}%`,
      transform: `translate(${lp > 50 ? 'calc(-100% - 7px)' : '7px'}, ${tp > 55 ? 'calc(-100% - 7px)' : '7px'})`,
    }
  }

  return (
   <div className="relative w-full max-w-[420px]">
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
      {/* gridlines */}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={sx(t)} y1={PAD} x2={sx(t)} y2={H - PAD} className="stroke-gray-100 dark:stroke-gray-800" strokeWidth="1" />
          <line x1={PAD} y1={sy(t)} x2={W - PAD} y2={sy(t)} className="stroke-gray-100 dark:stroke-gray-800" strokeWidth="1" />
        </g>
      ))}
      {/* axes through zero */}
      <line x1={sx(0)} y1={PAD} x2={sx(0)} y2={H - PAD} className="stroke-gray-300 dark:stroke-gray-600" strokeWidth="1.5" />
      <line x1={PAD} y1={sy(0)} x2={W - PAD} y2={sy(0)} className="stroke-gray-300 dark:stroke-gray-600" strokeWidth="1.5" />
      {ticks.filter((t) => t !== 0).map((t) => (
        <g key={`l${t}`}>
          <text x={sx(t)} y={sy(0) + 12} textAnchor="middle" className="fill-gray-400 text-[9px]">{t}</text>
          <text x={sx(0) - 5} y={sy(t) + 3} textAnchor="end" className="fill-gray-400 text-[9px]">{t}</text>
        </g>
      ))}
      {/* arm-angle axis (drawn under the data); label sits at the bottom, clear of data */}
      {axis && (
        <line x1={axis.x1} y1={axis.y1} x2={axis.x2} y2={axis.y2}
          className="stroke-gray-400 dark:stroke-gray-500" strokeWidth="1.5" strokeDasharray="5 4" opacity="0.7" />
      )}
      {/* movement blobs per pitch type */}
      {blobs.map((b) => (
        <circle key={b.pitch} cx={b.cxx} cy={b.cyy} r={b.r}
          fill={colorFor(b.pitch)} fillOpacity="0.1" stroke={colorFor(b.pitch)} strokeOpacity="0.35" strokeWidth="1" />
      ))}
      {/* per-pitch dots — lighter; clickable to reclassify; thick ring = manual
          override; removed/misread pitches show faint + dashed grey */}
      {points.map((p, i) => (
        <circle
          key={p.id ?? i}
          cx={dx(p.arm_hb)}
          cy={sy(p.ivb)}
          r={p.id === activeId ? 6 : (p.quality === 'ok' ? 3.5 : 3)}
          fill={p.quality === 'ok' ? colorFor(p.pitch) : 'none'}
          stroke={p.id === activeId ? '#111827' : (p.excluded ? '#9ca3af' : colorFor(p.pitch))}
          strokeWidth={p.manual && !p.excluded ? 2.75 : (p.id === activeId ? 2 : 1.25)}
          strokeDasharray={p.excluded ? '2 2' : undefined}
          fillOpacity={p.id === activeId ? 0.85 : 0.45}
          opacity={p.excluded ? 0.5 : 1}
          style={{ cursor: onPitchClick ? 'pointer' : 'default' }}
          onClick={() => onPitchClick && onPitchClick(p)}
        />
      ))}
      <text x={hbSign === 1 ? W - PAD : PAD} y={sy(0) - 5} textAnchor={hbSign === 1 ? 'end' : 'start'}
        className="fill-gray-400 text-[9px]">{hbSign === 1 ? 'arm side →' : '← arm side'}</text>
      <text x={sx(0) + 4} y={PAD + 8} className="fill-gray-400 text-[9px]">ride ↑</text>
      {axis && (
        <text x={W / 2} y={H - 9} textAnchor="middle" className="fill-gray-400 text-[10px] font-medium">{axis.label}</text>
      )}
    </svg>

    {relabel && pop && (
      <PitchPopup point={relabel} saving={saving} onPick={onPick} onClose={onCloseRelabel} pos={pop} />
    )}
   </div>
  )
}

// On-graph popup: the clicked pitch's metrics + reclassify options.
const EXCLUDE = '__exclude__'

function PitchPopup({ point, saving, onPick, onClose, pos }) {
  const Stat = ({ label, value }) => (
    <div className="text-center">
      <div className="text-[9px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-xs font-semibold text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  )
  const excluded = point.excluded
  return (
    <div className="absolute z-10 w-[244px] rounded-xl border border-portal-purple/50 dark:border-portal-accent/50 bg-white dark:bg-gray-900 p-2.5 shadow-lg"
      style={{ left: pos.left, top: pos.top, transform: pos.transform }}>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
          {excluded
            ? <span className="text-gray-500">{point.pitch === 'misread' ? 'Flagged misread' : 'Removed'}</span>
            : <><span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: colorFor(point.pitch) }} />
                {point.pitch}{point.manual ? ' · manual' : ''}</>}
        </div>
        <button type="button" onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
      </div>
      <div className="mb-2 grid grid-cols-4 gap-1 rounded-lg bg-gray-50 dark:bg-gray-800/60 py-1.5">
        <Stat label="Velo" value={fmt(point.velo, 1)} />
        <Stat label="IVB" value={fmt(point.ivb, 1)} />
        <Stat label="HB" value={fmt(point.arm_hb, 1)} />
        <Stat label="Spin" value={point.spin != null ? Math.round(point.spin) : '–'} />
      </div>
      {excluded && (
        <div className="mb-1.5 text-[11px] text-gray-400">Excluded from the arsenal &amp; grades. Assign a type to restore it.</div>
      )}
      <div className="flex flex-wrap gap-1">
        {PITCH_TYPES.map((t) => (
          <button key={t} type="button" disabled={saving} onClick={() => onPick(t)}
            className={`px-1.5 py-0.5 rounded text-[11px] border ${t === point.pitch ? 'border-portal-purple bg-portal-purple/10' : 'border-gray-200 dark:border-gray-700 hover:border-portal-purple'} text-gray-700 dark:text-gray-300 disabled:opacity-50`}>
            <span className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle" style={{ background: colorFor(t) }} />{t}
          </button>
        ))}
        {point.manual && !excluded && (
          <button type="button" disabled={saving} onClick={() => onPick(null)}
            className="px-1.5 py-0.5 rounded text-[11px] border border-gray-200 dark:border-gray-700 text-gray-500 hover:border-gray-400 disabled:opacity-50">
            ↺ auto
          </button>
        )}
        {excluded
          ? <button type="button" disabled={saving} onClick={() => onPick(null)}
              className="px-1.5 py-0.5 rounded text-[11px] border border-gray-200 dark:border-gray-700 text-gray-500 hover:border-gray-400 disabled:opacity-50">
              ↺ back to auto
            </button>
          : <button type="button" disabled={saving} onClick={() => onPick(EXCLUDE)}
              className="px-1.5 py-0.5 rounded text-[11px] border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:border-red-400 disabled:opacity-50">
              ✕ remove (misread)
            </button>}
      </div>
    </div>
  )
}

// Per-pitch-type location heatmaps (catcher's view). KDE density over the plate.
function LocationHeatmaps({ locations, arsenal }) {
  const groups = {}
  for (const l of locations || []) {
    if (l.sz_side != null && l.sz_height != null && l.pitch) (groups[l.pitch] ||= []).push(l)
  }
  const types = Object.entries(groups).filter(([, ls]) => ls.length >= 4)
    .sort((a, b) => b[1].length - a[1].length)
  if (!types.length) return null
  const meta = {}
  for (const a of arsenal || []) meta[a.pitch] = { zone: a.zone_pct, loc: a.loc_plus }
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">By pitch type</div>
      <div className="flex flex-wrap gap-3">
        {types.map(([pitch, ls]) => <Heatmap key={pitch} pitch={pitch} pts={ls} meta={meta[pitch]} />)}
      </div>
      <p className="mt-2 text-xs text-gray-400">
        Plate-location density per pitch type. Box = strike zone. Needs ≥4 reliable locations.
      </p>
    </div>
  )
}

function Heatmap({ pitch, pts, meta }) {
  const W = 132, H = 164, PAD = 8
  const XMIN = -18, XMAX = 18, YMIN = 8, YMAX = 52
  const sx = (v) => PAD + ((v - XMIN) / (XMAX - XMIN)) * (W - 2 * PAD)
  const sy = (v) => PAD + ((YMAX - v) / (YMAX - YMIN)) * (H - 2 * PAD)
  const NX = 16, NY = 20, bw = 4.2
  const cw = (W - 2 * PAD) / NX, ch = (H - 2 * PAD) / NY
  const cells = []
  let max = 0
  for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
    const cx = XMIN + ((i + 0.5) / NX) * (XMAX - XMIN)
    const cy = YMIN + ((j + 0.5) / NY) * (YMAX - YMIN)
    let d = 0
    for (const p of pts) { const ax = p.sz_side - cx, ay = p.sz_height - cy; d += Math.exp(-(ax * ax + ay * ay) / (2 * bw * bw)) }
    cells.push([i, j, d]); if (d > max) max = d
  }
  const col = colorFor(pitch)
  const zx = sx(-8.5), zw = sx(8.5) - sx(-8.5), zy = sy(42), zh = sy(18) - sy(42)
  return (
    <div className="text-center" style={{ flex: '1 1 190px', maxWidth: '340px' }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        {cells.map(([i, j, d], k) => {
          const o = max > 0 ? Math.pow(d / max, 0.7) * 0.92 : 0
          return o < 0.05 ? null : (
            <rect key={k} x={PAD + i * cw} y={PAD + (NY - 1 - j) * ch} width={cw + 0.6} height={ch + 0.6}
              fill={col} fillOpacity={o} />
          )
        })}
        <rect x={zx} y={zy} width={zw} height={zh} className="fill-none stroke-gray-500 dark:stroke-gray-400" strokeWidth="1.25" />
      </svg>
      <div className="mt-1 text-[11px] font-medium" style={{ color: col }}>
        {pitch} <span className="text-gray-400 font-normal">({pts.length})</span>
      </div>
      {meta && (meta.zone != null || meta.loc != null) && (
        <div className="text-[10px] text-gray-500 dark:text-gray-400">
          {meta.zone != null && `Zone ${meta.zone}%`}
          {meta.zone != null && meta.loc != null && ' · '}
          {meta.loc != null && `Loc+ ${meta.loc}`}
        </div>
      )}
    </div>
  )
}

// Strike-zone / location plot. sz_side (horizontal in) on x, sz_height (in) on y.
function StrikeZonePlot({ points }) {
  const W = 300, H = 360, PAD = 26
  const XMIN = -18, XMAX = 18, YMIN = 8, YMAX = 52
  const sx = (v) => PAD + ((v - XMIN) / (XMAX - XMIN)) * (W - 2 * PAD)
  const sy = (v) => PAD + ((YMAX - v) / (YMAX - YMIN)) * (H - 2 * PAD)
  const clamp = (px, lo, hi) => Math.max(lo, Math.min(hi, px))
  if (!points?.length) {
    return (
      <div className="flex h-[200px] items-center justify-center rounded-xl border border-dashed border-gray-300 dark:border-gray-600 text-xs text-gray-400 text-center px-4">
        No location data yet. Re-upload this player's session to capture plate location.
      </div>
    )
  }
  // nominal zone: 17" wide (±8.5), knees ~18" to letters ~42"
  const zx = sx(-8.5), zw = sx(8.5) - sx(-8.5), zy = sy(42), zh = sy(18) - sy(42)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[330px] rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
      <rect x={zx} y={zy} width={zw} height={zh} className="fill-none stroke-gray-400 dark:stroke-gray-500" strokeWidth="1.5" />
      {/* zone thirds */}
      <line x1={zx + zw / 3} y1={zy} x2={zx + zw / 3} y2={zy + zh} className="stroke-gray-200 dark:stroke-gray-700" strokeWidth="1" />
      <line x1={zx + (2 * zw) / 3} y1={zy} x2={zx + (2 * zw) / 3} y2={zy + zh} className="stroke-gray-200 dark:stroke-gray-700" strokeWidth="1" />
      <line x1={zx} y1={zy + zh / 3} x2={zx + zw} y2={zy + zh / 3} className="stroke-gray-200 dark:stroke-gray-700" strokeWidth="1" />
      <line x1={zx} y1={zy + (2 * zh) / 3} x2={zx + zw} y2={zy + (2 * zh) / 3} className="stroke-gray-200 dark:stroke-gray-700" strokeWidth="1" />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={clamp(sx(p.sz_side), 4, W - 4)}
          cy={clamp(sy(p.sz_height), 4, H - 4)}
          r="4"
          fill={colorFor(p.pitch)}
          fillOpacity={p.is_strike === 'Y' ? 0.85 : 0.4}
          stroke={colorFor(p.pitch)}
          strokeWidth="1"
        />
      ))}
    </svg>
  )
}

// Release-point plot: rel_side (ft) on x, rel_height (ft) on y, catcher's view.
function ReleasePlot({ points }) {
  const W = 200, H = 200, PAD = 22
  const XMIN = -3.5, XMAX = 3.5, YMIN = 3, YMAX = 7
  const sx = (v) => PAD + ((v - XMIN) / (XMAX - XMIN)) * (W - 2 * PAD)
  const sy = (v) => PAD + ((YMAX - v) / (YMAX - YMIN)) * (H - 2 * PAD)
  if (!points?.length) return null
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[220px] rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
      <line x1={sx(0)} y1={PAD} x2={sx(0)} y2={H - PAD} className="stroke-gray-200 dark:stroke-gray-700" strokeWidth="1" />
      {points.map((p, i) => (
        <circle key={i} cx={sx(p.rel_side)} cy={sy(p.rel_height)} r="3.5"
          fill={colorFor(p.pitch)} fillOpacity="0.7" stroke={colorFor(p.pitch)} strokeWidth="1" />
      ))}
      <text x={W - 6} y={H - 6} textAnchor="end" className="fill-gray-400 text-[9px]">side (ft)</text>
      <text x={6} y={14} className="fill-gray-400 text-[9px]">height (ft)</text>
    </svg>
  )
}

// Savant-style arm-slot figure: a stylized pitcher with the throwing arm raised
// to the estimated arm angle. Front (home-plate) view, so a RHP's arm is on the
// viewer's left. Illustrative — the angle is a geometric estimate (see backend).
function ArmFigure({ angle, hand }) {
  if (angle == null) return null
  const band = angleBand(angle)
  const armDir = hand === 'L' ? 1 : -1      // RHP arm to viewer-left, LHP to right
  const CX = 90, shY = 100, shX = CX + armDir * 12, L = 60
  const hand_at = (deg) => {
    const a = (deg * Math.PI) / 180
    return [shX + armDir * L * Math.cos(a), shY - L * Math.sin(a)]
  }
  const [hx, hy] = hand_at(angle)
  const [lx, ly] = hand_at(band.lo)
  const [ux, uy] = hand_at(band.hi)
  return (
    <svg viewBox="0 0 180 212" className="w-full max-w-[200px] rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
      <line x1="18" y1="197" x2="162" y2="197" className="stroke-gray-200 dark:stroke-gray-700" strokeWidth="2" />
      <path d="M82 150 L74 196 M98 150 L106 196" className="stroke-gray-300 dark:stroke-gray-600" strokeWidth="9" strokeLinecap="round" fill="none" />
      <path d="M76 98 Q90 90 104 98 L100 150 Q90 157 80 150 Z" className="fill-gray-300 dark:fill-gray-600" />
      <circle cx={CX} cy="76" r="13" className="fill-gray-300 dark:fill-gray-600" />
      {/* glove (non-throwing) arm hanging */}
      <path d={`M${CX - armDir * 12} 102 q ${-armDir * 13} 17 ${-armDir * 5} 35`} className="stroke-gray-300 dark:stroke-gray-600" strokeWidth="8" strokeLinecap="round" fill="none" />
      {/* uncertainty wedge (±5°) */}
      <path d={`M${shX} ${shY} L${lx} ${ly} A${L} ${L} 0 0 ${armDir === 1 ? 1 : 0} ${ux} ${uy} Z`}
        className="fill-portal-purple/15 dark:fill-portal-accent/20" />
      {/* throwing arm + ball at the midpoint of the band */}
      <line x1={shX} y1={shY} x2={hx} y2={hy} className="stroke-portal-purple dark:stroke-portal-accent" strokeWidth="9" strokeLinecap="round" />
      <circle cx={hx} cy={hy} r="6" className="fill-white dark:fill-gray-900 stroke-portal-purple dark:stroke-portal-accent" strokeWidth="2" />
      {/* angle label in the top corner OPPOSITE the throwing arm, clear of the figure */}
      <text x={armDir === -1 ? 170 : 10} y={28} textAnchor={armDir === -1 ? 'end' : 'start'}
        className="fill-gray-600 dark:fill-gray-300 text-[12px] font-semibold">≈{band.label}</text>
    </svg>
  )
}

function ArmSlotPanel({ arm, hand }) {
  if (!arm) return null
  const Metric = ({ label, value }) => (
    <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 px-3 py-2">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  )
  const spread = Math.max(arm.rel_height_sd || 0, arm.rel_side_sd || 0) * 12
  return (
    <div className="mt-6">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Arm slot &amp; release</h3>
      <div className="grid gap-4 lg:grid-cols-4">
        <div>
          <ArmFigure angle={arm.arm_angle} hand={hand} />
          <p className="mt-1 text-xs text-gray-400">
            Estimated arm angle ({arm.slot}). A rough ±5° band — rubber position and release
            data shift it, so read it as a range, not an exact number.
          </p>
        </div>
        <div>
          <ReleasePlot points={arm.points} />
          <p className="mt-1 text-xs text-gray-400">Release point per pitch (catcher's view). Tight clusters tunnel better.</p>
        </div>
        <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-3 gap-2 content-start">
          <Metric label="Arm angle (approx)" value={arm.arm_angle != null ? angleBand(arm.arm_angle).label : '–'} />
          <Metric label="Slot (approx)" value={arm.slot || '–'} />
          <Metric label="Release height" value={arm.rel_height != null ? `${fmt(arm.rel_height, 2)} ft` : '–'} />
          <Metric label="Release side" value={arm.rel_side != null ? `${fmt(arm.rel_side, 2)} ft` : '–'} />
          <Metric label="Consistency" value={`${arm.consistency} (±${fmt(spread, 1)} in)`} />
          <Metric label="Extension" value={arm.extension != null ? `${fmt(arm.extension, 2)} ft` : '–'} />
          <Metric label="Avg VAA" value={arm.vaa != null ? `${fmt(arm.vaa, 1)}°` : '–'} />
        </div>
      </div>
    </div>
  )
}
