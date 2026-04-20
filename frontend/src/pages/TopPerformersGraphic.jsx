import { useState, useCallback, useRef, useEffect } from 'react'
import { useApi } from '../hooks/useApi'

// ─── Theme (matches AllConferenceGraphic / ConferenceStandingsGraphic) ───
const THEME = {
  bg1: '#0a1628',
  bg2: '#0f2744',
  bg3: '#00687a',
  accent: '#7dd3fc',
  accentGlow: 'rgba(125,211,252,0.3)',
  accentSoft: 'rgba(125,211,252,0.12)',
  accentBorder: 'rgba(125,211,252,0.35)',
  textPrimary: '#ffffff',
  textSecondary: 'rgba(255,255,255,0.55)',
  textMuted: 'rgba(255,255,255,0.3)',
  border: 'rgba(255,255,255,0.08)',
  cardBg: 'rgba(255,255,255,0.04)',
  cardBorder: 'rgba(255,255,255,0.1)',
  circleBg: 'rgba(255,255,255,0.08)',
  hitterAccent: '#7dd3fc',   // sky blue for hitters
  pitcherAccent: '#fb923c',  // warm orange for pitchers
}

const DIV_OPTIONS = ['ALL', 'D1', 'D2', 'D3', 'NAIA', 'JUCO']

// ─── Canvas utilities ───
async function loadExportImage(src) {
  if (!src) return null
  const isExternal = src.startsWith('http') && !src.includes(window.location.hostname)
  const url = isExternal
    ? `/api/v1/proxy-image?url=${encodeURIComponent(src)}`
    : src.startsWith('/') ? src : src
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

function drawImageContain(ctx, img, x, y, boxW, boxH) {
  if (!img) return
  const scale = Math.min(boxW / img.width, boxH / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, x + (boxW - dw) / 2, y + (boxH - dh) / 2, dw, dh)
}

function drawImageCover(ctx, img, cx, cy, r) {
  if (!img) return
  const size = r * 2
  const scale = Math.max(size / img.width, size / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()
  ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh)
  ctx.restore()
}

function truncText(ctx, text, maxW) {
  if (!text) return ''
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 0 && ctx.measureText(t + '...').width > maxW) t = t.slice(0, -1)
  return t + '...'
}

function roundRect(ctx, x, y, w, h, r) {
  if (w < 2 * r) r = w / 2
  if (h < 2 * r) r = h / 2
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// ─── Formatters ───
function fmtAvg(v) {
  if (v === null || v === undefined) return '-'
  return Number(v).toFixed(3).replace(/^0/, '')
}
function fmtInt(v) {
  if (v === null || v === undefined) return '-'
  return String(Math.round(v))
}
function fmtFloat(v, d = 2) {
  if (v === null || v === undefined) return '-'
  return Number(v).toFixed(d)
}
function fmtIp(v) {
  if (v === null || v === undefined) return '-'
  return Number(v).toFixed(1)
}
function fmtOps(v) {
  if (v === null || v === undefined) return '-'
  return Number(v).toFixed(3).replace(/^0/, '')
}

function isNwac(p) {
  return (p?.division || '').toUpperCase() === 'JUCO' || (p?.division || '').toUpperCase() === 'NWAC'
}

// ─── Background + header + footer ───
function drawBackground(ctx, W, H) {
  const ang = 160 * Math.PI / 180
  const sinA = Math.sin(ang), cosA = Math.cos(ang)
  const halfDiag = (Math.abs(W * sinA) + Math.abs(H * cosA)) / 2
  const cxG = W / 2, cyG = H / 2
  const grad = ctx.createLinearGradient(
    cxG - halfDiag * sinA, cyG + halfDiag * cosA,
    cxG + halfDiag * sinA, cyG - halfDiag * cosA
  )
  grad.addColorStop(0, THEME.bg1)
  grad.addColorStop(0.35, THEME.bg2)
  grad.addColorStop(1, THEME.bg3)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, H)

  const orb1 = ctx.createRadialGradient(W - 80, 80, 0, W - 80, 80, 220)
  orb1.addColorStop(0, 'rgba(0,104,122,0.3)')
  orb1.addColorStop(1, 'rgba(0,104,122,0)')
  ctx.fillStyle = orb1
  ctx.fillRect(0, 0, W, H)
  const orb2 = ctx.createRadialGradient(70, H - 70, 0, 70, H - 70, 180)
  orb2.addColorStop(0, 'rgba(0,138,158,0.18)')
  orb2.addColorStop(1, 'rgba(0,138,158,0)')
  ctx.fillStyle = orb2
  ctx.fillRect(0, 0, W, H)
}

function drawHeader(ctx, W, padX, title, subtitle, faviconImg) {
  const font = 'Inter, Helvetica Neue, sans-serif'
  let curY = 16
  const nwLogoSz = 36
  if (faviconImg) drawImageContain(ctx, faviconImg, padX, curY, nwLogoSz, nwLogoSz)

  ctx.font = `800 14px ${font}`
  ctx.fillStyle = THEME.textSecondary
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  let charX = padX + nwLogoSz + 8
  for (const ch of 'NWBB STATS') {
    ctx.fillText(ch, charX, curY + nwLogoSz / 2)
    charX += ctx.measureText(ch).width + 2
  }
  curY += nwLogoSz + 10

  // Title
  ctx.font = `900 40px ${font}`
  ctx.fillStyle = THEME.textPrimary
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.shadowColor = THEME.accentGlow
  ctx.shadowBlur = 40
  ctx.fillText(title, padX, curY)
  ctx.shadowBlur = 0
  ctx.shadowColor = 'transparent'
  curY += 48

  ctx.font = `700 18px ${font}`
  ctx.fillStyle = THEME.accent
  ctx.fillText(subtitle, padX, curY)

  const headerH = 140
  ctx.strokeStyle = THEME.border
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, headerH)
  ctx.lineTo(W, headerH)
  ctx.stroke()
  return headerH
}

function drawFooter(ctx, W, H) {
  const font = 'Inter, Helvetica Neue, sans-serif'
  const footerH = 40
  const footerY = H - footerH
  ctx.strokeStyle = THEME.border
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, footerY)
  ctx.lineTo(W, footerY)
  ctx.stroke()

  ctx.font = `500 12px ${font}`
  ctx.fillStyle = THEME.textMuted
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('nwbaseballstats.com', 40, footerY + footerH / 2)

  ctx.textAlign = 'right'
  ctx.font = `400 11px ${font}`
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  ctx.fillText(`Updated ${today}`, W - 40, footerY + footerH / 2)
}

// ─── Section title ───
function drawSectionTitle(ctx, label, x, y, w, accent) {
  const font = 'Inter, Helvetica Neue, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'

  // Accent bar at left
  ctx.fillStyle = accent
  ctx.fillRect(x, y + 4, 4, 18)

  ctx.font = `800 18px ${font}`
  ctx.fillStyle = THEME.textPrimary
  ctx.fillText(label, x + 12, y + 13)

  // Faint divider line after label
  const labelW = ctx.measureText(label).width
  const lineStart = x + 12 + labelW + 12
  ctx.strokeStyle = THEME.border
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(lineStart, y + 13)
  ctx.lineTo(x + w, y + 13)
  ctx.stroke()
}

// ─── Horizontal player card (2x5 grid use) ───
function drawPerfCard({ ctx, x, y, w, h, rank, player, headshotImg, logoImg, kind, accent }) {
  const font = 'Inter, Helvetica Neue, sans-serif'

  // Card background
  ctx.fillStyle = THEME.cardBg
  roundRect(ctx, x, y, w, h, 10)
  ctx.fill()
  ctx.strokeStyle = THEME.cardBorder
  ctx.lineWidth = 1
  ctx.stroke()

  // Left colored accent stripe (thin)
  ctx.fillStyle = accent
  ctx.beginPath()
  ctx.moveTo(x, y + 10)
  ctx.lineTo(x + 3, y + 10)
  ctx.lineTo(x + 3, y + h - 10)
  ctx.lineTo(x, y + h - 10)
  ctx.closePath()
  ctx.fill()

  if (!player) {
    ctx.font = `500 12px ${font}`
    ctx.fillStyle = THEME.textMuted
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('—', x + w / 2, y + h / 2)
    return
  }

  const imgCY = y + h / 2

  // ── Fixed-pixel zones (guarantees no overlap at any card width) ──
  const rankCX = x + 22
  const imgR = Math.min(26, Math.floor(h * 0.36))
  const imgCX = x + 64
  const nameX = imgCX + imgR + 12
  const nameZoneEnd = x + 212
  const nameMaxW = nameZoneEnd - nameX

  const headlineCX = x + 250
  const gridLeftX = x + 296
  const gridRightX = x + w - 12
  const gridW = gridRightX - gridLeftX

  // Rank number (#1-#10)
  ctx.font = `900 18px ${font}`
  ctx.fillStyle = accent
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`#${rank}`, rankCX, imgCY)

  // Headshot / logo (NWAC = team logo)
  ctx.fillStyle = THEME.circleBg
  ctx.beginPath()
  ctx.arc(imgCX, imgCY, imgR + 2, 0, Math.PI * 2)
  ctx.fill()

  const useLogo = isNwac(player)
  if (useLogo) {
    if (logoImg) drawImageContain(ctx, logoImg, imgCX - imgR + 3, imgCY - imgR + 3, imgR * 2 - 6, imgR * 2 - 6)
  } else {
    if (headshotImg) drawImageCover(ctx, headshotImg, imgCX, imgCY, imgR)
    else if (logoImg) drawImageContain(ctx, logoImg, imgCX - imgR + 3, imgCY - imgR + 3, imgR * 2 - 6, imgR * 2 - 6)
  }
  ctx.strokeStyle = THEME.cardBorder
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(imgCX, imgCY, imgR, 0, Math.PI * 2)
  ctx.stroke()

  // Name + team block (with truncation)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `700 13px ${font}`
  ctx.fillStyle = THEME.textPrimary
  ctx.fillText(truncText(ctx, player.display_name || '', nameMaxW), nameX, imgCY - 3)

  // Team (small logo + short)
  ctx.textBaseline = 'middle'
  ctx.font = `500 11px ${font}`
  const tName = player.team_short || ''
  const miniSz = 12
  const gap = 4
  if (logoImg) {
    drawImageContain(ctx, logoImg, nameX, imgCY + 12 - miniSz / 2, miniSz, miniSz)
  }
  ctx.fillStyle = THEME.textSecondary
  ctx.fillText(truncText(ctx, tName, nameMaxW - miniSz - gap), nameX + miniSz + gap, imgCY + 12)

  // Headline stat — wRC+ (hitters) or FIP+ (pitchers)
  const headline = kind === 'hitter'
    ? { label: 'wRC+', value: fmtInt(player.wrc_plus) }
    : { label: 'FIP+', value: fmtInt(player.fip_plus) }

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `800 10px ${font}`
  ctx.fillStyle = THEME.textMuted
  ctx.fillText(headline.label, headlineCX, imgCY - 16)

  ctx.font = `900 20px ${font}`
  ctx.fillStyle = accent
  ctx.fillText(headline.value, headlineCX, imgCY + 7)

  // Mini stat cells
  const stats = kind === 'hitter'
    ? [
        { label: 'PA', value: fmtInt(player.pa) },
        { label: 'H', value: fmtInt(player.hits) },
        { label: 'HR', value: fmtInt(player.home_runs) },
        { label: 'RBI', value: fmtInt(player.rbi) },
        { label: 'R', value: fmtInt(player.runs) },
        { label: 'BB', value: fmtInt(player.walks) },
        { label: 'SB', value: fmtInt(player.stolen_bases) },
        { label: 'K', value: fmtInt(player.strikeouts) },
      ]
    : [
        { label: 'IP', value: fmtIp(player.innings_pitched) },
        { label: 'H', value: fmtInt(player.hits_allowed) },
        { label: 'ER', value: fmtInt(player.earned_runs) },
        { label: 'BB', value: fmtInt(player.walks) },
        { label: 'K', value: fmtInt(player.strikeouts) },
        { label: 'HR', value: fmtInt(player.home_runs_allowed) },
      ]

  const cellW = gridW / stats.length
  for (let i = 0; i < stats.length; i++) {
    const cx = gridLeftX + cellW * i + cellW / 2
    ctx.font = `700 9px ${font}`
    ctx.fillStyle = THEME.textMuted
    ctx.fillText(stats[i].label, cx, imgCY - 16)
    ctx.font = `800 13px ${font}`
    ctx.fillStyle = THEME.textPrimary
    ctx.fillText(stats[i].value, cx, imgCY + 7)
  }
}

// ─── Main renderer (1080 × 1080) ───
function renderGraphic({ ctx, W, H, data, division, faviconImg, headshots, teamLogos }) {
  drawBackground(ctx, W, H)

  const padX = 40
  const weekLabel = data.week_label || `${data.week_start} - ${data.week_end}`
  drawHeader(ctx, W, padX, 'TOP PERFORMERS', `Week of ${weekLabel}${division !== 'ALL' ? `  ·  ${division}` : ''}`, faviconImg)
  drawFooter(ctx, W, H)

  const headerH = 140
  const footerH = 40
  const bodyTop = headerH + 10
  const bodyBottom = H - footerH - 8
  const bodyH = bodyBottom - bodyTop

  // Split body into two equal stacks (hitters + pitchers)
  const sectionGap = 14
  const sectionTitleH = 26
  const eachSectionH = (bodyH - sectionGap) / 2
  const rowsH = eachSectionH - sectionTitleH
  const rowsCount = 5
  const colsCount = 2
  const colGap = 12
  const rowGap = 8
  const colW = Math.floor((W - padX * 2 - colGap) / colsCount)
  const rowH = Math.floor((rowsH - rowGap * (rowsCount - 1)) / rowsCount)

  // ── Hitters ──
  const hittersY = bodyTop
  drawSectionTitle(ctx, 'TOP HITTERS', padX, hittersY, W - padX * 2, THEME.hitterAccent)
  const hittersGridY = hittersY + sectionTitleH
  for (let i = 0; i < 10; i++) {
    const r = Math.floor(i / 2)
    const c = i % 2
    const cx = padX + c * (colW + colGap)
    const cy = hittersGridY + r * (rowH + rowGap)
    const player = data.top_hitters[i] || null
    drawPerfCard({
      ctx,
      x: cx, y: cy, w: colW, h: rowH,
      rank: i + 1,
      player,
      headshotImg: player ? headshots[player.player_id] : null,
      logoImg: player ? teamLogos[player.team_id] : null,
      kind: 'hitter',
      accent: THEME.hitterAccent,
    })
  }

  // ── Pitchers ──
  const pitchersY = bodyTop + eachSectionH + sectionGap
  drawSectionTitle(ctx, 'TOP PITCHERS', padX, pitchersY, W - padX * 2, THEME.pitcherAccent)
  const pitchersGridY = pitchersY + sectionTitleH
  for (let i = 0; i < 10; i++) {
    const r = Math.floor(i / 2)
    const c = i % 2
    const cx = padX + c * (colW + colGap)
    const cy = pitchersGridY + r * (rowH + rowGap)
    const player = data.top_pitchers[i] || null
    drawPerfCard({
      ctx,
      x: cx, y: cy, w: colW, h: rowH,
      rank: i + 1,
      player,
      headshotImg: player ? headshots[player.player_id] : null,
      logoImg: player ? teamLogos[player.team_id] : null,
      kind: 'pitcher',
      accent: THEME.pitcherAccent,
    })
  }
}

// ─── Collect players + teams for image loading ───
function collectPlayersAndTeams(hitters, pitchers) {
  const players = new Map()
  const teams = new Map()
  const addRow = (p) => {
    if (!p) return
    if (p.player_id && p.headshot_url) players.set(p.player_id, p.headshot_url)
    if (p.team_id && p.team_logo) teams.set(p.team_id, p.team_logo)
  }
  hitters.forEach(addRow)
  pitchers.forEach(addRow)
  return { players, teams }
}

// ─── Main component ───
export default function TopPerformersGraphic() {
  const [season] = useState(2026)
  const [weekStart, setWeekStart] = useState(null)  // YYYY-MM-DD Monday
  const [divFilter, setDivFilter] = useState('ALL')
  const [exporting, setExporting] = useState(false)
  const [images, setImages] = useState(null)
  const canvasRef = useRef(null)

  // 1. Load the list of available weeks
  const { data: weeksData, loading: weeksLoading } = useApi(
    '/games/top-performer-weeks', { season }, [season]
  )

  // Auto-select the most recent week on first load
  useEffect(() => {
    if (!weekStart && weeksData?.weeks?.length > 0) {
      // Default to current week if present, otherwise most recent
      const current = weeksData.weeks.find(w => w.is_current)
      setWeekStart((current || weeksData.weeks[0]).week_start)
    }
  }, [weeksData, weekStart])

  // 2. Load performers for the selected week
  const { data: perfData, loading: perfLoading } = useApi(
    weekStart ? '/games/weekly-top-performers' : null,
    { week_start: weekStart, season },
    [weekStart, season]
  )

  // 3. Apply division filter + slice to top 10
  const filtered = perfData ? (() => {
    const hitters = (perfData.top_hitters || []).filter(
      p => divFilter === 'ALL' || (p.division || '').toUpperCase() === divFilter
    ).slice(0, 10)
    const pitchers = (perfData.top_pitchers || []).filter(
      p => divFilter === 'ALL' || (p.division || '').toUpperCase() === divFilter
    ).slice(0, 10)

    // Pretty week label
    const weekObj = weeksData?.weeks?.find(w => w.week_start === perfData.week_start)
    return {
      ...perfData,
      top_hitters: hitters,
      top_pitchers: pitchers,
      week_label: weekObj?.label || '',
    }
  })() : null

  // 4. Load images once we have filtered data
  useEffect(() => {
    if (!filtered) return
    let cancelled = false
    async function loadAll() {
      const { players, teams } = collectPlayersAndTeams(filtered.top_hitters, filtered.top_pitchers)
      const playerIds = [...players.keys()]
      const teamIds = [...teams.keys()]

      const [faviconImg, ...rest] = await Promise.all([
        loadExportImage('/favicon.png'),
        ...playerIds.map(pid => loadExportImage(players.get(pid))),
        ...teamIds.map(tid => loadExportImage(teams.get(tid))),
      ])
      if (cancelled) return

      const headshots = {}
      playerIds.forEach((pid, i) => { headshots[pid] = rest[i] })
      const teamLogos = {}
      teamIds.forEach((tid, i) => { teamLogos[tid] = rest[playerIds.length + i] })
      setImages({ faviconImg, headshots, teamLogos })
    }
    loadAll()
    return () => { cancelled = true }
  }, [filtered])

  // 5. Draw preview whenever data/images change
  useEffect(() => {
    if (!canvasRef.current || !filtered || !images) return
    const canvas = canvasRef.current
    const W = 1080, H = 1080
    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    canvas.style.width = '100%'
    canvas.style.maxWidth = `${W}px`
    canvas.style.height = 'auto'
    const ctx = canvas.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)
    renderGraphic({
      ctx, W, H, data: filtered, division: divFilter,
      faviconImg: images.faviconImg,
      headshots: images.headshots,
      teamLogos: images.teamLogos,
    })
  }, [filtered, images, divFilter])

  // 6. Export handler
  const handleExport = useCallback(async () => {
    if (!filtered || !images) return
    setExporting(true)
    try {
      const dpr = 2
      const W = 1080, H = 1080
      const canvas = document.createElement('canvas')
      canvas.width = W * dpr
      canvas.height = H * dpr
      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)
      renderGraphic({
        ctx, W, H, data: filtered, division: divFilter,
        faviconImg: images.faviconImg,
        headshots: images.headshots,
        teamLogos: images.teamLogos,
      })
      const link = document.createElement('a')
      link.download = `nwbb-top-performers-${filtered.week_start}-${divFilter}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed. Check console for details.')
    } finally {
      setExporting(false)
    }
  }, [filtered, images, divFilter])

  const loading = weeksLoading || perfLoading

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Top Performers Graphic</h1>
      <p className="text-sm text-gray-500 mb-5">
        Weekly top 10 hitters and top 10 pitchers across PNW baseball. Monday to Sunday.
      </p>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* ═══ LEFT: Controls ═══ */}
        <div className="lg:w-72 shrink-0 space-y-4">
          <div className="bg-white rounded-lg shadow-sm border p-4 space-y-2">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Week
            </label>
            <select
              value={weekStart || ''}
              onChange={(e) => { setWeekStart(e.target.value); setImages(null) }}
              disabled={!weeksData?.weeks?.length}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
            >
              {(weeksData?.weeks || []).map(w => (
                <option key={w.week_start} value={w.week_start}>
                  {w.is_current ? '★ ' : ''}{w.label}
                </option>
              ))}
            </select>
          </div>

          <div className="bg-white rounded-lg shadow-sm border p-4 space-y-2">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Division
            </label>
            <div className="grid grid-cols-3 gap-2">
              {DIV_OPTIONS.map(d => (
                <button
                  key={d}
                  onClick={() => setDivFilter(d)}
                  className={`px-2 py-1.5 text-xs font-semibold rounded border transition-colors ${
                    divFilter === d
                      ? 'bg-pnw-sky text-white border-pnw-sky'
                      : 'bg-white text-pnw-slate border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleExport}
            disabled={exporting || !filtered || !images}
            className="w-full px-4 py-2.5 bg-pnw-green text-white text-sm font-semibold rounded-lg hover:bg-pnw-forest transition-colors disabled:opacity-50"
          >
            {exporting ? 'Generating...' : 'Download PNG'}
          </button>

          {loading && (
            <p className="text-xs text-gray-400">Loading...</p>
          )}

          {filtered && !loading && (
            <div className="text-xs text-gray-500 space-y-1">
              <p>Games: {filtered.game_count || 0}</p>
              <p>Hitters: {filtered.top_hitters.length}</p>
              <p>Pitchers: {filtered.top_pitchers.length}</p>
            </div>
          )}
        </div>

        {/* ═══ RIGHT: Canvas preview ═══ */}
        <div className="flex-1 min-w-0">
          {filtered && images ? (
            <div className="bg-gray-900 rounded-lg shadow-sm border border-gray-700 p-2">
              <canvas ref={canvasRef} className="rounded" />
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow-sm border p-8 text-center text-gray-400">
              {loading ? 'Loading weekly top performers...' : 'Select a week to begin.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
