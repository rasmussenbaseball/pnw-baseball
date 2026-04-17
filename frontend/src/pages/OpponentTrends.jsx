import { useState, useMemo } from 'react'
import { useTeams, useDivisions, useOpponentTrends } from '../hooks/useApi'

const SEASON = 2026

export default function OpponentTrends() {
  const [divisionId, setDivisionId] = useState('')
  const [selectedTeamId, setSelectedTeamId] = useState(null)
  const [activeTab, setActiveTab] = useState('lineups')

  const { data: divisions } = useDivisions()
  const { data: teams } = useTeams({ season: SEASON, ...(divisionId && { division_id: divisionId }) })
  const { data, loading, error } = useOpponentTrends(selectedTeamId, SEASON)

  const sortedTeams = useMemo(() => {
    if (!teams) return []
    return [...teams].sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name))
  }, [teams])

  return (
    <div className="max-w-6xl mx-auto px-4 py-5">
      <h1 className="text-xl font-bold text-gray-900 mb-1">Opponent Trends</h1>
      <p className="text-xs text-gray-500 mb-4">Lineup tendencies, rotation patterns & bullpen usage — weighted toward recent games</p>

      {/* Selectors */}
      <div className="flex flex-wrap gap-2 items-end mb-5">
        <select value={divisionId} onChange={e => { setDivisionId(e.target.value); setSelectedTeamId(null) }}
          className="rounded border border-gray-300 px-2 py-1.5 text-sm">
          <option value="">All Divisions</option>
          {(divisions || []).map(d => <option key={d.id} value={d.id}>{d.level}</option>)}
        </select>
        <select value={selectedTeamId || ''} onChange={e => setSelectedTeamId(e.target.value ? Number(e.target.value) : null)}
          className="rounded border border-gray-300 px-2 py-1.5 text-sm min-w-[200px]">
          <option value="">Choose a team...</option>
          {sortedTeams.map(t => <option key={t.id} value={t.id}>{t.short_name || t.name}</option>)}
        </select>
      </div>

      {!selectedTeamId && <Empty icon="🔍" text="Select a team to scout" />}
      {selectedTeamId && loading && <Empty icon="⏳" text="Analyzing..." spin />}
      {error && <div className="text-red-500 text-sm py-6 text-center">{error}</div>}

      {data && data.games_analyzed > 0 && (
        <>
          {/* Team bar */}
          <div className="flex items-center gap-2 mb-3">
            {data.team.logo_url && <img src={data.team.logo_url} alt="" className="w-8 h-8 object-contain" />}
            <span className="font-bold text-gray-900">{data.team.short_name || data.team.name}</span>
            <span className="text-xs text-gray-400">{data.games_analyzed}G · {data.team.conf_abbrev || data.team.conference_name} · {data.team.division_level}</span>
          </div>

          {/* Tabs */}
          <div className="flex gap-0.5 mb-4 bg-gray-100 rounded-lg p-0.5 w-fit">
            {['lineups', 'pitching'].map(t => (
              <button key={t} onClick={() => setActiveTab(t)}
                className={`px-3 py-1 rounded text-xs font-medium ${activeTab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
                {t === 'lineups' ? 'Lineups' : 'Pitching'}
              </button>
            ))}
          </div>

          {activeTab === 'lineups' && <LineupsTab d={data.lineup_trends} />}
          {activeTab === 'pitching' && <PitchingTab d={data.pitching_trends} />}
        </>
      )}

      {data && data.games_analyzed === 0 && <Empty icon="📊" text="No game data this season" />}
    </div>
  )
}

function Empty({ icon, text, spin }) {
  return (
    <div className="text-center py-16 text-gray-400">
      <div className={`text-3xl mb-2 ${spin ? 'animate-spin' : ''}`}>{icon}</div>
      <div className="text-sm">{text}</div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// LINEUPS TAB
// ═══════════════════════════════════════════════════════════

function LineupsTab({ d }) {
  const [view, setView] = useState('hand')
  if (!d) return null

  return (
    <div className="space-y-4">
      <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5 w-fit">
        {[
          { id: 'hand', label: 'vs RHP / LHP' },
          { id: 'game', label: 'By Game #' },
        ].map(t => (
          <button key={t.id} onClick={() => setView(t.id)}
            className={`px-3 py-1 rounded text-xs font-medium ${view === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {view === 'hand' && (
        <div className="space-y-2">
          <div className="text-[10px] text-gray-400">
            {d.count_vs_rhp || 0} vs RHP · {d.count_vs_lhp || 0} vs LHP · {d.count_vs_unknown || 0} unknown hand
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <LineupTable title={`Projected Lineup vs RHP`} sub={`${d.vs_rhp?.games_count || 0} games (RHP + unknown)`} data={d.vs_rhp} />
            <LineupTable title={`Projected Lineup vs LHP`} sub={`${d.vs_lhp?.games_count || 0} games`} data={d.vs_lhp} accent />
          </div>
        </div>
      )}

      {view === 'game' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map(slot => {
            const gd = d.by_game_number?.[String(slot)]
            if (!gd) return null
            return <LineupTable key={slot} title={`Game ${slot} Lineup`} sub={`${gd.games_count} games`} data={gd} />
          })}
        </div>
      )}

      {/* Bench section - compact row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <MiniTable title="Pinch Hitters" cols={['Name', 'App', 'AB', 'H', 'AVG', 'RBI', 'BB']}
          rows={(d.pinch_hitters || []).slice(0, 8).map(p => [
            p.name, p.apps, p.ab, p.h,
            p.avg != null ? p.avg.toFixed(3).replace(/^0/, '') : '—',
            p.rbi, p.bb
          ])} />
        <MiniTable title="Pinch Runners" cols={['Name', 'App', 'SB', 'CS', 'R']}
          rows={(d.pinch_runners || []).slice(0, 8).map(p => [
            p.name, p.apps, p.sb, p.cs, p.r
          ])} />
      </div>
    </div>
  )
}

function LineupTable({ title, sub, data, accent }) {
  if (!data || !data.lineup) return (
    <div className="bg-white rounded-lg border border-gray-100 p-4 text-center text-gray-400 text-xs">
      {title}: Not enough data
    </div>
  )

  return (
    <div className={`bg-white rounded-lg border ${accent ? 'border-blue-200' : 'border-gray-100'} overflow-hidden`}>
      <div className={`px-3 py-2 ${accent ? 'bg-blue-50 border-b border-blue-100' : 'bg-gray-50 border-b border-gray-100'}`}>
        <span className="text-xs font-bold text-gray-900">{title}</span>
        <span className="text-[10px] text-gray-400 ml-2">{sub}</span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-gray-400 border-b border-gray-50">
            <th className="w-7 py-1 text-center">#</th>
            <th className="w-10 py-1 text-center">Pos</th>
            <th className="py-1 pl-2 text-left">Player</th>
            <th className="w-12 py-1 text-right pr-3">%</th>
          </tr>
        </thead>
        <tbody>
          {data.lineup.map((row, i) => (
            <tr key={i} className="border-b border-gray-50 last:border-0">
              <td className="text-center py-1 font-bold text-gray-400">{row.spot}</td>
              <td className="text-center py-1 text-gray-500 font-medium">{row.position}</td>
              <td className="py-1 pl-2 font-medium text-gray-900">{row.player_name}</td>
              <td className="py-1 text-right pr-3 text-gray-500">{row.pct > 0 ? `${row.pct}%` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.bench && data.bench.length > 0 && (
        <div className="border-t border-gray-100 px-3 py-1.5">
          <span className="text-[10px] text-gray-400 font-medium">Bench: </span>
          <span className="text-[10px] text-gray-600">
            {data.bench.map(b => `${b.player_name} (${b.position || '?'}, ${b.games_started}G)`).join(' · ')}
          </span>
        </div>
      )}
    </div>
  )
}

function MiniTable({ title, cols, rows }) {
  return (
    <div className="bg-white rounded-lg border border-gray-100 overflow-hidden">
      <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100">
        <span className="text-[10px] font-bold text-gray-700 uppercase tracking-wider">{title}</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-2 text-[10px] text-gray-400">None recorded</div>
      ) : (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[10px] text-gray-400">
              {cols.map((c, i) => (
                <th key={i} className={`py-1 px-1.5 font-medium ${i === 0 ? 'text-left pl-3' : 'text-center'}`}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-gray-50">
                {row.map((cell, j) => (
                  <td key={j} className={`py-0.5 px-1.5 ${j === 0 ? 'text-left pl-3 font-medium text-gray-900' : 'text-center text-gray-600'}`}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}


// ═══════════════════════════════════════════════════════════
// PITCHING TAB
// ═══════════════════════════════════════════════════════════

function PitchingTab({ d }) {
  const [view, setView] = useState('rotation')
  if (!d) return null

  return (
    <div className="space-y-4">
      <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5 w-fit">
        {[
          { id: 'rotation', label: 'Rotation' },
          { id: 'bullpen', label: 'Bullpen' },
        ].map(t => (
          <button key={t.id} onClick={() => setView(t.id)}
            className={`px-3 py-1 rounded text-xs font-medium ${view === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {view === 'rotation' && <RotationView d={d} />}
      {view === 'bullpen' && <BullpenView relievers={d.relievers} />}
    </div>
  )
}


function RotationView({ d }) {
  const [expandedStarter, setExpandedStarter] = useState(null)

  return (
    <div className="space-y-4">
      {/* Predicted rotation */}
      {d.predicted_rotation?.length > 0 && (
        <div className="bg-teal-50 rounded-lg border border-teal-200 p-3">
          <div className="text-xs font-bold text-teal-900 mb-2">Projected Rotation (Next Series)</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {d.predicted_rotation.map(p => (
              <div key={p.game} className="bg-white rounded px-2.5 py-2 shadow-sm">
                <div className="text-[10px] text-gray-400">Game {p.game}</div>
                <div className="text-sm font-bold text-gray-900 flex items-center gap-1">
                  {p.name}
                  <Hand t={p.throws} />
                </div>
                <div className="text-[10px] text-gray-500">
                  <span>{p.game_conf}% this game</span>
                  <span className="ml-1">· {p.week_pct}% starts week</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Starters table */}
      <div className="bg-white rounded-lg border border-gray-100 overflow-hidden">
        <div className="px-3 py-2 bg-gray-50 border-b border-gray-100">
          <span className="text-xs font-bold text-gray-900">Starting Pitchers</span>
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-gray-400 border-b border-gray-100">
              <th className="py-1.5 pl-3 text-left">Pitcher</th>
              <th className="py-1.5 text-center">T</th>
              <th className="py-1.5 text-center">GS</th>
              <th className="py-1.5 text-center">Rec</th>
              <th className="py-1.5 text-center">ERA</th>
              <th className="py-1.5 text-center">IP/GS</th>
              <th className="py-1.5 text-center">K</th>
              <th className="py-1.5 text-center">BB</th>
              <th className="py-1.5 text-center">QS</th>
              <th className="py-1.5 pr-3 text-center">G1</th>
              <th className="py-1.5 text-center">G2</th>
              <th className="py-1.5 text-center">G3</th>
              <th className="py-1.5 pr-3 text-center">G4</th>
            </tr>
          </thead>
          <tbody>
            {d.starters.map((sp, i) => (
              <StarterRows key={i} sp={sp} expanded={expandedStarter === i}
                toggle={() => setExpandedStarter(expandedStarter === i ? null : i)} />
            ))}
          </tbody>
        </table>
        {d.starters.length === 0 && <div className="text-center py-4 text-gray-400 text-xs">No starters with 2+ starts</div>}
      </div>
    </div>
  )
}

function StarterRows({ sp, expanded, toggle }) {
  return (
    <>
      <tr className="border-b border-gray-50 cursor-pointer hover:bg-gray-50" onClick={toggle}>
        <td className="py-1.5 pl-3 font-medium text-gray-900">{sp.name}</td>
        <td className="text-center"><Hand t={sp.throws} /></td>
        <td className="text-center">{sp.starts}</td>
        <td className="text-center">{sp.record}</td>
        <td className="text-center font-medium">{sp.era ?? '—'}</td>
        <td className="text-center">{sp.avg_ip}</td>
        <td className="text-center">{sp.k}</td>
        <td className="text-center">{sp.bb}</td>
        <td className="text-center">{sp.qs}</td>
        <td className="text-center pr-1">{sp.slots?.['1'] || '—'}</td>
        <td className="text-center">{sp.slots?.['2'] || '—'}</td>
        <td className="text-center">{sp.slots?.['3'] || '—'}</td>
        <td className="text-center pr-3">{sp.slots?.['4'] || '—'}</td>
      </tr>
      {expanded && sp.recent?.length > 0 && (
        <tr>
          <td colSpan={13} className="bg-gray-50 px-3 py-1.5">
            <div className="text-[10px] font-bold text-gray-400 uppercase mb-1">Recent Starts</div>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[10px] text-gray-400">
                  <th className="text-left py-0.5">Date</th>
                  <th className="text-left py-0.5">Opp</th>
                  <th className="text-center py-0.5">G#</th>
                  <th className="text-center py-0.5">IP</th>
                  <th className="text-center py-0.5">K</th>
                  <th className="text-center py-0.5">ER</th>
                  <th className="text-center py-0.5">Dec</th>
                  <th className="text-center py-0.5">GmSc</th>
                  <th className="text-center py-0.5">PC</th>
                </tr>
              </thead>
              <tbody>
                {[...sp.recent].reverse().map((s, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="py-0.5 text-gray-500">{fmtDate(s.date)}</td>
                    <td className="py-0.5 font-medium">{s.opp}</td>
                    <td className="text-center text-gray-500">G{s.g}</td>
                    <td className="text-center">{s.ip}</td>
                    <td className="text-center">{s.k}</td>
                    <td className="text-center">{s.er}</td>
                    <td className="text-center">
                      {s.dec && <span className={s.dec === 'W' ? 'text-green-600 font-bold' : s.dec === 'L' ? 'text-red-500 font-bold' : ''}>{s.dec}</span>}
                    </td>
                    <td className="text-center text-gray-500">{s.gs || '—'}</td>
                    <td className="text-center text-gray-500">{s.pc || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  )
}


function BullpenView({ relievers }) {
  const [expandedIdx, setExpandedIdx] = useState(null)
  const closers = relievers.filter(r => r.role === 'closer')
  const multi = relievers.filter(r => r.role === 'multi_inning')
  const one = relievers.filter(r => r.role === 'one_inning')
  const mopUp = relievers.filter(r => r.role === 'mop_up')

  const renderGroup = (title, list, startIdx) => {
    if (!list.length) return null
    return (
      <div className="bg-white rounded-lg border border-gray-100 overflow-hidden">
        <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100">
          <span className="text-[10px] font-bold text-gray-700 uppercase tracking-wider">{title}</span>
          <span className="text-[10px] text-gray-400 ml-2">{list.length}</span>
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-gray-400 border-b border-gray-50">
              <th className="py-1 pl-3 text-left">Pitcher</th>
              <th className="py-1 text-center">T</th>
              <th className="py-1 text-center">App</th>
              <th className="py-1 text-center">IP</th>
              <th className="py-1 text-center">IP/A</th>
              <th className="py-1 text-center">ERA</th>
              <th className="py-1 text-center" title="Fielding Independent Pitching (lower is better)">FIP</th>
              <th className="py-1 text-center" title="(K - BB) / Batters Faced">K-BB%</th>
              <th className="py-1 text-center">K</th>
              <th className="py-1 text-center">BB</th>
              <th className="py-1 text-center">SV</th>
              <th className="py-1 text-center pr-3">Leverage%</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => {
              const idx = startIdx + i
              return (
                <RelieverRows key={i} r={r} expanded={expandedIdx === idx}
                  toggle={() => setExpandedIdx(expandedIdx === idx ? null : idx)} />
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {renderGroup('Closers', closers, 0)}
      {renderGroup('Multi-Inning Relievers', multi, 100)}
      {renderGroup('One-Inning Relievers', one, 200)}
      {renderGroup('Mop-Up / Low Usage', mopUp, 300)}
      {relievers.length === 0 && <div className="text-center py-6 text-gray-400 text-xs">No relievers with 2+ appearances</div>}
    </div>
  )
}

function RelieverRows({ r, expanded, toggle }) {
  return (
    <>
      <tr className="border-b border-gray-50 cursor-pointer hover:bg-gray-50" onClick={toggle}>
        <td className="py-1 pl-3 font-medium text-gray-900">
          {r.is_top && <span className="mr-1 text-yellow-500" title="Top reliever on team (rating)">★</span>}
          {r.name}
          <TierPill tier={r.tier} />
        </td>
        <td className="text-center"><Hand t={r.throws} /></td>
        <td className="text-center">{r.apps}</td>
        <td className="text-center">{r.total_ip ?? '—'}</td>
        <td className="text-center">{r.avg_ip}</td>
        <td className="text-center font-medium">{r.era ?? '—'}</td>
        <td className="text-center">{r.fip ?? '—'}</td>
        <td className="text-center">{r.k_bb_pct != null ? r.k_bb_pct + '%' : '—'}</td>
        <td className="text-center">{r.k}</td>
        <td className="text-center">{r.bb}</td>
        <td className="text-center font-bold">{r.saves || '—'}</td>
        <td className="text-center pr-3">{r.leverage_pct}%</td>
      </tr>
      {expanded && r.recent?.length > 0 && (
        <tr>
          <td colSpan={12} className="bg-gray-50 px-3 py-1">
            <div className="flex flex-wrap gap-1.5">
              {[...r.recent].reverse().map((a, i) => (
                <span key={i} className="text-[10px] bg-white border border-gray-200 rounded px-1.5 py-0.5">
                  {fmtDate(a.date)} {a.opp} {a.ip}IP {a.k}K
                  {a.er > 0 && <span className="text-red-500"> {a.er}ER</span>}
                  {a.dec && <span className={a.dec === 'S' ? 'text-green-600 font-bold' : ''}> {a.dec}</span>}
                </span>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ═══════════════════════════════════════════════════════════
// SHARED
// ═══════════════════════════════════════════════════════════

function Hand({ t }) {
  if (!t) return <span className="text-[10px] text-gray-300">?</span>
  return (
    <span className={`text-[10px] font-bold px-1 py-0.5 rounded ${
      t === 'L' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'
    }`}>{t}</span>
  )
}

function TierPill({ tier }) {
  if (!tier || tier === 'small_sample') return null
  const styles = {
    elite: 'bg-green-100 text-green-800',
    solid: 'bg-emerald-50 text-emerald-700',
    average: 'bg-gray-100 text-gray-600',
    struggling: 'bg-red-50 text-red-700',
  }
  const labels = {
    elite: 'Elite',
    solid: 'Solid',
    average: 'Avg',
    struggling: 'Struggling',
  }
  return (
    <span className={`ml-2 text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide ${styles[tier] || 'bg-gray-100 text-gray-500'}`}>
      {labels[tier] || tier}
    </span>
  )
}

function fmtDate(s) {
  try {
    const d = new Date(s + 'T12:00:00')
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return s }
}
