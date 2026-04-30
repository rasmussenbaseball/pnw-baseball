// BulkPlayerCards — renders many <PlayerCard /> instances stacked,
// each on its own printable page, so a coach can print a whole
// roster's worth of player cards in one print job.
//
// URL shape:  /portal/pdfs/bulk-player-cards?ids=1234:batting,1234:pitching,5678:batting
//
// Each `id:side` combo becomes one card. Two-way players appear twice
// in the URL (one per side they want printed) — so a hitter+pitcher
// like Saelens can be requested as `3372:batting,3372:pitching` and
// gets two separate pages.
//
// Print: each .card-page is `page-break-inside: avoid` and we put a
// .sheet-pagebreak between cards (same trick as the scouting sheet)
// so the browser places one card per physical page.

import { useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PlayerCard } from './PlayerCardPDF'


export default function BulkPlayerCards() {
  const [searchParams] = useSearchParams()
  const idsParam = searchParams.get('ids') || ''

  // Parse "1234:batting,5678:pitching,..." into an array of {id, side}
  // tuples. We tolerate plain "1234" entries (default to batting) so
  // hand-typed URLs still work.
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

  // Set the document title once based on how many cards are in the
  // batch. The print dialog's "Save as PDF" suggestion picks this up.
  // No cleanup/restore — other portal pages set their own titles on
  // mount, which avoids the React 18 effect-double-invocation pitfall
  // of capturing a stale "original" value.
  useEffect(() => {
    document.title = items.length === 1
      ? 'PlayerCards_1'
      : `PlayerCards_${items.length}`
  }, [items.length])

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

  return (
    <div className="bulk-cards">
      {/* Toolbar — single print button covers all cards. Hidden on
          print so it doesn't show up in the saved PDF. */}
      <div className="bg-portal-purple text-portal-cream sticky top-0 z-10 px-4 py-3 print:hidden flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-portal-cream/70 leading-none">
            Bulk Player Cards
          </div>
          <div className="text-base font-bold leading-tight">
            {items.length} card{items.length === 1 ? '' : 's'} ready to print
          </div>
        </div>
        <button
          onClick={() => window.print()}
          className="px-5 py-2 text-xs font-bold uppercase tracking-wider rounded
                     bg-portal-cream text-portal-purple-dark hover:bg-white"
        >
          Print / Save as PDF
        </button>
      </div>

      {/* Cards stacked. Each is wrapped in a div so we can insert a
          page break between them without modifying PlayerCard itself. */}
      {items.map((it, i) => (
        <div key={`${it.id}-${it.side}-${i}`}>
          <PlayerCard
            playerId={it.id}
            sideParam={it.side}
            showToolbar={false}
          />
          {i < items.length - 1 && <div className="sheet-pagebreak" />}
        </div>
      ))}
    </div>
  )
}
