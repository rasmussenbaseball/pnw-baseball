// TeamSeasonRecapGraphic — /team-season-recap
//
// End-of-year, positive-only team snapshot for Instagram/X. Pick a spring
// team and render a 1080x1350 PNG: record + conference standing and
// longest win streak up top; big WAR cards for Best Hitter, Best Pitcher,
// and Freshman of the Year; a "led the conference in X" superlative; and
// the team's most clutch moment (highest-WPA play). Data from
// /teams/{id}/season-recap. Mirrors the canvas patterns + teal/slate
// theme used across the site's other social graphics.

import { useState, useRef, useCallback, useEffect } from 'react'

const API_BASE = '/api/v1'
const W = 1080

// ── Theme (NWBB teal + slate) ──────────────────────────────────
const C = {
  teal:       '#0e7490',
  teal_dark:  '#0c4a52',
  teal_light: '#22d3ee',
  slate:      '#1e293b',
  slate_2:    '#334155',
  bg:         '#eef2f6',
  card:       '#ffffff',
  text:       '#1e293b',
  muted:      '#64748b',
  faint:      '#94a3b8',
  gold:       '#d97706',
  win:        '#0e7490',
}

// ── Helpers ────────────────────────────────────────────────────
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
  if (b[0] === '1') on.push('1st')
  if (b[1] === '1') on.push('2nd')
  if (b[2] === '1') on.push('3rd')
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
function drawCircleImg(ctx, img, cx, cy, r) {
  ctx.save()
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath(); ctx.clip()
  if (img) ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2)
  else { ctx.fillStyle = '#e2e8f0'; ctx.fillRect(cx - r, cy - r, r * 2, r * 2) }
  ctx.restore()
}

// ── Sections ───────────────────────────────────────────────────
async function drawHeader(ctx, data) {
  const t = data.team
  const grad = ctx.createLinearGradient(0, 0, W, 200)
  grad.addColorStop(0, C.teal_dark); grad.addColorStop(0.6, C.teal); grad.addColorStop(1, C.teal_light)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, 200)

  const logo = await tryLoad(t.logo_url)
  if (logo) ctx.drawImage(logo, 40, 38, 124, 124)
  else { ctx.fillStyle = 'rgba(255,255,255,0.15)'; roundRect(ctx, 40, 38, 124, 124, 12); ctx.fill() }

  const tx = 188
  ctx.textAlign = 'left'
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = '900 16px -apple-system, sans-serif'
  ctx.fillText(`${data.season} SEASON IN REVIEW`, tx, 66)

  ctx.fillStyle = '#fff'
  ctx.font = '900 52px -apple-system, sans-serif'
  ctx.fillText(truncate(ctx, cleanTeamName(t.name), W - tx - 40), tx, 120)

  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.font = '600 20px -apple-system, sans-serif'
  const lvl = t.division_level ? (/^\d+$/.test(String(t.division_level)) ? `NCAA D${t.division_level}` : String(t.division_level)) : ''
  ctx.fillText([lvl, t.conference_name].filter(Boolean).join('  ·  '), tx, 154)
}

function drawTopBoxes(ctx, data, top) {
  const rec = data.record || {}
  const pad = 40, gap = 16
  const boxW = (W - pad * 2 - gap) / 2
  const boxH = 110
  const boxes = [
    { label: 'RECORD', big: `${rec.wins ?? 0}-${rec.losses ?? 0}`,
      sub: rec.conference_wins != null
        ? `${rec.conference_wins}-${rec.conference_losses} ${data.team.conference_abbrev || 'conf'}` +
          (rec.conference_place_ordinal ? `  ·  ${rec.conference_place_ordinal} of ${rec.conference_total}` : '')
        : '' },
    { label: 'LONGEST WIN STREAK', big: `${data.longest_win_streak ?? 0}`,
      sub: (data.longest_win_streak === 1 ? 'game' : 'games') + ' in a row' },
  ]
  boxes.forEach((b, i) => {
    const x = pad + i * (boxW + gap)
    ctx.fillStyle = C.card; roundRect(ctx, x, top, boxW, boxH, 14); ctx.fill()
    ctx.strokeStyle = 'rgba(14,116,144,0.18)'; ctx.lineWidth = 1; ctx.stroke()
    ctx.textAlign = 'left'
    ctx.fillStyle = C.teal; ctx.font = '800 13px -apple-system, sans-serif'
    ctx.fillText(b.label, x + 20, top + 30)
    ctx.fillStyle = C.text; ctx.font = '900 40px -apple-system, sans-serif'
    ctx.fillText(b.big, x + 20, top + 76)
    ctx.fillStyle = C.muted; ctx.font = '600 15px -apple-system, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(b.sub, x + boxW - 20, top + 70)
  })
  return top + boxH
}

async function drawPlayerCard(ctx, top, label, labelColor, player, kind, teamLogoUrl) {
  const pad = 40, x = pad, w = W - pad * 2, h = 150
  ctx.fillStyle = C.card; roundRect(ctx, x, top, w, h, 16); ctx.fill()
  ctx.strokeStyle = 'rgba(14,116,144,0.18)'; ctx.lineWidth = 1; ctx.stroke()

  // Label tag
  ctx.textAlign = 'left'
  ctx.fillStyle = labelColor; ctx.font = '900 14px -apple-system, sans-serif'
  ctx.fillText(label, x + 24, top + 32)

  // Headshot (fallback to team logo)
  const img = await tryLoad(player.headshot_url) || await tryLoad(teamLogoUrl)
  const cy = top + h / 2 + 12
  drawCircleImg(ctx, img, x + 70, cy, 42)

  const colX = x + 130
  // Name
  ctx.fillStyle = C.text; ctx.font = '800 30px -apple-system, sans-serif'
  const nm = `${player.first_name} ${player.last_name}`
  const yr = player.year_in_school ? `  ${player.year_in_school}` : ''
  ctx.fillText(truncate(ctx, nm, w - 320), colX, top + 78)
  // class-year tag
  if (yr) {
    const nmW = ctx.measureText(truncate(ctx, nm, w - 320)).width
    ctx.fillStyle = C.faint; ctx.font = '700 18px -apple-system, sans-serif'
    ctx.fillText(yr.trim(), colX + nmW + 12, top + 78)
  }

  // Stat lines
  let l1 = '', l2 = ''
  if (kind === 'hitter') {
    l1 = `${fmtAvg(player.woba)} wOBA   ·   ${player.wrc_plus != null ? Math.round(player.wrc_plus) : '-'} wRC+`
    l2 = `${player.pa ?? 0} PA   ·   ${player.hr ?? 0} HR   ·   ${player.rbi ?? 0} RBI   ·   ${player.sb ?? 0} SB`
  } else {
    l1 = `${fmtEra(player.siera)} SIERA   ·   ${fmtPct(player.k_pct)} K`
    l2 = `${fmtIp(player.ip)} IP   ·   ${fmtAvg(player.baa)} BAA`
  }
  ctx.fillStyle = C.slate_2; ctx.font = '600 18px -apple-system, sans-serif'
  ctx.fillText(l1, colX, top + 108)
  ctx.fillStyle = C.muted; ctx.font = '500 16px -apple-system, sans-serif'
  ctx.fillText(l2, colX, top + 134)

  // Big WAR
  ctx.textAlign = 'right'
  ctx.fillStyle = C.teal; ctx.font = '900 56px -apple-system, sans-serif'
  ctx.fillText(fmtWar(player.war), x + w - 28, cy + 6)
  ctx.fillStyle = C.faint; ctx.font = '800 16px -apple-system, sans-serif'
  ctx.fillText('WAR', x + w - 28, cy + 34)

  return top + h
}

function drawSuperlative(ctx, sup, top) {
  if (!sup) return top
  const pad = 40, x = pad, w = W - pad * 2, h = 70
  ctx.fillStyle = C.slate; roundRect(ctx, x, top, w, h, 14); ctx.fill()
  ctx.textAlign = 'left'
  ctx.fillStyle = C.teal_light; ctx.font = '900 13px -apple-system, sans-serif'
  ctx.fillText('THEY EXCELLED AT', x + 24, top + 28)
  ctx.fillStyle = '#fff'; ctx.font = '700 24px -apple-system, sans-serif'
  ctx.fillText(truncate(ctx, sup.text, w - 48), x + 24, top + 56)
  return top + h
}

async function drawClutch(ctx, cm, top) {
  if (!cm) return top
  const pad = 40, x = pad, w = W - pad * 2, h = 180
  ctx.fillStyle = C.card; roundRect(ctx, x, top, w, h, 16); ctx.fill()
  ctx.strokeStyle = 'rgba(14,116,144,0.18)'; ctx.lineWidth = 1; ctx.stroke()

  ctx.textAlign = 'left'
  ctx.fillStyle = C.gold; ctx.font = '900 14px -apple-system, sans-serif'
  ctx.fillText('MOST CLUTCH MOMENT OF THE YEAR', x + 24, top + 32)

  // WPA pill
  const wpa = cm.wpa != null ? `+${cm.wpa.toFixed(2)}` : ''
  ctx.fillStyle = C.win; roundRect(ctx, x + 24, top + 46, 92, 40, 8); ctx.fill()
  ctx.fillStyle = '#fff'; ctx.font = '900 22px -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(wpa, x + 24 + 46, top + 73)
  ctx.fillStyle = C.faint; ctx.font = '700 11px -apple-system, sans-serif'

  // Headline
  ctx.textAlign = 'left'
  const hx = x + 132
  ctx.fillStyle = C.text; ctx.font = '800 24px -apple-system, sans-serif'
  const headline = `${cm.batter_name} ${(cm.result_type || '').replace(/_/g, ' ')}`
  ctx.fillText(truncate(ctx, headline, w - 160), hx, top + 70)
  // Situation line
  const lead = (cm.bat_score_before ?? 0) - (cm.fld_score_before ?? 0)
  const leadTxt = lead === 0 ? 'tied' : lead > 0 ? `up ${lead}` : `down ${-lead}`
  const half = cm.half === 'bottom' ? 'B' : 'T'
  const situation = [
    `${half}${cm.inning}`,
    `${leadTxt} (${cm.bat_score_before}-${cm.fld_score_before})`,
    basesText(cm.bases_before),
    `${cm.outs_before} out`,
    `${cm.home_away} ${cm.opponent_short || ''}`,
    shortDate(cm.game_date),
  ].filter(Boolean).join('   ·   ')
  ctx.fillStyle = C.muted; ctx.font = '500 15px -apple-system, sans-serif'
  ctx.fillText(truncate(ctx, situation, w - 160), hx, top + 96)

  // Narrative
  ctx.fillStyle = C.slate_2; ctx.font = 'italic 500 15px -apple-system, sans-serif'
  ctx.fillText(truncate(ctx, `"${cm.result_text || ''}"`, w - 48), x + 24, top + 132)

  // WP swing
  if (cm.wp_before != null && cm.wp_after != null) {
    ctx.fillStyle = C.text; ctx.font = '700 15px -apple-system, sans-serif'
    ctx.fillText(
      `Win probability swung from ${Math.round(cm.wp_before * 100)}% to ${Math.round(cm.wp_after * 100)}%`,
      x + 24, top + 160)
  }
  return top + h
}

function drawFooter(ctx, y) {
  ctx.fillStyle = C.slate
  ctx.fillRect(0, y, W, 60)
  ctx.textAlign = 'left'
  ctx.fillStyle = '#fff'; ctx.font = '700 15px -apple-system, sans-serif'
  ctx.fillText('nwbaseballstats.com', 40, y + 38)
  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '500 13px -apple-system, sans-serif'
  ctx.fillText('@nwbaseballstats', W - 40, y + 38)
}

// ── Main renderer ──────────────────────────────────────────────
async function renderRecap(canvas, data) {
  const HEADER = 200, GAP = 18, FOOTER = 60
  const hasFr = !!data.freshman_of_year
  const hasSup = !!data.superlative
  const hasClutch = !!data.clutch_moment
  let H = HEADER + 24
  H += 110 + GAP            // top boxes
  H += (150 + GAP) * 2      // hitter + pitcher
  if (hasFr) H += 150 + GAP
  if (hasSup) H += 70 + GAP
  if (hasClutch) H += 180 + GAP
  H += 8 + FOOTER

  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, W, H)

  await drawHeader(ctx, data)
  let y = HEADER + 24
  y = drawTopBoxes(ctx, data, y) + GAP
  const logoUrl = data.team.logo_url
  if (data.best_hitter)
    y = await drawPlayerCard(ctx, y, 'BEST HITTER', C.teal, data.best_hitter, 'hitter', logoUrl) + GAP
  if (data.best_pitcher)
    y = await drawPlayerCard(ctx, y, 'BEST PITCHER', C.teal, data.best_pitcher, 'pitcher', logoUrl) + GAP
  if (hasFr) {
    const fr = data.freshman_of_year
    y = await drawPlayerCard(ctx, y, 'FRESHMAN OF THE YEAR', C.gold, fr, fr.kind, logoUrl) + GAP
  }
  if (hasSup) y = drawSuperlative(ctx, data.superlative, y) + GAP
  if (hasClutch) y = await drawClutch(ctx, data.clutch_moment, y) + GAP
  drawFooter(ctx, H - FOOTER)
}

// ───────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────
export default function TeamSeasonRecapGraphic() {
  const [teams, setTeams] = useState([])
  const [selectedTeamId, setSelectedTeamId] = useState('')
  const [season, setSeason] = useState(2026)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [rendered, setRendered] = useState(false)
  const canvasRef = useRef(null)

  useEffect(() => {
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
      <h1 className="text-2xl font-bold text-pnw-slate dark:text-gray-100 mb-1">Team Season Recap Graphic</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        End-of-year, positive-only team snapshot for Instagram/X — record, win streak, WAR leaders,
        freshman of the year, a team superlative, and the season's most clutch moment.
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
        <p className="text-sm text-gray-400 mb-4">Pick a spring team above to build the recap.</p>
      )}

      <div className="rounded-lg overflow-hidden shadow-lg border border-gray-200 dark:border-gray-700 inline-block">
        <canvas
          ref={canvasRef}
          style={{ width: '100%', maxWidth: 540, height: 'auto', display: data ? 'block' : 'none' }}
        />
      </div>
    </div>
  )
}
