import { useState, useRef, useCallback, useEffect } from 'react'

const API_BASE = '/api/v1'

// ────────────────────────────────────────────
// Palette — teal background, brighter teal cards for contrast,
// gold championship accent so the trophy game stands out.
// ────────────────────────────────────────────
const PALETTE = {
  bg: '#062029',
  bgGradTop: '#082e3a',
  bgGradBottom: '#04181f',
  card: '#1a5f74',          // brighter than bg, real contrast
  cardEliminated: '#0f3e4a',
  cardChampionship: '#266b85',
  border: '#3aa3bd',        // brighter teal border for visibility
  borderBright: '#5fd4eb',
  championshipBorder: '#ffd54f',  // gold for the trophy game
  accent: '#5fd4eb',        // bright cyan for section labels
  accentDim: '#a7edff',
  textPrimary: '#ffffff',
  textSecondary: '#cef0fa',
  textMuted: 'rgba(255,255,255,0.50)',
  scoreBoxBorder: 'rgba(255,255,255,0.25)',
  scoreBoxText: 'rgba(255,255,255,0.40)',
  connector: '#3aa3bd',
  ifNecessaryDim: 'rgba(255,255,255,0.12)',
  topStrip: 'rgba(0,0,0,0.45)',
}

// ────────────────────────────────────────────
// Tournament data (CCC v1)
// ────────────────────────────────────────────

const TOURNAMENTS = {
  ccc_2026: {
    label: 'CCC Tournament',
    sub: 'May 1 to 4, Lewis-Clark State',
    season: 2026,
    seeds: [
      { seed: 1, team_id: 22,   name: 'Lewis-Clark State' },
      { seed: 2, team_id: 5720, name: 'British Columbia' },
      { seed: 3, team_id: 21,   name: 'College of Idaho' },
      { seed: 4, team_id: 24,   name: 'Bushnell' },
      { seed: 5, team_id: 20,   name: 'Oregon Tech' },
    ],
    games: [
      { num: 1, day: 'Fri May 1', time: '11:00 AM', home: { ref: 'seed', val: 4 },     away: { ref: 'seed', val: 5 } },
      { num: 2, day: 'Fri May 1', time: '2:30 PM',  home: { ref: 'seed', val: 2 },     away: { ref: 'seed', val: 3 } },
      { num: 3, day: 'Fri May 1', time: '6:00 PM',  home: { ref: 'seed', val: 1 },     away: { ref: 'winner', game: 1 } },
      { num: 4, day: 'Sat May 2', time: '11:00 AM', home: { ref: 'loser',  game: 1 },  away: { ref: 'loser',  game: 2 } },
      { num: 5, day: 'Sat May 2', time: '2:30 PM',  home: { ref: 'winner', game: 2 },  away: { ref: 'winner', game: 3 } },
      { num: 6, day: 'Sat May 2', time: '6:00 PM',  home: { ref: 'loser',  game: 3 },  away: { ref: 'winner', game: 4 } },
      { num: 7, day: 'Sun May 3', time: '11:00 AM', home: { ref: 'winner', game: 6 },  away: { ref: 'loser',  game: 5 } },
      { num: 8, day: 'Sun May 3', time: '2:30 PM',  home: { ref: 'winner', game: 7 },  away: { ref: 'winner', game: 5 } },
      { num: 9, day: 'Mon May 4', time: '11:00 AM', home: { ref: 'winner', game: 7 },  away: { ref: 'winner', game: 5 }, ifNecessary: true },
    ],
  },
}

// Canvas dimensions — 1920x1080 (16:9). Brackets flow left-to-right and
// need horizontal room.
const CANVAS_W = 1920
const CANVAS_H = 1080

// Explicit bracket positions: { gameNum: { x, y, w, h } } in 1920x1080.
//
// Column structure (4 columns):
//   Col 1: G1 (WB R1 play-in)         + G4 (LB R1)
//   Col 2: G2, G3 (WB R2 / QF byes)   + G6 (LB R2)
//   Col 3: G5 (WB Final)              + G7 (LB Final)
//   Col 4: G8 + G9 (Championship)
//
// G2 and G3 sit together in Col 2 because both are bye-round QFs —
// #2 vs #3 and #1 vs play-in winner. G4's LG1 + LG2 inputs come from
// G1 (Col 1 WB) and G2 (Col 2 WB), so G4 chronologically follows them
// but visually we shift it to Col 1 since the LB now starts there.
const LAYOUT = {
  // Winner's bracket (top half)
  1: { x: 60,   y: 400, w: 380, h: 120 },  // G1: 4 vs 5  (R1 play-in)
  2: { x: 500,  y: 240, w: 380, h: 120 },  // G2: 2 vs 3  (R2/QF, BYE)
  3: { x: 500,  y: 400, w: 380, h: 120 },  // G3: 1 vs WG1 (R2/QF, BYE)
  5: { x: 940,  y: 320, w: 380, h: 120 },  // G5: WG2 vs WG3 (WB Final)
  // Championship (far right, y centered between G5 and G7)
  8: { x: 1380, y: 540, w: 380, h: 130 },  // G8: WG5 vs WG7
  9: { x: 1380, y: 685, w: 380, h: 40 },   // G9: rematch (if necessary)
  // Loser's bracket (bottom half) — now starts in Col 1
  4: { x: 60,   y: 720, w: 380, h: 120 },  // G4: LG1 vs LG2 (LB R1)
  6: { x: 500,  y: 760, w: 380, h: 120 },  // G6: LG3 vs WG4 (LB R2)
  7: { x: 940,  y: 800, w: 380, h: 120 },  // G7: WG6 vs LG5 (LB Final)
}

// Connections drawn as bracket lines: from→to
const CONNECTIONS = [
  // Winner's bracket
  { from: 1, to: 3 },   // G1 winner → G3
  { from: 2, to: 5 },   // G2 winner → G5
  { from: 3, to: 5 },   // G3 winner → G5
  { from: 5, to: 8 },   // G5 winner → G8 (championship)
  // Loser's bracket
  { from: 4, to: 6 },   // G4 winner → G6
  { from: 6, to: 7 },   // G6 winner → G7
  { from: 7, to: 8 },   // G7 winner → G8 (championship)
]

// ────────────────────────────────────────────
// Image cache + helpers
// ────────────────────────────────────────────

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

function shortLabelForRef(ref, seedMap) {
  if (ref.ref === 'seed') {
    const s = seedMap[ref.val]
    return { name: s?.name || `Seed ${ref.val}`, seed: ref.val, team_id: s?.team_id }
  }
  if (ref.ref === 'winner') return { name: `Winner G${ref.game}`, placeholder: true }
  if (ref.ref === 'loser')  return { name: `Loser G${ref.game}`,  placeholder: true }
  return { name: '???', placeholder: true }
}

// ────────────────────────────────────────────
// Renderer
// ────────────────────────────────────────────

async function renderBracket(canvas, tournament, teamLogoMap) {
  const W = CANVAS_W, H = CANVAS_H
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  // Background — vertical teal gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H)
  bgGrad.addColorStop(0, PALETTE.bgGradTop)
  bgGrad.addColorStop(1, PALETTE.bgGradBottom)
  ctx.fillStyle = bgGrad
  ctx.fillRect(0, 0, W, H)

  // Header bar
  const headerH = 72
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, W, headerH)
  ctx.fillStyle = PALETTE.accent
  ctx.fillRect(0, headerH - 3, W, 3)

  // NW logo on left
  try {
    const nwImg = await loadImage('/images/nw-logo-white.png')
    const a = nwImg.naturalWidth / nwImg.naturalHeight
    const size = 44
    let dw = size, dh = size
    if (a >= 1) dh = size / a; else dw = size * a
    ctx.drawImage(nwImg, 24, (headerH - 3 - dh) / 2, dw, dh)
  } catch { /* skip */ }

  // Header title
  ctx.fillStyle = PALETTE.textPrimary
  ctx.font = 'bold 22px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('NW BASEBALL STATS', 84, (headerH - 3) / 2)

  ctx.textAlign = 'right'
  ctx.fillStyle = PALETTE.accentDim
  ctx.font = '15px system-ui, sans-serif'
  ctx.fillText('nwbaseballstats.com', W - 24, (headerH - 3) / 2)

  // Title + subtitle (centered)
  ctx.textAlign = 'center'
  ctx.fillStyle = PALETTE.textPrimary
  ctx.font = 'bold 64px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.fillText(tournament.label.toUpperCase(), W / 2, headerH + 64)

  ctx.fillStyle = PALETTE.accentDim
  ctx.font = '24px system-ui, sans-serif'
  ctx.fillText(tournament.sub, W / 2, headerH + 110)

  ctx.fillStyle = PALETTE.textMuted
  ctx.font = 'italic 16px system-ui, sans-serif'
  ctx.fillText('Double-elimination bracket', W / 2, headerH + 138)

  // Section labels
  drawSectionLabel(ctx, "WINNER'S BRACKET", 60,   210, 1000)
  drawSectionLabel(ctx, "CHAMPIONSHIP",     1380, 510, 380, true)
  drawSectionLabel(ctx, "LOSER'S BRACKET",  60,   690, 1000)

  // Build maps for game lookup
  const seedMap = {}
  for (const s of tournament.seeds) seedMap[s.seed] = s

  const gamesByNum = {}
  for (const g of tournament.games) gamesByNum[g.num] = g

  // Draw connector lines first (so cards sit on top)
  ctx.strokeStyle = PALETTE.connector
  ctx.lineWidth = 3
  ctx.lineJoin = 'round'
  for (const conn of CONNECTIONS) {
    const a = LAYOUT[conn.from]
    const b = LAYOUT[conn.to]
    if (!a || !b) continue
    drawConnector(ctx, a, b)
  }

  // Draw all game cards
  for (const g of tournament.games) {
    const pos = LAYOUT[g.num]
    if (!pos) continue
    if (g.ifNecessary) {
      await drawIfNecessaryCard(ctx, g, pos, seedMap, teamLogoMap)
    } else {
      await drawGameCard(ctx, g, pos, seedMap, teamLogoMap)
    }
  }

  // Footer
  ctx.fillStyle = PALETTE.textMuted
  ctx.font = '15px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('Bracket format · Final scores will populate when games complete', W / 2, H - 28)
}

function drawSectionLabel(ctx, text, x, y, w, centered = false) {
  ctx.fillStyle = PALETTE.accent
  ctx.font = 'bold 22px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  if (centered) {
    ctx.textAlign = 'center'
    ctx.fillText(text, x + w / 2, y)
  } else {
    ctx.textAlign = 'left'
    ctx.fillText(text, x, y)
  }
  // Subtle underline accent
  ctx.fillStyle = PALETTE.accent
  if (centered) {
    const tw = ctx.measureText(text).width
    ctx.fillRect(x + (w - tw) / 2, y + 16, tw, 2)
  } else {
    ctx.fillRect(x, y + 16, ctx.measureText(text).width, 2)
  }
}

function drawConnector(ctx, a, b) {
  // Draw a stepped connector from right edge of `a` (mid-height) to left edge of `b` (mid-height).
  const x1 = a.x + a.w
  const y1 = a.y + a.h / 2
  const x2 = b.x
  const y2 = b.y + b.h / 2
  const midX = (x1 + x2) / 2
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(midX, y1)
  ctx.lineTo(midX, y2)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

async function drawGameCard(ctx, game, pos, seedMap, teamLogoMap) {
  const { x, y, w, h } = pos
  const isChamp = game.num === 8

  // Card bg
  ctx.fillStyle = isChamp ? PALETTE.cardChampionship : PALETTE.card
  roundRect(ctx, x, y, w, h, 10)
  ctx.fill()

  // Card border — gold for the championship, bright teal for the rest
  ctx.strokeStyle = isChamp ? PALETTE.championshipBorder : PALETTE.border
  ctx.lineWidth = isChamp ? 2.5 : 1.6
  ctx.stroke()

  // Top strip with game number + time + day
  const stripH = 28
  ctx.fillStyle = PALETTE.topStrip
  roundRect(ctx, x, y, w, stripH, 10)
  ctx.fill()
  ctx.fillRect(x, y + 14, w, stripH - 14)

  // Game number badge
  ctx.fillStyle = isChamp ? PALETTE.championshipBorder : PALETTE.accent
  ctx.font = 'bold 14px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(`G${game.num}`, x + 12, y + 14)

  // Day + time
  ctx.fillStyle = PALETTE.textSecondary
  ctx.font = '13px system-ui, sans-serif'
  ctx.fillText(`${game.day} · ${game.time}`, x + 46, y + 14)

  // Two team rows
  const homeRef = shortLabelForRef(game.home, seedMap)
  const awayRef = shortLabelForRef(game.away, seedMap)
  const rowTop = y + stripH
  const rowH = (h - stripH) / 2

  await drawTeamRow(ctx, awayRef, x, rowTop,         w, rowH, teamLogoMap)
  // Divider line between teams
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x + 10, rowTop + rowH)
  ctx.lineTo(x + w - 10, rowTop + rowH)
  ctx.stroke()
  await drawTeamRow(ctx, homeRef, x, rowTop + rowH, w, rowH, teamLogoMap)
}

async function drawIfNecessaryCard(ctx, game, pos, seedMap, teamLogoMap) {
  const { x, y, w, h } = pos
  ctx.fillStyle = 'rgba(255,255,255,0.05)'
  roundRect(ctx, x, y, w, h, 6)
  ctx.fill()
  ctx.strokeStyle = PALETTE.ifNecessaryDim
  ctx.lineWidth = 1.2
  ctx.setLineDash([5, 4])
  ctx.stroke()
  ctx.setLineDash([])

  ctx.fillStyle = PALETTE.textMuted
  ctx.font = 'italic 14px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`G${game.num} · ${game.day} ${game.time} (if necessary)`, x + w / 2, y + h / 2)
}

async function drawTeamRow(ctx, teamRef, x, y, w, h, teamLogoMap) {
  // Logo or placeholder
  const logoSize = Math.min(h - 12, 38)
  const logoX = x + 10
  const logoY = y + (h - logoSize) / 2

  if (teamRef.team_id) {
    const url = teamLogoMap.get(teamRef.team_id)
    if (url) {
      try {
        const img = await loadImage(url)
        const a = img.naturalWidth / img.naturalHeight
        let dw = logoSize, dh = logoSize
        if (a >= 1) dh = logoSize / a; else dw = logoSize * a
        ctx.drawImage(img, logoX + (logoSize - dw) / 2, logoY + (logoSize - dh) / 2, dw, dh)
      } catch { /* skip */ }
    }
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.10)'
    ctx.beginPath()
    ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2 - 1, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = PALETTE.textMuted
    ctx.font = 'bold 18px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('?', logoX + logoSize / 2, logoY + logoSize / 2)
  }

  // Seed badge
  const afterLogoX = logoX + logoSize + 12
  let nameStartX = afterLogoX
  if (teamRef.seed) {
    const seedW = 28
    ctx.fillStyle = PALETTE.border
    roundRect(ctx, afterLogoX, y + h / 2 - 12, seedW, 24, 4)
    ctx.fill()
    ctx.fillStyle = PALETTE.textPrimary
    ctx.font = 'bold 13px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`#${teamRef.seed}`, afterLogoX + seedW / 2, y + h / 2)
    nameStartX = afterLogoX + seedW + 10
  }

  // Team name (truncate if too long)
  ctx.fillStyle = teamRef.placeholder ? PALETTE.textMuted : PALETTE.textPrimary
  ctx.font = teamRef.placeholder
    ? 'italic 17px system-ui, sans-serif'
    : 'bold 19px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  let displayName = teamRef.name
  const scoreBoxW = 50
  const maxNameW = w - (nameStartX - x) - scoreBoxW - 22
  while (ctx.measureText(displayName).width > maxNameW && displayName.length > 4) {
    displayName = displayName.slice(0, -1)
  }
  if (displayName !== teamRef.name) displayName = displayName.trimEnd() + '…'
  ctx.fillText(displayName, nameStartX, y + h / 2)

  // Score box on right (empty for now)
  const scoreBoxH = 30
  const scoreBoxX = x + w - scoreBoxW - 10
  const scoreBoxY = y + (h - scoreBoxH) / 2
  ctx.strokeStyle = PALETTE.scoreBoxBorder
  ctx.lineWidth = 1.2
  roundRect(ctx, scoreBoxX, scoreBoxY, scoreBoxW, scoreBoxH, 5)
  ctx.stroke()
  ctx.fillStyle = PALETTE.scoreBoxText
  ctx.font = 'bold 18px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('-', scoreBoxX + scoreBoxW / 2, scoreBoxY + scoreBoxH / 2)
}

// ────────────────────────────────────────────
// Page
// ────────────────────────────────────────────

export default function TournamentBracketGraphic() {
  const [selectedKey, setSelectedKey] = useState('ccc_2026')
  const [teamLogoMap, setTeamLogoMap] = useState(new Map())
  const [rendered, setRendered] = useState(false)
  const [error, setError] = useState(null)
  const canvasRef = useRef(null)

  const tournament = TOURNAMENTS[selectedKey]

  useEffect(() => {
    let cancelled = false
    async function fetchLogos() {
      const map = new Map()
      try {
        await Promise.all(tournament.seeds.map(async (s) => {
          try {
            const res = await fetch(`${API_BASE}/teams/${s.team_id}`)
            if (!res.ok) return
            const team = await res.json()
            if (team.logo_url) map.set(s.team_id, team.logo_url)
          } catch { /* skip */ }
        }))
        if (!cancelled) setTeamLogoMap(map)
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }
    fetchLogos()
    return () => { cancelled = true }
  }, [selectedKey, tournament.seeds])

  const generate = useCallback(async () => {
    if (!canvasRef.current) return
    await renderBracket(canvasRef.current, tournament, teamLogoMap)
    setRendered(true)
  }, [tournament, teamLogoMap])

  useEffect(() => { generate() }, [generate])

  const download = () => {
    if (!canvasRef.current) return
    const link = document.createElement('a')
    link.download = `${selectedKey}-bracket.png`
    link.href = canvasRef.current.toDataURL('image/png')
    link.click()
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Conference Tournament Bracket</h1>
      <p className="text-sm text-gray-500 mb-5">
        Generate a shareable bracket graphic for a conference tournament. Score boxes
        will fill with final scores once we wire up live updates.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={selectedKey}
          onChange={(e) => setSelectedKey(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal"
        >
          {Object.entries(TOURNAMENTS).map(([key, t]) => (
            <option key={key} value={key}>{t.label} ({t.season})</option>
          ))}
        </select>

        <button
          type="button"
          onClick={download}
          disabled={!rendered}
          className="px-4 py-2 rounded-lg bg-nw-teal text-white text-sm font-semibold
                     hover:bg-pnw-slate disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Download PNG
        </button>
      </div>

      {error && <p className="text-sm text-red-700 mb-3">{error}</p>}

      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-3">
        <canvas
          ref={canvasRef}
          className="w-full max-w-full h-auto rounded-lg"
          style={{ aspectRatio: '16 / 9' }}
        />
      </div>

      <p className="text-xs text-gray-500 mt-3">
        1920 x 1080 PNG (16:9). Great for Twitter, Facebook, and link
        previews. Instagram will crop unless posted as a landscape feed image.
        Click Download PNG to save.
      </p>
    </div>
  )
}
