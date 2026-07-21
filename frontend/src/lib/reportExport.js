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
