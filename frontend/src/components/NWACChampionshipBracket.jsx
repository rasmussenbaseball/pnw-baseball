import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  TOURNAMENTS,
  fetchTournamentGames,
  resolveBracket,
  shortLabelForRef,
} from '../lib/brackets'

// ════════════════════════════════════════════════════════════════
// NWAC CHAMPIONSHIPS — interactive homepage bracket
//
// 8-team double elimination at Lower Columbia College, Longview WA.
// Pulls live scores from /api/v1/games/by-date via the shared
// resolveBracket helper, so as games go final the bracket fills in
// and winners flow forward automatically. Clicking a completed game
// opens its box score.
// ════════════════════════════════════════════════════════════════

const TOURNEY = TOURNAMENTS.nwac_championships_2026

// Converging layout: winners bracket flows left→center, losers bracket
// flows right→center, championship sits in the middle where they meet.
// One row of columns (instead of two stacked sections) keeps the whole
// thing short enough to see on one screen and fills the full width.
const COLUMNS = [
  { key: 'wb1',   label: 'WB Round 1', side: 'wb',    games: [1, 2, 3, 4] },
  { key: 'wb2',   label: 'WB Round 2', side: 'wb',    games: [7, 8] },
  { key: 'wbf',   label: 'WB Final',   side: 'wb',    games: [11] },
  { key: 'champ', label: 'Championship', side: 'champ', games: [14] },
  { key: 'lbf',   label: 'LB Final',   side: 'lb',    games: [13] },
  { key: 'lb3',   label: 'LB Elim 3',  side: 'lb',    games: [12] },
  { key: 'lb2',   label: 'LB Elim 2',  side: 'lb',    games: [9, 10] },
  { key: 'lb1',   label: 'LB Elim 1',  side: 'lb',    games: [5, 6] },
]
const CHAMP_GAME = 14
const IF_NEC_GAME = 15

export default function NWACChampionshipBracket() {
  const [outcomes, setOutcomes] = useState(null)
  const [logos, setLogos] = useState({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const [dbGames, teams] = await Promise.all([
          fetchTournamentGames(TOURNEY),
          fetch('/api/v1/teams').then((r) => (r.ok ? r.json() : [])),
        ])
        if (!alive) return
        setOutcomes(resolveBracket(TOURNEY, dbGames))
        const map = {}
        for (const t of teams || []) map[t.id] = { logo: t.logo_url, short: t.short_name }
        setLogos(map)
      } catch {
        /* network hiccup — keep last good state */
      } finally {
        if (alive) setLoaded(true)
      }
    }
    load()
    // Refresh every 2 minutes so scores update during championship week
    const iv = setInterval(load, 120000)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [])

  const seedMap = useMemo(() => {
    const m = {}
    for (const s of TOURNEY.seeds) m[s.seed] = s
    return m
  }, [])

  // Resolve a {home/away} ref to display info + logo
  function teamForRef(ref) {
    const info = shortLabelForRef(ref, seedMap, outcomes, TOURNEY.seeds)
    const logo = info.team_id ? logos[info.team_id]?.logo : null
    return { ...info, logo }
  }

  // ── Tournament status summary ──
  const status = useMemo(() => {
    if (!outcomes) return { label: 'Loading…', tone: 'idle' }
    const real = TOURNEY.games.filter((g) => !g.ifNecessary)
    const finals = real.filter((g) => outcomes.get(g.num)?.status === 'final')
    const champOutcome =
      outcomes.get(IF_NEC_GAME)?.winner_id != null
        ? outcomes.get(IF_NEC_GAME)
        : outcomes.get(CHAMP_GAME)
    if (champOutcome?.winner_id) {
      const champ = TOURNEY.seeds.find((s) => s.team_id === champOutcome.winner_id)
      return { label: `Champion: ${champ?.name || 'TBD'}`, tone: 'champ' }
    }
    if (finals.length === 0) {
      return { label: 'Starts Thursday, May 21', tone: 'idle' }
    }
    return { label: `In Progress · ${finals.length} of ${real.length} games final`, tone: 'live' }
  }, [outcomes])

  return (
    <div className="mb-3 rounded-2xl overflow-hidden shadow-lg border border-pnw-teal/30 bg-gradient-to-br from-[#04323d] via-[#062f3a] to-[#021b22]">
      {/* ── Banner ── */}
      <div className="relative px-4 sm:px-6 py-4 border-b border-white/10">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-3xl leading-none" aria-hidden>🏆</span>
            <div className="min-w-0">
              <h2 className="text-lg sm:text-2xl font-extrabold tracking-tight text-white leading-none">
                NWAC CHAMPIONSHIPS
              </h2>
              <p className="text-[11px] sm:text-xs text-pnw-teal/90 mt-1 font-medium">
                May 21 to 25, 2026 · Lower Columbia College, Longview WA · 8-team double elimination
              </p>
            </div>
          </div>
          <StatusPill status={status} />
        </div>
      </div>

      {/* ── Bracket body — converging layout, fills full width ── */}
      <div className="overflow-x-auto scrollbar-hide px-3 sm:px-5 pt-3 pb-4">
        <div className="min-w-[820px]">
          {/* Group labels: WINNERS (left) · CHAMPIONSHIP (center) · LOSERS (right) */}
          <div className="flex items-end mb-2">
            <div className="flex-[3] text-[10px] font-bold uppercase tracking-[0.15em] text-pnw-teal/80">
              Winners Bracket →
            </div>
            <div className="flex-1 text-center text-[10px] font-bold uppercase tracking-[0.15em] text-amber-300">
              Title
            </div>
            <div className="flex-[4] text-right text-[10px] font-bold uppercase tracking-[0.15em] text-rose-300/70">
              ← Losers Bracket (elimination)
            </div>
          </div>

          {/* Single converging row of columns */}
          <div className="flex items-stretch gap-2 sm:gap-3">
            {COLUMNS.map((col) => (
              <RoundColumn
                key={col.key}
                label={col.label}
                side={col.side}
                gold={col.side === 'champ'}
              >
                {col.games.map((num) => (
                  <GameCard
                    key={num}
                    gameNum={num}
                    outcomes={outcomes}
                    teamForRef={teamForRef}
                    championship={col.side === 'champ'}
                  />
                ))}
                {col.side === 'champ' && <IfNecessaryNote outcomes={outcomes} />}
              </RoundColumn>
            ))}
          </div>
        </div>
      </div>

      {/* ── Footer link ── */}
      <div className="px-4 sm:px-6 py-2.5 border-t border-white/10 flex items-center justify-between">
        <span className="text-[11px] text-white/50">
          Scores update automatically as games go final
        </span>
        <Link
          to="/scoreboard"
          className="text-[11px] font-semibold text-pnw-teal hover:text-white transition-colors"
        >
          Full scoreboard →
        </Link>
      </div>
    </div>
  )
}

// ── Status pill ──
function StatusPill({ status }) {
  const tones = {
    idle: 'bg-white/10 text-white/80',
    live: 'bg-red-500/90 text-white',
    champ: 'bg-amber-400 text-amber-950',
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] sm:text-xs font-bold uppercase tracking-wider ${tones[status.tone] || tones.idle}`}
    >
      {status.tone === 'live' && (
        <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
      )}
      {status.tone === 'champ' && <span aria-hidden>🏆</span>}
      {status.label}
    </span>
  )
}

// ── Round column wrapper ──
// flex-1 so the eight columns spread evenly across the full width.
// min-w keeps cards legible and triggers horizontal scroll on phones.
function RoundColumn({ label, children, side }) {
  const labelTone =
    side === 'champ' ? 'text-amber-300'
    : side === 'lb' ? 'text-rose-300/60'
    : 'text-pnw-teal/60'
  return (
    <div className="flex-1 min-w-[96px] flex flex-col">
      <div className={`text-[8px] font-bold uppercase tracking-wider mb-1.5 text-center ${labelTone}`}>
        {label}
      </div>
      <div className="flex flex-col justify-around gap-2 flex-1">{children}</div>
    </div>
  )
}

// ── A single game card ──
function GameCard({ gameNum, outcomes, teamForRef, championship }) {
  const g = TOURNEY.games.find((x) => x.num === gameNum)
  if (!g) return null
  const o = outcomes?.get(gameNum)
  const away = teamForRef(g.away)
  const home = teamForRef(g.home)
  const isFinal = o?.status === 'final' && o.home_score != null && o.away_score != null
  const isLive = o?.status === 'live' || o?.status === 'in_progress'

  const card = (
    <div
      className={`rounded-lg overflow-hidden border transition-all ${
        championship
          ? 'border-amber-400/70 bg-amber-400/5 shadow-[0_0_0_1px_rgba(251,191,36,0.25)]'
          : 'border-white/10 bg-white/[0.04]'
      } ${o?.db_game_id ? 'hover:border-pnw-teal hover:bg-white/[0.08] cursor-pointer' : ''}`}
    >
      <div className="flex items-center justify-between px-2 pt-1.5 pb-1">
        <span className="text-[8px] font-bold uppercase tracking-wider text-white/35">
          {championship ? 'Title Game' : `Game ${gameNum}`}
        </span>
        {isLive ? (
          <span className="text-[8px] font-bold text-red-400 animate-pulse">LIVE</span>
        ) : isFinal ? (
          <span className="text-[8px] font-bold text-white/35">FINAL</span>
        ) : (
          <span className="text-[8px] font-medium text-white/35">{g.time}</span>
        )}
      </div>
      <TeamRow team={away} score={o?.away_score} won={isFinal && o.winner_id === away.team_id} isFinal={isFinal} />
      <div className="h-px bg-white/10 mx-2" />
      <TeamRow team={home} score={o?.home_score} won={isFinal && o.winner_id === home.team_id} isFinal={isFinal} />
      {!isFinal && !isLive && (
        <div className="text-center text-[8px] text-white/30 pb-1 pt-0.5">{g.day}</div>
      )}
    </div>
  )

  if (o?.db_game_id) {
    return (
      <Link to={`/game/${o.db_game_id}`} className="block">
        {card}
      </Link>
    )
  }
  return card
}

// ── One team line inside a game card ──
function TeamRow({ team, score, won, isFinal }) {
  const dimmed = isFinal && !won
  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 ${won ? 'bg-amber-400/10' : ''}`}>
      {team.logo ? (
        <img
          src={team.logo}
          alt=""
          className={`w-4 h-4 object-contain shrink-0 ${dimmed ? 'opacity-40' : ''}`}
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
        />
      ) : (
        <span className="w-4 h-4 shrink-0" />
      )}
      {team.seed && (
        <span
          className={`text-[8px] font-bold w-7 shrink-0 ${
            won ? 'text-amber-300' : dimmed ? 'text-white/30' : 'text-pnw-teal/70'
          }`}
        >
          {team.seed}
        </span>
      )}
      <span
        className={`text-[11px] truncate flex-1 ${
          team.placeholder
            ? 'text-white/30 italic'
            : won
            ? 'font-bold text-white'
            : dimmed
            ? 'text-white/40'
            : 'font-medium text-white/90'
        }`}
      >
        {team.name}
      </span>
      {score != null && (
        <span
          className={`text-[12px] font-mono tabular-nums shrink-0 ${
            won ? 'font-bold text-amber-300' : dimmed ? 'text-white/40' : 'text-white/90'
          }`}
        >
          {score}
        </span>
      )}
    </div>
  )
}

// ── "If necessary" game note (only shows once it matters) ──
function IfNecessaryNote({ outcomes }) {
  const o = outcomes?.get(IF_NEC_GAME)
  const isFinal = o?.status === 'final' && o.home_score != null
  // Only surface the bracket-reset game if it actually gets played.
  if (!isFinal) {
    return (
      <p className="text-[8px] text-white/30 text-center mt-1.5 leading-tight">
        If necessary: Mon May 25
      </p>
    )
  }
  return null
}
