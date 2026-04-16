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

function fmtPct(v) {
  if (v == null) return '0.0%'
  return v.toFixed(1) + '%'
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

// ── Draw a scorebug (compact, for 2x2 grid) ──
async function drawScorebug(ctx, game, x, y, w, h) {
  const away = cleanTeamName(game.away_short)
  const home = cleanTeamName(game.home_short)
  const aScore = game.away_score ?? '-'
  const hScore = game.home_score ?? '-'
  const aWon = Number(game.away_score) > Number(game.home_score)
  const hWon = Number(game.home_score) > Number(game.away_score)
  const pad = 8
  const radius = 6

  // Card bg
  roundRect(ctx, x, y, w, h, radius)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = '#cbd5e1'
  ctx.lineWidth = 1
  ctx.stroke()

  // Header bar with date + FINAL
  const headerH = 22
  ctx.save()
  roundRect(ctx, x, y, w, headerH, radius)
  ctx.clip()
  ctx.fillStyle = '#f1f5f9'
  ctx.fillRect(x, y, w, headerH)
  ctx.restore()
  // Bottom edge of header
  ctx.fillStyle = '#e2e8f0'
  ctx.fillRect(x, y + headerH - 1, w, 1)

  const innings = game.innings && game.innings !== 9 ? ` (${game.innings})` : ''
  const dateLabel = game.game_date ? shortDate(game.game_date) : ''
  ctx.fillStyle = '#475569'
  ctx.font = '700 11px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(`${dateLabel}`, x + pad, y + headerH / 2)

  ctx.fillStyle = '#64748b'
  ctx.font = '600 10px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText(`FINAL${innings}`, x + w - pad, y + headerH / 2)

  // R/H/E column headers
  const rheColW = 28
  const rheX = x + w - pad - rheColW * 3
  const rheHeaderY = y + headerH + 2
  ctx.fillStyle = '#94a3b8'
  ctx.font = '600 9px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('R', rheX + rheColW * 0.5, rheHeaderY + 6)
  ctx.fillText('H', rheX + rheColW * 1.5, rheHeaderY + 6)
  ctx.fillText('E', rheX + rheColW * 2.5, rheHeaderY + 6)

  // Team rows
  const teamTop = rheHeaderY + 14
  const rowH = (y + h - teamTop - 24) / 2  // leave room for W/L line
  const logoSize = 22

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
    curX += logoSize + 6

    // Team name
    const maxNameW = rheX - curX - 4
    ctx.fillStyle = won ? '#0f172a' : '#64748b'
    ctx.font = `${won ? '700' : '500'} 14px "Inter", system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    let display = teamName
    while (ctx.measureText(display).width > maxNameW && display.length > 2) display = display.slice(0, -1)
    if (display !== teamName) display += '.'
    ctx.fillText(display, curX, midY)

    // R/H/E values
    ctx.textAlign = 'center'
    ctx.fillStyle = won ? '#0f172a' : '#94a3b8'
    ctx.font = `${won ? '800' : '600'} 16px "Inter", system-ui, sans-serif`
    ctx.fillText(String(score), rheX + rheColW * 0.5, midY)
    ctx.fillStyle = '#64748b'
    ctx.font = '500 13px "Inter", system-ui, sans-serif'
    ctx.fillText(hits != null ? String(hits) : '-', rheX + rheColW * 1.5, midY)
    ctx.fillText(errors != null ? String(errors) : '-', rheX + rheColW * 2.5, midY)
  }

  // W/L pitchers at bottom
  const wlY = y + h - 14
  const wlParts = []
  if (game.win_pitcher) wlParts.push({ label: 'W', name: game.win_pitcher, color: '#16a34a' })
  if (game.loss_pitcher) wlParts.push({ label: 'L', name: game.loss_pitcher, color: '#dc2626' })
  if (game.save_pitcher) wlParts.push({ label: 'S', name: game.save_pitcher, color: '#2563eb' })
  if (wlParts.length > 0) {
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    // Measure total width to center everything
    const gap = 12
    let totalW = 0
    wlParts.forEach((p, i) => {
      ctx.font = '700 11px "Inter", system-ui, sans-serif'
      totalW += ctx.measureText(`${p.label}: `).width
      ctx.font = '600 11px "Inter", system-ui, sans-serif'
      totalW += ctx.measureText(p.name).width
      if (i < wlParts.length - 1) totalW += gap
    })
    let drawX = x + (w - totalW) / 2
    wlParts.forEach((p, i) => {
      ctx.textAlign = 'left'
      ctx.fillStyle = p.color
      ctx.font = '700 11px "Inter", system-ui, sans-serif'
      const labelStr = `${p.label}: `
      ctx.fillText(labelStr, drawX, wlY)
      drawX += ctx.measureText(labelStr).width
      ctx.fillStyle = '#334155'
      ctx.font = '600 11px "Inter", system-ui, sans-serif'
      ctx.fillText(p.name, drawX, wlY)
      drawX += ctx.measureText(p.name).width + gap
    })
  }
}

// ── Draw a stat comparison row (Team A value | Label | Team B value) ──
function drawStatCompareRow(ctx, label, valA, valB, centerX, y, colW, opts = {}) {
  const { highlight = 'higher', format = 'number', fontSize = 14 } = opts

  // Determine which side wins
  let aWins = false, bWins = false
  const numA = parseFloat(valA), numB = parseFloat(valB)
  if (!isNaN(numA) && !isNaN(numB)) {
    if (highlight === 'higher') { aWins = numA > numB; bWins = numB > numA }
    else if (highlight === 'lower') { aWins = numA < numB; bWins = numB < numA }
  }

  // Label in center
  ctx.fillStyle = '#64748b'
  ctx.font = `600 11px "Inter", system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, centerX, y)

  // Team A value (left)
  ctx.fillStyle = aWins ? '#2E7D32' : '#334155'
  ctx.font = `${aWins ? '800' : '600'} ${fontSize}px "Inter", system-ui, sans-serif`
  ctx.textAlign = 'right'
  ctx.fillText(String(valA), centerX - colW, y)

  // Team B value (right)
  ctx.fillStyle = bWins ? '#2E7D32' : '#334155'
  ctx.font = `${bWins ? '800' : '600'} ${fontSize}px "Inter", system-ui, sans-serif`
  ctx.textAlign = 'left'
  ctx.fillText(String(valB), centerX + colW, y)
}

// ── Draw performer table for one team (with table borders) ──
async function drawTeamPerformers(ctx, title, players, x, y, w, type) {
  const pad = 6
  const titleH = 22
  const rowH = 28
  const logoSize = 20
  const totalRows = players.length + 1 // +1 for header
  const tableH = totalRows * rowH
  const totalH = titleH + tableH

  // Section title
  ctx.fillStyle = '#2E7D32'
  ctx.font = '700 11px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(title, x + pad, y + titleH / 2)

  // Table outline
  const tableY = y + titleH
  roundRect(ctx, x, tableY, w, tableH, 4)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = '#cbd5e1'
  ctx.lineWidth = 1
  ctx.stroke()

  // Header row bg
  ctx.save()
  roundRect(ctx, x, tableY, w, rowH, 4)
  ctx.clip()
  ctx.fillStyle = '#1B5E20'
  ctx.fillRect(x, tableY, w, rowH)
  ctx.restore()

  ctx.fillStyle = '#ffffff'
  ctx.font = '700 8px "Inter", system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  const hMidY = tableY + rowH / 2

  const nameColW = w * 0.26
  const statCols = type === 'hitter'
    ? ['AB', 'H', 'HR', 'RBI', 'XBH', 'SB', 'BB+HBP', 'AVG']
    : ['IP', 'K', 'H', 'ER', 'BB', 'FIP', 'DEC']
  const statColW = (w - nameColW - pad) / statCols.length

  ctx.textAlign = 'left'
  ctx.fillText('PLAYER', x + pad, hMidY)
  statCols.forEach((col, i) => {
    ctx.textAlign = 'center'
    ctx.fillText(col, x + nameColW + statColW * i + statColW / 2, hMidY)
  })

  // Player rows
  for (let i = 0; i < players.length; i++) {
    const p = players[i]
    const ry = tableY + rowH + i * rowH
    const rMidY = ry + rowH / 2

    // Alternating row bg
    if (i % 2 === 1) {
      ctx.fillStyle = '#f8fafc'
      ctx.fillRect(x + 1, ry, w - 2, rowH)
    }

    // Row separator line
    ctx.fillStyle = '#e2e8f0'
    ctx.fillRect(x + 1, ry, w - 2, 0.5)

    let curX = x + pad

    // Headshot
    if (p.headshot_url) {
      try {
        const img = await loadImage(p.headshot_url)
        ctx.save()
        ctx.beginPath()
        ctx.arc(curX + logoSize / 2, rMidY, logoSize / 2, 0, Math.PI * 2)
        ctx.clip()
        ctx.drawImage(img, curX, rMidY - logoSize / 2, logoSize, logoSize)
        ctx.restore()
        curX += logoSize + 4
      } catch { curX += 2 }
    }

    const name = p.display_name || 'Unknown'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#0f172a'
    ctx.font = '600 12px "Inter", system-ui, sans-serif'
    const maxW = x + nameColW - curX - 2
    let displayName = name
    while (ctx.measureText(displayName).width > maxW && displayName.length > 3) displayName = displayName.slice(0, -1)
    if (displayName !== name) displayName += '.'
    ctx.fillText(displayName, curX, rMidY)

    // Stats
    const statFS = 11
    ctx.font = `600 ${statFS}px "Inter", system-ui, sans-serif`
    ctx.fillStyle = '#0f172a'
    if (type === 'hitter') {
      const avg = fmtAvg(p.avg)
      const stats = [
        p.at_bats || 0, p.hits || 0, p.home_runs || 0, p.rbi || 0,
        p.xbh || 0, p.stolen_bases || 0, p.bb_hbp || 0, avg,
      ]
      stats.forEach((val, j) => {
        ctx.textAlign = 'center'
        if (j === 2 && val > 0) {
          ctx.fillStyle = '#dc2626'
          ctx.font = `700 ${statFS}px "Inter", system-ui, sans-serif`
        } else {
          ctx.fillStyle = '#0f172a'
          ctx.font = `600 ${statFS}px "Inter", system-ui, sans-serif`
        }
        ctx.fillText(String(val), x + nameColW + statColW * j + statColW / 2, rMidY)
      })
    } else {
      const ip = fmtIP(p.innings_pitched)
      const dec = p.decision_summary || '-'
      const fip = p.fip != null ? p.fip.toFixed(2) : '-'
      const stats = [
        ip, p.strikeouts || 0, p.hits_allowed != null ? p.hits_allowed : '-',
        p.earned_runs || 0, p.bb_hbp || 0, fip, dec,
      ]
      stats.forEach((val, j) => {
        ctx.textAlign = 'center'
        if (j === 6) {
          const hasW = String(val).includes('W')
          const hasL = String(val).includes('L')
          ctx.fillStyle = hasW ? '#16a34a' : hasL ? '#dc2626' : '#64748b'
          ctx.font = `700 ${statFS}px "Inter", system-ui, sans-serif`
        } else {
          ctx.fillStyle = '#0f172a'
          ctx.font = `600 ${statFS}px "Inter", system-ui, sans-serif`
        }
        ctx.fillText(String(val), x + nameColW + statColW * j + statColW / 2, rMidY)
      })
    }
  }

  return totalH
}

// ────────────────────────────────────────────
// ── MAIN RENDERER (1080x1080) ──
// ────────────────────────────────────────────
async function renderSeriesGraphic(canvas, series) {
  const W = 1080, H = 1080
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  const pad = 24
  const centerX = W / 2

  // ── Background (dark green-tinted) ──
  ctx.fillStyle = '#0D1B0F'
  ctx.fillRect(0, 0, W, H)

  // ── Top header bar (black with green accent, matching Daily Recap) ──
  const headerH = 72
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, W, headerH)

  // Green accent line at bottom of header
  ctx.fillStyle = '#2E7D32'
  ctx.fillRect(0, headerH - 3, W, 3)

  // NW logo on left
  const hLogoPad = 16
  const hLogoSize = 44
  try {
    const nwImg = await loadImage('/images/nw-logo-white.png')
    const a = nwImg.naturalWidth / nwImg.naturalHeight
    let dw = hLogoSize, dh = hLogoSize
    if (a >= 1) dh = hLogoSize / a; else dw = hLogoSize * a
    ctx.drawImage(nwImg, hLogoPad, (headerH - 3 - dh) / 2, dw, dh)
  } catch { /* skip */ }

  // PNWCBR logo on right
  try {
    const cbrImg = await loadImage('/images/cbr-logo.jpg')
    const a = cbrImg.naturalWidth / cbrImg.naturalHeight
    let dw = hLogoSize, dh = hLogoSize
    if (a >= 1) dh = hLogoSize / a; else dw = hLogoSize * a
    ctx.drawImage(cbrImg, W - hLogoPad - dw, (headerH - 3 - dh) / 2, dw, dh)
  } catch { /* skip */ }

  // Title centered
  ctx.fillStyle = '#ffffff'
  ctx.font = '800 24px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('SERIES RECAP', centerX, headerH / 2 - 10)

  // Date range below title
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.font = '500 12px "Inter", system-ui, sans-serif'
  ctx.fillText(series.date_range || '', centerX, headerH / 2 + 10)

  let curY = headerH + 3

  // ── Team matchup section ──
  const teamA = series.team_a
  const teamB = series.team_b
  const matchupH = 125
  const matchBg = curY

  // Light background for matchup
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, matchBg, W, matchupH)
  ctx.fillStyle = '#e2e8f0'
  ctx.fillRect(0, matchBg + matchupH - 1, W, 1)

  const logoSz = 64
  const logoY = matchBg + 20
  const logoAX = W * 0.20
  const logoBX = W * 0.80

  // Draw team logos
  for (const [team, lx] of [[teamA, logoAX], [teamB, logoBX]]) {
    try {
      const img = await loadImage(team.logo_url)
      const a = img.naturalWidth / img.naturalHeight
      let dw = logoSz, dh = logoSz
      if (a >= 1) dh = logoSz / a; else dw = logoSz * a
      ctx.drawImage(img, lx - dw / 2, logoY + (logoSz - dh) / 2, dw, dh)
    } catch { /* skip */ }
  }

  // Team names + records
  const nameY = logoY + logoSz + 14
  for (const [team, tx] of [[teamA, logoAX], [teamB, logoBX]]) {
    ctx.fillStyle = '#0f172a'
    ctx.font = '800 20px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(cleanTeamName(team.short_name), tx, nameY)

    // Record + conf record
    let recordStr = ''
    if (team.record) recordStr = team.record
    if (team.conf_record) recordStr += ` (${team.conf_record})`
    if (recordStr) {
      ctx.fillStyle = '#64748b'
      ctx.font = '500 11px "Inter", system-ui, sans-serif'
      ctx.fillText(recordStr, tx, nameY + 16)
    }

    // National rank badge
    if (team.national_rank) {
      const badgeX = tx + 60
      const badgeY = logoY + 4
      ctx.fillStyle = '#2E7D32'
      roundRect(ctx, badgeX, badgeY, 36, 18, 4)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = '700 10px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`#${team.national_rank}`, badgeX + 18, badgeY + 9)
    }
  }

  // Series result in center
  const aWins = teamA.series_wins || 0
  const bWins = teamB.series_wins || 0
  let resultLabel = ''
  if (aWins > bWins) resultLabel = `${cleanTeamName(teamA.short_name)} wins the series`
  else if (bWins > aWins) resultLabel = `${cleanTeamName(teamB.short_name)} wins the series`
  else resultLabel = 'Series Split'

  ctx.fillStyle = '#1B5E20'
  ctx.font = '700 14px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(resultLabel, centerX, logoY + logoSz / 2 - 10)

  // Big series score
  ctx.fillStyle = '#4CAF50'
  ctx.font = '800 36px "Inter", system-ui, sans-serif'
  ctx.fillText(`${aWins}  -  ${bWins}`, centerX, logoY + logoSz / 2 + 20)

  curY = matchBg + matchupH

  // ── Scorebugs (2x2 grid) ──
  const bugSectionY = curY + 6
  ctx.fillStyle = '#64748b'
  ctx.font = '700 10px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('GAME RESULTS', pad, bugSectionY + 6)

  const bugGridY = bugSectionY + 16
  const numGames = series.scorebugs.length
  const cols = numGames <= 3 ? numGames : 2
  const rows = Math.ceil(numGames / cols)
  const gap = 10
  const bugW = (W - pad * 2 - gap * (cols - 1)) / cols
  const bugH = 105

  for (let i = 0; i < numGames; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const bx = pad + col * (bugW + gap)
    const by = bugGridY + row * (bugH + gap)
    await drawScorebug(ctx, series.scorebugs[i], bx, by, bugW, bugH)
  }

  curY = bugGridY + rows * (bugH + gap) + 2

  // ── Stat comparison section (SIDE BY SIDE: batting left, pitching right) ──
  const statSectionY = curY
  const halfCardW = (W - pad * 2 - 10) / 2
  const rowSpacing = 20

  const bA = teamA.series_batting || {}
  const bB = teamB.series_batting || {}
  const pA = teamA.series_pitching || {}
  const pB = teamB.series_pitching || {}

  const battingStats = [
    { label: 'AVG', a: fmtAvg(bA.avg), b: fmtAvg(bB.avg), hl: 'higher' },
    { label: 'OBP', a: fmtAvg(bA.obp), b: fmtAvg(bB.obp), hl: 'higher' },
    { label: 'SLG', a: fmtAvg(bA.slg), b: fmtAvg(bB.slg), hl: 'higher' },
    { label: 'OPS', a: fmtAvg(bA.ops), b: fmtAvg(bB.ops), hl: 'higher' },
    { label: 'wOBA', a: fmtAvg(bA.woba), b: fmtAvg(bB.woba), hl: 'higher' },
    { label: 'R', a: String(bA.r || 0), b: String(bB.r || 0), hl: 'higher' },
    { label: 'H', a: String(bA.h || 0), b: String(bB.h || 0), hl: 'higher' },
    { label: 'HR', a: String(bA.hr || 0), b: String(bB.hr || 0), hl: 'higher' },
    { label: 'K%', a: fmtPct(bA.k_rate), b: fmtPct(bB.k_rate), hl: 'lower' },
    { label: 'BB%', a: fmtPct(bA.bb_rate), b: fmtPct(bB.bb_rate), hl: 'higher' },
  ]

  const pitchingStats = [
    { label: 'ERA', a: (pA.era || 0).toFixed(2), b: (pB.era || 0).toFixed(2), hl: 'lower' },
    { label: 'FIP', a: (pA.fip || 0).toFixed(2), b: (pB.fip || 0).toFixed(2), hl: 'lower' },
    { label: 'WHIP', a: (pA.whip || 0).toFixed(2), b: (pB.whip || 0).toFixed(2), hl: 'lower' },
    { label: 'K%', a: fmtPct(pA.k_rate), b: fmtPct(pB.k_rate), hl: 'higher' },
    { label: 'BB%', a: fmtPct(pA.bb_rate), b: fmtPct(pB.bb_rate), hl: 'lower' },
    { label: 'H/9', a: (pA.h_per_9 || 0).toFixed(1), b: (pB.h_per_9 || 0).toFixed(1), hl: 'lower' },
    { label: 'HR/9', a: (pA.hr_per_9 || 0).toFixed(1), b: (pB.hr_per_9 || 0).toFixed(1), hl: 'lower' },
    { label: 'XBH', a: String(pA.xbh_allowed || 0), b: String(pB.xbh_allowed || 0), hl: 'lower' },
    { label: 'K', a: String(pA.k || 0), b: String(pB.k || 0), hl: 'higher' },
    { label: 'ER', a: String(pA.er || 0), b: String(pB.er || 0), hl: 'lower' },
  ]

  const maxStatRows = Math.max(battingStats.length, pitchingStats.length)
  const cardH = 44 + maxStatRows * rowSpacing + 6

  // Helper to draw one stat card
  function drawStatCard(cardX, cardW, title, stats, teamAName, teamBName) {
    const cardCenterX = cardX + cardW / 2
    roundRect(ctx, cardX, statSectionY, cardW, cardH, 8)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.fillStyle = '#2E7D32'
    ctx.font = '700 11px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(title, cardX + 10, statSectionY + 13)

    // Team name labels
    const labelsY = statSectionY + 30
    ctx.fillStyle = '#0f172a'
    ctx.font = '700 12px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(teamAName, cardCenterX - 36, labelsY)
    ctx.textAlign = 'left'
    ctx.fillText(teamBName, cardCenterX + 36, labelsY)

    let ry = labelsY + 20
    stats.forEach((stat) => {
      drawStatCompareRow(ctx, stat.label, stat.a, stat.b, cardCenterX, ry, 36, { highlight: stat.hl, fontSize: 14 })
      ry += rowSpacing
    })
  }

  const teamAClean = cleanTeamName(teamA.short_name)
  const teamBClean = cleanTeamName(teamB.short_name)

  drawStatCard(pad, halfCardW, 'SERIES BATTING', battingStats, teamAClean, teamBClean)
  drawStatCard(pad + halfCardW + 10, halfCardW, 'SERIES PITCHING', pitchingStats, teamAClean, teamBClean)

  curY = statSectionY + cardH + 8

  // ── Top Performers (split left/right by team) ──
  const perfSectionY = curY
  const halfW = (W - pad * 2 - 12) / 2

  // Team A performers on left
  let leftH = 0
  if (teamA.top_hitters?.length > 0) {
    leftH += await drawTeamPerformers(ctx, `${teamAClean} TOP HITTERS`, teamA.top_hitters, pad, perfSectionY, halfW, 'hitter')
  }
  if (teamA.top_pitchers?.length > 0) {
    leftH += await drawTeamPerformers(ctx, `${teamAClean} TOP PITCHERS`, teamA.top_pitchers, pad, perfSectionY + leftH + 4, halfW, 'pitcher')
  }

  // Team B performers on right
  let rightH = 0
  if (teamB.top_hitters?.length > 0) {
    rightH += await drawTeamPerformers(ctx, `${teamBClean} TOP HITTERS`, teamB.top_hitters, pad + halfW + 12, perfSectionY, halfW, 'hitter')
  }
  if (teamB.top_pitchers?.length > 0) {
    rightH += await drawTeamPerformers(ctx, `${teamBClean} TOP PITCHERS`, teamB.top_pitchers, pad + halfW + 12, perfSectionY + rightH + 4, halfW, 'pitcher')
  }

  curY = perfSectionY + Math.max(leftH, rightH) + 8

  // ── Venue / Park Factors bar ──
  if (series.venue) {
    const v = series.venue
    const venueY = Math.max(curY, H - 48)
    ctx.fillStyle = '#f1f5f9'
    ctx.fillRect(0, venueY, W, 22)
    ctx.fillStyle = '#64748b'
    ctx.font = '500 9px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    const parts = []
    if (v.stadium || v.name) parts.push(v.stadium || v.name)
    if (v.city && v.state) parts.push(`${v.city}, ${v.state}`)
    if (v.elevation_ft) parts.push(`${v.elevation_ft}ft elev.`)
    if (v.park_factor_pct != null) parts.push(`Park Factor: ${v.park_factor_pct > 0 ? '+' : ''}${v.park_factor_pct}%`)
    if (v.surface) parts.push(v.surface)
    if (v.dimensions) {
      const d = v.dimensions
      if (d.lf && d.cf && d.rf) parts.push(`${d.lf}-${d.cf}-${d.rf}`)
    }
    ctx.fillText(parts.join('  |  '), centerX, venueY + 11)
  }

  // ── Footer (green bar matching Daily Recap) ──
  const footerH = 40
  ctx.fillStyle = '#1B5E20'
  ctx.fillRect(0, H - footerH, W, footerH)
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.font = '600 12px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('NWBASEBALLSTATS.COM x PNWCBR', centerX, H - footerH / 2)
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

  useEffect(() => {
    async function fetchWeeks() {
      try {
        const res = await fetch(`${API_BASE}/games/series-weeks?season=2026`)
        if (!res.ok) throw new Error(`API error: ${res.status}`)
        const json = await res.json()
        setWeeks(json.weeks || [])
        const current = (json.weeks || []).find(w => w.is_current)
        if (current) setSelectedWeek(current.week_start)
        else if (json.weeks?.length) setSelectedWeek(json.weeks[json.weeks.length - 1].week_start)
      } catch (err) {
        setError(err.message)
      }
    }
    fetchWeeks()
  }, [])

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

  const filteredSeries = seriesData?.series?.filter(s =>
    divFilter === 'ALL' || (s.division || '').toUpperCase() === divFilter
  ) || []

  const currentSeries = filteredSeries[selectedSeriesIdx] || null

  const generate = useCallback(async () => {
    if (!currentSeries || !canvasRef.current) return
    await renderSeriesGraphic(canvasRef.current, currentSeries)
    setRendered(true)
  }, [currentSeries])

  useEffect(() => {
    if (currentSeries) generate()
    else setRendered(false)
  }, [currentSeries, generate])

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

      {/* Series selector */}
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
