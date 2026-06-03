// /summer/stats — the heavy-duty WCL stats page.
//
// Replaces the old /summerball page from the Stats tab. Adds:
//   • Batting / Pitching / Fielding sub-tabs in one place
//   • Multi-year season picker (2026 default, 2019-2025 history)
//   • Sort + min-PA / min-IP / min-TC filters
//   • Click-through to player + team profiles
//
// Uses the new /summer/leaderboards/* endpoints, which already power
// the Hub's leader tabs. Selecting an older season works as long as
// that season has summer_batting_stats / pitching_stats / fielding_stats
// rows in the DB.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import SummerPageShell from './SummerPageShell'
import { useApi } from '../../hooks/useApi'

const LEAGUE = 'WCL'
const SEASON_OPTIONS = [2026, 2025, 2024, 2023, 2022, 2021, 2019]
const TABS = [
  { key: 'batting',  label: 'Batting' },
  { key: 'pitching', label: 'Pitching' },
  { key: 'fielding', label: 'Fielding' },
]

const fmtAvg = (v) => v == null ? '—' : Number(v).toFixed(3).replace(/^0/, '')
const fmtEra = (v) => v == null ? '—' : Number(v).toFixed(2)
const fmtInt = (v) => v == null ? '—' : Math.round(v)
const fmtPct = (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`


export default function SummerStatsPage() {
  const [tab,     setTab]     = useState('batting')
  const [season,  setSeason]  = useState(2026)
  return (
    <SummerPageShell
      title="WCL Stats"
      subtitle="Full league leaderboards. Sortable, filterable, exportable. Multi-year history."
      headerExtra={
        <div className="flex items-center gap-2 shrink-0">
          <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">Season</label>
          <select
            value={season}
            onChange={e => setSeason(Number(e.target.value))}
            className="px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm font-semibold text-gray-900 dark:text-gray-100"
          >
            {SEASON_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      }
    >
      <div className="flex overflow-x-auto border-b border-gray-200 dark:border-gray-700 mb-4 gap-1">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-semibold whitespace-nowrap border-b-2 transition ${
              tab === t.key
                ? 'border-nw-teal text-nw-teal dark:border-teal-300 dark:text-teal-300'
                : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'batting'  && <BattingTab  season={season} />}
      {tab === 'pitching' && <PitchingTab season={season} />}
      {tab === 'fielding' && <FieldingTab season={season} />}
    </SummerPageShell>
  )
}

// ─── Batting ───────────────────────────────────────────────

const BATTING_PRESETS = {
  Standard: ['G','PA','AB','H','2B','3B','HR','R','RBI','BB','K','SB','AVG','OBP','SLG','OPS'],
  Advanced: ['PA','AVG','OBP','SLG','wOBA','wRC+','wRAA','ISO','BABIP','BB%','K%','oWAR'],
  Power:    ['G','PA','AB','2B','3B','HR','RBI','SLG','ISO','wRC+'],
  Discipline: ['PA','BB','K','HBP','BB%','K%','OBP','wOBA'],
  // Pitch-level plate discipline from PBP (swing/contact/whiff rates).
  'Pitch-Level': ['PA','Sw%','Con%','Whf%','K%','BB%','OPS'],
  Speed:    ['G','SB','CS','3B','R','AVG','OBP'],
}

const BATTING_COL_MAP = {
  G:    { key: 'games', fmt: 'int' },
  GS:   { key: 'games_started', fmt: 'int' },
  PA:   { key: 'plate_appearances', fmt: 'int' },
  AB:   { key: 'at_bats', fmt: 'int' },
  H:    { key: 'hits', fmt: 'int' },
  '2B': { key: 'doubles', fmt: 'int' },
  '3B': { key: 'triples', fmt: 'int' },
  HR:   { key: 'home_runs', fmt: 'int' },
  R:    { key: 'runs', fmt: 'int' },
  RBI:  { key: 'rbi', fmt: 'int' },
  BB:   { key: 'walks', fmt: 'int' },
  IBB:  { key: 'intentional_walks', fmt: 'int' },
  HBP:  { key: 'hit_by_pitch', fmt: 'int' },
  K:    { key: 'strikeouts', fmt: 'int' },
  SF:   { key: 'sacrifice_flies', fmt: 'int' },
  SH:   { key: 'sacrifice_bunts', fmt: 'int' },
  SB:   { key: 'stolen_bases', fmt: 'int' },
  CS:   { key: 'caught_stealing', fmt: 'int' },
  GIDP: { key: 'grounded_into_dp', fmt: 'int' },
  AVG:  { key: 'batting_avg', fmt: 'avg', bold: true },
  OBP:  { key: 'on_base_pct', fmt: 'avg' },
  SLG:  { key: 'slugging_pct', fmt: 'avg' },
  OPS:  { key: 'ops', fmt: 'avg', bold: true },
  wOBA: { key: 'woba', fmt: 'avg' },
  'wRC+': { key: 'wrc_plus', fmt: 'int', bold: true },
  wRAA: { key: 'wraa', fmt: 'one' },
  wRC:  { key: 'wrc', fmt: 'int' },
  ISO:  { key: 'iso', fmt: 'avg' },
  BABIP:{ key: 'babip', fmt: 'avg' },
  'BB%':{ key: 'bb_pct', fmt: 'pct' },
  'K%': { key: 'k_pct', fmt: 'pct' },
  oWAR: { key: 'offensive_war', fmt: 'war' },
  // Plate discipline (PBP). Swing% = swings / pitches, Contact% = contact /
  // swings, Whiff% = whiffs / swings.
  'Sw%':  { key: 'swing_pct',   fmt: 'pct' },
  'Con%': { key: 'contact_pct', fmt: 'pct', bold: true },
  'Whf%': { key: 'whiff_pct',   fmt: 'pct' },
}

function fmtCol(p, fmt) {
  if (p == null) return '—'
  if (fmt === 'avg') return fmtAvg(p)
  if (fmt === 'pct') return fmtPct(p)
  if (fmt === 'war') return Number(p).toFixed(2)
  if (fmt === 'one') return Number(p).toFixed(1)
  if (fmt === 'int') return fmtInt(p)
  if (fmt === 'era') return fmtEra(p)
  return String(p)
}

// Columns where lower-is-better (default arrow points up). Everything
// else defaults to descending (arrow down).
const BATTING_ASC_COLS = new Set(['k_pct', 'grounded_into_dp'])

function BattingTab({ season }) {
  const [sort,      setSort]      = useState({ by: 'wrc_plus', dir: 'desc' })
  const [qualified, setQualified] = useState(true)
  const [preset,    setPreset]    = useState('Standard')

  const { data, loading, error } = useApi('/summer/leaderboards/batting',
    { league: LEAGUE, season, qualified, sort_by: sort.by, sort_dir: sort.dir, limit: 250 },
    [season, sort.by, sort.dir, qualified])

  if (loading) return <Skeleton />
  if (error) return <Err msg={error} />
  const cols = BATTING_PRESETS[preset]
  const handleSort = (col) => {
    const cfg = BATTING_COL_MAP[col]
    if (!cfg) return
    const apiKey = cfg.key
    // If clicking the active column → toggle dir. Otherwise → set the
    // column's natural direction.
    if (sort.by === apiKey) {
      setSort({ by: apiKey, dir: sort.dir === 'desc' ? 'asc' : 'desc' })
    } else {
      setSort({ by: apiKey, dir: BATTING_ASC_COLS.has(apiKey) ? 'asc' : 'desc' })
    }
  }
  return (
    <>
      <FilterBar>
        <Qualified value={qualified} onChange={setQualified} type="batting" />
      </FilterBar>
      <Presets value={preset} onChange={setPreset} options={Object.keys(BATTING_PRESETS)} />
      {!data?.length ? (
        <Empty msg={`No ${qualified ? 'qualified' : 'qualifying'} batters in ${season} yet.`} />
      ) : (
        <Scroll>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <PlayerTh /><Th left>Team</Th>
                {cols.map(c => {
                  const cfg = BATTING_COL_MAP[c]
                  const apiKey = cfg?.key
                  const active = apiKey === sort.by
                  return (
                    <SortableTh
                      key={c}
                      label={c}
                      active={active}
                      dir={active ? sort.dir : null}
                      sortable={!!cfg}
                      onClick={() => handleSort(c)}
                    />
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.player_id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/60">
                  <Player p={p} rank={i + 1} />
                  <Team p={p} />
                  {cols.map(c => {
                    const cfg = BATTING_COL_MAP[c]
                    if (!cfg) return <Td key={c} num>—</Td>
                    return <Td key={c} num bold={cfg.bold || cfg.key === sort.by}>{fmtCol(p[cfg.key], cfg.fmt)}</Td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
    </>
  )
}

// ─── Pitching ──────────────────────────────────────────────

const PITCHING_PRESETS = {
  Standard: ['G','GS','W','L','SV','IP','H','R','ER','BB','K','HR','ERA','WHIP'],
  Advanced: ['IP','BF','ERA','WHIP','FIP','K/9','BB/9','HR/9','K%','BB%','BABIP','pWAR'],
  Workload: ['G','GS','CG','SHO','IP','BF','W','L','SV'],
  Discipline:['IP','BF','K','BB','HBP','WP','K/9','BB/9','K%','BB%','K/BB'],
  // Pitch-level rates from PBP (whiff / called-or-swinging-strike / strike%).
  'Pitch-Level': ['IP','Whf%','CSW%','Str%','F-Str%','K%','BB%'],
}

const PITCHING_COL_MAP = {
  G:    { key: 'games', fmt: 'int' },
  GS:   { key: 'games_started', fmt: 'int' },
  CG:   { key: 'complete_games', fmt: 'int' },
  SHO:  { key: 'shutouts', fmt: 'int' },
  W:    { key: 'wins', fmt: 'int' },
  L:    { key: 'losses', fmt: 'int' },
  SV:   { key: 'saves', fmt: 'int' },
  IP:   { key: 'innings_pitched', fmt: 'one' },
  BF:   { key: 'batters_faced', fmt: 'int' },
  H:    { key: 'hits_allowed', fmt: 'int' },
  R:    { key: 'runs_allowed', fmt: 'int' },
  ER:   { key: 'earned_runs', fmt: 'int' },
  BB:   { key: 'walks', fmt: 'int' },
  K:    { key: 'strikeouts', fmt: 'int' },
  HR:   { key: 'home_runs_allowed', fmt: 'int' },
  HBP:  { key: 'hit_batters', fmt: 'int' },
  WP:   { key: 'wild_pitches', fmt: 'int' },
  ERA:  { key: 'era',  fmt: 'era', bold: true },
  WHIP: { key: 'whip', fmt: 'era' },
  FIP:  { key: 'fip',  fmt: 'era', bold: true },
  'K/9':{ key: 'k_per_9',  fmt: 'era' },
  'BB/9':{ key: 'bb_per_9', fmt: 'era' },
  'H/9':{ key: 'h_per_9',   fmt: 'era' },
  'HR/9':{ key: 'hr_per_9', fmt: 'era' },
  'K/BB':{ key: 'k_bb_ratio', fmt: 'era' },
  'K%': { key: 'k_pct',  fmt: 'pct' },
  'BB%':{ key: 'bb_pct', fmt: 'pct' },
  BABIP:{ key: 'babip_against', fmt: 'avg' },
  pWAR: { key: 'pitching_war', fmt: 'war' },
  // Pitch-level (PBP). CSW% = called+swinging strikes / pitches; Whf% =
  // whiffs / swings; Str% = strikes / pitches; F-Str% = first-pitch strike%.
  'Whf%':   { key: 'whiff_pct',    fmt: 'pct', bold: true },
  'CSW%':   { key: 'csw_pct',      fmt: 'pct', bold: true },
  'Str%':   { key: 'strike_pct',   fmt: 'pct' },
  'F-Str%': { key: 'f_strike_pct', fmt: 'pct' },
}


const PITCHING_ASC_COLS = new Set([
  'era', 'whip', 'fip', 'bb_pct', 'bb_per_9', 'h_per_9', 'hr_per_9',
  'hits_allowed', 'earned_runs', 'runs_allowed', 'home_runs_allowed',
  'losses', 'babip_against', 'hit_batters', 'wild_pitches',
])

function PitchingTab({ season }) {
  const [sort,      setSort]      = useState({ by: 'fip', dir: 'asc' })
  const [qualified, setQualified] = useState(true)
  const [preset,    setPreset]    = useState('Standard')

  const { data, loading, error } = useApi('/summer/leaderboards/pitching',
    { league: LEAGUE, season, qualified, sort_by: sort.by, sort_dir: sort.dir, limit: 250 },
    [season, sort.by, sort.dir, qualified])

  if (loading) return <Skeleton />
  if (error) return <Err msg={error} />
  const cols = PITCHING_PRESETS[preset]
  const handleSort = (col) => {
    const cfg = PITCHING_COL_MAP[col]
    if (!cfg) return
    const apiKey = cfg.key
    if (sort.by === apiKey) {
      setSort({ by: apiKey, dir: sort.dir === 'desc' ? 'asc' : 'desc' })
    } else {
      setSort({ by: apiKey, dir: PITCHING_ASC_COLS.has(apiKey) ? 'asc' : 'desc' })
    }
  }
  return (
    <>
      <FilterBar>
        <Qualified value={qualified} onChange={setQualified} type="pitching" />
      </FilterBar>
      <Presets value={preset} onChange={setPreset} options={Object.keys(PITCHING_PRESETS)} />
      {!data?.length ? (
        <Empty msg={`No ${qualified ? 'qualified' : 'qualifying'} pitchers in ${season} yet.`} />
      ) : (
        <Scroll>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <PlayerTh /><Th left>Team</Th>
                {cols.map(c => {
                  const cfg = PITCHING_COL_MAP[c]
                  const apiKey = cfg?.key
                  const active = apiKey === sort.by
                  return (
                    <SortableTh
                      key={c}
                      label={c}
                      active={active}
                      dir={active ? sort.dir : null}
                      sortable={!!cfg}
                      onClick={() => handleSort(c)}
                    />
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.player_id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/60">
                  <Player p={p} rank={i + 1} />
                  <Team p={p} />
                  {cols.map(c => {
                    const cfg = PITCHING_COL_MAP[c]
                    if (!cfg) return <Td key={c} num>—</Td>
                    return <Td key={c} num bold={cfg.bold || cfg.key === sort.by}>{fmtCol(p[cfg.key], cfg.fmt)}</Td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
    </>
  )
}

// ─── Fielding ──────────────────────────────────────────────

function FieldingTab({ season }) {
  const [sort,  setSort]  = useState('fielding_pct')
  const [minTc, setMinTc] = useState(3)
  const { data, loading, error } = useApi('/summer/leaderboards/fielding',
    { league: LEAGUE, season, min_chances: minTc, sort_by: sort, limit: 200 },
    [season, sort, minTc])

  if (loading) return <Skeleton />
  if (error) return <Err msg={error} />
  return (
    <>
      <FilterBar>
        <Sort
          label="Sort by"
          value={sort}
          onChange={setSort}
          options={[
            ['fielding_pct',         'FldPct'],
            ['total_chances',        'Chances'],
            ['putouts',              'Putouts'],
            ['assists',              'Assists'],
            ['errors',               'Errors (fewest first)'],
            ['double_plays',         'Double Plays'],
            ['stolen_bases_against', 'SB Against'],
            ['caught_stealing_by',   'Caught Stealing'],
            ['cs_pct',               'CS%'],
          ]}
        />
        <Min label="Min Chances" value={minTc} onChange={setMinTc} steps={[0, 3, 10, 25, 50, 100]} />
      </FilterBar>
      {!data?.length ? (
        <Empty msg={`No qualified fielders in ${season} with ${minTc}+ chances yet.`} />
      ) : (
        <Scroll>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <PlayerTh /><Th left>Pos</Th><Th left>Team</Th>
                {['G','TC','PO','A','E','DP','PB','SBA','CS','FldPct','CS%'].map(h => (
                  <Th key={h}>{h}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.player_id + '-' + i} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/60">
                  <Player p={p} rank={i + 1} />
                  <Td className="text-left text-gray-500 dark:text-gray-400 uppercase">{p.position || ''}</Td>
                  <Team p={p} />
                  <Td num>{fmtInt(p.games)}</Td>
                  <Td num>{fmtInt(p.total_chances)}</Td>
                  <Td num>{fmtInt(p.putouts)}</Td>
                  <Td num>{fmtInt(p.assists)}</Td>
                  <Td num>{fmtInt(p.errors)}</Td>
                  <Td num>{fmtInt(p.double_plays)}</Td>
                  <Td num>{fmtInt(p.passed_balls)}</Td>
                  <Td num>{fmtInt(p.stolen_bases_against)}</Td>
                  <Td num>{fmtInt(p.caught_stealing_by)}</Td>
                  <Td num bold>{p.fielding_pct != null ? fmtAvg(p.fielding_pct) : '—'}</Td>
                  <Td num>{fmtPct(p.cs_pct)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
    </>
  )
}

// ─── shared bits ──────────────────────────────────────────

function FilterBar({ children }) {
  return <div className="flex flex-wrap items-end gap-3 mb-3">{children}</div>
}

function SortableTh({ label, active, dir, sortable, onClick }) {
  const arrow = active ? (dir === 'asc' ? '▲' : '▼') : ''
  return (
    <th
      onClick={sortable ? onClick : undefined}
      className={`px-1.5 py-1.5 text-xs font-bold uppercase tracking-wide text-right ${
        sortable ? 'cursor-pointer hover:text-nw-teal dark:hover:text-teal-300 select-none' : ''
      } ${active ? 'text-nw-teal dark:text-teal-300' : 'text-gray-500 dark:text-gray-400'}`}
    >
      <span className="inline-flex items-center gap-0.5">
        {label}
        {arrow && <span className="text-[9px] leading-none">{arrow}</span>}
      </span>
    </th>
  )
}

function Min({ label, value, onChange, steps }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-0.5">{label}</label>
      <select
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100"
      >
        {steps.map(s => <option key={s} value={s}>{s === 0 ? 'No min' : `${s}+`}</option>)}
      </select>
    </div>
  )
}

// Labeled <select> for the Fielding tab's sort key. `options` is a list of
// [value, label] pairs; `value` is a plain string. (The Batting/Pitching tabs
// sort by clicking column headers instead, so this only exists here — it was
// referenced but never defined, which crashed /summer/stats on the Fielding
// tab with "Sort is not defined".)
function Sort({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-0.5">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100"
      >
        {options.map(([v, lbl]) => <option key={v} value={v}>{lbl}</option>)}
      </select>
    </div>
  )
}

function Qualified({ value, onChange, type }) {
  const threshold = type === 'pitching' ? '0.75 IP per team game' : '2.0 PA per team game'
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-0.5">Filter</label>
      <label className="flex items-center gap-2 px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={value}
          onChange={e => onChange(e.target.checked)}
          className="w-3.5 h-3.5"
        />
        <span>Qualified only</span>
        <span className="text-[10px] text-gray-500 dark:text-gray-400">({threshold})</span>
      </label>
    </div>
  )
}

function Presets({ value, onChange, options }) {
  return (
    <div className="flex items-center gap-1 mb-3 -mt-1 overflow-x-auto">
      <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mr-1 shrink-0">View</span>
      {options.map(opt => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`px-2.5 py-1 text-xs font-semibold rounded-md whitespace-nowrap transition ${
            value === opt
              ? 'bg-nw-teal text-white'
              : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}

function Scroll({ children }) {
  return (
    <div className="overflow-x-auto -mx-3 sm:mx-0">
      <div className="min-w-[1000px] px-3 sm:px-0">{children}</div>
    </div>
  )
}

function Th({ children, left }) {
  return (
    <th className={`px-1.5 py-1.5 text-xs font-bold text-gray-500 dark:text-gray-400 ${left ? 'text-left' : 'text-right'}`}>
      {children}
    </th>
  )
}

function Td({ children, num, bold, className = '' }) {
  return (
    <td className={`px-1.5 py-1 ${num ? 'text-right tabular-nums' : ''} ${bold ? 'font-bold' : ''} ${className}`}>
      {children}
    </td>
  )
}

// Sticky header cell for the frozen Player column. z-20 keeps it above the
// frozen body cells (z-10) where they meet at the top-left.
function PlayerTh() {
  return (
    <th className="sticky left-0 z-20 bg-white dark:bg-gray-900 px-2 py-1.5 text-left text-xs font-bold text-gray-500 dark:text-gray-400 border-r border-gray-200 dark:border-gray-700">
      Player
    </th>
  )
}

// Frozen, compact name column. Sticks to the left edge so the player is always
// visible while the stat columns scroll on mobile. Rank is merged in (no
// separate # column), the first name is abbreviated, and long names truncate
// with the full name in a tooltip + on the linked profile.
function Player({ p, rank }) {
  return (
    <td className="sticky left-0 z-10 bg-white dark:bg-gray-900 px-2 py-1 border-r border-gray-200 dark:border-gray-700">
      <Link
        to={`/summer/players/${p.player_id}`}
        className="flex items-center gap-1.5 group"
        title={`${p.first_name} ${p.last_name}`}
      >
        {rank != null && (
          <span className="w-4 shrink-0 text-right text-[10px] text-gray-400 dark:text-gray-500 tabular-nums">{rank}</span>
        )}
        <span className="font-semibold text-gray-900 dark:text-gray-100 group-hover:text-nw-teal dark:group-hover:text-teal-300 truncate max-w-[104px] sm:max-w-[150px]">
          {p.first_name?.[0]}. {p.last_name}
        </span>
      </Link>
    </td>
  )
}

// Compact team column: logo always, short code only on sm+ (logo alone on
// mobile to save width). Full team name in the tooltip.
function Team({ p }) {
  return (
    <td className="px-1.5 py-1">
      <Link
        to={`/summer/teams/${p.team_id}`}
        className="flex items-center gap-1 text-nw-teal dark:text-teal-300 hover:underline"
        title={p.team_name}
      >
        {p.logo_url && <img src={p.logo_url} alt="" className="w-4 h-4 object-contain shrink-0" loading="lazy" />}
        <span className="hidden sm:inline truncate max-w-[72px]">{p.team_short || p.team_name}</span>
      </Link>
    </td>
  )
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-2 animate-pulse">
      {[0, 1, 2, 3, 4, 5, 6, 7].map(i => (
        <div key={i} className="h-9 rounded bg-gray-100 dark:bg-gray-800" />
      ))}
    </div>
  )
}

function Empty({ msg }) {
  return <div className="text-center py-12 text-gray-500 dark:text-gray-400 text-sm">{msg}</div>
}

function Err({ msg }) {
  return <div className="text-center py-12 text-rose-600 dark:text-rose-400 text-sm">{String(msg)}</div>
}
