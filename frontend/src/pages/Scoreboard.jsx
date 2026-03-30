import { useState, useEffect } from 'react'
import { useLiveScores } from '../hooks/useApi'

const DIV_COLORS = {
  D1: 'bg-blue-600', D2: 'bg-emerald-600', D3: 'bg-amber-600',
  NAIA: 'bg-red-600', JUCO: 'bg-purple-600',
}

const STATUS_LABELS = {
  live: { text: 'LIVE', class: 'bg-red-500 text-white animate-pulse' },
  scheduled: { text: 'Scheduled', class: 'bg-gray-100 text-gray-500' },
  final: { text: 'Final', class: 'bg-gray-200 text-gray-600' },
}

export default function Scoreboard() {
  const { data, loading, error, refetch } = useLiveScores()
  const [filter, setFilter] = useState('all')

  // Auto-refresh every 2 minutes
  useEffect(() => {
    const interval = setInterval(() => {
      refetch()
    }, 120000)
    return () => clearInterval(interval)
  }, [refetch])

  const todayGames = data?.today || []
  const recentGames = data?.recent || []
  const upcomingGames = data?.upcoming || []
  const lastUpdated = data?.last_updated

  // Filter by division
  const filterGames = (games) => {
    if (filter === 'all') return games
    return games.filter(g => g.team_division === filter)
  }

  const hasLiveGames = todayGames.some(g => g.status === 'live')

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            Scoreboard
            {hasLiveGames && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500 text-white text-xs font-bold animate-pulse">
                <span className="w-1.5 h-1.5 rounded-full bg-white" />
                LIVE
              </span>
            )}
          </h1>
          {lastUpdated && (
            <p className="text-xs text-gray-400 mt-0.5">
              Last updated: {new Date(lastUpdated).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}
            </p>
          )}
        </div>

        {/* Division filter */}
        <div className="flex gap-1.5 flex-wrap">
          {['all', 'D1', 'D2', 'D3', 'NAIA', 'JUCO'].map(d => (
            <button
              key={d}
              onClick={() => setFilter(d)}
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                filter === d
                  ? 'bg-nw-teal text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {d === 'all' ? 'All' : d}
            </button>
          ))}
        </div>
      </div>

      {loading && !data && (
        <div className="text-center py-12 text-gray-400">Loading scoreboard...</div>
      )}

      {error && !data && (
        <div className="text-center py-12 text-red-400">
          Unable to load scores. The live score scraper may not have run yet.
        </div>
      )}

      {data && (
        <>
          {/* Today's Games */}
          {filterGames(todayGames).length > 0 && (
            <Section title="Today's Games" count={filterGames(todayGames).length}>
              <GameGrid games={filterGames(todayGames)} />
            </Section>
          )}

          {filterGames(todayGames).length === 0 && !loading && (
            <div className="bg-white rounded-xl border border-gray-200 p-8 text-center mb-6">
              <div className="text-3xl mb-2">&#9918;</div>
              <p className="text-gray-500 font-medium">No PNW games today</p>
              <p className="text-gray-400 text-sm mt-1">Check back on game days for live scores</p>
            </div>
          )}

          {/* Recent Results */}
          {filterGames(recentGames).length > 0 && (
            <Section title="Recent Results" count={filterGames(recentGames).length}>
              <GameGrid games={filterGames(recentGames)} />
            </Section>
          )}

          {/* Upcoming */}
          {filterGames(upcomingGames).length > 0 && (
            <Section title="Upcoming" count={filterGames(upcomingGames).length}>
              <GameGrid games={filterGames(upcomingGames)} />
            </Section>
          )}
        </>
      )}
    </div>
  )
}


function Section({ title, count, children }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wider">{title}</h2>
        <span className="text-xs text-gray-400">({count})</span>
      </div>
      {children}
    </div>
  )
}


function GameGrid({ games }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {games.map((game, i) => (
        <GameCard key={`${game.id}-${game.team}-${i}`} game={game} />
      ))}
    </div>
  )
}


function GameCard({ game }) {
  const isLive = game.status === 'live'
  const isFinal = game.status === 'final'
  const isScheduled = game.status === 'scheduled'

  const statusInfo = STATUS_LABELS[game.status] || STATUS_LABELS.scheduled

  // Determine which team won (if final)
  const teamScore = game.team_score != null ? parseInt(game.team_score) : null
  const oppScore = game.opponent_score != null ? parseInt(game.opponent_score) : null
  const teamWon = isFinal && teamScore != null && oppScore != null && teamScore > oppScore
  const oppWon = isFinal && teamScore != null && oppScore != null && oppScore > teamScore

  // Format game time
  const gameTime = game.time || ''
  const gameDate = game.date ? new Date(game.date).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  }) : ''

  return (
    <div className={`bg-white rounded-xl border overflow-hidden transition-shadow hover:shadow-md ${
      isLive ? 'border-red-300 shadow-sm shadow-red-100' : 'border-gray-200'
    }`}>
      {/* Status bar */}
      <div className={`flex items-center justify-between px-3 py-1 ${
        isLive ? 'bg-red-50' : 'bg-gray-50'
      }`}>
        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${statusInfo.class}`}>
          {game.game_state_display && game.game_state_display !== 'SCHEDULED'
            ? game.game_state_display
            : statusInfo.text}
        </span>
        <div className="flex items-center gap-1.5">
          {game.team_division && (
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded text-white ${DIV_COLORS[game.team_division] || 'bg-gray-500'}`}>
              {game.team_division}
            </span>
          )}
          {game.is_conference && (
            <span className="text-[9px] text-gray-400">Conf</span>
          )}
        </div>
      </div>

      {/* Teams & Scores */}
      <div className="px-3 py-2">
        {/* Team (away perspective or whatever team we scraped from) */}
        <div className={`flex items-center justify-between py-1 ${oppWon ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {game.team_logo && (
              <img src={game.team_logo} alt="" className="w-5 h-5 object-contain shrink-0"
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <span className="text-sm font-semibold text-gray-800 truncate">{game.team}</span>
          </div>
          {teamScore != null ? (
            <span className={`text-lg font-bold tabular-nums ${teamWon ? 'text-gray-900' : 'text-gray-500'}`}>
              {teamScore}
            </span>
          ) : isScheduled && (
            <span className="text-xs text-gray-300">—</span>
          )}
        </div>

        {/* Opponent */}
        <div className={`flex items-center justify-between py-1 ${teamWon ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {game.opponent_image && (
              <img
                src={game.opponent_image}
                alt=""
                className="w-5 h-5 object-contain shrink-0"
                onError={(e) => { e.target.style.display = 'none' }}
              />
            )}
            <span className="text-sm font-semibold text-gray-800 truncate">
              {game.location === 'away' ? '@ ' : ''}{game.opponent_display || game.opponent}
            </span>
          </div>
          {oppScore != null ? (
            <span className={`text-lg font-bold tabular-nums ${oppWon ? 'text-gray-900' : 'text-gray-500'}`}>
              {oppScore}
            </span>
          ) : isScheduled && (
            <span className="text-xs text-gray-300">—</span>
          )}
        </div>

        {/* Show time prominently for scheduled games */}
        {isScheduled && gameTime && (
          <div className="text-center pt-1 border-t border-gray-100 mt-1">
            <span className="text-xs font-medium text-gray-500">{gameTime}</span>
          </div>
        )}
      </div>

      {/* Footer — date, time, and box score link */}
      <div className="px-3 py-1.5 bg-gray-50 border-t border-gray-100">
        <div className="text-[10px] text-gray-400 flex items-center justify-between">
          <span>{gameDate}</span>
          <div className="flex items-center gap-2">
            {!isScheduled && gameTime && <span>{gameTime}</span>}
            {isFinal && game.box_score_url && (
              <a
                href={game.box_score_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] font-semibold text-nw-teal hover:underline"
              >
                Box Score
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
