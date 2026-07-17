// RecruitingClassRankingsGraphic — /graphics/recruiting-classes
//
// A shareable 1080×1080 ranking card of PNW recruiting classes, ranked by
// class rating (average recruit score). Same MECHANISM as the WCL leaderboard
// graphic: one canvas used for BOTH the live preview and the PNG export (so
// they can never drift), a theme picker, and a count control — here a 5-to-50
// slider so you can post a tight "Top 5" or the full "Top 50" board.
//
// Data: useRecruitingClasses(gradYear) → { classes: [...] }, already sorted by
// class_score desc. We keep only ranked classes (class_rank not null) and take
// the top N. Logos come straight from each row's logo_url (same-origin /logos
// paths load directly; the loader proxies any external URL for canvas export).

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRecruitingClasses } from '../hooks/useApi'

// ─── Fixed 1080×1080 ───
const SIZE = { w: 1080, h: 1080 }

const GRAD_YEARS = [2026, 2027]
const FONT = "-apple-system, 'Inter', 'Helvetica Neue', sans-serif"

// ─── Palette + themes ───
const C = {
  navy: '#14365c', navyDark: '#0d2240', blue: '#1f5485',
  gold: '#c9a44c', goldDeep: '#a9842f', goldLight: '#e2c577',
  cream: '#f6f1e3', teal: '#0f766e', tealDark: '#0b4f4a', tealLight: '#5eead4',
}

const THEMES = [
  {
    id: 'classic', label: 'Classic',
    bgStops: [C.cream, C.cream], grain: true,
    grainDark: 'rgba(20,54,92,0.05)', grainLight: 'rgba(255,255,255,0.6)',
    headerStops: [C.navy, C.blue], headerRule: C.gold,
    kicker: C.goldLight, headerText: '#ffffff', headerSub: 'rgba(255,255,255,0.85)',
    card: '#ffffff', cardBorder: 'rgba(20,54,92,0.16)', cardAccent: C.navy,
    name: C.navy, secondary: '#5a5a5a', muted: '#8a8a8a',
    colHeader: C.goldDeep, mainStat: C.navy, mainStatTop3: C.goldDeep,
    medals: [C.gold, C.goldLight, C.goldDeep], medalText: C.navyDark, medalRing: C.navyDark,
    rank: '#9a9483', logoFallback: '#e8e4d6',
    footerBg: C.navyDark, footerText: '#ffffff', footerMuted: 'rgba(255,255,255,0.7)',
  },
  {
    id: 'navy', label: 'Navy Night',
    bgStops: [C.navyDark, C.navy, C.blue], grain: false,
    headerStops: [C.navyDark, C.navyDark], headerRule: C.gold,
    kicker: C.goldLight, headerText: '#ffffff', headerSub: 'rgba(246,241,227,0.75)',
    card: 'rgba(246,241,227,0.07)', cardBorder: 'rgba(226,197,119,0.28)', cardAccent: C.gold,
    name: C.cream, secondary: 'rgba(246,241,227,0.6)', muted: 'rgba(246,241,227,0.4)',
    colHeader: C.goldLight, mainStat: C.goldLight, mainStatTop3: C.goldLight,
    medals: [C.gold, C.goldLight, C.goldDeep], medalText: C.navyDark, medalRing: C.goldLight,
    rank: 'rgba(246,241,227,0.45)', logoFallback: 'rgba(246,241,227,0.12)',
    footerBg: 'rgba(0,0,0,0.35)', footerText: C.cream, footerMuted: 'rgba(246,241,227,0.6)',
  },
  {
    id: 'teal', label: 'NWBB Teal',
    bgStops: [C.cream, '#e6f2f0'], grain: true,
    grainDark: 'rgba(15,118,110,0.06)', grainLight: 'rgba(255,255,255,0.6)',
    headerStops: [C.teal, C.tealDark], headerRule: C.tealLight,
    kicker: C.tealLight, headerText: '#ffffff', headerSub: 'rgba(255,255,255,0.85)',
    card: '#ffffff', cardBorder: 'rgba(15,118,110,0.18)', cardAccent: C.teal,
    name: C.tealDark, secondary: '#4b5f5c', muted: '#8aa19d',
    colHeader: C.teal, mainStat: C.tealDark, mainStatTop3: C.teal,
    medals: [C.teal, C.tealLight, C.tealDark], medalText: '#ffffff', medalRing: C.tealDark,
    rank: '#8aa19d', logoFallback: '#dcebe8',
    footerBg: C.tealDark, footerText: '#ffffff', footerMuted: 'rgba(255,255,255,0.7)',
  },
]

function buildTheme(p) {
  return { ...p, swatch: p.bgStops.length > 1 ? `linear-gradient(135deg, ${p.bgStops.join(', ')})` : p.bgStops[0] }
}

// ─── Canvas helpers (same as the WCL leaderboard graphic) ───
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
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y)
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
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const twoColumns = (count) => count > 15
const initials = (name) => (name || '').split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase()

// ════════════════════════════════════════════════════════════════
// Canvas renderer — one pipeline for preview AND export.
// ════════════════════════════════════════════════════════════════
async function renderBoard(canvas, { rows, title, subtitle, theme, count, twoCol }) {
  const dpr = 2
  const { w, h } = SIZE
  canvas.width = w * dpr; canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  // ── Background ──
  const bg = ctx.createLinearGradient(0, 0, w, h)
  const stops = theme.bgStops
  stops.forEach((c, i) => bg.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), c))
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h)
  if (theme.grain) {
    const rnd = mulberry32(1337)
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * w, y = rnd() * h
      ctx.fillStyle = rnd() > 0.5 ? theme.grainDark : theme.grainLight
      ctx.fillRect(x, y, 1, 1)
    }
  }

  // ── Header band ──
  const HEAD_H = 162
  const hg = ctx.createLinearGradient(0, 0, w, HEAD_H)
  theme.headerStops.forEach((c, i) => hg.addColorStop(i / (theme.headerStops.length - 1 || 1), c))
  ctx.fillStyle = hg; ctx.fillRect(0, 0, w, HEAD_H)
  ctx.fillStyle = theme.headerRule; ctx.fillRect(0, HEAD_H - 4, w, 4)

  const padX = 48
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = theme.kicker
  ctx.font = `800 20px ${FONT}`
  ctx.fillText('NWBB STATS · PNW RECRUITING', padX, 50)
  ctx.fillStyle = theme.headerText
  ctx.font = `800 44px ${FONT}`
  ctx.fillText(truncText(ctx, title, w - padX * 2), padX, 100)
  ctx.fillStyle = theme.headerSub
  ctx.font = `600 22px ${FONT}`
  ctx.fillText(subtitle, padX, 136)

  // ── Body layout ──
  const BODY_TOP = HEAD_H + 26
  const FOOT_H = 92
  const BODY_BOT = h - FOOT_H - 14
  const bodyH = BODY_BOT - BODY_TOP
  const perCol = twoCol ? Math.ceil(count / 2) : count
  const gap = 22
  const colW = twoCol ? (w - padX * 2 - gap) / 2 : (w - padX * 2)
  const rowH = bodyH / perCol
  const rowGap = clamp(rowH * 0.12, 3, 9)
  const cardH = rowH - rowGap

  const nameSize = clamp(rowH * 0.30, 13, 30)
  const subSize = clamp(rowH * 0.19, 9, 15)
  const scoreSize = clamp(rowH * 0.34, 15, 34)
  const showSub = rowH > 46
  const showTopCommit = !twoCol && rowH > 68

  for (let idx = 0; idx < rows.length && idx < count; idx++) {
    const r = rows[idx]
    const col = twoCol && idx >= perCol ? 1 : 0
    const rowInCol = idx - col * perCol
    const x = padX + col * (colW + gap)
    const y = BODY_TOP + rowInCol * rowH
    const rank = idx + 1

    // card
    ctx.fillStyle = theme.card
    roundRect(ctx, x, y, colW, cardH, clamp(cardH * 0.18, 6, 14)); ctx.fill()
    ctx.strokeStyle = theme.cardBorder; ctx.lineWidth = 1
    roundRect(ctx, x + 0.5, y + 0.5, colW - 1, cardH - 1, clamp(cardH * 0.18, 6, 14)); ctx.stroke()
    // left accent
    ctx.fillStyle = theme.cardAccent
    roundRect(ctx, x, y, 5, cardH, 2.5); ctx.fill()

    const cy = y + cardH / 2
    let cx = x + 18

    // rank medallion (top 3) or number
    const medalR = clamp(cardH * 0.30, 13, 26)
    if (rank <= 3) {
      ctx.beginPath(); ctx.arc(cx + medalR, cy, medalR, 0, Math.PI * 2)
      ctx.fillStyle = theme.medals[rank - 1]; ctx.fill()
      ctx.lineWidth = 1.5; ctx.strokeStyle = theme.medalRing; ctx.stroke()
      ctx.fillStyle = theme.medalText
      ctx.font = `800 ${clamp(medalR * 1.1, 13, 26)}px ${FONT}`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(String(rank), cx + medalR, cy + 1)
      cx += medalR * 2 + 14
    } else {
      ctx.fillStyle = theme.rank
      ctx.font = `800 ${clamp(rowH * 0.28, 13, 26)}px ${FONT}`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(String(rank), cx + medalR, cy + 1)
      cx += medalR * 2 + 14
    }

    // logo
    const logoBox = clamp(cardH * 0.72, 26, 58)
    const logoImg = await loadLogoCached(r.logo_url)
    if (logoImg) {
      drawImageContain(ctx, logoImg, cx, cy - logoBox / 2, logoBox, logoBox)
    } else {
      ctx.fillStyle = theme.logoFallback
      roundRect(ctx, cx, cy - logoBox / 2, logoBox, logoBox, 8); ctx.fill()
      ctx.fillStyle = theme.muted
      ctx.font = `800 ${logoBox * 0.34}px ${FONT}`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(initials(r.short_name || r.name), cx + logoBox / 2, cy + 1)
    }
    cx += logoBox + 16

    // score block (right)
    const scoreRightPad = 20
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    ctx.fillStyle = rank <= 3 ? theme.mainStatTop3 : theme.mainStat
    ctx.font = `900 ${scoreSize}px ${FONT}`
    const scoreStr = (r.class_score != null ? Number(r.class_score).toFixed(1) : '-')
    const scoreY = showSub ? cy - subSize * 0.55 : cy
    ctx.fillText(scoreStr, x + colW - scoreRightPad, scoreY)
    ctx.fillStyle = theme.muted
    ctx.font = `700 ${clamp(subSize, 9, 13)}px ${FONT}`
    if (showSub) {
      ctx.fillText(`${r.commits} commit${r.commits === 1 ? '' : 's'}`, x + colW - scoreRightPad, cy + subSize * 0.95)
    }
    const scoreW = ctx.measureText(scoreStr).width + 60

    // team name + sub (left, between logo and score)
    const textMaxW = (x + colW - scoreRightPad - scoreW) - cx
    ctx.textAlign = 'left'
    ctx.fillStyle = theme.name
    ctx.font = `800 ${nameSize}px ${FONT}`
    const nameY = showSub ? cy - subSize * (showTopCommit ? 1.0 : 0.65) : cy
    ctx.textBaseline = 'middle'
    ctx.fillText(truncText(ctx, r.short_name || r.name, textMaxW), cx, nameY)
    if (showSub) {
      ctx.fillStyle = theme.secondary
      ctx.font = `600 ${subSize}px ${FONT}`
      const sub = [r.division, r.conference].filter(Boolean).join(' · ')
      ctx.fillText(truncText(ctx, sub, textMaxW), cx, nameY + subSize * 1.3)
      if (showTopCommit && r.top_commit && r.top_commit.name) {
        ctx.fillStyle = theme.muted
        ctx.font = `600 ${subSize * 0.95}px ${FONT}`
        const tc = `Top: ${r.top_commit.name}${r.top_commit.position ? ` (${r.top_commit.position})` : ''}`
        ctx.fillText(truncText(ctx, tc, textMaxW), cx, nameY + subSize * 2.55)
      }
    }
  }

  // ── Footer ──
  const fy = h - FOOT_H
  ctx.fillStyle = theme.footerBg; ctx.fillRect(0, fy, w, FOOT_H)
  ctx.fillStyle = theme.headerRule; ctx.fillRect(0, fy, w, 2)
  const fav = await loadLogoCached('/favicon.png')
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  if (fav) drawImageContain(ctx, fav, padX, fy + 30, 28, 28)
  ctx.fillStyle = theme.footerText
  ctx.font = `800 20px ${FONT}`
  ctx.fillText('NWBB STATS', padX + 38, fy + 42)
  ctx.fillStyle = theme.footerMuted
  ctx.font = `700 18px ${FONT}`
  ctx.fillText('nwbaseballstats.com/recruiting-classes', padX + 38, fy + 68)
  ctx.textAlign = 'right'
  ctx.fillStyle = theme.footerMuted
  ctx.font = `600 16px ${FONT}`
  ctx.fillText('Class rating = avg recruit score (ranked commits)', w - padX, fy + 42)
  ctx.fillText('Rating 0–100 · min 3 rated commits to rank', w - padX, fy + 68)
}

// ════════════════════════════════════════════════════════════════
export default function RecruitingClassRankingsGraphic() {
  const [gradYear, setGradYear] = useState(2026)
  const [count, setCount] = useState(10)
  const [themeId, setThemeId] = useState('classic')
  const [customTitle, setCustomTitle] = useState('')
  const [exporting, setExporting] = useState(false)

  const canvasRef = useRef(null)
  const { data, loading } = useRecruitingClasses(gradYear)

  const theme = buildTheme(THEMES.find(t => t.id === themeId) || THEMES[0])
  const allRows = (data?.classes || []).filter(r => r.class_rank != null)
  const maxAvail = Math.max(5, allRows.length)
  const effCount = clamp(count, 5, Math.min(50, maxAvail))
  const rows = allRows.slice(0, effCount)
  const twoCol = twoColumns(effCount)

  const title = customTitle.trim() || `Top ${effCount} PNW Recruiting Classes`
  const subtitle = `${gradYear} Class · Ranked by class rating`

  const renderToken = useRef(0)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const token = ++renderToken.current
    if (loading || !rows.length) {
      // draw a simple placeholder so the preview isn't blank
      const ctx = canvas.getContext('2d')
      canvas.width = SIZE.w * 2; canvas.height = SIZE.h * 2
      ctx.setTransform(2, 0, 0, 2, 0, 0)
      ctx.fillStyle = theme.bgStops[0]; ctx.fillRect(0, 0, SIZE.w, SIZE.h)
      ctx.fillStyle = theme.muted; ctx.font = `600 24px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillText(loading ? 'Loading…' : 'No ranked classes for this year', SIZE.w / 2, SIZE.h / 2)
      return
    }
    renderBoard(canvas, { rows, title, subtitle, theme, count: effCount, twoCol })
      .catch(err => console.error('Recruiting board render failed:', err))
    return () => { if (renderToken.current === token) renderToken.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(rows), loading, themeId, title, subtitle, effCount, twoCol])

  const handleExport = useCallback(() => {
    if (!canvasRef.current || !rows.length) return
    setExporting(true)
    try {
      const a = document.createElement('a')
      a.download = `recruiting-classes-top${effCount}-${gradYear}.png`
      a.href = canvasRef.current.toDataURL('image/png')
      a.click()
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed. Check console for details')
    } finally { setExporting(false) }
  }, [rows.length, effCount, gradYear])

  const scale = Math.min(600 / SIZE.w, 800 / SIZE.h)

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">Recruiting Class Rankings Graphic</h1>
      <p className="text-sm text-gray-500 mb-5">
        Shareable 1080×1080 card of the top PNW recruiting classes, ranked by class rating. Choose 5 to 50 teams.
      </p>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* ═══ Controls ═══ */}
        <div className="lg:w-80 shrink-0 space-y-5">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 mb-1">Class year</label>
            <select
              value={gradYear}
              onChange={e => setGradYear(Number(e.target.value))}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600"
            >
              {GRAD_YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 mb-1">
              Teams to include: <span className="text-nw-teal">{effCount}</span>
            </label>
            <input
              type="range" min={5} max={Math.min(50, maxAvail)} step={1}
              value={effCount}
              onChange={e => setCount(Number(e.target.value))}
              className="w-full accent-nw-teal"
            />
            <div className="flex justify-between text-[11px] text-gray-400 mt-0.5">
              <span>5</span><span>{Math.min(50, maxAvail)}</span>
            </div>
            <div className="flex gap-1 mt-2">
              {[5, 10, 25, 50].filter(n => n <= maxAvail).map(n => (
                <button key={n} onClick={() => setCount(n)}
                  className={`flex-1 text-[11px] font-bold py-1 rounded border ${
                    effCount === n ? 'bg-nw-teal text-white border-nw-teal' : 'border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-300'}`}>
                  {n}
                </button>
              ))}
            </div>
            {allRows.length < 50 && !loading && (
              <p className="text-[11px] text-gray-400 mt-1">{allRows.length} ranked classes available for {gradYear}.</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 mb-1">Theme</label>
            <div className="flex gap-2">
              {THEMES.map(t => {
                const bt = buildTheme(t)
                return (
                  <button key={t.id} onClick={() => setThemeId(t.id)} title={t.label}
                    className={`flex-1 h-10 rounded border-2 ${themeId === t.id ? 'border-nw-teal' : 'border-transparent'}`}
                    style={{ background: bt.swatch }} />
                )
              })}
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 mb-1">Custom title (optional)</label>
            <input
              type="text" value={customTitle} maxLength={48}
              onChange={e => setCustomTitle(e.target.value)}
              placeholder={`Top ${effCount} PNW Recruiting Classes`}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600"
            />
          </div>

          <button
            onClick={handleExport}
            disabled={exporting || loading || !rows.length}
            className="w-full px-4 py-2.5 text-sm font-bold uppercase tracking-wider rounded bg-nw-teal text-white hover:bg-nw-teal-dark disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Download PNG'}
          </button>
        </div>

        {/* ═══ Preview ═══ */}
        <div className="flex-1 min-w-0">
          <div className="inline-block rounded-lg overflow-hidden shadow-lg border border-gray-200 dark:border-gray-700"
            style={{ width: SIZE.w * scale, height: SIZE.h * scale }}>
            <canvas
              ref={canvasRef}
              style={{ width: SIZE.w * scale, height: SIZE.h * scale, display: 'block' }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
