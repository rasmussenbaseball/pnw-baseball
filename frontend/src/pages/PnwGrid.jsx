import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useGridConfig, gridSearchPlayers, gridCheckGuess } from '../hooks/useApi'

const MAX_GUESSES = 9

export default function PnwGrid() {
  const { user, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const { data: config, loading, error } = useGridConfig()
  const [grid, setGrid] = useState(Array(9).fill(null))
  const [activeCell, setActiveCell] = useState(null)
  const [guessesUsed, setGuessesUsed] = useState(0)
  const [usedPlayerIds, setUsedPlayerIds] = useState(new Set())
  const [gameOver, setGameOver] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const [saving, setSaving] = useState(false)
  const searchRef = useRef(null)
  const debounceRef = useRef(null)
  const gridRef = useRef(null)

  // Search with debounce
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) {
      setSearchResults([])
      return
    }
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const results = await gridSearchPlayers(searchQuery)
        setSearchResults(results.filter(p => !usedPlayerIds.has(p.id)))
      } catch {
        setSearchResults([])
      }
      setSearching(false)
    }, 250)
    return () => clearTimeout(debounceRef.current)
  }, [searchQuery, usedPlayerIds])

  // Focus search input when cell is selected
  useEffect(() => {
    if (activeCell !== null && searchRef.current) {
      searchRef.current.focus()
    }
  }, [activeCell])

  // Close search on escape
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        setActiveCell(null)
        setSearchQuery('')
        setSearchResults([])
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleCellClick = useCallback((idx) => {
    if (gameOver || grid[idx]) return
    setActiveCell(idx)
    setSearchQuery('')
    setSearchResults([])
  }, [gameOver, grid])

  const handleGuess = useCallback(async (player) => {
    if (activeCell === null || gameOver) return

    const row = Math.floor(activeCell / 3)
    const col = activeCell % 3

    try {
      const result = await gridCheckGuess(player.id, row, col)
      const newGuesses = guessesUsed + 1

      if (result.correct) {
        const newGrid = [...grid]
        newGrid[activeCell] = {
          ...result.player,
          correct: true,
          all_teams: result.all_teams || [],
          stat_years: result.stat_years || null,
        }
        setGrid(newGrid)
        setUsedPlayerIds(prev => new Set([...prev, player.id]))
        setFeedback({ cell: activeCell, correct: true })
      } else {
        setFeedback({ cell: activeCell, correct: false })
      }

      setGuessesUsed(newGuesses)

      const filledCount = grid.filter(Boolean).length + (result.correct ? 1 : 0)
      if (newGuesses >= MAX_GUESSES || filledCount >= 9) {
        setGameOver(true)
      }

      setActiveCell(null)
      setSearchQuery('')
      setSearchResults([])

      setTimeout(() => setFeedback(null), 800)
    } catch {
      // Handle error
    }
  }, [activeCell, gameOver, guessesUsed, grid])

  const handleReset = () => {
    setGrid(Array(9).fill(null))
    setGuessesUsed(0)
    setUsedPlayerIds(new Set())
    setGameOver(false)
    setActiveCell(null)
    setSearchQuery('')
    setSearchResults([])
    setFeedback(null)
  }

  const handleSaveImage = async () => {
    if (!gridRef.current) return
    setSaving(true)
    try {
      const { default: html2canvas } = await import('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/+esm')
      const canvas = await html2canvas(gridRef.current, {
        backgroundColor: '#f5f3ef',
        scale: 2,
        useCORS: true,
        logging: false,
      })
      const link = document.createElement('a')
      link.download = `pnw-grid-${config?.title?.replace(/[^a-zA-Z0-9]/g, '-') || 'result'}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (err) {
      console.error('Save failed:', err)
    }
    setSaving(false)
  }

  // Format stat years for display
  const formatStatYears = (statYears) => {
    if (!statYears) return ''
    if (statYears.type === 'career') {
      return statYears.span || ''
    }
    if (statYears.type === 'seasons' && statYears.years?.length) {
      return statYears.years.join(', ')
    }
    return ''
  }

  if (authLoading || loading) return <div className="text-center py-12 text-gray-400">Loading PNW Grid...</div>
  if (!user) return (
    <div className="text-center py-12 text-gray-400">
      <p className="text-lg font-medium mb-2">Log in to play PNW Grid</p>
      <p className="text-sm mb-4">Create a free account or log in to access this game.</p>
      <button
        onClick={() => navigate('/login')}
        className="px-5 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
      >
        Log In / Sign Up
      </button>
    </div>
  )
  if (error || !config) return (
    <div className="text-center py-12 text-gray-400">
      <p className="text-lg font-medium">No PNW Grid available right now</p>
      <p className="text-sm mt-1">Check back soon!</p>
    </div>
  )

  const { rows, columns } = config
  const score = grid.filter(Boolean).length

  return (
    <div className="max-w-xl mx-auto">
      {/* === Capturable area for screenshot === */}
      <div ref={gridRef} style={{ backgroundColor: '#f5f3ef', padding: '20px 16px 16px' }}>

        {/* Branded header */}
        <div className="text-center mb-3">
          <div className="flex items-center justify-center gap-2 mb-1">
            <img src="/images/nw-logo-white.png" alt="NW" className="h-7 w-7 rounded" style={{ background: '#00687a', padding: '3px' }} />
            <span className="text-lg font-extrabold tracking-tight" style={{ color: '#00687a' }}>PNW GRID</span>
          </div>
          {config.title && (
            <p className="text-[10px] text-gray-400 font-medium tracking-wide uppercase">{config.title}</p>
          )}
          <div className="flex items-center justify-center gap-4 mt-1.5 text-sm">
            <span className="text-gray-500">
              Guesses: <span className="font-bold text-gray-800">{guessesUsed}</span>/{MAX_GUESSES}
            </span>
            <span className="text-gray-500">
              Score: <span className="font-bold" style={{ color: '#00687a' }}>{score}</span>/9
            </span>
          </div>
        </div>

        {/* Grid */}
        <div className="grid grid-cols-4 gap-0 border border-gray-200 rounded-xl overflow-hidden bg-white shadow-sm">
          {/* Top-left branded cell */}
          <div className="border-b border-r border-gray-200 p-2 flex items-center justify-center" style={{ backgroundColor: '#00687a' }}>
            <img src="/images/nw-logo-white.png" alt="NW" className="h-6 w-6 opacity-80" />
          </div>

          {/* Column headers */}
          {columns.map((col, i) => (
            <div
              key={`col-${i}`}
              className="border-b border-r border-gray-200 p-2 flex items-center justify-center text-center last:border-r-0"
              style={{ backgroundColor: '#00687a' }}
            >
              <span className="text-xs font-bold text-white leading-tight">{col.label}</span>
            </div>
          ))}

          {/* Rows */}
          {rows.map((row, ri) => (
            <div key={`row-group-${ri}`} className="contents">
              {/* Row header */}
              <div
                className="border-b border-r border-gray-200 p-2 flex items-center justify-center text-center"
                style={{ backgroundColor: '#00687a' }}
              >
                <span className="text-xs font-bold text-white leading-tight">{row.label}</span>
              </div>

              {/* Grid cells */}
              {columns.map((col, ci) => {
                const idx = ri * 3 + ci
                const cell = grid[idx]
                const isActive = activeCell === idx
                const fb = feedback?.cell === idx ? feedback : null

                return (
                  <div
                    key={`cell-${ri}-${ci}`}
                    onClick={() => handleCellClick(idx)}
                    className={`
                      border-b border-r border-gray-200 aspect-square
                      flex items-center justify-center relative
                      transition-all duration-200
                      ${ri === 2 ? 'border-b-0' : ''}
                      ${ci === 2 ? 'border-r-0' : ''}
                      ${cell ? 'bg-emerald-50' : isActive ? 'bg-blue-50 ring-2 ring-inset ring-nw-teal' : 'bg-white hover:bg-gray-50 cursor-pointer'}
                      ${fb?.correct === true ? 'animate-correct' : ''}
                      ${fb?.correct === false ? 'animate-incorrect' : ''}
                    `}
                  >
                    {cell ? (
                      <div className="flex flex-col items-center gap-0 p-1 w-full">
                        {/* Player image */}
                        {cell.headshot_url ? (
                          <img
                            src={cell.headshot_url}
                            alt=""
                            className="w-9 h-9 rounded-full object-cover border border-gray-200"
                            onError={(e) => { e.target.style.display = 'none' }}
                          />
                        ) : cell.logo_url ? (
                          <img src={cell.logo_url} alt="" className="w-7 h-7 object-contain" />
                        ) : (
                          <div className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center">
                            <span className="text-emerald-600 text-xs font-bold">
                              {cell.first_name?.[0]}{cell.last_name?.[0]}
                            </span>
                          </div>
                        )}

                        {/* Player name */}
                        <span className="text-[9px] font-semibold text-gray-700 text-center leading-tight truncate w-full mt-0.5">
                          {cell.first_name?.[0]}. {cell.last_name}
                        </span>

                        {/* All team logos row */}
                        {cell.all_teams && cell.all_teams.length > 0 ? (
                          <div className="flex items-center justify-center gap-0.5 mt-0.5">
                            {cell.all_teams.map((team, ti) => (
                              team.logo_url ? (
                                <img
                                  key={ti}
                                  src={team.logo_url}
                                  alt={team.short_name}
                                  title={team.short_name}
                                  className="w-3.5 h-3.5 object-contain"
                                  onError={(e) => { e.target.style.display = 'none' }}
                                />
                              ) : (
                                <span key={ti} className="text-[7px] text-gray-400">{team.short_name}</span>
                              )
                            ))}
                          </div>
                        ) : (
                          <span className="text-[7px] text-gray-400">{cell.team_short}</span>
                        )}

                        {/* Stat year(s) */}
                        {cell.stat_years && (
                          <span className="text-[7px] text-gray-400 leading-none mt-0.5">
                            {formatStatYears(cell.stat_years)}
                          </span>
                        )}
                      </div>
                    ) : isActive ? (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-xs text-nw-teal font-medium">Type below...</span>
                      </div>
                    ) : (
                      <span className="text-gray-200 text-2xl font-light">+</span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {/* Game over result (inside capturable area) */}
        {gameOver && (
          <div className="mt-3 text-center">
            <div className={`inline-block px-4 py-2 rounded-lg text-sm font-bold ${
              score === 9 ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'
            }`}>
              {score === 9 ? 'Perfect! 9/9!' : `Game Over — ${score}/9`}
            </div>
          </div>
        )}

        {/* Branded footer watermark (inside capturable area) */}
        <div className="flex items-center justify-center gap-1.5 mt-3 opacity-60">
          <img src="/images/nw-logo-white.png" alt="" className="h-3.5 w-3.5 rounded-sm" style={{ background: '#00687a', padding: '1.5px' }} />
          <span className="text-[9px] font-bold tracking-wide" style={{ color: '#00687a' }}>nwbaseballstats.com</span>
        </div>
      </div>
      {/* === End capturable area === */}

      {/* Search input (outside capturable area) */}
      {activeCell !== null && !gameOver && (
        <div className="mt-3 relative px-4">
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search for a player..."
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal focus:border-transparent"
          />
          {searching && (
            <div className="absolute right-7 top-3">
              <div className="w-4 h-4 border-2 border-gray-300 border-t-nw-teal rounded-full animate-spin" />
            </div>
          )}

          {/* Search results dropdown */}
          {searchResults.length > 0 && (
            <div className="absolute top-full left-4 right-4 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-64 overflow-y-auto">
              {searchResults.map((player) => (
                <button
                  key={player.id}
                  onClick={() => handleGuess(player)}
                  className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-50 text-left transition-colors border-b border-gray-100 last:border-0"
                >
                  {player.headshot_url ? (
                    <img src={player.headshot_url} alt="" className="w-8 h-8 rounded-full object-cover shrink-0"
                      onError={(e) => { e.target.src = player.logo_url || ''; e.target.className = 'w-6 h-6 object-contain shrink-0' }} />
                  ) : player.logo_url ? (
                    <img src={player.logo_url} alt="" className="w-6 h-6 object-contain shrink-0" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                      <span className="text-gray-400 text-xs font-bold">{player.first_name?.[0]}{player.last_name?.[0]}</span>
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-gray-800 truncate">
                      {player.first_name} {player.last_name}
                    </div>
                    <div className="text-xs text-gray-400">
                      {player.team_short} · {player.position} · {player.year_in_school}
                    </div>
                  </div>
                  <span className="ml-auto text-[10px] font-medium text-gray-300">{player.division_level}</span>
                </button>
              ))}
            </div>
          )}

          {searchQuery.length >= 2 && !searching && searchResults.length === 0 && (
            <div className="absolute top-full left-4 right-4 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-center text-sm text-gray-400">
              No players found
            </div>
          )}
        </div>
      )}

      {/* Action buttons (outside capturable area) */}
      {gameOver && (
        <div className="mt-3 flex items-center justify-center gap-3 px-4">
          <button
            onClick={handleReset}
            className="text-sm font-medium hover:underline"
            style={{ color: '#00687a' }}
          >
            Play Again
          </button>
          <button
            onClick={handleSaveImage}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white transition"
            style={{ backgroundColor: '#00687a' }}
          >
            {saving ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Save as Image
              </>
            )}
          </button>
        </div>
      )}

      {/* Rules */}
      <div className="mt-5 mx-4 bg-gray-50 rounded-lg p-3 text-xs text-gray-500">
        <p className="font-semibold text-gray-600 mb-1">How to play</p>
        <p>Select a cell and search for a player who fits <strong>both</strong> the row and column criteria.
        Each player can only be used once. You have {MAX_GUESSES} guesses to fill the 3×3 grid.</p>
      </div>
    </div>
  )
}
