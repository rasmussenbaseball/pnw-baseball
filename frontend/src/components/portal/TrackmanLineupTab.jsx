/**
 * TrackMan Lineup tab: best nine vs RHP, vs LHP and overall, built from
 * pitch-level projections (see backend/app/stats/trackman_lineup.py), plus
 * the position-eligibility editor the optimizer reads.
 */
import { useMemo, useRef, useState } from 'react'
import { useApi } from '../../hooks/useApi'
import { supabase } from '../../lib/supabase'
import ReportActions from '../ReportActions'

const POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']
const CARDS = [
  ['R', 'vs RHP', 'Right-handed starter: platoon-adjusted projection for every hitter.'],
  ['L', 'vs LHP', 'Left-handed starter: same model, lefty platoon factors.'],
  ['all', 'Overall', 'No platoon adjustment: the lineup to post when the starter is unknown.'],
]

async function authHeaders() {
  try {
    const { data } = await supabase.auth.getSession()
    const t = data?.session?.access_token
    return t ? { Authorization: `Bearer ${t}` } : {}
  } catch { return {} }
}

const f3 = v => (v == null ? '—' : v.toFixed(3).replace(/^0/, ''))
const f1 = v => (v == null ? '—' : v.toFixed(1))
const sideTag = s => (s === 'L' ? 'L' : s === 'R' ? 'R' : s === 'S' ? 'S' : '')

function Card({ title, sub, right, children }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
      {(title || right) && (
        <div className="flex items-baseline justify-between gap-2 mb-2 flex-wrap">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">{title}</span>
            {sub && <span className="ml-2 text-[10px] text-gray-400">{sub}</span>}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  )
}

export default function TrackmanLineupTab({ teamCtx, season }) {
  const exportRef = useRef(null)
  const [team, setTeam] = useState(teamCtx.primary)
  // custom nine per card (names), set by swapping a bench hitter in
  const [custom, setCustom] = useState({})
  const [showModel, setShowModel] = useState(false)
  const params = {
    team: team || undefined, season,
    starters_r: custom.R?.join(',') || undefined,
    starters_l: custom.L?.join(',') || undefined,
    starters_all: custom.all?.join(',') || undefined,
  }
  const { data, loading, error, refetch } = useApi(team ? '/trackman/lineup' : null, params,
    [team, season, params.starters_r, params.starters_l, params.starters_all])

  const hitters = data?.hitters || []
  const byName = useMemo(() => Object.fromEntries(hitters.map(h => [h.player, h])), [hitters])

  function swap(vk, outName, inName) {
    const l = data?.lineups?.[vk]
    if (!l?.starters) return
    const nine = l.starters.map(s => (s.player === outName ? inName : s.player))
    setCustom(c => ({ ...c, [vk]: nine }))
  }
  function resetCard(vk) {
    setCustom(c => { const n = { ...c }; delete n[vk]; return n })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <select value={team} onChange={e => { setTeam(e.target.value); setCustom({}) }}
          className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2.5 py-1.5 text-sm font-semibold">
          {teamCtx.teams.map(t => <option key={t} value={t}>{t}{t === teamCtx.primary ? ' (my team)' : ''}</option>)}
        </select>
        <p className="text-xs text-gray-500 dark:text-gray-400 max-w-3xl">
          Same slot logic as the site's Lineup Helper (The Book: best hitters at 2 and 4, OBP and low strikeouts up top, power at 4 and 5, a real on-base bat at 9), but every input comes from TrackMan: expected production off exit velocity and launch angle instead of results, strikeout and walk rates projected from whiff, chase and zone contact on every pitch, platoon splits read from every pitch against each hand, swing decisions (SD+) for the table setters. Each card is then simulated for runs per game.
        </p>
        {data && <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setShowModel(v => !v)} className="text-[11px] font-semibold text-portal-purple dark:text-indigo-300">{showModel ? 'Hide model' : 'How the model works'}</button>
          <ReportActions targetRef={exportRef} filename={`trackman_lineups_${team}`} />
        </div>}
      </div>

      {error && <div className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-900/20 rounded-lg p-3">{String(error)}</div>}
      {loading && !data && <div className="text-sm text-gray-400 p-6 text-center">Projecting every hitter and simulating lineups…</div>}

      {showModel && data && <ModelCard model={data.model} />}

      {data && (
        <div ref={exportRef} className="space-y-3">
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
            {CARDS.map(([vk, title, blurb]) => (
              <LineupCard key={vk} vk={vk} title={title} blurb={blurb} lineup={data.lineups?.[vk]}
                byName={byName} loading={loading} onSwap={(o, i) => swap(vk, o, i)} onReset={() => resetCard(vk)} isCustom={!!custom[vk]} />
            ))}
          </div>
          <EligibilityEditor hitters={hitters} model={data.model} onSaved={refetch} />
          <ProjectionTable hitters={hitters} />
        </div>
      )}
    </div>
  )
}

function LineupCard({ vk, title, blurb, lineup, byName, loading, onSwap, onReset, isCustom }) {
  const [swapFor, setSwapFor] = useState(null)   // starter name being replaced
  if (!lineup) return <Card title={title}><div className="text-xs text-gray-400">No lineup.</div></Card>
  if (lineup.error) return <Card title={title}><div className="text-xs text-rose-600">{lineup.error}</div></Card>
  const hand = vk === 'all' ? null : vk
  const edge = lineup.edge_per_game
  return (
    <Card title={title} sub={blurb}
      right={<div className="flex items-center gap-2">
        {isCustom && <button onClick={onReset} className="text-[10px] font-semibold text-rose-600">reset to optimal</button>}
        {loading && <span className="text-[10px] text-gray-400">updating…</span>}
      </div>}>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[9px] uppercase tracking-wide text-gray-400">
            <th className="py-1 pr-1">#</th><th className="py-1 pr-1">Pos</th><th className="py-1 pr-2">Hitter</th>
            <th className="py-1 px-1 text-right" title="Projected wOBA for this matchup">wOBA</th>
            <th className="py-1 px-1 text-right">OBP</th><th className="py-1 px-1 text-right">SLG</th>
            <th className="py-1 px-1 text-right">K%</th><th className="py-1 px-1 text-right">BB%</th>
            <th className="py-1 px-1 text-right" title="Swing decisions, 100 = league">SD+</th>
            {hand && <th className="py-1 px-1 text-right" title="Platoon adjustment to wOBA, % (prior split updated by pitch-level run value vs this hand)">Plat</th>}
            <th className="py-1 px-1 text-right" title="Slot fitness (runs per season vs an average hitter in this slot)">Fit</th>
            <th className="py-1 pl-1"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {lineup.starters.map(s => (
            <tr key={s.player} className={swapFor === s.player ? 'bg-indigo-50 dark:bg-indigo-900/20' : ''}>
              <td className="py-1 pr-1 tabular-nums font-bold text-gray-500">{s.slot}</td>
              <td className={`py-1 pr-1 font-semibold ${s.position === 'DH' ? 'text-gray-400' : ''}`}>{s.position}</td>
              <td className="py-1 pr-2 whitespace-nowrap font-semibold">{s.player}<span className="ml-1 text-[9px] text-gray-400">{sideTag(s.side)}</span>
                {s.best_slot !== s.slot && <span className="ml-1 text-[9px] text-gray-400" title={`His single best slot would be ${s.best_slot}; the order balances the whole nine`}>({s.best_slot})</span>}</td>
              <td className="py-1 px-1 text-right tabular-nums font-bold">{f3(s.woba)}</td>
              <td className="py-1 px-1 text-right tabular-nums">{f3(s.obp)}</td>
              <td className="py-1 px-1 text-right tabular-nums">{f3(s.slg)}</td>
              <td className="py-1 px-1 text-right tabular-nums">{f1(s.k_pct)}</td>
              <td className="py-1 px-1 text-right tabular-nums">{f1(s.bb_pct)}</td>
              <td className={`py-1 px-1 text-right tabular-nums ${s.sd_plus == null ? 'text-gray-300' : s.sd_plus >= 110 ? 'text-emerald-600' : s.sd_plus <= 90 ? 'text-rose-600' : ''}`}>{s.sd_plus ?? '—'}</td>
              {hand && <td className={`py-1 px-1 text-right tabular-nums text-[11px] ${s.platoon_adj > 0 ? 'text-emerald-600' : s.platoon_adj < 0 ? 'text-rose-600' : 'text-gray-400'}`}>{s.platoon_adj == null ? '—' : `${s.platoon_adj > 0 ? '+' : ''}${s.platoon_adj.toFixed(1)}`}</td>}
              <td className="py-1 px-1 text-right tabular-nums text-gray-500">{s.score.toFixed(0)}</td>
              <td className="py-1 pl-1 text-right">
                <button onClick={() => setSwapFor(swapFor === s.player ? null : s.player)}
                  className="text-[10px] font-semibold text-gray-400 hover:text-portal-purple" title="Replace this starter with a bench hitter">swap</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {swapFor && (
        <div className="mt-2 text-[11px] bg-gray-50 dark:bg-gray-900 rounded-lg p-2">
          <span className="font-semibold">Replace {swapFor} with:</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {lineup.bench.map(b => (
              <button key={b.player} onClick={() => { onSwap(swapFor, b.player); setSwapFor(null) }}
                className="px-2 py-0.5 rounded-full bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 hover:ring-portal-purple"
                title={`wOBA ${f3(b.woba)} · best slot ${b.best_slot}${b.rated ? '' : ' · thin sample'}`}>
                {b.player} <span className="text-gray-400">{b.eligible.length ? b.eligible.join('/') : 'DH'}</span>
              </button>
            ))}
            <button onClick={() => setSwapFor(null)} className="px-2 py-0.5 text-gray-400">cancel</button>
          </div>
          <p className="mt-1 text-gray-400">The order is re-optimized and positions re-assigned around the new nine. A hitter with no eligible position can only DH.</p>
        </div>
      )}
      <div className="mt-2 flex items-baseline gap-3 flex-wrap text-[11px]">
        <span><span className="text-gray-400">Simulated</span> <span className="font-bold tabular-nums text-sm">{lineup.runs_pg.toFixed(2)}</span> <span className="text-gray-400">runs / game</span></span>
        <span className="text-gray-400" title="The same nine sorted straight by wOBA, simulated the same way">straight wOBA order {lineup.naive_runs_pg.toFixed(2)}
          <span className={`ml-1 font-semibold ${edge > 0.02 ? 'text-emerald-600' : edge < -0.02 ? 'text-rose-600' : 'text-gray-400'}`}>({edge > 0 ? '+' : ''}{edge.toFixed(2)})</span></span>
        <span className="text-gray-400" title="Sum of slot fitness over the nine">fit {lineup.order_score.toFixed(0)}</span>
      </div>
      {lineup.bench.length > 0 && (
        <div className="mt-2">
          <div className="text-[9px] uppercase tracking-wide text-gray-400 mb-1">Bench</div>
          <div className="flex flex-wrap gap-1">
            {lineup.bench.slice(0, 8).map(b => (
              <span key={b.player} className={`text-[10px] px-2 py-0.5 rounded-full ring-1 ring-gray-200 dark:ring-gray-700 ${b.rated ? '' : 'text-gray-400'}`}
                title={`${b.eligible.length ? b.eligible.join('/') : 'DH only'} · best slot ${b.best_slot} · wOBA ${f3(b.woba)}${b.rated ? '' : ' · under 10 PA, projection is mostly the league prior'}`}>
                {b.player} <span className="text-gray-400">{f3(b.woba)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

function EligibilityEditor({ hitters, model, onSaved }) {
  const [edits, setEdits] = useState({})   // player -> {positions, available, note}
  const [busy, setBusy] = useState(null)
  const minP = model?.elig_min_pitches ?? 25

  function cur(h) {
    return edits[h.player] || { positions: h.eligible, available: h.available, note: h.note || '' }
  }
  function toggle(h, pos) {
    const c = cur(h)
    const positions = c.positions.includes(pos) ? c.positions.filter(p => p !== pos) : [...c.positions, pos]
    setEdits(e => ({ ...e, [h.player]: { ...c, positions } }))
  }
  function setAvail(h, v) { setEdits(e => ({ ...e, [h.player]: { ...cur(h), available: v } })) }
  function setNote(h, v) { setEdits(e => ({ ...e, [h.player]: { ...cur(h), note: v } })) }
  async function save(h) {
    const c = cur(h)
    setBusy(h.player)
    const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) }
    await fetch('/api/v1/trackman/lineup/eligibility', { method: 'PUT', headers,
      body: JSON.stringify({ player: h.player, positions: c.positions, available: c.available, note: c.note || null }) })
    setEdits(e => { const n = { ...e }; delete n[h.player]; return n })
    setBusy(null)
    onSaved()
  }
  async function reset(h) {
    setBusy(h.player)
    const headers = await authHeaders()
    await fetch(`/api/v1/trackman/lineup/eligibility/${encodeURIComponent(h.player)}`, { method: 'DELETE', headers })
    setEdits(e => { const n = { ...e }; delete n[h.player]; return n })
    setBusy(null)
    onSaved()
  }
  return (
    <Card title="Positions and availability" sub={`Auto read: ${minP}+ pitches at a spot in the positioning files (any season) or behind the plate. Click positions to override; a hitter with none can only DH.`}>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-[9px] uppercase tracking-wide text-gray-400">
              <th className="py-1 pr-2">Hitter</th><th className="py-1 pr-2 text-right">PA</th>
              <th className="py-1 pr-2">Eligible</th><th className="py-1 pr-2">Seen at (pitches)</th>
              <th className="py-1 pr-2">In lineup pool</th><th className="py-1 pr-2">Note</th><th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {hitters.map(h => {
              const c = cur(h)
              const dirty = !!edits[h.player]
              return (
                <tr key={h.player} className={!c.available ? 'opacity-60' : ''}>
                  <td className="py-1 pr-2 whitespace-nowrap font-semibold">{h.player}<span className="ml-1 text-[9px] text-gray-400">{sideTag(h.side)}</span>
                    {h.eligible_source === 'manual' && !dirty && <span className="ml-1 text-[9px] uppercase text-portal-purple dark:text-indigo-300" title="Coach override">set</span>}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-gray-500">{h.views.all.pa}{!h.rated && <span className="ml-0.5 text-rose-500" title="Under 10 PA: not picked automatically">*</span>}</td>
                  <td className="py-1 pr-2">
                    <div className="flex gap-0.5">
                      {POSITIONS.map(p => (
                        <button key={p} onClick={() => toggle(h, p)}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ring-1 ${c.positions.includes(p)
                            ? 'bg-portal-purple text-white ring-portal-purple' : 'text-gray-400 ring-gray-200 dark:ring-gray-700 hover:ring-portal-purple/60'}`}>{p}</button>
                      ))}
                    </div>
                  </td>
                  <td className="py-1 pr-2 text-[10px] text-gray-500 whitespace-nowrap">
                    {Object.entries(h.auto_positions || {}).map(([p, n]) => `${p} ${n}`).join(' · ') || '—'}
                  </td>
                  <td className="py-1 pr-2">
                    <label className="inline-flex items-center gap-1 text-[11px]">
                      <input type="checkbox" checked={c.available} onChange={e => setAvail(h, e.target.checked)} /> available
                    </label>
                  </td>
                  <td className="py-1 pr-2">
                    <input value={c.note} onChange={e => setNote(h, e.target.value)} placeholder="hurt, pitcher only…"
                      className="w-32 rounded border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-1.5 py-0.5 text-[11px]" />
                  </td>
                  <td className="py-1 whitespace-nowrap text-right">
                    {dirty && <button disabled={busy === h.player} onClick={() => save(h)} className="text-[10px] font-semibold text-white bg-portal-purple rounded px-2 py-0.5 mr-1 disabled:opacity-50">save</button>}
                    {h.eligible_source === 'manual' && <button disabled={busy === h.player} onClick={() => reset(h)} className="text-[10px] font-semibold text-gray-400 hover:text-rose-600 disabled:opacity-50">back to auto</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function ProjectionTable({ hitters }) {
  const [open, setOpen] = useState(false)
  return (
    <Card title="Hitter projections" sub="What the optimizer sees: season view, then vs RHP and vs LHP"
      right={<button onClick={() => setOpen(v => !v)} className="text-[11px] font-semibold text-portal-purple dark:text-indigo-300">{open ? 'hide' : 'show'}</button>}>
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[9px] uppercase tracking-wide text-gray-400">
                <th className="py-1 pr-2">Hitter</th>
                <th className="py-1 px-1 text-right">PA</th><th className="py-1 px-1 text-right">Pitches</th><th className="py-1 px-1 text-right">BBE</th>
                <th className="py-1 px-1 text-right" title="Projected season wOBA">wOBA</th>
                <th className="py-1 px-1 text-right">OBP</th><th className="py-1 px-1 text-right">SLG</th>
                <th className="py-1 px-1 text-right" title="Projected K% (observed K% in grey, pitch-level expected K% from whiff/chase/zone contact)">K%</th>
                <th className="py-1 px-1 text-right" title="Projected BB% (observed, pitch-level expected)">BB%</th>
                <th className="py-1 px-1 text-right">Whiff</th><th className="py-1 px-1 text-right">Chase</th>
                <th className="py-1 px-1 text-right">GB%</th><th className="py-1 px-1 text-right">SD+</th>
                <th className="py-1 px-1 text-right" title="Average exit velocity">EV</th>
                <th className="py-1 px-1 text-right" title="wOBA vs RHP (PA seen)">vs R</th>
                <th className="py-1 px-1 text-right" title="wOBA vs LHP (PA seen)">vs L</th>
                <th className="py-1 px-1 text-right" title="Platoon gap used: prior split for his side updated by run value per pitch vs each hand, as % of wOBA (weight = how much the pitch evidence moved it)">Gap</th>
                <th className="py-1 px-1 text-right" title="Within-team speed z from the steal log (0 when none)">Spd</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {hitters.map(h => {
                const v = h.views.all, r = h.views.R, l = h.views.L, p = h.platoon
                return (
                  <tr key={h.player} className={!h.available ? 'opacity-50' : ''}>
                    <td className="py-1 pr-2 whitespace-nowrap font-semibold">{h.player}<span className="ml-1 text-[9px] text-gray-400">{sideTag(h.side)}</span></td>
                    <td className="py-1 px-1 text-right tabular-nums text-gray-500">{v.pa}</td>
                    <td className="py-1 px-1 text-right tabular-nums text-gray-500">{v.pitches}</td>
                    <td className="py-1 px-1 text-right tabular-nums text-gray-500">{v.bbe}</td>
                    <td className="py-1 px-1 text-right tabular-nums font-bold">{f3(v.woba)}</td>
                    <td className="py-1 px-1 text-right tabular-nums">{f3(v.obp)}</td>
                    <td className="py-1 px-1 text-right tabular-nums">{f3(v.slg)}</td>
                    <td className="py-1 px-1 text-right tabular-nums">{f1(v.k_pct)}<span className="ml-1 text-[9px] text-gray-400">{f1(v.xk_pitch)}</span></td>
                    <td className="py-1 px-1 text-right tabular-nums">{f1(v.bb_pct)}<span className="ml-1 text-[9px] text-gray-400">{f1(v.xbb_pitch)}</span></td>
                    <td className="py-1 px-1 text-right tabular-nums">{f1(v.whiff_pct)}</td>
                    <td className="py-1 px-1 text-right tabular-nums">{f1(v.chase_pct)}</td>
                    <td className="py-1 px-1 text-right tabular-nums">{f1(v.gb_pct)}</td>
                    <td className="py-1 px-1 text-right tabular-nums">{v.sd_plus ?? '—'}</td>
                    <td className="py-1 px-1 text-right tabular-nums">{v.avg_ev ?? '—'}</td>
                    <td className="py-1 px-1 text-right tabular-nums">{f3(r.woba)}<span className="ml-1 text-[9px] text-gray-400">{r.obs_pa}</span></td>
                    <td className="py-1 px-1 text-right tabular-nums">{f3(l.woba)}<span className="ml-1 text-[9px] text-gray-400">{l.obs_pa}</span></td>
                    <td className="py-1 px-1 text-right tabular-nums text-gray-500">{p?.gap_hat != null ? `${(100 * p.gap_hat).toFixed(1)}%` : '—'}<span className="ml-1 text-[9px] text-gray-400">w{p?.weight != null ? (100 * p.weight).toFixed(0) : 0}</span></td>
                    <td className="py-1 px-1 text-right tabular-nums text-gray-500">{h.speed_z?.toFixed(1)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] text-gray-400">Grey numbers: next to K% and BB% the pitch-level expected rate; next to vs R / vs L the plate appearances actually seen against that hand; next to Gap how far the pitch evidence moved the published platoon prior (0 = all prior).</p>
        </div>
      )}
    </Card>
  )
}

function ModelCard({ model }) {
  const lg = model?.league || {}
  const kf = model?.k_fit, bf = model?.bb_fit
  const coef = f => f ? Object.entries(f.coef).filter(([k]) => k !== 'intercept').map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v.toFixed(2)}`).join(', ') : 'not fit (corpus too thin)'
  return (
    <Card title="How the model works">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px] text-gray-600 dark:text-gray-300">
        <div className="space-y-1.5">
          <p><b>Corpus.</b> {model.corpus_pitches?.toLocaleString()} live pitches, {model.corpus_hitters} hitters (own and every opponent). League prior from games and scrimmages: wOBA {f3(lg.woba)}, OBP {f3(lg.obp)}, SLG {f3(lg.slg)}, K {f1(100 * lg.k)}%, BB {f1(100 * lg.bb)}%, HBP {f1(100 * lg.hbp)}%.</p>
          <p><b>Recency.</b> Every pitch weighted by half-life {model.half_life_weeks} weeks with a 0.15 floor; intrasquad PAs count 0.6 (own arms, 21% walks in the corpus).</p>
          <p><b>Expected production.</b> Each ball in play is credited with its xBA, xTB and xwOBAcon from exit velocity, launch angle and direction, shrunk toward the league per-batted-ball means with a 60-BBE prior; actual results blended in at 25%. Hit shape (1B/2B/3B/HR) comes from the barrel geometry of each ball.</p>
          <p><b>K and BB.</b> Observed rates shrink toward a prior (60 and 120 PA) that is itself the pitch-level prediction. K fit: {kf ? `${coef(kf)} (r² ${kf.r2}, ${kf.n} hitters)` : coef(null)}. BB fit: {bf ? `${coef(bf)} (r² ${bf.r2}, ${bf.n} hitters)` : coef(null)}.</p>
        </div>
        <div className="space-y-1.5">
          <p><b>Platoon.</b> Prior gap between facing opposite- and same-side pitching: RHB {(100 * (model.platoon_gap?.R ?? 0)).toFixed(1)}% of wOBA, LHB {(100 * (model.platoon_gap?.L ?? 0)).toFixed(1)}%, switch 0. Updated by run value per pitch against each hand (every pitch counts, not just the PA) with a 600-pitch prior, so a fall of 12 PA vs lefties moves the prior a little, never flips it. OBP moves 0.6x the gap, SLG 1.2x, K 1.5x the other way.</p>
          <p><b>Slot fitness.</b> The Book's slot weights (OBP, SLG, ISO at 4 and 5, BB, K, contact at 2 and 8, ground balls at 2 and 3, speed at 1, 2 and 9), plus TrackMan terms: SD+ above 100 is worth most at 1, 2 and 9; two-strike contact at 2 and 3. Starters are chosen by best-slot fitness under position eligibility (DH open to all), then the order is solved exactly (assignment DP).</p>
          <p><b>Runs per game.</b> 3,000 nine-inning Monte Carlo games per card from each hitter's outcome distribution with standard runner advancement and ground-ball double plays. The gap to a straight wOBA sort is real but small: lineup order is worth a few runs a season, the nine you pick is worth far more.</p>
          <p><b>Speed.</b> From the steal log in the Baserunning tool (SB, CS per time on first) plus triples; 0 for everyone when no steals are logged.{model.sd_model ? '' : ' SD+ unavailable: the swing-decision model needs 300+ live pitches.'}</p>
        </div>
      </div>
    </Card>
  )
}
