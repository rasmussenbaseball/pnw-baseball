/**
 * Play page — set lineups and run live games week by week.
 *
 * Three modes:
 *   - LIST: this week's games (set lineup, enter live game, or auto-sim)
 *   - LINEUP: per-game lineup editor (batting order + starter + bullpen)
 *   - LIVE: GameChanger-style PA-by-PA readout with pitching changes / pinch hits
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import { playerOverall, overallTier } from '../../gm/engine/playerRating'
import { defaultLineup } from '../../gm/engine/sim'
import { resolveLineupForGame, getSavedLineup, saveLineup } from '../../gm/engine/lineups'
import { createLiveGame } from '../../gm/engine/liveGame'
import { simWeek, advanceWeek } from '../../gm/engine/season'
import { seedFromPear } from '../../gm/engine/rankings'
import { displayPosition, displayClassYear } from '../../gm/engine/format'
import TeamLogo from '../../gm/components/TeamLogo'
import GMShell from '../../gm/components/GMShell'
import nonNaiaRaw from '../../gm/data/non_naia_teams.json'

const NON_NAIA_DISPLAY = (() => {
  const out = {}
  for (const div of nonNaiaRaw.divisions) {
    for (const t of div.teams) out[t.id] = { ...t, division: div.id }
  }
  return out
})()

export default function Play() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => loadDynasty(userId, slot))
  const [view, setView] = useState({ kind: 'LIST' })   // LIST | LINEUP | LIVE

  if (!save) return <Navigate to="/gm" replace />

  function refresh() { setSave({ ...save }) }

  if (view.kind === 'LINEUP') {
    return (
      <LineupEditor
        save={save}
        game={view.game}
        onSave={lineup => {
          saveLineup(save, view.game.id, lineup)
          saveDynasty(save); refresh()
          setView({ kind: 'LIST' })
        }}
        onCancel={() => setView({ kind: 'LIST' })}
      />
    )
  }

  if (view.kind === 'LIVE') {
    return (
      <LiveGameView
        save={save}
        game={view.game}
        onExit={(result) => {
          // Persist the final score on the schedule row
          const g = save.schedule.find(x => x.id === view.game.id)
          if (g && result) {
            g.homeRuns = result.homeRuns
            g.awayRuns = result.awayRuns
            g.played = true
            // Accumulate stats into save.playerStats
            accumulateBoxscore(save, result.boxscore)
            // Update team W-L for record-counting games (everything except
            // scrimmages + BYEs). Mirrors the auto-sim path in season.simWeek.
            const counts = g.countsTowardRecord !== false
            if (counts) {
              const homeTeam = save.teams[g.homeId]
              const awayTeam = save.teams[g.awayId]
              if (homeTeam && awayTeam) {
                if (g.homeRuns > g.awayRuns) {
                  homeTeam.wins++; awayTeam.losses++
                  if (g.type === 'CONFERENCE') { homeTeam.confWins++; awayTeam.confLosses++ }
                } else {
                  awayTeam.wins++; homeTeam.losses++
                  if (g.type === 'CONFERENCE') { awayTeam.confWins++; homeTeam.confLosses++ }
                }
                homeTeam.runDiff += g.homeRuns - g.awayRuns
                awayTeam.runDiff += g.awayRuns - g.homeRuns
              } else if (homeTeam || awayTeam) {
                // One side is non-NAIA (no team row); still credit the real side.
                const realTeam = homeTeam || awayTeam
                const realIsHome = !!homeTeam
                const realRuns = realIsHome ? g.homeRuns : g.awayRuns
                const oppRuns = realIsHome ? g.awayRuns : g.homeRuns
                if (realRuns > oppRuns) realTeam.wins++
                else realTeam.losses++
                realTeam.runDiff += realRuns - oppRuns
              }
            }
          }
          saveDynasty(save); refresh()
          setView({ kind: 'LIST' })
        }}
      />
    )
  }

  return (
    <GameList
      save={save}
      slot={slot}
      onSetLineup={(game) => setView({ kind: 'LINEUP', game })}
      onEnterGame={(game) => setView({ kind: 'LIVE', game })}
      onAutoSim={() => {
        // Use existing simWeek + advanceWeek so the rest of the system sees it
        const ratings = seedFromPear(save.schools, save.conferences)
        simWeek(save, save.schedule, ratings)
        advanceWeek(save, save.schedule)
        saveDynasty(save); refresh()
      }}
      onAdvanceEmptyWeek={() => {
        // No games this week — just bump the calendar one week forward and
        // re-render. Use the same advanceWeek so AP refreshes etc.
        advanceWeek(save, save.schedule)
        saveDynasty(save); refresh()
      }}
    />
  )
}

// ────────────────────────────────────────────────────────────────────────────
// LIST view
// ────────────────────────────────────────────────────────────────────────────

function GameList({ save, slot, onSetLineup, onEnterGame, onAutoSim, onAdvanceEmptyWeek }) {
  const cal = save.calendar
  const userSchoolId = save.userSchoolId
  // Determine "this week's user games":
  //   - Season mode: games matching the current seasonWeek (exclude BYE)
  //   - Offseason: any unplayed scrimmages (seasonWeek === 0)
  const thisWeekGames = useMemo(() => {
    const all = (save.schedule || []).filter(g =>
      (g.homeId === userSchoolId || g.awayId === userSchoolId)
      && g.type !== 'BYE'
      && g.awayId !== '__BYE__',
    )
    if (cal.mode === 'SEASON') return all.filter(g => g.seasonWeek === cal.seasonWeek)
    return all.filter(g => g.seasonWeek === 0 && !g.played)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
  }, [save, cal])

  const unplayed = thisWeekGames.filter(g => !g.played)
  const played = thisWeekGames.filter(g => g.played)

  // If there's nothing happening this week, surface the next week that DOES
  // have games — gives the user a clear "Advance to Wk X" button instead of
  // a dead-end empty state.
  const nextWeekWithGames = useMemo(() => {
    if (cal.mode !== 'SEASON') return null
    const sw = cal.seasonWeek ?? 1
    const future = (save.schedule || [])
      .filter(g =>
        !g.played
        && g.type !== 'BYE'
        && g.awayId !== '__BYE__'
        && g.seasonWeek > sw
        && (g.homeId === userSchoolId || g.awayId === userSchoolId)
      )
      .map(g => g.seasonWeek)
    return future.length ? Math.min(...future) : null
  }, [save, cal])

  const userSchool = save.schools[save.userSchoolId]
  return (
    <GMShell schoolName={userSchool?.name} schoolColors={userSchool?.colors}>
    <div className="max-w-5xl mx-auto">
      <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">PLAY</h1>
      <p className="font-pixel text-base text-[#a8a8c8] mb-6">
        {cal.mode === 'SEASON'
          ? `Season Week ${cal.seasonWeek}, set lineups, enter games, or auto-sim.`
          : 'Offseason, schedule scrimmages and set fall lineups to drive scrimmage development.'}
      </p>

      {unplayed.length === 0 && played.length === 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-6 text-center">
          <div className="text-gray-500 mb-3">
            No games scheduled for {cal.mode === 'SEASON' ? `Season Week ${cal.seasonWeek}` : 'this offseason week'}.
          </div>
          {cal.mode === 'SEASON' && nextWeekWithGames != null && (
            <button
              onClick={onAdvanceEmptyWeek}
              className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold hover:opacity-90"
            >
              Advance to Week {nextWeekWithGames} 
            </button>
          )}
          {cal.mode === 'OFFSEASON' && (
            <Link to={`/gm/schedule?slot=${slot}`} className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold inline-block hover:opacity-90">
              Schedule fall games 
            </Link>
          )}
        </div>
      )}

      <div className="space-y-3">
        {unplayed.map(g => (
          <GameCard
            key={g.id}
            save={save}
            game={g}
            onSetLineup={() => onSetLineup(g)}
            onEnterGame={() => onEnterGame(g)}
          />
        ))}
      </div>

      {played.length > 0 && (
        <div className="mt-6">
          <div className="text-xs uppercase text-gray-500 mb-2">Completed this week</div>
          <div className="space-y-1">
            {played.map(g => <PlayedRow key={g.id} save={save} game={g} />)}
          </div>
        </div>
      )}

      {unplayed.length > 0 && (
        <div className="mt-6 bg-white rounded-xl border border-gray-200 p-4 text-sm flex justify-between items-center">
          <div className="text-gray-600">Skip the live experience and auto-sim the rest of this week.</div>
          <button
            onClick={onAutoSim}
            className="px-4 py-2 bg-pnw-slate text-white rounded text-sm font-semibold hover:opacity-90"
          >
            Auto-sim week 
          </button>
        </div>
      )}

      {unplayed.length === 0 && played.length > 0 && cal.mode === 'SEASON' && (
        <div className="mt-6 bg-white rounded-xl border border-pnw-green/40 p-4 text-sm flex justify-between items-center">
          <div className="text-gray-700">All week-{cal.seasonWeek} games complete. Advance to the next week.</div>
          <button
            onClick={onAdvanceEmptyWeek}
            className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold hover:opacity-90"
          >
            Advance week 
          </button>
        </div>
      )}
    </div>
    </GMShell>
  )
}

function GameCard({ save, game, onSetLineup, onEnterGame }) {
  const userSchoolId = save.userSchoolId
  const isHome = game.homeId === userSchoolId
  const oppId = isHome ? game.awayId : game.homeId
  const opp = save.schools[oppId] || NON_NAIA_DISPLAY[oppId] || { name: oppId }
  const saved = getSavedLineup(save, game.id)
  const typeLabel = game.type === 'CONFERENCE' ? 'Conference'
    : game.type === 'D1_MIDWEEK' ? 'D1 Midweek'
    : game.type === 'FALL_SCRIMMAGE' ? 'Fall Scrimmage'
    : game.type === 'SPRING_SCRIMMAGE' ? 'Spring Scrimmage'
    : 'Non-conference'
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
      <div className="flex justify-between items-start mb-2">
        <div className="flex items-center gap-3">
          <TeamLogo school={opp} size={36} />
          <div>
            <div className="font-semibold text-pnw-slate">{isHome ? 'vs' : '@'} {opp.name}</div>
            <div className="text-xs text-gray-500">{typeLabel} • {game.date}</div>
          </div>
        </div>
        <div className="text-right">
          <div className={'text-[11px] font-semibold ' + (saved ? 'text-pnw-green' : 'text-amber-700')}>
            {saved ? ' Lineup set' : 'No lineup set'}
          </div>
          {!saved && (
            <div className="text-[10px] text-gray-400">Will use top-9 + top-5 default</div>
          )}
        </div>
      </div>
      <div className="flex gap-2 mt-3">
        <button onClick={onSetLineup} className="flex-1 px-3 py-1.5 border border-pnw-green text-pnw-green hover:bg-pnw-cream rounded text-xs font-semibold">
          {saved ? 'Edit lineup' : 'Set lineup'}
        </button>
        <button onClick={onEnterGame} className="flex-1 px-3 py-1.5 bg-pnw-green text-white rounded text-xs font-semibold hover:opacity-90">
          ▶ Enter game (live)
        </button>
      </div>
    </div>
  )
}

function PlayedRow({ save, game }) {
  const userSchoolId = save.userSchoolId
  const isHome = game.homeId === userSchoolId
  const oppId = isHome ? game.awayId : game.homeId
  const opp = save.schools[oppId] || NON_NAIA_DISPLAY[oppId] || { name: oppId }
  const my = isHome ? game.homeRuns : game.awayRuns
  const them = isHome ? game.awayRuns : game.homeRuns
  const won = my > them
  return (
    <div className="flex justify-between items-center text-sm py-1 px-3 bg-gray-50 rounded">
      <span className="text-gray-700">{isHome ? 'vs' : '@'} {opp.name}</span>
      <span className={'font-mono font-bold ' + (won ? 'text-green-700' : 'text-red-700')}>
        {won ? 'W' : 'L'} {my}-{them}
      </span>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// LINEUP editor
// ────────────────────────────────────────────────────────────────────────────

function LineupEditor({ save, game, onSave, onCancel }) {
  const userSchoolId = save.userSchoolId
  const team = save.teams[userSchoolId]
  const players = team.rosterPlayerIds.map(id => save.players[id]).filter(Boolean)

  // Initial state: saved lineup, otherwise default
  const saved = getSavedLineup(save, game.id)
  const def = defaultLineup(team, save.players)
  const [batters, setBatters] = useState(() =>
    saved ? saved.batters.map(id => save.players[id]).filter(Boolean) : def.batters,
  )
  const [starterId, setStarterId] = useState(() =>
    saved?.starterPitcherId ?? def.pitcherRotation[0]?.id ?? null,
  )
  const [bullpenIds, setBullpenIds] = useState(() =>
    saved?.bullpenIds ?? def.pitcherRotation.slice(1, 5).map(p => p.id),
  )

  const hitters = players.filter(p => !p.isPitcher)
  const pitchers = players.filter(p => p.isPitcher)
  const batterIds = new Set(batters.map(b => b.id))

  function setBatterSpot(spotIdx, player) {
    const next = [...batters]
    next[spotIdx] = player
    setBatters(next)
  }

  function moveSpot(idx, dir) {
    const swap = idx + dir
    if (swap < 0 || swap > 8) return
    const next = [...batters]
    ;[next[idx], next[swap]] = [next[swap], next[idx]]
    setBatters(next)
  }

  const canSave = batters.length === 9 && batters.every(b => b) && starterId

  function handleSave() {
    if (!canSave) return
    onSave({
      batters: batters.map(b => b.id),
      starterPitcherId: starterId,
      bullpenIds,
    })
  }

  function toggleBullpen(id) {
    if (bullpenIds.includes(id)) setBullpenIds(bullpenIds.filter(x => x !== id))
    else if (bullpenIds.length < 6) setBullpenIds([...bullpenIds, id])
  }

  const isHome = game.homeId === userSchoolId
  const oppId = isHome ? game.awayId : game.homeId
  const opp = save.schools[oppId] || NON_NAIA_DISPLAY[oppId] || { name: oppId }

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <button onClick={onCancel} className="text-sm text-pnw-green hover:underline">Back to games</button>
      <h1 className="text-2xl font-bold text-pnw-slate mt-1 mb-1">Set Lineup</h1>
      <p className="text-sm text-gray-600 mb-6">{isHome ? 'vs' : '@'} {opp.name} • {game.date}</p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Batting order */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-pnw-slate mb-3">Batting Order</h2>
          <div className="space-y-1.5">
            {batters.map((b, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs w-5 text-gray-400 font-mono">{i + 1}.</span>
                <select
                  value={b?.id || ''}
                  onChange={e => setBatterSpot(i, hitters.find(h => h.id === e.target.value))}
                  className="flex-1 border rounded px-2 py-1 text-sm"
                >
                  {hitters.map(h => (
                    <option key={h.id} value={h.id} disabled={batterIds.has(h.id) && h.id !== b?.id}>
                      {h.firstName} {h.lastName} ({displayPosition(h.primaryPosition)} · {displayClassYear(h)} · OVR {playerOverall(h)})
                    </option>
                  ))}
                </select>
                <button onClick={() => moveSpot(i, -1)} disabled={i === 0} className="text-xs px-1.5 py-0.5 border rounded disabled:opacity-30"></button>
                <button onClick={() => moveSpot(i, +1)} disabled={i === 8} className="text-xs px-1.5 py-0.5 border rounded disabled:opacity-30"></button>
              </div>
            ))}
          </div>
        </div>

        {/* Pitching */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-pnw-slate mb-3">Pitching</h2>
          <div className="mb-3">
            <label className="text-xs uppercase tracking-wider text-gray-500">Starting Pitcher</label>
            <select
              value={starterId || ''}
              onChange={e => setStarterId(e.target.value)}
              className="block w-full mt-1 border rounded px-2 py-1.5 text-sm"
            >
              <option value="">— pick one —</option>
              {pitchers.map(p => (
                <option key={p.id} value={p.id}>
                  {p.firstName} {p.lastName} ({displayClassYear(p)} · Stuff {p.pitcher.stuff} · Stam {p.pitcher.stamina})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider text-gray-500">Bullpen (up to 6)</label>
            <div className="mt-1 max-h-72 overflow-y-auto border border-gray-100 rounded p-2">
              {pitchers.filter(p => p.id !== starterId).map(p => (
                <label key={p.id} className="flex items-center gap-2 text-xs py-0.5 hover:bg-gray-50 rounded px-1">
                  <input
                    type="checkbox"
                    checked={bullpenIds.includes(p.id)}
                    onChange={() => toggleBullpen(p.id)}
                    disabled={!bullpenIds.includes(p.id) && bullpenIds.length >= 6}
                  />
                  <span className="flex-1">{p.firstName} {p.lastName}</span>
                  <span className="text-gray-500 font-mono">{p.pitcher.stuff}/{p.pitcher.control}/{p.pitcher.stamina}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onCancel} className="px-4 py-2 border rounded text-sm">Cancel</button>
        <button
          onClick={handleSave}
          disabled={!canSave}
          className="px-6 py-2 bg-pnw-green text-white rounded text-sm font-semibold disabled:opacity-40"
        >
          Save lineup
        </button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// LIVE game
// ────────────────────────────────────────────────────────────────────────────

function LiveGameView({ save, game, onExit }) {
  const userSchoolId = save.userSchoolId
  const isHome = game.homeId === userSchoolId
  const oppId = isHome ? game.awayId : game.homeId
  const userTeam = save.teams[userSchoolId]
  const oppTeam = save.teams[oppId]
  const userSchool = save.schools[userSchoolId]
  const oppSchool = save.schools[oppId] || NON_NAIA_DISPLAY[oppId]

  // Initialize the live engine exactly once per game id
  const liveRef = useRef(null)
  if (!liveRef.current) {
    const userLineup = resolveLineupForGame(save, userSchoolId, game.id)
    // Opponent — use defaultLineup for NAIA opponents, or build a synthetic
    // lineup for non-NAIA (just placeholder players based on strength).
    let oppLineup
    if (oppTeam) {
      oppLineup = resolveLineupForGame(save, oppId, game.id)
      if (!oppLineup.batters.length) {
        // safety net
        oppLineup = { batters: [], pitcherRotation: [] }
      }
    } else {
      // Non-NAIA opponent — build a synthetic 9-batter / 5-pitcher list from
      // a strength rating so the live engine has someone to face.
      const strength = oppSchool?.strength ?? 0
      oppLineup = makeSyntheticLineup(oppSchool, strength)
    }
    const homeLineup = isHome ? userLineup : oppLineup
    const awayLineup = isHome ? oppLineup : userLineup
    const userHC = save.coaches[userTeam.headCoachId]
    const oppHC = oppTeam ? save.coaches[oppTeam.headCoachId] : null
    liveRef.current = createLiveGame(homeLineup, awayLineup, {
      homeMotivator: (isHome ? userHC?.motivator : oppHC?.motivator) ?? 50,
      awayMotivator: (isHome ? oppHC?.motivator : userHC?.motivator) ?? 50,
      homeTeamName: (isHome ? userSchool : oppSchool)?.name || 'Home',
      awayTeamName: (isHome ? oppSchool : userSchool)?.name || 'Away',
    }, game.id)
  }
  const live = liveRef.current

  // Force re-render on event push
  const [, bump] = useState(0)
  const rerender = () => bump(x => x + 1)
  const [showPitching, setShowPitching] = useState(false)

  function doStep() { live.step(); rerender() }
  function doHalfInning() { live.simHalfInning(); rerender() }
  function doRest() { live.simRest(); rerender() }
  function doPitchingChange(newPitcher) {
    live.pitchingChange(newPitcher)
    setShowPitching(false)
    rerender()
  }
  function handleFinish() {
    if (!live.isOver()) live.simRest()
    onExit(live.getResult())
  }

  const s = live.state
  const userIsBatting = (s.top && !isHome) || (!s.top && isHome)
  const userIsPitching = !userIsBatting

  const homeName = isHome ? userSchool?.name : (oppSchool?.name || 'Opponent')
  const awayName = isHome ? (oppSchool?.name || 'Opponent') : userSchool?.name

  return (
    <div className="max-w-4xl mx-auto py-6 px-4">
      <div className="flex justify-between items-start mb-4">
        <div>
          <div className="text-xs text-gray-500">Live Game</div>
          <div className="text-2xl font-bold text-pnw-slate">{awayName} @ {homeName}</div>
          <div className="text-xs text-gray-500">{game.type === 'FALL_SCRIMMAGE' ? 'Fall Scrimmage' : game.type === 'CONFERENCE' ? 'Conference' : 'Non-conference'} • {game.date}</div>
        </div>
        <button onClick={handleFinish} className="px-3 py-1.5 bg-pnw-slate text-white rounded text-xs font-semibold">
          {live.isOver() ? 'Save & exit' : 'Auto-finish & exit'}
        </button>
      </div>

      {/* Scoreboard strip */}
      <div className="bg-pnw-slate text-white rounded-xl p-4 mb-4 grid grid-cols-3 gap-2 items-center">
        <div className="text-right">
          <div className="text-xs opacity-70">{awayName}</div>
          <div className="text-4xl font-bold font-mono">{s.awayRuns}</div>
        </div>
        <div className="text-center">
          <div className="text-xs opacity-70 uppercase tracking-wider">{s.isOver ? 'Final' : (s.top ? 'Top' : 'Bot')} {s.inning}</div>
          <div className="text-lg font-mono mt-1">{s.outs} out{s.outs === 1 ? '' : 's'}</div>
          <BaseDiagram bases={s.bases} />
        </div>
        <div className="text-left">
          <div className="text-xs opacity-70">{homeName}</div>
          <div className="text-4xl font-bold font-mono">{s.homeRuns}</div>
        </div>
      </div>

      {/* Matchup + controls */}
      {!s.isOver && (
        <div className="bg-white rounded-xl border border-gray-200 p-3 mb-4 flex justify-between items-center text-sm">
          <div>
            <div className="text-[10px] uppercase text-gray-500">At bat</div>
            <div className="font-semibold">{nm(live.currentBatter())}</div>
          </div>
          <div className="text-gray-400">vs</div>
          <div>
            <div className="text-[10px] uppercase text-gray-500">Pitching</div>
            <div className="font-semibold">{nm(live.currentPitcher())}</div>
          </div>
          <div className="flex gap-2">
            <button onClick={doStep} className="px-3 py-1.5 bg-pnw-green text-white rounded text-xs font-semibold">Next batter </button>
            <button onClick={doHalfInning} className="px-3 py-1.5 border border-pnw-green text-pnw-green rounded text-xs font-semibold">Finish inning</button>
            <button onClick={doRest} className="px-3 py-1.5 border rounded text-xs">Sim to end</button>
            {userIsPitching && (
              <button onClick={() => setShowPitching(true)} className="px-3 py-1.5 border border-amber-400 text-amber-700 rounded text-xs font-semibold">
                Pitching change
              </button>
            )}
          </div>
        </div>
      )}

      {/* Pitching change modal */}
      {showPitching && (
        <PitchingChangeModal
          live={live}
          save={save}
          isHome={isHome}
          onPick={doPitchingChange}
          onClose={() => setShowPitching(false)}
        />
      )}

      {/* Event log — newest first */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 max-h-[60vh] overflow-y-auto">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Play-by-play</h2>
        <div className="space-y-1">
          {[...s.events].reverse().map((ev, i) => (
            <EventLine key={s.events.length - 1 - i} ev={ev} />
          ))}
        </div>
      </div>
    </div>
  )
}

function EventLine({ ev }) {
  const tag = ev.top ? `T${ev.inning}` : `B${ev.inning}`
  if (ev.kind === 'GAME_END' || ev.kind === 'HALF_END' || ev.kind === 'SUB' || ev.kind === 'PITCHING_CHANGE') {
    return (
      <div className="text-xs text-pnw-slate border-l-2 border-pnw-green pl-2 py-0.5 bg-pnw-cream/40">
        <span className="font-mono text-[10px] text-gray-400 mr-2">{tag}</span>
        {ev.text}
      </div>
    )
  }
  // PA event
  return (
    <div className="text-sm py-0.5">
      <span className="font-mono text-[10px] text-gray-400 mr-2">{tag}</span>
      <span className="text-gray-700">{ev.text}</span>
      <span className="ml-2 text-[10px] text-gray-400">({ev.outs} out · {ev.score.away}-{ev.score.home})</span>
    </div>
  )
}

function BaseDiagram({ bases }) {
  const [r1, r2, r3] = bases
  return (
    <div className="inline-block mt-2 text-[14px]">
      <div className="flex justify-center"><span className={r2 ? 'opacity-100' : 'opacity-30'}>◆</span></div>
      <div className="flex gap-3 justify-center">
        <span className={r3 ? 'opacity-100' : 'opacity-30'}>◆</span>
        <span className={r1 ? 'opacity-100' : 'opacity-30'}>◆</span>
      </div>
    </div>
  )
}

function nm(p) { return p ? `${p.firstName} ${p.lastName}` : '???' }

function PitchingChangeModal({ live, save, isHome, onPick, onClose }) {
  // Available pitchers = user's bullpen
  const userSchoolId = save.userSchoolId
  const team = save.teams[userSchoolId]
  const isUserPitching = (live.state.top && isHome) || (!live.state.top && !isHome)
  if (!isUserPitching) {
    onClose()
    return null
  }
  const bullpen = (isHome ? live.state.homeBullpen : live.state.awayBullpen)
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-5 max-w-md w-full">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-lg font-semibold">Bring in</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"></button>
        </div>
        {bullpen.length === 0 && (
          <div className="text-sm text-gray-500">No pitchers left in the bullpen.</div>
        )}
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {bullpen.map(p => (
            <button
              key={p.id}
              onClick={() => onPick(p)}
              className="w-full text-left p-2 hover:bg-pnw-cream rounded text-sm flex justify-between"
            >
              <span>{p.firstName} {p.lastName}</span>
              <span className="text-xs text-gray-500 font-mono">Stuff {p.pitcher.stuff} · Stam {p.pitcher.stamina}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// Synthetic opponent (non-NAIA) — just enough player-shaped objects to feed simPA.
function makeSyntheticLineup(school, strength) {
  // strength is roughly -3..+10; map to a ratings mean.
  const base = 50 + strength * 2
  function fakeHitter(i) {
    return {
      id: `synth_${school?.id || 'opp'}_h${i}`,
      firstName: 'Opp',
      lastName: `Batter${i + 1}`,
      bats: i % 3 === 0 ? 'L' : 'R',
      throws: 'R',
      primaryPosition: ['C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF', 'DH'][i],
      isHitter: true, isPitcher: false,
      hitter: {
        contact_l: base, contact_r: base, power_l: base, power_r: base,
        discipline: base, speed: base, fielding: base, arm: base,
      },
      classYear: 'JR',
    }
  }
  function fakePitcher(i) {
    return {
      id: `synth_${school?.id || 'opp'}_p${i}`,
      firstName: 'Opp',
      lastName: `Pitcher${i + 1}`,
      bats: 'R', throws: i === 0 ? 'L' : 'R',
      primaryPosition: 'P',
      isHitter: false, isPitcher: true,
      pitcher: {
        stuff: base, control: base, command: base, stamina: base + 5,
        vs_l: base, vs_r: base, composure: base, durability: base,
        velocity_avg: 85, velocity_min: 83, velocity_max: 87,
      },
      classYear: 'JR',
    }
  }
  return {
    batters: Array.from({ length: 9 }, (_, i) => fakeHitter(i)),
    pitcherRotation: Array.from({ length: 5 }, (_, i) => fakePitcher(i)),
  }
}

// Accumulate a finished game's box score into save.playerStats. Same shape as
// season.js does for auto-simmed games. We mirror it here so live games update
// the same stats stores the rest of the engine reads from.
function accumulateBoxscore(save, boxscore) {
  if (!boxscore) return
  if (!save.playerStats) save.playerStats = {}
  const zeroBatter = { ab:0,h:0,d:0,t:0,hr:0,bb:0,k:0,rbi:0,pa:0,hbp:0,sf:0,sac:0,gidp:0,roe:0,gamesPlayed:0 }
  const zeroPitcher = { ip:0,h:0,bb:0,k:0,er:0,outs:0,pa:0,hbp:0,hr:0,gamesPlayed:0 }
  function bump(statsObj, isPitcher) {
    for (const [pid, s] of Object.entries(statsObj)) {
      const key = isPitcher ? `p_${pid}` : `b_${pid}`
      if (!save.playerStats[key]) save.playerStats[key] = { playerId: pid, isPitcher, ...(isPitcher ? zeroPitcher : zeroBatter) }
      const t = save.playerStats[key]
      for (const k of Object.keys(s)) t[k] = (t[k] || 0) + s[k]
      t.gamesPlayed = (t.gamesPlayed || 0) + 1
    }
  }
  bump(boxscore.batterStats, false)
  bump(boxscore.pitcherStats, true)
}
