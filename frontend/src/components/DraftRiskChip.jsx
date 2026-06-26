/**
 * "Draft" chip — shown for a player ranked in the top 30 of the current PNW MLB
 * Draft Board. Signals that a returning-by-class player could still be lost to
 * the draft. Renders nothing if the player isn't a top-30 prospect.
 */
import { draftRisk } from '../lib/draftRisk'

export default function DraftRiskChip({ playerId, className = '' }) {
  const d = draftRisk(playerId)
  if (!d) return null
  return (
    <span
      title={`#${d.rank} on the ${d.year} PNW MLB Draft Board — could be lost to the draft`}
      className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 ${className}`}
    >
      ◆ Draft #{d.rank}
    </span>
  )
}
