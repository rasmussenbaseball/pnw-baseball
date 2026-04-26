import { usePlayerPitchLevelStats } from '../hooks/useApi'
import SprayChart from './SprayChart'

/**
 * Pitch-Level Stats card — Phase G redesign.
 *
 * Sections (top to bottom):
 *   1. Header     — name + sample sizes + color legend
 *   2. Plate Discipline   — colored tiles (swing/whiff/contact/F1/putaway/P-PA/LI)
 *   3. Batted Ball        — colored tiles (GB/FB/LD/PU + Pull/Center/Oppo) + SprayChart
 *   4. Count Battle       — slash table per count state, color-coded
 *   5. Pitcher Hand Splits — slash table vs LHP/RHP, color-coded
 *   6. Situational        — slash table by base/inning/leverage state
 *
 * Color semantics: every metric is bucketed against per-division decile
 * thresholds. Direction varies:
 *   high = good for hitter   → red end of the spectrum
 *   low  = good for hitter   → blue end
 *   neutral (style metrics like GB%/Pull%) → just shows position vs league
 *
 * wRC+ across rows uses the OVERALL league wOBA as the baseline so
 * situational wRC+ swings around 100 meaningfully (not always = 100).
 */

export default function PitchLevelStatsCard({ playerId, season }) {
  const { data, loading, error } = usePlayerPitchLevelStats(playerId, season)

  if (loading) return null
  if (error)   return null
  if (!data?.discipline?.tracked_pa) return null

  const d = data.discipline
  const cp = data.contact_profile || {}
  const trackedShare = d.total_pa ? Math.round((d.tracked_pa / d.total_pa) * 100) : 0

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 sm:p-6 mt-6 overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-lg font-bold text-gray-900">Pitch-Level Stats</h3>
        <span className="text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
          Beta
        </span>
      </div>
      <p className="text-[11px] text-gray-500 mb-2">
        {d.total_pa} PA total · {d.tracked_pa} with pitch data ({trackedShare}%) · {d.pitches} pitches seen
      </p>
      <div className="flex items-center gap-2 text-[10px] text-gray-500 mb-5 flex-wrap">
        <span>Color vs {data.division_level} decile rank:</span>
        <ColorScale />
        <span className="text-gray-400">(hover any cell for league average)</span>
      </div>

      {/* ── 1. Plate Discipline ── */}
      <SectionHeader>Plate Discipline</SectionHeader>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-3">
        <ColorTile label="Swing %"          metric="swing_pct"
          value={d.swing_pct}   sub={`${d.swings} of ${d.pitches}`}
          league={d.league} deciles={d.deciles} formatter={fmtPct} />
        <ColorTile label="Whiff %"          metric="whiff_pct"
          value={d.whiff_pct}   sub={`${d.whiffs} of ${d.swings}`}
          league={d.league} deciles={d.deciles} formatter={fmtPct} />
        <ColorTile label="Contact %"        metric="contact_pct"
          value={d.contact_pct} sub={`vs lg ${fmtPct(d.league?.contact_pct)}`}
          league={d.league} deciles={d.deciles} formatter={fmtPct} />
        <ColorTile label="P / PA"           metric="pitches_per_pa"
          value={d.pitches_per_pa} sub={`${d.pitches}÷${d.tracked_pa}`}
          league={d.league} deciles={d.deciles} formatter={(v) => fmtNum(v, 2)} />
        <Tile label="Avg LI" value={fmtNum(d.avg_li, 2)}
              sub={d.li_pa ? `peak ${fmtNum(d.max_li, 1)}` : '—'} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
        <ColorTile label="1st-Pitch Swing"  metric="first_pitch_swing_pct"
          value={d.first_pitch_swing_pct}   sub={`vs lg ${fmtPct(d.league?.first_pitch_swing_pct)}`}
          league={d.league} deciles={d.deciles} formatter={fmtPct} />
        <ColorTile label="1st-Pitch Strike" metric="first_pitch_strike_pct"
          value={d.first_pitch_strike_pct}  sub={`vs lg ${fmtPct(d.league?.first_pitch_strike_pct)}`}
          league={d.league} deciles={d.deciles} formatter={fmtPct} />
        <ColorTile label="0-0 BIP %"        metric="first_pitch_in_play_pct"
          value={d.first_pitch_in_play_pct} sub={`vs lg ${fmtPct(d.league?.first_pitch_in_play_pct)}`}
          league={d.league} deciles={d.deciles} formatter={fmtPct} />
        <ColorTile label="Putaway %"        metric="putaway_pct"
          value={d.putaway_pct} sub={`of ${d.two_strike_pa} 2K PAs`}
          league={d.league} deciles={d.deciles} formatter={fmtPct} />
      </div>

      {/* ── 2. Batted Ball Profile ── */}
      {cp.bb_total > 0 && (
        <>
          <SectionHeader>Batted Ball Profile</SectionHeader>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <ColorTile label="GB %" metric="gb_pct" value={cp.gb_pct}
              sub={`${cp.gb_count} of ${cp.bb_total}`}
              league={d.league} deciles={d.deciles} formatter={fmtPct} />
            <ColorTile label="LD %" metric="ld_pct" value={cp.ld_pct}
              sub={`${cp.ld_count} of ${cp.bb_total}`}
              league={d.league} deciles={d.deciles} formatter={fmtPct} />
            <ColorTile label="FB %" metric="fb_pct" value={cp.fb_pct}
              sub={`${cp.fb_count} of ${cp.bb_total}`}
              league={d.league} deciles={d.deciles} formatter={fmtPct} />
            <ColorTile label="PU %" metric="pu_pct" value={cp.pu_pct}
              sub={`${cp.pu_count} of ${cp.bb_total}`}
              league={d.league} deciles={d.deciles} formatter={fmtPct} />
          </div>
          {cp.spray_total > 0 && (
            <div className="grid grid-cols-3 gap-2 mb-3">
              <Tile label="Pull %"   value={fmtPct(cp.pull_pct)}   sub={`of ${cp.spray_total}`} />
              <Tile label="Center %" value={fmtPct(cp.center_pct)} sub={`of ${cp.spray_total}`} />
              <Tile label="Oppo %"   value={fmtPct(cp.oppo_pct)}   sub={`of ${cp.spray_total}`} />
            </div>
          )}
          {data.spray_chart && data.spray_chart.all_total > 0 && (
            <div className="mt-2 mb-6">
              <SprayChart data={data.spray_chart} bats={cp.bats} defaultFilter="all" />
            </div>
          )}
        </>
      )}

      {/* ── 3. Count Battle ── */}
      <SectionHeader>Count Battle</SectionHeader>
      <DataTable minWidth={780} className="mb-6">
        <thead>
          <HeaderRow>
            <Th align="left">Count</Th>
            <Th>PA</Th>
            <Th>BIP</Th>
            <Th>BA</Th>
            <Th>OBP</Th>
            <Th>SLG</Th>
            <Th>OPS</Th>
            <Th>ISO</Th>
            <Th>wOBA</Th>
            <Th>wRC+</Th>
            <Th>Swing%</Th>
            <Th>Contact%</Th>
          </HeaderRow>
        </thead>
        <tbody>
          {data.count_states.map((cs) => (
            <BodyRow key={cs.label}>
              <CountCell label={cs.label} detail={cs.detail} />
              <NumCell value={cs.pa} muted={false} />
              <NumCell value={cs.bip} muted />
              <ColorCell row={cs} metric="ba" formatter={fmtRate} bold />
              <ColorCell row={cs} metric="obp" formatter={fmtRate} />
              <ColorCell row={cs} metric="slg" formatter={fmtRate} />
              <ColorCell row={cs} metric="ops" formatter={fmtRate} />
              <ColorCell row={cs} metric="iso" formatter={fmtRate} />
              <ColorCell row={cs} metric="woba" formatter={fmtRate} />
              <ColorCell row={cs} metric="wrc_plus" formatter={fmtInt} />
              <ColorCell row={cs} metric="swing_pct" formatter={fmtPct} />
              <ColorCell row={cs} metric="contact_pct" formatter={fmtPct} />
            </BodyRow>
          ))}
        </tbody>
      </DataTable>

      {/* ── 4. Pitcher Hand Splits ── */}
      <SectionHeader>Pitcher Hand Splits</SectionHeader>
      <DataTable minWidth={860} className="mb-6">
        <thead>
          <HeaderRow>
            <Th align="left">Split</Th>
            <Th>PA</Th>
            <Th>BIP</Th>
            <Th>BA</Th>
            <Th>OBP</Th>
            <Th>SLG</Th>
            <Th>OPS</Th>
            <Th>ISO</Th>
            <Th>wOBA</Th>
            <Th>wRC+</Th>
            <Th>K%</Th>
            <Th>BB%</Th>
            <Th>Swing%</Th>
          </HeaderRow>
        </thead>
        <tbody>
          {data.lr_splits.map((sp) => (
            <BodyRow key={sp.label}>
              <CountCell label={sp.label} />
              <NumCell value={sp.pa} muted={false} />
              <NumCell value={sp.bip} muted />
              <ColorCell row={sp} metric="ba" formatter={fmtRate} bold />
              <ColorCell row={sp} metric="obp" formatter={fmtRate} />
              <ColorCell row={sp} metric="slg" formatter={fmtRate} />
              <ColorCell row={sp} metric="ops" formatter={fmtRate} />
              <ColorCell row={sp} metric="iso" formatter={fmtRate} />
              <ColorCell row={sp} metric="woba" formatter={fmtRate} />
              <ColorCell row={sp} metric="wrc_plus" formatter={fmtInt} />
              <ColorCell row={sp} metric="k_pct" formatter={fmtPct} />
              <ColorCell row={sp} metric="bb_pct" formatter={fmtPct} />
              <ColorCell row={sp} metric="swing_pct" formatter={fmtPct} />
            </BodyRow>
          ))}
        </tbody>
      </DataTable>

      {/* ── 5. Situational Performance ── */}
      {data.situational_splits?.length > 0 && (
        <>
          <SectionHeader>Situational Performance</SectionHeader>
          <DataTable minWidth={860}>
            <thead>
              <HeaderRow>
                <Th align="left">Split</Th>
                <Th>PA</Th>
                <Th>BIP</Th>
                <Th>BA</Th>
                <Th>OBP</Th>
                <Th>SLG</Th>
                <Th>OPS</Th>
                <Th>wOBA</Th>
                <Th>wRC+</Th>
                <Th>K%</Th>
                <Th>BB%</Th>
              </HeaderRow>
            </thead>
            <tbody>
              {data.situational_splits.map((sp) => (
                <BodyRow key={sp.label}>
                  <CountCell label={sp.label} detail={sp.detail} />
                  <NumCell value={sp.pa} muted={false} />
                  <NumCell value={sp.bip} muted />
                  <ColorCell row={sp} metric="ba" formatter={fmtRate} bold />
                  <ColorCell row={sp} metric="obp" formatter={fmtRate} />
                  <ColorCell row={sp} metric="slg" formatter={fmtRate} />
                  <ColorCell row={sp} metric="ops" formatter={fmtRate} />
                  <ColorCell row={sp} metric="woba" formatter={fmtRate} />
                  <ColorCell row={sp} metric="wrc_plus" formatter={fmtInt} />
                  <ColorCell row={sp} metric="k_pct" formatter={fmtPct} />
                  <ColorCell row={sp} metric="bb_pct" formatter={fmtPct} />
                </BodyRow>
              ))}
            </tbody>
          </DataTable>
          <p className="text-[10px] text-gray-400 mt-2 italic">
            Situational splits use base/out/score state from PBP. Some 2026 PAs are not yet
            state-derived (especially OOC opponents) — totals here may be slightly lower than
            the season totals above.
          </p>
        </>
      )}
    </div>
  )
}

// ── Formatters ──────────────────────────────────────────────────
const fmtPct = (v) => v == null ? '-' : `${(v * 100).toFixed(0)}%`
const fmtRate = (v) => v == null ? '-' : (v >= 1 ? v.toFixed(3) : v.toFixed(3).replace(/^0/, ''))
const fmtNum = (v, digits = 0) => v == null ? '-' : v.toFixed(digits)
const fmtInt = (v) => v == null ? '-' : Math.round(v)

// ── Layout primitives (shared style) ────────────────────────────

function SectionHeader({ children }) {
  return (
    <h4 className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold mb-2 mt-1">
      {children}
    </h4>
  )
}

function DataTable({ children, minWidth = 700, className = '' }) {
  return (
    <div className={`overflow-x-auto -mx-4 sm:mx-0 ${className}`}>
      <table className="w-full text-xs border-collapse" style={{ minWidth: `${minWidth}px` }}>
        {children}
      </table>
    </div>
  )
}

function HeaderRow({ children }) {
  return (
    <tr className="bg-gray-50 text-gray-600 uppercase tracking-wide text-[10px] border-b border-gray-200">
      {children}
    </tr>
  )
}

function Th({ children, align = 'center' }) {
  const cls = align === 'left' ? 'text-left' : 'text-center'
  return (
    <th className={`${cls} px-3 py-2 align-middle font-semibold whitespace-nowrap`}>
      {children}
    </th>
  )
}

function BodyRow({ children }) {
  return <tr className="border-b border-gray-100 last:border-0">{children}</tr>
}

function CountCell({ label, detail }) {
  return (
    <td className="px-3 py-2.5 align-middle whitespace-nowrap border-r border-gray-100">
      <span className="font-medium text-gray-900">{label}</span>
      {detail && <span className="text-gray-400 ml-1.5">· {detail}</span>}
    </td>
  )
}

function NumCell({ value, muted = false }) {
  const cls = `text-center px-3 py-2.5 align-middle tabular-nums ${muted ? 'text-gray-400' : 'text-gray-700'}`
  return <td className={cls}>{value ?? '-'}</td>
}

// ── Color coding (Savant-style) ─────────────────────────────────

const METRIC_DIRECTION = {
  // Outcome metrics (high = better for hitter, RED end is good)
  ba: 'high', obp: 'high', slg: 'high', ops: 'high',
  iso: 'high', woba: 'high', wrc_plus: 'high',
  // Plate-discipline outcomes
  contact_pct: 'high', bb_pct: 'high',
  k_pct: 'low', whiff_pct: 'low',
  // Aggression / approach (NEUTRAL polarity — color shows position vs league.
  // High = aggressive / patient depending on metric. Blue = more passive,
  // Red = more aggressive.)
  swing_pct: 'high',
  first_pitch_swing_pct: 'high',
  first_pitch_strike_pct: 'high',
  first_pitch_in_play_pct: 'high',
  pitches_per_pa: 'high',                // higher = more selective / patient
  // 2-strike survival: lower putaway% = better for the hitter
  putaway_pct: 'low',
  // Batted-ball profile (style — color shows position vs league)
  gb_pct: 'high', fb_pct: 'high', ld_pct: 'high', pu_pct: 'high',
}

const SHADE_PALETTE = [
  'bg-blue-700 text-white',     // 0
  'bg-blue-500 text-white',
  'bg-blue-400 text-white',
  'bg-blue-300 text-gray-900',
  'bg-blue-100 text-gray-900',
  'bg-gray-50  text-gray-900',  // 5
  'bg-red-100  text-gray-900',
  'bg-red-300  text-gray-900',
  'bg-red-400  text-white',
  'bg-red-500  text-white',
  'bg-red-700  text-white',     // 10
]

function shadeForValue(metric, value, deciles) {
  if (value == null || !deciles) return null
  const dir = METRIC_DIRECTION[metric]
  if (!dir) return null
  const min = deciles[0], max = deciles[deciles.length - 1]
  if (min === max) return null
  let idx = 0
  for (let i = 0; i < deciles.length; i++) {
    if (value > deciles[i]) idx = i + 1
  }
  if (dir === 'low') idx = 10 - idx
  return idx
}

function tooltipLabel(metric) {
  const map = {
    ba: 'BA', obp: 'OBP', slg: 'SLG', ops: 'OPS', iso: 'ISO',
    woba: 'wOBA', wrc_plus: 'wRC+',
    k_pct: 'K%', bb_pct: 'BB%',
    swing_pct: 'Swing%', whiff_pct: 'Whiff%', contact_pct: 'Contact%',
    first_pitch_swing_pct: '1st-pitch Swing%',
    first_pitch_strike_pct: '1st-pitch Strike%',
    first_pitch_in_play_pct: '0-0 BIP%',
    putaway_pct: 'Putaway%', pitches_per_pa: 'P/PA',
    gb_pct: 'GB%', fb_pct: 'FB%', ld_pct: 'LD%', pu_pct: 'PU%',
  }
  return map[metric] || metric.toUpperCase()
}

function ColorCell({ row, metric, formatter, bold = false }) {
  const value = row[metric]
  const lg = row.league || {}
  const decs = (row.deciles || {})[metric]
  const idx = shadeForValue(metric, value, decs)
  const shade = idx != null ? SHADE_PALETTE[idx] : ''
  const valueText = formatter(value)
  const leagueValue = lg[metric]
  const leagueText = leagueValue != null ? formatter(leagueValue) : '—'
  return (
    <td className={`relative group text-center px-3 py-2.5 align-middle tabular-nums ${shade} ${bold ? 'font-semibold' : ''}`}>
      {valueText}
      <span className="pointer-events-none absolute z-30 left-1/2 -translate-x-1/2 bottom-full mb-1
                       opacity-0 group-hover:opacity-100 transition-opacity
                       whitespace-nowrap rounded bg-gray-900 text-white text-[10px] px-2 py-1 shadow-lg">
        Lg {tooltipLabel(metric)}: {leagueText}
      </span>
    </td>
  )
}

function ColorScale() {
  const swatches = [
    'bg-blue-700', 'bg-blue-500', 'bg-blue-400', 'bg-blue-300', 'bg-blue-100',
    'bg-gray-50', 'bg-red-100', 'bg-red-300', 'bg-red-400', 'bg-red-500', 'bg-red-700'
  ]
  return (
    <span className="inline-flex items-center gap-[1px]">
      <span className="text-[9px] text-gray-500 mr-1">passive / low</span>
      {swatches.map((c, i) => (
        <span key={i} className={`inline-block w-3 h-3 ${c} border border-gray-200`}></span>
      ))}
      <span className="text-[9px] text-gray-500 ml-1">aggressive / high</span>
    </span>
  )
}

function Tile({ label, value, sub }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[80px] py-2 px-2 border border-gray-100 rounded bg-gray-50">
      <div className="text-[9px] uppercase tracking-wide text-gray-500 font-semibold text-center">
        {label}
      </div>
      <div className="text-base sm:text-lg font-bold text-gray-900 tabular-nums my-0.5">
        {value ?? '-'}
      </div>
      <div className="text-[9px] text-gray-400 text-center">{sub}</div>
    </div>
  )
}

function ColorTile({ label, metric, value, sub, league, deciles, formatter }) {
  const decs = deciles?.[metric]
  const idx = shadeForValue(metric, value, decs)
  const shade = idx != null ? SHADE_PALETTE[idx] : 'bg-gray-50 text-gray-900'
  const leagueText = league?.[metric] != null ? formatter(league[metric]) : '—'
  return (
    <div className={`relative group flex flex-col items-center justify-center min-h-[80px] py-2 px-2 rounded border border-gray-100 ${shade}`}>
      <div className="text-[9px] uppercase tracking-wide font-semibold text-center opacity-90">
        {label}
      </div>
      <div className="text-base sm:text-lg font-bold tabular-nums my-0.5">
        {value == null ? '-' : formatter(value)}
      </div>
      <div className="text-[9px] opacity-75 text-center">{sub}</div>
      <span className="pointer-events-none absolute z-30 left-1/2 -translate-x-1/2 -top-1 -translate-y-full
                       opacity-0 group-hover:opacity-100 transition-opacity
                       whitespace-nowrap rounded bg-gray-900 text-white text-[10px] px-2 py-1 shadow-lg">
        Lg {tooltipLabel(metric)}: {leagueText}
      </span>
    </div>
  )
}
