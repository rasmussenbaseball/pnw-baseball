// Shared report export helpers — save any report as a PDF (via the browser
// print dialog, which handles multi-page layouts cleanly) or as a PNG image
// (via html2canvas, loaded on demand so it never bloats the initial bundle).

export function printReport() {
  window.print()
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
