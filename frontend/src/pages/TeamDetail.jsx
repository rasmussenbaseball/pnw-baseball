import { useState } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import { useTeamStats, useTeamRankings, useTeamHistory } from '../hooks/useApi'
import StatsTable from '../components/StatsTable'
import StatPresetBar from '../components/StatPresetBar'
import FavoriteButton from '../components/FavoriteButton'
import { BATTING_COLUMNS, PITCHING_COLUMNS,
         formatStat, divisionBadgeClass } from '../utils/stats'

// Team-specific columns: strip out team_short and division_level since we're on a team page
const TEAM_BAT_COLUMNS = BATTING_COLUMNS.filter(c => c.key !== 'team_short' && c.key !== 'division_level')
const TEAM_PIT_COLUMNS = PITCHING_COLUMNS.filter(c => c.key !== 'team_short' && c.key !== 'division_level')

const TEAM_BATTING_PRESETS = {
  'Standard': ['games', 'plate_appearances', 'at_bats', 'hits', 'doubles', 'triples', 'home_runs', 'runs', 'rbi', 'walks', 'strikeouts', 'stolen_bases', 'batting_avg', 'on_base_pct', 'slugging_pct', 'ops'],
  'Advanced': ['plate_appearances', 'batting_avg', 'on_base_pct', 'slugging_pct', 'woba', 'wrc_plus', 'iso', 'babip', 'bb_pct', 'k_pct', 'offensive_war'],
}

const TEAM_PITCHING_PRESETS = {
  'Standard': ['wins', 'losses', 'saves', 'games', 'games_started', 'innings_pitched', 'strikeouts', 'walks', 'hits_allowed', 'earned_runs', 'era', 'whip'],
  'Advanced': ['innings_pitched', 'era', 'era_plus', 'fip', 'fip_plus', 'xfip', 'siera', 'k_pct', 'bb_pct', 'k_bb_pct', 'babip_against', 'lob_pct', 'pitching_war'],
}

export default function TeamDetail() {
  const { teamId } = useParams()
  const [searchParams] = useSearchParams()
  const season = 2026
  const initialTab = searchParams.get('tab') === 'history' ? 'history' : 'season'
  const [activeTab, setActiveTab] = useState(initialTab)

  const { data: result, loading } = useTeamStats(teamId, season)
  const { data: rankings } = useTeamRankings(teamId, season)
  const { data: history, loading: historyLoading } = useTeamHistory(teamId)

  const [batPreset, setBatPreset] = useState('Standard')
  const [pitPreset, setPitPreset] = useState('Standard')

  const [batSort, setBatSort] = useState('plate_appearances')
  const [batSortDir, setBatSortDir] = useState('desc')
  const [pitSort, setPitSort] = useState('innings_pitched')
  const [pitSortDir, setPitSortDir] = useState('desc')

  const team = result?.team || history?.team
  const batting = result?.batting || []
  const pitching = result?.pitching || []

  // Client-side sort since the data comes pre-loaded for one team
  const sortedBatting = [...batting].sort((a, b) => {
    const av = a[batSort] ?? -Infinity
    const bv = b[batSort] ?? -Infinity
    return batSortDir === 'asc' ? av - bv : bv - av
  })

  const sortedPitching = [...pitching].sort((a, b) => {
    const av = a[pitSort] ?? -Infinity
    const bv = b[pitSort] ?? -Infinity
    return pitSortDir === 'asc' ? av - bv : bv - av
  })

  if (loading && !team) {
    return <div className="text-gray-400 animate-pulse py-8">Loading team data...</div>
  }

  if (!team) {
    return <div className="text-gray-500 py-8">Team not found.</div>
  }

  // Quick team summary stats
  const teamPA = batting.reduce((s, b) => s + (b.plate_appearances || 0), 0)
  const teamIP = pitching.reduce((s, p) => s + (p.innings_pitched || 0), 0)
  const teamOWAR = batting.reduce((s, b) => s + (b.offensive_war || 0), 0)
  const teamPWAR = pitching.reduce((s, p) => s + (p.pitching_war || 0), 0)

  return (
    <div>
      {/* Back link */}
      <Link to="/teams" className="text-sm text-pnw-teal hover:underline mb-3 inline-block">&larr; All Teams</Link>

      {/* Team header */}
      <div className="bg-white rounded-lg shadow-sm border p-4 sm:p-5 mb-4">
        <div className="flex items-center gap-2 sm:gap-3 mb-2">
          {team.logo_url && (
            <img
              src={team.logo_url}
              alt=""
              className="w-8 h-8 sm:w-10 sm:h-10 object-contain shrink-0"
              loading="lazy"
              onError={(e) => { e.target.style.display = 'none' }}
            />
          )}
          <span className={`px-2 py-0.5 rounded text-xs font-bold ${divisionBadgeClass(team.division_level)}`}>
            {team.division_level}
          </span>
          <h1 className="text-lg sm:text-2xl font-bold text-pnw-slate">{team.name}</h1>
          <FavoriteButton type="team" targetId={team.id} />
        </div>
        <div className="text-xs sm:text-sm text-gray-500">
          {team.city}, {team.state} · {team.conference_name}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-4 sm:mb-6 bg-gray-100 rounded-lg p-1">
        <button
          onClick={() => setActiveTab('season')}
          className={`flex-1 sm:flex-none px-3 sm:px-4 py-2 rounded-md text-xs sm:text-sm font-medium transition-colors ${
            activeTab === 'season'
              ? 'bg-white text-pnw-slate shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {season} Season
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`flex-1 sm:flex-none px-3 sm:px-4 py-2 rounded-md text-xs sm:text-sm font-medium transition-colors ${
            activeTab === 'history'
              ? 'bg-white text-pnw-slate shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Program History
        </button>
      </div>

      {/* Current Season Tab */}
      {activeTab === 'season' && (
        <div>
          {/* Summary row */}
          <div className="bg-white rounded-lg shadow-sm border p-3 sm:p-5 mb-4 sm:mb-6">
            <div className="text-xs sm:text-sm text-gray-500 mb-2 sm:mb-3">{season} Season</div>
            <div className="grid grid-cols-3 sm:flex sm:flex-wrap gap-3 sm:gap-6 text-xs sm:text-sm">
              <SummaryCell label="Batters" value={batting.length} />
              <SummaryCell label="Pitchers" value={pitching.length} />
              <SummaryCell label="Team PA" value={teamPA.toLocaleString()} />
              <SummaryCell label="Team IP" value={teamIP.toFixed(1)} />
              <SummaryCell label="Total oWAR" value={teamOWAR.toFixed(1)} highlight />
              <SummaryCell label="Total pWAR" value={teamPWAR.toFixed(1)} highlight />
              <SummaryCell label="Total WAR" value={(teamOWAR + teamPWAR).toFixed(1)} highlight />
            </div>
          </div>

          {/* Rankings card */}
          {rankings && rankings.composite && (
            <RankingsCard rankings={rankings} />
          )}

          {/* Batting table */}
          <div className="mb-6 sm:mb-8">
            <h2 className="text-lg sm:text-xl font-bold text-pnw-slate mb-2 sm:mb-3">Batting</h2>
            <StatPresetBar
              presets={TEAM_BATTING_PRESETS}
              activePreset={batPreset}
              onSelect={setBatPreset}
            />
            <StatsTable
              data={sortedBatting}
              columns={TEAM_BAT_COLUMNS}
              visibleColumns={TEAM_BATTING_PRESETS[batPreset]}
              sortBy={batSort}
              sortDir={batSortDir}
              onSort={(key, dir) => { setBatSort(key); setBatSortDir(dir) }}
              loading={false}
              offset={0}
            />
          </div>

          {/* Pitching table */}
          <div className="mb-8">
            <h2 className="text-lg sm:text-xl font-bold text-pnw-slate mb-2 sm:mb-3">Pitching</h2>
            <StatPresetBar
              presets={TEAM_PITCHING_PRESETS}
              activePreset={pitPreset}
              onSelect={setPitPreset}
            />
            <StatsTable
              data={sortedPitching}
              columns={TEAM_PIT_COLUMNS}
              visibleColumns={TEAM_PITCHING_PRESETS[pitPreset]}
              sortBy={pitSort}
              sortDir={pitSortDir}
              onSort={(key, dir) => { setPitSort(key); setPitSortDir(dir) }}
              loading={false}
              offset={0}
            />
          </div>
        </div>
      )}

      {/* History Tab */}
      {activeTab === 'history' && (
        <TeamHistoryTab history={history} loading={historyLoading} />
      )}
    </div>
  )
}


// ============================================================
// HISTORY TAB
// ============================================================

function TeamHistoryTab({ history, loading }) {
  const [leaderCategory, setLeaderCategory] = useState('batting')

  if (loading) {
    return <div className="text-gray-400 animate-pulse py-8">Loading history...</div>
  }

  if (!history) {
    return <div className="text-gray-500 py-8">No history data available.</div>
  }

  const { seasons, season_leaders, career_batting_leaders, career_pitching_leaders, all_time_summary } = history
  const numSeasons = all_time_summary?.num_seasons || 0
  const minYear = seasons.length > 0 ? seasons[seasons.length - 1].season : null
  const maxYear = seasons.length > 0 ? seasons[0].season : null

  return (
    <div>
      {/* All-Time Summary */}
      <div className="bg-white rounded-lg shadow-sm border p-5 mb-6">
        <h2 className="text-lg font-bold text-pnw-slate mb-1">Program Overview</h2>
        <div className="text-xs text-gray-400 mb-4">
          {numSeasons} season{numSeasons !== 1 ? 's' : ''} tracked
          {minYear && maxYear ? ` (${minYear}–${maxYear})` : ''}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
          <SummaryCell
            label="Overall Record"
            value={`${all_time_summary.total_wins || 0}-${all_time_summary.total_losses || 0}${all_time_summary.total_ties ? `-${all_time_summary.total_ties}` : ''}`}
          />
          <SummaryCell
            label="Win %"
            value={all_time_summary.win_pct != null ? all_time_summary.win_pct.toFixed(3) : '-'}
            highlight={all_time_summary.win_pct >= 0.600}
          />
          <SummaryCell
            label="Conf Record"
            value={`${all_time_summary.total_conf_wins || 0}-${all_time_summary.total_conf_losses || 0}`}
          />
          <SummaryCell
            label="Conf Win %"
            value={all_time_summary.conf_win_pct != null ? all_time_summary.conf_win_pct.toFixed(3) : '-'}
            highlight={all_time_summary.conf_win_pct >= 0.600}
          />
          <SummaryCell
            label="Runs Scored"
            value={(all_time_summary.total_rs || 0).toLocaleString()}
          />
          <SummaryCell
            label="Runs Allowed"
            value={(all_time_summary.total_ra || 0).toLocaleString()}
          />
        </div>
      </div>

      {/* Year-by-Year Records */}
      <div className="bg-white rounded-lg shadow-sm border p-5 mb-6">
        <h2 className="text-lg font-bold text-pnw-slate mb-4">Year-by-Year</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-gray-500 uppercase tracking-wide">
                <th className="text-left py-2 px-2">Year</th>
                <th className="text-center py-2 px-2">Record</th>
                <th className="text-center py-2 px-2">Win%</th>
                <th className="text-center py-2 px-2">Conf</th>
                <th className="text-center py-2 px-2">RS</th>
                <th className="text-center py-2 px-2">RA</th>
                <th className="text-center py-2 px-2">Diff</th>
                <th className="text-center py-2 px-2">ERA</th>
                <th className="text-center py-2 px-2">AVG</th>
                <th className="text-center py-2 px-2">wRC+</th>
                <th className="text-center py-2 px-2">FIP</th>
                <th className="text-center py-2 px-2">WAR</th>
                <th className="text-center py-2 px-2">Natl Rank</th>
              </tr>
            </thead>
            <tbody>
              {seasons.map((s) => {
                const w = s.wins || 0
                const l = s.losses || 0
                const winPct = w + l > 0 ? (w / (w + l)).toFixed(3) : '-'
                const diff = s.run_differential || 0
                return (
                  <tr key={s.season} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2 px-2 font-semibold text-pnw-slate">{s.season}</td>
                    <td className="text-center py-2 px-2">
                      {w}-{l}{s.ties ? `-${s.ties}` : ''}
                    </td>
                    <td className="text-center py-2 px-2">{winPct}</td>
                    <td className="text-center py-2 px-2">
                      {(s.conference_wins || 0) + (s.conference_losses || 0) > 0
                        ? `${s.conference_wins}-${s.conference_losses}`
                        : '-'}
                    </td>
                    <td className="text-center py-2 px-2">{s.runs_scored || '-'}</td>
                    <td className="text-center py-2 px-2">{s.runs_allowed || '-'}</td>
                    <td className={`text-center py-2 px-2 font-medium ${
                      diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-500' : ''
                    }`}>
                      {diff > 0 ? `+${diff}` : diff}
                    </td>
                    <td className="text-center py-2 px-2">
                      {s.team_era != null ? s.team_era.toFixed(2) : '-'}
                    </td>
                    <td className="text-center py-2 px-2">
                      {s.team_batting_avg != null ? s.team_batting_avg.toFixed(3) : '-'}
                    </td>
                    <td className="text-center py-2 px-2 font-medium">
                      {s.team_wrc_plus != null ? s.team_wrc_plus.toFixed(0) : '-'}
                    </td>
                    <td className="text-center py-2 px-2">
                      {s.team_fip != null ? s.team_fip.toFixed(2) : '-'}
                    </td>
                    <td className="text-center py-2 px-2 font-medium">
                      {s.total_war != null ? s.total_war.toFixed(1) : '-'}
                    </td>
                    <td className="text-center py-2 px-2">
                      {s.composite_rank ? `#${Math.round(s.composite_rank)}` : '-'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Season Stat Leaders */}
      <div className="bg-white rounded-lg shadow-sm border p-5 mb-6">
        <h2 className="text-lg font-bold text-pnw-slate mb-4">Season Award Leaders</h2>
        {seasons.map((s) => {
          const leaders = season_leaders[String(s.season)]
          if (!leaders || Object.keys(leaders).length === 0) return null

          const batLeaders = ['AVG', 'HR', 'RBI', 'H', 'SB', 'wRC+', 'oWAR'].filter(k => leaders[k])
          const pitLeaders = ['ERA', 'K', 'FIP', 'W', 'SV', 'pWAR'].filter(k => leaders[k])

          return (
            <div key={s.season} className="mb-5 last:mb-0">
              <h3 className="text-sm font-bold text-pnw-slate mb-2 flex items-center gap-2">
                {s.season}
                <span className="text-xs font-normal text-gray-400">
                  ({s.wins || 0}-{s.losses || 0})
                </span>
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* Batting leaders */}
                {batLeaders.length > 0 && (
                  <div>
                    <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">Batting</div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {batLeaders.map((cat) => {
                        const l = leaders[cat]
                        const val = cat === 'AVG' ? l.value.toFixed(3)
                          : cat === 'wRC+' ? Math.round(l.value)
                          : cat === 'oWAR' ? l.value.toFixed(1)
                          : l.value
                        return (
                          <Link
                            key={cat}
                            to={`/player/${l.player_id}`}
                            className="text-xs hover:bg-gray-50 rounded px-1"
                          >
                            <span className="text-gray-500">{cat}:</span>{' '}
                            <span className="font-semibold text-pnw-slate">{val}</span>{' '}
                            <span className="text-pnw-teal">{l.name}</span>
                          </Link>
                        )
                      })}
                    </div>
                  </div>
                )}
                {/* Pitching leaders */}
                {pitLeaders.length > 0 && (
                  <div>
                    <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">Pitching</div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {pitLeaders.map((cat) => {
                        const l = leaders[cat]
                        const val = cat === 'ERA' || cat === 'FIP' ? l.value.toFixed(2)
                          : cat === 'pWAR' ? l.value.toFixed(1)
                          : l.value
                        return (
                          <Link
                            key={cat}
                            to={`/player/${l.player_id}`}
                            className="text-xs hover:bg-gray-50 rounded px-1"
                          >
                            <span className="text-gray-500">{cat}:</span>{' '}
                            <span className="font-semibold text-pnw-slate">{val}</span>{' '}
                            <span className="text-pnw-teal">{l.name}</span>
                          </Link>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* All-Time Career Leaders */}
      <div className="bg-white rounded-lg shadow-sm border p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-pnw-slate">All-Time Career Leaders</h2>
            <p className="text-xs text-gray-400 mt-0.5">Stats tracked since 2022 season</p>
          </div>
          <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setLeaderCategory('batting')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                leaderCategory === 'batting'
                  ? 'bg-white text-pnw-slate shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Batting
            </button>
            <button
              onClick={() => setLeaderCategory('pitching')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                leaderCategory === 'pitching'
                  ? 'bg-white text-pnw-slate shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Pitching
            </button>
          </div>
        </div>

        {leaderCategory === 'batting' && (
          <CareerLeaderboards leaders={career_batting_leaders} type="batting" />
        )}
        {leaderCategory === 'pitching' && (
          <CareerLeaderboards leaders={career_pitching_leaders} type="pitching" />
        )}
      </div>
    </div>
  )
}


function CareerLeaderboards({ leaders, type }) {
  if (!leaders || Object.keys(leaders).length === 0) {
    return <div className="text-gray-400 text-sm">No career data available.</div>
  }

  // Display order
  const order = type === 'batting'
    ? ['oWAR', 'AVG', 'HR', 'RBI', 'H', 'R', 'SB', 'BB']
    : ['pWAR', 'ERA', 'K', 'W', 'SV', 'IP', 'WHIP']

  const categories = order.filter(k => leaders[k] && leaders[k].length > 0)

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {categories.map((cat) => (
        <div key={cat} className="bg-gray-50 rounded-lg p-3">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">{cat}</div>
          <div className="space-y-1">
            {leaders[cat].slice(0, 5).map((player, i) => {
              const val = cat === 'AVG' ? player.value.toFixed(3)
                : cat === 'ERA' || cat === 'WHIP' ? player.value.toFixed(2)
                : cat === 'oWAR' || cat === 'pWAR' ? player.value.toFixed(1)
                : cat === 'IP' ? player.value.toFixed(1)
                : player.value
              return (
                <div key={player.player_id} className="flex items-center gap-2 text-xs">
                  <span className={`w-4 text-right font-bold ${
                    i === 0 ? 'text-amber-500' : i === 1 ? 'text-gray-400' : i === 2 ? 'text-amber-700' : 'text-gray-300'
                  }`}>
                    {i + 1}
                  </span>
                  <Link
                    to={`/player/${player.player_id}`}
                    className="text-pnw-teal hover:underline truncate flex-1"
                  >
                    {player.name}
                  </Link>
                  <span className="font-semibold text-pnw-slate whitespace-nowrap">{val}</span>
                  <span className="text-gray-400 text-[10px]">
                    ({player.seasons}yr)
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}


// ============================================================
// SHARED COMPONENTS
// ============================================================

function SummaryCell({ label, value, highlight = false }) {
  return (
    <div className="text-center">
      <div className={`text-lg font-bold ${highlight ? 'text-pnw-forest' : 'text-pnw-slate'}`}>
        {value}
      </div>
      <div className="text-xs text-gray-400 uppercase tracking-wide">{label}</div>
    </div>
  )
}


function RankingsCard({ rankings }) {
  const comp = rankings.composite
  const pear = rankings.sources?.pear
  const cbr = rankings.sources?.cbr
  const divLevel = rankings.division_level

  // Determine total teams in division (use max from sources)
  const totalTeams = Math.max(pear?.total_teams || 0, cbr?.total_teams || 0)

  return (
    <div className="bg-white rounded-lg shadow-sm border p-5 mb-6">
      <h2 className="text-lg font-bold text-pnw-slate mb-4">Rankings</h2>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        {/* National Rank */}
        <div className="bg-gray-50 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-pnw-slate">
            #{Math.round(comp.composite_rank)}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            National Rank ({divLevel})
          </div>
          {totalTeams > 0 && (
            <div className="text-xs text-gray-400">out of {totalTeams} teams</div>
          )}
          <div className="flex justify-center gap-3 mt-2">
            {comp.pear_rank && (
              <span className="text-xs bg-green-100 text-green-800 px-1.5 py-0.5 rounded">
                Pear #{comp.pear_rank}
              </span>
            )}
            {comp.cbr_rank && (
              <span className="text-xs bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded">
                CBR #{comp.cbr_rank}
              </span>
            )}
          </div>
        </div>

        {/* Conference Rank */}
        <div className="bg-gray-50 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-pnw-slate">
            {rankings.conference_rank ? `#${rankings.conference_rank}` : '-'}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Conference Rank
          </div>
          {rankings.conference_total && (
            <div className="text-xs text-gray-400">
              out of {rankings.conference_total} in {rankings.conference_abbrev || rankings.conference_name}
            </div>
          )}
          {rankings.conference_standings && rankings.conference_standings.length > 0 && (
            <div className="mt-2 text-left">
              {rankings.conference_standings.map((t) => (
                <div
                  key={t.team_id}
                  className={`text-xs py-0.5 px-1.5 rounded ${
                    t.team_id === rankings.team_id
                      ? 'bg-pnw-teal/10 text-pnw-teal font-semibold'
                      : 'text-gray-500'
                  }`}
                >
                  {t.rank}. {t.short_name}{' '}
                  <span className="text-gray-400">
                    ({t.conf_wins + t.conf_losses > 0
                      ? `${t.conf_wins}-${t.conf_losses}`
                      : `${t.wins}-${t.losses}`})
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Strength of Schedule */}
        <div className="bg-gray-50 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-pnw-slate">
            {comp.composite_sos_rank ? `#${Math.round(comp.composite_sos_rank)}` : '-'}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Strength of Schedule
          </div>
          {totalTeams > 0 && comp.composite_sos_rank && (
            <div className="text-xs text-gray-400">out of {totalTeams} teams</div>
          )}
          <div className="flex justify-center gap-3 mt-2">
            {pear?.sos_rank && (
              <span className="text-xs bg-green-100 text-green-800 px-1.5 py-0.5 rounded">
                Pear #{pear.sos_rank}
              </span>
            )}
            {cbr?.sos_rank && (
              <span className="text-xs bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded">
                CBR #{cbr.sos_rank}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* National Percentile bar */}
      {comp.national_percentile != null && (
        <div className="mt-2">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
            <span>National Percentile ({divLevel})</span>
            <span className="font-semibold text-pnw-slate">{comp.national_percentile.toFixed(1)}%</span>
          </div>
          <div className="h-2.5 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${comp.national_percentile}%`,
                backgroundColor: comp.national_percentile >= 75 ? '#16a34a'
                  : comp.national_percentile >= 50 ? '#ca8a04'
                  : comp.national_percentile >= 25 ? '#ea580c' : '#dc2626'
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
