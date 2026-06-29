// AddToBoardButton — shown on player pages for recruiting-tier (or higher)
// users. Opens a modal to pick which recruiting board to add this player to,
// or to spin up a new board on the spot.
import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTier } from '../hooks/useTier'
import { tierMeets } from '../lib/tiers'
import { listBoards, createBoard, addPlayer } from '../lib/recruitingBoards'

export default function AddToBoardButton({ player, className = '' }) {
  const { tier, user } = useTier()
  const [open, setOpen] = useState(false)

  // Only recruiting tier and up; never for signed-out visitors.
  if (!user || !tierMeets(tier, 'recruiting')) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1.5 rounded-lg border border-nw-teal/40
                    bg-nw-teal/10 px-3 py-1.5 text-sm font-semibold text-nw-teal
                    hover:bg-nw-teal hover:text-white transition-colors ${className}`}
      >
        <span className="text-base leading-none">＋</span> Add to board
      </button>
      {open && <BoardPickerModal player={player} onClose={() => setOpen(false)} />}
    </>
  )
}


function BoardPickerModal({ player, onClose }) {
  const [boards, setBoards] = useState(null)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [addedTo, setAddedTo] = useState({})   // boardId -> true
  const [newTitle, setNewTitle] = useState('')
  const [creating, setCreating] = useState(false)

  const reload = useCallback(() => {
    listBoards()
      .then(d => setBoards(d.boards || []))
      .catch(e => setError(e.message || 'Could not load your boards.'))
  }, [])
  useEffect(() => { reload() }, [reload])

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const playerName = `${player.first_name || ''} ${player.last_name || ''}`.trim() || player.name || 'Player'

  async function addToBoard(boardId) {
    setBusyId(boardId); setError('')
    try {
      await addPlayer(boardId, {
        player_id: player.id ?? null,
        name: playerName,
        position: player.position || null,
        school: player.team_name || player.school || null,
      })
      setAddedTo(a => ({ ...a, [boardId]: true }))
    } catch (e) {
      setError(e.message || 'Could not add the player.')
    } finally {
      setBusyId(null)
    }
  }

  async function createAndAdd() {
    const title = newTitle.trim()
    if (!title) return
    setCreating(true); setError('')
    try {
      const { id } = await createBoard(title)
      setNewTitle('')
      await reload()
      await addToBoard(id)
    } catch (e) {
      setError(e.message || 'Could not create the board.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 p-4 pt-20"
         onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-gray-800 shadow-xl
                      border border-gray-200 dark:border-gray-700"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 py-3.5 border-b border-gray-100 dark:border-gray-700">
          <div>
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Add to recruiting board</h2>
            <p className="text-[12px] text-gray-500 dark:text-gray-400">{playerName}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-5 py-4 max-h-[55vh] overflow-y-auto">
          {error && <div className="mb-3 text-[13px] text-red-600 bg-red-50 dark:bg-red-900/20 rounded px-3 py-2">{error}</div>}

          {boards === null && <div className="text-sm text-gray-400 py-4 text-center">Loading your boards…</div>}

          {boards && boards.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
              You don't have any boards yet. Create your first one below.
            </p>
          )}

          {boards && boards.length > 0 && (
            <ul className="space-y-1.5 mb-4">
              {boards.map(b => (
                <li key={b.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-gray-200
                               dark:border-gray-700 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{b.title}</div>
                    <div className="text-[11px] text-gray-400">
                      {b.player_count} player{b.player_count === 1 ? '' : 's'}
                      {!b.is_owner && ' · shared with you'}
                    </div>
                  </div>
                  {addedTo[b.id] ? (
                    <span className="shrink-0 text-[13px] font-semibold text-green-600">Added ✓</span>
                  ) : (
                    <button
                      onClick={() => addToBoard(b.id)}
                      disabled={busyId === b.id}
                      className="shrink-0 rounded-md bg-nw-teal px-3 py-1.5 text-[13px] font-semibold
                                 text-white hover:bg-nw-teal-dark disabled:opacity-50"
                    >
                      {busyId === b.id ? '…' : 'Add'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* Create-new */}
          <div className="border-t border-gray-100 dark:border-gray-700 pt-3">
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">
              New board
            </label>
            <div className="flex gap-2">
              <input
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') createAndAdd() }}
                placeholder="e.g. 2027 Recruits, Outfielders…"
                className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900
                           px-3 py-1.5 text-sm focus:ring-2 focus:ring-nw-teal focus:border-transparent"
              />
              <button
                onClick={createAndAdd}
                disabled={creating || !newTitle.trim()}
                className="shrink-0 rounded-lg bg-nw-teal px-3 py-1.5 text-sm font-semibold text-white
                           hover:bg-nw-teal-dark disabled:opacity-50"
              >
                {creating ? '…' : 'Create + add'}
              </button>
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700 flex justify-between items-center">
          <Link to="/coaching/recruiting-board" className="text-[13px] font-semibold text-nw-teal hover:underline">
            Manage boards →
          </Link>
          <button onClick={onClose} className="text-[13px] font-semibold text-gray-500 hover:text-gray-700">
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
