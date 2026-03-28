import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStandings } from '../hooks/useApi'

// Division level → badge color classes
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

// ─── Compact conference standings table ───
function ConferenceTable({ conference }) {
  const badgeClass = BADGE_COLORS[conference.division_level] || 'bg-gray-500 text-white'

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${badgeClass}`}>
          {conference.division_level}
        </span>
        <h3 className="text-sm font-bold text-gray-800 truncate">
          {conference.conference_name}
        </h3>
      </div>

      {/* Table */}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-gray-500 uppercase tracking-wider">
            <th className="text-left pl-3 pr-1 py-1.5 font-semibold">Team</th>
            <th className="text-center px-1 py-1.5 font-semibold w-16">Conf</th>
            <th className="text-center px-1 py-1.5 font-semibold w-16">Overall</th>
            <th className="text-center px-1 pr-3 py-1.5 font-semibold w-12">Pct</th>
          </tr>
        </thead>
        <tbody>
          {conference.teams.map((team, i) => (
            <tr
              key={team.id}
              className={`border-t border-gray-50 transition-colors ${
                team.is_pnw
                  ? 'hover:bg-teal-50/50'
                  : 'opacity-50'
              }`}
            >
              <td className="pl-3 pr-1 py-1.5">
                {team.is_pnw ? (
                  <Link
                    to={`/team/${team.id}`}
                    className="flex items-center gap-1.5 hover:text-nw-teal transition-colors"
                  >
                    {team.logo_url && (
                      <img
                        src={team.logo_url}
                        alt=""
                        className="w-4 h-4 object-contain shrink-0"
                        onError={(e) => { e.target.style.display = 'none' }}
                      />
                    )}
                    <span className="font-semibold text-nw-teal truncate">{team.short_name}</span>
                  </Link>
                ) : (
                  <div className="flex items-center gap-1.5">
                    {team.logo_url && (
                      <img
                        src={team.logo_url}
                        alt=""
                        className="w-4 h-4 object-contain shrink-0 grayscale"
                        onError={(e) => { e.target.style.display = 'none' }}
                      />
                    )}
                    <span className="font-medium text-gray-400 truncate">{team.short_name}</span>
                  </div>
                )}
              </td>
              <td className={`text-center px-1 py-1.5 ${team.is_pnw ? 'text-gray-600' : 'text-gray-400'}`}>
                {team.conf_wins || team.conf_losses
                  ? `${team.conf_wins}-${team.conf_losses}`
                  : <span className="text-gray-300">-</span>
                }
              </td>
              <td className={`text-center px-1 py-1.5 ${team.is_pnw ? 'text-gray-600' : 'text-gray-400'}`}>
                {team.wins || team.losses
                  ? `${team.wins}-${team.losses}`
                  : <span className="text-gray-300">-</span>
                }
              </td>
              <td className={`text-center px-1 pr-3 py-1.5 font-mono ${team.is_pnw ? 'text-gray-500' : 'text-gray-400'}`}>
                {team.conf_wins || team.conf_losses
                  ? formatPct(team.conf_win_pct)
                  : <span className="text-gray-300">-</span>
                }
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Overall PNW Standings table ───
function OverallTable({ teams }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100">
        <h3 className="text-base font-bold text-gray-800">Overall PNW Standings</h3>
        <p className="text-xs text-gray-500 mt-0.5">All 57 teams ranked by overall win percentage</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-gray-500 uppercase tracking-wider bg-gray-50">
              <th className="text-center px-2 py-2 font-semibold w-8">#</th>
              <th className="text-left pl-3 pr-1 py-2 font-semibold">Team</th>
              <th className="text-center px-2 py-2 font-semibold w-12">Div</th>
              <th className="text-center px-2 py-2 font-semibold w-14">Conf</th>
              <th className="text-center px-2 py-2 font-semibold w-16">Overall</th>
              <th className="text-center px-2 py-2 font-semibold w-12">Pct</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((team, i) => {
              const badgeClass = BADGE_COLORS[team.division_level] || 'bg-gray-500 text-white'
              return (
                <tr
                  key={team.id}
                  className={`border-t border-gray-50 hover:bg-teal-50/50 transition-colors ${i < 3 ? 'bg-amber-50/30' : ''}`}
                >
                  <td className="text-center px-2 py-1.5 text-gray-400 font-mono">{i + 1}</td>
                  <td className="pl-3 pr-1 py-1.5">
                    <Link
                      to={`/team/${team.id}`}
                      className="flex items-center gap-1.5 hover:text-nw-teal transition-colors"
                    >
                      {team.logo_url && (
                        <img
                          src={team.logo_url}
                          alt=""
                          className="w-4 h-4 object-contain shrink-0"
                          onError={(e) => { e.target.style.display = 'none' }}
                        />
                      )}
                      <span className="font-medium text-gray-800">{team.short_name}</span>
                    </Link>
                  </td>
                  <td className="text-center px-2 py-1.5">
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${badgeClass}`}>
                      {team.division_level}
                    </span>
                  </td>
                  <td className="text-center px-2 py-1.5 text-gray-500">
                    {team.conference_abbrev}
                  </td>
                  <td className="text-center px-2 py-1.5 text-gray-600 font-medium">
                    {team.wins}-{team.losses}
                  </td>
                  <td className="text-center px-2 py-1.5 font-mono text-gray-700 font-medium">
                    {formatPct(team.win_pct)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Main Standings Page ───
export default function StandingsPage() {
  const [view, setView] = useState('conference') // 'conference' | 'overall'
  const { data, loading, error } = useStandings(2026)

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-nw-teal border-t-transparent" />
      </div>
    )
  }

  if (error) {
    return <div className="text-center text-red-600 py-10">Error loading standings: {error}</div>
  }

  const conferences = data?.conferences || []
  // Overall table: only PNW teams (non-PNW won't have stats)
  const overall = (data?.overall || []).filter(t => t.is_pnw)

  // Group conferences by division for visual grouping
  const divisionGroups = {}
  conferences.forEach(conf => {
    const dName = conf.division_name
    if (!divisionGroups[dName]) {
      divisionGroups[dName] = { name: dName, level: conf.division_level, conferences: [] }
    }
    divisionGroups[dName].conferences.push(conf)
  })
  // Filter out conferences with no teams
  Object.keys(divisionGroups).forEach(key => {
    divisionGroups[key].conferences = divisionGroups[key].conferences.filter(c => c.teams.length > 0)
    if (divisionGroups[key].conferences.length === 0) delete divisionGroups[key]
  })

  const divOrder = ['NCAA D1', 'NCAA D2', 'NCAA D3', 'NAIA', 'NWAC']
  const sortedDivisions = divOrder.filter(d => divisionGroups[d]).map(d => divisionGroups[d])

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-pnw-slate">Standings</h1>
        <div className="flex bg-gray-100 rounded-lg p-0.5">
          <button
            onClick={() => setView('conference')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              view === 'conference'
                ? 'bg-white text-nw-teal shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Conference
          </button>
          <button
            onClick={() => setView('overall')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              view === 'overall'
                ? 'bg-white text-nw-teal shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Overall PNW
          </button>
        </div>
      </div>

      {view === 'conference' ? (
        <div className="space-y-6">
          {sortedDivisions.map(div => {
            const confs = div.conferences
            // Separate small conferences (<=3 teams) from large ones
            const smallConfs = confs.filter(c => c.teams.length <= 3)
            const largeConfs = confs.filter(c => c.teams.length > 3)

            return (
              <div key={div.name}>
                <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-2">
                  {div.name}
                </h2>
                <div className={`grid gap-3 ${
                  confs.length >= 3 ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3' :
                  confs.length === 2 ? 'grid-cols-1 md:grid-cols-2' :
                  largeConfs.length === 1 && smallConfs.length > 0 ? 'grid-cols-1 md:grid-cols-2' :
                  'grid-cols-1 md:grid-cols-2'
                }`}>
                  {/* Large conferences render normally */}
                  {largeConfs.map(conf => (
                    <ConferenceTable key={conf.conference_id} conference={conf} />
                  ))}
                  {/* Stack small conferences in one column */}
                  {smallConfs.length > 0 && (
                    <div className="flex flex-col gap-3">
                      {smallConfs.map(conf => (
                        <ConferenceTable key={conf.conference_id} conference={conf} />
                      ))}
                    </div>
                  )}
                  {/* If no small/large split needed, render single conference */}
                  {smallConfs.length === 0 && largeConfs.length === 0 && confs.map(conf => (
                    <ConferenceTable key={conf.conference_id} conference={conf} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <OverallTable teams={overall} />
      )}
    </div>
  )
}
