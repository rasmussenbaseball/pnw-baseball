// Catcher Defense Lab — advanced catcher defensive value for the whole PNW,
// from box-score + play-by-play data (no pitch tracking).
//
// Total Defense = Framing + Throwing + Blocking runs vs average.
// Framing comes from a CSAA model over every TAKEN pitch in the season PBP
// (count/outs/home context + shrunk pitcher & batter adjustments), with
// empirical-Bayes shrinkage sized to measured split-half reliability.
// Throwing and blocking are regressed hard toward league because the box
// score can't separate the catcher from his staff. The model runs offline;
// this page renders its baked payload from /api/v1/catcher-defense and
// ports the prototype's QA guards (cs>sba sanitizer, pitches-per-inning
// checks, PB-rate and SBA-undercount flags) verbatim.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApi } from '../hooks/useApi'

// throwing/blocking constants (see methodology): run values + talent priors
const RV_THROW = 0.45, RV_BLOCK = 0.28, TAU_CS = 0.05, TAU_PB = 0.015
const PB_MAX = 0.2, SBA_LOW = 0.25, SBA_ABS_MAX = 4

// 5-tier quintile colors, best -> worst (legible on light and dark)
const TCOL = ['#059669', '#65a30d', '#d97706', '#ea580c', '#dc2626']
const BADGE = {
  D1: 'bg-rose-600 text-white', D2: 'bg-amber-500 text-gray-900', D3: 'bg-green-600 text-white',
  NAIA: 'bg-violet-600 text-white', NWAC: 'bg-sky-500 text-white',
}
const INFO = {
  totalDef: 'Total Defense: framing + throwing + blocking runs vs average. Framing is isolated from the pitcher and carries the most weight; throwing and blocking also depend on the staff and opponents, so they are regressed harder. Passed balls only; wild pitches are the pitcher\'s.',
  framing: 'Framing Runs: runs saved by turning borderline takes into called strikes vs an average catcher, at a college-scaled run value of about 0.14 per strike.',
  throwRuns: 'Throwing Runs: caught stealings vs an average catcher on the same attempts (0.45 runs per steal erased), regressed hard because CS% mostly reflects the pitching staff.',
  blockRuns: 'Blocking Runs: passed balls vs average, regressed hard (0.28 runs each). Wild pitches are charged to the pitcher.',
  frm_score: 'Framing Score: in-division framing percentile on a 1-10 scale. 5.0 = the median catcher in his own division, 7.9 = 79th percentile. Pure rank, no standard deviations.',
  csaa: 'Strikes Added %: how much this catcher raises the called-strike probability on an average taken pitch, vs an average catcher.',
}
const fmtPos = (v) => {
  const n = +v
  if (Math.abs(n) < 0.05) return String(v).includes('.') ? '0.0' : '0'
  return (n > 0 ? '+' : '') + v
}
// total shown as the sum of the DISPLAYED 1-decimal components so parts add up
const sumTD = (r) => (+r.framing.toFixed(1) + +r.throwRuns.toFixed(1) + +r.blockRuns.toFixed(1)).toFixed(1)

function buildRows(data) {
  const M = data.meta
  const RVS = M.run_value_scaled
  const rows = data.catchers.map(r => ({ ...r }))
  // QA: cs > sba means the throwing data is invalid — null it
  rows.forEach(r => {
    if (r.cs != null && r.cs > 0 && (r.sba == null || r.cs > r.sba)) { r.cs = null; r.sba = null }
    r.cs_pct = (r.sba != null && r.sba > 0 && r.cs != null && r.cs <= r.sba) ? r.cs / r.sba : null
    r._qual = r.taken_pitches_received >= 400 ? 'qualified' : 'partial'
    r._ppiBad = r.innings > 0
      ? (r.taken_pitches_received / r.innings < 3.0 || r.taken_pitches_received / r.innings > 12.0)
      : false
  })
  const QUAL = rows.filter(r => r._qual === 'qualified')

  // league rates (undercounted / flagged rows excluded so they can't move baselines)
  let s = 0, i = 0
  QUAL.forEach(r => { if (r.sba != null && r.innings > 0) { s += r.sba; i += r.innings } })
  const lgSbaRate = i > 0 ? s / i : 0
  const sbaLowOf = r => (r.sba != null && r.innings > 0 && r.sba <= SBA_ABS_MAX
    && r.sba < r.innings * lgSbaRate * SBA_LOW)
  let c = 0, sa = 0
  QUAL.forEach(r => { if (r.sba > 0 && r.cs != null && !sbaLowOf(r)) { c += r.cs; sa += r.sba } })
  const lgCSrate = sa > 0 ? c / sa : 0
  let p = 0, inn = 0
  QUAL.forEach(r => { if (r.innings > 0 && r.pb != null && r.pb / r.innings <= PB_MAX) { p += r.pb; inn += r.innings } })
  const lgPBrate = inn > 0 ? p / inn : 0
  const regress = (k, n, lg, tau) => {
    if (!(n > 0)) return 0
    const pr = k / n, sv = lg * (1 - lg) / n, f = tau * tau / (tau * tau + sv)
    return (lg + (pr - lg) * f) * n
  }
  rows.forEach(r => {
    r.framing = (r.cfr == null || !Number.isFinite(r.cfr)) ? 0 : r.cfr / 0.125 * RVS
    r._sbaLow = sbaLowOf(r)
    r.throwRuns = (r._sbaLow || !(r.sba > 0 && r.cs != null)) ? 0
      : (regress(r.cs, r.sba, lgCSrate, TAU_CS) - lgCSrate * r.sba) * RV_THROW
    r._pbFlagged = (r.pb != null && r.innings > 0 && r.pb / r.innings > PB_MAX)
    r.blockRuns = r._pbFlagged ? 0
      : ((r.pb != null && r.innings > 0)
        ? (lgPBrate * r.innings - regress(r.pb, r.innings, lgPBrate, TAU_PB)) * RV_BLOCK : 0)
    for (const k of ['framing', 'throwRuns', 'blockRuns']) if (!Number.isFinite(r[k])) r[k] = 0
    r.totalDef = r.framing + r.throwRuns + r.blockRuns
  })
  // Framing Score: in-division percentile of CSAA on a 1-10 scale
  const byDiv = {}
  QUAL.forEach(r => { (byDiv[r.level] = byDiv[r.level] || []).push(r.csaa) })
  rows.forEach(r => {
    const peers = byDiv[r.level]
    if (peers && peers.length) {
      let less = 0, eq = 0
      for (const x of peers) { if (x < r.csaa) less++; else if (x === r.csaa) eq++ }
      r.frm_score = Math.round((less + eq / 2) / peers.length * 100) / 10
    } else r.frm_score = 5.0
  })
  // quintile tiers over qualified, ppi-clean rows only
  const pop = QUAL.filter(r => !r._ppiBad)
  const sorted = {}
  ;['totalDef', 'framing', 'throwRuns', 'blockRuns', 'frm_score'].forEach(k =>
    sorted[k] = pop.map(r => r[k]).slice().sort((a, b) => a - b))
  const tier = (key, v) => {
    const a = sorted[key], n = a.length
    if (!n) return 2
    let less = 0, eq = 0
    for (const x of a) { if (x < v) less++; else if (x === v) eq++ }
    const pr = (less + eq / 2) / n
    return pr >= 0.8 ? 0 : pr >= 0.6 ? 1 : pr >= 0.4 ? 2 : pr >= 0.2 ? 3 : 4
  }
  return { rows, QUAL, tier, RVS }
}

function Tv({ tier, k, v, disp, r }) {
  const dim = r && (r._qual !== 'qualified' || r._ppiBad)
  const t = dim ? 2 : tier(k, v)
  const car = dim ? '' : t === 0 ? '▲ ' : t === 4 ? '▽ ' : ''
  return <span className="font-bold tabular-nums" style={{ color: dim ? '#9ca3af' : TCOL[t] }}>{car}{disp}</span>
}

const bandColor = (v) => {
  if (v == null) return 'rgba(107,114,128,0.08)'
  const t = Math.max(-1, Math.min(1, v / 5))
  return t >= 0 ? `rgba(5,150,105,${(0.10 + 0.5 * t).toFixed(2)})` : `rgba(220,38,38,${(0.10 - 0.5 * t).toFixed(2)})`
}

const BANDS = [
  ['two_strike', 'Two strikes', 'battles with 2 strikes'],
  ['three_ball', 'Three balls', '3-ball counts'],
  ['ahead', 'Ahead in count', 'pitcher ahead'],
  ['behind_even', 'Behind or even', 'behind or even counts'],
]

function Profile({ r, meta, tier, RVS }) {
  if (!r) return (
    <div className="p-10 text-center text-sm text-gray-400">Select a catcher to open his defensive profile.</div>
  )
  const LG = meta.league_csr
  const bandShrink = (v, n) => v * (meta.tau2 / (meta.tau2 + LG * (1 - LG) / n))
  const maxAbs = Math.max(Math.abs(r.framing), Math.abs(r.throwRuns), Math.abs(r.blockRuns), 0.5)
  const lowFr = r.eb_shrink < 0.5
  const lowTh = (r._sbaLow || r.sba == null || r.sba < 20 || Math.abs(r.throwRuns) < 1.0)
  const lowBl = (r._pbFlagged || Math.abs(r.blockRuns) < 1.0)
  const fLo = (r.cfr_ci ? r.cfr_ci[0] : 0) / 0.125 * RVS
  const fHi = (r.cfr_ci ? r.cfr_ci[1] : 0) / 0.125 * RVS
  const spansZero = fLo < 0 && fHi > 0
  const kpi = (lab, val, unit, key, raw, tip) => {
    const col = TCOL[tier(key, raw)]
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg bg-gray-50 dark:bg-gray-900/40 border-l-4 px-3 py-2" style={{ borderLeftColor: col }} title={tip}>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{lab}</div>
          <div className="text-[9px] text-gray-400">{unit}</div>
        </div>
        <div className="text-2xl font-black tabular-nums" style={{ color: col }}>{val}</div>
      </div>
    )
  }
  const comp = (lab, val, low) => {
    const pct = Math.min(50, Math.abs(val) / maxAbs * 50), pos = val >= 0
    const col = pos ? TCOL[0] : TCOL[4]
    return (
      <div className={`grid grid-cols-[64px,1fr,52px] items-center gap-2 mb-1 ${low ? 'opacity-45' : ''}`}
        title={low ? 'low confidence, within sample noise' : undefined}>
        <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{lab}</div>
        <div className="relative h-3 rounded-md bg-gray-100 dark:bg-gray-900/60 border border-gray-200 dark:border-gray-700">
          <div className="absolute top-0 bottom-0 left-1/2 w-px bg-gray-300 dark:bg-gray-600" />
          <div className="absolute top-px bottom-px rounded" style={{
            [pos ? 'left' : 'right']: '50%', width: `${pct}%`, background: col }} />
        </div>
        <div className="text-[12px] font-bold text-right tabular-nums" style={{ color: col }}>
          {low ? <span className="text-amber-500 mr-0.5">±</span> : null}{fmtPos(val.toFixed(1))}
        </div>
      </div>
    )
  }
  return (
    <div>
      <div className="px-4 pt-4 pb-3 border-b border-gray-100 dark:border-gray-700 text-center">
        {r.logo && <img src={r.logo} alt="" className="w-12 h-12 object-contain mx-auto mb-1.5"
          onError={e => { e.target.style.display = 'none' }} />}
        <div className="text-lg font-black text-gray-900 dark:text-gray-100">
          {r.name}{r._qual === 'partial' && <span className="ml-2 text-[9px] font-bold uppercase text-amber-600 border border-amber-400 rounded px-1">partial</span>}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{r.team}, {r.conference || r.level}{r.year ? `, ${r.year}` : ''}</div>
        <span className={`inline-block mt-1.5 text-[10px] font-extrabold px-2.5 py-0.5 rounded-full ${BADGE[r.level] || 'bg-gray-500 text-white'}`}>{r.level}</span>
      </div>
      <div className="p-3 space-y-1.5">
        {kpi('Total Defense', fmtPos(sumTD(r)), 'runs vs avg', 'totalDef', r.totalDef, INFO.totalDef)}
        {kpi('Framing Score', r.frm_score.toFixed(1), 'of 10, in division', 'frm_score', r.frm_score, INFO.frm_score)}
        {kpi('Framing Runs', fmtPos(r.framing.toFixed(1)), 'runs saved', 'framing', r.framing, INFO.framing)}
      </div>
      <p className="px-4 text-[10px] text-gray-400 leading-snug">
        Season framing split-half reliability is about 0.40; treat gaps under about 1 run as noise.
      </p>
      <div className="px-4 pt-2 pb-3">
        <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">Defense breakdown</div>
        {comp('Framing', r.framing, lowFr)}
        {comp('Throwing', r.throwRuns, lowTh)}
        {comp('Blocking', r.blockRuns, lowBl)}
        <p className="text-[10px] text-gray-400 leading-snug mt-1">
          Framing 90% interval (bootstrap): {fmtPos(fLo.toFixed(1))} to {fmtPos(fHi.toFixed(1))} runs
          {spansZero && <span className="text-amber-600"> (spans zero, not clearly above average)</span>}.
          Faded components are within sample noise.
        </p>
        {r._ppiBad && <p className="text-[10px] text-amber-600 mt-1">Pitch count looks off ({(r.taken_pitches_received / r.innings).toFixed(1)}/inn), framing may be unreliable.</p>}
        {r._pbFlagged && <p className="text-[10px] text-amber-600 mt-1">PB rate flagged, blocking excluded from Total Defense.</p>}
        {r._sbaLow && <p className="text-[10px] text-amber-600 mt-1">Stolen-base attempts look undercounted, throwing excluded from Total Defense.</p>}
      </div>
      <div className="px-4 pb-3">
        <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Framing by count leverage</div>
        <p className="text-[10px] text-gray-400 leading-snug mb-1.5">
          Strikes added per pitch within each situation, shrunk by sample size. Buckets overlap
          and do not add to a total; thin samples show n/a. Green gained, red lost.
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {BANDS.map(([k, lab, desc]) => {
            const v = r.count_bands?.[k], n = (r.count_bands_n || {})[k] || 0
            const thin = (v == null || n < 50)
            const vs = thin ? null : bandShrink(v, n)
            return (
              <div key={k} className="rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-2"
                style={{ background: bandColor(vs) }}>
                <div className="text-[9px] font-bold uppercase tracking-wide text-gray-600 dark:text-gray-300">{lab}</div>
                <div className="text-base font-extrabold tabular-nums text-gray-900 dark:text-gray-100">{thin ? 'n/a' : fmtPos(vs.toFixed(1)) + '%'}</div>
                <div className="text-[9px] text-gray-400">{thin ? 'thin sample' : desc}</div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="px-4 pb-4 flex flex-wrap gap-1.5">
        {[
          ['Strikes Added', fmtPos((100 * r.csaa).toFixed(2)) + '%', INFO.csaa],
          ['Innings', r.innings], ['Games', r.games],
          ['Sample confidence', (100 * r.eb_shrink).toFixed(0) + '%'],
          ['Passed balls', r.pb == null ? 'n/a' : `${r.pb}${r._pbFlagged ? ' (flagged)' : ''}`],
          ['Caught stealing', r.sba == null ? 'n/a'
            : r._sbaLow ? `${r.cs}/${r.sba} (undercounted)`
              : `${r.cs_pct != null ? (100 * r.cs_pct).toFixed(0) + '%' : 'n/a'} (${r.cs}/${r.sba})`],
        ].map(([lab, val, tip]) => (
          <span key={lab} title={tip}
            className="text-[11px] rounded-md bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-700 px-2 py-1 text-gray-500 dark:text-gray-400">
            {lab} <b className="text-gray-900 dark:text-gray-100">{val}</b>
          </span>
        ))}
      </div>
    </div>
  )
}

const COLS = [
  ['Total Defense', 'totalDef', INFO.totalDef], ['Framing Runs', 'framing', INFO.framing],
  ['Throwing', 'throwRuns', INFO.throwRuns], ['Blocking', 'blockRuns', INFO.blockRuns],
  ['Framing Score', 'frm_score', INFO.frm_score],
]

export default function CatcherDefense() {
  const { data, loading } = useApi('/catcher-defense')
  const built = useMemo(() => (data ? buildRows(data) : null), [data])
  const [tab, setTab] = useState('board')
  const [lvl, setLvl] = useState('')
  const [team, setTeam] = useState('')
  const [q, setQ] = useState('')
  const [minP, setMinP] = useState(0)
  const [sortK, setSortK] = useState('totalDef')
  const [sortD, setSortD] = useState(-1)
  const [selId, setSelId] = useState(null)
  const [scatterY, setScatterY] = useState('totalDef')
  const profRef = useRef(null)

  const rows = built?.rows || []
  const meta = data?.meta
  const maxPitches = useMemo(() => Math.max(1000, ...rows.map(r => r.taken_pitches_received)), [rows])
  const levels = useMemo(() => [...new Set(rows.map(r => r.level))].filter(Boolean).sort(), [rows])
  const teams = useMemo(() => [...new Set(rows.map(r => r.team))].filter(Boolean).sort(), [rows])

  const shown = useMemo(() => {
    const ql = q.toLowerCase()
    return rows
      .filter(r => r._qual === 'qualified' && (!lvl || r.level === lvl) && (!team || r.team === team)
        && r.taken_pitches_received >= minP
        && (!ql || (r.name + ' ' + r.team).toLowerCase().includes(ql)))
      .sort((a, b) => {
        let x = a[sortK] ?? -1e9, y = b[sortK] ?? -1e9
        return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sortD
      })
  }, [rows, lvl, team, q, minP, sortK, sortD])

  const sel = rows.find(r => r.catcher_id === selId) || null
  useEffect(() => {
    if (!selId && built) {
      const first = built.QUAL.slice().sort((a, b) => b.totalDef - a.totalDef)[0]
      if (first) setSelId(first.catcher_id)
    }
  }, [built, selId])

  const pick = (id) => {
    setSelId(id)
    if (window.matchMedia('(max-width: 1023px)').matches) {
      profRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }
  const clickSort = (k) => {
    if (sortK === k) setSortD(d => -d)
    else { setSortK(k); setSortD(k === 'name' ? 1 : -1) }
  }

  const tdLeader = built?.QUAL.slice().sort((a, b) => b.totalDef - a.totalDef)[0]

  if (loading || !built) return <div className="max-w-7xl mx-auto px-4 py-16 text-center text-gray-400">Loading catcher defense…</div>

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-5 py-6">
      <div className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-amber-500">Advanced defense</div>
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mt-0.5">Catcher Defense Lab</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-3xl">
        Framing, throwing, and blocking runs for every PNW catcher, modeled from {meta.n_pitches.toLocaleString()} taken
        pitches in the season play-by-play. No pitch tracking exists at this level, so the model works from counts,
        situations, and shrunk pitcher and batter adjustments, with honest uncertainty shown everywhere.
      </p>

      <div className="flex flex-wrap gap-2 mt-3">
        {[
          ['Total Defense leader', tdLeader ? `${tdLeader.name} (${fmtPos(sumTD(tdLeader))})` : 'n/a'],
          ['Taken pitches modeled', meta.n_pitches.toLocaleString()],
          ['Catchers', rows.length],
          ['Qualified (400+ pitches)', built.QUAL.length],
          ['Season', meta.season],
        ].map(([lab, val]) => (
          <span key={lab} className="rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-[11px] text-gray-500 dark:text-gray-400">
            {lab}<b className="block text-[13px] text-gray-900 dark:text-gray-100">{val}</b>
          </span>
        ))}
      </div>

      <div className="flex gap-1 mt-4 border-b border-gray-200 dark:border-gray-700">
        {[['board', 'Leaderboard'], ['scatter', 'Volume vs Value']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px ${tab === k
              ? 'border-nw-teal text-nw-teal dark:text-teal-300 dark:border-teal-300'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'board' && (
        <div className="grid lg:grid-cols-[minmax(0,1fr),330px] gap-4 mt-4 items-start">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <select value={lvl} onChange={e => setLvl(e.target.value)}
                className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1.5 text-sm">
                <option value="">All levels</option>
                {levels.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
              <select value={team} onChange={e => setTeam(e.target.value)}
                className="rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-2 py-1.5 text-sm">
                <option value="">All teams</option>
                {teams.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search catcher or team"
                className="flex-1 min-w-[140px] rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-900 px-3 py-1.5 text-sm" />
              <label className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400 rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5">
                Min pitches
                <input type="range" min="0" max={maxPitches} step="50" value={minP}
                  onChange={e => setMinP(+e.target.value)} className="accent-nw-teal" />
                <b className="tabular-nums text-gray-900 dark:text-gray-100 w-9 text-right">{minP}</b>
              </label>
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
              <table className="w-full text-[13px] min-w-[640px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400 border-b border-gray-100 dark:border-gray-700">
                    <th className="px-3 py-2 w-8">#</th>
                    <th className="px-2 py-2 cursor-pointer" onClick={() => clickSort('name')}>Player</th>
                    <th className="px-2 py-2">Team</th>
                    <th className="px-2 py-2">Level</th>
                    <th className="px-2 py-2 text-right cursor-pointer" onClick={() => clickSort('innings')}>Inn</th>
                    {COLS.map(([lab, k, tip]) => (
                      <th key={k} className={`px-2 py-2 text-right cursor-pointer whitespace-nowrap ${sortK === k ? 'text-nw-teal dark:text-teal-300' : ''}`}
                        title={tip} onClick={() => clickSort(k)}>
                        {lab}{sortK === k ? (sortD > 0 ? ' ▲' : ' ▼') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                  {shown.length === 0 && (
                    <tr><td colSpan={9} className="p-8 text-center text-gray-400">No catchers match these filters.</td></tr>
                  )}
                  {shown.map((r, i) => (
                    <tr key={r.catcher_id} onClick={() => pick(r.catcher_id)}
                      className={`cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 ${r.catcher_id === selId ? 'bg-teal-50 dark:bg-teal-900/20' : ''}`}>
                      <td className="px-3 py-1.5 text-gray-400 tabular-nums">{i + 1}</td>
                      <td className="px-2 py-1.5 font-semibold whitespace-nowrap text-gray-900 dark:text-gray-100">
                        {r.name}{r.year && <span className="ml-1.5 text-[10px] font-normal text-gray-400">{r.year}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">{r.team}</td>
                      <td className="px-2 py-1.5"><span className={`text-[9px] font-extrabold px-2 py-0.5 rounded-full ${BADGE[r.level] || 'bg-gray-500 text-white'}`}>{r.level}</span></td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{r.innings}</td>
                      <td className="px-2 py-1.5 text-right"><Tv tier={built.tier} k="totalDef" v={r.totalDef} disp={fmtPos(sumTD(r))} r={r} /></td>
                      <td className="px-2 py-1.5 text-right"><Tv tier={built.tier} k="framing" v={r.framing} disp={fmtPos(r.framing.toFixed(1))} r={r} /></td>
                      <td className="px-2 py-1.5 text-right"><Tv tier={built.tier} k="throwRuns" v={r.throwRuns} disp={fmtPos(r.throwRuns.toFixed(1))} r={r} /></td>
                      <td className="px-2 py-1.5 text-right"><Tv tier={built.tier} k="blockRuns" v={r.blockRuns} disp={fmtPos(r.blockRuns.toFixed(1))} r={r} /></td>
                      <td className="px-2 py-1.5 text-right"><Tv tier={built.tier} k="frm_score" v={r.frm_score} disp={r.frm_score.toFixed(1)} r={r} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-gray-400 mt-1.5">
              ▲ = top 20% of qualified catchers, ▽ = bottom 20%. Colors run green (best) to red (worst) in quintiles.
              Click any column to sort; click a row for the full profile.
            </p>
          </div>

          <div ref={profRef} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            <Profile r={sel} meta={meta} tier={built.tier} RVS={built.RVS} />
          </div>
        </div>
      )}

      {tab === 'scatter' && (
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-2 text-[12px]">
            <span className="text-gray-400">Y axis:</span>
            {[['totalDef', 'Total Defense'], ['framing', 'Framing only']].map(([k, label]) => (
              <button key={k} onClick={() => setScatterY(k)}
                className={`px-3 py-1 rounded-lg text-sm font-semibold ${scatterY === k
                  ? 'bg-nw-teal text-white' : 'bg-white dark:bg-gray-800 text-gray-500 border border-gray-200 dark:border-gray-700'}`}>
                {label}
              </button>
            ))}
            <span className="ml-3 text-[11px] text-gray-400 flex items-center gap-1">
              Framing tier: best {TCOL.map(c => <span key={c} className="inline-block w-3.5 h-3 rounded-sm" style={{ background: c }} />)} worst
              · dot size = sample reliability
            </span>
          </div>
          <Scatter rows={shown} scatterY={scatterY} tier={built.tier} onPick={(id) => { setTab('board'); pick(id) }} />
        </div>
      )}

      <details className="mt-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 px-5 max-w-4xl">
        <summary className="cursor-pointer py-4 font-bold text-gray-900 dark:text-gray-100">How the model works</summary>
        <div className="pb-5 text-sm text-gray-600 dark:text-gray-300 leading-relaxed space-y-3">
          <div><b className="text-gray-900 dark:text-gray-100">1. Modeling every taken pitch.</b> There is no ball tracking at this level, so every taken pitch (called ball or called strike) goes into a model of the chance it is called a strike, using the count, outs, and home team, plus shrunk pitcher and batter adjustments. The pitcher adjustment leaves out the catcher being rated, so a personal catcher cannot inflate his own baseline.</div>
          <div><b className="text-gray-900 dark:text-gray-100">2. Isolating the catcher.</b> Framing is the gap between actual and expected called strikes, regressed toward zero by sample size (empirical Bayes). A game-level split-half test shows about half the raw framing spread repeats as real skill; the rest is umpire and zone noise, and the shrinkage is sized to match. What survives is genuinely larger per inning than an MLB catcher because college zones are looser. The model separates strikes from balls with an AUC of {meta.auc.toFixed(3)}. College PBP does not record the umpire, so umpire tendencies cannot be removed the way a pro model would.</div>
          <div><b className="text-gray-900 dark:text-gray-100">3. Framing in runs and on a curve.</b> Strikes Added % is the skill per pitch; Framing Score ranks it within the catcher's own division on a 1-10 scale (pure percentile); Framing Runs multiply extra strikes by a college-scaled run value of about 0.14 per strike (provisional 1.15x the MLB 0.125 for the hotter run environment). A count-weighted version tested LESS repeatable than the season average, so it is deliberately not published.</div>
          <div><b className="text-gray-900 dark:text-gray-100">4. Throwing and blocking.</b> Caught-stealing rate and passed balls are not clean catcher skills; they also carry the pitcher's delivery time and the opponents. The raw CS% spread here (13 points) is far bigger than real arm talent, so both are regressed toward league with research-informed talent spreads (about 5 points for arms, less for blocking), at 0.45 runs per steal erased and 0.28 per passed ball avoided. Wild pitches belong to the pitcher and are excluded. Framing is the largest, most reliable piece; Total Defense is the sum of the three.</div>
          <div><b className="text-gray-900 dark:text-gray-100">5. Qualifying and QA.</b> Catchers with 400+ taken pitches qualify and set the color tiers. Rows with impossible data (caught stealings exceeding attempts, passed-ball rates only a data error produces, stolen-base attempts far below what innings imply, pitch counts that disagree with innings) are flagged, and the affected component is excluded from Total Defense rather than silently trusted.</div>
          <div><b className="text-gray-900 dark:text-gray-100">6. What this model cannot do.</b> No pitch locations means no spatial zone model and no per-edge maps; no umpire IDs means umpire bias is measured only in aggregate; no pitch types means a catcher with an erratic staff can look worse than he is. Every framing number carries a bootstrap interval; treat one that spans zero as not distinguishable from average.</div>
        </div>
      </details>

      <p className="text-[11px] text-gray-400 mt-4 max-w-3xl leading-relaxed">
        Total Defense combines framing, throwing and blocking runs from box-score and play-by-play data,
        with no pitch tracking. Data from nwbaseballstats.com, {meta.season}.
      </p>
    </div>
  )
}

function Scatter({ rows, scatterY, tier, onPick }) {
  const W = 1180, H = 500, L = 64, R = 22, T = 18, B = 46
  if (!rows.length) return <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-12 text-center text-gray-400">No catchers match these filters.</div>
  const x1 = Math.max(...rows.map(r => r.taken_pitches_received)) * 1.05
  const yM = Math.max(Math.max(...rows.map(r => Math.abs(r[scatterY]))), 1) * 1.15
  const X = v => L + v / x1 * (W - L - R)
  const Y = v => T + (yM - v) / (2 * yM) * (H - T - B)
  const yt = Math.ceil(yM), step = yt > 6 ? Math.ceil(yt / 5) : 1
  const gridY = []
  for (let v = -yt; v <= yt; v += step) gridY.push(v)
  const xs = x1 > 2000 ? 500 : 200
  const gridX = []
  for (let v = xs; v < x1; v += xs) gridX.push(v)
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label="Scatter: taken pitches vs defensive runs, one dot per catcher">
        {gridY.map(v => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="currentColor"
              className={v === 0 ? 'text-gray-400' : 'text-gray-100 dark:text-gray-700'} strokeWidth={v === 0 ? 1.3 : 1} />
            <text x={L - 9} y={Y(v) + 4} fontSize="11" textAnchor="end" fill="#9ca3af">{fmtPos(v)}</text>
          </g>
        ))}
        {gridX.map(v => (
          <g key={v}>
            <line x1={X(v)} x2={X(v)} y1={T} y2={H - B} stroke="currentColor" className="text-gray-100 dark:text-gray-700" />
            <text x={X(v)} y={H - B + 18} fontSize="11" textAnchor="middle" fill="#9ca3af">{v}</text>
          </g>
        ))}
        <text x={(L + W - R) / 2} y={H - 6} fontSize="12" textAnchor="middle" fill="#9ca3af">Taken pitches received</text>
        <text x={16} y={(T + H - B) / 2} fontSize="12" textAnchor="middle" fill="#9ca3af"
          transform={`rotate(-90 16 ${(T + H - B) / 2})`}>
          {scatterY === 'totalDef' ? 'Total Defense Runs' : 'Framing Runs'}
        </text>
        {rows.map(r => (
          <circle key={r.catcher_id} cx={X(r.taken_pitches_received)} cy={Y(r[scatterY])}
            r={(3 + 4 * r.eb_shrink).toFixed(1)} fill={TCOL[tier('framing', r.framing)]} fillOpacity="0.72"
            stroke={TCOL[tier('framing', r.framing)]} style={{ cursor: 'pointer' }}
            onClick={() => onPick(r.catcher_id)}>
            <title>{r.name}, {r.team} — {r.taken_pitches_received} pitches, {r.innings} inn. Framing {fmtPos(r.framing.toFixed(1))}, Total Defense {fmtPos(sumTD(r))}</title>
          </circle>
        ))}
      </svg>
      <p className="text-[11px] text-gray-400 mt-2">
        Pitches received on the horizontal axis, the selected metric on the vertical. Dots colored by Framing Runs
        tier and sized by sample reliability. Hover for detail; click a dot to open its profile.
      </p>
    </div>
  )
}
