// WclGameRecapGraphic — canvas-based SINGLE-game WCL recap card.
//   /summer/game-recap   (listed under the Graphics hub; ?game=<id> preselects)
//
// Zooms in on ONE game and renders a FIXED 1080×1350 (Instagram 4:5) PNG:
// centered final, full R/H/E line score, pitching decisions, and each
// side's top hitters. Sections are distributed to fill the canvas so the
// card always uses the full Instagram frame with even spacing.
//
// Download button writes wcl-game-<away>-<home>-<date>.png.

import { useState, useRef, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

const API_BASE = '/api/v1'
const W = 1080
const H = 1350

// ── Colors (WCL navy + gold theme) ─────────────────────────────
const C = {
  navy:       '#14365c',
  navy_dark:  '#0d2240',
  blue:       '#1f5485',
  gold:       '#c9a44c',
  gold_light: '#e2c577',
  bg:         '#f6f1e3',
  card:       '#ffffff',
  text:       '#1a1a1a',
  text_muted: '#5a5a5a',
  text_gray:  '#8a8a8a',
  win:        '#14365c',
  loss:       '#8a8a8a',
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

// ── Star derivation (no per-game WPA → simple box-score math) ──
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
function topHitters(rows, sideIsHome, n = 3) {
  return (rows || [])
    .filter(r => r.is_home === sideIsHome && (r.ab || r.bb) && (r.h || r.rbi || r.bb || r.hr))
    .sort((a, b) => scoreHitter(b) - scoreHitter(a))
    .slice(0, n)
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
  return `${fmtIP(p.ip)} IP, ${p.h || 0} H, ${p.er || 0} ER, ${p.bb || 0} BB, ${p.so || 0} K`
}
function decisions(pitching) {
  const order = { W: 0, L: 1, S: 2 }
  return (pitching || [])
    .filter(p => p.decision && order[p.decision] != null)
    .sort((a, b) => order[a.decision] - order[b.decision])
}

// ── Sections (each takes a TOP edge, returns its BOTTOM edge) ──
function drawHeader(ctx, dateIso, innings) {
  const grad = ctx.createLinearGradient(0, 0, W, 150)
  grad.addColorStop(0, C.navy)
  grad.addColorStop(0.55, C.blue)
  grad.addColorStop(1, C.gold)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, 150)

  ctx.fillStyle = C.gold_light
  ctx.font = '900 14px -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('WEST COAST LEAGUE · GAME RECAP', 40, 48)

  ctx.fillStyle = '#fff'
  ctx.font = '900 44px -apple-system, sans-serif'
  ctx.fillText(fmtDateLong(dateIso), 40, 100)

  const innTxt = innings && innings !== 9 ? `FINAL · ${innings} INNINGS` : 'FINAL'
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = '700 15px -apple-system, sans-serif'
  ctx.fillText(innTxt, 40, 128)
  return 150
}

// Centered head-to-head final: [logo] score – score [logo], names below.
async function drawScoreBlock(ctx, game, top) {
  const cx = W / 2
  const logoSize = 124
  const awayWon = (game.away_score ?? 0) > (game.home_score ?? 0)
  const homeWon = (game.home_score ?? 0) > (game.away_score ?? 0)
  const [awayImg, homeImg] = await Promise.all([tryLoad(game.away_logo), tryLoad(game.home_logo)])
  const logoY = top
  const drawLogo = (img, x) => {
    if (img) drawContain(ctx, img, x - logoSize / 2, logoY, logoSize)
    else { ctx.fillStyle = '#e8e4d6'; roundRect(ctx, x - logoSize / 2, logoY, logoSize, logoSize, 12); ctx.fill() }
  }
  drawLogo(awayImg, 175)
  drawLogo(homeImg, W - 175)

  ctx.textAlign = 'center'
  ctx.font = '900 96px -apple-system, sans-serif'
  ctx.fillStyle = awayWon ? C.win : C.loss
  ctx.fillText(String(game.away_score ?? '—'), cx - 100, logoY + 92)
  ctx.fillStyle = homeWon ? C.win : C.loss
  ctx.fillText(String(game.home_score ?? '—'), cx + 100, logoY + 92)
  ctx.fillStyle = C.text_gray
  ctx.font = '700 44px -apple-system, sans-serif'
  ctx.fillText('–', cx, logoY + 84)

  ctx.font = '800 24px -apple-system, sans-serif'
  const nameY = logoY + logoSize + 34
  ctx.fillStyle = awayWon ? C.navy : C.text_muted
  ctx.fillText(truncate(ctx, game.away_short || game.away_team_name || '—', 320), 175, nameY)
  ctx.fillStyle = homeWon ? C.navy : C.text_muted
  ctx.fillText(truncate(ctx, game.home_short || game.home_team_name || '—', 320), W - 175, nameY)
  return nameY + 16
}

// R/H/E line score grid in a white card.
function drawLineScore(ctx, game, top) {
  const awayLine = game.away_line_score || []
  const homeLine = game.home_line_score || []
  const innCols = Math.max(awayLine.length, homeLine.length, game.innings || 9)

  const padX = 40
  const cardX = padX
  const cardW = W - padX * 2
  const labelW = 170
  const rheW = 60
  const gridW = cardW - labelW - rheW * 3 - 24
  const colW = gridW / innCols
  const rowH = 46
  const cardH = rowH * 3 + 22

  ctx.fillStyle = C.card
  roundRect(ctx, cardX, top, cardW, cardH, 14)
  ctx.fill()
  ctx.strokeStyle = 'rgba(20,54,92,0.15)'
  ctx.lineWidth = 1
  ctx.stroke()

  const colX = (i) => cardX + 14 + labelW + i * colW + colW / 2
  const rheX = (k) => cardX + 14 + labelW + gridW + 12 + k * rheW + rheW / 2
  const headY = top + 32
  const r1Y = headY + rowH
  const r2Y = r1Y + rowH

  ctx.textAlign = 'center'
  ctx.font = '800 16px -apple-system, sans-serif'
  ctx.fillStyle = C.text_gray
  for (let i = 0; i < innCols; i++) ctx.fillText(String(i + 1), colX(i), headY)
  ctx.fillStyle = C.navy
  ctx.font = '900 16px -apple-system, sans-serif'
  ;['R', 'H', 'E'].forEach((h, k) => ctx.fillText(h, rheX(k), headY))

  const drawRow = (label, line, r, h, e, y, won) => {
    ctx.textAlign = 'left'
    ctx.font = (won ? '900 ' : '700 ') + '18px -apple-system, sans-serif'
    ctx.fillStyle = won ? C.navy : C.text_muted
    ctx.fillText(truncate(ctx, label || '—', labelW - 6), cardX + 16, y)
    ctx.textAlign = 'center'
    ctx.font = '600 17px -apple-system, sans-serif'
    ctx.fillStyle = C.text
    for (let i = 0; i < innCols; i++) ctx.fillText(fmtCell(line[i]), colX(i), y)
    ctx.font = '800 18px -apple-system, sans-serif'
    ctx.fillStyle = won ? C.navy : C.text
    ctx.fillText(String(r ?? '—'), rheX(0), y)
    ctx.font = '600 17px -apple-system, sans-serif'
    ctx.fillStyle = C.text_muted
    ctx.fillText(String(h ?? '—'), rheX(1), y)
    ctx.fillText(String(e ?? '—'), rheX(2), y)
  }
  const awayWon = (game.away_score ?? 0) > (game.home_score ?? 0)
  const homeWon = (game.home_score ?? 0) > (game.away_score ?? 0)
  drawRow(game.away_short || game.away_team_name, awayLine,
          game.away_score, game.away_hits, game.away_errors, r1Y, awayWon)
  ctx.strokeStyle = 'rgba(0,0,0,0.08)'
  ctx.beginPath(); ctx.moveTo(cardX + 16, r1Y + 13); ctx.lineTo(cardX + cardW - 16, r1Y + 13); ctx.stroke()
  drawRow(game.home_short || game.home_team_name, homeLine,
          game.home_score, game.home_hits, game.home_errors, r2Y, homeWon)
  return top + cardH
}

function sectionTitle(ctx, text, x, baseY) {
  ctx.textAlign = 'left'
  ctx.font = '900 17px -apple-system, sans-serif'
  ctx.fillStyle = C.gold
  ctx.fillText(text, x, baseY)
  // small gold rule under the title
  const w = ctx.measureText(text).width
  ctx.strokeStyle = 'rgba(201,164,76,0.45)'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(x, baseY + 7); ctx.lineTo(x + w, baseY + 7); ctx.stroke()
}

function drawDecisions(ctx, decs, top) {
  const padX = 40
  sectionTitle(ctx, 'PITCHING DECISIONS', padX, top + 18)
  let y = top + 18 + 34
  const labelFor = { W: 'W', L: 'L', S: 'SV' }
  decs.forEach((p) => {
    ctx.textAlign = 'left'
    ctx.font = '900 17px -apple-system, sans-serif'
    ctx.fillStyle = p.decision === 'W' ? C.win : (p.decision === 'L' ? C.loss : C.gold)
    ctx.fillText(labelFor[p.decision], padX, y)
    ctx.font = '700 17px -apple-system, sans-serif'
    ctx.fillStyle = C.text
    ctx.fillText(truncate(ctx, p.player_name || '', 360), padX + 46, y)
    ctx.font = '500 15px -apple-system, sans-serif'
    ctx.fillStyle = C.text_muted
    ctx.textAlign = 'right'
    ctx.fillText(pitcherLine(p), W - padX, y)
    y += 32
  })
  return y - 12
}

function drawHitters(ctx, game, away, home, top) {
  const padX = 40
  sectionTitle(ctx, 'TOP HITTERS', padX, top + 18)
  const colW = (W - padX * 2 - 30) / 2
  const colX = [padX, padX + colW + 30]
  const cols = [
    { name: game.away_short || game.away_team_name, hitters: away },
    { name: game.home_short || game.home_team_name, hitters: home },
  ]
  let maxY = top
  cols.forEach((col, ci) => {
    const x = colX[ci]
    let y = top + 18 + 34
    ctx.textAlign = 'left'
    ctx.font = '800 16px -apple-system, sans-serif'
    ctx.fillStyle = C.navy
    ctx.fillText(truncate(ctx, col.name || '—', colW), x, y)
    y += 30
    if (!col.hitters.length) {
      ctx.font = '500 15px -apple-system, sans-serif'
      ctx.fillStyle = C.text_gray
      ctx.fillText('—', x, y)
      y += 28
    }
    col.hitters.forEach((b) => {
      ctx.font = '700 17px -apple-system, sans-serif'
      ctx.fillStyle = C.text
      const nm = b.position ? `${b.player_name} · ${String(b.position).toUpperCase()}` : b.player_name
      ctx.fillText(truncate(ctx, nm || '', colW), x, y)
      y += 23
      ctx.font = '500 15px -apple-system, sans-serif'
      ctx.fillStyle = C.text_muted
      ctx.fillText(truncate(ctx, hitterLine(b), colW), x, y)
      y += 33
    })
    maxY = Math.max(maxY, y)
  })
  return maxY
}

function drawFooter(ctx) {
  ctx.fillStyle = C.navy_dark
  ctx.fillRect(0, H - 64, W, 64)
  ctx.fillStyle = '#fff'
  ctx.font = '700 15px -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('nwbaseballstats.com/summer', 40, H - 26)
  ctx.font = '500 13px -apple-system, sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.textAlign = 'right'
  ctx.fillText('@nwbaseballstats', W - 40, H - 26)
}

// ── Main renderer (fixed 1080×1350, sections distributed to fill) ─
async function renderGameCard(canvas, data) {
  const game = data.game
  const decs = decisions(data.pitching)
  const awayHit = topHitters(data.batting, false, 3)
  const homeHit = topHitters(data.batting, true, 3)
  const innings = Math.max(
    (game.away_line_score || []).length,
    (game.home_line_score || []).length,
    game.innings || 9,
  )

  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, W, H)

  const HEADER_H = 150
  const FOOTER_H = 64
  // Natural heights of the four middle sections.
  const SCORE_H = 124 + 34 + 16 + 16          // logo + name + padding
  const LINE_H = 46 * 3 + 22
  const DECS_H = 18 + 34 + Math.max(1, decs.length) * 32
  const hitRows = Math.max(awayHit.length, homeHit.length, 1)
  const HIT_H = 18 + 34 + 30 + hitRows * 56
  const content = SCORE_H + LINE_H + DECS_H + HIT_H
  // Distribute leftover space across 5 gaps (top, 3 between, bottom).
  const gap = Math.max(26, Math.min(90, (H - HEADER_H - FOOTER_H - content) / 5))

  drawHeader(ctx, game.game_date, innings)
  let y = HEADER_H + gap
  y = await drawScoreBlock(ctx, game, y) + gap
  y = drawLineScore(ctx, game, y) + gap
  y = drawDecisions(ctx, decs, y) + gap
  drawHitters(ctx, game, awayHit, homeHit, y)
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
        const r = await fetch(`${API_BASE}/summer/scoreboard?league=WCL&season=2026&days_back=120&days_ahead=3`)
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
        Pick any final WCL game and download a share-ready 1080×1350 (Instagram) card with the full line score, runs / hits / errors, pitching decisions, and top hitters.
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
