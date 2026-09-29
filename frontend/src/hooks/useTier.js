// useTier() — the current viewer's access level.
//
// There are no paid tiers any more (September 2026). The hook exists so the
// handful of components that care about developer access (RequireDev, the
// dev-only TrackMan card, dev menu items) have one place to ask. It is
// resolved entirely on the client from DEVELOPER_EMAILS; no network call.
//
// Returns:
//   tier    'none' (signed out) | 'user' (signed in) | 'dev' (developer allowlist)
//   isDev   convenience boolean
//   user    the Supabase user (or null)
//   loading true until the auth session has resolved

import { useAuth } from '../context/AuthContext'
import { isDeveloper } from '../lib/tiers'

export function useTier() {
  const { user, loading } = useAuth()
  const isDev = !!user?.email && isDeveloper(user.email)
  const tier = isDev ? 'dev' : user ? 'user' : 'none'
  return { tier, isDev, user, loading }
}
