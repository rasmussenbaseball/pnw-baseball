import { usePlayerPitchLevelStatsPitcher } from '../hooks/useApi'
import SprayChart from './SprayChart'

/**
 * Pitcher Pitch-Level Stats — full Phase G/H redesign mirror of the
 * hitter card.
 *
 * Color semantics: red = good for THIS pitcher (low opponent BA, high
 * Whiff%, high Strike%, low BB%, etc.). Direction is INVERTED for
 * opponent slash columns since LOW opp_OPS is GOOD for the pitcher.
 *
 * Sections:
 *   1. Plate Discipline — colored tiles
 *   2. Opponent Contact + Spray — 2-col layout
 *   3. Opponent Slash by Count — color-coded slash
 *   4. Batter Hand Splits — color-coded slash
 *   5. Situational Performance — color-coded slash
 */
export default function PitcherPitchLevelStatsCard({ playerId, season }) {
  const { data, loading, error } = usePlayerPitchLevelStatsPitcher(playerId, season)

  if (loading || error || !data) return null
  const d = data.discipline
  if (!d || !d.total_pa) return null
  const ocp = data.opp_contact_profile || {}
  const trackedShare = d.tracked_pa > 0 ? Math.round(100 * d.tracked_pa / d.total_pa) : 0

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 sm:p-6 mt-6 overflow-hidden">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-lg font-bold text-gray-900">Pitch-Level Stats</h3>
        <span className="text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
          Beta
        </span>
      </div>
      <p className="text-[11px] text-gray-500 mb-2">
        {d.total_pa} PA faced · {d.tracked_pa} with pitch data ({trackedShare}%) · {d.pitches} pitches thrown
      </p>
      <div className="flex items-center gap-2 text-[10px] text-gray-500 mb-5 flex-wrap">
        <span>Color vs {data.division_level} decile rank:</span>
        <ColorScale />
        <span className="text-gray-400">(hover any cell for league average)</span>
      </div>

      {/* ── 1 + 2: Plate Discipline + Opp Contact in 2-column layout ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">

        {/* LEFT column: Plate Discipline + Opp Contact tiles */}
        <div>
          <SectionHeader>Plate Discipline</SectionHeader>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <ColorTile label="Strike %"        metric="strike_pct"
              value={d.strike_pct} sub="of all pitches"
              league={d.league} deciles={d.deciles} formatter={fmtPct} />
            <ColorTile label="Called-Str %"    metric="called_strike_pct"
              value={d.called_strike_pct} sub="of all pitches"
              league={d.league} deciles={d.deciles} formatter={fmtPct} />
            <ColorTile label="Whiff %"         metric="whiff_pct"
              value={d.whiff_pct} sub={`${d.whiffs} of ${d.swings}`}
              league={d.league} deciles={d.deciles} formatter={fmtPct} />
            <ColorTile label="P / PA"          metric="pitches_per_pa"
              value={d.pitches_per_pa} sub={`${d.pitches}÷${d.tracked_pa}`}
              league={d.league} deciles={d.deciles} formatter={(v) => fmtNum(v, 2)} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <ColorTile label="1st-P Strike"    metric="first_pitch_strike_pct"
              value={d.first_pitch_strike_pct} sub={`of ${d.tracked_pa} PA`}
              league={d.league} deciles={d.deciles} formatter={fmtPct} />
            <ColorTile label="Putaway %"       metric="putaway_pct"
              value={d.putaway_pct} sub={`of ${d.two_strike_pa} 2K PAs`}
              league={d.league} deciles={d.deciles} formatter={fmtPct} />
            {/* On/Out in 3 — % of tracked PAs ending in 1-3 pitches with
                a hit-or-out outcome. Walks/HBP excluded. Efficiency stat. */}
            <ColorTile label="On/Out in 3"     metric="on_or_out_3_pct"
              value={d.on_or_out_3_pct} sub={`${d.on_or_out_3 ?? 0} of ${d.tracked_pa}`}
              league={d.league} deciles={d.deciles} formatter={fmtPct} />
            <Tile label="Pitches" value={d.pitches} sub={`over ${d.tracked_pa} PA`} />
          </div>

          {/* Avg LI + total WPA — paired because they answer adjacent
              questions: "what leverage moments did this pitcher work?"
              and "what did he do with them?" */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-5">
            <LeverageTile avgLI={d.avg_li} maxLI={d.max_li} pa={d.li_pa} />
            <WpaTile totalWPA={d.total_wpa} peakWPA={d.peak_wpa}
              pa={d.wpa_pa} side="pitcher" />
          </div>

          {ocp.bb_total > 0 && (
            <>
              <SectionHeader>Opponent Contact Profile</SectionHeader>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                <ColorTile label="GB %" metric="gb_pct" value={ocp.gb_pct}
                  sub={`${ocp.gb_count} of ${ocp.bb_total}`}
                  league={d.league} deciles={d.deciles} formatter={fmtPct} />
                <ColorTile label="LD %" metric="ld_pct" value={ocp.ld_pct}
                  sub={`${ocp.ld_count} of ${ocp.bb_total}`}
                  league={d.league} deciles={d.deciles} formatter={fmtPct} />
                <ColorTile label="FB %" metric="fb_pct" value={ocp.fb_pct}
                  sub={`${ocp.fb_count} of ${ocp.bb_total}`}
                  league={d.league} deciles={d.deciles} formatter={fmtPct} />
                <ColorTile label="PU %" metric="pu_pct" value={ocp.pu_pct}
                  sub={`${ocp.pu_count} of ${ocp.bb_total}`}
                  league={d.league} deciles={d.deciles} formatter={fmtPct} />
              </div>
              <p className="text-[10px] text-gray-400 italic">
                Type of contact this pitcher induces. High GB% = sinkerballer; low LD% = weak contact.
              </p>
            </>
          )}
        </div>

        {/* RIGHT column: Opponent Spray Chart */}
        {data.opp_spray_chart && data.opp_spray_chart.all_total > 0 && (
          <div>
            <SectionHeader>Opponent Spray (where balls go against this pitcher)</SectionHeader>
            <SprayChart data={data.opp_spray_chart} mode="pitcher" defaultFilter="all" />
          </div>
        )}
      </div>

      {/* ── 3. Opponent Slash by Count ── */}
      <SectionHeader>Opponent Slash by Count</SectionHeader>
      <DataTable minWidth={920} className="mb-6">
        <thead>
          <HeaderRow>
            <Th align="left">Count</Th>
            <Th>PA</Th>
            <Th>Pit</Th>
            <Th>BIP</Th>
            <Th>opp BA</Th>
            <Th>opp OBP</Th>
            <Th>opp SLG</Th>
            <Th>opp OPS</Th>
            <Th>opp wOBA</Th>
            <Th>wRC+ allowed</Th>
            <Th>K%</Th>
            <Th>BB%</Th>
            <Th>Whiff%</Th>
          </HeaderRow>
        </thead>
        <tbody>
          {data.count_states.map((cs) => (
            <BodyRow key={cs.label}>
              <CountCell label={cs.label} detail={cs.detail} />
              <NumCell value={cs.pa} muted={false} />
              <NumCell value={cs.pitches} muted />
              <NumCell value={cs.bip} muted />
              <ColorCell row={cs} metric="opp_ba" formatter={fmtRate} bold />
              <ColorCell row={cs} metric="opp_obp" formatter={fmtRate} />
              <ColorCell row={cs} metric="opp_slg" formatter={fmtRate} />
              <ColorCell row={cs} metric="opp_ops" formatter={fmtRate} />
              <ColorCell row={cs} metric="opp_woba" formatter={fmtRate} />
              <ColorCell row={cs} metric="wrc_plus_against" formatter={fmtInt} />
              <ColorCell row={cs} metric="k_pct" formatter={fmtPct} />
              <ColorCell row={cs} metric="bb_pct" formatter={fmtPct} />
              <ColorCell row={cs} metric="whiff_pct" formatter={fmtPct} />
            </BodyRow>
          ))}
        </tbody>
      </DataTable>

      {/* ── 4. Batter Hand Splits ── */}
      <SectionHeader>Batter Hand Splits</SectionHeader>
      <DataTable minWidth={920} className="mb-6">
        <thead>
          <HeaderRow>
            <Th align="left">Split</Th>
            <Th>PA</Th>
            <Th>Pit</Th>
            <Th>BIP</Th>
            <Th>opp BA</Th>
            <Th>opp OBP</Th>
            <Th>opp SLG</Th>
            <Th>opp OPS</Th>
            <Th>opp wOBA</Th>
            <Th>wRC+ allowed</Th>
            <Th>K%</Th>
            <Th>BB%</Th>
            <Th>Whiff%</Th>
          </HeaderRow>
        </thead>
        <tbody>
          {data.lr_splits.map((sp) => (
            <BodyRow key={sp.label}>
              <CountCell label={sp.label} />
              <NumCell value={sp.pa} muted={false} />
              <NumCell value={sp.pitches} muted />
              <NumCell value={sp.bip} muted />
              <ColorCell row={sp} metric="opp_ba" formatter={fmtRate} bold />
              <ColorCell row={sp} metric="opp_obp" formatter={fmtRate} />
              <ColorCell row={sp} metric="opp_slg" formatter={fmtRate} />
              <ColorCell row={sp} metric="opp_ops" formatter={fmtRate} />
              <ColorCell row={sp} metric="opp_woba" formatter={fmtRate} />
              <ColorCell row={sp} metric="wrc_plus_against" formatter={fmtInt} />
              <ColorCell row={sp} metric="k_pct" formatter={fmtPct} />
              <ColorCell row={sp} metric="bb_pct" formatter={fmtPct} />
              <ColorCell row={sp} metric="whiff_pct" formatter={fmtPct} />
            </BodyRow>
          ))}
        </tbody>
      </DataTable>

      {/* ── 5. Situational Performance ── */}
      {data.situational_splits?.length > 0 && (
        <>
          <SectionHeader>Situational Performance</SectionHeader>
          <DataTable minWidth={920}>
            <thead>
              <HeaderRow>
                <Th align="left">Split</Th>
                <Th>PA</Th>
                <Th>Pit</Th>
                <Th>BIP</Th>
                <Th>opp BA</Th>
                <Th>opp OBP</Th>
                <Th>opp SLG</Th>
                <Th>opp OPS</Th>
                <Th>opp wOBA</Th>
                <Th>wRC+ allowed</Th>
                <Th>K%</Th>
                <Th>BB%</Th>
              </HeaderRow>
            </thead>
            <tbody>
              {data.situational_splits.map((sp) => (
                <BodyRow key={sp.label}>
                  <CountCell label={sp.label} detail={sp.detail} />
                  <NumCell value={sp.pa} muted={false} />
                  <NumCell value={sp.pitches} muted />
                  <NumCell value={sp.bip} muted />
                  <ColorCell row={sp} metric="opp_ba" formatter={fmtRate} bold />
                  <ColorCell row={sp} metric="opp_obp" formatter={fmtRate} />
                  <ColorCell row={sp} metric="opp_slg" formatter={fmtRate} />
                  <ColorCell row={sp} metric="opp_ops" formatter={fmtRate} />
                  <ColorCell row={sp} metric="opp_woba" formatter={fmtRate} />
                  <ColorCell row={sp} metric="wrc_plus_against" formatter={fmtInt} />
                  <ColorCell row={sp} metric="k_pct" formatter={fmtPct} />
                  <ColorCell row={sp} metric="bb_pct" formatter={fmtPct} />
                </BodyRow>
              ))}
            </tbody>
          </DataTable>
          <p className="text-[10px] text-gray-400 mt-2 italic">
            Situational splits use base/out/score state from PBP.
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

// ── Layout primitives ──────────────────────────────────────────
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

// ── Color coding (pitcher direction-flipped) ─────────────────────
const METRIC_DIRECTION = {
  // Opponent slash — LOW is GOOD (blue scale bottom = bad, red top = good for pitcher)
  opp_ba: 'low', opp_obp: 'low', opp_slg: 'low', opp_ops: 'low',
  opp_iso: 'low', opp_woba: 'low', wrc_plus_against: 'low',
  // K% high = good, BB% low = good
  k_pct: 'high', bb_pct: 'low',
  // Pitcher discipline — higher = better
  strike_pct: 'high', called_strike_pct: 'high', whiff_pct: 'high',
  first_pitch_strike_pct: 'high', putaway_pct: 'high',
  on_or_out_3_pct: 'high',                // higher = quicker decisions
  pitches_per_pa: 'low',                  // lower = more efficient
  // Opp contact profile — pitcher style; treat as "high = high" (no skill polarity)
  gb_pct: 'high', fb_pct: 'high', ld_pct: 'low', pu_pct: 'high',
}
const SHADE_PALETTE = [
  'bg-blue-700 text-white', 'bg-blue-500 text-white', 'bg-blue-400 text-white',
  'bg-blue-300 text-gray-900', 'bg-blue-100 text-gray-900',
  'bg-gray-50  text-gray-900',
  'bg-red-100  text-gray-900', 'bg-red-300  text-gray-900',
  'bg-red-400  text-white', 'bg-red-500  text-white', 'bg-red-700  text-white',
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
    opp_ba: 'opp BA', opp_obp: 'opp OBP', opp_slg: 'opp SLG',
    opp_ops: 'opp OPS', opp_iso: 'opp ISO', opp_woba: 'opp wOBA',
    wrc_plus_against: 'wRC+ allowed', k_pct: 'K%', bb_pct: 'BB%',
    strike_pct: 'Strike%', called_strike_pct: 'Called-Str%', whiff_pct: 'Whiff%',
    first_pitch_strike_pct: '1st-P Strike%', putaway_pct: 'Putaway%',
    on_or_out_3_pct: 'On/Out in 3',
    pitches_per_pa: 'P/PA',
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
      <span className="text-[9px] text-gray-500 mr-1">worse</span>
      {swatches.map((c, i) => (
        <span key={i} className={`inline-block w-3 h-3 ${c} border border-gray-200`}></span>
      ))}
      <span className="text-[9px] text-gray-500 ml-1">better</span>
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
// Shared shell so LI and WPA tiles share an identical visual structure.
// Each tile has 4 stacked rows: label / headline / tier / explanation.
// Stacking (rather than flexing label and number into the same row)
// is what makes paired tiles align cleanly — the rows match by index.
function StatTile({ label, headline, headlineColor, subRight, tier, summary, explanation }) {
  return (
    <div className="relative group bg-gray-50 border border-gray-100 rounded p-3 flex flex-col">
      {/* Row 1: Label (uppercase, small, single line via nowrap) */}
      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold whitespace-nowrap mb-2">
        {label}
      </div>
      {/* Row 2: Big number on left, peak/PA sub-text right-aligned to baseline */}
      <div className="flex items-baseline justify-between mb-2">
        <span className={`text-3xl font-bold tabular-nums ${headlineColor || 'text-gray-900'}`}>
          {headline}
        </span>
        <span className="text-[10px] text-gray-500 text-right whitespace-nowrap ml-2">
          {subRight}
        </span>
      </div>
      {/* Row 3: Tier + one-line summary */}
      <div className="text-[11px] text-gray-700 mb-2">
        <span className="font-semibold">{tier}</span>
        <span className="text-gray-500"> · </span>
        <span className="text-gray-600">{summary}</span>
      </div>
      {/* Row 4: Explanation (small, gray, fills remaining vertical space) */}
      <p className="text-[10px] text-gray-500 leading-snug mt-auto">
        {explanation}
      </p>
    </div>
  )
}

function LeverageTile({ avgLI, maxLI, pa }) {
  const li = avgLI ?? 1.0
  const tier = li >= 1.8 ? 'Closer-tier' :
               li >= 1.4 ? 'High leverage' :
               li >= 1.1 ? 'Above average' :
               li >= 0.9 ? 'Average' :
               li >= 0.6 ? 'Below average' :
                           'Mop-up'
  const summary = li >= 1.0
    ? `${((li - 1) * 100).toFixed(0)}% above league-average importance`
    : `${((1 - li) * 100).toFixed(0)}% below league-average importance`
  return (
    <StatTile
      label="Avg Leverage Index"
      headline={fmtNum(li, 2)}
      subRight={`peak ${fmtNum(maxLI || 0, 1)} · ${pa || 0} PA`}
      tier={tier}
      summary={summary}
      explanation={
        <>
          Leverage Index measures how much a single PA can swing the win
          probability. For pitchers this is the killer reliever stat: closers
          come in for high-LI moments (1.5+), mop-up relievers see low LI
          (≤0.5). Starters drift toward 1.0.
        </>
      }
    />
  )
}

function WpaTile({ totalWPA, peakWPA, pa, side }) {
  if (totalWPA == null || pa == null || pa === 0) {
    return (
      <StatTile
        label="Win Probability Added"
        headline="—"
        subRight=""
        tier="No PBP coverage yet"
        summary="WPA appears once play-by-play data is available."
        explanation={
          <>
            Win Probability Added measures the cumulative change in win
            probability from each batter faced. Built from 1,100+ games of
            2026 PBP data.
          </>
        }
      />
    )
  }
  // Tier the season total. Pitcher totals tend to run a bit lower
  // than hitter totals because aces/closers spread their wins across
  // more outings — same thresholds work as a first cut.
  const tier = totalWPA >= 2.0 ? 'Elite contributor' :
               totalWPA >= 1.0 ? 'Strong contributor' :
               totalWPA >= 0.3 ? 'Above average' :
               totalWPA >= -0.3 ? 'Roughly neutral' :
               totalWPA >= -1.0 ? 'Below average' :
                                  'Net negative impact'
  const sign = totalWPA >= 0 ? '+' : ''
  const color = totalWPA >= 0.3 ? 'text-emerald-700' :
                totalWPA <= -0.3 ? 'text-rose-700' :
                                   'text-gray-900'
  const peakSign = (peakWPA ?? 0) >= 0 ? '+' : ''
  const sideLabel = side === 'pitcher' ? 'BF' : 'PA'
  const summary = totalWPA >= 0
    ? `added ${fmtNum(totalWPA, 1)} expected wins to his team`
    : `cost his team ${fmtNum(Math.abs(totalWPA), 1)} expected wins`
  return (
    <StatTile
      label="Win Probability Added"
      headline={`${sign}${fmtNum(totalWPA, 2)}`}
      headlineColor={color}
      subRight={`peak ${peakSign}${fmtNum(peakWPA || 0, 2)} · ${pa} ${sideLabel}`}
      tier={tier}
      summary={summary}
      explanation={
        <>
          Win Probability Added measures the cumulative change in win
          probability from each batter faced. A pitcher who escapes a
          bases-loaded jam in a tied 9th can earn +0.2 in a single AB. Closers
          and aces lead because their outs come in the highest-leverage spots.
        </>
      }
    />
  )
}
