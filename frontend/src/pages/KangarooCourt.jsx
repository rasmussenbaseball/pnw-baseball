import { useEffect, useState } from 'react'

// Bushnell Kangaroo Court — hidden standalone page, deliberately linked
// nowhere on the site (App.jsx also suppresses the site header/footer for
// /kcourt). Players enter their name + the team password to submit fines.
// The court keeper's password unlocks the full docket (view, delete, add).
//
// Styling is intentionally its own thing: Bushnell navy + gold (pulled
// from the Beacons cap), cartoon-poster fonts, and Iggy the boxing
// kangaroo as the mascot.

const AUTH_KEY = 'kcourt_auth'
const QUICK_AMOUNTS = [1, 2, 3, 4, 5]
const MAX_FILES = 4

const C = {
  navy: '#101a38',
  navyCard: '#1a2750',
  gold: '#f2b52b',
  goldLight: '#ffd35e',
  cream: '#fdf7ea',
  red: '#d94040',
  redDark: '#b32e2e',
  ink: '#22284a',
  tan: '#c98d5a',
  tanLight: '#e9c197',
  tanDark: '#7a4f2c',
}

const FONT_DISPLAY = "'Luckiest Guy', 'Arial Black', sans-serif"
const FONT_BODY = "'Nunito', 'Helvetica Neue', sans-serif"

function useCourtFonts() {
  useEffect(() => {
    const id = 'kcourt-fonts'
    if (document.getElementById(id)) return
    const link = document.createElement('link')
    link.id = id
    link.rel = 'stylesheet'
    link.href =
      'https://fonts.googleapis.com/css2?family=Luckiest+Guy&family=Nunito:wght@400;600;700;800;900&display=swap'
    document.head.appendChild(link)
  }, [])
}

function loadAuth() {
  try {
    return JSON.parse(sessionStorage.getItem(AUTH_KEY)) || null
  } catch {
    return null
  }
}

// ── Iggy the mascot ─────────────────────────────────────────────────────
// Cartoon kangaroo in a boxer's stance: red gloves up, Bushnell navy cap
// with the gold B. Pure SVG so it ships with the bundle.
function KangarooMascot({ style }) {
  return (
    <svg viewBox="0 0 360 400" style={style} aria-label="Iggy, the Kangaroo Court mascot">
      <defs>
        <linearGradient id="kc-glove" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ef5a5a" />
          <stop offset="1" stopColor={C.red} />
        </linearGradient>
      </defs>

      {/* tail */}
      <path
        d="M205 330 Q 300 352 330 290 Q 338 272 320 268 Q 280 310 200 296 Z"
        fill={C.tan}
        stroke={C.tanDark}
        strokeWidth="6"
        strokeLinejoin="round"
      />

      {/* feet */}
      <path
        d="M78 372 Q 74 352 108 350 L 150 356 Q 172 362 170 378 Q 168 392 138 393 L 98 392 Q 80 390 78 372 Z"
        fill={C.tan} stroke={C.tanDark} strokeWidth="6" strokeLinejoin="round"
      />
      <path
        d="M190 374 Q 188 354 220 352 L 262 358 Q 284 364 282 380 Q 280 393 250 394 L 210 393 Q 192 392 190 374 Z"
        fill={C.tan} stroke={C.tanDark} strokeWidth="6" strokeLinejoin="round"
      />

      {/* haunches */}
      <ellipse cx="118" cy="322" rx="44" ry="40" fill={C.tan} stroke={C.tanDark} strokeWidth="6" />
      <ellipse cx="232" cy="324" rx="44" ry="38" fill={C.tan} stroke={C.tanDark} strokeWidth="6" />

      {/* body */}
      <ellipse cx="175" cy="262" rx="72" ry="88" fill={C.tan} stroke={C.tanDark} strokeWidth="6" />
      {/* belly */}
      <ellipse cx="175" cy="282" rx="46" ry="60" fill={C.tanLight} />

      {/* ears (behind cap) */}
      <ellipse cx="128" cy="82" rx="15" ry="34" fill={C.tan} stroke={C.tanDark} strokeWidth="6" transform="rotate(-22 128 82)" />
      <ellipse cx="128" cy="86" rx="7" ry="20" fill="#e8a0a0" transform="rotate(-22 128 86)" />
      <ellipse cx="222" cy="82" rx="15" ry="34" fill={C.tan} stroke={C.tanDark} strokeWidth="6" transform="rotate(22 222 82)" />
      <ellipse cx="222" cy="86" rx="7" ry="20" fill="#e8a0a0" transform="rotate(22 222 86)" />

      {/* head */}
      <ellipse cx="175" cy="138" rx="52" ry="46" fill={C.tan} stroke={C.tanDark} strokeWidth="6" />
      {/* muzzle */}
      <ellipse cx="175" cy="158" rx="32" ry="24" fill={C.tanLight} />
      {/* nose */}
      <ellipse cx="175" cy="146" rx="11" ry="8" fill={C.tanDark} />
      {/* smirk */}
      <path d="M158 168 Q 175 182 192 168" fill="none" stroke={C.tanDark} strokeWidth="5" strokeLinecap="round" />
      {/* eyes */}
      <circle cx="155" cy="126" r="9" fill="#fff" stroke={C.tanDark} strokeWidth="3" />
      <circle cx="195" cy="126" r="9" fill="#fff" stroke={C.tanDark} strokeWidth="3" />
      <circle cx="157" cy="128" r="4" fill={C.ink} />
      <circle cx="193" cy="128" r="4" fill={C.ink} />
      {/* determined brows */}
      <path d="M143 112 L 166 118" stroke={C.tanDark} strokeWidth="5" strokeLinecap="round" />
      <path d="M207 112 L 184 118" stroke={C.tanDark} strokeWidth="5" strokeLinecap="round" />

      {/* Bushnell cap */}
      <path
        d="M126 100 Q 128 58 175 55 Q 222 58 224 100 Q 175 86 126 100 Z"
        fill="#1c2a55" stroke="#0d1530" strokeWidth="5" strokeLinejoin="round"
      />
      <path d="M175 55 L 175 88" stroke="#0d1530" strokeWidth="3" />
      <circle cx="175" cy="55" r="5" fill={C.gold} stroke="#0d1530" strokeWidth="3" />
      {/* brim */}
      <path
        d="M122 97 Q 175 114 228 97 Q 236 104 227 110 Q 175 126 123 110 Q 114 104 122 97 Z"
        fill="#16224a" stroke="#0d1530" strokeWidth="5" strokeLinejoin="round"
      />
      {/* gold B + flame, like the Beacons cap */}
      <text
        x="175" y="92" textAnchor="middle" fill={C.gold} stroke="#0d1530" strokeWidth="1"
        style={{ font: "900 30px 'Nunito', sans-serif" }}
      >
        B
      </text>
      <path d="M186 62 Q 191 54 187 48 Q 196 52 193 62 Q 190 67 186 62 Z" fill={C.goldLight} stroke="#0d1530" strokeWidth="2" />

      {/* left arm + raised glove */}
      <path d="M122 240 Q 90 218 84 186" fill="none" stroke={C.tanDark} strokeWidth="26" strokeLinecap="round" />
      <path d="M122 240 Q 90 218 84 186" fill="none" stroke={C.tan} strokeWidth="18" strokeLinecap="round" />
      <rect x="62" y="166" width="44" height="20" rx="9" fill={C.redDark} stroke="#7e1f1f" strokeWidth="4" transform="rotate(-15 84 176)" />
      <circle cx="80" cy="142" r="30" fill="url(#kc-glove)" stroke="#7e1f1f" strokeWidth="5" />
      <circle cx="102" cy="152" r="12" fill="url(#kc-glove)" stroke="#7e1f1f" strokeWidth="4" />
      <path d="M66 128 Q 78 120 90 126" fill="none" stroke="#ffd9d9" strokeWidth="4" strokeLinecap="round" />

      {/* right arm + jab glove */}
      <path d="M230 244 Q 262 232 278 206" fill="none" stroke={C.tanDark} strokeWidth="26" strokeLinecap="round" />
      <path d="M230 244 Q 262 232 278 206" fill="none" stroke={C.tan} strokeWidth="18" strokeLinecap="round" />
      <rect x="258" y="188" width="44" height="20" rx="9" fill={C.redDark} stroke="#7e1f1f" strokeWidth="4" transform="rotate(20 280 198)" />
      <circle cx="292" cy="172" r="32" fill="url(#kc-glove)" stroke="#7e1f1f" strokeWidth="5" />
      <circle cx="268" cy="188" r="12" fill="url(#kc-glove)" stroke="#7e1f1f" strokeWidth="4" />
      <path d="M282 156 Q 294 148 306 156" fill="none" stroke="#ffd9d9" strokeWidth="4" strokeLinecap="round" />
    </svg>
  )
}

// ── Shared UI bits ──────────────────────────────────────────────────────

const inputStyle = {
  width: '100%',
  borderRadius: 12,
  border: `3px solid ${C.ink}`,
  background: '#fff',
  padding: '10px 14px',
  fontSize: 15,
  fontFamily: FONT_BODY,
  fontWeight: 600,
  color: C.ink,
  outline: 'none',
}

const labelStyle = {
  display: 'block',
  fontFamily: FONT_BODY,
  fontWeight: 800,
  fontSize: 14,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: C.ink,
  marginBottom: 6,
}

function Card({ children, style }) {
  return (
    <div
      style={{
        background: C.cream,
        borderRadius: 22,
        border: `4px solid ${C.ink}`,
        boxShadow: `8px 8px 0 rgba(0,0,0,0.35)`,
        padding: 24,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

function GoldButton({ children, style, ...props }) {
  return (
    <button
      {...props}
      style={{
        background: `linear-gradient(180deg, ${C.goldLight}, ${C.gold})`,
        color: C.ink,
        fontFamily: FONT_DISPLAY,
        fontSize: 18,
        letterSpacing: '0.04em',
        border: `3px solid ${C.ink}`,
        borderRadius: 14,
        padding: '12px 22px',
        cursor: 'pointer',
        boxShadow: '4px 4px 0 rgba(0,0,0,0.35)',
        opacity: props.disabled ? 0.5 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  )
}

// ── Page ────────────────────────────────────────────────────────────────

export default function KangarooCourt() {
  useCourtFonts()
  const [auth, setAuth] = useState(loadAuth)

  // Paint the document itself navy so overscroll bounce doesn't flash the
  // site's cream background behind this standalone page.
  useEffect(() => {
    const prev = document.documentElement.style.background
    document.documentElement.style.background = C.navy
    return () => {
      document.documentElement.style.background = prev
    }
  }, [])

  const handleLogout = () => {
    sessionStorage.removeItem(AUTH_KEY)
    setAuth(null)
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: `radial-gradient(ellipse 80% 50% at 50% -10%, #24356e 0%, ${C.navy} 60%)`,
        fontFamily: FONT_BODY,
        padding: '32px 16px 80px',
      }}
    >
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        {/* Hero */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <KangarooMascot
            style={{ width: 210, height: 'auto', margin: '0 auto', display: 'block', animation: 'kc-bounce 2.4s ease-in-out infinite' }}
          />
          <style>{`
            @keyframes kc-bounce {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-10px); }
            }
          `}</style>
          <h1
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: 'clamp(34px, 7vw, 58px)',
              color: C.gold,
              textShadow: `3px 3px 0 ${C.ink}, 6px 6px 0 rgba(0,0,0,0.4)`,
              margin: '10px 0 4px',
              lineHeight: 1.2,
            }}
          >
            Bushnell Kangaroo Court
          </h1>
          <p style={{ color: '#aab6dd', fontWeight: 700, fontSize: 15, margin: 0 }}>
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
    <form onSubmit={submit} style={{ maxWidth: 420, margin: '0 auto' }}>
      <Card>
        <label style={labelStyle}>Your name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="First and last name"
          style={{ ...inputStyle, marginBottom: 16 }}
          autoComplete="off"
        />
        <label style={labelStyle}>Court password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          style={{ ...inputStyle, marginBottom: 16 }}
        />
        {error && (
          <p style={{ color: C.red, fontWeight: 800, fontSize: 14, margin: '0 0 12px' }}>{error}</p>
        )}
        <GoldButton type="submit" disabled={busy || !name.trim() || !password} style={{ width: '100%' }}>
          {busy ? 'Checking...' : 'Enter the court'}
        </GoldButton>
      </Card>
    </form>
  )
}

function SignedInBar({ auth, onLogout }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        color: '#aab6dd',
        fontSize: 13,
        fontWeight: 700,
        margin: '0 4px 14px',
      }}
    >
      <span>
        Signed in as <span style={{ color: '#fff' }}>{auth.name}</span>
        {auth.role === 'admin' && (
          <span
            style={{
              marginLeft: 8,
              background: C.gold,
              color: C.ink,
              borderRadius: 999,
              padding: '2px 10px',
              fontWeight: 900,
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Court Keeper
          </span>
        )}
      </span>
      <button
        onClick={onLogout}
        style={{
          background: 'none',
          border: 'none',
          color: '#aab6dd',
          textDecoration: 'underline',
          cursor: 'pointer',
          fontWeight: 700,
          fontSize: 13,
          fontFamily: FONT_BODY,
        }}
      >
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
    const finalPlayers =
      playerInput.trim() && !players.includes(playerInput.trim())
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

  const amountBtn = (selected) => ({
    borderRadius: 12,
    padding: '10px 18px',
    fontFamily: FONT_DISPLAY,
    fontSize: 17,
    cursor: 'pointer',
    border: `3px solid ${C.ink}`,
    background: selected ? C.ink : '#fff',
    color: selected ? C.gold : C.ink,
    boxShadow: selected ? 'none' : '3px 3px 0 rgba(0,0,0,0.2)',
  })

  return (
    <form onSubmit={submit}>
      <Card>
        <label style={labelStyle}>Who is getting fined?</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
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
            style={{ ...inputStyle, flex: 1 }}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={addPlayer}
            style={{
              borderRadius: 12,
              border: `3px solid ${C.ink}`,
              background: '#fff',
              color: C.ink,
              fontWeight: 900,
              fontFamily: FONT_BODY,
              fontSize: 14,
              padding: '0 18px',
              cursor: 'pointer',
              boxShadow: '3px 3px 0 rgba(0,0,0,0.2)',
            }}
          >
            Add
          </button>
        </div>
        {players.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            {players.map((p) => (
              <span
                key={p}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: C.red,
                  color: '#fff',
                  borderRadius: 999,
                  border: `2px solid ${C.ink}`,
                  padding: '4px 12px',
                  fontSize: 13,
                  fontWeight: 900,
                }}
              >
                {p}
                <button
                  type="button"
                  onClick={() => setPlayers(players.filter((x) => x !== p))}
                  aria-label={`Remove ${p}`}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#fff',
                    cursor: 'pointer',
                    fontWeight: 900,
                    padding: 0,
                  }}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        <label style={{ ...labelStyle, marginTop: 6 }}>Fine amount</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          {QUICK_AMOUNTS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => {
                setAmount(a)
                setCustomAmount('')
              }}
              style={amountBtn(customAmount === '' && amount === a)}
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
            style={{ ...inputStyle, width: 100 }}
          />
        </div>

        <label style={labelStyle}>What did they do?</label>
        <textarea
          value={explanation}
          onChange={(e) => setExplanation(e.target.value)}
          rows={3}
          placeholder="State your case. The court appreciates detail."
          style={{ ...inputStyle, marginBottom: 16, resize: 'vertical' }}
        />

        <label style={labelStyle}>Proof (optional)</label>
        <p style={{ fontSize: 12, color: '#6b7290', fontWeight: 700, margin: '0 0 8px' }}>
          Photos or videos, up to {MAX_FILES} files, 50 MB each.
        </p>
        <input
          type="file"
          accept="image/*,video/*"
          multiple
          onChange={pickFiles}
          style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}
        />
        {files.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: C.ink }}>
            {files.map((f, i) => (
              <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  📎 {f.name}
                </span>
                <button
                  type="button"
                  onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: C.red,
                    cursor: 'pointer',
                    fontWeight: 900,
                    textDecoration: 'underline',
                    fontFamily: FONT_BODY,
                    flexShrink: 0,
                  }}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && (
          <p style={{ color: C.red, fontWeight: 800, fontSize: 14, margin: '0 0 12px' }}>{error}</p>
        )}

        <GoldButton type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Filing with the court...' : 'Submit fine'}
        </GoldButton>
      </Card>
    </form>
  )
}

function PlayerView({ auth, onLogout }) {
  const [submitted, setSubmitted] = useState(false)

  return (
    <div>
      <SignedInBar auth={auth} onLogout={onLogout} />
      {submitted ? (
        <Card style={{ textAlign: 'center', padding: 36 }}>
          <div style={{ fontSize: 44, marginBottom: 6 }}>🔨</div>
          <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 26, color: C.ink, margin: '0 0 6px' }}>
            Fine submitted
          </h2>
          <p style={{ color: '#6b7290', fontWeight: 700, fontSize: 14, margin: '0 0 18px' }}>
            Your case is on the docket. It will be voted on at the next session of the court.
          </p>
          <GoldButton onClick={() => setSubmitted(false)}>File another fine</GoldButton>
        </Card>
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

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
          gap: 12,
        }}
      >
        <div>
          <h2
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: 30,
              color: C.gold,
              textShadow: `2px 2px 0 ${C.ink}`,
              margin: 0,
            }}
          >
            The Docket
          </h2>
          {fines && (
            <p style={{ color: '#aab6dd', fontWeight: 700, fontSize: 13, margin: '2px 0 0' }}>
              {fines.length} pending fine{fines.length === 1 ? '' : 's'}, ${total.toFixed(2)} on the table
            </p>
          )}
        </div>
        <GoldButton onClick={() => setShowForm(!showForm)} style={{ fontSize: 15, padding: '10px 16px' }}>
          {showForm ? 'Hide form' : '+ Add a fine'}
        </GoldButton>
      </div>

      {showForm && (
        <div style={{ marginBottom: 22 }}>
          <FineForm
            auth={auth}
            onSubmitted={() => {
              setShowForm(false)
              refresh()
            }}
          />
        </div>
      )}

      {error && (
        <p style={{ color: '#ff8484', fontWeight: 800, fontSize: 14, margin: '0 0 12px' }}>{error}</p>
      )}

      {fines === null ? (
        <p style={{ color: '#aab6dd', fontWeight: 700, textAlign: 'center', padding: '40px 0' }}>
          Loading the docket...
        </p>
      ) : fines.length === 0 ? (
        <Card style={{ textAlign: 'center' }}>
          <p style={{ color: '#6b7290', fontWeight: 700, margin: 0 }}>
            The docket is empty. A well-behaved team, or a quiet snitch network.
          </p>
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {fines.map((fine) => (
            <Card key={fine.id} style={{ padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                <div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    {fine.fined_players.map((p) => (
                      <span
                        key={p}
                        style={{
                          background: C.red,
                          color: '#fff',
                          borderRadius: 999,
                          border: `2px solid ${C.ink}`,
                          padding: '3px 12px',
                          fontSize: 12,
                          fontWeight: 900,
                        }}
                      >
                        {p}
                      </span>
                    ))}
                    <span style={{ fontFamily: FONT_DISPLAY, fontSize: 24, color: C.ink }}>
                      ${Number(fine.amount).toFixed(2).replace(/\.00$/, '')}
                    </span>
                  </div>
                  <p style={{ fontSize: 12, color: '#8a90ad', fontWeight: 700, margin: 0 }}>
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
                  style={{
                    background: '#fff',
                    border: `3px solid ${C.red}`,
                    borderRadius: 10,
                    color: C.red,
                    fontWeight: 900,
                    fontFamily: FONT_BODY,
                    fontSize: 12,
                    padding: '6px 12px',
                    cursor: 'pointer',
                    flexShrink: 0,
                    opacity: deleting === fine.id ? 0.5 : 1,
                  }}
                >
                  {deleting === fine.id ? 'Deleting...' : 'Delete'}
                </button>
              </div>
              <p style={{ fontSize: 15, color: C.ink, fontWeight: 600, whiteSpace: 'pre-wrap', margin: 0 }}>
                {fine.explanation}
              </p>
              {fine.media && fine.media.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
                  {fine.media.map((m, i) =>
                    m.type === 'video' ? (
                      <video
                        key={i}
                        src={m.url}
                        controls
                        style={{ maxHeight: 256, borderRadius: 12, border: `3px solid ${C.ink}` }}
                      />
                    ) : (
                      <a key={i} href={m.url} target="_blank" rel="noreferrer">
                        <img
                          src={m.url}
                          alt={m.filename || 'proof'}
                          style={{ maxHeight: 192, borderRadius: 12, border: `3px solid ${C.ink}` }}
                        />
                      </a>
                    )
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
