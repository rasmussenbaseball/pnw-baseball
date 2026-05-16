import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate, useParams } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import {
  playerOverall, playerPotentialOverall, overallTier,
  positionChangePenalty, HITTER_POSITION_OPTIONS,
} from '../../gm/engine/playerRating'
import AttrTooltip from '../../gm/components/AttrTooltip'
import { prettyLabel, displayPosition, displayClassYear } from '../../gm/engine/format'
import { ensureHappiness, happinessLevel, HAPPINESS_DISPLAY } from '../../gm/engine/happiness'
import GMShell from '../../gm/components/GMShell'
import PixelHeadshot from '../../gm/components/PixelHeadshot'

export default function PlayerDetail() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const { playerId } = useParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => loadDynasty(userId, slot))
  const [showMoveModal, setShowMoveModal] = useState(false)
  if (!save) return <Navigate to="/gm" replace />
  const player = save.players[playerId]
  if (!player) return <Navigate to={`/gm/roster?slot=${slot}`} replace />

  function applyPositionChange(newPos) {
    if (!player.isHitter) return
    const oldPos = player.primaryPosition
    if (oldPos === newPos) { setShowMoveModal(false); return }
    const penalty = positionChangePenalty(oldPos, newPos)
    // Mutate the player in place + record a permanent fielding bump so the
    // Roster / Player pages show the arrow indicator. Floor at 20 so we
    // don't drop someone to single digits — they're still a baseball player.
    player.primaryPosition = newPos
    if (penalty > 0) {
      const before = player.hitter.fielding
      player.hitter.fielding = Math.max(20, before - penalty)
      save.permanentBumps = save.permanentBumps || []
      save.permanentBumps.push({
        playerId: player.id,
        side: 'hitter',
        ratingKey: 'fielding',
        amount: -(before - player.hitter.fielding),
        week: save.calendar?.week,
        year: save.calendar?.year,
        source: `Position change ${oldPos} ${newPos}`,
      })
    }
    save.newsfeed = save.newsfeed || []
    save.newsfeed.unshift({
      id: `pos_change_${player.id}_${Date.now()}`,
      year: save.calendar?.year, week: save.calendar?.week, type: 'PLAYER_BOOST',
      headline: `${player.firstName} ${player.lastName} moved from ${displayPosition(oldPos)} to ${displayPosition(newPos)}` +
        (penalty > 0 ? ` (−${penalty} fielding)` : ''),
      payload: { playerId: player.id, fromPos: oldPos, toPos: newPos, penalty },
    })
    saveDynasty(save)
    setSave({ ...save })
    setShowMoveModal(false)
  }

  const ovr = playerOverall(player)
  const pot = playerPotentialOverall(player)
  const tier = overallTier(ovr)
  const potTier = overallTier(pot)
  const statsKey = player.isPitcher ? `p_${player.id}` : `b_${player.id}`
  const stats = save.playerStats?.[statsKey]

  // Pull school colors for the shell. The PlayerDetail doesn't always know
  // the user's school context, so fall back to a default amber if we can't.
  const userSchool = save.schools?.[save.userSchoolId]
  return (
    <GMShell schoolName={userSchool?.name} schoolColors={userSchool?.colors}>
    <div className="max-w-4xl mx-auto">
      <Link to={`/gm/roster?slot=${slot}`} className="text-sm text-pnw-green hover:underline">Roster</Link>

      <div className="flex justify-between items-start mt-2 mb-6 gap-4">
        <div className="flex items-start gap-3">
          <PixelHeadshot playerId={player.id} size={64} className="shrink-0" />
          <div>
          <h1 className="text-3xl font-bold text-pnw-slate">{player.firstName} {player.lastName}</h1>
          <p className="text-sm text-gray-600">
            {displayPosition(player.primaryPosition)} • {displayClassYear(player)} • {player.bats}/{player.throws} •
            {' '}{player.hometown.city}, {player.hometown.state}
          </p>
          {player.previousSchoolName && (
            <p className="text-xs text-gray-500">From {player.previousSchoolName}</p>
          )}
          {player.isHitter && (
            <button
              onClick={() => setShowMoveModal(true)}
              className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-pnw-green hover:underline"
            >
               Change position
            </button>
          )}
          </div>
        </div>
        <div className="flex gap-2">
          <RatingPill label="OVR" value={ovr} tier={tier} />
          <RatingPill label="POT" value={pot} tier={potTier} />
        </div>
      </div>

      {showMoveModal && player.isHitter && (
        <PositionChangeModal
          player={player}
          onPick={applyPositionChange}
          onClose={() => setShowMoveModal(false)}
        />
      )}

      {/* Injury status — pinned high so coaches see the IL stamp before stats */}
      {player.injury?.weeksRemaining > 0 && (
        <div className="bg-red-50 border-2 border-red-300 rounded-xl p-4 mb-4">
          <div className="flex items-start gap-3">
            <div className="text-3xl"></div>
            <div className="flex-1">
              <div className="text-xs uppercase tracking-wider text-red-700 font-bold">Currently injured</div>
              <div className="text-lg font-bold text-red-900">{player.injury.label}</div>
              <div className="text-xs text-red-800 mt-0.5">{player.injury.blurb}</div>
              <div className="text-[11px] text-gray-700 mt-2">
                <strong>{player.injury.weeksRemaining}</strong> week{player.injury.weeksRemaining === 1 ? '' : 's'} remaining
                {' '}of <strong>{player.injury.totalWeeks}</strong> ({player.injury.severity.toLowerCase()}).
                Out of lineups + can\'t develop until cleared.
                {player.injury.severity !== 'MINOR' && (
                  <span className="block text-amber-800 mt-1">
                     {player.injury.severity === 'SEASON' ? 'Season-ending' : 'Serious'} injury — some lingering rating
                    penalty will apply on return ({Object.entries(player.injury.statPenalty || {}).map(([k, v]) => `${k} ${v}`).join(', ')}).
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

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
                  <div className={'font-mono font-bold ' + ratingColor(v)}>
                    {v} <BoostArrow save={save} playerId={player.id} ratingKey={k} side="hitter" />
                  </div>
                </div>
              </AttrTooltip>
            ))}
          </div>
        </div>
      )}

      {/* Happiness panel */}
      <HappinessPanel player={player} />

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
                    <div className={'font-mono font-bold ' + ratingColor(v)}>
                      {v} <BoostArrow save={save} playerId={player.id} ratingKey={k} side="pitcher" />
                    </div>
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
    </GMShell>
  )
}

/**
 * Small inline arrow for a recently-boosted rating. Reads the same
 * tempBoosts / permanentBumps arrays the Roster page uses so the source of
 * truth is consistent.
 */
function BoostArrow({ save, playerId, ratingKey, side }) {
  const temps = (save.tempBoosts || []).filter(b =>
    b.playerId === playerId && b.side === side && b.ratingKey === ratingKey,
  )
  if (temps.length > 0) {
    return <span className="ml-0.5 text-blue-600" title="Temporary boost active"></span>
  }
  const perms = (save.permanentBumps || []).filter(b =>
    b.playerId === playerId && b.side === side && b.ratingKey === ratingKey,
  )
  if (perms.length === 0) return null
  const total = perms.reduce((s, b) => s + b.amount, 0)
  if (total > 0.1) return <span className="ml-0.5 text-green-600" title="Recently increased"></span>
  if (total < -0.1) return <span className="ml-0.5 text-red-600" title="Recently decreased"></span>
  return null
}

function HappinessPanel({ player }) {
  const h = ensureHappiness(player)
  const level = happinessLevel(h.value)
  const d = HAPPINESS_DISPLAY[level]
  const trendUp = h.lastWeek != null && h.value > h.lastWeek
  const trendDown = h.lastWeek != null && h.value < h.lastWeek
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-3">Happiness</h2>
      <div className="flex items-center gap-4">
        <div className={'rounded-lg p-3 text-center min-w-[110px] ' + d.bg}>
          <div className="text-3xl">{d.emoji}</div>
          <div className={'font-bold text-sm ' + d.color}>{d.label}</div>
          <div className="text-[10px] text-gray-500 font-mono">{h.value}/100</div>
        </div>
        <div className="flex-1 text-xs text-gray-600 leading-snug">
          {level === 'ECSTATIC' && 'Loves it here. Stats and GPA both trend up. Big factor against transferring.'}
          {level === 'HAPPY' && 'Comfortable in the program. Small positive drift on GPA and ratings.'}
          {level === 'NEUTRAL' && 'Stable. No drift — happy enough to stay focused, no red flags.'}
          {level === 'UNSURE' && 'Wavering. GPA and ratings drift slowly downward. Could be a transfer risk.'}
          {level === 'UPSET' && 'Unhappy and showing it — GPA + ratings drifting down. Real transfer risk; talk to them.'}
          <div className="mt-2 text-[11px] text-gray-500">
            Driven mostly by playing time vs. expectations and on-field performance.
            {trendUp && <span className="ml-1 text-green-700 font-semibold">trending up</span>}
            {trendDown && <span className="ml-1 text-red-700 font-semibold">trending down</span>}
            {/* meeting boosts are now permanent direct bumps — no countdown */}
          </div>
        </div>
      </div>
    </div>
  )
}

function PositionChangeModal({ player, onPick, onClose }) {
  const current = player.primaryPosition
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-lg w-full p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <div>
            <h3 className="text-lg font-bold text-pnw-slate">Move {player.firstName} {player.lastName}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Currently {displayPosition(current)}. Moving spots costs fielding rating
              — bigger transitions (especially to/from catcher) cost more.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none"></button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {HITTER_POSITION_OPTIONS.map(pos => {
            const penalty = positionChangePenalty(current, pos)
            const isCurrent = pos === current
            const color = penalty === 0 ? 'border-green-300 hover:bg-green-50'
              : penalty <= 5 ? 'border-amber-200 hover:bg-amber-50'
              : penalty <= 12 ? 'border-orange-300 hover:bg-orange-50'
              : 'border-red-400 hover:bg-red-50'
            return (
              <button
                key={pos}
                onClick={() => onPick(pos)}
                disabled={isCurrent}
                className={'p-3 rounded-lg border-2 text-center transition disabled:opacity-40 disabled:cursor-not-allowed ' +
                  (isCurrent ? 'border-pnw-green bg-pnw-cream/40' : 'bg-white ' + color)}
              >
                <div className="font-bold text-pnw-slate">{displayPosition(pos)}</div>
                <div className={'text-[10px] mt-1 font-mono ' +
                  (penalty === 0 ? 'text-green-700' :
                   penalty <= 5 ? 'text-amber-700' :
                   penalty <= 12 ? 'text-orange-700' :
                   'text-red-700')}>
                  {isCurrent ? 'current' : penalty === 0 ? 'no penalty' : `−${penalty} field`}
                </div>
              </button>
            )
          })}
        </div>
        <div className="mt-4 bg-gray-50 rounded p-3 text-[11px] text-gray-600 leading-snug">
          <div><strong className="text-pnw-slate">How this works:</strong></div>
          <div>• <strong>Same area</strong> (LFRF, 1B3B): small penalty (−3)</div>
          <div>• <strong>Cross-area</strong> (OFIF): moderate (−12)</div>
          <div>• <strong>Any spot Catcher</strong>: huge (−22) — toughest spot to learn</div>
          <div>• <strong>Any spot DH</strong>: free (no defense)</div>
          <div className="mt-1">The new position also weights your other ratings differently, so OVR will shift.</div>
        </div>
      </div>
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
  // Compute as raw numbers so OPS math is correct; format for display
  // separately. The old code stringified obp/slg with .slice(1) (baseball
  // ".464" convention) and then tried parseFloat('0' + str) which yielded
  // 464, not 0.464 — OPS came out wildly wrong.
  const pa = stats.ab + stats.bb + stats.hbp + stats.sf
  const avgNum = stats.ab > 0 ? stats.h / stats.ab : null
  const obpNum = pa > 0 ? (stats.h + stats.bb + stats.hbp) / pa : null
  const slgNum = stats.ab > 0
    ? (stats.h - stats.d - stats.t - stats.hr + stats.d * 2 + stats.t * 3 + stats.hr * 4) / stats.ab
    : null
  const opsNum = obpNum != null && slgNum != null ? obpNum + slgNum : null
  const fmt = n => n == null ? '.---' : n.toFixed(3).replace(/^0\./, '.')
  const avg = fmt(avgNum)
  const obp = fmt(obpNum)
  const slg = fmt(slgNum)
  const ops = fmt(opsNum)
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
