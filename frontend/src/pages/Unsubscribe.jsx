// /unsubscribe?token=… — public page recipients land on when they click
// the footer "Manage email preferences" link in a broadcast email.
//
// The token is the per-user UUID from `email_preferences.unsubscribe_token`.
// We don't require sign-in; the token IS the credential. From here the
// recipient can toggle individual lists off, save, OR click the big
// "Unsubscribe from all" button.

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

const API_BASE = '/api/v1'

export default function Unsubscribe() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [news, setNews] = useState(false)
  const [promos, setPromos] = useState(false)
  const [updates, setUpdates] = useState(false)
  const [redactedEmail, setRedactedEmail] = useState(null)

  // 1) Fetch current preferences for this token.
  useEffect(() => {
    if (!token) { setError('Missing token'); setLoading(false); return }
    let alive = true
    fetch(`${API_BASE}/email-preferences/by-token/${encodeURIComponent(token)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => {
        if (!alive) return
        setNews(!!d.subscribed_news)
        setPromos(!!d.subscribed_promos)
        setUpdates(!!d.subscribed_updates)
        setRedactedEmail(d.email_redacted || null)
        setLoading(false)
      })
      .catch(e => {
        if (!alive) return
        setError(e.message === 'HTTP 404'
          ? 'This unsubscribe link is no longer valid.'
          : 'Could not load your email preferences.')
        setLoading(false)
      })
    return () => { alive = false }
  }, [token])

  const allOff = !news && !promos && !updates

  async function save(nextState) {
    if (submitting) return
    setSubmitting(true); setError(null); setSaved(false)
    try {
      const res = await fetch(
        `${API_BASE}/email-preferences/by-token/${encodeURIComponent(token)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nextState),
        }
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      setNews(!!d.subscribed_news)
      setPromos(!!d.subscribed_promos)
      setUpdates(!!d.subscribed_updates)
      setSaved(true)
    } catch (e) {
      setError('Could not save your preferences. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const onSaveCurrent = () => save({
    subscribed_news: news, subscribed_promos: promos, subscribed_updates: updates,
  })

  const onUnsubAll = () => save({
    subscribed_news: false, subscribed_promos: false, subscribed_updates: false,
  })

  return (
    <div className="max-w-xl mx-auto px-4 py-12">
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 sm:p-8">
        <div className="mb-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-nw-teal mb-1">
            NW Baseball Stats
          </div>
          <h1 className="text-2xl font-extrabold text-gray-900 leading-tight">
            Email preferences
          </h1>
          {redactedEmail && (
            <p className="text-sm text-gray-500 mt-1">
              Managing preferences for <span className="font-mono">{redactedEmail}</span>
            </p>
          )}
        </div>

        {loading && <div className="text-gray-500 animate-pulse">Loading…</div>}

        {!loading && error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm px-3 py-2 rounded">
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
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

            {saved && (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs
                              px-3 py-2 rounded mb-3">
                {allOff
                  ? 'You\'ve been unsubscribed from all NW Baseball Stats emails.'
                  : 'Your preferences have been saved.'}
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
              <button
                onClick={onUnsubAll}
                disabled={submitting || allOff}
                className="text-sm font-semibold text-rose-600 hover:text-rose-700
                           disabled:opacity-40 disabled:cursor-not-allowed underline underline-offset-2"
              >
                Unsubscribe from all
              </button>
              <button
                onClick={onSaveCurrent}
                disabled={submitting}
                className="px-4 py-2 text-sm font-bold uppercase tracking-wider rounded
                           bg-nw-teal text-white hover:bg-nw-teal-dark
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Saving…' : 'Save preferences'}
              </button>
            </div>

            <p className="text-[11px] text-gray-400 mt-4 leading-snug">
              Changes apply immediately. You can resubscribe any time from your account.
            </p>
          </>
        )}
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
