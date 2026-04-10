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

// ── Image loader with cache ──
const imgCache = {}
function loadImage(src) {
  if (!src) return Promise.reject('no src')
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

// ── Draw a compact scorebug ──
async function drawScorebug(ctx, game, x, y, w, h) {
  const away = getTeamName(game, 'away')
  const home = getTeamName(game, 'home')
  const aScore = game.away_score ?? '-'
  const hScore = game.home_score ?? '-'
  const aWon = Number(game.away_score) > Number(game.home_score)
  const hWon = Number(game.home_score) > Number(game.away_score)

  // Card background
  roundRect(ctx, x, y, w, h, 5)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 0.5
  ctx.stroke()

  // Header bar with FINAL + extras
  const headerH = 14
  ctx.save()
  roundRect(ctx, x, y, w, headerH, 5)
  ctx.clip()
  ctx.fillStyle = '#f1f5f9'
  ctx.fillRect(x, y, w, headerH)
  ctx.restore()

  const innings = game.innings && game.innings !== 9 ? ` (${game.innings})` : ''
  ctx.fillStyle = '#64748b'
  ctx.font = '700 8px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(`FINAL${innings}`, x + 6, y + headerH / 2)

  // W/L/S pitcher on right side of header
  const pitcherParts = []
  if (game.win_pitcher) pitcherParts.push(`W: ${game.win_pitcher}`)
  if (game.loss_pitcher) pitcherParts.push(`L: ${game.loss_pitcher}`)
  if (game.save_pitcher) pitcherParts.push(`S: ${game.save_pitcher}`)
  if (pitcherParts.length > 0) {
    ctx.fillStyle = '#94a3b8'
    ctx.font = '500 7px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(pitcherParts.join('  '), x + w - 6, y + headerH / 2)
  }

  // Divider
  ctx.fillStyle = '#e2e8f0'
  ctx.fillRect(x + 1, y + headerH, w - 2, 0.5)

  // Team rows
  const teamTop = y + headerH + 1
  const teamH = h - headerH - 1
  const rowH = teamH / 2
  const logoSize = 14
  const nameFS = 10
  const scoreFS = 12

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
      ctx.fillStyle = '#f1f5f9'
      ctx.fillRect(x + 4, ry, w - 8, 0.5)
    }

    // Logo
    const logoX = x + 6
    let logoDrawn = false
    if (logo) {
      try {
        const img = await loadImage(logo)
        const aspect = img.naturalWidth / img.naturalHeight
        let drawW = logoSize, drawH = logoSize
        if (aspect >= 1) { drawH = logoSize / aspect } else { drawW = logoSize * aspect }
        ctx.drawImage(img, logoX + (logoSize - drawW) / 2, midY - drawH / 2, drawW, drawH)
        logoDrawn = true
      } catch { /* skip */ }
    }

    const nameX = logoDrawn ? logoX + logoSize + 5 : x + 6

    // Score on the right
    ctx.fillStyle = won ? '#0f172a' : '#94a3b8'
    ctx.font = `${won ? '800' : '600'} ${scoreFS}px "Inter", system-ui, sans-serif`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    const scoreX = x + w - 6
    ctx.fillText(String(score), scoreX, midY)

    // H/E next to score
    const scoreW = ctx.measureText(String(score)).width
    let heX = scoreX - scoreW - 6
    if (hits != null || errors != null) {
      const heText = `${hits ?? 0}H ${errors ?? 0}E`
      ctx.fillStyle = '#94a3b8'
      ctx.font = '500 7px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(heText, heX, midY)
      heX -= ctx.measureText(heText).width + 4
    }

    // Team name
    const maxNameW = heX - nameX - 4
    ctx.fillStyle = won ? '#0f172a' : '#64748b'
    ctx.font = `${won ? '700' : '500'} ${nameFS}px "Inter", system-ui, sans-serif`
    ctx.textAlign = 'left'
    let display = teamName
    while (ctx.measureText(display).width > maxNameW && display.length > 2) {
      display = display.slice(0, -1)
    }
    if (display !== teamName) display += '.'
    ctx.fillText(display, nameX, midY)

    // Record (small, under team name)
    if (record) {
      ctx.fillStyle = '#94a3b8'
      ctx.font = '400 7px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(`(${record})`, nameX, midY + 8)
    }
  }
}

// ── Draw a performer row ──
async function drawPerformerRow(ctx, player, x, y, w, h, type) {
  // Subtle background
  roundRect(ctx, x, y, w, h, 4)
  ctx.fillStyle = '#f8fafc'
  ctx.fill()

  const pad = 8
  let curX = x + pad
  const midY = y + h / 2

  // Team logo
  const logoSize = Math.min(28, h - 8)
  if (player.team_logo) {
    try {
      const img = await loadImage(player.team_logo)
      const aspect = img.naturalWidth / img.naturalHeight
      let dw = logoSize, dh = logoSize
      if (aspect >= 1) dh = logoSize / aspect; else dw = logoSize * aspect
      ctx.drawImage(img, curX + (logoSize - dw) / 2, midY - dh / 2, dw, dh)
    } catch { /* skip */ }
  }
  curX += logoSize + 8

  // Name
  ctx.fillStyle = '#0f172a'
  ctx.font = '700 11px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const name = player.display_name || 'Unknown'
  ctx.fillText(name, curX, midY - 5)

  // Team short
  ctx.fillStyle = '#64748b'
  ctx.font = '500 8px "Inter", system-ui, sans-serif'
  ctx.fillText(player.team_short || '', curX, midY + 7)

  // Stat line on the right
  ctx.textAlign = 'right'
  const statX = x + w - pad
  if (type === 'hitter') {
    const ab = player.at_bats || 0
    const h = player.hits || 0
    const hr = player.home_runs || 0
    const rbi = player.rbi || 0
    const bb = player.walks || 0
    const sb = player.stolen_bases || 0
    // Main line: H-for-AB, HR, RBI
    let parts = [`${h}-${ab}`]
    if (hr > 0) parts.push(`${hr} HR`)
    if (rbi > 0) parts.push(`${rbi} RBI`)
    if (bb > 0) parts.push(`${bb} BB`)
    if (sb > 0) parts.push(`${sb} SB`)
    ctx.fillStyle = '#0f172a'
    ctx.font = '700 11px "Inter", system-ui, sans-serif'
    ctx.fillText(parts.join(', '), statX, midY - 5)
    // Sub line: doubles, triples
    const extras = []
    if (player.doubles > 0) extras.push(`${player.doubles} 2B`)
    if (player.triples > 0) extras.push(`${player.triples} 3B`)
    if (player.runs > 0) extras.push(`${player.runs} R`)
    if (extras.length > 0) {
      ctx.fillStyle = '#94a3b8'
      ctx.font = '500 8px "Inter", system-ui, sans-serif'
      ctx.fillText(extras.join(', '), statX, midY + 7)
    }
  } else {
    // Pitcher
    const ip = player.innings_pitched || 0
    const k = player.strikeouts || 0
    const er = player.earned_runs || 0
    const ha = player.hits_allowed || 0
    const dec = player.decision ? ` (${player.decision})` : ''
    ctx.fillStyle = '#0f172a'
    ctx.font = '700 11px "Inter", system-ui, sans-serif'
    ctx.fillText(`${ip} IP, ${k} K, ${er} ER${dec}`, statX, midY - 5)
    const extras = []
    if (ha != null) extras.push(`${ha} H`)
    if (player.walks > 0) extras.push(`${player.walks} BB`)
    if (player.game_score) extras.push(`GS: ${player.game_score}`)
    if (extras.length > 0) {
      ctx.fillStyle = '#94a3b8'
      ctx.font = '500 8px "Inter", system-ui, sans-serif'
      ctx.fillText(extras.join(', '), statX, midY + 7)
    }
  }
}

// ── Solve scorebug layout ──
function solveBugLayout(totalGames, availableH, contentW) {
  const bugGap = 4
  const colGap = 6
  const bugH = 58 // fixed height for compact scorebugs

  for (let cols = 2; cols <= 4; cols++) {
    const colW = (contentW - (cols - 1) * colGap) / cols
    if (colW < 180) continue
    const rows = Math.ceil(totalGames / cols)
    const needed = rows * bugH + (rows - 1) * bugGap
    if (needed <= availableH) {
      return { cols, colW, bugH, bugGap, colGap, totalH: needed }
    }
  }
  // Fallback: 3 cols, shrink bug height
  const cols = 3
  const colW = (contentW - (cols - 1) * colGap) / cols
  const rows = Math.ceil(totalGames / cols)
  const shrunkH = Math.max(48, (availableH - (rows - 1) * bugGap) / rows)
  return { cols, colW, bugH: shrunkH, bugGap, colGap, totalH: rows * shrunkH + (rows - 1) * bugGap }
}

// ── Main canvas renderer ──
async function renderGraphic(canvas, data, dateShort, divisionLabel = '') {
  const { games, top_hitters, top_pitchers, bomb_squad } = data
  const hasPerformers = (top_hitters?.length > 0 || top_pitchers?.length > 0)
  const hasBombs = bomb_squad?.length > 0

  const W = 1080
  // Dynamic height: taller if we have performers
  const performerRows = Math.min(5, top_hitters?.length || 0)
  const pitcherRows = Math.min(3, top_pitchers?.length || 0)
  const bombRows = hasBombs ? 1 : 0
  const extraH = hasPerformers ? (performerRows + pitcherRows) * 40 + 120 : 0
  const bombH = bombRows * 50
  const H = Math.min(1920, Math.max(1080, 1080 + extraH + bombH))

  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  const pad = 24

  // White background
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  // ── Header bar ──
  const headerH = 64
  ctx.fillStyle = '#00687a'
  ctx.fillRect(0, 0, W, headerH)

  // NW logo mark
  ctx.fillStyle = 'rgba(255,255,255,0.2)'
  roundRect(ctx, pad, 14, 36, 36, 6)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 18px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('NW', pad + 18, 33)

  // Title centered
  const title = divisionLabel ? `PNW ${divisionLabel} SCORES` : 'PNW SCORES'
  ctx.fillStyle = '#ffffff'
  ctx.font = '800 28px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(title, W / 2, headerH / 2)

  // Date right
  ctx.textAlign = 'right'
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 12px "Helvetica Neue", "Arial", sans-serif'
  ctx.fillText(dateShort, W - pad, 26)
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.font = '400 10px "Helvetica Neue", "Arial", sans-serif'
  ctx.fillText(`${games.length} Game${games.length !== 1 ? 's' : ''}`, W - pad, 42)

  // Dark accent line
  ctx.fillStyle = '#0f172a'
  ctx.fillRect(0, headerH, W, 3)

  // ── SCORES SECTION ──
  const contentTop = headerH + 3 + 12
  const contentW = W - pad * 2

  // Calculate how much vertical space scores get
  // If we have performers, give scores about 45% of available space; otherwise fill
  const footerH = 28
  const totalAvail = H - contentTop - footerH - 12
  const scoresAvail = hasPerformers ? Math.min(totalAvail * 0.4, 400) : totalAvail
  const { cols, colW, bugH, bugGap, colGap, totalH: scoresUsedH } = solveBugLayout(games.length, scoresAvail, contentW)

  // Distribute games to columns
  const gamesPerCol = Math.ceil(games.length / cols)
  const columns = []
  for (let c = 0; c < cols; c++) {
    const start = c * gamesPerCol
    columns.push(games.slice(start, Math.min(start + gamesPerCol, games.length)))
  }

  // Center columns
  const totalColsW = cols * colW + (cols - 1) * colGap
  const startX = pad + (contentW - totalColsW) / 2

  // Render scorebugs
  for (let c = 0; c < columns.length; c++) {
    const colX = startX + c * (colW + colGap)
    let cy = contentTop
    for (let gi = 0; gi < columns[c].length; gi++) {
      await drawScorebug(ctx, columns[c][gi], colX, cy, colW, bugH)
      cy += bugH + bugGap
    }
  }

  let curY = contentTop + scoresUsedH + 20

  // ── TOP PERFORMERS SECTION ──
  if (hasPerformers) {
    // Section divider
    ctx.fillStyle = '#00687a'
    ctx.fillRect(pad, curY, contentW, 2)
    curY += 10

    // Section title
    ctx.fillStyle = '#0f172a'
    ctx.font = '800 18px "Helvetica Neue", "Arial", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('TOP PERFORMERS', W / 2, curY + 9)
    curY += 28

    // Top hitters
    if (top_hitters?.length > 0) {
      ctx.fillStyle = '#00687a'
      ctx.font = '700 11px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText('HITTING', pad, curY + 5)
      curY += 16

      const rowH = 38
      const rowGap = 4
      for (let i = 0; i < Math.min(5, top_hitters.length); i++) {
        await drawPerformerRow(ctx, top_hitters[i], pad, curY, contentW, rowH, 'hitter')
        curY += rowH + rowGap
      }
      curY += 6
    }

    // Top pitchers
    if (top_pitchers?.length > 0) {
      ctx.fillStyle = '#00687a'
      ctx.font = '700 11px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText('PITCHING', pad, curY + 5)
      curY += 16

      const rowH = 38
      const rowGap = 4
      for (let i = 0; i < Math.min(3, top_pitchers.length); i++) {
        await drawPerformerRow(ctx, top_pitchers[i], pad, curY, contentW, rowH, 'pitcher')
        curY += rowH + rowGap
      }
      curY += 6
    }
  }

  // ── BOMB SQUAD SECTION ──
  if (hasBombs) {
    // Divider
    ctx.fillStyle = '#dc2626'
    ctx.fillRect(pad, curY, contentW, 2)
    curY += 10

    // Title with emoji-style bomb icon
    ctx.fillStyle = '#dc2626'
    ctx.font = '800 16px "Helvetica Neue", "Arial", sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('BOMB SQUAD', W / 2, curY + 8)
    curY += 24

    // Render bomb squad as a compact grid
    const bombColW = contentW / 2
    const bombRowH = 24
    for (let i = 0; i < bomb_squad.length; i++) {
      const b = bomb_squad[i]
      const col = i % 2
      const row = Math.floor(i / 2)
      const bx = pad + col * bombColW
      const by = curY + row * bombRowH

      // Team logo tiny
      let logoOff = 0
      if (b.team_logo) {
        try {
          const img = await loadImage(b.team_logo)
          ctx.drawImage(img, bx, by + 2, 14, 14)
          logoOff = 18
        } catch { /* skip */ }
      }

      // Name
      ctx.fillStyle = '#0f172a'
      ctx.font = '600 10px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(b.display_name, bx + logoOff, by + 9)

      // HR count + season total
      const nameW = ctx.measureText(b.display_name).width
      const hrText = b.home_runs > 1 ? `${b.home_runs} HR` : 'HR'
      const seasonText = `(${b.season_hr} on season)`
      ctx.fillStyle = '#dc2626'
      ctx.font = '700 10px "Inter", system-ui, sans-serif'
      ctx.fillText(` ${hrText}`, bx + logoOff + nameW, by + 9)
      const hrW = ctx.measureText(` ${hrText}`).width
      ctx.fillStyle = '#94a3b8'
      ctx.font = '400 8px "Inter", system-ui, sans-serif'
      ctx.fillText(` ${seasonText}`, bx + logoOff + nameW + hrW, by + 9)
    }

    const bombGridRows = Math.ceil(bomb_squad.length / 2)
    curY += bombGridRows * bombRowH + 10
  }

  // ── Footer ──
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
      // Fetch enhanced data from daily-performers endpoint
      const res = await fetch(`${API_BASE}/games/daily-performers?date=${d}&season=2026`)
      if (!res.ok) throw new Error(`API error: ${res.status}`)
      const json = await res.json()

      // Also try live endpoint for better team names/logos on recent dates
      const liveRes = await fetch(`${API_BASE}/games/live`).catch(() => null)
      if (liveRes?.ok) {
        const liveData = await liveRes.json()
        const allLive = [...(liveData.today || []), ...(liveData.recent || [])]
        const liveByTeams = {}
        for (const g of allLive) {
          if (g.date?.startsWith(d) && g.status === 'final') {
            // Key by team names to match
            const key = (g.team || '').toLowerCase()
            if (key) liveByTeams[key] = g
          }
        }
        // Enrich DB games with live data (better logos, names)
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

  // Filter by division
  const filteredData = data ? {
    ...data,
    games: data.games.filter(g => {
      if (divFilter === 'ALL') return true
      return (g.home_division || g.division || '').toUpperCase() === divFilter
    }),
    top_hitters: data.top_hitters.filter(h => {
      if (divFilter === 'ALL') return true
      return (h.division || '').toUpperCase() === divFilter
    }),
    top_pitchers: data.top_pitchers.filter(p => {
      if (divFilter === 'ALL') return true
      return (p.division || '').toUpperCase() === divFilter
    }),
    bomb_squad: data.bomb_squad.filter(b => {
      if (divFilter === 'ALL') return true
      return (b.division || '').toUpperCase() === divFilter
    }),
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
      <p className="text-sm text-gray-500 mb-5">
        Generate a shareable scoreboard image for any game day.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-3">
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

      <div className="flex flex-wrap items-center gap-1.5 mb-5">
        {DIV_OPTIONS.map(d => (
          <button
            key={d}
            onClick={() => setDivFilter(d)}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
              divFilter === d
                ? 'bg-nw-teal text-white'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            {d === 'ALL' ? 'All' : d}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-gray-400 mb-4">Loading games...</p>}
      {error && <p className="text-sm text-red-500 mb-4">Error: {error}</p>}
      {!loading && data && finalCount === 0 && (
        <p className="text-sm text-gray-400 mb-4">No {divFilter !== 'ALL' ? divFilter + ' ' : ''}final games found for {fmtDisplayDate(date)}.</p>
      )}
      {!loading && finalCount > 0 && (
        <p className="text-sm text-gray-500 mb-4">
          {finalCount} game{finalCount !== 1 ? 's' : ''}
          {filteredData?.bomb_squad?.length > 0 && ` · ${filteredData.bomb_squad.length} HR`}
          {' on '}{fmtDisplayDate(date)}
        </p>
      )}

      <div className="rounded-lg overflow-hidden shadow-lg border border-gray-200 inline-block">
        <canvas
          ref={canvasRef}
          style={{ width: '100%', maxWidth: 540, height: 'auto', display: finalCount > 0 ? 'block' : 'none' }}
        />
      </div>
    </div>
  )
}
