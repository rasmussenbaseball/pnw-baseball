// SummerHub — landing for /summer. Internal tab nav covers
// scoreboard, standings, teams, and leaderboards. Single-page so
// nothing about the data hookup or state gets fragmented across
// routes for the v1 ship; we can split into separate pages later.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'

const TABS = [
  { key: 'scoreboard',  label: 'Scoreboard' },
  { key: 'standings',   label: 'Standings' },
  { key: 'batting',     label: 'Batting Leaders' },
  { key: 'pitching',    label: 'Pitching Leaders' },
  { key: 'teams',       label: 'Teams' },
  { key: 'pnw',         label: 'PNW Alumni' },
  { key: 'colleges',    label: 'College Mix' },
]

// 2026 WCL regular season opener — surfaces a banner during exhibitions.
const REGULAR_SEASON_OPENS = new Date('2026-06-04T00:00:00-07:00')

const LEAGUE = 'WCL'
const SEASON = 2026

const fmtAvg = v => v == null ? '—' : Number(v).toFixed(3).replace(/^0/, '')
const fmtEra = v => v == null ? '—' : Number(v).toFixed(2)
const fmtInt = v => v == null ? '—' : Math.round(v)
const fmtDate = d => {
  if (!d) return ''
  const dt = new Date(d)
  // d may arrive as ISO date string from JSON; treat as UTC to avoid TZ jitter
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// ─────────────────────────────────────────────────────────────
// League leaders ticker (always shown above the tab nav)
// ─────────────────────────────────────────────────────────────

const LEADER_CATS = [
  { stat: 'ops',         label: 'OPS',  fmt: 'avg',  side: 'batting',  minPa: 5 },
  { stat: 'batting_avg', label: 'AVG',  fmt: 'avg',  side: 'batting',  minPa: 5 },
  { stat: 'home_runs',   label: 'HR',   fmt: 'int',  side: 'batting',  minPa: 1 },
  { stat: 'rbi',         label: 'RBI',  fmt: 'int',  side: 'batting',  minPa: 1 },
  { stat: 'strikeouts',  label: 'K',    fmt: 'int',  side: 'pitching', minIp: 1 },
  { stat: 'era',         label: 'ERA',  fmt: 'era',  side: 'pitching', minIp: 5 },
]

function LeadersTicker() {
  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-1 py-2 mb-4 overflow-hidden">
      <div className="flex items-center">
        <span className="shrink-0 px-3 py-1 mr-2 rounded text-[10px] font-bold tracking-widest uppercase text-amber-900 bg-amber-100 dark:bg-amber-900/40 dark:text-amber-200">
          WCL Leaders
        </span>
        <div className="flex-1 overflow-x-auto">
          <div className="flex items-center gap-x-5 whitespace-nowrap">
            {LEADER_CATS.map(cat => (
              <LeaderCell key={cat.stat} cat={cat} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function LeaderCell({ cat }) {
  const endpoint = cat.side === 'batting'
    ? '/summer/leaderboards/batting'
    : '/summer/leaderboards/pitching'
  const params = cat.side === 'batting'
    ? { league: LEAGUE, season: SEASON, min_pa: cat.minPa, sort_by: cat.stat, limit: 1 }
    : { league: LEAGUE, season: SEASON, min_ip: cat.minIp, sort_by: cat.stat, limit: 1 }
  const { data, loading } = useApi(endpoint, params, [cat.stat])

  if (loading) {
    return <span className="text-xs text-gray-400 dark:text-gray-500">{cat.label} —</span>
  }
  const top = data?.[0]
  if (!top) {
    return (
      <span className="text-xs">
        <span className="font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">{cat.label}</span>
        <span className="ml-1 text-gray-400 dark:text-gray-500">—</span>
      </span>
    )
  }
  const raw = top[cat.stat]
  const val = cat.fmt === 'avg' ? fmtAvg(raw)
            : cat.fmt === 'era' ? (raw != null ? Number(raw).toFixed(2) : '—')
            : fmtInt(raw)
  return (
    <span className="text-xs">
      <span className="font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{cat.label}</span>
      <Link to={`/summer/players/${top.player_id}`} className="ml-1 font-semibold text-gray-900 dark:text-gray-100 hover:text-nw-teal dark:hover:text-teal-300">
        {top.first_name?.[0]}. {top.last_name}
      </Link>
      <span className="ml-1 text-gray-500 dark:text-gray-400">({top.team_short})</span>
      <span className="ml-1.5 font-bold tabular-nums text-amber-700 dark:text-amber-300">{val}</span>
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
// Sub-views
// ─────────────────────────────────────────────────────────────

function Scoreboard() {
  const { data, loading, error } = useApi('/summer/scoreboard', {
    league: LEAGUE, season: SEASON, days_back: 14, days_ahead: 7,
  })
  if (loading) return <SkeletonRows />
  if (error) return <ErrorState msg={error} />
  if (!data?.length) return <EmptyState msg="No games in the window." />

  // Group by date
  const byDate = {}
  for (const g of data) {
    if (!byDate[g.game_date]) byDate[g.game_date] = []
    byDate[g.game_date].push(g)
  }
  const dates = Object.keys(byDate).sort().reverse()

  return (
    <div className="flex flex-col gap-5">
      {dates.map(d => (
        <div key={d}>
          <div className="text-xs font-bold tracking-wider text-gray-500 dark:text-gray-400 uppercase mb-2">
            {fmtDate(d)}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {byDate[d].map(g => <GameCard key={g.id} g={g} />)}
          </div>
        </div>
      ))}
    </div>
  )
}

function GameCard({ g }) {
  const isFinal = g.status === 'final'
  const awayWon = isFinal && g.away_score > g.home_score
  const homeWon = isFinal && g.home_score > g.away_score
  return (
    <Link
      to={`/summer/games/${g.id}`}
      className="block rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 hover:border-nw-teal dark:hover:border-teal-400 transition"
    >
      <div className="flex justify-between items-center text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1.5">
        <span>{g.status === 'final' ? 'Final' : g.status === 'in_progress' ? 'Live' : 'Scheduled'}</span>
        <span>{fmtDate(g.game_date)}</span>
      </div>
      <Side
        teamId={g.away_team_id} name={g.away_team_name} short={g.away_short} logo={g.away_logo}
        score={g.away_score} bold={awayWon} dim={isFinal && homeWon} />
      <Side
        teamId={g.home_team_id} name={g.home_team_name} short={g.home_short} logo={g.home_logo}
        score={g.home_score} bold={homeWon} dim={isFinal && awayWon} />
    </Link>
  )
}

function Side({ teamId, name, short, logo, score, bold, dim }) {
  return (
    <div className={`flex items-center gap-2 py-0.5 ${dim ? 'opacity-60' : ''}`}>
      {logo
        ? <img src={logo} alt="" className="w-5 h-5 object-contain shrink-0" loading="lazy" />
        : <div className="w-5 h-5 rounded bg-gray-100 dark:bg-gray-700 shrink-0" />}
      <span className={`flex-1 text-[13px] truncate ${bold ? 'font-bold text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'}`}>
        {short || name || 'TBD'}
      </span>
      <span className={`text-base tabular-nums ${bold ? 'font-bold text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-400'}`}>
        {score == null ? '—' : score}
      </span>
    </div>
  )
}

function Standings() {
  const { data, loading, error } = useApi('/summer/standings', { league: LEAGUE, season: SEASON })
  if (loading) return <SkeletonRows />
  if (error) return <ErrorState msg={error} />
  if (!data?.length) {
    return <EmptyState msg="No standings yet — first conference games haven't been played." />
  }
  // Group by division (data sorted server-side division NULLS LAST → wins desc)
  const groups = {}
  for (const r of data) {
    const key = r.division || 'Other'
    if (!groups[key]) groups[key] = []
    groups[key].push(r)
  }
  const order = ['North', 'South', 'East', 'West', 'Other']
  const divisions = Object.keys(groups).sort(
    (a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) -
              (order.indexOf(b) === -1 ? 99 : order.indexOf(b))
  )
  return (
    <div className="flex flex-col gap-5">
      {divisions.map(div => (
        <div key={div}>
          <div className="text-xs font-bold tracking-wider text-gray-500 dark:text-gray-400 uppercase mb-2">
            {div} {div !== 'Other' && 'Division'}
          </div>
          <div className="overflow-x-auto -mx-3 sm:mx-0">
            <div className="min-w-[560px] px-3 sm:px-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <th className="text-left py-2 pl-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">Team</th>
                    <th className="text-right px-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">W</th>
                    <th className="text-right px-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">L</th>
                    <th className="text-right px-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">Pct</th>
                    <th className="text-right px-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">L10</th>
                    <th className="text-center px-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">Strk</th>
                    <th className="text-right px-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">RS</th>
                    <th className="text-right pr-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">RA</th>
                  </tr>
                </thead>
                <tbody>
                  {groups[div].map(row => (
                    <tr key={row.team_id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/60">
                      <td className="py-1.5 pl-2">
                        <Link to={`/summer/teams/${row.team_id}`} className="flex items-center gap-2 text-nw-teal dark:text-teal-300 hover:underline font-semibold">
                          {row.logo_url && <img src={row.logo_url} alt="" className="w-5 h-5 object-contain shrink-0" loading="lazy" />}
                          <span>{row.short_name || row.name}</span>
                        </Link>
                      </td>
                      <td className="text-right px-2 tabular-nums font-bold text-gray-900 dark:text-gray-100">{row.wins}</td>
                      <td className="text-right px-2 tabular-nums text-gray-700 dark:text-gray-300">{row.losses}</td>
                      <td className="text-right px-2 tabular-nums text-gray-700 dark:text-gray-300">{fmtAvg(row.pct)}</td>
                      <td className="text-right px-2 tabular-nums text-gray-700 dark:text-gray-300">{row.l10_wins ?? 0}-{row.l10_losses ?? 0}</td>
                      <td className={`text-center px-2 tabular-nums font-bold ${
                        !row.streak ? 'text-gray-400 dark:text-gray-500'
                        : row.streak.startsWith('W') ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'
                      }`}>{row.streak || '—'}</td>
                      <td className="text-right px-2 tabular-nums text-gray-600 dark:text-gray-400">{row.runs_scored}</td>
                      <td className="text-right pr-2 tabular-nums text-gray-600 dark:text-gray-400">{row.runs_against}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function BattingLeaders() {
  const [sort, setSort] = useState('wrc_plus')
  const { data, loading, error } = useApi('/summer/leaderboards/batting',
    { league: LEAGUE, season: SEASON, min_pa: 10, sort_by: sort, limit: 100 },
    [sort])

  if (loading) return <SkeletonRows />
  if (error) return <ErrorState msg={error} />
  if (!data?.length) {
    return <EmptyState msg="No qualified batters yet. Try lowering the PA filter once games start." />
  }
  return (
    <>
      <SortBar
        value={sort} onChange={setSort}
        options={[
          { value: 'wrc_plus',     label: 'wRC+' },
          { value: 'woba',         label: 'wOBA' },
          { value: 'ops',          label: 'OPS' },
          { value: 'batting_avg',  label: 'AVG' },
          { value: 'on_base_pct',  label: 'OBP' },
          { value: 'slugging_pct', label: 'SLG' },
          { value: 'iso',          label: 'ISO' },
          { value: 'home_runs',    label: 'HR' },
          { value: 'rbi',          label: 'RBI' },
          { value: 'bb_pct',       label: 'BB%' },
          { value: 'k_pct',        label: 'K% (lower=better)' },
          { value: 'offensive_war',label: 'oWAR' },
          { value: 'stolen_bases', label: 'SB' },
        ]}
      />
      <div className="overflow-x-auto -mx-3 sm:mx-0">
        <div className="min-w-[1000px] px-3 sm:px-0">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                {['#','Player','Team','PA','AVG','OBP','SLG','OPS','wOBA','wRC+','ISO','HR','BB%','K%','oWAR'].map((h, i) => (
                  <th key={h} className={`px-1.5 py-1.5 text-xs font-bold text-gray-500 dark:text-gray-400 ${i === 0 || i === 1 || i === 2 ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.player_id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/60">
                  <td className="px-1.5 py-1 text-gray-500 dark:text-gray-400 tabular-nums">{i + 1}</td>
                  <td className="px-1.5 py-1 font-semibold text-gray-900 dark:text-gray-100">
                    <Link to={`/summer/players/${p.player_id}`} className="hover:underline">{p.first_name} {p.last_name}</Link>
                  </td>
                  <td className="px-1.5 py-1">
                    <Link to={`/summer/teams/${p.team_id}`} className="text-nw-teal dark:text-teal-300 hover:underline">{p.team_short || p.team_name}</Link>
                  </td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.plate_appearances)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtAvg(p.batting_avg)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtAvg(p.on_base_pct)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtAvg(p.slugging_pct)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums font-bold">{fmtAvg(p.ops)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtAvg(p.woba)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums font-bold">{p.wrc_plus != null ? Math.round(p.wrc_plus) : '—'}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtAvg(p.iso)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.home_runs)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{p.bb_pct != null ? `${(p.bb_pct * 100).toFixed(1)}%` : '—'}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{p.k_pct != null ? `${(p.k_pct * 100).toFixed(1)}%` : '—'}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{p.offensive_war != null ? Number(p.offensive_war).toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function PitchingLeaders() {
  const [sort, setSort] = useState('fip')
  const { data, loading, error } = useApi('/summer/leaderboards/pitching',
    { league: LEAGUE, season: SEASON, min_ip: 3, sort_by: sort, limit: 100 },
    [sort])
  if (loading) return <SkeletonRows />
  if (error) return <ErrorState msg={error} />
  if (!data?.length) {
    return <EmptyState msg="No qualified pitchers yet. Try lowering the IP filter once games start." />
  }
  return (
    <>
      <SortBar
        value={sort} onChange={setSort}
        options={[
          { value: 'fip',           label: 'FIP (lower=better)' },
          { value: 'era',           label: 'ERA (lower=better)' },
          { value: 'whip',          label: 'WHIP (lower=better)' },
          { value: 'k_pct',         label: 'K%' },
          { value: 'bb_pct',        label: 'BB% (lower=better)' },
          { value: 'k_per_9',       label: 'K/9' },
          { value: 'bb_per_9',      label: 'BB/9 (lower=better)' },
          { value: 'strikeouts',    label: 'Total K' },
          { value: 'wins',          label: 'Wins' },
          { value: 'saves',         label: 'Saves' },
          { value: 'innings_pitched', label: 'IP' },
          { value: 'pitching_war',  label: 'pWAR' },
        ]}
      />
      <div className="overflow-x-auto -mx-3 sm:mx-0">
        <div className="min-w-[1000px] px-3 sm:px-0">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                {['#','Player','Team','IP','W','L','SV','K','BB','ERA','WHIP','FIP','K%','BB%','K/9','pWAR'].map((h, i) => (
                  <th key={h} className={`px-1.5 py-1.5 text-xs font-bold text-gray-500 dark:text-gray-400 ${i === 0 || i === 1 || i === 2 ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.player_id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/60">
                  <td className="px-1.5 py-1 text-gray-500 dark:text-gray-400 tabular-nums">{i + 1}</td>
                  <td className="px-1.5 py-1 font-semibold text-gray-900 dark:text-gray-100">
                    <Link to={`/summer/players/${p.player_id}`} className="hover:underline">{p.first_name} {p.last_name}</Link>
                  </td>
                  <td className="px-1.5 py-1">
                    <Link to={`/summer/teams/${p.team_id}`} className="text-nw-teal dark:text-teal-300 hover:underline">{p.team_short || p.team_name}</Link>
                  </td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{p.innings_pitched != null ? Number(p.innings_pitched).toFixed(1) : '—'}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.wins)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.losses)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.saves)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.strikeouts)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.walks)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums font-bold">{fmtEra(p.era)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtEra(p.whip)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums font-bold">{fmtEra(p.fip)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{p.k_pct != null ? `${(p.k_pct * 100).toFixed(1)}%` : '—'}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{p.bb_pct != null ? `${(p.bb_pct * 100).toFixed(1)}%` : '—'}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtEra(p.k_per_9)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{p.pitching_war != null ? Number(p.pitching_war).toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function PnwAlumni() {
  const { data, loading, error } = useApi('/summer/pnw-alumni', { league: LEAGUE, season: SEASON })
  if (loading) return <SkeletonRows />
  if (error) return <ErrorState msg={error} />
  if (!data?.length) {
    return <EmptyState msg="No PNW alumni linked yet. Pointstreak roster sync usually fills these in mid-June." />
  }
  // Group by spring school
  const groups = {}
  for (const r of data) {
    const key = r.spring_school || 'Other'
    if (!groups[key]) groups[key] = []
    groups[key].push(r)
  }
  const schools = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length || a.localeCompare(b))
  return (
    <div className="flex flex-col gap-5">
      <div className="text-xs text-gray-600 dark:text-gray-400 -mt-2">
        {data.length} PNW college players currently rostered across {Object.keys(groups).length} school{Object.keys(groups).length !== 1 ? 's' : ''}.
      </div>
      {schools.map(school => {
        const players = groups[school]
        return (
          <div key={school}>
            <div className="flex items-center gap-2 mb-2">
              {players[0]?.spring_team_logo && (
                <img src={players[0].spring_team_logo} alt="" className="w-6 h-6 object-contain" loading="lazy" />
              )}
              <Link
                to={players[0]?.spring_team_id ? `/team/${players[0].spring_team_id}` : '#'}
                className="text-sm font-bold tracking-tight text-gray-900 dark:text-gray-100 hover:text-nw-teal"
              >
                {school}
              </Link>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                {players[0]?.division_level || ''}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">{players.length} player{players.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {players.map(p => (
                <Link key={p.summer_player_id} to={`/summer/players/${p.summer_player_id}`}
                  className="flex items-center gap-2 px-3 py-2 rounded bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:border-nw-teal dark:hover:border-teal-400 transition">
                  {p.summer_team_logo && <img src={p.summer_team_logo} alt="" className="w-7 h-7 object-contain shrink-0" loading="lazy" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{p.spring_first} {p.spring_last}</div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                      {p.summer_position?.toUpperCase()} · {p.summer_team_short}{p.year && ` · ${p.year}`}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CollegeMix() {
  const { data, loading, error } = useApi('/summer/college-representation', { league: LEAGUE, season: SEASON, limit: 50 })
  if (loading) return <SkeletonRows />
  if (error) return <ErrorState msg={error} />
  if (!data?.length) {
    return <EmptyState msg="No college data yet. Pointstreak roster sync fills this in once it publishes." />
  }
  const total = data.reduce((s, r) => s + r.players, 0)
  const max = Math.max(...data.map(r => r.players))
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-gray-600 dark:text-gray-400 mb-2">
        Most-represented colleges among current WCL rosters. {data.length} schools, {total} players total.
      </div>
      {data.map((r, idx) => {
        const pct = max > 0 ? (r.players / max) * 100 : 0
        return (
          <div key={(r.college || idx) + (r.spring_team_id || '')} className="flex items-center gap-3 group">
            <div className="w-6 text-right text-xs text-gray-400 dark:text-gray-500 tabular-nums">{idx + 1}</div>
            <div className="w-6 shrink-0">
              {r.spring_team_logo && <img src={r.spring_team_logo} alt="" className="w-6 h-6 object-contain" loading="lazy" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex justify-between items-baseline gap-2">
                {r.spring_team_id
                  ? <Link to={`/team/${r.spring_team_id}`} className="text-sm font-semibold text-gray-900 dark:text-gray-100 hover:text-nw-teal truncate">{r.college}</Link>
                  : <span className="text-sm font-semibold text-gray-700 dark:text-gray-300 truncate">{r.college}</span>}
                <span className="text-xs font-bold tabular-nums text-nw-teal dark:text-teal-300 shrink-0">{r.players}</span>
              </div>
              <div className="h-1.5 rounded bg-gray-100 dark:bg-gray-700 mt-1 overflow-hidden">
                <div className="h-full bg-nw-teal dark:bg-teal-400 rounded" style={{ width: `${pct}%` }} />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Teams() {
  const { data, loading, error } = useApi('/summer/teams', { league: LEAGUE })
  if (loading) return <SkeletonRows />
  if (error) return <ErrorState msg={error} />
  if (!data?.length) return <EmptyState msg="No teams loaded yet." />
  // Group by division
  const groups = {}
  for (const t of data) {
    const key = t.division || 'Other'
    if (!groups[key]) groups[key] = []
    groups[key].push(t)
  }
  const order = ['North', 'South', 'East', 'West', 'Other']
  const divisions = Object.keys(groups).sort(
    (a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) -
              (order.indexOf(b) === -1 ? 99 : order.indexOf(b))
  )
  return (
    <div className="flex flex-col gap-5">
      {divisions.map(div => (
        <div key={div}>
          <div className="text-xs font-bold tracking-wider text-gray-500 dark:text-gray-400 uppercase mb-2">
            {div} {div !== 'Other' && 'Division'}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {groups[div].map(t => (
              <Link
                key={t.id}
                to={`/summer/teams/${t.id}`}
                className="flex items-center gap-3 p-3 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-nw-teal dark:hover:border-teal-400 transition"
              >
                {t.logo_url
                  ? <img src={t.logo_url} alt="" className="w-9 h-9 object-contain shrink-0" loading="lazy" />
                  : <div className="w-9 h-9 rounded bg-gray-100 dark:bg-gray-700 shrink-0" />}
                <div className="min-w-0">
                  <div className="text-sm font-bold text-gray-900 dark:text-gray-100 truncate">{t.name}</div>
                  {t.city && <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{t.city}{t.state ? `, ${t.state}` : ''}</div>}
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── shared bits ────────────────────────────────────────────────

function SortBar({ value, onChange, options }) {
  // Accept either ['ops','avg',...] OR [{value, label}, ...]
  const opts = options.map(o => typeof o === 'string' ? { value: o, label: o } : o)
  return (
    <div className="flex items-center gap-2 mb-3 text-xs">
      <span className="text-gray-500 dark:text-gray-400 font-bold uppercase tracking-wider">Sort:</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs"
      >
        {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

function SkeletonRows() {
  return (
    <div className="flex flex-col gap-2 animate-pulse">
      {[0, 1, 2, 3, 4].map(i => (
        <div key={i} className="h-9 rounded bg-gray-100 dark:bg-gray-800" />
      ))}
    </div>
  )
}

function EmptyState({ msg }) {
  return <div className="text-center py-12 text-gray-500 dark:text-gray-400 text-sm">{msg}</div>
}

function ErrorState({ msg }) {
  return <div className="text-center py-12 text-rose-600 dark:text-rose-400 text-sm">{String(msg)}</div>
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

export default function SummerHub() {
  const [tab, setTab] = useState('scoreboard')
  const preSeason = new Date() < REGULAR_SEASON_OPENS
  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4">
      {/* WCL hero — gold/navy gradient. Tailwind colors so dark mode behaves. */}
      <div
        className="relative overflow-hidden rounded-lg mb-4 border border-amber-300/40 dark:border-amber-700/40 shadow-sm"
        style={{ background: 'linear-gradient(120deg, #14365c 0%, #1f5485 55%, #c9a44c 100%)' }}
      >
        <div className="absolute inset-0 opacity-10 pointer-events-none"
          style={{ backgroundImage: 'radial-gradient(circle at 20% 30%, rgba(255,255,255,0.4), transparent 40%), radial-gradient(circle at 80% 70%, rgba(255,255,255,0.2), transparent 40%)' }} />
        <div className="relative px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="text-[10px] sm:text-xs font-bold tracking-[0.2em] uppercase text-amber-200">
              West Coast League · {SEASON}
            </span>
            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold tracking-widest uppercase bg-amber-300/30 text-amber-100 border border-amber-300/40">
              Summer
            </span>
          </div>
          <h1 className="mt-1 text-2xl sm:text-4xl font-bold text-white tracking-tight">
            WCL Hub
          </h1>
          <p className="mt-1.5 text-xs sm:text-sm text-amber-100/80 max-w-2xl">
            Daily box scores, standings, and player leaderboards across the West Coast League.
            Cross-linked to NWBB Stats spring profiles so you can track college players all year.
          </p>
        </div>
      </div>

      {preSeason && (
        <div className="rounded-md border border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 mb-4 flex items-start gap-2">
          <div className="text-xs sm:text-sm text-amber-900 dark:text-amber-200">
            <span className="font-bold">Preseason.</span> WCL regular season opens Wednesday, June 4. Exhibition games are showing now;
            standings + leaderboards fill in once league play begins.
          </div>
        </div>
      )}

      <LeadersTicker />

      <div className="flex overflow-x-auto border-b border-gray-200 dark:border-gray-700 mb-5 -mx-3 sm:mx-0 px-3 sm:px-0 gap-1">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm font-semibold whitespace-nowrap border-b-2 transition ${
              tab === t.key
                ? 'border-nw-teal text-nw-teal dark:border-teal-300 dark:text-teal-300'
                : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-[260px]">
        {tab === 'scoreboard' && <Scoreboard />}
        {tab === 'standings'  && <Standings />}
        {tab === 'batting'    && <BattingLeaders />}
        {tab === 'pitching'   && <PitchingLeaders />}
        {tab === 'teams'      && <Teams />}
        {tab === 'pnw'        && <PnwAlumni />}
        {tab === 'colleges'   && <CollegeMix />}
      </div>
    </div>
  )
}
