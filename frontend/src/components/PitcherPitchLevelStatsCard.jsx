import { usePlayerPitchLevelStatsPitcher } from '../hooks/useApi'

/**
 * Pitcher Pitch-Level Stats — mirror of the hitter card.
 *
 * Color semantics: red = good for THIS pitcher (low opponent BA, high
 * Whiff%, high Strike%, etc.). Direction is inverted for opponent
 * slash columns since for a pitcher, low opponent OPS is GOOD.
 */
export default function PitcherPitchLevelStatsCard({ playerId, season }) {
  const { data, loading, error } = usePlayerPitchLevelStatsPitcher(playerId, season)

  if (loading || error || !data) return null
  const d = data.discipline
  if (!d || !d.total_pa) return null

  const trackedShare = d.tracked_pa > 0
    ? Math.round(100 * d.tracked_pa / d.total_pa)
    : 0

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3 sm:p-5 mb-4 sm:mb-6">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-xs sm:text-sm font-semibold text-gray-600 uppercase tracking-wider">
          Pitch-Level Stats
        </h3>
        <span className="text-[10px] text-gray-400">{season}</span>
      </div>
      <p className="text-[10px] text-gray-500 mb-2">
        {d.total_pa} PA faced · {d.tracked_pa} with pitch data ({trackedShare}%) · {d.pitches} pitches thrown
      </p>
      <div className="flex items-center gap-2 text-[10px] text-gray-500 mb-3 flex-wrap">
        <span>Color vs {data.division_level} decile rank:</span>
        <ColorScale />
        <span className="text-gray-400">(hover any cell for league value)</span>
      </div>

      {/* ── Plate discipline (pitcher's side) ── */}
      <div className="grid grid-cols-2 sm:grid-cols-7 gap-2 mb-4">
        <Tile label="Pitches" value={d.pitches} sub={`over ${d.tracked_pa} PA`} />
        <Tile label="Strike %" value={fmtPct(d.strike_pct)} sub="thrown" />
        <Tile label="Called-Strike %" value={fmtPct(d.called_strike_pct)} sub="of all pitches" />
        <Tile label="Whiff %" value={fmtPct(d.whiff_pct)} sub={`${d.whiffs} of ${d.swings}`} />
        <Tile label="1st-Pitch Strike" value={fmtPct(d.first_pitch_strike_pct)} sub={`of ${d.tracked_pa} PA`} />
        <Tile label="Putaway %" value={fmtPct(d.putaway_pct)} sub="K rate w/ 2 strikes" />
        <Tile label="P / PA" value={fmtNum(d.pitches_per_pa, 2)} sub={`${d.pitches}÷${d.tracked_pa}`} />
      </div>

      {/* ── Count-state opponent slash ── */}
      <div className="mb-4">
        <h4 className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5">
          Opponent Slash by Count
        </h4>
        <div className="overflow-x-auto -mx-3 sm:mx-0">
          <table className="w-full text-xs min-w-[820px]">
            <thead className="bg-gray-50 text-gray-600 uppercase tracking-wide text-[10px]">
              <tr>
                <th className="text-left px-2 py-1.5">Count</th>
                <th className="text-right px-2 py-1.5">PA</th>
                <th className="text-right px-2 py-1.5">Pit</th>
                <th className="text-right px-2 py-1.5">BIP</th>
                <th className="text-right px-2 py-1.5">opp BA</th>
                <th className="text-right px-2 py-1.5">opp OBP</th>
                <th className="text-right px-2 py-1.5">opp SLG</th>
                <th className="text-right px-2 py-1.5">opp OPS</th>
                <th className="text-right px-2 py-1.5">opp ISO</th>
                <th className="text-right px-2 py-1.5">opp wOBA</th>
                <th className="text-right px-2 py-1.5">wRC+ allowed</th>
                <th className="text-right px-2 py-1.5">K%</th>
                <th className="text-right px-2 py-1.5">BB%</th>
                <th className="text-right px-2 py-1.5">Strike%</th>
                <th className="text-right px-2 py-1.5">Whiff%</th>
              </tr>
            </thead>
            <tbody>
              {data.count_states.map((cs) => (
                <tr key={cs.label}>
                  <td className="px-2 py-1.5 align-top">
                    <div className="font-medium text-gray-900">{cs.label}</div>
                    <div className="text-[10px] text-gray-400">{cs.detail}</div>
                  </td>
                  <td className="text-right px-2 py-1.5 text-gray-700 tabular-nums">{cs.pa}</td>
                  <td className="text-right px-2 py-1.5 text-gray-500 tabular-nums">{cs.pitches}</td>
                  <td className="text-right px-2 py-1.5 text-gray-500 tabular-nums">{cs.bip}</td>
                  <ColorCell row={cs} metric="opp_ba" formatter={fmtRate} bold />
                  <ColorCell row={cs} metric="opp_obp" formatter={fmtRate} />
                  <ColorCell row={cs} metric="opp_slg" formatter={fmtRate} />
                  <ColorCell row={cs} metric="opp_ops" formatter={fmtRate} />
                  <ColorCell row={cs} metric="opp_iso" formatter={fmtRate} />
                  <ColorCell row={cs} metric="opp_woba" formatter={fmtRate} />
                  <ColorCell row={cs} metric="wrc_plus_against" formatter={fmtInt} />
                  <ColorCell row={cs} metric="k_pct" formatter={fmtPct} />
                  <ColorCell row={cs} metric="bb_pct" formatter={fmtPct} />
                  <ColorCell row={cs} metric="strike_pct" formatter={fmtPct} />
                  <ColorCell row={cs} metric="whiff_pct" formatter={fmtPct} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── L/R batter splits ── */}
      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5">
          Batter Hand Splits
        </h4>
        <div className="overflow-x-auto -mx-3 sm:mx-0">
          <table className="w-full text-xs min-w-[820px]">
            <thead className="bg-gray-50 text-gray-600 uppercase tracking-wide text-[10px]">
              <tr>
                <th className="text-left px-2 py-1.5">Split</th>
                <th className="text-right px-2 py-1.5">PA</th>
                <th className="text-right px-2 py-1.5">Pit</th>
                <th className="text-right px-2 py-1.5">BIP</th>
                <th className="text-right px-2 py-1.5">opp BA</th>
                <th className="text-right px-2 py-1.5">opp OBP</th>
                <th className="text-right px-2 py-1.5">opp SLG</th>
                <th className="text-right px-2 py-1.5">opp OPS</th>
                <th className="text-right px-2 py-1.5">opp ISO</th>
                <th className="text-right px-2 py-1.5">opp wOBA</th>
                <th className="text-right px-2 py-1.5">wRC+ allowed</th>
                <th className="text-right px-2 py-1.5">K%</th>
                <th className="text-right px-2 py-1.5">BB%</th>
                <th className="text-right px-2 py-1.5">Strike%</th>
                <th className="text-right px-2 py-1.5">Whiff%</th>
              </tr>
            </thead>
            <tbody>
              {data.lr_splits.map((sp) => (
                <tr key={sp.label}>
                  <td className="px-2 py-1.5 font-medium text-gray-900">{sp.label}</td>
                  <td className="text-right px-2 py-1.5 text-gray-700 tabular-nums">{sp.pa}</td>
                  <td className="text-right px-2 py-1.5 text-gray-500 tabular-nums">{sp.pitches}</td>
                  <td className="text-right px-2 py-1.5 text-gray-500 tabular-nums">{sp.bip}</td>
                  <ColorCell row={sp} metric="opp_ba" formatter={fmtRate} bold />
                  <ColorCell row={sp} metric="opp_obp" formatter={fmtRate} />
                  <ColorCell row={sp} metric="opp_slg" formatter={fmtRate} />
                  <ColorCell row={sp} metric="opp_ops" formatter={fmtRate} />
                  <ColorCell row={sp} metric="opp_iso" formatter={fmtRate} />
                  <ColorCell row={sp} metric="opp_woba" formatter={fmtRate} />
                  <ColorCell row={sp} metric="wrc_plus_against" formatter={fmtInt} />
                  <ColorCell row={sp} metric="k_pct" formatter={fmtPct} />
                  <ColorCell row={sp} metric="bb_pct" formatter={fmtPct} />
                  <ColorCell row={sp} metric="strike_pct" formatter={fmtPct} />
                  <ColorCell row={sp} metric="whiff_pct" formatter={fmtPct} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.lr_splits.find(s => s.label === 'vs Unknown' && s.pa > 0) && (
          <p className="text-[10px] text-gray-400 mt-1.5 italic">
            Unknown = batter's handedness not in our roster data.
          </p>
        )}
      </div>
    </div>
  )
}

// ── helpers (mirror of hitter card, with inverted opp_* directions) ─

const METRIC_DIRECTION = {
  // For PITCHERS, low opponent slash is good → 'low' (red)
  opp_ba: 'low', opp_obp: 'low', opp_slg: 'low', opp_ops: 'low',
  opp_iso: 'low', opp_woba: 'low', wrc_plus_against: 'low',
  bb_pct: 'low',
  // High K%, Strike%, Whiff% are good
  k_pct: 'high', strike_pct: 'high', whiff_pct: 'high',
}

const SHADE_PALETTE = [
  'bg-blue-700 text-white',
  'bg-blue-500 text-white',
  'bg-blue-400 text-white',
  'bg-blue-300 text-gray-900',
  'bg-blue-100 text-gray-900',
  'bg-gray-50  text-gray-900',
  'bg-red-100  text-gray-900',
  'bg-red-300  text-gray-900',
  'bg-red-400  text-white',
  'bg-red-500  text-white',
  'bg-red-700  text-white',
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
    <td className={`relative group text-right px-2 py-1.5 tabular-nums ${shade} ${bold ? 'font-semibold' : ''}`}>
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
  return (
    <div className="text-center py-2 px-1 border border-gray-100 rounded bg-gray-50">
      <div className="text-[9px] uppercase tracking-wide text-gray-500 font-semibold">{label}</div>
      <div className="text-base sm:text-lg font-bold text-gray-900 tabular-nums">{value ?? '-'}</div>
      <div className="text-[9px] text-gray-400">{sub}</div>
    </div>
  )
}

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
