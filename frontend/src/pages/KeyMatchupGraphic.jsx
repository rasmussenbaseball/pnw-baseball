import { useState, useRef, useCallback, useEffect } from 'react'

const API_BASE = '/api/v1'

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtDisplayDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
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

function fmtPct(val) {
  if (val == null) return '-'
  const n = parseFloat(val)
  return n >= 1 ? (n * 1).toFixed(1) + '%' : (n * 100).toFixed(1) + '%'
}

function fmtAvg(val) {
  if (val == null) return '-'
  return parseFloat(val).toFixed(3).replace(/^0/, '')
}

function fmtRate(val) {
  if (val == null) return '-'
  const n = parseFloat(val)
  return n >= 1 ? n.toFixed(3) : n.toFixed(3).replace(/^0/, '')
}

function fmtDec(val, decimals = 2) {
  if (val == null) return '-'
  return parseFloat(val).toFixed(decimals)
}

// ── COLORS ──
const TEAL = '#0d9488'
const DARK = '#1e293b'
const MED = '#475569'
const LIGHT_BG = '#f8fafc'
const CARD_BG = '#ffffff'
const ACCENT_BG = '#f0fdfa'
const BORDER = '#e2e8f0'
const GREEN = '#059669'
const RED = '#dc2626'

// ── Draw the full 1080x1080 graphic ──
async function drawGraphic(canvas, data) {
  const S = 1080
  canvas.width = S
  canvas.height = S
  const ctx = canvas.getContext('2d')

  // Background
  ctx.fillStyle = LIGHT_BG
  ctx.fillRect(0, 0, S, S)

  const teams = data.matchup.teams
  if (teams.length < 2) return
  const away = teams.find(t => t.side === 'away') || teams[0]
  const home = teams.find(t => t.side === 'home') || teams[1]

  const pad = 32
  const innerW = S - pad * 2

  // ── HEADER: "KEY MATCHUP" + date ──
  let y = pad
  ctx.fillStyle = TEAL
  roundRect(ctx, pad, y, innerW, 56, 10)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 26px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('KEY MATCHUP', S / 2, y + 28)
  ctx.font = '14px system-ui, -apple-system, sans-serif'
  ctx.fillText(fmtDisplayDate(data.date), S / 2, y + 48)
  y += 72

  // ── TEAM HEADER: logos + names + records ──
  const teamHeaderH = 120
  ctx.fillStyle = CARD_BG
  roundRect(ctx, pad, y, innerW, teamHeaderH, 10)
  ctx.fill()
  ctx.strokeStyle = BORDER
  ctx.lineWidth = 1
  roundRect(ctx, pad, y, innerW, teamHeaderH, 10)
  ctx.stroke()

  // VS badge
  ctx.fillStyle = DARK
  ctx.font = 'bold 20px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('VS', S / 2, y + teamHeaderH / 2 + 7)

  // Conference badge
  if (data.matchup.is_conference_game) {
    ctx.fillStyle = TEAL
    ctx.font = 'bold 11px system-ui, -apple-system, sans-serif'
    ctx.fillText('CONFERENCE GAME', S / 2, y + teamHeaderH / 2 + 24)
  }

  // Draw each team side
  for (const [team, xCenter] of [[away, S * 0.25], [home, S * 0.75]]) {
    const rec = team.record || {}
    const recStr = `${rec.wins || 0}-${rec.losses || 0}`
    // Logo
    try {
      const logo = await loadImage(team.logo_url)
      ctx.drawImage(logo, xCenter - 30, y + 12, 60, 60)
    } catch {}
    // Name
    ctx.fillStyle = DARK
    ctx.font = 'bold 22px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(team.short_name || team.name, xCenter, y + 90)
    // Record + division
    ctx.fillStyle = MED
    ctx.font = '14px system-ui, -apple-system, sans-serif'
    ctx.fillText(`${recStr}  •  ${team.division_level || ''} ${team.conference_abbrev || ''}`, xCenter, y + 108)
  }
  y += teamHeaderH + 12

  // ── TEAM STATS COMPARISON ──
  const statRows = buildStatComparison(away, home)
  const statRowH = 30
  const statBlockH = 32 + statRows.length * statRowH + 12
  ctx.fillStyle = CARD_BG
  roundRect(ctx, pad, y, innerW, statBlockH, 10)
  ctx.fill()
  ctx.strokeStyle = BORDER
  roundRect(ctx, pad, y, innerW, statBlockH, 10)
  ctx.stroke()

  // Section header
  ctx.fillStyle = TEAL
  ctx.font = 'bold 14px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('TEAM COMPARISON', S / 2, y + 22)
  y += 36

  // Column headers
  ctx.fillStyle = MED
  ctx.font = 'bold 11px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(away.short_name, pad + 16, y + 4)
  ctx.textAlign = 'right'
  ctx.fillText(home.short_name, S - pad - 16, y + 4)
  ctx.textAlign = 'center'
  ctx.fillText('STAT', S / 2, y + 4)
  y += 6

  for (let i = 0; i < statRows.length; i++) {
    const row = statRows[i]
    const ry = y + i * statRowH

    // Alternating row bg
    if (i % 2 === 0) {
      ctx.fillStyle = ACCENT_BG
      ctx.fillRect(pad + 4, ry, innerW - 8, statRowH)
    }

    // Determine which side is better
    const awayBetter = row.awayBetter
    const homeBetter = row.homeBetter

    // Away value
    ctx.font = awayBetter ? 'bold 15px system-ui, -apple-system, sans-serif' : '15px system-ui, -apple-system, sans-serif'
    ctx.fillStyle = awayBetter ? GREEN : DARK
    ctx.textAlign = 'left'
    ctx.fillText(row.awayVal, pad + 24, ry + 20)

    // Stat label
    ctx.font = 'bold 12px system-ui, -apple-system, sans-serif'
    ctx.fillStyle = MED
    ctx.textAlign = 'center'
    ctx.fillText(row.label, S / 2, ry + 20)

    // Home value
    ctx.font = homeBetter ? 'bold 15px system-ui, -apple-system, sans-serif' : '15px system-ui, -apple-system, sans-serif'
    ctx.fillStyle = homeBetter ? GREEN : DARK
    ctx.textAlign = 'right'
    ctx.fillText(row.homeVal, S - pad - 24, ry + 20)
  }
  y += statRows.length * statRowH + 16

  // ── TOP HITTERS (side by side) ──
  y = drawPlayerSection(ctx, 'TOP HITTERS (wRC+, 50+ PA)', away, home, 'hitters', pad, y, innerW, S)
  y += 12

  // ── TOP PITCHERS (side by side) ──
  y = drawPlayerSection(ctx, 'TOP PITCHERS (FIP, 15+ IP)', away, home, 'pitchers', pad, y, innerW, S)

  // ── FOOTER ──
  y = S - 36
  ctx.fillStyle = TEAL
  ctx.fillRect(pad, y, innerW, 24)
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 11px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('PNWBASEBALLSTATS.COM', S / 2, y + 16)
}

function buildStatComparison(away, home) {
  const ab = away.batting || {}
  const ap = away.pitching || {}
  const hb = home.batting || {}
  const hp = home.pitching || {}

  const rows = [
    { label: 'AVG', awayVal: fmtAvg(ab.team_avg), homeVal: fmtAvg(hb.team_avg), higher: true },
    { label: 'HR/PA', awayVal: fmtRate(ab.hr_per_pa), homeVal: fmtRate(hb.hr_per_pa), higher: true },
    { label: 'BB%', awayVal: fmtPct(ab.avg_bb_pct), homeVal: fmtPct(hb.avg_bb_pct), higher: true },
    { label: 'K%', awayVal: fmtPct(ab.avg_k_pct), homeVal: fmtPct(hb.avg_k_pct), higher: false },
    { label: 'SB', awayVal: String(ab.total_sb || 0), homeVal: String(hb.total_sb || 0), higher: true },
    { label: 'oWAR', awayVal: fmtDec(ab.total_owar, 1), homeVal: fmtDec(hb.total_owar, 1), higher: true },
    { label: 'pWAR', awayVal: fmtDec(ap.total_pwar, 1), homeVal: fmtDec(hp.total_pwar, 1), higher: true },
    { label: 'FIP', awayVal: fmtDec(ap.avg_fip), homeVal: fmtDec(hp.avg_fip), higher: false },
    { label: 'P K%', awayVal: fmtPct(ap.avg_k_pct), homeVal: fmtPct(hp.avg_k_pct), higher: true },
    { label: 'P BB%', awayVal: fmtPct(ap.avg_bb_pct), homeVal: fmtPct(hp.avg_bb_pct), higher: false },
    { label: 'Opp AVG', awayVal: fmtAvg(ap.opp_avg), homeVal: fmtAvg(hp.opp_avg), higher: false },
    { label: 'Opp HR/PA', awayVal: fmtRate(ap.opp_hr_per_pa), homeVal: fmtRate(hp.opp_hr_per_pa), higher: false },
  ]

  return rows.map(r => {
    const a = parseFloat(r.awayVal) || 0
    const h = parseFloat(r.homeVal) || 0
    let awayBetter = false, homeBetter = false
    if (a !== h) {
      if (r.higher) {
        awayBetter = a > h
        homeBetter = h > a
      } else {
        awayBetter = a < h
        homeBetter = h < a
      }
    }
    return { ...r, awayBetter, homeBetter }
  })
}

function drawPlayerSection(ctx, title, away, home, type, pad, startY, innerW, S) {
  const players = type === 'hitters'
    ? { away: away.top_hitters || [], home: home.top_hitters || [] }
    : { away: away.top_pitchers || [], home: home.top_pitchers || [] }

  const maxRows = 3
  const rowH = 36
  const headerH = 28
  const blockH = headerH + maxRows * rowH + 12

  ctx.fillStyle = CARD_BG
  roundRect(ctx, pad, startY, innerW, blockH, 10)
  ctx.fill()
  ctx.strokeStyle = BORDER
  roundRect(ctx, pad, startY, innerW, blockH, 10)
  ctx.stroke()

  // Section title
  ctx.fillStyle = TEAL
  ctx.font = 'bold 13px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(title, S / 2, startY + 20)

  let y = startY + headerH

  // Column sub-headers
  ctx.fillStyle = MED
  ctx.font = 'bold 10px system-ui, -apple-system, sans-serif'
  if (type === 'hitters') {
    // Away side headers
    ctx.textAlign = 'left'
    ctx.fillText('PLAYER', pad + 12, y + 4)
    ctx.textAlign = 'right'
    ctx.fillText('wRC+', pad + innerW / 2 - 16, y + 4)
    // Home side headers
    ctx.textAlign = 'left'
    ctx.fillText('PLAYER', S / 2 + 12, y + 4)
    ctx.textAlign = 'right'
    ctx.fillText('wRC+', S - pad - 12, y + 4)
  } else {
    ctx.textAlign = 'left'
    ctx.fillText('PLAYER', pad + 12, y + 4)
    ctx.textAlign = 'right'
    ctx.fillText('FIP', pad + innerW / 2 - 16, y + 4)
    ctx.textAlign = 'left'
    ctx.fillText('PLAYER', S / 2 + 12, y + 4)
    ctx.textAlign = 'right'
    ctx.fillText('FIP', S - pad - 12, y + 4)
  }
  y += 10

  // Divider line
  ctx.strokeStyle = BORDER
  ctx.lineWidth = 0.5
  ctx.beginPath()
  ctx.moveTo(S / 2, startY + headerH - 4)
  ctx.lineTo(S / 2, startY + blockH - 6)
  ctx.stroke()

  for (let i = 0; i < maxRows; i++) {
    const ry = y + i * rowH

    // Alternating bg
    if (i % 2 === 0) {
      ctx.fillStyle = ACCENT_BG
      ctx.fillRect(pad + 4, ry, innerW / 2 - 8, rowH)
      ctx.fillRect(S / 2 + 4, ry, innerW / 2 - 8, rowH)
    }

    // Away player
    const ap = players.away[i]
    if (ap) {
      const name = `${ap.first_name?.[0] || ''}. ${ap.last_name || ''}`
      ctx.fillStyle = DARK
      ctx.font = '14px system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(name, pad + 12, ry + 22)
      ctx.font = 'bold 15px system-ui, -apple-system, sans-serif'
      ctx.fillStyle = TEAL
      ctx.textAlign = 'right'
      if (type === 'hitters') {
        ctx.fillText(String(Math.round(ap.wrc_plus || 0)), pad + innerW / 2 - 16, ry + 22)
      } else {
        ctx.fillText(fmtDec(ap.fip), pad + innerW / 2 - 16, ry + 22)
      }
    }

    // Home player
    const hp = players.home[i]
    if (hp) {
      const name = `${hp.first_name?.[0] || ''}. ${hp.last_name || ''}`
      ctx.fillStyle = DARK
      ctx.font = '14px system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(name, S / 2 + 12, ry + 22)
      ctx.font = 'bold 15px system-ui, -apple-system, sans-serif'
      ctx.fillStyle = TEAL
      ctx.textAlign = 'right'
      if (type === 'hitters') {
        ctx.fillText(String(Math.round(hp.wrc_plus || 0)), S - pad - 12, ry + 22)
      } else {
        ctx.fillText(fmtDec(hp.fip), S - pad - 12, ry + 22)
      }
    }
  }

  return startY + blockH
}

// ── Main Component ──
export default function KeyMatchupGraphic() {
  const [date, setDate] = useState(todayStr())
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [selectedGameId, setSelectedGameId] = useState(null)
  const canvasRef = useRef(null)

  const fetchData = useCallback(async (d, gid) => {
    setLoading(true)
    setError(null)
    try {
      let url = `${API_BASE}/games/key-matchup?date=${d}&season=2026`
      if (gid) url += `&game_id=${gid}`
      const resp = await fetch(url)
      if (!resp.ok) throw new Error('Failed to fetch matchup data')
      const json = await resp.json()
      setData(json)
      if (json.matchup) {
        setSelectedGameId(json.matchup.game_id)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData(date, null)
  }, [date, fetchData])

  useEffect(() => {
    if (data?.matchup && canvasRef.current) {
      drawGraphic(canvasRef.current, data)
    }
  }, [data])

  const handleGameChange = (e) => {
    const gid = parseInt(e.target.value)
    setSelectedGameId(gid)
    fetchData(date, gid)
  }

  const handleDownload = () => {
    if (!canvasRef.current) return
    const link = document.createElement('a')
    link.download = `key-matchup-${date}.png`
    link.href = canvasRef.current.toDataURL('image/png')
    link.click()
  }

  const changeDate = (dir) => {
    const d = new Date(date + 'T12:00:00')
    d.setDate(d.getDate() + dir)
    setDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }

  return (
    <div className="min-h-screen bg-gray-50 py-6 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Key Matchup Graphic</h1>
          <p className="text-sm text-gray-500 mt-1">Generate a social media graphic for the top matchup of the day</p>
        </div>

        {/* Controls */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
          <div className="flex flex-wrap items-center gap-4">
            {/* Date nav */}
            <div className="flex items-center gap-2">
              <button onClick={() => changeDate(-1)} className="px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 text-sm font-medium">←</button>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="px-3 py-1.5 rounded border border-gray-300 text-sm"
              />
              <button onClick={() => changeDate(1)} className="px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 text-sm font-medium">→</button>
            </div>

            {/* Game picker */}
            {data?.games?.length > 0 && (
              <select
                value={selectedGameId || ''}
                onChange={handleGameChange}
                className="px-3 py-1.5 rounded border border-gray-300 text-sm flex-1 min-w-[200px]"
              >
                {data.games.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.away_short} @ {g.home_short}
                    {g.is_conference_game ? ' (Conf)' : ''}
                    {g.home_division ? ` — ${g.home_division}` : ''}
                  </option>
                ))}
              </select>
            )}

            {/* Download */}
            <button
              onClick={handleDownload}
              disabled={!data?.matchup}
              className="px-4 py-1.5 rounded bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium disabled:opacity-50"
            >
              Download PNG
            </button>
          </div>
        </div>

        {/* Canvas */}
        {loading && <p className="text-center text-gray-500 py-12">Loading...</p>}
        {error && <p className="text-center text-red-500 py-12">{error}</p>}
        {!loading && data && !data.matchup && (
          <p className="text-center text-gray-500 py-12">No PNW games found for {shortDate(date)}</p>
        )}
        {data?.matchup && (
          <div className="flex justify-center">
            <canvas
              ref={canvasRef}
              className="rounded-lg shadow-lg border border-gray-200"
              style={{ width: 540, height: 540 }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
