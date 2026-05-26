import { createContext, useContext, useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { usePreview, AUTHOR_EMAILS } from './PreviewContext'

const AuthContext = createContext({
  user: null,
  session: null,
  loading: true,
  // realUser: the underlying Supabase user, ignoring any preview override.
  // Components like the preview widget / banner / "exit preview" button
  // need this so they can identify the author even while previewing as
  // anonymous. Everything else should keep reading `user`.
  realUser: null,
  signUp: async () => {},
  signIn: async () => {},
  signOut: async () => {},
})

export function AuthProvider({ children }) {
  const [realUser, setRealUser] = useState(null)
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  // Preview override (only applies when the author is signed in).
  // When previewTier === 'anonymous', we expose user=null/session=null
  // so the rest of the site renders the signed-out experience.
  const { previewTier, exitPreview } = usePreview()
  const isAuthor = !!realUser?.email && AUTHOR_EMAILS.includes(realUser.email)
  const anonymousOverride = isAuthor && previewTier === 'anonymous'
  const exposedUser    = anonymousOverride ? null : realUser
  const exposedSession = anonymousOverride ? null : session

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }

    // Get initial session
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s)
      setRealUser(s?.user ?? null)
      setLoading(false)
    })

    // Listen for auth changes (login, logout, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, s) => {
        setSession(s)
        setRealUser(s?.user ?? null)
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  // Sign-out always clears any active preview so the next account
  // never sees stale preview state.
  useEffect(() => {
    if (!realUser && previewTier) exitPreview()
  }, [realUser, previewTier, exitPreview])

  const signUp = async (email, password) => {
    if (!supabase) throw new Error('Auth not configured')
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) throw error
    return data
  }

  const signIn = async (email, password) => {
    if (!supabase) throw new Error('Auth not configured')
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
  }

  const signOut = async () => {
    if (!supabase) return
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider
      value={{
        user: exposedUser,
        session: exposedSession,
        loading,
        realUser,
        signUp,
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
