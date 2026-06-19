import { useState, useRef, useEffect, useCallback } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { divisionBadgeClass } from '../utils/stats'
import { useAuth } from '../context/AuthContext'
import { useTier } from '../hooks/useTier'
import { tierMeets, TIER_META, DEVELOPER_EMAILS, ARTICLE_AUTHOR_EMAILS } from '../lib/tiers'
import { isGmFreePlay } from '../lib/gmPromo'

// During the launch-week free-play promo the NW Coaching Simulator is open
// to everyone, so we drop its nav lock badge. Reverts automatically after
// the cutoff in lib/gmPromo.js.
function effectiveRequires(item) {
  if (item.to === '/gm' && isGmFreePlay()) return undefined
  return item.requires
}

// ─── Navigation structure ───
const NAV = [
  {
    // Visibility model: main tabs are always open so anonymous visitors
    // can SEE what's available. Individual items carry `requires: 'free'`
    // to show a lock icon for anonymous users and route-level gates
    // (RequireTier minTier="free") handle the actual block.
    label: 'Stats',
    items: [
      { to: '/stat-leaders', label: 'Stat Leaders', desc: 'Top 10 in key categories' },
      { to: '/hitting', label: 'Hitting', desc: 'Batting leaderboards & stats' },
      { to: '/pitching', label: 'Pitching', desc: 'Pitching leaderboards & stats' },
      { to: '/relievers', label: 'Relievers', desc: 'Goose Eggs, reliever WPA & bullpen leaders' },
      { to: '/fielding', label: 'Fielding', desc: 'Defensive leaderboards, filterable by position' },
      { to: '/team-stats', label: 'Team Stats', desc: 'Team-level hitting & pitching stats', requires: 'free' },
      { to: '/war', label: 'WAR Leaderboard', desc: 'Wins Above Replacement rankings' },
      { to: '/percentiles', label: 'Percentiles', desc: 'Baseball Savant-style percentile rankings', requires: 'free' },
      { to: '/player-comps', label: 'Player Comps', desc: "Each player's closest statistical comparables (NW + MLB)", requires: 'free' },
      { to: '/records', label: 'Records', desc: 'Single-season & career record holders', requires: 'free' },
      { to: '/top-moments', label: 'Top Moments', desc: "The season's biggest WPA swings and clutch leaderboards", requires: 'free' },
    ],
  },
  {
    label: 'Teams',
    items: [
      { to: '/scoreboard', label: 'Scoreboard', desc: 'Scores, results & schedules' },
      { to: '/teams', label: 'Team Pages', desc: 'Rosters, stats & profiles' },
      { to: '/projections', label: 'Projections', desc: '2027 projected rosters (incl. transfers)', requires: 'dev' },
      { to: '/pro-tracker', label: 'Pro Tracker', desc: 'PNW alumni in MiLB & MLB, by school' },
      { to: '/standings', label: 'Standings', desc: 'Conference & overall rankings' },
      { to: '/team-ratings', label: 'Team Ratings (CPI)', desc: 'Within-division power rankings' },
      { to: '/national-rankings', label: 'National Rankings', desc: 'Where PNW teams rank nationally' },
      { to: '/team-history', label: 'History', desc: 'Historical team performance', requires: 'free' },
    ],
  },
  {
    // Tab itself is open so anonymous visitors can see what recruiting
    // tools exist. Each item carries requires:'premium' so the lock
    // clicking sends them to the upsell card.
    label: 'Recruiting',
    items: [
      { to: '/recruiting', label: 'Recruiting Hub', desc: 'Start here: every recruiting tool, explained. Free to browse.' },
      { to: '/recruiting/tips', label: 'Recruiting Tips', desc: 'How to get recruited + freshman production by level', requires: 'premium' },
      { to: '/recruiting/advancement', label: 'NWAC Advancement', desc: 'Where NWAC teams send players + 2026 D1 commits', requires: 'premium' },
      { to: '/recruiting/quiz', label: 'Recruit Matchmaker', desc: 'Match yourself to your best-fit NW program', requires: 'premium' },
      { to: '/recruiting/breakdown', label: 'Breakdown', desc: 'Team-level recruiting metrics & trends', requires: 'premium' },
      { to: '/recruiting/hometown', label: 'Hometown Search', desc: 'Find players from your city', requires: 'premium' },
      { to: '/recruiting/guide', label: 'Recruiting Guide', desc: 'Complete program profiles & analysis', requires: 'premium' },
      { to: '/recruiting/program-guide', label: 'Program Guide (PDF)', desc: 'In-depth PDF book on all 57 PNW programs', requires: 'premium' },
      { to: '/recruiting/map', label: 'Map', desc: 'PNW program locations', requires: 'premium' },
      { to: '/recruiting-classes', label: 'Recruiting Classes', desc: 'Incoming class breakdowns', requires: 'premium' },
    ],
  },
  // News splits into Articles (the original /news list) and Commitments
  // (running list of new college commitments — JUCO now, HS soon).
  {
    label: 'News',
    items: [
      { to: '/news', label: 'Articles',
        desc: 'Stories, recaps, and notes from around PNW college baseball' },
      { to: '/news/commitments', label: 'Commitments',
        desc: 'NWAC commitments to 4-year programs (HS commitments coming soon)',
        requires: 'recruiting' },
    ],
  },
  // Summer baseball — currently WCL, more leagues later. The tab is
  // visible to everyone; items carry requires:'free' so anonymous
  // visitors see a lock (prompting signup) while every signed-in tier
  // has full access (routes use RequireAuth in App.jsx).
  {
    label: 'Summer',
    items: [
      { to: '/summer',             label: 'WCL Hub',        desc: 'Overview: today\'s games, leaders, standings + links to every section', requires: 'free' },
      { to: '/summer/scoreboard',  label: 'Scoreboard',     desc: 'Recent + upcoming WCL games, list and calendar views', requires: 'free' },
      { to: '/summer/standings',   label: 'Standings',      desc: 'North + South division standings with L10 and streaks', requires: 'free' },
      { to: '/summer/stats',       label: 'Stats',          desc: 'Batting, pitching, fielding leaderboards. Multi-year picker.', requires: 'free' },
      { to: '/summer/cpi',         label: 'Power Index',    desc: 'Composite Power Index: predictive, schedule-adjusted team rankings', requires: 'free' },
      { to: '/summer/teams',       label: 'Teams',          desc: 'Browse every WCL club, grouped by division', requires: 'free' },
      { to: '/summer/pnw-alumni',  label: 'PNW Alumni',     desc: 'PNW college players on WCL rosters this summer', requires: 'free' },
      { to: '/summer/college-mix', label: 'College Mix',    desc: 'Most-represented schools in the WCL', requires: 'free' },
    ],
  },
  // Tab is open so anonymous can browse; each item enforces its own
  // gate (free account minimum for Grid/Quiz, premium for the Sim).
  {
    label: 'Games',
    items: [
      { to: '/gm', label: 'NW Coaching Simulator',
        desc: 'Coach any Pacific Northwest college baseball program — D1 through NWAC, dynasty or career mode (alpha)',
        requires: 'premium' },
      { to: '/pnw-grid', label: 'PNW Grid',
        desc: 'Immaculate Grid for PNW baseball',
        requires: 'free' },
      { to: '/team-quiz', label: 'Team Quiz',
        desc: 'Test your knowledge of a PNW team across one or more seasons',
        requires: 'free' },
      { to: '/fieldguessr', label: 'FieldGuessr',
        desc: 'Guess the PNW ballpark from a photo of the field',
        requires: 'free' },
      { to: '/draft', label: '56-0',
        desc: 'Draft the best PNW roster and chase a perfect 56-0 season' },
      { to: '/wcl-pickem', label: "WCL Pick 'Em",
        desc: 'Weekly confidence pool — pick every WCL game and climb the leaderboard' },
    ],
  },
  {
    // Tab is open. Every item inside is premium-gated at the route
    // level; the lock icon here signals that for anonymous browsers.
    label: 'Coaching',
    items: [
      { to: '/portal', label: 'Coach & Scouting Portal',
        desc: 'Trends, opponent scouting, and PDFs in one workspace',
        requires: 'coach' },
      { to: '/compare', label: 'Matchups', desc: 'Head-to-head team comparisons',
        requires: 'free' },
      { to: '/park-factors', label: 'Park Factors', desc: 'Ballpark effects on stats',
        requires: 'premium' },
      { to: '/draftboard', label: 'Draft Board', desc: 'PNW college baseball MLB draft board',
        requires: 'premium' },
      { to: '/coaching/juco-tracker', label: 'JUCO Tracker',
        desc: 'NWAC players available for transfer to 4-year programs',
        requires: 'recruiting' },
      { to: '/coaching/transfer-portal', label: 'Transfer Portal Tracker',
        desc: 'PNW four-year players who have entered the transfer portal',
        requires: 'recruiting' },
    ],
  },
  {
    label: 'Misc',
    // Public: anonymous users need to be able to read About and the
    // Subscriptions/pricing page (otherwise they can't convert!).
    // Individual items inside (Graphics, Feature Request) can enforce
    // their own gate at the route level when needed.
    items: [
      { to: '/about', label: 'About',
        desc: 'The team, the build, the stat glossary, the run environments' },
      { to: '/pricing', label: 'Subscriptions',
        desc: 'Compare Free, Premium, and Coach & Scout tiers' },
      { to: '/graphics-hub', label: 'Graphics',
        desc: 'Pick from every social-media graphic generator on the site',
        requires: 'free' },
      { to: '/feature-request', label: 'Request a Feature',
        desc: 'Submit ideas and feedback' },
      // Owner-only authoring tools — articles + email blasts are limited to
      // ARTICLE_AUTHOR_EMAILS (NOT the dev/intern list).
      { to: '/articles', label: 'Write Articles',
        desc: 'Draft, edit, and publish site articles',
        requireEmail: ARTICLE_AUTHOR_EMAILS },
      { to: '/broadcasts', label: 'Email Broadcasts',
        desc: 'Compose and send to opted-in subscribers',
        requireEmail: ARTICLE_AUTHOR_EMAILS },
      // Dev tools — visible to site developers + interns (DEVELOPER_EMAILS).
      { to: '/commitment-editor', label: 'Commitment Editor',
        desc: 'Search an NWAC or transfer player and update / undo their commitment, live',
        requireEmail: DEVELOPER_EMAILS },
      { to: '/trackman-data', label: 'TrackMan Data',
        desc: 'Filterable pitch-shape stat tables (velo, movement, whiff/chase) across all ingested WCL teams',
        requireEmail: DEVELOPER_EMAILS },
      // Visual divider — items below are kept around for reference but
      // are no longer the active tools used regularly.
      { heading: 'Archived' },
      { to: '/all-conference', label: 'All-Conference Generator',
        desc: 'Build mock first, second, and HM teams from season stats',
        requires: 'free' },
      { to: '/playoff-projections', label: 'Playoff Projections',
        desc: 'Projected standings & playoff fields',
        requires: 'free' },
    ],
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
      navigate(item.data.kind === 'summer' ? `/summer/players/${item.data.id}` : `/player/${item.data.id}`)
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
            className="flex-1 bg-transparent dark:bg-transparent border-none outline-none text-base text-white placeholder-teal-200/50"
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
                      key={`p-${player.kind || 'spring'}-${player.id}`}
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
          className="bg-transparent dark:bg-transparent border-none outline-none text-sm text-white placeholder-teal-200/50 ml-2 w-40 lg:w-48"
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
                    key={`p-${player.kind || 'spring'}-${player.id}`}
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


// Visibility filtering on dropdown items:
//   - requireEmail: ['...']  → only render for matching emails (case-insensitive).
//   - requires: 'dev'        → hide from non-devs entirely (in-progress /
//                              internal tools). The lock-icon model in the
//                              other `requires` values doesn't apply here
//                              because non-devs have no upgrade path.
// Other requires values ('free' | 'premium' | 'coach') leave the item
// visible and let the dropdown render decide whether to show a lock.
function filterItemsForUser(items, userEmail, tier) {
  const email = (userEmail || '').toLowerCase()
  const isDev = tier === 'dev'
  return items.filter(i => {
    if (i.requireEmail && !i.requireEmail.map(e => e.toLowerCase()).includes(email)) {
      return false
    }
    if (i.requires === 'dev' && !isDev) return false
    return true
  })
}

// ─── Dropdown panel component ───
// Three states a sub-item can be in:
//   - locked: true        → "Coming soon", always opaque + locked icon
//   - requires: '<tier>'  → lock icon when the viewer's tier is below
//                           the item's required tier. So requires='free'
//                           locks for anonymous; requires='premium' locks
//                           for anonymous and free; requires='coach'
//                           locks for everyone below Coach & Scout.
//   - (default)           → fully open
function DropdownPanel({ items, onClose }) {
  const { user } = useAuth()
  const { tier } = useTier()
  const visible = filterItemsForUser(items, user?.email, tier)
  return (
    <div className="grid gap-0.5 p-2" style={{ minWidth: 240 }}>
      {visible.map((item, i) => {
        if (item.heading) {
          return (
            <div key={`h-${i}`} className="px-2.5 pt-3 pb-1 mt-1 border-t border-white/10">
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-teal-300/60">
                {item.heading}
              </span>
            </div>
          )
        }
        const req = effectiveRequires(item)
        const needsUpgrade = req && !tierMeets(tier, req)
        const showLock = item.locked || needsUpgrade
        const subtext = item.locked
          ? 'Coming soon'
          : (needsUpgrade
              ? `${TIER_META[req]?.label || req} required`
              : item.desc)
        // Visual treatment for locked rows: knock down opacity so they
        // read as clearly inaccessible without removing them from the
        // menu (the whole point of showing them is discoverability).
        const dimmed = item.locked || needsUpgrade
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={onClose}
            className={`flex flex-col px-2.5 py-1.5 rounded-md transition-colors group ${
              dimmed ? 'opacity-55 hover:opacity-90 hover:bg-white/5' : 'hover:bg-white/10'
            }`}
          >
            <span className="text-[13px] font-semibold text-white group-hover:text-teal-200 transition-colors flex items-center gap-1.5 leading-tight">
              {item.label}
              {showLock && (
                <svg className="w-3 h-3 text-teal-300/50" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
              )}
            </span>
            <span className="text-[11px] text-teal-300/60 mt-0 leading-tight">
              {subtext}
            </span>
          </Link>
        )
      })}
    </div>
  )
}

// ─── Single nav tab with hover dropdown ───
function NavTab({ section, isActive, user }) {
  const [open, setOpen] = useState(false)
  const timeoutRef = useRef(null)
  const tabRef = useRef(null)
  const navigate = useNavigate()

  const ADMIN_EMAILS = ['nate.rasmussen26@gmail.com']
  const isAdmin = user && ADMIN_EMAILS.includes(user.email)
  const isLocked = (section.authRequired && !user) || (section.adminOnly && !isAdmin)

  const handleEnter = () => {
    clearTimeout(timeoutRef.current)
    if (!isLocked) setOpen(true)
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

  // Auth-gated section - show lock icon, redirect to login on click
  if (isLocked) {
    return (
      <button
        onClick={() => navigate('/login')}
        className="px-3 py-1.5 rounded text-sm font-medium transition-colors flex items-center gap-1 whitespace-nowrap text-teal-100/60 hover:text-white hover:bg-white/10"
      >
        {section.label}
        <svg className="w-3 h-3 text-teal-300/40" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
      </button>
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
  const { tier } = useTier()
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
    if (section.to) return location.pathname.startsWith(section.to)
    return section.items?.some(item => location.pathname === item.to)
  }

  // Tab-level visibility. A section with `requireEmail` is hidden
  // entirely from non-matching users (no upsell, no lock icon — it
  // just disappears). Used to gate the Summer tab to devs while the
  // WCL section is still being built out.
  const visibleNav = NAV.filter(section => {
    if (section.requireEmail) {
      const email = (user?.email || '').toLowerCase()
      const allowed = section.requireEmail.map(e => e.toLowerCase())
      if (!allowed.includes(email)) return false
    }
    return true
  })

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
              <span className="text-sm sm:text-xl tracking-tight font-sans font-bold">
                NW BASEBALL STATS
              </span>
            </div>
          </Link>

          {/* Desktop Navigation + Search */}
          <div className="hidden lg:flex items-center gap-1">
            <nav className="flex items-center gap-0.5">
              {visibleNav.map(section => (
                <NavTab
                  key={section.label}
                  section={section}
                  isActive={isSectionActive(section)}
                  user={user}
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
                    <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-800
                                    rounded-lg shadow-lg border border-gray-200 dark:border-gray-700
                                    py-1 z-50">
                      <div className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500 truncate
                                      border-b border-gray-200 dark:border-gray-700">
                        {user.email}
                      </div>
                      <Link
                        to="/account"
                        onClick={() => setUserMenuOpen(false)}
                        className="block px-3 py-2 text-sm text-gray-700 dark:text-gray-200
                                   hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        My Account
                      </Link>
                      <Link
                        to="/favorites"
                        onClick={() => setUserMenuOpen(false)}
                        className="block px-3 py-2 text-sm text-gray-700 dark:text-gray-200
                                   hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        My Favorites
                      </Link>
                      <button
                        onClick={() => { signOut(); setUserMenuOpen(false) }}
                        className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200
                                   hover:bg-gray-50 dark:hover:bg-gray-700"
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
            {visibleNav.map(section => {
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
              const mobileIsAdmin = user && ['nate.rasmussen26@gmail.com'].includes(user.email)
              const isMobileLocked = (section.authRequired && !user) || (section.adminOnly && !mobileIsAdmin)

              // Auth-gated: show lock, redirect to login
              if (isMobileLocked) {
                return (
                  <Link
                    key={section.label}
                    to="/login"
                    onClick={() => setMobileOpen(false)}
                    className="flex items-center justify-between px-3 py-2 rounded text-sm font-medium text-teal-100/60 hover:text-white hover:bg-white/10"
                  >
                    {section.label}
                    <svg className="w-3.5 h-3.5 text-teal-300/40" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0110 0v4" />
                    </svg>
                  </Link>
                )
              }

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
                      {filterItemsForUser(section.items, user?.email, tier).map((item, i) => (
                        item.heading ? (
                          <div key={`mh-${i}`} className="px-3 pt-2 pb-1 mt-1 border-t border-white/10">
                            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-teal-300/60">
                              {item.heading}
                            </span>
                          </div>
                        ) : (
                          (() => {
                            const req = effectiveRequires(item)
                            const needsUpgrade = req && !tierMeets(tier, req)
                            const showLock = item.locked || needsUpgrade
                            const dimmed = item.locked || needsUpgrade
                            return (
                              <Link
                                key={item.to}
                                to={item.to}
                                onClick={() => { setMobileOpen(false); setMobileExpanded(null) }}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors
                                  ${dimmed ? 'opacity-55' : ''}
                                  ${location.pathname === item.to
                                    ? 'bg-white/15 text-white font-medium'
                                    : 'text-teal-200/70 hover:text-white hover:bg-white/10'
                                  }`}
                              >
                                {item.label}
                                {showLock && (
                                  <svg className="w-3 h-3 text-teal-300/40" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                    <path d="M7 11V7a5 5 0 0110 0v4" />
                                  </svg>
                                )}
                              </Link>
                            )
                          })()
                        )
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
                    to="/account"
                    onClick={() => setMobileOpen(false)}
                    className="block px-3 py-2 rounded text-sm text-teal-100 hover:text-white hover:bg-white/10"
                  >
                    My Account
                  </Link>
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
