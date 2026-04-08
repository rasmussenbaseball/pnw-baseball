import { useState, useRef, useCallback, useEffect } from 'react'

const API_BASE = '/api/v1'

// ── helpers ──
function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtDisplayDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// ── Clean team name for display ──
function cleanTeamName(name) {
  if (!name) return '???'
  let n = name.trim()
  // Strip ranking prefixes: "No. 7 Oregon State" -> "Oregon State", "#5 UCLA" -> "UCLA"
  n = n.replace(/^(?:No\.\s*\d+\s+|#\d+\s+|\(\d+\)\s+)/i, '')
  // Strip trailing digits that got concatenated (e.g. "Gonzaga8" -> "Gonzaga")
  // Only strip if the last chars are digits NOT preceded by a space (real names like "D3" are fine)
  n = n.replace(/(?<=[a-zA-Z])(\d+)$/, '')
  return n.trim() || '???'
}

// Pick the best available team name
function getTeamName(game, side) {
  const short = side === 'away' ? game.away_short : game.home_short
  const full = side === 'away' ? game.away_team_name : game.home_team_name
  // Prefer short_name from teams table, fall back to full name from games table
  return cleanTeamName(short || full)
}

// ── Image loader with cache ──
const imgCache = {}
function loadImage(src) {
  if (imgCache[src]) return imgCache[src]
  const promise = new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
  imgCache[src] = promise
  return promise
}

// ── Draw a rounded rect ──
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

// ── Draw a single game card ──
async function drawGameCard(ctx, game, x, y, w, h) {
  const away = getTeamName(game, 'away')
  const home = getTeamName(game, 'home')
  const aScore = game.away_score ?? '-'
  const hScore = game.home_score ?? '-'
  const aWon = game.status === 'final' && Number(game.away_score) > Number(game.home_score)
  const hWon = game.status === 'final' && Number(game.home_score) > Number(game.away_score)

  // Drop shadow
  ctx.fillStyle = 'rgba(0,0,0,0.06)'
  roundRect(ctx, x + 1, y + 2, w, h, 6)
  ctx.fill()

  // Card background
  roundRect(ctx, x, y, w, h, 6)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 1
  ctx.stroke()

  // FINAL header bar
  const labelH = Math.max(13, Math.min(22, h * 0.22))
  ctx.save()
  roundRect(ctx, x, y, w, labelH, 6)
  ctx.clip()
  ctx.fillStyle = '#f8fafc'
  ctx.fillRect(x, y, w, labelH)
  ctx.restore()
  ctx.fillStyle = '#e2e8f0'
  ctx.fillRect(x + 1, y + labelH, w - 2, 1)

  const innings = game.innings && game.innings !== 9 ? ` (${game.innings})` : ''
  const finalFS = Math.max(7, Math.min(11, labelH * 0.55))
  ctx.fillStyle = '#475569'
  ctx.font = `800 ${finalFS}px "Inter", system-ui, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(`FINAL${innings}`, x + 8, y + labelH / 2 + 0.5)

  // Team rows
  const teamTop = y + labelH + 1
  const teamH = h - labelH - 1
  const rowH = teamH / 2

  // Logo size
  const logoSize = Math.max(12, Math.min(26, rowH * 0.6))

  // Font sizes
  const nameFS = Math.max(8, Math.min(18, rowH * 0.55))
  const scoreFS = Math.max(9, Math.min(22, rowH * 0.62))

  for (let i = 0; i < 2; i++) {
    const isAway = i === 0
    const teamName = isAway ? away : home
    const score = isAway ? aScore : hScore
    const won = isAway ? aWon : hWon
    const logo = isAway ? game.away_logo : game.home_logo
    const ry = teamTop + i * rowH
    const midY = ry + rowH / 2

    if (i === 1) {
      ctx.fillStyle = '#f1f5f9'
      ctx.fillRect(x + 6, ry, w - 12, 1)
    }

    // Logo (skip placeholder if no logo URL - just leave the space)
    const logoX = x + 10
    const logoY = midY - logoSize / 2
    let logoDrawn = false
    if (logo) {
      try {
        const img = await loadImage(logo)
        ctx.drawImage(img, logoX, logoY, logoSize, logoSize)
        logoDrawn = true
      } catch { /* skip */ }
    }

    // Measure score width first
    ctx.save()
    ctx.font = `800 ${scoreFS}px "Inter", system-ui, sans-serif`
    const scoreW = ctx.measureText(String(score)).width
    ctx.restore()

    // If logo was drawn, name starts after logo; otherwise start closer to edge
    const nameStartX = logoDrawn ? logoX + logoSize + 8 : x + 10
    const maxNameW = w - (nameStartX - x) - scoreW - 18

    // Team name
    ctx.fillStyle = won ? '#0f172a' : '#64748b'
    ctx.font = `${won ? '700' : '500'} ${nameFS}px "Inter", system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    let displayName = teamName
    while (ctx.measureText(displayName).width > maxNameW && displayName.length > 2) {
      displayName = displayName.slice(0, -1)
    }
    if (displayName !== teamName) displayName += '.'
    ctx.fillText(displayName, nameStartX, midY + 0.5)

    // Score
    ctx.fillStyle = won ? '#0f172a' : '#94a3b8'
    ctx.font = `${won ? '800' : '600'} ${scoreFS}px "Inter", system-ui, sans-serif`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(score), x + w - 10, midY + 0.5)
  }
}

// ── Solve layout ──
function solveLayout(totalGames, availableH, contentW) {
  const cardGap = totalGames > 30 ? 3 : totalGames > 20 ? 4 : 5
  const colGap = 10
  const maxCardW = totalGames <= 5 ? 500 : totalGames <= 14 ? 460 : 9999

  let bestCols = 1
  let bestCardH = 0

  for (let cols = 1; cols <= 4; cols++) {
    const rawColW = (contentW - (cols - 1) * colGap) / cols
    if (rawColW < 190 && cols > 1) continue

    const gamesPerCol = Math.ceil(totalGames / cols)
    const usedCardGaps = (gamesPerCol - 1) * cardGap
    const cardH = (availableH - usedCardGaps) / gamesPerCol

    if (totalGames <= 5 && cols === 1 && cardH >= 60) {
      bestCols = 1; bestCardH = Math.min(190, cardH); break
    }
    if (totalGames >= 6 && totalGames <= 16 && cols === 2 && cardH >= 50) {
      bestCols = 2; bestCardH = Math.min(140, cardH); break
    }
    if (totalGames >= 17 && totalGames <= 30 && cols === 3 && cardH >= 45) {
      bestCols = 3; bestCardH = Math.min(100, cardH); break
    }
    if (totalGames > 30 && cols >= 3 && cardH >= 38) {
      bestCols = cols; bestCardH = Math.min(80, cardH); break
    }
    if (cardH >= 45 && cardH > bestCardH) {
      bestCols = cols; bestCardH = Math.min(140, cardH)
    }
  }

  if (bestCardH === 0) {
    bestCols = 4
    const gpc = Math.ceil(totalGames / 4)
    bestCardH = Math.max(34, (availableH - (gpc - 1) * cardGap) / gpc)
  }

  const rawColW = (contentW - (bestCols - 1) * colGap) / bestCols
  const colW = Math.min(rawColW, maxCardW)
  const centered = colW < rawColW || (bestCols <= 2 && totalGames <= 10)

  return { cols: bestCols, colW, cardH: bestCardH, cardGap, colGap, centered }
}

// ── Main canvas renderer ──
async function renderGraphic(canvas, games, dateShort) {
  const W = 1080
  const H = 1080
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  const totalGames = games.length

  // White background
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  // Teal header bar
  const headerH = 72
  ctx.fillStyle = '#00687a'
  ctx.fillRect(0, 0, W, headerH)

  const pad = 24

  // NW logo mark
  ctx.fillStyle = 'rgba(255,255,255,0.2)'
  roundRect(ctx, pad, 18, 36, 36, 6)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 18px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('NW', pad + 18, 37)

  // PNW SCORES centered
  ctx.fillStyle = '#ffffff'
  ctx.font = '800 30px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('PNW SCORES', W / 2, headerH / 2)

  // Date & game count right
  ctx.textAlign = 'right'
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 13px "Helvetica Neue", "Arial", sans-serif'
  ctx.fillText(dateShort, W - pad, 29)
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.font = '400 10px "Helvetica Neue", "Arial", sans-serif'
  ctx.fillText(`${totalGames} Game${totalGames !== 1 ? 's' : ''}`, W - pad, 45)

  // Dark accent line
  ctx.fillStyle = '#0f172a'
  ctx.fillRect(0, headerH, W, 3)

  // Content area
  const contentTop = headerH + 3 + 16
  const footerH = 28
  const availableH = H - contentTop - footerH - 8
  const contentW = W - pad * 2

  const layout = solveLayout(totalGames, availableH, contentW)
  const { cols, colW, cardH, cardGap, colGap, centered } = layout

  // Distribute games evenly
  const gamesPerCol = Math.ceil(totalGames / cols)
  const columns = []
  for (let c = 0; c < cols; c++) {
    const start = c * gamesPerCol
    const end = Math.min(start + gamesPerCol, totalGames)
    columns.push(games.slice(start, end))
  }

  // Center columns
  const totalColsW = cols * colW + (cols - 1) * colGap
  const startX = centered ? pad + (contentW - totalColsW) / 2 : pad

  // Vertical centering
  const tallestColGames = Math.max(...columns.map(c => c.length))
  const usedH = tallestColGames * cardH + (tallestColGames - 1) * cardGap
  const extraV = Math.max(0, availableH - usedH)
  const vOffset = extraV > 40 ? extraV * 0.42 : 0

  // Render columns
  for (let c = 0; c < cols; c++) {
    const colX = startX + c * (colW + colGap)
    let cy = contentTop + vOffset
    for (let gi = 0; gi < columns[c].length; gi++) {
      await drawGameCard(ctx, columns[c][gi], colX, cy, colW, cardH)
      cy += cardH + cardGap
    }
  }

  // Footer
  const footY = H - footerH / 2
  ctx.fillStyle = '#e2e8f0'
  ctx.fillRect(pad, H - footerH - 2, W - pad * 2, 1)
  ctx.fillStyle = '#00687a'
  ctx.font = '700 11px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('PNWBASEBALLSTATS.COM', pad, footY)
  ctx.fillStyle = '#94a3b8'
  ctx.font = '500 9px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText('2026 Season', W - pad, footY)
}

// ── Component ──
export default function DailyScoresGraphic() {
  const [date, setDate] = useState(todayStr())
  const [games, setGames] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [rendered, setRendered] = useState(false)
  const canvasRef = useRef(null)

  const fetchGames = useCallback(async (d) => {
    setLoading(true)
    setError(null)
    setRendered(false)
    try {
      const res = await fetch(`${API_BASE}/games/by-date?date=${d}`)
      if (!res.ok) throw new Error(`API error: ${res.status}`)
      const data = await res.json()
      const final = (data.games || data || []).filter(g => g.status === 'final')
      setGames(final)
    } catch (err) {
      setError(err.message)
      setGames(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchGames(date) }, [date, fetchGames])

  const generate = useCallback(async () => {
    if (!games?.length || !canvasRef.current) return
    await renderGraphic(canvasRef.current, games, shortDate(date))
    setRendered(true)
  }, [games, date])

  useEffect(() => {
    if (games?.length > 0) generate()
  }, [games, generate])

  const download = () => {
    if (!canvasRef.current) return
    const link = document.createElement('a')
    link.download = `pnw-scores-${date}.png`
    link.href = canvasRef.current.toDataURL('image/png')
    link.click()
  }

  const finalCount = games?.length ?? 0

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Daily Scores Graphic</h1>
      <p className="text-sm text-gray-500 mb-5">
        Generate a shareable scoreboard image for any game day.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal"
        />
        <button
          onClick={() => setDate(todayStr())}
          className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 transition-colors"
        >
          Today
        </button>
        {rendered && (
          <button
            onClick={download}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-nw-teal hover:bg-nw-teal/90 transition-colors"
          >
            Download PNG
          </button>
        )}
      </div>

      {loading && <p className="text-sm text-gray-400 mb-4">Loading games...</p>}
      {error && <p className="text-sm text-red-500 mb-4">Error: {error}</p>}
      {!loading && games && finalCount === 0 && (
        <p className="text-sm text-gray-400 mb-4">No final games found for {fmtDisplayDate(date)}.</p>
      )}
      {!loading && finalCount > 0 && (
        <p className="text-sm text-gray-500 mb-4">{finalCount} game{finalCount !== 1 ? 's' : ''} on {fmtDisplayDate(date)}</p>
      )}

      <div className="rounded-lg overflow-hidden shadow-lg border border-gray-200 inline-block">
        <canvas
          ref={canvasRef}
          style={{ width: '100%', maxWidth: 540, height: 'auto', aspectRatio: '1/1', display: finalCount > 0 ? 'block' : 'none' }}
        />
      </div>
    </div>
  )
}
