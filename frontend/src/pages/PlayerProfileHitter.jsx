// PlayerProfileHitter — redesigned hitter profile (generalized from the
// Jason Wright prototype, 5/28/26). Renders for any hitter. Props:
//   playerId : route player id (drives the secondary fetches)
//   data     : the /players/:id payload, fetched once by the parent
//   sideToggle : optional node (hitter/pitcher switch for two-way players)
//
// Visual language + shared primitives live in components/playerProfile/shared.jsx.

import { Link } from 'react-router-dom'
import { usePlayerGameLogs } from '../hooks/useApi'
import PitchLevelStatsCard from '../components/PitchLevelStatsCard'
import WpaByGameChart from '../components/LazyWpaByGameChart'  // defers recharts off the player page
import PlayerCompsCard from '../components/PlayerCompsCard'
import {
  usePlayerProfileTheme, formatPct, fmtCell,
  RadarChart, PercentilePanel, RollingLineChart, PerGameBarChart,
  SectionCard, SeasonStatTable, GameLogTable, CareerPath, StreaksCard,
  ProfileShell, divisionBadge,
  CHART_TIERS, HERO_GRADIENT, AWARD_BADGE_STYLE, RANK_BADGE_STYLE,
} from '../components/playerProfile/shared'
import { CURRENT_SEASON } from '../lib/seasons'

// SEASON is derived from the `season` prop inside the component (the year
// selector / ?season= URL param), so the page can render any season.

// Right-panel percentile rows + radar axes (batting).
const PCT_METRICS = [
  { key: 'offensive_war',          label: 'WAR',         fmt: 'war' },
  { key: 'wrc_plus',               label: 'wRC+',        fmt: 'int' },
  { key: 'woba',                   label: 'wOBA',        fmt: 'avg' },
  { key: 'wobacon',                label: 'wOBACON',     fmt: 'avg' },
  { key: 'iso',                    label: 'ISO',         fmt: 'avg' },
  { key: 'hr_pa_pct',              label: 'HR/PA',       fmt: 'pct' },
  { key: 'k_pct',                  label: 'K%',          fmt: 'pct' },
  { key: 'bb_pct',                 label: 'BB%',         fmt: 'pct' },
  { key: 'contact_pct',            label: 'Contact%',    fmt: 'pct' },
  { key: 'two_strike_contact_pct', label: '2K Contact%', fmt: 'pct' },
  { key: 'air_pull_pct',           label: 'AIRPULL%',    fmt: 'pct' },
  { key: 'fb_pct',                 label: 'FB%',         fmt: 'pct' },
  { key: 'sb_per_pa',              label: 'SB/PA',       fmt: 'pct' },
  { key: 'wpa',                    label: 'WPA',         fmt: 'wpa' },
]
const RADAR_KEYS = [
  { key: 'wrc_plus',    label: 'wRC+' },
  { key: 'iso',         label: 'ISO' },
  { key: 'contact_pct', label: 'Contact%' },
  { key: 'bb_pct',      label: 'BB%' },
  { key: 'k_pct',       label: 'K%' },
  { key: 'wpa',         label: 'WPA' },
]
const TOOLTIPS = {
  WAR:        { what: 'Wins Above Replacement.', why: 'Single best one-number summary.', range: 'Poor <0.5 | Avg ~1.5 | Great 3.0+' },
  'wRC+':     { what: 'Weighted Runs Created Plus, 100 = league avg.', why: 'Park + league adjusted.', range: 'Poor <85 | Avg ~100 | Great 130+' },
  wOBA:       { what: 'Weighted On-Base Average.', why: 'Better single offensive number than OBP/SLG.', range: 'Poor <.310 | Avg ~.330 | Great .400+' },
  wOBACON:    { what: 'wOBA on contact (balls in play).', why: 'Quality of contact, stripped of Ks and walks.', range: 'Poor <.330 | Avg ~.380 | Great .450+' },
  ISO:        { what: 'Isolated Power. SLG − AVG.', why: 'Pure extra-base power.', range: 'Poor <.130 | Avg ~.160 | Great .220+' },
  'HR/PA':    { what: 'Home runs per plate appearance.', why: 'Cleanest power-frequency metric.', range: 'Poor <1% | Avg ~2.5% | Great 4%+' },
  'K%':       { what: 'Strikeout rate.', why: 'Lower is better contact.', range: 'Poor >25% | Avg ~20% | Great <15%' },
  'BB%':      { what: 'Walk rate.', why: 'Plate discipline / pitch selection.', range: 'Poor <6% | Avg ~8% | Great 12%+' },
  'Contact%': { what: '% of swings that make contact.', why: 'Pure bat-to-ball skill.', range: 'Poor <72% | Avg ~78% | Great 85%+' },
  '2K Contact%': { what: 'Contact rate on swings with 2 strikes.', why: 'Two-strike battling / strikeout avoidance.', range: 'Poor <70% | Avg ~78% | Great 85%+' },
  'AIRPULL%': { what: '% of air-ball contact pulled.', why: 'Proxy for hard intentional contact.', range: 'Poor <12% | Avg ~16% | Great 22%+' },
  'FB%':      { what: 'Fly-ball rate on batted balls.', why: 'Launch / power tendency.', range: 'Low <30% | Avg ~38% | High 48%+' },
  'SB/PA':    { what: 'Stolen-base attempts per PA.', why: 'Speed + baserunning aggression.', range: 'Poor 0% | Avg ~3% | Great 8%+' },
  WPA:        { what: 'Win Probability Added.', why: 'Context-dependent clutch value.', range: 'Poor <0 | Avg ~0 | Great +1.5+' },
}

const EXTENDED_BATTING_COLS = [
  { key: 'season',            label: 'Year', fmt: 'raw', align: 'left' },
  { key: '_typeLabel',        label: 'Lvl',  fmt: 'raw', align: 'left' },
  { key: '_team',             label: 'Team', fmt: 'raw', align: 'left' },
  { key: 'games',             label: 'G',    fmt: 'int' },
  { key: 'plate_appearances', label: 'PA',   fmt: 'int' },
  { key: 'at_bats',           label: 'AB',   fmt: 'int' },
  { key: 'hits',              label: 'H',    fmt: 'int' },
  { key: 'doubles',           label: '2B',   fmt: 'int' },
  { key: 'triples',           label: '3B',   fmt: 'int' },
  { key: 'home_runs',         label: 'HR',   fmt: 'int' },
  { key: 'runs',              label: 'R',    fmt: 'int' },
  { key: 'rbi',               label: 'RBI',  fmt: 'int' },
  { key: 'walks',             label: 'BB',   fmt: 'int' },
  { key: 'strikeouts',        label: 'K',    fmt: 'int' },
  { key: 'stolen_bases',      label: 'SB',   fmt: 'int' },
  { key: 'batting_avg',       label: 'AVG',  fmt: 'avg' },
  { key: 'on_base_pct',       label: 'OBP',  fmt: 'avg' },
  { key: 'slugging_pct',      label: 'SLG',  fmt: 'avg' },
  { key: 'ops',               label: 'OPS',  fmt: 'avg' },
  { key: 'woba',              label: 'wOBA', fmt: 'avg' },
  { key: 'wrc_plus',          label: 'wRC+', fmt: 'int' },
  { key: 'iso',               label: 'ISO',  fmt: 'avg' },
  { key: 'bb_pct',            label: 'BB%',  fmt: 'pct' },
  { key: 'k_pct',             label: 'K%',   fmt: 'pct' },
  { key: 'offensive_war',     label: 'oWAR', fmt: 'war' },
]
// Summer (WCL/PIL) now carries the full advanced batting line
// (wOBA/wRC+/ISO/BB%/K%/oWAR), so nothing is blanked for summer rows.
const SUMMER_BLANK_COLS = new Set([])

const GAMELOG_BATTING_COLS = [
  { key: '_date', label: 'Date', align: 'left' },
  { key: '_opp',  label: 'Opp',  align: 'left' },
  { key: 'ab', label: 'AB' }, { key: 'r', label: 'R' }, { key: 'h', label: 'H' },
  { key: '2b', label: '2B' }, { key: '3b', label: '3B' }, { key: 'hr', label: 'HR' },
  { key: 'rbi', label: 'RBI' }, { key: 'bb', label: 'BB' }, { key: 'k', label: 'K' }, { key: 'sb', label: 'SB' },
]

const DEF_COLS_BASE = [
  { key: 'season',        label: 'Year', align: 'left', fmt: 'raw' },
  { key: 'position',      label: 'Pos',  align: 'left', fmt: 'raw' },
  { key: 'games',         label: 'G',    fmt: 'int' },
  { key: 'games_started', label: 'GS',   fmt: 'int' },
  { key: 'innings',       label: 'Inn',  fmt: 'inn' },
  { key: 'putouts',       label: 'PO',   fmt: 'int' },
  { key: 'assists',       label: 'A',    fmt: 'int' },
  { key: 'errors',        label: 'E',    fmt: 'int' },
  { key: 'total_chances', label: 'TC',   fmt: 'int' },
  { key: 'double_plays',  label: 'DP',   fmt: 'int' },
  { key: 'fielding_pct',  label: 'FldPct', fmt: 'avg' },
]
const DEF_COLS_CATCHER_EXTRA = [
  { key: 'passed_balls',         label: 'PB',  fmt: 'int' },
  { key: 'stolen_bases_against', label: 'SBA', fmt: 'int' },
  { key: 'caught_stealing_by',   label: 'CS',  fmt: 'int' },
  { key: 'cs_pct',               label: 'CS%', fmt: 'pctRaw' },
]

// ── batting per-game helpers ───────────────────────────────────
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
  const wobas = games.map(g => gameWoba(g)).filter(w => w != null)
  const out = []
  for (let i = 0; i < wobas.length; i++) {
    const slice = wobas.slice(Math.max(0, i - window + 1), i + 1)
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
  if (ops == null) return CHART_TIERS.none
  if (ops >= 1.300) return CHART_TIERS.great
  if (ops >= 1.000) return CHART_TIERS.good
  if (ops >= 0.800) return CHART_TIERS.solid
  if (ops >= 0.500) return CHART_TIERS.below
  return CHART_TIERS.poor
}
const fmtOps = v => v == null ? '—' : v.toFixed(3).replace(/^0/, '')
const fmtDate = d => { if (!d) return ''; const dt = new Date(d); return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}` }
const CLASS_YEARS = { Fr: 'Freshman', So: 'Sophomore', Jr: 'Junior', Sr: 'Senior', Gr: 'Graduate' }
function fmtClassYear(y) {
  if (!y) return null
  const rs = y.startsWith('R-')
  const base = rs ? y.slice(2) : y
  const label = CLASS_YEARS[base] || base
  return rs ? `RS ${label}` : label
}

// ── Defensive stats (per-position) ─────────────────────────────
function DefensiveStats({ rows }) {
  const T = usePlayerProfileTheme()
  if (!rows || !rows.length) return <div className="text-xs" style={{ color: T.textMuted }}>No defensive stats.</div>
  const hasCatcher = rows.some(r => r.position === 'C')
  const cols = hasCatcher ? [...DEF_COLS_BASE, ...DEF_COLS_CATCHER_EXTRA] : DEF_COLS_BASE
  const sorted = rows.slice().sort((a, b) => (b.season - a.season) || ((b.games || 0) - (a.games || 0)))
  return (
    <div className="overflow-x-auto -mx-3 sm:mx-0">
      <div className="min-w-[680px] px-3 sm:px-0">
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr style={{ borderBottom: `1px solid ${T.border}` }}>
              {cols.map(c => (
                <th key={c.key} className={`px-1.5 py-1.5 font-bold tracking-wide ${c.align === 'left' ? 'text-left' : 'text-right'}`} style={{ color: T.textLight }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={r.season + '-' + r.position + '-' + i} style={{ borderBottom: `1px solid ${T.rowBorder}` }}>
                {cols.map(c => (
                  <td key={c.key} className={`px-1.5 py-1.5 tabular-nums ${c.align === 'left' ? 'text-left font-semibold' : 'text-right'}`} style={{ color: T.text }}>
                    {fmtCell(c.fmt, r[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasCatcher && (
        <div className="text-[10px] mt-2 px-3 sm:px-0" style={{ color: T.textLight }}>
          SBA = stolen bases attempted · CS = runners thrown out · CS% caught-stealing rate
        </div>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────
export default function PlayerProfileHitter({ playerId, data, season = CURRENT_SEASON, sideToggle = null, seasonSelector = null }) {
  const SEASON = season || CURRENT_SEASON
  const T = usePlayerProfileTheme()
  const { data: gameLogs } = usePlayerGameLogs(playerId, SEASON)

  const { player, batting_stats, summer_batting, batting_percentiles, fielding_stats, awards, pnw_rankings, gold_gloves, position_breakdown, current_summer_assignment } = data

  // Interleave spring + summer rows chronologically.
  const springTagged = (batting_stats || []).map(s => ({ ...s, _kind: 'spring', _typeLabel: s.division_level || 'College', _team: s.team_short || '—' }))
  const summerTagged = (summer_batting || []).map(s => ({ ...s, _kind: 'summer', _typeLabel: s.league_abbrev || 'Summer', _team: s.team_name || '—' }))
  const allBattingRows = [...springTagged, ...summerTagged].sort((a, b) => (a.season !== b.season ? a.season - b.season : (a._kind === 'spring' ? -1 : 1)))
  const springRows = springTagged.slice().sort((a, b) => a.season - b.season)

  const career = springRows.reduce((acc, s) => {
    acc.pa += s.plate_appearances || 0; acc.ab += s.at_bats || 0; acc.h += s.hits || 0
    acc.hr += s.home_runs || 0; acc.bb += s.walks || 0; acc.hbp += s.hit_by_pitch || 0
    acc.sf += s.sacrifice_flies || 0
    acc.tb += (s.hits || 0) + (s.doubles || 0) + 2 * (s.triples || 0) + 3 * (s.home_runs || 0)
    return acc
  }, { pa: 0, ab: 0, h: 0, hr: 0, bb: 0, hbp: 0, sf: 0, tb: 0 })
  const careerAvg = career.ab > 0 ? career.h / career.ab : 0
  const careerOBP = (career.ab + career.bb + career.hbp + career.sf) > 0 ? (career.h + career.bb + career.hbp) / (career.ab + career.bb + career.hbp + career.sf) : 0
  const careerSLG = career.ab > 0 ? career.tb / career.ab : 0

  const currSeason = springRows.slice(-1)[0]
  const seasonWobaVal = currSeason?.woba
  const divLabel = currSeason?.division_level || player.division_level || 'LEAGUE'
  const lgWoba = data?.league_context?.woba

  // Render only metrics the API actually returned (non-null percentile).
  const pctMetrics = PCT_METRICS.filter(m => batting_percentiles?.[m.key]?.percentile != null)
  const radarStats = RADAR_KEYS
    .filter(rk => batting_percentiles?.[rk.key]?.percentile != null)
    .map(rk => ({ label: rk.label, pct: batting_percentiles[rk.key].percentile }))

  const battingGames = gameLogs?.batting || []
  const rolling = rollingWoba(battingGames, 10)

  const posRows = (position_breakdown || []).slice(0, 3)

  // Per-game OPS chart inputs
  const opsRows = battingGames.map(g => ({ g, val: gameOps(g) }))
  const withOps = opsRows.filter(r => r.val != null)
  const seasonOps = withOps.length ? withOps.reduce((s, r) => s + r.val, 0) / withOps.length : 0
  const last5 = withOps.slice(-5)
  const last5Ops = last5.length ? last5.reduce((s, r) => s + r.val, 0) / last5.length : 0
  const best = withOps.reduce((acc, r) => r.val > (acc?.val ?? -1) ? r : acc, null)
  const worst = withOps.reduce((acc, r) => r.val < (acc?.val ?? 999) ? r : acc, null)

  const seasonRange = springRows.length ? `${springRows[0].season}${springRows.length > 1 ? `–${springRows[springRows.length - 1].season}` : ''}` : null

  return (
    <ProfileShell>
      <div className="flex items-center gap-2 flex-wrap mb-1">
        {sideToggle}
        <div className="ml-auto flex items-center gap-2">
          {seasonSelector}
          <Link
            to={`/player-pages?id=${player.id}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold text-white hover:opacity-90 transition-opacity"
            style={{ background: T.accent }}
            title="View a downloadable, shareable graphic of this player"
          >
            📸 Player graphic
          </Link>
        </div>
      </div>

      {/* Hero */}
      <div className="grid lg:grid-cols-[1.1fr_1fr] rounded-md overflow-hidden mb-4" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        {/* LEFT */}
        <div className="p-5 flex flex-col">
          <div className="relative h-20 -mx-5 -mt-5" style={{ background: HERO_GRADIENT }}>
            <div className="absolute -bottom-7 left-[18px] w-[70px] h-[70px] rounded-full bg-gray-300 border-[3px] border-white flex items-center justify-center text-2xl font-bold text-gray-500 overflow-hidden">
              {player.headshot_url
                ? <img src={player.headshot_url} alt="" className="w-full h-full object-cover" />
                : <span>{player.first_name?.[0]}{player.last_name?.[0]}</span>}
            </div>
            {posRows.length > 0 && (
              <div className="absolute top-2 right-2.5 rounded-md px-2.5 pt-1.5 pb-2 text-white min-w-[170px]"
                style={{ background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', border: '1px solid rgba(255,255,255,0.14)' }}>
                <div className="text-[8.5px] font-bold tracking-widest opacity-80 mb-1">{SEASON} POSITIONS</div>
                {posRows.map(p => (
                  <div key={p.position} className="grid items-center mt-1 tabular-nums" style={{ gridTemplateColumns: '22px 1fr 36px', gap: '7px' }}>
                    <span className="text-[10.5px] font-bold tracking-wide">{p.position}</span>
                    <div className="h-1 rounded-sm overflow-hidden" style={{ background: 'rgba(255,255,255,0.18)' }}>
                      <div className="h-full" style={{ width: `${p.percentage}%`, background: T.gold }} />
                    </div>
                    <span className="text-[9.5px] font-semibold text-right opacity-90">{Math.round(p.percentage)}%</span>
                  </div>
                ))}
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
            {player.is_committed && player.committed_to && (
              <div className="mt-2 mr-2 inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-semibold bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200">
                ✓ Committed to {player.committed_to}
              </div>
            )}
            {current_summer_assignment && (
              <Link to={current_summer_assignment.summer_player_id ? `?summer=${current_summer_assignment.summer_player_id}` : `/summer/teams/${current_summer_assignment.team_id}`} className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-semibold bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/50">
                {current_summer_assignment.team_logo && <img src={current_summer_assignment.team_logo} alt="" className="w-4 h-4 object-contain" loading="lazy" />}
                Summer {SEASON}: {current_summer_assignment.team_short || current_summer_assignment.team_name}
                <span className="text-[10px] opacity-70">· {current_summer_assignment.league_abbrev}</span>
              </Link>
            )}

            {/* Radar + rolling wOBA */}
            <div className="grid grid-cols-1 sm:grid-cols-[0.95fr_1.05fr] gap-3.5 items-stretch my-3 py-2 border-y" style={{ borderColor: T.border }}>
              <div className="flex flex-col min-w-0">
                <div className="text-[9.5px] font-bold tracking-widest uppercase text-center mb-0.5" style={{ color: T.textLight }}>Skill Profile</div>
                <div className="flex-1 max-w-[260px] mx-auto w-full"><RadarChart stats={radarStats} /></div>
              </div>
              <div className="flex flex-col min-w-0">
                <div className="flex items-center justify-center gap-2 mb-0.5">
                  <span className="text-[9.5px] font-bold tracking-widest uppercase" style={{ color: T.textLight }}>10-Game Rolling wOBA</span>
                  {seasonWobaVal != null && (
                    <span className="px-1.5 py-px rounded-md text-[9.5px] font-bold tabular-nums tracking-wide text-white" style={{ background: T.great }}>SEASON {formatPct('avg', seasonWobaVal)}</span>
                  )}
                </div>
                <div className="flex-1 max-w-[340px] mx-auto w-full">
                  <RollingLineChart
                    series={rolling}
                    floorZero
                    fmtTick={v => `.${Math.round(v * 1000)}`}
                    refLines={[
                      ...(lgWoba != null ? [{ v: lgWoba, label: `LG ${formatPct('avg', lgWoba)}`, color: T.poor }] : []),
                      ...(seasonWobaVal != null ? [{ v: seasonWobaVal, label: 'season', color: T.gold }] : []),
                    ]}
                    lineColor={T.great}
                  />
                </div>
              </div>
            </div>

            {/* Year-by-year mini table */}
            <table className="w-full mt-2 text-[11px] border-collapse">
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {['Year', 'Lvl', 'Team', 'PA', 'AVG', 'OBP', 'SLG', 'HR', 'wRC+'].map(h => (
                    <th key={h} className={`px-1.5 py-1 font-bold tracking-wide ${h === 'Year' || h === 'Lvl' || h === 'Team' ? 'text-left' : 'text-right'}`} style={{ color: T.textLight }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allBattingRows.map((s, i) => {
                  const isCurrent = s._kind === 'spring' && i === allBattingRows.length - 1
                  const isSummer = s._kind === 'summer'
                  const rowStyle = isCurrent ? { background: T.highlight, borderTop: `1px solid ${T.borderStrong}` } : (isSummer ? { background: T.rowAlt } : {})
                  return (
                    <tr key={`${s.season}-${s._kind}-${s._team}-${i}`} className={`${isCurrent ? 'font-bold' : ''} ${isSummer ? 'italic' : ''}`} style={rowStyle}>
                      <td className="px-1.5 py-1 text-left" style={{ color: T.textMuted }}>{s.season}</td>
                      <td className="px-1.5 py-1 text-left" style={{ color: isSummer ? T.textLight : T.textMuted }}>{s._typeLabel}</td>
                      <td className="px-1.5 py-1 text-left" style={{ color: T.textMuted }}>{s._team}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{s.plate_appearances ?? '—'}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{s.batting_avg != null ? formatPct('avg', s.batting_avg) : '—'}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{s.on_base_pct != null ? formatPct('avg', s.on_base_pct) : '—'}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{s.slugging_pct != null ? formatPct('avg', s.slugging_pct) : '—'}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{s.home_runs ?? '—'}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{s.wrc_plus != null ? Math.round(s.wrc_plus) : '—'}</td>
                    </tr>
                  )
                })}
                {springRows.length > 1 && (
                  <tr style={{ borderTop: `1px solid ${T.border}` }}>
                    <td className="px-1.5 py-1 text-left" style={{ color: T.textMuted }}>Career</td>
                    <td className="px-1.5 py-1 text-left" style={{ color: T.textLight }}>Spring</td>
                    <td className="px-1.5 py-1 text-left" style={{ color: T.textLight }}>—</td>
                    <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{career.pa}</td>
                    <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{formatPct('avg', careerAvg)}</td>
                    <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{formatPct('avg', careerOBP)}</td>
                    <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{formatPct('avg', careerSLG)}</td>
                    <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>{career.hr}</td>
                    <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: T.text }}>—</td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* Badges */}
            <div className="flex flex-wrap gap-1.5 mt-3">
              {(gold_gloves || []).map((g, i) => (
                <span
                  key={`gg-${i}`}
                  className="text-[9.5px] font-bold tracking-wide px-2 py-[3px] rounded-full bg-amber-100 text-amber-900 border border-amber-300"
                  title={`${g.season} ${g.scope} Gold Glove${g.mvp ? ' MVP' : ''} (${g.position})`}
                >
                  🥇 {String(g.season).slice(-2)} {g.scope} GG · {g.position}{g.mvp ? ' MVP' : ''}
                </span>
              ))}
              {(awards || []).map((a, i) => (
                <span key={i} className="text-[9.5px] font-bold tracking-wide px-2 py-[3px] rounded-full" style={AWARD_BADGE_STYLE}>
                  {a.category} leader · {a.season}
                </span>
              ))}
              {(pnw_rankings || []).slice(0, 3).map((r, i) => (
                <span key={i} className="text-[9.5px] font-bold tracking-wide px-2 py-[3px] rounded-full" style={RANK_BADGE_STYLE}>
                  {r.rank}{r.rank === 1 ? 'st' : r.rank === 2 ? 'nd' : r.rank === 3 ? 'rd' : 'th'} PNW · {r.category}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT: percentiles */}
        <PercentilePanel title="Percentile Rankings" scopeLabel={`${SEASON} · VS ${divLabel}`} metrics={PCT_METRICS} percentiles={batting_percentiles} tooltips={TOOLTIPS} />
      </div>

      <SectionCard title="Batting Stats" right="BY SEASON">
        <SeasonStatTable cols={EXTENDED_BATTING_COLS} rows={allBattingRows} blankCols={SUMMER_BLANK_COLS} emptyMsg="No batting stats." />
      </SectionCard>

      <SectionCard title="Defensive Stats" right="BY POSITION">
        <DefensiveStats rows={fielding_stats} />
      </SectionCard>

      <StreaksCard playerId={playerId} season={SEASON} />

      <SectionCard title="Pitch Level Stats" right={String(SEASON)}>
        <div className="-mx-2"><PitchLevelStatsCard playerId={playerId} season={SEASON} /></div>
      </SectionCard>

      <SectionCard title="WPA at the Plate" right={String(SEASON)}>
        <WpaByGameChart playerId={playerId} position="batter" />
      </SectionCard>

      <SectionCard title="Game Log" right={`${SEASON} SEASON`}>
        <GameLogTable cols={GAMELOG_BATTING_COLS} games={battingGames} />
      </SectionCard>

      <div className="flex items-center gap-3 my-6">
        <span className="flex-1 h-px" style={{ background: T.borderStrong }} />
        <span className="text-[10px] font-bold tracking-widest uppercase" style={{ color: T.textLight }}>Extended Analytics</span>
        <span className="flex-1 h-px" style={{ background: T.borderStrong }} />
      </div>

      <SectionCard title="Per-Game OPS" right={`${SEASON} · CHRONOLOGICAL`}>
        {/* top stat strip */}
        <div className="flex flex-wrap gap-x-6 gap-y-2 mb-3 text-[11px]" style={{ color: T.textMuted }}>
          <div className="flex flex-col"><span className="text-[9.5px] uppercase tracking-wider" style={{ color: T.textLight }}>Season OPS</span><span className="text-base font-bold tabular-nums" style={{ color: T.text }}>{fmtOps(seasonOps)}</span></div>
          <div className="flex flex-col"><span className="text-[9.5px] uppercase tracking-wider" style={{ color: T.textLight }}>Last 5 Games</span><span className="text-base font-bold tabular-nums" style={{ color: last5Ops >= seasonOps ? T.great : T.poor }}>{fmtOps(last5Ops)}</span></div>
          {best && <div className="flex flex-col"><span className="text-[9.5px] uppercase tracking-wider" style={{ color: T.textLight }}>Best Game</span><span className="text-base font-bold tabular-nums" style={{ color: T.text }}>{fmtDate(best.g.game_date)} · {fmtOps(best.val)}</span></div>}
          {worst && <div className="flex flex-col"><span className="text-[9.5px] uppercase tracking-wider" style={{ color: T.textLight }}>Coldest Game</span><span className="text-base font-bold tabular-nums" style={{ color: T.poor }}>{fmtDate(worst.g.game_date)} · {fmtOps(worst.val)}</span></div>}
        </div>
        <PerGameBarChart
          rows={opsRows}
          maxVal={2.0}
          yTicks={[0.500, 1.000, 1.500, 2.000]}
          fmtY={fmtOps}
          refLines={[
            { v: 0.700, label: '.700 avg', color: T.poor },
            { v: 1.000, label: '1.000', color: T.gold },
            { v: seasonOps, label: `season ${fmtOps(seasonOps)}`, color: T.great },
          ]}
          colorFn={opsColor}
          tooltipFn={(g, ops) => `${fmtDate(g.game_date)} ${g.home_away === '@' ? '@' : 'vs'} ${g.opponent_short}: ${g.h ?? 0}-${g.ab ?? 0}${g.bb ? `, ${g.bb}BB` : ''}${g.hr ? `, ${g.hr}HR` : ''} · OPS ${fmtOps(ops)}`}
          legend={[
            { color: CHART_TIERS.poor, label: 'Below .500' },
            { color: CHART_TIERS.below, label: '.500–.799' },
            { color: CHART_TIERS.solid, label: '.800–.999' },
            { color: CHART_TIERS.good, label: '1.000–1.299' },
            { color: CHART_TIERS.great, label: '1.300+' },
          ]}
          note="Each bar = 1 game · hover for line"
        />
      </SectionCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="rounded-md p-5" style={{ background: T.card, border: `1px solid ${T.border}` }}>
          <h2 className="font-bold text-[15px] mb-3 pb-1.5 border-b-2 flex items-center gap-2" style={{ color: T.text, borderColor: T.text }}>
            <span>Career Path</span><span className="ml-auto text-[11px] font-semibold tracking-widest" style={{ color: T.textLight }}>SCHOOLS</span>
          </h2>
          <CareerPath player={player} divisionBadge={divisionBadge(divLabel)} seasonRange={seasonRange} />
        </div>
        <PlayerCompsCard playerId={playerId} side="hitter" divLabel={divLabel} season={SEASON} />
      </div>
    </ProfileShell>
  )
}
