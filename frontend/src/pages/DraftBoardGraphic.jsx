import { useState, useCallback, useRef, useEffect } from 'react'
import { DRAFT_DATA, DRAFT_YEARS, getSchoolLogo } from '../data/draftData'

// ─── Theme (matches TopPerformersGraphic / AllConferenceGraphic) ───
const THEME = {
  bg1: '#0a1628', bg2: '#0f2744', bg3: '#00687a',
  accent: '#7dd3fc', accentGlow: 'rgba(125,211,252,0.3)',
  textPrimary: '#ffffff', textSecondary: 'rgba(255,255,255,0.55)',
  textMuted: 'rgba(255,255,255,0.3)', border: 'rgba(255,255,255,0.08)',
  cardBg: 'rgba(255,255,255,0.04)', cardBorder: 'rgba(255,255,255,0.1)',
  circleBg: 'rgba(255,255,255,0.08)',
  gold: '#fbbf24', up: '#4ade80', down: '#f87171',
}
const F = 'Inter, Helvetica Neue, sans-serif'

// ─── Canvas utilities ───
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
function drawImageContain(ctx, img, x, y, boxW, boxH) {
  if (!img) return
  const scale = Math.min(boxW / img.width, boxH / img.height)
  const dw = img.width * scale, dh = img.height * scale
  ctx.drawImage(img, x + (boxW - dw) / 2, y + (boxH - dh) / 2, dw, dh)
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
function truncText(ctx, text, maxW) {
  if (!text) return ''
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 0 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1)
  return t + '…'
}

// ─── Background / header / footer ───
function drawBackground(ctx, W, H) {
  const ang = 160 * Math.PI / 180
  const sinA = Math.sin(ang), cosA = Math.cos(ang)
  const halfDiag = (Math.abs(W * sinA) + Math.abs(H * cosA)) / 2
  const grad = ctx.createLinearGradient(
    W / 2 - halfDiag * sinA, H / 2 + halfDiag * cosA,
    W / 2 + halfDiag * sinA, H / 2 - halfDiag * cosA)
  grad.addColorStop(0, THEME.bg1)
  grad.addColorStop(0.35, THEME.bg2)
  grad.addColorStop(1, THEME.bg3)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, H)
  const orb1 = ctx.createRadialGradient(W - 80, 80, 0, W - 80, 80, 260)
  orb1.addColorStop(0, 'rgba(0,104,122,0.3)'); orb1.addColorStop(1, 'rgba(0,104,122,0)')
  ctx.fillStyle = orb1; ctx.fillRect(0, 0, W, H)
}
function drawHeader(ctx, W, padX, title, subtitle, faviconImg) {
  let curY = 16
  const sz = 36
  if (faviconImg) drawImageContain(ctx, faviconImg, padX, curY, sz, sz)
  ctx.font = `800 14px ${F}`
  ctx.fillStyle = THEME.textSecondary
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  let charX = padX + sz + 8
  for (const ch of 'NWBB STATS') { ctx.fillText(ch, charX, curY + sz / 2); charX += ctx.measureText(ch).width + 2 }
  curY += sz + 12
  ctx.font = `900 40px ${F}`
  ctx.fillStyle = THEME.textPrimary
  ctx.textBaseline = 'top'
  ctx.shadowColor = THEME.accentGlow; ctx.shadowBlur = 40
  ctx.fillText(title, padX, curY)
  ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'
  curY += 50
  ctx.font = `700 17px ${F}`
  ctx.fillStyle = THEME.accent
  ctx.fillText(subtitle, padX, curY)
  const headerH = 132
  ctx.strokeStyle = THEME.border; ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(0, headerH); ctx.lineTo(W, headerH); ctx.stroke()
  return headerH
}
function drawFooter(ctx, W, H) {
  const footerH = 40, footerY = H - footerH
  ctx.strokeStyle = THEME.border; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, footerY); ctx.lineTo(W, footerY); ctx.stroke()
  ctx.font = `500 12px ${F}`; ctx.fillStyle = THEME.textMuted
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  ctx.fillText('nwbaseballstats.com/draftboard', 40, footerY + footerH / 2)
  ctx.textAlign = 'right'; ctx.font = `400 11px ${F}`
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  ctx.fillText(`Updated ${today}`, W - 40, footerY + footerH / 2)
}

// ─── One ranked row (card height = cardH, content scales by s) ───
function isPrepOrJC(p) { return p.year === 'PREP' || /^JC/.test(p.year || '') }

function drawRow(ctx, x, y, w, cardH, s, p, logoImg) {
  // Horizontal positions scale more gently than fonts so text keeps its room.
  const sp = Math.min(s, 1.3)
  ctx.fillStyle = THEME.cardBg
  roundRect(ctx, x, y, w, cardH, 8); ctx.fill()
  ctx.strokeStyle = THEME.cardBorder; ctx.lineWidth = 1; ctx.stroke()
  const midY = y + cardH / 2

  // Rank (top 10 gold)
  ctx.font = `900 ${19 * s}px ${F}`
  ctx.fillStyle = p.rank <= 10 ? THEME.gold : THEME.accent
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
  ctx.fillText(String(p.rank), x + 42 * sp, midY)

  // School logo
  const lcx = x + 70 * sp, lr = 15 * sp
  ctx.fillStyle = THEME.circleBg
  ctx.beginPath(); ctx.arc(lcx, midY, lr + 2, 0, Math.PI * 2); ctx.fill()
  if (logoImg) drawImageContain(ctx, logoImg, lcx - lr + 2, midY - lr + 2, lr * 2 - 4, lr * 2 - 4)

  const nameX = x + 92 * sp
  let rightEdge = x + w - 12

  // Commitment (right-aligned, only HS/JC)
  if (isPrepOrJC(p) && p.commit) {
    ctx.font = `italic 600 ${12 * s}px ${F}`
    ctx.fillStyle = THEME.accent
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    ctx.fillText(p.commit, x + w - 12, midY + 9 * s)
    rightEdge = x + w - 12 - ctx.measureText(p.commit).width - 12
  }

  // Name
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  ctx.font = `700 ${15 * s}px ${F}`; ctx.fillStyle = THEME.textPrimary
  ctx.fillText(truncText(ctx, p.name, (x + w - 12) - nameX), nameX, midY - 8 * s)

  // Meta: POS • YEAR • School
  ctx.font = `500 ${11 * s}px ${F}`; ctx.fillStyle = THEME.textSecondary
  const meta = [p.pos, p.year, p.school].filter(Boolean).join('   •   ')
  ctx.fillText(truncText(ctx, meta, rightEdge - nameX), nameX, midY + 9 * s)
}

// ─── Fixed canvas: SAME dimensions for every board; content scales to fit ───
const W = 1080, H = 1080, PAD_X = 40, COL_GAP = 24
const BODY_TOP = 150, FOOTER_H = 48, ROW_GAP = 6, BASE_ROW = 52
const BODY_H = H - BODY_TOP - FOOTER_H
const COL_W = (W - PAD_X * 2 - COL_GAP) / 2
const TOP_N_OPTIONS = [10, 20, 30, 40, 50]

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
// How many prospects actually render for a board at a given Top N.
function boardCount(year, topN) {
  return Math.min(topN, (DRAFT_DATA[year]?.prospects || []).length)
}

function renderGraphic(ctx, year, images, topN) {
  const board = DRAFT_DATA[year]
  const prospects = (board?.prospects || []).slice(0, topN)
  drawBackground(ctx, W, H)
  drawHeader(ctx, W, PAD_X, `${board.year} MLB DRAFT BOARD`,
    `Pacific Northwest Top ${prospects.length} Prospects`, images['/favicon.png'])
  const perCol = Math.max(1, Math.ceil(prospects.length / 2))
  const rowH = BODY_H / perCol
  const s = clamp(rowH / BASE_ROW, 0.66, 1.7)
  prospects.forEach((p, i) => {
    const col = i < perCol ? 0 : 1
    const rowInCol = col === 0 ? i : i - perCol
    const x = PAD_X + col * (COL_W + COL_GAP)
    const y = BODY_TOP + rowInCol * rowH
    drawRow(ctx, x, y, COL_W, rowH - ROW_GAP, s, p, images[getSchoolLogo(p.school)])
  })
  drawFooter(ctx, W, H)
  return H
}

export default function DraftBoardGraphic() {
  const [year, setYear] = useState('26')
  const [topN, setTopN] = useState(30)
  const [images, setImages] = useState(null)
  const [exporting, setExporting] = useState(false)
  const canvasRef = useRef(null)

  // Load every unique school logo for the board
  useEffect(() => {
    let cancel = false
    setImages(null)
    ;(async () => {
      const prospects = DRAFT_DATA[year]?.prospects || []
      const srcs = new Set(['/favicon.png'])
      prospects.forEach((p) => srcs.add(getSchoolLogo(p.school)))
      const entries = await Promise.all([...srcs].map(async (s) => [s, await loadExportImage(s)]))
      if (cancel) return
      const map = {}
      entries.forEach(([s, img]) => { map[s] = img })
      setImages(map)
    })()
    return () => { cancel = true }
  }, [year])

  // Draw to the on-screen canvas
  useEffect(() => {
    if (!images || !canvasRef.current) return
    const dpr = 2
    const canvas = canvasRef.current
    canvas.width = W * dpr
    canvas.height = H * dpr
    canvas.style.width = '100%'
    canvas.style.maxWidth = `${W}px`
    canvas.style.height = 'auto'
    const ctx = canvas.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)
    renderGraphic(ctx, year, images, topN)
  }, [images, year, topN])

  const handleExport = useCallback(() => {
    if (!images) return
    setExporting(true)
    try {
      const dpr = 2
      const canvas = document.createElement('canvas')
      canvas.width = W * dpr
      canvas.height = H * dpr
      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)
      renderGraphic(ctx, year, images, topN)
      const link = document.createElement('a')
      link.download = `nwbb-${DRAFT_DATA[year].year}-draft-board-top${boardCount(year, topN)}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed. Check console for details.')
    } finally { setExporting(false) }
  }, [images, year, topN])

  return (
    <div>
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">Draft Board Graphic</h1>
      <p className="text-sm text-gray-500 mb-5">
        Shareable PNG of the {DRAFT_DATA[year]?.year} PNW MLB Draft Board.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={year}
          onChange={(e) => setYear(e.target.value)}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-nw-teal-light"
        >
          {DRAFT_YEARS.filter((y) => DRAFT_DATA[y]?.prospects?.length).map((y) => (
            <option key={y} value={y}>{DRAFT_DATA[y].year} Draft Board</option>
          ))}
        </select>
        <select
          value={topN}
          onChange={(e) => setTopN(Number(e.target.value))}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-nw-teal-light"
        >
          {TOP_N_OPTIONS.map((n) => (
            <option key={n} value={n}>Top {n}</option>
          ))}
        </select>
        <button
          onClick={handleExport}
          disabled={!images || exporting}
          className="px-4 py-1.5 text-sm font-semibold rounded bg-nw-teal text-white hover:bg-nw-teal-light disabled:opacity-50"
        >
          {exporting ? 'Exporting…' : '⬇ Download PNG'}
        </button>
      </div>

      {!images && <div className="py-10 text-center text-xs text-gray-400 animate-pulse">Rendering board…</div>}
      <div className="rounded-lg overflow-hidden shadow-sm border border-gray-200 dark:border-gray-700 inline-block">
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}
