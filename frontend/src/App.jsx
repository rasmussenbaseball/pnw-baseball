import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Header from './components/Header'

// Auth guard - redirects to login if not signed in
function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return <Navigate to="/login" replace />
  return children
}

// Admin-only guard - only allows specific email(s)
const ADMIN_EMAILS = ['nate.rasmussen26@gmail.com', 'pnwcbr@gmail.com']
function RequireAdmin({ children }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return <Navigate to="/login" replace />
  if (!ADMIN_EMAILS.includes(user.email)) return <Navigate to="/" replace />
  return children
}

// ─── Existing pages ───
import BattingLeaderboard from './pages/BattingLeaderboard'
import PitchingLeaderboard from './pages/PitchingLeaderboard'
import WarLeaderboard from './pages/WarLeaderboard'
import TeamsPage from './pages/TeamsPage'
import TeamDetail from './pages/TeamDetail'
import TeamComparison from './pages/TeamComparison'
import ScatterPlot from './pages/ScatterPlot'
import PlayerSearch from './pages/PlayerSearch'
import JucoTracker from './pages/JucoTracker'
import PlayerDetail from './pages/PlayerDetail'
import SocialGraphics from './pages/SocialGraphics'
import DailyScoresGraphic from './pages/DailyScoresGraphic'
import KeyMatchupGraphic from './pages/KeyMatchupGraphic'

// ─── New pages ───
import Homepage from './pages/Homepage'
import SummerballData from './pages/SummerballData'
import StatLeaders from './pages/StatLeaders'
import StandingsPage from './pages/StandingsPage'
// ResultsPage removed - consolidated into Scoreboard with date picker
import GameDetail from './pages/GameDetail'
import TeamRatings from './pages/TeamRatings'
import TeamHistory from './pages/TeamHistory'
import RecruitingClasses from './pages/RecruitingClasses'
import RecruitingRankings from './pages/RecruitingRankings'
import RecruitingMap from './pages/RecruitingMap'
import RecruitingBreakdowns from './pages/RecruitingBreakdowns'
import RecruitingHistory from './pages/RecruitingHistory'
import RecruitingField from './pages/RecruitingField'
import RecruitingGuide from './pages/RecruitingGuide'
import PlayerScouting from './pages/PlayerScouting'
import TeamScouting from './pages/TeamScouting'
import EnhancedScouting from './pages/EnhancedScouting'
import ParkFactors from './pages/ParkFactors'
import DraftBoard from './pages/DraftBoard'
import NationalRankings from './pages/NationalRankings'
import Scoreboard from './pages/Scoreboard'
import About from './pages/About'
import RecruitingBreakdown from './pages/RecruitingBreakdown'
import PnwGrid from './pages/PnwGrid'
import AuthPage from './pages/AuthPage'
import FavoritesPage from './pages/FavoritesPage'
import FeatureRequest from './pages/FeatureRequest'
import PlayerGraphic from './pages/PlayerGraphic'
import HometownSearch from './pages/HometownSearch'
import RecordsPage from './pages/RecordsPage'
import PlayoffProjections from './pages/PlayoffProjections'

export default function App() {
  return (
    <AuthProvider>
    <div className="min-h-screen bg-nw-cream">
      <Header />
      <main className="max-w-7xl mx-auto px-2 sm:px-4 py-3 sm:py-6">
        <Routes>
          {/* Homepage */}
          <Route path="/" element={<Homepage />} />

          {/* Stats */}
          <Route path="/hitting" element={<BattingLeaderboard />} />
          <Route path="/pitching" element={<PitchingLeaderboard />} />
          <Route path="/war" element={<WarLeaderboard />} />
          <Route path="/scatter" element={<ScatterPlot />} />
          <Route path="/summerball" element={<SummerballData />} />
          <Route path="/stat-leaders" element={<StatLeaders />} />
          <Route path="/records" element={<RecordsPage />} />
          <Route path="/playoff-projections" element={<PlayoffProjections />} />

          {/* Teams */}
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/standings" element={<StandingsPage />} />
          <Route path="/results" element={<Navigate to="/scoreboard" replace />} />
          <Route path="/scoreboard" element={<Scoreboard />} />
          <Route path="/game/:gameId" element={<GameDetail />} />
          <Route path="/team/:teamId" element={<TeamDetail />} />
          <Route path="/team-ratings" element={<TeamRatings />} />
          <Route path="/national-rankings" element={<NationalRankings />} />
          <Route path="/team-history" element={<TeamHistory />} />
          <Route path="/recruiting-classes" element={<RecruitingClasses />} />
          <Route path="/recruiting/breakdown" element={<RecruitingBreakdown />} />
          <Route path="/recruiting/hometown" element={<HometownSearch />} />

          {/* Recruiting (admin only) */}
          <Route path="/recruiting/guide" element={<RequireAdmin><RecruitingGuide /></RequireAdmin>} />
          <Route path="/recruiting/rankings" element={<RequireAdmin><RecruitingRankings /></RequireAdmin>} />
          <Route path="/recruiting/map" element={<RequireAdmin><RecruitingMap /></RequireAdmin>} />
          <Route path="/recruiting/breakdowns" element={<RequireAdmin><RecruitingBreakdowns /></RequireAdmin>} />
          <Route path="/recruiting/history" element={<RequireAdmin><RecruitingHistory /></RequireAdmin>} />
          <Route path="/recruiting/field" element={<RequireAdmin><RecruitingField /></RequireAdmin>} />

          {/* Coaching (auth required) */}
          <Route path="/juco-tracker" element={<RequireAuth><JucoTracker /></RequireAuth>} />
          <Route path="/compare" element={<RequireAuth><TeamComparison /></RequireAuth>} />
          <Route path="/player-scouting" element={<RequireAuth><PlayerScouting /></RequireAuth>} />
          <Route path="/team-scouting" element={<RequireAuth><TeamScouting /></RequireAuth>} />
          <Route path="/enhanced-scouting" element={<RequireAuth><EnhancedScouting /></RequireAuth>} />
          <Route path="/park-factors" element={<RequireAuth><ParkFactors /></RequireAuth>} />

          {/* Draft */}
          <Route path="/draft" element={<DraftBoard year="26" />} />
          <Route path="/draft/2026" element={<DraftBoard year="26" />} />
          <Route path="/draft/2027" element={<DraftBoard year="27" />} />
          <Route path="/draft/2028" element={<DraftBoard year="28" />} />

          {/* Misc (auth required) */}
          <Route path="/pnw-grid" element={<RequireAuth><PnwGrid /></RequireAuth>} />
          <Route path="/graphics" element={<RequireAuth><SocialGraphics /></RequireAuth>} />
          <Route path="/daily-scores" element={<RequireAuth><DailyScoresGraphic /></RequireAuth>} />
          <Route path="/key-matchup" element={<RequireAuth><KeyMatchupGraphic /></RequireAuth>} />
          <Route path="/feature-request" element={<RequireAuth><FeatureRequest /></RequireAuth>} />
          <Route path="/player-pages" element={<RequireAuth><PlayerGraphic /></RequireAuth>} />
          <Route path="/players" element={<PlayerSearch />} />

          {/* About */}
          <Route path="/about" element={<About />} />
          <Route path="/glossary" element={<About />} /> {/* redirect old URL */}

          {/* Auth & Favorites */}
          <Route path="/login" element={<AuthPage />} />
          <Route path="/favorites" element={<FavoritesPage />} />

          {/* Legacy route: redirect old / batting path */}
          <Route path="/player/:playerId" element={<PlayerDetail />} />
        </Routes>
      </main>

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
              <p className="text-xs text-white/70">
                Created by{' '}
                <a href="https://x.com/RasmussenBase" target="_blank" rel="noopener noreferrer" className="text-white font-semibold hover:underline">Nate Rasmussen</a>
              </p>
            </div>

            {/* Links */}
            <div>
              <p className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">Site</p>
              <div className="space-y-1.5">
                <a href="/about" className="block text-xs text-white/80 hover:text-white transition-colors">About & Methodology</a>
                <a href="/about#glossary" className="block text-xs text-white/80 hover:text-white transition-colors">Stat Glossary</a>
                <a href="/about#environments" className="block text-xs text-white/80 hover:text-white transition-colors">Run Environments</a>
                <a href="/about#updates" className="block text-xs text-white/80 hover:text-white transition-colors">Site Updates</a>
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
    </div>
    </AuthProvider>
  )
}
