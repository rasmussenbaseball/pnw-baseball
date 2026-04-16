import { useState, useMemo } from 'react'
import { useTeams, useDivisions, useOpponentTrends } from '../hooks/useApi'
import { Link } from 'react-router-dom'

const SEASON = 2026

// ═══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════

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
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Opponent Trends</h1>
        <p className="text-sm text-gray-500 mt-1">
          Lineup tendencies, rotation patterns, and bullpen usage — weighted toward recent games
        </p>
      </div>

      {/* Team Selector */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-6">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Division</label>
            <select value={divisionId} onChange={e => { setDivisionId(e.target.value); setSelectedTeamId(null) }}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm">
              <option value="">All Divisions</option>
              {(divisions || []).map(d => <option key={d.id} value={d.id}>{d.level}</option>)}
            </select>
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs text-gray-500 block mb-1">Select Team to Scout</label>
            <select value={selectedTeamId || ''} onChange={e => setSelectedTeamId(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm">
              <option value="">Choose a team...</option>
              {sortedTeams.map(t => (
                <option key={t.id} value={t.id}>{t.short_name || t.name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Loading / Error / Empty states */}
      {!selectedTeamId && (
        <div className="text-center py-20 text-gray-400">
          <div className="text-5xl mb-3">🔍</div>
          <div className="text-lg font-medium">Select a team to scout</div>
          <div className="text-sm mt-1">Choose a team above to see their tendencies and patterns</div>
        </div>
      )}

      {selectedTeamId && loading && (
        <div className="text-center py-20 text-gray-400">
          <div className="animate-spin text-3xl mb-3">⏳</div>
          <div className="text-sm">Analyzing opponent data...</div>
        </div>
      )}

      {error && (
        <div className="text-center py-10 text-red-500 text-sm">{error}</div>
      )}

      {/* Main content */}
      {data && data.games_analyzed > 0 && (
        <div>
          {/* Team header */}
          <div className="flex items-center gap-3 mb-4">
            {data.team.logo_url && (
              <img src={data.team.logo_url} alt="" className="w-10 h-10 object-contain" />
            )}
            <div>
              <h2 className="text-lg font-bold text-gray-900">{data.team.short_name || data.team.name}</h2>
              <span className="text-xs text-gray-500">{data.games_analyzed} games analyzed · {data.team.conf_abbrev || data.team.conference_name} · {data.team.division_level}</span>
            </div>
          </div>

          {/* Tab navigation */}
          <div className="flex gap-1 mb-5 bg-gray-100 rounded-lg p-1 w-fit">
            {[
              { id: 'lineups', label: 'Lineups' },
              { id: 'pitching', label: 'Pitching' },
            ].map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors
                  ${activeTab === tab.id
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'}`}>
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === 'lineups' && <LineupsTab data={data.lineup_trends} />}
          {activeTab === 'pitching' && <PitchingTab data={data.pitching_trends} />}
        </div>
      )}

      {data && data.games_analyzed === 0 && (
        <div className="text-center py-20 text-gray-400">
          <div className="text-lg font-medium">No game data available</div>
          <div className="text-sm mt-1">This team has no final games recorded this season</div>
        </div>
      )}
    </div>
  )
}


// ═══════════════════════════════════════════════════════════
// LINEUPS TAB
// ═══════════════════════════════════════════════════════════

function LineupsTab({ data }) {
  const [handView, setHandView] = useState('vs_all')

  if (!data) return null

  const lineupData = data[handView] || data.vs_all

  return (
    <div className="space-y-6">
      {/* Hand toggle */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        {[
          { id: 'vs_all', label: `All (${data.vs_all?.games_count || 0})` },
          { id: 'vs_rhp', label: `vs RHP (${data.vs_rhp?.games_count || 0})` },
          { id: 'vs_lhp', label: `vs LHP (${data.vs_lhp?.games_count || 0})` },
        ].map(opt => (
          <button key={opt.id} onClick={() => setHandView(opt.id)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors
              ${handView === opt.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'}`}>
            {opt.label}
          </button>
        ))}
      </div>

      {/* Lineup grid */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="text-sm font-bold text-gray-900">Typical Lineup</h3>
          <p className="text-[10px] text-gray-400 mt-0.5">Weighted toward recent games · Top 3 most frequent players per spot</p>
        </div>
        <div className="divide-y divide-gray-50">
          {(lineupData?.lineup_spots || []).map(spot => (
            <div key={spot.spot} className="flex items-center gap-3 px-4 py-2.5">
              <div className="w-7 h-7 rounded-full bg-gray-900 text-white flex items-center justify-center text-xs font-bold shrink-0">
                {spot.spot}
              </div>
              <div className="text-[10px] text-gray-400 font-medium w-8 shrink-0">{spot.primary_position}</div>
              <div className="flex-1 min-w-0">
                {(spot.most_common || []).map((p, i) => (
                  <div key={i} className={`flex items-center gap-2 ${i > 0 ? 'mt-0.5' : ''}`}>
                    <span className={`text-sm ${i === 0 ? 'font-semibold text-gray-900' : 'text-gray-500'}`}>
                      {p.player_name}
                    </span>
                    <span className={`text-xs ${i === 0 ? 'text-teal-600 font-medium' : 'text-gray-400'}`}>
                      {p.weighted_pct}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bench Usage */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Pinch Hitters */}
        <BenchCard title="Pinch Hitters" items={data.pinch_hitters} emptyText="No pinch hitters recorded"
          renderItem={(p) => (
            <div className="flex items-center justify-between py-1.5">
              <div>
                <span className="text-sm font-medium text-gray-900">{p.player_name}</span>
                <span className="text-xs text-gray-400 ml-1.5">{p.appearances} app</span>
              </div>
              <div className="text-right">
                <span className="text-sm font-bold text-gray-900">
                  {p.avg != null ? p.avg.toFixed(3).replace(/^0/, '') : '—'}
                </span>
                <span className="text-[10px] text-gray-400 ml-1">
                  {p.hits}-{p.at_bats}
                </span>
              </div>
            </div>
          )} />

        {/* Pinch Runners */}
        <BenchCard title="Pinch Runners" items={data.pinch_runners} emptyText="No pinch runners recorded"
          renderItem={(p) => (
            <div className="flex items-center justify-between py-1.5">
              <div>
                <span className="text-sm font-medium text-gray-900">{p.player_name}</span>
                <span className="text-xs text-gray-400 ml-1.5">{p.appearances} app</span>
              </div>
              <div className="text-right text-xs text-gray-600">
                {p.stolen_bases} SB · {p.runs} R
              </div>
            </div>
          )} />

        {/* Defensive Replacements */}
        <BenchCard title="Defensive Subs" items={data.defensive_replacements} emptyText="No defensive subs recorded"
          renderItem={(p) => (
            <div className="flex items-center justify-between py-1.5">
              <div>
                <span className="text-sm font-medium text-gray-900">{p.player_name}</span>
                <span className="text-xs text-gray-400 ml-1.5">{p.appearances} app</span>
              </div>
              <div className="text-xs text-gray-500">
                {(p.positions || []).join(', ')}
              </div>
            </div>
          )} />
      </div>
    </div>
  )
}

function BenchCard({ title, items, emptyText, renderItem }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <h4 className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">{title}</h4>
      {(!items || items.length === 0) ? (
        <p className="text-xs text-gray-400 py-2">{emptyText}</p>
      ) : (
        <div className="divide-y divide-gray-50">
          {items.slice(0, 6).map((item, i) => (
            <div key={i}>{renderItem(item)}</div>
          ))}
        </div>
      )}
    </div>
  )
}


// ═══════════════════════════════════════════════════════════
// PITCHING TAB
// ═══════════════════════════════════════════════════════════

function PitchingTab({ data }) {
  const [pitchingView, setPitchingView] = useState('rotation')

  if (!data) return null

  return (
    <div className="space-y-6">
      {/* Sub-nav */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        {[
          { id: 'rotation', label: 'Starting Rotation' },
          { id: 'bullpen', label: 'Bullpen' },
        ].map(opt => (
          <button key={opt.id} onClick={() => setPitchingView(opt.id)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors
              ${pitchingView === opt.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'}`}>
            {opt.label}
          </button>
        ))}
      </div>

      {pitchingView === 'rotation' && <RotationSection data={data} />}
      {pitchingView === 'bullpen' && <BullpenSection relievers={data.relievers} />}
    </div>
  )
}


// ── Rotation Section ─────────────────────────────────────

function RotationSection({ data }) {
  const { starters, predicted_rotation } = data

  return (
    <div className="space-y-5">
      {/* Predicted rotation */}
      {predicted_rotation && predicted_rotation.length > 0 && (
        <div className="bg-gradient-to-r from-teal-50 to-cyan-50 rounded-xl border border-teal-200 p-4">
          <h3 className="text-sm font-bold text-teal-900 mb-3">Projected Next Series Rotation</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {predicted_rotation.map(p => (
              <div key={p.game_number} className="bg-white rounded-lg p-3 shadow-sm">
                <div className="text-[10px] text-gray-400 font-medium">Game {p.game_number}</div>
                <div className="text-sm font-bold text-gray-900 mt-0.5">{p.likely_starter}</div>
                <div className="flex items-center gap-2 mt-1">
                  {p.throws && (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      p.throws === 'L' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'
                    }`}>{p.throws}HP</span>
                  )}
                  <span className="text-[10px] text-gray-500">
                    {Math.round(p.confidence * 100)}% confidence
                  </span>
                </div>
                {p.avg_ip != null && (
                  <div className="text-[10px] text-gray-400 mt-1">Avg {p.avg_ip} IP</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Individual starter cards */}
      <div className="space-y-3">
        {starters.map((sp, idx) => (
          <StarterCard key={idx} starter={sp} />
        ))}
        {starters.length === 0 && (
          <div className="text-center py-10 text-gray-400 text-sm">No starting pitchers with 2+ starts found</div>
        )}
      </div>
    </div>
  )
}

function StarterCard({ starter }) {
  const [expanded, setExpanded] = useState(false)

  const slotEntries = Object.entries(starter.game_slot_distribution || {}).sort((a, b) => Number(a[0]) - Number(b[0]))
  const totalSlots = slotEntries.reduce((sum, [, v]) => sum + v, 0)

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="p-4 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-gray-900">{starter.player_name}</span>
                {starter.throws && (
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                    starter.throws === 'L' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'
                  }`}>{starter.throws}HP</span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-500">
                <span>{starter.starts} starts</span>
                <span>{starter.record}</span>
                <span>{starter.era != null ? `${starter.era} ERA` : ''}</span>
                <span>Avg {starter.avg_ip} IP</span>
                <span>{starter.quality_starts} QS</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {/* Game slot bars */}
            <div className="hidden md:flex items-center gap-1">
              {slotEntries.map(([slot, count]) => (
                <div key={slot} className="text-center">
                  <div className="text-[10px] text-gray-400">G{slot}</div>
                  <div className="w-8 bg-gray-100 rounded-full overflow-hidden mt-0.5" style={{ height: '20px' }}>
                    <div className="bg-teal-500 rounded-full w-full" style={{ height: `${Math.max((count / totalSlots) * 100, 15)}%`, marginTop: 'auto' }} />
                  </div>
                  <div className="text-[10px] font-medium text-gray-700">{count}</div>
                </div>
              ))}
            </div>
            <span className="text-gray-400 text-sm">{expanded ? '▲' : '▼'}</span>
          </div>
        </div>
      </div>

      {expanded && starter.recent_starts && starter.recent_starts.length > 0 && (
        <div className="border-t border-gray-100 px-4 py-3">
          <h4 className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">Recent Starts</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 border-b border-gray-50">
                  <th className="text-left py-1 font-medium">Date</th>
                  <th className="text-left py-1 font-medium">Opp</th>
                  <th className="text-center py-1 font-medium">G#</th>
                  <th className="text-center py-1 font-medium">IP</th>
                  <th className="text-center py-1 font-medium">K</th>
                  <th className="text-center py-1 font-medium">ER</th>
                  <th className="text-center py-1 font-medium">Dec</th>
                  <th className="text-center py-1 font-medium">GS</th>
                  <th className="text-center py-1 font-medium">PC</th>
                </tr>
              </thead>
              <tbody>
                {[...starter.recent_starts].reverse().map((s, i) => (
                  <tr key={i} className="border-b border-gray-50 last:border-0">
                    <td className="py-1.5 text-gray-600">{formatDate(s.date)}</td>
                    <td className="py-1.5 font-medium text-gray-900">{s.opponent}</td>
                    <td className="py-1.5 text-center text-gray-500">G{s.series_game}</td>
                    <td className="py-1.5 text-center font-medium">{s.ip}</td>
                    <td className="py-1.5 text-center">{s.k}</td>
                    <td className="py-1.5 text-center">{s.er}</td>
                    <td className="py-1.5 text-center">
                      {s.decision && (
                        <span className={`font-bold ${s.decision === 'W' ? 'text-green-600' : s.decision === 'L' ? 'text-red-500' : 'text-gray-500'}`}>
                          {s.decision}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-center text-gray-500">{s.game_score || '—'}</td>
                    <td className="py-1.5 text-center text-gray-500">{s.pitches || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}


// ── Bullpen Section ─────────────────────────────────────

function BullpenSection({ relievers }) {
  const closers = relievers.filter(r => r.role === 'closer')
  const multiInning = relievers.filter(r => r.role === 'multi_inning')
  const oneInning = relievers.filter(r => r.role === 'one_inning')

  return (
    <div className="space-y-5">
      {/* Bullpen overview cards */}
      <div className="grid grid-cols-3 gap-3">
        <StatBox label="Closers" value={closers.length} />
        <StatBox label="Multi-Inning" value={multiInning.length} />
        <StatBox label="One-Inning" value={oneInning.length} />
      </div>

      {/* Reliever groups */}
      {closers.length > 0 && (
        <RelieverGroup title="Closers" subtitle="Primary save options" relievers={closers} />
      )}
      {multiInning.length > 0 && (
        <RelieverGroup title="Multi-Inning Relievers" subtitle="Avg 1.5+ IP per appearance" relievers={multiInning} />
      )}
      {oneInning.length > 0 && (
        <RelieverGroup title="One-Inning Relievers" subtitle="Typically used for single innings" relievers={oneInning} />
      )}
      {relievers.length === 0 && (
        <div className="text-center py-10 text-gray-400 text-sm">No relievers with 2+ appearances found</div>
      )}
    </div>
  )
}

function RelieverGroup({ title, subtitle, relievers }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100">
        <h4 className="text-sm font-bold text-gray-900">{title}</h4>
        {subtitle && <p className="text-[10px] text-gray-400">{subtitle}</p>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-400 border-b border-gray-100 bg-gray-50">
              <th className="text-left px-4 py-2 font-medium">Pitcher</th>
              <th className="text-center px-2 py-2 font-medium">T</th>
              <th className="text-center px-2 py-2 font-medium">App</th>
              <th className="text-center px-2 py-2 font-medium">Avg IP</th>
              <th className="text-center px-2 py-2 font-medium">ERA</th>
              <th className="text-center px-2 py-2 font-medium">K</th>
              <th className="text-center px-2 py-2 font-medium">BB</th>
              <th className="text-center px-2 py-2 font-medium">SV</th>
              <th className="text-center px-2 py-2 font-medium">Close%</th>
              <th className="text-center px-2 py-2 font-medium">Multi IP</th>
            </tr>
          </thead>
          <tbody>
            {relievers.map((r, i) => (
              <RelieverRow key={i} reliever={r} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function RelieverRow({ reliever }) {
  const [expanded, setExpanded] = useState(false)
  const r = reliever

  return (
    <>
      <tr className="border-b border-gray-50 cursor-pointer hover:bg-gray-50"
          onClick={() => setExpanded(!expanded)}>
        <td className="px-4 py-2 font-medium text-gray-900">{r.player_name}</td>
        <td className="text-center px-2 py-2">
          {r.throws && (
            <span className={`text-[10px] font-bold px-1 py-0.5 rounded ${
              r.throws === 'L' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'
            }`}>{r.throws}</span>
          )}
        </td>
        <td className="text-center px-2 py-2">{r.appearances}</td>
        <td className="text-center px-2 py-2">{r.avg_ip}</td>
        <td className="text-center px-2 py-2 font-medium">{r.era != null ? r.era : '—'}</td>
        <td className="text-center px-2 py-2">{r.total_k}</td>
        <td className="text-center px-2 py-2">{r.total_bb}</td>
        <td className="text-center px-2 py-2 font-bold">{r.saves || '—'}</td>
        <td className="text-center px-2 py-2">{r.close_game_pct}%</td>
        <td className="text-center px-2 py-2">{r.multi_inning_apps}</td>
      </tr>
      {expanded && r.recent_appearances && r.recent_appearances.length > 0 && (
        <tr>
          <td colSpan={10} className="bg-gray-50 px-4 py-2">
            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Recent Appearances</div>
            <div className="flex flex-wrap gap-2">
              {[...r.recent_appearances].reverse().map((a, i) => (
                <div key={i} className="bg-white rounded px-2 py-1 text-[11px] border border-gray-200">
                  <span className="text-gray-500">{formatDate(a.date)}</span>
                  <span className="font-medium ml-1">{a.opponent}</span>
                  <span className="text-gray-400 ml-1">{a.ip} IP</span>
                  <span className="text-gray-400 ml-1">{a.k}K</span>
                  {a.er > 0 && <span className="text-red-500 ml-1">{a.er}ER</span>}
                  {a.decision && (
                    <span className={`ml-1 font-bold ${a.decision === 'S' ? 'text-green-600' : a.decision === 'W' ? 'text-green-600' : a.decision === 'L' ? 'text-red-500' : ''}`}>
                      {a.decision}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}


// ═══════════════════════════════════════════════════════════
// SHARED COMPONENTS
// ═══════════════════════════════════════════════════════════

function StatBox({ label, value }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      <div className="text-[10px] text-gray-500 font-medium mt-0.5">{label}</div>
    </div>
  )
}

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T12:00:00')
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch {
    return dateStr
  }
}
