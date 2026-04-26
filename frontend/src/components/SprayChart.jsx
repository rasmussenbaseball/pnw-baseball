import { useState, useMemo } from 'react'

/**
 * Statcast-style spray chart for a hitter.
 *
 * Layout:
 *   Outfield arc (3): LF / CF / RF — equal thirds across the fan.
 *                     LC + RC counts are folded into the adjacent OF
 *                     zone for visual cleanliness (sample is too thin
 *                     to render as separate gap wedges per player).
 *   Infield ring (4): 3B / SS / MID / 1B (catcher folds into MID).
 *
 * Filter chips: All Pitchers / vs RHP / vs LHP / XBH / HR.
 *
 * Outside the outfield fence: HR-percentage badges per OF third
 * (only shown when this player has at least one HR in the season).
 */

// NW Teal palette — light to dark
const SHADES = [
  '#f1f6f7',   // near-white
  '#dceef0',
  '#bee0e3',
  '#9dd0d6',
  '#73bcc6',
  '#48a8b6',
  '#1f95a6',
  '#008a9e',   // nw-teal-light
  '#00687a',   // nw-teal
  '#004d5a',   // nw-teal-dark
]

const TEXT_DARK_SHADES = new Set([6, 7, 8, 9])  // shade indexes where text should be white

function shadeIndex(pct, peak) {
  if (peak <= 0 || !pct) return 0
  return Math.min(SHADES.length - 1,
                  Math.max(0, Math.round((pct / peak) * (SHADES.length - 1))))
}

// Build SVG <path> for a circular wedge between two angles + two radii.
// Angles in degrees from straight-up (12 o'clock), clockwise.
function wedgePath(cx, cy, r1, r2, angStart, angEnd) {
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

function wedgeLabelPos(cx, cy, r1, r2, angStart, angEnd) {
  const aMid = ((angStart + angEnd) / 2 - 90) * Math.PI / 180
  const rMid = (r1 + r2) / 2
  return [cx + rMid * Math.cos(aMid), cy + rMid * Math.sin(aMid)]
}

const FAN_HALF_ANGLE = 45
const OF_ZONES = ['LF', 'CF', 'RF']
const IF_ZONES = ['IF_3B', 'IF_SS', 'IF_MID', 'IF_1B']
const ZONE_LABEL = {
  LF: 'LF', CF: 'CF', RF: 'RF',
  IF_3B: '3B', IF_SS: 'SS', IF_MID: 'MID', IF_1B: '1B',
}

// Fold the fine zones (10) into the visual zones (3 OF + 4 IF).
// LC → LF, RC → RF, IF_C → IF_MID.
function condense(counts = {}) {
  return {
    LF:     (counts.LF     || 0) + (counts.LC || 0),
    CF:     (counts.CF     || 0),
    RF:     (counts.RF     || 0) + (counts.RC || 0),
    IF_3B:  counts.IF_3B   || 0,
    IF_SS:  counts.IF_SS   || 0,
    IF_MID: (counts.IF_MID || 0) + (counts.IF_C || 0),
    IF_1B:  counts.IF_1B   || 0,
  }
}

const HITTER_FILTERS = [
  ['all',    'All Pitchers'],
  ['vs_rhp', 'vs RHP'],
  ['vs_lhp', 'vs LHP'],
  ['xbh',    'XBH'],
  ['hr',     'HR'],
]
const PITCHER_FILTERS = [
  ['all',    'All Batters'],
  ['vs_rhb', 'vs RHB'],
  ['vs_lhb', 'vs LHB'],
  ['xbh',    'XBH'],
  ['hr',     'HR'],
]

export default function SprayChart({ data, bats, defaultFilter = 'all', mode = 'hitter' }) {
  const FILTERS = mode === 'pitcher' ? PITCHER_FILTERS : HITTER_FILTERS
  const [filter, setFilter] = useState(defaultFilter)
  const counts = condense(data?.[filter])
  const total = data?.[`${filter}_total`] || 0

  // HR badges: % of HRs hit to each OF third
  const hrCondensed = useMemo(() => condense(data?.hr), [data])
  const hrTotal = data?.hr_total || 0

  // Color peak: scale by the max wedge in current view
  const allWedges = [
    ...OF_ZONES.map(z => counts[z] || 0),
    ...IF_ZONES.map(z => counts[z] || 0),
  ]
  const peak = Math.max(...allWedges, 1)

  // Smaller geometry (was 500x360, now 360x270)
  const W = 360, H = 270
  const HOME = { x: W / 2, y: H - 20 }
  const R_HOME = 6
  const R_INF_OUT = 100   // infield outer radius
  const R_OF_OUT = 200    // outfield outer radius
  const R_HR_BADGE = R_OF_OUT + 18  // outside the fence

  const ofWedge = (FAN_HALF_ANGLE * 2) / OF_ZONES.length
  const ifWedge = (FAN_HALF_ANGLE * 2) / IF_ZONES.length
  const ofAngles = i => [
    -FAN_HALF_ANGLE + i * ofWedge,
    -FAN_HALF_ANGLE + (i + 1) * ofWedge,
  ]
  const ifAngles = i => [
    -FAN_HALF_ANGLE + i * ifWedge,
    -FAN_HALF_ANGLE + (i + 1) * ifWedge,
  ]

  // Bases positions for the diamond (1B right, 2B up, 3B left)
  const BASE_DIST = 70  // distance from home along the diagonal
  const baseSize = 5    // half-side of the diamond
  // Foul lines run at -45° / +45° from straight up
  const a45 = 45 * Math.PI / 180
  const firstBase  = { x: HOME.x + BASE_DIST * Math.sin(a45), y: HOME.y - BASE_DIST * Math.cos(a45) }
  const thirdBase  = { x: HOME.x - BASE_DIST * Math.sin(a45), y: HOME.y - BASE_DIST * Math.cos(a45) }
  const secondBase = { x: HOME.x, y: HOME.y - BASE_DIST * Math.sqrt(2) }

  function renderBase(b, key) {
    return (
      <rect
        key={key}
        x={b.x - baseSize}
        y={b.y - baseSize}
        width={baseSize * 2}
        height={baseSize * 2}
        fill="#ffffff"
        stroke="#9ca3af"
        strokeWidth="1.2"
        transform={`rotate(45 ${b.x} ${b.y})`}
      />
    )
  }

  return (
    <div className="bg-white rounded-md border border-gray-200 p-3">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-gray-800">Spray Chart</h3>
        <div className="flex items-center flex-wrap gap-1 text-[10px]">
          {FILTERS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                filter === k
                  ? 'bg-nw-teal text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" xmlns="http://www.w3.org/2000/svg">
        {/* Outfield wedges (outer ring) */}
        {OF_ZONES.map((z, i) => {
          const [a1, a2] = ofAngles(i)
          const n = counts[z] || 0
          const pct = total > 0 ? n / total : 0
          const sIdx = shadeIndex(n, peak)
          const fill = SHADES[sIdx]
          const [lx, ly] = wedgeLabelPos(HOME.x, HOME.y, R_INF_OUT, R_OF_OUT, a1, a2)
          const pctText = total > 0 ? `${(pct * 100).toFixed(0)}%` : '—'
          const textColor = TEXT_DARK_SHADES.has(sIdx) ? '#ffffff' : '#1f2937'
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
                  style={{ fontSize: '13px', fontWeight: 700, fill: textColor, pointerEvents: 'none' }}
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
          const n = counts[z] || 0
          const pct = total > 0 ? n / total : 0
          const sIdx = shadeIndex(n, peak)
          const fill = SHADES[sIdx]
          const [lx, ly] = wedgeLabelPos(HOME.x, HOME.y, R_HOME, R_INF_OUT, a1, a2)
          const pctText = total > 0 ? `${(pct * 100).toFixed(0)}%` : '—'
          const textColor = TEXT_DARK_SHADES.has(sIdx) ? '#ffffff' : '#1f2937'
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
                  style={{ fontSize: '11px', fontWeight: 700, fill: textColor, pointerEvents: 'none' }}
                >
                  {pctText}
                </text>
              )}
            </g>
          )
        })}

        {/* Bases — diamond formation, white squares rotated 45° */}
        {renderBase(firstBase,  'b1')}
        {renderBase(secondBase, 'b2')}
        {renderBase(thirdBase,  'b3')}

        {/* Home plate — pentagon with point DOWN toward catcher,
            flat side facing pitcher's mound (away from camera) */}
        <polygon
          points={`
            ${HOME.x - 7},${HOME.y - 8}
            ${HOME.x + 7},${HOME.y - 8}
            ${HOME.x + 7},${HOME.y - 2}
            ${HOME.x},    ${HOME.y + 5}
            ${HOME.x - 7},${HOME.y - 2}
          `}
          fill="#ffffff"
          stroke="#9ca3af"
          strokeWidth="1.2"
        />

        {/* OF zone labels */}
        {OF_ZONES.map((z, i) => {
          const [a1, a2] = ofAngles(i)
          const aMid = ((a1 + a2) / 2 - 90) * Math.PI / 180
          const r = R_OF_OUT + 12
          return (
            <text
              key={`lab-${z}`}
              x={HOME.x + r * Math.cos(aMid)}
              y={HOME.y + r * Math.sin(aMid)}
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ fontSize: '10px', fontWeight: 600, fill: '#6b7280' }}
            >
              {ZONE_LABEL[z]}
            </text>
          )
        })}

        {/* HR badges OUTSIDE the fence — only shown when player has HRs */}
        {hrTotal > 0 && OF_ZONES.map((z, i) => {
          const hr = hrCondensed[z] || 0
          if (hr === 0) return null
          const [a1, a2] = ofAngles(i)
          const aMid = ((a1 + a2) / 2 - 90) * Math.PI / 180
          const bx = HOME.x + R_HR_BADGE * Math.cos(aMid)
          const by = HOME.y + R_HR_BADGE * Math.sin(aMid)
          const pct = `${Math.round((hr / hrTotal) * 100)}%`
          return (
            <g key={`hr-${z}`} transform={`translate(${bx}, ${by})`}>
              <rect
                x="-22" y="-9"
                width="44" height="18"
                rx="9" ry="9"
                fill="#004d5a"
              />
              <text
                x="0" y="0"
                textAnchor="middle"
                dominantBaseline="middle"
                style={{ fontSize: '10px', fontWeight: 700, fill: '#ffffff' }}
              >
                HR {pct}
              </text>
            </g>
          )
        })}

        {/* BIP badge */}
        <g transform={`translate(${W - 8}, 12)`}>
          <text x="0" y="0" textAnchor="end" style={{ fontSize: '9px', fontWeight: 600, fill: '#6b7280' }}>
            BIP
          </text>
          <text x="0" y="14" textAnchor="end" style={{ fontSize: '14px', fontWeight: 700, fill: '#1f2937' }}>
            {total}
          </text>
        </g>

        {/* Filter chip */}
        <g transform="translate(8, 8)">
          <rect x="0" y="0" rx="3" ry="3" width="76" height="16" fill="#1f2937" />
          <text x="38" y="11" textAnchor="middle" style={{ fontSize: '9px', fontWeight: 700, fill: '#ffffff', letterSpacing: '0.04em' }}>
            {(FILTERS.find(([k]) => k === filter) || [, 'ALL'])[1].toUpperCase()}
          </text>
        </g>
      </svg>

      {/* Legend / handedness hint */}
      <div className="flex items-center justify-between mt-2 text-[10px] text-gray-500">
        <span>
          Pull side: <strong className="text-gray-700">
            {bats === 'L' ? 'right' : bats === 'R' ? 'left' : '(switch)'}
          </strong>
        </span>
        <div className="flex items-center gap-1">
          <span>Less</span>
          {SHADES.slice(1).map((c, i) => (
            <span key={i} className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: c }} />
          ))}
          <span>More</span>
        </div>
      </div>
      {hrTotal > 0 && (
        <p className="text-[10px] text-gray-400 mt-1 italic">
          HR badges show % of {hrTotal} home run{hrTotal === 1 ? '' : 's'} pulled to each outfield zone.
        </p>
      )}
    </div>
  )
}
