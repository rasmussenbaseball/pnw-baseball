import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useGridConfig, gridSearchPlayers, gridCheckGuess, gridFetchRandom, gridCheckCustom, gridFetchSolutions } from '../hooks/useApi'

const MAX_GUESSES = 9

export default function PnwGrid() {
  const { user, loading: authLoading } = useAuth()
  const navigate = useNavigate()

  // Mode: 'weekly' or 'random'
  const [mode, setMode] = useState('weekly')
  const { data: weeklyConfig, loading: weeklyLoading, error: weeklyError } = useGridConfig()
  const [randomConfig, setRandomConfig] = useState(null)
  const [randomLoading, setRandomLoading] = useState(false)

  const config = mode === 'weekly' ? weeklyConfig : randomConfig
  const loading = mode === 'weekly' ? weeklyLoading : randomLoading

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
  const [solutions, setSolutions] = useState(null)
  const [solutionsLoading, setSolutionsLoading] = useState(false)
  const [showSolutions, setShowSolutions] = useState(false)
  const [expandedCell, setExpandedCell] = useState(null)
  const searchRef = useRef(null)
  const debounceRef = useRef(null)
  const gridRef = useRef(null)

  const isRandom = mode === 'random'

  // Fetch random grid on mode switch or "new grid"
  const fetchRandomGrid = useCallback(async () => {
    setRandomLoading(true)
    try {
      const cfg = await gridFetchRandom()
      setRandomConfig(cfg)
    } catch {
      setRandomConfig(null)
    }
    setRandomLoading(false)
  }, [])

  // When switching to random mode, fetch a grid if we don't have one
  useEffect(() => {
    if (mode === 'random' && !randomConfig) {
      fetchRandomGrid()
    }
  }, [mode, randomConfig, fetchRandomGrid])

  // Reset game state when config changes
  const resetGame = useCallback(() => {
    setGrid(Array(9).fill(null))
    setGuessesUsed(0)
    setUsedPlayerIds(new Set())
    setGameOver(false)
    setActiveCell(null)
    setSearchQuery('')
    setSearchResults([])
    setFeedback(null)
    setSolutions(null)
    setShowSolutions(false)
    setExpandedCell(null)
  }, [])

  const handleShowSolutions = useCallback(async () => {
    if (solutions) {
      setShowSolutions(s => !s)
      return
    }
    if (!config) return
    setSolutionsLoading(true)
    try {
      const data = await gridFetchSolutions(config.rows, config.columns)
      setSolutions(data.cells)
      setShowSolutions(true)
    } catch {
      // silently fail
    }
    setSolutionsLoading(false)
  }, [solutions, config])

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
      let result
      if (isRandom && config) {
        // Random mode: send criteria to custom endpoint
        result = await gridCheckCustom(player.id, config.rows[row], config.columns[col])
      } else {
        // Weekly mode: use row/col indices
        result = await gridCheckGuess(player.id, row, col)
      }

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
      // Weekly: game over at MAX_GUESSES or 9 filled. Random: only when 9 filled.
      if (filledCount >= 9 || (!isRandom && newGuesses >= MAX_GUESSES)) {
        setGameOver(true)
      }

      setActiveCell(null)
      setSearchQuery('')
      setSearchResults([])

      setTimeout(() => setFeedback(null), 800)
    } catch {
      // Handle error
    }
  }, [activeCell, gameOver, guessesUsed, grid, isRandom, config])

  const handleReset = () => {
    resetGame()
  }

  const handleNewRandomGrid = async () => {
    resetGame()
    await fetchRandomGrid()
  }

  const handleModeSwitch = (newMode) => {
    if (newMode === mode) return
    resetGame()
    setMode(newMode)
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

  if (authLoading) return <div className="text-center py-12 text-gray-400">Loading PNW Grid...</div>
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

  if (loading) return <div className="text-center py-12 text-gray-400">Loading PNW Grid...</div>

  // Weekly mode: show error if no config. Random mode: should always have config after loading.
  if (!config) return (
    <div className="text-center py-12 text-gray-400">
      <p className="text-lg font-medium">No PNW Grid available right now</p>
      <p className="text-sm mt-1">Check back soon!</p>
      {/* Still show the mode toggle so they can switch to random */}
      <div className="flex items-center justify-center gap-1 mt-4 bg-gray-100 rounded-lg p-1 mx-auto w-fit">
        <button
          onClick={() => handleModeSwitch('weekly')}
          className={`px-4 py-1.5 rounded-md text-xs font-semibold transition ${mode === 'weekly' ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}
        >
          Weekly
        </button>
        <button
          onClick={() => handleModeSwitch('random')}
          className={`px-4 py-1.5 rounded-md text-xs font-semibold transition ${mode === 'random' ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}
        >
          Random
        </button>
      </div>
    </div>
  )

  const { rows, columns } = config
  const score = grid.filter(Boolean).length

  return (
    <div className="max-w-xl mx-auto">
      {/* Mode toggle */}
      <div className="flex items-center justify-center gap-1 mb-3 bg-gray-100 rounded-lg p-1 mx-4">
        <button
          onClick={() => handleModeSwitch('weekly')}
          className={`flex-1 px-4 py-1.5 rounded-md text-xs font-semibold transition ${mode === 'weekly' ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}
        >
          Weekly
        </button>
        <button
          onClick={() => handleModeSwitch('random')}
          className={`flex-1 px-4 py-1.5 rounded-md text-xs font-semibold transition ${mode === 'random' ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}
        >
          Random
        </button>
      </div>

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
            {!isRandom && (
              <span className="text-gray-500">
                Guesses: <span className="font-bold text-gray-800">{guessesUsed}</span>/{MAX_GUESSES}
              </span>
            )}
            {isRandom && (
              <span className="text-gray-500">
                Guesses: <span className="font-bold text-gray-800">{guessesUsed}</span>
              </span>
            )}
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
              className="border-b border-r border-gray-200 p-2 flex flex-col items-center justify-center text-center last:border-r-0"
              style={{ backgroundColor: '#00687a' }}
            >
              {col.category && (
                <span className="text-[8px] uppercase tracking-wider text-teal-300 font-semibold leading-tight mb-0.5">{col.category}</span>
              )}
              {col.logo_url && (
                <img src={col.logo_url} alt="" className="w-6 h-6 object-contain mb-0.5" onError={(e) => { e.target.style.display = 'none' }} />
              )}
              <span className="text-xs font-bold text-white leading-tight">{col.label}</span>
            </div>
          ))}

          {/* Rows */}
          {rows.map((row, ri) => (
            <div key={`row-group-${ri}`} className="contents">
              {/* Row header */}
              <div
                className="border-b border-r border-gray-200 p-2 flex flex-col items-center justify-center text-center"
                style={{ backgroundColor: '#00687a' }}
              >
                {row.category && (
                  <span className="text-[8px] uppercase tracking-wider text-teal-300 font-semibold leading-tight mb-0.5">{row.category}</span>
                )}
                {row.logo_url && (
                  <img src={row.logo_url} alt="" className="w-6 h-6 object-contain mb-0.5" onError={(e) => { e.target.style.display = 'none' }} />
                )}
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
                        {/* Team logos at top */}
                        {cell.all_teams && cell.all_teams.length > 0 ? (
                          <div className="flex items-center justify-center gap-1">
                            {cell.all_teams.map((team, ti) => (
                              team.logo_url ? (
                                <img
                                  key={ti}
                                  src={team.logo_url}
                                  alt={team.short_name}
                                  title={team.short_name}
                                  className="w-7 h-7 object-contain"
                                  onError={(e) => { e.target.style.display = 'none' }}
                                />
                              ) : (
                                <span key={ti} className="text-[8px] text-gray-400 font-medium">{team.short_name}</span>
                              )
                            ))}
                          </div>
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
      {(gameOver || (isRandom && score === 9)) && (
        <div className="mt-3 flex items-center justify-center gap-3 px-4">
          {isRandom ? (
            <button
              onClick={handleNewRandomGrid}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white transition"
              style={{ backgroundColor: '#00687a' }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              New Grid
            </button>
          ) : (
            <button
              onClick={handleReset}
              className="text-sm font-medium hover:underline"
              style={{ color: '#00687a' }}
            >
              Play Again
            </button>
          )}
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
          <button
            onClick={handleShowSolutions}
            disabled={solutionsLoading}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition border"
            style={{ borderColor: '#00687a', color: '#00687a', backgroundColor: 'transparent' }}
          >
            {solutionsLoading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-teal-600 border-t-transparent rounded-full animate-spin" />
                Loading...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                {showSolutions ? 'Hide Answers' : 'All Answers'}
              </>
            )}
          </button>
        </div>
      )}

      {/* Solutions panel */}
      {showSolutions && solutions && config && (
        <div className="mt-4 px-4">
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100" style={{ backgroundColor: '#00687a' }}>
              <h3 className="text-sm font-bold text-white">All Possible Answers</h3>
            </div>
            {config.rows.map((row, ri) =>
              config.columns.map((col, ci) => {
                const key = `${ri}-${ci}`
                const players = solutions[key] || []
                const isExpanded = expandedCell === key
                const previewCount = 5

                return (
                  <div key={key} className="border-b border-gray-100 last:border-0">
                    <button
                      onClick={() => setExpandedCell(isExpanded ? null : key)}
                      className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition text-left"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-bold text-gray-400 shrink-0">{ri + 1},{ci + 1}</span>
                        <span className="text-xs font-semibold text-gray-700 truncate">
                          {row.label} + {col.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ backgroundColor: '#e6f3f5', color: '#00687a' }}>
                          {players.length}
                        </span>
                        <svg
                          className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                          fill="none" stroke="currentColor" viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="px-4 pb-3 max-h-64 overflow-y-auto">
                        {players.length === 0 ? (
                          <p className="text-xs text-gray-400 italic py-2">No matching players found</p>
                        ) : (
                          <div className="space-y-1">
                            {players.map((p, pi) => (
                              <div key={pi} className="flex items-center gap-2 py-1 px-2 rounded hover:bg-gray-50">
                                {p.logo_url ? (
                                  <img src={p.logo_url} alt="" className="w-5 h-5 object-contain shrink-0" onError={(e) => { e.target.style.display = 'none' }} />
                                ) : (
                                  <div className="w-5 h-5 shrink-0" />
                                )}
                                <span className="text-xs font-medium text-gray-700 truncate">
                                  {p.first_name} {p.last_name}
                                </span>
                                <span className="text-[10px] text-gray-400 ml-auto shrink-0">
                                  {p.team_short} · {p.last_season}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}

      {/* New Grid button visible during random play (not just at game over) */}
      {isRandom && !gameOver && score < 9 && (
        <div className="mt-3 flex items-center justify-center px-4">
          <button
            onClick={handleNewRandomGrid}
            className="flex items-center gap-1.5 text-xs font-medium hover:underline"
            style={{ color: '#00687a' }}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            New Grid
          </button>
        </div>
      )}

      {/* Rules */}
      <div className="mt-5 mx-4 bg-gray-50 rounded-lg p-3 text-xs text-gray-500">
        <p className="font-semibold text-gray-600 mb-1">How to play</p>
        <p>Select a cell and search for a player who fits <strong>both</strong> the row and column criteria.
        Each player can only be used once.{!isRandom && ` You have ${MAX_GUESSES} guesses to fill the 3×3 grid.`}
        {isRandom && ' Unlimited guesses — keep going until you fill the grid!'}</p>
        <p className="mt-1.5 text-gray-400">Data includes the 2018 season and later for 4-year schools and 2019 and later for NWAC. Rate stats require qualification (50+ PA for hitters, 20+ IP for pitchers).</p>
      </div>
    </div>
  )
}
