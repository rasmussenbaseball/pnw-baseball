// TeamSeasonRecapGraphic — /team-season-recap
//
// End-of-year, positive-only team snapshot for Instagram/X. Fixed
// 1080x1350 (IG 4:5) PNG. Theme is pulled from each team's logo (a
// dominant accent color drives the header, tinted background, and
// accents), logos render full (no circle crop), and the content fills
// the canvas via a proportional middle layout so there's no dead space.
// Data from /teams/{id}/season-recap (PNW teams only — /teams already
// filters to WA/OR/ID/MT/BC).

import { useState, useRef, useCallback, useEffect } from 'react'
import { CURRENT_SEASON } from '../lib/seasons'

const API_BASE = '/api/v1'
const W = 1080
const H = 1350

// ── Color helpers ──────────────────────────────────────────────
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))
const rgbStr = (c) => `rgb(${clamp(c[0])},${clamp(c[1])},${clamp(c[2])})`
const lum = (c) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const darkenTo = (c, target) => { const l = lum(c); return l > target && l > 0 ? c.map(x => x * (target / l)) : c.slice() }
const lightenTo = (c, target) => { const l = lum(c); return l < target ? mix(c, [255, 255, 255], (target - l) / (1 - l)) : c.slice() }
const TEAL = [14, 116, 144]

// Sample the logo for a dominant, saturated color. Returns [r,g,b] or null.
function extractAccent(img) {
  try {
    const s = 48
    const cv = document.createElement('canvas'); cv.width = s; cv.height = s
    const cx = cv.getContext('2d', { willReadFrequently: true })
    cx.drawImage(img, 0, 0, s, s)
    const data = cx.getImageData(0, 0, s, s).data
    const buckets = {}
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
      if (a < 130) continue
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
      const l = (r + g + b) / 3
      if (l > 235 || l < 18) continue          // skip white / black
      const key = `${r >> 5},${g >> 5},${b >> 5}`
      const sat = mx - mn
      const bk = buckets[key] || (buckets[key] = { r: 0, g: 0, b: 0, n: 0, sat: 0 })
      bk.r += r; bk.g += g; bk.b += b; bk.n++; bk.sat += sat
    }
    const arr = Object.values(buckets).map(b => ({
      c: [b.r / b.n, b.g / b.n, b.b / b.n], n: b.n, sat: b.sat / b.n,
    }))
    if (!arr.length) return null
    // Favor frequent + saturated colors.
    arr.sort((a, b) => (b.n * (b.sat + 25)) - (a.n * (a.sat + 25)))
    const top = arr[0]
    if (top.sat < 22) return null   // basically grayscale logo → use default
    return top.c
  } catch {
    return null
  }
}

function buildTheme(logoImg) {
  const base = extractAccent(logoImg) || TEAL
  const header = darkenTo(base, 0.30)               // dark, legible behind white text
  const headerLite = lightenTo(header, 0.46)
  const onWhite = darkenTo(base, 0.42)              // accent legible on white
  const fill = darkenTo(base, 0.40)                 // pills / bars
  const tint = mix(base, [248, 250, 252], 0.93)     // very light team-tinted page bg
  return {
    headerStart: rgbStr(darkenTo(header, 0.24)),
    headerEnd: rgbStr(headerLite),
    headerText: '#ffffff',
    headerSub: 'rgba(255,255,255,0.82)',
    accent: rgbStr(onWhite),
    fill: rgbStr(fill),
    bg: rgbStr(tint),
    card: '#ffffff',
    cardBorder: `rgba(${clamp(header[0])},${clamp(header[1])},${clamp(header[2])},0.16)`,
    slate: '#1e293b',
    muted: '#64748b',
    faint: '#94a3b8',
  }
}

// ── Format helpers ─────────────────────────────────────────────
function cleanTeamName(name) {
  if (!name) return '???'
  let n = name.trim().replace(/^(?:No\.\s*\d+\s+|#\d+\s+|\(\d+\))\s+/i, '')
  n = n.replace(/(?<=[a-zA-Z])(\d+)$/, '')
  return n.trim() || '???'
}
const fmtAvg = (v) => v == null ? '.000' : Number(v).toFixed(3).replace(/^0/, '')
const fmtEra = (v) => v == null ? '-.--' : Number(v).toFixed(2)
const fmtPct = (v, d = 1) => v == null ? '-' : Number(v).toFixed(d) + '%'
const fmtIp = (v) => v == null ? '0.0' : Number(v).toFixed(1)
const fmtWar = (v) => v == null ? '0.0' : Number(v).toFixed(1)
const shortDate = (iso) => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
function basesText(b) {
  if (!b) return 'bases empty'
  const on = []
  if (b[0] === '1') on.push('1st'); if (b[1] === '1') on.push('2nd'); if (b[2] === '1') on.push('3rd')
  if (on.length === 3) return 'bases loaded'
  if (!on.length) return 'bases empty'
  return on.join(' & ')
}

function resolveImageUrl(url) {
  if (!url) return url
  if (url.startsWith('data:') || url.startsWith('/') || url.startsWith('blob:')) return url
  if (/^https?:\/\//i.test(url)) return `${API_BASE}/proxy-image?url=${encodeURIComponent(url)}`
  return url
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
const tryLoad = (src) => loadImage(resolveImageUrl(src)).catch(() => null)

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}
function truncate(ctx, text, maxW) {
  let s = text || ''
  if (ctx.measureText(s).width <= maxW) return s
  while (s.length > 3 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1)
  return s + '…'
}
// Full logo, aspect preserved (no crop), centered in box.
function drawContain(ctx, img, x, y, w, h, pad = 0) {
  if (!img) return
  const bw = w - pad * 2, bh = h - pad * 2
  const ar = img.width / img.height
  let dw = bw, dh = bh
  if (bw / bh > ar) dw = bh * ar; else dh = bw / ar
  ctx.drawImage(img, x + pad + (bw - dw) / 2, y + pad + (bh - dh) / 2, dw, dh)
}
// White rounded tile (so transparent logos read on colored cards) + full logo.
function drawLogoTile(ctx, img, cx, cy, size, theme) {
  const x = cx - size / 2, y = cy - size / 2
  ctx.fillStyle = '#ffffff'
  roundRect(ctx, x, y, size, size, 12); ctx.fill()
  ctx.strokeStyle = theme.cardBorder; ctx.lineWidth = 1; ctx.stroke()
  if (img) drawContain(ctx, img, x, y, size, size, size * 0.12)
  else {
    ctx.fillStyle = '#e2e8f0'; roundRect(ctx, x, y, size, size, 12); ctx.fill()
  }
}

function card(ctx, theme, x, y, w, h) {
  ctx.fillStyle = theme.card; roundRect(ctx, x, y, w, h, 16); ctx.fill()
  ctx.strokeStyle = theme.cardBorder; ctx.lineWidth = 1; ctx.stroke()
  // team-color accent bar on the left edge
  ctx.save(); roundRect(ctx, x, y, w, h, 16); ctx.clip()
  ctx.fillStyle = theme.fill; ctx.fillRect(x, y, 6, h)
  ctx.restore()
}

// ── Sections ───────────────────────────────────────────────────
function drawHeader(ctx, theme, data, logo) {
  const t = data.team
  const HH = 250
  const grad = ctx.createLinearGradient(0, 0, W, HH)
  grad.addColorStop(0, theme.headerStart); grad.addColorStop(1, theme.headerEnd)
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, HH)

  // Full logo on a white tile (no crop)
  drawLogoTile(ctx, logo, 48 + 78, 50 + 78, 156, theme)

  // Conference badge (top-right)
  const place = (data.record || {}).conference_place_ordinal
  const confShort = t.conference_abbrev || ''
  let nameRight = W - 48
  if (place) {
    const bw = 188, bh = 96, bx = W - 48 - bw, by = 48
    ctx.fillStyle = 'rgba(255,255,255,0.16)'; roundRect(ctx, bx, by, bw, bh, 14); ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.30)'; ctx.lineWidth = 1; ctx.stroke()
    ctx.textAlign = 'center'
    ctx.fillStyle = '#fff'; ctx.font = '900 42px -apple-system, sans-serif'
    ctx.fillText(String(place).toUpperCase(), bx + bw / 2, by + 52)
    if (confShort) {
      ctx.fillStyle = theme.headerSub; ctx.font = '800 13px -apple-system, sans-serif'
      ctx.fillText(`IN ${confShort}`, bx + bw / 2, by + 78)
    }
    nameRight = bx - 22
  }

  const tx = 232
  ctx.textAlign = 'left'
  ctx.fillStyle = theme.headerSub; ctx.font = '900 17px -apple-system, sans-serif'
  ctx.fillText(`${data.season} SEASON IN REVIEW`, tx, 82)
  // team name, auto-fit
  let fs = 60
  ctx.fillStyle = theme.headerText
  const nm = cleanTeamName(t.name)
  do { ctx.font = `900 ${fs}px -apple-system, sans-serif`; fs -= 3 }
  while (ctx.measureText(nm).width > (nameRight - tx) && fs > 30)
  ctx.fillText(nm, tx, 142)
  ctx.fillStyle = theme.headerSub; ctx.font = '600 21px -apple-system, sans-serif'
  const lvl = t.division_level ? (/^\d+$/.test(String(t.division_level)) ? `NCAA D${t.division_level}` : String(t.division_level)) : ''
  ctx.fillText([lvl, t.conference_name].filter(Boolean).join('  ·  '), tx, 178)
  return HH
}

function drawRecordStreak(ctx, theme, data, y) {
  const rec = data.record || {}
  const pad = 40, gap = 16, h = 104
  const bw = (W - pad * 2 - gap) / 2
  const boxes = [
    { label: 'RECORD', big: `${rec.wins ?? 0}-${rec.losses ?? 0}`,
      sub: rec.conference_wins != null ? `${rec.conference_wins}-${rec.conference_losses} ${data.team.conference_abbrev || ''}` : '' },
    { label: 'LONGEST WIN STREAK', big: `${data.longest_win_streak ?? 0}`,
      sub: (data.longest_win_streak === 1 ? 'game' : 'games') + ' in a row' },
  ]
  boxes.forEach((b, i) => {
    const x = pad + i * (bw + gap)
    card(ctx, theme, x, y, bw, h)
    ctx.textAlign = 'left'
    ctx.fillStyle = theme.accent; ctx.font = '800 13px -apple-system, sans-serif'
    ctx.fillText(b.label, x + 22, y + 30)
    ctx.fillStyle = theme.slate; ctx.font = '900 42px -apple-system, sans-serif'
    ctx.fillText(b.big, x + 22, y + 76)
    ctx.fillStyle = theme.muted; ctx.font = '600 15px -apple-system, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(b.sub, x + bw - 22, y + 70)
  })
  return h
}

function statTable(ctx, theme, x, yVal, w, cols) {
  const cw = w / cols.length
  cols.forEach((c, i) => {
    const cx = x + i * cw + cw / 2
    ctx.textAlign = 'center'
    ctx.fillStyle = theme.slate; ctx.font = '800 23px -apple-system, sans-serif'
    ctx.fillText(c.v, cx, yVal)
    ctx.fillStyle = theme.faint; ctx.font = '700 12px -apple-system, sans-serif'
    ctx.fillText(c.l, cx, yVal + 19)
  })
}
const hitterCols = (p) => [
  { l: 'AVG', v: fmtAvg(p.avg) }, { l: 'OBP', v: fmtAvg(p.obp) }, { l: 'SLG', v: fmtAvg(p.slg) },
  { l: 'wOBA', v: fmtAvg(p.woba) }, { l: 'wRC+', v: p.wrc_plus != null ? String(Math.round(p.wrc_plus)) : '-' },
  { l: 'HR', v: String(p.hr ?? 0) }, { l: 'RBI', v: String(p.rbi ?? 0) }, { l: 'SB', v: String(p.sb ?? 0) },
]
const pitcherCols = (p) => [
  { l: 'ERA', v: fmtEra(p.era) }, { l: 'SIERA', v: fmtEra(p.siera) }, { l: 'FIP', v: fmtEra(p.fip) },
  { l: 'WHIP', v: fmtEra(p.whip) }, { l: 'K', v: String(p.k ?? 0) }, { l: 'BB', v: String(p.bb ?? 0) },
  { l: 'K%', v: fmtPct(p.k_pct) }, { l: 'BAA', v: fmtAvg(p.baa) },
]

function makePlayerCard(label, player, kind) {
  return (ctx, theme, x, y, w, h, logo) => {
    card(ctx, theme, x, y, w, h)
    const pad = 26
    // section label
    ctx.textAlign = 'left'
    ctx.fillStyle = theme.accent; ctx.font = '900 14px -apple-system, sans-serif'
    ctx.fillText(label, x + pad, y + 28)
    // logo tile (full, no crop) + name — top-anchored
    const tile = 60
    drawLogoTile(ctx, player._img || logo, x + pad + tile / 2, y + 44 + tile / 2, tile, theme)
    const nx = x + pad + tile + 18
    ctx.fillStyle = theme.slate; ctx.font = '800 30px -apple-system, sans-serif'
    const nm = truncate(ctx, `${player.first_name} ${player.last_name}`, w - (nx - x) - 160)
    ctx.fillText(nm, nx, y + 66)
    const vol = kind === 'hitter' ? `${player.pa ?? 0} PA` : `${fmtIp(player.ip)} IP`
    const tag = [player.year_in_school, (player.position || '').toUpperCase(), vol].filter(Boolean).join(' · ')
    ctx.fillStyle = theme.muted; ctx.font = '600 15px -apple-system, sans-serif'
    ctx.fillText(tag, nx, y + 90)
    // big WAR (top-right)
    ctx.textAlign = 'right'
    ctx.fillStyle = theme.accent; ctx.font = '900 50px -apple-system, sans-serif'
    ctx.fillText(fmtWar(player.war), x + w - pad, y + 72)
    ctx.fillStyle = theme.faint; ctx.font = '800 14px -apple-system, sans-serif'
    ctx.fillText('WAR', x + w - pad, y + 92)
    // full stat table — bottom-anchored so it never crowds the name
    ctx.strokeStyle = 'rgba(0,0,0,0.07)'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x + pad, y + h - 58); ctx.lineTo(x + w - pad, y + h - 58); ctx.stroke()
    statTable(ctx, theme, x + pad, y + h - 30, w - pad * 2,
              kind === 'hitter' ? hitterCols(player) : pitcherCols(player))
  }
}

function makeLeaders(leaders) {
  // Ordered candidates; show up to 6 present in one compressed row.
  const items = [
    ['AVG', leaders.avg], ['HR', leaders.hr], ['RBI', leaders.rbi], ['SB', leaders.sb],
    ['K', leaders.k], ['SV', leaders.sv], ['ERA', leaders.era], ['R', leaders.r], ['W', leaders.w],
  ].filter(([, v]) => v).slice(0, 6)
  return (ctx, theme, x, y, w, h) => {
    card(ctx, theme, x, y, w, h)
    ctx.textAlign = 'left'
    ctx.fillStyle = theme.accent; ctx.font = '900 14px -apple-system, sans-serif'
    ctx.fillText('TEAM LEADERS', x + 26, y + 28)
    if (!items.length) return
    const cellW = w / items.length
    const vfs = items.length >= 6 ? 30 : items.length >= 5 ? 33 : 38
    items.forEach(([label, v], i) => {
      const cx = x + i * cellW + cellW / 2
      ctx.textAlign = 'center'
      // bottom-anchored so the player name never spills past the card
      ctx.fillStyle = theme.slate; ctx.font = `900 ${vfs}px -apple-system, sans-serif`
      ctx.fillText(v.display, cx, y + h - 50)
      ctx.fillStyle = theme.accent; ctx.font = '800 14px -apple-system, sans-serif'
      ctx.fillText(label, cx, y + h - 30)
      ctx.fillStyle = theme.muted; ctx.font = '500 13px -apple-system, sans-serif'
      ctx.fillText(truncate(ctx, v.name, cellW - 16), cx, y + h - 13)
    })
    ctx.strokeStyle = 'rgba(0,0,0,0.06)'
    for (let i = 1; i < items.length; i++) {
      const dx = x + i * cellW
      ctx.beginPath(); ctx.moveTo(dx, y + 44); ctx.lineTo(dx, y + h - 18); ctx.stroke()
    }
  }
}

function wrapLines(ctx, text, maxW, maxLines) {
  const words = (text || '').split(' ')
  const lines = []; let cur = ''
  for (const wd of words) {
    const t = cur ? cur + ' ' + wd : wd
    if (ctx.measureText(t).width <= maxW) cur = t
    else { if (cur) lines.push(cur); cur = wd; if (lines.length >= maxLines) return null }
  }
  if (cur) lines.push(cur)
  return lines.length <= maxLines ? lines : null
}
// Superlative + Signature Win share one band (side by side) to save height.
function makeSuperSig(sup, sw) {
  return (ctx, theme, x, y, w, h) => {
    const gap = 16
    const both = sup && sw
    const halfW = both ? (w - gap) / 2 : w
    if (sup) {
      ctx.fillStyle = theme.fill; roundRect(ctx, x, y, halfW, h, 16); ctx.fill()
      ctx.textAlign = 'left'
      ctx.fillStyle = 'rgba(255,255,255,0.80)'; ctx.font = '900 12px -apple-system, sans-serif'
      ctx.fillText('THEY EXCELLED AT', x + 20, y + 26)
      ctx.fillStyle = '#fff'
      // fit to ≤2 lines, then vertically center in the area below the label
      const top = y + 40, bot = y + h - 16
      let placed = false
      for (let fs = both ? 21 : 25; fs >= 13 && !placed; fs--) {
        ctx.font = `700 ${fs}px -apple-system, sans-serif`
        const lines = wrapLines(ctx, sup.text, halfW - 40, 2)
        const lh = fs + 6
        if (lines && lines.length * lh <= (bot - top)) {
          const startY = top + ((bot - top) - lines.length * lh) / 2 + fs
          lines.forEach((ln, i) => ctx.fillText(ln, x + 20, startY + i * lh))
          placed = true
        }
      }
      if (!placed) {
        ctx.font = '700 13px -apple-system, sans-serif'
        ctx.fillText(truncate(ctx, sup.text, halfW - 40), x + 20, (top + bot) / 2 + 5)
      }
    }
    if (sw) {
      const sx = sup ? x + halfW + gap : x
      card(ctx, theme, sx, y, halfW, h)
      ctx.textAlign = 'left'
      ctx.fillStyle = theme.accent; ctx.font = '900 12px -apple-system, sans-serif'
      ctx.fillText('SIGNATURE WIN', sx + 20, y + 26)
      const rk = sw.opponent_rank ? `#${Math.round(sw.opponent_rank)} ` : ''
      const main = `${sw.team_score}-${sw.opp_score}  ${sw.home_away} ${rk}${sw.opponent_short || sw.opponent_name || ''}`
      ctx.fillStyle = theme.slate; ctx.font = '800 23px -apple-system, sans-serif'
      ctx.fillText(truncate(ctx, main, halfW - 40), sx + 20, y + 58)
      ctx.fillStyle = theme.muted; ctx.font = '600 14px -apple-system, sans-serif'
      ctx.fillText(shortDate(sw.game_date), sx + 20, y + h - 16)
    }
  }
}

function makeClutch(cm) {
  return (ctx, theme, x, y, w, h) => {
    card(ctx, theme, x, y, w, h)
    ctx.textAlign = 'left'
    ctx.fillStyle = theme.accent; ctx.font = '900 14px -apple-system, sans-serif'
    ctx.fillText('MOST CLUTCH MOMENT', x + 24, y + 30)
    // WPA pill
    const wpa = cm.wpa != null ? `+${cm.wpa.toFixed(2)}` : ''
    ctx.fillStyle = theme.fill; roundRect(ctx, x + 24, y + 46, 96, 42, 9); ctx.fill()
    ctx.fillStyle = '#fff'; ctx.font = '900 23px -apple-system, sans-serif'
    ctx.textAlign = 'center'; ctx.fillText(wpa, x + 24 + 48, y + 74)
    ctx.textAlign = 'left'
    const hx = x + 138
    ctx.fillStyle = theme.slate; ctx.font = '800 24px -apple-system, sans-serif'
    ctx.fillText(truncate(ctx, `${cm.batter_name} ${(cm.result_type || '').replace(/_/g, ' ')}`, w - 160), hx, y + 66)
    const lead = (cm.bat_score_before ?? 0) - (cm.fld_score_before ?? 0)
    const leadTxt = lead === 0 ? 'tied' : lead > 0 ? `up ${lead}` : `down ${-lead}`
    const sit = [`${cm.half === 'bottom' ? 'B' : 'T'}${cm.inning}`, `${leadTxt} (${cm.bat_score_before}-${cm.fld_score_before})`,
      basesText(cm.bases_before), `${cm.outs_before} out`, `${cm.home_away} ${cm.opponent_short || ''}`, shortDate(cm.game_date)]
      .filter(Boolean).join('   ·   ')
    ctx.fillStyle = theme.muted; ctx.font = '500 14px -apple-system, sans-serif'
    ctx.fillText(truncate(ctx, sit, w - 160), hx, y + 90)
    // narrative + win-prob — bottom-anchored so they never touch the border
    ctx.fillStyle = '#334155'; ctx.font = 'italic 500 15px -apple-system, sans-serif'
    ctx.fillText(truncate(ctx, `"${cm.result_text || ''}"`, w - 48), x + 24, y + h - 36)
    if (cm.wp_before != null && cm.wp_after != null) {
      ctx.fillStyle = theme.slate; ctx.font = '700 15px -apple-system, sans-serif'
      ctx.fillText(`Win probability swung from ${Math.round(cm.wp_before * 100)}% to ${Math.round(cm.wp_after * 100)}%`, x + 24, y + h - 14)
    }
  }
}

function drawFooter(ctx, theme) {
  const fh = 66
  ctx.fillStyle = theme.headerStart; ctx.fillRect(0, H - fh, W, fh)
  ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.font = '700 16px -apple-system, sans-serif'
  ctx.fillText('nwbaseballstats.com', 40, H - 26)
  ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.72)'; ctx.font = '500 14px -apple-system, sans-serif'
  ctx.fillText('@nwbaseballstats', W - 40, H - 26)
}

// ── Main renderer (fixed 1080x1350, proportional middle fill) ──
async function renderRecap(canvas, data) {
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')

  const logo = await tryLoad(data.team.logo_url)
  const theme = buildTheme(logo)

  // preload headshots for the player cards (fall back to team logo)
  const prep = async (p) => { if (p) p._img = await tryLoad(p.headshot_url) }
  await Promise.all([prep(data.best_hitter), prep(data.best_pitcher), prep(data.freshman_of_year), prep(data.transfer_of_year)])

  ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, W, H)

  const headerH = drawHeader(ctx, theme, data, logo)
  let y = headerH + 18
  const recH = drawRecordStreak(ctx, theme, data, y)
  y += recH + 18
  drawFooter(ctx, theme)

  // Build the present middle sections with relative weights (≈ natural
  // heights). Player cards carry a full stat table so they're tallest.
  const sections = []
  if (data.best_hitter) sections.push({ wt: 1.65, draw: (c, th, x, yy, w, h) => makePlayerCard('BEST HITTER', data.best_hitter, 'hitter')(c, th, x, yy, w, h, logo) })
  if (data.best_pitcher) sections.push({ wt: 1.65, draw: (c, th, x, yy, w, h) => makePlayerCard('BEST PITCHER', data.best_pitcher, 'pitcher')(c, th, x, yy, w, h, logo) })
  if (data.freshman_of_year) {
    const fr = data.freshman_of_year
    sections.push({ wt: 1.65, draw: (c, th, x, yy, w, h) => makePlayerCard('FRESHMAN OF THE YEAR', fr, fr.kind)(c, th, x, yy, w, h, logo) })
  } else if (data.transfer_of_year) {
    const tr = data.transfer_of_year
    sections.push({ wt: 1.65, draw: (c, th, x, yy, w, h) => makePlayerCard('TRANSFER OF THE YEAR', tr, tr.kind)(c, th, x, yy, w, h, logo) })
  }
  const tl = data.team_leaders || {}
  if (tl.avg || tl.hr || tl.rbi || tl.sb || tl.r || tl.w || tl.k || tl.sv || tl.era)
    sections.push({ wt: 1.15, draw: makeLeaders(tl) })
  if (data.superlative || data.signature_win) sections.push({ wt: 1.1, draw: makeSuperSig(data.superlative, data.signature_win) })
  if (data.clutch_moment) sections.push({ wt: 1.6, draw: makeClutch(data.clutch_moment) })

  const midTop = y
  const midBottom = H - 66 - 16
  const gap = 14
  const totalGap = gap * Math.max(0, sections.length - 1)
  const sumWt = sections.reduce((s, x) => s + x.wt, 0) || 1
  const unit = (midBottom - midTop - totalGap) / sumWt
  let cy = midTop
  for (const s of sections) {
    const h = unit * s.wt
    s.draw(ctx, theme, 40, cy, W - 80, h)
    cy += h + gap
  }
}

// ───────────────────────────────────────────────────────────────
export default function TeamSeasonRecapGraphic() {
  const [teams, setTeams] = useState([])
  const [selectedTeamId, setSelectedTeamId] = useState('')
  const [season, setSeason] = useState(CURRENT_SEASON)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [rendered, setRendered] = useState(false)
  const canvasRef = useRef(null)

  useEffect(() => {
    // /teams already returns PNW teams only (WA/OR/ID/MT/BC) — no CA opponents.
    fetch(`${API_BASE}/teams`)
      .then(r => r.json())
      .then(d => {
        const arr = Array.isArray(d) ? d : (d.teams || [])
        setTeams(arr.slice().sort((a, b) =>
          cleanTeamName(a.name || a.short_name).localeCompare(cleanTeamName(b.name || b.short_name))))
      })
      .catch(e => setError(String(e)))
  }, [])

  useEffect(() => {
    if (!selectedTeamId) { setData(null); return }
    setLoading(true); setError(null)
    fetch(`${API_BASE}/teams/${selectedTeamId}/season-recap?season=${season}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(d => setData(d))
      .catch(e => { setError(String(e)); setData(null) })
      .finally(() => setLoading(false))
  }, [selectedTeamId, season])

  const generate = useCallback(async () => {
    if (!data || !canvasRef.current) return
    try { await renderRecap(canvasRef.current, data); setRendered(true) }
    catch (e) { setError(String(e)) }
  }, [data])

  useEffect(() => { if (data) generate(); else setRendered(false) }, [data, generate])

  const download = () => {
    if (!canvasRef.current || !data) return
    const slug = cleanTeamName(data.team.name).replace(/\s+/g, '-').toLowerCase()
    const a = document.createElement('a')
    a.download = `season-recap-${slug}-${season}.png`
    a.href = canvasRef.current.toDataURL('image/png')
    a.click()
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">Team Season Recap Graphic</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        End-of-year, positive-only team snapshot for Instagram/X (1080×1350). Team-colored, with record, win streak,
        WAR leaders, freshman of the year, a conference superlative, and the season's most clutch moment.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={selectedTeamId}
          onChange={(e) => setSelectedTeamId(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal min-w-[260px]"
        >
          <option value="">Select a team...</option>
          {teams.map(t => {
            const lvl = t.division_level
            const label = lvl ? (/^\d+$/.test(String(lvl)) ? `D${lvl}` : String(lvl)) : ''
            return (
              <option key={t.id} value={t.id}>
                {cleanTeamName(t.name || t.short_name)}{label ? ` (${label})` : ''}
              </option>
            )
          })}
        </select>
        <select
          value={season}
          onChange={(e) => setSeason(Number(e.target.value))}
          className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal"
        >
          {[2026, 2025, 2024].map(y => <option key={y} value={y}>{y}</option>)}
        </select>

        {rendered && (
          <button
            onClick={download}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-nw-teal hover:bg-nw-teal/90 transition-colors"
          >
            Download PNG
          </button>
        )}
      </div>

      {loading && <p className="text-sm text-gray-400 mb-4">Loading team season…</p>}
      {error && <p className="text-sm text-red-500 mb-4">Error: {error}</p>}
      {!selectedTeamId && !loading && (
        <p className="text-sm text-gray-400 mb-4">Pick a PNW team above to build the recap.</p>
      )}

      <div className="rounded-lg overflow-hidden shadow-lg border border-gray-200 dark:border-gray-700 inline-block">
        <canvas
          ref={canvasRef}
          style={{ width: '100%', maxWidth: 432, height: 'auto', display: data ? 'block' : 'none' }}
        />
      </div>
    </div>
  )
}
