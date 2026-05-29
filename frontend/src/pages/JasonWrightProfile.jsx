// JasonWrightProfile — prototype layout per intern proposal (5/28/26).
// Gated to player_id=3078 only via PlayerDetail.jsx early-return.
// New UI: hero w/ radar + rolling wOBA + percentile rankings + stat
// table + badges (top), wRC+ heatmap + career path + similar players
// (bottom). Middle sections (pitch level stats, splits, WPA, game log)
// reuse the existing site components so the page stays usable.
//
// Color palette is the intern's cream/maroon/gold theme; dark variants
// fall back to standard site colors.

import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { usePlayer, usePlayerGameLogs, usePlayerSplits } from '../hooks/useApi'
import PitchLevelStatsCard from '../components/PitchLevelStatsCard'
import WpaByGameChart from '../components/WpaByGameChart'

const PLAYER_ID = 3078

// Theme palette mirrors the prototype:
//   bg: #faf7f1   card: #fff   border: #e5dfd2   accent: #14365c
//   great: #d22d49 (red)   gold: #c9a44c   poor: #5d99c6 (blue)
const THEME = {
  bg: '#faf7f1',
  card: '#ffffff',
  border: '#e5dfd2',
  borderStrong: '#c8bfa8',
  text: '#1a1a1a',
  textMuted: '#6b6b6b',
  textLight: '#9a9a9a',
  great: '#d22d49',
  poor: '#5d99c6',
  accent: '#14365c',
  gold: '#c9a44c',
  hot: '#ff6b35',
}

// Percentile metric ordering for the right panel (prototype lists 16,
// we render what the API actually returns).
const PCT_METRICS = [
  { key: 'offensive_war', label: 'WAR',      fmt: 'war' },
  { key: 'wrc_plus',      label: 'wRC+',     fmt: 'int' },
  { key: 'woba',          label: 'wOBA',     fmt: 'avg' },
  { key: 'iso',           label: 'ISO',      fmt: 'avg' },
  { key: 'hr_pa_pct',     label: 'HR/PA',    fmt: 'pct' },
  { key: 'k_pct',         label: 'K%',       fmt: 'pct' },
  { key: 'bb_pct',        label: 'BB%',      fmt: 'pct' },
  { key: 'contact_pct',   label: 'Contact%', fmt: 'pct' },
  { key: 'air_pull_pct',  label: 'AIRPULL%', fmt: 'pct' },
  { key: 'sb_per_pa',     label: 'SB/PA',    fmt: 'pct' },
  { key: 'wpa',           label: 'WPA',      fmt: 'wpa' },
]

const RADAR_KEYS = [
  { key: 'wrc_plus',     label: 'wRC+' },
  { key: 'iso',          label: 'ISO' },
  { key: 'contact_pct',  label: 'Contact%' },
  { key: 'bb_pct',       label: 'BB%' },
  { key: 'k_pct',        label: 'K%' },
  { key: 'wpa',          label: 'WPA' },
]

const TOOLTIPS = {
  WAR:        { what: 'Wins Above Replacement.', why: 'Single best one-number summary.',         range: 'Poor <0.5 | Avg ~1.5 | Great 3.0+' },
  'wRC+':     { what: 'Weighted Runs Created Plus, 100 = league avg.', why: 'Park + league adjusted.', range: 'Poor <85 | Avg ~100 | Great 130+' },
  wOBA:       { what: 'Weighted On-Base Average.',  why: 'Better single offensive number than OBP/SLG.', range: 'Poor <.310 | Avg ~.330 | Great .400+' },
  ISO:        { what: 'Isolated Power. SLG − AVG.', why: 'Pure extra-base power.',                       range: 'Poor <.130 | Avg ~.160 | Great .220+' },
  'HR/PA':    { what: 'Home runs per plate appearance.', why: 'Cleanest power-frequency metric.',         range: 'Poor <1% | Avg ~2.5% | Great 4%+' },
  'K%':       { what: 'Strikeout rate.',           why: 'Lower is better contact.',                     range: 'Poor >25% | Avg ~20% | Great <15%' },
  'BB%':      { what: 'Walk rate.',                 why: 'Plate discipline / pitch selection.',          range: 'Poor <6% | Avg ~8% | Great 12%+' },
  'Contact%': { what: '% of swings that make contact.', why: 'Pure bat-to-ball skill.',                  range: 'Poor <72% | Avg ~78% | Great 85%+' },
  'AIRPULL%': { what: '% of air-ball contact pulled.', why: 'Proxy for hard intentional contact.',       range: 'Poor <12% | Avg ~16% | Great 22%+' },
  'SB/PA':    { what: 'Stolen-base attempts per PA.', why: 'Speed + baserunning aggression.',            range: 'Poor 0% | Avg ~3% | Great 8%+' },
  WPA:        { what: 'Win Probability Added.',    why: 'Context-dependent clutch value.',              range: 'Poor <0 | Avg ~0 | Great +1.5+' },
}

// ── Color helpers ──────────────────────────────────────────────
function pctColor(p) {
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

function formatPct(key, val) {
  if (val == null) return '—'
  switch (key) {
    case 'war':  return Number(val).toFixed(2)
    case 'int':  return Math.round(val).toString()
    case 'avg':  return Number(val).toFixed(3).replace(/^0/, '')
    case 'pct':  return `${(val * 100).toFixed(1)}%`
    case 'wpa':  return val >= 0 ? `+${Number(val).toFixed(2)}` : Number(val).toFixed(2)
    default:     return String(val)
  }
}

// ── Radar chart ────────────────────────────────────────────────
function RadarChart({ stats }) {
  const cx = 160, cy = 130, r = 80
  const n = stats.length
  const angles = stats.map((_, i) => (Math.PI * 2 * i / n) - Math.PI / 2)

  const grid = [25, 50, 75, 100].map(level => {
    const rr = r * level / 100
    const points = angles.map(a => `${cx + rr * Math.cos(a)},${cy + rr * Math.sin(a)}`).join(' ')
    return <polygon key={level} points={points} fill="none" stroke={THEME.border} strokeWidth="0.6" opacity={level === 100 ? 1 : 0.5} />
  })

  const axes = angles.map((a, i) => (
    <line key={i} x1={cx} y1={cy} x2={cx + r * Math.cos(a)} y2={cy + r * Math.sin(a)} stroke={THEME.border} strokeWidth="0.6" />
  ))

  const dataPoints = stats.map((s, i) => {
    const rr = r * (s.pct || 0) / 100
    return `${cx + rr * Math.cos(angles[i])},${cy + rr * Math.sin(angles[i])}`
  }).join(' ')

  const dots = stats.map((s, i) => {
    const rr = r * (s.pct || 0) / 100
    return (
      <circle key={i}
        cx={cx + rr * Math.cos(angles[i])}
        cy={cy + rr * Math.sin(angles[i])}
        r="3" fill={pctColor(s.pct || 0)} stroke="#fff" strokeWidth="1" />
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
        <text x={lx} y={ly + dy} textAnchor={anchor} fontSize="9.5" fontWeight="700" fill="currentColor">{s.label}</text>
        <text x={lx} y={ly + dy + 10} textAnchor={anchor} fontSize="9" fill={THEME.textMuted} fontWeight="600">{s.pct ?? 0}th</text>
      </g>
    )
  })

  return (
    <svg viewBox="0 0 320 250" preserveAspectRatio="xMidYMid meet" className="w-full h-auto text-gray-900 dark:text-gray-100">
      {grid}{axes}
      <polygon points={dataPoints} fill="rgba(210,45,73,0.22)" stroke={THEME.great} strokeWidth="1.6" strokeLinejoin="round" />
      {dots}{labels}
    </svg>
  )
}

// ── Rolling wOBA chart (computed from game logs) ──────────────
function RollingWobaChart({ series, seasonAvg }) {
  if (!series || series.length < 2) return <div className="text-xs text-gray-500 dark:text-gray-400">Not enough games yet</div>

  const w = 340, h = 195
  const pl = 30, pr = 58, pt = 12, pb = 22
  const cw = w - pl - pr
  const ch = h - pt - pb
  const minY = 0.300, maxY = 0.600
  const last10Avg = series.slice(-1)[0] // latest rolling value
  const d2Avg = 0.330

  const xs = series.map((_, i) => pl + (cw * i / (series.length - 1)))
  const ys = series.map(v => pt + ch * (1 - (Math.max(minY, Math.min(maxY, v)) - minY) / (maxY - minY)))
  const path = series.map((_, i) => `${i === 0 ? 'M' : 'L'} ${xs[i].toFixed(1)} ${ys[i].toFixed(1)}`).join(' ')
  const areaPath = path + ` L ${xs[xs.length-1].toFixed(1)} ${(pt + ch).toFixed(1)} L ${xs[0].toFixed(1)} ${(pt + ch).toFixed(1)} Z`
  const yPos = v => pt + ch * (1 - (Math.max(minY, Math.min(maxY, v)) - minY) / (maxY - minY))

  const yTicks = [0.350, 0.400, 0.450, 0.500, 0.550]
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" className="w-full h-auto">
      {yTicks.map(t => (
        <g key={t}>
          <line x1={pl} y1={yPos(t)} x2={pl + cw} y2={yPos(t)} stroke={THEME.border} strokeWidth="0.5" strokeDasharray="2,3" />
          <text x={pl - 4} y={yPos(t) + 3} textAnchor="end" fontSize="8.5" fill={THEME.textLight} fontWeight="600">.{Math.round(t * 1000)}</text>
        </g>
      ))}
      <line x1={pl} y1={yPos(d2Avg)} x2={pl + cw} y2={yPos(d2Avg)} stroke={THEME.poor} strokeWidth="1" strokeDasharray="3,2" opacity="0.85" />
      <text x={pl + cw + 9} y={yPos(d2Avg) + 3} fontSize="8.5" fill={THEME.poor} fontWeight="700">D2 .330</text>
      {seasonAvg != null && (
        <line x1={pl} y1={yPos(seasonAvg)} x2={pl + cw} y2={yPos(seasonAvg)} stroke={THEME.gold} strokeWidth="1" strokeDasharray="3,2" opacity="0.85" />
      )}
      <path d={areaPath} fill="rgba(210,45,73,0.10)" />
      <path d={path} fill="none" stroke={THEME.great} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={xs[xs.length - 1].toFixed(1)} cy={ys[ys.length - 1].toFixed(1)} r="3.8" fill={THEME.great} stroke="#fff" strokeWidth="1.5" />
      <text x={pl} y={h - 6} fontSize="9" fill={THEME.textLight} fontWeight="700">G1</text>
      <text x={(pl + cw / 2).toFixed(1)} y={h - 6} textAnchor="middle" fontSize="9" fill={THEME.textLight} fontWeight="700">G{Math.round(series.length / 2)}</text>
      <text x={pl + cw} y={h - 6} textAnchor="end" fontSize="9" fill={THEME.textLight} fontWeight="700">G{series.length}</text>
    </svg>
  )
}

// ── wOBA constants (rough — Fangraphs 2023 weights, good enough for
// per-game rolling) ─────────────────────────────────────────────
const WOBA_W = { bb: 0.69, hbp: 0.72, h1b: 0.88, h2b: 1.247, h3b: 1.578, hr: 2.031 }
function gameWoba(g) {
  const ab = g.ab || 0
  const bb = g.bb || 0
  const hbp = g.hbp || 0
  const sf = g.sf || 0
  const h = g.h || 0
  const d = g['2b'] || 0
  const t = g['3b'] || 0
  const hr = g.hr || 0
  const s = Math.max(0, h - d - t - hr)
  const den = ab + bb + sf + hbp
  if (den <= 0) return null
  const num = WOBA_W.bb * bb + WOBA_W.hbp * hbp + WOBA_W.h1b * s + WOBA_W.h2b * d + WOBA_W.h3b * t + WOBA_W.hr * hr
  return num / den
}
function rollingWoba(games, window = 10) {
  const wobas = games.map(g => ({ g, w: gameWoba(g) })).filter(x => x.w != null)
  const out = []
  for (let i = 0; i < wobas.length; i++) {
    const slice = wobas.slice(Math.max(0, i - window + 1), i + 1)
    const tot = slice.reduce((s, x) => s + x.w, 0)
    out.push(tot / slice.length)
  }
  return out
}

// Game grade for the heatmap: simple OPS-driven 0-100. Empty AB → 50.
function gameGrade(g) {
  const ab = g.ab || 0
  const bb = g.bb || 0
  const h = g.h || 0
  const d = g['2b'] || 0
  const t = g['3b'] || 0
  const hr = g.hr || 0
  const k = g.k || 0
  const tb = h + d + 2 * t + 3 * hr
  const pa = ab + bb
  if (pa <= 0) return 50
  const obp = (h + bb) / pa
  const slg = ab > 0 ? tb / ab : 0
  const ops = obp + slg
  // Map OPS .000 → 0, 1.000 → 70, 1.500 → 100. K-heavy ABs drop floor.
  let grade = Math.min(100, Math.max(0, Math.round(ops * 70)))
  if (k >= 2 && h === 0) grade = Math.max(grade - 20, 10)
  if (hr >= 1) grade = Math.max(grade, 80)
  return grade
}

// ── Hero: percentile rankings panel ────────────────────────────
function PctRow({ stat, pct, raw }) {
  const [open, setOpen] = useState(false)
  const color = pctColor(pct || 0)
  const tip = TOOLTIPS[stat] || { what: '', why: '', range: '' }
  return (
    <div className="grid items-center gap-3 py-1" style={{ gridTemplateColumns: '100px 1fr 70px' }}>
      <div className="flex items-center justify-end gap-1 text-[12.5px] text-gray-700 dark:text-gray-300 font-medium">
        <span>{stat}</span>
        <button
          onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
          className="w-[13px] h-[13px] rounded-full bg-gray-400 text-white text-[9px] font-bold inline-flex items-center justify-center relative"
          title={stat}>
          i
          {open && (
            <span className="absolute bottom-[calc(100%+8px)] -right-2 z-50 w-60 p-3 rounded-md text-left text-[11.5px] font-normal text-white leading-snug" style={{ background: '#1a1a1a' }}>
              <strong className="block text-[12.5px] mb-1" style={{ color: THEME.gold }}>{stat}</strong>
              <span className="block">{tip.what}</span>
              <span className="block mt-1.5 text-[10px] uppercase tracking-wider" style={{ color: '#a3a3a3' }}>Why it matters</span>
              <span className="block">{tip.why}</span>
              <span className="block mt-1.5 text-[10px] uppercase tracking-wider" style={{ color: '#a3a3a3' }}>Range</span>
              <span className="block">{tip.range}</span>
            </span>
          )}
        </button>
      </div>
      <div className="relative h-3 rounded-full bg-[#efeadc] dark:bg-gray-700">
        <div className="h-full rounded-full relative" style={{ width: `${pct || 0}%`, background: color, minWidth: '18px' }}>
          <div className="absolute right-[-4px] top-1/2 -translate-y-1/2 w-[22px] h-[22px] rounded-full text-white text-[10.5px] font-bold flex items-center justify-center z-10 leading-none"
            style={{ background: color }}>
            {pct ?? 0}
          </div>
        </div>
      </div>
      <div className="text-right text-[12.5px] font-bold tabular-nums text-gray-900 dark:text-gray-100">{raw}</div>
    </div>
  )
}

// ── Career path timeline ──────────────────────────────────────
function CareerPath({ player }) {
  const nodes = []
  if (player.high_school || player.hometown) {
    nodes.push({
      type: 'hs',
      school: player.high_school || 'High School',
      loc: player.hometown || '',
      years: '— 2024',
      tag: 'High School',
    })
  }
  if (player.previous_school) {
    nodes.push({
      type: 'juco',
      school: player.previous_school,
      loc: '',
      years: '2024 – 2025',
      tag: 'Previous',
    })
  }
  nodes.push({
    type: 'current',
    school: player.team_name,
    loc: '',
    years: '2025 – Present',
    tag: 'CURRENT',
  })

  return (
    <div className="flex items-stretch pt-2 pb-1">
      {nodes.map((n, i) => (
        <div key={i} className="flex-1 flex flex-col items-center text-center relative px-2" style={n.type !== 'current' ? {} : {}}>
          {i < nodes.length - 1 && (
            <span className="absolute top-[14px] left-1/2 right-[-50%] h-[2px]" style={{ background: THEME.borderStrong }} />
          )}
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-bold relative z-10 border-[3px] border-white mb-2.5 leading-none"
            style={{
              background: n.type === 'current' ? THEME.gold : (n.type === 'juco' ? '#1f5485' : THEME.accent),
              boxShadow: n.type === 'current'
                ? `0 0 0 1px ${THEME.gold}, 0 0 0 4px rgba(201,164,76,0.2)`
                : `0 0 0 1px ${THEME.borderStrong}`,
            }}>
            {n.type === 'current' ? 'D2' : (n.type === 'juco' ? 'JC' : 'HS')}
          </div>
          <div className="font-bold text-[13px] text-gray-900 dark:text-gray-100">{n.school}</div>
          {n.loc && <div className="text-[11px] text-gray-600 dark:text-gray-400 mt-0.5">{n.loc}</div>}
          <div className="text-[10px] uppercase tracking-wider mt-1.5 font-bold" style={{ color: THEME.textLight }}>{n.years}</div>
          <span
            className="inline-block mt-1.5 px-2 py-[2px] rounded-full text-[9px] font-bold tracking-wider"
            style={n.type === 'current'
              ? { background: THEME.gold, color: THEME.accent }
              : { background: THEME.border, color: THEME.textMuted }}>
            {n.tag}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Streaks card (inlined; the live version isn't exported) ─────
function StreaksCardJW({ playerId, season = 2026 }) {
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
  const total = (data.current_hit_streak || 0) + (data.current_ob_streak || 0)
              + (data.best_hit_streak || 0) + (data.best_ob_streak || 0)
  if (!total) return null

  const tile = (label, val, accent) => (
    <div className="text-center px-2 py-3 rounded-lg" style={{ background: THEME.bg, border: `1px solid ${THEME.border}` }}>
      <div className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider" style={{ color: THEME.textMuted }}>{label}</div>
      <div className={`text-2xl sm:text-3xl font-extrabold mt-1 ${accent}`}>{val ?? 0}</div>
      <div className="text-[10px] mt-0.5" style={{ color: THEME.textLight }}>{(val ?? 0) === 1 ? 'game' : 'games'}</div>
    </div>
  )

  return (
    <div className="rounded-md p-5 mb-4 dark:bg-gray-800 dark:border-gray-700" style={{ background: '#fff', border: `1px solid ${THEME.border}` }}>
      <h2 className="font-bold text-[15px] mb-3 pb-1.5 border-b-2 flex items-center gap-2 dark:text-gray-100" style={{ color: THEME.text, borderColor: THEME.text }}>
        <span>🔥 {season} Streaks</span>
        <span className="ml-auto text-[11px] font-semibold tracking-widest" style={{ color: THEME.textLight }}>CURRENT</span>
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tile('Current Hit',     data.current_hit_streak, 'text-emerald-600')}
        {tile('Current On-Base', data.current_ob_streak,  'text-teal-600')}
        {tile('Longest Hit',     data.best_hit_streak,    'text-gray-900 dark:text-gray-100')}
        {tile('Longest On-Base', data.best_ob_streak,     'text-gray-900 dark:text-gray-100')}
      </div>
    </div>
  )
}

// ── wRC+ Game Tracker (heatmap) ────────────────────────────────
function GameTracker({ games }) {
  if (!games || !games.length) {
    return <div className="text-xs text-gray-500 dark:text-gray-400">No games yet</div>
  }
  const cols = 16
  const cellsTop = []
  for (let i = 0; i < games.length; i++) {
    const g = games[i]
    const grade = gameGrade(g)
    cellsTop.push({ g, grade })
  }
  // Month labels: place the month abbreviation in the column matching
  // the first game of that month within row 0.
  const monthLabels = Array(cols).fill('')
  const monthOf = (g) => {
    if (!g?.game_date) return ''
    const m = new Date(g.game_date).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()
    return m
  }
  let last = ''
  cellsTop.slice(0, cols).forEach((c, i) => {
    const m = monthOf(c.g)
    if (m && m !== last) { monthLabels[i] = m; last = m }
  })

  // Stats for the meta row
  const last5 = cellsTop.slice(-5)
  const last5Grade = last5.length ? Math.round(last5.reduce((s, c) => s + c.grade, 0) / last5.length) : 0
  const seasonAvgGrade = Math.round(cellsTop.reduce((s, c) => s + c.grade, 0) / cellsTop.length)
  const best = cellsTop.reduce((acc, c) => c.grade > (acc?.grade ?? -1) ? c : acc, null)
  const worst = cellsTop.reduce((acc, c) => c.grade < (acc?.grade ?? 999) ? c : acc, null)

  const fmtDate = d => {
    if (!d) return ''
    const dt = new Date(d)
    return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`
  }

  return (
    <div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 mb-3 text-[11px]" style={{ color: THEME.textMuted }}>
        <div className="flex flex-col">
          <span className="text-[9.5px] uppercase tracking-wider" style={{ color: THEME.textLight }}>Season Grade</span>
          <span className="text-base font-bold tabular-nums dark:text-gray-100" style={{ color: THEME.text }}>{seasonAvgGrade}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[9.5px] uppercase tracking-wider" style={{ color: THEME.textLight }}>Last 5 Games</span>
          <span className="text-base font-bold tabular-nums" style={{ color: last5Grade >= seasonAvgGrade ? THEME.great : THEME.poor }}>{last5Grade}</span>
        </div>
        {best && (
          <div className="flex flex-col">
            <span className="text-[9.5px] uppercase tracking-wider" style={{ color: THEME.textLight }}>Best Game</span>
            <span className="text-base font-bold tabular-nums dark:text-gray-100" style={{ color: THEME.text }}>
              {fmtDate(best.g.game_date)} {best.g.home_away === '@' ? '@' : 'vs'} {best.g.opponent_short?.slice(0, 12) || '?'}
            </span>
          </div>
        )}
        {worst && (
          <div className="flex flex-col">
            <span className="text-[9.5px] uppercase tracking-wider" style={{ color: THEME.textLight }}>Coldest Game</span>
            <span className="text-base font-bold tabular-nums" style={{ color: THEME.poor }}>{fmtDate(worst.g.game_date)}</span>
          </div>
        )}
      </div>

      <div className="grid gap-1 text-[10px] text-center font-bold tracking-wider mb-1" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, color: THEME.textLight }}>
        {monthLabels.map((m, i) => <span key={i}>{m}</span>)}
      </div>
      <div className="grid gap-1 mb-2" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {cellsTop.map((c, i) => {
          const line = `${c.g.h || 0}-${c.g.ab || 0}${c.g.hr ? `, ${c.g.hr}HR` : ''}${c.g.bb ? `, ${c.g.bb}BB` : ''}${c.g.k ? `, ${c.g.k}K` : ''}`
          return (
            <div key={i}
              className="aspect-square rounded-sm relative group cursor-pointer"
              style={{ background: pctColor(c.grade), border: '1px solid rgba(0,0,0,0.05)' }}
              title={`${fmtDate(c.g.game_date)} ${c.g.home_away === '@' ? '@' : 'vs'} ${c.g.opponent_short}: ${line} • grade ${c.grade}`} />
          )
        })}
      </div>

      <div className="flex items-center justify-center gap-2 text-[11px] font-semibold mt-2" style={{ color: THEME.textMuted }}>
        <span>Cold</span>
        <div className="flex gap-[2px]">
          {[5, 20, 35, 50, 65, 80, 95].map((p, i) => (
            <span key={i} className="w-[18px] h-[14px] rounded-sm" style={{ background: pctColor(p) }} />
          ))}
        </div>
        <span>Hot</span>
        <span className="ml-3 text-[10px] font-normal" style={{ color: THEME.textLight }}>Each cell = 1 game · hover for line</span>
      </div>
    </div>
  )
}

// ── Statistically similar players (placeholder list — no real
// similarity model yet) ──────────────────────────────────────
const SIMILAR_PLACEHOLDER = [
  { rank: 1, name: 'Coming soon',   meta: 'Similarity engine in dev', score: '—' },
]

// ── Game log table (compact, inline) ───────────────────────────
function GameLogJW({ games }) {
  if (!games || !games.length) return <div className="text-xs text-gray-500 dark:text-gray-400">No games yet.</div>
  const fmtDate = d => {
    if (!d) return ''
    const dt = new Date(d)
    return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`
  }
  return (
    <div className="overflow-x-auto -mx-3 sm:mx-0">
      <div className="min-w-[720px] px-3 sm:px-0">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b" style={{ borderColor: THEME.border }}>
              {['Date','Opp','AB','R','H','2B','3B','HR','RBI','BB','K','SB'].map(h => (
                <th key={h} className={`px-2 py-1.5 font-semibold ${h === 'Date' || h === 'Opp' ? 'text-left' : 'text-right'} dark:text-gray-300`} style={{ color: THEME.textMuted }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {games.map((g, i) => (
              <tr key={i} className="border-b hover:bg-gray-50 dark:hover:bg-gray-700/50" style={{ borderColor: '#f0ebdc' }}>
                <td className="px-2 py-1.5 text-left dark:text-gray-200" style={{ color: THEME.textMuted }}>{fmtDate(g.game_date)}</td>
                <td className="px-2 py-1.5 text-left font-semibold dark:text-gray-100" style={{ color: THEME.text }}>
                  {g.home_away === '@' ? '@ ' : 'vs '}{g.opponent_short?.split(' ').slice(0, 2).join(' ') || '?'}
                </td>
                {['ab','r','h','2b','3b','hr','rbi','bb','k','sb'].map(k => (
                  <td key={k} className="px-2 py-1.5 text-right tabular-nums dark:text-gray-200" style={{ color: THEME.text }}>{g[k] ?? 0}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ───────────────────────────────────────────────────────────────
export default function JasonWrightProfile() {
  const { data, loading, error } = usePlayer(PLAYER_ID)
  const { data: gameLogs } = usePlayerGameLogs(PLAYER_ID, 2026)
  // splits hook reserved for a future situational-splits widget; not
  // rendered in v1 of the prototype.
  // eslint-disable-next-line no-unused-vars
  const { data: splits } = usePlayerSplits(PLAYER_ID, 2026)

  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <div className="animate-spin h-8 w-8 border-4 border-nw-teal border-t-transparent rounded-full" />
        <div className="text-xs text-gray-500 dark:text-gray-400">Loading prototype...</div>
      </div>
    )
  }
  if (error || !data) {
    return <div className="text-center py-20 text-gray-500 dark:text-gray-400">{error || 'Player not found.'}</div>
  }

  const { player, batting_stats, batting_percentiles, awards, pnw_rankings, position_breakdown } = data
  const battingByYear = (batting_stats || []).sort((a, b) => a.season - b.season)
  const career = battingByYear.reduce((acc, s) => {
    acc.pa += s.plate_appearances || 0
    acc.ab += s.at_bats || 0
    acc.h  += s.hits || 0
    acc.hr += s.home_runs || 0
    acc.bb += s.walks || 0
    acc.hbp += s.hit_by_pitch || 0
    acc.sf += s.sacrifice_flies || 0
    acc.tb += (s.hits || 0) + (s.doubles || 0) + 2 * (s.triples || 0) + 3 * (s.home_runs || 0)
    return acc
  }, { pa: 0, ab: 0, h: 0, hr: 0, bb: 0, hbp: 0, sf: 0, tb: 0 })
  const careerAvg = career.ab > 0 ? career.h / career.ab : 0
  const careerOBP = (career.ab + career.bb + career.hbp + career.sf) > 0
    ? (career.h + career.bb + career.hbp) / (career.ab + career.bb + career.hbp + career.sf) : 0
  const careerSLG = career.ab > 0 ? career.tb / career.ab : 0

  const currSeason = battingByYear.slice(-1)[0]
  const seasonWobaVal = currSeason?.woba

  // Build radar data from live percentiles, fallback to 0 if missing
  const radarStats = RADAR_KEYS.map(rk => ({
    label: rk.label,
    pct: batting_percentiles?.[rk.key]?.percentile ?? 0,
  }))

  // Per-game wOBA series (rolling-10) for the hero chart
  const battingGames = gameLogs?.batting || []
  const rolling = useMemo(() => rollingWoba(battingGames, 10), [battingGames])

  // Hot indicator: last 10 PAs OPS vs season OPS
  const lastN = battingGames.slice(-7)
  const hotFlag = useMemo(() => {
    if (!currSeason || lastN.length < 3) return false
    const slice = lastN.reduce((s, g) => ({
      ab: s.ab + (g.ab || 0), h: s.h + (g.h || 0), bb: s.bb + (g.bb || 0),
      tb: s.tb + (g.h || 0) + (g['2b'] || 0) + 2 * (g['3b'] || 0) + 3 * (g.hr || 0),
    }), { ab: 0, h: 0, bb: 0, tb: 0 })
    if (slice.ab === 0) return false
    const ops = (slice.h + slice.bb) / (slice.ab + slice.bb) + slice.tb / slice.ab
    return ops > (currSeason.ops || 0) * 1.1
  }, [lastN, currSeason])

  // Position breakdown rows (top 3)
  const posRows = (position_breakdown || []).slice(0, 3)

  return (
    <div className="rounded-md" style={{ background: THEME.bg }}>
      <div className="dark:bg-gray-900 -m-px p-1 rounded-md">

        {/* Prototype banner / hero */}
        <div className="grid lg:grid-cols-[1.1fr_1fr] rounded-md overflow-hidden mb-4 dark:border-gray-700"
          style={{ background: '#fff', border: `1px solid ${THEME.border}` }}>

          {/* LEFT: bio, radar, rolling wOBA, year table, badges */}
          <div className="p-5 flex flex-col dark:bg-gray-800">
            <div className="relative h-20 -mx-5 -mt-5"
              style={{ background: 'linear-gradient(120deg, #14365c 0%, #1f5485 55%, #c9a44c 100%)' }}>
              <div className="absolute -bottom-7 left-[18px] w-[70px] h-[70px] rounded-full bg-gray-300 border-[3px] border-white flex items-center justify-center text-2xl font-bold text-gray-500 overflow-hidden">
                {player.headshot_url
                  ? <img src={player.headshot_url} alt="" className="w-full h-full object-cover" />
                  : <span>{player.first_name?.[0]}{player.last_name?.[0]}</span>}
              </div>
              {posRows.length > 0 && (
                <div className="absolute top-2 right-2.5 rounded-md px-2.5 pt-1.5 pb-2 text-white min-w-[170px]"
                  style={{ background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', border: '1px solid rgba(255,255,255,0.14)' }}>
                  <div className="text-[8.5px] font-bold tracking-widest opacity-80 mb-1">2026 POSITIONS</div>
                  {posRows.map(p => (
                    <div key={p.position} className="grid items-center mt-1 tabular-nums"
                      style={{ gridTemplateColumns: '22px 1fr 36px', gap: '7px' }}>
                      <span className="text-[10.5px] font-bold tracking-wide">{p.position}</span>
                      <div className="h-1 rounded-sm overflow-hidden" style={{ background: 'rgba(255,255,255,0.18)' }}>
                        <div className="h-full" style={{ width: `${p.percentage}%`, background: THEME.gold }} />
                      </div>
                      <span className="text-[9.5px] font-semibold text-right opacity-90">{Math.round(p.percentage)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-9">
              <div className="flex items-baseline gap-2 flex-wrap">
                <h1 className="text-[22px] font-bold tracking-tight dark:text-gray-100" style={{ color: THEME.text }}>
                  {player.first_name} {player.last_name}
                </h1>
                {player.jersey_number && (
                  <span className="text-base font-bold" style={{ color: THEME.textMuted }}>#{player.jersey_number}</span>
                )}
                {hotFlag && (
                  <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-bold px-2 py-[3px] rounded-full tracking-wide" style={{ background: 'rgba(255,107,53,0.12)', color: THEME.hot }}>
                    🔥 HOT
                  </span>
                )}
              </div>
              <div className="text-[13px] font-semibold mt-1 dark:text-gray-300" style={{ color: THEME.textMuted }}>
                {player.position} | <Link to={`/team/${player.team_id}`} className="hover:underline">{player.team_name}</Link>
              </div>
              <div className="text-[11px] mt-1.5 leading-relaxed dark:text-gray-400" style={{ color: THEME.textMuted }}>
                Bats/Throws: {player.bats || '—'}/{player.throws || '—'} &nbsp;|&nbsp; {player.height || '—'} {player.weight ? `${player.weight} lbs` : ''}
                {player.hometown && <><br />From: {player.hometown}</>}
                {player.previous_school && <> &nbsp;|&nbsp; Prev: {player.previous_school}</>}
              </div>

              {/* Skill profile + rolling wOBA side-by-side */}
              <div className="grid grid-cols-1 sm:grid-cols-[0.95fr_1.05fr] gap-3.5 items-stretch my-3 py-2 border-y" style={{ borderColor: THEME.border }}>
                <div className="flex flex-col min-w-0">
                  <div className="text-[9.5px] font-bold tracking-widest uppercase text-center mb-0.5" style={{ color: THEME.textLight }}>Skill Profile</div>
                  <div className="flex-1 max-w-[260px] mx-auto w-full"><RadarChart stats={radarStats} /></div>
                </div>
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center justify-center gap-2 mb-0.5">
                    <span className="text-[9.5px] font-bold tracking-widest uppercase" style={{ color: THEME.textLight }}>10-Game Rolling wOBA</span>
                    {seasonWobaVal != null && (
                      <span className="px-1.5 py-px rounded-md text-[9.5px] font-bold tabular-nums tracking-wide text-white" style={{ background: THEME.great }}>
                        SEASON {formatPct('avg', seasonWobaVal)}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 max-w-[340px] mx-auto w-full">
                    <RollingWobaChart series={rolling} seasonAvg={seasonWobaVal} />
                  </div>
                </div>
              </div>

              {/* Year-by-year table */}
              <table className="w-full mt-2 text-[11px] border-collapse">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${THEME.border}` }}>
                    {['Year','PA','AVG','OBP','SLG','HR','wRC+'].map(h => (
                      <th key={h} className={`px-1.5 py-1 font-bold tracking-wide dark:text-gray-300 ${h === 'Year' ? 'text-left' : 'text-right'}`} style={{ color: THEME.textLight }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {battingByYear.map((s, i) => {
                    const isCurrent = i === battingByYear.length - 1
                    return (
                      <tr key={s.season}
                        className={isCurrent ? 'font-bold dark:bg-amber-900/20' : 'dark:text-gray-200'}
                        style={isCurrent
                          ? { background: '#faf6ec', borderTop: `1px solid ${THEME.borderStrong}` }
                          : {}}>
                        <td className="px-1.5 py-1 text-left dark:text-gray-300" style={{ color: THEME.textMuted }}>{s.season}</td>
                        <td className="px-1.5 py-1 text-right tabular-nums">{s.plate_appearances}</td>
                        <td className="px-1.5 py-1 text-right tabular-nums">{formatPct('avg', s.batting_avg)}</td>
                        <td className="px-1.5 py-1 text-right tabular-nums">{formatPct('avg', s.on_base_pct)}</td>
                        <td className="px-1.5 py-1 text-right tabular-nums">{formatPct('avg', s.slugging_pct)}</td>
                        <td className="px-1.5 py-1 text-right tabular-nums">{s.home_runs}</td>
                        <td className="px-1.5 py-1 text-right tabular-nums">{Math.round(s.wrc_plus || 0)}</td>
                      </tr>
                    )
                  })}
                  {battingByYear.length > 1 && (
                    <tr style={{ borderTop: `1px solid ${THEME.border}` }} className="dark:text-gray-200">
                      <td className="px-1.5 py-1 text-left dark:text-gray-300" style={{ color: THEME.textMuted }}>Career</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{career.pa}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{formatPct('avg', careerAvg)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{formatPct('avg', careerOBP)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{formatPct('avg', careerSLG)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">{career.hr}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums">—</td>
                    </tr>
                  )}
                </tbody>
              </table>

              {/* Badges */}
              <div className="flex flex-wrap gap-1.5 mt-3">
                {(awards || []).map((a, i) => (
                  <span key={i} className="text-[9.5px] font-bold tracking-wide px-2 py-[3px] rounded-full inline-flex items-center gap-1"
                    style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }}>
                    🏆 GNAC {a.category} · {a.season}
                  </span>
                ))}
                {(pnw_rankings || []).slice(0, 3).map((r, i) => (
                  <span key={i} className="text-[9.5px] font-bold tracking-wide px-2 py-[3px] rounded-full"
                    style={{ background: '#dbeafe', color: '#1e40af', border: '1px solid #93c5fd' }}>
                    {r.rank}{r.rank === 1 ? 'st' : r.rank === 2 ? 'nd' : r.rank === 3 ? 'rd' : 'th'} PNW · {r.category}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* RIGHT: percentile rankings */}
          <div className="p-5 border-l dark:bg-gray-800 dark:border-gray-700" style={{ borderColor: THEME.border }}>
            <div className="flex items-baseline gap-2 pb-2 mb-3 border-b-2 dark:border-gray-100" style={{ borderColor: THEME.text }}>
              <h3 className="text-base font-bold tracking-tight dark:text-gray-100" style={{ color: THEME.text }}>Percentile Rankings</h3>
              <span className="ml-auto text-[11px] tracking-widest font-semibold" style={{ color: THEME.textLight }}>2026 · VS. D2</span>
            </div>
            <div className="grid items-end gap-3 text-[9px] font-bold uppercase tracking-widest mb-1.5"
              style={{ gridTemplateColumns: '100px 1fr 70px' }}>
              <span />
              <div className="flex justify-between">
                <span style={{ color: THEME.poor }}>▲ POOR</span>
                <span style={{ color: THEME.textLight }}>▲ AVG</span>
                <span style={{ color: THEME.great }}>▲ GREAT</span>
              </div>
              <span />
            </div>
            <div>
              {PCT_METRICS.map(m => {
                const v = batting_percentiles?.[m.key]
                const pct = v?.percentile
                const raw = v?.value != null ? formatPct(m.fmt, v.value) : '—'
                return <PctRow key={m.key} stat={m.label} pct={pct} raw={raw} />
              })}
            </div>
          </div>
        </div>

        {/* ── STREAKS ── */}
        <StreaksCardJW playerId={PLAYER_ID} />

        {/* ── PITCH LEVEL STATS (existing) ── */}
        <div className="rounded-md p-5 mb-4 dark:bg-gray-800 dark:border-gray-700" style={{ background: '#fff', border: `1px solid ${THEME.border}` }}>
          <h2 className="font-bold text-[15px] mb-3 pb-1.5 border-b-2 flex items-center gap-2 dark:text-gray-100 dark:border-gray-500" style={{ color: THEME.text, borderColor: THEME.text }}>
            <span>⚾ Pitch Level Stats</span>
            <span className="ml-auto text-[11px] font-semibold tracking-widest" style={{ color: THEME.textLight }}>2026</span>
          </h2>
          <div className="-mx-2">
            <PitchLevelStatsCard playerId={PLAYER_ID} season={2026} />
          </div>
        </div>

        {/* ── WPA AT THE PLATE (existing) ── */}
        <div className="rounded-md p-5 mb-4 dark:bg-gray-800 dark:border-gray-700" style={{ background: '#fff', border: `1px solid ${THEME.border}` }}>
          <h2 className="font-bold text-[15px] mb-3 pb-1.5 border-b-2 flex items-center gap-2 dark:text-gray-100 dark:border-gray-500" style={{ color: THEME.text, borderColor: THEME.text }}>
            <span>⚡ WPA at the Plate</span>
            <span className="ml-auto text-[11px] font-semibold tracking-widest" style={{ color: THEME.textLight }}>2026</span>
          </h2>
          <WpaByGameChart playerId={PLAYER_ID} position="batter" />
        </div>

        {/* ── GAME LOG (inline compact) ── */}
        <div className="rounded-md p-5 mb-4 dark:bg-gray-800 dark:border-gray-700" style={{ background: '#fff', border: `1px solid ${THEME.border}` }}>
          <h2 className="font-bold text-[15px] mb-3 pb-1.5 border-b-2 flex items-center gap-2 dark:text-gray-100 dark:border-gray-500" style={{ color: THEME.text, borderColor: THEME.text }}>
            <span>📝 Game Log</span>
            <span className="ml-auto text-[11px] font-semibold tracking-widest" style={{ color: THEME.textLight }}>2026 SEASON</span>
          </h2>
          <GameLogJW games={battingGames} />
        </div>

        {/* ── DIVIDER ── */}
        <div className="flex items-center gap-3 my-6">
          <span className="flex-1 h-px" style={{ background: THEME.borderStrong }} />
          <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: THEME.textLight }}>Extended Analytics</span>
          <span className="flex-1 h-px" style={{ background: THEME.borderStrong }} />
        </div>

        {/* ── wRC+ GAME TRACKER ── */}
        <div className="rounded-md p-5 mb-4 dark:bg-gray-800 dark:border-gray-700" style={{ background: '#fff', border: `1px solid ${THEME.border}` }}>
          <h2 className="font-bold text-[15px] mb-3 pb-1.5 border-b-2 flex items-center gap-2 dark:text-gray-100 dark:border-gray-500" style={{ color: THEME.text, borderColor: THEME.text }}>
            <span>📈 Per-Game Tracker</span>
            <span className="ml-auto text-[11px] font-semibold tracking-widest" style={{ color: THEME.textLight }}>2026 · CHRONOLOGICAL</span>
          </h2>
          <GameTracker games={battingGames} />
        </div>

        {/* ── CAREER PATH + SIMILAR PLAYERS ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          <div className="rounded-md p-5 dark:bg-gray-800 dark:border-gray-700" style={{ background: '#fff', border: `1px solid ${THEME.border}` }}>
            <h2 className="font-bold text-[15px] mb-3 pb-1.5 border-b-2 flex items-center gap-2 dark:text-gray-100 dark:border-gray-500" style={{ color: THEME.text, borderColor: THEME.text }}>
              <span>🎓 Career Path</span>
              <span className="ml-auto text-[11px] font-semibold tracking-widest" style={{ color: THEME.textLight }}>SCHOOLS</span>
            </h2>
            <CareerPath player={player} />
          </div>

          <div className="rounded-md p-5 dark:bg-gray-800 dark:border-gray-700" style={{ background: '#fff', border: `1px solid ${THEME.border}` }}>
            <h2 className="font-bold text-[15px] mb-3 pb-1.5 border-b-2 flex items-center gap-2 dark:text-gray-100 dark:border-gray-500" style={{ color: THEME.text, borderColor: THEME.text }}>
              <span>👥 Statistically Similar Players</span>
              <span className="ml-auto text-[11px] font-semibold tracking-widest" style={{ color: THEME.textLight }}>D2 · 2026</span>
            </h2>
            <div className="flex flex-col gap-2">
              {SIMILAR_PLACEHOLDER.map(p => (
                <div key={p.rank} className="grid gap-2.5 items-center px-3 py-2.5 rounded-md dark:bg-gray-900/40 dark:border-gray-700"
                  style={{ background: THEME.bg, border: `1px solid ${THEME.border}`, gridTemplateColumns: '26px 1fr auto' }}>
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[11px] font-bold" style={{ background: THEME.accent }}>{p.rank}</div>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-bold text-[13px] dark:text-gray-100" style={{ color: THEME.text }}>{p.name}</span>
                    <span className="text-[11px] dark:text-gray-400" style={{ color: THEME.textMuted }}>{p.meta}</span>
                  </div>
                  <div className="text-[10px] text-right leading-snug dark:text-gray-400" style={{ color: THEME.textMuted }}>
                    <b className="block text-base dark:text-gray-100" style={{ color: THEME.text }}>{p.score}</b>
                    similarity
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="text-center text-[10.5px] tracking-wide py-3" style={{ color: THEME.textLight }}>
          PROTOTYPE LAYOUT · Test format · Production layout used for all other players.
        </div>
      </div>
    </div>
  )
}
