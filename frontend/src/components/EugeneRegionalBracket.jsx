import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  TOURNAMENTS,
  fetchTournamentGames,
  resolveBracket,
  shortLabelForRef,
} from '../lib/brackets'

// ════════════════════════════════════════════════════════════════
// NCAA EUGENE REGIONAL — interactive homepage bracket
//
// Four-team double elimination at PK Park (Oregon), May 29 to June 1.
// Three of the four teams are PNW D1 programs, so this sits at the top
// of every tier homepage during regional weekend. Pulls live scores
// from /api/v1/games/by-date via the shared resolveBracket helper;
// PNW-vs-PNW games fill in automatically as they go final. Self-hides
// after the regional wraps.
// ════════════════════════════════════════════════════════════════

const TOURNEY = TOURNAMENTS.eugene_regional_2026

// Stop rendering once the regional is over (the morning after the
// if-necessary Monday game). Keeps the widget from lingering stale.
const HIDE_AFTER = new Date('2026-06-02T12:00:00-07:00')

// Bracket columns, winners flowing left→right with the elimination
// (loser's) games stacked beneath each round.
const COLUMNS = [
  { key: 'r1', label: 'Round 1 · Fri', games: [1, 2] },
  { key: 'r2', label: 'Saturday',      games: [4, 3] },
  { key: 'r3', label: 'Sunday',        games: [6, 5] },
  { key: 'if', label: 'If Nec · Mon',  games: [7] },
]

// Logo lookup straight off the seed entries (no extra fetch needed).
const LOGO_BY_TEAM = {}
for (const s of TOURNEY.seeds) if (s.team_id) LOGO_BY_TEAM[s.team_id] = s.logo

function nameSizeClass(name) {
  const n = (name || '').length
  if (n <= 9) return 'text-[11px]'
  if (n <= 13) return 'text-[10px]'
  return 'text-[9px]'
}

export default function EugeneRegionalBracket() {
  const [outcomes, setOutcomes] = useState(null)
  const [hidden] = useState(() => new Date() > HIDE_AFTER)

  useEffect(() => {
    if (hidden) return
    let alive = true
    async function load() {
      try {
        const games = await fetchTournamentGames(TOURNEY)
        if (alive) setOutcomes(resolveBracket(TOURNEY, games))
      } catch {
        if (alive) setOutcomes(resolveBracket(TOURNEY, []))
      }
    }
    load()
    return () => { alive = false }
  }, [hidden])

  const seedMap = useMemo(() => {
    const m = {}
    for (const s of TOURNEY.seeds) m[s.seed] = s
    return m
  }, [])

  function teamForRef(ref) {
    const info = shortLabelForRef(ref, seedMap, outcomes, TOURNEY.seeds)
    const logo = info.team_id ? LOGO_BY_TEAM[info.team_id] : null
    return { ...info, logo }
  }

  const status = useMemo(() => {
    if (!outcomes) return { label: 'Loading…', tone: 'idle' }
    const finals = TOURNEY.games.filter((g) => outcomes.get(g.num)?.status === 'final')
    const g4w = outcomes.get(4)?.winner_id
    const g6 = outcomes.get(6)
    const g7 = outcomes.get(7)
    let champId = null
    if (g7?.winner_id != null) champId = g7.winner_id
    else if (g6?.status === 'final' && g6.winner_id != null && g6.winner_id === g4w) champId = g6.winner_id
    if (champId != null) {
      const champ = TOURNEY.seeds.find((s) => s.team_id === champId)
      return { label: `Regional Champion: ${champ?.name || 'TBD'}`, tone: 'champ' }
    }
    if (finals.length === 0) return { label: 'Starts Fri, May 29', tone: 'idle' }
    return { label: `In Progress · ${finals.length} of ${TOURNEY.games.length} final`, tone: 'live' }
  }, [outcomes])

  if (hidden) return null

  return (
    <div className="mb-5 rounded-2xl overflow-hidden shadow-lg border border-emerald-500/30 bg-gradient-to-br from-[#0f2a1a] via-[#123420] to-[#0a1f13]">
      {/* Banner */}
      <div className="px-4 sm:px-6 py-4 border-b border-white/10">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[2px] text-amber-300 bg-amber-400/15 px-2 py-0.5 rounded">
                NCAA Tournament
              </span>
              <span className="text-[10px] font-bold uppercase tracking-[2px] text-emerald-300">
                3 PNW teams
              </span>
            </div>
            <h2 className="text-lg sm:text-2xl font-extrabold tracking-tight text-white leading-none mt-1.5">
              EUGENE REGIONAL
            </h2>
            <p className="text-[11px] sm:text-xs text-emerald-200/90 mt-1 font-medium">
              May 29 to June 1 · PK Park, Eugene · four-team double elimination
            </p>
          </div>
          <StatusPill status={status} />
        </div>

        {/* Teams legend — seeds, records, PNW tags */}
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
          {TOURNEY.seeds.map((s) => (
            <div key={s.seed} className="flex items-center gap-2 rounded-lg bg-white/[0.05] border border-white/10 px-2.5 py-1.5">
              <span className="text-[10px] font-bold tabular-nums text-amber-300 w-3 shrink-0">{s.seed}</span>
              {s.logo ? (
                <img src={s.logo} alt="" className="w-5 h-5 object-contain shrink-0"
                  onError={(e) => { e.currentTarget.style.display = 'none' }} />
              ) : <span className="w-5 h-5 shrink-0" />}
              <span className="min-w-0">
                <span className="flex items-center gap-1">
                  <span className="text-xs font-bold text-white truncate">{s.name}</span>
                  {s.pnw && <span className="text-[8px] font-bold uppercase text-emerald-300 shrink-0">PNW</span>}
                </span>
                <span className="block text-[10px] text-white/55 tabular-nums leading-tight">{s.record}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Bracket */}
      <div className="overflow-x-auto scrollbar-hide px-3 sm:px-5 pt-3 pb-4">
        <div className="min-w-[640px] flex items-stretch gap-2 sm:gap-3">
          {COLUMNS.map((col) => (
            <div key={col.key} className="flex-1 min-w-[150px] flex flex-col">
              <div className="text-[8px] font-bold uppercase tracking-wider mb-1.5 text-center text-emerald-300/80">
                {col.label}
              </div>
              <div className="flex flex-col justify-around gap-2 flex-1">
                {col.games.map((num) => (
                  <GameCard key={num} gameNum={num} outcomes={outcomes} teamForRef={teamForRef} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 sm:px-6 py-2.5 border-t border-white/10 flex items-center justify-between">
        <span className="text-[11px] text-white/50">Scores update automatically as games go final</span>
        <Link to="/scoreboard" className="text-[11px] font-semibold text-emerald-300 hover:text-white transition-colors">
          Full scoreboard →
        </Link>
      </div>
    </div>
  )
}

function StatusPill({ status }) {
  const tones = {
    idle: 'bg-white/10 text-white/80',
    live: 'bg-red-500/90 text-white',
    champ: 'bg-amber-400 text-amber-950',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] sm:text-xs font-bold uppercase tracking-wider ${tones[status.tone] || tones.idle}`}>
      {status.tone === 'live' && <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
      {status.label}
    </span>
  )
}

function GameCard({ gameNum, outcomes, teamForRef }) {
  const g = TOURNEY.games.find((x) => x.num === gameNum)
  if (!g) return null
  const o = outcomes?.get(gameNum)
  const away = teamForRef(g.away)
  const home = teamForRef(g.home)
  const isFinal = o?.status === 'final' && o.home_score != null && o.away_score != null
  const isLive = o?.status === 'live' || o?.status === 'in_progress'
  const gold = TOURNEY.championshipGames?.includes(gameNum)

  const card = (
    <div className={`rounded-lg overflow-hidden border transition-all ${
      gold ? 'border-amber-400/60 bg-amber-400/5' : 'border-white/10 bg-white/[0.04]'
    } ${o?.db_game_id ? 'hover:border-emerald-400 hover:bg-white/[0.08] cursor-pointer' : ''}`}>
      <div className="flex items-center justify-between px-2 pt-1.5 pb-1">
        <span className="text-[8px] font-bold uppercase tracking-wider text-white/60">
          {gameNum === 6 ? 'Regional Final' : gameNum === 7 ? 'If Necessary' : `Game ${gameNum}`}
        </span>
        {isLive ? (
          <span className="text-[8px] font-bold text-red-400 animate-pulse">LIVE</span>
        ) : isFinal ? (
          <span className="text-[8px] font-bold text-white/60">FINAL</span>
        ) : (
          <span className="text-[8px] font-medium text-white/60">{g.time}</span>
        )}
      </div>
      <TeamRow team={away} score={o?.away_score} won={isFinal && o.winner_id === away.team_id} isFinal={isFinal} />
      <div className="h-px bg-white/10 mx-2" />
      <TeamRow team={home} score={o?.home_score} won={isFinal && o.winner_id === home.team_id} isFinal={isFinal} />
      {!isFinal && !isLive && (
        <div className="text-center text-[8px] text-white/55 pb-1 pt-0.5">{g.day}</div>
      )}
    </div>
  )

  if (o?.db_game_id) {
    return <Link to={`/game/${o.db_game_id}`} className="block">{card}</Link>
  }
  return card
}

function TeamRow({ team, score, won, isFinal }) {
  const dimmed = isFinal && !won
  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 ${won ? 'bg-amber-400/10' : ''}`}>
      {team.logo ? (
        <img src={team.logo} alt="" className={`w-4 h-4 object-contain shrink-0 ${dimmed ? 'opacity-40' : ''}`}
          onError={(e) => { e.currentTarget.style.display = 'none' }} />
      ) : <span className="w-4 h-4 shrink-0" />}
      <span className={`${nameSizeClass(team.name)} leading-tight flex-1 min-w-0 whitespace-nowrap overflow-hidden ${
        team.placeholder ? 'text-white/30 italic' : won ? 'font-bold text-white' : dimmed ? 'text-white/40' : 'font-semibold text-white'
      }`}>
        {team.name}
      </span>
      {score != null && (
        <span className={`text-[12px] font-mono tabular-nums shrink-0 ${
          won ? 'font-bold text-amber-300' : dimmed ? 'text-white/40' : 'text-white/90'
        }`}>
          {score}
        </span>
      )}
    </div>
  )
}
