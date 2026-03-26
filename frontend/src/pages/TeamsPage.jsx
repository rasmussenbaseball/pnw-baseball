import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTeamsSummary, useDivisions } from '../hooks/useApi'
import { formatStat, divisionBadgeClass } from '../utils/stats'

export default function TeamsPage() {
  const [divisionFilter, setDivisionFilter] = useState(null)
  const [stateFilter, setStateFilter] = useState(null)

  const { data: divisions } = useDivisions()
  const { data: teams, loading } = useTeamsSummary({
    season: 2026,
    division_id: divisionFilter,
    state: stateFilter,
  })

  // Group teams by division in fixed order
  const DIVISION_ORDER = ['NCAA D1', 'NCAA D2', 'NCAA D3', 'NAIA', 'NWAC']
  const grouped = {}
  ;(teams || []).forEach(t => {
    const key = t.division_name || 'Other'
    if (!grouped[key]) grouped[key] = []
    grouped[key].push(t)
  })
  // Sort teams within each division by name
  Object.values(grouped).forEach(arr => arr.sort((a, b) => a.name.localeCompare(b.name)))

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-4">Teams</h1>

      <div className="flex gap-3 mb-4">
        <select
          value={divisionFilter || ''}
          onChange={(e) => setDivisionFilter(e.target.value ? parseInt(e.target.value) : null)}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm"
        >
          <option value="">All Divisions</option>
          {divisions?.map(d => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>

        <select
          value={stateFilter || ''}
          onChange={(e) => setStateFilter(e.target.value || null)}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm"
        >
          <option value="">All States</option>
          {['WA', 'OR', 'ID', 'MT', 'BC'].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="text-gray-400 animate-pulse">Loading teams...</div>
      ) : (
        DIVISION_ORDER.filter(div => grouped[div]).map(div => (
          <div key={div} className="mb-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {grouped[div].map(team => (
                <TeamCard key={team.id} team={team} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}


function TeamCard({ team }) {
  const h = team.top_hitter
  const p = team.top_pitcher

  return (
    <Link
      to={`/team/${team.id}`}
      className="bg-white rounded-lg shadow-sm border p-4 hover:shadow-md transition-shadow block"
    >
      {/* Team header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {team.logo_url && (
            <img
              src={team.logo_url}
              alt=""
              className="w-7 h-7 object-contain shrink-0"
              loading="lazy"
              onError={(e) => { e.target.style.display = 'none' }}
            />
          )}
          <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${divisionBadgeClass(team.division_level)}`}>
            {team.division_level}
          </span>
          <span className="font-semibold text-sm text-pnw-slate">{team.name}</span>
        </div>
        {team.team_war != null && (
          <div className="text-right">
            <span className="text-xs font-bold text-pnw-forest font-mono">
              {team.team_war.toFixed(1)} WAR
            </span>
            {(team.team_owar != null || team.team_pwar != null) && (
              <div className="text-[10px] font-mono text-gray-400">
                {(team.team_owar ?? 0).toFixed(1)}o / {(team.team_pwar ?? 0).toFixed(1)}p
              </div>
            )}
          </div>
        )}
      </div>
      <div className="text-xs text-gray-500 mb-3 flex items-center justify-between">
        <span>{team.city}, {team.state} — {team.conference_abbrev}</span>
        {team.wins != null && (
          <span className="font-mono font-semibold text-pnw-slate">
            {team.wins}-{team.losses}
            {team.conf_wins != null && team.conf_wins + team.conf_losses > 0 && (
              <span className="text-gray-400 font-normal"> ({team.conf_wins}-{team.conf_losses})</span>
            )}
          </span>
        )}
      </div>

      {/* Top players */}
      <div className="space-y-1.5">
        {h ? (
          <div className="flex items-center justify-between text-xs">
            <div className="text-gray-700 truncate mr-2">
              <span className="text-[10px] uppercase font-bold text-pnw-teal mr-1.5">TOP BAT</span>
              {h.first_name} {h.last_name}
              <span className="text-gray-400 ml-1">{h.position}</span>
            </div>
            <div className="flex gap-2 font-mono text-gray-600 whitespace-nowrap">
              <span>{formatStat(h.woba, 'avg')} wOBA</span>
              <span className="text-pnw-forest font-semibold">{formatStat(h.offensive_war, 'war')}</span>
            </div>
          </div>
        ) : (
          <div className="text-xs text-gray-400 italic">No qualifying hitters</div>
        )}

        {p ? (
          <div className="flex items-center justify-between text-xs">
            <div className="text-gray-700 truncate mr-2">
              <span className="text-[10px] uppercase font-bold text-pnw-teal mr-1.5">TOP ARM</span>
              {p.first_name} {p.last_name}
            </div>
            <div className="flex gap-2 font-mono text-gray-600 whitespace-nowrap">
              <span>{formatStat(p.fip, 'era')} FIP</span>
              <span className="text-pnw-forest font-semibold">{formatStat(p.pitching_war, 'war')}</span>
            </div>
          </div>
        ) : (
          <div className="text-xs text-gray-400 italic">No qualifying pitchers</div>
        )}
      </div>
    </Link>
  )
}
