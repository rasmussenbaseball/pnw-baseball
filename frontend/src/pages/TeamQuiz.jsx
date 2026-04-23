import { useState, useMemo } from 'react'
import { useTeams } from '../hooks/useApi'
import { CURRENT_SEASON } from '../utils/constants'
import { divisionBadgeClass } from '../utils/stats'

const PNW_STATES = ['WA', 'OR', 'ID', 'MT']
const DIV_ORDER = ['D1', 'D2', 'D3', 'NAIA', 'NWAC', 'JUCO']
const MIN_YEAR = 2018
const YEAR_OPTIONS = []
for (let y = CURRENT_SEASON; y >= MIN_YEAR; y--) YEAR_OPTIONS.push(y)

export default function TeamQuiz() {
  // ── Setup state ──
  const { data: teams, loading: teamsLoading } = useTeams()
  const [selectedTeamId, setSelectedTeamId] = useState(null)
  const [teamSearch, setTeamSearch] = useState('')
  const [selectedYears, setSelectedYears] = useState([])

  // ── Quiz state ──
  const [quiz, setQuiz] = useState(null)       // { questions: [...], team_id, seasons }
  const [quizLoading, setQuizLoading] = useState(false)
  const [quizError, setQuizError] = useState(null)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [userAnswer, setUserAnswer] = useState(null)     // MC: option id. match: {p1: v2, ...}
  const [revealed, setRevealed] = useState(false)
  const [score, setScore] = useState(0)
  const [completed, setCompleted] = useState(false)

  const selectedTeam = useMemo(() => {
    if (!teams || !selectedTeamId) return null
    return teams.find(t => t.id === selectedTeamId) || null
  }, [teams, selectedTeamId])

  const filteredTeams = useMemo(() => {
    if (!teams) return []
    const pnw = teams.filter(t => PNW_STATES.includes(t.state || ''))
    const q = teamSearch.trim().toLowerCase()
    if (!q) return pnw
    return pnw.filter(t =>
      (t.name || '').toLowerCase().includes(q) ||
      (t.short_name || '').toLowerCase().includes(q) ||
      (t.school_name || '').toLowerCase().includes(q)
    )
  }, [teams, teamSearch])

  const groupedTeams = useMemo(() => {
    const g = {}
    for (const t of filteredTeams) {
      const d = t.division_level || 'Other'
      if (!g[d]) g[d] = []
      g[d].push(t)
    }
    Object.values(g).forEach(arr =>
      arr.sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name))
    )
    return g
  }, [filteredTeams])

  const toggleYear = (year) => {
    setSelectedYears(prev => {
      if (prev.includes(year)) return prev.filter(y => y !== year)
      return [...prev, year].sort((a, b) => b - a)
    })
  }

  const startQuiz = async () => {
    if (!selectedTeamId || selectedYears.length === 0) return
    setQuizLoading(true)
    setQuizError(null)
    try {
      const seasons = selectedYears.join(',')
      const url = `/api/v1/quiz/questions?team_id=${selectedTeamId}&seasons=${seasons}&count=10`
      const resp = await fetch(url)
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({}))
        throw new Error(detail.detail || `Quiz request failed (${resp.status})`)
      }
      const data = await resp.json()
      if (!data.questions || data.questions.length === 0) {
        throw new Error('Not enough data to build a quiz for this team and seasons.')
      }
      setQuiz(data)
      setCurrentIdx(0)
      setUserAnswer(null)
      setRevealed(false)
      setScore(0)
      setCompleted(false)
    } catch (err) {
      setQuizError(err.message)
    } finally {
      setQuizLoading(false)
    }
  }

  const resetQuiz = () => {
    setQuiz(null)
    setQuizError(null)
    setCurrentIdx(0)
    setUserAnswer(null)
    setRevealed(false)
    setScore(0)
    setCompleted(false)
  }

  // ── Answer handling ──
  const currentQ = quiz?.questions?.[currentIdx]

  const isMcCorrect = (q, ans) => ans === q.answer
  const isMatchCorrect = (q, ans) => {
    if (!ans) return false
    // Answer key shape: {p1: v3, p2: v1, ...}
    for (const [pid, vid] of Object.entries(q.answer)) {
      if (ans[pid] !== vid) return false
    }
    return true
  }
  const isAnswerCorrect = (q, ans) =>
    q.type === 'match' ? isMatchCorrect(q, ans) : isMcCorrect(q, ans)

  const submitAnswer = () => {
    if (!currentQ) return
    if (revealed) return
    const correct = isAnswerCorrect(currentQ, userAnswer)
    if (correct) setScore(s => s + 1)
    setRevealed(true)
  }

  const nextQuestion = () => {
    if (!quiz) return
    const nextIdx = currentIdx + 1
    if (nextIdx >= quiz.questions.length) {
      setCompleted(true)
      return
    }
    setCurrentIdx(nextIdx)
    setUserAnswer(null)
    setRevealed(false)
  }

  // ── Match-question helpers ──
  // The user picks a value for each player from a dropdown.
  const setMatchValue = (playerKey, valueKey) => {
    if (revealed) return
    setUserAnswer(prev => {
      const next = { ...(prev || {}) }
      // Remove any other player that had this value selected (can't reuse values)
      for (const [pk, vk] of Object.entries(next)) {
        if (vk === valueKey) delete next[pk]
      }
      next[playerKey] = valueKey
      return next
    })
  }

  const matchAllFilled = (q, ans) => {
    if (!q || !ans) return false
    return q.players.every(p => ans[p.id])
  }

  // ─────────────────── RENDER ───────────────────

  if (!quiz) {
    return (
      <SetupScreen
        teamsLoading={teamsLoading}
        groupedTeams={groupedTeams}
        teamSearch={teamSearch}
        setTeamSearch={setTeamSearch}
        selectedTeam={selectedTeam}
        selectedTeamId={selectedTeamId}
        setSelectedTeamId={setSelectedTeamId}
        selectedYears={selectedYears}
        toggleYear={toggleYear}
        startQuiz={startQuiz}
        quizLoading={quizLoading}
        quizError={quizError}
      />
    )
  }

  if (completed) {
    return (
      <ResultsScreen
        team={selectedTeam}
        seasons={quiz.seasons}
        score={score}
        total={quiz.questions.length}
        onRetake={resetQuiz}
      />
    )
  }

  return (
    <QuestionScreen
      team={selectedTeam}
      question={currentQ}
      index={currentIdx}
      total={quiz.questions.length}
      score={score}
      userAnswer={userAnswer}
      setUserAnswer={setUserAnswer}
      revealed={revealed}
      submitAnswer={submitAnswer}
      nextQuestion={nextQuestion}
      setMatchValue={setMatchValue}
      isMcCorrect={isMcCorrect}
      isMatchCorrect={isMatchCorrect}
      matchAllFilled={matchAllFilled}
      onQuit={resetQuiz}
    />
  )
}

// ─────────────────── SETUP SCREEN ───────────────────

function SetupScreen({
  teamsLoading, groupedTeams, teamSearch, setTeamSearch,
  selectedTeam, selectedTeamId, setSelectedTeamId,
  selectedYears, toggleYear, startQuiz, quizLoading, quizError,
}) {
  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl sm:text-3xl font-bold text-pnw-slate mb-2">Team Quiz</h1>
      <p className="text-sm text-gray-500 mb-6">
        Test your knowledge of a Pacific Northwest college baseball team. Pick a team, choose one
        or more seasons, and get a 10 question quiz drawn at random from leaders, statlines, match
        formats, and head-to-head comparisons.
      </p>

      {/* Team picker */}
      <section className="mb-6">
        <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wide mb-2">
          1. Pick a team
        </h2>
        <input
          type="text"
          placeholder="Search teams..."
          value={teamSearch}
          onChange={(e) => setTeamSearch(e.target.value)}
          className="w-full max-w-md px-3 py-2 border rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-nw-teal/30"
        />
        {teamsLoading && <div className="text-gray-400 animate-pulse">Loading teams...</div>}

        <div className="max-h-80 overflow-y-auto border rounded-lg bg-white p-2">
          {DIV_ORDER.map(div => {
            const list = groupedTeams[div]
            if (!list || list.length === 0) return null
            return (
              <div key={div} className="mb-3 last:mb-0">
                <div className="flex items-center gap-2 px-1 mb-1">
                  <span className={`px-2 py-0.5 rounded text-xs font-bold ${divisionBadgeClass(div)}`}>
                    {div}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {list.map(t => (
                    <button
                      type="button"
                      key={t.id}
                      onClick={() => setSelectedTeamId(t.id)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-left text-sm transition-colors ${
                        selectedTeamId === t.id
                          ? 'bg-nw-teal/10 border-nw-teal'
                          : 'bg-white border-gray-200 hover:border-nw-teal/50 hover:bg-gray-50'
                      }`}
                    >
                      {t.logo_url && (
                        <img src={t.logo_url} alt="" className="w-5 h-5 object-contain"
                             onError={(e) => { e.target.style.display = 'none' }} />
                      )}
                      <span className="truncate">{t.short_name || t.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* Year picker */}
      <section className="mb-6">
        <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wide mb-2">
          2. Pick one or more seasons
        </h2>
        <div className="flex flex-wrap gap-2">
          {YEAR_OPTIONS.map(y => {
            const on = selectedYears.includes(y)
            return (
              <button
                type="button"
                key={y}
                onClick={() => toggleYear(y)}
                className={`px-4 py-2 rounded-lg border-2 text-sm font-semibold transition-colors ${
                  on
                    ? 'bg-pnw-forest text-white border-pnw-forest shadow-md ring-2 ring-pnw-forest/30'
                    : 'bg-white border-gray-300 text-gray-700 hover:border-nw-teal hover:bg-gray-50'
                }`}
              >
                {y}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-gray-400 mt-2">
          Questions will be pulled across any seasons you select.
        </p>
      </section>

      {/* Start button */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={startQuiz}
          disabled={!selectedTeamId || selectedYears.length === 0 || quizLoading}
          className="px-6 py-2.5 bg-pnw-green text-white font-semibold rounded-lg hover:bg-pnw-forest disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
        >
          {quizLoading ? 'Building quiz...' : 'Start Quiz'}
        </button>
        {selectedTeam && (
          <div className="text-sm text-gray-600">
            <span className="font-semibold">{selectedTeam.short_name || selectedTeam.name}</span>
            {selectedYears.length > 0 && <span className="text-gray-400"> · {selectedYears.join(', ')}</span>}
          </div>
        )}
      </div>
      {quizError && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {quizError}
        </div>
      )}
    </div>
  )
}

// ─────────────────── QUESTION SCREEN ───────────────────

function QuestionScreen({
  team, question, index, total, score, userAnswer, setUserAnswer,
  revealed, submitAnswer, nextQuestion, setMatchValue,
  matchAllFilled, onQuit,
}) {
  if (!question) return null
  const isMatch = question.type === 'match'
  const canSubmit = revealed
    ? false
    : isMatch
      ? matchAllFilled(question, userAnswer)
      : userAnswer != null

  const correct = revealed && (
    isMatch
      ? Object.entries(question.answer).every(([pid, vid]) => userAnswer?.[pid] === vid)
      : userAnswer === question.answer
  )

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header: progress + score + quit */}
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm text-gray-500">
          <span className="font-semibold text-pnw-slate">{team?.short_name || 'Team'}</span>
          <span className="mx-2">·</span>
          <span>Question {index + 1} of {total}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-gray-500">
            Score: <span className="font-semibold text-pnw-slate">{score} / {index + (revealed ? 1 : 0)}</span>
          </div>
          <button
            type="button"
            onClick={onQuit}
            className="text-xs text-gray-400 hover:text-gray-600 underline"
          >
            Quit
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-gray-200 rounded-full h-1.5 mb-6">
        <div
          className="bg-nw-teal h-1.5 rounded-full transition-all"
          style={{ width: `${((index + (revealed ? 1 : 0)) / total) * 100}%` }}
        />
      </div>

      {/* Prompt */}
      <div className="bg-white border rounded-xl p-5 mb-4 shadow-sm">
        <div className="text-base sm:text-lg font-semibold text-pnw-slate">{question.prompt}</div>
        {question.subtitle && (
          <div className="text-xs text-gray-400 mt-1">{question.subtitle}</div>
        )}
        {question.statline && (
          <div className="mt-3 px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg font-mono text-sm sm:text-base text-pnw-slate">
            {question.statline}
          </div>
        )}
      </div>

      {/* Answer area */}
      {!isMatch ? (
        <McOptions
          question={question}
          userAnswer={userAnswer}
          setUserAnswer={setUserAnswer}
          revealed={revealed}
        />
      ) : (
        <MatchBoard
          question={question}
          userAnswer={userAnswer}
          setMatchValue={setMatchValue}
          revealed={revealed}
        />
      )}

      {/* Reveal explanation */}
      {revealed && (
        <div className={`mt-4 p-4 rounded-lg border ${
          correct
            ? 'bg-green-50 border-green-200 text-green-800'
            : 'bg-red-50 border-red-200 text-red-800'
        }`}>
          <div className="font-semibold mb-1">{correct ? 'Correct!' : 'Not quite.'}</div>
          {question.explanation && <div className="text-sm">{question.explanation}</div>}
          {isMatch && (
            <div className="text-sm mt-2">
              Correct pairings:
              <ul className="mt-1 list-disc list-inside">
                {question.players.map(p => {
                  const vid = question.answer[p.id]
                  const v = question.values.find(x => x.id === vid)
                  return (
                    <li key={p.id}>
                      {p.label} — {v?.label}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Action button */}
      <div className="mt-5 flex justify-end">
        {!revealed ? (
          <button
            type="button"
            onClick={submitAnswer}
            disabled={!canSubmit}
            className="px-6 py-2.5 bg-pnw-green text-white font-semibold rounded-lg hover:bg-pnw-forest disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            Submit
          </button>
        ) : (
          <button
            type="button"
            onClick={nextQuestion}
            className="px-6 py-2.5 bg-amber-500 text-white font-semibold rounded-lg shadow-md hover:bg-amber-600 transition-colors"
          >
            {index + 1 >= total ? 'See Results' : 'Next Question'}
          </button>
        )}
      </div>
    </div>
  )
}

// ─────────────────── MC OPTIONS ───────────────────

function McOptions({ question, userAnswer, setUserAnswer, revealed }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {question.options.map(opt => {
        const picked = userAnswer === opt.id
        const isAnswer = opt.id === question.answer
        let tone = 'bg-white border-gray-200 hover:border-nw-teal/50 hover:bg-gray-50'
        if (revealed) {
          if (isAnswer) tone = 'bg-green-50 border-green-400'
          else if (picked && !isAnswer) tone = 'bg-red-50 border-red-400'
          else tone = 'bg-white border-gray-200 opacity-70'
        } else if (picked) {
          tone = 'bg-nw-teal/10 border-nw-teal'
        }
        return (
          <button
            type="button"
            key={opt.id}
            onClick={() => !revealed && setUserAnswer(opt.id)}
            disabled={revealed}
            className={`text-left px-4 py-3 rounded-lg border text-sm sm:text-base transition-colors ${tone}`}
          >
            <span className="font-bold text-gray-400 mr-2">{opt.id.toUpperCase()}.</span>
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// ─────────────────── MATCH BOARD ───────────────────
// Renders 4 players on the left with a dropdown each; 4 values on the right for reference.

function MatchBoard({ question, userAnswer, setMatchValue, revealed }) {
  const ans = userAnswer || {}
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-400 mb-2">Players</div>
        <div className="space-y-2">
          {question.players.map(p => {
            const chosen = ans[p.id]
            const correct = question.answer[p.id]
            let tone = 'bg-white border-gray-200'
            if (revealed) {
              if (chosen === correct) tone = 'bg-green-50 border-green-400'
              else if (chosen && chosen !== correct) tone = 'bg-red-50 border-red-400'
              else tone = 'bg-red-50 border-red-400'  // unanswered in a match is still wrong
            }
            return (
              <div key={p.id} className={`flex items-center gap-2 border rounded-lg px-3 py-2 ${tone}`}>
                <div className="flex-1 text-sm font-medium text-pnw-slate truncate">{p.label}</div>
                <select
                  value={chosen || ''}
                  onChange={(e) => setMatchValue(p.id, e.target.value)}
                  disabled={revealed}
                  className="text-sm border rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-nw-teal/30"
                >
                  <option value="">Select...</option>
                  {question.values.map(v => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-400 mb-2">Values (each used once)</div>
        <div className="space-y-2">
          {question.values.map(v => (
            <div key={v.id} className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono text-pnw-slate">
              {v.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─────────────────── RESULTS SCREEN ───────────────────

function ResultsScreen({ team, seasons, score, total, onRetake }) {
  const pct = Math.round((score / total) * 100)
  let headline = 'Nice run!'
  if (pct === 100) headline = 'Perfect score.'
  else if (pct >= 80) headline = 'Big fan energy.'
  else if (pct >= 60) headline = 'Solid showing.'
  else if (pct >= 40) headline = 'Room to grow.'
  else headline = 'Tough one. Try again?'

  return (
    <div className="max-w-xl mx-auto text-center">
      <h1 className="text-2xl sm:text-3xl font-bold text-pnw-slate mb-1">{headline}</h1>
      <p className="text-sm text-gray-500 mb-6">
        {team?.short_name || 'Team'} · {Array.isArray(seasons) ? seasons.join(', ') : seasons}
      </p>
      <div className="inline-flex items-baseline gap-2 mb-8">
        <div className="text-6xl font-bold text-pnw-green">{score}</div>
        <div className="text-2xl text-gray-400">/ {total}</div>
      </div>
      <div className="text-sm text-gray-500 mb-8">{pct}% correct</div>
      <div className="flex gap-3 justify-center">
        <button
          type="button"
          onClick={onRetake}
          className="px-6 py-2.5 bg-pnw-green text-white font-semibold rounded-lg hover:bg-pnw-forest transition-colors"
        >
          Play Again
        </button>
      </div>
    </div>
  )
}
