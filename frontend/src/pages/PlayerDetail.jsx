import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { usePlayer } from '../hooks/useApi'
import { formatStat, divisionBadgeClass } from '../utils/stats'

// ── Percentile bubble configs ──────────────────────────────────
const BATTING_PERCENTILE_METRICS = [
  { key: 'woba',         label: 'wOBA',   format: 'avg' },
  { key: 'wrc_plus',     label: 'wRC+',   format: 'int' },
  { key: 'iso',          label: 'ISO',    format: 'avg' },
  { key: 'bb_pct',       label: 'BB%',    format: 'pct' },
  { key: 'k_pct',        label: 'K%',     format: 'pct' },
  { key: 'offensive_war', label: 'WAR',   format: 'war' },
  { key: 'stolen_bases', label: 'SB',     format: 'int' },
]

const PITCHING_PERCENTILE_METRICS = [
  { key: 'k_pct',        label: 'K%',     format: 'pct' },
  { key: 'bb_pct',       label: 'BB%',    format: 'pct' },
  { key: 'fip',          label: 'FIP',    format: 'era' },
  { key: 'fip_plus',     label: 'FIP+',   format: 'int' },
  { key: 'era_plus',    label: 'ERA+',   format: 'int' },
  { key: 'xfip',         label: 'xFIP',   format: 'era' },
  { key: 'siera',        label: 'SIERA',  format: 'era' },
  { key: 'lob_pct',      label: 'LOB%',   format: 'pct' },
  { key: 'pitching_war', label: 'WAR',    format: 'war' },
  { key: 'k_bb_pct',     label: 'K-BB%',  format: 'pct' },
]

// ── Stat table column configs ──────────────────────────────────
const BATTING_TABLE_COLS = [
  { key: 'season',       label: 'Year',  format: null },
  { key: 'team_short',   label: 'Team',  format: null },
  { key: 'division_level', label: 'Lvl', format: null },
  { key: 'games',        label: 'G',     format: 'int' },
  { key: 'plate_appearances', label: 'PA', format: 'int' },
  { key: 'at_bats',      label: 'AB',    format: 'int' },
  { key: 'hits',         label: 'H',     format: 'int' },
  { key: 'doubles',      label: '2B',    format: 'int' },
  { key: 'triples',      label: '3B',    format: 'int' },
  { key: 'home_runs',    label: 'HR',    format: 'int' },
  { key: 'runs',         label: 'R',     format: 'int' },
  { key: 'rbi',          label: 'RBI',   format: 'int' },
  { key: 'walks',        label: 'BB',    format: 'int' },
  { key: 'strikeouts',   label: 'K',     format: 'int' },
  { key: 'stolen_bases', label: 'SB',    format: 'int' },
  { key: 'batting_avg',  label: 'AVG',   format: 'avg' },
  { key: 'on_base_pct',  label: 'OBP',   format: 'avg' },
  { key: 'slugging_pct', label: 'SLG',   format: 'avg' },
  { key: 'ops',          label: 'OPS',   format: 'avg' },
  { key: 'woba',         label: 'wOBA',  format: 'avg' },
  { key: 'wrc_plus',     label: 'wRC+',  format: 'int' },
  { key: 'iso',          label: 'ISO',   format: 'avg' },
  { key: 'bb_pct',       label: 'BB%',   format: 'pct' },
  { key: 'k_pct',        label: 'K%',    format: 'pct' },
  { key: 'offensive_war', label: 'oWAR', format: 'war' },
]

const PITCHING_TABLE_COLS = [
  { key: 'season',       label: 'Year',  format: null },
  { key: 'team_short',   label: 'Team',  format: null },
  { key: 'division_level', label: 'Lvl', format: null },
  { key: 'wins',         label: 'W',     format: 'int' },
  { key: 'losses',       label: 'L',     format: 'int' },
  { key: 'saves',        label: 'SV',    format: 'int' },
  { key: 'games',        label: 'G',     format: 'int' },
  { key: 'games_started', label: 'GS',   format: 'int' },
  { key: 'innings_pitched', label: 'IP', format: 'ip' },
  { key: 'strikeouts',   label: 'K',     format: 'int' },
  { key: 'walks',        label: 'BB',    format: 'int' },
  { key: 'hits_allowed', label: 'H',     format: 'int' },
  { key: 'earned_runs',  label: 'ER',    format: 'int' },
  { key: 'era',          label: 'ERA',   format: 'era' },
  { key: 'whip',         label: 'WHIP',  format: 'era' },
  { key: 'fip',          label: 'FIP',   format: 'era' },
  { key: 'fip_plus',     label: 'FIP+',  format: 'int' },
  { key: 'era_plus',    label: 'ERA+',  format: 'int' },
  { key: 'xfip',         label: 'xFIP',  format: 'era' },
  { key: 'siera',        label: 'SIERA', format: 'era' },
  { key: 'k_pct',        label: 'K%',    format: 'pct' },
  { key: 'bb_pct',       label: 'BB%',   format: 'pct' },
  { key: 'lob_pct',      label: 'LOB%',  format: 'pct' },
  { key: 'pitching_war', label: 'WAR',   format: 'war' },
]

// ── Helpers ────────────────────────────────────────────────────

/**
 * Baseball Savant-style percentile color — matches their blue→gray→red gradient.
 * Uses linear interpolation between color stops for a smooth result.
 */
function percentileColor(pct) {
  // Color stops: [percentile, r, g, b]
  const stops = [
    [1,   23,  57, 122],   // #17397a deep blue
    [10,  36,  90, 163],   // #245aa3
    [20,  62, 130, 202],   // #3e82ca
    [30, 108, 172, 221],   // #6cacdd
    [40, 162, 200, 226],   // #a2c8e2
    [50, 186, 186, 186],   // #bababa gray
    [60, 219, 183, 163],   // #dbb7a3
    [70, 217, 147, 130],   // #d99382
    [80, 209, 107,  97],   // #d16b61
    [90, 193,  58,  55],   // #c13a37
    [99, 174,  10,  32],   // #ae0a20
  ]

  const p = Math.max(1, Math.min(99, pct))

  // Find surrounding stops
  let lo = stops[0], hi = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (p >= stops[i][0] && p <= stops[i + 1][0]) {
      lo = stops[i]
      hi = stops[i + 1]
      break
    }
  }

  const t = hi[0] === lo[0] ? 0 : (p - lo[0]) / (hi[0] - lo[0])
  const r = Math.round(lo[1] + t * (hi[1] - lo[1]))
  const g = Math.round(lo[2] + t * (hi[2] - lo[2]))
  const b = Math.round(lo[3] + t * (hi[3] - lo[3]))
  return `rgb(${r},${g},${b})`
}

function computeCareerTotals(seasons, type) {
  if (!seasons.length) return null

  const sumKeys = type === 'batting'
    ? ['games', 'games_started', 'plate_appearances', 'at_bats', 'runs', 'hits',
       'doubles', 'triples', 'home_runs', 'rbi', 'walks', 'strikeouts',
       'hit_by_pitch', 'sacrifice_flies', 'sacrifice_bunts', 'stolen_bases',
       'caught_stealing', 'grounded_into_dp']
    : ['games', 'games_started', 'wins', 'losses', 'saves', 'complete_games',
       'shutouts', 'innings_pitched', 'hits_allowed', 'runs_allowed',
       'earned_runs', 'walks', 'strikeouts', 'home_runs_allowed',
       'hit_batters', 'wild_pitches', 'batters_faced']

  const totals = { season: 'Career', team_short: '', division_level: '' }
  for (const k of sumKeys) {
    totals[k] = seasons.reduce((s, row) => s + (row[k] || 0), 0)
  }

  if (type === 'batting') {
    const { at_bats: ab, hits: h, walks: bb, hit_by_pitch: hbp,
            sacrifice_flies: sf, doubles: d2, triples: d3, home_runs: hr } = totals
    const pa = totals.plate_appearances
    totals.batting_avg = ab > 0 ? h / ab : null
    totals.on_base_pct = pa > 0 ? (h + bb + (hbp || 0)) / (ab + bb + (hbp || 0) + (sf || 0)) : null
    const tb = h + d2 + 2 * d3 + 3 * hr
    totals.slugging_pct = ab > 0 ? tb / ab : null
    totals.ops = (totals.on_base_pct || 0) + (totals.slugging_pct || 0)
    totals.iso = ab > 0 ? (totals.slugging_pct - totals.batting_avg) : null
    totals.bb_pct = pa > 0 ? bb / pa : null
    totals.k_pct = pa > 0 ? totals.strikeouts / pa : null
    // Sum WAR across seasons
    totals.offensive_war = seasons.reduce((s, r) => s + (r.offensive_war || 0), 0)
  } else {
    const { earned_runs: er, innings_pitched: ip, walks: bb, hits_allowed: h,
            strikeouts: k, batters_faced: bf } = totals
    totals.era = ip > 0 ? (er / ip) * 9 : null
    totals.whip = ip > 0 ? (bb + h) / ip : null
    totals.k_pct = bf > 0 ? k / bf : null
    totals.bb_pct = bf > 0 ? bb / bf : null
    totals.pitching_war = seasons.reduce((s, r) => s + (r.pitching_war || 0), 0)
  }

  return totals
}


// ── Components ─────────────────────────────────────────────────

function PercentileBars({ percentiles, metrics, title, divisionLevel }) {
  const available = metrics.filter(m => percentiles[m.key])
  if (!available.length) return null

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 mb-6 overflow-hidden">
      {/* Header bar */}
      <div className="px-3 sm:px-5 pt-4 sm:pt-5 pb-2 sm:pb-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base sm:text-lg font-bold text-gray-800">{title}</h3>
          <span className="text-[10px] sm:text-xs font-medium text-gray-400 uppercase tracking-wide">
            vs. {divisionLevel || 'Division'}
          </span>
        </div>
      </div>

      {/* Scale legend — hidden on very small screens */}
      <div className="px-3 sm:px-5 mb-2 hidden sm:block">
        <div className="flex items-end" style={{ paddingLeft: 120 }}>
          <div className="flex-1 flex justify-between text-[10px] font-bold tracking-wider">
            <div className="flex flex-col items-center">
              <span style={{ color: 'rgb(36,90,163)' }}>POOR</span>
              <span style={{ color: 'rgb(36,90,163)', fontSize: 8 }}>&#9650;</span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-gray-400">AVERAGE</span>
              <span className="text-gray-400" style={{ fontSize: 8 }}>&#9650;</span>
            </div>
            <div className="flex flex-col items-center">
              <span style={{ color: 'rgb(193,58,55)' }}>GREAT</span>
              <span style={{ color: 'rgb(193,58,55)', fontSize: 8 }}>&#9650;</span>
            </div>
          </div>
          <div style={{ width: 52 }} />
        </div>
      </div>

      {/* Stat rows */}
      <div className="px-3 sm:px-5 pb-4 sm:pb-5">
        {available.map((metric, idx) => {
          const { value, percentile } = percentiles[metric.key]
          const color = percentileColor(percentile)
          const barWidth = Math.max(4, percentile)

          return (
            <div key={metric.key}>
              {/* Dashed separator */}
              {idx > 0 && (
                <div className="border-t border-dashed border-gray-200 ml-16 sm:ml-[120px]" />
              )}

              <div className="flex items-center h-8 sm:h-9">
                {/* Stat label — right aligned */}
                <div className="shrink-0 text-right pr-2 sm:pr-3 w-16 sm:w-[120px]">
                  <span className="text-[11px] sm:text-[13px] font-medium text-gray-600">
                    {metric.label}
                  </span>
                </div>

                {/* Bar area */}
                <div className="flex-1 relative h-6 sm:h-7">
                  {/* Track background */}
                  <div
                    className="absolute top-1/2 left-0 right-0 bg-gray-100 rounded"
                    style={{ height: 6, transform: 'translateY(-50%)' }}
                  />

                  {/* Colored bar */}
                  <div
                    className="absolute top-1/2 left-0 rounded"
                    style={{
                      height: 6,
                      width: `calc(${barWidth}% - 12px)`,
                      transform: 'translateY(-50%)',
                      backgroundColor: color,
                      transition: 'width 0.5s ease',
                    }}
                  />

                  {/* Percentile circle */}
                  <div
                    className="absolute top-1/2 flex items-center justify-center rounded-full"
                    style={{
                      left: `${barWidth}%`,
                      transform: 'translate(-50%, -50%)',
                      width: 24,
                      height: 24,
                      backgroundColor: color,
                      border: '2px solid white',
                      boxShadow: '0 0 0 1px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.1)',
                      transition: 'left 0.5s ease',
                    }}
                  >
                    <span className="text-white text-[10px] sm:text-[11px] font-bold leading-none">
                      {percentile}
                    </span>
                  </div>
                </div>

                {/* Stat value — right side */}
                <div className="shrink-0 text-right pl-1.5 sm:pl-2 w-11 sm:w-[52px]">
                  <span className="text-[11px] sm:text-[13px] font-medium text-gray-700 tabular-nums">
                    {formatStat(value, metric.format)}
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div className="px-3 sm:px-5 pb-3 flex items-center justify-between">
        <span className="text-[10px] text-gray-400">
          Min 50 PA / 10 IP to qualify
        </span>
        <span className="text-[10px] text-gray-400 italic">
          vs. {divisionLevel || 'division'}
        </span>
      </div>
    </div>
  )
}

function StatsTable({ rows, columns, careerRow }) {
  if (!rows.length) return null

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b-2 border-nw-teal/30">
            {columns.map(col => (
              <th
                key={col.key}
                className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right first:text-left"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
              {columns.map(col => (
                <td key={col.key} className="px-2 py-1.5 text-right first:text-left whitespace-nowrap">
                  {col.format ? formatStat(row[col.key], col.format) : (row[col.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
          {careerRow && (
            <tr className="border-t-2 border-nw-teal/30 font-semibold bg-gray-50">
              {columns.map(col => (
                <td key={col.key} className="px-2 py-1.5 text-right first:text-left whitespace-nowrap">
                  {col.format ? formatStat(careerRow[col.key], col.format) : (careerRow[col.key] ?? '')}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}


// ── Team Awards ─────────────────────────────────────────────────

function TeamAwards({ awards, careerRankings, teamShort }) {
  // Group season awards by year + team
  const bySeason = {}
  awards.forEach(a => {
    const key = `${a.season}-${a.team_id || ''}`
    if (!bySeason[key]) bySeason[key] = { season: a.season, team_short: a.team_short, team_logo: a.team_logo, team_id: a.team_id, items: [] }
    bySeason[key].items.push(a)
  })
  const seasonKeys = Object.keys(bySeason).sort((a, b) => {
    const sa = bySeason[a].season, sb = bySeason[b].season
    return sb - sa || a.localeCompare(b)
  })

  const hasSeasonAwards = awards.length > 0
  const hasCareerRankings = careerRankings && careerRankings.length > 0

  function formatVal(cat, val) {
    if (cat === 'AVG') return val.toFixed(3)
    if (cat === 'ERA' || cat === 'FIP' || cat === 'WHIP') return val.toFixed(2)
    if (cat === 'oWAR' || cat === 'pWAR' || cat === 'IP') return val.toFixed(1)
    if (cat === 'wRC+') return Math.round(val)
    return val
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd']
    const v = n % 100
    return n + (s[(v - 20) % 10] || s[v] || s[0])
  }

  function TeamLogo({ logo, name, size = 'w-4 h-4' }) {
    if (!logo) return null
    return (
      <img src={logo} alt={name || ''} className={`${size} object-contain shrink-0`}
        loading="lazy" onError={(e) => { e.target.style.display = 'none' }} />
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 mb-6">
      {/* Season Awards */}
      {hasSeasonAwards && (
        <div className={hasCareerRankings ? 'mb-4 pb-4 border-b border-gray-100' : ''}>
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">
            Season Awards
          </h3>
          <div className="space-y-2">
            {seasonKeys.map(key => {
              const group = bySeason[key]
              return (
                <div key={key} className="flex items-start gap-2">
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-xs font-bold text-pnw-slate bg-gray-100 px-2 py-1 rounded w-10 text-center">
                      {String(group.season).slice(-2)}
                    </span>
                    <TeamLogo logo={group.team_logo} name={group.team_short} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {group.items.map((a, i) => (
                      <span
                        key={i}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                          a.type === 'batting'
                            ? 'bg-blue-50 text-blue-700 border border-blue-200'
                            : 'bg-orange-50 text-orange-700 border border-orange-200'
                        }`}
                      >
                        <span className="font-bold">{a.category}</span>
                        <span className="opacity-70">{formatVal(a.category, a.value)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
          <p className="text-[10px] text-gray-400 mt-2">Team leader in category per season</p>
        </div>
      )}

      {/* Career Rankings */}
      {hasCareerRankings && (
        <div>
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">
            Career Rankings
          </h3>
          <div className="flex flex-wrap gap-2">
            {careerRankings.map((r, i) => (
              <div
                key={i}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border ${
                  r.rank === 1
                    ? 'bg-amber-50 text-amber-800 border-amber-200'
                    : r.rank === 2
                    ? 'bg-gray-50 text-gray-600 border-gray-300'
                    : r.rank === 3
                    ? 'bg-orange-50 text-orange-700 border-orange-200'
                    : 'bg-gray-50 text-gray-600 border-gray-200'
                }`}
              >
                <TeamLogo logo={r.team_logo} name={r.team_short} />
                <span className="font-bold">
                  {ordinal(r.rank)}
                </span>
                <span>in {r.category}</span>
                <span className="opacity-60">({formatVal(r.category, r.value)})</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-gray-400 mt-2">All-time team career rankings (since 2022, min 50 PA / 20 IP)</p>
        </div>
      )}
    </div>
  )
}


// ── Main Page ──────────────────────────────────────────────────

export default function PlayerDetail() {
  const { playerId } = useParams()
  const [percentileSeason, setPercentileSeason] = useState(null) // null = most recent (default)
  const { data, loading, error } = usePlayer(playerId, percentileSeason)

  if (loading && !data) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-nw-teal border-t-transparent rounded-full" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="text-center py-20 text-gray-500">
        {error || 'Player not found.'}
      </div>
    )
  }

  const { player, batting_stats, pitching_stats, batting_percentiles, pitching_percentiles, percentile_season: activePercentileSeason, awards, career_rankings, linked_players } = data
  const isTransfer = linked_players && linked_players.length > 1
  const hasBatting = batting_stats && batting_stats.length > 0
  const hasPitching = pitching_stats && pitching_stats.length > 0
  const battingCareer = hasBatting ? computeCareerTotals(batting_stats, 'batting') : null
  const pitchingCareer = hasPitching ? computeCareerTotals(pitching_stats, 'pitching') : null

  // Build available seasons for the toggle (from both batting and pitching)
  const allSeasons = [
    ...new Set([
      ...(batting_stats || []).map(s => s.season),
      ...(pitching_stats || []).map(s => s.season),
    ])
  ].sort((a, b) => b - a) // newest first

  const hasMultipleSeasons = allSeasons.length > 1

  // Determine the display label for the percentile section
  const percentileLabel = activePercentileSeason === 'career'
    ? 'Career'
    : `${activePercentileSeason || allSeasons[0] || 'Current'} Season`

  return (
    <div>
      {/* ── Player Header ── */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 sm:p-6 mb-4 sm:mb-6">
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
              {player.first_name} {player.last_name}
              {player.jersey_number && (
                <span className="text-gray-400 font-normal ml-2">#{player.jersey_number}</span>
              )}
            </h1>
            <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-1 text-sm text-gray-600">
              <Link
                to={`/team/${player.team_id}`}
                className="text-nw-teal hover:underline font-medium flex items-center gap-1.5"
              >
                {player.logo_url && (
                  <img
                    src={player.logo_url}
                    alt=""
                    className="w-5 h-5 object-contain shrink-0"
                    loading="lazy"
                    onError={(e) => { e.target.style.display = 'none' }}
                  />
                )}
                {player.team_name}
              </Link>
              <span className={`px-2 py-0.5 rounded text-xs font-bold ${divisionBadgeClass(player.division_level)}`}>
                {player.division_level}
              </span>
              <span>{player.conference_abbrev}</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-3 sm:gap-x-6 gap-y-1 text-xs sm:text-sm text-gray-600">
            {player.position && (
              <div><span className="text-gray-400">Pos</span> <span className="font-medium">{player.position}</span></div>
            )}
            {player.year_in_school && (
              <div><span className="text-gray-400">Yr</span> <span className="font-medium">{player.year_in_school}</span></div>
            )}
            {(player.bats || player.throws) && (
              <div><span className="text-gray-400">B/T</span> <span className="font-medium">{player.bats || '—'}/{player.throws || '—'}</span></div>
            )}
            {player.height && (
              <div><span className="text-gray-400">Ht</span> <span className="font-medium">{player.height}</span></div>
            )}
            {player.hometown && (
              <div><span className="text-gray-400">From</span> <span className="font-medium">{player.hometown}</span></div>
            )}
            {player.previous_school && (
              <div><span className="text-gray-400">Prev</span> <span className="font-medium">{player.previous_school}</span></div>
            )}
          </div>
        </div>
      </div>

      {/* ── Transfer History (multi-school career) ── */}
      {isTransfer && (
        <div className="bg-gradient-to-r from-blue-50 to-teal-50 rounded-lg border border-blue-200 p-4 mb-6">
          <div className="flex items-center gap-2 mb-2">
            <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            <span className="text-sm font-semibold text-blue-700">Multi-School Career</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {linked_players.map((lp, idx) => (
              <div key={lp.id} className="flex items-center gap-1.5">
                {idx > 0 && <span className="text-gray-400 mr-1">→</span>}
                <Link
                  to={`/team/${lp.team_id}`}
                  className="flex items-center gap-1.5 px-2.5 py-1 bg-white rounded-full border border-gray-200 text-sm font-medium text-gray-700 hover:border-nw-teal hover:text-nw-teal transition-colors"
                >
                  {lp.logo_url && (
                    <img src={lp.logo_url} alt="" className="w-4 h-4 object-contain" loading="lazy"
                      onError={(e) => { e.target.style.display = 'none' }} />
                  )}
                  {lp.team_short}
                  <span className={`ml-0.5 px-1.5 py-0 rounded text-[10px] font-bold ${divisionBadgeClass(lp.division_level)}`}>
                    {lp.division_level}
                  </span>
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Team Awards & Career Rankings ── */}
      {((awards && awards.length > 0) || (career_rankings && career_rankings.length > 0)) && (
        <TeamAwards awards={awards || []} careerRankings={career_rankings || []} teamShort={player.team_short} />
      )}

      {/* ── Season Filter (only show if player has multiple seasons) ── */}
      {hasMultipleSeasons && (hasBatting || hasPitching) && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider mr-1">Rankings</span>
          {allSeasons.map(season => (
            <button
              key={season}
              onClick={() => setPercentileSeason(
                // If clicking the most recent season and we're already on default (null), do nothing
                // Otherwise set it. If already selected, go back to default (most recent).
                percentileSeason === String(season) ? null : String(season)
              )}
              className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${
                (percentileSeason === String(season)) || (!percentileSeason && activePercentileSeason === String(season))
                  ? 'bg-nw-teal text-white shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {season}
            </button>
          ))}
          <button
            onClick={() => setPercentileSeason(percentileSeason === 'career' ? null : 'career')}
            className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${
              percentileSeason === 'career'
                ? 'bg-nw-teal text-white shadow-sm'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            Career
          </button>
          {loading && (
            <div className="animate-spin h-4 w-4 border-2 border-nw-teal border-t-transparent rounded-full ml-1" />
          )}
        </div>
      )}

      {/* ── Batting Percentiles ── */}
      {batting_percentiles && Object.keys(batting_percentiles).length > 0 && (
        <PercentileBars
          percentiles={batting_percentiles}
          metrics={BATTING_PERCENTILE_METRICS}
          title={`Batting — ${percentileLabel}`}
          divisionLevel={player.division_level}
        />
      )}

      {/* ── Pitching Percentiles ── */}
      {pitching_percentiles && Object.keys(pitching_percentiles).length > 0 && (
        <PercentileBars
          percentiles={pitching_percentiles}
          metrics={PITCHING_PERCENTILE_METRICS}
          title={`Pitching — ${percentileLabel}`}
          divisionLevel={player.division_level}
        />
      )}

      {/* ── Batting Stats Table (career) ── */}
      {hasBatting && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3 sm:p-5 mb-4 sm:mb-6">
          <h3 className="text-xs sm:text-sm font-semibold text-gray-600 uppercase tracking-wider mb-2 sm:mb-3">
            {batting_stats.length > 1 ? 'Career Batting Stats' : 'Batting Stats'}
          </h3>
          <div className="overflow-x-auto -mx-3 sm:mx-0">
            <div className="min-w-[700px] px-3 sm:px-0">
              <StatsTable rows={batting_stats} columns={BATTING_TABLE_COLS} careerRow={battingCareer} />
            </div>
          </div>
        </div>
      )}

      {/* ── Pitching Stats Table (career) ── */}
      {hasPitching && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3 sm:p-5 mb-4 sm:mb-6">
          <h3 className="text-xs sm:text-sm font-semibold text-gray-600 uppercase tracking-wider mb-2 sm:mb-3">
            {pitching_stats.length > 1 ? 'Career Pitching Stats' : 'Pitching Stats'}
          </h3>
          <div className="overflow-x-auto -mx-3 sm:mx-0">
            <div className="min-w-[700px] px-3 sm:px-0">
              <StatsTable rows={pitching_stats} columns={PITCHING_TABLE_COLS} careerRow={pitchingCareer} />
            </div>
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {!hasBatting && !hasPitching && (
        <div className="text-center py-12 text-gray-400">
          No stats recorded for this player yet.
        </div>
      )}
    </div>
  )
}
