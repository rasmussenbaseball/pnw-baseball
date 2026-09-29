import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { DEVELOPER_EMAILS } from '../lib/tiers'
import { supabase } from '../lib/supabase'

/**
 * MaintenanceLockout — full-screen overlay that blocks everyone except
 * developers from using the site during major-construction windows.
 *
 * Toggle:
 *   Set VITE_MAINTENANCE_LOCKOUT=true in Vercel env vars + redeploy
 *   to enable, or flip LOCKOUT_FORCE_ON below and push.
 *
 * Access rules when active:
 *   - developer accounts  → pass through, see the full site
 *   - everyone else       → full-screen lockout, no navigation
 *   - /login, /auth       → always reachable so a developer can sign in
 *   - /unsubscribe        → reachable too, since people may click
 *                            email links during the window
 *
 * Doesn't affect the API at all; only the SPA shell renders the overlay.
 */
const LOCKOUT_FORCE_ON = false

export default function MaintenanceLockout({ children }) {
  const envFlag = import.meta.env.VITE_MAINTENANCE_LOCKOUT === 'true'
  const enabled = LOCKOUT_FORCE_ON || envFlag
  const { user, loading } = useAuth()
  const location = useLocation()

  if (!enabled) return children

  if (
    location.pathname.startsWith('/auth') ||
    location.pathname.startsWith('/login') ||
    location.pathname.startsWith('/unsubscribe')
  ) {
    return children
  }

  // While auth is resolving, render nothing so we don't briefly flash the
  // site to someone who's about to get locked out.
  if (loading) return null

  const email = (user?.email || '').toLowerCase()
  if (email && DEVELOPER_EMAILS.includes(email)) return children

  return <LockoutScreen user={user} />
}


function LockoutScreen({ user }) {
  const handleSignOut = async () => {
    try { await supabase.auth.signOut() } catch (_) { /* noop */ }
    window.location.assign('/login')
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
              to="/login"
              className="px-5 py-2.5 bg-amber-400 text-[#003845] rounded-lg font-semibold hover:bg-amber-300 transition-colors"
            >
              Sign in
            </Link>
          )}
        </div>

        <div className="mt-8 pt-4 border-t border-white/10 text-xs text-white/55">
          Questions? Email{' '}
          <a
            href="mailto:info@nwbaseballstats.com"
            className="underline-offset-4 hover:underline"
          >
            info@nwbaseballstats.com
          </a>
        </div>
      </div>
    </div>
  )
}
