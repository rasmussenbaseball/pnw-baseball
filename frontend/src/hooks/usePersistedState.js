import { useState, useCallback } from 'react'

/**
 * Like useState, but persists to sessionStorage so filters
 * survive navigation between pages within a session.
 *
 * @param {string} key - Unique storage key (e.g. "juco_position")
 * @param {*} defaultValue - Initial value if nothing stored
 */
export function usePersistedState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = sessionStorage.getItem(key)
      if (stored !== null) return JSON.parse(stored)
    } catch { /* ignore */ }
    return defaultValue
  })

  const setPersisted = useCallback((valOrFn) => {
    setValue(prev => {
      const next = typeof valOrFn === 'function' ? valOrFn(prev) : valOrFn
      try { sessionStorage.setItem(key, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [key])

  return [value, setPersisted]
}
