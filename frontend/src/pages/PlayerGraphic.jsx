import { useState, useEffect, useRef, useCallback } from 'react'
import { usePlayer } from '../hooks/useApi'
import { formatStat } from '../utils/stats'
import { toBlob } from 'html-to-image'

// ─── Percentile color (Savant-style blue→gray→red) ────────────
function percentileColor(pct) {
  const stops = [
    [1,   23,  57, 122],
    [10,  36,  90, 163],
    [20,  62, 130, 202],
    [30, 108, 172, 221],
    [40, 162, 200, 226],
    [50, 186, 186, 186],
    [60, 219, 183, 163],
    [70, 217, 147, 130],
    [80, 209, 107,  97],
    [90, 193,  58,  55],
    [99, 174,  10,  32],
  ]
  const p = Math.max(1, Math.min(99, pct))
  let lo = stops[0], hi = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (p >= stops[i][0] && p <= stops[i + 1][0]) {
      lo = stops[i]; hi = stops[i + 1]; break
    }
  }
  const t = hi[0] === lo[0] ? 0 : (p - lo[0]) / (hi[0] - lo[0])
  const r = Math.round(lo[1] + t * (hi[1] - lo[1]))
  const g = Math.round(lo[2] + t * (hi[2] - lo[2]))
  const b = Math.round(lo[3] + t * (hi[3] - lo[3]))
  return `rgb(${r},${g},${b})`
}

// ─── Career total computation ─────────────────────────────────
function computeCareerTotals(seasons, type) {
  if (!seasons.length) return null
  const sumKeys = type === 'batting'
    ? ['games', 'plate_appearances', 'at_bats', 'runs', 'hits', 'doubles', 'triples',
       'home_runs', 'rbi', 'walks', 'strikeouts', 'hit_by_pitch', 'sacrifice_flies',
       'stolen_bases', 'caught_stealing']
    : ['games', 'games_started', 'wins', 'losses', 'saves', 'innings_pitched',
       'hits_allowed', 'earned_runs', 'walks', 'strikeouts', 'home_runs_allowed',
       'hit_batters', 'wild_pitches', 'batters_faced']
  const totals = { season: 'Career' }
  for (const k of sumKeys) totals[k] = seasons.reduce((s, row) => s + (row[k] || 0), 0)

  if (type === 'batting') {
    const { at_bats: ab, hits: h, walks: bb, hit_by_pitch: hbp,
            sacrifice_flies: sf, doubles: d2, triples: d3, home_runs: hr } = totals
    const pa = totals.plate_appearances
    totals.batting_avg = ab > 0 ? h / ab : null
    totals.on_base_pct = pa > 0 ? (h + bb + (hbp || 0)) / (ab + bb + (hbp || 0) + (sf || 0)) : null
    const tb = h + d2 + 2 * d3 + 3 * hr
    totals.slugging_pct = ab > 0 ? tb / ab : null
    totals.ops = (totals.on_base_pct || 0) + (totals.slugging_pct || 0)
    totals.iso = ab > 0 ? (totals.slugging_pct - totals.batting_avg) : null
    totals.woba = null
    totals.wrc_plus = null
    totals.bb_pct = pa > 0 ? bb / pa : null
    totals.k_pct = pa > 0 ? totals.strikeouts / pa : null
    totals.offensive_war = seasons.reduce((s, r) => s + (r.offensive_war || 0), 0)
  } else {
    const { earned_runs: er, innings_pitched: ip, walks: bb, hits_allowed: h,
            strikeouts: k, batters_faced: bf } = totals
    totals.era = ip > 0 ? (er / ip) * 9 : null
    totals.whip = ip > 0 ? (bb + h) / ip : null
    totals.fip = null
    totals.k_pct = bf > 0 ? k / bf : null
    totals.bb_pct = bf > 0 ? bb / bf : null
    totals.pitching_war = seasons.reduce((s, r) => s + (r.pitching_war || 0), 0)
  }
  return totals
}

// ─── Stat display configs ─────────────────────────────────────
const BATTING_PERCENTILE_METRICS = [
  { key: 'woba',          label: 'wOBA',   format: 'avg' },
  { key: 'wrc_plus',      label: 'wRC+',   format: 'int' },
  { key: 'iso',           label: 'ISO',    format: 'avg' },
  { key: 'hr_pa_pct',     label: 'HR/PA%', format: 'pct' },
  { key: 'bb_pct',        label: 'BB%',    format: 'pct' },
  { key: 'k_pct',         label: 'K%',     format: 'pct' },
  { key: 'offensive_war', label: 'WAR',    format: 'war' },
  { key: 'stolen_bases',  label: 'SB',     format: 'int' },
]

const PITCHING_PERCENTILE_METRICS = [
  { key: 'k_pct',         label: 'K%',    format: 'pct' },
  { key: 'bb_pct',        label: 'BB%',   format: 'pct' },
  { key: 'fip',           label: 'FIP',   format: 'era' },
  { key: 'xfip',          label: 'xFIP',  format: 'era' },
  { key: 'siera',         label: 'SIERA', format: 'era' },
  { key: 'lob_pct',       label: 'LOB%',  format: 'pct' },
  { key: 'pitching_war',  label: 'WAR',   format: 'war' },
  { key: 'h_per_9',       label: 'H/9',   format: 'era' },
  { key: 'hr_per_9',      label: 'HR/9',  format: 'era' },
]

const BATTING_CORE = [
  { key: 'games', label: 'G', format: 'int' },
  { key: 'plate_appearances', label: 'PA', format: 'int' },
  { key: 'hits', label: 'H', format: 'int' },
  { key: 'home_runs', label: 'HR', format: 'int' },
  { key: 'rbi', label: 'RBI', format: 'int' },
  { key: 'stolen_bases', label: 'SB', format: 'int' },
  { key: 'runs', label: 'R', format: 'int' },
  { key: 'walks', label: 'BB', format: 'int' },
]

const BATTING_ADVANCED = [
  { key: 'batting_avg', label: 'AVG', format: 'avg' },
  { key: 'on_base_pct', label: 'OBP', format: 'avg' },
  { key: 'slugging_pct', label: 'SLG', format: 'avg' },
  { key: 'ops', label: 'OPS', format: 'avg' },
  { key: 'woba', label: 'wOBA', format: 'avg' },
  { key: 'wrc_plus', label: 'wRC+', format: 'int' },
  { key: 'iso', label: 'ISO', format: 'avg' },
  { key: 'offensive_war', label: 'oWAR', format: 'war' },
]

const PITCHING_CORE = [
  { key: 'wins', label: 'W', format: 'int' },
  { key: 'losses', label: 'L', format: 'int' },
  { key: 'saves', label: 'SV', format: 'int' },
  { key: 'games', label: 'G', format: 'int' },
  { key: 'games_started', label: 'GS', format: 'int' },
  { key: 'innings_pitched', label: 'IP', format: 'ip' },
  { key: 'strikeouts', label: 'K', format: 'int' },
  { key: 'walks', label: 'BB', format: 'int' },
]

const PITCHING_ADVANCED = [
  { key: 'era', label: 'ERA', format: 'era' },
  { key: 'whip', label: 'WHIP', format: 'era' },
  { key: 'fip', label: 'FIP', format: 'era' },
  { key: 'fip_plus', label: 'FIP+', format: 'int' },
  { key: 'era_plus', label: 'ERA+', format: 'int' },
  { key: 'xfip', label: 'xFIP', format: 'era' },
  { key: 'siera', label: 'SIERA', format: 'era' },
  { key: 'pitching_war', label: 'WAR', format: 'war' },
]

// Compact career row stats for multi-season display
const BATTING_CAREER_ROW = [
  { key: 'games', label: 'G', format: 'int' },
  { key: 'batting_avg', label: 'AVG', format: 'avg' },
  { key: 'home_runs', label: 'HR', format: 'int' },
  { key: 'rbi', label: 'RBI', format: 'int' },
  { key: 'offensive_war', label: 'oWAR', format: 'war' },
]

const PITCHING_CAREER_ROW = [
  { key: 'games', label: 'G', format: 'int' },
  { key: 'era', label: 'ERA', format: 'era' },
  { key: 'innings_pitched', label: 'IP', format: 'ip' },
  { key: 'strikeouts', label: 'K', format: 'int' },
  { key: 'pitching_war', label: 'pWAR', format: 'war' },
]

// Pie chart colors
const PIE_COLORS = {
  '1B': '#10b981', '2B': '#f59e0b', '3B': '#f97316', 'HR': '#ef4444',
  'BB': '#3b82f6', 'HBP': '#a855f7', 'H': '#f59e0b',
}


// ─── Helpers ──────────────────────────────────────────────────
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

function formatAwardVal(cat, val, fmt) {
  if (fmt === 'avg') return Number(val).toFixed(3)
  if (fmt === 'float1') return Number(val).toFixed(1)
  if (fmt === 'float2') return Number(val).toFixed(2)
  if (fmt === 'int') return Math.round(val)
  if (fmt === 'pct') return Number(val).toFixed(1) + '%'
  if (cat === 'AVG' || cat === 'ISO' || cat === 'OBP' || cat === 'SLG') return Number(val).toFixed(3)
  if (cat === 'ERA' || cat === 'FIP' || cat === 'WHIP' || cat === 'SIERA' || cat === 'xFIP') return Number(val).toFixed(2)
  if (cat === 'oWAR' || cat === 'pWAR' || cat === 'IP') return Number(val).toFixed(1)
  if (cat === 'wRC+' || cat === 'FIP+' || cat === 'ERA+') return Math.round(val)
  if (cat === 'K-BB%') return Number(val).toFixed(1) + '%'
  return val
}


// ─── Player Search Component ──────────────────────────────────
function PlayerSearchBox({ onSelect }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const debounceRef = useRef(null)

  useEffect(() => {
    if (query.length < 2) { setResults([]); setOpen(false); return }
    setLoading(true)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/v1/players/search?q=${encodeURIComponent(query)}`)
        const data = await res.json()
        setResults(Array.isArray(data) ? data : data.players || [])
        setOpen(true)
      } catch { setResults([]) }
      setLoading(false)
    }, 300)
    return () => clearTimeout(debounceRef.current)
  }, [query])

  return (
    <div className="relative w-full max-w-md">
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search for a player..."
        className="w-full px-4 py-2.5 rounded-lg border border-gray-300 focus:border-nw-teal focus:ring-1 focus:ring-nw-teal text-sm"
      />
      {loading && (
        <div className="absolute right-3 top-3 w-4 h-4 border-2 border-nw-teal border-t-transparent rounded-full animate-spin" />
      )}
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
          {results.map(p => (
            <button
              key={p.id}
              onClick={() => { onSelect(p.id); setQuery(p.first_name + ' ' + p.last_name); setOpen(false) }}
              className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center gap-3 border-b border-gray-100 last:border-b-0"
            >
              {p.headshot_url ? (
                <img src={p.headshot_url} alt="" className="w-8 h-8 rounded-full object-cover" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs text-gray-500">
                  {p.first_name?.[0]}{p.last_name?.[0]}
                </div>
              )}
              <div>
                <div className="text-sm font-medium text-gray-900">{p.first_name} {p.last_name}</div>
                <div className="text-xs text-gray-500">{p.team_name} · {p.position}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}


// ─── SVG Donut Pie Chart ──────────────────────────────────────
function OnBasePieChart({ statsRow, isPitcher, size = 76 }) {
  if (!statsRow) return null

  let slices = []
  if (isPitcher) {
    const nonHrHits = Math.max(0, (statsRow.hits_allowed || 0) - (statsRow.home_runs_allowed || 0))
    slices = [
      { label: 'H', value: nonHrHits, color: PIE_COLORS['H'] },
      { label: 'HR', value: statsRow.home_runs_allowed || 0, color: PIE_COLORS['HR'] },
      { label: 'BB', value: statsRow.walks || 0, color: PIE_COLORS['BB'] },
      { label: 'HBP', value: statsRow.hit_batters || 0, color: PIE_COLORS['HBP'] },
    ]
  } else {
    const singles = Math.max(0, (statsRow.hits || 0) - (statsRow.doubles || 0) - (statsRow.triples || 0) - (statsRow.home_runs || 0))
    slices = [
      { label: '1B', value: singles, color: PIE_COLORS['1B'] },
      { label: '2B', value: statsRow.doubles || 0, color: PIE_COLORS['2B'] },
      { label: '3B', value: statsRow.triples || 0, color: PIE_COLORS['3B'] },
      { label: 'HR', value: statsRow.home_runs || 0, color: PIE_COLORS['HR'] },
      { label: 'BB', value: statsRow.walks || 0, color: PIE_COLORS['BB'] },
      { label: 'HBP', value: statsRow.hit_by_pitch || 0, color: PIE_COLORS['HBP'] },
    ]
  }

  slices = slices.filter(s => s.value > 0)
  const total = slices.reduce((s, sl) => s + sl.value, 0)
  if (total === 0) return null

  const cx = size / 2, cy = size / 2, r = size / 2 - 1
  let angle = -Math.PI / 2

  const paths = slices.map(sl => {
    const pct = sl.value / total
    const startAngle = angle
    const endAngle = angle + pct * 2 * Math.PI
    angle = endAngle
    if (pct >= 0.999) {
      return { ...sl, pct, d: `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z` }
    }
    const x1 = cx + r * Math.cos(startAngle)
    const y1 = cy + r * Math.sin(startAngle)
    const x2 = cx + r * Math.cos(endAngle)
    const y2 = cy + r * Math.sin(endAngle)
    const largeArc = pct > 0.5 ? 1 : 0
    return { ...sl, pct, d: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z` }
  })

  return (
    <div className="flex items-center gap-2.5">
      <svg width={size} height={size} className="shrink-0">
        {paths.map((p, i) => (
          <path key={i} d={p.d} fill={p.color} stroke="rgba(10,22,40,0.9)" strokeWidth={1.5} />
        ))}
        <circle cx={cx} cy={cy} r={r * 0.42} fill="rgba(10,22,40,0.95)" />
      </svg>
      <div className="flex flex-col gap-0.5">
        {paths.map((p, i) => (
          <div key={i} className="flex items-center gap-1">
            <div className="rounded-sm shrink-0" style={{ width: '7px', height: '7px', backgroundColor: p.color }} />
            <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.65)', fontWeight: 600 }}>{p.label}</span>
            <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.35)' }}>{Math.round(p.pct * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}


// ─── Percentile Bar (compact, fills available height) ─────────
function PercentileBar({ label, value, percentile, format, height }) {
  const color = percentileColor(percentile)
  const barWidth = Math.max(4, percentile)
  return (
    <div className="flex items-center" style={{ height: height || '22px' }}>
      <div style={{ width: '38px', textAlign: 'right', paddingRight: '5px', fontSize: '9px', fontWeight: 700, color: 'rgba(255,255,255,0.5)', flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, position: 'relative', height: '5px', margin: '0 4px' }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: '9999px', backgroundColor: 'rgba(255,255,255,0.07)' }} />
        <div style={{ position: 'absolute', top: 0, left: 0, height: '100%', borderRadius: '9999px', width: `${barWidth}%`, backgroundColor: color, transition: 'width 0.5s ease' }} />
      </div>
      <div style={{ width: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '18px', height: '18px', borderRadius: '50%', fontSize: '8px', fontWeight: 700, color: '#fff', backgroundColor: color }}>{percentile}</span>
      </div>
      <div style={{ width: '38px', textAlign: 'right', fontSize: '9px', color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>{formatStat(value, format)}</div>
    </div>
  )
}


// ─── Stat Cell (bordered) ─────────────────────────────────────
function StatCell({ label, value, format, borderRight = true }) {
  return (
    <div style={{
      textAlign: 'center', padding: '3px 0',
      borderRight: borderRight ? '1px solid rgba(255,255,255,0.05)' : 'none',
    }}>
      <div style={{ fontSize: '7px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.5)', lineHeight: 1, marginBottom: '2px' }}>{label}</div>
      <div style={{ fontSize: '12px', fontWeight: 700, color: '#fff', lineHeight: 1 }}>{formatStat(value, format)}</div>
    </div>
  )
}


// ─── Award / Ranking Badge ────────────────────────────────────
function AwardBadge({ rank, category, value, type, format, variant = 'award', teamLogo = null }) {
  // variant: 'award' (team leader), 'career' (career ranking), 'pnw' (PNW ranking)
  const bgColors = {
    award: 'rgba(59,130,246,0.15)',
    career: rank === 1 ? 'rgba(245,158,11,0.2)' : rank <= 3 ? 'rgba(245,158,11,0.12)' : 'rgba(255,255,255,0.06)',
    pnw: rank === 1 ? 'rgba(20,184,166,0.2)' : 'rgba(20,184,166,0.12)',
  }
  const borderColors = {
    award: 'rgba(59,130,246,0.3)',
    career: rank === 1 ? 'rgba(245,158,11,0.4)' : 'rgba(245,158,11,0.2)',
    pnw: rank === 1 ? 'rgba(20,184,166,0.4)' : 'rgba(20,184,166,0.25)',
  }
  const textColors = {
    award: 'rgba(147,197,253,0.9)',
    career: rank === 1 ? 'rgba(252,211,77,0.95)' : 'rgba(252,211,77,0.7)',
    pnw: 'rgba(94,234,212,0.9)',
  }

  const formattedVal = formatAwardVal(category, value, format)

  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      padding: '2px 6px', borderRadius: '4px',
      background: bgColors[variant], border: `1px solid ${borderColors[variant]}`,
      fontSize: '8px', color: textColors[variant], fontWeight: 600,
      lineHeight: 1.3,
    }}>
      {variant === 'career' && teamLogo && (
        <img src={teamLogo} alt="" style={{ width: '10px', height: '10px', objectFit: 'contain', flexShrink: 0 }} />
      )}
      {variant === 'pnw' && <span style={{ fontSize: '7px', opacity: 0.6 }}>PNW</span>}
      {(variant === 'career' || variant === 'pnw') && (
        <span style={{ fontWeight: 800 }}>{ordinal(rank)}</span>
      )}
      <span>{category}</span>
      <span style={{ opacity: 0.5 }}>{formattedVal}</span>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════
// MAIN PAGE COMPONENT
// ═══════════════════════════════════════════════════════════════
export default function PlayerGraphic() {
  const [playerId, setPlayerId] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const id = params.get('id')
    return id ? Number(id) : null
  })
  const [selectedSeason, setSelectedSeason] = useState('latest')
  const [statMode, setStatMode] = useState(null)
  const [teamInfo, setTeamInfo] = useState(null)
  const cardRef = useRef(null)

  const percentileSeason = selectedSeason === 'career' ? 'career' : selectedSeason === 'latest' ? null : selectedSeason
  const { data: rawData, loading, error } = usePlayer(playerId, percentileSeason)

  const info = rawData?.player || {}
  const battingStats = rawData?.batting_stats || []
  const pitchingStats = rawData?.pitching_stats || []
  const teamHistory = rawData?.team_history || []
  const awards = rawData?.awards || []

  const downloadImage = useCallback(async () => {
    if (!cardRef.current) return
    try {
      // Pre-convert all images to inline data URLs to avoid CORS issues
      const images = cardRef.current.querySelectorAll('img')
      const origSrcs = []
      for (const img of images) {
        origSrcs.push(img.src)
        try {
          const canvas = document.createElement('canvas')
          canvas.width = img.naturalWidth || img.width || 100
          canvas.height = img.naturalHeight || img.height || 100
          const ctx = canvas.getContext('2d')
          ctx.drawImage(img, 0, 0)
          img.src = canvas.toDataURL('image/png')
        } catch { /* skip images that can't be converted */ }
      }

      const blob = await toBlob(cardRef.current, {
        pixelRatio: 2,
        style: { borderRadius: '0px' },
        skipFonts: true,
      })

      // Restore original image sources
      images.forEach((img, i) => { img.src = origSrcs[i] })

      if (!blob) throw new Error('No blob generated')

      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      const playerName = `${info.first_name || ''}-${info.last_name || ''}`.toLowerCase().replace(/\s+/g, '-')
      link.download = `${playerName}-${selectedSeason === 'latest' ? 'stats' : selectedSeason}.png`
      link.href = url
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to save image:', err)
      // Fallback: try without images
      try {
        const blob = await toBlob(cardRef.current, {
          pixelRatio: 2,
          style: { borderRadius: '0px' },
          skipFonts: true,
          filter: (node) => node.tagName !== 'IMG',
        })
        if (blob) {
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          const playerName = `${info.first_name || ''}-${info.last_name || ''}`.toLowerCase().replace(/\s+/g, '-')
          link.download = `${playerName}-${selectedSeason === 'latest' ? 'stats' : selectedSeason}.png`
          link.href = url
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          URL.revokeObjectURL(url)
        }
      } catch {
        alert('Failed to save image. Try right-clicking the graphic and selecting "Save image as..."')
      }
    }
  }, [info.first_name, info.last_name, selectedSeason])
  const pnwRankings = rawData?.pnw_rankings || []
  const careerRankings = rawData?.career_rankings || []
  const summerBatting = rawData?.summer_batting || []
  const summerPitching = rawData?.summer_pitching || []

  const battingSeasons = battingStats.map(s => s.season)
  const pitchingSeasons = pitchingStats.map(s => s.season)
  const allSeasons = [...new Set([...battingSeasons, ...pitchingSeasons])].sort((a, b) => b - a)
  const latestSeason = allSeasons[0] || 2026

  const activeSeason = selectedSeason === 'latest' ? latestSeason : selectedSeason === 'career' ? 'career' : Number(selectedSeason)

  const hasBatting = battingStats.length > 0
  const hasPitching = pitchingStats.length > 0

  const battingRow = activeSeason === 'career'
    ? computeCareerTotals(battingStats, 'batting')
    : battingStats.find(s => s.season === activeSeason)
  const pitchingRow = activeSeason === 'career'
    ? computeCareerTotals(pitchingStats, 'pitching')
    : pitchingStats.find(s => s.season === activeSeason)

  const battingPercentiles = rawData?.batting_percentiles || {}
  const pitchingPercentiles = rawData?.pitching_percentiles || {}
  const percentiles = { ...battingPercentiles, ...pitchingPercentiles }

  const isTwoWay = hasBatting && hasPitching
  const autoIsPitcher = hasPitching && (!hasBatting || (pitchingRow && !battingRow))
  const isPitcher = statMode ? statMode === 'pitching' : autoIsPitcher
  const statsRow = isPitcher ? pitchingRow : battingRow
  const coreStats = isPitcher ? PITCHING_CORE : BATTING_CORE
  const advStats = isPitcher ? PITCHING_ADVANCED : BATTING_ADVANCED
  const percMetrics = isPitcher ? PITCHING_PERCENTILE_METRICS : BATTING_PERCENTILE_METRICS
  const availablePerc = percMetrics.filter(m => percentiles[m.key]).slice(0, 9)
  const careerRowStats = isPitcher ? PITCHING_CAREER_ROW : BATTING_CAREER_ROW

  // Get all seasons for career display (not the active one)
  const allStatSeasons = isPitcher ? pitchingStats : battingStats
  const otherSeasons = allStatSeasons.filter(s => s.season !== activeSeason)

  // Fetch team record + national ranking
  useEffect(() => {
    if (!info.team_id) return
    const season = activeSeason === 'career' ? 2026 : activeSeason
    Promise.all([
      fetch(`/api/v1/team-ratings?season=${season}`).then(r => r.json()).catch(() => []),
      fetch(`/api/v1/national-rankings?season=${season}`).then(r => r.json()).catch(() => []),
    ]).then(([ratingsData, rankingsData]) => {
      let record = null
      const divisions = Array.isArray(ratingsData) ? ratingsData : []
      for (const div of divisions) {
        const team = (div.teams || []).find(t => t.id === info.team_id)
        if (team) { record = team; break }
      }
      let ranking = null
      const rankDivisions = Array.isArray(rankingsData) ? rankingsData : []
      for (const div of rankDivisions) {
        const team = (div.teams || []).find(t => t.team_id === info.team_id)
        if (team) { ranking = team; break }
      }
      setTeamInfo({ record, ranking })
    })
  }, [info.team_id, activeSeason])

  // Deduplicate career history
  const careerEntries = (() => {
    if (!teamHistory.length) return []
    const grouped = {}
    for (const th of teamHistory) {
      const key = th.team_id || th.team_short
      if (!grouped[key]) {
        grouped[key] = { ...th, seasons: [th.season] }
      } else {
        grouped[key].seasons.push(th.season)
      }
    }
    return Object.values(grouped).map(g => ({
      ...g,
      seasonRange: g.seasons.length === 1
        ? String(g.seasons[0])
        : `${Math.min(...g.seasons)}-${String(Math.max(...g.seasons)).slice(-2)}`,
    })).sort((a, b) => Math.min(...a.seasons) - Math.min(...b.seasons))
  })()

  // Group season awards by season
  const awardsBySeason = (() => {
    const grouped = {}
    awards.forEach(a => {
      const key = a.season
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(a)
    })
    return Object.entries(grouped)
      .sort(([a], [b]) => Number(b) - Number(a))
  })()

  // Compute how much right-column content we have to determine sizing
  const hasCareer = otherSeasons.length > 0 || careerEntries.length > 1
  const hasSummer = summerBatting.length > 0 || summerPitching.length > 0
  const hasAwards = awards.length > 0
  const hasCareerRankings = careerRankings.length > 0
  const hasPnwRankings = pnwRankings.length > 0
  const hasTeamInfo = !!teamInfo?.record
  const rightContentCount = [hasCareer || hasSummer, hasAwards || hasCareerRankings || hasPnwRankings, hasTeamInfo, true /* pie chart */].filter(Boolean).length

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800 mb-1">Player Pages</h1>
        <p className="text-sm text-gray-500 mb-4">Generate a shareable player graphic.</p>
        <PlayerSearchBox onSelect={setPlayerId} />
      </div>

      {playerId && loading && (
        <div className="text-center py-12 text-gray-500">Loading player data...</div>
      )}
      {playerId && error && (
        <div className="text-center py-12 text-red-500">Failed to load player. Try another search.</div>
      )}

      {rawData && (
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={selectedSeason}
            onChange={e => setSelectedSeason(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm"
          >
            <option value="latest">Latest Season ({latestSeason})</option>
            {allSeasons.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
            <option value="career">Career</option>
          </select>
          {isTwoWay && (
            <div className="inline-flex bg-gray-200 rounded-lg p-0.5">
              <button
                onClick={() => setStatMode('batting')}
                className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${
                  isPitcher === false ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >Hitting</button>
              <button
                onClick={() => setStatMode('pitching')}
                className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${
                  isPitcher === true ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >Pitching</button>
            </div>
          )}
          <button
            onClick={downloadImage}
            className="px-4 py-1.5 bg-pnw-green text-white text-sm font-semibold rounded-lg hover:bg-pnw-forest transition-colors"
          >
            Save Image
          </button>
        </div>
      )}

      {/* ═══ THE CARD ═══ */}
      {rawData && (
        <div className="flex justify-center">
          <div
            ref={cardRef}
            style={{
              width: '540px',
              height: '640px',
              background: 'linear-gradient(160deg, #0a1628 0%, #0f2744 35%, #00687a 100%)',
              borderRadius: '12px',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* ── HEADER ── */}
            <div style={{ display: 'flex', alignItems: 'center', padding: '10px 14px 6px', flexShrink: 0 }}>
              {/* Headshot */}
              <div style={{ flexShrink: 0 }}>
                {info.headshot_url ? (
                  <img src={info.headshot_url} alt="" style={{ width: '52px', height: '52px', borderRadius: '50%', objectFit: 'cover', border: '2px solid rgba(255,255,255,0.2)' }} />
                ) : (
                  <div style={{ width: '52px', height: '52px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: 700, color: 'rgba(255,255,255,0.4)' }}>
                    {info.first_name?.[0]}{info.last_name?.[0]}
                  </div>
                )}
              </div>

              {/* Center: Name + Info */}
              <div style={{ flex: 1, textAlign: 'center', padding: '0 8px', minWidth: 0 }}>
                <div style={{ fontSize: '22px', fontWeight: 800, color: '#fff', lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {info.first_name} {info.last_name}
                </div>
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.45)', marginTop: '2px' }}>
                  {[info.position, info.jersey_number ? `#${info.jersey_number}` : null, info.bats && info.throws ? `${info.bats}/${info.throws}` : null, info.year_in_school].filter(Boolean).join('  \u00B7  ')}
                </div>
                <div style={{ fontSize: '12px', fontWeight: 600, marginTop: '2px', color: '#7dd3fc' }}>
                  {info.team_name}
                </div>
              </div>

              {/* Team logo */}
              <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                {info.logo_url ? (
                  <img src={info.logo_url} alt="" style={{ width: '48px', height: '48px', objectFit: 'contain', opacity: 0.7 }} />
                ) : (
                  <div style={{ width: '48px', height: '48px' }} />
                )}
                <div style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: '1px' }}>
                  {info.division_level}
                </div>
              </div>
            </div>

            {/* ── STAT TABLES ── */}
            <div style={{ margin: '0 10px', flexShrink: 0, borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              {statsRow ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2px 8px', background: 'rgba(255,255,255,0.03)', position: 'relative' }}>
                    <span style={{ fontSize: '7px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {isPitcher ? 'Pitching' : 'Batting'}
                    </span>
                    <span style={{ fontSize: '7px', color: 'rgba(255,255,255,0.3)', position: 'absolute', right: '8px' }}>
                      {activeSeason === 'career' ? 'Career' : activeSeason}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    {coreStats.map((s, i) => (
                      <StatCell key={s.key} label={s.label} value={statsRow[s.key]} format={s.format} borderRight={i < coreStats.length - 1} />
                    ))}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2px 8px', background: 'rgba(255,255,255,0.03)', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    <span style={{ fontSize: '7px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Advanced</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    {advStats.map((s, i) => (
                      <StatCell key={s.key} label={s.label} value={statsRow[s.key]} format={s.format} borderRight={i < advStats.length - 1} />
                    ))}
                  </div>
                </>
              ) : (
                <div style={{ padding: '12px', textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: '11px' }}>No stats for this season.</div>
              )}
            </div>

            {/* ── BOTTOM SPLIT (flex-1 fills remaining space) ── */}
            <div style={{ flex: 1, display: 'flex', margin: '6px 10px 0', minHeight: 0 }}>

              {/* LEFT: Percentile Bars - fills full height */}
              <div style={{ flex: 1.2, display: 'flex', flexDirection: 'column', paddingRight: '8px', borderRight: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '2px' }}>
                  <span style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Percentile Rankings</span>
                </div>
                {availablePerc.length > 0 ? (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-evenly' }}>
                    {availablePerc.map(m => (
                      <PercentileBar
                        key={m.key}
                        label={m.label}
                        value={percentiles[m.key].value}
                        percentile={percentiles[m.key].percentile}
                        format={m.format}
                      />
                    ))}
                  </div>
                ) : (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.2)', fontSize: '10px' }}>
                    Not enough PA to qualify
                  </div>
                )}
                <div style={{ fontSize: '7px', color: 'rgba(255,255,255,0.2)', marginTop: '2px', marginBottom: '4px' }}>vs. {info.division_level || 'Division'}</div>
              </div>

              {/* RIGHT: Everything else - centered, fills full height */}
              <div style={{ flex: 0.8, display: 'flex', flexDirection: 'column', paddingLeft: '8px', justifyContent: 'space-evenly', alignItems: 'center' }}>

                {/* Pie Chart - scales up when sparse */}
                {statsRow && (
                  <div style={{ width: '100%' }}>
                    <div style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px', textAlign: 'center' }}>
                      {isPitcher ? 'Baserunners Allowed' : 'Reaching Base'}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'center' }}>
                      <OnBasePieChart statsRow={statsRow} isPitcher={isPitcher} size={rightContentCount <= 2 ? 100 : 76} />
                    </div>
                  </div>
                )}

                {/* Team Info - scales up when sparse */}
                {hasTeamInfo && (
                  <div style={{ width: '100%', textAlign: 'center' }}>
                    <div style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '3px' }}>Team</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'center', gap: '5px' }}>
                      <span style={{ fontSize: rightContentCount <= 2 ? '18px' : '14px', fontWeight: 700, color: 'rgba(255,255,255,0.85)' }}>
                        {teamInfo.record.wins}-{teamInfo.record.losses}
                      </span>
                      {teamInfo.record.conf_wins != null && (
                        <span style={{ fontSize: rightContentCount <= 2 ? '11px' : '9px', color: 'rgba(255,255,255,0.4)' }}>
                          ({teamInfo.record.conf_wins}-{teamInfo.record.conf_losses} conf)
                        </span>
                      )}
                    </div>
                    {teamInfo.ranking?.composite_rank && (
                      <div style={{ fontSize: rightContentCount <= 2 ? '11px' : '9px', fontWeight: 600, color: '#7dd3fc', marginTop: '2px' }}>
                        #{teamInfo.ranking.composite_rank} {info.division_level}
                      </div>
                    )}
                    {teamInfo.record.conference_name && (
                      <div style={{ fontSize: rightContentCount <= 2 ? '9px' : '8px', color: 'rgba(255,255,255,0.3)', marginTop: '2px' }}>{teamInfo.record.conference_name}</div>
                    )}
                    {/* Extra team stats when sparse - show team WAR, wRC+, FIP */}
                    {rightContentCount <= 2 && teamInfo.record && (
                      <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '6px' }}>
                        {teamInfo.record.team_war != null && (
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '7px', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase' }}>WAR</div>
                            <div style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.7)' }}>{Number(teamInfo.record.team_war).toFixed(1)}</div>
                          </div>
                        )}
                        {teamInfo.record.team_wrc_plus != null && (
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '7px', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase' }}>wRC+</div>
                            <div style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.7)' }}>{Math.round(teamInfo.record.team_wrc_plus)}</div>
                          </div>
                        )}
                        {teamInfo.record.team_fip != null && (
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '7px', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase' }}>FIP</div>
                            <div style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.7)' }}>{Number(teamInfo.record.team_fip).toFixed(2)}</div>
                          </div>
                        )}
                        {teamInfo.record.ppi != null && (
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '7px', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase' }}>PPI</div>
                            <div style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.7)' }}>{Math.round(teamInfo.record.ppi)}</div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Career History */}
                {hasCareer && (
                  <div style={{ width: '100%' }}>
                    <div style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '3px', textAlign: 'center' }}>Career</div>
                    {otherSeasons.map((row, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px', justifyContent: 'center' }}>
                        {row.logo_url && (
                          <img src={row.logo_url} alt="" style={{ width: '12px', height: '12px', objectFit: 'contain', opacity: 0.6, flexShrink: 0 }} />
                        )}
                        <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.5)', flexShrink: 0 }}>{String(row.season).slice(-2)}'</span>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          {careerRowStats.map(s => (
                            <span key={s.key} style={{ fontSize: '8px', color: 'rgba(255,255,255,0.75)' }}>
                              <span style={{ color: 'rgba(255,255,255,0.45)' }}>{s.label} </span>
                              {formatStat(row[s.key], s.format)}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                    {otherSeasons.length === 0 && careerEntries.length > 1 && careerEntries.map((entry, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px', justifyContent: 'center' }}>
                        {entry.logo_url && (
                          <img src={entry.logo_url} alt="" style={{ width: '12px', height: '12px', objectFit: 'contain', opacity: 0.6, flexShrink: 0 }} />
                        )}
                        <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.5)' }}>{entry.seasonRange}</span>
                        <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.75)', fontWeight: 500 }}>{entry.team_short}</span>
                        <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.4)' }}>({entry.division_level})</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Summer Ball */}
                {hasSummer && (
                  <div style={{ width: '100%' }}>
                    <div style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '3px', textAlign: 'center' }}>Summer Ball</div>
                    {(isPitcher ? summerPitching : summerBatting).length > 0 ? (
                      (isPitcher ? summerPitching : summerBatting).slice(0, 3).map((row, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px', justifyContent: 'center' }}>
                          {row.team_logo && (
                            <img src={row.team_logo} alt="" style={{ width: '12px', height: '12px', objectFit: 'contain', opacity: 0.6, flexShrink: 0 }} />
                          )}
                          <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.5)', flexShrink: 0 }}>{String(row.season).slice(-2)}'</span>
                          <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.65)', fontWeight: 500 }}>{row.team_short || row.team_name}</span>
                          {row.league_abbrev && (
                            <span style={{ fontSize: '7px', color: 'rgba(255,255,255,0.3)' }}>({row.league_abbrev})</span>
                          )}
                          <div style={{ display: 'flex', gap: '4px' }}>
                            {isPitcher ? (
                              <>
                                <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.55)' }}>
                                  <span style={{ color: 'rgba(255,255,255,0.35)' }}>ERA </span>{row.era != null ? Number(row.era).toFixed(2) : '-'}
                                </span>
                                <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.55)' }}>
                                  <span style={{ color: 'rgba(255,255,255,0.35)' }}>IP </span>{row.innings_pitched != null ? Number(row.innings_pitched).toFixed(1) : '-'}
                                </span>
                                <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.55)' }}>
                                  <span style={{ color: 'rgba(255,255,255,0.35)' }}>K </span>{row.strikeouts ?? '-'}
                                </span>
                              </>
                            ) : (
                              <>
                                <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.55)' }}>
                                  <span style={{ color: 'rgba(255,255,255,0.35)' }}>AVG </span>{row.batting_avg != null ? Number(row.batting_avg).toFixed(3) : '-'}
                                </span>
                                <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.55)' }}>
                                  <span style={{ color: 'rgba(255,255,255,0.35)' }}>HR </span>{row.home_runs ?? '-'}
                                </span>
                                <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.55)' }}>
                                  <span style={{ color: 'rgba(255,255,255,0.35)' }}>RBI </span>{row.rbi ?? '-'}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      ))
                    ) : (
                      // Show whichever summer stats are available if the player's primary type has none
                      (isPitcher ? summerBatting : summerPitching).slice(0, 3).map((row, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px', justifyContent: 'center' }}>
                          {row.team_logo && (
                            <img src={row.team_logo} alt="" style={{ width: '12px', height: '12px', objectFit: 'contain', opacity: 0.6, flexShrink: 0 }} />
                          )}
                          <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.5)', flexShrink: 0 }}>{String(row.season).slice(-2)}'</span>
                          <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.65)', fontWeight: 500 }}>{row.team_short || row.team_name}</span>
                          {row.league_abbrev && (
                            <span style={{ fontSize: '7px', color: 'rgba(255,255,255,0.3)' }}>({row.league_abbrev})</span>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* Awards + Rankings */}
                {(hasAwards || hasCareerRankings || hasPnwRankings) && (
                  <div style={{ width: '100%' }}>
                    {hasAwards && (
                      <div style={{ marginBottom: '4px' }}>
                        <div style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '3px', textAlign: 'center' }}>
                          Team Leaders
                        </div>
                        {awardsBySeason.map(([season, items]) => (
                          <div key={season} style={{ marginBottom: '2px' }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', alignItems: 'center', justifyContent: 'center' }}>
                              <span style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(255,255,255,0.35)' }}>{String(season).slice(-2)}'</span>
                              {items.slice(0, 6).map((a, i) => (
                                <AwardBadge key={i} rank={1} category={a.category} value={a.value} type={a.type} variant="award" />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {hasPnwRankings && (
                      <div style={{ marginBottom: '4px' }}>
                        <div style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '3px', textAlign: 'center' }}>
                          PNW Rankings
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', justifyContent: 'center' }}>
                          {pnwRankings.slice(0, 6).map((r, i) => (
                            <AwardBadge key={i} rank={r.rank} category={r.category} value={r.value} format={r.format} variant="pnw" />
                          ))}
                        </div>
                      </div>
                    )}

                    {hasCareerRankings && (
                      <div>
                        <div style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '3px', textAlign: 'center' }}>
                          Career Rankings
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', justifyContent: 'center' }}>
                          {careerRankings.slice(0, 6).map((r, i) => (
                            <AwardBadge key={i} rank={r.rank} category={r.category} value={r.value} variant="career" teamLogo={r.team_logo} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ── FOOTER ── */}
            <div style={{ margin: '0 10px', borderTop: '1px solid rgba(255,255,255,0.04)', flexShrink: 0 }} />
            <div style={{ padding: '3px 14px 5px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.2)', fontWeight: 500 }}>pnwbaseballstats.com</span>
              <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.2)', fontWeight: 500 }}>{activeSeason === 'career' ? 'Career' : `${activeSeason} Season`}</span>
            </div>
          </div>
        </div>
      )}

      {!playerId && (
        <div className="text-center py-16 text-gray-400">
          <svg className="w-16 h-16 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0" />
          </svg>
          <p className="text-lg font-medium text-gray-500 mb-1">Search for a player above</p>
          <p className="text-sm">Generate a shareable graphic with their stats, percentiles, and rankings.</p>
        </div>
      )}
    </div>
  )
}
