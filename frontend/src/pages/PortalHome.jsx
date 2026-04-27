// PortalHome — coach-facing dashboard tailored to the team selected
// in PortalTeamContext. Surfaces a "morning coffee" snapshot: record,
// recent form, leaders, clutch performers, schedule, and moments.
//
// Data hooks are existing site endpoints — the dashboard composes
// them rather than asking for a new backend endpoint.

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  useTeamStats,
  useTeamRankings,
  useTeamGames,
  useTeamFutureGames,
  useTopMoments,
} from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'

const SEASON = 2026


export default function PortalHome() {
  const { team } = usePortalTeam()

  // We never reach this without a team — PortalTeamGate prompts first —
  // but defensively guard.
  if (!team) return null

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-5 py-5 space-y-5">
      <Hero team={team} />
      <RecentForm teamId={team.id} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopHitterSpotlight teamId={team.id} />
        <TopPitcherSpotlight teamId={team.id} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopHittersBoard teamId={team.id} />
        <TopPitchersBoard teamId={team.id} />
      </div>

      <ClutchPerformers teamId={team.id} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <UpcomingSchedule teamId={team.id} />
        <TopMomentsForTeam teamId={team.id} />
      </div>
    </div>
  )
}


// ───────────────────────────────────────────────────────────────
// 1. Hero — team header strip with record + standing
// ───────────────────────────────────────────────────────────────
function Hero({ team }) {
  const { data: stats } = useTeamStats(team.id, SEASON)
  const { data: rankings } = useTeamRankings(team.id, SEASON)

  const ts = stats?.team_season_stats || {}
  const wins = ts.wins ?? 0
  const losses = ts.losses ?? 0
  const ties = ts.ties ?? 0
  const runs_for = ts.runs ?? 0
  const runs_against = ts.runs_allowed ?? 0
  const run_diff = runs_for - runs_against
  const recordStr = ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`
  const winPct = (wins + losses) > 0 ? (wins / (wins + losses)) : 0

  return (
    <div className="bg-portal-purple text-portal-cream rounded-2xl shadow-md
                    p-5 sm:p-6 flex items-center gap-4 sm:gap-6">
      {team.logo_url && (
        <img
          src={team.logo_url}
          alt=""
          className="h-20 w-20 sm:h-24 sm:w-24 object-contain bg-white/95 rounded-xl p-1.5 shadow-sm"
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-widest text-portal-accent font-semibold mb-1">
          {team.division_level}
          {rankings?.conference_name ? ` · ${rankings.conference_name}` : ''}
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold leading-tight">
          {team.short_name || team.name}
        </h1>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mt-2">
          <Stat label="Record" value={recordStr} hint={`${(winPct * 100).toFixed(1)}%`} />
          <Stat
            label="Run diff"
            value={`${run_diff >= 0 ? '+' : ''}${run_diff}`}
            hint={`${runs_for} for / ${runs_against} against`}
          />
          {rankings?.conference_rank && (
            <Stat label="Conf rank" value={`#${rankings.conference_rank}`} />
          )}
          {rankings?.composite_rank && (
            <Stat label="National" value={`#${rankings.composite_rank}`} />
          )}
        </div>
      </div>
    </div>
  )
}


function Stat({ label, value, hint }) {
  return (
    <div className="leading-none">
      <div className="text-[10px] uppercase tracking-widest text-portal-cream/60 mb-0.5">
        {label}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-xl sm:text-2xl font-bold tabular-nums">{value}</span>
        {hint && <span className="text-[11px] text-portal-cream/60">{hint}</span>}
      </div>
    </div>
  )
}


// ───────────────────────────────────────────────────────────────
// 2. Recent Form — last 10 games as W/L pills
// ───────────────────────────────────────────────────────────────
function RecentForm({ teamId }) {
  const { data: games } = useTeamGames(teamId, SEASON)
  const last10 = useMemo(() => {
    if (!games) return []
    const finals = games.filter(g => g.status === 'final')
    return finals.slice(-10)
  }, [games])

  if (!games) return <Skeleton label="Recent form" rows={1} />

  if (last10.length === 0) {
    return (
      <Card title="Recent Form" subtitle="Last 10 games">
        <div className="text-xs text-gray-400 text-center py-4">
          No games played yet this season.
        </div>
      </Card>
    )
  }

  return (
    <Card title="Recent Form" subtitle={`Last ${last10.length}`}>
      <div className="flex flex-wrap items-stretch gap-2">
        {last10.map((g) => {
          const isHome = g.home_team_id === teamId
          const myScore = isHome ? g.home_score : g.away_score
          const oppScore = isHome ? g.away_score : g.home_score
          const oppShort = isHome ? g.away_short : g.home_short
          const oppLogo = isHome ? g.away_logo : g.home_logo
          const won = myScore > oppScore
          const tied = myScore === oppScore
          const wlClass = tied
            ? 'bg-gray-100 text-gray-700 border-gray-200'
            : won
              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
              : 'bg-rose-50 text-rose-800 border-rose-200'
          return (
            <div
              key={g.id}
              className={`flex flex-col items-center justify-center
                          rounded border px-2 py-1.5 min-w-[58px] ${wlClass}`}
              title={`${formatDate(g.game_date)} ${isHome ? 'vs' : '@'} ${oppShort}`}
            >
              <div className="text-[10px] font-bold uppercase tracking-wider">
                {tied ? 'T' : won ? 'W' : 'L'}
              </div>
              <div className="text-xs font-semibold tabular-nums leading-tight">
                {myScore}-{oppScore}
              </div>
              <div className="flex items-center gap-1 mt-0.5">
                {oppLogo && <img src={oppLogo} alt="" className="h-3 w-3 object-contain" />}
                <span className="text-[9px] text-gray-500 truncate max-w-[60px]">
                  {isHome ? '' : '@'}{oppShort}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}


// ───────────────────────────────────────────────────────────────
// 3. Top Hitter / Pitcher spotlight cards
// ───────────────────────────────────────────────────────────────
function TopHitterSpotlight({ teamId }) {
  const { data: stats } = useTeamStats(teamId, SEASON)
  const top = useMemo(() => {
    const list = stats?.batting || []
    return [...list]
      .filter(p => (p.plate_appearances || 0) >= 30)
      .sort((a, b) => (b.offensive_war || 0) - (a.offensive_war || 0))[0]
  }, [stats])
  if (!stats) return <Skeleton label="Top hitter" rows={4} />
  if (!top) return null
  return (
    <SpotlightCard
      eyebrow="Top Hitter"
      player={top}
      stats={[
        { label: 'AVG/OBP/SLG',
          value: `${fmtAvg(top.batting_avg)}/${fmtAvg(top.on_base_pct)}/${fmtAvg(top.slugging_pct)}` },
        { label: 'wRC+', value: top.wrc_plus != null ? Math.round(top.wrc_plus) : '—' },
        { label: 'WAR', value: fmtWar(top.offensive_war) },
        { label: 'HR', value: top.home_runs ?? '—' },
      ]}
      accentColor="bg-emerald-50 border-emerald-200"
    />
  )
}


function TopPitcherSpotlight({ teamId }) {
  const { data: stats } = useTeamStats(teamId, SEASON)
  const top = useMemo(() => {
    const list = stats?.pitching || []
    return [...list]
      .filter(p => (p.innings_pitched || 0) >= 5)
      .sort((a, b) => (b.pitching_war || 0) - (a.pitching_war || 0))[0]
  }, [stats])
  if (!stats) return <Skeleton label="Top pitcher" rows={4} />
  if (!top) return null
  return (
    <SpotlightCard
      eyebrow="Top Pitcher"
      player={top}
      stats={[
        { label: 'ERA', value: fmtEra(top.era) },
        { label: 'FIP', value: fmtEra(top.fip) },
        { label: 'IP', value: fmtIp(top.innings_pitched) },
        { label: 'WAR', value: fmtWar(top.pitching_war) },
      ]}
      accentColor="bg-sky-50 border-sky-200"
    />
  )
}


function SpotlightCard({ eyebrow, player, stats, accentColor }) {
  return (
    <div className={`border rounded-xl overflow-hidden bg-white shadow-sm`}>
      <div className={`${accentColor} px-4 py-2 border-b`}>
        <div className="text-[10px] uppercase tracking-widest font-semibold text-portal-accent">
          {eyebrow}
        </div>
      </div>
      <div className="p-4 flex items-center gap-4">
        {player.headshot_url && (
          <img
            src={player.headshot_url}
            alt=""
            className="h-16 w-16 sm:h-20 sm:w-20 rounded-lg object-cover bg-gray-100 shrink-0"
            onError={(e) => { e.currentTarget.style.display = 'none' }}
          />
        )}
        <div className="flex-1 min-w-0">
          <Link
            to={`/players/${player.player_id}`}
            className="text-base sm:text-lg font-bold text-portal-purple-dark hover:underline"
          >
            {player.player_name || `${player.first_name} ${player.last_name}`}
          </Link>
          <div className="text-[11px] text-gray-500 mb-2">
            {player.position || ''}
            {player.year_in_school ? ` · ${player.year_in_school}` : ''}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {stats.map((s, i) => (
              <div key={i}>
                <div className="text-[9px] uppercase tracking-wide text-gray-400">{s.label}</div>
                <div className="text-sm font-bold tabular-nums">{s.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}


// ───────────────────────────────────────────────────────────────
// 4. Top hitters / pitchers leaderboards
// ───────────────────────────────────────────────────────────────
function TopHittersBoard({ teamId }) {
  const { data: stats } = useTeamStats(teamId, SEASON)
  const rows = useMemo(() => {
    const list = stats?.batting || []
    return [...list]
      .filter(p => (p.plate_appearances || 0) >= 30)
      .sort((a, b) => (b.offensive_war || 0) - (a.offensive_war || 0))
      .slice(0, 5)
  }, [stats])
  if (!stats) return <Skeleton label="Top hitters" rows={5} />
  return (
    <Card title="Top Hitters" subtitle="By WAR · min 30 PA">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-gray-400 border-b border-gray-100">
            <th className="text-left pb-1">Player</th>
            <th className="text-right pb-1">AVG</th>
            <th className="text-right pb-1">OPS</th>
            <th className="text-right pb-1">HR</th>
            <th className="text-right pb-1">WAR</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.player_id || i} className="border-b border-gray-50 last:border-0">
              <td className="py-1.5">
                <Link
                  to={`/players/${p.player_id}`}
                  className="text-portal-purple-dark hover:underline font-medium"
                >
                  {p.player_name || `${p.first_name} ${p.last_name}`}
                </Link>
              </td>
              <td className="text-right tabular-nums">{fmtAvg(p.batting_avg)}</td>
              <td className="text-right tabular-nums">{fmtAvg(p.ops)}</td>
              <td className="text-right tabular-nums">{p.home_runs ?? '—'}</td>
              <td className="text-right font-semibold tabular-nums">{fmtWar(p.offensive_war)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={5} className="text-center text-gray-400 text-xs py-3">
              No qualified hitters yet.
            </td></tr>
          )}
        </tbody>
      </table>
    </Card>
  )
}


function TopPitchersBoard({ teamId }) {
  const { data: stats } = useTeamStats(teamId, SEASON)
  const rows = useMemo(() => {
    const list = stats?.pitching || []
    return [...list]
      .filter(p => (p.innings_pitched || 0) >= 5)
      .sort((a, b) => (b.pitching_war || 0) - (a.pitching_war || 0))
      .slice(0, 5)
  }, [stats])
  if (!stats) return <Skeleton label="Top pitchers" rows={5} />
  return (
    <Card title="Top Pitchers" subtitle="By WAR · min 5 IP">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-gray-400 border-b border-gray-100">
            <th className="text-left pb-1">Player</th>
            <th className="text-right pb-1">ERA</th>
            <th className="text-right pb-1">FIP</th>
            <th className="text-right pb-1">IP</th>
            <th className="text-right pb-1">WAR</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.player_id || i} className="border-b border-gray-50 last:border-0">
              <td className="py-1.5">
                <Link
                  to={`/players/${p.player_id}`}
                  className="text-portal-purple-dark hover:underline font-medium"
                >
                  {p.player_name || `${p.first_name} ${p.last_name}`}
                </Link>
              </td>
              <td className="text-right tabular-nums">{fmtEra(p.era)}</td>
              <td className="text-right tabular-nums">{fmtEra(p.fip)}</td>
              <td className="text-right tabular-nums">{fmtIp(p.innings_pitched)}</td>
              <td className="text-right font-semibold tabular-nums">{fmtWar(p.pitching_war)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={5} className="text-center text-gray-400 text-xs py-3">
              No qualified pitchers yet.
            </td></tr>
          )}
        </tbody>
      </table>
    </Card>
  )
}


// ───────────────────────────────────────────────────────────────
// 5. Clutch performers — top WPA contributors on this team
// ───────────────────────────────────────────────────────────────
function ClutchPerformers({ teamId }) {
  // We use the league-wide top moments endpoint and filter client-side
  // for this team's players. moments_limit + leaderboard_limit are
  // raised to give us a fuller pool to filter against.
  const { data } = useTopMoments(SEASON, { leaderboard_limit: 100 })
  const hitters = useMemo(() => {
    if (!data?.top_hitters) return []
    return data.top_hitters
      .filter(p => p.team_id === teamId)
      .slice(0, 4)
  }, [data, teamId])
  const pitchers = useMemo(() => {
    if (!data?.top_pitchers) return []
    return data.top_pitchers
      .filter(p => p.team_id === teamId)
      .slice(0, 4)
  }, [data, teamId])
  if (!data) return <Skeleton label="Clutch performers" rows={3} />
  if (hitters.length === 0 && pitchers.length === 0) return null
  return (
    <Card title="Clutch Performers" subtitle="Highest cumulative Win Probability Added">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-portal-accent font-semibold mb-2">
            Hitters
          </div>
          {hitters.length === 0 ? (
            <div className="text-xs text-gray-400 italic">No qualified hitters yet.</div>
          ) : (
            <ul className="space-y-1.5">
              {hitters.map(p => <ClutchRow key={p.player_id} player={p} unit="PA" />)}
            </ul>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-portal-accent font-semibold mb-2">
            Pitchers
          </div>
          {pitchers.length === 0 ? (
            <div className="text-xs text-gray-400 italic">No qualified pitchers yet.</div>
          ) : (
            <ul className="space-y-1.5">
              {pitchers.map(p => <ClutchRow key={p.player_id} player={p} unit="BF" />)}
            </ul>
          )}
        </div>
      </div>
    </Card>
  )
}


function ClutchRow({ player, unit }) {
  const sign = player.total_wpa >= 0 ? '+' : ''
  const colorClass = player.total_wpa >= 0.5 ? 'text-emerald-700'
    : player.total_wpa <= -0.5 ? 'text-rose-700' : 'text-gray-700'
  return (
    <li className="flex items-center justify-between gap-2">
      <Link
        to={`/players/${player.player_id}`}
        className="text-sm font-semibold text-portal-purple-dark hover:underline truncate"
      >
        {player.name}
      </Link>
      <div className="flex items-baseline gap-2 shrink-0">
        <span className={`text-sm font-bold tabular-nums ${colorClass}`}>
          {sign}{player.total_wpa.toFixed(2)}
        </span>
        <span className="text-[10px] text-gray-400">{player.pa || player.bf} {unit}</span>
      </div>
    </li>
  )
}


// ───────────────────────────────────────────────────────────────
// 6. Upcoming schedule
// ───────────────────────────────────────────────────────────────
function UpcomingSchedule({ teamId }) {
  const { data: games } = useTeamFutureGames(teamId, 6)
  if (!games) return <Skeleton label="Upcoming" rows={3} />
  if (games.length === 0) {
    return (
      <Card title="Upcoming Schedule" subtitle="Next games">
        <div className="text-xs text-gray-400 text-center py-4">
          No games scheduled.
        </div>
      </Card>
    )
  }
  return (
    <Card title="Upcoming Schedule" subtitle="Next games">
      <ul className="divide-y divide-gray-100">
        {games.map(g => {
          const isHome = g.home_team_id === teamId
          const oppShort = isHome ? g.away_short : g.home_short
          const oppLogo = isHome ? g.away_logo : g.home_logo
          return (
            <li key={g.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="text-[11px] text-gray-500 tabular-nums w-16 shrink-0">
                {formatDate(g.game_date)}
              </span>
              <span className="text-[10px] text-gray-400 w-5 shrink-0">
                {isHome ? 'vs' : '@'}
              </span>
              {oppLogo && <img src={oppLogo} alt="" className="h-5 w-5 object-contain shrink-0" />}
              <span className="font-medium text-gray-900 truncate">{oppShort || 'TBD'}</span>
              {g.is_conference && (
                <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5
                                  rounded bg-portal-accent/15 text-portal-accent
                                  font-bold ml-auto shrink-0">
                  Conf
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}


// ───────────────────────────────────────────────────────────────
// 7. Top moments — this team's biggest WPA plays of the season
// ───────────────────────────────────────────────────────────────
function TopMomentsForTeam({ teamId }) {
  const { data } = useTopMoments(SEASON, { moments_limit: 50 })
  const moments = useMemo(() => {
    if (!data?.hitter_moments && !data?.pitcher_moments) return []
    const all = [...(data.hitter_moments || []), ...(data.pitcher_moments || [])]
    // A team's "moment" is one where one of their players was either
    // batter (hit) or pitcher (pitching gem). Filter on team_id of
    // the featured player for that perspective.
    const filtered = all.filter(m => {
      const featured = m.perspective === 'batter' ? m.batter : m.pitcher
      return featured?.team_id === teamId
    })
    // Sort by wpa desc, dedupe by event id, take 4
    const byId = new Map()
    filtered
      .sort((a, b) => b.wpa - a.wpa)
      .forEach(m => { if (!byId.has(m.id)) byId.set(m.id, m) })
    return Array.from(byId.values()).slice(0, 4)
  }, [data, teamId])
  if (!data) return <Skeleton label="Top moments" rows={3} />
  if (moments.length === 0) {
    return (
      <Card title="Top Moments" subtitle="Biggest single-PA WPA swings">
        <div className="text-xs text-gray-400 text-center py-4">
          No clutch moments yet — they'll appear as the season builds.
        </div>
      </Card>
    )
  }
  return (
    <Card title="Top Moments" subtitle="Biggest single-PA WPA swings">
      <ul className="space-y-2">
        {moments.map(m => {
          const featured = m.perspective === 'batter' ? m.batter : m.pitcher
          const sign = m.wpa >= 0 ? '+' : ''
          const result = formatResult(m.result_type)
          const date = m.game_date
            ? new Date(m.game_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : '—'
          const inn = `${m.half === 'top' ? 'T' : 'B'}${m.inning}`
          return (
            <li key={m.id} className="flex items-center gap-3">
              <span className="text-base font-bold text-emerald-700 tabular-nums w-14 shrink-0">
                {sign}{m.wpa.toFixed(2)}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-portal-purple-dark truncate">
                  <Link to={`/players/${featured.id}`} className="hover:underline">
                    {featured.name}
                  </Link>
                  <span className="text-xs text-gray-500 font-normal ml-1.5">
                    · {result.toLowerCase()}
                  </span>
                </div>
                <div className="text-[10px] text-gray-500">
                  {date} · {inn} · vs {m.perspective === 'batter' ? m.pitcher.name : m.batter.name}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}


// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

function Card({ title, subtitle, children }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm">
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-baseline justify-between gap-2">
        <div className="text-sm font-bold text-portal-purple-dark uppercase tracking-wide">
          {title}
        </div>
        {subtitle && (
          <div className="text-[10px] text-gray-500 truncate">{subtitle}</div>
        )}
      </div>
      <div className="p-3 sm:p-4">
        {children}
      </div>
    </div>
  )
}


function Skeleton({ label, rows = 3 }) {
  return (
    <Card title={label} subtitle="loading…">
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-4 bg-gray-100 animate-pulse rounded" />
        ))}
      </div>
    </Card>
  )
}


function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}


function fmtAvg(v) {
  if (v == null) return '—'
  return v >= 1 ? v.toFixed(3) : v.toFixed(3).replace('0.', '.')
}
function fmtEra(v) {
  if (v == null) return '—'
  return v.toFixed(2)
}
function fmtIp(v) {
  if (v == null) return '—'
  return v.toFixed(1)
}
function fmtWar(v) {
  if (v == null) return '—'
  return v.toFixed(1)
}


function formatResult(rt) {
  const map = {
    home_run: 'Home run', triple: 'Triple', double: 'Double', single: 'Single',
    walk: 'Walk', intentional_walk: 'IBB', hbp: 'HBP',
    strikeout_swinging: 'K (swinging)', strikeout_looking: 'K (looking)',
    ground_out: 'Ground out', fly_out: 'Fly out', line_out: 'Line out',
    pop_out: 'Pop out', sac_fly: 'Sac fly', sac_bunt: 'Sac bunt',
    fielders_choice: "Fielder's choice", error: 'ROE',
    double_play: 'Double play', triple_play: 'Triple play',
    catcher_interference: "Catcher's int.",
  }
  return map[rt] || rt || '—'
}
