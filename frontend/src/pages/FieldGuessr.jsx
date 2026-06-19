import { useState, useMemo } from 'react'
import { STADIUM_TEAMS } from '../data/stadiumQuiz'
import { divisionBadgeClass } from '../utils/stats'

// Conference order + sub-conference labels, matching the rest of the site.
const CONF_ORDER = ['D1', 'D2', 'D3', 'NAIA', 'JUCO']
const CONF_INFO = {
  D1: { label: 'D1', sub: '' },
  D2: { label: 'D2', sub: 'GNAC' },
  D3: { label: 'D3', sub: 'NWC' },
  NAIA: { label: 'NAIA', sub: 'CCC' },
  JUCO: { label: 'JUCO', sub: 'NWAC' },
}
const QUESTIONS_PER_ROUND = 10
const IMG_BASE = '/stadium-quiz/'

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export default function FieldGuessr() {
  // ── Setup state ──
  const [difficulty, setDifficulty] = useState('easy') // 'easy' | 'hard'
  const [selectedConfs, setSelectedConfs] = useState(
    () => new Set(CONF_ORDER)
  )

  // ── Game state ──
  const [phase, setPhase] = useState('setup') // 'setup' | 'playing' | 'results'
  const [questions, setQuestions] = useState([])
  const [currentQ, setCurrentQ] = useState(0)
  const [score, setScore] = useState(0)
  const [answered, setAnswered] = useState(false)
  const [results, setResults] = useState([])

  // Per-question picker state
  const [pickConf, setPickConf] = useState('') // selected division in two-step picker
  const [pickTeam, setPickTeam] = useState('') // selected team name

  const confCounts = useMemo(() => {
    const c = {}
    for (const t of STADIUM_TEAMS) c[t.conference] = (c[t.conference] || 0) + 1
    return c
  }, [])

  const gamePool = useMemo(
    () => STADIUM_TEAMS.filter((t) => selectedConfs.has(t.conference)),
    [selectedConfs]
  )

  const isSingleConf = selectedConfs.size === 1

  // Teams available in the picker, given which division (if any) is chosen.
  const pickerTeams = useMemo(() => {
    const conf = isSingleConf ? [...selectedConfs][0] : pickConf
    if (!conf) return []
    return gamePool
      .filter((t) => t.conference === conf)
      .map((t) => t.name)
      .sort((a, b) => a.localeCompare(b))
  }, [gamePool, pickConf, isSingleConf, selectedConfs])

  const toggleConf = (id) => {
    setSelectedConfs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const startGame = () => {
    if (selectedConfs.size === 0) return
    const picked = shuffle(gamePool).slice(
      0,
      Math.min(QUESTIONS_PER_ROUND, gamePool.length)
    )
    setQuestions(picked)
    setCurrentQ(0)
    setScore(0)
    setResults([])
    setAnswered(false)
    setPickConf('')
    setPickTeam('')
    setPhase('playing')
  }

  const current = questions[currentQ]

  const submitAnswer = () => {
    if (!pickTeam || answered) return
    const correct = pickTeam === current.name
    setAnswered(true)
    if (correct) setScore((s) => s + 1)
    setResults((r) => [
      ...r,
      { team: current.name, field: current.field, guess: pickTeam, correct },
    ])
  }

  const nextQuestion = () => {
    if (currentQ >= questions.length - 1) {
      setPhase('results')
      return
    }
    setCurrentQ((i) => i + 1)
    setAnswered(false)
    setPickConf('')
    setPickTeam('')
  }

  const resetGame = () => {
    setPhase('setup')
    setAnswered(false)
    setPickConf('')
    setPickTeam('')
  }

  // ── Render ──
  if (phase === 'setup') {
    return (
      <SetupScreen
        difficulty={difficulty}
        setDifficulty={setDifficulty}
        selectedConfs={selectedConfs}
        toggleConf={toggleConf}
        confCounts={confCounts}
        startGame={startGame}
      />
    )
  }

  if (phase === 'results') {
    return <ResultsScreen score={score} results={results} resetGame={resetGame} />
  }

  return (
    <QuestionScreen
      current={current}
      index={currentQ}
      total={questions.length}
      score={score}
      difficulty={difficulty}
      answered={answered}
      isSingleConf={isSingleConf}
      includedConfs={CONF_ORDER.filter((c) => selectedConfs.has(c))}
      pickConf={isSingleConf ? [...selectedConfs][0] : pickConf}
      setPickConf={(v) => {
        setPickConf(v)
        setPickTeam('')
      }}
      pickTeam={pickTeam}
      setPickTeam={setPickTeam}
      pickerTeams={pickerTeams}
      submitAnswer={submitAnswer}
      nextQuestion={nextQuestion}
    />
  )
}

// ─────────────────── SETUP SCREEN ───────────────────

function SetupScreen({
  difficulty,
  setDifficulty,
  selectedConfs,
  toggleConf,
  confCounts,
  startGame,
}) {
  const noneSelected = selectedConfs.size === 0
  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl sm:text-3xl font-bold text-pnw-slate mb-2">
        FieldGuessr
      </h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Identify the ballpark. You get a photo of a Pacific Northwest college
        baseball field, then guess which team plays there. Ten parks per round.
      </p>

      {/* Difficulty */}
      <section className="mb-6">
        <h2 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
          1. Difficulty
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {[
            {
              id: 'easy',
              title: '🟢 Rookie',
              desc: 'Original photos of the field',
            },
            {
              id: 'hard',
              title: '🔴 Veteran',
              desc: 'Logos & colors blacked out',
            },
          ].map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDifficulty(d.id)}
              className={`px-4 py-3 rounded-lg border-2 text-left transition-colors ${
                difficulty === d.id
                  ? 'bg-pnw-forest text-white border-pnw-forest shadow-md ring-2 ring-pnw-forest/30'
                  : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-nw-teal'
              }`}
            >
              <div className="font-semibold text-sm">{d.title}</div>
              <div
                className={`text-xs mt-0.5 ${
                  difficulty === d.id
                    ? 'text-white/80'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                {d.desc}
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* Conferences */}
      <section className="mb-6">
        <h2 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
          2. Levels to include
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {CONF_ORDER.map((id) => {
            const info = CONF_INFO[id]
            const on = selectedConfs.has(id)
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggleConf(id)}
                className={`px-3 py-2.5 rounded-lg border-2 text-center transition-colors ${
                  on
                    ? 'bg-nw-teal/10 border-nw-teal'
                    : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:border-nw-teal/50'
                }`}
              >
                <div className="flex items-center justify-center gap-1.5">
                  <span
                    className={`px-1.5 py-0.5 rounded text-xs font-bold ${divisionBadgeClass(
                      id
                    )}`}
                  >
                    {info.label}
                  </span>
                </div>
                {info.sub && (
                  <div className="text-[0.7rem] text-gray-500 dark:text-gray-400 mt-1">
                    {info.sub}
                  </div>
                )}
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-300 mt-1">
                  {confCounts[id] || 0} parks
                </div>
              </button>
            )
          })}
        </div>
        {noneSelected && (
          <p className="text-xs text-red-600 dark:text-red-400 mt-2">
            Select at least one level to start.
          </p>
        )}
      </section>

      <button
        type="button"
        onClick={startGame}
        disabled={noneSelected}
        className="px-6 py-2.5 bg-pnw-green text-white font-semibold rounded-lg hover:bg-pnw-forest disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
      >
        ⚾ Play Ball
      </button>
    </div>
  )
}

// ─────────────────── QUESTION SCREEN ───────────────────

function QuestionScreen({
  current,
  index,
  total,
  score,
  difficulty,
  answered,
  isSingleConf,
  includedConfs,
  pickConf,
  setPickConf,
  pickTeam,
  setPickTeam,
  pickerTeams,
  submitAnswer,
  nextQuestion,
}) {
  // After answering in Veteran mode, reveal the original (easy) photo.
  const imgFile =
    answered && difficulty === 'hard' ? current.easy : current[difficulty]
  const isLast = index === total - 1
  const correct = answered && pickTeam === current.name

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header: progress + score */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Question {index + 1} of {total}
        </div>
        <div className="text-sm font-semibold text-pnw-slate">
          Score <span className="text-pnw-green">{score}</span>
        </div>
      </div>
      <div className="h-1.5 w-full bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mb-4">
        <div
          className="h-full bg-pnw-green transition-all duration-300"
          style={{ width: `${(index / total) * 100}%` }}
        />
      </div>

      {/* Field image */}
      <div className="rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-900 mb-4">
        <img
          src={IMG_BASE + imgFile}
          alt="Baseball field"
          className="w-full aspect-[3/2] object-cover"
        />
      </div>

      <div className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
        Which team plays here?
      </div>

      {/* Two-step picker: division → team */}
      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        {!isSingleConf && (
          <select
            value={pickConf}
            onChange={(e) => setPickConf(e.target.value)}
            disabled={answered}
            className="sm:w-40 px-3 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-nw-teal/30 disabled:opacity-60"
          >
            <option value="">Level…</option>
            {includedConfs.map((c) => (
              <option key={c} value={c}>
                {CONF_INFO[c].label}
                {CONF_INFO[c].sub ? ` (${CONF_INFO[c].sub})` : ''}
              </option>
            ))}
          </select>
        )}
        <select
          value={pickTeam}
          onChange={(e) => setPickTeam(e.target.value)}
          disabled={answered || (!isSingleConf && !pickConf)}
          className="flex-1 px-3 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-nw-teal/30 disabled:opacity-60"
        >
          <option value="">
            {!isSingleConf && !pickConf ? 'Pick a level first…' : 'Select a team…'}
          </option>
          {pickerTeams.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {/* Feedback */}
      {answered && (
        <div
          className={`p-3 rounded-lg text-sm mb-3 border ${
            correct
              ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-700 text-green-800 dark:text-green-300'
              : 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700'
          }`}
        >
          {correct ? (
            <div className="font-semibold">
              ✅ {current.name} — {current.field}
            </div>
          ) : (
            <>
              <div className="text-red-700 dark:text-red-300 font-semibold">
                ❌ You guessed: {pickTeam}
              </div>
              <div className="text-green-700 dark:text-green-400 font-semibold mt-1">
                ✅ {current.name} — {current.field}
              </div>
            </>
          )}
        </div>
      )}

      {/* Action button */}
      {!answered ? (
        <button
          type="button"
          onClick={submitAnswer}
          disabled={!pickTeam}
          className="w-full px-6 py-2.5 bg-pnw-green text-white font-semibold rounded-lg hover:bg-pnw-forest disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
        >
          Submit Answer
        </button>
      ) : (
        <button
          type="button"
          onClick={nextQuestion}
          className="w-full px-6 py-2.5 border-2 border-pnw-green text-pnw-green font-semibold rounded-lg hover:bg-pnw-green/10 transition-colors"
        >
          {isLast ? 'See Results' : 'Next Question →'}
        </button>
      )}
    </div>
  )
}

// ─────────────────── RESULTS SCREEN ───────────────────

function ResultsScreen({ score, results, resetGame }) {
  const total = results.length
  const pct = total ? score / total : 0
  let grade = '⚾ Keep watching, the fields will start looking familiar.'
  if (pct === 1) grade = '🏆 Perfect! You know every ballpark.'
  else if (pct >= 0.8) grade = '⭐ Excellent Northwest baseball IQ!'
  else if (pct >= 0.6) grade = '👍 Solid effort, not bad!'
  else if (pct >= 0.4) grade = '📚 Time to hit more games.'

  return (
    <div className="max-w-2xl mx-auto text-center">
      <div className="text-6xl sm:text-7xl font-bold text-pnw-green leading-none">
        {score}/{total}
      </div>
      <div className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mt-1">
        Correct Answers
      </div>
      <div className="text-lg font-semibold text-pnw-slate mt-3">{grade}</div>

      <div className="mt-6 text-left max-h-80 overflow-y-auto space-y-1.5">
        {results.map((r, i) => (
          <div
            key={i}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg border text-sm ${
              r.correct
                ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
                : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
            }`}
          >
            <span
              className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                r.correct ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <div>
              <div className="font-semibold text-pnw-slate">{r.team}</div>
              {!r.correct && (
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  You guessed: {r.guess}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={resetGame}
        className="mt-6 px-8 py-2.5 bg-pnw-green text-white font-semibold rounded-lg hover:bg-pnw-forest transition-colors"
      >
        ↩ Play Again
      </button>
    </div>
  )
}
