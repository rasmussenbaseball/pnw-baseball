import { useState, useCallback, useRef, useEffect } from 'react'
import { useApi } from '../hooks/useApi'

// ─── Conference options (mirrors AllConferenceGenerator) ───
const CONF_OPTIONS = [
  { value: 'gnac', label: 'GNAC (D2)', group: 'Conference' },
  { value: 'nwc', label: 'NWC (D3)', group: 'Conference' },
  { value: 'ccc', label: 'CCC (NAIA)', group: 'Conference' },
  { value: 'nwac-east', label: 'NWAC East', group: 'NWAC' },
  { value: 'nwac-north', label: 'NWAC North', group: 'NWAC' },
  { value: 'nwac-south', label: 'NWAC South', group: 'NWAC' },
  { value: 'nwac-west', label: 'NWAC West', group: 'NWAC' },
  { value: 'all-nwac', label: 'All-NWAC', group: 'Combined' },
  { value: 'all-pnw', label: 'All-PNW', group: 'Combined' },
]

// Position slots (same order as AllConferenceGenerator)
const HITTER_SLOTS = ['C', '1B', '2B', '3B', 'SS', 'OF1', 'OF2', 'OF3', 'DH', 'UTIL']
const PITCHER_SLOTS = ['SP1', 'SP2', 'SP3', 'SP4', 'RP']
const HM_CATEGORIES = [
  { key: 'C', label: 'C' },
  { key: '1B', label: '1B' },
  { key: '2B', label: '2B' },
  { key: '3B', label: '3B' },
  { key: 'SS', label: 'SS' },
  { key: 'OF', label: 'OF' },
  { key: 'DH', label: 'DH' },
  { key: 'UTIL', label: 'UTIL' },
  { key: 'SP', label: 'SP' },
  { key: 'RP', label: 'RP' },
]

// ─── Theme (matches ConferenceStandingsGraphic) ───
const THEME = {
  bg1: '#0a1628',
  bg2: '#0f2744',
  bg3: '#00687a',
  accent: '#7dd3fc',
  accentGlow: 'rgba(125,211,252,0.3)',
  accentSoft: 'rgba(125,211,252,0.12)',
  accentBorder: 'rgba(125,211,252,0.35)',
  textPrimary: '#ffffff',
  textSecondary: 'rgba(255,255,255,0.55)',
  textMuted: 'rgba(255,255,255,0.3)',
  border: 'rgba(255,255,255,0.08)',
  cardBg: 'rgba(255,255,255,0.04)',
  cardBorder: 'rgba(255,255,255,0.1)',
  circleBg: 'rgba(255,255,255,0.08)',
}

// ─── Canvas utilities ───
async function loadExportImage(src) {
  if (!src) return null
  const isExternal = src.startsWith('http') && !src.includes(window.location.hostname)
  const url = isExternal
    ? `/api/v1/proxy-image?url=${encodeURIComponent(src)}`
    : src.startsWith('/') ? src : src
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const blob = await resp.blob()
    const objectUrl = URL.createObjectURL(blob)
    return await new Promise((resolve) => {
      const img = new Image()
      img.onload = () => { resolve(img); URL.revokeObjectURL(objectUrl) }
      img.onerror = () => { resolve(null); URL.revokeObjectURL(objectUrl) }
      img.src = objectUrl
    })
  } catch { return null }
}

function drawImageContain(ctx, img, x, y, boxW, boxH) {
  if (!img) return
  const scale = Math.min(boxW / img.width, boxH / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, x + (boxW - dw) / 2, y + (boxH - dh) / 2, dw, dh)
}

function drawImageCover(ctx, img, cx, cy, r) {
  if (!img) return
  const size = r * 2
  const scale = Math.max(size / img.width, size / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()
  ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh)
  ctx.restore()
}

function truncText(ctx, text, maxW) {
  if (!text) return ''
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 0 && ctx.measureText(t + '...').width > maxW) t = t.slice(0, -1)
  return t + '...'
}

function roundRect(ctx, x, y, w, h, r) {
  if (w < 2 * r) r = w / 2
  if (h < 2 * r) r = h / 2
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// ─── Formatters ───
function fmtAvg(v) {
  if (v === null || v === undefined) return '-'
  return Number(v).toFixed(3).replace(/^0/, '')
}
function fmtInt(v) {
  if (v === null || v === undefined) return '-'
  return String(Math.round(v))
}
function fmtFloat(v, d = 2) {
  if (v === null || v === undefined) return '-'
  return Number(v).toFixed(d)
}
function fmtIp(v) {
  if (v === null || v === undefined) return '-'
  return Number(v).toFixed(1)
}
function fmtWar(v) {
  if (v === null || v === undefined) return '-'
  return Number(v).toFixed(2)
}
function fmtWarRate(v) {
  if (v === null || v === undefined) return '-'
  return Number(v).toFixed(3)
}
function fmtPct(v) {
  // backend stores k_pct/bb_pct as a fraction (0.24 = 24%)
  if (v === null || v === undefined) return '-'
  return `${(Number(v) * 100).toFixed(1)}%`
}

function isNwac(player) {
  return player?.division_level === 'JUCO'
}

// Collapse OF1/OF2/OF3 → "OF" and SP1/SP2/SP3/SP4 → "SP".
// All other slot labels (C, 1B, UTIL, DH, RP, etc.) pass through unchanged.
function displaySlot(slot) {
  if (!slot) return ''
  const s = String(slot).toUpperCase()
  if (s.startsWith('OF')) return 'OF'
  if (s.startsWith('SP')) return 'SP'
  return s
}

// ─── Shared header / footer ───
function drawBackground(ctx, W, H) {
  const ang = 160 * Math.PI / 180
  const sinA = Math.sin(ang), cosA = Math.cos(ang)
  const halfDiag = (Math.abs(W * sinA) + Math.abs(H * cosA)) / 2
  const cxG = W / 2, cyG = H / 2
  const grad = ctx.createLinearGradient(
    cxG - halfDiag * sinA, cyG + halfDiag * cosA,
    cxG + halfDiag * sinA, cyG - halfDiag * cosA
  )
  grad.addColorStop(0, THEME.bg1)
  grad.addColorStop(0.35, THEME.bg2)
  grad.addColorStop(1, THEME.bg3)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, H)

  const orb1 = ctx.createRadialGradient(W - 80, 80, 0, W - 80, 80, 220)
  orb1.addColorStop(0, 'rgba(0,104,122,0.3)')
  orb1.addColorStop(1, 'rgba(0,104,122,0)')
  ctx.fillStyle = orb1
  ctx.fillRect(0, 0, W, H)
  const orb2 = ctx.createRadialGradient(70, H - 70, 0, 70, H - 70, 180)
  orb2.addColorStop(0, 'rgba(0,138,158,0.18)')
  orb2.addColorStop(1, 'rgba(0,138,158,0)')
  ctx.fillStyle = orb2
  ctx.fillRect(0, 0, W, H)
}

function drawHeader(ctx, W, padX, title, subtitle, faviconImg) {
  const font = 'Inter, Helvetica Neue, sans-serif'
  let curY = 16
  const nwLogoSz = 36
  if (faviconImg) drawImageContain(ctx, faviconImg, padX, curY, nwLogoSz, nwLogoSz)

  ctx.font = `800 14px ${font}`
  ctx.fillStyle = THEME.textSecondary
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  let charX = padX + nwLogoSz + 8
  for (const ch of 'NWBB STATS') {
    ctx.fillText(ch, charX, curY + nwLogoSz / 2)
    charX += ctx.measureText(ch).width + 2
  }
  curY += nwLogoSz + 10

  // Title
  ctx.font = `900 40px ${font}`
  ctx.fillStyle = THEME.textPrimary
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.shadowColor = THEME.accentGlow
  ctx.shadowBlur = 40
  ctx.fillText(title, padX, curY)
  ctx.shadowBlur = 0
  ctx.shadowColor = 'transparent'
  curY += 48

  // Subtitle (accent color to make it pop)
  ctx.font = `700 18px ${font}`
  ctx.fillStyle = THEME.accent
  ctx.fillText(subtitle, padX, curY)

  const headerH = 140
  ctx.strokeStyle = THEME.border
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, headerH)
  ctx.lineTo(W, headerH)
  ctx.stroke()
  return headerH
}

function drawFooter(ctx, W, H) {
  const font = 'Inter, Helvetica Neue, sans-serif'
  const footerH = 40
  const footerY = H - footerH
  ctx.strokeStyle = THEME.border
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, footerY)
  ctx.lineTo(W, footerY)
  ctx.stroke()

  ctx.font = `500 12px ${font}`
  ctx.fillStyle = THEME.textMuted
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('nwbaseballstats.com', 40, footerY + footerH / 2)

  ctx.textAlign = 'right'
  ctx.font = `400 11px ${font}`
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  ctx.fillText(`Updated ${today}`, W - 40, footerY + footerH / 2)
}

// ─── Card render (for 1st/2nd team view) ───
function drawPlayerCard(ctx, x, y, w, h, player, headshotImg, logoImg, kind, rateMode) {
  const font = 'Inter, Helvetica Neue, sans-serif'

  // Card background
  ctx.fillStyle = THEME.cardBg
  roundRect(ctx, x, y, w, h, 12)
  ctx.fill()
  ctx.strokeStyle = THEME.cardBorder
  ctx.lineWidth = 1
  ctx.stroke()

  // Position badge at top — single-color fill with rounded top, flat bottom.
  const badgeH = 26
  const badgeR = 12
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(x + badgeR, y)
  ctx.lineTo(x + w - badgeR, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + badgeR)
  ctx.lineTo(x + w, y + badgeH)
  ctx.lineTo(x, y + badgeH)
  ctx.lineTo(x, y + badgeR)
  ctx.quadraticCurveTo(x, y, x + badgeR, y)
  ctx.closePath()
  ctx.fillStyle = THEME.accentSoft
  ctx.fill()
  ctx.restore()
  // Divider line at badge bottom
  ctx.strokeStyle = THEME.accentBorder
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, y + badgeH)
  ctx.lineTo(x + w, y + badgeH)
  ctx.stroke()

  // Position label (collapses OF1/OF2/OF3 → OF, SP1/SP2... → SP)
  ctx.font = `800 13px ${font}`
  ctx.fillStyle = THEME.accent
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(displaySlot(player?.slot), x + w / 2, y + badgeH / 2 + 1)

  if (!player) {
    // Placeholder
    ctx.font = `500 12px ${font}`
    ctx.fillStyle = THEME.textMuted
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('No qualifier', x + w / 2, y + h / 2 + 20)
    return
  }

  // Decide whether to show headshot or team logo (NWAC = team logo).
  // When the card is short (e.g. First Team cards squeezed by the
  // awards row above), shrink the headshot so the stats table below
  // has enough room.  Second Team cards are taller → full-size image.
  const compact = h < 260
  const showLogo = isNwac(player)
  const imgR = compact ? 28 : 38
  const imgCX = x + w / 2
  const imgCY = y + badgeH + (compact ? 6 : 8) + imgR

  // Circle background
  ctx.fillStyle = THEME.circleBg
  ctx.beginPath()
  ctx.arc(imgCX, imgCY, imgR + 2, 0, Math.PI * 2)
  ctx.fill()

  if (showLogo) {
    if (logoImg) {
      drawImageContain(ctx, logoImg, imgCX - imgR + 3, imgCY - imgR + 3, imgR * 2 - 6, imgR * 2 - 6)
    }
  } else {
    if (headshotImg) {
      drawImageCover(ctx, headshotImg, imgCX, imgCY, imgR)
    } else if (logoImg) {
      drawImageContain(ctx, logoImg, imgCX - imgR + 3, imgCY - imgR + 3, imgR * 2 - 6, imgR * 2 - 6)
    }
  }
  // Ring
  ctx.strokeStyle = THEME.cardBorder
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(imgCX, imgCY, imgR, 0, Math.PI * 2)
  ctx.stroke()

  // Player name
  const nameY = imgCY + imgR + (compact ? 11 : 14)
  ctx.font = `700 ${compact ? 13 : 14}px ${font}`
  ctx.fillStyle = THEME.textPrimary
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(truncText(ctx, player.name || '', w - 12), x + w / 2, nameY)

  // Team line (small logo + short name)
  const teamY = nameY + (compact ? 13 : 16)
  ctx.font = `500 11px ${font}`
  const tName = player.team_short || ''
  const nameWidth = ctx.measureText(tName).width
  const miniLogoSz = 12
  const gapBetween = 4
  const totalTeamW = miniLogoSz + gapBetween + nameWidth
  const teamStartX = x + (w - totalTeamW) / 2
  if (logoImg) {
    drawImageContain(ctx, logoImg, teamStartX, teamY - miniLogoSz / 2, miniLogoSz, miniLogoSz)
  }
  ctx.fillStyle = THEME.textSecondary
  ctx.textAlign = 'left'
  ctx.fillText(tName, teamStartX + miniLogoSz + gapBetween, teamY)

  // Stats panel: true table grid (3 rows × 2 cols = 6 stats).
  // Outer rounded rect, thin row separators, center column divider,
  // label on top of each cell and value beneath.  Looks contained
  // rather than floating in space.
  const statsTop = teamY + (compact ? 9 : 12)
  const statsBottom = y + h - 8
  const statsH = statsBottom - statsTop
  const sx = x + 6
  const sw = w - 12
  const cellW = sw / 2
  const cellH = statsH / 3

  // Table background + border
  ctx.fillStyle = 'rgba(255,255,255,0.03)'
  roundRect(ctx, sx, statsTop, sw, statsH, 8)
  ctx.fill()
  ctx.strokeStyle = THEME.cardBorder
  ctx.lineWidth = 1
  ctx.stroke()

  // Center vertical divider
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(sx + cellW, statsTop + 4)
  ctx.lineTo(sx + cellW, statsTop + statsH - 4)
  ctx.stroke()

  // Horizontal row dividers (between rows 1-2 and 2-3)
  for (let r = 1; r < 3; r++) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.moveTo(sx + 4, statsTop + r * cellH)
    ctx.lineTo(sx + sw - 4, statsTop + r * cellH)
    ctx.stroke()
  }

  const stats = buildStats(player, kind, rateMode)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < stats.length; i++) {
    const col = i % 2
    const row = Math.floor(i / 2)
    const cx = sx + col * cellW + cellW / 2
    const cy = statsTop + row * cellH + cellH / 2

    ctx.font = `700 8px ${font}`
    ctx.fillStyle = THEME.textMuted
    ctx.fillText(stats[i].label, cx, cy - 8)

    ctx.font = `800 14px ${font}`
    ctx.fillStyle = THEME.textPrimary
    ctx.fillText(stats[i].value, cx, cy + 6)
  }
}

function buildStats(player, kind, rateMode) {
  if (kind === 'hitter') {
    // Two-way UTIL players get a blended stat block that shows both sides.
    if (player.slot === 'UTIL' && player.is_two_way && player.pitching) {
      const totalWar = (player.war || 0) + (player.pitching.war || 0)
      return [
        { label: 'Total WAR', value: fmtWar(totalWar) },
        { label: 'wOBA', value: fmtAvg(player.woba) },
        { label: 'HR', value: fmtInt(player.hr) },
        { label: 'FIP', value: fmtFloat(player.pitching.fip) },
        { label: 'K%', value: fmtPct(player.pitching.k_pct) },
        { label: 'BB%', value: fmtPct(player.pitching.bb_pct) },
      ]
    }
    const warLabel = rateMode ? 'WAR/PA' : 'WAR'
    const warVal = rateMode ? fmtWarRate(player.war_rate) : fmtWar(player.war)
    return [
      { label: 'PA', value: fmtInt(player.pa) },
      { label: warLabel, value: warVal },
      { label: 'wRC+', value: fmtInt(player.wrc_plus) },
      { label: 'ISO', value: fmtAvg(player.iso) },
      { label: 'HR', value: fmtInt(player.hr) },
      { label: 'SB', value: fmtInt(player.sb) },
    ]
  } else {
    // pitchers — relievers use WAR/IP
    const isReliever = (player.slot || '').startsWith('RP')
    const useRate = rateMode || isReliever
    const warLabel = useRate ? 'WAR/IP' : 'WAR'
    const warVal = useRate ? fmtWarRate(player.war_rate) : fmtWar(player.war)
    return [
      { label: warLabel, value: warVal },
      { label: 'FIP', value: fmtFloat(player.fip) },
      { label: 'SIERA', value: fmtFloat(player.siera) },
      { label: 'K%', value: fmtPct(player.k_pct) },
      { label: 'BB%', value: fmtPct(player.bb_pct) },
      { label: 'IP', value: fmtIp(player.ip) },
    ]
  }
}

// ─── Awards row (First Team only) ───
// Equal row of 5 award cards at the top of the First Team graphic.
// Stats intentionally omitted — just team logo, headshot, name, slot.
const AWARD_ORDER = [
  { key: 'mvp',              title: 'MVP' },
  { key: 'hitter_of_year',   title: 'HITTER OF THE YEAR' },
  { key: 'pitcher_of_year',  title: 'PITCHER OF THE YEAR' },
  { key: 'transfer_of_year', title: 'TRANSFER OF THE YEAR' },
  { key: 'freshman_of_year', title: 'FRESHMAN OF THE YEAR' },
]

function drawAwardCard(ctx, x, y, w, h, title, player, headshotImg, logoImg) {
  const font = 'Inter, Helvetica Neue, sans-serif'

  // Card background — slightly richer than position cards
  ctx.fillStyle = 'rgba(125,211,252,0.07)'
  roundRect(ctx, x, y, w, h, 12)
  ctx.fill()
  ctx.strokeStyle = THEME.accentBorder
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Title banner across the top — solid accent-soft band
  const bannerH = 22
  const bannerR = 12
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(x + bannerR, y)
  ctx.lineTo(x + w - bannerR, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + bannerR)
  ctx.lineTo(x + w, y + bannerH)
  ctx.lineTo(x, y + bannerH)
  ctx.lineTo(x, y + bannerR)
  ctx.quadraticCurveTo(x, y, x + bannerR, y)
  ctx.closePath()
  ctx.fillStyle = 'rgba(125,211,252,0.18)'
  ctx.fill()
  ctx.restore()
  ctx.strokeStyle = THEME.accentBorder
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, y + bannerH)
  ctx.lineTo(x + w, y + bannerH)
  ctx.stroke()

  // Title text (auto-shrink if it overflows the banner)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = THEME.accent
  let titleFontSize = 10
  ctx.font = `900 ${titleFontSize}px ${font}`
  while (ctx.measureText(title).width > w - 8 && titleFontSize > 7) {
    titleFontSize -= 0.5
    ctx.font = `900 ${titleFontSize}px ${font}`
  }
  ctx.fillText(title, x + w / 2, y + bannerH / 2 + 1)

  if (!player) {
    ctx.font = `500 11px ${font}`
    ctx.fillStyle = THEME.textMuted
    ctx.fillText('No winner', x + w / 2, y + h / 2 + 10)
    return
  }

  // Headshot / logo
  const showLogo = isNwac(player)
  const imgR = 28
  const imgCX = x + w / 2
  const imgCY = y + bannerH + 8 + imgR

  // Circle background
  ctx.fillStyle = THEME.circleBg
  ctx.beginPath()
  ctx.arc(imgCX, imgCY, imgR + 2, 0, Math.PI * 2)
  ctx.fill()

  if (showLogo) {
    if (logoImg) drawImageContain(ctx, logoImg, imgCX - imgR + 3, imgCY - imgR + 3, imgR * 2 - 6, imgR * 2 - 6)
  } else {
    if (headshotImg) drawImageCover(ctx, headshotImg, imgCX, imgCY, imgR)
    else if (logoImg) drawImageContain(ctx, logoImg, imgCX - imgR + 3, imgCY - imgR + 3, imgR * 2 - 6, imgR * 2 - 6)
  }
  // Accent ring around the hero
  ctx.strokeStyle = THEME.accent
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(imgCX, imgCY, imgR, 0, Math.PI * 2)
  ctx.stroke()

  // Position slot pill, centered just under the image (OF1→OF, SP1→SP)
  const posY = imgCY + imgR + 11
  const posText = displaySlot(player.position)
  ctx.font = `800 10px ${font}`
  const posW = Math.max(28, ctx.measureText(posText).width + 12)
  const posX = x + (w - posW) / 2
  ctx.fillStyle = 'rgba(125,211,252,0.18)'
  roundRect(ctx, posX, posY - 7, posW, 14, 7)
  ctx.fill()
  ctx.fillStyle = THEME.accent
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(posText, x + w / 2, posY)

  // Player name
  const nameY = posY + 15
  ctx.font = `800 13px ${font}`
  ctx.fillStyle = THEME.textPrimary
  ctx.fillText(truncText(ctx, player.name || '', w - 10), x + w / 2, nameY)

  // Team (logo + short name)
  const teamY = nameY + 14
  ctx.font = `600 11px ${font}`
  const tName = player.team_short || ''
  const nameWidth = ctx.measureText(tName).width
  const miniLogoSz = 12
  const gapBetween = 4
  const totalTeamW = miniLogoSz + gapBetween + nameWidth
  const teamStartX = x + (w - totalTeamW) / 2
  if (logoImg) {
    drawImageContain(ctx, logoImg, teamStartX, teamY - miniLogoSz / 2, miniLogoSz, miniLogoSz)
  }
  ctx.fillStyle = THEME.textSecondary
  ctx.textAlign = 'left'
  ctx.fillText(tName, teamStartX + miniLogoSz + gapBetween, teamY)
}

function drawAwardsRow(ctx, x, y, w, h, awards, headshots, teamLogos) {
  if (!awards) return
  const count = AWARD_ORDER.length
  const gap = 10
  const cardW = Math.floor((w - gap * (count - 1)) / count)
  for (let i = 0; i < count; i++) {
    const a = AWARD_ORDER[i]
    const player = awards[a.key] || null
    const cx = x + i * (cardW + gap)
    const headshotImg = player ? headshots[player.player_id] : null
    const logoImg = player ? teamLogos[player.team_id] : null
    drawAwardCard(ctx, cx, y, cardW, h, a.title, player, headshotImg, logoImg)
  }
}

// ─── Team view renderer (1st Team or 2nd Team) ───
function renderTeamView({
  ctx, W, H, result, team, teamLabel, faviconImg, headshots, teamLogos, showAwards,
}) {
  drawBackground(ctx, W, H)
  const padX = 40
  const headerH = drawHeader(
    ctx, W, padX,
    `${result.label || ''} ${teamLabel}`,
    `2026 All-Conference Team`,
    faviconImg
  )
  drawFooter(ctx, W, H)

  const bodyTop = headerH + 14
  const bodyBottom = H - 40 - 8
  let gridTop = bodyTop

  // Awards row (First Team only) — sits above the position grid.
  if (showAwards && result.awards) {
    const awardsH = 160
    drawAwardsRow(
      ctx,
      padX,
      bodyTop,
      W - padX * 2,
      awardsH,
      result.awards,
      headshots,
      teamLogos
    )
    // Subtle divider between awards row and position grid
    const divY = bodyTop + awardsH + 14
    ctx.strokeStyle = THEME.border
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(padX, divY)
    ctx.lineTo(W - padX, divY)
    ctx.stroke()
    gridTop = divY + 14
  }

  const bodyH = bodyBottom - gridTop

  const rowsCount = 3
  const colsCount = 5
  const gap = 14
  const colW = Math.floor((W - padX * 2 - gap * (colsCount - 1)) / colsCount)
  const rowH = Math.floor((bodyH - gap * (rowsCount - 1)) / rowsCount)

  const row1 = ['C', '1B', '2B', '3B', 'SS']
  const row2 = ['OF1', 'OF2', 'OF3', 'DH', 'UTIL']
  const row3 = ['SP1', 'SP2', 'SP3', 'SP4', 'RP']
  const layout = [row1, row2, row3]

  for (let r = 0; r < rowsCount; r++) {
    const slots = layout[r]
    const y = gridTop + r * (rowH + gap)
    const isPitcherRow = r === 2
    for (let c = 0; c < colsCount; c++) {
      const slot = slots[c]
      const x = padX + c * (colW + gap)
      const player = team ? team[slot] : null
      const headshotImg = player ? headshots[player.player_id] : null
      const logoImg = player ? teamLogos[player.team_id] : null
      drawPlayerCard(
        ctx, x, y, colW, rowH,
        player, headshotImg, logoImg,
        isPitcherRow ? 'pitcher' : 'hitter',
        result.rate_mode
      )
    }
  }
}

// ─── Honorable Mentions view (no stats, compact chips) ───
function drawHmChip(ctx, x, y, w, h, player, headshotImg, logoImg) {
  const font = 'Inter, Helvetica Neue, sans-serif'
  // background tile
  ctx.fillStyle = THEME.cardBg
  roundRect(ctx, x, y, w, h, 10)
  ctx.fill()
  ctx.strokeStyle = THEME.cardBorder
  ctx.lineWidth = 1
  ctx.stroke()

  if (!player) return

  const showLogo = isNwac(player)
  const imgR = Math.floor(h * 0.36)
  const imgCX = x + 12 + imgR
  const imgCY = y + h / 2

  ctx.fillStyle = THEME.circleBg
  ctx.beginPath()
  ctx.arc(imgCX, imgCY, imgR + 1, 0, Math.PI * 2)
  ctx.fill()

  if (showLogo) {
    if (logoImg) drawImageContain(ctx, logoImg, imgCX - imgR + 2, imgCY - imgR + 2, imgR * 2 - 4, imgR * 2 - 4)
  } else {
    if (headshotImg) drawImageCover(ctx, headshotImg, imgCX, imgCY, imgR)
    else if (logoImg) drawImageContain(ctx, logoImg, imgCX - imgR + 2, imgCY - imgR + 2, imgR * 2 - 4, imgR * 2 - 4)
  }
  ctx.strokeStyle = THEME.cardBorder
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(imgCX, imgCY, imgR, 0, Math.PI * 2)
  ctx.stroke()

  const textX = imgCX + imgR + 10
  const textMaxW = x + w - 10 - textX

  // Name
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `700 13px ${font}`
  ctx.fillStyle = THEME.textPrimary
  ctx.fillText(truncText(ctx, player.name || '', textMaxW), textX, imgCY - 2)

  // Team (small logo + short name)
  ctx.font = `500 11px ${font}`
  const miniSz = 12
  const gap = 4
  const tName = player.team_short || ''
  ctx.textBaseline = 'middle'
  if (logoImg) {
    drawImageContain(ctx, logoImg, textX, imgCY + 10 - miniSz / 2, miniSz, miniSz)
  }
  ctx.fillStyle = THEME.textSecondary
  ctx.fillText(truncText(ctx, tName, textMaxW - miniSz - gap), textX + miniSz + gap, imgCY + 10)
}

function renderHmView({
  ctx, W, H, result, faviconImg, headshots, teamLogos,
}) {
  drawBackground(ctx, W, H)
  const padX = 40
  const headerH = drawHeader(
    ctx, W, padX,
    `${result.label || ''} Honorable Mentions`,
    `2026 All-Conference Honorable Mentions`,
    faviconImg
  )
  drawFooter(ctx, W, H)

  const hm = result.honorable_mentions || {}
  const bodyTop = headerH + 14
  const bodyBottom = H - 40 - 8
  const bodyH = bodyBottom - bodyTop

  const cats = HM_CATEGORIES
  const rowGap = 8
  const rowH = Math.floor((bodyH - rowGap * (cats.length - 1)) / cats.length)

  const labelW = 60
  const chipGap = 10
  const chipsAreaX = padX + labelW + 8
  const chipsAreaW = W - padX - chipsAreaX
  const chipsPerRow = 3
  const chipW = Math.floor((chipsAreaW - chipGap * (chipsPerRow - 1)) / chipsPerRow)

  const font = 'Inter, Helvetica Neue, sans-serif'

  for (let r = 0; r < cats.length; r++) {
    const cat = cats[r]
    const y = bodyTop + r * (rowH + rowGap)
    const players = hm[cat.key] || []

    // Category label (left column)
    ctx.font = `800 16px ${font}`
    ctx.fillStyle = THEME.accent
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(cat.label, padX, y + rowH / 2)

    // Thin divider tick
    ctx.strokeStyle = THEME.border
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(padX + labelW, y + rowH / 2 - rowH * 0.35)
    ctx.lineTo(padX + labelW, y + rowH / 2 + rowH * 0.35)
    ctx.stroke()

    // Chips
    for (let i = 0; i < chipsPerRow; i++) {
      const cx = chipsAreaX + i * (chipW + chipGap)
      const p = players[i] || null
      const headshotImg = p ? headshots[p.player_id] : null
      const logoImg = p ? teamLogos[p.team_id] : null
      if (!p) {
        // empty placeholder
        ctx.fillStyle = 'rgba(255,255,255,0.015)'
        roundRect(ctx, cx, y, chipW, rowH, 10)
        ctx.fill()
        continue
      }
      drawHmChip(ctx, cx, y, chipW, rowH, p, headshotImg, logoImg)
    }
  }
}

// ─── Gather all unique players (for headshot loading) and teams (for logo loading) ───
function collectPlayersAndTeams(result) {
  const players = new Map()  // player_id -> headshot_url
  const teams = new Map()    // team_id -> team_logo

  const addPlayer = (p) => {
    if (!p) return
    if (p.player_id && p.headshot_url) players.set(p.player_id, p.headshot_url)
    if (p.team_id && p.team_logo) teams.set(p.team_id, p.team_logo)
  }

  const eachTeam = (team) => {
    if (!team) return
    Object.values(team).forEach(addPlayer)
  }
  eachTeam(result.first_team)
  eachTeam(result.second_team)

  const hm = result.honorable_mentions || {}
  Object.values(hm).forEach(list => {
    (list || []).forEach(addPlayer)
  })

  // Awards winners might be the same players as the first team, but
  // they might not — so run them through addPlayer to be safe.
  const awards = result.awards || {}
  Object.values(awards).forEach(addPlayer)

  return { players, teams }
}

// ─── Main component ───
export default function AllConferenceGraphic() {
  const [season] = useState(2026)
  const [conf, setConf] = useState('gnac')
  const [view, setView] = useState('first')  // 'first' | 'second' | 'hm'
  const [exporting, setExporting] = useState(false)
  const [images, setImages] = useState(null)   // { faviconImg, headshots, teamLogos }
  const canvasRef = useRef(null)

  const { data: result, loading } = useApi('/all-conference', { conf, season }, [conf, season])

  // Load images (favicon + all headshots + all team logos) when data arrives
  useEffect(() => {
    if (!result) return
    let cancelled = false

    async function loadAll() {
      const { players, teams } = collectPlayersAndTeams(result)
      const playerIds = [...players.keys()]
      const teamIds = [...teams.keys()]

      const [faviconImg, ...rest] = await Promise.all([
        loadExportImage('/favicon.png'),
        ...playerIds.map(pid => loadExportImage(players.get(pid))),
        ...teamIds.map(tid => loadExportImage(teams.get(tid))),
      ])

      if (cancelled) return

      const headshots = {}
      playerIds.forEach((pid, i) => { headshots[pid] = rest[i] })
      const teamLogos = {}
      teamIds.forEach((tid, i) => { teamLogos[tid] = rest[playerIds.length + i] })

      setImages({ faviconImg, headshots, teamLogos })
    }

    loadAll()
    return () => { cancelled = true }
  }, [result])

  // Draw preview whenever data/images/view changes
  useEffect(() => {
    if (!canvasRef.current || !result || !images) return

    const canvas = canvasRef.current
    const W = 1080, H = 1080
    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    canvas.style.width = '100%'
    canvas.style.maxWidth = `${W}px`
    canvas.style.height = 'auto'
    const ctx = canvas.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)

    if (view === 'hm') {
      renderHmView({
        ctx, W, H, result,
        faviconImg: images.faviconImg,
        headshots: images.headshots,
        teamLogos: images.teamLogos,
      })
    } else {
      const team = view === 'first' ? result.first_team : result.second_team
      const teamLabel = view === 'first' ? 'First Team' : 'Second Team'
      renderTeamView({
        ctx, W, H, result, team, teamLabel,
        faviconImg: images.faviconImg,
        headshots: images.headshots,
        teamLogos: images.teamLogos,
        showAwards: view === 'first',
      })
    }
  }, [result, images, view])

  // ─── Export handler ───
  const handleExport = useCallback(async () => {
    if (!result || !images) return
    setExporting(true)
    try {
      const dpr = 2
      const W = 1080, H = 1080

      const canvas = document.createElement('canvas')
      canvas.width = W * dpr
      canvas.height = H * dpr
      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)

      if (view === 'hm') {
        renderHmView({
          ctx, W, H, result,
          faviconImg: images.faviconImg,
          headshots: images.headshots,
          teamLogos: images.teamLogos,
        })
      } else {
        const team = view === 'first' ? result.first_team : result.second_team
        const teamLabel = view === 'first' ? 'First Team' : 'Second Team'
        renderTeamView({
          ctx, W, H, result, team, teamLabel,
          faviconImg: images.faviconImg,
          headshots: images.headshots,
          teamLogos: images.teamLogos,
          showAwards: view === 'first',
        })
      }

      const viewLabel = view === 'first' ? '1st-team' : view === 'second' ? '2nd-team' : 'honorable-mentions'
      const link = document.createElement('a')
      link.download = `nwbb-all-conference-${conf}-${viewLabel}-${season}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed. Check console for details.')
    } finally {
      setExporting(false)
    }
  }, [result, images, view, conf, season])

  // Group conferences for dropdown
  const grouped = {}
  for (const c of CONF_OPTIONS) {
    if (!grouped[c.group]) grouped[c.group] = []
    grouped[c.group].push(c)
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">All-Conference Graphic</h1>
      <p className="text-sm text-gray-500 mb-5">
        Downloadable first team, second team, and honorable mention graphics for social media.
      </p>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* ═══ LEFT: Controls ═══ */}
        <div className="lg:w-72 shrink-0 space-y-4">
          <div className="bg-white rounded-lg shadow-sm border p-4 space-y-3">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Conference
            </label>
            <select
              value={conf}
              onChange={(e) => { setConf(e.target.value); setImages(null) }}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
            >
              {Object.entries(grouped).map(([groupName, options]) => (
                <optgroup key={groupName} label={groupName}>
                  {options.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="bg-white rounded-lg shadow-sm border p-4 space-y-2">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Team
            </label>
            <div className="grid grid-cols-1 gap-2">
              {[
                { key: 'first', label: '1st Team' },
                { key: 'second', label: '2nd Team' },
                { key: 'hm', label: 'Honorable Mentions' },
              ].map(opt => (
                <button
                  key={opt.key}
                  onClick={() => setView(opt.key)}
                  className={`px-3 py-2 text-sm rounded border transition-colors ${
                    view === opt.key
                      ? 'bg-pnw-sky text-white border-pnw-sky'
                      : 'bg-white text-pnw-slate border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleExport}
            disabled={exporting || !result || !images}
            className="w-full px-4 py-2.5 bg-pnw-green text-white text-sm font-semibold rounded-lg hover:bg-pnw-forest transition-colors disabled:opacity-50"
          >
            {exporting ? 'Generating...' : 'Download PNG'}
          </button>

          {loading && (
            <p className="text-xs text-gray-400">Loading all-conference data...</p>
          )}
        </div>

        {/* ═══ RIGHT: Live Canvas Preview ═══ */}
        <div className="flex-1 min-w-0">
          {result && images ? (
            <div className="bg-gray-900 rounded-lg shadow-sm border border-gray-700 p-2">
              <canvas ref={canvasRef} className="rounded" />
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow-sm border p-8 text-center text-gray-400">
              {loading ? 'Loading graphic...' : 'Preparing images...'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
