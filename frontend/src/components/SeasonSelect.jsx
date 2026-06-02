// SeasonSelect — reusable year-filter dropdown.
//
// Drop this anywhere we house season-scoped data. Controlled component:
// pass the current `value` (a number) and an `onChange(year)` handler.
// Defaults to the full SEASONS list, but a caller can pass a narrower
// `seasons` array (e.g. only the seasons a given player has data for, or
// PBP_SEASONS for play-by-play features).

import { SEASONS } from '../lib/seasons'

export default function SeasonSelect({
  value,
  onChange,
  seasons = SEASONS,
  label = null,
  className = '',
  id,
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {label && (
        <label htmlFor={id} className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
          {label}
        </label>
      )}
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800
                   text-gray-800 dark:text-gray-100 text-sm font-semibold px-2 py-1
                   focus:outline-none focus:ring-2 focus:ring-nw-teal/40 cursor-pointer"
      >
        {seasons.map((y) => (
          <option key={y} value={y}>{y}</option>
        ))}
      </select>
    </span>
  )
}
