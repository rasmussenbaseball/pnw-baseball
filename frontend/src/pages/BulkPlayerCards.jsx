// BulkPlayerCards — renders many player cards stacked, each on its own
// printable page, so a coach can print a whole roster's worth of cards in one
// job.
//
// URL shape:  /portal/pdfs/bulk-player-cards?ids=1234:batting,5678:pitching
//             &template=<templateId>   (optional)
//
// Each `id:side` combo becomes one card. Two-way players appear twice in the
// URL (one per side). With no template, we render the standard fixed
// <PlayerCard> and print via the browser dialog. With a template (built in the
// Custom Player Card builder, saved to localStorage), we render <CustomCard>
// per player in that layout and export a multi-page PDF via html2canvas — the
// custom card is 8.5in wide, which the @media print margins would clip, so the
// image path is the reliable one.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PlayerCard } from './PlayerCardPDF'
import { CustomCard } from './CustomCard'
import { getTemplate } from '../lib/cardTemplates'
import { saveNodesAsPdf } from '../lib/reportExport'


export default function BulkPlayerCards() {
  const [searchParams] = useSearchParams()
  const idsParam = searchParams.get('ids') || ''
  const templateId = searchParams.get('template') || ''
  const template = useMemo(() => (templateId ? getTemplate(templateId) : null), [templateId])

  const items = useMemo(() => {
    return idsParam.split(',')
      .map(s => s.trim()).filter(Boolean)
      .map(token => {
        const [idStr, sideStr] = token.split(':')
        const id = parseInt(idStr, 10)
        const side = (sideStr === 'pitching' ? 'pitching' :
                      sideStr === 'batting'  ? 'batting'  : 'batting')
        return Number.isFinite(id) ? { id, side } : null
      })
      .filter(Boolean)
  }, [idsParam])

  useEffect(() => {
    document.title = `PlayerCards_${items.length}`
  }, [items.length])

  const cardRefs = useRef([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [bw, setBw] = useState(false)

  const onExportPdf = async () => {
    setBusy(true)
    setProgress('Rendering…')
    const nodes = cardRefs.current.filter(Boolean)
    if (bw) nodes.forEach(n => n.classList.add('bw-report'))
    try {
      await saveNodesAsPdf(
        cardRefs.current,
        `PlayerCards_${items.length}${template ? '_' + template.name.replace(/\s+/g, '') : ''}${bw ? '_bw' : ''}`,
        (done, total) => setProgress(`Rendering ${done}/${total}…`),
      )
    } catch (e) {
      console.error('bulk pdf failed', e)
    } finally {
      if (bw) nodes.forEach(n => n.classList.remove('bw-report'))
      setBusy(false)
      setProgress('')
    }
  }

  // Standard (non-template) cards print via the browser dialog; apply B&W to
  // the whole stack for the duration of the print.
  const onPrint = () => {
    const wrap = document.querySelector('.bulk-cards')
    if (bw && wrap) {
      wrap.classList.add('bw-report')
      const cleanup = () => { wrap.classList.remove('bw-report'); window.removeEventListener('afterprint', cleanup) }
      window.addEventListener('afterprint', cleanup)
    }
    window.print()
  }

  if (!items.length) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <p className="text-gray-500">
          No players selected. Go back to{' '}
          <a className="text-portal-purple underline" href="/portal/pdfs">/portal/pdfs</a>{' '}
          to pick a roster.
        </p>
      </div>
    )
  }

  // Side for a template card: honor the token's side, but a template that pins
  // a side (not 'auto') overrides it for the whole batch.
  const templateSide = it => (template && template.sidePref && template.sidePref !== 'auto') ? template.sidePref : it.side

  return (
    <div className="bulk-cards">
      <div className="bg-portal-purple text-portal-cream sticky top-0 z-10 px-4 py-3 print:hidden flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-portal-cream/70 leading-none">
            Bulk Player Cards{template ? ` · ${template.name}` : ''}
          </div>
          <div className="text-base font-bold leading-tight">
            {items.length} card{items.length === 1 ? '' : 's'} ready
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs font-medium text-portal-cream/90 cursor-pointer select-none"
                 title="Strip color shading for mono printers (bold = good, italic = bad)">
            <input type="checkbox" checked={bw} onChange={e => setBw(e.target.checked)} className="h-3.5 w-3.5 accent-portal-accent" />
            B&amp;W
          </label>
          {template ? (
            <button
              onClick={onExportPdf}
              disabled={busy}
              className="px-5 py-2 text-xs font-bold uppercase tracking-wider rounded
                         bg-portal-cream text-portal-purple-dark hover:bg-white disabled:opacity-60"
            >
              {busy ? progress || 'Rendering…' : 'Save all as PDF'}
            </button>
          ) : (
            <button
              onClick={onPrint}
              className="px-5 py-2 text-xs font-bold uppercase tracking-wider rounded
                         bg-portal-cream text-portal-purple-dark hover:bg-white"
            >
              Print / Save as PDF
            </button>
          )}
        </div>
      </div>

      {template && (
        <div className="print:hidden max-w-2xl mx-auto px-4 pt-3 text-[11px] text-gray-500">
          Using your “{template.name}” template. Cards render below and export as a multi-page PDF (one card per page).
          Give them a moment to load before exporting.
        </div>
      )}

      {items.map((it, i) => (
        <div key={`${it.id}-${it.side}-${i}`} className={template ? 'flex justify-center py-3' : ''}>
          {template ? (
            <CustomCard
              playerId={it.id}
              blocks={template.blocks}
              sideParam={templateSide(it)}
              cardRef={el => { cardRefs.current[i] = el }}
            />
          ) : (
            <>
              <PlayerCard playerId={it.id} sideParam={it.side} showToolbar={false} />
              {i < items.length - 1 && <div className="sheet-pagebreak" />}
            </>
          )}
        </div>
      ))}
    </div>
  )
}
