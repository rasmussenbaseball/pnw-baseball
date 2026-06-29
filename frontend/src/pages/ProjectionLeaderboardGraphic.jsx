// Projection Leaderboard Graphic — a shareable 2027-projection stat card.
//
// Three modes:
//   • Stat Leaders     — top N projected players in one stat (5–50)
//   • Best in Every Stat — the #1 projected player in every stat at once
//   • Biggest Gains     — largest 2026 -> 2027 improvement in one stat (breakouts)
//
// Filters: side (hitting/pitching), level, qualifier (min PA / IP), count, theme.
// One canvas drawing pipeline feeds both the live preview and the PNG download.
import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useProjectionPlayerLeaders } from '../hooks/useApi'

const SEASON = 2027
const LEVELS = ['All', 'D1', 'D2', 'D3', 'NAIA', 'JUCO']
const COUNTS = [5, 10, 15, 20, 25, 30, 40, 50]
const FONT = "-apple-system, 'Inter', 'Helvetica Neue', sans-serif"

// ── formatters ──
const slash = (v) => (v == null ? '–' : Number(v).toFixed(3).replace(/^0/, ''))
const f2 = (v) => (v == null ? '–' : Number(v).toFixed(2))
const f1 = (v) => (v == null ? '–' : Number(v).toFixed(1))
const int0 = (v) => (v == null ? '–' : Math.round(v).toLocaleString())
const pct1 = (v) => (v == null ? '–' : `${(v * 100).toFixed(1)}%`)
const ipNum = (ip) => { if (ip == null) return 0; const w = Math.floor(ip); const f = Math.round((ip - w) * 10); return w + (f >= 1 ? f / 3 : 0) }

// every projected stat we can show. delta = has a 2026 actual to diff for Gains.
const HIT_STATS = [
  { key: 'wOBA', label: 'wOBA', fmt: slash, delta: true },
  { key: 'OPS', label: 'OPS', fmt: slash, delta: true },
  { key: 'AVG', label: 'AVG', fmt: slash, delta: true },
  { key: 'OBP', label: 'OBP', fmt: slash, delta: true },
  { key: 'SLG', label: 'SLG', fmt: slash, delta: true },
  { key: 'iso', label: 'ISO', fmt: slash, delta: true },
  { key: 'HR', label: 'Home Runs', fmt: int0, delta: true },
  { key: 'R', label: 'Runs', fmt: int0, delta: true },
  { key: 'RBI', label: 'RBI', fmt: int0, delta: true },
  { key: 'BB', label: 'Walks', fmt: int0, delta: true },
  { key: 'bb_pct', label: 'BB%', fmt: pct1, delta: true },
  { key: 'k_pct', label: 'K%', fmt: pct1, lowerBetter: true, delta: true },
  { key: 'WAR', label: 'WAR', fmt: f1, delta: false },
  { key: 'PT', label: 'Plate Appearances', fmt: int0, delta: false },
]
const PIT_STATS = [
  { key: 'ERA', label: 'ERA', fmt: f2, lowerBetter: true, delta: true },
  { key: 'FIP', label: 'FIP', fmt: f2, lowerBetter: true, delta: true },
  { key: 'WHIP', label: 'WHIP', fmt: f2, lowerBetter: true, delta: true },
  { key: 'K_pct', label: 'K%', fmt: pct1, delta: true },
  { key: 'BB_pct', label: 'BB%', fmt: pct1, lowerBetter: true, delta: true },
  { key: 'HR9', label: 'HR/9', fmt: f2, lowerBetter: true, delta: true },
  { key: 'opp_avg', label: 'Opp AVG', fmt: slash, lowerBetter: true, delta: true },
  { key: 'WAR', label: 'WAR', fmt: f1, delta: false },
  { key: 'IP', label: 'Innings', fmt: f1, delta: false },
]

const THEMES = {
  midnight: { name: 'Midnight', bg: ['#0b1f2a', '#10303d'], band: ['#0d9488', '#0f766e'],
    text: '#f1f5f9', muted: '#93a3b3', accent: '#2dd4bf', bandText: '#ecfeff', bandSub: '#a7f3e6',
    row: 'rgba(255,255,255,0.05)', rule: 'rgba(255,255,255,0.08)', chip: '#134e4a', chipText: '#5eead4', up: '#34d399' },
  paper: { bg: ['#ffffff', '#eef2f6'], band: ['#0d9488', '#0f766e'],
    text: '#0f172a', muted: '#64748b', accent: '#0d9488', bandText: '#ffffff', bandSub: '#c8fff2',
    row: 'rgba(2,6,23,0.035)', rule: 'rgba(2,6,23,0.08)', chip: '#ccfbf1', chipText: '#0f766e', up: '#059669' },
  maroon: { name: 'Maroon', bg: ['#1a0f14', '#2a1620'], band: ['#7f1d3a', '#5b1228'],
    text: '#fdf2f5', muted: '#c4a3ad', accent: '#fb7185', bandText: '#fff1f4', bandSub: '#f8c6d2',
    row: 'rgba(255,255,255,0.05)', rule: 'rgba(255,255,255,0.08)', chip: '#4c1d2e', chipText: '#fda4af', up: '#fb7185' },
}

function grad(ctx, stops, x, y, w, h) {
  const g = ctx.createLinearGradient(x, y, x, y + h)
  stops.forEach((c, i) => g.addColorStop(stops.length > 1 ? i / (stops.length - 1) : 0, c))
  return g
}
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}
function clip(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1)
  return t + '…'
}

const W = 1080, PAD = 56, HEADER = 220, FOOTER = 92

function renderGraphic(canvas, { title, subtitle, rows, leadIsStat, mode, t }) {
  const twoCol = rows.length > 14
  const perCol = twoCol ? Math.ceil(rows.length / 2) : rows.length
  const ROWH = 70
  const bodyTop = HEADER + 26
  const height = bodyTop + perCol * ROWH + 24 + FOOTER
  canvas.width = W; canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = grad(ctx, t.bg, 0, 0, W, height); ctx.fillRect(0, 0, W, height)

  // header band
  ctx.fillStyle = grad(ctx, t.band, 0, 0, W, HEADER); ctx.fillRect(0, 0, W, HEADER)
  ctx.fillStyle = t.bandSub
  ctx.font = `700 26px ${FONT}`; ctx.textBaseline = 'alphabetic'
  ctx.fillText('2027 PROJECTIONS', PAD, 64)
  ctx.fillStyle = t.bandText
  ctx.font = `800 56px ${FONT}`
  ctx.fillText(clip(ctx, title, W - PAD * 2), PAD, 128)
  ctx.fillStyle = t.bandSub
  ctx.font = `500 27px ${FONT}`
  ctx.fillText(clip(ctx, subtitle, W - PAD * 2), PAD, 174)

  const colW = twoCol ? (W - PAD * 2 - 36) / 2 : (W - PAD * 2)
  const cols = twoCol ? [PAD, PAD + colW + 36] : [PAD]

  rows.forEach((r, i) => {
    const col = twoCol ? Math.floor(i / perCol) : 0
    const idxInCol = twoCol ? i % perCol : i
    const x = cols[col]
    const y = bodyTop + idxInCol * ROWH
    if (i % 2 === 0) { ctx.fillStyle = t.row; rrect(ctx, x, y, colW, ROWH - 8, 12); ctx.fill() }

    // lead: rank chip OR stat label
    const leadW = leadIsStat ? 168 : 56
    if (leadIsStat) {
      ctx.fillStyle = t.accent
      ctx.font = `800 30px ${FONT}`
      ctx.fillText(clip(ctx, r.lead, leadW), x + 12, y + 42)
    } else {
      const rank = r.lead
      ctx.fillStyle = rank === '1' ? t.accent : t.chip
      rrect(ctx, x + 8, y + 14, 44, 36, 10); ctx.fill()
      ctx.fillStyle = rank === '1' ? '#06231f' : t.chipText
      ctx.font = `800 24px ${FONT}`; ctx.textAlign = 'center'
      ctx.fillText(rank, x + 30, y + 40); ctx.textAlign = 'left'
    }

    // name + team
    const nameX = x + leadW + 8
    const valW = 150
    ctx.fillStyle = t.text
    ctx.font = `700 31px ${FONT}`
    ctx.fillText(clip(ctx, r.name, colW - leadW - valW - 24), nameX, y + 33)
    ctx.fillStyle = t.muted
    ctx.font = `500 22px ${FONT}`
    const sub = r.sub ? `${r.team} · ${r.sub}` : r.team
    ctx.fillText(clip(ctx, sub, colW - leadW - valW - 24), nameX, y + 58)

    // value (right)
    ctx.textAlign = 'right'
    ctx.fillStyle = t.accent
    ctx.font = `800 38px ${FONT}`
    ctx.fillText(r.value, x + colW - 10, y + 34)
    if (r.delta) {
      ctx.fillStyle = t.up
      ctx.font = `700 21px ${FONT}`
      ctx.fillText(r.delta, x + colW - 10, y + 60)
    }
    ctx.textAlign = 'left'
  })

  // footer
  const fy = height - FOOTER
  ctx.strokeStyle = t.rule; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(PAD, fy); ctx.lineTo(W - PAD, fy); ctx.stroke()
  ctx.fillStyle = t.text
  ctx.font = `800 30px ${FONT}`
  ctx.fillText('NW Baseball Stats', PAD, fy + 52)
  ctx.fillStyle = t.muted
  ctx.font = `500 24px ${FONT}`
  ctx.textAlign = 'right'
  ctx.fillText('nwbaseballstats.com', W - PAD, fy + 52)
  ctx.textAlign = 'left'
}

export default function ProjectionLeaderboardGraphic() {
  const [side, setSide] = useState('bat')
  const [mode, setMode] = useState('leaders')   // leaders | every | gains
  const [level, setLevel] = useState('All')
  const [statKey, setStatKey] = useState('wOBA')
  const [count, setCount] = useState(10)
  const [minQual, setMinQual] = useState(side === 'bat' ? 100 : 20)
  const [themeId, setThemeId] = useState('midnight')
  const canvasRef = useRef(null)

  const { data, loading } = useProjectionPlayerLeaders(side, SEASON)
  const STATS = side === 'bat' ? HIT_STATS : PIT_STATS
  const stat = STATS.find((s) => s.key === statKey) || STATS[0]
  const t = THEMES[themeId]

  // reset stat + qualifier when side flips
  const flipSide = (s) => {
    setSide(s)
    setStatKey(s === 'bat' ? 'wOBA' : 'ERA')
    setMinQual(s === 'bat' ? 100 : 20)
    if (mode === 'gains' && !(s === 'bat' ? HIT_STATS : PIT_STATS).find((x) => x.key === statKey)?.delta) setStatKey(s === 'bat' ? 'wOBA' : 'ERA')
  }

  const pool = useMemo(() => {
    let r = (data?.players || []).filter((p) => level === 'All' || p.level === level)
    r = r.filter((p) => (side === 'bat' ? (p.PT || 0) >= minQual : ipNum(p.IP) >= minQual))
    return r
  }, [data, level, minQual, side])

  const { rows, title, subtitle, leadIsStat } = useMemo(() => {
    const lvlLabel = level === 'All' ? 'PNW' : level
    const sideLabel = side === 'bat' ? 'Hitters' : 'Pitchers'
    const qualLabel = side === 'bat' ? `${minQual}+ PA` : `${minQual}+ IP`

    const topBy = (arr, s, n) => {
      const v = arr.filter((p) => p[s.key] != null)
      v.sort((a, b) => s.lowerBetter ? a[s.key] - b[s.key] : b[s.key] - a[s.key])
      return v.slice(0, n)
    }

    if (mode === 'every') {
      const rows = STATS.map((s) => {
        const top = topBy(pool, s, 1)[0]
        if (!top) return null
        return { lead: s.label, name: top.name, team: top.team, sub: top.level === level ? null : top.level,
          value: s.fmt(top[s.key]) }
      }).filter(Boolean)
      return { rows, leadIsStat: true,
        title: `Best Projected ${sideLabel}`,
        subtitle: `${lvlLabel} · top in every stat · ${qualLabel}` }
    }

    if (mode === 'gains') {
      const v = pool.filter((p) => p.a && p.a[stat.key] != null && p[stat.key] != null)
        .map((p) => ({ p, d: p[stat.key] - p.a[stat.key] }))
      // improvement: higher-better stat wants largest +d; lower-better wants largest -d
      v.sort((a, b) => stat.lowerBetter ? a.d - b.d : b.d - a.d)
      const rows = v.slice(0, count).map(({ p, d }, i) => {
        const sign = d > 0 ? '+' : ''
        const dStr = (['HR', 'R', 'RBI', 'BB'].includes(stat.key)) ? `${sign}${Math.round(d)}`
          : stat.fmt === pct1 ? `${sign}${(d * 100).toFixed(1)}pt`
          : `${sign}${d.toFixed(stat.fmt === slash ? 3 : 2).replace(/^(\+|-)?0\./, '$1.')}`
        return { lead: String(i + 1), name: p.name, team: p.team,
          sub: p.level === level ? null : p.level,
          value: stat.fmt(p[stat.key]),
          delta: `${stat.fmt(p.a[stat.key])} → ${dStr}` }
      })
      return { rows, leadIsStat: false,
        title: `Biggest ${stat.label} Gains`,
        subtitle: `${lvlLabel} ${sideLabel} · 2026 → 2027 · ${qualLabel}` }
    }

    // leaders
    const rows = topBy(pool, stat, count).map((p, i) => ({
      lead: String(i + 1), name: p.name, team: p.team,
      sub: p.level === level ? null : p.level, value: stat.fmt(p[stat.key]),
    }))
    return { rows, leadIsStat: false,
      title: `${stat.label} Leaders`,
      subtitle: `${lvlLabel} ${sideLabel} · projected ${SEASON} · ${qualLabel}` }
  }, [pool, mode, stat, count, side, level, minQual, STATS])

  useEffect(() => {
    if (canvasRef.current && rows.length) renderGraphic(canvasRef.current, { title, subtitle, rows, leadIsStat, mode, t })
  }, [rows, title, subtitle, leadIsStat, mode, t])

  const download = useCallback(() => {
    if (!canvasRef.current || !rows.length) return
    const a = document.createElement('a')
    a.download = `nwbb-proj-${mode}-${side}-${statKey}-${level}.png`
    a.href = canvasRef.current.toDataURL('image/png')
    a.click()
  }, [rows.length, mode, side, statKey, level])

  const Btn = ({ active, onClick, children }) => (
    <button onClick={onClick}
      className={`px-3 py-1.5 text-xs font-semibold rounded-md border ${active ? 'bg-nw-teal text-white border-nw-teal' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
      {children}
    </button>
  )
  const statChoices = mode === 'gains' ? STATS.filter((s) => s.delta) : STATS

  return (
    <div className="max-w-screen-xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">Projection Leaderboard Graphics</h1>
      <p className="text-sm text-gray-500 mb-5">Shareable 2027-projection stat cards. Top leaders in any stat, the best player in every stat, or the biggest 2026 → 2027 breakouts.</p>

      <div className="grid lg:grid-cols-[320px_1fr] gap-6">
        <div className="space-y-4">
          <div>
            <div className="text-xs font-semibold text-gray-500 mb-1.5">Side</div>
            <div className="flex gap-2">
              <Btn active={side === 'bat'} onClick={() => flipSide('bat')}>Hitting</Btn>
              <Btn active={side === 'pit'} onClick={() => flipSide('pit')}>Pitching</Btn>
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 mb-1.5">Mode</div>
            <div className="flex flex-wrap gap-2">
              <Btn active={mode === 'leaders'} onClick={() => setMode('leaders')}>Stat Leaders</Btn>
              <Btn active={mode === 'every'} onClick={() => setMode('every')}>Best in Every Stat</Btn>
              <Btn active={mode === 'gains'} onClick={() => { setMode('gains'); if (!stat.delta) setStatKey(statChoices[0].key) }}>Biggest Gains</Btn>
            </div>
          </div>
          {mode !== 'every' && (
            <div>
              <div className="text-xs font-semibold text-gray-500 mb-1.5">Stat</div>
              <select value={statKey} onChange={(e) => setStatKey(e.target.value)}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm">
                {statChoices.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
          )}
          <div>
            <div className="text-xs font-semibold text-gray-500 mb-1.5">Level</div>
            <div className="flex flex-wrap gap-1.5">
              {LEVELS.map((lv) => <Btn key={lv} active={level === lv} onClick={() => setLevel(lv)}>{lv}</Btn>)}
            </div>
          </div>
          {mode !== 'every' && (
            <div>
              <div className="text-xs font-semibold text-gray-500 mb-1.5">How many</div>
              <div className="flex flex-wrap gap-1.5">
                {COUNTS.map((n) => <Btn key={n} active={count === n} onClick={() => setCount(n)}>{n}</Btn>)}
              </div>
            </div>
          )}
          <div>
            <div className="text-xs font-semibold text-gray-500 mb-1.5">Qualifier — min {side === 'bat' ? 'PA' : 'IP'}</div>
            <input type="number" value={minQual} min={0} step={side === 'bat' ? 10 : 5}
              onChange={(e) => setMinQual(Number(e.target.value) || 0)}
              className="w-32 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm" />
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 mb-1.5">Theme</div>
            <div className="flex gap-2">
              {Object.entries(THEMES).map(([id, th]) => (
                <button key={id} onClick={() => setThemeId(id)} title={th.name}
                  className={`h-8 w-8 rounded-full border-2 ${themeId === id ? 'border-nw-teal' : 'border-transparent'}`}
                  style={{ background: `linear-gradient(135deg, ${th.bg[0]}, ${th.band[0]})` }} />
              ))}
            </div>
          </div>
          <button onClick={download} disabled={!rows.length}
            className="w-full py-2.5 rounded-md bg-nw-teal text-white font-semibold text-sm hover:bg-nw-teal/90 disabled:opacity-50">
            ⬇ Download PNG
          </button>
        </div>

        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-4 overflow-auto">
          {loading ? <p className="text-sm text-gray-500 py-10 text-center">Loading projections…</p>
            : !rows.length ? <p className="text-sm text-gray-500 py-10 text-center">No players match these filters.</p>
            : <canvas ref={canvasRef} className="w-full h-auto rounded-md shadow" style={{ maxWidth: 640, margin: '0 auto', display: 'block' }} />}
        </div>
      </div>
    </div>
  )
}
