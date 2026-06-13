// Composite Power Index (CPI) team ratings, grouped by division.
// CPI is a predictive, SoS-adjusted power rating centered at 100 (division
// average). Data from GET /team-ratings. Brand rule: no em-dashes in copy.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTeamRatings } from '../hooks/useApi'
import StatsLastUpdated from '../components/StatsLastUpdated'
import { CURRENT_SEASON } from '../lib/seasons'

const BADGE_COLORS = {
  D1: 'bg-red-600 text-white',
  D2: 'bg-blue-600 text-white',
  D3: 'bg-green-600 text-white',
  NAIA: 'bg-purple-600 text-white',
  JUCO: 'bg-amber-700 text-white',
}

// CPI color: 100 = division average. Green above, red below.
function cpiColor(v) {
  if (v == null) return 'text-gray-400 dark:text-gray-500'
  if (v >= 112) return 'text-emerald-700 dark:text-emerald-300'
  if (v >= 103) return 'text-emerald-600 dark:text-emerald-400'
  if (v >= 97) return 'text-gray-700 dark:text-gray-300'
  if (v >= 88) return 'text-orange-600 dark:text-orange-400'
  return 'text-red-600 dark:text-red-400'
}

function cpiBg(v) {
  // Light tints need dark-mode counterparts; otherwise the tinted row
  // stays light in dark mode and the (now light) text vanishes on it.
  if (v == null) return ''
  if (v >= 112) return 'bg-emerald-50 dark:bg-emerald-900/30'
  if (v >= 103) return 'bg-emerald-50/50 dark:bg-emerald-900/20'
  if (v >= 97) return ''
  if (v >= 88) return 'bg-orange-50/50 dark:bg-orange-900/20'
  return 'bg-red-50/50 dark:bg-red-900/20'
}

// Component index color (off/pit/sos indexes, all centered at 100)
function idxColor(v) {
  if (v == null) return 'text-gray-400 dark:text-gray-500'
  if (v >= 106) return 'text-emerald-600 dark:text-emerald-400 font-semibold'
  if (v <= 94) return 'text-red-600 dark:text-red-400 font-semibold'
  return 'text-gray-600 dark:text-gray-300'
}

// Mini bar chart: maps the practical CPI range (~70-130) onto 0-100% width
function ScoreBar({ value, color = 'bg-nw-teal' }) {
  const width = Math.max(2, Math.min(100, ((value ?? 100) - 70) / 60 * 100))
  return (
    <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-1.5">
      <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${width}%` }} />
    </div>
  )
}

function scoreBarColor(v) {
  if (v == null) return 'bg-gray-400'
  if (v >= 112) return 'bg-emerald-500'
  if (v >= 103) return 'bg-emerald-400'
  if (v >= 97) return 'bg-gray-400'
  if (v >= 88) return 'bg-orange-400'
  return 'bg-red-400'
}

// ─── Division CPI table ───
function DivisionTable({ division }) {
  const badgeClass = BADGE_COLORS[division.division_level] || 'bg-gray-50 dark:bg-gray-900/400 text-white'

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden mb-5">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2">
        <span className={`text-xs font-bold px-2 py-0.5 rounded ${badgeClass}`}>
          {division.division_level}
        </span>
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-200">{division.division_name}</h3>
        <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">{division.teams.length} teams</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider bg-gray-50 dark:bg-gray-900/40">
              <th className="text-center px-2 py-2 font-semibold w-8">#</th>
              <th className="text-left pl-3 pr-1 py-2 font-semibold">Team</th>
              <th className="text-center px-2 py-2 font-semibold w-14" title="Composite Power Index (100 = division average)">CPI</th>
              <th className="text-center px-2 py-2 font-semibold w-16">Record</th>
              <th className="text-center px-1 py-2 font-semibold w-14" title="Projected win percentage at full strength">
                <span className="hidden sm:inline">Proj W%</span>
                <span className="sm:hidden">PW%</span>
              </th>
              <th className="text-center px-1 py-2 font-semibold w-12" title="Team offense, regressed wRC+ (100 = division average)">
                <span className="hidden sm:inline">Off</span>
                <span className="sm:hidden">O</span>
              </th>
              <th className="text-center px-1 py-2 font-semibold w-12" title="Team pitching index from FIP (100 = division average, higher is better)">
                <span className="hidden sm:inline">Pitch</span>
                <span className="sm:hidden">P</span>
              </th>
              <th className="text-center px-1 py-2 font-semibold w-12" title="Strength of schedule (100 = average). PEAR-based for NCAA and NAIA, results-based for NWAC">
                <span className="hidden sm:inline">SoS</span>
                <span className="sm:hidden">S</span>
              </th>
              <th className="text-center px-1 py-2 font-semibold w-14" title="Actual win% minus projected. Positive = outplaying the rating.">
                <span className="hidden sm:inline">vs Proj</span>
                <span className="sm:hidden">±</span>
              </th>
              <th className="text-left px-2 py-2 font-semibold w-24 hidden md:table-cell">Strength</th>
            </tr>
          </thead>
          <tbody>
            {division.teams.map((team) => (
              <tr
                key={team.id}
                className={`border-t border-gray-50 hover:bg-teal-50/40 transition-colors ${cpiBg(team.cpi)}`}
              >
                {/* Rank */}
                <td className="text-center px-2 py-2 font-mono text-gray-400 dark:text-gray-500">{team.rank}</td>

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
                    <span className="font-medium text-gray-800 dark:text-gray-200 truncate">{team.short_name}</span>
                  </Link>
                </td>

                {/* CPI */}
                <td className={`text-center px-2 py-2 font-bold text-sm tabular-nums ${cpiColor(team.cpi)}`}>
                  {team.cpi ?? '-'}
                </td>

                {/* Record */}
                <td className="text-center px-2 py-2 text-gray-600 dark:text-gray-400">
                  {team.wins}-{team.losses}
                </td>

                {/* Projected win % */}
                <td className="text-center px-1 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                  {team.proj_winpct != null ? `${(team.proj_winpct * 100).toFixed(0)}%` : '-'}
                </td>

                {/* Component indexes (all centered at 100) */}
                <td className={`text-center px-1 py-2 tabular-nums ${idxColor(team.off_wrc)}`}>{team.off_wrc ?? '-'}</td>
                <td className={`text-center px-1 py-2 tabular-nums ${idxColor(team.pit_index)}`}>{team.pit_index ?? '-'}</td>
                <td className={`text-center px-1 py-2 tabular-nums ${idxColor(team.sos_index)}`}>{team.sos_index ?? '-'}</td>

                {/* Luck: actual vs projected win%. Computed from intra-division
                    games only, so hide it when that sample is tiny (D1 teams
                    only play each other a dozen times a season). */}
                <td className={`text-center px-1 py-2 tabular-nums ${team.luck == null || team.games < 15 ? 'text-gray-300 dark:text-gray-600' : team.luck > 0.02 ? 'text-emerald-600 dark:text-emerald-400' : team.luck < -0.02 ? 'text-red-500 dark:text-red-400' : 'text-gray-400 dark:text-gray-500'}`}>
                  {team.luck != null && team.games >= 15 ? `${team.luck > 0 ? '+' : ''}${Math.round(team.luck * 100)}%` : '-'}
                </td>

                {/* Visual strength bar */}
                <td className="px-2 py-2 hidden md:table-cell">
                  <ScoreBar value={team.cpi} color={scoreBarColor(team.cpi)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Info card explaining CPI ───
function InfoCard() {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden mb-5">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-2.5 flex items-center justify-between text-left hover:bg-gray-50 dark:bg-gray-900/40 transition-colors"
      >
        <span className="text-xs font-semibold text-gray-600 dark:text-gray-400">How CPI Works</span>
        <svg className={`w-4 h-4 text-gray-400 dark:text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="px-4 pb-3 text-xs text-gray-600 dark:text-gray-400 space-y-2 border-t border-gray-100 dark:border-gray-700 pt-2.5">
          <p>
            The <strong>Composite Power Index (CPI)</strong> is a predictive power rating centered at 100. A score of 100 is exactly average for the division; 112 or higher is elite, 88 or lower is struggling. Teams are only compared to their direct division peers, not across divisions.
          </p>
          <p className="font-semibold text-gray-700 dark:text-gray-300">How the rating is built:</p>
          <div className="grid sm:grid-cols-3 gap-2">
            <div className="bg-gray-50 dark:bg-gray-900/40 rounded p-2">
              <p className="font-bold text-nw-teal">Underlying talent (65%)</p>
              <p className="text-[10px] text-gray-500 dark:text-gray-400">Expected run differential from team wRC+ (offense) and FIP (pitching). These strip out sequencing and clutch luck, so they predict better than win-loss alone. Both are regressed toward average by sample size.</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-900/40 rounded p-2">
              <p className="font-bold text-nw-teal">Schedule-adjusted results (35%)</p>
              <p className="text-[10px] text-gray-500 dark:text-gray-400">Capped run margins plus strength of schedule, so beating strong teams counts more. For NCAA and NAIA teams the schedule strength comes from PEAR's national SOS ratings, which account for every opponent on the slate. NWAC schedules are fully covered by our own game results, so NWAC strength of schedule is calculated from those results instead. Regressed hard when the sample is small.</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-900/40 rounded p-2">
              <p className="font-bold text-nw-teal">Projection</p>
              <p className="text-[10px] text-gray-500 dark:text-gray-400">The blend becomes a projected win percentage. The vs Proj column shows who is over or under their true level.</p>
            </div>
          </div>
          <p>
            Off, Pitch, and SoS are also centered at 100, so a 106 offense is clearly above the division average and a 94 is clearly below it. Run margins only count games against teams in the same division, which keeps the rating an apples-to-apples comparison, while the PEAR schedule strength reflects each NCAA and NAIA team's full national slate.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ───
export default function TeamRatings() {
  const { data, loading, error } = useTeamRatings(CURRENT_SEASON)

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
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">Team Ratings</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Composite Power Index | within-division power rankings · {CURRENT_SEASON}</p>

      <InfoCard />

      {divisions.map(div => (
        <DivisionTable key={div.division_id} division={div} />
      ))}

      <StatsLastUpdated className="mt-4" />
    </div>
  )
}
