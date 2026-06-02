// RecruitingHomepage — the homepage for RECRUITING tier users
// ($10/mo, aimed at college coaches).
//
// It mirrors the premium homepage exactly (same welcome, toolbox, data
// widgets, mock player deep-dives, coaching-sim block) and adds ONE
// recruiting-only thing in the showcase slot directly beneath the
// toolbox: side-by-side "Top Uncommitted JUCO" and "Top Transfer
// Portal" boards, each linking to its full tracker.
//
// Wired in App.jsx HomepageRouter on tier === 'recruiting'.

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import PremiumHomepage from './PremiumHomepage'

const SEASON = 2026


export default function RecruitingHomepage() {
  return <PremiumHomepage portalShowcase={<RecruitingShowcase />} />
}


// ============================================================
// RECRUITING SHOWCASE — two live boards (uncommitted JUCO +
// transfer portal), each linking to its tracker.
// ============================================================
function RecruitingShowcase() {
  return (
    <section className="rounded-xl overflow-hidden border border-nw-teal/20 dark:border-nw-teal/40 shadow-sm">
      {/* Teal banner ties this block to the recruiting brand */}
      <div className="bg-gradient-to-r from-pnw-slate via-nw-teal to-pnw-sky text-white px-4 sm:px-5 py-4 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[2px] text-amber-300 mb-0.5">
            Recruiting · Included
          </div>
          <h2 className="text-lg sm:text-xl font-extrabold leading-tight">
            Your Recruiting Boards
          </h2>
          <p className="text-xs text-white/75 max-w-xl leading-snug mt-1">
            Live transfer targets across the Pacific Northwest: uncommitted NWAC
            sophomores and four-year players in the portal, ranked by WAR.
          </p>
        </div>
        <Link
          to="/coaching/juco-tracker"
          className="shrink-0 px-4 py-2 rounded-lg bg-amber-400 text-[#003845] font-bold text-xs hover:bg-amber-300 transition-colors"
        >
          Open the trackers →
        </Link>
      </div>

      <div className="bg-white dark:bg-gray-800 p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <RecruitBoard
          title="Top Uncommitted JUCO"
          subtitle="Sophomores by WAR · transfer targets"
          endpoint="/players/juco/uncommitted"
          params={{ season: SEASON, year_in_school: 'So', sort_by: 'total_war', sort_dir: 'desc', limit: 60 }}
          filterUncommitted
          trackerTo="/coaching/juco-tracker"
          trackerLabel="Open the JUCO Tracker →"
        />
        <RecruitBoard
          title="Top Transfer Portal"
          subtitle="Four-year entrants by WAR"
          endpoint="/transfer-portal"
          params={{ season: SEASON, sort_by: 'total_war', sort_dir: 'desc' }}
          trackerTo="/coaching/transfer-portal"
          trackerLabel="Open the Transfer Portal Tracker →"
        />
      </div>
    </section>
  )
}


// ------------------------------------------------------------
// A single live board — pulls the top 5 from a tracker endpoint
// (auth token attached by useApi, so recruiting/coach/dev get data)
// and links to the full tracker.
// ------------------------------------------------------------
function fmtWar(v) {
  const n = Number(v || 0)
  return n.toFixed(1)
}
function fmtAvg(v) {
  if (v == null) return '-'
  const n = Number(v)
  return n >= 1 ? n.toFixed(3) : n.toFixed(3).replace(/^0/, '')
}

function RecruitBoard({ title, subtitle, endpoint, params, filterUncommitted, trackerTo, trackerLabel }) {
  const { data, loading } = useApi(endpoint, params, [])

  const top5 = useMemo(() => {
    if (!Array.isArray(data)) return []
    const rows = filterUncommitted
      ? data.filter((p) => !p.committed_to && !p.is_committed)
      : data
    return rows.slice(0, 5)
  }, [data, filterUncommitted])

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col">
      <div className="px-3 py-2 bg-nw-teal/5 dark:bg-nw-teal/15 border-b border-gray-200 dark:border-gray-700">
        <div className="text-[10px] font-bold uppercase tracking-[1.5px] text-nw-teal">
          {title}
        </div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400">{subtitle}</div>
      </div>

      {loading ? (
        <div className="p-4 text-center text-xs text-gray-400 animate-pulse">Loading players…</div>
      ) : top5.length === 0 ? (
        <div className="p-4 text-center text-xs text-gray-400">No players found.</div>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-700/60">
          {top5.map((p, i) => {
            const isPitcher = (Number(p.pitching_war) || 0) > (Number(p.offensive_war) || 0)
            const secondary = isPitcher
              ? ['ERA', p.era != null ? Number(p.era).toFixed(2) : '-']
              : ['AVG', fmtAvg(p.batting_avg)]
            return (
              <li key={p.id} className="flex items-center gap-2 px-3 py-2">
                <span className="text-[11px] font-bold tabular-nums text-gray-400 dark:text-gray-500 w-4 shrink-0 text-right">
                  {i + 1}
                </span>
                {p.logo_url ? (
                  <img src={p.logo_url} alt="" className="w-5 h-5 object-contain shrink-0"
                    onError={(e) => { e.target.style.display = 'none' }} />
                ) : <span className="w-5 h-5 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <Link
                    to={`/player/${p.id}`}
                    className="block text-xs font-semibold text-nw-teal hover:underline truncate leading-tight"
                  >
                    {p.first_name} {p.last_name}
                  </Link>
                  <div className="text-[10px] text-gray-500 dark:text-gray-400 truncate">
                    {p.team_short || p.team_name}{p.position ? ` · ${p.position}` : ''}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-extrabold tabular-nums text-gray-900 dark:text-gray-100 leading-none">
                    {fmtWar(p.total_war)}
                  </div>
                  <div className="text-[9px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mt-0.5">
                    WAR · {secondary[0]} {secondary[1]}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <Link
        to={trackerTo}
        className="mt-auto block px-3 py-2 text-center text-[11px] font-bold uppercase tracking-wider text-nw-teal border-t border-gray-200 dark:border-gray-700 hover:bg-nw-teal/5 dark:hover:bg-nw-teal/15 transition-colors"
      >
        {trackerLabel}
      </Link>
    </div>
  )
}
