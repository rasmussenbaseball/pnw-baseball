// Projections (2027) — dev-gated page under the Teams tab.
//
// Pick a team, see its projected 2027 roster: returning players + incoming
// transfers. Graduating seniors and departed NWAC sophomores are excluded.
// Class shown is the player's 2027 class. Click any row to expand a detail
// view: 2026 actual → 2027 projected with the change, plus the floor/ceiling
// (10th–90th percentile) outcomes.

import { useState, useMemo, Fragment } from 'react'
import { useProjectionTeams, useTeamProjections } from '../hooks/useApi'

const SEASON = 2027
const LEVEL_ORDER = ['D1', 'D2', 'D3', 'NAIA', 'JUCO']

const f3 = (v) => (v === null || v === undefined ? '–' : Number(v).toFixed(3))
const f2 = (v) => (v === null || v === undefined ? '–' : Number(v).toFixed(2))
const f1 = (v) => (v === null || v === undefined ? '–' : Number(v).toFixed(1))
const slash = (v) => (v === null || v === undefined ? '–' : Number(v).toFixed(3).replace(/^0/, ''))
const pctInt = (v) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`)

// pitch-level rate as a whole % with the YoY change beside it.
// upGood = is an INCREASE good for this stat+side? (hitter whiff up = bad).
function pctDelta(proj, key, prevKey, upGood = true) {
  const v = proj?.[key]
  if (v === null || v === undefined) return <span className="text-gray-300 dark:text-gray-600">–</span>
  const shown = `${Math.round(v * 100)}%`
  const prev = proj?.[prevKey]
  if (prev === null || prev === undefined) return <span>{shown}</span>
  const d = Math.round((v - prev) * 100)
  if (d === 0) return <span>{shown}</span>
  const up = d > 0
  const good = up === upGood   // up & upGood, or down & !upGood
  return <span>{shown}<span className={`ml-0.5 text-[10px] ${good ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>{up ? '▲' : '▼'}{Math.abs(d)}</span></span>
}

function Confidence({ rel }) {
  const r = rel ?? 0
  const [label, cls] = r >= 0.6 ? ['High', 'bg-emerald-500'] : r >= 0.4 ? ['Med', 'bg-amber-500'] : ['Low', 'bg-gray-400']
  return (
    <span className="inline-flex items-center gap-1.5" title={`Confidence ${label} — how much career data backs this projection (reliability ${r.toFixed(2)}). More data → less regression.`}>
      <span className={`h-2 w-2 rounded-full ${cls}`} /><span className="text-[11px] text-gray-500 dark:text-gray-400">{label}</span>
    </span>
  )
}

function Incoming({ row }) {
  if (!row.is_incoming) return null
  return <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" title={row.from_team ? `Incoming from ${row.from_team}` : 'Incoming transfer'}>{row.from_team ? `↙ ${row.from_team}` : 'Incoming'}</span>
}

function valueColor(v, lo, hi, invert = false) {
  if (v === null || v === undefined) return ''
  let t = (v - lo) / (hi - lo); if (invert) t = 1 - t; t = Math.max(0, Math.min(1, t))
  if (t > 0.66) return 'text-emerald-600 dark:text-emerald-400 font-semibold'
  if (t < 0.33) return 'text-rose-500 dark:text-rose-400'
  return 'font-medium text-gray-800 dark:text-gray-200'
}

const TH = 'px-2.5 py-2 text-right font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap text-[11px] uppercase tracking-wide'
const THL = TH + ' text-left'
const TD = 'px-2.5 py-2 text-right whitespace-nowrap tabular-nums text-gray-700 dark:text-gray-300'
const TDL = TD + ' text-left'
const GROUP = 'px-2.5 py-1 text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500'
const BL = ' border-l border-gray-200 dark:border-gray-700'

// one "2026 → 2027 (Δ)" cell in the expanded detail
function Cmp({ label, v26, v27, fmt = slash, pct = false, invertGood = false }) {
  const fmtv = pct ? (x) => (x == null ? '–' : `${Math.round(x * 100)}%`) : fmt
  const d = (v26 != null && v27 != null) ? (pct ? Math.round((v27 - v26) * 100) : v27 - v26) : null
  const good = d == null ? false : (invertGood ? d < 0 : d > 0)
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-gray-400">{label}</span>
      <span className="text-sm tabular-nums text-gray-800 dark:text-gray-200">
        <span className="text-gray-400">{fmtv(v26)}</span>
        <span className="mx-1 text-gray-300">→</span>
        <span className="font-semibold">{fmtv(v27)}</span>
        {d != null && d !== 0 && (
          <span className={`ml-1 text-[11px] ${good ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
            ({pct ? (d > 0 ? '+' : '') + d : (d > 0 ? '+' : '') + fmt(Math.abs(d)).replace(/^/, d > 0 ? '' : '-')})
          </span>
        )}
      </span>
    </div>
  )
}

function HitterDetail({ row, span }) {
  const p = row.proj || {}, a = row.actual_2026 || {}
  return (
    <tr className="bg-nw-teal/[0.03] dark:bg-nw-teal/[0.06]">
      <td colSpan={span} className="px-6 py-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-6 gap-y-3">
          <Cmp label="AVG" v26={a.avg} v27={p.AVG} />
          <Cmp label="OBP" v26={a.obp} v27={p.OBP} />
          <Cmp label="SLG" v26={a.slg} v27={p.SLG} />
          <Cmp label="wOBA" v26={a.woba} v27={p.wOBA} />
          <Cmp label="HR" v26={a.hr} v27={p.HR} fmt={f1} />
          <Cmp label="BB%" v26={p.bb_pct != null ? p.bb_pct : null} v27={p.bb_pct} pct />
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wide text-gray-400">wOBA range (floor–ceiling)</span>
            <span className="text-sm tabular-nums"><span className="text-rose-500">{slash(p.wOBA_lo)}</span>
              <span className="mx-1 font-semibold">{slash(p.wOBA)}</span>
              <span className="text-emerald-600 dark:text-emerald-400">{slash(p.wOBA_hi)}</span></span>
          </div>
        </div>
        <p className="text-[11px] text-gray-400 mt-3">2026 actual → 2027 projected. Range is the 10th–90th percentile of likely outcomes (his realistic floor and ceiling).</p>
      </td>
    </tr>
  )
}

function PitcherDetail({ row, span }) {
  const p = row.proj || {}, a = row.actual_2026 || {}
  return (
    <tr className="bg-nw-teal/[0.03] dark:bg-nw-teal/[0.06]">
      <td colSpan={span} className="px-6 py-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-6 gap-y-3">
          <Cmp label="ERA" v26={a.era} v27={p.ERA} fmt={f2} invertGood />
          <Cmp label="FIP" v26={a.fip} v27={p.FIP} fmt={f2} invertGood />
          <Cmp label="IP" v26={a.ip} v27={p.IP} fmt={f1} />
          <Cmp label="K%" v26={a.k_pct} v27={p.K_pct} pct />
          <Cmp label="BB%" v26={a.bb_pct} v27={p.BB_pct} pct invertGood />
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wide text-gray-400">ERA range (ceiling–floor)</span>
            <span className="text-sm tabular-nums"><span className="text-emerald-600 dark:text-emerald-400">{f2(p.ERA_lo)}</span>
              <span className="mx-1 font-semibold">{f2(p.ERA)}</span>
              <span className="text-rose-500">{f2(p.ERA_hi)}</span></span>
          </div>
        </div>
        <p className="text-[11px] text-gray-400 mt-3">2026 actual → 2027 projected. ERA leans on FIP/peripherals, not noisy ERA. Range is the 10th–90th percentile (best case–worst case).</p>
      </td>
    </tr>
  )
}

// Rescale counting stats to a fixed volume (200 PA / 50 IP) so players compare
// on equal playing time. Rate stats (AVG/ERA/wOBA/FIP/K%…) are untouched; WAR
// scales with volume too, giving a clean per-200-PA / per-50-IP value number.
function normLine(p, isBat) {
  const vol = isBat ? (p.PT || 0) : (p.IP || 0)
  if (!vol) return p
  const f = (isBat ? 200 : 50) / vol
  const r0 = (v) => (v == null ? v : Math.round(v * f))
  const r1 = (v) => (v == null ? v : Math.round(v * f * 10) / 10)
  return isBat
    ? { ...p, PT: 200, H: r0(p.H), '2B': r0(p['2B']), '3B': r0(p['3B']),
        HR: r1(p.HR), R: r0(p.R), RBI: r0(p.RBI), BB: r0(p.BB), WAR: r1(p.WAR) }
    : { ...p, IP: 50, BF: r0(p.BF), HR_allowed: r1(p.HR_allowed), WAR: r1(p.WAR) }
}

function Table({ rows, side, expanded, toggle, norm }) {
  if (!rows?.length) return <p className="text-sm text-gray-500 py-4">No projected {side === 'bat' ? 'hitters' : 'pitchers'}.</p>
  const isBat = side === 'bat'
  const span = isBat ? 20 : 16
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-800/60">
            <th className={THL} colSpan={3}> </th>
            {isBat ? <>
              <th className={GROUP} colSpan={8}>Counting</th>
              <th className={GROUP + BL} colSpan={4}>Rate &amp; value</th>
              <th className={GROUP + BL} colSpan={3}>Plate skills (Δ vs ’26)</th>
            </> : <>
              <th className={GROUP} colSpan={6}>Run prevention</th>
              <th className={GROUP + BL} colSpan={2}>Command</th>
              <th className={GROUP + BL} colSpan={3}>Stuff (Δ vs ’26)</th>
            </>}
            <th className={GROUP + BL} colSpan={2}>Value</th>
          </tr>
          <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60">
            <th className={THL}>Player</th><th className={TH}>’27</th><th className={TH}>Pos</th>
            {isBat ? <>
              <th className={TH}>PA</th><th className={TH}>H</th><th className={TH}>2B</th><th className={TH}>3B</th>
              <th className={TH}>HR</th><th className={TH}>R</th><th className={TH}>RBI</th><th className={TH}>BB</th>
              <th className={TH + BL}>AVG</th><th className={TH}>OBP</th><th className={TH}>SLG</th><th className={TH}>wOBA</th>
              <th className={TH + BL}>Whiff</th><th className={TH}>GB</th><th className={TH}>Pull-air</th>
            </> : <>
              <th className={TH}>BF</th><th className={TH}>IP</th><th className={TH}>ERA</th><th className={TH}>FIP</th><th className={TH}>WHIP</th><th className={TH}>HR</th>
              <th className={TH + BL}>K%</th><th className={TH}>BB%</th>
              <th className={TH + BL}>Whiff</th><th className={TH}>GB</th><th className={TH}>Strike</th>
            </>}
            <th className={TH + BL}>WAR</th><th className={TH}>Conf</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const p = norm ? normLine(r.proj || {}, isBat) : (r.proj || {})
            const open = expanded === r.player_id
            return (
              <Fragment key={r.player_id}>
                <tr onClick={() => toggle(r.player_id)}
                    className={`cursor-pointer border-b border-gray-100 dark:border-gray-800 ${i % 2 ? 'bg-gray-50/40 dark:bg-gray-800/20' : ''} ${open ? 'bg-nw-teal/5' : 'hover:bg-nw-teal/5'}`}>
                  <td className={TDL + ' font-medium text-gray-900 dark:text-gray-100'}>
                    <span className="text-gray-300 mr-1">{open ? '▾' : '▸'}</span>{r.name}<Incoming row={r} />
                  </td>
                  <td className={TD}>{p.class_2027 || '–'}</td>
                  <td className={TD}>{r.pos || '–'}</td>
                  {isBat ? <>
                    <td className={TD}>{p.PT ?? '–'}</td><td className={TD}>{p.H ?? '–'}</td>
                    <td className={TD}>{p['2B'] ?? '–'}</td><td className={TD}>{p['3B'] ?? '–'}</td>
                    <td className={TD + ' font-semibold text-gray-900 dark:text-gray-100'}>{p.HR ?? '–'}</td>
                    <td className={TD}>{p.R ?? '–'}</td><td className={TD}>{p.RBI ?? '–'}</td><td className={TD}>{p.BB ?? '–'}</td>
                    <td className={TD + BL}>{slash(p.AVG)}</td><td className={TD}>{slash(p.OBP)}</td><td className={TD}>{slash(p.SLG)}</td>
                    <td className={`${TD} ${valueColor(p.wOBA, 0.300, 0.430)}`}>{slash(p.wOBA)}</td>
                    <td className={TD + BL}>{pctDelta(p, 'p_whiff', 'p_whiff_prev', false)}</td>
                    <td className={TD}>{pctDelta(p, 'p_gb', 'p_gb_prev', false)}</td><td className={TD}>{pctDelta(p, 'p_airpull', 'p_airpull_prev', true)}</td>
                  </> : <>
                    <td className={TD}>{p.BF ?? '–'}</td><td className={TD}>{f1(p.IP)}</td>
                    <td className={`${TD} ${valueColor(p.ERA, 3.5, 7.0, true)}`}>{f2(p.ERA)}</td>
                    <td className={TD}>{f2(p.FIP)}</td>
                    <td className={TD}>{f2(p.WHIP)}</td><td className={TD}>{f1(p.HR_allowed)}</td>
                    <td className={TD + BL}>{pctInt(p.K_pct)}</td><td className={TD}>{pctInt(p.BB_pct)}</td>
                    <td className={TD + BL}>{pctDelta(p, 'p_whiff', 'p_whiff_prev')}</td>
                    <td className={TD}>{pctDelta(p, 'p_gb', 'p_gb_prev')}</td><td className={TD}>{pctDelta(p, 'p_strike', 'p_strike_prev')}</td>
                  </>}
                  <td className={`${TD} ${BL} font-semibold ${valueColor(p.WAR, 0.5, 2.0)}`}>{f1(p.WAR)}</td>
                  <td className={TDL}><Confidence rel={p.reliability} /></td>
                </tr>
                {open && (isBat ? <HitterDetail row={r} span={span} /> : <PitcherDetail row={r} span={span} />)}
              </Fragment>
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
  const [expanded, setExpanded] = useState(null)
  const [norm, setNorm] = useState(false)
  const effectiveTeamId = picked || teams?.[0]?.id || null
  const { data: payload, loading } = useTeamProjections(effectiveTeamId, SEASON)
  const toggle = (id) => setExpanded((cur) => (cur === id ? null : id))

  const grouped = useMemo(() => {
    const g = {}; for (const t of teams || []) (g[t.level] ||= []).push(t); return g
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
            Returning players + incoming transfers. Graduating seniors and departed NWAC sophomores excluded.
            Click any player for their 2026 → 2027 change and floor/ceiling outcomes.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <label className="text-sm">
            <span className="block text-xs text-gray-500 mb-1">View</span>
            <button onClick={() => setNorm((v) => !v)}
              className={`rounded-md border px-3 py-2 text-sm font-medium whitespace-nowrap ${norm ? 'border-nw-teal bg-nw-teal/10 text-nw-teal' : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300'}`}>
              {norm ? 'Per 200 PA / 50 IP' : 'Projected totals'}
            </button>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-500 mb-1">Team</span>
            <select className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm min-w-[240px]"
              value={effectiveTeamId || ''} onChange={(e) => { setPicked(Number(e.target.value)); setExpanded(null) }}>
              {LEVEL_ORDER.filter((lv) => grouped[lv]).map((lv) => (
                <optgroup key={lv} label={lv}>
                  {grouped[lv].map((t) => <option key={t.id} value={t.id}>{t.short_name}{t.n_incoming ? ` (+${t.n_incoming})` : ''}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
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
            <Table rows={payload.hitters} side="bat" expanded={expanded} toggle={toggle} norm={norm} />
          </section>
          <section>
            <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wide">Pitchers</h3>
            <Table rows={payload.pitchers} side="pit" expanded={expanded} toggle={toggle} norm={norm} />
          </section>
          <div className="text-xs text-gray-400 dark:text-gray-500 space-y-1 pt-3 border-t border-gray-100 dark:border-gray-800">
            <p><b>Conf</b> = how much career data backs the projection (more data → more confident, less regression).
              <b> Plate skills / Stuff</b> show the projected rate with the projected change vs 2026 (▲/▼).
              The point projection is the most-likely (median) outcome; a player’s upside lives in his ceiling — click a row to see it.</p>
            <p><b>ERA</b> blends FIP-reconstruction with regressed ERA (leans on stable peripherals). Incoming transfers are projected at their new level.</p>
          </div>
        </div>
      )}
    </div>
  )
}
