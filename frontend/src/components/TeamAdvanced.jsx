// TeamAdvanced — the "advanced look" section for the public team page.
//
// Reuses the same rich /teams/{id}/info-graphic payload that powers the coach
// portal homepage (Savant-style percentile cards vs division, top hitters /
// pitchers by WAR, spotlights) plus /top-moments for clutch (WPA) leaders, but
// re-themed to the site's nw-teal palette and made fully public.

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useTeamInfoGraphic, useTopMoments } from '../hooks/useApi'

// Baseball Savant red→white→blue percentile palette.
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

const fmtAvg = (v) => v == null ? '—' : (v >= 1 ? v.toFixed(3) : v.toFixed(3).replace(/^0\./, '.'))
const fmtWar = (v) => v == null ? '—' : v.toFixed(1)
const PCT_FMT = (v) => v != null ? `${(v * 100).toFixed(1)}%` : '—'

const SAVANT_LABELS = {
  batting: [
    { key: 'wrc_plus',     label: 'wRC+',     fmt: v => v != null ? Math.round(v) : '—' },
    { key: 'woba',         label: 'wOBA',     fmt: fmtAvg },
    { key: 'batting_avg',  label: 'AVG',      fmt: fmtAvg },
    { key: 'hr_per_pa',    label: 'HR/PA',    fmt: v => v != null ? `${(v * 100).toFixed(1)}%` : '—' },
    { key: 'owar',         label: 'oWAR',     fmt: v => v != null ? v.toFixed(1) : '—' },
    { key: 'contact_pct',  label: 'Contact%', fmt: PCT_FMT },
    { key: 'swing_pct',    label: 'Swing%',   fmt: PCT_FMT },
    { key: 'air_pull_pct', label: 'AirPull%', fmt: PCT_FMT },
  ],
  pitching: [
    { key: 'siera',      label: 'SIERA',   fmt: v => v != null ? v.toFixed(2) : '—' },
    { key: 'era',        label: 'ERA',     fmt: v => v != null ? v.toFixed(2) : '—' },
    { key: 'k_pct',      label: 'K%',      fmt: v => v != null ? `${v.toFixed(1)}%` : '—' },
    { key: 'baa',        label: 'BAA',     fmt: fmtAvg },
    { key: 'pwar',       label: 'pWAR',    fmt: v => v != null ? v.toFixed(1) : '—' },
    { key: 'strike_pct', label: 'Strike%', fmt: PCT_FMT },
    { key: 'fps_pct',    label: 'FPS%',    fmt: PCT_FMT },
    { key: 'whiff_pct',  label: 'Whiff%',  fmt: PCT_FMT },
  ],
}

export default function TeamAdvanced({ teamId, season }) {
  const { data: ig } = useTeamInfoGraphic(teamId, season)
  return (
    <div className="space-y-4 sm:space-y-6 mb-6 sm:mb-8">
      <div className="flex items-baseline gap-2">
        <h2 className="text-lg sm:text-xl font-bold text-nw-teal dark:text-gray-100">Advanced Look</h2>
        <span className="text-[11px] text-gray-400 dark:text-gray-500">percentiles vs {ig?.percentile_baseline?.label || `division · ${season}`}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SavantCard title="Team Hitting" data={ig?.batting_percentiles} layout="batting" />
        <SavantCard title="Team Pitching" data={ig?.pitching_percentiles} layout="pitching" />
      </div>

      {/* Top Hitter/Pitcher spotlights + WAR leaderboards removed — the
          "Impact Performers" widget on the Season tab covers team leaders. */}

      <ClutchPerformers teamId={teamId} season={season} />
    </div>
  )
}


function Card({ title, subtitle, children }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-baseline justify-between gap-2">
        <div className="text-sm font-bold text-nw-teal dark:text-gray-100 uppercase tracking-wide">{title}</div>
        {subtitle && <div className="text-[10px] text-gray-500 dark:text-gray-400 truncate">{subtitle}</div>}
      </div>
      <div className="p-3 sm:p-4">{children}</div>
    </div>
  )
}

function Skeleton({ label, rows = 5 }) {
  return (
    <Card title={label} subtitle="loading…">
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-4 bg-gray-100 dark:bg-gray-700 animate-pulse rounded" />
        ))}
      </div>
    </Card>
  )
}


function SavantCard({ title, data, layout }) {
  const rows = SAVANT_LABELS[layout]
  if (!data) return <Skeleton label={title} rows={8} />
  return (
    <Card title={title} subtitle="percentile vs multi-year history">
      <div className="space-y-2">
        {rows.map(({ key, label, fmt }) => {
          const block = data[key] || {}
          return (
            <PercentileRow key={key} label={label} valueText={fmt(block.value)}
              percentile={block.percentile} rank={block.rank} total={block.total}
              comparison={block.comparison} />
          )
        })}
      </div>
    </Card>
  )
}

function PercentileRow({ label, valueText, percentile, rank, total, comparison }) {
  const pct = percentile ?? 50
  const compShort = comparison === 'conference' ? 'conf' : comparison === 'division' ? 'div' : ''
  return (
    <div className="grid grid-cols-[64px,1fr,80px,52px] items-center gap-2">
      <div className="text-xs font-bold text-gray-700 dark:text-gray-300">{label}</div>
      <div className="relative h-4 bg-gray-100 dark:bg-gray-700 rounded overflow-hidden">
        <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: percentileColor(percentile) }} />
        <div className="absolute inset-y-0 left-1/2 w-px bg-gray-300 dark:bg-gray-600" />
      </div>
      <div className="text-[10px] tabular-nums text-right text-gray-600 dark:text-gray-400 leading-tight">
        {comparison === 'history'
          ? (percentile != null ? <><span className="font-bold text-gray-800 dark:text-gray-200">{percentile}</span><span className="text-gray-400 ml-0.5">pctile</span></> : '—')
          : (rank != null && total != null
              ? <>#{rank}/{total}<span className="text-gray-400 ml-1">{compShort}</span></>
              : '—')}
      </div>
      <div className="text-sm font-bold tabular-nums text-right text-gray-900 dark:text-gray-100">{valueText}</div>
    </div>
  )
}


function Headshot({ src, name }) {
  const cls = 'h-16 w-16 sm:h-20 sm:w-20 text-base'
  if (src) {
    return (
      <img src={src} alt="" className={`${cls} rounded-lg object-cover bg-gray-100 shrink-0`}
        onError={(e) => { e.currentTarget.style.display = 'none'
          if (e.currentTarget.nextSibling) e.currentTarget.nextSibling.style.display = 'flex' }} />
    )
  }
  const initials = (name || '?').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
  return (
    <div className={`${cls} rounded-lg bg-nw-teal/10 dark:bg-nw-teal/30 text-nw-teal dark:text-gray-100 font-bold flex items-center justify-center shrink-0`}>
      {initials}
    </div>
  )
}

function Spotlight({ ig, side }) {
  const isBat = side === 'bat'
  if (!ig) return <Skeleton label={isBat ? 'Top Hitter' : 'Top Pitcher'} rows={4} />
  const top = (isBat ? ig.top_hitters : ig.top_pitchers)?.[0]
  if (!top) return null
  const stats = isBat
    ? [
        { label: 'AVG', value: fmtAvg(top.batting_avg) },
        { label: 'wOBA', value: fmtAvg(top.woba) },
        { label: 'wRC+', value: top.wrc_plus != null ? Math.round(top.wrc_plus) : '—' },
        { label: 'WAR', value: fmtWar(top.offensive_war) },
      ]
    : [
        { label: 'ERA', value: top.era != null ? top.era.toFixed(2) : '—' },
        { label: 'SIERA', value: top.siera != null ? top.siera.toFixed(2) : '—' },
        { label: 'K%', value: top.k_pct != null ? `${top.k_pct.toFixed(1)}%` : '—' },
        { label: 'WAR', value: fmtWar(top.pitching_war) },
      ]
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
      <div className={`h-1 ${isBat ? 'bg-emerald-500' : 'bg-sky-500'}`} />
      <div className="p-4 flex items-center gap-4">
        <Headshot src={top.headshot_url} name={top.name || `${top.first_name || ''} ${top.last_name || ''}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <Link to={`/player/${top.id || top.player_id}`}
              className="text-base sm:text-lg font-bold text-nw-teal dark:text-gray-100 hover:underline truncate">
              {top.name || `${top.first_name} ${top.last_name}`}
            </Link>
            <span className="text-[10px] uppercase tracking-widest font-bold text-gray-400 shrink-0">
              {isBat ? 'Top Hitter' : 'Top Pitcher'}
            </span>
          </div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">
            {top.position || ''}{top.year_in_school ? ` · ${top.year_in_school}` : ''}
          </div>
          <div className="grid grid-cols-4 gap-2">
            {stats.map((s, i) => (
              <div key={i}>
                <div className="text-[9px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{s.label}</div>
                <div className="text-sm font-bold tabular-nums text-gray-900 dark:text-gray-100">{s.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}


function LeadersBoard({ ig, side }) {
  const isBat = side === 'bat'
  if (!ig) return <Skeleton label={isBat ? 'Top Hitters' : 'Top Pitchers'} rows={5} />
  const rows = (isBat ? ig.top_hitters : ig.top_pitchers) || []
  return (
    <Card title={isBat ? 'Top Hitters' : 'Top Pitchers'} subtitle={isBat ? 'by WAR · qualified' : 'by WAR · min 5 IP'}>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide border-b border-gray-100 dark:border-gray-700">
            <th className="text-left pb-1.5">Player</th>
            {isBat ? <>
              <th className="text-right pb-1.5">AVG</th><th className="text-right pb-1.5">wOBA</th>
              <th className="text-right pb-1.5">wRC+</th><th className="text-right pb-1.5">WAR</th>
            </> : <>
              <th className="text-right pb-1.5">ERA</th><th className="text-right pb-1.5">SIERA</th>
              <th className="text-right pb-1.5">K%</th><th className="text-right pb-1.5">WAR</th>
            </>}
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.id || i} className="border-b border-gray-50 dark:border-gray-700/50 last:border-0 hover:bg-nw-teal/5 dark:hover:bg-gray-700/40 transition-colors">
              <td className="py-1.5">
                <Link to={`/player/${p.id || p.player_id}`} className="text-nw-teal dark:text-gray-100 hover:underline font-medium">
                  {p.name || `${p.first_name} ${p.last_name}`}
                </Link>
                {p.position && <span className="text-[10px] text-gray-400 ml-1.5">{p.position}</span>}
              </td>
              {isBat ? <>
                <td className="text-right tabular-nums">{fmtAvg(p.batting_avg)}</td>
                <td className="text-right tabular-nums">{fmtAvg(p.woba)}</td>
                <td className="text-right tabular-nums">{p.wrc_plus != null ? Math.round(p.wrc_plus) : '—'}</td>
                <td className="text-right font-semibold tabular-nums">{fmtWar(p.offensive_war)}</td>
              </> : <>
                <td className="text-right tabular-nums">{p.era != null ? p.era.toFixed(2) : '—'}</td>
                <td className="text-right tabular-nums">{p.siera != null ? p.siera.toFixed(2) : '—'}</td>
                <td className="text-right tabular-nums">{p.k_pct != null ? `${p.k_pct.toFixed(1)}%` : '—'}</td>
                <td className="text-right font-semibold tabular-nums">{fmtWar(p.pitching_war)}</td>
              </>}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={5} className="text-center text-gray-400 text-xs py-3">No qualified players yet.</td></tr>
          )}
        </tbody>
      </table>
    </Card>
  )
}


function ClutchPerformers({ teamId, season }) {
  const { data } = useTopMoments(season, { leaderboard_limit: 2000, moments_limit: 1 })
  const tid = Number(teamId)
  const hitters = useMemo(() => (data?.top_hitters || [])
    .filter(p => p.team_id === tid).sort((a, b) => (b.total_wpa || 0) - (a.total_wpa || 0)).slice(0, 6), [data, tid])
  const pitchers = useMemo(() => (data?.top_pitchers || [])
    .filter(p => p.team_id === tid).sort((a, b) => (b.total_wpa || 0) - (a.total_wpa || 0)).slice(0, 6), [data, tid])
  if (!data) return <Skeleton label="Clutch Performers" rows={4} />
  if (hitters.length === 0 && pitchers.length === 0) return null
  return (
    <Card title="Clutch Performers" subtitle="highest cumulative Win Probability Added (WPA)">
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
      <div className="text-[10px] uppercase tracking-widest text-nw-teal font-semibold mb-1.5">{title}</div>
      {rows.length === 0 ? (
        <div className="text-xs text-gray-400 italic py-1">None yet.</div>
      ) : (
        <ul className="space-y-1">
          {rows.map(p => {
            const sign = p.total_wpa >= 0 ? '+' : ''
            const colorClass = p.total_wpa >= 0.5 ? 'text-emerald-600 dark:text-emerald-400'
              : p.total_wpa <= -0.5 ? 'text-rose-500 dark:text-rose-400' : 'text-gray-700 dark:text-gray-300'
            return (
              <li key={p.player_id} className="flex items-center justify-between gap-2">
                <Link to={`/player/${p.player_id}`} className="text-sm font-medium text-nw-teal dark:text-gray-100 hover:underline truncate">
                  {p.name}
                </Link>
                <div className="flex items-baseline gap-1.5 shrink-0">
                  <span className={`text-sm font-bold tabular-nums ${colorClass}`}>{sign}{p.total_wpa.toFixed(2)}</span>
                  <span className="text-[10px] text-gray-400 tabular-nums w-14 text-right">{p.pa || p.bf} {unit}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
