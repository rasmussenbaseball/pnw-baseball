/**
 * DepthChart — three views:
 *   1. vs RHP lineup (platoon rating uses contact_r / power_r)
 *   2. vs LHP lineup (platoon rating uses contact_l / power_l)
 *   3. Pitching Staff (rotation / closers / middle relief / depth)
 *
 * The DH slot is NOT tied to primaryPosition. Each lineup picks the best
 * remaining hitter (across the team) who isn't already in the 8 starting
 * field positions — that's the DH. Reflects how college coaches actually
 * use the slot: best bat available, glove doesn't matter.
 */

import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import { playerOverall } from '../../gm/engine/playerRating'
import { displayPosition, displayClassYear } from '../../gm/engine/format'
import GMShell from '../../gm/components/GMShell'

const FIELD_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']

// Field-layout coordinates (% within the container).
const FIELD_POS = {
  CF: { top: 8,  left: 50 },
  LF: { top: 22, left: 16 },
  RF: { top: 22, left: 84 },
  SS: { top: 42, left: 36 },
  '2B': { top: 42, left: 64 },
  '3B': { top: 60, left: 18 },
  '1B': { top: 60, left: 82 },
  P:  { top: 60, left: 50 },
  C:  { top: 84, left: 50 },
  DH: { top: 96, left: 84 },
}

export default function DepthChart() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'
  const [view, setView] = useState('VS_RHP')   // VS_RHP | VS_LHP | PITCHING

  const save = useMemo(() => loadDynasty(userId, slot), [userId, slot])
  if (!save) return <Navigate to="/gm" replace />

  const team = save.teams[save.userSchoolId]
  const school = save.schools[save.userSchoolId]
  const players = team.rosterPlayerIds.map(id => save.players[id]).filter(Boolean)
  const hitters = players.filter(p => !p.isPitcher && p.eligibilityStatus !== 'cut' && p.eligibilityStatus !== 'dismissed')
  const pitchers = players.filter(p => p.isPitcher && p.eligibilityStatus !== 'cut' && p.eligibilityStatus !== 'dismissed')

  // Two depth charts — one for each platoon split. Each picks 8 starters by
  // primary position + a DH (best remaining bat).
  const vsRhpChart = useMemo(() => buildLineup(hitters, 'r'), [hitters])
  const vsLhpChart = useMemo(() => buildLineup(hitters, 'l'), [hitters])
  const pitchingStaff = useMemo(() => buildPitchingStaff(pitchers), [pitchers])

  return (
    <GMShell schoolName={school?.name} schoolColors={school?.colors}>
    <div className="max-w-6xl mx-auto">
      <div className="mb-4 flex justify-between items-start flex-wrap gap-3">
        <div>
          <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">DEPTH CHART</h1>
          <p className="font-pixel text-base text-[#a8a8c8]">
            Auto-built from platoon ratings. Tap a player to view their card.
          </p>
        </div>
        <div className="flex gap-1 border-2 border-[#3a3a5e] rounded overflow-hidden">
          <ViewTab active={view === 'VS_RHP'} onClick={() => setView('VS_RHP')} label="vs RHP" />
          <ViewTab active={view === 'VS_LHP'} onClick={() => setView('VS_LHP')} label="vs LHP" />
          <ViewTab active={view === 'PITCHING'} onClick={() => setView('PITCHING')} label="Pitching Staff" />
        </div>
      </div>

      {(view === 'VS_RHP' || view === 'VS_LHP') && (
        <LineupView
          chart={view === 'VS_RHP' ? vsRhpChart : vsLhpChart}
          side={view === 'VS_RHP' ? 'r' : 'l'}
          slot={slot}
          allHitters={hitters}
        />
      )}
      {view === 'PITCHING' && <PitchingView staff={pitchingStaff} slot={slot} />}
    </div>
    </GMShell>
  )
}

function ViewTab({ active, onClick, label }) {
  return (
    <button
      onClick={onClick}
      className={
        'px-4 py-2 text-sm font-bold uppercase tracking-wider transition ' +
        (active ? 'bg-pnw-green text-white' : 'bg-[#23233d] text-[#a8a8c8] hover:text-white')
      }
    >{label}</button>
  )
}

// ─── Lineup builder ─────────────────────────────────────────────────────────

/**
 * For each of the 8 field positions, rank position-eligible hitters by their
 * platoon-side score (contact + power for the relevant side). The DH slot
 * gets the best HITTER not already in the starting 8 (anyone can DH).
 */
function buildLineup(hitters, side) {
  // Score a hitter for the given platoon side
  const score = p => {
    const c = p.hitter?.[`contact_${side}`] ?? 50
    const pw = p.hitter?.[`power_${side}`] ?? 50
    const d = p.hitter?.discipline ?? 50
    return c * 0.5 + pw * 0.35 + d * 0.15
  }
  // Build per-position depth (sorted by platoon score)
  const byPos = {}
  for (const pos of FIELD_POSITIONS) {
    byPos[pos] = hitters
      .filter(p => p.primaryPosition === pos)
      .map(p => ({ p, ovr: playerOverall(p), platoon: score(p) }))
      .sort((a, b) => b.platoon - a.platoon)
  }

  // Starters = best at each position
  const startingIds = new Set()
  for (const pos of FIELD_POSITIONS) {
    const top = byPos[pos][0]
    if (top) startingIds.add(top.p.id)
  }

  // DH = best non-starter bat. If a position is empty (only 1 player there)
  // we still let that player double up — DH is "best bat not in the lineup".
  const dhPool = hitters
    .filter(p => !startingIds.has(p.id))
    .map(p => ({ p, ovr: playerOverall(p), platoon: score(p) }))
    .sort((a, b) => b.platoon - a.platoon)
  byPos.DH = dhPool.slice(0, 3)

  return byPos
}

// ─── Lineup view ────────────────────────────────────────────────────────────

function LineupView({ chart, side, slot, allHitters }) {
  // Build a flat list for the BENCH section (everyone not a starter or DH)
  const startingIds = new Set()
  for (const pos of [...FIELD_POSITIONS, 'DH']) {
    const top = chart[pos]?.[0]
    if (top) startingIds.add(top.p.id)
  }
  const bench = allHitters
    .filter(p => !startingIds.has(p.id))
    .map(p => ({ p, ovr: playerOverall(p) }))
    .sort((a, b) => b.ovr - a.ovr)
    .slice(0, 12)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Field diagram */}
      <div className="lg:col-span-2 relative bg-gradient-to-b from-green-700 to-green-900 rounded-xl shadow-lg overflow-hidden" style={{ aspectRatio: '4/3', minHeight: 500 }}>
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {/* Outer arc (outfield wall) */}
          <path d="M 8 60 Q 50 -8 92 60" fill="rgba(160, 110, 75, 0.15)" stroke="rgba(255,255,255,0.2)" strokeWidth="0.3" />
          {/* Infield diamond */}
          <polygon points="50,40 64,55 50,72 36,55" fill="rgba(160, 110, 75, 0.45)" stroke="rgba(255,255,255,0.5)" strokeWidth="0.4" />
          {/* Outer infield arc */}
          <path d="M 30 60 Q 50 35 70 60" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="0.3" />
          {/* Pitcher mound */}
          <circle cx="50" cy="55" r="2" fill="rgba(160, 110, 75, 0.7)" />
        </svg>
        {[...FIELD_POSITIONS, 'DH'].map(pos => {
          const list = chart[pos] || []
          const coord = FIELD_POS[pos]
          if (!coord) return null
          return (
            <DepthSlot
              key={pos}
              position={pos}
              top={coord.top}
              left={coord.left}
              players={list}
              slot={slot}
              side={side}
            />
          )
        })}
      </div>

      {/* Sidebar — starting lineup card list */}
      <div className="space-y-2">
        <div className="bg-[#23233d] rounded p-3">
          <div className="text-[10px] uppercase tracking-wider text-amber-300 font-bold mb-2">
            STARTING LINEUP {side === 'r' ? 'vs RHP' : 'vs LHP'}
          </div>
          <div className="space-y-1">
            {[...FIELD_POSITIONS, 'DH'].map(pos => {
              const top = chart[pos]?.[0]
              if (!top) return (
                <div key={pos} className="flex items-center justify-between text-xs text-gray-500 py-1">
                  <span className="font-mono w-8">{pos}</span>
                  <span className="italic">No player</span>
                </div>
              )
              const c = top.p.hitter?.[`contact_${side}`] ?? 50
              const pw = top.p.hitter?.[`power_${side}`] ?? 50
              return (
                <Link
                  key={pos}
                  to={`/gm/player/${top.p.id}?slot=${slot}`}
                  className="flex items-center gap-2 text-xs hover:bg-[#3a3a5e] rounded px-2 py-1 transition"
                >
                  <span className="font-mono w-8 text-amber-300">{pos}</span>
                  <span className="flex-1 truncate text-white">{top.p.firstName} {top.p.lastName}</span>
                  <span className="text-[10px] text-[#a8a8c8] font-mono w-12 text-right">
                    {c}/{pw}
                  </span>
                  <span className={'font-mono font-bold w-8 text-right ' + ovrColor(top.ovr)}>{top.ovr}</span>
                </Link>
              )
            })}
          </div>
          <div className="text-[10px] text-[#a8a8c8] mt-2 leading-snug">
            Per-side ratings shown right of name (Contact/Power vs {side === 'r' ? 'RHP' : 'LHP'}). DH = best bat not in starting 8.
          </div>
        </div>

        <div className="bg-[#23233d] rounded p-3">
          <div className="text-[10px] uppercase tracking-wider text-[#a8a8c8] font-bold mb-2">BENCH</div>
          <div className="space-y-0.5">
            {bench.map(b => (
              <Link
                key={b.p.id}
                to={`/gm/player/${b.p.id}?slot=${slot}`}
                className="flex items-center gap-2 text-[11px] hover:bg-[#3a3a5e] rounded px-2 py-0.5 transition"
              >
                <span className="font-mono text-[10px] text-[#a8a8c8] w-8">{displayPosition(b.p.primaryPosition)}</span>
                <span className="flex-1 truncate text-white">{b.p.firstName} {b.p.lastName}</span>
                <span className="text-[10px] text-[#a8a8c8]">{displayClassYear(b.p)}</span>
                <span className={'font-mono w-8 text-right ' + ovrColor(b.ovr)}>{b.ovr}</span>
              </Link>
            ))}
            {bench.length === 0 && (
              <div className="text-[11px] text-gray-500 italic">Everyone's a starter.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function DepthSlot({ position, top, left, players, slot, side }) {
  if (players.length === 0) {
    return (
      <div
        className="absolute text-center"
        style={{ top: `${top}%`, left: `${left}%`, transform: 'translate(-50%, -50%)' }}
      >
        <div className="bg-gray-100 border border-gray-300 rounded px-2 py-1 text-xs text-gray-500 shadow">
          <div className="font-bold">{position}</div>
          <div className="text-[10px]">—</div>
        </div>
      </div>
    )
  }
  const starter = players[0]
  const c = starter.p.hitter?.[`contact_${side}`] ?? 50
  const pw = starter.p.hitter?.[`power_${side}`] ?? 50
  return (
    <div
      className="absolute"
      style={{ top: `${top}%`, left: `${left}%`, transform: 'translate(-50%, -50%)', minWidth: 130 }}
    >
      <div className="bg-white/95 rounded-lg shadow-lg border border-gray-200 overflow-hidden">
        <div className="bg-pnw-slate text-white text-[10px] font-bold uppercase tracking-wider px-2 py-0.5">
          {position}
        </div>
        <Link
          to={`/gm/player/${starter.p.id}?slot=${slot}`}
          className="flex justify-between items-center px-2 py-1 hover:bg-pnw-cream"
        >
          <span className="text-xs font-semibold text-pnw-slate truncate">{starter.p.firstName} {starter.p.lastName}</span>
          <span className={'text-xs font-mono font-bold ml-2 ' + ovrColor(starter.ovr)}>{starter.ovr}</span>
        </Link>
        <div className="px-2 py-0.5 text-[10px] text-gray-500 bg-gray-50 flex justify-between font-mono">
          <span>C {c}</span>
          <span>P {pw}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Pitching view ──────────────────────────────────────────────────────────

function PitchingView({ staff, slot }) {
  return (
    <div className="space-y-4">
      <PitchingGroup title="Starting Rotation" sub="4 SP" players={staff.starters} slot={slot} accent="bg-pnw-green" />
      <PitchingGroup title="Closers" sub="2 high-leverage relievers" players={staff.closers} slot={slot} accent="bg-red-700" />
      <PitchingGroup title="Long Relievers" sub="2 multi-inning RP" players={staff.longRelievers} slot={slot} accent="bg-amber-600" />
      <PitchingGroup title="Middle Relievers" sub="5 RP" players={staff.middleRelievers} slot={slot} accent="bg-blue-700" />
      {staff.depth.length > 0 && (
        <PitchingGroup title="Depth / Unassigned" sub={`${staff.depth.length} pitchers`} players={staff.depth} slot={slot} accent="bg-gray-400" />
      )}
    </div>
  )
}

function PitchingGroup({ title, sub, players, slot, accent }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className={'text-white px-4 py-2 ' + accent}>
        <div className="text-sm font-bold">{title}</div>
        <div className="text-[11px] opacity-80">{sub}</div>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[560px]">
        <thead className="bg-gray-50 text-[10px] uppercase text-gray-500">
          <tr>
            <th className="text-left py-1 px-3">#</th>
            <th className="text-left">Pitcher</th>
            <th className="text-center">Class</th>
            <th className="text-center">T</th>
            <th className="text-center">Stuff</th>
            <th className="text-center">Ctrl</th>
            <th className="text-center">Cmd</th>
            <th className="text-center">Stam</th>
            <th className="text-center">vs L</th>
            <th className="text-center">vs R</th>
            <th className="text-center">Velo</th>
            <th className="text-center">OVR</th>
          </tr>
        </thead>
        <tbody>
          {players.map((entry, i) => (
            <tr key={entry.p.id} className="border-t hover:bg-gray-50">
              <td className="py-1.5 px-3 text-gray-500 text-xs">{i + 1}</td>
              <td>
                <Link to={`/gm/player/${entry.p.id}?slot=${slot}`} className="text-pnw-slate hover:text-pnw-green hover:underline text-xs font-medium">
                  {entry.p.firstName} {entry.p.lastName}
                </Link>
              </td>
              <td className="text-xs text-gray-500 text-center">{entry.p.classYear}</td>
              <td className="text-xs text-gray-500 text-center">{entry.p.throws}</td>
              <td className="text-xs font-mono text-center">{entry.p.pitcher.stuff}</td>
              <td className="text-xs font-mono text-center">{entry.p.pitcher.control}</td>
              <td className="text-xs font-mono text-center">{entry.p.pitcher.command}</td>
              <td className="text-xs font-mono text-center">{entry.p.pitcher.stamina}</td>
              <td className="text-xs font-mono text-center">{entry.p.pitcher.vs_l ?? '—'}</td>
              <td className="text-xs font-mono text-center">{entry.p.pitcher.vs_r ?? '—'}</td>
              <td className="text-xs font-mono text-gray-700 text-center">
                {entry.p.pitcher.velocity_avg ? `${entry.p.pitcher.velocity_min}-${entry.p.pitcher.velocity_max}` : '—'}
              </td>
              <td className={'text-xs font-mono font-bold text-center ' + ovrColor(entry.ovr)}>{entry.ovr}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}

function buildPitchingStaff(pitchers) {
  const withRatings = pitchers
    .map(p => ({
      p,
      ovr: playerOverall(p),
      starterScore: (p.pitcher.stuff || 0) * 0.55 + (p.pitcher.stamina || 0) * 0.30 + (p.pitcher.control || 0) * 0.15,
      closerScore:  (p.pitcher.stuff || 0) * 0.50 + (p.pitcher.composure || 0) * 0.30 + (p.pitcher.control || 0) * 0.20,
      longScore:    (p.pitcher.stamina || 0) * 0.60 + (p.pitcher.stuff || 0) * 0.30 + (p.pitcher.control || 0) * 0.10,
    }))

  const sortedByStarter = [...withRatings].sort((a, b) => b.starterScore - a.starterScore)
  const starters = sortedByStarter.slice(0, 4)
  const assigned = new Set(starters.map(e => e.p.id))

  const remainingForCloser = withRatings.filter(e => !assigned.has(e.p.id))
    .sort((a, b) => b.closerScore - a.closerScore)
  const closers = remainingForCloser.slice(0, 2)
  closers.forEach(e => assigned.add(e.p.id))

  const remainingForLong = withRatings.filter(e => !assigned.has(e.p.id))
    .sort((a, b) => b.longScore - a.longScore)
  const longRelievers = remainingForLong.slice(0, 2)
  longRelievers.forEach(e => assigned.add(e.p.id))

  const remainingForMid = withRatings.filter(e => !assigned.has(e.p.id))
    .sort((a, b) => b.ovr - a.ovr)
  const middleRelievers = remainingForMid.slice(0, 5)
  middleRelievers.forEach(e => assigned.add(e.p.id))

  const depth = withRatings.filter(e => !assigned.has(e.p.id))
    .sort((a, b) => b.ovr - a.ovr)

  return { starters, closers, longRelievers, middleRelievers, depth }
}

function ovrColor(ovr) {
  if (ovr >= 85) return 'text-green-700'
  if (ovr >= 75) return 'text-pnw-green'
  if (ovr >= 65) return 'text-pnw-slate'
  if (ovr >= 55) return 'text-gray-600'
  return 'text-gray-400'
}
