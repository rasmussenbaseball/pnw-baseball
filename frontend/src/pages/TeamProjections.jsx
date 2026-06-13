// Projections (2027) — dev-gated page under the Teams tab.
//
// Pick a team and see its projected 2027 roster: returning players plus
// incoming transfers (resolved from commitments + the transfer portal),
// each with a full projected stat line. Graduating seniors / departed
// NWAC sophomores are excluded by the projection writer.

import { useState, useMemo } from 'react'
import { useProjectionTeams, useTeamProjections } from '../hooks/useApi'

const SEASON = 2027
const LEVEL_ORDER = ['D1', 'D2', 'D3', 'NAIA', 'JUCO']

function num(v, d = 3) {
  if (v === null || v === undefined) return '-'
  return typeof v === 'number' ? v.toFixed(d) : v
}

// pitch-level stat with year-over-year delta in parens
function withDelta(proj, key, prevKey, pct = true) {
  const v = proj?.[key]
  if (v === null || v === undefined) return '-'
  const shown = pct ? Math.round(v * 100) : v.toFixed(3)
  const prev = proj?.[prevKey]
  if (prev === null || prev === undefined) return `${shown}`
  const d = pct ? Math.round((v - prev) * 100) : (v - prev).toFixed(3)
  const sign = d > 0 ? '+' : ''
  return `${shown} (${sign}${d})`
}

function IncomingBadge({ row }) {
  if (!row.is_incoming) return null
  return (
    <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold
                     bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
          title={row.from_team ? `Incoming from ${row.from_team}` : 'Incoming transfer'}>
      {row.from_team ? `← ${row.from_team}` : 'Incoming'}
    </span>
  )
}

const TH = 'px-2 py-1.5 text-left font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap'
const TD = 'px-2 py-1.5 whitespace-nowrap tabular-nums'

function HitterTable({ rows }) {
  if (!rows?.length) return <p className="text-sm text-gray-500 py-4">No projected hitters.</p>
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead className="border-b border-gray-200 dark:border-gray-700">
          <tr>
            {['Player', 'Pos', "'26 Cls", 'PA', 'AB', 'H', '2B', '3B', 'HR', 'R', 'RBI', 'BB', 'SO',
              'AVG', 'OBP', 'SLG', 'wOBA', 'Range', 'Whiff%', 'GB%', 'AirPull%', 'Rel'].map((h) => (
              <th key={h} className={TH}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const p = r.proj || {}
            return (
              <tr key={r.player_id} className="border-b border-gray-100 dark:border-gray-800
                                               hover:bg-gray-50 dark:hover:bg-gray-800/40">
                <td className={`${TD} font-medium`}>{r.name}<IncomingBadge row={r} /></td>
                <td className={TD}>{r.pos || '-'}</td>
                <td className={TD}>{r.class_last || '-'}</td>
                <td className={TD}>{p.PT ?? '-'}</td>
                <td className={TD}>{p.AB ?? '-'}</td>
                <td className={TD}>{p.H ?? '-'}</td>
                <td className={TD}>{p['2B'] ?? '-'}</td>
                <td className={TD}>{p['3B'] ?? '-'}</td>
                <td className={`${TD} font-semibold`}>{p.HR ?? '-'}</td>
                <td className={TD}>{p.R ?? '-'}</td>
                <td className={TD}>{p.RBI ?? '-'}</td>
                <td className={TD}>{p.BB ?? '-'}</td>
                <td className={TD}>{p.SO ?? '-'}</td>
                <td className={TD}>{num(p.AVG)}</td>
                <td className={TD}>{num(p.OBP)}</td>
                <td className={TD}>{num(p.SLG)}</td>
                <td className={`${TD} font-semibold`}>{num(p.wOBA)}</td>
                <td className={`${TD} text-gray-500`}>{num(p.wOBA_lo)}–{num(p.wOBA_hi)}</td>
                <td className={TD}>{withDelta(p, 'p_whiff', 'p_whiff_prev')}</td>
                <td className={TD}>{withDelta(p, 'p_gb', 'p_gb_prev')}</td>
                <td className={TD}>{withDelta(p, 'p_airpull', 'p_airpull_prev')}</td>
                <td className={`${TD} text-gray-500`}>{num(p.reliability, 2)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PitcherTable({ rows }) {
  if (!rows?.length) return <p className="text-sm text-gray-500 py-4">No projected pitchers.</p>
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead className="border-b border-gray-200 dark:border-gray-700">
          <tr>
            {['Player', 'Pos', "'26 Cls", 'BF', 'ERA~', 'FIP~', 'Range', 'FIPluck', 'K%', 'BB%',
              'Whiff%', 'GB%', 'Strike%', 'Rel'].map((h) => (
              <th key={h} className={TH}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const p = r.proj || {}
            return (
              <tr key={r.player_id} className="border-b border-gray-100 dark:border-gray-800
                                               hover:bg-gray-50 dark:hover:bg-gray-800/40">
                <td className={`${TD} font-medium`}>{r.name}<IncomingBadge row={r} /></td>
                <td className={TD}>{r.pos || '-'}</td>
                <td className={TD}>{r.class_last || '-'}</td>
                <td className={TD}>{p.BF ?? '-'}</td>
                <td className={`${TD} font-semibold`}>{num(p.ERA, 2)}</td>
                <td className={TD}>{num(p.FIP, 2)}</td>
                <td className={`${TD} text-gray-500`}>{num(p.ERA_lo, 2)}–{num(p.ERA_hi, 2)}</td>
                <td className={TD}>{p.fip_luck === null || p.fip_luck === undefined ? '-' : (p.fip_luck > 0 ? '+' : '') + p.fip_luck.toFixed(2)}</td>
                <td className={TD}>{num(p.K_pct)}</td>
                <td className={TD}>{num(p.BB_pct)}</td>
                <td className={TD}>{withDelta(p, 'p_whiff', 'p_whiff_prev')}</td>
                <td className={TD}>{withDelta(p, 'p_gb', 'p_gb_prev')}</td>
                <td className={TD}>{withDelta(p, 'p_strike', 'p_strike_prev')}</td>
                <td className={`${TD} text-gray-500`}>{num(p.reliability, 2)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function TeamProjections() {
  const { data: teams } = useProjectionTeams(SEASON)
  const [picked, setPicked] = useState(null)
  // default to the first team once the list loads; user selection overrides
  const effectiveTeamId = picked || teams?.[0]?.id || null
  const setTeamId = setPicked
  const { data: payload, loading: isLoading } = useTeamProjections(effectiveTeamId, SEASON)

  const grouped = useMemo(() => {
    const g = {}
    for (const t of teams || []) (g[t.level] ||= []).push(t)
    return g
  }, [teams])

  return (
    <div className="max-w-screen-2xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">2027 Projections</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Projected next-season lines for returning players plus incoming transfers.
            Graduating seniors and departed NWAC sophomores are excluded.
          </p>
        </div>
        <label className="text-sm">
          <span className="block text-xs text-gray-500 mb-1">Team</span>
          <select
            className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800
                       px-3 py-2 text-sm min-w-[220px]"
            value={effectiveTeamId || ''}
            onChange={(e) => setTeamId(Number(e.target.value))}
          >
            {LEVEL_ORDER.filter((lv) => grouped[lv]).map((lv) => (
              <optgroup key={lv} label={lv}>
                {grouped[lv].map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.short_name} ({t.n}{t.n_incoming ? `, ${t.n_incoming} in` : ''})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      {isLoading && <p className="text-sm text-gray-500 py-8">Loading projections…</p>}
      {!isLoading && payload && (
        <div className="space-y-8">
          <section>
            <div className="flex items-center gap-2 mb-2">
              {payload.team?.logo_url && (
                <img src={payload.team.logo_url} alt="" className="h-7 w-7 object-contain" />
              )}
              <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
                {payload.team?.short_name} — Hitters
              </h2>
            </div>
            <HitterTable rows={payload.hitters} />
          </section>
          <section>
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-2">
              {payload.team?.short_name} — Pitchers
            </h2>
            <PitcherTable rows={payload.pitchers} />
          </section>
          <p className="text-xs text-gray-400 dark:text-gray-500 pt-2 border-t border-gray-100 dark:border-gray-800">
            Pitch-level stats show the projected value with the change vs 2026 in parentheses.
            ERA~ blends FIP-reconstruction with regressed ERA. FIPluck = career ERA−FIP
            (negative = beats FIP, positive = unlucky rebound candidate). Range = 10th–90th percentile.
            Incoming transfers are projected at their new level.
          </p>
        </div>
      )}
    </div>
  )
}
