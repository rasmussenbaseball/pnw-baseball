// Portal team selection state — stored in localStorage so a coach's
// "primary focus" team persists across sessions. Wrapped in React
// context so any portal page or header element can read it without
// prop-drilling.
//
// Shape: { id, name, short_name, logo_url } or null when nothing
// has been selected yet (triggers the team-gate prompt).

import { createContext, useContext, useState, useEffect, useCallback } from 'react'


const STORAGE_KEY = 'portalPrimaryTeam'

const PortalTeamContext = createContext(null)


export function PortalTeamProvider({ children }) {
  // Lazy-load from localStorage on mount.
  const [team, setTeam] = useState(() => {
    if (typeof window === 'undefined') return null
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  })

  // Persist whenever team changes.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (team) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(team))
      } else {
        window.localStorage.removeItem(STORAGE_KEY)
      }
    } catch {
      // ignore — quota errors etc.
    }
  }, [team])

  const clearTeam = useCallback(() => setTeam(null), [])

  return (
    <PortalTeamContext.Provider value={{ team, setTeam, clearTeam }}>
      {children}
    </PortalTeamContext.Provider>
  )
}


/**
 * usePortalTeam — read or update the portal's primary team.
 * Returns { team, setTeam, clearTeam }.
 */
export function usePortalTeam() {
  const ctx = useContext(PortalTeamContext)
  if (!ctx) {
    throw new Error('usePortalTeam must be used inside <PortalTeamProvider>')
  }
  return ctx
}
