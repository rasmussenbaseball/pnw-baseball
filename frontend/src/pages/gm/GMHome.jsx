import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { listDynasties, deleteDynasty } from '../../gm/engine/save'
import { loadSchools } from '../../gm/engine/loadSchools'
import TeamLogo from '../../gm/components/TeamLogo'
import GMShell, { PixelCard } from '../../gm/components/GMShell'

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
    <GMShell>
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <h1 className="font-pixel-display text-2xl tracking-widest text-white mb-2">NAIA BASEBALL GM</h1>
          <p className="font-pixel text-base text-[#a8a8c8]">
            Build a dynasty. Recruit, manage rosters, set lineups, sim seasons.
          </p>
          <span className="inline-block mt-3 px-2 py-1 bg-amber-400 text-[#1a1a2e] font-pixel-display text-[9px] tracking-widest">
            ALPHA · V1 IN PROGRESS
          </span>
        </div>

        <div className="mb-6">
          <h2 className="font-pixel-display text-sm tracking-widest text-white mb-3">YOUR DYNASTIES</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {[1, 2, 3].map(slot => {
              const d = dynasties.find(x => x.slot === slot)
              if (d) {
                const school = schools[d.userSchoolId]
                const conf = school ? conferences[school.conferenceId] : null
                return (
                  <PixelCard
                    key={slot}
                    accent={school?.colors?.[0] || '#fbbf24'}
                    title={`SLOT ${slot}`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      {school && <TeamLogo school={school} size={32} />}
                      <div className="text-white text-base font-bold">{school?.name || 'Unknown school'}</div>
                    </div>
                    <div className="text-[#a8a8c8] text-xs mb-3">
                      {conf?.abbreviation} · Year {d.year}, Week {d.week}
                    </div>
                    <div className="flex gap-2">
                      <Link
                        to={`/gm/dashboard?slot=${slot}`}
                        className="flex-1 text-center px-3 py-1.5 bg-pnw-green text-white rounded text-xs font-bold uppercase tracking-wider hover:opacity-90"
                      >
                        Continue
                      </Link>
                      <button
                        onClick={() => handleDelete(slot)}
                        className="px-3 py-1.5 border border-[#3a3a5e] text-[#a8a8c8] rounded text-xs hover:bg-red-900/40 hover:text-red-300 hover:border-red-500/40"
                      >
                        Delete
                      </button>
                    </div>
                  </PixelCard>
                )
              }
              return (
                <Link
                  key={slot}
                  to="/gm/new"
                  className="block bg-[#23233d] rounded-xl border-4 border-dashed border-[#3a3a5e] p-4 hover:border-amber-300 hover:bg-[#2a2a48] transition"
                >
                  <div className="text-[10px] uppercase tracking-widest text-[#a8a8c8] mb-2 font-bold">Slot {slot}</div>
                  <div className="text-base font-bold text-amber-300">+ New Dynasty</div>
                  <div className="text-xs text-[#a8a8c8] mt-1">Pick a school, build a coach, start the story.</div>
                </Link>
              )
            })}
          </div>
        </div>

        <PixelCard accent="#fbbf24" title="THE GAME">
          <p className="text-[#e8e8e8] text-base font-pixel leading-relaxed">
            NAIA Baseball GM is a turn-based dynasty simulator. You take over a real
            Cascade Collegiate Conference program as the head coach, hire your staff,
            recruit your roster, sim games week-by-week, and try to build a national
            contender. Run it like a real coach with the live-game engine, or hand the
            week-to-week to Auto Mode and watch your dynasty unfold.
          </p>
        </PixelCard>
      </div>
    </GMShell>
  )
}
