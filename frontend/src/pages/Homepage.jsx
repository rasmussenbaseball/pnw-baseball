/**
 * Unified homepage (June 2026 redesign) — ONE homepage for every tier.
 *
 * Replaces the five per-tier homepages (Anonymous/Free/Premium/Recruiting/
 * Coach). Dense masonry-style columns of compact widgets, each linking
 * deeper into the site; nothing dominates the page.
 *
 * Layout: TRUE stacked columns (per Nate — widgets snap to the bottom of
 * the one above, no row-band gaps). Column membership is hand-balanced
 * per breakpoint in COLUMN_LAYOUTS below; the marquee widgets (standings,
 * WAR, stat leaders) always sit at the column tops. The pricing strip
 * spans full width underneath.
 *
 * Widgets live in components/home/ — StatWidgets (data-heavy) and
 * FeatureWidgets (product/marketing). All share WidgetShell for one look.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { CURRENT_SEASON } from '../lib/seasons'
import {
  StandingsWidget, WarLeadersWidget, StatLeadersWidget,
  RecordsWidget, CpiWidget,
} from '../components/home/StatWidgets'
import {
  DraftBoardWidget, GridPreviewWidget, ArticlesWidget,
  RecruitingHubWidget, GmPreviewWidget, PortalPreviewWidget,
  PbpTeaserWidget, PercentileTeaserWidget, TiersWidget,
} from '../components/home/FeatureWidgets'

export default function Homepage() {
  const { user } = useAuth()
  return (
    <div className="max-w-7xl mx-auto">
      {/* Slim hero band — identity + one-line pitch, no wasted height */}
      <div className="rounded-xl bg-gradient-to-r from-nw-teal-dark via-nw-teal to-nw-teal-light text-white px-4 sm:px-6 py-4 mb-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
        <div className="flex-1 min-w-0">
          <h1 className="text-lg sm:text-xl font-extrabold tracking-tight">
            Northwest Baseball Stats
          </h1>
          <p className="text-[11px] sm:text-xs text-white/85">
            Advanced analytics for every PNW college program — D1, D2, D3, NAIA, and NWAC — plus summer ball, recruiting, and play-by-play data you won't find anywhere else.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link to="/players" className="text-[11px] font-bold px-3 py-1.5 rounded-full bg-white text-nw-teal hover:bg-nw-cream">
            Find a player
          </Link>
          {!user && (
            <Link to="/login" className="text-[11px] font-bold px-3 py-1.5 rounded-full border border-white/60 text-white hover:bg-white/10">
              Sign up free
            </Link>
          )}
        </div>
      </div>

      <WidgetColumns />

      {/* pricing strip — always full width below the columns */}
      <div className="mt-4">
        <TiersWidget />
      </div>

      <p className="text-center text-[10px] text-gray-400 mt-6 mb-2">
        Covering the {CURRENT_SEASON} season across Washington, Oregon, Idaho, Montana, and British Columbia.
      </p>
    </div>
  )
}

// ─── Column layout ──────────────────────────────────────────────────
// Each widget renders once; which column it lands in depends on the
// breakpoint. Assignments are hand-balanced so column heights come out
// roughly even — when a widget grows or a new one is added, re-balance
// here (estimate heights from the rendered page, not the code).

const WIDGETS = {
  standings:  <StandingsWidget />,
  war:        <WarLeadersWidget />,
  statLeaders: <StatLeadersWidget />,
  records:    <RecordsWidget />,
  draft:      <DraftBoardWidget />,
  grid:       <GridPreviewWidget />,
  articles:   <ArticlesWidget />,
  recruiting: <RecruitingHubWidget />,
  cpi:        <CpiWidget />,
  gm:         <GmPreviewWidget />,
  portal:     <PortalPreviewWidget />,
  pbp:        <PbpTeaserWidget />,
  percentile: <PercentileTeaserWidget />,
}

const COLUMN_LAYOUTS = {
  3: [
    ['standings', 'records', 'gm', 'percentile'],
    ['war', 'draft', 'articles', 'cpi', 'pbp'],
    ['statLeaders', 'grid', 'recruiting', 'portal'],
  ],
  2: [
    ['standings', 'statLeaders', 'draft', 'gm', 'pbp', 'percentile'],
    ['war', 'records', 'grid', 'articles', 'recruiting', 'cpi', 'portal'],
  ],
  1: [
    ['standings', 'war', 'statLeaders', 'records', 'draft', 'grid',
     'articles', 'recruiting', 'cpi', 'gm', 'portal', 'pbp', 'percentile'],
  ],
}

function useColumnCount() {
  const get = () => {
    if (typeof window === 'undefined') return 3
    if (window.innerWidth >= 1280) return 3
    if (window.innerWidth >= 768) return 2
    return 1
  }
  const [n, setN] = useState(get)
  useEffect(() => {
    const onResize = () => setN(get())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return n
}

function WidgetColumns() {
  const n = useColumnCount()
  const cols = COLUMN_LAYOUTS[n] || COLUMN_LAYOUTS[3]
  return (
    <div className="flex gap-4 items-start">
      {cols.map((keys, i) => (
        <div key={i} className="flex-1 min-w-0 flex flex-col gap-4">
          {keys.map(k => <div key={k}>{WIDGETS[k]}</div>)}
        </div>
      ))}
    </div>
  )
}
