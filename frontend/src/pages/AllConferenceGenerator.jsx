import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'

// Conference dropdown options (must match backend ALL_CONF_GROUPS keys)
const CONF_OPTIONS = [
  { value: 'gnac', label: 'GNAC (D2)', group: 'Conference' },
  { value: 'nwc', label: 'NWC (D3)', group: 'Conference' },
  { value: 'ccc', label: 'CCC (NAIA)', group: 'Conference' },
  { value: 'nwac-east', label: 'NWAC East', group: 'NWAC' },
  { value: 'nwac-north', label: 'NWAC North', group: 'NWAC' },
  { value: 'nwac-south', label: 'NWAC South', group: 'NWAC' },
  { value: 'nwac-west', label: 'NWAC West', group: 'NWAC' },
  { value: 'all-nwac', label: 'All-NWAC', group: 'Combined' },
  { value: 'all-pnw', label: 'All-PNW', group: 'Combined' },
]

// Position slots used to render 1st/2nd team grids
const POSITION_SLOTS = ['C', '1B', '2B', '3B', 'SS', 'OF1', 'OF2', 'OF3', 'DH', 'UTIL']
// HM is grouped by category, so the three OF spots collapse into one OF list
const HM_CATEGORIES = ['C', '1B', '2B', '3B', 'SS', 'OF', 'DH', 'UTIL']

// Helpers
function fmtAvg(v) {
  if (v === null || v === undefined) return '-'
  return v.toFixed(3).replace(/^0/, '')
}
function fmtInt(v) {
  if (v === null || v === undefined) return '-'
  return Math.round(v)
}
function fmtIp(v) {
  if (v === null || v === undefined) return '-'
  return Number(v).toFixed(1)
}

// Headshot fallback
function Avatar({ url, alt }) {
  const [errored, setErrored] = useState(false)
  if (!url || errored) {
    return (
      <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center text-gray-400 text-xs">
        N/A
      </div>
    )
  }
  return (
    <img
      src={url}
      alt={alt || ''}
      className="w-12 h-12 rounded-full object-cover bg-gray-100"
      onError={() => setErrored(true)}
    />
  )
}

// One player card (hitter or pitcher)
function PlayerCard({ player, kind, rateMode, compact }) {
  if (!player) {
    return (
      <div className="border border-dashed border-gray-200 rounded-lg p-3 text-center text-gray-400 text-xs">
        No qualifier
      </div>
    )
  }
  const isHitter = kind === 'hitter'
  return (
    <div className="border border-gray-200 rounded-lg p-3 bg-white shadow-sm hover:shadow transition-shadow">
      <div className="flex items-start gap-2">
        <Avatar url={player.headshot_url} alt={player.name} />
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase font-semibold text-nw-teal">
            {player.slot}
          </div>
          <Link
            to={`/players/${player.player_id}`}
            className="text-sm font-bold text-pnw-slate hover:text-nw-teal block truncate"
          >
            {player.name}
          </Link>
          <div className="text-xs text-gray-500 flex items-center gap-1 truncate">
            {player.team_logo && (
              <img src={player.team_logo} alt="" className="w-4 h-4 object-contain" />
            )}
            <span>{player.team_short}</span>
            {player.conference && (
              <span className="text-gray-300">| {player.conference}</span>
            )}
          </div>
        </div>
      </div>

      {isHitter ? (
        <div className={`mt-2 grid ${compact ? 'grid-cols-3' : 'grid-cols-4'} gap-1 text-xs`}>
          <Stat label={rateMode ? 'WAR/PA' : 'WAR'} value={rateMode ? player.war_rate?.toFixed(3) : player.war?.toFixed(2)} />
          <Stat label="wRC+" value={fmtInt(player.wrc_plus)} />
          <Stat label="AVG" value={fmtAvg(player.avg)} />
          <Stat label="OPS" value={fmtAvg(player.ops)} hideCompact={compact} />
          <Stat label="HR" value={fmtInt(player.hr)} />
          <Stat label="PA" value={fmtInt(player.pa)} />
        </div>
      ) : (
        (() => {
          // Relievers: always show WAR/IP (better signal for small samples).
          // Starters: show WAR normally, or WAR/IP when the page is in rate_mode (all-pnw).
          const isReliever = typeof player.slot === 'string' && player.slot.startsWith('RP')
          const useRate = rateMode || isReliever
          const warLabel = useRate ? 'WAR/IP' : 'WAR'
          const warValue = useRate ? player.war_rate?.toFixed(3) : player.war?.toFixed(2)
          return (
            <div className={`mt-2 grid ${compact ? 'grid-cols-3' : 'grid-cols-4'} gap-1 text-xs`}>
              <Stat label={warLabel} value={warValue} />
              <Stat label="ERA" value={player.era != null ? Number(player.era).toFixed(2) : '-'} />
              <Stat label="FIP" value={player.fip != null ? Number(player.fip).toFixed(2) : '-'} />
              <Stat label="WHIP" value={player.whip != null ? Number(player.whip).toFixed(2) : '-'} hideCompact={compact} />
              <Stat label="IP" value={fmtIp(player.ip)} />
              <Stat label="K" value={fmtInt(player.k)} />
            </div>
          )
        })()
      )}

      {/* Two-way pitching info (only for hitter cards in UTIL slot or HM) */}
      {isHitter && player.is_two_way && player.pitching && (
        <div className="mt-2 pt-2 border-t border-gray-100">
          <div className="text-[10px] uppercase font-semibold text-amber-600 mb-1">
            Two-Way Pitching
          </div>
          <div className="grid grid-cols-4 gap-1 text-xs">
            <Stat label="IP" value={fmtIp(player.pitching.ip)} />
            <Stat label="ERA" value={player.pitching.era != null ? Number(player.pitching.era).toFixed(2) : '-'} />
            <Stat label="FIP" value={player.pitching.fip != null ? Number(player.pitching.fip).toFixed(2) : '-'} />
            <Stat label="pWAR" value={player.pitching.war?.toFixed(2)} />
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, hideCompact }) {
  return (
    <div className={`text-center ${hideCompact ? 'hidden sm:block' : ''}`}>
      <div className="text-[10px] uppercase text-gray-400 font-medium">{label}</div>
      <div className="text-sm font-semibold text-pnw-slate tabular-nums">{value ?? '-'}</div>
    </div>
  )
}

// Render a full team (10 hitters + 4 SP + 1 RP)
function TeamSection({ title, team, rateMode, accentColor }) {
  if (!team) return null
  return (
    <div className="mb-8">
      <h2 className={`text-lg font-bold ${accentColor} mb-3 border-b-2 border-current pb-1 inline-block`}>
        {title}
      </h2>

      {/* Hitters */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 mb-4">
        {POSITION_SLOTS.map(slot => (
          <PlayerCard
            key={slot}
            player={team[slot]}
            kind="hitter"
            rateMode={rateMode}
          />
        ))}
      </div>

      {/* Pitchers */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
        {['SP1', 'SP2', 'SP3', 'SP4', 'RP'].map(slot => (
          <PlayerCard
            key={slot}
            player={team[slot]}
            kind="pitcher"
            rateMode={rateMode}
          />
        ))}
      </div>
    </div>
  )
}

// Honorable mentions section: top 3 per slot, presented compactly
function HonorableMentions({ hm, rateMode }) {
  if (!hm) return null
  return (
    <div className="mb-8">
      <h2 className="text-lg font-bold text-gray-600 mb-3 border-b-2 border-current pb-1 inline-block">
        Honorable Mentions
      </h2>
      <div className="space-y-4">
        {HM_CATEGORIES.map(cat => (
          <div key={cat}>
            <div className="text-xs uppercase font-semibold text-nw-teal mb-1">{cat}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {(hm[cat] || []).length === 0 ? (
                <div className="text-xs text-gray-400 italic">No additional qualifiers</div>
              ) : (
                hm[cat].map(p => (
                  <PlayerCard key={p.player_id} player={p} kind="hitter" rateMode={rateMode} compact />
                ))
              )}
            </div>
          </div>
        ))}

        <div>
          <div className="text-xs uppercase font-semibold text-nw-teal mb-1">SP</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {(hm.SP || []).length === 0 ? (
              <div className="text-xs text-gray-400 italic">No additional qualifiers</div>
            ) : (
              hm.SP.map(p => (
                <PlayerCard key={p.player_id} player={p} kind="pitcher" rateMode={rateMode} compact />
              ))
            )}
          </div>
        </div>

        <div>
          <div className="text-xs uppercase font-semibold text-nw-teal mb-1">RP</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {(hm.RP || []).length === 0 ? (
              <div className="text-xs text-gray-400 italic">No additional qualifiers</div>
            ) : (
              hm.RP.map(p => (
                <PlayerCard key={p.player_id} player={p} kind="pitcher" rateMode={rateMode} compact />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Criteria block — shows the rules used to build each team
function CriteriaPanel({ rateMode }) {
  return (
    <details className="mb-6 bg-gray-50 border border-gray-200 rounded-lg">
      <summary className="cursor-pointer px-4 py-2 text-sm font-semibold text-pnw-slate hover:bg-gray-100">
        How players are selected
      </summary>
      <div className="px-4 py-3 text-xs text-gray-700 space-y-2 leading-relaxed">
        <p>
          <span className="font-semibold">Primary criteria:</span> WAR (offensive WAR for hitters,
          pitching WAR for starters, WAR per IP for relievers).
          {rateMode && (
            <> For All-PNW we use <span className="font-mono">WAR per PA</span> for hitters and{' '}
            <span className="font-mono">WAR per IP</span> for pitchers, since teams across divisions play
            different game counts.</>
          )}
        </p>
        <p>
          <span className="font-semibold">Tiebreakers:</span> wRC+ for hitters, FIP (lower is better) for pitchers.
        </p>
        <p>
          <span className="font-semibold">Position eligibility:</span> a player must have appeared at
          least 15 games at a position to be eligible there. The three outfield spots all draw from
          the same pool, so any qualified outfielder can fill OF1, OF2, or OF3.
        </p>
        <p>
          <span className="font-semibold">DH:</span> 15+ games at DH AND those games make up at least
          50 percent of the player's defensive games. Pure hitters who never DH are not eligible.
        </p>
        <p>
          <span className="font-semibold">UTIL eligibility:</span> a player must either be a true two-way
          contributor (10+ IP and 40+ PA) OR have appeared at least 7 games at both an infield position
          (catcher counts) and an outfield position.
        </p>
        <p>
          <span className="font-semibold">One appearance per page:</span> each player can appear
          exactly once on this page. Two-way players are slotted in whichever role (hitter or pitcher)
          earned them more WAR and removed from the other pool entirely.
        </p>
        <p>
          <span className="font-semibold">Multi-position handling:</span> when a player would be top-rated
          at more than one position, the algorithm assigns players in whichever way maximizes the combined
          WAR of both filled spots.
        </p>
        <p>
          <span className="font-semibold">Pitching staff:</span> 4 starting pitchers (must be qualified at
          0.75 IP per team game played), 1 reliever (must have 15+ IP and fewer than 4 starts; ranked by
          WAR per IP).
        </p>
        <p>
          <span className="font-semibold">Negative WAR:</span> any player whose WAR was below zero is
          excluded entirely, even if it leaves a position with fewer than 3 honorable mentions.
        </p>
        <p>
          <span className="font-semibold">Hitter qualification (All-PNW only):</span> 2.0 PA per team game.
        </p>
        <p>
          <span className="font-semibold">Honorable mentions:</span> top 3 remaining qualifiers at each
          position (with no player appearing as HM at more than one spot), plus 3 each for SP and RP.
        </p>
      </div>
    </details>
  )
}

export default function AllConferenceGenerator() {
  const [conf, setConf] = useState('gnac')
  const [season] = useState(2026)
  const { data, loading, error } = useApi('/all-conference', { conf, season }, [conf, season])

  const rateMode = data?.rate_mode

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-pnw-slate mb-1">All-Conference Generator</h1>
        <p className="text-sm text-gray-500">
          Mock first team, second team, and honorable mentions built from current season stats.
        </p>
      </div>

      {/* Conference selector */}
      <div className="mb-4">
        <label className="block text-xs uppercase font-semibold text-gray-500 mb-1">
          Conference
        </label>
        <select
          value={conf}
          onChange={(e) => setConf(e.target.value)}
          className="w-full sm:w-auto px-3 py-2 border border-gray-300 rounded-lg text-sm font-medium bg-white focus:outline-none focus:ring-2 focus:ring-nw-teal"
        >
          <optgroup label="Conference">
            {CONF_OPTIONS.filter(o => o.group === 'Conference').map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </optgroup>
          <optgroup label="NWAC Divisions">
            {CONF_OPTIONS.filter(o => o.group === 'NWAC').map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </optgroup>
          <optgroup label="Combined">
            {CONF_OPTIONS.filter(o => o.group === 'Combined').map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </optgroup>
        </select>
      </div>

      <CriteriaPanel rateMode={rateMode} />

      {loading && (
        <div className="text-center py-12 text-gray-400">Building teams...</div>
      )}
      {error && (
        <div className="text-center py-12 text-red-400">Error: {error}</div>
      )}

      {data && !loading && (
        <>
          <div className="mb-4 text-sm text-gray-500">
            {data.label} | {data.team_count} team{data.team_count !== 1 ? 's' : ''} | Season {data.season}
          </div>

          <TeamSection
            title="First Team"
            team={data.first_team}
            rateMode={rateMode}
            accentColor="text-nw-teal"
          />
          <TeamSection
            title="Second Team"
            team={data.second_team}
            rateMode={rateMode}
            accentColor="text-pnw-slate"
          />
          <HonorableMentions hm={data.honorable_mentions} rateMode={rateMode} />
        </>
      )}
    </div>
  )
}
