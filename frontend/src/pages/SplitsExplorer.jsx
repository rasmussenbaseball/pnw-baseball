/**
 * Splits Explorer — /portal/splits.
 *
 * A deeply filterable per-player PBP stat table. Pick a team + side, then stack
 * game-state, handedness, home/away, timing, and count filters to dig in.
 * Data: /api/v1/portal/splits
 */

import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'
import { CURRENT_SEASON } from '../lib/seasons'

const SEASON = CURRENT_SEASON

const rate = (v) => v == null ? '—' : Number(v).toFixed(3).replace(/^0/, '')
const pct = (v) => v == null ? '—' : `${Math.round(v * 100)}%`
const int = (v) => v == null ? '—' : `${Math.round(v)}`

// Filter option catalogs (keys must match the backend dicts).
const F_BASE = [
  ['all', 'Any base state'], ['bases_empty', 'Bases empty'], ['runner_on', 'Runner on'],
  ['risp', 'RISP'], ['risp_2out', 'RISP, 2 out'], ['loaded', 'Bases loaded'], ['leadoff', 'Leadoff'],
]
const F_TIMING = [
  ['all', 'Any inning'], ['innings_1_3', 'Innings 1-3'], ['innings_4_6', 'Innings 4-6'],
  ['innings_7_plus', 'Innings 7+'], ['late_close', 'Late & close'],
]
const F_VENUE = [['all', 'Home & away'], ['home', 'Home only'], ['away', 'Away only']]
const F_COUNT = [
  ['all', 'Any count'], ['first_pitch', 'First pitch (0-0)'], ['ahead', 'Hitter ahead'],
  ['even', 'Even count'], ['behind', 'Hitter behind'], ['two_strike', 'Two strikes'], ['three_ball', 'Three balls'],
  ['0-0', '0-0'], ['1-0', '1-0'], ['2-0', '2-0'], ['3-0', '3-0'],
  ['0-1', '0-1'], ['1-1', '1-1'], ['2-1', '2-1'], ['3-1', '3-1'],
  ['0-2', '0-2'], ['1-2', '1-2'], ['2-2', '2-2'], ['3-2', '3-2'],
]
const F_HAND_HIT = [['all', 'vs Any hand'], ['vs_rhp', 'vs RHP'], ['vs_lhp', 'vs LHP']]
const F_HAND_PIT = [['all', 'vs Any hand'], ['vs_rhb', 'vs RHB'], ['vs_lhb', 'vs LHB']]
const F_ENTRY = [['all', 'Any entry'], ['starter', 'Started (batted by 3rd)'], ['bench', 'Off the bench (1st PA after 3rd)']]

// Column catalogs
const HIT_COLS = [
  ['pa', 'PA', int], ['avg', 'AVG', rate], ['obp', 'OBP', rate], ['slg', 'SLG', rate],
  ['ops', 'OPS', rate], ['woba', 'wOBA', rate], ['k_pct', 'K%', pct], ['bb_pct', 'BB%', pct],
  ['swing_pct', 'Swing%', pct], ['contact_pct', 'Contact%', pct], ['whiff_pct', 'Whiff%', pct],
  ['gb_pct', 'GB%', pct], ['ld_pct', 'LD%', pct], ['fb_pct', 'FB%', pct],
]
const PIT_COLS = [
  ['pa', 'BF', int], ['avg', 'oAVG', rate], ['obp', 'oOBP', rate], ['slg', 'oSLG', rate],
  ['k_pct', 'K%', pct], ['bb_pct', 'BB%', pct], ['strike_pct', 'Strike%', pct], ['whiff_pct', 'Whiff%', pct],
  ['gb_pct', 'GB%', pct], ['ld_pct', 'LD%', pct], ['fb_pct', 'FB%', pct],
]

function CountGrid({ data, side }) {
  if (!data?.counts?.length) return <p className="text-sm text-gray-500 italic p-4">No data.</p>
  const cols = side === 'pitchers'
    ? [['strike_pct', 'Strike%'], ['whiff_pct', 'Whiff%'], ['swing_pct', 'Swing%'], ['contact_pct', 'Contact%']]
    : [['swing_pct', 'Swing%'], ['contact_pct', 'Contact%'], ['whiff_pct', 'Whiff%'], ['strike_pct', 'Strike%']]
  return (
    <table className="w-full text-sm tabular-nums">
      <thead className="bg-gray-50 dark:bg-gray-900/40 text-[11px] uppercase text-gray-500">
        <tr>
          <th className="text-left px-3 py-2 font-semibold">Count</th>
          <th className="text-right px-3 py-2 font-semibold">Pitches</th>
          {cols.map(([k, l]) => <th key={k} className="text-right px-3 py-2 font-semibold">{l}</th>)}
        </tr>
      </thead>
      <tbody>
        {data.counts.map(r => (
          <tr key={r.count} className={`border-t border-gray-100 dark:border-gray-700 ${r.strike_pct == null ? 'opacity-40' : ''}`}>
            <td className="text-left px-3 py-1.5 font-semibold text-portal-purple-dark dark:text-gray-100">{r.count}</td>
            <td className="text-right px-3 py-1.5 text-gray-400">{r.pitches}</td>
            {cols.map(([k]) => <td key={k} className="text-right px-3 py-1.5 text-gray-700 dark:text-gray-200">{pct(r[k])}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Select({ value, onChange, options }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="px-2.5 py-1.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal">
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  )
}

export default function SplitsExplorer() {
  const { team: portalTeam } = usePortalTeam()
  const [teamId, setTeamId] = useState(null)
  const [side, setSide] = useState('hitters')
  const [baseState, setBaseState] = useState('all')
  const [handedness, setHandedness] = useState('all')
  const [venue, setVenue] = useState('all')
  const [timing, setTiming] = useState('all')
  const [count, setCount] = useState('all')
  const [entry, setEntry] = useState('all')
  const [minPa, setMinPa] = useState(10)
  const [view, setView] = useState('players')  // 'players' | 'counts'
  const [sortKey, setSortKey] = useState('pa')
  const [sortDir, setSortDir] = useState('desc')

  const { data: teams } = useApi('/teams', {})
  useEffect(() => { if (teamId == null && portalTeam?.id) setTeamId(portalTeam.id) }, [portalTeam?.id, teamId])
  // Reset handedness when switching sides (option keys differ).
  useEffect(() => { setHandedness('all') }, [side])

  const { data, loading } = useApi('/portal/splits',
    (teamId && view === 'players') ? { team_id: teamId, side, season: SEASON, base_state: baseState,
               handedness, venue, timing, count, entry, min_pa: minPa } : {},
    [teamId, side, view, baseState, handedness, venue, timing, count, entry, minPa])

  const { data: gridData, loading: gridLoading } = useApi('/portal/count-grid',
    (teamId && view === 'counts') ? { team_id: teamId, side, season: SEASON, base_state: baseState,
               handedness, venue, timing, entry } : {},
    [teamId, side, view, baseState, handedness, venue, timing, entry])

  const teamOptions = useMemo(() => (teams || []).filter(t => t.is_active)
    .sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name)), [teams])

  const cols = side === 'pitchers' ? PIT_COLS : HIT_COLS
  const handOpts = side === 'pitchers' ? F_HAND_PIT : F_HAND_HIT

  const rows = useMemo(() => {
    const list = [...(data?.players || [])]
    list.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (av == null) return 1
      if (bv == null) return -1
      return sortDir === 'desc' ? bv - av : av - bv
    })
    return list
  }, [data, sortKey, sortDir])

  const toggleSort = (k) => {
    if (sortKey === k) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(k); setSortDir('desc') }
  }

  return (
    <div className="max-w-full mx-auto px-3 sm:px-5 py-5 space-y-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-lg font-bold text-portal-purple-dark dark:text-gray-100">Splits Explorer</h1>
          <div className="inline-flex rounded-lg overflow-hidden border border-gray-300">
            {['hitters', 'pitchers'].map(s => (
              <button key={s} onClick={() => setSide(s)}
                className={`px-3 py-1.5 text-sm font-medium capitalize ${side === s ? 'bg-portal-purple text-portal-cream' : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
                {s}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-lg overflow-hidden border border-gray-300">
            {[['players', 'Players'], ['counts', 'Count grid']].map(([v, label]) => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 text-sm font-medium ${view === v ? 'bg-nw-teal text-white' : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={teamId ?? ''} onChange={(e) => setTeamId(Number(e.target.value))}
            className="px-2.5 py-1.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal min-w-[200px]">
            <option value="">Pick a team...</option>
            {teamOptions.map(t => <option key={t.id} value={t.id}>{t.short_name || t.name}</option>)}
          </select>
          <Select value={baseState} onChange={setBaseState} options={F_BASE} />
          <Select value={handedness} onChange={setHandedness} options={handOpts} />
          <Select value={venue} onChange={setVenue} options={F_VENUE} />
          <Select value={timing} onChange={setTiming} options={F_TIMING} />
          {view === 'players' && <Select value={count} onChange={setCount} options={F_COUNT} />}
          {side === 'hitters' && <Select value={entry} onChange={setEntry} options={F_ENTRY} />}
          {view === 'players' && (
            <label className="text-xs text-gray-500 flex items-center gap-1">
              min <input type="number" min="1" value={minPa} onChange={(e) => setMinPa(Math.max(1, Number(e.target.value) || 1))}
                className="w-14 px-2 py-1 rounded border border-gray-300 text-sm" />
            </label>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-x-auto">
        {view === 'counts' ? (
          gridLoading && !gridData
            ? <p className="text-sm text-gray-500 italic p-4">Loading count grid...</p>
            : <CountGrid data={gridData} side={side} />
        ) : loading && !data ? (
          <p className="text-sm text-gray-500 italic p-4">Loading splits...</p>
        ) : !rows.length ? (
          <p className="text-sm text-gray-500 italic p-4">No players match these filters (try lowering the min sample).</p>
        ) : (
          <table className="w-full text-sm tabular-nums whitespace-nowrap">
            <thead className="bg-gray-50 dark:bg-gray-900/40 text-[11px] uppercase text-gray-500 sticky top-0">
              <tr>
                <th className="text-left font-semibold px-3 py-2">Player</th>
                {cols.map(([k, label]) => (
                  <th key={k} onClick={() => toggleSort(k)}
                    className="px-2 py-2 text-right font-semibold cursor-pointer hover:text-nw-teal select-none">
                    {label}{sortKey === k ? (sortDir === 'desc' ? ' ▾' : ' ▴') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(p => (
                <tr key={p.player_id} className="border-t border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="text-left px-3 py-1.5">
                    <Link to={`/players/${p.player_id}`} className="font-medium text-portal-purple-dark dark:text-gray-100 hover:underline">{p.name}</Link>
                    <span className="text-[11px] text-gray-400 ml-1.5">{p.position}{(p.bats || p.throws) ? ` · ${side === 'pitchers' ? p.throws : p.bats}` : ''}</span>
                  </td>
                  {cols.map(([k, , fmt]) => <td key={k} className="px-2 py-1.5 text-right text-gray-700 dark:text-gray-200">{fmt(p[k])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-[11px] text-gray-400 px-1">
        From play-by-play. {view === 'counts'
          ? 'Count grid measures swing/contact/whiff/strike rates AT each ball-strike count (pitch-by-pitch), for the whole team under the filters above.'
          : '"Off the bench" flags players whose first plate appearance of a game came after the 3rd inning (a pinch-hit / late-sub proxy).'}
      </p>
    </div>
  )
}
