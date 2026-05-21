import { Link } from 'react-router-dom'
import { useNwacMvpTracker } from '../hooks/useApi'

// ════════════════════════════════════════════════════════════════
// NWAC TOURNAMENT MVP WATCH
//
// The 10 most valuable players across the 8 championship teams, ranked
// by an MVP score (WAR rate primary, then total WAR, then wRC+ / FIP+),
// with at least 3 pitchers guaranteed. Sits next to the odds widget.
// ════════════════════════════════════════════════════════════════

export default function NWACMvpTracker() {
  const { data, loading } = useNwacMvpTracker(2026)
  const players = data?.players || []
  if (!loading && players.length === 0) return null

  return (
    <div className="h-full rounded-2xl overflow-hidden shadow-lg border border-pnw-teal/30 bg-gradient-to-br from-[#04323d] via-[#062f3a] to-[#021b22] flex flex-col">
      {/* Header */}
      <div className="px-4 sm:px-5 py-3 border-b border-white/10">
        <h2 className="text-sm sm:text-base font-extrabold tracking-tight text-white leading-snug">
          Tournament MVP Watch
        </h2>
        <p className="text-[10px] text-pnw-teal/70 mt-1 font-medium">
          Top value in the field · WAR rate, wRC+ / FIP+ · 8 teams
        </p>
      </div>

      {/* Rows */}
      <div className="flex-1 px-3 sm:px-4 py-2 divide-y divide-white/5">
        {loading && players.length === 0 ? (
          <div className="py-6 text-center text-white/40 text-sm animate-pulse">
            Loading candidates…
          </div>
        ) : (
          players.map((p) => <MvpRow key={p.player_id} player={p} />)
        )}
      </div>

      {/* Footer */}
      <div className="px-4 sm:px-5 py-2 border-t border-white/10 flex items-center justify-between">
        <span className="text-[10px] text-white/50">
          Ranked by value · 3+ pitchers
        </span>
        <Link
          to="/war"
          className="text-[10px] font-semibold text-pnw-teal hover:text-white transition-colors"
        >
          WAR leaders →
        </Link>
      </div>
    </div>
  )
}

function MvpRow({ player }) {
  const isPitcher = player.role === 'PIT'
  return (
    <Link
      to={`/player/${player.player_id}`}
      className="flex items-center gap-2 py-1.5 hover:bg-white/[0.04] transition-colors group"
    >
      {/* Rank */}
      <span className="w-4 text-center text-[11px] font-mono font-bold text-white/40 shrink-0">
        {player.rank}
      </span>

      {/* Team logo */}
      {player.team_logo ? (
        <img
          src={player.team_logo}
          alt=""
          className="w-5 h-5 object-contain shrink-0"
          onError={(e) => { e.currentTarget.style.display = 'none' }}
        />
      ) : (
        <span className="w-5 h-5 shrink-0" />
      )}

      {/* Name + stat line */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-semibold text-white truncate group-hover:text-pnw-teal transition-colors">
            {player.name}
          </span>
          <span
            className={`text-[7px] font-bold uppercase tracking-wider px-1 py-0.5 rounded shrink-0 ${
              isPitcher ? 'bg-sky-400/90 text-sky-950' : 'bg-emerald-400/90 text-emerald-950'
            }`}
          >
            {isPitcher ? 'P' : player.position}
          </span>
          <span className="text-[10px] text-white/35 shrink-0 truncate hidden sm:inline">
            {player.team_short}
          </span>
        </div>
        <div className="text-[10px] text-white/45 tabular-nums leading-tight mt-0.5 truncate">
          {player.stat_line}
        </div>
      </div>

      {/* WAR */}
      <div className="text-right shrink-0 w-12">
        <div className="text-sm font-bold tabular-nums leading-none text-white">
          {player.war?.toFixed(1)}
        </div>
        <div className="text-[8px] uppercase tracking-wider text-white/35 leading-tight">
          {isPitcher ? 'pWAR' : 'oWAR'}
        </div>
      </div>
    </Link>
  )
}
