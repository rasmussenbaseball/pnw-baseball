import { useState, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { useRecruitingClasses, useRecruitingClassDetail } from '../hooks/useApi'
import { divisionBadgeClass } from '../utils/stats'

// Grad years that have been scraped. Future years come online as they're
// scraped, so adding one here is all it takes to extend the selector.
const GRAD_YEARS = [2026]

// Single chip showing a recruit's State Rank, or a muted "Unranked".
function RankChips({ stateRank }) {
  if (stateRank == null) {
    return <span className="text-[10px] font-medium text-gray-400 dark:text-gray-500 italic">Unranked</span>
  }
  return (
    <span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded bg-teal-50 text-nw-teal dark:bg-teal-900/30 dark:text-teal-300 whitespace-nowrap">
      State Rank #{stateRank}
    </span>
  )
}

// Inline expanded panel: a school's full commit list, fetched lazily.
function ExpandedClass({ teamId, gradYear, colSpan }) {
  const { data, loading, error } = useRecruitingClassDetail(teamId, gradYear)

  return (
    <tr className="bg-nw-cream/40 dark:bg-gray-900/40">
      <td colSpan={colSpan} className="px-3 sm:px-4 py-3">
        {loading && (
          <div className="text-center py-4 text-xs text-gray-400 dark:text-gray-500">Loading commits...</div>
        )}
        {error && (
          <div className="text-center py-4 text-xs text-red-400">Couldn't load this class.</div>
        )}
        {data && (
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
              {data.team?.name} commits ({data.commit_count}
              {data.scored_count != null ? ` · ${data.scored_count} rated` : ''}
              {data.class_score != null ? ` · ${data.class_score.toFixed(1)} avg rating` : ''})
            </div>
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700 text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <th className="px-3 py-1.5 text-left font-semibold">Commit</th>
                    <th className="px-3 py-1.5 text-center font-semibold">Pos</th>
                    <th className="px-3 py-1.5 text-left font-semibold">High School</th>
                    <th className="px-3 py-1.5 text-center font-semibold">Ht / Wt</th>
                    <th className="px-3 py-1.5 text-left font-semibold">State Rank</th>
                    <th className="px-3 py-1.5 text-center font-semibold">Rating</th>
                  </tr>
                </thead>
                <tbody>
                  {data.commits.map((c, i) => (
                    <tr
                      key={c.id}
                      className={`border-b border-gray-100 dark:border-gray-700 last:border-0 ${i % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/50 dark:bg-gray-900/20'}`}
                    >
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          {c.headshot_url ? (
                            <img
                              src={c.headshot_url}
                              alt=""
                              className="w-6 h-6 rounded-full object-cover shrink-0"
                              loading="lazy"
                              onError={(e) => { e.target.style.display = 'none' }}
                            />
                          ) : (
                            <div className="w-6 h-6 rounded-full bg-gray-100 dark:bg-gray-700 shrink-0" />
                          )}
                          <span className="text-xs font-semibold text-gray-800 dark:text-gray-200 whitespace-nowrap">{c.name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-center text-xs font-semibold text-gray-600 dark:text-gray-400">{c.position || '-'}</td>
                      <td className="px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400">
                        <span className="whitespace-nowrap">{c.high_school || '-'}</span>
                        {(c.city || c.state) && (
                          <span className="block text-[10px] text-gray-400 dark:text-gray-500">
                            {[c.city, c.state].filter(Boolean).join(', ')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-center text-[11px] text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {c.height || c.weight
                          ? `${c.height || '-'}${c.weight ? ` / ${c.weight}` : ''}`
                          : '-'}
                      </td>
                      <td className="px-3 py-1.5">
                        <RankChips stateRank={c.state_rank} />
                      </td>
                      <td className="px-3 py-1.5 text-center text-xs tabular-nums">
                        {c.recruit_score != null ? (
                          <span className="font-bold text-nw-teal dark:text-nw-teal-light">
                            {Math.round(c.recruit_score)}
                          </span>
                        ) : (
                          <span className="text-[10px] italic text-gray-400 dark:text-gray-500">No ranking</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </td>
    </tr>
  )
}

export default function RecruitingClasses() {
  const [gradYear, setGradYear] = useState(2026)
  const [expanded, setExpanded] = useState(null)
  const { data, loading, error } = useRecruitingClasses(gradYear)

  const classes = data?.classes || []
  // The best class_score anchors the relative bar widths. Classes can now be
  // unranked (class_rank null) with a null class_score, so derive the max
  // from the numeric scores rather than assuming classes[0].
  const topScore = classes.reduce(
    (max, c) => (c.class_score != null && c.class_score > max ? c.class_score : max),
    0,
  )
  const COL_SPAN = 4

  const toggle = (teamId) => setExpanded((cur) => (cur === teamId ? null : teamId))

  return (
    <div>
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">{gradYear} Recruiting Classes</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 max-w-3xl">
        High school commits to PNW college programs, graded by their State Rank. Each school's Class
        Rating is the average prospect rating of its ranked commits (0 to 100), weighted by state.
        Depth and unrated commits do not inflate it. Expand a row to see the full incoming class.
      </p>

      {/* Grad-year selector */}
      <div className="flex items-center gap-2 mb-4">
        <label htmlFor="gradYear" className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Class
        </label>
        <select
          id="gradYear"
          value={gradYear}
          onChange={(e) => { setGradYear(Number(e.target.value)); setExpanded(null) }}
          className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-medium text-gray-700 dark:text-gray-200 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-nw-teal"
        >
          {GRAD_YEARS.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      {loading && (
        <div className="text-center py-12 text-gray-400 dark:text-gray-500">Loading recruiting classes...</div>
      )}
      {error && (
        <div className="text-center py-12 text-red-400">Error: {error}</div>
      )}

      {!loading && !error && classes.length === 0 && (
        <div className="text-center py-12 text-gray-400 dark:text-gray-500">No commits found for {gradYear}.</div>
      )}

      {!loading && !error && classes.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700 text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">
                <th className="px-3 py-2 text-center font-semibold w-10">#</th>
                <th className="px-3 py-2 text-left font-semibold">Program</th>
                <th className="px-3 py-2 text-center font-semibold whitespace-nowrap">Commits</th>
                <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Class Rating</th>
              </tr>
            </thead>
            <tbody>
              {classes.map((cls, i) => {
                const isOpen = expanded === cls.team_id
                // class_rank is now nullable: only classes with >= 3 scored
                // commits get a number. Unranked classes sort last and render
                // without a rank / medallion.
                const hasRank = cls.class_rank != null
                const hasScore = cls.class_score != null
                const isTop3 = hasRank && cls.class_rank <= 3
                const pct = hasScore && topScore > 0
                  ? Math.max(4, (cls.class_score / topScore) * 100)
                  : 0
                return (
                  <Fragment key={cls.team_id}>
                    <tr
                      onClick={() => toggle(cls.team_id)}
                      className={`border-b border-gray-100 dark:border-gray-700 cursor-pointer transition-colors ${
                        isOpen ? 'bg-teal-50/60 dark:bg-teal-900/20' : 'hover:bg-blue-50/40 dark:hover:bg-gray-700/40'
                      } ${i % 2 === 0 && !isOpen ? 'bg-white dark:bg-gray-800' : ''} ${i % 2 !== 0 && !isOpen ? 'bg-gray-50/50 dark:bg-gray-900/20' : ''}`}
                    >
                      {/* Rank */}
                      <td className="px-3 py-2.5 text-center">
                        <span className={`inline-flex items-center justify-center text-sm font-black tabular-nums ${
                          isTop3 ? 'text-amber-500' : 'text-gray-400 dark:text-gray-500'
                        }`}>
                          {hasRank ? cls.class_rank : '—'}
                        </span>
                      </td>

                      {/* Program */}
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className={`text-gray-300 dark:text-gray-600 text-xs transition-transform ${isOpen ? 'rotate-90' : ''}`}>&rsaquo;</span>
                          {cls.logo_url ? (
                            <img
                              src={cls.logo_url}
                              alt=""
                              className="w-6 h-6 object-contain shrink-0"
                              loading="lazy"
                              onError={(e) => { e.target.style.display = 'none' }}
                            />
                          ) : (
                            <div className="w-6 h-6 shrink-0" />
                          )}
                          <span className="text-xs font-semibold text-gray-800 dark:text-gray-200 whitespace-nowrap">
                            {cls.name}
                          </span>
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${divisionBadgeClass(cls.division)}`}>
                            {cls.division}
                          </span>
                        </div>
                      </td>

                      {/* Commits: rated (scored) of total */}
                      <td className="px-3 py-2.5 text-center text-xs text-gray-700 dark:text-gray-300 tabular-nums whitespace-nowrap">
                        <span className="font-semibold">{cls.scored_commits ?? cls.ranked ?? 0} rated</span>
                        <span className="text-gray-400 dark:text-gray-500"> · {cls.commits} total</span>
                      </td>

                      {/* Class rating (0-100 avg) + bar */}
                      <td className="px-3 py-2.5">
                        {hasScore ? (
                          <div className="flex items-center gap-2 min-w-[120px]">
                            <span className="text-sm font-black tabular-nums text-nw-teal dark:text-nw-teal-light w-10 text-right">
                              {cls.class_score.toFixed(1)}
                            </span>
                            <div className="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                              <div
                                className={`h-full rounded-full ${isTop3 ? 'bg-amber-400' : 'bg-nw-teal'}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        ) : (
                          <span className="text-[11px] italic text-gray-400 dark:text-gray-500">
                            Not enough ranked commits to rate
                          </span>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <ExpandedClass
                        teamId={cls.team_id}
                        gradYear={gradYear}
                        colSpan={COL_SPAN}
                      />
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      {!loading && !error && classes.length > 0 && (
        <div className="mt-4 px-1 text-[10px] text-gray-400 dark:text-gray-500 space-y-1 max-w-3xl">
          <p><strong>Class Rating</strong> is the average prospect rating (0 to 100) of each class's ranked commits, weighted by state. Depth and unrated commits do not inflate it. The bar shows each rating relative to the top class.</p>
          <p><strong>Commits</strong> shows rated (from states we rank) of total. Classes with fewer than 3 rated commits are not ranked and sort last.</p>
          <p className="italic">2026 commitments trickle in through the cycle, so classes will keep filling out.</p>
        </div>
      )}
    </div>
  )
}
