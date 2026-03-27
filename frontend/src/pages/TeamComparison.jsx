import { useState, useEffect } from 'react'
import { formatStat, divisionBadgeClass } from '../utils/stats'

const API_BASE = '/api/v1'

const STAT_SECTIONS = [
  {
    label: 'Batting',
    stats: [
      { key: 'batting.team_avg', label: 'Team AVG', format: 'avg' },
      { key: 'batting.team_obp', label: 'Team OBP', format: 'avg' },
      { key: 'batting.team_slg', label: 'Team SLG', format: 'avg' },
      { key: 'batting.avg_woba', label: 'Avg wOBA', format: 'avg' },
      { key: 'batting.avg_wrc_plus', label: 'Avg wRC+', format: 'int' },
      { key: 'batting.total_hr', label: 'Home Runs', format: 'int' },
      { key: 'batting.total_r', label: 'Runs', format: 'int' },
      { key: 'batting.total_sb', label: 'Stolen Bases', format: 'int' },
      { key: 'batting.avg_bb_pct', label: 'BB%', format: 'pct' },
      { key: 'batting.avg_k_pct', label: 'K%', format: 'pct', lowerBetter: true },
      { key: 'batting.total_owar', label: 'oWAR', format: 'war' },
    ]
  },
  {
    label: 'Pitching',
    stats: [
      { key: 'pitching.team_era', label: 'Team ERA', format: 'era', lowerBetter: true },
      { key: 'pitching.team_whip', label: 'Team WHIP', format: 'era', lowerBetter: true },
      { key: 'pitching.avg_fip', label: 'Avg FIP', format: 'era', lowerBetter: true },
      { key: 'pitching.avg_fip_plus', label: 'Avg FIP+', format: 'int' },
      { key: 'pitching.avg_era_plus', label: 'Avg ERA+', format: 'int' },
      { key: 'pitching.avg_xfip', label: 'Avg xFIP', format: 'era', lowerBetter: true },
      { key: 'pitching.total_k', label: 'Strikeouts', format: 'int' },
      { key: 'pitching.avg_k_pct', label: 'K%', format: 'pct' },
      { key: 'pitching.avg_bb_pct', label: 'BB%', format: 'pct', lowerBetter: true },
      { key: 'pitching.total_ip', label: 'Innings Pitched', format: 'ip' },
      { key: 'pitching.total_pwar', label: 'pWAR', format: 'war' },
    ]
  },
  {
    label: 'Overall',
    stats: [
      { key: 'total_war', label: 'Total WAR', format: 'war' },
    ]
  }
]

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : null), obj)
}

export default function TeamComparison() {
  const [allTeams, setAllTeams] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [compareData, setCompareData] = useState([])
  const [loading, setLoading] = useState(false)

  // Fetch all teams on mount
  useEffect(() => {
    fetch(`${API_BASE}/teams`)
      .then(r => r.json())
      .then(teams => setAllTeams(teams.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {})
  }, [])

  // Fetch comparison data when teams change
  useEffect(() => {
    if (selectedIds.length < 2) {
      setCompareData([])
      return
    }
    setLoading(true)
    fetch(`${API_BASE}/teams/compare?season=2026&team_ids=${selectedIds.join(',')}`)
      .then(r => r.json())
      .then(data => { setCompareData(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [selectedIds])

  const addTeam = (id) => {
    if (id && !selectedIds.includes(id) && selectedIds.length < 6) {
      setSelectedIds([...selectedIds, id])
    }
  }

  const removeTeam = (id) => {
    setSelectedIds(selectedIds.filter(x => x !== id))
  }

  // Find best value for each stat row to highlight
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

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-4">Team Comparison</h1>

      {/* Team selector */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <select
          className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          value=""
          onChange={(e) => { addTeam(parseInt(e.target.value)); e.target.value = '' }}
        >
          <option value="">+ Add team...</option>
          {allTeams
            .filter(t => !selectedIds.includes(t.id))
            .map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
        </select>

        {/* Selected team chips */}
        {selectedIds.map(id => {
          const team = allTeams.find(t => t.id === id)
          if (!team) return null
          return (
            <span
              key={id}
              className="inline-flex items-center gap-1.5 bg-white border rounded-full px-3 py-1 text-sm font-medium shadow-sm"
            >
              {team.logo_url && (
                <img src={team.logo_url} alt="" className="w-4 h-4 object-contain"
                     onError={(e) => { e.target.style.display = 'none' }} />
              )}
              {team.short_name || team.name}
              <button
                onClick={() => removeTeam(id)}
                className="ml-1 text-gray-400 hover:text-red-500 font-bold"
              >×</button>
            </span>
          )
        })}
      </div>

      {selectedIds.length < 2 && (
        <div className="text-gray-400 text-sm italic">Select at least 2 teams to compare.</div>
      )}

      {loading && <div className="text-gray-400 animate-pulse">Loading comparison...</div>}

      {compareData.length >= 2 && !loading && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-pnw-forest/20">
                <th className="text-left py-2 px-3 font-semibold text-pnw-slate w-36">Stat</th>
                {compareData.map(team => (
                  <th key={team.id} className="text-center py-2 px-3 min-w-[120px]">
                    <div className="flex flex-col items-center gap-1">
                      {team.logo_url && (
                        <img src={team.logo_url} alt="" className="w-8 h-8 object-contain"
                             onError={(e) => { e.target.style.display = 'none' }} />
                      )}
                      <span className="font-bold text-pnw-slate text-xs">{team.short_name}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${divisionBadgeClass(team.division_level)}`}>
                        {team.division_level}
                      </span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {STAT_SECTIONS.map(section => (
                <>
                  <tr key={`section-${section.label}`}>
                    <td
                      colSpan={compareData.length + 1}
                      className="pt-4 pb-1 px-3 text-xs font-bold uppercase tracking-wider text-pnw-forest border-b border-pnw-forest/10"
                    >
                      {section.label}
                    </td>
                  </tr>
                  {section.stats.map(stat => {
                    const bestIdx = getBestIdx(stat)
                    return (
                      <tr key={stat.key} className="border-b border-gray-100 hover:bg-gray-50/50">
                        <td className="py-1.5 px-3 text-gray-600 font-medium">{stat.label}</td>
                        {compareData.map((team, i) => {
                          const val = getNestedValue(team, stat.key)
                          const isBest = i === bestIdx && compareData.length > 1
                          return (
                            <td
                              key={team.id}
                              className={`py-1.5 px-3 text-center font-mono text-sm
                                ${isBest ? 'text-pnw-forest font-bold' : 'text-gray-700'}`}
                            >
                              {val != null ? formatStat(val, stat.format) : '-'}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
