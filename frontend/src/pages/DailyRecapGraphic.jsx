import { useState, useRef, useCallback, useEffect } from 'react'

const API_BASE = '/api/v1'

function cleanTeamName(name) {
  if (!name) return '???'
  let n = name.trim()
  n = n.replace(/^(?:No\.\s*\d+\s+|#\d+\s+|\(\d+\))\s+/i, '')
  n = n.replace(/(?<=[a-zA-Z])(\d+)$/, '')
  return n.trim() || '???'
}

function shortDate(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function fmtIP(ip) {
  if (ip == null) return '0'
  const whole = Math.floor(ip)
  const frac = ip - whole
  if (frac < 0.1) return String(whole)
  if (frac < 0.5) return `${whole}.1`
  if (frac < 0.8) return `${whole}.2`
  return String(whole + 1)
}

function fmtAvg(v) {
  if (v == null) return '.000'
  return v.toFixed(3).replace(/^0/, '')
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

// Colors
const COLORS = {
  green_dark: '#1B5E20',
  green_light: '#2E7D32',
  green_accent: '#4CAF50',
  bg_dark: '#0D1B0F',
  white: '#ffffff',
  text_dark: '#0f172a',
  text_gray: '#64748b',
}

// ── Draw large scorebug for daily recap ──
async function drawDailyScoreBug(ctx, game, x, y, w, h) {
  const away = cleanTeamName(game.away_short)
  const home = cleanTeamName(game.home_short)
  const aScore = game.away_score ?? '-'
  const hScore = game.home_score ?? '-'
  const aWon = Number(game.away_score) > Number(game.home_score)
  const hWon = Number(game.home_score) > Number(game.away_score)
  const pad = 12
  const radius = 8

  // Card background
  roundRect(ctx, x, y, w, h, radius)
  ctx.fillStyle = COLORS.white
  ctx.fill()
  ctx.strokeStyle = '#cbd5e1'
  ctx.lineWidth = 1
  ctx.stroke()

  // Header bar with date + FINAL
  const headerH = 28
  ctx.save()
  roundRect(ctx, x, y, w, headerH, radius)
  ctx.clip()
  ctx.fillStyle = COLORS.green_dark
  ctx.fillRect(x, y, w, headerH)
  ctx.restore()

  const dateLabel = game.game_date ? shortDate(game.game_date) : ''
  ctx.fillStyle = COLORS.white
  ctx.font = '700 13px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(dateLabel, x + pad, y + headerH / 2)

  ctx.fillStyle = COLORS.white
  ctx.font = '700 13px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText('FINAL', x + w - pad, y + headerH / 2)

  // R/H/E column headers
  const rheColW = 38
  const rheX = x + w - pad - rheColW * 3
  const rheHeaderY = y + headerH + 6
  ctx.fillStyle = COLORS.text_gray
  ctx.font = '600 10px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('R', rheX + rheColW * 0.5, rheHeaderY + 8)
  ctx.fillText('H', rheX + rheColW * 1.5, rheHeaderY + 8)
  ctx.fillText('E', rheX + rheColW * 2.5, rheHeaderY + 8)

  // Team rows
  const teamTop = rheHeaderY + 18
  const rowH = (y + h - teamTop - 28) / 2
  const logoSize = 36

  for (let i = 0; i < 2; i++) {
    const isAway = i === 0
    const teamName = isAway ? away : home
    const score = isAway ? aScore : hScore
    const won = isAway ? aWon : hWon
    const logo = isAway ? game.away_logo : game.home_logo
    const hits = isAway ? game.away_hits : game.home_hits
    const errors = isAway ? game.away_errors : game.home_errors
    const ry = teamTop + i * rowH
    const midY = ry + rowH / 2

    if (i === 1) {
      ctx.fillStyle = '#f0f4e8'
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
    curX += logoSize + 12

    // Team name
    const maxNameW = rheX - curX - 4
    ctx.fillStyle = won ? COLORS.text_dark : COLORS.text_gray
    ctx.font = `${won ? '700' : '500'} 18px "Inter", system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    let display = teamName
    while (ctx.measureText(display).width > maxNameW && display.length > 2) display = display.slice(0, -1)
    if (display !== teamName) display += '.'
    ctx.fillText(display, curX, midY)

    // R/H/E values
    ctx.textAlign = 'center'
    ctx.fillStyle = won ? COLORS.text_dark : COLORS.text_gray
    ctx.font = `${won ? '800' : '600'} 22px "Inter", system-ui, sans-serif`
    ctx.fillText(String(score), rheX + rheColW * 0.5, midY)
    ctx.fillStyle = COLORS.text_gray
    ctx.font = '500 14px "Inter", system-ui, sans-serif'
    ctx.fillText(hits != null ? String(hits) : '-', rheX + rheColW * 1.5, midY)
    ctx.fillText(errors != null ? String(errors) : '-', rheX + rheColW * 2.5, midY)
  }

  // W/L/S pitchers at bottom
  const wlY = y + h - 12
  const wlParts = []
  if (game.win_pitcher) wlParts.push({ label: 'W', name: game.win_pitcher, color: '#16a34a' })
  if (game.loss_pitcher) wlParts.push({ label: 'L', name: game.loss_pitcher, color: '#dc2626' })
  if (game.save_pitcher) wlParts.push({ label: 'S', name: game.save_pitcher, color: '#2563eb' })
  if (wlParts.length > 0) {
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    const gap = 14
    let totalW = 0
    wlParts.forEach((p, i) => {
      ctx.font = '700 12px "Inter", system-ui, sans-serif'
      totalW += ctx.measureText(`${p.label}: `).width
      ctx.font = '600 12px "Inter", system-ui, sans-serif'
      totalW += ctx.measureText(p.name).width
      if (i < wlParts.length - 1) totalW += gap
    })
    let drawX = x + (w - totalW) / 2
    wlParts.forEach((p, i) => {
      ctx.textAlign = 'left'
      ctx.fillStyle = p.color
      ctx.font = '700 12px "Inter", system-ui, sans-serif'
      const labelStr = `${p.label}: `
      ctx.fillText(labelStr, drawX, wlY)
      drawX += ctx.measureText(labelStr).width
      ctx.fillStyle = '#334155'
      ctx.font = '600 12px "Inter", system-ui, sans-serif'
      ctx.fillText(p.name, drawX, wlY)
      drawX += ctx.measureText(p.name).width + gap
    })
  }
}

// ── Draw inning-by-inning linescore table ──
function drawLinescore(ctx, game, x, y, w, h) {
  const pad = 6
  const radius = 4

  // Card background
  roundRect(ctx, x, y, w, h, radius)
  ctx.fillStyle = COLORS.white
  ctx.fill()
  ctx.strokeStyle = '#cbd5e1'
  ctx.lineWidth = 1
  ctx.stroke()

  // Build columns: Team | 1 2 3 4 5 6 7 8 9 | R H E
  const cols = ['TEAM', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'R', 'H', 'E']
  const teamColW = 50
  const innColW = (w - teamColW - 1) / 12

  // Header row
  ctx.fillStyle = COLORS.green_dark
  ctx.fillRect(x, y, w, h / 3)
  ctx.fillStyle = COLORS.white
  ctx.font = '700 11px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  let colX = x + teamColW / 2
  cols.forEach((col, i) => {
    if (i === 0) {
      ctx.textAlign = 'center'
      ctx.fillText(col, x + teamColW / 2, y + (h / 3) / 2)
    } else {
      ctx.fillText(col, colX, y + (h / 3) / 2)
      colX += innColW
    }
  })

  // Get inning scores
  const innings = game.innings || []
  const aInn = Array(9).fill('-')
  const hInn = Array(9).fill('-')

  if (Array.isArray(innings)) {
    innings.forEach((inn, idx) => {
      if (idx < 9) {
        if (inn.away != null) aInn[idx] = inn.away
        if (inn.home != null) hInn[idx] = inn.home
      }
    })
  }

  // Away team row
  const rowH = h / 3
  ctx.fillStyle = '#f8fafc'
  ctx.fillRect(x, y + rowH, w, rowH)
  ctx.fillStyle = COLORS.text_dark
  ctx.font = '600 11px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  const awayShort = cleanTeamName(game.away_short).substring(0, 3).toUpperCase()
  ctx.fillText(awayShort, x + teamColW / 2, y + rowH + rowH / 2)

  colX = x + teamColW + innColW / 2
  for (let i = 0; i < 9; i++) {
    ctx.fillText(String(aInn[i]), colX, y + rowH + rowH / 2)
    colX += innColW
  }
  ctx.fillText(String(game.away_score ?? '-'), colX, y + rowH + rowH / 2)
  colX += innColW
  ctx.fillText(String(game.away_hits ?? '-'), colX, y + rowH + rowH / 2)
  colX += innColW
  ctx.fillText(String(game.away_errors ?? '-'), colX, y + rowH + rowH / 2)

  // Home team row
  ctx.fillStyle = COLORS.white
  ctx.fillRect(x, y + rowH * 2, w, rowH)
  ctx.fillStyle = COLORS.text_dark
  ctx.font = '600 11px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  const homeShort = cleanTeamName(game.home_short).substring(0, 3).toUpperCase()
  ctx.fillText(homeShort, x + teamColW / 2, y + rowH * 2 + rowH / 2)

  colX = x + teamColW + innColW / 2
  for (let i = 0; i < 9; i++) {
    ctx.fillText(String(hInn[i]), colX, y + rowH * 2 + rowH / 2)
    colX += innColW
  }
  ctx.fillText(String(game.home_score ?? '-'), colX, y + rowH * 2 + rowH / 2)
  colX += innColW
  ctx.fillText(String(game.home_hits ?? '-'), colX, y + rowH * 2 + rowH / 2)
  colX += innColW
  ctx.fillText(String(game.home_errors ?? '-'), colX, y + rowH * 2 + rowH / 2)
}

// ── Draw top performers section ──
async function drawTopPerformers(ctx, performers, x, y, w, h) {
  if (!performers || performers.length === 0) return 0

  const pad = 8
  const perfH = 40
  const maxPerfs = 6
  const perfs = performers.slice(0, maxPerfs)
  const totalH = perfs.length * perfH

  // Draw each performer card
  for (let i = 0; i < perfs.length; i++) {
    const p = perfs[i]
    const py = y + i * perfH
    const pMidY = py + perfH / 2

    // Alternating background
    if (i % 2 === 0) {
      ctx.fillStyle = '#f8fafc'
      ctx.fillRect(x, py, w, perfH)
    } else {
      ctx.fillStyle = COLORS.white
      ctx.fillRect(x, py, w, perfH)
    }

    // Separator line
    ctx.fillStyle = '#e2e8f0'
    ctx.fillRect(x, py, w, 0.5)

    let curX = x + pad

    // Team logo
    const logoSize = 24
    if (p.team_logo) {
      try {
        const img = await loadImage(p.team_logo)
        const a = img.naturalWidth / img.naturalHeight
        let dw = logoSize, dh = logoSize
        if (a >= 1) dh = logoSize / a; else dw = logoSize * a
        ctx.drawImage(img, curX + (logoSize - dw) / 2, pMidY - dh / 2, dw, dh)
      } catch { /* skip */ }
    }
    curX += logoSize + 8

    // Player name
    const name = p.display_name || 'Unknown'
    ctx.fillStyle = COLORS.text_dark
    ctx.font = '600 12px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(name, curX, pMidY - 8)

    // Stat line
    ctx.fillStyle = COLORS.text_gray
    ctx.font = '500 10px "Inter", system-ui, sans-serif'
    ctx.fillText(p.stat_line || '', curX, pMidY + 8)

    // Badge (BAT/PITCH or decision)
    const badgeX = x + w - pad - 40
    const badgeY = pMidY - 10
    let badgeColor = COLORS.green_accent
    let badgeText = p.type === 'pitcher' ? 'PITCH' : 'BAT'

    if (p.type === 'pitcher') {
      if (p.decision === 'W') badgeColor = '#16a34a'
      else if (p.decision === 'L') badgeColor = '#dc2626'
      else if (p.decision === 'S') badgeColor = '#2563eb'
      badgeText = p.decision || 'PITCH'
    }

    roundRect(ctx, badgeX, badgeY, 38, 20, 3)
    ctx.fillStyle = badgeColor
    ctx.fill()
    ctx.fillStyle = COLORS.white
    ctx.font = '700 9px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(badgeText, badgeX + 19, badgeY + 10)
  }

  return totalH
}

// ── Header bar ──
async function drawHeader(ctx, date, x, y, w, h) {
  // Full dark green header
  ctx.fillStyle = COLORS.green_dark
  ctx.fillRect(x, y, w, h)

  // Accent line at bottom
  ctx.fillStyle = COLORS.green_light
  ctx.fillRect(x, y + h - 3, w, 3)

  const logoSize = 60
  const pad = 30

  // NW logo on left
  try {
    const img = await loadImage('/images/nw-logo-white.png')
    const a = img.naturalWidth / img.naturalHeight
    let dw = logoSize, dh = logoSize
    if (a >= 1) dh = logoSize / a; else dw = logoSize * a
    ctx.drawImage(img, pad, y + (h - dh) / 2, dw, dh)
  } catch { /* skip */ }

  // PNWCBR logo on right
  try {
    const img = await loadImage('/images/cbr-logo.jpg')
    const a = img.naturalWidth / img.naturalHeight
    let dw = logoSize, dh = logoSize
    if (a >= 1) dh = logoSize / a; else dw = logoSize * a
    ctx.drawImage(img, w - pad - dw, y + (h - dh) / 2, dw, dh)
  } catch { /* skip */ }

  // "DAILY RECAP" centered, large
  ctx.fillStyle = COLORS.white
  ctx.font = '800 32px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('DAILY RECAP', x + w / 2, y + h / 2 - 10)

  // Date below title
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.font = '500 16px "Inter", system-ui, sans-serif'
  ctx.fillText(date, x + w / 2, y + h / 2 + 18)
}

// ── Footer bar ──
function drawFooter(ctx, x, y, w, h) {
  ctx.fillStyle = COLORS.green_dark
  ctx.fillRect(x, y, w, h)

  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.font = '600 12px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('NWBASEBALLSTATS.COM x PNWCBR', x + w / 2, y + h / 2)
}

// ── Enrich a game object with team info from the API response ──
function enrichGame(gameObj, data) {
  const teamA = data.team_a || {}
  const teamB = data.team_b || {}
  // Figure out which team is home/away for this game
  const homeIsA = gameObj.home_team_id === teamA.team_id
  const home = homeIsA ? teamA : teamB
  const away = homeIsA ? teamB : teamA
  return {
    ...gameObj,
    home_short: home.short_name || 'TBD',
    away_short: away.short_name || 'TBD',
    home_logo: home.logo_url || '',
    away_logo: away.logo_url || '',
    home_record: home.record || {},
    away_record: away.record || {},
    game_date: data.date,
  }
}

// ── Main renderer (1080x1080) ──
async function renderDailyGraphic(canvas, data) {
  const W = 1080
  const H = 1080
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  const allGames = (data.games || []).map(g => enrichGame(g, data))
  const isDoubleheader = allGames.length >= 2

  // Background
  ctx.fillStyle = COLORS.bg_dark
  ctx.fillRect(0, 0, W, H)

  // Header (large, with both logos)
  const headerH = 100
  const dateLabel = data.date ? shortDate(data.date) : ''
  await drawHeader(ctx, dateLabel, 0, 0, W, headerH)

  const footerH = 45
  let curY = headerH + 10

  if (!isDoubleheader) {
    // ── Single game layout ──
    const game = allGames[0] || {}

    // Scorebug
    const scoreH = 180
    await drawDailyScoreBug(ctx, game, 12, curY, W - 24, scoreH)
    curY += scoreH + 10

    // Linescore
    const lineH = 90
    drawLinescore(ctx, game, 12, curY, W - 24, lineH)
    curY += lineH + 12

    // Top performers
    ctx.fillStyle = COLORS.green_light
    ctx.font = '700 16px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('TOP PERFORMERS', 20, curY + 12)
    curY += 30

    const allPerfs = [...(game.top_performers || [])].sort((a, b) => (b.perf_score || 0) - (a.perf_score || 0))
    await drawTopPerformers(ctx, allPerfs, 12, curY, W - 24, H - curY - footerH - 10)
  } else {
    // ── Doubleheader layout ──
    const spacePerGame = (H - headerH - footerH - 30) / 2

    for (let gi = 0; gi < 2; gi++) {
      const game = allGames[gi] || {}

      // Game label
      ctx.fillStyle = COLORS.green_light
      ctx.font = '700 14px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(`GAME ${gi + 1}`, 20, curY + 8)
      curY += 20

      // Smaller scorebug
      const scoreH = 140
      await drawDailyScoreBug(ctx, game, 12, curY, W - 24, scoreH)
      curY += scoreH + 6

      // Smaller linescore
      const lineH = 70
      drawLinescore(ctx, game, 12, curY, W - 24, lineH)
      curY += lineH + 6

      // Top performers for this game
      ctx.fillStyle = COLORS.green_light
      ctx.font = '700 12px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText('TOP PERFORMERS', 20, curY + 8)
      curY += 20

      const allPerfs = [...(game.top_performers || [])].sort((a, b) => (b.perf_score || 0) - (a.perf_score || 0))
      const maxPerfH = spacePerGame - scoreH - lineH - 60
      const perfH = await drawTopPerformers(ctx, allPerfs.slice(0, 4), 12, curY, W - 24, maxPerfH)
      curY += perfH + 10
    }
  }

  // Footer
  drawFooter(ctx, 0, H - footerH, W, footerH)
}

// ── Component ──
export default function DailyRecapGraphic() {
  const [dates, setDates] = useState([])
  const [selectedDate, setSelectedDate] = useState('')
  const [matchups, setMatchups] = useState([])
  const [selectedMatchup, setSelectedMatchup] = useState(null)
  const [gameData, setGameData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [rendered, setRendered] = useState(false)
  const canvasRef = useRef(null)

  // Fetch available dates
  useEffect(() => {
    async function fetchDates() {
      try {
        const res = await fetch(`${API_BASE}/games/daily-recap-dates?season=2026`)
        if (!res.ok) throw new Error(`API error: ${res.status}`)
        const json = await res.json()
        setDates(json.dates || [])
        if (json.dates?.length > 0) {
          setSelectedDate(json.dates[0])
        }
      } catch (err) {
        setError(err.message)
      }
    }
    fetchDates()
  }, [])

  // Fetch matchups for selected date
  const fetchMatchups = useCallback(async (date) => {
    if (!date) return
    setLoading(true)
    setError(null)
    setSelectedMatchup(null)
    setGameData(null)
    setRendered(false)
    try {
      const res = await fetch(`${API_BASE}/games/daily-recap-matchups?date=${date}&season=2026`)
      if (!res.ok) throw new Error(`API error: ${res.status}`)
      const json = await res.json()
      setMatchups(json.matchups || [])
      if (json.matchups?.length > 0) {
        setSelectedMatchup(json.matchups[0])
      }
    } catch (err) {
      setError(err.message)
      setMatchups([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch game data for selected matchup
  const fetchGameData = useCallback(async (date, matchup) => {
    if (!date || !matchup) return
    setLoading(true)
    setError(null)
    setRendered(false)
    try {
      const res = await fetch(
        `${API_BASE}/games/daily-recap?date=${date}&home_team_id=${matchup.home_team_id}&away_team_id=${matchup.away_team_id}&season=2026`
      )
      if (!res.ok) throw new Error(`API error: ${res.status}`)
      const json = await res.json()
      setGameData(json)
    } catch (err) {
      setError(err.message)
      setGameData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMatchups(selectedDate)
  }, [selectedDate, fetchMatchups])

  useEffect(() => {
    fetchGameData(selectedDate, selectedMatchup)
  }, [selectedDate, selectedMatchup, fetchGameData])

  const generate = useCallback(async () => {
    if (!gameData || !canvasRef.current) return
    await renderDailyGraphic(canvasRef.current, gameData)
    setRendered(true)
  }, [gameData])

  useEffect(() => {
    if (gameData) generate()
    else setRendered(false)
  }, [gameData, generate])

  const download = () => {
    if (!canvasRef.current || !gameData) return
    const link = document.createElement('a')
    const away = cleanTeamName(gameData.away_short).replace(/\s+/g, '-').toLowerCase()
    const home = cleanTeamName(gameData.home_short).replace(/\s+/g, '-').toLowerCase()
    link.download = `daily-recap-${away}-vs-${home}-${selectedDate}.png`
    link.href = canvasRef.current.toDataURL('image/png')
    link.click()
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Daily Recap</h1>
      <p className="text-sm text-gray-500 mb-5">Generate a shareable daily recap graphic for any game.</p>

      {/* Date selector */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <select
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal"
        >
          {dates.map(d => (
            <option key={d} value={d}>
              {shortDate(d)}
            </option>
          ))}
        </select>

        {rendered && (
          <button onClick={download}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-nw-teal hover:bg-nw-teal/90 transition-colors">
            Download PNG
          </button>
        )}
      </div>

      {/* Matchup selector */}
      {matchups.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {matchups.map((m, i) => (
            <button key={i} onClick={() => setSelectedMatchup(m)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                selectedMatchup?.away_team_id === m.away_team_id && selectedMatchup?.home_team_id === m.home_team_id
                  ? 'bg-pnw-slate text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>
              {cleanTeamName(m.away_short)} vs {cleanTeamName(m.home_short)}
            </button>
          ))}
        </div>
      )}

      {loading && <p className="text-sm text-gray-400 mb-4">Loading game data...</p>}
      {error && <p className="text-sm text-red-500 mb-4">Error: {error}</p>}
      {!loading && matchups.length === 0 && (
        <p className="text-sm text-gray-400 mb-4">No games found for this date.</p>
      )}

      <div className="rounded-lg overflow-hidden shadow-lg border border-gray-200 inline-block">
        <canvas ref={canvasRef}
          style={{ width: '100%', maxWidth: 540, height: 'auto', aspectRatio: '1/1', display: gameData ? 'block' : 'none' }} />
      </div>
    </div>
  )
}
