// WclRecapGraphic — canvas-based daily WCL recap card.
//   /summer/recap
//
// Pulls /summer/scoreboard for the chosen date, then per-game
// /summer/games/{id} to find each side's top hitter + winning
// pitcher, and renders a 1080×1350 (Instagram-friendly) PNG card.
// Mirrors the spring DailyRecapGraphic pattern but leaner — summer
// data doesn't have per-game WPA so we derive top performers via
// simple box-score math.
//
// Download button writes a PNG named wcl-recap-YYYY-MM-DD.png.

import { useState, useRef, useCallback, useEffect } from 'react'

const API_BASE = '/api/v1'

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
  win:        '#1b5e20',
  loss:       '#b71c1c',
}

// ── Tiny helpers ───────────────────────────────────────────────
const fmtIP = (ip) => {
  if (ip == null) return '0.0'
  return Number(ip).toFixed(1)
}
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

// Tries to load. Returns null if it errors out (keeps the canvas
// draw resilient against a single missing logo).
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

// ── Derive each game's stars from /summer/games/{id} payload ───
//
// Without per-game WPA we score hitters with a simple linear weight:
//   H + 2B + 2*3B + 3*HR + 0.5*BB + 0.4*RBI + 0.3*R - 0.3*K
// And pick the winning pitcher first via the decision tag, falling
// back to the most-IP pitcher with the fewest ER on the winning side.
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
  const filtered = (rows || []).filter(r => r.is_home === sideIsHome && (r.ab || r.bb))
  if (!filtered.length) return null
  return filtered.sort((a, b) => scoreHitter(b) - scoreHitter(a))[0]
}

function pickWinningPitcher(pitchers, sideIsHome, winnerIsHome) {
  if (winnerIsHome !== sideIsHome) return null
  const side = (pitchers || []).filter(p => p.is_home === sideIsHome)
  // Explicit W decision wins
  const tagged = side.find(p => p.decision === 'W')
  if (tagged) return tagged
  // Fall back to longest outing with fewest earned runs
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
  return `${fmtIP(p.ip)} IP, ${p.h || 0} H, ${p.er || 0} ER, ${p.so || 0} K`
}

// ── Per-game card drawer ───────────────────────────────────────
async function drawGameCard(ctx, game, hitterAway, hitterHome, winPitcher, x, y, w, h) {
  // Card background
  ctx.fillStyle = C.card
  roundRect(ctx, x, y, w, h, 14)
  ctx.fill()
  ctx.strokeStyle = 'rgba(20,54,92,0.18)'
  ctx.lineWidth = 1
  ctx.stroke()

  const padX = 18
  const innerY = y + 16
  const logoSize = 56
  const teamColX = x + padX + logoSize + 14
  const scoreColX = x + w - padX

  const isFinal = game.status === 'final'
  const awayWon = isFinal && (game.away_score ?? 0) > (game.home_score ?? 0)
  const homeWon = isFinal && (game.home_score ?? 0) > (game.away_score ?? 0)

  // Status pill
  ctx.fillStyle = isFinal ? C.text_gray : C.gold
  ctx.font = '600 12px -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(isFinal ? 'FINAL' : game.status?.toUpperCase() || '—', x + padX, innerY)

  // Away row
  const rowH = 56
  const awayY = innerY + 12
  await drawTeamRow(ctx,
    x + padX, awayY, w - 2*padX, rowH,
    game.away_logo, game.away_short || game.away_team_name,
    game.away_score, awayWon, !awayWon && isFinal,
    teamColX, scoreColX,
    logoSize)

  // Home row
  const homeY = awayY + rowH + 4
  await drawTeamRow(ctx,
    x + padX, homeY, w - 2*padX, rowH,
    game.home_logo, game.home_short || game.home_team_name,
    game.home_score, homeWon, !homeWon && isFinal,
    teamColX, scoreColX,
    logoSize)

  // Stars line (winning pitcher + top hitter from winning side)
  const starsY = homeY + rowH + 18
  ctx.font = '700 11px -apple-system, sans-serif'
  ctx.fillStyle = C.gold
  ctx.textAlign = 'left'
  ctx.fillText('STARS', x + padX, starsY)

  ctx.font = '500 13px -apple-system, sans-serif'
  ctx.fillStyle = C.text
  let cursor = starsY + 18

  if (winPitcher) {
    ctx.fillStyle = C.text
    ctx.font = '700 13px -apple-system, sans-serif'
    ctx.fillText(`W: ${winPitcher.player_name}`, x + padX, cursor)
    cursor += 16
    ctx.font = '500 12px -apple-system, sans-serif'
    ctx.fillStyle = C.text_muted
    ctx.fillText(pitcherLine(winPitcher), x + padX, cursor)
    cursor += 18
  }
  // Top hitter from the winning side (or away if tied/exhibition)
  const winnerHitter = homeWon ? hitterHome : hitterAway
  if (winnerHitter) {
    ctx.fillStyle = C.text
    ctx.font = '700 13px -apple-system, sans-serif'
    ctx.fillText(`Hit: ${winnerHitter.player_name}`, x + padX, cursor)
    cursor += 16
    ctx.font = '500 12px -apple-system, sans-serif'
    ctx.fillStyle = C.text_muted
    ctx.fillText(hitterLine(winnerHitter), x + padX, cursor)
  }
}

async function drawTeamRow(ctx, x, y, w, h, logoUrl, name, score, won, lost, teamColX, scoreColX, logoSize) {
  const logo = logoUrl ? await tryLoad(logoUrl) : null
  // Logo (logoUrl is absolute path under /logos/summer/...)
  if (logo) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(x + logoSize / 2, y + h / 2, logoSize / 2, 0, Math.PI * 2)
    ctx.closePath()
    ctx.clip()
    ctx.drawImage(logo, x, y + (h - logoSize) / 2, logoSize, logoSize)
    ctx.restore()
  } else {
    ctx.fillStyle = '#e5e5e5'
    ctx.beginPath()
    ctx.arc(x + logoSize / 2, y + h / 2, logoSize / 2, 0, Math.PI * 2)
    ctx.fill()
  }

  // Team name
  ctx.textAlign = 'left'
  ctx.font = (won ? '800' : '600') + ' 22px -apple-system, sans-serif'
  ctx.fillStyle = lost ? C.text_gray : C.text
  // Truncate long names
  let display = name || '—'
  const maxW = scoreColX - teamColX - 70
  while (ctx.measureText(display).width > maxW && display.length > 4) {
    display = display.slice(0, -1)
  }
  ctx.fillText(display, teamColX, y + h / 2 + 8)

  // Score
  ctx.textAlign = 'right'
  ctx.font = (won ? '900' : '700') + ' 34px -apple-system, sans-serif'
  ctx.fillStyle = won ? C.navy : (lost ? C.text_gray : C.text)
  ctx.fillText(String(score ?? '—'), scoreColX, y + h / 2 + 11)
}

// ── Header / footer ────────────────────────────────────────────
function drawHeader(ctx, dateIso, gameCount, w) {
  // Gradient navy → gold
  const grad = ctx.createLinearGradient(0, 0, w, 120)
  grad.addColorStop(0, C.navy)
  grad.addColorStop(0.55, C.blue)
  grad.addColorStop(1, C.gold)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, 130)

  ctx.fillStyle = C.gold_light
  ctx.font = '900 13px -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('WEST COAST LEAGUE · RECAP', 40, 42)

  ctx.fillStyle = '#fff'
  ctx.font = '900 40px -apple-system, sans-serif'
  ctx.fillText(fmtDateLong(dateIso), 40, 86)

  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = '600 16px -apple-system, sans-serif'
  ctx.fillText(`${gameCount} game${gameCount !== 1 ? 's' : ''}`, 40, 112)
}

function drawFooter(ctx, w, h) {
  ctx.fillStyle = C.navy_dark
  ctx.fillRect(0, h - 60, w, 60)
  ctx.fillStyle = '#fff'
  ctx.font = '700 14px -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('nwbaseballstats.com/summer', 40, h - 26)
  ctx.font = '500 12px -apple-system, sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.textAlign = 'right'
  ctx.fillText('@nwbaseballstats', w - 40, h - 26)
}

// ── Main canvas drawer ─────────────────────────────────────────
async function renderRecap(canvas, dateIso, games, gameDetails) {
  const COLS = 2
  const W = 1080
  const CARD_H = 280
  const CARD_GAP = 14
  const HEADER_H = 130
  const FOOTER_H = 60
  const PADDING = 30
  const rows = Math.ceil(games.length / COLS)
  const H = HEADER_H + rows * (CARD_H + CARD_GAP) + PADDING + FOOTER_H

  canvas.width = W
  canvas.height = H

  const ctx = canvas.getContext('2d')
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, W, H)

  drawHeader(ctx, dateIso, games.length, W)

  const cardW = (W - PADDING * 2 - CARD_GAP) / COLS

  for (let i = 0; i < games.length; i++) {
    const game = games[i]
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const x = PADDING + col * (cardW + CARD_GAP)
    const y = HEADER_H + 14 + row * (CARD_H + CARD_GAP)
    const det = gameDetails[game.id] || {}
    const awayHitter = pickTopHitter(det.batting, false)
    const homeHitter = pickTopHitter(det.batting, true)
    const winnerIsHome = (game.home_score ?? 0) > (game.away_score ?? 0)
    const winPitcher = pickWinningPitcher(det.pitching, winnerIsHome, winnerIsHome)
    await drawGameCard(ctx, game, awayHitter, homeHitter, winPitcher, x, y, cardW, CARD_H)
  }

  drawFooter(ctx, W, H)
}

// ───────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────
export default function WclRecapGraphic() {
  const [date, setDate] = useState(() => {
    // Default to yesterday (most-recent completed slate)
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  })
  const [games, setGames] = useState([])
  const [details, setDetails] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const canvasRef = useRef(null)

  // Fetch games for the chosen date + box scores for each
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setGames([]); setDetails({})
    ;(async () => {
      try {
        // Calculate the exact window we need for the chosen date — picks
        // either the today + 0 ahead path (if date is in the past) or
        // a one-day-ahead window.
        const target = new Date(date + 'T00:00:00')
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const diffDays = Math.round((today - target) / 86400000)
        const back  = Math.max(0, Math.min(120, diffDays))
        const ahead = Math.max(0, Math.min(120, -diffDays))
        const r = await fetch(`${API_BASE}/summer/scoreboard?league=WCL&season=2026&days_back=${back}&days_ahead=${ahead}`)
        if (!r.ok) throw new Error(`scoreboard fetch failed: ${r.status}`)
        const all = await r.json()
        const onDate = all.filter(g => g.game_date === date)
        if (cancelled) return
        setGames(onDate)
        // Pull box scores in parallel
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

  // Render after data ready
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
        Pick a date, pull the slate, download a shareable 1080-wide PNG. Built for Twitter / IG.
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
