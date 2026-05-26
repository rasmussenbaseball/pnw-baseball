// MaintenanceBanner — small dismissible amber notice shown on the
// homepage while the site is actively being worked on. Auto-hides
// itself after MAINTENANCE_END so we don't have to remember to take
// it down. Dismissal sticks per-session.
//
// To remove later: just delete the import + render in Homepage.jsx,
// or bump MAINTENANCE_END into the past.

import { useState } from 'react'

// Window during which the banner is visible (Pacific time-ish; we use
// a UTC instant to avoid TZ math at render time).
const MAINTENANCE_END = new Date('2026-05-28T08:00:00-07:00')  // Wed 8am PT

export default function MaintenanceBanner() {
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem('maint-banner-dismissed-2026-05-26') === '1' }
    catch { return false }
  })

  if (dismissed) return null
  if (Date.now() > MAINTENANCE_END.getTime()) return null

  const dismiss = () => {
    setDismissed(true)
    try { sessionStorage.setItem('maint-banner-dismissed-2026-05-26', '1') } catch {}
  }

  return (
    <div
      role="status"
      className="mb-3 rounded-lg border border-amber-300 dark:border-amber-700/60
                 bg-amber-50 dark:bg-amber-900/30 px-4 py-3
                 flex items-start gap-3"
    >
      <svg
        aria-hidden
        className="w-5 h-5 mt-0.5 text-amber-600 dark:text-amber-300 shrink-0"
        fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round"
              d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-amber-900 dark:text-amber-200">
          Site under construction (May 26 + 27)
        </p>
        <p className="text-xs text-amber-900/80 dark:text-amber-200/80 mt-0.5 leading-snug">
          We're shipping a bunch of improvements across the next two days.
          You may see the occasional error or temporarily-unavailable feature.
          Thanks for bearing with us.
        </p>
      </div>
      <button
        onClick={dismiss}
        aria-label="Dismiss notice"
        className="shrink-0 p-1 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40
                   text-amber-700 dark:text-amber-300"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
