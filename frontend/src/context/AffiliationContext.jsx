// AffiliationContext — the "your team" designation for Coach / Dev
// users. Powers the player-highlight feature and seeds the Portal's
// default team selection.
//
// Storage: the source of truth is /me/affiliated-team on the backend.
// We mirror to localStorage so the highlight applies instantly on
// page load without waiting for the network round-trip.
//
// Anyone NOT signed in or below the Coach tier silently gets a null
// affiliation; the UI for setting it lives on the Account page and
// is hidden for those tiers.

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { useAuth } from './AuthContext'
import { supabase } from '../lib/supabase'

const STORAGE_KEY = 'affiliated_team_v1'
const API_BASE = '/api/v1'

const AffiliationContext = createContext({
  team: null,
  loading: true,
  setAffiliation: async () => {},
  clearAffiliation: async () => {},
})


function readCache() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeCache(team) {
  if (typeof window === 'undefined') return
  try {
    if (team) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(team))
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // quota / private mode — fine to ignore
  }
}


export function AffiliationProvider({ children }) {
  const { user, session } = useAuth()
  const [team, setTeam] = useState(() => readCache())
  const [loading, setLoading] = useState(true)

  // Fetch from server when the auth session changes.
  useEffect(() => {
    let alive = true
    if (!user || !session) {
      // Signed-out users have no affiliation.
      setTeam(null)
      writeCache(null)
      setLoading(false)
      return () => { alive = false }
    }
    setLoading(true)
    fetch(`${API_BASE}/me/affiliated-team`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!alive) return
        const t = data?.team || null
        setTeam(t)
        writeCache(t)
      })
      .catch(() => { /* keep cached value */ })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [user, session])

  const setAffiliation = useCallback(async (teamId) => {
    if (!session) throw new Error('Not signed in')
    const r = await fetch(`${API_BASE}/me/affiliated-team`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ team_id: teamId }),
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`Save failed: HTTP ${r.status} ${body}`)
    }
    const data = await r.json()
    const t = data?.team || null
    setTeam(t)
    writeCache(t)
    return t
  }, [session])

  const clearAffiliation = useCallback(() => setAffiliation(null), [setAffiliation])

  return (
    <AffiliationContext.Provider value={{
      team,
      loading,
      setAffiliation,
      clearAffiliation,
    }}>
      {children}
    </AffiliationContext.Provider>
  )
}


/**
 * useAffiliatedTeam — exposes the current user's "your team".
 *
 * Returns: { team, loading, setAffiliation, clearAffiliation }
 *   team         : { id, short_name, school_name, logo_url, division_level }
 *                  or null when "No affiliation"
 *   loading      : true until the initial /me/affiliated-team fetch resolves
 *   setAffiliation(teamId) : PUT to server; teamId=null clears
 *   clearAffiliation()     : alias for setAffiliation(null)
 *
 * Safe to call from any component — outside the provider returns a
 * no-op stub with team=null, loading=false. That keeps optional
 * highlight logic from blowing up if it renders before the provider.
 */
export function useAffiliatedTeam() {
  return useContext(AffiliationContext)
}
