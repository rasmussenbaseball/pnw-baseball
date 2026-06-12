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
  return (
    <div className="max-w-7xl mx-auto">
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
