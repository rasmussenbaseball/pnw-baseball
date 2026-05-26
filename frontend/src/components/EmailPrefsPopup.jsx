// One-time email opt-in popup for logged-in users.
//
// Behavior:
//   • On mount, if there's a logged-in user, fetch their email_preferences.
//   • If they don't have a row yet, show the modal asking them to opt
//     into News / Promotions / Site Updates.
//   • Saving (with any selections, or none) stamps `prompted_at` so the
//     popup never reappears for that user.
//   • The popup never appears for signed-out visitors.
//
// Phase 2 (next session) will use these flags + the row's unsubscribe_token
// to send broadcasts via Resend and to power one-click unsubscribe URLs.

import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'

const API_BASE = '/api/v1'

// Show the popup at most this many seconds after page load. Gives the
// site a moment to render so we're not slapping a modal on a cold page.
const APPEAR_DELAY_MS = 1200

function authHeaders(session) {
  if (!session?.access_token) return {}
  return { Authorization: `Bearer ${session.access_token}` }
}

export default function EmailPrefsPopup() {
  const { user, session } = useAuth()
  const [shouldShow, setShouldShow] = useState(false)
  const [open, setOpen] = useState(false)

  // Defaults: all three boxes checked. Most users who click "Subscribe"
  // expect to get the newsletter; if they want to be selective they can
  // uncheck. If they want zero email, they click "No thanks" and we
  // save all three as false.
  const [news, setNews] = useState(true)
  const [promos, setPromos] = useState(true)
  const [updates, setUpdates] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // 1) Decide whether to show: only for logged-in users with no row.
  useEffect(() => {
    if (!user || !session) { setShouldShow(false); return }
    let alive = true
    fetch(`${API_BASE}/email-preferences/me`, { headers: authHeaders(session) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => { if (alive) setShouldShow(d.preferences == null) })
      .catch(() => { if (alive) setShouldShow(false) })  // silent fail — better than spamming
    return () => { alive = false }
  }, [user, session])

  // 2) Delay the actual reveal a beat after the SPA settles.
  useEffect(() => {
    if (!shouldShow) return
    const t = setTimeout(() => setOpen(true), APPEAR_DELAY_MS)
    return () => clearTimeout(t)
  }, [shouldShow])

  const save = async (allYes) => {
    if (submitting) return
    setSubmitting(true); setError(null)
    const payload = allYes
      ? { subscribed_news: news,    subscribed_promos: promos, subscribed_updates: updates }
      : { subscribed_news: false,   subscribed_promos: false,  subscribed_updates: false }
    try {
      const res = await fetch(`${API_BASE}/email-preferences/me`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(session) },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setOpen(false)
      setShouldShow(false)
    } catch (e) {
      setError(e.message || 'Could not save preferences')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-md w-full p-6 sm:p-7 relative">
        {/* Close (X) button — counts as "No thanks" so the modal doesn't come back */}
        <button
          onClick={() => save(false)}
          className="absolute top-3 right-3 text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200 text-xl leading-none"
          aria-label="Close"
        >
          ×
        </button>

        <div className="mb-4">
          <div className="inline-flex items-center gap-1.5 mb-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-nw-teal">
              Email signup
            </span>
          </div>
          <h2 className="text-xl sm:text-2xl font-extrabold text-gray-900 dark:text-gray-100 leading-tight">
            Stay in the loop with NW Baseball Stats
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 leading-snug">
            Get site news, occasional promotions, and announcements about new
            features delivered to your inbox. Pick what you want; unsubscribe
            any time from any email.
          </p>
        </div>

        <div className="space-y-2.5 mb-5">
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

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => save(false)}
            disabled={submitting}
            className="px-4 py-2 text-sm font-semibold text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            No thanks
          </button>
          <button
            onClick={() => save(true)}
            disabled={submitting || (!news && !promos && !updates)}
            className="px-4 py-2 text-sm font-bold uppercase tracking-wider rounded
                       bg-nw-teal text-white hover:bg-nw-teal-dark
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Saving…' : 'Subscribe'}
          </button>
        </div>

        <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-3 text-center">
          We'll only email what you ask for, from info@nwbaseballstats.com.
        </p>
      </div>
    </div>
  )
}


function Choice({ checked, onChange, title, desc }) {
  return (
    <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer
                       transition-colors ${
                         checked
                           ? 'border-nw-teal bg-nw-teal/5'
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
