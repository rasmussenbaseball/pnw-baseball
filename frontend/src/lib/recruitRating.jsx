// Color scale for a recruit's 0-100 prospect rating. Deeper teal = higher
// rating, fading to neutral at the low end. Color only, no tier words (Nate,
// 2026-11-22: never label a recruit with a word like "depth").
const SCALE = [
  [85, 'bg-teal-700 text-white dark:bg-teal-500 dark:text-teal-950'],
  [70, 'bg-teal-500 text-white dark:bg-teal-600 dark:text-white'],
  [55, 'bg-teal-300 text-teal-950 dark:bg-teal-700/80 dark:text-teal-50'],
  [40, 'bg-teal-100 text-teal-900 dark:bg-teal-800/60 dark:text-teal-100'],
  [25, 'bg-slate-100 text-slate-700 dark:bg-slate-700/60 dark:text-slate-200'],
  [0, 'bg-slate-50 text-slate-500 dark:bg-slate-800 dark:text-slate-400'],
]

export function ratingClass(score) {
  if (score == null || isNaN(score)) return 'bg-transparent text-gray-400'
  return (SCALE.find(([min]) => score >= min) || SCALE[SCALE.length - 1])[1]
}

export function RatingPill({ score, className = '' }) {
  if (score == null || isNaN(score)) {
    return <span className={`text-[10px] italic text-gray-400 dark:text-gray-500 ${className}`}>-</span>
  }
  return (
    <span className={`inline-flex min-w-[2.25rem] justify-center rounded px-1.5 py-0.5 text-xs font-bold tabular-nums ${ratingClass(score)} ${className}`}
      title="Prospect rating, 0 to 100 on one national scale">
      {Math.round(score)}
    </span>
  )
}
