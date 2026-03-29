import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { formatStat, divisionBadgeClass } from '../utils/stats'

const API_BASE = '/api/v1'
const PNW_STATES = ['WA', 'OR', 'ID', 'MT', 'BC']

// Team colors for visual distinction
const TEAM_COLORS = [
  { bg: 'bg-teal-500', text: 'text-teal-700', light: 'bg-teal-50', border: 'border-teal-200', bar: '#0d9488' },
  { bg: 'bg-orange-500', text: 'text-orange-700', light: 'bg-orange-50', border: 'border-orange-200', bar: '#ea580c' },
  { bg: 'bg-blue-500', text: 'text-blue-700', light: 'bg-blue-50', border: 'border-blue-200', bar: '#2563eb' },
  { bg: 'bg-purple-500', text: 'text-purple-700', light: 'bg-purple-50', border: 'border-purple-200', bar: '#9333ea' },
  { bg: 'bg-rose-500', text: 'text-rose-700', light: 'bg-rose-50', border: 'border-rose-200', bar: '#e11d48' },
  { bg: 'bg-emerald-500', text: 'text-emerald-700', light: 'bg-emerald-50', border: 'border-emerald-200', bar: '#059669' },
]

const STAT_SECTIONS = [
  {
    label: 'Team Batting',
    stats: [
      { key: 'batting.team_avg', label: 'AVG', format: 'avg' },
      { key: 'batting.team_obp', label: 'OBP', format: 'avg' },
      { key: 'batting.team_slg', label: 'SLG', format: 'avg' },
      { key: 'batting.avg_woba', label: 'wOBA', format: 'avg' },
      { key: 'batting.avg_wrc_plus', label: 'wRC+', format: 'int' },
      { key: 'batting.avg_iso', label: 'ISO', format: 'avg' },
      { key: 'batting.total_hr', label: 'HR', format: 'int' },
      { key: 'batting.total_r', label: 'Runs', format: 'int' },
      { key: 'batting.total_rbi', label: 'RBI', format: 'int' },
      { key: 'batting.total_sb', label: 'SB', format: 'int' },
      { key: 'batting.avg_bb_pct', label: 'BB%', format: 'pct' },
      { key: 'batting.avg_k_pct', label: 'K%', format: 'pct', lowerBetter: true },
      { key: 'batting.total_owar', label: 'oWAR', format: 'war' },
    ]
  },
  {
    label: 'Team Pitching',
    stats: [
      { key: 'pitching.team_era', label: 'ERA', format: 'era', lowerBetter: true },
      { key: 'pitching.team_whip', label: 'WHIP', format: 'era', lowerBetter: true },
      { key: 'pitching.avg_fip', label: 'FIP', format: 'era', lowerBetter: true },
      { key: 'pitching.avg_fip_plus', label: 'FIP+', format: 'int' },
      { key: 'pitching.avg_era_plus', label: 'ERA+', format: 'int' },
      { key: 'pitching.avg_xfip', label: 'xFIP', format: 'era', lowerBetter: true },
      { key: 'pitching.total_k', label: 'K', format: 'int' },
      { key: 'pitching.avg_k_pct', label: 'K%', format: 'pct' },
      { key: 'pitching.avg_bb_pct', label: 'BB%', format: 'pct', lowerBetter: true },
      { key: 'pitching.total_ip', label: 'IP', format: 'ip' },
      { key: 'pitching.total_pwar', label: 'pWAR', format: 'war' },
    ]
  },
]

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : null), obj)
}

// Visual bar for stat comparison
function StatBar({ values, bestIdx, lowerBetter, colors }) {
  const nums = values.map(v => (v != null ? Number(v) : 0))
  const max = Math.max(...nums.filter(n => n !== 0), 1)
  const min = Math.min(...nums.filter(n => n !== 0), 0)
  const range = lowerBetter ? max : max

  return (
    <div className="flex flex-col gap-1 w-full">
      {nums.map((val, i) => {
        const pct = range > 0 ? Math.min((Math.abs(val) / range) * 100, 100) : 0
        const isBest = i === bestIdx && values.length > 1
        return (
          <div key={i} className="flex items-center gap-1.5 h-4">
            <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.max(pct, 2)}%`,
                  backgroundColor: isBest ? colors[i]?.bar || '#0d9488' : '#d1d5db',
                  opacity: isBest ? 1 : 0.5,
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Player card for top hitters/pitchers
function PlayerCard({ player, type, teamColor, teamLogo }) {
  const isBatter = type === 'batting'
  return (
    <Link
      to={`/player/${player.player_id}`}
      className={`block p-2.5 rounded-lg border ${teamColor.border} ${teamColor.light} hover:shadow-sm transition-shadow`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {teamLogo && (
            <img src={teamLogo} alt="" className="w-3.5 h-3.5 object-contain shrink-0"
                 onError={(e) => { e.target.style.display = 'none' }} />
          )}
          <span className="font-semibold text-xs text-gray-900 truncate">
            {player.first_name} {player.last_name}
          </span>
        </div>
        <span className="text-[10px] text-gray-400 shrink-0 ml-1">{player.position}</span>
      </div>
      {isBatter ? (
        <div className="grid grid-cols-4 gap-x-2 gap-y-0.5 text-[10px]">
          <StatPill label="AVG" value={player.batting_avg != null ? Number(player.batting_avg).toFixed(3) : '-'} />
          <StatPill label="HR" value={player.home_runs} />
          <StatPill label="wRC+" value={player.wrc_plus != null ? Math.round(Number(player.wrc_plus)) : '-'} />
          <StatPill label="oWAR" value={player.offensive_war != null ? Number(player.offensive_war).toFixed(1) : '-'} highlight />
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-x-2 gap-y-0.5 text-[10px]">
          <StatPill label="ERA" value={player.era != null ? Number(player.era).toFixed(2) : '-'} />
          <StatPill label="IP" value={player.innings_pitched != null ? Number(player.innings_pitched).toFixed(1) : '-'} />
          <StatPill label="K" value={player.strikeouts} />
          <StatPill label="pWAR" value={player.pitching_war != null ? Number(player.pitching_war).toFixed(1) : '-'} highlight />
        </div>
      )}
    </Link>
  )
}

function StatPill({ label, value, highlight }) {
  return (
    <div className={`flex flex-col items-center ${highlight ? 'font-bold' : ''}`}>
      <span className="text-gray-400 leading-none">{label}</span>
      <span className={`leading-tight ${highlight ? 'text-teal-700' : 'text-gray-700'}`}>{value ?? '-'}</span>
    </div>
  )
}

export default function TeamComparison() {
  const [allTeams, setAllTeams] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [compareData, setCompareData] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch(`${API_BASE}/teams`)
      .then(r => r.json())
      .then(teams => setAllTeams(teams.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (selectedIds.length < 2) {
      setCompareData([])
      return
    }
    setLoading(true)
    fetch(`${API_BASE}/teams/compare?season=2026&team_ids=${selectedIds.join(',')}`)
      .then(r => r.json())
      .then(data => { setCompareData(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => { setCompareData([]); setLoading(false) })
  }, [selectedIds])

  const addTeam = (id) => {
    if (id && !selectedIds.includes(id) && selectedIds.length < 6) {
      setSelectedIds([...selectedIds, id])
    }
  }

  const removeTeam = (id) => {
    setSelectedIds(selectedIds.filter(x => x !== id))
  }

  const getBestIdx = (stat) => {
    const vals = compareData.map(t => getNestedValue(t, stat.key))
    if (vals.every(v => v == null)) return -1
    const numeric = vals.map(v => (v != null ? Number(v) : null))
    let bestIdx = -1
    let bestVal = null
    numeric.forEach((v, i) => {
      if (v == null) return
      if (bestVal == null) { bestIdx = i; bestVal = v; return }
      if (stat.lowerBetter ? v < bestVal : v > bestVal) {
        bestIdx = i; bestVal = v
      }
    })
    return bestIdx
  }

  // Count "wins" per stat section
  const getWinCounts = (section) => {
    const counts = compareData.map(() => 0)
    section.stats.forEach(stat => {
      const best = getBestIdx(stat)
      if (best >= 0) counts[best]++
    })
    return counts
  }

  const pnwTeams = allTeams.filter(t => PNW_STATES.includes(t.state))

  // Group by division for the dropdown
  const divisions = {}
  pnwTeams.forEach(t => {
    const key = t.division_level || 'Other'
    if (!divisions[key]) divisions[key] = []
    divisions[key].push(t)
  })
  const divOrder = ['D1', 'D2', 'D3', 'NAIA', 'JUCO']

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-pnw-slate">Team Comparison</h1>
        <p className="text-sm text-gray-400 mt-1">Compare up to 6 teams head-to-head across batting, pitching, and top players</p>
      </div>

      {/* Team selector */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
            value=""
            onChange={(e) => { addTeam(parseInt(e.target.value)); e.target.value = '' }}
          >
            <option value="">+ Add team...</option>
            {divOrder.filter(d => divisions[d]).map(div => (
              <optgroup key={div} label={div}>
                {divisions[div]
                  .filter(t => !selectedIds.includes(t.id))
                  .map(t => (
                    <option key={t.id} value={t.id}>{t.short_name || t.name}</option>
                  ))}
              </optgroup>
            ))}
          </select>

          {/* Selected team chips with color indicators */}
          {selectedIds.map((id, idx) => {
            const team = allTeams.find(t => t.id === id)
            if (!team) return null
            const color = TEAM_COLORS[idx % TEAM_COLORS.length]
            return (
              <span
                key={id}
                className={`inline-flex items-center gap-1.5 ${color.light} border ${color.border} rounded-full px-3 py-1.5 text-sm font-medium shadow-sm`}
              >
                <span className={`w-2 h-2 rounded-full ${color.bg}`} />
                {team.logo_url && (
                  <img src={team.logo_url} alt="" className="w-4 h-4 object-contain"
                       onError={(e) => { e.target.style.display = 'none' }} />
                )}
                {team.short_name || team.name}
                <span className={`px-1 py-0 rounded text-[9px] font-bold ${divisionBadgeClass(team.division_level)}`}>
                  {team.division_level}
                </span>
                <button
                  onClick={() => removeTeam(id)}
                  className="ml-0.5 text-gray-400 hover:text-red-500 font-bold text-lg leading-none"
                >×</button>
              </span>
            )
          })}

          {selectedIds.length > 0 && (
            <button
              onClick={() => setSelectedIds([])}
              className="text-xs text-gray-400 hover:text-red-500 ml-1"
            >Clear all</button>
          )}
        </div>

        {selectedIds.length < 2 && (
          <p className="text-gray-400 text-sm mt-3 italic">Select at least 2 teams to compare.</p>
        )}
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="animate-spin h-8 w-8 border-4 border-teal-500 border-t-transparent rounded-full" />
        </div>
      )}

      {compareData.length >= 2 && !loading && (
        <div className="space-y-6">
          {/* ── Team Overview Cards ── */}
          <div className={`grid gap-4 ${compareData.length <= 3 ? `grid-cols-${compareData.length}` : 'grid-cols-2 lg:grid-cols-3'}`}
               style={{ gridTemplateColumns: `repeat(${Math.min(compareData.length, 3)}, 1fr)` }}>
            {compareData.map((team, idx) => {
              const color = TEAM_COLORS[idx % TEAM_COLORS.length]
              const record = team.record || {}
              const wins = record.wins || 0
              const losses = record.losses || 0
              const winPct = (wins + losses) > 0 ? (wins / (wins + losses)).toFixed(3) : '.000'
              return (
                <div key={team.id} className={`bg-white rounded-lg shadow-sm border-2 ${color.border} p-4`}>
                  <div className="flex items-center gap-3 mb-3">
                    {team.logo_url && (
                      <img src={team.logo_url} alt="" className="w-12 h-12 object-contain"
                           onError={(e) => { e.target.style.display = 'none' }} />
                    )}
                    <div>
                      <h3 className="font-bold text-pnw-slate text-lg leading-tight">{team.short_name}</h3>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${divisionBadgeClass(team.division_level)}`}>
                          {team.division_level}
                        </span>
                        <span className="text-xs text-gray-500">{team.conference_abbrev}</span>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="bg-gray-50 rounded-lg py-2">
                      <div className="text-lg font-bold text-pnw-slate">{wins}-{losses}</div>
                      <div className="text-[10px] text-gray-400 uppercase">Record</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg py-2">
                      <div className="text-lg font-bold text-pnw-slate">{winPct}</div>
                      <div className="text-[10px] text-gray-400 uppercase">Win%</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg py-2">
                      <div className="text-lg font-bold text-teal-600">{team.total_war}</div>
                      <div className="text-[10px] text-gray-400 uppercase">WAR</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* ── Stat Comparison Tables with Bars ── */}
          {STAT_SECTIONS.map(section => {
            const winCounts = getWinCounts(section)
            return (
              <div key={section.label} className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                {/* Section header with win counts */}
                <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
                  <h2 className="text-sm font-bold uppercase tracking-wider text-pnw-slate">{section.label}</h2>
                  <div className="flex items-center gap-3">
                    {compareData.map((team, idx) => {
                      const color = TEAM_COLORS[idx % TEAM_COLORS.length]
                      return (
                        <div key={team.id} className="flex items-center gap-1.5 text-xs">
                          <span className={`w-2 h-2 rounded-full ${color.bg}`} />
                          <span className="font-medium text-gray-600">{team.short_name}</span>
                          <span className={`font-bold ${color.text}`}>{winCounts[idx]}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="divide-y divide-gray-100">
                  {section.stats.map(stat => {
                    const bestIdx = getBestIdx(stat)
                    const values = compareData.map(t => getNestedValue(t, stat.key))
                    return (
                      <div key={stat.key} className="flex items-center px-4 py-2 hover:bg-gray-50/50">
                        <div className="w-16 shrink-0 text-xs font-medium text-gray-500">{stat.label}</div>
                        <div className="flex-1 grid gap-2" style={{ gridTemplateColumns: `repeat(${compareData.length}, 1fr)` }}>
                          {compareData.map((team, i) => {
                            const val = values[i]
                            const isBest = i === bestIdx && compareData.length > 1
                            const color = TEAM_COLORS[i % TEAM_COLORS.length]
                            const nums = values.map(v => (v != null ? Math.abs(Number(v)) : 0))
                            const maxVal = Math.max(...nums, 0.001)
                            const pct = val != null ? (Math.abs(Number(val)) / maxVal) * 100 : 0
                            return (
                              <div key={team.id} className="flex items-center gap-2">
                                <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden relative">
                                  <div
                                    className="h-full rounded-full transition-all duration-700 ease-out"
                                    style={{
                                      width: `${Math.max(pct, 3)}%`,
                                      backgroundColor: isBest ? color.bar : '#d1d5db',
                                    }}
                                  />
                                </div>
                                <span className={`text-xs font-mono w-14 text-right shrink-0 ${isBest ? `${color.text} font-bold` : 'text-gray-500'}`}>
                                  {val != null ? formatStat(Number(val), stat.format) : '-'}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Overall section total WAR */}
                {section.label === 'Team Pitching' && (
                  <div className="px-4 py-3 bg-gray-50 border-t border-gray-200">
                    <div className="flex items-center">
                      <div className="w-16 shrink-0 text-xs font-bold text-pnw-slate">Total WAR</div>
                      <div className="flex-1 grid gap-2" style={{ gridTemplateColumns: `repeat(${compareData.length}, 1fr)` }}>
                        {compareData.map((team, i) => {
                          const vals = compareData.map(t => t.total_war || 0)
                          const maxVal = Math.max(...vals, 0.001)
                          const pct = (team.total_war || 0) / maxVal * 100
                          const isBest = team.total_war === Math.max(...vals)
                          const color = TEAM_COLORS[i % TEAM_COLORS.length]
                          return (
                            <div key={team.id} className="flex items-center gap-2">
                              <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
                                <div
                                  className="h-full rounded-full transition-all duration-700"
                                  style={{ width: `${Math.max(pct, 3)}%`, backgroundColor: isBest ? color.bar : '#d1d5db' }}
                                />
                              </div>
                              <span className={`text-xs font-mono w-14 text-right shrink-0 font-bold ${isBest ? color.text : 'text-gray-500'}`}>
                                {team.total_war}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {/* ── Top Players Section ── */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Top Hitters */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 bg-blue-50 border-b border-blue-100">
                <h2 className="text-sm font-bold uppercase tracking-wider text-blue-800">Top Hitters (by oWAR)</h2>
              </div>
              <div className="p-3 space-y-4">
                {compareData.map((team, idx) => {
                  const color = TEAM_COLORS[idx % TEAM_COLORS.length]
                  return (
                    <div key={team.id}>
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`w-2 h-2 rounded-full ${color.bg}`} />
                        {team.logo_url && (
                          <img src={team.logo_url} alt="" className="w-4 h-4 object-contain"
                               onError={(e) => { e.target.style.display = 'none' }} />
                        )}
                        <span className="text-xs font-bold text-pnw-slate">{team.short_name}</span>
                      </div>
                      <div className="space-y-1.5 ml-4">
                        {(team.top_hitters || []).map((p, pi) => (
                          <PlayerCard key={pi} player={p} type="batting" teamColor={color} teamLogo={team.logo_url} />
                        ))}
                        {(!team.top_hitters || team.top_hitters.length === 0) && (
                          <p className="text-xs text-gray-400 italic py-2">No qualified hitters</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Top Pitchers */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 bg-orange-50 border-b border-orange-100">
                <h2 className="text-sm font-bold uppercase tracking-wider text-orange-800">Top Pitchers (by pWAR)</h2>
              </div>
              <div className="p-3 space-y-4">
                {compareData.map((team, idx) => {
                  const color = TEAM_COLORS[idx % TEAM_COLORS.length]
                  return (
                    <div key={team.id}>
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`w-2 h-2 rounded-full ${color.bg}`} />
                        {team.logo_url && (
                          <img src={team.logo_url} alt="" className="w-4 h-4 object-contain"
                               onError={(e) => { e.target.style.display = 'none' }} />
                        )}
                        <span className="text-xs font-bold text-pnw-slate">{team.short_name}</span>
                      </div>
                      <div className="space-y-1.5 ml-4">
                        {(team.top_pitchers || []).map((p, pi) => (
                          <PlayerCard key={pi} player={p} type="pitching" teamColor={color} teamLogo={team.logo_url} />
                        ))}
                        {(!team.top_pitchers || team.top_pitchers.length === 0) && (
                          <p className="text-xs text-gray-400 italic py-2">No qualified pitchers</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* ── Quick Verdict ── */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <h2 className="text-sm font-bold uppercase tracking-wider text-pnw-slate mb-3">Edge Summary</h2>
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${compareData.length}, 1fr)` }}>
              {compareData.map((team, idx) => {
                const color = TEAM_COLORS[idx % TEAM_COLORS.length]
                const batWins = getWinCounts(STAT_SECTIONS[0])[idx]
                const pitWins = getWinCounts(STAT_SECTIONS[1])[idx]
                const totalCats = STAT_SECTIONS[0].stats.length + STAT_SECTIONS[1].stats.length
                const totalWins = batWins + pitWins
                const pct = Math.round((totalWins / totalCats) * 100)
                return (
                  <div key={team.id} className={`text-center p-3 rounded-lg border-2 ${color.border} ${color.light}`}>
                    <div className="flex items-center justify-center gap-2 mb-2">
                      {team.logo_url && (
                        <img src={team.logo_url} alt="" className="w-6 h-6 object-contain"
                             onError={(e) => { e.target.style.display = 'none' }} />
                      )}
                      <span className="font-bold text-sm text-pnw-slate">{team.short_name}</span>
                    </div>
                    <div className={`text-3xl font-black ${color.text}`}>{totalWins}</div>
                    <div className="text-[10px] text-gray-400 uppercase mt-0.5">of {totalCats} categories</div>
                    <div className="mt-2 flex gap-2 justify-center text-[10px]">
                      <span className="bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">Bat: {batWins}</span>
                      <span className="bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-medium">Pitch: {pitWins}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
