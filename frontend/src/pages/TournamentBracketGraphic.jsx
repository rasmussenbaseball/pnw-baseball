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

const TOURNAMENTS = {
  ccc_2026: {
    label: 'CCC Tournament',
    sub: 'May 1 to 4, Lewis-Clark State',
    season: 2026,
    formatLabel: 'Double-elimination bracket',
    seeds: [
      { seed: 1, team_id: 22,   name: 'Lewis-Clark State' },
      { seed: 2, team_id: 5720, name: 'British Columbia' },
      { seed: 3, team_id: 21,   name: 'College of Idaho' },
      { seed: 4, team_id: 24,   name: 'Bushnell' },
      { seed: 5, team_id: 20,   name: 'Oregon Tech' },
    ],
    games: [
      { num: 1, iso: '2026-05-01', day: 'Fri May 1', time: '11:00 AM', home: { ref: 'seed', val: 4 },     away: { ref: 'seed', val: 5 } },
      { num: 2, iso: '2026-05-01', day: 'Fri May 1', time: '2:30 PM',  home: { ref: 'seed', val: 2 },     away: { ref: 'seed', val: 3 } },
      { num: 3, iso: '2026-05-01', day: 'Fri May 1', time: '6:00 PM',  home: { ref: 'seed', val: 1 },     away: { ref: 'winner', game: 1 } },
      { num: 4, iso: '2026-05-02', day: 'Sat May 2', time: '11:00 AM', home: { ref: 'loser',  game: 1 },  away: { ref: 'loser',  game: 2 } },
      { num: 5, iso: '2026-05-02', day: 'Sat May 2', time: '2:30 PM',  home: { ref: 'winner', game: 2 },  away: { ref: 'winner', game: 3 } },
      { num: 6, iso: '2026-05-02', day: 'Sat May 2', time: '6:00 PM',  home: { ref: 'loser',  game: 3 },  away: { ref: 'winner', game: 4 } },
      { num: 7, iso: '2026-05-03', day: 'Sun May 3', time: '11:00 AM', home: { ref: 'winner', game: 6 },  away: { ref: 'loser',  game: 5 } },
      { num: 8, iso: '2026-05-03', day: 'Sun May 3', time: '2:30 PM',  home: { ref: 'winner', game: 7 },  away: { ref: 'winner', game: 5 } },
      { num: 9, iso: '2026-05-04', day: 'Mon May 4', time: '11:00 AM', home: { ref: 'winner', game: 7 },  away: { ref: 'winner', game: 5 }, ifNecessary: true },
    ],
    // CCC layout — 4 columns wide:
    //   Col 1: G1 (WB R1 play-in)         + G4 (LB R1)
    //   Col 2: G2, G3 (WB R2 / QF byes)   + G6 (LB R2)
    //   Col 3: G5 (WB Final)              + G7 (LB Final)
    //   Col 4: G8 + G9 (Championship)
    layout: {
      1: { x: 60,   y: 400, w: 380, h: 120 },
      2: { x: 500,  y: 240, w: 380, h: 120 },
      3: { x: 500,  y: 400, w: 380, h: 120 },
      5: { x: 940,  y: 320, w: 380, h: 120 },
      8: { x: 1380, y: 540, w: 380, h: 130 },
      9: { x: 1380, y: 685, w: 380, h: 40  },
      4: { x: 60,   y: 720, w: 380, h: 120 },
      6: { x: 500,  y: 760, w: 380, h: 120 },
      7: { x: 940,  y: 800, w: 380, h: 120 },
    },
    connections: [
      { from: 1, to: 3 },
      { from: 2, to: 5 },
      { from: 3, to: 5 },
      { from: 5, to: 8 },
      { from: 4, to: 6 },
      { from: 6, to: 7 },
      { from: 7, to: 8 },
    ],
    sectionLabels: [
      { text: "WINNER'S BRACKET", x: 60,   y: 210, w: 1000 },
      { text: "CHAMPIONSHIP",     x: 1380, y: 510, w: 380, centered: true },
      { text: "LOSER'S BRACKET",  x: 60,   y: 690, w: 1000 },
    ],
    championshipGames: [8],
  },
  nwc_2026: {
    label: 'NWC Tournament',
    sub: 'May 8 to 10',
    season: 2026,
    formatLabel: 'Double-elimination bracket',
    seeds: [
      { seed: 1, team_id: 13, name: 'Whitworth' },
      { seed: 2, team_id: 14, name: 'Linfield' },
      { seed: 3, team_id: 15, name: 'Lewis & Clark' },
      { seed: 4, team_id: 10, name: 'Puget Sound' },
    ],
    games: [
      { num: 1, iso: '2026-05-08', day: 'Fri May 8',  time: '2:00 PM',  home: { ref: 'seed', val: 1 },    away: { ref: 'seed', val: 4 } },
      { num: 2, iso: '2026-05-08', day: 'Fri May 8',  time: '5:00 PM',  home: { ref: 'seed', val: 2 },    away: { ref: 'seed', val: 3 } },
      { num: 3, iso: '2026-05-09', day: 'Sat May 9',  time: '10:00 AM', home: { ref: 'loser',  game: 1 }, away: { ref: 'loser',  game: 2 } },
      { num: 4, iso: '2026-05-09', day: 'Sat May 9',  time: '1:00 PM',  home: { ref: 'winner', game: 1 }, away: { ref: 'winner', game: 2 } },
      { num: 5, iso: '2026-05-09', day: 'Sat May 9',  time: '4:00 PM',  home: { ref: 'winner', game: 3 }, away: { ref: 'loser',  game: 4 } },
      { num: 6, iso: '2026-05-10', day: 'Sun May 10', time: '12:00 PM', home: { ref: 'winner', game: 4 }, away: { ref: 'winner', game: 5 } },
      { num: 7, iso: '2026-05-10', day: 'Sun May 10', time: '3:00 PM',  home: { ref: 'winner', game: 4 }, away: { ref: 'winner', game: 5 }, ifNecessary: true },
    ],
    // NWC layout — 4 teams, 7 games:
    //   Col 1: G1, G2 (WB R1)              + G3 (LB R1)
    //   Col 2: G4 (WB Final)               + G5 (LB Final)
    //   Col 3: G6 + G7 (Championship)
    layout: {
      1: { x: 200, y: 320, w: 420, h: 130 },
      2: { x: 200, y: 480, w: 420, h: 130 },
      4: { x: 740, y: 400, w: 420, h: 130 },
      3: { x: 200, y: 720, w: 420, h: 130 },
      5: { x: 740, y: 720, w: 420, h: 130 },
      6: { x: 1280, y: 540, w: 440, h: 140 },
      7: { x: 1280, y: 695, w: 440, h: 40  },
    },
    connections: [
      { from: 1, to: 4 },
      { from: 2, to: 4 },
      { from: 4, to: 6 },
      { from: 3, to: 5 },
      { from: 5, to: 6 },
    ],
    sectionLabels: [
      { text: "WINNER'S BRACKET", x: 200,  y: 290, w: 960 },
      { text: "CHAMPIONSHIP",     x: 1280, y: 510, w: 440, centered: true },
      { text: "LOSER'S BRACKET",  x: 200,  y: 690, w: 960 },
    ],
    championshipGames: [6],
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

// ────────────────────────────────────────────
// Tournament resolution: match bracket games to DB rows, chain winners/losers
// ────────────────────────────────────────────

async function fetchTournamentGames(tournament) {
  const dates = [...new Set(tournament.games.map((g) => g.iso).filter(Boolean))]
  const all = []
  await Promise.all(
    dates.map(async (iso) => {
      try {
        const res = await fetch(`${API_BASE}/games/by-date?date=${iso}`)
        if (!res.ok) return
        const data = await res.json()
        // Endpoint returns { games: [...] }, but tolerate a bare array too.
        const games = Array.isArray(data)
          ? data
          : (Array.isArray(data?.games) ? data.games : [])
        if (games.length) all.push(...games)
      } catch {
        /* skip */
      }
    })
  )
  return all
}

function resolveBracket(tournament, dbGames) {
  const seedMap = {}
  for (const s of tournament.seeds) seedMap[s.seed] = s

  // Index DB games by date + sorted team-id pair.
  // Bracket "home/away" is positional, not literal hosting, so we match
  // unordered pairs and re-map scores afterward.
  const dbByKey = new Map()
  for (const g of dbGames) {
    if (!g || !g.home_team_id || !g.away_team_id) continue
    const pair = [g.home_team_id, g.away_team_id].sort((a, b) => a - b).join('-')
    const key = `${g.game_date}|${pair}`
    const existing = dbByKey.get(key)
    if (!existing || (g.status === 'final' && existing.status !== 'final')) {
      dbByKey.set(key, g)
    }
  }

  function resolveRef(ref, outcomes) {
    if (!ref) return null
    if (ref.ref === 'seed')   return seedMap[ref.val]?.team_id || null
    if (ref.ref === 'winner') return outcomes.get(ref.game)?.winner_id || null
    if (ref.ref === 'loser')  return outcomes.get(ref.game)?.loser_id  || null
    return null
  }

  const outcomes = new Map()
  for (const g of tournament.games) {
    const homeId = resolveRef(g.home, outcomes)
    const awayId = resolveRef(g.away, outcomes)
    const outcome = {
      home_team_id: homeId,
      away_team_id: awayId,
      status: null,
      home_score: null,
      away_score: null,
      winner_id: null,
      loser_id:  null,
      db_game_id: null,
    }
    if (homeId && awayId && g.iso) {
      const pair = [homeId, awayId].sort((a, b) => a - b).join('-')
      const db = dbByKey.get(`${g.iso}|${pair}`)
      if (db) {
        outcome.db_game_id = db.id
        outcome.status = db.status
        if (db.status === 'final' && db.home_score != null && db.away_score != null) {
          // Map DB scores back to bracket-home/away order.
          const dbHomeIsBracketHome = db.home_team_id === homeId
          outcome.home_score = dbHomeIsBracketHome ? db.home_score : db.away_score
          outcome.away_score = dbHomeIsBracketHome ? db.away_score : db.home_score
          if (outcome.home_score > outcome.away_score) {
            outcome.winner_id = homeId
            outcome.loser_id  = awayId
          } else if (outcome.away_score > outcome.home_score) {
            outcome.winner_id = awayId
            outcome.loser_id  = homeId
          }
        }
      }
    }
    outcomes.set(g.num, outcome)
  }
  return outcomes
}

function shortLabelForRef(ref, seedMap, outcomes, seeds) {
  if (ref.ref === 'seed') {
    const s = seedMap[ref.val]
    return { name: s?.name || `Seed ${ref.val}`, seed: ref.val, team_id: s?.team_id }
  }
  if (ref.ref === 'winner' || ref.ref === 'loser') {
    const o = outcomes?.get(ref.game)
    const tid = ref.ref === 'winner' ? o?.winner_id : o?.loser_id
    if (tid) {
      const s = seeds.find((x) => x.team_id === tid)
      return { name: s?.name || `Team ${tid}`, seed: s?.seed, team_id: tid }
    }
    return { name: `${ref.ref === 'winner' ? 'Winner' : 'Loser'} G${ref.game}`, placeholder: true }
  }
  return { name: '???', placeholder: true }
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

  // Day + time (or "FINAL" badge if game is over)
  const outcome = outcomes?.get(game.num)
  const isFinal = outcome?.status === 'final'
  ctx.fillStyle = PALETTE.textSecondary
  ctx.font = '13px system-ui, sans-serif'
  ctx.fillText(`${game.day} · ${game.time}`, x + 46, y + 14)

  if (isFinal) {
    // FINAL pill on the right of the strip
    const pillW = 50, pillH = 18
    const pillX = x + w - pillW - 10
    const pillY = y + (stripH - pillH) / 2
    ctx.fillStyle = PALETTE.accent
    roundRect(ctx, pillX, pillY, pillW, pillH, 4)
    ctx.fill()
    ctx.fillStyle = '#062029'
    ctx.font = 'bold 11px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('FINAL', pillX + pillW / 2, y + 14)
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
  ctx.fillText(`G${game.num} · ${game.day} ${game.time} (if necessary)`, x + w / 2, y + h / 2)
}

async function drawTeamRow(ctx, teamRef, x, y, w, h, teamLogoMap, score, isWinner, isLoser) {
  // Logo or placeholder
  const logoSize = Math.min(h - 12, 38)
  const logoX = x + 10
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
    : (isWinner ? 'bold 20px system-ui, sans-serif' : 'bold 19px system-ui, sans-serif')
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

  // Score box on right
  const scoreBoxH = 30
  const scoreBoxX = x + w - scoreBoxW - 10
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
    ctx.font = isWinner ? 'bold 22px system-ui, sans-serif' : 'bold 20px system-ui, sans-serif'
  } else {
    ctx.fillStyle = PALETTE.scoreBoxText
    ctx.font = 'bold 18px system-ui, sans-serif'
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
