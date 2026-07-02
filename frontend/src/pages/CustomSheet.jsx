/**
 * Custom Scouting Sheet builder — /portal/custom-sheet.
 *
 * Pick a team + hitters/pitchers, stack any filters (game state, handedness,
 * home/away, timing, count, pinch-hit), then choose exactly which stat columns
 * to show. The sheet builds live and saves as a PDF or image.
 *
 * Data: /portal/splits (build_splits) — every per-player stat we compute under
 * the selected filter. Season-only advanced metrics (wRC+, WAR, FIP+) aren't
 * split-computable, so they live on the standard scouting sheets, not here.
 */

import { useState, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'
import { CURRENT_SEASON } from '../lib/seasons'
import ReportActions from '../components/ReportActions'
import { toneAttr } from '../lib/reportExport'

const SEASON = CURRENT_SEASON

const rate = v => v == null ? '–' : Number(v).toFixed(3).replace(/^0\./, '.').replace(/^-0\./, '-.')
const pct = v => v == null ? '–' : `${(v * 100).toFixed(1)}%`
const int = v => v == null ? '–' : `${Math.round(v)}`

// Filter option catalogs (keys match the backend dicts).
const F_BASE = [['all', 'Any base state'], ['bases_empty', 'Bases empty'], ['runner_on', 'Runner on'], ['risp', 'RISP'], ['risp_2out', 'RISP, 2 out'], ['loaded', 'Bases loaded'], ['leadoff', 'Leadoff']]
const F_TIMING = [['all', 'Any inning'], ['innings_1_3', 'Innings 1-3'], ['innings_4_6', 'Innings 4-6'], ['innings_7_plus', 'Innings 7+'], ['late_close', 'Late & close']]
const F_VENUE = [['all', 'Home & away'], ['home', 'Home only'], ['away', 'Away only']]
const F_COUNT = [['all', 'Any count'], ['first_pitch', 'First pitch'], ['ahead', 'Hitter ahead'], ['even', 'Even count'], ['behind', 'Hitter behind'], ['two_strike', 'Two strikes'], ['three_ball', 'Three balls'],
  ['0-0', '0-0'], ['1-0', '1-0'], ['2-0', '2-0'], ['3-0', '3-0'], ['0-1', '0-1'], ['1-1', '1-1'], ['2-1', '2-1'], ['3-1', '3-1'], ['0-2', '0-2'], ['1-2', '1-2'], ['2-2', '2-2'], ['3-2', '3-2']]
const F_HAND_HIT = [['all', 'vs Any hand'], ['vs_rhp', 'vs RHP'], ['vs_lhp', 'vs LHP']]
const F_HAND_PIT = [['all', 'vs Any hand'], ['vs_rhb', 'vs RHB'], ['vs_lhb', 'vs LHB']]
const F_ENTRY = [['all', 'Any entry'], ['starter', 'Started (batted by 3rd)'], ['bench', 'Off the bench']]

// Stat catalogs. good/bad drive good→bad shading (good<bad = lower is better).
const HIT_STATS = [
  { key: 'pa', label: 'PA', group: 'Counts', fmt: int }, { key: 'ab', label: 'AB', group: 'Counts', fmt: int },
  { key: 'h', label: 'H', group: 'Counts', fmt: int }, { key: 'doubles', label: '2B', group: 'Counts', fmt: int },
  { key: 'triples', label: '3B', group: 'Counts', fmt: int }, { key: 'hr', label: 'HR', group: 'Counts', fmt: int },
  { key: 'bb', label: 'BB', group: 'Counts', fmt: int }, { key: 'so', label: 'SO', group: 'Counts', fmt: int },
  { key: 'hbp', label: 'HBP', group: 'Counts', fmt: int }, { key: 'tb', label: 'TB', group: 'Counts', fmt: int },
  { key: 'avg', label: 'AVG', group: 'Slash', fmt: rate, good: .330, bad: .220 },
  { key: 'obp', label: 'OBP', group: 'Slash', fmt: rate, good: .430, bad: .290 },
  { key: 'slg', label: 'SLG', group: 'Slash', fmt: rate, good: .500, bad: .300 },
  { key: 'ops', label: 'OPS', group: 'Slash', fmt: rate, good: .900, bad: .600 },
  { key: 'woba', label: 'wOBA', group: 'Slash', fmt: rate, good: .420, bad: .290 },
  { key: 'iso', label: 'ISO', group: 'Slash', fmt: rate, good: .200, bad: .080 },
  { key: 'babip', label: 'BABIP', group: 'Slash', fmt: rate, good: .360, bad: .260 },
  { key: 'k_pct', label: 'K%', group: 'Discipline', fmt: pct, good: .12, bad: .28 },
  { key: 'bb_pct', label: 'BB%', group: 'Discipline', fmt: pct, good: .15, bad: .04 },
  { key: 'k_bb_pct', label: 'K-BB%', group: 'Discipline', fmt: pct, good: -.05, bad: .20 },
  { key: 'hr_pct', label: 'HR%', group: 'Discipline', fmt: pct, good: .05, bad: .004 },
  { key: 'swing_pct', label: 'Swing%', group: 'Discipline', fmt: pct },
  { key: 'contact_pct', label: 'Contact%', group: 'Discipline', fmt: pct, good: .88, bad: .72 },
  { key: 'whiff_pct', label: 'Whiff%', group: 'Discipline', fmt: pct, good: .10, bad: .30 },
  { key: 'strike_pct', label: 'Strike%', group: 'Discipline', fmt: pct },
  { key: 'gb_pct', label: 'GB%', group: 'Batted Ball', fmt: pct },
  { key: 'ld_pct', label: 'LD%', group: 'Batted Ball', fmt: pct, good: .26, bad: .15 },
  { key: 'fb_pct', label: 'FB%', group: 'Batted Ball', fmt: pct },
  { key: 'pu_pct', label: 'PU%', group: 'Batted Ball', fmt: pct, good: .02, bad: .12 },
]
const PIT_STATS = [
  { key: 'pa', label: 'BF', group: 'Counts', fmt: int }, { key: 'h', label: 'H', group: 'Counts', fmt: int },
  { key: 'hr', label: 'HR', group: 'Counts', fmt: int }, { key: 'bb', label: 'BB', group: 'Counts', fmt: int },
  { key: 'so', label: 'SO', group: 'Counts', fmt: int }, { key: 'hbp', label: 'HBP', group: 'Counts', fmt: int },
  { key: 'avg', label: 'oAVG', group: 'Against', fmt: rate, good: .220, bad: .320 },
  { key: 'obp', label: 'oOBP', group: 'Against', fmt: rate, good: .290, bad: .400 },
  { key: 'slg', label: 'oSLG', group: 'Against', fmt: rate, good: .320, bad: .480 },
  { key: 'ops', label: 'oOPS', group: 'Against', fmt: rate, good: .620, bad: .850 },
  { key: 'woba', label: 'oWOBA', group: 'Against', fmt: rate, good: .290, bad: .400 },
  { key: 'iso', label: 'oISO', group: 'Against', fmt: rate, good: .080, bad: .200 },
  { key: 'babip', label: 'oBABIP', group: 'Against', fmt: rate, good: .260, bad: .360 },
  { key: 'k_pct', label: 'K%', group: 'Discipline', fmt: pct, good: .28, bad: .12 },
  { key: 'bb_pct', label: 'BB%', group: 'Discipline', fmt: pct, good: .05, bad: .12 },
  { key: 'k_bb_pct', label: 'K-BB%', group: 'Discipline', fmt: pct, good: .20, bad: .05 },
  { key: 'whiff_pct', label: 'Whiff%', group: 'Discipline', fmt: pct, good: .28, bad: .15 },
  { key: 'strike_pct', label: 'Strike%', group: 'Discipline', fmt: pct, good: .68, bad: .58 },
  { key: 'swing_pct', label: 'Swing%', group: 'Discipline', fmt: pct },
  { key: 'contact_pct', label: 'Contact%', group: 'Discipline', fmt: pct, good: .72, bad: .88 },
  { key: 'gb_pct', label: 'GB%', group: 'Batted Ball', fmt: pct },
  { key: 'ld_pct', label: 'LD%', group: 'Batted Ball', fmt: pct, good: .15, bad: .26 },
  { key: 'fb_pct', label: 'FB%', group: 'Batted Ball', fmt: pct },
  { key: 'pu_pct', label: 'PU%', group: 'Batted Ball', fmt: pct, good: .12, bad: .02 },
]
const DEFAULT_HIT = ['pa', 'avg', 'obp', 'slg', 'ops', 'woba', 'iso', 'k_pct', 'bb_pct', 'contact_pct']
const DEFAULT_PIT = ['pa', 'avg', 'obp', 'slg', 'k_pct', 'bb_pct', 'whiff_pct', 'strike_pct']

function tscore(v, good, bad) {
  if (v == null || good == null || bad == null || good === bad) return null
  const s = (Number(v) - bad) / (good - bad)
  return Math.max(0, Math.min(1, s)) * 100
}
function shade(score) {
  if (score == null) return undefined
  const p = Math.max(0, Math.min(100, score)) / 100
  let r, g, b, a
  if (p >= 0.5) { const t = (p - 0.5) * 2; r = Math.round(255 + (162 - 255) * t); g = Math.round(255 + (210 - 255) * t); b = Math.round(255 + (162 - 255) * t); a = 0.5 + 0.4 * t }
  else { const t = (0.5 - p) * 2; r = Math.round(255 + (245 - 255) * t); g = Math.round(255 + (170 - 255) * t); b = Math.round(255 + (170 - 255) * t); a = 0.5 + 0.4 * t }
  return `rgba(${r},${g},${b},${a})`
}
const handColor = h => ({ L: '#c0392b', R: '#1f4e8c', B: '#7d3c98', S: '#7d3c98' }[(h || '').toUpperCase()] || '#374151')

function Select({ value, onChange, options }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="px-2.5 py-1.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )
}

export default function CustomSheet() {
  const { team: portalTeam } = usePortalTeam()
  const [teamId, setTeamId] = useState(portalTeam?.id || null)
  const [side, setSide] = useState('hitters')
  const [baseState, setBaseState] = useState('all')
  const [handedness, setHandedness] = useState('all')
  const [venue, setVenue] = useState('all')
  const [timing, setTiming] = useState('all')
  const [count, setCount] = useState('all')
  const [entry, setEntry] = useState('all')
  const [minPa, setMinPa] = useState(5)
  const [sortKey, setSortKey] = useState('pa')
  const [sortDir, setSortDir] = useState('desc')
  const [selHit, setSelHit] = useState(new Set(DEFAULT_HIT))
  const [selPit, setSelPit] = useState(new Set(DEFAULT_PIT))
  const reportRef = useRef(null)

  const { data: teams } = useApi('/teams', {})
  const isHit = side === 'hitters'
  const catalog = isHit ? HIT_STATS : PIT_STATS
  const selected = isHit ? selHit : selPit
  const setSelected = isHit ? setSelHit : setSelPit
  const toggleCol = key => setSelected(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })

  const { data } = useApi('/portal/splits',
    teamId ? { team_id: teamId, side, season: SEASON, base_state: baseState, handedness, venue, timing, count, entry, min_pa: minPa } : {},
    [teamId, side, baseState, handedness, venue, timing, count, entry, minPa])

  const teamOpts = useMemo(() => (teams || []).filter(t => t.is_active).sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name)), [teams])
  const cols = catalog.filter(c => selected.has(c.key))
  const teamRow = (teams || []).find(t => t.id === teamId)

  const rows = useMemo(() => {
    const list = [...(data?.players || [])]
    list.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (av == null) return 1; if (bv == null) return -1
      return sortDir === 'desc' ? bv - av : av - bv
    })
    return list
  }, [data, sortKey, sortDir])
  const toggleSort = k => { if (sortKey === k) setSortDir(d => d === 'desc' ? 'asc' : 'desc'); else { setSortKey(k); setSortDir('desc') } }

  const handField = isHit ? 'bats' : 'throws'
  const groups = [...new Set(catalog.map(c => c.group))]

  return (
    <div className="custom-sheet-page max-w-full mx-auto px-3 sm:px-5 py-5 space-y-4">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 space-y-3 print:hidden">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-lg font-bold text-portal-purple-dark dark:text-gray-100">Custom Scouting Sheet</h1>
          <div className="inline-flex rounded-lg overflow-hidden border border-gray-300">
            {['hitters', 'pitchers'].map(s => (
              <button key={s} onClick={() => setSide(s)}
                className={`px-3 py-1.5 text-sm font-medium capitalize ${side === s ? 'bg-portal-purple text-portal-cream' : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>{s}</button>
            ))}
          </div>
          {data && teamRow && <ReportActions targetRef={reportRef} className="ml-auto"
            filename={`custom_${(teamRow.short_name || teamRow.name || 'team').replace(/\s+/g, '_')}_${side}`} />}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={teamId ?? ''} onChange={e => setTeamId(Number(e.target.value))}
            className="px-2.5 py-1.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal min-w-[190px]">
            <option value="">Pick a team...</option>
            {teamOpts.map(t => <option key={t.id} value={t.id}>{t.short_name || t.name}</option>)}
          </select>
          <Select value={baseState} onChange={setBaseState} options={F_BASE} />
          <Select value={handedness} onChange={setHandedness} options={isHit ? F_HAND_HIT : F_HAND_PIT} />
          <Select value={venue} onChange={setVenue} options={F_VENUE} />
          <Select value={timing} onChange={setTiming} options={F_TIMING} />
          <Select value={count} onChange={setCount} options={F_COUNT} />
          {isHit && <Select value={entry} onChange={setEntry} options={F_ENTRY} />}
          <label className="text-xs text-gray-500 flex items-center gap-1">min
            <input type="number" min="1" value={minPa} onChange={e => setMinPa(Math.max(1, Number(e.target.value) || 1))}
              className="w-14 px-2 py-1 rounded border border-gray-300 text-sm" /></label>
        </div>
        {/* Column picker */}
        <div className="border-t border-gray-100 dark:border-gray-700 pt-2">
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1.5">Columns ({cols.length})</div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {groups.map(g => (
              <div key={g}>
                <div className="text-[10px] uppercase text-gray-400 font-semibold mb-0.5">{g}</div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {catalog.filter(c => c.group === g).map(c => (
                    <label key={c.key} className="flex items-center gap-1 cursor-pointer select-none text-xs">
                      <input type="checkbox" checked={selected.has(c.key)} onChange={() => toggleCol(c.key)} className="accent-portal-purple" />
                      <span className="text-gray-700 dark:text-gray-300">{c.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Live sheet — fixed page width so the PDF/image are a standard size */}
      <div className="flex justify-center">
        <section ref={reportRef} className="sheet-page bg-white w-full max-w-[816px] border border-gray-200 rounded-xl overflow-hidden print:border-0 print:rounded-none">
          {!teamId ? (
            <p className="text-sm text-gray-500 italic p-4">Pick a team to build a sheet.</p>
          ) : !cols.length ? (
            <p className="text-sm text-gray-500 italic p-4">Select at least one stat column.</p>
          ) : !rows.length ? (
            <p className="text-sm text-gray-500 italic p-4">No players match these filters.</p>
          ) : (
            <>
              <div className="flex items-baseline justify-between px-3 pt-2 pb-1">
                <div className="font-bold text-portal-purple-dark">{teamRow?.short_name || teamRow?.name} · <span className="uppercase text-sm">{side}</span></div>
                <div className="text-[11px] text-gray-400">{rows.length} players · {SEASON}</div>
              </div>
              <table className="w-full border-collapse text-[9px] leading-tight tabular-nums table-fixed">
                <colgroup>
                  <col style={{ width: '4%' }} />
                  <col style={{ width: '19%' }} />
                  <col style={{ width: '4.5%' }} />
                  <col style={{ width: '3.5%' }} />
                  {cols.map(c => <col key={c.key} style={{ width: `${69 / cols.length}%` }} />)}
                </colgroup>
                <thead>
                  <tr className="bg-portal-purple text-portal-cream">
                    <th className="text-right px-1 py-1 border border-portal-purple-dark">#</th>
                    <th className="text-left px-1 py-1 border border-portal-purple-dark">Name</th>
                    <th className="text-left px-0.5 py-1 border border-portal-purple-dark">Pos</th>
                    <th className="text-center px-0.5 py-1 border border-portal-purple-dark">{isHit ? 'B' : 'T'}</th>
                    {cols.map(c => (
                      <th key={c.key} onClick={() => toggleSort(c.key)}
                        className="text-center px-0.5 py-1 border border-portal-purple-dark font-semibold cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis print:cursor-auto">
                        {c.label}{sortKey === c.key ? (sortDir === 'desc' ? ' ▾' : ' ▴') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.player_id}>
                      <td className="text-right px-1 py-0.5 border border-gray-200 text-gray-500">{r.jersey_number || '–'}</td>
                      <td className="text-left px-1 py-0.5 border border-gray-200 font-bold whitespace-nowrap overflow-hidden text-ellipsis" style={{ color: handColor(r[handField]) }}>
                        {r.first_name?.[0]}. {r.last_name}
                      </td>
                      <td className="text-left px-0.5 py-0.5 border border-gray-200 text-gray-600">{r.position || '–'}</td>
                      <td className="text-center px-0.5 py-0.5 border border-gray-200 text-gray-600">{r[handField] || '–'}</td>
                      {cols.map(c => (
                        <td key={c.key} className="text-center px-0.5 py-0.5 border border-gray-200 overflow-hidden text-ellipsis"
                          {...toneAttr(tscore(r[c.key], c.good, c.bad))}
                          style={{ backgroundColor: shade(tscore(r[c.key], c.good, c.bad)) }}>
                          {c.fmt(r[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      </div>
      <p className="text-[11px] text-gray-400 px-1 print:hidden">
        From play-by-play, computed under the filters above. Shading is good→bad on an absolute scale (green good, red poor).
        Season-only metrics (wRC+, WAR, FIP+) aren't split-computable and live on the standard <Link to="/portal/scouting-sheet" className="text-nw-teal hover:underline">scouting sheet</Link>.
      </p>
    </div>
  )
}
