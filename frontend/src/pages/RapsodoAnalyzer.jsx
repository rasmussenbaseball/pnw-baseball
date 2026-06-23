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

import { useState } from 'react'
import { useApi } from '../hooks/useApi'
import { supabase } from '../lib/supabase'

const PITCH_COLORS = {
  '4-seam (ride)': '#e11d48',
  'fastball (mixed)': '#ef4444',
  'sinker / 2-seam': '#f59e0b',
  'cutter': '#8b5cf6',
  'slider': '#3b82f6',
  'sweeper': '#14b8a6',
  'gyro slider': '#6366f1',
  'curveball': '#22c55e',
  'changeup': '#ec4899',
  'unclassified': '#9ca3af',
}
const colorFor = (p) => PITCH_COLORS[p] || '#9ca3af'
const fmt = (v, d = 1) => (v === null || v === undefined ? '–' : Number(v).toFixed(d))
const handLabel = (h) => ({ R: 'RHP', L: 'LHP' }[h] || '—')

export default function RapsodoAnalyzer() {
  const [selected, setSelected] = useState(null)
  const { data, loading, refetch } = useApi('/rapsodo/players')
  const players = data?.players || []

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-portal-purple dark:text-portal-accent">
          Rapsodo Lab
        </h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          Upload your bullpen sessions. We clean the data, re-classify every pitch by its
          actual shape, and build a profile for each of your players.
        </p>
      </header>

      <UploadZone onDone={refetch} />

      {selected ? (
        <PlayerProfile rapsodoId={selected} onBack={() => setSelected(null)} />
      ) : (
        <Roster players={players} loading={loading} onPick={setSelected} />
      )}
    </div>
  )
}

// ─────────────────────────────── Upload ───────────────────────────────
function UploadZone({ onDone }) {
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
function PlayerProfile({ rapsodoId, onBack }) {
  const { data, loading } = useApi(`/rapsodo/players/${rapsodoId}`)

  if (loading) return <p className="mt-6 text-gray-500">Loading profile…</p>
  if (!data) return null
  const { player, arsenal, plot, locations, arm, hand_profile, sessions, n_sessions, suggestions } = data

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
      </div>

      <CoachingNotes suggestions={suggestions} />

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2 space-y-6">
          <div>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Movement profile</h3>
            <MovementPlot points={plot} arsenal={arsenal} />
            <p className="mt-2 text-xs text-gray-400">
              Pitcher's view: arm side →, ride ↑. One dot per pitch; rings = lower-confidence reads.
            </p>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Location</h3>
            <StrikeZonePlot points={locations} />
            <p className="mt-2 text-xs text-gray-400">
              Plate-crossing point per pitch (catcher's view). Box = nominal strike zone. Warmups excluded.
            </p>
          </div>
        </div>

        <div className="lg:col-span-3">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Arsenal <span className="font-normal normal-case">(re-classified by shape)</span>
          </h3>
          <ArsenalTable arsenal={arsenal} />
          <h3 className="mt-6 mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Sessions</h3>
          <SessionList sessions={sessions} />
        </div>
      </div>

      <ArmSlotPanel arm={arm} />

      <PronationCard profile={hand_profile} />

      <p className="mt-6 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 px-4 py-3 text-xs text-amber-800 dark:text-amber-300">
        Shapes are tendencies, not verdicts. Pitch labels are inferred from velocity, movement,
        spin efficiency and gyro (v1), so atypical pitches can be mislabeled. Low-confidence and
        failed reads are excluded from the averages. Rapsodo infers movement from spin, so it can
        under-read seam-shifted-wake pitches (e.g. heavy sinkers).
      </p>
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
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 dark:bg-gray-800 text-left text-gray-500 dark:text-gray-400">
          <tr>
            <th className="px-3 py-2 font-medium">Pitch</th>
            <th className="px-3 py-2 font-medium text-right">#</th>
            <th className="px-3 py-2 font-medium text-right">Velo</th>
            <th className="px-3 py-2 font-medium text-right">Max</th>
            <th className="px-3 py-2 font-medium text-right">Spin</th>
            <th className="px-3 py-2 font-medium text-right">Eff%</th>
            <th className="px-3 py-2 font-medium text-right">IVB</th>
            <th className="px-3 py-2 font-medium text-right">Arm HB</th>
            <th className="px-3 py-2 font-medium">Tilt</th>
            <th className="px-3 py-2 font-medium text-right">Stuff*</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {arsenal.map((a) => (
            <tr key={a.pitch} className="bg-white dark:bg-gray-900">
              <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">
                <span className="inline-block w-2.5 h-2.5 rounded-full mr-2 align-middle" style={{ background: colorFor(a.pitch) }} />
                {a.pitch}
              </td>
              <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{a.count}</td>
              <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{fmt(a.velo)}</td>
              <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{fmt(a.velo_max)}</td>
              <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{a.total_spin ?? '–'}</td>
              <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{fmt(a.spin_eff, 0)}</td>
              <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{fmt(a.ivb)}</td>
              <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{fmt(a.arm_hb)}</td>
              <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{a.tilt || '–'}</td>
              <td
                title={a.stuff_components ? Object.entries(a.stuff_components).map(([k, v]) => `${k}: ${v > 0 ? '+' : ''}${v}`).join('\n') : ''}
                className={`px-3 py-2 text-right font-medium ${a.stuff == null ? 'text-gray-400' : a.stuff >= 100 ? 'text-green-600 dark:text-green-400' : 'text-gray-600 dark:text-gray-400'}`}>
                {a.stuff ?? '–'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-[11px] text-gray-400">
        * Stuff (v1): research-grounded shape grade, 100 = average <em>for that pitch type</em>
        (college-provisional anchors). Built from published Stuff+ effect sizes (velocity,
        ride, extension, and a secondary's separation off the fastball). Not comparable across
        pitch types; ignores command. Hover a score for its breakdown. Recalibrates as data grows.
      </p>
    </div>
  )
}

function SessionList({ sessions }) {
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
        </li>
      ))}
    </ul>
  )
}

// ─────────────────────────── Movement plot (SVG) ───────────────────────────
function MovementPlot({ points, arsenal }) {
  const W = 380, H = 380, PAD = 30, DOM = 26
  const sx = (v) => PAD + ((v + DOM) / (2 * DOM)) * (W - 2 * PAD)
  const sy = (v) => PAD + ((DOM - v) / (2 * DOM)) * (H - 2 * PAD)
  const ticks = [-20, -10, 0, 10, 20]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[420px] rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
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
      {/* per-pitch dots */}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={sx(p.arm_hb)}
          cy={sy(p.ivb)}
          r={p.quality === 'ok' ? 4 : 3.5}
          fill={p.quality === 'ok' ? colorFor(p.pitch) : 'none'}
          stroke={colorFor(p.pitch)}
          strokeWidth="1.5"
          fillOpacity="0.75"
        />
      ))}
      {/* centroid labels — only meaningful clusters, to avoid overlap */}
      {arsenal?.filter((a) => a.count >= 2 && a.pitch !== 'unclassified').map((a) => (
        a.arm_hb === null || a.ivb === null ? null : (
          <text
            key={a.pitch}
            x={sx(a.arm_hb)}
            y={sy(a.ivb) - 7}
            textAnchor="middle"
            className="text-[9px] font-semibold"
            style={{ fill: colorFor(a.pitch) }}
          >
            {a.pitch.replace(' / 2-seam', '').replace('fastball (mixed)', 'FB')}
          </text>
        )
      ))}
      <text x={W - PAD} y={sy(0) - 5} textAnchor="end" className="fill-gray-400 text-[9px]">arm side →</text>
      <text x={sx(0) + 4} y={PAD + 8} className="fill-gray-400 text-[9px]">ride ↑</text>
    </svg>
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

function ArmSlotPanel({ arm }) {
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
      <div className="grid gap-4 lg:grid-cols-3">
        <div>
          <ReleasePlot points={arm.points} />
          <p className="mt-1 text-xs text-gray-400">Release point per pitch (catcher's view). Tight clusters tunnel better.</p>
        </div>
        <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-3 gap-2 content-start">
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
