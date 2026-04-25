import { usePlayerPitchLevelStats } from '../hooks/useApi'

/**
 * Pitch-Level Stats card for a hitter.
 *
 * Important: many source PBP feeds publish narrative without count or
 * pitch sequence (e.g. "Player walked." with no parens). For those PAs
 * we record the OUTCOME but not the pitches. The card distinguishes
 * total PA from pitch-tracked PA so users can judge sample reliability
 * for any pitch-level metric.
 *
 * Sections:
 *   1. Plate discipline tile row — only over pitch-tracked PAs
 *   2. Count-state slash lines — over all PAs (results-based)
 *   3. L/R splits — over all PAs (results-based)
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
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3 sm:p-5 mb-4 sm:mb-6">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-xs sm:text-sm font-semibold text-gray-600 uppercase tracking-wider">
          Pitch-Level Stats
        </h3>
        <span className="text-[10px] text-gray-400">{season}</span>
      </div>
      <p className="text-[10px] text-gray-500 mb-2">
        {d.total_pa} PA total · {d.tracked_pa} with pitch data ({trackedShare}%) · {d.pitches} pitches seen
      </p>
      <div className="flex items-center gap-3 text-[10px] text-gray-500 mb-3">
        <span>Color vs {data.division_level} league avg:</span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-red-200 border border-gray-200"></span>
          better
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-blue-200 border border-gray-200"></span>
          worse
        </span>
        <span className="text-gray-400">(hover any cell for league value)</span>
      </div>

      {/* ── Plate discipline ── */}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 mb-4">
        <Tile
          label="Pitches"
          value={d.pitches}
          sub={`over ${d.tracked_pa} PA`}
        />
        <Tile
          label="Swing %"
          value={fmtPct(d.swing_pct)}
          sub={`${d.swings} of ${d.pitches}`}
        />
        <Tile
          label="Whiff %"
          value={fmtPct(d.whiff_pct)}
          sub={`${d.whiffs} of ${d.swings}`}
        />
        <Tile
          label="1st-Pitch Swing"
          value={fmtPct(d.first_pitch_swing_pct)}
          sub={`of ${d.tracked_pa} PA`}
        />
        <Tile
          label="1st-Pitch Strike"
          value={fmtPct(d.first_pitch_strike_pct)}
          sub={`of ${d.tracked_pa} PA`}
        />
        <Tile
          label="P / PA"
          value={fmtNum(d.pitches_per_pa, 2)}
          sub={`${d.pitches}÷${d.tracked_pa}`}
        />
      </div>

      {/* ── Count-state slash lines ── */}
      <div className="mb-4">
        <h4 className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5">
          Count-State Slash
        </h4>
        <div className="overflow-x-auto -mx-3 sm:mx-0">
          <table className="w-full text-xs min-w-[720px]">
            <thead className="bg-gray-50 text-gray-600 uppercase tracking-wide text-[10px]">
              <tr>
                <th className="text-left px-2 py-1.5">Count</th>
                <th className="text-right px-2 py-1.5">PA</th>
                <th className="text-right px-2 py-1.5">Pit</th>
                <th className="text-right px-2 py-1.5">BIP</th>
                <th className="text-right px-2 py-1.5">BA</th>
                <th className="text-right px-2 py-1.5">OBP</th>
                <th className="text-right px-2 py-1.5">SLG</th>
                <th className="text-right px-2 py-1.5">OPS</th>
                <th className="text-right px-2 py-1.5">ISO</th>
                <th className="text-right px-2 py-1.5">wOBA</th>
                <th className="text-right px-2 py-1.5">Swing%</th>
                <th className="text-right px-2 py-1.5">Contact%</th>
              </tr>
            </thead>
            <tbody>
              {data.count_states.map((cs, i) => {
                const lg = cs.league || {}
                const c = (m) => `text-right px-2 py-1.5 tabular-nums ${colorClass(m, cs[m], lg[m])}`
                const t = (m, fn) => cellTitle(m, cs[m], lg[m], fn)
                return (
                  <tr key={cs.label} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                    <td className="px-2 py-1.5">
                      <div className="font-medium text-gray-900">{cs.label}</div>
                      <div className="text-[10px] text-gray-400">{cs.detail}</div>
                    </td>
                    <td className="text-right px-2 py-1.5 text-gray-700 tabular-nums">{cs.pa}</td>
                    <td className="text-right px-2 py-1.5 text-gray-500 tabular-nums">{cs.pitches}</td>
                    <td className="text-right px-2 py-1.5 text-gray-500 tabular-nums">{cs.bip}</td>
                    <td className={`${c('ba')} font-semibold text-gray-900`} title={t('ba', fmtRate)}>{fmtRate(cs.ba)}</td>
                    <td className={c('obp')} title={t('obp', fmtRate)}>{fmtRate(cs.obp)}</td>
                    <td className={c('slg')} title={t('slg', fmtRate)}>{fmtRate(cs.slg)}</td>
                    <td className={c('ops')} title={t('ops', fmtRate)}>{fmtRate(cs.ops)}</td>
                    <td className={c('iso')} title={t('iso', fmtRate)}>{fmtRate(cs.iso)}</td>
                    <td className={c('woba')} title={t('woba', fmtRate)}>{fmtRate(cs.woba)}</td>
                    <td className="text-right px-2 py-1.5 text-gray-700 tabular-nums">{fmtPct(cs.swing_pct)}</td>
                    <td className={c('contact_pct')} title={t('contact_pct', fmtPct)}>{fmtPct(cs.contact_pct)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── L/R splits ── */}
      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold mb-1.5">
          Pitcher Hand Splits
        </h4>
        <div className="overflow-x-auto -mx-3 sm:mx-0">
          <table className="w-full text-xs min-w-[800px]">
            <thead className="bg-gray-50 text-gray-600 uppercase tracking-wide text-[10px]">
              <tr>
                <th className="text-left px-2 py-1.5">Split</th>
                <th className="text-right px-2 py-1.5">PA</th>
                <th className="text-right px-2 py-1.5">Pit</th>
                <th className="text-right px-2 py-1.5">BIP</th>
                <th className="text-right px-2 py-1.5">BA</th>
                <th className="text-right px-2 py-1.5">OBP</th>
                <th className="text-right px-2 py-1.5">SLG</th>
                <th className="text-right px-2 py-1.5">OPS</th>
                <th className="text-right px-2 py-1.5">ISO</th>
                <th className="text-right px-2 py-1.5">wOBA</th>
                <th className="text-right px-2 py-1.5">K%</th>
                <th className="text-right px-2 py-1.5">BB%</th>
                <th className="text-right px-2 py-1.5">Swing%</th>
                <th className="text-right px-2 py-1.5">Contact%</th>
              </tr>
            </thead>
            <tbody>
              {data.lr_splits.map((sp, i) => {
                const lg = sp.league || {}
                const c = (m) => `text-right px-2 py-1.5 tabular-nums ${colorClass(m, sp[m], lg[m])}`
                const t = (m, fn) => cellTitle(m, sp[m], lg[m], fn)
                return (
                  <tr key={sp.label} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                    <td className="px-2 py-1.5 font-medium text-gray-900">{sp.label}</td>
                    <td className="text-right px-2 py-1.5 text-gray-700 tabular-nums">{sp.pa}</td>
                    <td className="text-right px-2 py-1.5 text-gray-500 tabular-nums">{sp.pitches}</td>
                    <td className="text-right px-2 py-1.5 text-gray-500 tabular-nums">{sp.bip}</td>
                    <td className={`${c('ba')} font-semibold text-gray-900`} title={t('ba', fmtRate)}>{fmtRate(sp.ba)}</td>
                    <td className={c('obp')} title={t('obp', fmtRate)}>{fmtRate(sp.obp)}</td>
                    <td className={c('slg')} title={t('slg', fmtRate)}>{fmtRate(sp.slg)}</td>
                    <td className={c('ops')} title={t('ops', fmtRate)}>{fmtRate(sp.ops)}</td>
                    <td className={c('iso')} title={t('iso', fmtRate)}>{fmtRate(sp.iso)}</td>
                    <td className={c('woba')} title={t('woba', fmtRate)}>{fmtRate(sp.woba)}</td>
                    <td className={c('k_pct')} title={t('k_pct', fmtPct)}>{fmtPct(sp.k_pct)}</td>
                    <td className={c('bb_pct')} title={t('bb_pct', fmtPct)}>{fmtPct(sp.bb_pct)}</td>
                    <td className="text-right px-2 py-1.5 text-gray-700 tabular-nums">{fmtPct(sp.swing_pct)}</td>
                    <td className={c('contact_pct')} title={t('contact_pct', fmtPct)}>{fmtPct(sp.contact_pct)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {data.lr_splits.find(s => s.label === 'vs Unknown' && s.pa > 0) && (
          <p className="text-[10px] text-gray-400 mt-1.5 italic">
            Unknown = pitcher's handedness not in our roster data (mostly OOC opponents).
          </p>
        )}
      </div>
    </div>
  )
}

// ── helpers ──────────────────────────────────────────────────────

function Tile({ label, value, sub }) {
  return (
    <div className="text-center py-2 px-1 border border-gray-100 rounded bg-gray-50">
      <div className="text-[9px] uppercase tracking-wide text-gray-500 font-semibold">
        {label}
      </div>
      <div className="text-base sm:text-lg font-bold text-gray-900 tabular-nums">
        {value ?? '-'}
      </div>
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

// ── Color coding (Savant-style) ─────────────────────────────────
// Compares cell value to league baseline (league average for the same
// division + same filter). Red = above league (good for batter), blue
// = below league (bad). Direction inverts for K%/Whiff% where low is
// good. Returns Tailwind background class or '' when no signal.

const METRIC_DIRECTION = {
  ba: 'high', obp: 'high', slg: 'high', ops: 'high',
  iso: 'high', woba: 'high', contact_pct: 'high', bb_pct: 'high',
  k_pct: 'low', whiff_pct: 'low',
  // swing_pct intentionally omitted — not inherently good or bad
}

const METRIC_THRESHOLDS = {
  ba: [0.030, 0.060],
  obp: [0.040, 0.080],
  slg: [0.060, 0.120],
  ops: [0.100, 0.200],
  iso: [0.040, 0.080],
  woba: [0.040, 0.080],
  contact_pct: [0.040, 0.080],
  bb_pct: [0.030, 0.060],
  k_pct: [0.040, 0.080],
  whiff_pct: [0.040, 0.080],
}

function colorClass(metric, value, leagueValue) {
  if (value == null || leagueValue == null) return ''
  const dir = METRIC_DIRECTION[metric]
  const t = METRIC_THRESHOLDS[metric]
  if (!dir || !t) return ''
  let delta = value - leagueValue
  if (dir === 'low') delta = -delta
  if (delta >= t[1]) return 'bg-red-200'
  if (delta >= t[0]) return 'bg-red-100'
  if (delta <= -t[1]) return 'bg-blue-200'
  if (delta <= -t[0]) return 'bg-blue-100'
  return ''
}

function cellTitle(metric, value, leagueValue, formatter) {
  // tooltip: "League: .293" so user can hover to see the benchmark
  if (leagueValue == null) return undefined
  return `League ${formatter(leagueValue)}`
}
