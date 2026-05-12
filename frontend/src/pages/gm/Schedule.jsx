import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import { simWeek, advanceWeek } from '../../gm/engine/season'
import { seedFromPear } from '../../gm/engine/rankings'
import {
  openNonConfWeeks, tryAddNonConfGame, addByeWeek,
  tryAddScrimmage, fallScrimmageSlots, springScrimmageSlots,
  countRecordGames, gamesRemaining,
  countScrimmages, scrimmagesRemaining,
  countD1Midweeks, d1MidweeksRemaining,
  getConferenceRules,
  checkOpponentEligibility,
  NAIA_GAME_CAP, NAIA_SCRIMMAGE_CAP, NAIA_D1_MIDWEEK_CAP,
} from '../../gm/engine/schedule'
import { totalAnnualTravelCost, estimateAwaySeriesCost, estimateMidweekCost } from '../../gm/engine/travel'
import TeamLogo from '../../gm/components/TeamLogo'
import nonNaiaRaw from '../../gm/data/non_naia_teams.json'

const NON_NAIA_DISPLAY = (() => {
  const out = {}
  for (const div of nonNaiaRaw.divisions) {
    for (const t of div.teams) out[t.id] = { ...t, division: div.id }
  }
  return out
})()

export default function Schedule() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => loadDynasty(userId, slot))
  const [pickingForWeek, setPickingForWeek] = useState(null)
  const [pickingScrimmage, setPickingScrimmage] = useState(null)

  if (!save) return <Navigate to="/gm" replace />

  const userSchoolId = save.userSchoolId
  const userSchool = save.schools[userSchoolId]
  const seasonYear = save.calendar.year + 1     // 2027 if Year 1 starts in 2026 offseason
  const confRules = getConferenceRules(userSchool.conferenceId)
  const schedule = save.schedule || []

  // User games only
  const myGames = schedule
    .filter(g => g.homeId === userSchoolId || g.awayId === userSchoolId)
    .sort((a, b) => (a.seasonWeek - b.seasonWeek) || a.date.localeCompare(b.date))

  // Group by week (regular season weeks 1-16)
  const byWeek = {}
  myGames.filter(g => g.seasonWeek > 0).forEach(g => {
    if (!byWeek[g.seasonWeek]) byWeek[g.seasonWeek] = []
    byWeek[g.seasonWeek].push(g)
  })

  // Scrimmages (seasonWeek = 0)
  const scrimmages = myGames.filter(g => g.seasonWeek === 0)

  const openWeeks = openNonConfWeeks(userSchoolId, userSchool.conferenceId, schedule, seasonYear)
  const countedGames = countRecordGames(userSchoolId, schedule)
  const gameCapRemaining = gamesRemaining(userSchoolId, schedule)
  const scrimCount = countScrimmages(userSchoolId, schedule)
  const scrimRemaining = scrimmagesRemaining(userSchoolId, schedule)
  const d1Count = countD1Midweeks(userSchoolId, schedule)
  const d1Remaining = d1MidweeksRemaining(userSchoolId, schedule)
  const travelCost = useMemo(
    () => totalAnnualTravelCost(userSchoolId, schedule, save.schools, NON_NAIA_DISPLAY),
    [save],
  )

  function handleSimNextWeek() {
    if (save.calendar.mode !== 'SEASON') {
      save.calendar.mode = 'SEASON'
      save.calendar.seasonWeek = 1
      save.calendar.offseasonWeek = null
    }
    const ratings = seedFromPear(save.schools, save.conferences)
    const summary = simWeek(save, save.schedule, ratings)
    advanceWeek(save, save.schedule)
    saveDynasty(save)
    setSave({ ...save })
    if (summary.userResults.length) {
      alert('Week complete:\n' + summary.userResults.map(r => `${r.result} ${r.score} vs ${r.opponent}`).join('\n'))
    }
  }

  function handleAddOpponent(week, opponent, options) {
    const result = tryAddNonConfGame(
      userSchoolId, opponent.id, opponent.division, week, seasonYear, schedule,
      { userIsHome: options?.userIsHome ?? true, format: options?.format },
    )
    if (!result.ok) { alert(result.error); return }
    save.schedule.push(...result.games)
    saveDynasty(save)
    setSave({ ...save })
    setPickingForWeek(null)
    if (result.info) alert(result.info)
  }

  function handleAddBye(week) {
    save.schedule.push(addByeWeek(userSchoolId, week, seasonYear))
    saveDynasty(save)
    setSave({ ...save })
  }

  function handleAddScrimmage(date, opponent, season) {
    const result = tryAddScrimmage(
      userSchoolId, opponent.id, opponent.division,
      date, seasonYear, schedule, season,
    )
    if (!result.ok) { alert(result.error); return }
    save.schedule.push(...result.games)
    saveDynasty(save)
    setSave({ ...save })
    setPickingScrimmage(null)
  }

  return (
    <div className="max-w-5xl mx-auto py-8">
      <div className="mb-6 flex justify-between items-start">
        <div>
          <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Dashboard</Link>
          <h1 className="text-3xl font-bold text-pnw-slate mt-1">{seasonYear} Schedule</h1>
          <p className="text-sm text-gray-600">
            {save.conferences[userSchool.conferenceId]?.name} • {confRules.seriesLength}-game series •
            {' '}Conf opens {fmtTarget(confRules.confStartDate)} • Conf ends {fmtTarget(confRules.confEndDate)}
          </p>
        </div>
        <button
          onClick={handleSimNextWeek}
          className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold hover:opacity-90"
        >
          Sim next week →
        </button>
      </div>

      {/* Caps + travel widget */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
        <CapCard label="Regular-season" count={countedGames} cap={NAIA_GAME_CAP} unit="games" />
        <CapCard label="Scrimmages" count={scrimCount} cap={NAIA_SCRIMMAGE_CAP} unit="scrim" />
        <CapCard label="D1 midweeks" count={d1Count} cap={NAIA_D1_MIDWEEK_CAP} unit="games" />
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
          <div className="text-xs text-gray-500 uppercase tracking-wider">Travel cost (est)</div>
          <div className="text-lg font-bold text-pnw-slate">${(travelCost / 1000).toFixed(1)}K</div>
          <div className="text-[10px] text-gray-400">cumulative away games + series</div>
        </div>
      </div>

      {/* Scrimmage section */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
        <div className="flex justify-between items-center mb-2">
          <div>
            <div className="text-sm font-semibold text-amber-900">Fall ball + Pre-season Scrimmages</div>
            <div className="text-xs text-amber-700">
              {scrimRemaining} of {NAIA_SCRIMMAGE_CAP} left. Doubleheaders only. Don't count toward record.
              Most teams use ~8 in fall (October Fridays).
            </div>
          </div>
          <button
            onClick={() => setPickingScrimmage('FALL')}
            disabled={scrimRemaining < 2}
            className="text-xs bg-amber-900 text-white px-3 py-1.5 rounded disabled:opacity-50"
          >
            + Fall DH
          </button>
        </div>
        {scrimmages.length > 0 && (
          <div className="space-y-1 mt-2 text-xs text-amber-900">
            {Object.entries(groupBySeriesId(scrimmages)).map(([sid, games]) => {
              const g = games[0]
              const opp = save.schools[g.awayId] || NON_NAIA_DISPLAY[g.awayId]
              return (
                <div key={sid} className="flex items-center gap-2">
                  <TeamLogo school={opp} size={16} />
                  <span>{g.date} — {games.length}-game DH vs {opp?.name}</span>
                  <span className="text-amber-600">{g.type === 'FALL_SCRIMMAGE' ? '(Fall)' : '(Spring pre-season)'}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Regular-season schedule */}
      {Object.keys(byWeek).sort((a, b) => a - b).map(wkStr => {
        const week = parseInt(wkStr, 10)
        const games = byWeek[week]
        const dateLabel = games[0]?.date
        const isOpen = openWeeks.some(d => d.week === week)
        return (
          <div key={week} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm mb-3">
            <div className="flex justify-between items-center mb-2">
              <div>
                <span className="text-xs uppercase tracking-wider text-gray-500">Week {week}</span>
                <span className="text-xs text-gray-400 ml-2">{dateLabel}</span>
              </div>
              {isOpen && (
                <div className="flex gap-2">
                  <button onClick={() => handleAddBye(week)} className="text-xs text-gray-500 hover:text-pnw-slate">
                    + Bye
                  </button>
                  <button onClick={() => setPickingForWeek(week)} className="text-xs text-pnw-green hover:underline">
                    + Add opponent
                  </button>
                </div>
              )}
            </div>
            <div className="space-y-1.5 text-sm">
              {Object.entries(groupBySeriesId(games)).map(([sid, seriesGames]) => (
                <SeriesRow key={sid} games={seriesGames} userSchoolId={userSchoolId} save={save} />
              ))}
            </div>
          </div>
        )
      })}

      {/* Empty open weeks */}
      {openWeeks
        .filter(w => !byWeek[w.week])
        .map(w => (
          <div key={w.week} className="bg-gray-50 rounded-xl border border-dashed border-gray-200 p-4 mb-3 flex items-center justify-between">
            <div>
              <span className="text-xs uppercase tracking-wider text-gray-500">Week {w.week} — open</span>
              <span className="text-xs text-gray-400 ml-2">{w.date}</span>
            </div>
            <div className="flex gap-2">
              <button onClick={() => handleAddBye(w.week)} className="text-xs text-gray-500 hover:text-pnw-slate">+ Bye</button>
              <button onClick={() => setPickingForWeek(w.week)} className="text-xs text-pnw-green hover:underline">+ Add opponent</button>
            </div>
          </div>
        ))}

      {pickingForWeek != null && (
        <OpponentPicker
          save={save}
          userSchool={userSchool}
          d1Remaining={d1Remaining}
          onPick={(opp, options) => handleAddOpponent(pickingForWeek, opp, options)}
          onClose={() => setPickingForWeek(null)}
        />
      )}

      {pickingScrimmage && (
        <ScrimmagePicker
          save={save}
          season={pickingScrimmage}
          year={seasonYear}
          onPick={(date, opp) => handleAddScrimmage(date, opp, pickingScrimmage)}
          onClose={() => setPickingScrimmage(null)}
        />
      )}
    </div>
  )
}

function fmtTarget(target) {
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[target.month]} ${target.day}`
}

function CapCard({ label, count, cap, unit }) {
  const pct = Math.min(100, (count / cap) * 100)
  const color = count >= cap ? 'bg-red-500' : count >= cap - 2 ? 'bg-amber-500' : 'bg-pnw-green'
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="text-lg font-bold text-pnw-slate">{count} / {cap}</div>
      <div className="h-1 bg-gray-100 rounded-full overflow-hidden mt-1">
        <div className={'h-full ' + color} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[10px] text-gray-400 mt-1">{cap - count} {unit} remain</div>
    </div>
  )
}

function groupBySeriesId(games) {
  const out = {}
  for (const g of games) {
    const key = g.seriesId || g.id
    if (!out[key]) out[key] = []
    out[key].push(g)
  }
  return out
}

function SeriesRow({ games, userSchoolId, save }) {
  const g0 = games[0]
  if (g0.type === 'BYE') {
    return <div className="py-1 text-sm text-gray-400 italic">— BYE WEEK —</div>
  }
  const isHome = g0.homeId === userSchoolId
  const oppId = isHome ? g0.awayId : g0.homeId
  const opp = save.schools[oppId] || NON_NAIA_DISPLAY[oppId]
  const isScrim = g0.type === 'FALL_SCRIMMAGE' || g0.type === 'SPRING_SCRIMMAGE'
  const typeLabel = g0.type === 'CONFERENCE' ? 'Conf' :
                    g0.type === 'D1_MIDWEEK' ? 'D1 midweek' :
                    isScrim ? 'Scrim' : 'NC'
  const seriesScore = games.map(g => {
    if (!g.played) return null
    const my = isHome ? g.homeRuns : g.awayRuns
    const them = isHome ? g.awayRuns : g.homeRuns
    return { my, them, win: my > them }
  })
  const allPlayed = seriesScore.every(s => s != null)

  return (
    <div className="border-b last:border-b-0 py-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TeamLogo school={opp} size={20} />
          <span className="text-gray-700">{isHome ? 'vs' : '@'} {opp?.name}</span>
          <span className={'text-xs ' + (isScrim ? 'text-amber-600' : g0.type === 'D1_MIDWEEK' ? 'text-blue-600' : 'text-gray-400')}>{typeLabel}</span>
          {games.length > 1 && <span className="text-[10px] text-gray-400">({games.length}-game series)</span>}
        </div>
        {allPlayed && (
          <div className="font-mono text-xs">
            {seriesScore.map((s, i) => (
              <span key={i} className={s.win ? 'text-green-700 mr-2' : 'text-red-700 mr-2'}>
                {s.win ? 'W' : 'L'} {s.my}-{s.them}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function OpponentPicker({ save, userSchool, d1Remaining, onPick, onClose }) {
  const [filter, setFilter] = useState('')
  const [divFilter, setDivFilter] = useState('ALL')

  const allCandidates = useMemo(() => {
    const naia = Object.values(save.schools)
      .filter(s => s.id !== save.userSchoolId)
      .filter(s => s.conferenceId !== userSchool.conferenceId)  // no intra-conf non-conf
      .map(s => ({
        id: s.id, name: s.name, city: s.city, state: s.state,
        colors: s.colors, nickname: s.nickname,
        division: 'NAIA',
        strength: s.pearRating ?? 0,
      }))
    const nonNaia = nonNaiaRaw.divisions.flatMap(div =>
      div.teams.map(t => ({ ...t, division: div.id, strength: t.strength ?? 0 })),
    )
    return [...naia, ...nonNaia]
  }, [save, userSchool])

  const filtered = allCandidates
    .filter(t => divFilter === 'ALL' || t.division === divFilter)
    .filter(t => !filter || t.name.toLowerCase().includes(filter.toLowerCase()))
    .filter(t => t.division !== 'JUCO_NWAC')  // NWAC routed via scrimmage picker
    .filter(t => t.division !== 'D1' || d1Remaining > 0)  // hide D1 if cap full
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 60)

  function withTravel(opp, userIsHome) {
    if (userIsHome) return null  // home games — no travel
    if (opp.division === 'D1') {
      return estimateMidweekCost(userSchool.state, opp.state)
    }
    return estimateAwaySeriesCost(userSchool.state, opp.state, 4, 3)
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 max-w-2xl w-full max-h-[85vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-lg font-semibold">Pick opponent</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>

        <div className="flex gap-1 mb-3 flex-wrap">
          {['ALL', 'NAIA', 'D1', 'D2', 'D3'].map(d => (
            <button
              key={d}
              onClick={() => setDivFilter(d)}
              className={'px-2 py-1 rounded text-xs ' +
                (divFilter === d ? 'bg-pnw-green text-white' : 'bg-gray-100 text-gray-700')
              }
            >
              {d}{d === 'D1' && ` (${d1Remaining} left)`}
            </button>
          ))}
        </div>

        <input
          type="text"
          placeholder="Search opponents..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="w-full border rounded px-3 py-2 text-sm mb-3"
        />

        {divFilter === 'D1' && (
          <div className="bg-blue-50 border border-blue-200 rounded p-2 mb-3 text-xs text-blue-900">
            D1 games are midweek-only. Hard cap of 2/year.
          </div>
        )}

        <div className="space-y-1 max-h-96 overflow-y-auto">
          {filtered.map(s => {
            const homeTravel = withTravel(s, true)
            const awayTravel = withTravel(s, false)
            return (
              <div key={s.id} className="flex items-center gap-2 p-2 hover:bg-pnw-cream rounded text-sm">
                <TeamLogo school={s} size={20} />
                <div className="flex-1">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-gray-500">{s.city}, {s.state} • {s.division} • Strength {s.strength.toFixed(2)}</div>
                </div>
                <div className="flex flex-col gap-1 text-xs">
                  <button
                    onClick={() => onPick(s, { userIsHome: true })}
                    className="px-2 py-1 bg-pnw-green text-white rounded"
                    title={`Home — $0 travel`}
                  >
                    Home
                  </button>
                  <button
                    onClick={() => onPick(s, { userIsHome: false })}
                    className="px-2 py-1 border border-pnw-green text-pnw-green rounded"
                    title={awayTravel ? `Away — ~$${awayTravel.totalCost.toLocaleString()} travel (${awayTravel.mode}, ${awayTravel.miles}mi)` : 'Away'}
                  >
                    Away {awayTravel && <span className="opacity-60">(${(awayTravel.totalCost / 1000).toFixed(1)}K)</span>}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ScrimmagePicker({ save, season, year, onPick, onClose }) {
  const slots = season === 'FALL' ? fallScrimmageSlots(year) : springScrimmageSlots(year + 1)
  const [filter, setFilter] = useState('')
  const [selectedDate, setSelectedDate] = useState(slots[0]?.date || '')

  const candidates = useMemo(() => {
    const naia = Object.values(save.schools)
      .filter(s => s.id !== save.userSchoolId)
      .map(s => ({
        id: s.id, name: s.name, city: s.city, state: s.state,
        colors: s.colors, nickname: s.nickname,
        division: 'NAIA',
      }))
    const nonNaia = nonNaiaRaw.divisions.flatMap(div =>
      div.teams.map(t => ({ ...t, division: div.id })),
    )
    return [...naia, ...nonNaia]
  }, [save])

  const filtered = candidates
    .filter(t => !filter || t.name.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 50)

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-lg font-semibold">{season} Scrimmage Doubleheader</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Pick a doubleheader date and opponent. 2 games = 2 of your 10 scrimmage allotment.
        </p>

        <div className="mb-3">
          <label className="text-xs uppercase tracking-wider text-gray-500">Date</label>
          <select className="block w-full mt-1 border rounded px-2 py-1.5 text-sm" value={selectedDate} onChange={e => setSelectedDate(e.target.value)}>
            {slots.map(s => <option key={s.date} value={s.date}>{s.label} — {s.date}</option>)}
          </select>
        </div>

        <input
          type="text"
          placeholder="Search opponents (any division)..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="w-full border rounded px-3 py-2 text-sm mb-3"
        />

        <div className="space-y-1 max-h-72 overflow-y-auto">
          {filtered.map(s => (
            <button
              key={s.id}
              onClick={() => onPick(selectedDate, s)}
              className="w-full flex items-center gap-2 p-2 hover:bg-amber-50 rounded text-left text-sm"
            >
              <TeamLogo school={s} size={20} />
              <div className="flex-1">
                <div>{s.name}</div>
                <div className="text-xs text-gray-500">{s.city}, {s.state} • {s.division}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
