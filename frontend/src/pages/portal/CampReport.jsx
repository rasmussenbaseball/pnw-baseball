// Camp Report — prospect camp workspace + one-page printable report.
//
// Coaches create a camp, upload its Blast Motion / TrackMan BP / TrackMan
// game CSVs, pick an attendee from the dropdown, type in bio + field
// measurables (60yd, IF/OF velo, pop time) + development notes, and
// download a one-page report styled like the Custom Player Card
// (.custom-card-page + data-scale-content, so Save PDF = native
// full-bleed print and Save image = the card export pipeline).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useApi } from '../../hooks/useApi'
import { supabase } from '../../lib/supabase'
import { usePortalTeam } from '../../context/PortalTeamContext'
import ReportActions from '../../components/ReportActions'

async function authHeaders() {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function api(method, url, body, isForm = false) {
  const headers = await authHeaders()
  if (!isForm) headers['Content-Type'] = 'application/json'
  const r = await fetch(`/api/v1${url}`, {
    method, headers, body: isForm ? body : (body ? JSON.stringify(body) : undefined),
  })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`)
  return r.json()
}

const BIO_FIELDS = [
  ['position', 'Position', 'SS / RHP'],
  ['bats', 'Bats', 'R / L / S'],
  ['throws', 'Throws', 'R / L'],
  ['height', 'Height', `6'1"`],
  ['weight', 'Weight', '185'],
  ['grad_year', 'Grad year', '2027'],
  ['school', 'School', 'Sheldon HS'],
  ['hometown', 'Hometown', 'Eugene'],
  ['state', 'State', 'OR'],
]
const MEASURABLE_FIELDS = [
  ['sixty_time', '60-yd dash', '6.95'],
  ['if_velo', 'IF velo (mph)', '82'],
  ['of_velo', 'OF velo (mph)', '85'],
  ['pop_time', 'Pop time', '2.05'],
]

export default function CampReport() {
  const { team } = usePortalTeam()
  const { data: campsData, refetch: refetchCamps } = useApi('/portal/camps')
  const camps = campsData?.camps || []
  const [campId, setCampId] = useState(null)
  const [newCamp, setNewCamp] = useState({ name: '', camp_date: '' })
  const [uploadLog, setUploadLog] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [players, setPlayers] = useState([])
  const [selKey, setSelKey] = useState('')
  const [report, setReport] = useState(null)
  const [form, setForm] = useState({})
  const [saved, setSaved] = useState(false)
  const [newName, setNewName] = useState('')
  const blastNameRef = useRef(null)
  const pageRef = useRef(null)

  useEffect(() => {
    if (!campId && camps.length) setCampId(camps[0].id)
  }, [camps, campId])

  async function loadPlayers(cid = campId) {
    if (!cid) return
    const d = await api('GET', `/portal/camps/${cid}/players`)
    setPlayers(d.players || [])
  }
  useEffect(() => { setPlayers([]); setSelKey(''); setReport(null); if (campId) loadPlayers() }, [campId])  // eslint-disable-line

  async function loadReport(key) {
    setSelKey(key); setReport(null); setSaved(false)
    if (!key) return
    const d = await api('GET', `/portal/camps/${campId}/players/${key}/report`)
    setReport(d)
    const f = {}
    for (const [k] of [...BIO_FIELDS, ...MEASURABLE_FIELDS]) f[k] = d.player?.[k] || ''
    f.notes = d.player?.notes || ''
    setForm(f)
  }

  async function createCamp() {
    if (!newCamp.name.trim()) return
    setBusy(true); setError('')
    try {
      const d = await api('POST', '/portal/camps', { name: newCamp.name, camp_date: newCamp.camp_date || null })
      setNewCamp({ name: '', camp_date: '' })
      await refetchCamps(); setCampId(d.id)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  async function upload(fileList, blastPlayer) {
    if (!fileList?.length || !campId) return
    setBusy(true); setError('')
    try {
      const fd = new FormData()
      for (const f of fileList) fd.append('files', f)
      if (blastPlayer) fd.append('blast_player', blastPlayer)
      const d = await api('POST', `/portal/camps/${campId}/upload`, fd, true)
      setUploadLog(l => [...(d.results || []).map(r =>
        r.kind === 'blast'
          ? `${r.file}: ${r.rows} swings → ${r.player} (${r.new} new)`
          : `${r.file}: ${r.kind.replace('trackman_', 'TrackMan ')} · ${r.players} players · ${r.new} new rows`),
        ...(d.errors || []).map(e => `⚠ ${e.file}: ${e.error}`), ...l].slice(0, 8))
      await loadPlayers()
      if (selKey) await loadReport(selKey)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  async function addAttendee() {
    const n = newName.trim()
    if (!n || !campId) return
    setBusy(true); setError('')
    try {
      const d = await api('POST', `/portal/camps/${campId}/players`, { display_name: n })
      setNewName(''); await loadPlayers(); await loadReport(d.name_key)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  async function save() {
    setBusy(true); setError('')
    try {
      await api('PATCH', `/portal/camps/${campId}/players/${selKey}`, form)
      setSaved(true); setTimeout(() => setSaved(false), 2000)
      setReport(r => r ? { ...r, player: { ...r.player, ...form } } : r)
      await loadPlayers()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const selPlayer = players.find(p => p.name_key === selKey)
  const filename = report ? `camp_report_${(report.player.display_name || 'player').replace(/\s+/g, '_').toLowerCase()}` : 'camp_report'

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-5 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-portal-purple dark:text-portal-accent-light">Camp Report</h1>
          <p className="text-[13px] text-gray-500 dark:text-gray-400 max-w-2xl mt-1">
            Upload your camp's TrackMan and Blast Motion CSVs, add measurables and notes
            per attendee, and download a one-page report for each player.
          </p>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Camp</span>
            <select value={campId || ''} onChange={e => setCampId(Number(e.target.value) || null)}
              className="block rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-sm min-w-[180px]">
              {!camps.length && <option value="">No camps yet</option>}
              {camps.map(c => <option key={c.id} value={c.id}>{c.name}{c.camp_date ? ` · ${c.camp_date}` : ''}</option>)}
            </select>
          </label>
          <input value={newCamp.name} onChange={e => setNewCamp(v => ({ ...v, name: e.target.value }))}
            placeholder="New camp name" className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-sm w-40" />
          <input type="date" value={newCamp.camp_date} onChange={e => setNewCamp(v => ({ ...v, camp_date: e.target.value }))}
            className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-sm" />
          <button onClick={createCamp} disabled={busy || !newCamp.name.trim()}
            className="rounded-lg bg-portal-purple text-white text-sm font-semibold px-3 py-1.5 disabled:opacity-50">
            Create camp
          </button>
        </div>
      </div>

      {campId && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-5">
          <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">TrackMan CSVs (BP or game)</div>
            <p className="text-[12px] text-gray-500 dark:text-gray-400 mb-2">
              Attendees are picked up automatically from the batter and pitcher names.
              Re-uploading a file never double-counts.
            </p>
            <input type="file" accept=".csv" multiple disabled={busy}
              onChange={e => { upload(e.target.files); e.target.value = '' }}
              className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-portal-purple file:text-white file:px-3 file:py-1.5 file:text-sm file:font-semibold" />
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Blast Motion export</div>
            <p className="text-[12px] text-gray-500 dark:text-gray-400 mb-2">
              Blast files don't include the player's name, so type it first, then pick the file.
            </p>
            <div className="flex gap-2 items-center flex-wrap">
              <input ref={blastNameRef} placeholder="Player name" list="camp-attendees"
                className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-sm w-44" />
              <datalist id="camp-attendees">
                {players.map(p => <option key={p.name_key} value={p.display_name} />)}
              </datalist>
              <input type="file" accept=".csv" disabled={busy}
                onChange={e => { upload(e.target.files, blastNameRef.current?.value || ''); e.target.value = '' }}
                className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-portal-purple file:text-white file:px-3 file:py-1.5 file:text-sm file:font-semibold" />
            </div>
          </div>
        </div>
      )}

      {uploadLog.length > 0 && (
        <div className="mb-4 rounded-lg bg-gray-50 dark:bg-gray-900/40 ring-1 ring-gray-200 dark:ring-gray-700 px-3 py-2">
          {uploadLog.map((l, i) => <div key={i} className="text-[12px] text-gray-600 dark:text-gray-300 font-mono">{l}</div>)}
        </div>
      )}
      {error && <div className="mb-4 text-[13px] text-rose-600">{error}</div>}

      {campId && (
        <div className="flex flex-wrap items-end gap-2 mb-5">
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
              Attendee ({players.length})
            </span>
            <select value={selKey} onChange={e => loadReport(e.target.value)}
              className="block rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-sm min-w-[240px]">
              <option value="">Select a player…</option>
              {players.map(p => (
                <option key={p.name_key} value={p.name_key}>
                  {p.display_name}
                  {p.blast_rows > 0 || p.hit_rows > 0 || p.pitch_rows > 0
                    ? `  (${[p.blast_rows && `${p.blast_rows} swings`, p.hit_rows && `${p.hit_rows} BBE`, p.pitch_rows && `${p.pitch_rows} pitches`].filter(Boolean).join(' · ')})`
                    : '  (manual only)'}
                </option>
              ))}
            </select>
          </label>
          <input value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addAttendee() }}
            placeholder="Add attendee by name"
            className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-sm w-48" />
          <button onClick={addAttendee} disabled={busy || !newName.trim()}
            className="rounded-lg border border-portal-purple text-portal-purple dark:text-portal-accent-light text-sm font-semibold px-3 py-1.5 disabled:opacity-50">
            Add
          </button>
        </div>
      )}

      {selKey && report && (
        <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-5 items-start">
          {/* ── Editor ── */}
          <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4 space-y-3">
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
              {report.player.display_name} — info
            </div>
            <div className="grid grid-cols-3 gap-2">
              {BIO_FIELDS.map(([k, label, ph]) => (
                <label key={k} className="block">
                  <span className="text-[9px] font-bold uppercase tracking-wide text-gray-400">{label}</span>
                  <input value={form[k] || ''} placeholder={ph}
                    onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                    className="w-full rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1 text-[13px]" />
                </label>
              ))}
            </div>
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 pt-1">Measurables</div>
            <div className="grid grid-cols-4 gap-2">
              {MEASURABLE_FIELDS.map(([k, label, ph]) => (
                <label key={k} className="block">
                  <span className="text-[9px] font-bold uppercase tracking-wide text-gray-400">{label}</span>
                  <input value={form[k] || ''} placeholder={ph}
                    onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                    className="w-full rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1 text-[13px]" />
                </label>
              ))}
            </div>
            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Development notes</span>
              <textarea value={form.notes || ''} rows={7}
                placeholder="Swing plays to the pull side with real bat speed; needs to tighten the chase..."
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-[13px] leading-snug" />
            </label>
            <div className="flex items-center gap-3">
              <button onClick={save} disabled={busy}
                className="rounded-lg bg-portal-purple text-white text-sm font-semibold px-4 py-2 disabled:opacity-50">
                {busy ? 'Saving…' : 'Save player'}
              </button>
              {saved && <span className="text-[12px] text-emerald-600 font-semibold">Saved ✓</span>}
            </div>
          </div>

          {/* ── Report preview + export ── */}
          <div>
            <ReportActions targetRef={pageRef} filename={filename} fullBleedPrint className="mb-3" />
            <div className="overflow-x-auto pb-4">
              <CampReportCard pageRef={pageRef} report={report} form={form} teamLogo={team?.logo_url} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// ── The one-page report (custom-card look: 816×1056, auto-fit) ──

function Panel({ title, children, className = '' }) {
  return (
    <div className={`border border-gray-200 rounded p-2 ${className}`}>
      <div className="text-[10px] uppercase tracking-widest text-portal-purple-dark font-bold mb-1">{title}</div>
      {children}
    </div>
  )
}

function Meas({ label, value }) {
  return (
    <div className="flex flex-col items-center border border-gray-200 rounded py-1.5 px-1">
      <span className="text-[8px] font-bold uppercase tracking-wider text-gray-500">{label}</span>
      <span className="text-[15px] font-bold tabular-nums text-portal-purple-dark leading-tight">
        {value || '—'}
      </span>
    </div>
  )
}

function StatCol({ label, value, sub }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[8px] text-gray-500 uppercase font-bold">{label}</span>
      <span className="text-[12px] font-bold tabular-nums">{value ?? '—'}</span>
      {sub != null && <span className="text-[8px] text-gray-400 tabular-nums">{sub}</span>}
    </div>
  )
}

function EvLaScatter({ points }) {
  const W = 200, H = 108
  const evMin = 40, evMax = 110, laMin = -30, laMax = 60
  const x = ev => ((Math.min(Math.max(ev, evMin), evMax) - evMin) / (evMax - evMin)) * (W - 16) + 8
  const y = la => H - 12 - ((Math.min(Math.max(la ?? 0, laMin), laMax) - laMin) / (laMax - laMin)) * (H - 20)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <rect x="0" y="0" width={W} height={H} rx="4" fill="#f9fafb" />
      {/* sweet-spot band 8-32 deg */}
      <rect x="8" y={y(32)} width={W - 16} height={y(8) - y(32)} fill="#10b981" opacity="0.08" />
      <line x1="8" y1={y(0)} x2={W - 8} y2={y(0)} stroke="#d1d5db" strokeWidth="0.7" />
      {[60, 80, 100].map(ev => (
        <g key={ev}>
          <line x1={x(ev)} y1="6" x2={x(ev)} y2={H - 10} stroke="#e5e7eb" strokeWidth="0.6" />
          <text x={x(ev)} y={H - 2} textAnchor="middle" style={{ fontSize: 6, fill: '#9ca3af' }}>{ev}</text>
        </g>
      ))}
      <text x="4" y="8" style={{ fontSize: 6, fill: '#9ca3af' }}>LA°</text>
      <text x={W - 6} y={H - 2} textAnchor="end" style={{ fontSize: 6, fill: '#9ca3af' }}>EV mph</text>
      {points.map((p, i) => (
        <circle key={i} cx={x(p.ev)} cy={y(p.la)} r="2.2"
          fill={p.ctx === 'game' ? '#1d1f4d' : '#8e7553'} opacity="0.75" />
      ))}
    </svg>
  )
}

export function CampReportCard({ pageRef, report, form, teamLogo }) {
  const contentRef = useRef(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const measure = () => {
      const h = el.scrollHeight
      setScale(h > 1030 ? 1030 / h : 1)
    }
    measure()
    const timers = [150, 500].map(ms => setTimeout(measure, ms))
    return () => timers.forEach(clearTimeout)
  }, [report, form])

  const p = { ...report.player, ...form }
  const camp = report.camp
  const bio = [
    p.position, (p.bats || p.throws) ? `B/T: ${p.bats || '–'}/${p.throws || '–'}` : null,
    p.height, p.weight ? `${p.weight} lbs` : null, p.grad_year ? `Class of ${p.grad_year}` : null,
  ].filter(Boolean).join(' · ')
  const from = [p.school, [p.hometown, p.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')
  const b = report.blast
  const hit = report.hitting
  const pit = report.pitching
  const pct = v => v != null ? `${Math.round(v * 100)}%` : '—'

  const hitRow = (label, h) => h && (
    <div className="grid grid-cols-6 gap-1 py-1 border-b border-gray-100 last:border-0">
      <span className="text-[9px] font-bold text-gray-600 self-center">{label}</span>
      <StatCol label="BBE" value={h.bbe} />
      <StatCol label="Avg EV" value={h.ev_avg} />
      <StatCol label="Max EV" value={h.ev_max} />
      <StatCol label="Avg LA" value={h.la_avg != null ? `${h.la_avg}°` : null} />
      <StatCol label="Hard-Hit" value={pct(h.hard_hit_pct)} sub={h.dist_max ? `${Math.round(h.dist_max)} ft max` : null} />
    </div>
  )

  return (
    <div ref={pageRef} className="custom-card-page bg-white shadow border border-gray-200"
      style={{ width: '816px', height: '1056px', overflow: 'hidden', position: 'relative' }}>
      <div ref={contentRef} data-scale-content
        style={{ width: '816px', transform: `scale(${scale})`, transformOrigin: 'top left', padding: '14px' }}>

        {/* Header */}
        <div className="flex items-center gap-3 border-b-2 border-portal-purple pb-2 mb-2">
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 leading-none">
              {camp.name}{camp.date ? ` · ${camp.date}` : ''}
            </div>
            <div className="text-xl font-bold leading-tight text-portal-purple-dark">{p.display_name}</div>
            <div className="text-[10px] text-gray-600 leading-none mt-0.5">{bio || ' '}</div>
            {from && <div className="text-[10px] text-gray-500 leading-none mt-0.5">{from}</div>}
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 leading-none">Camp Report</div>
            {teamLogo && <img src={teamLogo} alt="" className="h-10 w-10 object-contain ml-auto mt-1" />}
          </div>
        </div>

        {/* Measurables strip */}
        <div className="grid grid-cols-6 gap-2 mb-2">
          <Meas label="60-yd dash" value={p.sixty_time} />
          <Meas label="IF velo" value={p.if_velo} />
          <Meas label="OF velo" value={p.of_velo} />
          <Meas label="Pop time" value={p.pop_time} />
          <Meas label="Height" value={p.height} />
          <Meas label="Weight" value={p.weight ? `${p.weight}` : null} />
        </div>

        <div className="grid grid-cols-2 gap-2 mb-2 items-stretch [&>*]:h-full">
          {/* Blast */}
          <Panel title={`Swing Metrics — Blast Motion${b ? ` (${b.swings} swings)` : ''}`}>
            {!b ? (
              <div className="text-[9.5px] text-gray-400 italic">No Blast Motion data uploaded for this player.</div>
            ) : (
              <>
                <table className="w-full text-[9.5px] tabular-nums">
                  <thead>
                    <tr className="text-gray-500">
                      <th className="text-left font-semibold pb-0.5"> </th>
                      <th className="text-right font-semibold pb-0.5">Avg</th>
                      <th className="text-right font-semibold pb-0.5">Best</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ['Bat speed (mph)', b.bat_speed_avg, b.bat_speed_max],
                      ['Peak hand speed (mph)', b.hand_speed_avg, b.hand_speed_max],
                      ['Rotational accel (g)', b.rot_accel_avg, null],
                      ['On-plane efficiency', b.on_plane_avg != null ? `${b.on_plane_avg}%` : null, null],
                      ['Attack angle', b.attack_angle_avg != null ? `${b.attack_angle_avg}°` : null, null],
                      ['Time to contact (s)', b.ttc_avg, null],
                      ['Power (kW)', b.power_avg, null],
                    ].map(([l, a, m]) => (
                      <tr key={l} className="border-t border-gray-100">
                        <td className="py-0.5 text-gray-700">{l}</td>
                        <td className="py-0.5 text-right font-semibold">{a ?? '—'}</td>
                        <td className="py-0.5 text-right text-gray-500">{m ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="grid grid-cols-3 gap-1 mt-1.5">
                  {[['Plane', b.scores.plane], ['Connection', b.scores.connection], ['Rotation', b.scores.rotation]].map(([l, v]) => (
                    <div key={l} className="text-center bg-portal-purple/5 rounded py-1">
                      <div className="text-[8px] uppercase font-bold text-gray-500">{l}</div>
                      <div className="text-[13px] font-bold tabular-nums text-portal-purple-dark">{v != null ? Math.round(v) : '—'}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Panel>

          {/* TrackMan batted ball */}
          <Panel title="Batted Ball — TrackMan">
            {!hit ? (
              <div className="text-[9.5px] text-gray-400 italic">No TrackMan batted-ball data for this player.</div>
            ) : (
              <>
                {hitRow('BP', hit.bp)}
                {hitRow('Live', hit.game)}
                {report.scatter?.length > 2 && (
                  <div className="mt-1.5">
                    <EvLaScatter points={report.scatter} />
                    <div className="flex justify-center gap-3 text-[8px] text-gray-500 mt-0.5">
                      <span><span className="inline-block w-2 h-2 rounded-full align-middle mr-1" style={{ background: '#8e7553' }} />BP</span>
                      <span><span className="inline-block w-2 h-2 rounded-full align-middle mr-1" style={{ background: '#1d1f4d' }} />Live</span>
                      <span className="text-gray-400">shaded band = sweet spot (8-32°)</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </Panel>
        </div>

        {/* Pitching */}
        {pit && (
          <Panel title={`Pitching — TrackMan (${pit.pitches} pitches${pit.throws ? ` · throws ${pit.throws[0]}` : ''})`} className="mb-2">
            <table className="w-full text-[9.5px] tabular-nums">
              <thead>
                <tr className="text-gray-500">
                  {['Pitch', 'N', 'Velo', 'Max', 'Spin', 'IVB', 'HB', 'Ext', 'Strike%'].map((h, i) => (
                    <th key={h} className={`font-semibold pb-0.5 ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pit.arsenal.map(a => (
                  <tr key={a.type} className="border-t border-gray-100">
                    <td className="py-0.5 font-semibold text-gray-700">{a.type}</td>
                    <td className="py-0.5 text-right">{a.n}</td>
                    <td className="py-0.5 text-right font-semibold">{a.velo_avg ?? '—'}</td>
                    <td className="py-0.5 text-right text-gray-500">{a.velo_max ?? '—'}</td>
                    <td className="py-0.5 text-right">{a.spin_avg ?? '—'}</td>
                    <td className="py-0.5 text-right">{a.ivb_avg ?? '—'}</td>
                    <td className="py-0.5 text-right">{a.hb_avg ?? '—'}</td>
                    <td className="py-0.5 text-right">{a.ext_avg ?? '—'}</td>
                    <td className="py-0.5 text-right">{a.strike_pct != null ? `${Math.round(a.strike_pct * 100)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}

        {/* Notes */}
        <Panel title="Development Notes" className="mb-2">
          {(form.notes || p.notes) ? (
            <div className="text-[10.5px] leading-relaxed text-gray-800 whitespace-pre-wrap" style={{ minHeight: '90px' }}>
              {form.notes ?? p.notes}
            </div>
          ) : (
            <div style={{ minHeight: '90px' }}>
              {[...Array(5)].map((_, i) => <div key={i} className="border-b border-gray-200 h-5" />)}
            </div>
          )}
        </Panel>

        {/* Footer */}
        <div className="flex items-center justify-between border-t-2 border-portal-purple pt-1.5">
          <span className="text-[9px] uppercase tracking-widest text-gray-500 font-bold">
            NWBB Stats · Camp Report
          </span>
          <span className="text-[9px] text-gray-400">nwbaseballstats.com</span>
        </div>
      </div>
    </div>
  )
}
