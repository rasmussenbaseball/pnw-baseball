import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useNationalRankings } from '../hooks/useApi'

const BADGE_COLORS = {
  D1: 'bg-red-600 text-white',
  D2: 'bg-blue-600 text-white',
  D3: 'bg-green-600 text-white',
  NAIA: 'bg-purple-600 text-white',
  JUCO: 'bg-amber-700 text-white',
}

function percentileColor(pct) {
  if (pct >= 90) return 'text-emerald-700 font-bold'
  if (pct >= 75) return 'text-emerald-600'
  if (pct >= 50) return 'text-gray-700'
  if (pct >= 25) return 'text-orange-600'
  return 'text-red-600'
}

function percentileBg(pct) {
  if (pct >= 90) return 'bg-emerald-50'
  if (pct >= 75) return 'bg-emerald-50/50'
  if (pct >= 50) return ''
  if (pct >= 25) return 'bg-orange-50/50'
  return 'bg-red-50/50'
}

function PercentileBar({ value }) {
  if (!value && value !== 0) return <span className="text-gray-400 text-xs">-</span>
  const width = Math.max(2, Math.min(100, value))
  const color = value >= 75 ? 'bg-emerald-500' : value >= 50 ? 'bg-teal-400' : value >= 25 ? 'bg-orange-400' : 'bg-red-400'
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 bg-gray-100 rounded-full h-2">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${width}%` }} />
      </div>
      <span className={`text-xs font-medium ${percentileColor(value)}`}>{value.toFixed(1)}%</span>
    </div>
  )
}

function SourceBadge({ source, rank, total }) {
  if (!rank) return null
  const colors = {
    pear: 'bg-green-100 text-green-800 border-green-200',
    cbr: 'bg-purple-100 text-purple-800 border-purple-200',
  }
  const labels = { pear: 'Pear', cbr: 'CBR' }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${colors[source] || 'bg-gray-100 text-gray-700 border-gray-200'}`}>
      {labels[source] || source} #{rank}
      {total ? <span className="text-gray-400 ml-0.5">/{total}</span> : null}
    </span>
  )
}

function SosRankBadge({ rank, label }) {
  if (!rank && rank !== 0) return null
  return (
    <span className="text-xs text-gray-500" title={`${label} SOS Rank`}>
      {label}: #{typeof rank === 'number' ? Math.round(rank) : rank}
    </span>
  )
}

// ─── Division Rankings Table ───
function DivisionSection({ division }) {
  const [expanded, setExpanded] = useState(true)
  const badgeClass = BADGE_COLORS[division.division_level] || 'bg-gray-500 text-white'
  const hasData = division.teams.some(t => t.composite_rank)

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className={`px-2.5 py-1 rounded-md text-xs font-bold ${badgeClass}`}>
            {division.division_level}
          </span>
          <h3 className="text-lg font-bold text-gray-900">{division.division_name}</h3>
          <span className="text-sm text-gray-400">({division.teams.length} teams)</span>
        </div>
        <svg className={`w-5 h-5 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
             fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {division.note && (
        <div className="px-5 pb-2">
          <p className="text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg">{division.note}</p>
        </div>
      )}

      {/* Table */}
      {expanded && hasData && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 uppercase tracking-wider border-t border-b border-gray-100 bg-gray-50/50">
                <th className="text-left px-5 py-2.5 w-12">Comp.</th>
                <th className="text-left px-3 py-2.5">Team</th>
                <th className="text-left px-3 py-2.5">Record</th>
                <th className="text-left px-3 py-2.5">Source Rankings</th>
                <th className="text-left px-3 py-2.5">SOS</th>
                <th className="text-left px-3 py-2.5">Natl Percentile</th>
              </tr>
            </thead>
            <tbody>
              {division.teams.map((team, idx) => (
                <tr key={team.team_id}
                    className={`border-b border-gray-50 hover:bg-nw-cream/30 transition-colors ${percentileBg(team.national_percentile || 0)}`}>
                  {/* Composite Rank */}
                  <td className="px-5 py-3">
                    <span className="text-lg font-bold text-gray-900">
                      #{team.composite_rank ? team.composite_rank.toFixed(0) : '-'}
                    </span>
                  </td>

                  {/* Team */}
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2.5">
                      {team.logo_url && (
                        <img src={team.logo_url} alt="" className="w-7 h-7 object-contain" />
                      )}
                      <div>
                        <Link to={`/team/${team.team_id}`}
                              className="font-semibold text-gray-900 hover:text-nw-teal transition-colors">
                          {team.short_name}
                        </Link>
                        <p className="text-xs text-gray-400">{team.conference_name}</p>
                      </div>
                    </div>
                  </td>

                  {/* Record */}
                  <td className="px-3 py-3">
                    <span className="font-medium">{team.record}</span>
                    <span className="text-xs text-gray-400 ml-1">
                      ({(team.win_pct * 100).toFixed(0)}%)
                    </span>
                  </td>

                  {/* Source Rankings */}
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      <SourceBadge source="pear" rank={team.pear_rank} total={team.sources?.pear?.total_teams} />
                      <SourceBadge source="cbr" rank={team.cbr_rank} total={team.sources?.cbr?.total_teams} />
                    </div>
                  </td>

                  {/* SOS */}
                  <td className="px-3 py-3">
                    <div className="flex flex-col gap-0.5">
                      {team.composite_sos_rank != null && (
                        <span className="text-xs font-medium text-gray-700">
                          SOS #{Math.round(team.composite_sos_rank)}
                        </span>
                      )}
                      <div className="flex gap-2">
                        {team.sources?.pear?.sos_rank != null && <SosRankBadge rank={team.sources.pear.sos_rank} label="P" />}
                        {team.sources?.cbr?.sos_rank != null && <SosRankBadge rank={team.sources.cbr.sos_rank} label="C" />}
                      </div>
                    </div>
                  </td>

                  {/* National Percentile */}
                  <td className="px-3 py-3">
                    <PercentileBar value={team.national_percentile} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* JUCO fallback - no composite data */}
      {expanded && !hasData && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 uppercase tracking-wider border-t border-b border-gray-100 bg-gray-50/50">
                <th className="text-left px-5 py-2.5 w-8">#</th>
                <th className="text-left px-3 py-2.5">Team</th>
                <th className="text-left px-3 py-2.5">Record</th>
                <th className="text-left px-3 py-2.5">Win %</th>
              </tr>
            </thead>
            <tbody>
              {division.teams.map((team, idx) => (
                <tr key={team.team_id} className="border-b border-gray-50 hover:bg-nw-cream/30">
                  <td className="px-5 py-2.5 text-gray-400 font-medium">{idx + 1}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      {team.logo_url && <img src={team.logo_url} alt="" className="w-6 h-6 object-contain" />}
                      <Link to={`/team/${team.team_id}`}
                            className="font-medium text-gray-900 hover:text-nw-teal">
                        {team.short_name}
                      </Link>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">{team.record}</td>
                  <td className="px-3 py-2.5">{(team.win_pct * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Cross-Division Comparison ───
function CrossDivisionTable({ teams }) {
  if (!teams || teams.length === 0) return null

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100">
        <h3 className="text-lg font-bold text-gray-900">Cross-Division Comparison</h3>
        <p className="text-sm text-gray-500 mt-1">
          All PNW teams ranked by their national percentile within their division.
          Higher percentile = stronger relative to peers nationally.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-100 bg-gray-50/50">
              <th className="text-left px-5 py-2.5 w-8">#</th>
              <th className="text-left px-3 py-2.5">Team</th>
              <th className="text-left px-3 py-2.5">Division</th>
              <th className="text-left px-3 py-2.5">Record</th>
              <th className="text-left px-3 py-2.5">Natl Rank</th>
              <th className="text-left px-3 py-2.5">Natl Percentile</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((team, idx) => {
              const badgeClass = BADGE_COLORS[team.division_level] || 'bg-gray-500 text-white'
              return (
                <tr key={team.team_id}
                    className={`border-b border-gray-50 hover:bg-nw-cream/30 ${percentileBg(team.national_percentile || 0)}`}>
                  <td className="px-5 py-2.5 font-bold text-gray-400">{idx + 1}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      {team.logo_url && <img src={team.logo_url} alt="" className="w-6 h-6 object-contain" />}
                      <Link to={`/team/${team.team_id}`}
                            className="font-semibold text-gray-900 hover:text-nw-teal">
                        {team.short_name}
                      </Link>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${badgeClass}`}>
                      {team.division_level}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">{team.record}</td>
                  <td className="px-3 py-2.5 font-medium">
                    #{team.composite_rank ? team.composite_rank.toFixed(0) : '-'}
                    <span className="text-xs text-gray-400 ml-0.5">
                      ({team.num_sources} src{team.num_sources !== 1 ? 's' : ''})
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <PercentileBar value={team.national_percentile} />
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

// ─── Info Card ───
function InfoCard() {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors"
      >
        <span className="text-sm font-semibold text-gray-700">How National Rankings Work</span>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
             fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="px-5 pb-4 text-sm text-gray-600 space-y-3 border-t border-gray-100 pt-3">
          <p>
            We combine rankings from <strong>3 independent national rating systems</strong> to create a composite ranking for each PNW team within their division:
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="bg-green-50 rounded-lg p-3">
              <p className="font-semibold text-green-800">Pear Ratings (NET)</p>
              <p className="text-xs text-green-700 mt-1">
                Combines Team Strength (TSR), Resume Quality (RQI), and Strength of Schedule (SOS).
                Covers D1, D2, D3, NAIA.
              </p>
            </div>
            <div className="bg-purple-50 rounded-lg p-3">
              <p className="font-semibold text-purple-800">College Baseball Ratings (CBR)</p>
              <p className="text-xs text-purple-700 mt-1">
                Power rating combining preseason expectations and season results,
                plus SOR and Wins Above Bubble. Covers D1, D2, D3, NAIA.
              </p>
            </div>
          </div>
          <p>
            The <strong>Composite Rank</strong> is the simple average of each team's rank across available sources.
            The <strong>National Percentile</strong> shows where a team stands among ALL teams in their division nationally.
            This enables <strong>cross-division comparison</strong>. A team at the 95th percentile in NAIA is performing
            comparably to a team at the 95th percentile in D1, relative to their respective peers.
          </p>
          <p className="text-xs text-gray-400">
            NWAC (JUCO) teams are not covered by national rating systems and use our internal PPI rating instead.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ───
export default function NationalRankings() {
  const [view, setView] = useState('by-division')
  const { data, loading, error } = useNationalRankings(2026)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-nw-teal border-t-transparent" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-24">
        <p className="text-red-500 mb-2">Failed to load national rankings</p>
        <p className="text-sm text-gray-400">{error}</p>
        <p className="text-sm text-gray-400 mt-4">
          National rankings require running the scraper first:
          <code className="bg-gray-100 px-2 py-1 rounded ml-1 text-xs">
            python3 scripts/scrape_national_ratings.py --season 2026
          </code>
        </p>
      </div>
    )
  }

  const divisions = data?.divisions || []
  const crossDivision = data?.cross_division || []
  const hasCompositeData = crossDivision.length > 0

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight">National Rankings</h1>
          <p className="text-gray-500 mt-1">
            Where PNW teams rank nationally | composite of Pear & CBR ratings
          </p>
        </div>

        {/* View toggle */}
        {hasCompositeData && (
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setView('by-division')}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                view === 'by-division' ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              By Division
            </button>
            <button
              onClick={() => setView('cross-division')}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                view === 'cross-division' ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Cross-Division
            </button>
          </div>
        )}
      </div>

      {/* Info card */}
      <InfoCard />

      {/* No data state */}
      {!hasCompositeData && divisions.length === 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center">
          <p className="text-gray-500 text-lg mb-2">No national ranking data yet</p>
          <p className="text-sm text-gray-400">
            Run the scraper to import ratings from Pear and CBR:
          </p>
          <code className="block bg-gray-100 px-4 py-2 rounded mt-3 text-sm text-gray-700">
            python3 scripts/scrape_national_ratings.py --season 2026
          </code>
        </div>
      )}

      {/* Division view */}
      {view === 'by-division' && divisions.map(div => (
        <DivisionSection key={div.division_id} division={div} />
      ))}

      {/* Cross-division view */}
      {view === 'cross-division' && (
        <CrossDivisionTable teams={crossDivision} />
      )}

      {/* Data sources footer */}
      <div className="text-xs text-gray-400 text-center pt-4 space-y-1">
        <p>Data sourced from PearRatings.com and CollegeBaseballRatings.com</p>
        <p>Composite rankings are averaged across available sources. Not all sources cover all teams.</p>
      </div>
    </div>
  )
}
