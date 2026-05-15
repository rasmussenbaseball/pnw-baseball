/**
 * Summer Ball page.
 *
 * Two modes depending on calendar:
 *   - PLANNING (Wk 14 onward, through end of season) — user picks players for
 *     each league. Can freely add / remove.
 *   - CONFIRM  (Wk 43 onward) — planning is closed. User can REMOVE assigned
 *     players, but NOT add new ones.
 *   - RESOLVED — read-only summary of how the summer went.
 *
 * Players are listed in their league with their eligibility, draft buzz risk,
 * and removal button. League cards above explain what each league does.
 */

import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import {
  SUMMER_LEAGUES, SUMMER_LEAGUE_KEYS, leaguesForPlayer,
  isPlayerEligibleForSummerBall,
  planSummerAssignment, removeSummerAssignment,
  confirmOrRemoveAssignment, ensureSummerBallState,
} from '../../gm/engine/summerBall'
import { playerOverall, overallTier } from '../../gm/engine/playerRating'
import { displayPosition, displayClassYear } from '../../gm/engine/format'
import { ensureUnifiedCalendar } from '../../gm/engine/gameYear'

export default function SummerBall() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => {
    const s = loadDynasty(userId, slot)
    if (s) {
      ensureUnifiedCalendar(s)
      ensureSummerBallState(s)
    }
    return s
  })
  const [pickingForPlayer, setPickingForPlayer] = useState(null)

  if (!save) return <Navigate to="/gm" replace />

  const team = save.teams[save.userSchoolId]
  const sb = save.summerBall || { status: 'PLANNING', assignments: {} }
  const players = (team.rosterPlayerIds || []).map(id => save.players[id]).filter(Boolean)
  const eligiblePlayers = players.filter(isPlayerEligibleForSummerBall)
  const status = sb.status
  const week = save.calendar?.weekOfYear ?? 1

  const planningOpen = status === 'PLANNING'
  const removeOnly = status === 'CONFIRMED'
  const resolved = status === 'RESOLVED'

  // Build league → assigned-players map
  const byLeague = useMemo(() => {
    const out = {}
    for (const k of SUMMER_LEAGUE_KEYS) out[k] = []
    for (const [pid, a] of Object.entries(sb.assignments || {})) {
      if (a.removed) continue
      const p = save.players[pid]
      if (!p) continue
      out[a.leagueKey]?.push({ player: p, assignment: a })
    }
    return out
  }, [sb, save.players])

  function handlePlan(playerId, leagueKey) {
    const result = planSummerAssignment(save, playerId, leagueKey)
    if (!result.ok) { alert(result.error); return }
    saveDynasty(save); setSave({ ...save })
    setPickingForPlayer(null)
  }
  function handleRemove(playerId) {
    if (planningOpen) {
      removeSummerAssignment(save, playerId)
    } else {
      confirmOrRemoveAssignment(save, playerId, false)
    }
    saveDynasty(save); setSave({ ...save })
  }

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Dashboard</Link>
      <h1 className="text-3xl font-bold text-pnw-slate mt-1">☀️ Summer Ball</h1>
      <p className="text-sm text-gray-600">
        Send players to wood-bat summer leagues. Reps, exposure, draft buzz — but real injury + poach risk too.
      </p>

      {/* Status banner */}
      <StatusBanner status={status} week={week} />

      {/* Resolved? Surface the full summer report at the top. */}
      {resolved && sb.results?.length > 0 && (
        <SummerReport results={sb.results} year={sb.year} />
      )}

      {/* Leagues overview */}
      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mt-6 mb-2">League Tiers</h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-6">
        {SUMMER_LEAGUE_KEYS.map(k => (
          <LeagueCard
            key={k}
            league={SUMMER_LEAGUES[k]}
            assigned={byLeague[k] || []}
            canPlan={planningOpen}
            canRemove={!resolved}
            onRemove={handleRemove}
            onAddClick={() => setPickingForPlayer({ leagueKey: k })}
          />
        ))}
      </div>

      {/* Unassigned eligible players — only shown during PLANNING */}
      {planningOpen && (
        <>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mt-6 mb-2">
            Eligible — not yet assigned
          </h2>
          <p className="text-[11px] text-gray-500 mb-2">
            Seniors are excluded (they\'ll graduate or go pro). The leagues each player qualifies for
            depend on their current OVR.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {eligiblePlayers
              .filter(p => !sb.assignments?.[p.id] || sb.assignments[p.id].removed)
              .map(p => (
                <UnassignedRow
                  key={p.id}
                  player={p}
                  onAssign={() => setPickingForPlayer({ playerId: p.id })}
                />
              ))}
          </div>
        </>
      )}

      {pickingForPlayer && (
        <PickerModal
          save={save}
          eligiblePlayers={eligiblePlayers}
          assignments={sb.assignments}
          context={pickingForPlayer}
          onPick={(pid, lk) => handlePlan(pid, lk)}
          onClose={() => setPickingForPlayer(null)}
        />
      )}
    </div>
  )
}

function SummerReport({ results, year }) {
  // Headline aggregates
  const total = results.length
  const totalOvrGain = results.reduce((s, r) => s + Math.max(0, r.ovrDelta), 0)
  const avgGain = total > 0 ? totalOvrGain / total : 0
  const injuries = results.filter(r => r.injured).length
  const poached = results.filter(r => r.poached).length
  const buzzed = results.filter(r => r.draftBuzz).length

  // Sort by impact: biggest gainers first, then by injuries
  const sorted = [...results].sort((a, b) => {
    if (!!a.injured !== !!b.injured) return a.injured ? 1 : -1
    return b.ovrDelta - a.ovrDelta
  })

  return (
    <div className="bg-gradient-to-br from-pnw-cream to-amber-50 border-2 border-pnw-green/40 rounded-xl p-5 mb-4 shadow-lg">
      <div className="flex justify-between items-start mb-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-pnw-green font-bold">Summer {year} Report</div>
          <h2 className="text-2xl font-bold text-pnw-slate">☀️ How your summer played out</h2>
        </div>
        <div className="text-right text-xs">
          <div className="font-mono text-3xl font-bold text-pnw-green leading-none">+{avgGain.toFixed(1)}</div>
          <div className="uppercase tracking-wider text-gray-500 text-[10px] mt-0.5">Avg OVR gain</div>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2 mb-4 text-center text-xs">
        <ReportTile label="Players sent" value={total} />
        <ReportTile label="Injuries" value={injuries} color={injuries > 0 ? 'text-red-700' : 'text-gray-500'} />
        <ReportTile label="D1 poach interest" value={poached} color={poached > 0 ? 'text-amber-700' : 'text-gray-500'} />
        <ReportTile label="Draft buzz" value={buzzed} color={buzzed > 0 ? 'text-purple-700' : 'text-gray-500'} />
      </div>
      <div className="space-y-2">
        {sorted.map(r => (
          <SummerResultRow key={r.playerId} result={r} />
        ))}
      </div>
    </div>
  )
}

function ReportTile({ label, value, color = 'text-pnw-slate' }) {
  return (
    <div className="bg-white rounded p-2">
      <div className={'text-2xl font-bold leading-none ' + color}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mt-1">{label}</div>
    </div>
  )
}

function SummerResultRow({ result }) {
  const lg = SUMMER_LEAGUES[result.leagueKey]
  const isHurt = !!result.injured
  const isPoached = result.poached
  const delta = result.ovrDelta
  const deltaColor = isHurt ? 'text-red-700'
    : delta >= 3 ? 'text-emerald-700'
    : delta >= 1.5 ? 'text-pnw-green'
    : delta >= 0 ? 'text-gray-700'
    : 'text-red-700'
  return (
    <div className={'bg-white rounded p-2.5 border ' + (isHurt ? 'border-red-200' : 'border-gray-200')}>
      <div className="flex items-center gap-2">
        <span className={'text-[10px] font-bold px-1.5 py-0.5 rounded ' + (lg?.color || 'bg-gray-100')}>
          {lg?.short || result.leagueKey}
        </span>
        <span className="font-medium text-sm text-pnw-slate flex-1 truncate">{result.playerName}</span>
        <div className="text-right shrink-0">
          <div className={'font-mono font-bold text-base ' + deltaColor}>
            {delta >= 0 ? '+' : ''}{delta.toFixed(1)} OVR
          </div>
          <div className="text-[10px] text-gray-500">{result.ovrBefore} → {result.ovrAfter}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-1 text-[11px]">
        <span className="text-gray-600">{result.verdict}</span>
        {isHurt && (
          <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-800 font-semibold">
            🩼 {result.injured.severity.toLowerCase()} injury ({result.injured.weeks} wk)
          </span>
        )}
        {isPoached && (
          <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold">
            📞 D1 interest
          </span>
        )}
        {result.draftBuzz && (
          <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 font-semibold">
            ⭐ Draft buzz
          </span>
        )}
      </div>
    </div>
  )
}

function StatusBanner({ status, week }) {
  if (status === 'PLANNING') {
    return (
      <div className="bg-pnw-cream border-l-4 border-pnw-green text-pnw-slate rounded-r p-4 mb-4 mt-4">
        <div className="font-bold">📋 Planning window OPEN — Week {week}</div>
        <div className="text-sm mt-1">
          Build your tentative summer-ball roster. Free to add / remove anyone right now.
          After your season ends, you\'ll get one last chance to REMOVE players, but you can\'t add new ones.
        </div>
      </div>
    )
  }
  if (status === 'CONFIRMED') {
    return (
      <div className="bg-amber-50 border-l-4 border-amber-400 text-amber-900 rounded-r p-4 mb-4 mt-4">
        <div className="font-bold">🔒 Final confirmation — Week {week}</div>
        <div className="text-sm mt-1">
          Sign-ups are closed for the year. Review your summer roster below — REMOVE any player who shouldn\'t go
          (overuse, injury concerns, transfer rumors). You can\'t add new players now.
        </div>
      </div>
    )
  }
  return (
    <div className="bg-blue-50 border-l-4 border-blue-400 text-blue-900 rounded-r p-4 mb-4 mt-4">
      <div className="font-bold">📊 Summer wrapped — Week {week}</div>
      <div className="text-sm mt-1">
        The leagues are done. Check the newsfeed / individual player pages for development gains, injuries,
        and any D1 poach interest from a hot summer.
      </div>
    </div>
  )
}

function LeagueCard({ league, assigned, canPlan, canRemove, onRemove, onAddClick }) {
  const ovrLabel = league.maxOvr != null
    ? `${league.minOvr}-${league.maxOvr} OVR`
    : `${league.minOvr}+ OVR`
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
      <div className="flex justify-between items-start gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-pnw-slate">{league.label}</h3>
            <span className={'text-[10px] font-bold px-1.5 py-0.5 rounded ' + league.color}>
              {league.short}
            </span>
          </div>
          <div className="text-[11px] text-gray-500">
            {league.region} · Prestige {league.prestige}/10 · <strong>{ovrLabel}</strong>
          </div>
        </div>
        {canPlan && (
          <button
            onClick={onAddClick}
            className="text-xs bg-pnw-green text-white px-2 py-1 rounded shrink-0 hover:opacity-90"
          >
            + Assign
          </button>
        )}
      </div>
      <p className="text-[11px] text-gray-700 leading-snug mb-2">{league.blurb}</p>
      <div className="grid grid-cols-3 gap-2 mb-2 text-[10px]">
        <Stat label="Dev focus" value={league.devFocus} />
        <Stat label="Injury risk" value={`${Math.round(league.injuryRisk * 100)}%`} valueClass={league.injuryRisk < 0.10 ? 'text-green-700' : league.injuryRisk < 0.15 ? 'text-amber-700' : 'text-red-700'} />
        <Stat label="Poach risk" value={`${Math.round(league.poachChance * 100)}%`} valueClass={league.poachChance < 0.10 ? 'text-green-700' : league.poachChance < 0.20 ? 'text-amber-700' : 'text-red-700'} />
      </div>
      {assigned.length > 0 ? (
        <div className="space-y-1">
          {assigned.map(({ player, assignment }) => (
            <AssignedRow key={player.id} player={player} assignment={assignment} canRemove={canRemove} onRemove={() => onRemove(player.id)} />
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-gray-400 italic mt-1">No players assigned</div>
      )}
    </div>
  )
}

function Stat({ label, value, valueClass }) {
  return (
    <div className="bg-gray-50 rounded p-1.5">
      <div className="text-[9px] uppercase text-gray-500 leading-tight">{label}</div>
      <div className={'font-semibold text-[11px] leading-tight ' + (valueClass || 'text-pnw-slate')}>{value}</div>
    </div>
  )
}

function AssignedRow({ player, assignment, canRemove, onRemove }) {
  const ovr = playerOverall(player)
  const tier = overallTier(ovr)
  return (
    <div className="flex items-center gap-2 bg-pnw-cream/40 rounded p-1.5">
      <span className={'inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ' + tier.bg + ' ' + tier.color}>{ovr}</span>
      <span className="text-sm font-medium text-pnw-slate flex-1 truncate">
        {player.firstName} {player.lastName}
      </span>
      <span className="text-[10px] text-gray-500">{displayPosition(player.primaryPosition)} · {displayClassYear(player)}</span>
      {canRemove && (
        <button onClick={onRemove} className="text-xs text-red-700 hover:underline">Remove</button>
      )}
    </div>
  )
}

function UnassignedRow({ player, onAssign }) {
  const ovr = playerOverall(player)
  const tier = overallTier(ovr)
  const leagues = leaguesForPlayer(player)
  return (
    <div className="bg-white rounded border border-gray-200 p-2 flex items-center gap-2">
      <span className={'inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ' + tier.bg + ' ' + tier.color}>{ovr}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{player.firstName} {player.lastName}</div>
        <div className="text-[10px] text-gray-500">
          {displayPosition(player.primaryPosition)} · {displayClassYear(player)} ·{' '}
          {leagues.length > 0
            ? `Qualifies for ${leagues.length} league${leagues.length === 1 ? '' : 's'}`
            : 'No league qualified'}
        </div>
      </div>
      <button
        onClick={onAssign}
        disabled={leagues.length === 0}
        className="text-xs bg-pnw-green text-white px-2 py-1 rounded disabled:opacity-30"
      >
        Send →
      </button>
    </div>
  )
}

function PickerModal({ save, eligiblePlayers, assignments, context, onPick, onClose }) {
  // Two flows: pick a league for a player, or pick a player for a league
  const isLeaguePreset = !!context.leagueKey
  const isPlayerPreset = !!context.playerId

  if (isLeaguePreset) {
    const lg = SUMMER_LEAGUES[context.leagueKey]
    const candidates = eligiblePlayers.filter(p => {
      const a = assignments[p.id]
      if (a && !a.removed) return false   // already assigned somewhere
      return leaguesForPlayer(p).includes(context.leagueKey)
    })
    return (
      <Modal onClose={onClose} title={`Pick a player for ${lg.label}`}>
        {candidates.length === 0 ? (
          <p className="text-sm text-gray-500">No eligible unassigned players qualify for this league.</p>
        ) : (
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {candidates.map(p => {
              const ovr = playerOverall(p)
              return (
                <button
                  key={p.id}
                  onClick={() => onPick(p.id, context.leagueKey)}
                  className="w-full flex items-center gap-2 p-2 hover:bg-pnw-cream rounded text-left text-sm"
                >
                  <span className="font-mono font-bold text-pnw-green">{ovr}</span>
                  <span className="flex-1">{p.firstName} {p.lastName}</span>
                  <span className="text-xs text-gray-500">{displayPosition(p.primaryPosition)} · {displayClassYear(p)}</span>
                </button>
              )
            })}
          </div>
        )}
      </Modal>
    )
  }

  // isPlayerPreset
  const p = save.players[context.playerId]
  const leagues = leaguesForPlayer(p)
  return (
    <Modal onClose={onClose} title={`Pick a league for ${p.firstName} ${p.lastName}`}>
      {leagues.length === 0 ? (
        <p className="text-sm text-gray-500">No league qualifies — current OVR is outside every band.</p>
      ) : (
        <div className="space-y-2">
          {leagues.map(k => {
            const lg = SUMMER_LEAGUES[k]
            return (
              <button
                key={k}
                onClick={() => onPick(p.id, k)}
                className="w-full text-left p-3 border border-gray-200 rounded hover:border-pnw-green hover:bg-pnw-cream"
              >
                <div className="flex justify-between items-start">
                  <div className="font-semibold text-pnw-slate">{lg.label}</div>
                  <span className={'text-[10px] font-bold px-1.5 py-0.5 rounded ' + lg.color}>{lg.short}</span>
                </div>
                <div className="text-[11px] text-gray-600 mt-1">{lg.blurb}</div>
              </button>
            )
          })}
        </div>
      )}
    </Modal>
  )
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3">
          <h3 className="text-lg font-bold text-pnw-slate">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}
