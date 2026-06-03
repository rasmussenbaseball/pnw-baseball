import { lazy } from 'react'

// Shared with the vite:preloadError handler in main.jsx so the two recovery
// paths can't double-reload. One reload per 10s window, tracked in sessionStorage.
const RELOAD_KEY = 'nwbb_chunk_reload_ts'
const RELOAD_WINDOW_MS = 10000

function shouldReloadOnce() {
  let last = 0
  try { last = Number(sessionStorage.getItem(RELOAD_KEY) || 0) } catch { /* storage blocked */ }
  if (Date.now() - last > RELOAD_WINDOW_MS) {
    try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())) } catch { /* storage blocked */ }
    return true
  }
  return false
}

/**
 * React.lazy wrapper that self-heals stale code-split chunks after a redeploy.
 *
 * Each frontend deploy gives every chunk a fresh content-hash filename, so the
 * old names 404. A tab still running the previous build fails the first time it
 * lazy-loads a route — in one of two ways:
 *
 *   1) import() REJECTS — "Failed to fetch dynamically imported module" /
 *      "error loading dynamically imported module", or a module-MIME error when
 *      our SPA host answers the missing asset with index.html (text/html).
 *   2) import() RESOLVES to a bogus module with no default export — the same
 *      index.html case on hosts without strict module-MIME enforcement — which
 *      later detonates inside React.lazy as "undefined is not an object
 *      (evaluating '…_result.default')" or "Cannot read properties of undefined
 *      (reading 'default')". These were the /player and /news Sentry crashes.
 *
 * Either way the cure is identical: reload once to pull the current asset
 * manifest. The sessionStorage guard keeps a genuinely-broken chunk from
 * reload-looping — the second failure inside the window rethrows and surfaces
 * in the ErrorBoundary, as it should.
 */
export function lazyWithRetry(factory) {
  return lazy(() =>
    factory()
      .then((mod) => {
        if (!mod || typeof mod.default === 'undefined') {
          // Resolved, but it's not a real module (stale host served index.html).
          throw new Error('Dynamic import resolved without a default export')
        }
        return mod
      })
      .catch((err) => {
        if (shouldReloadOnce()) {
          window.location.reload()
          // Keep Suspense pending through the reload instead of flashing the
          // crash fallback for a split second.
          return new Promise(() => {})
        }
        throw err
      })
  )
}
