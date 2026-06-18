// TransferPortalGraphic — /graphics/portal-tracker  (dev/admin only)
//
// Shareable leaderboard graphic for the Transfer Portal Tracker and the JUCO
// (NWAC) Tracker. Styled after the WCL leaderboard graphic (cream paper, white
// rounded row cards, rank medallions, column headers, footer strip) but in a
// green PNWCBR co-brand. Fixed 1080x1080 canvas for EVERY size so all exports
// are identical dimensions; Top 10 = one column, Top 20/50 = two columns with
// the rows scaled to fit (the WCL density approach). Density-based stat columns
// (fewer stats as the list grows) keep each size legible.
//
// Data: /transfer-portal and /players/juco/uncommitted (recruiting-tier gated;
// dev users bypass). We over-fetch then filter/sort/top-N client-side.

import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'

const SIZE = { w: 1080, h: 1080 }   // ALWAYS this size, every board
const FONT = "-apple-system, 'Inter', 'Helvetica Neue', sans-serif"

// ── Green / PNWCBR theme (WCL layout, recolored) ──
const G = {
  cream: '#f6f1e3',
  green: '#15803d', greenMid: '#1f9d4d', greenDeep: '#166534',
  greenDk: '#0b3d1f', greenLight: '#9be8b6',
}
const THEME = {
  bgStops: [G.cream, G.cream], grain: true,
  grainDark: 'rgba(11,61,31,0.05)', grainLight: 'rgba(255,255,255,0.6)',
  headerStops: [G.greenDk, G.green], headerRule: G.greenLight,
  kicker: G.greenLight, headerText: '#ffffff', headerSub: 'rgba(255,255,255,0.85)',
  card: '#ffffff', cardBorder: 'rgba(11,61,31,0.16)', cardAccent: G.greenDeep,
  name: G.greenDk, secondary: '#5a5a5a', muted: '#8a8a8a', commit: G.green,
  colHeader: G.greenDeep, mainStat: G.greenDk, mainStatTop3: G.greenDeep,
  medals: [G.green, G.greenMid, G.greenDeep], medalText: '#ffffff', medalRing: G.greenDk,
  rank: '#9a9483', logoFallback: '#e6ece7',
  footerBg: G.greenDk, footerText: '#ffffff', footerMuted: 'rgba(255,255,255,0.72)',
}

// Stat tiers per size — fewer columns as the list grows.
const HIT_TIERS = {
  10: [['offensive_war','oWAR','war'],['batting_avg','AVG','avg'],['on_base_pct','OBP','avg'],['slugging_pct','SLG','avg'],['ops','OPS','avg'],['wrc_plus','wRC+','int']],
  20: [['offensive_war','oWAR','war'],['batting_avg','AVG','avg'],['ops','OPS','avg']],
  50: [['offensive_war','oWAR','war'],['ops','OPS','avg']],
}
const PIT_TIERS = {
  10: [['pitching_war','pWAR','war'],['era','ERA','era'],['fip','FIP','era'],['pitch_k_pct','K%','pct'],['pitch_bb_pct','BB%','pct'],['innings_pitched','IP','ip']],
  20: [['pitching_war','pWAR','war'],['fip','FIP','era'],['pitch_k_pct','K%','pct']],
  50: [['pitching_war','pWAR','war'],['fip','FIP','era']],
}
const SORT_KEY = { hitters: 'offensive_war', pitchers: 'pitching_war' }
const POSITIONS = {
  hitters: [['all','All'],['C','C'],['IF','IF'],['OF','OF'],['DH','DH']],
  pitchers: [['all','All'],['RHP','RHP'],['LHP','LHP']],
}

function fmt(val, format) {
  if (val == null || val === '') return '-'
  switch (format) {
    case 'avg': return Number(val).toFixed(3).replace(/^0/, '')
    case 'era': return Number(val).toFixed(2)
    case 'pct': return (Number(val) * 100).toFixed(1) + '%'
    case 'ip':  return Number(val).toFixed(1)
    case 'war': return Number(val).toFixed(1)
    case 'int': return Math.round(Number(val)).toString()
    default: return String(val)
  }
}
function fmtYr(y) {
  if (!y) return ''
  const m = { 'R-Fr': 'r-Fr', 'R-So': 'r-So', 'R-Jr': 'r-Jr', 'R-Sr': 'r-Sr' }
  return m[y] || y
}
const isPitcherPos = (pos) => {
  const u = (pos || '').toUpperCase()
  return u === 'P' || u === 'RHP' || u === 'LHP' || u === 'SP' || u === 'RP' || u.startsWith('RHP/') || u.startsWith('LHP/') || u.startsWith('P/')
}

async function authHeaders() {
  try {
    const { data } = await supabase.auth.getSession()
    const t = data?.session?.access_token
    return t ? { Authorization: `Bearer ${t}` } : {}
  } catch { return {} }
}
async function loadImg(src) {
  if (!src) return null
  const external = src.startsWith('http') && !src.includes(window.location.hostname)
  const url = external ? `/api/v1/proxy-image?url=${encodeURIComponent(src)}` : src
  try {
    const r = await fetch(url); if (!r.ok) return null
    const blob = await r.blob(); const ou = URL.createObjectURL(blob)
    return await new Promise(res => {
      const im = new Image()
      im.onload = () => { res(im); URL.revokeObjectURL(ou) }
      im.onerror = () => { res(null); URL.revokeObjectURL(ou) }
      im.src = ou
    })
  } catch { return null }
}
const _logoCache = {}
const cachedLogo = s => { if (!s) return Promise.resolve(null); if (!_logoCache[s]) _logoCache[s] = loadImg(s); return _logoCache[s] }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath()
}
function trunc(ctx, text, maxW) {
  text = text || ''
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1)
  return t + '…'
}
function contain(ctx, img, x, y, bw, bh) {
  if (!img) return
  const s = Math.min(bw / img.width, bh / img.height)
  const dw = img.width * s, dh = img.height * s
  ctx.drawImage(img, x + (bw - dw) / 2, y + (bh - dh) / 2, dw, dh)
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function renderBoard(canvas, opts) {
  const { items, config, title, kicker, subtitle, footerNote, count, twoCol, theme } = opts
  // Fonts must be ready before measureText/fillText or truncation math is wrong
  // (text overflows) on a cold render.
  try { if (document.fonts?.ready) await document.fonts.ready } catch { /* ignore */ }
  const w = SIZE.w, h = SIZE.h
  const dpr = 2
  canvas.width = w * dpr; canvas.height = h * dpr
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px'
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  // background + paper grain
  ctx.fillStyle = theme.bgStops[0]; ctx.fillRect(0, 0, w, h)
  if (theme.grain) {
    const rand = mulberry32(20260618)
    for (let i = 0; i < 1600; i++) {
      const x = rand() * w, y = rand() * h, s = rand() < 0.5 ? 1 : 2
      ctx.fillStyle = rand() < 0.5 ? theme.grainDark : theme.grainLight
      ctx.fillRect(x, y, s, s)
    }
  }

  // header band + accent rule
  const headerH = 150
  const hg = ctx.createLinearGradient(0, 0, w, headerH)
  theme.headerStops.forEach((c, i) => hg.addColorStop(i / (theme.headerStops.length - 1), c))
  ctx.fillStyle = hg; ctx.fillRect(0, 0, w, headerH)
  ctx.fillStyle = theme.headerRule; ctx.fillRect(0, headerH - 6, w, 6)

  const padX = 48
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = theme.kicker; ctx.font = `900 15px ${FONT}`
  ctx.fillText(kicker, padX, 48)
  let titleSize = 46
  ctx.font = `900 ${titleSize}px ${FONT}`
  while (titleSize > 24 && ctx.measureText(title).width > w - padX * 2 - 170) {
    titleSize -= 2; ctx.font = `900 ${titleSize}px ${FONT}`
  }
  ctx.fillStyle = theme.headerText; ctx.fillText(title, padX, 102)
  ctx.fillStyle = theme.headerSub; ctx.font = `600 17px ${FONT}`
  ctx.fillText(subtitle, padX, 130)

  // PNWCBR logo top-right (transparent mark -> white chip so it reads on green)
  const cbr = await cachedLogo('/images/cbr-logo.png')
  if (cbr) {
    const cw = 96, ch = 86, cx = w - padX - cw, cy = 30
    ctx.save(); ctx.fillStyle = '#fff'; roundRect(ctx, cx, cy, cw, ch, 12); ctx.fill(); ctx.restore()
    contain(ctx, cbr, cx + 7, cy + 6, cw - 14, ch - 12)
  }

  // footer strip
  const footerH = 56, footerY = h - footerH
  ctx.fillStyle = theme.footerBg; ctx.fillRect(0, footerY, w, footerH)
  ctx.fillStyle = theme.footerText; ctx.font = `700 15px ${FONT}`
  ctx.textAlign = 'left'; ctx.fillText('nwbaseballstats.com', 40, footerY + 35)
  ctx.fillStyle = theme.footerMuted; ctx.font = `500 13px ${FONT}`
  ctx.textAlign = 'right'; ctx.fillText('@nwbbstats', w - 40, footerY + 35)
  if (footerNote) { ctx.textAlign = 'center'; ctx.fillText(footerNote, w / 2, footerY + 35) }

  // body geometry
  const bodyPadX = 36
  const bodyTop = headerH + 16
  const bodyBottom = footerY - 14
  const colHeaderH = 26
  const bodyH = bodyBottom - bodyTop - colHeaderH

  const renderCount = Math.min(count, Math.max(items.length, 1))
  const columns = twoCol ? 2 : 1
  const colGap = twoCol ? 14 : 0
  const colWidth = (w - bodyPadX * 2 - colGap * (columns - 1)) / columns
  const itemsPerCol = Math.max(1, Math.ceil(renderCount / columns))
  const rowGap = twoCol ? 6 : Math.min(10, Math.max(4, Math.floor(60 / itemsPerCol) + 2))
  const rowH = Math.floor((bodyH - rowGap * (itemsPerCol - 1)) / itemsPerCol)

  // Scale text with row height so tall (Top 10/20) cards fill nicely instead of
  // floating small text in the upper-middle with dead space below.
  const fontSize = twoCol
    ? Math.min(Math.max(Math.round(rowH * 0.20), 12), 19)
    : Math.min(Math.max(Math.round(rowH * 0.22), 15), 24)
  const subSize = Math.max(Math.floor(fontSize * 0.64), 9)
  const threeLine = rowH >= 54          // room for name + meta + commitment
  const rankSize = twoCol ? Math.max(fontSize - 1, 13) : Math.max(fontSize, 16)
  const logoSize = Math.min(Math.floor(rowH * 0.6), twoCol ? 34 : 46)
  const extraCols = config.extra || []
  const mainStatW = twoCol ? Math.floor(colWidth * 0.17) : Math.floor(w * 0.105)
  const extraW = twoCol ? Math.floor(colWidth * 0.13) : Math.floor(w * 0.092)
  const rankW = twoCol ? Math.floor(colWidth * 0.085) : Math.floor(w * 0.05)
  const logoW = logoSize + (twoCol ? 6 : 10)
  const rowPadX = twoCol ? 8 : 14

  if (!items.length) {
    ctx.fillStyle = theme.name; ctx.font = `700 22px ${FONT}`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('No players match these filters', w / 2, (bodyTop + bodyBottom) / 2)
    return
  }

  const logoImgs = await Promise.all(items.slice(0, renderCount).map(p => cachedLogo(p.logo_url)))

  // column headers
  for (let col = 0; col < columns; col++) {
    const colX = bodyPadX + col * (colWidth + colGap)
    ctx.font = `800 ${Math.max(Math.floor(fontSize * 0.6), 10)}px ${FONT}`
    ctx.fillStyle = theme.colHeader
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    const hy = bodyTop + colHeaderH / 2 - 4
    ctx.fillText('PLAYER', colX + rowPadX + rankW + logoW, hy)
    let hx = colX + colWidth - rowPadX
    ctx.textAlign = 'right'
    for (let ei = extraCols.length - 1; ei >= 0; ei--) { ctx.fillText(extraCols[ei].label.toUpperCase(), hx, hy); hx -= extraW }
    ctx.fillText(config.label.toUpperCase(), hx, hy)
  }

  // rows
  const rowStartY = bodyTop + colHeaderH
  for (let i = 0; i < Math.min(renderCount, items.length); i++) {
    const p = items[i]
    const name = `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.name || '-'
    const bt = [p.bats, p.throws].filter(Boolean).join('/')
    const meta = [p.position, p.team_short || p.team_name, bt, fmtYr(p.year_in_school)].filter(Boolean).join(' · ')
    const commit = p.committed_to ? `→ ${p.committed_to}` : 'Uncommitted'
    const isTop3 = i < 3

    const col = twoCol ? Math.floor(i / itemsPerCol) : 0
    const rowInCol = twoCol ? i % itemsPerCol : i
    const x = bodyPadX + col * (colWidth + colGap)
    const y = rowStartY + rowInCol * (rowH + rowGap)
    const r = twoCol ? 8 : 12

    // card + border + accent bar
    ctx.fillStyle = theme.card; roundRect(ctx, x, y, colWidth, rowH, r); ctx.fill()
    ctx.strokeStyle = isTop3 ? theme.medals[i] : theme.cardBorder
    ctx.lineWidth = isTop3 ? 2 : 1; ctx.stroke()
    ctx.save(); roundRect(ctx, x, y, colWidth, rowH, r); ctx.clip()
    ctx.fillStyle = isTop3 ? theme.medals[i] : theme.cardAccent
    ctx.fillRect(x, y, 5, rowH); ctx.restore()

    let cellX = x + rowPadX
    const cy = y + rowH / 2

    // rank (medallion for top 3 in single col)
    if (isTop3 && !twoCol) {
      const mr = Math.min(rowH * 0.32, 22)
      ctx.beginPath(); ctx.arc(cellX + rankW / 2, cy, mr, 0, Math.PI * 2)
      ctx.fillStyle = theme.medals[i]; ctx.fill()
      ctx.strokeStyle = theme.medalRing; ctx.lineWidth = 1.5; ctx.stroke()
      ctx.fillStyle = theme.medalText; ctx.font = `900 ${Math.floor(mr * 1.05)}px ${FONT}`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), cellX + rankW / 2, cy + 1)
    } else {
      ctx.font = `900 ${rankSize}px ${FONT}`
      ctx.fillStyle = isTop3 ? theme.medals[i] : theme.rank
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), cellX + rankW / 2, cy)
    }
    cellX += rankW

    // team logo
    const li = logoImgs[i]
    if (li) contain(ctx, li, cellX, cy - logoSize / 2, logoSize, logoSize)
    else {
      ctx.fillStyle = theme.logoFallback; roundRect(ctx, cellX, cy - logoSize / 2, logoSize, logoSize, 4); ctx.fill()
      ctx.font = `700 ${Math.floor(logoSize * 0.34)}px ${FONT}`; ctx.fillStyle = theme.muted
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText((p.team_short || name).slice(0, 3).toUpperCase(), cellX + logoSize / 2, cy)
    }
    cellX += logoW

    // name + meta (+ commitment) — vertically centered around cy
    const statsEndX = x + colWidth - rowPadX
    const nameMaxW = Math.max(statsEndX - (extraCols.length * extraW + mainStatW) - cellX - 12, 60)
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    if (threeLine) {
      // three centered lines: name, meta, commitment
      const g1 = Math.round(fontSize * 0.74)   // name center -> meta center
      const g2 = Math.round(subSize * 1.32)    // meta center -> commitment center
      const c0 = cy - (g1 + g2) / 2            // first line (name) center
      ctx.font = `700 ${fontSize}px ${FONT}`; ctx.fillStyle = theme.name
      ctx.fillText(trunc(ctx, name, nameMaxW), cellX, c0)
      ctx.font = `500 ${subSize}px ${FONT}`; ctx.fillStyle = theme.secondary
      ctx.fillText(trunc(ctx, meta, nameMaxW), cellX, c0 + g1)
      ctx.font = `${p.committed_to ? 700 : 500} ${subSize}px ${FONT}`
      ctx.fillStyle = p.committed_to ? theme.commit : theme.muted
      ctx.fillText(trunc(ctx, commit, nameMaxW), cellX, c0 + g1 + g2)
    } else {
      // compact two lines (dense Top 50) — sized to the short row so the block
      // leaves padding above/below instead of filling the whole card.
      const nameC = Math.min(Math.max(Math.round(rowH * 0.38), 9), 14)
      const metaC = Math.max(Math.round(nameC * 0.72), 7)
      const nameY = cy - metaC / 2 - 1   // centers the two-line block around cy
      const metaY = cy + nameC / 2 + 1
      ctx.font = `700 ${nameC}px ${FONT}`; ctx.fillStyle = theme.name
      ctx.fillText(trunc(ctx, name, nameMaxW), cellX, nameY)
      const metaBase = p.committed_to ? [p.position, p.team_short || p.team_name].filter(Boolean).join(' · ') : meta
      ctx.font = `500 ${metaC}px ${FONT}`; ctx.fillStyle = theme.secondary
      const metaDrawn = trunc(ctx, metaBase, nameMaxW)
      ctx.fillText(metaDrawn, cellX, metaY)
      if (p.committed_to) {
        const mw = ctx.measureText(metaDrawn + ' ').width   // same 500 font as drawn
        const remaining = nameMaxW - mw
        if (remaining > 28) {
          ctx.font = `700 ${metaC}px ${FONT}`; ctx.fillStyle = theme.commit
          ctx.fillText(trunc(ctx, commit, remaining), cellX + mw, metaY)
        }
      }
    }

    // stats from right edge
    let sX = statsEndX
    ctx.textBaseline = 'middle'; ctx.textAlign = 'right'
    for (let ei = extraCols.length - 1; ei >= 0; ei--) {
      ctx.font = `600 ${Math.floor(fontSize * 0.82)}px ${FONT}`; ctx.fillStyle = theme.secondary
      ctx.fillText(fmt(p[extraCols[ei].key], extraCols[ei].format), sX, cy); sX -= extraW
    }
    ctx.font = `900 ${Math.floor(fontSize * (twoCol ? 1.05 : 1.25))}px ${FONT}`
    ctx.fillStyle = isTop3 ? theme.mainStatTop3 : theme.mainStat
    ctx.fillText(fmt(p[config.key], config.format), sX, cy)
  }
}

export default function TransferPortalGraphic() {
  const [board, setBoard] = useState('portal')
  const [side, setSide] = useState('hitters')
  const [count, setCount] = useState(10)
  const [position, setPosition] = useState('all')
  const [hideCommitted, setHideCommitted] = useState(false)
  const [rawRows, setRawRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const canvasRef = useRef(null)

  const SEASON = 2026

  useEffect(() => {
    let alive = true
    setLoading(true); setErr(null)
    const sortBy = SORT_KEY[side]
    const base = board === 'portal' ? '/api/v1/transfer-portal' : '/api/v1/players/juco/uncommitted'
    const params = new URLSearchParams({ season: String(SEASON), sort_by: sortBy, sort_dir: 'desc', limit: '150' })
    if (board === 'juco') params.set('year_in_school', 'So')
    ;(async () => {
      try {
        const r = await fetch(`${base}?${params}`, { headers: await authHeaders(), cache: 'no-store' })
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`)
        const d = await r.json()
        const arr = Array.isArray(d) ? d : (d.players || d.results || [])
        if (alive) { setRawRows(arr); setLoading(false) }
      } catch (e) { if (alive) { setErr(e.message); setLoading(false) } }
    })()
    return () => { alive = false }
  }, [board, side])

  const tier = (side === 'hitters' ? HIT_TIERS : PIT_TIERS)[count]
  const rows = (() => {
    let r = rawRows.slice()
    r = r.filter(p => side === 'pitchers' ? isPitcherPos(p.position) : !isPitcherPos(p.position))
    if (position !== 'all') {
      r = r.filter(p => {
        const u = (p.position || '').toUpperCase()
        if (position === 'IF') return ['1B', '2B', '3B', 'SS', 'IF'].some(z => u === z || u.includes('/' + z))
        if (position === 'OF') return ['OF', 'LF', 'CF', 'RF'].some(z => u === z || u.includes('/' + z))
        return u === position || u.startsWith(position + '/') || u.endsWith('/' + position)
      })
    }
    if (hideCommitted) r = r.filter(p => !p.committed_to)
    const k = SORT_KEY[side]
    r.sort((a, b) => (b[k] ?? -999) - (a[k] ?? -999))
    return r
  })()

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const config = { key: tier[0][0], label: tier[0][1], format: tier[0][2], extra: tier.slice(1).map(([k, l, f]) => ({ key: k, label: l, format: f })) }
    const kicker = board === 'portal' ? 'TRANSFER PORTAL · TRACKER' : 'NWAC JUCO · TRACKER'
    const title = `Top ${count} ${board === 'portal' ? 'Portal' : 'JUCO'} ${side === 'hitters' ? 'Hitters' : 'Pitchers'}`
    const subtitle = `Sorted by ${tier[0][1]} · ${SEASON}`
    renderBoard(canvas, {
      items: rows, config, title, kicker, subtitle,
      footerNote: 'in partnership with PNWCBR',
      count, twoCol: count >= 15, theme: THEME,
    }).catch(e => console.error('portal graphic render failed:', e))
  }, [rows, side, count, board, tier])

  useEffect(() => { if (!loading) redraw() }, [loading, redraw])

  function download() {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob(blob => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${board}-${side}-top${count}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    }, 'image/png')
  }

  const Btn = ({ on, onClick, children }) => (
    <button onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-sm font-semibold border ${on ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white dark:bg-gray-800 text-gray-600 border-gray-300 dark:border-gray-600 hover:border-emerald-600'}`}>
      {children}
    </button>
  )

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">Portal / JUCO Tracker Graphics</h1>
      <p className="text-sm text-gray-500 mb-4">Green PNWCBR co-branded leaderboard graphics for the Transfer Portal and NWAC JUCO trackers. Fixed 1080×1080 for every size.</p>

      <div className="flex flex-wrap gap-2 mb-3">
        <Btn on={board === 'portal'} onClick={() => setBoard('portal')}>Transfer Portal</Btn>
        <Btn on={board === 'juco'} onClick={() => setBoard('juco')}>JUCO Tracker</Btn>
        <span className="w-px bg-gray-300 mx-1" />
        <Btn on={side === 'hitters'} onClick={() => setSide('hitters')}>Hitters</Btn>
        <Btn on={side === 'pitchers'} onClick={() => setSide('pitchers')}>Pitchers</Btn>
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {[10, 20, 50].map(n => <Btn key={n} on={count === n} onClick={() => setCount(n)}>Top {n}</Btn>)}
        <span className="w-px bg-gray-300 mx-1" />
        <select value={position} onChange={e => setPosition(e.target.value)}
          className="px-2 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 text-sm bg-white dark:bg-gray-800">
          {POSITIONS[side].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300">
          <input type="checkbox" checked={hideCommitted} onChange={e => setHideCommitted(e.target.checked)} />
          Hide committed
        </label>
        <button onClick={download} className="ml-auto px-4 py-1.5 rounded-md bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800">⬇ Download PNG</button>
      </div>

      {err && <div className="mb-3 p-2.5 rounded bg-red-50 text-red-700 text-sm border border-red-200">Failed to load: {err}</div>}
      {loading && <div className="text-gray-500 py-8 text-center text-sm">Loading tracker data…</div>}
      <div className="overflow-x-auto">
        <canvas ref={canvasRef} className="rounded-lg shadow-lg max-w-full" style={{ display: loading ? 'none' : 'block' }} />
      </div>
      <p className="text-xs text-gray-400 mt-2">{rows.length} players match · showing top {Math.min(count, rows.length)}. Top 10 = one column; Top 20/50 = two columns (fewer stat columns shown as the list grows).</p>
    </div>
  )
}
