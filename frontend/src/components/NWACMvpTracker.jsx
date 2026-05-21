import { Link } from 'react-router-dom'
import { useNwacMvpTracker } from '../hooks/useApi'

// ════════════════════════════════════════════════════════════════
// NWAC TOURNAMENT MVP WATCH
//
// Two leaderboards side by side — top 10 hitters and top 10 pitchers
// from the 8 championship teams, ranked by the MVP score (WAR rate +
// total WAR + wRC+ / FIP+). Sits next to the odds widget.
// ════════════════════════════════════════════════════════════════

export default function NWACMvpTracker() {
  const { data, loading } = useNwacMvpTracker(2026)
  const hitters = data?.hitters || []
  const pitchers = data?.pitchers || []
  if (!loading && hitters.length === 0 && pitchers.length === 0) return null

  return (
    <div className="h-full rounded-2xl overflow-hidden shadow-lg border border-pnw-teal/30 bg-gradient-to-br from-[#04323d] via-[#062f3a] to-[#021b22] flex flex-col">
      {/* Header */}
      <div className="px-4 sm:px-5 py-3 border-b border-white/10">
        <h2 className="text-sm sm:text-base font-extrabold tracking-tight text-white leading-snug">
          Tournament MVP Watch
        </h2>
      </div>

      {/* Two columns: hitters | pitchers */}
      <div className="flex-1 grid grid-cols-2 divide-x divide-white/10">
        <MvpColumn title="Hitters" accent="emerald" players={hitters} loading={loading} />
        <MvpColumn title="Pitchers" accent="sky" players={pitchers} loading={loading} />
      </div>

      {/* Footer */}
      <div className="px-4 sm:px-5 py-2 border-t border-white/10 flex items-center justify-end">
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

function MvpColumn({ title, accent, players, loading }) {
  const headTone = accent === 'sky' ? 'text-sky-300/80' : 'text-emerald-300/80'
  return (
    <div className="min-w-0 px-2 sm:px-3 py-2">
      <div className={`text-[9px] font-bold uppercase tracking-[0.15em] mb-1.5 ${headTone}`}>
        {title}
      </div>
      <div className="flex flex-col">
        {loading && players.length === 0 ? (
          <div className="py-6 text-center text-white/40 text-xs animate-pulse">…</div>
        ) : (
          players.map((p) => <MvpRow key={p.player_id} player={p} accent={accent} />)
        )}
      </div>
    </div>
  )
}

function MvpRow({ player, accent }) {
  const isPitcher = accent === 'sky'
  // Secondary stat shown under the name: quality metric for quick read.
  const sub = isPitcher
    ? `${player.fip_plus != null ? Math.round(player.fip_plus) : '—'} FIP+ · ${player.era != null ? player.era.toFixed(2) : '—'} ERA`
    : `${player.wrc_plus != null ? Math.round(player.wrc_plus) : '—'} wRC+ · ${player.hr ?? 0} HR`
  const warTone = isPitcher ? 'text-sky-300' : 'text-emerald-300'

  return (
    <Link
      to={`/player/${player.player_id}`}
      className="flex items-center gap-1.5 py-1 hover:bg-white/[0.05] rounded transition-colors group"
    >
      <span className="w-3.5 text-center text-[10px] font-mono font-bold text-white/35 shrink-0">
        {player.rank}
      </span>
      {player.team_logo ? (
        <img
          src={player.team_logo}
          alt=""
          className="w-4 h-4 object-contain shrink-0"
          onError={(e) => { e.currentTarget.style.display = 'none' }}
        />
      ) : (
        <span className="w-4 h-4 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold text-white truncate leading-tight group-hover:text-pnw-teal transition-colors">
          {player.name}
        </div>
        <div className="text-[9px] text-white/40 truncate leading-tight">{sub}</div>
      </div>
      <div className="text-right shrink-0">
        <div className={`text-[12px] font-bold tabular-nums leading-none ${warTone}`}>
          {player.war?.toFixed(1)}
        </div>
        <div className="text-[7px] uppercase tracking-wider text-white/30 leading-tight">
          {isPitcher ? 'pWAR' : 'oWAR'}
        </div>
      </div>
    </Link>
  )
}
