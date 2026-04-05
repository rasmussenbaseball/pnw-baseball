import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useLiveScores, useGamesByDate } from '../hooks/useApi'

const DIV_COLORS = {
  D1: 'bg-blue-600', D2: 'bg-emerald-600', D3: 'bg-amber-600',
  NAIA: 'bg-red-600', JUCO: 'bg-purple-600',
}

const STATUS_LABELS = {
  live: { text: 'LIVE', class: 'bg-red-500 text-white animate-pulse' },
  scheduled: { text: 'Scheduled', class: 'bg-gray-100 text-gray-500' },
  final: { text: 'Final', class: 'bg-gray-200 text-gray-600' },
}

/** Format YYYY-MM-DD as "Fri, Apr 4" */
function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

/** Get today in Pacific time as YYYY-MM-DD */
function getTodayPacific() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
}

/** Shift a YYYY-MM-DD string by n days */
function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}


export default function Scoreboard() {
  const todayStr = getTodayPacific()
  const [selectedDate, setSelectedDate] = useState(todayStr)
  const [filter, setFilter] = useState('all')

  const isToday = selectedDate === todayStr

  // Live scores for today (auto-refresh)
  const { data: liveData, loading: liveLoading, error: liveError, refetch } = useLiveScores()

  // DB games for past/future dates
  const { data: dbData, loading: dbLoading, error: dbError } = useGamesByDate(isToday ? null : selectedDate)

  // Auto-refresh live scores every 2 minutes (only when viewing today)
  useEffect(() => {
    if (!isToday) return
    const interval = setInterval(() => refetch(), 120000)
    return () => clearInterval(interval)
  }, [isToday, refetch])

  // Determine which data to display
  const loading = isToday ? liveLoading : dbLoading
  const error = isToday ? liveError : dbError

  // Normalize games into a common format
  const games = useMemo(() => {
    if (isToday) {
      const today = liveData?.today || []
      const recent = liveData?.recent || []
      const upcoming = liveData?.upcoming || []
      // Tag each game with its section for grouping
      return [
        ...today.map(g => ({ ...g, _source: 'live', _section: 'today' })),
        ...recent.map(g => ({ ...g, _source: 'live', _section: 'recent' })),
        ...upcoming.map(g => ({ ...g, _source: 'live', _section: 'upcoming' })),
      ]
    }
    // DB games — normalize to a consistent shape
    return (dbData?.games || []).map(g => ({
      ...g,
      _source: 'db',
      _section: 'date',
    }))
  }, [isToday, liveData, dbData])

  // Filter by division
  const filteredGames = useMemo(() => {
    if (filter === 'all') return games
    return games.filter(g => {
      if (g._source === 'live') return g.team_division === filter
      // DB games have home_division and away_division
      return g.home_division === filter || g.away_division === filter
    })
  }, [games, filter])

  // Group games by section
  const todayGames = filteredGames.filter(g => g._section === 'today')
  const recentGames = filteredGames.filter(g => g._section === 'recent')
  const upcomingGames = filteredGames.filter(g => g._section === 'upcoming')
  const dateGames = filteredGames.filter(g => g._section === 'date')

  const hasLiveGames = todayGames.some(g => g.status === 'live')
  const lastUpdated = liveData?.last_updated

  const hasData = isToday ? !!liveData : !!dbData

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
          {isToday && lastUpdated && (
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

      {/* Date picker */}
      <DatePicker selectedDate={selectedDate} onChange={setSelectedDate} today={todayStr} />

      {/* Loading */}
      {loading && !hasData && (
        <div className="text-center py-12 text-gray-400">Loading scoreboard...</div>
      )}

      {/* Error */}
      {error && !hasData && (
        <div className="text-center py-12 text-red-400">
          Unable to load scores.
        </div>
      )}

      {/* Content */}
      {hasData && (
        <>
          {/* Today view: sections for today / recent / upcoming */}
          {isToday && (
            <>
              {todayGames.length > 0 && (
                <Section title="Today's Games" count={todayGames.length}>
                  <GameGrid games={todayGames} />
                </Section>
              )}

              {todayGames.length === 0 && !loading && (
                <div className="bg-white rounded-xl border border-gray-200 p-8 text-center mb-6">
                  <div className="text-3xl mb-2">&#9918;</div>
                  <p className="text-gray-500 font-medium">No PNW games today</p>
                  <p className="text-gray-400 text-sm mt-1">Check back on game days for live scores</p>
                </div>
              )}

              {recentGames.length > 0 && (
                <Section title="Recent Results" count={recentGames.length}>
                  <GameGrid games={recentGames} />
                </Section>
              )}

              {upcomingGames.length > 0 && (
                <Section title="Upcoming" count={upcomingGames.length}>
                  <GameGrid games={upcomingGames} />
                </Section>
              )}
            </>
          )}

          {/* Past/future date view: flat list */}
          {!isToday && (
            <>
              {dateGames.length > 0 ? (
                <Section title={formatDateLabel(selectedDate)} count={dateGames.length}>
                  <GameGrid games={dateGames} />
                </Section>
              ) : (
                <div className="bg-white rounded-xl border border-gray-200 p-8 text-center mb-6">
                  <div className="text-3xl mb-2">&#9918;</div>
                  <p className="text-gray-500 font-medium">No games on {formatDateLabel(selectedDate)}</p>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}


function DatePicker({ selectedDate, onChange, today }) {
  const isToday = selectedDate === today

  return (
    <div className="flex items-center justify-center gap-2 mb-5">
      <button
        onClick={() => onChange(shiftDate(selectedDate, -1))}
        className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
        title="Previous day"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <button
        onClick={() => onChange(today)}
        className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
          isToday
            ? 'bg-nw-teal text-white'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
        }`}
      >
        Today
      </button>

      <input
        type="date"
        value={selectedDate}
        onChange={(e) => onChange(e.target.value)}
        className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-nw-teal/30 focus:border-nw-teal"
      />

      <button
        onClick={() => onChange(shiftDate(selectedDate, 1))}
        className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
        title="Next day"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
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
        <GameCard key={`${game.id}-${i}`} game={game} />
      ))}
    </div>
  )
}


function GameCard({ game }) {
  const isLive = game._source === 'live'
  ? game.status === 'live'
  : false
  const isFinal = game.status === 'final'
  const isScheduled = game.status === 'scheduled'
  const statusInfo = STATUS_LABELS[game.status] || STATUS_LABELS.scheduled

  // Normalize data between live scores format and DB format
  if (game._source === 'live') {
    return <LiveGameCard game={game} isLive={isLive} isFinal={isFinal} isScheduled={isScheduled} statusInfo={statusInfo} />
  }
  return <DBGameCard game={game} isFinal={isFinal} isScheduled={isScheduled} statusInfo={statusInfo} />
}


/** Card for live scores data (from scraper JSON) */
function LiveGameCard({ game, isLive, isFinal, isScheduled, statusInfo }) {
  const teamScore = game.team_score != null ? parseInt(game.team_score) : null
  const oppScore = game.opponent_score != null ? parseInt(game.opponent_score) : null
  const teamWon = isFinal && teamScore != null && oppScore != null && teamScore > oppScore
  const oppWon = isFinal && teamScore != null && oppScore != null && oppScore > teamScore

  const gameTime = game.time || ''
  const gameDate = game.date ? formatDateLabel(game.date) : ''

  return (
    <div className={`bg-white rounded-xl border overflow-hidden transition-shadow hover:shadow-md ${
      isLive ? 'border-red-300 shadow-sm shadow-red-100' : 'border-gray-200'
    }`}>
      {/* Status bar */}
      <div className={`flex items-center justify-between px-3 py-1 ${isLive ? 'bg-red-50' : 'bg-gray-50'}`}>
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

        <div className={`flex items-center justify-between py-1 ${teamWon ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {game.opponent_image && (
              <img src={game.opponent_image} alt="" className="w-5 h-5 object-contain shrink-0"
                onError={(e) => { e.target.style.display = 'none' }} />
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

        {isScheduled && gameTime && (
          <div className="text-center pt-1 border-t border-gray-100 mt-1">
            <span className="text-xs font-medium text-gray-500">{gameTime}</span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 bg-gray-50 border-t border-gray-100">
        <div className="text-[10px] text-gray-400 flex items-center justify-between">
          <span>{gameDate}</span>
          <div className="flex items-center gap-2">
            {!isScheduled && gameTime && <span>{gameTime}</span>}
            {isFinal && game.box_score_url && (
              <a href={game.box_score_url} target="_blank" rel="noopener noreferrer"
                className="text-[10px] font-semibold text-nw-teal hover:underline">
                Box Score
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}


/** Card for database games (home/away format) */
function DBGameCard({ game, isFinal, isScheduled, statusInfo }) {
  const homeWon = isFinal && game.home_score > game.away_score
  const awayWon = isFinal && game.away_score > game.home_score
  const division = game.home_division || game.away_division

  const gameTime = game.game_time || ''

  const cardContent = (
    <div className={`bg-white rounded-xl border overflow-hidden transition-shadow hover:shadow-md border-gray-200`}>
      {/* Status bar */}
      <div className="flex items-center justify-between px-3 py-1 bg-gray-50">
        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${statusInfo.class}`}>
          {statusInfo.text}
        </span>
        <div className="flex items-center gap-1.5">
          {division && (
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded text-white ${DIV_COLORS[division] || 'bg-gray-500'}`}>
              {division}
            </span>
          )}
          {game.is_conference_game && (
            <span className="text-[9px] text-gray-400">Conf</span>
          )}
          {game.innings && game.innings !== 9 && (
            <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-semibold">
              {game.innings}
            </span>
          )}
        </div>
      </div>

      {/* Teams & Scores */}
      <div className="px-3 py-2">
        {/* Away team */}
        <div className={`flex items-center justify-between py-1 ${homeWon ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {game.away_logo && (
              <img src={game.away_logo} alt="" className="w-5 h-5 object-contain shrink-0"
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <span className="text-sm font-semibold text-gray-800 truncate">
              {game.away_short || game.away_team_name || 'Away'}
            </span>
          </div>
          {game.away_score != null ? (
            <span className={`text-lg font-bold tabular-nums ${awayWon ? 'text-gray-900' : 'text-gray-500'}`}>
              {game.away_score}
            </span>
          ) : (
            <span className="text-xs text-gray-300">—</span>
          )}
        </div>

        {/* Home team */}
        <div className={`flex items-center justify-between py-1 ${awayWon ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {game.home_logo && (
              <img src={game.home_logo} alt="" className="w-5 h-5 object-contain shrink-0"
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <span className="text-sm font-semibold text-gray-800 truncate">
              {game.home_short || game.home_team_name || 'Home'}
            </span>
          </div>
          {game.home_score != null ? (
            <span className={`text-lg font-bold tabular-nums ${homeWon ? 'text-gray-900' : 'text-gray-500'}`}>
              {game.home_score}
            </span>
          ) : (
            <span className="text-xs text-gray-300">—</span>
          )}
        </div>

        {isScheduled && gameTime && (
          <div className="text-center pt-1 border-t border-gray-100 mt-1">
            <span className="text-xs font-medium text-gray-500">{gameTime}</span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 bg-gray-50 border-t border-gray-100">
        <div className="text-[10px] text-gray-400 flex items-center justify-between">
          <span>{formatDateLabel(game.game_date)}</span>
          <div className="flex items-center gap-2">
            {!isScheduled && gameTime && <span>{gameTime}</span>}
            {isFinal && game.id && (
              <span className="text-[10px] font-semibold text-nw-teal">
                Box Score
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )

  // DB games link to the game detail page
  if (isFinal && game.id) {
    return <Link to={`/game/${game.id}`} className="block">{cardContent}</Link>
  }
  return cardContent
}
