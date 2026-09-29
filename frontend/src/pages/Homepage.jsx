/**
 * Homepage (September 2026 redesign).
 *
 * Flat, light, data-first. Award cards and Team Ratings on top, then a leader
 * rail, then three columns of charts (play-by-play, standings, WCL), then
 * projections and recruiting, then articles and the tool tiles. Every module
 * lives in components/home/HomeV2.jsx; the widget-column homepage this
 * replaced is still in components/home/{StatWidgets,FeatureWidgets}.jsx.
 */
import { useEffect } from 'react'
import { useApi } from '../hooks/useApi'
import { CURRENT_SEASON } from '../lib/seasons'
import { ensureGoogleFonts } from '../lib/loadFonts'
import {
  AwardsRow, ResultsStrip, RatingsTiles, LeaderRail,
  PbpPanel, StandingsPanel, WclPanel,
  ProjectionsPanel, RecruitingPanel, ArticlesPanel, SiteNumbersPanel, ToolsRow,
} from '../components/home/HomeV2'

export default function Homepage() {
  useEffect(() => {
    ensureGoogleFonts('home-fonts', 'family=Archivo:wdth,wght@75..100,500..900&family=IBM+Plex+Mono:wght@400;500;600')
  }, [])

  // Shared by the award cards, the ratings tiles and the standings panel.
  const { data: ratings, loading: ratingsLoading } = useApi('/team-ratings', { season: CURRENT_SEASON })
  const { data: natl } = useApi('/national-rankings', { season: CURRENT_SEASON })
  const { data: standings, loading: standingsLoading } = useApi('/standings', { season: CURRENT_SEASON })

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-6">
      <AwardsRow ratings={ratings} natl={natl} />
      <ResultsStrip />
      <RatingsTiles ratings={ratings} natl={natl} loading={ratingsLoading} />
      <LeaderRail />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <PbpPanel />
        <StandingsPanel standings={standings} loading={standingsLoading} />
        <WclPanel />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <ProjectionsPanel className="lg:col-span-2" />
        <RecruitingPanel />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <ArticlesPanel className="lg:col-span-2" />
        <SiteNumbersPanel />
      </div>

      <ToolsRow />

      <p className="text-center text-[11px] text-gray-400 mb-2">
        Covering the {CURRENT_SEASON} season across Washington, Oregon, Idaho, Montana, and British Columbia. Free for everyone.
      </p>
    </div>
  )
}
