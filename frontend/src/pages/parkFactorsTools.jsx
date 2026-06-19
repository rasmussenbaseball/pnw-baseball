/**
 * Native, theme-aware ports of Kai Malloch's Park Factors interactive tools.
 * BuilderSuite owns one configured park (elevation, temp, wind, 5-corner fences,
 * wall heights) — the draggable field diagram, the batted-ball panel, and the
 * pitch panel all run on it. TravelScout and ParkMap are standalone. All math is
 * his (lib/parkPhysics.js); UI is our Tailwind theme (light/dark) on live data.
 */
import { useState, useMemo, useRef } from 'react'
import {
  builderScore, airDensityRatio, simulateBattedBall, classifyBattedBall,
  pitchMovement, axisHint, WINDS, GEO, MAP, CASCADE_LON,
} from '../lib/parkPhysics'

const DIRS = [['lf', 'LF', -45], ['lcf', 'LCF', -22.5], ['cf', 'CF', 0], ['rcf', 'RCF', 22.5], ['rf', 'RF', 45]]
const GEO_ALIAS = { 'Lewis & Clark Pioneers': 'Lewis & Clark River Otters' }

export function scoreHex(idx) {
  if (idx == null) return '#9ca3af'
  if (idx >= 108) return '#dc2626'
  if (idx >= 103) return '#f97316'
  if (idx > 97) return '#9ca3af'
  if (idx > 92) return '#3b82f6'
  return '#4f46e5'
}
function tiltLabel(idx) {
  if (idx >= 108) return 'Strong hitter'
  if (idx >= 103) return 'Hitter'
  if (idx > 97) return 'Neutral'
  if (idx > 92) return 'Pitcher'
  return 'Strong pitcher'
}
const TONE = { hitter: 'text-red-600 dark:text-red-400', pitcher: 'text-blue-600 dark:text-blue-400', teal: 'text-nw-teal', white: 'text-gray-700 dark:text-gray-200' }
function windCategory(w) {
  const s = (w || '').toLowerCase()
  if (s.includes('strong')) return 'Strong'
  if (s.includes('moderate')) return 'Moderate'
  if (s.includes('light')) return 'Light'
  return 'Calm'
}

function Slider({ label, value, min, max, step = 1, onChange, display }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-gray-500 dark:text-gray-400">{label}</span>
        <span className="font-bold tabular-nums text-pnw-slate dark:text-gray-100">{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-nw-teal" />
    </div>
  )
}

// ─────────────── Draggable field diagram (5 corners + walls + carry arc) ──────────────
function FieldDiagram({ dims, walls, onDrag, carryFt }) {
  const svgRef = useRef(null)
  const [drag, setDrag] = useState(null)
  const W = 320, H = 226, cx = W / 2, cy = H - 18, scale = (cy - 30) / 440
  const fx = (x) => cx + x * scale
  const fy = (y) => cy - y * scale
  const pol = (d, deg) => { const r = (deg * Math.PI) / 180; return [fx(d * Math.sin(r)), fy(d * Math.cos(r))] }
  const wall = DIRS.map(([k, , deg]) => pol(dims[k], deg))
  const home = [fx(0), fy(0)]
  const toSvg = (e) => { const r = svgRef.current.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H] }
  const onMove = (e) => {
    if (!drag) return
    const [x, y] = toSvg(e)
    const dist = Math.hypot(x - cx, cy - y) / scale
    onDrag(drag, Math.max(290, Math.min(440, Math.round(dist))))
  }
  const carryArc = carryFt
    ? [-45, -33.75, -22.5, -11.25, 0, 11.25, 22.5, 33.75, 45].map((d) => pol(Math.min(carryFt, 438), d).join(',')).join(' ')
    : null
  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto touch-none select-none"
      onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
      <polygon points={[home, ...wall].map((p) => p.join(',')).join(' ')} className="fill-green-600/20 dark:fill-green-700/25" />
      <line x1={home[0]} y1={home[1]} x2={wall[0][0]} y2={wall[0][1]} stroke="#9ca3af" strokeWidth="0.8" />
      <line x1={home[0]} y1={home[1]} x2={wall[4][0]} y2={wall[4][1]} stroke="#9ca3af" strokeWidth="0.8" />
      {carryArc && <polyline points={carryArc} fill="none" stroke="#f97316" strokeWidth="1.2" strokeDasharray="3 2" opacity="0.9" />}
      {/* wall segments, thickness = height */}
      {wall.slice(0, -1).map((p, i) => (
        <line key={i} x1={p[0]} y1={p[1]} x2={wall[i + 1][0]} y2={wall[i + 1][1]}
          stroke="#0e8aa0" strokeWidth={Math.max(1.2, (Number(walls[DIRS[i][0]]) || 8) / 3)} strokeLinecap="round" />
      ))}
      <circle cx={home[0]} cy={home[1]} r="2" fill="#fff" stroke="#888" strokeWidth="0.5" />
      {DIRS.map(([k, lab, deg], i) => {
        const [px, py] = wall[i]
        const r = (deg * Math.PI) / 180
        return (
          <g key={k}>
            <circle cx={px} cy={py} r={drag === k ? 7 : 5} fill="#13b1c6" stroke="#fff" strokeWidth="1.5"
              style={{ cursor: 'grab' }} onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); setDrag(k) }} />
            <text x={px + Math.sin(r) * 13} y={py - Math.cos(r) * 13 + 3}
              textAnchor={deg < -5 ? 'end' : deg > 5 ? 'start' : 'middle'} fontSize="9" className="fill-gray-600 dark:fill-gray-300 font-semibold">{dims[k]}</text>
          </g>
        )
      })}
    </svg>
  )
}

// ─────────────────────────── BUILDER SUITE ───────────────────────────
export function BuilderSuite({ teams }) {
  const sorted = useMemo(() => [...teams].sort((a, b) => a.short_name.localeCompare(b.short_name)), [teams])
  const [elev, setElev] = useState(500)
  const [temp, setTemp] = useState(62)
  const [wind, setWind] = useState('Calm')
  const [dims, setDims] = useState({ lf: 325, lcf: 365, cf: 395, rcf: 365, rf: 325 })
  const [walls, setWalls] = useState({ lf: 8, lcf: 8, cf: 8, rcf: 8, rf: 8 })
  const [loaded, setLoaded] = useState('')

  const loadPark = (name) => {
    setLoaded(name)
    const p = teams.find((t) => t.full_name === name)
    if (!p) return
    setElev(p.elevation_ft || 0)
    setTemp(Math.round(p.avg_temp_f || 60))
    setWind(windCategory(p.wind))
    const d = p.dimensions || {}
    setDims({ lf: d.lf || 325, lcf: d.lcf || 365, cf: d.cf || 395, rcf: d.rcf || 365, rf: d.rf || 325 })
  }
  const setFence = (k, v) => setDims((prev) => ({ ...prev, [k]: v }))
  const adof = (dims.lf + dims.lcf + dims.cf + dims.rcf + dims.rf) / 5
  const r = builderScore(elev, adof, temp, wind)
  const rho = airDensityRatio(elev, temp)
  const carryFt = simulateBattedBall(100, 28, rho, 0, dims.cf).carry
  const c = scoreHex(r.score)

  return (
    <div className="space-y-3">
      {/* ── Builder ── */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-pnw-slate dark:text-gray-100">Park Builder</h3>
          <select value={loaded} onChange={(e) => loadPark(e.target.value)}
            className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200">
            <option value="">Load a real park…</option>
            {sorted.map((t) => <option key={t.team_id} value={t.full_name}>{t.short_name}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">Drag the fence points · orange arc = a 100mph/28° barrel's carry here</div>
            <FieldDiagram dims={dims} walls={walls} onDrag={setFence} carryFt={carryFt} />
            <div className="grid grid-cols-5 gap-1 mt-2">
              {DIRS.map(([k, lab]) => (
                <label key={k} className="text-center">
                  <div className="text-[9px] text-gray-400 dark:text-gray-500">{lab} wall</div>
                  <input type="number" value={walls[k]} min={2} max={40}
                    onChange={(e) => setWalls((w) => ({ ...w, [k]: Number(e.target.value) }))}
                    className="w-full text-xs text-center px-1 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200" />
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <Slider label="Elevation" value={elev} min={0} max={4500} step={10} onChange={setElev} display={`${elev.toLocaleString()} ft`} />
            <Slider label="Game-time temp" value={temp} min={45} max={85} onChange={setTemp} display={`${temp}°F`} />
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Wind</div>
              <div className="flex gap-1">
                {WINDS.map((w) => (
                  <button key={w} type="button" onClick={() => setWind(w)}
                    className={`flex-1 text-xs font-semibold py-1 rounded border ${wind === w
                      ? 'bg-pnw-forest text-white border-pnw-forest'
                      : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300'}`}>{w}</button>
                ))}
              </div>
            </div>
            <div className="text-[11px] text-gray-400 dark:text-gray-500">Avg outfield depth: {adof.toFixed(0)} ft</div>
          </div>
          <div className="flex flex-col items-center justify-center gap-2 border-t lg:border-t-0 lg:border-l border-gray-200 dark:border-gray-700 pt-3 lg:pt-0 lg:pl-4">
            <div className="w-20 h-20 rounded-full flex items-center justify-center border-4" style={{ borderColor: c, color: c }}>
              <span className="text-2xl font-bold">{r.score.toFixed(0)}</span>
            </div>
            <span className="text-xs font-semibold" style={{ color: c }}>{tiltLabel(r.score)}</span>
            {elev >= 2500 && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">⚡ Magnus zone</span>}
            <div className="w-full space-y-0.5 mt-1">
              {[['Elevation', r.elevE], ['Dimensions', r.dimE], ['Temperature', r.tempE], ['Wind', r.windE]].map(([l, v]) => (
                <div key={l} className="flex items-center justify-between text-xs">
                  <span className="text-gray-500 dark:text-gray-400">{l}</span>
                  <span className={`font-bold tabular-nums ${v >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}`}>{v >= 0 ? '+' : ''}{v.toFixed(1)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <BattedBallPanel dims={dims} walls={walls} rho={rho} />
        <PitchPanel elev={elev} temp={temp} />
      </div>
      <p className="text-[11px] text-gray-400 dark:text-gray-500">The labs run on the park you built (or loaded) above — first-order physics calibrated to Statcast norms.</p>
    </div>
  )
}

// ─────────────────────────── BATTED-BALL PANEL ───────────────────────────
function BattedBallPanel({ dims, walls, rho }) {
  const [ev, setEv] = useState(98)
  const [la, setLa] = useState(27)
  const [tail, setTail] = useState(0)
  const [dir, setDir] = useState('cf')
  const fenceFt = dims[dir]
  const wallFt = Number(walls[dir]) || 8
  const bb = simulateBattedBall(ev, la, rho, tail, fenceFt)
  const cls = classifyBattedBall(bb, fenceFt, wallFt, la)
  const sea = simulateBattedBall(ev, la, airDensityRatio(0, 59), 0, fenceFt)
  const minEvHR = useMemo(() => {
    for (let e = 60; e <= 120; e += 1) {
      const s = simulateBattedBall(e, la, rho, tail, fenceFt)
      if (s.hAtF !== null && s.hAtF > wallFt) return e
    }
    return null
  }, [la, rho, tail, fenceFt, wallFt])

  const W = 320, H = 150, maxX = Math.max(bb.carry, fenceFt + 15), maxY = Math.max(bb.apex + 8, wallFt + 12)
  const sx = (x) => 6 + (x / maxX) * (W - 12)
  const sy = (y) => H - 14 - (y / maxY) * (H - 24)
  const pathD = bb.path.map((p, i) => `${i ? 'L' : 'M'} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ')

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="font-bold text-pnw-slate dark:text-gray-100 mb-2">Batted-Ball Lab</h3>
      <div className="flex gap-1 mb-3">
        {DIRS.map(([k, lab]) => (
          <button key={k} type="button" onClick={() => setDir(k)}
            className={`flex-1 text-xs font-semibold py-1 rounded border ${dir === k
              ? 'bg-pnw-forest text-white border-pnw-forest'
              : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300'}`}>{lab}</button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-2">
          <Slider label="Exit velocity" value={ev} min={60} max={118} onChange={setEv} display={`${ev} mph`} />
          <Slider label="Launch angle" value={la} min={5} max={45} onChange={setLa} display={`${la}°`} />
          <Slider label="Tailwind" value={tail} min={-12} max={15} onChange={setTail} display={`${tail >= 0 ? '+' : ''}${tail} mph`} />
        </div>
        <div className="flex flex-col items-center justify-center">
          <div className="text-3xl font-bold text-pnw-slate dark:text-gray-100">{bb.carry.toFixed(0)} <span className="text-base font-semibold text-gray-400">ft</span></div>
          <div className={`text-sm font-bold ${TONE[cls.tone] || TONE.white}`}>{cls.label}</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 text-center">{cls.note}</div>
          <div className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">{(bb.carry - sea.carry) >= 0 ? '+' : ''}{(bb.carry - sea.carry).toFixed(0)} ft vs sea level</div>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto mt-2">
        <line x1={6} y1={H - 14} x2={W - 6} y2={H - 14} className="stroke-gray-300 dark:stroke-gray-600" strokeWidth="0.8" />
        <line x1={sx(fenceFt)} y1={sy(wallFt)} x2={sx(fenceFt)} y2={H - 14} stroke="#0e8aa0" strokeWidth="2" />
        <text x={sx(fenceFt)} y={sy(wallFt) - 3} textAnchor="middle" fontSize="8" className="fill-gray-400">{dir.toUpperCase()} {fenceFt}/{wallFt}</text>
        <path d={pathD} fill="none" stroke={cls.tone === 'hitter' ? '#dc2626' : '#3b82f6'} strokeWidth="2" />
      </svg>
      <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
        {minEvHR === null ? `No EV up to 120 clears ${dir.toUpperCase()} at ${la}°` : `Clears ${dir.toUpperCase()} down to ${minEvHR} mph at ${la}°`}
      </div>
      <div className="mt-2">
        <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">Spray check · same swing, all five</div>
        <div className="grid grid-cols-5 gap-1">
          {DIRS.map(([k, lab]) => {
            const s = simulateBattedBall(ev, la, rho, tail, dims[k])
            const cc = classifyBattedBall(s, dims[k], Number(walls[k]) || 8, la)
            const short = { 'Home Run': 'HR', Double: '2B', Single: '1B', 'Line Out': 'LO', 'Fly Out': 'FO' }[cc.label] || cc.label
            return (
              <div key={k} className={`text-center text-[11px] rounded py-1 ${cc.tone === 'hitter' ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400' : cc.tone === 'teal' ? 'bg-nw-teal/10 text-nw-teal' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
                <div className="text-[9px] text-gray-400">{lab}</div><div className="font-bold">{short}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────── PITCH PANEL ───────────────────────────
const PITCHES = [
  ['4-Seam', 95, 2400, 0, 0.92], ['Sinker', 93, 2150, 60, 0.88], ['Cutter', 89, 2400, 320, 0.55],
  ['Slider', 85, 2500, 280, 0.35], ['Sweeper', 83, 2700, 260, 0.28], ['Curveball', 80, 2600, 185, 0.85],
  ['Changeup', 85, 1750, 75, 0.90], ['Splitter', 86, 1400, 90, 0.45], ['Knuckleball', 73, 500, 0, 0.05],
]
const ELEVS = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4108]

// Spin axis (degrees, 0 = pure ride/backspin) → clock face, RHP perspective.
function clockLabel(deg) {
  const hoursFloat = ((deg % 360) + 360) % 360 / 30 // 30° per hour, 0° = 12:00
  let h = Math.floor(hoursFloat)
  let m = Math.round((hoursFloat - h) * 60)
  if (m === 60) { m = 0; h += 1 }
  h = h % 12
  return `${h === 0 ? 12 : h}:${String(m).padStart(2, '0')}`
}

function PitchPanel({ elev, temp }) {
  const [name, setName] = useState('4-Seam')
  const [velo, setVelo] = useState(95)
  const [rpm, setRpm] = useState(2400)
  const [axis, setAxis] = useState(0)
  const [eff, setEff] = useState(92)
  const pick = (p) => { setName(p[0]); setVelo(p[1]); setRpm(p[2]); setAxis(p[3]); setEff(Math.round(p[4] * 100)) }
  const e100 = eff / 100
  const mvHere = pitchMovement(velo, rpm, e100, airDensityRatio(elev, temp))
  const mvSea = pitchMovement(velo, rpm, e100, airDensityRatio(0, temp))
  const axRad = (axis * Math.PI) / 180
  const ivb = mvHere * Math.cos(axRad)
  const hb = mvHere * Math.sin(axRad)
  const elevMoves = ELEVS.map((e) => pitchMovement(velo, rpm, e100, airDensityRatio(e, temp)))
  const maxMv = Math.max(...elevMoves, mvSea, 0.1)
  const nearRow = ELEVS.reduce((b, e) => (Math.abs(e - elev) < Math.abs(b - elev) ? e : b), ELEVS[0])

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="font-bold text-pnw-slate dark:text-gray-100 mb-2">Pitch Lab</h3>
      <div className="flex flex-wrap gap-1 mb-3">
        {PITCHES.map((p) => (
          <button key={p[0]} type="button" onClick={() => pick(p)}
            className={`text-[11px] font-semibold px-2 py-1 rounded border ${name === p[0]
              ? 'bg-pnw-forest text-white border-pnw-forest'
              : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300'}`}>{p[0]}</button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-2">
          <Slider label="Velocity" value={velo} min={70} max={102} onChange={setVelo} display={`${velo} mph`} />
          <Slider label="Spin rate" value={rpm} min={400} max={3200} step={50} onChange={setRpm} display={`${rpm.toLocaleString()} rpm`} />
          <Slider label="Spin axis" value={axis} min={0} max={359} onChange={setAxis} display={`${clockLabel(axis)} · ${axisHint(axis)}`} />
          <Slider label="Spin efficiency" value={eff} min={5} max={100} onChange={setEff} display={`${eff}%`} />
        </div>
        <div className="flex flex-col items-center justify-center gap-1">
          <div className="text-3xl font-bold text-pnw-slate dark:text-gray-100">{mvHere.toFixed(1)} <span className="text-base font-semibold text-gray-400">in</span></div>
          <div className="flex gap-3 text-[11px]">
            <span className="text-gray-500 dark:text-gray-400">IVB <span className="font-bold text-pnw-slate dark:text-gray-200">{ivb >= 0 ? '+' : ''}{ivb.toFixed(1)}</span></span>
            <span className="text-gray-500 dark:text-gray-400">HB <span className="font-bold text-pnw-slate dark:text-gray-200">{hb >= 0 ? '+' : ''}{hb.toFixed(1)}</span></span>
          </div>
          <div className="text-[11px] text-gray-400 dark:text-gray-500">{(mvHere - mvSea) >= 0 ? '+' : ''}{(mvHere - mvSea).toFixed(1)} in vs sea level</div>
        </div>
      </div>
      {/* movement at every elevation */}
      <div className="mt-3">
        <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">Movement at every elevation</div>
        <div className="flex items-end gap-1">
          {ELEVS.map((e, i) => {
            const barPx = Math.max(3, Math.round((elevMoves[i] / maxMv) * 90))
            const inMagnus = e >= 2500
            const isHere = e === nearRow
            return (
              <div key={e} className="flex-1 flex flex-col items-center justify-end" title={`${e.toLocaleString()} ft: ${elevMoves[i].toFixed(1)} in`}>
                <div className="text-[8px] font-semibold text-gray-500 dark:text-gray-400 tabular-nums">{elevMoves[i].toFixed(1)}</div>
                <div className="w-full rounded-t" style={{ height: `${barPx}px`, background: isHere ? '#13b1c6' : inMagnus ? '#f59e0b' : '#cbd5e1' }} />
                <div className="text-[7px] text-gray-400 dark:text-gray-500 mt-0.5">{e >= 4108 ? '4.1k*' : e >= 1000 ? `${e / 1000}k` : e}</div>
              </div>
            )
          })}
        </div>
        <div className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">Break (in) by elevation. <span className="text-amber-500">Amber</span> = Magnus zone (2,500+ ft), <span className="text-nw-teal">teal</span> = your park. * Oregon Tech, the PNW ceiling.</div>
      </div>
    </div>
  )
}

// ─────────────────────────── TRAVEL SCOUT ───────────────────────────
export function TravelScout({ teams }) {
  const DIVS = ['NWAC', 'NAIA', 'NCAA D1', 'NCAA D2', 'NCAA D3']
  const [div, setDiv] = useState('NWAC')
  const inDiv = useMemo(() => teams.filter((t) => t.division === div).sort((a, b) => a.short_name.localeCompare(b.short_name)), [teams, div])
  const [homeName, setHomeName] = useState('')
  const [roadName, setRoadName] = useState('')
  const home = inDiv.find((t) => t.full_name === homeName) || inDiv[0]
  const road = inDiv.find((t) => t.full_name === roadName && t.full_name !== home?.full_name)
    || inDiv.find((t) => t.full_name !== home?.full_name)
  if (!home || !road) return <div className="text-sm text-gray-400 py-8 text-center">Pick a division with at least two parks.</div>

  const carry = (p) => simulateBattedBall(100, 28, airDensityRatio(p.elevation_ft || 0, p.avg_temp_f || 60), 0, 400).carry
  const brk = (p) => pitchMovement(95, 2400, 0.92, airDensityRatio(p.elevation_ft || 0, p.avg_temp_f || 60))
  const swing = (road.park_index || 0) - (home.park_index || 0)
  const dCarry = carry(road) - carry(home)
  const dBrk = (100 * (brk(road) - brk(home))) / brk(home)
  const magFlip = (road.elevation_ft >= 2500) !== (home.elevation_ft >= 2500)

  const Sel = ({ value, onChange, label }) => (
    <label className="flex-1 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">{label}</div>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200">
        {inDiv.map((t) => <option key={t.team_id} value={t.full_name}>{t.short_name}</option>)}
      </select>
    </label>
  )
  const Row = ({ label, home: h, road: rr, delta, good }) => (
    <div className="grid grid-cols-3 items-center text-sm py-1.5 border-b border-gray-100 dark:border-gray-700/60">
      <span className="text-gray-500 dark:text-gray-400 text-xs">{label}</span>
      <span className="text-center tabular-nums text-gray-700 dark:text-gray-300">{h} <span className="text-gray-300 dark:text-gray-600">→</span> {rr}</span>
      <span className={`text-right font-bold tabular-nums ${good === null ? 'text-gray-500' : good ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}`}>{delta}</span>
    </div>
  )
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 max-w-2xl">
      <h3 className="font-bold text-pnw-slate dark:text-gray-100 mb-3">Travel Scout</h3>
      <div className="flex flex-wrap gap-1 mb-3">
        {DIVS.map((d) => (
          <button key={d} type="button" onClick={() => { setDiv(d); setHomeName(''); setRoadName('') }}
            className={`text-xs font-semibold px-2 py-1 rounded border ${div === d
              ? 'bg-pnw-forest text-white border-pnw-forest'
              : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300'}`}>{d.replace('NCAA ', '')}</button>
        ))}
      </div>
      <div className="flex gap-3 mb-3">
        <Sel value={home.full_name} onChange={setHomeName} label="Home park" />
        <Sel value={road.full_name} onChange={setRoadName} label="Road park" />
      </div>
      <div className="flex items-center justify-center gap-2 mb-3">
        <span className="text-xs text-gray-500 dark:text-gray-400">Run-environment swing</span>
        <span className={`text-2xl font-bold ${swing >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}`}>{swing >= 0 ? '+' : ''}{swing.toFixed(1)}</span>
      </div>
      <Row label="Park Index" home={home.park_index?.toFixed(0)} road={road.park_index?.toFixed(0)} delta={`${swing >= 0 ? '+' : ''}${swing.toFixed(1)}`} good={swing >= 0} />
      <Row label="100mph/28° carry" home={`${carry(home).toFixed(0)}'`} road={`${carry(road).toFixed(0)}'`} delta={`${dCarry >= 0 ? '+' : ''}${dCarry.toFixed(0)} ft`} good={dCarry >= 0} />
      <Row label="Breaking-ball move" home={`${brk(home).toFixed(1)}"`} road={`${brk(road).toFixed(1)}"`} delta={`${dBrk >= 0 ? '+' : ''}${dBrk.toFixed(0)}%`} good={dBrk < 0} />
      <Row label="Surface" home={home.surface || '—'} road={road.surface || '—'} delta={(home.surface || '') === (road.surface || '') ? 'same' : 'changes'} good={null} />
      {magFlip && <div className="mt-3 text-[11px] font-semibold px-2 py-1 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 inline-block">⚡ Magnus flip — one of these is a 2,500+ ft altitude park</div>}
    </div>
  )
}

// ─────────────────────────── REGIONAL MAP ───────────────────────────
export function ParkMap({ teams }) {
  const [hover, setHover] = useState(null)
  const W = 720, H = 470, pad = 14
  const lonMin = -124.95, lonMax = -107.4, latMin = 41.6, latMax = 49.95
  const X = (lon) => pad + ((lon - lonMin) / (lonMax - lonMin)) * (W - 2 * pad)
  const Y = (lat) => pad + ((latMax - lat) / (latMax - latMin)) * (H - 2 * pad)
  const poly = (pts) => pts.map(([la, lo]) => `${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join(' ')
  const geoOf = (t) => GEO[t.full_name] || GEO[GEO_ALIAS[t.full_name]]
  const pts = teams.filter(geoOf)
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-bold text-pnw-slate dark:text-gray-100">Regional Map</h3>
        <div className="flex items-center gap-2 text-[10px] text-gray-500 dark:text-gray-400">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: '#dc2626' }} />Hitter</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: '#9ca3af' }} />Neutral</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: '#4f46e5' }} />Pitcher</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        {Object.values(MAP).map((pts2, i) => (
          <polygon key={i} points={poly(pts2)} className="fill-gray-100 dark:fill-gray-900/60 stroke-gray-300 dark:stroke-gray-600" strokeWidth="1" />
        ))}
        <line x1={X(CASCADE_LON)} y1={pad} x2={X(CASCADE_LON)} y2={H - pad} stroke="#13b1c6" strokeWidth="1" strokeDasharray="5 4" opacity="0.5" />
        <text x={X(CASCADE_LON) + 3} y={pad + 10} fontSize="8" className="fill-nw-teal" opacity="0.8">Cascades</text>
        {pts.map((t) => {
          const [la, lo] = geoOf(t)
          const on = hover === t.full_name
          return (
            <g key={t.team_id} onMouseEnter={() => setHover(t.full_name)} onMouseLeave={() => setHover(null)} style={{ cursor: 'pointer' }}>
              <circle cx={X(lo)} cy={Y(la)} r={on ? 6 : 4} fill={scoreHex(t.park_index)} stroke="#fff" strokeWidth={on ? 1.5 : 0.8} />
            </g>
          )
        })}
        {hover && (() => {
          const t = teams.find((x) => x.full_name === hover); const [la, lo] = GEO[hover] || GEO[GEO_ALIAS[hover]]
          return (
            <g>
              <rect x={Math.min(X(lo) + 8, W - 130)} y={Y(la) - 22} width="124" height="30" rx="4" className="fill-gray-900/90" />
              <text x={Math.min(X(lo) + 14, W - 124)} y={Y(la) - 10} fontSize="9" fill="#fff" fontWeight="700">{t.short_name}</text>
              <text x={Math.min(X(lo) + 14, W - 124)} y={Y(la) + 1} fontSize="8" fill="#cbd5e1">Index {t.park_index?.toFixed(0)} · {t.elevation_ft?.toLocaleString()} ft</text>
            </g>
          )
        })()}
      </svg>
    </div>
  )
}
