import { useState } from 'react'
import { useAuth } from '../context/AuthContext'

const CATEGORIES = [
  { value: 'feature', label: 'Feature Request' },
  { value: 'bug', label: 'Bug Report' },
  { value: 'data', label: 'Data Issue' },
  { value: 'other', label: 'Other Feedback' },
]

export default function FeatureRequest() {
  const { user } = useAuth()
  const [category, setCategory] = useState('feature')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!message.trim()) return

    setSubmitting(true)
    setError(null)

    try {
      const resp = await fetch('/api/v1/feature-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user?.email || '',
          category,
          message: message.trim(),
        }),
      })

      if (!resp.ok) {
        const data = await resp.json()
        throw new Error(data.detail || 'Failed to submit')
      }

      setSubmitted(true)
      setMessage('')
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-pnw-slate mb-2">Request a Feature</h1>
      <p className="text-sm text-gray-500 mb-6">
        NW Baseball Stats is a work in progress and your feedback shapes what gets built next.
        Have an idea for a new feature, found a bug, or notice a data issue? Let us know below.
      </p>

      {submitted ? (
        <div className="bg-white rounded-xl shadow-sm border border-green-200 p-6 text-center">
          <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
            <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-pnw-slate mb-1">Thanks for the feedback!</h2>
          <p className="text-sm text-gray-500 mb-4">
            Your submission has been received. We review every request.
          </p>
          <button
            onClick={() => setSubmitted(false)}
            className="px-4 py-2 bg-pnw-teal text-white text-sm font-semibold rounded-lg hover:bg-pnw-teal/90 transition-colors"
          >
            Submit Another
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
          {/* Category selector */}
          <div className="mb-4">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
              What type of feedback?
            </label>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map(cat => (
                <button
                  key={cat.value}
                  type="button"
                  onClick={() => setCategory(cat.value)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    category === cat.value
                      ? 'bg-pnw-teal text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          {/* Message */}
          <div className="mb-4">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
              Your message
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
                category === 'feature' ? "Describe the feature you'd like to see..."
                : category === 'bug' ? "What happened? What did you expect to happen?"
                : category === 'data' ? "Which player, team, or stat looks wrong?"
                : "What's on your mind?"
              }
              rows={5}
              maxLength={2000}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-pnw-teal/30 focus:border-pnw-teal resize-y"
              required
            />
            <div className="text-right text-[10px] text-gray-400 mt-1">
              {message.length}/2000
            </div>
          </div>

          {/* Logged-in email note */}
          {user?.email && (
            <p className="text-xs text-gray-400 mb-4">
              Submitting as <span className="font-medium text-gray-600">{user.email}</span>
            </p>
          )}

          {error && (
            <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-4">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !message.trim()}
            className="w-full px-4 py-2.5 bg-pnw-teal text-white text-sm font-semibold rounded-lg hover:bg-pnw-teal/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Submitting...' : 'Submit Feedback'}
          </button>
        </form>
      )}

      {/* Social links */}
      <div className="mt-6 bg-white rounded-xl shadow-sm border border-gray-200 p-5">
        <h3 className="text-sm font-bold text-pnw-slate mb-2">Other ways to reach us</h3>
        <p className="text-xs text-gray-500 mb-3">
          Want to chat directly or follow along with development?
        </p>
        <div className="flex gap-3">
          <a
            href="https://x.com/NWBBStats"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 hover:border-pnw-teal hover:bg-pnw-teal/5 transition-colors text-sm text-gray-700"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            @NWBBStats
          </a>
          <a
            href="https://instagram.com/nwbbstats"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 hover:border-pnw-teal hover:bg-pnw-teal/5 transition-colors text-sm text-gray-700"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>
            @nwbbstats
          </a>
        </div>
      </div>
    </div>
  )
}
