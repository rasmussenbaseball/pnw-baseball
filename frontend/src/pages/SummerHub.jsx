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
]

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
  return (
    <div className="overflow-x-auto -mx-3 sm:mx-0">
      <div className="min-w-[560px] px-3 sm:px-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700">
              <th className="text-left py-2 pl-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">Team</th>
              <th className="text-right px-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">W</th>
              <th className="text-right px-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">L</th>
              <th className="text-right px-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">Pct</th>
              <th className="text-right px-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">RS</th>
              <th className="text-right pr-2 text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">RA</th>
            </tr>
          </thead>
          <tbody>
            {data.map(row => (
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
                <td className="text-right px-2 tabular-nums text-gray-600 dark:text-gray-400">{row.runs_scored}</td>
                <td className="text-right pr-2 tabular-nums text-gray-600 dark:text-gray-400">{row.runs_against}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function BattingLeaders() {
  const [sort, setSort] = useState('ops')
  const { data, loading, error } = useApi('/summer/leaderboards/batting',
    { league: LEAGUE, season: SEASON, min_pa: 20, sort_by: sort, limit: 100 },
    [sort])

  if (loading) return <SkeletonRows />
  if (error) return <ErrorState msg={error} />
  if (!data?.length) {
    return <EmptyState msg="No qualified batters yet — needs 20+ PA." />
  }
  return (
    <>
      <SortBar
        value={sort} onChange={setSort}
        options={['ops','batting_avg','on_base_pct','slugging_pct','home_runs','rbi','hits','stolen_bases','walks','runs']}
      />
      <div className="overflow-x-auto -mx-3 sm:mx-0">
        <div className="min-w-[820px] px-3 sm:px-0">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                {['#','Player','Team','PA','AVG','OBP','SLG','OPS','HR','RBI','SB'].map((h, i) => (
                  <th key={h} className={`px-1.5 py-1.5 text-xs font-bold text-gray-500 dark:text-gray-400 ${i === 0 || i === 1 || i === 2 ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.player_id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/60">
                  <td className="px-1.5 py-1 text-gray-500 dark:text-gray-400 tabular-nums">{i + 1}</td>
                  <td className="px-1.5 py-1 font-semibold text-gray-900 dark:text-gray-100">{p.first_name} {p.last_name}</td>
                  <td className="px-1.5 py-1">
                    <Link to={`/summer/teams/${p.team_id}`} className="text-nw-teal dark:text-teal-300 hover:underline">{p.team_short || p.team_name}</Link>
                  </td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.plate_appearances)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtAvg(p.batting_avg)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtAvg(p.on_base_pct)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtAvg(p.slugging_pct)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums font-bold">{fmtAvg(p.ops)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.home_runs)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.rbi)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.stolen_bases)}</td>
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
  const [sort, setSort] = useState('era')
  const { data, loading, error } = useApi('/summer/leaderboards/pitching',
    { league: LEAGUE, season: SEASON, min_ip: 5, sort_by: sort, limit: 100 },
    [sort])
  if (loading) return <SkeletonRows />
  if (error) return <ErrorState msg={error} />
  if (!data?.length) {
    return <EmptyState msg="No qualified pitchers yet — needs 5+ IP." />
  }
  return (
    <>
      <SortBar
        value={sort} onChange={setSort}
        options={['era','whip','k_per_9','bb_per_9','strikeouts','wins','saves','innings_pitched']}
      />
      <div className="overflow-x-auto -mx-3 sm:mx-0">
        <div className="min-w-[820px] px-3 sm:px-0">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                {['#','Player','Team','IP','W','L','SV','K','BB','ERA','WHIP','K/9'].map((h, i) => (
                  <th key={h} className={`px-1.5 py-1.5 text-xs font-bold text-gray-500 dark:text-gray-400 ${i === 0 || i === 1 || i === 2 ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.player_id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/60">
                  <td className="px-1.5 py-1 text-gray-500 dark:text-gray-400 tabular-nums">{i + 1}</td>
                  <td className="px-1.5 py-1 font-semibold text-gray-900 dark:text-gray-100">{p.first_name} {p.last_name}</td>
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
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtEra(p.k_per_9)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function Teams() {
  const { data, loading, error } = useApi('/summer/teams', { league: LEAGUE })
  if (loading) return <SkeletonRows />
  if (error) return <ErrorState msg={error} />
  if (!data?.length) return <EmptyState msg="No teams loaded yet." />
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {data.map(t => (
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
  )
}

// ── shared bits ────────────────────────────────────────────────

function SortBar({ value, onChange, options }) {
  return (
    <div className="flex items-center gap-2 mb-3 text-xs">
      <span className="text-gray-500 dark:text-gray-400 font-bold uppercase tracking-wider">Sort:</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs"
      >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
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
  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4">
      <div className="mb-4">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">
            Summer
          </h1>
          <span className="text-sm font-semibold text-gray-500 dark:text-gray-400">
            West Coast League · {SEASON}
          </span>
        </div>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Daily scoreboard, standings, and player leaderboards across the WCL. Scrapes refresh every morning.
        </p>
      </div>

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
      </div>
    </div>
  )
}
