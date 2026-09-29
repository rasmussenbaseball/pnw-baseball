import { useState, useCallback } from 'react'

/**
 * Like useState, but persists to web storage so values survive navigation.
 *
 * @param {string} key - Unique storage key (e.g. "juco_position")
 * @param {*} defaultValue - Initial value if nothing stored
 * @param {{ storage?: 'session' | 'local', sanitize?: (v: any) => any }} [opts] -
 *   storage: 'session' (default) lasts the browser tab; 'local' persists across
 *   visits until cleared. sanitize: applied to a STORED value on read, so a
 *   value that has gone stale (e.g. a season no longer in SEASONS after the
 *   yearly rollover) can be clamped back to something valid instead of sticking.
 */
export function usePersistedState(key, defaultValue, opts = {}) {
  const store = () => {
    try { return opts.storage === 'local' ? window.localStorage : window.sessionStorage }
    catch { return null }
  }
  const [value, setValue] = useState(() => {
    try {
      const stored = store()?.getItem(key)
      if (stored != null) {
        const parsed = JSON.parse(stored)
        return opts.sanitize ? opts.sanitize(parsed) : parsed
      }
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
