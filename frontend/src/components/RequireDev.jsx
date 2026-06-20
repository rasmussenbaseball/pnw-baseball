// <RequireDev>…</RequireDev>
//
// Strict dev-only route gate. Unlike <RequireTier>, this one is NOT
// subject to soft-mode pre-launch behavior — it always blocks non-dev
// emails, signed in or not. Use it to hide work-in-progress pages
// (Summer Hub during pre-launch, internal tools, etc.).
//
// Pass-through condition: useTier() returns tier === 'dev', which
// resolves from DEVELOPER_EMAILS in lib/tiers.js.

import { Link, useLocation } from 'react-router-dom'
import { useTier } from '../hooks/useTier'
import { useAuth } from '../context/AuthContext'


// Optional `emails` prop: when provided, pass-through requires the signed-in
// email to be on that list (stricter than the dev tier — used for the
// Commitment Editor). Without it, the gate is the dev tier as before.
export default function RequireDev({ children, fallback, emails }) {
  const { tier, loading } = useTier()
  const { user } = useAuth()
  const location = useLocation()

  if (loading) return null
  const ok = emails
    ? !!user?.email && emails.map(e => e.toLowerCase()).includes(user.email.toLowerCase())
    : tier === 'dev'
  if (ok) return children

  if (fallback) return fallback
  return (
    <div className="max-w-md mx-auto py-20 px-6 text-center">
      <div className="text-5xl mb-4">🔒</div>
      <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">
        In development
      </h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
        This section is still being built and isn't available yet. Check back soon.
      </p>
      <Link
        to="/"
        state={{ from: location.pathname }}
        className="inline-block px-4 py-2 rounded-md bg-nw-teal text-white text-sm font-semibold hover:bg-teal-700"
      >
        Back to home
      </Link>
    </div>
  )
}
