// Public /news/[slug] — renders a single published article. Body is
// markdown rendered with react-markdown + GFM (tables, strikethrough,
// task lists). Headers / quotes / lists get prose-friendly Tailwind
// styling via the `markdown` className on the wrapper.

import { Link, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { usePublishedArticle } from '../hooks/useArticles'

function fmtDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    })
  } catch { return '' }
}

export default function NewsArticle() {
  const { slug } = useParams()
  const { data, loading, error } = usePublishedArticle(slug)

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="text-gray-500 animate-pulse">Loading…</div>
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <Link to="/news" className="text-sm text-nw-teal hover:underline">← All articles</Link>
        <div className="text-rose-600 mt-4">Article not found.</div>
      </div>
    )
  }

  return (
    <article className="max-w-3xl mx-auto px-4 py-8">
      <Link to="/news" className="text-sm text-nw-teal hover:underline">← All articles</Link>

      {data.hero_image_url && (
        <div className="mt-4 rounded-xl overflow-hidden bg-gray-100 aspect-[16/9]">
          <img
            src={data.hero_image_url}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => { e.currentTarget.parentElement.style.display = 'none' }}
          />
        </div>
      )}

      <header className="mt-5 mb-4 border-b border-gray-200 pb-4">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-gray-900 leading-tight">
          {data.title}
        </h1>
        {data.subtitle && (
          <p className="text-lg text-gray-600 mt-2">{data.subtitle}</p>
        )}
        <p className="text-[11px] text-gray-500 mt-3 uppercase tracking-wider">
          By {data.author_name} · {fmtDate(data.published_at)}
        </p>
      </header>

      <div className="markdown prose prose-sm sm:prose-base max-w-none text-gray-800">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {data.body_md || ''}
        </ReactMarkdown>
      </div>
    </article>
  )
}
