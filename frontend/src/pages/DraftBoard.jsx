import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { DRAFT_DATA, DRAFT_YEARS, getSchoolLogo } from '../data/draftData'
import { formatStat } from '../utils/stats'

const POS_COLORS = {
  SS: 'bg-blue-100 text-blue-800',
  C: 'bg-amber-100 text-amber-800',
  RHP: 'bg-red-100 text-red-800',
  LHP: 'bg-emerald-100 text-emerald-800',
  OF: 'bg-purple-100 text-purple-800',
  '1B': 'bg-orange-100 text-orange-800',
  '2B': 'bg-cyan-100 text-cyan-800',
  '3B': 'bg-pink-100 text-pink-800',
  IF: 'bg-blue-100 text-blue-800',
  INF: 'bg-blue-100 text-blue-800',
  P: 'bg-rose-100 text-rose-800',
  TWP: 'bg-rose-100 text-rose-800',
  'OF/3B': 'bg-violet-100 text-violet-800',
  UTIL: 'bg-teal-100 text-teal-800',
  CF: 'bg-purple-100 text-purple-800',
}

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T12:00:00')
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  } catch { return dateStr }
}


// ─── Expandable player stats row ──────────────────────────────
function PlayerStatsDropdown({ playerId }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!playerId) { setLoading(false); return }
    fetch(`/api/v1/players/${playerId}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [playerId])

  if (loading) {
    return (
      <div className="px-4 py-3 text-xs text-gray-400">Loading stats...</div>
    )
  }

  if (!playerId) {
    return (
      <div className="px-4 py-3">
        <p className="text-xs text-gray-400 italic">High school prospect -- no college stats available yet.</p>
        <p className="text-[10px] text-gray-300 mt-1">Scouting report coming soon.</p>
      </div>
    )
  }

  if (!data) {
    return <div className="px-4 py-3 text-xs text-gray-400">Unable to load stats.</div>
  }

  const player = data.player || {}
  const batting = data.batting_stats || []
  const pitching = data.pitching_stats || []
  const latestBat = batting.length > 0 ? batting[batting.length - 1] : null
  const latestPitch = pitching.length > 0 ? pitching[pitching.length - 1] : null

  return (
    <div className="px-4 py-3 space-y-2">
      {/* Player info row */}
      <div className="flex items-center gap-2">
        {player.headshot_url && (
          <img src={player.headshot_url} alt="" className="w-10 h-10 rounded-full object-cover border border-gray-200" />
        )}
        <div>
          <div className="text-xs text-gray-500">
            {[player.position, player.year_in_school, player.bats && player.throws ? `${player.bats}/${player.throws}` : null].filter(Boolean).join(' · ')}
          </div>
          <Link to={`/player/${playerId}`} className="text-xs text-nw-teal hover:underline font-medium">
            View full profile →
          </Link>
        </div>
      </div>

      {/* Batting stats */}
      {latestBat && (
        <div>
          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
            {latestBat.season} Batting
          </div>
          <div className="grid grid-cols-6 gap-1">
            {[
              { label: 'AVG', value: formatStat(latestBat.batting_avg, 'avg') },
              { label: 'OBP', value: formatStat(latestBat.on_base_pct, 'avg') },
              { label: 'SLG', value: formatStat(latestBat.slugging_pct, 'avg') },
              { label: 'HR', value: latestBat.home_runs ?? '-' },
              { label: 'RBI', value: latestBat.rbi ?? '-' },
              { label: 'oWAR', value: formatStat(latestBat.offensive_war, 'war') },
            ].map(s => (
              <div key={s.label} className="text-center bg-gray-50 rounded px-1 py-1">
                <div className="text-[9px] text-gray-400 font-medium">{s.label}</div>
                <div className="text-xs font-bold text-gray-800">{s.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pitching stats */}
      {latestPitch && (
        <div>
          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
            {latestPitch.season} Pitching
          </div>
          <div className="grid grid-cols-6 gap-1">
            {[
              { label: 'ERA', value: formatStat(latestPitch.era, 'era') },
              { label: 'IP', value: formatStat(latestPitch.innings_pitched, 'ip') },
              { label: 'K', value: latestPitch.strikeouts ?? '-' },
              { label: 'WHIP', value: formatStat(latestPitch.whip, 'era') },
              { label: 'FIP', value: formatStat(latestPitch.fip, 'era') },
              { label: 'pWAR', value: formatStat(latestPitch.pitching_war, 'war') },
            ].map(s => (
              <div key={s.label} className="text-center bg-gray-50 rounded px-1 py-1">
                <div className="text-[9px] text-gray-400 font-medium">{s.label}</div>
                <div className="text-xs font-bold text-gray-800">{s.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!latestBat && !latestPitch && (
        <p className="text-xs text-gray-400 italic">No stats available yet this season.</p>
      )}

      <p className="text-[10px] text-gray-300 mt-1">Scouting report coming soon.</p>
    </div>
  )
}


// ─── Main DraftBoard page ──────────────────────────────────────
export default function DraftBoard({ year }) {
  const [activeYear, setActiveYear] = useState(year || '26')
  const [expandedRank, setExpandedRank] = useState(null)
  const board = DRAFT_DATA[activeYear]

  const toggleExpand = (rank) => {
    setExpandedRank(expandedRank === rank ? null : rank)
  }

  // Reset expanded row when switching years
  useEffect(() => { setExpandedRank(null) }, [activeYear])

  return (
    <div>
      {/* Header + Year Tabs */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-pnw-slate mb-1">PNW MLB Draft Board</h1>
        <p className="text-sm text-gray-500 mb-4">
          Top PNW prospects for the MLB Draft
        </p>
        <div className="inline-flex bg-gray-200 rounded-lg p-1 gap-1">
          {DRAFT_YEARS.map((yr) => (
            <button
              key={yr}
              onClick={() => setActiveYear(yr)}
              className={`px-5 py-2 rounded-md text-sm font-bold transition-all ${
                activeYear === yr
                  ? 'bg-pnw-teal text-white shadow-md'
                  : 'bg-white text-gray-700 hover:bg-gray-50 shadow-sm'
              }`}
            >
              20{yr}
            </button>
          ))}
        </div>
      </div>

      {/* Subtitle + Last Updated */}
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-700">
          {board.year} Draft - {board.prospects.length} Prospects
        </h2>
        {board.lastUpdated && (
          <span className="text-xs text-gray-400">
            Last updated {formatDate(board.lastUpdated)}
          </span>
        )}
      </div>

      {/* Desktop table */}
      <div className="hidden sm:block bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider w-12">Rank</th>
              <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Player</th>
              <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider w-20">Pos</th>
              <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">School</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {board.prospects.map((p) => {
              const posClass = POS_COLORS[p.pos] || 'bg-gray-100 text-gray-800'
              const isExpanded = expandedRank === p.rank
              const logo = getSchoolLogo(p.school)
              return (
                <tr key={p.rank} className="group" style={{ cursor: 'default' }}>
                  <td colSpan={5} className="p-0">
                    <div
                      onClick={() => toggleExpand(p.rank)}
                      className={`flex items-center px-4 py-3 cursor-pointer transition-colors ${isExpanded ? 'bg-teal-50/60' : 'hover:bg-teal-50/40'}`}
                    >
                      <div className="w-12 shrink-0">
                        <span className={`text-sm font-bold ${p.rank <= 3 ? 'text-amber-600' : 'text-gray-400'}`}>
                          {p.rank}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <img
                          src={logo}
                          alt=""
                          className="w-6 h-6 object-contain shrink-0"
                          onError={(e) => { e.target.src = '/favicon.png' }}
                        />
                        <div>
                          {p.playerId ? (
                            <Link
                              to={`/player/${p.playerId}`}
                              onClick={(e) => e.stopPropagation()}
                              className="text-sm font-semibold text-gray-900 hover:text-nw-teal transition-colors"
                            >
                              {p.name}
                            </Link>
                          ) : (
                            <span className="text-sm font-semibold text-gray-900">{p.name}</span>
                          )}
                        </div>
                      </div>
                      <div className="w-20 shrink-0">
                        <span className={`inline-block px-2 py-0.5 text-xs font-bold rounded ${posClass}`}>
                          {p.pos}
                        </span>
                      </div>
                      <div className="flex-1 text-sm text-gray-600">{p.school}</div>
                      <div className="w-8 flex items-center justify-center shrink-0">
                        <svg
                          className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                          fill="none" stroke="currentColor" viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="bg-gray-50/80 border-t border-gray-100">
                        <PlayerStatsDropdown playerId={p.playerId} />
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="sm:hidden space-y-2">
        {board.prospects.map((p) => {
          const posClass = POS_COLORS[p.pos] || 'bg-gray-100 text-gray-800'
          const isExpanded = expandedRank === p.rank
          const logo = getSchoolLogo(p.school)
          return (
            <div key={p.rank} className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div
                onClick={() => toggleExpand(p.rank)}
                className={`px-4 py-3 flex items-center gap-3 cursor-pointer ${isExpanded ? 'bg-teal-50/60' : ''}`}
              >
                <span className={`text-lg font-bold w-8 text-center shrink-0 ${p.rank <= 3 ? 'text-amber-600' : 'text-gray-400'}`}>
                  {p.rank}
                </span>
                <img
                  src={logo}
                  alt=""
                  className="w-6 h-6 object-contain shrink-0"
                  onError={(e) => { e.target.src = '/favicon.png' }}
                />
                <div className="flex-1 min-w-0">
                  {p.playerId ? (
                    <Link
                      to={`/player/${p.playerId}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-sm font-semibold text-gray-900 hover:text-nw-teal transition-colors block truncate"
                    >
                      {p.name}
                    </Link>
                  ) : (
                    <span className="text-sm font-semibold text-gray-900 block truncate">{p.name}</span>
                  )}
                  <span className="text-xs text-gray-500">{p.school}</span>
                </div>
                <span className={`inline-block px-2 py-0.5 text-xs font-bold rounded shrink-0 ${posClass}`}>
                  {p.pos}
                </span>
                <svg
                  className={`w-4 h-4 text-gray-400 transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
              {isExpanded && (
                <div className="bg-gray-50/80 border-t border-gray-100">
                  <PlayerStatsDropdown playerId={p.playerId} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
