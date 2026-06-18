// CommitmentEditor — /commitment-editor  (dev/intern only, gated by <RequireDev>)
//
// Lets developers + interns search any NWAC or transfer player and set or undo
// their commitment status. Writes go straight to the DB via the dev-gated
// /admin/commitment/* endpoints and show up immediately on the NWAC commitments
// tracker, the JUCO/transfer trackers, and the player's profile badge.

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'

const API_BASE = '/api/v1'

async function authHeaders() {
  const { data } = await supabase.auth.getSession()
  const t = data?.session?.access_token
  return t ? { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }
}

function StatusChip({ player }) {
  if (player.is_committed && player.committed_to) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
        ✓ {player.committed_to}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
      Uncommitted
    </span>
  )
}

function PlayerRow({ player, onChanged, setToast }) {
  const [school, setSchool] = useState(player.committed_to || '')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const val = school.trim()
    if (!val) { setToast({ type: 'err', msg: 'Enter a school first.' }); return }
    setBusy(true)
    try {
      const res = await fetch(`${API_BASE}/admin/commitment/set`, {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({ player_id: player.id, committed_to: val }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
      setToast({ type: 'ok', msg: `${player.name} → ${val}` })
      onChanged(player.id, { is_committed: true, committed_to: val })
    } catch (e) { setToast({ type: 'err', msg: e.message }) }
    finally { setBusy(false) }
  }

  const undo = async () => {
    setBusy(true)
    try {
      const res = await fetch(`${API_BASE}/admin/commitment/clear`, {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({ player_id: player.id }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
      setToast({ type: 'ok', msg: `${player.name} marked uncommitted` })
      setSchool('')
      onChanged(player.id, { is_committed: false, committed_to: null })
    } catch (e) { setToast({ type: 'err', msg: e.message }) }
    finally { setBusy(false) }
  }

  const meta = [player.position, player.team_short, player.division_level,
    [player.bats, player.throws].filter(Boolean).join('/'), player.year_in_school]
    .filter(Boolean).join(' · ')

  return (
    <div className="flex flex-wrap items-center gap-3 p-3 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
      {player.logo_url
        ? <img src={player.logo_url} alt="" className="w-9 h-9 object-contain flex-shrink-0" />
        : <div className="w-9 h-9 rounded bg-gray-100 dark:bg-gray-700 flex-shrink-0" />}
      <div className="min-w-[180px] flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-gray-900 dark:text-gray-100">{player.name}</span>
          <StatusChip player={player} />
        </div>
        <div className="text-xs text-gray-500">{meta}</div>
      </div>
      <input
        value={school}
        onChange={e => setSchool(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save() }}
        placeholder="New school / commitment"
        className="px-2.5 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 text-sm bg-white dark:bg-gray-900 w-48"
      />
      <button onClick={save} disabled={busy}
        className="px-3 py-1.5 rounded-md bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-50">
        {busy ? '…' : 'Save'}
      </button>
      {player.is_committed && (
        <button onClick={undo} disabled={busy}
          className="px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 text-sm font-semibold text-gray-600 dark:text-gray-300 hover:border-red-400 hover:text-red-600 disabled:opacity-50">
          Undo
        </button>
      )}
    </div>
  )
}

export default function CommitmentEditor() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [recent, setRecent] = useState([])
  const [toast, setToast] = useState(null)
  const debounceRef = useRef(null)

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/commitment/recent`, { headers: await authHeaders() })
      if (res.ok) setRecent(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadRecent() }, [loadRecent])

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`${API_BASE}/admin/commitment/search?q=${encodeURIComponent(q.trim())}`, { headers: await authHeaders() })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setResults(await res.json())
      } catch { setResults([]) }
      finally { setSearching(false) }
    }, 280)
    return () => clearTimeout(debounceRef.current)
  }, [q])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  // Apply an edit to the in-memory results + refresh the recent list.
  const onChanged = (playerId, patch) => {
    setResults(rs => rs.map(p => p.id === playerId ? { ...p, ...patch } : p))
    loadRecent()
  }

  const fmtTime = (s) => {
    try { return new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }
    catch { return s }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">Commitment Editor</h1>
      <p className="text-sm text-gray-500 mb-4">
        Search any NWAC or transfer player and set or undo their commitment. Changes go live immediately
        on the trackers and the player's profile. Every edit is logged.
      </p>

      {toast && (
        <div className={`mb-3 p-2.5 rounded text-sm border ${toast.type === 'ok'
          ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
          : 'bg-red-50 text-red-700 border-red-200'}`}>
          {toast.type === 'ok' ? '✓ ' : '⚠ '}{toast.msg}
        </div>
      )}

      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        autoFocus
        placeholder="Search a player by name…"
        className="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 mb-3"
      />

      <div className="space-y-2 mb-8">
        {searching && <div className="text-sm text-gray-400 py-4 text-center">Searching…</div>}
        {!searching && q.trim().length >= 2 && results.length === 0 && (
          <div className="text-sm text-gray-400 py-4 text-center">No players found.</div>
        )}
        {results.map(p => (
          <PlayerRow key={p.id} player={p} onChanged={onChanged} setToast={setToast} />
        ))}
      </div>

      {recent.length > 0 && (
        <div>
          <h2 className="text-sm font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">Recent edits</h2>
          <div className="space-y-1.5">
            {recent.map(r => (
              <div key={r.id} className="flex flex-wrap items-center gap-x-2 text-sm text-gray-600 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800 pb-1.5">
                <span className="font-medium text-gray-800 dark:text-gray-200">{r.name || `Player ${r.player_id}`}</span>
                {r.team_short && <span className="text-gray-400">({r.team_short})</span>}
                {r.action === 'set'
                  ? <span>→ <span className="text-emerald-700 font-medium">{r.new_committed_to}</span></span>
                  : <span className="text-red-500">uncommitted{r.old_committed_to ? ` (was ${r.old_committed_to})` : ''}</span>}
                <span className="text-gray-400 ml-auto text-xs">{r.editor_email} · {fmtTime(r.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
