import { useState, useRef, useCallback, useEffect } from 'react'

const API_BASE = '/api/v1'

// ── helpers ──
function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtDisplayDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function cleanTeamName(name) {
  if (!name) return '???'
  let n = name.trim()
  n = n.replace(/^(?:No\.\s*\d+\s+|#\d+\s+|\(\d+\)\s+)/i, '')
  n = n.replace(/(?<=[a-zA-Z])(\d+)$/, '')
  return n.trim() || '???'
}

function getTeamName(game, side) {
  const short = side === 'away' ? (game.away_short || game.away_team_name) : (game.home_short || game.home_team_name)
  return cleanTeamName(short)
}

// ── Image loader with cache ──
const imgCache = {}
function loadImage(src) {
  if (!src) return Promise.reject('no src')
  if (imgCache[src]) return imgCache[src]
  const promise = new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
  imgCache[src] = promise
  return promise
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

// ── Draw a scorebug (more square, taller) ──
async function drawScorebug(ctx, game, x, y, w, h) {
  const away = getTeamName(game, 'away')
  const home = getTeamName(game, 'home')
  const aScore = game.away_score ?? '-'
  const hScore = game.home_score ?? '-'
  const aWon = Number(game.away_score) > Number(game.home_score)
  const hWon = Number(game.home_score) > Number(game.away_score)

  // Card background with subtle shadow
  ctx.fillStyle = 'rgba(0,0,0,0.04)'
  roundRect(ctx, x + 1, y + 1, w, h, 6)
  ctx.fill()
  roundRect(ctx, x, y, w, h, 6)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 0.5
  ctx.stroke()

  // Header bar: FINAL + W/L/S
  const headerH = 16
  ctx.save()
  roundRect(ctx, x, y, w, headerH, 6)
  ctx.clip()
  ctx.fillStyle = '#f1f5f9'
  ctx.fillRect(x, y, w, headerH)
  ctx.restore()
  ctx.fillStyle = '#e2e8f0'
  ctx.fillRect(x + 1, y + headerH, w - 2, 0.5)

  const innings = game.innings && game.innings !== 9 ? ` (${game.innings})` : ''
  ctx.fillStyle = '#475569'
  ctx.font = '800 8px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(`FINAL${innings}`, x + 6, y + headerH / 2)

  // W/L/S pitcher
  const pitcherParts = []
  if (game.win_pitcher) pitcherParts.push(`W: ${game.win_pitcher}`)
  if (game.loss_pitcher) pitcherParts.push(`L: ${game.loss_pitcher}`)
  if (game.save_pitcher) pitcherParts.push(`S: ${game.save_pitcher}`)
  if (pitcherParts.length > 0) {
    ctx.fillStyle = '#94a3b8'
    ctx.font = '500 7px "Inter", system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(pitcherParts.join('  '), x + w - 6, y + headerH / 2)
  }

  // R/H/E column headers on the right
  const rheTop = y + headerH + 2
  const colW_rhe = 18
  const rheStartX = x + w - 6 - colW_rhe * 3
  ctx.fillStyle = '#94a3b8'
  ctx.font = '600 7px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('R', rheStartX + colW_rhe * 0.5, rheTop + 5)
  ctx.fillText('H', rheStartX + colW_rhe * 1.5, rheTop + 5)
  ctx.fillText('E', rheStartX + colW_rhe * 2.5, rheTop + 5)

  // Team rows
  const teamTop = rheTop + 12
  const teamH = h - headerH - 14
  const rowH = teamH / 2
  const logoSize = 18
  const nameFS = 11
  const scoreFS = 14

  for (let i = 0; i < 2; i++) {
    const isAway = i === 0
    const teamName = isAway ? away : home
    const score = isAway ? aScore : hScore
    const won = isAway ? aWon : hWon
    const logo = isAway ? game.away_logo : game.home_logo
    const record = isAway ? game.away_record : game.home_record
    const hits = isAway ? game.away_hits : game.home_hits
    const errors = isAway ? game.away_errors : game.home_errors
    const ry = teamTop + i * rowH
    const midY = ry + rowH / 2

    if (i === 1) {
      ctx.fillStyle = '#e2e8f0'
      ctx.fillRect(x + 4, ry - 1, w - 8, 0.5)
    }

    // Logo
    const logoX = x + 6
    let logoDrawn = false
    if (logo) {
      try {
        const img = await loadImage(logo)
        const aspect = img.naturalWidth / img.naturalHeight
        let drawW = logoSize, drawH = logoSize
        if (aspect >= 1) drawH = logoSize / aspect; else drawW = logoSize * aspect
        ctx.drawImage(img, logoX + (logoSize - drawW) / 2, midY - drawH / 2, drawW, drawH)
        logoDrawn = true
      } catch { /* skip */ }
    }

    const nameX = logoDrawn ? logoX + logoSize + 5 : x + 6
    const maxNameW = rheStartX - nameX - 4

    // Team name
    ctx.fillStyle = won ? '#0f172a' : '#64748b'
    ctx.font = `${won ? '700' : '500'} ${nameFS}px "Inter", system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    let display = teamName
    while (ctx.measureText(display).width > maxNameW && display.length > 2) {
      display = display.slice(0, -1)
    }
    if (display !== teamName) display += '.'
    ctx.fillText(display, nameX, midY - (record ? 4 : 0))

    // Record
    if (record) {
      ctx.fillStyle = '#94a3b8'
      ctx.font = '400 7px "Inter", system-ui, sans-serif'
      ctx.fillText(`(${record})`, nameX, midY + 7)
    }

    // R / H / E values
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // Runs (score) — bold
    ctx.fillStyle = won ? '#0f172a' : '#94a3b8'
    ctx.font = `${won ? '800' : '600'} ${scoreFS}px "Inter", system-ui, sans-serif`
    ctx.fillText(String(score), rheStartX + colW_rhe * 0.5, midY)
    // Hits
    ctx.fillStyle = '#64748b'
    ctx.font = '500 10px "Inter", system-ui, sans-serif'
    ctx.fillText(hits != null ? String(hits) : '-', rheStartX + colW_rhe * 1.5, midY)
    // Errors
    ctx.fillText(errors != null ? String(errors) : '-', rheStartX + colW_rhe * 2.5, midY)
  }
}

// ── Draw a performer row ──
async function drawPerformerRow(ctx, player, x, y, w, h, type) {
  roundRect(ctx, x, y, w, h, 4)
  ctx.fillStyle = '#f8fafc'
  ctx.fill()

  const pad = 8
  let curX = x + pad
  const midY = y + h / 2

  // Team logo
  const logoSize = Math.min(28, h - 8)
  if (player.team_logo) {
    try {
      const img = await loadImage(player.team_logo)
      const aspect = img.naturalWidth / img.naturalHeight
      let dw = logoSize, dh = logoSize
      if (aspect >= 1) dh = logoSize / aspect; else dw = logoSize * aspect
      ctx.drawImage(img, curX + (logoSize - dw) / 2, midY - dh / 2, dw, dh)
    } catch { /* skip */ }
  }
  curX += logoSize + 8

  // Name
  ctx.fillStyle = '#0f172a'
  ctx.font = '700 11px "Inter", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const name = player.display_name || 'Unknown'
  ctx.fillText(name, curX, midY - 5)

  // Team short
  ctx.fillStyle = '#64748b'
  ctx.font = '500 8px "Inter", system-ui, sans-serif'
  ctx.fillText(player.team_short || '', curX, midY + 7)

  // Stat line on the right
  ctx.textAlign = 'right'
  const statX = x + w - pad
  if (type === 'hitter') {
    const ab = player.at_bats || 0
    const h = player.hits || 0
    const hr = player.home_runs || 0
    const rbi = player.rbi || 0
    const bb = player.walks || 0
    const sb = player.stolen_bases || 0
    let parts = [`${h}-${ab}`]
    if (hr > 0) parts.push(`${hr} HR`)
    if (rbi > 0) parts.push(`${rbi} RBI`)
    if (bb > 0) parts.push(`${bb} BB`)
    if (sb > 0) parts.push(`${sb} SB`)
    ctx.fillStyle = '#0f172a'
    ctx.font = '700 11px "Inter", system-ui, sans-serif'
    ctx.fillText(parts.join(', '), statX, midY - 5)
    const extras = []
    if (player.doubles > 0) extras.push(`${player.doubles} 2B`)
    if (player.triples > 0) extras.push(`${player.triples} 3B`)
    if (player.runs > 0) extras.push(`${player.runs} R`)
    if (extras.length > 0) {
      ctx.fillStyle = '#94a3b8'
      ctx.font = '500 8px "Inter", system-ui, sans-serif'
      ctx.fillText(extras.join(', '), statX, midY + 7)
    }
  } else {
    const ip = player.innings_pitched || 0
    const k = player.strikeouts || 0
    const er = player.earned_runs || 0
    const dec = player.decision ? ` (${player.decision})` : ''
    ctx.fillStyle = '#0f172a'
    ctx.font = '700 11px "Inter", system-ui, sans-serif'
    ctx.fillText(`${ip} IP, ${k} K, ${er} ER${dec}`, statX, midY - 5)
    const extras = []
    if (player.hits_allowed != null) extras.push(`${player.hits_allowed} H`)
    if (player.walks > 0) extras.push(`${player.walks} BB`)
    if (player.game_score) extras.push(`GS: ${player.game_score}`)
    if (extras.length > 0) {
      ctx.fillStyle = '#94a3b8'
      ctx.font = '500 8px "Inter", system-ui, sans-serif'
      ctx.fillText(extras.join(', '), statX, midY + 7)
    }
  }
}

// ── Solve scorebug grid layout ──
function solveBugLayout(totalGames, contentW) {
  const bugGap = 5
  const colGap = 8

  // Try different column counts, preferring square-ish bugs
  for (let cols = 2; cols <= 5; cols++) {
    const colW = (contentW - (cols - 1) * colGap) / cols
    if (colW < 160) continue
    const rows = Math.ceil(totalGames / cols)
    // Target bug height: make them more square-ish (aspect ~1.6:1 w:h)
    const bugH = Math.min(80, Math.max(60, colW / 1.8))
    const totalH = rows * bugH + (rows - 1) * bugGap
    if (cols >= 2) {
      return { cols, colW, bugH, bugGap, colGap, totalH }
    }
  }
  // Fallback
  const cols = 3
  const colW = (contentW - (cols - 1) * colGap) / cols
  const rows = Math.ceil(totalGames / cols)
  const bugH = 65
  return { cols, colW, bugH, bugGap, colGap, totalH: rows * bugH + (rows - 1) * bugGap }
}

// ── Main canvas renderer ──
async function renderGraphic(canvas, data, dateShort, divisionLabel = '') {
  const { games, top_hitters, top_pitchers } = data
  const numGames = games.length

  // Determine how many performers to show (3 if <3 games, 5 if >=3 games)
  const hitCount = numGames >= 3 ? Math.min(5, top_hitters?.length || 0) : Math.min(3, top_hitters?.length || 0)
  const pitchCount = numGames >= 3 ? Math.min(5, top_pitchers?.length || 0) : Math.min(3, top_pitchers?.length || 0)
  const hasPerformers = hitCount > 0 || pitchCount > 0

  const W = 1080
  const pad = 24
  const contentW = W - pad * 2

  // Pre-calculate section heights
  const headerH = 64
  const { totalH: scoresH } = solveBugLayout(numGames, contentW)
  const perfRowH = 38
  const perfGap = 4
  const perfSectionH = hasPerformers
    ? 40 + (hitCount > 0 ? 18 + hitCount * (perfRowH + perfGap) + 8 : 0) + (pitchCount > 0 ? 18 + pitchCount * (perfRowH + perfGap) + 8 : 0)
    : 0
  const footerH = 30

  // Total canvas height — enough for everything
  const H = headerH + 3 + 16 + scoresH + 24 + perfSectionH + footerH + 16
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  // White background
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  // ── Header bar ──
  ctx.fillStyle = '#00687a'
  ctx.fillRect(0, 0, W, headerH)

  // NW logo mark
  ctx.fillStyle = 'rgba(255,255,255,0.2)'
  roundRect(ctx, pad, 14, 36, 36, 6)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 18px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('NW', pad + 18, 33)

  // Title
  const title = divisionLabel ? `PNW ${divisionLabel} SCORES` : 'PNW SCORES'
  ctx.fillStyle = '#ffffff'
  ctx.font = '800 28px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(title, W / 2, headerH / 2)

  // Date right
  ctx.textAlign = 'right'
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 12px "Helvetica Neue", "Arial", sans-serif'
  ctx.fillText(dateShort, W - pad, 26)
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.font = '400 10px "Helvetica Neue", "Arial", sans-serif'
  ctx.fillText(`${numGames} Game${numGames !== 1 ? 's' : ''}`, W - pad, 42)

  // Dark accent
  ctx.fillStyle = '#0f172a'
  ctx.fillRect(0, headerH, W, 3)

  // ── SCORES ──
  let curY = headerH + 3 + 12
  const { cols, colW, bugH, bugGap, colGap } = solveBugLayout(numGames, contentW)

  const gamesPerCol = Math.ceil(numGames / cols)
  const columns = []
  for (let c = 0; c < cols; c++) {
    columns.push(games.slice(c * gamesPerCol, Math.min((c + 1) * gamesPerCol, numGames)))
  }

  const totalColsW = cols * colW + (cols - 1) * colGap
  const startX = pad + (contentW - totalColsW) / 2

  for (let c = 0; c < columns.length; c++) {
    const colX = startX + c * (colW + colGap)
    let cy = curY
    for (let gi = 0; gi < columns[c].length; gi++) {
      await drawScorebug(ctx, columns[c][gi], colX, cy, colW, bugH)
      cy += bugH + bugGap
    }
  }
  curY += scoresH + 20

  // ── TOP PERFORMERS ──
  if (hasPerformers) {
    ctx.fillStyle = '#00687a'
    ctx.fillRect(pad, curY, contentW, 2)
    curY += 12

    ctx.fillStyle = '#0f172a'
    ctx.font = '800 18px "Helvetica Neue", "Arial", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('TOP PERFORMERS', W / 2, curY + 9)
    curY += 28

    // Hitters
    if (hitCount > 0) {
      ctx.fillStyle = '#00687a'
      ctx.font = '700 11px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText('HITTING', pad, curY + 5)
      curY += 16
      for (let i = 0; i < hitCount; i++) {
        await drawPerformerRow(ctx, top_hitters[i], pad, curY, contentW, perfRowH, 'hitter')
        curY += perfRowH + perfGap
      }
      curY += 8
    }

    // Pitchers
    if (pitchCount > 0) {
      ctx.fillStyle = '#00687a'
      ctx.font = '700 11px "Inter", system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText('PITCHING', pad, curY + 5)
      curY += 16
      for (let i = 0; i < pitchCount; i++) {
        await drawPerformerRow(ctx, top_pitchers[i], pad, curY, contentW, perfRowH, 'pitcher')
        curY += perfRowH + perfGap
      }
      curY += 8
    }
  }

  // ── Footer ──
  const footY = H - footerH / 2
  ctx.fillStyle = '#e2e8f0'
  ctx.fillRect(pad, H - footerH - 2, W - pad * 2, 1)
  ctx.fillStyle = '#00687a'
  ctx.font = '700 11px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('PNWBASEBALLSTATS.COM', pad, footY)
  ctx.fillStyle = '#94a3b8'
  ctx.font = '500 9px "Helvetica Neue", "Arial", sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText('2026 Season', W - pad, footY)
}

// ── Component ──
export default function DailyScoresGraphic() {
  const [date, setDate] = useState(todayStr())
  const [data, setData] = useState(null)
  const [divFilter, setDivFilter] = useState('ALL')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [rendered, setRendered] = useState(false)
  const canvasRef = useRef(null)

  const DIV_OPTIONS = ['ALL', 'D1', 'D2', 'D3', 'NAIA', 'JUCO']

  const fetchData = useCallback(async (d) => {
    setLoading(true)
    setError(null)
    setRendered(false)
    try {
      const res = await fetch(`${API_BASE}/games/daily-performers?date=${d}&season=2026`)
      if (!res.ok) throw new Error(`API error: ${res.status}`)
      const json = await res.json()

      // Enrich with live endpoint for better logos on recent dates
      const liveRes = await fetch(`${API_BASE}/games/live`).catch(() => null)
      if (liveRes?.ok) {
        const liveData = await liveRes.json()
        const allLive = [...(liveData.today || []), ...(liveData.recent || [])]
        const liveByTeams = {}
        for (const g of allLive) {
          if (g.date?.startsWith(d) && g.status === 'final') {
            const key = (g.team || '').toLowerCase()
            if (key) liveByTeams[key] = g
          }
        }
        for (const game of json.games) {
          const homeKey = (game.home_short || '').toLowerCase()
          const live = liveByTeams[homeKey]
          if (live) {
            if (live.team_logo && !game.home_logo) game.home_logo = live.team_logo
            if (live.opponent_logo && !game.away_logo) game.away_logo = live.opponent_logo
            game.division = live.team_division || game.home_division
          }
        }
      }

      setData(json)
    } catch (err) {
      setError(err.message)
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData(date) }, [date, fetchData])

  // Filter by division
  const filteredData = data ? {
    ...data,
    games: data.games.filter(g => {
      if (divFilter === 'ALL') return true
      return (g.home_division || g.division || '').toUpperCase() === divFilter
    }),
    top_hitters: data.top_hitters.filter(h => {
      if (divFilter === 'ALL') return true
      return (h.division || '').toUpperCase() === divFilter
    }),
    top_pitchers: data.top_pitchers.filter(p => {
      if (divFilter === 'ALL') return true
      return (p.division || '').toUpperCase() === divFilter
    }),
  } : null

  const generate = useCallback(async () => {
    if (!filteredData?.games?.length || !canvasRef.current) return
    const divLabel = divFilter !== 'ALL' ? divFilter : ''
    await renderGraphic(canvasRef.current, filteredData, shortDate(date), divLabel)
    setRendered(true)
  }, [filteredData, date, divFilter])

  useEffect(() => {
    if (filteredData?.games?.length > 0) generate()
    else setRendered(false)
  }, [filteredData, generate])

  const download = () => {
    if (!canvasRef.current) return
    const link = document.createElement('a')
    const suffix = divFilter !== 'ALL' ? `-${divFilter.toLowerCase()}` : ''
    link.download = `pnw-scores${suffix}-${date}.png`
    link.href = canvasRef.current.toDataURL('image/png')
    link.click()
  }

  const finalCount = filteredData?.games?.length ?? 0

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Daily Scores Graphic</h1>
      <p className="text-sm text-gray-500 mb-5">
        Generate a shareable scoreboard image for any game day.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal"
        />
        <button
          onClick={() => setDate(todayStr())}
          className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 transition-colors"
        >
          Today
        </button>
        {rendered && (
          <button
            onClick={download}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-nw-teal hover:bg-nw-teal/90 transition-colors"
          >
            Download PNG
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-5">
        {DIV_OPTIONS.map(d => (
          <button
            key={d}
            onClick={() => setDivFilter(d)}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
              divFilter === d
                ? 'bg-nw-teal text-white'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            {d === 'ALL' ? 'All' : d}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-gray-400 mb-4">Loading games...</p>}
      {error && <p className="text-sm text-red-500 mb-4">Error: {error}</p>}
      {!loading && data && finalCount === 0 && (
        <p className="text-sm text-gray-400 mb-4">No {divFilter !== 'ALL' ? divFilter + ' ' : ''}final games found for {fmtDisplayDate(date)}.</p>
      )}
      {!loading && finalCount > 0 && (
        <p className="text-sm text-gray-500 mb-4">
          {finalCount} game{finalCount !== 1 ? 's' : ''} on {fmtDisplayDate(date)}
        </p>
      )}

      <div className="rounded-lg overflow-hidden shadow-lg border border-gray-200 inline-block">
        <canvas
          ref={canvasRef}
          style={{ width: '100%', maxWidth: 540, height: 'auto', display: finalCount > 0 ? 'block' : 'none' }}
        />
      </div>
    </div>
  )
}
