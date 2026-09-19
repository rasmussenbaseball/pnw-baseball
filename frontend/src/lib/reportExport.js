// Shared report export helpers — save any report as a PDF (via the browser
// print dialog, which handles multi-page layouts cleanly) or as a PNG image
// (via html2canvas, loaded on demand so it never bloats the initial bundle).

export function printReport() {
  window.print()
}

// Map a 0-100 "good-direction" score (higher = better, 50 = neutral) to a
// tone. Used to tag shaded cells so the black-&-white export can swap color
// shading for typography: bold = good, italic = bad, normal = middle.
export function toneOf(score) {
  if (score == null || Number.isNaN(Number(score))) return null
  const s = Number(score)
  if (s >= 65) return 'good'
  if (s <= 35) return 'bad'
  return 'mid'
}
// Spread onto a shaded element: {...toneAttr(score)} → data-tone="good|bad|mid".
export function toneAttr(score) {
  const t = toneOf(score)
  return t ? { 'data-tone': t } : {}
}

const CAPTURE_OPTS = {
  backgroundColor: '#ffffff', scale: 2, useCORS: true, allowTaint: false, logging: false,
}

// Capture a node to a canvas.
//
// Two engines, chosen by content:
// - Plain report nodes: html2canvas (repaints the DOM itself). Proven on the
//   simple table reports.
// - `[data-scale-content]` nodes (the Custom Player Card): html-to-image,
//   which serializes the DOM into an SVG foreignObject and lets the BROWSER
//   render it. html2canvas 1.4.1 repainted the card's dense 8-9px typography
//   with shifted glyph baselines — shading pills drifted off their numbers,
//   the vs-team slash labels hid under their band, and table rows half-clipped
//   (Nate's Mertlich export, July 2026). Real browser text rendering makes the
//   capture match the screen exactly. Cross-origin images (headshots) must be
//   same-origin for this engine — CardHeader routes them through
//   /api/v1/proxy-image.
async function captureCardCanvas(content, node) {
  const { toCanvas } = await import('html-to-image')
  // The on-screen card is fit-to-page via transform:scale(); capture at
  // NATURAL 1:1 size instead (callers fit the image to the page), so the
  // raster isn't a blurry upscale of a shrunken layout.
  const page = content.closest('.custom-card-page') || node
  const saved = { t: content.style.transform, h: page.style.height, o: page.style.overflow }
  content.style.transform = 'none'
  page.style.height = 'auto'
  page.style.overflow = 'visible'
  try {
    return await toCanvas(content, {
      backgroundColor: '#ffffff',
      pixelRatio: 2,
      width: content.scrollWidth,
      height: content.scrollHeight,
    })
  } finally {
    content.style.transform = saved.t
    page.style.height = saved.h
    page.style.overflow = saved.o
  }
}

async function captureCanvas(html2canvas, node) {
  // Wait for web fonts (Inter) to load — both engines otherwise measure with
  // FALLBACK font metrics, which shifts text and clips lines.
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready } catch { /* older browsers */ }
  }
  const content = node && node.querySelector ? node.querySelector('[data-scale-content]') : null
  if (!content) return html2canvas(node, CAPTURE_OPTS)
  return captureCardCanvas(content, node)
}

// Render a fixed-size node to a single-page letter PDF (image-based, so it
// matches the PNG exactly). Used by the Custom Player Card builder, whose page
// is already sized to one sheet — avoids the @media print machinery entirely.
export async function saveNodeAsPdf(node, filename = 'card', opts = {}) {
  if (!node) return
  const { unit = 'pt', format = 'letter', orientation = 'portrait' } = opts
  const [{ default: html2canvas }, jspdf] = await Promise.all([
    import('html2canvas'), import('jspdf'),
  ])
  const JsPDF = jspdf.jsPDF || jspdf.default
  const canvas = await captureCanvas(html2canvas, node)
  const img = canvas.toDataURL('image/png')
  const pdf = new JsPDF({ unit, format, orientation })
  const pw = pdf.internal.pageSize.getWidth()
  const ph = pdf.internal.pageSize.getHeight()
  const ar = canvas.width / canvas.height
  let w = pw, h = pw / ar
  if (h > ph) { h = ph; w = ph * ar }
  pdf.addImage(img, 'PNG', (pw - w) / 2, 0, w, h)
  pdf.save(`${filename}.pdf`)
}

// Render MANY fixed-size nodes into one multi-page letter PDF — one card per
// page. Used by bulk custom-card generation (each card is already sized to a
// sheet, so we image each and drop it on its own page). onProgress(done,total)
// lets the caller show a "rendering 3/30" status.
export async function saveNodesAsPdf(nodes, filename = 'cards', onProgress, opts = {}) {
  const list = (nodes || []).filter(Boolean)
  if (!list.length) return
  const { unit = 'pt', format = 'letter', orientation = 'portrait' } = opts
  const [{ default: html2canvas }, jspdf] = await Promise.all([
    import('html2canvas'), import('jspdf'),
  ])
  const JsPDF = jspdf.jsPDF || jspdf.default
  const pdf = new JsPDF({ unit, format, orientation })
  const pw = pdf.internal.pageSize.getWidth()
  const ph = pdf.internal.pageSize.getHeight()
  for (let i = 0; i < list.length; i++) {
    const canvas = await captureCanvas(html2canvas, list[i])
    const img = canvas.toDataURL('image/png')
    const ar = canvas.width / canvas.height
    let w = pw, h = pw / ar
    if (h > ph) { h = ph; w = ph * ar }
    if (i > 0) pdf.addPage(format, orientation)
    pdf.addImage(img, 'PNG', (pw - w) / 2, (ph - h) / 2, w, h)
    if (onProgress) onProgress(i + 1, list.length)
  }
  pdf.save(`${filename}.pdf`)
}

// Render report nodes of ANY height into a multi-page letter PDF at a fixed,
// readable scale (the single-page helpers above shrink a tall node to fit,
// which turns a long report into an unreadable strip). Each node starts on a
// fresh page and is cut BETWEEN its `[data-report-block]` children, so a
// table or chart never splits across a page unless it is taller than a page
// on its own. Used by the TrackMan Custom Reporting builder.
export async function saveNodesAsPagedPdf(nodes, filename = 'report', onProgress, opts = {}) {
  const list = (nodes || []).filter(Boolean)
  if (!list.length) return
  const { unit = 'pt', format = 'letter', orientation = 'portrait', margin = 26 } = opts
  const [{ default: html2canvas }, jspdf] = await Promise.all([
    import('html2canvas'), import('jspdf'),
  ])
  const JsPDF = jspdf.jsPDF || jspdf.default
  const pdf = new JsPDF({ unit, format, orientation })
  const pw = pdf.internal.pageSize.getWidth()
  const ph = pdf.internal.pageSize.getHeight()
  const cw = pw - 2 * margin, chPt = ph - 2 * margin
  let first = true
  for (let i = 0; i < list.length; i++) {
    const node = list[i]
    const rect = node.getBoundingClientRect()
    const blocks = [...node.querySelectorAll('[data-report-block]')].map(b => {
      const r = b.getBoundingClientRect()
      return [r.top - rect.top, r.bottom - rect.top]
    })
    const canvas = await captureCanvas(html2canvas, node)
    const k = canvas.width / (rect.width || 1)          // css px -> canvas px
    const pageH = canvas.width * (chPt / cw)            // canvas px per page
    const cuts = []
    let start = 0
    for (const [top, bottom] of blocks) {
      const t = Math.max(0, top * k - 6 * k), b = bottom * k
      if (b - start > pageH && t > start) { cuts.push([start, t]); start = t }
      while (b - start > pageH) { cuts.push([start, start + pageH]); start += pageH }
    }
    if (canvas.height - start > 2) cuts.push([start, canvas.height])
    for (const [y0, y1] of cuts) {
      const h = Math.min(Math.round(y1 - y0), Math.round(pageH))
      if (h <= 0) continue
      const slice = document.createElement('canvas')
      slice.width = canvas.width
      slice.height = h
      const ctx = slice.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, slice.width, slice.height)
      ctx.drawImage(canvas, 0, Math.round(y0), canvas.width, h, 0, 0, canvas.width, h)
      if (!first) pdf.addPage(format, orientation)
      first = false
      pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, cw, h * (cw / canvas.width))
    }
    if (onProgress) onProgress(i + 1, list.length)
  }
  pdf.save(`${filename}.pdf`)
}

export async function saveNodeAsImage(node, filename = 'report') {
  if (!node) return
  const { default: html2canvas } = await import('html2canvas')
  const canvas = await captureCanvas(html2canvas, node)
  await new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) return resolve()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${filename}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      resolve()
    }, 'image/png')
  })
}


// ── CSV export ───────────────────────────────────────────────────
export function downloadCsvText(text, filename = 'data') {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${filename}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

// Serialize every <table> inside a node into one CSV. Multi-table views get
// a section label per table, taken from the first text line of the table's
// card (a board title, or a player's name on session sheets).
export function saveNodeAsCsv(node, filename = 'data') {
  if (!node) return
  const tables = [...node.querySelectorAll('table')]
  if (!tables.length) return
  const esc = (v) => {
    const t = String(v ?? '').replace(/\s+/g, ' ').trim()
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
  }
  const lines = []
  tables.forEach((tbl, i) => {
    if (tables.length > 1) {
      const card = tbl.closest('.rounded-xl')
      const label = card ? (card.innerText || '').split('\n').map(l => l.trim()).filter(Boolean)[0] : ''
      lines.push(esc(label || `Table ${i + 1}`))
    }
    tbl.querySelectorAll('tr').forEach(tr => {
      const cells = [...tr.querySelectorAll('th,td')].map(c => esc(c.innerText))
      if (cells.some(c => c !== '')) lines.push(cells.join(','))
    })
    lines.push('')
  })
  downloadCsvText(lines.join('\n'), filename)
}
