import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useAllFavorites } from '../hooks/useFavorites'

export default function FavoritesPage() {
  const { user, loading: authLoading } = useAuth()
  const { teams, players, loading } = useAllFavorites()

  if (authLoading) return null
  if (!user) return <Navigate to="/login" replace />

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-6">My Favorites</h1>

      {loading && <div className="text-gray-400 animate-pulse">Loading...</div>}

      {!loading && teams.length === 0 && players.length === 0 && (
        <div className="bg-white rounded-xl border p-8 text-center text-gray-400">
          <p className="text-lg mb-2">No favorites yet</p>
          <p className="text-sm">
            Browse{' '}
            <Link to="/teams" className="text-nw-teal hover:underline">teams</Link>
            {' '}and{' '}
            <Link to="/players" className="text-nw-teal hover:underline">players</Link>
            {' '}to start following your favorites.
          </p>
        </div>
      )}

      {/* Teams section */}
      {teams.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-pnw-slate mb-3">
            Teams ({teams.length})
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {teams.map(t => (
              <Link
                key={t.id}
                to={`/team/${t.id}`}
                className="flex items-center gap-3 bg-white rounded-lg border p-3
                           hover:border-nw-teal/30 hover:shadow-sm transition-all"
              >
                {t.logo_url ? (
                  <img src={t.logo_url} alt="" className="w-10 h-10 object-contain" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center
                                  text-xs font-bold text-gray-400">
                    {t.short_name || '?'}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="font-medium text-pnw-slate truncate">{t.name}</div>
                  <div className="text-xs text-gray-400">
                    {t.division_level}{t.conference_abbrev ? ` · ${t.conference_abbrev}` : ''}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Players section */}
      {players.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-pnw-slate mb-3">
            Players ({players.length})
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {players.map(p => (
              <Link
                key={p.id}
                to={`/player/${p.id}`}
                className="flex items-center gap-3 bg-white rounded-lg border p-3
                           hover:border-nw-teal/30 hover:shadow-sm transition-all"
              >
                {p.image_url ? (
                  <img src={p.image_url} alt="" className="w-10 h-10 rounded-full object-cover" />
                ) : p.team_logo ? (
                  <img src={p.team_logo} alt="" className="w-10 h-10 object-contain opacity-50" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center
                                  text-xs font-bold text-gray-400">
                    {(p.first_name?.[0] || '') + (p.last_name?.[0] || '')}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="font-medium text-pnw-slate truncate">
                    {p.first_name} {p.last_name}
                  </div>
                  <div className="text-xs text-gray-400">
                    {p.position}{p.year ? ` · ${p.year}` : ''}
                    {p.team_name ? ` · ${p.team_name}` : ''}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
