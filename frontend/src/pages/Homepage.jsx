/**
 * Unified homepage (June 2026 redesign) — ONE homepage for every tier.
 *
 * Replaces the five per-tier homepages (Anonymous/Free/Premium/Recruiting/
 * Coach). Dense grid of compact widgets, each linking deeper into the
 * site; nothing dominates the page. Layout intent:
 *
 *   band 1 (the asks for "top of page"): standings · WAR by level · stat leaders
 *   band 2: records · draft board · today's grid
 *   band 3: articles · recruiting hub · WCL CPI
 *   band 4: GM sim · portal · PBP teaser + percentile teaser (stacked)
 *   band 5: tier pricing strip (full width)
 *
 * Widgets live in components/home/ — StatWidgets (data-heavy) and
 * FeatureWidgets (product/marketing). All share WidgetShell for one look.
 */

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

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
        {/* band 1 — the marquee stats */}
        <StandingsWidget />
        <WarLeadersWidget />
        <StatLeadersWidget />

        {/* band 2 */}
        <RecordsWidget />
        <DraftBoardWidget />
        <GridPreviewWidget />

        {/* band 3 */}
        <ArticlesWidget />
        <RecruitingHubWidget />
        <CpiWidget />

        {/* band 4 — product showcases + data teasers */}
        <GmPreviewWidget />
        <PortalPreviewWidget />
        <div className="grid grid-cols-1 gap-4">
          <PbpTeaserWidget />
          <PercentileTeaserWidget />
        </div>

        {/* band 5 — pricing strip */}
        <TiersWidget className="md:col-span-2 xl:col-span-3" />
      </div>

      <p className="text-center text-[10px] text-gray-400 mt-6 mb-2">
        Covering the {CURRENT_SEASON} season across Washington, Oregon, Idaho, Montana, and British Columbia.
      </p>
    </div>
  )
}
