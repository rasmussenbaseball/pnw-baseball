// PreviewBanner — small persistent indicator shown on every page while
// the author is in "view as tier" preview mode. Makes it obvious that
// what's on screen is filtered, and provides a one-click exit.
//
// Renders nothing when no preview is active OR when the viewer isn't
// the author (so accidentally-set localStorage on a guest's machine
// would never produce a confusing banner).

import { useAuth } from '../context/AuthContext'
import { usePreview, AUTHOR_EMAILS } from '../context/PreviewContext'

export default function PreviewBanner() {
  const { realUser } = useAuth()
  const { previewTier, exitPreview } = usePreview()

  const isAuthor = !!realUser?.email && AUTHOR_EMAILS.includes(realUser.email)
  if (!isAuthor || !previewTier) return null

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60]
                 flex items-center gap-3 px-3 py-2 rounded-full shadow-lg
                 bg-indigo-600 text-white text-xs font-bold tracking-wider
                 ring-2 ring-white/30"
    >
      <span aria-hidden className="inline-block w-2 h-2 rounded-full bg-amber-300 animate-pulse" />
      <span className="uppercase">Viewing as: {previewTier}</span>
      <button
        type="button"
        onClick={exitPreview}
        className="ml-1 px-2 py-1 rounded text-[10px] uppercase
                   bg-white/15 hover:bg-white/30 transition-colors"
      >
        Exit preview
      </button>
    </div>
  )
}
