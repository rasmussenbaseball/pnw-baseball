import { Link } from 'react-router-dom'
import { useNwacChampionshipOdds } from '../hooks/useApi'

// ════════════════════════════════════════════════════════════════
// NWAC CHAMPIONSHIP ODDS
//
// Companion to the bracket: each team's Monte Carlo probability of
// winning the title. Model lives server-side (/nwac-championship-odds)
// and blends team strength (PPI: WAR, wRC+, FIP, win%), bracket
// position / strength of draw, and home-field for the host. Sits right
// under the bracket as part of the NWAC takeover.
// ════════════════════════════════════════════════════════════════

export default function NWACChampionshipOdds() {
  const { data, loading } = useNwacChampionshipOdds(2026)

  const teams = data?.teams || []
  if (!loading && teams.length === 0) return null

  // Scale bars relative to the favorite so the field reads clearly.
  const maxPct = teams.reduce((m, t) => Math.max(m, t.champ_pct || 0), 0) || 1

  return (
    <div className="h-full rounded-2xl overflow-hidden shadow-lg border border-pnw-teal/30 bg-gradient-to-br from-[#04323d] via-[#062f3a] to-[#021b22] flex flex-col">
      {/* Header */}
      <div className="px-4 sm:px-5 py-3 border-b border-white/10">
        <h2 className="text-sm sm:text-base font-extrabold tracking-tight text-white leading-snug">
          Any team can win in Longview
          <span className="text-pnw-teal"> (but here are the odds)</span>
        </h2>
        <p className="text-[10px] text-pnw-teal/70 mt-1 font-medium">
          50,000 simulations · PPI, bracket draw, home field · updates live
        </p>
      </div>

      {/* Rows */}
      <div className="flex-1 px-3 sm:px-4 py-2 divide-y divide-white/5">
        {loading && teams.length === 0 ? (
          <div className="py-6 text-center text-white/40 text-sm animate-pulse">
            Crunching the simulations…
          </div>
        ) : (
          teams.map((t, i) => (
            <OddsRow key={t.team_id} team={t} rank={i + 1} maxPct={maxPct} />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 sm:px-5 py-2 border-t border-white/10 flex items-center justify-between">
        <span className="text-[10px] text-white/50">
          Fair odds · no vig
        </span>
        <Link
          to="/team-ratings"
          className="text-[10px] font-semibold text-pnw-teal hover:text-white transition-colors"
        >
          Power ratings →
        </Link>
      </div>
    </div>
  )
}

function fmtLine(american) {
  if (american == null) return null
  return american > 0 ? `+${american}` : `${american}`
}

function OddsRow({ team, rank, maxPct }) {
  const pct = (team.champ_pct || 0) * 100
  const barWidth = `${Math.max(1.5, ((team.champ_pct || 0) / maxPct) * 100)}%`
  const isFav = rank === 1 && !team.eliminated
  const elim = team.eliminated
  const line = fmtLine(team.american_odds)

  return (
    <Link
      to={`/team/${team.team_id}`}
      className={`flex items-center gap-2 py-1.5 hover:bg-white/[0.04] transition-colors group ${elim ? 'opacity-45' : ''}`}
    >
      {/* Rank */}
      <span className="w-4 text-center text-[11px] font-mono font-bold text-white/40 shrink-0">
        {rank}
      </span>

      {/* Logo */}
      {team.logo_url ? (
        <img
          src={team.logo_url}
          alt=""
          className="w-5 h-5 object-contain shrink-0"
          onError={(e) => { e.currentTarget.style.display = 'none' }}
        />
      ) : (
        <span className="w-5 h-5 shrink-0" />
      )}

      {/* Name + bar */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1 mb-1">
          <span className="text-[12px] font-semibold text-white truncate group-hover:text-pnw-teal transition-colors">
            {team.short_name}
          </span>
          {team.is_host && (
            <span className="text-[7px] font-bold uppercase tracking-wider px-1 py-0.5 rounded bg-amber-400 text-amber-950 shrink-0">
              Host
            </span>
          )}
        </div>
        <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className={`h-full rounded-full ${
              isFav
                ? 'bg-gradient-to-r from-amber-400 to-amber-300'
                : 'bg-gradient-to-r from-pnw-teal to-cyan-300'
            }`}
            style={{ width: elim ? '0%' : barWidth }}
          />
        </div>
      </div>

      {/* Odds: % + Vegas line */}
      <div className="text-right shrink-0 w-14">
        {elim ? (
          <div className="text-[11px] font-bold text-rose-300/80 tracking-wide">OUT</div>
        ) : (
          <>
            <div className={`text-sm font-bold tabular-nums leading-none ${isFav ? 'text-amber-300' : 'text-white'}`}>
              {pct.toFixed(1)}%
            </div>
            {line && (
              <div className="text-[10px] font-mono text-pnw-teal/90 tabular-nums leading-tight mt-0.5">
                {line}
              </div>
            )}
          </>
        )}
      </div>
    </Link>
  )
}
