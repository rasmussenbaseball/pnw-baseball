// Theme (light / dark / system) provider.
//
// Three values stored in localStorage under `theme`:
//   • 'light'  — always light
//   • 'dark'   — always dark
//   • 'system' — follow OS preference, react to changes
//
// On first paint, a no-flash bootstrap script in index.html reads the
// same localStorage key and toggles class="dark" on <html> BEFORE
// React mounts. This provider then takes over and keeps the class
// in sync whenever the user (or the OS, in 'system' mode) changes
// preference.
//
// Dark mode is OPT-IN per component via Tailwind's `dark:` variants
// (e.g. `bg-white dark:bg-gray-900`). Pages that haven't been touched
// yet will still render light when dark is active — that's expected
// during the gradual rollout.

import { createContext, useCallback, useContext, useEffect, useState } from 'react'

const STORAGE_KEY = 'theme'
const VALID = ['light', 'dark', 'system']

const ThemeContext = createContext({
  theme: 'system',          // user's stored choice (one of VALID)
  resolvedTheme: 'light',   // what's actually applied: 'light' | 'dark'
  setTheme: () => {},
})

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (VALID.includes(v)) return v
  } catch {}
  return 'system'
}

function systemPrefersDark() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function applyDarkClass(isDark) {
  const root = document.documentElement
  if (isDark) root.classList.add('dark')
  else root.classList.remove('dark')
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => readStored())
  const [resolvedTheme, setResolved] = useState(
    () => (readStored() === 'dark' ||
           (readStored() === 'system' && systemPrefersDark())) ? 'dark' : 'light'
  )

  // Apply class + recompute resolved theme whenever the choice changes.
  useEffect(() => {
    const isDark = theme === 'dark' || (theme === 'system' && systemPrefersDark())
    applyDarkClass(isDark)
    setResolved(isDark ? 'dark' : 'light')
  }, [theme])

  // When user picks 'system', listen for OS-level changes so the page
  // updates live if they flip their system between light and dark.
  useEffect(() => {
    if (theme !== 'system') return
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e) => {
      applyDarkClass(e.matches)
      setResolved(e.matches ? 'dark' : 'light')
    }
    // Use addEventListener where available; fall back for older Safari.
    if (mql.addEventListener) mql.addEventListener('change', onChange)
    else mql.addListener(onChange)
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange)
      else mql.removeListener(onChange)
    }
  }, [theme])

  const setTheme = useCallback((next) => {
    if (!VALID.includes(next)) return
    try { localStorage.setItem(STORAGE_KEY, next) } catch {}
    setThemeState(next)
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
