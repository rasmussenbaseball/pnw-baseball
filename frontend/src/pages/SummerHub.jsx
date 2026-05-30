// SummerHub — landing for /summer. Internal tab nav covers
// scoreboard, standings, teams, and leaderboards. Single-page so
// nothing about the data hookup or state gets fragmented across
// routes for the v1 ship; we can split into separate pages later.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'

const TABS = [
  { key: 'scoreboard',  label: 'Scoreboard' },
  { key: 'calendar',    label: 'Calendar' },
  { key: 'standings',   label: 'Standings' },
  { key: 'batting',     label: 'Batting' },
  { key: 'pitching',    label: 'Pitching' },
  { key: 'fielding',    label: 'Fielding' },
  { key: 'teams',       label: 'Teams' },
  { key: 'pnw',         label: 'PNW Alumni' },
  { key: 'colleges',    label: 'College Mix' },
]

// 2026 WCL key dates. The schedule scraper marks games as
// 'exhibition' / 'conference' / 'playoff' so we can also infer
// season phase from data, but these dates anchor the UI banner.
const SEASON_OPENS    = new Date('2026-05-29T00:00:00-07:00')  // first regular-season games
const REGULAR_FULL_GO = new Date('2026-06-04T00:00:00-07:00')  // every team in play
const PLAYOFFS_START  = new Date('2026-08-12T00:00:00-07:00')  // approx

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

export function LeadersTicker() {
  // Mobile: 2-up grid so leaders aren't hidden behind horizontal scroll.
  // Desktop: original single-row ticker.
  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-2 mb-4">
      <div className="hidden sm:flex items-center overflow-hidden">
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
      <div className="sm:hidden">
        <div className="text-[10px] font-bold tracking-widest uppercase text-amber-900 dark:text-amber-200 mb-1.5">
          WCL Leaders
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {LEADER_CATS.map(cat => (
            <LeaderCell key={cat.stat} cat={cat} />
          ))}
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
// Today's slate widget — surfaces tonight's games at the top
// ─────────────────────────────────────────────────────────────

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

export function TodaySlate() {
  // Pull just a tight window so we get today's games quickly
  const { data } = useApi('/summer/scoreboard',
    { league: LEAGUE, season: SEASON, days_back: 0, days_ahead: 1 }, [])
  if (!data) return null
  const today = todayKey()
  const games = data.filter(g => g.game_date === today)
  if (games.length === 0) return null
  return (
    <div className="rounded-md border border-nw-teal/40 dark:border-teal-400/40 bg-nw-teal/5 dark:bg-teal-900/20 px-3 py-2.5 mb-4">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-[10px] font-bold tracking-widest uppercase text-nw-teal dark:text-teal-300">Tonight's WCL slate</span>
        <span className="text-[10px] text-gray-500 dark:text-gray-400">{games.length} game{games.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
        {games.map(g => {
          const isFinal = g.status === 'final'
          const awayWon = isFinal && g.away_score > g.home_score
          const homeWon = isFinal && g.home_score > g.away_score
          return (
            <Link key={g.id} to={`/summer/games/${g.id}`}
              className="block rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-1.5 hover:border-nw-teal dark:hover:border-teal-400">
              <div className="flex justify-between items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">
                <span>{isFinal ? 'Final' : g.status === 'in_progress' ? 'Live' : 'Scheduled'}</span>
              </div>
              <SlateSide team={g.away_short || g.away_team_name} logo={g.away_logo} score={g.away_score} bold={awayWon} dim={isFinal && homeWon} />
              <SlateSide team={g.home_short || g.home_team_name} logo={g.home_logo} score={g.home_score} bold={homeWon} dim={isFinal && awayWon} />
            </Link>
          )
        })}
      </div>
    </div>
  )
}

function SlateSide({ team, logo, score, bold, dim }) {
  return (
    <div className={`flex items-center gap-1.5 py-0.5 ${dim ? 'opacity-60' : ''}`}>
      {logo
        ? <img src={logo} alt="" className="w-4 h-4 object-contain shrink-0" loading="lazy" />
        : <div className="w-4 h-4 rounded bg-gray-100 dark:bg-gray-700 shrink-0" />}
      <span className={`flex-1 text-xs truncate ${bold ? 'font-bold text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'}`}>
        {team || 'TBD'}
      </span>
      <span className={`text-sm tabular-nums ${bold ? 'font-bold text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-400'}`}>
        {score == null ? '' : score}
      </span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Stat Leaders strip — top 5 per category (batting + pitching),
// mirrors the spring /stat-leaders page in spirit but compact
// enough to live on the Hub homepage.
// ─────────────────────────────────────────────────────────────

const BATTING_LEADER_CATS = [
  { stat: 'batting_avg',  label: 'AVG',  fmt: 'avg' },
  { stat: 'home_runs',    label: 'HR',   fmt: 'int' },
  { stat: 'rbi',          label: 'RBI',  fmt: 'int' },
  { stat: 'ops',          label: 'OPS',  fmt: 'avg' },
  { stat: 'wrc_plus',     label: 'wRC+', fmt: 'int' },
  { stat: 'stolen_bases', label: 'SB',   fmt: 'int' },
]
const PITCHING_LEADER_CATS = [
  { stat: 'era',           label: 'ERA',  fmt: 'era' },
  { stat: 'strikeouts',    label: 'K',    fmt: 'int' },
  { stat: 'wins',          label: 'W',    fmt: 'int' },
  { stat: 'saves',         label: 'SV',   fmt: 'int' },
  { stat: 'fip',           label: 'FIP',  fmt: 'era' },
  { stat: 'innings_pitched', label: 'IP', fmt: 'era' },
]

export function StatLeaders() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <LeadersColumn title="Top Hitters" cats={BATTING_LEADER_CATS} endpoint="/summer/leaderboards/batting" />
      <LeadersColumn title="Top Pitchers" cats={PITCHING_LEADER_CATS} endpoint="/summer/leaderboards/pitching" />
    </div>
  )
}

function LeadersColumn({ title, cats, endpoint }) {
  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">{title}</h3>
        <Link to="/summer/stats" className="text-[11px] font-semibold text-nw-teal dark:text-teal-300 hover:underline">
          Full leaderboards →
        </Link>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
        {cats.map(c => <LeaderTopFive key={c.stat} cat={c} endpoint={endpoint} />)}
      </div>
    </div>
  )
}

function LeaderTopFive({ cat, endpoint }) {
  const { data, loading } = useApi(endpoint,
    { league: LEAGUE, season: SEASON, qualified: true, sort_by: cat.stat, limit: 5 },
    [cat.stat])

  if (loading) {
    return <div className="text-[11px] text-gray-400 dark:text-gray-500">Loading {cat.label}…</div>
  }
  if (!data?.length) {
    return (
      <div>
        <div className="text-[10px] font-bold tracking-widest uppercase text-amber-700 dark:text-amber-300 mb-1">{cat.label}</div>
        <div className="text-[11px] text-gray-400 dark:text-gray-500">No qualified players yet</div>
      </div>
    )
  }
  const fmt = (v) => {
    if (v == null) return '—'
    if (cat.fmt === 'avg') return fmtAvg(v)
    if (cat.fmt === 'era') return Number(v).toFixed(2)
    return Math.round(v).toString()
  }
  return (
    <div>
      <div className="text-[10px] font-bold tracking-widest uppercase text-amber-700 dark:text-amber-300 mb-1">{cat.label}</div>
      <ol className="space-y-0.5">
        {data.map((p, i) => (
          <li key={p.player_id} className="flex items-center gap-1.5 text-[11.5px]">
            <span className="w-3 text-gray-400 dark:text-gray-500 tabular-nums">{i + 1}</span>
            <Link to={`/summer/players/${p.player_id}`} className="flex-1 truncate font-semibold text-gray-900 dark:text-gray-100 hover:text-nw-teal">
              {p.first_name?.[0]}. {p.last_name}
            </Link>
            <span className="text-[10px] text-gray-500 dark:text-gray-400 shrink-0">{p.team_short}</span>
            <span className="font-bold tabular-nums text-gray-900 dark:text-gray-100 shrink-0">{fmt(p[cat.stat])}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Hot/Cold trend widget (last-5 OPS vs season OPS)
// ─────────────────────────────────────────────────────────────

export function TrendsWidget() {
  const { data, loading } = useApi('/summer/trends', { league: LEAGUE, season: SEASON, window: 5 })
  if (loading || !data) return null
  const { hot = [], cold = [] } = data
  if (!hot.length && !cold.length) return null
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
      <TrendList title="Hot · last 5 games" rows={hot} accent="emerald" />
      <TrendList title="Cold · last 5 games" rows={cold} accent="rose" />
    </div>
  )
}

function TrendList({ title, rows, accent }) {
  const headerColor = accent === 'emerald'
    ? 'text-emerald-700 dark:text-emerald-300'
    : 'text-rose-700 dark:text-rose-300'
  const deltaColor = accent === 'emerald'
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-rose-600 dark:text-rose-400'
  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
      <div className={`text-[10px] sm:text-xs font-bold tracking-widest uppercase mb-2 ${headerColor}`}>{title}</div>
      {rows.length === 0
        ? <div className="text-xs text-gray-500 dark:text-gray-400">No qualifiers yet.</div>
        : <ul className="flex flex-col gap-1">
            {rows.slice(0, 5).map(r => (
              <li key={r.player_id} className="flex items-center justify-between gap-2 text-xs">
                <Link to={`/summer/players/${r.player_id}`} className="font-semibold text-gray-900 dark:text-gray-100 hover:text-nw-teal truncate">
                  {r.first_name?.[0]}. {r.last_name}
                </Link>
                <span className="text-[10px] text-gray-500 dark:text-gray-400 shrink-0">{r.team_short}</span>
                <span className={`tabular-nums font-bold ${deltaColor} shrink-0`}>
                  {r.delta > 0 ? '+' : ''}{Number(r.delta).toFixed(3)} OPS
                </span>
              </li>
            ))}
          </ul>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Sub-views
// ─────────────────────────────────────────────────────────────

export function Scoreboard() {
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

export function ScheduleCalendar() {
  // Default to current month — but if pre-June, default to June 2026 so
  // visitors see the opening series instead of an empty May.
  const today = new Date()
  const minMonth = new Date(2026, 5, 1) // June 2026
  const initial = today < minMonth
    ? new Date(2026, 5, 1)
    : new Date(today.getFullYear(), today.getMonth(), 1)
  const [cursor, setCursor] = useState(initial)

  // Window covers the full visible month + leading/trailing weeks
  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const monthEnd   = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)
  const gridStart  = new Date(monthStart)
  gridStart.setDate(monthStart.getDate() - monthStart.getDay()) // back up to Sunday
  const gridEnd    = new Date(monthEnd)
  gridEnd.setDate(monthEnd.getDate() + (6 - monthEnd.getDay()))

  // Convert to days_back / days_ahead from "today"
  const daysBack  = Math.max(0, Math.ceil((today - gridStart) / 86400000))
  const daysAhead = Math.max(0, Math.ceil((gridEnd - today) / 86400000))

  const { data, loading, error } = useApi('/summer/scoreboard',
    { league: LEAGUE, season: SEASON, days_back: Math.min(60, daysBack), days_ahead: Math.min(60, daysAhead) },
    [cursor.toISOString()])

  if (error) return <ErrorState msg={error} />

  // Bucket games by yyyy-mm-dd
  const byDate = {}
  for (const g of (data || [])) {
    if (!byDate[g.game_date]) byDate[g.game_date] = []
    byDate[g.game_date].push(g)
  }

  // Build 6x7 grid of cells from gridStart
  const cells = []
  const cur = new Date(gridStart)
  while (cur <= gridEnd) {
    cells.push(new Date(cur))
    cur.setDate(cur.getDate() + 1)
  }
  const dayKey = d => d.toISOString().slice(0, 10)
  const monthLabel = cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
          className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
          ← Prev
        </button>
        <div className="flex-1 text-center text-base sm:text-lg font-bold text-gray-900 dark:text-gray-100">{monthLabel}</div>
        <button
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
          className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
          Next →
        </button>
      </div>

      <div className="grid grid-cols-7 gap-px text-[10px] uppercase tracking-wider font-bold text-gray-400 dark:text-gray-500 mb-1">
        {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => <div key={d} className="text-center">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-px border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden bg-gray-200 dark:bg-gray-700">
        {cells.map((d, i) => {
          const inMonth = d.getMonth() === cursor.getMonth()
          const isToday = d.toDateString() === today.toDateString()
          const games = byDate[dayKey(d)] || []
          return (
            <div key={i}
              className={`min-h-[80px] sm:min-h-[100px] p-1 sm:p-1.5 ${inMonth ? 'bg-white dark:bg-gray-800' : 'bg-gray-50 dark:bg-gray-900'} ${isToday ? 'ring-2 ring-nw-teal dark:ring-teal-400 ring-inset' : ''}`}>
              <div className={`text-[10px] sm:text-xs font-bold mb-1 ${inMonth ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-600'}`}>
                {d.getDate()}
              </div>
              <div className="flex flex-col gap-0.5">
                {games.slice(0, 3).map(g => {
                  const isFinal = g.status === 'final'
                  const awayWon = isFinal && g.away_score > g.home_score
                  return (
                    <Link key={g.id} to={`/summer/games/${g.id}`}
                      className="block text-[10px] sm:text-[11px] leading-tight rounded px-1 py-0.5 bg-gray-50 dark:bg-gray-700/70 hover:bg-gray-100 dark:hover:bg-gray-700 truncate">
                      <span className={awayWon ? 'font-bold' : ''}>{g.away_short || g.away_team_name?.split(' ').slice(-1)[0]}</span>
                      <span className="text-gray-400 mx-0.5">@</span>
                      <span className={!awayWon && isFinal ? 'font-bold' : ''}>{g.home_short || g.home_team_name?.split(' ').slice(-1)[0]}</span>
                      {isFinal && g.away_score != null && (
                        <span className="ml-1 tabular-nums text-gray-500 dark:text-gray-400">{g.away_score}-{g.home_score}</span>
                      )}
                    </Link>
                  )
                })}
                {games.length > 3 && (
                  <span className="text-[10px] text-gray-400 dark:text-gray-500">+{games.length - 3} more</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {loading && <div className="text-center text-xs text-gray-400 dark:text-gray-500 mt-2">Loading…</div>}
    </div>
  )
}

export function Standings() {
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

export function BattingLeaders() {
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

export function PitchingLeaders() {
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

export function FieldingLeaders() {
  const [sort, setSort] = useState('fielding_pct')
  const { data, loading, error } = useApi('/summer/leaderboards/fielding',
    { league: LEAGUE, season: SEASON, min_chances: 3, sort_by: sort, limit: 100 },
    [sort])
  if (loading) return <SkeletonRows />
  if (error) return <ErrorState msg={error} />
  if (!data?.length) {
    return <EmptyState msg="No qualified fielders yet. Min 3 chances; lower the bar once league play starts." />
  }
  return (
    <>
      <SortBar
        value={sort} onChange={setSort}
        options={[
          { value: 'fielding_pct',         label: 'FldPct' },
          { value: 'total_chances',        label: 'Chances' },
          { value: 'putouts',              label: 'Putouts' },
          { value: 'assists',              label: 'Assists' },
          { value: 'errors',               label: 'Errors (fewest first)' },
          { value: 'double_plays',         label: 'Double Plays' },
          { value: 'stolen_bases_against', label: 'SB Against' },
          { value: 'caught_stealing_by',   label: 'Caught Stealing' },
          { value: 'cs_pct',               label: 'CS%' },
        ]}
      />
      <div className="overflow-x-auto -mx-3 sm:mx-0">
        <div className="min-w-[820px] px-3 sm:px-0">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                {['#','Player','Pos','Team','G','TC','PO','A','E','DP','PB','SBA','CS','FldPct','CS%'].map((h, i) => (
                  <th key={h} className={`px-1.5 py-1.5 text-xs font-bold text-gray-500 dark:text-gray-400 ${i < 4 ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.player_id + '-' + i} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/60">
                  <td className="px-1.5 py-1 text-gray-500 dark:text-gray-400 tabular-nums">{i + 1}</td>
                  <td className="px-1.5 py-1 font-semibold text-gray-900 dark:text-gray-100">
                    <Link to={`/summer/players/${p.player_id}`} className="hover:underline">{p.first_name} {p.last_name}</Link>
                  </td>
                  <td className="px-1.5 py-1 text-left text-gray-500 dark:text-gray-400 uppercase">{p.position || ''}</td>
                  <td className="px-1.5 py-1">
                    <Link to={`/summer/teams/${p.team_id}`} className="text-nw-teal dark:text-teal-300 hover:underline">{p.team_short}</Link>
                  </td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.games)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.total_chances)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.putouts)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.assists)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.errors)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.double_plays)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.passed_balls)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.stolen_bases_against)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{fmtInt(p.caught_stealing_by)}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums font-bold">{p.fielding_pct != null ? fmtAvg(p.fielding_pct) : '—'}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{p.cs_pct != null ? `${(p.cs_pct * 100).toFixed(1)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

export function PnwAlumni() {
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

export function CollegeMix() {
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

export function Teams() {
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

// ─────────────────────────────────────────────────────────────
// Hub homepage — overview widgets + navigation cards. The deep
// data tables now live on dedicated /summer/<section> pages so
// the Hub stays light and scannable.
// ─────────────────────────────────────────────────────────────

const HUB_CARDS = [
  { to: '/summer/scoreboard',  label: 'Scoreboard',    desc: 'Yesterday + tonight + the calendar grid' },
  { to: '/summer/standings',   label: 'Standings',     desc: 'W/L, L10, streak by division' },
  { to: '/summer/stats',       label: 'Stats',         desc: 'Batting, pitching, fielding leaders + history' },
  { to: '/summer/teams',       label: 'Teams',         desc: 'All 17 clubs, North + South' },
  { to: '/summer/pnw-alumni',  label: 'PNW Alumni',    desc: 'Spring college players in the WCL' },
  { to: '/summer/college-mix', label: 'College Mix',   desc: 'Which colleges are most represented' },
  { to: '/summer/recap',       label: 'Recap Graphic', desc: 'Generate a shareable PNG of any day' },
]

export default function SummerHub() {
  const now = new Date()
  // Phase: preseason → opening (between first game and full slate) →
  // regular → playoffs. Drives the banner copy.
  const phase = now < SEASON_OPENS ? 'preseason'
              : now < REGULAR_FULL_GO ? 'opening'
              : now < PLAYOFFS_START ? 'regular'
              : 'playoffs'
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
          <div className="mt-3">
            <Link
              to="/summer/recap"
              className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-wide uppercase px-3 py-1.5 rounded-full bg-amber-200/20 hover:bg-amber-200/30 text-amber-100 border border-amber-200/40 transition"
            >
              Daily Recap Graphic →
            </Link>
          </div>
        </div>
      </div>

      {phase === 'preseason' && (
        <div className="rounded-md border border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 mb-4">
          <div className="text-xs sm:text-sm text-amber-900 dark:text-amber-200">
            <span className="font-bold">Preseason.</span> WCL regular season opens Thursday, May 29. Exhibitions only for now —
            standings + leaderboards fill in once league play begins.
          </div>
        </div>
      )}
      {phase === 'opening' && (
        <div className="rounded-md border border-emerald-300 dark:border-emerald-700/50 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2 mb-4">
          <div className="text-xs sm:text-sm text-emerald-900 dark:text-emerald-200">
            <span className="font-bold">Opening weekend.</span> First regular-season games are in the books. Full league schedule
            kicks off Wednesday, June 4.
          </div>
        </div>
      )}
      {phase === 'playoffs' && (
        <div className="rounded-md border border-rose-300 dark:border-rose-700/50 bg-rose-50 dark:bg-rose-900/20 px-3 py-2 mb-4">
          <div className="text-xs sm:text-sm text-rose-900 dark:text-rose-200">
            <span className="font-bold">Playoffs.</span> Postseason underway.
          </div>
        </div>
      )}

      <TodaySlate />
      <LeadersTicker />
      <TrendsWidget />
      <StatLeaders />

      {/* Navigation cards — explorers tap one to land on a dedicated
          page instead of digging through nested tabs. */}
      <div className="mb-6">
        <div className="text-[11px] font-bold tracking-widest uppercase text-gray-500 dark:text-gray-400 mb-2">
          Explore
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
          {HUB_CARDS.map(c => (
            <Link
              key={c.to}
              to={c.to}
              className="group block rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 hover:border-nw-teal dark:hover:border-teal-400 transition"
            >
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-sm font-bold text-gray-900 dark:text-gray-100">{c.label}</span>
                <span className="text-nw-teal dark:text-teal-300 opacity-0 group-hover:opacity-100 transition">→</span>
              </div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug">{c.desc}</div>
            </Link>
          ))}
        </div>
      </div>

      {/* Standings preview — keep below the cards so the Hub still
          shows live league context without forcing a click. */}
      <div className="mb-6">
        <div className="flex items-baseline justify-between mb-2">
          <div className="text-[11px] font-bold tracking-widest uppercase text-gray-500 dark:text-gray-400">
            Standings
          </div>
          <Link to="/summer/standings" className="text-[11px] font-semibold text-nw-teal dark:text-teal-300 hover:underline">
            Full standings →
          </Link>
        </div>
        <Standings />
      </div>

      {/* Recent results — same Scoreboard widget the dedicated page uses */}
      <div className="mb-6">
        <div className="flex items-baseline justify-between mb-2">
          <div className="text-[11px] font-bold tracking-widest uppercase text-gray-500 dark:text-gray-400">
            Recent Games
          </div>
          <Link to="/summer/scoreboard" className="text-[11px] font-semibold text-nw-teal dark:text-teal-300 hover:underline">
            Full scoreboard →
          </Link>
        </div>
        <Scoreboard />
      </div>

    </div>
  )
}
