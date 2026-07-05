// SharedRecruitingBoard — /recruiting-board/shared/:token
//
// PUBLIC read-only view of a recruiting board reached via its share link.
// No account needed. Shows the board title, summary tiles, and the player
// list (status chips, stats, notes) — everything a printed board would show,
// minus member emails and per-player attribution. Editing lives on the real
// board page for the owner + email-shared staff.

import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getSharedBoard } from '../lib/recruitingBoards'

function fmtDate(s) {
  if (!s) return null
  const [y, m, d] = String(s).slice(0, 10).split('-')
  return (m && d) ? `${m}/${d}/${String(y).slice(2)}` : s
}

function parseMoney(s) {
  if (s == null) return null
  const m = String(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([kK])?/)
  if (!m) return null
  let n = parseFloat(m[1])
  if (m[2]) n *= 1000
  return Number.isFinite(n) ? n : null
}
const fmtMoney = n => '$' + Math.round(n || 0).toLocaleString()

export default function SharedRecruitingBoard() {
  const { token } = useParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    getSharedBoard(token)
      .then(setData)
      .catch(e => setError(e.message || 'This share link is no longer active.'))
  }, [token])

  useEffect(() => {
    if (data?.board?.title) document.title = `${data.board.title} · Recruiting Board`
  }, [data])

  if (error) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">Board unavailable</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">{error}</p>
        <Link to="/" className="text-sm text-nw-teal hover:underline">← NW Baseball Stats</Link>
      </div>
    )
  }
  if (!data) return <div className="max-w-3xl mx-auto px-4 py-16 text-center text-sm text-gray-400">Loading board…</div>

  const { board, players } = data
  const commits = players.filter(p => p.committed)
  const commitAmts = commits.map(p => parseMoney(p.offer_amount)).filter(n => n != null)
  const offers = players.filter(p => !p.committed && parseMoney(p.offer_amount) != null)

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-5 py-6">
      <div className="mb-4">
        <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Shared recruiting board · read-only</div>
        <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100">{board.title}</h1>
        <p className="text-[12px] text-gray-400 mt-0.5">Shared by {board.owner_email} · via NW Baseball Stats</p>
      </div>

      {/* Summary */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 mb-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {[
            ['Players', players.length],
            ['Committed', commits.length],
            ['Committed $', fmtMoney(commitAmts.reduce((a, b) => a + b, 0))],
            ['Offers out', offers.length],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-gray-50 dark:bg-gray-900/40 px-3 py-2.5">
              <div className="text-2xl font-bold text-nw-teal tabular-nums leading-none">{value}</div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mt-1">{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Players */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
        <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 text-[11px] font-bold uppercase tracking-wide text-gray-400">
          {players.length} player{players.length === 1 ? '' : 's'}
        </div>
        {players.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">No players on this board.</div>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {players.map(p => (
              <li key={p.id} className="px-4 py-3">
                <div className="flex items-center gap-2 flex-wrap">
                  {p.player_id
                    ? <Link to={`/player/${p.player_id}`} className="text-sm font-semibold text-nw-teal hover:underline">{p.name}</Link>
                    : <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{p.name}</span>}
                  {p.position && <span className="text-[11px] font-bold text-gray-500 bg-gray-100 dark:bg-gray-700 rounded px-1.5 py-0.5">{p.position}</span>}
                  {p.class_year && <span className="text-[11px] text-gray-500">{p.class_year}</span>}
                  {p.school && <span className="text-[11px] text-gray-400">· {p.school}</span>}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mt-1">
                  {p.committed && (
                    <span className="text-[11px] font-bold text-green-700 bg-green-100 dark:bg-green-900/40 dark:text-green-300 rounded-full px-2 py-0.5">Committed</span>
                  )}
                  {p.offer_amount && (
                    <span className="text-[11px] font-semibold text-amber-800 bg-amber-100 dark:bg-amber-900/40 dark:text-amber-200 rounded-full px-2 py-0.5">Offer: {p.offer_amount}</span>
                  )}
                  {p.last_contacted && (
                    <span className="text-[11px] text-gray-500 bg-gray-100 dark:bg-gray-700 rounded-full px-2 py-0.5">Last contact {fmtDate(p.last_contacted)}</span>
                  )}
                </div>
                {p.stat_line && (
                  <div className="text-[12px] mt-1 tabular-nums">
                    <span className="font-semibold text-gray-700 dark:text-gray-200">{p.stat_line}</span>
                    {p.stat_season && <span className="text-gray-400"> · {p.stat_season}</span>}
                  </div>
                )}
                {(p.notes || p.height || p.weight) && (
                  <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-1">
                    {[p.height, p.weight && `${p.weight} lbs`, p.notes].filter(Boolean).join(' · ')}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[11px] text-gray-400 mt-3 text-center">
        Built with <Link to="/coaching/recruiting-board" className="text-nw-teal hover:underline">Recruiting Boards</Link> on NW Baseball Stats, free with an account.
      </p>
    </div>
  )
}
