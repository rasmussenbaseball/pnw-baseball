// /news/commitments — running list of recent commitments.
//
// Phase 1: NWAC (JUCO) player commitments — `players.is_committed=1`,
// `committed_to` set. Sorted newest first (by updated_at).
// Phase 2 (coming): HS commitments to PNW schools — same page, second
// section once that data starts flowing in.

import { useEffect, useState } from 'react'
import NewsTabs from '../components/NewsTabs'

const API_BASE = '/api/v1'

function fmtDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    })
  } catch { return '' }
}

function fmtHeight(h) {
  if (!h) return null
  const m = String(h).match(/(\d+)\D+(\d+)/)
  return m ? `${m[1]}'${m[2]}"` : String(h)
}

function PlayerInitials({ first, last }) {
  const a = (first?.[0] || '').toUpperCase()
  const b = (last?.[0] || '').toUpperCase()
  return (
    <div className="w-14 h-14 rounded-full bg-gradient-to-br from-pnw-teal/30 to-pnw-teal/10
                    flex items-center justify-center text-pnw-teal font-bold text-base shrink-0">
      {a}{b}
    </div>
  )
}

export default function NewsCommitments() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    fetch(`${API_BASE}/commitments?level=JUCO&limit=200`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => { if (alive) { setRows(d.commitments || []); setLoading(false) } })
      .catch(e => { if (alive) { setError(e.message); setLoading(false) } })
    return () => { alive = false }
  }, [])

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="mb-4">
        <h1 className="text-3xl font-bold text-gray-900">News</h1>
        <p className="text-sm text-gray-500 mt-1">
          Commitments, recaps, and notes from around PNW college baseball.
        </p>
      </div>

      <NewsTabs active="commitments" />

      {loading && <div className="text-gray-500 animate-pulse">Loading commitments…</div>}
      {error && <div className="text-rose-600">Could not load commitments: {error}</div>}

      {!loading && !error && rows.length === 0 && (
        <div className="text-gray-500 italic">No commitments yet.</div>
      )}

      {/* Section header */}
      {!loading && rows.length > 0 && (
        <>
          <div className="flex items-baseline justify-between mt-2 mb-3">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-pnw-teal">
              NWAC commitments
            </h2>
            <span className="text-xs text-gray-500">{rows.length} player{rows.length === 1 ? '' : 's'}</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {rows.map(c => (
              <a
                key={c.player_id}
                href={`/player/${c.player_id}`}
                className="group flex items-center gap-3 bg-white border border-gray-200 rounded-lg p-3
                           hover:border-nw-teal hover:shadow-md transition-all"
              >
                {/* Headshot or initials */}
                {c.headshot_url ? (
                  <img
                    src={c.headshot_url}
                    alt=""
                    className="w-14 h-14 rounded-full object-cover bg-gray-100 shrink-0"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none'
                      e.currentTarget.nextElementSibling?.style.removeProperty('display')
                    }}
                  />
                ) : (
                  <PlayerInitials first={c.first_name} last={c.last_name} />
                )}

                {/* Name + current team */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-gray-900 truncate group-hover:text-nw-teal">
                    {c.first_name} {c.last_name}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {c.team_logo && (
                      <img src={c.team_logo} alt="" className="w-3.5 h-3.5 object-contain shrink-0"
                           onError={(e) => { e.currentTarget.style.display = 'none' }} />
                    )}
                    <span className="text-[11px] text-gray-600 truncate">
                      {c.team_short}
                      {c.position ? ` · ${c.position}` : ''}
                      {c.year_in_school ? ` · ${c.year_in_school}` : ''}
                      {fmtHeight(c.height) ? ` · ${fmtHeight(c.height)}` : ''}
                      {c.weight ? ` · ${c.weight}` : ''}
                    </span>
                  </div>
                </div>

                {/* Commitment side */}
                <div className="text-right shrink-0">
                  <div className="text-[10px] uppercase tracking-wider text-emerald-600 font-bold">
                    Committed →
                  </div>
                  <div className="text-sm font-bold text-gray-900 truncate max-w-[10rem]"
                       title={c.committed_to}>
                    {c.committed_to}
                  </div>
                  <div className="text-[10px] text-gray-400 mt-0.5">
                    {fmtDate(c.commitment_date)}
                  </div>
                </div>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
