// NWAC Advancement — where NWAC (JUCO) players move on to, built from our
// cross-team player links. Shows 2026 D1 arrivals, a per-team leaderboard of who
// sends the most / best, each team's destination breakdown + committed players,
// and the top landing spots league-wide. Premium page in the Recruiting dropdown.
// Scope note: only transfers to PNW programs we track are visible (Bellevue ->
// Bushnell shows; Bellevue -> UCLA does not). Brand rule: no em-dashes.
import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const LEVELS = {
  D1: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  D2: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  NAIA: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  D3: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
}
const LEVEL_LABEL = { D1: 'Division I', D2: 'Division II', NAIA: 'NAIA', D3: 'Division III' }
const LevelTag = ({ level }) => (
  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${LEVELS[level] || 'bg-gray-100 text-gray-600'}`}>{level}</span>
)
const Logo = ({ src, size = 20 }) =>
  src ? <img src={src} alt="" style={{ width: size, height: size }} className="inline-block object-contain align-middle" />
      : <span style={{ width: size, height: size }} className="inline-block rounded bg-gray-200 dark:bg-gray-700 align-middle" />

const SORTS = [
  { key: 'total', label: 'Total advanced' },
  { key: 'd1', label: 'To D1' },
  { key: 'distinct_dests', label: 'Distinct schools' },
  { key: 'committed_count', label: 'Committed' },
]

export default function NwacAdvancement() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [sortKey, setSortKey] = useState('total')
  const [open, setOpen] = useState(null)

  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        const { data: sess } = await supabase.auth.getSession()
        const token = sess?.session?.access_token
        const r = await fetch('/api/v1/recruiting/nwac-advancement?season=2026', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'premium' : `HTTP ${r.status}`)
        const j = await r.json()
        if (!cancel) setData(j)
      } catch (e) { if (!cancel) setErr(e.message || 'load') }
    })()
    return () => { cancel = true }
  }, [])

  const teams = (data?.teams || []).slice().sort((a, b) => (b[sortKey] - a[sortKey]) || (b.total - a.total))
  const t = data?.totals

  if (err === 'premium') return (
    <div className="max-w-3xl mx-auto px-4 py-16 text-center text-gray-600 dark:text-gray-300">
      NWAC Advancement is a premium feature. <a href="/pricing" className="text-nw-teal font-semibold hover:underline">View plans</a>
    </div>
  )

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-6">
      {/* Hero */}
      <section className="text-center rounded-3xl bg-gradient-to-b from-teal-50 to-white dark:from-teal-900/20 dark:to-gray-900 ring-1 ring-gray-200 dark:ring-gray-700 px-5 py-8 sm:py-10 mb-6">
        <div className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-nw-teal bg-white dark:bg-gray-900 px-3 py-1 rounded-full mb-2 ring-1 ring-teal-100 dark:ring-teal-800">
          Recruiting · NWAC
        </div>
        <h1 className="text-3xl sm:text-4xl font-black text-pnw-slate dark:text-gray-100 leading-tight">NWAC Advancement</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300 max-w-2xl mx-auto leading-relaxed">
          Which NWAC programs move players up, and where those players land. Built from our transfer history across PNW college baseball, so it captures moves to the four-year programs we track.
        </p>
        {data && (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-y-4 divide-x divide-gray-200 dark:divide-gray-700">
            {[[data.commit_counts.total, '2026 commitments'], [data.commit_counts.D1, 'to Division I'], [t.advanced, 'advanced all-time']].map(([n, l]) => (
              <div key={l} className="text-center px-4">
                <div className="text-2xl sm:text-3xl font-black text-nw-teal">{n}</div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 mt-0.5">{l}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      {err && err !== 'premium' && <div className="text-sm text-rose-600 dark:text-rose-400 mb-4">Couldn't load advancement data.</div>}
      {!data && !err && <div className="text-sm text-gray-400 py-10 text-center">Loading…</div>}

      {data && (
        <>
          {/* Scope disclaimer — this data is PNW-only and tracking has a start year */}
          <div className="rounded-xl bg-amber-50/70 dark:bg-amber-900/15 ring-1 ring-amber-200/70 dark:ring-amber-800/40 px-4 py-3 mb-6 text-[12.5px] leading-relaxed text-amber-900 dark:text-amber-200/90">
            <span className="font-bold">How to read this:</span> "Advanced" and the landing-spot counts only include players who moved on to a <span className="font-semibold">Pacific Northwest four-year program we track</span> (Division I through NAIA in WA, OR, ID, MT, plus UBC), using data since <span className="font-semibold">{data.tracking_since}</span>. A player who transferred to a school outside the region (a California D1, say) will not appear here. Commitment data reflects publicly known commitments, so the 2026 percentages below are a floor, not the full picture.
          </div>

          {/* 2026 commitments, grouped by the level committed to */}
          <section className="rounded-2xl bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 p-5 sm:p-6 mb-6">
            <div className="text-[10px] font-bold uppercase tracking-widest text-nw-teal mb-1">Headliner · the 2026 class</div>
            <h2 className="text-lg sm:text-xl font-black text-pnw-slate dark:text-gray-100 mb-1">Where this year's NWAC players committed</h2>
            <p className="text-[13px] text-gray-500 dark:text-gray-400 mb-4">Every NWAC player with a commitment on file, grouped by the level of the school they chose. Division I first.</p>
            {data.commits.length === 0 ? (
              <div className="text-sm text-gray-400">No commitments on record yet.</div>
            ) : ['D1', 'D2', 'NAIA', 'D3', null].map(lv => {
              const list = data.commits.filter(c => (lv ? c.dest_level === lv : !c.dest_level))
              if (!list.length) return null
              return (
                <div key={lv || 'other'} className="mb-4 last:mb-0">
                  <div className="flex items-center gap-2 mb-2">
                    {lv
                      ? <LevelTag level={lv} />
                      : <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300">4-YR</span>}
                    <span className="text-[12px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">{(lv ? LEVEL_LABEL[lv] : 'Other four-year') + ' · ' + list.length}</span>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
                    {list.map((c, i) => (
                      <div key={i} className="flex items-center gap-2 text-[13px] py-0.5">
                        <span className="font-bold text-pnw-slate dark:text-gray-100 truncate">{c.player}</span>
                        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-gray-500 dark:text-gray-400 shrink-0">
                          <Logo src={c.nwac_logo} size={15} /> {c.nwac_team}
                          <span className="text-nw-teal">&rarr;</span>
                          {c.dest_logo && <Logo src={c.dest_logo} size={15} />}
                          <span className={`font-semibold ${lv === 'D1' ? 'text-sky-700 dark:text-sky-300' : 'text-gray-700 dark:text-gray-200'}`}>{c.dest}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </section>

          {/* 2026 sophomore movement — % of each team's sophomores with a known commitment */}
          {(() => {
            const SO = new Set(['So', 'R-So'])
            const rows = data.teams
              .filter(t => t.soph_count > 0)
              .map(t => {
                const committed = (t.committed || []).filter(c => SO.has(c.year))
                const schools = {}
                committed.forEach(c => {
                  const k = c.dest
                  if (!schools[k]) schools[k] = { dest: c.dest, level: c.dest_level || c.level, count: 0 }
                  schools[k].count += 1
                })
                return {
                  team: t.team, logo: t.logo, soph: t.soph_count, committed: committed.length,
                  pct: Math.round((committed.length / t.soph_count) * 100),
                  schools: Object.values(schools).sort((a, b) => b.count - a.count),
                }
              })
              .sort((a, b) => b.pct - a.pct || b.committed - a.committed || b.soph - a.soph)
            return (
              <section className="rounded-2xl bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 p-5 sm:p-6 mb-6">
                <div className="text-[10px] font-bold uppercase tracking-widest text-nw-teal mb-1">The 2026 class</div>
                <h2 className="text-lg sm:text-xl font-black text-pnw-slate dark:text-gray-100 mb-1">How much of each team's sophomore class is moving on</h2>
                <p className="text-[13px] text-gray-500 dark:text-gray-400">Sophomores are NWAC players in their final junior-college year. "Moving on" counts those with a known commitment to a four-year school, and lists where. Because commitments are only as complete as what programs publish, these percentages are a floor, not the full picture.</p>
                <div className="overflow-x-auto -mx-1 mt-3">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="text-gray-400 dark:text-gray-500 text-[11px] uppercase tracking-wide border-b border-gray-200 dark:border-gray-700">
                        <th className="text-left py-2 pl-1 font-semibold">NWAC Team</th>
                        <th className="text-right px-2 tabular-nums" title="2026 sophomores on the roster">Soph</th>
                        <th className="text-right px-2 tabular-nums">Moving on</th>
                        <th className="text-right px-2 tabular-nums">%</th>
                        <th className="text-left px-2">Committed to</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.team} className="border-b border-gray-100 dark:border-gray-700/50 align-top">
                          <td className="py-2 pl-1">
                            <span className="inline-flex items-center gap-2"><Logo src={r.logo} size={18} /><span className="font-bold text-pnw-slate dark:text-gray-100">{r.team}</span></span>
                          </td>
                          <td className="text-right px-2 tabular-nums text-gray-600 dark:text-gray-300">{r.soph}</td>
                          <td className="text-right px-2 tabular-nums font-semibold text-pnw-slate dark:text-gray-100">{r.committed || ''}</td>
                          <td className="text-right px-2 tabular-nums font-extrabold text-nw-teal">{r.committed ? r.pct + '%' : ''}</td>
                          <td className="px-2 py-1.5">
                            {r.schools.length ? (
                              <span className="flex flex-wrap gap-1">
                                {r.schools.map(s => (
                                  <span key={s.dest} className="inline-flex items-center gap-1 text-[11.5px] bg-gray-50 dark:bg-gray-900/40 ring-1 ring-gray-200 dark:ring-gray-700 rounded-full px-2 py-0.5">
                                    {s.level && <LevelTag level={s.level} />}
                                    <span className="text-gray-700 dark:text-gray-200">{s.dest}{s.count > 1 ? ` x${s.count}` : ''}</span>
                                  </span>
                                ))}
                              </span>
                            ) : <span className="text-gray-400 dark:text-gray-500">none recorded yet</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )
          })()}

          {/* Team leaderboard */}
          <section className="rounded-2xl bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 p-5 sm:p-6 mb-6">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
              <h2 className="text-lg sm:text-xl font-black text-pnw-slate dark:text-gray-100">Who sends the most to PNW four-year schools</h2>
              <div className="flex flex-wrap gap-1">
                {SORTS.map(s => (
                  <button key={s.key} onClick={() => setSortKey(s.key)}
                    className={`text-[11px] font-bold px-2.5 py-1 rounded-full transition-colors ${sortKey === s.key ? 'bg-nw-teal text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[13px] text-gray-500 dark:text-gray-400 mb-3">Every player who advanced to a four-year program in our PNW database, {data.tracking_since} to present (out-of-region transfers not included). Tap a team to see exactly where their players went.</p>
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-[13px] tabular-nums">
                <thead>
                  <tr className="text-gray-400 dark:text-gray-500 text-[11px] uppercase tracking-wide border-b border-gray-200 dark:border-gray-700">
                    <th className="text-left py-2 pl-1 font-semibold">NWAC Team</th>
                    <th className="text-right px-2" title="Players who advanced to a 4-year PNW program">Advanced</th>
                    <th className="text-right px-2">D1</th>
                    <th className="text-right px-2">D2</th>
                    <th className="text-right px-2">NAIA</th>
                    <th className="text-right px-2">D3</th>
                    <th className="text-right px-2" title="Distinct destination schools">Schools</th>
                    <th className="text-right px-2 pr-1" title="Players with a committed school on file">Committed</th>
                  </tr>
                </thead>
                <tbody>
                  {teams.map((tm, i) => (
                    <>
                      <tr key={tm.team}
                        onClick={() => setOpen(open === tm.team ? null : tm.team)}
                        className={`border-b border-gray-100 dark:border-gray-700/50 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900/40 ${i === 0 ? 'bg-teal-50/40 dark:bg-teal-900/10' : ''}`}>
                        <td className="py-2 pl-1">
                          <span className="inline-flex items-center gap-2">
                            <Logo src={tm.logo} size={20} />
                            <span className="font-bold text-pnw-slate dark:text-gray-100">{tm.team}</span>
                            {i === 0 && <span className="text-[9px] font-bold uppercase text-nw-teal bg-teal-100 dark:bg-teal-900/40 px-1.5 py-0.5 rounded">Leader</span>}
                          </span>
                        </td>
                        <td className="text-right px-2 font-extrabold text-pnw-slate dark:text-gray-100">{tm.total}</td>
                        <td className="text-right px-2 font-semibold text-sky-700 dark:text-sky-300">{tm.d1 || ''}</td>
                        <td className="text-right px-2">{tm.d2 || ''}</td>
                        <td className="text-right px-2">{tm.naia || ''}</td>
                        <td className="text-right px-2">{tm.d3 || ''}</td>
                        <td className="text-right px-2">{tm.distinct_dests || ''}</td>
                        <td className="text-right px-2 pr-1">{tm.committed_count || ''}</td>
                      </tr>
                      {open === tm.team && (
                        <tr key={tm.team + '-d'} className="border-b border-gray-100 dark:border-gray-700/50 bg-gray-50/60 dark:bg-gray-900/30">
                          <td colSpan={8} className="px-3 py-3">
                            {tm.destinations.length > 0 ? (
                              <>
                                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Where {tm.team} sends players</div>
                                <div className="flex flex-wrap gap-1.5 mb-3">
                                  {tm.destinations.map(d => (
                                    <span key={d.team} className="inline-flex items-center gap-1.5 text-[12px] bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 rounded-full pl-1.5 pr-2 py-0.5">
                                      <Logo src={d.logo} size={16} />
                                      <span className="font-semibold text-gray-700 dark:text-gray-200">{d.team}</span>
                                      <LevelTag level={d.level} />
                                      <span className="text-gray-400">x{d.count}</span>
                                    </span>
                                  ))}
                                </div>
                              </>
                            ) : <div className="text-[12px] text-gray-400 mb-2">No tracked advancements yet.</div>}
                            {tm.committed.length > 0 && (
                              <>
                                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">Committed</div>
                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-gray-600 dark:text-gray-300">
                                  {tm.committed.map((c, j) => (
                                    <span key={j}><span className="font-semibold text-gray-800 dark:text-gray-100">{c.player}</span> &rarr; {c.dest}{c.year ? ` (${c.year})` : ''}</span>
                                  ))}
                                </div>
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Top landing spots */}
          <section className="rounded-2xl bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 p-5 sm:p-6 mb-6">
            <h2 className="text-lg sm:text-xl font-black text-pnw-slate dark:text-gray-100 mb-1">Top landing spots</h2>
            <p className="text-[13px] text-gray-500 dark:text-gray-400 mb-4">The four-year programs that take the most NWAC players (all years on record).</p>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
              {data.top_destinations.map((d, i) => (
                <div key={d.team} className="flex items-center gap-2 py-1">
                  <span className="text-[11px] text-gray-400 w-5 text-right tabular-nums">{i + 1}</span>
                  <Logo src={d.logo} size={20} />
                  <span className="font-semibold text-sm text-gray-800 dark:text-gray-100">{d.team}</span>
                  <LevelTag level={d.level} />
                  <span className="ml-auto font-extrabold text-pnw-slate dark:text-gray-100 tabular-nums">{d.count}</span>
                </div>
              ))}
            </div>
          </section>

          <p className="text-[11px] text-gray-400 dark:text-gray-500">
            Advancements are reconstructed from players who appear at a NWAC school and later at a four-year PNW program in our database, so a player who transferred to a school we do not track (an out-of-region D1, for example) will not appear. Committed-player data reflects what programs publish on their rosters, which is limited. Includes transfers from past seasons, not just 2026.
          </p>
        </>
      )}
    </div>
  )
}
