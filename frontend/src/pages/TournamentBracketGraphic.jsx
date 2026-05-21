import { useState, useRef, useCallback, useEffect } from 'react'
import { TOURNAMENTS, fetchTournamentGames, resolveBracket, shortLabelForRef } from '../lib/brackets'

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
  scoreBoxBorderWinner: '#ffd54f',
  scoreBoxText: 'rgba(255,255,255,0.40)',
  connector: '#3aa3bd',
  ifNecessaryDim: 'rgba(255,255,255,0.12)',
  topStrip: 'rgba(0,0,0,0.45)',
  loserDim: 'rgba(255,255,255,0.45)',
}

// ────────────────────────────────────────────
// Canvas dimensions — 1920x1080 (16:9). Brackets flow left-to-right and
// need horizontal room.
// ────────────────────────────────────────────
const CANVAS_W = 1920
const CANVAS_H = 1080

// ────────────────────────────────────────────
// Tournament data
//
// Each tournament entry carries everything the renderer needs:
//   - seeds:           team_id + display name per seed
//   - games:           ordered list of games with home/away refs
//                      (refs can be { ref:'seed', val } / { ref:'winner', game } /
//                      { ref:'loser', game })
//   - layout:          { gameNum: { x, y, w, h } } absolute positions
//   - connections:     bracket-line list [{ from, to }]
//   - sectionLabels:   labels drawn on the canvas
//   - formatLabel:     subtitle under tournament name (e.g. "Double-elimination bracket")
//   - championshipGames: game numbers that get the gold border / championship styling
// ────────────────────────────────────────────

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


// ────────────────────────────────────────────
// Renderer
// ────────────────────────────────────────────

async function renderBracket(canvas, tournament, teamLogoMap, outcomes) {
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
  ctx.fillText(tournament.formatLabel || 'Double-elimination bracket', W / 2, headerH + 138)

  // Section labels — sourced from tournament data so each format can lay out
  // its own labels (winner's/loser's/championship for double-elim brackets,
  // round-robin sections for GNAC, etc.).
  for (const lbl of (tournament.sectionLabels || [])) {
    drawSectionLabel(ctx, lbl.text, lbl.x, lbl.y, lbl.w, !!lbl.centered)
  }

  // Build maps for game lookup
  const seedMap = {}
  for (const s of tournament.seeds) seedMap[s.seed] = s
  const championshipGames = new Set(tournament.championshipGames || [])

  // Draw connector lines first (so cards sit on top)
  ctx.strokeStyle = PALETTE.connector
  ctx.lineWidth = 3
  ctx.lineJoin = 'round'
  for (const conn of (tournament.connections || [])) {
    const a = tournament.layout[conn.from]
    const b = tournament.layout[conn.to]
    if (!a || !b) continue
    drawConnector(ctx, a, b)
  }

  // Draw all game cards
  for (const g of tournament.games) {
    const pos = tournament.layout[g.num]
    if (!pos) continue
    if (g.ifNecessary) {
      await drawIfNecessaryCard(ctx, g, pos)
    } else {
      await drawGameCard(ctx, g, pos, seedMap, teamLogoMap, outcomes, tournament.seeds, championshipGames)
    }
  }

  // Footer
  const anyFinal = outcomes && [...outcomes.values()].some((o) => o.status === 'final')
  ctx.fillStyle = PALETTE.textMuted
  ctx.font = '15px system-ui, sans-serif'
  ctx.textAlign = 'center'
  const footerText = anyFinal
    ? 'Bracket format · Final scores update automatically as games complete'
    : 'Bracket format · Final scores will populate when games complete'
  ctx.fillText(footerText, W / 2, H - 28)
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

async function drawGameCard(ctx, game, pos, seedMap, teamLogoMap, outcomes, seeds, championshipGames) {
  const { x, y, w, h } = pos
  const isChamp = championshipGames ? championshipGames.has(game.num) : false
  // Compact: tighter fonts / smaller strip so cards under ~270px wide stay readable.
  const compact = w < 270

  // Card bg
  ctx.fillStyle = isChamp ? PALETTE.cardChampionship : PALETTE.card
  roundRect(ctx, x, y, w, h, 10)
  ctx.fill()

  // Card border — gold for the championship, bright teal for the rest
  ctx.strokeStyle = isChamp ? PALETTE.championshipBorder : PALETTE.border
  ctx.lineWidth = isChamp ? 2.5 : 1.6
  ctx.stroke()

  // Top strip with game number + time + day
  const stripH = compact ? 22 : 28
  ctx.fillStyle = PALETTE.topStrip
  roundRect(ctx, x, y, w, stripH, 10)
  ctx.fill()
  ctx.fillRect(x, y + 14, w, stripH - 14)

  // Game number badge — use displayLabel override if present (e.g. GNAC
  // scenario B uses 'G4' / 'G5' as labels even though their internal nums
  // are 6 / 7 to keep the outcomes Map keys unique).
  const stripCY = y + stripH / 2
  const numPadL = compact ? 8 : 12
  ctx.fillStyle = isChamp ? PALETTE.championshipBorder : PALETTE.accent
  ctx.font = `bold ${compact ? 12 : 14}px system-ui, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const numText = game.displayLabel || `G${game.num}`
  ctx.fillText(numText, x + numPadL, stripCY)
  // Push day/time text past the actual rendered width of the number so longer
  // game labels ("G102", "G108") don't collide with the time.
  const numEndX = x + numPadL + ctx.measureText(numText).width

  // Day + time (or "FINAL" badge if game is over)
  const outcome = outcomes?.get(game.num)
  const isFinal = outcome?.status === 'final'
  ctx.fillStyle = PALETTE.textSecondary
  ctx.font = `${compact ? 11 : 13}px system-ui, sans-serif`
  ctx.fillText(`${game.day} · ${game.time}`, numEndX + (compact ? 6 : 10), stripCY)

  if (isFinal) {
    // FINAL pill on the right of the strip
    const pillW = compact ? 42 : 50
    const pillH = compact ? 16 : 18
    const pillX = x + w - pillW - (compact ? 6 : 10)
    const pillY = y + (stripH - pillH) / 2
    ctx.fillStyle = PALETTE.accent
    roundRect(ctx, pillX, pillY, pillW, pillH, 4)
    ctx.fill()
    ctx.fillStyle = '#062029'
    ctx.font = `bold ${compact ? 10 : 11}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText('FINAL', pillX + pillW / 2, stripCY)
  }

  // Two team rows
  const homeRef = shortLabelForRef(game.home, seedMap, outcomes, seeds)
  const awayRef = shortLabelForRef(game.away, seedMap, outcomes, seeds)
  const rowTop = y + stripH
  const rowH = (h - stripH) / 2

  const homeScore = outcome?.home_score
  const awayScore = outcome?.away_score
  const winnerId = outcome?.winner_id || null
  const homeIsWinner = isFinal && winnerId && homeRef.team_id === winnerId
  const awayIsWinner = isFinal && winnerId && awayRef.team_id === winnerId

  await drawTeamRow(ctx, awayRef, x, rowTop,         w, rowH, teamLogoMap, awayScore, awayIsWinner, isFinal && !awayIsWinner)
  // Divider line between teams
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x + 10, rowTop + rowH)
  ctx.lineTo(x + w - 10, rowTop + rowH)
  ctx.stroke()
  await drawTeamRow(ctx, homeRef, x, rowTop + rowH, w, rowH, teamLogoMap, homeScore, homeIsWinner, isFinal && !homeIsWinner)
}

async function drawIfNecessaryCard(ctx, game, pos) {
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
  const label = game.displayLabel || `G${game.num}`
  ctx.fillText(`${label} · ${game.day} ${game.time} (if necessary)`, x + w / 2, y + h / 2)
}

async function drawTeamRow(ctx, teamRef, x, y, w, h, teamLogoMap, score, isWinner, isLoser) {
  // Compact mode kicks in for narrow cards (e.g. the combined NWAC playoff
  // bracket). All sizes scale down so longer team names still fit without
  // overflowing the row.
  const compact = w < 270

  // Logo or placeholder — uses most of the row height so the logo reads
  // clearly even on the compact bracket.
  const logoSize = Math.min(h - 6, compact ? 30 : 40)
  const logoX = x + (compact ? 6 : 10)
  const logoY = y + (h - logoSize) / 2

  // Save alpha so we can dim losers
  const prevAlpha = ctx.globalAlpha
  if (isLoser) ctx.globalAlpha = 0.55

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

  // Seed badge — only rendered on roomier (non-compact) cards. On the
  // dense full-playoff bracket there isn't room for the badge AND the
  // team name, so the badge is skipped entirely.
  const afterLogoX = logoX + logoSize + (compact ? 6 : 12)
  let nameStartX = afterLogoX
  if (teamRef.seed && !compact) {
    ctx.font = 'bold 13px system-ui, sans-serif'
    const seedText = `#${teamRef.seed}`
    const tw = ctx.measureText(seedText).width
    const seedW = Math.max(28, Math.ceil(tw) + 12)
    ctx.fillStyle = PALETTE.border
    roundRect(ctx, afterLogoX, y + h / 2 - 12, seedW, 24, 4)
    ctx.fill()
    ctx.fillStyle = PALETTE.textPrimary
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(seedText, afterLogoX + seedW / 2, y + h / 2)
    nameStartX = afterLogoX + seedW + 10
  }

  // Team name (truncate if too long)
  ctx.fillStyle = teamRef.placeholder ? PALETTE.textMuted : PALETTE.textPrimary
  if (compact) {
    ctx.font = teamRef.placeholder
      ? 'italic 13px system-ui, sans-serif'
      : (isWinner ? 'bold 16px system-ui, sans-serif' : 'bold 15px system-ui, sans-serif')
  } else {
    ctx.font = teamRef.placeholder
      ? 'italic 17px system-ui, sans-serif'
      : (isWinner ? 'bold 20px system-ui, sans-serif' : 'bold 19px system-ui, sans-serif')
  }
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  let displayName = teamRef.name
  const scoreBoxW = compact ? 36 : 50
  const namePadRight = compact ? 14 : 22
  const maxNameW = w - (nameStartX - x) - scoreBoxW - namePadRight
  while (ctx.measureText(displayName).width > maxNameW && displayName.length > 4) {
    displayName = displayName.slice(0, -1)
  }
  if (displayName !== teamRef.name) displayName = displayName.trimEnd() + '…'
  ctx.fillText(displayName, nameStartX, y + h / 2)

  // Score box on right
  const scoreBoxH = compact ? 22 : 30
  const scoreBoxX = x + w - scoreBoxW - (compact ? 6 : 10)
  const scoreBoxY = y + (h - scoreBoxH) / 2

  // Restore alpha for the score box itself (don't dim the winner score by accident,
  // and the loser score should still be readable but slightly muted via alpha above).
  if (isWinner) {
    // Filled gold-bordered box for the winner
    ctx.fillStyle = 'rgba(255,213,79,0.15)'
    roundRect(ctx, scoreBoxX, scoreBoxY, scoreBoxW, scoreBoxH, 5)
    ctx.fill()
    ctx.strokeStyle = PALETTE.scoreBoxBorderWinner
    ctx.lineWidth = 1.8
    ctx.stroke()
  } else {
    ctx.strokeStyle = PALETTE.scoreBoxBorder
    ctx.lineWidth = 1.2
    roundRect(ctx, scoreBoxX, scoreBoxY, scoreBoxW, scoreBoxH, 5)
    ctx.stroke()
  }

  if (score != null) {
    ctx.fillStyle = isWinner ? PALETTE.championshipBorder : PALETTE.textPrimary
    if (compact) ctx.font = isWinner ? 'bold 16px system-ui, sans-serif' : 'bold 15px system-ui, sans-serif'
    else         ctx.font = isWinner ? 'bold 22px system-ui, sans-serif' : 'bold 20px system-ui, sans-serif'
  } else {
    ctx.fillStyle = PALETTE.scoreBoxText
    ctx.font = `bold ${compact ? 14 : 18}px system-ui, sans-serif`
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(score != null ? String(score) : '-', scoreBoxX + scoreBoxW / 2, scoreBoxY + scoreBoxH / 2)

  // Restore alpha
  ctx.globalAlpha = prevAlpha
}

// ────────────────────────────────────────────
// Page
// ────────────────────────────────────────────

export default function TournamentBracketGraphic() {
  const [selectedKey, setSelectedKey] = useState('ccc_2026')
  const [teamLogoMap, setTeamLogoMap] = useState(new Map())
  const [outcomes, setOutcomes] = useState(new Map())
  const [rendered, setRendered] = useState(false)
  const [error, setError] = useState(null)
  const canvasRef = useRef(null)

  const tournament = TOURNAMENTS[selectedKey]

  // Fetch team logos
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

  // Fetch tournament game results and resolve bracket
  useEffect(() => {
    let cancelled = false
    async function fetchScores() {
      try {
        const dbGames = await fetchTournamentGames(tournament)
        const resolved = resolveBracket(tournament, dbGames)
        if (!cancelled) setOutcomes(resolved)
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }
    fetchScores()
    return () => { cancelled = true }
  }, [selectedKey, tournament])

  const generate = useCallback(async () => {
    if (!canvasRef.current) return
    await renderBracket(canvasRef.current, tournament, teamLogoMap, outcomes)
    setRendered(true)
  }, [tournament, teamLogoMap, outcomes])

  useEffect(() => { generate() }, [generate])

  const download = () => {
    if (!canvasRef.current) return
    const link = document.createElement('a')
    link.download = `${selectedKey}-bracket.png`
    link.href = canvasRef.current.toDataURL('image/png')
    link.click()
  }

  // Quick status read-out for the page (so the user can see what populated)
  const finalCount = [...outcomes.values()].filter((o) => o.status === 'final').length
  const totalNonOptional = tournament.games.filter((g) => !g.ifNecessary).length

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Conference Tournament Bracket</h1>
      <p className="text-sm text-gray-500 mb-5">
        Generate a shareable bracket graphic for a conference tournament. Final scores
        and matchups update automatically as games complete in the database.
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

        <span className="text-xs text-gray-500">
          {finalCount} of {totalNonOptional} games final
        </span>
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
