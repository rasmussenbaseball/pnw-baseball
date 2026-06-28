/**
 * Conference landing page (/conference/:slug, slug = lowercased abbreviation).
 * SEO target for "GNAC baseball stats", "GNAC standings", "NWC baseball schedule",
 * etc. Reuses the /standings data and links out to every member team. The
 * entity-specific <title>/description/JSON-LD is injected server-side by the
 * Vercel edge middleware (see frontend/middleware.js + backend seo.py).
 */
import { Link, useParams } from 'react-router-dom'
import { useStandings } from '../hooks/useApi'
import { CURRENT_SEASON } from '../lib/seasons'

const BADGE_COLORS = {
  D1: 'bg-red-600 text-white', D2: 'bg-blue-600 text-white', D3: 'bg-green-600 text-white',
  NAIA: 'bg-purple-600 text-white', JUCO: 'bg-amber-700 text-white',
}
const LEVEL_LABEL = {
  D1: 'NCAA Division I', D2: 'NCAA Division II', D3: 'NCAA Division III',
  NAIA: 'NAIA', JUCO: 'NWAC / JUCO',
}

const slugify = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const fmtPct = (p) => (p == null ? '-' : p === 1 ? '1.000' : `.${String(Math.round(p * 1000)).padStart(3, '0')}`)

export default function ConferencePage() {
  const { slug } = useParams()
  const { data, loading } = useStandings(CURRENT_SEASON)
  const conferences = data?.conferences || []
  const conf = conferences.find((c) => slugify(c.conference_abbrev) === slug)

  if (loading) {
    return <div className="py-16 text-center text-gray-400 animate-pulse">Loading conference…</div>
  }
  if (!conf) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">Conference not found</h1>
        <p className="mt-2 text-gray-500">
          <Link to="/standings" className="text-nw-teal hover:underline">Browse all conference standings →</Link>
        </p>
      </div>
    )
  }

  const abbr = conf.conference_abbrev
  const name = conf.conference_name
  const level = conf.division_level
  const teams = conf.teams || []

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 py-6">
      <div className="mb-1 text-sm text-gray-400">
        <Link to="/standings" className="hover:text-nw-teal">Standings</Link> · {LEVEL_LABEL[level] || level}
      </div>
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-gray-100">
          {name} Baseball
        </h1>
        <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${BADGE_COLORS[level] || 'bg-gray-500 text-white'}`}>
          {level}
        </span>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-5 max-w-3xl">
        {abbr} ({name}) {CURRENT_SEASON} {LEVEL_LABEL[level] || ''} college baseball standings, team and
        player stats, advanced metrics, and schedule. Tracking all {teams.length} {abbr} programs.
      </p>

      <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-left">
            <tr>
              <th className="px-3 py-2 font-semibold">Team</th>
              <th className="px-3 py-2 font-semibold text-center">Conf</th>
              <th className="px-3 py-2 font-semibold text-center">Pct</th>
              <th className="px-3 py-2 font-semibold text-center">Overall</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {teams.map((t) => (
              <tr key={t.id} className="bg-white dark:bg-gray-900 hover:bg-portal-cream dark:hover:bg-gray-800">
                <td className="px-3 py-2.5">
                  <Link to={`/team/${t.id}`} className="flex items-center gap-2 font-semibold text-nw-teal hover:underline">
                    {t.logo_url && <img src={t.logo_url} alt="" className="w-5 h-5 object-contain"
                      onError={(e) => { e.target.style.display = 'none' }} />}
                    {t.short_name}
                  </Link>
                </td>
                <td className="px-3 py-2.5 text-center tabular-nums text-gray-700 dark:text-gray-300">
                  {t.conf_wins || t.conf_losses ? `${t.conf_wins}-${t.conf_losses}` : '-'}
                </td>
                <td className="px-3 py-2.5 text-center tabular-nums font-mono text-gray-500">
                  {t.conf_wins || t.conf_losses ? fmtPct(t.conf_win_pct) : '-'}
                </td>
                <td className="px-3 py-2.5 text-center tabular-nums text-gray-500">
                  {t.overall_wins != null ? `${t.overall_wins}-${t.overall_losses}` : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-5 flex flex-wrap gap-3 text-sm">
        <Link to="/standings" className="text-nw-teal hover:underline">Full standings →</Link>
        <Link to="/leaderboards" className="text-nw-teal hover:underline">Stat leaders →</Link>
        <Link to="/teams" className="text-nw-teal hover:underline">All teams →</Link>
      </div>
    </div>
  )
}
