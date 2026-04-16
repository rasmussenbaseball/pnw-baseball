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

// Minimum performance thresholds for "both" view
const MIN_HITTING_SCORE = 1.0   // ~1-for-4 with a walk or run scored
const MIN_PITCHING_SCORE = 1.5  // ~2 IP with a K or two and few ER

// Very low thresholds for single-team view (any hit or decent outing)
const MIN_HITTING_SCORE_TEAM = 0.3   // basically any hit or walk
const MIN_PITCHING_SCORE_TEAM = -1.0 // any pitcher who didn't get shelled

function filterTopPerformers(performers, maxCount = 6, useTeamThresholds = false) {
  if (!performers) return []
  const hitMin = useTeamThresholds ? MIN_HITTING_SCORE_TEAM : MIN_HITTING_SCORE
  const pitchMin = useTeamThresholds ? MIN_PITCHING_SCORE_TEAM : MIN_PITCHING_SCORE
  return performers
    .filter(p => {
      const threshold = p.type === 'pitcher' ? pitchMin : hitMin
      return (p.perf_score || 0) >= threshold
    })
    .sort((a, b) => (b.perf_score || 0) - (a.perf_score || 0))
    .slice(0, maxCount)
}

// ── Draw combined scorebug with inning-by-inning built in ──
async function drawScoreBugWithInnings(ctx, game, x, y, w, h) {
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

  // Green header bar
  const headerH = 26
  ctx.save()
  roundRect(ctx, x, y, w, headerH, radius)
  ctx.clip()
  ctx.fillStyle = COLORS.green_dark
  ctx.fillRect(x, y, w, headerH)
  ctx.restore()

  ctx.fillStyle = COLORS.white
  ctx.font = '700 12px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  ctx.fillText('FINAL', x + w - pad, y + headerH / 2)

  // Layout: [Logo+Name] [1 2 3 4 5 6 7 8 9] [R H E]
  const logoSize = 32
  const nameAreaW = 160
  const rheAreaW = 120  // R, H, E columns
  const innAreaW = w - nameAreaW - rheAreaW - pad * 2
  const innX = x + nameAreaW
  const rheX = x + w - rheAreaW - pad
  const innColW = innAreaW / 9
  const rheColW = rheAreaW / 3

  // Inning column headers
  const colHeaderY = y + headerH + 4
  ctx.fillStyle = COLORS.text_gray
  ctx.font = '600 10px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < 9; i++) {
    ctx.fillText(String(i + 1), innX + i * innColW + innColW / 2, colHeaderY + 7)
  }
  ctx.fillText('R', rheX + rheColW * 0.5, colHeaderY + 7)
  ctx.fillText('H', rheX + rheColW * 1.5, colHeaderY + 7)
  ctx.fillText('E', rheX + rheColW * 2.5, colHeaderY + 7)

  // Get inning scores
  const awayLine = game.away_line_score || []
  const homeLine = game.home_line_score || []

  // Two team rows
  const rowTop = colHeaderY + 18
  const rowH = (y + h - rowTop - 30) / 2

  for (let t = 0; t < 2; t++) {
    const isAway = t === 0
    const teamName = isAway ? away : home
    const score = isAway ? aScore : hScore
    const won = isAway ? aWon : hWon
    const logo = isAway ? game.away_logo : game.home_logo
    const hits = isAway ? game.away_hits : game.home_hits
    const errors = isAway ? game.away_errors : game.home_errors
    const lineScore = isAway ? awayLine : homeLine
    const ry = rowTop + t * rowH
    const midY = ry + rowH / 2

    // Separator
    if (t === 1) {
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
    curX += logoSize + 8

    // Team name
    ctx.fillStyle = won ? COLORS.text_dark : COLORS.text_gray
    ctx.font = `${won ? '700' : '500'} 16px "Inter", system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    let display = teamName
    const maxNameW = innX - curX - 6
    while (ctx.measureText(display).width > maxNameW && display.length > 2) display = display.slice(0, -1)
    if (display !== teamName) display += '.'
    ctx.fillText(display, curX, midY)

    // Inning scores
    ctx.font = '500 13px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillStyle = COLORS.text_dark
    for (let i = 0; i < 9; i++) {
      const val = i < lineScore.length && lineScore[i] != null ? lineScore[i] : '-'
      ctx.fillText(String(val), innX + i * innColW + innColW / 2, midY)
    }

    // R (bold), H, E
    ctx.fillStyle = won ? COLORS.text_dark : COLORS.text_gray
    ctx.font = `${won ? '800' : '600'} 20px "Inter", system-ui, sans-serif`
    ctx.fillText(String(score), rheX + rheColW * 0.5, midY)
    ctx.font = '500 14px "Inter", system-ui, sans-serif'
    ctx.fillStyle = COLORS.text_gray
    ctx.fillText(hits != null ? String(hits) : '-', rheX + rheColW * 1.5, midY)
    ctx.fillText(errors != null ? String(errors) : '-', rheX + rheColW * 2.5, midY)
  }

  // W/L/S pitchers at bottom
  const wlY = y + h - 14
  const wlParts = []
  if (game.win_pitcher) wlParts.push({ label: 'W', name: game.win_pitcher, color: '#16a34a' })
  if (game.loss_pitcher) wlParts.push({ label: 'L', name: game.loss_pitcher, color: '#dc2626' })
  if (game.save_pitcher) wlParts.push({ label: 'S', name: game.save_pitcher, color: '#2563eb' })
  if (wlParts.length > 0) {
    ctx.textBaseline = 'middle'
    const gap = 14
    let totalW = 0
    wlParts.forEach((p, i) => {
      ctx.font = '700 11px "Inter", system-ui, sans-serif'
      totalW += ctx.measureText(`${p.label}: `).width
      ctx.font = '500 11px "Inter", system-ui, sans-serif'
      totalW += ctx.measureText(p.name).width
      if (i < wlParts.length - 1) totalW += gap
    })
    let drawX = x + (w - totalW) / 2
    wlParts.forEach((p) => {
      ctx.textAlign = 'left'
      ctx.fillStyle = p.color
      ctx.font = '700 11px "Inter", system-ui, sans-serif'
      const labelStr = `${p.label}: `
      ctx.fillText(labelStr, drawX, wlY)
      drawX += ctx.measureText(labelStr).width
      ctx.fillStyle = '#334155'
      ctx.font = '500 11px "Inter", system-ui, sans-serif'
      ctx.fillText(p.name, drawX, wlY)
      drawX += ctx.measureText(p.name).width + gap
    })
  }
}

// ── Draw a single performer card ──
async function drawPerformerCard(ctx, p, px, py, cardW, cardH) {
  const pad = 12

  // Card background
  roundRect(ctx, px, py, cardW, cardH, 8)
  ctx.fillStyle = '#f8fafc'
  ctx.fill()
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 0.5
  ctx.stroke()

  // Left accent bar (green for team color)
  roundRect(ctx, px, py, 4, cardH, 8)
  ctx.fillStyle = COLORS.green_light
  ctx.fill()

  const pMidY = py + cardH / 2
  let curX = px + pad + 6

  // Team logo (larger)
  const logoSize = Math.min(cardH * 0.5, 44)
  if (p.team_logo) {
    try {
      const img = await loadImage(p.team_logo)
      const a = img.naturalWidth / img.naturalHeight
      let dw = logoSize, dh = logoSize
      if (a >= 1) dh = logoSize / a; else dw = logoSize * a
      ctx.drawImage(img, curX + (logoSize - dw) / 2, pMidY - dh / 2, dw, dh)
    } catch { /* skip */ }
  }
  curX += logoSize + 12

  // Player name + year/position tag
  const nameFontSize = Math.min(Math.floor(cardH * 0.2), 18)
  const name = p.player_name || 'Unknown'
  const maxW = cardW - logoSize - pad * 2 - 20

  // Build year/position tag (e.g. "Jr. | SS" or "So. | RHP")
  const tagParts = []
  if (p.year) tagParts.push(p.year.replace('Freshman', 'FR').replace('Sophomore', 'SO').replace('Junior', 'JR').replace('Senior', 'SR').replace('Redshirt', 'RS').replace('Fr.', 'FR').replace('So.', 'SO').replace('Jr.', 'JR').replace('Sr.', 'SR').toUpperCase())
  if (p.position) tagParts.push(p.position.toUpperCase())
  const tag = tagParts.join(' | ')

  // Draw name
  ctx.fillStyle = COLORS.text_dark
  ctx.font = `700 ${nameFontSize}px "Inter", system-ui, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  let displayName = name
  while (ctx.measureText(displayName).width > maxW * 0.65 && displayName.length > 3) displayName = displayName.slice(0, -1)
  if (displayName !== name) displayName += '.'

  // Position name and tag on same line
  const nameY = p.commitment ? pMidY - nameFontSize * 0.9 : pMidY - nameFontSize * 0.6
  ctx.fillText(displayName, curX, nameY)

  // Draw year/position tag after name
  if (tag) {
    const nameW = ctx.measureText(displayName + '  ').width
    ctx.fillStyle = COLORS.text_gray
    ctx.font = `500 ${Math.max(nameFontSize - 4, 10)}px "Inter", system-ui, sans-serif`
    ctx.fillText(tag, curX + nameW, nameY)
  }

  // Stat line
  const statFontSize = Math.min(Math.floor(cardH * 0.15), 14)
  const statY = p.commitment ? pMidY + 2 : pMidY + nameFontSize * 0.5
  ctx.fillStyle = COLORS.text_gray
  ctx.font = `500 ${statFontSize}px "Inter", system-ui, sans-serif`
  let statLine = p.stat_line || ''
  while (ctx.measureText(statLine).width > maxW && statLine.length > 3) statLine = statLine.slice(0, -1)
  if (statLine !== (p.stat_line || '')) statLine += '...'
  ctx.fillText(statLine, curX, statY)

  // Commitment line for JUCO players
  if (p.commitment) {
    const commitFontSize = Math.max(statFontSize - 1, 9)
    ctx.fillStyle = p.commitment.startsWith('Committed') ? '#16a34a' : '#94a3b8'
    ctx.font = `600 ${commitFontSize}px "Inter", system-ui, sans-serif`
    ctx.fillText(p.commitment, curX, statY + statFontSize + 4)
  }
}

// ── Draw top performers split by team: left column = away, right column = home ──
async function drawTopPerformers(ctx, performers, game, x, y, w, maxH) {
  if (!performers || performers.length === 0) return 0

  const gap = 10
  const colW = (w - gap) / 2
  const cardGap = 8

  // Split performers by team and filter by threshold (max 3 per team)
  const homeId = game.home_team_id
  const awayId = game.away_team_id
  const awayPerfs = filterTopPerformers(
    performers.filter(p => p.team_id === awayId), 3
  )
  const homePerfs = filterTopPerformers(
    performers.filter(p => p.team_id === homeId), 3
  )

  const maxRows = Math.max(awayPerfs.length, homePerfs.length)
  if (maxRows === 0) return 0

  const perfH = Math.min((maxH - (maxRows - 1) * cardGap) / maxRows, 120)

  // Draw away team performers on left
  for (let i = 0; i < awayPerfs.length; i++) {
    const py = y + i * (perfH + cardGap)
    if (py + perfH > y + maxH) break
    await drawPerformerCard(ctx, awayPerfs[i], x, py, colW, perfH)
  }

  // Draw home team performers on right
  for (let i = 0; i < homePerfs.length; i++) {
    const py = y + i * (perfH + cardGap)
    if (py + perfH > y + maxH) break
    await drawPerformerCard(ctx, homePerfs[i], x + colW + gap, py, colW, perfH)
  }

  return maxRows * (perfH + cardGap)
}

// ── Draw single-team performers (full width, 2 columns, up to 6) ──
async function drawSingleTeamPerformers(ctx, performers, teamId, x, y, w, maxH) {
  if (!performers || performers.length === 0) return 0

  const gap = 10
  const colW = (w - gap) / 2
  const cardGap = 8

  // Filter to just this team's performers with very low threshold, up to 6
  const teamPerfs = filterTopPerformers(
    performers.filter(p => p.team_id === teamId), 6, true
  )
  if (teamPerfs.length === 0) return 0

  const rows = Math.ceil(teamPerfs.length / 2)
  const perfH = Math.min((maxH - (rows - 1) * cardGap) / rows, 120)

  for (let i = 0; i < teamPerfs.length; i++) {
    const col = i % 2
    const row = Math.floor(i / 2)
    const px = x + col * (colW + gap)
    const py = y + row * (perfH + cardGap)
    if (py + perfH > y + maxH) break
    await drawPerformerCard(ctx, teamPerfs[i], px, py, colW, perfH)
  }

  return rows * (perfH + cardGap)
}

// ── Header bar ──
// focusTeam: { name, logo } or null for 'both' mode
async function drawHeader(ctx, date, x, y, w, h, focusTeam = null) {
  // Black header
  ctx.fillStyle = '#000000'
  ctx.fillRect(x, y, w, h)

  // Green accent line at bottom
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

  if (focusTeam) {
    // ── Single-team header: team logo + team name ──
    const teamLogoSize = 48
    const centerX = x + w / 2

    // Team logo next to title
    let teamLogoW = 0
    if (focusTeam.logo) {
      try {
        const img = await loadImage(focusTeam.logo)
        const a = img.naturalWidth / img.naturalHeight
        let dw = teamLogoSize, dh = teamLogoSize
        if (a >= 1) dh = teamLogoSize / a; else dw = teamLogoSize * a
        teamLogoW = dw + 14
        // Measure text to center logo+name together
        ctx.font = '800 28px "Inter", system-ui, sans-serif'
        const titleW = ctx.measureText(focusTeam.name).width
        const totalW = teamLogoW + titleW
        ctx.drawImage(img, centerX - totalW / 2, y + (h - 3) / 2 - dh / 2 - 4, dw, dh)
      } catch { teamLogoW = 0 }
    }

    // Team name
    ctx.fillStyle = COLORS.white
    ctx.font = '800 28px "Inter", system-ui, sans-serif'
    ctx.textAlign = teamLogoW > 0 ? 'left' : 'center'
    ctx.textBaseline = 'middle'
    if (teamLogoW > 0) {
      const titleW = ctx.measureText(focusTeam.name).width
      const totalW = teamLogoW + titleW
      ctx.fillText(focusTeam.name, centerX - totalW / 2 + teamLogoW, y + (h - 3) / 2 - 8)
    } else {
      ctx.fillText(focusTeam.name, centerX, y + (h - 3) / 2 - 8)
    }

    // "DAILY GAME RECAP" smaller below
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.font = '600 14px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('DAILY GAME RECAP', centerX, y + (h - 3) / 2 + 12)

    // Date
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '500 12px "Inter", system-ui, sans-serif'
    ctx.fillText(date, centerX, y + (h - 3) / 2 + 28)
  } else {
    // ── Both teams header ──
    ctx.fillStyle = COLORS.white
    ctx.font = '800 32px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('DAILY GAME RECAP', x + w / 2, y + h / 2 - 10)

    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.font = '500 16px "Inter", system-ui, sans-serif'
    ctx.fillText(date, x + w / 2, y + h / 2 + 18)
  }
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
// viewMode: 'both' | 'home' | 'away'
async function renderDailyGraphic(canvas, data, viewMode = 'both') {
  const W = 1080
  const allGames = (data.games || []).map(g => enrichGame(g, data))
  const isDoubleheader = allGames.length >= 2

  // Determine the focused team for single-team views
  const focusTeamId = viewMode === 'home'
    ? (allGames[0]?.home_team_id)
    : viewMode === 'away'
      ? (allGames[0]?.away_team_id)
      : null
  const focusTeamName = viewMode === 'home'
    ? cleanTeamName(allGames[0]?.home_short)
    : viewMode === 'away'
      ? cleanTeamName(allGames[0]?.away_short)
      : null

  const H = 1080
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  // Background
  ctx.fillStyle = COLORS.bg_dark
  ctx.fillRect(0, 0, W, H)

  // Build focusTeam info for header (single-team modes)
  const focusTeamInfo = focusTeamId ? {
    name: focusTeamName,
    logo: viewMode === 'home'
      ? (allGames[0]?.home_logo)
      : (allGames[0]?.away_logo),
  } : null

  // Header
  const headerH = 100
  const dateLabel = data.date ? shortDate(data.date) : ''
  await drawHeader(ctx, dateLabel, 0, 0, W, headerH, focusTeamInfo)

  const footerH = 45
  let curY = headerH + 10

  if (!isDoubleheader) {
    // ── Single game layout ──
    const game = allGames[0] || {}

    // Combined scorebug with innings
    const scoreH = 180
    await drawScoreBugWithInnings(ctx, game, 12, curY, W - 24, scoreH)
    curY += scoreH + 14

    if (viewMode === 'both') {
      // ── BOTH: split performers by team (3 per side) ──
      const colW_s = (W - 24 - 10) / 2
      ctx.fillStyle = COLORS.green_light
      ctx.font = '700 20px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('TOP PERFORMERS', W / 2, curY + 10)
      curY += 28

      ctx.font = '700 14px "Inter", system-ui, sans-serif'
      ctx.fillStyle = COLORS.text_dark
      ctx.textAlign = 'center'
      ctx.fillText(cleanTeamName(game.away_short), 12 + colW_s / 2, curY + 8)
      ctx.fillText(cleanTeamName(game.home_short), 12 + colW_s + 10 + colW_s / 2, curY + 8)
      curY += 22

      await drawTopPerformers(ctx, game.top_performers, game, 12, curY, W - 24, H - curY - footerH - 10)
    } else {
      // ── SINGLE TEAM: full-width performers (up to 6) ──
      ctx.fillStyle = COLORS.green_light
      ctx.font = '700 20px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(`${focusTeamName} TOP PERFORMERS`, W / 2, curY + 10)
      curY += 34

      await drawSingleTeamPerformers(ctx, game.top_performers, focusTeamId, 12, curY, W - 24, H - curY - footerH - 10)
    }
  } else {
    // ── Doubleheader layout ──
    const spacePerGame = (H - headerH - footerH - 20) / 2

    for (let gi = 0; gi < 2; gi++) {
      const game = allGames[gi] || {}

      // Game label
      ctx.fillStyle = COLORS.green_light
      ctx.font = '700 14px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(`GAME ${gi + 1}`, 20, curY + 6)
      curY += 18

      // Combined scorebug with innings (compact)
      const scoreH = 150
      await drawScoreBugWithInnings(ctx, game, 12, curY, W - 24, scoreH)
      curY += scoreH + 6

      if (viewMode === 'both') {
        // ── BOTH: split by team ──
        const dh_colW = (W - 24 - 10) / 2
        ctx.fillStyle = COLORS.green_light
        ctx.font = '700 13px "Inter", system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('TOP PERFORMERS', W / 2, curY + 5)
        curY += 16

        ctx.font = '600 11px "Inter", system-ui, sans-serif'
        ctx.fillStyle = COLORS.text_dark
        ctx.textAlign = 'center'
        ctx.fillText(cleanTeamName(game.away_short), 12 + dh_colW / 2, curY + 5)
        ctx.fillText(cleanTeamName(game.home_short), 12 + dh_colW + 10 + dh_colW / 2, curY + 5)
        curY += 14

        const maxPerfH = spacePerGame - scoreH - 64
        const perfH = await drawTopPerformers(ctx, game.top_performers, game, 12, curY, W - 24, maxPerfH)
        curY += perfH + 6
      } else {
        // ── SINGLE TEAM: full-width for doubleheader ──
        // Use the focused team's ID from THIS game (home/away might flip between games)
        const thisTeamId = focusTeamId
        ctx.fillStyle = COLORS.green_light
        ctx.font = '700 13px "Inter", system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(`${focusTeamName} TOP PERFORMERS`, W / 2, curY + 5)
        curY += 18

        const maxPerfH = spacePerGame - scoreH - 50
        const perfH = await drawSingleTeamPerformers(ctx, game.top_performers, thisTeamId, 12, curY, W - 24, maxPerfH)
        curY += perfH + 6
      }
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
  const [viewMode, setViewMode] = useState('both') // 'both' | 'away' | 'home'
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
    await renderDailyGraphic(canvasRef.current, gameData, viewMode)
    setRendered(true)
  }, [gameData, viewMode])

  useEffect(() => {
    if (gameData) generate()
    else setRendered(false)
  }, [gameData, generate])

  // Reset viewMode when matchup changes
  useEffect(() => { setViewMode('both') }, [selectedMatchup])

  const download = () => {
    if (!canvasRef.current || !gameData) return
    const link = document.createElement('a')
    const away = (awayName || 'away').replace(/\s+/g, '-').toLowerCase()
    const home = (homeName || 'home').replace(/\s+/g, '-').toLowerCase()
    const suffix = viewMode === 'both' ? '' : `-${viewMode === 'away' ? away : home}`
    link.download = `daily-recap-${away}-vs-${home}${suffix}-${selectedDate}.png`
    link.href = canvasRef.current.toDataURL('image/png')
    link.click()
  }

  // Team names for view mode buttons (API: team_a = home, team_b = away)
  const awayName = gameData ? cleanTeamName(gameData.team_b?.short_name || '') : 'Away'
  const homeName = gameData ? cleanTeamName(gameData.team_a?.short_name || '') : 'Home'

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Daily Game Recap</h1>
      <p className="text-sm text-gray-500 mb-5">Generate a shareable game recap graphic for any matchup.</p>

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

      {/* View mode: Both / Away Team / Home Team */}
      {gameData && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="text-xs text-gray-500 font-medium mr-1">View:</span>
          <button onClick={() => setViewMode('both')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              viewMode === 'both' ? 'bg-nw-teal text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}>Both</button>
          <button onClick={() => setViewMode('away')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              viewMode === 'away' ? 'bg-nw-teal text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}>{awayName}</button>
          <button onClick={() => setViewMode('home')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              viewMode === 'home' ? 'bg-nw-teal text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}>{homeName}</button>
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
