// useTier() — resolves the current user's subscription tier.
//
// Returns one of: 'none' | 'free' | 'premium' | 'coach' plus a loading
// flag so consumers can render a spinner or nothing during fetch.
//
// Mapping rules:
//   • Not signed in (no user) → 'none'
//   • Signed in + no /me/subscription row → 'free'
//   • /me/subscription returns tier='free'   → 'free'
//   • /me/subscription returns tier='paid'   → 'premium'
//     (until the backend tier enum is expanded to include 'premium'
//     and 'coach' explicitly, 'paid' is treated as premium)
//   • /me/subscription returns tier='coach'  → 'coach'  (future)
//
// Internally caches the result in localStorage so a tier check on
// a fresh page load doesn't have to wait for the network round-trip
// before deciding whether to show a teaser or full content.
//
// Refreshes every time the auth session changes (sign-in, sign-out).

import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'

const API_BASE = '/api/v1'
const CACHE_KEY = 'tier_cache_v1'

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw)
    // Cache is per-user; stale across logins gets invalidated below.
    return c
  } catch { return null }
}

function writeCache(userId, tier) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ userId, tier, at: Date.now() }))
  } catch {}
}

export function useTier() {
  const { user, session, loading: authLoading } = useAuth()
  const [tier, setTier] = useState(() => {
    if (!user) return 'none'
    const cached = readCache()
    if (cached && cached.userId === user.id) return cached.tier
    return 'free'  // safe default for signed-in users until we know better
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (authLoading) return
    if (!user || !session) {
      setTier('none')
      setLoading(false)
      return
    }
    let alive = true
    fetch(`${API_BASE}/me/subscription`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => {
        if (!alive) return
        let next = 'free'
        // Backend currently only knows 'free' | 'paid'. Map until
        // 'premium' / 'coach' are added explicitly server-side.
        if (d.tier === 'paid')    next = 'premium'
        if (d.tier === 'premium') next = 'premium'
        if (d.tier === 'coach')   next = 'coach'
        setTier(next)
        writeCache(user.id, next)
      })
      .catch(() => { if (alive) setTier('free') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [user, session, authLoading])

  return { tier, loading: loading || authLoading, user }
}
