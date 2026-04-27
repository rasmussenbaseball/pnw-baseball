import { useState, useRef, useCallback, useEffect } from 'react'

const API_BASE = '/api/v1'

// ────────────────────────────────────────────
// Tournament data (CCC for v1, easy to add more)
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
      // Friday May 1
      { num: 1, day: 'Friday May 1',  time: '11:00 AM', home: { ref: 'seed', val: 4 },        away: { ref: 'seed', val: 5 } },
      { num: 2, day: 'Friday May 1',  time: '2:30 PM',  home: { ref: 'seed', val: 2 },        away: { ref: 'seed', val: 3 } },
      { num: 3, day: 'Friday May 1',  time: '6:00 PM',  home: { ref: 'seed', val: 1 },        away: { ref: 'winner', game: 1 } },
      // Saturday May 2
      { num: 4, day: 'Saturday May 2', time: '11:00 AM', home: { ref: 'loser',  game: 1 },     away: { ref: 'loser',  game: 2 } },
      { num: 5, day: 'Saturday May 2', time: '2:30 PM',  home: { ref: 'winner', game: 2 },     away: { ref: 'winner', game: 3 } },
      { num: 6, day: 'Saturday May 2', time: '6:00 PM',  home: { ref: 'loser',  game: 3 },     away: { ref: 'winner', game: 4 } },
      // Sunday May 3
      { num: 7, day: 'Sunday May 3',  time: '11:00 AM', home: { ref: 'winner', game: 6 },     away: { ref: 'loser',  game: 5 } },
      { num: 8, day: 'Sunday May 3',  time: '2:30 PM',  home: { ref: 'winner', game: 7 },     away: { ref: 'winner', game: 5 } },
      // Monday May 4 (if necessary)
      { num: 9, day: 'Monday May 4',  time: '11:00 AM', home: { ref: 'winner', game: 7 },     away: { ref: 'winner', game: 5 }, ifNecessary: true },
    ],
  },
}

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
// Renderer (1080x1080)
// ────────────────────────────────────────────

async function renderBracket(canvas, tournament, teamLogoMap) {
  const W = 1080, H = 1080
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  // ── Background ──
  ctx.fillStyle = '#0D1B0F'
  ctx.fillRect(0, 0, W, H)

  // ── Top header bar ──
  const headerH = 72
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, W, headerH)
  ctx.fillStyle = '#2E7D32'
  ctx.fillRect(0, headerH - 3, W, 3)

  // NW logo on left
  try {
    const nwImg = await loadImage('/images/nw-logo-white.png')
    const a = nwImg.naturalWidth / nwImg.naturalHeight
    const size = 44
    let dw = size, dh = size
    if (a >= 1) dh = size / a; else dw = size * a
    ctx.drawImage(nwImg, 16, (headerH - 3 - dh) / 2, dw, dh)
  } catch { /* skip */ }

  // PNWCBR logo on right
  try {
    const cbrImg = await loadImage('/images/cbr-logo.jpg')
    const a = cbrImg.naturalWidth / cbrImg.naturalHeight
    const size = 44
    let dw = size, dh = size
    if (a >= 1) dh = size / a; else dw = size * a
    ctx.drawImage(cbrImg, W - 16 - dw, (headerH - 3 - dh) / 2, dw, dh)
  } catch { /* skip */ }

  // Header title
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 20px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('NW BASEBALL STATS', W / 2, (headerH - 3) / 2)

  // ── Title + subtitle ──
  ctx.textAlign = 'center'
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 56px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.fillText(tournament.label.toUpperCase(), W / 2, headerH + 60)

  ctx.fillStyle = '#9CCC9F'
  ctx.font = '24px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.fillText(tournament.sub, W / 2, headerH + 100)

  ctx.fillStyle = 'rgba(255,255,255,0.4)'
  ctx.font = 'italic 16px system-ui, sans-serif'
  ctx.fillText('Double-elimination bracket', W / 2, headerH + 124)

  // ── Body: render games grouped by day ──
  const seedMap = {}
  for (const s of tournament.seeds) seedMap[s.seed] = s

  const bodyTop = headerH + 150
  const bodyBottom = H - 70  // leave room for footer
  const bodyH = bodyBottom - bodyTop

  // Group games by day
  const days = []
  const seenDays = new Set()
  for (const g of tournament.games) {
    if (!seenDays.has(g.day)) {
      seenDays.add(g.day)
      days.push({ label: g.day, games: [] })
    }
    days[days.length - 1].games.push(g)
  }

  const dayBlockH = bodyH / days.length

  for (let di = 0; di < days.length; di++) {
    const day = days[di]
    const yTop = bodyTop + di * dayBlockH
    const yMid = yTop + dayBlockH / 2

    // Day label on left side
    ctx.textAlign = 'left'
    ctx.fillStyle = '#9CCC9F'
    ctx.font = 'bold 18px system-ui, sans-serif'
    ctx.fillText(day.label.toUpperCase(), 30, yTop + 30)

    // Day separator line
    ctx.strokeStyle = 'rgba(46,125,50,0.25)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(30, yTop + 44)
    ctx.lineTo(W - 30, yTop + 44)
    ctx.stroke()

    // Game cards in a row
    const cardCount = day.games.length
    const cardW = 308
    const cardH = dayBlockH - 80
    const gap = 20
    const totalW = cardCount * cardW + (cardCount - 1) * gap
    const xStart = (W - totalW) / 2

    for (let ci = 0; ci < cardCount; ci++) {
      const g = day.games[ci]
      const xCard = xStart + ci * (cardW + gap)
      const yCard = yTop + 56
      await drawGameCard(ctx, g, xCard, yCard, cardW, cardH, seedMap, teamLogoMap)
    }
  }

  // ── Footer ──
  ctx.fillStyle = 'rgba(255,255,255,0.4)'
  ctx.font = '14px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('nwbaseballstats.com', W / 2, H - 28)
}

async function drawGameCard(ctx, game, x, y, w, h, seedMap, teamLogoMap) {
  // Card background
  if (game.ifNecessary) {
    ctx.fillStyle = 'rgba(255,255,255,0.04)'
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
  }
  roundRect(ctx, x, y, w, h, 10)
  ctx.fill()

  // Card border
  ctx.strokeStyle = game.ifNecessary
    ? 'rgba(255,255,255,0.10)'
    : 'rgba(46,125,50,0.45)'
  ctx.lineWidth = 1.2
  ctx.stroke()

  // Game number badge top-left
  ctx.fillStyle = '#2E7D32'
  roundRect(ctx, x + 10, y + 10, 38, 22, 4)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 13px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`G${game.num}`, x + 29, y + 21)

  // Time top-right
  ctx.fillStyle = '#9CCC9F'
  ctx.font = '13px system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText(game.time, x + w - 12, y + 21)

  // "If necessary" tag
  if (game.ifNecessary) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = 'italic 11px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('if necessary', x + w / 2, y + 40)
  }

  // Two team rows
  const homeRef = shortLabelForRef(game.home, seedMap)
  const awayRef = shortLabelForRef(game.away, seedMap)
  const rowTop = y + 50
  const rowH = (h - 60) / 2

  await drawTeamRow(ctx, awayRef, x + 10, rowTop, w - 20, rowH, teamLogoMap)
  await drawTeamRow(ctx, homeRef, x + 10, rowTop + rowH, w - 20, rowH, teamLogoMap)
}

async function drawTeamRow(ctx, teamRef, x, y, w, h, teamLogoMap) {
  // Logo or placeholder square
  const logoSize = Math.min(h - 16, 44)
  const logoY = y + (h - logoSize) / 2
  const logoX = x + 6

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
    // Placeholder circle
    ctx.fillStyle = 'rgba(255,255,255,0.1)'
    ctx.beginPath()
    ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2 - 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.font = 'bold 16px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('?', logoX + logoSize / 2, logoY + logoSize / 2)
  }

  // Seed badge (when known)
  const textX = logoX + logoSize + 12
  if (teamRef.seed) {
    ctx.fillStyle = '#1B5E20'
    roundRect(ctx, textX, y + h / 2 - 11, 24, 22, 4)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 12px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`#${teamRef.seed}`, textX + 12, y + h / 2)
  }

  // Team name
  ctx.fillStyle = teamRef.placeholder ? 'rgba(255,255,255,0.55)' : '#ffffff'
  ctx.font = teamRef.placeholder
    ? 'italic 16px system-ui, sans-serif'
    : 'bold 17px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const nameX = teamRef.seed ? textX + 32 : textX
  // Truncate long names
  let displayName = teamRef.name
  const maxNameW = w - (nameX - x) - 60   // leave 60px on right for score
  while (ctx.measureText(displayName).width > maxNameW && displayName.length > 4) {
    displayName = displayName.slice(0, -1)
  }
  if (displayName !== teamRef.name) displayName = displayName.trimEnd() + '…'
  ctx.fillText(displayName, nameX, y + h / 2)

  // Score box on right (empty for now)
  const scoreBoxW = 40
  const scoreBoxH = 28
  const scoreBoxX = x + w - scoreBoxW - 4
  const scoreBoxY = y + (h - scoreBoxH) / 2
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'
  ctx.lineWidth = 1
  roundRect(ctx, scoreBoxX, scoreBoxY, scoreBoxW, scoreBoxH, 4)
  ctx.stroke()
  ctx.fillStyle = 'rgba(255,255,255,0.25)'
  ctx.font = 'bold 16px system-ui, sans-serif'
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

  // Fetch logos for the seeded teams
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

  useEffect(() => {
    generate()
  }, [generate])

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
        will fill in with final scores once we wire up live updates.
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
          style={{ aspectRatio: '1 / 1' }}
        />
      </div>

      <p className="text-xs text-gray-500 mt-3">
        1080 x 1080 PNG, ready for Instagram, Twitter, or any other social
        feed. Click Download PNG to save.
      </p>
    </div>
  )
}
