import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTeams } from '../hooks/useApi'
import { divisionBadgeClass } from '../utils/stats'

export default function TeamHistory() {
  const { data: teams, loading } = useTeams()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')

  const filteredTeams = (teams || []).filter(t =>
    t.name?.toLowerCase().includes(search.toLowerCase()) ||
    t.short_name?.toLowerCase().includes(search.toLowerCase())
  )

  // Group by division
  const grouped = {}
  filteredTeams.forEach(t => {
    const div = t.division_level || 'Other'
    if (!grouped[div]) grouped[div] = []
    grouped[div].push(t)
  })

  const divOrder = ['D1', 'D2', 'D3', 'NAIA', 'JUCO']

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-2">Program History</h1>
      <p className="text-sm text-gray-500 mb-4">
        Select a team to view year-by-year records, season stat leaders, and all-time career leaders.
      </p>

      {/* Search */}
      <input
        type="text"
        placeholder="Search teams..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full max-w-md px-3 py-2 border rounded-lg text-sm mb-6 focus:outline-none focus:ring-2 focus:ring-pnw-teal/30"
      />

      {loading && <div className="text-gray-400 animate-pulse">Loading teams...</div>}

      {divOrder.map(div => {
        const divTeams = grouped[div]
        if (!divTeams || divTeams.length === 0) return null
        return (
          <div key={div} className="mb-6">
            <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wide mb-2">
              <span className={`px-2 py-0.5 rounded text-xs font-bold ${divisionBadgeClass(div)}`}>
                {div}
              </span>
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {divTeams.sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name)).map(t => (
                <Link
                  key={t.id}
                  to={`/team/${t.id}?tab=history`}
                  className="flex items-center gap-2 px-3 py-2 bg-white rounded-lg border hover:border-pnw-teal/50 hover:bg-gray-50 transition-colors"
                >
                  {t.logo_url && (
                    <img
                      src={t.logo_url}
                      alt=""
                      className="w-6 h-6 object-contain"
                      onError={(e) => { e.target.style.display = 'none' }}
                    />
                  )}
                  <span className="text-sm font-medium text-pnw-slate">{t.short_name || t.name}</span>
                </Link>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
