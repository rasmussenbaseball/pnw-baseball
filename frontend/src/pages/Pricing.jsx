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
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const API_BASE = '/api/v1'

function authHeaders(session) {
  if (!session?.access_token) return {}
  return { Authorization: `Bearer ${session.access_token}` }
}

// ─── Tier metadata ──────────────────────────────────────────────
//
// One row of this drives both the card grid and the bullet lists. The
// comparison table below is a separate data structure (FEATURES) so we
// can group related features and check each one against the tier slug.

// Tier definitions. The `monthlyPrice` / `yearlyPrice` / `yearlySaving`
// fields drive the price strip on each card. Anything with monthlyPrice=null
// is free (Anonymous / Free).
const TIERS = [
  {
    slug: 'none',
    name: 'Anonymous',
    tagline: 'Browse without an account',
    monthlyPrice: null, yearlyPrice: null, yearlySaving: 0,
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
    monthlyPrice: null, yearlyPrice: null, yearlySaving: 0,
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
    monthlyPrice: 5,  yearlyPrice: 50,  yearlySaving: 10,
    badge: 'Most popular',
    highlights: [
      'Everything in Free, plus:',
      'All paywalled articles',
      'Recruiting tools, draft board, hometown search',
      'Park factors & advanced research',
      'The coaching simulator',
    ],
  },
  {
    slug: 'coach',
    name: 'Coach & Scout',
    tagline: 'For programs & professional scouts',
    monthlyPrice: 25, yearlyPrice: 250, yearlySaving: 50,
    highlights: [
      'Everything in Premium, plus:',
      'Full Coach & Scout portal',
      'JUCO tracker + advanced player & team scouting',
      'All printables, PDFs, and scouting sheets',
      'TrackMan integration (coming soon)',
      'Custom tools built on request',
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
  { feat: 'Historic matchups',              tiers: { none: false, free: false, premium: true, coach: true } },
  { feat: 'Coaching simulator (GM)',         tiers: { none: false, free: false, premium: true, coach: true } },

  { section: 'Coach & Scout portal' },
  { feat: 'JUCO tracker',                              tiers: { none: false, free: false, premium: false, coach: true } },
  { feat: 'Advanced player & team scouting reports',   tiers: { none: false, free: false, premium: false, coach: true } },
  { feat: 'NWAC tournament scouting sheet',            tiers: { none: false, free: false, premium: false, coach: true } },
  { feat: 'Bullpen, lineup & opponent-trends tools',   tiers: { none: false, free: false, premium: false, coach: true } },
  { feat: 'All printables & PDF exports (player cards, catcher cards, bulk)',
                                                        tiers: { none: false, free: false, premium: false, coach: true } },
  { feat: 'All-conference generator',                  tiers: { none: false, free: false, premium: false, coach: true } },
  { feat: 'TrackMan integration',                      tiers: { none: false, free: false, premium: false, coach: true }, note: 'Coming soon' },
  { feat: 'Custom tools built on request',             tiers: { none: false, free: false, premium: false, coach: true } },
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

export default function Pricing() {
  const { user, session } = useAuth()
  const navigate = useNavigate()

  // 'none' for anonymous; '/me/subscription' returns 'free' | 'premium'
  // | 'coach' for logged-in users (with legacy 'paid' coerced to 'premium').
  const [currentTier, setCurrentTier] = useState(user ? 'free' : 'none')

  // Interval toggle: persists in localStorage so users come back to the
  // same view next time. Yearly is the default — the discount story is
  // the easier sell.
  const [interval, setInterval] = useState(() => {
    try { return localStorage.getItem('pricing_interval') || 'yearly' } catch { return 'yearly' }
  })
  useEffect(() => {
    try { localStorage.setItem('pricing_interval', interval) } catch {}
  }, [interval])

  // Checkout state
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!user || !session) { setCurrentTier('none'); return }
    let alive = true
    fetch(`${API_BASE}/me/subscription`, { headers: authHeaders(session) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => {
        if (!alive) return
        if (d.tier === 'premium') setCurrentTier('premium')
        else if (d.tier === 'coach') setCurrentTier('coach')
        else if (d.tier === 'paid') setCurrentTier('premium')  // legacy
        else setCurrentTier('free')
      })
      .catch(() => { if (alive) setCurrentTier('free') })
    return () => { alive = false }
  }, [user, session])

  // ─── Checkout → Stripe ────────────────────────────────────
  async function startCheckout(tier) {
    if (busy) return
    // Anonymous users need to sign in first; redirect to login with
    // a `next` parameter so they bounce back to /pricing afterward.
    if (!user || !session) {
      navigate(`/login?next=${encodeURIComponent('/pricing')}`)
      return
    }
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${API_BASE}/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(session) },
        body: JSON.stringify({ tier, interval }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.detail || `Checkout failed (${res.status})`)
      }
      const { url } = await res.json()
      if (!url) throw new Error('No checkout URL returned')
      window.location.href = url   // Stripe Checkout
    } catch (e) {
      setError(e.message || 'Could not start checkout')
      setBusy(false)
    }
  }

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

      {/* ── Billing interval toggle ── */}
      <div className="flex justify-center mb-6">
        <IntervalToggle value={interval} onChange={setInterval} />
      </div>

      {error && (
        <div className="max-w-md mx-auto mb-4 bg-rose-50 border border-rose-200 text-rose-700
                        text-sm px-3 py-2 rounded">
          {error}
        </div>
      )}

      {/* ── Tier cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-12">
        {TIERS.map(tier => (
          <TierCard
            key={tier.slug}
            tier={tier}
            interval={interval}
            isCurrent={tier.slug === currentTier}
            user={user}
            busy={busy}
            onSubscribe={() => startCheckout(tier.slug)}
          />
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

function TierCard({ tier, interval, isCurrent, user, busy, onSubscribe }) {
  const ring = isCurrent
    ? 'border-nw-teal ring-2 ring-nw-teal/30'
    : 'border-gray-200 dark:border-gray-700'
  const badge = isCurrent
    ? <Badge color="teal">Current plan</Badge>
    : tier.badge
    ? <Badge color="gold">{tier.badge}</Badge>
    : null

  // Pull the right price for the active billing interval. Free / Anonymous
  // tiers have monthlyPrice=null and render a "$0" line with no cadence.
  const isPaid = tier.monthlyPrice != null
  const amount = isPaid
    ? (interval === 'yearly' ? tier.yearlyPrice : tier.monthlyPrice)
    : 0
  const cadence = isPaid
    ? (interval === 'yearly' ? '/ year' : '/ month')
    : (tier.slug === 'free' ? 'forever' : '')

  return (
    <div className={`relative bg-white dark:bg-gray-800 rounded-2xl border ${ring} p-5 flex flex-col`}>
      {badge && <div className="absolute -top-2.5 right-4">{badge}</div>}

      {/* Tier name + price */}
      <div className="mb-3">
        <div className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400">
          {tier.name}
        </div>
        <div className="flex items-baseline gap-1 mt-1">
          <span className="text-3xl font-extrabold text-gray-900 dark:text-gray-100">
            ${amount}
          </span>
          {cadence && (
            <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">{cadence}</span>
          )}
        </div>
        {/* Yearly savings hint */}
        {isPaid && interval === 'yearly' && tier.yearlySaving > 0 && (
          <div className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400 mt-1">
            Save ${tier.yearlySaving} / year vs monthly
          </div>
        )}
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
      <TierCTA
        tier={tier} interval={interval} isCurrent={isCurrent}
        user={user} busy={busy} onSubscribe={onSubscribe}
      />
    </div>
  )
}

function TierCTA({ tier, interval, isCurrent, user, busy, onSubscribe }) {
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
  if (tier.slug === 'none') {
    return (
      <div className="w-full text-center px-3 py-2 text-xs font-bold uppercase tracking-wider rounded
                      border border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500">
        No sign-up needed
      </div>
    )
  }

  // Paid tiers (Premium / Coach): real Stripe checkout button.
  // Premium monthly gets a "7-day free trial" hint because that's the
  // only path that ships with a trial per spec.
  const trialHint = tier.slug === 'premium' && interval === 'monthly'
  return (
    <button
      onClick={onSubscribe}
      disabled={busy}
      className="block w-full text-center px-3 py-2 text-xs font-bold uppercase tracking-wider rounded
                 bg-nw-teal hover:bg-nw-teal-dark text-white transition-colors
                 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {busy
        ? 'Loading…'
        : trialHint
          ? 'Start 7-day free trial'
          : `Subscribe ${interval === 'yearly' ? 'yearly' : 'monthly'}`}
    </button>
  )
}


// ─── Monthly / Yearly toggle ───────────────────────────────────

function IntervalToggle({ value, onChange }) {
  const opts = [
    { v: 'monthly', label: 'Monthly' },
    { v: 'yearly',  label: 'Yearly · save up to $50' },
  ]
  return (
    <div className="inline-flex items-center gap-1 p-1 bg-white dark:bg-gray-800 border
                    border-gray-200 dark:border-gray-700 rounded-full shadow-sm">
      {opts.map(o => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          type="button"
          className={`px-4 py-1.5 text-xs font-bold uppercase tracking-wider rounded-full
                      transition-colors ${
            value === o.v
              ? 'bg-nw-teal text-white shadow'
              : 'text-gray-600 dark:text-gray-300 hover:text-nw-teal'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
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
          <thead className="bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
            <tr>
              <th className="text-left px-4 py-3 font-bold text-gray-700 dark:text-gray-200">Feature</th>
              {tierKeys.map(k => (
                <th key={k} className={`text-center px-3 py-3 text-[11px] font-extrabold uppercase
                                        tracking-wider ${
                  currentTier === k
                    ? 'text-nw-teal'
                    : 'text-gray-600 dark:text-gray-300'
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
                  <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300 text-[13px]">
                    {row.feat}
                    {row.note && (
                      <span className="ml-2 text-[10px] font-bold uppercase tracking-wider
                                       text-amber-700 bg-amber-100 dark:text-amber-300
                                       dark:bg-amber-900/40 px-1.5 py-0.5 rounded">
                        {row.note}
                      </span>
                    )}
                  </td>
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
