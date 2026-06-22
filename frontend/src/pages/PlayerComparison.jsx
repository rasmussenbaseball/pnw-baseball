// Player Comparison (Coaching tool) — pick up to 5 players and compare their
// hitting, pitching, and fielding side by side. The per-row leader is starred,
// and rate/advanced stats are colored green/red vs the player's division league
// average. Toggle between the current season and career totals.

import { useState, useMemo } from 'react'
import { useApi } from '../hooks/useApi'
import { CURRENT_SEASON } from '../lib/seasons'

const MAX = 5

// [key, label, format, lowerIsBetter]
const HIT_ROWS = [
  ['plate_appearances', 'PA', 'int', false],
  ['batting_avg', 'AVG', 'avg', false],
  ['on_base_pct', 'OBP', 'avg', false],
  ['slugging_pct', 'SLG', 'avg', false],
  ['ops', 'OPS', 'avg', false],
  ['home_runs', 'HR', 'int', false],
  ['rbi', 'RBI', 'int', false],
  ['stolen_bases', 'SB', 'int', false],
  ['iso', 'ISO', 'avg', false],
  ['bb_pct', 'BB%', 'pct', false],
  ['k_pct', 'K%', 'pct', true],
  ['woba', 'wOBA', 'avg', false],
  ['wrc_plus', 'wRC+', 'int', false],
  ['offensive_war', 'oWAR', 'war', false],
]
const PIT_ROWS = [
  ['innings_pitched', 'IP', 'ip', false],
  ['wins', 'W', 'int', false],
  ['saves', 'SV', 'int', false],
  ['era', 'ERA', 'era', true],
  ['whip', 'WHIP', 'era', true],
  ['k_pct', 'K%', 'pct', false],
  ['bb_pct', 'BB%', 'pct', true],
  ['k_bb_pct', 'K-BB%', 'pct', false],
  ['baa', 'BAA', 'avg', true],
  ['k_per_9', 'K/9', 'rate', false],
  ['fip', 'FIP', 'era', true],
  ['fip_plus', 'FIP+', 'int', false],
  ['pitching_war', 'pWAR', 'war', false],
]
const FLD_ROWS = [
  ['fielding_pct', 'FLD%', 'avg', false],
  ['putouts', 'PO', 'int', false],
  ['assists', 'A', 'int', false],
  ['errors', 'E', 'int', true],
  ['double_plays', 'DP', 'int', false],
]
// Catcher-only rows (shown when any selected player has caught).
const CATCHER_ROWS = [
  ['caught_stealing_by', 'CS', 'int', false],
  ['stolen_bases_against', 'SBA', 'int', true],
  ['cs_pct', 'CS%', 'pct', false],
  ['passed_balls', 'PB', 'int', true],
]
// Play-by-play discipline (season only). 5th element = neutral (no leader/color
// for descriptive rates that aren't clearly better/worse).
const PBP_HIT_ROWS = [
  ['swing_pct', 'Swing%', 'pct', false, true],
  ['contact_pct', 'Contact%', 'pct', false, false],
  ['whiff_pct', 'Whiff%', 'pct', true, false],
  ['putaway_pct', 'Putaway%', 'pct', true, false],
  ['air_pull_pct', 'AirPull%', 'pct', false, false],
  ['first_pitch_strike_pct', '1P-Str%', 'pct', false, true],
  ['gb_pct', 'GB%', 'pct', false, true],
  ['fb_pct', 'FB%', 'pct', false, true],
  ['ld_pct', 'LD%', 'pct', false, true],
  ['pitches_per_pa', 'P/PA', 'rate', false, true],
]
const PBP_PIT_ROWS = [
  ['whiff_pct', 'Whiff%', 'pct', false, false],
  ['strike_pct', 'Strike%', 'pct', false, false],
  ['called_strike_pct', 'CStr%', 'pct', false, true],
  ['first_pitch_strike_pct', '1P-Str%', 'pct', false, false],
  ['putaway_pct', 'Putaway%', 'pct', false, false],
  ['gb_pct', 'GB%', 'pct', false, true],
  ['opp_air_pull_pct', 'Opp AirPull%', 'pct', true, false],
]

function fmt(format, v) {
  if (v == null || v === '') return '—'
  const n = Number(v)
  switch (format) {
    case 'int':  return Math.round(n).toString()
    case 'avg':  return n.toFixed(3).replace(/^0\./, '.').replace(/^-0\./, '-.')
    case 'pct':  return `${(n * 100).toFixed(1)}%`
    case 'era':  return n.toFixed(2)
    case 'rate': return n.toFixed(2)
    case 'war':  return n.toFixed(1)
    case 'ip':   return n.toFixed(1)
    default:     return String(v)
  }
}

export default function PlayerComparison() {
  const [selected, setSelected] = useState([])   // [{id, name, team_short}]
  const [mode, setMode] = useState('season')      // 'season' | 'career'
  const [query, setQuery] = useState('')

  const ids = selected.map(p => p.id).join(',')
  const { data, loading } = useApi(ids ? '/players/compare' : null,
    { ids, mode, season: CURRENT_SEASON }, [ids, mode])
  const { data: results } = useApi(query.trim().length >= 2 ? '/players/search' : null,
    { q: query.trim(), limit: 8 }, [query])

  const players = data?.players || []
  const leagueAvgs = data?.league_averages || { batting: {}, pitching: {} }

  // Per-player overall fielding totals (sum across positions), for comparable rows.
  const fielding = useMemo(() => players.map(p => {
    const t = { putouts: 0, assists: 0, errors: 0, double_plays: 0,
                caught_stealing_by: 0, stolen_bases_against: 0, passed_balls: 0, has: false }
    for (const f of (p.fielding || [])) {
      t.putouts += f.putouts || 0; t.assists += f.assists || 0
      t.errors += f.errors || 0; t.double_plays += f.double_plays || 0
      t.caught_stealing_by += f.caught_stealing_by || 0
      t.stolen_bases_against += f.stolen_bases_against || 0
      t.passed_balls += f.passed_balls || 0; t.has = true
    }
    const tc = t.putouts + t.assists + t.errors
    t.fielding_pct = tc ? (t.putouts + t.assists) / tc : null
    const csa = t.caught_stealing_by + t.stolen_bases_against
    t.cs_pct = csa ? t.caught_stealing_by / csa : null
    return t.has ? t : {}
  }), [players])

  const addPlayer = (p) => {
    if (selected.length >= MAX || selected.some(s => s.id === p.id)) return
    setSelected([...selected, { id: p.id, name: `${p.first_name} ${p.last_name}`, team_short: p.team_short }])
    setQuery('')
  }
  const removePlayer = (id) => setSelected(selected.filter(s => s.id !== id))

  const valOf = (p, i, group, key) =>
    group === 'fielding' ? (fielding[i] ? fielding[i][key] : null) : (p[group] ? p[group][key] : null)

  // Renders one stat row across all player columns.
  const Row = ({ group, def }) => {
    const [key, label, format, lower, neutral] = def
    const vals = players.map((p, i) => {
      const v = valOf(p, i, group, key)
      return v == null || v === '' ? null : Number(v)
    })
    const present = vals.filter(v => v != null)
    const best = (!neutral && present.length) ? (lower ? Math.min(...present) : Math.max(...present)) : null
    return (
      <tr className="border-b border-gray-100 dark:border-gray-700/60">
        <td className="sticky left-0 z-10 bg-gray-50 dark:bg-gray-900 px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap">{label}</td>
        {players.map((p, i) => {
          const v = vals[i]
          const isLeader = !neutral && v != null && v === best && players.length > 1
          const avg = neutral ? null : leagueAvgs[group]?.[p.division_level]?.[key]
          let cls = 'text-gray-800 dark:text-gray-100'
          if (v != null && avg != null) {
            const better = lower ? v < avg : v > avg
            cls = better ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'
          }
          return (
            <td key={p.id} className={`px-3 py-1.5 text-sm text-center tabular-nums ${cls} ${isLeader ? 'bg-amber-50 dark:bg-amber-900/30 font-bold' : ''}`}>
              {isLeader && <span className="text-amber-500 mr-0.5">★</span>}
              {fmt(format, valOf(p, i, group, key))}
            </td>
          )
        })}
      </tr>
    )
  }

  const SectionHead = ({ title }) => (
    <tr className="bg-nw-teal/10 dark:bg-teal-900/30">
      <td className="sticky left-0 z-10 bg-nw-teal/10 dark:bg-teal-900/30 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-nw-teal dark:text-teal-300">{title}</td>
      {players.map(p => <td key={p.id} className="bg-nw-teal/10 dark:bg-teal-900/30" />)}
    </tr>
  )

  const anyBatting = players.some(p => p.batting)
  const anyPitching = players.some(p => p.pitching)
  const anyFielding = fielding.some(f => f.has)
  const anyCatcher = fielding.some(f => (f.caught_stealing_by || 0) + (f.stolen_bases_against || 0) + (f.passed_balls || 0) > 0)
  const anyBattingPbp = mode === 'season' && players.some(p => p.batting_pbp)
  const anyPitchingPbp = mode === 'season' && players.some(p => p.pitching_pbp)

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">Player Comparison</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Compare up to {MAX} players side by side. <span className="text-amber-500">★</span> marks the leader in each
        category; rate stats are <span className="text-emerald-600 dark:text-emerald-400">green</span> above /
        <span className="text-rose-500 dark:text-rose-400"> red</span> below their division average.
      </p>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-3 mb-4">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          {/* Search */}
          <div className="relative flex-1 min-w-[220px]">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={selected.length >= MAX ? `Max ${MAX} players selected` : 'Search a player to add…'}
              disabled={selected.length >= MAX}
              className="w-full rounded border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-3 py-1.5 text-sm"
            />
            {query.trim().length >= 2 && (results?.length > 0) && (
              <div className="absolute z-30 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-72 overflow-auto">
                {results.map(r => {
                  const taken = selected.some(s => s.id === r.id)
                  return (
                    <button key={r.id} type="button" onClick={() => addPlayer(r)} disabled={taken}
                      className={`w-full text-left px-3 py-1.5 text-sm flex items-center justify-between hover:bg-teal-50 dark:hover:bg-teal-900/40 ${taken ? 'opacity-40' : ''}`}>
                      <span>{r.first_name} {r.last_name}</span>
                      <span className="text-xs text-gray-400">{r.team_short} · {r.division_level}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          {/* Season / Career toggle */}
          <div className="inline-flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden text-sm">
            {['season', 'career'].map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-3 py-1.5 font-semibold ${mode === m ? 'bg-nw-teal text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300'}`}>
                {m === 'season' ? CURRENT_SEASON : 'Career'}
              </button>
            ))}
          </div>
        </div>
        {/* Selected chips */}
        <div className="flex flex-wrap gap-2">
          {selected.map(s => (
            <span key={s.id} className="inline-flex items-center gap-1.5 rounded-full bg-nw-teal/10 dark:bg-teal-900/40 text-nw-teal dark:text-teal-200 px-2.5 py-1 text-xs font-medium">
              {s.name} <span className="text-gray-400">{s.team_short}</span>
              <button onClick={() => removePlayer(s.id)} className="text-gray-400 hover:text-rose-500" aria-label="Remove">✕</button>
            </span>
          ))}
          {selected.length === 0 && <span className="text-xs text-gray-400">No players selected yet.</span>}
        </div>
      </div>

      {/* Comparison table */}
      {selected.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-10 text-center text-gray-400">
          Search and add players to compare them side by side.
        </div>
      ) : loading ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-10 text-center text-gray-400 animate-pulse">Loading…</div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-200 dark:border-gray-700">
                <th className="sticky left-0 z-10 bg-white dark:bg-gray-800 px-3 py-2 text-left text-xs text-gray-400 font-semibold w-32">Player</th>
                {players.map(p => (
                  <th key={p.id} className="px-3 py-2 text-center align-top min-w-[140px]">
                    <div className="flex flex-col items-center gap-0.5">
                      {p.logo_url && <img src={p.logo_url} alt="" className="w-7 h-7 object-contain mb-0.5" />}
                      <span className="text-sm font-bold text-nw-teal dark:text-gray-100 leading-tight">{p.first_name} {p.last_name}</span>
                      <span className="text-[11px] text-gray-500 dark:text-gray-400">{p.team_short} · {p.division_level}</span>
                      <span className="text-[10px] text-gray-400">
                        {(p.positions || []).length
                          ? p.positions.map(x => `${x.position} ${x.percentage}%`).join(' / ')
                          : (p.primary_position || '')}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {p.bats || '?'}/{p.throws || '?'}{p.year_in_school ? ` · ${p.year_in_school}` : ''}
                      </span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {anyBatting && <><SectionHead title="Hitting" />{HIT_ROWS.map(def => <Row key={def[0]} group="batting" def={def} />)}</>}
              {anyBattingPbp && <><SectionHead title="Plate Discipline (PBP)" />{PBP_HIT_ROWS.map(def => <Row key={'bpbp_' + def[0]} group="batting_pbp" def={def} />)}</>}
              {anyPitching && <><SectionHead title="Pitching" />{PIT_ROWS.map(def => <Row key={def[0]} group="pitching" def={def} />)}</>}
              {anyPitchingPbp && <><SectionHead title="Pitching — PBP" />{PBP_PIT_ROWS.map(def => <Row key={'ppbp_' + def[0]} group="pitching_pbp" def={def} />)}</>}
              {anyFielding && <><SectionHead title="Fielding (all positions)" />{FLD_ROWS.map(def => <Row key={def[0]} group="fielding" def={def} />)}</>}
              {anyCatcher && <><SectionHead title="Catching" />{CATCHER_ROWS.map(def => <Row key={'c_' + def[0]} group="fielding" def={def} />)}</>}
            </tbody>
          </table>
        </div>
      )}
      {mode === 'career' && selected.length > 0 && (
        <p className="text-[11px] text-gray-400 mt-2">Career = all seasons in our database, summed (rates recomputed). Above/below coloring uses the current-season division average. Play-by-play stats are season-only, so they show in the {CURRENT_SEASON} view.</p>
      )}
    </div>
  )
}
