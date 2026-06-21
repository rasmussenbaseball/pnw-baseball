import { useState, useEffect, useMemo } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import { useTeamStats, useTeamRankings, useTeamHistory, useTeamFutureGames, useTeamRecruits, useIncomingTransfers, useTeamInfoGraphic, useBattingPbpLeaderboard, usePitchingPbpLeaderboard } from '../hooks/useApi'
import TeamAdvanced from '../components/TeamAdvanced'
import StatsTable from '../components/StatsTable'
import StatPresetBar from '../components/StatPresetBar'
import FavoriteButton from '../components/FavoriteButton'
import StatsLastUpdated from '../components/StatsLastUpdated'
import ExportCSVButton from '../components/ExportCSVButton'
import SeasonSelect from '../components/SeasonSelect'
import { CURRENT_SEASON, clampSeason } from '../lib/seasons'
import { BATTING_COLUMNS, PITCHING_COLUMNS, BATTING_PBP_COLUMNS, PITCHING_PBP_COLUMNS,
         formatStat, divisionBadgeClass, ipSum } from '../utils/stats'

// Team-specific columns: strip out team_short and division_level since we're on a team page
const TEAM_BAT_COLUMNS = BATTING_COLUMNS.filter(c => c.key !== 'team_short' && c.key !== 'division_level')
const TEAM_PIT_COLUMNS = PITCHING_COLUMNS.filter(c => c.key !== 'team_short' && c.key !== 'division_level')
// PBP (play-by-play) views — same column sets as the PBP leaderboards, minus
// the team/level columns that are redundant on a single team's page.
const TEAM_BAT_PBP_COLUMNS = BATTING_PBP_COLUMNS.filter(c => c.key !== 'team_short' && c.key !== 'division_level')
const TEAM_PIT_PBP_COLUMNS = PITCHING_PBP_COLUMNS.filter(c => c.key !== 'team_short' && c.key !== 'division_level')

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
  const [searchParams, setSearchParams] = useSearchParams()
  const season = clampSeason(searchParams.get('season') || CURRENT_SEASON)
  const setSeason = (yr) => {
    const next = new URLSearchParams(searchParams)
    next.set('season', String(yr))
    setSearchParams(next, { replace: true })
  }
  const initialTab = searchParams.get('tab') === 'history' ? 'history' : 'season'
  const [activeTab, setActiveTab] = useState(initialTab)

  const { data: result, loading, error } = useTeamStats(teamId, season)
  const { data: rankings } = useTeamRankings(teamId, season)
  const { data: history, loading: historyLoading } = useTeamHistory(teamId)
  const { data: futureData } = useTeamFutureGames(teamId, 15)
  const { data: ig } = useTeamInfoGraphic(teamId, season)

  const team = result?.team || history?.team
  const batting = result?.batting || []
  const pitching = result?.pitching || []

  // Treat data as "stale" while the just-clicked team is still
  // loading but `team` still holds the previously loaded team. Without
  // this check the user sees the OLD team's roster + stats during the
  // fetch instead of a clear loading state.
  const teamIsCurrent = team?.id != null && String(team.id) === String(teamId)
  if (loading && !teamIsCurrent) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <div className="animate-spin h-8 w-8 border-4 border-nw-teal border-t-transparent rounded-full" />
        <div className="text-xs text-gray-500 dark:text-gray-400">Loading team...</div>
      </div>
    )
  }

  // A fetch failure used to fall through to "Team not found", which reads as
  // if the team doesn't exist when the API just hiccuped.
  if (error && !team) {
    return (
      <div className="py-12 text-center">
        <p className="text-red-600 dark:text-red-400 font-semibold">Couldn't load this team.</p>
        <p className="text-sm text-gray-500 mt-1">Please refresh the page to try again.</p>
      </div>
    )
  }

  if (!team) {
    return <div className="text-gray-500 py-8">Team not found.</div>
  }

  // Quick team summary stats
  const teamPA = batting.reduce((s, b) => s + (b.plate_appearances || 0), 0)
  // innings_pitched is baseball notation (6.2 = 6⅔) — sum via outs, not floats
  const teamIP = ipSum(pitching.map(p => p.innings_pitched))
  const teamOWAR = batting.reduce((s, b) => s + (b.offensive_war || 0), 0)
  const teamPWAR = pitching.reduce((s, p) => s + (p.pitching_war || 0), 0)

  return (
    <div>
      {/* Back link */}
      <Link to="/teams" className="text-sm text-nw-teal-light hover:underline mb-3 inline-block">&larr; All Teams</Link>

      {/* Team header */}
      <HeroHeader team={team} ig={ig} />

      {/* Tab bar */}
      <div className="flex gap-1 mb-4 sm:mb-6 bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
        <button
          onClick={() => setActiveTab('season')}
          className={`flex-1 sm:flex-none px-3 sm:px-4 py-2 rounded-md text-xs sm:text-sm font-medium transition-colors ${
            activeTab === 'season'
              ? 'bg-white dark:bg-gray-800 text-nw-teal shadow-sm'
              : 'text-gray-500 hover:text-gray-700 dark:text-gray-300'
          }`}
        >
          {season} Season
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`flex-1 sm:flex-none px-3 sm:px-4 py-2 rounded-md text-xs sm:text-sm font-medium transition-colors ${
            activeTab === 'history'
              ? 'bg-white dark:bg-gray-800 text-nw-teal shadow-sm'
              : 'text-gray-500 hover:text-gray-700 dark:text-gray-300'
          }`}
        >
          Program History
        </button>
      </div>

      {/* Current Season Tab */}
      {activeTab === 'season' && (
        <div>
          {/* Season snapshot */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden mb-4 sm:mb-6">
            <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/40">
              <div className="text-sm font-bold text-nw-teal dark:text-gray-100 uppercase tracking-wide">{season} Snapshot</div>
              <SeasonSelect value={season} onChange={setSeason} label="Season" id="team-season" />
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 divide-x divide-y sm:divide-y-0 divide-gray-100 dark:divide-gray-700">
              <SnapCell label="Batters" value={batting.length} />
              <SnapCell label="Pitchers" value={pitching.length} />
              <SnapCell label="Team PA" value={teamPA.toLocaleString()} />
              <SnapCell label="Team IP" value={teamIP.toFixed(1)} />
              <SnapCell label="oWAR" value={teamOWAR.toFixed(1)} accent />
              <SnapCell label="pWAR" value={teamPWAR.toFixed(1)} accent />
              <SnapCell label="Total WAR" value={(teamOWAR + teamPWAR).toFixed(1)} accent strong />
            </div>
          </div>

          {/* Rankings card */}
          {rankings && rankings.composite && (
            <RankingsCard rankings={rankings} />
          )}

          {/* Advanced, Savant-style team look (percentiles vs division, leaders, clutch) */}
          <TeamAdvanced teamId={teamId} season={season} />

          {/* Upcoming Games */}
          {futureData?.games?.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-3 sm:p-5 mb-4 sm:mb-6">
              <h2 className="text-base sm:text-lg font-bold text-nw-teal dark:text-gray-100 mb-3">Upcoming Games</h2>
              <div className="space-y-2">
                {futureData.games.map((g, i) => {
                  const isHome = g.home_team_id === Number(teamId)
                  const oppName = isHome ? (g.away_short || g.away_team) : (g.home_short || g.home_team)
                  const oppLogo = isHome ? g.away_logo : g.home_logo
                  const prefix = isHome ? 'vs' : '@'
                  const dateStr = new Date(g.game_date + 'T12:00:00').toLocaleDateString('en-US', {
                    weekday: 'short', month: 'short', day: 'numeric'
                  })
                  return (
                    <div key={i} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                      <span className="text-xs text-gray-400 w-20 shrink-0">{dateStr}</span>
                      <span className="text-xs font-medium text-gray-500 w-5 shrink-0">{prefix}</span>
                      {oppLogo && (
                        <img src={oppLogo} alt="" className="w-5 h-5 object-contain shrink-0"
                          onError={(e) => { e.target.style.display = 'none' }} />
                      )}
                      <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">{oppName}</span>
                      {g.is_postseason ? (
                        <span className="text-[9px] font-bold text-white bg-rose-600 px-1.5 py-0.5 rounded">PLAYOFFS</span>
                      ) : g.is_conference ? (
                        <span className="text-[9px] font-bold text-nw-teal-light bg-teal-50 px-1.5 py-0.5 rounded">CONF</span>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Batting */}
          <StatSection
            title="Batting" side="bat" teamId={teamId} season={season} rows={batting}
            boxColumns={TEAM_BAT_COLUMNS} presets={TEAM_BATTING_PRESETS}
            pbpColumns={TEAM_BAT_PBP_COLUMNS} defaultSort="plate_appearances"
            csvName={`nwbb_${teamId}_batting_${season}`}
          />

          {/* Pitching */}
          <StatSection
            title="Pitching" side="pit" teamId={teamId} season={season} rows={pitching}
            boxColumns={TEAM_PIT_COLUMNS} presets={TEAM_PITCHING_PRESETS}
            pbpColumns={TEAM_PIT_PBP_COLUMNS} defaultSort="innings_pitched"
            csvName={`nwbb_${teamId}_pitching_${season}`}
          />

          {/* Incoming class: transfers (JUCO/portal) + HS commits, unified */}
          <IncomingClassSection teamId={teamId} />
        </div>
      )}

      {/* History Tab */}
      {activeTab === 'history' && (
        <TeamHistoryTab history={history} loading={historyLoading} teamId={teamId} />
      )}
    </div>
  )
}


// ============================================================
// INCOMING RECRUITING CLASS (HS commits)
// ============================================================

// Level badge color for an incoming transfer's ORIGIN level.
function levelBadgeClass(level) {
  switch (level) {
    case 'D1': return 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
    case 'D2': return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
    case 'D3': return 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
    case 'NAIA': return 'bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300'
    case 'JUCO': return 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
    default: return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
  }
}

const fmtSlash = (v) => v == null ? null : (v >= 1 ? v.toFixed(3) : v.toFixed(3).replace(/^0\./, '.'))

// One incoming transfer row. DB players (kind 'player') link to their profile
// and show origin school/level + a compact stat line; name-only transfers show
// just name + source school.
function TransferRow({ t }) {
  const isPlayer = t.kind === 'player'
  const b = t.bat, p = t.pit
  let statLine = null
  if (isPlayer && t.side === 'pit' && p) {
    statLine = [p.era != null && `${p.era.toFixed(2)} ERA`, p.ip != null && `${Number(p.ip).toFixed(1)} IP`,
                p.k != null && `${p.k} K`].filter(Boolean).join(' · ')
  } else if (isPlayer && b) {
    const ops = (b.obp != null && b.slg != null) ? fmtSlash(b.obp + b.slg) : null
    statLine = [fmtSlash(b.avg) && `${fmtSlash(b.avg)} AVG`, ops && `${ops} OPS`,
                b.hr != null && `${b.hr} HR`].filter(Boolean).join(' · ')
  }
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-gray-50 dark:border-gray-700/50 last:border-0">
      {isPlayer ? (
        <Link to={`/player/${t.player_id}`} className="text-xs font-semibold text-nw-teal dark:text-gray-100 hover:underline whitespace-nowrap">{t.name}</Link>
      ) : (
        <span className="text-xs font-semibold text-gray-800 dark:text-gray-200 whitespace-nowrap">{t.name}</span>
      )}
      {t.position && <span className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase shrink-0">{t.position}</span>}
      <span className="flex-1 text-[11px] text-gray-500 dark:text-gray-400 truncate">
        {isPlayer
          ? <>from <span className="font-medium text-gray-600 dark:text-gray-300">{t.from_team}</span>{statLine ? ` · ${statLine}` : ''}</>
          : (t.from_school ? `from ${t.from_school}` : '')}
      </span>
      <span className={`inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap shrink-0 ${isPlayer ? levelBadgeClass(t.from_level) : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}>
        {isPlayer ? (t.from_level || 'Transfer') : 'Transfer'}
      </span>
    </div>
  )
}

// Unified Incoming Class: incoming transfers (JUCO/portal + name-only) and HS
// commits in one section. Renders nothing when the team has neither.
function IncomingClassSection({ teamId, gradYear = 2026 }) {
  const { data: transferData } = useIncomingTransfers(teamId)
  const { data: recruitData } = useTeamRecruits(teamId, gradYear)
  const transfers = Array.isArray(transferData) ? transferData : []
  const commits = recruitData?.commits || []
  if (!transfers.length && !commits.length) return null

  const classScore = recruitData?.class_score
  const scoredCount = recruitData?.scored_count

  return (
    <div className="mb-8">
      <div className="mb-2 flex items-center gap-2 flex-wrap">
        <h2 className="text-lg sm:text-xl font-bold text-nw-teal dark:text-gray-100">Incoming Class ({gradYear})</h2>
        {classScore != null && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-nw-teal dark:text-nw-teal-light">
            <span className="text-sm font-black tabular-nums">{classScore.toFixed(1)}</span>
            <span className="text-gray-400 dark:text-gray-500 font-medium">avg rating</span>
            {scoredCount != null && (
              <span className="text-gray-400 dark:text-gray-500 font-medium">· {scoredCount} rated</span>
            )}
          </span>
        )}
        <Link to="/recruiting-classes" className="ml-auto text-[11px] font-semibold text-nw-teal hover:underline whitespace-nowrap">
          All classes &rarr;
        </Link>
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-3 sm:p-4 space-y-4">
        {transfers.length > 0 && (
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-nw-teal mb-1.5">
              Transfers <span className="text-gray-400 dark:text-gray-500">· {transfers.length}</span>
            </div>
            <div className="grid sm:grid-cols-2 gap-x-6">
              {transfers.map((t) => <TransferRow key={`${t.kind}-${t.player_id || t.id}`} t={t} />)}
            </div>
          </div>
        )}
        {commits.length > 0 && (
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-nw-teal mb-1.5">
              High School Commits <span className="text-gray-400 dark:text-gray-500">· {commits.length}</span>
            </div>
            <div className="grid sm:grid-cols-2 gap-x-6">
              {commits.map((c) => {
                const rank = c.state_rank
                return (
                  <div key={c.id} className="flex items-center gap-2 py-1.5 border-b border-gray-50 dark:border-gray-700/50 last:border-0">
                    <span className="text-xs font-semibold text-gray-800 dark:text-gray-200 whitespace-nowrap">{c.name}</span>
                    {c.position && (
                      <span className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase shrink-0">{c.position}</span>
                    )}
                    <span className="flex-1 text-[11px] text-gray-500 dark:text-gray-400 truncate">
                      {[c.high_school, c.state].filter(Boolean).join(', ')}
                    </span>
                    {rank != null ? (
                      <span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded bg-teal-50 text-nw-teal dark:bg-teal-900/30 dark:text-teal-300 whitespace-nowrap shrink-0">
                        State #{rank}
                      </span>
                    ) : c.recruit_score == null ? (
                      <span className="text-[10px] italic text-gray-400 dark:text-gray-500 whitespace-nowrap shrink-0">No ranking</span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}


// ============================================================
// HISTORY TAB
// ============================================================

function ChampionshipBanner({ teamId }) {
  const [titles, setTitles] = useState([])

  useEffect(() => {
    if (!teamId) return
    fetch(`/api/v1/teams/${teamId}/championships`)
      .then(r => r.json())
      .then(d => setTitles(d.championships || []))
      .catch((err) => console.error('[TeamDetail] /teams/championships failed:', err))
  }, [teamId])

  if (!titles.length) return null

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-5 mb-6">
      <h2 className="text-lg font-bold text-nw-teal dark:text-gray-100 mb-3">Conference Championships</h2>
      <div className="flex flex-wrap gap-2">
        {titles.map((t, i) => (
          <div
            key={i}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
              t.championship_type === 'Regular Season'
                ? 'bg-amber-50 text-amber-700 border border-amber-200'
                : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
            }`}
          >
            <span className="font-bold">{t.season}</span>
            {' '}
            <span className="opacity-70">{t.championship_type === 'Regular Season' ? 'Reg. Season' : 'Tournament'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TeamHistoryTab({ history, loading, teamId }) {
  const [leaderCategory, setLeaderCategory] = useState('batting')

  if (loading) {
    return <div className="text-gray-400 animate-pulse py-8">Loading history...</div>
  }

  if (!history) {
    return <div className="text-gray-500 py-8">No history data available.</div>
  }

  const { seasons, season_leaders, career_batting_leaders, career_pitching_leaders,
          single_season_batting_records, single_season_pitching_records,
          all_time_summary } = history
  const numSeasons = all_time_summary?.num_seasons || 0
  const minYear = seasons.length > 0 ? seasons[seasons.length - 1].season : null
  const maxYear = seasons.length > 0 ? seasons[0].season : null

  return (
    <div>
      {/* All-Time Summary */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-5 mb-6">
        <h2 className="text-lg font-bold text-nw-teal dark:text-gray-100 mb-1">Program Overview</h2>
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

      {/* Conference Championships */}
      <ChampionshipBanner teamId={teamId} />

      {/* Year-by-Year Records */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-5 mb-6">
        <h2 className="text-lg font-bold text-nw-teal dark:text-gray-100 mb-4">Year-by-Year</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-nw-teal/10 dark:bg-gray-900/50 text-[11px] text-nw-teal dark:text-gray-300 uppercase tracking-wide">
                <th className="text-left py-2 px-2 rounded-l-lg">Year</th>
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
              {seasons.map((s, i) => {
                const w = s.wins || 0
                const l = s.losses || 0
                const winPct = w + l > 0 ? (w / (w + l)).toFixed(3) : '-'
                const diff = s.run_differential || 0
                return (
                  <tr key={s.season} className={`border-b border-gray-100 dark:border-gray-700/60 hover:bg-nw-teal/5 dark:hover:bg-gray-700/40 transition-colors ${i % 2 ? 'bg-gray-50/50 dark:bg-gray-900/20' : ''}`}>
                    <td className="py-2 px-2 font-semibold text-nw-teal dark:text-gray-100">{s.season}</td>
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-5 mb-6">
        <h2 className="text-lg font-bold text-nw-teal dark:text-gray-100 mb-4">Season Award Leaders</h2>
        {seasons.map((s) => {
          const leaders = season_leaders[String(s.season)]
          if (!leaders || Object.keys(leaders).length === 0) return null

          const batLeaders = ['AVG', 'HR', 'RBI', 'H', 'SB', 'wRC+', 'oWAR'].filter(k => leaders[k])
          const pitLeaders = ['ERA', 'K', 'FIP', 'W', 'SV', 'pWAR'].filter(k => leaders[k])

          return (
            <div key={s.season} className="mb-3 last:mb-0 rounded-lg border border-gray-100 dark:border-gray-700 p-3 bg-gray-50/40 dark:bg-gray-900/20">
              <h3 className="text-sm font-bold text-nw-teal dark:text-gray-100 mb-2 flex items-center gap-2">
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
                            className="text-xs inline-flex items-center gap-1 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-0.5 hover:border-nw-teal/60 transition-colors"
                          >
                            <span className="text-gray-500">{cat}:</span>{' '}
                            <span className="font-semibold text-nw-teal dark:text-gray-100">{val}</span>{' '}
                            <span className="text-nw-teal-light">{l.name}</span>
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
                            className="text-xs inline-flex items-center gap-1 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-0.5 hover:border-nw-teal/60 transition-colors"
                          >
                            <span className="text-gray-500">{cat}:</span>{' '}
                            <span className="font-semibold text-nw-teal dark:text-gray-100">{val}</span>{' '}
                            <span className="text-nw-teal-light">{l.name}</span>
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-nw-teal dark:text-gray-100">All-Time Career Leaders</h2>
            <p className="text-xs text-gray-400 mt-0.5">Stats tracked since 2022 season</p>
          </div>
          <div className="flex gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5">
            <button
              onClick={() => setLeaderCategory('batting')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                leaderCategory === 'batting'
                  ? 'bg-white dark:bg-gray-800 text-nw-teal shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-300'
              }`}
            >
              Batting
            </button>
            <button
              onClick={() => setLeaderCategory('pitching')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                leaderCategory === 'pitching'
                  ? 'bg-white dark:bg-gray-800 text-nw-teal shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-300'
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

      {/* Single-Season Records */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-nw-teal dark:text-gray-100">Single-Season Records</h2>
            <p className="text-xs text-gray-400 mt-0.5">Top 5 single-season performances · min 50 PA / 20 IP</p>
          </div>
          <div className="flex gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5">
            <button
              onClick={() => setLeaderCategory('batting')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                leaderCategory === 'batting'
                  ? 'bg-white dark:bg-gray-800 text-nw-teal shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-300'
              }`}
            >
              Batting
            </button>
            <button
              onClick={() => setLeaderCategory('pitching')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                leaderCategory === 'pitching'
                  ? 'bg-white dark:bg-gray-800 text-nw-teal shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-300'
              }`}
            >
              Pitching
            </button>
          </div>
        </div>

        {leaderCategory === 'batting' && (
          <SingleSeasonRecords leaders={single_season_batting_records} type="batting" />
        )}
        {leaderCategory === 'pitching' && (
          <SingleSeasonRecords leaders={single_season_pitching_records} type="pitching" />
        )}
      </div>
    </div>
  )
}


function SingleSeasonRecords({ leaders, type }) {
  if (!leaders || Object.keys(leaders).length === 0) {
    return <div className="text-gray-400 text-sm">No single-season data available.</div>
  }

  const order = type === 'batting'
    ? ['oWAR', 'AVG', 'OPS', 'wRC+', 'HR', 'RBI', 'H', 'R', 'SB', 'BB']
    : ['pWAR', 'ERA', 'WHIP', 'FIP', 'K', 'W', 'SV', 'IP']

  const categories = order.filter(k => leaders[k] && leaders[k].length > 0)

  const fmtVal = (cat, value) => {
    if (value == null) return '—'
    if (cat === 'AVG' || cat === 'OPS') return value.toFixed(3)
    if (cat === 'ERA' || cat === 'WHIP' || cat === 'FIP') return value.toFixed(2)
    if (cat === 'oWAR' || cat === 'pWAR') return value.toFixed(1)
    if (cat === 'IP') return value.toFixed(1)
    if (cat === 'wRC+') return Math.round(value)
    return value
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {categories.map((cat) => (
        <div key={cat} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 p-3 hover:shadow-sm transition-shadow">
          <div className="text-[11px] font-bold text-nw-teal dark:text-nw-teal-light uppercase tracking-wider mb-2 pb-1.5 border-b border-gray-200 dark:border-gray-700">{cat}</div>
          <div className="space-y-1">
            {leaders[cat].slice(0, 5).map((player, i) => (
              <div key={`${player.player_id}-${player.season}`} className="flex items-center gap-2 text-xs">
                <span className={`w-4 text-right font-bold ${
                  i === 0 ? 'text-amber-500' : i === 1 ? 'text-gray-400' : i === 2 ? 'text-amber-700' : 'text-gray-300'
                }`}>
                  {i + 1}
                </span>
                <Link
                  to={`/player/${player.player_id}`}
                  className="text-nw-teal-light hover:underline truncate flex-1"
                >
                  {player.name}
                </Link>
                <span className="font-semibold text-nw-teal dark:text-gray-100 whitespace-nowrap">{fmtVal(cat, player.value)}</span>
                <span className="text-gray-400 text-[10px] whitespace-nowrap">
                  '{String(player.season).slice(-2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
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
        <div key={cat} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 p-3 hover:shadow-sm transition-shadow">
          <div className="text-[11px] font-bold text-nw-teal dark:text-nw-teal-light uppercase tracking-wider mb-2 pb-1.5 border-b border-gray-200 dark:border-gray-700">{cat}</div>
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
                    className="text-nw-teal-light hover:underline truncate flex-1"
                  >
                    {player.name}
                  </Link>
                  <span className="font-semibold text-nw-teal dark:text-gray-100 whitespace-nowrap">{val}</span>
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

// ============================================================
// SEASON STAT TABLES (Box Score / Play-by-Play toggle)
// ============================================================

function SnapCell({ label, value, accent = false, strong = false }) {
  return (
    <div className="px-3 py-3 text-center">
      <div className={`text-lg sm:text-xl font-bold tabular-nums ${
        strong ? 'text-nw-teal-dark dark:text-nw-teal-light'
          : accent ? 'text-nw-teal dark:text-nw-teal-light' : 'text-gray-900 dark:text-gray-100'}`}>
        {value}
      </div>
      <div className="text-[10px] sm:text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wide mt-0.5">{label}</div>
    </div>
  )
}

function ModeToggle({ mode, setMode }) {
  return (
    <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs font-semibold">
      {[['box', 'Box Score'], ['pbp', 'Play-by-Play']].map(([m, label]) => (
        <button key={m} onClick={() => setMode(m)}
          className={`px-3 py-1.5 transition-colors ${mode === m
            ? 'bg-nw-teal text-white'
            : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
          {label}
        </button>
      ))}
    </div>
  )
}

function StatSection({ title, side, teamId, season, rows, boxColumns, presets, pbpColumns, defaultSort, csvName }) {
  const [mode, setMode] = useState('box')
  const [preset, setPreset] = useState('Standard')
  const [sortKey, setSortKey] = useState(defaultSort)
  const [sortDir, setSortDir] = useState('desc')
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const av = a[sortKey] ?? -Infinity, bv = b[sortKey] ?? -Infinity
    return sortDir === 'asc' ? av - bv : bv - av
  }), [rows, sortKey, sortDir])
  return (
    <div className="mb-6 sm:mb-8">
      <div className="mb-2 flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg sm:text-xl font-bold text-nw-teal dark:text-gray-100">{title}</h2>
        <div className="flex items-center gap-2">
          <ModeToggle mode={mode} setMode={setMode} />
          {mode === 'box' && <ExportCSVButton data={sorted} columns={boxColumns} filename={csvName} />}
        </div>
      </div>
      {mode === 'box' ? (
        <>
          <StatPresetBar presets={presets} activePreset={preset} onSelect={setPreset} />
          <StatsTable data={sorted} columns={boxColumns} visibleColumns={presets[preset]}
            sortBy={sortKey} sortDir={sortDir}
            onSort={(k, d) => { setSortKey(k); setSortDir(d) }} loading={false} offset={0} />
        </>
      ) : side === 'bat'
        ? <BatPbpTable teamId={teamId} season={season} columns={pbpColumns} />
        : <PitPbpTable teamId={teamId} season={season} columns={pbpColumns} />}
    </div>
  )
}

function BatPbpTable({ teamId, season, columns }) {
  const { data, loading } = useBattingPbpLeaderboard(
    { season, team_id: Number(teamId), min_pa: 0, limit: 300, sort_by: 'tracked_pa', sort_dir: 'desc' })
  return <PbpTableInner data={data} loading={loading} columns={columns} />
}

function PitPbpTable({ teamId, season, columns }) {
  const { data, loading } = usePitchingPbpLeaderboard(
    { season, team_id: Number(teamId), min_pa: 0, limit: 300, sort_by: 'tracked_pa', sort_dir: 'desc' })
  return <PbpTableInner data={data} loading={loading} columns={columns} />
}

function PbpTableInner({ data, loading, columns }) {
  const [sortKey, setSortKey] = useState('tracked_pa')
  const [sortDir, setSortDir] = useState('desc')
  const rows = data?.data || (Array.isArray(data) ? data : []) || []
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const av = a[sortKey] ?? -Infinity, bv = b[sortKey] ?? -Infinity
    return sortDir === 'asc' ? av - bv : bv - av
  }), [rows, sortKey, sortDir])
  if (!loading && rows.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 text-center text-sm text-gray-400 dark:text-gray-500">
        No play-by-play data tracked for this team this season yet.
      </div>
    )
  }
  return (
    <StatsTable data={sorted} columns={columns} visibleColumns={columns.map(c => c.key)}
      sortBy={sortKey} sortDir={sortDir}
      onSort={(k, d) => { setSortKey(k); setSortDir(d) }} loading={loading} offset={0} />
  )
}


// Modern gradient hero with identity + headline stats pulled from the
// /teams/{id}/info-graphic payload (record, run diff, pythag, ranks).
function HeroHeader({ team, ig }) {
  const r = ig?.record || {}
  const rk = ig?.rankings || {}
  const wins = r.wins ?? 0, losses = r.losses ?? 0, ties = r.ties ?? 0
  const recordStr = ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`
  const winPct = (wins + losses) > 0 ? wins / (wins + losses) : null
  const runDiff = r.run_diff
  return (
    <div className="rounded-2xl shadow-lg overflow-hidden mb-4 sm:mb-6 bg-gradient-to-br from-nw-teal to-nw-teal-dark text-white">
      <div className="px-4 sm:px-6 pt-5 pb-4 flex items-start gap-3 sm:gap-5">
        {team.logo_url && (
          <img src={team.logo_url} alt="" loading="lazy"
            className="h-16 w-16 sm:h-20 sm:w-20 object-contain bg-white/95 rounded-xl p-1.5 shadow-sm shrink-0"
            onError={(e) => { e.target.style.display = 'none' }} />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[10px] sm:text-[11px] uppercase tracking-widest text-white/70 mb-1 flex items-center flex-wrap gap-x-2 gap-y-1">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${divisionBadgeClass(team.division_level)}`}>{team.division_level}</span>
            <span>{[team.city && `${team.city}, ${team.state}`, team.conference_name].filter(Boolean).join(' · ')}</span>
            {ig?.head_coach?.name && <span>· {ig.head_coach.name}</span>}
          </div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-3xl font-bold leading-tight truncate">{team.name}</h1>
            <FavoriteButton type="team" targetId={team.id} />
          </div>
          <div className="flex flex-wrap items-end gap-x-5 gap-y-2 mt-3">
            <HeroStat label="Record" value={recordStr} hint={winPct != null ? `${(winPct * 100).toFixed(1)}%` : ''} />
            {(r.conf_wins != null || r.conf_losses != null) && (
              <HeroStat label="Conference" value={`${r.conf_wins ?? 0}-${r.conf_losses ?? 0}`} />
            )}
            {runDiff != null && (
              <HeroStat label="Run Diff" value={`${runDiff >= 0 ? '+' : ''}${runDiff}`}
                hint={r.runs_for != null ? `${r.runs_for} for / ${r.runs_against} ag` : ''} good={runDiff >= 0} />
            )}
            {r.pythagorean_wins != null && (
              <HeroStat label="Pythag W-L" value={`${r.pythagorean_wins}-${r.pythagorean_losses}`} />
            )}
            {rk.conference_rank != null && (
              <HeroStat label="Conf Rank" value={`#${rk.conference_rank}`}
                hint={rk.conference_total ? `of ${rk.conference_total}` : ''} />
            )}
            {rk.national_rank != null && (
              <HeroStat label="National" value={`#${rk.national_rank}`}
                hint={rk.national_percentile != null ? `${Math.round(rk.national_percentile)}th pct` : ''} />
            )}
            {rk.power_rating != null && (
              <HeroStat label="Power" value={rk.power_rating.toFixed(1)}
                hint={rk.power_rating_div_rank ? `#${rk.power_rating_div_rank} in ${team.division_level}` : ''} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function HeroStat({ label, value, hint, good }) {
  const valueClass = good === true ? 'text-emerald-200' : good === false ? 'text-rose-200' : 'text-white'
  return (
    <div className="leading-none">
      <div className="text-[9px] uppercase tracking-widest text-white/55 mb-1">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-lg sm:text-2xl font-bold tabular-nums ${valueClass}`}>{value}</span>
        {hint && <span className="text-[10px] text-white/60">{hint}</span>}
      </div>
    </div>
  )
}


function SummaryCell({ label, value, highlight = false }) {
  return (
    <div className="text-center">
      <div className={`text-lg font-bold ${highlight ? 'text-nw-teal-dark' : 'text-nw-teal dark:text-gray-100'}`}>
        {value}
      </div>
      <div className="text-xs text-gray-400 uppercase tracking-wide">{label}</div>
    </div>
  )
}


function RankChip({ text, color }) {
  const cls = color === 'green'
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
    : 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
  return <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${cls}`}>{text}</span>
}

function PctBar({ label, pct, color }) {
  return (
    <div className="mt-3 text-left">
      <div className="flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400 mb-1">
        <span>{label}</span>
        <span className="font-semibold text-gray-700 dark:text-gray-200">{pct.toFixed(1)}%</span>
      </div>
      <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  )
}

function RankTile({ accent, label, rank, sub, chips = [], children }) {
  const live = chips.filter(Boolean)
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col bg-gray-50/40 dark:bg-gray-900/30">
      <div className={`h-1 bg-gradient-to-r ${accent}`} />
      <div className="p-3 text-center flex-1">
        <div className="text-3xl font-black text-nw-teal dark:text-gray-100 leading-none">{rank}</div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1.5">{label}</div>
        {sub && <div className="text-[10px] text-gray-400 dark:text-gray-500">{sub}</div>}
        {live.length > 0 && (
          <div className="flex justify-center gap-2 mt-2">
            {live.map(([txt, color], i) => <RankChip key={i} text={txt} color={color} />)}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

function RankingsCard({ rankings }) {
  const comp = rankings.composite
  const pear = rankings.sources?.pear
  const cbr = rankings.sources?.cbr
  const divLevel = rankings.division_level
  const totalTeams = Math.max(pear?.total_teams || 0, cbr?.total_teams || 0)
  const pctColor = (p) => p >= 75 ? '#16a34a' : p >= 50 ? '#ca8a04' : p >= 25 ? '#ea580c' : '#dc2626'

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden mb-4 sm:mb-6">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/40 flex items-baseline justify-between gap-2">
        <div className="text-sm font-bold text-nw-teal dark:text-gray-100 uppercase tracking-wide">Rankings</div>
        <StatsLastUpdated />
      </div>
      <div className="p-3 sm:p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* National */}
        <RankTile
          accent="from-nw-teal to-nw-teal-dark"
          label={`National Rank · ${divLevel}`}
          rank={comp.composite_rank != null ? `#${Math.round(comp.composite_rank)}` : '-'}
          sub={totalTeams ? `of ${totalTeams} teams` : ''}
          chips={[comp.pear_rank && [`Pear #${comp.pear_rank}`, 'green'],
                  comp.cbr_rank && [`CBR #${comp.cbr_rank}`, 'purple']]}
        >
          {comp.national_percentile != null && (
            <PctBar label="National percentile" pct={comp.national_percentile} color={pctColor(comp.national_percentile)} />
          )}
        </RankTile>

        {/* Conference + mini standings */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden bg-gray-50/40 dark:bg-gray-900/30">
          <div className="h-1 bg-gradient-to-r from-indigo-500 to-indigo-700" />
          <div className="p-3">
            <div className="text-center">
              <div className="text-3xl font-black text-nw-teal dark:text-gray-100 leading-none">
                {rankings.conference_rank ? `#${rankings.conference_rank}` : '-'}
              </div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1.5">
                Conference Rank{rankings.conference_total ? ` · ${rankings.conference_abbrev || rankings.conference_name}` : ''}
              </div>
            </div>
            {rankings.conference_standings && rankings.conference_standings.length > 0 && (
              <div className="mt-2.5 space-y-0.5">
                {rankings.conference_standings.map((t) => (
                  <div key={t.team_id}
                    className={`flex items-center justify-between text-[11px] rounded px-1.5 py-0.5 ${
                      t.team_id === rankings.team_id
                        ? 'bg-nw-teal/10 text-nw-teal dark:text-nw-teal-light font-semibold border-l-2 border-nw-teal'
                        : 'text-gray-500 dark:text-gray-400'}`}>
                    <span className="truncate">{t.rank}. {t.short_name}</span>
                    <span className="text-gray-400 tabular-nums shrink-0 ml-2">
                      {t.conf_wins + t.conf_losses > 0 ? `${t.conf_wins}-${t.conf_losses}` : `${t.wins}-${t.losses}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Strength of schedule */}
        <RankTile
          accent="from-amber-400 to-amber-600"
          label="Strength of Schedule"
          rank={comp.composite_sos_rank ? `#${Math.round(comp.composite_sos_rank)}` : '-'}
          sub={totalTeams && comp.composite_sos_rank ? `of ${totalTeams} teams` : ''}
          chips={[pear?.sos_rank && [`Pear #${pear.sos_rank}`, 'green'],
                  cbr?.sos_rank && [`CBR #${cbr.sos_rank}`, 'purple']]}
        />
      </div>
    </div>
  )
}
