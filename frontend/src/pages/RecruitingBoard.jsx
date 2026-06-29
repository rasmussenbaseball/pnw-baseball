// RecruitingBoard — coaches build and share recruiting boards.
//
//  • Unlimited boards with custom titles (left rail).
//  • Each board holds players added from our player pages OR entered manually
//    (non-PNW recruits): name, position, class, school, height, weight, stats,
//    notes. Every player shows which email added them.
//  • Boards are shareable by email — the owner adds coworker emails; anyone on
//    the board can add players to it.
//
// Lives on the main site under /coaching (teal theme), gated to recruiting tier+.
import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  listBoards, createBoard, getBoard, renameBoard, deleteBoard,
  addMember, removeMember, addPlayer, updatePlayer, removePlayer,
} from '../lib/recruitingBoards'
import RecruitFinder from '../components/RecruitFinder'

export default function RecruitingBoard() {
  const [view, setView] = useState('board')   // 'board' | 'finder'
  const [boards, setBoards] = useState(null)
  const [activeId, setActiveId] = useState(null)
  const [newTitle, setNewTitle] = useState('')
  const [error, setError] = useState('')

  const loadBoards = useCallback(async (selectId) => {
    try {
      const d = await listBoards()
      setBoards(d.boards || [])
      if (selectId) setActiveId(selectId)
      else if (d.boards?.length && !d.boards.some(b => b.id === selectId)) {
        setActiveId(prev => (prev && d.boards.some(b => b.id === prev)) ? prev : d.boards[0].id)
      }
    } catch (e) {
      setError(e.message || 'Could not load boards.')
      setBoards([])
    }
  }, [])

  useEffect(() => { loadBoards() }, [loadBoards])

  async function handleCreate() {
    const title = newTitle.trim()
    if (!title) return
    setError('')
    try {
      const { id } = await createBoard(title)
      setNewTitle('')
      await loadBoards(id)
    } catch (e) { setError(e.message || 'Could not create board.') }
  }

  return (
    <div className={`${view === 'finder' ? 'max-w-7xl' : 'max-w-6xl'} mx-auto px-3 sm:px-5 py-6`}>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100">Recruiting Board</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          {view === 'finder'
            ? 'Find uncommitted NWAC, transfer-portal, and WCL-portal players by position, archetype, or custom stat filters.'
            : 'Build boards of players to track, add notes, and share with your staff.'}
        </p>
      </div>

      {/* Board / Finder toggle */}
      <div className="inline-flex rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5 mb-5">
        {[['board', 'My Boards'], ['finder', 'Recruit Finder']].map(([v, l]) => (
          <button key={v} onClick={() => setView(v)}
            className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-colors
              ${view === v ? 'bg-white dark:bg-gray-700 text-nw-teal shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            {l}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 rounded px-3 py-2">{error}</div>}

      {view === 'finder' ? <RecruitFinder /> : (
      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-5">
        {/* Left rail: boards */}
        <aside>
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2 px-1">Your boards</div>
            {boards === null && <div className="text-sm text-gray-400 px-1 py-2">Loading…</div>}
            {boards && boards.length === 0 && <div className="text-sm text-gray-400 px-1 py-2">No boards yet.</div>}
            <ul className="space-y-1">
              {(boards || []).map(b => (
                <li key={b.id}>
                  <button
                    onClick={() => setActiveId(b.id)}
                    className={`w-full text-left rounded-lg px-3 py-2 transition-colors
                      ${activeId === b.id ? 'bg-nw-teal text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-700/60'}`}
                  >
                    <div className="text-sm font-semibold truncate">{b.title}</div>
                    <div className={`text-[11px] ${activeId === b.id ? 'text-white/75' : 'text-gray-400'}`}>
                      {b.player_count} player{b.player_count === 1 ? '' : 's'}{!b.is_owner && ' · shared'}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
              <input
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
                placeholder="New board title…"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900
                           px-3 py-1.5 text-sm focus:ring-2 focus:ring-nw-teal focus:border-transparent"
              />
              <button
                onClick={handleCreate}
                disabled={!newTitle.trim()}
                className="mt-2 w-full rounded-lg bg-nw-teal text-white text-sm font-semibold py-1.5
                           hover:bg-nw-teal-dark disabled:opacity-50"
              >
                New board
              </button>
            </div>
          </div>
        </aside>

        {/* Right: active board */}
        <main>
          {activeId
            ? <BoardPanel key={activeId} boardId={activeId} onChanged={() => loadBoards(activeId)}
                          onDeleted={() => { setActiveId(null); loadBoards() }} />
            : <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-10 text-center text-gray-400">
                Select a board, or create one to get started.
              </div>}
        </main>
      </div>
      )}
    </div>
  )
}


function BoardPanel({ boardId, onChanged, onDeleted }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState('')

  const reload = useCallback(() => {
    getBoard(boardId)
      .then(d => { setData(d); setTitle(d.board.title) })
      .catch(e => setError(e.message || 'Could not load board.'))
  }, [boardId])
  useEffect(() => { reload() }, [reload])

  if (error) return <div className="text-sm text-red-600 bg-red-50 dark:bg-red-900/20 rounded px-3 py-2">{error}</div>
  if (!data) return <div className="text-sm text-gray-400 p-6">Loading board…</div>

  const { board, players, members, viewer_email } = data
  const isOwner = board.is_owner

  async function saveTitle() {
    const t = title.trim()
    if (!t || t === board.title) { setEditingTitle(false); return }
    try { await renameBoard(boardId, t); setEditingTitle(false); reload(); onChanged() }
    catch (e) { setError(e.message) }
  }
  async function handleDelete() {
    if (!confirm(`Delete board “${board.title}”? This can't be undone.`)) return
    try { await deleteBoard(boardId); onDeleted() } catch (e) { setError(e.message) }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-start justify-between gap-3">
          {editingTitle ? (
            <div className="flex gap-2 flex-1">
              <input autoFocus value={title} onChange={e => setTitle(e.target.value)}
                     onKeyDown={e => { if (e.key === 'Enter') saveTitle() }}
                     className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-3 py-1.5 text-lg font-bold" />
              <button onClick={saveTitle} className="rounded-lg bg-nw-teal text-white px-3 text-sm font-semibold">Save</button>
            </div>
          ) : (
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
              {board.title}
              {isOwner && (
                <button onClick={() => setEditingTitle(true)}
                        className="ml-2 text-[12px] font-semibold text-gray-400 hover:text-nw-teal align-middle">Rename</button>
              )}
            </h2>
          )}
          {isOwner && (
            <button onClick={handleDelete} className="shrink-0 text-[13px] text-red-500 hover:text-red-700 font-medium">
              Delete board
            </button>
          )}
        </div>
        {!isOwner && (
          <div className="mt-1 text-[12px] text-gray-400">Shared with you by {board.owner_email}</div>
        )}
        <MembersBox boardId={boardId} board={board} members={members} isOwner={isOwner} onChanged={reload} />
      </div>

      {players.length > 0 && <BoardSummary players={players} />}

      {/* Add players (search our DB or manual) */}
      <AddPlayersCard boardId={boardId} onAdded={() => { reload(); onChanged() }} />

      {/* Players */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
        <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 text-[11px] font-bold uppercase tracking-wide text-gray-400">
          {players.length} player{players.length === 1 ? '' : 's'}
        </div>
        {players.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">No players on this board yet.</div>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {players.map(p => (
              <PlayerRow key={p.id} boardId={boardId} player={p} viewerEmail={viewer_email}
                         onChanged={() => { reload(); onChanged() }} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}


// Parse a free-text offer ("$5,000/yr", "12k", "5000") into a number, or null.
function parseMoney(s) {
  if (s == null) return null
  const m = String(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([kK])?/)
  if (!m) return null
  let n = parseFloat(m[1])
  if (m[2]) n *= 1000
  return Number.isFinite(n) ? n : null
}
function fmtMoney(n) {
  return '$' + Math.round(n || 0).toLocaleString()
}
function posGroup(pos) {
  if (!pos) return 'Other'
  const first = pos.toUpperCase().split('/')[0].trim()
  if (['RHP', 'LHP', 'P', 'SP', 'RP'].includes(first)) return 'P'
  if (first === 'C') return 'C'
  if (['1B', '2B', '3B', 'SS', 'IF'].includes(first)) return 'IF'
  if (['OF', 'LF', 'CF', 'RF'].includes(first)) return 'OF'
  if (first === 'DH') return 'DH'
  return 'Other'
}

function SummaryTile({ label, value, sub }) {
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 px-3 py-2.5">
      <div className="text-2xl font-bold text-nw-teal tabular-nums leading-none">{value}</div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mt-1">{label}</div>
      {sub && <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

function BoardSummary({ players }) {
  const commits = players.filter(p => p.committed)
  const commitAmts = commits.map(p => parseMoney(p.offer_amount)).filter(n => n != null)
  const totalCommitted = commitAmts.reduce((a, b) => a + b, 0)
  const avgSchol = commitAmts.length ? totalCommitted / commitAmts.length : 0
  const offers = players.filter(p => !p.committed && parseMoney(p.offer_amount) != null)
  const totalOffers = offers.reduce((a, p) => a + parseMoney(p.offer_amount), 0)

  const groups = ['C', 'IF', 'OF', 'P', 'DH', 'Other']
  const breakdown = groups
    .map(g => ({
      g,
      commits: commits.filter(p => posGroup(p.position) === g).length,
      offers: offers.filter(p => posGroup(p.position) === g).length,
    }))
    .filter(r => r.commits || r.offers)

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <SummaryTile label="Committed" value={commits.length}
          sub={commitAmts.length ? `${commitAmts.length} with $ set` : null} />
        <SummaryTile label="Committed $" value={fmtMoney(totalCommitted)}
          sub={commitAmts.length ? `${fmtMoney(avgSchol)} avg scholarship` : 'no amounts set'} />
        <SummaryTile label="Offers out" value={offers.length} />
        <SummaryTile label="$ on offer" value={fmtMoney(totalOffers)} />
      </div>
      {breakdown.length > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">By position</div>
          <div className="flex flex-wrap gap-2">
            {breakdown.map(r => (
              <div key={r.g} className="rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5">
                <span className="text-[12px] font-bold text-gray-700 dark:text-gray-200">{r.g}</span>
                <span className="text-[11px] text-gray-500 ml-2">
                  {r.commits} committed · {r.offers} offered
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function MembersBox({ boardId, board, members, isOwner, onChanged }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')

  async function add() {
    const e = email.trim().toLowerCase()
    if (!e) return
    setError('')
    try { await addMember(boardId, e); setEmail(''); onChanged() }
    catch (err) { setError(err.message || 'Could not add member.') }
  }
  async function remove(id) {
    try { await removeMember(boardId, id); onChanged() } catch (err) { setError(err.message) }
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Shared with</div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-nw-teal/10 text-nw-teal px-2.5 py-0.5 text-[12px] font-semibold">
          {board.owner_email} <span className="text-[10px] opacity-70">owner</span>
        </span>
        {members.map(m => (
          <span key={m.id} className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-gray-700 px-2.5 py-0.5 text-[12px] text-gray-700 dark:text-gray-200">
            {m.email}
            {isOwner && (
              <button onClick={() => remove(m.id)} className="text-gray-400 hover:text-red-500 ml-0.5" title="Remove">×</button>
            )}
          </span>
        ))}
      </div>
      {isOwner && (
        <div className="flex gap-2">
          <input
            value={email} onChange={e => setEmail(e.target.value)} type="email"
            onKeyDown={e => { if (e.key === 'Enter') add() }}
            placeholder="coworker@email.com"
            className="flex-1 max-w-xs rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-3 py-1.5 text-sm focus:ring-2 focus:ring-nw-teal focus:border-transparent"
          />
          <button onClick={add} disabled={!email.trim()} className="rounded-lg border border-nw-teal text-nw-teal text-sm font-semibold px-3 py-1.5 hover:bg-nw-teal hover:text-white disabled:opacity-50">
            Share
          </button>
        </div>
      )}
      {error && <div className="mt-1.5 text-[12px] text-red-600">{error}</div>}
    </div>
  )
}


const CLASS_PRESETS = ['HS 2027', 'HS 2028', 'HS 2029', 'JUCO Fr', 'JUCO So', 'Transfer']

function AddPlayersCard({ boardId, onAdded }) {
  const [mode, setMode] = useState('search')   // 'search' | 'manual'
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center gap-1 mb-3">
        {['search', 'manual'].map(m => (
          <button key={m} onClick={() => setMode(m)}
            className={`text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors
              ${mode === m ? 'bg-nw-teal text-white' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
            {m === 'search' ? 'Search our database' : 'Add manually'}
          </button>
        ))}
      </div>
      {mode === 'search'
        ? <PlayerSearchAdd boardId={boardId} onAdded={onAdded} />
        : <ManualAddForm boardId={boardId} onAdded={onAdded} />}
    </div>
  )
}

function PlayerSearchAdd({ boardId, onAdded }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [addedIds, setAddedIds] = useState({})
  const [busyId, setBusyId] = useState(null)

  useEffect(() => {
    const query = q.trim()
    if (query.length < 2) { setResults([]); return }
    let cancelled = false
    setLoading(true)
    const t = setTimeout(() => {
      fetch(`/api/v1/players/search?q=${encodeURIComponent(query)}&limit=12`)
        .then(r => r.json())
        .then(d => { if (!cancelled) setResults(Array.isArray(d) ? d : []) })
        .catch(() => { if (!cancelled) setResults([]) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [q])

  async function add(p) {
    setBusyId(p.id)
    try {
      await addPlayer(boardId, {
        player_id: p.id,
        name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        position: p.position || null,
        school: p.team_short || p.team_name || null,
        class_year: p.year_in_school || null,
      })
      setAddedIds(a => ({ ...a, [p.id]: true }))
      onAdded()
    } finally { setBusyId(null) }
  }

  return (
    <div>
      <input
        value={q} onChange={e => setQ(e.target.value)} autoFocus
        placeholder="Search players in our database by name…"
        className="w-full rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-nw-teal focus:border-transparent"
      />
      {loading && <div className="text-[12px] text-gray-400 mt-2">Searching…</div>}
      {!loading && q.trim().length >= 2 && results.length === 0 && (
        <div className="text-[12px] text-gray-400 mt-2">No players found. Try “Add manually” for non-PNW players.</div>
      )}
      {results.length > 0 && (
        <ul className="mt-2 max-h-72 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700 rounded-lg border border-gray-100 dark:border-gray-700">
          {results.map(p => (
            <li key={p.id} className="flex items-center gap-2.5 px-3 py-2">
              {p.logo_url && <img src={p.logo_url} alt="" className="w-6 h-6 object-contain shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                  {p.first_name} {p.last_name}
                </div>
                <div className="text-[11px] text-gray-400 truncate">
                  {[p.position, p.team_short || p.team_name, p.division_level].filter(Boolean).join(' · ')}
                </div>
              </div>
              {addedIds[p.id]
                ? <span className="text-[13px] font-semibold text-green-600 shrink-0">Added</span>
                : <button onClick={() => add(p)} disabled={busyId === p.id}
                          className="shrink-0 rounded-md bg-nw-teal text-white text-[13px] font-semibold px-3 py-1 hover:bg-nw-teal-dark disabled:opacity-50">
                    {busyId === p.id ? '…' : 'Add'}
                  </button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ManualAddForm({ boardId, onAdded }) {
  const [f, setF] = useState({ name: '', position: '', class_year: '', school: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }))

  async function submit() {
    if (!f.name.trim()) return
    setBusy(true); setError('')
    try {
      await addPlayer(boardId, {
        name: f.name.trim(),
        position: f.position.trim() || null,
        class_year: f.class_year.trim() || null,
        school: f.school.trim() || null,
      })
      setF({ name: '', position: '', class_year: '', school: '' })
      onAdded()
    } catch (e) { setError(e.message || 'Could not add player.') }
    finally { setBusy(false) }
  }

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <input value={f.name} onChange={set('name')} placeholder="Name *"
               className="col-span-2 sm:col-span-1 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-3 py-1.5 text-sm focus:ring-2 focus:ring-nw-teal focus:border-transparent" />
        <input value={f.position} onChange={set('position')} placeholder="Pos (e.g. RHP, OF)"
               className="rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-3 py-1.5 text-sm focus:ring-2 focus:ring-nw-teal focus:border-transparent" />
        <input value={f.class_year} onChange={set('class_year')} placeholder="Class"
               list="rb-class-presets"
               className="rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-3 py-1.5 text-sm focus:ring-2 focus:ring-nw-teal focus:border-transparent" />
        <datalist id="rb-class-presets">
          {CLASS_PRESETS.map(c => <option key={c} value={c} />)}
        </datalist>
        <input value={f.school} onChange={set('school')} placeholder="School / team"
               onKeyDown={e => { if (e.key === 'Enter') submit() }}
               className="rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-3 py-1.5 text-sm focus:ring-2 focus:ring-nw-teal focus:border-transparent" />
      </div>
      <div className="flex items-center gap-3 mt-2">
        <button onClick={submit} disabled={busy || !f.name.trim()}
                className="rounded-lg bg-nw-teal text-white text-sm font-semibold px-4 py-1.5 hover:bg-nw-teal-dark disabled:opacity-50">
          {busy ? 'Adding…' : 'Add player'}
        </button>
        <span className="text-[12px] text-gray-400">Add height, weight, stats &amp; notes after adding (expand the row).</span>
      </div>
      {error && <div className="mt-1.5 text-[12px] text-red-600">{error}</div>}
    </div>
  )
}


function fmtDate(s) {
  if (!s) return null
  const [y, m, d] = String(s).slice(0, 10).split('-')
  return (m && d) ? `${m}/${d}/${String(y).slice(2)}` : s
}

function PlayerRow({ boardId, player, viewerEmail, onChanged }) {
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [d, setD] = useState(player)
  const [saving, setSaving] = useState(false)
  const set = (k) => (e) => setD(s => ({ ...s, [k]: e.target.value }))

  async function patch(payload) { await updatePlayer(boardId, player.id, payload); onChanged() }

  async function save() {
    setSaving(true)
    try {
      await patch({
        position: d.position || '', class_year: d.class_year || '', school: d.school || '',
        height: d.height || '', weight: d.weight || '', notes: d.notes || '',
        offer_amount: d.offer_amount || '', last_contacted: d.last_contacted || '',
      })
      setExpanded(false)
    } finally { setSaving(false) }
  }
  async function remove() {
    if (!confirm(`Remove ${player.name} from this board?`)) return
    await removePlayer(boardId, player.id); onChanged()
  }

  const today = new Date().toISOString().slice(0, 10)

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {player.player_id
              ? <Link to={`/player/${player.player_id}`} className="text-sm font-semibold text-nw-teal hover:underline">{player.name}</Link>
              : <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{player.name}</span>}
            {player.position && <span className="text-[11px] font-bold text-gray-500 bg-gray-100 dark:bg-gray-700 rounded px-1.5 py-0.5">{player.position}</span>}
            {player.class_year && <span className="text-[11px] text-gray-500">{player.class_year}</span>}
            {player.school && <span className="text-[11px] text-gray-400">· {player.school}</span>}
          </div>
          {/* status chips */}
          <div className="flex items-center gap-1.5 flex-wrap mt-1">
            {player.committed && (
              <span className="text-[11px] font-bold text-green-700 bg-green-100 dark:bg-green-900/40 dark:text-green-300 rounded-full px-2 py-0.5">Committed</span>
            )}
            {player.offer_amount && (
              <span className="text-[11px] font-semibold text-amber-800 bg-amber-100 dark:bg-amber-900/40 dark:text-amber-200 rounded-full px-2 py-0.5">Offer: {player.offer_amount}</span>
            )}
            {player.last_contacted && (
              <span className="text-[11px] text-gray-500 bg-gray-100 dark:bg-gray-700 rounded-full px-2 py-0.5">Last contact {fmtDate(player.last_contacted)}</span>
            )}
          </div>
          {/* actual stats — only for players in our database */}
          {player.stat_line && (
            <div className="text-[12px] mt-1 tabular-nums">
              <span className="font-semibold text-gray-700 dark:text-gray-200">{player.stat_line}</span>
              {player.stat_season && <span className="text-gray-400"> · {player.stat_season}</span>}
            </div>
          )}
          {(player.notes || player.height || player.weight) && !expanded && (
            <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-1 truncate">
              {[player.height, player.weight && `${player.weight} lbs`, player.notes].filter(Boolean).join(' · ')}
            </div>
          )}
          <div className="text-[10.5px] text-gray-400 mt-0.5">
            added by {player.added_by_email === viewerEmail ? 'you' : player.added_by_email}
          </div>
        </div>

        {/* actions dropdown */}
        <div className="relative shrink-0">
          <button onClick={() => setMenuOpen(o => !o)}
                  className="px-2 py-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 text-lg leading-none"
                  title="Actions">⋯</button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-20 w-52 rounded-lg bg-white dark:bg-gray-800 shadow-lg border border-gray-200 dark:border-gray-700 py-1 text-sm">
                <MenuItem onClick={() => { setMenuOpen(false); patch({ committed: !player.committed }) }}>
                  {player.committed ? 'Unmark committed' : 'Mark as committed'}
                </MenuItem>
                <MenuItem onClick={() => { setMenuOpen(false); patch({ last_contacted: today }) }}>
                  Mark contacted today
                </MenuItem>
                <MenuItem onClick={() => { setMenuOpen(false); setExpanded(true) }}>
                  Edit details &amp; offer
                </MenuItem>
                <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
                <MenuItem danger onClick={() => { setMenuOpen(false); remove() }}>
                  Remove from board
                </MenuItem>
              </div>
            </>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 bg-gray-50 dark:bg-gray-900/40 rounded-lg p-3">
          <Field label="Position"><input value={d.position || ''} onChange={set('position')} className={INP} /></Field>
          <Field label="Class"><input value={d.class_year || ''} onChange={set('class_year')} list="rb-class-presets" className={INP} /></Field>
          <Field label="School / team"><input value={d.school || ''} onChange={set('school')} className={INP} /></Field>
          <Field label="Offer ($)"><input value={d.offer_amount || ''} onChange={set('offer_amount')} placeholder="e.g. $5,000/yr" className={INP} /></Field>
          <Field label="Height"><input value={d.height || ''} onChange={set('height')} placeholder='e.g. 6-2' className={INP} /></Field>
          <Field label="Weight"><input value={d.weight || ''} onChange={set('weight')} placeholder='e.g. 190' className={INP} /></Field>
          <Field label="Last contacted"><input type="date" value={(d.last_contacted || '').slice(0, 10)} onChange={set('last_contacted')} className={INP} /></Field>
          <Field label="Committed">
            <button type="button" onClick={() => setD(s => ({ ...s, committed: !s.committed }))}
              className={`w-full rounded-lg px-3 py-1.5 text-sm font-semibold border ${d.committed ? 'bg-green-600 text-white border-green-600' : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300'}`}>
              {d.committed ? 'Committed' : 'Not committed'}
            </button>
          </Field>
          <Field label="Notes" full><textarea value={d.notes || ''} onChange={set('notes')} rows={3} placeholder="Scouting notes…" className={INP + ' resize-y'} /></Field>
          <div className="col-span-2 sm:col-span-4 flex justify-end gap-2">
            <button onClick={() => { setD(player); setExpanded(false) }} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-500 hover:text-gray-700">Cancel</button>
            <button onClick={save} disabled={saving} className="rounded-lg bg-nw-teal text-white text-sm font-semibold px-4 py-1.5 hover:bg-nw-teal-dark disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

function MenuItem({ children, onClick, danger }) {
  return (
    <button onClick={onClick}
      className={`w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors
        ${danger ? 'text-red-600' : 'text-gray-700 dark:text-gray-200'}`}>
      {children}
    </button>
  )
}

const INP = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-3 py-1.5 text-sm focus:ring-2 focus:ring-nw-teal focus:border-transparent'

function Field({ label, children, full }) {
  return (
    <label className={`block ${full ? 'col-span-2 sm:col-span-4' : ''}`}>
      <span className="block text-[10.5px] font-semibold uppercase tracking-wide text-gray-400 mb-1">{label}</span>
      {children}
    </label>
  )
}
