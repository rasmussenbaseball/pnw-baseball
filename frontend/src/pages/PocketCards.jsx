/**
 * Pocket Shift Cards — /portal/alignments/cards?team_id=
 *
 * Index-card-sized (5"×3") defensive-shift cards, one per opponent hitter, for
 * the dugout. Each card: a field diagram with the 7 fielders' ideal dots, the
 * shift call, the key fielder moves, and the hitter's spray headline. Export
 * the whole team as a multi-page PDF (one index card per page) or a PNG sheet.
 *
 * Data: /api/v1/portal/alignments?team_id=&season= (same as the Alignments page).
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { CURRENT_SEASON } from '../lib/seasons'
import FieldMini from '../components/FieldMini'
import { saveNodesAsPdf, saveNodeAsImage } from '../lib/reportExport'

const SEASON = CURRENT_SEASON
const CARD_W = 480  // 5in @ 96dpi
const CARD_H = 288  // 3in @ 96dpi

const SHIFT_CLR = shift => {
  const l = (shift?.label || '').toLowerCase()
  if (l.startsWith('full shift')) return '#be123c'   // rose
  if (l.startsWith('shade')) return '#b45309'        // amber
  return '#475569'                                    // slate
}

function PocketCard({ h, team, cardRef }) {
  const shift = h.shift || {}
  const lanes = h.lanes || {}
  const domIf = h.infield ? Object.entries(h.infield).sort((a, b) => b[1] - a[1])[0] : null
  const IF_SHORT = { IF_3B: '3B', IF_SS: 'SS', IF_MID: 'up-mid', IF_2B: '2B', IF_1B: '1B' }
  return (
    <div ref={cardRef} className="pocket-card bg-white text-gray-900 border border-gray-300 flex overflow-hidden"
      style={{ width: `${CARD_W}px`, height: `${CARD_H}px` }}>
      {/* Field diagram */}
      <div className="shrink-0 flex items-center justify-center" style={{ width: '250px', padding: '6px' }}>
        <FieldMini fielders={h.fielders} w={230} h={250} />
      </div>
      {/* Text panel */}
      <div className="flex-1 border-l border-gray-200 px-3 py-2.5 flex flex-col" style={{ minWidth: 0 }}>
        <div className="flex items-baseline gap-1.5">
          <span className="font-extrabold text-[15px] truncate">{h.name}</span>
          <span className="text-[11px] text-gray-500">{h.position}</span>
          <span className="text-[10px] font-bold px-1 rounded bg-gray-100 text-gray-600">{h.bats}HH</span>
        </div>
        <div className="text-[10px] text-gray-400 mb-1">{team?.short_name} · {h.bip} BIP</div>

        <div className="text-[15px] font-extrabold leading-tight mb-1" style={{ color: SHIFT_CLR(shift) }}>
          {shift.label}
        </div>

        <ul className="space-y-0.5 mb-1">
          {(shift.moves || []).slice(0, 5).map((m, i) => (
            <li key={i} className="text-[11px] leading-tight">
              <b>{m.pos}</b> {m.note}
            </li>
          ))}
        </ul>

        <div className="mt-auto text-[10px] text-gray-500 leading-tight">
          <div>Grounders: {Math.round((lanes.if_pull || 0) * 100)}% pull {lanes.pull_side}</div>
          {domIf && <div>Most: {IF_SHORT[domIf[0]] || domIf[0]} {Math.round(domIf[1] * 100)}%</div>}
        </div>
      </div>
    </div>
  )
}

export default function PocketCards() {
  const [searchParams] = useSearchParams()
  const teamId = Number(searchParams.get('team_id')) || null
  const { data, loading, error } = useApi(
    teamId ? '/portal/alignments' : null,
    teamId ? { team_id: teamId, season: SEASON } : {},
    [teamId],
  )
  const hitters = data?.hitters || []
  const refs = useRef([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')

  useEffect(() => { document.title = `ShiftCards_${data?.team?.short_name || ''}` }, [data])

  const onPdf = async () => {
    setBusy(true); setProgress('Rendering…')
    try {
      await saveNodesAsPdf(
        refs.current,
        `ShiftCards_${data?.team?.short_name || 'team'}`.replace(/\s+/g, ''),
        (d, t) => setProgress(`Rendering ${d}/${t}…`),
        { unit: 'in', format: [5, 3], orientation: 'landscape' },
      )
    } finally { setBusy(false); setProgress('') }
  }

  const sheetRef = useRef(null)

  if (!teamId) return <div className="max-w-2xl mx-auto p-8 text-gray-500">No team selected. Open from the <a className="text-portal-purple underline" href="/portal/alignments">Defensive Alignments</a> page.</div>

  return (
    <div>
      <div className="bg-portal-purple text-portal-cream sticky top-0 z-10 px-4 py-3 print:hidden flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-portal-cream/70 leading-none">Pocket Shift Cards</div>
          <div className="text-base font-bold leading-tight">{data?.team?.short_name} · {hitters.length} hitters</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onPdf} disabled={busy || !hitters.length}
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded bg-portal-cream text-portal-purple-dark hover:bg-white disabled:opacity-60">
            {busy ? progress || 'Rendering…' : 'Save as index-card PDF'}
          </button>
          <button onClick={() => saveNodeAsImage(sheetRef.current, `ShiftCards_${data?.team?.short_name || 'team'}`)} disabled={!hitters.length}
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded border border-portal-cream/40 text-portal-cream hover:bg-portal-purple-light disabled:opacity-60">
            Save image sheet
          </button>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 pt-3 text-[11px] text-gray-500 print:hidden">
        5×3 inch cards — one per hitter. “Save as index-card PDF” gives one card per page to print and cut for the dugout.
      </div>

      {error && <div className="p-6 text-red-700">{error}</div>}
      {loading && !data && <div className="p-8 text-gray-400 animate-pulse">Building cards…</div>}

      <div ref={sheetRef} className="flex flex-wrap gap-4 justify-center p-4">
        {hitters.map((h, i) => (
          <PocketCard key={h.player_id} h={h} team={data?.team} cardRef={el => { refs.current[i] = el }} />
        ))}
      </div>
    </div>
  )
}
