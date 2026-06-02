// SummerPlayerProfile — rich summer-league player profile in the same
// visual language as the spring PlayerProfileHitter / PlayerProfilePitcher.
//
// Summer players (WCL/PIL today) carry the full advanced stat line, so we
// can give them savant-style percentile bars, a skill radar, rolling and
// per-game charts, and pitch-level approach cards (the last only where we
// have tracked play-by-play, i.e. 2026 WCL). Pre-2026 summer has no PBP,
// so those cards/metrics gracefully hide, but everything derivable from
// season + box-score data still renders.
//
// Visual primitives are shared with the spring pages
// (components/playerProfile/shared.jsx); this file supplies summer data
// + summer-appropriate metric configs.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  usePlayerProfileTheme, formatPct, fmtCell,
  RadarChart, PercentilePanel, RollingLineChart, PerGameBarChart,
  SectionCard, SeasonStatTable, GameLogTable, ProfileShell, SideToggle,
} from '../components/playerProfile/shared'

// ── Percentile + radar configs (summer subset of the spring sets) ──
const BAT_PCT_METRICS = [
  { key: 'offensive_war', label: 'WAR',      fmt: 'war' },
  { key: 'wrc_plus',      label: 'wRC+',     fmt: 'int' },
  { key: 'woba',          label: 'wOBA',     fmt: 'avg' },
  { key: 'wobacon',       label: 'wOBACON',  fmt: 'avg' },
  { key: 'iso',           label: 'ISO',      fmt: 'avg' },
  { key: 'hr_pa_pct',     label: 'HR/PA',    fmt: 'pct' },
  { key: 'contact_pct',   label: 'Contact%', fmt: 'pct' },
  { key: 'k_pct',         label: 'K%',       fmt: 'pct' },
  { key: 'bb_pct',        label: 'BB%',      fmt: 'pct' },
  { key: 'sb_per_pa',     label: 'SB/PA',    fmt: 'pct' },
]
const BAT_RADAR = [
  { key: 'wrc_plus', label: 'wRC+' }, { key: 'iso', label: 'ISO' },
  { key: 'contact_pct', label: 'Contact%' }, { key: 'bb_pct', label: 'BB%' },
  { key: 'k_pct', label: 'K%' }, { key: 'woba', label: 'wOBA' },
]
const PIT_PCT_METRICS = [
  { key: 'pitching_war',           label: 'WAR',     fmt: 'war' },
  { key: 'k_pct',                  label: 'K%',      fmt: 'pct' },
  { key: 'bb_pct',                 label: 'BB%',     fmt: 'pct' },
  { key: 'fip',                    label: 'FIP',     fmt: 'era' },
  { key: 'siera',                  label: 'SIERA',   fmt: 'era' },
  { key: 'xfip',                   label: 'xFIP',    fmt: 'era' },
  { key: 'baa',                    label: 'BAA',     fmt: 'avg' },
  { key: 'strike_pct',             label: 'Strike%', fmt: 'pct' },
  { key: 'first_pitch_strike_pct', label: 'FPS%',    fmt: 'pct' },
  { key: 'whiff_pct',              label: 'Whiff%',  fmt: 'pct' },
  { key: 'hr_pa_pct',              label: 'HR/PA',   fmt: 'pct' },
]
const PIT_RADAR = [
  { key: 'k_pct', label: 'K%' }, { key: 'whiff_pct', label: 'Whiff%' },
  { key: 'strike_pct', label: 'Strike%' }, { key: 'fip', label: 'FIP' },
  { key: 'siera', label: 'SIERA' }, { key: 'bb_pct', label: 'BB%' },
  { key: 'baa', label: 'BAA' },
]
const TOOLTIPS = {
  WAR:        { what: 'Wins Above Replacement.', why: 'Single best one-number summary.', range: 'Poor <0.5 | Avg ~1.5 | Great 3.0+' },
  'wRC+':     { what: 'Weighted Runs Created Plus, 100 = league avg.', why: 'League adjusted offense.', range: 'Poor <85 | Avg ~100 | Great 130+' },
  wOBA:       { what: 'Weighted On-Base Average.', why: 'Better one-number offense than OBP/SLG.', range: 'Poor <.310 | Avg ~.340 | Great .420+' },
  wOBACON:    { what: 'wOBA on contact (balls in play).', why: 'Quality of contact.', range: 'Poor <.330 | Avg ~.380 | Great .450+' },
  ISO:        { what: 'Isolated Power. SLG minus AVG.', why: 'Pure extra-base power.', range: 'Poor <.120 | Avg ~.160 | Great .220+' },
  'HR/PA':    { what: 'Home runs per plate appearance.', why: 'Power frequency.', range: 'Poor <1% | Avg ~2.5% | Great 4%+' },
  'Contact%': { what: '% of swings that make contact.', why: 'Bat-to-ball skill (tracked PBP).', range: 'Poor <72% | Avg ~78% | Great 85%+' },
  'K%':       { what: 'Strikeout rate.', why: 'Lower is better.', range: 'Poor >25% | Avg ~20% | Great <15%' },
  'BB%':      { what: 'Walk rate.', why: 'Plate discipline.', range: 'Poor <6% | Avg ~9% | Great 13%+' },
  'SB/PA':    { what: 'Stolen-base attempts per PA.', why: 'Speed / aggression.', range: 'Poor 0% | Avg ~3% | Great 8%+' },
  FIP:        { what: 'Fielding Independent Pitching.', why: 'ERA estimator on K/BB/HR.', range: 'Poor >5.5 | Avg ~4.5 | Great <3.5' },
  SIERA:      { what: 'Skill-Interactive ERA.', why: 'Adds batted-ball context to FIP.', range: 'Poor >5.0 | Avg ~4.2 | Great <3.4' },
  xFIP:       { what: 'Expected FIP (normalized HR rate).', why: 'Strips HR/FB luck.', range: 'Poor >5.0 | Avg ~4.3 | Great <3.6' },
  BAA:        { what: 'Batting average against.', why: 'Contact suppression.', range: 'Poor >.290 | Avg ~.250 | Great <.215' },
  'Strike%':  { what: '% of pitches that are strikes (tracked PBP).', why: 'Filling up the zone.', range: 'Poor <60% | Avg ~63% | Great 67%+' },
  'FPS%':     { what: 'First-pitch strike rate (tracked PBP).', why: 'Getting ahead.', range: 'Poor <56% | Avg ~60% | Great 65%+' },
  'Whiff%':   { what: 'Swinging-strike rate per swing (tracked PBP).', why: 'Swing-and-miss stuff.', range: 'Poor <18% | Avg ~24% | Great 32%+' },
}

// ── Season-table column sets (summer column names) ─────────────────
const BAT_COLS = [
  { key: 'season', label: 'Year', fmt: 'raw', align: 'left' },
  { key: 'games', label: 'G', fmt: 'int' }, { key: 'plate_appearances', label: 'PA', fmt: 'int' },
  { key: 'at_bats', label: 'AB', fmt: 'int' }, { key: 'hits', label: 'H', fmt: 'int' },
  { key: 'doubles', label: '2B', fmt: 'int' }, { key: 'triples', label: '3B', fmt: 'int' },
  { key: 'home_runs', label: 'HR', fmt: 'int' }, { key: 'runs', label: 'R', fmt: 'int' },
  { key: 'rbi', label: 'RBI', fmt: 'int' }, { key: 'walks', label: 'BB', fmt: 'int' },
  { key: 'strikeouts', label: 'K', fmt: 'int' }, { key: 'stolen_bases', label: 'SB', fmt: 'int' },
  { key: 'batting_avg', label: 'AVG', fmt: 'avg' }, { key: 'on_base_pct', label: 'OBP', fmt: 'avg' },
  { key: 'slugging_pct', label: 'SLG', fmt: 'avg' }, { key: 'ops', label: 'OPS', fmt: 'avg' },
  { key: 'woba', label: 'wOBA', fmt: 'avg' }, { key: 'wrc_plus', label: 'wRC+', fmt: 'int' },
  { key: 'iso', label: 'ISO', fmt: 'avg' }, { key: 'bb_pct', label: 'BB%', fmt: 'pct' },
  { key: 'k_pct', label: 'K%', fmt: 'pct' }, { key: 'offensive_war', label: 'oWAR', fmt: 'war' },
]
const PIT_COLS = [
  { key: 'season', label: 'Year', fmt: 'raw', align: 'left' },
  { key: 'wins', label: 'W', fmt: 'int' }, { key: 'losses', label: 'L', fmt: 'int' },
  { key: 'saves', label: 'SV', fmt: 'int' }, { key: 'games', label: 'G', fmt: 'int' },
  { key: 'games_started', label: 'GS', fmt: 'int' }, { key: 'innings_pitched', label: 'IP', fmt: 'ip' },
  { key: 'strikeouts', label: 'K', fmt: 'int' }, { key: 'walks', label: 'BB', fmt: 'int' },
  { key: 'hits_allowed', label: 'H', fmt: 'int' }, { key: 'earned_runs', label: 'ER', fmt: 'int' },
  { key: 'era', label: 'ERA', fmt: 'era' }, { key: 'whip', label: 'WHIP', fmt: 'era' },
  { key: 'baa', label: 'BAA', fmt: 'avg' }, { key: 'fip', label: 'FIP', fmt: 'era' },
  { key: 'fip_plus', label: 'FIP+', fmt: 'int' }, { key: 'era_plus', label: 'ERA+', fmt: 'int' },
  { key: 'xfip', label: 'xFIP', fmt: 'era' }, { key: 'siera', label: 'SIERA', fmt: 'era' },
  { key: 'lob_pct', label: 'LOB%', fmt: 'pct' }, { key: 'k_pct', label: 'K%', fmt: 'pct' },
  { key: 'bb_pct', label: 'BB%', fmt: 'pct' }, { key: 'pitching_war', label: 'WAR', fmt: 'war' },
]
const BAT_GAMELOG = [
  { key: '_date', label: 'Date', align: 'left' }, { key: '_opp', label: 'Opp', align: 'left' },
  { key: 'ab', label: 'AB' }, { key: 'r', label: 'R' }, { key: 'h', label: 'H' },
  { key: '2b', label: '2B' }, { key: '3b', label: '3B' }, { key: 'hr', label: 'HR' },
  { key: 'rbi', label: 'RBI' }, { key: 'bb', label: 'BB' }, { key: 'so', label: 'K' }, { key: 'sb', label: 'SB' },
]
const PIT_GAMELOG = [
  { key: '_date', label: 'Date', align: 'left' }, { key: '_opp', label: 'Opp', align: 'left' },
  { key: 'decision', label: 'Dec', align: 'left' }, { key: 'ip', label: 'IP', fmt: 'ip' },
  { key: 'h', label: 'H' }, { key: 'r', label: 'R' }, { key: 'er', label: 'ER' },
  { key: 'bb', label: 'BB' }, { key: 'so', label: 'K' }, { key: 'hr', label: 'HR' },
]

const FIELD_COLS_BASE = [
  { key: 'season', label: 'Year', align: 'left', fmt: 'raw' },
  { key: 'position', label: 'Pos', align: 'left', fmt: 'raw' },
  { key: 'games', label: 'G', fmt: 'int' }, { key: 'total_chances', label: 'TC', fmt: 'int' },
  { key: 'putouts', label: 'PO', fmt: 'int' }, { key: 'assists', label: 'A', fmt: 'int' },
  { key: 'errors', label: 'E', fmt: 'int' }, { key: 'double_plays', label: 'DP', fmt: 'int' },
  { key: 'fielding_pct', label: 'FldPct', fmt: 'avg' },
]
const FIELD_COLS_CATCHER = [
  { key: 'passed_balls', label: 'PB', fmt: 'int' },
  { key: 'stolen_bases_against', label: 'SBA', fmt: 'int' },
  { key: 'caught_stealing_by', label: 'CS', fmt: 'int' },
  { key: 'cs_pct', label: 'CS%', fmt: 'pctRaw' },
]

// ── Per-game helpers ───────────────────────────────────────────────
const WOBA_W = { bb: 0.69, hbp: 0.72, h1b: 0.88, h2b: 1.247, h3b: 1.578, hr: 2.031 }
function gameWoba(g) {
  const ab = g.ab || 0, bb = g.bb || 0, hbp = g.hbp || 0, sf = g.sf || 0
  const h = g.h || 0, d = g['2b'] || 0, t = g['3b'] || 0, hr = g.hr || 0
  const s = Math.max(0, h - d - t - hr)
  const den = ab + bb + sf + hbp
  if (den <= 0) return null
  return (WOBA_W.bb * bb + WOBA_W.hbp * hbp + WOBA_W.h1b * s + WOBA_W.h2b * d + WOBA_W.h3b * t + WOBA_W.hr * hr) / den
}
function rollingWoba(games, window = 10) {
  const ws = games.map(gameWoba).filter(w => w != null)
  const out = []
  for (let i = 0; i < ws.length; i++) {
    const slice = ws.slice(Math.max(0, i - window + 1), i + 1)
    out.push(slice.reduce((s, x) => s + x, 0) / slice.length)
  }
  return out
}
function gameOps(g) {
  const ab = g.ab || 0, bb = g.bb || 0, h = g.h || 0
  const d = g['2b'] || 0, t = g['3b'] || 0, hr = g.hr || 0
  const tb = h + d + 2 * t + 3 * hr
  const pa = ab + bb
  if (pa <= 0) return null
  return (h + bb) / pa + (ab > 0 ? tb / ab : 0)
}
function opsColor(ops) {
  if (ops == null) return '#d4d4d4'
  if (ops >= 1.300) return '#b8302a'
  if (ops >= 1.000) return '#5b9d4d'
  if (ops >= 0.800) return '#c9a44c'
  if (ops >= 0.500) return '#9a9a9a'
  return '#5d99c6'
}
// Convert baseball-notation IP (6.2 = 6 and 2/3) to true innings.
function ipToTrue(ip) {
  if (ip == null) return 0
  const whole = Math.floor(ip)
  const frac = Math.round((ip - whole) * 10)
  return whole + (frac >= 1 ? frac / 3 : 0)
}
// 10-outing rolling FIP, anchored to season FIP so the constant matches.
function rollingFip(games, seasonFip, window = 10) {
  const outings = games
    .map(g => ({ ip: ipToTrue(g.ip), core: 13 * (g.hr || 0) + 3 * ((g.bb || 0) + (g.hbp || 0)) - 2 * (g.so || 0) }))
    .filter(o => o.ip > 0)
  if (!outings.length) return []
  const totIp = outings.reduce((s, o) => s + o.ip, 0)
  const totCore = outings.reduce((s, o) => s + o.core, 0)
  const seasonRaw = totIp > 0 ? totCore / totIp : 0
  const constant = (seasonFip != null ? Number(seasonFip) : 3.40) - seasonRaw
  const out = []
  for (let i = 0; i < outings.length; i++) {
    const slice = outings.slice(Math.max(0, i - window + 1), i + 1)
    const ip = slice.reduce((s, o) => s + o.ip, 0)
    const core = slice.reduce((s, o) => s + o.core, 0)
    out.push((ip > 0 ? core / ip : 0) + constant)
  }
  return out
}
const fmtOps = v => v == null ? '—' : v.toFixed(3).replace(/^0/, '')
const fmtEra = v => v == null ? '—' : Number(v).toFixed(2)
const fmtDate = d => { if (!d) return ''; const dt = new Date(d); return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}` }
const CLASS_YEARS = { Fr: 'Freshman', So: 'Sophomore', Jr: 'Junior', Sr: 'Senior', Gr: 'Graduate' }
function fmtClassYear(y) {
  if (!y) return null
  const rs = y.startsWith('R-')
  const base = rs ? y.slice(2) : y
  const label = CLASS_YEARS[base] || base
  return rs ? `RS ${label}` : label
}

// Tag a per-game row with home/away + opponent so it works with the
// shared GameLogTable / PerGameBarChart (which read home_away + opponent_short).
function tagGame(g, teamId) {
  const isHome = g.home_team_id === teamId
  return {
    ...g,
    home_away: isHome ? 'vs' : '@',
    opponent_short: (isHome ? g.away_team_name : g.home_team_name) || '?',
  }
}

// ── Shared hero shell (banner + bio + spring link) ─────────────────
function SummerHero({ player, springLink, season, contextBox, children, rightPanel }) {
  const T = usePlayerProfileTheme()
  return (
    <div className="grid lg:grid-cols-[1.1fr_1fr] rounded-md overflow-hidden mb-4" style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <div className="p-5 flex flex-col">
        <div className="relative h-20 -mx-5 -mt-5" style={{ background: 'linear-gradient(120deg, #14365c 0%, #1f5485 55%, #c9a44c 100%)' }}>
          <div className="absolute -bottom-7 left-[18px] w-[70px] h-[70px] rounded-full bg-gray-300 border-[3px] border-white flex items-center justify-center text-2xl font-bold text-gray-500 overflow-hidden">
            <span>{player.first_name?.[0]}{player.last_name?.[0]}</span>
          </div>
          {contextBox}
        </div>

        <div className="mt-9">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h1 className="text-[22px] font-bold tracking-tight" style={{ color: T.text }}>{player.first_name} {player.last_name}</h1>
            {player.jersey_number && <span className="text-base font-bold" style={{ color: T.textMuted }}>#{player.jersey_number}</span>}
            <span className="px-2 py-0.5 rounded text-[10px] font-bold tracking-wide bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">{player.league_abbr}</span>
          </div>
          <div className="text-[13px] font-semibold mt-1 flex items-center gap-1.5 flex-wrap" style={{ color: T.textMuted }}>
            {player.position && <span>{player.position} |</span>}
            <Link to={`/summer/teams/${player.team_id}`} className="hover:underline inline-flex items-center gap-1">
              {player.team_logo && <img src={player.team_logo} alt="" className="w-4 h-4 object-contain" loading="lazy" />}
              {player.team_short || player.team_name}
            </Link>
            {fmtClassYear(player.year_in_school) && <> | {fmtClassYear(player.year_in_school)}</>}
          </div>
          <div className="text-[11px] mt-1.5 leading-relaxed" style={{ color: T.textMuted }}>
            Bats/Throws: {player.bats || '—'}/{player.throws || '—'}
            {player.college && <> &nbsp;|&nbsp; College: <span className="font-semibold" style={{ color: T.text }}>{player.college}</span></>}
            {player.hometown && <><br />From: {player.hometown}</>}
          </div>
          {springLink && (
            <Link
              to={`/player/${springLink.spring_player_id}`}
              className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-semibold bg-teal-50 dark:bg-teal-900/30 text-teal-800 dark:text-teal-200 hover:bg-teal-100 dark:hover:bg-teal-900/50">
              {springLink.spring_team_logo && <img src={springLink.spring_team_logo} alt="" className="w-4 h-4 object-contain" loading="lazy" />}
              View college profile: {springLink.spring_first} {springLink.spring_last}
              {springLink.spring_team_short && <span className="opacity-70"> · {springLink.spring_team_short}</span>}
            </Link>
          )}

          {children}
        </div>
      </div>
      {rightPanel}
    </div>
  )
}

// Year-by-year mini table inside the hero (compact).
function MiniTable({ rows, cols }) {
  const T = usePlayerProfileTheme()
  return (
    <table className="w-full mt-2 text-[11px] border-collapse">
      <thead>
        <tr style={{ borderBottom: `1px solid ${T.border}` }}>
          {cols.map(c => (
            <th key={c.label} className={`px-1.5 py-1 font-bold tracking-wide ${c.align === 'left' ? 'text-left' : 'text-right'}`} style={{ color: T.textLight }}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((s, i) => {
          const isCurrent = i === rows.length - 1
          return (
            <tr key={s.season + '-' + i} className={isCurrent ? 'font-bold' : ''} style={isCurrent ? { background: T.highlight, borderTop: `1px solid ${T.borderStrong}` } : {}}>
              {cols.map(c => (
                <td key={c.label} className={`px-1.5 py-1 tabular-nums ${c.align === 'left' ? 'text-left' : 'text-right'}`} style={{ color: c.align === 'left' ? T.textMuted : T.text }}>
                  {c.render ? c.render(s) : fmtCell(c.fmt, s[c.key])}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// Compact season rate-stat tiles — shown in the hero's chart slot when a
// season predates our per-game tracking (so the panel stays full instead
// of an empty "not enough games" placeholder).
function StatTiles({ tiles }) {
  const T = usePlayerProfileTheme()
  return (
    <div className="grid grid-cols-3 gap-2 w-full self-center">
      {tiles.map(([label, val]) => (
        <div key={label} className="rounded py-2.5 text-center" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
          <div className="text-[15px] font-bold tabular-nums" style={{ color: T.text }}>{val}</div>
          <div className="text-[9px] uppercase tracking-wide mt-0.5" style={{ color: T.textMuted }}>{label}</div>
        </div>
      ))}
    </div>
  )
}

function ApproachCard({ approach, kind }) {
  const T = usePlayerProfileTheme()
  if (!approach) return null
  const tiles = kind === 'pitcher'
    ? [['Strike%', approach.strike_pct], ['Whiff%', approach.whiff_pct], ['1st-Pitch K%', approach.first_pitch_strike_pct], ['K%', approach.k_pct], ['BB%', approach.bb_pct]]
    : [['Swing%', approach.swing_pct], ['Contact%', approach.contact_pct], ['Whiff%', approach.whiff_pct], ['1st-Pitch Sw%', approach.first_pitch_swing_pct], ['K%', approach.k_pct], ['BB%', approach.bb_pct]]
  return (
    <SectionCard title="Pitch Level Stats" right={`${approach.season} · PLAY-BY-PLAY`}>
      <div className="text-[11px] mb-2" style={{ color: T.textLight }}>
        From tracked WCL play-by-play · {approach.pa} {kind === 'pitcher' ? 'batters faced' : 'PA'}, {approach.pitches_seen} pitches seen
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {tiles.map(([label, val]) => (
          <div key={label} className="rounded py-2 text-center" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
            <div className="text-base sm:text-lg font-bold tabular-nums" style={{ color: T.text }}>{val == null ? '—' : `${(val * 100).toFixed(1)}%`}</div>
            <div className="text-[10px] uppercase tracking-wide mt-0.5 leading-tight" style={{ color: T.textMuted }}>{label}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px]" style={{ color: T.textLight }}>
        {kind === 'pitcher'
          ? 'Strike = called + swinging + foul + ball in play. Whiff = swinging strikes per swing. Samples are small early in the season.'
          : 'Swing = whiff + foul + ball in play; contact excludes whiffs. Samples are small early in the season.'}
      </p>
    </SectionCard>
  )
}

function FieldingCard({ rows }) {
  const T = usePlayerProfileTheme()
  if (!rows || !rows.length) return null
  const hasCatcher = rows.some(r => r.position === 'C')
  const cols = hasCatcher ? [...FIELD_COLS_BASE, ...FIELD_COLS_CATCHER] : FIELD_COLS_BASE
  const sorted = rows.slice().sort((a, b) => (b.season - a.season) || ((b.games || 0) - (a.games || 0)))
  return (
    <SectionCard title="Defensive Stats" right="BY POSITION">
      <div className="overflow-x-auto -mx-3 sm:mx-0">
        <div className="min-w-[640px] px-3 sm:px-0">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {cols.map(c => <th key={c.key} className={`px-1.5 py-1.5 font-bold tracking-wide ${c.align === 'left' ? 'text-left' : 'text-right'}`} style={{ color: T.textLight }}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.season + '-' + r.position + '-' + i} style={{ borderBottom: `1px solid ${T.rowBorder}` }}>
                  {cols.map(c => <td key={c.key} className={`px-1.5 py-1.5 tabular-nums ${c.align === 'left' ? 'text-left font-semibold' : 'text-right'}`} style={{ color: T.text }}>{fmtCell(c.fmt, r[c.key])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </SectionCard>
  )
}

// ════════════════════════════════════════════════════════════════
// HITTER
// ════════════════════════════════════════════════════════════════
function SummerHitterProfile({ data, season }) {
  const T = usePlayerProfileTheme()
  const { player, batting, fielding, game_batting, spring_link, approach, batting_percentiles } = data

  const rows = (batting || []).slice().sort((a, b) => a.season - b.season)
  const pct = batting_percentiles || {}
  const radarStats = BAT_RADAR.filter(rk => pct?.[rk.key]?.percentile != null).map(rk => ({ label: rk.label, pct: pct[rk.key].percentile }))
  const seasonRow = rows.find(r => r.season === season) || rows.slice(-1)[0]
  const seasonWoba = seasonRow?.woba != null ? Number(seasonRow.woba) : null
  const lgWoba = pct?.woba?.league_avg

  const games = (game_batting || []).map(g => tagGame(g, player.team_id))
  const rolling = rollingWoba(games, 10)
  const opsRows = games.map(g => ({ g, val: gameOps(g) }))
  const withOps = opsRows.filter(r => r.val != null)
  const seasonOps = withOps.length ? withOps.reduce((s, r) => s + r.val, 0) / withOps.length : 0
  const last5 = withOps.slice(-5)
  const last5Ops = last5.length ? last5.reduce((s, r) => s + r.val, 0) / last5.length : 0
  const best = withOps.reduce((acc, r) => r.val > (acc?.val ?? -1) ? r : acc, null)

  const miniCols = [
    { label: 'Year', align: 'left', render: s => s.season },
    { label: 'PA', render: s => s.plate_appearances ?? '—' },
    { label: 'AVG', render: s => s.batting_avg != null ? formatPct('avg', s.batting_avg) : '—' },
    { label: 'OBP', render: s => s.on_base_pct != null ? formatPct('avg', s.on_base_pct) : '—' },
    { label: 'SLG', render: s => s.slugging_pct != null ? formatPct('avg', s.slugging_pct) : '—' },
    { label: 'HR', render: s => s.home_runs ?? '—' },
    { label: 'wRC+', render: s => s.wrc_plus != null ? Math.round(s.wrc_plus) : '—' },
  ]

  return (
    <>
      <SummerHero
        player={player} springLink={spring_link} season={season}
        contextBox={seasonRow && (
          <div className="absolute top-2 right-2.5 rounded-md px-2.5 py-2 text-white" style={{ background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', border: '1px solid rgba(255,255,255,0.14)' }}>
            <div className="text-[8.5px] font-bold tracking-widest opacity-80 mb-1">{season} HITTING</div>
            <div className="text-[13px] font-bold tabular-nums">{seasonRow.ops != null ? formatPct('avg', seasonRow.ops) : '—'} OPS</div>
            <div className="text-[10px] opacity-90 mt-0.5 tabular-nums">{seasonRow.home_runs || 0} HR · {seasonRow.rbi || 0} RBI · {seasonRow.stolen_bases || 0} SB</div>
          </div>
        )}
        rightPanel={<PercentilePanel title="Percentile Rankings" scopeLabel={`${season} · VS ${player.league_abbr}`} metrics={BAT_PCT_METRICS.filter(m => pct?.[m.key]?.percentile != null)} percentiles={pct} tooltips={TOOLTIPS} />}
      >
        <div className="grid grid-cols-1 sm:grid-cols-[0.95fr_1.05fr] gap-3.5 items-stretch my-3 py-2 border-y" style={{ borderColor: T.border }}>
          <div className="flex flex-col min-w-0">
            <div className="text-[9.5px] font-bold tracking-widest uppercase text-center mb-0.5" style={{ color: T.textLight }}>Skill Profile</div>
            <div className="flex-1 max-w-[260px] mx-auto w-full">
              {radarStats.length >= 3 ? <RadarChart stats={radarStats} /> : <div className="text-[11px] text-center py-8" style={{ color: T.textMuted }}>Not enough qualified peers for percentiles yet</div>}
            </div>
          </div>
          <div className="flex flex-col min-w-0">
            <div className="flex items-center justify-center gap-2 mb-0.5">
              <span className="text-[9.5px] font-bold tracking-widest uppercase" style={{ color: T.textLight }}>{rolling.length >= 2 ? '10-Game Rolling wOBA' : `${season} Rate Stats`}</span>
              {seasonWoba != null && <span className="px-1.5 py-px rounded-md text-[9.5px] font-bold tabular-nums tracking-wide text-white" style={{ background: T.great }}>SEASON {formatPct('avg', seasonWoba)}</span>}
            </div>
            <div className="flex-1 max-w-[340px] mx-auto w-full flex">
              {rolling.length >= 2
                ? <RollingLineChart series={rolling} floorZero fmtTick={v => `.${Math.round(v * 1000)}`}
                    refLines={[
                      ...(lgWoba != null ? [{ v: lgWoba, label: `LG ${formatPct('avg', lgWoba)}`, color: T.poor }] : []),
                      ...(seasonWoba != null ? [{ v: seasonWoba, label: 'season', color: T.gold }] : []),
                    ]} lineColor={T.great} />
                : <StatTiles tiles={[
                    ['AVG', seasonRow?.batting_avg != null ? formatPct('avg', seasonRow.batting_avg) : '—'],
                    ['OBP', seasonRow?.on_base_pct != null ? formatPct('avg', seasonRow.on_base_pct) : '—'],
                    ['SLG', seasonRow?.slugging_pct != null ? formatPct('avg', seasonRow.slugging_pct) : '—'],
                    ['OPS', seasonRow?.ops != null ? formatPct('avg', seasonRow.ops) : '—'],
                    ['wOBA', seasonRow?.woba != null ? formatPct('avg', seasonRow.woba) : '—'],
                    ['wRC+', seasonRow?.wrc_plus != null ? Math.round(seasonRow.wrc_plus) : '—'],
                  ]} />}
            </div>
          </div>
        </div>
        <MiniTable rows={rows} cols={miniCols} />
      </SummerHero>

      <SectionCard title="Batting Stats" right="BY SEASON">
        <SeasonStatTable cols={BAT_COLS} rows={rows.map(r => ({ ...r, _kind: 'spring' }))} blankCols={new Set([])} emptyMsg="No batting stats." />
      </SectionCard>

      <ApproachCard approach={approach} kind="hitter" />
      <FieldingCard rows={fielding} />

      <SectionCard title="Game Log" right={`${season} SEASON`}>
        <GameLogTable cols={BAT_GAMELOG} games={games} emptyMsg="No games tracked this season yet." />
      </SectionCard>

      <div className="flex items-center gap-3 my-6">
        <span className="flex-1 h-px" style={{ background: T.borderStrong }} />
        <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: T.textLight }}>Extended Analytics</span>
        <span className="flex-1 h-px" style={{ background: T.borderStrong }} />
      </div>

      {withOps.length > 1 && (
        <SectionCard title="Per-Game OPS" right={`${season} · CHRONOLOGICAL`}>
          <div className="flex flex-wrap gap-x-6 gap-y-2 mb-3 text-[11px]" style={{ color: T.textMuted }}>
            <div className="flex flex-col"><span className="text-[9.5px] uppercase tracking-wider" style={{ color: T.textLight }}>Season OPS</span><span className="text-base font-bold tabular-nums" style={{ color: T.text }}>{fmtOps(seasonOps)}</span></div>
            <div className="flex flex-col"><span className="text-[9.5px] uppercase tracking-wider" style={{ color: T.textLight }}>Last 5 Games</span><span className="text-base font-bold tabular-nums" style={{ color: last5Ops >= seasonOps ? T.great : T.poor }}>{fmtOps(last5Ops)}</span></div>
            {best && <div className="flex flex-col"><span className="text-[9.5px] uppercase tracking-wider" style={{ color: T.textLight }}>Best Game</span><span className="text-base font-bold tabular-nums" style={{ color: T.text }}>{fmtDate(best.g.game_date)} · {fmtOps(best.val)}</span></div>}
          </div>
          <PerGameBarChart rows={opsRows} maxVal={2.0} yTicks={[0.5, 1.0, 1.5, 2.0]} fmtY={fmtOps}
            refLines={[{ v: 0.7, label: '.700 avg', color: T.poor }, { v: seasonOps, label: `season ${fmtOps(seasonOps)}`, color: T.great }]}
            colorFn={opsColor}
            tooltipFn={(g, ops) => `${fmtDate(g.game_date)} ${g.home_away} ${g.opponent_short}: ${g.h ?? 0}-${g.ab ?? 0}${g.bb ? `, ${g.bb}BB` : ''}${g.hr ? `, ${g.hr}HR` : ''} · OPS ${fmtOps(ops)}`}
            legend={[{ color: '#5d99c6', label: 'Below .500' }, { color: '#9a9a9a', label: '.500–.799' }, { color: '#c9a44c', label: '.800–.999' }, { color: '#5b9d4d', label: '1.000–1.299' }, { color: '#b8302a', label: '1.300+' }]}
            note="Each bar = 1 game · hover for line" />
        </SectionCard>
      )}
    </>
  )
}

// ════════════════════════════════════════════════════════════════
// PITCHER
// ════════════════════════════════════════════════════════════════
function SummerPitcherProfile({ data, season }) {
  const T = usePlayerProfileTheme()
  const { player, pitching, game_pitching, spring_link, pitch_approach, pitching_percentiles } = data

  const rows = (pitching || []).slice().sort((a, b) => a.season - b.season)
  const pct = pitching_percentiles || {}
  const radarStats = PIT_RADAR.filter(rk => pct?.[rk.key]?.percentile != null).slice(0, 6).map(rk => ({ label: rk.label, pct: pct[rk.key].percentile }))
  const seasonRow = rows.find(r => r.season === season) || rows.slice(-1)[0]
  const seasonFip = seasonRow?.fip != null ? Number(seasonRow.fip) : null
  const lgFip = pct?.fip?.league_avg
  const role = (seasonRow?.games_started || 0) > 0 && (seasonRow?.games_started || 0) >= ((seasonRow?.games || 0) - (seasonRow?.games_started || 0)) ? 'Starter' : 'Reliever'

  const games = (game_pitching || []).map(g => tagGame(g, player.team_id))
  const rolling = rollingFip(games, seasonFip, 10)
  const kRows = games.map(g => ({ g, val: g.so ?? 0 }))
  const maxK = Math.max(6, ...kRows.map(r => r.val))
  const mostK = games.reduce((acc, g) => (g.so ?? 0) > (acc?.so ?? -1) ? g : acc, null)
  const last5 = games.slice(-5).map(g => ({ ip: ipToTrue(g.ip), er: g.er || 0 })).filter(o => o.ip > 0)
  const last5Ip = last5.reduce((s, o) => s + o.ip, 0)
  const last5Era = last5Ip > 0 ? (last5.reduce((s, o) => s + o.er, 0) * 9) / last5Ip : null

  const miniCols = [
    { label: 'Year', align: 'left', render: s => s.season },
    { label: 'IP', render: s => s.innings_pitched != null ? Number(s.innings_pitched).toFixed(1) : '—' },
    { label: 'ERA', render: s => fmtEra(s.era) },
    { label: 'WHIP', render: s => fmtEra(s.whip) },
    { label: 'K', render: s => s.strikeouts ?? '—' },
    { label: 'BB', render: s => s.walks ?? '—' },
    { label: 'FIP', render: s => fmtEra(s.fip) },
  ]

  return (
    <>
      <SummerHero
        player={player} springLink={spring_link} season={season}
        contextBox={seasonRow && (
          <div className="absolute top-2 right-2.5 rounded-md px-2.5 py-2 text-white" style={{ background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', border: '1px solid rgba(255,255,255,0.14)' }}>
            <div className="text-[8.5px] font-bold tracking-widest opacity-80 mb-1">{season} ROLE</div>
            <div className="text-[13px] font-bold tracking-wide">{role}</div>
            <div className="text-[10px] opacity-90 mt-0.5 tabular-nums">{seasonRow.games || 0} G · {seasonRow.games_started || 0} GS · {seasonRow.saves || 0} SV</div>
          </div>
        )}
        rightPanel={<PercentilePanel title="Percentile Rankings" scopeLabel={`${season} · VS ${player.league_abbr}`} metrics={PIT_PCT_METRICS.filter(m => pct?.[m.key]?.percentile != null)} percentiles={pct} tooltips={TOOLTIPS} />}
      >
        <div className="grid grid-cols-1 sm:grid-cols-[0.95fr_1.05fr] gap-3.5 items-stretch my-3 py-2 border-y" style={{ borderColor: T.border }}>
          <div className="flex flex-col min-w-0">
            <div className="text-[9.5px] font-bold tracking-widest uppercase text-center mb-0.5" style={{ color: T.textLight }}>Skill Profile</div>
            <div className="flex-1 max-w-[260px] mx-auto w-full">
              {radarStats.length >= 3 ? <RadarChart stats={radarStats} /> : <div className="text-[11px] text-center py-8" style={{ color: T.textMuted }}>Not enough qualified peers for percentiles yet</div>}
            </div>
          </div>
          <div className="flex flex-col min-w-0">
            <div className="flex items-center justify-center gap-2 mb-0.5">
              <span className="text-[9.5px] font-bold tracking-widest uppercase" style={{ color: T.textLight }}>{rolling.length >= 2 ? '10-Game Rolling FIP' : `${season} Rate Stats`}</span>
              {seasonFip != null && <span className="px-1.5 py-px rounded-md text-[9.5px] font-bold tabular-nums tracking-wide text-white" style={{ background: T.accent }}>SEASON {fmtEra(seasonFip)}</span>}
            </div>
            <div className="flex-1 max-w-[340px] mx-auto w-full flex">
              {rolling.length >= 2
                ? <RollingLineChart series={rolling} floorZero fmtTick={v => v.toFixed(2)}
                    refLines={[
                      ...(lgFip != null ? [{ v: lgFip, label: `LG ${fmtEra(lgFip)}`, color: T.poor }] : []),
                      ...(seasonFip != null ? [{ v: seasonFip, label: 'season', color: T.gold }] : []),
                    ]} lineColor={T.accent} />
                : <StatTiles tiles={[
                    ['ERA', fmtEra(seasonRow?.era)],
                    ['FIP', fmtEra(seasonRow?.fip)],
                    ['WHIP', fmtEra(seasonRow?.whip)],
                    ['K%', seasonRow?.k_pct != null ? formatPct('pct', seasonRow.k_pct) : '—'],
                    ['BB%', seasonRow?.bb_pct != null ? formatPct('pct', seasonRow.bb_pct) : '—'],
                    ['K/9', fmtEra(seasonRow?.k_per_9)],
                  ]} />}
            </div>
          </div>
        </div>
        <MiniTable rows={rows} cols={miniCols} />
      </SummerHero>

      <SectionCard title="Pitching Stats" right="BY SEASON">
        <SeasonStatTable cols={PIT_COLS} rows={rows.map(r => ({ ...r, _kind: 'spring' }))} blankCols={new Set([])} emptyMsg="No pitching stats." minWidth="820px" />
      </SectionCard>

      <ApproachCard approach={pitch_approach} kind="pitcher" />

      <SectionCard title="Game Log" right={`${season} SEASON`}>
        <GameLogTable cols={PIT_GAMELOG} games={games} minWidth="700px" emptyMsg="No games tracked this season yet." />
      </SectionCard>

      <div className="flex items-center gap-3 my-6">
        <span className="flex-1 h-px" style={{ background: T.borderStrong }} />
        <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: T.textLight }}>Extended Analytics</span>
        <span className="flex-1 h-px" style={{ background: T.borderStrong }} />
      </div>

      {games.length > 1 && (
        <SectionCard title="Strikeouts by Outing" right={`${season} · CHRONOLOGICAL`}>
          <div className="flex flex-wrap gap-x-6 gap-y-2 mb-3 text-[11px]" style={{ color: T.textMuted }}>
            <div className="flex flex-col"><span className="text-[9.5px] uppercase tracking-wider" style={{ color: T.textLight }}>Season ERA</span><span className="text-base font-bold tabular-nums" style={{ color: T.text }}>{fmtEra(seasonRow?.era)}</span></div>
            <div className="flex flex-col"><span className="text-[9.5px] uppercase tracking-wider" style={{ color: T.textLight }}>Last 5 Outings</span><span className="text-base font-bold tabular-nums" style={{ color: (last5Era != null && seasonRow?.era != null && last5Era <= Number(seasonRow.era)) ? T.great : T.poor }}>{last5Era != null ? fmtEra(last5Era) : '—'}</span></div>
            {mostK && <div className="flex flex-col"><span className="text-[9.5px] uppercase tracking-wider" style={{ color: T.textLight }}>Most K's</span><span className="text-base font-bold tabular-nums" style={{ color: T.text }}>{fmtDate(mostK.game_date)} · {mostK.so} K</span></div>}
          </div>
          <PerGameBarChart rows={kRows} maxVal={maxK} yTicks={[Math.round(maxK / 2), maxK]} fmtY={v => String(v)}
            colorFn={v => v >= 8 ? '#b8302a' : v >= 5 ? '#5b9d4d' : v >= 3 ? '#c9a44c' : '#9a9a9a'}
            tooltipFn={(g, k) => `${fmtDate(g.game_date)} ${g.home_away} ${g.opponent_short}: ${g.ip != null ? Number(g.ip).toFixed(1) : '?'} IP, ${g.h ?? 0}H ${g.er ?? 0}ER ${k}K ${g.bb ?? 0}BB${g.decision ? ` · ${g.decision}` : ''}`}
            note="Each bar = 1 outing · hover for line" />
        </SectionCard>
      )}
    </>
  )
}

// ════════════════════════════════════════════════════════════════
// Side router (two-way → toggle)
// ════════════════════════════════════════════════════════════════
export default function SummerPlayerProfile({ data, seasonSelector = null }) {
  const season = data.season
  const hasBatting = (data.batting || []).some(r => r.season === season) || (data.batting || []).length > 0
  const hasPitching = (data.pitching || []).some(r => r.season === season) || (data.pitching || []).length > 0
  const isTwoWay = hasBatting && hasPitching

  // Default to the side with the bigger sample for the active season.
  const batRow = (data.batting || []).find(r => r.season === season)
  const pitRow = (data.pitching || []).find(r => r.season === season)
  const defaultSide = (() => {
    if (hasBatting && !hasPitching) return 'batting'
    if (hasPitching && !hasBatting) return 'pitching'
    const pa = batRow?.plate_appearances || 0
    const ip = pitRow?.innings_pitched || 0
    return (ip * 4) > pa ? 'pitching' : 'batting'
  })()
  const [side, setSide] = useState(defaultSide)
  const activeSide = isTwoWay ? side : defaultSide

  return (
    <ProfileShell>
      {(isTwoWay || seasonSelector) && (
        <div className="flex items-center gap-2 flex-wrap mb-1">
          {isTwoWay && <SideToggle side={activeSide} onChange={setSide} />}
          {seasonSelector && <div className="ml-auto">{seasonSelector}</div>}
        </div>
      )}
      {activeSide === 'pitching'
        ? <SummerPitcherProfile data={data} season={season} />
        : <SummerHitterProfile data={data} season={season} />}
    </ProfileShell>
  )
}
