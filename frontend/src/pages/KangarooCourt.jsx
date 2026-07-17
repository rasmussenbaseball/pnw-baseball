import { useEffect, useState } from 'react'

// Bushnell Kangaroo Court — hidden page, deliberately linked nowhere on the
// site. Players enter their name + the team password to submit fines.
// The court keeper's password unlocks the full docket (view, delete, add).

const AUTH_KEY = 'kcourt_auth'
const QUICK_AMOUNTS = [1, 2, 3, 4, 5]
const MAX_FILES = 4

function loadAuth() {
  try {
    return JSON.parse(sessionStorage.getItem(AUTH_KEY)) || null
  } catch {
    return null
  }
}

export default function KangarooCourt() {
  const [auth, setAuth] = useState(loadAuth)

  const handleLogout = () => {
    sessionStorage.removeItem(AUTH_KEY)
    setAuth(null)
  }

  return (
    <div className="max-w-3xl mx-auto pb-16">
      <div className="text-center mt-4 mb-8">
        <div className="text-5xl mb-2">🦘⚖️</div>
        <h1 className="text-3xl font-extrabold text-nw-teal dark:text-gray-100 tracking-tight">
          Bushnell Kangaroo Court
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          The court is always in session. Fines are final (pending a team vote).
        </p>
      </div>

      {!auth ? (
        <LoginCard
          onLogin={(a) => {
            sessionStorage.setItem(AUTH_KEY, JSON.stringify(a))
            setAuth(a)
          }}
        />
      ) : auth.role === 'admin' ? (
        <AdminView auth={auth} onLogout={handleLogout} />
      ) : (
        <PlayerView auth={auth} onLogout={handleLogout} />
      )}
    </div>
  )
}

function LoginCard({ onLogin }) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!name.trim() || !password) return
    setBusy(true)
    setError(null)
    try {
      const resp = await fetch('/api/v1/kcourt/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), password }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.detail || 'Login failed')
      onLogin({ name: data.name, role: data.role, password })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 max-w-md mx-auto"
    >
      <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
        Your name
      </label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="First and last name"
        className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-nw-teal"
        autoComplete="off"
      />
      <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
        Court password
      </label>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-nw-teal"
      />
      {error && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>}
      <button
        type="submit"
        disabled={busy || !name.trim() || !password}
        className="w-full bg-nw-teal text-white font-semibold rounded-lg py-2 text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {busy ? 'Checking...' : 'Enter the court'}
      </button>
    </form>
  )
}

function SignedInBar({ auth, onLogout }) {
  return (
    <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-4">
      <span>
        Signed in as <span className="font-semibold text-gray-700 dark:text-gray-200">{auth.name}</span>
        {auth.role === 'admin' && (
          <span className="ml-2 inline-block bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 rounded-full px-2 py-0.5 font-semibold">
            Court Keeper
          </span>
        )}
      </span>
      <button onClick={onLogout} className="underline hover:text-nw-teal">
        Sign out
      </button>
    </div>
  )
}

function FineForm({ auth, onSubmitted }) {
  const [players, setPlayers] = useState([])
  const [playerInput, setPlayerInput] = useState('')
  const [amount, setAmount] = useState(1)
  const [customAmount, setCustomAmount] = useState('')
  const [explanation, setExplanation] = useState('')
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const addPlayer = () => {
    const p = playerInput.trim()
    if (p && !players.includes(p)) setPlayers([...players, p])
    setPlayerInput('')
  }

  const effectiveAmount = customAmount !== '' ? parseFloat(customAmount) : amount

  const pickFiles = (e) => {
    const picked = Array.from(e.target.files || [])
    const merged = [...files, ...picked].slice(0, MAX_FILES)
    const tooBig = merged.find((f) => f.size > 50 * 1024 * 1024)
    if (tooBig) {
      setError(`${tooBig.name} is over the 50 MB limit`)
      return
    }
    setError(null)
    setFiles(merged)
    e.target.value = ''
  }

  const submit = async (e) => {
    e.preventDefault()
    const finalPlayers = playerInput.trim() && !players.includes(playerInput.trim())
      ? [...players, playerInput.trim()]
      : players
    if (!finalPlayers.length) {
      setError('Add at least one player to fine')
      return
    }
    if (!(effectiveAmount > 0)) {
      setError('Pick a fine amount')
      return
    }
    if (!explanation.trim()) {
      setError('The court demands an explanation')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('password', auth.password)
      form.append('submitted_by', auth.name)
      form.append('fined_players', JSON.stringify(finalPlayers))
      form.append('amount', String(effectiveAmount))
      form.append('explanation', explanation.trim())
      files.forEach((f) => form.append('files', f))
      const resp = await fetch('/api/v1/kcourt/fines', { method: 'POST', body: form })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.detail || 'Submission failed')
      setPlayers([])
      setPlayerInput('')
      setAmount(1)
      setCustomAmount('')
      setExplanation('')
      setFiles([])
      onSubmitted()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6"
    >
      <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
        Who is getting fined?
      </label>
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          value={playerInput}
          onChange={(e) => setPlayerInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addPlayer()
            }
          }}
          placeholder="Player name (add one or more)"
          className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-nw-teal"
          autoComplete="off"
        />
        <button
          type="button"
          onClick={addPlayer}
          className="bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-sm font-semibold rounded-lg px-4 hover:bg-gray-200 dark:hover:bg-gray-600"
        >
          Add
        </button>
      </div>
      {players.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {players.map((p) => (
            <span
              key={p}
              className="inline-flex items-center gap-1 bg-nw-teal/10 text-nw-teal dark:bg-teal-900/40 dark:text-teal-300 rounded-full px-3 py-1 text-xs font-semibold"
            >
              {p}
              <button
                type="button"
                onClick={() => setPlayers(players.filter((x) => x !== p))}
                className="hover:opacity-70"
                aria-label={`Remove ${p}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1 mt-2">
        Fine amount
      </label>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {QUICK_AMOUNTS.map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => {
              setAmount(a)
              setCustomAmount('')
            }}
            className={`rounded-lg px-4 py-2 text-sm font-bold border transition-colors ${
              customAmount === '' && amount === a
                ? 'bg-nw-teal text-white border-nw-teal'
                : 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 hover:border-nw-teal'
            }`}
          >
            ${a}
          </button>
        ))}
        <input
          type="number"
          min="0.5"
          max="100"
          step="0.5"
          value={customAmount}
          onChange={(e) => setCustomAmount(e.target.value)}
          placeholder="Other $"
          className="w-24 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-nw-teal"
        />
      </div>

      <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
        What did they do?
      </label>
      <textarea
        value={explanation}
        onChange={(e) => setExplanation(e.target.value)}
        rows={3}
        placeholder="State your case. The court appreciates detail."
        className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-nw-teal"
      />

      <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
        Proof (optional)
      </label>
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">
        Photos or videos, up to {MAX_FILES} files, 50 MB each.
      </p>
      <input
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={pickFiles}
        className="block w-full text-sm text-gray-500 dark:text-gray-400 mb-2 file:mr-3 file:rounded-lg file:border-0 file:bg-nw-teal/10 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-nw-teal hover:file:bg-nw-teal/20"
      />
      {files.length > 0 && (
        <ul className="text-xs text-gray-600 dark:text-gray-300 mb-3 space-y-1">
          {files.map((f, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="truncate">📎 {f.name}</span>
              <button
                type="button"
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
                className="text-red-500 hover:underline shrink-0"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="w-full bg-nw-teal text-white font-semibold rounded-lg py-2.5 text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {busy ? 'Filing with the court...' : 'Submit fine'}
      </button>
    </form>
  )
}

function PlayerView({ auth, onLogout }) {
  const [submitted, setSubmitted] = useState(false)

  return (
    <div>
      <SignedInBar auth={auth} onLogout={onLogout} />
      {submitted ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-green-200 dark:border-green-800 p-8 text-center">
          <div className="text-4xl mb-2">🔨</div>
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-1">
            Fine submitted
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Your case is on the docket. It will be voted on at the next session of the court.
          </p>
          <button
            onClick={() => setSubmitted(false)}
            className="bg-nw-teal text-white font-semibold rounded-lg px-5 py-2 text-sm hover:opacity-90"
          >
            File another fine
          </button>
        </div>
      ) : (
        <FineForm auth={auth} onSubmitted={() => setSubmitted(true)} />
      )}
    </div>
  )
}

function AdminView({ auth, onLogout }) {
  const [fines, setFines] = useState(null)
  const [error, setError] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [deleting, setDeleting] = useState(null)

  const refresh = async () => {
    try {
      const resp = await fetch(
        `/api/v1/kcourt/fines?password=${encodeURIComponent(auth.password)}&_t=${Date.now()}`
      )
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.detail || 'Failed to load fines')
      setFines(data.fines)
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const handleDelete = async (id) => {
    if (!window.confirm('Throw this case out of court? This permanently deletes it.')) return
    setDeleting(id)
    try {
      const resp = await fetch(
        `/api/v1/kcourt/fines/${id}?password=${encodeURIComponent(auth.password)}`,
        { method: 'DELETE' }
      )
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.detail || 'Delete failed')
      setFines((prev) => prev.filter((f) => f.id !== id))
    } catch (err) {
      setError(err.message)
    } finally {
      setDeleting(null)
    }
  }

  const total = (fines || []).reduce((sum, f) => sum + Number(f.amount), 0)

  return (
    <div>
      <SignedInBar auth={auth} onLogout={onLogout} />

      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">The Docket</h2>
          {fines && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {fines.length} pending fine{fines.length === 1 ? '' : 's'}, ${total.toFixed(2)} on
              the table
            </p>
          )}
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="bg-nw-teal text-white font-semibold rounded-lg px-4 py-2 text-sm hover:opacity-90"
        >
          {showForm ? 'Hide form' : '+ Add a fine'}
        </button>
      </div>

      {showForm && (
        <div className="mb-6">
          <FineForm
            auth={auth}
            onSubmitted={() => {
              setShowForm(false)
              refresh()
            }}
          />
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>}

      {fines === null ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
          Loading the docket...
        </p>
      ) : fines.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
          The docket is empty. A well-behaved team, or a quiet snitch network.
        </p>
      ) : (
        <div className="space-y-4">
          {fines.map((fine) => (
            <div
              key={fine.id}
              className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-5"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    {fine.fined_players.map((p) => (
                      <span
                        key={p}
                        className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-full px-3 py-0.5 text-xs font-bold"
                      >
                        {p}
                      </span>
                    ))}
                    <span className="text-lg font-extrabold text-gray-900 dark:text-gray-100">
                      ${Number(fine.amount).toFixed(2).replace(/\.00$/, '')}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    Filed by {fine.submitted_by} on{' '}
                    {new Date(fine.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(fine.id)}
                  disabled={deleting === fine.id}
                  className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-300 font-semibold shrink-0 disabled:opacity-50"
                >
                  {deleting === fine.id ? 'Deleting...' : 'Delete'}
                </button>
              </div>
              <p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap">
                {fine.explanation}
              </p>
              {fine.media && fine.media.length > 0 && (
                <div className="flex flex-wrap gap-3 mt-3">
                  {fine.media.map((m, i) =>
                    m.type === 'video' ? (
                      <video
                        key={i}
                        src={m.url}
                        controls
                        className="max-h-64 rounded-lg border border-gray-200 dark:border-gray-700"
                      />
                    ) : (
                      <a key={i} href={m.url} target="_blank" rel="noreferrer">
                        <img
                          src={m.url}
                          alt={m.filename || 'proof'}
                          className="max-h-48 rounded-lg border border-gray-200 dark:border-gray-700"
                        />
                      </a>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
