// WclRecapGraphic — canvas-based daily WCL recap card.
//   /summer/recap  (listed under the Graphics hub)
//
// Pulls /summer/scoreboard for the chosen date, then per-game
// /summer/games/{id} for each side's standout + R/H/E, and renders a
// FIXED 1080×1350 (Instagram 4:5) PNG. Game cards fill the middle so
// the card never has a runaway height. Each game shows the score with
// runs / hits / errors plus a compact winning-pitcher + top-hitter strip.
//
// Download button writes a PNG named wcl-recap-YYYY-MM-DD.png.

import { useState, useRef, useCallback, useEffect } from 'react'
import { CURRENT_SEASON } from '../lib/seasons'

const API_BASE = '/api/v1'

// Fixed Instagram-portrait canvas.
const W = 1080
const H = 1350

// ── Colors (WCL navy + gold theme) ─────────────────────────────
const C = {
  navy:       '#14365c',
  navy_dark:  '#0d2240',
  blue:       '#1f5485',
  gold:       '#c9a44c',
  gold_light: '#e2c577',
  bg:         '#f6f1e3',
  card:       '#ffffff',
  text:       '#1a1a1a',
  text_muted: '#5a5a5a',
  text_gray:  '#8a8a8a',
}

// ── Tiny helpers ───────────────────────────────────────────────
const fmtIP = (ip) => (ip == null ? '0.0' : Number(ip).toFixed(1))
const fmtDateLong = (iso) => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })
}
const todayKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

// Image cache so the same logo isn't fetched twice across redraws.
const imgCache = {}
function loadImage(src) {
  if (!src) return Promise.reject('no-src')
  if (imgCache[src]) return imgCache[src]
  const p = new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
  imgCache[src] = p
  return p
}
const tryLoad = (src) => loadImage(src).catch(() => null)

function roundRect(ctx, x, y, w, h, r) {
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

// Draw an image contained (no crop) within a box, centered.
function drawContain(ctx, img, x, y, box) {
  const ar = img.width / img.height
  let dw = box, dh = box
  if (ar > 1) dh = box / ar
  else dw = box * ar
  ctx.drawImage(img, x + (box - dw) / 2, y + (box - dh) / 2, dw, dh)
}

function truncate(ctx, text, maxW) {
  let s = text || ''
  while (s.length > 3 && ctx.measureText(s).width > maxW) s = s.slice(0, -1)
  return s
}

// ── Star derivation (no per-game WPA, so simple box-score math) ─
function scoreHitter(b) {
  return (b.h || 0) * 1
       + (b['2b'] || 0) * 1
       + (b['3b'] || 0) * 2
       + (b.hr || 0) * 3
       + (b.bb || 0) * 0.5
       + (b.rbi || 0) * 0.4
       + (b.r  || 0) * 0.3
       - (b.so || 0) * 0.3
}
function pickTopHitter(rows, sideIsHome) {
  const filtered = (rows || []).filter(r => r.is_home === sideIsHome && (r.ab || r.bb) && (r.h || r.rbi || r.bb || r.hr))
  if (!filtered.length) return null
  return filtered.sort((a, b) => scoreHitter(b) - scoreHitter(a))[0]
}
function pickWinningPitcher(pitchers, winnerIsHome) {
  const side = (pitchers || []).filter(p => p.is_home === winnerIsHome)
  const tagged = side.find(p => p.decision === 'W')
  if (tagged) return tagged
  return side.slice().sort((a, b) => {
    const ipA = a.ip || 0, ipB = b.ip || 0
    if (ipA !== ipB) return ipB - ipA
    return (a.er || 0) - (b.er || 0)
  })[0]
}
function hitterLine(b) {
  if (!b) return ''
  const parts = [`${b.h ?? 0}-${b.ab ?? 0}`]
  if (b.hr) parts.push(`${b.hr} HR`)
  if (b['2b']) parts.push(`${b['2b']} 2B`)
  if (b['3b']) parts.push(`${b['3b']} 3B`)
  if (b.rbi) parts.push(`${b.rbi} RBI`)
  if (b.bb) parts.push(`${b.bb} BB`)
  return parts.join(', ')
}
function pitcherLine(p) {
  if (!p) return ''
  return `${fmtIP(p.ip)} IP, ${p.er || 0} ER, ${p.so || 0} K`
}

// ── One team's scoreline: logo, name, then right-aligned R / H / E ─
async function drawScoreline(ctx, x, baseY, logoUrl, name, r, h, e, won, lost, cols) {
  const box = 38
  const logo = logoUrl ? await tryLoad(logoUrl) : null
  if (logo) drawContain(ctx, logo, x, baseY - box / 2, box)
  else { ctx.fillStyle = '#e8e4d6'; roundRect(ctx, x, baseY - box / 2, box, box, 6); ctx.fill() }

  ctx.textAlign = 'left'
  ctx.font = (won ? '800 ' : '600 ') + '21px -apple-system, sans-serif'
  ctx.fillStyle = lost ? C.text_gray : (won ? C.navy : C.text)
  const nameX = x + box + 12
  ctx.fillText(truncate(ctx, name || '—', cols.r - 34 - nameX), nameX, baseY + 7)

  ctx.textAlign = 'right'
  ctx.font = (won ? '900 ' : '800 ') + '26px -apple-system, sans-serif'
  ctx.fillStyle = won ? C.navy : (lost ? C.text_gray : C.text)
  ctx.fillText(String(r ?? '—'), cols.r, baseY + 9)
  ctx.font = '600 19px -apple-system, sans-serif'
  ctx.fillStyle = C.text_muted
  ctx.fillText(String(h ?? '—'), cols.h, baseY + 8)
  ctx.fillText(String(e ?? '—'), cols.e, baseY + 8)
}

// ── Per-game card ──────────────────────────────────────────────
async function drawGameCard(ctx, game, det, x, y, w, h) {
  ctx.fillStyle = C.card
  roundRect(ctx, x, y, w, h, 16); ctx.fill()
  ctx.strokeStyle = 'rgba(20,54,92,0.16)'; ctx.lineWidth = 1; ctx.stroke()
  // navy accent strip across the top
  ctx.save(); roundRect(ctx, x, y, w, h, 16); ctx.clip()
  ctx.fillStyle = C.navy; ctx.fillRect(x, y, w, 5); ctx.restore()

  const pad = 20
  const g = det.game || game
  const isFinal = game.status === 'final'
  const awayWon = isFinal && (g.away_score ?? 0) > (g.home_score ?? 0)
  const homeWon = isFinal && (g.home_score ?? 0) > (g.away_score ?? 0)

  const cols = { r: x + w - pad - 96, h: x + w - pad - 46, e: x + w - pad }

  // Performers (winning pitcher + winning side's top hitter)
  const winHitter = homeWon ? pickTopHitter(det.batting, true)
                  : awayWon ? pickTopHitter(det.batting, false)
                  : pickTopHitter(det.batting, false)
  const winPitcher = isFinal ? pickWinningPitcher(det.pitching, homeWon) : null
  const perfs = []
  if (winPitcher) perfs.push({ tag: 'WP',  bg: C.gold, name: winPitcher.player_name, line: pitcherLine(winPitcher) })
  if (winHitter)  perfs.push({ tag: 'BAT', bg: C.navy, name: winHitter.player_name,  line: hitterLine(winHitter) })

  // Content block height → vertically center within the (possibly tall) card.
  const rowH = 44
  const dividerH = perfs.length ? 16 : 0
  const perfH = perfs.length * 34
  const contentH = 18 + rowH * 2 + dividerH + perfH
  let cy = y + Math.max(20, (h - contentH) / 2) + 8

  // status (left) + R/H/E header (right)
  ctx.textAlign = 'left'
  ctx.font = '800 11px -apple-system, sans-serif'
  ctx.fillStyle = isFinal ? C.text_gray : C.gold
  ctx.fillText(isFinal ? (g.innings && g.innings !== 9 ? `FINAL / ${g.innings}` : 'FINAL')
                       : (game.status || '').toUpperCase(), x + pad, cy)
  ctx.textAlign = 'right'
  ctx.font = '800 11px -apple-system, sans-serif'
  ctx.fillStyle = C.gold
  ctx.fillText('R', cols.r, cy); ctx.fillText('H', cols.h, cy); ctx.fillText('E', cols.e, cy)
  cy += 22

  await drawScoreline(ctx, x + pad, cy + rowH / 2 - 6,
    g.away_logo, g.away_short || g.away_team_name,
    g.away_score, g.away_hits, g.away_errors, awayWon, homeWon, cols)
  cy += rowH
  await drawScoreline(ctx, x + pad, cy + rowH / 2 - 6,
    g.home_logo, g.home_short || g.home_team_name,
    g.home_score, g.home_hits, g.home_errors, homeWon, awayWon, cols)
  cy += rowH

  if (perfs.length) {
    cy += 4
    ctx.strokeStyle = 'rgba(201,164,76,0.55)'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x + pad, cy); ctx.lineTo(x + w - pad, cy); ctx.stroke()
    cy += 20
    for (const p of perfs) {
      const tagW = 32
      ctx.fillStyle = p.bg; roundRect(ctx, x + pad, cy - 12, tagW, 16, 4); ctx.fill()
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '800 10px -apple-system, sans-serif'
      ctx.fillText(p.tag, x + pad + tagW / 2, cy)
      const tx = x + pad + tagW + 9
      ctx.textAlign = 'left'; ctx.font = '700 13px -apple-system, sans-serif'; ctx.fillStyle = C.text
      const nm = truncate(ctx, p.name || '', w - 2 * pad - tagW - 120)
      ctx.fillText(nm, tx, cy)
      const nameW = ctx.measureText(nm).width
      ctx.font = '500 12px -apple-system, sans-serif'; ctx.fillStyle = C.text_muted
      const lnX = tx + nameW + 8
      ctx.fillText(truncate(ctx, p.line || '', x + w - pad - lnX), lnX, cy)
      cy += 34
    }
  }
}

// ── Header / footer ────────────────────────────────────────────
function drawHeader(ctx, dateIso, gameCount) {
  const grad = ctx.createLinearGradient(0, 0, W, 150)
  grad.addColorStop(0, C.navy)
  grad.addColorStop(0.55, C.blue)
  grad.addColorStop(1, C.gold)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, 150)

  ctx.fillStyle = C.gold_light
  ctx.font = '900 14px -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('WEST COAST LEAGUE · DAILY RECAP', 40, 48)

  ctx.fillStyle = '#fff'
  ctx.font = '900 44px -apple-system, sans-serif'
  ctx.fillText(fmtDateLong(dateIso), 40, 100)

  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = '600 17px -apple-system, sans-serif'
  ctx.fillText(`${gameCount} game${gameCount !== 1 ? 's' : ''}`, 40, 128)
}

function drawFooter(ctx) {
  ctx.fillStyle = C.navy_dark
  ctx.fillRect(0, H - 64, W, 64)
  ctx.fillStyle = '#fff'
  ctx.font = '700 15px -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('nwbaseballstats.com/summer', 40, H - 26)
  ctx.font = '500 13px -apple-system, sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.textAlign = 'right'
  ctx.fillText('@nwbbstats', W - 40, H - 26)
}

// ── Main canvas drawer (fixed 1080×1350) ───────────────────────
async function renderRecap(canvas, dateIso, games, gameDetails) {
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, W, H)

  drawHeader(ctx, dateIso, games.length)
  drawFooter(ctx)

  const n = games.length
  if (!n) return
  const HEADER_H = 150, FOOTER_H = 64, PAD = 30, GAP = 16
  const COLS = n === 1 ? 1 : 2
  const rows = Math.ceil(n / COLS)
  const top = HEADER_H + 18
  const availH = (H - FOOTER_H - 18) - top
  const cardW = (W - PAD * 2 - (COLS - 1) * GAP) / COLS
  // Cap card height so a sparse slate doesn't blow up to full height;
  // center the grid block vertically in the leftover space.
  const cardH = Math.min(360, (availH - (rows - 1) * GAP) / rows)
  const gridH = rows * cardH + (rows - 1) * GAP
  const startY = top + Math.max(0, (availH - gridH) / 2)

  for (let i = 0; i < n; i++) {
    const game = games[i]
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const x = PAD + col * (cardW + GAP)
    const y = startY + row * (cardH + GAP)
    await drawGameCard(ctx, game, gameDetails[game.id] || {}, x, y, cardW, cardH)
  }
}

// ───────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────
export default function WclRecapGraphic() {
  const [date, setDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  })
  const [games, setGames] = useState([])
  const [details, setDetails] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const canvasRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setGames([]); setDetails({})
    ;(async () => {
      try {
        const target = new Date(date + 'T00:00:00')
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const diffDays = Math.round((today - target) / 86400000)
        const back  = Math.max(0, Math.min(120, diffDays))
        const ahead = Math.max(0, Math.min(120, -diffDays))
        const r = await fetch(`${API_BASE}/summer/scoreboard?league=WCL&season=${CURRENT_SEASON}&days_back=${back}&days_ahead=${ahead}`)
        if (!r.ok) throw new Error(`scoreboard fetch failed: ${r.status}`)
        const all = await r.json()
        const onDate = all.filter(g => g.game_date === date)
        if (cancelled) return
        setGames(onDate)
        const dets = {}
        await Promise.all(onDate.map(async g => {
          try {
            const dr = await fetch(`${API_BASE}/summer/games/${g.id}`)
            if (dr.ok) dets[g.id] = await dr.json()
          } catch {}
        }))
        if (!cancelled) setDetails(dets)
      } catch (e) {
        if (!cancelled) setError(e.message || 'fetch failed')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [date])

  useEffect(() => {
    if (loading || !games.length || !canvasRef.current) return
    renderRecap(canvasRef.current, date, games, details).catch(e => setError(e.message))
  }, [loading, games, details, date])

  const download = useCallback(() => {
    if (!canvasRef.current) return
    const a = document.createElement('a')
    a.download = `wcl-recap-${date}.png`
    a.href = canvasRef.current.toDataURL('image/png')
    a.click()
  }, [date])

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4">
      <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">WCL Daily Recap Graphic</h1>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Pick a date and download a shareable 1080×1350 (Instagram) PNG with every game's score, runs / hits / errors, and standouts.
      </p>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">Date</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100"
          />
        </div>
        <button
          onClick={() => setDate(todayKey())}
          className="px-3 py-1.5 text-sm font-semibold rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Today
        </button>
        <button
          disabled={!games.length || loading}
          onClick={download}
          className="px-4 py-1.5 text-sm font-bold rounded bg-nw-teal text-white hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Download PNG
        </button>
      </div>

      {loading && <div className="text-sm text-gray-500 dark:text-gray-400">Loading {date}…</div>}
      {error && <div className="text-sm text-rose-600 dark:text-rose-400">Error: {error}</div>}
      {!loading && !error && games.length === 0 && (
        <div className="text-sm text-gray-500 dark:text-gray-400">No WCL games on {date}.</div>
      )}

      <div className="overflow-auto bg-white dark:bg-gray-900 rounded-md border border-gray-200 dark:border-gray-700 p-2">
        <canvas
          ref={canvasRef}
          style={{ maxWidth: '100%', height: 'auto', display: games.length ? 'block' : 'none' }}
        />
      </div>
    </div>
  )
}
