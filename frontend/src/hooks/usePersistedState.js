import { useState, useCallback } from 'react'

/**
 * Like useState, but persists to web storage so values survive navigation.
 *
 * @param {string} key - Unique storage key (e.g. "juco_position")
 * @param {*} defaultValue - Initial value if nothing stored
 * @param {{ storage?: 'session' | 'local' }} [opts] - 'session' (default) lasts
 *   the browser tab; 'local' persists across visits until cleared.
 */
export function usePersistedState(key, defaultValue, opts = {}) {
  const store = () => {
    try { return opts.storage === 'local' ? window.localStorage : window.sessionStorage }
    catch { return null }
  }
  const [value, setValue] = useState(() => {
    try {
      const stored = store()?.getItem(key)
      if (stored != null) return JSON.parse(stored)
    } catch { /* ignore */ }
    return defaultValue
  })

  const setPersisted = useCallback((valOrFn) => {
    setValue(prev => {
      const next = typeof valOrFn === 'function' ? valOrFn(prev) : valOrFn
      try { store()?.setItem(key, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return [value, setPersisted]
}
