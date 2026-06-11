/**
 * Homepage feature widgets — the marketing / product-discovery cards of
 * the June 2026 homepage redesign. All nine build on WidgetShell so the
 * grid reads as one design. Stats-flavored cards stay teal; the product
 * cards (GM, portal, tiers, grid) use their own identities on purpose.
 *
 * Route notes (verified against App.jsx):
 *  - Player profiles live at /player/:playerId (NOT /players/:id).
 *  - /recruiting/rankings is admin-only, so the Recruiting Hub links to
 *    /recruiting-classes (the public-facing class rankings page) instead.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  WidgetCard, Carousel, PillToggle, GroupLabel, WidgetSkeleton, WidgetNote,
} from './WidgetShell'
import { useApi } from '../../hooks/useApi'
import { DRAFT_DATA, DRAFT_YEARS, getSchoolLogo } from '../../data/draftData'

// "Jun 9" style short date for article / commitment rows.
function fmtShortDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '' }
}

// Small teal link chip used across the promo slides.
function LinkChip({ to, children }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold
                 bg-nw-teal/10 text-nw-teal dark:bg-nw-teal/20 dark:text-nw-teal-light
                 hover:bg-nw-teal hover:text-white transition-colors"
    >
      {children} →
    </Link>
  )
}

// ─── 1. MLB Draft Board ─────────────────────────────────────────

export function DraftBoardWidget() {
  const [year, setYear] = useState(DRAFT_YEARS[0])
  const board = DRAFT_DATA[year]
  const prospects = (board?.prospects || []).slice(0, 10)

  return (
    <WidgetCard
      title="MLB Draft Board"
      to="/draft"
      linkLabel="Full board"
      controls={
        <PillToggle
          light
          options={DRAFT_YEARS.map(y => ({ value: y, label: `'${y}` }))}
          value={year}
          onChange={setYear}
        />
      }
    >
      {prospects.length === 0 ? (
        <WidgetNote>Rankings for the '{year} class are coming soon.</WidgetNote>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
          {prospects.map(p => {
            const inner = (
              <>
                <span className="w-4 text-[10px] font-bold text-gray-400 tabular-nums shrink-0">{p.rank}</span>
                <img
                  src={getSchoolLogo(p.school)} alt="" loading="lazy"
                  className="w-5 h-5 object-contain shrink-0"
                  onError={(e) => { e.target.style.visibility = 'hidden' }}
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-semibold text-gray-800 dark:text-gray-100 truncate leading-tight">
                    {p.name}
                  </span>
                  <span className="block text-[10px] text-gray-400 truncate leading-tight">
                    {p.pos} · {p.school}
                  </span>
                </span>
              </>
            )
            const cls = 'flex items-center gap-2 py-0.5'
            return p.playerId ? (
              <Link
                key={`${year}-${p.rank}`}
                to={`/player/${p.playerId}`}
                className={`${cls} hover:bg-nw-cream dark:hover:bg-gray-700/50 rounded px-1 -mx-1`}
              >
                {inner}
              </Link>
            ) : (
              <div key={`${year}-${p.rank}`} className={cls}>{inner}</div>
            )
          })}
        </div>
      )}
    </WidgetCard>
  )
}

// ─── 2. Today's PNW Grid ────────────────────────────────────────

export function GridPreviewWidget() {
  const { data, loading, error } = useApi('/grid/config')
  const columns = data?.columns || []
  const rows = data?.rows || []

  return (
    <WidgetCard title="Today's PNW Grid" to="/pnw-grid" linkLabel="Play today's grid" accent="dark">
      {loading ? (
        <WidgetSkeleton rows={4} />
      ) : error || columns.length === 0 || rows.length === 0 ? (
        <WidgetNote>Today's puzzle isn't loaded yet — tap through to play.</WidgetNote>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,5rem)_repeat(3,minmax(0,1fr))] gap-1">
            {/* corner spacer */}
            <div />
            {columns.slice(0, 3).map((c, i) => (
              <div key={`c-${i}`} className="text-[9px] font-bold text-gray-600 dark:text-gray-300 text-center leading-tight truncate self-end pb-0.5">
                {c.label}
              </div>
            ))}
            {rows.slice(0, 3).map((r, ri) => (
              <div key={`r-${ri}`} className="contents">
                <div className="text-[9px] font-bold text-gray-600 dark:text-gray-300 leading-tight truncate self-center text-right pr-1">
                  {r.label}
                </div>
                {[0, 1, 2].map(ci => (
                  <div
                    key={`cell-${ri}-${ci}`}
                    className="h-9 rounded-md bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700
                               flex items-center justify-center text-sm font-bold text-gray-300 dark:text-gray-600"
                  >
                    ?
                  </div>
                ))}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2">
            New puzzle daily — guess players to fill the grid.
          </p>
        </>
      )}
    </WidgetCard>
  )
}

// ─── 3. Latest Articles ─────────────────────────────────────────

export function ArticlesWidget() {
  const { data, loading, error } = useApi('/articles', { limit: 4 })
  const articles = data?.articles || []
  const gated = (t) => ['premium', 'recruiting', 'coach'].includes(t)

  return (
    <WidgetCard title="Latest Articles" to="/news" linkLabel="All articles">
      {loading ? (
        <WidgetSkeleton rows={4} />
      ) : error ? (
        <WidgetNote>Couldn't load articles right now.</WidgetNote>
      ) : articles.length === 0 ? (
        <WidgetNote>No articles yet — check back soon.</WidgetNote>
      ) : (
        <div className="space-y-1">
          {articles.map(a => (
            <Link
              key={a.id || a.slug}
              to={`/news/${a.slug}`}
              className="flex items-center gap-2 py-1 hover:bg-nw-cream dark:hover:bg-gray-700/50 rounded px-1 -mx-1"
            >
              {a.hero_image_url ? (
                <img
                  src={a.hero_image_url} alt="" loading="lazy"
                  className="w-10 h-10 rounded object-cover shrink-0"
                  onError={(e) => { e.target.style.visibility = 'hidden' }}
                />
              ) : (
                <span className="w-10 h-10 rounded bg-gray-100 dark:bg-gray-700 shrink-0" />
              )}
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-semibold text-gray-800 dark:text-gray-100 leading-tight line-clamp-2">
                  {a.title}
                  {gated(a.requires_tier) && (
                    <span className="ml-1.5 inline-block align-middle text-[8px] font-bold uppercase tracking-wider
                                     px-1 py-px rounded bg-amber-100 text-amber-800
                                     dark:bg-amber-900/50 dark:text-amber-300">
                      Premium
                    </span>
                  )}
                </span>
                <span className="block text-[10px] text-gray-400 leading-tight mt-0.5">
                  {fmtShortDate(a.published_at)}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </WidgetCard>
  )
}

// ─── 4. Recruiting Hub ──────────────────────────────────────────

export function RecruitingHubWidget() {
  const { data } = useApi('/commitments', { limit: 3 })
  const commits = (data?.commitments || []).slice(0, 3)

  const slides = [
    // Slide 1 — Recruiting Guide
    <div key="guide" className="min-h-[120px]">
      <GroupLabel>Recruiting Guide</GroupLabel>
      <div className="text-xs font-bold text-gray-800 dark:text-gray-100 mb-1">
        Know the path before you walk it
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug mb-2">
        How PNW recruiting actually works, level by level: timelines, roster math, and what
        coaches at each division look for.
      </p>
      <LinkChip to="/recruiting/guide">Read the guide</LinkChip>
    </div>,

    // Slide 2 — Commitment Tracker
    <div key="commits" className="min-h-[120px]">
      <GroupLabel>Commitment Tracker</GroupLabel>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug mb-1.5">
        Every PNW commitment as it happens, with stats attached.
      </p>
      {commits.length > 0 && (
        <div className="mb-2">
          {commits.map((c, i) => (
            <div key={i} className="flex items-center gap-1.5 py-0.5 text-[11px]">
              <span className="font-semibold text-gray-800 dark:text-gray-100 truncate">
                {c.first_name} {c.last_name}
              </span>
              <span className="text-gray-400 truncate">
                {c.team_short} → {c.committed_to}
              </span>
              <span className="ml-auto text-[10px] text-gray-400 tabular-nums whitespace-nowrap">
                {fmtShortDate(c.commitment_date)}
              </span>
            </div>
          ))}
        </div>
      )}
      <LinkChip to="/news/commitments">Track commitments</LinkChip>
    </div>,

    // Slide 3 — Rankings & Map
    <div key="rankings" className="min-h-[120px]">
      <GroupLabel>Rankings &amp; Map</GroupLabel>
      <div className="text-xs font-bold text-gray-800 dark:text-gray-100 mb-1">
        Who's building the best classes?
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug mb-2">
        Recruiting class rankings for every PNW program, plus an interactive map of where
        each roster comes from.
      </p>
      <div className="flex flex-wrap gap-1.5">
        <LinkChip to="/recruiting-classes">Class rankings</LinkChip>
        <LinkChip to="/recruiting/map">Recruiting map</LinkChip>
      </div>
    </div>,
  ]

  return (
    <WidgetCard title="Recruiting Hub" to="/recruiting" linkLabel="Explore recruiting">
      <Carousel slides={slides} ariaLabel="Recruiting hub highlights" />
    </WidgetCard>
  )
}

// ─── 5. PNW Coach Sim (GM game) ─────────────────────────────────

export function GmPreviewWidget() {
  return (
    <WidgetCard title="PNW Coach Sim" to="/gm" linkLabel="Start your dynasty" accent="pixel">
      <div className="rounded-lg bg-[#1a1a2e] border border-[#3a3a5e] p-3 font-mono">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[9px] font-bold uppercase tracking-widest text-[#fbbf24]">Dashboard</span>
          <span className="w-1.5 h-1.5 rounded-full bg-[#fbbf24] animate-pulse" />
        </div>
        <div className="text-[11px] text-[#fbbf24] tabular-nums tracking-tight mb-2">
          WK 27 · SEASON OPENS · OVR 74 · BUDGET $180K
        </div>
        <ul className="space-y-1 text-[11px] text-gray-300">
          <li className="flex items-start gap-1.5"><span className="text-[#fbbf24]">▸</span>Run a real PNW program</li>
          <li className="flex items-start gap-1.5"><span className="text-[#fbbf24]">▸</span>Recruit, develop, manage the budget</li>
          <li className="flex items-start gap-1.5"><span className="text-[#fbbf24]">▸</span>Climb from JUCO to a dynasty</li>
        </ul>
      </div>
    </WidgetCard>
  )
}

// ─── 6. Coach & Scouting Portal ─────────────────────────────────

export function PortalPreviewWidget() {
  const sheet = [
    ['1B vs RHP', 'Air-pull 38%', 'shade pull'],
    ['CF vs LHP', 'Chase 31%', 'expand away'],
    ['RHP putaway', 'Whiff 41% SL', 'bury 0-2'],
  ]
  return (
    <WidgetCard title="Coach & Scouting Portal" to="/portal" linkLabel="Open the portal" accent="indigo">
      <div className="rounded-lg bg-portal-purple p-2.5 mb-2">
        <div className="text-[8px] font-bold uppercase tracking-widest text-portal-accent-light mb-1.5">
          Scouting Sheet · sample
        </div>
        <table className="w-full text-[10px] text-portal-cream">
          <thead>
            <tr className="text-[8px] uppercase tracking-wider text-portal-cream/50">
              <th className="text-left font-bold pb-0.5">Player</th>
              <th className="text-left font-bold pb-0.5">Tendency</th>
              <th className="text-left font-bold pb-0.5">Edge</th>
            </tr>
          </thead>
          <tbody>
            {sheet.map((row, i) => (
              <tr key={i} className="border-t border-portal-purple-light">
                {row.map((cell, j) => (
                  <td key={j} className="py-0.5 pr-1.5 whitespace-nowrap tabular-nums">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-1 mb-1.5">
        {['Scouting Sheets', 'Bullpen Cards', 'Lineup Helper', 'Catcher Cards'].map(p => (
          <span
            key={p}
            className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-indigo-50 text-portal-purple
                       dark:bg-indigo-900/40 dark:text-indigo-300"
          >
            {p}
          </span>
        ))}
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400">
        Game-prep PDFs and matchup data built from play-by-play.
      </p>
    </WidgetCard>
  )
}

// ─── 7. Play-by-Play teaser ─────────────────────────────────────

export function PbpTeaserWidget() {
  // 5-zone fan: origin (50,68), r=60, slice edges every 18° from -45° to 45°.
  const wedges = [
    { d: 'M50 68 L7.57 25.57 A60 60 0 0 1 22.76 14.54 Z', hot: true },   // pull
    { d: 'M50 68 L22.76 14.54 A60 60 0 0 1 40.61 8.74 Z', hot: false },
    { d: 'M50 68 L40.61 8.74 A60 60 0 0 1 59.39 8.74 Z', hot: true },    // center
    { d: 'M50 68 L59.39 8.74 A60 60 0 0 1 77.24 14.54 Z', hot: false },
    { d: 'M50 68 L77.24 14.54 A60 60 0 0 1 92.43 25.57 Z', hot: false },
  ]
  return (
    <WidgetCard title="Play-by-Play Data" to="/hitting" linkLabel="Explore the data">
      <div className="flex items-center gap-3">
        <svg viewBox="0 0 100 72" className="w-24 shrink-0" aria-hidden="true">
          {wedges.map((w, i) => (
            <path
              key={i}
              d={w.d}
              className={w.hot
                ? 'fill-nw-teal/80'
                : 'fill-gray-100 dark:fill-gray-700'}
              stroke="currentColor"
              strokeWidth="0.75"
              strokeLinejoin="round"
              style={{ color: 'rgba(120,120,120,0.35)' }}
            />
          ))}
          <text x="23" y="36" textAnchor="middle" className="fill-white" fontSize="7" fontWeight="700">42%</text>
          <text x="23" y="43" textAnchor="middle" className="fill-white" fontSize="5">Pull</text>
          <text x="50" y="28" textAnchor="middle" className="fill-white" fontSize="7" fontWeight="700">24%</text>
          <text x="50" y="35" textAnchor="middle" className="fill-white" fontSize="5">Mid</text>
        </svg>
        <div className="min-w-0">
          <div className="flex flex-wrap gap-1 mb-1.5">
            {['Contact%', 'Whiff%', 'Air-Pull%'].map(s => (
              <span
                key={s}
                className="px-1.5 py-0.5 rounded-full text-[9px] font-bold tabular-nums
                           bg-nw-teal/10 text-nw-teal dark:bg-nw-teal/20 dark:text-nw-teal-light"
              >
                {s}
              </span>
            ))}
          </div>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug">
            Per-pitch outcomes tracked for 90% of PNW games.
          </p>
        </div>
      </div>
    </WidgetCard>
  )
}

// ─── 8. Savant-style percentiles teaser ─────────────────────────

export function PercentileTeaserWidget() {
  // Static demo values with the savant red (good) → blue (poor) ramp.
  const bars = [
    { label: 'wOBACON', v: 94, color: '#d22d49' },
    { label: 'Whiff%', v: 88, color: '#c75d6e' },
    { label: 'Contact%', v: 71, color: '#8f9bb3' },
    { label: 'Speed', v: 55, color: '#5d99c6' },
  ]
  return (
    <WidgetCard title="Savant-Style Percentiles" to="/percentiles" linkLabel="See percentiles">
      <GroupLabel>Sample player</GroupLabel>
      <div className="space-y-2.5 mt-1">
        {bars.map(b => (
          <div key={b.label}>
            <div className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 mb-0.5">{b.label}</div>
            <div className="relative h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 mr-2.5">
              <div
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${b.v}%`, backgroundColor: b.color }}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 w-[18px] h-[18px] rounded-full
                           flex items-center justify-center text-[9px] font-bold text-white tabular-nums
                           ring-2 ring-white dark:ring-gray-800"
                style={{ left: `calc(${b.v}% - 9px)`, backgroundColor: b.color }}
              >
                {b.v}
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2.5">
        Every player page ranks 15+ metrics against their division.
      </p>
    </WidgetCard>
  )
}

// ─── 9. Choose Your Tier ────────────────────────────────────────

// Mirrors the real tier data in pages/Pricing.jsx — keep in sync.
const TIER_STRIP = [
  {
    name: 'Free', price: '$0',
    features: ['PNW Grid + Team Quiz', 'Percentiles, Records & more'],
  },
  {
    name: 'Premium', price: '$5/mo', popular: true,
    features: ['NW Coaching Simulator', 'Recruiting guides + Draft Board'],
  },
  {
    name: 'Recruiting', price: '$10/mo',
    features: ['JUCO + Transfer Portal trackers', 'Commitments tracker'],
  },
  {
    name: 'Coach & Scout', price: '$25/mo',
    features: ['Full scouting portal', 'Printable PDFs + CSV exports'],
  },
]

export function TiersWidget({ className = '' }) {
  return (
    <WidgetCard title="Choose Your Tier" to="/pricing" linkLabel="Compare plans" accent="gold" className={className}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {TIER_STRIP.map(t => (
          <div
            key={t.name}
            className={`relative rounded-lg border p-2.5 ${
              t.popular
                ? 'border-nw-teal ring-1 ring-nw-teal/40'
                : 'border-gray-200 dark:border-gray-700'
            }`}
          >
            {t.popular && (
              <span className="absolute -top-2 right-2 px-1.5 py-px rounded-full text-[8px] font-bold uppercase
                               tracking-wider bg-nw-teal text-white">
                Popular
              </span>
            )}
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t.name}
            </div>
            <div className="text-sm font-extrabold text-gray-900 dark:text-gray-100 tabular-nums mb-1">
              {t.price}
            </div>
            <ul className="space-y-0.5">
              {t.features.map(f => (
                <li key={f} className="flex items-start gap-1 text-[10px] text-gray-600 dark:text-gray-300 leading-snug">
                  <span className="text-nw-teal mt-px">✓</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </WidgetCard>
  )
}
