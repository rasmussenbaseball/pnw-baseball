/**
 * Pixelated GM-game shell. Wraps every page with:
 *   - A retro 8-bit-style header with dropdown nav
 *   - A team-home button (pixel logo)
 *   - The pixel-font family applied to all descendants
 *
 * The header REPLACES the old per-page navigation tiles. Pages just render
 * their content; the shell handles chrome.
 */

import { useState, useRef, useEffect } from 'react'
import { Link, useSearchParams, useLocation, matchPath } from 'react-router-dom'

const NAV = [
  {
    key: 'team', label: 'Team',
    items: [
      { label: 'Roster',      path: '/gm/roster' },
      { label: 'Depth Chart', path: '/gm/depth' },
      { label: 'Schedule',    path: '/gm/schedule' },
      { label: 'Standings',   path: '/gm/standings' },
    ],
  },
  {
    key: 'stats', label: 'Stats',
    items: [
      { label: 'Spring stats',  path: '/gm/stats?view=spring' },
      { label: 'Fall stats',    path: '/gm/stats?view=fall' },
      { label: 'Career stats',  path: '/gm/stats?view=career' },
      { label: 'Records',       path: '/gm/records' },
      { label: 'Academics',     path: '/gm/academics' },
    ],
  },
  {
    key: 'actions', label: 'Actions',
    items: [
      { label: 'Weekly Actions', path: '/gm/weekly' },
      { label: 'Recruiting',     path: '/gm/recruiting' },
      { label: 'Budget',         path: '/gm/budget' },
      { label: 'Staff',          path: '/gm/coaches' },
    ],
  },
  {
    key: 'extras', label: 'Extras',
    items: [
      { label: 'Calendar',     path: '/gm/calendar' },
      { label: 'Rankings',     path: '/gm/rankings' },
      { label: 'Summer Ball',  path: '/gm/summer' },
      { label: 'Postseason',   path: '/gm/postseason' },
      { label: 'Tutorial',     path: '/gm/dashboard?tutorial=1' },
    ],
  },
]

export default function GMShell({ children, schoolName, schoolColors }) {
  const [params] = useSearchParams()
  const slot = params.get('slot') || '1'
  return (
    <div className="gm-pixel-shell font-pixel min-h-screen bg-[#1a1a2e] text-[#e8e8e8]">
      {/* Subtle CRT scanlines for the retro feel */}
      <Scanlines />
      <PixelHeader slot={slot} schoolName={schoolName} schoolColors={schoolColors} />
      <main className="relative z-10 px-4 py-5 max-w-6xl mx-auto">
        {children}
      </main>
    </div>
  )
}

function PixelHeader({ slot, schoolName, schoolColors }) {
  const accent = schoolColors?.[0] || '#fbbf24'   // gold default
  return (
    <header
      className="sticky top-0 z-30 border-b-4 shadow-lg"
      style={{ borderColor: accent, backgroundColor: '#0f0f1e' }}
    >
      <div className="max-w-6xl mx-auto flex items-center gap-3 px-3 py-2">
        {/* Home button — pixel-style logo block */}
        <Link
          to={`/gm/dashboard?slot=${slot}`}
          className="flex items-center gap-2 hover:opacity-90 transition group"
          title="Back to dashboard"
        >
          <div
            className="w-9 h-9 flex items-center justify-center text-lg font-bold"
            style={{
              backgroundColor: accent,
              color: '#1a1a2e',
              boxShadow: '2px 2px 0 rgba(0,0,0,0.5)',
              imageRendering: 'pixelated',
            }}
          >
            
          </div>
          <div className="hidden md:block leading-none">
            <div
              className="font-pixel-display text-[10px] tracking-widest"
              style={{ color: accent }}
            >
              NAIA GM
            </div>
            <div className="font-pixel text-xl text-white truncate max-w-[200px]">
              {schoolName || 'Home'}
            </div>
          </div>
        </Link>

        <div className="flex-1" />

        {/* Nav: explicit Home button first, then dropdown groups */}
        <nav className="flex items-center gap-1">
          <HomeNavButton slot={slot} accent={accent} />
          {NAV.map(group => (
            <NavDropdown key={group.key} group={group} slot={slot} accent={accent} />
          ))}
        </nav>
      </div>
    </header>
  )
}

function HomeNavButton({ slot, accent }) {
  const location = useLocation()
  const isActive = location.pathname.startsWith('/gm/dashboard')
  return (
    <Link
      to={`/gm/dashboard?slot=${slot}`}
      className={
        'font-pixel-display text-[10px] tracking-widest px-3 py-2 border-2 transition ' +
        (isActive
          ? 'text-[#1a1a2e]'
          : 'border-transparent text-[#e8e8e8] hover:text-white hover:border-[#3a3a5e]')
      }
      style={isActive
        ? { backgroundColor: accent, borderColor: accent }
        : {}}
      title="Back to dashboard"
    >
      Home
    </Link>
  )
}

function NavDropdown({ group, slot, accent }) {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const ref = useRef(null)
  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])
  // Highlight if any item in this group matches current path
  const isActive = group.items.some(it => location.pathname.startsWith(it.path.split('?')[0]))
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={
          'font-pixel-display text-[10px] tracking-widest px-3 py-2 border-2 transition ' +
          (open || isActive
            ? 'text-[#1a1a2e]'
            : 'border-transparent text-[#e8e8e8] hover:text-white hover:border-[#3a3a5e]')
        }
        style={open || isActive
          ? { backgroundColor: accent, borderColor: accent }
          : {}}
      >
        {group.label}
      </button>
      {open && (
        <div
          className="absolute right-0 mt-1 w-48 border-4 shadow-xl z-50"
          style={{ borderColor: accent, backgroundColor: '#0f0f1e' }}
        >
          {group.items.map(it => {
            const sep = it.path.includes('?') ? '&' : '?'
            const to = `${it.path}${sep}slot=${slot}`
            return (
              <Link
                key={it.path + it.label}
                to={to}
                onClick={() => setOpen(false)}
                className="block font-pixel text-base px-3 py-1.5 text-[#e8e8e8] hover:text-[#1a1a2e] transition"
                onMouseEnter={e => { e.currentTarget.style.backgroundColor = accent }}
                onMouseLeave={e => { e.currentTarget.style.backgroundColor = '' }}
              >
                ▸ {it.label}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Scanlines() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-50 opacity-[0.06]"
      style={{
        background: 'repeating-linear-gradient(0deg, transparent 0, transparent 2px, #000 2px, #000 3px)',
      }}
    />
  )
}

/**
 * Reusable pixel-styled card. Stand-in for the previous rounded white cards.
 * Pass `accent` (a hex color) for the border + title chip.
 */
export function PixelCard({ children, title, accent = '#fbbf24', className = '' }) {
  return (
    <div
      className={'relative border-4 mb-4 ' + className}
      style={{
        borderColor: accent,
        backgroundColor: '#23233d',
        boxShadow: '4px 4px 0 rgba(0,0,0,0.4)',
      }}
    >
      {title && (
        <div
          className="font-pixel-display text-[10px] tracking-widest px-3 py-1.5 border-b-4"
          style={{
            backgroundColor: accent,
            color: '#1a1a2e',
            borderColor: accent,
          }}
        >
          {title}
        </div>
      )}
      <div className="p-3 text-[#e8e8e8] font-pixel text-lg">
        {children}
      </div>
    </div>
  )
}

/**
 * ContextBox — an explainer panel meant to teach the user how the page they
 * just landed on works. Collapsible (closed state remembered per-key in
 * localStorage so users who have read it once aren't pestered every visit).
 * Pop the tutorial slideshow to see them again.
 *
 * @param {object} props
 * @param {string} props.storageKey  unique key like 'recruitingHelp'
 * @param {string} props.title       "How recruiting works"
 * @param {React.ReactNode} props.children
 */
export function ContextBox({ storageKey, title, children }) {
  const lsKey = `gmHelp:${storageKey || 'box'}:open`
  const [open, setOpen] = useState(() => {
    // Default open — but once user collapses, remember
    if (typeof window === 'undefined') return true
    const v = window.localStorage.getItem(lsKey)
    return v === null ? true : v === '1'
  })
  function toggle() {
    const next = !open
    setOpen(next)
    try { window.localStorage.setItem(lsKey, next ? '1' : '0') } catch (e) {}
  }
  return (
    <div className="mb-4 bg-[#23233d] border-l-4 border-[#3a3a5e] rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-[#2a2a4a] transition"
      >
        <span className="font-pixel-display text-[11px] tracking-widest text-amber-300">
          {open ? '▾' : '▸'}  {title}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-[#a8a8c8]">
          {open ? 'Hide' : 'Show'}
        </span>
      </button>
      {open && (
        <div className="px-4 py-3 text-sm text-[#e8e8e8] font-pixel leading-relaxed border-t border-[#3a3a5e]">
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * Pixel-styled button. Chunky border, hard shadow, snappy hover.
 */
export function PixelButton({ children, onClick, accent = '#fbbf24', disabled, className = '', ...rest }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        'font-pixel-display text-[10px] tracking-widest px-3 py-2 border-4 transition ' +
        (disabled
          ? 'opacity-40 cursor-not-allowed border-gray-500 bg-gray-700 text-gray-300'
          : 'hover:translate-y-[2px] hover:shadow-none') +
        ' ' + className
      }
      style={disabled ? {} : {
        backgroundColor: accent,
        borderColor: accent,
        color: '#1a1a2e',
        boxShadow: '4px 4px 0 rgba(0,0,0,0.4)',
      }}
      {...rest}
    >
      {children}
    </button>
  )
}
