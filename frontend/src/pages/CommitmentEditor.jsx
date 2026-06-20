// CommitmentEditor — /commitment-editor  (dev/intern only, gated by <RequireDev>)
//
// Three dev tools in one page:
//   • Commitments & Portal — search a player; set/clear commitment (PNW schools
//     autocomplete to a canonical name so they land on the right 2027 roster),
//     and add/remove them from the Transfer Portal Tracker.
//   • Link Pages — search two player records (spring or summer) and link them
//     (spring+spring or summer+spring), or unlink.
// All writes hit the dev-gated /admin/* endpoints and are live + logged.

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'

const API_BASE = '/api/v1'

async function authHeaders() {
  const { data } = await supabase.auth.getSession()
  const t = data?.session?.access_token
  return t ? { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }
}
async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: await authHeaders() })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
  return res.json()
}
async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
  return res.json()
}

const fmtTime = (s) => {
  try { return new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }
  catch { return s }
}
const playerMeta = (p) => [p.position, p.team_short, p.division_level,
  [p.bats, p.throws].filter(Boolean).join('/'), p.year_in_school].filter(Boolean).join(' · ')

// ── PNW school autocomplete field ──
function PnwSchoolField({ value, onChange, pnwTeams }) {
  const [open, setOpen] = useState(false)
  const ql = (value || '').trim().toLowerCase()
  const matches = ql.length >= 1
    ? pnwTeams.filter(t => `${t.short_name} ${t.school_name}`.toLowerCase().includes(ql)).slice(0, 8)
    : []
  return (
    <div className="relative">
      <input
        value={value}
        onChange={e => { onChange(e.target.value, null); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="New school / commitment"
        className="px-2.5 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 text-sm bg-white dark:bg-gray-900 w-52"
      />
      {open && matches.length > 0 && (
        <div className="absolute z-20 mt-1 w-64 max-h-60 overflow-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg">
          {matches.map(t => (
            <button key={t.id} type="button"
              onMouseDown={() => { onChange(t.short_name, t.id); setOpen(false) }}
              className="block w-full text-left px-2.5 py-1.5 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 text-sm">
              <span className="font-medium text-gray-900 dark:text-gray-100">{t.short_name}</span>
              <span className="text-gray-400 text-xs ml-1.5">{t.school_name} · {t.level}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusChip({ committed, school }) {
  if (committed && school) return <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">✓ {school}</span>
  return <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">Uncommitted</span>
}

// ── Commitment + portal row ──
function PlayerRow({ player, pnwTeams, onChanged, setToast }) {
  const [school, setSchool] = useState(player.committed_to || '')
  const [teamId, setTeamId] = useState(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn) => { setBusy(true); try { await fn() } catch (e) { setToast({ type: 'err', msg: e.message }) } finally { setBusy(false) } }

  const save = () => run(async () => {
    const val = school.trim()
    if (!val) { setToast({ type: 'err', msg: 'Enter a school first.' }); return }
    const r = await apiPost('/admin/commitment/set', { player_id: player.id, committed_to: val, committed_team_id: teamId })
    setToast({ type: 'ok', msg: `${player.name} → ${r.committed_to}${r.matched_pnw ? ' (PNW — on 2027 roster)' : ''}` })
    onChanged(player.id, { is_committed: true, committed_to: r.committed_to })
  })
  const undo = () => run(async () => {
    await apiPost('/admin/commitment/clear', { player_id: player.id })
    setToast({ type: 'ok', msg: `${player.name} marked uncommitted` }); setSchool('')
    onChanged(player.id, { is_committed: false, committed_to: null })
  })
  const togglePortal = () => run(async () => {
    const r = await apiPost(player.in_portal ? '/admin/portal/remove' : '/admin/portal/add', { player_id: player.id })
    setToast({ type: 'ok', msg: `${player.name} ${r.in_portal ? 'added to' : 'removed from'} portal` })
    onChanged(player.id, { in_portal: r.in_portal })
  })

  return (
    <div className="flex flex-wrap items-center gap-3 p-3 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
      {player.logo_url ? <img src={player.logo_url} alt="" className="w-9 h-9 object-contain flex-shrink-0" /> : <div className="w-9 h-9 rounded bg-gray-100 dark:bg-gray-700 flex-shrink-0" />}
      <div className="min-w-[170px] flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-gray-900 dark:text-gray-100">{player.name}</span>
          <StatusChip committed={player.is_committed} school={player.committed_to} />
          {player.in_portal && <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">In portal</span>}
        </div>
        <div className="text-xs text-gray-500">{playerMeta(player)}</div>
      </div>
      <PnwSchoolField value={school} onChange={(v, id) => { setSchool(v); setTeamId(id) }} pnwTeams={pnwTeams} />
      <button onClick={save} disabled={busy} className="px-3 py-1.5 rounded-md bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-50">Save</button>
      {player.is_committed && (
        <button onClick={undo} disabled={busy} className="px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 text-sm font-semibold text-gray-600 dark:text-gray-300 hover:border-red-400 hover:text-red-600 disabled:opacity-50">Undo</button>
      )}
      <button onClick={togglePortal} disabled={busy}
        className={`px-3 py-1.5 rounded-md text-sm font-semibold border disabled:opacity-50 ${player.in_portal
          ? 'border-amber-300 text-amber-700 hover:bg-amber-50'
          : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-amber-400 hover:text-amber-700'}`}>
        {player.in_portal ? 'Remove from portal' : 'Add to portal'}
      </button>
    </div>
  )
}

function CommitmentsTab({ pnwTeams, setToast }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [recent, setRecent] = useState([])
  const debounceRef = useRef(null)

  const loadRecent = useCallback(async () => { try { setRecent(await apiGet('/admin/commitment/recent')) } catch { /* */ } }, [])
  useEffect(() => { loadRecent() }, [loadRecent])

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try { setResults(await apiGet(`/admin/commitment/search?q=${encodeURIComponent(q.trim())}`)) }
      catch { setResults([]) } finally { setSearching(false) }
    }, 280)
    return () => clearTimeout(debounceRef.current)
  }, [q])

  const onChanged = (id, patch) => { setResults(rs => rs.map(p => p.id === id ? { ...p, ...patch } : p)); loadRecent() }

  return (
    <>
      <input value={q} onChange={e => setQ(e.target.value)} autoFocus placeholder="Search a player by name…"
        className="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 mb-3" />
      <div className="space-y-2 mb-8">
        {searching && <div className="text-sm text-gray-400 py-4 text-center">Searching…</div>}
        {!searching && q.trim().length >= 2 && results.length === 0 && <div className="text-sm text-gray-400 py-4 text-center">No players found.</div>}
        {results.map(p => <PlayerRow key={p.id} player={p} pnwTeams={pnwTeams} onChanged={onChanged} setToast={setToast} />)}
      </div>
      {recent.length > 0 && (
        <div>
          <h2 className="text-sm font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">Recent edits</h2>
          <div className="space-y-1.5">
            {recent.map(r => (
              <div key={r.id} className="flex flex-wrap items-center gap-x-2 text-sm text-gray-600 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800 pb-1.5">
                <span className="font-medium text-gray-800 dark:text-gray-200">{r.name || `Player ${r.player_id}`}</span>
                {r.team_short && <span className="text-gray-400">({r.team_short})</span>}
                {r.action === 'set' && <span>→ <span className="text-emerald-700 font-medium">{r.new_committed_to}</span></span>}
                {r.action === 'clear' && <span className="text-red-500">uncommitted{r.old_committed_to ? ` (was ${r.old_committed_to})` : ''}</span>}
                {r.action === 'portal_add' && <span className="text-amber-600">added to portal</span>}
                {r.action === 'portal_remove' && <span className="text-gray-500">removed from portal</span>}
                <span className="text-gray-400 ml-auto text-xs">{r.editor_email} · {fmtTime(r.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

// ── Link-pages tab ──
function LinkSearchBox({ label, selected, onSelect, onUnlinked, setToast }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef(null)

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try { setResults(await apiGet(`/admin/link/search?q=${encodeURIComponent(q.trim())}`)) }
      catch { setResults([]) } finally { setSearching(false) }
    }, 280)
    return () => clearTimeout(debounceRef.current)
  }, [q])

  const unlink = async (lk) => {
    try { await apiPost('/admin/link/remove', { table: lk.table, link_id: lk.link_id }); setToast({ type: 'ok', msg: 'Unlinked' }); onUnlinked() }
    catch (e) { setToast({ type: 'err', msg: e.message }) }
  }

  return (
    <div className="flex-1 min-w-[280px]">
      <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">{label}</div>
      {selected ? (
        <div className="p-3 border-2 border-emerald-500 rounded-lg bg-emerald-50/40 dark:bg-emerald-900/20">
          <div className="flex items-center justify-between gap-2">
            <div>
              <span className="font-semibold text-gray-900 dark:text-gray-100">{selected.name}</span>
              <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${selected.kind === 'summer' ? 'bg-sky-100 text-sky-700' : 'bg-gray-100 text-gray-600'}`}>{selected.kind}</span>
              <div className="text-xs text-gray-500">{playerMeta(selected)}</div>
            </div>
            <button onClick={() => onSelect(null)} className="text-gray-400 hover:text-gray-700 text-lg leading-none">×</button>
          </div>
        </div>
      ) : (
        <>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search spring or summer player…"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm mb-2" />
          <div className="space-y-1.5 max-h-72 overflow-auto">
            {searching && <div className="text-xs text-gray-400 py-2 text-center">Searching…</div>}
            {results.map(p => (
              <div key={`${p.kind}-${p.id}`} className="p-2 border border-gray-200 dark:border-gray-700 rounded-md bg-white dark:bg-gray-800">
                <div className="flex items-center justify-between gap-2">
                  <button onClick={() => onSelect(p)} className="text-left flex-1">
                    <span className="font-medium text-gray-900 dark:text-gray-100 text-sm">{p.name}</span>
                    <span className={`ml-1.5 text-[10px] px-1 py-0.5 rounded ${p.kind === 'summer' ? 'bg-sky-100 text-sky-700' : 'bg-gray-100 text-gray-600'}`}>{p.kind}</span>
                    <div className="text-xs text-gray-500">{playerMeta(p)}</div>
                  </button>
                </div>
                {p.links && p.links.length > 0 && (
                  <div className="mt-1 pl-1 space-y-0.5">
                    {p.links.map(lk => (
                      <div key={lk.link_id} className="flex items-center gap-2 text-xs text-gray-500">
                        🔗 {lk.role === 'canonical' ? 'primary of' : lk.role === 'summer' ? 'summer of' : 'linked to'} <span className="font-medium">{lk.other_name}</span>{lk.other_team ? ` (${lk.other_team})` : ''}
                        <button onClick={() => unlink(lk)} className="text-red-500 hover:underline">unlink</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function LinkTab({ setToast }) {
  const [a, setA] = useState(null)
  const [b, setB] = useState(null)
  const [canonical, setCanonical] = useState(null)
  const [busy, setBusy] = useState(false)
  const [nonce, setNonce] = useState(0)  // bump to force a re-search after unlink

  const bothSpring = a && b && a.kind === 'spring' && b.kind === 'spring'
  const bothSummer = a && b && a.kind === 'summer' && b.kind === 'summer'
  const canLink = a && b && !bothSummer && (!bothSpring || canonical)

  const doLink = async () => {
    setBusy(true)
    try {
      await apiPost('/admin/link/create', {
        a: { kind: a.kind, id: a.id }, b: { kind: b.kind, id: b.id },
        canonical_id: bothSpring ? canonical : undefined,
      })
      setToast({ type: 'ok', msg: `Linked ${a.name} ↔ ${b.name}` })
      setA(null); setB(null); setCanonical(null)
    } catch (e) { setToast({ type: 'err', msg: e.message }) }
    finally { setBusy(false) }
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">
        Link two records so their pages/careers merge. Spring + spring (a transfer with two school rows) or
        summer + spring. Search each side; an existing link shows an <span className="text-red-500">unlink</span> option.
      </p>
      <div className="flex flex-wrap gap-4 mb-4">
        <LinkSearchBox key={`a-${nonce}`} label="Player A" selected={a} onSelect={setA} onUnlinked={() => setNonce(n => n + 1)} setToast={setToast} />
        <LinkSearchBox key={`b-${nonce}`} label="Player B" selected={b} onSelect={setB} onUnlinked={() => setNonce(n => n + 1)} setToast={setToast} />
      </div>

      {bothSummer && <div className="mb-3 text-sm text-red-600">Can't link two summer players — link each to its spring page instead.</div>}

      {bothSpring && (
        <div className="mb-3 text-sm">
          <span className="font-semibold text-gray-700 dark:text-gray-300 mr-3">Primary (canonical) page:</span>
          {[a, b].map(p => (
            <label key={p.id} className="inline-flex items-center gap-1.5 mr-4">
              <input type="radio" name="canon" checked={canonical === p.id} onChange={() => setCanonical(p.id)} />
              {p.name} <span className="text-gray-400 text-xs">({p.team_short})</span>
            </label>
          ))}
        </div>
      )}

      <button onClick={doLink} disabled={!canLink || busy}
        className="px-5 py-2 rounded-md bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-40">
        {busy ? 'Linking…' : 'Link these two'}
      </button>
    </div>
  )
}

// ── Incoming out-of-region transfers tab (name-only) ──
function IncomingTab({ pnwTeams, setToast }) {
  const [list, setList] = useState([])
  const [name, setName] = useState('')
  const [fromSchool, setFromSchool] = useState('')
  const [pos, setPos] = useState('')
  const [dest, setDest] = useState('')
  const [destId, setDestId] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => { try { setList(await apiGet('/admin/incoming/list')) } catch { /* */ } }, [])
  useEffect(() => { load() }, [load])

  const add = async () => {
    if (!name.trim()) { setToast({ type: 'err', msg: 'Enter a player name.' }); return }
    if (!destId) { setToast({ type: 'err', msg: 'Pick the destination PNW school from the dropdown.' }); return }
    setBusy(true)
    try {
      await apiPost('/admin/incoming/add', { name: name.trim(), from_school: fromSchool.trim(), to_team_id: destId, position: pos.trim() || null })
      setToast({ type: 'ok', msg: `${name.trim()} → ${dest}` })
      setName(''); setFromSchool(''); setPos(''); setDest(''); setDestId(null)
      load()
    } catch (e) { setToast({ type: 'err', msg: e.message }) }
    finally { setBusy(false) }
  }
  const remove = async (id) => {
    try { await apiPost('/admin/incoming/remove', { id }); load() }
    catch (e) { setToast({ type: 'err', msg: e.message }) }
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">
        Out-of-region players transferring TO a PNW school (not in our database, so name-only — no stats).
        They show as an "Incoming Transfers" section on the destination team's page.
      </p>
      <div className="flex flex-wrap items-end gap-2 mb-5 p-3 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
        <div>
          <div className="text-[11px] font-bold text-gray-500 uppercase mb-1">Player</div>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Jake Evans"
            className="px-2.5 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 text-sm bg-white dark:bg-gray-900 w-44" />
        </div>
        <div>
          <div className="text-[11px] font-bold text-gray-500 uppercase mb-1">Pos</div>
          <input value={pos} onChange={e => setPos(e.target.value)} placeholder="OF"
            className="px-2.5 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 text-sm bg-white dark:bg-gray-900 w-16" />
        </div>
        <div>
          <div className="text-[11px] font-bold text-gray-500 uppercase mb-1">From (old school)</div>
          <input value={fromSchool} onChange={e => setFromSchool(e.target.value)} placeholder="Long Beach State"
            className="px-2.5 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 text-sm bg-white dark:bg-gray-900 w-44" />
        </div>
        <div>
          <div className="text-[11px] font-bold text-gray-500 uppercase mb-1">To (PNW school)</div>
          <PnwSchoolField value={dest} onChange={(v, id) => { setDest(v); setDestId(id) }} pnwTeams={pnwTeams} />
        </div>
        <button onClick={add} disabled={busy} className="px-4 py-1.5 rounded-md bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-50">Add</button>
      </div>

      <div className="space-y-1.5">
        {list.length === 0 && <div className="text-sm text-gray-400">No incoming transfers yet.</div>}
        {list.map(r => (
          <div key={r.id} className="flex items-center gap-2 text-sm border-b border-gray-100 dark:border-gray-800 pb-1.5">
            <span className="font-semibold text-gray-800 dark:text-gray-200">{r.name}</span>
            {r.position && <span className="text-[10px] font-bold text-gray-400 uppercase">{r.position}</span>}
            <span className="text-gray-500">{r.from_school ? `from ${r.from_school}` : ''} → <span className="text-emerald-700 font-medium">{r.to_team}</span></span>
            <button onClick={() => remove(r.id)} className="ml-auto text-red-500 hover:underline text-xs">remove</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── WCL summer players: assign a spring school + WCL portal membership ──
const wclMeta = (p) => [p.position, p.team_short, p.league,
  [p.bats, p.throws].filter(Boolean).join('/'), p.year_in_school].filter(Boolean).join(' · ')

function WclPlayerRow({ player, pnwTeams, onChanged, setToast }) {
  const [school, setSchool] = useState(player.assigned_school || '')
  const [teamId, setTeamId] = useState(player.assigned_school_team_id || null)
  const [busy, setBusy] = useState(false)

  // Manual assignment wins; otherwise fall back to the auto-linked PNW school.
  const effSchool = player.assigned_school || player.linked_school
  const fromLink = !player.assigned_school && !!player.linked_school

  const run = async (fn) => { setBusy(true); try { await fn() } catch (e) { setToast({ type: 'err', msg: e.message }) } finally { setBusy(false) } }

  const save = () => run(async () => {
    const val = school.trim()
    if (!val) { setToast({ type: 'err', msg: 'Enter a school first.' }); return }
    const r = await apiPost('/admin/summer/school/set', { summer_player_id: player.id, school: val, school_team_id: teamId })
    setToast({ type: 'ok', msg: `${player.name} → ${r.school}${r.matched_pnw ? ' (PNW)' : ''}` })
    onChanged(player.id, { assigned_school: r.school })
  })
  const clear = () => run(async () => {
    await apiPost('/admin/summer/school/clear', { summer_player_id: player.id })
    setToast({ type: 'ok', msg: `${player.name} school cleared` }); setSchool(''); setTeamId(null)
    onChanged(player.id, { assigned_school: null })
  })
  const togglePortal = () => run(async () => {
    const r = await apiPost(player.in_wcl_portal ? '/admin/wcl-portal/remove' : '/admin/wcl-portal/add', { summer_player_id: player.id })
    setToast({ type: 'ok', msg: `${player.name} ${r.in_wcl_portal ? 'added to' : 'removed from'} WCL portal` })
    onChanged(player.id, { in_wcl_portal: r.in_wcl_portal })
  })

  return (
    <div className="flex flex-wrap items-center gap-3 p-3 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
      {player.logo_url ? <img src={player.logo_url} alt="" className="w-9 h-9 object-contain flex-shrink-0" /> : <div className="w-9 h-9 rounded bg-gray-100 dark:bg-gray-700 flex-shrink-0" />}
      <div className="min-w-[170px] flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-gray-900 dark:text-gray-100">{player.name}</span>
          {effSchool
            ? <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-sky-100 text-sky-800">🎓 {effSchool}{fromLink ? ' · linked' : ''}</span>
            : <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">No school</span>}
          {player.in_wcl_portal && <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">In WCL portal</span>}
        </div>
        <div className="text-xs text-gray-500">{wclMeta(player)}</div>
      </div>
      <PnwSchoolField value={school} onChange={(v, id) => { setSchool(v); setTeamId(id) }} pnwTeams={pnwTeams} />
      <button onClick={save} disabled={busy} className="px-3 py-1.5 rounded-md bg-emerald-700 text-white text-sm font-semibold hover:bg-emerald-800 disabled:opacity-50">Save</button>
      {player.assigned_school && (
        <button onClick={clear} disabled={busy} className="px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 text-sm font-semibold text-gray-600 dark:text-gray-300 hover:border-red-400 hover:text-red-600 disabled:opacity-50">Clear</button>
      )}
      <button onClick={togglePortal} disabled={busy}
        className={`px-3 py-1.5 rounded-md text-sm font-semibold border disabled:opacity-50 ${player.in_wcl_portal
          ? 'border-amber-300 text-amber-700 hover:bg-amber-50'
          : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-amber-400 hover:text-amber-700'}`}>
        {player.in_wcl_portal ? 'Remove from WCL portal' : 'Add to WCL portal'}
      </button>
    </div>
  )
}

function WclTab({ pnwTeams, setToast }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [recent, setRecent] = useState([])
  const debounceRef = useRef(null)

  const loadRecent = useCallback(async () => { try { setRecent(await apiGet('/admin/wcl/recent')) } catch { /* */ } }, [])
  useEffect(() => { loadRecent() }, [loadRecent])

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try { setResults(await apiGet(`/admin/summer/search?q=${encodeURIComponent(q.trim())}`)) }
      catch { setResults([]) } finally { setSearching(false) }
    }, 280)
    return () => clearTimeout(debounceRef.current)
  }, [q])

  const onChanged = (id, patch) => { setResults(rs => rs.map(p => p.id === id ? { ...p, ...patch } : p)); loadRecent() }

  return (
    <>
      <p className="text-sm text-gray-500 mb-3">
        Assign a spring school to any WCL player (PNW schools autocomplete; type any other school as free text),
        and add players to the WCL Transfer Portal Tracker.
      </p>
      <input value={q} onChange={e => setQ(e.target.value)} autoFocus placeholder="Search a WCL player by name…"
        className="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 mb-3" />
      <div className="space-y-2 mb-8">
        {searching && <div className="text-sm text-gray-400 py-4 text-center">Searching…</div>}
        {!searching && q.trim().length >= 2 && results.length === 0 && <div className="text-sm text-gray-400 py-4 text-center">No WCL players found.</div>}
        {results.map(p => <WclPlayerRow key={p.id} player={p} pnwTeams={pnwTeams} onChanged={onChanged} setToast={setToast} />)}
      </div>
      {recent.length > 0 && (
        <div>
          <h2 className="text-sm font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">Recent WCL edits</h2>
          <div className="space-y-1.5">
            {recent.map(r => (
              <div key={r.id} className="flex flex-wrap items-center gap-x-2 text-sm text-gray-600 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800 pb-1.5">
                <span className="font-medium text-gray-800 dark:text-gray-200">{r.name}</span>
                {r.team_short && <span className="text-gray-400">({r.team_short})</span>}
                {r.action === 'school_set' && <span>→ <span className="text-sky-700 font-medium">{r.detail}</span></span>}
                {r.action === 'school_clear' && <span className="text-red-500">school cleared</span>}
                {r.action === 'portal_add' && <span className="text-amber-600">added to WCL portal</span>}
                {r.action === 'portal_remove' && <span className="text-gray-500">removed from WCL portal</span>}
                <span className="text-gray-400 ml-auto text-xs">{r.editor_email} · {fmtTime(r.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

export default function CommitmentEditor() {
  const [tab, setTab] = useState('commit')
  const [toast, setToast] = useState(null)
  const [pnwTeams, setPnwTeams] = useState([])

  useEffect(() => { apiGet('/admin/teams/pnw').then(setPnwTeams).catch(() => setPnwTeams([])) }, [])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3800); return () => clearTimeout(t) }, [toast])

  const TabBtn = ({ id, children }) => (
    <button onClick={() => setTab(id)}
      className={`px-4 py-1.5 rounded-md text-sm font-semibold border ${tab === id ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white dark:bg-gray-800 text-gray-600 border-gray-300 dark:border-gray-600 hover:border-emerald-600'}`}>
      {children}
    </button>
  )

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">Commitment Editor</h1>
      <p className="text-sm text-gray-500 mb-4">Dev tools: edit commitments &amp; transfer-portal status, and link player pages. Changes go live immediately and are logged.</p>

      <div className="flex gap-2 mb-4 flex-wrap">
        <TabBtn id="commit">Commitments &amp; Portal</TabBtn>
        <TabBtn id="wcl">WCL Players</TabBtn>
        <TabBtn id="link">Link Pages</TabBtn>
        <TabBtn id="incoming">Incoming Transfers</TabBtn>
      </div>

      {toast && (
        <div className={`mb-3 p-2.5 rounded text-sm border ${toast.type === 'ok' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
          {toast.type === 'ok' ? '✓ ' : '⚠ '}{toast.msg}
        </div>
      )}

      {tab === 'commit' && <CommitmentsTab pnwTeams={pnwTeams} setToast={setToast} />}
      {tab === 'wcl' && <WclTab pnwTeams={pnwTeams} setToast={setToast} />}
      {tab === 'link' && <LinkTab setToast={setToast} />}
      {tab === 'incoming' && <IncomingTab pnwTeams={pnwTeams} setToast={setToast} />}
    </div>
  )
}
