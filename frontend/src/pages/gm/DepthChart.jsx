import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import { playerOverall } from '../../gm/engine/playerRating'
import { displayPosition } from '../../gm/engine/format'
import GMShell from '../../gm/components/GMShell'

const POSITION_ORDER = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH']

// Field-layout coordinates (% within the container). Anchor is the player's
// fielding spot on a baseball diamond.
const FIELD_POS = {
  CF: { top: 7,  left: 50 },
  LF: { top: 18, left: 18 },
  RF: { top: 18, left: 82 },
  SS: { top: 38, left: 33 },
  '2B': { top: 38, left: 60 },
  '3B': { top: 52, left: 18 },
  '1B': { top: 52, left: 82 },
  P:  { top: 55, left: 50 },
  C:  { top: 80, left: 50 },
  DH: { top: 95, left: 18 },
}

export default function DepthChart() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'
  const [view, setView] = useState('LINEUP')   // LINEUP | PITCHING

  const save = useMemo(() => loadDynasty(userId, slot), [userId, slot])
  if (!save) return <Navigate to="/gm" replace />

  const team = save.teams[save.userSchoolId]
  const school = save.schools[save.userSchoolId]
  const players = team.rosterPlayerIds.map(id => save.players[id]).filter(Boolean)
  const hitters = players.filter(p => p.isHitter)
  const pitchers = players.filter(p => p.isPitcher)

  // Group hitters by primary position, sorted by OVR desc
  const hittersByPos = {}
  for (const pos of POSITION_ORDER) {
    hittersByPos[pos] = hitters
      .filter(p => p.primaryPosition === pos)
      .map(p => ({ p, ovr: playerOverall(p) }))
      .sort((a, b) => b.ovr - a.ovr)
  }

  // Pitching staff assignment based on stuff/stamina:
  //   4 starters (top by stuff×stamina weighted)
  //   2 closers (top remaining by stuff+composure)
  //   2 long relievers (top remaining by stamina)
  //   5 middle relievers (next by stuff)
  const pitchingStaff = useMemo(() => buildPitchingStaff(pitchers), [pitchers])

  return (
    <GMShell schoolName={school?.name} schoolColors={school?.colors}>
    <div className="max-w-5xl mx-auto">
      <div className="mb-4 flex justify-between items-start">
        <div>
          <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">DEPTH CHART</h1>
          <p className="font-pixel text-base text-[#a8a8c8]">Auto-assigned from primary position + ratings.</p>
        </div>
        <div className="flex gap-1 border border-gray-200 rounded-lg overflow-hidden">
          <button
            onClick={() => setView('LINEUP')}
            className={'px-4 py-2 text-sm ' + (view === 'LINEUP' ? 'bg-pnw-green text-white font-semibold' : 'bg-white text-gray-600 hover:bg-gray-50')}
          >Lineup</button>
          <button
            onClick={() => setView('PITCHING')}
            className={'px-4 py-2 text-sm ' + (view === 'PITCHING' ? 'bg-pnw-green text-white font-semibold' : 'bg-white text-gray-600 hover:bg-gray-50')}
          >Pitching Staff</button>
        </div>
      </div>

      {view === 'LINEUP'
        ? <LineupView hittersByPos={hittersByPos} slot={slot} />
        : <PitchingView staff={pitchingStaff} slot={slot} />}
    </div>
    </GMShell>
  )
}

function LineupView({ hittersByPos, slot }) {
  return (
    <div className="relative bg-gradient-to-b from-green-700 to-green-900 rounded-xl shadow-lg overflow-hidden" style={{ aspectRatio: '4/3', minHeight: 600 }}>
      {/* Diamond outline */}
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polygon
          points="50,28 72,50 50,72 28,50"
          fill="none"
          stroke="rgba(255,255,255,0.5)"
          strokeWidth="0.5"
        />
        <polygon
          points="50,15 90,55 50,95 10,55"
          fill="none"
          stroke="rgba(255,255,255,0.3)"
          strokeWidth="0.3"
        />
      </svg>

      {POSITION_ORDER.map(pos => {
        const list = hittersByPos[pos] || []
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
          />
        )
      })}
    </div>
  )
}

function DepthSlot({ position, top, left, players, slot }) {
  if (players.length === 0) {
    return (
      <div
        className="absolute text-center"
        style={{ top: `${top}%`, left: `${left}%`, transform: 'translate(-50%, -50%)' }}
      >
        <div className="bg-gray-100 border border-gray-300 rounded px-2 py-1 text-xs text-gray-500 shadow">
          <div className="font-bold">{displayPosition(position)}</div>
          <div className="text-[10px]">—</div>
        </div>
      </div>
    )
  }
  const starter = players[0]
  const backups = players.slice(1, 3)
  return (
    <div
      className="absolute"
      style={{ top: `${top}%`, left: `${left}%`, transform: 'translate(-50%, -50%)', minWidth: 140 }}
    >
      <div className="bg-white/95 rounded-lg shadow-lg border border-gray-200 overflow-hidden">
        <div className="bg-pnw-slate text-white text-[10px] font-bold uppercase tracking-wider px-2 py-0.5">
          {displayPosition(position)}
        </div>
        <Link
          to={`/gm/player/${starter.p.id}?slot=${slot}`}
          className="flex justify-between items-center px-2 py-1 hover:bg-pnw-cream"
        >
          <span className="text-xs font-semibold text-pnw-slate truncate">{starter.p.firstName} {starter.p.lastName}</span>
          <span className={'text-xs font-mono font-bold ml-2 ' + ovrColor(starter.ovr)}>{starter.ovr}</span>
        </Link>
        {backups.map(b => (
          <Link
            key={b.p.id}
            to={`/gm/player/${b.p.id}?slot=${slot}`}
            className="flex justify-between items-center px-2 py-0.5 hover:bg-pnw-cream border-t border-gray-100"
          >
            <span className="text-[11px] text-gray-600 truncate">{b.p.firstName} {b.p.lastName}</span>
            <span className={'text-[11px] font-mono ml-2 ' + ovrColor(b.ovr)}>{b.ovr}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

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
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-[10px] uppercase text-gray-500">
          <tr>
            <th className="text-left py-1 px-3">#</th>
            <th className="text-left">Pitcher</th>
            <th className="text-center">Class</th>
            <th className="text-center">Throws</th>
            <th className="text-center">Stuff</th>
            <th className="text-center">Ctrl</th>
            <th className="text-center">Stam</th>
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
              <td className="text-xs font-mono text-center">{entry.p.pitcher.stamina}</td>
              <td className="text-xs font-mono text-gray-700 text-center">
                {entry.p.pitcher.velocity_avg ? `${entry.p.pitcher.velocity_min}-${entry.p.pitcher.velocity_max}` : '—'}
              </td>
              <td className={'text-xs font-mono font-bold text-center ' + ovrColor(entry.ovr)}>{entry.ovr}</td>
            </tr>
          ))}
        </tbody>
      </table>
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

  // Pick starters first — top 4 by starterScore
  const sortedByStarter = [...withRatings].sort((a, b) => b.starterScore - a.starterScore)
  const starters = sortedByStarter.slice(0, 4)
  const assigned = new Set(starters.map(e => e.p.id))

  // Closers — top 2 of remaining by closer score
  const remainingForCloser = withRatings.filter(e => !assigned.has(e.p.id))
    .sort((a, b) => b.closerScore - a.closerScore)
  const closers = remainingForCloser.slice(0, 2)
  closers.forEach(e => assigned.add(e.p.id))

  // Long relievers — top 2 of remaining by long score
  const remainingForLong = withRatings.filter(e => !assigned.has(e.p.id))
    .sort((a, b) => b.longScore - a.longScore)
  const longRelievers = remainingForLong.slice(0, 2)
  longRelievers.forEach(e => assigned.add(e.p.id))

  // Middle relievers — next 5 by OVR
  const remainingForMid = withRatings.filter(e => !assigned.has(e.p.id))
    .sort((a, b) => b.ovr - a.ovr)
  const middleRelievers = remainingForMid.slice(0, 5)
  middleRelievers.forEach(e => assigned.add(e.p.id))

  // Anyone left = depth
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
