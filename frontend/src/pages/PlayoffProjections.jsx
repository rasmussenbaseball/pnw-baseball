import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import StatsLastUpdated from '../components/StatsLastUpdated'

const API_BASE = '/api/v1'

const BADGE_COLORS = {
  D1: 'bg-red-600 text-white',
  D2: 'bg-blue-600 text-white',
  D3: 'bg-green-600 text-white',
  NAIA: 'bg-purple-600 text-white',
  JUCO: 'bg-amber-700 text-white',
}

function formatPct(pct) {
  if (!pct && pct !== 0) return '.000'
  return pct === 1 ? '1.000' : `.${String(Math.round(pct * 1000)).padStart(3, '0')}`
}

function formatRecord(wins, losses) {
  return `${Math.round(wins)}-${Math.round(losses)}`
}

// ─── Projected Conference Standings Table ───
function ProjectedStandingsTable({ conference, playoffTeamCount }) {
  const badgeClass = BADGE_COLORS[conference.division_level] || 'bg-gray-500 text-white'
  const teams = conference.teams || []

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${badgeClass}`}>
          {conference.division_level === 'JUCO' ? 'NWAC' : conference.division_level}
        </span>
        <h3 className="text-sm font-bold text-gray-800 truncate">
          {conference.conference_name}
        </h3>
      </div>

      {/* Table */}
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-[9px] text-gray-400 uppercase tracking-wider">
            <th className="text-left pl-3 pr-1 py-1.5 font-semibold">Team</th>
            <th className="text-center px-1 py-1.5 font-semibold" title="Current overall record">Current</th>
            <th className="text-center px-1 py-1.5 font-semibold" title="Projected final conference record">Proj Conf</th>
            <th className="text-center px-1 py-1.5 font-semibold" title="Projected conference win %">Pct</th>
            <th className="text-center px-1 py-1.5 font-semibold" title="Projected final overall record">Proj All</th>
            <th className="text-center px-1 py-1.5 font-semibold" title="Projected overall win %">Pct</th>
            <th className="text-center px-1 py-1.5 font-semibold" title="Games remaining">Rem</th>
            <th className="text-center px-1 pr-3 py-1.5 font-semibold" title="Power rating">PWR</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((team, i) => {
            const isPlayoffTeam = playoffTeamCount && i < playoffTeamCount
            return (
              <tr
                key={team.team_id}
                className={`border-t border-gray-50 hover:bg-teal-50/50 ${
                  isPlayoffTeam ? '' : 'opacity-60'
                }`}
              >
                <td className="pl-3 pr-1 py-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {isPlayoffTeam && (
                      <span className="text-[9px] font-bold text-teal-600 w-3 text-right shrink-0">
                        {i + 1}
                      </span>
                    )}
                    {!isPlayoffTeam && <span className="w-3 shrink-0" />}
                    {team.logo_url && (
                      <img
                        src={team.logo_url}
                        alt=""
                        className="w-4 h-4 object-contain shrink-0"
                        onError={(e) => { e.target.style.display = 'none' }}
                      />
                    )}
                    <Link
                      to={`/team/${team.team_id}`}
                      className="font-semibold text-gray-800 hover:text-teal-700 truncate"
                    >
                      {team.short_name}
                    </Link>
                  </div>
                </td>
                <td className="text-center px-1 py-1.5 text-gray-500">
                  {team.current_wins}-{team.current_losses}
                </td>
                <td className="text-center px-1 py-1.5 font-medium">
                  {formatRecord(team.projected_conf_wins, team.projected_conf_losses)}
                </td>
                <td className="text-center px-1 py-1.5 font-bold text-pnw-slate">
                  {formatPct(team.projected_conf_win_pct)}
                </td>
                <td className="text-center px-1 py-1.5 font-medium">
                  {formatRecord(team.projected_wins, team.projected_losses)}
                </td>
                <td className="text-center px-1 py-1.5 text-gray-600">
                  {formatPct(team.projected_win_pct)}
                </td>
                <td className="text-center px-1 py-1.5 text-gray-400">
                  {team.games_remaining}
                </td>
                <td className="text-center px-1 pr-3 py-1.5">
                  {team.power_rating ? (
                    <span className="text-[10px] font-bold text-teal-700">{team.power_rating.toFixed(1)}</span>
                  ) : (
                    <span className="text-gray-300">-</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Playoff Bracket Card ───
function PlayoffBracket({ bracket }) {
  const badgeClass = BADGE_COLORS[bracket.division_level] || 'bg-gray-500 text-white'
  const divLabel = bracket.division_level === 'JUCO' ? 'NWAC' : bracket.division_level

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${badgeClass}`}>
          {divLabel}
        </span>
        <h3 className="text-sm font-bold text-gray-800">{bracket.format_name}</h3>
      </div>

      <div className="p-3">
        <p className="text-[10px] text-gray-400 mb-3 italic">{bracket.description}</p>

        <div className="space-y-1.5">
          {bracket.teams.map((team) => (
            <div
              key={team.team_id}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-gray-50 hover:bg-teal-50/50 transition-colors"
            >
              <span className="text-xs font-bold text-teal-600 w-4 text-right shrink-0">
                #{team.seed}
              </span>
              {team.logo_url && (
                <img
                  src={team.logo_url}
                  alt=""
                  className="w-5 h-5 object-contain shrink-0"
                  onError={(e) => { e.target.style.display = 'none' }}
                />
              )}
              <Link
                to={`/team/${team.team_id}`}
                className="text-xs font-semibold text-gray-800 hover:text-teal-700"
              >
                {team.short_name}
              </Link>
              <span className="text-[10px] text-gray-400 ml-auto">
                {team.projected_conf_record} conf
              </span>
              <span className="text-[10px] text-gray-400">
                {team.projected_overall_record} overall
              </span>
              {team.power_rating && (
                <span className="text-[10px] font-bold text-teal-600 ml-1">
                  {team.power_rating.toFixed(1)}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* GNAC pod display */}
        {bracket.pods && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {Object.entries(bracket.pods).map(([podName, seeds]) => (
              <div key={podName} className="bg-gray-50 rounded p-2">
                <p className="text-[9px] font-bold text-gray-400 uppercase mb-1">
                  {podName.replace('_', ' ')}
                </p>
                {seeds.map(seed => {
                  const team = bracket.teams.find(t => t.seed === seed)
                  return team ? (
                    <div key={seed} className="text-[10px] text-gray-600 py-0.5">
                      #{seed} {team.short_name}
                    </div>
                  ) : null
                })}
              </div>
            ))}
          </div>
        )}

        {/* NWAC regional display */}
        {bracket.auto_advance && (
          <div className="mt-3 space-y-2">
            <div className="bg-teal-50 rounded p-2">
              <p className="text-[9px] font-bold text-teal-600 uppercase mb-0.5">Auto-advance to Final 8</p>
              {bracket.auto_advance.map(seed => {
                const team = bracket.teams.find(t => t.seed === seed)
                return team ? (
                  <p key={seed} className="text-[10px] font-medium text-teal-700">
                    #{seed} {team.short_name}
                  </p>
                ) : null
              })}
            </div>
            {bracket.first_round && (
              <div className="bg-gray-50 rounded p-2">
                <p className="text-[9px] font-bold text-gray-400 uppercase mb-0.5">
                  Regional ({bracket.first_round.type.replace('_', ' ')})
                </p>
                <p className="text-[10px] text-gray-600">
                  #{bracket.first_round.matchup[0]} vs #{bracket.first_round.matchup[1]}
                </p>
                <p className="text-[9px] text-gray-400 mt-0.5">
                  Winner plays #{bracket.teams[1]?.seed} ({bracket.second_round?.type?.replace('_', ' ')})
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Page ───
export default function PlayoffProjections() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('standings') // 'standings' or 'brackets'
  const [divFilter, setDivFilter] = useState('all')

  useEffect(() => {
    setLoading(true)
    fetch(`${API_BASE}/playoff-projections?season=2026`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const conferences = data?.conferences || []
  const playoffs = data?.playoffs || []

  // Build a lookup: conference_name -> playoff team count
  const playoffCountByConf = {}
  for (const bracket of playoffs) {
    playoffCountByConf[bracket.conference] = bracket.teams?.length || 0
  }

  // Exclude D1 (no conference playoff format applies to PNW D1 teams)
  const nonD1Conferences = conferences.filter(c => c.division_level !== 'D1')

  // Filter conferences by division
  const filteredConferences = divFilter === 'all'
    ? nonD1Conferences
    : nonD1Conferences.filter(c => c.division_level === divFilter)

  const filteredPlayoffs = divFilter === 'all'
    ? playoffs
    : playoffs.filter(b => b.division_level === divFilter)

  const DIVISIONS = ['all', 'D2', 'D3', 'NAIA', 'JUCO']

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-pnw-slate">Playoff Projections</h1>
        <p className="text-sm text-gray-400 mt-1">
          Projected end-of-season standings and playoff fields based on remaining schedules and power ratings
        </p>
        {data?.schedule_last_updated && (
          <p className="text-[10px] text-gray-300 mt-1">
            Schedules updated: {new Date(data.schedule_last_updated).toLocaleDateString()}
            {' - '}{data.total_future_games} games remaining
          </p>
        )}
      </div>

      {/* Controls */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6 space-y-3">
        <div className="flex flex-wrap gap-4">
          {/* View toggle */}
          <div>
            <span className="text-xs font-bold text-gray-400 uppercase tracking-wide mr-3">View</span>
            <div className="inline-flex gap-1 bg-gray-100 rounded-lg p-1">
              {[
                { key: 'standings', label: 'Projected Standings' },
                { key: 'brackets', label: 'Playoff Fields' },
              ].map(v => (
                <button
                  key={v.key}
                  onClick={() => setView(v.key)}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
                    view === v.key
                      ? 'bg-white text-pnw-slate shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>

          {/* Division filter */}
          <div>
            <span className="text-xs font-bold text-gray-400 uppercase tracking-wide mr-3">Division</span>
            <div className="inline-flex gap-1 bg-gray-100 rounded-lg p-1">
              {DIVISIONS.map(d => (
                <button
                  key={d}
                  onClick={() => setDivFilter(d)}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
                    divFilter === d
                      ? 'bg-white text-pnw-slate shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {d === 'all' ? 'All' : d === 'JUCO' ? 'NWAC' : d}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="animate-spin h-8 w-8 border-4 border-teal-500 border-t-transparent rounded-full" />
        </div>
      )}

      {!loading && data && view === 'standings' && (
        <div className="space-y-4">
          <p className="text-xs text-gray-400 italic">
            Projected records use power ratings and Elo win probability for each remaining game.
            Playoff-bound teams are highlighted with their projected seed.
          </p>
          {filteredConferences.map(conf => (
            <ProjectedStandingsTable
              key={conf.conference_name}
              conference={conf}
              playoffTeamCount={playoffCountByConf[conf.conference_name] || 0}
            />
          ))}
          {filteredConferences.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">
              No schedule data available yet. Run the future schedule scraper to generate projections.
            </p>
          )}
        </div>
      )}

      {!loading && data && view === 'brackets' && (
        <div className="space-y-4">
          <p className="text-xs text-gray-400 italic">
            Projected playoff fields based on each conference's tournament format and projected conference standings.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredPlayoffs.map(bracket => (
              <PlayoffBracket
                key={bracket.conference}
                bracket={bracket}
              />
            ))}
          </div>
          {filteredPlayoffs.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">
              No playoff projection data available yet.
            </p>
          )}
        </div>
      )}

      <StatsLastUpdated />
    </div>
  )
}
