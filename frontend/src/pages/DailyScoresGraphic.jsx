import { useState, useRef, useCallback, useEffect } from 'react'

const API_BASE = '/api/v1'

const DIV_ORDER = ['D1', 'D2', 'D3', 'NAIA', 'JUCO']
const DIV_LABELS = {
  D1: 'NCAA D1', D2: 'NCAA D2', D3: 'NCAA D3',
  NAIA: 'NAIA', JUCO: 'NWAC',
}

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

function groupByDivision(games) {
  const groups = {}
  for (const g of games) {
    const div = g.home_division || g.away_division || 'Other'
    if (!groups[div]) groups[div] = []
    groups[div].push(g)
  }
  return DIV_ORDER
    .filter(d => groups[d]?.length > 0)
    .map(d => ({ division: d, label: DIV_LABELS[d] || d, games: groups[d] }))
    .concat(groups['Other']?.length ? [{ division: 'Other', label: 'Other', games: groups['Other'] }] : [])
}

// ── Canvas renderer ──
// Dynamically sizes to fit all games in a 1080x1080 square
async function renderGraphic(canvas, divGroups, dateLabel) {
  const W = 1080
  const H = 1080
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  // ── Background ──
  const bgGrad = ctx.createLinearGradient(0, 0, W * 0.3, H)
  bgGrad.addColorStop(0, '#060e18')
  bgGrad.addColorStop(0.25, '#0b1a2e')
  bgGrad.addColorStop(0.5, '#0a2235')
  bgGrad.addColorStop(0.75, '#091c2d')
  bgGrad.addColorStop(1, '#060e18')
  ctx.fillStyle = bgGrad
  ctx.fillRect(0, 0, W, H)

  // Subtle grid overlay
  ctx.strokeStyle = 'rgba(255,255,255,0.018)'
  ctx.lineWidth = 1
  for (let x = 0; x < W; x += 54) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke() }
  for (let y = 0; y < H; y += 54) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke() }

  // Top accent bar
  const barGrad = ctx.createLinearGradient(0, 0, W, 0)
  barGrad.addColorStop(0, 'transparent')
  barGrad.addColorStop(0.2, '#00687a')
  barGrad.addColorStop(0.5, '#22d3ee')
  barGrad.addColorStop(0.8, '#00687a')
  barGrad.addColorStop(1, 'transparent')
  ctx.fillStyle = barGrad
  ctx.fillRect(0, 0, W, 4)

  // ── Header ──
  const pad = 36
  let y = 28

  // NW logo mark
  ctx.fillStyle = '#00687a'
  const logoSize = 34
  ctx.beginPath()
  ctx.roundRect(pad, y - 2, logoSize, logoSize, 7)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 17px "Bebas Neue", "Arial Narrow", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('NW', pad + logoSize / 2, y + logoSize / 2)

  // Brand text
  ctx.textAlign = 'left'
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.font = '700 15px "Barlow Condensed", sans-serif'
  ctx.letterSpacing = '2px'
  ctx.fillText('NW BASEBALL STATS', pad + logoSize + 12, y + 12)
  ctx.fillStyle = 'rgba(255,255,255,0.3)'
  ctx.font = '500 9px "Inter", sans-serif'
  ctx.fillText('pnwbaseballstats.com', pad + logoSize + 12, y + 26)

  // Season badge (right side)
  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(0,180,216,0.08)'
  ctx.beginPath()
  ctx.roundRect(W - pad - 110, y, 110, 22, 4)
  ctx.fill()
  ctx.strokeStyle = 'rgba(0,180,216,0.15)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = '#22d3ee'
  ctx.font = '700 12px "Barlow Condensed", sans-serif'
  ctx.fillText('2026 SEASON', W - pad - 8, y + 15)

  // Date
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.font = '500 10px "Inter", sans-serif'
  ctx.fillText(dateLabel, W - pad, y + 38)

  y += 56

  // ── Title ──
  ctx.textAlign = 'left'
  ctx.fillStyle = '#ffffff'
  ctx.font = '400 52px "Bebas Neue", "Arial Narrow", sans-serif'
  ctx.fillText('DAILY SCORES', pad, y + 42)
  y += 50

  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = '500 14px "Barlow Condensed", sans-serif'
  ctx.fillText('Game results across all PNW divisions', pad, y + 8)
  y += 18

  // Divider
  const divGrad = ctx.createLinearGradient(pad, 0, W - pad, 0)
  divGrad.addColorStop(0, 'rgba(0,180,216,0.3)')
  divGrad.addColorStop(0.5, 'rgba(255,255,255,0.05)')
  divGrad.addColorStop(1, 'transparent')
  ctx.fillStyle = divGrad
  ctx.fillRect(pad, y + 4, W - pad * 2, 1)
  y += 12

  // ── Compute layout ──
  const totalGames = divGroups.reduce((n, g) => n + g.games.length, 0)
  const totalDivHeaders = divGroups.length
  const availableH = H - y - 40 // footer space

  // Calculate columns: 1 col for <=12 games, 2 for <=28, 3 for more
  const cols = totalGames <= 12 ? 1 : totalGames <= 28 ? 2 : 3
  const colW = (W - pad * 2 - (cols - 1) * 16) / cols

  // Distribute divisions across columns to balance heights
  const columns = Array.from({ length: cols }, () => [])
  const colHeights = new Array(cols).fill(0)

  for (const grp of divGroups) {
    // Find the shortest column
    let minIdx = 0
    for (let i = 1; i < cols; i++) {
      if (colHeights[i] < colHeights[minIdx]) minIdx = i
    }
    columns[minIdx].push(grp)
    colHeights[minIdx] += 1 + grp.games.length // 1 for header
  }

  const maxRows = Math.max(...colHeights)
  // Size each scorebug row to fill available space
  const rowH = Math.min(42, Math.max(24, availableH / maxRows - 2))
  const divHeaderH = rowH + 4
  const fontSize = Math.min(18, Math.max(11, rowH * 0.48))
  const scoreFontSize = Math.min(22, Math.max(13, rowH * 0.58))
  const teamFontSize = fontSize
  const logoH = Math.min(28, Math.max(14, rowH * 0.7))

  // ── Render columns ──
  for (let c = 0; c < cols; c++) {
    const colX = pad + c * (colW + 16)
    let cy = y

    for (const grp of columns[c]) {
      // Division header
      ctx.fillStyle = '#22d3ee'
      ctx.beginPath()
      ctx.arc(colX + 4, cy + divHeaderH / 2, 3, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = '#22d3ee'
      ctx.font = `700 ${Math.min(13, fontSize * 0.75)}px "Barlow Condensed", sans-serif`
      ctx.textAlign = 'left'
      ctx.fillText(grp.label.toUpperCase(), colX + 14, cy + divHeaderH / 2 + 4)
      cy += divHeaderH

      // Games
      for (const game of grp.games) {
        const away = game.away_short || game.away_team_name || '???'
        const home = game.home_short || game.home_team_name || '???'
        const aScore = game.away_score ?? '-'
        const hScore = game.home_score ?? '-'
        const aWon = game.status === 'final' && game.away_score > game.home_score
        const hWon = game.status === 'final' && game.home_score > game.away_score

        // Scorebug background
        ctx.fillStyle = 'rgba(255,255,255,0.025)'
        ctx.beginPath()
        ctx.roundRect(colX, cy, colW, rowH - 2, 6)
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.04)'
        ctx.lineWidth = 1
        ctx.stroke()

        const midY = cy + (rowH - 2) / 2
        const halfH = (rowH - 2) / 2

        // Away team (top half)
        // Logo placeholder
        const logoX = colX + 8
        const awayLogoY = midY - halfH / 2 - logoH / 4
        const homeLogoY = midY + halfH / 2 - logoH / 4

        // Away team name
        ctx.fillStyle = aWon ? '#ffffff' : 'rgba(255,255,255,0.55)'
        ctx.font = `${aWon ? '700' : '500'} ${teamFontSize}px "Barlow Condensed", sans-serif`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(away, logoX + logoH + 6, midY - halfH / 2 + 1)

        // Away score
        ctx.fillStyle = aWon ? '#22d3ee' : 'rgba(255,255,255,0.45)'
        ctx.font = `${aWon ? '800' : '600'} ${scoreFontSize}px "Barlow Condensed", sans-serif`
        ctx.textAlign = 'right'
        ctx.fillText(String(aScore), colX + colW - 10, midY - halfH / 2 + 1)

        // Thin separator line
        ctx.fillStyle = 'rgba(255,255,255,0.06)'
        ctx.fillRect(colX + 8, midY - 0.5, colW - 16, 1)

        // Home team name
        ctx.fillStyle = hWon ? '#ffffff' : 'rgba(255,255,255,0.55)'
        ctx.font = `${hWon ? '700' : '500'} ${teamFontSize}px "Barlow Condensed", sans-serif`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(home, logoX + logoH + 6, midY + halfH / 2 + 1)

        // Home score
        ctx.fillStyle = hWon ? '#22d3ee' : 'rgba(255,255,255,0.45)'
        ctx.font = `${hWon ? '800' : '600'} ${scoreFontSize}px "Barlow Condensed", sans-serif`
        ctx.textAlign = 'right'
        ctx.fillText(String(hScore), colX + colW - 10, midY + halfH / 2 + 1)

        // Try to load and draw logos
        if (game.away_logo) {
          try {
            const img = await loadImage(game.away_logo)
            ctx.drawImage(img, logoX, midY - halfH / 2 - logoH / 2 + 1, logoH, logoH)
          } catch { /* skip */ }
        }
        if (game.home_logo) {
          try {
            const img = await loadImage(game.home_logo)
            ctx.drawImage(img, logoX, midY + halfH / 2 - logoH / 2 + 1, logoH, logoH)
          } catch { /* skip */ }
        }

        cy += rowH
      }
      cy += 4 // gap after division
    }
  }

  // ── Footer ──
  const footY = H - 20
  ctx.fillStyle = 'rgba(0,180,216,0.12)'
  ctx.fillRect(pad, footY - 16, W - pad * 2, 1)

  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(0,180,216,0.5)'
  ctx.font = '700 13px "Barlow Condensed", sans-serif'
  ctx.fillText('PNWBASEBALLSTATS.COM', pad, footY)

  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(255,255,255,0.22)'
  ctx.font = '600 9px "Inter", sans-serif'
  ctx.fillText(`${totalGames} Games · All Divisions · 2026 Season`, W - pad, footY)
}

// Image loader with cache
const imgCache = {}
function loadImage(src) {
  if (imgCache[src]) return imgCache[src]
  const promise = new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    // Handle relative URLs
    img.src = src.startsWith('http') ? src : src
  })
  imgCache[src] = promise
  return promise
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
      // Only final games
      const final = (data.games || data || []).filter(g => g.status === 'final')
      setGames(final)
    } catch (err) {
      setError(err.message)
      setGames(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchGames(date)
  }, [date, fetchGames])

  const generate = useCallback(async () => {
    if (!games?.length || !canvasRef.current) return
    const groups = groupByDivision(games)
    await renderGraphic(canvasRef.current, groups, fmtDisplayDate(date))
    setRendered(true)
  }, [games, date])

  // Auto-generate when games load
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

      {/* Controls */}
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

      {/* Status */}
      {loading && <p className="text-sm text-gray-400 mb-4">Loading games...</p>}
      {error && <p className="text-sm text-red-500 mb-4">Error: {error}</p>}
      {!loading && games && finalCount === 0 && (
        <p className="text-sm text-gray-400 mb-4">No final games found for {fmtDisplayDate(date)}.</p>
      )}
      {!loading && finalCount > 0 && (
        <p className="text-sm text-gray-500 mb-4">{finalCount} game{finalCount !== 1 ? 's' : ''} on {fmtDisplayDate(date)}</p>
      )}

      {/* Canvas */}
      <div className="rounded-lg overflow-hidden shadow-lg border border-gray-200 inline-block">
        <canvas
          ref={canvasRef}
          style={{ width: '100%', maxWidth: 540, height: 'auto', aspectRatio: '1/1', display: finalCount > 0 ? 'block' : 'none' }}
        />
      </div>
    </div>
  )
}
