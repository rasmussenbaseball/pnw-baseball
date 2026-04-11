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

function fmtPct(val) {
  if (val == null) return '-'
  const n = parseFloat(val)
  return n >= 1 ? n.toFixed(1) + '%' : (n * 100).toFixed(1) + '%'
}
function fmtAvg(val) {
  if (val == null) return '-'
  return parseFloat(val).toFixed(3).replace(/^0/, '')
}
function fmtDec(val, d = 2) {
  if (val == null) return '-'
  return parseFloat(val).toFixed(d)
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

// ── TEAM COLORS (school colors for PNW teams) ──
const TEAM_COLORS = {
  'Oregon':       { primary: '#154733', secondary: '#FEE123' },
  'Oregon St':    { primary: '#DC4405', secondary: '#000000' },
  'Washington':   { primary: '#4B2E83', secondary: '#B7A57A' },
  'Wash St':      { primary: '#981E32', secondary: '#5E6A71' },
  'Gonzaga':      { primary: '#002967', secondary: '#C8102E' },
  'Portland':     { primary: '#3E1F6B', secondary: '#FFFFFF' },
  'Seattle U':    { primary: '#AA0000', secondary: '#000000' },
  'CWU':          { primary: '#B1040E', secondary: '#000000' },
  'WWU':          { primary: '#003F87', secondary: '#FFFFFF' },
  'SPU':          { primary: '#4E2683', secondary: '#FFFFFF' },
  'SFU':          { primary: '#CC0633', secondary: '#003B6F' },
  'MSU Billings': { primary: '#FFB81C', secondary: '#006341' },
  'MSUB':         { primary: '#FFB81C', secondary: '#006341' },
  'SMU':          { primary: '#004990', secondary: '#FFFFFF' },
  'NNU':          { primary: '#F7941D', secondary: '#000000' },
  'WOU':          { primary: '#E41C38', secondary: '#3D3935' },
  'Concordia':    { primary: '#002855', secondary: '#FFFFFF' },
  'Corban':       { primary: '#003262', secondary: '#B8922F' },
  'EOU':          { primary: '#003DA5', secondary: '#FFC72C' },
  'L&C':          { primary: '#B5A36A', secondary: '#000000' },
  'Lewis-Clark':  { primary: '#003DA5', secondary: '#CF102D' },
  'Linfield':     { primary: '#6E2585', secondary: '#000000' },
  'George Fox':   { primary: '#00205B', secondary: '#CFB87C' },
  'Pacific':      { primary: '#000000', secondary: '#C8102E' },
  'PLU':          { primary: '#000000', secondary: '#C89A2C' },
  'Puget Sound':  { primary: '#8B2332', secondary: '#000000' },
  'Whitman':      { primary: '#1C5BA2', secondary: '#D2492A' },
  'Whitworth':    { primary: '#A6192E', secondary: '#002855' },
  'Willamette':   { primary: '#862633', secondary: '#C99700' },
  'Bushnell':     { primary: '#002D72', secondary: '#C8102E' },
  // NWAC
  'Edmonds':      { primary: '#003DA5', secondary: '#C8102E' },
  'Everett':      { primary: '#00703C', secondary: '#FFFFFF' },
  'Skagit Valley':{ primary: '#003DA5', secondary: '#C8102E' },
  'Shoreline':    { primary: '#003DA5', secondary: '#C8102E' },
  'Bellevue':     { primary: '#003DA5', secondary: '#B8860B' },
  'Olympic':      { primary: '#002855', secondary: '#FFFFFF' },
  'Pierce':       { primary: '#002D72', secondary: '#FFB81C' },
  'Tacoma':       { primary: '#00205B', secondary: '#C8102E' },
  'Centralia':    { primary: '#006747', secondary: '#FFFFFF' },
  'Grays Harbor': { primary: '#002855', secondary: '#FFB81C' },
  'L Columbia':   { primary: '#C8102E', secondary: '#000000' },
  'Clark':        { primary: '#003DA5', secondary: '#FFFFFF' },
  'Chemeketa':    { primary: '#003DA5', secondary: '#C8102E' },
  'SW Oregon':    { primary: '#003DA5', secondary: '#C8102E' },
  'Clackamas':    { primary: '#006747', secondary: '#FFFFFF' },
  'Lane':         { primary: '#003DA5', secondary: '#C8102E' },
  'Mt Hood':      { primary: '#003DA5', secondary: '#FFB81C' },
  'Linn-Benton':  { primary: '#003DA5', secondary: '#FFFFFF' },
  'Treasure Val': { primary: '#003DA5', secondary: '#C8102E' },
  'Blue Mountain':{ primary: '#003DA5', secondary: '#FFFFFF' },
  'Columbia Basin':{ primary: '#B5121B', secondary: '#000000' },
  'Walla Walla':  { primary: '#006747', secondary: '#FFFFFF' },
  'Wenatchee Val':{ primary: '#003DA5', secondary: '#C8102E' },
  'Yakima Valley':{ primary: '#003DA5', secondary: '#C8102E' },
  'Big Bend':     { primary: '#003DA5', secondary: '#000000' },
  'Spokane':      { primary: '#C8102E', secondary: '#FFFFFF' },
  'Spokane Falls':{ primary: '#000000', secondary: '#C8102E' },
}
const DEFAULT_COLORS = { primary: '#00687a', secondary: '#004d5a' }

function getTeamColors(shortName) {
  return TEAM_COLORS[shortName] || DEFAULT_COLORS
}

// ── BRAND COLORS ──
const TEAL = '#00687a'
const TEAL_DARK = '#004d5a'
const DARK = '#1e293b'
const MED = '#64748b'
const LIGHT_TEXT = '#94a3b8'
const BG = '#0f172a'        // dark background
const CARD_BG = '#1e293b'   // dark card
const CARD_LIGHT = '#334155' // lighter card accent
const WHITE = '#ffffff'
const GREEN = '#10b981'

// ── Draw the full 1080x1080 graphic ──
async function drawGraphic(canvas, data, prediction) {
  const S = 1080
  canvas.width = S
  canvas.height = S
  const ctx = canvas.getContext('2d')

  const teams = data.matchup.teams
  if (teams.length < 2) return
  const away = teams.find(t => t.side === 'away') || teams[0]
  const home = teams.find(t => t.side === 'home') || teams[1]
  const awayC = getTeamColors(away.short_name)
  const homeC = getTeamColors(home.short_name)

  const pad = 24
  const innerW = S - pad * 2
  const halfW = innerW / 2

  // ── DARK BACKGROUND ──
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, S, S)

  // ── TEAM COLOR BARS AT TOP ──
  // Away color bar (left half)
  ctx.fillStyle = awayC.primary
  ctx.fillRect(0, 0, S / 2, 6)
  // Home color bar (right half)
  ctx.fillStyle = homeC.primary
  ctx.fillRect(S / 2, 0, S / 2, 6)

  let y = 14

  // ── HEADER ──
  ctx.fillStyle = TEAL
  roundRect(ctx, pad, y, innerW, 42, 8)
  ctx.fill()
  ctx.fillStyle = WHITE
  ctx.font = 'bold 20px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('KEY MATCHUP', S / 2, y + 22)
  ctx.font = '11px system-ui, -apple-system, sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.fillText(fmtDisplayDate(data.date), S / 2, y + 36)
  y += 50

  // ── TEAM HEADER SECTION ──
  const teamH = 130
  ctx.fillStyle = CARD_BG
  roundRect(ctx, pad, y, innerW, teamH, 10)
  ctx.fill()

  // Team color accent strips on sides
  ctx.fillStyle = awayC.primary
  roundRect(ctx, pad, y, 5, teamH, 0)
  ctx.fill()
  ctx.fillStyle = homeC.primary
  ctx.fillRect(S - pad - 5, y, 5, teamH)

  // VS center
  ctx.fillStyle = CARD_LIGHT
  const vsR = 22
  ctx.beginPath()
  ctx.arc(S / 2, y + teamH / 2, vsR, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = WHITE
  ctx.font = 'bold 14px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('VS', S / 2, y + teamH / 2 + 5)

  // Conference badge
  if (data.matchup.is_conference_game) {
    ctx.fillStyle = TEAL
    roundRect(ctx, S / 2 - 52, y + teamH / 2 + 26, 104, 18, 9)
    ctx.fill()
    ctx.fillStyle = WHITE
    ctx.font = 'bold 9px system-ui, -apple-system, sans-serif'
    ctx.fillText('CONFERENCE GAME', S / 2, y + teamH / 2 + 38)
  }

  // Draw each team
  for (const [team, xCenter, colors] of [[away, pad + halfW / 2 + 4, awayC], [home, S - pad - halfW / 2 - 4, homeC]]) {
    const rec = team.record || {}
    const recStr = `${rec.wins || 0}-${rec.losses || 0}`
    const confStr = (rec.conference_wins != null && rec.conference_losses != null)
      ? `${rec.conference_wins}-${rec.conference_losses} conf`
      : ''

    // Logo
    try {
      const logo = await loadImage(team.logo_url)
      ctx.drawImage(logo, xCenter - 28, y + 8, 56, 56)
    } catch {}

    // Name
    ctx.fillStyle = WHITE
    ctx.font = 'bold 22px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(team.short_name || team.name, xCenter, y + 82)

    // Record
    ctx.fillStyle = LIGHT_TEXT
    ctx.font = '13px system-ui, -apple-system, sans-serif'
    ctx.fillText(recStr + (confStr ? '  (' + confStr + ')' : ''), xCenter, y + 98)

    // Division + conference
    ctx.font = '11px system-ui, -apple-system, sans-serif'
    ctx.fillText(`${team.division_level || ''} • ${team.conference_abbrev || ''}`, xCenter, y + 113)

    // National ranking badge
    const rank = team.national_rank?.composite_rank
    if (rank) {
      ctx.fillStyle = colors.primary
      roundRect(ctx, xCenter - 18, y + 118, 36, 16, 8)
      ctx.fill()
      ctx.fillStyle = WHITE
      ctx.font = 'bold 10px system-ui, -apple-system, sans-serif'
      ctx.fillText(`#${rank}`, xCenter, y + 129)
    }
  }
  y += teamH + 8

  // ── WIN PROBABILITY BAR ──
  if (prediction?.matchups?.[0]) {
    const m = prediction.matchups[0]
    const predH = 72
    ctx.fillStyle = CARD_BG
    roundRect(ctx, pad, y, innerW, predH, 10)
    ctx.fill()

    // Get win probs for each side
    let awayProb, homeProb
    if (away.id === m.team_a) {
      awayProb = m.win_prob_a; homeProb = m.win_prob_b
    } else {
      awayProb = m.win_prob_b; homeProb = m.win_prob_a
    }

    // Label
    ctx.fillStyle = LIGHT_TEXT
    ctx.font = 'bold 10px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('PROJECTED WIN %', S / 2, y + 16)

    // Win probability bar
    const barX = pad + 70
    const barW = innerW - 140
    const barY = y + 24
    const barH = 20
    const awayW = barW * awayProb
    const homeW = barW * homeProb

    // Away bar (left)
    ctx.fillStyle = awayC.primary
    roundRect(ctx, barX, barY, Math.max(awayW, 8), barH, 4)
    ctx.fill()
    // Home bar (right)
    ctx.fillStyle = homeC.primary
    roundRect(ctx, barX + barW - Math.max(homeW, 8), barY, Math.max(homeW, 8), barH, 4)
    ctx.fill()

    // Percentages
    ctx.fillStyle = WHITE
    ctx.font = 'bold 18px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(`${(awayProb * 100).toFixed(0)}%`, pad + 14, barY + 16)
    ctx.textAlign = 'right'
    ctx.fillText(`${(homeProb * 100).toFixed(0)}%`, S - pad - 14, barY + 16)

    // Spread + O/U + Proj Runs below bar
    const infoY = barY + barH + 16
    ctx.font = '11px system-ui, -apple-system, sans-serif'
    ctx.fillStyle = LIGHT_TEXT
    ctx.textAlign = 'center'

    // Spread
    const absSpread = Math.abs(m.spread).toFixed(1)
    const favName = m.favored === away.id ? away.short_name : home.short_name
    ctx.fillText(`SPREAD`, S / 2 - 120, infoY - 4)
    ctx.fillStyle = WHITE
    ctx.font = 'bold 12px system-ui, -apple-system, sans-serif'
    ctx.fillText(`${favName} -${absSpread}`, S / 2 - 120, infoY + 10)

    // O/U
    ctx.fillStyle = LIGHT_TEXT
    ctx.font = '11px system-ui, -apple-system, sans-serif'
    ctx.fillText('OVER/UNDER', S / 2, infoY - 4)
    ctx.fillStyle = WHITE
    ctx.font = 'bold 12px system-ui, -apple-system, sans-serif'
    ctx.fillText(`${m.proj_total.toFixed(1)} runs`, S / 2, infoY + 10)

    // Proj runs
    ctx.fillStyle = LIGHT_TEXT
    ctx.font = '11px system-ui, -apple-system, sans-serif'
    ctx.fillText('PROJ. RUNS', S / 2 + 120, infoY - 4)
    ctx.fillStyle = WHITE
    ctx.font = 'bold 12px system-ui, -apple-system, sans-serif'
    const projA = away.id === m.team_a ? m.proj_runs_a : m.proj_runs_b
    const projB = home.id === m.team_a ? m.proj_runs_a : m.proj_runs_b
    ctx.fillText(`${projA.toFixed(1)} - ${projB.toFixed(1)}`, S / 2 + 120, infoY + 10)

    y += predH + 8
  }

  // ── POWER RATINGS ──
  if (prediction?.teams?.length >= 2) {
    const pwrH = 40
    ctx.fillStyle = CARD_BG
    roundRect(ctx, pad, y, innerW, pwrH, 8)
    ctx.fill()

    const awayTeamPred = prediction.teams.find(t => t.team_id === away.id) || prediction.teams[0]
    const homeTeamPred = prediction.teams.find(t => t.team_id === home.id) || prediction.teams[1]

    // Away power rating
    ctx.fillStyle = awayC.primary
    ctx.font = 'bold 18px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(awayTeamPred.power_rating?.toFixed(1) || '-', pad + 16, y + 26)
    ctx.fillStyle = LIGHT_TEXT
    ctx.font = '9px system-ui, -apple-system, sans-serif'
    ctx.fillText('PWR RATING', pad + 16, y + 14)

    // Pyth Win%
    ctx.textAlign = 'center'
    ctx.fillStyle = LIGHT_TEXT
    ctx.font = '9px system-ui, -apple-system, sans-serif'
    ctx.fillText('PYTH WIN%', S / 2 - 90, y + 14)
    ctx.fillStyle = WHITE
    ctx.font = 'bold 12px system-ui, -apple-system, sans-serif'
    ctx.fillText(`${((awayTeamPred.components?.pyth_win_pct || 0) * 100).toFixed(0)}%`, S / 2 - 90, y + 28)

    // WAR/G
    ctx.fillStyle = LIGHT_TEXT
    ctx.font = '9px system-ui, -apple-system, sans-serif'
    ctx.fillText('WAR/G', S / 2, y + 14)
    ctx.fillStyle = WHITE
    ctx.font = 'bold 12px system-ui, -apple-system, sans-serif'
    ctx.fillText(`${(awayTeamPred.components?.war_per_game || 0).toFixed(2)}  /  ${(homeTeamPred.components?.war_per_game || 0).toFixed(2)}`, S / 2, y + 28)

    // Pyth Win% home
    ctx.fillStyle = LIGHT_TEXT
    ctx.font = '9px system-ui, -apple-system, sans-serif'
    ctx.fillText('PYTH WIN%', S / 2 + 90, y + 14)
    ctx.fillStyle = WHITE
    ctx.font = 'bold 12px system-ui, -apple-system, sans-serif'
    ctx.fillText(`${((homeTeamPred.components?.pyth_win_pct || 0) * 100).toFixed(0)}%`, S / 2 + 90, y + 28)

    // Home power rating
    ctx.fillStyle = homeC.primary
    ctx.font = 'bold 18px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(homeTeamPred.power_rating?.toFixed(1) || '-', S - pad - 16, y + 26)
    ctx.fillStyle = LIGHT_TEXT
    ctx.font = '9px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText('PWR RATING', S - pad - 16, y + 14)

    y += pwrH + 6
  }

  // ── TEAM STATS COMPARISON (two columns: Offense + Pitching) ──
  const statBlockH = 186
  ctx.fillStyle = CARD_BG
  roundRect(ctx, pad, y, innerW, statBlockH, 10)
  ctx.fill()

  // Offense header
  ctx.fillStyle = TEAL
  ctx.font = 'bold 11px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('OFFENSE', pad + halfW / 2, y + 16)
  ctx.fillText('PITCHING', S - pad - halfW / 2, y + 16)

  // Divider
  ctx.strokeStyle = CARD_LIGHT
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(S / 2, y + 4)
  ctx.lineTo(S / 2, y + statBlockH - 4)
  ctx.stroke()

  const offenseStats = buildOffenseStats(away, home)
  const pitchingStats = buildPitchingStats(away, home)

  drawStatBlock(ctx, offenseStats, pad + 8, S / 2 - 8, y + 26, away, home)
  drawStatBlock(ctx, pitchingStats, S / 2 + 8, S - pad - 8, y + 26, away, home)

  y += statBlockH + 6

  // ── TOP HITTERS ──
  y = drawPlayerSection(ctx, 'TOP HITTERS  (50+ PA)', away, home, 'hitters', pad, y, innerW, S, awayC, homeC)
  y += 6

  // ── TOP PITCHERS ──
  y = drawPlayerSection(ctx, 'TOP PITCHERS  (15+ IP)', away, home, 'pitchers', pad, y, innerW, S, awayC, homeC)

  // ── FOOTER ──
  const footerY = S - 28
  ctx.fillStyle = TEAL
  roundRect(ctx, pad, footerY, innerW, 20, 6)
  ctx.fill()
  ctx.fillStyle = WHITE
  ctx.font = 'bold 9px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('PNWBASEBALLSTATS.COM', S / 2, footerY + 14)
}

function buildOffenseStats(away, home) {
  const ab = away.batting || {}
  const hb = home.batting || {}
  const ar = away.record || {}
  const hr = home.record || {}
  const aGames = (ar.wins || 0) + (ar.losses || 0) || 1
  const hGames = (hr.wins || 0) + (hr.losses || 0) || 1
  const aRPG = ((ab.total_runs || 0) / aGames).toFixed(1)
  const hRPG = ((hb.total_runs || 0) / hGames).toFixed(1)
  return [
    { label: 'R/G', away: aRPG, home: hRPG, higher: true },
    { label: 'AVG', away: fmtAvg(ab.team_avg), home: fmtAvg(hb.team_avg), higher: true },
    { label: 'OBP', away: fmtAvg(ab.team_obp), home: fmtAvg(hb.team_obp), higher: true },
    { label: 'SLG', away: fmtAvg(ab.team_slg), home: fmtAvg(hb.team_slg), higher: true },
    { label: 'wRC+', away: String(Math.round(ab.avg_wrc_plus || 0)), home: String(Math.round(hb.avg_wrc_plus || 0)), higher: true },
    { label: 'HR', away: String(ab.total_hr || 0), home: String(hb.total_hr || 0), higher: true },
    { label: 'SB', away: String(ab.total_sb || 0), home: String(hb.total_sb || 0), higher: true },
    { label: 'oWAR', away: fmtDec(ab.total_owar, 1), home: fmtDec(hb.total_owar, 1), higher: true },
  ]
}

function buildPitchingStats(away, home) {
  const ap = away.pitching || {}
  const hp = home.pitching || {}
  const ar = away.record || {}
  const hr = home.record || {}
  const aGames = (ar.wins || 0) + (ar.losses || 0) || 1
  const hGames = (hr.wins || 0) + (hr.losses || 0) || 1
  const aRAPG = ((ap.total_runs_allowed || 0) / aGames).toFixed(1)
  const hRAPG = ((hp.total_runs_allowed || 0) / hGames).toFixed(1)
  return [
    { label: 'RA/G', away: aRAPG, home: hRAPG, higher: false },
    { label: 'ERA', away: fmtDec(ap.team_era), home: fmtDec(hp.team_era), higher: false },
    { label: 'FIP', away: fmtDec(ap.avg_fip), home: fmtDec(hp.avg_fip), higher: false },
    { label: 'WHIP', away: fmtDec(ap.team_whip), home: fmtDec(hp.team_whip), higher: false },
    { label: 'K%', away: fmtPct(ap.avg_k_pct), home: fmtPct(hp.avg_k_pct), higher: true },
    { label: 'BB%', away: fmtPct(ap.avg_bb_pct), home: fmtPct(hp.avg_bb_pct), higher: false },
    { label: 'Opp AVG', away: fmtAvg(ap.opp_avg), home: fmtAvg(hp.opp_avg), higher: false },
    { label: 'pWAR', away: fmtDec(ap.total_pwar, 1), home: fmtDec(hp.total_pwar, 1), higher: true },
  ]
}

function drawStatBlock(ctx, stats, xLeft, xRight, startY, away, home) {
  const rowH = 19
  const blockW = xRight - xLeft
  const midX = xLeft + blockW / 2

  // Column headers
  ctx.fillStyle = LIGHT_TEXT
  ctx.font = 'bold 9px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText(away.short_name, midX - 34, startY + 4)
  ctx.textAlign = 'left'
  ctx.fillText(home.short_name, midX + 34, startY + 4)

  for (let i = 0; i < stats.length; i++) {
    const row = stats[i]
    const ry = startY + 10 + i * rowH
    const a = parseFloat(row.away) || 0
    const h = parseFloat(row.home) || 0
    const aBetter = a !== h && (row.higher ? a > h : a < h)
    const hBetter = a !== h && (row.higher ? h > a : h < a)

    // Alternating row bg
    if (i % 2 === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.03)'
      ctx.fillRect(xLeft, ry, blockW, rowH)
    }

    // Away value
    ctx.font = aBetter ? 'bold 12px system-ui, -apple-system, sans-serif' : '12px system-ui, -apple-system, sans-serif'
    ctx.fillStyle = aBetter ? GREEN : WHITE
    ctx.textAlign = 'right'
    ctx.fillText(row.away, midX - 34, ry + 14)

    // Label
    ctx.font = 'bold 10px system-ui, -apple-system, sans-serif'
    ctx.fillStyle = LIGHT_TEXT
    ctx.textAlign = 'center'
    ctx.fillText(row.label, midX, ry + 14)

    // Home value
    ctx.font = hBetter ? 'bold 12px system-ui, -apple-system, sans-serif' : '12px system-ui, -apple-system, sans-serif'
    ctx.fillStyle = hBetter ? GREEN : WHITE
    ctx.textAlign = 'left'
    ctx.fillText(row.home, midX + 34, ry + 14)
  }
}

function drawPlayerSection(ctx, title, away, home, type, pad, startY, innerW, S, awayC, homeC) {
  const players = type === 'hitters'
    ? { away: away.top_hitters || [], home: home.top_hitters || [] }
    : { away: away.top_pitchers || [], home: home.top_pitchers || [] }

  const maxRows = 3
  const rowH = 34
  const headerH = 26
  const subH = 14
  const blockH = headerH + subH + maxRows * rowH + 6

  ctx.fillStyle = CARD_BG
  roundRect(ctx, pad, startY, innerW, blockH, 10)
  ctx.fill()

  // Team color accent on section header
  ctx.fillStyle = awayC.primary
  ctx.fillRect(pad, startY, 4, headerH)
  ctx.fillStyle = homeC.primary
  ctx.fillRect(S - pad - 4, startY, 4, headerH)

  // Title
  ctx.fillStyle = WHITE
  ctx.font = 'bold 11px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(title, S / 2, startY + 17)

  // Divider
  ctx.strokeStyle = CARD_LIGHT
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(S / 2, startY + headerH)
  ctx.lineTo(S / 2, startY + blockH - 4)
  ctx.stroke()

  let y = startY + headerH
  const leftStart = pad + 8
  const leftEnd = S / 2 - 8
  const rightStart = S / 2 + 8
  const rightEnd = S - pad - 8
  const sideW = leftEnd - leftStart

  // Sub headers
  ctx.fillStyle = LIGHT_TEXT
  ctx.font = 'bold 8px system-ui, -apple-system, sans-serif'

  if (type === 'hitters') {
    for (const [xs] of [[leftStart], [rightStart]]) {
      ctx.textAlign = 'left'
      ctx.fillText('PLAYER', xs + 2, y + 10)
      ctx.textAlign = 'right'
      ctx.fillText('AVG', xs + sideW * 0.48, y + 10)
      ctx.fillText('HR', xs + sideW * 0.60, y + 10)
      ctx.fillText('wRC+', xs + sideW * 0.78, y + 10)
      ctx.fillText('oWAR', xs + sideW - 2, y + 10)
    }
  } else {
    for (const [xs] of [[leftStart], [rightStart]]) {
      ctx.textAlign = 'left'
      ctx.fillText('PLAYER', xs + 2, y + 10)
      ctx.textAlign = 'right'
      ctx.fillText('ERA', xs + sideW * 0.48, y + 10)
      ctx.fillText('K', xs + sideW * 0.60, y + 10)
      ctx.fillText('FIP', xs + sideW * 0.78, y + 10)
      ctx.fillText('pWAR', xs + sideW - 2, y + 10)
    }
  }
  y += subH

  for (let i = 0; i < maxRows; i++) {
    const ry = y + i * rowH

    if (i % 2 === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.03)'
      ctx.fillRect(pad + 4, ry, innerW / 2 - 8, rowH)
      ctx.fillRect(S / 2 + 4, ry, innerW / 2 - 8, rowH)
    }

    const ap = players.away[i]
    if (ap) drawPlayerRow(ctx, ap, type, leftStart, sideW, ry, awayC)
    const hp = players.home[i]
    if (hp) drawPlayerRow(ctx, hp, type, rightStart, sideW, ry, homeC)
  }

  return startY + blockH
}

function drawPlayerRow(ctx, player, type, xStart, sideW, ry, teamC) {
  const name = `${player.first_name?.[0] || ''}. ${player.last_name || ''}`

  // Name
  ctx.fillStyle = WHITE
  ctx.font = '12px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(name, xStart + 2, ry + 15)

  // Position
  if (player.position) {
    ctx.fillStyle = LIGHT_TEXT
    ctx.font = '8px system-ui, -apple-system, sans-serif'
    ctx.fillText(player.position, xStart + 2, ry + 26)
  }

  ctx.textAlign = 'right'

  if (type === 'hitters') {
    ctx.fillStyle = WHITE
    ctx.font = '11px system-ui, -apple-system, sans-serif'
    ctx.fillText(fmtAvg(player.batting_avg), xStart + sideW * 0.48, ry + 20)
    ctx.fillText(String(player.home_runs || 0), xStart + sideW * 0.60, ry + 20)
    // wRC+ highlighted
    ctx.fillStyle = teamC.primary
    ctx.font = 'bold 12px system-ui, -apple-system, sans-serif'
    ctx.fillText(String(Math.round(player.wrc_plus || 0)), xStart + sideW * 0.78, ry + 20)
    ctx.fillStyle = WHITE
    ctx.font = '11px system-ui, -apple-system, sans-serif'
    ctx.fillText(fmtDec(player.offensive_war, 1), xStart + sideW - 2, ry + 20)
  } else {
    ctx.fillStyle = WHITE
    ctx.font = '11px system-ui, -apple-system, sans-serif'
    ctx.fillText(fmtDec(player.era), xStart + sideW * 0.48, ry + 20)
    ctx.fillText(String(player.strikeouts || 0), xStart + sideW * 0.60, ry + 20)
    // FIP highlighted
    ctx.fillStyle = teamC.primary
    ctx.font = 'bold 12px system-ui, -apple-system, sans-serif'
    ctx.fillText(fmtDec(player.fip), xStart + sideW * 0.78, ry + 20)
    ctx.fillStyle = WHITE
    ctx.font = '11px system-ui, -apple-system, sans-serif'
    ctx.fillText(fmtDec(player.pitching_war, 1), xStart + sideW - 2, ry + 20)
  }
}

// ── Main Component ──
export default function KeyMatchupGraphic() {
  const [date, setDate] = useState(todayStr())
  const [data, setData] = useState(null)
  const [prediction, setPrediction] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [selectedGameId, setSelectedGameId] = useState(null)
  const canvasRef = useRef(null)

  const fetchData = useCallback(async (d, gid) => {
    setLoading(true)
    setError(null)
    try {
      let url = `${API_BASE}/games/key-matchup?date=${d}&season=2026`
      if (gid) url += `&game_id=${gid}`
      const resp = await fetch(url)
      if (!resp.ok) throw new Error('Failed to fetch matchup data')
      const json = await resp.json()
      setData(json)
      if (json.matchup) {
        setSelectedGameId(json.matchup.game_id)
        const teamIds = json.matchup.teams.map(t => t.id).join(',')
        if (teamIds) {
          try {
            const predResp = await fetch(`${API_BASE}/teams/matchup?season=2026&team_ids=${teamIds}`)
            if (predResp.ok) setPrediction(await predResp.json())
          } catch {}
        }
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData(date, null) }, [date, fetchData])

  useEffect(() => {
    if (data?.matchup && canvasRef.current) {
      drawGraphic(canvasRef.current, data, prediction)
    }
  }, [data, prediction])

  const handleGameChange = (e) => {
    const gid = parseInt(e.target.value)
    setSelectedGameId(gid)
    fetchData(date, gid)
  }

  const handleDownload = () => {
    if (!canvasRef.current) return
    const link = document.createElement('a')
    link.download = `key-matchup-${date}.png`
    link.href = canvasRef.current.toDataURL('image/png')
    link.click()
  }

  const changeDate = (dir) => {
    const d = new Date(date + 'T12:00:00')
    d.setDate(d.getDate() + dir)
    setDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }

  return (
    <div className="min-h-screen bg-gray-50 py-6 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Key Matchup Graphic</h1>
          <p className="text-sm text-gray-500 mt-1">Generate a social media graphic for the top matchup of the day</p>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <button onClick={() => changeDate(-1)} className="px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 text-sm font-medium">&larr;</button>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className="px-3 py-1.5 rounded border border-gray-300 text-sm" />
              <button onClick={() => changeDate(1)} className="px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 text-sm font-medium">&rarr;</button>
            </div>
            {data?.games?.length > 0 && (
              <select value={selectedGameId || ''} onChange={handleGameChange} className="px-3 py-1.5 rounded border border-gray-300 text-sm flex-1 min-w-[200px]">
                {data.games.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.away_short} @ {g.home_short}{g.is_conference_game ? ' (Conf)' : ''}{g.home_division ? ` — ${g.home_division}` : ''}
                  </option>
                ))}
              </select>
            )}
            <button onClick={handleDownload} disabled={!data?.matchup} className="px-4 py-1.5 rounded text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#00687a' }}>
              Download PNG
            </button>
          </div>
        </div>

        {loading && <p className="text-center text-gray-500 py-12">Loading...</p>}
        {error && <p className="text-center text-red-500 py-12">{error}</p>}
        {!loading && data && !data.matchup && (
          <p className="text-center text-gray-500 py-12">No PNW games found for {shortDate(date)}</p>
        )}
        {data?.matchup && (
          <div className="flex justify-center">
            <canvas ref={canvasRef} className="rounded-lg shadow-lg" style={{ width: 540, height: 540 }} />
          </div>
        )}
      </div>
    </div>
  )
}
