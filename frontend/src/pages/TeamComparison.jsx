import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { formatStat, divisionBadgeClass } from '../utils/stats'
import StatsLastUpdated from '../components/StatsLastUpdated'

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

// Power rating gauge - circular display
function PowerGauge({ rating, label, size = 80 }) {
  const radius = (size - 8) / 2
  const circumference = 2 * Math.PI * radius
  const pct = Math.max(0, Math.min(100, rating || 0))
  const offset = circumference - (pct / 100) * circumference

  // Color based on rating
  let color = '#ef4444' // red
  if (pct >= 75) color = '#059669' // green
  else if (pct >= 55) color = '#0d9488' // teal
  else if (pct >= 40) color = '#eab308' // yellow
  else if (pct >= 25) color = '#f97316' // orange

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size/2} cy={size/2} r={radius}
          fill="none" stroke="#f3f4f6" strokeWidth="6" />
        <circle cx={size/2} cy={size/2} r={radius}
          fill="none" stroke={color} strokeWidth="6"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-1000 ease-out" />
      </svg>
      <div className="absolute flex flex-col items-center justify-center" style={{ width: size, height: size }}>
        <span className="text-xl font-black text-pnw-slate">{pct.toFixed(0)}</span>
      </div>
      {label && <span className="text-[10px] text-gray-400 uppercase mt-1">{label}</span>}
    </div>
  )
}

// Matchup card showing head-to-head prediction
function MatchupCard({ matchup, teamMap, colorMap }) {
  const a = teamMap[matchup.team_a]
  const b = teamMap[matchup.team_b]
  if (!a || !b) return null

  const colorA = colorMap[matchup.team_a] || TEAM_COLORS[0]
  const colorB = colorMap[matchup.team_b] || TEAM_COLORS[1]
  // Round team A and derive team B = 100 - A so the pair always sums to 100
  // (independent Math.round can yield 99/101 when the raw decimal lands near .5).
  const pctA = Math.round(matchup.win_prob_a * 100)
  const pctB = 100 - pctA
  const spread = matchup.spread
  const favored = matchup.favored === matchup.team_a ? a : b
  const spreadAbs = Math.abs(spread)

  // Confidence label
  let confidence = 'Toss-up'
  if (spreadAbs >= 7) confidence = 'Heavy favorite'
  else if (spreadAbs >= 4.5) confidence = 'Strong favorite'
  else if (spreadAbs >= 2.5) confidence = 'Moderate edge'
  else if (spreadAbs >= 1) confidence = 'Slight edge'

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Team headers */}
      <div className="grid grid-cols-[1fr_auto_1fr]">
        <div className={`p-3 ${colorA.light} border-b-2`} style={{ borderColor: colorA.bar }}>
          <div className="flex items-center gap-2">
            {a.logo_url && <img src={a.logo_url} alt="" className="w-8 h-8 object-contain" onError={(e) => { e.target.style.display = 'none' }} />}
            <div>
              <div className="font-bold text-sm text-pnw-slate">{a.short_name}</div>
              <div className="flex items-center gap-1.5">
                <span className={`px-1 py-0 rounded text-[9px] font-bold ${divisionBadgeClass(a.division_level)}`}>{a.division_level}</span>
                <span className="text-[10px] text-gray-400">{a.record}</span>
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center px-3 text-xs font-bold text-gray-300 border-b-2 border-gray-100">VS</div>
        <div className={`p-3 ${colorB.light} border-b-2 text-right`} style={{ borderColor: colorB.bar }}>
          <div className="flex items-center gap-2 justify-end">
            <div>
              <div className="font-bold text-sm text-pnw-slate">{b.short_name}</div>
              <div className="flex items-center gap-1.5 justify-end">
                <span className="text-[10px] text-gray-400">{b.record}</span>
                <span className={`px-1 py-0 rounded text-[9px] font-bold ${divisionBadgeClass(b.division_level)}`}>{b.division_level}</span>
              </div>
            </div>
            {b.logo_url && <img src={b.logo_url} alt="" className="w-8 h-8 object-contain" onError={(e) => { e.target.style.display = 'none' }} />}
          </div>
        </div>
      </div>

      {/* Win probability bar */}
      <div className="px-4 pt-3 pb-1">
        <div className="flex items-center justify-between text-xs mb-1">
          <span className="font-bold" style={{ color: colorA.bar }}>{pctA}%</span>
          <span className="text-[10px] text-gray-400 uppercase">Projected Win %</span>
          <span className="font-bold" style={{ color: colorB.bar }}>{pctB}%</span>
        </div>
        <div className="flex h-4 rounded-full overflow-hidden">
          <div
            className="transition-all duration-700 ease-out rounded-l-full"
            style={{ width: `${pctA}%`, backgroundColor: colorA.bar }}
          />
          <div
            className="transition-all duration-700 ease-out rounded-r-full"
            style={{ width: `${pctB}%`, backgroundColor: colorB.bar }}
          />
        </div>
      </div>

      {/* Spread + power ratings + projected runs */}
      <div className="px-4 py-3">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-lg font-black" style={{ color: colorA.bar }}>{a.power_rating}</div>
            <div className="text-[10px] text-gray-400 uppercase">Power Rating</div>
          </div>
          <div className="flex flex-col items-center justify-center">
            <div className="text-lg font-black text-pnw-slate">
              {spread > 0 ? `${a.short_name} -${spreadAbs.toFixed(1)}` : spread < 0 ? `${b.short_name} -${spreadAbs.toFixed(1)}` : 'EVEN'}
            </div>
            <div className="text-[10px] text-gray-400 uppercase">Run Spread</div>
            <div className="text-[9px] text-gray-300 mt-0.5">{confidence}</div>
          </div>
          <div>
            <div className="text-lg font-black" style={{ color: colorB.bar }}>{b.power_rating}</div>
            <div className="text-[10px] text-gray-400 uppercase">Power Rating</div>
          </div>
        </div>

        {/* Projected score + over/under */}
        {matchup.proj_total != null && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-base font-bold" style={{ color: colorA.bar }}>{matchup.proj_runs_a}</div>
                <div className="text-[10px] text-gray-400">Proj. Runs</div>
              </div>
              <div>
                <div className="text-base font-bold text-pnw-slate">O/U {matchup.proj_total}</div>
                <div className="text-[10px] text-gray-400">Proj. Total</div>
              </div>
              <div>
                <div className="text-base font-bold" style={{ color: colorB.bar }}>{matchup.proj_runs_b}</div>
                <div className="text-[10px] text-gray-400">Proj. Runs</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Component breakdown */}
      <div className="px-4 pb-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
          {[
            { label: 'Pyth Win%', a: a.components?.pyth_win_pct ? (a.components.pyth_win_pct * 100).toFixed(0) + '%' : '-',
              b: b.components?.pyth_win_pct ? (b.components.pyth_win_pct * 100).toFixed(0) + '%' : '-' },
            { label: 'Run Diff/G', a: a.components?.run_diff_per_game != null ? (a.components.run_diff_per_game > 0 ? '+' : '') + a.components.run_diff_per_game.toFixed(1) : '-',
              b: b.components?.run_diff_per_game != null ? (b.components.run_diff_per_game > 0 ? '+' : '') + b.components.run_diff_per_game.toFixed(1) : '-' },
            { label: 'wRC+', a: a.components?.wrc_plus ?? '-', b: b.components?.wrc_plus ?? '-' },
            { label: 'FIP', a: a.components?.fip ?? '-', b: b.components?.fip ?? '-' },
            { label: 'WAR/G', a: a.components?.war_per_game ?? '-', b: b.components?.war_per_game ?? '-' },
            { label: 'Natl Pctl', a: a.components?.national_percentile != null ? a.components.national_percentile.toFixed(0) + '%' : 'N/A',
              b: b.components?.national_percentile != null ? b.components.national_percentile.toFixed(0) + '%' : 'N/A' },
          ].map(row => (
            <div key={row.label} className="flex items-center justify-between py-0.5 border-b border-gray-50">
              <span className="font-medium" style={{ color: colorA.bar }}>{row.a}</span>
              <span className="text-gray-400 mx-1">{row.label}</span>
              <span className="font-medium" style={{ color: colorB.bar }}>{row.b}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}


export default function TeamComparison() {
  const [allTeams, setAllTeams] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [compareData, setCompareData] = useState([])
  const [matchupData, setMatchupData] = useState({ teams: [], matchups: [] })
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('matchups')

  useEffect(() => {
    fetch(`${API_BASE}/teams`)
      .then(r => r.json())
      .then(teams => setAllTeams(teams.sort((a, b) => a.name.localeCompare(b.name))))
      .catch((err) => console.error('[TeamComparison] /teams failed:', err))
  }, [])

  useEffect(() => {
    if (selectedIds.length < 2) {
      setCompareData([])
      setMatchupData({ teams: [], matchups: [] })
      return
    }
    setLoading(true)
    const idsStr = selectedIds.join(',')

    // Fetch both endpoints in parallel
    Promise.all([
      fetch(`${API_BASE}/teams/compare?season=2026&team_ids=${idsStr}`).then(r => r.json()),
      fetch(`${API_BASE}/teams/matchup?season=2026&team_ids=${idsStr}`).then(r => r.json()),
    ])
      .then(([compare, matchup]) => {
        setCompareData(Array.isArray(compare) ? compare : [])
        setMatchupData(matchup || { teams: [], matchups: [] })
        setLoading(false)
      })
      .catch(() => {
        setCompareData([])
        setMatchupData({ teams: [], matchups: [] })
        setLoading(false)
      })
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

  const getWinCounts = (section) => {
    const counts = compareData.map(() => 0)
    section.stats.forEach(stat => {
      const best = getBestIdx(stat)
      if (best >= 0) counts[best]++
    })
    return counts
  }

  // Build maps for matchup cards
  const teamMap = useMemo(() => {
    const m = {}
    ;(matchupData.teams || []).forEach(t => { m[t.team_id] = t })
    return m
  }, [matchupData.teams])

  const colorMap = useMemo(() => {
    const m = {}
    selectedIds.forEach((id, idx) => {
      m[id] = TEAM_COLORS[idx % TEAM_COLORS.length]
    })
    return m
  }, [selectedIds])

  const pnwTeams = allTeams.filter(t => PNW_STATES.includes(t.state))
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
        <h1 className="text-2xl font-bold text-pnw-slate">Matchups & Comparison</h1>
        <p className="text-sm text-gray-400 mt-1">Cross-division power ratings, neutral-site projections, and head-to-head stat comparison</p>
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
        <>
          {/* Tab navigation */}
          <div className="flex gap-1 mb-6 bg-gray-100 rounded-lg p-1 w-fit">
            {[
              { key: 'matchups', label: 'Matchup Predictions' },
              { key: 'stats', label: 'Stat Comparison' },
              { key: 'players', label: 'Top Players' },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  activeTab === tab.key
                    ? 'bg-white text-pnw-slate shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* ── MATCHUPS TAB ── */}
          {activeTab === 'matchups' && (
            <div className="space-y-6">
              {/* Power Rankings Bar */}
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                <div className="px-4 py-3 bg-gradient-to-r from-pnw-slate to-gray-700 border-b border-gray-200">
                  <h2 className="text-sm font-bold uppercase tracking-wider text-white">Cross-Division Power Ratings</h2>
                  <p className="text-[10px] text-gray-300 mt-0.5">Based on Pythagorean win%, wRC+, FIP, WAR, and national rankings</p>
                </div>
                <div className="p-4 space-y-3">
                  {(matchupData.teams || []).map((team, idx) => {
                    const color = colorMap[team.team_id] || TEAM_COLORS[0]
                    const maxRating = Math.max(...(matchupData.teams || []).map(t => t.power_rating || 0), 1)
                    return (
                      <div key={team.team_id} className="flex items-center gap-3">
                        <div className="w-36 flex items-center gap-2 shrink-0">
                          {team.logo_url && <img src={team.logo_url} alt="" className="w-6 h-6 object-contain" onError={(e) => { e.target.style.display = 'none' }} />}
                          <div className="min-w-0">
                            <div className="text-sm font-bold text-pnw-slate truncate">{team.short_name}</div>
                            <div className="flex items-center gap-1">
                              <span className={`px-1 py-0 rounded text-[8px] font-bold ${divisionBadgeClass(team.division_level)}`}>{team.division_level}</span>
                              <span className="text-[10px] text-gray-400">{team.record}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex-1 bg-gray-100 rounded-full h-7 overflow-hidden relative">
                          <div
                            className="h-full rounded-full transition-all duration-1000 ease-out flex items-center justify-end pr-2"
                            style={{
                              width: `${Math.max((team.power_rating / maxRating) * 100, 5)}%`,
                              backgroundColor: color.bar,
                            }}
                          >
                            <span className="text-xs font-black text-white drop-shadow-sm">{team.power_rating}</span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Head-to-Head Matchup Cards */}
              <div className={`grid gap-4 ${(matchupData.matchups || []).length === 1 ? 'grid-cols-1 max-w-lg mx-auto' : 'grid-cols-1 lg:grid-cols-2'}`}>
                {(matchupData.matchups || []).map((m, i) => (
                  <MatchupCard key={i} matchup={m} teamMap={teamMap} colorMap={colorMap} />
                ))}
              </div>

              {/* Methodology note */}
              <div className="text-[10px] text-gray-400 text-center px-4">
                Power ratings blend Pythagorean expected win% (30%), national ranking percentile (25%), wRC+ (15%), FIP (15%), and WAR depth (15%), then scale by division strength. Division multipliers are calibrated to research showing D2 teams win ~23% vs D1 (Hardball Times). Win probabilities use an Elo-style formula (scale=50) for neutral-site projections.
              </div>
            </div>
          )}

          {/* ── STATS TAB ── */}
          {activeTab === 'stats' && (
            <div className="space-y-6">
              {/* Team Overview Cards */}
              <div className={`grid gap-4`}
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

              {/* Stat Comparison Tables */}
              {STAT_SECTIONS.map(section => {
                const winCounts = getWinCounts(section)
                return (
                  <div key={section.label} className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
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

              {/* Edge Summary */}
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                <h2 className="text-sm font-bold uppercase tracking-wider text-pnw-slate mb-3">Edge Summary</h2>
                <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${compareData.length}, 1fr)` }}>
                  {compareData.map((team, idx) => {
                    const color = TEAM_COLORS[idx % TEAM_COLORS.length]
                    const batWins = getWinCounts(STAT_SECTIONS[0])[idx]
                    const pitWins = getWinCounts(STAT_SECTIONS[1])[idx]
                    const totalCats = STAT_SECTIONS[0].stats.length + STAT_SECTIONS[1].stats.length
                    const totalWins = batWins + pitWins
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

          {/* ── PLAYERS TAB ── */}
          {activeTab === 'players' && (
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
          )}
        </>
      )}

      <StatsLastUpdated className="mt-4" />
    </div>
  )
}
