import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTeamsSummary, useDivisions } from '../hooks/useApi'
import { formatStat, divisionBadgeClass } from '../utils/stats'
import { usePersistedState } from '../hooks/usePersistedState'
import { CURRENT_SEASON } from '../lib/seasons'

export default function TeamsPage() {
  const [divisionFilter, setDivisionFilter] = usePersistedState('teams_divFilter', null)
  const [stateFilter, setStateFilter] = usePersistedState('teams_stateFilter', null)

  const { data: divisions } = useDivisions()
  const { data: teams, loading } = useTeamsSummary({
    season: CURRENT_SEASON,
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
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-4">Teams</h1>

      <div className="flex gap-3 mb-5">
        <select
          value={divisionFilter || ''}
          onChange={(e) => setDivisionFilter(e.target.value ? parseInt(e.target.value) : null)}
          className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal/40"
        >
          <option value="">All Divisions</option>
          {divisions?.map(d => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>

        <select
          value={stateFilter || ''}
          onChange={(e) => setStateFilter(e.target.value || null)}
          className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal/40"
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
          <div key={div} className="mb-7">
            <div className="flex items-baseline gap-2 mb-2.5">
              <h2 className="text-sm font-bold uppercase tracking-wide text-nw-teal dark:text-gray-200">{div}</h2>
              <span className="text-xs text-gray-400">{grouped[div].length} teams</span>
            </div>
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


// Division-colored top accent (mirrors the division badge colors) so the
// grid reads by tier at a glance, matching the team-page V2 card chrome.
const DIV_ACCENT = {
  D1: 'border-t-red-500',
  D2: 'border-t-blue-500',
  D3: 'border-t-green-500',
  NAIA: 'border-t-purple-500',
  JUCO: 'border-t-amber-500',
}

function StatTile({ label, value, sub, accent }) {
  return (
    <div className={`rounded-lg border border-gray-100 dark:border-gray-700 border-t-[3px] ${accent} bg-gray-50/60 dark:bg-gray-900/30 px-1.5 py-1 text-center`}>
      <div className="text-[8.5px] font-bold uppercase tracking-wide text-gray-400 dark:text-gray-500 leading-tight">{label}</div>
      <div className="text-sm font-extrabold text-gray-900 dark:text-gray-100 tabular-nums leading-tight">{value}</div>
      {sub ? <div className="text-[8.5px] text-gray-400 dark:text-gray-500 tabular-nums leading-tight">{sub}</div> : null}
    </div>
  )
}

function PlayerLine({ label, name, meta, stat, war }) {
  return (
    <div className="flex items-center justify-between text-xs gap-2">
      <div className="text-gray-700 dark:text-gray-300 truncate min-w-0">
        <span className="text-[9px] uppercase font-bold text-nw-teal-light mr-1.5 tracking-wide">{label}</span>
        {name}
        {meta && <span className="text-gray-400 ml-1">{meta}</span>}
      </div>
      <div className="flex gap-2 font-mono text-gray-600 dark:text-gray-400 whitespace-nowrap shrink-0">
        <span>{stat}</span>
        <span className="text-nw-teal-dark dark:text-nw-teal-light font-semibold">{war}</span>
      </div>
    </div>
  )
}

function TeamCard({ team }) {
  const h = team.top_hitter
  const p = team.top_pitcher
  const accent = DIV_ACCENT[team.division_level] || 'border-t-nw-teal-light'
  const games = (team.wins || 0) + (team.losses || 0)
  const winPct = games ? team.wins / games : null
  const rd = team.run_differential

  return (
    <Link
      to={`/team/${team.id}`}
      className={`bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 border-t-4 ${accent} p-3.5 hover:shadow-md hover:-translate-y-0.5 transition-all block`}
    >
      {/* Header — big logo, name, record (mirrors the team-page hero) */}
      <div className="flex items-center gap-3 mb-3">
        {team.logo_url ? (
          <img
            src={team.logo_url}
            alt=""
            className="w-12 h-12 object-contain shrink-0"
            loading="lazy"
            onError={(e) => { e.target.style.visibility = 'hidden' }}
          />
        ) : (
          <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-700 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${divisionBadgeClass(team.division_level)}`}>
              {team.division_level}
            </span>
            {team.national_rank != null && (
              <span className="text-[10px] font-bold text-gray-400 dark:text-gray-500">#{Math.ceil(team.national_rank)}</span>
            )}
            <span className="font-bold text-[15px] text-nw-teal dark:text-gray-100 truncate">{team.name}</span>
          </div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
            {team.city}, {team.state} · {team.conference_abbrev}
          </div>
        </div>
        {team.wins != null && (
          <div className="text-right shrink-0">
            <div className="text-lg font-black text-nw-teal dark:text-gray-100 tabular-nums leading-none">{team.wins}-{team.losses}</div>
            {team.conf_wins != null && team.conf_wins + team.conf_losses > 0 && (
              <div className="text-[10px] text-gray-400 tabular-nums mt-0.5">{team.conf_wins}-{team.conf_losses} conf</div>
            )}
          </div>
        )}
      </div>

      {/* At-a-glance stat tiles */}
      <div className="grid grid-cols-3 gap-1.5 mb-3">
        <StatTile
          label="Team WAR"
          value={team.team_war != null ? team.team_war.toFixed(1) : '—'}
          sub={team.team_war != null ? `${(team.team_owar ?? 0).toFixed(1)}o / ${(team.team_pwar ?? 0).toFixed(1)}p` : ''}
          accent="border-t-nw-teal-light"
        />
        <StatTile
          label="Run Diff"
          value={rd != null ? `${rd >= 0 ? '+' : ''}${rd}` : '—'}
          sub={team.runs_scored != null ? `${team.runs_scored} / ${team.runs_allowed}` : ''}
          accent={rd == null ? 'border-t-gray-300' : rd >= 0 ? 'border-t-emerald-400' : 'border-t-rose-400'}
        />
        <StatTile
          label="Win %"
          value={winPct != null ? winPct.toFixed(3).replace(/^0/, '') : '—'}
          sub={games ? `${games} G` : ''}
          accent="border-t-violet-400"
        />
      </div>

      {/* Top players */}
      <div className="space-y-1.5">
        {h ? (
          <PlayerLine label="Top Bat" name={`${h.first_name} ${h.last_name}`} meta={h.position}
            stat={`${formatStat(h.woba, 'avg')} wOBA`} war={formatStat(h.offensive_war, 'war')} />
        ) : (
          <div className="text-xs text-gray-400 italic">No qualifying hitters</div>
        )}
        {p ? (
          <PlayerLine label="Top Arm" name={`${p.first_name} ${p.last_name}`} meta={null}
            stat={`${formatStat(p.fip, 'era')} FIP`} war={formatStat(p.pitching_war, 'war')} />
        ) : (
          <div className="text-xs text-gray-400 italic">No qualifying pitchers</div>
        )}
      </div>
    </Link>
  )
}
