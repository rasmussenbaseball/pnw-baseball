import { useMemo } from 'react'
import { Link, useSearchParams, Navigate, useParams } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import { playerOverall, playerPotentialOverall, overallTier } from '../../gm/engine/playerRating'
import AttrTooltip from '../../gm/components/AttrTooltip'
import { prettyLabel, displayPosition } from '../../gm/engine/format'

export default function PlayerDetail() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const { playerId } = useParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const save = useMemo(() => loadDynasty(userId, slot), [userId, slot])
  if (!save) return <Navigate to="/gm" replace />
  const player = save.players[playerId]
  if (!player) return <Navigate to={`/gm/roster?slot=${slot}`} replace />

  const ovr = playerOverall(player)
  const pot = playerPotentialOverall(player)
  const tier = overallTier(ovr)
  const potTier = overallTier(pot)
  const statsKey = player.isPitcher ? `p_${player.id}` : `b_${player.id}`
  const stats = save.playerStats?.[statsKey]

  return (
    <div className="max-w-4xl mx-auto py-8">
      <Link to={`/gm/roster?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Roster</Link>

      <div className="flex justify-between items-start mt-2 mb-6">
        <div>
          <h1 className="text-3xl font-bold text-pnw-slate">{player.firstName} {player.lastName}</h1>
          <p className="text-sm text-gray-600">
            {displayPosition(player.primaryPosition)} • {player.classYear} • {player.bats}/{player.throws} •
            {' '}{player.hometown.city}, {player.hometown.state}
          </p>
          {player.previousSchoolName && (
            <p className="text-xs text-gray-500">From {player.previousSchoolName}</p>
          )}
        </div>
        <div className="flex gap-2">
          <RatingPill label="OVR" value={ovr} tier={tier} />
          <RatingPill label="POT" value={pot} tier={potTier} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {/* Academic + scholarship card */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2">Academics + $</h2>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span>GPA</span>
              <span className={'font-bold ' + gpaColor(player.gpa)}>{(player.gpa ?? 0).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span>Academic Standing</span>
              <span className={'font-bold ' + standingColor(player.academicStanding)}>{player.academicStanding}</span>
            </div>
            <div className="flex justify-between">
              <span>Scholarship $</span>
              <span className="font-mono">${((player.scholarship?.annualAmount || 0) / 1000).toFixed(1)}K/yr</span>
            </div>
            <div className="flex justify-between text-gray-500 text-xs">
              <span>Seasons used</span>
              <span>{player.seasonsUsed} / 4</span>
            </div>
          </div>
        </div>

        {/* Season stats */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2">This Season Stats</h2>
          {!stats ? (
            <p className="text-sm text-gray-400">No games played yet this season.</p>
          ) : player.isPitcher ? (
            <PitchingStatsLine stats={stats} />
          ) : (
            <BattingStatsLine stats={stats} />
          )}
        </div>
      </div>

      {/* Ratings detail */}
      {player.isHitter && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-3">Hitter Ratings</h2>
          <div className="grid grid-cols-4 gap-3">
            {Object.entries(player.hitter).map(([k, v]) => (
              <AttrTooltip key={k} attr={k}>
                <div className="bg-gray-50 rounded p-2 text-center cursor-help">
                  <div className="text-[10px] text-gray-500 uppercase">{prettyLabel(k)}</div>
                  <div className={'font-mono font-bold ' + ratingColor(v)}>{v}</div>
                </div>
              </AttrTooltip>
            ))}
          </div>
        </div>
      )}

      {player.isPitcher && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-3">Pitcher Ratings</h2>
          <div className="grid grid-cols-4 gap-3">
            {Object.entries(player.pitcher)
              .filter(([k]) => !k.startsWith('velocity'))
              .map(([k, v]) => (
                <AttrTooltip key={k} attr={k}>
                  <div className="bg-gray-50 rounded p-2 text-center cursor-help">
                    <div className="text-[10px] text-gray-500 uppercase">{prettyLabel(k)}</div>
                    <div className={'font-mono font-bold ' + ratingColor(v)}>{v}</div>
                    {k === 'stuff' && player.pitcher.velocity_avg && (
                      <div className="text-[9px] text-gray-500 mt-0.5">
                        {player.pitcher.velocity_min}–{player.pitcher.velocity_max} mph
                      </div>
                    )}
                  </div>
                </AttrTooltip>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}

function RatingPill({ label, value, tier }) {
  return (
    <div className={'rounded p-3 text-center ' + tier.bg}>
      <div className={'text-2xl font-bold ' + tier.color}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
    </div>
  )
}

function BattingStatsLine({ stats }) {
  const avg = stats.ab > 0 ? (stats.h / stats.ab).toFixed(3).slice(1) : '.---'
  const obp = (stats.ab + stats.bb + stats.hbp + stats.sf) > 0
    ? ((stats.h + stats.bb + stats.hbp) / (stats.ab + stats.bb + stats.hbp + stats.sf)).toFixed(3).slice(1)
    : '.---'
  const slg = stats.ab > 0
    ? ((stats.h - stats.d - stats.t - stats.hr + stats.d * 2 + stats.t * 3 + stats.hr * 4) / stats.ab).toFixed(3).slice(1)
    : '.---'
  const ops = obp !== '.---' && slg !== '.---' ? (parseFloat('0' + obp) + parseFloat('0' + slg)).toFixed(3).slice(1) : '.---'
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
      <Stat label="AVG" value={avg} />
      <Stat label="OBP" value={obp} />
      <Stat label="SLG" value={slg} />
      <Stat label="OPS" value={ops} />
      <Stat label="AB" value={stats.ab} />
      <Stat label="H" value={stats.h} />
      <Stat label="2B" value={stats.d} />
      <Stat label="3B" value={stats.t} />
      <Stat label="HR" value={stats.hr} />
      <Stat label="RBI" value={stats.rbi} />
      <Stat label="BB" value={stats.bb} />
      <Stat label="K" value={stats.k} />
      <Stat label="HBP" value={stats.hbp || 0} />
      <Stat label="SF" value={stats.sf || 0} />
      <Stat label="SAC" value={stats.sac || 0} />
      <Stat label="GIDP" value={stats.gidp || 0} />
      <Stat label="ROE" value={stats.roe || 0} />
    </div>
  )
}

function PitchingStatsLine({ stats }) {
  const era = stats.ip > 0 ? (stats.er * 9 / stats.ip).toFixed(2) : '—'
  const whip = stats.ip > 0 ? ((stats.h + stats.bb) / stats.ip).toFixed(2) : '—'
  const k9 = stats.ip > 0 ? (stats.k * 9 / stats.ip).toFixed(1) : '—'
  const bb9 = stats.ip > 0 ? (stats.bb * 9 / stats.ip).toFixed(1) : '—'
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
      <Stat label="IP" value={stats.ip.toFixed(1)} />
      <Stat label="ERA" value={era} />
      <Stat label="WHIP" value={whip} />
      <Stat label="H" value={stats.h} />
      <Stat label="BB" value={stats.bb} />
      <Stat label="K" value={stats.k} />
      <Stat label="HR" value={stats.hr || 0} />
      <Stat label="HBP" value={stats.hbp || 0} />
      <Stat label="ER" value={stats.er} />
      <Stat label="K/9" value={k9} />
      <Stat label="BB/9" value={bb9} />
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  )
}

function ratingColor(r) {
  if (r >= 80) return 'text-yellow-700'
  if (r >= 70) return 'text-pnw-green'
  if (r >= 60) return 'text-pnw-slate'
  return 'text-gray-600'
}

function gpaColor(gpa) {
  if (gpa >= 3.5) return 'text-green-700'
  if (gpa >= 3.0) return 'text-pnw-green'
  if (gpa >= 2.5) return 'text-pnw-slate'
  if (gpa >= 2.0) return 'text-amber-700'
  return 'text-red-700'
}

function standingColor(s) {
  if (s === 'eligible') return 'text-green-700'
  if (s === 'probation') return 'text-amber-700'
  if (s === 'ineligible' || s === 'dismissed') return 'text-red-700'
  return 'text-gray-600'
}
