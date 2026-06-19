import { useState, useMemo } from 'react'
import { useParkFactors } from '../hooks/useApi'
import { BuilderSuite, ParkMap, TravelScout, scoreHex } from './parkFactorsTools'
import { airDensityRatio, simulateBattedBall } from '../lib/parkPhysics'

// ───────────────────────── helpers ─────────────────────────
const DIV_ORDER = ['NCAA D1', 'NCAA D2', 'NCAA D3', 'NAIA', 'NWAC']

function tilt(pct) {
  if (pct == null) return { label: 'Neutral', cls: 'text-gray-500', bg: 'bg-gray-100 dark:bg-gray-700', ring: 'ring-gray-300 dark:ring-gray-600' }
  if (pct >= 8) return { label: 'Strong hitter', cls: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/20', ring: 'ring-red-300 dark:ring-red-700' }
  if (pct >= 3) return { label: 'Hitter', cls: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-900/20', ring: 'ring-orange-300 dark:ring-orange-700' }
  if (pct > -3) return { label: 'Neutral', cls: 'text-gray-500 dark:text-gray-400', bg: 'bg-gray-100 dark:bg-gray-700', ring: 'ring-gray-300 dark:ring-gray-600' }
  if (pct > -8) return { label: 'Pitcher', cls: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-900/20', ring: 'ring-blue-300 dark:ring-blue-700' }
  return { label: 'Strong pitcher', cls: 'text-indigo-700 dark:text-indigo-400', bg: 'bg-indigo-50 dark:bg-indigo-900/20', ring: 'ring-indigo-300 dark:ring-indigo-700' }
}

// Per-factor contributions to (index - 100). These sum to the park's tilt.
function contributions(park) {
  const e = park.effects || {}
  const wObs = e.observed_weight ?? 0
  const wCond = 1 - wObs
  return {
    elev: wCond * (e.elevation_pct ?? 0),
    dim: wCond * (e.dimension_pct ?? 0),
    temp: wCond * (e.temperature_pct ?? 0),
    hr: wObs * (park.home_road_split_pct ?? 0),
    wObs,
  }
}

function ContribBar({ label, value }) {
  const pct = Math.min(Math.abs(value) / 12 * 100, 100)
  const pos = value >= 0
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-gray-500 dark:text-gray-400 w-20 text-right shrink-0">{label}</span>
      <div className="flex-1 h-3 bg-gray-100 dark:bg-gray-700 rounded-full relative overflow-hidden">
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-gray-300 dark:bg-gray-500" />
        <div
          className={`absolute top-0 h-full ${pos ? 'bg-red-400 rounded-r-full left-1/2' : 'bg-blue-400 rounded-l-full'}`}
          style={pos ? { width: `${pct / 2}%` } : { width: `${pct / 2}%`, right: '50%' }}
        />
      </div>
      <span className={`text-[11px] font-bold w-12 ${value >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}`}>
        {value >= 0 ? '+' : ''}{value.toFixed(1)}
      </span>
    </div>
  )
}

// Colored, to-scale ballpark from the five measured corners (LF/LCF/CF/RCF/RF).
// Real geometry: bases 90 ft apart; the infield "skin" is bounded by the 95 ft
// grass-line arc from the pitching rubber (the rounded dirt/grass cut). Grass vs
// turf comes from the surface string; mowing stripes radiate from home; the team
// logo (HTML overlay) sits in center field. Estimated dims: ~ prefix + dashed wall.
const GRASS = '#6ba253', GRASS2 = '#5c9147', TURF = '#33a576', TURF2 = '#2c9268', DIRT = '#c0824f'

function FieldShape({ dims, surface, logo, id, elevation, temp }) {
  if (!dims || !dims.cf) {
    return <div className="text-[11px] text-gray-400 italic text-center py-6">Dimensions unavailable</div>
  }
  const estimated = dims.status === 'estimated'
  const tilde = estimated ? '~' : ''
  const s = surface || ''
  const ofTurf = /turf\s*of/i.test(s) || /turf\s*inf\/turf/i.test(s)
  const infTurf = /turf\s*inf/i.test(s)
  const ofA = ofTurf ? TURF : GRASS
  const ofB = ofTurf ? TURF2 : GRASS2
  const infFill = infTurf ? TURF : DIRT

  const corners = [
    { d: dims.lf, deg: -45 }, { d: dims.lcf, deg: -22.5 }, { d: dims.cf, deg: 0 },
    { d: dims.rcf, deg: 22.5 }, { d: dims.rf, deg: 45 },
  ].filter((c) => c.d)
  const W = 200, H = 172, cx = W / 2, cy = H - 16, scale = (cy - 28) / 420
  const fx = (x) => cx + x * scale
  const fy = (y) => cy - y * scale
  const pol = (d, deg) => { const r = (deg * Math.PI) / 180; return [fx(d * Math.sin(r)), fy(d * Math.cos(r))] }
  const wall = corners.map((c) => pol(c.d, c.deg))
  const home = [fx(0), fy(0)]
  const fair = [home, ...wall].map((p) => p.join(',')).join(' ')
  const mound = [fx(0), fy(60.5)], moundR = 95 * scale
  const b1 = pol(90, 45), b2 = pol(127.28, 0), b3 = pol(90, -45)
  const stroke = estimated ? '#9ca3af' : '#0e8aa0'
  const cpId = `pf-clip-${id}`
  const [lx, ly] = pol(255, 0)

  const stripes = []
  const N = 10
  for (let i = 0; i < N; i++) {
    const p1 = pol(470, -45 + i * (90 / N))
    const p2 = pol(470, -45 + (i + 1) * (90 / N))
    stripes.push(<polygon key={i} points={`${home.join(',')} ${p1.join(',')} ${p2.join(',')}`} fill={i % 2 ? ofB : ofA} />)
  }
  // Dotted arc = a 100 mph / 28° barrel's carry in this park's air.
  const carryFt = (elevation != null && temp != null)
    ? simulateBattedBall(100, 28, airDensityRatio(elevation, temp), 0, dims.cf).carry : null
  const carryArc = carryFt
    ? [-45, -33.75, -22.5, -11.25, 0, 11.25, 22.5, 33.75, 45].map((d) => pol(Math.min(carryFt, 415), d).join(',')).join(' ')
    : null

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        <defs><clipPath id={cpId}><polygon points={fair} /></clipPath></defs>
        <g clipPath={`url(#${cpId})`}>
          {stripes}
          {/* infield dirt/turf skin, bounded by the 95 ft grass-line arc */}
          <circle cx={mound[0]} cy={mound[1]} r={moundR} fill={infFill} />
          {infTurf ? (
            <>
              <path d={`M ${home.join(' ')} L ${b1.join(' ')} L ${b2.join(' ')} L ${b3.join(' ')} Z`} fill="none" stroke={DIRT} strokeWidth={6 * scale} />
              <circle cx={home[0]} cy={home[1]} r={13 * scale} fill={DIRT} />
              <circle cx={mound[0]} cy={mound[1]} r={9 * scale} fill={DIRT} />
              {[b1, b2, b3].map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={7 * scale} fill={DIRT} />)}
            </>
          ) : (
            <circle cx={mound[0]} cy={mound[1]} r="1.6" fill="rgba(255,255,255,0.45)" />
          )}
          {/* bases + home */}
          {[b1, b2, b3].map((p, i) => <rect key={i} x={p[0] - 1.6} y={p[1] - 1.6} width="3.2" height="3.2" fill="#fff" transform={`rotate(45 ${p[0]} ${p[1]})`} />)}
          <circle cx={home[0]} cy={home[1]} r="1.9" fill="#fff" />
          {/* foul lines */}
          <line x1={home[0]} y1={home[1]} x2={wall[0][0]} y2={wall[0][1]} stroke="rgba(255,255,255,0.65)" strokeWidth="0.8" />
          <line x1={home[0]} y1={home[1]} x2={wall[4][0]} y2={wall[4][1]} stroke="rgba(255,255,255,0.65)" strokeWidth="0.8" />
        </g>
        {/* 100mph/28° carry arc in this park's air */}
        {carryArc && <polyline points={carryArc} fill="none" stroke="#f97316" strokeWidth="1.1" strokeDasharray="3 2" opacity="0.85" />}
        {/* outfield wall */}
        <polyline points={wall.map((p) => p.join(',')).join(' ')} fill="none"
          stroke={stroke} strokeWidth="1.8" strokeDasharray={estimated ? '4 2' : 'none'} strokeLinejoin="round" />
        {/* corner distance labels */}
        {corners.map((c, i) => {
          const [px, py] = wall[i]
          const r = (c.deg * Math.PI) / 180
          const tx = px + Math.sin(r) * 9
          const ty = py - Math.cos(r) * 9 + 2.5
          const anchor = c.deg < -5 ? 'end' : c.deg > 5 ? 'start' : 'middle'
          return (
            <text key={i} x={tx} y={ty} textAnchor={anchor} fontSize="9" fill="currentColor"
              className="text-gray-600 dark:text-gray-300 font-semibold">{tilde}{c.d}</text>
          )
        })}
      </svg>
      {/* team logo overlaid in center field */}
      {logo && (
        <img
          src={logo}
          alt=""
          className="absolute pointer-events-none"
          style={{
            width: '14%', left: `${(lx / W) * 100}%`, top: `${(ly / H) * 100}%`,
            transform: 'translate(-50%, -50%)',
            filter: 'drop-shadow(0 0 2px #fff) drop-shadow(0 0 2px #fff)',
          }}
          onError={(e) => { e.target.style.display = 'none' }}
        />
      )}
    </div>
  )
}

function ParkCard({ park }) {
  const [open, setOpen] = useState(false)
  const idx = park.park_index
  const pct = park.park_factor_pct
  const t = tilt(pct)
  const c = contributions(park)
  const dims = park.dimensions || {}
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-pnw-slate dark:text-gray-100 truncate">{park.short_name}</span>
            {park.elevation_ft >= 2500 && (
              <span title="Magnus zone — 2,500+ ft elevation noticeably boosts carry & break"
                className="text-[9px] font-bold px-1 py-px rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 whitespace-nowrap">⚡ Magnus</span>
            )}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{park.stadium}</div>
          <div className="text-[11px] text-gray-400 dark:text-gray-500">{park.city}{park.state && !park.city?.includes(park.state) ? `, ${park.state}` : ''} · {park.division}</div>
        </div>
        <div className="flex flex-col items-center shrink-0">
          <div className={`w-16 h-16 rounded-full ring-2 ${t.bg} ${t.ring} flex flex-col items-center justify-center`}>
            <span className={`text-xl font-bold leading-none ${t.cls}`}>{idx?.toFixed(0)}</span>
            <span className={`text-[10px] font-semibold ${t.cls}`}>{pct >= 0 ? '+' : ''}{pct?.toFixed(1)}</span>
          </div>
          <span className={`text-[10px] font-medium mt-0.5 ${t.cls}`}>{t.label}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-3 items-center">
        <FieldShape dims={dims} surface={park.surface} logo={park.logo_url} id={park.team_id} elevation={park.elevation_ft} temp={park.avg_temp_f} />
        <div className="space-y-1">
          <ContribBar label="Elevation" value={c.elev} />
          <ContribBar label="Dimensions" value={c.dim} />
          <ContribBar label="Temp" value={c.temp} />
          <ContribBar label="Home/road" value={c.hr} />
        </div>
      </div>

      <button onClick={() => setOpen((o) => !o)}
        className="mt-3 text-[11px] font-semibold text-nw-teal hover:underline">
        {open ? 'Hide details' : 'Details'}
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-2 mt-2 text-[11px]">
          {[
            ['Elevation', `${park.elevation_ft?.toLocaleString()} ft`],
            ['Avg OF depth', `${dims.avg_of} ft${dims.status === 'estimated' ? ' (est)' : ''}`],
            ['Avg game temp', `${park.avg_temp_f}°F`],
            ['Surface', park.surface || '—'],
            ['Home/road split', `${park.home_road_split_pct >= 0 ? '+' : ''}${park.home_road_split_pct}% (${park.home_road_games} g)`],
            ['Observed weight', `${Math.round(c.wObs * 100)}%`],
          ].map(([k, v]) => (
            <div key={k} className="bg-gray-50 dark:bg-gray-900/40 rounded p-2">
              <div className="text-gray-400 dark:text-gray-500">{k}</div>
              <div className="font-bold text-gray-700 dark:text-gray-200">{v}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SummaryBar({ teams }) {
  const s = useMemo(() => {
    if (!teams?.length) return null
    const sorted = [...teams].sort((a, b) => (b.park_index || 0) - (a.park_index || 0))
    const byElev = [...teams].sort((a, b) => (b.elevation_ft || 0) - (a.elevation_ft || 0))[0]
    const small = [...teams].sort((a, b) => (a.dimensions?.avg_of || 999) - (b.dimensions?.avg_of || 999))[0]
    const warm = [...teams].sort((a, b) => (b.avg_temp_f || 0) - (a.avg_temp_f || 0))[0]
    const magnus = teams.filter((t) => (t.elevation_ft || 0) >= 2500).length
    return { hitter: sorted[0], pitcher: sorted[sorted.length - 1], byElev, small, warm, magnus, total: teams.length }
  }, [teams])
  if (!s) return null
  const Cell = ({ label, name, sub, cls }) => (
    <div>
      <div className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-bold ${cls || 'text-pnw-slate dark:text-gray-100'}`}>{name}</div>
      <div className="text-[10px] text-gray-500 dark:text-gray-400">{sub}</div>
    </div>
  )
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 mb-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <Cell label="Most hitter" name={s.hitter?.short_name} sub={`index ${s.hitter?.park_index?.toFixed(0)}`} cls="text-red-600 dark:text-red-400" />
      <Cell label="Most pitcher" name={s.pitcher?.short_name} sub={`index ${s.pitcher?.park_index?.toFixed(0)}`} cls="text-blue-600 dark:text-blue-400" />
      <Cell label="Highest elevation" name={s.byElev?.short_name} sub={`${s.byElev?.elevation_ft?.toLocaleString()} ft`} cls="text-amber-600 dark:text-amber-400" />
      <Cell label="Magnus zones" name={`${s.magnus} parks`} sub="2,500+ ft elevation" cls="text-amber-600 dark:text-amber-400" />
      <Cell label="Smallest field" name={s.small?.short_name} sub={`${s.small?.dimensions?.avg_of} ft avg`} />
      <Cell label="Warmest park" name={s.warm?.short_name} sub={`${s.warm?.avg_temp_f}°F avg`} />
    </div>
  )
}

function ScoreDistributionStrip({ teams }) {
  const idxs = teams.map((t) => t.park_index).filter((v) => v != null)
  if (!idxs.length) return null
  const min = Math.floor(Math.min(...idxs)) - 1
  const max = Math.ceil(Math.max(...idxs)) + 1
  const z = {
    pitcher: idxs.filter((v) => v <= 97).length,
    neutral: idxs.filter((v) => v > 97 && v < 103).length,
    hitter: idxs.filter((v) => v >= 103).length,
  }
  const pos = (v) => `${((v - min) / (max - min)) * 100}%`
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 mb-4">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide mb-2">
        <span className="text-gray-400 dark:text-gray-500">Score distribution</span>
        <span><span className="text-blue-600 dark:text-blue-400 font-bold">{z.pitcher}P</span> · <span className="text-gray-400">{z.neutral}N</span> · <span className="text-red-600 dark:text-red-400 font-bold">{z.hitter}H</span></span>
      </div>
      <div className="relative h-6">
        <div className="absolute left-0 right-0 top-1/2 h-px bg-gray-200 dark:bg-gray-700" />
        <div className="absolute top-0 bottom-0 w-px bg-gray-300 dark:bg-gray-600" style={{ left: pos(100) }} />
        {teams.map((t) => t.park_index != null && (
          <div key={t.team_id} title={`${t.short_name} · ${t.park_index.toFixed(0)}`}
            className="absolute top-1 bottom-1 w-[2px] rounded-full"
            style={{ left: pos(t.park_index), background: scoreHex(t.park_index) }} />
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-gray-400 dark:text-gray-500 mt-1"><span>{min}</span><span>100 = avg</span><span>{max}</span></div>
    </div>
  )
}

function Rolodex({ teams }) {
  const BANDS = ['Strong hitter', 'Hitter', 'Neutral', 'Pitcher', 'Strong pitcher']
  const byBand = {}
  teams.forEach((t) => { const b = tilt(t.park_factor_pct).label; (byBand[b] = byBand[b] || []).push(t) })
  return (
    <div className="space-y-4">
      {BANDS.map((b) => {
        const list = (byBand[b] || []).sort((a, c) => c.park_index - a.park_index)
        if (!list.length) return null
        const cls = tilt(list[0].park_factor_pct).cls
        return (
          <div key={b}>
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`text-[11px] font-bold uppercase tracking-wide ${cls}`}>{b}</span>
              <span className="text-[10px] text-gray-400 dark:text-gray-500">{list.length} park{list.length > 1 ? 's' : ''}</span>
              <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {list.map((t) => {
                const tt = tilt(t.park_factor_pct)
                return (
                  <div key={t.team_id} className="shrink-0 w-28 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-2 text-center">
                    {t.logo_url && <img src={t.logo_url} alt="" className="w-7 h-7 object-contain mx-auto mb-1" onError={(e) => { e.target.style.visibility = 'hidden' }} />}
                    <div className="text-[11px] font-semibold text-pnw-slate dark:text-gray-100 truncate">{t.short_name}</div>
                    <div className={`text-lg font-bold leading-none ${tt.cls}`}>{t.park_index?.toFixed(0)}</div>
                    <div className="text-[9px] text-gray-400 dark:text-gray-500 mt-0.5">{t.division?.replace('NCAA ', '')}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const COLS = [
  { k: 'park_index', label: 'Index', fmt: (v) => v?.toFixed(1) },
  { k: 'park_factor_pct', label: '+/-', fmt: (v) => `${v >= 0 ? '+' : ''}${v?.toFixed(1)}` },
  { k: 'elevation_ft', label: 'Elev', fmt: (v) => v?.toLocaleString() },
  { k: 'avg_of', label: 'OF', fmt: (v) => v, get: (p) => p.dimensions?.avg_of },
  { k: 'avg_temp_f', label: 'Temp', fmt: (v) => `${v}°` },
  { k: 'home_road_split_pct', label: 'H/R', fmt: (v) => `${v >= 0 ? '+' : ''}${v}%` },
  { k: 'home_road_games', label: 'G', fmt: (v) => v },
]

function ParkTable({ teams }) {
  const [sort, setSort] = useState('park_index')
  const [dir, setDir] = useState(-1)
  const rows = useMemo(() => {
    const col = COLS.find((c) => c.k === sort)
    const val = (p) => (col?.get ? col.get(p) : p[sort]) ?? 0
    return [...teams].sort((a, b) => (val(a) - val(b)) * dir)
  }, [teams, sort, dir])
  const click = (k) => { if (k === sort) setDir((d) => -d); else { setSort(k); setDir(-1) } }
  return (
    <div className="overflow-x-auto bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
            <th className="px-3 py-2">Park</th>
            {COLS.map((c) => (
              <th key={c.k} className="px-3 py-2 text-right cursor-pointer hover:text-nw-teal whitespace-nowrap" onClick={() => click(c.k)}>
                {c.label}{sort === c.k ? (dir < 0 ? ' ↓' : ' ↑') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const t = tilt(p.park_factor_pct)
            return (
              <tr key={p.team_id} className="border-b border-gray-100 dark:border-gray-700/50">
                <td className="px-3 py-2">
                  <div className="font-semibold text-pnw-slate dark:text-gray-100">{p.short_name}</div>
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">{p.division}</div>
                </td>
                {COLS.map((c) => (
                  <td key={c.k} className={`px-3 py-2 text-right tabular-nums ${c.k === 'park_index' ? `font-bold ${t.cls}` : 'text-gray-700 dark:text-gray-300'}`}>
                    {c.k === 'avg_of' && p.dimensions?.status === 'estimated' ? '~' : ''}{c.fmt(c.get ? c.get(p) : p[c.k])}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FilterPill({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-sm font-semibold border transition-colors ${
        active
          ? 'bg-pnw-forest text-white border-pnw-forest'
          : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-nw-teal'
      }`}
    >
      {children}
    </button>
  )
}

export default function ParkFactors() {
  const { data, loading, error } = useParkFactors()
  const [section, setSection] = useState('leaderboard') // 'leaderboard' | 'tools'
  const [view, setView] = useState('cards')
  const [div, setDiv] = useState('all')

  const teams = data?.teams || []
  const divisions = useMemo(() => DIV_ORDER.filter((d) => teams.some((t) => t.division === d)), [teams])
  const filtered = useMemo(() => (div === 'all' ? teams : teams.filter((t) => t.division === div)), [teams, div])

  return (
    <div className="max-w-6xl mx-auto px-3 py-4">
      <h1 className="text-2xl sm:text-3xl font-bold text-pnw-slate dark:text-gray-100 mb-1">Park Factors</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 max-w-3xl">
        How much each PNW park inflates or suppresses run scoring. <strong>Park Index 100 = the average
        PNW park</strong>; above 100 favors hitters, below favors pitchers. Each park blends its measured
        conditions (elevation, outfield depth, temperature) with six seasons of home/road run data,
        weighted by sample size.
      </p>

      <div className="flex gap-1 mb-4 border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
        {[['leaderboard', 'Leaderboard'], ['builder', 'Builder & Labs'], ['map', 'Map'], ['travel', 'Travel Scout']].map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setSection(k)}
            className={`px-4 py-2 text-sm font-semibold -mb-px border-b-2 whitespace-nowrap transition-colors ${
              section === k
                ? 'border-nw-teal text-nw-teal'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-pnw-slate dark:hover:text-gray-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && <div className="text-gray-400 dark:text-gray-500 animate-pulse py-12 text-center">Loading park factors…</div>}
      {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300">Failed to load park factors.</div>}

      {section === 'builder' && !loading && !error && <BuilderSuite teams={teams} />}
      {section === 'map' && !loading && !error && <ParkMap teams={teams} />}
      {section === 'travel' && !loading && !error && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500 dark:text-gray-400">How the environment shifts when a team leaves home for a conference road park — index swing, carry & break, surface, and altitude.</p>
          <TravelScout teams={teams} />
        </div>
      )}

      {section === 'leaderboard' && !loading && !error && (
        <>
          <SummaryBar teams={teams} />
          <ScoreDistributionStrip teams={teams} />

          <div className="flex flex-wrap items-center gap-2 mb-4 mt-4">
            <div className="flex flex-wrap gap-1">
              <FilterPill active={div === 'all'} onClick={() => setDiv('all')}>All</FilterPill>
              {divisions.map((d) => (
                <FilterPill key={d} active={div === d} onClick={() => setDiv(d)}>{d.replace('NCAA ', '')}</FilterPill>
              ))}
            </div>
            <div className="ml-auto flex gap-1">
              <FilterPill active={view === 'cards'} onClick={() => setView('cards')}>Cards</FilterPill>
              <FilterPill active={view === 'rolodex'} onClick={() => setView('rolodex')}>Rolodex</FilterPill>
              <FilterPill active={view === 'table'} onClick={() => setView('table')}>Table</FilterPill>
            </div>
          </div>

          {view === 'cards' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered.map((p) => <ParkCard key={p.team_id} park={p} />)}
            </div>
          )}
          {view === 'rolodex' && <Rolodex teams={filtered} />}
          {view === 'table' && <ParkTable teams={filtered} />}

          <div className="mt-6 text-xs text-gray-500 dark:text-gray-400 max-w-3xl leading-relaxed">
            <h2 className="text-sm font-bold text-pnw-slate dark:text-gray-200 mb-1">How it works</h2>
            <p>{data?.methodology}</p>
            <p className="mt-2 text-gray-400 dark:text-gray-500">
              Updated {data?.last_updated}. Park Factors model built by Kai Malloch (intern).
            </p>
          </div>
        </>
      )}
    </div>
  )
}
