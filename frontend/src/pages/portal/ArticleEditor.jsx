// /articles/new and /articles/edit/:id —
// markdown editor with toolbar (B/I/H2/Link/Image/Quote/List/Code) and
// a live preview pane. Image uploads go through the backend
// /portal/articles/upload-image endpoint, which writes to the
// `article-images` Supabase Storage bucket and returns a public URL —
// the URL is inserted at the cursor as `![filename](url)`.

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
  const [status, setStatus] = useState('draft')
  const [savedSlug, setSavedSlug] = useState(null)
  const [error, setError] = useState(null)

  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)
  const heroInputRef = useRef(null)
  const [uploadingHero, setUploadingHero] = useState(false)

  useEffect(() => {
    if (!existing) return
    setTitle(existing.title || '')
    setSubtitle(existing.subtitle || '')
    setBodyMd(existing.body_md || '')
    setHero(existing.hero_image_url || '')
    setAuthorName(existing.author_name || '')
    setStatus(existing.status || 'draft')
    setSavedSlug(existing.slug || null)
  }, [existing])

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

  // ── Toolbar helpers ──────────────────────────────────────────
  // All operate on textarea selection so the cursor lands somewhere
  // predictable after the insert.

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
    const md = `[${text}](${url})`
    insertAtCursor(md)
  }

  // Shared upload helper — POST a file to the article-images bucket via
  // the backend and return { url, path, filename }. Throws on failure.
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

  // Body-image upload — inserts a markdown image at the cursor.
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

  // Hero-image upload — sets the cover image shown on /news and at the
  // top of /news/[slug]. Same backend endpoint as body images.
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
      }
      const saved = editId
        ? await update(editId, payload)
        : await create(payload)
      setSavedSlug(saved.slug)
      setStatus(saved.status)
      if (isNew) {
        navigate(`/articles/edit/${saved.id}`, { replace: true })
      }
    } catch (e) {
      setError(e.message || 'Save failed.')
    } finally {
      setSaving(false)
    }
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
    <div className="max-w-5xl mx-auto px-4 py-5">
      {/* Header */}
      <div className="flex items-baseline justify-between mb-4 gap-2 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            {isNew ? 'New Article' : 'Edit Article'}
          </h1>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {status === 'published' ? 'Published' : status === 'archived' ? 'Archived' : 'Draft'}
            {savedSlug && status === 'published' && (
              <> · <a href={`/news/${savedSlug}`} target="_blank" rel="noreferrer"
                       className="text-nw-teal hover:underline">/news/{savedSlug}</a></>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/articles')}
            className="text-xs font-semibold text-gray-600 hover:text-gray-900 px-3 py-2"
          >
            ← My Articles
          </button>
          <button
            onClick={save}
            disabled={!canSave || saving}
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                       bg-gray-200 text-gray-800 hover:bg-gray-300
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={onPublishToggle}
            disabled={!canSave || saving}
            className={`px-4 py-2 text-xs font-bold uppercase tracking-wider rounded text-white
                        disabled:opacity-50 disabled:cursor-not-allowed ${
              status === 'published'
                ? 'bg-rose-600 hover:bg-rose-700'
                : 'bg-nw-teal hover:bg-nw-teal-dark'
            }`}
          >
            {status === 'published' ? 'Unpublish' : 'Publish'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3 py-2 rounded mb-3">
          {error}
        </div>
      )}

      {/* Bio / hero fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <div className="md:col-span-2">
          <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-600 mb-1">Title</label>
          <input
            type="text" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Headline"
            className="w-full rounded border border-gray-300 px-3 py-2 text-base font-bold"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-600 mb-1">Subtitle (optional)</label>
          <input
            type="text" value={subtitle} onChange={(e) => setSubtitle(e.target.value)}
            placeholder="One-line dek"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-600 mb-1">Author name</label>
          <input
            type="text" value={authorName} onChange={(e) => setAuthorName(e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-600 mb-1">
            Cover image (shown on /news)
          </label>
          <div className="flex items-stretch gap-3">
            {/* Preview */}
            <div className="w-32 h-20 rounded border border-gray-300 bg-gray-50 overflow-hidden shrink-0">
              {hero ? (
                <img src={hero} alt="cover"
                     className="w-full h-full object-cover"
                     onError={(e) => { e.currentTarget.style.display = 'none' }} />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-400">
                  No cover yet
                </div>
              )}
            </div>
            {/* Actions + URL field */}
            <div className="flex-1 min-w-0 flex flex-col justify-between">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => heroInputRef.current?.click()}
                  disabled={uploadingHero}
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded
                             bg-nw-teal text-white hover:bg-nw-teal-dark
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {uploadingHero ? 'Uploading…' : (hero ? 'Replace photo' : 'Upload photo')}
                </button>
                {hero && (
                  <button
                    type="button"
                    onClick={() => setHero('')}
                    className="text-[11px] font-semibold text-rose-600 hover:underline px-2"
                  >
                    Remove
                  </button>
                )}
              </div>
              <input
                type="url"
                value={hero}
                onChange={(e) => setHero(e.target.value)}
                placeholder="…or paste an image URL"
                className="w-full rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-600"
              />
            </div>
            <input
              ref={heroInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={handleHeroFile}
              className="hidden"
            />
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 flex-wrap mb-0 bg-gray-50 border border-gray-300 border-b-0 rounded-t px-2 py-1.5">
        <ToolBtn label="H2"    title="Heading 2"        onClick={() => prefixLine('## ')} />
        <ToolBtn label="B"     title="Bold (wraps **)"  onClick={() => wrapSelection('**')} bold />
        <ToolBtn label="I"     title="Italic (wraps *)" onClick={() => wrapSelection('*')} italic />
        <ToolDivider />
        <ToolBtn label="Link"  title="Insert link"      onClick={insertLink} />
        <ToolBtn label="Image" title="Upload an image"
                 onClick={() => fileInputRef.current?.click()}
                 disabled={uploading} />
        {uploading && <span className="text-[11px] text-gray-500 ml-1">Uploading…</span>}
        <ToolDivider />
        <ToolBtn label="❝"     title="Block quote"      onClick={() => prefixLine('> ')} />
        <ToolBtn label="•"     title="Bullet list"      onClick={() => prefixLine('- ')} />
        <ToolBtn label="1."    title="Numbered list"    onClick={() => prefixLine('1. ')} />
        <ToolBtn label="</>"   title="Inline code"      onClick={() => wrapSelection('`')} mono />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={handleFile}
          className="hidden"
        />
      </div>

      {/* Markdown editor + live preview */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <textarea
            ref={textareaRef}
            value={bodyMd}
            onChange={(e) => setBodyMd(e.target.value)}
            spellCheck="true"
            placeholder="Write your article in Markdown.

Use the toolbar above to add headings, bold, links, and images.
Select text first, then click Bold / Italic / Link to wrap your selection."
            className="w-full h-[60vh] rounded-b border border-gray-300 border-t-0 px-3 py-2 text-sm font-mono leading-relaxed"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-600 mb-1">
            Preview
          </label>
          <div className="markdown prose prose-sm max-w-none h-[60vh] overflow-y-auto rounded border border-gray-200 px-3 py-2 bg-white">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {bodyMd || '_Nothing to preview yet — start typing on the left._'}
            </ReactMarkdown>
          </div>
        </div>
      </div>

      <p className="text-[11px] text-gray-400 mt-3">
        Image uploads (PNG / JPG / WebP / GIF, up to 8 MB) go to Supabase Storage and
        the public URL is inserted at your cursor as a markdown image.
      </p>
    </div>
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
                  disabled:opacity-40 disabled:cursor-not-allowed
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
