// /news/commitments — running list of recent commitments.
//
// Phase 1: NWAC (JUCO) player commitments — `players.is_committed=1`,
// `committed_to` set. Sorted newest first (by updated_at).
// Phase 2 (coming): HS commitments to PNW schools — same page, second
// section once that data starts flowing in.

import { useEffect, useState } from 'react'

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

// Tidy AVG: drop the leading zero so .350 reads cleaner than 0.350.
function fmtAvg(v) {
  if (v == null) return '–'
  return Number(v).toFixed(3).replace(/^0\./, '.')
}

function fmtIp(v) {
  if (v == null) return '–'
  return Number(v).toFixed(1)
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

// Stat strip shown under the player's bio. Renders batting and/or
// pitching lines depending on what the backend included.
function StatStrip({ batting, pitching }) {
  const lines = []
  if (batting) {
    const sb = batting.sb ? ` · ${batting.sb} SB` : ''
    lines.push(
      <span key="b" className="text-[11px] font-semibold text-emerald-700 tabular-nums">
        {fmtAvg(batting.avg)} · {batting.hr || 0} HR · {batting.rbi || 0} RBI{sb}
        <span className="ml-1 font-medium text-emerald-700/60">({batting.pa} PA)</span>
      </span>
    )
  }
  if (pitching) {
    lines.push(
      <span key="p" className="text-[11px] font-semibold text-sky-700 tabular-nums">
        {fmtIp(pitching.ip)} IP · {pitching.k} K · {pitching.era != null ? pitching.era.toFixed(2) : '–'} ERA
      </span>
    )
  }
  if (!lines.length) return null
  return <div className="flex flex-col gap-0.5 mt-1.5">{lines}</div>
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
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Commitments</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          NWAC players committing to 4-year programs. (HS commitments to PNW schools coming soon.)
        </p>
      </div>

      {loading && <div className="text-gray-500 dark:text-gray-400 animate-pulse">Loading commitments…</div>}
      {error && <div className="text-rose-600">Could not load commitments: {error}</div>}

      {!loading && !error && rows.length === 0 && (
        <div className="text-gray-500 dark:text-gray-400 italic">No commitments yet.</div>
      )}

      {!loading && rows.length > 0 && (
        <>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-pnw-teal">
              NWAC commitments
            </h2>
            <span className="text-xs text-gray-500 dark:text-gray-400">{rows.length} player{rows.length === 1 ? '' : 's'}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {rows.map(c => <CommitmentCard key={c.player_id} c={c} />)}
          </div>
        </>
      )}
    </div>
  )
}


function CommitmentCard({ c }) {
  const committedTeam = c.committed_team  // { team_id, short_name, school_name, logo_url } or null

  return (
    <a
      href={`/player/${c.player_id}`}
      className="group flex items-start gap-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3
                 hover:border-nw-teal hover:shadow-md transition-all"
    >
      {/* Headshot / initials */}
      {c.headshot_url ? (
        <img
          src={c.headshot_url}
          alt=""
          className="w-14 h-14 rounded-full object-cover bg-gray-100 dark:bg-gray-700 shrink-0"
          onError={(e) => { e.currentTarget.style.display = 'none' }}
        />
      ) : (
        <PlayerInitials first={c.first_name} last={c.last_name} />
      )}

      {/* Player bio + stats */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-gray-900 dark:text-gray-100 truncate group-hover:text-nw-teal">
          {c.first_name} {c.last_name}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          {c.team_logo && (
            <img src={c.team_logo} alt="" className="w-3.5 h-3.5 object-contain shrink-0"
                 onError={(e) => { e.currentTarget.style.display = 'none' }} />
          )}
          <span className="text-[11px] text-gray-600 dark:text-gray-400 truncate">
            {c.team_short}
            {c.position ? ` · ${c.position}` : ''}
            {c.year_in_school ? ` · ${c.year_in_school}` : ''}
            {fmtHeight(c.height) ? ` · ${fmtHeight(c.height)}` : ''}
            {c.weight ? ` · ${c.weight}` : ''}
          </span>
        </div>
        <StatStrip batting={c.batting} pitching={c.pitching} />
      </div>

      {/* Commitment side */}
      <div className="text-right shrink-0 max-w-[10rem]">
        <div className="text-[10px] uppercase tracking-wider text-emerald-600 font-bold mb-1">
          Committed →
        </div>
        {committedTeam?.logo_url ? (
          <div className="flex items-center justify-end gap-1.5 mb-0.5">
            <img
              src={committedTeam.logo_url}
              alt=""
              className="w-5 h-5 object-contain"
              onError={(e) => { e.currentTarget.style.display = 'none' }}
            />
            <span className="text-sm font-bold text-gray-900 dark:text-gray-100 truncate" title={c.committed_to}>
              {c.committed_to}
            </span>
          </div>
        ) : (
          <div className="text-sm font-bold text-gray-900 dark:text-gray-100 truncate mb-0.5"
               title={c.committed_to}>
            {c.committed_to}
          </div>
        )}
        {/* Commitment date intentionally hidden: the backend currently
            returns players.updated_at (last scrape touch), not the real
            date the player committed. Hidden until a true committed_at
            timestamp is tracked. */}
      </div>
    </a>
  )
}
