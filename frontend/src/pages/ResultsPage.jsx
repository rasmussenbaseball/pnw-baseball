import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useRecentGames } from '../hooks/useApi'

const DIVISION_FILTERS = [
  { value: '', label: 'All Divisions' },
  { value: 'D1', label: 'D1' },
  { value: 'D2', label: 'D2' },
  { value: 'D3', label: 'D3' },
  { value: 'NAIA', label: 'NAIA' },
  { value: 'JUCO', label: 'JUCO' },
]

function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function GameCard({ game }) {
  const homeWon = game.home_score > game.away_score
  const awayWon = game.away_score > game.home_score

  return (
    <Link
      to={`/game/${game.id}`}
      className="block bg-white rounded-lg shadow-sm border border-gray-200 hover:border-nw-teal/30 hover:shadow-md transition-all"
    >
      <div className="px-4 py-3">
        {/* Date & badge row */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">
            {formatDate(game.game_date)}
          </span>
          <div className="flex items-center gap-1.5">
            {game.is_conference_game && (
              <span className="text-[9px] bg-nw-teal/10 text-nw-teal px-1.5 py-0.5 rounded font-semibold">
                CONF
              </span>
            )}
            {game.innings && game.innings !== 9 && (
              <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-semibold">
                {game.innings} INN
              </span>
            )}
          </div>
        </div>

        {/* Away team */}
        <div className={`flex items-center justify-between py-1 ${awayWon ? 'font-bold' : 'text-gray-500'}`}>
          <div className="flex items-center gap-2 min-w-0">
            {game.away_logo && (
              <img
                src={game.away_logo}
                alt=""
                className="w-5 h-5 object-contain shrink-0"
                onError={(e) => { e.target.style.display = 'none' }}
              />
            )}
            <span className="text-sm truncate">
              {game.away_short || game.away_team_name || 'Away'}
            </span>
          </div>
          <span className={`text-sm font-mono tabular-nums ${awayWon ? 'text-gray-900' : 'text-gray-400'}`}>
            {game.away_score}
          </span>
        </div>

        {/* Home team */}
        <div className={`flex items-center justify-between py-1 ${homeWon ? 'font-bold' : 'text-gray-500'}`}>
          <div className="flex items-center gap-2 min-w-0">
            {game.home_logo && (
              <img
                src={game.home_logo}
                alt=""
                className="w-5 h-5 object-contain shrink-0"
                onError={(e) => { e.target.style.display = 'none' }}
              />
            )}
            <span className="text-sm truncate">
              {game.home_short || game.home_team_name || 'Home'}
            </span>
          </div>
          <span className={`text-sm font-mono tabular-nums ${homeWon ? 'text-gray-900' : 'text-gray-400'}`}>
            {game.home_score}
          </span>
        </div>

        {/* Score extras */}
        {(game.home_hits != null || game.away_hits != null) && (
          <div className="flex items-center justify-between mt-1 pt-1 border-t border-gray-50 text-[10px] text-gray-400">
            <span>H: {game.away_hits ?? '-'} / {game.home_hits ?? '-'}</span>
            <span>E: {game.away_errors ?? '-'} / {game.home_errors ?? '-'}</span>
          </div>
        )}
      </div>
    </Link>
  )
}

export default function ResultsPage() {
  const [division, setDivision] = useState('')
  const [season] = useState(2026)

  const { data: games, loading, error } = useRecentGames(season, 100, null, division || null)

  // Group games by date
  const gamesByDate = {}
  if (games) {
    games.forEach(g => {
      const dateKey = g.game_date || 'Unknown'
      if (!gamesByDate[dateKey]) gamesByDate[dateKey] = []
      gamesByDate[dateKey].push(g)
    })
  }

  const sortedDates = Object.keys(gamesByDate).sort((a, b) => b.localeCompare(a))

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-pnw-slate">Results</h1>
        <div className="flex items-center gap-2">
          {DIVISION_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => setDivision(f.value)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                division === f.value
                  ? 'bg-nw-teal text-white'
                  : 'bg-gray-100 text-gray-500 hover:text-gray-700'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-nw-teal border-t-transparent" />
        </div>
      ) : error ? (
        <div className="text-center text-red-600 py-10">Error loading results: {error}</div>
      ) : !games || games.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <p className="text-lg font-medium">No games found</p>
          <p className="text-sm mt-1">Game data will appear here once box scores are scraped.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {sortedDates.map(dateKey => (
            <div key={dateKey}>
              <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-2">
                {formatDate(dateKey)}
              </h2>
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {gamesByDate[dateKey].map(game => (
                  <GameCard key={game.id} game={game} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
