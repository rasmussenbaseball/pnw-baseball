// <RequireTier minTier="premium">…</RequireTier>
//
// Drop-in route gate, analogous to <RequireAuth>, but enforces a
// minimum SUBSCRIPTION TIER (none → free → premium → coach).
//
// Behavior when the user's tier is BELOW the required minimum:
//   • Renders a configurable fallback. Defaults to a friendly
//     "Upgrade to access this" card linking to /pricing.
//   • Anonymous users get a sign-in nudge instead.
//
// Behavior when the tier is loading: renders nothing (avoids
// flashing the upgrade card before we've checked). The check itself
// is cheap (cached in localStorage) so this is usually a single frame.
//
// NOTE: like every frontend gate, this is UX-only. Backend endpoints
// that return premium data must enforce the same check server-side.

import { Link, useLocation } from 'react-router-dom'
import { useTier } from '../hooks/useTier'
import { usePreview } from '../context/PreviewContext'
import { TIER_META, tierMeets } from '../lib/tiers'

// Vite build-time flag. When 'true', tier checks are enforced and
// users below `minTier` see the upsell card. When ANYTHING ELSE
// (default), we run in "soft mode" — anonymous still get an
// upsell/sign-in nudge, but every signed-in user passes through.
//
// This lets us wire <RequireTier> around premium routes RIGHT NOW
// without locking out our current free users. When payments go live,
// set VITE_TIER_GATING_ENABLED=true in the build environment and
// rebuild. One flag flips the whole paywall on.
const GATING_ENABLED = (import.meta.env.VITE_TIER_GATING_ENABLED || '')
  .toString().toLowerCase() === 'true'


export default function RequireTier({ minTier = 'free', children, fallback }) {
  const { tier, loading, user } = useTier()
  const { previewTier } = usePreview()
  const location = useLocation()

  if (loading) return null

  // Author-preview mode: behave AS IF gating is hard-on. This is what
  // makes "View as free" actually block premium pages even while we're
  // pre-launch in soft mode. Falls through to the HARD MODE block below.
  const effectiveHardMode = GATING_ENABLED || !!previewTier

  // ── SOFT MODE (default, pre-launch) ─────────────────────────
  // Just keep anonymous users out of authenticated pages. Every
  // signed-in user — regardless of subscription — passes through.
  if (!effectiveHardMode) {
    if (minTier === 'none') return children
    if (user) return children
    return fallback || (
      <DefaultUpsell
        userTier="none"
        minTier={minTier}
        signedIn={false}
        from={location.pathname}
      />
    )
  }

  // ── HARD MODE (post-launch) ─────────────────────────────────
  // Enforce the full tier ladder.
  if (tierMeets(tier, minTier)) return children
  if (fallback) return fallback
  return (
    <DefaultUpsell
      userTier={tier}
      minTier={minTier}
      signedIn={!!user}
      from={location.pathname}
    />
  )
}


function DefaultUpsell({ userTier, minTier, signedIn, from }) {
  const needLabel = TIER_META[minTier]?.label || minTier
  const youLabel  = TIER_META[userTier]?.label || userTier

  return (
    <div className="max-w-xl mx-auto px-4 py-12">
      <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700
                      shadow-sm p-6 sm:p-8 text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full
                        bg-nw-teal/10 text-nw-teal mb-3">
          <svg className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round"
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <h2 className="text-xl sm:text-2xl font-extrabold text-gray-900 dark:text-gray-100 mb-1">
          {needLabel} access required
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
          {signedIn
            ? `You're on the ${youLabel} tier. Upgrade to ${needLabel} to unlock this page.`
            : 'Sign in or sign up to access this page.'}
        </p>
        <div className="flex flex-col sm:flex-row gap-2 justify-center">
          {!signedIn && (
            <Link
              to={`/login?next=${encodeURIComponent(from)}`}
              className="px-4 py-2 text-sm font-bold uppercase tracking-wider rounded
                         bg-nw-teal hover:bg-nw-teal-dark text-white transition-colors"
            >
              Sign in
            </Link>
          )}
          <Link
            to="/pricing"
            className="px-4 py-2 text-sm font-bold uppercase tracking-wider rounded
                       border border-nw-teal text-nw-teal hover:bg-nw-teal hover:text-white
                       transition-colors"
          >
            Compare plans
          </Link>
        </div>
        {/* Escape hatch back to public content — keeps people from
            feeling trapped on the upsell card. */}
        <div className="mt-5 pt-4 border-t border-gray-100 dark:border-gray-700">
          <Link
            to="/"
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-nw-teal
                       dark:hover:text-nw-teal transition-colors inline-flex items-center gap-1"
          >
            ← Back to homepage
          </Link>
        </div>
      </div>
    </div>
  )
}
