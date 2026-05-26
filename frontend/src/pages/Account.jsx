// /account — "My Account" landing page for logged-in users.
//
// Surfaces in one place:
//   • Account email
//   • Current subscription tier (Free, for now — paid tier ships later)
//   • Email-preferences toggles (the same 3 lists the popup uses)
//
// Saving the preferences goes through the existing /email-preferences/me
// PUT endpoint, so changes here suppress the popup automatically (it
// only shows when the user has no row, and saving here creates the row).

import { useEffect, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'

const API_BASE = '/api/v1'

function authHeaders(session) {
  if (!session?.access_token) return {}
  return { Authorization: `Bearer ${session.access_token}` }
}

export default function Account() {
  const { user, session, loading: authLoading } = useAuth()
  const { theme, resolvedTheme, setTheme } = useTheme()

  // ?upgraded=true is the redirect target from Stripe Checkout's
  // success_url. Show a one-time welcome banner and poll
  // /me/subscription briefly so the new tier appears even if the
  // webhook is mid-flight when the user lands.
  const [searchParams, setSearchParams] = useSearchParams()
  const justUpgraded = searchParams.get('upgraded') === 'true'
  const [bannerOpen, setBannerOpen] = useState(justUpgraded)

  // Email preferences state
  const [news, setNews] = useState(false)
  const [promos, setPromos] = useState(false)
  const [updates, setUpdates] = useState(false)
  const [prefsLoaded, setPrefsLoaded] = useState(false)

  // Subscription state
  const [tier, setTier] = useState(null)
  const [tierStartedAt, setTierStartedAt] = useState(null)
  const [subInfo, setSubInfo] = useState({
    interval: null,
    current_period_end: null,
    cancel_at_period_end: false,
  })

  // Save UI
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  // Load email prefs + subscription tier in parallel on mount.
  useEffect(() => {
    if (!session) return
    let alive = true

    fetch(`${API_BASE}/email-preferences/me`, { headers: authHeaders(session) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => {
        if (!alive) return
        const p = d.preferences
        if (p) {
          setNews(!!p.subscribed_news)
          setPromos(!!p.subscribed_promos)
          setUpdates(!!p.subscribed_updates)
        } else {
          // New users default ON — most people who reach this page are
          // here to opt in, not out. They can uncheck what they don't want.
          setNews(true); setPromos(true); setUpdates(true)
        }
        setPrefsLoaded(true)
      })
      .catch(() => { if (alive) setPrefsLoaded(true) })

    // Polling — when we just came back from Stripe checkout, the
    // subscription.created webhook can be a few seconds behind the
    // redirect. Poll /me/subscription every 2s for up to 20s, stopping
    // as soon as we see a paid tier appear.
    let attempts = 0
    const maxAttempts = justUpgraded ? 10 : 1
    let timer = null
    function fetchSub() {
      fetch(`${API_BASE}/me/subscription`, { headers: authHeaders(session) })
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(d => {
          if (!alive) return
          setTier(d.tier || 'free')
          setTierStartedAt(d.started_at || null)
          setSubInfo({
            interval: d.interval || null,
            current_period_end: d.current_period_end || null,
            cancel_at_period_end: !!d.cancel_at_period_end,
          })
          attempts += 1
          const isPaid = d.tier === 'premium' || d.tier === 'coach' || d.tier === 'paid'
          if (justUpgraded && !isPaid && attempts < maxAttempts) {
            timer = setTimeout(fetchSub, 2000)
          } else if (justUpgraded && isPaid) {
            // Tier confirmed — clean the URL so a future reload doesn't
            // re-trigger the success banner.
            setSearchParams({}, { replace: true })
          }
        })
        .catch(() => { if (alive) setTier('free') })
    }
    fetchSub()

    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [session, justUpgraded])

  if (authLoading) return <PageShell><div className="text-gray-500 animate-pulse">Loading…</div></PageShell>
  if (!user) return <Navigate to="/login" replace />

  async function save() {
    if (saving) return
    setSaving(true); setError(null); setSavedAt(null)
    try {
      const res = await fetch(`${API_BASE}/email-preferences/me`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(session) },
        body: JSON.stringify({
          subscribed_news: news,
          subscribed_promos: promos,
          subscribed_updates: updates,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSavedAt(Date.now())
    } catch (e) {
      setError(e.message || 'Could not save preferences')
    } finally {
      setSaving(false)
    }
  }

  return (
    <PageShell>
      {/* Upgrade success banner — appears once after Stripe checkout. */}
      {bannerOpen && (
        <UpgradeBanner tier={tier} onClose={() => setBannerOpen(false)} />
      )}

      <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-1">My Account</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Manage your subscription, appearance, and how we email you.
      </p>

      {/* ─── Account block ─── */}
      <Section title="Account">
        <Row label="Email" value={<span className="font-mono text-sm">{user.email}</span>} />
      </Section>

      {/* ─── Appearance block ─── */}
      <Section
        title="Appearance"
        right={
          <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-100
                           dark:text-amber-300 dark:bg-amber-900/40 px-2 py-0.5 rounded">
            Beta
          </span>
        }
      >
        <div className="grid grid-cols-3 gap-2">
          <ThemeOption
            value="system"
            current={theme}
            onPick={setTheme}
            label="System"
            desc="Match my device"
            icon={<IconSystem />}
          />
          <ThemeOption
            value="light"
            current={theme}
            onPick={setTheme}
            label="Light"
            desc="Always light"
            icon={<IconSun />}
          />
          <ThemeOption
            value="dark"
            current={theme}
            onPick={setTheme}
            label="Dark"
            desc="Always dark"
            icon={<IconMoon />}
          />
        </div>
        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-3 leading-snug">
          Dark mode is rolling out gradually. The header and a few key pages support it; other
          pages will be updated in coming releases.
          {theme === 'system' && (
            <> Currently following your device ({resolvedTheme}).</>
          )}
        </p>
      </Section>

      {/* ─── Subscription block ─── */}
      <Section
        title="Subscription"
        right={
          <Link
            to="/pricing"
            className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 hover:text-nw-teal
                       uppercase tracking-wider"
          >
            Compare plans →
          </Link>
        }
      >
        <SubscriptionDetails
          session={session}
          tier={tier}
          tierStartedAt={tierStartedAt}
          subInfo={subInfo}
        />
      </Section>

      {/* ─── Email preferences block ─── */}
      <Section
        title="Email preferences"
        right={
          savedAt && !error && (
            <span className="text-[11px] font-semibold text-emerald-600 uppercase tracking-wider">
              Saved
            </span>
          )
        }
      >
        {!prefsLoaded ? (
          <div className="text-sm text-gray-400 animate-pulse">Loading…</div>
        ) : (
          <>
            <p className="text-xs text-gray-500 mb-3">
              Pick what you want. We email from{' '}
              <span className="font-mono">info@nwbaseballstats.com</span>. Unsubscribe any time.
            </p>
            <div className="space-y-2.5 mb-4">
              <Choice
                checked={news}
                onChange={setNews}
                title="Newsletter"
                desc="Weekly-ish content, articles, and recaps from around PNW baseball."
              />
              <Choice
                checked={updates}
                onChange={setUpdates}
                title="Site announcements"
                desc="New features, big additions, occasional behind-the-scenes notes."
              />
              <Choice
                checked={promos}
                onChange={setPromos}
                title="Promotions"
                desc="Heads-ups about upcoming paid-tier features and any limited-time offers."
              />
            </div>

            {error && (
              <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3 py-2 rounded mb-3">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end">
              <button
                onClick={save}
                disabled={saving}
                className="px-4 py-2 text-sm font-bold uppercase tracking-wider rounded
                           bg-nw-teal text-white hover:bg-nw-teal-dark
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving…' : 'Save preferences'}
              </button>
            </div>
          </>
        )}
      </Section>
    </PageShell>
  )
}


// ─── Layout helpers ───
function PageShell({ children }) {
  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {children}
    </div>
  )
}

function Section({ title, right, children }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                    rounded-2xl shadow-sm p-5 sm:p-6 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-gray-700 dark:text-gray-300">
          {title}
        </h2>
        {right}
      </div>
      {children}
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">{label}</span>
      <span className="text-gray-900 dark:text-gray-100">{value}</span>
    </div>
  )
}

// ─── Appearance toggle pieces ───
function ThemeOption({ value, current, onPick, label, desc, icon }) {
  const active = current === value
  return (
    <button
      type="button"
      onClick={() => onPick(value)}
      className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border text-center
                  transition-colors ${
        active
          ? 'border-nw-teal bg-nw-teal/5 dark:bg-nw-teal/15'
          : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/40'
      }`}
    >
      <div className={active ? 'text-nw-teal' : 'text-gray-500 dark:text-gray-400'}>{icon}</div>
      <div className={`text-sm font-bold ${active ? 'text-nw-teal' : 'text-gray-900 dark:text-gray-100'}`}>
        {label}
      </div>
      <div className="text-[10px] text-gray-500 dark:text-gray-400 leading-snug">{desc}</div>
    </button>
  )
}

// ─── Upgrade success banner (?upgraded=true) ──────────────────
function UpgradeBanner({ tier, onClose }) {
  const tierName = tier === 'coach' ? 'Coach & Scout'
                 : tier === 'premium' ? 'Premium'
                 : 'paid'
  const isConfirmed = tier === 'premium' || tier === 'coach' || tier === 'paid'
  return (
    <div className="mb-5 bg-gradient-to-r from-emerald-50 to-teal-50
                    dark:from-emerald-900/30 dark:to-teal-900/30
                    border border-emerald-200 dark:border-emerald-800
                    rounded-xl p-4 sm:p-5 relative">
      <button
        onClick={onClose}
        className="absolute top-2 right-2 text-emerald-700/60 hover:text-emerald-900
                   dark:text-emerald-300/60 dark:hover:text-emerald-100 text-xl leading-none"
        aria-label="Dismiss"
      >
        ×
      </button>
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-10 h-10 rounded-full bg-emerald-500/15 dark:bg-emerald-400/20
                        flex items-center justify-center">
          <svg className="w-5 h-5 text-emerald-700 dark:text-emerald-300"
               fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <div>
          <h3 className="text-base sm:text-lg font-extrabold text-emerald-900 dark:text-emerald-100">
            {isConfirmed
              ? `Welcome to NW Baseball Stats ${tierName}!`
              : `Thanks — finalizing your subscription…`}
          </h3>
          <p className="text-[13px] sm:text-sm text-emerald-800/90 dark:text-emerald-200/90 mt-0.5 leading-snug">
            {isConfirmed
              ? `Your subscription is active. You'll get a welcome email at your account address shortly.`
              : `Stripe confirmed the payment — your account is being upgraded. This usually takes a few seconds.`}
          </p>
        </div>
      </div>
    </div>
  )
}

function IconSystem() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <line x1="8" y1="20" x2="16" y2="20" />
      <line x1="12" y1="16" x2="12" y2="20" />
    </svg>
  )
}

function IconSun() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

function IconMoon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function TierBadge({ tier }) {
  // Map every possible tier value to a badge style. Legacy 'paid' renders
  // the same as 'premium' since those rows were never differentiated.
  const palette = {
    free:    { cls: 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600',         label: 'Free' },
    premium: { cls: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700', label: 'Premium' },
    coach:   { cls: 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300 dark:border-indigo-700', label: 'Coach & Scout' },
    paid:    { cls: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700', label: 'Paid' },
    dev:     { cls: 'bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-700', label: 'Developer' },
  }[tier] || { cls: 'bg-gray-100 text-gray-700 border-gray-200', label: tier || '—' }
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${palette.cls}`}>
      {palette.label}
    </span>
  )
}


// ─── Subscription detail block ────────────────────────────────────
//
// Shows current tier + start date for paid users, with a "Manage
// subscription" button that opens the Stripe Customer Portal. For free
// users, shows a "See plans →" CTA pointing at /pricing.

function SubscriptionDetails({ session, tier, tierStartedAt, subInfo }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Comped accounts (devs + lifetime coaches granted via the backend
  // allowlist) have no Stripe customer to manage. They get a Free
  // Forever badge and skip the billing / portal UI entirely.
  const isComped = !!subInfo?.comped || tier === 'dev'
  const isPaid = !isComped && (tier === 'premium' || tier === 'coach' || tier === 'paid')

  async function openPortal() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${API_BASE}/billing/portal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(session) },
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.detail || `Could not open portal (${res.status})`)
      }
      const { url } = await res.json()
      if (!url) throw new Error('No portal URL returned')
      window.location.href = url
    } catch (e) {
      setError(e.message || 'Could not open billing portal')
      setBusy(false)
    }
  }

  // Period-end formatted: "June 1, 2026"
  const periodEndFmt = subInfo?.current_period_end
    ? new Date(subInfo.current_period_end).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
      })
    : null

  const intervalLabel = subInfo?.interval === 'yearly' ? 'Yearly'
                      : subInfo?.interval === 'monthly' ? 'Monthly'
                      : null

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <TierBadge tier={tier} />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              {isComped              ? (subInfo?.comped_label || 'Free Forever')
               : tier === 'coach'    ? 'Coach & Scout subscriber'
               : isPaid              ? 'Premium subscriber'
                                     : 'Free account'}
            </span>
            {isComped ? (
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded
                              bg-emerald-100 text-emerald-800 border border-emerald-200
                              dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-700">
                Free Forever
              </span>
            ) : intervalLabel && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded
                              bg-gray-100 text-gray-600 border border-gray-200
                              dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600">
                {intervalLabel}
              </span>
            )}
          </div>

          {/* Status line: shows the next billing date OR the cancellation date */}
          {isPaid && periodEndFmt && (
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
              {subInfo.cancel_at_period_end ? (
                <span className="text-rose-700 dark:text-rose-300 font-semibold">
                  Cancels on {periodEndFmt}
                </span>
              ) : (
                <>Next billing on <span className="font-semibold text-gray-800 dark:text-gray-200">{periodEndFmt}</span></>
              )}
            </p>
          )}

          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 leading-snug">
            {isComped
              ? (tier === 'dev'
                  ? 'Site-developer access. You can see every page on the site, including in-progress features hidden from the public. Thanks for building this with us.'
                  : 'Lifetime Coach & Scout access for being part of the private alpha. No payment required, no expiration. Thank you.')
              : isPaid
              ? (subInfo?.cancel_at_period_end
                  ? 'Your subscription is set to cancel at the end of the current period. You\'ll keep full access until then.'
                  : `Thanks for supporting NW Baseball Stats${tierStartedAt ? ` since ${new Date(tierStartedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : ''}.`)
              : 'You have full access to all public stats, leaderboards, and tools. Upgrade for premium content, recruiting tools, and the Coach & Scout portal.'}
          </p>
        </div>

        {isComped ? null : isPaid ? (
          <button
            onClick={openPortal}
            disabled={busy}
            className="shrink-0 px-3 py-2 text-xs font-bold uppercase tracking-wider rounded
                       border border-nw-teal text-nw-teal hover:bg-nw-teal hover:text-white
                       transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Loading…' : 'Manage subscription'}
          </button>
        ) : (
          <Link
            to="/pricing"
            className="shrink-0 px-3 py-2 text-xs font-bold uppercase tracking-wider rounded
                       border border-nw-teal text-nw-teal hover:bg-nw-teal hover:text-white
                       dark:hover:bg-nw-teal dark:hover:text-white transition-colors"
          >
            See plans →
          </Link>
        )}
      </div>

      {error && (
        <div className="mt-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3 py-2 rounded">
          {error}
        </div>
      )}
    </>
  )
}

function Choice({ checked, onChange, title, desc }) {
  return (
    <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer
                       transition-colors ${
                         checked
                           ? 'border-nw-teal bg-nw-teal/5 dark:bg-nw-teal/15'
                           : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/40'
                       }`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-nw-teal cursor-pointer shrink-0"
      />
      <div className="min-w-0">
        <div className="text-sm font-bold text-gray-900 dark:text-gray-100">{title}</div>
        <p className="text-[12px] text-gray-500 dark:text-gray-400 leading-snug mt-0.5">{desc}</p>
      </div>
    </label>
  )
}
