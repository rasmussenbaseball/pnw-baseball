import { Routes, Route } from 'react-router-dom'
import Header from './components/Header'

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

// ─── New pages ───
import Homepage from './pages/Homepage'
import SummerballData from './pages/SummerballData'
import StatLeaders from './pages/StatLeaders'
import StandingsPage from './pages/StandingsPage'
import TeamRatings from './pages/TeamRatings'
import TeamHistory from './pages/TeamHistory'
import RecruitingClasses from './pages/RecruitingClasses'
import RecruitingRankings from './pages/RecruitingRankings'
import RecruitingMap from './pages/RecruitingMap'
import RecruitingBreakdowns from './pages/RecruitingBreakdowns'
import RecruitingHistory from './pages/RecruitingHistory'
import RecruitingField from './pages/RecruitingField'
import PlayerScouting from './pages/PlayerScouting'
import TeamScouting from './pages/TeamScouting'
import EnhancedScouting from './pages/EnhancedScouting'
import ParkFactors from './pages/ParkFactors'
import DraftBoard from './pages/DraftBoard'
import NationalRankings from './pages/NationalRankings'
import Glossary from './pages/Glossary'

export default function App() {
  return (
    <div className="min-h-screen bg-nw-cream">
      <Header />
      <main className="max-w-7xl mx-auto px-4 py-6">
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

          {/* Teams */}
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/standings" element={<StandingsPage />} />
          <Route path="/team/:teamId" element={<TeamDetail />} />
          <Route path="/team-ratings" element={<TeamRatings />} />
          <Route path="/national-rankings" element={<NationalRankings />} />
          <Route path="/team-history" element={<TeamHistory />} />
          <Route path="/recruiting-classes" element={<RecruitingClasses />} />

          {/* Recruiting */}
          <Route path="/recruiting/rankings" element={<RecruitingRankings />} />
          <Route path="/recruiting/map" element={<RecruitingMap />} />
          <Route path="/recruiting/breakdowns" element={<RecruitingBreakdowns />} />
          <Route path="/recruiting/history" element={<RecruitingHistory />} />
          <Route path="/recruiting/field" element={<RecruitingField />} />

          {/* Coaching */}
          <Route path="/juco-tracker" element={<JucoTracker />} />
          <Route path="/compare" element={<TeamComparison />} />
          <Route path="/player-scouting" element={<PlayerScouting />} />
          <Route path="/team-scouting" element={<TeamScouting />} />
          <Route path="/enhanced-scouting" element={<EnhancedScouting />} />
          <Route path="/park-factors" element={<ParkFactors />} />

          {/* Draft */}
          <Route path="/draft/2026" element={<DraftBoard year="26" />} />
          <Route path="/draft/2027" element={<DraftBoard year="27" />} />
          <Route path="/draft/2028" element={<DraftBoard year="28" />} />

          {/* Misc */}
          <Route path="/graphics" element={<SocialGraphics />} />
          <Route path="/players" element={<PlayerSearch />} />

          {/* Glossary */}
          <Route path="/glossary" element={<Glossary />} />

          {/* Legacy route: redirect old / batting path */}
          <Route path="/player/:playerId" element={<PlayerDetail />} />
        </Routes>
      </main>

      <footer className="border-t border-nw-teal/10 mt-12 py-6 text-center text-xs text-gray-400">
        NW Baseball Stats — Pacific Northwest College Baseball Analytics
      </footer>
    </div>
  )
}
