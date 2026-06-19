// Shared sticky stat table for the JUCO + Transfer Portal trackers.
// Renders ONE table (Hitters OR Pitchers). Two-way players appear in
// both tables and get a small ⇄ icon next to their name.
//
// Frozen "Player Info" columns (#, Player, School, Pos, B/T, Yr,
// Committed) stay pinned on horizontal scroll. The group-header width
// (458) matches the summed frozen column widths so the stat header
// never gets painted over.

import { Link } from 'react-router-dom'
import { formatStat } from '../utils/stats'

// Division-level chip colors for a committed school (resolved server-side).
const COMMIT_LVL = {
  D1: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  D2: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  NAIA: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  D3: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
}

export const BATTING_COLS = [
  // oWAR leads — it's the default sort, so showing it first makes the ranking obvious.
  { key: 'offensive_war',  label: 'oWAR', format: 'war',  mono: true },
  { key: 'batting_avg',    label: 'AVG',  format: 'avg',  mono: true },
  { key: 'on_base_pct',    label: 'OBP',  format: 'avg',  mono: true },
  { key: 'slugging_pct',   label: 'SLG',  format: 'avg',  mono: true },
  { key: 'woba',           label: 'wOBA', format: 'avg',  mono: true },
  { key: 'wrc_plus',       label: 'wRC+', format: 'int',  mono: true },
  { key: 'home_runs',      label: 'HR',   format: 'int' },
  { key: 'rbi',            label: 'RBI',  format: 'int' },
  { key: 'stolen_bases',   label: 'SB',   format: 'int' },
  { key: 'plate_appearances', label: 'PA', format: 'int' },
  { key: 'bat_k_pct',      label: 'K%',      format: 'pct', mono: true },
  { key: 'bat_bb_pct',     label: 'BB%',     format: 'pct', mono: true },
  { key: 'contact_pct',    label: 'Contact%',format: 'pct', mono: true },
  { key: 'swing_pct',      label: 'Swing%',  format: 'pct', mono: true },
  { key: 'air_pull_pct',   label: 'AIRPULL%',format: 'pct', mono: true },
  { key: 'batter_wpa',     label: 'WPA',     format: 'wpa', mono: true },
]

export const PITCHING_COLS = [
  // pWAR leads — it's the default sort, so showing it first makes the ranking obvious.
  { key: 'pitching_war',   label: 'pWAR', format: 'war',  mono: true },
  { key: 'era',            label: 'ERA',  format: 'era',  mono: true },
  { key: 'fip',            label: 'FIP',  format: 'era',  mono: true },
  { key: 'fip_plus',       label: 'FIP+', format: 'int',  mono: true },
  { key: 'siera',          label: 'SIERA',format: 'era',  mono: true },
  { key: 'baa',            label: 'BAA',  format: 'avg',  mono: true },
  { key: 'pitch_k_pct',    label: 'K%',   format: 'pct',  mono: true },
  { key: 'pitch_bb_pct',   label: 'BB%',  format: 'pct',  mono: true },
  { key: 'whiff_pct',      label: 'Whiff%',  format: 'pct', mono: true },
  { key: 'strike_pct',     label: 'Strike%', format: 'pct', mono: true },
  { key: 'first_pitch_strike_pct', label: 'FPS%', format: 'pct', mono: true },
  { key: 'innings_pitched', label: 'IP',   format: 'ip' },
  { key: 'pitcher_wpa',    label: 'WPA',  format: 'wpa',  mono: true },
]

export const HITTER_STAT_COLS = [
  ...BATTING_COLS,
  { key: 'total_war', label: 'WAR', format: 'war', mono: true },
]
export const PITCHER_STAT_COLS = [
  ...PITCHING_COLS,
  { key: 'total_war', label: 'WAR', format: 'war', mono: true },
]

// Every displayed stat column is sortable. Derive the set from the column
// definitions so it can never drift from what's actually shown.
export const SORTABLE = new Set([
  'total_war',
  ...BATTING_COLS.map(c => c.key),
  ...PITCHING_COLS.map(c => c.key),
])
// Lower-is-better stats sort ascending by default when first clicked.
export const ASC_DEFAULT = new Set(['era', 'fip', 'siera', 'baa'])

// Pitcher position codes (covers two-way labels like "RHP/1B").
const PITCHER_POS = new Set(['P', 'RHP', 'LHP', 'SP', 'RP'])
function isPitcherPos(pos) {
  if (!pos) return false
  const u = String(pos).toUpperCase()
  return PITCHER_POS.has(u) || u.startsWith('RHP/') || u.startsWith('LHP/') || u.startsWith('P/')
}
// Classify by stats first; for players with no stats yet (e.g. a portal entry
// who hasn't played, or a redshirt), fall back to position so they still land
// on the correct Hitters / Pitchers list instead of disappearing from both.
export function isHitter(row) {
  if ((row.plate_appearances || 0) > 0) return true
  if ((row.innings_pitched || 0) > 0) return false
  return !isPitcherPos(row.position)
}
export function isPitcher(row) {
  if ((row.innings_pitched || 0) > 0) return true
  if ((row.plate_appearances || 0) > 0) return false
  return isPitcherPos(row.position)
}
export function isTwoWay(row) { return isHitter(row) && isPitcher(row) }

function fmtCell(row, col) {
  const val = row[col.key]
  if (col.format === 'pct') return val != null ? (Number(val) * 100).toFixed(1) + '%' : '-'
  if (col.format === 'int') return val != null ? Math.round(val) : '-'
  if (col.format === 'ip') return val ? formatStat(val, 'ip') : '-'
  if (col.format === 'wpa') return val != null ? (val >= 0 ? '+' : '') + Number(val).toFixed(2) : '-'
  if (col.format) return formatStat(val, col.format)
  return val ?? '-'
}

function TwoWayIcon() {
  return (
    <span
      title="Two-way player. Appears on both the Hitters and Pitchers tables."
      className="ml-1 inline-flex items-center justify-center text-[9px] font-bold text-white bg-nw-teal rounded px-1 leading-tight align-middle"
    >
      2WAY
    </span>
  )
}

// Segmented Hitters / Pitchers selector shown above the tracker table.
// Counts are optional (pass null while data is loading).
export function BoardToggle({ board, onChange, hitterCount = null, pitcherCount = null }) {
  const tab = (key, label, count) => (
    <button
      type="button"
      onClick={() => onChange(key)}
      aria-pressed={board === key}
      className={`px-5 py-1.5 text-sm font-semibold transition-colors ${
        board === key
          ? 'bg-nw-teal text-white'
          : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
      }`}
    >
      {label}{count != null ? ` (${count})` : ''}
    </button>
  )
  return (
    <div className="inline-flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden mb-4 divide-x divide-gray-300 dark:divide-gray-600">
      {tab('hitters', 'Hitters', hitterCount)}
      {tab('pitchers', 'Pitchers', pitcherCount)}
    </div>
  )
}

// Awards cell — gold gloves, all-conference honors, and top-10-in-level stats,
// from the tracker endpoints' `awards` field. Compact badges with full detail
// in the tooltip so a coach can scan honors right on the tracker.
const _AC_RANK = { '1st': 0, '2nd': 1, 'HM': 2 }
function AwardsCell({ awards }) {
  const gg = awards?.gold_gloves || []
  const ac = awards?.all_conference || []
  const t10 = awards?.top10 || []
  if (!gg.length && !ac.length && !t10.length) return <span className="text-gray-300 dark:text-gray-600">-</span>
  const ggTitle = gg.map(g => `${g.season} ${g.scope} Gold Glove${g.mvp ? ' MVP' : ''} (${g.position})`).join('\n')
  const acTitle = ac.map(a => `${a.season} All-${a.scope} ${a.team === '1st' ? '1st Team' : a.team === '2nd' ? '2nd Team' : 'Honorable Mention'}${a.position ? ` (${a.position})` : ''}`).join('\n')
  const best = [...ac].sort((a, b) => (_AC_RANK[a.team] ?? 9) - (_AC_RANK[b.team] ?? 9))[0]
  return (
    <div className="flex items-center gap-1 whitespace-nowrap">
      {gg.length > 0 && (
        <span title={ggTitle} className="text-[9px] font-bold px-1 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 whitespace-nowrap">
          🥇 Gold Glove{gg.length > 1 ? 's' : ''}: {gg.map(g => g.scope + (g.mvp ? ' MVP' : '')).join(', ')}
        </span>
      )}
      {ac.length > 0 && (
        <span title={acTitle} className="text-[9px] font-bold px-1 py-0.5 rounded bg-indigo-100 text-indigo-800 border border-indigo-300 whitespace-nowrap">⭐ All-Conf {best?.team || ''}</span>
      )}
      {t10.length > 0 && (
        <span title={`Top 10 in their level: ${t10.join(', ')}`} className="text-[9px] font-bold px-1 py-0.5 rounded bg-teal-100 text-teal-800 border border-teal-300 whitespace-nowrap">T10 {t10.join('/')}</span>
      )}
    </div>
  )
}

export default function PlayerTrackerTable({
  rows, statCols, groupLabel, sortBy, sortDir, onSort,
  infoLabel = 'Team', committedHeader = 'Committed',
}) {
  const hasAwards = (rows || []).some(r => r && r.awards)
  const sortArrow = (key) => {
    if (!SORTABLE.has(key)) return null
    if (sortBy !== key) return <span className="text-gray-300 ml-0.5">↕</span>
    return <span className="text-nw-teal ml-0.5">{sortDir === 'desc' ? '↓' : '↑'}</span>
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border overflow-x-auto relative">
      <table className="w-full text-[11px] leading-tight border-collapse">
        <thead>
          {/* Category header row */}
          <tr className="sticky top-0 z-20 bg-nw-teal">
            <th colSpan={7} style={{width:488,minWidth:488,maxWidth:488}} className="sticky left-0 z-30 bg-nw-teal text-white text-[10px] font-semibold tracking-wider uppercase px-2 py-1 text-left border-r border-white/10">
              Player Info
            </th>
            <th colSpan={statCols.length} className="bg-nw-teal text-white text-[10px] font-semibold tracking-wider uppercase px-2 py-1 text-center">
              {groupLabel}
            </th>
            {hasAwards && (
              <th className="bg-nw-teal text-white text-[10px] font-semibold tracking-wider uppercase px-2 py-1 text-center border-l border-white/10">
                Honors
              </th>
            )}
          </tr>
          {/* Column header row */}
          <tr className="sticky top-[25px] z-20 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
            <th style={{width:28,minWidth:28,maxWidth:28}} className="sticky left-0 z-30 bg-gray-50 dark:bg-gray-900 px-1 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-right border-r border-gray-100 dark:border-gray-700">#</th>
            <th style={{width:140,minWidth:140,maxWidth:140}} className="sticky left-[28px] z-30 bg-gray-50 dark:bg-gray-900 px-1.5 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-left">Player</th>
            <th style={{width:90,minWidth:90,maxWidth:90}} className="sticky left-[168px] z-30 bg-gray-50 dark:bg-gray-900 px-1.5 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-left">{infoLabel}</th>
            <th style={{width:40,minWidth:40,maxWidth:40}} className="sticky left-[258px] z-30 bg-gray-50 dark:bg-gray-900 px-1 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-left">Pos</th>
            <th style={{width:32,minWidth:32,maxWidth:32}} className="sticky left-[298px] z-30 bg-gray-50 dark:bg-gray-900 px-1 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-left">B/T</th>
            <th style={{width:28,minWidth:28,maxWidth:28}} className="sticky left-[330px] z-30 bg-gray-50 dark:bg-gray-900 px-1 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-left">Yr</th>
            <th style={{width:130,minWidth:130,maxWidth:130}} className="sticky left-[358px] z-30 bg-gray-50 dark:bg-gray-900 px-1.5 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-left border-r border-gray-200 dark:border-gray-700">{committedHeader}</th>
            {statCols.map(col => (
              <th
                key={col.key}
                onClick={() => onSort(col.key)}
                className={`px-1.5 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-right whitespace-nowrap ${
                  SORTABLE.has(col.key) ? 'cursor-pointer select-none hover:text-nw-teal' : ''
                } ${sortBy === col.key ? 'text-nw-teal bg-teal-50/50' : ''}`}
              >
                {col.label}{sortArrow(col.key)}
              </th>
            ))}
            {hasAwards && (
              <th className="px-2 py-1.5 text-gray-500 dark:text-gray-400 font-semibold text-left whitespace-nowrap border-l border-gray-200 dark:border-gray-700">Awards</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id} className={`border-b border-gray-100 dark:border-gray-700/60 hover:bg-teal-50 dark:hover:bg-teal-900 ${i % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50 dark:bg-gray-900'}`}>
              <td style={{width:28,minWidth:28,maxWidth:28}} className="sticky left-0 z-10 bg-inherit px-1 py-1 text-gray-400 dark:text-gray-500 text-right text-[10px] border-r border-gray-100 dark:border-gray-700">{i + 1}</td>
              <td style={{width:140,minWidth:140,maxWidth:140}} className="sticky left-[28px] z-10 bg-inherit px-1.5 py-1 font-medium overflow-hidden">
                <span className="flex items-center whitespace-nowrap">
                  <Link to={`/player/${row.id}`} className="text-nw-teal hover:underline truncate">
                    {row.first_name} {row.last_name}
                  </Link>
                  {isTwoWay(row) && <TwoWayIcon />}
                </span>
              </td>
              <td style={{width:90,minWidth:90,maxWidth:90}} className="sticky left-[168px] z-10 bg-inherit px-1.5 py-1 overflow-hidden">
                <div className="flex items-center gap-1 max-w-full">
                  {row.logo_url && (
                    <img src={row.logo_url} alt="" className="w-4 h-4 object-contain shrink-0"
                      onError={(e) => { e.target.style.display = 'none' }} />
                  )}
                  <span className="text-gray-600 dark:text-gray-400 truncate">{row.team_short || row.team_name}</span>
                </div>
              </td>
              <td style={{width:40,minWidth:40,maxWidth:40}} className="sticky left-[258px] z-10 bg-inherit px-1 py-1 text-gray-500 dark:text-gray-400 truncate overflow-hidden">{row.position || '-'}</td>
              <td style={{width:32,minWidth:32,maxWidth:32}} className="sticky left-[298px] z-10 bg-inherit px-1 py-1 text-gray-500 dark:text-gray-400 truncate overflow-hidden">{row.bats || '-'}/{row.throws || '-'}</td>
              <td style={{width:28,minWidth:28,maxWidth:28}} className="sticky left-[330px] z-10 bg-inherit px-1 py-1 text-gray-500 dark:text-gray-400 truncate overflow-hidden">{row.year_in_school || '-'}</td>
              <td style={{width:130,minWidth:130,maxWidth:130}} className="sticky left-[358px] z-10 bg-inherit px-1.5 py-1 border-r border-gray-200 dark:border-gray-700 overflow-hidden">
                {row.committed_to ? (
                  <span title={`${row.committed_to}${row.committed_level ? ' (' + row.committed_level + ')' : ''}`} className="inline-flex items-center gap-1 max-w-full align-middle">
                    {row.committed_level && (
                      <span className={`shrink-0 text-[8px] font-extrabold px-1 py-0.5 rounded ${COMMIT_LVL[row.committed_level] || 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}>{row.committed_level}</span>
                    )}
                    <span className="px-1.5 py-0.5 text-[10px] font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 rounded truncate">{row.committed_to}</span>
                  </span>
                ) : (
                  <span className="text-gray-400 dark:text-gray-500">-</span>
                )}
              </td>
              {statCols.map(col => (
                <td
                  key={col.key}
                  className={`px-1.5 py-1 text-right whitespace-nowrap ${
                    col.mono ? 'font-mono' : ''
                  } ${sortBy === col.key ? 'bg-teal-50/50 font-semibold' : 'text-gray-600 dark:text-gray-400'}`}
                >
                  {fmtCell(row, col)}
                </td>
              ))}
              {hasAwards && (
                <td className="px-2 py-1 border-l border-gray-100 dark:border-gray-700">
                  <AwardsCell awards={row.awards} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-3 py-1.5 text-[11px] text-gray-400 dark:text-gray-500 border-t">
        Showing {rows.length} {rows.length === 1 ? 'player' : 'players'}
      </div>
    </div>
  )
}
