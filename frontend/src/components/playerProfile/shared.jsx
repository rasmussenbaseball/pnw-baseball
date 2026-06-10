// Shared primitives for the redesigned player profile (hitter + pitcher).
//
// Extracted from the Jason Wright prototype so the hitter and pitcher
// pages share one look. Everything here is side-agnostic — pages supply
// their own metric configs and per-game value functions.
//
// Theme: the prototype's cream/maroon/gold palette in LIGHT, plus a
// matching DARK palette. `usePlayerProfileTheme()` reads the resolved
// mode from ThemeContext and returns the active palette `T`. All themed
// colors are driven by `T` via inline styles so dark mode is real (not a
// patchwork of Tailwind dark: overrides).

import { useState, useEffect } from 'react'
import { useTheme } from '../../context/ThemeContext'
import { CURRENT_SEASON } from '../../lib/seasons'

// ── Palettes ───────────────────────────────────────────────────
export const THEME_LIGHT = {
  bg: '#faf7f1',
  card: '#ffffff',
  border: '#e5dfd2',
  borderStrong: '#c8bfa8',
  text: '#1a1a1a',
  textMuted: '#6b6b6b',
  textLight: '#9a9a9a',
  track: '#efeadc',       // percentile bar track
  highlight: '#faf6ec',   // current-season row
  rowAlt: '#f7f3ea',      // summer row
  rowBorder: '#f0ebdc',
  great: '#d22d49',
  poor: '#5d99c6',
  accent: '#14365c',
  gold: '#c9a44c',
  hot: '#ff6b35',
}

export const THEME_DARK = {
  bg: '#0b1220',
  card: '#1f2937',        // gray-800
  border: '#374151',      // gray-700
  borderStrong: '#4b5563',// gray-600
  text: '#f3f4f6',        // gray-100
  textMuted: '#9ca3af',   // gray-400
  textLight: '#6b7280',   // gray-500
  track: '#374151',
  highlight: '#3a2f17',   // muted amber on dark
  rowAlt: '#172033',
  rowBorder: '#2a3344',
  great: '#f0556e',       // slightly brighter red for dark
  poor: '#6aa9d6',
  accent: '#1f5485',
  gold: '#d8b65f',
  hot: '#ff8a5c',
}

export function usePlayerProfileTheme() {
  const { resolvedTheme } = useTheme()
  return resolvedTheme === 'dark' ? THEME_DARK : THEME_LIGHT
}

// ── Color + format helpers (theme-independent) ─────────────────
// Performance color scale (blue → cream → red), like a savant card.
export function pctColor(p) {
  const stops = [
    { p: 0,   c: [93, 153, 198] },
    { p: 30,  c: [149, 184, 209] },
    { p: 48,  c: [212, 201, 179] },
    { p: 52,  c: [212, 201, 179] },
    { p: 70,  c: [229, 115, 115] },
    { p: 100, c: [210, 45, 73] },
  ]
  let lo = stops[0], hi = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (p >= stops[i].p && p <= stops[i + 1].p) { lo = stops[i]; hi = stops[i + 1]; break }
  }
  const t = (p - lo.p) / ((hi.p - lo.p) || 1)
  const c = lo.c.map((v, i) => Math.round(v + (hi.c[i] - v) * t))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

export function formatPct(kind, val) {
  if (val == null) return '—'
  switch (kind) {
    case 'war':  return Number(val).toFixed(2)
    case 'int':  return Math.round(val).toString()
    case 'avg':  return Number(val).toFixed(3).replace(/^0/, '')
    case 'era':  return Number(val).toFixed(2)
    case 'pct':  return `${(val * 100).toFixed(1)}%`
    case 'wpa':  return val >= 0 ? `+${Number(val).toFixed(2)}` : Number(val).toFixed(2)
    default:     return String(val)
  }
}

// Generic stat-cell formatter for the season + game-log tables.
export function fmtCell(kind, v) {
  if (v == null || v === '') return '—'
  switch (kind) {
    case 'raw':    return v
    case 'int':    return Math.round(v)
    case 'avg':    return Number(v).toFixed(3).replace(/^0/, '')
    case 'era':    return Number(v).toFixed(2)
    case 'pct':    return `${(Number(v) * 100).toFixed(1)}%`
    case 'pctRaw': return `${(Number(v) * 100).toFixed(1)}%`
    case 'war':    return Number(v).toFixed(2)
    case 'ip':     return Number(v).toFixed(1)
    case 'inn':    return Number(v).toFixed(1)
    default:       return v
  }
}

// Convert baseball-notation IP (6.2 = 6 and 2/3) to true innings.
export function ipToTrue(ip) {
  if (ip == null) return 0
  const whole = Math.floor(ip)
  const frac = Math.round((ip - whole) * 10) // .0 .1 .2
  return whole + (frac >= 1 ? frac / 3 : 0)
}

// ── Outer shell (themed background) ────────────────────────────
export function ProfileShell({ children }) {
  const T = usePlayerProfileTheme()
  return (
    <div className="rounded-md" style={{ background: T.bg }}>
      <div className="p-1 rounded-md">{children}</div>
    </div>
  )
}

// ── Section card chrome ────────────────────────────────────────
export function SectionCard({ title, right, children, className = '' }) {
  const T = usePlayerProfileTheme()
  return (
    <div className={`rounded-md p-5 mb-4 ${className}`} style={{ background: T.card, border: `1px solid ${T.border}` }}>
      {title && (
        <h2 className="font-bold text-[15px] mb-3 pb-1.5 border-b-2 flex items-center gap-2"
          style={{ color: T.text, borderColor: T.text }}>
          <span>{title}</span>
          {right && <span className="ml-auto text-[11px] font-semibold tracking-widest" style={{ color: T.textLight }}>{right}</span>}
        </h2>
      )}
      {children}
    </div>
  )
}

// ── Radar chart ────────────────────────────────────────────────
export function RadarChart({ stats }) {
  const T = usePlayerProfileTheme()
  const cx = 160, cy = 130, r = 80
  const n = stats.length
  const angles = stats.map((_, i) => (Math.PI * 2 * i / n) - Math.PI / 2)

  const grid = [25, 50, 75, 100].map(level => {
    const rr = r * level / 100
    const points = angles.map(a => `${cx + rr * Math.cos(a)},${cy + rr * Math.sin(a)}`).join(' ')
    return <polygon key={level} points={points} fill="none" stroke={T.border} strokeWidth="0.6" opacity={level === 100 ? 1 : 0.5} />
  })
  const axes = angles.map((a, i) => (
    <line key={i} x1={cx} y1={cy} x2={cx + r * Math.cos(a)} y2={cy + r * Math.sin(a)} stroke={T.border} strokeWidth="0.6" />
  ))
  const dataPoints = stats.map((s, i) => {
    const rr = r * (s.pct || 0) / 100
    return `${cx + rr * Math.cos(angles[i])},${cy + rr * Math.sin(angles[i])}`
  }).join(' ')
  const dots = stats.map((s, i) => {
    const rr = r * (s.pct || 0) / 100
    return (
      <circle key={i} cx={cx + rr * Math.cos(angles[i])} cy={cy + rr * Math.sin(angles[i])}
        r="3" fill={pctColor(s.pct || 0)} stroke={T.card} strokeWidth="1" />
    )
  })
  const labels = stats.map((s, i) => {
    const a = angles[i]
    const lx = cx + (r + 18) * Math.cos(a)
    const ly = cy + (r + 18) * Math.sin(a)
    let anchor = 'middle'
    if (Math.cos(a) > 0.3) anchor = 'start'
    else if (Math.cos(a) < -0.3) anchor = 'end'
    const dy = Math.sin(a) > 0.3 ? 8 : (Math.sin(a) < -0.3 ? -2 : 0)
    return (
      <g key={i}>
        <text x={lx} y={ly + dy} textAnchor={anchor} fontSize="9.5" fontWeight="700" fill={T.text}>{s.label}</text>
        <text x={lx} y={ly + dy + 10} textAnchor={anchor} fontSize="9" fill={T.textMuted} fontWeight="600">{s.pct ?? 0}th</text>
      </g>
    )
  })
  return (
    <svg viewBox="0 0 320 250" preserveAspectRatio="xMidYMid meet" className="w-full h-auto">
      {grid}{axes}
      <polygon points={dataPoints} fill="rgba(210,45,73,0.22)" stroke={T.great} strokeWidth="1.6" strokeLinejoin="round" />
      {dots}{labels}
    </svg>
  )
}

// ── Percentile panel (header + POOR/AVG/GREAT legend + rows) ────
export function PctRow({ stat, pct, raw, tip }) {
  const T = usePlayerProfileTheme()
  const [open, setOpen] = useState(false)
  const color = pctColor(pct || 0)
  const t = tip || { what: '', why: '', range: '' }
  return (
    <div className="grid items-center gap-2.5 py-1" style={{ gridTemplateColumns: '116px 1fr 58px' }}>
      <div className="flex items-center justify-end gap-1 text-[11.5px] font-medium whitespace-nowrap" style={{ color: T.textMuted }}>
        <span>{stat}</span>
        <button
          onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
          className="w-[13px] h-[13px] rounded-full bg-gray-400 text-white text-[9px] font-bold inline-flex items-center justify-center relative"
          title={stat}>
          i
          {open && (
            <span className="absolute bottom-[calc(100%+8px)] -right-2 z-50 w-60 p-3 rounded-md text-left text-[11.5px] font-normal text-white leading-snug" style={{ background: '#1a1a1a' }}>
              <strong className="block text-[12.5px] mb-1" style={{ color: T.gold }}>{stat}</strong>
              <span className="block">{t.what}</span>
              <span className="block mt-1.5 text-[10px] uppercase tracking-wider" style={{ color: '#a3a3a3' }}>Why it matters</span>
              <span className="block">{t.why}</span>
              <span className="block mt-1.5 text-[10px] uppercase tracking-wider" style={{ color: '#a3a3a3' }}>Range</span>
              <span className="block">{t.range}</span>
            </span>
          )}
        </button>
      </div>
      <div className="relative h-3 rounded-full" style={{ background: T.track }}>
        <div className="h-full rounded-full relative" style={{ width: `${pct || 0}%`, background: color, minWidth: '18px' }}>
          <div className="absolute right-[-4px] top-1/2 -translate-y-1/2 w-[22px] h-[22px] rounded-full text-white text-[10.5px] font-bold flex items-center justify-center z-10 leading-none"
            style={{ background: color }}>
            {pct ?? 0}
          </div>
        </div>
      </div>
      <div className="text-right text-[12.5px] font-bold tabular-nums" style={{ color: T.text }}>{raw}</div>
    </div>
  )
}

export function PercentilePanel({ title, scopeLabel, metrics, percentiles, tooltips }) {
  const T = usePlayerProfileTheme()
  return (
    <div className="p-5 border-l flex flex-col" style={{ borderColor: T.border }}>
      <div className="flex items-baseline gap-2 pb-2 mb-3 border-b-2" style={{ borderColor: T.text }}>
        <h3 className="text-base font-bold tracking-tight" style={{ color: T.text }}>Percentile Rankings</h3>
        {scopeLabel && <span className="ml-auto text-[11px] tracking-widest font-semibold" style={{ color: T.textLight }}>{scopeLabel}</span>}
      </div>
      <div className="grid items-end gap-2.5 text-[9px] font-bold uppercase tracking-widest mb-1.5" style={{ gridTemplateColumns: '116px 1fr 58px' }}>
        <span />
        <div className="flex justify-between">
          <span style={{ color: T.poor }}>▲ POOR</span>
          <span style={{ color: T.textLight }}>▲ AVG</span>
          <span style={{ color: T.great }}>▲ GREAT</span>
        </div>
        <span />
      </div>
      <div className="flex-1 flex flex-col justify-between gap-1">
        {metrics.map(m => {
          const v = percentiles?.[m.key]
          const pct = v?.percentile
          const raw = v?.value != null ? formatPct(m.fmt, v.value) : '—'
          return <PctRow key={m.key} stat={m.label} pct={pct} raw={raw} tip={tooltips?.[m.label]} />
        })}
      </div>
    </div>
  )
}

// Nice axis range + ticks for an arbitrary value spread (so low-wOBA or
// high-ERA lines are never clipped — the axis adapts to the data).
function niceNum(x, round) {
  const exp = Math.floor(Math.log10(x || 1))
  const f = (x || 1) / Math.pow(10, exp)
  let nf
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10
  return nf * Math.pow(10, exp)
}
function niceRange(lo, hi, tickCount = 4, floorZero = false) {
  if (!(hi > lo)) { hi = lo + 1 }
  const range = niceNum(hi - lo, false)
  const step = niceNum(range / tickCount, true)
  let niceLo = Math.floor(lo / step) * step
  let niceHi = Math.ceil(hi / step) * step
  if (floorZero) niceLo = Math.max(0, niceLo)
  const ticks = []
  for (let v = niceLo; v <= niceHi + step * 1e-6; v += step) ticks.push(+v.toFixed(6))
  return { min: niceLo, max: niceHi, ticks }
}

// ── Rolling line chart (generic, auto-ranging y-axis) ──────────
// series: number[]; refLines: [{ v, label, color }]; fmtTick: (v)=>string.
// The y-axis is derived from the data + reference lines so every player's
// line is visible (no fixed floor that clips below-average seasons).
export function RollingLineChart({ series, fmtTick, refLines = [], lineColor, floorZero = false }) {
  const T = usePlayerProfileTheme()
  const line = lineColor || T.great
  if (!series || series.length < 2) {
    return <div className="text-xs" style={{ color: T.textMuted }}>Not enough games yet</div>
  }
  // Derive bounds from the series + any reference lines, with a little pad.
  const vals = [...series, ...refLines.map(r => r.v)].filter(v => v != null && isFinite(v))
  let lo = Math.min(...vals), hi = Math.max(...vals)
  const pad = ((hi - lo) || 1) * 0.12
  const { min: yMin, max: yMax, ticks: yTicks } = niceRange(lo - pad, hi + pad, 4, floorZero)
  const w = 340, h = 195
  const pl = 34, pr = 64, pt = 12, pb = 22
  const cw = w - pl - pr
  const ch = h - pt - pb
  const clamp = v => Math.max(yMin, Math.min(yMax, v))
  const xs = series.map((_, i) => pl + (cw * i / (series.length - 1)))
  const yPos = v => pt + ch * (1 - (clamp(v) - yMin) / (yMax - yMin))
  const ys = series.map(v => yPos(v))
  const path = series.map((_, i) => `${i === 0 ? 'M' : 'L'} ${xs[i].toFixed(1)} ${ys[i].toFixed(1)}`).join(' ')
  const areaPath = path + ` L ${xs[xs.length - 1].toFixed(1)} ${(pt + ch).toFixed(1)} L ${xs[0].toFixed(1)} ${(pt + ch).toFixed(1)} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" className="w-full h-auto">
      {yTicks.map(t => (
        <g key={t}>
          <line x1={pl} y1={yPos(t)} x2={pl + cw} y2={yPos(t)} stroke={T.border} strokeWidth="0.5" strokeDasharray="2,3" />
          <text x={pl - 4} y={yPos(t) + 3} textAnchor="end" fontSize="8.5" fill={T.textLight} fontWeight="600">{fmtTick(t)}</text>
        </g>
      ))}
      {refLines.map((rl, i) => (
        <g key={i}>
          <line x1={pl} y1={yPos(rl.v)} x2={pl + cw} y2={yPos(rl.v)} stroke={rl.color} strokeWidth="1" strokeDasharray="3,2" opacity="0.85" />
          <text x={pl + cw + 6} y={yPos(rl.v) + 3} fontSize="8.5" fill={rl.color} fontWeight="700">{rl.label}</text>
        </g>
      ))}
      <path d={areaPath} fill="rgba(210,45,73,0.10)" />
      <path d={path} fill="none" stroke={line} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={xs[xs.length - 1].toFixed(1)} cy={ys[ys.length - 1].toFixed(1)} r="3.8" fill={line} stroke={T.card} strokeWidth="1.5" />
      <text x={pl} y={h - 6} fontSize="9" fill={T.textLight} fontWeight="700">G1</text>
      <text x={(pl + cw / 2).toFixed(1)} y={h - 6} textAnchor="middle" fontSize="9" fill={T.textLight} fontWeight="700">G{Math.round(series.length / 2)}</text>
      <text x={pl + cw} y={h - 6} textAnchor="end" fontSize="9" fill={T.textLight} fontWeight="700">G{series.length}</text>
    </svg>
  )
}

// ── Per-game bar chart (generic) ───────────────────────────────
// rows: [{ g, val }]; colorFn(val); maxVal; yTicks:[v]; fmtY(v);
// refLines:[{v,label,color}]; tooltipFn(g,val); legend:[{color,label}]
export function PerGameBarChart({ rows, maxVal, yTicks, fmtY, refLines = [], colorFn, tooltipFn, legend = [], note }) {
  const T = usePlayerProfileTheme()
  if (!rows || !rows.length) return <div className="text-xs" style={{ color: T.textMuted }}>No games yet</div>
  const fmtDate = d => { if (!d) return ''; const dt = new Date(d); return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}` }
  const barCount = rows.length
  const w = 800, h = 160
  const padL = 36, padR = 8, padT = 10, padB = 28
  const cw = w - padL - padR
  const ch = h - padT - padB
  const barGap = 2
  const barW = Math.max(2, (cw - (barCount - 1) * barGap) / barCount)
  const yPos = v => padT + ch * (1 - Math.min(v, maxVal) / maxVal)
  const tickInterval = Math.max(1, Math.ceil(barCount / 7))
  return (
    <div>
      <div className="w-full overflow-x-auto">
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" className="w-full" style={{ minWidth: '460px' }}>
          {yTicks.map(v => (
            <g key={v}>
              <line x1={padL} y1={yPos(v)} x2={padL + cw} y2={yPos(v)} stroke={T.border} strokeWidth="0.6" strokeDasharray="2,3" />
              <text x={padL - 5} y={yPos(v) + 3} textAnchor="end" fontSize="9" fill={T.textLight} fontWeight="600">{fmtY(v)}</text>
            </g>
          ))}
          {refLines.map((rl, i) => (
            <g key={i}>
              <line x1={padL} y1={yPos(rl.v)} x2={padL + cw} y2={yPos(rl.v)} stroke={rl.color} strokeWidth="1" strokeDasharray="3,2" opacity="0.7" />
              <text x={padL + cw - 4} y={yPos(rl.v) - 3} textAnchor="end" fontSize="8.5" fill={rl.color} fontWeight="700">{rl.label}</text>
            </g>
          ))}
          {rows.map((r, i) => {
            const x = padL + i * (barW + barGap)
            const has = r.val != null
            const y = has ? yPos(r.val) : padT + ch
            const hBar = has ? (padT + ch) - y : 0
            return (
              <rect key={i} x={x} y={y} width={barW} height={hBar || 1} fill={colorFn(r.val)} rx="1">
                <title>{tooltipFn(r.g, r.val)}</title>
              </rect>
            )
          })}
          {rows.map((r, i) => {
            if (i % tickInterval !== 0 && i !== rows.length - 1) return null
            const x = padL + i * (barW + barGap) + barW / 2
            return <text key={i} x={x} y={h - 8} textAnchor="middle" fontSize="9" fill={T.textLight} fontWeight="600">{fmtDate(r.g.game_date)}</text>
          })}
        </svg>
      </div>
      {(legend.length > 0 || note) && (
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[10.5px] font-semibold mt-3" style={{ color: T.textMuted }}>
          {legend.map((l, i) => (
            <span key={i} className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-sm" style={{ background: l.color }} /> {l.label}</span>
          ))}
          {note && <span className="text-[10px] font-normal" style={{ color: T.textLight }}>{note}</span>}
        </div>
      )}
    </div>
  )
}

// ── Season stat table (generic) ────────────────────────────────
// cols: [{ key, label, fmt, align }]; rows tagged with _kind/_typeLabel/_team.
// blankCols: Set of keys to show "—" for summer rows. Highlights the last
// spring row as the current season.
export function SeasonStatTable({ cols, rows, blankCols, emptyMsg = 'No stats.', minWidth = '820px' }) {
  const T = usePlayerProfileTheme()
  if (!rows || !rows.length) return <div className="text-xs" style={{ color: T.textMuted }}>{emptyMsg}</div>
  let lastSpringIdx = -1
  rows.forEach((r, i) => { if (r._kind === 'spring') lastSpringIdx = i })
  return (
    <div className="overflow-x-auto -mx-3 sm:mx-0">
      <div className="px-3 sm:px-0" style={{ minWidth }}>
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr style={{ borderBottom: `1px solid ${T.border}` }}>
              {cols.map(c => (
                <th key={c.key} className={`px-1.5 py-1.5 font-bold tracking-wide ${c.align === 'left' ? 'text-left' : 'text-right'}`} style={{ color: T.textLight }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isCurrent = i === lastSpringIdx
              const isSummer = r._kind === 'summer'
              const rowStyle = isCurrent
                ? { background: T.highlight, borderTop: `1px solid ${T.borderStrong}` }
                : (isSummer ? { background: T.rowAlt, borderBottom: `1px solid ${T.rowBorder}` } : { borderBottom: `1px solid ${T.rowBorder}` })
              return (
                <tr key={`${r.season}-${r._kind}-${r._team}-${i}`} className={`${isCurrent ? 'font-bold' : ''} ${isSummer ? 'italic' : ''}`} style={rowStyle}>
                  {cols.map(c => {
                    const blank = isSummer && blankCols && blankCols.has(c.key)
                    return (
                      <td key={c.key} className={`px-1.5 py-1.5 tabular-nums ${c.align === 'left' ? 'text-left' : 'text-right'}`} style={{ color: isSummer ? T.textMuted : T.text }}>
                        {blank ? '—' : fmtCell(c.fmt, r[c.key])}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Game log table (generic) ───────────────────────────────────
// cols: [{ key, label, fmt, align }]; games: rows. First col conventionally
// Date, second Opp (rendered with home/away prefix).
export function GameLogTable({ cols, games, minWidth = '720px', emptyMsg = 'No games yet.' }) {
  const T = usePlayerProfileTheme()
  if (!games || !games.length) return <div className="text-xs" style={{ color: T.textMuted }}>{emptyMsg}</div>
  const fmtDate = d => { if (!d) return ''; const dt = new Date(d); return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}` }
  return (
    <div className="overflow-x-auto -mx-3 sm:mx-0">
      <div className="px-3 sm:px-0" style={{ minWidth }}>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b" style={{ borderColor: T.border }}>
              {cols.map(c => (
                <th key={c.key} className={`px-2 py-1.5 font-semibold ${c.align === 'left' ? 'text-left' : 'text-right'}`} style={{ color: T.textMuted }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {games.map((g, i) => (
              <tr key={i} className="border-b" style={{ borderColor: T.rowBorder }}>
                {cols.map(c => {
                  if (c.key === '_date') return <td key={c.key} className="px-2 py-1.5 text-left" style={{ color: T.textMuted }}>{fmtDate(g.game_date)}</td>
                  if (c.key === '_opp') return (
                    <td key={c.key} className="px-2 py-1.5 text-left font-semibold" style={{ color: T.text }}>
                      {g.home_away === '@' ? '@ ' : 'vs '}{g.opponent_short?.split(' ').slice(0, 2).join(' ') || '?'}
                    </td>
                  )
                  return <td key={c.key} className={`px-2 py-1.5 tabular-nums ${c.align === 'left' ? 'text-left' : 'text-right'}`} style={{ color: T.text }}>{c.fmt ? fmtCell(c.fmt, g[c.key]) : (g[c.key] ?? 0)}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Career path timeline (data-driven; no fabricated year ranges) ──
export function CareerPath({ player, divisionBadge, seasonRange }) {
  const T = usePlayerProfileTheme()
  const nodes = []
  if (player.high_school || player.hometown) {
    nodes.push({ type: 'hs', school: player.high_school || 'High School', loc: player.hometown || '', tag: 'High School', badge: 'HS' })
  }
  if (player.previous_school) {
    nodes.push({ type: 'prev', school: player.previous_school, loc: '', tag: 'Previous', badge: 'PREV' })
  }
  nodes.push({ type: 'current', school: player.team_name, loc: '', tag: 'CURRENT', badge: divisionBadge || 'NOW', years: seasonRange })
  return (
    <div className="flex items-stretch pt-2 pb-1">
      {nodes.map((n, i) => (
        <div key={i} className="flex-1 flex flex-col items-center text-center relative px-2">
          {i < nodes.length - 1 && (
            <span className="absolute top-[14px] left-1/2 right-[-50%] h-[2px]" style={{ background: T.borderStrong }} />
          )}
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[10px] font-bold relative z-10 mb-2.5 leading-none"
            style={{
              background: n.type === 'current' ? T.gold : (n.type === 'prev' ? T.accent : T.borderStrong),
              boxShadow: n.type === 'current' ? `0 0 0 1px ${T.gold}, 0 0 0 4px rgba(201,164,76,0.2)` : `0 0 0 1px ${T.borderStrong}`,
            }}>
            {n.badge}
          </div>
          <div className="font-bold text-[13px]" style={{ color: T.text }}>{n.school || '—'}</div>
          {n.loc && <div className="text-[11px] mt-0.5" style={{ color: T.textMuted }}>{n.loc}</div>}
          {n.years && <div className="text-[10px] uppercase tracking-wider mt-1.5 font-bold" style={{ color: T.textLight }}>{n.years}</div>}
          <span className="inline-block mt-1.5 px-2 py-[2px] rounded-full text-[9px] font-bold tracking-wider"
            style={n.type === 'current' ? { background: T.gold, color: '#1a1a1a' } : { background: T.border, color: T.textMuted }}>
            {n.tag}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Streaks card (batting; hitter pages only) ──────────────────
export function StreaksCard({ playerId, season = CURRENT_SEASON }) {
  const T = usePlayerProfileTheme()
  const [data, setData] = useState(null)
  useEffect(() => {
    let alive = true
    fetch(`/api/v1/players/${playerId}/streaks?season=${season}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (alive) setData(d) })
      .catch(() => { if (alive) setData(null) })
    return () => { alive = false }
  }, [playerId, season])

  if (!data) return null
  const total = (data.current_hit_streak || 0) + (data.current_ob_streak || 0) + (data.best_hit_streak || 0) + (data.best_ob_streak || 0)
  if (!total) return null
  const tile = (label, val, accentColor) => (
    <div className="text-center px-2 py-3 rounded-lg" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
      <div className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider" style={{ color: T.textMuted }}>{label}</div>
      <div className="text-2xl sm:text-3xl font-extrabold mt-1" style={{ color: accentColor || T.text }}>{val ?? 0}</div>
      <div className="text-[10px] mt-0.5" style={{ color: T.textLight }}>{(val ?? 0) === 1 ? 'game' : 'games'}</div>
    </div>
  )
  return (
    <div className="rounded-md p-5 mb-4" style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <h2 className="font-bold text-[15px] mb-3 pb-1.5 border-b-2 flex items-center gap-2" style={{ color: T.text, borderColor: T.text }}>
        <span>{season} Streaks</span>
        <span className="ml-auto text-[11px] font-semibold tracking-widest" style={{ color: T.textLight }}>CURRENT</span>
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tile('Current Hit', data.current_hit_streak, '#10b981')}
        {tile('Current On-Base', data.current_ob_streak, '#14b8a6')}
        {tile('Longest Hit', data.best_hit_streak)}
        {tile('Longest On-Base', data.best_ob_streak)}
      </div>
    </div>
  )
}

// ── Hero side toggle (two-way players) ─────────────────────────
export function SideToggle({ side, onChange }) {
  const T = usePlayerProfileTheme()
  const btn = (val, label) => (
    <button
      onClick={() => onChange(val)}
      className="px-3 py-1 rounded-md text-[11px] font-bold tracking-wide transition-colors"
      style={side === val
        ? { background: T.accent, color: '#fff' }
        : { background: T.track, color: T.textMuted }}>
      {label}
    </button>
  )
  return (
    <div className="inline-flex gap-1 p-1 rounded-lg mb-3" style={{ background: T.card, border: `1px solid ${T.border}` }}>
      {btn('batting', 'Hitting')}
      {btn('pitching', 'Pitching')}
    </div>
  )
}

// ── Shared division-badge helper ───────────────────────────────
export function divisionBadge(level) {
  if (!level) return 'NOW'
  const s = String(level).toUpperCase()
  if (s.includes('JUCO') || s.includes('NWAC')) return 'JC'
  if (s.includes('NAIA')) return 'NAIA'
  if (s === 'D1' || s.includes('DI')) return 'D1'
  if (s === 'D2' || s.includes('DII')) return 'D2'
  if (s === 'D3' || s.includes('DIII')) return 'D3'
  return s.slice(0, 4)
}
