import { Routes, Route, Navigate, useLocation, Link } from 'react-router-dom'
import { Suspense } from 'react'
import { lazyWithRetry } from './lib/lazyWithRetry'
import { AuthProvider, useAuth } from './context/AuthContext'
import { AffiliationProvider } from './context/AffiliationContext'
import { ThemeProvider } from './context/ThemeContext'
import MaintenanceLockout from './components/MaintenanceLockout'
import GlobalRouteLoader from './components/GlobalRouteLoader'
import { isDeveloper, COMMITMENT_EDITOR_EMAILS } from './lib/tiers'
import Header from './components/Header'
import EmailPrefsPopup from './components/EmailPrefsPopup'

// Sign-in guard for tools that store YOUR OWN data (TrackMan / Rapsodo /
// Blast / Camp uploads, recruiting boards, favorites). Everything built on
// public data is open without an account; these need an identity so the
// site knows whose workspace to show. Renders a blurred teaser + prompt.
function RequireSignIn({ children }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return (
    <div className="relative">
      <div className="filter blur-sm opacity-60 pointer-events-none select-none" aria-hidden="true">
        {children}
      </div>
      <div className="absolute inset-0 flex items-start justify-center pt-24 bg-white/40 dark:bg-gray-900/40">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-6 sm:p-8 max-w-sm w-full text-center mx-4">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-nw-teal/10 dark:bg-nw-teal/20 rounded-full mb-3">
            <svg className="w-6 h-6 text-nw-teal" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-nw-teal dark:text-gray-100 mb-1">Sign in to use this tool</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
            This tool saves your own uploads and lists, so it needs an account to know whose data to show.
            Accounts are free and take a few seconds. Everything else on the site is open without one.
          </p>
          <div className="space-y-2">
            <a
              href="/login?tab=signup"
              className="block w-full px-4 py-2.5 bg-nw-teal text-white text-sm font-semibold rounded-lg hover:bg-nw-teal-dark transition-colors"
            >
              Create a free account
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

// Article-author allowlist — only these emails see the "Articles" item
// in the Misc dropdown and reach /articles management routes. Public
// reading at /news stays open to everyone. Owner-only: developers/interns
// are intentionally NOT granted authoring or email-broadcast access.
// Mirror ARTICLE_AUTHOR_EMAILS in lib/tiers.js + articles.py.
export const ARTICLE_AUTHOR_EMAILS = [
  'nate.rasmussen26@gmail.com',
  'pnwcbr@gmail.com',
  'olearyjoe101@gmail.com',
]

// Email broadcasts stay owner-only — stricter than article authoring.
// Mirror _BROADCAST_OWNER_EMAILS in email_broadcasts.py + lib/tiers.js.
export const BROADCAST_OWNER_EMAILS = [
  'nate.rasmussen26@gmail.com',
  'pnwcbr@gmail.com',
]

function RequireEmail({ emails, children }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return <Navigate to="/login" replace />
  const email = (user.email || '').toLowerCase()
  if (!emails.includes(email)) {
    return <Navigate to="/news" replace />
  }
  return children
}

function RequireArticleAuthor({ children }) {
  return <RequireEmail emails={ARTICLE_AUTHOR_EMAILS}>{children}</RequireEmail>
}

function RequireBroadcastOwner({ children }) {
  return <RequireEmail emails={BROADCAST_OWNER_EMAILS}>{children}</RequireEmail>
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

function GmRoute({ children }) {
  // The NW Coaching Simulator is open to everyone. Suspense boundary so the
  // lazy-loaded GM chunk shows a themed loading screen on first visit.
  return <Suspense fallback={<GmChunkLoading />}>{children}</Suspense>
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
const WclRecapGraphic = lazyWithRetry(() => import('./pages/WclRecapGraphic'))
const WclGameRecapGraphic = lazyWithRetry(() => import('./pages/WclGameRecapGraphic'))
const WclLeaderboardGraphic = lazyWithRetry(() => import('./pages/WclLeaderboardGraphic'))
const RecruitingClassRankingsGraphic = lazyWithRetry(() => import('./pages/RecruitingClassRankingsGraphic'))
const ProjectionLeaderboardGraphic = lazyWithRetry(() => import('./pages/ProjectionLeaderboardGraphic'))
const TransferPortalGraphic = lazyWithRetry(() => import('./pages/TransferPortalGraphic'))
const CommitmentEditor = lazyWithRetry(() => import('./pages/CommitmentEditor'))
const WclStandingsGraphic = lazyWithRetry(() => import('./pages/WclStandingsGraphic'))
// Hidden page — intentionally not linked from any nav/footer.
const KangarooCourt = lazyWithRetry(() => import('./pages/KangarooCourt'))
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
import PnwDraft from './pages/PnwDraft'
import TeamDetail from './pages/TeamDetail'
import TeamProjections from './pages/TeamProjections'
import TrackManData from './pages/TrackManData'
import TeamComparison from './pages/TeamComparison'
import ScatterPlot from './pages/ScatterPlot'
import PlayerSearch from './pages/PlayerSearch'
import JucoTracker from './pages/JucoTracker'
import TransferPortalTracker from './pages/TransferPortalTracker'
import WclTransferTracker from './pages/WclTransferTracker'
import PlayerDetail from './pages/PlayerDetail'
// Social-graphic generators: admin/author tools, never on a
// visitor's path — lazy so their ~8k lines stay out of the main bundle.
const SocialGraphics = lazyWithRetry(() => import('./pages/SocialGraphics'))
const DailyScoresGraphic = lazyWithRetry(() => import('./pages/DailyScoresGraphic'))
const KeyMatchupGraphic = lazyWithRetry(() => import('./pages/KeyMatchupGraphic'))
const SeriesRecapGraphic = lazyWithRetry(() => import('./pages/SeriesRecapGraphic'))
const TournamentBracketGraphic = lazyWithRetry(() => import('./pages/TournamentBracketGraphic'))
const DailyRecapGraphic = lazyWithRetry(() => import('./pages/DailyRecapGraphic'))

// ─── New pages ───
// June 2026: the five per-tier homepages were replaced by the unified
// Homepage (their files remain on disk as a rollback path, unimported).
import Homepage from './pages/Homepage'
import StatLeaders from './pages/StatLeaders'
import StandingsPage from './pages/StandingsPage'
import ConferencePage from './pages/ConferencePage'
// ResultsPage removed - consolidated into Scoreboard with date picker
import GameDetail from './pages/GameDetail'
import TeamRatings from './pages/TeamRatings'
import TeamHistory from './pages/TeamHistory'
import RecruitingHub from './pages/RecruitingHub'  // public landing page (all tiers)
import RecruitingClasses from './pages/RecruitingClasses'
import RecruitQuiz from './pages/RecruitQuiz'
import RecruitingRankings from './pages/RecruitingRankings'
import RecruitingMap from './pages/RecruitingMap'
import AdminRecruitingPlaceholder from './pages/AdminRecruitingPlaceholder'
import RecruitingHistory from './pages/RecruitingHistory'
import RecruitingField from './pages/RecruitingField'
const RecruitingGuide = lazyWithRetry(() => import('./pages/RecruitingGuide'))  // recharts
const RecruitingProgramGuide = lazyWithRetry(() => import('./pages/RecruitingProgramGuide'))  // react-pdf (heavy)
const RecruitingTips = lazyWithRetry(() => import('./pages/RecruitingTips'))
const NwacAdvancement = lazyWithRetry(() => import('./pages/NwacAdvancement'))
// Coach-portal scouting + print/PDF pages (coach tier only) — lazy.
const PlayerScouting = lazyWithRetry(() => import('./pages/PlayerScouting'))
const TeamScouting = lazyWithRetry(() => import('./pages/TeamScouting'))
const SeriesPlanner = lazyWithRetry(() => import('./pages/SeriesPlanner'))
const MatchupCalculator = lazyWithRetry(() => import('./pages/portal/MatchupCalculator'))
const CampReport = lazyWithRetry(() => import('./pages/portal/CampReport'))
const TrackmanSuite = lazyWithRetry(() => import('./pages/TrackmanSuite'))
const BlastLab = lazyWithRetry(() => import('./pages/BlastLab'))
const Alignments = lazyWithRetry(() => import('./pages/Alignments'))
const PocketCards = lazyWithRetry(() => import('./pages/PocketCards'))
const SplitsExplorer = lazyWithRetry(() => import('./pages/SplitsExplorer'))
const ScoutingSheet = lazyWithRetry(() => import('./pages/ScoutingSheet'))
const CustomSheet = lazyWithRetry(() => import('./pages/CustomSheet'))
const CustomPlayerCard = lazyWithRetry(() => import('./pages/CustomPlayerCard'))
const PlayerCardPDF = lazyWithRetry(() => import('./pages/PlayerCardPDF'))
const BulkPlayerCards = lazyWithRetry(() => import('./pages/BulkPlayerCards'))
const PortalPDFs = lazyWithRetry(() => import('./pages/PortalPDFs'))
const BullpenSheet = lazyWithRetry(() => import('./pages/BullpenSheet'))
const CatcherCards = lazyWithRetry(() => import('./pages/CatcherCards'))
import NewsList from './pages/NewsList'
const NewsArticle = lazyWithRetry(() => import('./pages/NewsArticle'))  // pulls react-markdown — lazy to split it off the main bundle
import NewsCommitments from './pages/NewsCommitments'
const GraphicsHub = lazyWithRetry(() => import('./pages/GraphicsHub'))
import ArticlesList from './pages/portal/ArticlesList'
const ArticleEditor = lazyWithRetry(() => import('./pages/portal/ArticleEditor'))  // author-only, react-markdown
const EmailComposer = lazyWithRetry(() => import('./pages/portal/EmailComposer'))  // author-only, react-markdown
import Unsubscribe from './pages/Unsubscribe'
import Account from './pages/Account'
import Terms from './pages/Terms'
import Privacy from './pages/Privacy'
const OpponentTrends = lazyWithRetry(() => import('./pages/OpponentTrends'))  // big coach-portal page
const HistoricMatchups = lazyWithRetry(() => import('./pages/HistoricMatchups'))
const LineupHelper = lazyWithRetry(() => import('./pages/LineupHelper'))  // ~1,150 lines, coach-only
import ParkFactors from './pages/ParkFactors'
// Coach & Scouting Portal
import PortalLayout from './components/PortalLayout'
const PortalHome = lazyWithRetry(() => import('./pages/PortalHome'))  // recharts, coach portal
const RapsodoAnalyzer = lazyWithRetry(() => import('./pages/RapsodoAnalyzer'))  // coach Rapsodo lab
import DraftBoard from './pages/DraftBoard'
import NationalRankings from './pages/NationalRankings'
import Scoreboard from './pages/Scoreboard'
const About = lazyWithRetry(() => import('./pages/About'))  // recharts run-environment chart
import RecruitingBreakdown from './pages/RecruitingBreakdown'
const PnwGrid = lazyWithRetry(() => import('./pages/PnwGrid'))  // ~1,050 lines, niche game
import TopMoments from './pages/TopMoments'
const AllConferenceGenerator = lazyWithRetry(() => import('./pages/AllConferenceGenerator'))
import AuthPage from './pages/AuthPage'
import ResetPassword from './pages/ResetPassword'
import FavoritesPage from './pages/FavoritesPage'
import FeatureRequest from './pages/FeatureRequest'
const PlayerGraphic = lazyWithRetry(() => import('./pages/PlayerGraphic'))
const ConferenceStandingsGraphic = lazyWithRetry(() => import('./pages/ConferenceStandingsGraphic'))
const AllConferenceGraphic = lazyWithRetry(() => import('./pages/AllConferenceGraphic'))
const TopPerformersGraphic = lazyWithRetry(() => import('./pages/TopPerformersGraphic'))
const DraftBoardGraphic = lazyWithRetry(() => import('./pages/DraftBoardGraphic'))
const TeamInfoGraphic = lazyWithRetry(() => import('./pages/TeamInfoGraphic'))
const TeamSeasonRecapGraphic = lazyWithRetry(() => import('./pages/TeamSeasonRecapGraphic'))
import HometownSearch from './pages/HometownSearch'
import RecordsPage from './pages/RecordsPage'
const PlayoffProjections = lazyWithRetry(() => import('./pages/PlayoffProjections'))  // ~950 lines, recharts
import Percentiles from './pages/Percentiles'
import PlayerComps from './pages/PlayerComps'
import PlayerComparison from './pages/PlayerComparison'
const CatcherDefense = lazyWithRetry(() => import('./pages/CatcherDefense'))
const RecruitingBoard = lazyWithRetry(() => import('./pages/RecruitingBoard'))
const SharedRecruitingBoard = lazyWithRetry(() => import('./pages/SharedRecruitingBoard'))  // public read-only board via share link
import TeamQuiz from './pages/TeamQuiz'
const FieldGuessr = lazyWithRetry(() => import('./pages/FieldGuessr'))  // image-based ballpark guessing game
const PnwPickle = lazyWithRetry(() => import('./pages/PnwPickle'))  // guess-the-player game

// ─── GM (new section, isolated from existing site code) ───
// GM dynasty game pages — lazy-loaded so visitors to the main analytics
// site don't download the ~1.5MB game bundle. Triggered on first /gm/*
// navigation. The Vite manualChunks config pools these into a single
// `gm-ui` chunk, so the very first /gm/ hit pays one download for all
// dynasty pages.
const GMHome = lazyWithRetry(() => import('./pages/gm/GMHome'))
const NewDynasty = lazyWithRetry(() => import('./pages/gm/NewDynasty'))
const Dashboard = lazyWithRetry(() => import('./pages/gm/Dashboard'))
const Roster = lazyWithRetry(() => import('./pages/gm/Roster'))
const Schedule = lazyWithRetry(() => import('./pages/gm/Schedule'))
const Standings = lazyWithRetry(() => import('./pages/gm/Standings'))
const Rankings = lazyWithRetry(() => import('./pages/gm/Rankings'))
const Budget = lazyWithRetry(() => import('./pages/gm/Budget'))
const Postseason = lazyWithRetry(() => import('./pages/gm/Postseason'))
const Recruiting = lazyWithRetry(() => import('./pages/gm/Recruiting'))
const Career = lazyWithRetry(() => import('./pages/gm/Career'))
const GMPlayerDetail = lazyWithRetry(() => import('./pages/gm/PlayerDetail'))
const Coaches = lazyWithRetry(() => import('./pages/gm/Coaches'))
const WeeklyActions = lazyWithRetry(() => import('./pages/gm/WeeklyActions'))
const DepthChart = lazyWithRetry(() => import('./pages/gm/DepthChart'))
const Play = lazyWithRetry(() => import('./pages/gm/Play'))
const GMCalendar = lazyWithRetry(() => import('./pages/gm/Calendar'))
const SummerBall = lazyWithRetry(() => import('./pages/gm/SummerBall'))
const GMStats = lazyWithRetry(() => import('./pages/gm/Stats'))
const Records = lazyWithRetry(() => import('./pages/gm/Records'))
const Academics = lazyWithRetry(() => import('./pages/gm/Academics'))
const TeamStats = lazyWithRetry(() => import('./pages/gm/TeamStats'))

export default function App() {
  // Portal routes get their own full-page shell — no main-site Header,
  // no global <main> width constraint, no main-site footer. Inside the
  // portal, PortalLayout provides its own header/wrapper.
  const { pathname } = useLocation()
  const isPortal = pathname.startsWith('/portal')
  const isGm = pathname.startsWith('/gm')
  // Kangaroo Court is a hidden standalone page — no site header/footer.
  const isKcourt = pathname.startsWith('/kcourt')

  return (
    <ThemeProvider>
    <AuthProvider>
    <AffiliationProvider>
    <MaintenanceLockout>
    <GlobalRouteLoader />
    <div className={`min-h-screen transition-colors ${
      isPortal ? 'bg-portal-cream dark:bg-gray-900'
      : isGm ? 'bg-gray-50'
      : isKcourt ? 'bg-[#101a38]'
      : 'bg-nw-cream dark:bg-gray-900'
    }`}>
      {!isPortal && !isGm && !isKcourt && <Header />}
      <EmailPrefsPopup />
      <RouteContainer isPortal={isPortal} isGm={isGm} isKcourt={isKcourt}>
        <Suspense fallback={<div className="min-h-[60vh]" />}>
        <Routes>
          {/* Homepage */}
          <Route path="/" element={<HomepageRouter />} />

          {/* Stats */}
          <Route path="/hitting" element={<BattingLeaderboard />} />
          <Route path="/pitching" element={<PitchingLeaderboard />} />
          <Route path="/fielding" element={<FieldingLeaderboard />} />
          <Route path="/relievers" element={<RelieverLeaderboard />} />
          <Route path="/war" element={<WarLeaderboard />} />
          <Route path="/team-stats" element={<TeamStatsPage />} />
          <Route path="/scatter" element={<ScatterPlot />} />
          {/* /summerball moved into the Summer tab as /summer/stats.
              Keep this redirect so old bookmarks + share links still land
              on the new page. Drop when we're confident no one's linking. */}
          <Route path="/summerball" element={<Navigate to="/summer/stats" replace />} />
          {/* Summer is locked to devs while we wrap up phase-2 polish.
              Open to everyone. */}
          <Route path="/summer" element={<SummerHub />} />
          <Route path="/summer/stats" element={<SummerStatsPage />} />
          {/* Power Index merged into the Standings page (2026-06) */}
          <Route path="/summer/cpi" element={<Navigate to="/summer/standings" replace />} />
          <Route path="/summer/scoreboard" element={<SummerScoreboardPage />} />
          <Route path="/summer/standings" element={<SummerStandingsPage />} />
          <Route path="/summer/teams" element={<SummerTeamsPage />} />
          <Route path="/summer/teams/:id" element={<SummerTeamDetail />} />
          <Route path="/summer/players/:id" element={<SummerPlayerDetail />} />
          <Route path="/summer/games/:id" element={<SummerGameDetail />} />
          <Route path="/summer/pnw-alumni" element={<SummerPnwAlumniPage />} />
          <Route path="/summer/college-mix" element={<SummerCollegeMixPage />} />
          <Route path="/summer/recap" element={<WclRecapGraphic />} />
          <Route path="/summer/game-recap" element={<WclGameRecapGraphic />} />
          <Route path="/stat-leaders" element={<StatLeaders />} />
          <Route path="/percentiles" element={<Percentiles />} />
          <Route path="/player-comps" element={<PlayerComps />} />
          <Route path="/records" element={<RecordsPage />} />
          <Route path="/playoff-projections" element={<PlayoffProjections />} />

          {/* Teams */}
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/projections" element={<TeamProjections />} />
          <Route path="/projections/graphic" element={<ProjectionLeaderboardGraphic />} />
          <Route path="/trackman-data" element={<RequireDev><TrackManData /></RequireDev>} />
          <Route path="/commitment-editor" element={<RequireDev emails={COMMITMENT_EDITOR_EMAILS}><CommitmentEditor /></RequireDev>} />
          <Route path="/pro-tracker" element={<ProTracker />} />
          <Route path="/draft" element={<PnwDraft />} />
          <Route path="/standings" element={<StandingsPage />} />
          <Route path="/conference/:slug" element={<ConferencePage />} />
          <Route path="/results" element={<Navigate to="/scoreboard" replace />} />
          <Route path="/scoreboard" element={<Scoreboard />} />
          <Route path="/game/:gameId" element={<GameDetail />} />
          <Route path="/team/:teamId" element={<TeamDetail />} />
          <Route path="/team-ratings" element={<TeamRatings />} />
          <Route path="/national-rankings" element={<NationalRankings />} />
          <Route path="/team-history" element={<TeamHistory />} />
          {/* Public landing page for the whole Recruiting tab (all tiers, no gate) */}
          <Route path="/recruiting" element={<RecruitingHub />} />
          {/* Matchmaker is open to EVERYONE (anonymous included) as a funnel:
              non-paid users only see their #1 fit — the full ranked list is
              gated inside RecruitQuiz.jsx at premium. */}
          <Route path="/recruiting/quiz" element={<RecruitQuiz />} />
          <Route path="/recruiting-classes" element={<RecruitingClasses />} />
          <Route path="/recruiting/breakdown" element={<RecruitingBreakdown />} />
          <Route path="/recruiting/hometown" element={<HometownSearch />} />

          {/* Recruiting guides are public; the in-page editor stays admin-only
              (gated inside RecruitingGuide + admin PUT). */}
          <Route path="/recruiting/guide" element={<RecruitingGuide />} />
          <Route path="/recruiting/program-guide" element={<RecruitingProgramGuide />} />
          <Route path="/recruiting/tips" element={<RecruitingTips />} />
          <Route path="/recruiting/advancement" element={<NwacAdvancement />} />
          <Route path="/recruiting/rankings" element={<RequireAdmin><RecruitingRankings /></RequireAdmin>} />
          <Route path="/recruiting/map" element={<RecruitingMap />} />
          <Route path="/recruiting/breakdowns" element={<RequireAdmin><AdminRecruitingPlaceholder /></RequireAdmin>} />
          <Route path="/recruiting/history" element={<RequireAdmin><RecruitingHistory /></RequireAdmin>} />
          <Route path="/recruiting/field" element={<RequireAdmin><RecruitingField /></RequireAdmin>} />

          {/* Coaching tools. JUCO + Transfer Portal trackers live in the
              main-site Coaching tab; old standalone + portal URLs redirect here. */}
          <Route path="/coaching/juco-tracker" element={<JucoTracker />} />
          <Route path="/coaching/transfer-portal" element={<TransferPortalTracker />} />
          <Route path="/coaching/wcl-portal" element={<WclTransferTracker />} />
          <Route path="/coaching/player-comparison" element={<PlayerComparison />} />
          <Route path="/coaching/catcher-defense" element={<CatcherDefense />} />
          {/* Recruiting boards store per-user lists, so they need a sign-in. */}
          <Route path="/coaching/recruiting-board" element={<RequireSignIn><RecruitingBoard /></RequireSignIn>} />
          {/* Public read-only board view via share link — no auth. */}
          <Route path="/recruiting-board/shared/:token" element={<SharedRecruitingBoard />} />
          <Route path="/juco-tracker" element={<Navigate to="/coaching/juco-tracker" replace />} />
          <Route path="/portal/juco-tracker" element={<Navigate to="/coaching/juco-tracker" replace />} />
          <Route path="/compare" element={<TeamComparison />} />
          <Route path="/park-factors" element={<ParkFactors />} />

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

          {/* Coach & Scouting Portal — open to everyone. The upload tools
              inside (TrackMan, Rapsodo, Blast, Camp) ask for a sign-in because
              they store per-user data. */}
          <Route path="/portal"
                 element={<PortalLayout noGate><PortalHome /></PortalLayout>} />
          <Route path="/portal/trends"
                 element={<PortalLayout><OpponentTrends /></PortalLayout>} />
          <Route path="/portal/historic"
                 element={<PortalLayout><HistoricMatchups /></PortalLayout>} />
          <Route path="/portal/player-scouting"
                 element={<PortalLayout><PlayerScouting /></PortalLayout>} />
          <Route path="/portal/rapsodo"
                 element={<PortalLayout><RequireSignIn><RapsodoAnalyzer /></RequireSignIn></PortalLayout>} />
          <Route path="/portal/lineup-helper"
                 element={<PortalLayout><LineupHelper /></PortalLayout>} />
          <Route path="/portal/team-scouting"
                 element={<PortalLayout><TeamScouting /></PortalLayout>} />
          <Route path="/portal/series-planner"
                 element={<PortalLayout><SeriesPlanner /></PortalLayout>} />
          <Route path="/portal/matchup-calculator"
                 element={<PortalLayout><MatchupCalculator /></PortalLayout>} />
          <Route path="/portal/trackman"
                 element={<PortalLayout><RequireSignIn><TrackmanSuite /></RequireSignIn></PortalLayout>} />
          <Route path="/portal/blast"
                 element={<PortalLayout><RequireSignIn><BlastLab /></RequireSignIn></PortalLayout>} />
          <Route path="/portal/camp-report"
                 element={<PortalLayout><RequireSignIn><CampReport /></RequireSignIn></PortalLayout>} />
          <Route path="/portal/alignments"
                 element={<PortalLayout><Alignments /></PortalLayout>} />
          <Route path="/portal/alignments/cards"
                 element={<PortalLayout lightOnly><PocketCards /></PortalLayout>} />
          {/* Retired Advance Report → Series Planner (keeps old deep links alive via ?team_id fallback) */}
          <Route path="/portal/advance-report"
                 element={<PortalLayout><SeriesPlanner /></PortalLayout>} />
          <Route path="/portal/splits"
                 element={<PortalLayout><SplitsExplorer /></PortalLayout>} />
          <Route path="/portal/custom-sheet"
                 element={<PortalLayout lightOnly><CustomSheet /></PortalLayout>} />
          <Route path="/portal/custom-card"
                 element={<PortalLayout lightOnly><CustomPlayerCard /></PortalLayout>} />
          <Route path="/portal/scouting-sheet"
                 element={<PortalLayout lightOnly><ScoutingSheet /></PortalLayout>} />
          <Route path="/portal/scouting-sheet/:teamId"
                 element={<PortalLayout lightOnly><ScoutingSheet /></PortalLayout>} />
          <Route path="/portal/pdfs"
                 element={<PortalLayout><PortalPDFs /></PortalLayout>} />
          <Route path="/portal/pdfs/player-card/:playerId"
                 element={<PortalLayout lightOnly><PlayerCardPDF /></PortalLayout>} />
          <Route path="/portal/pdfs/bulk-player-cards"
                 element={<PortalLayout lightOnly><BulkPlayerCards /></PortalLayout>} />
          <Route path="/portal/bullpen-sheet"
                 element={<PortalLayout lightOnly><BullpenSheet /></PortalLayout>} />
          <Route path="/portal/bullpen-sheet/:teamId"
                 element={<PortalLayout lightOnly><BullpenSheet /></PortalLayout>} />
          <Route path="/portal/catcher-cards"
                 element={<PortalLayout lightOnly><CatcherCards /></PortalLayout>} />
          <Route path="/portal/catcher-cards/:teamId"
                 element={<PortalLayout lightOnly><CatcherCards /></PortalLayout>} />
          {/* News (public) + Articles (author-allowlist only) */}
          <Route path="/news" element={<NewsList />} />
          <Route path="/news/commitments" element={<NewsCommitments />} />
          <Route path="/news/:slug" element={<NewsArticle />} />
          <Route path="/articles" element={<RequireArticleAuthor><ArticlesList /></RequireArticleAuthor>} />
          <Route path="/articles/new" element={<RequireArticleAuthor><ArticleEditor /></RequireArticleAuthor>} />
          <Route path="/articles/edit/:id" element={<RequireArticleAuthor><ArticleEditor /></RequireArticleAuthor>} />

          {/* Email broadcasts (author-allowlist only) + public unsubscribe page */}
          <Route path="/broadcasts" element={<RequireBroadcastOwner><EmailComposer /></RequireBroadcastOwner>} />
          <Route path="/unsubscribe" element={<Unsubscribe />} />

          {/* "My Account" — sign-in required */}
          <Route path="/account" element={<RequireSignIn><Account /></RequireSignIn>} />
          {/* The site is free; old pricing links land on About. */}
          <Route path="/pricing" element={<Navigate to="/about" replace />} />

          {/* Legal */}
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />

          {/* MLB Draft Board (auth required). Lives at /draftboard; /draft is the 56-0 game. */}
          <Route path="/draftboard" element={<DraftBoard year="26" />} />
          <Route path="/draftboard/2026" element={<DraftBoard year="26" />} />
          <Route path="/draftboard/2027" element={<DraftBoard year="27" />} />
          <Route path="/draftboard/2028" element={<DraftBoard year="28" />} />
          {/* Old /draft/* draft-board links redirect to the new path */}
          <Route path="/draft/2026" element={<Navigate to="/draftboard/2026" replace />} />
          <Route path="/draft/2027" element={<Navigate to="/draftboard/2027" replace />} />
          <Route path="/draft/2028" element={<Navigate to="/draftboard/2028" replace />} />

          {/* Misc (auth required) */}
          <Route path="/top-moments" element={<TopMoments />} />
          <Route path="/pnw-grid" element={<PnwGrid />} />
          <Route path="/team-quiz" element={<TeamQuiz />} />
          <Route path="/fieldguessr" element={<FieldGuessr />} />
          <Route path="/pnw-pickle" element={<PnwPickle />} />
          <Route path="/all-conference" element={<AllConferenceGenerator />} />
          <Route path="/graphics" element={<SocialGraphics />} />
          <Route path="/graphics/wcl-leaderboards" element={<WclLeaderboardGraphic />} />
          <Route path="/graphics/recruiting-classes" element={<RecruitingClassRankingsGraphic />} />
          <Route path="/graphics/portal-tracker" element={<TransferPortalGraphic />} />
          <Route path="/graphics/wcl-standings" element={<WclStandingsGraphic />} />
          <Route path="/graphics-hub" element={<GraphicsHub />} />
          <Route path="/daily-scores" element={<DailyScoresGraphic />} />
          <Route path="/key-matchup" element={<KeyMatchupGraphic />} />
          <Route path="/series-recap" element={<SeriesRecapGraphic />} />
          <Route path="/tournament-bracket" element={<TournamentBracketGraphic />} />
          <Route path="/daily-recap" element={<DailyRecapGraphic />} />
          <Route path="/feature-request" element={<FeatureRequest />} />
          <Route path="/kcourt" element={<KangarooCourt />} />
          <Route path="/player-pages" element={<PlayerGraphic />} />
          <Route path="/conference-standings" element={<ConferenceStandingsGraphic />} />
          <Route path="/all-conference-graphic" element={<AllConferenceGraphic />} />
          <Route path="/top-performers-graphic" element={<TopPerformersGraphic />} />
          <Route path="/wcl-top-performers-graphic" element={<TopPerformersGraphic variant="summer" />} />
          <Route path="/draft-board-graphic" element={<DraftBoardGraphic />} />
          <Route path="/team-info-graphic" element={<TeamInfoGraphic />} />
          <Route path="/team-season-recap" element={<TeamSeasonRecapGraphic />} />
          <Route path="/players" element={<PlayerSearch />} />

          {/* GM (NW Coaching Simulator — private alpha, locked to dev only) */}
          <Route path="/gm" element={<GmRoute><GMHome /></GmRoute>} />
          <Route path="/gm/new" element={<GmRoute><NewDynasty /></GmRoute>} />
          <Route path="/gm/dashboard" element={<GmRoute><Dashboard /></GmRoute>} />
          <Route path="/gm/roster" element={<GmRoute><Roster /></GmRoute>} />
          <Route path="/gm/schedule" element={<GmRoute><Schedule /></GmRoute>} />
          <Route path="/gm/standings" element={<GmRoute><Standings /></GmRoute>} />
          <Route path="/gm/rankings" element={<GmRoute><Rankings /></GmRoute>} />
          <Route path="/gm/budget" element={<GmRoute><Budget /></GmRoute>} />
          <Route path="/gm/postseason" element={<GmRoute><Postseason /></GmRoute>} />
          <Route path="/gm/recruiting" element={<GmRoute><Recruiting /></GmRoute>} />
          <Route path="/gm/career" element={<GmRoute><Career /></GmRoute>} />
          <Route path="/gm/coaches" element={<GmRoute><Coaches /></GmRoute>} />
          <Route path="/gm/weekly" element={<GmRoute><WeeklyActions /></GmRoute>} />
          <Route path="/gm/depth" element={<GmRoute><DepthChart /></GmRoute>} />
          <Route path="/gm/play" element={<GmRoute><Play /></GmRoute>} />
          <Route path="/gm/calendar" element={<GmRoute><GMCalendar /></GmRoute>} />
          <Route path="/gm/summer" element={<GmRoute><SummerBall /></GmRoute>} />
          <Route path="/gm/stats" element={<GmRoute><GMStats /></GmRoute>} />
          <Route path="/gm/records" element={<GmRoute><Records /></GmRoute>} />
          <Route path="/gm/academics" element={<GmRoute><Academics /></GmRoute>} />
          <Route path="/gm/teamstats" element={<GmRoute><TeamStats /></GmRoute>} />
          <Route path="/gm/player/:playerId" element={<GmRoute><GMPlayerDetail /></GmRoute>} />

          {/* About */}
          <Route path="/about" element={<About />} />
          <Route path="/glossary" element={<About />} /> {/* redirect old URL */}

          {/* Auth & Favorites */}
          <Route path="/login" element={<AuthPage />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/favorites" element={<RequireSignIn><FavoritesPage /></RequireSignIn>} />

          {/* Legacy route: redirect old / batting path */}
          <Route path="/player/:playerId" element={<PlayerDetail />} />
        </Routes>
        </Suspense>
      </RouteContainer>

      {!isPortal && !isGm && !isKcourt && (
      <footer className="border-t border-gray-200 mt-12 bg-nw-teal text-white">
        <div className="max-w-6xl mx-auto px-4 py-8">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
            {/* Brand */}
            <div className="col-span-2 lg:col-span-1">
              <div className="text-sm font-bold mb-2">NW Baseball Stats</div>
              <p className="text-xs text-white/70 leading-relaxed mb-3 max-w-xs">
                Advanced analytics for every level of Pacific Northwest college baseball, plus recruiting and summer-ball coverage.
              </p>
              <p className="text-xs text-white/70">
                Created by{' '}
                <a href="https://x.com/RasmussenBase" target="_blank" rel="noopener noreferrer" className="text-white font-semibold hover:underline">Nate Rasmussen</a>
              </p>
            </div>

            {/* Explore */}
            <div>
              <p className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">Explore</p>
              <div className="space-y-1.5">
                <Link to="/stat-leaders" className="block text-xs text-white/80 hover:text-white transition-colors">Stat Leaders</Link>
                <Link to="/standings" className="block text-xs text-white/80 hover:text-white transition-colors">Standings</Link>
                <Link to="/players" className="block text-xs text-white/80 hover:text-white transition-colors">Players</Link>
                <Link to="/recruiting" className="block text-xs text-white/80 hover:text-white transition-colors">Recruiting</Link>
                <Link to="/summer" className="block text-xs text-white/80 hover:text-white transition-colors">Summer / WCL</Link>
                <Link to="/scoreboard" className="block text-xs text-white/80 hover:text-white transition-colors">Scoreboard</Link>
              </div>
            </div>

            {/* Site */}
            <div>
              <p className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">Site</p>
              <div className="space-y-1.5">
                <Link to="/about" className="block text-xs text-white/80 hover:text-white transition-colors">About & The Team</Link>
                <a href="/about#behind" className="block text-xs text-white/80 hover:text-white transition-colors">Behind the Curtain</a>
                <a href="/about#glossary" className="block text-xs text-white/80 hover:text-white transition-colors">Stat Glossary</a>
                <Link to="/feature-request" className="block text-xs text-white/80 hover:text-white transition-colors">Feedback</Link>
              </div>
            </div>

            {/* Data + Social */}
            <div>
              <p className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">Data Sources</p>
              <div className="space-y-1.5 mb-4">
                <p className="text-xs text-white/70">NCAA D1&ndash;D3 &amp; NAIA via Sidearm Sports</p>
                <p className="text-xs text-white/70">NWAC via PrestoSports</p>
                <p className="text-xs text-white/70">Summer leagues (WCL) via wclstats.com</p>
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
          <div className="border-t border-white/10 pt-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-[10px] text-white/40">
            <span>&copy; {new Date().getFullYear()} NW Baseball Stats. Not affiliated with the NCAA, NAIA, or NWAC. All stats from public sources.</span>
            <span className="flex items-center gap-3">
              <Link to="/terms" className="hover:text-white/80 transition-colors">Terms</Link>
              <Link to="/privacy" className="hover:text-white/80 transition-colors">Privacy</Link>
            </span>
          </div>
        </div>
      </footer>
      )}
    </div>
    </MaintenanceLockout>
    </AffiliationProvider>
    </AuthProvider>
    </ThemeProvider>
  )
}

// On the main site, all routed pages live inside a centered, padded
// <main> wrapper. The portal pages use the full viewport (their own
// PortalLayout handles padding internally), so this helper picks the
// right wrapper based on the current route.
function HomepageRouter() {
  // June 2026 redesign: ONE homepage for every tier (per Nate). The five
  // per-tier homepages (Anonymous/Free/Premium/Recruiting/Coach) are
  // retired from routing; their files remain for now as a rollback path.
  return <Homepage />
}


function RouteContainer({ isPortal, isGm, isKcourt, children }) {
  if (isPortal || isGm || isKcourt) {
    return <>{children}</>
  }
  return (
    <main className="max-w-7xl mx-auto px-2 sm:px-4 py-3 sm:py-6">
      {children}
    </main>
  )
}

