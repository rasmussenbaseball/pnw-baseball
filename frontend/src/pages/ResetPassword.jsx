// Landing page for Supabase password-recovery links. The email link opens
// the site with a recovery session; AuthContext routes here on the
// PASSWORD_RECOVERY event, and this form saves the new password.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function ResetPassword() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const { user, updatePassword } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setLoading(true)
    try {
      await updatePassword(password)
      setDone(true)
      setTimeout(() => navigate('/'), 1800)
    } catch (err) {
      setError(err.message || 'Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-md mx-auto mt-12">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-8">
        <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1 text-center">
          Set a New Password
        </h1>
        <p className="text-sm text-gray-400 dark:text-gray-500 text-center mb-6">
          {user ? `for ${user.email}` : ''}
        </p>

        {!user && (
          <div className="mb-4 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 text-sm">
            This reset link is expired or invalid. Go to the{' '}
            <button onClick={() => navigate('/login')} className="font-semibold underline">log in page</button>
            {' '}and use "Forgot password?" to request a fresh one.
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
            {error}
          </div>
        )}

        {done ? (
          <div className="p-3 rounded-lg bg-teal-50 dark:bg-teal-900/30 border border-teal-200 dark:border-teal-800 text-teal-700 dark:text-teal-300 text-sm">
            Password updated. Taking you to the site...
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">New Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600
                           bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-nw-teal/30 focus:border-nw-teal"
                placeholder="At least 6 characters"
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Confirm New Password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600
                           bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-nw-teal/30 focus:border-nw-teal"
                autoComplete="new-password"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !user}
              className="w-full bg-nw-teal text-white font-semibold py-2.5 rounded-lg
                         hover:bg-nw-teal/90 transition-colors disabled:opacity-50"
            >
              {loading ? 'Saving...' : 'Save New Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
