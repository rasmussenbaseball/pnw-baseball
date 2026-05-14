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
  NAIA_GAME_CAP, NAIA_SCRIMMAGE_CAP, NAIA_D1_MIDWEEK_CAP,
  REGULAR_SEASON_LAST_WEEK,
} from '../../gm/engine/schedule'
import { totalAnnualTravelCost, estimateAwaySeriesCost, estimateMidweekCost } from '../../gm/engine/travel'
import { sortByProximity, stateProximity, proximityLabel } from '../../gm/engine/proximity'
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
  const [pickingMidweek, setPickingMidweek] = useState(null)   // numeric: week to add midweek to
  const [pickingScrimmage, setPickingScrimmage] = useState(null)
  const [showMidweekSection, setShowMidweekSection] = useState(false)

  if (!save) return <Navigate to="/gm" replace />

  const userSchoolId = save.userSchoolId
  const userSchool = save.schools[userSchoolId]
  const seasonYear = save.calendar.year + 1
  const confRules = getConferenceRules(userSchool.conferenceId)
  const schedule = save.schedule || []

  const myGames = schedule
    .filter(g => g.homeId === userSchoolId || g.awayId === userSchoolId)
    .sort((a, b) => (a.seasonWeek - b.seasonWeek) || a.date.localeCompare(b.date))

  // Group by week
  const byWeek = {}
  myGames.filter(g => g.seasonWeek > 0).forEach(g => {
    if (!byWeek[g.seasonWeek]) byWeek[g.seasonWeek] = []
    byWeek[g.seasonWeek].push(g)
  })

  const scrimmages = myGames.filter(g => g.seasonWeek === 0)
  const openWeeks = openNonConfWeeks(userSchoolId, userSchool.conferenceId, schedule, seasonYear)
  const countedGames = countRecordGames(userSchoolId, schedule)
  const gameCapRemaining = gamesRemaining(userSchoolId, schedule)
  const scrimCount = countScrimmages(userSchoolId, schedule)
  const scrimRemaining = scrimmagesRemaining(userSchoolId, schedule)
  const d1Remaining = d1MidweeksRemaining(userSchoolId, schedule)
  const travelCost = useMemo(
    () => totalAnnualTravelCost(userSchoolId, schedule, save.schools, NON_NAIA_DISPLAY),
    [save],
  )

  const scheduleIncomplete = openWeeks.length > 0
  const filledWeekends = Object.keys(byWeek).length
  const totalWeekendSlots = filledWeekends + openWeeks.length

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
    setPickingMidweek(null)
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

  // Sort scheduled weeks chronologically
  const scheduledWeekNums = Object.keys(byWeek).map(n => parseInt(n, 10)).sort((a, b) => a - b)

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="mb-4 flex justify-between items-start">
        <div>
          <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Dashboard</Link>
          <h1 className="text-3xl font-bold text-pnw-slate mt-1">{seasonYear} Schedule</h1>
          <p className="text-sm text-gray-600">
            {save.conferences[userSchool.conferenceId]?.name} • {confRules.seriesLength}-game conf weekend series •
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

      {/* INCOMPLETE banner */}
      {scheduleIncomplete && (
        <div className="bg-amber-100 border-l-4 border-amber-500 text-amber-900 p-4 rounded mb-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-bold text-base">⚠ Schedule incomplete</div>
              <div className="text-sm mt-1">
                You have <strong>{openWeeks.length} open weekend slot{openWeeks.length === 1 ? '' : 's'}</strong> to fill before opening day.
                Conference weekends are pre-built — you just need to add non-conference series in Weeks 1-3 (and any post-conference weeks) and decide on byes.
              </div>
            </div>
            <div className="text-right text-xs whitespace-nowrap ml-4">
              <div>{filledWeekends}/{totalWeekendSlots} weekends set</div>
              <div className="text-amber-700">{gameCapRemaining} of {NAIA_GAME_CAP} games left</div>
            </div>
          </div>
        </div>
      )}

      {/* COMPLETE — mark-done button to satisfy Wk 1 phase-gate */}
      {!scheduleIncomplete && !save.scheduleComplete && (
        <div className="bg-green-50 border-l-4 border-green-500 text-green-900 p-4 rounded mb-4 flex justify-between items-center">
          <div>
            <div className="font-bold text-base">✓ All weekends scheduled</div>
            <div className="text-sm mt-1">
              Confirm your schedule to clear the Week 1 phase-gate and unlock Wk 2 (assistant coach hiring).
              Travel budget for Wk 3 will lock in at <strong>${(travelCost / 1000).toFixed(1)}K</strong> based on these trips.
            </div>
          </div>
          <button
            onClick={() => {
              save.scheduleComplete = true
              save.newsfeed.unshift({
                id: `sched_done_${save.calendar.year}`,
                year: save.calendar.year, week: save.calendar.week, type: 'AWARD',
                headline: `📋 Locked in the ${seasonYear} schedule. Travel forecast: $${(travelCost / 1000).toFixed(1)}K.`,
                payload: {},
              })
              saveDynasty(save); setSave({ ...save })
            }}
            className="px-4 py-2 bg-green-600 text-white rounded text-sm font-semibold hover:opacity-90 shrink-0 ml-3"
          >
            Confirm schedule ✓
          </button>
        </div>
      )}
      {save.scheduleComplete && (
        <div className="bg-green-50 border border-green-200 text-green-800 text-xs p-2 rounded mb-4">
          ✓ Schedule confirmed. Travel cost: <strong>${(travelCost / 1000).toFixed(1)}K</strong> (locks into the budget on Wk 3).
        </div>
      )}

      {/* Caps strip — D1 midweek bar removed */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <CapCard label="Regular-season games" count={countedGames} cap={NAIA_GAME_CAP} unit="games" />
        <CapCard label="Scrimmages" count={scrimCount} cap={NAIA_SCRIMMAGE_CAP} unit="scrim" />
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
          <div className="text-xs text-gray-500 uppercase tracking-wider">Travel cost (est)</div>
          <div className="text-lg font-bold text-pnw-slate">${(travelCost / 1000).toFixed(1)}K</div>
          <div className="text-[10px] text-gray-400">cumulative away games + series</div>
        </div>
      </div>

      {/* OPEN WEEKS — at the top, prominent */}
      {openWeeks.length > 0 && (
        <div className="bg-amber-50 border-2 border-dashed border-amber-300 rounded-xl p-4 mb-6">
          <div className="flex justify-between items-baseline mb-3">
            <div>
              <h2 className="text-base font-bold text-amber-900">Open weeks — fill these first</h2>
              <p className="text-xs text-amber-700">Pre-conference (weeks 1-3) and post-conference weekends. Add an opponent or take a bye.</p>
            </div>
          </div>
          <div className="space-y-2">
            {openWeeks.map(w => (
              <div key={w.week} className="bg-white rounded-lg border border-amber-200 p-3 flex items-center justify-between">
                <div>
                  <span className="font-semibold text-pnw-slate">Week {w.week}</span>
                  <span className="text-xs text-gray-500 ml-2">starts {w.date}</span>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => handleAddBye(w.week)} className="text-xs text-gray-600 hover:text-pnw-slate hover:underline">+ Bye week</button>
                  <button onClick={() => setPickingForWeek(w.week)} className="text-xs font-semibold bg-pnw-green text-white px-3 py-1.5 rounded hover:opacity-90">
                    + Add opponent
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SCHEDULED WEEKS (chronological) */}
      {scheduledWeekNums.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2">Scheduled weeks</h2>
          {scheduledWeekNums.filter(w => w <= REGULAR_SEASON_LAST_WEEK).map(week => {
            const games = byWeek[week]
            const dateLabel = games[0]?.date
            // Detect type
            const hasConference = games.some(g => g.type === 'CONFERENCE')
            const weekType = hasConference ? 'Conference' : games.some(g => g.type === 'BYE') ? 'Bye' : 'Non-conference'
            return (
              <div key={week} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm mb-2">
                <div className="flex justify-between items-baseline mb-2">
                  <div>
                    <span className="text-xs uppercase tracking-wider text-gray-500">Week {week}</span>
                    <span className={'ml-2 text-[10px] px-1.5 py-0.5 rounded ' +
                      (weekType === 'Conference' ? 'bg-pnw-green/10 text-pnw-green' :
                       weekType === 'Bye' ? 'bg-gray-100 text-gray-500' :
                       'bg-blue-50 text-blue-700')
                    }>{weekType}</span>
                    <span className="text-xs text-gray-400 ml-2">{dateLabel}</span>
                  </div>
                </div>
                <div className="space-y-1.5 text-sm">
                  {Object.entries(groupBySeriesId(games)).map(([sid, seriesGames]) => (
                    <SeriesRow key={sid} games={seriesGames} userSchoolId={userSchoolId} save={save} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Postseason boundary */}
      <div className="bg-pnw-slate text-white rounded-xl p-3 mb-6 text-sm font-semibold">
        <div className="flex items-center justify-between">
          <span>🏆 Postseason begins Week {REGULAR_SEASON_LAST_WEEK + 1}</span>
          <span className="text-xs font-normal opacity-80">Wk 14 Conf Tournament • Wk 15 Opening Round • Wk 16 NAIA World Series</span>
        </div>
      </div>

      {/* TRAVEL BUDGET WARNING — Wk 1 user-visible signal */}
      <TravelBudgetWarning save={save} travelCost={travelCost} />

      {/* AUTO FALL GAMES — read-only display */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
        <div className="flex justify-between items-start mb-2">
          <div>
            <div className="text-sm font-semibold text-amber-900">
              🍂 Fall Scrimmages — auto-scheduled
            </div>
            <div className="text-xs text-amber-700">
              8 games (4 doubleheaders) vs nearby D2/D3/JUCO opponents. No NAIA fall opponents allowed. Don't count toward record.
            </div>
          </div>
          <div className="text-[11px] text-amber-800 bg-amber-100 px-2 py-1 rounded font-mono">
            {scrimmages.length} game{scrimmages.length === 1 ? '' : 's'} set
          </div>
        </div>
        {scrimmages.length > 0 && (
          <div className="space-y-1 mt-2 text-xs text-amber-900">
            {Object.entries(groupBySeriesId(scrimmages)).map(([sid, games]) => {
              const g = games[0]
              const oppId = g.homeId === userSchoolId ? g.awayId : g.homeId
              const opp = save.schools[oppId] || NON_NAIA_DISPLAY[oppId]
              const isHome = g.homeId === userSchoolId
              return (
                <div key={sid} className="flex items-center gap-2">
                  <TeamLogo school={opp} size={16} />
                  <span>{g.date} — {games.length}-game DH {isHome ? 'vs' : '@'} {opp?.name}</span>
                  <span className="text-amber-600 text-[10px]">({opp?.division || 'opponent'})</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* MIDWEEK section — gated until all weekends scheduled */}
      <div className={'rounded-xl p-4 border ' + (scheduleIncomplete ? 'bg-gray-50 border-gray-200' : 'bg-blue-50 border-blue-200')}>
        <div className="flex justify-between items-start mb-2">
          <div>
            <div className={'text-sm font-semibold ' + (scheduleIncomplete ? 'text-gray-500' : 'text-blue-900')}>
              Midweek games {scheduleIncomplete && '(locked)'}
            </div>
            <div className={'text-xs ' + (scheduleIncomplete ? 'text-gray-400' : 'text-blue-700')}>
              {scheduleIncomplete
                ? 'Fill all weekend slots above first. Then you can optionally add midweek games (Tue/Wed) for more reps.'
                : `Optional. NAIA vs D1 hard cap of ${NAIA_D1_MIDWEEK_CAP}/year (${d1Remaining} left). NAIA-vs-NAIA or D2/D3 single games allowed.`
              }
            </div>
          </div>
          {!scheduleIncomplete && (
            <button
              onClick={() => setShowMidweekSection(s => !s)}
              className="text-xs bg-blue-700 text-white px-3 py-1.5 rounded hover:opacity-90"
            >
              {showMidweekSection ? 'Hide' : '+ Add midweek'}
            </button>
          )}
        </div>
        {!scheduleIncomplete && showMidweekSection && (
          <div className="mt-3 space-y-1.5">
            <p className="text-[11px] text-blue-800 mb-2">Pick a week (Tue/Wed slot). Midweeks are limited to non-conference opponents.</p>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-1">
              {scheduledWeekNums.filter(w => byWeek[w].some(g => g.type === 'CONFERENCE' || g.type === 'BYE' || g.type === 'NON_CONFERENCE'))
                .map(week => (
                  <button
                    key={week}
                    onClick={() => setPickingMidweek(week)}
                    className="text-xs border border-blue-300 bg-white text-blue-800 rounded px-2 py-1 hover:bg-blue-100"
                  >
                    Wk {week}
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>

      {pickingForWeek != null && (
        <OpponentPicker
          save={save}
          userSchool={userSchool}
          d1Remaining={0}    // D1 opponents are midweek only — exclude from weekend picker
          midweekMode={false}
          onPick={(opp, options) => handleAddOpponent(pickingForWeek, opp, options)}
          onClose={() => setPickingForWeek(null)}
        />
      )}

      {pickingMidweek != null && (
        <OpponentPicker
          save={save}
          userSchool={userSchool}
          d1Remaining={d1Remaining}
          midweekMode={true}
          onPick={(opp, options) => handleAddOpponent(pickingMidweek, opp, options)}
          onClose={() => setPickingMidweek(null)}
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

function TravelBudgetWarning({ save, travelCost }) {
  // Realistic travel target ~14% of total athletic budget for a MID-tier
  // NAIA program. Trip the warning only when actual scheduled trips push
  // 50%+ above that — small overages are normal.
  const total = save.budget?.totalAthleticBudget || 0
  if (!total || !travelCost) return null
  const target = total * 0.14
  const actual = travelCost
  const ratio = actual / Math.max(1, target)
  if (ratio < 1.5) return null   // within reason — no warning
  const overBy = actual - target
  return (
    <div className={'rounded-xl p-3 mb-4 text-sm flex justify-between items-start ' +
      (ratio >= 2 ? 'bg-red-50 border-2 border-red-300 text-red-900'
                  : 'bg-amber-50 border border-amber-300 text-amber-900')}>
      <div className="flex-1">
        <div className="font-semibold">
          ⚠ Travel cost is {ratio >= 2.5 ? 'WAY' : 'somewhat'} over the typical 14% allocation
        </div>
        <div className="text-xs mt-1">
          Your trips will cost <strong>${(actual / 1000).toFixed(1)}K</strong> — that's
          ${(overBy / 1000).toFixed(1)}K over the ${(target / 1000).toFixed(1)}K
          baseline. Travel locks into the budget at Wk 3 from these games; consider
          home-heavy weekends or closer non-conference opponents if money is tight.
        </div>
      </div>
    </div>
  )
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
                    isScrim ? 'Scrim' : 'Non-conf'
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

function OpponentPicker({ save, userSchool, d1Remaining, midweekMode, onPick, onClose }) {
  const [filter, setFilter] = useState('')
  const [divFilter, setDivFilter] = useState('ALL')

  const allCandidates = useMemo(() => {
    const naia = Object.values(save.schools)
      .filter(s => s.id !== save.userSchoolId)
      .filter(s => s.conferenceId !== userSchool.conferenceId)
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

  // Compute rank within each division so the user can see "#14 NAIA",
  // "#48 D3", etc. Drops a `rank` + `divisionSize` onto each candidate.
  const candidatesByDivisionRanked = useMemo(() => {
    const byDiv = {}
    for (const c of allCandidates) {
      if (!byDiv[c.division]) byDiv[c.division] = []
      byDiv[c.division].push(c)
    }
    for (const div of Object.keys(byDiv)) {
      byDiv[div].sort((a, b) => b.strength - a.strength)
      byDiv[div].forEach((t, i) => {
        t.rank = i + 1
        t.divisionSize = byDiv[div].length
      })
    }
    return allCandidates
  }, [allCandidates])

  // Sort by proximity to the user's home state first — closer teams cost
  // less to travel to and reflect realistic non-conf scheduling patterns.
  // Strength is the tiebreaker within the same proximity bucket.
  const userState = userSchool.state
  const filtered = sortByProximity(
    userState,
    candidatesByDivisionRanked
      .filter(t => divFilter === 'ALL' || t.division === divFilter)
      .filter(t => !filter || t.name.toLowerCase().includes(filter.toLowerCase()))
      .filter(t => t.division !== 'JUCO_NWAC')
      .filter(t => {
        // D1 only allowed in midweek mode
        if (t.division === 'D1') return midweekMode && d1Remaining > 0
        return true
      }),
  ).slice(0, 60)

  function withTravel(opp, userIsHome) {
    if (userIsHome) return null
    if (midweekMode) return estimateMidweekCost(userSchool.state, opp.state)
    return estimateAwaySeriesCost(userSchool.state, opp.state, 4, 3)
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 max-w-2xl w-full max-h-[85vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-lg font-semibold">
            {midweekMode ? 'Pick midweek opponent' : 'Pick weekend opponent'}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>

        <div className="flex gap-1 mb-3 flex-wrap">
          {['ALL', 'NAIA', 'D2', 'D3', ...(midweekMode ? ['D1'] : [])].map(d => (
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

        {midweekMode && (
          <div className="bg-blue-50 border border-blue-200 rounded p-2 mb-3 text-xs text-blue-900">
            Midweek single game. D1 opponents are capped at {NAIA_D1_MIDWEEK_CAP}/year.
          </div>
        )}

        <p className="text-[11px] text-gray-500 mb-2">Sorted by proximity to {userState} — closer opponents first.</p>
        <div className="space-y-1 max-h-96 overflow-y-auto">
          {filtered.map(s => {
            const awayTravel = withTravel(s, false)
            const px = stateProximity(userState, s.state)
            const pxColor = px === 0 ? 'bg-green-100 text-green-800'
              : px === 1 ? 'bg-pnw-cream text-pnw-green'
              : px === 2 ? 'bg-blue-50 text-blue-700'
              : 'bg-gray-100 text-gray-500'
            return (
              <div key={s.id} className="flex items-center gap-2 p-2 hover:bg-pnw-cream rounded text-sm">
                <TeamLogo school={s} size={20} />
                <div className="flex-1">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-gray-500">
                    {s.city}, {s.state} • {s.division}
                    {s.rank && (
                      <> • <span className="font-semibold text-pnw-slate">#{s.rank} {s.division === 'NAIA' ? 'NAIA' : s.division}</span></>
                    )}
                  </div>
                </div>
                <span className={'text-[10px] font-semibold px-1.5 py-0.5 rounded ' + pxColor}>
                  {proximityLabel(px)}
                </span>
                <div className="flex flex-col gap-1 text-xs">
                  <button
                    onClick={() => onPick(s, { userIsHome: true })}
                    className="px-2 py-1 bg-pnw-green text-white rounded"
                  >
                    Home
                  </button>
                  <button
                    onClick={() => onPick(s, { userIsHome: false })}
                    className="px-2 py-1 border border-pnw-green text-pnw-green rounded"
                    title={awayTravel ? `Away — ~$${awayTravel.totalCost.toLocaleString()}` : 'Away'}
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
  const userState = save.schools[save.userSchoolId]?.state

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
    // Sort by proximity — teams don't travel far for fall scrimmages, so the
    // closest options should be at the top of the list by default.
    return sortByProximity(userState, [...naia, ...nonNaia])
  }, [save, userState])

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
          Pick a doubleheader date and opponent. 2 games count toward your 10 scrimmage allotment.
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

        <p className="text-[11px] text-gray-500 mb-2">Sorted by closest to {userState}. Fall trips are short — keep it nearby.</p>
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {filtered.map(s => {
            const px = stateProximity(userState, s.state)
            const pxColor = px === 0 ? 'bg-green-100 text-green-800'
              : px === 1 ? 'bg-pnw-cream text-pnw-green'
              : px === 2 ? 'bg-blue-50 text-blue-700'
              : 'bg-gray-100 text-gray-500'
            return (
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
                <span className={'text-[10px] font-semibold px-1.5 py-0.5 rounded ' + pxColor}>
                  {proximityLabel(px)}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
