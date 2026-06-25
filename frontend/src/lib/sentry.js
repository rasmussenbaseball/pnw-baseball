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
      'Lock broken by another request',
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
      // React.lazy's resolver reads `payload._result.default`; a tab on an old
      // bundle that navigates to a lazy route whose chunk 404'd after a redeploy
      // throws this. lazyWithRetry reloads to recover on current bundles — this
      // backstops clients still on a pre-fix cached bundle (heavy deploy days).
      '_result.default',

      // Third-party / in-app-browser injected scripts that throw inside our pages
      // but are not our code. Instagram's iOS in-app browser injects a native
      // bridge (window.webkit.messageHandlers / sendDataToNative /
      // sendPageHideMessage) that errors on some pages. Nothing we can fix.
      'window.webkit.messageHandlers',
      'sendDataToNative',
      'sendPageHideMessage',

      // Instagram's ANDROID in-app browser injects iabjs://...android scripts
      // (navigation_performance_logger_android) that call into a native Java
      // bridge. When the WebView tears that bridge down on page unload, the
      // injected sendBeforeUnloadMessage throws "Java object is gone". Not our
      // code, fires on unload, unfixable from our side. (The denyUrls /iabjs:/
      // below is the primary filter; these back it up.)
      'Java object is gone',
      'enableDidUserTypeOnKeyboardLogging',
    ],
    // Drop errors whose stack originates in third-party injected scripts (browser
    // extensions, in-app browsers, translation proxies) rather than our bundle.
    // e.g. "jsQuilting" is an injected script we don't ship; its own 404'd file
    // surfaces as a bogus "Unexpected token '<'" SyntaxError on our pages.
    denyUrls: [
      /jsQuilting/,
      // Instagram's Android in-app browser injects scripts under the iabjs://
      // scheme (e.g. iabjs://navigation_performance_logger_android). Drop any
      // error whose stack originates there.
      /iabjs:/,
    ],
  })

  initialized = true
}

export { Sentry }
