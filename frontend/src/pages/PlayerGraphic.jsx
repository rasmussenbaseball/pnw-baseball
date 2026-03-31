import { useState, useRef, useCallback, useEffect } from 'react'
import { usePlayer } from '../hooks/useApi'
import { formatStat } from '../utils/stats'

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
    totals.woba = null // API computes this
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
  { key: 'woba',          label: 'wOBA',  format: 'avg' },
  { key: 'wrc_plus',      label: 'wRC+',  format: 'int' },
  { key: 'iso',           label: 'ISO',   format: 'avg' },
  { key: 'bb_pct',        label: 'BB%',   format: 'pct' },
  { key: 'k_pct',         label: 'K%',    format: 'pct' },
  { key: 'offensive_war', label: 'WAR',   format: 'war' },
  { key: 'stolen_bases',  label: 'SB',    format: 'int' },
]

const PITCHING_PERCENTILE_METRICS = [
  { key: 'k_pct',         label: 'K%',    format: 'pct' },
  { key: 'bb_pct',        label: 'BB%',   format: 'pct' },
  { key: 'fip',           label: 'FIP',   format: 'era' },
  { key: 'fip_plus',      label: 'FIP+',  format: 'int' },
  { key: 'era_plus',      label: 'ERA+',  format: 'int' },
  { key: 'xfip',          label: 'xFIP',  format: 'era' },
  { key: 'siera',         label: 'SIERA', format: 'era' },
  { key: 'pitching_war',  label: 'WAR',   format: 'war' },
  { key: 'k_bb_pct',      label: 'K-BB%', format: 'pct' },
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

// ─── Canvas export helpers ────────────────────────────────────
async function loadExportImage(src) {
  if (!src) return null
  const isExternal = src.startsWith('http') && !src.includes(window.location.hostname)
  const url = isExternal ? `/api/v1/proxy-image?url=${encodeURIComponent(src)}` : src
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const blob = await resp.blob()
    const objectUrl = URL.createObjectURL(blob)
    return await new Promise((resolve) => {
      const img = new Image()
      img.onload = () => { resolve(img); URL.revokeObjectURL(objectUrl) }
      img.onerror = () => { resolve(null); URL.revokeObjectURL(objectUrl) }
      img.src = objectUrl
    })
  } catch { return null }
}

function canvasRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function fmtCanvas(value, format) {
  if (value === null || value === undefined) return '-'
  switch (format) {
    case 'avg': return value >= 1 ? value.toFixed(3) : value.toFixed(3).replace('0.', '.')
    case 'era': return value.toFixed(2)
    case 'pct': return (value * 100).toFixed(1) + '%'
    case 'war': return value.toFixed(1)
    case 'ip':  return value.toFixed(1)
    case 'int': return Math.round(value).toString()
    default: return String(value)
  }
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

// ─── Percentile Bar Row (on-screen preview) ───────────────────
function PercentileBar({ label, value, percentile, format }) {
  const color = percentileColor(percentile)
  const barWidth = Math.max(4, percentile)
  return (
    <div className="flex items-center h-7">
      <div className="w-14 text-right pr-2 text-[11px] font-medium text-gray-200 shrink-0">{label}</div>
      <div className="flex-1 relative h-5">
        <div className="absolute top-1/2 left-0 right-0 h-1.5 rounded-full" style={{ transform: 'translateY(-50%)', backgroundColor: 'rgba(255,255,255,0.1)' }} />
        <div className="absolute top-1/2 left-0 h-1.5 rounded-full" style={{ transform: 'translateY(-50%)', width: `${barWidth}%`, backgroundColor: color, transition: 'width 0.5s ease' }} />
      </div>
      <div className="w-10 text-center shrink-0">
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold text-white" style={{ backgroundColor: color }}>
          {percentile}
        </span>
      </div>
      <div className="w-14 text-right text-[11px] text-gray-300 shrink-0">{fmtCanvas(value, format)}</div>
    </div>
  )
}

// ─── Stat Grid Cell ───────────────────────────────────────────
function StatCell({ label, value, format }) {
  return (
    <div className="text-center">
      <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-0.5">{label}</div>
      <div className="text-sm font-bold text-white">{formatStat(value, format)}</div>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════
// MAIN PAGE COMPONENT
// ═══════════════════════════════════════════════════════════════
export default function PlayerGraphic() {
  const [playerId, setPlayerId] = useState(null)
  const [selectedSeason, setSelectedSeason] = useState('latest')
  const [exporting, setExporting] = useState(false)
  const cardRef = useRef(null)

  // Determine percentile_season param
  const percentileSeason = selectedSeason === 'career' ? 'career' : selectedSeason === 'latest' ? null : selectedSeason
  const { data: player, loading, error } = usePlayer(playerId, percentileSeason)

  // Available seasons
  const battingSeasons = player?.batting_stats?.map(s => s.season) || []
  const pitchingSeasons = player?.pitching_stats?.map(s => s.season) || []
  const allSeasons = [...new Set([...battingSeasons, ...pitchingSeasons])].sort((a, b) => b - a)
  const latestSeason = allSeasons[0] || 2026

  // Active season data
  const activeSeason = selectedSeason === 'latest' ? latestSeason : selectedSeason === 'career' ? 'career' : Number(selectedSeason)

  const hasBatting = player?.batting_stats?.length > 0
  const hasPitching = player?.pitching_stats?.length > 0

  // Get the stats row for the selected season
  const battingRow = activeSeason === 'career'
    ? computeCareerTotals(player?.batting_stats || [], 'batting')
    : player?.batting_stats?.find(s => s.season === activeSeason)
  const pitchingRow = activeSeason === 'career'
    ? computeCareerTotals(player?.pitching_stats || [], 'pitching')
    : player?.pitching_stats?.find(s => s.season === activeSeason)

  // Percentiles from API
  const percentiles = player?.percentiles || {}

  // Rankings / awards
  const pnwRankings = player?.pnw_rankings || []
  const awards = player?.awards || []

  // Build leaderboard badges
  const badges = []
  for (const r of pnwRankings) {
    if (r.rank <= 3) {
      badges.push({ scope: 'PNW', rank: r.rank, category: r.category, value: r.value, format: r.format })
    }
  }
  for (const a of awards) {
    if (a.season === activeSeason || activeSeason === 'career') {
      badges.push({ scope: a.team_short || 'Team', rank: 1, category: a.category, value: a.value, format: 'int' })
    }
  }

  // ─── Canvas Export ────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    if (!player) return
    setExporting(true)

    try {
      const W = 1080, H = 1080
      const canvas = document.createElement('canvas')
      canvas.width = W; canvas.height = H
      const ctx = canvas.getContext('2d')
      const font = 'Inter, system-ui, -apple-system, sans-serif'

      // ── Background gradient
      const grad = ctx.createLinearGradient(0, 0, W, H)
      grad.addColorStop(0, '#0a1628')
      grad.addColorStop(0.35, '#0f2744')
      grad.addColorStop(1, '#00687a')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, W, H)

      // ── Subtle orbs
      ctx.beginPath()
      ctx.arc(W * 0.8, H * 0.15, 200, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0,104,122,0.2)'
      ctx.fill()
      ctx.beginPath()
      ctx.arc(W * 0.2, H * 0.85, 250, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0,138,158,0.1)'
      ctx.fill()

      const pad = 48

      // ── Load images
      const [headshot, logo] = await Promise.all([
        loadExportImage(player.headshot_url),
        loadExportImage(player.logo_url),
      ])

      // ══ HEADER SECTION (y: 0 → ~200) ══
      let y = pad

      // Logo in top-right
      if (logo) {
        const logoSize = 70
        ctx.globalAlpha = 0.5
        ctx.drawImage(logo, W - pad - logoSize, y, logoSize, logoSize)
        ctx.globalAlpha = 1
      }

      // Headshot circle
      const hsSize = 120
      const hsX = pad, hsY = y
      ctx.save()
      ctx.beginPath()
      ctx.arc(hsX + hsSize / 2, hsY + hsSize / 2, hsSize / 2, 0, Math.PI * 2)
      ctx.closePath()
      ctx.clip()
      if (headshot) {
        ctx.drawImage(headshot, hsX, hsY, hsSize, hsSize)
      } else {
        ctx.fillStyle = '#1a3a5c'
        ctx.fillRect(hsX, hsY, hsSize, hsSize)
        ctx.font = `bold 40px ${font}`
        ctx.fillStyle = 'rgba(255,255,255,0.4)'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(
          (player.first_name?.[0] || '') + (player.last_name?.[0] || ''),
          hsX + hsSize / 2, hsY + hsSize / 2
        )
      }
      ctx.restore()

      // Name
      const nameX = hsX + hsSize + 20
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.font = `800 42px ${font}`
      ctx.fillStyle = '#ffffff'
      ctx.fillText(player.first_name || '', nameX, y + 8)
      ctx.fillText(player.last_name || '', nameX, y + 52)

      // Info line
      const infoItems = [
        player.position,
        player.jersey_number ? `#${player.jersey_number}` : null,
        player.bats && player.throws ? `${player.bats}/${player.throws}` : null,
        player.year_in_school,
      ].filter(Boolean)
      ctx.font = `500 18px ${font}`
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.fillText(infoItems.join('  ·  '), nameX, y + 100)

      // Team / school
      ctx.font = `600 20px ${font}`
      ctx.fillStyle = '#7dd3fc'
      ctx.fillText(player.team_name || '', nameX + 1, y + 124)

      // Season label
      const seasonLabel = activeSeason === 'career' ? 'CAREER' : `${activeSeason} SEASON`
      ctx.font = `700 14px ${font}`
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.textAlign = 'right'
      ctx.fillText(seasonLabel, W - pad, y + 82)

      // Division badge
      if (player.division_level) {
        ctx.font = `700 13px ${font}`
        ctx.fillStyle = 'rgba(125,211,252,0.7)'
        ctx.fillText(player.division_level, W - pad, y + 102)
      }

      y += 170

      // ── Divider
      ctx.strokeStyle = 'rgba(255,255,255,0.1)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke()
      y += 20

      // Determine which stats to draw
      const isPitcher = hasPitching && (!hasBatting || (pitchingRow && !battingRow))
      const statsRow = isPitcher ? pitchingRow : battingRow
      const coreStats = isPitcher ? PITCHING_CORE : BATTING_CORE
      const advStats = isPitcher ? PITCHING_ADVANCED : BATTING_ADVANCED
      const percMetrics = isPitcher ? PITCHING_PERCENTILE_METRICS : BATTING_PERCENTILE_METRICS

      // ══ CORE STATS GRID ══
      if (statsRow) {
        ctx.font = `700 13px ${font}`
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.textAlign = 'left'
        ctx.fillText(isPitcher ? 'PITCHING' : 'BATTING', pad, y)
        y += 22

        const cols = coreStats.length
        const cellW = (W - pad * 2) / cols
        for (let i = 0; i < cols; i++) {
          const cx = pad + cellW * i + cellW / 2
          // Label
          ctx.font = `600 11px ${font}`
          ctx.fillStyle = 'rgba(255,255,255,0.4)'
          ctx.textAlign = 'center'
          ctx.fillText(coreStats[i].label, cx, y)
          // Value
          ctx.font = `bold 26px ${font}`
          ctx.fillStyle = '#ffffff'
          ctx.fillText(fmtCanvas(statsRow[coreStats[i].key], coreStats[i].format), cx, y + 30)
        }
        y += 56

        // ── Advanced stats row
        ctx.font = `700 13px ${font}`
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.textAlign = 'left'
        ctx.fillText('ADVANCED', pad, y)
        y += 22

        const advCols = advStats.length
        const advCellW = (W - pad * 2) / advCols
        for (let i = 0; i < advCols; i++) {
          const cx = pad + advCellW * i + advCellW / 2
          ctx.font = `600 11px ${font}`
          ctx.fillStyle = 'rgba(255,255,255,0.4)'
          ctx.textAlign = 'center'
          ctx.fillText(advStats[i].label, cx, y)
          ctx.font = `bold 24px ${font}`
          ctx.fillStyle = '#ffffff'
          ctx.fillText(fmtCanvas(statsRow[advStats[i].key], advStats[i].format), cx, y + 28)
        }
        y += 54
      }

      // ── Divider
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke()
      y += 16

      // ══ PERCENTILE BARS ══
      const availablePerc = percMetrics.filter(m => percentiles[m.key])
      if (availablePerc.length > 0) {
        ctx.font = `700 13px ${font}`
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.textAlign = 'left'
        ctx.fillText('PERCENTILE RANKINGS', pad, y)

        ctx.font = `500 10px ${font}`
        ctx.textAlign = 'right'
        ctx.fillText(`vs. ${player.division_level || 'Division'}`, W - pad, y)
        y += 20

        const barH = 30
        const labelW = 70
        const valueW = 60
        const circleR = 13
        const barArea = W - pad * 2 - labelW - valueW - circleR * 2 - 20

        for (const metric of availablePerc) {
          const { value, percentile } = percentiles[metric.key]
          const color = percentileColor(percentile)
          const bx = pad + labelW
          const barY = y + barH / 2

          // Label
          ctx.font = `600 13px ${font}`
          ctx.fillStyle = 'rgba(255,255,255,0.6)'
          ctx.textAlign = 'right'
          ctx.fillText(metric.label, bx - 10, barY + 4)

          // Track
          canvasRoundRect(ctx, bx, barY - 3, barArea, 6, 3)
          ctx.fillStyle = 'rgba(255,255,255,0.08)'
          ctx.fill()

          // Bar
          const bw = Math.max(6, (Math.max(4, percentile) / 100) * barArea)
          canvasRoundRect(ctx, bx, barY - 3, bw, 6, 3)
          ctx.fillStyle = color
          ctx.fill()

          // Circle with percentile number
          const circX = bx + barArea + 16 + circleR
          ctx.beginPath()
          ctx.arc(circX, barY, circleR, 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.fill()
          ctx.font = `bold 12px ${font}`
          ctx.fillStyle = '#ffffff'
          ctx.textAlign = 'center'
          ctx.fillText(String(percentile), circX, barY + 4)

          // Value
          ctx.font = `500 12px ${font}`
          ctx.fillStyle = 'rgba(255,255,255,0.5)'
          ctx.textAlign = 'right'
          ctx.fillText(fmtCanvas(value, metric.format), W - pad, barY + 4)

          y += barH
        }
        y += 8
      }

      // ── Divider
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke()
      y += 14

      // ══ LEADERBOARD BADGES ══
      const topBadges = badges.slice(0, 6)
      if (topBadges.length > 0) {
        ctx.font = `700 13px ${font}`
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.textAlign = 'left'
        ctx.fillText('LEADERBOARD', pad, y)
        y += 18

        const badgeCols = Math.min(topBadges.length, 3)
        const badgeW = (W - pad * 2 - (badgeCols - 1) * 12) / badgeCols
        const badgeH = 48

        for (let i = 0; i < topBadges.length; i++) {
          const col = i % badgeCols
          const row = Math.floor(i / badgeCols)
          const bx = pad + col * (badgeW + 12)
          const by = y + row * (badgeH + 8)
          const b = topBadges[i]

          canvasRoundRect(ctx, bx, by, badgeW, badgeH, 8)
          ctx.fillStyle = 'rgba(255,255,255,0.05)'
          ctx.fill()
          ctx.strokeStyle = 'rgba(255,255,255,0.1)'
          ctx.lineWidth = 1
          ctx.stroke()

          // Rank circle
          const rankColors = ['#f59e0b', '#94a3b8', '#cd7f32']
          ctx.beginPath()
          ctx.arc(bx + 24, by + badgeH / 2, 14, 0, Math.PI * 2)
          ctx.fillStyle = rankColors[Math.min(b.rank - 1, 2)] || '#64748b'
          ctx.fill()
          ctx.font = `bold 14px ${font}`
          ctx.fillStyle = '#ffffff'
          ctx.textAlign = 'center'
          ctx.fillText(String(b.rank), bx + 24, by + badgeH / 2 + 5)

          // Category + scope
          ctx.textAlign = 'left'
          ctx.font = `600 14px ${font}`
          ctx.fillStyle = '#ffffff'
          ctx.fillText(b.category, bx + 46, by + 20)
          ctx.font = `500 11px ${font}`
          ctx.fillStyle = 'rgba(255,255,255,0.4)'
          ctx.fillText(b.scope, bx + 46, by + 37)
        }

        y += Math.ceil(topBadges.length / badgeCols) * (badgeH + 8) + 4
      }

      // ══ FOOTER ══
      const footerY = H - 40
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(pad, footerY); ctx.lineTo(W - pad, footerY); ctx.stroke()

      ctx.font = `500 13px ${font}`
      ctx.fillStyle = 'rgba(255,255,255,0.3)'
      ctx.textAlign = 'left'
      ctx.fillText('nwbaseballstats.com', pad, footerY + 22)
      ctx.textAlign = 'right'
      ctx.fillText(seasonLabel, W - pad, footerY + 22)

      // ── Download
      const link = document.createElement('a')
      const safeName = `${player.first_name}_${player.last_name}`.replace(/\s/g, '_')
      link.download = `nwbb-${safeName}-${activeSeason}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed — check console for details.')
    } finally {
      setExporting(false)
    }
  }, [player, activeSeason, percentiles, badges, hasBatting, hasPitching, battingRow, pitchingRow])

  // ═══════════════════════════════════════════════════════════════
  // ON-SCREEN PREVIEW
  // ═══════════════════════════════════════════════════════════════
  return (
    <div className="space-y-6">
      {/* Page title + search */}
      <div>
        <h1 className="text-2xl font-bold text-gray-800 mb-1">Player Pages</h1>
        <p className="text-sm text-gray-500 mb-4">Generate a social media-ready graphic for any player.</p>
        <PlayerSearchBox onSelect={setPlayerId} />
      </div>

      {/* Loading / error states */}
      {playerId && loading && (
        <div className="text-center py-12 text-gray-500">Loading player data...</div>
      )}
      {playerId && error && (
        <div className="text-center py-12 text-red-500">Failed to load player. Try another search.</div>
      )}

      {/* Controls */}
      {player && (
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
          <button
            onClick={handleExport}
            disabled={exporting}
            className="px-4 py-1.5 bg-nw-teal text-white text-sm font-medium rounded-lg hover:bg-nw-teal-dark transition-colors disabled:opacity-50"
          >
            {exporting ? 'Exporting...' : 'Download PNG'}
          </button>
        </div>
      )}

      {/* Card preview */}
      {player && (
        <div className="flex justify-center">
          <div
            ref={cardRef}
            className="w-full max-w-lg aspect-square rounded-xl overflow-hidden shadow-2xl"
            style={{ background: 'linear-gradient(160deg, #0a1628 0%, #0f2744 35%, #00687a 100%)' }}
          >
            {/* ── Header ── */}
            <div className="p-5 pb-3 flex items-start gap-4">
              <div className="shrink-0">
                {player.headshot_url ? (
                  <img src={player.headshot_url} alt="" className="w-20 h-20 rounded-full object-cover border-2 border-white/20" />
                ) : (
                  <div className="w-20 h-20 rounded-full bg-white/10 flex items-center justify-center text-xl font-bold text-white/40">
                    {player.first_name?.[0]}{player.last_name?.[0]}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-2xl font-extrabold text-white leading-tight">{player.first_name}</div>
                <div className="text-2xl font-extrabold text-white leading-tight">{player.last_name}</div>
                <div className="text-xs text-white/50 mt-1">
                  {[player.position, player.jersey_number ? `#${player.jersey_number}` : null, player.bats && player.throws ? `${player.bats}/${player.throws}` : null, player.year_in_school].filter(Boolean).join('  ·  ')}
                </div>
                <div className="text-sm font-semibold mt-0.5" style={{ color: '#7dd3fc' }}>{player.team_name}</div>
              </div>
              <div className="shrink-0 text-right">
                {player.logo_url && (
                  <img src={player.logo_url} alt="" className="w-12 h-12 object-contain opacity-50 mb-1" />
                )}
                <div className="text-[10px] font-bold text-white/30 uppercase tracking-wider">
                  {activeSeason === 'career' ? 'Career' : activeSeason}
                </div>
                {player.division_level && (
                  <div className="text-[10px] font-bold mt-0.5" style={{ color: 'rgba(125,211,252,0.7)' }}>{player.division_level}</div>
                )}
              </div>
            </div>

            <div className="border-t border-white/10 mx-5" />

            {/* ── Stats ── */}
            {(() => {
              const isPitcher = hasPitching && (!hasBatting || (pitchingRow && !battingRow))
              const row = isPitcher ? pitchingRow : battingRow
              const core = isPitcher ? PITCHING_CORE : BATTING_CORE
              const adv = isPitcher ? PITCHING_ADVANCED : BATTING_ADVANCED
              const perc = isPitcher ? PITCHING_PERCENTILE_METRICS : BATTING_PERCENTILE_METRICS

              if (!row) return <div className="p-5 text-white/40 text-sm">No stats for this season.</div>

              return (
                <div className="p-5 pt-3 space-y-3 overflow-y-auto" style={{ maxHeight: 'calc(100% - 160px)' }}>
                  {/* Core stats grid */}
                  <div>
                    <div className="text-[10px] font-bold text-white/30 uppercase tracking-wider mb-2">
                      {isPitcher ? 'Pitching' : 'Batting'}
                    </div>
                    <div className="grid grid-cols-4 gap-y-2 gap-x-1">
                      {core.map(s => <StatCell key={s.key} label={s.label} value={row[s.key]} format={s.format} />)}
                    </div>
                  </div>

                  {/* Advanced stats grid */}
                  <div>
                    <div className="text-[10px] font-bold text-white/30 uppercase tracking-wider mb-2">Advanced</div>
                    <div className="grid grid-cols-4 gap-y-2 gap-x-1">
                      {adv.map(s => <StatCell key={s.key} label={s.label} value={row[s.key]} format={s.format} />)}
                    </div>
                  </div>

                  <div className="border-t border-white/[0.06]" />

                  {/* Percentile bars */}
                  {perc.filter(m => percentiles[m.key]).length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="text-[10px] font-bold text-white/30 uppercase tracking-wider">Percentile Rankings</div>
                        <div className="text-[9px] text-white/25">vs. {player.division_level || 'Division'}</div>
                      </div>
                      <div className="space-y-0.5">
                        {perc.filter(m => percentiles[m.key]).map(m => (
                          <PercentileBar
                            key={m.key}
                            label={m.label}
                            value={percentiles[m.key].value}
                            percentile={percentiles[m.key].percentile}
                            format={m.format}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Leaderboard badges */}
                  {badges.length > 0 && (
                    <>
                      <div className="border-t border-white/[0.06]" />
                      <div>
                        <div className="text-[10px] font-bold text-white/30 uppercase tracking-wider mb-2">Leaderboard</div>
                        <div className="grid grid-cols-3 gap-2">
                          {badges.slice(0, 6).map((b, i) => {
                            const rankColors = ['#f59e0b', '#94a3b8', '#cd7f32']
                            return (
                              <div key={i} className="rounded-lg p-2 text-center" style={{ backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                                <div className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold text-white mb-1" style={{ backgroundColor: rankColors[Math.min(b.rank - 1, 2)] || '#64748b' }}>
                                  {b.rank}
                                </div>
                                <div className="text-xs font-semibold text-white">{b.category}</div>
                                <div className="text-[10px] text-white/40">{b.scope}</div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )
            })()}

            {/* ── Footer ── */}
            <div className="border-t border-white/[0.06] mx-5" />
            <div className="px-5 py-2 flex items-center justify-between">
              <span className="text-[10px] text-white/25 font-medium">nwbaseballstats.com</span>
              <span className="text-[10px] text-white/25 font-medium">{activeSeason === 'career' ? 'Career' : `${activeSeason} Season`}</span>
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
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
