// SignupPopup — anonymous-only modal that explains the tier system
// and what each level unlocks. Shows once per session, dismissible.
//
// Strategy: lead with "what you're missing" (anonymous gets very
// little), then show the four-tier ladder side-by-side so the visitor
// can pick their own starting point. CTAs route to:
//   • /login?tab=signup   for Free signup
//   • /pricing            for paid tier comparison & checkout

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const TIERS = [
  {
    name: 'Anonymous',
    sub: "What you're seeing now",
    price: null,
    tone: 'gray',
    perks: [
      'Stats + leaderboards',
      'Scoreboard + standings',
      'About + Subscriptions pages',
    ],
    cap: 'Locked: recruiting tools, games, articles, graphics, advanced scouting, coaching tools.',
  },
  {
    name: 'Free',
    sub: 'Make an account',
    price: '$0',
    tone: 'teal',
    perks: [
      'Everything in Anonymous',
      'PNW Grid + Team Quiz',
      'Recruiting tools (guides, map, hometown search)',
      'Draft Board + JUCO Tracker',
      'Custom graphics + matchup breakdowns',
    ],
  },
  {
    name: 'Premium',
    sub: 'Best for fans',
    price: '$5/mo',
    tone: 'amber',
    badge: 'Most popular',
    perks: [
      'Everything in Free',
      'Premium articles (full season recap, scouting reads)',
      'Advanced player scouting reports',
      '7-day free trial',
    ],
  },
  {
    name: 'Coach & Scout',
    sub: 'For programs',
    price: '$25/mo',
    tone: 'indigo',
    perks: [
      'Everything in Premium',
      'Full Coaching Portal (lineups, bullpen, trends)',
      'Printable scouting PDFs + catcher cards',
      'NW Coaching Simulator',
      'Custom tools on request',
    ],
  },
]


const TONE_CLASSES = {
  gray: {
    card: 'border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900/40',
    pill: 'text-gray-600 bg-gray-200 dark:text-gray-300 dark:bg-gray-700',
    accent: 'text-gray-500 dark:text-gray-400',
  },
  teal: {
    card: 'border-nw-teal/40 bg-nw-teal/5 dark:bg-nw-teal/10',
    pill: 'text-nw-teal bg-nw-teal/15',
    accent: 'text-nw-teal',
  },
  amber: {
    card: 'border-amber-400 bg-amber-50 dark:bg-amber-900/20 ring-2 ring-amber-300/60',
    pill: 'text-amber-800 bg-amber-200 dark:text-amber-200 dark:bg-amber-900/40',
    accent: 'text-amber-700 dark:text-amber-300',
  },
  indigo: {
    card: 'border-indigo-400/60 bg-indigo-50 dark:bg-indigo-900/20',
    pill: 'text-indigo-700 bg-indigo-100 dark:text-indigo-300 dark:bg-indigo-900/40',
    accent: 'text-indigo-700 dark:text-indigo-300',
  },
}


export default function SignupPopup() {
  const { user } = useAuth()
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem('signup-popup-dismissed') === '1' } catch { return false }
  })

  // Hide for signed-in users (real or simulated-as-free via preview)
  // and once dismissed for the session.
  if (user || dismissed) return null

  const dismiss = () => {
    setDismissed(true)
    try { sessionStorage.setItem('signup-popup-dismissed', '1') } catch {}
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
      <div
        className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-2xl
                   w-full max-w-3xl my-4 animate-fade-in"
        role="dialog"
        aria-labelledby="signup-popup-title"
      >
        {/* Close */}
        <button
          onClick={dismiss}
          aria-label="Close"
          className="absolute top-3 right-3 p-1.5 rounded-full
                     hover:bg-gray-100 dark:hover:bg-gray-700
                     text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-200
                     transition-colors z-10"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="p-5 sm:p-7">
          {/* Header */}
          <div className="text-center mb-4">
            <div className="inline-flex items-center justify-center w-11 h-11 rounded-full
                            bg-nw-teal/10 mb-2">
              <svg className="w-6 h-6 text-nw-teal" fill="none" stroke="currentColor"
                   strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round"
                      d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <h2 id="signup-popup-title"
                className="text-xl sm:text-2xl font-extrabold text-pnw-slate dark:text-gray-100 mb-1">
              You're seeing the anonymous view
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xl mx-auto">
              Most of NW Baseball Stats unlocks with a free account. The good stuff (scouting, advanced metrics, the coaching portal) lives in our paid tiers.
            </p>
          </div>

          {/* Tier grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 mb-5">
            {TIERS.map((t) => {
              const tone = TONE_CLASSES[t.tone]
              return (
                <div
                  key={t.name}
                  className={`relative rounded-lg border ${tone.card} p-3 flex flex-col`}
                >
                  {t.badge && (
                    <span className={`absolute -top-2 left-1/2 -translate-x-1/2
                                      text-[9px] font-bold uppercase tracking-wider
                                      px-2 py-0.5 rounded-full ${tone.pill}`}>
                      {t.badge}
                    </span>
                  )}
                  <div className="mb-2">
                    <p className={`text-[10px] font-bold uppercase tracking-wider ${tone.accent}`}>
                      {t.sub}
                    </p>
                    <p className="text-sm font-extrabold text-gray-900 dark:text-gray-100">
                      {t.name}
                    </p>
                    {t.price && (
                      <p className="text-xs font-bold text-gray-700 dark:text-gray-300 mt-0.5">
                        {t.price}
                      </p>
                    )}
                  </div>
                  <ul className="space-y-1 mb-2 flex-1">
                    {t.perks.map((p, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-[11px] text-gray-700 dark:text-gray-300 leading-snug">
                        <svg className={`w-3 h-3 mt-0.5 shrink-0 ${tone.accent}`}
                             fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                  {t.cap && (
                    <p className="text-[10px] text-rose-700 dark:text-rose-300 italic leading-snug mt-1 pt-2 border-t border-gray-200 dark:border-gray-700">
                      {t.cap}
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
            <Link
              to="/login?tab=signup"
              onClick={dismiss}
              className="flex-1 px-4 py-2.5 bg-nw-teal hover:bg-nw-teal-dark text-white
                         text-sm font-bold rounded-lg transition-colors text-center"
            >
              Sign Up Free
            </Link>
            <Link
              to="/pricing"
              onClick={dismiss}
              className="flex-1 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 text-white
                         text-sm font-bold rounded-lg transition-colors text-center"
            >
              Compare Subscriptions →
            </Link>
            <Link
              to="/login"
              onClick={dismiss}
              className="px-4 py-2.5 border border-gray-300 dark:border-gray-600
                         text-gray-700 dark:text-gray-300 text-sm font-medium
                         rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700
                         transition-colors text-center"
            >
              Log in
            </Link>
          </div>

          <p className="text-[10px] text-gray-400 dark:text-gray-500 text-center mt-3">
            Stats, leaderboards, and scores are always free without an account.
          </p>
        </div>
      </div>
    </div>
  )
}
