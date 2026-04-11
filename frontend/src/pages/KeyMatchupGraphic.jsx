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

// ── TEAM COLORS ──
const TC = {
  'Oregon':       { p: '#154733', s: '#FEE123', t: '#7dca5c' },
  'Oregon St':    { p: '#DC4405', s: '#000000', t: '#ff8c5a' },
  'Washington':   { p: '#4B2E83', s: '#B7A57A', t: '#b89aff' },
  'Wash St':      { p: '#981E32', s: '#5E6A71', t: '#ff6b7f' },
  'Gonzaga':      { p: '#002967', s: '#C8102E', t: '#6b9aff' },
  'Portland':     { p: '#3E1F6B', s: '#FFFFFF', t: '#b089ff' },
  'Seattle U':    { p: '#AA0000', s: '#000000', t: '#ff6666' },
  'CWU':          { p: '#B1040E', s: '#000000', t: '#ff6b6b' },
  'WWU':          { p: '#003F87', s: '#FFFFFF', t: '#6ba3ff' },
  'SPU':          { p: '#4E2683', s: '#FFFFFF', t: '#b089ff' },
  'SFU':          { p: '#CC0633', s: '#003B6F', t: '#ff6680' },
  'MSU Billings': { p: '#FFB81C', s: '#006341', t: '#ffd666' },
  'MSUB':         { p: '#FFB81C', s: '#006341', t: '#ffd666' },
  'SMU':          { p: '#004990', s: '#FFFFFF', t: '#5599ff' },
  'NNU':          { p: '#F7941D', s: '#000000', t: '#ffb74d' },
  'WOU':          { p: '#E41C38', s: '#3D3935', t: '#ff6b7f' },
  'Concordia':    { p: '#002855', s: '#FFFFFF', t: '#5588cc' },
  'Corban':       { p: '#003262', s: '#B8922F', t: '#5588cc' },
  'EOU':          { p: '#003DA5', s: '#FFC72C', t: '#5599ff' },
  'L&C':          { p: '#B5A36A', s: '#000000', t: '#d4c898' },
  'Lewis-Clark':  { p: '#003DA5', s: '#CF102D', t: '#5599ff' },
  'Linfield':     { p: '#6E2585', s: '#000000', t: '#b66bdd' },
  'George Fox':   { p: '#00205B', s: '#CFB87C', t: '#5577bb' },
  'Pacific':      { p: '#000000', s: '#C8102E', t: '#999999' },
  'PLU':          { p: '#000000', s: '#C89A2C', t: '#d4b84d' },
  'Puget Sound':  { p: '#8B2332', s: '#000000', t: '#dd6677' },
  'Whitman':      { p: '#1C5BA2', s: '#D2492A', t: '#6ba3ff' },
  'Whitworth':    { p: '#A6192E', s: '#002855', t: '#dd6677' },
  'Willamette':   { p: '#862633', s: '#C99700', t: '#cc7788' },
  'Bushnell':     { p: '#002D72', s: '#C8102E', t: '#5588cc' },
}
const DEFAULT_C = { p: '#00687a', s: '#004d5a', t: '#4dd9c0' }
function getTC(name) { return TC[name] || DEFAULT_C }

// ── DESIGN TOKENS ──
const BG = '#0f172a'
const CARD = '#1e293b'
const CARD2 = '#273548'
const SUBTLE = '#334155'
const WHITE = '#f8fafc'
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
  const ac = getTC(away.short_name), hc = getTC(home.short_name)
  const P = 20, W = S - P * 2, half = W / 2

  // BG
  ctx.fillStyle = BG; ctx.fillRect(0, 0, S, S)
  // Team color bars
  ctx.fillStyle = ac.p; ctx.fillRect(0, 0, S / 2, 5)
  ctx.fillStyle = hc.p; ctx.fillRect(S / 2, 0, S / 2, 5)

  let y = 10

  // ── HEADER ──
  ctx.fillStyle = TEAL; roundRect(ctx, P, y, W, 36, 8); ctx.fill()
  ctx.fillStyle = WHITE; ctx.font = 'bold 17px system-ui'; ctx.textAlign = 'center'
  ctx.fillText('KEY MATCHUP', S / 2, y + 19)
  ctx.font = '10px system-ui'; ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.fillText(fmtDisplayDate(data.date), S / 2, y + 32)
  y += 42

  // ── TEAM BANNER ──
  const bannerH = 100
  ctx.fillStyle = CARD; roundRect(ctx, P, y, W, bannerH, 10); ctx.fill()
  // Color accents
  ctx.fillStyle = ac.p; ctx.fillRect(P, y, 5, bannerH)
  ctx.fillStyle = hc.p; ctx.fillRect(S - P - 5, y, 5, bannerH)

  // VS circle
  ctx.fillStyle = SUBTLE
  ctx.beginPath(); ctx.arc(S / 2, y + bannerH / 2, 18, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = WHITE; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center'
  ctx.fillText('VS', S / 2, y + bannerH / 2 + 5)
  if (data.matchup.is_conference_game) {
    ctx.fillStyle = TEAL; roundRect(ctx, S / 2 - 46, y + bannerH / 2 + 22, 92, 14, 7); ctx.fill()
    ctx.fillStyle = WHITE; ctx.font = 'bold 8px system-ui'; ctx.fillText('CONFERENCE GAME', S / 2, y + bannerH / 2 + 32)
  }

  for (const [team, xC, c] of [[away, P + half / 2 + 4, ac], [home, S - P - half / 2 - 4, hc]]) {
    const r = team.record || {}
    const rec = `${r.wins || 0}-${r.losses || 0}`
    const conf = r.conference_wins != null ? `(${r.conference_wins}-${r.conference_losses} conf)` : ''
    try { const logo = await loadImage(team.logo_url); ctx.drawImage(logo, xC - 24, y + 6, 48, 48) } catch {}
    ctx.fillStyle = WHITE; ctx.font = 'bold 20px system-ui'; ctx.textAlign = 'center'
    ctx.fillText(team.short_name || team.name, xC, y + 70)
    ctx.fillStyle = LIGHT; ctx.font = '11px system-ui'
    ctx.fillText(`${rec}  ${conf}`, xC, y + 84)
    ctx.font = '10px system-ui'; ctx.fillText(`${team.division_level || ''} • ${team.conference_abbrev || ''}`, xC, y + 96)
    const rank = team.national_rank?.composite_rank
    if (rank) {
      ctx.fillStyle = c.p; roundRect(ctx, xC - 16, y + 52, 32, 14, 7); ctx.fill()
      ctx.fillStyle = WHITE; ctx.font = 'bold 9px system-ui'; ctx.fillText(`#${rank}`, xC, y + 62)
    }
  }
  y += bannerH + 6

  // ── WIN PROBABILITY + PREDICTION ──
  const m = pred?.matchups?.[0]
  if (m) {
    const predH = 62
    ctx.fillStyle = CARD; roundRect(ctx, P, y, W, predH, 8); ctx.fill()
    let awP, hoP
    if (away.id === m.team_a) { awP = m.win_prob_a; hoP = m.win_prob_b }
    else { awP = m.win_prob_b; hoP = m.win_prob_a }

    // Bar
    const bX = P + 60, bW = W - 120, bY = y + 8, bH = 22
    ctx.fillStyle = ac.p; roundRect(ctx, bX, bY, bW * awP, bH, 4); ctx.fill()
    ctx.fillStyle = hc.p; roundRect(ctx, bX + bW - bW * hoP, bY, bW * hoP, bH, 4); ctx.fill()
    // Pcts
    ctx.fillStyle = WHITE; ctx.font = 'bold 20px system-ui'
    ctx.textAlign = 'left'; ctx.fillText(`${(awP * 100).toFixed(0)}%`, P + 10, bY + 18)
    ctx.textAlign = 'right'; ctx.fillText(`${(hoP * 100).toFixed(0)}%`, S - P - 10, bY + 18)
    ctx.fillStyle = DIM; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center'
    ctx.fillText('PROJECTED WIN %', S / 2, bY + 15)

    // Bottom row: Spread | O/U | Proj Runs | Power ratings
    const iy = y + 40
    const cols = [P + W * 0.1, P + W * 0.3, P + W * 0.5, P + W * 0.7, P + W * 0.9]
    const absSprd = Math.abs(m.spread).toFixed(1)
    const fav = m.favored === away.id ? away.short_name : home.short_name
    const projA = away.id === m.team_a ? m.proj_runs_a : m.proj_runs_b
    const projB = home.id === m.team_a ? m.proj_runs_a : m.proj_runs_b
    const awPwr = pred.teams?.find(t => t.team_id === away.id)
    const hoPwr = pred.teams?.find(t => t.team_id === home.id)

    const infoItems = [
      { label: 'PWR RATING', val: awPwr?.power_rating?.toFixed(1) || '-', color: ac.t },
      { label: 'SPREAD', val: `${fav} -${absSprd}` },
      { label: 'OVER/UNDER', val: `${m.proj_total.toFixed(1)} runs` },
      { label: 'PROJ RUNS', val: `${projA.toFixed(1)} - ${projB.toFixed(1)}` },
      { label: 'PWR RATING', val: hoPwr?.power_rating?.toFixed(1) || '-', color: hc.t },
    ]
    infoItems.forEach((item, i) => {
      ctx.fillStyle = DIM; ctx.font = 'bold 7px system-ui'; ctx.textAlign = 'center'
      ctx.fillText(item.label, cols[i], iy)
      ctx.fillStyle = item.color || WHITE; ctx.font = 'bold 11px system-ui'
      ctx.fillText(item.val, cols[i], iy + 14)
    })
    y += predH + 5
  }

  // ── TEAM STATS: Full-width grid layout ──
  const statsH = 166
  ctx.fillStyle = CARD; roundRect(ctx, P, y, W, statsH, 8); ctx.fill()

  // Offense (left half) and Pitching (right half) side by side
  // Each has: column of away vals | labels | column of home vals
  const offStats = buildOffStats(away, home)
  const pitStats = buildPitStats(away, home)
  const leftMid = P + half / 2, rightMid = S - P - half / 2

  // Headers
  ctx.fillStyle = ac.t; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'
  ctx.fillText('OFFENSE', leftMid, y + 14)
  ctx.fillStyle = hc.t; ctx.fillText('PITCHING', rightMid, y + 14)

  // Divider
  ctx.strokeStyle = SUBTLE; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(S / 2, y + 4); ctx.lineTo(S / 2, y + statsH - 4); ctx.stroke()

  drawCompact(ctx, offStats, P + 6, S / 2 - 6, y + 20, away, home, ac, hc)
  drawCompact(ctx, pitStats, S / 2 + 6, S - P - 6, y + 20, away, home, ac, hc)
  y += statsH + 5

  // ── TOP HITTERS (5 per side) ──
  y = drawPlayers(ctx, 'TOP HITTERS  (50+ PA)', away.top_hitters || [], home.top_hitters || [], 'hit', 5, P, y, W, S, ac, hc)
  y += 4

  // ── STARTERS (3 per side) ──
  y = drawPlayers(ctx, 'STARTING ROTATION  (5+ GS)', away.top_starters || [], home.top_starters || [], 'sp', 3, P, y, W, S, ac, hc)
  y += 4

  // ── RELIEVERS (2 per side) ──
  y = drawPlayers(ctx, 'TOP RELIEVERS  (10+ IP, by K-BB%)', away.top_relievers || [], home.top_relievers || [], 'rp', 2, P, y, W, S, ac, hc)

  // ── FOOTER ──
  ctx.fillStyle = TEAL; roundRect(ctx, P, S - 24, W, 18, 6); ctx.fill()
  ctx.fillStyle = WHITE; ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center'
  ctx.fillText('PNWBASEBALLSTATS.COM', S / 2, S - 12)
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

function drawCompact(ctx, stats, xL, xR, startY, away, home, ac, hc) {
  const bw = xR - xL, mid = xL + bw / 2, rh = 17
  // Headers
  ctx.font = 'bold 8px system-ui'; ctx.fillStyle = LIGHT
  ctx.textAlign = 'right'; ctx.fillText(away.short_name, mid - 28, startY + 6)
  ctx.textAlign = 'left'; ctx.fillText(home.short_name, mid + 28, startY + 6)
  for (let i = 0; i < stats.length; i++) {
    const r = stats[i], ry = startY + 10 + i * rh
    const av = parseFloat(r.a) || 0, hv = parseFloat(r.h) || 0
    const aB = av !== hv && (r.hi ? av > hv : av < hv)
    const hB = av !== hv && (r.hi ? hv > av : hv < av)
    if (i % 2 === 0) { ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(xL, ry, bw, rh) }
    // Away
    ctx.font = aB ? 'bold 11px system-ui' : '11px system-ui'
    ctx.fillStyle = aB ? GREEN : WHITE
    ctx.textAlign = 'right'; ctx.fillText(r.a, mid - 28, ry + 13)
    // Label
    ctx.font = 'bold 9px system-ui'; ctx.fillStyle = DIM; ctx.textAlign = 'center'
    ctx.fillText(r.l, mid, ry + 13)
    // Home
    ctx.font = hB ? 'bold 11px system-ui' : '11px system-ui'
    ctx.fillStyle = hB ? GREEN : WHITE
    ctx.textAlign = 'left'; ctx.fillText(r.h, mid + 28, ry + 13)
  }
}

function drawPlayers(ctx, title, awayP, homeP, type, max, P, startY, W, S, ac, hc) {
  const rh = type === 'hit' ? 26 : 28
  const headH = 22, subH = 12
  const blockH = headH + subH + max * rh + 4

  ctx.fillStyle = CARD; roundRect(ctx, P, startY, W, blockH, 8); ctx.fill()
  // Title bar with team color accents
  ctx.fillStyle = CARD2; roundRect(ctx, P, startY, W, headH, 8); ctx.fill()
  ctx.fillStyle = ac.p; ctx.fillRect(P, startY, 4, headH)
  ctx.fillStyle = hc.p; ctx.fillRect(S - P - 4, startY, 4, headH)
  ctx.fillStyle = WHITE; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'
  ctx.fillText(title, S / 2, startY + 15)

  // Divider
  ctx.strokeStyle = SUBTLE; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(S / 2, startY + headH); ctx.lineTo(S / 2, startY + blockH - 2); ctx.stroke()

  const lx = P + 6, lw = W / 2 - 12, rx = S / 2 + 6

  let y = startY + headH
  // Sub headers
  ctx.fillStyle = DIM; ctx.font = 'bold 7px system-ui'
  const cols = type === 'hit'
    ? [['PLAYER', 0.01, 'l'], ['AVG', 0.42, 'r'], ['OBP', 0.55, 'r'], ['SLG', 0.67, 'r'], ['HR', 0.77, 'r'], ['wRC+', 0.88, 'r'], ['oWAR', 0.99, 'r']]
    : type === 'sp'
    ? [['PLAYER', 0.01, 'l'], ['ERA', 0.42, 'r'], ['IP', 0.55, 'r'], ['K', 0.66, 'r'], ['FIP', 0.78, 'r'], ['K-BB%', 0.90, 'r'], ['pWAR', 0.99, 'r']]
    : [['PLAYER', 0.01, 'l'], ['ERA', 0.42, 'r'], ['IP', 0.55, 'r'], ['K', 0.66, 'r'], ['FIP', 0.78, 'r'], ['K-BB%', 0.90, 'r'], ['pWAR', 0.99, 'r']]

  for (const [base] of [[lx], [rx]]) {
    cols.forEach(([label, pct, align]) => {
      ctx.textAlign = align === 'l' ? 'left' : 'right'
      ctx.fillText(label, base + lw * pct, y + 9)
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
  ctx.fillStyle = WHITE; ctx.font = '11px system-ui'; ctx.textAlign = 'left'
  ctx.fillText(nm, xS + sw * 0.01, ry + 14)
  if (p.position) {
    ctx.fillStyle = DIM; ctx.font = '7px system-ui'
    ctx.fillText(p.position, xS + sw * 0.01, ry + 22)
  }
  ctx.textAlign = 'right'
  if (type === 'hit') {
    ctx.fillStyle = WHITE; ctx.font = '10px system-ui'
    ctx.fillText(fmtAvg(p.batting_avg), xS + sw * 0.42, ry + 14)
    ctx.fillText(fmtAvg(p.on_base_pct), xS + sw * 0.55, ry + 14)
    ctx.fillText(fmtAvg(p.slugging_pct), xS + sw * 0.67, ry + 14)
    ctx.fillText(String(p.home_runs || 0), xS + sw * 0.77, ry + 14)
    ctx.fillStyle = tc.t; ctx.font = 'bold 11px system-ui'
    ctx.fillText(String(Math.round(p.wrc_plus || 0)), xS + sw * 0.88, ry + 14)
    ctx.fillStyle = WHITE; ctx.font = '10px system-ui'
    ctx.fillText(fmtDec(p.offensive_war, 1), xS + sw * 0.99, ry + 14)
  } else {
    const kbb = p.k_bb_pct != null ? fmtPct(p.k_bb_pct) : (p.k_pct != null && p.bb_pct != null ? fmtPct(parseFloat(p.k_pct) - parseFloat(p.bb_pct)) : '-')
    ctx.fillStyle = WHITE; ctx.font = '10px system-ui'
    ctx.fillText(fmtDec(p.era), xS + sw * 0.42, ry + 14)
    ctx.fillText(fmtIP(p.innings_pitched), xS + sw * 0.55, ry + 14)
    ctx.fillText(String(p.strikeouts || 0), xS + sw * 0.66, ry + 14)
    ctx.fillStyle = tc.t; ctx.font = 'bold 11px system-ui'
    ctx.fillText(fmtDec(p.fip), xS + sw * 0.78, ry + 14)
    ctx.fillStyle = WHITE; ctx.font = '10px system-ui'
    ctx.fillText(kbb, xS + sw * 0.90, ry + 14)
    ctx.fillText(fmtDec(p.pitching_war, 1), xS + sw * 0.99, ry + 14)
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
      setData(json)
      if (json.matchup) {
        setSelGame(json.matchup.game_id)
        const ids = json.matchup.teams.map(t => t.id).join(',')
        if (ids) {
          try {
            const pr = await fetch(`${API_BASE}/teams/matchup?season=2026&team_ids=${ids}`)
            if (pr.ok) setPred(await pr.json())
          } catch {}
        }
      }
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
              <select value={selGame || ''} onChange={e => { setSelGame(parseInt(e.target.value)); fetchData(date, parseInt(e.target.value)) }} className="px-3 py-1.5 rounded border border-gray-300 text-sm flex-1 min-w-[200px]">
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
