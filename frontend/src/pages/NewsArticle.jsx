// Public /news/[slug] — renders a single published article. The body
// is markdown (or rich HTML) rendered for every viewer; no paywall.

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
        <div className="text-gray-500 dark:text-gray-400 animate-pulse">Loading…</div>
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <Link to="/news" className="text-sm text-nw-teal hover:underline">← All articles</Link>
        <div className="text-rose-600 dark:text-rose-400 mt-4">Article not found.</div>
      </div>
    )
  }


  return (
    <article className="max-w-3xl mx-auto px-4 py-8">
      <Link to="/news" className="text-sm text-nw-teal hover:underline">← All articles</Link>

      {data.hero_image_url && (
        // Cover renders at its native aspect ratio (centered, with a
        // soft gray panel behind for any letterbox space). Lets square,
        // banner, and portrait covers all display without being cropped.
        // max-h cap prevents very tall portraits from dominating the page.
        <div className="mt-4 rounded-xl overflow-hidden bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
          <img
            src={data.hero_image_url}
            alt=""
            className="max-w-full max-h-[640px] w-auto h-auto object-contain"
            onError={(e) => { e.currentTarget.parentElement.style.display = 'none' }}
          />
        </div>
      )}

      <header className="mt-5 mb-4 border-b border-gray-200 dark:border-gray-700 pb-4">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-gray-900 dark:text-gray-100 leading-tight">
          {data.title}
        </h1>
        {data.subtitle && (
          <p className="text-lg text-gray-600 dark:text-gray-400 mt-2">{data.subtitle}</p>
        )}
        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-3 uppercase tracking-wider">
          NW Baseball Stats · {fmtDate(data.published_at)}
        </p>
      </header>

      {data.body_html ? (
        <div className="markdown prose prose-sm sm:prose-base max-w-none text-gray-800 dark:text-gray-200 dark:prose-invert"
             dangerouslySetInnerHTML={{ __html: data.body_html }} />
      ) : (
        <div className="markdown prose prose-sm sm:prose-base max-w-none text-gray-800 dark:text-gray-200 dark:prose-invert">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {data.body_md || ''}
          </ReactMarkdown>
        </div>
      )}
    </article>
  )
}
