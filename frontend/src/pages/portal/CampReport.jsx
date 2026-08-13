// Camp Report — prospect camp workspace + one-page printable reports.
//
// Coaches create a camp, upload its Blast Motion / TrackMan BP / TrackMan
// game CSVs, pick an attendee, type bio + field measurables + development
// notes, and download reports. Two-way players get TWO separate PDFs: a
// hitting report (Blast + batted-ball visuals) and a pitching report (a
// deep dive on the game outing: arsenal, movement, locations, velo by
// pitch). Cards carry .custom-card-page + data-scale-content so they
// reuse all the Custom Player Card print/export machinery.
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
const BLAST_MANUAL_FIELDS = [
  ['blast_bat_speed', 'Bat speed', '68.5'],
  ['blast_hand_speed', 'Hand speed', '21.0'],
  ['blast_rot_accel', 'Rot. accel', '12.5'],
  ['blast_plane', 'Plane score', '64'],
  ['blast_connection', 'Connection', '52'],
  ['blast_rotation', 'Rotation', '58'],
]

export default function CampReport() {
  const { team } = usePortalTeam()
  const { data: campsData, refetch: refetchCamps } = useApi('/portal/camps')
  const camps = campsData?.camps || []
  const [campId, setCampId] = useState(null)
  const [newCamp, setNewCamp] = useState({ name: '', camp_date: '' })
  const [uploadLog, setUploadLog] = useState([])
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const [players, setPlayers] = useState([])
  const [uploads, setUploads] = useState([])
  const [selKey, setSelKey] = useState('')
  const [report, setReport] = useState(null)
  const [side, setSide] = useState('hitting')
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
  async function loadUploads(cid = campId) {
    if (!cid) return
    const d = await api('GET', `/portal/camps/${cid}/uploads`)
    setUploads(d.uploads || [])
  }
  async function deleteUpload(u) {
    if (!window.confirm(`Delete "${u.filename}" and its ${u.rows} rows from this camp?`)) return
    setBusy(true); setError('')
    try {
      await api('DELETE', `/portal/camps/${campId}/uploads/${u.id}`)
      await Promise.all([loadUploads(), loadPlayers()])
      if (selKey) await loadReport(selKey)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  useEffect(() => { setPlayers([]); setUploads([]); setSelKey(''); setReport(null); if (campId) { loadPlayers(); loadUploads() } }, [campId])  // eslint-disable-line

  async function loadReport(key) {
    setSelKey(key); setReport(null); setSaved(false)
    if (!key) return
    const d = await api('GET', `/portal/camps/${campId}/players/${key}/report`)
    setReport(d)
    setSide(d.pitching && !(d.blast || d.hitting) ? 'pitching' : 'hitting')
    const f = {}
    for (const [k] of [...BIO_FIELDS, ...MEASURABLE_FIELDS, ...BLAST_MANUAL_FIELDS]) f[k] = d.player?.[k] || ''
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
    setUploading(true); setError('')
    try {
      const fd = new FormData()
      for (const f of fileList) fd.append('files', f)
      if (blastPlayer) fd.append('blast_player', blastPlayer)
      const d = await api('POST', `/portal/camps/${campId}/upload`, fd, true)
      setUploadLog(l => [...(d.results || []).map(r =>
        r.kind === 'blast'
          ? `${r.file}: ${r.rows} swings → ${r.player}`
          : `${r.file}: ${r.kind.replace('trackman_', 'TrackMan ')} · ${r.players} players · ${r.rows} rows`),
        ...(d.errors || []).map(e => `⚠ ${e.file}: ${e.error}`), ...l].slice(0, 8))
      await Promise.all([loadPlayers(), loadUploads()])
      if (selKey) await loadReport(selKey)
    } catch (e) { setError(e.message) } finally { setUploading(false) }
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
      setSaved(true); setTimeout(() => setSaved(false), 2500)
      setReport(r => r ? { ...r, player: { ...r.player, ...form } } : r)
      await loadPlayers()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const hasHit = !!(report?.blast || report?.hitting)
  const hasPit = !!report?.pitching
  const twoWay = hasHit && hasPit
  const activeSide = twoWay ? side : (hasPit ? 'pitching' : 'hitting')
  const filename = report
    ? `camp_report_${(report.player.display_name || 'player').replace(/\s+/g, '_').toLowerCase()}_${activeSide}`
    : 'camp_report'

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-5 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-portal-purple dark:text-portal-accent-light">Camp Report</h1>
          <p className="text-[13px] text-gray-500 dark:text-gray-400 max-w-2xl mt-1">
            Upload your camp's TrackMan and Blast Motion CSVs, add measurables and notes
            per attendee, and download a one-page report for each player. Two-way players
            get separate hitting and pitching reports.
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
              Re-uploading a file refreshes its data, never double-counts.
            </p>
            <input type="file" accept=".csv" multiple disabled={uploading}
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
              <input type="file" accept=".csv" disabled={uploading}
                onChange={e => { upload(e.target.files, blastNameRef.current?.value || ''); e.target.value = '' }}
                className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-portal-purple file:text-white file:px-3 file:py-1.5 file:text-sm file:font-semibold" />
            </div>
          </div>
        </div>
      )}

      {uploading && (
        <div className="mb-4 flex items-center gap-2 text-[13px] text-portal-purple dark:text-portal-accent-light font-semibold">
          <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
          Uploading and parsing… large files can take a moment.
        </div>
      )}
      {uploads.length > 0 && (
        <div className="mb-4 bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">
            Uploaded files ({uploads.length})
          </div>
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {uploads.map(u => (
              <li key={u.id} className="flex items-center justify-between py-1.5 gap-3">
                <div className="min-w-0">
                  <span className="text-[13px] font-mono text-gray-700 dark:text-gray-200 truncate block">{u.filename}</span>
                  <span className="text-[11px] text-gray-400">
                    {(u.kind || '').replace('trackman_', 'TrackMan ').replace('blast', 'Blast Motion')} · {u.rows} rows · {u.uploaded}
                  </span>
                </div>
                <button onClick={() => deleteUpload(u)} disabled={busy}
                  className="shrink-0 text-[12px] font-semibold text-rose-600 hover:text-rose-700 border border-rose-200 dark:border-rose-900 rounded-lg px-2.5 py-1 disabled:opacity-50">
                  Delete
                </button>
              </li>
            ))}
          </ul>
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
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 pt-1">
              Blast by hand
              <span className="ml-1.5 normal-case font-normal text-gray-400">(used when no Blast file is uploaded)</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {BLAST_MANUAL_FIELDS.map(([k, label, ph]) => (
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
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              {twoWay && (
                <div className="flex rounded-lg overflow-hidden ring-1 ring-portal-purple">
                  {[['hitting', 'Hitting report'], ['pitching', 'Pitching report']].map(([k, label]) => (
                    <button key={k} onClick={() => setSide(k)}
                      className={`px-3 py-1.5 text-sm font-semibold ${activeSide === k
                        ? 'bg-portal-purple text-white'
                        : 'bg-white dark:bg-gray-800 text-portal-purple dark:text-portal-accent-light'}`}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <ReportActions targetRef={pageRef} filename={filename} fullBleedPrint />
            </div>
            <div className="overflow-x-auto pb-4">
              {activeSide === 'pitching'
                ? <PitcherCard pageRef={pageRef} report={report} form={form} teamLogo={team?.logo_url} />
                : <HitterCard pageRef={pageRef} report={report} form={form} teamLogo={team?.logo_url} />}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// ═══════════════════════ shared card pieces ═══════════════════════

const PITCH_COLORS = {
  Fastball: '#b91c1c', Sinker: '#ea580c', Cutter: '#a16207', Slider: '#2563eb',
  Sweeper: '#0891b2', Curveball: '#7c3aed', ChangeUp: '#16a34a', Splitter: '#db2777',
  Knuckleball: '#64748b', Unknown: '#6b7280',
}
const pColor = t => PITCH_COLORS[t] || PITCH_COLORS.Unknown
const evColor = ev => ev >= 95 ? '#b91c1c' : ev >= 90 ? '#1d1f4d' : ev >= 80 ? '#8e7553' : '#9ca3af'

function Panel({ title, right, children, className = '' }) {
  return (
    <div className={`border border-gray-200 rounded p-2 ${className}`}>
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-[10px] uppercase tracking-widest text-portal-purple-dark font-bold">{title}</div>
        {right && <div className="text-[8.5px] text-gray-400">{right}</div>}
      </div>
      {children}
    </div>
  )
}

function BigStat({ label, value, sub }) {
  return (
    <div className="flex flex-col items-center justify-center border border-gray-200 rounded py-1.5 px-1 min-w-0">
      <span className="text-[7.5px] font-bold uppercase tracking-wider text-gray-500 whitespace-nowrap">{label}</span>
      <span className="text-[16px] font-bold tabular-nums text-portal-purple-dark leading-tight whitespace-nowrap">
        {value ?? '—'}
      </span>
      {sub && <span className="text-[7.5px] text-gray-400 whitespace-nowrap">{sub}</span>}
    </div>
  )
}

function CardShell({ pageRef, children }) {
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
  })
  return (
    <div ref={pageRef} className="custom-card-page bg-white shadow border border-gray-200"
      style={{ width: '816px', height: '1056px', overflow: 'hidden', position: 'relative' }}>
      <div ref={contentRef} data-scale-content
        style={{ width: '816px', minHeight: '1056px', transform: `scale(${scale})`, transformOrigin: 'top left', padding: '14px', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
  )
}

function CardHeader({ report, form, teamLogo, tag }) {
  const p = { ...report.player, ...form }
  const camp = report.camp
  const bio = [
    p.position, (p.bats || p.throws) ? `B/T: ${p.bats || '–'}/${p.throws || '–'}` : null,
    p.height, p.weight ? `${p.weight} lbs` : null, p.grad_year ? `Class of ${p.grad_year}` : null,
  ].filter(Boolean).join(' · ')
  const from = [p.school, [p.hometown, p.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')
  return (
    <div className="flex items-center gap-3 border-b-2 border-portal-purple pb-2 mb-2">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 leading-none">
          {camp.name}{camp.date ? ` · ${camp.date}` : ''}
        </div>
        <div className="text-xl font-bold leading-tight text-portal-purple-dark">{p.display_name}</div>
        <div className="text-[10px] text-gray-600 leading-none mt-0.5">{bio || ' '}</div>
        {from && <div className="text-[10px] text-gray-500 leading-none mt-0.5">{from}</div>}
      </div>
      <div className="text-right">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 leading-none whitespace-nowrap">{tag}</div>
        {teamLogo && <img src={teamLogo} alt="" className="h-10 w-10 object-contain ml-auto mt-1" />}
      </div>
    </div>
  )
}

function NotesPanel({ form, report, lines = 4 }) {
  const notes = form.notes ?? report.player.notes
  return (
    <Panel title="Development Notes" className="mt-auto mb-2">
      {notes ? (
        <div className="text-[10.5px] leading-relaxed text-gray-800 whitespace-pre-wrap" style={{ minHeight: `${lines * 18}px` }}>
          {notes}
        </div>
      ) : (
        <div style={{ minHeight: `${lines * 18}px` }}>
          {[...Array(lines)].map((_, i) => <div key={i} className="border-b border-gray-200 h-[18px]" />)}
        </div>
      )}
    </Panel>
  )
}

function CardFooter() {
  return (
    <div className="flex items-center justify-between border-t-2 border-portal-purple pt-1.5">
      <span className="text-[9px] uppercase tracking-widest text-gray-500 font-bold whitespace-nowrap">
        NWBB Stats · Camp Report
      </span>
      <span className="text-[9px] text-gray-400">nwbaseballstats.com</span>
    </div>
  )
}

function TypeLegend({ types }) {
  return (
    <div className="flex flex-wrap justify-center gap-x-2.5 gap-y-0.5 mt-1">
      {types.map(t => (
        <span key={t} className="text-[8px] text-gray-600 whitespace-nowrap">
          <span className="inline-block w-2 h-2 rounded-full align-middle mr-1" style={{ background: pColor(t) }} />{t}
        </span>
      ))}
    </div>
  )
}


// ═══════════════════════ hitter visuals ═══════════════════════

function EvLaScatter({ points }) {
  const W = 340, H = 210
  const evMin = 40, evMax = 115, laMin = -40, laMax = 70
  const x = ev => 26 + ((Math.min(Math.max(ev, evMin), evMax) - evMin) / (evMax - evMin)) * (W - 34)
  const y = la => H - 18 - ((Math.min(Math.max(la ?? 0, laMin), laMax) - laMin) / (laMax - laMin)) * (H - 28)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <rect x="0" y="0" width={W} height={H} rx="4" fill="#f9fafb" />
      <rect x="26" y={y(32)} width={W - 34} height={y(8) - y(32)} fill="#10b981" opacity="0.09" />
      <line x1="26" y1={y(0)} x2={W - 8} y2={y(0)} stroke="#d1d5db" strokeWidth="0.8" />
      {[60, 80, 100].map(ev => (
        <g key={ev}>
          <line x1={x(ev)} y1="8" x2={x(ev)} y2={H - 16} stroke="#e5e7eb" strokeWidth="0.6" />
          <text x={x(ev)} y={H - 5} textAnchor="middle" style={{ fontSize: 8, fill: '#9ca3af' }}>{ev} mph</text>
        </g>
      ))}
      {[-20, 0, 20, 40].map(la => (
        <text key={la} x="21" y={y(la) + 2.5} textAnchor="end" style={{ fontSize: 7.5, fill: '#9ca3af' }}>{la}°</text>
      ))}
      {points.map((p, i) => (
        <circle key={i} cx={x(p.ev)} cy={y(p.la)} r="3"
          fill={p.ctx === 'game' ? '#1d1f4d' : '#8e7553'} opacity="0.75" />
      ))}
    </svg>
  )
}

function SprayFan({ points }) {
  const W = 340, H = 210
  const ox = W / 2, oy = H - 14
  const maxDist = Math.max(320, ...points.map(p => p.dist || 0)) * 1.06
  const R = H - 34
  const pt = (dir, dist) => {
    const a = (dir * Math.PI) / 180
    const r = (Math.min(dist, maxDist) / maxDist) * R
    return [ox + r * Math.sin(a), oy - r * Math.cos(a)]
  }
  const foul = a => pt(a, maxDist)
  const arcs = [150, 250, 350].filter(d => d < maxDist)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <rect x="0" y="0" width={W} height={H} rx="4" fill="#f9fafb" />
      {/* fair territory */}
      <path d={`M ${ox} ${oy} L ${foul(-45)[0]} ${foul(-45)[1]} A ${R} ${R} 0 0 1 ${foul(45)[0]} ${foul(45)[1]} Z`}
        fill="#ffffff" stroke="#d1d5db" strokeWidth="1" />
      {arcs.map(d => {
        const r = (d / maxDist) * R
        const [x1, y1] = pt(-45, d); const [x2, y2] = pt(45, d)
        return (
          <g key={d}>
            <path d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`} fill="none" stroke="#e5e7eb" strokeWidth="0.8" />
            <text x={ox} y={oy - r - 2} textAnchor="middle" style={{ fontSize: 7, fill: '#9ca3af' }}>{d} ft</text>
          </g>
        )
      })}
      <line x1={ox} y1={oy} x2={ox} y2={oy - R} stroke="#eef0f3" strokeWidth="0.8" />
      {points.map((p, i) => {
        const [cx, cy] = pt(Math.max(-45, Math.min(45, p.dir)), p.dist)
        return <circle key={i} cx={cx} cy={cy} r="3.2" fill={evColor(p.ev || 0)} opacity="0.8" />
      })}
      <rect x={ox - 3} y={oy - 3} width="6" height="6" transform={`rotate(45 ${ox} ${oy})`} fill="#1d1f4d" />
    </svg>
  )
}

function LaMixBar({ mix, label }) {
  if (!mix) return null
  const segs = [['GB', mix.gb, '#a16207'], ['LD', mix.ld, '#16a34a'], ['FB', mix.fb, '#2563eb'], ['PU', mix.pu, '#9ca3af']]
  return (
    <div className="mt-1">
      <div className="flex justify-between text-[7.5px] text-gray-500 mb-0.5">
        <span className="font-bold uppercase">{label}</span>
        <span>{segs.map(([l, v]) => `${l} ${Math.round((v || 0) * 100)}%`).join(' · ')}</span>
      </div>
      <div className="flex h-2 rounded overflow-hidden bg-gray-100">
        {segs.map(([l, v, c]) => v > 0 && <div key={l} style={{ width: `${v * 100}%`, background: c, opacity: 0.8 }} />)}
      </div>
    </div>
  )
}

function HitLine({ label, h }) {
  if (!h) return null
  const pct = v => v != null ? `${Math.round(v * 100)}%` : '—'
  return (
    <div>
      <div className="grid grid-cols-7 gap-1 items-end py-1">
        <span className="text-[9.5px] font-bold text-gray-700 self-center">{label}</span>
        {[['BBE', h.bbe], ['Avg EV', h.ev_avg], ['Max EV', h.ev_max],
          ['Avg LA', h.la_avg != null ? `${h.la_avg}°` : null],
          ['Hard-Hit', pct(h.hard_hit_pct)], ['Sweet Spot', pct(h.sweet_spot_pct)]].map(([l, v]) => (
          <div key={l} className="flex flex-col items-center min-w-0">
            <span className="text-[7.5px] text-gray-500 uppercase font-bold whitespace-nowrap">{l}</span>
            <span className="text-[13px] font-bold tabular-nums whitespace-nowrap">{v ?? '—'}</span>
          </div>
        ))}
      </div>
      <LaMixBar mix={h.la_mix} label={`${label} batted-ball mix`} />
    </div>
  )
}

function HitterCard({ pageRef, report, form, teamLogo }) {
  const p = { ...report.player, ...form }
  // Live preview: hand-typed Blast numbers stand in when no export exists.
  const manualVals = [p.blast_bat_speed, p.blast_hand_speed, p.blast_rot_accel,
                      p.blast_plane, p.blast_connection, p.blast_rotation]
  const manual = !report.blast?.swings && manualVals.some(v => v)
  const b = manual ? {
    manual: true, swings: null,
    bat_speed_avg: p.blast_bat_speed || null, bat_speed_max: null,
    hand_speed_avg: p.blast_hand_speed || null, hand_speed_max: null,
    rot_accel_avg: p.blast_rot_accel || null,
    on_plane_avg: null, attack_angle_avg: null, ttc_avg: null, power_avg: null,
    scores: { plane: p.blast_plane, connection: p.blast_connection, rotation: p.blast_rotation },
  } : report.blast
  const hit = report.hitting
  return (
    <CardShell pageRef={pageRef}>
      <CardHeader report={report} form={form} teamLogo={teamLogo} tag="Camp Hitting Report" />

      <div className="grid grid-cols-6 gap-2 mb-2">
        <BigStat label="60-yd dash" value={p.sixty_time} />
        <BigStat label="IF velo" value={p.if_velo} />
        <BigStat label="OF velo" value={p.of_velo} />
        <BigStat label="Pop time" value={p.pop_time} />
        <BigStat label="Height" value={p.height} />
        <BigStat label="Weight" value={p.weight} />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-2 items-stretch [&>*]:h-full">
        <Panel title="Swing Metrics — Blast Motion" right={b ? (b.manual ? 'entered by hand' : `${b.swings} swings`) : null}>
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
                  ].filter(([, a]) => !b.manual || a != null).map(([l, a, m]) => (
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
                    <div className="text-[14px] font-bold tabular-nums text-portal-purple-dark">{v != null ? Math.round(v) : '—'}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Panel>

        <Panel title="Batted Ball — TrackMan">
          {!hit ? (
            <div className="text-[9.5px] text-gray-400 italic">No TrackMan batted-ball data for this player.</div>
          ) : (
            <div className="space-y-1.5">
              <HitLine label="BP" h={hit.bp} />
              {hit.bp && hit.game && <div className="border-t border-gray-100" />}
              <HitLine label="Live" h={hit.game} />
            </div>
          )}
        </Panel>
      </div>

      {(report.scatter?.length > 2 || report.spray?.length > 2) && (
        <div className="grid grid-cols-2 gap-2 mb-2 items-stretch [&>*]:h-full">
          <Panel title="Exit Velo × Launch Angle">
            <EvLaScatter points={report.scatter || []} />
            <div className="flex justify-center gap-3 text-[8px] text-gray-500 mt-0.5">
              <span><span className="inline-block w-2 h-2 rounded-full align-middle mr-1" style={{ background: '#8e7553' }} />BP</span>
              <span><span className="inline-block w-2 h-2 rounded-full align-middle mr-1" style={{ background: '#1d1f4d' }} />Live</span>
              <span className="text-gray-400">band = sweet spot (8-32°)</span>
            </div>
          </Panel>
          <Panel title="Spray Chart" right="all tracked contact">
            {report.spray?.length > 2 ? (
              <>
                <SprayFan points={report.spray} />
                <div className="flex justify-center gap-2.5 text-[8px] text-gray-500 mt-0.5">
                  {[['95+', '#b91c1c'], ['90-95', '#1d1f4d'], ['80-90', '#8e7553'], ['<80', '#9ca3af']].map(([l, c]) => (
                    <span key={l}><span className="inline-block w-2 h-2 rounded-full align-middle mr-1" style={{ background: c }} />{l} EV</span>
                  ))}
                </div>
              </>
            ) : (
              <div className="text-[9.5px] text-gray-400 italic">Not enough tracked ball flight for a spray chart.</div>
            )}
          </Panel>
        </div>
      )}

      {report.top_bbe?.length > 0 && (
        <Panel title="Hardest-Hit Balls" className="mb-2">
          <table className="w-full text-[9.5px] tabular-nums">
            <thead>
              <tr className="text-gray-500">
                {['#', 'Exit velo', 'Launch', 'Distance', 'Result', 'Setting'].map((h, i) => (
                  <th key={h} className={`font-semibold pb-0.5 ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.top_bbe.map((t, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="py-0.5 text-gray-400">{i + 1}</td>
                  <td className="py-0.5 text-right font-bold" style={{ color: evColor(t.ev) }}>{t.ev} mph</td>
                  <td className="py-0.5 text-right">{t.la != null ? `${t.la}°` : '—'}</td>
                  <td className="py-0.5 text-right">{t.dist ? `${Math.round(t.dist)} ft` : '—'}</td>
                  <td className="py-0.5 text-right">{t.res && t.res !== 'BP' ? t.res : '—'}</td>
                  <td className="py-0.5 text-right text-gray-500">{t.ctx === 'bp' ? 'BP' : 'Live'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <NotesPanel form={form} report={report} lines={4} />
      <CardFooter />
    </CardShell>
  )
}


// ═══════════════════════ pitcher visuals ═══════════════════════

function MovementPlot({ points }) {
  const W = 340, H = 250
  const lim = 26
  const x = hb => W / 2 + (Math.min(Math.max(hb, -lim), lim) / lim) * (W / 2 - 22)
  const y = ivb => H / 2 - (Math.min(Math.max(ivb, -lim), lim) / lim) * (H / 2 - 20)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <rect x="0" y="0" width={W} height={H} rx="4" fill="#f9fafb" />
      {[-20, -10, 10, 20].map(v => (
        <g key={v}>
          <line x1={x(v)} y1="8" x2={x(v)} y2={H - 14} stroke="#eef0f3" strokeWidth="0.6" />
          <line x1="20" y1={y(v)} x2={W - 8} y2={y(v)} stroke="#eef0f3" strokeWidth="0.6" />
        </g>
      ))}
      <line x1={x(0)} y1="8" x2={x(0)} y2={H - 14} stroke="#d1d5db" strokeWidth="0.9" />
      <line x1="20" y1={y(0)} x2={W - 8} y2={y(0)} stroke="#d1d5db" strokeWidth="0.9" />
      {[-20, 20].map(v => (
        <text key={v} x={x(v)} y={H - 4} textAnchor="middle" style={{ fontSize: 7.5, fill: '#9ca3af' }}>{v}"</text>
      ))}
      {[-20, 20].map(v => (
        <text key={v} x="16" y={y(v) + 2.5} textAnchor="end" style={{ fontSize: 7.5, fill: '#9ca3af' }}>{v}"</text>
      ))}
      <text x={W - 10} y={y(0) - 4} textAnchor="end" style={{ fontSize: 7.5, fill: '#9ca3af' }}>HB →</text>
      <text x={x(0) + 4} y="14" style={{ fontSize: 7.5, fill: '#9ca3af' }}>IVB ↑</text>
      {points.map((p, i) => (
        <circle key={i} cx={x(p.hb)} cy={y(p.ivb)} r="3.4" fill={pColor(p.t)} opacity="0.75" />
      ))}
    </svg>
  )
}

function LocationPlot({ points }) {
  const W = 260, H = 250
  // plate coords (ft, catcher view): x -2..2, z 0.5..4.6
  const x = px => W / 2 + (Math.min(Math.max(px, -2), 2) / 2) * (W / 2 - 24)
  const y = pz => H - 20 - ((Math.min(Math.max(pz, 0.4), 4.6) - 0.4) / 4.2) * (H - 34)
  const zx1 = x(-0.83), zx2 = x(0.83), zy1 = y(3.5), zy2 = y(1.5)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <rect x="0" y="0" width={W} height={H} rx="4" fill="#f9fafb" />
      {/* strike zone + 9-box */}
      <rect x={zx1} y={zy1} width={zx2 - zx1} height={zy2 - zy1} fill="none" stroke="#1d1f4d" strokeWidth="1.4" />
      {[1, 2].map(i => (
        <g key={i}>
          <line x1={zx1 + (zx2 - zx1) * i / 3} y1={zy1} x2={zx1 + (zx2 - zx1) * i / 3} y2={zy2} stroke="#c8cbd8" strokeWidth="0.7" />
          <line x1={zx1} y1={zy1 + (zy2 - zy1) * i / 3} x2={zx2} y2={zy1 + (zy2 - zy1) * i / 3} stroke="#c8cbd8" strokeWidth="0.7" />
        </g>
      ))}
      {/* home plate */}
      <path d={`M ${x(-0.7)} ${H - 10} L ${x(0.7)} ${H - 10} L ${x(0.5)} ${H - 5} L ${x(-0.5)} ${H - 5} Z`}
        fill="#e5e7eb" />
      {points.map((p, i) => (
        <circle key={i} cx={x(p.px)} cy={y(p.pz)} r="3.2" fill={pColor(p.t)} opacity="0.7" />
      ))}
      <text x={W / 2} y="10" textAnchor="middle" style={{ fontSize: 7.5, fill: '#9ca3af' }}>catcher's view</text>
    </svg>
  )
}

function VeloSeq({ points }) {
  const W = 700, H = 130
  const velos = points.map(p => p.v)
  const vMin = Math.floor(Math.min(...velos) - 2), vMax = Math.ceil(Math.max(...velos) + 2)
  const x = i => 30 + ((i - 1) / Math.max(points.length - 1, 1)) * (W - 42)
  const y = v => H - 18 - ((v - vMin) / (vMax - vMin)) * (H - 28)
  const grid = []
  for (let v = Math.ceil(vMin / 5) * 5; v <= vMax; v += 5) grid.push(v)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <rect x="0" y="0" width={W} height={H} rx="4" fill="#f9fafb" />
      {grid.map(v => (
        <g key={v}>
          <line x1="30" y1={y(v)} x2={W - 8} y2={y(v)} stroke="#eef0f3" strokeWidth="0.7" />
          <text x="25" y={y(v) + 2.5} textAnchor="end" style={{ fontSize: 7.5, fill: '#9ca3af' }}>{v}</text>
        </g>
      ))}
      {points.map((p, i) => (
        <circle key={i} cx={x(p.i)} cy={y(p.v)} r="2.8" fill={pColor(p.t)} opacity="0.8" />
      ))}
      <text x={W - 10} y={H - 5} textAnchor="end" style={{ fontSize: 7.5, fill: '#9ca3af' }}>pitch number →</text>
    </svg>
  )
}

function PitcherCard({ pageRef, report, form, teamLogo }) {
  const pit = report.pitching
  const o = pit.outing || {}
  const types = [...new Set((pit.arsenal || []).map(a => a.type))]
  const pct = v => v != null ? `${Math.round(v * 100)}%` : '—'
  return (
    <CardShell pageRef={pageRef}>
      <CardHeader report={report} form={form} teamLogo={teamLogo} tag="Camp Pitching Report" />

      <div className="grid grid-cols-7 gap-2 mb-2">
        <BigStat label="Pitches" value={pit.pitches} />
        <BigStat label="Batters" value={o.bf} />
        <BigStat label="K" value={o.k} />
        <BigStat label="BB" value={o.bb} />
        <BigStat label="Hits" value={o.hits} />
        <BigStat label="Strike%" value={o.strike_pct != null ? pct(o.strike_pct) : null} />
        <BigStat label="Max velo" value={o.velo_max} sub="mph" />
      </div>

      <Panel title="Arsenal" right={pit.throws ? `throws ${pit.throws}` : null} className="mb-2">
        <table className="w-full text-[9.5px] tabular-nums">
          <thead>
            <tr className="text-gray-500">
              {['Pitch', 'Use%', 'N', 'Velo', 'Max', 'Spin', 'IVB', 'HB', 'Ext', 'Zone%', 'Whiff%', 'CSW%', 'Strike%'].map((h, i) => (
                <th key={h} className={`font-semibold pb-0.5 whitespace-nowrap ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pit.arsenal.map(a => (
              <tr key={a.type} className="border-t border-gray-100">
                <td className="py-0.5 font-semibold whitespace-nowrap">
                  <span className="inline-block w-2 h-2 rounded-full align-middle mr-1.5" style={{ background: pColor(a.type) }} />
                  {a.type}
                </td>
                <td className="py-0.5 text-right">{pct(a.usage)}</td>
                <td className="py-0.5 text-right text-gray-500">{a.n}</td>
                <td className="py-0.5 text-right font-semibold">{a.velo_avg ?? '—'}</td>
                <td className="py-0.5 text-right text-gray-500">{a.velo_max ?? '—'}</td>
                <td className="py-0.5 text-right">{a.spin_avg ?? '—'}</td>
                <td className="py-0.5 text-right">{a.ivb_avg ?? '—'}</td>
                <td className="py-0.5 text-right">{a.hb_avg ?? '—'}</td>
                <td className="py-0.5 text-right">{a.ext_avg ?? '—'}</td>
                <td className="py-0.5 text-right">{pct(a.zone_pct)}</td>
                <td className="py-0.5 text-right">{pct(a.whiff_pct)}</td>
                <td className="py-0.5 text-right">{pct(a.csw_pct)}</td>
                <td className="py-0.5 text-right">{pct(a.strike_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <div className="grid grid-cols-[1.3fr_1fr] gap-2 mb-2 items-stretch [&>*]:h-full">
        <Panel title="Pitch Movement" right="induced break, inches">
          {pit.movement?.length ? <MovementPlot points={pit.movement} />
            : <div className="text-[9.5px] text-gray-400 italic">No movement data.</div>}
          <TypeLegend types={types} />
        </Panel>
        <Panel title="Locations" right="all pitches">
          {pit.locations?.length ? <LocationPlot points={pit.locations} />
            : <div className="text-[9.5px] text-gray-400 italic">No location data — re-upload this game's CSV to add it.</div>}
        </Panel>
      </div>

      {pit.velo_seq?.length > 3 && (
        <Panel title="Velocity Through the Outing" className="mb-2">
          <VeloSeq points={pit.velo_seq} />
        </Panel>
      )}

      <NotesPanel form={form} report={report} lines={3} />
      <CardFooter />
    </CardShell>
  )
}
