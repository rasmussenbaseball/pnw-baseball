import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import { playerOverall, playerPotentialOverall, overallTier, teamOverall } from '../../gm/engine/playerRating'
import { teamAcademicSummary } from '../../gm/engine/academics'
import { displayPosition, displayClassYear } from '../../gm/engine/format'
import { ensureHappiness, happinessLevel, HAPPINESS_DISPLAY } from '../../gm/engine/happiness'
import { cutsWindowOpen, ensureCutsState, cutPlayer, cutTrustTier, isMandatoryCutMode } from '../../gm/engine/cuts'
import GMShell from '../../gm/components/GMShell'
import PixelHeadshot from '../../gm/components/PixelHeadshot'

const POSITION_GROUPS = {
  All: () => true,
  Pitchers: (p) => p.isPitcher,
  Catchers: (p) => p.primaryPosition === 'C',
  Infield: (p) => ['1B', '2B', 'SS', '3B'].includes(p.primaryPosition),
  Outfield: (p) => ['LF', 'CF', 'RF'].includes(p.primaryPosition),
}

export default function Roster() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => loadDynasty(userId, slot))
  const [group, setGroup] = useState('All')
  const [sortKey, setSortKey] = useState('overall')
  const [cutMode, setCutMode] = useState(false)

  if (!save) return <Navigate to="/gm" replace />
  ensureCutsState(save)
  const cutsOpen = cutsWindowOpen(save)
  const mandatoryMode = isMandatoryCutMode(save)
  const mandatoryNeeded = save.mandatoryCuts?.needed ?? 0
  const cutsRemaining = mandatoryMode
    ? mandatoryNeeded
    : (save.cuts?.allowed || 0) - (save.cuts?.used || 0)

  function handleCut(playerId) {
    const player = save.players[playerId]
    if (!player) return
    if (!confirm(`Cut ${player.firstName} ${player.lastName}? This is permanent — they leave the program immediately.`)) return
    const result = cutPlayer(save, playerId)
    if (!result.ok) { alert(result.error); return }
    saveDynasty(save)
    setSave({ ...save })
  }

  const team = save.teams[save.userSchoolId]
  const school = save.schools[save.userSchoolId]
  const players = team.rosterPlayerIds.map(id => save.players[id]).filter(Boolean)

  const filtered = players.filter(POSITION_GROUPS[group])

  const sorted = [...filtered].sort((a, b) => {
    const av = playerOverall(a)
    const bv = playerOverall(b)
    return sortKey === 'overall' ? bv - av : 0
  })

  const teamOvr = teamOverall(team, save.players)
  const acadSummary = teamAcademicSummary(players)

  return (
    <GMShell schoolName={school.name} schoolColors={school.colors}>
    <div className="max-w-6xl mx-auto">
      <div className="flex justify-between items-start mb-6">
        <div>
          <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">Dashboard</Link>
          <h1 className="text-3xl font-bold text-pnw-slate mt-1">{school.name} — Roster</h1>
          <p className="text-sm text-gray-600">{players.length} players</p>
        </div>
        <div className="flex gap-3">
          <TeamOvrCard label="Team OVR" value={teamOvr.overall} />
          <TeamOvrCard label="Hitting OVR" value={teamOvr.hitting} />
          <TeamOvrCard label="Pitching OVR" value={teamOvr.pitching} />
          <TeamOvrCard label="Team GPA" value={acadSummary.teamGpa.toFixed(2)} small />
        </div>
      </div>

      {/* Cuts banner — visible only when window open + cuts remaining */}
      {cutsOpen && cutsRemaining > 0 && (
        <CutsControlPanel
          save={save}
          cutMode={cutMode}
          setCutMode={setCutMode}
          remaining={cutsRemaining}
          mandatory={mandatoryMode}
        />
      )}
      {save.cuts && save.cuts.year === save.calendar?.year && save.cuts.allowed === 0 && (
        <CutsTrustNote save={save} />
      )}

      <div className="flex gap-2 mb-4">
        {Object.keys(POSITION_GROUPS).map(g => (
          <button
            key={g}
            onClick={() => setGroup(g)}
            className={'px-3 py-1.5 rounded text-xs font-semibold ' +
              (group === g ? 'bg-pnw-green text-white' : 'bg-gray-100 text-gray-700')
            }
          >
            {g}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs text-gray-500 uppercase">
                <th className="py-2 px-3">Name</th>
                <th title="Primary position">Pos</th>
                <th title="Class year (FR/SO/JR/SR)">Class</th>
                <th title="Bats / Throws">Bats/Thr</th>
                <th>Hometown</th>
                <th title="Annual athletic scholarship $">Schol</th>
                <th title="Current overall rating">OVR</th>
                <th title="Projected future overall rating (potential)">POT</th>
                <th title="Contact rating (avg of vs LHP / vs RHP)">Contact</th>
                <th title="Power rating (avg of vs LHP / vs RHP)">Power</th>
                <th title="Plate discipline — BB rate, K avoidance">Disc</th>
                <th title="Fielding rating at primary position">Field</th>
                <th title="Stuff — whiff + contact-quality suppression">Stuff</th>
                <th title="Control — BB + HBP rate">Ctrl</th>
                <th title="Stamina — innings per outing">Stam</th>
                <th title="Player happiness — affects GPA, stats, and transfer risk over time">Mood</th>
                {cutMode && <th>Cut</th>}
              </tr>
            </thead>
            <tbody>
              {sorted.map(p => {
                const ovr = playerOverall(p)
                const pot = playerPotentialOverall(p)
                const tier = overallTier(ovr)
                // Mandatory cuts allow SR (they still count toward the cap
                // until graduation). Normal AD-trust cuts hide SR since they
                // graduate naturally — don't waste a cut.
                const cuttable = cutMode && (mandatoryMode || p.classYear !== 'SR')
                return (
                  <tr key={p.id} className={'border-t hover:bg-gray-50 ' + (cutMode ? '' : 'cursor-pointer')} onClick={() => !cutMode && navigate(`/gm/player/${p.id}?slot=${slot}`)}>
                    <td className="py-2 px-3 font-medium">
                      <div className="flex items-center gap-2">
                        <PixelHeadshot playerId={p.id} size={28} className="shrink-0" />
                        <span className="truncate">
                          {p.firstName} {p.lastName}
                          {p.injury?.weeksRemaining > 0 && (
                            <span
                              className="ml-1 inline-block px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[9px] font-bold uppercase align-middle"
                              title={`${p.injury.label} — ${p.injury.weeksRemaining} wk left`}
                            >
                               IL
                            </span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td className="text-gray-700">{displayPosition(p.primaryPosition)}</td>
                    <td className="text-gray-700">{displayClassYear(p)}</td>
                    <td className="text-gray-600">{p.bats}/{p.throws}</td>
                    <td className="text-gray-600 text-xs">{p.hometown.city}, {p.hometown.state}</td>
                    <td className="text-gray-600 text-xs">${(p.scholarship.annualAmount / 1000).toFixed(1)}K</td>
                    <td>
                      <span className={'inline-block px-1.5 py-0.5 rounded font-bold text-sm ' + tier.color + ' ' + tier.bg}>
                        {ovr}
                      </span>
                    </td>
                    <td className={'text-xs ' + ratingColor(pot)}>{pot}</td>
                    <td className="font-mono text-xs">{p.isHitter ? <StatCell value={Math.round((p.hitter.contact_l + p.hitter.contact_r) / 2)} arrow={arrowFor(save, p.id, ['contact_l', 'contact_r'], 'hitter')} /> : '—'}</td>
                    <td className="font-mono text-xs">{p.isHitter ? <StatCell value={Math.round((p.hitter.power_l + p.hitter.power_r) / 2)} arrow={arrowFor(save, p.id, ['power_l', 'power_r'], 'hitter')} /> : '—'}</td>
                    <td className="font-mono text-xs">{p.isHitter ? <StatCell value={p.hitter.discipline} arrow={arrowFor(save, p.id, ['discipline'], 'hitter')} /> : '—'}</td>
                    <td className="font-mono text-xs">{p.isHitter ? <StatCell value={p.hitter.fielding} arrow={arrowFor(save, p.id, ['fielding'], 'hitter')} /> : '—'}</td>
                    <td className="font-mono text-xs">{p.isPitcher ? <StatCell value={p.pitcher.stuff} arrow={arrowFor(save, p.id, ['stuff'], 'pitcher')} /> : '—'}</td>
                    <td className="font-mono text-xs">{p.isPitcher ? <StatCell value={p.pitcher.control} arrow={arrowFor(save, p.id, ['control'], 'pitcher')} /> : '—'}</td>
                    <td className="font-mono text-xs">{p.isPitcher ? <StatCell value={p.pitcher.stamina} arrow={arrowFor(save, p.id, ['stamina'], 'pitcher')} /> : '—'}</td>
                    <td className="text-xs"><HappinessPill player={p} /></td>
                    {cutMode && (
                      <td className="text-xs">
                        {cuttable ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleCut(p.id) }}
                            className="px-2 py-0.5 bg-red-600 text-white rounded text-[10px] hover:opacity-90 font-semibold"
                          >
                             Cut
                          </button>
                        ) : (
                          <span className="text-[10px] text-gray-400 italic">SR</span>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    </GMShell>
  )
}

function TeamOvrCard({ label, value, small }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-3 shadow-sm text-center">
      <div className={'font-bold ' + (small ? 'text-xl text-pnw-slate' : 'text-2xl ' + ratingColor(value))}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
    </div>
  )
}

function ratingColor(r) {
  if (r >= 80) return 'text-green-700'
  if (r >= 70) return 'text-pnw-green'
  if (r >= 60) return 'text-pnw-slate'
  if (r >= 50) return 'text-gray-600'
  return 'text-gray-400'
}

// Returns 'blue' if any of the given ratingKeys has an active temporary boost
// for this player; otherwise 'green' / 'red' if there's been a recent
// permanent change in the last 2 weeks; else null (no arrow).
function arrowFor(save, playerId, ratingKeys, side) {
  const temps = (save.tempBoosts || []).filter(b =>
    b.playerId === playerId && b.side === side && ratingKeys.includes(b.ratingKey),
  )
  if (temps.length > 0) return 'blue'
  const perms = (save.permanentBumps || []).filter(b =>
    b.playerId === playerId && b.side === side && ratingKeys.includes(b.ratingKey),
  )
  if (perms.length === 0) return null
  const total = perms.reduce((s, b) => s + b.amount, 0)
  if (total > 0.1) return 'green'
  if (total < -0.1) return 'red'
  return null
}

function HappinessPill({ player }) {
  const h = ensureHappiness(player)
  const level = happinessLevel(h.value)
  const d = HAPPINESS_DISPLAY[level]
  const trend = h.lastWeek != null && h.value !== h.lastWeek
    ? (h.value > h.lastWeek ? '' : '')
    : ''
  const trendColor = h.value > (h.lastWeek ?? h.value) ? 'text-green-600'
    : h.value < (h.lastWeek ?? h.value) ? 'text-red-600' : ''
  return (
    <span
      className={'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ' + d.color + ' ' + d.bg}
      title={`${d.label} (${h.value}/100) — week-over-week ${trend || 'flat'}`}
    >
      <span>{d.emoji}</span>
      <span className="font-semibold">{d.label}</span>
      {trend && <span className={trendColor}>{trend}</span>}
    </span>
  )
}

function CutsControlPanel({ save, cutMode, setCutMode, remaining, mandatory }) {
  if (mandatory) {
    const overflow = save.mandatoryCuts?.overByAtFlag ?? remaining
    return (
      <div className="bg-red-100 border-l-4 border-red-700 rounded-r p-4 mb-4">
        <div className="flex justify-between items-start gap-3">
          <div className="flex-1">
            <div className="font-bold text-red-900"> REQUIRED: Cut {remaining} player{remaining === 1 ? '' : 's'} to reach the 50-cap</div>
            <div className="text-xs text-red-800 mt-1 leading-snug">
              You finalized over the cap by <strong>{overflow}</strong>. The AD already docked your job security
              ({overflow * 3} pts). You must cut down to 50 before you can advance to the new year.
            </div>
            <div className="text-[11px] text-gray-700 mt-1.5">
              In mandatory-cut mode you CAN cut seniors (they still count toward the cap until graduation).
              Choose wisely — cuts are permanent. Plan your recruiting class size more carefully next year.
            </div>
          </div>
          <button
            onClick={() => setCutMode(!cutMode)}
            className={'px-4 py-2 rounded text-sm font-semibold shrink-0 ' +
              (cutMode ? 'bg-gray-700 text-white hover:opacity-90' : 'bg-red-700 text-white hover:opacity-90')}
          >
            {cutMode ? 'Done' : 'Enter cut mode'}
          </button>
        </div>
      </div>
    )
  }
  const tier = cutTrustTier(save)
  return (
    <div className="bg-red-50 border-l-4 border-red-500 rounded-r p-4 mb-4">
      <div className="flex justify-between items-start gap-3">
        <div className="flex-1">
          <div className="font-bold text-red-900"> Roster cuts available — {remaining} left</div>
          <div className="text-xs text-red-800 mt-1 leading-snug">
            AD trust tier: <strong>{tier.label}</strong> · {tier.note} Cuts are permanent.
            Seniors auto-graduate — don\'t waste a cut on them.
          </div>
          <div className="text-[11px] text-gray-600 mt-1.5">
            <strong>How to earn more next year:</strong> win games, hit postseason, keep job security high.
            The AD pulls cut privileges when programs struggle.
          </div>
        </div>
        <button
          onClick={() => setCutMode(!cutMode)}
          className={'px-4 py-2 rounded text-sm font-semibold shrink-0 ' +
            (cutMode ? 'bg-gray-700 text-white hover:opacity-90' : 'bg-red-600 text-white hover:opacity-90')}
        >
          {cutMode ? 'Done cutting' : 'Enter cut mode'}
        </button>
      </div>
    </div>
  )
}

function CutsTrustNote({ save }) {
  const tier = cutTrustTier(save)
  if (tier.allowed > 0) return null
  return (
    <div className="bg-amber-50 border border-amber-200 rounded p-3 mb-4 text-xs text-amber-900">
      <strong> Cuts privileges suspended.</strong> {tier.note}
    </div>
  )
}

function StatCell({ value, arrow }) {
  if (!arrow) return <span>{value}</span>
  const icon = arrow === 'red' ? '' : ''
  const color = arrow === 'green' ? 'text-green-600' :
                arrow === 'red'   ? 'text-red-600' :
                                    'text-blue-600'
  const title = arrow === 'blue'  ? 'Temporary boost active' :
                arrow === 'green' ? 'Increased in last 2 weeks' :
                                    'Decreased in last 2 weeks'
  return (
    <span title={title}>
      {value}<span className={'ml-0.5 ' + color}>{icon}</span>
    </span>
  )
}
