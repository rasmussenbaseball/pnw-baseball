// WCL Composite Power Index (CPI) table — predictive, SoS-adjusted power rating
// centered at 100. Extracted from the old standalone /summer/cpi page so it can
// live as a section on the combined Standings page. Brand rule: no em-dashes.
import { useState, useEffect } from 'react'
import { CURRENT_SEASON } from '../../lib/seasons'

const API_BASE = '/api/v1'

const cpiColor = (v) =>
  v >= 110 ? 'text-teal-700 dark:text-teal-300'
  : v >= 102 ? 'text-teal-600 dark:text-teal-400'
  : v >= 96 ? 'text-gray-600 dark:text-gray-300'
  : v >= 90 ? 'text-amber-600 dark:text-amber-400'
  : 'text-rose-600 dark:text-rose-400'

const idxColor = (v) =>
  v >= 106 ? 'text-teal-700 dark:text-teal-300 font-semibold'
  : v <= 94 ? 'text-rose-600 dark:text-rose-400 font-semibold'
  : 'text-gray-600 dark:text-gray-300'

const Logo = ({ src, size = 22 }) =>
  src ? <img src={src} alt="" style={{ width: size, height: size }} className="inline-block object-contain align-middle" />
      : <span style={{ width: size, height: size }} className="inline-block rounded bg-gray-200 dark:bg-gray-700 align-middle" />

const COLS = [
  { key: 'cpi', label: 'CPI', title: 'Composite Power Index (100 = league average)' },
  { key: 'proj_winpct', label: 'Proj W%', title: 'Projected win percentage at full strength' },
  { key: 'off_wrc', label: 'Off', title: 'Team offense, regressed wRC+ (100 = average)' },
  { key: 'pit_index', label: 'Pit', title: 'Team pitching index from FIP (100 = average, higher is better)' },
  { key: 'sos_index', label: 'SoS', title: 'Strength of schedule (100 = average)' },
  { key: 'luck', label: 'vs Record', title: 'Actual win% minus projected. Negative = playing better than the record shows.' },
]

export default function PowerIndexTable() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(false)
  const [sortKey, setSortKey] = useState('cpi')

  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        const r = await fetch(`${API_BASE}/summer/cpi?league=WCL&season=${CURRENT_SEASON}`)
        if (!r.ok) throw new Error()
        const j = await r.json()
        if (!cancel) setData(j)
      } catch { if (!cancel) setErr(true) }
    })()
    return () => { cancel = true }
  }, [])

  const teams = (data?.teams || []).slice().sort((a, b) => (b[sortKey] ?? -1) - (a[sortKey] ?? -1))

  return (
    <div>
      <p className="text-[13px] text-gray-600 dark:text-gray-400 leading-relaxed mb-3 max-w-3xl">
        A predictive power rating that blends each team's underlying performance (wRC+ for offense, FIP for pitching)
        with their schedule-adjusted results to estimate true strength, not just the record. 100 is league average;
        higher is better. The <span className="font-semibold">vs Record</span> column flags who is over or under their
        true level.
      </p>

      {err && <div className="text-sm text-rose-600 dark:text-rose-400 mb-4">Rankings are unavailable right now.</div>}
      {!data && !err && <div className="text-sm text-gray-400 py-10 text-center">Computing ratings…</div>}

      {data && (
        <section className="rounded-2xl bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 p-3 sm:p-5 overflow-x-auto">
          <table className="w-full text-[13px] tabular-nums min-w-[640px]">
            <thead>
              <tr className="text-gray-400 dark:text-gray-500 text-[11px] uppercase tracking-wide border-b border-gray-200 dark:border-gray-700">
                <th className="text-left py-2 pl-1 font-semibold w-8">#</th>
                <th className="text-left px-2 font-semibold">Team</th>
                {COLS.map(c => (
                  <th key={c.key} title={c.title}
                    onClick={() => setSortKey(c.key)}
                    className={`text-right px-2 font-semibold cursor-pointer select-none hover:text-nw-teal ${sortKey === c.key ? 'text-nw-teal' : ''}`}>
                    {c.label}{sortKey === c.key ? ' ▾' : ''}
                  </th>
                ))}
                <th className="text-right px-2 pr-1 font-semibold">Record</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((t, i) => (
                <tr key={t.team_id} className={`border-b border-gray-100 dark:border-gray-700/50 ${i === 0 && sortKey === 'cpi' ? 'bg-teal-50/40 dark:bg-teal-900/10' : ''}`}>
                  <td className="py-2 pl-1 text-gray-400 dark:text-gray-500">{sortKey === 'cpi' ? t.rank : i + 1}</td>
                  <td className="px-2">
                    <span className="inline-flex items-center gap-2">
                      <Logo src={t.logo} />
                      <span className="font-bold text-nw-teal dark:text-gray-100">{t.team}</span>
                    </span>
                  </td>
                  <td className={`text-right px-2 font-black text-base ${cpiColor(t.cpi)}`}>{t.cpi}</td>
                  <td className="text-right px-2 text-gray-700 dark:text-gray-200">{(t.proj_winpct * 100).toFixed(1)}%</td>
                  <td className={`text-right px-2 ${idxColor(t.off_wrc)}`}>{t.off_wrc}</td>
                  <td className={`text-right px-2 ${idxColor(t.pit_index)}`}>{t.pit_index}</td>
                  <td className={`text-right px-2 ${idxColor(t.sos_index)}`}>{t.sos_index}</td>
                  <td className={`text-right px-2 font-semibold ${t.luck > 0.02 ? 'text-emerald-600 dark:text-emerald-400' : t.luck < -0.02 ? 'text-rose-600 dark:text-rose-400' : 'text-gray-400'}`}
                      title="Actual win% minus projected">
                    {t.luck == null ? '' : (t.luck > 0 ? '+' : '') + Math.round(t.luck * 100) + '%'}
                  </td>
                  <td className="text-right px-2 pr-1 text-gray-500 dark:text-gray-400">{t.actual_w}-{t.actual_l}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-3 px-1">
            Projected win % and the expected record are at full strength over a 54-game season. Off is regressed team wRC+,
            Pit is a FIP-based index, both centered at 100. Early in the season ratings sit close to 100 by design, since
            small samples are regressed toward the mean; the spread widens as games accumulate.
          </p>
        </section>
      )}
    </div>
  )
}
