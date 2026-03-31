import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStatLeaders, useNationalRankings, useTeamRatings, useGamesTicker, useLiveScores } from '../hooks/useApi'
import { divisionBadgeClass } from '../utils/stats'
import { useAuth } from '../context/AuthContext'

const SEASON = 2026

// ─── Stat value formatting ───
function fmtVal(value, format) {
  if (value == null) return '-'
  if (format === 'int') return Math.round(value)
  if (format === 'avg') return value.toFixed(3).replace(/^0/, '')
  if (format === 'float1') return value.toFixed(1)
  if (format === 'float2') return value.toFixed(2)
  if (format === 'pct') return (value * 100).toFixed(1) + '%'
  return value
}

// ─── Division badge colors for inline use ───
const DIV_COLORS = {
  D1: 'bg-blue-600', D2: 'bg-emerald-600', D3: 'bg-amber-600',
  NAIA: 'bg-red-600', JUCO: 'bg-purple-600',
}

export default function Homepage() {
  const { data: leaders } = useStatLeaders(SEASON, 5, true)
  const { data: rankings } = useNationalRankings(SEASON)
  const { data: ratings } = useTeamRatings(SEASON)
  const { data: recentGames } = useGamesTicker(SEASON, 20)
  const { data: liveData } = useLiveScores()
  const { user } = useAuth()

  // Only show live ticker when games are actually in progress
  const todayGames = liveData?.today || []
  const hasLiveGames = todayGames.some(g => g.status === 'live')

  return (
    <div>
      {/* Game results ticker — shows live ticker only when games are in progress, otherwise recent results */}
      {hasLiveGames && (
        <LiveGamesTicker games={todayGames} hasLive={hasLiveGames} />
      )}
      <GameResultsTicker games={recentGames} />

      {/* Hero ticker - stat leaders marquee */}
      <LeaderTicker leaders={leaders} />

      {/* Main dashboard grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-5 mt-3 sm:mt-5">
        {/* Left column - wider (2/3) */}
        <div className="lg:col-span-2 flex flex-col gap-5">
          <NationalRankingsWidget rankings={rankings} />
          <StatLeadersWidget leaders={leaders} />
        </div>

        {/* Right column - sidebar (1/3) */}
        <div className="flex flex-col gap-5">
          <PowerRankingsWidget ratings={ratings} />
          <PnwGridWidget />
          {!user && <SignUpWidget />}
          <QuickLinksWidget />
        </div>
      </div>
    </div>
  )
}


// ════════════════════════════════════════════
// GAME RESULTS TICKER (horizontal scroll of recent scores)
// ════════════════════════════════════════════
function GameResultsTicker({ games }) {
  if (!games || games.length === 0) return null

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden mb-3">
      <div className="flex items-center">
        <div className="flex-none px-3 py-2 bg-pnw-slate text-white">
          <Link to="/results" className="text-[10px] uppercase tracking-wider font-bold hover:text-teal-300 transition-colors">
            Scores
          </Link>
        </div>
        <div className="flex overflow-x-auto scrollbar-hide gap-0 divide-x divide-gray-100 flex-1">
          {games.map((g) => {
            const homeWon = g.home_score > g.away_score
            return (
              <Link
                key={g.id}
                to={`/game/${g.id}`}
                className="flex-none px-3 py-1.5 hover:bg-gray-50 transition-colors min-w-[120px]"
              >
                {/* Away */}
                <div className={`flex items-center justify-between gap-2 ${homeWon ? 'text-gray-400' : 'font-semibold text-gray-800'}`}>
                  <div className="flex items-center gap-1 min-w-0">
                    {g.away_logo && (
                      <img src={g.away_logo} alt="" className="w-3.5 h-3.5 object-contain shrink-0"
                        onError={(e) => { e.target.style.display = 'none' }} />
                    )}
                    <span className="text-[11px] truncate">{g.away_name}</span>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums">{g.away_score}</span>
                </div>
                {/* Home */}
                <div className={`flex items-center justify-between gap-2 ${homeWon ? 'font-semibold text-gray-800' : 'text-gray-400'}`}>
                  <div className="flex items-center gap-1 min-w-0">
                    {g.home_logo && (
                      <img src={g.home_logo} alt="" className="w-3.5 h-3.5 object-contain shrink-0"
                        onError={(e) => { e.target.style.display = 'none' }} />
                    )}
                    <span className="text-[11px] truncate">{g.home_name}</span>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums">{g.home_score}</span>
                </div>
                {/* Date */}
                <div className="text-[9px] text-gray-300 text-center mt-0.5">
                  {g.game_date ? new Date(g.game_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
                  {g.innings && g.innings !== 9 ? ` (${g.innings})` : ''}
                </div>
              </Link>
            )
          })}
        </div>
        <Link to="/results" className="flex-none px-3 py-2 text-nw-teal hover:text-nw-teal/70 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>
    </div>
  )
}


// ════════════════════════════════════════════
// LIVE GAMES TICKER (shows today's games with live indicators)
// ════════════════════════════════════════════
function LiveGamesTicker({ games, hasLive }) {
  if (!games || games.length === 0) return null

  return (
    <div className={`bg-white rounded-xl shadow-sm border overflow-hidden mb-3 ${hasLive ? 'border-red-200' : 'border-gray-200'}`}>
      <div className="flex items-center">
        <div className={`flex-none px-3 py-2 ${hasLive ? 'bg-red-600' : 'bg-pnw-slate'} text-white`}>
          <Link to="/scoreboard" className="text-[10px] uppercase tracking-wider font-bold hover:text-teal-300 transition-colors flex items-center gap-1">
            {hasLive && <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
            {hasLive ? 'Live' : 'Recent'}
          </Link>
        </div>
        <div className="flex overflow-x-auto scrollbar-hide gap-0 divide-x divide-gray-100 flex-1">
          {games.map((g, i) => {
            const isLive = g.status === 'live'
            const isFinal = g.status === 'final'
            const teamScore = g.team_score != null ? parseInt(g.team_score) : null
            const oppScore = g.opponent_score != null ? parseInt(g.opponent_score) : null
            const teamWon = isFinal && teamScore > oppScore
            const oppWon = isFinal && oppScore > teamScore

            return (
              <Link
                key={`${g.id}-${g.team}-${i}`}
                to="/scoreboard"
                className={`flex-none px-3 py-1.5 hover:bg-gray-50 transition-colors min-w-[130px] ${isLive ? 'bg-red-50/50' : ''}`}
              >
                {/* Team */}
                <div className={`flex items-center justify-between gap-2 ${oppWon ? 'text-gray-400' : 'font-semibold text-gray-800'}`}>
                  <div className="flex items-center gap-1 min-w-0">
                    {g.team_logo && (
                      <img src={g.team_logo} alt="" className="w-3.5 h-3.5 object-contain shrink-0"
                        onError={(e) => { e.target.style.display = 'none' }} />
                    )}
                    <span className="text-[11px] truncate">{g.team}</span>
                  </div>
                  {teamScore != null ? (
                    <span className="text-[11px] font-mono tabular-nums">{teamScore}</span>
                  ) : null}
                </div>
                {/* Opponent */}
                <div className={`flex items-center justify-between gap-2 ${teamWon ? 'text-gray-400' : 'font-semibold text-gray-800'}`}>
                  <div className="flex items-center gap-1 min-w-0">
                    {g.opponent_logo && (
                      <img src={g.opponent_logo} alt="" className="w-3.5 h-3.5 object-contain shrink-0"
                        onError={(e) => { e.target.style.display = 'none' }} />
                    )}
                    <span className="text-[11px] truncate">{g.location === 'away' ? '@ ' : ''}{g.opponent}</span>
                  </div>
                  {oppScore != null ? (
                    <span className="text-[11px] font-mono tabular-nums">{oppScore}</span>
                  ) : null}
                </div>
                {/* Status */}
                <div className="text-[9px] text-center mt-0.5">
                  {isLive ? (
                    <span className="text-red-500 font-bold animate-pulse">
                      {g.game_state_display && g.game_state_display !== 'SCHEDULED' ? g.game_state_display : 'LIVE'}
                    </span>
                  ) : isFinal ? (
                    <span className="text-gray-300">Final</span>
                  ) : (
                    <span className="text-gray-300">{g.time || 'TBD'}</span>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
        <Link to="/scoreboard" className="flex-none px-3 py-2 text-nw-teal hover:text-nw-teal/70 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>
    </div>
  )
}


// ════════════════════════════════════════════
// LEADER TICKER (top bar, scrolling stat leaders)
// ════════════════════════════════════════════
function LeaderTicker({ leaders }) {
  if (!leaders) return null

  const allLeaders = [
    ...(leaders.batting || []),
    ...(leaders.pitching || []),
  ]

  return (
    <div className="bg-pnw-slate rounded-xl overflow-hidden">
      <div className="flex overflow-x-auto scrollbar-hide gap-0 divide-x divide-gray-600">
        {allLeaders.map((cat) => {
          const top = cat.leaders?.[0]
          if (!top) return null
          return (
            <Link
              key={cat.key}
              to={cat.key === 'era' || cat.key === 'strikeouts' || cat.key === 'pitching_war' || cat.key === 'fip_plus' || cat.key === 'quality_starts' || cat.key === 'k_minus_bb_pct'
                ? '/pitching' : '/hitting'}
              className="flex-none px-3 sm:px-4 py-2 sm:py-2.5 hover:bg-white/5 transition-colors min-w-0"
            >
              <div className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">{cat.label} Leader</div>
              <div className="flex items-center gap-2 mt-0.5">
                {top.logo_url && (
                  <img src={top.logo_url} alt="" className="w-5 h-5 object-contain"
                    onError={(e) => { e.target.style.display = 'none' }} />
                )}
                <span className="text-sm text-white font-semibold truncate">
                  {top.first_name[0]}. {top.last_name}
                </span>
                <span className="text-sm text-pnw-teal font-bold ml-auto">
                  {fmtVal(top.value, cat.format)}
                </span>
              </div>
              <div className="text-[10px] text-gray-500 truncate">{top.short_name}</div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}


// ════════════════════════════════════════════
// NATIONAL RANKINGS WIDGET
// ════════════════════════════════════════════
function NationalRankingsWidget({ rankings }) {
  if (!rankings) return <WidgetSkeleton title="National Rankings" />

  // Show top 5 per division (skip JUCO)
  const divisions = (rankings.divisions || []).filter(d => d.division_level !== 'JUCO')

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-3 sm:p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm sm:text-base font-bold text-pnw-slate">National Rankings</h2>
        <Link to="/national-rankings" className="text-xs text-pnw-teal hover:underline">View all →</Link>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3">
        {divisions.map((div) => (
          <div key={div.division_level}>
            <div className={`text-[10px] sm:text-xs font-bold text-white px-2 py-1 rounded-t ${DIV_COLORS[div.division_level] || 'bg-gray-600'}`}>
              {div.division_level}
            </div>
            <div className="border border-t-0 border-gray-200 rounded-b">
              {div.teams.slice(0, 5).map((team, i) => (
                <Link
                  key={team.team_id}
                  to={`/team/${team.team_id}`}
                  className={`flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-1 sm:py-1.5 text-[11px] sm:text-xs hover:bg-gray-50 ${
                    i < div.teams.length - 1 && i < 4 ? 'border-b border-gray-100' : ''
                  }`}
                >
                  <span className="text-gray-400 w-4 text-right font-mono text-[9px] sm:text-[10px] shrink-0">
                    {Math.round(team.composite_rank)}
                  </span>
                  {team.logo_url && (
                    <img src={team.logo_url} alt="" className="w-3.5 h-3.5 sm:w-4 sm:h-4 object-contain shrink-0"
                      onError={(e) => { e.target.style.display = 'none' }} />
                  )}
                  <span className="font-medium text-gray-800 truncate flex-1 min-w-0">{team.short_name}</span>
                  <span className="text-gray-400 text-[9px] sm:text-[10px] shrink-0 hidden sm:inline">{team.record}</span>
                  {team.national_percentile && (
                    <span className={`text-[9px] sm:text-[10px] font-semibold px-0.5 sm:px-1 rounded shrink-0 ${
                      team.national_percentile >= 75 ? 'text-green-700 bg-green-50'
                      : team.national_percentile >= 50 ? 'text-amber-700 bg-amber-50'
                      : 'text-gray-500'
                    }`}>
                      {team.national_percentile.toFixed(0)}%
                    </span>
                  )}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


// ════════════════════════════════════════════
// STAT LEADERS WIDGET (main area, top 5 per category)
// ════════════════════════════════════════════
function StatLeadersWidget({ leaders }) {
  if (!leaders) return <WidgetSkeleton title="Stat Leaders" />

  const battingCats = leaders.batting || []
  const pitchingCats = leaders.pitching || []

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-3 sm:p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm sm:text-base font-bold text-pnw-slate">Stat Leaders</h2>
        <Link to="/stat-leaders" className="text-xs text-pnw-teal hover:underline">View all →</Link>
      </div>

      {/* Batting */}
      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Batting</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-3 mb-4">
        {battingCats.map(cat => (
          <LeaderCategory key={cat.key} cat={cat} type="batting" />
        ))}
      </div>

      {/* Pitching */}
      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Pitching</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-3">
        {pitchingCats.map(cat => (
          <LeaderCategory key={cat.key} cat={cat} type="pitching" />
        ))}
      </div>
    </div>
  )
}

function LeaderCategory({ cat, type }) {
  const linkTo = type === 'pitching' ? '/pitching' : '/hitting'
  return (
    <div>
      <Link to={linkTo} className="text-xs font-semibold text-pnw-slate hover:text-pnw-teal transition-colors mb-1 block">
        {cat.label}
      </Link>
      {cat.leaders?.slice(0, 5).map((p, i) => (
        <Link
          key={p.player_id}
          to={`/player/${p.player_id}`}
          className={`flex items-center gap-1 py-[3px] text-xs hover:bg-gray-50 rounded px-1 -mx-1 ${p.is_qualified === false ? 'italic text-gray-400' : ''}`}
        >
          <span className={`w-3.5 text-right font-mono text-[10px] shrink-0 ${
            i === 0 ? 'text-amber-500 font-bold' : 'text-gray-400'
          }`}>
            {i + 1}
          </span>
          {p.logo_url && (
            <img src={p.logo_url} alt="" className="w-3.5 h-3.5 object-contain shrink-0"
              onError={(e) => { e.target.style.display = 'none' }} />
          )}
          <span className="text-gray-700 truncate flex-1 min-w-0">
            {p.first_name[0]}. {p.last_name}
          </span>
          <span className="font-bold text-pnw-slate font-mono text-[11px] shrink-0">
            {fmtVal(p.value, cat.format)}
          </span>
        </Link>
      ))}
    </div>
  )
}


// ════════════════════════════════════════════
// POWER RANKINGS WIDGET (team WAR / PPI)
// ════════════════════════════════════════════
function PowerRankingsWidget({ ratings }) {
  const [selectedDiv, setSelectedDiv] = useState('all')
  if (!ratings) return <WidgetSkeleton title="Power Rankings" />

  // API returns an array of division objects directly
  const divisions = Array.isArray(ratings) ? ratings : (ratings.divisions || [])
  // Flatten all teams and sort by total WAR
  let allTeams = []
  divisions.forEach(div => {
    (div.teams || []).forEach(t => {
      allTeams.push({
        ...t,
        team_id: t.team_id || t.id,
        division_level: t.division_level || div.division_level,
        record: t.record || `${t.wins}-${t.losses}`,
      })
    })
  })
  allTeams.sort((a, b) => (b.team_war || 0) - (a.team_war || 0))

  if (selectedDiv !== 'all') {
    allTeams = allTeams.filter(t => t.division_level === selectedDiv)
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-base font-bold text-pnw-slate">Power Rankings</h2>
        <Link to="/team-ratings" className="text-xs text-pnw-teal hover:underline">View all →</Link>
      </div>

      <div className="flex gap-1 mb-2.5 flex-wrap">
        {['all', 'D1', 'D2', 'D3', 'NAIA'].map(d => (
          <button
            key={d}
            onClick={() => setSelectedDiv(d)}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              selectedDiv === d
                ? 'bg-pnw-teal text-white'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            {d === 'all' ? 'All' : d}
          </button>
        ))}
      </div>

      <div className="space-y-0">
        {allTeams.slice(0, 10).map((team, i) => (
          <Link
            key={team.team_id}
            to={`/team/${team.team_id}`}
            className="flex items-center gap-1.5 py-1 text-xs hover:bg-gray-50 rounded px-1 -mx-1 border-b border-gray-50 last:border-0"
          >
            <span className={`w-4 text-right font-mono text-[10px] ${
              i < 3 ? 'text-amber-500 font-bold' : 'text-gray-400'
            }`}>
              {i + 1}
            </span>
            <span className={`w-1.5 h-1.5 rounded-full ${DIV_COLORS[team.division_level] || 'bg-gray-400'}`} />
            {team.logo_url && (
              <img src={team.logo_url} alt="" className="w-4 h-4 object-contain"
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <span className="font-medium text-gray-800 truncate flex-1">{team.short_name}</span>
            <span className="text-gray-400 text-[10px]">{team.record}</span>
            <span className="font-bold text-pnw-slate font-mono text-[11px] w-8 text-right">
              {team.team_war?.toFixed(1) || '0.0'}
            </span>
          </Link>
        ))}
      </div>
      <div className="text-[10px] text-gray-400 text-right mt-1">Ranked by Team WAR</div>
    </div>
  )
}


// ════════════════════════════════════════════
// PNW GRID WIDGET (daily trivia game link)
// ════════════════════════════════════════════
function PnwGridWidget() {
  return (
    <Link
      to="/pnw-grid"
      className="block bg-gradient-to-br from-pnw-slate to-pnw-slate/90 rounded-xl shadow-sm border border-gray-100 p-4 hover:shadow-md transition-shadow group"
    >
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-pnw-teal/20 rounded-lg flex items-center justify-center shrink-0">
          <svg className="w-6 h-6 text-pnw-teal" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-white group-hover:text-pnw-teal transition-colors">
            PNW Grid
          </div>
          <div className="text-[11px] text-gray-400">
            Daily trivia game — test your PNW baseball knowledge
          </div>
        </div>
        <svg className="w-4 h-4 text-gray-500 group-hover:text-pnw-teal transition-colors shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </Link>
  )
}


// ════════════════════════════════════════════
// SIGN UP CTA WIDGET (shown only to logged-out users)
// ════════════════════════════════════════════
function SignUpWidget() {
  return (
    <div className="bg-gradient-to-br from-pnw-teal/5 to-pnw-teal/10 rounded-xl shadow-sm border border-pnw-teal/20 p-4">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 bg-pnw-teal/15 rounded-full flex items-center justify-center shrink-0 mt-0.5">
          <svg className="w-5 h-5 text-pnw-teal" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-bold text-pnw-slate">Create a Free Account</h3>
          <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
            Sign up with your email to unlock coaching tools, JUCO tracker, matchup breakdowns, social graphics, and more.
          </p>
        </div>
      </div>
      <Link
        to="/login"
        className="mt-3 block w-full text-center px-4 py-2 bg-pnw-teal text-white text-sm font-semibold rounded-lg hover:bg-pnw-teal/90 transition-colors"
      >
        Sign Up Free
      </Link>
      <p className="text-[10px] text-gray-400 text-center mt-2">
        No credit card required — just an email address
      </p>
    </div>
  )
}


// ════════════════════════════════════════════
// QUICK LINKS WIDGET
// ════════════════════════════════════════════
function QuickLinksWidget() {
  const links = [
    { to: '/juco-tracker', label: 'JUCO Tracker', desc: 'Uncommitted sophomores' },
    { to: '/war', label: 'WAR Leaders', desc: 'Top players by WAR' },
    { to: '/hitting', label: 'Batting Leaders', desc: 'Full batting leaderboard' },
    { to: '/pitching', label: 'Pitching Leaders', desc: 'Full pitching leaderboard' },
    { to: '/compare', label: 'Team Compare', desc: 'Head-to-head team stats' },
    { to: '/glossary', label: 'Glossary', desc: 'Stat definitions & methodology' },
  ]

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <h2 className="text-base font-bold text-pnw-slate mb-2">Quick Links</h2>
      <div className="grid grid-cols-2 gap-1.5">
        {links.map(link => (
          <Link
            key={link.to}
            to={link.to}
            className="px-2.5 py-2 rounded-lg border border-gray-100 hover:border-pnw-teal hover:bg-pnw-teal/5 transition-colors"
          >
            <div className="text-xs font-semibold text-pnw-slate">{link.label}</div>
            <div className="text-[10px] text-gray-400">{link.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  )
}


// ════════════════════════════════════════════
// LOADING SKELETON
// ════════════════════════════════════════════
function WidgetSkeleton({ title }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <h2 className="text-base font-bold text-pnw-slate mb-3">{title}</h2>
      <div className="animate-pulse space-y-2">
        <div className="h-3 bg-gray-200 rounded w-3/4" />
        <div className="h-3 bg-gray-200 rounded w-1/2" />
        <div className="h-3 bg-gray-200 rounded w-2/3" />
        <div className="h-3 bg-gray-200 rounded w-1/2" />
      </div>
    </div>
  )
}
