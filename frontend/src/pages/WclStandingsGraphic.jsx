// WclStandingsGraphic — /graphics/wcl-standings
//
// The summer-league (WCL) sibling of the spring conference-standings
// graphic (ConferenceStandingsGraphic.jsx at /conference-standings).
// Same MECHANISM as spring standings — one fixed 1080×1080 canvas drawn
// with a header band, column headers, team rows with logos, an optional
// cut line, and a footer, exported as a PNG — but rendered in the WCL
// visual identity shared with WclLeaderboardGraphic / WclRecapGraphic:
// cream paper + grain, navy header band with a gold rule, white row
// cards, gold rank medallions for the top 3, and the navy footer strip.
// It reuses WclLeaderboardGraphic's theme system (Summer Classic /
// Navy Night / Golden Hour via buildTheme) wholesale.
//
// The standings ORDER is CPI rank — that's the whole point of this
// graphic (per Nate: record + run differential + CPI rank). Data comes
// from /summer/cpi (one row per team with rank, record, run_diff_pg,
// CPI, division), enriched by a team_id join with
// /summer/leaderboards/team-stats for team OPS / ERA.
//
// Canvas helpers (fmt, truncText, canvasRoundRect, drawImageContain,
// loadExportImage / proxy-image logo loading, mulberry32 grain) are
// copied from WclLeaderboardGraphic.jsx, which does not export them.

import { useState, useRef, useEffect, useCallback } from 'react'
import { useApi } from '../hooks/useApi'

// ─── Fixed 1080×1080 ───
const SIZE = { w: 1080, h: 1080 }

// Summer seasons with WCL data (matches WclLeaderboardGraphic). Newest first.
const SUMMER_SEASONS = [2026, 2025, 2024]
const CURRENT_SUMMER_SEASON = 2026

// ─── WCL color constants (same hexes as WclLeaderboardGraphic.jsx) ───
const WCL = {
  navy: '#14365c',
  navyDark: '#0d2240',
  blue: '#1f5485',
  gold: '#c9a44c',
  goldDeep: '#a9842f',
  goldLight: '#e2c577',
  cream: '#f6f1e3',
}

// ─── Themes (identical palette set to WclLeaderboardGraphic) ───
const THEMES = [
  {
    id: 'classic', label: 'Summer Classic',
    bgStops: [WCL.cream, WCL.cream], grain: true, grainDark: 'rgba(20,54,92,0.05)', grainLight: 'rgba(255,255,255,0.6)',
    headerStops: [WCL.navy, WCL.blue], headerRule: WCL.gold,
    kicker: WCL.goldLight, headerText: '#ffffff', headerSub: 'rgba(255,255,255,0.85)',
    card: '#ffffff', cardBorder: 'rgba(20,54,92,0.16)', cardAccent: WCL.navy,
    text: '#1a1a1a', name: WCL.navy, secondary: '#5a5a5a', muted: '#8a8a8a',
    colHeader: WCL.goldDeep, mainStat: WCL.navy, mainStatTop3: WCL.goldDeep,
    medals: [WCL.gold, WCL.goldLight, WCL.goldDeep], medalText: WCL.navyDark, medalRing: WCL.navyDark,
    rank: '#9a9483', logoFallback: '#e8e4d6',
    footerBg: WCL.navyDark, footerText: '#ffffff', footerMuted: 'rgba(255,255,255,0.7)',
    divLabel: WCL.navy,
    green: '#2e8b57', red: '#c0392b',
    cutLine: 'rgba(20,54,92,0.5)',
  },
  {
    id: 'navy', label: 'Navy Night',
    bgStops: [WCL.navyDark, WCL.navy, WCL.blue], grain: false,
    headerStops: [WCL.navyDark, WCL.navyDark], headerRule: WCL.gold,
    kicker: WCL.goldLight, headerText: '#ffffff', headerSub: 'rgba(246,241,227,0.75)',
    card: 'rgba(246,241,227,0.07)', cardBorder: 'rgba(226,197,119,0.28)', cardAccent: WCL.gold,
    text: WCL.cream, name: WCL.cream, secondary: 'rgba(246,241,227,0.6)', muted: 'rgba(246,241,227,0.4)',
    colHeader: WCL.goldLight, mainStat: WCL.goldLight, mainStatTop3: WCL.goldLight,
    medals: [WCL.gold, WCL.goldLight, WCL.goldDeep], medalText: WCL.navyDark, medalRing: WCL.goldLight,
    rank: 'rgba(246,241,227,0.45)', logoFallback: 'rgba(246,241,227,0.12)',
    footerBg: 'rgba(0,0,0,0.35)', footerText: WCL.cream, footerMuted: 'rgba(246,241,227,0.6)',
    divLabel: WCL.goldLight,
    green: '#5fd38a', red: '#e8736a',
    cutLine: 'rgba(226,197,119,0.5)',
  },
  {
    id: 'sunset', label: 'Golden Hour',
    bgStops: [WCL.cream, '#f0e3c2', WCL.goldLight], grain: true, grainDark: 'rgba(169,132,47,0.07)', grainLight: 'rgba(255,255,255,0.55)',
    headerStops: [WCL.navy, WCL.navyDark], headerRule: WCL.goldDeep,
    kicker: WCL.goldLight, headerText: '#ffffff', headerSub: 'rgba(255,255,255,0.85)',
    card: 'rgba(255,255,255,0.92)', cardBorder: 'rgba(169,132,47,0.35)', cardAccent: WCL.goldDeep,
    text: '#1a1a1a', name: WCL.navy, secondary: '#6a6048', muted: '#94855e',
    colHeader: WCL.navy, mainStat: WCL.navy, mainStatTop3: WCL.navy,
    medals: [WCL.navy, WCL.blue, WCL.navyDark], medalText: WCL.goldLight, medalRing: WCL.goldDeep,
    rank: '#94855e', logoFallback: '#efe7cf',
    footerBg: WCL.navy, footerText: '#ffffff', footerMuted: 'rgba(255,255,255,0.7)',
    divLabel: WCL.navy,
    green: '#2e8b57', red: '#c0392b',
    cutLine: 'rgba(169,132,47,0.55)',
  },
]

function buildTheme(palette) {
  const stops = palette.bgStops
  return {
    ...palette,
    swatch: stops.length > 1 ? `linear-gradient(135deg, ${stops.join(', ')})` : stops[0],
  }
}

// ─── Format helper (copied from WclLeaderboardGraphic.jsx) ───
function fmt(val, format) {
  if (val == null || val === '') return '-'
  switch (format) {
    case 'avg': return Number(val).toFixed(3).replace(/^0/, '')
    case 'era': return Number(val).toFixed(2)
    case 'int': return Math.round(Number(val)).toString()
    default: return String(val)
  }
}

// ─── Canvas helpers (copied from WclLeaderboardGraphic.jsx) ───
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
  } catch {
    return null
  }
}

function drawImageContain(ctx, img, x, y, boxW, boxH) {
  if (!img) return
  const scale = Math.min(boxW / img.width, boxH / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, x + (boxW - dw) / 2, y + (boxH - dh) / 2, dw, dh)
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

function truncText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 0 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1)
  return t + '…'
}

const logoCache = {}
function loadLogoCached(src) {
  if (!src) return Promise.resolve(null)
  if (!logoCache[src]) logoCache[src] = loadExportImage(src)
  return logoCache[src]
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FONT = "-apple-system, 'Inter', 'Helvetica Neue', sans-serif"

// Stat columns drawn to the right of the team name. Run Diff is required
// and colored (+green / -red); OPS and ERA are the two team rate stats
// that read cleanly at this size; CPI is the index the standings order by.
const STAT_COLS = [
  { key: 'winpct',   label: 'PCT',  format: 'avg' },
  { key: 'run_diff', label: 'DIFF', format: 'diff' },
  { key: 'team_ops', label: 'OPS',  format: 'avg' },
  { key: 'team_era', label: 'ERA',  format: 'era' },
  { key: 'cpi',      label: 'CPI',  format: 'int' },
]

// ════════════════════════════════════════════════════════════════
// Canvas renderer — one pipeline for preview AND export.
// ════════════════════════════════════════════════════════════════
async function renderStandings(canvas, opts) {
  const { teams, title, subtitle, footerNote, theme, division, loading } = opts
  const w = SIZE.w, h = SIZE.h
  const dpr = 2
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  // ── Background + paper grain ──
  if (theme.bgStops.length > 1) {
    const g = ctx.createLinearGradient(0, 0, 0, h)
    theme.bgStops.forEach((c, i) => g.addColorStop(i / (theme.bgStops.length - 1), c))
    ctx.fillStyle = g
  } else {
    ctx.fillStyle = theme.bgStops[0]
  }
  ctx.fillRect(0, 0, w, h)

  if (theme.grain) {
    const rand = mulberry32(20260614)
    for (let i = 0; i < 1600; i++) {
      const x = rand() * w, y = rand() * h, s = rand() < 0.5 ? 1 : 2
      ctx.fillStyle = rand() < 0.5 ? theme.grainDark : theme.grainLight
      ctx.fillRect(x, y, s, s)
    }
  }

  // ── Header band: navy gradient + gold rule ──
  const headerH = 150
  const hg = ctx.createLinearGradient(0, 0, w, headerH)
  theme.headerStops.forEach((c, i) =>
    hg.addColorStop(theme.headerStops.length > 1 ? i / (theme.headerStops.length - 1) : 0, c))
  ctx.fillStyle = hg
  ctx.fillRect(0, 0, w, headerH)
  ctx.fillStyle = theme.headerRule
  ctx.fillRect(0, headerH - 6, w, 6)

  const padX = 48
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = theme.kicker
  ctx.font = `900 15px ${FONT}`
  ctx.fillText('WEST COAST LEAGUE · STANDINGS', padX, 48)

  // Title — shrink-to-fit so long custom titles never clip
  let titleSize = 44
  ctx.font = `900 ${titleSize}px ${FONT}`
  while (titleSize > 24 && ctx.measureText(title).width > w - padX * 2 - 200) {
    titleSize -= 2
    ctx.font = `900 ${titleSize}px ${FONT}`
  }
  ctx.fillStyle = theme.headerText
  ctx.fillText(title, padX, 102)

  ctx.fillStyle = theme.headerSub
  ctx.font = `600 17px ${FONT}`
  ctx.fillText(subtitle, padX, 130)

  // Brand mark top-right
  const favicon = await loadLogoCached('/favicon.png')
  ctx.textAlign = 'right'
  ctx.font = `800 14px ${FONT}`
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  const brand = 'NWBB STATS'
  ctx.fillText(brand, w - padX, 50)
  if (favicon) {
    const bw = ctx.measureText(brand).width
    drawImageContain(ctx, favicon, w - padX - bw - 30, 36, 22, 22)
  }

  // ── Footer strip ──
  const footerH = 56
  const footerY = h - footerH
  ctx.fillStyle = theme.footerBg
  ctx.fillRect(0, footerY, w, footerH)
  ctx.fillStyle = theme.footerText
  ctx.font = `700 15px ${FONT}`
  ctx.textAlign = 'left'
  ctx.fillText('nwbaseballstats.com/summer', 40, footerY + 35)
  ctx.font = `500 13px ${FONT}`
  ctx.fillStyle = theme.footerMuted
  ctx.textAlign = 'right'
  ctx.fillText('@nwbaseballstats', w - 40, footerY + 35)
  if (footerNote) {
    ctx.textAlign = 'center'
    ctx.fillText(footerNote, w / 2, footerY + 35)
  }

  // ── Body geometry ──
  const bodyPadX = 36
  const bodyTop = headerH + 16
  const bodyBottom = footerY - 14
  const colHeaderH = 28
  const bodyH = bodyBottom - bodyTop - colHeaderH

  if (loading || !teams.length) {
    ctx.fillStyle = theme.name
    ctx.font = `700 22px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(loading ? 'Loading…' : 'No standings for these filters', w / 2, (bodyTop + bodyBottom) / 2)
    return
  }

  const n = teams.length
  const rowGap = Math.min(8, Math.max(3, Math.floor(80 / n)))
  const rowH = Math.floor((bodyH - rowGap * (n - 1)) / n)
  const fontSize = Math.min(Math.max(Math.floor(rowH * 0.4), 12), 20)
  const logoSize = Math.min(Math.floor(rowH * 0.66), 34)

  // ── Column geometry: stats drawn from the right edge ──
  const tableLeft = bodyPadX
  const tableRight = w - bodyPadX
  const rowPadX = 16
  const statW = Math.floor((tableRight - tableLeft) * 0.105)
  const rankW = Math.floor(fontSize * 2.0)
  const recordX = tableRight - rowPadX - STAT_COLS.length * statW   // W-L sits left of the stat block
  const recordW = Math.floor((tableRight - tableLeft) * 0.1)

  // Pre-load row logos
  const logoImgs = await Promise.all(teams.map(t => loadLogoCached(t.logo)))

  // ── Column headers ──
  const hy = bodyTop + colHeaderH / 2 - 2
  ctx.font = `800 ${Math.max(Math.floor(fontSize * 0.62), 10)}px ${FONT}`
  ctx.fillStyle = theme.colHeader
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText('TEAM', tableLeft + rowPadX + rankW + logoSize + 12, hy)
  ctx.textAlign = 'center'
  ctx.fillText('W-L', recordX - recordW / 2, hy)
  for (let i = 0; i < STAT_COLS.length; i++) {
    const cx = tableRight - rowPadX - (STAT_COLS.length - 1 - i) * statW - statW / 2
    ctx.fillText(STAT_COLS[i].label, cx, hy)
  }

  // ── Rows ──
  const rowStartY = bodyTop + colHeaderH
  for (let i = 0; i < n; i++) {
    const t = teams[i]
    const isTop3 = i < 3
    const x = tableLeft
    const y = rowStartY + i * (rowH + rowGap)
    const cw = tableRight - tableLeft
    const r = 10

    // Card
    ctx.fillStyle = theme.card
    canvasRoundRect(ctx, x, y, cw, rowH, r)
    ctx.fill()
    ctx.strokeStyle = isTop3 ? theme.medals[i] : theme.cardBorder
    ctx.lineWidth = isTop3 ? 2 : 1
    ctx.stroke()
    // Left accent bar
    ctx.save()
    canvasRoundRect(ctx, x, y, cw, rowH, r)
    ctx.clip()
    ctx.fillStyle = isTop3 ? theme.medals[i] : theme.cardAccent
    ctx.fillRect(x, y, 5, rowH)
    ctx.restore()

    const cy = y + rowH / 2
    let cellX = x + rowPadX

    // Rank — gold medallion for top 3, plain number otherwise
    if (isTop3) {
      const mr = Math.min(rowH * 0.3, 17)
      ctx.beginPath()
      ctx.arc(cellX + rankW / 2, cy, mr, 0, Math.PI * 2)
      ctx.fillStyle = theme.medals[i]
      ctx.fill()
      ctx.strokeStyle = theme.medalRing
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.fillStyle = theme.medalText
      ctx.font = `900 ${Math.floor(mr * 1.05)}px ${FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(t.rank), cellX + rankW / 2, cy + 1)
    } else {
      ctx.font = `900 ${Math.max(fontSize, 16)}px ${FONT}`
      ctx.fillStyle = theme.rank
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(t.rank), cellX + rankW / 2, cy)
    }
    cellX += rankW

    // Logo
    const logoImg = logoImgs[i]
    if (logoImg) {
      drawImageContain(ctx, logoImg, cellX, cy - logoSize / 2, logoSize, logoSize)
    } else {
      ctx.fillStyle = theme.logoFallback
      canvasRoundRect(ctx, cellX, cy - logoSize / 2, logoSize, logoSize, 4)
      ctx.fill()
      ctx.font = `700 ${Math.floor(logoSize * 0.35)}px ${FONT}`
      ctx.fillStyle = theme.muted
      ctx.textAlign = 'center'
      ctx.fillText((t.team || '').slice(0, 3).toUpperCase(), cellX + logoSize / 2, cy)
    }
    cellX += logoSize + 12

    // Team name (+ division tag when showing combined standings)
    const nameMaxW = recordX - recordW - cellX - 12
    const showDivTag = division === 'all' && t.division
    if (showDivTag) {
      const subSize = Math.floor(fontSize * 0.62)
      const gap = Math.floor(fontSize * 0.18)
      const nameY = cy - (subSize + gap) / 2
      ctx.font = `700 ${fontSize}px ${FONT}`
      ctx.fillStyle = theme.name
      ctx.textAlign = 'left'
      ctx.fillText(truncText(ctx, t.team_name || t.team || '-', nameMaxW), cellX, nameY)
      ctx.font = `600 ${subSize}px ${FONT}`
      ctx.fillStyle = theme.secondary
      ctx.fillText(`${t.division} Div.`, cellX, nameY + fontSize / 2 + gap + subSize / 2)
    } else {
      ctx.font = `700 ${fontSize}px ${FONT}`
      ctx.fillStyle = theme.name
      ctx.textAlign = 'left'
      ctx.fillText(truncText(ctx, t.team_name || t.team || '-', nameMaxW), cellX, cy)
    }

    // W-L
    ctx.font = `700 ${fontSize}px ${FONT}`
    ctx.fillStyle = theme.name
    ctx.textAlign = 'center'
    ctx.fillText(`${t.actual_w}-${t.actual_l}`, recordX - recordW / 2, cy)

    // Stat columns from the right
    for (let c = 0; c < STAT_COLS.length; c++) {
      const col = STAT_COLS[c]
      const cx = tableRight - rowPadX - (STAT_COLS.length - 1 - c) * statW - statW / 2
      let val, color, text
      if (col.key === 'run_diff') {
        val = t.run_diff
        color = val > 0 ? theme.green : val < 0 ? theme.red : theme.secondary
        text = val > 0 ? `+${val}` : `${val}`
        ctx.font = `800 ${fontSize}px ${FONT}`
      } else if (col.key === 'winpct') {
        val = t.actual_winpct
        color = theme.text
        text = fmt(val, 'avg')
        ctx.font = `600 ${Math.floor(fontSize * 0.92)}px ${FONT}`
      } else if (col.key === 'cpi') {
        val = t.cpi
        color = isTop3 ? theme.mainStatTop3 : theme.mainStat
        text = fmt(val, 'int')
        ctx.font = `800 ${fontSize}px ${FONT}`
      } else {
        val = t[col.key]
        color = theme.text
        text = fmt(val, col.format)
        ctx.font = `600 ${Math.floor(fontSize * 0.92)}px ${FONT}`
      }
      ctx.fillStyle = color
      ctx.textAlign = 'center'
      ctx.fillText(text, cx, cy)
    }
  }
}

// ════════════════════════════════════════════════════════════════
// Page component
// ════════════════════════════════════════════════════════════════
export default function WclStandingsGraphic() {
  const canvasRef = useRef(null)

  const [season, setSeason] = useState(CURRENT_SUMMER_SEASON)
  const [division, setDivision] = useState('all')   // 'all' | 'North' | 'South' | ...
  const [themeId, setThemeId] = useState('classic')
  const [customTitle, setCustomTitle] = useState('')
  const [exporting, setExporting] = useState(false)

  const theme = buildTheme(THEMES.find(t => t.id === themeId) || THEMES[0])

  const { data: cpiData, loading: cpiLoading } = useApi('/summer/cpi', { season, league: 'WCL' }, [season])
  const { data: teamStatsData, loading: tsLoading } = useApi(
    '/summer/leaderboards/team-stats', { season, league: 'WCL' }, [season]
  )
  const loading = cpiLoading || tsLoading

  // Reset division if it no longer exists for the selected season's data
  const cpiTeams = cpiData?.teams || []
  const divisions = [...new Set(cpiTeams.map(t => t.division).filter(Boolean))].sort()
  useEffect(() => {
    if (division !== 'all' && !divisions.includes(division)) setDivision('all')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [season, divisions.join(',')])

  // Join CPI rows with team-stats (OPS / ERA) on team_id, compute total run diff
  const teamStatsList = Array.isArray(teamStatsData) ? teamStatsData : teamStatsData?.data || []
  const statsById = Object.fromEntries(teamStatsList.map(t => [t.team_id, t]))

  let rows = cpiTeams
    .filter(t => division === 'all' || t.division === division)
    .map(t => {
      const ts = statsById[t.team_id] || {}
      return {
        ...t,
        run_diff: Math.round((t.run_diff_pg || 0) * (t.games || 0)),
        team_ops: ts.team_ops,
        team_era: ts.team_era,
      }
    })
    .sort((a, b) => a.rank - b.rank)

  // Re-rank within a single-division view so the column reads 1..n
  if (division !== 'all') rows = rows.map((t, i) => ({ ...t, rank: i + 1 }))

  const titleText = customTitle || (division === 'all' ? 'WCL Standings' : `WCL ${division} Division`)
  const subtitle = `${season} West Coast League`
    + (division === 'all' ? ' · By CPI Rank' : ' · By CPI Rank')
  const footerNote = 'Ordered by CPI'

  // ─── Render whenever inputs change ───
  const renderToken = useRef(0)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const token = ++renderToken.current
    renderStandings(canvas, {
      teams: rows, title: titleText, subtitle, footerNote, theme, division, loading,
    }).catch(err => console.error('WCL standings render failed:', err))
    return () => { if (renderToken.current === token) renderToken.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(rows), loading, themeId, titleText, subtitle, division])

  // ─── Export ───
  const handleExport = useCallback(() => {
    if (!canvasRef.current || !rows.length) return
    setExporting(true)
    try {
      const a = document.createElement('a')
      const divTag = division === 'all' ? 'all' : division.toLowerCase()
      a.download = `wcl-standings-${divTag}-${season}.png`
      a.href = canvasRef.current.toDataURL('image/png')
      a.click()
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed. Check console for details')
    } finally {
      setExporting(false)
    }
  }, [rows.length, division, season])

  const scale = Math.min(600 / SIZE.w, 800 / SIZE.h)

  return (
    <div>
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">WCL Standings Graphic</h1>
      <p className="text-sm text-gray-500 mb-5">
        Shareable West Coast League standings (1080×1080): record, run differential, and CPI rank in the summer look.
      </p>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* ═══ LEFT: Controls ═══ */}
        <div className="lg:w-80 shrink-0 space-y-4">
          {/* Filters */}
          <div className="bg-white rounded-lg shadow-sm border p-4 space-y-3">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">Filters</label>

            <div>
              <label className="text-xs text-gray-500">Season</label>
              <select value={season} onChange={e => setSeason(+e.target.value)}
                className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                {SUMMER_SEASONS.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>

            <div>
              <label className="text-xs text-gray-500">Division</label>
              <select value={division} onChange={e => setDivision(e.target.value)}
                className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                <option value="all">All (combined)</option>
                {divisions.map(d => <option key={d} value={d}>{d} Division</option>)}
              </select>
            </div>
          </div>

          {/* Theme */}
          <div className="bg-white rounded-lg shadow-sm border p-4">
            <label className="block text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Theme</label>
            <div className="grid grid-cols-3 gap-2">
              {THEMES.map(t => (
                <button key={t.id} onClick={() => setThemeId(t.id)} title={t.label}
                  className={`h-9 rounded-md border-2 transition-all relative overflow-hidden
                    ${themeId === t.id ? 'border-[#c9a44c] ring-2 ring-[#c9a44c]/40 scale-105' : 'border-gray-200 hover:border-gray-300'}`}
                  style={{ background: buildTheme(t).swatch }}
                >
                  <span className="absolute inset-x-0 top-0 h-2" style={{ background: t.headerStops[0] }} />
                  <span className="absolute inset-x-0 top-2 h-0.5" style={{ background: t.headerRule }} />
                </button>
              ))}
            </div>
            <div className="text-[11px] text-gray-400 mt-1.5">{(THEMES.find(t => t.id === themeId) || THEMES[0]).label}</div>
          </div>

          {/* Export */}
          <div className="bg-white rounded-lg shadow-sm border p-4 space-y-3">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">Export</label>

            <div>
              <label className="text-xs text-gray-500">Custom Title (optional)</label>
              <input type="text" value={customTitle} onChange={e => setCustomTitle(e.target.value)}
                placeholder={titleText} maxLength={60}
                className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm" />
            </div>

            <button
              onClick={handleExport}
              disabled={exporting || loading || !rows.length}
              className="w-full py-2.5 rounded-lg bg-[#14365c] text-white font-bold text-sm
                hover:bg-[#0d2240] transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                flex items-center justify-center gap-2"
            >
              {exporting ? 'Exporting...' : 'Download PNG'}
            </button>
          </div>
        </div>

        {/* ═══ RIGHT: Canvas preview (the same canvas that exports) ═══ */}
        <div className="flex-1 flex flex-col items-center">
          <div className="text-xs text-gray-400 mb-2">Preview (1080×1080)</div>
          <div style={{
            width: SIZE.w * scale,
            maxWidth: '100%',
            borderRadius: 8,
            overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(13,34,64,0.25)',
          }}>
            <canvas ref={canvasRef} style={{ width: '100%', height: 'auto', display: 'block' }} />
          </div>
        </div>
      </div>
    </div>
  )
}
