// /broadcasts — admin email broadcast composer.
//
// Email-gated via RequireArticleAuthor in App.jsx (same allowlist as
// the article editor). Author writes a subject + markdown body, picks
// an audience (Newsletter / Promotions / Site announcements), can
// "Send a test to me" first, then "Send broadcast" to fan it out to
// every opted-in subscriber. Recent broadcasts are listed below.

import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAuth } from '../../context/AuthContext'

const API_BASE = '/api/v1'

const AUDIENCES = [
  { value: 'news',    label: 'Newsletter',          desc: 'Content drops, articles, recaps' },
  { value: 'updates', label: 'Site announcements',  desc: 'New features, big additions' },
  { value: 'promos',  label: 'Promotions',          desc: 'Paid-tier offers, limited-time deals' },
]

function authHeaders(session) {
  if (!session?.access_token) return {}
  return { Authorization: `Bearer ${session.access_token}` }
}

export default function EmailComposer() {
  const { session, user } = useAuth()

  const [subject, setSubject] = useState('')
  const [bodyMd, setBodyMd] = useState('')
  const [audience, setAudience] = useState('news')
  const [isPreview, setIsPreview] = useState(false)
  const [counts, setCounts] = useState(null)
  const [broadcasts, setBroadcasts] = useState([])
  const [busy, setBusy] = useState(null) // 'test' | 'send' | null
  const [flash, setFlash] = useState(null) // { type, text }

  const textareaRef = useRef(null)

  function autoGrow() {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.max(ta.scrollHeight, 320)}px`
  }
  useEffect(() => { autoGrow() }, [bodyMd, isPreview])

  // Audience counts + recent broadcasts on mount.
  useEffect(() => {
    if (!session) return
    fetch(`${API_BASE}/portal/broadcasts/audience-counts`, { headers: authHeaders(session) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setCounts)
      .catch(() => setCounts(null))
    refreshBroadcasts()
  }, [session])

  function refreshBroadcasts() {
    fetch(`${API_BASE}/portal/broadcasts?limit=15`, { headers: authHeaders(session) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => setBroadcasts(d.broadcasts || []))
      .catch(() => setBroadcasts([]))
  }

  const audienceCount = counts ? counts[audience] : null
  const sendDisabled =
    !subject.trim() || !bodyMd.trim() || busy != null || audienceCount === 0

  async function postCompose(path) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(session) },
      body: JSON.stringify({
        subject: subject.trim(),
        body_md: bodyMd,
        audience,
      }),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`)
    }
    return res.json()
  }

  async function onSendTest() {
    if (!subject.trim() || !bodyMd.trim()) return
    setBusy('test'); setFlash(null)
    try {
      const r = await postCompose('/portal/broadcasts/test')
      setFlash({
        type: 'ok',
        text: `Test sent to ${r.test_to} (${r.sent} delivered${r.failed ? `, ${r.failed} failed` : ''}).`,
      })
    } catch (e) {
      setFlash({ type: 'err', text: e.message || 'Test send failed' })
    } finally {
      setBusy(null)
    }
  }

  async function onSendReal() {
    if (sendDisabled) return
    const a = AUDIENCES.find(x => x.value === audience)
    const ok = window.confirm(
      `Send "${subject.trim()}" to ${audienceCount} subscriber${audienceCount === 1 ? '' : 's'} ` +
      `(${a.label})?\n\nThis cannot be undone.`
    )
    if (!ok) return
    setBusy('send'); setFlash(null)
    try {
      const r = await postCompose('/portal/broadcasts/send')
      setFlash({
        type: 'ok',
        text: `Broadcast sent: ${r.sent}/${r.recipient_count} delivered` +
              `${r.failed ? `, ${r.failed} failed` : ''}.`,
      })
      // Clear the composer so they don't accidentally double-send.
      setSubject('')
      setBodyMd('')
      refreshBroadcasts()
    } catch (e) {
      setFlash({ type: 'err', text: e.message || 'Send failed' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="mb-5">
        <h1 className="text-3xl font-bold text-gray-900">Email broadcasts</h1>
        <p className="text-sm text-gray-500 mt-1">
          Compose and send to opted-in subscribers. Sends as{' '}
          <span className="font-mono">info@nwbaseballstats.com</span> via Google Workspace SMTP relay.
        </p>
      </div>

      {/* Audience counts badge strip */}
      <div className="flex flex-wrap items-center gap-2 mb-4 text-xs">
        <span className="text-gray-500">Audience size:</span>
        {AUDIENCES.map(a => (
          <span key={a.value}
            className={`px-2 py-0.5 rounded-full border ${
              audience === a.value
                ? 'bg-nw-teal text-white border-nw-teal'
                : 'bg-white border-gray-200 text-gray-600'
            }`}>
            {a.label}: {counts ? counts[a.value] : '–'}
          </span>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5 sm:p-6 mb-6">
        {/* Audience */}
        <div className="mb-4">
          <label className="block text-xs font-bold uppercase tracking-wider text-gray-600 mb-1.5">
            Audience
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {AUDIENCES.map(a => (
              <button
                key={a.value}
                onClick={() => setAudience(a.value)}
                type="button"
                className={`text-left p-2.5 rounded-lg border transition-colors ${
                  audience === a.value
                    ? 'border-nw-teal bg-nw-teal/5'
                    : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                }`}
              >
                <div className="text-sm font-bold text-gray-900">{a.label}</div>
                <div className="text-[11px] text-gray-500 leading-snug mt-0.5">{a.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Subject */}
        <div className="mb-4">
          <label className="block text-xs font-bold uppercase tracking-wider text-gray-600 mb-1.5">
            Subject
          </label>
          <input
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="Subject line for the email"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg
                       focus:border-nw-teal focus:outline-none focus:ring-1 focus:ring-nw-teal/30"
            maxLength={200}
          />
        </div>

        {/* Body / Preview toggle */}
        <div className="mb-3 flex items-center justify-between">
          <label className="text-xs font-bold uppercase tracking-wider text-gray-600">
            Body (markdown)
          </label>
          <div className="text-[11px] text-gray-400">
            <button
              type="button"
              onClick={() => setIsPreview(p => !p)}
              className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${
                isPreview
                  ? 'bg-nw-teal text-white border-nw-teal'
                  : 'bg-white border-gray-200 text-gray-700 hover:border-gray-300'
              }`}
            >
              {isPreview ? 'Edit' : 'Preview'}
            </button>
          </div>
        </div>

        {!isPreview ? (
          <textarea
            ref={textareaRef}
            value={bodyMd}
            onChange={e => setBodyMd(e.target.value)}
            placeholder={
              "Write your message in markdown.\n\n" +
              "**bold**, *italic*, [link](https://...), # heading,\n" +
              "- bullet, > quote, etc.\n"
            }
            className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm
                       focus:border-nw-teal focus:outline-none focus:ring-1 focus:ring-nw-teal/30
                       resize-none"
            spellCheck={true}
          />
        ) : (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 min-h-[320px]">
            {bodyMd.trim() ? (
              <div className="markdown prose prose-sm max-w-none text-gray-800">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{bodyMd}</ReactMarkdown>
              </div>
            ) : (
              <div className="text-sm text-gray-400 italic">Nothing to preview yet.</div>
            )}
          </div>
        )}

        {/* Flash / status row */}
        {flash && (
          <div className={`mt-3 text-xs px-3 py-2 rounded border ${
            flash.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
              : 'bg-rose-50 border-rose-200 text-rose-700'
          }`}>
            {flash.text}
          </div>
        )}

        {/* Send buttons */}
        <div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="text-[11px] text-gray-500">
            Sending as {user?.email || '—'}. Test goes only to your inbox; broadcast goes to{' '}
            <span className="font-bold">{audienceCount ?? '—'}</span> subscriber{audienceCount === 1 ? '' : 's'}.
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onSendTest}
              disabled={busy != null || !subject.trim() || !bodyMd.trim()}
              className="px-3 py-2 text-sm font-semibold text-gray-700 border border-gray-300 rounded
                         hover:border-gray-400 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === 'test' ? 'Sending test…' : 'Send test to me'}
            </button>
            <button
              onClick={onSendReal}
              disabled={sendDisabled}
              className="px-4 py-2 text-sm font-bold uppercase tracking-wider rounded
                         bg-nw-teal text-white hover:bg-nw-teal-dark
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === 'send' ? 'Sending…' : 'Send broadcast'}
            </button>
          </div>
        </div>
      </div>

      {/* Recent broadcasts */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5 sm:p-6">
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-gray-700 mb-3">
          Recent broadcasts
        </h2>
        {broadcasts.length === 0 ? (
          <div className="text-sm text-gray-400 italic">No broadcasts yet.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {broadcasts.map(b => <BroadcastRow key={b.id} b={b} />)}
          </div>
        )}
      </div>
    </div>
  )
}


function BroadcastRow({ b }) {
  const when = b.sent_at || b.created_at
  const stamp = when ? new Date(when).toLocaleString() : '—'
  const statusColor = {
    sent:    'bg-emerald-100 text-emerald-700',
    partial: 'bg-amber-100 text-amber-700',
    sending: 'bg-sky-100 text-sky-700',
    failed:  'bg-rose-100 text-rose-700',
    queued:  'bg-gray-100 text-gray-700',
  }[b.status] || 'bg-gray-100 text-gray-700'

  return (
    <div className="py-2.5 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-gray-900 truncate">{b.subject}</div>
        <div className="text-[11px] text-gray-500 mt-0.5">
          {b.audience} · {b.sent_count}/{b.recipient_count} sent
          {b.failed_count ? ` · ${b.failed_count} failed` : ''} · {stamp}
        </div>
      </div>
      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${statusColor}`}>
        {b.status}
      </span>
    </div>
  )
}
