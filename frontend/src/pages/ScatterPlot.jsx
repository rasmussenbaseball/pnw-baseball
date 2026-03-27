import { useState, useEffect, useMemo } from 'react'
import { divisionBadgeClass } from '../utils/stats'

const API_BASE = '/api/v1'

const STAT_OPTIONS = [
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
  { value: 'total_pwar', label: 'Pitching WAR', group: 'Pitching' },
  // Combined
  { value: 'total_war', label: 'Total WAR', group: 'Overall' },
]

const DIVISION_COLORS = {
  'D1': '#1e40af',
  'D2': '#059669',
  'D3': '#d97706',
  'NAIA': '#7c3aed',
  'JUCO': '#dc2626',
}

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
  if (xPerf >= 75 && yPerf >= 75) return '#16a34a'  // green - top 25th in both
  if (xPerf <= 25 && yPerf <= 25) return '#dc2626'  // red - bottom 25th in both
  return '#ca8a04' // yellow/gold - everything else
}

const MARGIN = { top: 30, right: 30, bottom: 50, left: 60 }
const WIDTH = 700
const HEIGHT = 500

export default function ScatterPlot() {
  const [xStat, setXStat] = useState('team_avg')
  const [yStat, setYStat] = useState('team_era')
  const [divisionId, setDivisionId] = useState(null)
  const [divisions, setDivisions] = useState([])
  const [points, setPoints] = useState([])
  const [loading, setLoading] = useState(false)
  const [hoveredTeam, setHoveredTeam] = useState(null)

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

    // For "lower is better" stats, flip: higher raw value maps to LEFT/BOTTOM
    const xFlip = xOpt?.lowerBetter
    const yFlip = yOpt?.lowerBetter

    const xScale = (v) => {
      const ratio = (v - (xMin - xPad)) / ((xMax + xPad) - (xMin - xPad))
      return MARGIN.left + (xFlip ? (1 - ratio) : ratio) * plotW
    }
    const yScale = (v) => {
      const ratio = (v - (yMin - yPad)) / ((yMax + yPad) - (yMin - yPad))
      // SVG y increases downward, so invert; also handle "lower is better" flip
      return MARGIN.top + (yFlip ? ratio : (1 - ratio)) * plotH
    }

    // Generate ~5 tick values for each axis
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

    // Performance percentile per team
    const perf = {}
    points.forEach(pt => {
      perf[pt.team_id] = {
        xPerf: perfPercentile(xVals, pt.x, xLower),
        yPerf: perfPercentile(yVals, pt.y, yLower),
      }
    })

    // Zone thresholds: find raw values at given performance percentile cutoffs
    // For "top Nth percentile in both", we need the raw value where perf >= (100 - N)
    // That means: for normal stats, the value at the (100 - N)th raw percentile
    //             for lowerBetter stats, the value at the Nth raw percentile
    const rawPercentile = (sortedArr, pct) => {
      const idx = Math.floor((pct / 100) * (sortedArr.length - 1))
      return sortedArr[Math.min(idx, sortedArr.length - 1)]
    }

    // Top 33rd: performance >= 67  →  raw percentile 67 (normal) or 33 (lowerBetter)
    // Top 10th: performance >= 90  →  raw percentile 90 (normal) or 10 (lowerBetter)
    const x33 = rawPercentile(xVals, xLower ? 33 : 67)
    const x10 = rawPercentile(xVals, xLower ? 10 : 90)
    const y33 = rawPercentile(yVals, yLower ? 33 : 67)
    const y10 = rawPercentile(yVals, yLower ? 10 : 90)

    // Best raw values (the 100th percentile edge for zones)
    // For normal stats, best = max; for lowerBetter, best = min
    const xBest = xLower ? xVals[0] : xVals[xVals.length - 1]
    const yBest = yLower ? yVals[0] : yVals[yVals.length - 1]

    return {
      pointPerf: perf,
      zoneThresholds: { x33, x10, y33, y10, xBest, yBest },
    }
  }, [points, xOpt, yOpt])

  const plotW = WIDTH - MARGIN.left - MARGIN.right
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-4">Team Scatter Plot</h1>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 mb-6 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">X-Axis</label>
          <select
            value={xStat}
            onChange={(e) => setXStat(e.target.value)}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            {['Batting', 'Pitching', 'Overall'].map(group => (
              <optgroup key={group} label={group}>
                {STAT_OPTIONS.filter(s => s.group === group).map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Y-Axis</label>
          <select
            value={yStat}
            onChange={(e) => setYStat(e.target.value)}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            {['Batting', 'Pitching', 'Overall'].map(group => (
              <optgroup key={group} label={group}>
                {STAT_OPTIONS.filter(s => s.group === group).map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Division</label>
          <select
            value={divisionId || ''}
            onChange={(e) => setDivisionId(e.target.value ? parseInt(e.target.value) : null)}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            <option value="">All Divisions</option>
            {divisions.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      </div>

      {(xOpt?.lowerBetter || yOpt?.lowerBetter) && (
        <div className="text-xs text-gray-400 mb-3 italic">
          {xOpt?.lowerBetter && `${xOpt.label} axis is flipped (lower = better → right). `}
          {yOpt?.lowerBetter && `${yOpt.label} axis is flipped (lower = better → top).`}
        </div>
      )}

      {loading && <div className="text-gray-400 animate-pulse">Loading...</div>}

      {!loading && points.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border p-4 overflow-x-auto">
          <svg width={WIDTH} height={HEIGHT} className="mx-auto">
            {/* Grid lines */}
            {xTicks.map((v, i) => (
              <line key={`xg-${i}`} x1={xScale(v)} x2={xScale(v)}
                    y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom}
                    stroke="#e5e7eb" strokeWidth={1} />
            ))}
            {yTicks.map((v, i) => (
              <line key={`yg-${i}`} x1={MARGIN.left} x2={WIDTH - MARGIN.right}
                    y1={yScale(v)} y2={yScale(v)}
                    stroke="#e5e7eb" strokeWidth={1} />
            ))}

            {/* Axes */}
            <line x1={MARGIN.left} x2={WIDTH - MARGIN.right}
                  y1={HEIGHT - MARGIN.bottom} y2={HEIGHT - MARGIN.bottom}
                  stroke="#9ca3af" strokeWidth={1} />
            <line x1={MARGIN.left} x2={MARGIN.left}
                  y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom}
                  stroke="#9ca3af" strokeWidth={1} />

            {/* X-axis ticks & labels */}
            {xTicks.map((v, i) => (
              <text key={`xt-${i}`} x={xScale(v)} y={HEIGHT - MARGIN.bottom + 18}
                    textAnchor="middle" fontSize={10} fill="#6b7280">
                {typeof v === 'number' && v < 1 && v > 0 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : Math.round(v)}
              </text>
            ))}

            {/* Y-axis ticks & labels */}
            {yTicks.map((v, i) => (
              <text key={`yt-${i}`} x={MARGIN.left - 8} y={yScale(v) + 3}
                    textAnchor="end" fontSize={10} fill="#6b7280">
                {typeof v === 'number' && v < 1 && v > 0 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : Math.round(v)}
              </text>
            ))}

            {/* Axis labels */}
            <text x={WIDTH / 2} y={HEIGHT - 5} textAnchor="middle" fontSize={12}
                  fontWeight="600" fill="#374151">
              {xOpt?.label || xStat} {xOpt?.lowerBetter ? '← Better' : '→ Better'}
            </text>
            <text x={15} y={HEIGHT / 2} textAnchor="middle" fontSize={12}
                  fontWeight="600" fill="#374151"
                  transform={`rotate(-90, 15, ${HEIGHT / 2})`}>
              {yOpt?.label || yStat} {yOpt?.lowerBetter ? '' : '↑ Better'}
            </text>

            {/* "Better" arrow in top-right */}
            <text x={WIDTH - MARGIN.right - 5} y={MARGIN.top + 15}
                  textAnchor="end" fontSize={10} fill="#059669" fontWeight="bold">
              ★ Better
            </text>

            {/* Percentile zone boxes */}
            {zoneThresholds && (() => {
              const xFlip = xOpt?.lowerBetter
              const yFlip = yOpt?.lowerBetter

              // Top 33rd zone: from threshold to the "better" edge
              // For normal stats, better = higher raw value (right/top of plot)
              // For lowerBetter, better = lower raw value (also right/top after flip)
              // So the zone always extends from the threshold pixel toward the top-right corner
              const x33px = xScale(zoneThresholds.x33)
              const y33px = yScale(zoneThresholds.y33)
              const x10px = xScale(zoneThresholds.x10)
              const y10px = yScale(zoneThresholds.y10)

              // Use the best data point values as the zone edges, plus padding
              // so the best team's logo circle fits fully inside the box
              const PAD = 20 // roughly the circle radius
              const xBestPx = xScale(zoneThresholds.xBest) + PAD
              const yBestPx = yScale(zoneThresholds.yBest) - PAD

              // Clamp to plot area so boxes don't overflow
              const clampX = (v) => Math.max(MARGIN.left, Math.min(v, WIDTH - MARGIN.right))
              const clampY = (v) => Math.max(MARGIN.top, Math.min(v, HEIGHT - MARGIN.bottom))

              const cxBest = clampX(xBestPx)
              const cyBest = clampY(yBestPx)

              return (
                <>
                  {/* Top 33rd percentile zone */}
                  <rect
                    x={Math.min(x33px, cxBest)} y={Math.min(y33px, cyBest)}
                    width={Math.abs(cxBest - x33px)} height={Math.abs(y33px - cyBest)}
                    fill="none" stroke="#16a34a" strokeWidth={1.5}
                    strokeDasharray="6,3" opacity={0.5} rx={3}
                  />
                  <text x={Math.min(x33px, cxBest) + 4} y={Math.min(y33px, cyBest) + 12} fontSize={9}
                        fill="#16a34a" opacity={0.7} fontWeight="600">
                    Top 33%
                  </text>

                  {/* Top 10th percentile zone */}
                  <rect
                    x={Math.min(x10px, cxBest)} y={Math.min(y10px, cyBest)}
                    width={Math.abs(cxBest - x10px)} height={Math.abs(y10px - cyBest)}
                    fill="#16a34a" fillOpacity={0.04}
                    stroke="#16a34a" strokeWidth={2}
                    strokeDasharray="4,2" opacity={0.7} rx={3}
                  />
                  <text x={Math.min(x10px, cxBest) + 4} y={Math.min(y10px, cyBest) + 14} fontSize={9}
                        fill="#16a34a" opacity={0.9} fontWeight="700">
                    Top 10%
                  </text>
                </>
              )
            })()}

            {/* Data points */}
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
                  {/* Background circle */}
                  <circle cx={cx} cy={cy} r={isHovered ? 20 : 16}
                          fill="white" stroke={color} strokeWidth={isHovered ? 2.5 : 1.5}
                          opacity={isHovered ? 1 : 0.9} />

                  {/* Team logo or abbreviation */}
                  {pt.logo_url ? (
                    <image href={pt.logo_url} x={cx - 10} y={cy - 10}
                           width={20} height={20}
                           style={{ pointerEvents: 'none' }} />
                  ) : (
                    <text x={cx} y={cy + 3} textAnchor="middle" fontSize={8}
                          fontWeight="bold" fill={color}
                          style={{ pointerEvents: 'none' }}>
                      {pt.short_name}
                    </text>
                  )}

                  {/* Hover tooltip */}
                  {isHovered && (
                    <>
                      <rect x={cx + 22} y={cy - 28} width={140} height={52}
                            rx={4} fill="white" stroke="#e5e7eb" strokeWidth={1}
                            filter="drop-shadow(0 1px 3px rgba(0,0,0,0.1))" />
                      <text x={cx + 28} y={cy - 12} fontSize={11} fontWeight="bold" fill="#1f2937">
                        {pt.name}
                      </text>
                      <text x={cx + 28} y={cy + 2} fontSize={10} fill="#6b7280">
                        {pt.division_level} · {pt.conference_abbrev}
                      </text>
                      <text x={cx + 28} y={cy + 16} fontSize={10} fill="#374151" fontFamily="monospace">
                        x: {pt.x}  y: {pt.y}
                      </text>
                    </>
                  )}
                </g>
              )
            })}
          </svg>

          {/* Legend */}
          <div className="flex flex-wrap justify-center gap-4 mt-4 text-xs">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full border" style={{ backgroundColor: '#16a34a' }} />
              <span className="text-gray-600">Top 25th pctl (both axes)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full border" style={{ backgroundColor: '#ca8a04' }} />
              <span className="text-gray-600">Middle</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full border" style={{ backgroundColor: '#dc2626' }} />
              <span className="text-gray-600">Bottom 25th pctl (both axes)</span>
            </div>
            <div className="flex items-center gap-1.5 ml-4 pl-4 border-l border-gray-200">
              <div className="w-4 h-3 border border-dashed rounded-sm" style={{ borderColor: '#16a34a' }} />
              <span className="text-gray-600">Top 33% zone</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-3 border-2 border-dashed rounded-sm" style={{ borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.04)' }} />
              <span className="text-gray-600">Top 10% zone</span>
            </div>
          </div>
        </div>
      )}

      {!loading && points.length === 0 && (
        <div className="text-gray-400 text-sm italic mt-4">No data available for the selected options.</div>
      )}
    </div>
  )
}
