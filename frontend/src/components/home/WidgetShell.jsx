/**
 * Homepage widget system — the shared shell every homepage widget uses so
 * the whole grid reads as ONE design.
 *
 * Design rules (June 2026 redesign):
 *  - Cards: white/gray-800 surface, rounded-xl, thin border, subtle shadow.
 *  - Every card has a slim colored header strip (accent prop) with an
 *    uppercase tracked title and a "link" affordance to its full page.
 *  - No card should grow tall: keep content to ~5-8 rows; use <Carousel>
 *    to paginate extra content instead of growing the card.
 *  - Numbers are tabular-nums; player rows use 20px logos.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

// Accent header palettes. Teal is the default brand; the marketing-ish
// widgets (GM, portal, tiers) use their own product identities on purpose.
const ACCENTS = {
  teal:   'from-nw-teal to-nw-teal-light',
  dark:   'from-gray-800 to-gray-700',
  gold:   'from-amber-500 to-amber-400',
  indigo: 'from-portal-purple to-portal-purple-light',
  pixel:  'from-[#1a1a2e] to-[#3a3a5e]',
  summer: 'from-orange-500 to-amber-400',
}

/**
 * The standard widget card.
 * @param title    header text (short)
 * @param to       route the header link points at
 * @param linkLabel  e.g. "Full standings" (default "View all")
 * @param accent   one of ACCENTS keys (default 'teal')
 * @param badge    optional small white-on-accent chip next to the title
 * @param controls optional node rendered at the right edge of the header
 *                 (toggles, year filters) INSTEAD of the link; the link
 *                 then renders in the footer.
 * @param className extra classes for the grid cell (e.g. col spans)
 */
export function WidgetCard({ title, to, linkLabel = 'View all', accent = 'teal',
                             badge = null, controls = null, footer = null,
                             className = '', children }) {
  const headerLink = !controls && to
  return (
    <section className={`bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden flex flex-col ${className}`}>
      <div className={`bg-gradient-to-r ${ACCENTS[accent] || ACCENTS.teal} px-3 py-2 flex items-center gap-2`}>
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-white truncate">{title}</h2>
        {badge && (
          <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-white/20 text-white whitespace-nowrap">{badge}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {controls}
          {headerLink && (
            <Link to={to} className="text-[10px] font-semibold text-white/90 hover:text-white whitespace-nowrap">
              {linkLabel} →
            </Link>
          )}
        </div>
      </div>
      <div className="p-3 flex-1 min-h-0">{children}</div>
      {(footer || (controls && to)) && (
        <div className="px-3 pb-2.5 -mt-1">
          {footer || (
            <Link to={to} className="text-[10px] font-semibold text-nw-teal hover:underline">
              {linkLabel} →
            </Link>
          )}
        </div>
      )}
    </section>
  )
}

// ─── Auto-advance scheduler ─────────────────────────────────────────
// One page-global ticker advances carousels ROUND-ROBIN, one per slot,
// so no two ever move at the same instant (per Nate). With ~5 carousels
// on the homepage and a 700ms slot, each one advances every ~3.5s.
// A carousel skips its turn while hovered or within its manual-
// interaction cooldown; nothing advances while the tab is hidden.

const AUTO_SLOT_MS = 700
const MANUAL_PAUSE_MS = 10_000
const _autoEntries = []
let _autoTimer = null
let _autoIdx = 0

function registerAutoCarousel(entry) {
  _autoEntries.push(entry)
  if (_autoTimer) return
  _autoTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return
    if (_autoEntries.length === 0) return
    _autoIdx = _autoIdx % _autoEntries.length
    const e = _autoEntries[_autoIdx]
    _autoIdx += 1
    if (e.canAdvance()) e.advance()
  }, AUTO_SLOT_MS)
}

function unregisterAutoCarousel(entry) {
  const i = _autoEntries.indexOf(entry)
  if (i >= 0) _autoEntries.splice(i, 1)
  if (_autoEntries.length === 0 && _autoTimer) {
    clearInterval(_autoTimer)
    _autoTimer = null
  }
}

/**
 * Generic in-card carousel — arrows + dots, no external deps. Pass an
 * array of rendered slides; the card stays one slide tall.
 *
 * Auto-advances via the shared round-robin scheduler above (disable
 * with auto={false}). Hovering pauses it; using the arrows/dots pauses
 * it for 10s so readers aren't yanked off a slide they navigated to.
 */
export function Carousel({ slides, ariaLabel = 'carousel', auto = true }) {
  const [idx, setIdx] = useState(0)
  const n = slides?.length || 0
  const pauseRef = useRef({ hovered: false, pausedUntil: 0 })
  const touch = useCallback(() => { pauseRef.current.pausedUntil = Date.now() + MANUAL_PAUSE_MS }, [])
  const prev = useCallback(() => { touch(); setIdx(i => (i - 1 + n) % n) }, [n, touch])
  const next = useCallback(() => { touch(); setIdx(i => (i + 1) % n) }, [n, touch])

  useEffect(() => {
    if (!auto || n <= 1) return undefined
    const entry = {
      canAdvance: () => !pauseRef.current.hovered && Date.now() >= pauseRef.current.pausedUntil,
      advance: () => setIdx(i => (i + 1) % n),
    }
    registerAutoCarousel(entry)
    return () => unregisterAutoCarousel(entry)
  }, [auto, n])

  if (!n) return null
  return (
    <div
      aria-label={ariaLabel}
      onMouseEnter={() => { pauseRef.current.hovered = true }}
      onMouseLeave={() => { pauseRef.current.hovered = false }}
    >
      <div>{slides[idx]}</div>
      {n > 1 && (
        <div className="flex items-center justify-center gap-1.5 mt-2">
          <button type="button" onClick={prev} aria-label="Previous"
            className="w-6 h-6 rounded-full border border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-300 hover:text-nw-teal hover:border-nw-teal text-xs leading-none">
            ‹
          </button>
          {slides.map((_, i) => (
            <button key={i} type="button" onClick={() => { touch(); setIdx(i) }} aria-label={`Slide ${i + 1}`}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${i === idx ? 'bg-nw-teal' : 'bg-gray-300 dark:bg-gray-600'}`} />
          ))}
          <button type="button" onClick={next} aria-label="Next"
            className="w-6 h-6 rounded-full border border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-300 hover:text-nw-teal hover:border-nw-teal text-xs leading-none">
            ›
          </button>
        </div>
      )}
    </div>
  )
}

/** Pill-style toggle for 2-3 options (e.g. Spring / WCL, draft years). */
export function PillToggle({ options, value, onChange, light = false }) {
  return (
    <div className={`flex rounded-full p-0.5 ${light ? 'bg-white/20' : 'bg-gray-100 dark:bg-gray-700'}`}>
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={`px-2 py-0.5 rounded-full text-[10px] font-bold transition-colors ${
            value === o.value
              ? (light ? 'bg-white text-nw-teal' : 'bg-nw-teal text-white')
              : (light ? 'text-white/80 hover:text-white' : 'text-gray-500 dark:text-gray-300 hover:text-nw-teal')
          }`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** One player line: rank, logo, name, team, right-aligned value. */
export function PlayerRow({ rank, logo, name, sub, value, valueClass = '', to }) {
  const inner = (
    <>
      {rank != null && <span className="w-4 text-[10px] font-bold text-gray-400 tabular-nums shrink-0">{rank}</span>}
      {logo
        ? <img src={logo} alt="" loading="lazy" className="w-5 h-5 object-contain shrink-0" onError={(e) => { e.target.style.visibility = 'hidden' }} />
        : <span className="w-5 shrink-0" />}
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-semibold text-gray-800 dark:text-gray-100 truncate leading-tight">{name}</span>
        {sub && <span className="block text-[10px] text-gray-400 truncate leading-tight">{sub}</span>}
      </span>
      <span className={`text-xs font-bold tabular-nums text-nw-teal dark:text-nw-teal-light ${valueClass}`}>{value}</span>
    </>
  )
  const cls = 'flex items-center gap-2 py-1'
  return to
    ? <Link to={to} className={`${cls} hover:bg-nw-cream dark:hover:bg-gray-700/50 rounded px-1 -mx-1`}>{inner}</Link>
    : <div className={cls}>{inner}</div>
}

/** Tiny uppercase label above a group of rows inside a card. */
export function GroupLabel({ children, className = '' }) {
  return <div className={`text-[9px] font-bold uppercase tracking-wider text-gray-400 mb-0.5 ${className}`}>{children}</div>
}

/** Loading shimmer that holds a card's shape while data fetches. */
export function WidgetSkeleton({ rows = 5 }) {
  return (
    <div className="animate-pulse space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-4 bg-gray-100 dark:bg-gray-700 rounded" />
      ))}
    </div>
  )
}

/** Friendly inline empty/error note so a failed fetch never blanks a card. */
export function WidgetNote({ children }) {
  return <div className="text-[11px] text-gray-400 py-4 text-center">{children}</div>
}
