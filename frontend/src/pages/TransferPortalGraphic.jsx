// TransferPortalGraphic — /graphics/portal-tracker  (dev/admin only)
//
// Shareable leaderboard-style graphic for the Transfer Portal Tracker and the
// JUCO (NWAC) Tracker, in the green PNWCBR co-brand. Mirrors the WCL leaderboard
// graphic: a canvas board with density-based stat columns (more players shown =
// fewer stat columns) so Top 10 / 20 / 50 each stay legible. Hitters and
// pitchers each get their own stat set; positional filter + hide-committed
// toggle apply to both boards.
//
// Data: /transfer-portal and /players/juco/uncommitted (recruiting-tier gated;
// dev users bypass). We over-fetch then filter/sort/top-N client-side so the
// controls are responsive without re-hitting the API.

import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'

const SIZE = { w: 1080 }
const FONT = "-apple-system, 'Inter', 'Helvetica Neue', sans-serif"

// ── Green / PNWCBR theme ──
const T = {
  bg: '#0d2818', bg2: '#13391f',
  header1: '#15512c', header2: '#1d7a40',
  rule: '#36c46a',
  kicker: '#9be8b6', text: '#ffffff', sub: 'rgba(255,255,255,0.72)',
  rowBg: 'rgba(255,255,255,0.05)', rowAlt: 'rgba(255,255,255,0.08)',
  rowTop3: 'rgba(54,196,106,0.18)', accent: '#36c46a',
  name: '#ffffff', meta: 'rgba(255,255,255,0.66)',
  statMain: '#9be8b6', stat: '#ffffff',
  footerBg: '#0a1f12', footerText: 'rgba(255,255,255,0.7)',
  logoFallback: 'rgba(255,255,255,0.12)',
}

// Stat tiers per size — fewer columns as the list grows (leaderboard-graphic feel).
const HIT_TIERS = {
  10: [['offensive_war','oWAR','war'],['batting_avg','AVG','avg'],['on_base_pct','OBP','avg'],['slugging_pct','SLG','avg'],['ops','OPS','avg'],['wrc_plus','wRC+','int'],['home_runs','HR','int']],
  20: [['offensive_war','oWAR','war'],['batting_avg','AVG','avg'],['ops','OPS','avg'],['wrc_plus','wRC+','int']],
  50: [['offensive_war','oWAR','war'],['ops','OPS','avg']],
}
const PIT_TIERS = {
  10: [['pitching_war','pWAR','war'],['era','ERA','era'],['fip','FIP','era'],['pitch_k_pct','K%','pct'],['pitch_bb_pct','BB%','pct'],['innings_pitched','IP','ip']],
  20: [['pitching_war','pWAR','war'],['fip','FIP','era'],['pitch_k_pct','K%','pct'],['pitch_bb_pct','BB%','pct']],
  50: [['pitching_war','pWAR','war'],['fip','FIP','era']],
}
const SORT_KEY = { hitters: 'offensive_war', pitchers: 'pitching_war' }

const POSITIONS = {
  hitters: [['all','All'],['C','C'],['IF','IF'],['OF','OF'],['DH','DH']],
  pitchers: [['all','All'],['RHP','RHP'],['LHP','LHP']],
}

function fmt(val, format) {
  if (val == null || val === '') return '-'
  switch (format) {
    case 'avg': return Number(val).toFixed(3).replace(/^0/, '')
    case 'era': return Number(val).toFixed(2)
    case 'pct': return (Number(val) * 100).toFixed(1) + '%'
    case 'ip':  return Number(val).toFixed(1)
    case 'war': return Number(val).toFixed(1)
    case 'int': return val == null ? '-' : Math.round(Number(val)).toString()
    default: return String(val)
  }
}

async function authHeaders() {
  try {
    const { data } = await supabase.auth.getSession()
    const t = data?.session?.access_token
    return t ? { Authorization: `Bearer ${t}` } : {}
  } catch { return {} }
}

async function loadImg(src) {
  if (!src) return null
  const external = src.startsWith('http') && !src.includes(window.location.hostname)
  const url = external ? `/api/v1/proxy-image?url=${encodeURIComponent(src)}` : src
  try {
    const r = await fetch(url); if (!r.ok) return null
    const blob = await r.blob(); const ou = URL.createObjectURL(blob)
    return await new Promise(res => {
      const im = new Image()
      im.onload = () => { res(im); URL.revokeObjectURL(ou) }
      im.onerror = () => { res(null); URL.revokeObjectURL(ou) }
      im.src = ou
    })
  } catch { return null }
}
const _logoCache = {}
const cachedLogo = s => { if (!s) return Promise.resolve(null); if (!_logoCache[s]) _logoCache[s] = loadImg(s); return _logoCache[s] }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath()
}
function trunc(ctx, text, maxW) {
  text = text || ''
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1)
  return t + '…'
}
function contain(ctx, img, x, y, bw, bh) {
  if (!img) return
  const s = Math.min(bw / img.width, bh / img.height)
  const dw = img.width * s, dh = img.height * s
  ctx.drawImage(img, x + (bw - dw) / 2, y + (bh - dh) / 2, dw, dh)
}

async function renderBoard(canvas, opts) {
  const { rows, side, count, statTier, title, subtitle } = opts
  const twoCol = count >= 40
  const cols = twoCol ? 2 : 1
  const perCol = Math.ceil(count / cols)

  const W = SIZE.w
  const pad = 40
  const headerH = 150
  const footerH = 56
  const rowH = twoCol ? 40 : 54
  const rowGap = twoCol ? 6 : 8
  const bodyTop = headerH + 18
  const bodyH = perCol * rowH + (perCol - 1) * rowGap
  const H = bodyTop + bodyH + 24 + footerH

  const dpr = 2
  canvas.width = W * dpr; canvas.height = H * dpr
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  // background
  const bg = ctx.createLinearGradient(0, 0, 0, H)
  bg.addColorStop(0, T.bg); bg.addColorStop(1, T.bg2)
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H)

  // header
  const hg = ctx.createLinearGradient(0, 0, W, 0)
  hg.addColorStop(0, T.header1); hg.addColorStop(1, T.header2)
  ctx.fillStyle = hg; ctx.fillRect(0, 0, W, headerH)
  ctx.fillStyle = T.rule; ctx.fillRect(0, headerH - 4, W, 4)

  // logos: NWBB left, PNWCBR right
  const [nwLogo, cbrLogo] = await Promise.all([cachedLogo('/images/nw-logo-white.png'), cachedLogo('/images/cbr-logo.png')])
  contain(ctx, nwLogo, pad, 30, 84, 84)
  // PNWCBR logo: the HD transparent mark is dark-green with cut-out lettering,
  // so it needs a light chip behind it to read against the green header.
  if (cbrLogo) {
    const cw = 112, ch = 100, cx = W - pad - cw, cy = 25
    ctx.save(); ctx.fillStyle = '#ffffff'; roundRect(ctx, cx, cy, cw, ch, 14); ctx.fill(); ctx.restore()
    contain(ctx, cbrLogo, cx + 8, cy + 7, cw - 16, ch - 14)
  }

  // title block (centered)
  ctx.textAlign = 'center'
  ctx.fillStyle = T.kicker
  ctx.font = `700 16px ${FONT}`
  ctx.fillText((subtitle || '').toUpperCase(), W / 2, 44)
  ctx.fillStyle = T.text
  ctx.font = `900 38px ${FONT}`
  ctx.fillText(trunc(ctx, title, W - 300), W / 2, 86)
  ctx.fillStyle = T.sub
  ctx.font = `600 15px ${FONT}`
  ctx.fillText(`Top ${count} · sorted by ${statTier[0][1]}`, W / 2, 116)

  if (!rows.length) {
    ctx.fillStyle = T.sub; ctx.font = `600 20px ${FONT}`
    ctx.fillText('No players match these filters.', W / 2, bodyTop + 60)
    drawFooter()
    return
  }

  // column geometry
  const colGap = twoCol ? 16 : 0
  const colW = (W - pad * 2 - colGap * (cols - 1)) / cols
  // left identity zone fixed, stat columns share the rest
  const nStats = statTier.length
  const idW = twoCol ? Math.floor(colW * 0.46) : Math.floor(colW * 0.40)
  const statsZoneW = colW - idW
  const statColW = statsZoneW / nStats

  const shown = rows.slice(0, count)
  const logos = await Promise.all(shown.map(p => cachedLogo(p.logo_url)))

  shown.forEach((p, i) => {
    const c = twoCol ? Math.floor(i / perCol) : 0
    const ri = twoCol ? i % perCol : i
    const x = pad + c * (colW + colGap)
    const y = bodyTop + ri * (rowH + rowGap)
    const top3 = i < 3
    ctx.fillStyle = top3 ? T.rowTop3 : (i % 2 ? T.rowAlt : T.rowBg)
    roundRect(ctx, x, y, colW, rowH, 8); ctx.fill()
    if (top3) { ctx.fillStyle = T.accent; ctx.fillRect(x, y, 4, rowH) }
    const cy = y + rowH / 2
    ctx.textBaseline = 'middle'

    // rank
    ctx.textAlign = 'left'
    ctx.fillStyle = top3 ? T.accent : T.meta
    ctx.font = `800 ${twoCol ? 15 : 18}px ${FONT}`
    let cx = x + 12
    ctx.fillText(String(i + 1), cx, cy)
    cx += twoCol ? 24 : 30

    // team logo
    const ls = twoCol ? 22 : 30
    if (logos[i]) contain(ctx, logos[i], cx, cy - ls / 2, ls, ls)
    else { ctx.fillStyle = T.logoFallback; roundRect(ctx, cx, cy - ls / 2, ls, ls, 5); ctx.fill() }
    cx += ls + 8

    // name + meta line
    const nameMaxW = x + idW - cx - 6
    const nm = `${p.first_name || ''} ${p.last_name || ''}`.trim()
    ctx.fillStyle = T.name
    ctx.font = `800 ${twoCol ? 15 : 18}px ${FONT}`
    ctx.fillText(trunc(ctx, nm, nameMaxW), cx, cy - (twoCol ? 7 : 9))
    // meta: POS · TEAM · B/T · Yr  (+ commit)
    const bt = [p.bats, p.throws].filter(Boolean).join('/')
    const metaBits = [p.position, p.team_short || p.team_name, bt, fmtYr(p.year_in_school)].filter(Boolean)
    ctx.fillStyle = T.meta
    ctx.font = `600 ${twoCol ? 11 : 12.5}px ${FONT}`
    ctx.fillText(trunc(ctx, metaBits.join(' · '), nameMaxW), cx, cy + (twoCol ? 8 : 8))
    // commitment line (small, accent if committed)
    const commit = p.committed_to ? `→ ${p.committed_to}` : 'Uncommitted'
    ctx.fillStyle = p.committed_to ? T.kicker : T.sub
    ctx.font = `${p.committed_to ? 700 : 500} ${twoCol ? 10.5 : 12}px ${FONT}`
    ctx.fillText(trunc(ctx, commit, nameMaxW), cx, cy + (twoCol ? 22 : 26))

    // stat columns
    const sx0 = x + idW
    statTier.forEach(([key, , f], si) => {
      const sx = sx0 + si * statColW + statColW / 2
      ctx.textAlign = 'center'
      ctx.fillStyle = si === 0 ? T.statMain : T.stat
      ctx.font = `${si === 0 ? 900 : 700} ${twoCol ? 15 : 19}px ${FONT}`
      ctx.fillText(fmt(p[key], f), sx, cy - 8)
      ctx.fillStyle = T.sub
      ctx.font = `600 ${twoCol ? 9 : 11}px ${FONT}`
      ctx.fillText(statTier[si][1], sx, cy + (twoCol ? 11 : 13))
    })
  })

  drawFooter()

  function drawFooter() {
    ctx.fillStyle = T.footerBg; ctx.fillRect(0, H - footerH, W, footerH)
    ctx.fillStyle = T.footerText; ctx.font = `700 13px ${FONT}`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('NWBASEBALLSTATS.COM  x  PNWCBR', W / 2, H - footerH / 2)
  }
}

function fmtYr(y) {
  if (!y) return ''
  const m = { 'Fr': 'Fr', 'So': 'So', 'Jr': 'Jr', 'Sr': 'Sr', 'R-Fr': 'r-Fr', 'R-So': 'r-So', 'R-Jr': 'r-Jr', 'R-Sr': 'r-Sr', 'Gr': 'Gr' }
  return m[y] || y
}

const isPitcherPos = (pos) => {
  const u = (pos || '').toUpperCase()
  return u === 'P' || u === 'RHP' || u === 'LHP' || u === 'SP' || u === 'RP' || u.startsWith('RHP/') || u.startsWith('LHP/') || u.startsWith('P/')
}

export default function TransferPortalGraphic() {
  const [board, setBoard] = useState('portal')        // portal | juco
  const [side, setSide] = useState('hitters')          // hitters | pitchers
  const [count, setCount] = useState(10)               // 10 | 20 | 50
  const [position, setPosition] = useState('all')
  const [hideCommitted, setHideCommitted] = useState(false)
  const [rawRows, setRawRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const canvasRef = useRef(null)

  const SEASON = 2026
  const title = board === 'portal' ? 'Transfer Portal Tracker' : 'NWAC JUCO Tracker'
  const subtitle = side === 'hitters' ? 'Top Hitters' : 'Top Pitchers'

  // Fetch the board+side dataset (over-fetch, filter client-side)
  useEffect(() => {
    let alive = true
    setLoading(true); setErr(null)
    const sortBy = SORT_KEY[side]
    const base = board === 'portal' ? '/api/v1/transfer-portal' : '/api/v1/players/juco/uncommitted'
    const params = new URLSearchParams({ season: String(SEASON), sort_by: sortBy, sort_dir: 'desc', limit: '150' })
    if (board === 'juco') params.set('year_in_school', 'So')
    ;(async () => {
      try {
        const r = await fetch(`${base}?${params}`, { headers: await authHeaders(), cache: 'no-store' })
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`)
        const d = await r.json()
        const arr = Array.isArray(d) ? d : (d.players || d.results || [])
        if (alive) { setRawRows(arr); setLoading(false) }
      } catch (e) { if (alive) { setErr(e.message); setLoading(false) } }
    })()
    return () => { alive = false }
  }, [board, side])

  // Derive the filtered/sorted/top-N rows
  const statTier = (side === 'hitters' ? HIT_TIERS : PIT_TIERS)[count]
  const rows = (() => {
    let r = rawRows.slice()
    // side: hitters exclude pitchers, pitchers only
    r = r.filter(p => side === 'pitchers' ? isPitcherPos(p.position) : !isPitcherPos(p.position))
    if (position !== 'all') {
      r = r.filter(p => {
        const u = (p.position || '').toUpperCase()
        if (position === 'IF') return ['1B', '2B', '3B', 'SS', 'IF'].some(x => u === x || u.includes('/' + x))
        if (position === 'OF') return ['OF', 'LF', 'CF', 'RF'].some(x => u === x || u.includes('/' + x))
        return u === position || u.startsWith(position + '/') || u.endsWith('/' + position)
      })
    }
    if (hideCommitted) r = r.filter(p => !p.committed_to)
    const k = SORT_KEY[side]
    r.sort((a, b) => (b[k] ?? -999) - (a[k] ?? -999))
    return r
  })()

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    renderBoard(canvas, { rows, side, count, statTier, title, subtitle })
      .catch(e => console.error('portal graphic render failed:', e))
  }, [rows, side, count, statTier, title, subtitle])

  useEffect(() => { if (!loading) redraw() }, [loading, redraw])

  function download() {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob(blob => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${board}-${side}-top${count}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    }, 'image/png')
  }

  const Btn = ({ on, onClick, children }) => (
    <button onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-sm font-semibold border ${on ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white dark:bg-gray-800 text-gray-600 border-gray-300 dark:border-gray-600 hover:border-emerald-600'}`}>
      {children}
    </button>
  )

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">Portal / JUCO Tracker Graphics</h1>
      <p className="text-sm text-gray-500 mb-4">Green PNWCBR co-branded leaderboard graphics for the Transfer Portal and NWAC JUCO trackers.</p>

      <div className="flex flex-wrap gap-2 mb-3">
        <Btn on={board === 'portal'} onClick={() => setBoard('portal')}>Transfer Portal</Btn>
        <Btn on={board === 'juco'} onClick={() => setBoard('juco')}>JUCO Tracker</Btn>
        <span className="w-px bg-gray-300 mx-1" />
        <Btn on={side === 'hitters'} onClick={() => setSide('hitters')}>Hitters</Btn>
        <Btn on={side === 'pitchers'} onClick={() => setSide('pitchers')}>Pitchers</Btn>
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {[10, 20, 50].map(n => <Btn key={n} on={count === n} onClick={() => setCount(n)}>Top {n}</Btn>)}
        <span className="w-px bg-gray-300 mx-1" />
        <select value={position} onChange={e => setPosition(e.target.value)}
          className="px-2 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 text-sm bg-white dark:bg-gray-800">
          {POSITIONS[side].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300">
          <input type="checkbox" checked={hideCommitted} onChange={e => setHideCommitted(e.target.checked)} />
          Hide committed
        </label>
        <button onClick={download} className="ml-auto px-4 py-1.5 rounded-md bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800">⬇ Download PNG</button>
      </div>

      {err && <div className="mb-3 p-2.5 rounded bg-red-50 text-red-700 text-sm border border-red-200">Failed to load: {err}</div>}
      {loading && <div className="text-gray-500 py-8 text-center text-sm">Loading tracker data…</div>}
      <div className="overflow-x-auto">
        <canvas ref={canvasRef} className="rounded-lg shadow-lg max-w-full" style={{ display: loading ? 'none' : 'block' }} />
      </div>
      <p className="text-xs text-gray-400 mt-2">{rows.length} players match · showing top {Math.min(count, rows.length)}. Fewer stat columns show as the list grows (matches our leaderboard graphics).</p>
    </div>
  )
}
