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

// Render a fixed-size node to a single-page letter PDF (image-based, so it
// matches the PNG exactly). Used by the Custom Player Card builder, whose page
// is already sized to one sheet — avoids the @media print machinery entirely.
export async function saveNodeAsPdf(node, filename = 'card') {
  if (!node) return
  const [{ default: html2canvas }, jspdf] = await Promise.all([
    import('html2canvas'), import('jspdf'),
  ])
  const JsPDF = jspdf.jsPDF || jspdf.default
  const canvas = await html2canvas(node, {
    backgroundColor: '#ffffff', scale: 2, useCORS: true, allowTaint: false, logging: false,
  })
  const img = canvas.toDataURL('image/png')
  const pdf = new JsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' })
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
export async function saveNodesAsPdf(nodes, filename = 'cards', onProgress) {
  const list = (nodes || []).filter(Boolean)
  if (!list.length) return
  const [{ default: html2canvas }, jspdf] = await Promise.all([
    import('html2canvas'), import('jspdf'),
  ])
  const JsPDF = jspdf.jsPDF || jspdf.default
  const pdf = new JsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' })
  const pw = pdf.internal.pageSize.getWidth()
  const ph = pdf.internal.pageSize.getHeight()
  for (let i = 0; i < list.length; i++) {
    const canvas = await html2canvas(list[i], {
      backgroundColor: '#ffffff', scale: 2, useCORS: true, allowTaint: false, logging: false,
    })
    const img = canvas.toDataURL('image/png')
    const ar = canvas.width / canvas.height
    let w = pw, h = pw / ar
    if (h > ph) { h = ph; w = ph * ar }
    if (i > 0) pdf.addPage('letter', 'portrait')
    pdf.addImage(img, 'PNG', (pw - w) / 2, 0, w, h)
    if (onProgress) onProgress(i + 1, list.length)
  }
  pdf.save(`${filename}.pdf`)
}

export async function saveNodeAsImage(node, filename = 'report') {
  if (!node) return
  const { default: html2canvas } = await import('html2canvas')
  const canvas = await html2canvas(node, {
    // White backdrop so dark-mode reports still read on a saved PNG.
    backgroundColor: '#ffffff',
    scale: 2,                 // retina-crisp
    useCORS: true,            // pull in cross-origin logos where allowed
    allowTaint: false,        // a logo that can't load CORS renders blank, never taints
    logging: false,
  })
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
