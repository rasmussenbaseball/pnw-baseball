/**
 * Pixelated GM-game shell. Wraps every page with:
 *   - A retro 8-bit-style header with dropdown nav
 *   - A team-home button (pixel logo)
 *   - The pixel-font family applied to all descendants
 *
 * The header REPLACES the old per-page navigation tiles. Pages just render
 * their content; the shell handles chrome.
 */

import { useState, useRef, useEffect, Component } from 'react'
import { Link, useSearchParams, useLocation, useNavigate, matchPath } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../engine/save'
import { applyTeamTheme, clearTeamTheme } from '../lib/teamTheme'
import { Sentry } from '../../lib/sentry'

/**
 * Catches render-time crashes on any GM page so the user gets a recoverable
 * message + the actual error text (for reporting) instead of a blank white
 * screen. Without this, one bad render anywhere nukes the whole app.
 */
class GMErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    // Surface in the console for debugging.
    console.error('GM page crashed:', error, info?.componentStack)
    // Also forward to Sentry with the component stack — without this,
    // the top-level Sentry.ErrorBoundary never sees the error (this
    // boundary catches first), and Sentry alerts come through with a
    // useless "Error: No error message". Reported by Zack: the prod
    // JAVASCRIPT-REACT-8/9 alerts had no actionable detail.
    try {
      // React's componentDidCatch can hand back a non-Error throw (e.g.
      // `throw undefined`, `throw 'string'`, or a Promise rejection that
      // bubbled). In that case `error.message` is undefined and Sentry
      // groups the event with the opaque "No error message" headline.
      // Wrap non-Error throws in a synthetic Error so the alert always
      // names a component + value.
      let reportable = error
      if (!(error instanceof Error)) {
        const msg = `Non-Error thrown in GM page: ${
          error === undefined ? 'undefined' :
          error === null ? 'null' :
          (typeof error === 'object' ? JSON.stringify(error).slice(0, 200) : String(error))
        }`
        reportable = new Error(msg)
      }
      // Pull the deepest component name from the stack — surfaces in
      // Sentry's fingerprint so issues group per-component instead of
      // collapsing all GM crashes into one bucket.
      const compStack = info?.componentStack || ''
      const firstComp = (compStack.match(/^\s*at\s+(\w+)/m) || compStack.match(/^\s*in\s+(\w+)/m) || [])[1] || 'unknown'
      Sentry.captureException(reportable, {
        contexts: {
          react: { componentStack: compStack || '(none)' },
          gm: {
            location: typeof window !== 'undefined' ? window.location.pathname + window.location.search : '(ssr)',
            originalThrowType: error === undefined ? 'undefined' : (error === null ? 'null' : typeof error),
          },
        },
        tags: {
          gmBoundary: 'GMErrorBoundary',
          gmCrashComponent: firstComp,
        },
      })
    } catch { /* Sentry no-ops when uninitialized; never let reporting itself throw */ }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="max-w-2xl mx-auto mt-10 p-5 border-4 border-red-500 rounded bg-[#2a1a2e]">
          <div className="font-pixel-display text-sm tracking-widest text-red-400 mb-2">THIS PAGE HIT AN ERROR</div>
          <p className="font-pixel text-sm text-[#e8e8e8] mb-3">
            Something broke while rendering this page. Your dynasty save is fine — head back to the
            dashboard. If this keeps happening, send over the error text below.
          </p>
          <pre className="text-[11px] text-red-300 bg-black/40 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap">
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <div className="flex gap-2 mt-3">
            <a href="/gm" className="bg-team-accent text-team-accent-fg font-pixel-display text-[10px] tracking-widest uppercase px-3 py-2 rounded">
              ← GM Home
            </a>
            <button
              onClick={() => this.setState({ error: null })}
              className="border-2 border-[#3a3a5e] text-[#e8e8e8] font-pixel-display text-[10px] tracking-widest uppercase px-3 py-2 rounded"
            >
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

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
      { label: 'Season stats',   path: '/gm/stats?view=spring' },
      { label: 'Career stats',   path: '/gm/stats?view=career' },
      { label: 'Team stats',     path: '/gm/teamstats' },
      { label: 'Records',        path: '/gm/records' },
      { label: 'Academics',      path: '/gm/academics' },
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
      { label: 'Career',       path: '/gm/career' },   // story-mode trajectory + offers
      { label: 'Tutorial',     path: '/gm/dashboard?tutorial=1' },
    ],
  },
]

export default function GMShell({ children, schoolName, schoolColors }) {
  const [params] = useSearchParams()
  const slot = params.get('slot') || '1'
  const location = useLocation()
  const accent = 'var(--team-accent, #fbbf24)'
  const { user } = useAuth()
  // Apply the user's team theme as CSS variables on every GM page so
  // the entire experience (buttons, accents, hero gradients) picks up
  // their school colors via the rewired Tailwind aliases. Cleared on
  // unmount so the main site reverts to NW teal. Per Nate, May 2026.
  useEffect(() => {
    try {
      const save = loadDynasty(user?.id || 'guest', parseInt(slot, 10))
      if (save?.userSchoolId) applyTeamTheme(save.userSchoolId)
      else clearTeamTheme()
    } catch (e) { clearTeamTheme() }
    return () => clearTeamTheme()
  }, [user?.id, slot])
  // Hide the back-strip on the dashboard (it IS the home) and on the
  // top-level GM landing. Everywhere else it gives a 1-tap escape.
  const showBackStrip = location.pathname !== '/gm' && !location.pathname.startsWith('/gm/dashboard')
  return (
    <div className="gm-pixel-shell font-pixel min-h-screen bg-[#1a1a2e] text-[#e8e8e8]">
      {/* Subtle CRT scanlines for the retro feel */}
      <Scanlines />
      <PixelHeader slot={slot} schoolName={schoolName} schoolColors={schoolColors} />
      {showBackStrip && <BackStrip slot={slot} accent={accent} />}
      <main className="relative z-10 px-3 sm:px-4 py-4 sm:py-5 max-w-6xl mx-auto">
        <GMErrorBoundary>{children}</GMErrorBoundary>
      </main>
      <ToastContainer />
    </div>
  )
}

/**
 * Slim back / home strip under the header. Two pixel chips: one runs the
 * browser back stack (so users can return to whatever they were on before),
 * the other jumps to Dashboard. Hidden on the dashboard + GM home pages.
 */
function BackStrip({ slot, accent }) {
  const navigate = useNavigate()
  return (
    <div className="border-b border-[#3a3a5e] bg-[#0f0f1e]">
      <div className="max-w-6xl mx-auto flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          onClick={() => {
            // Fallback to dashboard if there's no history (e.g. landed directly)
            if (window.history.length > 1) navigate(-1)
            else navigate(`/gm/dashboard?slot=${slot}`)
          }}
          className="font-pixel-display text-[9px] tracking-widest px-2.5 py-1.5 border-2 border-[#3a3a5e] text-[#a8a8c8] hover:text-white hover:border-[#a8a8c8] transition"
          title="Back to previous page"
        >
          ← BACK
        </button>
        <Link
          to={`/gm/dashboard?slot=${slot}`}
          className="font-pixel-display text-[9px] tracking-widest px-2.5 py-1.5 border-2 text-[#1a1a2e] hover:opacity-90"
          style={{ backgroundColor: accent, borderColor: accent }}
          title="Back to Dashboard"
        >
          ⌂ HOME
        </Link>
      </div>
    </div>
  )
}

/**
 * In-app pixel-themed toast system. Pages dispatch a custom event with
 * `gmToast(msg, level)` instead of calling the native `alert()` (which
 * looks broken on /gm/* and pulls focus out of the pixel theme). The
 * container listens, queues, and auto-dismisses after a few seconds.
 *
 * Levels: 'info' (default), 'warn', 'success', 'error'.
 * Usage:    import { gmToast } from '../../gm/components/GMShell'
 *           gmToast('Not enough AP', 'warn')
 */
export function gmToast(message, level = 'info') {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('gm:toast', { detail: { message, level } }))
}

function ToastContainer() {
  const [toasts, setToasts] = useState([])
  useEffect(() => {
    function onToast(e) {
      const id = Math.random().toString(36).slice(2, 9)
      const t = { id, message: e.detail.message, level: e.detail.level || 'info' }
      setToasts(prev => [...prev, t])
      // Errors stick around longer so the user can read them.
      const ttl = t.level === 'error' ? 7000 : t.level === 'warn' ? 5000 : 3500
      setTimeout(() => {
        setToasts(prev => prev.filter(x => x.id !== id))
      }, ttl)
    }
    window.addEventListener('gm:toast', onToast)
    return () => window.removeEventListener('gm:toast', onToast)
  }, [])
  if (toasts.length === 0) return null
  const palette = {
    info:    { bg: '#1a1a2e', border: '#fbbf24', text: '#fef3c7' },
    success: { bg: '#0f2e1a', border: '#34d399', text: '#a7f3d0' },
    warn:    { bg: '#2e1a0a', border: '#f59e0b', text: '#fed7aa' },
    error:   { bg: '#2e0a0a', border: '#ef4444', text: '#fecaca' },
  }
  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-[120] flex flex-col gap-2 max-w-[92vw] w-[480px]">
      {toasts.map(t => {
        const p = palette[t.level] || palette.info
        return (
          <div
            key={t.id}
            role="status"
            aria-live="polite"
            className="font-pixel text-sm px-3 py-2 border-2 shadow-lg cursor-pointer animate-[fadeIn_0.15s_ease-out]"
            style={{ backgroundColor: p.bg, borderColor: p.border, color: p.text }}
            onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
          >
            {t.message}
          </div>
        )
      })}
    </div>
  )
}

function PixelHeader({ slot, schoolName, schoolColors }) {
  // Header accent now reads from the team theme (set by applyTeamTheme on
  // mount). Falls back to the legacy gold when no team is themed.
  const accent = 'var(--team-accent, #fbbf24)'
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [reportBugOpen, setReportBugOpen] = useState(false)
  return (
    <header
      className="sticky top-0 z-30 border-b-4 shadow-lg"
      style={{ borderColor: accent, backgroundColor: '#0f0f1e' }}
    >
      <div className="max-w-6xl mx-auto flex items-center gap-2 sm:gap-3 px-3 py-2">
        {/* Home button — branding wordmark, no placeholder square */}
        <Link
          to={`/gm/dashboard?slot=${slot}`}
          className="flex items-center hover:opacity-90 transition group min-w-0"
          title="Back to dashboard"
        >
          <div className="leading-none min-w-0">
            <div
              className="hidden sm:flex items-center gap-1.5 font-pixel-display text-[10px] tracking-widest"
              style={{ color: accent }}
            >
              <span>NW COACHING SIM</span>
            </div>
            <div
              className="font-pixel text-sm sm:text-lg md:text-xl text-white truncate max-w-[140px] sm:max-w-[200px] md:max-w-[260px]"
              title={schoolName || 'Home'}
            >
              {schoolName || 'Home'}
            </div>
          </div>
        </Link>

        <div className="flex-1" />

        {/* Themed back-to-main-site link — pixel chip styled to match. Only
            shown on sm+. On xs it lives inside the hamburger menu. */}
        <a
          href="/"
          title="Return to NW Baseball Stats main site"
          className="hidden sm:inline-block font-pixel-display text-[9px] tracking-widest px-2.5 py-1.5 border-2 text-[#a8a8c8] hover:text-white hover:border-[#a8a8c8] transition"
          style={{ borderColor: '#3a3a5e' }}
        >
          ← MAIN SITE
        </a>

        {/* Report-a-bug entry point — opens a modal with our contact info. */}
        <button
          type="button"
          onClick={() => setReportBugOpen(true)}
          title="Report a bug or share feedback"
          className="hidden sm:inline-block font-pixel-display text-[9px] tracking-widest px-2.5 py-1.5 border-2 text-amber-200 hover:text-amber-100 hover:border-amber-200 transition"
          style={{ borderColor: '#7a5d1a' }}
        >
          🐛 REPORT BUG
        </button>

        {/* Desktop nav (sm and up) */}
        <nav className="hidden sm:flex items-center gap-1">
          <HomeNavButton slot={slot} accent={accent} />
          {NAV.map(group => (
            <NavDropdown key={group.key} group={group} slot={slot} accent={accent} />
          ))}
        </nav>

        {/* Mobile hamburger (xs only) */}
        <button
          type="button"
          onClick={() => setMobileNavOpen(o => !o)}
          aria-label="Open menu"
          aria-expanded={mobileNavOpen}
          className="sm:hidden flex flex-col gap-1 p-2 border-2"
          style={{ borderColor: accent }}
        >
          <span className="block w-5 h-0.5" style={{ backgroundColor: accent }} />
          <span className="block w-5 h-0.5" style={{ backgroundColor: accent }} />
          <span className="block w-5 h-0.5" style={{ backgroundColor: accent }} />
        </button>
      </div>

      {/* Mobile nav panel */}
      {mobileNavOpen && (
        <div
          className="sm:hidden border-t-2 px-3 py-3 space-y-3 max-h-[80vh] overflow-y-auto"
          style={{ borderColor: accent, backgroundColor: '#0f0f1e' }}
        >
          <Link
            to={`/gm/dashboard?slot=${slot}`}
            onClick={() => setMobileNavOpen(false)}
            className="block font-pixel-display text-[11px] tracking-widest px-3 py-2 border-2 text-white"
            style={{ borderColor: accent }}
          >
            ▸ HOME
          </Link>
          {NAV.map(group => (
            <div key={group.key} className="space-y-1">
              <div
                className="font-pixel-display text-[10px] tracking-widest"
                style={{ color: accent }}
              >
                {group.label.toUpperCase()}
              </div>
              {group.items.map(it => {
                const sep = it.path.includes('?') ? '&' : '?'
                const to = `${it.path}${sep}slot=${slot}`
                return (
                  <Link
                    key={it.path + it.label}
                    to={to}
                    onClick={() => setMobileNavOpen(false)}
                    className="block font-pixel text-sm pl-3 py-1.5 text-[#e8e8e8] hover:text-white"
                  >
                    ▸ {it.label}
                  </Link>
                )
              })}
            </div>
          ))}
          {/* Themed back-to-main-site at bottom of mobile menu */}
          <div className="pt-3 border-t-2 space-y-2" style={{ borderColor: '#3a3a5e' }}>
            <button
              type="button"
              onClick={() => { setReportBugOpen(true); setMobileNavOpen(false) }}
              className="block w-full text-left font-pixel-display text-[10px] tracking-widest pl-3 py-2 text-amber-200 hover:text-amber-100"
            >
              🐛 REPORT BUG
            </button>
            <a
              href="/"
              onClick={() => setMobileNavOpen(false)}
              className="block font-pixel-display text-[10px] tracking-widest pl-3 py-2 text-[#a8a8c8] hover:text-white"
            >
              ← MAIN SITE
            </a>
          </div>
        </div>
      )}
      {reportBugOpen && <ReportBugModal onClose={() => setReportBugOpen(false)} />}
    </header>
  )
}

/**
 * Report-a-bug modal — points users at email + socials so we can squash
 * issues faster than waiting for them to land in Sentry. No form submission
 * (would need a backend route); copy is intentionally specific about what
 * info to include so the report we DO get is actually actionable.
 */
function ReportBugModal({ onClose }) {
  useModalDismiss(onClose)
  return (
    <div
      className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center px-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#0f0f1e] border-4 max-w-md w-full p-6 shadow-2xl"
        style={{ borderColor: 'var(--team-accent, #fbbf24)' }}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="font-pixel-display text-[10px] tracking-widest text-amber-300 mb-1">
              REPORT A BUG
            </div>
            <h2 className="font-pixel text-xl text-white">Found something off?</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[#a8a8c8] hover:text-white text-2xl leading-none"
          >
            ×
          </button>
        </div>

        <p className="text-sm text-[#e8e8e8] mb-4 leading-relaxed">
          Help us squash it. Send a short note describing what you saw and
          we'll look into it.
        </p>

        <div className="space-y-3 mb-4">
          <a
            href="mailto:info@nwbaseballstats.com?subject=NW%20Coaching%20Sim%20bug%20report&body=Level%3A%20%0ADynasty%20year%3A%20%0AWhat%20happened%3A%20%0AWhat%20you%20expected%3A%20"
            className="block bg-[#1a1a2e] border-2 border-[#3a3a5e] hover:border-amber-300 p-3 transition"
          >
            <div className="font-pixel-display text-[9px] tracking-widest text-amber-300">EMAIL US</div>
            <div className="font-pixel text-sm text-white mt-1">info@nwbaseballstats.com</div>
          </a>
          <div className="bg-[#1a1a2e] border-2 border-[#3a3a5e] p-3">
            <div className="font-pixel-display text-[9px] tracking-widest text-amber-300">DM US ON SOCIALS</div>
            <div className="font-pixel text-sm text-[#e8e8e8] mt-1">
              @nwbaseballstats on Instagram &amp; X
            </div>
          </div>
        </div>

        <div className="bg-[#1a1a2e] border border-[#3a3a5e] p-3 text-xs text-[#a8a8c8] leading-relaxed">
          <div className="font-pixel-display text-[9px] tracking-widest text-amber-200 mb-1">PLEASE INCLUDE</div>
          <ul className="space-y-0.5">
            <li>• Your level (D1 / D2 / D3 / NAIA / NWAC) and dynasty year</li>
            <li>• What you did right before the bug</li>
            <li>• What happened vs. what you expected</li>
            <li>• A screenshot if you can grab one</li>
          </ul>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full bg-amber-500 hover:bg-amber-400 text-[#0f0f1e] font-pixel-display text-[10px] tracking-widest py-2.5 transition"
        >
          GOT IT
        </button>
      </div>
    </div>
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
        <span className="font-pixel-display text-[11px] tracking-widest text-team-accent">
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
 * Reusable modal close-X button. Pixel-styled, chunky touch target, always
 * visible against light-card or dark-card backgrounds. Use this in every
 * modal so the close affordance is consistent + can't go invisible.
 *
 * @param {object} props
 * @param {() => void} props.onClick   the modal's onClose callback
 * @param {boolean} [props.dark]       set true for dark-card modals (defaults to light)
 * @param {string} [props.className]   extra classes
 */
export function ModalCloseButton({ onClick, dark = false, className = '' }) {
  const colorCls = dark
    ? 'text-[#e8e8e8] hover:text-white border-[#3a3a5e] hover:border-amber-300 hover:bg-[#3a3a5e]'
    : 'text-gray-500 hover:text-gray-900 border-gray-300 hover:border-gray-700 hover:bg-gray-100'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Close"
      title="Close (Esc)"
      className={
        'shrink-0 w-9 h-9 flex items-center justify-center border-2 font-bold text-lg leading-none transition ' +
        colorCls + ' ' + className
      }
    >
      ×
    </button>
  )
}

/**
 * useModalDismiss — attaches:
 *   - Escape-key listener that fires onClose
 *   - backdrop-click handler (returned as `backdropProps`) — call as
 *     {...backdropProps} on the OUTER fixed-inset-0 div, and put
 *     onClick={e => e.stopPropagation()} on the inner card.
 *
 * Used by every GM modal so users can dismiss via X, backdrop click, or Esc.
 */
export function useModalDismiss(onClose) {
  useEffect(() => {
    if (!onClose) return
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return {
    backdropProps: { onClick: onClose },
    stopProps: { onClick: (e) => e.stopPropagation() },
  }
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
