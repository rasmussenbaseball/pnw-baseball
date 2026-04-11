import { useState, useRef, useCallback, useEffect } from 'react'

const API_BASE = '/api/v1'

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtDisplayDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function cleanTeamName(name) {
  if (!name) return '???'
  let n = name.trim()
  n = n.replace(/^(?:No\.\s*\d+\s+|#\d+\s+|\(\d+\)\s+)/i, '')
  n = n.replace(/(?<=[a-zA-Z])(\d+)$/, '')
  return n.trim() || '???'
}

function getTeamName(game, side) {
  const short = side === 'away' ? (game.away_short || game.away_team_name) : (game.home_short || game.home_team_name)
  return cleanTeamName(short)
}

// Convert decimal IP to baseball notation: 6.6667 -> 6.2, 5.3333 -> 5.1
function fmtIP(ip) {
  if (ip == null) return '0'
  const whole = Math.floor(ip)
  const frac = ip - whole
  if (frac < 0.1) return String(whole)
  if (frac < 0.5) return `${whole}.1`
  if (frac < 0.8) return `${whole}.2`
  return String(whole + 1)
}

const imgCache = {}
function loadImage(src) {
  if (!src) return Promise.reject('no src')
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

// ── Scorebug: scales fully with size ──
async function drawScorebug(ctx, game, x, y, w, h) {
  const away = getTeamName(game, 'away')
  const home = getTeamName(game, 'home')
  const aScore = game.away_score ?? '-'
  const hScore = game.home_score ?? '-'
  const aWon = Number(game.away_score) > Number(game.home_score)
  const hWon = Number(game.home_score) > Number(game.away_score)

  // Scale everything proportionally to bug dimensions
  const sH = h / 90  // height scale (baseline 90px)
  const sW = w / 250 // width scale (baseline 250px)
  const s = Math.min(sH, sW) // use the smaller scale factor
  const headerFS = Math.max(6, 9 * s)
  const nameFS = Math.max(7, 13 * s)
  const scoreFS = Math.max(8, 16 * s)
  const smallFS = Math.max(5, 8 * s)
  const rheFS = Math.max(6, 12 * s)
  const wlsFS = Math.max(5, 7.5 * s)
  const logoSize = Math.max(10, 22 * s)
  const pad = Math.max(3, 6 * s)
  const radius = Math.max(3, 5 * s)

  // Card shadow + bg
  ctx.fillStyle = 'rgba(0,0,0,0.03)'
  roundRect(ctx, x + 1, y + 1, w, h, radius)
  ctx.fill()
  roundRect(ctx, x, y, w, h, radius)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = Math.max(0.5, s * 0.5)
  ctx.stroke()

  // Header: FINAL + W/L/S pitchers
  const headerH = Math.max(12, 18 * s)
  ctx.save()
  roundRect(ctx, x, y, w, headerH, radius)
  ctx.clip()
  ctx.fillStyle = '#f1f5f9'
  ctx.fillRect(x, y, w, headerH)
  ctx.restore()
  ctx.fillStyle = '#e2e8f0'
  ctx.fillRect(x + 1, y + headerH, w - 2, 0.5)

  const innings = game.innings && game.innings !== 9 ? ` (${game.innings})` : ''
  ctx.fillStyle = '#475569'
  ctx.font = `800 ${headerFS}px "Inter", system-ui, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(`FINAL${innings}`, x + pad, y + headerH / 2)

  // W/L/S
  const parts = []
  if (game.win_pitcher) parts.push(`W: ${game.win_pitcher}`)
  if (game.loss_pitcher) parts.push(`L: ${game.loss_pitcher}`)
  if (game.save_pitcher) parts.push(`S: ${game.save_pitcher}`)
  if (parts.length > 0) {
    ctx.fillStyle = '#94a3b8'
    ctx.font = `500 ${wlsFS}px "Inter", system-ui, sans-serif`
    ctx.textAlign = 'right'
    ctx.fillText(parts.join('  '), x + w - pad, y + headerH / 2)
  }

  // R/H/E header
  const rheColW = Math.max(14, 22 * s)
  const rheX = x + w - pad - rheColW * 3
  const rheHeaderY = y + headerH + 2 * s
  ctx.fillStyle = '#94a3b8'
  ctx.font = `600 ${Math.max(5, 7.5 * s)}px "Inter", system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText('R', rheX + rheColW * 0.5, rheHeaderY + 5 * s)
  ctx.fillText('H', rheX + rheColW * 1.5, rheHeaderY + 5 * s)
  ctx.fillText('E', rheX + rheColW * 2.5, rheHeaderY + 5 * s)

  // Team rows
  const teamTop = rheHeaderY + 11 * s
  const teamH = y + h - teamTop - 2 * s
  const rowH = teamH / 2

  for (let i = 0; i < 2; i++) {
    const isAway = i === 0
    const teamName = isAway ? away : home
    const score = isAway ? aScore : hScore
    const won = isAway ? aWon : hWon
    const logo = isAway ? game.away_logo : game.home_logo
    const record = isAway ? game.away_record : game.home_record
    const hits = isAway ? game.away_hits : game.home_hits
    const errors = isAway ? game.away_errors : game.home_errors
    const ry = teamTop + i * rowH
    const midY = ry + rowH / 2

    if (i === 1) {
      ctx.fillStyle = '#e2e8f0'
      ctx.fillRect(x + pad, ry - 1, w - pad * 2, 0.5)
    }

    // Logo
    let curX = x + pad
    if (logo) {
      try {
        const img = await loadImage(logo)
        const a = img.naturalWidth / img.naturalHeight
        let dw = logoSize, dh = logoSize
        if (a >= 1) dh = logoSize / a; else dw = logoSize * a
        ctx.drawImage(img, curX + (logoSize - dw) / 2, midY - dh / 2, dw, dh)
      } catch { /* skip */ }
    }
    curX += logoSize + pad

    // Team name
    const maxNameW = rheX - curX - 2
    ctx.fillStyle = won ? '#0f172a' : '#64748b'
    ctx.font = `${won ? '700' : '500'} ${nameFS}px "Inter", system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    let display = teamName
    while (ctx.measureText(display).width > maxNameW && display.length > 2) display = display.slice(0, -1)
    if (display !== teamName) display += '.'
    ctx.fillText(display, curX, midY - (record ? 4 * s : 0))

    // Record
    if (record) {
      ctx.fillStyle = '#94a3b8'
      ctx.font = `400 ${smallFS}px "Inter", system-ui, sans-serif`
      ctx.fillText(`(${record})`, curX, midY + 7 * s)
    }

    // R (score) / H / E
    ctx.textAlign = 'center'
    ctx.fillStyle = won ? '#0f172a' : '#94a3b8'
    ctx.font = `${won ? '800' : '600'} ${scoreFS}px "Inter", system-ui, sans-serif`
    ctx.fillText(String(score), rheX + rheColW * 0.5, midY)
    ctx.fillStyle = '#64748b'
    ctx.font = `500 ${rheFS}px "Inter", system-ui, sans-serif`
    ctx.fillText(hits != null ? String(hits) : '-', rheX + rheColW * 1.5, midY)
    ctx.fillText(errors != null ? String(errors) : '-', rheX + rheColW * 2.5, midY)
  }
}

// ── Draw a compact stat table (with logos) ──
async function drawStatTable(ctx, title, players, x, y, w, h, type) {
  const pad = 6
  const titleH = 16
  const rowCount = players.length + 1 // +1 for header row
  const rowH = Math.min(28, (h - titleH) / Math.max(1, rowCount))
  const logoSize = Math.max(12, rowH - 6)

  // Section label
  ctx.fillStyle = '#00687a'
  ctx.font = '700 11px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(title, x + pad, y + titleH / 2)

  // Table header row
  const tableY = y + titleH
  ctx.fillStyle = '#f1f5f9'
  roundRect(ctx, x, tableY, w, rowH, 3)
  ctx.fill()

  ctx.fillStyle = '#64748b'
  ctx.font = '600 8px "Inter", system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  const headerMidY = tableY + rowH / 2

  // Column layout: logo + name takes ~48%, stats take rest
  const nameColW = w * 0.48
  const statCols = type === 'hitter' ? ['AB', 'H', 'HR', 'RBI', 'XBH', 'SB'] : ['IP', 'H', 'K', 'BB', 'ER', 'DEC']
  const statColW = (w - nameColW - pad) / statCols.length

  ctx.textAlign = 'left'
  ctx.fillText('PLAYER', x + pad, headerMidY)
  statCols.forEach((col, i) => {
    ctx.textAlign = 'center'
    ctx.fillText(col, x + nameColW + statColW * i + statColW / 2, headerMidY)
  })

  // Data rows
  for (let i = 0; i < players.length; i++) {
    const p = players[i]
    const ry = tableY + rowH + i * rowH
    const rMidY = ry + rowH / 2

    // Alternating bg
    if (i % 2 === 1) {
      ctx.fillStyle = '#fafbfc'
      ctx.fillRect(x, ry, w, rowH)
    }

    // Subtle row divider
    ctx.fillStyle = '#f1f5f9'
    ctx.fillRect(x + 2, ry, w - 4, 0.5)

    // Team logo
    let curX = x + pad
    const logoSrc = p.team_logo
    if (logoSrc) {
      try {
        const img = await loadImage(logoSrc)
        const a = img.naturalWidth / img.naturalHeight
        let dw = logoSize, dh = logoSize
        if (a >= 1) dh = logoSize / a; else dw = logoSize * a
        ctx.drawImage(img, curX + (logoSize - dw) / 2, rMidY - dh / 2, dw, dh)
      } catch { /* skip */ }
    }
    curX += logoSize + 3

    // Player name
    const name = p.display_name || 'Unknown'
    const team = p.team_short || ''
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#0f172a'
    ctx.font = '600 11px "Inter", system-ui, sans-serif'

    const maxW = x + nameColW - curX - 2
    let displayName = name
    while (ctx.measureText(`${displayName} ${team}`).width > maxW && displayName.length > 3) {
      displayName = displayName.slice(0, -1)
    }
    if (displayName !== name) displayName += '.'
    ctx.fillText(displayName, curX, rMidY)

    // Team abbrev in gray
    const nameW = ctx.measureText(displayName + ' ').width
    ctx.fillStyle = '#94a3b8'
    ctx.font = '400 8px "Inter", system-ui, sans-serif'
    ctx.fillText(team, curX + nameW, rMidY)

    // Stats
    ctx.font = '600 10px "Inter", system-ui, sans-serif'
    ctx.fillStyle = '#0f172a'
    if (type === 'hitter') {
      // AB, H, HR, RBI, XBH, SB
      const stats = [
        p.at_bats || 0, p.hits || 0, p.home_runs || 0,
        p.rbi || 0, p.xbh || 0, p.stolen_bases || 0,
      ]
      stats.forEach((val, j) => {
        ctx.textAlign = 'center'
        // Highlight HR (j=2) in red
        ctx.fillStyle = j === 2 && val > 0 ? '#dc2626' : '#0f172a'
        ctx.font = j === 2 && val > 0 ? '700 10px "Inter", system-ui, sans-serif' : '600 10px "Inter", system-ui, sans-serif'
        ctx.fillText(String(val), x + nameColW + statColW * j + statColW / 2, rMidY)
      })
    } else {
      // IP, H, K, BB, ER, DEC
      const ip = fmtIP(p.innings_pitched)
      const stats = [
        ip, p.hits_allowed != null ? p.hits_allowed : '-',
        p.strikeouts || 0, p.walks || 0,
        p.earned_runs || 0, p.decision || '-',
      ]
      stats.forEach((val, j) => {
        ctx.textAlign = 'center'
        if (j === 5) { // DEC column
          ctx.fillStyle = val === 'W' ? '#16a34a' : val === 'L' ? '#dc2626' : '#64748b'
          ctx.font = '700 10px "Inter", system-ui, sans-serif'
        } else {
          ctx.fillStyle = '#0f172a'
          ctx.font = '600 10px "Inter", system-ui, sans-serif'
        }
        ctx.fillText(String(val), x + nameColW + statColW * j + statColW / 2, rMidY)
      })
    }
  }
}

// ── Main renderer (always 1080x1080) ──
async function renderGraphic(canvas, data, dateShort, divisionLabel = '') {
  const { games, top_hitters, top_pitchers } = data
  const numGames = games.length

  // Always 5 performers per section
  const PERF_COUNT = 5
  const hitters = (top_hitters || []).slice(0, PERF_COUNT)
  const pitchers = (top_pitchers || []).slice(0, PERF_COUNT)
  const hasPerformers = hitters.length > 0 || pitchers.length > 0

  const W = 1080
  const H = 1080
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  const pad = 20

  // White bg
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  // ── Header ──
  const headerH = 60
  ctx.fillStyle = '#00687a'
  ctx.fillRect(0, 0, W, headerH)

  ctx.fillStyle = 'rgba(255,255,255,0.2)'
  roundRect(ctx, pad, 12, 34, 34, 5)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 16px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('NW', pad + 17, 30)

  const title = divisionLabel ? `PNW ${divisionLabel} SCORES` : 'PNW SCORES'
  ctx.fillStyle = '#ffffff'
  ctx.font = '800 26px "Helvetica Neue", "Arial", sans-serif'
  ctx.fillText(title, W / 2, headerH / 2)

  ctx.textAlign = 'right'
  ctx.font = '700 11px "Helvetica Neue", "Arial", sans-serif'
  ctx.fillText(dateShort, W - pad, 24)
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.font = '400 9px "Helvetica Neue", "Arial", sans-serif'
  ctx.fillText(`${numGames} Game${numGames !== 1 ? 's' : ''}`, W - pad, 38)

  ctx.fillStyle = '#0f172a'
  ctx.fillRect(0, headerH, W, 3)

  // ── Fixed layout zones (bottom-up) ──
  const footerH = 26
  const contentW = W - pad * 2
  // Performers section is FIXED height, anchored at bottom above footer
  const perfSectionH = hasPerformers ? 210 : 0
  const perfDividerH = hasPerformers ? 6 : 0
  const scoresTopY = headerH + 3 + 8 // 8px margin below header line
  const scoresBottomY = H - footerH - perfSectionH - perfDividerH - 4
  const scoresAvailH = scoresBottomY - scoresTopY

  // ── Scorebugs: fill ALL available space with good proportions ──
  const bugGap = 4
  const colGap = 6

  // Try column counts 1-6, pick layout where bugs are closest to
  // a good scorebug aspect ratio (w:h around 2.5:1 to 3.5:1)
  let bestCols = 2, bestBugH = 50
  let bestScore = -Infinity
  for (let cols = 1; cols <= 6; cols++) {
    const colW = (contentW - (cols - 1) * colGap) / cols
    if (colW < 120 && cols > 1) continue
    const rows = Math.ceil(numGames / cols)
    if (rows === 0) continue
    let bugH = (scoresAvailH - (rows - 1) * bugGap) / rows
    // Cap height so bugs keep scorebug proportions (not taller than ~40% of width)
    bugH = Math.min(bugH, colW * 0.45)
    bugH = Math.max(bugH, 36)
    const ratio = colW / bugH
    // Ideal ratio around 3:1 - penalize deviations
    const ratioPenalty = -Math.abs(ratio - 3.0) * 5
    // Prefer bigger bugs (area)
    const areaBonus = (colW * bugH) / 1000
    const score = areaBonus + ratioPenalty
    if (score > bestScore) {
      bestScore = score
      bestCols = cols
      bestBugH = bugH
    }
  }

  const bugColW = (contentW - (bestCols - 1) * colGap) / bestCols
  const bugH = bestBugH

  // Distribute games evenly across columns
  const gamesPerCol = Math.ceil(numGames / bestCols)
  const columns = []
  for (let c = 0; c < bestCols; c++) {
    columns.push(games.slice(c * gamesPerCol, Math.min((c + 1) * gamesPerCol, numGames)))
  }

  // Center the grid horizontally
  const totalColsW = bestCols * bugColW + (bestCols - 1) * colGap
  const startX = pad + (contentW - totalColsW) / 2

  // Center scorebugs vertically in their zone
  const actualRows = Math.ceil(numGames / bestCols)
  const totalBugsH = actualRows * bugH + (actualRows - 1) * bugGap
  const bugStartY = scoresTopY + (scoresAvailH - totalBugsH) / 2

  for (let c = 0; c < columns.length; c++) {
    const colX = startX + c * (bugColW + colGap)
    let cy = bugStartY
    for (let gi = 0; gi < columns[c].length; gi++) {
      await drawScorebug(ctx, columns[c][gi], colX, cy, bugColW, bugH)
      cy += bugH + bugGap
    }
  }

  // ── Top Performers (FIXED at bottom, always same size) ──
  if (hasPerformers) {
    const perfY = H - footerH - perfSectionH - 2
    ctx.fillStyle = '#00687a'
    ctx.fillRect(pad, perfY, contentW, 2)

    const perfTopY = perfY + 4
    const perfH = perfSectionH - 6
    const halfW = (contentW - 10) / 2

    // Left: Hitters
    if (hitters.length > 0) {
      await drawStatTable(ctx, 'TOP HITTERS', hitters, pad, perfTopY, halfW, perfH, 'hitter')
    }

    // Right: Pitchers
    if (pitchers.length > 0) {
      await drawStatTable(ctx, 'TOP PITCHERS', pitchers, pad + halfW + 10, perfTopY, halfW, perfH, 'pitcher')
    }
  }

  // ── Footer ──
  const footY = H - footerH / 2
  ctx.fillStyle = '#e2e8f0'
  ctx.fillRect(pad, H - footerH - 2, contentW, 1)
  ctx.fillStyle = '#00687a'
  ctx.font = '700 10px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('PNWBASEBALLSTATS.COM', pad, footY)
  ctx.fillStyle = '#94a3b8'
  ctx.font = '500 8px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText('2026 Season', W - pad, footY)
}

// ── Component ──
export default function DailyScoresGraphic() {
  const [date, setDate] = useState(todayStr())
  const [data, setData] = useState(null)
  const [divFilter, setDivFilter] = useState('ALL')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [rendered, setRendered] = useState(false)
  const canvasRef = useRef(null)

  const DIV_OPTIONS = ['ALL', 'D1', 'D2', 'D3', 'NAIA', 'JUCO']

  const fetchData = useCallback(async (d) => {
    setLoading(true)
    setError(null)
    setRendered(false)
    try {
      const res = await fetch(`${API_BASE}/games/daily-performers?date=${d}&season=2026`)
      if (!res.ok) throw new Error(`API error: ${res.status}`)
      const json = await res.json()

      const liveRes = await fetch(`${API_BASE}/games/live`).catch(() => null)
      if (liveRes?.ok) {
        const liveData = await liveRes.json()
        const allLive = [...(liveData.today || []), ...(liveData.recent || [])]
        const liveByTeams = {}
        for (const g of allLive) {
          if (g.date?.startsWith(d) && g.status === 'final') {
            const key = (g.team || '').toLowerCase()
            if (key) liveByTeams[key] = g
          }
        }
        for (const game of json.games) {
          const homeKey = (game.home_short || '').toLowerCase()
          const live = liveByTeams[homeKey]
          if (live) {
            if (live.team_logo && !game.home_logo) game.home_logo = live.team_logo
            if (live.opponent_logo && !game.away_logo) game.away_logo = live.opponent_logo
            game.division = live.team_division || game.home_division
          }
        }
      }
      setData(json)
    } catch (err) {
      setError(err.message)
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData(date) }, [date, fetchData])

  const filteredData = data ? {
    ...data,
    games: data.games.filter(g => divFilter === 'ALL' || (g.home_division || g.division || '').toUpperCase() === divFilter),
    top_hitters: data.top_hitters.filter(h => divFilter === 'ALL' || (h.division || '').toUpperCase() === divFilter),
    top_pitchers: data.top_pitchers.filter(p => divFilter === 'ALL' || (p.division || '').toUpperCase() === divFilter),
  } : null

  const generate = useCallback(async () => {
    if (!filteredData?.games?.length || !canvasRef.current) return
    const divLabel = divFilter !== 'ALL' ? divFilter : ''
    await renderGraphic(canvasRef.current, filteredData, shortDate(date), divLabel)
    setRendered(true)
  }, [filteredData, date, divFilter])

  useEffect(() => {
    if (filteredData?.games?.length > 0) generate()
    else setRendered(false)
  }, [filteredData, generate])

  const download = () => {
    if (!canvasRef.current) return
    const link = document.createElement('a')
    const suffix = divFilter !== 'ALL' ? `-${divFilter.toLowerCase()}` : ''
    link.download = `pnw-scores${suffix}-${date}.png`
    link.href = canvasRef.current.toDataURL('image/png')
    link.click()
  }

  const finalCount = filteredData?.games?.length ?? 0

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Daily Scores Graphic</h1>
      <p className="text-sm text-gray-500 mb-5">Generate a shareable scoreboard image for any game day.</p>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal" />
        <button onClick={() => setDate(todayStr())}
          className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 transition-colors">Today</button>
        {rendered && (
          <button onClick={download}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-nw-teal hover:bg-nw-teal/90 transition-colors">Download PNG</button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-5">
        {DIV_OPTIONS.map(d => (
          <button key={d} onClick={() => setDivFilter(d)}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
              divFilter === d ? 'bg-nw-teal text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}>{d === 'ALL' ? 'All' : d}</button>
        ))}
      </div>

      {loading && <p className="text-sm text-gray-400 mb-4">Loading games...</p>}
      {error && <p className="text-sm text-red-500 mb-4">Error: {error}</p>}
      {!loading && data && finalCount === 0 && (
        <p className="text-sm text-gray-400 mb-4">No {divFilter !== 'ALL' ? divFilter + ' ' : ''}final games found for {fmtDisplayDate(date)}.</p>
      )}
      {!loading && finalCount > 0 && (
        <p className="text-sm text-gray-500 mb-4">{finalCount} game{finalCount !== 1 ? 's' : ''} on {fmtDisplayDate(date)}</p>
      )}

      <div className="rounded-lg overflow-hidden shadow-lg border border-gray-200 inline-block">
        <canvas ref={canvasRef}
          style={{ width: '100%', maxWidth: 540, height: 'auto', aspectRatio: '1/1', display: finalCount > 0 ? 'block' : 'none' }} />
      </div>
    </div>
  )
}
