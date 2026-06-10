// WclGameRecapGraphic — canvas-based SINGLE-game WCL recap card.
//   /summer/game-recap   (listed under the Graphics hub; ?game=<id> preselects)
//
// Renders a FIXED 1080×1350 (Instagram 4:5) PNG: centered final, full R/H/E
// line score, a play-by-play win-probability chart (the server builds the
// curve from the actual WCL plate-appearance events; this card falls back to an
// inning-level line-score model only if a game has no events), and each side's
// TOP PERFORMERS as large, readable cards — top hitters PLUS top pitchers
// (decision pitchers always shown with a W/L/SV badge, then the best remaining
// arms). Sections use fixed, generous heights so the card fills the frame
// without big empty gaps.
//
// Download button writes wcl-game-<away>-<home>-<date>.png.

import { useState, useRef, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CURRENT_SEASON } from '../lib/seasons'

const API_BASE = '/api/v1'
const W = 1080
const H = 1350

// ── Colors (WCL navy + gold theme) ─────────────────────────────
const C = {
  navy:       '#14365c',
  navy_dark:  '#0d2240',
  blue:       '#1f5485',
  gold:       '#c9a44c',
  gold_deep:  '#a9842f',
  gold_light: '#e2c577',
  bg:         '#f6f1e3',
  card:       '#ffffff',
  card_alt:   '#fbf8ef',
  line:       'rgba(20,54,92,0.12)',
  text:       '#1a1a1a',
  text_muted: '#5a5a5a',
  text_gray:  '#8a8a8a',
  win:        '#14365c',
  loss:       '#8a8a8a',
  wlW:        '#2f7d4f',
  wlL:        '#b04a4a',
  homeFill:   'rgba(20,54,92,0.22)',
  awayFill:   'rgba(169,132,47,0.26)',
}

// ── Tiny helpers ───────────────────────────────────────────────
const fmtIP = (ip) => (ip == null ? '0.0' : Number(ip).toFixed(1))
const fmtDateLong = (iso) => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })
}
const fmtCell = (v) => {
  if (v == null || v === '') return ''
  if (typeof v === 'string' && v.toUpperCase() === 'X') return 'X'
  return String(v)
}

const imgCache = {}
function loadImage(src) {
  if (!src) return Promise.reject('no-src')
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
const tryLoad = (src) => loadImage(src).catch(() => null)

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
function drawContain(ctx, img, x, y, box) {
  const ar = img.width / img.height
  let dw = box, dh = box
  if (ar > 1) dh = box / ar
  else dw = box * ar
  ctx.drawImage(img, x + (box - dw) / 2, y + (box - dh) / 2, dw, dh)
}
function truncate(ctx, text, maxW) {
  let s = text || ''
  while (s.length > 3 && ctx.measureText(s).width > maxW) s = s.slice(0, -1)
  return s === (text || '') ? s : s.replace(/…?$/, '…')
}

// ── Performer selection (box-score scoring; no per-game WPA) ───
function scoreHitter(b) {
  return (b.h || 0) * 1
       + (b['2b'] || 0) * 1
       + (b['3b'] || 0) * 2
       + (b.hr || 0) * 3
       + (b.bb || 0) * 0.5
       + (b.rbi || 0) * 0.4
       + (b.r  || 0) * 0.3
       - (b.so || 0) * 0.3
}
function scorePitcher(p) {
  const ip = Number(p.ip) || 0
  return ip * 1.2
       - (p.er || 0) * 1.4
       + (p.so || 0) * 0.35
       - (p.bb || 0) * 0.15
       + (p.decision === 'W' ? 2.5 : p.decision === 'S' ? 1.5 : p.decision === 'L' ? -0.2 : 0)
       + (p.is_starter ? 0.4 : 0)
}
function topHitters(rows, sideIsHome, n) {
  return (rows || [])
    .filter(r => r.is_home === sideIsHome && (r.ab || r.bb) && (r.h || r.rbi || r.bb || r.hr))
    .sort((a, b) => scoreHitter(b) - scoreHitter(a))
    .slice(0, n)
}
// Decision pitchers ALWAYS show (W, then SV, then L), then fill with the best
// remaining arms so we never highlight only the decision-makers.
function topPitchers(rows, sideIsHome, n) {
  const mine = (rows || []).filter(r => r.is_home === sideIsHome && (Number(r.ip) || 0) > 0)
  const decRank = { W: 0, S: 1, L: 2 }
  const decs = mine
    .filter(p => p.decision && decRank[p.decision] != null)
    .sort((a, b) => decRank[a.decision] - decRank[b.decision])
  const rest = mine
    .filter(p => !(p.decision && decRank[p.decision] != null))
    .sort((a, b) => scorePitcher(b) - scorePitcher(a))
  return [...decs, ...rest].slice(0, n)
}
function hitterLine(b) {
  if (!b) return ''
  const parts = [`${b.h ?? 0}-${b.ab ?? 0}`]
  if (b.hr) parts.push(`${b.hr} HR`)
  if (b['2b']) parts.push(`${b['2b']} 2B`)
  if (b['3b']) parts.push(`${b['3b']} 3B`)
  if (b.rbi) parts.push(`${b.rbi} RBI`)
  if (b.bb) parts.push(`${b.bb} BB`)
  if (b.sb) parts.push(`${b.sb} SB`)
  return parts.join(', ')
}
function pitcherLine(p) {
  if (!p) return ''
  const parts = [`${fmtIP(p.ip)} IP`, `${p.h || 0} H`, `${p.er || 0} ER`]
  if (p.bb) parts.push(`${p.bb} BB`)
  parts.push(`${p.so || 0} K`)
  return parts.join(', ')
}

// ── Win-probability model ──────────────────────────────────────
// We have no pitch data for summer games, so the curve is MODELED from the
// inning-by-inning line score: after each half-inning we estimate the home
// team's win probability from the run lead and innings remaining, using a
// normal approximation of remaining run-differential. Honest, inning-resolution.
function erf(x) {
  const s = x < 0 ? -1 : 1
  x = Math.abs(x)
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const t = 1 / (1 + p * x)
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
  return s * y
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2))
function weHome(lead, inningsRemaining) {
  if (inningsRemaining <= 0.05) return lead > 0 ? 1 : lead < 0 ? 0 : 0.5
  const sd = 1.65 * Math.sqrt(inningsRemaining) + 0.45
  const z = (lead + (lead === 0 ? 0.2 : 0)) / sd
  return Math.max(0.02, Math.min(0.98, normCdf(z)))
}
function winProbSeries(game) {
  const away = game.away_line_score || []
  const home = game.home_line_score || []
  const N = Math.max(away.length, home.length)
  if (N < 1) return null
  const val = (arr, i) => {
    const v = arr[i]
    if (v == null || v === '') return null
    if (typeof v === 'string' && v.toUpperCase() === 'X') return null
    const n = Number(v)
    return isNaN(n) ? null : n
  }
  const REG = 9
  let aw = 0, hm = 0
  const pts = [{ x: 0, wp: weHome(0, REG) }]
  for (let i = 0; i < N; i++) {
    const inn = i + 1
    const av = val(away, i); if (av != null) aw += av
    let remTop = inn > REG ? 0.4 : Math.max(0, REG - inn) + 0.5
    pts.push({ x: inn - 0.5, wp: weHome(hm - aw, remTop) })
    const hv = val(home, i); if (hv != null) hm += hv
    let remBot = inn > REG ? 0.3 : Math.max(0, REG - inn)
    pts.push({ x: inn, wp: weHome(hm - aw, remBot) })
  }
  const finalWp = (game.home_score ?? 0) > (game.away_score ?? 0) ? 1
                : (game.away_score ?? 0) > (game.home_score ?? 0) ? 0 : 0.5
  pts[pts.length - 1] = { x: pts[pts.length - 1].x, wp: finalWp }
  return { pts, N }
}

// ── Header / score / line-score / footer ───────────────────────
function drawHeader(ctx, dateIso, innings) {
  const grad = ctx.createLinearGradient(0, 0, W, 156)
  grad.addColorStop(0, C.navy)
  grad.addColorStop(0.55, C.blue)
  grad.addColorStop(1, C.gold)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, 156)

  ctx.fillStyle = C.gold_light
  ctx.font = '900 15px -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('WEST COAST LEAGUE · GAME RECAP', 48, 50)

  ctx.fillStyle = '#fff'
  ctx.font = '900 46px -apple-system, sans-serif'
  ctx.fillText(fmtDateLong(dateIso), 48, 106)

  const innTxt = innings && innings !== 9 ? `FINAL · ${innings} INNINGS` : 'FINAL'
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = '700 16px -apple-system, sans-serif'
  ctx.fillText(innTxt, 48, 134)
  return 156
}

async function drawScoreBlock(ctx, game, top) {
  const cx = W / 2
  const logoSize = 120
  const awayWon = (game.away_score ?? 0) > (game.home_score ?? 0)
  const homeWon = (game.home_score ?? 0) > (game.away_score ?? 0)
  const [awayImg, homeImg] = await Promise.all([tryLoad(game.away_logo), tryLoad(game.home_logo)])
  const logoY = top
  const drawLogo = (img, x) => {
    if (img) drawContain(ctx, img, x - logoSize / 2, logoY, logoSize)
    else { ctx.fillStyle = '#e8e4d6'; roundRect(ctx, x - logoSize / 2, logoY, logoSize, logoSize, 12); ctx.fill() }
  }
  drawLogo(awayImg, 180)
  drawLogo(homeImg, W - 180)

  ctx.textAlign = 'center'
  ctx.font = '900 104px -apple-system, sans-serif'
  ctx.fillStyle = awayWon ? C.win : C.loss
  ctx.fillText(String(game.away_score ?? '—'), cx - 108, logoY + 92)
  ctx.fillStyle = homeWon ? C.win : C.loss
  ctx.fillText(String(game.home_score ?? '—'), cx + 108, logoY + 92)
  ctx.fillStyle = C.text_gray
  ctx.font = '700 46px -apple-system, sans-serif'
  ctx.fillText('–', cx, logoY + 82)

  ctx.font = '800 26px -apple-system, sans-serif'
  const nameY = logoY + logoSize + 36
  ctx.fillStyle = awayWon ? C.navy : C.text_muted
  ctx.fillText(truncate(ctx, game.away_short || game.away_team_name || '—', 320), 180, nameY)
  ctx.fillStyle = homeWon ? C.navy : C.text_muted
  ctx.fillText(truncate(ctx, game.home_short || game.home_team_name || '—', 320), W - 180, nameY)
  return nameY + 16
}

function drawLineScore(ctx, game, top) {
  const awayLine = game.away_line_score || []
  const homeLine = game.home_line_score || []
  const innCols = Math.max(awayLine.length, homeLine.length, game.innings || 9)

  const padX = 48
  const cardX = padX
  const cardW = W - padX * 2
  const labelW = 168
  const rheW = 60
  const gridW = cardW - labelW - rheW * 3 - 24
  const colW = gridW / innCols
  const rowH = 48
  const cardH = rowH * 3 + 20

  ctx.fillStyle = C.card
  roundRect(ctx, cardX, top, cardW, cardH, 16)
  ctx.fill()
  ctx.strokeStyle = C.line
  ctx.lineWidth = 1
  ctx.stroke()

  const colX = (i) => cardX + 16 + labelW + i * colW + colW / 2
  const rheX = (k) => cardX + 16 + labelW + gridW + 12 + k * rheW + rheW / 2
  const headY = top + 34
  const r1Y = headY + rowH
  const r2Y = r1Y + rowH

  ctx.textAlign = 'center'
  ctx.font = '800 17px -apple-system, sans-serif'
  ctx.fillStyle = C.text_gray
  for (let i = 0; i < innCols; i++) ctx.fillText(String(i + 1), colX(i), headY)
  ctx.fillStyle = C.navy
  ctx.font = '900 17px -apple-system, sans-serif'
  ;['R', 'H', 'E'].forEach((h, k) => ctx.fillText(h, rheX(k), headY))

  const drawRow = (label, line, r, h, e, y, won) => {
    ctx.textAlign = 'left'
    ctx.font = (won ? '900 ' : '700 ') + '20px -apple-system, sans-serif'
    ctx.fillStyle = won ? C.navy : C.text_muted
    ctx.fillText(truncate(ctx, label || '—', labelW - 6), cardX + 18, y)
    ctx.textAlign = 'center'
    ctx.font = '600 19px -apple-system, sans-serif'
    ctx.fillStyle = C.text
    for (let i = 0; i < innCols; i++) ctx.fillText(fmtCell(line[i]), colX(i), y)
    ctx.font = '900 20px -apple-system, sans-serif'
    ctx.fillStyle = won ? C.navy : C.text
    ctx.fillText(String(r ?? '—'), rheX(0), y)
    ctx.font = '600 19px -apple-system, sans-serif'
    ctx.fillStyle = C.text_muted
    ctx.fillText(String(h ?? '—'), rheX(1), y)
    ctx.fillText(String(e ?? '—'), rheX(2), y)
  }
  const awayWon = (game.away_score ?? 0) > (game.home_score ?? 0)
  const homeWon = (game.home_score ?? 0) > (game.away_score ?? 0)
  drawRow(game.away_short || game.away_team_name, awayLine,
          game.away_score, game.away_hits, game.away_errors, r1Y, awayWon)
  ctx.strokeStyle = 'rgba(0,0,0,0.08)'
  ctx.beginPath(); ctx.moveTo(cardX + 18, r1Y + 14); ctx.lineTo(cardX + cardW - 18, r1Y + 14); ctx.stroke()
  drawRow(game.home_short || game.home_team_name, homeLine,
          game.home_score, game.home_hits, game.home_errors, r2Y, homeWon)
  return top + cardH
}

function sectionTitle(ctx, text, x, baseY) {
  ctx.textAlign = 'left'
  ctx.font = '900 18px -apple-system, sans-serif'
  ctx.fillStyle = C.gold_deep
  ctx.fillText(text, x, baseY)
  const w = ctx.measureText(text).width
  ctx.strokeStyle = 'rgba(169,132,47,0.5)'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(x, baseY + 8); ctx.lineTo(x + w, baseY + 8); ctx.stroke()
}

// ── Win-probability chart (white card with two-tone area) ──────
function drawWinProb(ctx, game, series, top, height) {
  const padX = 48
  const cardX = padX
  const cardW = W - padX * 2
  const cardH = height

  ctx.fillStyle = C.card
  roundRect(ctx, cardX, top, cardW, cardH, 16)
  ctx.fill()
  ctx.strokeStyle = C.line
  ctx.lineWidth = 1
  ctx.stroke()

  sectionTitle(ctx, 'WIN PROBABILITY', cardX + 20, top + 30)

  // Legend (which side is up / down)
  const homeName = game.home_short || game.home_team_name || 'Home'
  const awayName = game.away_short || game.away_team_name || 'Away'
  ctx.textAlign = 'right'
  ctx.font = '800 14px -apple-system, sans-serif'
  const swatch = (label, color, ry) => {
    const tw = ctx.measureText(label).width
    ctx.fillStyle = C.text_muted
    ctx.fillText(label, cardX + cardW - 20, ry)
    ctx.fillStyle = color
    roundRect(ctx, cardX + cardW - 20 - tw - 18, ry - 11, 12, 12, 3)
    ctx.fill()
  }
  swatch(homeName, C.navy, top + 26)
  swatch(awayName, C.gold_deep, top + 46)

  // Plot rect
  const px = cardX + 64
  const py = top + 56
  const pw = cardW - 64 - 24
  const ph = cardH - 56 - 34
  const N = series.N
  const xFor = (inn) => px + (inn / N) * pw
  const yFor = (wp) => py + (1 - wp) * ph
  const yMid = yFor(0.5)

  // y gridlines at 0 / 50 / 100
  ctx.textAlign = 'right'
  ctx.font = '600 12px -apple-system, sans-serif'
  ;[[1, '100%'], [0.5, '50%'], [0, '0%']].forEach(([wp, lbl]) => {
    const gy = yFor(wp)
    ctx.strokeStyle = wp === 0.5 ? 'rgba(20,54,92,0.35)' : 'rgba(0,0,0,0.07)'
    ctx.setLineDash(wp === 0.5 ? [5, 4] : [])
    ctx.beginPath(); ctx.moveTo(px, gy); ctx.lineTo(px + pw, gy); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = C.text_gray
    ctx.fillText(lbl, px - 8, gy + 4)
  })

  const pts = series.pts

  // Two-tone area fill: home color where wp>50 (above mid), away color below.
  const fillRegion = (clampLow, color) => {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(xFor(pts[0].x), yMid)
    pts.forEach(pt => {
      const wp = clampLow ? Math.max(0.5, pt.wp) : Math.min(0.5, pt.wp)
      ctx.lineTo(xFor(pt.x), yFor(wp))
    })
    ctx.lineTo(xFor(pts[pts.length - 1].x), yMid)
    ctx.closePath()
    ctx.fill()
  }
  fillRegion(true, C.homeFill)   // home (above 50)
  fillRegion(false, C.awayFill)  // away (below 50)

  // Curve line
  ctx.strokeStyle = C.navy
  ctx.lineWidth = 3
  ctx.lineJoin = 'round'
  ctx.beginPath()
  pts.forEach((pt, i) => {
    const x = xFor(pt.x), y = yFor(pt.wp)
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  })
  ctx.stroke()

  // End dot
  const last = pts[pts.length - 1]
  ctx.fillStyle = C.navy
  ctx.beginPath(); ctx.arc(xFor(last.x), yFor(last.wp), 5, 0, Math.PI * 2); ctx.fill()

  // x-axis inning labels
  ctx.textAlign = 'center'
  ctx.font = '700 13px -apple-system, sans-serif'
  ctx.fillStyle = C.text_gray
  for (let i = 1; i <= N; i++) ctx.fillText(String(i), xFor(i), py + ph + 22)
  ctx.textAlign = 'left'
  ctx.font = '700 11px -apple-system, sans-serif'
  ctx.fillStyle = C.text_gray
  ctx.fillText('INNING', px, py + ph + 22)
  return top + cardH
}

// ── Top performers (two columns; big hitter + pitcher cards) ───
// Draws a W/L/SV pill centered vertically on `cy` (the name line). Returns the
// horizontal advance so the name can sit just to its right.
function badge(ctx, x, cy, dec) {
  const map = { W: ['W', C.wlW], L: ['L', C.wlL], S: ['SV', C.gold_deep] }
  const m = map[dec]
  if (!m) return 0
  const [label, color] = m
  ctx.font = '900 14px -apple-system, sans-serif'
  const tw = ctx.measureText(label).width
  const bw = tw + 16
  const bh = 22
  ctx.fillStyle = color
  roundRect(ctx, x, cy - bh / 2, bw, bh, 6)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + bw / 2, cy + 1)
  ctx.textBaseline = 'alphabetic'
  return bw + 12
}

function drawPerformerCard(ctx, x, y, w, h, item, accent) {
  ctx.fillStyle = C.card
  roundRect(ctx, x, y, w, h, 12)
  ctx.fill()
  ctx.strokeStyle = C.line
  ctx.lineWidth = 1
  ctx.stroke()
  // left accent stripe
  ctx.fillStyle = accent
  roundRect(ctx, x, y + 10, 5, h - 20, 3)
  ctx.fill()

  const p = item.data
  const nameY = y + h / 2 - 6
  let nx = x + 20
  if (item.kind === 'pitcher' && p.decision) {
    nx += badge(ctx, nx, nameY - 7, p.decision)
  }
  const role = item.kind === 'pitcher'
    ? (p.is_starter ? 'SP' : 'RP')
    : (p.position ? String(p.position).toUpperCase() : '')
  // College / school, shown right-aligned on the name line when known. Clean
  // PNW names come from the spring cross-link, so this naturally flags PNWers.
  const college = p.college || ''
  ctx.font = '700 14px -apple-system, sans-serif'
  const collegeW = college ? ctx.measureText(college).width : 0
  const rightLimit = x + w - 16 - (college ? collegeW + 14 : 0)
  ctx.font = '800 14px -apple-system, sans-serif'
  const roleW = role ? ctx.measureText(role).width : 0

  ctx.textAlign = 'left'
  ctx.font = '900 22px -apple-system, sans-serif'
  ctx.fillStyle = C.navy
  const nameMax = Math.max(40, rightLimit - nx - (role ? roleW + 10 : 0))
  const nm = truncate(ctx, p.player_name || '', nameMax)
  ctx.fillText(nm, nx, nameY)
  if (role) {
    const nw = ctx.measureText(nm).width
    ctx.font = '800 14px -apple-system, sans-serif'
    ctx.fillStyle = C.text_gray
    ctx.fillText(role, nx + nw + 10, nameY)
  }
  if (college) {
    ctx.font = '700 14px -apple-system, sans-serif'
    ctx.fillStyle = C.blue
    ctx.textAlign = 'right'
    ctx.fillText(college, x + w - 16, nameY)
    ctx.textAlign = 'left'
  }
  // stat line
  ctx.font = '600 17px -apple-system, sans-serif'
  ctx.fillStyle = C.text_muted
  const stat = item.kind === 'pitcher' ? pitcherLine(p) : hitterLine(p)
  ctx.fillText(truncate(ctx, stat, w - 26), x + 20, y + h - 18)
}

async function drawPerformers(ctx, game, data, top, bottomLimit) {
  const padX = 48
  sectionTitle(ctx, 'TOP PERFORMERS', padX, top + 22)
  const gridTop = top + 22 + 22

  const colGap = 30
  const colW = (W - padX * 2 - colGap) / 2
  const colX = [padX, padX + colW + colGap]

  const sides = [
    { isHome: false, accent: C.gold_deep, name: game.away_short || game.away_team_name, logo: game.away_logo },
    { isHome: true,  accent: C.navy,      name: game.home_short || game.home_team_name, logo: game.home_logo },
  ]

  // Build per-side performer lists: 3 hitters + 2 pitchers.
  const lists = sides.map(s => {
    const hitters = topHitters(data.batting, s.isHome, 3).map(d => ({ kind: 'hitter', data: d }))
    const pitchers = topPitchers(data.pitching, s.isHome, 2).map(d => ({ kind: 'pitcher', data: d }))
    return [...hitters, ...pitchers]
  })
  const rows = Math.max(1, lists[0].length, lists[1].length)

  const headerH = 40
  const cardsTop = gridTop + headerH
  const avail = bottomLimit - cardsTop
  const cardGap = 10
  const cardH = Math.max(58, Math.min(96, (avail - (rows - 1) * cardGap) / rows))

  const logos = await Promise.all(sides.map(s => tryLoad(s.logo)))

  sides.forEach((s, ci) => {
    const x = colX[ci]
    // team header (mini logo + name)
    const li = logos[ci]
    let hx = x
    if (li) { drawContain(ctx, li, x, gridTop - 4, 30); hx = x + 38 }
    ctx.textAlign = 'left'
    ctx.font = '900 21px -apple-system, sans-serif'
    ctx.fillStyle = s.accent
    ctx.fillText(truncate(ctx, s.name || '—', colW - (hx - x)), hx, gridTop + 20)

    lists[ci].forEach((item, ri) => {
      const cy = cardsTop + ri * (cardH + cardGap)
      drawPerformerCard(ctx, x, cy, colW, cardH, item, s.accent)
    })
  })
}

function drawFooter(ctx) {
  ctx.fillStyle = C.navy_dark
  ctx.fillRect(0, H - 64, W, 64)
  ctx.fillStyle = '#fff'
  ctx.font = '700 16px -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('nwbaseballstats.com/summer', 48, H - 25)
  ctx.font = '500 14px -apple-system, sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.textAlign = 'right'
  ctx.fillText('@nwbaseballstats', W - 48, H - 25)
}

// ── Main renderer (fixed 1080×1350) ────────────────────────────
async function renderGameCard(canvas, data) {
  const game = data.game
  // Prefer the server's PA-by-PA win-probability curve (built from the actual
  // WCL play-by-play events). Fall back to the inning-level line-score model
  // only for games that have no events.
  const sw = data.win_prob
  const series = (sw && Array.isArray(sw.pts) && sw.pts.length > 2)
    ? { pts: sw.pts, N: sw.innings || Math.max(9, ...sw.pts.map(p => Math.ceil(p.x))) }
    : winProbSeries(game)
  const innings = Math.max(
    (game.away_line_score || []).length,
    (game.home_line_score || []).length,
    game.innings || 9,
  )

  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, W, H)

  const HEADER_H = 156
  const FOOTER_H = 64
  const GAP = 24
  const SCORE_H = 120 + 36 + 16
  const LINE_H = 48 * 3 + 20
  const WP_H = series ? 226 : 0

  drawHeader(ctx, game.game_date, innings)
  let y = HEADER_H + GAP
  y = await drawScoreBlock(ctx, game, y) + GAP
  y = drawLineScore(ctx, game, y) + GAP
  if (series) y = drawWinProb(ctx, game, series, y, WP_H) + GAP
  await drawPerformers(ctx, game, data, y, H - FOOTER_H - 18)
  drawFooter(ctx)
}

// ───────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────
export default function WclGameRecapGraphic() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [games, setGames] = useState([])
  const [selectedId, setSelectedId] = useState(searchParams.get('game') || '')
  const [data, setData] = useState(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingGame, setLoadingGame] = useState(false)
  const [error, setError] = useState(null)
  const canvasRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setLoadingList(true)
    ;(async () => {
      try {
        const r = await fetch(`${API_BASE}/summer/scoreboard?league=WCL&season=${CURRENT_SEASON}&days_back=120&days_ahead=3`)
        if (!r.ok) throw new Error(`scoreboard fetch failed: ${r.status}`)
        const all = await r.json()
        const finals = all
          .filter(g => g.status === 'final')
          .sort((a, b) => (b.game_date || '').localeCompare(a.game_date || '') || b.id - a.id)
        if (cancelled) return
        setGames(finals)
        if (!selectedId && finals.length) setSelectedId(String(finals[0].id))
      } catch (e) {
        if (!cancelled) setError(e.message || 'fetch failed')
      } finally {
        if (!cancelled) setLoadingList(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    setLoadingGame(true); setError(null); setData(null)
    ;(async () => {
      try {
        const r = await fetch(`${API_BASE}/summer/games/${selectedId}`)
        if (!r.ok) throw new Error(`game fetch failed: ${r.status}`)
        const d = await r.json()
        if (!cancelled) setData(d)
      } catch (e) {
        if (!cancelled) setError(e.message || 'fetch failed')
      } finally {
        if (!cancelled) setLoadingGame(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedId])

  useEffect(() => {
    if (loadingGame || !data?.game || !canvasRef.current) return
    renderGameCard(canvasRef.current, data).catch(e => setError(e.message))
  }, [loadingGame, data])

  const onPick = (id) => {
    setSelectedId(id)
    setSearchParams(id ? { game: id } : {})
  }

  const download = useCallback(() => {
    if (!canvasRef.current || !data?.game) return
    const g = data.game
    const slug = (s) => (s || 'team').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const a = document.createElement('a')
    a.download = `wcl-game-${slug(g.away_short || g.away_team_name)}-${slug(g.home_short || g.home_team_name)}-${g.game_date}.png`
    a.href = canvasRef.current.toDataURL('image/png')
    a.click()
  }, [data])

  const label = (g) => {
    const a = g.away_short || g.away_team_name || '?'
    const h = g.home_short || g.home_team_name || '?'
    return `${g.game_date} · ${a} ${g.away_score}-${g.home_score} ${h}`
  }

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4">
      <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">WCL Game Recap Graphic</h1>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Pick any final WCL game and download a share-ready 1080×1350 (Instagram) card with the full line score, a play-by-play win-probability chart, and each side's top performers (hitters and pitchers).
      </p>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="min-w-[260px]">
          <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">Game</label>
          <select
            value={selectedId}
            onChange={e => onPick(e.target.value)}
            disabled={loadingList || !games.length}
            className="w-full px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100"
          >
            {!games.length && <option value="">No final games yet</option>}
            {games.map(g => (
              <option key={g.id} value={g.id}>{label(g)}</option>
            ))}
          </select>
        </div>
        <button
          disabled={!data?.game || loadingGame}
          onClick={download}
          className="px-4 py-1.5 text-sm font-bold rounded bg-nw-teal text-white hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Download PNG
        </button>
      </div>

      {loadingList && <div className="text-sm text-gray-500 dark:text-gray-400">Loading games…</div>}
      {loadingGame && <div className="text-sm text-gray-500 dark:text-gray-400">Rendering recap…</div>}
      {error && <div className="text-sm text-rose-600 dark:text-rose-400">Error: {error}</div>}

      <div className="overflow-auto bg-white dark:bg-gray-900 rounded-md border border-gray-200 dark:border-gray-700 p-2">
        <canvas
          ref={canvasRef}
          style={{ maxWidth: '100%', height: 'auto', display: data?.game ? 'block' : 'none' }}
        />
      </div>
    </div>
  )
}
