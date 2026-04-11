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
  return n >= 1 ? n.toFixed(1) + '%' : (n * 100).toFixed(1) + '%'
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

function fmtIP(ip) {
  if (ip == null) return '0'
  const whole = Math.floor(ip)
  const frac = ip - whole
  if (frac < 0.1) return String(whole)
  if (frac < 0.5) return `${whole}.1`
  if (frac < 0.8) return `${whole}.2`
  return String(whole + 1)
}

// ── COLORS (brand teal) ──
const TEAL = '#00687a'
const TEAL_DARK = '#004d5a'
const TEAL_LIGHT = '#008a9e'
const DARK = '#1e293b'
const MED = '#475569'
const LIGHT_BG = '#f8fafc'
const CARD_BG = '#ffffff'
const ACCENT_BG = '#e6f4f1'
const BORDER = '#e2e8f0'
const GREEN = '#059669'

// ── Draw the full 1080x1080 graphic ──
async function drawGraphic(canvas, data, prediction) {
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

  const pad = 28
  const innerW = S - pad * 2
  const halfW = innerW / 2

  // ── HEADER ──
  let y = pad
  ctx.fillStyle = TEAL
  roundRect(ctx, pad, y, innerW, 52, 10)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 24px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('KEY MATCHUP', S / 2, y + 26)
  ctx.font = '13px system-ui, -apple-system, sans-serif'
  ctx.fillText(fmtDisplayDate(data.date), S / 2, y + 44)
  y += 62

  // ── TEAM HEADER: logos + names + records ──
  const teamHeaderH = 110
  ctx.fillStyle = CARD_BG
  roundRect(ctx, pad, y, innerW, teamHeaderH, 10)
  ctx.fill()
  ctx.strokeStyle = BORDER
  ctx.lineWidth = 1
  roundRect(ctx, pad, y, innerW, teamHeaderH, 10)
  ctx.stroke()

  // VS badge
  ctx.fillStyle = DARK
  ctx.font = 'bold 18px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('VS', S / 2, y + 50)

  // Conference badge
  if (data.matchup.is_conference_game) {
    ctx.fillStyle = TEAL
    ctx.font = 'bold 10px system-ui, -apple-system, sans-serif'
    ctx.fillText('CONFERENCE GAME', S / 2, y + 66)
  }

  // Draw each team side
  for (const [team, xCenter] of [[away, pad + halfW / 2], [home, S - pad - halfW / 2]]) {
    const rec = team.record || {}
    const recStr = `${rec.wins || 0}-${rec.losses || 0}`
    try {
      const logo = await loadImage(team.logo_url)
      ctx.drawImage(logo, xCenter - 26, y + 10, 52, 52)
    } catch {}
    ctx.fillStyle = DARK
    ctx.font = 'bold 20px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(team.short_name || team.name, xCenter, y + 80)
    ctx.fillStyle = MED
    ctx.font = '12px system-ui, -apple-system, sans-serif'
    ctx.fillText(`${recStr}  •  ${team.division_level || ''} ${team.conference_abbrev || ''}`, xCenter, y + 96)
  }
  y += teamHeaderH + 8

  // ── PREDICTION BAR: Win%, Spread, O/U ──
  if (prediction) {
    const predH = 44
    ctx.fillStyle = TEAL_DARK
    roundRect(ctx, pad, y, innerW, predH, 8)
    ctx.fill()

    const matchup = prediction.matchups?.[0]
    if (matchup) {
      const awayWinPct = matchup.win_prob_a != null
        ? (away.id === matchup.team_a ? matchup.win_prob_a : matchup.win_prob_b)
        : null
      const homeWinPct = matchup.win_prob_a != null
        ? (home.id === matchup.team_a ? matchup.win_prob_a : matchup.win_prob_b)
        : null
      const spread = matchup.spread != null
        ? (matchup.favored === away.id ? -matchup.spread : matchup.spread)
        : null  // negative = away favored, positive = home favored
      const ou = matchup.proj_total

      ctx.fillStyle = '#fff'
      ctx.font = 'bold 13px system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'center'

      // Away win%
      if (awayWinPct != null) {
        ctx.fillText(`${(awayWinPct * 100).toFixed(0)}%`, pad + innerW * 0.15, y + predH / 2 + 5)
      }
      // Spread
      if (spread != null) {
        const absSpread = Math.abs(matchup.spread).toFixed(1)
        const spreadStr = matchup.favored === away.id
          ? `${away.short_name} -${absSpread}`
          : `${home.short_name} -${absSpread}`
        ctx.font = '12px system-ui, -apple-system, sans-serif'
        ctx.fillText(spreadStr, S / 2 - 70, y + predH / 2 + 5)
      }
      // O/U
      if (ou != null) {
        ctx.font = '12px system-ui, -apple-system, sans-serif'
        ctx.fillText(`O/U ${ou.toFixed(1)}`, S / 2 + 70, y + predH / 2 + 5)
      }
      // Home win%
      if (homeWinPct != null) {
        ctx.font = 'bold 13px system-ui, -apple-system, sans-serif'
        ctx.fillText(`${(homeWinPct * 100).toFixed(0)}%`, S - pad - innerW * 0.15, y + predH / 2 + 5)
      }

      // Labels
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.font = '9px system-ui, -apple-system, sans-serif'
      ctx.fillText('WIN %', pad + innerW * 0.15, y + 12)
      ctx.fillText('SPREAD', S / 2 - 70, y + 12)
      ctx.fillText('OVER/UNDER', S / 2 + 70, y + 12)
      ctx.fillText('WIN %', S - pad - innerW * 0.15, y + 12)
    }
    y += predH + 8
  }

  // ── TEAM STATS COMPARISON ──
  const statRows = buildStatComparison(away, home)
  const statRowH = 24
  const statHeaderH = 30
  const statBlockH = statHeaderH + statRows.length * statRowH + 8
  ctx.fillStyle = CARD_BG
  roundRect(ctx, pad, y, innerW, statBlockH, 10)
  ctx.fill()
  ctx.strokeStyle = BORDER
  roundRect(ctx, pad, y, innerW, statBlockH, 10)
  ctx.stroke()

  // Section header
  ctx.fillStyle = TEAL
  ctx.font = 'bold 13px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('TEAM COMPARISON', S / 2, y + 20)

  // Column headers
  ctx.fillStyle = MED
  ctx.font = 'bold 10px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(away.short_name, pad + 20, y + 20)
  ctx.textAlign = 'right'
  ctx.fillText(home.short_name, S - pad - 20, y + 20)
  y += statHeaderH

  // Stat values positioned much closer to center
  const valInset = 180  // distance from edge for values (closer to center)
  const labelX = S / 2

  for (let i = 0; i < statRows.length; i++) {
    const row = statRows[i]
    const ry = y + i * statRowH

    if (i % 2 === 0) {
      ctx.fillStyle = ACCENT_BG
      ctx.fillRect(pad + 4, ry, innerW - 8, statRowH)
    }

    // Away value (right-aligned, close to center)
    ctx.font = row.awayBetter ? 'bold 13px system-ui, -apple-system, sans-serif' : '13px system-ui, -apple-system, sans-serif'
    ctx.fillStyle = row.awayBetter ? GREEN : DARK
    ctx.textAlign = 'right'
    ctx.fillText(row.awayVal, labelX - 50, ry + 17)

    // Stat label (centered)
    ctx.font = 'bold 11px system-ui, -apple-system, sans-serif'
    ctx.fillStyle = MED
    ctx.textAlign = 'center'
    ctx.fillText(row.label, labelX, ry + 17)

    // Home value (left-aligned, close to center)
    ctx.font = row.homeBetter ? 'bold 13px system-ui, -apple-system, sans-serif' : '13px system-ui, -apple-system, sans-serif'
    ctx.fillStyle = row.homeBetter ? GREEN : DARK
    ctx.textAlign = 'left'
    ctx.fillText(row.homeVal, labelX + 50, ry + 17)
  }
  y += statRows.length * statRowH + 14

  // ── TOP HITTERS ──
  y = drawPlayerSection(ctx, 'TOP HITTERS  (50+ PA)', away, home, 'hitters', pad, y, innerW, S)
  y += 8

  // ── TOP PITCHERS ──
  y = drawPlayerSection(ctx, 'TOP PITCHERS  (15+ IP)', away, home, 'pitchers', pad, y, innerW, S)

  // ── FOOTER ──
  const footerY = S - 32
  ctx.fillStyle = TEAL
  roundRect(ctx, pad, footerY, innerW, 22, 6)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 10px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('PNWBASEBALLSTATS.COM', S / 2, footerY + 15)
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
      if (r.higher) { awayBetter = a > h; homeBetter = h > a }
      else { awayBetter = a < h; homeBetter = h < a }
    }
    return { ...r, awayBetter, homeBetter }
  })
}

function drawPlayerSection(ctx, title, away, home, type, pad, startY, innerW, S) {
  const players = type === 'hitters'
    ? { away: away.top_hitters || [], home: home.top_hitters || [] }
    : { away: away.top_pitchers || [], home: home.top_pitchers || [] }

  const maxRows = 3
  const rowH = 44
  const headerH = 32
  const subHeaderH = 16
  const blockH = headerH + subHeaderH + maxRows * rowH + 8

  ctx.fillStyle = CARD_BG
  roundRect(ctx, pad, startY, innerW, blockH, 10)
  ctx.fill()
  ctx.strokeStyle = BORDER
  roundRect(ctx, pad, startY, innerW, blockH, 10)
  ctx.stroke()

  // Section title
  ctx.fillStyle = TEAL
  ctx.font = 'bold 12px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(title, S / 2, startY + 20)

  // Divider line down center
  ctx.strokeStyle = BORDER
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(S / 2, startY + headerH - 2)
  ctx.lineTo(S / 2, startY + blockH - 4)
  ctx.stroke()

  let y = startY + headerH

  // Sub-headers for each side
  const leftStart = pad + 8
  const leftEnd = S / 2 - 8
  const rightStart = S / 2 + 8
  const rightEnd = S - pad - 8
  const sideW = leftEnd - leftStart

  ctx.fillStyle = MED
  ctx.font = 'bold 9px system-ui, -apple-system, sans-serif'

  if (type === 'hitters') {
    // Away headers
    ctx.textAlign = 'left'
    ctx.fillText('PLAYER', leftStart + 4, y + 10)
    ctx.textAlign = 'right'
    ctx.fillText('AVG', leftStart + sideW * 0.52, y + 10)
    ctx.fillText('HR', leftStart + sideW * 0.68, y + 10)
    ctx.fillText('wRC+', leftStart + sideW * 0.84, y + 10)
    ctx.fillText('oWAR', leftEnd - 2, y + 10)
    // Home headers
    ctx.textAlign = 'left'
    ctx.fillText('PLAYER', rightStart + 4, y + 10)
    ctx.textAlign = 'right'
    ctx.fillText('AVG', rightStart + sideW * 0.52, y + 10)
    ctx.fillText('HR', rightStart + sideW * 0.68, y + 10)
    ctx.fillText('wRC+', rightStart + sideW * 0.84, y + 10)
    ctx.fillText('oWAR', rightEnd - 2, y + 10)
  } else {
    ctx.textAlign = 'left'
    ctx.fillText('PLAYER', leftStart + 4, y + 10)
    ctx.textAlign = 'right'
    ctx.fillText('ERA', leftStart + sideW * 0.52, y + 10)
    ctx.fillText('IP', leftStart + sideW * 0.66, y + 10)
    ctx.fillText('FIP', leftStart + sideW * 0.82, y + 10)
    ctx.fillText('pWAR', leftEnd - 2, y + 10)
    ctx.textAlign = 'left'
    ctx.fillText('PLAYER', rightStart + 4, y + 10)
    ctx.textAlign = 'right'
    ctx.fillText('ERA', rightStart + sideW * 0.52, y + 10)
    ctx.fillText('IP', rightStart + sideW * 0.66, y + 10)
    ctx.fillText('FIP', rightStart + sideW * 0.82, y + 10)
    ctx.fillText('pWAR', rightEnd - 2, y + 10)
  }
  y += subHeaderH

  for (let i = 0; i < maxRows; i++) {
    const ry = y + i * rowH

    if (i % 2 === 0) {
      ctx.fillStyle = ACCENT_BG
      ctx.fillRect(pad + 4, ry, innerW / 2 - 8, rowH)
      ctx.fillRect(S / 2 + 4, ry, innerW / 2 - 8, rowH)
    }

    // Away player
    const ap = players.away[i]
    if (ap) {
      drawPlayerRow(ctx, ap, type, leftStart, leftEnd, sideW, ry)
    }

    // Home player
    const hp = players.home[i]
    if (hp) {
      drawPlayerRow(ctx, hp, type, rightStart, rightEnd, sideW, ry)
    }
  }

  return startY + blockH
}

function drawPlayerRow(ctx, player, type, xStart, xEnd, sideW, ry) {
  const name = `${player.first_name?.[0] || ''}. ${player.last_name || ''}`

  // Player name
  ctx.fillStyle = DARK
  ctx.font = '13px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(name, xStart + 4, ry + 18)

  // Position tag
  if (player.position) {
    ctx.fillStyle = MED
    ctx.font = '9px system-ui, -apple-system, sans-serif'
    ctx.fillText(player.position, xStart + 4, ry + 32)
  }

  ctx.textAlign = 'right'
  ctx.font = '12px system-ui, -apple-system, sans-serif'

  if (type === 'hitters') {
    // AVG
    ctx.fillStyle = DARK
    ctx.fillText(fmtAvg(player.batting_avg), xStart + sideW * 0.52, ry + 25)
    // HR
    ctx.fillText(String(player.home_runs || 0), xStart + sideW * 0.68, ry + 25)
    // wRC+ (highlighted)
    ctx.fillStyle = TEAL
    ctx.font = 'bold 13px system-ui, -apple-system, sans-serif'
    ctx.fillText(String(Math.round(player.wrc_plus || 0)), xStart + sideW * 0.84, ry + 25)
    // oWAR
    ctx.fillStyle = DARK
    ctx.font = '12px system-ui, -apple-system, sans-serif'
    ctx.fillText(fmtDec(player.offensive_war, 1), xEnd - 2, ry + 25)
  } else {
    // ERA
    ctx.fillStyle = DARK
    ctx.fillText(fmtDec(player.era), xStart + sideW * 0.52, ry + 25)
    // IP
    ctx.fillText(fmtIP(player.innings_pitched), xStart + sideW * 0.66, ry + 25)
    // FIP (highlighted)
    ctx.fillStyle = TEAL
    ctx.font = 'bold 13px system-ui, -apple-system, sans-serif'
    ctx.fillText(fmtDec(player.fip), xStart + sideW * 0.82, ry + 25)
    // pWAR
    ctx.fillStyle = DARK
    ctx.font = '12px system-ui, -apple-system, sans-serif'
    ctx.fillText(fmtDec(player.pitching_war, 1), xEnd - 2, ry + 25)
  }
}

// ── Main Component ──
export default function KeyMatchupGraphic() {
  const [date, setDate] = useState(todayStr())
  const [data, setData] = useState(null)
  const [prediction, setPrediction] = useState(null)
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
        // Fetch prediction for these two teams
        const teamIds = json.matchup.teams.map(t => t.id).join(',')
        if (teamIds) {
          try {
            const predResp = await fetch(`${API_BASE}/teams/matchup?season=2026&team_ids=${teamIds}`)
            if (predResp.ok) {
              const predJson = await predResp.json()
              setPrediction(predJson)
            }
          } catch {}
        }
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
      drawGraphic(canvasRef.current, data, prediction)
    }
  }, [data, prediction])

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
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Key Matchup Graphic</h1>
          <p className="text-sm text-gray-500 mt-1">Generate a social media graphic for the top matchup of the day</p>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <button onClick={() => changeDate(-1)} className="px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 text-sm font-medium">&larr;</button>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className="px-3 py-1.5 rounded border border-gray-300 text-sm" />
              <button onClick={() => changeDate(1)} className="px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 text-sm font-medium">&rarr;</button>
            </div>

            {data?.games?.length > 0 && (
              <select value={selectedGameId || ''} onChange={handleGameChange} className="px-3 py-1.5 rounded border border-gray-300 text-sm flex-1 min-w-[200px]">
                {data.games.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.away_short} @ {g.home_short}{g.is_conference_game ? ' (Conf)' : ''}{g.home_division ? ` — ${g.home_division}` : ''}
                  </option>
                ))}
              </select>
            )}

            <button onClick={handleDownload} disabled={!data?.matchup} className="px-4 py-1.5 rounded text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#00687a' }}>
              Download PNG
            </button>
          </div>
        </div>

        {loading && <p className="text-center text-gray-500 py-12">Loading...</p>}
        {error && <p className="text-center text-red-500 py-12">{error}</p>}
        {!loading && data && !data.matchup && (
          <p className="text-center text-gray-500 py-12">No PNW games found for {shortDate(date)}</p>
        )}
        {data?.matchup && (
          <div className="flex justify-center">
            <canvas ref={canvasRef} className="rounded-lg shadow-lg border border-gray-200" style={{ width: 540, height: 540 }} />
          </div>
        )}
      </div>
    </div>
  )
}
