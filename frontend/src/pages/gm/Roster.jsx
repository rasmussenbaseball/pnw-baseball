import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import { playerOverall, playerPotentialOverall, overallTier, teamOverall } from '../../gm/engine/playerRating'
import { teamAcademicSummary } from '../../gm/engine/academics'
import { displayPosition } from '../../gm/engine/format'

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

  const save = useMemo(() => loadDynasty(userId, slot), [userId, slot])
  const [group, setGroup] = useState('All')
  const [sortKey, setSortKey] = useState('overall')

  if (!save) return <Navigate to="/gm" replace />

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
    <div className="max-w-6xl mx-auto py-8">
      <div className="flex justify-between items-start mb-6">
        <div>
          <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Dashboard</Link>
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
              </tr>
            </thead>
            <tbody>
              {sorted.map(p => {
                const ovr = playerOverall(p)
                const pot = playerPotentialOverall(p)
                const tier = overallTier(ovr)
                return (
                  <tr key={p.id} className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/gm/player/${p.id}?slot=${slot}`)}>
                    <td className="py-2 px-3 font-medium">{p.firstName} {p.lastName}</td>
                    <td className="text-gray-700">{displayPosition(p.primaryPosition)}</td>
                    <td className="text-gray-700">{p.classYear}</td>
                    <td className="text-gray-600">{p.bats}/{p.throws}</td>
                    <td className="text-gray-600 text-xs">{p.hometown.city}, {p.hometown.state}</td>
                    <td className="text-gray-600 text-xs">${(p.scholarship.annualAmount / 1000).toFixed(1)}K</td>
                    <td>
                      <span className={'inline-block px-1.5 py-0.5 rounded font-bold text-sm ' + tier.color + ' ' + tier.bg}>
                        {ovr}
                      </span>
                    </td>
                    <td className={'text-xs ' + ratingColor(pot)}>{pot}</td>
                    <td className="font-mono text-xs">{p.isHitter ? Math.round((p.hitter.contact_l + p.hitter.contact_r) / 2) : '—'}</td>
                    <td className="font-mono text-xs">{p.isHitter ? Math.round((p.hitter.power_l + p.hitter.power_r) / 2) : '—'}</td>
                    <td className="font-mono text-xs">{p.isHitter ? p.hitter.discipline : '—'}</td>
                    <td className="font-mono text-xs">{p.isHitter ? p.hitter.fielding : '—'}</td>
                    <td className="font-mono text-xs">{p.isPitcher ? p.pitcher.stuff : '—'}</td>
                    <td className="font-mono text-xs">{p.isPitcher ? p.pitcher.control : '—'}</td>
                    <td className="font-mono text-xs">{p.isPitcher ? p.pitcher.stamina : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
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
