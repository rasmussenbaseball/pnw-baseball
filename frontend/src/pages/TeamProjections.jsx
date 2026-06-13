// Projections (2027) — dev-gated page under the Teams tab.
//
// Pick a team, see its projected 2027 roster: returning players + incoming
// transfers (resolved from commitments + the portal). Graduating seniors and
// departed NWAC sophomores are excluded by the writer. Class shown is the
// player's 2027 class. Stats are projected (not actual).

import { useState, useMemo } from 'react'
import { useProjectionTeams, useTeamProjections } from '../hooks/useApi'

const SEASON = 2027
const LEVEL_ORDER = ['D1', 'D2', 'D3', 'NAIA', 'JUCO']

const f3 = (v) => (v === null || v === undefined ? '–' : Number(v).toFixed(3))
const f2 = (v) => (v === null || v === undefined ? '–' : Number(v).toFixed(2))
// slash without leading zero (.312), the baseball convention
const slash = (v) => (v === null || v === undefined ? '–' : Number(v).toFixed(3).replace(/^0/, ''))

// pitch-level rate shown as a whole-number % with the YoY change beside it
function pct(proj, key, prevKey) {
  const v = proj?.[key]
  if (v === null || v === undefined) return <span className="text-gray-300 dark:text-gray-600">–</span>
  const shown = Math.round(v * 100)
  const prev = proj?.[prevKey]
  if (prev === null || prev === undefined) return <span>{shown}</span>
  const d = Math.round((v - prev) * 100)
  if (d === 0) return <span>{shown}</span>
  const up = d > 0
  return (
    <span>{shown}<span className={`ml-0.5 text-[10px] ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
      {up ? '▲' : '▼'}{Math.abs(d)}</span></span>
  )
}

// Confidence from reliability: how much real data backs the projection.
function Confidence({ rel }) {
  const r = rel ?? 0
  const [label, cls] = r >= 0.6 ? ['High', 'bg-emerald-500'] : r >= 0.4 ? ['Med', 'bg-amber-500'] : ['Low', 'bg-gray-400']
  return (
    <span className="inline-flex items-center gap-1.5" title={`Confidence ${label} — based on how much career data backs this projection (reliability ${r.toFixed(2)})`}>
      <span className={`h-2 w-2 rounded-full ${cls}`} />
      <span className="text-[11px] text-gray-500 dark:text-gray-400">{label}</span>
    </span>
  )
}

function Incoming({ row }) {
  if (!row.is_incoming) return null
  return (
    <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold
                     bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
          title={row.from_team ? `Incoming from ${row.from_team}` : 'Incoming transfer'}>
      {row.from_team ? `↙ ${row.from_team}` : 'Incoming'}
    </span>
  )
}

// color scale for the headline value stat (green good → red bad)
function valueColor(v, lo, hi, invert = false) {
  if (v === null || v === undefined) return ''
  let t = (v - lo) / (hi - lo)
  if (invert) t = 1 - t
  t = Math.max(0, Math.min(1, t))
  if (t > 0.66) return 'text-emerald-600 dark:text-emerald-400 font-semibold'
  if (t < 0.33) return 'text-rose-500 dark:text-rose-400'
  return 'font-medium text-gray-800 dark:text-gray-200'
}

const TH = 'px-2.5 py-2 text-right font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap text-[11px] uppercase tracking-wide'
const THL = TH + ' text-left'
const TD = 'px-2.5 py-2 text-right whitespace-nowrap tabular-nums text-gray-700 dark:text-gray-300'
const TDL = TD + ' text-left'
const GROUP = 'px-2.5 py-1 text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500'

function HitterTable({ rows }) {
  if (!rows?.length) return <p className="text-sm text-gray-500 py-4">No projected hitters.</p>
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-800/60">
            <th className={THL} colSpan={3}> </th>
            <th className={GROUP} colSpan={8}>Counting</th>
            <th className={GROUP + ' border-l border-gray-200 dark:border-gray-700'} colSpan={4}>Rate &amp; value</th>
            <th className={GROUP + ' border-l border-gray-200 dark:border-gray-700'} colSpan={3}>Plate skills (Δ vs ’26)</th>
            <th className={GROUP} colSpan={1}> </th>
          </tr>
          <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60">
            <th className={THL}>Player</th><th className={TH}>’27</th><th className={TH}>Pos</th>
            <th className={TH}>PA</th><th className={TH}>H</th><th className={TH}>2B</th><th className={TH}>3B</th>
            <th className={TH}>HR</th><th className={TH}>R</th><th className={TH}>RBI</th><th className={TH}>BB</th>
            <th className={TH + ' border-l border-gray-200 dark:border-gray-700'}>AVG</th><th className={TH}>OBP</th><th className={TH}>SLG</th>
            <th className={TH}>wOBA</th>
            <th className={TH + ' border-l border-gray-200 dark:border-gray-700'}>Whiff</th><th className={TH}>GB</th><th className={TH}>Pull-air</th>
            <th className={TH + ' border-l border-gray-200 dark:border-gray-700'}>Conf</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const p = r.proj || {}
            return (
              <tr key={r.player_id} className={`border-b border-gray-100 dark:border-gray-800 ${i % 2 ? 'bg-gray-50/40 dark:bg-gray-800/20' : ''} hover:bg-nw-teal/5`}>
                <td className={TDL + ' font-medium text-gray-900 dark:text-gray-100'}>{r.name}<Incoming row={r} /></td>
                <td className={TD}>{p.class_2027 || '–'}</td>
                <td className={TD}>{r.pos || '–'}</td>
                <td className={TD}>{p.PT ?? '–'}</td>
                <td className={TD}>{p.H ?? '–'}</td>
                <td className={TD}>{p['2B'] ?? '–'}</td>
                <td className={TD}>{p['3B'] ?? '–'}</td>
                <td className={TD + ' font-semibold text-gray-900 dark:text-gray-100'}>{p.HR ?? '–'}</td>
                <td className={TD}>{p.R ?? '–'}</td>
                <td className={TD}>{p.RBI ?? '–'}</td>
                <td className={TD}>{p.BB ?? '–'}</td>
                <td className={TD + ' border-l border-gray-100 dark:border-gray-800'}>{slash(p.AVG)}</td>
                <td className={TD}>{slash(p.OBP)}</td>
                <td className={TD}>{slash(p.SLG)}</td>
                <td className={`${TD} ${valueColor(p.wOBA, 0.300, 0.430)}`}>{slash(p.wOBA)}</td>
                <td className={TD + ' border-l border-gray-100 dark:border-gray-800'}>{pct(p, 'p_whiff', 'p_whiff_prev')}</td>
                <td className={TD}>{pct(p, 'p_gb', 'p_gb_prev')}</td>
                <td className={TD}>{pct(p, 'p_airpull', 'p_airpull_prev')}</td>
                <td className={TDL + ' border-l border-gray-100 dark:border-gray-800'}><Confidence rel={p.reliability} /></td>
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
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-800/60">
            <th className={THL} colSpan={3}> </th>
            <th className={GROUP} colSpan={4}>Run prevention</th>
            <th className={GROUP + ' border-l border-gray-200 dark:border-gray-700'} colSpan={2}>Command</th>
            <th className={GROUP + ' border-l border-gray-200 dark:border-gray-700'} colSpan={3}>Stuff (Δ vs ’26)</th>
            <th className={GROUP} colSpan={1}> </th>
          </tr>
          <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60">
            <th className={THL}>Player</th><th className={TH}>’27</th><th className={TH}>Pos</th>
            <th className={TH}>BF</th><th className={TH}>ERA</th><th className={TH}>FIP</th>
            <th className={TH} title="Career ERA minus FIP. Negative = beats FIP; positive = unlucky.">Luck</th>
            <th className={TH + ' border-l border-gray-200 dark:border-gray-700'}>K%</th><th className={TH}>BB%</th>
            <th className={TH + ' border-l border-gray-200 dark:border-gray-700'}>Whiff</th><th className={TH}>GB</th><th className={TH}>Strike</th>
            <th className={TH + ' border-l border-gray-200 dark:border-gray-700'}>Conf</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const p = r.proj || {}
            return (
              <tr key={r.player_id} className={`border-b border-gray-100 dark:border-gray-800 ${i % 2 ? 'bg-gray-50/40 dark:bg-gray-800/20' : ''} hover:bg-nw-teal/5`}>
                <td className={TDL + ' font-medium text-gray-900 dark:text-gray-100'}>{r.name}<Incoming row={r} /></td>
                <td className={TD}>{p.class_2027 || '–'}</td>
                <td className={TD}>{r.pos || '–'}</td>
                <td className={TD}>{p.BF ?? '–'}</td>
                <td className={`${TD} ${valueColor(p.ERA, 3.5, 7.0, true)}`}>{f2(p.ERA)}</td>
                <td className={TD}>{f2(p.FIP)}</td>
                <td className={TD + ' text-[11px]'}>{p.fip_luck === null || p.fip_luck === undefined ? '–' : (p.fip_luck > 0 ? '+' : '') + p.fip_luck.toFixed(1)}</td>
                <td className={TD + ' border-l border-gray-100 dark:border-gray-800'}>{Math.round((p.K_pct ?? 0) * 100)}</td>
                <td className={TD}>{Math.round((p.BB_pct ?? 0) * 100)}</td>
                <td className={TD + ' border-l border-gray-100 dark:border-gray-800'}>{pct(p, 'p_whiff', 'p_whiff_prev')}</td>
                <td className={TD}>{pct(p, 'p_gb', 'p_gb_prev')}</td>
                <td className={TD}>{pct(p, 'p_strike', 'p_strike_prev')}</td>
                <td className={TDL + ' border-l border-gray-100 dark:border-gray-800'}><Confidence rel={p.reliability} /></td>
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
  const effectiveTeamId = picked || teams?.[0]?.id || null
  const { data: payload, loading } = useTeamProjections(effectiveTeamId, SEASON)

  const grouped = useMemo(() => {
    const g = {}
    for (const t of teams || []) (g[t.level] ||= []).push(t)
    return g
  }, [teams])

  const nIncoming = (payload?.hitters || []).concat(payload?.pitchers || []).filter((r) => r.is_incoming).length
  const nTotal = (payload?.hitters?.length || 0) + (payload?.pitchers?.length || 0)

  return (
    <div className="max-w-screen-2xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">2027 Projections</h1>
            <span className="rounded bg-nw-teal/10 text-nw-teal text-[10px] font-bold px-1.5 py-0.5 uppercase">Dev</span>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Projected next-season lines for returning players + incoming transfers. Graduating
            seniors and departed NWAC sophomores are excluded. Numbers are projections, not actuals.
          </p>
        </div>
        <label className="text-sm">
          <span className="block text-xs text-gray-500 mb-1">Team</span>
          <select
            className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm min-w-[240px]"
            value={effectiveTeamId || ''} onChange={(e) => setPicked(Number(e.target.value))}>
            {LEVEL_ORDER.filter((lv) => grouped[lv]).map((lv) => (
              <optgroup key={lv} label={lv}>
                {grouped[lv].map((t) => (
                  <option key={t.id} value={t.id}>{t.short_name}{t.n_incoming ? ` (+${t.n_incoming})` : ''}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      {loading && <p className="text-sm text-gray-500 py-8">Loading projections…</p>}
      {!loading && payload && (
        <div className="space-y-7">
          <div className="flex items-center gap-3">
            {payload.team?.logo_url && <img src={payload.team.logo_url} alt="" className="h-9 w-9 object-contain" />}
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">{payload.team?.short_name}</h2>
              <p className="text-xs text-gray-500">{nTotal} projected players{nIncoming ? ` · ${nIncoming} incoming` : ''}</p>
            </div>
          </div>

          <section>
            <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wide">Hitters</h3>
            <HitterTable rows={payload.hitters} />
          </section>
          <section>
            <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wide">Pitchers</h3>
            <PitcherTable rows={payload.pitchers} />
          </section>

          <div className="text-xs text-gray-400 dark:text-gray-500 space-y-1 pt-3 border-t border-gray-100 dark:border-gray-800">
            <p><b>Conf</b> = how much career data backs the projection (more data → more confident, less regression).
              <b> Plate skills / Stuff</b> show the projected rate with the projected change vs 2026 (▲/▼).</p>
            <p><b>ERA</b> blends FIP-reconstruction with regressed ERA (leans on the stable peripherals, not noisy ERA).
              <b> Luck</b> = career ERA−FIP: negative means the pitcher has beaten his FIP, positive means he’s been unlucky.
              Incoming transfers are projected at their new level.</p>
          </div>
        </div>
      )}
    </div>
  )
}
