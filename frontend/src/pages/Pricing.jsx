// /pricing — tier comparison page.
//
// PURE MARKETING for now — no payment flow, no gating, no signup
// capture. Just a clear "here's what each tier gets you" surface so
// readers know what's coming. The Premium and Coach/Scout tiers are
// flagged "Coming Soon"; clicks point them at info@ for early access.
//
// Tiers (per Nate's spec, 2026-05-25):
//   • NONE          (anonymous) — basic public surfaces only
//   • FREE          (free account) — advanced metrics + newsletter
//   • PREMIUM $5/mo — everything except the Coach & Scout portal
//   • COACH/SCOUT $25/mo — full portal + everything Premium has
//
// The user's current tier is read from /me/subscription so the right
// card flips to "Current plan" with a teal outline. Anonymous users
// see NONE flagged.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const API_BASE = '/api/v1'

// ─── Tier metadata ──────────────────────────────────────────────
//
// One row of this drives both the card grid and the bullet lists. The
// comparison table below is a separate data structure (FEATURES) so we
// can group related features and check each one against the tier slug.

const TIERS = [
  {
    slug: 'none',
    name: 'Anonymous',
    tagline: 'Browse without an account',
    price: '$0',
    cadence: '',
    accent: 'gray',
    highlights: [
      'Homepage + scoreboards',
      'Stat leaders & leaderboards',
      'Team and player pages',
      'Free articles',
    ],
  },
  {
    slug: 'free',
    name: 'Free',
    tagline: 'Sign in for the full public site',
    price: '$0',
    cadence: 'forever',
    accent: 'teal',
    highlights: [
      'Everything in Anonymous, plus:',
      'Advanced player metrics (WAR, savant)',
      'Save favorites & opt into the newsletter',
      'Some premium content',
    ],
  },
  {
    slug: 'premium',
    name: 'Premium',
    tagline: 'For die-hard fans + analysts',
    price: '$5',
    cadence: '/ month',
    accent: 'gold',
    badge: 'Most popular',
    comingSoon: true,
    highlights: [
      'Everything in Free, plus:',
      'All paywalled articles',
      'Recruiting tools, draft board, JUCO tracker',
      'Park factors, hometown search, advanced research',
      'The coaching simulator (NAIA GM)',
    ],
  },
  {
    slug: 'coach',
    name: 'Coach & Scout',
    tagline: 'For programs & professional scouts',
    price: '$25',
    cadence: '/ month',
    accent: 'indigo',
    comingSoon: true,
    highlights: [
      'Everything in Premium, plus:',
      'Full Coach & Scout portal',
      'NWAC tournament sheet + bullpen / lineup helpers',
      'Player card PDFs, catcher cards, bulk exports',
      'All-conference generator, opponent trends',
    ],
  },
]

// ─── Feature comparison table ───────────────────────────────────
//
// Each row: { feat, tiers: { none, free, premium, coach } }
// A `true` value renders a checkmark in that column. Anything else is a
// dash. Grouped by section heading.

const FEATURES = [
  { section: 'Stats & data' },
  { feat: 'Stat leaders & leaderboards',  tiers: { none: true, free: true, premium: true, coach: true } },
  { feat: 'Player pages (basic)',          tiers: { none: true, free: true, premium: true, coach: true } },
  { feat: 'Team pages & team stats',       tiers: { none: true, free: true, premium: true, coach: true } },
  { feat: 'Scoreboard + standings',        tiers: { none: true, free: true, premium: true, coach: true } },
  { feat: 'Advanced player metrics (WAR, percentiles, savant)',
                                            tiers: { none: false, free: true, premium: true, coach: true } },

  { section: 'Content' },
  { feat: 'Free articles',                  tiers: { none: true, free: true, premium: true, coach: true } },
  { feat: 'Premium articles',               tiers: { none: false, free: false, premium: true, coach: true } },
  { feat: 'Newsletter & site announcements', tiers: { none: false, free: true, premium: true, coach: true } },

  { section: 'Research & tools' },
  { feat: 'Save favorite players & teams',  tiers: { none: false, free: true, premium: true, coach: true } },
  { feat: 'Commitments tracker',            tiers: { none: false, free: false, premium: true, coach: true } },
  { feat: 'Recruiting class rankings',      tiers: { none: false, free: false, premium: true, coach: true } },
  { feat: 'Hometown & geo search',          tiers: { none: false, free: false, premium: true, coach: true } },
  { feat: 'Draft board',                    tiers: { none: false, free: false, premium: true, coach: true } },
  { feat: 'Park factors',                   tiers: { none: false, free: false, premium: true, coach: true } },
  { feat: 'JUCO tracker',                   tiers: { none: false, free: false, premium: true, coach: true } },
  { feat: 'Historic matchups',              tiers: { none: false, free: false, premium: true, coach: true } },
  { feat: 'NAIA Coaching Simulator (GM)',   tiers: { none: false, free: false, premium: true, coach: true } },

  { section: 'Coach & Scout portal' },
  { feat: 'NWAC tournament scouting sheet', tiers: { none: false, free: false, premium: false, coach: true } },
  { feat: 'Bullpen / pitcher scouting',     tiers: { none: false, free: false, premium: false, coach: true } },
  { feat: 'Lineup helper',                  tiers: { none: false, free: false, premium: false, coach: true } },
  { feat: 'Player card PDFs',               tiers: { none: false, free: false, premium: false, coach: true } },
  { feat: 'Catcher cards',                  tiers: { none: false, free: false, premium: false, coach: true } },
  { feat: 'Bulk player card export',        tiers: { none: false, free: false, premium: false, coach: true } },
  { feat: 'All-conference generator',       tiers: { none: false, free: false, premium: false, coach: true } },
  { feat: 'Opponent trends',                tiers: { none: false, free: false, premium: false, coach: true } },
]

const FAQ = [
  {
    q: "When does Premium launch?",
    a: "Soon — we're finalizing the payment flow. Email info@nwbaseballstats.com if you want an early-access seat.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. Once Premium and Coach/Scout launch, you'll be able to cancel or downgrade from your account page. No annual commitment.",
  },
  {
    q: "What if I'm a coach at a current PNW program?",
    a: "Reach out — discounted bulk seats are available for college programs. Email info@nwbaseballstats.com.",
  },
  {
    q: "Will free features ever be moved behind a paywall?",
    a: "No. The features currently free will stay free. New advanced features will roll out into the paid tiers.",
  },
]

// ─── Component ──────────────────────────────────────────────────

function authHeaders(session) {
  if (!session?.access_token) return {}
  return { Authorization: `Bearer ${session.access_token}` }
}

export default function Pricing() {
  const { user, session } = useAuth()
  // 'none' for anonymous; '/me/subscription' returns 'free' | 'paid' for
  // logged-in users. The tier slug we use locally is one of
  // 'none' | 'free' | 'premium' | 'coach' — we coerce the backend's
  // simple 'paid' into 'premium' until the backend distinguishes.
  const [currentTier, setCurrentTier] = useState(user ? 'free' : 'none')

  useEffect(() => {
    if (!user || !session) { setCurrentTier('none'); return }
    let alive = true
    fetch(`${API_BASE}/me/subscription`, { headers: authHeaders(session) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => {
        if (!alive) return
        if (d.tier === 'paid') setCurrentTier('premium')
        else setCurrentTier('free')
      })
      .catch(() => { if (alive) setCurrentTier('free') })
    return () => { alive = false }
  }, [user, session])

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 sm:py-12">
      {/* ── Header ── */}
      <div className="text-center mb-10">
        <div className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-nw-teal mb-2">
          Subscription
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-gray-900 dark:text-gray-100 leading-tight">
          Pick the access that fits how you watch
        </h1>
        <p className="text-sm sm:text-base text-gray-500 dark:text-gray-400 mt-3 max-w-2xl mx-auto">
          NW Baseball Stats is free for fans. Paid tiers unlock recruiting tools, premium analysis,
          and the full Coach &amp; Scout portal used by college programs.
        </p>
      </div>

      {/* ── Tier cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-12">
        {TIERS.map(tier => (
          <TierCard key={tier.slug} tier={tier} isCurrent={tier.slug === currentTier} user={user} />
        ))}
      </div>

      {/* ── Full comparison table ── */}
      <div className="mb-12">
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-2 px-1">
          Full feature comparison
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3 px-1">
          Everything every tier includes. Hover a checkmark in the table for the tier name.
        </p>
        <ComparisonTable currentTier={currentTier} />
      </div>

      {/* ── FAQ ── */}
      <div className="mb-12">
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-3 px-1">FAQ</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {FAQ.map((f, i) => (
            <div key={i} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                                    rounded-lg p-4">
              <div className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-1">{f.q}</div>
              <div className="text-[13px] text-gray-600 dark:text-gray-400 leading-snug">{f.a}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Footer CTA ── */}
      <div className="text-center bg-gradient-to-br from-nw-teal/10 to-nw-teal/5
                      dark:from-nw-teal/20 dark:to-nw-teal/10 rounded-2xl p-6 sm:p-8 border
                      border-nw-teal/20">
        <h3 className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100 mb-1">
          Questions or interested in early access?
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          We're rolling out the paid tiers carefully. Tell us how you'd use Premium or Coach &amp; Scout
          and we'll get back to you.
        </p>
        <a
          href="mailto:info@nwbaseballstats.com?subject=Subscription%20interest"
          className="inline-block px-5 py-2.5 bg-nw-teal hover:bg-nw-teal-dark text-white
                     font-bold uppercase tracking-wider text-sm rounded transition-colors"
        >
          Email info@nwbaseballstats.com
        </a>
      </div>
    </div>
  )
}


// ─── Tier card ──────────────────────────────────────────────────

function TierCard({ tier, isCurrent, user }) {
  const ring = isCurrent
    ? 'border-nw-teal ring-2 ring-nw-teal/30'
    : 'border-gray-200 dark:border-gray-700'
  const badge = isCurrent
    ? <Badge color="teal">Current plan</Badge>
    : tier.badge
    ? <Badge color="gold">{tier.badge}</Badge>
    : tier.comingSoon
    ? <Badge color="gray">Coming soon</Badge>
    : null

  return (
    <div className={`relative bg-white dark:bg-gray-800 rounded-2xl border ${ring} p-5 flex flex-col`}>
      {/* Badge floats top-right */}
      {badge && <div className="absolute -top-2.5 right-4">{badge}</div>}

      {/* Tier name + price */}
      <div className="mb-3">
        <div className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400">
          {tier.name}
        </div>
        <div className="flex items-baseline gap-1 mt-1">
          <span className="text-3xl font-extrabold text-gray-900 dark:text-gray-100">{tier.price}</span>
          {tier.cadence && (
            <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">{tier.cadence}</span>
          )}
        </div>
        <p className="text-[12px] text-gray-600 dark:text-gray-400 mt-1 leading-snug">{tier.tagline}</p>
      </div>

      {/* Highlights */}
      <ul className="space-y-1.5 mb-4 flex-1">
        {tier.highlights.map((h, i) => (
          <li key={i} className="flex items-start gap-1.5 text-[13px] text-gray-700 dark:text-gray-300 leading-snug">
            <svg className="w-3.5 h-3.5 mt-0.5 shrink-0 text-nw-teal" fill="none"
                 stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span>{h}</span>
          </li>
        ))}
      </ul>

      {/* CTA */}
      <TierCTA tier={tier} isCurrent={isCurrent} user={user} />
    </div>
  )
}

function TierCTA({ tier, isCurrent, user }) {
  if (isCurrent) {
    return (
      <button
        disabled
        className="w-full px-3 py-2 text-xs font-bold uppercase tracking-wider rounded
                   border border-nw-teal text-nw-teal bg-nw-teal/5 cursor-default"
      >
        Your current plan
      </button>
    )
  }
  // Anonymous → can sign up free
  if (tier.slug === 'free' && !user) {
    return (
      <Link
        to="/login"
        className="block w-full text-center px-3 py-2 text-xs font-bold uppercase tracking-wider rounded
                   bg-nw-teal hover:bg-nw-teal-dark text-white transition-colors"
      >
        Sign up free
      </Link>
    )
  }
  // Anonymous, no sign up needed for None tier
  if (tier.slug === 'none') {
    return (
      <div className="w-full text-center px-3 py-2 text-xs font-bold uppercase tracking-wider rounded
                      border border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500">
        No sign-up needed
      </div>
    )
  }
  // Paid tiers — Coming Soon, email for early access
  if (tier.comingSoon) {
    return (
      <a
        href={`mailto:info@nwbaseballstats.com?subject=${encodeURIComponent(tier.name + ' early access')}`}
        className="block w-full text-center px-3 py-2 text-xs font-bold uppercase tracking-wider rounded
                   border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200
                   hover:border-nw-teal hover:text-nw-teal transition-colors"
      >
        Request early access
      </a>
    )
  }
  return null
}


// ─── Badge ──────────────────────────────────────────────────────

function Badge({ color, children }) {
  const styles = {
    teal: 'bg-nw-teal text-white',
    gold: 'bg-amber-400 text-amber-950',
    gray: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  }[color] || 'bg-gray-200 text-gray-700'
  return (
    <span className={`inline-block text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full ${styles}`}>
      {children}
    </span>
  )
}


// ─── Comparison table ───────────────────────────────────────────

function ComparisonTable({ currentTier }) {
  const tierKeys = ['none', 'free', 'premium', 'coach']
  const tierLabels = { none: 'Anonymous', free: 'Free', premium: 'Premium', coach: 'Coach & Scout' }

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                    rounded-2xl overflow-hidden shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700">
            <tr>
              <th className="text-left px-4 py-3 font-bold text-gray-700 dark:text-gray-300">Feature</th>
              {tierKeys.map(k => (
                <th key={k} className={`text-center px-3 py-3 text-[11px] font-extrabold uppercase
                                        tracking-wider ${
                  currentTier === k
                    ? 'text-nw-teal'
                    : 'text-gray-600 dark:text-gray-400'
                }`}>
                  {tierLabels[k]}
                  {currentTier === k && (
                    <div className="text-[9px] font-bold normal-case tracking-normal text-nw-teal mt-0.5">
                      ← you
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FEATURES.map((row, i) => (
              row.section ? (
                <tr key={`s-${i}`} className="bg-gray-50/60 dark:bg-gray-900/40 border-t border-gray-200 dark:border-gray-700">
                  <td colSpan={5} className="px-4 py-2 text-[10px] font-bold uppercase tracking-[0.15em]
                                              text-gray-500 dark:text-gray-400">
                    {row.section}
                  </td>
                </tr>
              ) : (
                <tr key={`f-${i}`} className="border-t border-gray-100 dark:border-gray-700/50">
                  <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300 text-[13px]">{row.feat}</td>
                  {tierKeys.map(k => (
                    <td key={k} className="text-center px-3 py-2.5">
                      <Check value={row.tiers[k]} title={tierLabels[k]} />
                    </td>
                  ))}
                </tr>
              )
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Check({ value, title }) {
  if (value) {
    return (
      <svg className="w-4 h-4 mx-auto text-emerald-600" fill="none" stroke="currentColor"
           strokeWidth="3" viewBox="0 0 24 24" aria-label={`included in ${title}`}>
        <title>included in {title}</title>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    )
  }
  return (
    <span className="text-gray-300 dark:text-gray-600" aria-label={`not in ${title}`}>—</span>
  )
}
