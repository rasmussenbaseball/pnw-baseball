import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import StatsLastUpdated from '../components/StatsLastUpdated'

const API_BASE = '/api/v1'

export default function HometownSearch() {
  const [query, setQuery] = useState('')
  const [inputValue, setInputValue] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [topCities, setTopCities] = useState([])

  // Load top cities on mount
  useEffect(() => {
    fetch(`${API_BASE}/hometown-search?q=`)
      .then(r => r.json())
      .then(d => setTopCities(d.cities || []))
      .catch(() => {})
  }, [])

  // Fetch results when query changes
  useEffect(() => {
    if (!query) { setData(null); return }
    setLoading(true)
    fetch(`${API_BASE}/hometown-search?q=${encodeURIComponent(query)}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [query])

  const handleSubmit = (e) => {
    e.preventDefault()
    setQuery(inputValue.trim())
  }

  const handleCityClick = (city) => {
    // Extract just the city name (before the comma) for search
    const cityName = city.split(',')[0].trim()
    setInputValue(cityName)
    setQuery(cityName)
  }

  // Group players by team for the summary view
  const teamSummary = data?.teams || []
  const players = data?.players || []

  // Division filter
  const [divFilter, setDivFilter] = useState('All')
  const divisions = ['All', 'NCAA D1', 'NCAA D2', 'NCAA D3', 'NAIA', 'NWAC']

  const filteredPlayers = useMemo(() => {
    if (divFilter === 'All') return players
    return players.filter(p => p.division === divFilter)
  }, [players, divFilter])

  const filteredTeams = useMemo(() => {
    if (divFilter === 'All') return teamSummary
    return teamSummary.filter(t => t.division === divFilter)
  }, [teamSummary, divFilter])

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Hometown Search</h1>
      <p className="text-sm text-gray-500 mb-5">
        Search your hometown to see which PNW college programs players from your area have gone to.
      </p>

      {/* Search bar */}
      <form onSubmit={handleSubmit} className="mb-5">
        <div className="flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Enter a city (e.g. Seattle, Boise, Portland...)"
            className="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal focus:border-transparent"
          />
          <button
            type="submit"
            className="px-5 py-2.5 rounded-lg bg-nw-teal text-white text-sm font-medium hover:bg-teal-700 transition-colors"
          >
            Search
          </button>
        </div>
      </form>

      {/* Popular cities (shown when no search) */}
      {!data && !loading && topCities.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Popular Hometowns</h2>
          <div className="flex flex-wrap gap-2">
            {topCities.map(c => (
              <button
                key={c.hometown}
                onClick={() => handleCityClick(c.hometown)}
                className="px-3 py-1.5 rounded-full bg-gray-100 text-xs font-medium text-gray-600 hover:bg-nw-teal hover:text-white transition-colors"
              >
                {c.hometown} ({c.player_count})
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="text-center py-12 text-gray-400">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-nw-teal mx-auto mb-3" />
          Searching...
        </div>
      )}

      {/* Results */}
      {data && !loading && (
        <div>
          {/* Result count */}
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-gray-600">
              Found <span className="font-bold text-gray-800">{players.length}</span> player{players.length !== 1 ? 's' : ''} from
              {' '}<span className="font-bold text-nw-teal">"{data.query}"</span>
              {' '}across <span className="font-bold text-gray-800">{teamSummary.length}</span> program{teamSummary.length !== 1 ? 's' : ''}
            </p>
          </div>

          {players.length === 0 ? (
            <div className="text-center py-12 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-gray-500 text-sm">No players found. Try a different city name or a broader search.</p>
            </div>
          ) : (
            <>
              {/* Division filter */}
              <div className="flex gap-1 mb-4 overflow-x-auto pb-1">
                {divisions.map(d => (
                  <button
                    key={d}
                    onClick={() => setDivFilter(d)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                      divFilter === d
                        ? 'bg-nw-teal text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>

              {/* Team summary cards */}
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Programs with players from "{data.query}"</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 mb-6">
                {filteredTeams.map(t => (
                  <Link
                    key={t.team_id}
                    to={`/team/${t.team_id}`}
                    className="bg-white rounded-lg shadow-sm border border-gray-200 px-3 py-2.5 hover:border-nw-teal hover:shadow transition-all"
                  >
                    <p className="text-sm font-semibold text-gray-800 truncate">{t.team}</p>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] text-gray-400 uppercase">{t.division}</span>
                      <span className="text-sm font-bold text-nw-teal">{t.count}</span>
                    </div>
                  </Link>
                ))}
              </div>

              {/* Player table */}
              <h2 className="text-sm font-semibold text-gray-700 mb-3">All Players ({filteredPlayers.length})</h2>
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Player</th>
                        <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Hometown</th>
                        <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase hidden sm:table-cell">High School</th>
                        <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Team</th>
                        <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase hidden sm:table-cell">Division</th>
                        <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Pos</th>
                        <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase hidden sm:table-cell">Year</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPlayers.map((p, i) => (
                        <tr key={`${p.id}-${i}`} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <Link to={`/player/${p.id}`} className="text-nw-teal hover:underline font-medium">
                              {p.first_name} {p.last_name}
                            </Link>
                          </td>
                          <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{p.hometown}</td>
                          <td className="px-3 py-2 text-gray-500 whitespace-nowrap hidden sm:table-cell">
                            {p.high_school && p.high_school !== 'Full Bio' ? p.high_school : '-'}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <Link to={`/team/${p.team_id}`} className="text-gray-700 hover:text-nw-teal">
                              {p.team}
                            </Link>
                          </td>
                          <td className="px-3 py-2 text-gray-500 whitespace-nowrap hidden sm:table-cell">{p.division}</td>
                          <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{p.position || '-'}</td>
                          <td className="px-3 py-2 text-gray-500 whitespace-nowrap hidden sm:table-cell">{p.year_in_school || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <StatsLastUpdated className="mt-4" />
    </div>
  )
}
