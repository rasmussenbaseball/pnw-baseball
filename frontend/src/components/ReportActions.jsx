// ReportActions — a "Save PDF / Save image" button pair for any report, with a
// Black & White toggle for coaches on mono printers.
//
// B&W mode adds the `bw-report` class to the captured node for the duration of
// the export/print: global CSS (index.css) then strips all color shading and
// swaps it for typography — bold = good, italic = bad, normal = middle (driven
// by data-tone attributes on shaded cells).

import { useState } from 'react'
import { saveNodeAsImage, saveNodeAsPdf } from '../lib/reportExport'

// pdfFromCanvas: when true, "Save PDF" renders the target node to a single-page
// letter PDF (via html2canvas + jsPDF) instead of the browser print dialog.
// fullBleedPrint: when true (and NOT pdfFromCanvas), "Save PDF" uses the native
// browser print with a full-bleed @page (margin: 0) — used for the Custom Player
// Card, whose node is already sized to exactly one letter page. Native print
// renders the real DOM, so cross-origin headshots, the SVG spray chart, text
// baselines and color shading all come out exactly as shown (html2canvas can't
// do any of those faithfully).
export default function ReportActions({ targetRef, filename = 'report', className = '', pdfFromCanvas = false, fullBleedPrint = false }) {
  const [busy, setBusy] = useState(false)
  const [bw, setBw] = useState(false)

  // Run an html2canvas-based export with the B&W class applied (and removed)
  // around the capture.
  const run = async (fn) => {
    const node = targetRef?.current
    setBusy(true)
    if (bw && node) node.classList.add('bw-report')
    try { await fn(node, bw ? `${filename}_bw` : filename) }
    catch (e) { console.error('export failed', e) }
    finally {
      if (bw && node) node.classList.remove('bw-report')
      setBusy(false)
    }
  }
  const onImage = () => run(saveNodeAsImage)
  const onPdf = () => run(saveNodeAsPdf)

  // Print path: keep the B&W class on through the print dialog, then clean up.
  // For a full-bleed card, inject a margin:0 @page rule (overriding the global
  // 0.4in) so the 816×1056px card maps 1:1 to a letter page.
  const onPrint = () => {
    const node = targetRef?.current
    let styleEl = null
    if (bw && node) node.classList.add('bw-report')
    if (fullBleedPrint) {
      styleEl = document.createElement('style')
      styleEl.setAttribute('media', 'print')
      styleEl.textContent = '@page { size: letter portrait; margin: 0; }'
      document.head.appendChild(styleEl)
    }
    if ((bw && node) || styleEl) {
      const cleanup = () => {
        if (bw && node) node.classList.remove('bw-report')
        if (styleEl) styleEl.remove()
        window.removeEventListener('afterprint', cleanup)
      }
      window.addEventListener('afterprint', cleanup)
    }
    window.print()
  }

  return (
    <div className={`flex items-center gap-2 print:hidden ${className}`}>
      <button
        onClick={pdfFromCanvas ? onPdf : onPrint}
        disabled={busy && pdfFromCanvas}
        className="px-3 py-2 rounded-lg bg-portal-purple text-portal-cream text-sm font-semibold hover:opacity-90 disabled:opacity-50"
      >
        {busy && pdfFromCanvas ? 'Rendering…' : 'Save PDF'}
      </button>
      <button
        onClick={onImage}
        disabled={busy}
        className="px-3 py-2 rounded-lg border border-nw-teal text-nw-teal text-sm font-semibold hover:bg-nw-teal/10 disabled:opacity-50"
      >
        {busy ? 'Rendering…' : 'Save image'}
      </button>
      <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 cursor-pointer select-none" title="Strip color shading for mono printers (bold = good, italic = bad)">
        <input type="checkbox" checked={bw} onChange={e => setBw(e.target.checked)} className="h-3.5 w-3.5 accent-portal-purple" />
        B&amp;W
      </label>
    </div>
  )
}
