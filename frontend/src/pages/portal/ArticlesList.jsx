// Portal /portal/articles — the author's article shelf.
//
// Shows every article authored by the current user (draft / published /
// archived) with quick actions: open editor, publish/unpublish, archive.
// Sits behind RequirePortalAccess, so any logged-in portal user reaches it.

import { Link, useNavigate } from 'react-router-dom'
import { useMyArticles, useArticleMutations } from '../../hooks/useArticles'

function fmtDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    })
  } catch { return '' }
}

const STATUS_TONE = {
  draft:     'bg-gray-200 text-gray-700',
  published: 'bg-emerald-100 text-emerald-800',
  archived:  'bg-rose-100 text-rose-700',
}

export default function ArticlesList() {
  const { data, loading, refetch } = useMyArticles()
  const { togglePublish, archive } = useArticleMutations()
  const navigate = useNavigate()
  const articles = data?.articles || []

  const onTogglePublish = async (a) => {
    const wantPublish = a.status !== 'published'
    try {
      await togglePublish(a.id, wantPublish)
      refetch()
    } catch (e) { alert(`Could not change status: ${e.message}`) }
  }
  const onArchive = async (a) => {
    if (!confirm(`Archive "${a.title}"? It will be hidden from /news but kept in the database.`)) return
    try { await archive(a.id); refetch() }
    catch (e) { alert(`Could not archive: ${e.message}`) }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-baseline justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-portal-purple-dark">My Articles</h1>
          <p className="text-xs text-gray-500 mt-1">
            Drafts and published posts you've written.
          </p>
        </div>
        <button
          onClick={() => navigate('/portal/articles/new')}
          className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                     bg-portal-purple text-portal-cream hover:bg-portal-purple-dark"
        >
          + New Article
        </button>
      </div>

      {loading && <div className="text-gray-500 animate-pulse">Loading…</div>}

      {!loading && articles.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-sm text-gray-500">
          You haven't written any articles yet. Click <span className="font-semibold">+ New Article</span> to start.
        </div>
      )}

      <div className="space-y-2">
        {articles.map(a => (
          <div key={a.id} className="bg-white border border-gray-200 rounded-lg p-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${STATUS_TONE[a.status] || STATUS_TONE.draft}`}>
                  {a.status}
                </span>
                <span className="text-[11px] text-gray-500">
                  {a.status === 'published' ? `Published ${fmtDate(a.published_at)}` : `Updated ${fmtDate(a.updated_at)}`}
                </span>
              </div>
              <Link
                to={`/portal/articles/edit/${a.id}`}
                className="text-sm font-bold text-gray-900 hover:text-portal-purple block truncate"
              >
                {a.title || <span className="italic text-gray-400">Untitled draft</span>}
              </Link>
              {a.subtitle && (
                <p className="text-[12px] text-gray-500 truncate mt-0.5">{a.subtitle}</p>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {a.status === 'published' && (
                <Link
                  to={`/news/${a.slug}`}
                  className="text-[11px] font-semibold text-nw-teal hover:underline px-2 py-1"
                >
                  View
                </Link>
              )}
              <button
                onClick={() => onTogglePublish(a)}
                className="text-[11px] font-semibold text-portal-purple hover:underline px-2 py-1"
              >
                {a.status === 'published' ? 'Unpublish' : 'Publish'}
              </button>
              <button
                onClick={() => onArchive(a)}
                className="text-[11px] font-semibold text-rose-600 hover:underline px-2 py-1"
                disabled={a.status === 'archived'}
              >
                Archive
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
