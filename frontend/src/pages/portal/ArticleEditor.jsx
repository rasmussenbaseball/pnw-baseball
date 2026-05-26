// /articles/new and /articles/edit/:id — full-page document editor.
//
// Layout is one centered "page" (max-w 800px on a soft gray background)
// so writing feels like a Google Doc / Medium post rather than a form:
//   • Cover image at top, full-bleed across the page (click to upload).
//   • Big borderless title, then a smaller borderless subtitle.
//   • A compact byline strip (author name + status).
//   • A clean, borderless, auto-growing textarea for the body.
//   • A sticky toolbar at the top of the viewport: ← My Articles, status,
//     formatting buttons (H2 / B / I / link / image / quote / list / code),
//     Preview toggle, Save, Publish.
// Toggle Preview to swap the body textarea for the fully rendered
// markdown so you can review the article exactly as readers will see it.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAuth } from '../../context/AuthContext'
import { useMyArticle, useArticleMutations } from '../../hooks/useArticles'

const API_BASE = '/api/v1'

export default function ArticleEditor() {
  const { id } = useParams()
  const editId = id ? parseInt(id, 10) : null
  const isNew = !editId
  const navigate = useNavigate()
  const { user, session } = useAuth()

  const { data: existing, loading } = useMyArticle(editId)
  const { create, update, togglePublish } = useArticleMutations()

  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [bodyMd, setBodyMd] = useState('')
  const [hero, setHero] = useState('')
  const [authorName, setAuthorName] = useState('')
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadingHero, setUploadingHero] = useState(false)
  const [status, setStatus] = useState('draft')
  const [savedSlug, setSavedSlug] = useState(null)
  const [error, setError] = useState(null)
  const [isPreview, setIsPreview] = useState(false)
  // Article paywall tier — 'free' (default), 'premium', or 'coach'.
  // Locks article BODY behind the chosen tier; metadata + excerpt remain
  // public so search and link-previews still work.
  const [requiresTier, setRequiresTier] = useState('free')

  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)
  const heroInputRef = useRef(null)

  // Auto-grow the body textarea to match its content so the editor reads
  // like a flowing document instead of a fixed-height box with a scrollbar.
  function autoGrow() {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.max(ta.scrollHeight, 480)}px`
  }
  useEffect(() => { autoGrow() }, [bodyMd, isPreview])

  // Hydrate form from existing article on edit.
  useEffect(() => {
    if (!existing) return
    setTitle(existing.title || '')
    setSubtitle(existing.subtitle || '')
    setBodyMd(existing.body_md || '')
    setHero(existing.hero_image_url || '')
    setAuthorName(existing.author_name || '')
    setStatus(existing.status || 'draft')
    setSavedSlug(existing.slug || null)
    setRequiresTier(existing.requires_tier || 'free')
  }, [existing])

  // Default author name on a brand-new article from the user's email.
  useEffect(() => {
    if (isNew && !authorName && user?.email) {
      const local = user.email.split('@')[0]
      setAuthorName(local.replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
    }
  }, [isNew, user, authorName])

  const canSave = useMemo(
    () => title.trim().length > 0 && authorName.trim().length > 0,
    [title, authorName]
  )

  // ── Toolbar / textarea helpers ───────────────────────────────
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
    setUploading(true); setError(null)
    try {
      const data = await uploadImage(file)
      const alt = (file.name || 'image').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')
      insertAtCursor(`\n\n![${alt}](${data.url})\n\n`)
    } catch (e) { setError(e.message || 'Image upload failed') }
    finally { setUploading(false) }
  }
  async function handleHeroFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploadingHero(true); setError(null)
    try {
      const data = await uploadImage(file)
      setHero(data.url)
    } catch (e) { setError(e.message || 'Hero upload failed') }
    finally { setUploadingHero(false) }
  }

  // ── Save / publish ───────────────────────────────────────────
  const save = async () => {
    if (!canSave || saving) return
    setError(null); setSaving(true)
    try {
      const payload = {
        title: title.trim(),
        subtitle: subtitle.trim() || null,
        body_md: bodyMd,
        hero_image_url: hero.trim() || null,
        author_name: authorName.trim(),
        requires_tier: requiresTier,
      }
      const saved = editId
        ? await update(editId, payload)
        : await create(payload)
      setSavedSlug(saved.slug)
      setStatus(saved.status)
      if (isNew) navigate(`/articles/edit/${saved.id}`, { replace: true })
    } catch (e) { setError(e.message || 'Save failed.') }
    finally { setSaving(false) }
  }
  const onPublishToggle = async () => {
    if (!editId) { await save(); return }
    setSaving(true); setError(null)
    try {
      const updated = await togglePublish(editId, status !== 'published')
      setStatus(updated.status)
    } catch (e) { setError(e.message || 'Publish toggle failed.') }
    finally { setSaving(false) }
  }

  if (editId && loading && !existing) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6 text-gray-500 animate-pulse">
        Loading article…
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-100 -mt-4 sm:-mt-5">
      {/* ── Sticky top toolbar ─────────────────────────────────── */}
      <div className="sticky top-0 z-30 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-2 flex-wrap">
          {/* Left cluster */}
          <button
            onClick={() => navigate('/articles')}
            className="text-xs font-semibold text-gray-600 hover:text-gray-900 px-2 py-1 rounded
                       hover:bg-gray-100 transition-colors"
          >
            ← My Articles
          </button>
          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
            status === 'published'
              ? 'bg-emerald-100 text-emerald-800'
              : status === 'archived'
              ? 'bg-rose-100 text-rose-700'
              : 'bg-gray-200 text-gray-700'
          }`}>
            {status}
          </span>

          {/* Tier picker — sets articles.requires_tier. Body is locked
              behind this tier; metadata stays public. */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Access</span>
            <select
              value={requiresTier}
              onChange={(e) => setRequiresTier(e.target.value)}
              disabled={isPreview}
              className="text-[11px] font-semibold text-gray-800 bg-gray-100 hover:bg-gray-200
                         rounded px-1.5 py-0.5 border-0 outline-none focus:ring-1 focus:ring-nw-teal/30
                         cursor-pointer transition-colors"
              title="Minimum tier required to read the article body"
            >
              <option value="free">Free</option>
              <option value="premium">Premium</option>
              <option value="coach">Coach</option>
            </select>
          </div>

          {savedSlug && status === 'published' && (
            <a href={`/news/${savedSlug}`} target="_blank" rel="noreferrer"
               className="text-[11px] text-nw-teal hover:underline">View on /news →</a>
          )}

          {/* Middle cluster — markdown formatting */}
          <div className="flex items-center gap-0.5 ml-auto mr-auto sm:ml-4 sm:mr-auto">
            <ToolBtn label="H2"    title="Heading 2"        onClick={() => prefixLine('## ')} disabled={isPreview} />
            <ToolBtn label="B"     title="Bold"             onClick={() => wrapSelection('**')} disabled={isPreview} bold />
            <ToolBtn label="I"     title="Italic"           onClick={() => wrapSelection('*')} disabled={isPreview} italic />
            <ToolDivider />
            <ToolBtn label="Link"  title="Insert link"      onClick={insertLink} disabled={isPreview} />
            <ToolBtn label="Image" title="Insert image"
                     onClick={() => fileInputRef.current?.click()}
                     disabled={isPreview || uploading} />
            {uploading && <span className="text-[10px] text-gray-500 ml-1">Uploading…</span>}
            <ToolDivider />
            <ToolBtn label="❝"     title="Block quote"      onClick={() => prefixLine('> ')} disabled={isPreview} />
            <ToolBtn label="•"     title="Bullet list"      onClick={() => prefixLine('- ')} disabled={isPreview} />
            <ToolBtn label="1."    title="Numbered list"    onClick={() => prefixLine('1. ')} disabled={isPreview} />
            <ToolBtn label="</>"   title="Inline code"      onClick={() => wrapSelection('`')} disabled={isPreview} mono />
          </div>

          {/* Right cluster */}
          <button
            onClick={() => setIsPreview((v) => !v)}
            className={`text-xs font-semibold px-3 py-1.5 rounded transition-colors ${
              isPreview
                ? 'bg-gray-900 text-white hover:bg-black'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
            title={isPreview ? 'Back to editing' : 'Preview as published'}
          >
            {isPreview ? 'Editing' : 'Preview'}
          </button>
          <button
            onClick={save}
            disabled={!canSave || saving}
            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded
                       bg-gray-200 text-gray-800 hover:bg-gray-300
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={onPublishToggle}
            disabled={!canSave || saving}
            className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded text-white
                        disabled:opacity-50 disabled:cursor-not-allowed ${
              status === 'published'
                ? 'bg-rose-600 hover:bg-rose-700'
                : 'bg-nw-teal hover:bg-nw-teal-dark'
            }`}
          >
            {status === 'published' ? 'Unpublish' : 'Publish'}
          </button>

          <input ref={fileInputRef} type="file"
                 accept="image/png,image/jpeg,image/webp,image/gif"
                 onChange={handleFile} className="hidden" />
        </div>

        {error && (
          <div className="bg-rose-50 border-t border-rose-200 text-rose-700 text-xs px-4 py-2">
            {error}
          </div>
        )}
      </div>

      {/* ── The "page" ─────────────────────────────────────────── */}
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="bg-white shadow-md rounded-lg overflow-hidden">
          {/* Cover image — full-bleed across the page width */}
          <CoverArea
            hero={hero}
            uploading={uploadingHero}
            onUploadClick={() => heroInputRef.current?.click()}
            onClear={() => setHero('')}
            disabled={isPreview}
          />
          <input ref={heroInputRef} type="file"
                 accept="image/png,image/jpeg,image/webp,image/gif"
                 onChange={handleHeroFile} className="hidden" />

          <div className="px-8 sm:px-12 py-8 sm:py-10">
            {isPreview ? (
              <PreviewView
                title={title} subtitle={subtitle} authorName={authorName}
                publishedAt={existing?.published_at} bodyMd={bodyMd}
              />
            ) : (
              <>
                {/* Title — borderless, looks like a real headline */}
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Article title"
                  className="w-full border-0 outline-none focus:ring-0 text-3xl sm:text-4xl font-extrabold
                             text-gray-900 leading-tight placeholder-gray-300 px-0 py-1 bg-transparent"
                />
                {/* Subtitle */}
                <input
                  type="text"
                  value={subtitle}
                  onChange={(e) => setSubtitle(e.target.value)}
                  placeholder="Optional subtitle / dek"
                  className="w-full border-0 outline-none focus:ring-0 text-lg sm:text-xl font-normal
                             text-gray-600 leading-snug placeholder-gray-300 px-0 py-1 mt-1 bg-transparent"
                />
                {/* Byline strip */}
                <div className="flex items-center gap-2 mt-3 mb-6 pb-4 border-b border-gray-200">
                  <span className="text-[11px] uppercase tracking-wider text-gray-500">By</span>
                  <input
                    type="text"
                    value={authorName}
                    onChange={(e) => setAuthorName(e.target.value)}
                    placeholder="Author name"
                    className="border-0 outline-none focus:ring-0 text-sm font-semibold text-gray-800
                               placeholder-gray-400 px-0 py-0.5 bg-transparent"
                  />
                </div>
                {/* Body — borderless, prose-styled, auto-growing */}
                <textarea
                  ref={textareaRef}
                  value={bodyMd}
                  onChange={(e) => { setBodyMd(e.target.value); autoGrow() }}
                  onFocus={autoGrow}
                  spellCheck="true"
                  placeholder="Start writing your article. Use the toolbar to format. Click Preview at any time to see how it'll look on /news."
                  className="w-full border-0 outline-none focus:ring-0 resize-none
                             text-base sm:text-[17px] leading-relaxed text-gray-800
                             placeholder-gray-300 px-0 py-1 bg-transparent
                             font-sans"
                  style={{ minHeight: '480px' }}
                />
              </>
            )}
          </div>
        </div>

        <p className="text-[11px] text-gray-400 mt-4 text-center">
          {isPreview
            ? 'Showing the article exactly as it will appear on /news. Click Editing to keep writing.'
            : 'Tip: highlight text first, then click B / I / Link to wrap your selection. Images (PNG/JPG/WebP/GIF up to 8 MB) upload to Supabase Storage and get inserted at your cursor.'}
        </p>
      </div>
    </div>
  )
}


// ── Cover image area at the top of the page ────────────────────
function CoverArea({ hero, uploading, onUploadClick, onClear, disabled }) {
  if (hero) {
    return (
      <div className="relative group">
        <img src={hero} alt="cover"
             className="w-full aspect-[16/9] object-cover bg-gray-100"
             onError={(e) => { e.currentTarget.style.display = 'none' }} />
        {!disabled && (
          <div className="absolute top-3 right-3 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={onUploadClick}
              disabled={uploading}
              className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded
                         bg-white/90 text-gray-900 hover:bg-white shadow-sm
                         disabled:opacity-60"
            >
              {uploading ? 'Uploading…' : 'Replace'}
            </button>
            <button
              type="button"
              onClick={onClear}
              className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded
                         bg-white/90 text-rose-700 hover:bg-white shadow-sm"
            >
              Remove
            </button>
          </div>
        )}
      </div>
    )
  }
  if (disabled) {
    // In preview mode with no cover, show nothing rather than an empty
    // "add cover" prompt — keeps the preview honest.
    return null
  }
  return (
    <button
      type="button"
      onClick={onUploadClick}
      disabled={uploading}
      className="w-full aspect-[16/9] bg-gradient-to-br from-gray-50 to-gray-100
                 border-b border-gray-200 flex items-center justify-center
                 hover:bg-gray-50 transition-colors disabled:opacity-60"
    >
      <div className="text-center">
        <div className="text-3xl text-gray-300 mb-1">+</div>
        <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">
          {uploading ? 'Uploading…' : 'Add cover image'}
        </div>
        <div className="text-[10px] text-gray-400 mt-1">
          Shown on the /news card and at the top of the article
        </div>
      </div>
    </button>
  )
}


// ── Read-only preview view ─────────────────────────────────────
function PreviewView({ title, subtitle, authorName, publishedAt, bodyMd }) {
  const date = publishedAt
    ? new Date(publishedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  return (
    <article>
      <h1 className="text-3xl sm:text-4xl font-extrabold text-gray-900 leading-tight">
        {title || <span className="text-gray-300">Untitled article</span>}
      </h1>
      {subtitle && (
        <p className="text-lg sm:text-xl text-gray-600 mt-2 leading-snug">{subtitle}</p>
      )}
      <p className="text-[11px] text-gray-500 mt-3 mb-6 uppercase tracking-wider pb-4 border-b border-gray-200">
        By {authorName || 'Author'} · {date}
      </p>
      <div className="markdown prose prose-sm sm:prose-base max-w-none text-gray-800">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {bodyMd || '_Nothing written yet._'}
        </ReactMarkdown>
      </div>
    </article>
  )
}


// ── Toolbar primitives ────────────────────────────────────────
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
