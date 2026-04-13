import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useLiveScores, useGamesByDate, useWinProbabilities } from '../hooks/useApi'

const DIV_COLORS = {
  D1: 'bg-blue-600', D2: 'bg-emerald-600', D3: 'bg-amber-600',
  NAIA: 'bg-red-600', JUCO: 'bg-purple-600',
}

/** Division display order */
const DIV_ORDER = ['D1', 'D2', 'D3', 'NAIA', 'JUCO']

const DIV_LABELS = {
  D1: 'NCAA Division I', D2: 'NCAA Division II', D3: 'NCAA Division III',
  NAIA: 'NAIA', JUCO: 'NWAC (JUCO)',
}

const STATUS_LABELS = {
  live: { text: 'LIVE', class: 'bg-red-500 text-white animate-pulse' },
  scheduled: { text: 'Scheduled', class: 'bg-gray-100 text-gray-500' },
  final: { text: 'Final', class: 'bg-gray-200 text-gray-600' },
}

/** Format a date string as "Fri, Apr 4". Handles both YYYY-MM-DD and ISO datetime. */
function formatDateLabel(dateStr) {
  if (!dateStr) return ''
  // Extract just the date portion if it's an ISO datetime
  const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr
  const d = new Date(datePart + 'T12:00:00')
  if (isNaN(d)) return ''
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

  // Win probabilities for PNW-vs-PNW games on the selected date
  const { data: wpData } = useWinProbabilities(selectedDate)
  const winProbs = wpData?.probabilities || {}

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
    // DB games - normalize to a consistent shape
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

  /** Group a list of games by division in D1→D2→D3→NAIA→JUCO order */
  function groupByDivision(gamesList) {
    const groups = {}
    for (const g of gamesList) {
      const div = g._source === 'live'
        ? (g.team_division || 'Other')
        : (g.home_division || g.away_division || 'Other')
      if (!groups[div]) groups[div] = []
      groups[div].push(g)
    }
    // Return in order
    return DIV_ORDER
      .filter(d => groups[d]?.length > 0)
      .map(d => ({ division: d, label: DIV_LABELS[d] || d, games: groups[d] }))
      .concat(
        groups['Other']?.length > 0
          ? [{ division: 'Other', label: 'Other', games: groups['Other'] }]
          : []
      )
  }

  const showDivGroups = filter === 'all'

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
          {/* Today view */}
          {isToday && (
            <>
              {todayGames.length > 0 && (
                <>
                  {groupByDivision(todayGames).map(({ division, label, games: divGames }) => (
                    <DivisionSection key={division} division={division} label={label} count={divGames.length}>
                      <GameGrid games={divGames} winProbs={winProbs} />
                    </DivisionSection>
                  ))}
                </>
              )}

              {todayGames.length === 0 && !loading && (
                <div className="bg-white rounded-xl border border-gray-200 p-8 text-center mb-6">
                  <div className="text-3xl mb-2">&#9918;</div>
                  <p className="text-gray-500 font-medium">No PNW games today</p>
                  <p className="text-gray-400 text-sm mt-1">Check back on game days for live scores</p>
                </div>
              )}
            </>
          )}

          {/* Past/future date view */}
          {!isToday && (
            <>
              {dateGames.length > 0 ? (
                <>
                  {groupByDivision(dateGames).map(({ division, label, games: divGames }) => (
                    <DivisionSection key={division} division={division} label={label} count={divGames.length}>
                      <GameGrid games={divGames} winProbs={winProbs} />
                    </DivisionSection>
                  ))}
                </>
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


function DivisionSection({ division, label, count, children }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded text-white ${DIV_COLORS[division] || 'bg-gray-500'}`}>
          {division}
        </span>
        <h2 className="text-sm font-bold text-gray-700 tracking-wider">{label}</h2>
        <span className="text-xs text-gray-400">({count})</span>
      </div>
      {children}
    </div>
  )
}


function GameGrid({ games, winProbs = {} }) {
  const count = games.length
  // More games = compact cards with tighter gaps
  // Cap at 3 columns so the layout is more square (better for screenshots)
  const compact = count >= 8
  const gridCols = 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
  const gap = compact ? 'gap-1.5' : 'gap-2'

  return (
    <div className={`grid ${gridCols} ${gap}`}>
      {games.map((game, i) => (
        <GameCard key={`${game.id}-${i}`} game={game} winProbs={winProbs} compact={compact} />
      ))}
    </div>
  )
}


function GameCard({ game, winProbs = {}, compact = false }) {
  const isLive = game._source === 'live'
  ? game.status === 'live'
  : false
  const isFinal = game.status === 'final'
  const isScheduled = game.status === 'scheduled'
  const statusInfo = STATUS_LABELS[game.status] || STATUS_LABELS.scheduled

  // Look up win probability for this game
  const wp = game._source === 'db' && game.id ? winProbs[String(game.id)] : null

  // Normalize data between live scores format and DB format
  if (game._source === 'live') {
    return <LiveGameCard game={game} isLive={isLive} isFinal={isFinal} isScheduled={isScheduled} statusInfo={statusInfo} winProbs={winProbs} compact={compact} />
  }
  return <DBGameCard game={game} isFinal={isFinal} isScheduled={isScheduled} statusInfo={statusInfo} wp={wp} compact={compact} />
}


/** Card for live scores data (from scraper JSON) */
function LiveGameCard({ game: rawGame, isLive, isFinal, isScheduled, statusInfo, winProbs = {}, compact = false }) {
  // Normalize alternative formats (e.g. WMT home_team/away_team) to standard team/opponent
  const game = rawGame.team ? rawGame : {
    ...rawGame,
    team: rawGame.home_team || 'TBD',
    opponent: rawGame.away_team || 'TBD',
    team_score: rawGame.home_score,
    opponent_score: rawGame.away_score,
    team_logo: rawGame.home_logo || rawGame.team_logo,
    opponent_logo: rawGame.away_logo || rawGame.opponent_logo,
    location: 'home',
  }

  const teamScore = game.team_score != null ? parseInt(game.team_score) : null
  const oppScore = game.opponent_score != null ? parseInt(game.opponent_score) : null
  const teamWon = isFinal && teamScore != null && oppScore != null && teamScore > oppScore
  const oppWon = isFinal && teamScore != null && oppScore != null && oppScore > teamScore

  const gameTime = game.time || ''
  const gameDate = game.date ? formatDateLabel(game.date) : ''

  // For live games, try to find matching win prob by DB game ID if available
  // Live scores from the scraper may have a db_game_id attached
  const wp = game.db_game_id ? winProbs[String(game.db_game_id)] : null
  const fmtWp = (val) => val != null ? `${Math.round(val * 100)}%` : null

  // Determine which side is home/away for win prob display
  // Live games: game.team is the "source" team, game.location tells us if source team is home/away
  const isSourceHome = game.location !== 'away'
  const teamWp = wp ? fmtWp(isSourceHome ? wp.home_win_prob : wp.away_win_prob) : null
  const oppWp = wp ? fmtWp(isSourceHome ? wp.away_win_prob : wp.home_win_prob) : null
  const teamWpRaw = wp ? (isSourceHome ? wp.home_win_prob : wp.away_win_prob) : null
  const oppWpRaw = wp ? (isSourceHome ? wp.away_win_prob : wp.home_win_prob) : null

  const logoSize = compact ? 'w-4 h-4' : 'w-5 h-5'
  const teamText = compact ? 'text-xs' : 'text-sm'
  const scoreText = compact ? 'text-base' : 'text-lg'
  const cardPadX = compact ? 'px-2' : 'px-3'
  const cardPadY = compact ? 'py-1' : 'py-2'
  const rowPad = compact ? 'py-0.5' : 'py-1'

  return (
    <div className={`bg-white ${compact ? 'rounded-lg' : 'rounded-xl'} border overflow-hidden transition-shadow hover:shadow-md ${
      isLive ? 'border-red-300 shadow-sm shadow-red-100' : 'border-gray-200'
    }`}>
      {/* Status bar */}
      <div className={`flex items-center justify-between ${cardPadX} py-0.5 ${isLive ? 'bg-red-50' : 'bg-gray-50'}`}>
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

      {/* R/H/E header + Teams & Scores */}
      <div className={`${cardPadX} ${cardPadY}`}>
        {isFinal && (game.home_hits != null || game.away_hits != null) && (
          <div className="flex justify-end gap-0 mb-0.5">
            <span className="text-[9px] font-semibold text-gray-400 w-8 text-center">R</span>
            <span className="text-[9px] font-semibold text-gray-400 w-7 text-center">H</span>
          </div>
        )}
        <div className={`flex items-center ${rowPad} ${oppWon ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {game.team_logo && (
              <img src={game.team_logo} alt="" className={`${logoSize} object-contain shrink-0`}
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <span className={`${teamText} font-semibold text-gray-800 truncate`}>{game.team}</span>
            {teamWp && (
              <span className={`text-[10px] font-semibold tabular-nums shrink-0 ${
                teamWpRaw >= 0.5 ? 'text-emerald-600' : 'text-gray-400'
              }`}>{teamWp}</span>
            )}
          </div>
          <div className="flex items-center gap-0 shrink-0">
            {teamScore != null ? (
              <span className={`${scoreText} font-bold tabular-nums w-8 text-center ${teamWon ? 'text-gray-900' : 'text-gray-500'}`}>
                {teamScore}
              </span>
            ) : isScheduled ? (
              <span className="text-xs text-gray-300 w-8 text-center">-</span>
            ) : null}
            {isFinal && (game.home_hits != null || game.away_hits != null) && (
              <span className="text-xs text-gray-400 tabular-nums w-7 text-center">{(game.location === 'home' ? game.home_hits : game.away_hits) ?? '-'}</span>
            )}
          </div>
        </div>

        <div className={`flex items-center ${rowPad} ${teamWon ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {(game.opponent_logo || game.opponent_image) && (
              <img src={game.opponent_logo || game.opponent_image} alt="" className={`${logoSize} object-contain shrink-0`}
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <span className={`${teamText} font-semibold text-gray-800 truncate`}>
              {game.location === 'away' ? '@ ' : ''}{game.opponent_display || game.opponent}
            </span>
            {oppWp && (
              <span className={`text-[10px] font-semibold tabular-nums shrink-0 ${
                oppWpRaw >= 0.5 ? 'text-emerald-600' : 'text-gray-400'
              }`}>{oppWp}</span>
            )}
          </div>
          <div className="flex items-center gap-0 shrink-0">
            {oppScore != null ? (
              <span className={`${scoreText} font-bold tabular-nums w-8 text-center ${oppWon ? 'text-gray-900' : 'text-gray-500'}`}>
                {oppScore}
              </span>
            ) : isScheduled ? (
              <span className="text-xs text-gray-300 w-8 text-center">-</span>
            ) : null}
            {isFinal && (game.home_hits != null || game.away_hits != null) && (
              <span className="text-xs text-gray-400 tabular-nums w-7 text-center">{(game.location === 'home' ? game.away_hits : game.home_hits) ?? '-'}</span>
            )}
          </div>
        </div>

        {isScheduled && gameTime && (
          <div className={`text-center pt-0.5 border-t border-gray-100 ${compact ? 'mt-0.5' : 'mt-1'}`}>
            <span className="text-xs font-medium text-gray-500">{gameTime}</span>
          </div>
        )}
      </div>

      {/* W/L/S + Footer */}
      {isFinal && (game.win_pitcher || game.loss_pitcher) && (
        <div className={`${cardPadX} pb-1`}>
          <div className="flex flex-wrap gap-x-3 gap-y-0">
            {game.win_pitcher && <span className="text-[10px] text-gray-500"><span className="font-semibold text-emerald-600">W:</span> {game.win_pitcher}</span>}
            {game.loss_pitcher && <span className="text-[10px] text-gray-500"><span className="font-semibold text-red-500">L:</span> {game.loss_pitcher}</span>}
            {game.save_pitcher && <span className="text-[10px] text-gray-500"><span className="font-semibold text-blue-500">S:</span> {game.save_pitcher}</span>}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className={`px-3 ${compact ? 'py-1' : 'py-1.5'} bg-gray-50 border-t border-gray-100`}>
        <div className="text-[10px] text-gray-400 flex items-center justify-between">
          {!compact && <span>{gameDate}</span>}
          <div className={`flex items-center gap-2 ${compact ? 'ml-auto' : ''}`}>
            {!compact && !isScheduled && gameTime && <span>{gameTime}</span>}
            {isFinal && game.box_score_url && (
              <a href={game.box_score_url} target="_blank" rel="noopener noreferrer"
                className="text-[10px] font-semibold text-nw-teal hover:underline">
                Box Score
              </a>
            )}
            {!isFinal && !isScheduled && game.box_score_url && (
              <a href={game.box_score_url} target="_blank" rel="noopener noreferrer"
                className="text-[10px] font-semibold text-amber-600 hover:underline animate-pulse">
                Live Stats
              </a>
            )}
            </div>
          </div>
        </div>
    </div>
  )
}


/** Card for database games (home/away format) */
function DBGameCard({ game, isFinal, isScheduled, statusInfo, wp, compact = false }) {
  const homeWon = isFinal && game.home_score > game.away_score
  const awayWon = isFinal && game.away_score > game.home_score
  const division = game.home_division || game.away_division

  const gameTime = game.game_time || ''

  // Format win probability as percentage (e.g., 0.723 -> "72%")
  // Prefer inline values from the API response (works for future games too),
  // fall back to separate winProbs lookup for older data
  const fmtWp = (val) => val != null ? `${Math.round(val * 100)}%` : null
  const homeWpRaw = game.home_win_prob ?? (wp ? wp.home_win_prob : null)
  const awayWpRaw = game.away_win_prob ?? (wp ? wp.away_win_prob : null)
  const awayWp = fmtWp(awayWpRaw)
  const homeWp = fmtWp(homeWpRaw)

  const logoSize = compact ? 'w-4 h-4' : 'w-5 h-5'
  const teamText = compact ? 'text-xs' : 'text-sm'
  const scoreText = compact ? 'text-base' : 'text-lg'
  const cardPadX = compact ? 'px-2' : 'px-3'
  const cardPadY = compact ? 'py-1' : 'py-2'
  const rowPad = compact ? 'py-0.5' : 'py-1'

  const cardContent = (
    <div className={`bg-white ${compact ? 'rounded-lg' : 'rounded-xl'} border overflow-hidden transition-shadow hover:shadow-md border-gray-200`}>
      {/* Status bar */}
      <div className={`flex items-center justify-between ${cardPadX} py-0.5 bg-gray-50`}>
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

      {/* R/H/E header + Teams & Scores */}
      <div className={`${cardPadX} ${cardPadY}`}>
        {isFinal && (game.home_hits != null || game.away_hits != null) && (
          <div className="flex justify-end gap-0 mb-0.5">
            <span className="text-[9px] font-semibold text-gray-400 w-8 text-center">R</span>
            <span className="text-[9px] font-semibold text-gray-400 w-7 text-center">H</span>
          </div>
        )}
        {/* Away team */}
        <div className={`flex items-center ${rowPad} ${homeWon ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {game.away_logo && (
              <img src={game.away_logo} alt="" className={`${logoSize} object-contain shrink-0`}
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <span className={`${teamText} font-semibold text-gray-800 truncate`}>
              {game.away_short || game.away_team_name || 'Away'}
            </span>
            {awayWp && (
              <span className={`text-[10px] font-semibold tabular-nums shrink-0 ${
                awayWpRaw >= 0.5 ? 'text-emerald-600' : 'text-gray-400'
              }`}>{awayWp}</span>
            )}
          </div>
          <div className="flex items-center gap-0 shrink-0">
            {game.away_score != null ? (
              <span className={`${scoreText} font-bold tabular-nums w-8 text-center ${awayWon ? 'text-gray-900' : 'text-gray-500'}`}>
                {game.away_score}
              </span>
            ) : (
              <span className="text-xs text-gray-300 w-8 text-center">-</span>
            )}
            {isFinal && (game.home_hits != null || game.away_hits != null) && (
              <span className="text-xs text-gray-400 tabular-nums w-7 text-center">{game.away_hits ?? '-'}</span>
            )}
          </div>
        </div>

        {/* Home team */}
        <div className={`flex items-center ${rowPad} ${awayWon ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {game.home_logo && (
              <img src={game.home_logo} alt="" className={`${logoSize} object-contain shrink-0`}
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <span className={`${teamText} font-semibold text-gray-800 truncate`}>
              {game.home_short || game.home_team_name || 'Home'}
            </span>
            {homeWp && (
              <span className={`text-[10px] font-semibold tabular-nums shrink-0 ${
                homeWpRaw >= 0.5 ? 'text-emerald-600' : 'text-gray-400'
              }`}>{homeWp}</span>
            )}
          </div>
          <div className="flex items-center gap-0 shrink-0">
            {game.home_score != null ? (
              <span className={`${scoreText} font-bold tabular-nums w-8 text-center ${homeWon ? 'text-gray-900' : 'text-gray-500'}`}>
                {game.home_score}
              </span>
            ) : (
              <span className="text-xs text-gray-300 w-8 text-center">-</span>
            )}
            {isFinal && (game.home_hits != null || game.away_hits != null) && (
              <span className="text-xs text-gray-400 tabular-nums w-7 text-center">{game.home_hits ?? '-'}</span>
            )}
          </div>
        </div>

        {isScheduled && gameTime && (
          <div className={`text-center pt-0.5 border-t border-gray-100 ${compact ? 'mt-0.5' : 'mt-1'}`}>
            <span className="text-xs font-medium text-gray-500">{gameTime}</span>
          </div>
        )}
      </div>

      {/* W/L/S pitchers */}
      {isFinal && (game.win_pitcher || game.loss_pitcher) && (
        <div className={`${cardPadX} pb-1`}>
          <div className="flex flex-wrap gap-x-3 gap-y-0">
            {game.win_pitcher && <span className="text-[10px] text-gray-500"><span className="font-semibold text-emerald-600">W:</span> {game.win_pitcher}</span>}
            {game.loss_pitcher && <span className="text-[10px] text-gray-500"><span className="font-semibold text-red-500">L:</span> {game.loss_pitcher}</span>}
            {game.save_pitcher && <span className="text-[10px] text-gray-500"><span className="font-semibold text-blue-500">S:</span> {game.save_pitcher}</span>}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className={`px-3 ${compact ? 'py-1' : 'py-1.5'} bg-gray-50 border-t border-gray-100`}>
        <div className="text-[10px] text-gray-400 flex items-center justify-between">
          {!compact && <span>{formatDateLabel(game.game_date)}</span>}
          <div className={`flex items-center gap-2 ${compact ? 'ml-auto' : ''}`}>
            {!compact && !isScheduled && gameTime && <span>{gameTime}</span>}
            {isFinal && game.source_url && (
              <a href={game.source_url} target="_blank" rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-[10px] font-semibold text-nw-teal hover:underline">
                Box Score
              </a>
            )}
            {isFinal && !game.source_url && game.id && (
              <span className="text-[10px] font-semibold text-nw-teal">
                Box Score
              </span>
            )}
            {!isFinal && (game.home_stats_url || game.away_stats_url) && (
              <a href={game.home_stats_url || game.away_stats_url} target="_blank" rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-[10px] font-semibold text-nw-teal hover:underline">
                Live Stats
              </a>
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
