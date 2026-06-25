// rapsodoReport.js — build a downloadable one-sheet report (PDF + PNG) of a
// pitcher's Rapsodo data. Framework-free: every panel is composed into ONE
// self-contained, light-theme SVG (no external CSS/fonts), so it rasterizes
// deterministically via <Image> -> <canvas> regardless of the app's theme.
//
// The sheet mirrors the Rapsodo Lab DATA tab (no coaching points): arsenal
// table, movement profile, plate-location (all + per pitch type), arm slot &
// release, and the per-session development trend. Page is US-Letter portrait so
// it fills a PDF page edge-to-edge and exports as a standard portrait image.

export const REPORT_W = 1700
export const REPORT_H = 2200            // 1700/2200 = 8.5/11 (Letter portrait)

const PITCH_COLORS = {
  fastball: '#ef4444', sinker: '#f59e0b', cutter: '#8b5cf6', slider: '#3b82f6',
  sweeper: '#14b8a6', curveball: '#22c55e', changeup: '#ec4899', splitter: '#0891b2',
  unclassified: '#9ca3af',
}
const colorFor = (p) => PITCH_COLORS[p] || '#9ca3af'
const ACCENT = '#7c3aed', INK = '#111827', SUB = '#6b7280', FAINT = '#9ca3af'
const LINE = '#e5e7eb', GRID = '#f1f1f4', GOOD = '#16a34a'

const fmt = (v, d = 1) => (v === null || v === undefined ? '–' : Number(v).toFixed(d))
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const handLabel = (h) => ({ R: 'RHP', L: 'LHP' }[h] || '—')
const angleBand = (a) => { if (a == null) return null; const c = Math.round(a / 5) * 5; return { lo: c - 5, hi: c + 5, label: `${c - 5}–${c + 5}°` } }

// ── small SVG text helper ───────────────────────────────────────────────────
function txt(x, y, s, { size = 24, fill = INK, weight = 400, anchor = 'start', upper = false, ls = 0 } = {}) {
  const style = `font-size:${size}px;font-weight:${weight};${upper ? 'text-transform:uppercase;' : ''}${ls ? `letter-spacing:${ls}px;` : ''}`
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${fill}" style="${style}">${esc(s)}</text>`
}
function sectionTitle(x, y, label) {
  return txt(x, y, label, { size: 22, fill: SUB, weight: 700, upper: true, ls: 1.2 })
}

// ── header ──────────────────────────────────────────────────────────────────
function headerPanel(profile, scopeLabel, generatedOn, x0, y0, W) {
  const p = profile.player
  const chips = []
  let cx = x0
  const nameY = y0 + 40
  let s = txt(x0, nameY, p.player_name, { size: 46, fill: INK, weight: 800 })
  // measure-ish: place chips after the name using a rough char width
  cx = x0 + (p.player_name || '').length * 26 + 26
  const chip = (label, fg, bg) => {
    const w = label.length * 12 + 30
    const g = `<g transform="translate(${cx},${y0 + 14})"><rect rx="16" width="${w}" height="34" fill="${bg}"/>` +
      txt(cx + 0, 0, '', {}) + `</g>` // placeholder; build properly below
    return { w }
  }
  // chips (handedness, lean) — build inline
  let chipsSvg = ''
  let chx = cx
  const addChip = (label, fg, bg) => {
    const w = String(label).length * 12 + 30
    chipsSvg += `<g transform="translate(${chx},${y0 + 10})"><rect rx="17" width="${w}" height="34" fill="${bg}"/>` +
      txt(w / 2, 24, label, { size: 18, fill: fg, weight: 700, anchor: 'middle' }) + `</g>`
    chx += w + 12
  }
  addChip(handLabel(p.handedness), ACCENT, '#ede9fe')
  if (profile.hand_profile?.lean) addChip(profile.hand_profile.lean, '#374151', '#f3f4f6')
  if (p.mode === 'pnw' && p.players_id && p.linked_player_name) addChip(p.linked_player_name, '#374151', '#f3f4f6')

  // scope + meta line
  const nSess = profile.n_sessions
  const nPitch = (profile.plot || []).filter((q) => !q.excluded).length
  const dates = (profile.sessions || []).map((q) => q.session_date).filter(Boolean)
  const range = dates.length ? (dates.length === 1 ? dates[0] : `${dates[dates.length - 1]} – ${dates[0]}`) : 'undated'
  const meta = `${scopeLabel}  ·  ${range}  ·  ${nPitch} reliable pitches`
  const metaSvg = txt(x0, y0 + 78, meta, { size: 22, fill: SUB, weight: 500 })

  // branding (right)
  const brand = txt(x0 + W, y0 + 24, 'NWBB STATS · RAPSODO LAB', { size: 18, fill: ACCENT, weight: 800, anchor: 'end', ls: 1 })
  const gen = generatedOn ? txt(x0 + W, y0 + 50, `generated ${generatedOn}`, { size: 16, fill: FAINT, anchor: 'end' }) : ''

  const rule = `<line x1="${x0}" y1="${y0 + 100}" x2="${x0 + W}" y2="${y0 + 100}" stroke="${LINE}" stroke-width="2"/>`
  return { svg: s + chipsSvg + metaSvg + brand + gen + rule, h: 112 }
}

// ── arsenal table ───────────────────────────────────────────────────────────
function arsenalPanel(arsenal, x0, y0, W) {
  const cols = [
    ['Pitch', 'pitch', 'l', 230], ['#', 'count', 'r', 80], ['Velo', 'velo', 'r', 104],
    ['Max', 'velo_max', 'r', 104], ['Spin', 'total_spin', 'r', 132], ['Eff', 'spin_eff', 'r', 88],
    ['IVB', 'ivb', 'r', 100], ['HB', 'arm_hb', 'r', 100], ['VAA', 'vaa', 'r', 110],
    ['Tilt', 'tilt', 'l', 116], ['Zone', 'zone_pct', 'r', 104], ['Loc+', 'loc_plus', 'r', 110],
    ['Stuff', 'stuff', 'r', 110],
  ]
  const totalW = cols.reduce((s, c) => s + c[3], 0)
  const scale = W / totalW
  const xs = []; let acc = x0
  for (const c of cols) { xs.push(acc); acc += c[3] * scale }
  const title = sectionTitle(x0, y0, 'Arsenal')
  let y = y0 + 18
  const hH = 48, rH = 52
  // header band
  let svg = `<rect x="${x0}" y="${y}" width="${W}" height="${hH}" rx="10" fill="#f8f7fb"/>`
  cols.forEach((c, i) => {
    const cw = c[3] * scale
    const tx = c[2] === 'r' ? xs[i] + cw - 14 : xs[i] + 14
    svg += txt(tx, y + 32, c[0], { size: 20, fill: SUB, weight: 700, anchor: c[2] === 'r' ? 'end' : 'start' })
  })
  y += hH
  const cell = (a, key) => {
    if (key === 'count') return String(a.count)
    if (key === 'velo' || key === 'velo_max' || key === 'ivb' || key === 'arm_hb') return fmt(a[key])
    if (key === 'spin_eff') return fmt(a.spin_eff, 0)
    if (key === 'total_spin') return a.total_spin == null ? '–' : String(Math.round(a.total_spin))
    if (key === 'vaa') return a.vaa == null ? '–' : `${fmt(a.vaa)}°`
    if (key === 'tilt') return a.tilt || '–'
    if (key === 'zone_pct') return a.zone_pct == null ? '–' : `${a.zone_pct}%`
    if (key === 'loc_plus') return a.loc_plus ?? '–'
    if (key === 'stuff') return a.stuff ?? '–'
    return ''
  }
  arsenal.forEach((a, ri) => {
    if (ri % 2 === 1) svg += `<rect x="${x0}" y="${y}" width="${W}" height="${rH}" fill="#fafafa"/>`
    const baseY = y + 34
    cols.forEach((c, i) => {
      const cw = c[3] * scale
      if (c[1] === 'pitch') {
        svg += `<circle cx="${xs[i] + 22}" cy="${baseY - 7}" r="9" fill="${colorFor(a.pitch)}"/>`
        svg += txt(xs[i] + 40, baseY, a.pitch, { size: 23, fill: INK, weight: 600 })
        return
      }
      const v = cell(a, c[1])
      let fill = SUB, weight = 400
      if (c[1] === 'stuff' && a.stuff != null) { fill = a.stuff >= 100 ? GOOD : SUB; weight = 700 }
      if (c[1] === 'loc_plus' && a.loc_plus != null) { fill = a.loc_plus >= 100 ? GOOD : SUB; weight = 700 }
      const tx = c[2] === 'r' ? xs[i] + cw - 14 : xs[i] + 14
      svg += txt(tx, baseY, v, { size: 23, fill, weight, anchor: c[2] === 'r' ? 'end' : 'start' })
    })
    y += rH
  })
  svg += `<rect x="${x0}" y="${y0 + 18}" width="${W}" height="${hH + arsenal.length * rH}" rx="10" fill="none" stroke="${LINE}" stroke-width="2"/>`
  y += 8
  svg += txt(x0, y + 22, 'Stuff: 100 = WCL TrackMan-model average for that pitch type (not comparable across types; ignores command).   Loc+: 100 = average command (bullpen, no hitter/count).', { size: 16, fill: FAINT })
  return { svg: title + svg, h: (y + 30) - y0 }
}

// ── movement profile ────────────────────────────────────────────────────────
function movementPanel(profile, x0, y0, box) {
  const PAD = 42, DOM = 26
  const sx = (v) => PAD + ((v + DOM) / (2 * DOM)) * (box - 2 * PAD)
  const sy = (v) => PAD + ((DOM - v) / (2 * DOM)) * (box - 2 * PAD)
  const hand = profile.player.handedness
  const hbSign = hand === 'L' ? -1 : 1
  const dx = (h) => sx(h * hbSign)
  const ticks = [-20, -10, 0, 10, 20]
  let g = `<g transform="translate(${x0},${y0})">`
  g += `<rect width="${box}" height="${box}" rx="12" fill="#ffffff" stroke="${LINE}" stroke-width="2"/>`
  ticks.forEach((t) => {
    g += `<line x1="${sx(t)}" y1="${PAD}" x2="${sx(t)}" y2="${box - PAD}" stroke="${GRID}" stroke-width="1.5"/>`
    g += `<line x1="${PAD}" y1="${sy(t)}" x2="${box - PAD}" y2="${sy(t)}" stroke="${GRID}" stroke-width="1.5"/>`
  })
  g += `<line x1="${sx(0)}" y1="${PAD}" x2="${sx(0)}" y2="${box - PAD}" stroke="#d1d5db" stroke-width="2"/>`
  g += `<line x1="${PAD}" y1="${sy(0)}" x2="${box - PAD}" y2="${sy(0)}" stroke="#d1d5db" stroke-width="2"/>`
  ticks.filter((t) => t !== 0).forEach((t) => {
    g += txt(sx(t), sy(0) + 22, String(t), { size: 16, fill: FAINT, anchor: 'middle' })
    g += txt(sx(0) - 8, sy(t) + 6, String(t), { size: 16, fill: FAINT, anchor: 'end' })
  })
  // arm axis
  const arm = profile.arm
  if (arm?.arm_angle != null) {
    const th = (arm.arm_angle * Math.PI) / 180
    const ax = hbSign * DOM * Math.cos(th), ay = DOM * Math.sin(th)
    g += `<line x1="${sx(-ax)}" y1="${sy(-ay)}" x2="${sx(ax)}" y2="${sy(ay)}" stroke="#9ca3af" stroke-width="2" stroke-dasharray="7 5" opacity="0.7"/>`
    g += txt(box / 2, box - 14, `arm slot ${angleBand(arm.arm_angle).label}`, { size: 17, fill: SUB, weight: 600, anchor: 'middle' })
  }
  // blobs
  const groups = {}
  for (const q of profile.plot || []) {
    if (q.quality === 'ok' && q.pitch && q.pitch !== 'unclassified' && q.arm_hb != null && q.ivb != null) (groups[q.pitch] ||= []).push(q)
  }
  Object.entries(groups).filter(([, ps]) => ps.length >= 2).forEach(([pitch, ps]) => {
    const cxx = ps.reduce((s, q) => s + dx(q.arm_hb), 0) / ps.length
    const cyy = ps.reduce((s, q) => s + sy(q.ivb), 0) / ps.length
    const rms = Math.sqrt(ps.reduce((s, q) => s + (dx(q.arm_hb) - cxx) ** 2 + (sy(q.ivb) - cyy) ** 2, 0) / ps.length)
    const r = Math.max(24, Math.min(118, rms * 1.5))
    g += `<circle cx="${cxx.toFixed(1)}" cy="${cyy.toFixed(1)}" r="${r.toFixed(1)}" fill="${colorFor(pitch)}" fill-opacity="0.10" stroke="${colorFor(pitch)}" stroke-opacity="0.35" stroke-width="1.5"/>`
  })
  for (const q of profile.plot || []) {
    if (q.arm_hb == null || q.ivb == null) continue
    const ok = q.quality === 'ok' && !q.excluded
    g += `<circle cx="${dx(q.arm_hb).toFixed(1)}" cy="${sy(q.ivb).toFixed(1)}" r="${ok ? 5 : 4}" fill="${ok ? colorFor(q.pitch) : 'none'}" fill-opacity="0.55" stroke="${q.excluded ? '#9ca3af' : colorFor(q.pitch)}" stroke-width="${q.manual && !q.excluded ? 3 : 1.5}" ${q.excluded ? 'stroke-dasharray="3 3" opacity="0.5"' : ''}/>`
  }
  g += txt(hbSign === 1 ? box - PAD : PAD, sy(0) - 8, hbSign === 1 ? 'arm side →' : '← arm side', { size: 16, fill: FAINT, anchor: hbSign === 1 ? 'end' : 'start' })
  g += txt(sx(0) + 6, PAD + 14, 'ride ↑', { size: 16, fill: FAINT })
  g += `</g>`
  return g
}

// ── plate location: all pitches (catcher's view) ────────────────────────────
function strikeZonePanel(locations, x0, y0, W, H) {
  const PAD = 30
  const XMIN = -18, XMAX = 18, YMIN = 8, YMAX = 52
  const sx = (v) => PAD + ((v - XMIN) / (XMAX - XMIN)) * (W - 2 * PAD)
  const sy = (v) => PAD + ((YMAX - v) / (YMAX - YMIN)) * (H - 2 * PAD)
  const clamp = (px, lo, hi) => Math.max(lo, Math.min(hi, px))
  const zx = sx(-8.5), zw = sx(8.5) - sx(-8.5), zy = sy(42), zh = sy(18) - sy(42)
  let g = `<g transform="translate(${x0},${y0})">`
  g += `<rect width="${W}" height="${H}" rx="12" fill="#ffffff" stroke="${LINE}" stroke-width="2"/>`
  g += `<rect x="${zx}" y="${zy}" width="${zw}" height="${zh}" fill="none" stroke="#9ca3af" stroke-width="2"/>`
  for (let i = 1; i < 3; i++) {
    g += `<line x1="${zx + (i * zw) / 3}" y1="${zy}" x2="${zx + (i * zw) / 3}" y2="${zy + zh}" stroke="${LINE}" stroke-width="1.5"/>`
    g += `<line x1="${zx}" y1="${zy + (i * zh) / 3}" x2="${zx + zw}" y2="${zy + (i * zh) / 3}" stroke="${LINE}" stroke-width="1.5"/>`
  }
  for (const p of locations || []) {
    if (p.sz_side == null || p.sz_height == null) continue
    g += `<circle cx="${clamp(sx(p.sz_side), 5, W - 5).toFixed(1)}" cy="${clamp(sy(p.sz_height), 5, H - 5).toFixed(1)}" r="6" fill="${colorFor(p.pitch)}" fill-opacity="${p.is_strike === 'Y' ? 0.85 : 0.4}" stroke="${colorFor(p.pitch)}" stroke-width="1.2"/>`
  }
  g += `</g>`
  return g
}

// ── per-pitch-type location heatmaps (contour bands + dots) ─────────────────
function heatmapCell(pitch, pts, x0, y0, W, H) {
  const PAD = 9
  const XMIN = -18, XMAX = 18, YMIN = 8, YMAX = 52
  const sx = (v) => PAD + ((v - XMIN) / (XMAX - XMIN)) * (W - 2 * PAD)
  const sy = (v) => PAD + ((YMAX - v) / (YMAX - YMIN)) * (H - 2 * PAD)
  const clamp = (px, lo, hi) => Math.max(lo, Math.min(hi, px))
  const NX = 24, NY = 30, bw = 3.2
  const cw = (W - 2 * PAD) / NX, ch = (H - 2 * PAD) / NY
  let max = 0; const cells = []
  for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
    const cx = XMIN + ((i + 0.5) / NX) * (XMAX - XMIN), cy = YMIN + ((j + 0.5) / NY) * (YMAX - YMIN)
    let d = 0
    for (const p of pts) { const ax = p.sz_side - cx, ay = p.sz_height - cy; d += Math.exp(-(ax * ax + ay * ay) / (2 * bw * bw)) }
    cells.push([i, j, d]); if (d > max) max = d
  }
  const band = (r) => (r >= 0.82 ? 1 : r >= 0.62 ? 0.74 : r >= 0.42 ? 0.5 : r >= 0.24 ? 0.3 : r >= 0.1 ? 0.15 : 0)
  const col = colorFor(pitch)
  let g = `<g transform="translate(${x0},${y0})">`
  g += `<rect width="${W}" height="${H}" rx="10" fill="#ffffff" stroke="${LINE}" stroke-width="2"/>`
  for (const [i, j, d] of cells) {
    const o = max > 0 ? band(d / max) : 0
    if (o === 0) continue
    g += `<rect x="${(PAD + i * cw).toFixed(2)}" y="${(PAD + (NY - 1 - j) * ch).toFixed(2)}" width="${(cw + 0.6).toFixed(2)}" height="${(ch + 0.6).toFixed(2)}" fill="${col}" fill-opacity="${o}"/>`
  }
  const zx = sx(-8.5), zw = sx(8.5) - sx(-8.5), zy = sy(42), zh = sy(18) - sy(42)
  g += `<rect x="${zx.toFixed(1)}" y="${zy.toFixed(1)}" width="${zw.toFixed(1)}" height="${zh.toFixed(1)}" fill="none" stroke="#6b7280" stroke-width="1.6"/>`
  for (const p of pts) g += `<circle cx="${clamp(sx(p.sz_side), 3, W - 3).toFixed(1)}" cy="${clamp(sy(p.sz_height), 3, H - 3).toFixed(1)}" r="2.4" fill="#fff" fill-opacity="0.95" stroke="${col}" stroke-width="1"/>`
  g += txt(W / 2, H + 26, `${pitch} (${pts.length})`, { size: 18, fill: col, weight: 700, anchor: 'middle' })
  g += `</g>`
  return g
}

function heatmapRow(locations, x0, y0, W) {
  const groups = {}
  for (const l of locations || []) if (l.sz_side != null && l.sz_height != null && l.pitch) (groups[l.pitch] ||= []).push(l)
  const types = Object.entries(groups).filter(([, ls]) => ls.length >= 4).sort((a, b) => b[1].length - a[1].length).slice(0, 5)
  if (!types.length) return { svg: '', h: 0 }
  const HMH = 300, gap = 28
  const n = types.length
  const HMW = Math.min(290, (W - (n - 1) * gap) / n)
  const used = n * HMW + (n - 1) * gap
  const startX = x0 + (W - used) / 2
  let svg = sectionTitle(x0, y0, 'Plate location by pitch type')
  types.forEach(([pitch, ls], i) => { svg += heatmapCell(pitch, ls, startX + i * (HMW + gap), y0 + 18, HMW, HMH) })
  return { svg, h: 18 + HMH + 36 }
}

// ── arm slot figure ─────────────────────────────────────────────────────────
function armFigure(arm, hand, x0, y0, scale) {
  if (arm?.arm_angle == null) return ''
  const band = angleBand(arm.arm_angle)
  const armDir = hand === 'L' ? 1 : -1
  const CX = 90, shY = 100, shX = CX + armDir * 12, L = 60
  const at = (deg) => { const a = (deg * Math.PI) / 180; return [shX + armDir * L * Math.cos(a), shY - L * Math.sin(a)] }
  const [hx, hy] = at(arm.arm_angle), [lx, ly] = at(band.lo), [ux, uy] = at(band.hi)
  const G = '#d1d5db'
  let g = `<g transform="translate(${x0},${y0}) scale(${scale})">`
  g += `<rect x="0" y="0" width="180" height="212" rx="10" fill="#ffffff" stroke="${LINE}" stroke-width="${2 / scale}"/>`
  g += `<line x1="18" y1="197" x2="162" y2="197" stroke="${G}" stroke-width="2"/>`
  g += `<path d="M82 150 L74 196 M98 150 L106 196" stroke="${G}" stroke-width="9" stroke-linecap="round" fill="none"/>`
  g += `<path d="M76 98 Q90 90 104 98 L100 150 Q90 157 80 150 Z" fill="${G}"/>`
  g += `<circle cx="${CX}" cy="76" r="13" fill="${G}"/>`
  g += `<path d="M${CX - armDir * 12} 102 q ${-armDir * 13} 17 ${-armDir * 5} 35" stroke="${G}" stroke-width="8" stroke-linecap="round" fill="none"/>`
  g += `<path d="M${shX} ${shY} L${lx.toFixed(1)} ${ly.toFixed(1)} A${L} ${L} 0 0 ${armDir === 1 ? 1 : 0} ${ux.toFixed(1)} ${uy.toFixed(1)} Z" fill="${ACCENT}" fill-opacity="0.15"/>`
  g += `<line x1="${shX}" y1="${shY}" x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}" stroke="${ACCENT}" stroke-width="9" stroke-linecap="round"/>`
  g += `<circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="6" fill="#fff" stroke="${ACCENT}" stroke-width="2"/>`
  g += `<text x="${armDir === -1 ? 170 : 10}" y="28" text-anchor="${armDir === -1 ? 'end' : 'start'}" fill="${INK}" style="font-size:13px;font-weight:700">≈${band.label}</text>`
  g += `</g>`
  return g
}

function releasePanel(points, x0, y0, S) {
  const PAD = 26
  const XMIN = -3.5, XMAX = 3.5, YMIN = 3, YMAX = 7
  const sx = (v) => PAD + ((v - XMIN) / (XMAX - XMIN)) * (S - 2 * PAD)
  const sy = (v) => PAD + ((YMAX - v) / (YMAX - YMIN)) * (S - 2 * PAD)
  let g = `<g transform="translate(${x0},${y0})">`
  g += `<rect width="${S}" height="${S}" rx="10" fill="#ffffff" stroke="${LINE}" stroke-width="2"/>`
  g += `<line x1="${sx(0)}" y1="${PAD}" x2="${sx(0)}" y2="${S - PAD}" stroke="${GRID}" stroke-width="1.5"/>`
  for (const p of points || []) {
    if (p.rel_side == null || p.rel_height == null) continue
    g += `<circle cx="${sx(p.rel_side).toFixed(1)}" cy="${sy(p.rel_height).toFixed(1)}" r="4.5" fill="${colorFor(p.pitch)}" fill-opacity="0.7" stroke="${colorFor(p.pitch)}" stroke-width="1"/>`
  }
  g += txt(S - 8, S - 8, 'side (ft)', { size: 14, fill: FAINT, anchor: 'end' })
  g += txt(8, 18, 'height (ft)', { size: 14, fill: FAINT })
  g += `</g>`
  return g
}

// horizontal strip of release/arm metrics (one row, fills the page width)
function armMetricStrip(arm, x0, y0, W) {
  if (!arm) return { svg: '', h: 0 }
  const spread = Math.max(arm.rel_height_sd || 0, arm.rel_side_sd || 0) * 12
  const tiles = [
    ['Arm angle', arm.arm_angle != null ? angleBand(arm.arm_angle).label : '–'],
    ['Slot', arm.slot || '–'],
    ['Avg VAA', arm.vaa != null ? `${fmt(arm.vaa, 1)}°` : '–'],
    ['Rel height', arm.rel_height != null ? `${fmt(arm.rel_height, 2)} ft` : '–'],
    ['Rel side', arm.rel_side != null ? `${fmt(arm.rel_side, 2)} ft` : '–'],
    ['Extension', arm.extension != null ? `${fmt(arm.extension, 2)} ft` : '–'],
    ['Consistency', `${arm.consistency} ±${fmt(spread, 1)}in`],
    ['Pitches', String(arm.n ?? '–')],
  ]
  const gap = 16, n = tiles.length, th = 92
  const tw = (W - (n - 1) * gap) / n
  let svg = sectionTitle(x0, y0, 'Release & arm slot')
  const ty = y0 + 18
  tiles.forEach((t, i) => {
    const x = x0 + i * (tw + gap)
    svg += `<rect x="${x}" y="${ty}" width="${tw}" height="${th}" rx="10" fill="#f8f7fb"/>`
    svg += txt(x + 16, ty + 32, t[0], { size: 16, fill: SUB })
    svg += txt(x + 16, ty + 66, t[1], { size: 24, fill: INK, weight: 700 })
  })
  return { svg, h: 18 + th }
}

// ── development trend mini-charts ───────────────────────────────────────────
function miniTrend(title, unit, pts, color, x0, y0, W, H, decimals = 1) {
  const PAD = 26
  const vals = pts.map((p) => p.value).filter((v) => v != null)
  let g = `<g transform="translate(${x0},${y0})">`
  g += `<rect width="${W}" height="${H}" rx="9" fill="#ffffff" stroke="${LINE}" stroke-width="2"/>`
  g += txt(14, 24, title, { size: 16, fill: SUB, weight: 600 })
  if (!vals.length) { g += txt(W / 2, H / 2 + 6, 'no data', { size: 16, fill: FAINT, anchor: 'middle' }) + '</g>'; return g + '</g>' }
  const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1
  const n = pts.length
  const sx = (i) => (n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - 2 * PAD))
  const sy = (v) => (H - PAD) - ((v - min) / span) * (H - 2 * PAD - 16)
  const coords = pts.map((p, i) => (p.value == null ? null : [sx(i), sy(p.value)])).filter(Boolean)
  if (coords.length > 1) g += `<path d="${coords.map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2.5"/>`
  coords.forEach((c) => { g += `<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="4" fill="${color}"/>` })
  const latest = vals[vals.length - 1], delta = vals.length > 1 ? latest - vals[0] : null
  g += txt(W - 12, 24, `${latest.toFixed(decimals)}${unit ? ' ' + unit : ''}`, { size: 17, fill: INK, weight: 700, anchor: 'end' })
  if (delta != null) g += txt(W - 12, H - 12, `${delta > 0 ? '+' : ''}${delta.toFixed(decimals)}`, { size: 15, fill: delta > 0 ? GOOD : delta < 0 ? '#dc2626' : FAINT, anchor: 'end' })
  g += `</g>`
  return g
}

function trendRow(trend, x0, y0, W) {
  if (!trend?.length) return { svg: '', h: 0 }
  const specs = [
    ['FB velocity', 'mph', 'fb_velo', '#ef4444', 1],
    ['FB IVB', 'in', 'fb_ivb', '#3b82f6', 1],
    ['FB spin', 'rpm', 'fb_spin', '#8b5cf6', 0],
    ['Release consistency', 'in', 'rel_consistency_in', '#14b8a6', 1],
  ]
  const gap = 24, n = specs.length
  const cw = (W - (n - 1) * gap) / n, ch = 190
  let svg = sectionTitle(x0, y0, `Development trend · ${trend.length} session${trend.length === 1 ? '' : 's'}`)
  specs.forEach((s, i) => {
    const pts = trend.map((t) => ({ value: t[s[2]] }))
    svg += miniTrend(s[0], s[1], pts, s[3], x0 + i * (cw + gap), y0 + 18, cw, ch, s[4])
  })
  return { svg, h: 18 + ch }
}

// ── master compose ──────────────────────────────────────────────────────────
export function buildReportSVG(profile, opts = {}) {
  const { scopeLabel = 'All sessions (combined)', generatedOn = '' } = opts
  const W = REPORT_W, H = REPORT_H, M = 60, CW = W - 2 * M
  let y = 52, parts = []
  const head = headerPanel(profile, scopeLabel, generatedOn, M, y, CW); parts.push(head.svg); y += head.h + 26
  const ars = arsenalPanel(profile.arsenal || [], M, y, CW); parts.push(ars.svg); y += ars.h + 32

  // Row: 3 equal-height columns — movement | plate location (all) | arm figure + release
  parts.push(sectionTitle(M, y, 'Movement, location & release')); y += 18
  const rowTop = y, box = 640, hand = profile.player.handedness
  parts.push(movementPanel(profile, M, rowTop, box))
  parts.push(txt(M + 4, rowTop + box + 24, 'Horizontal break vs induced vertical break (pitcher’s view). Diagonal = arm-slot axis.', { size: 16, fill: FAINT }))
  const c2x = M + box + 40, c2w = 470
  parts.push(strikeZonePanel(profile.locations, c2x, rowTop, c2w, box))
  parts.push(txt(c2x + 4, rowTop + box + 24, 'All pitches (catcher’s view) · box = strike zone.', { size: 16, fill: FAINT }))
  const c3x = c2x + c2w + 40, c3w = W - M - c3x
  if (profile.arm?.arm_angle != null) {
    const figScale = Math.min(c3w / 180, (box * 0.52) / 212)
    parts.push(armFigure(profile.arm, hand, c3x + (c3w - 180 * figScale) / 2, rowTop, figScale))
    const figH = 212 * figScale
    const relS = Math.min(c3w, box - figH - 20)
    parts.push(releasePanel(profile.arm?.points, c3x + (c3w - relS) / 2, rowTop + figH + 20, relS))
    parts.push(txt(c3x + 4, rowTop + box + 24, 'Release point per pitch.', { size: 16, fill: FAINT }))
  }
  y = rowTop + box + 50

  // Row: release/arm-slot metric strip (full width)
  const strip = armMetricStrip(profile.arm, M, y, CW); if (strip.svg) { parts.push(strip.svg); y += strip.h + 32 }

  // Row: per-pitch-type location heatmaps
  const hm = heatmapRow(profile.locations, M, y, CW); if (hm.svg) { parts.push(hm.svg); y += hm.h + 32 }

  // Row: development trends
  const tr = trendRow(profile.trend, M, y, CW); if (tr.svg) { parts.push(tr.svg); y += tr.h }

  // Footer disclaimer (mirrors the data page; no coaching)
  const footY = H - 46
  parts.push(`<line x1="${M}" y1="${footY - 22}" x2="${W - M}" y2="${footY - 22}" stroke="${LINE}" stroke-width="2"/>`)
  parts.push(txt(M, footY, 'Pitch labels are inferred from velocity, movement, spin efficiency and gyro (v1), so atypical pitches can be mislabeled. Low-confidence, warmup', { size: 15, fill: FAINT }))
  parts.push(txt(M, footY + 22, 'and failed reads are excluded from the averages. Rapsodo infers movement from spin, so it can under-read seam-shifted-wake pitches (e.g. heavy sinkers).', { size: 15, fill: FAINT }))

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Arial, Helvetica, sans-serif"><rect width="${W}" height="${H}" fill="#ffffff"/>${parts.join('')}</svg>`
}

// ── rasterize + download ────────────────────────────────────────────────────
export function svgToPngBlob(svg, scale = 2) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = REPORT_W * scale; canvas.height = REPORT_H * scale
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
    }
    img.onerror = () => reject(new Error('SVG render failed'))
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  })
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const slug = (s) => String(s || 'pitcher').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')

export async function downloadReportPNG(profile, opts = {}) {
  const svg = buildReportSVG(profile, opts)
  const blob = await svgToPngBlob(svg, 2)
  triggerDownload(blob, `${slug(profile.player.player_name)}_rapsodo_${slug(opts.scopeShort || 'report')}.png`)
}

export async function downloadReportPDF(profile, opts = {}) {
  const svg = buildReportSVG(profile, opts)
  const blob = await svgToPngBlob(svg, 2)
  const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob) })
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' })
  pdf.addImage(dataUrl, 'PNG', 0, 0, 612, 792)
  pdf.save(`${slug(profile.player.player_name)}_rapsodo_${slug(opts.scopeShort || 'report')}.pdf`)
}
