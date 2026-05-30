// Shared chrome for /summer/* subpages.
// Compact heading + breadcrumb-style back link so every dedicated
// page (Stats, Scoreboard, Standings, Teams, PNW Alumni, etc.)
// stays visually consistent with the Hub.

import { Link } from 'react-router-dom'

export default function SummerPageShell({ title, subtitle, children, headerExtra = null }) {
  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4">
      <Link to="/summer" className="inline-block text-xs text-nw-teal dark:text-teal-300 hover:underline mb-3">
        ← WCL Hub
      </Link>
      <div className="mb-5 flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">{subtitle}</p>
          )}
        </div>
        {headerExtra}
      </div>
      {children}
    </div>
  )
}
