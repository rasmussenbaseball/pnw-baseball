// PlayerProfilePitcher — pitcher profile in the same visual language as
// PlayerProfileHitter. Same shared primitives, pitching metrics. Props:
//   playerId, data (the /players/:id payload), sideToggle (two-way switch).

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { usePlayerGameLogs, usePlayerGooseEggs } from '../hooks/useApi'
import PitcherPitchLevelStatsCard from '../components/PitcherPitchLevelStatsCard'
import WpaByGameChart from '../components/WpaByGameChart'
import {
  usePlayerProfileTheme, formatPct,
  RadarChart, PercentilePanel, RollingLineChart, PerGameBarChart,
  SectionCard, SeasonStatTable, GameLogTable, CareerPath,
  ProfileShell, divisionBadge, ipToTrue,
} from '../components/playerProfile/shared'

// SEASON is derived from the `season` prop inside the component (the year
// selector / ?season= URL param), so the page can render any season.

// Right-panel percentile rows. Superset ordered best-first; the page
// filters to the keys the API actually returns for this player (PBP
// percentiles like Whiff%/Strike% only exist for some arms; classic
// rate stats are always there). Same defensive approach the standard
// page uses — we just render what's present.
const PCT_METRICS_ALL = [
  { key: 'pitching_war',           label: 'WAR',          fmt: 'war' },
  { key: 'k_pct',                  label: 'K%',           fmt: 'pct' },
  { key: 'bb_pct',                 label: 'BB%',          fmt: 'pct' },
  { key: 'fip',                    label: 'FIP',          fmt: 'era' },
  { key: 'siera',                  label: 'SIERA',        fmt: 'era' },
  { key: 'xfip',                   label: 'xFIP',         fmt: 'era' },
  { key: 'baa',                    label: 'BAA',          fmt: 'avg' },
  { key: 'strike_pct',             label: 'Strike%',      fmt: 'pct' },
  { key: 'first_pitch_strike_pct', label: 'FPS%',         fmt: 'pct' },
  { key: 'whiff_pct',              label: 'Whiff%',       fmt: 'pct' },
  { key: 'opp_woba',               label: 'opp wOBA',     fmt: 'avg' },
  { key: 'opp_air_pull_pct',       label: 'opp AIRPULL%', fmt: 'pct' },
  { key: 'hr_pa_pct',              label: 'HR/PA',        fmt: 'pct' },
  { key: 'wpa',                    label: 'WPA',          fmt: 'wpa' },
]
// Radar prefers stuff/command shape; falls back to whatever is present.
const RADAR_PREF = [
  { key: 'k_pct',      label: 'K%' },
  { key: 'whiff_pct',  label: 'Whiff%' },
  { key: 'strike_pct', label: 'Strike%' },
  { key: 'fip',        label: 'FIP' },
  { key: 'siera',      label: 'SIERA' },
  { key: 'bb_pct',     label: 'BB%' },
  { key: 'opp_woba',   label: 'opp wOBA' },
  { key: 'baa',        label: 'BAA' },
]
const TOOLTIPS = {
  WAR:        { what: 'Wins Above Replacement.', why: 'Single best one-number summary.', range: 'Poor <0.5 | Avg ~1.5 | Great 3.0+' },
  'K%':       { what: 'Strikeout rate (of batters faced).', why: 'Bat-missing ability.', range: 'Poor <18% | Avg ~22% | Great 30%+' },
  'BB%':      { what: 'Walk rate.', why: 'Command. Lower is better.', range: 'Poor >11% | Avg ~8% | Great <6%' },
  'K-BB%':    { what: 'Strikeout rate minus walk rate.', why: 'Best simple command-of-stuff number.', range: 'Poor <10% | Avg ~14% | Great 22%+' },
  FIP:        { what: 'Fielding Independent Pitching.', why: 'ERA estimator on K/BB/HR only.', range: 'Poor >5.50 | Avg ~4.50 | Great <3.50' },
  SIERA:      { what: 'Skill-Interactive ERA.', why: 'Adds batted-ball context to FIP.', range: 'Poor >5.00 | Avg ~4.20 | Great <3.40' },
  xFIP:       { what: 'Expected FIP (normalized HR rate).', why: 'Strips out HR/FB luck.', range: 'Poor >5.00 | Avg ~4.30 | Great <3.60' },
  BAA:        { what: 'Batting average against.', why: 'Raw contact suppression.', range: 'Poor >.290 | Avg ~.250 | Great <.215' },
  'HR/9':     { what: 'Home runs allowed per 9 IP.', why: 'Damage prevention.', range: 'Poor >1.3 | Avg ~0.9 | Great <0.5' },
  'H/9':      { what: 'Hits allowed per 9 IP.', why: 'Baserunner suppression.', range: 'Poor >9.5 | Avg ~8.5 | Great <7.0' },
  'LOB%':     { what: 'Left-on-base / strand rate.', why: 'Pitching out of trouble.', range: 'Poor <68% | Avg ~72% | Great 78%+' },
  'HR/PA':    { what: 'Home runs allowed per batter faced.', why: 'Damage prevention.', range: 'Poor >3.5% | Avg ~2.5% | Great <1.5%' },
  'opp wOBA': { what: 'Opponent wOBA allowed.', why: 'Overall contact quality allowed.', range: 'Poor >.360 | Avg ~.330 | Great <.290' },
  'Strike%':  { what: '% of pitches that are strikes.', why: 'Throwing strikes / efficiency.', range: 'Poor <60% | Avg ~63% | Great 67%+' },
  'FPS%':     { what: 'First-pitch strike rate.', why: 'Getting ahead in the count.', range: 'Poor <56% | Avg ~60% | Great 65%+' },
  'Whiff%':   { what: 'Swinging-strike rate per swing.', why: 'Pure swing-and-miss stuff.', range: 'Poor <18% | Avg ~24% | Great 32%+' },
  'opp AIRPULL%': { what: 'Opponent air-pull contact allowed.', why: 'Hard-contact prevention. Lower better.', range: 'Poor >18% | Avg ~16% | Great <12%' },
  WPA:        { what: 'Win Probability Added.', why: 'Context-dependent clutch value.', range: 'Poor <0 | Avg ~0 | Great +1.5+' },
}

const EXTENDED_PITCHING_COLS = [
  { key: 'season',          label: 'Year', fmt: 'raw', align: 'left' },
  { key: '_typeLabel',      label: 'Lvl',  fmt: 'raw', align: 'left' },
  { key: '_team',           label: 'Team', fmt: 'raw', align: 'left' },
  { key: 'wins',            label: 'W',   fmt: 'int' },
  { key: 'losses',          label: 'L',   fmt: 'int' },
  { key: 'saves',           label: 'SV',  fmt: 'int' },
  { key: 'games',           label: 'G',   fmt: 'int' },
  { key: 'games_started',   label: 'GS',  fmt: 'int' },
  { key: 'innings_pitched', label: 'IP',  fmt: 'ip' },
  { key: 'strikeouts',      label: 'K',   fmt: 'int' },
  { key: 'walks',           label: 'BB',  fmt: 'int' },
  { key: 'hits_allowed',    label: 'H',   fmt: 'int' },
  { key: 'earned_runs',     label: 'ER',  fmt: 'int' },
  { key: 'era',             label: 'ERA', fmt: 'era' },
  { key: 'whip',            label: 'WHIP',fmt: 'era' },
  { key: 'baa',             label: 'BAA', fmt: 'avg' },
  { key: 'fip',             label: 'FIP', fmt: 'era' },
  { key: 'k_pct',           label: 'K%',  fmt: 'pct' },
  { key: 'bb_pct',          label: 'BB%', fmt: 'pct' },
  { key: 'pitching_war',    label: 'WAR', fmt: 'war' },
]
// Summer (WCL/PIL) now carries the full advanced pitching line — FIP, K%,
// BB%, WAR, and BAA (computed from hits / AB-against) — so nothing is blanked.
const SUMMER_BLANK_COLS = new Set([])

const GAMELOG_PITCHING_COLS = [
  { key: '_date', label: 'Date', align: 'left' },
  { key: '_opp',  label: 'Opp',  align: 'left' },
  { key: 'decision', label: 'Dec', align: 'left' },
  { key: 'ip', label: 'IP', fmt: 'ip' },
  { key: 'h', label: 'H' }, { key: 'r', label: 'R' }, { key: 'er', label: 'ER' },
  { key: 'bb', label: 'BB' }, { key: 'k', label: 'K' }, { key: 'hr', label: 'HR' },
  { key: 'outing_grade', label: 'Grade' },
]

const fmtEra = v => (v == null ? '—' : Number(v).toFixed(2))
const CLASS_YEARS = { Fr: 'Freshman', So: 'Sophomore', Jr: 'Junior', Sr: 'Senior', Gr: 'Graduate' }
function fmtClassYear(y) {
  if (!y) return null
  const rs = y.startsWith('R-')
  const base = rs ? y.slice(2) : y
  const label = CLASS_YEARS[base] || base
  return rs ? `RS ${label}` : label
}
const fmtDate = d => { if (!d) return ''; const dt = new Date(d); return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}` }

// Game-score color tiers (higher is better for pitchers).
function gsColor(gs) {
  if (gs == null) return '#d4d4d4'
  if (gs >= 80) return '#b8302a'
  if (gs >= 65) return '#5b9d4d'
  if (gs >= 50) return '#c9a44c'
  if (gs >= 30) return '#9a9a9a'
  return '#5d99c6'
}

// trueIP → baseball notation string (e.g. 31.6667 → "31.2")
function ipNotation(trueIP) {
  const outs = Math.round(trueIP * 3)
  return `${Math.floor(outs / 3)}.${outs % 3}`
}

// 10-outing rolling FIP from pitching game logs. FIP needs a per-league
// constant; rather than guess it, we anchor to the player's authoritative
// season FIP — constant = seasonFIP − (season FIP-core rate). Each window's
// FIP = (windowed 13*HR + 3*(BB+HBP) − 2*K) / windowed IP + that constant.
function rollingFipSeries(games, seasonFip, window = 10) {
  const outings = games
    .map(g => ({
      ip: ipToTrue(g.ip),
      core: 13 * (g.hr || 0) + 3 * ((g.bb || 0) + (g.hbp || 0)) - 2 * (g.k || 0),
    }))
    .filter(o => o.ip > 0)
  if (!outings.length) return []
  const totIp = outings.reduce((s, o) => s + o.ip, 0)
  const totCore = outings.reduce((s, o) => s + o.core, 0)
  const seasonRaw = totIp > 0 ? totCore / totIp : 0
  const constant = (seasonFip != null ? seasonFip : 3.10) - seasonRaw
  const out = []
  for (let i = 0; i < outings.length; i++) {
    const slice = outings.slice(Math.max(0, i - window + 1), i + 1)
    const ip = slice.reduce((s, o) => s + o.ip, 0)
    const core = slice.reduce((s, o) => s + o.core, 0)
    out.push((ip > 0 ? core / ip : 0) + constant)
  }
  return out
}

// ───────────────────────────────────────────────────────────────
export default function PlayerProfilePitcher({ playerId, data, season = 2026, sideToggle = null, seasonSelector = null }) {
  const SEASON = season || 2026
  const T = usePlayerProfileTheme()
  const { data: gameLogs } = usePlayerGameLogs(playerId, SEASON)
  const { data: goose } = usePlayerGooseEggs(playerId, SEASON)

  const { player, pitching_stats, summer_pitching, pitching_percentiles, awards, pnw_rankings, current_summer_assignment } = data

  const springTagged = (pitching_stats || []).map(s => ({ ...s, _kind: 'spring', _typeLabel: s.division_level || 'College', _team: s.team_short || '—' }))
  const summerTagged = (summer_pitching || []).map(s => ({ ...s, _kind: 'summer', _typeLabel: s.league_abbrev || 'Summer', _team: s.team_name || '—' }))
  const allRows = [...springTagged, ...summerTagged].sort((a, b) => (a.season !== b.season ? a.season - b.season : (a._kind === 'spring' ? -1 : 1)))
  const springRows = springTagged.slice().sort((a, b) => a.season - b.season)

  // Career (spring only)
  const career = springRows.reduce((acc, s) => {
    acc.ip += ipToTrue(s.innings_pitched); acc.er += s.earned_runs || 0
    acc.k += s.strikeouts || 0; acc.bb += s.walks || 0; acc.h += s.hits_allowed || 0
    acc.w += s.wins || 0; acc.l += s.losses || 0; acc.sv += s.saves || 0
    return acc
  }, { ip: 0, er: 0, k: 0, bb: 0, h: 0, w: 0, l: 0, sv: 0 })
  const careerEra = career.ip > 0 ? (career.er * 9) / career.ip : 0
  const careerWhip = career.ip > 0 ? (career.bb + career.h) / career.ip : 0

  const currSeason = springRows.slice(-1)[0]
  const divLabel = currSeason?.division_level || player.division_level || 'LEAGUE'

  // Render only metrics the API actually returned (non-null percentile).
  const pctMetrics = PCT_METRICS_ALL.filter(m => pitching_percentiles?.[m.key]?.percentile != null)
  const radarStats = RADAR_PREF
    .filter(rk => pitching_percentiles?.[rk.key]?.percentile != null)
    .slice(0, 6)
    .map(rk => ({ label: rk.label, pct: pitching_percentiles[rk.key].percentile }))

  const pitchingGames = gameLogs?.pitching || []
  const seasonFip = currSeason?.fip
  const rolling = rollingFipSeries(pitchingGames, seasonFip, 10)
  const seasonEra = currSeason?.era
  // League FIP reference: prefer the authoritative run-environment value;
  // fall back to deriving from the player's FIP+ (lgFIP = FIP * FIP+/100).
  const lgFip = data?.league_context?.fip
    ?? (seasonFip != null && currSeason?.fip_plus != null ? +(seasonFip * currSeason.fip_plus / 100).toFixed(2) : null)

  // Per-outing grade chart inputs (0-100, role-normalized vs same role at level)
  const gsRows = pitchingGames.map(g => ({ g, val: g.outing_grade }))
  const withGs = gsRows.filter(r => r.val != null)
  const bestGs = withGs.reduce((acc, r) => r.val > (acc?.val ?? -1) ? r : acc, null)
  const mostK = pitchingGames.reduce((acc, g) => (g.k ?? 0) > (acc?.k ?? -1) ? g : acc, null)
  // Last-5-outing ERA
  const last5 = pitchingGames.slice(-5).map(g => ({ ip: ipToTrue(g.ip), er: g.er || 0 })).filter(o => o.ip > 0)
  const last5Ip = last5.reduce((s, o) => s + o.ip, 0)
  const last5Era = last5Ip > 0 ? (last5.reduce((s, o) => s + o.er, 0) * 9) / last5Ip : null

  const seasonRange = springRows.length ? `${springRows[0].season}${springRows.length > 1 ? `–${springRows[springRows.length - 1].season}` : ''}` : null
  const role = (currSeason?.games_started || 0) >= ((currSeason?.games || 0) - (currSeason?.games_started || 0)) && (currSeason?.games_started || 0) > 0 ? 'Starter' : 'Reliever'

  return (
    <ProfileShell>
      {(sideToggle || seasonSelector) && (
        <div className="flex items-center gap-2 flex-wrap mb-1">
          {sideToggle}
          {seasonSelector && <div className="ml-auto">{seasonSelector}</div>}
        </div>
      )}

      {/* Hero */}
      <div className="grid lg:grid-cols-[1.1fr_1fr] rounded-md overflow-hidden mb-4" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        {/* LEFT */}
        <div className="p-5 flex flex-col">
          <div className="relative h-20 -mx-5 -mt-5" style={{ background: 'linear-gradient(120deg, #14365c 0%, #1f5485 55%, #c9a44c 100%)' }}>
            <div className="absolute -bottom-7 left-[18px] w-[70px] h-[70px] rounded-full bg-gray-300 border-[3px] border-white flex items-center justify-center text-2xl font-bold text-gray-500 overflow-hidden">
              {player.headshot_url
                ? <img src={player.headshot_url} alt="" className="w-full h-full object-cover" />
                : <span>{player.first_name?.[0]}{player.last_name?.[0]}</span>}
            </div>
            {currSeason && (
              <div className="absolute top-2 right-2.5 rounded-md px-2.5 py-2 text-white" style={{ background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', border: '1px solid rgba(255,255,255,0.14)' }}>
                <div className="text-[8.5px] font-bold tracking-widest opacity-80 mb-1">{SEASON} ROLE</div>
                <div className="text-[13px] font-bold tracking-wide">{role}</div>
                <div className="text-[10px] opacity-90 mt-0.5 tabular-nums">{currSeason.games || 0} G · {currSeason.games_started || 0} GS · {currSeason.saves || 0} SV</div>
              </div>
            )}
          </div>

          <div className="mt-9">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h1 className="text-[22px] font-bold tracking-tight" style={{ color: T.text }}>{player.first_name} {player.last_name}</h1>
              {player.jersey_number && <span className="text-base font-bold" style={{ color: T.textMuted }}>#{player.jersey_number}</span>}
            </div>
            <div className="text-[13px] font-semibold mt-1" style={{ color: T.textMuted }}>
              {player.position} | <Link to={`/team/${player.team_id}`} className="hover:underline">{player.team_name}</Link>
              {fmtClassYear(player.year_in_school) && <> | {fmtClassYear(player.year_in_school)}</>}
            </div>
            <div className="text-[11px] mt-1.5 leading-relaxed" style={{ color: T.textMuted }}>
              Bats/Throws: {player.bats || '—'}/{player.throws || '—'} &nbsp;|&nbsp; {player.height || '—'} {player.weight ? `${player.weight} lbs` : ''}
              {player.hometown && <><br />From: {player.hometown}</>}
              {player.previous_school && <> &nbsp;|&nbsp; Prev: {player.previous_school}</>}
            </div>
            {current_summer_assignment && (
              <Link to={current_summer_assignment.summer_player_id ? `?summer=${current_summer_assignment.summer_player_id}` : `/summer/teams/${current_summer_assignment.team_id}`} className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-semibold bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/50">
                {current_summer_assignment.team_logo && <img src={current_summer_assignment.team_logo} alt="" className="w-4 h-4 object-contain" loading="lazy" />}
                Summer {SEASON}: {current_summer_assignment.team_short || current_summer_assignment.team_name}
                <span className="text-[10px] opacity-70">· {current_summer_assignment.league_abbrev}</span>
              </Link>
            )}

            {/* Radar + rolling ERA */}
            <div className="grid grid-cols-1 sm:grid-cols-[0.95fr_1.05fr] gap-3.5 items-stretch my-3 py-2 border-y" style={{ borderColor: T.border }}>
              <div className="flex flex-col min-w-0">
                <div className="text-[9.5px] font-bold tracking-widest uppercase text-center mb-0.5" style={{ color: T.textLight }}>Skill Profile</div>
                <div className="flex-1 max-w-[260px] mx-auto w-full"><RadarChart stats={radarStats} /></div>
              </div>
              <div className="flex flex-col min-w-0">
                <div className="flex items-center justify-center gap-2 mb-0.5">
                  <span className="text-[9.5px] font-bold tracking-widest uppercase" style={{ color: T.textLight }}>10-Game Rolling FIP</span>
                  {seasonFip != null && (
                    <span className="px-1.5 py-px rounded-md text-[9.5px] font-bold tabular-nums tracking-wide text-white" style={{ background: T.accent }}>SEASON {fmtEra(seasonFip)}</span>
                  )}
                </div>
                <div className="flex-1 max-w-[340px] mx-auto w-full">
                  <RollingLineChart
                    series={rolling}
                    floorZero
                    fmtTick={v => v.toFixed(2)}
                    refLines={[
                      ...(lgFip != null ? [{ v: lgFip, label: `LG ${fmtEra(lgFip)}`, color: T.poor }] : []),
                      ...(seasonFip != null ? [{ v: seasonFip, label: 'season', color: T.gold }] : []),
                    ]}
                    lineColor={T.accent}
                  />
                </div>
              </div>
            </div>

            {/* Year-by-year mini table */}
            <table className="w-full mt-2 text-[11px] border-collapse">
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {['Year', 'Lvl', 'Team', 'IP', 'ERA', 'WHIP', 'K', 'BB', 'FIP'].map(h => (
                    <th key={h} className={`px-1.5 py-1 font-bold tracking-wide ${h === 'Year' || h === 'Lvl' || h === 'Team' ? 'text-left' : 'text-right'}`} style={{ color: T.textLight }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allRows.map((s, i) => {
                  const isCurrent = s._kind === 'spring' && i === allRows.length - 1
                  const isSummer = s._kind === 'summer'
                  const rowStyle = isCurrent ? { background: T.highlight, borderTop: `1px solid ${T.borderStrong}` } : (isSummer ? { background: T.rowAlt } : {})
                  return (
                    <tr key={`${s.season}-${s._kind}-${s._team}-${i}`} className={`${isCurrent ? 'font-bold' : ''} ${isSummer ? 'italic' : ''}`} style={rowStyle}>
                      <td className="px-1.5 py-1 text-left" style={{ color: T.textMuted }}>{s.season}</td>
                      <td className="px-1.5 py-1 text-left" style={{ color: isSummer ? T.textLight : T.textMuted }}>{s._typeLabel}</td>
                      <td className="px-1.5 py-1 text-left" style={{ color: T.textMuted }}>{s._team}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{s.innings_pitched != null ? Number(s.innings_pitched).toFixed(1) : '—'}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{fmtEra(s.era)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{fmtEra(s.whip)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{s.strikeouts ?? '—'}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{s.walks ?? '—'}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{fmtEra(s.fip)}</td>
                    </tr>
                  )
                })}
                {springRows.length > 1 && (
                  <tr style={{ borderTop: `1px solid ${T.border}` }}>
                    <td className="px-1.5 py-1 text-left" style={{ color: T.textMuted }}>Career</td>
                    <td className="px-1.5 py-1 text-left" style={{ color: T.textLight }}>Spring</td>
                    <td className="px-1.5 py-1 text-left" style={{ color: T.textLight }}>—</td>
                    <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{ipNotation(career.ip)}</td>
                    <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{fmtEra(careerEra)}</td>
                    <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{fmtEra(careerWhip)}</td>
                    <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{career.k}</td>
                    <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{career.bb}</td>
                    <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>—</td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* Badges */}
            <div className="flex flex-wrap gap-1.5 mt-3">
              {(awards || []).map((a, i) => (
                <span key={i} className="text-[9.5px] font-bold tracking-wide px-2 py-[3px] rounded-full" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }}>
                  {a.category} leader · {a.season}
                </span>
              ))}
              {(pnw_rankings || []).slice(0, 3).map((r, i) => (
                <span key={i} className="text-[9.5px] font-bold tracking-wide px-2 py-[3px] rounded-full" style={{ background: '#dbeafe', color: '#1e40af', border: '1px solid #93c5fd' }}>
                  {r.rank}{r.rank === 1 ? 'st' : r.rank === 2 ? 'nd' : r.rank === 3 ? 'rd' : 'th'} PNW · {r.category}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT: percentiles */}
        <PercentilePanel title="Percentile Rankings" scopeLabel={`${SEASON} · VS ${divLabel}`} metrics={pctMetrics} percentiles={pitching_percentiles} tooltips={TOOLTIPS} />
      </div>

      <SectionCard title="Pitching Stats" right="BY SEASON">
        <SeasonStatTable cols={EXTENDED_PITCHING_COLS} rows={allRows} blankCols={SUMMER_BLANK_COLS} emptyMsg="No pitching stats." minWidth="780px" />
      </SectionCard>

      <SectionCard title="Pitch Level Stats" right={String(SEASON)}>
        <div className="-mx-2"><PitcherPitchLevelStatsCard playerId={playerId} season={SEASON} /></div>
      </SectionCard>

      <SectionCard title="WPA on the Mound" right={String(SEASON)}>
        <WpaByGameChart playerId={playerId} position="pitcher" />
      </SectionCard>

      {/* Goose Eggs — clutch relief, shown just before the box scores.
          Renders only for pitchers with relief appearances. */}
      <GooseEggCard goose={goose} T={T} season={SEASON} />

      <SectionCard title="Game Log" right={`${SEASON} SEASON`}>
        <GameLogTable cols={GAMELOG_PITCHING_COLS} games={pitchingGames} minWidth="760px" />
      </SectionCard>

      <div className="flex items-center gap-3 my-6">
        <span className="flex-1 h-px" style={{ background: T.borderStrong }} />
        <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: T.textLight }}>Extended Analytics</span>
        <span className="flex-1 h-px" style={{ background: T.borderStrong }} />
      </div>

      <SectionCard title="Per-Outing Grade" right={`${SEASON} · CHRONOLOGICAL`}>
        <p className="text-[11px] mb-3 leading-snug" style={{ color: T.textLight }}>
          Each outing graded 0 to 100 against other outings in the same role (starter or reliever)
          at this level. 50 is an average outing for the role, so starter and reliever grades are
          directly comparable.
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-2 mb-3 text-[11px]" style={{ color: T.textMuted }}>
          <div className="flex flex-col"><span className="text-[9.5px] uppercase tracking-wider" style={{ color: T.textLight }}>Season ERA</span><span className="text-base font-bold tabular-nums" style={{ color: T.text }}>{fmtEra(seasonEra)}</span></div>
          <div className="flex flex-col"><span className="text-[9.5px] uppercase tracking-wider" style={{ color: T.textLight }}>Last 5 Outings</span><span className="text-base font-bold tabular-nums" style={{ color: (last5Era != null && seasonEra != null && last5Era <= seasonEra) ? T.great : T.poor }}>{last5Era != null ? fmtEra(last5Era) : '—'}</span></div>
          {bestGs && <div className="flex flex-col"><span className="text-[9.5px] uppercase tracking-wider" style={{ color: T.textLight }}>Best Outing</span><span className="text-base font-bold tabular-nums" style={{ color: T.text }}>{fmtDate(bestGs.g.game_date)} · {bestGs.val} grade</span></div>}
          {mostK && <div className="flex flex-col"><span className="text-[9.5px] uppercase tracking-wider" style={{ color: T.textLight }}>Most K's</span><span className="text-base font-bold tabular-nums" style={{ color: T.text }}>{fmtDate(mostK.game_date)} · {mostK.k} K</span></div>}
        </div>
        <PerGameBarChart
          rows={gsRows}
          maxVal={100}
          yTicks={[25, 50, 75, 100]}
          fmtY={v => String(v)}
          refLines={[{ v: 50, label: '50 avg', color: T.poor }]}
          colorFn={gsColor}
          tooltipFn={(g, gs) => `${fmtDate(g.game_date)} ${g.home_away === '@' ? '@' : 'vs'} ${g.opponent_short}: ${g.ip != null ? Number(g.ip).toFixed(1) : '?'} IP, ${g.h ?? 0}H ${g.er ?? 0}ER ${g.k ?? 0}K ${g.bb ?? 0}BB · Grade ${gs ?? '—'}${g.is_starter ? ' (SP)' : ' (RP)'}${g.decision ? ` · ${g.decision}` : ''}`}
          legend={[
            { color: '#5d99c6', label: '<30' },
            { color: '#9a9a9a', label: '30–49' },
            { color: '#c9a44c', label: '50–64' },
            { color: '#5b9d4d', label: '65–79' },
            { color: '#b8302a', label: '80+' },
          ]}
          note="Each bar = 1 outing · 0-100 role-normalized grade · hover for line"
        />
      </SectionCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="rounded-md p-5" style={{ background: T.card, border: `1px solid ${T.border}` }}>
          <h2 className="font-bold text-[15px] mb-3 pb-1.5 border-b-2 flex items-center gap-2" style={{ color: T.text, borderColor: T.text }}>
            <span>Career Path</span><span className="ml-auto text-[11px] font-semibold tracking-widest" style={{ color: T.textLight }}>SCHOOLS</span>
          </h2>
          <CareerPath player={player} divisionBadge={divisionBadge(divLabel)} seasonRange={seasonRange} />
        </div>
        <div className="rounded-md p-5" style={{ background: T.card, border: `1px solid ${T.border}` }}>
          <h2 className="font-bold text-[15px] mb-3 pb-1.5 border-b-2 flex items-center gap-2" style={{ color: T.text, borderColor: T.text }}>
            <span>Statistically Similar Pitchers</span><span className="ml-auto text-[11px] font-semibold tracking-widest" style={{ color: T.textLight }}>{divLabel} · {SEASON}</span>
          </h2>
          <div className="text-[12px] py-4 text-center" style={{ color: T.textMuted }}>Similarity engine in development.</div>
        </div>
      </div>
    </ProfileShell>
  )
}


// ════════════════════════════════════════════
// GOOSE EGGS — clutch relief metric (PBP-derived)
// ════════════════════════════════════════════
function GooseInfoButton({ T }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative mb-3">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1.5 text-[11px] font-semibold hover:underline"
        style={{ color: T.textMuted }}
      >
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border text-[9px] font-bold"
          style={{ borderColor: T.border }}>i</span>
        What do these mean?
      </button>
      {open && (
        <div className="absolute z-30 left-0 mt-2 w-[min(460px,88vw)] rounded-lg p-3 text-[11px] leading-snug shadow-xl"
          style={{ background: T.card, border: `1px solid ${T.borderStrong}`, color: T.textMuted }}>
          <p className="mb-2" style={{ color: T.text }}>
            Goose Eggs reward clutch, scoreless relief. A "goose window" is any 7th inning or later
            where the pitcher's team is not trailing and the game is within 3 runs (or the tying run
            is on base or at the plate) when he enters.
          </p>
          <ul className="space-y-1">
            <li><b style={{ color: T.great }}>Goose Egg (GEG)</b> — a goose window where he allowed no runs and either finished the inning or escaped the jam he came into.</li>
            <li><b style={{ color: T.poor }}>Broken Egg (BRK)</b> — a goose window where a run scored during his stint.</li>
            <li><b style={{ color: T.text }}>Opportunities (OPP)</b> — total goose windows he pitched in.</li>
            <li><b style={{ color: T.text }}>Goose %</b> — GEG divided by (GEG + BRK), so it rewards quality, not just usage.</li>
          </ul>
        </div>
      )}
    </div>
  )
}

function GooseEggCard({ goose, T, season = 2026 }) {
  if (!goose || !goose.relief_app) return null
  const pct = goose.goose_pct != null ? `${Math.round(goose.goose_pct * 100)}%` : '—'
  const tiles = [
    { label: 'Goose Eggs', val: goose.geg, color: T.great },
    { label: 'Broken Eggs', val: goose.brk, color: T.poor },
    { label: 'Opportunities', val: goose.opp, color: T.text },
    { label: 'Goose %', val: pct, color: T.text },
  ]
  return (
    <SectionCard title="Goose Eggs" right={`${season} · RELIEF`}>
      <GooseInfoButton T={T} />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {tiles.map(t => (
          <div key={t.label} className="flex flex-col items-center justify-center rounded-md py-3 px-2"
            style={{ background: T.card, border: `1px solid ${T.border}` }}>
            <span className="text-xl font-bold tabular-nums" style={{ color: t.color }}>{t.val}</span>
            <span className="text-[9.5px] uppercase tracking-wider text-center mt-0.5" style={{ color: T.textLight }}>{t.label}</span>
          </div>
        ))}
      </div>
      <p className="text-[10px] mt-2" style={{ color: T.textLight }}>
        {goose.relief_app} relief appearances · {goose.relief_ip} relief IP · 7th inning or later
      </p>
    </SectionCard>
  )
}
