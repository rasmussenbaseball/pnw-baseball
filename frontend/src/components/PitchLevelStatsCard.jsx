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
      <p className="text-[10px] text-gray-500 mb-3">
        {d.total_pa} PA total · {d.tracked_pa} with pitch data ({trackedShare}%) · {d.pitches} pitches seen
      </p>

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
          <table className="w-full text-xs min-w-[480px]">
            <thead className="bg-gray-50 text-gray-600 uppercase tracking-wide text-[10px]">
              <tr>
                <th className="text-left px-2 py-1.5">Count</th>
                <th className="text-right px-2 py-1.5">PA</th>
                <th className="text-right px-2 py-1.5">Pitches</th>
                <th className="text-right px-2 py-1.5">BA</th>
                <th className="text-right px-2 py-1.5">OBP</th>
                <th className="text-right px-2 py-1.5">SLG</th>
                <th className="text-right px-2 py-1.5">OPS</th>
              </tr>
            </thead>
            <tbody>
              {data.count_states.map((cs, i) => (
                <tr key={cs.label} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                  <td className="px-2 py-1.5">
                    <div className="font-medium text-gray-900">{cs.label}</div>
                    <div className="text-[10px] text-gray-400">{cs.detail}</div>
                  </td>
                  <td className="text-right px-2 py-1.5 text-gray-700 tabular-nums">{cs.pa}</td>
                  <td className="text-right px-2 py-1.5 text-gray-500 tabular-nums">{cs.pitches}</td>
                  <td className="text-right px-2 py-1.5 font-semibold text-gray-900 tabular-nums">{fmtRate(cs.ba)}</td>
                  <td className="text-right px-2 py-1.5 text-gray-700 tabular-nums">{fmtRate(cs.obp)}</td>
                  <td className="text-right px-2 py-1.5 text-gray-700 tabular-nums">{fmtRate(cs.slg)}</td>
                  <td className="text-right px-2 py-1.5 text-gray-700 tabular-nums">{fmtRate(cs.ops)}</td>
                </tr>
              ))}
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
          <table className="w-full text-xs min-w-[480px]">
            <thead className="bg-gray-50 text-gray-600 uppercase tracking-wide text-[10px]">
              <tr>
                <th className="text-left px-2 py-1.5">Split</th>
                <th className="text-right px-2 py-1.5">PA</th>
                <th className="text-right px-2 py-1.5">Pitches</th>
                <th className="text-right px-2 py-1.5">BA</th>
                <th className="text-right px-2 py-1.5">OBP</th>
                <th className="text-right px-2 py-1.5">SLG</th>
                <th className="text-right px-2 py-1.5">OPS</th>
              </tr>
            </thead>
            <tbody>
              {data.lr_splits.map((sp, i) => (
                <tr key={sp.label} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                  <td className="px-2 py-1.5 font-medium text-gray-900">{sp.label}</td>
                  <td className="text-right px-2 py-1.5 text-gray-700 tabular-nums">{sp.pa}</td>
                  <td className="text-right px-2 py-1.5 text-gray-500 tabular-nums">{sp.pitches}</td>
                  <td className="text-right px-2 py-1.5 font-semibold text-gray-900 tabular-nums">{fmtRate(sp.ba)}</td>
                  <td className="text-right px-2 py-1.5 text-gray-700 tabular-nums">{fmtRate(sp.obp)}</td>
                  <td className="text-right px-2 py-1.5 text-gray-700 tabular-nums">{fmtRate(sp.slg)}</td>
                  <td className="text-right px-2 py-1.5 text-gray-700 tabular-nums">{fmtRate(sp.ops)}</td>
                </tr>
              ))}
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
