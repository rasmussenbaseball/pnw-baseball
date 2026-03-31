import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useFavoritesDashboard } from '../hooks/useFavorites'
import { formatStat } from '../utils/stats'
import FavoriteButton from '../components/FavoriteButton'

// ── Player Card ─────────────────────────────────────────────
function PlayerCard({ p }) {
  const isPitcher = p.position === 'P' || p.position === 'LHP' || p.position === 'RHP'
  const bat = p.batting
  const pit = p.pitching
  const last7 = p.last7_batting
  const last3 = p.last3_pitching

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 flex items-center gap-3 border-b border-gray-100">
        {p.headshot_url ? (
          <img src={p.headshot_url} alt="" className="w-12 h-12 rounded-full object-cover border-2 border-gray-200 shrink-0"
            onError={e => { e.target.style.display = 'none' }} />
        ) : p.team_logo ? (
          <img src={p.team_logo} alt="" className="w-10 h-10 object-contain opacity-40 shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-sm font-bold text-gray-400 shrink-0">
            {(p.first_name?.[0] || '')}{(p.last_name?.[0] || '')}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Link to={`/player/${p.id}`} className="font-bold text-pnw-slate hover:text-nw-teal truncate">
              {p.first_name} {p.last_name}
            </Link>
            <FavoriteButton type="player" targetId={p.id} size="sm" />
          </div>
          <div className="flex items-center gap-1.5 text-xs text-gray-400 mt-0.5">
            {p.position && <span>{p.position}</span>}
            {p.year_in_school && <span>· {p.year_in_school}</span>}
            <span>·</span>
            <Link to={`/team/${p.team_id}`} className="hover:text-nw-teal flex items-center gap-1">
              {p.team_logo && <img src={p.team_logo} alt="" className="w-3.5 h-3.5 object-contain" />}
              {p.team_short}
            </Link>
            {p.division_level && <span className="px-1 py-0 rounded text-[9px] font-bold bg-gray-100">{p.division_level}</span>}
          </div>
        </div>
      </div>

      {/* Season Stats */}
      <div className="px-4 py-2">
        {/* Batting season line */}
        {bat && !isPitcher && (
          <div>
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
              {bat.season} Batting
            </div>
            <div className="grid grid-cols-6 gap-1 text-center">
              {[
                ['AVG', formatStat(bat.batting_avg, 'avg')],
                ['OPS', formatStat(bat.ops, 'avg')],
                ['HR', bat.home_runs || 0],
                ['RBI', bat.rbi || 0],
                ['SB', bat.stolen_bases || 0],
                ['G', bat.games || 0],
              ].map(([label, val]) => (
                <div key={label}>
                  <div className="text-[10px] text-gray-400">{label}</div>
                  <div className="text-sm font-semibold text-gray-800 tabular-nums">{val}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pitching season line */}
        {pit && isPitcher && (
          <div>
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
              {pit.season} Pitching
            </div>
            <div className="grid grid-cols-6 gap-1 text-center">
              {[
                ['ERA', formatStat(pit.era, 'era')],
                ['WHIP', formatStat(pit.whip, 'era')],
                ['K', pit.strikeouts || 0],
                ['IP', formatStat(pit.innings_pitched, 'ip')],
                ['W-L', `${pit.wins || 0}-${pit.losses || 0}`],
                ['SV', pit.saves || 0],
              ].map(([label, val]) => (
                <div key={label}>
                  <div className="text-[10px] text-gray-400">{label}</div>
                  <div className="text-sm font-semibold text-gray-800 tabular-nums">{val}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Two-way: show both */}
        {bat && isPitcher && (
          <div className="mt-2">
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
              Batting
            </div>
            <div className="grid grid-cols-4 gap-1 text-center">
              {[
                ['AVG', formatStat(bat.batting_avg, 'avg')],
                ['HR', bat.home_runs || 0],
                ['RBI', bat.rbi || 0],
                ['G', bat.games || 0],
              ].map(([label, val]) => (
                <div key={label}>
                  <div className="text-[10px] text-gray-400">{label}</div>
                  <div className="text-xs font-semibold text-gray-700 tabular-nums">{val}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {pit && !isPitcher && bat && (
          <div className="mt-2">
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
              Pitching
            </div>
            <div className="grid grid-cols-4 gap-1 text-center">
              {[
                ['ERA', formatStat(pit.era, 'era')],
                ['K', pit.strikeouts || 0],
                ['IP', formatStat(pit.innings_pitched, 'ip')],
                ['W-L', `${pit.wins || 0}-${pit.losses || 0}`],
              ].map(([label, val]) => (
                <div key={label}>
                  <div className="text-[10px] text-gray-400">{label}</div>
                  <div className="text-xs font-semibold text-gray-700 tabular-nums">{val}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!bat && !pit && (
          <div className="text-xs text-gray-400 italic py-1">No stats recorded yet</div>
        )}
      </div>

      {/* Trend line */}
      {last7 && last7.games > 0 && !isPitcher && (
        <div className="px-4 py-2 border-t border-gray-50 bg-gray-50/50">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold text-gray-400 uppercase">Last {last7.games}G</span>
            <div className="flex gap-3 text-xs tabular-nums">
              <span className={last7.avg >= 0.300 ? 'text-green-600 font-bold' : last7.avg < 0.200 ? 'text-red-500 font-bold' : 'text-gray-600 font-medium'}>
                {last7.avg != null ? last7.avg.toFixed(3) : '-'}
              </span>
              <span className="text-gray-500">{last7.h}-{last7.ab}</span>
              {last7.hr > 0 && <span className="text-gray-600">{last7.hr} HR</span>}
              {last7.rbi > 0 && <span className="text-gray-600">{last7.rbi} RBI</span>}
            </div>
          </div>
        </div>
      )}

      {last3 && last3.games > 0 && isPitcher && (
        <div className="px-4 py-2 border-t border-gray-50 bg-gray-50/50">
          <div className="text-[10px] font-semibold text-gray-400 uppercase mb-1">Last {last3.games} Appearances</div>
          <div className="space-y-0.5">
            {last3.recent.map((g, i) => (
              <div key={i} className="flex items-center gap-2 text-xs tabular-nums">
                <span className="text-gray-400 w-12">{new Date(g.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                <span className="text-gray-700">{g.ip.toFixed(1)} IP</span>
                <span className="text-gray-500">{g.er} ER</span>
                <span className="text-gray-500">{g.k} K</span>
                {g.decision && (
                  <span className={`font-bold ${g.decision === 'W' ? 'text-green-600' : g.decision === 'L' ? 'text-red-500' : 'text-gray-500'}`}>
                    {g.decision}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}


// ── Team Card ───────────────────────────────────────────────
function TeamCard({ t }) {
  const record = [t.wins ?? '-', t.losses ?? '-'].join('-')
  const confRecord = (t.conference_wins != null && t.conference_losses != null)
    ? `${t.conference_wins}-${t.conference_losses}`
    : null

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 flex items-center gap-3 border-b border-gray-100">
        {t.logo_url ? (
          <img src={t.logo_url} alt="" className="w-12 h-12 object-contain shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-400">
            {t.short_name || '?'}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Link to={`/team/${t.id}`} className="font-bold text-pnw-slate hover:text-nw-teal truncate">
              {t.name}
            </Link>
            <FavoriteButton type="team" targetId={t.id} size="sm" />
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-400 mt-0.5">
            {t.division_level && <span className="px-1 py-0 rounded text-[9px] font-bold bg-gray-100">{t.division_level}</span>}
            {t.conference_abbrev && <span>{t.conference_abbrev}</span>}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-lg font-bold text-gray-800 tabular-nums">{record}</div>
          {confRecord && <div className="text-[10px] text-gray-400">{confRecord} conf</div>}
        </div>
      </div>

      {/* Last 5 results */}
      {t.last5 && t.last5.length > 0 && (
        <div className="px-4 py-2 border-b border-gray-50">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Recent Results</div>
          <div className="space-y-0.5">
            {t.last5.map((g, i) => (
              <div key={i} className="flex items-center gap-2 text-xs tabular-nums">
                <span className={`font-bold w-4 text-center ${g.won ? 'text-green-600' : 'text-red-500'}`}>
                  {g.won ? 'W' : 'L'}
                </span>
                <span className="text-gray-800 font-medium w-8">{g.team_score}-{g.opp_score}</span>
                <span className="text-gray-400">{g.home_away}</span>
                <span className="flex items-center gap-1 text-gray-600 truncate">
                  {g.opp_logo && <img src={g.opp_logo} alt="" className="w-3 h-3 object-contain" />}
                  {g.opponent}
                </span>
                <span className="ml-auto text-gray-300 text-[10px]">
                  {new Date(g.game_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stat leaders */}
      {(t.batting_leaders?.length > 0 || t.pitching_leaders?.length > 0) && (
        <div className="px-4 py-2 bg-gray-50/50">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Team Leaders</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            {(t.batting_leaders || []).map((b, i) => (
              <div key={`b${i}`} className="flex items-center justify-between text-xs">
                <Link to={`/player/${b.id}`} className="text-gray-700 hover:text-nw-teal truncate">
                  {b.first_name[0]}. {b.last_name}
                </Link>
                <span className="text-gray-500 tabular-nums ml-1">
                  {formatStat(b.batting_avg, 'avg')}/{formatStat(b.ops, 'avg')}
                </span>
              </div>
            ))}
            {(t.pitching_leaders || []).map((pl, i) => (
              <div key={`p${i}`} className="flex items-center justify-between text-xs">
                <Link to={`/player/${pl.id}`} className="text-gray-700 hover:text-nw-teal truncate">
                  {pl.first_name[0]}. {pl.last_name}
                </Link>
                <span className="text-gray-500 tabular-nums ml-1">
                  {formatStat(pl.era, 'era')} ERA
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}


// ── Main Page ───────────────────────────────────────────────
export default function FavoritesPage() {
  const { user, loading: authLoading } = useAuth()
  const { data, loading } = useFavoritesDashboard()

  if (authLoading) return null
  if (!user) return <Navigate to="/login" replace />

  const teams = data?.teams || []
  const players = data?.players || []

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
          <div className="grid gap-4 lg:grid-cols-2">
            {teams.map(t => <TeamCard key={t.id} t={t} />)}
          </div>
        </div>
      )}

      {/* Players section */}
      {players.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-pnw-slate mb-3">
            Players ({players.length})
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {players.map(p => <PlayerCard key={p.id} p={p} />)}
          </div>
        </div>
      )}
    </div>
  )
}
