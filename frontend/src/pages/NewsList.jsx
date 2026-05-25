// Public /news index — newest published articles first.
//
// Card grid: hero image (if set) + title + subtitle + author/date.
// Click a card to open /news/[slug]. Empty/loading states handled inline.

import { Link } from 'react-router-dom'
import { usePublishedArticles } from '../hooks/useArticles'

function fmtDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    })
  } catch { return '' }
}

export default function NewsList() {
  const { data, loading, error } = usePublishedArticles(50)
  const articles = data?.articles || []

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">News</h1>
        <p className="text-sm text-gray-500 mt-1">
          Stories, recaps, and notes from around PNW college baseball.
        </p>
      </div>

      {loading && (
        <div className="text-gray-500 animate-pulse">Loading articles…</div>
      )}
      {error && (
        <div className="text-rose-600">Could not load articles: {error}</div>
      )}
      {!loading && !error && articles.length === 0 && (
        <div className="text-gray-500 italic">No articles yet.</div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {articles.map(a => (
          <Link
            key={a.id}
            to={`/news/${a.slug}`}
            className="group rounded-xl overflow-hidden bg-white border border-gray-200
                       hover:border-nw-teal hover:shadow-md transition-all"
          >
            {a.hero_image_url ? (
              <div className="aspect-[16/9] bg-gray-100 overflow-hidden">
                <img
                  src={a.hero_image_url}
                  alt=""
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  onError={(e) => { e.currentTarget.style.display = 'none' }}
                />
              </div>
            ) : (
              <div className="aspect-[16/9] bg-gradient-to-br from-pnw-teal/10 to-pnw-teal/5
                              flex items-center justify-center text-pnw-teal/60 text-sm font-bold">
                NW Baseball Stats
              </div>
            )}
            <div className="p-4">
              <h2 className="text-base font-bold text-gray-900 group-hover:text-nw-teal leading-snug line-clamp-2">
                {a.title}
              </h2>
              {a.subtitle && (
                <p className="text-sm text-gray-600 mt-1 line-clamp-2">{a.subtitle}</p>
              )}
              <p className="text-[11px] text-gray-500 mt-2 uppercase tracking-wider">
                {a.author_name} · {fmtDate(a.published_at)}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
