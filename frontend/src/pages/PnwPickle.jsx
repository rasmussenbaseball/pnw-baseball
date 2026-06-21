import { useState, useMemo, useRef, useEffect } from 'react'
import { SEASONS } from '../lib/seasons'
import { divisionBadgeClass } from '../utils/stats'

// Only offer seasons that actually have a qualifying player pool. Per-season
// class data (and game results for the 4-year schools) only exist from 2022
// on, so 2018-2021 produce empty/near-empty pools — leave them out.
const PICKLE_MIN_SEASON = 2022
const PICKLE_SEASONS = SEASONS.filter((y) => y >= PICKLE_MIN_SEASON)

const LEVELS = [
  { id: 'all', label: 'All PNW' },
  { id: 'D1', label: 'D1' },
  { id: 'D2', label: 'D2' },
  { id: 'D3', label: 'D3' },
  { id: 'NAIA', label: 'NAIA' },
  { id: 'NWAC', label: 'NWAC' },
]
const MAX_GUESSES = 8

// Role is part of the identity: a two-way player is split into a Hitter option
// and a Pitcher option (same player_id/season/team), so role keeps them distinct.
const uid = (p) => `${p.player_id}-${p.season}-${p.team}-${p.role}`

const fmt2 = (v) => (v == null ? '—' : Number(v).toFixed(2))
const fmt3 = (v) => (v == null ? '—' : Number(v).toFixed(3).replace(/^0/, ''))
const fmtIP = (v) => (v == null ? '—' : Number(v).toFixed(1))

// ── Per-column comparison: returns { state, arrow } ──
//   state: 'hit' (exact) | 'close' (near) | 'miss' (wrong) | 'na' (not comparable)
// Stat columns are role-specific: a hitter has no ERA, a pitcher has no AVG,
// and when the hidden player lacks a stat there's nothing to compare against,
// so those cells render 'na' (greyed, informational only).
function compare(col, guess, answer) {
  switch (col.type) {
    case 'exact': {
      const g = col.get(guess), a = col.get(answer)
      return { state: g === a ? 'hit' : 'miss' }
    }
    case 'conf':
      if (guess.conference === answer.conference) return { state: 'hit' }
      return { state: guess.level === answer.level ? 'close' : 'miss' }
    case 'pos':
      if ((guess.position || '') === (answer.position || '')) return { state: 'hit' }
      return { state: guess.posGroup && guess.posGroup === answer.posGroup ? 'close' : 'miss' }
    case 'role':
      if (guess.role === answer.role) return { state: 'hit' }
      // Two-Way overlaps with both Hitter and Pitcher.
      return { state: guess.role === 'Two-Way' || answer.role === 'Two-Way' ? 'close' : 'miss' }
    case 'num': {
      const gv = col.val(guess), av = col.val(answer)
      const diff = av - gv
      const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : null
      if (diff === 0) return { state: 'hit' }
      return { state: Math.abs(diff) <= col.close ? 'close' : 'miss', arrow }
    }
    case 'stat': {
      const gv = col.val(guess), av = col.val(answer)
      if (gv == null || av == null) return { state: 'na' }
      const diff = av - gv
      const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : null
      const ad = Math.abs(diff)
      if (ad <= (col.hit || 0)) return { state: 'hit' }
      return { state: ad <= col.close ? 'close' : 'miss', arrow }
    }
    default:
      return { state: 'miss' }
  }
}

const COLUMNS = [
  { key: 'level', type: 'exact', label: 'Level', get: (p) => p.level },
  { key: 'conference', type: 'conf', label: 'Conf', get: (p) => p.conference },
  { key: 'team', type: 'exact', label: 'Team', get: (p) => p.team },
  { key: 'class', type: 'num', label: 'Class', get: (p) => p.classYear, val: (p) => p.classRank, close: 1 },
  { key: 'position', type: 'pos', label: 'Pos', get: (p) => p.position || '—' },
  { key: 'bats', type: 'exact', label: 'B', get: (p) => p.bats || '—' },
  { key: 'throws', type: 'exact', label: 'T', get: (p) => p.throws || '—' },
  { key: 'role', type: 'role', label: 'Role', get: (p) => p.role },
  { key: 'season', type: 'num', label: 'Year', get: (p) => p.season, val: (p) => p.season, close: 1 },
  // Hitting stats (greyed for pitchers)
  { key: 'avg', type: 'stat', label: 'AVG', get: (p) => fmt3(p.stats?.AVG), val: (p) => p.stats?.AVG, hit: 0.005, close: 0.030 },
  { key: 'hr', type: 'stat', label: 'HR', get: (p) => p.stats?.HR ?? '—', val: (p) => p.stats?.HR, hit: 0, close: 3 },
  // Pitching stats (greyed for hitters)
  { key: 'era', type: 'stat', label: 'ERA', get: (p) => fmt2(p.stats?.ERA), val: (p) => p.stats?.ERA, hit: 0.10, close: 1.0 },
  { key: 'k', type: 'stat', label: 'K', get: (p) => p.stats?.SO ?? '—', val: (p) => p.stats?.SO, hit: 0, close: 15 },
  // Everyone
  { key: 'war', type: 'stat', label: 'WAR', get: (p) => p.war.toFixed(1), val: (p) => p.war, hit: 0.05, close: 1.0 },
]

const CELL = {
  hit: 'bg-green-600 text-white border-green-700',
  close: 'bg-amber-500 text-white border-amber-600',
  miss: 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600',
  na: 'bg-transparent border-dashed border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-500',
}

export default function PnwPickle() {
  const [phase, setPhase] = useState('setup') // setup | loading | playing | done
  const [level, setLevel] = useState('all')
  const [difficulty, setDifficulty] = useState('medium') // easy | medium | hard
  const [years, setYears] = useState(() => new Set(PICKLE_SEASONS)) // default all years
  const [error, setError] = useState(null)

  const [pool, setPool] = useState([])
  const [answer, setAnswer] = useState(null)
  const [guesses, setGuesses] = useState([])
  const [won, setWon] = useState(false)
  const [gaveUp, setGaveUp] = useState(false)

  const toggleYear = (y) => {
    setYears((prev) => {
      const next = new Set(prev)
      if (next.has(y)) next.delete(y)
      else next.add(y)
      return next
    })
  }
  const allYears = years.size === PICKLE_SEASONS.length

  const startGame = async () => {
    if (years.size === 0) { setError('Pick at least one year.'); return }
    setError(null)
    setPhase('loading')
    try {
      // Always send the explicit season list so excluded years (2018-2021)
      // never leak in via the backend's "no seasons = all years" default.
      const seasonsParam = `&seasons=${[...years].join(',')}`
      const resp = await fetch(`/api/v1/pnw-pickle/pool?level=${level}&difficulty=${difficulty}${seasonsParam}`)
      if (!resp.ok) throw new Error(`Request failed (${resp.status})`)
      const data = await resp.json()
      // answers = qualified, positive-WAR players (the hidden player is one of
      // these). guesses = every player in the pool (the search box options).
      const answers = data.answers || []
      const guesses = data.guesses || []
      if (answers.length < 3) {
        setError(`Only ${answers.length} qualified players match that combo. Pick more years, a broader level, or an easier difficulty.`)
        setPhase('setup')
        return
      }
      const ans = answers[Math.floor(Math.random() * answers.length)]
      setPool(guesses)
      setAnswer(ans)
      setGuesses([])
      setWon(false)
      setGaveUp(false)
      setPhase('playing')
    } catch (err) {
      setError(err.message)
      setPhase('setup')
    }
  }

  const submitGuess = (player) => {
    if (phase !== 'playing') return
    const next = [...guesses, player]
    setGuesses(next)
    if (uid(player) === uid(answer)) {
      setWon(true)
      setPhase('done')
    } else if (next.length >= MAX_GUESSES) {
      setPhase('done')
    }
  }

  const giveUp = () => {
    if (phase !== 'playing') return
    setGaveUp(true)
    setWon(false)
    setPhase('done')
  }

  const playAgain = () => {
    setPhase('setup')
    setGuesses([])
    setAnswer(null)
    setError(null)
    setGaveUp(false)
  }

  const guessedUids = useMemo(() => new Set(guesses.map(uid)), [guesses])

  if (phase === 'setup' || phase === 'loading') {
    return (
      <SetupScreen
        level={level} setLevel={setLevel}
        difficulty={difficulty} setDifficulty={setDifficulty}
        years={years} toggleYear={toggleYear} allYears={allYears}
        setYears={setYears}
        startGame={startGame} loading={phase === 'loading'} error={error}
      />
    )
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl sm:text-3xl font-bold text-pnw-slate">PNW Pickle</h1>
        <div className="text-sm font-semibold text-gray-500 dark:text-gray-400">
          Guess {Math.min(guesses.length + (phase === 'done' ? 0 : 1), MAX_GUESSES)} / {MAX_GUESSES}
        </div>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Guess the hidden PNW player. 🟩 exact · 🟨 close · ↑ answer is higher · ↓ lower · dashed = stat doesn't apply.
      </p>

      {phase === 'playing' && (
        <>
          <GuessInput
            pool={pool}
            guessedUids={guessedUids}
            onPick={submitGuess}
          />
          <div className="flex justify-end -mt-2 mb-3">
            <button
              type="button"
              onClick={giveUp}
              className="text-xs font-semibold text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 underline underline-offset-2"
            >
              Give up & reveal answer
            </button>
          </div>
        </>
      )}

      {phase === 'done' && (
        <ResultBanner won={won} gaveUp={gaveUp} answer={answer} count={guesses.length} playAgain={playAgain} />
      )}

      <GuessGrid guesses={guesses} answer={answer} />

      {phase === 'done' && (
        <div className="text-center mt-6">
          <button
            type="button"
            onClick={playAgain}
            className="px-8 py-2.5 bg-pnw-green text-white font-semibold rounded-lg hover:bg-pnw-forest transition-colors"
          >
            ↩ Play Again
          </button>
        </div>
      )}
    </div>
  )
}

// ─────────────────── SETUP ───────────────────

const DIFFICULTIES = [
  { id: 'easy', label: 'Easy', desc: 'Stars only (2.0+ WAR, 1.3+ for pitchers)' },
  { id: 'medium', label: 'Medium', desc: 'Solid contributors (0.8+ WAR)' },
  { id: 'hard', label: 'Hard', desc: 'Anyone with positive WAR (0.1+)' },
]

function SetupScreen({ level, setLevel, difficulty, setDifficulty, years, toggleYear, allYears, setYears, startGame, loading, error }) {
  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl sm:text-3xl font-bold text-pnw-slate mb-2">PNW Pickle</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Guess the mystery Pacific Northwest college player in {MAX_GUESSES} tries. Each guess
        reveals how close you are on level, team, class, position, handedness, year, and stats
        (AVG/HR for hitters, ERA/K for pitchers, WAR for everyone). Pick a difficulty to set how
        good the mystery player has to be, so they should be names you remember.
      </p>

      <section className="mb-6">
        <h2 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
          1. Difficulty
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDifficulty(d.id)}
              className={`px-3 py-2.5 rounded-lg border-2 text-left transition-colors ${
                difficulty === d.id
                  ? 'bg-pnw-forest text-white border-pnw-forest shadow-md'
                  : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-nw-teal'
              }`}
            >
              <div className="font-semibold text-sm">{d.label}</div>
              <div className={`text-xs mt-0.5 ${difficulty === d.id ? 'text-white/80' : 'text-gray-500 dark:text-gray-400'}`}>
                {d.desc}
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="mb-6">
        <h2 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
          2. Player pool
        </h2>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => setLevel(l.id)}
              className={`px-3 py-2.5 rounded-lg border-2 text-sm font-semibold transition-colors ${
                level === l.id
                  ? 'bg-pnw-forest text-white border-pnw-forest shadow-md'
                  : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-nw-teal'
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </section>

      <section className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            3. Seasons
          </h2>
          <button
            type="button"
            onClick={() => setYears(allYears ? new Set() : new Set(PICKLE_SEASONS))}
            className="text-xs font-semibold text-nw-teal hover:underline"
          >
            {allYears ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {PICKLE_SEASONS.map((y) => {
            const on = years.has(y)
            return (
              <button
                key={y}
                type="button"
                onClick={() => toggleYear(y)}
                className={`px-3.5 py-2 rounded-lg border-2 text-sm font-semibold transition-colors ${
                  on
                    ? 'bg-nw-teal/10 border-nw-teal text-pnw-slate dark:text-gray-100'
                    : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-nw-teal'
                }`}
              >
                {y}
              </button>
            )
          })}
        </div>
      </section>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={startGame}
        disabled={loading}
        className="px-6 py-2.5 bg-pnw-green text-white font-semibold rounded-lg hover:bg-pnw-forest disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? 'Loading…' : '🥒 Start Game'}
      </button>
    </div>
  )
}

// ─────────────────── GUESS INPUT (autocomplete) ───────────────────

function GuessInput({ pool, guessedUids, onPick }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [])

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    return pool
      .filter((p) => !guessedUids.has(uid(p)) && p.name.toLowerCase().includes(s))
      .slice(0, 12)
  }, [q, pool, guessedUids])

  const pick = (p) => {
    onPick(p)
    setQ('')
    setOpen(false)
  }

  return (
    <div className="relative mb-4" ref={wrapRef}>
      <input
        type="text"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        placeholder="Type a player's name to guess…"
        className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-nw-teal/30"
      />
      {open && matches.length > 0 && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-72 overflow-y-auto">
          {matches.map((p) => (
            <button
              key={uid(p)}
              type="button"
              onClick={() => pick(p)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-nw-teal/10 border-b border-gray-100 dark:border-gray-700 last:border-0"
            >
              {p.logo && (
                <img src={p.logo} alt="" className="w-5 h-5 object-contain flex-shrink-0"
                     onError={(e) => { e.target.style.display = 'none' }} />
              )}
              <span className="font-medium text-pnw-slate dark:text-gray-100">{p.name}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto">
                {p.season} {p.team} · {p.role}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────── GUESS GRID ───────────────────

function GuessGrid({ guesses, answer }) {
  if (guesses.length === 0) {
    return (
      <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-8">
        Your guesses will appear here.
      </p>
    )
  }
  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <table className="w-full border-separate" style={{ borderSpacing: '3px' }}>
        <thead>
          <tr>
            <th className="text-left text-[0.7rem] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 px-2 pb-1">
              Player
            </th>
            {COLUMNS.map((c) => (
              <th key={c.key} className="text-[0.7rem] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 px-1 pb-1 text-center">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...guesses].reverse().map((g) => (
            <tr key={uid(g)}>
              <td className="text-sm font-semibold text-pnw-slate dark:text-gray-100 px-2 whitespace-nowrap">
                {g.name}
              </td>
              {COLUMNS.map((c) => {
                const { state, arrow } = compare(c, g, answer)
                return (
                  <td key={c.key} className="p-0">
                    <div className={`min-w-[2.7rem] h-11 flex items-center justify-center rounded-md border text-xs font-semibold text-center leading-tight px-1 ${CELL[state]}`}>
                      <span>{c.get(g)}{arrow ? ` ${arrow}` : ''}</span>
                    </div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─────────────────── RESULT ───────────────────

function statLine(p) {
  const s = p.stats || {}
  if (p.role === 'Pitcher') {
    return `${s.W ?? 0}W ${s.SV ?? 0}SV · ${fmt2(s.ERA)} ERA · ${s.SO ?? 0} K · ${fmtIP(s.IP)} IP · ${p.war.toFixed(1)} WAR`
  }
  const hit = `${fmt3(s.AVG)}/${fmt3(s.OBP)}/${fmt3(s.SLG)} · ${s.HR ?? 0} HR · ${s.RBI ?? 0} RBI · ${s.SB ?? 0} SB · ${(s.oWAR ?? p.war).toFixed?.(1) ?? p.war} WAR`
  if (p.role === 'Two-Way') {
    return `${hit}  |  ${fmt2(s.ERA)} ERA, ${s.SO ?? 0} K`
  }
  return hit
}

function ResultBanner({ won, gaveUp, answer, count, playAgain }) {
  return (
    <div className={`mb-4 p-4 rounded-xl border text-center ${
      won
        ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-700'
        : 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700'
    }`}>
      <div className={`text-lg font-bold ${won ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
        {won ? `🥒 Got it in ${count}!` : gaveUp ? 'You gave up. The answer was:' : 'Out of guesses!'}
      </div>
      <div className="flex items-center justify-center gap-2 mt-2">
        {answer.logo && <img src={answer.logo} alt="" className="w-6 h-6 object-contain" onError={(e) => { e.target.style.display = 'none' }} />}
        <span className="font-semibold text-pnw-slate dark:text-gray-100">{answer.name}</span>
        <span className={`px-2 py-0.5 rounded text-xs font-bold ${divisionBadgeClass(answer.level === 'NWAC' ? 'JUCO' : answer.level)}`}>
          {answer.level}
        </span>
      </div>
      <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
        {answer.season} {answer.teamName} · {answer.classYear} · {answer.position}
      </div>
      <div className="text-sm font-medium text-pnw-slate dark:text-gray-200 mt-1">{statLine(answer)}</div>
    </div>
  )
}
