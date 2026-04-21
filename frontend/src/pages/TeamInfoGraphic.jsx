import { useState, useRef, useCallback, useEffect } from 'react'

const API_BASE = '/api/v1'
const SIZE = 1080
const MARGIN = 36

// ─── Helpers ───
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
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtAvg(v) {
  if (v == null) return '.000'
  return v.toFixed(3).replace(/^0/, '')
}

function fmtEra(v) {
  if (v == null) return '-.--'
  return v.toFixed(2)
}

function fmtPct(v, d = 1) {
  if (v == null) return '-'
  return v.toFixed(d) + '%'
}

function fmtInt(v) {
  if (v == null) return '-'
  return Math.round(v).toString()
}

function ordinal(n) {
  if (n == null) return '-'
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

// Route external headshot URLs through our image proxy so canvas can use them
// without CORS issues. Local paths (/headshots/*, /logos/*) and data URIs pass through.
function resolveImageUrl(url) {
  if (!url) return url
  if (url.startsWith('data:') || url.startsWith('/') || url.startsWith('blob:')) return url
  if (/^https?:\/\//i.test(url)) {
    return `${API_BASE}/proxy-image?url=${encodeURIComponent(url)}`
  }
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
    img.onerror = (e) => {
      console.warn('[TeamInfoGraphic] image failed to load:', src)
      reject(e)
    }
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

// Savant-style red→white→blue palette
function percentileColor(pct) {
  if (pct == null) return '#e5e7eb'
  const p = Math.max(0, Math.min(100, pct)) / 100
  let r, g, b
  if (p >= 0.5) {
    const t = (p - 0.5) * 2
    r = Math.round(255 * (1 - t) + 214 * t)
    g = Math.round(255 * (1 - t) + 62 * t)
    b = Math.round(255 * (1 - t) + 62 * t)
  } else {
    const t = p * 2
    r = Math.round(29 * (1 - t) + 255 * t)
    g = Math.round(78 * (1 - t) + 255 * t)
    b = Math.round(216 * (1 - t) + 255 * t)
  }
  return `rgb(${r},${g},${b})`
}

function textColorFor(bg) {
  // parse rgb()
  const m = bg.match(/\d+/g)
  if (!m) return '#1e293b'
  const [r, g, b] = m.map(Number)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? '#1e293b' : '#ffffff'
}

// Try to load team logo, fallback gracefully
async function tryLoadLogo(team) {
  const src = team?.logo_url || team?.logo
  if (!src) return null
  try {
    return await loadImage(resolveImageUrl(src))
  } catch {
    return null
  }
}

// ─── Zone renderers ───

async function drawHeader(ctx, data, y, h) {
  const logo = await tryLoadLogo(data.team)
  const pad = MARGIN

  // Background band with a subtle slate gradient
  const grad = ctx.createLinearGradient(0, y, 0, y + h)
  grad.addColorStop(0, '#0f172a')
  grad.addColorStop(1, '#1e293b')
  ctx.fillStyle = grad
  ctx.fillRect(0, y, SIZE, h)

  // Accent strip at bottom of header
  ctx.fillStyle = '#14b8a6'
  ctx.fillRect(0, y + h - 4, SIZE, 4)

  // Logo
  const logoSize = 140
  const logoX = pad
  const logoY = y + (h - logoSize) / 2
  if (logo) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.clip()
    ctx.drawImage(logo, logoX + 8, logoY + 8, logoSize - 16, logoSize - 16)
    ctx.restore()
  } else {
    ctx.fillStyle = '#ffffff22'
    ctx.beginPath()
    ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2, 0, Math.PI * 2)
    ctx.fill()
  }

  // Team name
  const textX = logoX + logoSize + 24
  const teamName = cleanTeamName(data.team.name || data.team.short_name)
  const city = [data.team.city, data.team.state].filter(Boolean).join(', ')

  ctx.fillStyle = '#ffffff'
  ctx.font = '800 56px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  // Fit team name to available width
  const maxW = SIZE - textX - pad
  let fontSize = 56
  while (fontSize > 30) {
    ctx.font = `800 ${fontSize}px "Inter", system-ui, sans-serif`
    if (ctx.measureText(teamName).width <= maxW) break
    fontSize -= 2
  }
  ctx.fillText(teamName, textX, logoY + 60)

  // Sub-line: division · conference
  ctx.font = '600 22px "Inter", system-ui, sans-serif'
  ctx.fillStyle = '#5eead4'
  const divLabel = data.team.division_name || (data.team.division_level ? `D${data.team.division_level}` : '')
  const sub1 = [divLabel, data.team.conference_name].filter(Boolean).join(' · ')
  ctx.fillText(sub1 || 'PNW Baseball', textX, logoY + 94)

  ctx.font = '500 18px "Inter", system-ui, sans-serif'
  ctx.fillStyle = '#cbd5e1'
  const coachName = data.head_coach?.name ? `HC: ${data.head_coach.name}` : ''
  const locLine = [city, coachName].filter(Boolean).join('   •   ')
  ctx.fillText(locLine, textX, logoY + 120)
}

function drawRecordStrip(ctx, data, y, h) {
  const pad = MARGIN
  const innerPad = 14
  const card = {
    x: pad,
    y: y + innerPad,
    w: SIZE - pad * 2,
    h: h - innerPad * 2,
  }

  // Card bg
  roundRect(ctx, card.x, card.y, card.w, card.h, 14)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 1
  ctx.stroke()

  const rec = data.record || {}
  const w = rec.wins ?? 0
  const l = rec.losses ?? 0
  const t = rec.ties ?? 0
  const pct = (w + l) > 0 ? w / (w + l) : 0
  const cw = rec.conf_wins ?? 0
  const cl = rec.conf_losses ?? 0
  const hw = rec.home_wins ?? 0
  const hl = rec.home_losses ?? 0
  const aw = rec.away_wins ?? 0
  const al = rec.away_losses ?? 0
  const rf = rec.runs_for ?? 0
  const ra = rec.runs_against ?? 0
  const diff = rf - ra

  const cols = [
    { label: 'OVERALL', big: `${w}-${l}${t ? `-${t}` : ''}`, small: fmtAvg(pct).replace('.', '') ? fmtAvg(pct) : '.000' },
    { label: 'CONFERENCE', big: `${cw}-${cl}`, small: (cw + cl) > 0 ? fmtAvg(cw / (cw + cl)) : '.000' },
    { label: 'HOME', big: `${hw}-${hl}`, small: (hw + hl) > 0 ? fmtAvg(hw / (hw + hl)) : '.000' },
    { label: 'AWAY', big: `${aw}-${al}`, small: (aw + al) > 0 ? fmtAvg(aw / (aw + al)) : '.000' },
    { label: 'RUN DIFF', big: `${diff >= 0 ? '+' : ''}${diff}`, small: `${rf}/${ra}` },
    { label: 'PYTHAG', big: rec.pythagorean_wins != null ? `${fmtInt(rec.pythagorean_wins)}-${fmtInt(rec.pythagorean_losses)}` : '-', small: 'expected' },
  ]

  const colW = card.w / cols.length
  cols.forEach((col, i) => {
    const cx = card.x + colW * i
    const cy = card.y

    // divider
    if (i > 0) {
      ctx.strokeStyle = '#e2e8f0'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(cx, cy + 16)
      ctx.lineTo(cx, cy + card.h - 16)
      ctx.stroke()
    }

    ctx.fillStyle = '#94a3b8'
    ctx.font = '700 11px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(col.label, cx + colW / 2, cy + 14)

    // big value, color run diff
    let bigColor = '#0f172a'
    if (col.label === 'RUN DIFF') bigColor = diff >= 0 ? '#047857' : '#b91c1c'
    ctx.fillStyle = bigColor
    ctx.font = '800 32px "Inter", system-ui, sans-serif'
    ctx.fillText(col.big, cx + colW / 2, cy + card.h / 2 + 2)

    ctx.fillStyle = '#64748b'
    ctx.font = '500 12px "Inter", system-ui, sans-serif'
    ctx.fillText(col.small, cx + colW / 2, cy + card.h - 14)
  })
}

function drawRankings(ctx, data, y, h) {
  const pad = MARGIN
  const gap = 12
  const inner = SIZE - pad * 2
  const cardW = (inner - gap * 3) / 4
  const cardH = h - 20
  const cy = y + 10

  const r = data.rankings || {}
  const cards = [
    { label: 'NATIONAL RANK', big: r.national_rank != null ? `#${r.national_rank}` : '-', small: r.national_percentile != null ? `${Math.round(r.national_percentile)} percentile` : '', tint: '#0ea5e9' },
    { label: 'CONFERENCE RANK', big: r.conference_rank != null ? `#${r.conference_rank}` : '-', small: r.conference_total ? `of ${r.conference_total}` : '', tint: '#14b8a6' },
    { label: 'POWER RATING', big: r.power_rating != null ? r.power_rating.toFixed(2) : '-', small: r.power_rating_conf_rank != null ? `${ordinal(r.power_rating_conf_rank)} in conference` : 'cross-division quality', tint: '#8b5cf6' },
    { label: 'STRENGTH OF SCHED', big: r.sos_rank != null ? `#${r.sos_rank}` : '-', small: r.sos != null ? `SOS ${r.sos.toFixed(3)}` : '', tint: '#f59e0b' },
  ]

  cards.forEach((c, i) => {
    const cx = pad + (cardW + gap) * i
    roundRect(ctx, cx, cy, cardW, cardH, 14)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1
    ctx.stroke()

    // Tint bar on top
    ctx.save()
    roundRect(ctx, cx, cy, cardW, cardH, 14)
    ctx.clip()
    ctx.fillStyle = c.tint
    ctx.fillRect(cx, cy, cardW, 6)
    ctx.restore()

    ctx.fillStyle = '#64748b'
    ctx.font = '700 11px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(c.label, cx + cardW / 2, cy + 22)

    ctx.fillStyle = '#0f172a'
    ctx.font = '800 36px "Inter", system-ui, sans-serif'
    ctx.fillText(c.big, cx + cardW / 2, cy + cardH / 2 + 4)

    ctx.fillStyle = '#94a3b8'
    ctx.font = '500 11px "Inter", system-ui, sans-serif'
    ctx.fillText(c.small, cx + cardW / 2, cy + cardH - 14)
  })
}

function drawPercentiles(ctx, data, y, h) {
  const pad = MARGIN
  const headerH = 30
  ctx.fillStyle = '#0f172a'
  ctx.font = '800 20px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText('DIVISION RANK', pad, y + 22)

  ctx.fillStyle = '#64748b'
  ctx.font = '500 13px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText('lower rank = better', SIZE - pad, y + 22)

  const battingMetrics = [
    { key: 'batting_avg', label: 'AVG',   fmt: v => v != null ? v.toFixed(3).replace(/^0/, '') : '-' },
    { key: 'woba',        label: 'wOBA',  fmt: v => v != null ? v.toFixed(3).replace(/^0/, '') : '-' },
    { key: 'hr_per_pa',   label: 'HR/PA', fmt: v => v != null ? (v * 100).toFixed(1) + '%' : '-' },
    { key: 'owar',        label: 'oWAR',  fmt: v => v != null ? v.toFixed(1) : '-' },
    { key: 'wrc_plus',    label: 'wRC+',  fmt: v => v != null ? v.toFixed(0) : '-' },
  ]
  const pitchingMetrics = [
    { key: 'era',   label: 'ERA',   fmt: v => v != null ? v.toFixed(2) : '-' },
    { key: 'siera', label: 'SIERA', fmt: v => v != null ? v.toFixed(2) : '-' },
    { key: 'k_pct', label: 'K%',    fmt: v => v != null ? v.toFixed(1) + '%' : '-' },
    { key: 'baa',   label: 'BAA',   fmt: v => v != null ? v.toFixed(3).replace(/^0/, '') : '-' },
    { key: 'pwar',  label: 'pWAR',  fmt: v => v != null ? v.toFixed(1) : '-' },
  ]

  const batP = data.batting_percentiles || {}
  const pitP = data.pitching_percentiles || {}
  const startY = y + headerH + 8
  const availH = h - headerH - 16
  const cols = 5
  const gap = 9
  const cellW = (SIZE - pad * 2 - gap * (cols - 1)) / cols
  const rowGap = 8
  const cellH = (availH - rowGap) / 2

  const drawRow = (metrics, data, rowY) => {
    metrics.forEach((m, c) => {
      const cx = pad + c * (cellW + gap)
      const obj = data[m.key] || {}
      const pct = obj.percentile
      const val = obj.value
      const rank = obj.rank
      const total = obj.total

      const bg = percentileColor(pct)
      const txt = textColorFor(bg)

      roundRect(ctx, cx, rowY, cellW, cellH, 10)
      ctx.fillStyle = bg
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.stroke()

      ctx.fillStyle = txt
      ctx.font = '700 12px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(m.label, cx + cellW / 2, rowY + 14)

      // Metric value (mid-sized)
      ctx.font = '700 20px "Inter", system-ui, sans-serif'
      ctx.fillText(m.fmt(val), cx + cellW / 2, rowY + 38)

      // Division rank — the headline number
      if (rank != null && total != null) {
        ctx.font = '900 26px "Inter", system-ui, sans-serif'
        ctx.fillText(ordinal(rank), cx + cellW / 2, rowY + cellH / 2 + 18)
        ctx.font = '600 10px "Inter", system-ui, sans-serif'
        ctx.fillText(`of ${total}`, cx + cellW / 2, rowY + cellH - 12)
      } else {
        ctx.font = '800 22px "Inter", system-ui, sans-serif'
        ctx.fillText('—', cx + cellW / 2, rowY + cellH / 2 + 14)
      }
    })
  }

  drawRow(battingMetrics, batP, startY)
  drawRow(pitchingMetrics, pitP, startY + cellH + rowGap)
}

async function drawPerformers(ctx, data, y, h) {
  const pad = MARGIN
  const title = 'TOP PERFORMERS'
  ctx.fillStyle = '#0f172a'
  ctx.font = '800 20px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(title, pad, y + 24)

  const hittersTitle = 'HITTERS'
  const pitchersTitle = 'PITCHERS'
  ctx.fillStyle = '#64748b'
  ctx.font = '700 13px "Inter", system-ui, sans-serif'
  ctx.fillText(hittersTitle, pad, y + 48)
  ctx.fillText(pitchersTitle, SIZE / 2 + 8, y + 48)

  const ROWS = 5
  const ROW_GAP = 6
  const listStartY = y + 60
  const availH = h - 70
  const colW = (SIZE - pad * 2 - 16) / 2
  const rowH = Math.floor((availH - ROW_GAP * (ROWS - 1)) / ROWS)

  const renderList = async (list, baseX) => {
    for (let i = 0; i < ROWS; i++) {
      const p = list[i]
      const ry = listStartY + i * (rowH + ROW_GAP)
      roundRect(ctx, baseX, ry, colW, rowH, 10)
      ctx.fillStyle = i === 0 ? '#f0fdfa' : '#f8fafc'
      ctx.fill()
      ctx.strokeStyle = '#e2e8f0'
      ctx.lineWidth = 1
      ctx.stroke()

      if (!p) {
        ctx.fillStyle = '#94a3b8'
        ctx.font = '500 14px "Inter", system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('—', baseX + colW / 2, ry + rowH / 2)
        continue
      }

      // rank bubble
      ctx.fillStyle = i === 0 ? '#14b8a6' : '#94a3b8'
      ctx.beginPath()
      ctx.arc(baseX + 22, ry + rowH / 2, 14, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = '800 14px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(i + 1), baseX + 22, ry + rowH / 2 + 1)

      // headshot or initials
      const headX = baseX + 44
      const headSize = 36
      let headImg = null
      if (p.headshot_url) {
        try { headImg = await loadImage(resolveImageUrl(p.headshot_url)) } catch { headImg = null }
      }
      ctx.save()
      ctx.beginPath()
      ctx.arc(headX + headSize / 2, ry + rowH / 2, headSize / 2, 0, Math.PI * 2)
      ctx.fillStyle = '#e2e8f0'
      ctx.fill()
      ctx.clip()
      if (headImg) {
        ctx.drawImage(headImg, headX, ry + (rowH - headSize) / 2, headSize, headSize)
      } else {
        ctx.fillStyle = '#64748b'
        ctx.font = '700 14px "Inter", system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const initials = (p.name || '??').split(' ').map(s => s[0]).slice(0, 2).join('')
        ctx.fillText(initials, headX + headSize / 2, ry + rowH / 2 + 1)
      }
      ctx.restore()

      // name + sub
      ctx.textAlign = 'left'
      ctx.fillStyle = '#0f172a'
      ctx.font = '700 16px "Inter", system-ui, sans-serif'
      ctx.textBaseline = 'alphabetic'
      const nx = headX + headSize + 10
      let name = p.name || ''
      const maxNameW = colW - (nx - baseX) - 110
      while (ctx.measureText(name).width > maxNameW && name.length > 3) {
        name = name.slice(0, -1)
      }
      if (name !== p.name) name = name.trim() + '…'
      ctx.fillText(name, nx, ry + rowH / 2 - 2)

      ctx.fillStyle = '#64748b'
      ctx.font = '500 12px "Inter", system-ui, sans-serif'
      ctx.fillText(p.sub || '', nx, ry + rowH / 2 + 14)

      // WAR chip
      ctx.textAlign = 'right'
      ctx.fillStyle = '#0f172a'
      ctx.font = '800 22px "Inter", system-ui, sans-serif'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText((p.war != null ? p.war.toFixed(1) : '-'), baseX + colW - 14, ry + rowH / 2 + 2)
      ctx.fillStyle = '#94a3b8'
      ctx.font = '700 10px "Inter", system-ui, sans-serif'
      ctx.fillText('WAR', baseX + colW - 14, ry + rowH / 2 + 16)
    }
  }

  const hitters = (data.top_hitters || []).map(h => ({
    name: h.name,
    sub: `${fmtAvg(h.woba)} wOBA  •  wRC+ ${h.wrc_plus != null ? Math.round(h.wrc_plus) : '-'}`,
    war: h.offensive_war,
    headshot_url: h.headshot_url,
  }))
  const pitchers = (data.top_pitchers || []).map(h => ({
    name: h.name,
    sub: `${fmtEra(h.siera)} SIERA  •  K% ${h.k_pct != null ? h.k_pct.toFixed(1) + '%' : '-'}`,
    war: h.pitching_war,
    headshot_url: h.headshot_url,
  }))

  await renderList(hitters, pad)
  await renderList(pitchers, SIZE / 2 + 8)
}

async function drawLast5(ctx, data, y, h) {
  const pad = MARGIN
  ctx.fillStyle = '#0f172a'
  ctx.font = '800 18px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText('LAST 5 GAMES', pad, y + 20)

  const games = (data.last_5_games || []).slice(0, 5)
  const startY = y + 30
  const gap = 8
  const cardW = (SIZE - pad * 2 - gap * 4) / 5
  const cardH = h - 38

  for (let i = 0; i < 5; i++) {
    const cx = pad + i * (cardW + gap)
    const game = games[i]

    roundRect(ctx, cx, startY, cardW, cardH, 10)
    if (!game) {
      ctx.fillStyle = '#f1f5f9'
      ctx.fill()
      continue
    }
    const won = game.result === 'W'
    const tied = game.result === 'T'
    ctx.fillStyle = won ? '#ecfdf5' : tied ? '#f1f5f9' : '#fef2f2'
    ctx.fill()
    ctx.strokeStyle = won ? '#10b981' : tied ? '#cbd5e1' : '#ef4444'
    ctx.lineWidth = 2
    ctx.stroke()

    // Top row: W/L pill + H/A + date
    const pillW = 22
    const pillH = 18
    ctx.fillStyle = won ? '#10b981' : tied ? '#64748b' : '#ef4444'
    roundRect(ctx, cx + 10, startY + 10, pillW, pillH, 5)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = '800 12px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(game.result || '-', cx + 10 + pillW / 2, startY + 10 + pillH / 2 + 1)

    ctx.fillStyle = '#64748b'
    ctx.font = '700 11px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    const topRight = `${game.home_away || ''} ${shortDate(game.date)}`.trim()
    ctx.fillText(topRight, cx + cardW - 10, startY + 10 + pillH / 2 + 1)

    // Score (big, centered)
    ctx.fillStyle = '#0f172a'
    ctx.font = '800 26px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const scoreTxt = `${game.team_score ?? '-'}-${game.opp_score ?? '-'}`
    ctx.fillText(scoreTxt, cx + cardW / 2, startY + 46)

    // Bottom: small logo + opp short name
    const logoSize = 20
    const opp = cleanTeamName(game.opponent_short || game.opponent || '').slice(0, 13)
    ctx.font = '700 11px "Inter", system-ui, sans-serif'
    const oppW = ctx.measureText(opp).width
    const totalW = logoSize + 6 + oppW
    const sx = cx + (cardW - totalW) / 2
    const baseY = startY + cardH - 16
    if (game.opponent_logo) {
      try {
        const img = await loadImage(game.opponent_logo)
        ctx.save()
        ctx.beginPath()
        ctx.arc(sx + logoSize / 2, baseY, logoSize / 2, 0, Math.PI * 2)
        ctx.clip()
        ctx.drawImage(img, sx, baseY - logoSize / 2, logoSize, logoSize)
        ctx.restore()
      } catch {
        ctx.fillStyle = '#e2e8f0'
        ctx.beginPath()
        ctx.arc(sx + logoSize / 2, baseY, logoSize / 2, 0, Math.PI * 2)
        ctx.fill()
      }
    } else {
      ctx.fillStyle = '#e2e8f0'
      ctx.beginPath()
      ctx.arc(sx + logoSize / 2, baseY, logoSize / 2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.fillStyle = '#334155'
    ctx.font = '700 11px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(opp, sx + logoSize + 6, baseY)
  }
}

function drawFooter(ctx, data, y, h) {
  ctx.fillStyle = '#0f172a'
  ctx.fillRect(0, y, SIZE, h)
  ctx.fillStyle = '#14b8a6'
  ctx.fillRect(0, y, SIZE, 3)

  ctx.fillStyle = '#ffffff'
  ctx.font = '800 16px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('NW BASEBALL STATS', MARGIN, y + h / 2)

  ctx.fillStyle = '#94a3b8'
  ctx.font = '500 13px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'right'
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  ctx.fillText(`nwbaseballstats.com  •  as of ${today}`, SIZE - MARGIN, y + h / 2)
}

// ─── Main renderer ───
async function renderTeamInfoGraphic(canvas, data) {
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')

  // Background
  ctx.fillStyle = '#f8fafc'
  ctx.fillRect(0, 0, SIZE, SIZE)

  // Zones (y offsets add up to 1080)
  const zones = {
    header: { y: 0, h: 180 },
    record: { y: 180, h: 120 },
    rankings: { y: 300, h: 130 },
    percentiles: { y: 430, h: 260 },
    performers: { y: 690, h: 350 },
    footer: { y: 1040, h: 40 },
  }

  await drawHeader(ctx, data, zones.header.y, zones.header.h)
  drawRecordStrip(ctx, data, zones.record.y, zones.record.h)
  drawRankings(ctx, data, zones.rankings.y, zones.rankings.h)
  drawPercentiles(ctx, data, zones.percentiles.y, zones.percentiles.h)
  await drawPerformers(ctx, data, zones.performers.y, zones.performers.h)
  drawFooter(ctx, data, zones.footer.y, zones.footer.h)
}

// ─── React component ───
export default function TeamInfoGraphic() {
  const [teams, setTeams] = useState([])
  const [selectedTeamId, setSelectedTeamId] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [rendered, setRendered] = useState(false)
  const canvasRef = useRef(null)

  // Fetch PNW teams
  useEffect(() => {
    fetch(`${API_BASE}/teams`)
      .then(r => r.json())
      .then(d => {
        // /teams returns a flat array
        const arr = Array.isArray(d) ? d : (d.teams || [])
        const list = arr.slice().sort((a, b) => {
          const an = cleanTeamName(a.name || a.short_name)
          const bn = cleanTeamName(b.name || b.short_name)
          return an.localeCompare(bn)
        })
        setTeams(list)
      })
      .catch(e => setError(String(e)))
  }, [])

  // Fetch team info when a team is picked
  useEffect(() => {
    if (!selectedTeamId) {
      setData(null)
      return
    }
    setLoading(true)
    setError(null)
    fetch(`${API_BASE}/teams/${selectedTeamId}/info-graphic`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(d => setData(d))
      .catch(e => {
        setError(String(e))
        setData(null)
      })
      .finally(() => setLoading(false))
  }, [selectedTeamId])

  const generate = useCallback(async () => {
    if (!data || !canvasRef.current) return
    try {
      await renderTeamInfoGraphic(canvasRef.current, data)
      setRendered(true)
    } catch (e) {
      setError(String(e))
    }
  }, [data])

  useEffect(() => {
    if (data) generate()
    else setRendered(false)
  }, [data, generate])

  const download = () => {
    if (!canvasRef.current || !data) return
    const link = document.createElement('a')
    const slug = cleanTeamName(data.team.name).replace(/\s+/g, '-').toLowerCase()
    link.download = `team-info-${slug}.png`
    link.href = canvasRef.current.toDataURL('image/png')
    link.click()
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Team Info Graphic</h1>
      <p className="text-sm text-gray-500 mb-5">
        Generate a shareable team overview graphic for any PNW team.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={selectedTeamId}
          onChange={(e) => setSelectedTeamId(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal min-w-[260px]"
        >
          <option value="">Select a team...</option>
          {teams.map(t => {
            const lvl = t.division_level
            const label = lvl
              ? (/^\d+$/.test(String(lvl)) ? `D${lvl}` : String(lvl))
              : ''
            return (
              <option key={t.id} value={t.id}>
                {cleanTeamName(t.name || t.short_name)}
                {label ? ` (${label})` : ''}
              </option>
            )
          })}
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

      {loading && <p className="text-sm text-gray-400 mb-4">Loading team info...</p>}
      {error && <p className="text-sm text-red-500 mb-4">Error: {error}</p>}
      {!selectedTeamId && !loading && (
        <p className="text-sm text-gray-400 mb-4">
          Pick a team above to build the graphic. Only PNW teams with full data are available.
        </p>
      )}

      <div className="rounded-lg overflow-hidden shadow-lg border border-gray-200 inline-block">
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            maxWidth: 540,
            height: 'auto',
            aspectRatio: '1/1',
            display: data ? 'block' : 'none',
          }}
        />
      </div>
    </div>
  )
}
