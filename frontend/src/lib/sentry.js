/**
 * Sentry crash-reporting setup.
 *
 * No-ops in dev and when no DSN is configured, so local builds never send
 * events. In production, errors and unhandled rejections get reported to
 * the Sentry project named by VITE_SENTRY_DSN.
 *
 * Add VITE_SENTRY_DSN as a Vercel environment variable to turn it on.
 */
import * as Sentry from '@sentry/react'

const DSN = import.meta.env.VITE_SENTRY_DSN
const ENVIRONMENT = import.meta.env.MODE // 'production' on Vercel, 'development' locally

let initialized = false

export function initSentry() {
  if (initialized) return
  if (!DSN) return // No DSN configured — quietly skip (dev, preview without env, etc.)
  if (!import.meta.env.PROD) return // Never report from local dev

  Sentry.init({
    dsn: DSN,
    environment: ENVIRONMENT,
    // Sample 10% of transactions for performance monitoring. Keeps the free
    // tier comfortable; bump up if you need more visibility.
    tracesSampleRate: 0.1,
    integrations: [
      Sentry.browserTracingIntegration(),
    ],
    // Strip query strings from URLs in breadcrumbs so we don't accidentally
    // ship Supabase tokens or email addresses to Sentry.
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data && typeof breadcrumb.data.url === 'string') {
        breadcrumb.data.url = breadcrumb.data.url.split('?')[0]
      }
      return breadcrumb
    },
    // Ignore noisy browser-extension and third-party errors that aren't ours,
    // plus two classes of known-benign noise we were getting emailed about:
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      'Non-Error promise rejection captured',

      // Supabase auth-token Web Lock contention. supabase-js uses the browser
      // Navigator LockManager to serialize token refreshes across tabs; when a
      // user has two tabs open (or refreshes mid-refresh) one request "steals"
      // the lock and the loser throws. supabase-js retries and recovers — it's
      // pure noise, never a real failure. (These were the "/" and "/login"
      // alerts.)
      'Lock was stolen by another request',
      'was released because another request stole it',
      'Acquiring an exclusive Navigator LockManager lock',
      'navigatorLock',

      // Stale code-split chunks after a redeploy. lazyWithRetry + the
      // vite:preloadError handler now auto-reload to recover, so these should
      // no longer reach an ErrorBoundary — this is just a backstop for the rare
      // case where reload is blocked (e.g. sessionStorage disabled). (These
      // were the "/player/…" and "/news/…" _result.default crashes.)
      'Failed to fetch dynamically imported module',
      'error loading dynamically imported module',
      'Importing a module script failed',
      'Unable to preload CSS',
      'Dynamic import resolved without a default export',
      'ChunkLoadError',
    ],
  })

  initialized = true
}

export { Sentry }
