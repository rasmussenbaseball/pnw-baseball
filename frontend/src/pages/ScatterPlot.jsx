import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { divisionBadgeClass } from '../utils/stats'
import StatsLastUpdated from '../components/StatsLastUpdated'

const API_BASE = '/api/v1'

const STAT_OPTIONS = [
  // Team record
  { value: 'win_pct', label: 'Win %', group: 'Record' },
  { value: 'conf_win_pct', label: 'Conf Win %', group: 'Record' },
  { value: 'run_diff', label: 'Run Differential', group: 'Record' },
  // Batting
  { value: 'team_avg', label: 'Team AVG', group: 'Batting' },
  { value: 'team_obp', label: 'Team OBP', group: 'Batting' },
  { value: 'team_slg', label: 'Team SLG', group: 'Batting' },
  { value: 'team_ops', label: 'Team OPS', group: 'Batting' },
  { value: 'avg_woba', label: 'Avg wOBA', group: 'Batting' },
  { value: 'avg_wrc_plus', label: 'Avg wRC+', group: 'Batting' },
  { value: 'avg_iso', label: 'Avg ISO', group: 'Batting' },
  { value: 'total_hr', label: 'Total HR', group: 'Batting' },
  { value: 'total_runs', label: 'Total Runs', group: 'Batting' },
  { value: 'total_sb', label: 'Total SB', group: 'Batting' },
  { value: 'avg_bb_pct', label: 'BB% (Batting)', group: 'Batting' },
  { value: 'avg_k_pct', label: 'K% (Batting)', group: 'Batting', lowerBetter: true },
  { value: 'total_owar', label: 'Offensive WAR', group: 'Batting' },
  // Pitching
  { value: 'team_era', label: 'Team ERA', group: 'Pitching', lowerBetter: true },
  { value: 'team_whip', label: 'Team WHIP', group: 'Pitching', lowerBetter: true },
  { value: 'avg_fip', label: 'Avg FIP', group: 'Pitching', lowerBetter: true },
  { value: 'avg_fip_plus', label: 'Avg FIP+', group: 'Pitching' },
  { value: 'avg_era_plus', label: 'Avg ERA+', group: 'Pitching' },
  { value: 'avg_xfip', label: 'Avg xFIP', group: 'Pitching', lowerBetter: true },
  { value: 'total_k', label: 'Total K (Pitching)', group: 'Pitching' },
  { value: 'pitching_k_pct', label: 'K% (Pitching)', group: 'Pitching' },
  { value: 'pitching_bb_pct', label: 'BB% (Pitching)', group: 'Pitching', lowerBetter: true },
  { value: 'pitching_k_bb_pct', label: 'K-BB% (Pitching)', group: 'Pitching' },
  { value: 'total_pwar', label: 'Pitching WAR', group: 'Pitching' },
  // Combined
  { value: 'total_war', label: 'Total WAR', group: 'Overall' },
]

// Compute percentile rank (0-100) for a value within a sorted array
function percentileRank(sortedVals, value) {
  let count = 0
  for (const v of sortedVals) {
    if (v < value) count++
    else if (v === value) count += 0.5
  }
  return (count / sortedVals.length) * 100
}

// Get "performance percentile" - higher = better, accounting for lowerBetter
function perfPercentile(sortedVals, value, lowerBetter) {
  const raw = percentileRank(sortedVals, value)
  return lowerBetter ? (100 - raw) : raw
}

// Determine dot color based on both-axis percentiles
function getDotColor(xPerf, yPerf) {
  if (xPerf >= 75 && yPerf >= 75) return '#059669'  // emerald - top 25th in both
  if (xPerf <= 25 && yPerf <= 25) return '#dc2626'  // red - bottom 25th in both
  return '#ca8a04' // gold - everything else
}

// Brand colors
const BRAND = {
  teal: '#00687a',
  tealDark: '#004d5a',
  tealLight: '#008a9e',
  cream: '#faf8f5',
}

// SVG dimensions — larger for better quality
const HEADER_H = 52
const FOOTER_H = 28
const MARGIN = { top: HEADER_H + 20, right: 35, bottom: 55 + FOOTER_H, left: 65 }
const WIDTH = 850
const HEIGHT = 600

export default function ScatterPlot() {
  const [xStat, setXStat] = useState('team_avg')
  const [yStat, setYStat] = useState('team_era')
  const [divisionId, setDivisionId] = useState(null)
  const [divisions, setDivisions] = useState([])
  const [points, setPoints] = useState([])
  const [loading, setLoading] = useState(false)
  const [hoveredTeam, setHoveredTeam] = useState(null)
  const svgRef = useRef(null)

  const handleSaveImage = useCallback(async () => {
    const svg = svgRef.current
    if (!svg) return

    // Clone the SVG so we can inline logos as base64
    const clone = svg.cloneNode(true)
    const images = clone.querySelectorAll('image')

    await Promise.all(Array.from(images).map(async (imgEl) => {
      const href = imgEl.getAttribute('href')
      if (!href || href.startsWith('data:')) return
      try {
        const resp = await fetch(href)
        const blob = await resp.blob()
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result)
          reader.readAsDataURL(blob)
        })
        imgEl.setAttribute('href', dataUrl)
      } catch {
        // If logo fails to load, skip it
      }
    }))

    const svgData = new XMLSerializer().serializeToString(clone)
    const canvas = document.createElement('canvas')
    const scale = 2
    canvas.width = WIDTH * scale
    canvas.height = HEIGHT * scale
    const ctx = canvas.getContext('2d')
    ctx.scale(scale, scale)
    const img = new Image()
    img.onload = () => {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, WIDTH, HEIGHT)
      ctx.drawImage(img, 0, 0, WIDTH, HEIGHT)
      const link = document.createElement('a')
      link.download = `nwbb-${xStat}-vs-${yStat}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    }
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)))
  }, [xStat, yStat])

  // Fetch divisions
  useEffect(() => {
    fetch(`${API_BASE}/divisions`)
      .then(r => r.json())
      .then(d => setDivisions(d))
      .catch(() => {})
  }, [])

  // Fetch scatter data
  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams({ season: '2026', x_stat: xStat, y_stat: yStat })
    if (divisionId) params.set('division_id', divisionId)
    fetch(`${API_BASE}/teams/scatter?${params}`)
      .then(r => r.json())
      .then(data => { setPoints(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [xStat, yStat, divisionId])

  const xOpt = STAT_OPTIONS.find(s => s.value === xStat)
  const yOpt = STAT_OPTIONS.find(s => s.value === yStat)

  // Compute scales
  const { xScale, yScale, xTicks, yTicks } = useMemo(() => {
    if (!points.length) return { xScale: () => 0, yScale: () => 0, xTicks: [], yTicks: [] }

    const xVals = points.map(p => p.x)
    const yVals = points.map(p => p.y)
    const xMin = Math.min(...xVals)
    const xMax = Math.max(...xVals)
    const yMin = Math.min(...yVals)
    const yMax = Math.max(...yVals)

    const xPad = (xMax - xMin) * 0.1 || 1
    const yPad = (yMax - yMin) * 0.1 || 1

    const plotW = WIDTH - MARGIN.left - MARGIN.right
    const plotH = HEIGHT - MARGIN.top - MARGIN.bottom

    const xFlip = xOpt?.lowerBetter
    const yFlip = yOpt?.lowerBetter

    const xScale = (v) => {
      const ratio = (v - (xMin - xPad)) / ((xMax + xPad) - (xMin - xPad))
      return MARGIN.left + (xFlip ? (1 - ratio) : ratio) * plotW
    }
    const yScale = (v) => {
      const ratio = (v - (yMin - yPad)) / ((yMax + yPad) - (yMin - yPad))
      return MARGIN.top + (yFlip ? ratio : (1 - ratio)) * plotH
    }

    const makeTicks = (min, max, count = 5) => {
      const step = (max - min) / (count - 1)
      return Array.from({ length: count }, (_, i) => {
        const v = min + step * i
        return Math.round(v * 1000) / 1000
      })
    }

    return {
      xScale,
      yScale,
      xTicks: makeTicks(xMin, xMax),
      yTicks: makeTicks(yMin, yMax),
    }
  }, [points, xOpt, yOpt])

  // Compute percentiles for each point + zone thresholds
  const { pointPerf, zoneThresholds } = useMemo(() => {
    if (!points.length) return { pointPerf: {}, zoneThresholds: null }

    const xVals = points.map(p => p.x).sort((a, b) => a - b)
    const yVals = points.map(p => p.y).sort((a, b) => a - b)
    const xLower = xOpt?.lowerBetter || false
    const yLower = yOpt?.lowerBetter || false

    const perf = {}
    points.forEach(pt => {
      perf[pt.team_id] = {
        xPerf: perfPercentile(xVals, pt.x, xLower),
        yPerf: perfPercentile(yVals, pt.y, yLower),
      }
    })

    const rawPercentile = (sortedArr, pct) => {
      const idx = Math.floor((pct / 100) * (sortedArr.length - 1))
      return sortedArr[Math.min(idx, sortedArr.length - 1)]
    }

    const x50 = rawPercentile(xVals, 50)
    const x10 = rawPercentile(xVals, xLower ? 10 : 90)
    const y50 = rawPercentile(yVals, 50)
    const y10 = rawPercentile(yVals, yLower ? 10 : 90)

    const xBest = xLower ? xVals[0] : xVals[xVals.length - 1]
    const yBest = yLower ? yVals[0] : yVals[yVals.length - 1]

    return {
      pointPerf: perf,
      zoneThresholds: { x50, x10, y50, y10, xBest, yBest },
    }
  }, [points, xOpt, yOpt])

  // Pearson correlation coefficient (r) and trend line
  const { r, rLabel, trendLine } = useMemo(() => {
    if (points.length < 3) return { r: null, rLabel: '', trendLine: null }

    const n = points.length
    const xs = points.map(p => p.x)
    const ys = points.map(p => p.y)
    const sumX = xs.reduce((a, b) => a + b, 0)
    const sumY = ys.reduce((a, b) => a + b, 0)
    const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0)
    const sumX2 = xs.reduce((a, x) => a + x * x, 0)
    const sumY2 = ys.reduce((a, y) => a + y * y, 0)

    const num = n * sumXY - sumX * sumY
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY))
    const rVal = den === 0 ? 0 : num / den

    // Strength label
    const absR = Math.abs(rVal)
    let strength = 'No'
    if (absR >= 0.7) strength = 'Strong'
    else if (absR >= 0.4) strength = 'Moderate'
    else if (absR >= 0.2) strength = 'Weak'

    const dir = rVal >= 0 ? 'positive' : 'negative'
    const label = `r = ${rVal >= 0 ? '' : ''}${rVal.toFixed(3)} (${strength} ${dir})`

    // Linear regression for trend line: y = mx + b
    const m = den === 0 ? 0 : num / (n * sumX2 - sumX * sumX)
    const b = (sumY - m * sumX) / n
    const xMin = Math.min(...xs)
    const xMax = Math.max(...xs)

    return {
      r: rVal,
      rLabel: label,
      trendLine: { x1: xMin, y1: m * xMin + b, x2: xMax, y2: m * xMax + b },
    }
  }, [points])

  const plotW = WIDTH - MARGIN.left - MARGIN.right
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom

  // Build subtitle for the chart header
  const divLabel = divisionId
    ? divisions.find(d => d.id === divisionId)?.name || ''
    : 'All Divisions'

  // Select component
  const Select = ({ label, value, onChange, children }) => (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">{label}</label>
      <select
        value={value}
        onChange={onChange}
        className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-pnw-sky/40 focus:border-pnw-sky transition-all"
      >
        {children}
      </select>
    </div>
  )

  return (
    <div>
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-pnw-slate">Team Scatter Plot</h1>
        <p className="text-sm text-gray-400 mt-0.5">Compare team performance across any two stats · 2026 Season</p>
      </div>

      {/* Controls bar */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-4 mb-5">
        <div className="flex flex-wrap gap-4 items-end">
          <Select label="X-Axis" value={xStat} onChange={(e) => setXStat(e.target.value)}>
            {['Record', 'Batting', 'Pitching', 'Overall'].map(group => (
              <optgroup key={group} label={group}>
                {STAT_OPTIONS.filter(s => s.group === group).map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </optgroup>
            ))}
          </Select>

          <Select label="Y-Axis" value={yStat} onChange={(e) => setYStat(e.target.value)}>
            {['Record', 'Batting', 'Pitching', 'Overall'].map(group => (
              <optgroup key={group} label={group}>
                {STAT_OPTIONS.filter(s => s.group === group).map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </optgroup>
            ))}
          </Select>

          <Select label="Division" value={divisionId || ''} onChange={(e) => setDivisionId(e.target.value ? parseInt(e.target.value) : null)}>
            <option value="">All Divisions</option>
            {divisions.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </Select>

          {points.length > 0 && (
            <button
              onClick={handleSaveImage}
              className="ml-auto flex items-center gap-1.5 px-4 py-2 rounded-lg bg-pnw-green text-white text-sm font-semibold hover:bg-pnw-forest shadow-sm transition-all active:scale-95"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Save Image
            </button>
          )}
        </div>

        {(xOpt?.lowerBetter || yOpt?.lowerBetter) && (
          <div className="text-[11px] text-gray-400 mt-3 italic">
            {xOpt?.lowerBetter && `${xOpt.label} axis is flipped (lower = better → right). `}
            {yOpt?.lowerBetter && `${yOpt.label} axis is flipped (lower = better → top).`}
          </div>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-pnw-green border-t-transparent rounded-full animate-spin" />
          <span className="ml-3 text-gray-400 text-sm">Loading data...</span>
        </div>
      )}

      {!loading && points.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-3 sm:p-5 overflow-x-auto">
          <svg ref={svgRef} width={WIDTH} height={HEIGHT} className="mx-auto block" xmlns="http://www.w3.org/2000/svg"
               style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
            <defs>
              {/* Performance gradient */}
              <linearGradient id="perfGradient" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0%" stopColor="#fca5a5" stopOpacity="0.30" />
                <stop offset="45%" stopColor="#fde68a" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#86efac" stopOpacity="0.30" />
              </linearGradient>
              {/* Drop shadow for tooltips */}
              <filter id="tooltipShadow" x="-10%" y="-10%" width="130%" height="130%">
                <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.12" />
              </filter>
            </defs>

            {/* ── Branded header bar ── */}
            <rect x={0} y={0} width={WIDTH} height={HEADER_H} fill={BRAND.teal} rx={0} />
            <text x={20} y={32} fontSize={18} fontWeight="700" fill="white" letterSpacing="0.5">
              NW BASEBALL STATS
            </text>
            <text x={WIDTH - 20} y={28} fontSize={11} fill="rgba(255,255,255,0.7)" textAnchor="end">
              {xOpt?.label} vs {yOpt?.label}
            </text>
            <text x={WIDTH - 20} y={42} fontSize={10} fill="rgba(255,255,255,0.5)" textAnchor="end">
              {divLabel} · 2026 Season
            </text>

            {/* ── Plot background ── */}
            <rect x={MARGIN.left} y={MARGIN.top}
                  width={plotW} height={plotH}
                  fill="url(#perfGradient)" rx={4} />

            {/* ── Grid lines ── */}
            {xTicks.map((v, i) => (
              <line key={`xg-${i}`} x1={xScale(v)} x2={xScale(v)}
                    y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom}
                    stroke="rgba(255,255,255,0.6)" strokeWidth={1} />
            ))}
            {yTicks.map((v, i) => (
              <line key={`yg-${i}`} x1={MARGIN.left} x2={WIDTH - MARGIN.right}
                    y1={yScale(v)} y2={yScale(v)}
                    stroke="rgba(255,255,255,0.6)" strokeWidth={1} />
            ))}

            {/* ── Axes ── */}
            <line x1={MARGIN.left} x2={WIDTH - MARGIN.right}
                  y1={HEIGHT - MARGIN.bottom} y2={HEIGHT - MARGIN.bottom}
                  stroke="#94a3b8" strokeWidth={1.5} />
            <line x1={MARGIN.left} x2={MARGIN.left}
                  y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom}
                  stroke="#94a3b8" strokeWidth={1.5} />

            {/* ── X-axis ticks & labels ── */}
            {xTicks.map((v, i) => (
              <g key={`xt-${i}`}>
                <line x1={xScale(v)} x2={xScale(v)}
                      y1={HEIGHT - MARGIN.bottom} y2={HEIGHT - MARGIN.bottom + 5}
                      stroke="#94a3b8" strokeWidth={1} />
                <text x={xScale(v)} y={HEIGHT - MARGIN.bottom + 18}
                      textAnchor="middle" fontSize={10} fill="#64748b" fontWeight="500">
                  {typeof v === 'number' && v < 1 && v > 0 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : Math.round(v)}
                </text>
              </g>
            ))}

            {/* ── Y-axis ticks & labels ── */}
            {yTicks.map((v, i) => (
              <g key={`yt-${i}`}>
                <line x1={MARGIN.left - 5} x2={MARGIN.left}
                      y1={yScale(v)} y2={yScale(v)}
                      stroke="#94a3b8" strokeWidth={1} />
                <text x={MARGIN.left - 10} y={yScale(v) + 4}
                      textAnchor="end" fontSize={10} fill="#64748b" fontWeight="500">
                  {typeof v === 'number' && v < 1 && v > 0 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : Math.round(v)}
                </text>
              </g>
            ))}

            {/* ── Axis labels ── */}
            <text x={MARGIN.left + plotW / 2} y={HEIGHT - MARGIN.bottom + 38}
                  textAnchor="middle" fontSize={12} fontWeight="700" fill="#334155">
              {xOpt?.label || xStat}
              <tspan fontSize={10} fontWeight="400" fill="#94a3b8">
                {xOpt?.lowerBetter ? '  ← Better' : '  Better →'}
              </tspan>
            </text>
            <text x={18} y={MARGIN.top + plotH / 2} textAnchor="middle" fontSize={12}
                  fontWeight="700" fill="#334155"
                  transform={`rotate(-90, 18, ${MARGIN.top + plotH / 2})`}>
              {yOpt?.label || yStat}
              <tspan fontSize={10} fontWeight="400" fill="#94a3b8">
                {yOpt?.lowerBetter ? '' : '  ↑ Better'}
              </tspan>
            </text>

            {/* ── Percentile zone boxes ── */}
            {zoneThresholds && (() => {
              const x50px = xScale(zoneThresholds.x50)
              const y50px = yScale(zoneThresholds.y50)
              const x10px = xScale(zoneThresholds.x10)
              const y10px = yScale(zoneThresholds.y10)

              const PAD = 20
              const xBestPx = xScale(zoneThresholds.xBest) + PAD
              const yBestPx = yScale(zoneThresholds.yBest) - PAD

              const clampX = (v) => Math.max(MARGIN.left, Math.min(v, WIDTH - MARGIN.right))
              const clampY = (v) => Math.max(MARGIN.top, Math.min(v, HEIGHT - MARGIN.bottom))

              const cxBest = clampX(xBestPx)
              const cyBest = clampY(yBestPx)

              return (
                <>
                  <rect
                    x={Math.min(x50px, cxBest)} y={Math.min(y50px, cyBest)}
                    width={Math.abs(cxBest - x50px)} height={Math.abs(y50px - cyBest)}
                    fill="none" stroke="#059669" strokeWidth={1.5}
                    strokeDasharray="8,4" opacity={0.4} rx={4}
                  />
                  <rect
                    x={Math.min(x10px, cxBest)} y={Math.min(y10px, cyBest)}
                    width={Math.abs(cxBest - x10px)} height={Math.abs(y10px - cyBest)}
                    fill="#059669" fillOpacity={0.05}
                    stroke="#059669" strokeWidth={2}
                    strokeDasharray="6,3" opacity={0.6} rx={4}
                  />
                </>
              )
            })()}

            {/* ── Trend line ── */}
            {trendLine && xScale && yScale && (() => {
              const x1px = xScale(trendLine.x1)
              const y1px = yScale(trendLine.y1)
              const x2px = xScale(trendLine.x2)
              const y2px = yScale(trendLine.y2)
              // Clamp to plot area
              const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
              return (
                <line
                  x1={clamp(x1px, MARGIN.left, MARGIN.left + plotW)}
                  y1={clamp(y1px, MARGIN.top, MARGIN.top + plotH)}
                  x2={clamp(x2px, MARGIN.left, MARGIN.left + plotW)}
                  y2={clamp(y2px, MARGIN.top, MARGIN.top + plotH)}
                  stroke={BRAND.teal} strokeWidth={2}
                  strokeDasharray="8,4" opacity={0.5}
                />
              )
            })()}

            {/* ── Data points ── */}
            {points.map(pt => {
              const cx = xScale(pt.x)
              const cy = yScale(pt.y)
              const isHovered = hoveredTeam === pt.team_id
              const perf = pointPerf[pt.team_id]
              const color = perf ? getDotColor(perf.xPerf, perf.yPerf) : '#6b7280'

              return (
                <g key={pt.team_id}
                   onMouseEnter={() => setHoveredTeam(pt.team_id)}
                   onMouseLeave={() => setHoveredTeam(null)}
                   style={{ cursor: 'pointer' }}>
                  {/* Outer glow on hover */}
                  {isHovered && (
                    <circle cx={cx} cy={cy} r={23} fill="none"
                            stroke={color} strokeWidth={1.5} opacity={0.3} />
                  )}
                  {/* Background circle */}
                  <circle cx={cx} cy={cy} r={isHovered ? 18 : 15}
                          fill="white" stroke={color}
                          strokeWidth={isHovered ? 2.5 : 1.5}
                          opacity={isHovered ? 1 : 0.92} />

                  {/* Team logo or abbreviation */}
                  {pt.logo_url ? (
                    <image href={pt.logo_url} x={cx - 10} y={cy - 10}
                           width={20} height={20}
                           style={{ pointerEvents: 'none' }} />
                  ) : (
                    <text x={cx} y={cy + 3} textAnchor="middle" fontSize={7}
                          fontWeight="bold" fill={color}
                          style={{ pointerEvents: 'none' }}>
                      {pt.short_name}
                    </text>
                  )}

                  {/* Hover tooltip */}
                  {isHovered && (
                    <g>
                      <rect x={cx + 24} y={cy - 34} width={170} height={64}
                            rx={8} fill="white" stroke="#e2e8f0" strokeWidth={1}
                            filter="url(#tooltipShadow)" />
                      {/* Accent bar */}
                      <rect x={cx + 24} y={cy - 34} width={4} height={64}
                            rx={2} fill={BRAND.teal} />
                      <text x={cx + 36} y={cy - 16} fontSize={12} fontWeight="700" fill="#1e293b">
                        {pt.name}
                      </text>
                      <text x={cx + 36} y={cy - 2} fontSize={10} fill="#64748b">
                        {pt.division_level} · {pt.conference_abbrev}
                      </text>
                      <text x={cx + 36} y={cy + 14} fontSize={9} fill="#94a3b8" fontFamily="monospace">
                        {xOpt?.label}: {pt.x}
                      </text>
                      <text x={cx + 36} y={cy + 24} fontSize={9} fill="#94a3b8" fontFamily="monospace">
                        {yOpt?.label}: {pt.y}
                      </text>
                    </g>
                  )}
                </g>
              )
            })}

            {/* ── Footer watermark ── */}
            <rect x={0} y={HEIGHT - FOOTER_H} width={WIDTH} height={FOOTER_H} fill="#f8fafc" />
            <line x1={0} x2={WIDTH} y1={HEIGHT - FOOTER_H} y2={HEIGHT - FOOTER_H} stroke="#e2e8f0" strokeWidth={1} />
            <text x={20} y={HEIGHT - 10} fontSize={9} fill="#94a3b8" fontWeight="600">
              nwbaseballstats.com
            </text>
            <text x={WIDTH - 20} y={HEIGHT - 10} fontSize={9} fill="#cbd5e1" textAnchor="end">
              {points.length} teams · Data updated 2026
            </text>

            {/* ── Correlation badge ── */}
            {r !== null && (
              <g>
                <rect x={MARGIN.left + 8} y={MARGIN.top + 6} width={rLabel.length * 6.5 + 16} height={22}
                      rx={4} fill="white" stroke="#e2e8f0" strokeWidth={1} opacity={0.95} />
                <text x={MARGIN.left + 16} y={MARGIN.top + 21} fontSize={11}
                      fontWeight="600" fill={Math.abs(r) >= 0.4 ? BRAND.teal : '#6b7280'}>
                  {rLabel}
                </text>
              </g>
            )}
          </svg>

          {/* Legend below the chart */}
          <div className="flex flex-wrap justify-center gap-5 mt-4 pt-3 border-t border-gray-100 text-xs text-gray-500">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#059669', border: '1.5px solid #059669' }} />
              <span>Top 25th pctl (both axes)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#ca8a04', border: '1.5px solid #ca8a04' }} />
              <span>Middle</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#dc2626', border: '1.5px solid #dc2626' }} />
              <span>Bottom 25th pctl (both axes)</span>
            </div>
            <div className="flex items-center gap-1.5 ml-3 pl-3 border-l border-gray-200">
              <div className="w-4 h-3 border border-dashed rounded" style={{ borderColor: '#059669' }} />
              <span>Top 50% zone</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-3 border-2 border-dashed rounded" style={{ borderColor: '#059669', backgroundColor: 'rgba(5,150,105,0.05)' }} />
              <span>Top 10% zone</span>
            </div>
            <div className="flex items-center gap-1.5 ml-3 pl-3 border-l border-gray-200">
              <div className="w-5 h-0 border-t-2 border-dashed" style={{ borderColor: BRAND.teal }} />
              <span>Trend line</span>
            </div>
          </div>
        </div>
      )}

      {!loading && points.length === 0 && (
        <div className="text-center py-16">
          <div className="text-gray-300 text-4xl mb-2">&#9898;</div>
          <div className="text-gray-400 text-sm">No data available for the selected options.</div>
        </div>
      )}

      <StatsLastUpdated className="mt-4" />
    </div>
  )
}
