// ReportActions — a small "Save PDF / Save image" button pair for any report.
// Pass a ref to the element that should be captured as an image (PDF uses the
// browser print dialog, so it prints the whole page's print layout).

import { useState } from 'react'
import { saveNodeAsImage, saveNodeAsPdf } from '../lib/reportExport'

// pdfFromCanvas: when true, "Save PDF" renders the target node to a single-page
// letter PDF (via html2canvas + jsPDF) instead of the browser print dialog.
// Use for fixed-size single-page reports (the Custom Player Card).
export default function ReportActions({ targetRef, filename = 'report', className = '', pdfFromCanvas = false }) {
  const [busy, setBusy] = useState(false)

  const run = async (fn) => {
    setBusy(true)
    try { await fn(targetRef?.current, filename) }
    catch (e) { console.error('export failed', e) }
    finally { setBusy(false) }
  }
  const onImage = () => run(saveNodeAsImage)
  const onPdf = () => run(saveNodeAsPdf)

  return (
    <div className={`flex items-center gap-2 print:hidden ${className}`}>
      <button
        onClick={pdfFromCanvas ? onPdf : () => window.print()}
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
    </div>
  )
}
