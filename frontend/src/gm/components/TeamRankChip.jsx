/**
 * Inline chips rendered next to a team name: national rank (#42) + team OVR.
 * Sources rank from the cached NWBB Rating (state.nwbbRatings) and OVR from
 * the live roster (teamOverall).
 *
 * Behavior:
 *   - Team WITH a cached rating: "#42" rank chip
 *   - Opponent NOT in our universe (no roster): division code, e.g. "D1"
 *   - Team WITH a roster: "OVR" chip showing the team overall
 *   - Nothing cached / no roster: those chips render nothing
 *
 * Usage:
 *   <span>{opp.name}<TeamRankChip save={save} schoolId={opp.id} /></span>
 *
 * Props:
 *   showOvr   (default true)  — render the OVR chip
 *   showRank  (default true)  — render the rank chip
 */

import { rankLabel } from '../engine/nwbbRating'
import { teamOverall } from '../engine/playerRating'

export default function TeamRankChip({ save, schoolId, className = '', showOvr = true, showRank = true }) {
  const label = showRank ? rankLabel(save, schoolId) : null
  const isNonNaia = !!save?.nwbbRatings?.[schoolId]?.isNonNaia

  // Team OVR from the live roster (only when the team has a roster in-state).
  let ovr = null
  if (showOvr) {
    const team = save?.teams?.[schoolId]
    if (team && (team.rosterPlayerIds || []).length) {
      const o = teamOverall(team, save.players).overall
      if (o > 0) ovr = o
    }
  }

  const ovrChip = ovr != null ? (
    <span
      className="inline-block text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ml-1 align-baseline bg-pnw-green/20 text-pnw-green"
      title={`Team OVR ${ovr}`}
    >
      {ovr}
    </span>
  ) : null

  let rankChip = null
  if (label) {
    if (isNonNaia) {
      // Opponent outside our universe — short division code, muted styling.
      rankChip = (
        <span
          className="inline-block text-[9px] font-pixel uppercase tracking-wider px-1 py-0.5 rounded bg-[#3a3a5e] text-[#a8a8c8] ml-1"
          title={`${label} opponent`}
        >
          {label}
        </span>
      )
    } else {
      const rank = save.nwbbRatings[schoolId]?.nationalRank
      const colorCls = rank <= 5 ? 'bg-amber-400 text-[#1a1a2e] font-bold'
        : rank <= 15 ? 'bg-amber-400/80 text-[#1a1a2e] font-bold'
        : rank <= 30 ? 'bg-amber-300/60 text-[#1a1a2e]'
        : rank <= 60 ? 'bg-[#3a3a5e] text-amber-200'
        : 'bg-[#3a3a5e] text-[#a8a8c8]'
      rankChip = (
        <span
          className={'inline-block text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ml-1 align-baseline ' + colorCls}
          title={`National rank ${label}`}
        >
          {label}
        </span>
      )
    }
  }

  if (!rankChip && !ovrChip) return null
  return <span className={className}>{rankChip}{ovrChip}</span>
}
