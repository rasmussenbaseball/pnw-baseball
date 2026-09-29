/**
 * Homepage (September 2026 redesign).
 *
 * Flat, light, data-first. Award cards and Team Ratings on top, a leader rail,
 * then a masonry of panels (champions, play-by-play, standings, WCL,
 * projections, recruiting, articles, site totals) that always ends on one
 * line, then the tool tiles. Every module lives in components/home/HomeV2.jsx;
 * the widget-column homepage this replaced is still in
 * components/home/{StatWidgets,FeatureWidgets}.jsx.
 *
 * The "last results" strip (ResultsStrip in HomeV2) is unmounted for the
 * offseason; add it back under AwardsRow when games start in the spring.
 */
import { useEffect } from 'react'
import { useApi } from '../hooks/useApi'
import { CURRENT_SEASON } from '../lib/seasons'
import { ensureGoogleFonts } from '../lib/loadFonts'
import {
  AwardsRow, RatingsTiles, LeaderRail, Masonry,
  ChampionsPanel, PbpPanel, StandingsPanel, WclPanel,
  ProjectionsPanel, RecruitingPanel, ArticlesPanel, SiteNumbersPanel, ToolsRow,
} from '../components/home/HomeV2'

export default function Homepage() {
  useEffect(() => {
    ensureGoogleFonts('home-fonts', 'family=Archivo:wdth,wght@75..100,500..900&family=IBM+Plex+Mono:wght@400;500;600')
  }, [])

  // Shared by the award cards, the ratings tiles, standings and champions.
  const { data: ratings, loading: ratingsLoading } = useApi('/team-ratings', { season: CURRENT_SEASON })
  const { data: natl } = useApi('/national-rankings', { season: CURRENT_SEASON })
  const { data: standings, loading: standingsLoading } = useApi('/standings', { season: CURRENT_SEASON })

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-6">
      <AwardsRow ratings={ratings} natl={natl} />
      <RatingsTiles ratings={ratings} natl={natl} loading={ratingsLoading} />
      <LeaderRail />

      <Masonry>
        <ChampionsPanel key="champions" standings={standings} />
        <PbpPanel key="pbp" />
        <StandingsPanel key="standings" standings={standings} loading={standingsLoading} />
        <WclPanel key="wcl" />
        <ProjectionsPanel key="projections" />
        <RecruitingPanel key="recruiting" />
        <ArticlesPanel key="articles" />
        <SiteNumbersPanel key="numbers" />
      </Masonry>

      <ToolsRow />

      <p className="text-center text-[11px] text-gray-400 mb-2">
        Covering the {CURRENT_SEASON} season across Washington, Oregon, Idaho, Montana, and British Columbia. Free for everyone.
      </p>
    </div>
  )
}
