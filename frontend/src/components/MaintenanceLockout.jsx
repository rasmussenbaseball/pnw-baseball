import { Link, useLocation } from 'react-router-dom'
import { useTier } from '../hooks/useTier'
import { tierMeets, DEVELOPER_EMAILS } from '../lib/tiers'
import { useAuth } from '../context/AuthContext'
import { usePreview } from '../context/PreviewContext'
import { supabase } from '../lib/supabase'

/**
 * MaintenanceLockout — full-screen overlay that blocks everyone below
 * the Coach tier from using the site during major-construction
 * windows.
 *
 * Toggle:
 *   Set VITE_MAINTENANCE_LOCKOUT=true in Vercel env vars + redeploy
 *   to enable. Set it back to anything else (or remove it) to
 *   disable. No code changes needed to flip the switch.
 *
 * Access rules when active:
 *   - coach + dev tiers   → pass through, see the full site
 *   - all other tiers     → full-screen lockout, no navigation
 *   - /auth route         → always reachable so a Coach/Dev who isn't
 *                            signed in can still sign in
 *   - /unsubscribe        → reachable too, since people may click
 *                            email links during the window
 *
 * Doesn't affect the API at all — the backend keeps serving normally
 * (the GH Actions NWAC scrape, cron jobs, etc. all continue). Only
 * the SPA shell renders the overlay.
 */
// To toggle the lockout: flip this constant and push. Vercel
// auto-deploys in ~60s. Setting via Vercel env var (the old path)
// also still works — env var wins if it's set to 'true'.
const LOCKOUT_FORCE_ON = true

export default function MaintenanceLockout({ children }) {
  const envFlag = import.meta.env.VITE_MAINTENANCE_LOCKOUT === 'true'
  const enabled = LOCKOUT_FORCE_ON || envFlag
  const { tier, loading } = useTier()
  const { user, realUser } = useAuth()
  const { previewTier, exitPreview } = usePreview()
  const location = useLocation()

  // Lockout flag off → no-op
  if (!enabled) return children

  // Escape hatches: signing in and unsubscribing must still work.
  if (
    location.pathname.startsWith('/auth') ||
    location.pathname.startsWith('/unsubscribe')
  ) {
    return children
  }

  // Developer-tier bypass — check the REAL underlying user, not the
  // previewed tier. Without this, a developer who flipped their view
  // to "anonymous" with the preview widget would lock themselves out
  // of their own site with no way back in (the preview-exit toggle
  // lives inside the regular UI that the lockout would otherwise hide).
  //
  // Devs always render the full site. If they want to see what a
  // lower tier sees during a lockout window, they can flip the env
  // flag off temporarily.
  const realEmail = realUser?.email
  if (realEmail && DEVELOPER_EMAILS.includes(realEmail)) {
    // Belt-and-suspenders: also clear any active preview that was
    // hiding the in-site exit toggle. Otherwise the preview widget
    // on the homepage would still report "previewing as X" once
    // they're past the lockout.
    if (previewTier) {
      try { exitPreview() } catch { /* noop */ }
    }
    return children
  }

  // While we're resolving the tier, render nothing so we don't briefly
  // flash the site to someone who's about to get locked out.
  if (loading) return null

  // Coach + dev (and any future tier above Coach) get through.
  if (tierMeets(tier, 'coach')) return children

  return <LockoutScreen user={user} />
}


function _UnusedPreviewBanner({ children, exitPreview, previewTier }) {
  // Kept around in case we want to bring back the "view as X with
  // a one-click exit" pattern after the lockout window. Not rendered
  // currently — devs pass straight through the lockout instead.
  return (
    <>
      <div className="fixed top-0 inset-x-0 z-[10000] bg-amber-400 text-[#003845] text-xs sm:text-sm font-semibold px-3 py-1.5 flex items-center justify-center gap-3 shadow">
        <span>
          Previewing as <span className="font-mono">{previewTier}</span>
        </span>
        <button
          type="button"
          onClick={exitPreview}
          className="px-2 py-0.5 rounded bg-[#003845] text-amber-300 hover:bg-[#005266] transition-colors"
        >
          Exit preview
        </button>
      </div>
      <div className="pt-8">{children}</div>
    </>
  )
}


function LockoutScreen({ user }) {
  const handleSignOut = async () => {
    try { await supabase.auth.signOut() } catch (_) { /* noop */ }
    window.location.assign('/auth')
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-gradient-to-br from-[#003845] via-[#00687a] to-[#008ba6] text-white">
      <div className="max-w-xl w-full mx-4 sm:mx-6 rounded-2xl bg-white/10 backdrop-blur-md border border-white/15 shadow-2xl p-6 sm:p-10">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex items-center justify-center w-12 h-12 rounded-lg bg-amber-400 text-[#003845] font-black text-xl">
            NW
          </div>
          <div className="text-lg font-bold">NW Baseball Stats</div>
        </div>

        <div className="mb-2 text-amber-300 text-xs font-semibold uppercase tracking-[2px]">
          Under Construction
        </div>

        <h1 className="text-3xl sm:text-4xl font-extrabold leading-tight mb-4">
          We're rebuilding a few things.
        </h1>

        <p className="text-base sm:text-lg text-white/85 leading-relaxed mb-6">
          The site's offline for a day or two while we ship some major
          upgrades. We'll be back shortly with new tools and a faster,
          cleaner experience.
        </p>

        <div className="rounded-lg bg-white/10 border border-white/15 p-4 mb-6 text-sm text-white/90">
          <div className="font-semibold mb-1">Coach &amp; Scout subscribers</div>
          <p className="text-white/75">
            Your access continues during construction. Sign in below to
            keep using the full site.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {user ? (
            <>
              <button
                type="button"
                onClick={handleSignOut}
                className="px-5 py-2.5 bg-amber-400 text-[#003845] rounded-lg font-semibold hover:bg-amber-300 transition-colors"
              >
                Sign in as another account
              </button>
              <span className="text-sm text-white/70">
                Signed in as <span className="font-mono">{user.email}</span>
              </span>
            </>
          ) : (
            <Link
              to="/auth"
              className="px-5 py-2.5 bg-amber-400 text-[#003845] rounded-lg font-semibold hover:bg-amber-300 transition-colors"
            >
              Sign in
            </Link>
          )}
          <a
            href="https://twitter.com/RasmussenBase"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-white/70 hover:text-white underline-offset-4 hover:underline"
          >
            Updates on X
          </a>
        </div>

        <div className="mt-8 pt-4 border-t border-white/10 text-xs text-white/55">
          Questions? Email{' '}
          <a
            href="mailto:nate@nwbaseballstats.com"
            className="underline-offset-4 hover:underline"
          >
            nate@nwbaseballstats.com
          </a>
        </div>
      </div>
    </div>
  )
}
