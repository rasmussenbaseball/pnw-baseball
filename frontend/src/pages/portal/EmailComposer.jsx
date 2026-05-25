// /broadcasts — admin email broadcast composer.
//
// Layout mirrors /articles/edit (Google Docs-style "document"):
//   • Sticky top toolbar with back, audience picker, formatting buttons,
//     Preview toggle, Send Test, Send Broadcast
//   • Centered max-w-3xl "page" on a soft gray background
//   • Big borderless subject input + auto-growing borderless body
//     textarea so writing feels like a document, not a form
//   • Always-on faded preview of the signature block that the backend
//     auto-appends (so the author knows exactly what subscribers see)
//   • Recent broadcasts list rendered below the document
//
// Email-gated via RequireArticleAuthor in App.jsx (same allowlist as
// the article editor). Sends through Resend; preview / send / send-test
// endpoints all live under /api/v1/portal/broadcasts/*.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAuth } from '../../context/AuthContext'

const API_BASE = '/api/v1'

const AUDIENCES = [
  { value: 'news',    label: 'Newsletter',         short: 'News',          desc: 'Content drops, articles, recaps' },
  { value: 'updates', label: 'Site announcements', short: 'Announcements', desc: 'New features, big additions' },
  { value: 'promos',  label: 'Promotions',         short: 'Promotions',    desc: 'Paid-tier offers, limited-time deals' },
]

function authHeaders(session) {
  if (!session?.access_token) return {}
  return { Authorization: `Bearer ${session.access_token}` }
}

export default function EmailComposer() {
  const navigate = useNavigate()
  const { session, user } = useAuth()

  const [subject, setSubject] = useState('')
  const [bodyMd, setBodyMd] = useState('')
  const [audience, setAudience] = useState('news')
  const [isPreview, setIsPreview] = useState(false)

  const [counts, setCounts] = useState(null)
  const [broadcasts, setBroadcasts] = useState([])
  const [busy, setBusy] = useState(null)      // 'test' | 'send' | null
  const [uploading, setUploading] = useState(false)
  const [flash, setFlash] = useState(null)    // { type:'ok'|'err', text }

  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)

  // Auto-grow the body textarea to match its content so the editor reads
  // like a flowing document instead of a fixed-height box with a scroll.
  function autoGrow() {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.max(ta.scrollHeight, 360)}px`
  }
  useEffect(() => { autoGrow() }, [bodyMd, isPreview])

  // ─── Initial data load ─────────────────────────────────────
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

  // ─── Toolbar helpers (same shape as ArticleEditor) ────────
  function wrapSelection(before, after = before, placeholder = 'text') {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const sel = bodyMd.slice(start, end) || placeholder
    const next = bodyMd.slice(0, start) + before + sel + after + bodyMd.slice(end)
    setBodyMd(next)
    requestAnimationFrame(() => {
      ta.focus()
      const ns = start + before.length
      ta.setSelectionRange(ns, ns + sel.length)
    })
  }
  function insertAtCursor(text) {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const next = bodyMd.slice(0, start) + text + bodyMd.slice(end)
    setBodyMd(next)
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + text.length
      ta.setSelectionRange(pos, pos)
    })
  }
  function prefixLine(prefix) {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const lineStart = bodyMd.lastIndexOf('\n', start - 1) + 1
    const next = bodyMd.slice(0, lineStart) + prefix + bodyMd.slice(lineStart)
    setBodyMd(next)
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + prefix.length
      ta.setSelectionRange(pos, pos)
    })
  }
  function insertLink() {
    const ta = textareaRef.current
    if (!ta) return
    const sel = bodyMd.slice(ta.selectionStart, ta.selectionEnd)
    const url = window.prompt('Link URL', 'https://')
    if (!url) return
    const text = sel || window.prompt('Link text', '') || 'link'
    insertAtCursor(`[${text}](${url})`)
  }

  // Image upload reuses the article-images Supabase Storage endpoint
  // — same author allowlist gates both, same bucket, no extra plumbing.
  async function uploadImage(file) {
    if (!session?.access_token) throw new Error('Not authenticated; refresh and try again.')
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${API_BASE}/portal/articles/upload-image`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
      body: fd,
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      throw new Error(j.detail || `Upload failed (${res.status})`)
    }
    return res.json()
  }
  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true); setFlash(null)
    try {
      const data = await uploadImage(file)
      const alt = (file.name || 'image').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')
      insertAtCursor(`\n\n![${alt}](${data.url})\n\n`)
    } catch (err) { setFlash({ type: 'err', text: err.message || 'Image upload failed' }) }
    finally { setUploading(false) }
  }

  // ─── Send / preview / test ─────────────────────────────────
  const audienceMeta = AUDIENCES.find(a => a.value === audience)
  const audienceCount = counts ? counts[audience] : null
  const canSend = subject.trim().length > 0 && bodyMd.trim().length > 0

  async function postCompose(path) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(session) },
      body: JSON.stringify({ subject: subject.trim(), body_md: bodyMd, audience }),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`)
    }
    return res.json()
  }

  async function onSendTest() {
    if (!canSend || busy != null) return
    setBusy('test'); setFlash(null)
    try {
      const r = await postCompose('/portal/broadcasts/test')
      setFlash({
        type: 'ok',
        text: `Test sent to ${r.test_to} (${r.sent} delivered${r.failed ? `, ${r.failed} failed` : ''}).`,
      })
    } catch (err) { setFlash({ type: 'err', text: err.message || 'Test send failed' }) }
    finally { setBusy(null) }
  }

  async function onSendReal() {
    if (!canSend || busy != null || audienceCount === 0) return
    const ok = window.confirm(
      `Send "${subject.trim()}" to ${audienceCount} subscriber${audienceCount === 1 ? '' : 's'} ` +
      `(${audienceMeta.label})?\n\nThis cannot be undone.`
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
      setSubject('')
      setBodyMd('')
      refreshBroadcasts()
    } catch (err) { setFlash({ type: 'err', text: err.message || 'Send failed' }) }
    finally { setBusy(null) }
  }

  return (
    <div className="bg-gray-50 min-h-screen">
      {/* ── Sticky top toolbar ─────────────────────────────────── */}
      <div className="sticky top-0 z-30 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-2 flex-wrap">
          {/* Left cluster */}
          <button
            onClick={() => navigate('/portal')}
            className="text-xs font-semibold text-gray-600 hover:text-gray-900 px-2 py-1 rounded
                       hover:bg-gray-100 transition-colors"
          >
            ← Portal
          </button>

          {/* Audience picker (compact) */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">To</span>
            <select
              value={audience}
              onChange={e => setAudience(e.target.value)}
              className="text-xs font-semibold text-gray-800 bg-gray-100 hover:bg-gray-200
                         rounded px-2 py-1 border-0 outline-none focus:ring-1 focus:ring-nw-teal/30
                         cursor-pointer transition-colors"
            >
              {AUDIENCES.map(a => (
                <option key={a.value} value={a.value}>
                  {a.label}{counts ? ` (${counts[a.value]})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Middle cluster — formatting (mirrors ArticleEditor) */}
          <div className="flex items-center gap-0.5 ml-auto mr-auto sm:ml-4 sm:mr-auto">
            <ToolBtn label="H2"    title="Heading 2"     onClick={() => prefixLine('## ')} disabled={isPreview} />
            <ToolBtn label="B"     title="Bold"          onClick={() => wrapSelection('**')} disabled={isPreview} bold />
            <ToolBtn label="I"     title="Italic"        onClick={() => wrapSelection('*')} disabled={isPreview} italic />
            <ToolDivider />
            <ToolBtn label="Link"  title="Insert link"   onClick={insertLink} disabled={isPreview} />
            <ToolBtn label="Image" title="Insert image"
                     onClick={() => fileInputRef.current?.click()}
                     disabled={isPreview || uploading} />
            {uploading && <span className="text-[10px] text-gray-500 ml-1">Uploading…</span>}
            <ToolDivider />
            <ToolBtn label="❝"     title="Block quote"   onClick={() => prefixLine('> ')} disabled={isPreview} />
            <ToolBtn label="•"     title="Bullet list"   onClick={() => prefixLine('- ')} disabled={isPreview} />
            <ToolBtn label="1."    title="Numbered list" onClick={() => prefixLine('1. ')} disabled={isPreview} />
            <ToolBtn label="</>"   title="Inline code"   onClick={() => wrapSelection('`')} disabled={isPreview} mono />
          </div>

          {/* Right cluster */}
          <button
            onClick={() => setIsPreview(v => !v)}
            className={`text-xs font-semibold px-3 py-1.5 rounded transition-colors ${
              isPreview ? 'bg-gray-900 text-white hover:bg-black' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
            title={isPreview ? 'Back to editing' : 'Preview as recipients will see it'}
          >
            {isPreview ? 'Editing' : 'Preview'}
          </button>
          <button
            onClick={onSendTest}
            disabled={!canSend || busy != null}
            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded
                       bg-gray-200 text-gray-800 hover:bg-gray-300
                       disabled:opacity-50 disabled:cursor-not-allowed"
            title="Send a test only to your inbox"
          >
            {busy === 'test' ? 'Sending…' : 'Send Test'}
          </button>
          <button
            onClick={onSendReal}
            disabled={!canSend || busy != null || audienceCount === 0}
            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded text-white
                       bg-nw-teal hover:bg-nw-teal-dark
                       disabled:opacity-50 disabled:cursor-not-allowed"
            title={`Send to ${audienceCount ?? '—'} subscribers`}
          >
            {busy === 'send' ? 'Sending…' : 'Send Broadcast'}
          </button>

          <input ref={fileInputRef} type="file"
                 accept="image/png,image/jpeg,image/webp,image/gif"
                 onChange={handleFile} className="hidden" />
        </div>

        {flash && (
          <div className={`border-t text-xs px-4 py-2 ${
            flash.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
              : 'bg-rose-50 border-rose-200 text-rose-700'
          }`}>
            {flash.text}
          </div>
        )}
      </div>

      {/* ── The "page" ─────────────────────────────────────────── */}
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="bg-white shadow-md rounded-lg overflow-hidden">
          {/* Brand bar (mimics what the email itself shows) */}
          <div className="px-8 sm:px-12 pt-7 pb-2">
            <div className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-nw-teal">
              NW Baseball Stats
            </div>
          </div>

          <div className="px-8 sm:px-12 py-6 sm:py-8">
            {isPreview ? (
              <EmailPreview
                subject={subject}
                bodyMd={bodyMd}
                authorEmail={user?.email}
                audienceLabel={audienceMeta?.label}
                audienceCount={audienceCount}
              />
            ) : (
              <>
                {/* Subject — borderless, looks like an email subject */}
                <input
                  type="text"
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  placeholder="Subject line"
                  maxLength={200}
                  className="w-full border-0 outline-none focus:ring-0 text-2xl sm:text-3xl font-extrabold
                             text-gray-900 leading-tight placeholder-gray-300 px-0 py-1 bg-transparent"
                />

                {/* Send-as strip (informational) */}
                <div className="flex items-center gap-2 mt-2 mb-5 pb-4 border-b border-gray-100 text-[11px]">
                  <span className="uppercase tracking-wider text-gray-400">From</span>
                  <span className="font-semibold text-gray-700">
                    NW Baseball Stats &lt;info@nwbaseballstats.com&gt;
                  </span>
                  <span className="text-gray-300">·</span>
                  <span className="uppercase tracking-wider text-gray-400">To</span>
                  <span className="font-semibold text-gray-700">
                    {audienceMeta?.label}
                    {audienceCount != null && (
                      <span className="text-gray-400 font-normal ml-1">
                        ({audienceCount} subscriber{audienceCount === 1 ? '' : 's'})
                      </span>
                    )}
                  </span>
                </div>

                {/* Body — borderless, prose-styled, auto-growing */}
                <textarea
                  ref={textareaRef}
                  value={bodyMd}
                  onChange={e => { setBodyMd(e.target.value); autoGrow() }}
                  onFocus={autoGrow}
                  spellCheck="true"
                  placeholder="Write your message. Press Enter for new paragraphs. Use the toolbar to format. Click Preview at any time to see exactly what subscribers will get."
                  className="w-full border-0 outline-none focus:ring-0 resize-none
                             text-base sm:text-[17px] leading-relaxed text-gray-800
                             placeholder-gray-300 px-0 py-1 bg-transparent font-sans"
                  style={{ minHeight: '360px' }}
                />

                {/* Signature preview — shows what gets auto-appended */}
                <SignatureBlock />

                {/* Footer preview — the unsubscribe line in every email */}
                <div className="mt-4 pt-3 border-t border-gray-100 text-[11px] text-gray-400 leading-snug">
                  You're receiving this because you subscribed at nwbaseballstats.com.<br />
                  Manage email preferences or unsubscribe.
                </div>
              </>
            )}
          </div>
        </div>

        <p className="text-[11px] text-gray-400 mt-4 text-center px-4">
          {isPreview
            ? 'Showing the email exactly as it will appear in subscribers\' inboxes. Click Editing to keep writing.'
            : 'Tip: highlight text first, then click B / I / Link to wrap your selection. The signature and unsubscribe footer are automatically appended to every email.'}
        </p>

        {/* Recent broadcasts */}
        <div className="mt-8">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.15em] text-gray-500 mb-2 px-1">
            Recent broadcasts
          </h2>
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            {broadcasts.length === 0 ? (
              <div className="p-5 text-sm text-gray-400 italic">No broadcasts yet.</div>
            ) : (
              <div className="divide-y divide-gray-100">
                {broadcasts.map(b => <BroadcastRow key={b.id} b={b} />)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}


// ─── Signature preview shown inline in the composer ───────────
function SignatureBlock() {
  return (
    <div className="mt-7 pt-4 border-t border-gray-200 flex items-center gap-3.5">
      <a href="/" className="shrink-0">
        <img
          src="/favicon.png"
          alt="NW Baseball Stats"
          className="w-12 h-12 rounded-[10px] object-cover bg-gray-100"
          onError={(e) => { e.currentTarget.style.display = 'none' }}
        />
      </a>
      <div className="min-w-0">
        <div className="text-[13px] font-extrabold text-nw-teal leading-tight tracking-wide">
          NW Baseball Stats
        </div>
        <div className="text-[11px] text-gray-500 leading-snug mt-0.5">
          College baseball analytics for the Pacific Northwest.
        </div>
        <div className="text-[11px] font-semibold text-nw-teal mt-0.5">nwbaseballstats.com</div>
      </div>
    </div>
  )
}


// ─── Read-only preview view (Preview button) ──────────────────
function EmailPreview({ subject, bodyMd, authorEmail, audienceLabel, audienceCount }) {
  return (
    <article>
      <div className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-nw-teal mb-3">
        From info@nwbaseballstats.com → {audienceLabel}{audienceCount != null ? ` (${audienceCount})` : ''}
      </div>
      <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-900 leading-tight">
        {subject || <span className="text-gray-300">Subject line</span>}
      </h1>
      <div className="mt-5 markdown prose prose-sm sm:prose-base max-w-none text-gray-800">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {bodyMd || '_Nothing written yet._'}
        </ReactMarkdown>
      </div>
      <SignatureBlock />
      <div className="mt-4 pt-3 border-t border-gray-100 text-[11px] text-gray-400 leading-snug">
        You're receiving this because you subscribed at nwbaseballstats.com.<br />
        Manage email preferences or unsubscribe.
      </div>
    </article>
  )
}


// ─── Recent broadcasts list item ──────────────────────────────
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
    <div className="py-2.5 px-4 flex items-start gap-3">
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


// ─── Toolbar primitives (same shape as ArticleEditor) ─────────
function ToolBtn({ label, title, onClick, disabled, bold, italic, mono }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`px-2 py-1 rounded text-xs hover:bg-gray-200 transition-colors
                  disabled:opacity-30 disabled:cursor-not-allowed
                  ${bold ? 'font-extrabold' : ''}
                  ${italic ? 'italic font-bold' : ''}
                  ${mono ? 'font-mono' : ''}`}
    >
      {label}
    </button>
  )
}
function ToolDivider() {
  return <span className="w-px h-5 bg-gray-300 mx-0.5" />
}
