// Blast Lab — coach-portal workspace for Blast Motion swing-sensor data.
//
// Upload the two team exports Blast produces (Average performance + Peak
// 95th percentile) and get a merged swing board: bat speed with the
// avg-to-peak "in the tank" gap, swing quickness, swing shape (attack and
// vertical bat angle vs the ideal bands), and the connection angles that
// drive sequencing. Click a hitter for their full sheet with team
// percentile bars and a bat-speed trend across testing dates.
import { useMemo, useRef, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { supabase } from '../lib/supabase'
import ReportActions from '../components/ReportActions'
import { toneAttr } from '../lib/reportExport'

const fmt = (v, d = 1) => (v === null || v === undefined ? '–' : Number(v).toFixed(d))

async function authHeaders() {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// Within-team percentile heat (same color language as the TrackMan suite).
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
function HeatCell({ v, vals, higher = true, dec = 1, extra = '' }) {
  const p = pctlOf(v, vals, higher)
  return (
    <td className={`px-2 py-1.5 text-right tabular-nums ${heatCls(p)} ${extra}`} {...toneAttr(p)}>
      {v == null ? '–' : Number(v).toFixed(dec)}
    </td>
  )
}

// Band coloring for shape/connection metrics where "more" isn't better.
const BAND_CLS = {
  good: 'text-emerald-600 dark:text-emerald-400 font-semibold',
  mid: 'text-amber-600 dark:text-amber-400',
  bad: 'text-rose-600 dark:text-rose-400 font-semibold',
}
const bandTone = (v, goodLo, goodHi, fringe) => {
  if (v == null) return null
  if (v >= goodLo && v <= goodHi) return 'good'
  if (v >= goodLo - fringe && v <= goodHi + fringe) return 'mid'
  return 'bad'
}
// Attack angle: 5-20 matches the pitch plane; Early Connection ~90-100 and
// Connection at Impact ~85-95 are the classic sequencing windows.
const aaTone = v => bandTone(v, 5, 20, 5)
const ecTone = v => bandTone(v, 90, 100, 8)
const ciTone = v => bandTone(v, 85, 95, 8)

const METRIC_TIPS = {
  bat: 'Average bat speed at impact. College average sits in the high 60s; 75+ is elite.',
  tank: 'Peak (95th percentile) bat speed minus average. A big gap means the top-end swing is not showing up consistently; a small gap on a fast bat is repeatable power.',
  hand: 'Peak hand speed. Wrist and forearm delivery of the barrel.',
  rot: 'Rotational acceleration: how fast the bat accelerates once the turn starts. The best sequencers score high.',
  power: 'Swing power in kilowatts (speed x mass x acceleration).',
  ope: 'On-plane efficiency: share of the swing spent on the pitch plane. 75-85% is the target window.',
  aa: 'Attack angle: barrel direction at impact. 5-20 degrees matches the pitch plane; negative is chopping down.',
  vba: 'Vertical bat angle at impact. Typically -25 to -35; steeper (more negative) plays lower in the zone.',
  ttc: 'Time to contact from downswing start. Lower is quicker; roughly 0.14-0.16s is typical.',
  commit: 'Commit time: decision point before contact. Lower leaves more time to read the pitch.',
  ec: 'Early connection: shoulder-to-bat angle at the start of the turn. ~90-100 degrees keeps the barrel connected to the turn.',
  ci: 'Connection at impact: same angle at contact. ~90 degrees means the body, not just the hands, delivered the barrel.',
  tilt: 'Body (posture) tilt at impact.',
}

// ── Swing shape mini-viz: attack angle + VBA on a protractor ─────
function SwingShape({ avg, p95 }) {
  const W = 260, H = 150, cx = 130, cy = 120, R = 95
  const ray = (deg, r = R) => [cx + r * Math.cos((-deg * Math.PI) / 180), cy + r * Math.sin((-deg * Math.PI) / 180)]
  const arc = (a1, a2, r = R) => {
    const [x1, y1] = ray(a1, r); const [x2, y2] = ray(a2, r)
    return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 0 ${a2 > a1 ? 0 : 1} ${x2} ${y2} Z`
  }
  const aa = avg?.attack_angle
  const aaP = p95?.attack_angle
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <path d={arc(5, 20)} fill="#059669" opacity="0.12" />
      <line x1={cx - R} y1={cy} x2={cx + R} y2={cy} stroke="currentColor" className="text-gray-300 dark:text-gray-600" />
      {[-20, -10, 10, 20, 30].map(a => {
        const [x, y] = ray(a)
        return <line key={a} x1={cx} y1={cy} x2={x} y2={y} stroke="currentColor" className="text-gray-100 dark:text-gray-700" />
      })}
      {aa != null && (
        <g>
          <line x1={cx} y1={cy} x2={ray(Math.max(-25, Math.min(40, aa)))[0]} y2={ray(Math.max(-25, Math.min(40, aa)))[1]}
            stroke="#d22d49" strokeWidth="3" strokeLinecap="round" />
          <text x={ray(Math.max(-25, Math.min(40, aa)), R + 2)[0]} y={ray(Math.max(-25, Math.min(40, aa)), R + 2)[1]}
            fontSize="10" fontWeight="700" fill="#d22d49">{fmt(aa)}°</text>
        </g>
      )}
      {aaP != null && (
        <line x1={cx} y1={cy} x2={ray(Math.max(-25, Math.min(40, aaP)))[0]} y2={ray(Math.max(-25, Math.min(40, aaP)))[1]}
          stroke="#d22d49" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.5" />
      )}
      <text x={ray(12, R * 0.55)[0]} y={ray(12, R * 0.55)[1]} fontSize="8" fill="#059669" textAnchor="middle">on plane 5-20°</text>
      <text x={12} y={H - 6} fontSize="9" fill="#9ca3af">attack angle (solid = avg, dashed = peak)</text>
    </svg>
  )
}

// Deviation-from-ideal bar for the connection angles.
function ConnBar({ label, v, ideal, tone }) {
  const dev = v == null ? null : v - ideal
  const W = 100
  const x = dev == null ? 0 : Math.max(-45, Math.min(45, dev))
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-32 text-gray-500 dark:text-gray-400 shrink-0">{label}</span>
      <svg viewBox="0 0 100 12" className="flex-1 h-3">
        <line x1={W / 2} y1="1" x2={W / 2} y2="11" stroke="currentColor" className="text-gray-300 dark:text-gray-500" />
        {dev != null && (
          <rect x={x < 0 ? W / 2 + x : W / 2} y="3" width={Math.abs(x)} height="6" rx="2"
            fill={tone === 'good' ? '#059669' : tone === 'mid' ? '#f59e0b' : '#e11d48'} opacity="0.8" />
        )}
      </svg>
      <span className={`w-14 text-right tabular-nums font-semibold ${BAND_CLS[tone] || ''}`}>{fmt(v)}°</span>
    </div>
  )
}

function TrendSpark({ points }) {
  if (!points || points.length < 2) return null
  const W = 220, H = 56, L = 6, R = 6, T = 8, B = 14
  const vals = points.map(p => p.bat_speed)
  const lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1
  const X = i => L + (i / (points.length - 1)) * (W - L - R)
  const Y = v => T + (hi - v) / (hi - lo) * (H - T - B)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[240px]">
      <polyline points={points.map((p, i) => `${X(i)},${Y(p.bat_speed)}`).join(' ')}
        fill="none" stroke="#8b5cf6" strokeWidth="2" />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={X(i)} cy={Y(p.bat_speed)} r="3" fill="#8b5cf6" />
          <text x={X(i)} y={Y(p.bat_speed) - 5} fontSize="8" textAnchor="middle" fill="#8b5cf6" fontWeight="700">{p.bat_speed}</text>
        </g>
      ))}
      <text x={L} y={H - 2} fontSize="7.5" fill="#9ca3af">{points[0].date}</text>
      <text x={W - R} y={H - 2} fontSize="7.5" fill="#9ca3af" textAnchor="end">{points[points.length - 1].date}</text>
    </svg>
  )
}

function PctlBar({ label, value, pctl, unit = '' }) {
  const dot = pctl >= 50 ? '#d22d49' : '#3661ad'
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-32 text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide shrink-0">{label}</span>
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

export default function BlastLab() {
  const exportRef = useRef(null)
  const [dateSel, setDateSel] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const [selected, setSelected] = useState('')
  const [uploadDate, setUploadDate] = useState('')
  const avgRef = useRef(null)
  const p95Ref = useRef(null)
  const { data, loading, refetch } = useApi('/portal/blast/board', dateSel ? { date: dateSel } : {})

  const players = data?.players || []
  const active = players.find(p => p.player === selected) || null

  const cohort = useMemo(() => {
    const pick = (side, key) => players.map(p => p[side]?.[key]).filter(v => v != null)
    return {
      bat: pick('avg', 'bat_speed'), batP: pick('p95', 'bat_speed'),
      hand: pick('avg', 'hand_speed'), rot: pick('avg', 'rot_accel'),
      power: pick('avg', 'power_kw'), ope: pick('avg', 'ope'),
      ttc: pick('avg', 'ttc'), commit: pick('avg', 'commit_time'),
      tank: players.map(p => (p.p95?.bat_speed != null && p.avg?.bat_speed != null)
        ? p.p95.bat_speed - p.avg.bat_speed : null).filter(v => v != null),
    }
  }, [players])

  async function upload() {
    const jobs = [
      [avgRef.current?.files?.[0], 'avg'],
      [p95Ref.current?.files?.[0], 'p95'],
    ].filter(([f]) => f)
    if (!jobs.length) { setNote({ err: 'Choose at least one CSV.' }); return }
    setBusy(true); setNote(null)
    try {
      const done = []
      for (const [f, kind] of jobs) {
        const fd = new FormData()
        fd.append('file', f)
        fd.append('kind', kind)
        if (uploadDate) fd.append('session_date', uploadDate)
        const res = await fetch('/api/v1/portal/blast/upload', {
          method: 'POST', body: fd, headers: await authHeaders(),
        })
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
        done.push(`${kind === 'avg' ? 'Averages' : 'Peak'} (${(await res.json()).players} hitters)`)
      }
      setNote({ ok: `Uploaded: ${done.join(' + ')}` })
      if (avgRef.current) avgRef.current.value = ''
      if (p95Ref.current) p95Ref.current.value = ''
      refetch()
    } catch (e) {
      setNote({ err: e.message })
    } finally { setBusy(false) }
  }

  const leaders = useMemo(() => {
    if (!players.length) return []
    const by = (fn, dir = 1) => [...players].filter(p => fn(p) != null)
      .sort((a, b) => dir * (fn(b) - fn(a)))[0]
    const out = []
    const fast = by(p => p.p95?.bat_speed)
    if (fast) out.push(['Fastest bat (peak)', fast.player, `${fmt(fast.p95.bat_speed)} mph`])
    const avg = by(p => p.avg?.bat_speed)
    if (avg) out.push(['Best avg bat speed', avg.player, `${fmt(avg.avg.bat_speed)} mph`])
    const ope = by(p => p.avg?.ope)
    if (ope) out.push(['Most on-plane', ope.player, `${fmt(ope.avg.ope)}%`])
    const quick = by(p => p.avg?.ttc, -1)
    if (quick) out.push(['Quickest to contact', quick.player, `${fmt(quick.avg.ttc, 3)}s`])
    return out
  }, [players])

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Blast Lab</h1>
        <span className="text-xs text-gray-400">swing-sensor board from Blast Motion team exports</span>
        {(data?.dates || []).length > 0 && (
          <select value={data?.date || ''} onChange={e => setDateSel(e.target.value)}
            className="ml-auto rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-sm font-semibold">
            {(data?.dates || []).map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        {players.length > 0 && <ReportActions csv targetRef={exportRef} filename={`blast_${data?.date || 'board'}`} />}
      </div>

      {/* upload */}
      <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
        <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">
          Upload a testing session — Blast team exports
        </div>
        <div className="flex items-end gap-3 flex-wrap text-sm">
          <label className="block">
            <span className="block text-[11px] font-semibold text-gray-500 dark:text-gray-400 mb-1">Averages CSV</span>
            <input ref={avgRef} type="file" accept=".csv" className="text-xs" />
          </label>
          <label className="block">
            <span className="block text-[11px] font-semibold text-gray-500 dark:text-gray-400 mb-1">Peak (95th percentile) CSV</span>
            <input ref={p95Ref} type="file" accept=".csv" className="text-xs" />
          </label>
          <label className="block">
            <span className="block text-[11px] font-semibold text-gray-500 dark:text-gray-400 mb-1">Testing date (optional)</span>
            <input type="date" value={uploadDate} onChange={e => setUploadDate(e.target.value)}
              className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1 text-sm" />
          </label>
          <button onClick={upload} disabled={busy}
            className="px-4 py-2 rounded-lg bg-portal-purple text-portal-cream text-sm font-semibold hover:opacity-90 disabled:opacity-50">
            {busy ? 'Uploading…' : 'Upload'}
          </button>
          {note?.ok && <span className="text-xs text-emerald-600 dark:text-emerald-400 font-semibold">{note.ok}</span>}
          {note?.err && <span className="text-xs text-rose-600 dark:text-rose-400 font-semibold">{note.err}</span>}
        </div>
        <p className="text-[10.5px] text-gray-400 mt-2">
          Export both files from the Blast team dashboard (Average performance + Peak 95th percentile) and
          upload them together. Sessions are keyed by testing date, so re-uploading the same date just
          refreshes it, and each new date builds the trend lines.
        </p>
      </div>

      {loading ? <div className="text-sm text-gray-400 p-6 text-center">Loading…</div> : players.length === 0 ? (
        <div className="p-10 text-center text-sm text-gray-400">No Blast data yet — upload the two team CSVs above.</div>
      ) : (
        <div ref={exportRef} className="space-y-3">
          {leaders.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {leaders.map(([label, who, val]) => (
                <div key={label} className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 px-4 py-3">
                  <div className="text-lg font-bold text-portal-purple dark:text-gray-100 leading-none">{val}</div>
                  <div className="text-[12px] font-semibold text-gray-700 dark:text-gray-300 mt-1 truncate">{who}</div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mt-0.5">{label}</div>
                </div>
              ))}
            </div>
          )}

          <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 overflow-x-auto">
            <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Team swing board — {data?.date}</span>
              <span className="text-[10px] text-gray-400">click a hitter for their full sheet · shading is within this group</span>
            </div>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
                  <th className="px-4 py-2">Hitter</th>
                  <th className="px-2 py-2 text-right">Swings</th>
                  <th className="px-2 py-2 text-right" title={METRIC_TIPS.bat}>Bat Spd</th>
                  <th className="px-2 py-2 text-right" title="Peak (95th percentile) bat speed">Peak</th>
                  <th className="px-2 py-2 text-right" title={METRIC_TIPS.tank}>In Tank</th>
                  <th className="px-2 py-2 text-right" title={METRIC_TIPS.hand}>Hand Spd</th>
                  <th className="px-2 py-2 text-right" title={METRIC_TIPS.rot}>Rot Accel</th>
                  <th className="px-2 py-2 text-right" title={METRIC_TIPS.power}>Power</th>
                  <th className="px-2 py-2 text-right" title={METRIC_TIPS.ope}>OPE%</th>
                  <th className="px-2 py-2 text-right" title={METRIC_TIPS.aa}>Attack°</th>
                  <th className="px-2 py-2 text-right" title={METRIC_TIPS.vba}>VBA°</th>
                  <th className="px-2 py-2 text-right" title={METRIC_TIPS.ttc}>TTC</th>
                  <th className="px-2 py-2 text-right" title={METRIC_TIPS.commit}>Commit</th>
                  <th className="px-2 py-2 text-right" title={METRIC_TIPS.ec}>Early Conn°</th>
                  <th className="px-2 py-2 text-right" title={METRIC_TIPS.ci}>Conn Impact°</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {players.map(p => {
                  const a = p.avg || {}, pk = p.p95 || {}
                  const tank = (pk.bat_speed != null && a.bat_speed != null) ? pk.bat_speed - a.bat_speed : null
                  return (
                    <tr key={p.player} onClick={() => setSelected(selected === p.player ? '' : p.player)}
                      className={`cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 ${selected === p.player ? 'bg-portal-purple/5' : ''}`}>
                      <td className="px-4 py-1.5 font-semibold whitespace-nowrap">{p.player}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{p.swings ?? '–'}</td>
                      <HeatCell v={a.bat_speed} vals={cohort.bat} extra="font-semibold" />
                      <HeatCell v={pk.bat_speed} vals={cohort.batP} />
                      <HeatCell v={tank} vals={cohort.tank} higher={false} />
                      <HeatCell v={a.hand_speed} vals={cohort.hand} />
                      <HeatCell v={a.rot_accel} vals={cohort.rot} />
                      <HeatCell v={a.power_kw} vals={cohort.power} dec={2} />
                      <HeatCell v={a.ope} vals={cohort.ope} />
                      <td className={`px-2 py-1.5 text-right tabular-nums ${BAND_CLS[aaTone(a.attack_angle)] || ''}`}>{fmt(a.attack_angle)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(a.vert_bat_angle)}</td>
                      <HeatCell v={a.ttc} vals={cohort.ttc} higher={false} dec={3} />
                      <HeatCell v={a.commit_time} vals={cohort.commit} higher={false} dec={3} />
                      <td className={`px-2 py-1.5 text-right tabular-nums ${BAND_CLS[ecTone(a.early_connection)] || ''}`}>{fmt(a.early_connection)}</td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${BAND_CLS[ciTone(a.connection_impact)] || ''}`}>{fmt(a.connection_impact)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {active && (() => {
            const a = active.avg || {}, pk = active.p95 || {}
            const bars = [
              ['Bat speed', fmt(a.bat_speed), pctlOf(a.bat_speed, cohort.bat), ' mph'],
              ['Peak bat speed', fmt(pk.bat_speed), pctlOf(pk.bat_speed, cohort.batP), ' mph'],
              ['Hand speed', fmt(a.hand_speed), pctlOf(a.hand_speed, cohort.hand), ' mph'],
              ['Rot acceleration', fmt(a.rot_accel), pctlOf(a.rot_accel, cohort.rot), ' g'],
              ['Power', fmt(a.power_kw, 2), pctlOf(a.power_kw, cohort.power), ' kW'],
              ['On-plane eff.', fmt(a.ope), pctlOf(a.ope, cohort.ope), '%'],
              ['Time to contact', fmt(a.ttc, 3), pctlOf(a.ttc, cohort.ttc, false), 's'],
              ['Commit time', fmt(a.commit_time, 3), pctlOf(a.commit_time, cohort.commit, false), 's'],
            ].filter(b => b[2] != null)
            const hist = data?.history?.[active.player]
            return (
              <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4 space-y-3">
                <div className="flex items-baseline justify-between flex-wrap gap-2">
                  <span className="font-bold text-gray-900 dark:text-gray-100">{active.player} — swing sheet</span>
                  <span className="text-[10px] text-gray-400">{active.swings ?? '–'} swings · percentiles vs this group</span>
                </div>
                <div className="grid md:grid-cols-3 gap-4 items-start">
                  <div className="space-y-2 md:col-span-1">
                    {bars.map(([l, v, p, u]) => <PctlBar key={l} label={l} value={v} pctl={p} unit={u} />)}
                  </div>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1 text-center">Swing shape</div>
                    <SwingShape avg={a} p95={pk} />
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 text-center">
                      VBA <b className="tabular-nums">{fmt(a.vert_bat_angle)}°</b> · body tilt <b className="tabular-nums">{fmt(a.body_tilt)}°</b>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Connection (ideal ≈ 90°)</div>
                    <ConnBar label="Early connection" v={a.early_connection} ideal={95} tone={ecTone(a.early_connection)} />
                    <ConnBar label="Connection at impact" v={a.connection_impact} ideal={90} tone={ciTone(a.connection_impact)} />
                    <ConnBar label="Hinge at impact" v={a.hinge_angle} ideal={65} tone={bandTone(a.hinge_angle, 55, 75, 12)} />
                    {hist && hist.length >= 2 && (
                      <div className="pt-2">
                        <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Avg bat speed by testing date</div>
                        <TrendSpark points={hist} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })()}

          <p className="text-[10.5px] text-gray-400 leading-snug max-w-4xl">
            Shading compares hitters within this testing group (red = top, blue = bottom). Banded columns
            use fixed windows instead: attack angle green at 5-20 degrees (on the pitch plane), early
            connection near 90-100 and connection at impact near 90 (the barrel staying connected to the
            turn). In Tank = peak minus average bat speed; a small gap on a fast bat is repeatable power,
            a big gap means the best swing is not showing up often. Save PDF exports the whole board.
          </p>
        </div>
      )}
    </div>
  )
}
