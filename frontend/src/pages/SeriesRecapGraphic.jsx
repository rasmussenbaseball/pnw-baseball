import { useState, useRef, useCallback, useEffect } from 'react'

const API_BASE = '/api/v1'

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Find the Tuesday that starts the current week
function currentWeekTuesday() {
  const d = new Date()
  const day = d.getDay() // 0=Sun, 1=Mon, 2=Tue
  const diff = (day < 2) ? (day + 5) : (day - 2) // days since last Tuesday
  d.setDate(d.getDate() - diff)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function shortDate(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function cleanTeamName(name) {
  if (!name) return '???'
  let n = name.trim()
  n = n.replace(/^(?:No\.\s*\d+\s+|#\d+\s+|\(\d+\))\s+/i, '')
  n = n.replace(/(?<=[a-zA-Z])(\d+)$/, '')
  return n.trim() || '???'
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

// ── Draw a single scorebug for the series ──
async function drawSeriesScorebug(ctx, game, x, y, w, h) {
  const away = cleanTeamName(game.away_short)
  const home = cleanTeamName(game.home_short)
  const aScore = game.away_score ?? '-'
  const hScore = game.home_score ?? '-'
  const aWon = Number(game.away_score) > Number(game.home_score)
  const hWon = Number(game.home_score) > Number(game.away_score)

  const s = Math.min(h / 80, w / 240)
  const nameFS = Math.max(7, 12 * s)
  const scoreFS = Math.max(8, 15 * s)
  const smallFS = Math.max(5, 8 * s)
  const wlsFS = Math.max(5, 7 * s)
  const logoSize = Math.max(10, 20 * s)
  const pad = Math.max(3, 5 * s)
  const radius = Math.max(3, 5 * s)

  // Card bg
  roundRect(ctx, x, y, w, h, radius)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 0.5
  ctx.stroke()

  // Header bar
  const headerH = Math.max(12, 16 * s)
  ctx.save()
  roundRect(ctx, x, y, w, headerH, radius)
  ctx.clip()
  ctx.fillStyle = '#f1f5f9'
  ctx.fillRect(x, y, w, headerH)
  ctx.restore()

  // Date + FINAL
  const innings = game.innings && game.innings !== 9 ? ` (${game.innings})` : ''
  const dateLabel = game.game_date ? shortDate(game.game_date) : ''
  ctx.fillStyle = '#475569'
  ctx.font = `700 ${Math.max(5, 8 * s)}px "Inter", system-ui, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(`${dateLabel}  FINAL${innings}`, x + pad, y + headerH / 2)

  // W/L
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
  const rheColW = Math.max(14, 20 * s)
  const rheX = x + w - pad - rheColW * 3
  const rheHeaderY = y + headerH + 1 * s
  ctx.fillStyle = '#94a3b8'
  ctx.font = `600 ${Math.max(5, 7 * s)}px "Inter", system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText('R', rheX + rheColW * 0.5, rheHeaderY + 4 * s)
  ctx.fillText('H', rheX + rheColW * 1.5, rheHeaderY + 4 * s)
  ctx.fillText('E', rheX + rheColW * 2.5, rheHeaderY + 4 * s)

  // Team rows
  const teamTop = rheHeaderY + 9 * s
  const teamH = y + h - teamTop - 2 * s
  const rowH = teamH / 2

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
      ctx.fillStyle = '#e2e8f0'
      ctx.fillRect(x + pad, ry - 1, w - pad * 2, 0.5)
    }

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

    const maxNameW = rheX - curX - 2
    ctx.fillStyle = won ? '#0f172a' : '#64748b'
    ctx.font = `${won ? '700' : '500'} ${nameFS}px "Inter", system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    let display = teamName
    while (ctx.measureText(display).width > maxNameW && display.length > 2) display = display.slice(0, -1)
    if (display !== teamName) display += '.'
    ctx.fillText(display, curX, midY)

    // R/H/E values
    ctx.textAlign = 'center'
    ctx.fillStyle = won ? '#0f172a' : '#94a3b8'
    ctx.font = `${won ? '800' : '600'} ${scoreFS}px "Inter", system-ui, sans-serif`
    ctx.fillText(String(score), rheX + rheColW * 0.5, midY)
    ctx.fillStyle = '#64748b'
    ctx.font = `500 ${Math.max(6, 11 * s)}px "Inter", system-ui, sans-serif`
    ctx.fillText(hits != null ? String(hits) : '-', rheX + rheColW * 1.5, midY)
    ctx.fillText(errors != null ? String(errors) : '-', rheX + rheColW * 2.5, midY)
  }
}

// ── Draw top performers table ──
async function drawPerformersTable(ctx, title, players, x, y, w, h, type) {
  const pad = 6
  const titleH = 18
  const rowCount = players.length + 1
  const rowH = Math.min(30, (h - titleH) / Math.max(1, rowCount))
  const logoSize = Math.max(12, rowH - 6)

  ctx.fillStyle = '#00687a'
  ctx.font = '700 11px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(title, x + pad, y + titleH / 2)

  // Table header
  const tableY = y + titleH
  ctx.fillStyle = '#f1f5f9'
  roundRect(ctx, x, tableY, w, rowH, 3)
  ctx.fill()

  ctx.fillStyle = '#64748b'
  ctx.font = '600 9px "Inter", system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  const headerMidY = tableY + rowH / 2

  const nameColW = w * 0.44
  const statCols = type === 'hitter'
    ? ['AB', 'H', 'HR', 'RBI', 'XBH', 'SB', 'AVG']
    : ['IP', 'H', 'K', 'BB', 'ER', 'DEC']
  const statColW = (w - nameColW - pad) / statCols.length

  ctx.textAlign = 'left'
  ctx.fillText('PLAYER', x + pad, headerMidY)
  statCols.forEach((col, i) => {
    ctx.textAlign = 'center'
    ctx.fillText(col, x + nameColW + statColW * i + statColW / 2, headerMidY)
  })

  for (let i = 0; i < players.length; i++) {
    const p = players[i]
    const ry = tableY + rowH + i * rowH
    const rMidY = ry + rowH / 2

    if (i % 2 === 1) {
      ctx.fillStyle = '#fafbfc'
      ctx.fillRect(x, ry, w, rowH)
    }
    ctx.fillStyle = '#f1f5f9'
    ctx.fillRect(x + 2, ry, w - 4, 0.5)

    // Team logo
    let curX = x + pad
    if (p.team_logo) {
      try {
        const img = await loadImage(p.team_logo)
        const a = img.naturalWidth / img.naturalHeight
        let dw = logoSize, dh = logoSize
        if (a >= 1) dh = logoSize / a; else dw = logoSize * a
        ctx.drawImage(img, curX + (logoSize - dw) / 2, rMidY - dh / 2, dw, dh)
      } catch { /* skip */ }
    }
    curX += logoSize + 3

    // Headshot
    if (p.headshot_url) {
      try {
        const img = await loadImage(p.headshot_url)
        const hsSize = logoSize
        ctx.save()
        ctx.beginPath()
        ctx.arc(curX + hsSize / 2, rMidY, hsSize / 2, 0, Math.PI * 2)
        ctx.clip()
        ctx.drawImage(img, curX, rMidY - hsSize / 2, hsSize, hsSize)
        ctx.restore()
        curX += hsSize + 3
      } catch {
        /* skip */
      }
    }

    const name = p.display_name || 'Unknown'
    const team = p.team_short || ''
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#0f172a'
    ctx.font = '600 12px "Inter", system-ui, sans-serif'

    const maxW = x + nameColW - curX - 2
    let displayName = name
    while (ctx.measureText(`${displayName} ${team}`).width > maxW && displayName.length > 3) {
      displayName = displayName.slice(0, -1)
    }
    if (displayName !== name) displayName += '.'
    ctx.fillText(displayName, curX, rMidY)

    const nameW = ctx.measureText(displayName + ' ').width
    ctx.fillStyle = '#94a3b8'
    ctx.font = '400 9px "Inter", system-ui, sans-serif'
    ctx.fillText(team, curX + nameW, rMidY)

    // Stats
    ctx.font = '600 11px "Inter", system-ui, sans-serif'
    ctx.fillStyle = '#0f172a'
    if (type === 'hitter') {
      const avg = p.avg != null ? p.avg.toFixed(3).replace(/^0/, '') : '-'
      const stats = [
        p.at_bats || 0, p.hits || 0, p.home_runs || 0,
        p.rbi || 0, p.xbh || 0, p.stolen_bases || 0, avg,
      ]
      stats.forEach((val, j) => {
        ctx.textAlign = 'center'
        ctx.fillStyle = j === 2 && val > 0 ? '#dc2626' : '#0f172a'
        ctx.font = j === 2 && val > 0 ? '700 11px "Inter", system-ui, sans-serif' : '600 11px "Inter", system-ui, sans-serif'
        ctx.fillText(String(val), x + nameColW + statColW * j + statColW / 2, rMidY)
      })
    } else {
      const ip = fmtIP(p.innings_pitched)
      const dec = p.decision_summary || p.decision || '-'
      const stats = [
        ip, p.hits_allowed != null ? p.hits_allowed : '-',
        p.strikeouts || 0, p.walks || 0,
        p.earned_runs || 0, dec,
      ]
      stats.forEach((val, j) => {
        ctx.textAlign = 'center'
        if (j === 5) {
          const hasW = String(val).includes('W')
          const hasL = String(val).includes('L')
          ctx.fillStyle = hasW ? '#16a34a' : hasL ? '#dc2626' : '#64748b'
          ctx.font = '700 11px "Inter", system-ui, sans-serif'
        } else {
          ctx.fillStyle = '#0f172a'
          ctx.font = '600 11px "Inter", system-ui, sans-serif'
        }
        ctx.fillText(String(val), x + nameColW + statColW * j + statColW / 2, rMidY)
      })
    }
  }
}

// ── Main renderer for a single series (1080x1080) ──
async function renderSeriesGraphic(canvas, series) {
  const W = 1080
  const H = 1080
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  const pad = 24

  // White bg
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  // ── Header bar ──
  const headerH = 60
  ctx.fillStyle = '#00687a'
  ctx.fillRect(0, 0, W, headerH)

  // NW badge
  ctx.fillStyle = 'rgba(255,255,255,0.2)'
  roundRect(ctx, pad, 12, 34, 34, 5)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 16px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('NW', pad + 17, 30)

  ctx.fillStyle = '#ffffff'
  ctx.font = '800 24px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('SERIES RECAP', W / 2, headerH / 2)

  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.font = '500 10px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText(series.date_range || '', W - pad, headerH / 2)

  ctx.fillStyle = '#0f172a'
  ctx.fillRect(0, headerH, W, 3)

  let curY = headerH + 3 + 14

  // ── Series matchup header: logos + names + result ──
  const teamA = series.team_a
  const teamB = series.team_b
  const matchupH = 90
  const logoSz = 60

  // Team A logo
  const logoAX = W * 0.22
  const logoBX = W * 0.78
  const logoMidY = curY + matchupH / 2

  try {
    const imgA = await loadImage(teamA.logo_url)
    const aA = imgA.naturalWidth / imgA.naturalHeight
    let dwA = logoSz, dhA = logoSz
    if (aA >= 1) dhA = logoSz / aA; else dwA = logoSz * aA
    ctx.drawImage(imgA, logoAX - dwA / 2, logoMidY - dhA / 2, dwA, dhA)
  } catch { /* skip */ }

  try {
    const imgB = await loadImage(teamB.logo_url)
    const aB = imgB.naturalWidth / imgB.naturalHeight
    let dwB = logoSz, dhB = logoSz
    if (aB >= 1) dhB = logoSz / aB; else dwB = logoSz * aB
    ctx.drawImage(imgB, logoBX - dwB / 2, logoMidY - dhB / 2, dwB, dhB)
  } catch { /* skip */ }

  // Team names
  ctx.fillStyle = '#0f172a'
  ctx.font = '800 22px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(cleanTeamName(teamA.short_name), logoAX, logoMidY + logoSz / 2 + 14)
  ctx.fillText(cleanTeamName(teamB.short_name), logoBX, logoMidY + logoSz / 2 + 14)

  // Records
  if (teamA.record) {
    ctx.fillStyle = '#94a3b8'
    ctx.font = '500 12px "Inter", system-ui, sans-serif'
    ctx.fillText(`(${teamA.record})`, logoAX, logoMidY + logoSz / 2 + 30)
  }
  if (teamB.record) {
    ctx.fillStyle = '#94a3b8'
    ctx.font = '500 12px "Inter", system-ui, sans-serif'
    ctx.fillText(`(${teamB.record})`, logoBX, logoMidY + logoSz / 2 + 30)
  }

  // "VS" in the middle
  ctx.fillStyle = '#94a3b8'
  ctx.font = '700 16px "Inter", system-ui, sans-serif'
  ctx.fillText('VS', W / 2, logoMidY)

  // Series result
  ctx.fillStyle = '#00687a'
  ctx.font = '800 20px "Inter", system-ui, sans-serif'
  ctx.fillText(series.result_text || '', W / 2, logoMidY + 30)

  curY += matchupH + 50

  // ── Win probability bar ──
  if (series.win_probability) {
    const wp = series.win_probability
    const barW = W - pad * 2 - 160
    const barH = 22
    const barX = pad + 80
    const barY = curY

    ctx.fillStyle = '#64748b'
    ctx.font = '600 10px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText("TODAY'S PROJECTED MATCHUP", W / 2, barY - 8)

    // Bar background
    roundRect(ctx, barX, barY, barW, barH, 4)
    ctx.fillStyle = '#e2e8f0'
    ctx.fill()

    // Team A side (teal)
    const aPct = wp.team_a_prob
    const aBarW = barW * aPct
    ctx.save()
    roundRect(ctx, barX, barY, barW, barH, 4)
    ctx.clip()
    ctx.fillStyle = '#00687a'
    ctx.fillRect(barX, barY, aBarW, barH)
    ctx.restore()

    // Percentages
    ctx.fillStyle = '#0f172a'
    ctx.font = '700 13px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(`${Math.round(aPct * 100)}%`, barX - 8, barY + barH / 2)
    ctx.textAlign = 'left'
    ctx.fillText(`${Math.round((1 - aPct) * 100)}%`, barX + barW + 8, barY + barH / 2)

    // Spread
    if (series.spread != null && series.spread !== 0) {
      const favTeam = series.spread > 0 ? teamA.short_name : teamB.short_name
      const spreadVal = Math.abs(series.spread)
      ctx.fillStyle = '#94a3b8'
      ctx.font = '500 10px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`${cleanTeamName(favTeam)} -${spreadVal.toFixed(1)}`, W / 2, barY + barH + 14)
    }

    curY += barH + 32
  }

  // ── Team series stats ──
  const statsY = curY
  const statsH = 36
  ctx.fillStyle = '#f8fafc'
  roundRect(ctx, pad, statsY, W - pad * 2, statsH, 5)
  ctx.fill()
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 0.5
  ctx.stroke()

  const statsLabels = ['RUNS', 'HITS', 'ERRORS']
  const teamAStats = [teamA.series_runs, teamA.series_hits, teamA.series_errors]
  const teamBStats = [teamB.series_runs, teamB.series_hits, teamB.series_errors]
  const statSpacing = (W - pad * 2) / (statsLabels.length + 2)
  const statsMidY = statsY + statsH / 2

  // Team names on sides
  ctx.fillStyle = '#00687a'
  ctx.font = '700 11px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(cleanTeamName(teamA.short_name), pad + 10, statsMidY)
  ctx.textAlign = 'right'
  ctx.fillText(cleanTeamName(teamB.short_name), W - pad - 10, statsMidY)

  statsLabels.forEach((label, i) => {
    const centerX = pad + statSpacing * (i + 1.5)
    ctx.fillStyle = '#94a3b8'
    ctx.font = '600 8px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(label, centerX, statsMidY - 8)

    // Team A value
    const aVal = teamAStats[i] || 0
    const bVal = teamBStats[i] || 0
    const aWins = (label === 'ERRORS') ? aVal < bVal : aVal > bVal

    ctx.font = '700 13px "Inter", system-ui, sans-serif'
    ctx.fillStyle = aWins ? '#00687a' : '#64748b'
    ctx.textAlign = 'right'
    ctx.fillText(String(aVal), centerX - 14, statsMidY + 6)

    ctx.fillStyle = '#94a3b8'
    ctx.font = '400 10px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('-', centerX, statsMidY + 6)

    ctx.font = '700 13px "Inter", system-ui, sans-serif'
    ctx.fillStyle = !aWins ? '#00687a' : '#64748b'
    ctx.textAlign = 'left'
    ctx.fillText(String(bVal), centerX + 14, statsMidY + 6)
  })

  curY = statsY + statsH + 16

  // ── Scorebugs ──
  const numGames = series.scorebugs.length
  const bugW = (W - pad * 2 - (numGames - 1) * 8) / numGames
  const bugH = Math.min(86, bugW * 0.38)

  for (let i = 0; i < numGames; i++) {
    const bx = pad + i * (bugW + 8)
    await drawSeriesScorebug(ctx, series.scorebugs[i], bx, curY, bugW, bugH)
  }

  curY += bugH + 20

  // ── Top performers ──
  const perfH = H - curY - 30  // leave room for footer
  const halfW = (W - pad * 2 - 12) / 2

  if (series.top_hitters?.length > 0) {
    await drawPerformersTable(ctx, 'TOP HITTERS', series.top_hitters, pad, curY, halfW, perfH, 'hitter')
  }
  if (series.top_pitchers?.length > 0) {
    await drawPerformersTable(ctx, 'TOP PITCHERS', series.top_pitchers, pad + halfW + 12, curY, halfW, perfH, 'pitcher')
  }

  // ── Footer ──
  const footerY = H - 18
  ctx.fillStyle = '#e2e8f0'
  ctx.fillRect(pad, footerY - 8, W - pad * 2, 1)
  ctx.fillStyle = '#00687a'
  ctx.font = '700 10px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('PNWBASEBALLSTATS.COM', pad, footerY)
  ctx.fillStyle = '#94a3b8'
  ctx.font = '500 8px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText('2026 Season', W - pad, footerY)
}

// ── Component ──
export default function SeriesRecapGraphic() {
  const [weeks, setWeeks] = useState([])
  const [selectedWeek, setSelectedWeek] = useState('')
  const [seriesData, setSeriesData] = useState(null)
  const [selectedSeriesIdx, setSelectedSeriesIdx] = useState(0)
  const [divFilter, setDivFilter] = useState('ALL')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [rendered, setRendered] = useState(false)
  const canvasRef = useRef(null)

  const DIV_OPTIONS = ['ALL', 'D1', 'D2', 'D3', 'NAIA', 'JUCO']

  // Fetch available weeks on mount
  useEffect(() => {
    async function fetchWeeks() {
      try {
        const res = await fetch(`${API_BASE}/games/series-weeks?season=2026`)
        if (!res.ok) throw new Error(`API error: ${res.status}`)
        const json = await res.json()
        setWeeks(json.weeks || [])
        // Default to current week
        const current = (json.weeks || []).find(w => w.is_current)
        if (current) setSelectedWeek(current.week_start)
        else if (json.weeks?.length) setSelectedWeek(json.weeks[json.weeks.length - 1].week_start)
      } catch (err) {
        setError(err.message)
      }
    }
    fetchWeeks()
  }, [])

  // Fetch series data when week changes
  const fetchSeries = useCallback(async (weekStart) => {
    if (!weekStart) return
    setLoading(true)
    setError(null)
    setRendered(false)
    setSelectedSeriesIdx(0)
    try {
      const res = await fetch(`${API_BASE}/games/series-recap?week_start=${weekStart}&season=2026`)
      if (!res.ok) throw new Error(`API error: ${res.status}`)
      const json = await res.json()
      setSeriesData(json)
    } catch (err) {
      setError(err.message)
      setSeriesData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSeries(selectedWeek) }, [selectedWeek, fetchSeries])

  // Filter series by division
  const filteredSeries = seriesData?.series?.filter(s =>
    divFilter === 'ALL' || (s.division || '').toUpperCase() === divFilter
  ) || []

  const currentSeries = filteredSeries[selectedSeriesIdx] || null

  // Render canvas when series selection changes
  const generate = useCallback(async () => {
    if (!currentSeries || !canvasRef.current) return
    await renderSeriesGraphic(canvasRef.current, currentSeries)
    setRendered(true)
  }, [currentSeries])

  useEffect(() => {
    if (currentSeries) generate()
    else setRendered(false)
  }, [currentSeries, generate])

  // Reset series index when division filter changes
  useEffect(() => { setSelectedSeriesIdx(0) }, [divFilter])

  const download = () => {
    if (!canvasRef.current || !currentSeries) return
    const link = document.createElement('a')
    const a = cleanTeamName(currentSeries.team_a.short_name).replace(/\s+/g, '-').toLowerCase()
    const b = cleanTeamName(currentSeries.team_b.short_name).replace(/\s+/g, '-').toLowerCase()
    link.download = `series-${a}-vs-${b}-${selectedWeek}.png`
    link.href = canvasRef.current.toDataURL('image/png')
    link.click()
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Series Recap</h1>
      <p className="text-sm text-gray-500 mb-5">Generate a shareable series recap graphic for any week.</p>

      {/* Week selector */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <select
          value={selectedWeek}
          onChange={(e) => setSelectedWeek(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal"
        >
          {weeks.map(w => (
            <option key={w.week_start} value={w.week_start}>
              {w.label}{w.is_current ? ' (Current)' : ''}
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

      {/* Division filter */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {DIV_OPTIONS.map(d => (
          <button key={d} onClick={() => setDivFilter(d)}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
              divFilter === d ? 'bg-nw-teal text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}>{d === 'ALL' ? 'All' : d}</button>
        ))}
      </div>

      {/* Series selector (if multiple in one week) */}
      {filteredSeries.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {filteredSeries.map((s, i) => (
            <button key={i} onClick={() => setSelectedSeriesIdx(i)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                selectedSeriesIdx === i
                  ? 'bg-pnw-slate text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>
              {cleanTeamName(s.team_a.short_name)} vs {cleanTeamName(s.team_b.short_name)}
            </button>
          ))}
        </div>
      )}

      {loading && <p className="text-sm text-gray-400 mb-4">Loading series...</p>}
      {error && <p className="text-sm text-red-500 mb-4">Error: {error}</p>}
      {!loading && seriesData && filteredSeries.length === 0 && (
        <p className="text-sm text-gray-400 mb-4">No {divFilter !== 'ALL' ? divFilter + ' ' : ''}series found for this week.</p>
      )}
      {!loading && filteredSeries.length > 0 && (
        <p className="text-sm text-gray-500 mb-4">
          {filteredSeries.length} series found &middot; {currentSeries?.result_text}
        </p>
      )}

      <div className="rounded-lg overflow-hidden shadow-lg border border-gray-200 inline-block">
        <canvas ref={canvasRef}
          style={{ width: '100%', maxWidth: 540, height: 'auto', aspectRatio: '1/1', display: currentSeries ? 'block' : 'none' }} />
      </div>
    </div>
  )
}
