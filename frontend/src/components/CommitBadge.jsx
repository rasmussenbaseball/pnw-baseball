// CommitBadge — a compact "committed to X" indicator shown next to a
// player's name on stat tables. Mostly relevant for JUCO/NWAC players
// who've committed to a four-year program, but renders for any player
// whose `committed_to` is set. Full school name in the title tooltip;
// the visible text truncates so it never blows up a dense table cell.

export default function CommitBadge({ school }) {
  if (!school) return null
  return (
    <span
      title={`Committed to ${school}`}
      className="inline-flex items-center gap-0.5 max-w-full align-middle text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 leading-tight"
    >
      <svg viewBox="0 0 24 24" className="w-3 h-3 shrink-0" fill="currentColor" aria-hidden="true">
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
      </svg>
      <span className="truncate">{school}</span>
    </span>
  )
}
