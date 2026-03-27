import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTeamRatings } from '../hooks/useApi'

const BADGE_COLORS = {
  D1: 'bg-red-600 text-white',
  D2: 'bg-blue-600 text-white',
  D3: 'bg-green-600 text-white',
  NAIA: 'bg-purple-600 text-white',
  JUCO: 'bg-amber-700 text-white',
}

// PPI color: green for high, yellow for mid, red for low
function ppiColor(ppi) {
  if (ppi >= 65) return 'text-emerald-700'
  if (ppi >= 55) return 'text-emerald-600'
  if (ppi >= 45) return 'text-gray-700'
  if (ppi >= 35) return 'text-orange-600'
  return 'text-red-600'
}

function ppiBg(ppi) {
  if (ppi >= 65) return 'bg-emerald-50'
  if (ppi >= 55) return 'bg-emerald-50/50'
  if (ppi >= 45) return ''
  if (ppi >= 35) return 'bg-orange-50/50'
  return 'bg-red-50/50'
}

// Mini bar chart for a 0-100 score
function ScoreBar({ value, color = 'bg-nw-teal' }) {
  const width = Math.max(2, Math.min(100, value))
  return (
    <div className="w-full bg-gray-100 rounded-full h-1.5">
      <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${width}%` }} />
    </div>
  )
}

function scoreBarColor(val) {
  if (val >= 65) return 'bg-emerald-500'
  if (val >= 55) return 'bg-emerald-400'
  if (val >= 45) return 'bg-gray-400'
  if (val >= 35) return 'bg-orange-400'
  return 'bg-red-400'
}

// ─── Division PPI table ───
function DivisionTable({ division }) {
  const badgeClass = BADGE_COLORS[division.division_level] || 'bg-gray-500 text-white'

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden mb-5">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
        <span className={`text-xs font-bold px-2 py-0.5 rounded ${badgeClass}`}>
          {division.division_level}
        </span>
        <h3 className="text-base font-bold text-gray-800">{division.division_name}</h3>
        <span className="text-xs text-gray-400 ml-auto">{division.teams.length} teams</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-gray-500 uppercase tracking-wider bg-gray-50">
              <th className="text-center px-2 py-2 font-semibold w-8">#</th>
              <th className="text-left pl-3 pr-1 py-2 font-semibold">Team</th>
              <th className="text-center px-2 py-2 font-semibold w-14">PPI</th>
              <th className="text-center px-2 py-2 font-semibold w-16">Record</th>
              <th className="text-center px-1 py-2 font-semibold w-12" title="Team WAR component">
                <span className="hidden sm:inline">WAR</span>
                <span className="sm:hidden">W</span>
              </th>
              <th className="text-center px-1 py-2 font-semibold w-12" title="Offensive rating (wRC+)">
                <span className="hidden sm:inline">Off</span>
                <span className="sm:hidden">O</span>
              </th>
              <th className="text-center px-1 py-2 font-semibold w-12" title="Pitching rating (FIP)">
                <span className="hidden sm:inline">Pitch</span>
                <span className="sm:hidden">P</span>
              </th>
              <th className="text-center px-1 py-2 font-semibold w-12" title="Win percentage component">
                <span className="hidden sm:inline">Win</span>
                <span className="sm:hidden">W%</span>
              </th>
              <th className="text-center px-1 py-2 font-semibold w-12" title="Conference win% component">
                <span className="hidden sm:inline">Conf</span>
                <span className="sm:hidden">C</span>
              </th>
              <th className="text-left px-2 py-2 font-semibold w-24 hidden md:table-cell">Breakdown</th>
            </tr>
          </thead>
          <tbody>
            {division.teams.map((team) => (
              <tr
                key={team.id}
                className={`border-t border-gray-50 hover:bg-teal-50/40 transition-colors ${ppiBg(team.ppi)}`}
              >
                {/* Rank */}
                <td className="text-center px-2 py-2 font-mono text-gray-400">{team.ppi_rank}</td>

                {/* Team */}
                <td className="pl-3 pr-1 py-2">
                  <Link
                    to={`/team/${team.id}`}
                    className="flex items-center gap-1.5 hover:text-nw-teal transition-colors"
                  >
                    {team.logo_url && (
                      <img
                        src={team.logo_url}
                        alt=""
                        className="w-5 h-5 object-contain shrink-0"
                        onError={(e) => { e.target.style.display = 'none' }}
                      />
                    )}
                    <span className="font-medium text-gray-800 truncate">{team.short_name}</span>
                  </Link>
                </td>

                {/* PPI */}
                <td className={`text-center px-2 py-2 font-bold text-sm tabular-nums ${ppiColor(team.ppi)}`}>
                  {team.ppi.toFixed(1)}
                </td>

                {/* Record */}
                <td className="text-center px-2 py-2 text-gray-600">
                  {team.wins}-{team.losses}
                </td>

                {/* Component scores */}
                <td className={`text-center px-1 py-2 tabular-nums ${ppiColor(team.war_score)}`}>{Math.round(team.war_score)}</td>
                <td className={`text-center px-1 py-2 tabular-nums ${ppiColor(team.off_score)}`}>{Math.round(team.off_score)}</td>
                <td className={`text-center px-1 py-2 tabular-nums ${ppiColor(team.pitch_score)}`}>{Math.round(team.pitch_score)}</td>
                <td className={`text-center px-1 py-2 tabular-nums ${ppiColor(team.win_score)}`}>{Math.round(team.win_score)}</td>
                <td className={`text-center px-1 py-2 tabular-nums ${ppiColor(team.conf_score)}`}>{Math.round(team.conf_score)}</td>

                {/* Visual breakdown bar */}
                <td className="px-2 py-2 hidden md:table-cell">
                  <ScoreBar value={team.ppi} color={scoreBarColor(team.ppi)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Info card explaining PPI ───
function InfoCard() {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden mb-5">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-2.5 flex items-center justify-between text-left hover:bg-gray-50 transition-colors"
      >
        <span className="text-xs font-semibold text-gray-600">How PPI Works</span>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="px-4 pb-3 text-xs text-gray-600 space-y-2 border-t border-gray-100 pt-2.5">
          <p>
            The <strong>PNW Power Index (PPI)</strong> rates each team on a 0–100 scale relative to their division peers. A score of 50 is exactly average for the division; 65+ is elite, 35 or below is struggling.
          </p>
          <p className="font-semibold text-gray-700">Components:</p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <div className="bg-gray-50 rounded p-2 text-center">
              <p className="font-bold text-nw-teal">35%</p>
              <p className="text-[10px] text-gray-500">Team WAR</p>
            </div>
            <div className="bg-gray-50 rounded p-2 text-center">
              <p className="font-bold text-nw-teal">20%</p>
              <p className="text-[10px] text-gray-500">Offense (wRC+)</p>
            </div>
            <div className="bg-gray-50 rounded p-2 text-center">
              <p className="font-bold text-nw-teal">20%</p>
              <p className="text-[10px] text-gray-500">Pitching (FIP)</p>
            </div>
            <div className="bg-gray-50 rounded p-2 text-center">
              <p className="font-bold text-nw-teal">15%</p>
              <p className="text-[10px] text-gray-500">Win %</p>
            </div>
            <div className="bg-gray-50 rounded p-2 text-center">
              <p className="font-bold text-nw-teal">10%</p>
              <p className="text-[10px] text-gray-500">Conf Win %</p>
            </div>
          </div>
          <p>
            Each component is z-score normalized within the division. So a score of 65 in "Off" means that team's offense is one standard deviation above its division average. Teams are only compared to their direct peers, not across divisions.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ───
export default function TeamRatings() {
  const { data, loading, error } = useTeamRatings(2026)

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-nw-teal border-t-transparent" />
      </div>
    )
  }

  if (error) {
    return <div className="text-center text-red-600 py-10">Error loading team ratings: {error}</div>
  }

  const divisions = data || []

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Team Ratings</h1>
      <p className="text-sm text-gray-500 mb-4">PNW Power Index | within-division talent rankings · 2026</p>

      <InfoCard />

      {divisions.map(div => (
        <DivisionTable key={div.division_id} division={div} />
      ))}
    </div>
  )
}
