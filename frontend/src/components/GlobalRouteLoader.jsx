// GlobalRouteLoader — a fixed-position spinner badge that becomes
// visible whenever any API request has been in flight for longer than
// the threshold (default 700ms). useApi.js bumps / decrements a global
// counter via `lib/pendingRequests`; this component subscribes to that
// counter and reveals itself with a small delay so it doesn't flash
// for fast requests.
//
// Mounted once at the App root so EVERY page benefits without each
// page component needing its own loading UI.

import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { subscribeToPending } from '../lib/pendingRequests'

const REVEAL_DELAY_MS = 700  // wait this long before showing the badge

export default function GlobalRouteLoader() {
  const [pending, setPending] = useState(0)
  const [visible, setVisible] = useState(false)
  const location = useLocation()

  // Sub/unsub on mount/unmount.
  useEffect(() => {
    const unsub = subscribeToPending((n) => setPending(n))
    return unsub
  }, [])

  // Reset visibility on route change so a stuck spinner from a
  // previous page never lingers.
  useEffect(() => {
    setVisible(false)
  }, [location.pathname])

  // After the reveal delay, show the spinner if requests are still
  // pending. If they finish before the delay, no spinner ever shows.
  useEffect(() => {
    if (pending <= 0) {
      setVisible(false)
      return
    }
    const t = setTimeout(() => setVisible(true), REVEAL_DELAY_MS)
    return () => clearTimeout(t)
  }, [pending])

  if (!visible) return null

  return (
    <div
      role="status"
      aria-label="Loading"
      className="fixed top-3 right-3 sm:top-4 sm:right-4 z-[9998]
                 flex items-center gap-2
                 bg-white/95 dark:bg-gray-800/95 backdrop-blur
                 shadow-lg ring-1 ring-gray-200 dark:ring-gray-700
                 rounded-full pl-2.5 pr-3.5 py-1.5
                 text-xs font-medium text-gray-700 dark:text-gray-200"
    >
      <span
        className="block h-3.5 w-3.5 rounded-full
                   border-2 border-pnw-sky border-t-transparent
                   animate-spin"
      />
      Loading...
    </div>
  )
}
