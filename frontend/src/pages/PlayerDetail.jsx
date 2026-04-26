import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { usePlayer, usePlayerGameLogs, usePlayerSplits } from '../hooks/useApi'
import { formatStat, divisionBadgeClass } from '../utils/stats'
import FavoriteButton from '../components/FavoriteButton'
import StatsLastUpdated from '../components/StatsLastUpdated'
import PitchLevelStatsCard from '../components/PitchLevelStatsCard'
import PitcherPitchLevelStatsCard from '../components/PitcherPitchLevelStatsCard'

// ── Percentile bubble configs ──────────────────────────────────
// Pre-2026: original metric set. Kept stable for historic seasons so
// old player profiles don't suddenly lose stats they had before.
const BATTING_PERCENTILE_METRICS = [
  { key: 'woba',         label: 'wOBA',   format: 'avg' },
  { key: 'wrc_plus',     label: 'wRC+',   format: 'int' },
  { key: 'iso',          label: 'ISO',    format: 'avg' },
  { key: 'hr_pa_pct',    label: 'HR/PA%', format: 'pct' },
  { key: 'bb_pct',       label: 'BB%',    format: 'pct' },
  { key: 'k_pct',        label: 'K%',     format: 'pct' },
  { key: 'offensive_war', label: 'WAR',   format: 'war' },
  { key: 'sb_per_pa',    label: 'SB/PA',  format: 'pct' },
]

const PITCHING_PERCENTILE_METRICS = [
  { key: 'k_pct',        label: 'K%',     format: 'pct' },
  { key: 'bb_pct',       label: 'BB%',    format: 'pct' },
  { key: 'fip',          label: 'FIP',    format: 'era' },
  { key: 'fip_plus',     label: 'FIP+',   format: 'int' },
  { key: 'era_plus',    label: 'ERA+',   format: 'int' },
  { key: 'xfip',         label: 'xFIP',   format: 'era' },
  { key: 'siera',        label: 'SIERA',  format: 'era' },
  { key: 'baa',          label: 'BAA',    format: 'avg' },
  { key: 'lob_pct',      label: 'LOB%',   format: 'pct' },
  { key: 'hr_per_9',     label: 'HR/9',   format: 'era' },
  { key: 'pitching_war', label: 'WAR',    format: 'war' },
  { key: 'k_bb_pct',     label: 'K-BB%',  format: 'pct' },
]

// 2026+ metric set — leans on PBP-derived stats (Contact%, AIRPULL%,
// Strike%, FPS%, Whiff%, etc.) that we only have for games with
// pitch-level data.
const BATTING_PERCENTILE_METRICS_2026 = [
  { key: 'offensive_war', label: 'WAR',     format: 'war' },
  { key: 'wrc_plus',      label: 'wRC+',    format: 'int' },
  { key: 'iso',           label: 'ISO',     format: 'avg' },
  { key: 'hr_pa_pct',     label: 'HR/PA',   format: 'pct' },
  { key: 'sb_per_pa',     label: 'SB/PA',   format: 'pct' },
  { key: 'k_pct',         label: 'K%',      format: 'pct' },
  { key: 'bb_pct',        label: 'BB%',     format: 'pct' },
  { key: 'contact_pct',   label: 'Contact%',format: 'pct' },
  { key: 'air_pull_pct',  label: 'AIRPULL%',format: 'pct' },
]

const PITCHING_PERCENTILE_METRICS_2026 = [
  { key: 'pitching_war',           label: 'WAR',          format: 'war' },
  { key: 'k_pct',                  label: 'K%',           format: 'pct' },
  { key: 'bb_pct',                 label: 'BB%',          format: 'pct' },
  { key: 'fip',                    label: 'FIP',          format: 'era' },
  { key: 'siera',                  label: 'SIERA',        format: 'era' },
  { key: 'hr_pa_pct',              label: 'HR/PA',        format: 'pct' },
  { key: 'opp_woba',               label: 'opp wOBA',     format: 'avg' },
  { key: 'strike_pct',             label: 'Strike%',      format: 'pct' },
  { key: 'first_pitch_strike_pct', label: 'FPS%',         format: 'pct' },
  { key: 'whiff_pct',              label: 'Whiff%',       format: 'pct' },
  { key: 'opp_air_pull_pct',       label: 'opp AIRPULL%', format: 'pct' },
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
  { key: 'baa',          label: 'BAA',   format: 'avg' },
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

// ── Summer stat table column configs ──────────────────────────
const SUMMER_BATTING_TABLE_COLS = [
  { key: 'season',       label: 'Year',   format: null },
  { key: 'team_name',    label: 'Team',   format: null },
  { key: 'league_abbrev', label: 'League', format: null },
  { key: 'games',        label: 'G',      format: 'int' },
  { key: 'plate_appearances', label: 'PA', format: 'int' },
  { key: 'at_bats',      label: 'AB',     format: 'int' },
  { key: 'hits',         label: 'H',      format: 'int' },
  { key: 'doubles',      label: '2B',     format: 'int' },
  { key: 'triples',      label: '3B',     format: 'int' },
  { key: 'home_runs',    label: 'HR',     format: 'int' },
  { key: 'runs',         label: 'R',      format: 'int' },
  { key: 'rbi',          label: 'RBI',    format: 'int' },
  { key: 'walks',        label: 'BB',     format: 'int' },
  { key: 'strikeouts',   label: 'K',      format: 'int' },
  { key: 'stolen_bases', label: 'SB',     format: 'int' },
  { key: 'batting_avg',  label: 'AVG',    format: 'avg' },
  { key: 'on_base_pct',  label: 'OBP',    format: 'avg' },
  { key: 'slugging_pct', label: 'SLG',    format: 'avg' },
  { key: 'ops',          label: 'OPS',    format: 'avg' },
]

const SUMMER_PITCHING_TABLE_COLS = [
  { key: 'season',       label: 'Year',   format: null },
  { key: 'team_name',    label: 'Team',   format: null },
  { key: 'league_abbrev', label: 'League', format: null },
  { key: 'wins',         label: 'W',      format: 'int' },
  { key: 'losses',       label: 'L',      format: 'int' },
  { key: 'saves',        label: 'SV',     format: 'int' },
  { key: 'games',        label: 'G',      format: 'int' },
  { key: 'games_started', label: 'GS',    format: 'int' },
  { key: 'innings_pitched', label: 'IP',  format: 'ip' },
  { key: 'strikeouts',   label: 'K',      format: 'int' },
  { key: 'walks',        label: 'BB',     format: 'int' },
  { key: 'hits_allowed', label: 'H',      format: 'int' },
  { key: 'earned_runs',  label: 'ER',     format: 'int' },
  { key: 'era',          label: 'ERA',    format: 'era' },
  { key: 'whip',         label: 'WHIP',   format: 'era' },
  { key: 'k_per_9',      label: 'K/9',    format: 'era' },
  { key: 'bb_per_9',     label: 'BB/9',   format: 'era' },
]

// ── Helpers ────────────────────────────────────────────────────

/**
 * Baseball Savant-style percentile color - matches their blue->gray->red gradient.
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
            strikeouts: k, batters_faced: bf, hit_batters: hbp } = totals
    totals.era = ip > 0 ? (er / ip) * 9 : null
    totals.whip = ip > 0 ? (bb + h) / ip : null
    totals.k_pct = bf > 0 ? k / bf : null
    totals.bb_pct = bf > 0 ? bb / bf : null
    // BAA = H / (BF - BB - HBP)
    const baaDenom = (bf || 0) - (bb || 0) - (hbp || 0)
    totals.baa = baaDenom > 0 ? h / baaDenom : null
    totals.pitching_war = seasons.reduce((s, r) => s + (r.pitching_war || 0), 0)
  }

  return totals
}


// ── Components ─────────────────────────────────────────────────

function PercentileBars({ percentiles, metrics, title, divisionLevel, seasonFilter, fillHeight = false }) {
  const available = metrics.filter(m => percentiles[m.key])
  if (!available.length) return null

  return (
    <div className={`bg-white rounded-lg shadow-sm border border-gray-200 mb-4 sm:mb-6 overflow-hidden flex flex-col ${fillHeight ? 'h-full' : ''}`}>
      {/* Header bar */}
      <div className="px-3 sm:px-5 pt-4 sm:pt-5 pb-2 sm:pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-base sm:text-lg font-bold text-gray-800">{title}</h3>
          {/* Season filter chips (passed in) — render inside the rectangle */}
          {seasonFilter}
          <span className="text-[10px] sm:text-xs font-medium text-gray-400 uppercase tracking-wide">
            vs. {divisionLevel || 'Division'}
          </span>
        </div>
      </div>

      {/* Scale legend - hidden on very small screens */}
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
                {/* Stat label - right aligned */}
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

                {/* Stat value - right side */}
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
          Min 10 PA / 5 IP to qualify
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

  // First column (Season/Year) is sticky on mobile
  const firstKey = columns[0]?.key

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b-2 border-nw-teal/30">
            {columns.map((col, ci) => (
              <th
                key={col.key}
                className={`px-2 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right first:text-left ${ci === 0 ? 'sticky-col sticky-col-last bg-white' : ''}`}
                style={ci === 0 ? { position: 'sticky', left: 0, zIndex: 10 } : undefined}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
              {columns.map((col, ci) => (
                <td
                  key={col.key}
                  className={`px-2 py-1.5 text-right first:text-left whitespace-nowrap ${ci === 0 ? 'sticky-col sticky-col-last bg-white' : ''}`}
                  style={ci === 0 ? { position: 'sticky', left: 0, zIndex: 5 } : undefined}
                >
                  {col.format ? formatStat(row[col.key], col.format) : (row[col.key] ?? '-')}
                </td>
              ))}
            </tr>
          ))}
          {careerRow && (
            <tr className="border-t-2 border-nw-teal/30 font-semibold bg-gray-50">
              {columns.map((col, ci) => (
                <td
                  key={col.key}
                  className={`px-2 py-1.5 text-right first:text-left whitespace-nowrap ${ci === 0 ? 'sticky-col sticky-col-last bg-gray-50' : ''}`}
                  style={ci === 0 ? { position: 'sticky', left: 0, zIndex: 5 } : undefined}
                >
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

function TeamAwards({ awards, careerRankings, pnwRankings, teamShort }) {
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
  const hasPnwRankings = pnwRankings && pnwRankings.length > 0

  function formatVal(cat, val, fmt) {
    // If a format hint is provided (from PNW rankings), use it
    if (fmt === 'avg') return Number(val).toFixed(3)
    if (fmt === 'float1') return Number(val).toFixed(1)
    if (fmt === 'float2') return Number(val).toFixed(2)
    if (fmt === 'int') return Math.round(val)
    if (fmt === 'pct') return Number(val).toFixed(1) + '%'
    // Fallback: format by category name
    if (cat === 'AVG' || cat === 'ISO') return Number(val).toFixed(3)
    if (cat === 'ERA' || cat === 'FIP' || cat === 'WHIP' || cat === 'SIERA') return Number(val).toFixed(2)
    if (cat === 'oWAR' || cat === 'pWAR' || cat === 'IP') return Number(val).toFixed(1)
    if (cat === 'wRC+' || cat === 'FIP+') return Math.round(val)
    if (cat === 'K-BB%') return Number(val).toFixed(1) + '%'
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
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
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

      {/* PNW Rankings */}
      {hasPnwRankings && (
        <div className={hasCareerRankings ? 'mb-4 pb-4 border-b border-gray-100' : ''}>
          <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">
            PNW Rankings
          </h3>
          <div className="flex flex-wrap gap-2">
            {pnwRankings.map((r, i) => (
              <div
                key={i}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border ${
                  r.rank === 1
                    ? 'bg-teal-50 text-teal-800 border-teal-300'
                    : r.rank <= 3
                    ? 'bg-teal-50 text-teal-700 border-teal-200'
                    : 'bg-gray-50 text-teal-700 border-teal-200'
                }`}
              >
                <img src="/favicon.png" alt="NW" className="w-4 h-4 object-contain shrink-0" />
                <span className="font-bold">
                  {ordinal(r.rank)}
                </span>
                <span>in {r.category}</span>
                <span className="opacity-60">({formatVal(r.category, r.value, r.format)})</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-gray-400 mt-2">Top 10 across all PNW divisions (2026, qualified)</p>
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


// ── Position Pie Chart ─────────────────────────────────────────
const POS_COLORS = {
  'C': '#0d9488', 'SS': '#0891b2', 'CF': '#2563eb', '2B': '#7c3aed',
  '3B': '#c026d3', 'RF': '#e11d48', 'LF': '#ea580c', '1B': '#d97706',
  'OF': '#059669', 'IF': '#4f46e5', 'DH': '#6b7280', 'UT': '#9ca3af', 'N/A': '#d1d5db',
}

// Recent games card — last N games' compact lines. Used as a right-
// column filler so the column always has enough vertical bulk to match
// the bars' height. Shows hitting and/or pitching depending on what
// the player did in the last games.
function RecentGames({ batting, pitching, limit = 6, className = '' }) {
  // Sort newest-first by game_date and take the most recent `limit`
  const bat = (batting || []).slice().sort((a, b) => (b.game_date || '').localeCompare(a.game_date || '')).slice(0, limit)
  const pit = (pitching || []).slice().sort((a, b) => (b.game_date || '').localeCompare(a.game_date || '')).slice(0, limit)

  if (bat.length === 0 && pit.length === 0) return null

  function shortDate(d) {
    if (!d) return ''
    const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (!m) return d
    return `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`
  }

  function batLine(g) {
    const parts = [`${g.h}-${g.ab}`]
    if (g.hr)  parts.push(`${g.hr} HR`)
    if (g['2b']) parts.push(`${g['2b']} 2B`)
    if (g['3b']) parts.push(`${g['3b']} 3B`)
    if (g.rbi)   parts.push(`${g.rbi} RBI`)
    if (g.bb)    parts.push(`${g.bb} BB`)
    if (g.k)     parts.push(`${g.k} K`)
    if (g.sb)    parts.push(`${g.sb} SB`)
    return parts.join(', ')
  }

  function pitLine(g) {
    const parts = [`${g.ip} IP`]
    if (g.er != null) parts.push(`${g.er} ER`)
    if (g.h != null)  parts.push(`${g.h} H`)
    if (g.bb != null) parts.push(`${g.bb} BB`)
    if (g.k != null)  parts.push(`${g.k} K`)
    return parts.join(', ')
  }

  // Decision-style decoration for hitter games (W/L/T)
  function resultColor(g) {
    if (g.team_score == null || g.opp_score == null) return 'text-gray-400'
    if (g.team_score > g.opp_score)  return 'text-green-600'
    if (g.team_score < g.opp_score)  return 'text-red-500'
    return 'text-gray-400'
  }
  function resultLetter(g) {
    if (g.team_score == null || g.opp_score == null) return ''
    if (g.team_score > g.opp_score)  return 'W'
    if (g.team_score < g.opp_score)  return 'L'
    return 'T'
  }

  return (
    <div className={`bg-white rounded-lg shadow-sm border border-gray-200 p-4 flex flex-col overflow-hidden ${className}`}>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 shrink-0">
        Recent Games
      </h3>
      {/* Internal scroll — extra games scroll inside this container,
          which keeps the right column from pushing past the bars. */}
      <div className="space-y-1.5 flex-grow min-h-0 overflow-y-auto pr-1">
        {bat.map((g, i) => (
          <div key={`b-${i}`} className="grid grid-cols-[40px_1fr_auto] items-center gap-2 text-[11px] py-1 border-b border-gray-50 last:border-0">
            <span className="text-gray-400 tabular-nums">{shortDate(g.game_date)}</span>
            <span className="text-gray-700 truncate">
              <span className={`font-bold ${resultColor(g)} mr-1`}>{resultLetter(g)}</span>
              <span className="text-gray-500">{g.home_away}{g.opponent_short || '?'}</span>
              <span className="text-gray-400 ml-1.5 text-[10px]">{g.team_score}-{g.opp_score}</span>
            </span>
            <span className="text-gray-700 tabular-nums text-right text-[11px]">{batLine(g)}</span>
          </div>
        ))}
        {pit.map((g, i) => (
          <div key={`p-${i}`} className="grid grid-cols-[40px_1fr_auto] items-center gap-2 text-[11px] py-1 border-b border-gray-50 last:border-0">
            <span className="text-gray-400 tabular-nums">{shortDate(g.game_date)}</span>
            <span className="text-gray-700 truncate">
              <span className={`font-bold ${g.decision === 'W' ? 'text-green-600' : g.decision === 'L' ? 'text-red-500' : g.decision === 'S' ? 'text-blue-500' : 'text-gray-400'} mr-1`}>
                {g.decision || '·'}
              </span>
              <span className="text-gray-500">{g.home_away}{g.opponent_short || '?'}</span>
            </span>
            <span className="text-gray-700 tabular-nums text-right text-[11px]">{pitLine(g)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Filler/summary card for the right column. Always renders so the
// awards + position + glance stack matches the bars' height. Shows
// big-number season counting stats (different from the percentile
// rate stats already in the bars).
function SeasonGlance({ bat, pit, className = '' }) {
  // Only render when we have at least one stat block for the season
  if (!bat && !pit) return null

  const tiles = []
  if (bat && (bat.plate_appearances || 0) > 0) {
    const ip = (bat.plate_appearances - bat.walks - bat.hit_by_pitch - (bat.sacrifice_flies||0))
    tiles.push({ label: 'AVG', value: bat.batting_avg != null ? Number(bat.batting_avg).toFixed(3).replace(/^0/, '') : '-' })
    tiles.push({ label: 'OPS', value: bat.ops != null ? Number(bat.ops).toFixed(3).replace(/^0/, '') : '-' })
    tiles.push({ label: 'HR',  value: bat.home_runs ?? '-' })
    tiles.push({ label: 'RBI', value: bat.rbi ?? '-' })
    tiles.push({ label: 'R',   value: bat.runs ?? '-' })
    tiles.push({ label: 'SB',  value: bat.stolen_bases ?? '-' })
    tiles.push({ label: 'BB',  value: bat.walks ?? '-' })
    tiles.push({ label: 'K',   value: bat.strikeouts ?? '-' })
    tiles.push({ label: 'G',   value: bat.games ?? '-' })
  }
  if (pit && (pit.innings_pitched || 0) > 0) {
    tiles.push({ label: 'W-L', value: `${pit.wins ?? 0}-${pit.losses ?? 0}` })
    tiles.push({ label: 'ERA', value: pit.era != null ? Number(pit.era).toFixed(2) : '-' })
    tiles.push({ label: 'WHIP', value: pit.whip != null ? Number(pit.whip).toFixed(2) : '-' })
    tiles.push({ label: 'IP',  value: pit.innings_pitched != null ? Number(pit.innings_pitched).toFixed(1) : '-' })
    tiles.push({ label: 'K',   value: pit.strikeouts ?? '-' })
    tiles.push({ label: 'BB',  value: pit.walks ?? '-' })
    tiles.push({ label: 'SV',  value: pit.saves ?? '-' })
    tiles.push({ label: 'G',   value: pit.games ?? '-' })
  }

  if (tiles.length === 0) return null

  return (
    <div className={`bg-white rounded-lg shadow-sm border border-gray-200 p-4 flex flex-col ${className}`}>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
        2026 Season Glance
      </h3>
      <div className="grid grid-cols-3 sm:grid-cols-3 gap-2 flex-grow content-start">
        {tiles.map((t, i) => (
          <div key={i} className="bg-gray-50 rounded border border-gray-100 px-2 py-2 text-center">
            <div className="text-[9px] uppercase tracking-wide text-gray-500 font-semibold">{t.label}</div>
            <div className="text-base font-bold text-gray-900 tabular-nums">{t.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function PositionPieChart({ breakdown }) {
  if (!breakdown || breakdown.length === 0) return null
  const total = breakdown.reduce((s, b) => s + b.games, 0)
  if (total === 0) return null

  // Sort by games descending for the bar list
  const rows = [...breakdown].sort((a, b) => b.games - a.games)
  const maxFrac = rows[0].games / total

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Position Breakdown
        </h3>
        <span className="text-[10px] text-gray-400">{total} games tracked</span>
      </div>
      <div className="space-y-2">
        {rows.map((row) => {
          const frac = row.games / total
          // Bar widths scale relative to the most-played position so
          // the largest reads as 100% wide (more visually distinct than
          // raw % which can leave a single-position player with one tiny bar).
          const widthPct = maxFrac > 0 ? Math.max(2, (frac / maxFrac) * 100) : 0
          const color = POS_COLORS[row.position] || '#6b7280'
          return (
            <div key={row.position} className="flex items-center gap-2">
              {/* Position badge */}
              <div
                className="shrink-0 w-9 h-7 rounded flex items-center justify-center text-white text-xs font-bold"
                style={{ backgroundColor: color }}
              >
                {row.position}
              </div>
              {/* Bar */}
              <div className="flex-1 relative h-7 bg-gray-50 rounded overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded"
                  style={{
                    width: `${widthPct}%`,
                    backgroundColor: color,
                    opacity: 0.18,
                    transition: 'width 0.5s ease',
                  }}
                />
                <div
                  className="absolute inset-y-0 left-0"
                  style={{
                    width: `${widthPct}%`,
                    borderLeft: `3px solid ${color}`,
                  }}
                />
                <div className="absolute inset-0 flex items-center justify-between px-2.5 text-[11px]">
                  <span className="font-semibold text-gray-700 tabular-nums">
                    {(frac * 100).toFixed(1)}%
                  </span>
                  <span className="text-gray-400 tabular-nums">{row.games}g</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}


// ── Game Log Tables ──────────────────────────────────────────

const BATTING_GAMELOG_COLS = [
  { key: 'game_date',  label: 'Date' },
  { key: 'opponent',   label: 'Opp' },
  { key: 'result',     label: 'Score' },
  { key: 'position',   label: 'Pos' },
  { key: 'ab',         label: 'AB' },
  { key: 'r',          label: 'R' },
  { key: 'h',          label: 'H' },
  { key: '2b',         label: '2B' },
  { key: '3b',         label: '3B' },
  { key: 'hr',         label: 'HR' },
  { key: 'rbi',        label: 'RBI' },
  { key: 'bb',         label: 'BB' },
  { key: 'k',          label: 'K' },
  { key: 'hbp',        label: 'HBP' },
  { key: 'sb',         label: 'SB' },
  { key: 'cs',         label: 'CS' },
  { key: 'sf',         label: 'SF' },
  { key: 'sh',         label: 'SH' },
]

const PITCHING_GAMELOG_COLS = [
  { key: 'game_date',  label: 'Date' },
  { key: 'opponent',   label: 'Opp' },
  { key: 'result',     label: 'Score' },
  { key: 'decision',   label: 'Dec' },
  { key: 'ip',         label: 'IP' },
  { key: 'h',          label: 'H' },
  { key: 'r',          label: 'R' },
  { key: 'er',         label: 'ER' },
  { key: 'bb',         label: 'BB' },
  { key: 'k',          label: 'K' },
  { key: 'hbp',        label: 'HBP' },
  { key: 'wp',         label: 'WP' },
  { key: 'bf',         label: 'BF' },
  { key: 'pitches',    label: 'NP' },
  { key: 'game_score', label: 'GSc' },
]

function formatDate(dateStr) {
  if (!dateStr) return '-'
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function GameLogTable({ title, logs, columns }) {
  if (!logs || logs.length === 0) return null

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3 sm:p-5 mb-4 sm:mb-6">
      <h3 className="text-xs sm:text-sm font-semibold text-gray-600 uppercase tracking-wider mb-2 sm:mb-3">
        {title}
      </h3>
      <div className="overflow-x-auto -mx-3 sm:mx-0 max-h-[500px] overflow-y-auto">
        <div className="min-w-[700px] px-3 sm:px-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white z-10">
                <tr className="border-b-2 border-nw-teal/30">
                  {columns.map(col => (
                    <th
                      key={col.key}
                      className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right first:text-left bg-white"
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.map((row, i) => {
                  const won = row.team_score > row.opp_score
                  const resultText = `${won ? 'W' : 'L'} ${row.team_score}-${row.opp_score}`

                  return (
                    <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                      {columns.map(col => {
                        let val
                        if (col.key === 'game_date') {
                          val = formatDate(row.game_date)
                        } else if (col.key === 'opponent') {
                          val = (
                            <span className="flex items-center gap-1">
                              {row.opponent_logo && (
                                <img
                                  src={row.opponent_logo}
                                  alt=""
                                  className="w-4 h-4 object-contain"
                                  onError={(e) => { e.target.style.display = 'none' }}
                                />
                              )}
                              <span>{row.opponent_short || '?'}</span>
                            </span>
                          )
                        } else if (col.key === 'result') {
                          val = (
                            <span className={won ? 'text-green-600 font-medium' : 'text-red-500 font-medium'}>
                              {resultText}
                            </span>
                          )
                        } else if (col.key === 'ip') {
                          val = row.ip != null ? row.ip.toFixed(1) : '-'
                        } else if (col.key === 'decision') {
                          val = row.decision || '-'
                        } else if (col.key === 'position') {
                          val = row.position || '-'
                        } else {
                          val = row[col.key] != null ? row[col.key] : '-'
                        }

                        return (
                          <td key={col.key} className="px-2 py-1.5 text-right first:text-left whitespace-nowrap">
                            {val}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}


// ── Home / Road Splits ────────────────────────────────────────

const BATTING_SPLIT_COLS = [
  { key: 'split',  label: 'Split' },
  { key: 'g',      label: 'G' },
  { key: 'pa',     label: 'PA' },
  { key: 'ab',     label: 'AB' },
  { key: 'h',      label: 'H' },
  { key: 'r',      label: 'R' },
  { key: 'rbi',    label: 'RBI' },
  { key: 'bb',     label: 'BB' },
  { key: 'k',      label: 'K' },
  { key: 'avg',    label: 'AVG' },
  { key: 'obp',    label: 'OBP' },
]

const PITCHING_SPLIT_COLS = [
  { key: 'split',     label: 'Split' },
  { key: 'g',         label: 'G' },
  { key: 'gs',        label: 'GS' },
  { key: 'w',         label: 'W' },
  { key: 'l',         label: 'L' },
  { key: 'sv',        label: 'SV' },
  { key: 'ip_display', label: 'IP' },
  { key: 'h',         label: 'H' },
  { key: 'er',        label: 'ER' },
  { key: 'bb',        label: 'BB' },
  { key: 'k',         label: 'K' },
  { key: 'hr',        label: 'HR' },
  { key: 'era',       label: 'ERA' },
  { key: 'whip',      label: 'WHIP' },
  { key: 'k_per_9',   label: 'K/9' },
  { key: 'bb_per_9',  label: 'BB/9' },
  { key: 'k_pct',     label: 'K%' },
  { key: 'bb_pct',    label: 'BB%' },
]

function formatSplitVal(val, key) {
  if (val == null) return '-'
  if (['avg', 'obp', 'slg', 'ops'].includes(key)) {
    return val >= 1 ? val.toFixed(3) : val.toFixed(3).replace(/^0/, '')
  }
  if (['era', 'whip', 'k_per_9', 'bb_per_9'].includes(key)) return val.toFixed(2)
  if (['k_pct', 'bb_pct'].includes(key)) return (val * 100).toFixed(1) + '%'
  if (key === 'ip_display') return val.toFixed(1)
  return val
}

function SplitsSection({ splits }) {
  if (!splits) return null
  const { batting, pitching } = splits
  if (!batting && !pitching) return null

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3 sm:p-5 mb-4 sm:mb-6">
      <h3 className="text-xs sm:text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">
        Home / Road Splits
      </h3>

      {batting && (batting.home.g > 0 || batting.away.g > 0) && (
        <div className="mb-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Batting</h4>
          <div className="overflow-x-auto -mx-3 sm:mx-0">
            <div className="min-w-[650px] px-3 sm:px-0">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-200">
                    {BATTING_SPLIT_COLS.map(col => (
                      <th key={col.key} className={`px-2 py-1.5 font-semibold text-gray-500 ${col.key === 'split' ? 'text-left' : 'text-right'}`}>
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { ...batting.home, split: 'Home' },
                    { ...batting.away, split: 'Road' },
                  ].map(row => (
                    <tr key={row.split} className="border-b border-gray-100 hover:bg-gray-50">
                      {BATTING_SPLIT_COLS.map(col => (
                        <td key={col.key} className={`px-2 py-1.5 ${col.key === 'split' ? 'text-left font-semibold text-gray-700' : 'text-right tabular-nums'}`}>
                          {col.key === 'split' ? row.split : formatSplitVal(row[col.key], col.key)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {pitching && (pitching.home.g > 0 || pitching.away.g > 0) && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Pitching</h4>
          <div className="overflow-x-auto -mx-3 sm:mx-0">
            <div className="min-w-[700px] px-3 sm:px-0">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-200">
                    {PITCHING_SPLIT_COLS.map(col => (
                      <th key={col.key} className={`px-2 py-1.5 font-semibold text-gray-500 ${col.key === 'split' ? 'text-left' : 'text-right'}`}>
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { ...pitching.home, split: 'Home' },
                    { ...pitching.away, split: 'Road' },
                  ].map(row => (
                    <tr key={row.split} className="border-b border-gray-100 hover:bg-gray-50">
                      {PITCHING_SPLIT_COLS.map(col => (
                        <td key={col.key} className={`px-2 py-1.5 ${col.key === 'split' ? 'text-left font-semibold text-gray-700' : 'text-right tabular-nums'}`}>
                          {col.key === 'split' ? row.split : formatSplitVal(row[col.key], col.key)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// ── Main Page ──────────────────────────────────────────────────

export default function PlayerDetail() {
  const { playerId } = useParams()
  const [percentileSeason, setPercentileSeason] = useState(null) // null = most recent (default)
  const [headshotError, setHeadshotError] = useState(false)
  const { data, loading, error } = usePlayer(playerId, percentileSeason)
  const { data: gameLogs } = usePlayerGameLogs(playerId, 2026)
  const { data: splits } = usePlayerSplits(playerId, 2026)

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

  const { player, batting_stats, pitching_stats, batting_percentiles, pitching_percentiles, percentile_season: activePercentileSeason, awards, career_rankings, pnw_rankings, position_breakdown, linked_players, summer_batting, summer_pitching } = data
  const isTransfer = linked_players && linked_players.length > 1
  const hasBatting = batting_stats && batting_stats.length > 0
  const hasPitching = pitching_stats && pitching_stats.length > 0
  const hasSummerBatting = summer_batting && summer_batting.length > 0
  const hasSummerPitching = summer_pitching && summer_pitching.length > 0
  const hasSummerStats = hasSummerBatting || hasSummerPitching
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
          {/* Player Headshot */}
          {player.headshot_url && !headshotError ? (
            <img
              src={player.headshot_url}
              alt={`${player.first_name} ${player.last_name}`}
              className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg object-cover border-2 border-gray-200 shrink-0"
              onError={() => setHeadshotError(true)}
            />
          ) : (
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg bg-gradient-to-br from-gray-200 to-gray-300 flex items-center justify-center shrink-0 border-2 border-gray-200">
              <span className="text-lg sm:text-xl font-bold text-gray-500">
                {(player.first_name?.[0] || '')}{(player.last_name?.[0] || '')}
              </span>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
                {player.first_name} {player.last_name}
                {player.jersey_number && (
                  <span className="text-gray-400 font-normal ml-2">#{player.jersey_number}</span>
                )}
              </h1>
              <FavoriteButton type="player" targetId={player.id} />
              <Link
                to={`/player-pages?id=${player.id}`}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-nw-teal bg-teal-50 hover:bg-teal-100 rounded transition-colors"
                title="View shareable player graphic"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 0 1 2-2h.93a2 2 0 0 0 1.664-.89l.812-1.22A2 2 0 0 1 10.07 4h3.86a2 2 0 0 1 1.664.89l.812 1.22A2 2 0 0 0 18.07 7H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z" />
                  <circle cx="12" cy="13" r="3" />
                </svg>
                Player Page
              </Link>
            </div>
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
              <div><span className="text-gray-400">B/T</span> <span className="font-medium">{player.bats || '-'}/{player.throws || '-'}</span></div>
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

          {/* Multi-school career path — inline in header (was a separate card) */}
          {isTransfer && (
            <div className="basis-full flex flex-wrap items-center gap-1.5 mt-2 text-xs text-gray-600">
              <span className="text-gray-400 mr-1">Career</span>
              {linked_players.map((lp, idx) => (
                <span key={lp.id} className="inline-flex items-center gap-1">
                  {idx > 0 && <span className="text-gray-300 mr-0.5">→</span>}
                  <Link
                    to={`/team/${lp.team_id}`}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-50 rounded border border-gray-200 hover:border-nw-teal hover:text-nw-teal transition-colors"
                  >
                    {lp.logo_url && (
                      <img src={lp.logo_url} alt="" className="w-3.5 h-3.5 object-contain"
                        loading="lazy" onError={(e) => { e.target.style.display = 'none' }} />
                    )}
                    <span className="font-medium">{lp.team_short}</span>
                    <span className={`px-1 py-0 rounded text-[9px] font-bold ${divisionBadgeClass(lp.division_level)}`}>
                      {lp.division_level}
                    </span>
                  </Link>
                </span>
              ))}
            </div>
          )}

          {/* Commitment status - NWAC/JUCO players only */}
          {player.division_level === 'JUCO' && (
            <div className="mt-2">
              {player.is_committed && player.committed_to ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-50 border border-green-200 text-sm font-semibold text-green-700">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                  Committed to {player.committed_to}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-gray-50 border border-gray-200 text-sm font-medium text-gray-500">
                  Uncommitted
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* (Multi-school career now lives in the player header above.
            Season filter is embedded inside the PercentileBars header below.) */}

      {/* Season filter chips — passed as an element to PercentileBars. */}
      {(() => {
        // Defined here so the JSX block below can hand it to PercentileBars.
        // We build the element once and pass to whichever PercentileBars
        // renders FIRST (batting if present, else pitching).
        return null
      })()}

      {/* ── Percentile Bars + Awards + Position ──
          For 2026, use the new metric set and a 2-column equal-height
          layout (bars on the left, awards + position on the right).
          Pre-2026: keep the legacy stacked full-width layout. */}
      {(() => {
        const isCurrent2026 = activePercentileSeason === '2026'
        const battingMetrics = isCurrent2026 ? BATTING_PERCENTILE_METRICS_2026 : BATTING_PERCENTILE_METRICS
        const pitchingMetrics = isCurrent2026 ? PITCHING_PERCENTILE_METRICS_2026 : PITCHING_PERCENTILE_METRICS
        const hasAwards = (awards && awards.length > 0)
                       || (career_rankings && career_rankings.length > 0)
                       || (pnw_rankings && pnw_rankings.length > 0)
        const hasPosition = position_breakdown && position_breakdown.length > 0
        const hasBars = (batting_percentiles && Object.keys(batting_percentiles).length > 0)
                     || (pitching_percentiles && Object.keys(pitching_percentiles).length > 0)

        // Season-filter chip group, embedded inside the bars header
        // (was a standalone row above the cards before).
        const seasonFilter = hasMultipleSeasons && (hasBatting || hasPitching) ? (
          <div className="flex items-center gap-1 flex-wrap">
            {allSeasons.map(season => (
              <button
                key={season}
                onClick={() => setPercentileSeason(
                  percentileSeason === String(season) ? null : String(season)
                )}
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold transition-all ${
                  (percentileSeason === String(season)) || (!percentileSeason && activePercentileSeason === String(season))
                    ? 'bg-nw-teal text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {season}
              </button>
            ))}
            <button
              onClick={() => setPercentileSeason(percentileSeason === 'career' ? null : 'career')}
              className={`px-2 py-0.5 rounded-full text-[10px] font-bold transition-all ${
                percentileSeason === 'career'
                  ? 'bg-nw-teal text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Career
            </button>
            {loading && (
              <div className="animate-spin h-3 w-3 border-2 border-nw-teal border-t-transparent rounded-full ml-1" />
            )}
          </div>
        ) : null

        // 2026 layout: bars + awards side-by-side, equal height
        if (isCurrent2026 && hasBars && (hasAwards || hasPosition)) {
          return (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6 items-stretch">
              {/* LEFT: percentile bars (one container, both batting + pitching inside) */}
              <div className="flex flex-col h-full">
                {batting_percentiles && Object.keys(batting_percentiles).length > 0 && (
                  <PercentileBars
                    percentiles={batting_percentiles}
                    metrics={battingMetrics}
                    title={`Batting · ${percentileLabel}`}
                    divisionLevel={player.division_level}
                    seasonFilter={seasonFilter}
                    fillHeight={!pitching_percentiles || Object.keys(pitching_percentiles || {}).length === 0}
                  />
                )}
                {pitching_percentiles && Object.keys(pitching_percentiles).length > 0 && (
                  <PercentileBars
                    percentiles={pitching_percentiles}
                    metrics={pitchingMetrics}
                    title={`Pitching · ${percentileLabel}`}
                    divisionLevel={player.division_level}
                    seasonFilter={!batting_percentiles || Object.keys(batting_percentiles || {}).length === 0 ? seasonFilter : null}
                    fillHeight={true}
                  />
                )}
              </div>

              {/* RIGHT: awards + position + glance + recent games.
                  CAPPED at left column height: min-h-0 + overflow-hidden
                  on the wrapper means the row's height is dictated by
                  the LEFT (bars) column. RecentGames is the bottom
                  card with flex-grow + internal scroll so it consumes
                  the remaining space (and excess games scroll instead
                  of pushing the row taller). */}
              <div className="flex flex-col h-full gap-4 min-h-0 overflow-hidden">
                {hasAwards && (
                  <TeamAwards
                    awards={awards || []}
                    careerRankings={career_rankings || []}
                    pnwRankings={pnw_rankings || []}
                    teamShort={player.team_short}
                  />
                )}
                {hasPosition && (
                  <PositionPieChart breakdown={position_breakdown} />
                )}
                <SeasonGlance
                  bat={batting_stats?.find(r => r.season === 2026)}
                  pit={pitching_stats?.find(r => r.season === 2026)}
                />
                <RecentGames
                  batting={gameLogs?.batting}
                  pitching={gameLogs?.pitching}
                  limit={20}
                  className="flex-grow min-h-0"
                />
              </div>
            </div>
          )
        }

        // Default: stack awards then bars full-width (legacy layout)
        return (
          <>
            {hasAwards && (
              <TeamAwards
                awards={awards || []}
                careerRankings={career_rankings || []}
                pnwRankings={pnw_rankings || []}
                teamShort={player.team_short}
              />
            )}
            {seasonFilter && (
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider mr-1">Rankings</span>
                {seasonFilter}
              </div>
            )}
            {batting_percentiles && Object.keys(batting_percentiles).length > 0 && (
              <PercentileBars
                percentiles={batting_percentiles}
                metrics={battingMetrics}
                title={`Batting · ${percentileLabel}`}
                divisionLevel={player.division_level}
              />
            )}
            {pitching_percentiles && Object.keys(pitching_percentiles).length > 0 && (
              <PercentileBars
                percentiles={pitching_percentiles}
                metrics={pitchingMetrics}
                title={`Pitching · ${percentileLabel}`}
                divisionLevel={player.division_level}
              />
            )}
          </>
        )
      })()}

      {/* ── Position Breakdown ──
          For 2026 the position chart now lives inside the awards
          column above. For pre-2026 seasons it stays as a standalone
          card here so historic profiles still show position usage. */}
      {activePercentileSeason !== '2026' && position_breakdown && position_breakdown.length > 0 && (
        <PositionPieChart breakdown={position_breakdown} />
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

      {/* ── Pitch-Level Stats (PBP-derived; auto-hides if no events) ── */}
      {hasBatting && <PitchLevelStatsCard playerId={playerId} season={2026} />}

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

      {/* ── Pitcher Pitch-Level Stats (PBP-derived; auto-hides if no events) ── */}
      {hasPitching && <PitcherPitchLevelStatsCard playerId={playerId} season={2026} />}

      {/* ── Summer Ball Stats ── */}
      {hasSummerStats && (
        <div className="bg-gradient-to-r from-amber-50 to-orange-50 rounded-lg shadow-sm border border-amber-200 p-3 sm:p-5 mb-4 sm:mb-6">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm sm:text-base font-bold text-amber-800 uppercase tracking-wider">
              Summer Ball
            </h3>
          </div>

          {hasSummerBatting && (
            <div className="mb-4">
              <h4 className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-2">Batting</h4>
              <div className="bg-white rounded-lg border border-amber-100 overflow-x-auto">
                <div className="min-w-[650px]">
                  <StatsTable rows={summer_batting} columns={SUMMER_BATTING_TABLE_COLS} />
                </div>
              </div>
            </div>
          )}

          {hasSummerPitching && (
            <div>
              <h4 className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-2">Pitching</h4>
              <div className="bg-white rounded-lg border border-amber-100 overflow-x-auto">
                <div className="min-w-[650px]">
                  <StatsTable rows={summer_pitching} columns={SUMMER_PITCHING_TABLE_COLS} />
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Game Logs ── */}
      {gameLogs?.batting?.length > 0 && gameLogs.batting.some(g => (g.ab || 0) + (g.bb || 0) + (g.hbp || 0) + (g.sf || 0) + (g.sh || 0) > 0) && (
        <GameLogTable
          title="Batting Game Log"
          logs={gameLogs.batting}
          columns={BATTING_GAMELOG_COLS}
        />
      )}
      {gameLogs?.pitching?.length > 0 && (
        <GameLogTable
          title="Pitching Game Log"
          logs={gameLogs.pitching}
          columns={PITCHING_GAMELOG_COLS}
        />
      )}

      {/* ── Empty state ── */}
      {!hasBatting && !hasPitching && (
        <div className="text-center py-12 text-gray-400">
          No stats recorded for this player yet.
        </div>
      )}

      <StatsLastUpdated className="mt-4" />
    </div>
  )
}
