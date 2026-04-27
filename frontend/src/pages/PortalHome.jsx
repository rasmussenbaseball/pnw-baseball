// PortalHome — coach-facing dashboard tailored to the team selected
// in PortalTeamContext. The layout is a single, dense command center:
//
//   ┌────────────────────────────────────────────────────────┐
//   │  HERO  logo + name + record + run diff + ranks          │
//   │        last 10 game pills + cumulative win-pct trend    │
//   ├────────────────────────────┬────────────────────────────┤
//   │  TEAM SAVANT  batting       │  TEAM SAVANT  pitching     │
//   │  5 percentile bars vs       │  5 percentile bars vs      │
//   │  division                   │  division                  │
//   ├────────────────────────────┴────────────────────────────┤
//   │  SPOTLIGHT  top hitter card  │  top pitcher card        │
//   ├────────────────────────────┬────────────────────────────┤
//   │  TOP 5 HITTERS table        │  TOP 5 PITCHERS table      │
//   ├────────────────────────────┴────────────────────────────┤
//   │  CLUTCH PERFORMERS  hitters | pitchers                  │
//   ├────────────────────────────┬────────────────────────────┤
//   │  TOP MOMENTS                │  UPCOMING SCHEDULE         │
//   └────────────────────────────┴────────────────────────────┘
//
// The Hero reads from /teams/{id}/info-graphic — one rich endpoint that
// already does run-diff math from the games table, packs Savant-style
// 5-stat batting/pitching percentile cards vs the team's division, and
// returns top 5 players w/ headshots and the last 5 games.
//
// We supplement with /teams/{id}/games (for the cumulative trend),
// /top-moments (clutch + biggest swings, with deliberately high
// leaderboard/moment limits so smaller teams still surface entries),
// and /games/future (upcoming schedule).

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip as RTooltip,
  ReferenceLine,
} from 'recharts'
import {
  useTeamInfoGraphic,
  useTeamGames,
  useTeamFutureGames,
  useTopMoments,
} from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'

const SEASON = 2026


// ────────────────────────────────────────────────────────────────
// Color helpers — Baseball Savant red→white→blue percentile palette
// ────────────────────────────────────────────────────────────────
function percentileColor(pct) {
  if (pct == null) return '#e5e7eb'
  const p = Math.max(0, Math.min(100, pct)) / 100
  let r, g, b
  if (p >= 0.5) {
    const t = (p - 0.5) * 2
    r = Math.round(255 * (1 - t) + 214 * t)
    g = Math.round(255 * (1 - t) + 62 * t)
    b = Math.round(255 * (1 - t) + 62 * t)
  } else {
    const t = p * 2
    r = Math.round(29 * (1 - t) + 255 * t)
    g = Math.round(78 * (1 - t) + 255 * t)
    b = Math.round(216 * (1 - t) + 255 * t)
  }
  return `rgb(${r},${g},${b})`
}


// ────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────
export default function PortalHome() {
  const { team } = usePortalTeam()
  const { data: ig } = useTeamInfoGraphic(team?.id, SEASON)

  if (!team) return null

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-5 py-5 space-y-4">
      <Hero team={team} ig={ig} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SavantCard title="Team Hitting" data={ig?.batting_percentiles} layout="batting" />
        <SavantCard title="Team Pitching" data={ig?.pitching_percentiles} layout="pitching" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopHitterSpotlight ig={ig} />
        <TopPitcherSpotlight ig={ig} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopHittersBoard ig={ig} />
        <TopPitchersBoard ig={ig} />
      </div>

      <ClutchPerformers teamId={team.id} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopMomentsForTeam teamId={team.id} />
        <UpcomingSchedule teamId={team.id} />
      </div>
    </div>
  )
}


// ────────────────────────────────────────────────────────────────
// 1. Hero — record splits, run diff, ranks, last-10 pills, trend
// ────────────────────────────────────────────────────────────────
function Hero({ team, ig }) {
  const r = ig?.record || {}
  const rk = ig?.rankings || {}
  const wins = r.wins ?? 0
  const losses = r.losses ?? 0
  const ties = r.ties ?? 0
  const recordStr = ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`
  const winPct = (wins + losses) > 0 ? wins / (wins + losses) : 0
  const runDiff = r.run_diff ?? 0
  const runsFor = r.runs_for ?? 0
  const runsAgainst = r.runs_against ?? 0

  return (
    <div className="bg-portal-purple text-portal-cream rounded-2xl shadow-lg overflow-hidden">
      {/* Top row — identity + headline stats */}
      <div className="px-5 sm:px-6 pt-5 pb-4 flex items-center gap-4 sm:gap-6">
        {team.logo_url && (
          <img
            src={team.logo_url}
            alt=""
            className="h-20 w-20 sm:h-24 sm:w-24 object-contain bg-white/95 rounded-xl p-1.5 shadow-sm shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-portal-accent font-semibold mb-1">
            {(rk.division_name || '')}{rk.conference_abbrev ? ` · ${rk.conference_abbrev}` : ''}
            {ig?.head_coach?.name ? ` · ${ig.head_coach.name}` : ''}
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold leading-tight">
            {team.short_name || team.name}
          </h1>
          <div className="flex flex-wrap items-end gap-x-5 gap-y-1.5 mt-2">
            <HeroStat label="Record" value={recordStr}
                      hint={`${(winPct * 100).toFixed(1)}%`} />
            <HeroStat label="Conference"
                      value={`${r.conf_wins ?? 0}-${r.conf_losses ?? 0}`} />
            <HeroStat label="Run Diff"
                      value={`${runDiff >= 0 ? '+' : ''}${runDiff}`}
                      hint={`${runsFor} for / ${runsAgainst} against`}
                      good={runDiff >= 0} />
            {r.pythagorean_wins != null && (
              <HeroStat label="Pythag W-L"
                        value={`${r.pythagorean_wins}-${r.pythagorean_losses}`}
                        hint={(r.pythagorean_wins - wins) >= 0
                          ? `+${r.pythagorean_wins - wins} vs actual`
                          : `${r.pythagorean_wins - wins} vs actual`} />
            )}
            {rk.conference_rank != null && (
              <HeroStat label="Conf Rank"
                        value={`#${rk.conference_rank}`}
                        hint={rk.conference_total ? `of ${rk.conference_total}` : ''} />
            )}
            {rk.national_rank != null && (
              <HeroStat label="National"
                        value={`#${rk.national_rank}`}
                        hint={rk.national_percentile != null
                          ? `${Math.round(rk.national_percentile)}th pct` : ''} />
            )}
            {rk.power_rating != null && (
              <HeroStat label="Power"
                        value={rk.power_rating.toFixed(1)}
                        hint={rk.power_rating_div_rank
                          ? `D${rk.power_rating_div_rank}/${rk.power_rating_div_total} in div`
                          : ''} />
            )}
          </div>
        </div>
      </div>

      {/* Bottom band — last 10 pills + cumulative win-pct trend */}
      <div className="bg-portal-purple-dark/40 px-5 sm:px-6 py-3 grid grid-cols-1 lg:grid-cols-[auto,1fr] gap-4 lg:gap-6 items-center">
        <RecentFormPills teamId={team.id} />
        <TrendChart teamId={team.id} />
      </div>
    </div>
  )
}


function HeroStat({ label, value, hint, good }) {
  const valueClass = good === true ? 'text-emerald-300'
    : good === false ? 'text-rose-300'
    : 'text-portal-cream'
  return (
    <div className="leading-none">
      <div className="text-[9px] uppercase tracking-widest text-portal-cream/55 mb-1">
        {label}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-xl sm:text-2xl font-bold tabular-nums ${valueClass}`}>
          {value}
        </span>
        {hint && <span className="text-[10px] text-portal-cream/60">{hint}</span>}
      </div>
    </div>
  )
}


// Last 10 W/L pills — fixed-size, uniform.
function RecentFormPills({ teamId }) {
  const { data: games } = useTeamGames(teamId, SEASON)
  const last10 = useMemo(() => {
    if (!Array.isArray(games)) return []
    return games.filter(g => g.status === 'final').slice(-10)
  }, [games])

  if (last10.length === 0) {
    return (
      <div className="text-[10px] text-portal-cream/60 italic">
        Last 10 — no completed games yet
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1">
      <span className="text-[9px] uppercase tracking-widest text-portal-cream/55 mr-1">
        Last 10
      </span>
      {last10.map((g) => {
        const isHome = g.home_team_id === teamId
        const myScore = isHome ? g.home_score : g.away_score
        const oppScore = isHome ? g.away_score : g.home_score
        const oppShort = isHome ? g.away_short : g.home_short
        const won = myScore > oppScore
        const tied = myScore === oppScore
        const cls = tied
          ? 'bg-gray-200/30 border-gray-200/40 text-portal-cream'
          : won
            ? 'bg-emerald-500/25 border-emerald-400/50 text-emerald-100'
            : 'bg-rose-500/25 border-rose-400/50 text-rose-100'
        return (
          <div
            key={g.id}
            className={`flex flex-col items-center justify-center
                        rounded border w-12 h-12 leading-tight ${cls}`}
            title={`${formatDate(g.game_date)} ${isHome ? 'vs' : '@'} ${oppShort} · ${myScore}-${oppScore}`}
          >
            <div className="text-[10px] font-bold">
              {tied ? 'T' : won ? 'W' : 'L'}
            </div>
            <div className="text-[10px] font-semibold tabular-nums">
              {myScore}-{oppScore}
            </div>
          </div>
        )
      })}
    </div>
  )
}


// Cumulative win-pct over the season — single-line chart.
function TrendChart({ teamId }) {
  const { data: games } = useTeamGames(teamId, SEASON)
  const series = useMemo(() => {
    if (!Array.isArray(games)) return []
    let w = 0, l = 0
    return games
      .filter(g => g.status === 'final')
      .map((g, i) => {
        const isHome = g.home_team_id === teamId
        const myScore = isHome ? g.home_score : g.away_score
        const oppScore = isHome ? g.away_score : g.home_score
        if (myScore > oppScore) w++
        else if (myScore < oppScore) l++
        const pct = (w + l) > 0 ? w / (w + l) : 0
        return { idx: i + 1, pct, w, l, date: g.game_date }
      })
  }, [games, teamId])

  if (series.length < 2) {
    return <div /> // hide chart until we have ≥2 finals
  }

  const lastPct = series[series.length - 1].pct
  const above500 = lastPct >= 0.5
  const lineColor = above500 ? '#86efac' : '#fda4af'

  return (
    <div className="h-16 w-full -mb-1">
      <ResponsiveContainer>
        <AreaChart data={series} margin={{ top: 2, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity={0.5} />
              <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={[0, 1]} />
          <XAxis hide dataKey="idx" />
          <ReferenceLine y={0.5} stroke="#ffffff44" strokeDasharray="2 3" />
          <RTooltip
            cursor={{ stroke: '#ffffff66', strokeDasharray: '3 3' }}
            contentStyle={{ fontSize: 11, padding: '4px 8px',
              backgroundColor: '#1d1f4d', border: '1px solid #ffffff22',
              borderRadius: 6, color: '#f5f3ef' }}
            formatter={(v, name, p) => [
              `${(v * 100).toFixed(1)}%  (${p.payload.w}-${p.payload.l})`,
              'Win pct',
            ]}
            labelFormatter={(idx, p) => p?.[0]?.payload?.date
              ? formatDate(p[0].payload.date) : `Game ${idx}`}
          />
          <Area type="monotone" dataKey="pct" stroke={lineColor} strokeWidth={2}
                fill="url(#trendGrad)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
      <div className="text-[9px] uppercase tracking-widest text-portal-cream/55 -mt-1 text-right pr-1">
        Win pct over season
      </div>
    </div>
  )
}


// ────────────────────────────────────────────────────────────────
// 2. Team Savant card — 5 percentile bars vs division
// ────────────────────────────────────────────────────────────────
const SAVANT_LABELS = {
  batting: [
    { key: 'wrc_plus',   label: 'wRC+',  fmt: v => v != null ? Math.round(v) : '—' },
    { key: 'woba',       label: 'wOBA',  fmt: v => fmtAvg(v) },
    { key: 'batting_avg',label: 'AVG',   fmt: v => fmtAvg(v) },
    { key: 'hr_per_pa',  label: 'HR/PA', fmt: v => v != null ? `${(v * 100).toFixed(1)}%` : '—' },
    { key: 'owar',       label: 'oWAR',  fmt: v => v != null ? v.toFixed(1) : '—' },
  ],
  pitching: [
    { key: 'siera', label: 'SIERA',  fmt: v => v != null ? v.toFixed(2) : '—' },
    { key: 'era',   label: 'ERA',    fmt: v => v != null ? v.toFixed(2) : '—' },
    { key: 'k_pct', label: 'K%',     fmt: v => v != null ? `${v.toFixed(1)}%` : '—' },
    { key: 'baa',   label: 'BAA',    fmt: v => fmtAvg(v) },
    { key: 'pwar',  label: 'pWAR',   fmt: v => v != null ? v.toFixed(1) : '—' },
  ],
}

function SavantCard({ title, data, layout }) {
  const rows = SAVANT_LABELS[layout]
  if (!data) return <Skeleton label={title} rows={5} />
  return (
    <Card title={title} subtitle="Percentile vs division">
      <div className="space-y-2.5">
        {rows.map(({ key, label, fmt }) => {
          const block = data[key] || {}
          return (
            <PercentileRow
              key={key}
              label={label}
              valueText={fmt(block.value)}
              percentile={block.percentile}
              rank={block.rank}
              total={block.total}
            />
          )
        })}
      </div>
    </Card>
  )
}


function PercentileRow({ label, valueText, percentile, rank, total }) {
  const pct = percentile ?? 50
  const color = percentileColor(percentile)
  return (
    <div className="grid grid-cols-[60px,1fr,72px,52px] items-center gap-2">
      <div className="text-xs font-bold text-gray-700">{label}</div>
      <div className="relative h-4 bg-gray-100 rounded overflow-hidden">
        <div
          className="h-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
        <div className="absolute inset-y-0 left-1/2 w-px bg-gray-300" />
      </div>
      <div className="text-[11px] tabular-nums text-right text-gray-600">
        {rank != null && total != null ? `#${rank} / ${total}` : '—'}
      </div>
      <div className="text-sm font-bold tabular-nums text-right">
        {valueText}
      </div>
    </div>
  )
}


// ────────────────────────────────────────────────────────────────
// 3. Spotlight cards — top hitter + top pitcher
// ────────────────────────────────────────────────────────────────
function TopHitterSpotlight({ ig }) {
  const top = ig?.top_hitters?.[0]
  if (!ig) return <Skeleton label="Top Hitter" rows={4} />
  if (!top) return null
  return (
    <SpotlightCard
      eyebrow="Top Hitter"
      eyebrowAccent="bg-emerald-500"
      player={top}
      stats={[
        { label: 'AVG',  value: fmtAvg(top.batting_avg) },
        { label: 'wOBA', value: fmtAvg(top.woba) },
        { label: 'wRC+', value: top.wrc_plus != null ? Math.round(top.wrc_plus) : '—' },
        { label: 'WAR',  value: fmtWar(top.offensive_war) },
      ]}
    />
  )
}


function TopPitcherSpotlight({ ig }) {
  const top = ig?.top_pitchers?.[0]
  if (!ig) return <Skeleton label="Top Pitcher" rows={4} />
  if (!top) return null
  return (
    <SpotlightCard
      eyebrow="Top Pitcher"
      eyebrowAccent="bg-sky-500"
      player={top}
      stats={[
        { label: 'ERA',   value: top.era != null ? top.era.toFixed(2) : '—' },
        { label: 'SIERA', value: top.siera != null ? top.siera.toFixed(2) : '—' },
        { label: 'K%',    value: top.k_pct != null ? `${top.k_pct.toFixed(1)}%` : '—' },
        { label: 'WAR',   value: fmtWar(top.pitching_war) },
      ]}
    />
  )
}


function SpotlightCard({ eyebrow, eyebrowAccent, player, stats }) {
  // Use the eyebrowAccent classes as a subtle gradient strip header.
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      <div className={`h-1 ${eyebrowAccent}`} />
      <div className="p-4 flex items-center gap-4">
        <PlayerHeadshot
          src={player.headshot_url}
          name={player.name || `${player.first_name || ''} ${player.last_name || ''}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <Link
              to={`/players/${player.id || player.player_id}`}
              className="text-base sm:text-lg font-bold text-portal-purple-dark hover:underline truncate"
            >
              {player.name || `${player.first_name} ${player.last_name}`}
            </Link>
            <span className="text-[10px] uppercase tracking-widest font-bold text-portal-accent shrink-0">
              {eyebrow}
            </span>
          </div>
          <div className="text-[11px] text-gray-500 mb-2">
            {player.position || ''}
            {player.year_in_school ? ` · ${player.year_in_school}` : ''}
          </div>
          <div className="grid grid-cols-4 gap-2">
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


// Headshot with fallback initials chip — never a broken image icon.
function PlayerHeadshot({ src, name, size = 'md' }) {
  const cls = size === 'sm'
    ? 'h-8 w-8 text-[10px]'
    : 'h-16 w-16 sm:h-20 sm:w-20 text-base'
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className={`${cls} rounded-lg object-cover bg-gray-100 shrink-0`}
        onError={(e) => {
          e.currentTarget.style.display = 'none'
          if (e.currentTarget.nextSibling) {
            e.currentTarget.nextSibling.style.display = 'flex'
          }
        }}
      />
    )
  }
  const initials = (name || '?')
    .split(/\s+/)
    .map(w => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <div className={`${cls} rounded-lg bg-portal-purple/10 text-portal-purple-dark
                     font-bold flex items-center justify-center shrink-0`}>
      {initials}
    </div>
  )
}


// ────────────────────────────────────────────────────────────────
// 4. Top hitters / top pitchers — denser tables
// ────────────────────────────────────────────────────────────────
function TopHittersBoard({ ig }) {
  const rows = ig?.top_hitters || []
  if (!ig) return <Skeleton label="Top Hitters" rows={5} />
  return (
    <Card title="Top Hitters" subtitle="By WAR · qualified">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-gray-400 uppercase tracking-wide border-b border-gray-100">
            <th className="text-left pb-1.5">Player</th>
            <th className="text-right pb-1.5">AVG</th>
            <th className="text-right pb-1.5">wOBA</th>
            <th className="text-right pb-1.5">wRC+</th>
            <th className="text-right pb-1.5">WAR</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.id || i}
                className="border-b border-gray-50 last:border-0 hover:bg-portal-purple/5 transition-colors">
              <td className="py-1.5">
                <Link
                  to={`/players/${p.id || p.player_id}`}
                  className="text-portal-purple-dark hover:underline font-medium"
                >
                  {p.name || `${p.first_name} ${p.last_name}`}
                </Link>
                {p.position && (
                  <span className="text-[10px] text-gray-400 ml-1.5">{p.position}</span>
                )}
              </td>
              <td className="text-right tabular-nums">{fmtAvg(p.batting_avg)}</td>
              <td className="text-right tabular-nums">{fmtAvg(p.woba)}</td>
              <td className="text-right tabular-nums">
                {p.wrc_plus != null ? Math.round(p.wrc_plus) : '—'}
              </td>
              <td className="text-right font-semibold tabular-nums">
                {fmtWar(p.offensive_war)}
              </td>
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


function TopPitchersBoard({ ig }) {
  const rows = ig?.top_pitchers || []
  if (!ig) return <Skeleton label="Top Pitchers" rows={5} />
  return (
    <Card title="Top Pitchers" subtitle="By WAR · min 5 IP">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-gray-400 uppercase tracking-wide border-b border-gray-100">
            <th className="text-left pb-1.5">Player</th>
            <th className="text-right pb-1.5">ERA</th>
            <th className="text-right pb-1.5">SIERA</th>
            <th className="text-right pb-1.5">K%</th>
            <th className="text-right pb-1.5">BB%</th>
            <th className="text-right pb-1.5">WAR</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.id || i}
                className="border-b border-gray-50 last:border-0 hover:bg-portal-purple/5 transition-colors">
              <td className="py-1.5">
                <Link
                  to={`/players/${p.id || p.player_id}`}
                  className="text-portal-purple-dark hover:underline font-medium"
                >
                  {p.name || `${p.first_name} ${p.last_name}`}
                </Link>
                {p.position && (
                  <span className="text-[10px] text-gray-400 ml-1.5">{p.position}</span>
                )}
              </td>
              <td className="text-right tabular-nums">
                {p.era != null ? p.era.toFixed(2) : '—'}
              </td>
              <td className="text-right tabular-nums">
                {p.siera != null ? p.siera.toFixed(2) : '—'}
              </td>
              <td className="text-right tabular-nums">
                {p.k_pct != null ? `${p.k_pct.toFixed(1)}%` : '—'}
              </td>
              <td className="text-right tabular-nums">
                {p.bb_pct != null ? `${p.bb_pct.toFixed(1)}%` : '—'}
              </td>
              <td className="text-right font-semibold tabular-nums">
                {fmtWar(p.pitching_war)}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={6} className="text-center text-gray-400 text-xs py-3">
              No qualified pitchers yet.
            </td></tr>
          )}
        </tbody>
      </table>
    </Card>
  )
}


// ────────────────────────────────────────────────────────────────
// 5. Clutch performers — top WPA contributors on this team
// ────────────────────────────────────────────────────────────────
function ClutchPerformers({ teamId }) {
  // The league-wide top-100 leaderboard misses smaller-program players,
  // so request the FULL leaderboard (2,000 covers every qualifier with
  // headroom) and filter client-side. Cheap one-off response.
  const { data } = useTopMoments(SEASON, { leaderboard_limit: 2000, moments_limit: 1 })
  const hitters = useMemo(() => {
    if (!data?.top_hitters) return []
    return data.top_hitters
      .filter(p => p.team_id === teamId)
      .sort((a, b) => (b.total_wpa || 0) - (a.total_wpa || 0))
      .slice(0, 6)
  }, [data, teamId])
  const pitchers = useMemo(() => {
    if (!data?.top_pitchers) return []
    return data.top_pitchers
      .filter(p => p.team_id === teamId)
      .sort((a, b) => (b.total_wpa || 0) - (a.total_wpa || 0))
      .slice(0, 6)
  }, [data, teamId])
  if (!data) return <Skeleton label="Clutch Performers" rows={4} />
  if (hitters.length === 0 && pitchers.length === 0) {
    return (
      <Card title="Clutch Performers"
            subtitle="Highest cumulative Win Probability Added">
        <div className="text-xs text-gray-400 text-center py-3">
          No tracked WPA yet — moments accumulate as the season builds.
        </div>
      </Card>
    )
  }
  return (
    <Card title="Clutch Performers"
          subtitle="Highest cumulative Win Probability Added (WPA)">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
        <ClutchColumn title="Hitters" rows={hitters} unit="PA" />
        <ClutchColumn title="Pitchers" rows={pitchers} unit="BF" />
      </div>
    </Card>
  )
}


function ClutchColumn({ title, rows, unit }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-portal-accent font-semibold mb-1.5">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-gray-400 italic py-1">None yet.</div>
      ) : (
        <ul className="space-y-1">
          {rows.map(p => {
            const sign = p.total_wpa >= 0 ? '+' : ''
            const colorClass = p.total_wpa >= 0.5 ? 'text-emerald-700'
              : p.total_wpa <= -0.5 ? 'text-rose-700'
              : 'text-gray-700'
            return (
              <li key={p.player_id} className="flex items-center justify-between gap-2">
                <Link
                  to={`/players/${p.player_id}`}
                  className="text-sm font-medium text-portal-purple-dark hover:underline truncate"
                >
                  {p.name}
                </Link>
                <div className="flex items-baseline gap-1.5 shrink-0">
                  <span className={`text-sm font-bold tabular-nums ${colorClass}`}>
                    {sign}{p.total_wpa.toFixed(2)}
                  </span>
                  <span className="text-[10px] text-gray-400 tabular-nums w-14 text-right">
                    {p.pa || p.bf} {unit}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}


// ────────────────────────────────────────────────────────────────
// 6. Top moments — biggest single-PA WPA swings featuring this team
// ────────────────────────────────────────────────────────────────
function TopMomentsForTeam({ teamId }) {
  // Big moments_limit so smaller programs still surface entries.
  const { data } = useTopMoments(SEASON, { moments_limit: 500, leaderboard_limit: 1 })
  const moments = useMemo(() => {
    if (!data) return []
    const all = [...(data.hitter_moments || []), ...(data.pitcher_moments || [])]
    const filtered = all.filter(m => {
      const featured = m.perspective === 'batter' ? m.batter : m.pitcher
      return featured?.team_id === teamId && typeof m.wpa === 'number'
    })
    const byId = new Map()
    filtered
      .sort((a, b) => b.wpa - a.wpa)
      .forEach(m => { if (!byId.has(m.id)) byId.set(m.id, m) })
    return Array.from(byId.values()).slice(0, 5)
  }, [data, teamId])
  if (!data) return <Skeleton label="Top Moments" rows={4} />
  if (moments.length === 0) {
    return (
      <Card title="Top Moments" subtitle="Biggest single-PA WPA swings">
        <div className="text-xs text-gray-400 text-center py-3">
          No clutch moments yet — they'll appear as the season builds.
        </div>
      </Card>
    )
  }
  return (
    <Card title="Top Moments" subtitle="Biggest single-PA WPA swings">
      <ul className="space-y-1.5">
        {moments.map(m => {
          const featured = m.perspective === 'batter' ? m.batter : m.pitcher
          const opp = m.perspective === 'batter' ? m.pitcher : m.batter
          const result = formatResult(m.result_type)
          const date = m.game_date
            ? new Date(m.game_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : '—'
          const inn = `${m.half === 'top' ? 'T' : 'B'}${m.inning}`
          return (
            <li key={m.id} className="flex items-center gap-2.5">
              <span className="text-base font-bold text-emerald-700 tabular-nums w-12 shrink-0">
                +{m.wpa.toFixed(2)}
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
                <div className="text-[10px] text-gray-500 truncate">
                  {date} · {inn} · vs {opp?.name || '—'}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}


// ────────────────────────────────────────────────────────────────
// 7. Upcoming schedule
// ────────────────────────────────────────────────────────────────
function UpcomingSchedule({ teamId }) {
  const { data } = useTeamFutureGames(teamId, 8)
  // /games/future returns { games, total, last_updated } — unwrap.
  const games = data?.games
  if (!games) return <Skeleton label="Upcoming Schedule" rows={4} />
  if (games.length === 0) {
    return (
      <Card title="Upcoming Schedule" subtitle="Next games">
        <div className="text-xs text-gray-400 text-center py-3">
          No games scheduled.
        </div>
      </Card>
    )
  }
  return (
    <Card title="Upcoming Schedule" subtitle={`Next ${games.length} games`}>
      <ul className="divide-y divide-gray-100">
        {games.map(g => {
          const isHome = g.home_team_id === teamId
          const oppShort = isHome ? g.away_short : g.home_short
          const oppLogo = isHome ? g.away_logo : g.home_logo
          return (
            <li key={g.id} className="flex items-center gap-2 py-1.5 text-sm">
              <span className="text-[11px] text-gray-500 tabular-nums w-14 shrink-0">
                {formatDate(g.game_date)}
              </span>
              <span className="text-[10px] text-gray-400 w-5 shrink-0">
                {isHome ? 'vs' : '@'}
              </span>
              {oppLogo
                ? <img src={oppLogo} alt="" className="h-5 w-5 object-contain shrink-0" />
                : <div className="h-5 w-5 shrink-0" />}
              <span className="font-medium text-gray-900 truncate flex-1">
                {oppShort || 'TBD'}
              </span>
              {g.is_conference && (
                <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5
                                  rounded bg-portal-accent/15 text-portal-accent
                                  font-bold shrink-0">
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


// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────
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
  return v >= 1 ? v.toFixed(3) : v.toFixed(3).replace(/^0\./, '.')
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
