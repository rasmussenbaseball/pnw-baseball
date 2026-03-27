import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { divisionBadgeClass } from '../utils/stats'

export default function PlayerSearch() {
  const [query, setQuery] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [jucoOnly, setJucoOnly] = useState(false)
  const [uncommittedOnly, setUncommittedOnly] = useState(false)

  const { data, loading } = useApi(
    searchTerm.length >= 2 ? '/players/search' : null,
    {
      q: searchTerm,
      juco_only: jucoOnly || undefined,
      uncommitted_only: uncommittedOnly || undefined,
      limit: 50,
    },
    [searchTerm, jucoOnly, uncommittedOnly]
  )

  const handleSearch = (e) => {
    e.preventDefault()
    setSearchTerm(query)
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-4">Player Search</h1>

      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by player name..."
          className="flex-1 max-w-md rounded border border-gray-300 px-4 py-2 text-sm
                     focus:ring-2 focus:ring-pnw-sky focus:border-transparent"
        />
        <button
          type="submit"
          className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-medium hover:bg-pnw-forest"
        >
          Search
        </button>
      </form>

      <div className="flex gap-4 mb-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={jucoOnly}
            onChange={(e) => setJucoOnly(e.target.checked)}
            className="rounded border-gray-300"
          />
          JUCO players only
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={uncommittedOnly}
            onChange={(e) => setUncommittedOnly(e.target.checked)}
            className="rounded border-gray-300"
          />
          Uncommitted only
        </label>
      </div>

      {loading && (
        <div className="text-gray-400 animate-pulse">Searching...</div>
      )}

      {data && data.length === 0 && searchTerm && (
        <p className="text-gray-500">No players found for "{searchTerm}"</p>
      )}

      {data && data.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
          <table className="stat-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Team</th>
                <th>Lvl</th>
                <th>Pos</th>
                <th>Yr</th>
                <th>B/T</th>
                <th>Hometown</th>
                <th>Committed To</th>
              </tr>
            </thead>
            <tbody>
              {data.map(p => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/player/${p.id}`} className="player-link">
                      {p.first_name} {p.last_name}
                    </Link>
                  </td>
                  <td>{p.team_short || p.team_name}</td>
                  <td>
                    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-bold ${divisionBadgeClass(p.division_level)}`}>
                      {p.division_level}
                    </span>
                  </td>
                  <td>{p.position}</td>
                  <td>{p.year_in_school}</td>
                  <td className="text-gray-500">{p.bats}/{p.throws}</td>
                  <td className="text-gray-500">{p.hometown || '-'}</td>
                  <td>
                    {p.is_committed
                      ? <span className="text-green-600 font-medium">{p.committed_to}</span>
                      : <span className="text-orange-500 text-xs">Uncommitted</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
