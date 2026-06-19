import { useState, useMemo, Fragment } from 'react'
import { useRecruitingClasses, useRecruitingClassDetail, useRecruitingTransfers } from '../hooks/useApi'
import { divisionBadgeClass } from '../utils/stats'

// Grad years that have been scraped. Future years come online as they're
// scraped, so adding one here is all it takes to extend the selector.
const GRAD_YEARS = [2026]

// Combined Class Rating = HS class rating + this much per point of a program's
// transfer rating (its AVERAGE WAR per transfer, drop-down-adjusted, floored at
// 0). The HS rankings stay the backbone — at this weight an elite transfer
// class adds a handful of points without overturning the top tier.
const COMBINED_TRANSFER_WEIGHT = 3.0

// The three pages, selected by the buttons at the top.
const VIEWS = [
  { key: 'hs', label: 'High School',
    blurb: 'High school commits to PNW college programs, graded by their State Rank. Each school\'s Class Rating is the average prospect rating of its ranked commits (0 to 100), weighted by state. Depth and unrated commits do not inflate it.' },
  { key: 'transfers', label: 'Transfers',
    blurb: 'Incoming transfers (JUCO and four-year portal) committed to each PNW program, rated by their season WAR. A program\'s Transfer WAR is the sum of its transfers\' WAR; a D1 player dropping to a lower level counts double.' },
  { key: 'combined', label: 'Combined',
    blurb: 'The full incoming class for each program: high school newcomers plus transfers. Combined Class Rating is the HS rating plus a weighted transfer-WAR bonus, so strong HS classes stay on top while transfers nudge the order.' },
]

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

// JUCO vs four-year-portal source tag on a transfer row.
function SourceBadge({ source }) {
  const isPortal = source === 'portal'
  return (
    <span className={`inline-flex items-center text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide whitespace-nowrap ${
      isPortal
        ? 'bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-300'
        : 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300'
    }`}>
      {isPortal ? 'Portal' : 'JUCO'}
    </span>
  )
}

// HS commit list for one school, fetched lazily. Inner content only (no <tr>),
// so it can be dropped into the High School view OR stacked with transfers in
// the Combined view.
function ClassCommitsPanel({ teamId, gradYear }) {
  const { data, loading, error } = useRecruitingClassDetail(teamId, gradYear)

  if (loading) return <div className="text-center py-4 text-xs text-gray-400 dark:text-gray-500">Loading commits...</div>
  if (error) return <div className="text-center py-4 text-xs text-red-400">Couldn't load this class.</div>
  if (!data) return null

  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
        {data.team?.name} HS commits ({data.commit_count}
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
                  <span className="text-xs font-semibold text-gray-800 dark:text-gray-200 whitespace-nowrap">{c.name}</span>
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
                  {c.height || c.weight ? `${c.height || '-'}${c.weight ? ` / ${c.weight}` : ''}` : '-'}
                </td>
                <td className="px-3 py-1.5"><RankChips stateRank={c.state_rank} /></td>
                <td className="px-3 py-1.5 text-center text-xs tabular-nums">
                  {c.recruit_score != null ? (
                    <span className="font-bold text-nw-teal dark:text-nw-teal-light">{Math.round(c.recruit_score)}</span>
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
  )
}

// Incoming-transfer list for one school. Data is embedded in the transfers
// board response, so this renders without a fetch. Shows each transfer's season
// WAR (the rating basis) and a "2×" tag when a D1 player dropped down a level.
function TransferList({ transfers }) {
  if (!transfers || transfers.length === 0) {
    return <div className="text-center py-3 text-xs text-gray-400 dark:text-gray-500 italic">No transfers yet.</div>
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700 text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">
            <th className="px-3 py-1.5 text-left font-semibold">Transfer</th>
            <th className="px-3 py-1.5 text-center font-semibold">Pos</th>
            <th className="px-3 py-1.5 text-left font-semibold">From</th>
            <th className="px-3 py-1.5 text-left font-semibold">Transfer Rank</th>
            <th className="px-3 py-1.5 text-center font-semibold">WAR</th>
          </tr>
        </thead>
        <tbody>
          {transfers.map((t, i) => (
            <tr
              key={t.player_id ?? i}
              className={`border-b border-gray-100 dark:border-gray-700 last:border-0 ${i % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/50 dark:bg-gray-900/20'}`}
            >
              <td className="px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-gray-800 dark:text-gray-200 whitespace-nowrap">{t.name}</span>
                  <SourceBadge source={t.source} />
                </div>
              </td>
              <td className="px-3 py-1.5 text-center text-xs font-semibold text-gray-600 dark:text-gray-400">{t.position || '-'}</td>
              <td className="px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{t.previous_school || '-'}</td>
              <td className="px-3 py-1.5">
                {t.pool_rank != null ? (
                  <span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded bg-teal-50 text-nw-teal dark:bg-teal-900/30 dark:text-teal-300 whitespace-nowrap">
                    {t.source === 'juco' ? 'NWAC ' : ''}{t.player_type === 'pitcher' ? 'Pitcher' : 'Hitter'} #{t.pool_rank}
                  </span>
                ) : (
                  <span className="text-[10px] font-medium text-gray-400 dark:text-gray-500 italic">Unranked</span>
                )}
              </td>
              <td className="px-3 py-1.5 text-center text-xs tabular-nums whitespace-nowrap">
                {t.war != null ? (
                  <>
                    <span className="font-bold text-nw-teal dark:text-nw-teal-light">{t.war.toFixed(1)}</span>
                    {t.boosted && (
                      <span className="ml-1 inline-flex items-center text-[9px] font-bold px-1 py-0.5 rounded bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-300" title="D1 player dropping a level: WAR doubled in the rating">
                        2×
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-gray-400 dark:text-gray-500" title="Out-of-region transfer: no WAR in our data, not counted in the rating">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// A single program logo + name + division badge cell.
function ProgramCell({ row, isOpen }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-gray-300 dark:text-gray-600 text-xs transition-transform ${isOpen ? 'rotate-90' : ''}`}>&rsaquo;</span>
      {row.logo_url ? (
        <img src={row.logo_url} alt="" className="w-6 h-6 object-contain shrink-0" loading="lazy" onError={(e) => { e.target.style.display = 'none' }} />
      ) : (
        <div className="w-6 h-6 shrink-0" />
      )}
      <span className="text-xs font-semibold text-gray-800 dark:text-gray-200 whitespace-nowrap">{row.name}</span>
      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${divisionBadgeClass(row.division)}`}>{row.division}</span>
    </div>
  )
}

const rowBg = (i, isOpen) =>
  isOpen
    ? 'bg-teal-50/60 dark:bg-teal-900/20'
    : `hover:bg-blue-50/40 dark:hover:bg-gray-700/40 ${i % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/50 dark:bg-gray-900/20'}`

// ── High School board (the original leaderboard) ──
function HSBoard({ classes, gradYear, expanded, toggle }) {
  const topScore = classes.reduce((m, c) => (c.class_score != null && c.class_score > m ? c.class_score : m), 0)
  return (
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
            const hasRank = cls.class_rank != null
            const hasScore = cls.class_score != null
            const isTop3 = hasRank && cls.class_rank <= 3
            const pct = hasScore && topScore > 0 ? Math.max(4, (cls.class_score / topScore) * 100) : 0
            return (
              <Fragment key={cls.team_id}>
                <tr onClick={() => toggle(cls.team_id)} className={`border-b border-gray-100 dark:border-gray-700 cursor-pointer transition-colors ${rowBg(i, isOpen)}`}>
                  <td className="px-3 py-2.5 text-center">
                    <span className={`inline-flex items-center justify-center text-sm font-black tabular-nums ${isTop3 ? 'text-amber-500' : 'text-gray-400 dark:text-gray-500'}`}>
                      {hasRank ? cls.class_rank : '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5"><ProgramCell row={cls} isOpen={isOpen} /></td>
                  <td className="px-3 py-2.5 text-center text-xs text-gray-700 dark:text-gray-300 tabular-nums whitespace-nowrap">
                    <span className="font-semibold">{cls.scored_commits ?? cls.ranked ?? 0} rated</span>
                    <span className="text-gray-400 dark:text-gray-500"> · {cls.commits} total</span>
                  </td>
                  <td className="px-3 py-2.5">
                    {hasScore ? (
                      <div className="flex items-center gap-2 min-w-[120px]">
                        <span className="text-sm font-black tabular-nums text-nw-teal dark:text-nw-teal-light w-10 text-right">{cls.class_score.toFixed(1)}</span>
                        <div className="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                          <div className={`h-full rounded-full ${isTop3 ? 'bg-amber-400' : 'bg-nw-teal'}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    ) : (
                      <span className="text-[11px] italic text-gray-400 dark:text-gray-500">Not enough ranked commits to rate</span>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="bg-nw-cream/40 dark:bg-gray-900/40">
                    <td colSpan={4} className="px-3 sm:px-4 py-3"><ClassCommitsPanel teamId={cls.team_id} gradYear={gradYear} /></td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Transfers board (ranked by total transfer WAR; JUCO + portal per program) ──
function TransfersBoard({ teams, expanded, toggle }) {
  const topRating = teams.reduce((m, t) => (t.transfer_rating > m ? t.transfer_rating : m), 0)
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700 text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">
            <th className="px-3 py-2 text-center font-semibold w-10">#</th>
            <th className="px-3 py-2 text-left font-semibold">Program</th>
            <th className="px-3 py-2 text-center font-semibold whitespace-nowrap">Transfers</th>
            <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Avg WAR</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((t, i) => {
            const isOpen = expanded === t.team_id
            const portal = t.transfers.filter((x) => x.source === 'portal').length
            const juco = t.transfer_count - portal
            const isTop3 = i < 3
            const pct = topRating > 0 ? Math.max(4, (t.transfer_rating / topRating) * 100) : 0
            return (
              <Fragment key={t.team_id}>
                <tr onClick={() => toggle(t.team_id)} className={`border-b border-gray-100 dark:border-gray-700 cursor-pointer transition-colors ${rowBg(i, isOpen)}`}>
                  <td className="px-3 py-2.5 text-center">
                    <span className={`inline-flex items-center justify-center text-sm font-black tabular-nums ${isTop3 ? 'text-amber-500' : 'text-gray-400 dark:text-gray-500'}`}>{i + 1}</span>
                  </td>
                  <td className="px-3 py-2.5"><ProgramCell row={t} isOpen={isOpen} /></td>
                  <td className="px-3 py-2.5 text-center text-xs text-gray-700 dark:text-gray-300 tabular-nums whitespace-nowrap">
                    <span className="font-semibold">{t.transfer_count}</span>
                    <span className="text-gray-400 dark:text-gray-500"> · {juco} JUCO{portal ? ` · ${portal} portal` : ''}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2 min-w-[120px]">
                      <span className="text-sm font-black tabular-nums text-nw-teal dark:text-nw-teal-light w-12 text-right" title={`${t.transfer_total} total WAR over ${t.transfer_count} transfer${t.transfer_count === 1 ? '' : 's'}`}>{t.transfer_rating.toFixed(2)}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                        <div className={`h-full rounded-full ${isTop3 ? 'bg-amber-400' : 'bg-nw-teal'}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="bg-nw-cream/40 dark:bg-gray-900/40">
                    <td colSpan={4} className="px-3 sm:px-4 py-3"><TransferList transfers={t.transfers} /></td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Combined board (HS rating + transfer WAR bonus; expand shows both) ──
function CombinedBoard({ rows, gradYear, expanded, toggle }) {
  const topScore = rows.reduce((m, r) => (r.combined_score > m ? r.combined_score : m), 0)
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700 text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">
            <th className="px-3 py-2 text-center font-semibold w-10">#</th>
            <th className="px-3 py-2 text-left font-semibold">Program</th>
            <th className="px-3 py-2 text-center font-semibold whitespace-nowrap">HS</th>
            <th className="px-3 py-2 text-center font-semibold whitespace-nowrap">Transfers</th>
            <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Class Rating</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isOpen = expanded === row.team_id
            const hasScore = row.combined_score > 0
            const isTop3 = i < 3
            const pct = topScore > 0 ? Math.max(4, (row.combined_score / topScore) * 100) : 0
            return (
              <Fragment key={row.team_id}>
                <tr onClick={() => toggle(row.team_id)} className={`border-b border-gray-100 dark:border-gray-700 cursor-pointer transition-colors ${rowBg(i, isOpen)}`}>
                  <td className="px-3 py-2.5 text-center">
                    <span className={`inline-flex items-center justify-center text-sm font-black tabular-nums ${isTop3 ? 'text-amber-500' : 'text-gray-400 dark:text-gray-500'}`}>{i + 1}</span>
                  </td>
                  <td className="px-3 py-2.5"><ProgramCell row={row} isOpen={isOpen} /></td>
                  <td className="px-3 py-2.5 text-center text-xs text-gray-700 dark:text-gray-300 tabular-nums">{row.hs_commits || '—'}</td>
                  <td className="px-3 py-2.5 text-center text-xs text-gray-700 dark:text-gray-300 tabular-nums whitespace-nowrap">
                    {row.transfer_count ? (
                      <>
                        <span className="font-semibold">{row.transfer_count}</span>
                        <span className="text-gray-400 dark:text-gray-500"> · {row.transfer_rating.toFixed(2)} avg WAR</span>
                      </>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2.5">
                    {hasScore ? (
                      <div className="flex items-center gap-2 min-w-[120px]">
                        <span className="text-sm font-black tabular-nums text-nw-teal dark:text-nw-teal-light w-10 text-right">{row.combined_score.toFixed(1)}</span>
                        <div className="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                          <div className={`h-full rounded-full ${isTop3 ? 'bg-amber-400' : 'bg-nw-teal'}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    ) : (
                      <span className="text-[11px] italic text-gray-400 dark:text-gray-500">Not rated</span>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="bg-nw-cream/40 dark:bg-gray-900/40">
                    <td colSpan={5} className="px-3 sm:px-4 py-3 space-y-3">
                      {row.hs_commits > 0 && <ClassCommitsPanel teamId={row.team_id} gradYear={gradYear} />}
                      {row.transfer_count > 0 && (
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                            Transfers ({row.transfer_count} · {row.transfer_rating.toFixed(2)} avg WAR)
                          </div>
                          <TransferList transfers={row.transfers} />
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function RecruitingClasses() {
  const [gradYear, setGradYear] = useState(2026)
  const [view, setView] = useState('hs')
  const [expanded, setExpanded] = useState(null)
  const [levelFilter, setLevelFilter] = useState('all')
  const [confFilter, setConfFilter] = useState('all')

  const { data: hsData, loading: hsLoading, error: hsError } = useRecruitingClasses(gradYear)
  const { data: trData, loading: trLoading, error: trError } = useRecruitingTransfers(gradYear)

  const classes = hsData?.classes || []
  const transferTeams = trData?.teams || []

  // Combined = union of programs from both sources, keyed by team_id. The
  // Combined Class Rating is the HS class rating plus a weighted transfer-WAR
  // bonus, so the HS rankings stay the backbone and transfers nudge the order.
  const combinedRows = useMemo(() => {
    const m = new Map()
    for (const c of hsData?.classes || []) {
      m.set(c.team_id, {
        team_id: c.team_id, name: c.name, logo_url: c.logo_url, division: c.division,
        conference: c.conference,
        class_score: c.class_score, hs_commits: c.commits,
        transfer_count: 0, transfer_rating: 0, transfers: [],
      })
    }
    for (const t of trData?.teams || []) {
      const ex = m.get(t.team_id)
      if (ex) { ex.transfer_count = t.transfer_count; ex.transfer_rating = t.transfer_rating; ex.transfers = t.transfers }
      else m.set(t.team_id, {
        team_id: t.team_id, name: t.name, logo_url: t.logo_url, division: t.division,
        conference: t.conference,
        class_score: null, hs_commits: 0,
        transfer_count: t.transfer_count, transfer_rating: t.transfer_rating, transfers: t.transfers,
      })
    }
    const rows = [...m.values()]
    for (const r of rows) {
      r.combined_score = (r.class_score ?? 0) + COMBINED_TRANSFER_WEIGHT * (r.transfer_rating || 0)
    }
    return rows.sort((a, b) => b.combined_score - a.combined_score || a.name.localeCompare(b.name))
  }, [hsData, trData])

  // Level + conference filter options, derived from the union of all programs.
  const LEVEL_ORDER = ['D1', 'D2', 'D3', 'NAIA', 'JUCO']
  const levelOptions = useMemo(() => {
    const s = new Set(combinedRows.map((r) => r.division).filter(Boolean))
    return LEVEL_ORDER.filter((l) => s.has(l))
  }, [combinedRows])
  const confOptions = useMemo(() => {
    const s = new Set(combinedRows
      .filter((r) => levelFilter === 'all' || r.division === levelFilter)
      .map((r) => r.conference).filter(Boolean))
    return [...s].sort()
  }, [combinedRows, levelFilter])

  const matchRow = (r) =>
    (levelFilter === 'all' || r.division === levelFilter) &&
    (confFilter === 'all' || r.conference === confFilter)
  const classesF = useMemo(() => classes.filter(matchRow), [classes, levelFilter, confFilter])
  const transferTeamsF = useMemo(() => transferTeams.filter(matchRow), [transferTeams, levelFilter, confFilter])
  const combinedRowsF = useMemo(() => combinedRows.filter(matchRow), [combinedRows, levelFilter, confFilter])

  const switchView = (v) => { setView(v); setExpanded(null) }
  const toggle = (teamId) => setExpanded((cur) => (cur === teamId ? null : teamId))

  const loading = view === 'transfers' ? trLoading : view === 'combined' ? (hsLoading || trLoading) : hsLoading
  const error = view === 'transfers' ? trError : view === 'combined' ? (hsError || trError) : hsError
  const isEmpty =
    view === 'hs' ? classesF.length === 0
      : view === 'transfers' ? transferTeamsF.length === 0
        : combinedRowsF.length === 0
  const filtersActive = levelFilter !== 'all' || confFilter !== 'all'

  const activeBlurb = VIEWS.find((v) => v.key === view)?.blurb

  return (
    <div>
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">{gradYear} Recruiting Classes</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 max-w-3xl">{activeBlurb}</p>

      {/* View toggle + grad-year selector */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => switchView(v.key)}
              className={`px-3 py-1.5 text-xs font-bold rounded-md transition-colors ${
                view === v.key
                  ? 'bg-nw-teal text-white shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-nw-teal dark:hover:text-nw-teal-light'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="gradYear" className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Class</label>
          <select
            id="gradYear"
            value={gradYear}
            onChange={(e) => { setGradYear(Number(e.target.value)); setExpanded(null) }}
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-medium text-gray-700 dark:text-gray-200 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-nw-teal"
          >
            {GRAD_YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="levelFilter" className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Level</label>
          <select
            id="levelFilter"
            value={levelFilter}
            onChange={(e) => { setLevelFilter(e.target.value); setConfFilter('all'); setExpanded(null) }}
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-medium text-gray-700 dark:text-gray-200 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-nw-teal"
          >
            <option value="all">All levels</option>
            {levelOptions.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        {confOptions.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor="confFilter" className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Conference</label>
            <select
              id="confFilter"
              value={confFilter}
              onChange={(e) => { setConfFilter(e.target.value); setExpanded(null) }}
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-medium text-gray-700 dark:text-gray-200 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-nw-teal max-w-[200px]"
            >
              <option value="all">All conferences</option>
              {confOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        )}
      </div>

      {loading && <div className="text-center py-12 text-gray-400 dark:text-gray-500">Loading recruiting classes...</div>}
      {error && <div className="text-center py-12 text-red-400">Error: {error}</div>}

      {!loading && !error && isEmpty && (
        <div className="text-center py-12 text-gray-400 dark:text-gray-500">
          {filtersActive ? 'No programs match these filters.'
            : view === 'transfers' ? 'No transfer commitments tracked yet.' : `No commits found for ${gradYear}.`}
        </div>
      )}

      {!loading && !error && !isEmpty && view === 'hs' && (
        <HSBoard classes={classesF} gradYear={gradYear} expanded={expanded} toggle={toggle} />
      )}
      {!loading && !error && !isEmpty && view === 'transfers' && (
        <TransfersBoard teams={transferTeamsF} expanded={expanded} toggle={toggle} />
      )}
      {!loading && !error && !isEmpty && view === 'combined' && (
        <CombinedBoard rows={combinedRowsF} gradYear={gradYear} expanded={expanded} toggle={toggle} />
      )}

      {/* Legend */}
      {!loading && !error && !isEmpty && (
        <div className="mt-4 px-1 text-[10px] text-gray-400 dark:text-gray-500 space-y-1 max-w-3xl">
          {view === 'hs' && (
            <>
              <p><strong>Class Rating</strong> is the average prospect rating (0 to 100) of each class's ranked commits, weighted by state. Depth and unrated commits do not inflate it. The bar shows each rating relative to the top class.</p>
              <p><strong>Commits</strong> shows rated (from states we rank) of total. Classes with fewer than 3 rated commits are not ranked and sort last.</p>
            </>
          )}
          {view === 'transfers' && (
            <>
              <p><strong>Avg WAR</strong> rates each program's transfer class by the <em>average</em> season WAR (offense + pitching) of its transfers, not the total, so depth never inflates a class: 7 transfers worth 7 WAR rate at 1.00, the same as one transfer worth 1 WAR. A below-replacement transfer counts as 0, never a negative.</p>
              <p><strong>Transfer Rank</strong> is each player's standing among <em>every</em> player in his pool, not just the transfers — a JUCO commit is ranked against all NWAC players, with hitting and pitching ranked separately (so there's a #1 hitter and a #1 pitcher). A <strong>D1 player dropping</strong> to a D2, D3, or NAIA program has his WAR doubled (a "2×" tag), reflecting his outsized impact at the new level.</p>
              <p className="italic">WAR is only available for players in our database (NWAC JUCO + the four-year programs we track). An incoming transfer from outside the region is still listed, but with no WAR ("—") and left out of the WAR average, so it never penalizes a class.</p>
            </>
          )}
          {view === 'combined' && (
            <>
              <p><strong>Combined Class Rating</strong> = HS Class Rating + {COMBINED_TRANSFER_WEIGHT}× the program's average transfer WAR. The HS rankings are the backbone, so a strong transfer class nudges a program up a few spots without overturning the solid HS order.</p>
              <p className="italic">WAR is only available for transfers from PNW programs (NWAC JUCO + tracked four-year players); out-of-region transfers are shown but unrated and left out of the average.</p>
            </>
          )}
          <p className="italic">2026 commitments trickle in through the cycle, so classes will keep filling out.</p>
        </div>
      )}
    </div>
  )
}
