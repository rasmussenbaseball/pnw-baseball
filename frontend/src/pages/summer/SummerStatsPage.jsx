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

function BattingTab({ season }) {
  const [sort,  setSort]  = useState('wrc_plus')
  const [minPa, setMinPa] = useState(10)
  const { data, loading, error } = useApi('/summer/leaderboards/batting',
    { league: LEAGUE, season, min_pa: minPa, sort_by: sort, limit: 200 },
    [season, sort, minPa])

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
            ['wrc_plus',     'wRC+'],
            ['woba',         'wOBA'],
            ['ops',          'OPS'],
            ['batting_avg',  'AVG'],
            ['on_base_pct',  'OBP'],
            ['slugging_pct', 'SLG'],
            ['iso',          'ISO'],
            ['home_runs',    'HR'],
            ['rbi',          'RBI'],
            ['bb_pct',       'BB%'],
            ['k_pct',        'K% (lower=better)'],
            ['offensive_war','oWAR'],
            ['stolen_bases', 'SB'],
          ]}
        />
        <Min label="Min PA" value={minPa} onChange={setMinPa} steps={[0, 10, 25, 50, 75, 100]} />
      </FilterBar>
      {!data?.length ? (
        <Empty msg={`No qualified batters in ${season} with ${minPa}+ PA yet.`} />
      ) : (
        <Scroll>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                {['#','Player','Team','PA','AVG','OBP','SLG','OPS','wOBA','wRC+','ISO','HR','BB%','K%','oWAR'].map((h, i) => (
                  <Th key={h} left={i < 3}>{h}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.player_id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/60">
                  <Rank>{i + 1}</Rank>
                  <Player p={p} />
                  <Team p={p} />
                  <Td num>{fmtInt(p.plate_appearances)}</Td>
                  <Td num>{fmtAvg(p.batting_avg)}</Td>
                  <Td num>{fmtAvg(p.on_base_pct)}</Td>
                  <Td num>{fmtAvg(p.slugging_pct)}</Td>
                  <Td num bold>{fmtAvg(p.ops)}</Td>
                  <Td num>{fmtAvg(p.woba)}</Td>
                  <Td num bold>{p.wrc_plus != null ? Math.round(p.wrc_plus) : '—'}</Td>
                  <Td num>{fmtAvg(p.iso)}</Td>
                  <Td num>{fmtInt(p.home_runs)}</Td>
                  <Td num>{fmtPct(p.bb_pct)}</Td>
                  <Td num>{fmtPct(p.k_pct)}</Td>
                  <Td num>{p.offensive_war != null ? Number(p.offensive_war).toFixed(2) : '—'}</Td>
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

function PitchingTab({ season }) {
  const [sort,  setSort]  = useState('fip')
  const [minIp, setMinIp] = useState(3)
  const { data, loading, error } = useApi('/summer/leaderboards/pitching',
    { league: LEAGUE, season, min_ip: minIp, sort_by: sort, limit: 200 },
    [season, sort, minIp])

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
            ['fip',             'FIP (lower=better)'],
            ['era',             'ERA (lower=better)'],
            ['whip',            'WHIP (lower=better)'],
            ['k_pct',           'K%'],
            ['bb_pct',          'BB% (lower=better)'],
            ['k_per_9',         'K/9'],
            ['bb_per_9',        'BB/9 (lower=better)'],
            ['strikeouts',      'Total K'],
            ['wins',            'Wins'],
            ['saves',           'Saves'],
            ['innings_pitched', 'IP'],
            ['pitching_war',    'pWAR'],
          ]}
        />
        <Min label="Min IP" value={minIp} onChange={setMinIp} steps={[0, 3, 10, 20, 30, 50]} />
      </FilterBar>
      {!data?.length ? (
        <Empty msg={`No qualified pitchers in ${season} with ${minIp}+ IP yet.`} />
      ) : (
        <Scroll>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                {['#','Player','Team','IP','W','L','SV','K','BB','ERA','WHIP','FIP','K%','BB%','K/9','pWAR'].map((h, i) => (
                  <Th key={h} left={i < 3}>{h}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.player_id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/60">
                  <Rank>{i + 1}</Rank>
                  <Player p={p} />
                  <Team p={p} />
                  <Td num>{p.innings_pitched != null ? Number(p.innings_pitched).toFixed(1) : '—'}</Td>
                  <Td num>{fmtInt(p.wins)}</Td>
                  <Td num>{fmtInt(p.losses)}</Td>
                  <Td num>{fmtInt(p.saves)}</Td>
                  <Td num>{fmtInt(p.strikeouts)}</Td>
                  <Td num>{fmtInt(p.walks)}</Td>
                  <Td num bold>{fmtEra(p.era)}</Td>
                  <Td num>{fmtEra(p.whip)}</Td>
                  <Td num bold>{fmtEra(p.fip)}</Td>
                  <Td num>{fmtPct(p.k_pct)}</Td>
                  <Td num>{fmtPct(p.bb_pct)}</Td>
                  <Td num>{fmtEra(p.k_per_9)}</Td>
                  <Td num>{p.pitching_war != null ? Number(p.pitching_war).toFixed(2) : '—'}</Td>
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
                {['#','Player','Pos','Team','G','TC','PO','A','E','DP','PB','SBA','CS','FldPct','CS%'].map((h, i) => (
                  <Th key={h} left={i < 4}>{h}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.player_id + '-' + i} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/60">
                  <Rank>{i + 1}</Rank>
                  <Player p={p} />
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

function Sort({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-0.5">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100"
      >
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
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

function Rank({ children }) {
  return <td className="px-1.5 py-1 text-gray-500 dark:text-gray-400 tabular-nums">{children}</td>
}

function Player({ p }) {
  return (
    <td className="px-1.5 py-1 font-semibold text-gray-900 dark:text-gray-100">
      <Link to={`/summer/players/${p.player_id}`} className="hover:underline">
        {p.first_name} {p.last_name}
      </Link>
    </td>
  )
}

function Team({ p }) {
  return (
    <td className="px-1.5 py-1">
      <Link to={`/summer/teams/${p.team_id}`} className="text-nw-teal dark:text-teal-300 hover:underline">
        {p.team_short || p.team_name}
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
