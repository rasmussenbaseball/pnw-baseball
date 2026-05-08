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

// ── STANDARDIZED SIDE COLORS: left (away) = navy blue, right (home) = teal ──
const LEFT_C  = { p: '#1e3a5f', t: '#6ba3ff' }   // navy blue / light blue accent
const RIGHT_C = { p: '#00687a', t: '#4dd9c0' }    // teal / light teal accent

// ── DESIGN TOKENS ──
const BG = '#0f172a'
const CARD = '#1e293b'
const CARD2 = '#273548'
const SUBTLE = '#334155'
const WHITE = '#f1f5f9'
const LIGHT = '#94a3b8'
const DIM = '#64748b'
const TEAL = '#00687a'
const GREEN = '#34d399'

// ── MAIN DRAW ──
async function drawGraphic(canvas, data, pred) {
  const S = 1080
  canvas.width = S; canvas.height = S
  const ctx = canvas.getContext('2d')
  const teams = data.matchup.teams
  if (teams.length < 2) return
  const away = teams.find(t => t.side === 'away') || teams[0]
  const home = teams.find(t => t.side === 'home') || teams[1]
  const ac = LEFT_C, hc = RIGHT_C
  const P = 16, W = S - P * 2, half = W / 2

  // BG
  ctx.fillStyle = BG; ctx.fillRect(0, 0, S, S)
  // Team color bars
  ctx.fillStyle = ac.p; ctx.fillRect(0, 0, S / 2, 6)
  ctx.fillStyle = hc.p; ctx.fillRect(S / 2, 0, S / 2, 6)

  let y = 12

  // ── HEADER ──
  const hdrH = 48
  ctx.fillStyle = TEAL; roundRect(ctx, P, y, W, hdrH, 10); ctx.fill()
  ctx.fillStyle = WHITE; ctx.font = 'bold 22px system-ui'; ctx.textAlign = 'center'
  ctx.fillText('KEY MATCHUP', S / 2, y + 24)
  ctx.font = '12px system-ui'; ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.fillText(fmtDisplayDate(data.date), S / 2, y + 40)
  y += hdrH + 8

  // ── TEAM BANNER ──
  const bannerH = 148
  ctx.fillStyle = CARD; roundRect(ctx, P, y, W, bannerH, 10); ctx.fill()
  ctx.fillStyle = ac.p; ctx.fillRect(P, y, 6, bannerH)
  ctx.fillStyle = hc.p; ctx.fillRect(S - P - 6, y, 6, bannerH)

  // VS
  ctx.fillStyle = SUBTLE
  ctx.beginPath(); ctx.arc(S / 2, y + 62, 22, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = WHITE; ctx.font = 'bold 16px system-ui'; ctx.textAlign = 'center'
  ctx.fillText('VS', S / 2, y + 68)
  if (data.matchup.is_conference_game) {
    ctx.fillStyle = TEAL; roundRect(ctx, S / 2 - 56, y + 90, 112, 18, 9); ctx.fill()
    ctx.fillStyle = WHITE; ctx.font = 'bold 9px system-ui'; ctx.fillText('CONFERENCE GAME', S / 2, y + 102)
  }

  for (const [team, xC, c] of [[away, P + half / 2 + 6, ac], [home, S - P - half / 2 - 6, hc]]) {
    const r = team.record || {}
    const rec = `${r.wins || 0}-${r.losses || 0}`
    const conf = r.conference_wins != null ? `(${r.conference_wins}-${r.conference_losses} conf)` : ''
    try { const logo = await loadImage(team.logo_url); ctx.drawImage(logo, xC - 30, y + 8, 60, 60) } catch {}
    ctx.fillStyle = WHITE; ctx.font = 'bold 24px system-ui'; ctx.textAlign = 'center'
    ctx.fillText(team.short_name || team.name, xC, y + 86)
    ctx.fillStyle = LIGHT; ctx.font = '13px system-ui'
    ctx.fillText(`${rec}  ${conf}`, xC, y + 102)
    ctx.font = '11px system-ui'; ctx.fillText(`${team.division_level || ''} • ${team.conference_abbrev || ''}`, xC, y + 117)
    const rank = team.national_rank?.composite_rank
    if (rank) {
      const rankStr = `#${Math.round(rank)}`
      ctx.font = 'bold 10px system-ui'
      const rw = ctx.measureText(rankStr).width + 14
      ctx.fillStyle = c.p; roundRect(ctx, xC - rw / 2, y + 124, rw, 16, 8); ctx.fill()
      ctx.fillStyle = WHITE; ctx.fillText(rankStr, xC, y + 136)
    }
  }
  y += bannerH + 8

  // ── WIN PROBABILITY + PREDICTION ──
  const m = pred?.matchups?.[0]
  if (m) {
    const predH = 78
    ctx.fillStyle = CARD; roundRect(ctx, P, y, W, predH, 10); ctx.fill()
    let awP, hoP
    if (away.id === m.team_a) { awP = m.win_prob_a; hoP = m.win_prob_b }
    else { awP = m.win_prob_b; hoP = m.win_prob_a }

    // Bar
    const bX = P + 76, bW = W - 152, bY = y + 10, bH = 26
    ctx.fillStyle = ac.p; roundRect(ctx, bX, bY, Math.max(bW * awP, 10), bH, 5); ctx.fill()
    ctx.fillStyle = hc.p; roundRect(ctx, bX + bW - Math.max(bW * hoP, 10), bY, Math.max(bW * hoP, 10), bH, 5); ctx.fill()
    // Round away side and derive home = 100 - away so the two always sum to 100
    // (independent rounding of each side can produce 99/101 near .5 crossovers).
    const awPct = Math.round(awP * 100)
    const hoPct = 100 - awPct
    ctx.fillStyle = WHITE; ctx.font = 'bold 24px system-ui'
    ctx.textAlign = 'left'; ctx.fillText(`${awPct}%`, P + 12, bY + 22)
    ctx.textAlign = 'right'; ctx.fillText(`${hoPct}%`, S - P - 12, bY + 22)
    // Label background pill for readability
    ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center'
    const pwLabel = 'PROJECTED WIN %'
    const pwW = ctx.measureText(pwLabel).width + 16
    ctx.fillStyle = 'rgba(15,23,42,0.7)'; roundRect(ctx, S / 2 - pwW / 2, bY + 5, pwW, 16, 8); ctx.fill()
    ctx.fillStyle = WHITE
    ctx.fillText(pwLabel, S / 2, bY + 17)

    // Bottom info row
    const iy = y + 48
    const cols = [P + W * 0.1, P + W * 0.3, P + W * 0.5, P + W * 0.7, P + W * 0.9]
    const absSprd = Math.abs(m.spread).toFixed(1)
    const fav = m.favored === away.id ? away.short_name : home.short_name
    const projA = away.id === m.team_a ? m.proj_runs_a : m.proj_runs_b
    const projB = home.id === m.team_a ? m.proj_runs_a : m.proj_runs_b
    const awPwr = pred.teams?.find(t => t.team_id === away.id)
    const hoPwr = pred.teams?.find(t => t.team_id === home.id)

    const items = [
      { label: 'PWR RATING', val: awPwr?.power_rating?.toFixed(1) || '-', color: ac.t },
      { label: 'SPREAD', val: `${fav} -${absSprd}` },
      { label: 'OVER/UNDER', val: `${m.proj_total.toFixed(1)} runs` },
      { label: 'PROJ RUNS', val: `${projA.toFixed(1)} - ${projB.toFixed(1)}` },
      { label: 'PWR RATING', val: hoPwr?.power_rating?.toFixed(1) || '-', color: hc.t },
    ]
    items.forEach((it, i) => {
      ctx.fillStyle = DIM; ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center'
      ctx.fillText(it.label, cols[i], iy)
      ctx.fillStyle = it.color || WHITE; ctx.font = 'bold 14px system-ui'
      ctx.fillText(it.val, cols[i], iy + 18)
    })
    y += predH + 7
  }

  // ── TEAM STATS + PREVIOUS MATCHUPS (three columns) ──
  // Layout: OFFENSE | PITCHING | PREVIOUS MATCHUPS
  // The two stat columns are tighter than before so the new head-to-head
  // panel can sit on the same row.
  const statsH = 210
  ctx.fillStyle = CARD; roundRect(ctx, P, y, W, statsH, 10); ctx.fill()

  // Column boundaries
  const offW  = W * 0.28
  const pitW  = W * 0.28
  const matchW = W - offW - pitW
  const offX1 = P
  const offX2 = offX1 + offW
  const pitX1 = offX2
  const pitX2 = pitX1 + pitW
  const matX1 = pitX2
  const matX2 = S - P

  // Section headers
  ctx.fillStyle = ac.t; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center'
  ctx.fillText('OFFENSE', offX1 + offW / 2, y + 18)
  ctx.fillStyle = hc.t
  ctx.fillText('PITCHING', pitX1 + pitW / 2, y + 18)
  ctx.fillStyle = WHITE
  ctx.fillText('PREVIOUS MATCHUPS', matX1 + matchW / 2, y + 18)

  // Vertical separators between columns
  ctx.strokeStyle = SUBTLE; ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(offX2, y + 6); ctx.lineTo(offX2, y + statsH - 6)
  ctx.moveTo(pitX2, y + 6); ctx.lineTo(pitX2, y + statsH - 6)
  ctx.stroke()

  drawCompact(ctx, buildOffStats(away, home), offX1 + 6, offX2 - 6, y + 26, away, home)
  drawCompact(ctx, buildPitStats(away, home), pitX1 + 6, pitX2 - 6, y + 26, away, home)
  drawPreviousMatchups(ctx, m.previous_matchups || [], away, home,
                        matX1 + 8, matX2 - 8, y + 30, statsH - 36, ac, hc)
  y += statsH + 6

  // ── TOP HITTERS (5) ──
  y = drawPlayers(ctx, 'TOP HITTERS', away.top_hitters || [], home.top_hitters || [], 'hit', 5, P, y, W, S, ac, hc)
  y += 6

  // ── STARTERS (3) ──
  y = drawPlayers(ctx, 'STARTING ROTATION', away.top_starters || [], home.top_starters || [], 'pit', 3, P, y, W, S, ac, hc)
  y += 6

  // ── RELIEVERS (2) ──
  y = drawPlayers(ctx, 'TOP RELIEVERS', away.top_relievers || [], home.top_relievers || [], 'pit', 2, P, y, W, S, ac, hc)

  // ── FOOTER ──
  const footerH = 24
  const footerY = S - P - footerH
  ctx.fillStyle = TEAL; roundRect(ctx, P, footerY, W, footerH, 8); ctx.fill()
  ctx.fillStyle = WHITE; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'
  ctx.fillText('PNWBASEBALLSTATS.COM', S / 2, footerY + 16)
}

function buildOffStats(a, h) {
  const ab = a.batting || {}, hb = h.batting || {}
  const ag = (a.record?.wins || 0) + (a.record?.losses || 0) || 1
  const hg = (h.record?.wins || 0) + (h.record?.losses || 0) || 1
  return [
    { l: 'R/G', a: ((ab.total_runs || 0) / ag).toFixed(1), h: ((hb.total_runs || 0) / hg).toFixed(1), hi: true },
    { l: 'AVG', a: fmtAvg(ab.team_avg), h: fmtAvg(hb.team_avg), hi: true },
    { l: 'OBP', a: fmtAvg(ab.team_obp), h: fmtAvg(hb.team_obp), hi: true },
    { l: 'SLG', a: fmtAvg(ab.team_slg), h: fmtAvg(hb.team_slg), hi: true },
    { l: 'wRC+', a: String(Math.round(ab.avg_wrc_plus || 0)), h: String(Math.round(hb.avg_wrc_plus || 0)), hi: true },
    { l: 'HR', a: String(ab.total_hr || 0), h: String(hb.total_hr || 0), hi: true },
    { l: 'SB', a: String(ab.total_sb || 0), h: String(hb.total_sb || 0), hi: true },
    { l: 'oWAR', a: fmtDec(ab.total_owar, 1), h: fmtDec(hb.total_owar, 1), hi: true },
  ]
}
function buildPitStats(a, h) {
  const ap = a.pitching || {}, hp = h.pitching || {}
  const ag = (a.record?.wins || 0) + (a.record?.losses || 0) || 1
  const hg = (h.record?.wins || 0) + (h.record?.losses || 0) || 1
  return [
    { l: 'RA/G', a: ((ap.total_runs_allowed || 0) / ag).toFixed(1), h: ((hp.total_runs_allowed || 0) / hg).toFixed(1), hi: false },
    { l: 'ERA', a: fmtDec(ap.team_era), h: fmtDec(hp.team_era), hi: false },
    { l: 'FIP', a: fmtDec(ap.avg_fip), h: fmtDec(hp.avg_fip), hi: false },
    { l: 'WHIP', a: fmtDec(ap.team_whip), h: fmtDec(hp.team_whip), hi: false },
    { l: 'K%', a: fmtPct(ap.avg_k_pct), h: fmtPct(hp.avg_k_pct), hi: true },
    { l: 'BB%', a: fmtPct(ap.avg_bb_pct), h: fmtPct(hp.avg_bb_pct), hi: false },
    { l: 'Opp AVG', a: fmtAvg(ap.opp_avg), h: fmtAvg(hp.opp_avg), hi: false },
    { l: 'pWAR', a: fmtDec(ap.total_pwar, 1), h: fmtDec(hp.total_pwar, 1), hi: true },
  ]
}

function drawCompact(ctx, stats, xL, xR, startY, away, home) {
  const bw = xR - xL, mid = xL + bw / 2, rh = 22
  ctx.font = 'bold 10px system-ui'; ctx.fillStyle = LIGHT
  ctx.textAlign = 'right'; ctx.fillText(away.short_name, mid - 36, startY + 6)
  ctx.textAlign = 'left'; ctx.fillText(home.short_name, mid + 36, startY + 6)
  for (let i = 0; i < stats.length; i++) {
    const r = stats[i], ry = startY + 12 + i * rh
    const av = parseFloat(r.a) || 0, hv = parseFloat(r.h) || 0
    const aB = av !== hv && (r.hi ? av > hv : av < hv)
    const hB = av !== hv && (r.hi ? hv > av : hv < av)
    if (i % 2 === 0) { ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(xL, ry, bw, rh) }
    ctx.font = aB ? 'bold 14px system-ui' : '14px system-ui'
    ctx.fillStyle = aB ? GREEN : WHITE
    ctx.textAlign = 'right'; ctx.fillText(r.a, mid - 36, ry + 16)
    ctx.font = 'bold 11px system-ui'; ctx.fillStyle = DIM; ctx.textAlign = 'center'
    ctx.fillText(r.l, mid, ry + 16)
    ctx.font = hB ? 'bold 14px system-ui' : '14px system-ui'
    ctx.fillStyle = hB ? GREEN : WHITE
    ctx.textAlign = 'left'; ctx.fillText(r.h, mid + 36, ry + 16)
  }
}

function drawPreviousMatchups(ctx, games, away, home, xL, xR, startY, maxH, ac, hc) {
  const colW = xR - xL

  if (!games || games.length === 0) {
    // No previous meeting this season
    ctx.fillStyle = LIGHT
    ctx.font = '12px system-ui'
    ctx.textAlign = 'center'
    ctx.fillText('No previous meeting this season', (xL + xR) / 2, startY + maxH / 2 - 6)
    ctx.fillStyle = DIM
    ctx.font = 'italic 10px system-ui'
    ctx.fillText('First matchup of the year', (xL + xR) / 2, startY + maxH / 2 + 10)
    return
  }

  // Compute head-to-head record from the games' perspective of `away`
  let awayWins = 0, homeWins = 0
  for (const g of games) {
    const awayIsHome = g.home_team_id === away.id
    const aScore = awayIsHome ? g.home_score : g.away_score
    const hScore = awayIsHome ? g.away_score : g.home_score
    if (aScore == null || hScore == null) continue
    if (aScore > hScore) awayWins++
    else if (hScore > aScore) homeWins++
  }

  // Header: H2H record line
  const headY = startY
  ctx.fillStyle = LIGHT
  ctx.font = 'bold 10px system-ui'
  ctx.textAlign = 'center'
  ctx.fillText(`${away.short_name} ${awayWins} – ${homeWins} ${home.short_name}`,
                (xL + xR) / 2, headY + 4)

  // Game list — auto-shrink row height to fit all games
  const listTopY = headY + 16
  const listMaxH = maxH - 16
  const n = games.length
  const rh = Math.min(28, Math.max(14, Math.floor(listMaxH / Math.max(n, 1))))
  const dateColW = colW * 0.32
  const scoreColW = colW * 0.40
  const resultColW = colW - dateColW - scoreColW

  for (let i = 0; i < n; i++) {
    const g = games[i]
    const ry = listTopY + i * rh
    if (i % 2 === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.03)'
      ctx.fillRect(xL, ry, colW, rh)
    }

    const awayIsHome = g.home_team_id === away.id
    const awayScore = awayIsHome ? g.home_score : g.away_score
    const homeScore = awayIsHome ? g.away_score : g.home_score
    const awayWon = awayScore != null && homeScore != null && awayScore > homeScore
    const homeWon = homeScore != null && awayScore != null && homeScore > awayScore

    // Date (left)
    const isoDate = g.game_date
    let dateStr = ''
    if (isoDate) {
      const [y, mo, d] = isoDate.split('-').map(Number)
      const dt = new Date(y, mo - 1, d)
      dateStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }
    ctx.fillStyle = LIGHT
    ctx.font = '11px system-ui'
    ctx.textAlign = 'left'
    ctx.fillText(dateStr, xL + 6, ry + rh / 2 + 4)

    // Score (center): "AwayShort N - M HomeShort"
    // Use side colors (away = ac, home = hc) for each team's short name.
    const midX = xL + dateColW + scoreColW / 2
    const awayLabel = away.short_name.length > 6 ? away.short_name.slice(0, 6) : away.short_name
    const homeLabel = home.short_name.length > 6 ? home.short_name.slice(0, 6) : home.short_name
    const aScoreStr = awayScore != null ? String(awayScore) : '–'
    const hScoreStr = homeScore != null ? String(homeScore) : '–'
    const scoreText = `${aScoreStr} – ${hScoreStr}`
    ctx.font = 'bold 13px system-ui'
    ctx.fillStyle = WHITE
    ctx.textAlign = 'center'
    ctx.fillText(scoreText, midX, ry + rh / 2 + 4)

    // Result indicator (right): "W" or "L" from away's perspective, color-coded
    let resultText = '—'
    let resultColor = DIM
    if (awayWon) { resultText = `${away.short_name} W`; resultColor = ac.t }
    else if (homeWon) { resultText = `${home.short_name} W`; resultColor = hc.t }
    ctx.font = 'bold 10px system-ui'
    ctx.fillStyle = resultColor
    ctx.textAlign = 'right'
    ctx.fillText(resultText, xR - 6, ry + rh / 2 + 4)
  }
}


function drawPlayers(ctx, title, awayP, homeP, type, max, P, startY, W, S, ac, hc) {
  const rh = 36
  const headH = 28, subH = 16
  const blockH = headH + subH + max * rh + 6

  ctx.fillStyle = CARD; roundRect(ctx, P, startY, W, blockH, 10); ctx.fill()
  ctx.fillStyle = CARD2; roundRect(ctx, P, startY, W, headH, 10); ctx.fill()
  ctx.fillStyle = ac.p; ctx.fillRect(P, startY, 5, headH)
  ctx.fillStyle = hc.p; ctx.fillRect(S - P - 5, startY, 5, headH)
  ctx.fillStyle = WHITE; ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'center'
  ctx.fillText(title, S / 2, startY + 18)

  ctx.strokeStyle = SUBTLE; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(S / 2, startY + headH); ctx.lineTo(S / 2, startY + blockH - 2); ctx.stroke()

  const lx = P + 8, lw = W / 2 - 16, rx = S / 2 + 8
  let y = startY + headH

  ctx.fillStyle = DIM; ctx.font = 'bold 9px system-ui'
  const cols = type === 'hit'
    ? [['PLAYER', 0.01, 'l'], ['AVG', 0.40, 'r'], ['OBP', 0.53, 'r'], ['SLG', 0.66, 'r'], ['HR', 0.76, 'r'], ['wRC+', 0.88, 'r'], ['oWAR', 0.99, 'r']]
    : [['PLAYER', 0.01, 'l'], ['ERA', 0.40, 'r'], ['IP', 0.52, 'r'], ['K', 0.62, 'r'], ['FIP', 0.74, 'r'], ['K-BB%', 0.88, 'r'], ['pWAR', 0.99, 'r']]

  for (const base of [lx, rx]) {
    cols.forEach(([label, pct, align]) => {
      ctx.textAlign = align === 'l' ? 'left' : 'right'
      ctx.fillText(label, base + lw * pct, y + 11)
    })
  }
  y += subH

  for (let i = 0; i < max; i++) {
    const ry = y + i * rh
    if (i % 2 === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.025)'
      ctx.fillRect(P + 2, ry, W / 2 - 4, rh)
      ctx.fillRect(S / 2 + 2, ry, W / 2 - 4, rh)
    }
    if (awayP[i]) drawPRow(ctx, awayP[i], type, lx, lw, ry, ac)
    if (homeP[i]) drawPRow(ctx, homeP[i], type, rx, lw, ry, hc)
  }
  return startY + blockH
}

function drawPRow(ctx, p, type, xS, sw, ry, tc) {
  const nm = `${p.first_name?.[0] || ''}. ${p.last_name || ''}`
  ctx.fillStyle = WHITE; ctx.font = '13px system-ui'; ctx.textAlign = 'left'
  ctx.fillText(nm, xS + sw * 0.01, ry + 16)
  if (p.position) {
    ctx.fillStyle = DIM; ctx.font = '8px system-ui'
    ctx.fillText(p.position, xS + sw * 0.01, ry + 28)
  }
  ctx.textAlign = 'right'
  if (type === 'hit') {
    ctx.fillStyle = WHITE; ctx.font = '12px system-ui'
    ctx.fillText(fmtAvg(p.batting_avg), xS + sw * 0.40, ry + 22)
    ctx.fillText(fmtAvg(p.on_base_pct), xS + sw * 0.53, ry + 22)
    ctx.fillText(fmtAvg(p.slugging_pct), xS + sw * 0.66, ry + 22)
    ctx.fillText(String(p.home_runs || 0), xS + sw * 0.76, ry + 22)
    ctx.fillStyle = tc.t; ctx.font = 'bold 14px system-ui'
    ctx.fillText(String(Math.round(p.wrc_plus || 0)), xS + sw * 0.88, ry + 22)
    ctx.fillStyle = WHITE; ctx.font = '12px system-ui'
    ctx.fillText(fmtDec(p.offensive_war, 1), xS + sw * 0.99, ry + 22)
  } else {
    const kbb = p.k_bb_pct != null ? fmtPct(p.k_bb_pct) : (p.k_pct != null && p.bb_pct != null ? fmtPct(parseFloat(p.k_pct) - parseFloat(p.bb_pct)) : '-')
    ctx.fillStyle = WHITE; ctx.font = '12px system-ui'
    ctx.fillText(fmtDec(p.era), xS + sw * 0.40, ry + 22)
    ctx.fillText(fmtIP(p.innings_pitched), xS + sw * 0.52, ry + 22)
    ctx.fillText(String(p.strikeouts || 0), xS + sw * 0.62, ry + 22)
    ctx.fillStyle = tc.t; ctx.font = 'bold 14px system-ui'
    ctx.fillText(fmtDec(p.fip), xS + sw * 0.74, ry + 22)
    ctx.fillStyle = WHITE; ctx.font = '12px system-ui'
    ctx.fillText(kbb, xS + sw * 0.88, ry + 22)
    ctx.fillText(fmtDec(p.pitching_war, 1), xS + sw * 0.99, ry + 22)
  }
}

// ── Component ──
export default function KeyMatchupGraphic() {
  const [date, setDate] = useState(todayStr())
  const [data, setData] = useState(null)
  const [pred, setPred] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [selGame, setSelGame] = useState(null)
  const canvasRef = useRef(null)

  const fetchData = useCallback(async (d, gid) => {
    setLoading(true); setError(null)
    try {
      let url = `${API_BASE}/games/key-matchup?date=${d}&season=2026`
      if (gid) url += `&game_id=${gid}`
      const resp = await fetch(url)
      if (!resp.ok) throw new Error('Failed to fetch')
      const json = await resp.json()

      if (json.matchup) {
        setSelGame(json.matchup.game_id)
        const teams = json.matchup.teams || []
        const ids = teams.map(t => t.id).join(',')
        if (ids) {
          try {
            const pr = await fetch(`${API_BASE}/teams/matchup?season=2026&team_ids=${ids}`)
            if (pr.ok) setPred(await pr.json())
          } catch {}
        }

        // Fetch previous head-to-head games this season. Use one team's
        // game log and filter to games vs the other team. Excludes the
        // currently-selected game so today's matchup doesn't show as a
        // "previous" result.
        if (teams.length === 2) {
          try {
            const [t1, t2] = teams
            const gr = await fetch(`${API_BASE}/teams/${t1.id}/games?season=2026`)
            if (gr.ok) {
              const allGames = await gr.json()
              const h2h = (Array.isArray(allGames) ? allGames : [])
                .filter(g => g.status === 'final'
                          && (g.home_team_id === t2.id || g.away_team_id === t2.id)
                          && g.id !== json.matchup.game_id)
                .sort((a, b) => (a.game_date || '').localeCompare(b.game_date || ''))
              json.matchup.previous_matchups = h2h
            }
          } catch {}
        }
      }
      setData(json)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData(date, null) }, [date, fetchData])
  useEffect(() => { if (data?.matchup && canvasRef.current) drawGraphic(canvasRef.current, data, pred) }, [data, pred])

  const changeDate = (dir) => {
    const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + dir)
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
              <select value={selGame || ''} onChange={e => { const v = e.target.value; setSelGame(v); fetchData(date, v) }} className="px-3 py-1.5 rounded border border-gray-300 text-sm flex-1 min-w-[200px]">
                {data.games.map(g => <option key={g.id} value={g.id}>{g.away_short} @ {g.home_short}{g.is_conference_game ? ' (Conf)' : ''}{g.home_division ? ` — ${g.home_division}` : ''}</option>)}
              </select>
            )}
            <button onClick={() => { if (!canvasRef.current) return; const l = document.createElement('a'); l.download = `key-matchup-${date}.png`; l.href = canvasRef.current.toDataURL('image/png'); l.click() }} disabled={!data?.matchup} className="px-4 py-1.5 rounded text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#00687a' }}>
              Download PNG
            </button>
          </div>
        </div>
        {loading && <p className="text-center text-gray-500 py-12">Loading...</p>}
        {error && <p className="text-center text-red-500 py-12">{error}</p>}
        {!loading && data && !data.matchup && <p className="text-center text-gray-500 py-12">No PNW games found for {shortDate(date)}</p>}
        {data?.matchup && (
          <div className="flex justify-center">
            <canvas ref={canvasRef} className="rounded-lg shadow-lg" style={{ width: 540, height: 540 }} />
          </div>
        )}
      </div>
    </div>
  )
}
