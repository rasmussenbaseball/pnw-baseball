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
  StandingsWidget,
  RecordsWidget,
} from '../components/home/StatWidgets'
import { LeadersBoard } from '../components/home/LeadersBoard'
import {
  DraftBoardWidget, GridPreviewWidget, ArticlesWidget,
  RecentMovesWidget, GmPreviewWidget, PortalPreviewWidget,
  NewFeaturesWidget, GamesWidget, ComparablesWidget,
  TiersWidget,
} from '../components/home/FeatureWidgets'

export default function Homepage() {
  return (
    <div className="max-w-7xl mx-auto">
      {/* Wide stat-leaders board across the very top */}
      <div className="mb-4">
        <LeadersBoard />
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
  standings:   <StandingsWidget />,
  records:     <RecordsWidget />,
  draft:       <DraftBoardWidget />,
  grid:        <GridPreviewWidget />,
  articles:    <ArticlesWidget />,
  recentMoves: <RecentMovesWidget />,
  newFeatures: <NewFeaturesWidget />,
  comps:       <ComparablesWidget />,
  games:       <GamesWidget />,
  gm:          <GmPreviewWidget />,
  portal:      <PortalPreviewWidget />,
}

const COLUMN_LAYOUTS = {
  3: [
    ['standings', 'recentMoves', 'portal', 'games'],
    ['newFeatures', 'comps', 'draft', 'records'],
    ['articles', 'grid', 'gm'],
  ],
  2: [
    ['standings', 'newFeatures', 'comps', 'draft', 'records', 'portal'],
    ['gm', 'games', 'articles', 'recentMoves', 'grid'],
  ],
  1: [
    ['standings', 'newFeatures', 'comps', 'articles', 'draft', 'games',
     'grid', 'records', 'recentMoves', 'gm', 'portal'],
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

// Desktop (3-col) gives Latest Articles a 2-column-wide featured slot on top
// for legibility: a narrow left column, then a 2-wide right region with the
// wide ArticlesWidget above two sub-columns (which is where "New on the site"
// /newFeatures now lives — bumped down a row).
const DESKTOP_LEFT = ['standings', 'draft', 'records', 'gm']
const DESKTOP_SUB = [
  ['newFeatures', 'comps', 'games'],
  ['portal', 'recentMoves', 'grid'],
]

function Stack({ keys }) {
  return (
    <div className="flex-1 min-w-0 flex flex-col gap-4">
      {keys.map(k => <div key={k}>{WIDGETS[k]}</div>)}
    </div>
  )
}

function WidgetColumns() {
  const n = useColumnCount()
  if (n === 3) {
    return (
      <div className="flex gap-4 items-start">
        <Stack keys={DESKTOP_LEFT} />
        <div className="flex-[2] min-w-0 flex flex-col gap-4">
          <ArticlesWidget wide />
          <div className="flex gap-4 items-start">
            {DESKTOP_SUB.map((keys, i) => <Stack key={i} keys={keys} />)}
          </div>
        </div>
      </div>
    )
  }
  const cols = COLUMN_LAYOUTS[n] || COLUMN_LAYOUTS[2]
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
