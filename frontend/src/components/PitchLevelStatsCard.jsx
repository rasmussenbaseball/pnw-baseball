import { usePlayerPitchLevelStats } from '../hooks/useApi'

/**
 * Pitch-Level Stats card for a hitter.
 *
 * Color coding: each comparable cell is bucketed against the player's
 * own division's decile distribution for that filter. 10 shades from
 * dark blue (worst decile) to dark red (best decile), with neutral
 * gray near the median. K%/Whiff% inverted (low is good).
 *
 * Tooltip on every colored cell shows the league average for that
 * exact filter — e.g. NAIA hitters in 2-strike counts.
 */
export default function PitchLevelStatsCard({ playerId, season }) {
  const { data, loading, error } = usePlayerPitchLevelStats(playerId, season)

  if (loading || error || !data) return null
  const d = data.discipline
  if (!d || !d.total_pa) return null

  const trackedShare = d.tracked_pa > 0
    ? Math.round(100 * d.tracked_pa / d.total_pa)
    : 0

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 sm:p-6 mb-4 sm:mb-6">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-xs sm:text-sm font-semibold text-gray-600 uppercase tracking-wider flex items-center gap-2">
          Pitch-Level Stats
          <span className="text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
            Beta
          </span>
        </h3>
        <span className="text-[10px] text-gray-400">{season}</span>
      </div>
      <p className="text-[10px] text-gray-500 mb-2">
        {d.total_pa} PA total · {d.tracked_pa} with pitch data ({trackedShare}%) · {d.pitches} pitches seen
      </p>
      <div className="flex items-center gap-2 text-[10px] text-gray-500 mb-5 flex-wrap">
        <span>Color vs {data.division_level} decile rank:</span>
        <ColorScale />
        <span className="text-gray-400">(hover any cell for league average)</span>
      </div>

      {/* ── Plate discipline ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-9 gap-2 mb-6">
        <Tile label="Pitches" value={d.pitches} sub={`over ${d.tracked_pa} PA`} />
        <Tile label="Swing %" value={fmtPct(d.swing_pct)} sub={`${d.swings} of ${d.pitches}`} />
        <Tile label="Whiff %" value={fmtPct(d.whiff_pct)} sub={`${d.whiffs} of ${d.swings}`} />
        <Tile label="1st-Pitch Swing" value={fmtPct(d.first_pitch_swing_pct)} sub={`of ${d.tracked_pa} PA`} />
        <Tile label="1st-Pitch Strike" value={fmtPct(d.first_pitch_strike_pct)} sub={`of ${d.tracked_pa} PA`} />
        <Tile label="0-0 BIP %" value={fmtPct(d.first_pitch_in_play_pct)} sub={`of ${d.tracked_pa} PA`} />
        <Tile label="Putaway %" value={fmtPct(d.putaway_pct)} sub={`of ${d.two_strike_pa} 2K PAs`} />
        <Tile label="Avg LI" value={fmtNum(d.avg_li, 2)} sub={d.li_pa ? `peak ${fmtNum(d.max_li, 1)}` : '—'} />
        <Tile label="P / PA" value={fmtNum(d.pitches_per_pa, 2)} sub={`${d.pitches}÷${d.tracked_pa}`} />
      </div>

      {/* ── Count-state slash lines ── */}
      <SectionHeader>Count-State Slash</SectionHeader>
      <DataTable minWidth={780} className="mb-6">
        <thead>
          <HeaderRow>
            <Th align="left">Count</Th>
            <Th>PA</Th>
            <Th>Pit</Th>
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
              <NumCell value={cs.pitches} muted />
              <NumCell value={cs.bip} muted />
              <ColorCell row={cs} metric="ba" formatter={fmtRate} bold />
              <ColorCell row={cs} metric="obp" formatter={fmtRate} />
              <ColorCell row={cs} metric="slg" formatter={fmtRate} />
              <ColorCell row={cs} metric="ops" formatter={fmtRate} />
              <ColorCell row={cs} metric="iso" formatter={fmtRate} />
              <ColorCell row={cs} metric="woba" formatter={fmtRate} />
              <ColorCell row={cs} metric="wrc_plus" formatter={fmtInt} />
              <NumCell value={fmtPct(cs.swing_pct)} muted={false} text />
              <ColorCell row={cs} metric="contact_pct" formatter={fmtPct} />
            </BodyRow>
          ))}
        </tbody>
      </DataTable>

      {/* ── L/R splits ── */}
      <SectionHeader>Pitcher Hand Splits</SectionHeader>
      <DataTable minWidth={860}>
        <thead>
          <HeaderRow>
            <Th align="left">Split</Th>
            <Th>PA</Th>
            <Th>Pit</Th>
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
            <Th>Contact%</Th>
          </HeaderRow>
        </thead>
        <tbody>
          {data.lr_splits.map((sp) => (
            <BodyRow key={sp.label}>
              <td className="px-3 py-2.5 align-middle font-medium text-gray-900 border-r border-gray-100">
                {sp.label}
              </td>
              <NumCell value={sp.pa} muted={false} />
              <NumCell value={sp.pitches} muted />
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
              <NumCell value={fmtPct(sp.swing_pct)} muted={false} text />
              <ColorCell row={sp} metric="contact_pct" formatter={fmtPct} />
            </BodyRow>
          ))}
        </tbody>
      </DataTable>
      {data.lr_splits.find(s => s.label === 'vs Unknown' && s.pa > 0) && (
        <p className="text-[10px] text-gray-400 mt-2 italic">
          Unknown = pitcher's handedness not in our roster data (mostly OOC opponents).
        </p>
      )}

      {/* ── Situational splits (base state / inning / late & close) ── */}
      {data.situational_splits && data.situational_splits.length > 0 && (
        <>
          <div className="mt-6">
            <SectionHeader>Situational Splits</SectionHeader>
          </div>
          <DataTable minWidth={860}>
            <thead>
              <HeaderRow>
                <Th align="left">Split</Th>
                <Th>PA</Th>
                <Th>Pit</Th>
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
                <Th>Contact%</Th>
              </HeaderRow>
            </thead>
            <tbody>
              {data.situational_splits.map((sp) => (
                <BodyRow key={sp.label}>
                  <CountCell label={sp.label} detail={sp.detail} />
                  <NumCell value={sp.pa} muted={false} />
                  <NumCell value={sp.pitches} muted />
                  <NumCell value={sp.bip} muted />
                  <ColorCell row={sp} metric="ba"  formatter={fmtRate} bold />
                  <ColorCell row={sp} metric="obp" formatter={fmtRate} />
                  <ColorCell row={sp} metric="slg" formatter={fmtRate} />
                  <ColorCell row={sp} metric="ops" formatter={fmtRate} />
                  <ColorCell row={sp} metric="iso" formatter={fmtRate} />
                  <ColorCell row={sp} metric="woba" formatter={fmtRate} />
                  <ColorCell row={sp} metric="wrc_plus" formatter={fmtInt} />
                  <ColorCell row={sp} metric="k_pct"  formatter={fmtPct} />
                  <ColorCell row={sp} metric="bb_pct" formatter={fmtPct} />
                  <ColorCell row={sp} metric="contact_pct" formatter={fmtPct} />
                </BodyRow>
              ))}
            </tbody>
          </DataTable>
          <p className="text-[10px] text-gray-400 mt-2 italic">
            Situational splits use base/out/score state from PBP. Some 2026 PAs
            are not yet state-derived (especially OOC opponents) — totals here
            may be slightly lower than the season totals above.
          </p>
        </>
      )}
    </div>
  )
}

// ── Layout primitives (shared style for tables) ─────────────────

function SectionHeader({ children }) {
  return (
    <h4 className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold mb-2">
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
  const cls = align === 'left' ? 'text-left' : align === 'right' ? 'text-right' : 'text-center'
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
  // Single horizontal line keeps row height uniform across the table.
  return (
    <td className="px-3 py-2.5 align-middle whitespace-nowrap border-r border-gray-100">
      <span className="font-medium text-gray-900">{label}</span>
      {detail && <span className="text-gray-400 ml-1.5">· {detail}</span>}
    </td>
  )
}

function NumCell({ value, muted = false, text = false }) {
  // text=true means we're rendering a pre-formatted string (e.g. fmtPct);
  // otherwise we just display the value as-is. muted dims numbers that are
  // sample-size-only (PA, Pitches, BIP).
  const cls = `text-center px-3 py-2.5 align-middle tabular-nums ${
    muted ? 'text-gray-400' : 'text-gray-700'
  }`
  return <td className={cls}>{value ?? '-'}</td>
}

// ── Color coding (Savant-style) ─────────────────────────────────

const METRIC_DIRECTION = {
  ba: 'high', obp: 'high', slg: 'high', ops: 'high',
  iso: 'high', woba: 'high', wrc_plus: 'high',
  contact_pct: 'high', bb_pct: 'high',
  k_pct: 'low', whiff_pct: 'low',
}

const SHADE_PALETTE = [
  'bg-blue-700 text-white',     // 0 — worst
  'bg-blue-500 text-white',
  'bg-blue-400 text-white',
  'bg-blue-300 text-gray-900',
  'bg-blue-100 text-gray-900',
  'bg-gray-50  text-gray-900',  // 5 — neutral
  'bg-red-100  text-gray-900',
  'bg-red-300  text-gray-900',
  'bg-red-400  text-white',
  'bg-red-500  text-white',
  'bg-red-700  text-white',     // 10 — best
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
        League {metric.toUpperCase().replace('_PCT', '%').replace('_', ' ')}: {leagueText}
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
      <span className="text-[9px] text-gray-500 mr-1">worse</span>
      {swatches.map((c, i) => (
        <span key={i} className={`inline-block w-3 h-3 ${c} border border-gray-200`}></span>
      ))}
      <span className="text-[9px] text-gray-500 ml-1">better</span>
    </span>
  )
}

function Tile({ label, value, sub }) {
  // Consistent height + true centering. Grid cell stretches naturally.
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

// ── Formatters ──────────────────────────────────────────────────

function fmtPct(v) {
  if (v === null || v === undefined) return '-'
  return (v * 100).toFixed(1) + '%'
}

function fmtRate(v) {
  if (v === null || v === undefined) return '-'
  const s = v.toFixed(3)
  return s.startsWith('0') ? s.slice(1) : s
}

function fmtNum(v, decimals = 2) {
  if (v === null || v === undefined) return '-'
  return v.toFixed(decimals)
}

function fmtInt(v) {
  if (v === null || v === undefined) return '-'
  return Math.round(v).toString()
}
