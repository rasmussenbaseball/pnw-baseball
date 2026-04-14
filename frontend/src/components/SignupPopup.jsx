import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function SignupPopup() {
  const { user } = useAuth()
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem('signup-popup-dismissed') === '1' } catch { return false }
  })

  // Don't show if user is logged in or already dismissed this session
  if (user || dismissed) return null

  const dismiss = () => {
    setDismissed(true)
    try { sessionStorage.setItem('signup-popup-dismissed', '1') } catch {}
  }

  const features = [
    { title: 'Recruiting Tools', desc: 'Recruiting guides, rankings, maps, and hometown search' },
    { title: 'Draft Board', desc: 'Track draft-eligible players across all PNW divisions' },
    { title: 'Custom Graphics', desc: 'Leaderboard graphics, scatter plots, daily scores, and more' },
    { title: 'PNW Grid', desc: 'The daily baseball guessing game for PNW fans' },
    { title: 'JUCO Tracker', desc: 'Follow JUCO transfers and commitments' },
    { title: 'Matchup Breakdowns', desc: 'Head-to-head team comparisons with advanced stats' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 sm:p-8 animate-fade-in">
        {/* Close button */}
        <button
          onClick={dismiss}
          className="absolute top-3 right-3 p-1.5 rounded-full hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Header */}
        <div className="text-center mb-5">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-pnw-green/10 rounded-full mb-3">
            <svg className="w-6 h-6 text-pnw-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-pnw-slate">Create Your Free Account</h2>
          <p className="text-sm text-gray-500 mt-1">
            Unlock everything NW Baseball Stats has to offer, for free.
          </p>
        </div>

        {/* Feature list */}
        <div className="space-y-2.5 mb-6">
          {features.map((f, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="flex-none mt-0.5">
                <svg className="w-4 h-4 text-pnw-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-800">{f.title}</p>
                <p className="text-xs text-gray-500">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* CTA buttons */}
        <div className="space-y-2.5">
          <Link
            to="/login?tab=signup"
            onClick={dismiss}
            className="block w-full px-4 py-2.5 bg-pnw-green text-white text-sm font-semibold rounded-lg hover:bg-pnw-forest transition-colors text-center"
          >
            Sign Up Free
          </Link>
          <Link
            to="/login"
            onClick={dismiss}
            className="block w-full px-4 py-2.5 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors text-center"
          >
            Already have an account? Log in
          </Link>
        </div>

        {/* Footer note */}
        <p className="text-[10px] text-gray-400 text-center mt-4">
          Stats, leaderboards, and scores are available without an account.
        </p>
      </div>
    </div>
  )
}
