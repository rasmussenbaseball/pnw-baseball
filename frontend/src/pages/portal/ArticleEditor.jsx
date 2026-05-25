// Portal /portal/articles/new and /portal/articles/edit/:id —
// markdown editor with live preview.
//
// Layout: title + subtitle + hero URL fields up top, then a two-pane
// split (markdown textarea on the left, rendered preview on the right).
// Bottom action bar: Save Draft / Save / Publish / Unpublish.
// Author name defaults to the user's email local-part on first create
// (the user can override).

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAuth } from '../../context/AuthContext'
import { useMyArticle, useArticleMutations } from '../../hooks/useArticles'

export default function ArticleEditor() {
  const { id } = useParams()
  const editId = id ? parseInt(id, 10) : null
  const isNew = !editId
  const navigate = useNavigate()
  const { user } = useAuth()

  // Existing article (when editing).
  const { data: existing, loading } = useMyArticle(editId)
  const { create, update, togglePublish } = useArticleMutations()

  // Form state.
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [bodyMd, setBodyMd] = useState('')
  const [hero, setHero] = useState('')
  const [authorName, setAuthorName] = useState('')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('draft')
  const [savedSlug, setSavedSlug] = useState(null)
  const [error, setError] = useState(null)

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
  }, [existing])

  // Sensible default for author_name on a brand-new article.
  useEffect(() => {
    if (isNew && !authorName && user?.email) {
      const local = user.email.split('@')[0]
      // Title-case the email local-part as a friendly starting point.
      setAuthorName(local.replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
    }
  }, [isNew, user, authorName])

  const canSave = useMemo(() => title.trim().length > 0 && authorName.trim().length > 0, [title, authorName])

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
        // Slide into edit mode for the freshly-created article so subsequent
        // saves keep updating the same row.
        navigate(`/portal/articles/edit/${saved.id}`, { replace: true })
      }
    } catch (e) {
      setError(e.message || 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const onPublishToggle = async () => {
    if (!editId) {
      // For a brand-new article, save first then publish.
      await save()
      return
    }
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
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-portal-purple-dark">
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
            onClick={() => navigate('/portal/articles')}
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
            className={`px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                        text-portal-cream
                        disabled:opacity-50 disabled:cursor-not-allowed ${
              status === 'published'
                ? 'bg-rose-600 hover:bg-rose-700'
                : 'bg-portal-purple hover:bg-portal-purple-dark'
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
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-600 mb-1">Hero image URL (optional)</label>
          <input
            type="url" value={hero} onChange={(e) => setHero(e.target.value)}
            placeholder="https://…"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
      </div>

      {/* Markdown editor + live preview */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-600 mb-1">
            Body (Markdown)
          </label>
          <textarea
            value={bodyMd}
            onChange={(e) => setBodyMd(e.target.value)}
            spellCheck="true"
            placeholder="Write your article in Markdown.

# Heading
## Subheading

Regular paragraph text. **Bold**, *italics*, [links](https://nwbaseballstats.com).

- Bullet
- Bullet

> Quoted line

Inline `code` and code blocks are supported."
            className="w-full h-[60vh] rounded border border-gray-300 px-3 py-2 text-sm font-mono leading-relaxed"
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
        Markdown supports headings, bold/italic, links, lists, quotes, tables, code blocks, and inline code.
        Hero images and inline images can be pasted in as URLs for now.
      </p>
    </div>
  )
}
