// UpgradePromoWidget — conversion nudge for anonymous + free users on
// the homepage. Sells the next tier up:
//   • Anonymous → "Make an account" (free)  + "Compare plans" (paid)
//   • Free      → "Try Premium" (link to /pricing with $5/mo highlighted)
//
// Renders nothing for premium, coach, and dev users (they've already
// converted; the slot stays clean for them).

import { Link } from 'react-router-dom'
import { useTier } from '../hooks/useTier'

const ANON_PERKS = [
  'PNW Grid + Team Quiz',
  'Custom graphics + matchup breakdowns',
  'Team stats, percentiles, records',
  'NW Coaching Simulator + recruiting tools (Premium)',
]

const FREE_PERKS = [
  'NW Coaching Simulator (dynasty mode)',
  'All recruiting tools + Draft Board',
  'Premium articles + Commitments tracker',
  'Park Factors + advanced research',
  '7-day free trial',
]

export default function UpgradePromoWidget() {
  const { tier, loading } = useTier()
  if (loading) return null
  // Hide for everyone who has already passed the conversion line.
  if (tier !== 'none' && tier !== 'free') return null

  const isAnon = tier === 'none'

  return (
    <div
      className="rounded-xl overflow-hidden border border-amber-300 dark:border-amber-700/60
                 bg-gradient-to-br from-amber-50 via-white to-amber-50
                 dark:from-amber-900/30 dark:via-gray-800 dark:to-amber-900/20
                 shadow-sm"
    >
      <div className="px-4 sm:px-5 py-4 sm:py-5">
        {/* Header */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.15em]
                           text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40
                           px-2 py-0.5 rounded">
            {isAnon ? 'You\'re missing out' : 'Upgrade to Premium'}
          </span>
        </div>

        <h3 className="text-lg sm:text-xl font-extrabold text-pnw-slate dark:text-gray-100
                       mb-1 leading-tight">
          {isAnon
            ? 'Most of NW Baseball Stats is locked'
            : 'Unlock the rest of the site'}
        </h3>
        <p className="text-xs sm:text-sm text-gray-600 dark:text-gray-300 mb-3">
          {isAnon
            ? 'A free account unlocks games, graphics, advanced stats, and more. Paid tiers unlock the rest.'
            : 'Premium ($5/mo) opens up the Coaching Simulator, recruiting tools, draft board, premium articles, and Park Factors.'}
        </p>

        {/* Perks */}
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5 mb-4">
          {(isAnon ? ANON_PERKS : FREE_PERKS).map((p, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs sm:text-[13px]
                                   text-gray-700 dark:text-gray-200 leading-snug">
              <svg className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
                   fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <span>{p}</span>
            </li>
          ))}
        </ul>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row gap-2">
          {isAnon ? (
            <>
              <Link
                to="/login?tab=signup"
                className="flex-1 px-3 py-2 text-xs sm:text-sm font-bold uppercase
                           tracking-wider rounded text-center bg-nw-teal hover:bg-nw-teal-dark
                           text-white transition-colors"
              >
                Sign Up Free
              </Link>
              <Link
                to="/pricing"
                className="flex-1 px-3 py-2 text-xs sm:text-sm font-bold uppercase
                           tracking-wider rounded text-center bg-amber-500 hover:bg-amber-600
                           text-white transition-colors"
              >
                See Paid Plans →
              </Link>
            </>
          ) : (
            <>
              <Link
                to="/pricing"
                className="flex-1 px-3 py-2 text-xs sm:text-sm font-bold uppercase
                           tracking-wider rounded text-center bg-amber-500 hover:bg-amber-600
                           text-white transition-colors"
              >
                Start Premium · $5/mo
              </Link>
              <Link
                to="/pricing"
                className="flex-1 px-3 py-2 text-xs sm:text-sm font-bold uppercase
                           tracking-wider rounded text-center
                           border border-nw-teal text-nw-teal hover:bg-nw-teal hover:text-white
                           transition-colors"
              >
                Compare Plans
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
