// Small Articles | Commitments tab strip used by both /news (Articles)
// and /news/commitments. Keeps the two news surfaces feeling like one
// section without forcing users back through the top nav.

import { NavLink } from 'react-router-dom'

const TABS = [
  { to: '/news',             label: 'Articles' },
  { to: '/news/commitments', label: 'Commitments' },
]

export default function NewsTabs({ active }) {
  // `active` is optional — NavLink's `end`+`useResolvedPath` matching
  // handles `/news` vs `/news/commitments` correctly, but explicit
  // `active` lets a page force-highlight when nested deeper.
  return (
    <div className="flex items-center gap-1 border-b border-gray-200 mb-5">
      {TABS.map(t => {
        const forceActive =
          (active === 'articles'    && t.to === '/news') ||
          (active === 'commitments' && t.to === '/news/commitments')
        return (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.to === '/news'}
            className={({ isActive }) => {
              const on = forceActive || isActive
              return `px-3 py-2 text-sm font-semibold transition-colors -mb-px border-b-2 ${
                on
                  ? 'border-nw-teal text-nw-teal'
                  : 'border-transparent text-gray-500 hover:text-gray-900'
              }`
            }}
          >
            {t.label}
          </NavLink>
        )
      })}
    </div>
  )
}
