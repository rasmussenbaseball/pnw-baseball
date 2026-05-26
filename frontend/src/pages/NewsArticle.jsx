// Public /news/[slug] — renders a single published article. The body
// is markdown rendered with react-markdown + GFM.
//
// Paywall: each article carries a `requires_tier` ('free' / 'premium' /
// 'coach'). The backend strips body_md and sets `locked: true` for
// callers whose tier is below the requirement. When locked, we render
// title + subtitle + excerpt + a paywall card with "Sign in" / "Upgrade"
// CTAs. Soft-mode (default pre-launch) returns 'coach' for every
// viewer so locked is never set.

import { Link, useLocation, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { usePublishedArticle } from '../hooks/useArticles'
import { useAuth } from '../context/AuthContext'

function fmtDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    })
  } catch { return '' }
}

const TIER_LABELS = { free: 'Free', premium: 'Premium', coach: 'Coach & Scout' }

export default function NewsArticle() {
  const { slug } = useParams()
  const { data, loading, error } = usePublishedArticle(slug)
  const { user } = useAuth()
  const location = useLocation()

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

  const isLocked = !!data.locked
  const requiredTier = data.requires_tier || 'free'

  return (
    <article className="max-w-3xl mx-auto px-4 py-8">
      <Link to="/news" className="text-sm text-nw-teal hover:underline">← All articles</Link>

      {data.hero_image_url && (
        <div className="mt-4 rounded-xl overflow-hidden bg-gray-100 dark:bg-gray-800 aspect-[16/9]">
          <img
            src={data.hero_image_url}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => { e.currentTarget.parentElement.style.display = 'none' }}
          />
        </div>
      )}

      <header className="mt-5 mb-4 border-b border-gray-200 dark:border-gray-700 pb-4">
        <div className="flex items-center gap-2 mb-2">
          {requiredTier !== 'free' && (
            <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
              requiredTier === 'coach'
                ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300'
                : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
            }`}>
              {TIER_LABELS[requiredTier]} only
            </span>
          )}
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-gray-900 dark:text-gray-100 leading-tight">
          {data.title}
        </h1>
        {data.subtitle && (
          <p className="text-lg text-gray-600 dark:text-gray-400 mt-2">{data.subtitle}</p>
        )}
        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-3 uppercase tracking-wider">
          By {data.author_name} · {fmtDate(data.published_at)}
        </p>
      </header>

      {/* Body rendering for both states. When locked, body_md is the
          free-preview portion (everything before the author's paywall
          break, served by the backend). If no break was set, body_md
          is empty and we fall back to the excerpt. */}
      {isLocked ? (
        <>
          {data.body_md ? (
            <div className="markdown prose prose-sm sm:prose-base max-w-none text-gray-800 dark:text-gray-200 dark:prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {data.body_md}
              </ReactMarkdown>
            </div>
          ) : data.excerpt ? (
            <p className="text-base sm:text-lg text-gray-700 dark:text-gray-300 leading-relaxed mb-6 italic">
              {data.excerpt}
            </p>
          ) : null}

          {/* Decorative fade above the paywall so the preview text doesn't
              feel like it was abruptly chopped off. Only render when there's
              actual preview content above. */}
          {data.body_md && <PreviewFade />}

          <PaywallCard
            requiredTier={requiredTier}
            signedIn={!!user}
            hasPreview={!!data.body_md}
            from={location.pathname}
          />
        </>
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


// Tiny fade between the free preview text and the paywall card. Sells
// the "there's more below" feeling without being a hard hit.
function PreviewFade() {
  return (
    <div className="relative h-12 -mt-8 pointer-events-none"
         style={{
           background: 'linear-gradient(to bottom, rgba(255,255,255,0) 0%, var(--paywall-fade) 100%)',
         }}>
      <style>{`
        :root { --paywall-fade: #ffffff; }
        html.dark { --paywall-fade: #111827; }
      `}</style>
    </div>
  )
}


function PaywallCard({ requiredTier, signedIn, hasPreview, from }) {
  const label = TIER_LABELS[requiredTier] || requiredTier
  return (
    <div className="bg-gradient-to-br from-nw-teal/5 to-nw-teal/10
                    dark:from-nw-teal/15 dark:to-nw-teal/5
                    border border-nw-teal/30 rounded-2xl p-6 sm:p-8 text-center">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full
                      bg-nw-teal/10 dark:bg-nw-teal/20 text-nw-teal mb-3">
        <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round"
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
      </div>
      <h3 className="text-xl font-extrabold text-gray-900 dark:text-gray-100 mb-1">
        {hasPreview ? `Keep reading with ${label}` : `This article is for ${label} subscribers`}
      </h3>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-5 max-w-sm mx-auto">
        {hasPreview
          ? signedIn
            ? `You've read the free preview. ${label} subscribers see the full story plus every other paywalled article.`
            : `You've read the free preview. Sign in or subscribe to ${label} to read the rest and unlock every paywalled article.`
          : signedIn
            ? `Upgrade to ${label} to read this article and unlock every paywalled story.`
            : 'Sign in or subscribe to read this article and unlock every paywalled story.'}
      </p>
      <div className="flex flex-col sm:flex-row gap-2 justify-center">
        {!signedIn && (
          <Link
            to={`/login?next=${encodeURIComponent(from)}`}
            className="px-4 py-2 text-sm font-bold uppercase tracking-wider rounded
                       bg-nw-teal hover:bg-nw-teal-dark text-white transition-colors"
          >
            Sign in
          </Link>
        )}
        <Link
          to="/pricing"
          className="px-4 py-2 text-sm font-bold uppercase tracking-wider rounded
                     border border-nw-teal text-nw-teal hover:bg-nw-teal hover:text-white
                     transition-colors"
        >
          {signedIn ? `Upgrade to ${label}` : 'See plans'}
        </Link>
      </div>
    </div>
  )
}
