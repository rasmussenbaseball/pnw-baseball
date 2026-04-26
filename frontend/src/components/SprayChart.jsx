import { useState, useMemo } from 'react'

/**
 * Statcast-style spray chart for a hitter (or opponent contact for a
 * pitcher). 9 wedges fan out from home plate:
 *   Outfield arc (5):  LF / LC / CF / RC / RF
 *   Infield ring  (4): 3B / SS / MID / 1B
 *
 * IF_C (catcher foul pops) is folded into IF_MID for the visual since
 * those are foul-territory balls that don't sit cleanly on the fan.
 *
 * Props:
 *   data      — { all: {ZONE: count}, vs_lhp, vs_rhp, all_total, ... }
 *   bats      — 'L' / 'R' / 'S' (used for orientation hint, not rotation)
 *   defaultFilter — 'all' / 'vs_lhp' / 'vs_rhp'
 */

const SHADES = [
  '#f5f5f5',  // 0%
  '#e8f5e8',  // very low
  '#c8e6c9',
  '#a5d6a7',
  '#81c784',
  '#66bb6a',
  '#4caf50',
  '#388e3c',
  '#2e7d32',
  '#1b5e20',  // peak
]

function shadeFor(pct, peak) {
  if (peak <= 0 || !pct) return SHADES[0]
  const idx = Math.min(SHADES.length - 1,
                       Math.max(0, Math.round((pct / peak) * (SHADES.length - 1))))
  return SHADES[idx]
}

// Build an SVG <path> for a circular wedge between two angles + two radii.
// Angles in degrees, measured from straight-up (12 o'clock) clockwise.
// (cx, cy) is the wedge apex (home plate).
function wedgePath(cx, cy, r1, r2, angStart, angEnd) {
  // Convert to math angles (0 = right, ccw positive)
  const a1 = (angStart - 90) * Math.PI / 180
  const a2 = (angEnd - 90) * Math.PI / 180
  const x1in = cx + r1 * Math.cos(a1)
  const y1in = cy + r1 * Math.sin(a1)
  const x1ot = cx + r2 * Math.cos(a1)
  const y1ot = cy + r2 * Math.sin(a1)
  const x2in = cx + r1 * Math.cos(a2)
  const y2in = cy + r1 * Math.sin(a2)
  const x2ot = cx + r2 * Math.cos(a2)
  const y2ot = cy + r2 * Math.sin(a2)
  const large = Math.abs(angEnd - angStart) > 180 ? 1 : 0
  return [
    `M ${x1in} ${y1in}`,
    `L ${x1ot} ${y1ot}`,
    `A ${r2} ${r2} 0 ${large} 1 ${x2ot} ${y2ot}`,
    `L ${x2in} ${y2in}`,
    `A ${r1} ${r1} 0 ${large} 0 ${x1in} ${y1in}`,
    'Z',
  ].join(' ')
}

// Compute centroid for placing the percentage label
function wedgeLabelPos(cx, cy, r1, r2, angStart, angEnd) {
  const aMid = ((angStart + angEnd) / 2 - 90) * Math.PI / 180
  const rMid = (r1 + r2) / 2
  return [cx + rMid * Math.cos(aMid), cy + rMid * Math.sin(aMid)]
}

// 9-wedge layout. Foul lines = -45° to +45° from straight-up.
//   OF arc:  -45° to +45°, 5 wedges of 18° each (LF on left for the viewer)
//   IF ring: same -45° to +45°, 4 wedges of 22.5° each
const FAN_HALF_ANGLE = 45  // degrees from straight up

// Outfield zones: order from left (-45°) to right (+45°)
const OF_ZONES = ['LF', 'LC', 'CF', 'RC', 'RF']
// Infield zones: order from left (-45°) to right (+45°)
const IF_ZONES = ['IF_3B', 'IF_SS', 'IF_MID', 'IF_1B']

const ZONE_LABEL = {
  LF: 'LF', LC: 'LC', CF: 'CF', RC: 'RC', RF: 'RF',
  IF_3B: '3B', IF_SS: 'SS', IF_MID: 'MID', IF_1B: '1B',
}

export default function SprayChart({ data, bats, defaultFilter = 'all' }) {
  const [filter, setFilter] = useState(defaultFilter)

  const counts = data?.[filter] || {}
  const total = data?.[`${filter}_total`] || 0

  // Fold IF_C into IF_MID for visual purposes
  const if_c = counts.IF_C || 0
  const display = useMemo(() => {
    const out = { ...counts }
    out.IF_MID = (out.IF_MID || 0) + if_c
    return out
  }, [counts, if_c])

  // Compute peak for color scaling (use the larger of either ring's max)
  const peakOF = Math.max(...OF_ZONES.map(z => display[z] || 0))
  const peakIF = Math.max(...IF_ZONES.map(z => display[z] || 0))
  const peak = Math.max(peakOF, peakIF)

  // Geometry — chart is 500 wide, 360 tall
  const W = 500, H = 360
  const HOME = { x: W / 2, y: H - 20 }
  const R_HOME = 12       // small "home plate" inner radius
  const R_INF_OUT = 150   // infield outer radius (= OF inner)
  const R_OF_OUT = 290    // outfield outer radius

  // Wedge angle ranges
  const ofWedge = (FAN_HALF_ANGLE * 2) / OF_ZONES.length
  const ifWedge = (FAN_HALF_ANGLE * 2) / IF_ZONES.length

  function ofAngles(i) {
    return [
      -FAN_HALF_ANGLE + i * ofWedge,
      -FAN_HALF_ANGLE + (i + 1) * ofWedge,
    ]
  }
  function ifAngles(i) {
    return [
      -FAN_HALF_ANGLE + i * ifWedge,
      -FAN_HALF_ANGLE + (i + 1) * ifWedge,
    ]
  }

  return (
    <div className="bg-white rounded-md border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-800">Spray Chart</h3>
        <div className="flex items-center gap-1 text-[11px]">
          {[
            ['all',    'All'],
            ['vs_rhp', 'vs RHP'],
            ['vs_lhp', 'vs LHP'],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`px-2 py-0.5 rounded font-medium ${
                filter === k
                  ? 'bg-gray-800 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" xmlns="http://www.w3.org/2000/svg">
          {/* Foul-line backdrop (white triangle behind everything) */}
          <path
            d={`M ${HOME.x} ${HOME.y}
                L ${HOME.x - R_OF_OUT * Math.cos((45 - 90) * Math.PI / 180) * -1} ${HOME.y + R_OF_OUT * Math.sin((45 - 90) * Math.PI / 180)}
                L ${HOME.x + R_OF_OUT * Math.cos((45 - 90) * Math.PI / 180) * -1} ${HOME.y + R_OF_OUT * Math.sin((45 - 90) * Math.PI / 180)} Z`}
            fill="white"
            stroke="#d4d4d4"
            strokeWidth="1.5"
          />

          {/* Outfield wedges (outer ring) */}
          {OF_ZONES.map((z, i) => {
            const [a1, a2] = ofAngles(i)
            const n = display[z] || 0
            const pct = total > 0 ? n / total : 0
            const fill = shadeFor(n, peak)
            const [lx, ly] = wedgeLabelPos(HOME.x, HOME.y, R_INF_OUT, R_OF_OUT, a1, a2)
            const pctText = total > 0 ? `${(pct * 100).toFixed(0)}%` : '—'
            return (
              <g key={`of-${z}`}>
                <path
                  d={wedgePath(HOME.x, HOME.y, R_INF_OUT, R_OF_OUT, a1, a2)}
                  fill={fill}
                  stroke="white"
                  strokeWidth="2"
                />
                {n > 0 && (
                  <text
                    x={lx} y={ly}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="fill-gray-900 font-bold"
                    style={{ fontSize: '14px', pointerEvents: 'none' }}
                  >
                    {pctText}
                  </text>
                )}
              </g>
            )
          })}

          {/* Infield wedges (inner ring) */}
          {IF_ZONES.map((z, i) => {
            const [a1, a2] = ifAngles(i)
            const n = display[z] || 0
            const pct = total > 0 ? n / total : 0
            const fill = shadeFor(n, peak)
            const [lx, ly] = wedgeLabelPos(HOME.x, HOME.y, R_HOME, R_INF_OUT, a1, a2)
            const pctText = total > 0 ? `${(pct * 100).toFixed(0)}%` : '—'
            return (
              <g key={`if-${z}`}>
                <path
                  d={wedgePath(HOME.x, HOME.y, R_HOME, R_INF_OUT, a1, a2)}
                  fill={fill}
                  stroke="white"
                  strokeWidth="2"
                />
                {n > 0 && (
                  <text
                    x={lx} y={ly}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="fill-gray-900 font-bold"
                    style={{ fontSize: '13px', pointerEvents: 'none' }}
                  >
                    {pctText}
                  </text>
                )}
              </g>
            )
          })}

          {/* Home plate marker */}
          <polygon
            points={`${HOME.x - 8},${HOME.y} ${HOME.x + 8},${HOME.y} ${HOME.x + 8},${HOME.y - 6} ${HOME.x},${HOME.y - 12} ${HOME.x - 8},${HOME.y - 6}`}
            fill="#9ca3af"
            stroke="#6b7280"
            strokeWidth="1"
          />

          {/* Bases (visual only) */}
          <circle cx={HOME.x - 70} cy={HOME.y - 100} r="3" fill="#9ca3af" />
          <circle cx={HOME.x}      cy={HOME.y - 130} r="3" fill="#9ca3af" />
          <circle cx={HOME.x + 70} cy={HOME.y - 100} r="3" fill="#9ca3af" />

          {/* Zone labels (small position markers above each wedge) */}
          {OF_ZONES.map((z, i) => {
            const [a1, a2] = ofAngles(i)
            const aMid = ((a1 + a2) / 2 - 90) * Math.PI / 180
            const r = R_OF_OUT + 14
            return (
              <text
                key={`lab-${z}`}
                x={HOME.x + r * Math.cos(aMid)}
                y={HOME.y + r * Math.sin(aMid)}
                textAnchor="middle"
                dominantBaseline="middle"
                className="fill-gray-500"
                style={{ fontSize: '11px' }}
              >
                {ZONE_LABEL[z]}
              </text>
            )
          })}

          {/* BIP badge */}
          <g transform={`translate(${W - 70}, 16)`}>
            <text x="0" y="0" textAnchor="end" className="fill-gray-500" style={{ fontSize: '10px', fontWeight: 600 }}>
              BIP
            </text>
            <text x="55" y="2" textAnchor="end" className="fill-gray-900" style={{ fontSize: '16px', fontWeight: 700 }}>
              {total}
            </text>
          </g>

          {/* Filter chip / batting hand badge */}
          <g transform="translate(16, 16)">
            <rect x="-4" y="-12" rx="4" ry="4" width="78" height="20" fill="#1f2937" />
            <text x="35" y="2" textAnchor="middle" className="fill-white" style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em' }}>
              {filter === 'all' ? 'ALL PITCHERS' : filter === 'vs_lhp' ? 'VS LHP' : 'VS RHP'}
            </text>
          </g>
        </svg>

        {/* Legend / handedness hint */}
        <div className="flex items-center justify-between mt-2 text-[10px] text-gray-500">
          <span>Pull side {bats === 'L' ? '→' : bats === 'R' ? '←' : ''} {bats === 'L' ? 'right' : bats === 'R' ? 'left' : '(switch)'}</span>
          <div className="flex items-center gap-1">
            <span>Less</span>
            {SHADES.slice(1).map((c, i) => (
              <span key={i} className="inline-block w-3 h-3 rounded" style={{ backgroundColor: c }} />
            ))}
            <span>More</span>
          </div>
        </div>
        {if_c > 0 && (
          <p className="text-[10px] text-gray-400 mt-1 italic">
            Note: {if_c} catcher foul-pop{if_c === 1 ? '' : 's'} folded into MID for the visual.
          </p>
        )}
      </div>
    </div>
  )
}
