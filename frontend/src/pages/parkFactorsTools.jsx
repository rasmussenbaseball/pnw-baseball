/**
 * Native, theme-aware ports of Kai Malloch's Park Factors interactive tools:
 * Park Builder, Batted-ball lab, Pitch lab, and the regional Map. All math is
 * his (lib/parkPhysics.js); the UI is rebuilt in our Tailwind theme (light/dark)
 * and reads the live /park-factors data.
 */
import { useState, useMemo } from 'react'
import {
  builderScore, airDensityRatio, simulateBattedBall, classifyBattedBall,
  pitchMovement, axisHint, WINDS, GEO, MAP, CASCADE_LON,
} from '../lib/parkPhysics'

// index → color (works on light + dark). Mirrors the leaderboard tilt buckets.
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

// Our L&C full_name differs from Kai's GEO key.
const GEO_ALIAS = { 'Lewis & Clark Pioneers': 'Lewis & Clark River Otters' }

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
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-nw-teal"
      />
    </div>
  )
}

function IndexDial({ idx }) {
  const c = scoreHex(idx)
  return (
    <div className="flex flex-col items-center shrink-0">
      <div className="w-20 h-20 rounded-full flex items-center justify-center border-4" style={{ borderColor: c, color: c }}>
        <span className="text-2xl font-bold">{idx.toFixed(0)}</span>
      </div>
      <span className="text-xs font-semibold mt-1" style={{ color: c }}>{tiltLabel(idx)}</span>
    </div>
  )
}

// ─────────────────────────── PARK BUILDER ───────────────────────────
export function ParkBuilder({ teams }) {
  const sorted = useMemo(() => [...teams].sort((a, b) => a.short_name.localeCompare(b.short_name)), [teams])
  const [elev, setElev] = useState(500)
  const [adof, setAdof] = useState(350)
  const [temp, setTemp] = useState(62)
  const [wind, setWind] = useState('Calm')
  const [loaded, setLoaded] = useState('')

  const loadPark = (name) => {
    setLoaded(name)
    const p = teams.find((t) => t.full_name === name)
    if (!p) return
    setElev(p.elevation_ft || 0)
    setAdof(Math.round(p.dimensions?.avg_of || 350))
    setTemp(Math.round(p.avg_temp_f || 60))
    setWind(windCategory(p.wind))
  }

  const r = builderScore(elev, adof, temp, wind)
  const nearest = useMemo(
    () => [...teams].sort((a, b) => Math.abs(a.park_index - r.score) - Math.abs(b.park_index - r.score)).slice(0, 3),
    [teams, r.score]
  )
  const Contrib = ({ label, v }) => (
    <div className="flex items-center justify-between text-xs">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className={`font-bold tabular-nums ${v >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}`}>{v >= 0 ? '+' : ''}{v.toFixed(1)}</span>
    </div>
  )

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold text-pnw-slate dark:text-gray-100">Park Builder</h3>
        <select value={loaded} onChange={(e) => loadPark(e.target.value)}
          className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200">
          <option value="">Load a real park…</option>
          {sorted.map((t) => <option key={t.team_id} value={t.full_name}>{t.short_name}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-3">
          <Slider label="Elevation" value={elev} min={0} max={4500} step={10} onChange={setElev} display={`${elev.toLocaleString()} ft`} />
          <Slider label="Avg outfield depth" value={adof} min={320} max={410} onChange={setAdof} display={`${adof} ft`} />
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
        </div>

        <div className="flex flex-col items-center justify-center gap-3 border-t sm:border-t-0 sm:border-l border-gray-200 dark:border-gray-700 pt-3 sm:pt-0 sm:pl-4">
          <IndexDial idx={r.score} />
          {elev >= 2500 && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">⚡ Magnus zone (2,500+ ft)</span>
          )}
          <div className="w-full space-y-0.5">
            <Contrib label="Elevation" v={r.elevE} />
            <Contrib label="Dimensions" v={r.dimE} />
            <Contrib label="Temperature" v={r.tempE} />
            <Contrib label="Wind" v={r.windE} />
          </div>
          <div className="text-[11px] text-gray-400 dark:text-gray-500 text-center">
            Plays like: {nearest.map((p) => p.short_name).join(', ')}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────── BATTED-BALL LAB ───────────────────────────
export function BattedBallLab({ teams }) {
  const sorted = useMemo(() => [...teams].sort((a, b) => a.short_name.localeCompare(b.short_name)), [teams])
  const [ev, setEv] = useState(100)
  const [la, setLa] = useState(28)
  const [tail, setTail] = useState(0)
  const [parkName, setParkName] = useState(sorted[0]?.full_name || '')
  const park = teams.find((t) => t.full_name === parkName) || sorted[0]
  const elev = park?.elevation_ft || 0
  const temp = park?.avg_temp_f || 60
  const fenceFt = park?.dimensions?.cf || 400
  const wallFt = 8
  const rho = airDensityRatio(elev, temp)
  const b = simulateBattedBall(ev, la, rho, tail, fenceFt)
  const sea = simulateBattedBall(ev, la, 1.0, tail, fenceFt)
  const cls = classifyBattedBall(b, fenceFt, wallFt, la)
  const dCarry = b.carry - sea.carry

  // trajectory svg
  const W = 320, H = 130, maxX = Math.max(b.carry, fenceFt) * 1.05, maxY = Math.max(b.apex, 50) * 1.1
  const sx = (x) => 6 + (x / maxX) * (W - 12)
  const sy = (y) => H - 6 - (y / maxY) * (H - 16)
  const pathD = b.path.map((p, i) => `${i ? 'L' : 'M'} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ')

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold text-pnw-slate dark:text-gray-100">Batted-Ball Lab</h3>
        <select value={parkName} onChange={(e) => setParkName(e.target.value)}
          className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200">
          {sorted.map((t) => <option key={t.team_id} value={t.full_name}>{t.short_name}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-3">
          <Slider label="Exit velocity" value={ev} min={60} max={118} onChange={setEv} display={`${ev} mph`} />
          <Slider label="Launch angle" value={la} min={5} max={45} onChange={setLa} display={`${la}°`} />
          <Slider label="Tailwind" value={tail} min={-12} max={15} onChange={setTail} display={`${tail >= 0 ? '+' : ''}${tail} mph`} />
          <div className="text-[11px] text-gray-400 dark:text-gray-500">
            {park?.short_name} · {elev.toLocaleString()} ft · {temp}°F · {fenceFt} ft to CF
          </div>
        </div>
        <div className="flex flex-col items-center justify-center gap-2">
          <div className="text-3xl font-bold text-pnw-slate dark:text-gray-100">{b.carry.toFixed(0)} <span className="text-base font-semibold text-gray-400">ft</span></div>
          <div className={`text-sm font-bold ${TONE[cls.tone] || TONE.white}`}>{cls.label}</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 text-center">{cls.note}</div>
          <div className="text-[11px] text-gray-400 dark:text-gray-500">
            {dCarry >= 0 ? '+' : ''}{dCarry.toFixed(0)} ft vs sea level · apex {b.apex.toFixed(0)} ft · {b.hang.toFixed(1)}s hang
          </div>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto mt-3">
        <line x1={sx(fenceFt)} y1={6} x2={sx(fenceFt)} y2={H - 6} stroke="#9ca3af" strokeWidth="1" strokeDasharray="3 2" />
        <line x1={6} y1={H - 6} x2={W - 6} y2={H - 6} stroke="currentColor" className="text-gray-300 dark:text-gray-600" strokeWidth="0.8" />
        <path d={pathD} fill="none" stroke={scoreHex(cls.tone === 'hitter' ? 110 : 95)} strokeWidth="2" />
        <text x={sx(fenceFt) - 2} y={16} textAnchor="end" fontSize="8" className="fill-gray-400">CF {fenceFt}</text>
      </svg>
    </div>
  )
}

// ─────────────────────────── PITCH LAB ───────────────────────────
export function PitchLab({ teams }) {
  const sorted = useMemo(() => [...teams].sort((a, b) => a.short_name.localeCompare(b.short_name)), [teams])
  const [velo, setVelo] = useState(90)
  const [spin, setSpin] = useState(2300)
  const [eff, setEff] = useState(90)
  const [axis, setAxis] = useState(0)
  const [parkName, setParkName] = useState(sorted[0]?.full_name || '')
  const park = teams.find((t) => t.full_name === parkName) || sorted[0]
  const elev = park?.elevation_ft || 0
  const temp = park?.avg_temp_f || 60
  const rho = airDensityRatio(elev, temp)
  const move = pitchMovement(velo, spin, eff / 100, rho)
  const sea = pitchMovement(velo, spin, eff / 100, 1.0)
  const dMove = move - sea
  const rad = ((axis - 90) * Math.PI) / 180

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold text-pnw-slate dark:text-gray-100">Pitch Lab</h3>
        <select value={parkName} onChange={(e) => setParkName(e.target.value)}
          className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200">
          {sorted.map((t) => <option key={t.team_id} value={t.full_name}>{t.short_name}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-3">
          <Slider label="Velocity" value={velo} min={70} max={102} onChange={setVelo} display={`${velo} mph`} />
          <Slider label="Spin rate" value={spin} min={1400} max={3200} step={50} onChange={setSpin} display={`${spin.toLocaleString()} rpm`} />
          <Slider label="Spin efficiency" value={eff} min={50} max={100} onChange={setEff} display={`${eff}%`} />
          <Slider label="Spin axis (clock)" value={axis} min={0} max={359} onChange={setAxis} display={axisHint(axis)} />
          <div className="text-[11px] text-gray-400 dark:text-gray-500">{park?.short_name} · {elev.toLocaleString()} ft · {temp}°F</div>
        </div>
        <div className="flex flex-col items-center justify-center gap-2">
          <svg viewBox="0 0 120 120" className="w-28 h-28">
            <circle cx="60" cy="60" r="46" fill="none" stroke="currentColor" className="text-gray-200 dark:text-gray-700" strokeWidth="1" />
            <line x1="60" y1="60" x2={(60 + Math.cos(rad) * Math.min(move * 4, 44)).toFixed(1)} y2={(60 + Math.sin(rad) * Math.min(move * 4, 44)).toFixed(1)}
              stroke="#13b1c6" strokeWidth="3" strokeLinecap="round" />
            <circle cx="60" cy="60" r="3" fill="#13b1c6" />
          </svg>
          <div className="text-3xl font-bold text-pnw-slate dark:text-gray-100">{move.toFixed(1)} <span className="text-base font-semibold text-gray-400">in</span></div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">{axisHint(axis)}</div>
          <div className="text-[11px] text-gray-400 dark:text-gray-500">{dMove >= 0 ? '+' : ''}{dMove.toFixed(1)} in vs sea level</div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────── TRAVEL SCOUT ───────────────────────────
// How the environment changes when a team travels from its home park to an
// opponent's — index swing, carry & break deltas, Magnus flip, surface change.
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
  const Row = ({ label, home: h, road: r, delta, good }) => (
    <div className="grid grid-cols-3 items-center text-sm py-1.5 border-b border-gray-100 dark:border-gray-700/60">
      <span className="text-gray-500 dark:text-gray-400 text-xs">{label}</span>
      <span className="text-center tabular-nums text-gray-700 dark:text-gray-300">{h} <span className="text-gray-300 dark:text-gray-600">→</span> {r}</span>
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
      {magFlip && (
        <div className="mt-3 text-[11px] font-semibold px-2 py-1 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 inline-block">
          ⚡ Magnus flip — one of these is a 2,500+ ft altitude park
        </div>
      )}
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
        {/* Cascade crest split */}
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
