import { createContext, useContext, useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext({
  user: null,
  session: null,
  loading: true,
  // realUser: kept as an alias of `user` for older call sites.
  realUser: null,
  signUp: async () => {},
  signIn: async () => {},
  signOut: async () => {},
})

export function AuthProvider({ children }) {
  const [realUser, setRealUser] = useState(null)
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  const exposedUser    = realUser
  const exposedSession = session

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
      (event, s) => {
        setSession(s)
        setRealUser(s?.user ?? null)
        // A password-recovery email link lands on the homepage with a
        // recovery session; send the user straight to the set-a-new-password
        // form (window.location because this provider sits above the router).
        if (event === 'PASSWORD_RECOVERY' &&
            window.location.pathname !== '/reset-password') {
          window.location.assign('/reset-password')
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [])

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

  // Sends the Supabase recovery email. No redirectTo: the link opens the
  // site root, where the PASSWORD_RECOVERY event above routes to the form.
  const resetPassword = async (email) => {
    if (!supabase) throw new Error('Auth not configured')
    const { error } = await supabase.auth.resetPasswordForEmail(email)
    if (error) throw error
  }

  const updatePassword = async (password) => {
    if (!supabase) throw new Error('Auth not configured')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) throw error
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
        resetPassword,
        updatePassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
