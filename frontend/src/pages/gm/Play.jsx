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
import GMShell, { PixelCard, PixelButton } from '../../gm/components/GMShell'
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
            // Persist the per-game boxscore so the user can review it from
            // the Completed-this-week list.
            if (result.boxscore?.batterStats) {
              g.boxscore = {
                batterStats: result.boxscore.batterStats,
                pitcherStats: result.boxscore.pitcherStats || {},
                innings: result.boxscore.innings || null,
              }
            }
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
  // Determine "this week's user games" — ONLY games actually scheduled
  // for the current week. Previously, offseason mode returned every fall
  // scrimmage at once (all of them have seasonWeek=0), which let the user
  // see "Enter game" buttons for games weeks in advance. Now we match on
  // the unified weekOfYear field so each week only surfaces its own games.
  const thisWeekGames = useMemo(() => {
    const wk = cal.weekOfYear
    const sw = cal.seasonWeek
    const all = (save.schedule || []).filter(g =>
      (g.homeId === userSchoolId || g.awayId === userSchoolId)
      && g.type !== 'BYE'
      && g.awayId !== '__BYE__',
    )
    return all
      .filter(g => {
        // Season mode: in-season games match by seasonWeek
        if (cal.mode === 'SEASON' && sw != null && g.seasonWeek === sw) return true
        // Offseason: scrimmages match by weekOfYear (each scrim has a specific
        // week — see scheduleFallGames). Don't return ALL scrimmages.
        if (wk != null && g.weekOfYear === wk) return true
        return false
      })
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
      <p className="font-pixel text-base text-[#a8a8c8] mb-3">
        {cal.mode === 'SEASON'
          ? `Season Week ${cal.seasonWeek}, set lineups, enter games, or auto-sim.`
          : 'Offseason — set fall lineups to drive scrimmage development.'}
      </p>

      {cal.mode !== 'SEASON' && unplayed.some(g => g.type === 'FALL_SCRIMMAGE') && (
        <div className="bg-emerald-900/30 border-l-4 border-emerald-400 text-emerald-100 rounded-r p-3 mb-4 text-sm">
          <strong className="text-emerald-300">Fall scrimmages develop your players.</strong> Anyone you put in the lineup gets a small permanent rating bump per scrimmage (some larger, some smaller — scaled by their potential). This is your biggest non-recruiting offseason dev lever. Play your underclassmen, projects, and anyone you're trying to grow.
        </div>
      )}

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
  const isFallScrim = game.type === 'FALL_SCRIMMAGE'
  const typeLabel = game.type === 'CONFERENCE' ? 'Conference'
    : game.type === 'D1_MIDWEEK' ? 'D1 Midweek'
    : isFallScrim ? 'Fall Scrimmage'
    : game.type === 'SPRING_SCRIMMAGE' ? 'Spring Scrimmage'
    : 'Non-conference'
  return (
    <div className={'rounded-xl border p-4 shadow-sm ' + (isFallScrim ? 'bg-emerald-50 border-emerald-300' : 'bg-white border-gray-200')}>
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
            {saved ? 'Lineup set' : 'No lineup set'}
          </div>
          {!saved && (
            <div className="text-[10px] text-gray-400">Will use top-9 + top-5 default</div>
          )}
        </div>
      </div>
      {isFallScrim && (
        <div className="mt-1 mb-2 bg-emerald-100 border border-emerald-300 rounded px-2 py-1.5 text-[11px] text-emerald-900 leading-snug">
          <strong>Development boost:</strong> every player you start in this scrimmage gets a chance at a small rating bump. Play your young guys + projects — they'll grow more here than they will in spring.
        </div>
      )}
      <div className="flex gap-2 mt-3">
        <button onClick={onSetLineup} className="flex-1 px-3 py-1.5 border border-pnw-green text-pnw-green hover:bg-pnw-cream rounded text-xs font-semibold">
          {saved ? 'Edit lineup' : 'Set lineup'}
        </button>
        <button onClick={onEnterGame} className="flex-1 px-3 py-1.5 bg-pnw-green text-white rounded text-xs font-semibold hover:opacity-90">
          Enter game (live)
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
  const [open, setOpen] = useState(false)
  const hasBoxscore = !!game.boxscore?.batterStats
  return (
    <>
      <div className="flex justify-between items-center text-sm py-1 px-3 bg-gray-50 rounded">
        <span className="text-gray-700">{isHome ? 'vs' : '@'} {opp.name}</span>
        <div className="flex items-center gap-2">
          {hasBoxscore && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="text-[11px] text-pnw-green hover:underline font-semibold"
            >
              Box score
            </button>
          )}
          <span className={'font-mono font-bold ' + (won ? 'text-green-700' : 'text-red-700')}>
            {won ? 'W' : 'L'} {my}-{them}
          </span>
        </div>
      </div>
      {open && (
        <BoxScoreModal
          save={save}
          game={game}
          oppName={opp.name}
          isHome={isHome}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function BoxScoreModal({ save, game, oppName, isHome, onClose }) {
  const bs = game.boxscore
  if (!bs) return null
  const userSchoolId = save.userSchoolId
  const userTeam = save.teams[userSchoolId]
  const isMyRoster = pid => userTeam.rosterPlayerIds.includes(pid)
  const myBatters = []
  const oppBatters = []
  for (const [pid, s] of Object.entries(bs.batterStats || {})) {
    const player = save.players[pid] || { firstName: pid, lastName: '' }
    const row = { pid, name: `${player.firstName} ${player.lastName}`.trim(), ...s }
    if (isMyRoster(pid)) myBatters.push(row); else oppBatters.push(row)
  }
  const myPitchers = []
  const oppPitchers = []
  for (const [pid, s] of Object.entries(bs.pitcherStats || {})) {
    const player = save.players[pid] || { firstName: pid, lastName: '' }
    const row = { pid, name: `${player.firstName} ${player.lastName}`.trim(), ...s }
    if (isMyRoster(pid)) myPitchers.push(row); else oppPitchers.push(row)
  }
  myBatters.sort((a, b) => (b.h || 0) - (a.h || 0))
  oppBatters.sort((a, b) => (b.h || 0) - (a.h || 0))
  myPitchers.sort((a, b) => (b.outs || 0) - (a.outs || 0))
  oppPitchers.sort((a, b) => (b.outs || 0) - (a.outs || 0))
  const userSchool = save.schools[userSchoolId]
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-5xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="bg-pnw-slate text-white px-6 py-3 flex justify-between items-center sticky top-0">
          <div>
            <div className="text-xs opacity-80 uppercase tracking-wider">Box Score</div>
            <div className="text-lg font-bold">
              {isHome ? `${oppName} @ ${userSchool.name}` : `${userSchool.name} @ ${oppName}`}
            </div>
            <div className="text-xs opacity-80">
              Final: {isHome ? `${game.awayRuns} - ${game.homeRuns}` : `${game.awayRuns} - ${game.homeRuns}`} · {game.date}
            </div>
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white text-xl">×</button>
        </div>
        <div className="p-4 space-y-4">
          <BoxScoreTable title={`${userSchool.name} — Hitting`} rows={myBatters} type="batter" />
          <BoxScoreTable title={`${oppName} — Hitting`} rows={oppBatters} type="batter" />
          <BoxScoreTable title={`${userSchool.name} — Pitching`} rows={myPitchers} type="pitcher" />
          <BoxScoreTable title={`${oppName} — Pitching`} rows={oppPitchers} type="pitcher" />
        </div>
      </div>
    </div>
  )
}

function BoxScoreTable({ title, rows, type }) {
  if (rows.length === 0) {
    return (
      <div>
        <div className="text-xs uppercase tracking-wider text-gray-500 font-bold mb-1">{title}</div>
        <div className="text-xs text-gray-400 italic px-2 py-1">No players logged.</div>
      </div>
    )
  }
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-gray-500 font-bold mb-1">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-500 uppercase text-[10px]">
            {type === 'batter' ? (
              <tr>
                <th className="text-left py-1 px-2">Player</th>
                <th className="text-center">AB</th>
                <th className="text-center">R</th>
                <th className="text-center">H</th>
                <th className="text-center">2B</th>
                <th className="text-center">3B</th>
                <th className="text-center">HR</th>
                <th className="text-center">RBI</th>
                <th className="text-center">BB</th>
                <th className="text-center">K</th>
                <th className="text-center">HBP</th>
                <th className="text-center">SB</th>
                <th className="text-center">CS</th>
                <th className="text-center">AVG</th>
              </tr>
            ) : (
              <tr>
                <th className="text-left py-1 px-2">Pitcher</th>
                <th className="text-center">IP</th>
                <th className="text-center">H</th>
                <th className="text-center">R</th>
                <th className="text-center">ER</th>
                <th className="text-center">BB</th>
                <th className="text-center">K</th>
                <th className="text-center">HR</th>
                <th className="text-center">HBP</th>
                <th className="text-center">BF</th>
                <th className="text-center">ERA</th>
              </tr>
            )}
          </thead>
          <tbody>
            {rows.map(r => {
              if (type === 'batter') {
                const avg = r.ab > 0 ? (r.h / r.ab) : null
                return (
                  <tr key={r.pid} className="border-t">
                    <td className="py-1 px-2 font-medium">{r.name}</td>
                    <td className="text-center font-mono">{r.ab || 0}</td>
                    <td className="text-center font-mono">{r.r || 0}</td>
                    <td className="text-center font-mono font-semibold">{r.h || 0}</td>
                    <td className="text-center font-mono">{r.d || 0}</td>
                    <td className="text-center font-mono">{r.t || 0}</td>
                    <td className="text-center font-mono">{r.hr || 0}</td>
                    <td className="text-center font-mono">{r.rbi || 0}</td>
                    <td className="text-center font-mono">{r.bb || 0}</td>
                    <td className="text-center font-mono">{r.k || 0}</td>
                    <td className="text-center font-mono">{r.hbp || 0}</td>
                    <td className="text-center font-mono">{r.sb || 0}</td>
                    <td className="text-center font-mono">{r.cs || 0}</td>
                    <td className="text-center font-mono">{avg != null ? avg.toFixed(3).replace(/^0\./, '.') : '—'}</td>
                  </tr>
                )
              }
              const ipDec = (r.outs || 0) / 3
              const ipDisplay = r.ip != null ? r.ip.toFixed(1) : (Math.floor(ipDec) + '.' + ((r.outs || 0) % 3))
              const era = ipDec > 0 ? (r.er * 9 / ipDec).toFixed(2) : '—'
              return (
                <tr key={r.pid} className="border-t">
                  <td className="py-1 px-2 font-medium">{r.name}</td>
                  <td className="text-center font-mono font-semibold">{ipDisplay}</td>
                  <td className="text-center font-mono">{r.h || 0}</td>
                  <td className="text-center font-mono">{(r.er || 0) /* R approximation */}</td>
                  <td className="text-center font-mono">{r.er || 0}</td>
                  <td className="text-center font-mono">{r.bb || 0}</td>
                  <td className="text-center font-mono">{r.k || 0}</td>
                  <td className="text-center font-mono">{r.hr || 0}</td>
                  <td className="text-center font-mono">{r.hbp || 0}</td>
                  <td className="text-center font-mono">{r.pa || 0}</td>
                  <td className="text-center font-mono">{era}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// LINEUP editor
// ────────────────────────────────────────────────────────────────────────────

function LineupEditor({ save, game, onSave, onCancel }) {
  const userSchoolId = save.userSchoolId
  const team = save.teams[userSchoolId]
  const players = team.rosterPlayerIds
    .map(id => save.players[id])
    .filter(p => p && p.eligibilityStatus !== 'cut' && p.eligibilityStatus !== 'dismissed' && (p.injury?.weeksRemaining || 0) === 0)

  // Initial state from saved lineup or default
  const saved = getSavedLineup(save, game.id)
  const def = defaultLineup(team, save.players)
  // Each batting slot is { playerId, position } — position is the FIELDING
  // slot they play. DH is allowed and means "no field position, bat only".
  const [slots, setSlots] = useState(() => initialSlots(saved, def, save.players, players))
  const [starterId, setStarterId] = useState(() =>
    saved?.starterPitcherId ?? def.pitcherRotation[0]?.id ?? null,
  )

  const hitters = players.filter(p => !p.isPitcher)
  const pitchers = players.filter(p => p.isPitcher)
  const POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH']

  function setSlotPlayer(slotIdx, playerId) {
    const next = [...slots]
    next[slotIdx] = { ...next[slotIdx], playerId }
    setSlots(next)
  }
  function setSlotPosition(slotIdx, position) {
    const next = [...slots]
    // Enforce unique field positions (DH excluded — only one DH but you'd
    // expect that anyway). If another slot already has this position, swap.
    if (position !== 'DH') {
      const dupIdx = next.findIndex((s, i) => i !== slotIdx && s.position === position)
      if (dupIdx >= 0) next[dupIdx] = { ...next[dupIdx], position: next[slotIdx].position }
    }
    next[slotIdx] = { ...next[slotIdx], position }
    setSlots(next)
  }
  function moveSpot(idx, dir) {
    const swap = idx + dir
    if (swap < 0 || swap > 8) return
    const next = [...slots]
    ;[next[idx], next[swap]] = [next[swap], next[idx]]
    setSlots(next)
  }

  const usedIds = new Set(slots.map(s => s.playerId).filter(Boolean))
  const allPositionsCovered =
    ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']
      .every(pos => slots.some(s => s.position === pos))
  const canSave = slots.every(s => s.playerId) && starterId && allPositionsCovered

  function handleSave() {
    if (!canSave) return
    onSave({
      batters: slots.map(s => s.playerId),
      batterPositions: slots.map(s => s.position),
      starterPitcherId: starterId,
      // bullpenIds dropped — every pitcher is available
      bullpenIds: pitchers.filter(p => p.id !== starterId).map(p => p.id),
    })
  }

  const isHome = game.homeId === userSchoolId
  const oppId = isHome ? game.awayId : game.homeId
  const opp = save.schools[oppId] || NON_NAIA_DISPLAY[oppId] || { name: oppId }
  const school = save.schools[userSchoolId]

  return (
    <GMShell schoolName={school?.name} schoolColors={school?.colors}>
    <div className="max-w-5xl mx-auto">
      <button onClick={onCancel} className="text-xs text-amber-300 hover:underline mb-2 font-pixel uppercase tracking-widest">
        ← Back to games
      </button>
      <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">SET LINEUP</h1>
      <p className="font-pixel text-base text-[#a8a8c8] mb-4">
        {isHome ? 'vs' : '@'} {opp.name} · {game.date}
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Batting order */}
        <PixelCard accent="#fbbf24" title="BATTING ORDER">
          <div className="text-[10px] text-[#a8a8c8] mb-2 leading-snug">
            Pick a player + their field position for each spot. The DH can
            be your best bat regardless of natural position. Every field
            position (C, 1B, 2B, SS, 3B, LF, CF, RF) must be filled exactly once.
          </div>
          <div className="space-y-1.5">
            {slots.map((slot, i) => {
              const p = save.players[slot.playerId]
              const ovr = p ? playerOverall(p) : 0
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className="font-mono text-amber-300 font-bold w-6">{i + 1}.</span>
                  <select
                    value={slot.playerId || ''}
                    onChange={e => setSlotPlayer(i, e.target.value)}
                    className="flex-1 bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded px-2 py-1 text-sm text-white"
                  >
                    <option value="">— pick player —</option>
                    {hitters.map(h => (
                      <option key={h.id} value={h.id} disabled={usedIds.has(h.id) && h.id !== slot.playerId}>
                        {h.firstName} {h.lastName} ({displayPosition(h.primaryPosition)} · {displayClassYear(h)} · OVR {playerOverall(h)})
                      </option>
                    ))}
                  </select>
                  <select
                    value={slot.position}
                    onChange={e => setSlotPosition(i, e.target.value)}
                    className="bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded px-2 py-1 text-xs text-white w-16"
                    title="Field position"
                  >
                    {POSITIONS.map(pos => <option key={pos} value={pos}>{pos}</option>)}
                  </select>
                  <div className="flex flex-col gap-0.5">
                    <button
                      onClick={() => moveSpot(i, -1)}
                      disabled={i === 0}
                      className="text-[10px] px-1 bg-[#3a3a5e] text-white rounded disabled:opacity-30"
                    >▲</button>
                    <button
                      onClick={() => moveSpot(i, +1)}
                      disabled={i === 8}
                      className="text-[10px] px-1 bg-[#3a3a5e] text-white rounded disabled:opacity-30"
                    >▼</button>
                  </div>
                </div>
              )
            })}
          </div>
          {!allPositionsCovered && (
            <div className="mt-2 text-[10px] text-red-400">
              Missing position: every field position (C, 1B, 2B, SS, 3B, LF, CF, RF) must appear exactly once. The 9th slot can be DH or duplicate a field position.
            </div>
          )}
        </PixelCard>

        {/* Pitching */}
        <PixelCard accent="#fbbf24" title="STARTING PITCHER">
          <div className="text-[10px] text-[#a8a8c8] mb-2 leading-snug">
            Pick your starter — anyone else on the staff is available to
            come in from the bullpen during the game via the live-game sub
            menu. No need to pre-select a bullpen.
          </div>
          <select
            value={starterId || ''}
            onChange={e => setStarterId(e.target.value)}
            className="block w-full bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded px-2 py-2 text-sm text-white"
          >
            <option value="">— pick a starter —</option>
            {pitchers.map(p => (
              <option key={p.id} value={p.id}>
                {p.firstName} {p.lastName} ({displayClassYear(p)} · Stuff {p.pitcher.stuff} · Stam {p.pitcher.stamina} · Velo {p.pitcher.velocity_avg ? p.pitcher.velocity_avg.toFixed(0) : '—'})
              </option>
            ))}
          </select>
          <div className="mt-4 text-[10px] uppercase tracking-widest text-amber-300 font-bold">
            Available bullpen ({pitchers.length - (starterId ? 1 : 0)})
          </div>
          <div className="text-[10px] text-[#a8a8c8] mb-1">All non-starter pitchers are ready to come in.</div>
          <div className="max-h-60 overflow-y-auto bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded p-2">
            {pitchers
              .filter(p => p.id !== starterId)
              .sort((a, b) => playerOverall(b) - playerOverall(a))
              .map(p => (
                <div key={p.id} className="flex justify-between items-center text-[11px] py-0.5 text-[#e8e8e8]">
                  <span>{p.firstName} {p.lastName}</span>
                  <span className="text-[10px] text-[#a8a8c8] font-mono">
                    {p.pitcher.stuff}/{p.pitcher.control}/{p.pitcher.stamina} · OVR {playerOverall(p)}
                  </span>
                </div>
              ))}
          </div>
        </PixelCard>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <PixelButton onClick={onCancel} accent="#3a3a5e">Cancel</PixelButton>
        <PixelButton onClick={handleSave} disabled={!canSave}>
          Save lineup
        </PixelButton>
      </div>
    </div>
    </GMShell>
  )
}

/**
 * Build initial 9-slot batting lineup from saved-state or default. Each slot
 * has { playerId, position }. If saved data lacks per-slot positions
 * (older saves), fall back to the player's primaryPosition.
 */
function initialSlots(saved, def, allPlayers, eligiblePlayers) {
  if (saved && saved.batters && saved.batters.length === 9) {
    return saved.batters.map((pid, i) => {
      const player = allPlayers[pid]
      const pos = saved.batterPositions?.[i] || player?.primaryPosition || 'DH'
      return { playerId: pid, position: pos }
    })
  }
  // From default lineup — populate positions from each batter's primaryPosition.
  // Then dedupe so every field position is unique. Duplicate slots become DH.
  const used = new Set()
  return (def.batters || []).slice(0, 9).map((b, i) => {
    let pos = b.primaryPosition || 'DH'
    if (pos !== 'DH' && used.has(pos)) pos = 'DH'
    if (pos !== 'DH') used.add(pos)
    return { playerId: b.id, position: pos }
  })
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
  const [subMenuOpen, setSubMenuOpen] = useState(null)   // 'PITCH'|'HIT'|'RUN'|'FIELD'|null

  function doStep() { live.step(); rerender() }
  function doHalfInning() { live.simHalfInning(); rerender() }
  function doRest() { live.simRest(); rerender() }
  function handleSubmitSub(kind, payload) {
    if (kind === 'PITCH') live.pitchingChange(payload.player)
    if (kind === 'HIT')   live.pinchHit(payload.side, payload.spotIdx, payload.player)
    if (kind === 'RUN')   live.pinchRun(payload.side, payload.baseIdx, payload.player)
    if (kind === 'FIELD') live.defensiveSub(payload.side, payload.position, payload.player)
    setSubMenuOpen(null)
    rerender()
  }
  function handleFinish() {
    if (!live.isOver()) live.simRest()
    onExit(live.getResult())
  }

  const s = live.state
  const userIsBatting = (s.top && !isHome) || (!s.top && isHome)
  const userIsPitching = !userIsBatting
  const userSide = isHome ? 'home' : 'away'

  const homeName = isHome ? userSchool?.name : (oppSchool?.name || 'Opponent')
  const awayName = isHome ? (oppSchool?.name || 'Opponent') : userSchool?.name

  // Current batter / pitcher refs
  const batter = live.currentBatter()
  const pitcher = live.currentPitcher()
  const batterToday = batter ? live.batterTodayLine(batter.id) : null
  // On-deck and in-the-hole
  const battingSide = s.top ? 'away' : 'home'
  const battingLineup = s.top ? s.awayBatters : s.homeBatters
  const battingIdx = s.top ? s.awayPAIndex : s.homePAIndex
  const onDeck = battingLineup[(battingIdx + 1) % 9]
  const inTheHole = battingLineup[(battingIdx + 2) % 9]

  // User-side data for the bottom panel
  const userBatters = isHome ? s.homeBatters : s.awayBatters
  const userFielders = isHome ? s.homeFielders : s.awayFielders
  const userPitcher = isHome ? s.homePitcher : s.awayPitcher
  const userPitcherLine = isHome ? s.homePitcherLine : s.awayPitcherLine
  const userFatigue = isHome ? s.homeFatigue : s.awayFatigue
  const userConfidence = isHome ? s.homeConfidence : s.awayConfidence
  const userPitches = isHome ? s.homePitches : s.awayPitches

  return (
    <div className="max-w-6xl mx-auto py-4 px-3">
      <div className="flex justify-between items-start mb-3">
        <div>
          <div className="text-xs text-gray-500">Live Game</div>
          <div className="text-xl font-bold text-pnw-slate">{awayName} @ {homeName}</div>
          <div className="text-[11px] text-gray-500">{game.type === 'FALL_SCRIMMAGE' ? 'Fall Scrimmage' : game.type === 'CONFERENCE' ? 'Conference' : 'Non-conference'} · {game.date}</div>
        </div>
        <button onClick={handleFinish} className="px-3 py-1.5 bg-pnw-slate text-white rounded text-xs font-semibold">
          {live.isOver() ? 'Save & exit' : 'Auto-finish & exit'}
        </button>
      </div>

      {/* SCOREBOARD — broadcast style with linescore by inning */}
      <Scoreboard state={s} homeName={homeName} awayName={awayName} />

      {/* CONTROL BAR — advance + subs (pinned high, right under scoreboard) */}
      {!s.isOver && (
        <div className="bg-white rounded-xl border border-gray-200 p-3 mb-3 flex flex-wrap items-center gap-2">
          <div className="flex gap-2 flex-1 flex-wrap">
            <button onClick={doStep} className="px-3 py-1.5 bg-pnw-green text-white rounded text-xs font-semibold">Next batter →</button>
            <button onClick={doHalfInning} className="px-3 py-1.5 border border-pnw-green text-pnw-green rounded text-xs font-semibold">Finish inning</button>
            <button onClick={doRest} className="px-3 py-1.5 border rounded text-xs">Sim to end</button>
          </div>
          <div className="flex gap-1 flex-wrap">
            <span className="text-[10px] text-gray-500 self-center uppercase tracking-wider mr-1">Subs:</span>
            {userIsPitching && (
              <button onClick={() => setSubMenuOpen('PITCH')} className="px-2.5 py-1 border border-amber-400 text-amber-700 rounded text-[11px] font-semibold hover:bg-amber-50">
                Pitching
              </button>
            )}
            {userIsBatting && (
              <button onClick={() => setSubMenuOpen('HIT')} className="px-2.5 py-1 border border-blue-400 text-blue-700 rounded text-[11px] font-semibold hover:bg-blue-50">
                Pinch hitter
              </button>
            )}
            {userIsBatting && s.bases.some(b => b) && (
              <button onClick={() => setSubMenuOpen('RUN')} className="px-2.5 py-1 border border-purple-400 text-purple-700 rounded text-[11px] font-semibold hover:bg-purple-50">
                Pinch runner
              </button>
            )}
            <button onClick={() => setSubMenuOpen('FIELD')} className="px-2.5 py-1 border border-gray-400 text-gray-700 rounded text-[11px] font-semibold hover:bg-gray-50">
              Defensive sub
            </button>
          </div>
        </div>
      )}

      {/* PLAY-BY-PLAY — pinned high so the latest action is always above the
          fold. Scrollable list, newest first. */}
      <div className="bg-white rounded-xl border border-gray-200 p-3 mb-3 max-h-[35vh] overflow-y-auto">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Play-by-play</h2>
        <div className="space-y-1">
          {[...s.events].reverse().map((ev, i) => (
            <EventLine key={s.events.length - 1 - i} ev={ev} />
          ))}
        </div>
      </div>

      {/* MATCHUP — current batter + pitcher, with rich detail */}
      {!s.isOver && batter && pitcher && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <BatterCard batter={batter} todayLine={batterToday} onDeck={onDeck} inTheHole={inTheHole} side={battingSide} />
          <PitcherCard
            pitcher={pitcher}
            line={s.top ? s.homePitcherLine : s.awayPitcherLine}
            pitches={s.top ? s.homePitches : s.awayPitches}
            fatigue={s.top ? s.homeFatigue : s.awayFatigue}
            confidence={s.top ? s.homeConfidence : s.awayConfidence}
            bf={s.top ? s.homePitcherBF : s.awayPitcherBF}
          />
        </div>
      )}

      {/* Sub menu modal */}
      {subMenuOpen && (
        <SubMenu
          kind={subMenuOpen}
          live={live}
          save={save}
          userSide={userSide}
          onSubmit={handleSubmitSub}
          onClose={() => setSubMenuOpen(null)}
        />
      )}

      {/* USER FIELD VIEW — show your defenders + lineup live */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        <UserFieldDiagram fielders={userFielders} pitcher={userPitcher} bases={s.bases} userIsPitching={userIsPitching} />
        <UserLineupCard
          batters={userBatters}
          live={live}
          isUserBatting={userIsBatting}
          battingIdx={battingIdx}
          userSchool={userSchool}
        />
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

// ─── Live-game UI components ────────────────────────────────────────────────

function Scoreboard({ state: s, homeName, awayName }) {
  const innings = Math.max(s.linescore.away.length, s.linescore.home.length, s.inning, 9)
  const inningCols = []
  for (let i = 1; i <= Math.max(9, innings); i++) inningCols.push(i)
  return (
    <div className="bg-pnw-slate text-white rounded-xl p-3 mb-3 shadow-lg">
      {/* Top strip: team rows with linescore + R/H/E + current count */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider opacity-60">
              <th className="text-left pl-2 w-[120px]">Team</th>
              {inningCols.map(i => <th key={i} className="text-center w-6 font-mono">{i}</th>)}
              <th className="text-center w-8 font-bold border-l border-white/20">R</th>
              <th className="text-center w-8 font-bold">H</th>
              <th className="text-center w-8 font-bold">E</th>
            </tr>
          </thead>
          <tbody>
            <ScoreboardRow name={awayName} linescore={s.linescore.away} runs={s.awayRuns} hits={s.awayHits} errors={s.awayErrors} inningCols={inningCols} isBatting={s.top && !s.isOver} />
            <ScoreboardRow name={homeName} linescore={s.linescore.home} runs={s.homeRuns} hits={s.homeHits} errors={s.homeErrors} inningCols={inningCols} isBatting={!s.top && !s.isOver} />
          </tbody>
        </table>
      </div>
      {/* Bottom strip: current inning state */}
      <div className="mt-2 flex items-center justify-between border-t border-white/15 pt-2">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider opacity-60">Status</div>
            <div className="text-base font-bold">
              {s.isOver ? 'FINAL' : `${s.top ? 'Top' : 'Bot'} ${s.inning}`}
            </div>
          </div>
          {!s.isOver && (
            <>
              <div>
                <div className="text-[10px] uppercase tracking-wider opacity-60">Outs</div>
                <div className="flex gap-1 mt-1">
                  {[0,1,2].map(i => (
                    <span key={i} className={'inline-block w-2.5 h-2.5 rounded-full ' + (i < s.outs ? 'bg-red-400' : 'bg-white/15')} />
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider opacity-60">Bases</div>
                <BaseDiagram bases={s.bases} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ScoreboardRow({ name, linescore, runs, hits, errors, inningCols, isBatting }) {
  return (
    <tr className={'border-t border-white/10 ' + (isBatting ? 'bg-white/5' : '')}>
      <td className="py-1.5 pl-2 font-semibold truncate max-w-[120px]">
        {isBatting && <span className="text-amber-300 mr-1">▶</span>}
        {name}
      </td>
      {inningCols.map(i => {
        const idx = i - 1
        const val = linescore[idx]
        return (
          <td key={i} className="text-center font-mono text-sm">
            {val == null ? <span className="opacity-30">·</span> : val}
          </td>
        )
      })}
      <td className="text-center font-bold text-xl font-mono border-l border-white/20">{runs}</td>
      <td className="text-center font-mono">{hits}</td>
      <td className="text-center font-mono">{errors}</td>
    </tr>
  )
}

function BatterCard({ batter, todayLine, onDeck, inTheHole, side }) {
  const c = todayLine || { ab: 0, h: 0, d: 0, t: 0, hr: 0, rbi: 0, bb: 0, k: 0 }
  const ab = c.ab || 0
  const h = c.h || 0
  const summary = ab === 0 && (c.bb || 0) === 0
    ? 'First AB'
    : `${h}-for-${ab}${c.hr ? `, ${c.hr} HR` : ''}${c.bb ? `, ${c.bb} BB` : ''}${c.k ? `, ${c.k} K` : ''}`
  const contactL = batter?.hitter?.contact_l ?? 50
  const contactR = batter?.hitter?.contact_r ?? 50
  const powerL = batter?.hitter?.power_l ?? 50
  const powerR = batter?.hitter?.power_r ?? 50
  return (
    <div className="bg-white rounded-xl border-2 border-blue-400/40 p-3 shadow-sm">
      <div className="flex justify-between items-start">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-blue-700 font-bold">At the plate</div>
          <div className="text-lg font-bold text-pnw-slate leading-tight">
            {nm(batter)}
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            {batter?.primaryPosition} · {batter?.bats}HB · {batter?.classYear}
          </div>
        </div>
        <div className="text-right text-[11px]">
          <div className="text-gray-400 uppercase tracking-wider text-[9px]">Today</div>
          <div className="font-mono font-semibold text-pnw-slate">{summary}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1 text-[10px] text-center">
        <div className="bg-gray-50 rounded p-1"><div className="text-gray-400">Con vL</div><div className="font-mono font-semibold">{contactL}</div></div>
        <div className="bg-gray-50 rounded p-1"><div className="text-gray-400">Con vR</div><div className="font-mono font-semibold">{contactR}</div></div>
        <div className="bg-gray-50 rounded p-1"><div className="text-gray-400">Pow vL</div><div className="font-mono font-semibold">{powerL}</div></div>
        <div className="bg-gray-50 rounded p-1"><div className="text-gray-400">Pow vR</div><div className="font-mono font-semibold">{powerR}</div></div>
      </div>
      <div className="mt-2 text-[10px] text-gray-500 border-t pt-2 flex gap-3">
        <span><strong>On deck:</strong> {nm(onDeck)}</span>
        <span><strong>In the hole:</strong> {nm(inTheHole)}</span>
      </div>
    </div>
  )
}

function PitcherCard({ pitcher, line, pitches, fatigue, confidence, bf }) {
  const ip = Math.floor((line?.outs || 0) / 3) + '.' + ((line?.outs || 0) % 3)
  const era = (line?.outs || 0) > 0 ? (line.er * 9 / (line.outs / 3)).toFixed(2) : '—'
  const fatiguePct = Math.min(100, fatigue)
  const fatigueLabel = fatigue < 25 ? 'Fresh' : fatigue < 50 ? 'OK' : fatigue < 75 ? 'Tiring' : 'Gassed'
  const fatigueColor = fatigue < 25 ? 'bg-emerald-500' : fatigue < 50 ? 'bg-lime-500' : fatigue < 75 ? 'bg-amber-500' : 'bg-red-500'
  const confidenceColor = confidence >= 65 ? 'text-emerald-600' : confidence >= 45 ? 'text-pnw-slate' : 'text-red-600'
  return (
    <div className="bg-white rounded-xl border-2 border-amber-400/40 p-3 shadow-sm">
      <div className="flex justify-between items-start">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-amber-700 font-bold">On the mound</div>
          <div className="text-lg font-bold text-pnw-slate leading-tight">{nm(pitcher)}</div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            {pitcher?.throws}HP · {pitcher?.classYear} · {pitcher?.measurables?.fbVeloMph ? `${pitcher.measurables.fbVeloMinMph}-${pitcher.measurables.fbVeloMaxMph} mph` : ''}
          </div>
        </div>
        <div className="text-right text-[11px]">
          <div className="text-gray-400 uppercase tracking-wider text-[9px]">Today</div>
          <div className="font-mono font-semibold text-pnw-slate">
            {ip} IP, {line?.h || 0}H {line?.er || 0}ER {line?.k || 0}K {line?.bb || 0}BB
          </div>
        </div>
      </div>
      {/* Pitch count + fatigue + confidence row */}
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        <div className="bg-gray-50 rounded p-1.5">
          <div className="text-[9px] uppercase tracking-wider text-gray-400">Pitch count</div>
          <div className="text-base font-bold font-mono">{pitches}</div>
        </div>
        <div className="bg-gray-50 rounded p-1.5">
          <div className="text-[9px] uppercase tracking-wider text-gray-400">Fatigue</div>
          <div className="h-2.5 bg-gray-200 rounded-full mt-1 overflow-hidden">
            <div className={'h-full ' + fatigueColor} style={{ width: `${fatiguePct}%` }} />
          </div>
          <div className="text-[10px] text-gray-600 mt-0.5">{fatigueLabel} · {Math.round(fatigue)}</div>
        </div>
        <div className="bg-gray-50 rounded p-1.5">
          <div className="text-[9px] uppercase tracking-wider text-gray-400">Confidence</div>
          <div className={'text-base font-bold font-mono ' + confidenceColor}>{Math.round(confidence)}</div>
          <div className="text-[10px] text-gray-500">{confidence >= 65 ? 'Locked in' : confidence >= 45 ? 'Steady' : 'Shaky'}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1 text-[10px] text-center">
        <div className="bg-gray-50 rounded p-1"><div className="text-gray-400">Stuff</div><div className="font-mono font-semibold">{pitcher?.pitcher?.stuff ?? '—'}</div></div>
        <div className="bg-gray-50 rounded p-1"><div className="text-gray-400">Ctrl</div><div className="font-mono font-semibold">{pitcher?.pitcher?.control ?? '—'}</div></div>
        <div className="bg-gray-50 rounded p-1"><div className="text-gray-400">Cmd</div><div className="font-mono font-semibold">{pitcher?.pitcher?.command ?? '—'}</div></div>
        <div className="bg-gray-50 rounded p-1"><div className="text-gray-400">Stam</div><div className="font-mono font-semibold">{pitcher?.pitcher?.stamina ?? '—'}</div></div>
      </div>
    </div>
  )
}

function UserFieldDiagram({ fielders, pitcher, bases, userIsPitching }) {
  // Coordinates (% within container) — slightly tweaked from DepthChart
  const FIELD_POS = {
    CF: { top: 12, left: 50 },
    LF: { top: 25, left: 18 },
    RF: { top: 25, left: 82 },
    SS: { top: 45, left: 36 },
    '2B': { top: 45, left: 64 },
    '3B': { top: 62, left: 20 },
    '1B': { top: 62, left: 80 },
    P:  { top: 62, left: 50 },
    C:  { top: 88, left: 50 },
  }
  return (
    <div className="bg-gradient-to-b from-green-700 to-green-900 rounded-xl shadow-md relative overflow-hidden" style={{ aspectRatio: '4/3', minHeight: 260 }}>
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d="M 8 70 Q 50 -5 92 70" fill="rgba(160, 110, 75, 0.18)" stroke="rgba(255,255,255,0.2)" strokeWidth="0.3" />
        <polygon points="50,50 64,62 50,75 36,62" fill="rgba(160, 110, 75, 0.45)" stroke="rgba(255,255,255,0.5)" strokeWidth="0.4" />
        <circle cx="50" cy="62" r="2" fill="rgba(160, 110, 75, 0.7)" />
      </svg>
      {/* Title */}
      <div className="absolute top-2 left-2 right-2 flex justify-between text-[10px] uppercase tracking-wider text-white/80 font-semibold z-10">
        <span>Defense {userIsPitching ? '(on field)' : '(while batting)'}</span>
        <span className="opacity-75">{bases.some(b => b) ? 'Runners on' : 'Bases empty'}</span>
      </div>
      {['CF','LF','RF','SS','2B','3B','1B','P','C'].map(pos => {
        const f = pos === 'P' ? pitcher : fielders[pos]
        const coord = FIELD_POS[pos]
        if (!coord) return null
        return (
          <div
            key={pos}
            className="absolute text-center"
            style={{ top: `${coord.top}%`, left: `${coord.left}%`, transform: 'translate(-50%, -50%)' }}
          >
            <div className="bg-white/95 rounded shadow text-[10px] leading-tight px-1.5 py-0.5 min-w-[60px]">
              <div className="text-pnw-slate font-bold">{pos}</div>
              <div className="text-gray-700 text-[9px] truncate max-w-[80px]">
                {f ? `${f.firstName?.[0] || ''}. ${f.lastName || '?'}` : '—'}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function UserLineupCard({ batters, live, isUserBatting, battingIdx, userSchool }) {
  const accent = userSchool?.colors?.[0] || '#fbbf24'
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider" style={{ backgroundColor: accent, color: '#1a1a2e' }}>
        Your Lineup
      </div>
      <table className="w-full text-xs">
        <thead className="bg-gray-50 text-[9px] uppercase text-gray-500">
          <tr>
            <th className="text-left py-1 pl-2 w-6">#</th>
            <th className="text-left">Player</th>
            <th className="text-center w-6">Pos</th>
            <th className="text-center w-8">AB</th>
            <th className="text-center w-8">H</th>
            <th className="text-center w-8">RBI</th>
            <th className="text-center w-8">K</th>
          </tr>
        </thead>
        <tbody>
          {batters.map((b, i) => {
            const today = live.batterTodayLine(b.id)
            const isUp = isUserBatting && (battingIdx % 9) === i
            return (
              <tr key={b.id} className={'border-t ' + (isUp ? 'bg-blue-50 font-semibold' : '')}>
                <td className="py-1 pl-2 text-gray-500">{i + 1}</td>
                <td>
                  {isUp && <span className="text-blue-600 mr-0.5">▶</span>}
                  {b.firstName} {b.lastName}
                </td>
                <td className="text-center text-gray-500">{b.primaryPosition}</td>
                <td className="text-center font-mono">{today.ab || 0}</td>
                <td className="text-center font-mono">{today.h || 0}</td>
                <td className="text-center font-mono">{today.rbi || 0}</td>
                <td className="text-center font-mono">{today.k || 0}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SubMenu({ kind, live, save, userSide, onSubmit, onClose }) {
  const state = live.state
  const bench = userSide === 'home' ? state.homeBench : state.awayBench
  const bullpen = userSide === 'home' ? state.homeBullpen : state.awayBullpen
  const batters = userSide === 'home' ? state.homeBatters : state.awayBatters
  const fielders = userSide === 'home' ? state.homeFielders : state.awayFielders

  if (kind === 'PITCH') {
    return (
      <SubModal title="Pitching change" onClose={onClose}>
        {bullpen.length === 0 ? (
          <div className="text-sm text-gray-500">No pitchers left in the bullpen.</div>
        ) : (
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {bullpen.map(p => (
              <button
                key={p.id}
                onClick={() => onSubmit('PITCH', { player: p })}
                className="w-full text-left p-2 hover:bg-pnw-cream rounded text-sm flex justify-between items-center"
              >
                <span className="font-medium">{p.firstName} {p.lastName}</span>
                <span className="text-[11px] text-gray-500 font-mono">
                  Stuff {p.pitcher?.stuff} · Stam {p.pitcher?.stamina} · Velo {p.measurables?.fbVeloMph || '—'}
                </span>
              </button>
            ))}
          </div>
        )}
      </SubModal>
    )
  }

  if (kind === 'HIT') {
    // Pick which lineup spot to pinch-hit FOR, then pick the player
    return (
      <SubModal title="Pinch hitter" onClose={onClose}>
        <div className="text-xs text-gray-500 mb-2">Pick a lineup spot — the on-deck or in-the-hole batter is usually the safest swap. The current AB-in-progress can't be swapped mid-PA.</div>
        <PickPlayerForSpot batters={batters} bench={bench} onPick={(spotIdx, player) => onSubmit('HIT', { side: userSide, spotIdx, player })} />
      </SubModal>
    )
  }

  if (kind === 'RUN') {
    const baseNames = ['1B', '2B', '3B']
    return (
      <SubModal title="Pinch runner" onClose={onClose}>
        <div className="text-xs text-gray-500 mb-2">Pick a base + a bench player to swap in. Pinch runner takes over the lineup spot.</div>
        {state.bases.every(b => !b) && <div className="text-sm text-gray-500">No runners on base.</div>}
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {state.bases.map((runner, i) => {
            if (!runner) return null
            return (
              <div key={i} className="border rounded p-2">
                <div className="text-[11px] uppercase tracking-wider text-gray-500 font-bold mb-1">
                  {baseNames[i]} — {runner.firstName} {runner.lastName}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {bench.map(p => (
                    <button
                      key={p.id}
                      onClick={() => onSubmit('RUN', { side: userSide, baseIdx: i, player: p })}
                      className="text-left p-1.5 hover:bg-purple-50 rounded text-xs flex justify-between"
                    >
                      <span>{p.firstName} {p.lastName}</span>
                      <span className="text-gray-500 font-mono">SPD {p.hitter?.speed ?? '—'}</span>
                    </button>
                  ))}
                </div>
                {bench.length === 0 && <div className="text-xs text-gray-400 italic">Bench is empty.</div>}
              </div>
            )
          })}
        </div>
      </SubModal>
    )
  }

  if (kind === 'FIELD') {
    return (
      <SubModal title="Defensive substitution" onClose={onClose}>
        <div className="text-xs text-gray-500 mb-2">Pick a position to upgrade. The previous fielder moves to the bench; the new player joins the lineup at the same batting spot.</div>
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'].map(pos => {
            const f = fielders[pos]
            return (
              <div key={pos} className="border rounded p-2">
                <div className="text-[11px] uppercase tracking-wider text-gray-500 font-bold mb-1">
                  {pos} — currently {f ? `${f.firstName} ${f.lastName}` : 'empty'}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {bench.map(p => (
                    <button
                      key={p.id}
                      onClick={() => onSubmit('FIELD', { side: userSide, position: pos, player: p })}
                      className="text-left p-1.5 hover:bg-gray-100 rounded text-xs flex justify-between"
                    >
                      <span>{p.firstName} {p.lastName}</span>
                      <span className="text-gray-500 font-mono">FLD {p.hitter?.fielding ?? '—'}/ARM {p.hitter?.arm ?? '—'}</span>
                    </button>
                  ))}
                </div>
                {bench.length === 0 && <div className="text-xs text-gray-400 italic">Bench is empty.</div>}
              </div>
            )
          })}
        </div>
      </SubModal>
    )
  }
  return null
}

function PickPlayerForSpot({ batters, bench, onPick }) {
  const [spotIdx, setSpotIdx] = useState(null)
  if (spotIdx == null) {
    return (
      <div className="space-y-1 max-h-80 overflow-y-auto">
        {batters.map((b, i) => (
          <button
            key={b.id + '_' + i}
            onClick={() => setSpotIdx(i)}
            className="w-full text-left p-2 hover:bg-blue-50 rounded text-sm flex justify-between"
          >
            <span><span className="text-gray-500 mr-2">#{i + 1}</span>{b.firstName} {b.lastName}</span>
            <span className="text-[11px] text-gray-500">{b.primaryPosition}</span>
          </button>
        ))}
      </div>
    )
  }
  if (bench.length === 0) {
    return <div className="text-sm text-gray-500">Bench is empty — no pinch hitters available.</div>
  }
  return (
    <div>
      <div className="text-[11px] text-gray-500 mb-2">Choose a pinch hitter for #{spotIdx + 1} {batters[spotIdx].lastName}:</div>
      <div className="grid grid-cols-1 gap-1 max-h-72 overflow-y-auto">
        {bench.map(p => (
          <button
            key={p.id}
            onClick={() => onPick(spotIdx, p)}
            className="text-left p-1.5 hover:bg-blue-50 rounded text-xs flex justify-between"
          >
            <span>{p.firstName} {p.lastName}</span>
            <span className="text-gray-500 font-mono">
              C {p.hitter?.contact_r ?? '—'}/P {p.hitter?.power_r ?? '—'} · {p.bats}HB
            </span>
          </button>
        ))}
      </div>
      <button
        onClick={() => setSpotIdx(null)}
        className="mt-2 text-xs text-gray-500 hover:underline"
      >← Pick a different spot</button>
    </div>
  )
}

function SubModal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl p-4 max-w-xl w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// Synthetic opponent (non-NAIA) — generates real-looking players for non-NAIA
// opponents (D1/D2/D3 / NWAC schools) so the live-game UI shows actual names
// and varied ratings instead of identical "OppBatter1, OppBatter2..." placeholders.
function makeSyntheticLineup(school, strength) {
  // strength is roughly -3..+10; map to a ratings MEAN. Each player gets
  // gaussian noise around it so they're all different.
  const ratingMean = 50 + strength * 2
  // Deterministic per-school seed so the same opponent looks the same
  // across page loads (no headshot-flicker between visits).
  const seedKey = school?.id || 'synthOpp'
  const seedNum = stableHash(seedKey)
  let rngIdx = 0
  function nextRand() {
    // Cheap linear-congruential — not crypto, just enough variety
    rngIdx++
    const x = Math.sin(seedNum + rngIdx) * 10000
    return x - Math.floor(x)
  }
  function gauss(mean, std) {
    // Box-Muller
    const u = Math.max(1e-6, nextRand())
    const v = nextRand()
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
  function name() {
    const fn = SYNTH_FIRST_NAMES[Math.floor(nextRand() * SYNTH_FIRST_NAMES.length)]
    const ln = SYNTH_LAST_NAMES[Math.floor(nextRand() * SYNTH_LAST_NAMES.length)]
    return { firstName: fn, lastName: ln }
  }
  function pickClass() {
    const r = nextRand()
    if (r < 0.20) return 'FR'
    if (r < 0.55) return 'SO'
    if (r < 0.85) return 'JR'
    return 'SR'
  }
  function fakeHitter(i, position) {
    const { firstName, lastName } = name()
    return {
      id: `synth_${seedKey}_h${i}`,
      firstName, lastName,
      bats: nextRand() < 0.28 ? 'L' : (nextRand() < 0.05 ? 'S' : 'R'),
      throws: nextRand() < 0.20 ? 'L' : 'R',
      primaryPosition: position,
      isHitter: true, isPitcher: false,
      hitter: {
        contact_l: Math.round(clamp(gauss(ratingMean, 9), 25, 99)),
        contact_r: Math.round(clamp(gauss(ratingMean, 9), 25, 99)),
        power_l:   Math.round(clamp(gauss(ratingMean - 2, 10), 25, 99)),
        power_r:   Math.round(clamp(gauss(ratingMean - 2, 10), 25, 99)),
        discipline: Math.round(clamp(gauss(ratingMean, 8), 25, 99)),
        speed:     Math.round(clamp(gauss(ratingMean, 10), 25, 99)),
        fielding:  Math.round(clamp(gauss(ratingMean, 9), 25, 99)),
        arm:       Math.round(clamp(gauss(ratingMean, 10), 25, 99)),
        composure: Math.round(clamp(gauss(ratingMean, 8), 25, 99)),
        durability: Math.round(clamp(gauss(ratingMean, 8), 25, 99)),
      },
      classYear: pickClass(),
    }
  }
  function fakePitcher(i, isStarter) {
    const { firstName, lastName } = name()
    const stuffMean = isStarter ? ratingMean + 4 : ratingMean
    const velo = Math.round(clamp(gauss(85 + strength * 0.5, 2), 75, 99) * 10) / 10
    return {
      id: `synth_${seedKey}_p${i}`,
      firstName, lastName,
      bats: 'R', throws: nextRand() < 0.30 ? 'L' : 'R',
      primaryPosition: 'P',
      isHitter: false, isPitcher: true,
      pitcher: {
        stuff: Math.round(clamp(gauss(stuffMean, 10), 25, 99)),
        control: Math.round(clamp(gauss(ratingMean, 9), 25, 99)),
        command: Math.round(clamp(gauss(ratingMean, 9), 25, 99)),
        stamina: Math.round(clamp(gauss(ratingMean + 5, 8), 25, 99)),
        vs_l: Math.round(clamp(gauss(ratingMean, 10), 25, 99)),
        vs_r: Math.round(clamp(gauss(ratingMean, 10), 25, 99)),
        composure: Math.round(clamp(gauss(ratingMean, 8), 25, 99)),
        durability: Math.round(clamp(gauss(ratingMean, 8), 25, 99)),
        velocity_avg: velo,
        velocity_min: Math.round((velo - 2) * 10) / 10,
        velocity_max: Math.round((velo + 2) * 10) / 10,
      },
      classYear: pickClass(),
    }
  }
  const positions = ['C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF', 'DH']
  return {
    batters: positions.map((pos, i) => fakeHitter(i, pos)),
    pitcherRotation: Array.from({ length: 5 }, (_, i) => fakePitcher(i, i === 0)),
    bench: [],
  }
}

function stableHash(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0
  return Math.abs(h)
}

// Tiny pool of plausible college-baseball names — used only for non-NAIA
// opponents (D1/D2/D3/NWAC) where we don't generate real player records.
const SYNTH_FIRST_NAMES = [
  'Alex', 'Andrew', 'Anthony', 'Austin', 'Ben', 'Blake', 'Brady', 'Brendan',
  'Caleb', 'Cameron', 'Carter', 'Chase', 'Chris', 'Cody', 'Connor', 'Cooper',
  'Cole', 'Dalton', 'Daniel', 'David', 'Derek', 'Dominic', 'Dylan', 'Eli',
  'Elijah', 'Ethan', 'Evan', 'Garrett', 'Gavin', 'Hayden', 'Hunter', 'Isaac',
  'Jack', 'Jackson', 'Jacob', 'Jake', 'James', 'Jared', 'Jason', 'Jaxon',
  'Joey', 'Jordan', 'Joshua', 'Josiah', 'Justin', 'Kade', 'Kaiden', 'Kobe',
  'Kyle', 'Landon', 'Logan', 'Lucas', 'Luke', 'Mason', 'Matt', 'Max',
  'Michael', 'Nathan', 'Nick', 'Noah', 'Owen', 'Parker', 'Peyton', 'Preston',
  'Reese', 'Ryan', 'Sam', 'Sean', 'Seth', 'Shane', 'Spencer', 'Tanner',
  'Tate', 'Trevor', 'Tyler', 'Wyatt', 'Xavier', 'Zach', 'Brock', 'Trey',
]
const SYNTH_LAST_NAMES = [
  'Adams', 'Allen', 'Anderson', 'Bailey', 'Baker', 'Barnes', 'Bell', 'Bennett',
  'Brown', 'Bryant', 'Campbell', 'Carter', 'Clark', 'Cole', 'Collins', 'Cook',
  'Cooper', 'Cox', 'Davis', 'Edwards', 'Evans', 'Fisher', 'Foster', 'Garcia',
  'Gonzalez', 'Gray', 'Green', 'Hall', 'Hamilton', 'Harris', 'Hayes', 'Henderson',
  'Hill', 'Howard', 'Hughes', 'Jackson', 'Johnson', 'Jones', 'Kelly', 'King',
  'Lee', 'Lewis', 'Long', 'Martin', 'Martinez', 'Miller', 'Mitchell', 'Moore',
  'Morgan', 'Murphy', 'Nelson', 'Owens', 'Parker', 'Patterson', 'Perez', 'Perry',
  'Peterson', 'Phillips', 'Powell', 'Reed', 'Reyes', 'Rivera', 'Roberts', 'Robinson',
  'Rodriguez', 'Rogers', 'Russell', 'Sanchez', 'Sanders', 'Scott', 'Smith', 'Stewart',
  'Sullivan', 'Taylor', 'Thomas', 'Thompson', 'Torres', 'Turner', 'Walker', 'Ward',
  'Watson', 'White', 'Williams', 'Wilson', 'Wood', 'Wright', 'Young', 'Bishop',
]

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
