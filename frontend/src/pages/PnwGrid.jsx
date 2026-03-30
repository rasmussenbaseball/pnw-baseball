import { useState, useEffect, useRef, useCallback } from 'react'
import { useGridConfig, gridSearchPlayers, gridCheckGuess } from '../hooks/useApi'

const MAX_GUESSES = 9

export default function PnwGrid() {
  const { data: config, loading, error } = useGridConfig()
  const [grid, setGrid] = useState(Array(9).fill(null)) // 3x3 = 9 cells
  const [activeCell, setActiveCell] = useState(null)
  const [guessesUsed, setGuessesUsed] = useState(0)
  const [usedPlayerIds, setUsedPlayerIds] = useState(new Set())
  const [gameOver, setGameOver] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [feedback, setFeedback] = useState(null) // {cell, correct} for animation
  const searchRef = useRef(null)
  const debounceRef = useRef(null)

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
        }
        setGrid(newGrid)
        setUsedPlayerIds(prev => new Set([...prev, player.id]))
        setFeedback({ cell: activeCell, correct: true })
      } else {
        setFeedback({ cell: activeCell, correct: false })
      }

      setGuessesUsed(newGuesses)

      // Check if game is over
      const filledCount = grid.filter(Boolean).length + (result.correct ? 1 : 0)
      if (newGuesses >= MAX_GUESSES || filledCount >= 9) {
        setGameOver(true)
      }

      setActiveCell(null)
      setSearchQuery('')
      setSearchResults([])

      // Clear feedback after animation
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

  if (loading) return <div className="text-center py-12 text-gray-400">Loading PNW Grid...</div>
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
      {/* Header */}
      <div className="text-center mb-4">
        <h1 className="text-2xl font-bold text-gray-900">PNW Grid</h1>
        {config.title && (
          <p className="text-xs text-gray-400 mt-0.5">{config.title}</p>
        )}
        <div className="flex items-center justify-center gap-4 mt-2 text-sm">
          <span className="text-gray-500">
            Guesses: <span className="font-bold text-gray-800">{guessesUsed}</span>/{MAX_GUESSES}
          </span>
          <span className="text-gray-500">
            Score: <span className="font-bold text-nw-teal">{score}</span>/9
          </span>
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-4 gap-0 border border-gray-200 rounded-xl overflow-hidden bg-white shadow-sm">
        {/* Top-left empty cell */}
        <div className="bg-gray-50 border-b border-r border-gray-200 p-2" />

        {/* Column headers */}
        {columns.map((col, i) => (
          <div
            key={`col-${i}`}
            className="bg-gray-50 border-b border-r border-gray-200 p-2 flex items-center justify-center text-center last:border-r-0"
          >
            <span className="text-xs font-bold text-gray-700 leading-tight">{col.label}</span>
          </div>
        ))}

        {/* Rows */}
        {rows.map((row, ri) => (
          <>
            {/* Row header */}
            <div
              key={`row-${ri}`}
              className="bg-gray-50 border-b border-r border-gray-200 p-2 flex items-center justify-center text-center last:border-b-0"
            >
              <span className="text-xs font-bold text-gray-700 leading-tight">{row.label}</span>
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
                    <div className="flex flex-col items-center gap-0.5 p-1 w-full">
                      {cell.headshot_url ? (
                        <img
                          src={cell.headshot_url}
                          alt=""
                          className="w-10 h-10 rounded-full object-cover border border-gray-200"
                          onError={(e) => { e.target.style.display = 'none' }}
                        />
                      ) : cell.logo_url ? (
                        <img src={cell.logo_url} alt="" className="w-8 h-8 object-contain" />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
                          <span className="text-emerald-600 text-xs font-bold">
                            {cell.first_name?.[0]}{cell.last_name?.[0]}
                          </span>
                        </div>
                      )}
                      <span className="text-[9px] font-semibold text-gray-700 text-center leading-tight truncate w-full">
                        {cell.first_name?.[0]}. {cell.last_name}
                      </span>
                      <span className="text-[8px] text-gray-400">{cell.team_short}</span>
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
          </>
        ))}
      </div>

      {/* Search input (shown when a cell is active) */}
      {activeCell !== null && !gameOver && (
        <div className="mt-3 relative">
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search for a player..."
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal focus:border-transparent"
          />
          {searching && (
            <div className="absolute right-3 top-3">
              <div className="w-4 h-4 border-2 border-gray-300 border-t-nw-teal rounded-full animate-spin" />
            </div>
          )}

          {/* Search results dropdown */}
          {searchResults.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-64 overflow-y-auto">
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
            <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-center text-sm text-gray-400">
              No players found
            </div>
          )}
        </div>
      )}

      {/* Game over */}
      {gameOver && (
        <div className="mt-4 text-center">
          <div className={`inline-block px-4 py-2 rounded-lg text-sm font-bold ${
            score === 9 ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'
          }`}>
            {score === 9 ? 'Perfect! 9/9!' : `Game Over — ${score}/9`}
          </div>
          <button
            onClick={handleReset}
            className="block mx-auto mt-2 text-sm text-nw-teal hover:underline font-medium"
          >
            Play Again
          </button>
        </div>
      )}

      {/* Rules */}
      <div className="mt-6 bg-gray-50 rounded-lg p-3 text-xs text-gray-500">
        <p className="font-semibold text-gray-600 mb-1">How to play</p>
        <p>Select a cell and search for a player who fits <strong>both</strong> the row and column criteria.
        Each player can only be used once. You have {MAX_GUESSES} guesses to fill the 3×3 grid.</p>
      </div>
    </div>
  )
}
