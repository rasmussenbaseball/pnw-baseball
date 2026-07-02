/**
 * Pocket Defensive Card — /portal/alignments/cards?team_id=
 *
 * One grid for the whole opponent lineup: each ROW is a hitter, each COLUMN is
 * one of our fielders (1B, 2B, 3B, SS, LF, CF, RF), and the cell is a short
 * code for where that fielder should play against that hitter. Plus BUNT and
 * STEAL columns so players know the running-game threats. Printable to one
 * page (letter landscape) or saved as an image.
 *
 * Abbreviations: PL pull side · OP oppo side · SL slight · HV heavy ·
 * DP deep · IN shallow · BK back · — straight up.
 *
 * Data: /api/v1/portal/alignments?team_id=&season=
 */

import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { CURRENT_SEASON } from '../lib/seasons'
import { saveNodeAsPdf, saveNodeAsImage } from '../lib/reportExport'

const SEASON = CURRENT_SEASON
const POS_COLS = ['1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']

// Cell tint by the move code so the grid reads at a glance (bold = heavy).
function cellClass(abbr) {
  if (!abbr || abbr === '—') return 'text-gray-300'
  const heavy = abbr.includes('HV')
  let bg = ''
  if (abbr.includes('PL')) bg = heavy ? 'bg-rose-200' : 'bg-rose-50'
  else if (abbr.includes('OP')) bg = heavy ? 'bg-sky-200' : 'bg-sky-50'
  else if (abbr.includes('DP')) bg = 'bg-indigo-50'
  else if (abbr.includes('IN')) bg = 'bg-amber-50'
  return `${bg} ${heavy ? 'font-extrabold' : 'font-semibold'} text-gray-800`
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
  const gridRef = useRef(null)
  useEffect(() => { document.title = `DefCard_${data?.team?.short_name || ''}` }, [data])

  const fname = `DefCard_${(data?.team?.short_name || 'team').replace(/\s+/g, '')}`

  if (!teamId) return <div className="max-w-2xl mx-auto p-8 text-gray-500">No team selected. Open from the <a className="text-portal-purple underline" href="/portal/alignments">Defensive Alignments</a> page.</div>

  return (
    <div className="px-3 py-4">
      <div className="bg-portal-purple text-portal-cream px-4 py-3 print:hidden flex items-center justify-between gap-3 flex-wrap rounded-t-lg max-w-[1050px] mx-auto">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-portal-cream/70 leading-none">Defensive Positioning Card</div>
          <div className="text-base font-bold leading-tight">{data?.team?.short_name} · {hitters.length} hitters</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => saveNodeAsPdf(gridRef.current, fname, { format: 'letter', orientation: 'landscape' })}
            disabled={!hitters.length}
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded bg-portal-cream text-portal-purple-dark hover:bg-white disabled:opacity-60">
            Save PDF
          </button>
          <button onClick={() => saveNodeAsImage(gridRef.current, fname)} disabled={!hitters.length}
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded border border-portal-cream/40 text-portal-cream hover:bg-portal-purple-light disabled:opacity-60">
            Save image
          </button>
        </div>
      </div>

      {error && <div className="p-6 text-red-700">{error}</div>}
      {loading && !data && <div className="p-8 text-gray-400 animate-pulse">Building card…</div>}

      {hitters.length > 0 && (
        <div ref={gridRef} className="pocket-grid bg-white max-w-[1050px] mx-auto p-4 border border-gray-200">
          <div className="flex items-baseline justify-between mb-1">
            <div className="text-lg font-extrabold text-portal-purple-dark">{data?.team?.short_name} — Defensive Card</div>
            <div className="text-[10px] text-gray-400">{data?.meta?.season} · where each fielder plays vs each hitter</div>
          </div>
          {/* legend */}
          <div className="text-[10px] text-gray-500 mb-2 flex flex-wrap gap-x-3 gap-y-0.5">
            <span><b>PL</b> pull side</span><span><b>OP</b> oppo side</span>
            <span><b>SL</b> slight</span><span><b>HV</b> heavy</span>
            <span><b>DP</b> deep</span><span><b>IN</b> shallow</span>
            <span><b>—</b> straight up</span>
            <span className="text-amber-700"><b>BUNT</b> season bunts (h = for a hit)</span>
            <span className="text-teal-700"><b>STL</b> stolen bases</span>
          </div>

          <table className="w-full border-collapse text-center tabular-nums" style={{ fontSize: '11px' }}>
            <thead>
              <tr className="bg-portal-purple text-portal-cream">
                <th className="px-1 py-1 text-right">#</th>
                <th className="px-2 py-1 text-left">Hitter</th>
                <th className="px-1 py-1">B</th>
                {POS_COLS.map(p => <th key={p} className="px-1 py-1">{p}</th>)}
                <th className="px-1 py-1 bg-amber-600">BUNT</th>
                <th className="px-1 py-1 bg-teal-700">STL</th>
              </tr>
            </thead>
            <tbody>
              {hitters.map((h, ri) => {
                const byPos = {}
                for (const f of (h.fielders || [])) byPos[f.pos] = f.abbr
                const rg = h.run_game || {}
                const bunts = rg.bunts || 0
                const sb = rg.sb || 0
                return (
                  <tr key={h.player_id} className={ri % 2 ? 'bg-gray-50' : 'bg-white'}>
                    <td className="px-1 py-1 text-right text-gray-400">{h.jersey || ''}</td>
                    <td className="px-2 py-1 text-left font-semibold text-gray-900 whitespace-nowrap">{h.name}</td>
                    <td className="px-1 py-1 text-gray-500">{h.bats}</td>
                    {POS_COLS.map(p => (
                      <td key={p} className={`px-1 py-1 border-l border-gray-100 ${cellClass(byPos[p])}`}>
                        {byPos[p] || '—'}
                      </td>
                    ))}
                    <td className={`px-1 py-1 border-l border-gray-200 ${bunts >= 2 ? 'bg-amber-100 font-bold text-amber-900' : 'text-gray-500'}`}>
                      {bunts > 0 ? `${bunts}${rg.bunt_hits ? ` (${rg.bunt_hits}h)` : ''}` : '·'}
                    </td>
                    <td className={`px-1 py-1 border-l border-gray-200 ${sb >= 8 ? 'bg-teal-100 font-bold text-teal-900' : 'text-gray-500'}`}>
                      {sb > 0 ? sb : '·'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="text-[9px] text-gray-400 mt-2 italic">
            Codes are per-fielder shading from each hitter's spray. Straight up (—) = normal alignment. Thin samples are directional.
          </div>
        </div>
      )}
    </div>
  )
}
