// PreviewTierWidget — author-only "view as tier" toggle.
//
// Renders only when the signed-in user is an author (Nate). Anyone
// else sees nothing — the widget short-circuits silently.
//
// Placed on the homepage so it's the first thing the author sees on
// landing; tier selection persists in localStorage so the author can
// click around as that tier.

import { useAuth } from '../context/AuthContext'
import { usePreview, AUTHOR_EMAILS } from '../context/PreviewContext'

const TIERS = [
  { id: null,          label: 'My View',      hint: 'Your real signed-in tier' },
  { id: 'anonymous',   label: 'Anonymous',    hint: 'Signed-out visitor' },
  { id: 'free',        label: 'Free',         hint: 'Free account holder' },
  { id: 'premium',     label: 'Premium',      hint: '$5/mo subscriber' },
  { id: 'coach',       label: 'Coach',        hint: '$25/mo Coach & Scout' },
]


export default function PreviewTierWidget() {
  const { realUser } = useAuth()
  const { previewTier, setPreviewTier } = usePreview()

  const isAuthor = !!realUser?.email && AUTHOR_EMAILS.includes(realUser.email)
  if (!isAuthor) return null

  return (
    <div className="mb-5 rounded-xl border-2 border-dashed border-indigo-300 dark:border-indigo-700
                    bg-indigo-50/60 dark:bg-indigo-900/20 px-4 py-3">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
            Author Preview · Bug Hunt Mode
          </p>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
            Switch tiers to see what each kind of user sees. Persists across pages until you exit.
          </p>
        </div>
        {previewTier && (
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded
                           bg-indigo-600 text-white">
            Active: {previewTier}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {TIERS.map((t) => {
          const selected = previewTier === t.id
          return (
            <button
              key={t.id || 'me'}
              type="button"
              onClick={() => setPreviewTier(t.id)}
              title={t.hint}
              className={`px-3 py-2 rounded text-xs font-bold uppercase tracking-wider
                          border transition-colors text-left
                          ${selected
                            ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                            : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 ' +
                              'border-gray-200 dark:border-gray-700 hover:border-indigo-400 ' +
                              'hover:bg-indigo-50 dark:hover:bg-indigo-900/30'}`}
            >
              <div>{t.label}</div>
              <div className={`text-[9px] font-normal mt-0.5 normal-case tracking-normal
                               ${selected ? 'text-indigo-100' : 'text-gray-500 dark:text-gray-400'}`}>
                {t.hint}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
