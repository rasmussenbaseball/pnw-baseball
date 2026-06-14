import { useState, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { useRecruitingClasses, useRecruitingClassDetail } from '../hooks/useApi'
import { divisionBadgeClass } from '../utils/stats'

// Grad years that have been scraped. Future years come online as they're
// scraped, so adding one here is all it takes to extend the selector.
const GRAD_YEARS = [2026]

// Small chip showing a recruit's source ranking, or a muted "Unranked".
function RankChips({ bbnw, pbr }) {
  const chips = []
  if (bbnw != null) chips.push(['BBNW', bbnw])
  if (pbr != null) chips.push(['PBR', pbr])
  if (chips.length === 0) {
    return <span className="text-[10px] font-medium text-gray-400 dark:text-gray-500 italic">Unranked</span>
  }
  return (
    <span className="flex flex-wrap gap-1">
      {chips.map(([label, rank]) => (
        <span
          key={label}
          className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded bg-teal-50 text-nw-teal dark:bg-teal-900/30 dark:text-teal-300 whitespace-nowrap"
        >
          {label} #{rank}
        </span>
      ))}
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
              {data.team?.name} commits ({data.commit_count})
            </div>
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700 text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <th className="px-3 py-1.5 text-left font-semibold">Commit</th>
                    <th className="px-3 py-1.5 text-center font-semibold">Pos</th>
                    <th className="px-3 py-1.5 text-left font-semibold">High School</th>
                    <th className="px-3 py-1.5 text-center font-semibold">Ht / Wt</th>
                    <th className="px-3 py-1.5 text-left font-semibold">Ranking</th>
                    <th className="px-3 py-1.5 text-center font-semibold">Score</th>
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
                        <RankChips bbnw={c.bbnw_state_rank} pbr={c.pbr_state_rank} />
                      </td>
                      <td className="px-3 py-1.5 text-center text-xs font-bold tabular-nums text-nw-teal dark:text-nw-teal-light">
                        {c.recruit_score != null ? Math.round(c.recruit_score) : '-'}
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
  // #1 score anchors the relative bar widths.
  const topScore = classes.length ? classes[0].class_score : 0
  const COL_SPAN = 6

  const toggle = (teamId) => setExpanded((cur) => (cur === teamId ? null : teamId))

  return (
    <div>
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">{gradYear} Recruiting Classes</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 max-w-3xl">
        High school commits to PNW college programs, graded by their PBR and BBNW state rankings.
        Each school's class score sums the value of every commit, so programs landing more (and more
        highly ranked) players rise to the top. Expand a row to see the full incoming class.
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
                <th className="px-3 py-2 text-center font-semibold whitespace-nowrap">Ranked</th>
                <th className="px-3 py-2 text-left font-semibold">Top Commit</th>
                <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Class Score</th>
              </tr>
            </thead>
            <tbody>
              {classes.map((cls, i) => {
                const isOpen = expanded === cls.team_id
                const isTop3 = (cls.class_rank ?? i + 1) <= 3
                const pct = topScore > 0 ? Math.max(4, (cls.class_score / topScore) * 100) : 0
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
                          {cls.class_rank ?? i + 1}
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

                      {/* Commits */}
                      <td className="px-3 py-2.5 text-center text-xs font-semibold text-gray-700 dark:text-gray-300 tabular-nums">
                        {cls.commits}
                      </td>

                      {/* Ranked */}
                      <td className="px-3 py-2.5 text-center text-xs text-gray-600 dark:text-gray-400 tabular-nums">
                        {cls.ranked}
                      </td>

                      {/* Top commit */}
                      <td className="px-3 py-2.5">
                        {cls.top_commit ? (
                          <span className="flex items-center gap-1.5">
                            <span className="text-xs font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">
                              {cls.top_commit.name}
                            </span>
                            {cls.top_commit.position && (
                              <span className="text-[10px] text-gray-400 dark:text-gray-500">{cls.top_commit.position}</span>
                            )}
                            {cls.top_commit.rank != null && (
                              <span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded bg-teal-50 text-nw-teal dark:bg-teal-900/30 dark:text-teal-300 whitespace-nowrap">
                                #{cls.top_commit.rank}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-300 dark:text-gray-600">-</span>
                        )}
                      </td>

                      {/* Class score + bar */}
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2 min-w-[120px]">
                          <span className="text-sm font-black tabular-nums text-nw-teal dark:text-nw-teal-light w-10 text-right">
                            {Math.round(cls.class_score)}
                          </span>
                          <div className="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${isTop3 ? 'bg-amber-400' : 'bg-nw-teal'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
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
          <p><strong>Class Score</strong> sums the value of every commit, graded from the better of their PBR or BBNW state ranking. Unranked commits add a small baseline.</p>
          <p><strong>Ranked</strong> counts commits with a PBR or BBNW state ranking. The bar shows each class score relative to the No. 1 class.</p>
          <p className="italic">2026 commitments trickle in through the cycle, so classes will keep filling out.</p>
        </div>
      )}
    </div>
  )
}
