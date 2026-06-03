import { useEffect, useState } from 'react'

// Site-entry notice shown during an unusually high-traffic period, so visitors
// know slow / temporarily-unavailable pages are expected and not broken.
//
// Flip ENABLED to false (one line) to remove it once traffic settles — no other
// changes needed. Shows once per browser session (sessionStorage), so it doesn't
// nag on every navigation but reappears for a fresh visit.
const ENABLED = false  // Site is healthy again (Supabase upgraded + queries optimized). Flip to true to re-show during a future spike.
const DISMISS_KEY = 'nwbb_traffic_notice_dismissed'

export default function HighTrafficNotice() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!ENABLED) return
    let dismissed = false
    try { dismissed = sessionStorage.getItem(DISMISS_KEY) === '1' } catch { /* storage blocked */ }
    if (!dismissed) setOpen(true)
  }, [])

  if (!ENABLED || !open) return null

  const dismiss = () => {
    try { sessionStorage.setItem(DISMISS_KEY, '1') } catch { /* storage blocked */ }
    setOpen(false)
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center bg-black/50 px-4 pb-4 sm:pb-0"
      role="dialog"
      aria-modal="true"
      aria-labelledby="traffic-notice-title"
      onClick={dismiss}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white dark:bg-gray-800 shadow-2xl border border-gray-200 dark:border-gray-700 p-6 sm:p-7 text-center"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-pnw-green/10 dark:bg-pnw-green/20 mb-3">
          <svg className="w-6 h-6 text-pnw-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <h2 id="traffic-notice-title" className="text-lg font-bold text-pnw-slate dark:text-gray-100 mb-2">
          We're seeing heavy traffic right now
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-5 leading-relaxed">
          Thanks for stopping by! We're getting an unusually high number of visitors,
          so some pages — especially individual player profiles — may load slowly or be
          briefly unavailable. Most of the site is working normally. Hang tight, and
          thanks for your patience.
        </p>
        <button
          onClick={dismiss}
          className="w-full px-5 py-2.5 bg-pnw-green text-white rounded-lg font-semibold hover:bg-pnw-forest transition-colors"
        >
          Got it
        </button>
      </div>
    </div>
  )
}
