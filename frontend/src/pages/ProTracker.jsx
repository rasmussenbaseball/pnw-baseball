// Pro Tracker — PNW college alumni currently in affiliated pro baseball.
//
// Top: an overview "graphic" — headline totals plus a sorted bar ranking of
// every school by how many pros it has produced. Below: a team-by-team
// breakdown listing each alum, linked to their NWBB player page when we have
// one (players from before our 2018 coverage stay listed but unlinked) and to
// their MLB/MiLB stats page.

import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import InternCredit from '../components/InternCredit'

// Level badge styling, best level first. Tailwind needs literal class strings.
const LEVEL_STYLE = {
  MLB:  'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 ring-amber-300/50',
  AAA:  'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 ring-emerald-300/40',
  AA:   'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300 ring-sky-300/40',
  'A+': 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300 ring-teal-300/40',
  A:    'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300 ring-indigo-300/40',
  Rk:   'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300 ring-gray-400/40',
}
const LEVEL_LABEL = { MLB: 'MLB', AAA: 'Triple-A', AA: 'Double-A', 'A+': 'High-A', A: 'Single-A', Rk: 'Rookie' }

function LevelBadge({ level }) {
  const cls = LEVEL_STYLE[level] || 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300 ring-gray-400/40'
  return (
    <span className={`inline-flex items-center justify-center min-w-[3rem] px-2 py-0.5 rounded-md text-[11px] font-bold uppercase tracking-wide ring-1 ${cls}`}>
      {level || '—'}
    </span>
  )
}

function draftLine(p) {
  const yr = p.year_drafted || ''
  const pick = (p.pick || '').toUpperCase()
  const by = p.drafted_by || ''
  if (pick === 'NDFA') return `Undrafted FA${yr ? ` · ${yr}` : ''}${by ? ` · ${by}` : ''}`
  const pickTxt = pick ? `No. ${pick}` : ''
  return [yr, pickTxt, by].filter(Boolean).join(' · ')
}

function teamAnchor(id) { return `pro-team-${id}` }

function StatTile({ value, label, accent }) {
  return (
    <div className="rounded-xl bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 px-4 py-3 text-center">
      <div className={`text-3xl font-black tabular-nums ${accent || 'text-pnw-slate dark:text-gray-100'}`}>{value}</div>
      <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</div>
    </div>
  )
}

export default function ProTracker() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    fetch('/api/v1/pro-alumni')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(d => { if (alive) setData(d) })
      .catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [])

  const maxCount = useMemo(
    () => (data?.teams?.length ? Math.max(...data.teams.map(t => t.count)) : 1),
    [data]
  )

  if (error) {
    return <div className="max-w-3xl mx-auto py-16 text-center text-gray-500 dark:text-gray-400">Couldn't load the Pro Tracker ({error}).</div>
  }
  if (!data) {
    return <div className="max-w-3xl mx-auto py-16 text-center text-gray-500 dark:text-gray-400">Loading pro alumni…</div>
  }

  const { overview, teams } = data

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-6">
      {/* Page header */}
      <div className="mb-5">
        <h1 className="text-3xl sm:text-4xl font-black text-pnw-slate dark:text-gray-100">Pro Tracker</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Pacific Northwest college alumni in affiliated pro baseball (MiLB &amp; MLB). Names link to their
          NWBB profile where we have one.
        </p>
        <p className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-nw-teal bg-teal-50 dark:bg-teal-900/30 dark:text-teal-300 rounded-full px-3 py-1">
          Only players who have appeared in a game during the 2026 season are included.
        </p>
        <InternCredit names="Oliver Duthie" className="mt-2" />
      </div>

      {/* ── Overview graphic ── */}
      <div className="rounded-2xl bg-gradient-to-br from-pnw-slate to-[#1f3a4d] dark:from-gray-900 dark:to-gray-800 p-4 sm:p-6 shadow-lg mb-8">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <StatTile value={overview.total_players} label="Total Pros" />
          <StatTile value={overview.total_mlb} label="In the Majors" accent="text-amber-500 dark:text-amber-400" />
          <StatTile value={overview.total_orgs} label="MLB Orgs" />
          <StatTile value={overview.total_colleges} label="Schools" />
        </div>

        <div className="text-[11px] font-bold uppercase tracking-widest text-teal-200/80 mb-2">Pros by school</div>
        <div className="space-y-1.5">
          {teams.map(t => (
            <a
              key={t.team_id}
              href={`#${teamAnchor(t.team_id)}`}
              className="group flex items-center gap-2 sm:gap-3 rounded-lg px-2 py-1.5 hover:bg-white/10 transition-colors"
            >
              <div className="w-7 flex justify-center shrink-0">
                {t.logo_url
                  ? <img src={t.logo_url} alt="" className="w-6 h-6 object-contain" loading="lazy" onError={e => { e.target.style.display = 'none' }} />
                  : null}
              </div>
              <div className="w-20 sm:w-28 shrink-0 text-sm font-semibold text-white truncate">{t.short_name}</div>
              <div className="flex-1 h-5 rounded bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded bg-gradient-to-r from-nw-teal to-teal-300"
                  style={{ width: `${Math.max(6, (t.count / maxCount) * 100)}%` }}
                />
              </div>
              <div className="w-12 sm:w-14 shrink-0 text-right text-[10px] font-bold tabular-nums text-amber-300">
                {t.mlb_count > 0 ? `${t.mlb_count} MLB` : ''}
              </div>
              <div className="w-7 sm:w-8 shrink-0 text-right text-sm font-black tabular-nums text-white">{t.count}</div>
            </a>
          ))}
        </div>
      </div>

      {/* ── Team-by-team breakdown ── */}
      <div className="space-y-6">
        {teams.map(t => (
          <section key={t.team_id} id={teamAnchor(t.team_id)} className="scroll-mt-20">
            <div className="flex items-center gap-3 mb-2 px-1">
              {t.logo_url && (
                <img src={t.logo_url} alt="" className="w-9 h-9 object-contain shrink-0" loading="lazy" onError={e => { e.target.style.display = 'none' }} />
              )}
              <div className="min-w-0">
                <Link to={`/teams?team=${t.team_id}`} className="block text-lg font-extrabold text-pnw-slate dark:text-gray-100 hover:text-nw-teal truncate">
                  {t.name}
                </Link>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {t.count} {t.count === 1 ? 'pro' : 'pros'}{t.mlb_count > 0 ? ` · ${t.mlb_count} in MLB` : ''}
                  {t.division_level ? ` · ${t.division_level}` : ''}
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 overflow-hidden divide-y divide-gray-100 dark:divide-gray-700">
              {t.players.map((p, i) => (
                <div key={`${t.team_id}-${i}`} className="flex items-center gap-3 px-3 py-2.5">
                  <LevelBadge level={p.level} />
                  <div className="flex-1 min-w-0">
                    {p.player_id
                      ? <Link to={`/player/${p.player_id}`} className="font-semibold text-pnw-slate dark:text-gray-100 hover:text-nw-teal truncate block">{p.name}</Link>
                      : <span className="font-semibold text-pnw-slate dark:text-gray-100 truncate block">{p.name}</span>}
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{draftLine(p)}</div>
                  </div>
                  <div className="hidden sm:block w-44 shrink-0 text-right">
                    <div className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">{p.current_team || p.affiliate}</div>
                    {p.affiliate && p.affiliate !== p.current_team && (
                      <div className="text-[11px] text-gray-400 dark:text-gray-500 truncate">{p.affiliate} system</div>
                    )}
                  </div>
                  {p.stats_url && (
                    <a
                      href={p.stats_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="MLB/MiLB stats page"
                      className="shrink-0 text-gray-400 hover:text-nw-teal transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5M19 5l-7 7M10 5H5v14h14v-5" />
                      </svg>
                    </a>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <p className="mt-8 text-center text-[11px] text-gray-400 dark:text-gray-500">
        Players who attended more than one PNW school appear under each. Pre-2018 alumni are listed but may not have a profile page yet.
      </p>
    </div>
  )
}
