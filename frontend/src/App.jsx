import { Routes, Route, Navigate, useLocation, Link } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { AffiliationProvider } from './context/AffiliationContext'
import { ThemeProvider } from './context/ThemeContext'
import { PreviewProvider } from './context/PreviewContext'
import PreviewBanner from './components/PreviewBanner'
import MaintenanceLockout from './components/MaintenanceLockout'
import GlobalRouteLoader from './components/GlobalRouteLoader'
import { isDeveloper } from './lib/tiers'
import Header from './components/Header'
import EmailPrefsPopup from './components/EmailPrefsPopup'

// Auth guard - shows blurred teaser with signup prompt if not signed in
function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return (
    <div className="relative">
      {/* Blurred teaser of the page */}
      <div className="filter blur-sm opacity-60 pointer-events-none select-none" aria-hidden="true">
        {children}
      </div>
      {/* Overlay prompt */}
      <div className="absolute inset-0 flex items-start justify-center pt-24 bg-white/40 dark:bg-gray-900/40">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-6 sm:p-8 max-w-sm w-full text-center mx-4">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-pnw-green/10 dark:bg-pnw-green/20 rounded-full mb-3">
            <svg className="w-6 h-6 text-pnw-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-pnw-slate dark:text-gray-100 mb-1">Free Account Required</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
            Sign up for a free account to access this feature. It only takes a few seconds.
          </p>
          <div className="space-y-2">
            <a
              href="/login?tab=signup"
              className="block w-full px-4 py-2.5 bg-pnw-green text-white text-sm font-semibold rounded-lg hover:bg-pnw-forest transition-colors"
            >
              Sign Up Free
            </a>
            <a
              href="/login"
              className="block w-full px-4 py-2.5 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
            >
              Log In
            </a>
          </div>
        </div>
      </div>
    </div>
  )
  return children
}

// Admin-only guard - only allows specific email(s). Site developers
// (DEVELOPER_EMAILS in lib/tiers.js) always pass through.
const ADMIN_EMAILS = ['nate.rasmussen26@gmail.com', 'pnwcbr@gmail.com']
function RequireAdmin({ children }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return <Navigate to="/login" replace />
  const email = (user.email || '').toLowerCase()
  if (!ADMIN_EMAILS.includes(email) && !isDeveloper(email)) {
    return <Navigate to="/" replace />
  }
  return children
}

// GM early-access guard — locks the GM game to a single user during private alpha.
// Site devs (DEVELOPER_EMAILS) also get in automatically, regardless of allowlist.
const GM_EARLY_ACCESS_EMAILS = [
  'nate.rasmussen26@gmail.com',
  'jawomack@bushnell.edu',
  'ethan.stacy@gmail.com',
  'jhussey1703@gmail.com',
  'dylanthomasha@gmail.com',
  'miyazawajoshua@gmail.com',
  'maxo2326@gmail.com',
]

// Article-author allowlist — only these emails see the "Articles" item
// in the Misc dropdown and reach /articles management routes. Public
// reading at /news stays open to everyone. All site developers are
// granted authoring access too (handled in the guard below).
export const ARTICLE_AUTHOR_EMAILS = [
  'nate.rasmussen26@gmail.com',
]

function RequireArticleAuthor({ children }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return <Navigate to="/login" replace />
  const email = (user.email || '').toLowerCase()
  if (!ARTICLE_AUTHOR_EMAILS.includes(email) && !isDeveloper(email)) {
    return <Navigate to="/news" replace />
  }
  return children
}

// Loading screen shown while the lazy-loaded GM chunk is downloading.
// Triggered on the FIRST navigation to any /gm/* route (after that, the
// whole game bundle is cached so subsequent pages render instantly).
function GmChunkLoading() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center bg-[#1a1a2e] text-[#e8e8e8] font-pixel">
      <div className="text-center">
        <div className="font-pixel-display text-[10px] tracking-widest text-amber-300 mb-3">
          NW COACHING SIM
        </div>
        <div className="text-lg">Loading dynasty…</div>
        <div className="text-xs text-[#a8a8c8] mt-2">First-time load, then cached.</div>
      </div>
    </div>
  )
}

function RequireGmEarlyAccess({ children }) {
  // GM access — who gets into /gm/*:
  //   1. Beta allowlist (GM_EARLY_ACCESS_EMAILS) — original private-alpha
  //      testers, grandfathered in regardless of subscription.
  //   2. Any PAID subscription tier — Premium, Coach & Scout, or Dev.
  //      useTier() resolves the backend /me/subscription row: a paid sub
  //      ('paid'/'premium') → 'premium', a coach sub → 'coach', and site
  //      devs (DEVELOPER_EMAILS) → 'dev'. All three pass. Even if the
  //      backend only distinguishes free/paid today, every paid user maps
  //      to 'premium' and gets in.
  // Blocked: signed-out + Free-tier users → the upsell card below.
  const { user, loading } = useAuth()
  const { tier, loading: tierLoading } = useTier()
  if (loading || tierLoading) return null
  if (!user) return <Navigate to="/login" replace />

  const onAllowlist = GM_EARLY_ACCESS_EMAILS.includes(user.email)
  // Premium, Coach & Scout, and Dev tiers all include the GM game.
  const hasPaidTier = tier === 'premium' || tier === 'recruiting' || tier === 'coach' || tier === 'dev'
  // Launch-week promo: free to play for every signed-in user until the
  // cutoff in lib/gmPromo.js, after which this gate auto-reverts.
  const freePlay = isGmFreePlay()

  if (!onAllowlist && !hasPaidTier && !freePlay) {
    return (
      <div className="max-w-xl mx-auto py-16 text-center">
        <h1 className="text-3xl font-bold text-pnw-slate dark:text-gray-100 mb-4">NW Coaching Simulator</h1>
        <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-xl p-6">
          <p className="text-sm text-amber-900 dark:text-amber-200 mb-2">🔒 <strong>Premium feature</strong></p>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            The NW Coaching Simulator is included with any Premium or Coach &amp; Scout subscription.
            Upgrade to start running your own dynasty.
          </p>
          <Link to="/pricing"
                className="mt-4 inline-block px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                           bg-nw-teal hover:bg-nw-teal-dark text-white transition-colors">
            See plans →
          </Link>
        </div>
        <a href="/" className="mt-6 inline-block text-sm text-pnw-green hover:underline">← Back to NW Baseball Stats</a>
      </div>
    )
  }
  // Suspense boundary so lazy-loaded GM pages don't crash. The fallback
  // shows a themed loading screen during the (one-time) chunk download.
  return <Suspense fallback={<GmChunkLoading />}>{children}</Suspense>
}

// Portal access — Coach & Scout tier only. The portal is the
// dedicated coaching workspace (lineup helpers, scouting sheets,
// catcher cards, PDFs) and is the headline justification for the
// top-tier subscription. Anonymous / Free / Premium → upsell card
// pointing to /pricing.
const PORTAL_OWNERS = ['nate.rasmussen26@gmail.com']  // legacy / reference
function RequirePortalAccess({ children }) {
  return <RequireTier minTier="coach">{children}</RequireTier>
}

// ─── Existing pages ───
import BattingLeaderboard from './pages/BattingLeaderboard'
import PitchingLeaderboard from './pages/PitchingLeaderboard'
import FieldingLeaderboard from './pages/FieldingLeaderboard'
import RelieverLeaderboard from './pages/RelieverLeaderboard'
import SummerHub from './pages/SummerHub'
import SummerGameDetail from './pages/SummerGameDetail'
import SummerTeamDetail from './pages/SummerTeamDetail'
import SummerPlayerDetail from './pages/SummerPlayerDetail'
import WclRecapGraphic from './pages/WclRecapGraphic'
import WclGameRecapGraphic from './pages/WclGameRecapGraphic'
import SummerStatsPage from './pages/summer/SummerStatsPage'
import SummerScoreboardPage from './pages/summer/SummerScoreboardPage'
import SummerStandingsPage from './pages/summer/SummerStandingsPage'
import SummerTeamsPage from './pages/summer/SummerTeamsPage'
import SummerPnwAlumniPage from './pages/summer/SummerPnwAlumniPage'
import SummerCollegeMixPage from './pages/summer/SummerCollegeMixPage'
import RequireDev from './components/RequireDev'
import WarLeaderboard from './pages/WarLeaderboard'
import TeamStatsPage from './pages/TeamStatsPage'
import TeamsPage from './pages/TeamsPage'
import ProTracker from './pages/ProTracker'
import TeamDetail from './pages/TeamDetail'
import TeamComparison from './pages/TeamComparison'
import ScatterPlot from './pages/ScatterPlot'
import PlayerSearch from './pages/PlayerSearch'
import JucoTracker from './pages/JucoTracker'
import TransferPortalTracker from './pages/TransferPortalTracker'
import PlayerDetail from './pages/PlayerDetail'
import SocialGraphics from './pages/SocialGraphics'
import DailyScoresGraphic from './pages/DailyScoresGraphic'
import KeyMatchupGraphic from './pages/KeyMatchupGraphic'
import SeriesRecapGraphic from './pages/SeriesRecapGraphic'
import TournamentBracketGraphic from './pages/TournamentBracketGraphic'
import DailyRecapGraphic from './pages/DailyRecapGraphic'

// ─── New pages ───
import Homepage from './pages/Homepage'
import AnonymousHomepage from './pages/AnonymousHomepage'
import FreeHomepage from './pages/FreeHomepage'
import PremiumHomepage from './pages/PremiumHomepage'
import RecruitingHomepage from './pages/RecruitingHomepage'
import CoachHomepage from './pages/CoachHomepage'
import StatLeaders from './pages/StatLeaders'
import StandingsPage from './pages/StandingsPage'
// ResultsPage removed - consolidated into Scoreboard with date picker
import GameDetail from './pages/GameDetail'
import TeamRatings from './pages/TeamRatings'
import TeamHistory from './pages/TeamHistory'
import RecruitingClasses from './pages/RecruitingClasses'
import RecruitQuiz from './pages/RecruitQuiz'
import RecruitingRankings from './pages/RecruitingRankings'
import RecruitingMap from './pages/RecruitingMap'
import AdminRecruitingPlaceholder from './pages/AdminRecruitingPlaceholder'
import RecruitingHistory from './pages/RecruitingHistory'
import RecruitingField from './pages/RecruitingField'
import RecruitingGuide from './pages/RecruitingGuide'
import PlayerScouting from './pages/PlayerScouting'
import TeamScouting from './pages/TeamScouting'
import ScoutingSheet from './pages/ScoutingSheet'
import PlayerCardPDF from './pages/PlayerCardPDF'
import BulkPlayerCards from './pages/BulkPlayerCards'
import PortalPDFs from './pages/PortalPDFs'
import BullpenSheet from './pages/BullpenSheet'
import CatcherCards from './pages/CatcherCards'
import NWACTournamentSheet from './pages/NWACTournamentSheet'
import NewsList from './pages/NewsList'
import NewsArticle from './pages/NewsArticle'
import NewsCommitments from './pages/NewsCommitments'
import GraphicsHub from './pages/GraphicsHub'
import ArticlesList from './pages/portal/ArticlesList'
import ArticleEditor from './pages/portal/ArticleEditor'
import EmailComposer from './pages/portal/EmailComposer'
import Unsubscribe from './pages/Unsubscribe'
import Account from './pages/Account'
import Pricing from './pages/Pricing'
import RequireTier from './components/RequireTier'
import { useTier } from './hooks/useTier'
import { isGmFreePlay } from './lib/gmPromo'
import OpponentTrends from './pages/OpponentTrends'
import HistoricMatchups from './pages/HistoricMatchups'
import LineupHelper from './pages/LineupHelper'
import ParkFactors from './pages/ParkFactors'
// Coach & Scouting Portal
import PortalLayout from './components/PortalLayout'
import PortalHome from './pages/PortalHome'
import DraftBoard from './pages/DraftBoard'
import NationalRankings from './pages/NationalRankings'
import Scoreboard from './pages/Scoreboard'
import About from './pages/About'
import RecruitingBreakdown from './pages/RecruitingBreakdown'
import PnwGrid from './pages/PnwGrid'
import TopMoments from './pages/TopMoments'
import AllConferenceGenerator from './pages/AllConferenceGenerator'
import AuthPage from './pages/AuthPage'
import FavoritesPage from './pages/FavoritesPage'
import FeatureRequest from './pages/FeatureRequest'
import PlayerGraphic from './pages/PlayerGraphic'
import ConferenceStandingsGraphic from './pages/ConferenceStandingsGraphic'
import AllConferenceGraphic from './pages/AllConferenceGraphic'
import TopPerformersGraphic from './pages/TopPerformersGraphic'
import TeamInfoGraphic from './pages/TeamInfoGraphic'
import TeamSeasonRecapGraphic from './pages/TeamSeasonRecapGraphic'
import HometownSearch from './pages/HometownSearch'
import RecordsPage from './pages/RecordsPage'
import PlayoffProjections from './pages/PlayoffProjections'
import Percentiles from './pages/Percentiles'
import PlayerComps from './pages/PlayerComps'
import TeamQuiz from './pages/TeamQuiz'

// ─── GM (new section, isolated from existing site code) ───
// GM dynasty game pages — lazy-loaded so visitors to the main analytics
// site don't download the ~1.5MB game bundle. Triggered on first /gm/*
// navigation. The Vite manualChunks config pools these into a single
// `gm-ui` chunk, so the very first /gm/ hit pays one download for all
// dynasty pages.
const GMHome = lazy(() => import('./pages/gm/GMHome'))
const NewDynasty = lazy(() => import('./pages/gm/NewDynasty'))
const Dashboard = lazy(() => import('./pages/gm/Dashboard'))
const Roster = lazy(() => import('./pages/gm/Roster'))
const Schedule = lazy(() => import('./pages/gm/Schedule'))
const Standings = lazy(() => import('./pages/gm/Standings'))
const Rankings = lazy(() => import('./pages/gm/Rankings'))
const Budget = lazy(() => import('./pages/gm/Budget'))
const Postseason = lazy(() => import('./pages/gm/Postseason'))
const Recruiting = lazy(() => import('./pages/gm/Recruiting'))
const Career = lazy(() => import('./pages/gm/Career'))
const GMPlayerDetail = lazy(() => import('./pages/gm/PlayerDetail'))
const Coaches = lazy(() => import('./pages/gm/Coaches'))
const WeeklyActions = lazy(() => import('./pages/gm/WeeklyActions'))
const DepthChart = lazy(() => import('./pages/gm/DepthChart'))
const Play = lazy(() => import('./pages/gm/Play'))
const GMCalendar = lazy(() => import('./pages/gm/Calendar'))
const SummerBall = lazy(() => import('./pages/gm/SummerBall'))
const GMStats = lazy(() => import('./pages/gm/Stats'))
const Records = lazy(() => import('./pages/gm/Records'))
const Academics = lazy(() => import('./pages/gm/Academics'))
const TeamStats = lazy(() => import('./pages/gm/TeamStats'))

export default function App() {
  // Portal routes get their own full-page shell — no main-site Header,
  // no global <main> width constraint, no main-site footer. Inside the
  // portal, PortalLayout provides its own header/wrapper.
  const { pathname } = useLocation()
  const isPortal = pathname.startsWith('/portal')
  const isGm = pathname.startsWith('/gm')

  return (
    <ThemeProvider>
    <PreviewProvider>
    <AuthProvider>
    <AffiliationProvider>
    <MaintenanceLockout>
    <PreviewBanner />
    <GlobalRouteLoader />
    <div className={`min-h-screen transition-colors ${
      isPortal ? 'bg-portal-cream dark:bg-gray-900'
      : isGm ? 'bg-gray-50'
      : 'bg-nw-cream dark:bg-gray-900'
    }`}>
      {!isPortal && !isGm && <Header />}
      <EmailPrefsPopup />
      <RouteContainer isPortal={isPortal} isGm={isGm}>
        <Routes>
          {/* Homepage */}
          <Route path="/" element={<HomepageRouter />} />

          {/* Stats */}
          <Route path="/hitting" element={<BattingLeaderboard />} />
          <Route path="/pitching" element={<PitchingLeaderboard />} />
          <Route path="/fielding" element={<FieldingLeaderboard />} />
          <Route path="/relievers" element={<RelieverLeaderboard />} />
          <Route path="/war" element={<WarLeaderboard />} />
          <Route path="/team-stats" element={<RequireTier minTier="free"><TeamStatsPage /></RequireTier>} />
          <Route path="/scatter" element={<ScatterPlot />} />
          {/* /summerball moved into the Summer tab as /summer/stats.
              Keep this redirect so old bookmarks + share links still land
              on the new page. Drop when we're confident no one's linking. */}
          <Route path="/summerball" element={<Navigate to="/summer/stats" replace />} />
          {/* Summer is locked to devs while we wrap up phase-2 polish.
              Drop the RequireDev wrappers when ready to ship publicly. */}
          <Route path="/summer" element={<RequireAuth><SummerHub /></RequireAuth>} />
          <Route path="/summer/stats" element={<RequireAuth><SummerStatsPage /></RequireAuth>} />
          <Route path="/summer/scoreboard" element={<RequireAuth><SummerScoreboardPage /></RequireAuth>} />
          <Route path="/summer/standings" element={<RequireAuth><SummerStandingsPage /></RequireAuth>} />
          <Route path="/summer/teams" element={<RequireAuth><SummerTeamsPage /></RequireAuth>} />
          <Route path="/summer/teams/:id" element={<RequireAuth><SummerTeamDetail /></RequireAuth>} />
          <Route path="/summer/players/:id" element={<RequireAuth><SummerPlayerDetail /></RequireAuth>} />
          <Route path="/summer/games/:id" element={<RequireAuth><SummerGameDetail /></RequireAuth>} />
          <Route path="/summer/pnw-alumni" element={<RequireAuth><SummerPnwAlumniPage /></RequireAuth>} />
          <Route path="/summer/college-mix" element={<RequireAuth><SummerCollegeMixPage /></RequireAuth>} />
          <Route path="/summer/recap" element={<RequireAuth><WclRecapGraphic /></RequireAuth>} />
          <Route path="/summer/game-recap" element={<RequireAuth><WclGameRecapGraphic /></RequireAuth>} />
          <Route path="/stat-leaders" element={<StatLeaders />} />
          <Route path="/percentiles" element={<RequireTier minTier="free"><Percentiles /></RequireTier>} />
          <Route path="/player-comps" element={<RequireTier minTier="free"><PlayerComps /></RequireTier>} />
          <Route path="/records" element={<RequireTier minTier="free"><RecordsPage /></RequireTier>} />
          <Route path="/playoff-projections" element={<RequireTier minTier="free"><PlayoffProjections /></RequireTier>} />

          {/* Teams */}
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/pro-tracker" element={<ProTracker />} />
          <Route path="/standings" element={<StandingsPage />} />
          <Route path="/results" element={<Navigate to="/scoreboard" replace />} />
          <Route path="/scoreboard" element={<Scoreboard />} />
          <Route path="/game/:gameId" element={<GameDetail />} />
          <Route path="/team/:teamId" element={<TeamDetail />} />
          <Route path="/team-ratings" element={<TeamRatings />} />
          <Route path="/national-rankings" element={<NationalRankings />} />
          <Route path="/team-history" element={<RequireTier minTier="free"><TeamHistory /></RequireTier>} />
          <Route path="/recruiting/quiz" element={<RequireTier minTier="premium"><RecruitQuiz /></RequireTier>} />
          <Route path="/recruiting-classes" element={<RequireTier minTier="premium"><RecruitingClasses /></RequireTier>} />
          <Route path="/recruiting/breakdown" element={<RequireTier minTier="premium"><RecruitingBreakdown /></RequireTier>} />
          <Route path="/recruiting/hometown" element={<RequireTier minTier="premium"><HometownSearch /></RequireTier>} />

          {/* Recruiting (admin only) */}
          <Route path="/recruiting/guide" element={<RequireAdmin><RecruitingGuide /></RequireAdmin>} />
          <Route path="/recruiting/rankings" element={<RequireAdmin><RecruitingRankings /></RequireAdmin>} />
          <Route path="/recruiting/map" element={<RequireAdmin><RecruitingMap /></RequireAdmin>} />
          <Route path="/recruiting/breakdowns" element={<RequireAdmin><AdminRecruitingPlaceholder /></RequireAdmin>} />
          <Route path="/recruiting/history" element={<RequireAdmin><RecruitingHistory /></RequireAdmin>} />
          <Route path="/recruiting/field" element={<RequireAdmin><RecruitingField /></RequireAdmin>} />

          {/* Coaching (auth required) */}
          {/* JUCO + Transfer Portal trackers live in the main-site Coaching
              tab (premium). Old standalone + portal URLs redirect here. */}
          <Route path="/coaching/juco-tracker" element={<RequireTier minTier="recruiting"><JucoTracker /></RequireTier>} />
          <Route path="/coaching/transfer-portal" element={<RequireTier minTier="recruiting"><TransferPortalTracker /></RequireTier>} />
          <Route path="/juco-tracker" element={<Navigate to="/coaching/juco-tracker" replace />} />
          <Route path="/portal/juco-tracker" element={<Navigate to="/coaching/juco-tracker" replace />} />
          <Route path="/compare" element={<RequireAuth><TeamComparison /></RequireAuth>} />
          <Route path="/park-factors" element={<RequireTier minTier="premium"><ParkFactors /></RequireTier>} />

          {/* Team Scouting + Enhanced Scouting moved into the portal; redirect
              old top-level URLs so any external links and bookmarks still work. */}
          <Route path="/team-scouting" element={<Navigate to="/portal/team-scouting" replace />} />
          <Route path="/enhanced-scouting" element={<Navigate to="/portal" replace />} />

          {/* Old URLs → redirect into the portal so bookmarks still work */}
          <Route path="/opponent-trends"
                 element={<Navigate to="/portal/trends" replace />} />
          <Route path="/historic"
                 element={<Navigate to="/portal/historic" replace />} />
          <Route path="/player-scouting"
                 element={<Navigate to="/portal/player-scouting" replace />} />

          {/* Coach & Scouting Portal — locked to PORTAL_OWNERS only.
              Anyone else (including signed-in non-owners) gets bounced
              to the main-site homepage. */}
          <Route path="/portal"
                 element={<RequirePortalAccess><PortalLayout><PortalHome /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/trends"
                 element={<RequirePortalAccess><PortalLayout><OpponentTrends /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/historic"
                 element={<RequirePortalAccess><PortalLayout><HistoricMatchups /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/player-scouting"
                 element={<RequirePortalAccess><PortalLayout><PlayerScouting /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/lineup-helper"
                 element={<RequirePortalAccess><PortalLayout><LineupHelper /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/team-scouting"
                 element={<RequirePortalAccess><PortalLayout><TeamScouting /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/scouting-sheet"
                 element={<RequirePortalAccess><PortalLayout lightOnly><ScoutingSheet /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/scouting-sheet/:teamId"
                 element={<RequirePortalAccess><PortalLayout lightOnly><ScoutingSheet /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/pdfs"
                 element={<RequirePortalAccess><PortalLayout><PortalPDFs /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/pdfs/player-card/:playerId"
                 element={<RequirePortalAccess><PortalLayout lightOnly><PlayerCardPDF /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/pdfs/bulk-player-cards"
                 element={<RequirePortalAccess><PortalLayout lightOnly><BulkPlayerCards /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/bullpen-sheet"
                 element={<RequirePortalAccess><PortalLayout lightOnly><BullpenSheet /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/bullpen-sheet/:teamId"
                 element={<RequirePortalAccess><PortalLayout lightOnly><BullpenSheet /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/catcher-cards"
                 element={<RequirePortalAccess><PortalLayout lightOnly><CatcherCards /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/catcher-cards/:teamId"
                 element={<RequirePortalAccess><PortalLayout lightOnly><CatcherCards /></PortalLayout></RequirePortalAccess>} />
          <Route path="/portal/nwac-tournament-sheet"
                 element={<RequirePortalAccess><PortalLayout lightOnly><NWACTournamentSheet /></PortalLayout></RequirePortalAccess>} />
          {/* News (public) + Articles (author-allowlist only) */}
          <Route path="/news" element={<NewsList />} />
          <Route path="/news/commitments" element={<RequireTier minTier="recruiting"><NewsCommitments /></RequireTier>} />
          <Route path="/news/:slug" element={<NewsArticle />} />
          <Route path="/articles" element={<RequireArticleAuthor><ArticlesList /></RequireArticleAuthor>} />
          <Route path="/articles/new" element={<RequireArticleAuthor><ArticleEditor /></RequireArticleAuthor>} />
          <Route path="/articles/edit/:id" element={<RequireArticleAuthor><ArticleEditor /></RequireArticleAuthor>} />

          {/* Email broadcasts (author-allowlist only) + public unsubscribe page */}
          <Route path="/broadcasts" element={<RequireArticleAuthor><EmailComposer /></RequireArticleAuthor>} />
          <Route path="/unsubscribe" element={<Unsubscribe />} />

          {/* "My Account" — auth required */}
          <Route path="/account" element={<RequireAuth><Account /></RequireAuth>} />
          {/* Pricing / tier comparison — public so anyone can see what each tier gets */}
          <Route path="/pricing" element={<Pricing />} />

          {/* Draft (auth required) */}
          <Route path="/draft" element={<RequireTier minTier="premium"><DraftBoard year="26" /></RequireTier>} />
          <Route path="/draft/2026" element={<RequireTier minTier="premium"><DraftBoard year="26" /></RequireTier>} />
          <Route path="/draft/2027" element={<RequireTier minTier="premium"><DraftBoard year="27" /></RequireTier>} />
          <Route path="/draft/2028" element={<RequireTier minTier="premium"><DraftBoard year="28" /></RequireTier>} />

          {/* Misc (auth required) */}
          <Route path="/top-moments" element={<RequireAuth><TopMoments /></RequireAuth>} />
          <Route path="/pnw-grid" element={<RequireAuth><PnwGrid /></RequireAuth>} />
          <Route path="/team-quiz" element={<RequireAuth><TeamQuiz /></RequireAuth>} />
          <Route path="/all-conference" element={<RequireAuth><AllConferenceGenerator /></RequireAuth>} />
          <Route path="/graphics" element={<RequireAuth><SocialGraphics /></RequireAuth>} />
          <Route path="/graphics-hub" element={<RequireTier minTier="free"><GraphicsHub /></RequireTier>} />
          <Route path="/daily-scores" element={<RequireAuth><DailyScoresGraphic /></RequireAuth>} />
          <Route path="/key-matchup" element={<RequireAuth><KeyMatchupGraphic /></RequireAuth>} />
          <Route path="/series-recap" element={<RequireAuth><SeriesRecapGraphic /></RequireAuth>} />
          <Route path="/tournament-bracket" element={<RequireAuth><TournamentBracketGraphic /></RequireAuth>} />
          <Route path="/daily-recap" element={<RequireAuth><DailyRecapGraphic /></RequireAuth>} />
          <Route path="/feature-request" element={<FeatureRequest />} />
          <Route path="/player-pages" element={<RequireAuth><PlayerGraphic /></RequireAuth>} />
          <Route path="/conference-standings" element={<RequireAuth><ConferenceStandingsGraphic /></RequireAuth>} />
          <Route path="/all-conference-graphic" element={<RequireAuth><AllConferenceGraphic /></RequireAuth>} />
          <Route path="/top-performers-graphic" element={<RequireAuth><TopPerformersGraphic /></RequireAuth>} />
          <Route path="/team-info-graphic" element={<RequireAuth><TeamInfoGraphic /></RequireAuth>} />
          <Route path="/team-season-recap" element={<RequireAuth><TeamSeasonRecapGraphic /></RequireAuth>} />
          <Route path="/players" element={<PlayerSearch />} />

          {/* GM (NW Coaching Simulator — private alpha, locked to dev only) */}
          <Route path="/gm" element={<RequireGmEarlyAccess><GMHome /></RequireGmEarlyAccess>} />
          <Route path="/gm/new" element={<RequireGmEarlyAccess><NewDynasty /></RequireGmEarlyAccess>} />
          <Route path="/gm/dashboard" element={<RequireGmEarlyAccess><Dashboard /></RequireGmEarlyAccess>} />
          <Route path="/gm/roster" element={<RequireGmEarlyAccess><Roster /></RequireGmEarlyAccess>} />
          <Route path="/gm/schedule" element={<RequireGmEarlyAccess><Schedule /></RequireGmEarlyAccess>} />
          <Route path="/gm/standings" element={<RequireGmEarlyAccess><Standings /></RequireGmEarlyAccess>} />
          <Route path="/gm/rankings" element={<RequireGmEarlyAccess><Rankings /></RequireGmEarlyAccess>} />
          <Route path="/gm/budget" element={<RequireGmEarlyAccess><Budget /></RequireGmEarlyAccess>} />
          <Route path="/gm/postseason" element={<RequireGmEarlyAccess><Postseason /></RequireGmEarlyAccess>} />
          <Route path="/gm/recruiting" element={<RequireGmEarlyAccess><Recruiting /></RequireGmEarlyAccess>} />
          <Route path="/gm/career" element={<RequireGmEarlyAccess><Career /></RequireGmEarlyAccess>} />
          <Route path="/gm/coaches" element={<RequireGmEarlyAccess><Coaches /></RequireGmEarlyAccess>} />
          <Route path="/gm/weekly" element={<RequireGmEarlyAccess><WeeklyActions /></RequireGmEarlyAccess>} />
          <Route path="/gm/depth" element={<RequireGmEarlyAccess><DepthChart /></RequireGmEarlyAccess>} />
          <Route path="/gm/play" element={<RequireGmEarlyAccess><Play /></RequireGmEarlyAccess>} />
          <Route path="/gm/calendar" element={<RequireGmEarlyAccess><GMCalendar /></RequireGmEarlyAccess>} />
          <Route path="/gm/summer" element={<RequireGmEarlyAccess><SummerBall /></RequireGmEarlyAccess>} />
          <Route path="/gm/stats" element={<RequireGmEarlyAccess><GMStats /></RequireGmEarlyAccess>} />
          <Route path="/gm/records" element={<RequireGmEarlyAccess><Records /></RequireGmEarlyAccess>} />
          <Route path="/gm/academics" element={<RequireGmEarlyAccess><Academics /></RequireGmEarlyAccess>} />
          <Route path="/gm/teamstats" element={<RequireGmEarlyAccess><TeamStats /></RequireGmEarlyAccess>} />
          <Route path="/gm/player/:playerId" element={<RequireGmEarlyAccess><GMPlayerDetail /></RequireGmEarlyAccess>} />

          {/* About */}
          <Route path="/about" element={<About />} />
          <Route path="/glossary" element={<About />} /> {/* redirect old URL */}

          {/* Auth & Favorites */}
          <Route path="/login" element={<AuthPage />} />
          <Route path="/favorites" element={<FavoritesPage />} />

          {/* Legacy route: redirect old / batting path */}
          <Route path="/player/:playerId" element={<PlayerDetail />} />
        </Routes>
      </RouteContainer>

      {!isPortal && !isGm && (
      <footer className="border-t border-gray-200 mt-12 bg-pnw-slate text-white">
        <div className="max-w-6xl mx-auto px-4 py-8">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-6">
            {/* Brand */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-bold">NW Baseball Stats</span>
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-nw-teal text-white uppercase tracking-wider">Beta</span>
              </div>
              <p className="text-xs text-white/70 leading-relaxed mb-3">
                Advanced analytics for every level of Pacific Northwest college baseball.
              </p>
              <p className="text-xs text-white/70 mb-3">
                For more info on the site, go here:{' '}
                <a href="/about" className="text-white font-semibold hover:underline">About →</a>
              </p>
              <p className="text-xs text-white/70">
                Created by{' '}
                <a href="https://x.com/RasmussenBase" target="_blank" rel="noopener noreferrer" className="text-white font-semibold hover:underline">Nate Rasmussen</a>
              </p>
            </div>

            {/* Links */}
            <div>
              <p className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">Site</p>
              <div className="space-y-1.5">
                <a href="/about" className="block text-xs text-white/80 hover:text-white transition-colors">About & The Team</a>
                <a href="/about#behind" className="block text-xs text-white/80 hover:text-white transition-colors">Behind the Curtain</a>
                <a href="/about#glossary" className="block text-xs text-white/80 hover:text-white transition-colors">Stat Glossary</a>
                <a href="/about#environments" className="block text-xs text-white/80 hover:text-white transition-colors">Run Environments</a>
              </div>
            </div>

            {/* Data + Social */}
            <div>
              <p className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">Data Sources</p>
              <div className="space-y-1.5 mb-4">
                <p className="text-xs text-white/70">D1/D2/D3/NAIA via Sidearm Sports</p>
                <p className="text-xs text-white/70">NWAC via PrestoSports</p>
                <p className="text-xs text-white/70">Summer leagues via PointStreak</p>
              </div>
              <p className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">Follow</p>
              <div className="flex items-center gap-3">
                <a href="https://x.com/NWBBStats" target="_blank" rel="noopener noreferrer" className="text-white/70 hover:text-white transition-colors" aria-label="X (Twitter)">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                </a>
                <a href="https://instagram.com/nwbbstats" target="_blank" rel="noopener noreferrer" className="text-white/70 hover:text-white transition-colors" aria-label="Instagram">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>
                </a>
              </div>
            </div>
          </div>

          {/* Bottom bar */}
          <div className="border-t border-white/10 pt-4 text-center text-[10px] text-white/40">
            &copy; {new Date().getFullYear()} NW Baseball Stats. Not affiliated with the NCAA, NAIA, or NWAC. All stats from public sources.
          </div>
        </div>
      </footer>
      )}
    </div>
    </MaintenanceLockout>
    </AffiliationProvider>
    </AuthProvider>
    </PreviewProvider>
    </ThemeProvider>
  )
}

// On the main site, all routed pages live inside a centered, padded
// <main> wrapper. The portal pages use the full viewport (their own
// PortalLayout handles padding internally), so this helper picks the
// right wrapper based on the current route.
// HomepageRouter — picks the right homepage per tier:
//   • not signed in        → AnonymousHomepage (signup-focused)
//   • signed-in free tier  → FreeHomepage (data-rich + premium nudge)
//   • premium tier         → PremiumHomepage
//   • recruiting tier      → RecruitingHomepage (premium page + recruiting boards)
//   • coach tier / dev     → CoachHomepage (premium page + portal showcase)
// Devs resolve to the 'dev' tier in "My View", so their landing page is
// the coach homepage too.
function HomepageRouter() {
  const { user, loading: authLoading } = useAuth()
  const { tier, loading: tierLoading } = useTier()
  if (authLoading || (user && tierLoading)) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-nw-teal border-t-transparent rounded-full" />
      </div>
    )
  }
  if (!user) return <AnonymousHomepage />
  if (tier === 'free') return <FreeHomepage />
  if (tier === 'premium') return <PremiumHomepage />
  if (tier === 'recruiting') return <RecruitingHomepage />
  if (tier === 'coach' || tier === 'dev') return <CoachHomepage />
  return <Homepage />
}


function RouteContainer({ isPortal, isGm, children }) {
  if (isPortal || isGm) {
    return <>{children}</>
  }
  return (
    <main className="max-w-7xl mx-auto px-2 sm:px-4 py-3 sm:py-6">
      {children}
    </main>
  )
}

