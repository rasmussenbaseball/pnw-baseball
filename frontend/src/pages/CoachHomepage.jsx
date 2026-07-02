// CoachHomepage — the homepage for COACH & SCOUT tier users (and the
// "My View" homepage for site developers).
//
// It mirrors the premium homepage exactly (same welcome, toolbox, data
// widgets, mock player deep-dives, coaching-sim block) and adds ONE
// coach-only thing: a Portal Showcase widget directly beneath the
// toolbox that surfaces everything in the Coach & Scout portal —
// opponent scouting, lineup optimization, printable PDFs, and a live
// "top uncommitted NWAC players" board pulled straight from the JUCO
// tracker.
//
// Wired in App.jsx HomepageRouter on tier === 'coach' || tier === 'dev'.

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import PremiumHomepage from './PremiumHomepage'
import { CURRENT_SEASON } from '../lib/seasons'

const SEASON = CURRENT_SEASON


export default function CoachHomepage() {
  return <PremiumHomepage portalShowcase={<PortalShowcase />} />
}


// ============================================================
// PORTAL SHOWCASE — everything in the Coach & Scout portal, with a
// live uncommitted-JUCO board on the side.
// ============================================================
const PORTAL_TOOLS = [
  { to: '/portal/series-planner', label: 'Series Planner',
    desc: 'Full pre-series game plan for any opponent', icon: 'target' },
  { to: '/portal/splits', label: 'Splits Explorer',
    desc: 'Filter any team by game state, count, hand, home/away', icon: 'trend' },
  { to: '/portal/custom-sheet', label: 'Custom Sheet',
    desc: 'Build a sheet: pick the filters and stat columns you want', icon: 'clipboard' },
  { to: '/portal/custom-card', label: 'Custom Player Card',
    desc: 'Build cards from blocks, save templates, print rosters in bulk', icon: 'user' },
  { to: '/coaching/juco-tracker', label: 'JUCO Tracker',
    desc: 'Uncommitted NWAC transfer targets', icon: 'search' },
  { to: '/portal/lineup-helper', label: 'Lineup Helper',
    desc: 'Optimal batting orders vs RHP / LHP', icon: 'lineup' },
  { to: '/portal/team-scouting', label: 'Team Scouting',
    desc: 'Full opponent report, every stat + percentile', icon: 'clipboard' },
  { to: '/portal/alignments', label: 'Defensive Alignments',
    desc: 'Per-hitter spray + shift calls (5 IF / 5 OF lanes)', icon: 'target' },
  { to: '/portal/trends', label: 'Trends',
    desc: 'Lineup, rotation & bullpen tendencies', icon: 'trend' },
  { to: '/portal/historic', label: 'Historic Matchups',
    desc: 'Per-PA matchup history vs an opponent', icon: 'history' },
  { to: '/portal/player-scouting', label: 'Player Scouting',
    desc: 'Individual scouting reports', icon: 'user' },
  { to: '/portal/pdfs', label: 'Reporting',
    desc: 'Scouting sheets, cards & boards — save as PDF or image', icon: 'pdf' },
  { to: '/portal/bullpen-sheet', label: 'Bullpen Sheet',
    desc: 'In-game pitcher decision card', icon: 'bullpen' },
]

function PortalToolIcon({ name }) {
  const common = 'w-5 h-5'
  const paths = {
    search: 'M21 21l-4.3-4.3M11 18a7 7 0 100-14 7 7 0 000 14z',
    lineup: 'M4 6h16M4 12h16M4 18h10',
    clipboard: 'M9 4h6a1 1 0 011 1v1h2a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h2V5a1 1 0 011-1zm0 2v1h6V6M8 11h8m-8 4h5',
    trend: 'M3 17l6-6 4 4 7-8m0 0h-4m4 0v4',
    history: 'M3 12a9 9 0 109-9 9 9 0 00-9 9zm0 0H1m2 0l2.5-2.5M12 7v5l3 2',
    user: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM5 21v-1a6 6 0 0112 0v1',
    pdf: 'M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zm7 0v5h5M9 13h6m-6 3h4',
    bullpen: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 0v9l5 3',
    target: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 4a5 5 0 100 10 5 5 0 000-10zm0 4a1 1 0 100 2 1 1 0 000-2z',
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" className={common}>
      <path d={paths[name] || paths.clipboard} />
    </svg>
  )
}

function PortalShowcase() {
  return (
    <section className="rounded-xl overflow-hidden border border-portal-purple/20 dark:border-portal-purple/40 shadow-sm">
      {/* Purple banner header ties this block to the portal brand */}
      <div className="bg-gradient-to-r from-portal-purple via-portal-purple to-portal-purple-light text-portal-cream px-4 sm:px-5 py-4 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[2px] text-portal-accent mb-0.5">
            Coach &amp; Scout · Included
          </div>
          <h2 className="text-lg sm:text-xl font-extrabold leading-tight">
            Your Coaching &amp; Scouting Portal
          </h2>
          <p className="text-xs text-portal-cream/75 max-w-xl leading-snug mt-1">
            A dedicated workspace built for staffs: opponent scouting, lineup
            optimization, printable game-day PDFs, and the JUCO transfer tracker.
          </p>
        </div>
        <Link
          to="/portal"
          className="shrink-0 px-4 py-2 rounded-lg bg-portal-accent text-portal-purple-dark font-bold text-xs hover:bg-portal-accent-light transition-colors"
        >
          Open the Portal →
        </Link>
      </div>

      <div className="bg-white dark:bg-gray-800 p-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Tool tiles — span 2 columns */}
        <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-2.5 content-start">
          {PORTAL_TOOLS.map((t) => (
            <Link
              key={t.label}
              to={t.to}
              className="group flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 p-3 hover:border-portal-purple dark:hover:border-portal-accent hover:shadow-sm transition-all"
            >
              <span className="shrink-0 w-9 h-9 rounded-lg bg-portal-purple/10 dark:bg-portal-purple/25 text-portal-purple dark:text-portal-accent flex items-center justify-center group-hover:bg-portal-purple group-hover:text-white transition-colors">
                <PortalToolIcon name={t.icon} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-gray-900 dark:text-gray-100 group-hover:text-portal-purple dark:group-hover:text-portal-accent transition-colors truncate">
                  {t.label}
                </span>
                <span className="block text-[11px] text-gray-500 dark:text-gray-400 truncate">
                  {t.desc}
                </span>
              </span>
            </Link>
          ))}
        </div>

        {/* Live uncommitted-JUCO board */}
        <UncommittedJucoBoard />
      </div>
    </section>
  )
}


// ------------------------------------------------------------
// Top uncommitted NWAC players — pulled live from the same
// endpoint the JUCO tracker uses. Coach-tier gated server-side;
// useApi attaches the auth token, so coach/dev callers get data.
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

function UncommittedJucoBoard() {
  const { data, loading } = useApi('/players/juco/uncommitted', {
    season: SEASON,
    year_in_school: 'So',
    sort_by: 'total_war',
    sort_dir: 'desc',
    limit: 60,
  }, [])

  const top5 = useMemo(() => {
    if (!Array.isArray(data)) return []
    return data
      .filter((p) => !p.committed_to && !p.is_committed)
      .slice(0, 5)
  }, [data])

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col">
      <div className="px-3 py-2 bg-portal-purple/5 dark:bg-portal-purple/20 border-b border-gray-200 dark:border-gray-700">
        <div className="text-[10px] font-bold uppercase tracking-[1.5px] text-portal-purple dark:text-portal-accent">
          Top Uncommitted JUCO
        </div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400">
          Sophomores by WAR · transfer targets
        </div>
      </div>

      {loading ? (
        <div className="p-4 text-center text-xs text-gray-400 animate-pulse">Loading players…</div>
      ) : top5.length === 0 ? (
        <div className="p-4 text-center text-xs text-gray-400">No uncommitted sophomores found.</div>
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
                    className="block text-xs font-semibold text-portal-purple dark:text-portal-accent hover:underline truncate leading-tight"
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
        to="/coaching/juco-tracker"
        className="mt-auto block px-3 py-2 text-center text-[11px] font-bold uppercase tracking-wider text-portal-purple dark:text-portal-accent border-t border-gray-200 dark:border-gray-700 hover:bg-portal-purple/5 dark:hover:bg-portal-purple/20 transition-colors"
      >
        Open the JUCO Tracker →
      </Link>
    </div>
  )
}
