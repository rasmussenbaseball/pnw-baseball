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
      'Stat Leaders, Hitting, Pitching, WAR',
      'Scoreboard, Standings, Team Pages, CPI',
      'National Rankings + Player Pages',
      '56-0 Draft game + player graphic cards',
      'Free articles, About, Request a Feature',
    ],
  },
  {
    slug: 'free',
    name: 'Free',
    tagline: 'Sign in for the full public site',
    monthlyPrice: null, yearlyPrice: null, yearlySaving: 0,
    highlights: [
      'Everything in Anonymous, plus:',
      "All games: PNW Grid, FieldGuessr, PNW Pickle, Team Quiz, WCL Pick 'Em",
      'Park Factors tool + Player Comparison',
      'Team Stats, Percentiles, Records, Summerball, Top Moments, Team History',
      'Matchup breakdowns + graphics generator',
      'Save favorites + opt into the newsletter',
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
      'NW Coaching Simulator (dynasty mode)',
      'Recruiting guides, map & hometown search',
      'Recruiting class rankings + MLB Draft Board',
      'Premium articles (full season recaps, scouting reads)',
    ],
  },
  {
    slug: 'recruiting',
    name: 'Recruiting',
    tagline: 'For college coaches & recruiters',
    monthlyPrice: 10, yearlyPrice: 100, yearlySaving: 20,
    highlights: [
      'Everything in Premium, plus:',
      'JUCO Tracker (NWAC transfer targets)',
      'Transfer Portal Tracker (4-year entrants)',
      'WCL Transfer Portal Tracker (summer ball)',
      'Commitments tracker',
      'Advanced hitter & pitcher discipline stats',
    ],
  },
  {
    slug: 'coach',
    name: 'Coach & Scout',
    tagline: 'For programs & professional scouts',
    monthlyPrice: 25, yearlyPrice: 250, yearlySaving: 50,
    highlights: [
      'Everything in Recruiting, plus:',
      'Full Coach & Scouting Portal',
      'Lineup Helper, Bullpen Sheets, Catcher Cards',
      'Team / Player / Opponent scouting reports',
      'Historic Matchups',
      'All printable PDFs (player cards, bulk exports)',
      'CSV data exports on every stat table',
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

// IMPORTANT: this table mirrors the gating in Header.jsx (requires:
// per item) + App.jsx route wraps. Anything that changes there has to
// be reflected here so the public-facing tier promises stay accurate.
const FEATURES = [
  { section: 'Browsing & stats' },
  { feat: 'Homepage, Scoreboard, Standings',  tiers: { none: true, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Stat Leaders + Hitting / Pitching / WAR leaderboards',
                                               tiers: { none: true, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Team pages + CPI + National Rankings',
                                               tiers: { none: true, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Player pages (full profile, splits, percentiles)',
                                               tiers: { none: true, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Team Stats + Team History',         tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Savant-style Percentiles page',     tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Summerball Data (WCL, PIL)',        tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Records + Top Moments',             tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },

  { section: 'Content' },
  { feat: 'Free articles',                     tiers: { none: true, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Premium articles (full body)',      tiers: { none: false, free: false, premium: true, recruiting: true, coach: true } },
  { feat: 'Newsletter + site announcements',   tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'About + Subscriptions + Feature Requests',
                                               tiers: { none: true, free: true, premium: true, recruiting: true, coach: true } },

  { section: 'Games & interactive tools' },
  { feat: '56-0 PNW Draft (build-the-best-roster game)',
                                               tiers: { none: true, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Player graphic cards (downloadable PNG)',
                                               tiers: { none: true, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'PNW Grid (daily puzzle)',           tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'FieldGuessr (guess the ballpark)',  tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'PNW Pickle (guess the player)',     tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Team Quiz',                         tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },
  { feat: "WCL Pick 'Em (weekly confidence pool)",
                                               tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Park Factors (park builder, batted-ball & pitch labs, regional map)',
                                               tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Player Comparison tool',            tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Matchup breakdowns',                tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Graphics generator (daily scores, leaderboards, recaps)',
                                               tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'All-Conference Generator + Playoff Projections',
                                               tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },
  { feat: 'Save favorite players & teams',     tiers: { none: false, free: true, premium: true, recruiting: true, coach: true } },

  { section: 'Premium ($5/mo)' },
  { feat: 'NW Coaching Simulator (dynasty mode)',
                                               tiers: { none: false, free: false, premium: true, recruiting: true, coach: true } },
  { feat: 'Recruiting Breakdown + Hometown Search',
                                               tiers: { none: false, free: false, premium: true, recruiting: true, coach: true } },
  { feat: 'Recruiting Guide + Map + Class rankings',
                                               tiers: { none: false, free: false, premium: true, recruiting: true, coach: true } },
  { feat: 'Commitments tracker',               tiers: { none: false, free: false, premium: false, recruiting: true, coach: true } },
  { feat: 'MLB Draft Board',                   tiers: { none: false, free: false, premium: true, recruiting: true, coach: true } },
  { feat: 'Recruiting Quiz + NWAC Advancement guide',
                                               tiers: { none: false, free: false, premium: true, recruiting: true, coach: true } },

  { section: 'Recruiting ($10/mo)' },
  { feat: 'JUCO Tracker (NWAC transfer targets)',
                                               tiers: { none: false, free: false, premium: false, recruiting: true, coach: true } },
  { feat: 'Transfer Portal Tracker (4-year entrants)',
                                               tiers: { none: false, free: false, premium: false, recruiting: true, coach: true } },
  { feat: 'WCL Transfer Portal Tracker (summer-ball portal, WCL stats)',
                                               tiers: { none: false, free: false, premium: false, recruiting: true, coach: true } },
  { feat: 'Advanced hitter & pitcher discipline stats',
                                               tiers: { none: false, free: false, premium: false, recruiting: true, coach: true } },

  { section: 'Coach & Scout Portal ($25/mo)' },
  { feat: 'Lineup Helper (vs RHP / LHP, bench)',
                                               tiers: { none: false, free: false, premium: false, recruiting: false, coach: true } },
  { feat: 'Opponent Trends + predicted lineups',
                                               tiers: { none: false, free: false, premium: false, recruiting: false, coach: true } },
  { feat: 'Team Scouting + Player Scouting reports',
                                               tiers: { none: false, free: false, premium: false, recruiting: false, coach: true } },
  { feat: 'Historic Matchups (per-PA vs opponent)',
                                               tiers: { none: false, free: false, premium: false, recruiting: false, coach: true } },
  { feat: 'Printable Scouting Sheets + Bullpen Sheets',
                                               tiers: { none: false, free: false, premium: false, recruiting: false, coach: true } },
  { feat: 'Catcher Cards (pocket pitch-calling cards)',
                                               tiers: { none: false, free: false, premium: false, recruiting: false, coach: true } },
  { feat: 'Player Card PDFs + Bulk export',    tiers: { none: false, free: false, premium: false, recruiting: false, coach: true } },
  { feat: 'NWAC Tournament scouting sheet',    tiers: { none: false, free: false, premium: false, recruiting: false, coach: true } },
  { feat: 'TrackMan integration',              tiers: { none: false, free: false, premium: false, recruiting: false, coach: true }, note: 'Coming soon' },
  { feat: 'Custom tools built on request',     tiers: { none: false, free: false, premium: false, recruiting: false, coach: true } },
]

const FAQ = [
  {
    q: "How does billing work?",
    a: "Card billed through Stripe on the same day each month (or each year for the annual plan). You can switch plans, update your card, or cancel anytime from your account page.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. Cancel or downgrade from your account page anytime. You keep full access through the end of the period you've already paid for. No annual commitment.",
  },
  {
    q: "Do you offer refunds?",
    a: "If something isn't working as advertised, email info@nwbaseballstats.com within 7 days of charge and we'll refund you. Past that, the cancel-anytime policy applies.",
  },
  {
    q: "What if I'm a coach at a current PNW program?",
    a: "Reach out. Discounted bulk seats are available for college programs. Email info@nwbaseballstats.com.",
  },
  {
    q: "Will free features ever be moved behind a paywall?",
    a: "No. The features currently free will stay free. New advanced features will roll out into the paid tiers.",
  },
  {
    q: "Where can I see what's coming next?",
    a: "Follow @RasmussenBase on X for site updates, or check the About page for what's already built. Subscribers get early access to new features as they ship.",
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
        else if (d.tier === 'recruiting') setCurrentTier('recruiting')
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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 mb-12">
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

      {/* ── Feature highlights showcase ── */}
      <FeatureHighlights />

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

  // Paid tiers (Premium / Coach): real Stripe checkout button. Free trials were
  // retired 2026-06-20, so every path bills immediately.
  return (
    <button
      onClick={onSubscribe}
      disabled={busy}
      className="block w-full text-center px-3 py-2 text-xs font-bold uppercase tracking-wider rounded
                 bg-nw-teal hover:bg-nw-teal-dark text-white transition-colors
                 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {busy ? 'Loading…' : `Subscribe ${interval === 'yearly' ? 'yearly' : 'monthly'}`}
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
  const tierKeys = ['none', 'free', 'premium', 'recruiting', 'coach']
  const tierLabels = { none: 'Anonymous', free: 'Free', premium: 'Premium', recruiting: 'Recruiting', coach: 'Coach & Scout' }

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
                  <td colSpan={6} className="px-4 py-2 text-[10px] font-bold uppercase tracking-[0.15em]
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

// ─── Feature highlights showcase ───────────────────────────────
//
// More selling than the comparison table — pull out the marquee
// features for Premium and Coach with paragraph descriptions. Sits
// between the tier cards and the full comparison table for shoppers
// who don't want to read a whole grid of checkmarks.

function FeatureHighlights() {
  const premiumFeatures = [
    {
      icon: '📰',
      title: 'Every paywalled article',
      desc: 'Long-form analysis, weekly recaps, recruiting profiles, and breakdowns that don\'t appear on social media.',
    },
    {
      icon: '🎯',
      title: 'Recruiting tools',
      desc: 'Class rankings, hometown / geo search, commitments tracker, and an aggregated draft board for every PNW conference.',
    },
    {
      icon: '🏟️',
      title: 'MLB Draft Board',
      desc: 'An aggregated draft board ranking the top PNW prospects across every conference, year by year, with the scouting context behind each name.',
    },
    {
      icon: '🎮',
      title: 'NW Coaching Simulator',
      desc: 'Build a dynasty as the head coach of any Pacific Northwest program (D1 through NWAC). Recruit, set lineups, and coach against a sim of the actual PNW season.',
    },
  ]

  const coachFeatures = [
    {
      icon: '📋',
      title: 'Printable scouting sheets',
      desc: 'Full hitter + pitcher rosters with conference percentiles, ready to print and bring to the dugout. Bullpen sheet, catcher cards, single-page player cards.',
    },
    {
      icon: '🔍',
      title: 'Advanced player & team scouting',
      desc: 'Pitch-level data, batted-ball type, spray charts, situational splits, leverage index. The same stuff MLB front offices look at, applied to PNW college baseball.',
    },
    {
      icon: '🎓',
      title: 'JUCO transfer tracker',
      desc: 'Every uncommitted NWAC player with stats, position, hand, and percentiles. Filter by class year, sort by WAR. The recruiting tool we built for ourselves.',
    },
    {
      icon: '🛠️',
      title: 'Custom tools on request',
      desc: 'Coach & Scout subscribers get to ask for the report or sheet you actually need. We build it. TrackMan integration coming soon.',
    },
  ]

  return (
    <div className="mb-12">
      {/* Premium feature highlights */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <Badge color="gold">Premium · $5/mo</Badge>
          <h2 className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            What you unlock with Premium
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {premiumFeatures.map((f, i) => (
            <FeatureCard key={i} {...f} accent="amber" />
          ))}
        </div>
      </div>

      {/* Coach & Scout feature highlights */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full
                           bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300">
            Coach & Scout · $25/mo
          </span>
          <h2 className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            For programs &amp; pro scouts
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {coachFeatures.map((f, i) => (
            <FeatureCard key={i} {...f} accent="indigo" />
          ))}
        </div>
      </div>
    </div>
  )
}

function FeatureCard({ icon, title, desc, accent }) {
  // Accent colors picked so the card chrome reads as "this is part
  // of the highlighted tier" without overpowering the description.
  const accentBg = accent === 'indigo'
    ? 'bg-indigo-50/40 dark:bg-indigo-900/10 border-indigo-100 dark:border-indigo-900/60'
    : 'bg-amber-50/40 dark:bg-amber-900/10 border-amber-100 dark:border-amber-900/60'
  return (
    <div className={`rounded-2xl border ${accentBg} p-4 sm:p-5`}>
      <div className="flex items-start gap-3">
        <div className="text-2xl shrink-0 leading-none">{icon}</div>
        <div className="min-w-0">
          <h3 className="text-sm sm:text-base font-extrabold text-gray-900 dark:text-gray-100 leading-tight">
            {title}
          </h3>
          <p className="text-[13px] sm:text-sm text-gray-700 dark:text-gray-300 leading-snug mt-1">
            {desc}
          </p>
        </div>
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
