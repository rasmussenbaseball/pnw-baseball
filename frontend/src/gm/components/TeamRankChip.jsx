/**
 * Inline "#42" chip rendered next to a team name. Sources from the cached
 * NWBB Rating on state.nwbbRatings.
 *
 * Behavior:
 *   - NAIA team WITH a rating: "#42"
 *   - Non-NAIA team: division code, e.g. "D1" / "D3"
 *   - No rating cached (brand new save, pre-week-1): null (renders nothing)
 *
 * Usage:
 *   <span>{game.opponent.name}<TeamRankChip save={save} schoolId={opp.id} /></span>
 */

import { rankLabel } from '../engine/nwbbRating'

export default function TeamRankChip({ save, schoolId, className = '' }) {
  const label = rankLabel(save, schoolId)
  if (!label) return null
  const isNonNaia = !!save?.nwbbRatings?.[schoolId]?.isNonNaia
  // Non-NAIA labels are short ("D1", "D3") — slightly different styling so
  // they don't look like a national rank.
  if (isNonNaia) {
    return (
      <span
        className={'inline-block text-[9px] font-pixel uppercase tracking-wider px-1 py-0.5 rounded bg-[#3a3a5e] text-[#a8a8c8] ml-1 ' + className}
        title={`${label} opponent`}
      >
        {label}
      </span>
    )
  }
  // NAIA — show rank with color tier
  const rank = save.nwbbRatings[schoolId]?.nationalRank
  const colorCls = rank <= 5 ? 'bg-amber-400 text-[#1a1a2e] font-bold'
    : rank <= 15 ? 'bg-amber-400/80 text-[#1a1a2e] font-bold'
    : rank <= 30 ? 'bg-amber-300/60 text-[#1a1a2e]'
    : rank <= 60 ? 'bg-[#3a3a5e] text-amber-200'
    : 'bg-[#3a3a5e] text-[#a8a8c8]'
  return (
    <span
      className={'inline-block text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ml-1 align-baseline ' + colorCls + ' ' + className}
      title={`National rank ${label}`}
    >
      {label}
    </span>
  )
}
