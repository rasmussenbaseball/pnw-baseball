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
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const API_BASE = '/api/v1'

function authHeaders(session) {
  if (!session?.access_token) return {}
  return { Authorization: `Bearer ${session.access_token}` }
}

export default function Account() {
  const { user, session, loading: authLoading } = useAuth()

  // Email preferences state
  const [news, setNews] = useState(false)
  const [promos, setPromos] = useState(false)
  const [updates, setUpdates] = useState(false)
  const [prefsLoaded, setPrefsLoaded] = useState(false)

  // Subscription state
  const [tier, setTier] = useState(null)
  const [tierStartedAt, setTierStartedAt] = useState(null)

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

    fetch(`${API_BASE}/me/subscription`, { headers: authHeaders(session) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => {
        if (!alive) return
        setTier(d.tier || 'free')
        setTierStartedAt(d.started_at || null)
      })
      .catch(() => { if (alive) setTier('free') })

    return () => { alive = false }
  }, [session])

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
      <h1 className="text-3xl font-bold text-gray-900 mb-1">My Account</h1>
      <p className="text-sm text-gray-500 mb-6">
        Manage your subscription and how we email you.
      </p>

      {/* ─── Account block ─── */}
      <Section title="Account">
        <Row label="Email" value={<span className="font-mono text-sm">{user.email}</span>} />
      </Section>

      {/* ─── Subscription block ─── */}
      <Section
        title="Subscription"
        right={
          <Link
            to="/about"
            className="text-[11px] font-semibold text-gray-500 hover:text-nw-teal uppercase tracking-wider"
          >
            What's included →
          </Link>
        }
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <TierBadge tier={tier} />
              <span className="text-sm text-gray-700">
                {tier === 'paid' ? 'Paid subscriber' : 'Free account'}
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-1.5">
              {tier === 'paid'
                ? 'Thanks for supporting NW Baseball Stats.'
                : 'You have full access to all public stats, leaderboards, and tools. A paid tier with advanced scouting features is coming soon.'}
            </p>
          </div>
          {tier !== 'paid' && (
            <button
              disabled
              title="Coming soon"
              className="shrink-0 px-3 py-2 text-xs font-bold uppercase tracking-wider rounded
                         border border-gray-200 text-gray-400 cursor-not-allowed"
            >
              Upgrade · soon
            </button>
          )}
        </div>
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
    <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5 sm:p-6 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-gray-700">{title}</h2>
        {right}
      </div>
      {children}
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
      <span className="text-gray-900">{value}</span>
    </div>
  )
}

function TierBadge({ tier }) {
  const styles = tier === 'paid'
    ? 'bg-amber-100 text-amber-800 border-amber-200'
    : 'bg-gray-100 text-gray-700 border-gray-200'
  const label = tier === 'paid' ? 'Paid' : 'Free'
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${styles}`}>
      {label}
    </span>
  )
}

function Choice({ checked, onChange, title, desc }) {
  return (
    <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer
                       transition-colors ${
                         checked
                           ? 'border-nw-teal bg-nw-teal/5'
                           : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                       }`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-nw-teal cursor-pointer shrink-0"
      />
      <div className="min-w-0">
        <div className="text-sm font-bold text-gray-900">{title}</div>
        <p className="text-[12px] text-gray-500 leading-snug mt-0.5">{desc}</p>
      </div>
    </label>
  )
}
