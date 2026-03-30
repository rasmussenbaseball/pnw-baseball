import { useState, useRef, useEffect, useCallback } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { divisionBadgeClass } from '../utils/stats'
import { useAuth } from '../context/AuthContext'

// ─── Navigation structure ───
const NAV = [
  {
    label: 'Stats',
    items: [
      { to: '/stat-leaders', label: 'Stat Leaders', desc: 'Top 5 in key categories' },
      { to: '/hitting', label: 'Hitting', desc: 'Batting leaderboards & stats' },
      { to: '/pitching', label: 'Pitching', desc: 'Pitching leaderboards & stats' },
      { to: '/war', label: 'WAR Leaderboard', desc: 'Wins Above Replacement rankings' },
      { to: '/scatter', label: 'Scatter Plot', desc: 'Compare stats visually' },
      { to: '/summerball', label: 'Summerball Data', desc: 'Summer league stats', locked: true },
    ],
  },
  {
    label: 'Teams',
    items: [
      { to: '/scoreboard', label: 'Scoreboard', desc: 'Live scores & today\'s games' },
      { to: '/teams', label: 'Team Pages', desc: 'Rosters, stats & profiles' },
      { to: '/results', label: 'Results', desc: 'Game scores & box scores' },
      { to: '/standings', label: 'Standings', desc: 'Conference & overall rankings' },
      { to: '/team-ratings', label: 'Team Ratings (PPI)', desc: 'Within-division power rankings' },
      { to: '/national-rankings', label: 'National Rankings', desc: 'Where PNW teams rank nationally' },
      { to: '/team-history', label: 'History', desc: 'Historical team performance' },
      { to: '/recruiting-classes', label: 'Recruiting Classes', desc: 'Incoming class breakdowns', locked: true },
    ],
  },
  {
    label: 'Recruiting',
    items: [
      { to: '/recruiting/rankings', label: 'Rankings', desc: 'Player recruiting rankings', locked: true },
      { to: '/recruiting/map', label: 'Map', desc: 'PNW program locations' },
      { to: '/recruiting/breakdowns', label: 'Breakdowns', desc: 'Analysis by region & position', locked: true },
      { to: '/recruiting/history', label: 'History', desc: 'Historical recruiting trends', locked: true },
      { to: '/recruiting/field', label: 'Field', desc: 'Field-level visualization', locked: true },
    ],
  },
  {
    label: 'Coaching',
    items: [
      { to: '/juco-tracker', label: 'JUCO Tracker', desc: 'Track JUCO transfer talent' },
      { to: '/compare', label: 'Matchups', desc: 'Head-to-head team comparisons' },
      { to: '/player-scouting', label: 'Player Scouting', desc: 'Individual scouting reports', locked: true },
      { to: '/team-scouting', label: 'Team Scouting', desc: 'Team tendencies & reports', locked: true },
      { to: '/enhanced-scouting', label: 'Enhanced Scouting', desc: 'Advanced scouting tools', locked: true },
      { to: '/park-factors', label: 'Park Factors', desc: 'Ballpark effects on stats' },
    ],
  },
  {
    label: 'Draft',
    items: [
      { to: '/draft/2026', label: "Draft Board '26", desc: '2026 MLB Draft prospects', locked: true },
      { to: '/draft/2027', label: "Draft Board '27", desc: '2027 MLB Draft prospects', locked: true },
      { to: '/draft/2028', label: "Draft Board '28", desc: '2028 MLB Draft prospects', locked: true },
    ],
  },
  {
    label: 'Misc',
    items: [
      { to: '/graphics', label: 'Graphics', desc: 'Create social media images' },
    ],
  },
  {
    label: 'Glossary',
    to: '/glossary', // direct link, no dropdown
  },
]

// ─── Search Bar ───
function SearchBar({ mobile = false }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false) // mobile expand state
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const inputRef = useRef(null)
  const containerRef = useRef(null)
  const debounceRef = useRef(null)
  const navigate = useNavigate()

  // Flatten results into a single navigable list
  const flatResults = []
  if (results) {
    results.teams.forEach(t => flatResults.push({ type: 'team', data: t }))
    results.players.forEach(p => flatResults.push({ type: 'player', data: p }))
  }

  const doSearch = useCallback(async (q) => {
    if (q.length < 2) {
      setResults(null)
      setOpen(false)
      return
    }
    setLoading(true)
    try {
      const resp = await fetch(`/api/v1/search?q=${encodeURIComponent(q)}&limit=6`)
      if (resp.ok) {
        const data = await resp.json()
        setResults(data)
        setOpen(true)
        setSelectedIdx(-1)
      }
    } catch (e) {
      // silently fail
    } finally {
      setLoading(false)
    }
  }, [])

  const handleChange = (e) => {
    const val = e.target.value
    setQuery(val)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(val), 250)
  }

  const handleKeyDown = (e) => {
    if (!open || flatResults.length === 0) {
      if (e.key === 'Escape') {
        setOpen(false)
        inputRef.current?.blur()
      }
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx(prev => Math.min(prev + 1, flatResults.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx(prev => Math.max(prev - 1, -1))
    } else if (e.key === 'Enter' && selectedIdx >= 0) {
      e.preventDefault()
      const item = flatResults[selectedIdx]
      navigateTo(item)
    } else if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
    }
  }

  const navigateTo = (item) => {
    if (item.type === 'team') {
      navigate(`/team/${item.data.id}`)
    } else {
      navigate(`/player/${item.data.id}`)
    }
    setQuery('')
    setResults(null)
    setOpen(false)
    inputRef.current?.blur()
  }

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Keyboard shortcut: / to focus search
  useEffect(() => {
    const handler = (e) => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey &&
          document.activeElement?.tagName !== 'INPUT' &&
          document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Mobile: icon-only button that opens a full-width search overlay
  if (mobile && !expanded) {
    return (
      <button
        onClick={() => { setExpanded(true); setTimeout(() => inputRef.current?.focus(), 100) }}
        className="p-2 rounded hover:bg-white/10 transition-colors"
        aria-label="Search"
      >
        <svg className="w-5 h-5 text-teal-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </button>
    )
  }

  // Mobile expanded: full-width overlay
  if (mobile && expanded) {
    return (
      <div ref={containerRef} className="fixed inset-0 z-[100] bg-nw-teal">
        <div className="flex items-center gap-2 px-3 h-14">
          <svg className="w-5 h-5 text-teal-200 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={handleChange}
            onKeyDown={(e) => { if (e.key === 'Escape') { setExpanded(false); setQuery(''); setResults(null); setOpen(false) } else handleKeyDown(e) }}
            placeholder="Search players & teams..."
            className="flex-1 bg-transparent border-none outline-none text-base text-white placeholder-teal-200/50"
            autoFocus
          />
          {loading && (
            <div className="animate-spin h-4 w-4 border-2 border-teal-200 border-t-transparent rounded-full shrink-0" />
          )}
          <button
            onClick={() => { setExpanded(false); setQuery(''); setResults(null); setOpen(false) }}
            className="p-2 text-teal-200 hover:text-white"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Results */}
        {open && flatResults.length > 0 && (
          <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 56px)' }}>
            {results.teams.length > 0 && (
              <div>
                <div className="px-4 pt-3 pb-1 text-[10px] font-bold text-teal-300/50 uppercase tracking-widest">Teams</div>
                {results.teams.map((team, i) => (
                  <button
                    key={`t-${team.id}`}
                    onClick={() => { navigateTo({ type: 'team', data: team }); setExpanded(false) }}
                    className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-colors ${selectedIdx === i ? 'bg-white/10' : 'hover:bg-white/5'}`}
                  >
                    {team.logo_url && <img src={team.logo_url} alt="" className="w-6 h-6 object-contain shrink-0" onError={(e) => { e.target.style.display = 'none' }} />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white truncate">{team.short_name || team.name}</div>
                      <div className="text-[11px] text-teal-300/50">{team.city}, {team.state}</div>
                    </div>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${divisionBadgeClass(team.division_level)}`}>{team.division_level}</span>
                  </button>
                ))}
              </div>
            )}
            {results.players.length > 0 && (
              <div>
                <div className="px-4 pt-3 pb-1 text-[10px] font-bold text-teal-300/50 uppercase tracking-widest">Players</div>
                {results.players.map((player, i) => {
                  const idx = results.teams.length + i
                  return (
                    <button
                      key={`p-${player.id}`}
                      onClick={() => { navigateTo({ type: 'player', data: player }); setExpanded(false) }}
                      className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-colors ${selectedIdx === idx ? 'bg-white/10' : 'hover:bg-white/5'}`}
                    >
                      {player.logo_url && <img src={player.logo_url} alt="" className="w-5 h-5 object-contain shrink-0" onError={(e) => { e.target.style.display = 'none' }} />}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-white truncate">{player.first_name} {player.last_name}</div>
                        <div className="text-[11px] text-teal-300/50">{player.team_short}{player.position ? ` · ${player.position}` : ''}</div>
                      </div>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${divisionBadgeClass(player.division_level)}`}>{player.division_level}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {open && query.length >= 2 && !loading && flatResults.length === 0 && (
          <div className="px-4 py-6 text-center text-teal-200/50">No results for "{query}"</div>
        )}
      </div>
    )
  }

  // Desktop: inline search bar
  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center bg-white/10 rounded-lg px-2.5 py-1.5 focus-within:bg-white/20 transition-colors">
        {/* Search icon */}
        <svg className="w-4 h-4 text-teal-200 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (results && query.length >= 2) setOpen(true) }}
          placeholder="Search players & teams..."
          className="bg-transparent border-none outline-none text-sm text-white placeholder-teal-200/50 ml-2 w-40 lg:w-48"
        />
        {loading && (
          <div className="animate-spin h-3.5 w-3.5 border-2 border-teal-200 border-t-transparent rounded-full ml-1 shrink-0" />
        )}
        {!loading && !query && (
          <kbd className="hidden sm:inline-block text-[10px] text-teal-200/40 bg-white/5 px-1.5 py-0.5 rounded border border-white/10 ml-1 shrink-0">/</kbd>
        )}
      </div>

      {/* Results dropdown */}
      {open && flatResults.length > 0 && (
        <div
          className="absolute top-full right-0 mt-1.5 w-80 max-h-96 overflow-y-auto rounded-xl shadow-2xl border border-white/10 z-50"
          style={{
            background: 'linear-gradient(160deg, #0c2234 0%, #0f3048 50%, #0a4a56 100%)',
          }}
        >
          {/* Teams section */}
          {results.teams.length > 0 && (
            <div>
              <div className="px-3 pt-3 pb-1 text-[10px] font-bold text-teal-300/50 uppercase tracking-widest">
                Teams
              </div>
              {results.teams.map((team, i) => {
                const idx = i
                return (
                  <button
                    key={`t-${team.id}`}
                    onClick={() => navigateTo({ type: 'team', data: team })}
                    onMouseEnter={() => setSelectedIdx(idx)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                      selectedIdx === idx ? 'bg-white/10' : 'hover:bg-white/5'
                    }`}
                  >
                    {team.logo_url && (
                      <img
                        src={team.logo_url}
                        alt=""
                        className="w-6 h-6 object-contain shrink-0"
                        onError={(e) => { e.target.style.display = 'none' }}
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white truncate">{team.short_name || team.name}</div>
                      <div className="text-[11px] text-teal-300/50">{team.city}, {team.state}</div>
                    </div>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${divisionBadgeClass(team.division_level)}`}>
                      {team.division_level}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Players section */}
          {results.players.length > 0 && (
            <div>
              <div className="px-3 pt-3 pb-1 text-[10px] font-bold text-teal-300/50 uppercase tracking-widest">
                Players
              </div>
              {results.players.map((player, i) => {
                const idx = results.teams.length + i
                return (
                  <button
                    key={`p-${player.id}`}
                    onClick={() => navigateTo({ type: 'player', data: player })}
                    onMouseEnter={() => setSelectedIdx(idx)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                      selectedIdx === idx ? 'bg-white/10' : 'hover:bg-white/5'
                    }`}
                  >
                    {player.logo_url && (
                      <img
                        src={player.logo_url}
                        alt=""
                        className="w-5 h-5 object-contain shrink-0"
                        onError={(e) => { e.target.style.display = 'none' }}
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white truncate">
                        {player.first_name} {player.last_name}
                      </div>
                      <div className="text-[11px] text-teal-300/50">
                        {player.team_short}
                        {player.position ? ` · ${player.position}` : ''}
                        {player.year_in_school ? ` · ${player.year_in_school}` : ''}
                      </div>
                    </div>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${divisionBadgeClass(player.division_level)}`}>
                      {player.division_level}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Footer */}
          <div className="px-3 py-2 border-t border-white/5">
            <div className="text-[10px] text-teal-300/30 text-center">
              Use arrow keys to navigate, Enter to select
            </div>
          </div>
        </div>
      )}

      {/* No results */}
      {open && query.length >= 2 && !loading && flatResults.length === 0 && (
        <div
          className="absolute top-full right-0 mt-1.5 w-72 rounded-xl shadow-2xl border border-white/10 z-50 px-4 py-3"
          style={{
            background: 'linear-gradient(160deg, #0c2234 0%, #0f3048 50%, #0a4a56 100%)',
          }}
        >
          <div className="text-sm text-teal-200/50 text-center">No results for "{query}"</div>
        </div>
      )}
    </div>
  )
}


// ─── Dropdown panel component ───
function DropdownPanel({ items, onClose }) {
  return (
    <div className="grid gap-1 p-3" style={{ minWidth: 260 }}>
      {items.map(item => (
        <Link
          key={item.to}
          to={item.to}
          onClick={onClose}
          className={`flex flex-col px-3 py-2.5 rounded-lg transition-colors group ${
            item.locked ? 'opacity-50 hover:bg-white/5' : 'hover:bg-white/10'
          }`}
        >
          <span className="text-sm font-semibold text-white group-hover:text-teal-200 transition-colors flex items-center gap-1.5">
            {item.label}
            {item.locked && (
              <svg className="w-3 h-3 text-teal-300/50" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
            )}
          </span>
          <span className="text-xs text-teal-300/60 mt-0.5">
            {item.locked ? 'Coming soon' : item.desc}
          </span>
        </Link>
      ))}
    </div>
  )
}

// ─── Single nav tab with hover dropdown ───
function NavTab({ section, isActive }) {
  const [open, setOpen] = useState(false)
  const timeoutRef = useRef(null)
  const tabRef = useRef(null)

  const handleEnter = () => {
    clearTimeout(timeoutRef.current)
    setOpen(true)
  }

  const handleLeave = () => {
    timeoutRef.current = setTimeout(() => setOpen(false), 150)
  }

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current)
  }, [])

  // Direct link (no dropdown), e.g. Glossary
  if (section.to) {
    return (
      <Link
        to={section.to}
        className={`px-3 py-1.5 rounded text-sm font-medium transition-colors whitespace-nowrap
          ${isActive
            ? 'bg-white/20 text-white'
            : 'text-teal-100 hover:text-white hover:bg-white/10'
          }`}
      >
        {section.label}
      </Link>
    )
  }

  return (
    <div
      ref={tabRef}
      className="relative"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        className={`px-3 py-1.5 rounded text-sm font-medium transition-colors flex items-center gap-1 whitespace-nowrap
          ${isActive || open
            ? 'bg-white/20 text-white'
            : 'text-teal-100 hover:text-white hover:bg-white/10'
          }`}
      >
        {section.label}
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-1 z-50 rounded-xl shadow-2xl border border-white/10 overflow-hidden"
          style={{
            background: 'linear-gradient(160deg, #0c2234 0%, #0f3048 50%, #0a4a56 100%)',
            backdropFilter: 'blur(20px)',
          }}
        >
          <DropdownPanel items={section.items} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

// ─── Main Header ───
export default function Header() {
  const location = useLocation()
  const navigate = useNavigate()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [mobileExpanded, setMobileExpanded] = useState(null)
  const { user, signOut } = useAuth()
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef(null)

  // Close user menu on outside click
  useEffect(() => {
    if (!userMenuOpen) return
    const handleClick = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [userMenuOpen])

  // Check if current path is active for a section
  const isSectionActive = (section) => {
    if (section.to) return location.pathname === section.to
    return section.items?.some(item => location.pathname === item.to)
  }

  return (
    <header className="bg-nw-teal text-white shadow-lg relative z-50">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          {/* Logo / Brand */}
          <Link to="/" className="flex items-center gap-2 sm:gap-3 shrink-0">
            <img
              src="/images/nw-logo-white.png"
              alt="NW Baseball Stats"
              className="h-8 w-8 sm:h-10 sm:w-10 rounded"
            />
            <div className="flex flex-col leading-tight">
              <span className="text-sm sm:text-xl font-bold tracking-wide font-display">
                NW BASEBALL STATS
              </span>
              <span className="text-[10px] text-teal-200 tracking-widest uppercase hidden sm:block">
                Northwest Baseball Statistics
              </span>
            </div>
          </Link>

          {/* Desktop Navigation + Search */}
          <div className="hidden lg:flex items-center gap-1">
            <nav className="flex items-center gap-0.5">
              {NAV.map(section => (
                <NavTab
                  key={section.label}
                  section={section}
                  isActive={isSectionActive(section)}
                />
              ))}
            </nav>
            <div className="ml-2 border-l border-white/15 pl-2">
              <SearchBar />
            </div>

            {/* Auth: Login button or User menu */}
            <div className="ml-2 border-l border-white/15 pl-2 relative" ref={userMenuRef}>
              {user ? (
                <>
                  <button
                    onClick={() => setUserMenuOpen(!userMenuOpen)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm
                               hover:bg-white/10 transition-colors text-teal-100"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                    <svg className={`w-3 h-3 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`}
                         fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {userMenuOpen && (
                    <div className="absolute right-0 top-full mt-1 w-48 bg-white rounded-lg shadow-lg
                                    border py-1 z-50">
                      <div className="px-3 py-2 text-xs text-gray-400 truncate border-b">
                        {user.email}
                      </div>
                      <Link
                        to="/favorites"
                        onClick={() => setUserMenuOpen(false)}
                        className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        My Favorites
                      </Link>
                      <button
                        onClick={() => { signOut(); setUserMenuOpen(false) }}
                        className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        Log Out
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <Link
                  to="/login"
                  className="px-3 py-1.5 rounded-md text-sm font-medium
                             bg-white/10 hover:bg-white/20 transition-colors text-white"
                >
                  Log In
                </Link>
              )}
            </div>
          </div>

          {/* Mobile: search + menu button */}
          <div className="lg:hidden flex items-center gap-1">
            <SearchBar mobile />
            <button
              className="p-2 rounded hover:bg-white/10 transition-colors"
              onClick={() => setMobileOpen(!mobileOpen)}
              aria-label="Toggle navigation"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {mobileOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {mobileOpen && (
          <nav className="lg:hidden pb-4 border-t border-white/10 pt-2 space-y-1">
            {NAV.map(section => {
              // Direct link
              if (section.to) {
                return (
                  <Link
                    key={section.label}
                    to={section.to}
                    onClick={() => setMobileOpen(false)}
                    className={`block px-3 py-2 rounded text-sm font-medium transition-colors
                      ${location.pathname === section.to
                        ? 'bg-white/20 text-white'
                        : 'text-teal-100 hover:text-white hover:bg-white/10'
                      }`}
                  >
                    {section.label}
                  </Link>
                )
              }

              // Expandable section
              const isExpanded = mobileExpanded === section.label
              return (
                <div key={section.label}>
                  <button
                    onClick={() => setMobileExpanded(isExpanded ? null : section.label)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded text-sm font-medium transition-colors
                      ${isSectionActive(section) ? 'bg-white/20 text-white' : 'text-teal-100 hover:text-white hover:bg-white/10'}`}
                  >
                    {section.label}
                    <svg className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {isExpanded && (
                    <div className="ml-4 mt-1 space-y-0.5 border-l border-white/10 pl-3">
                      {section.items.map(item => (
                        <Link
                          key={item.to}
                          to={item.to}
                          onClick={() => { setMobileOpen(false); setMobileExpanded(null) }}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors
                            ${item.locked ? 'opacity-50' : ''}
                            ${location.pathname === item.to
                              ? 'bg-white/15 text-white font-medium'
                              : 'text-teal-200/70 hover:text-white hover:bg-white/10'
                            }`}
                        >
                          {item.label}
                          {item.locked && (
                            <svg className="w-3 h-3 text-teal-300/40" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                              <path d="M7 11V7a5 5 0 0110 0v4" />
                            </svg>
                          )}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Mobile auth links */}
            <div className="border-t border-white/10 mt-2 pt-2">
              {user ? (
                <>
                  <div className="px-3 py-1 text-xs text-teal-200/50 truncate">{user.email}</div>
                  <Link
                    to="/favorites"
                    onClick={() => setMobileOpen(false)}
                    className="block px-3 py-2 rounded text-sm text-teal-100 hover:text-white hover:bg-white/10"
                  >
                    My Favorites
                  </Link>
                  <button
                    onClick={() => { signOut(); setMobileOpen(false) }}
                    className="w-full text-left px-3 py-2 rounded text-sm text-teal-100 hover:text-white hover:bg-white/10"
                  >
                    Log Out
                  </button>
                </>
              ) : (
                <Link
                  to="/login"
                  onClick={() => setMobileOpen(false)}
                  className="block px-3 py-2 rounded text-sm font-medium text-white bg-white/10 text-center"
                >
                  Log In / Sign Up
                </Link>
              )}
            </div>
          </nav>
        )}
      </div>
    </header>
  )
}
