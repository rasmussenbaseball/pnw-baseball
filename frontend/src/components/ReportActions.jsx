// ReportActions — a small "Save PDF / Save image" button pair for any report.
// Pass a ref to the element that should be captured as an image (PDF uses the
// browser print dialog, so it prints the whole page's print layout).

import { useState } from 'react'
import { saveNodeAsImage } from '../lib/reportExport'

export default function ReportActions({ targetRef, filename = 'report', className = '' }) {
  const [busy, setBusy] = useState(false)

  const onImage = async () => {
    setBusy(true)
    try {
      await saveNodeAsImage(targetRef?.current, filename)
    } catch (e) {
      console.error('image export failed', e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`flex items-center gap-2 print:hidden ${className}`}>
      <button
        onClick={() => window.print()}
        className="px-3 py-2 rounded-lg bg-portal-purple text-portal-cream text-sm font-semibold hover:opacity-90"
      >
        Save PDF
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
