import { useState, useCallback, useRef, useEffect } from 'react'
import { useApi } from '../hooks/useApi'

// ─── Canvas utilities (same as SocialGraphics) ───
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

function truncText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 0 && ctx.measureText(t + '...').width > maxW) t = t.slice(0, -1)
  return t + '...'
}

// ─── Theme ───
const THEME = {
  bg1: '#0a1628',
  bg2: '#0f2744',
  bg3: '#00687a',
  accent: '#7dd3fc',
  accentGlow: 'rgba(125,211,252,0.3)',
  textPrimary: '#ffffff',
  textSecondary: 'rgba(255,255,255,0.45)',
  textMuted: 'rgba(255,255,255,0.25)',
  border: 'rgba(255,255,255,0.08)',
  rowAlt: 'rgba(255,255,255,0.025)',
  playoffLine: 'rgba(125,211,252,0.4)',
  green: '#34d399',
  red: '#f87171',
}

// ─── Core render function (draws to any canvas context) ───
function renderStandings(ctx, W, H, conf, teams, faviconImg, logoImgs) {
  const font = 'Inter, Helvetica Neue, sans-serif'

  // ─── Background gradient ───
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

  // Decorative orbs
  const orb1 = ctx.createRadialGradient(W - 80, 80, 0, W - 80, 80, 200)
  orb1.addColorStop(0, 'rgba(0,104,122,0.3)')
  orb1.addColorStop(1, 'rgba(0,104,122,0)')
  ctx.fillStyle = orb1
  ctx.fillRect(0, 0, W, H)
  const orb2 = ctx.createRadialGradient(70, H - 70, 0, 70, H - 70, 150)
  orb2.addColorStop(0, 'rgba(0,138,158,0.15)')
  orb2.addColorStop(1, 'rgba(0,138,158,0)')
  ctx.fillStyle = orb2
  ctx.fillRect(0, 0, W, H)

  // ─── Layout constants ───
  const padX = 40
  const headerH = 140
  const footerH = 40
  const colHeaderH = 32
  const bodyTop = headerH + 8
  const bodyBottom = H - footerH - 8
  const tableH = bodyBottom - bodyTop - colHeaderH
  const rowH = Math.floor(tableH / Math.max(teams.length, 1))
  const fontSize = Math.min(Math.max(Math.floor(rowH * 0.42), 13), 20)
  const logoSize = Math.min(Math.floor(rowH * 0.6), 28)

  // ─── Header ───
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

  // Conference name
  ctx.font = `900 42px ${font}`
  ctx.fillStyle = THEME.textPrimary
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.shadowColor = THEME.accentGlow
  ctx.shadowBlur = 40
  ctx.fillText(conf.conference_name, padX, curY)
  ctx.shadowBlur = 0
  ctx.shadowColor = 'transparent'
  curY += 52

  const divLabel = conf.division_level === 'JUCO' ? 'NWAC' : conf.division_name
  ctx.font = `500 16px ${font}`
  ctx.fillStyle = THEME.textSecondary
  ctx.fillText(`2026 Conference Standings  |  ${divLabel}`, padX, curY)

  // Header border
  ctx.strokeStyle = THEME.border
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, headerH)
  ctx.lineTo(W, headerH)
  ctx.stroke()

  // ─── Column layout ───
  const rankColX = padX
  const logoColX = padX + 28
  const nameColX = logoColX + logoSize + 8
  const cols = [
    { label: 'OVERALL', x: 520, w: 80 },
    { label: 'CONF', x: 610, w: 75 },
    { label: 'REM', x: 695, w: 45 },
    { label: 'SOS', x: 750, w: 45 },
    { label: 'GB', x: 808, w: 50 },
    { label: teams[0]?.rank_label || 'RANK', x: 880, w: 60 },
  ]

  // Column headers
  const colY = bodyTop
  ctx.font = `700 ${Math.floor(fontSize * 0.55)}px ${font}`
  ctx.fillStyle = THEME.textMuted
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText('TEAM', nameColX, colY + colHeaderH / 2)
  for (const col of cols) {
    ctx.textAlign = 'center'
    ctx.fillText(col.label, col.x, colY + colHeaderH / 2)
  }

  ctx.strokeStyle = THEME.border
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(padX, colY + colHeaderH)
  ctx.lineTo(W - padX, colY + colHeaderH)
  ctx.stroke()

  // ─── Data rows ───
  const rowStartY = colY + colHeaderH

  for (let i = 0; i < teams.length; i++) {
    const t = teams[i]
    const ry = rowStartY + i * rowH
    const cellCY = ry + rowH / 2

    // Alt row bg
    if (i % 2 === 1) {
      ctx.fillStyle = THEME.rowAlt
      ctx.fillRect(padX - 8, ry, W - padX * 2 + 16, rowH)
    }

    // Playoff line
    if (conf.playoff_spots && i === conf.playoff_spots - 1 && i < teams.length - 1) {
      ctx.strokeStyle = THEME.playoffLine
      ctx.lineWidth = 1.5
      ctx.setLineDash([6, 4])
      ctx.beginPath()
      ctx.moveTo(padX, ry + rowH)
      ctx.lineTo(W - padX, ry + rowH)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Rank
    ctx.font = `700 ${fontSize}px ${font}`
    ctx.fillStyle = THEME.textSecondary
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${i + 1}`, rankColX + 10, cellCY)

    // Logo
    if (logoImgs[i]) drawImageContain(ctx, logoImgs[i], logoColX, cellCY - logoSize / 2, logoSize, logoSize)

    // Name
    ctx.font = `600 ${fontSize}px ${font}`
    ctx.fillStyle = THEME.textPrimary
    ctx.textAlign = 'left'
    ctx.fillText(truncText(ctx, t.short_name || '', cols[0].x - nameColX - 20), nameColX, cellCY)

    // Overall W-L
    ctx.font = `500 ${fontSize}px ${font}`
    ctx.fillStyle = THEME.textPrimary
    ctx.textAlign = 'center'
    ctx.fillText(`${t.wins}-${t.losses}`, cols[0].x, cellCY)

    // Conf W-L
    ctx.fillText(`${t.conf_wins}-${t.conf_losses}`, cols[1].x, cellCY)

    // Conf games remaining
    ctx.fillStyle = THEME.textSecondary
    ctx.fillText(`${t.conf_games_remaining ?? '-'}`, cols[2].x, cellCY)

    // SOS remaining rank
    if (t.sos_remaining_rank != null) {
      const total = teams.length
      const pct = (t.sos_remaining_rank - 1) / Math.max(total - 1, 1)
      if (pct < 0.33) ctx.fillStyle = THEME.red
      else if (pct > 0.66) ctx.fillStyle = THEME.green
      else ctx.fillStyle = THEME.textSecondary
      ctx.fillText(`${t.sos_remaining_rank}`, cols[3].x, cellCY)
    } else {
      ctx.fillStyle = THEME.textMuted
      ctx.fillText('-', cols[3].x, cellCY)
    }

    // Games back (from playoff cutoff)
    const gb = t.games_back
    if (gb != null && gb <= 0) {
      // In playoff position or tied for cutoff
      ctx.fillStyle = THEME.accent
      if (gb === 0) ctx.fillText('-', cols[4].x, cellCY)
      else ctx.fillText(`+${Math.abs(gb) % 1 === 0 ? Math.abs(gb) : Math.abs(gb).toFixed(1)}`, cols[4].x, cellCY)
    } else if (gb != null) {
      ctx.fillStyle = THEME.textSecondary
      ctx.fillText(`${gb % 1 === 0 ? gb : gb.toFixed(1)}`, cols[4].x, cellCY)
    } else {
      ctx.fillStyle = THEME.textMuted
      ctx.fillText('-', cols[4].x, cellCY)
    }

    // National/PPI rank
    if (t.rank != null) {
      ctx.font = `700 ${fontSize}px ${font}`
      ctx.fillStyle = THEME.accent
      ctx.fillText(`#${t.rank}`, cols[5].x, cellCY)
    } else {
      ctx.fillStyle = THEME.textMuted
      ctx.font = `500 ${fontSize}px ${font}`
      ctx.fillText('-', cols[5].x, cellCY)
    }
  }

  // ─── Footer ───
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
  ctx.fillText('pnwbaseballstats.com', padX, footerY + footerH / 2)

  ctx.textAlign = 'right'
  ctx.font = `400 11px ${font}`
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  ctx.fillText(`Updated ${today}`, W - padX, footerY + footerH / 2)

  if (conf.playoff_spots) {
    ctx.textAlign = 'center'
    ctx.font = `400 10px ${font}`
    ctx.fillStyle = THEME.playoffLine
    ctx.fillText(`--- Playoff cutoff (Top ${conf.playoff_spots})`, W / 2, footerY + footerH / 2)
  }
}


// ─── Main component ───
export default function ConferenceStandingsGraphic() {
  const [season] = useState(2026)
  const [selectedConf, setSelectedConf] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [images, setImages] = useState(null)  // { faviconImg, logoImgs }
  const canvasRef = useRef(null)

  const { data: result, loading } = useApi('/conference-standings-graphic', { season }, [season])
  const conferences = result?.conferences || []

  // Auto-select first conference
  if (conferences.length > 0 && selectedConf === null) {
    setSelectedConf(conferences[0].conference_id)
  }

  const activeConf = conferences.find(c => c.conference_id === selectedConf)

  // Load images when conference changes, then draw preview
  useEffect(() => {
    if (!activeConf || !activeConf.teams.length) return
    let cancelled = false

    async function loadAndDraw() {
      const [faviconImg, ...logoImgs] = await Promise.all([
        loadExportImage('/favicon.png'),
        ...activeConf.teams.map(t => loadExportImage(t.logo_url))
      ])
      if (cancelled) return
      setImages({ faviconImg, logoImgs })
    }

    loadAndDraw()
    return () => { cancelled = true }
  }, [activeConf?.conference_id, activeConf?.teams?.length])

  // Draw to preview canvas whenever images or data change
  useEffect(() => {
    if (!canvasRef.current || !activeConf || !images) return

    const canvas = canvasRef.current
    const W = 1080, H = 1080
    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    canvas.style.width = '100%'
    canvas.style.maxWidth = `${W}px`
    canvas.style.height = 'auto'
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)

    renderStandings(ctx, W, H, activeConf, activeConf.teams, images.faviconImg, images.logoImgs)
  }, [activeConf, images])

  // ─── Export handler ───
  const handleExport = useCallback(async () => {
    if (!activeConf || !activeConf.teams.length) return
    setExporting(true)
    try {
      const dpr = 2
      const W = 1080, H = 1080

      const [faviconImg, ...logoImgs] = await Promise.all([
        loadExportImage('/favicon.png'),
        ...activeConf.teams.map(t => loadExportImage(t.logo_url))
      ])

      const canvas = document.createElement('canvas')
      canvas.width = W * dpr
      canvas.height = H * dpr
      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)

      renderStandings(ctx, W, H, activeConf, activeConf.teams, faviconImg, logoImgs)

      const link = document.createElement('a')
      const safeName = activeConf.conference_abbrev || activeConf.conference_name.replace(/\s+/g, '-')
      link.download = `nwbb-standings-${safeName}-${season}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed. Check console for details.')
    } finally {
      setExporting(false)
    }
  }, [activeConf, season])

  // Group conferences by division for dropdown
  const grouped = {}
  for (const c of conferences) {
    const divKey = c.division_name
    if (!grouped[divKey]) grouped[divKey] = []
    grouped[divKey].push(c)
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Conference Standings</h1>
      <p className="text-sm text-gray-500 mb-5">
        Generate downloadable conference standings graphics for social media.
      </p>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* ═══ LEFT: Controls ═══ */}
        <div className="lg:w-72 shrink-0 space-y-4">
          <div className="bg-white rounded-lg shadow-sm border p-4 space-y-3">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">Conference</label>
            {loading ? (
              <p className="text-sm text-gray-400">Loading...</p>
            ) : (
              <select
                value={selectedConf || ''}
                onChange={(e) => { setSelectedConf(Number(e.target.value)); setImages(null) }}
                className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
              >
                {Object.entries(grouped).map(([divName, confs]) => (
                  <optgroup key={divName} label={divName}>
                    {confs.map(c => (
                      <option key={c.conference_id} value={c.conference_id}>
                        {c.conference_abbrev || c.conference_name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
          </div>

          <button
            onClick={handleExport}
            disabled={exporting || !activeConf}
            className="w-full px-4 py-2.5 bg-pnw-green text-white text-sm font-semibold rounded-lg hover:bg-pnw-forest transition-colors disabled:opacity-50"
          >
            {exporting ? 'Generating...' : 'Download PNG'}
          </button>
        </div>

        {/* ═══ RIGHT: Live Canvas Preview ═══ */}
        <div className="flex-1 min-w-0">
          {activeConf ? (
            <div className="bg-gray-900 rounded-lg shadow-sm border border-gray-700 p-2">
              <canvas ref={canvasRef} className="rounded" />
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow-sm border p-8 text-center text-gray-400">
              Select a conference to preview standings
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
