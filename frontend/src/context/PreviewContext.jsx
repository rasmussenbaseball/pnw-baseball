// PreviewContext — author-only "view as tier" override.
//
// Lets the site owner (nate.rasmussen26@gmail.com) browse the site
// AS IF they were an anonymous / free / premium / coach user, so they
// can catch bugs in tier-gated UI without juggling test accounts.
//
// How it works (frontend-only, no backend changes):
//   • Stores `previewTier` in localStorage under PREVIEW_KEY.
//   • AuthContext, when it sees previewTier === 'anonymous' AND the
//     real user is the author, exposes user=null/session=null to
//     consumers (so the site renders as signed-out).
//   • useTier(), when it sees a previewTier AND the real user is the
//     author, returns that tier instead of the actual subscription.
//   • RequireTier, when a preview is active, forces hard-gating
//     behavior (so /pricing-gated routes are blocked just like a real
//     user without that tier would experience).
//
// Caveats:
//   • Backend API responses still come back with the author's real
//     auth, so any data that's tier-trimmed server-side (paywalled
//     article bodies) will still arrive full. Frontend gates cover
//     most of the bug-discovery surface, which is the goal here.
//   • Preview state auto-clears when the author signs out, so nobody
//     ever sees the toggle on a non-author account.
//
// PreviewProvider must wrap AuthProvider in App.jsx (AuthContext
// reads the preview state).

import { createContext, useCallback, useContext, useEffect, useState } from 'react'

const PREVIEW_KEY = 'nwbb-preview-tier'

// Whose home page shows the preview widget. Re-exports the dev
// allowlist from lib/tiers.js so adding a new developer there
// automatically gives them the bug-hunt toggle too. The export is
// kept under the AUTHOR_EMAILS name for backwards-compat with any
// existing imports.
import { DEVELOPER_EMAILS } from '../lib/tiers'
export const AUTHOR_EMAILS = DEVELOPER_EMAILS

// Allowed preview values. null = no preview, render normally.
const VALID = new Set(['anonymous', 'free', 'premium', 'coach'])

const PreviewContext = createContext({
  previewTier: null,
  setPreviewTier: () => {},
  exitPreview: () => {},
})

function readStored() {
  try {
    const v = localStorage.getItem(PREVIEW_KEY)
    return VALID.has(v) ? v : null
  } catch { return null }
}

export function PreviewProvider({ children }) {
  const [previewTier, setPreviewTierState] = useState(readStored)

  // Persist any change immediately so a page reload picks it back up.
  const setPreviewTier = useCallback((tier) => {
    if (tier && !VALID.has(tier)) {
      // eslint-disable-next-line no-console
      console.warn('[Preview] Invalid tier:', tier)
      return
    }
    try {
      if (tier) localStorage.setItem(PREVIEW_KEY, tier)
      else localStorage.removeItem(PREVIEW_KEY)
    } catch {}
    setPreviewTierState(tier || null)
  }, [])

  const exitPreview = useCallback(() => setPreviewTier(null), [setPreviewTier])

  // Cross-tab sync: if I open another tab and toggle, the existing
  // tab should follow along.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== PREVIEW_KEY) return
      setPreviewTierState(VALID.has(e.newValue) ? e.newValue : null)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return (
    <PreviewContext.Provider value={{ previewTier, setPreviewTier, exitPreview }}>
      {children}
    </PreviewContext.Provider>
  )
}

export const usePreview = () => useContext(PreviewContext)
