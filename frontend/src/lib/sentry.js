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
    // Ignore noisy browser-extension and third-party errors that aren't ours.
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      'Non-Error promise rejection captured',
    ],
  })

  initialized = true
}

export { Sentry }
