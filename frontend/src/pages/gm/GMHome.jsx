import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { listDynasties, deleteDynasty } from '../../gm/engine/save'
import { loadSchools } from '../../gm/engine/loadSchools'
import TeamLogo from '../../gm/components/TeamLogo'

export default function GMHome() {
  const { user } = useAuth()
  const userId = user?.id || 'guest'

  const { schools, conferences } = useMemo(() => loadSchools(), [])
  const [dynasties, setDynasties] = useState(() => listDynasties(userId))

  function handleDelete(slot) {
    if (!confirm('Delete this dynasty? This cannot be undone.')) return
    deleteDynasty(userId, slot)
    setDynasties(listDynasties(userId))
  }

  return (
    <div className="max-w-5xl mx-auto py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-pnw-slate">NAIA Baseball GM</h1>
        <p className="text-sm text-gray-600 mt-1">
          Build a dynasty. Recruit, manage rosters, set lineups, sim seasons.
        </p>
        <span className="inline-flex items-center px-2 py-0.5 mt-2 rounded text-[10px] font-bold bg-nw-teal text-white uppercase tracking-wider">
          Alpha — v1 in progress
        </span>
      </div>

      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-3">Your Dynasties</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[1, 2, 3].map(slot => {
            const d = dynasties.find(x => x.slot === slot)
            if (d) {
              const school = schools[d.userSchoolId]
              const conf = school ? conferences[school.conferenceId] : null
              return (
                <div key={slot} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                  <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">Slot {slot}</div>
                  <div className="flex items-center gap-2 mb-1">
                    {school && <TeamLogo school={school} size={28} />}
                    <div className="font-semibold text-pnw-slate">{school?.name || 'Unknown school'}</div>
                  </div>
                  <div className="text-xs text-gray-500 mb-3">{conf?.abbreviation} • Year {d.year}, Week {d.week}</div>
                  <div className="flex gap-2">
                    <Link
                      to={`/gm/dashboard?slot=${slot}`}
                      className="flex-1 text-center px-3 py-1.5 bg-pnw-green text-white rounded text-xs font-semibold hover:opacity-90"
                    >
                      Continue
                    </Link>
                    <button
                      onClick={() => handleDelete(slot)}
                      className="px-3 py-1.5 border border-gray-200 text-gray-500 rounded text-xs hover:bg-red-50 hover:text-red-700 hover:border-red-200"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )
            }
            return (
              <Link
                key={slot}
                to="/gm/new"
                className="block bg-white rounded-xl border-2 border-dashed border-gray-200 p-4 hover:border-pnw-green hover:bg-pnw-cream transition"
              >
                <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">Slot {slot}</div>
                <div className="font-semibold text-pnw-slate">+ New Dynasty</div>
                <div className="text-xs text-gray-500 mt-1">Pick a school, build a coach, start the story</div>
              </Link>
            )
          })}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-pnw-slate uppercase tracking-wider mb-2">What's playable in v1.5 (alpha)</h3>
        <ul className="text-sm text-gray-700 space-y-1 list-disc pl-5">
          <li><strong>Bushnell University only</strong> — full national expansion later</li>
          <li>199 real NAIA programs simulated in the background (PEAR-seeded strength)</li>
          <li>~7,000 fictional players, ~1,000 coaches across the world</li>
          <li>Mode select: <em>Traditional</em> (hard sim, injuries on) or <em>Custom</em></li>
          <li>2027 conference schedule generated; user fills in non-conference</li>
          <li>PA-level sim engine for your games; fast sim for the rest of the league</li>
          <li>Custom predictive rankings (replaces NAIA RPI/BoChip)</li>
        </ul>
        <h3 className="text-sm font-semibold text-pnw-slate uppercase tracking-wider mt-4 mb-2">Coming next</h3>
        <ul className="text-sm text-gray-700 space-y-1 list-disc pl-5">
          <li>Recruiting board (HS + JUCO + transfer portal)</li>
          <li>D1/D2/D3 non-conference scheduling</li>
          <li>NAIA postseason (Opening Round Avista NAIA World Series)</li>
          <li>Practice / lift / meals (Action Points spent on team development)</li>
        </ul>
      </div>
    </div>
  )
}
