// PlayerCardPDF — printable one-page player profile.
//
// Mirrors the most coach-relevant pieces of /players/:id and squeezes
// them onto a single US Letter portrait page:
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │  HEADER  headshot · name · pos · B/T · year · team · season  │
//   ├────────────────────────────────┬─────────────────────────────┤
//   │  PERCENTILE BARS               │  SPRAY CHART                │
//   │  (Savant set — 8 stats)        │  (zone × hand × xbh/hr)     │
//   ├────────────────────────────────┴─────────────────────────────┤
//   │  PLATE DISCIPLINE  │  BATTED BALL MIX  │  SPLITS (vs L/R/RIS)│
//   ├──────────────────────────────────────────────────────────────┤
//   │  SEASON STATS  (one row per season + career rollup)          │
//   ├──────────────────────────────────────────────────────────────┤
//   │  SUMMER BALL  (compact)                                      │
//   └──────────────────────────────────────────────────────────────┘
//
// For two-way players we render ONE side per PDF (chosen by `?side=`
// query param, defaulting to higher-WAR side). The PDFs picker
// surfaces both sides for two-way guys.

import { useParams, useSearchParams } from 'react-router-dom'
import {
  usePlayer,
  usePlayerPitchLevelStats,
  usePlayerPitchLevelStatsPitcher,
} from '../hooks/useApi'
import SprayChart from '../components/SprayChart'


const SEASON = 2026


// ───────────────────────────────────────────────────────────
// Formatters
// ───────────────────────────────────────────────────────────
const fmt = {
  rate: v => v == null ? '–' : Number(v).toFixed(3).replace(/^0\./, '.').replace(/^-0\./, '-.'),
  pct:  v => v == null ? '–' : `${(Number(v) * 100).toFixed(1)}%`,
  pct0: v => v == null ? '–' : `${(Number(v) * 100).toFixed(0)}%`,
  int:  v => v == null ? '–' : Math.round(Number(v)),
  era:  v => v == null ? '–' : Number(v).toFixed(2),
  ip:   v => v == null ? '–' : Number(v).toFixed(1),
  war:  v => v == null ? '–' : Number(v).toFixed(1),
  num:  v => v == null ? '–' : v,
}


// ───────────────────────────────────────────────────────────
// Savant-style percentile bar
// ───────────────────────────────────────────────────────────
function pctColor(pct) {
  if (pct == null) return '#e5e7eb'
  const p = Math.max(0, Math.min(100, pct)) / 100
  let r, g, b
  if (p >= 0.5) {
    const t = (p - 0.5) * 2
    r = Math.round(255 + (214 - 255) * t)
    g = Math.round(255 + (62 - 255) * t)
    b = Math.round(255 + (62 - 255) * t)
  } else {
    const t = (0.5 - p) * 2
    r = Math.round(255 + (29 - 255) * t)
    g = Math.round(255 + (78 - 255) * t)
    b = Math.round(255 + (216 - 255) * t)
  }
  return `rgb(${r},${g},${b})`
}


function PercentileRow({ label, value, percentile }) {
  const pct = percentile == null ? null : Math.max(0, Math.min(100, percentile))
  return (
    <div className="flex items-center gap-2 py-0.5">
      <div className="w-16 text-[9.5px] font-bold text-gray-700">{label}</div>
      <div className="relative h-3 flex-1 bg-gray-100 rounded overflow-hidden">
        {pct != null && (
          <div
            className="h-full"
            style={{ width: `${pct}%`, backgroundColor: pctColor(pct) }}
          />
        )}
        <div className="absolute inset-y-0 left-1/2 w-px bg-gray-300" />
      </div>
      <div className="text-[10px] tabular-nums w-12 text-right font-semibold">
        {value}
      </div>
      <div className="text-[8.5px] tabular-nums w-7 text-right text-gray-500">
        {pct != null ? Math.round(pct) : '–'}
      </div>
    </div>
  )
}


// Hitter percentile metric set — same as the player page's 2026 set
const HITTER_METRICS = [
  { key: 'wrc_plus',     label: 'wRC+',      fmt: v => v != null ? Math.round(v) : '–' },
  { key: 'woba',         label: 'wOBA',      fmt: v => fmt.rate(v) },
  { key: 'batting_avg',  label: 'AVG',       fmt: v => fmt.rate(v) },
  { key: 'hr_per_pa',    label: 'HR/PA',     fmt: v => fmt.pct(v) },
  { key: 'owar',         label: 'oWAR',      fmt: v => fmt.war(v) },
  { key: 'contact_pct',  label: 'Contact%',  fmt: v => fmt.pct(v) },
  { key: 'swing_pct',    label: 'Swing%',    fmt: v => fmt.pct(v) },
  { key: 'air_pull_pct', label: 'AirPull%',  fmt: v => fmt.pct(v) },
]

const PITCHER_METRICS = [
  { key: 'siera',      label: 'SIERA',   fmt: v => fmt.era(v) },
  { key: 'era',        label: 'ERA',     fmt: v => fmt.era(v) },
  { key: 'k_pct',      label: 'K%',      fmt: v => v != null ? `${Number(v).toFixed(1)}%` : '–' },
  { key: 'baa',        label: 'BAA',     fmt: v => fmt.rate(v) },
  { key: 'pwar',       label: 'pWAR',    fmt: v => fmt.war(v) },
  { key: 'strike_pct', label: 'Strike%', fmt: v => fmt.pct(v) },
  { key: 'fps_pct',    label: 'FPS%',    fmt: v => fmt.pct(v) },
  { key: 'whiff_pct',  label: 'Whiff%',  fmt: v => fmt.pct(v) },
]


// ───────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────
export default function PlayerCardPDF() {
  const { playerId } = useParams()
  const [searchParams] = useSearchParams()
  const sideParam = searchParams.get('side')   // 'batting' | 'pitching' | null

  const { data, loading, error } = usePlayer(playerId, null)
  const { data: hitterPbp } = usePlayerPitchLevelStats(playerId, SEASON)
  const { data: pitcherPbp } = usePlayerPitchLevelStatsPitcher(playerId, SEASON)

  if (loading || !data) {
    return <div className="p-8 text-gray-500 animate-pulse">Loading…</div>
  }
  if (error) {
    return <div className="p-8 text-rose-600">Could not load player.</div>
  }

  const { player, batting_percentiles, pitching_percentiles } = data
  // Defensive: useApi starts with data=null, and even after data loads
  // some fields can come through as null rather than missing. Default
  // destructuring only catches undefined, so coerce to [] explicitly.
  const battingStats = Array.isArray(data.batting_stats) ? data.batting_stats : []
  const pitchingStats = Array.isArray(data.pitching_stats) ? data.pitching_stats : []
  const summerBatting = Array.isArray(data.summer_batting) ? data.summer_batting : []
  const summerPitching = Array.isArray(data.summer_pitching) ? data.summer_pitching : []

  const hasBatting = battingStats.length > 0
  const hasPitching = pitchingStats.length > 0
  // Default side: higher career WAR. Same logic as the player page.
  const totBatWar = battingStats.reduce((s, r) => s + (r.offensive_war || 0), 0)
  const totPitWar = pitchingStats.reduce((s, r) => s + (r.pitching_war || 0), 0)
  const defaultSide = (hasBatting && hasPitching)
    ? (totPitWar > totBatWar ? 'pitching' : 'batting')
    : (hasPitching ? 'pitching' : 'batting')
  const side = sideParam || defaultSide

  return (
    <div className="player-card-pdf mx-auto px-3 py-4 max-w-[820px] print:px-0 print:py-0 print:max-w-none">
      {/* Toolbar — hidden on print */}
      <div className="flex items-center justify-between gap-3 mb-3 print:hidden">
        <h1 className="text-lg font-bold text-portal-purple-dark">
          Player Card · {player.first_name} {player.last_name} ·{' '}
          <span className="capitalize">{side}</span>
        </h1>
        <button
          onClick={() => window.print()}
          className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                     bg-portal-purple text-portal-cream hover:bg-portal-purple-dark"
        >
          Print / Save as PDF
        </button>
      </div>

      <section className="card-page">
        <CardHeader player={player} side={side} season={SEASON} />

        <div className="grid grid-cols-[1fr_1.1fr] gap-3 mt-2">
          <PercentilePanel
            side={side}
            battingPercentiles={batting_percentiles}
            pitchingPercentiles={pitching_percentiles}
          />
          <SprayPanel side={side} hitterPbp={hitterPbp} pitcherPbp={pitcherPbp} player={player} />
        </div>

        <div className="grid grid-cols-3 gap-2 mt-2">
          <DisciplinePanel side={side} hitterPbp={hitterPbp} pitcherPbp={pitcherPbp} />
          <BattedBallPanel side={side} hitterPbp={hitterPbp} pitcherPbp={pitcherPbp} />
          <SplitsPanel side={side} hitterPbp={hitterPbp} pitcherPbp={pitcherPbp} />
        </div>

        <SeasonStatsTable side={side} battingStats={battingStats} pitchingStats={pitchingStats} />

        <SummerBallTable
          side={side}
          summerBatting={summerBatting}
          summerPitching={summerPitching}
        />
      </section>
    </div>
  )
}


// ───────────────────────────────────────────────────────────
// Header
// ───────────────────────────────────────────────────────────
function CardHeader({ player, side, season }) {
  const handColor = ({
    L: '#c0392b', R: '#1f4e8c', B: '#7d3c98',
  })[(side === 'pitching' ? player.throws : player.bats)?.toUpperCase()] || '#374151'
  const sideLabel = side === 'pitching' ? 'PITCHING' : 'HITTING'
  return (
    <div className="flex items-center gap-3 border-b-2 border-portal-purple pb-2">
      {player.headshot_url ? (
        <img src={player.headshot_url} alt=""
             className="w-12 h-12 rounded-md object-cover bg-gray-100" />
      ) : (
        <div className="w-12 h-12 rounded-md bg-gray-100 flex items-center justify-center text-gray-400 font-bold">
          {(player.first_name?.[0] || '') + (player.last_name?.[0] || '')}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 leading-none">
          {player.team_short || player.team_name} · {player.conference_abbrev || ''} · {player.division_level || ''} · {season}
        </div>
        <div className="text-lg font-bold leading-tight" style={{ color: handColor }}>
          {player.first_name} {player.last_name}
          {player.jersey_number && (
            <span className="text-gray-400 font-normal ml-2">#{player.jersey_number}</span>
          )}
        </div>
        <div className="text-[10px] text-gray-600 leading-none mt-0.5">
          {player.position || '–'}
          {player.bats || player.throws ? ` · B/T: ${player.bats || '–'}/${player.throws || '–'}` : ''}
          {player.year_in_school ? ` · ${player.year_in_school}` : ''}
          {player.height ? ` · ${player.height}` : ''}
          {player.weight ? ` · ${player.weight} lbs` : ''}
          {player.hometown ? ` · ${player.hometown}` : ''}
        </div>
      </div>
      <div className="text-right">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 leading-none">
          {sideLabel} CARD
        </div>
        {player.logo_url && (
          <img src={player.logo_url} alt="" className="h-10 w-10 object-contain ml-auto mt-0.5" />
        )}
      </div>
    </div>
  )
}


// ───────────────────────────────────────────────────────────
// Percentile bars (Savant set, 8 stats)
// ───────────────────────────────────────────────────────────
function PercentilePanel({ side, battingPercentiles, pitchingPercentiles }) {
  const metrics = side === 'pitching' ? PITCHER_METRICS : HITTER_METRICS
  const data = side === 'pitching' ? pitchingPercentiles : battingPercentiles
  const title = side === 'pitching' ? 'Pitcher Percentiles' : 'Hitter Percentiles'
  return (
    <div className="border border-gray-200 rounded p-2">
      <div className="text-[10px] uppercase tracking-widest text-portal-purple-dark font-bold mb-1">
        {title} <span className="text-gray-400 font-normal">vs peers</span>
      </div>
      <div className="space-y-0">
        {metrics.map(m => {
          const block = (data && data[m.key]) || {}
          return (
            <PercentileRow
              key={m.key}
              label={m.label}
              value={m.fmt(block.value)}
              percentile={block.percentile}
            />
          )
        })}
      </div>
    </div>
  )
}


// ───────────────────────────────────────────────────────────
// Spray chart panel
// ───────────────────────────────────────────────────────────
function SprayPanel({ side, hitterPbp, pitcherPbp, player }) {
  // Hitter: own spray. Pitcher: opposing batters' spray vs this pitcher.
  const data = side === 'pitching' ? pitcherPbp?.opp_spray_chart : hitterPbp?.spray_chart
  const title = side === 'pitching' ? 'Opp. Spray vs This Pitcher' : 'Spray Chart'
  // For the SprayChart component, `bats` controls pull/oppo orientation;
  // for pitcher mode we pass through but the spray chart's mode handles it.
  const bats = side === 'pitching' ? null : (player.bats || 'R')
  const mode = side === 'pitching' ? 'pitcher' : 'hitter'
  return (
    <div className="border border-gray-200 rounded p-2 flex flex-col">
      <div className="text-[10px] uppercase tracking-widest text-portal-purple-dark font-bold mb-1">
        {title}
      </div>
      <div className="flex-1 min-h-[180px]">
        {data ? (
          <SprayChart data={data} bats={bats} mode={mode} defaultFilter="all" />
        ) : (
          <div className="text-[10px] text-gray-400 italic">No PBP coverage yet.</div>
        )}
      </div>
    </div>
  )
}


// ───────────────────────────────────────────────────────────
// Plate discipline mini panel
// ───────────────────────────────────────────────────────────
function DisciplinePanel({ side, hitterPbp, pitcherPbp }) {
  const rows = side === 'pitching' ? [
    ['Strike%',   pitcherPbp?.discipline?.strike_pct],
    ['FPS%',      pitcherPbp?.discipline?.first_pitch_strike_pct],
    ['Whiff%',    pitcherPbp?.discipline?.whiff_pct],
    ['Putaway%',  pitcherPbp?.discipline?.putaway_pct],
    ['Called K%', pitcherPbp?.discipline?.called_strike_pct],
    ['P/PA',      pitcherPbp?.discipline?.pitches_per_pa],
  ] : [
    ['Contact%',  hitterPbp?.discipline?.contact_pct],
    ['Swing%',    hitterPbp?.discipline?.swing_pct],
    ['Whiff%',    hitterPbp?.discipline?.whiff_pct],
    ['FPSwing%',  hitterPbp?.discipline?.first_pitch_swing_pct],
    ['Putaway%',  hitterPbp?.discipline?.putaway_pct],
    ['0-0 BIP%',  hitterPbp?.discipline?.zero_zero_bip_pct],
  ]
  return (
    <MiniCard title="Plate Discipline">
      {rows.map(([label, val]) => (
        <StatLine key={label} label={label}
          value={label === 'P/PA' ? (val == null ? '–' : Number(val).toFixed(1)) : fmt.pct(val)} />
      ))}
    </MiniCard>
  )
}


// ───────────────────────────────────────────────────────────
// Batted ball mini panel
// ───────────────────────────────────────────────────────────
function BattedBallPanel({ side, hitterPbp, pitcherPbp }) {
  const cp = side === 'pitching' ? pitcherPbp?.opp_contact_profile : hitterPbp?.contact_profile
  const prefix = side === 'pitching' ? 'opp ' : ''
  return (
    <MiniCard title={side === 'pitching' ? 'Batted Ball Allowed' : 'Batted Ball'}>
      <StatLine label={`${prefix}GB%`} value={fmt.pct(cp?.gb_pct)} />
      <StatLine label={`${prefix}FB%`} value={fmt.pct(cp?.fb_pct)} />
      <StatLine label={`${prefix}LD%`} value={fmt.pct(cp?.ld_pct)} />
      <StatLine label={`${prefix}PU%`} value={fmt.pct(cp?.pu_pct)} />
      {side !== 'pitching' && (
        <>
          <StatLine label="Pull%"  value={fmt.pct(cp?.pull_pct)} />
          <StatLine label="AirPull%" value={fmt.pct(cp?.air_pull_pct)} />
        </>
      )}
    </MiniCard>
  )
}


// ───────────────────────────────────────────────────────────
// Splits mini panel — vs L / vs R / w RISP. The data lives on
// pitch-level-stats endpoints as `lr_splits` + `situational_splits`,
// each a list of {label, filter_key, ...stat fields}. We pluck
// the right entry by filter_key and pull a few key stats.
// ───────────────────────────────────────────────────────────
function findSplit(arr, key) {
  if (!Array.isArray(arr)) return null
  return arr.find(r => r.filter_key === key) || null
}

function SplitsPanel({ side, hitterPbp, pitcherPbp }) {
  const isPitcher = side === 'pitching'
  const pbp = isPitcher ? pitcherPbp : hitterPbp
  if (!pbp) {
    return <MiniCard title="Splits"><div className="text-[10px] text-gray-400 italic">—</div></MiniCard>
  }
  const lrSplits = pbp.lr_splits || []
  const sitSplits = pbp.situational_splits || []
  const cols = isPitcher
    ? [['vs_rhh', 'vR'], ['vs_lhh', 'vL'], ['risp', 'RISP']]
    : [['vs_rhp', 'vR'], ['vs_lhp', 'vL'], ['risp', 'RISP']]
  // For each column key, look in lr_splits first, then situational.
  const lookup = key => findSplit(lrSplits, key) || findSplit(sitSplits, key)
  const rows = isPitcher
    ? [
        { keys: ['opp_woba','woba'], label: 'opp wOBA', fmt: fmt.rate },
        { keys: ['opp_iso','iso'],   label: 'opp ISO',  fmt: fmt.rate },
        { keys: ['k_pct'],           label: 'K%',       fmt: fmt.pct },
        { keys: ['bb_pct'],          label: 'BB%',      fmt: fmt.pct },
      ]
    : [
        { keys: ['woba'],        label: 'wOBA',    fmt: fmt.rate },
        { keys: ['iso'],         label: 'ISO',     fmt: fmt.rate },
        { keys: ['contact_pct'], label: 'Contact%', fmt: fmt.pct },
        { keys: ['k_pct'],       label: 'K%',      fmt: fmt.pct },
        { keys: ['bb_pct'],      label: 'BB%',     fmt: fmt.pct },
      ]
  // For each (column, row) cell, find the first matching key in the
  // split entry — covers naming variation between hitter and pitcher
  // payloads (woba vs opp_woba, etc.).
  const cellValue = (block, keys) => {
    if (!block) return null
    for (const k of keys) {
      if (block[k] != null) return block[k]
    }
    return null
  }
  return (
    <MiniCard title="Splits">
      <div className="grid grid-cols-[1fr_repeat(3,minmax(0,36px))] gap-x-1 text-[9.5px]">
        <div />
        {cols.map(([_, label]) => (
          <div key={label} className="text-[8.5px] text-gray-500 text-right font-bold">
            {label}
          </div>
        ))}
        {rows.map(r => (
          <Row key={r.label} label={r.label}>
            {cols.map(([colKey]) => {
              const block = lookup(colKey)
              return (
                <div key={colKey} className="text-right tabular-nums font-semibold">
                  {r.fmt(cellValue(block, r.keys))}
                </div>
              )
            })}
          </Row>
        ))}
      </div>
    </MiniCard>
  )
}


function Row({ label, children }) {
  return (
    <>
      <div className="text-gray-700">{label}</div>
      {children}
    </>
  )
}


// ───────────────────────────────────────────────────────────
// Reusable mini card
// ───────────────────────────────────────────────────────────
function MiniCard({ title, children }) {
  return (
    <div className="border border-gray-200 rounded p-2 text-[9.5px] leading-tight">
      <div className="text-[9.5px] uppercase tracking-widest text-portal-purple-dark font-bold mb-1">
        {title}
      </div>
      {children}
    </div>
  )
}

function StatLine({ label, value }) {
  return (
    <div className="flex justify-between items-baseline border-b border-gray-100 last:border-0 py-0.5">
      <span className="text-gray-600">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  )
}


// ───────────────────────────────────────────────────────────
// Season stats table — compact, one row per season + career
// ───────────────────────────────────────────────────────────
function SeasonStatsTable({ side, battingStats, pitchingStats }) {
  if (side === 'pitching') {
    return <PitchingStatsTable rows={pitchingStats} />
  }
  return <BattingStatsTable rows={battingStats} />
}


function BattingStatsTable({ rows }) {
  if (!rows.length) return null
  // Sort newest → oldest, drop seasons with 0 PA
  const sorted = [...rows].filter(r => (r.plate_appearances || 0) > 0)
                          .sort((a, b) => b.season - a.season)
  const career = aggregateBatting(sorted)
  return (
    <div className="mt-2 border border-gray-200 rounded overflow-hidden">
      <div className="bg-portal-purple text-portal-cream text-[9.5px] px-2 py-1 font-bold uppercase tracking-widest">
        Season Stats
      </div>
      <table className="w-full text-[9.5px] leading-tight tabular-nums">
        <thead className="bg-gray-50 text-gray-600 font-semibold">
          <tr>
            {['Sn','Tm','PA','AB','H','HR','RBI','R','SB','BB','K','AVG','OBP','SLG','wOBA','wRC+','WAR']
              .map(h => <th key={h} className="px-1.5 py-1 text-right border-b border-gray-200 first:text-left">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => (
            <tr key={r.season} className="border-b border-gray-100 last:border-0">
              <td className="px-1.5 py-1 font-semibold text-left">{r.season}</td>
              <td className="px-1.5 py-1 text-right text-gray-500">{r.team_short || ''}</td>
              <td className="px-1.5 py-1 text-right">{r.plate_appearances || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.at_bats || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.hits || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.home_runs || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.rbi || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.runs || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.stolen_bases || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.walks || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.strikeouts || 0}</td>
              <td className="px-1.5 py-1 text-right">{fmt.rate(r.batting_avg)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.rate(r.on_base_pct)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.rate(r.slugging_pct)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.rate(r.woba)}</td>
              <td className="px-1.5 py-1 text-right">{r.wrc_plus != null ? Math.round(r.wrc_plus) : '–'}</td>
              <td className="px-1.5 py-1 text-right font-semibold">{fmt.war(r.offensive_war)}</td>
            </tr>
          ))}
          {sorted.length > 1 && (
            <tr className="bg-portal-purple/5 font-bold border-t-2 border-portal-purple">
              <td className="px-1.5 py-1 text-left" colSpan={2}>CAREER</td>
              <td className="px-1.5 py-1 text-right">{career.pa}</td>
              <td className="px-1.5 py-1 text-right">{career.ab}</td>
              <td className="px-1.5 py-1 text-right">{career.h}</td>
              <td className="px-1.5 py-1 text-right">{career.hr}</td>
              <td className="px-1.5 py-1 text-right">{career.rbi}</td>
              <td className="px-1.5 py-1 text-right">{career.runs}</td>
              <td className="px-1.5 py-1 text-right">{career.sb}</td>
              <td className="px-1.5 py-1 text-right">{career.bb}</td>
              <td className="px-1.5 py-1 text-right">{career.k}</td>
              <td className="px-1.5 py-1 text-right">{fmt.rate(career.avg)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.rate(career.obp)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.rate(career.slg)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.rate(career.woba)}</td>
              <td className="px-1.5 py-1 text-right">{career.wrcPlus != null ? Math.round(career.wrcPlus) : '–'}</td>
              <td className="px-1.5 py-1 text-right">{fmt.war(career.war)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}


function PitchingStatsTable({ rows }) {
  if (!rows.length) return null
  const sorted = [...rows].filter(r => (r.innings_pitched || 0) > 0)
                          .sort((a, b) => b.season - a.season)
  const career = aggregatePitching(sorted)
  return (
    <div className="mt-2 border border-gray-200 rounded overflow-hidden">
      <div className="bg-portal-purple text-portal-cream text-[9.5px] px-2 py-1 font-bold uppercase tracking-widest">
        Season Stats
      </div>
      <table className="w-full text-[9.5px] leading-tight tabular-nums">
        <thead className="bg-gray-50 text-gray-600 font-semibold">
          <tr>
            {['Sn','Tm','W-L','ERA','FIP','WHIP','IP','H','BB','K','HR','K%','BB%','BAA','WAR']
              .map(h => <th key={h} className="px-1.5 py-1 text-right border-b border-gray-200 first:text-left">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => (
            <tr key={r.season} className="border-b border-gray-100 last:border-0">
              <td className="px-1.5 py-1 font-semibold text-left">{r.season}</td>
              <td className="px-1.5 py-1 text-right text-gray-500">{r.team_short || ''}</td>
              <td className="px-1.5 py-1 text-right">{(r.wins || 0)}-{(r.losses || 0)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.era(r.era)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.era(r.fip)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.era(r.whip)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.ip(r.innings_pitched)}</td>
              <td className="px-1.5 py-1 text-right">{r.hits_allowed || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.walks || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.strikeouts || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.home_runs_allowed || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.k_pct != null ? `${(r.k_pct * 100).toFixed(1)}%` : '–'}</td>
              <td className="px-1.5 py-1 text-right">{r.bb_pct != null ? `${(r.bb_pct * 100).toFixed(1)}%` : '–'}</td>
              <td className="px-1.5 py-1 text-right">{fmt.rate(r.opp_avg)}</td>
              <td className="px-1.5 py-1 text-right font-semibold">{fmt.war(r.pitching_war)}</td>
            </tr>
          ))}
          {sorted.length > 1 && (
            <tr className="bg-portal-purple/5 font-bold border-t-2 border-portal-purple">
              <td className="px-1.5 py-1 text-left" colSpan={2}>CAREER</td>
              <td className="px-1.5 py-1 text-right">{career.w}-{career.l}</td>
              <td className="px-1.5 py-1 text-right">{fmt.era(career.era)}</td>
              <td className="px-1.5 py-1 text-right">–</td>
              <td className="px-1.5 py-1 text-right">{fmt.era(career.whip)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.ip(career.ip)}</td>
              <td className="px-1.5 py-1 text-right">{career.h}</td>
              <td className="px-1.5 py-1 text-right">{career.bb}</td>
              <td className="px-1.5 py-1 text-right">{career.k}</td>
              <td className="px-1.5 py-1 text-right">{career.hr}</td>
              <td className="px-1.5 py-1 text-right">–</td>
              <td className="px-1.5 py-1 text-right">–</td>
              <td className="px-1.5 py-1 text-right">{fmt.rate(career.baa)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.war(career.war)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}


// ───────────────────────────────────────────────────────────
// Summer ball — compact, gated by side
// ───────────────────────────────────────────────────────────
function SummerBallTable({ side, summerBatting, summerPitching }) {
  const rows = side === 'pitching' ? summerPitching : summerBatting
  if (!rows || rows.length === 0) return null
  const sorted = [...rows].sort((a, b) => b.season - a.season)
  return (
    <div className="mt-2 border border-amber-200 rounded overflow-hidden">
      <div className="bg-amber-100 text-amber-900 text-[9.5px] px-2 py-1 font-bold uppercase tracking-widest">
        Summer Ball
      </div>
      <table className="w-full text-[9.5px] leading-tight tabular-nums">
        <thead className="bg-amber-50 text-amber-800 font-semibold">
          <tr>
            {(side === 'pitching'
              ? ['Sn','League','Team','W-L','ERA','IP','H','BB','K','HR']
              : ['Sn','League','Team','PA','AVG','OBP','SLG','HR','RBI','SB']
            ).map(h => <th key={h} className="px-1.5 py-1 text-right border-b border-amber-100 first:text-left">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => side === 'pitching' ? (
            <tr key={i} className="border-b border-amber-50 last:border-0">
              <td className="px-1.5 py-1 font-semibold text-left">{r.season}</td>
              <td className="px-1.5 py-1 text-right text-gray-600">{r.league || ''}</td>
              <td className="px-1.5 py-1 text-right text-gray-500">{r.team_short || r.team_name || ''}</td>
              <td className="px-1.5 py-1 text-right">{(r.wins || 0)}-{(r.losses || 0)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.era(r.era)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.ip(r.innings_pitched)}</td>
              <td className="px-1.5 py-1 text-right">{r.hits_allowed || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.walks || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.strikeouts || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.home_runs_allowed || 0}</td>
            </tr>
          ) : (
            <tr key={i} className="border-b border-amber-50 last:border-0">
              <td className="px-1.5 py-1 font-semibold text-left">{r.season}</td>
              <td className="px-1.5 py-1 text-right text-gray-600">{r.league || ''}</td>
              <td className="px-1.5 py-1 text-right text-gray-500">{r.team_short || r.team_name || ''}</td>
              <td className="px-1.5 py-1 text-right">{r.plate_appearances || 0}</td>
              <td className="px-1.5 py-1 text-right">{fmt.rate(r.batting_avg)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.rate(r.on_base_pct)}</td>
              <td className="px-1.5 py-1 text-right">{fmt.rate(r.slugging_pct)}</td>
              <td className="px-1.5 py-1 text-right">{r.home_runs || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.rbi || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.stolen_bases || 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}


// ───────────────────────────────────────────────────────────
// Career aggregation helpers
// ───────────────────────────────────────────────────────────
function aggregateBatting(rows) {
  if (!rows.length) return {}
  let pa = 0, ab = 0, h = 0, hr = 0, rbi = 0, runs = 0, sb = 0, bb = 0, k = 0, war = 0
  let tb = 0, hbp = 0, sf = 0, woba_num = 0, wrc_num = 0
  rows.forEach(r => {
    pa += r.plate_appearances || 0
    ab += r.at_bats || 0
    h += r.hits || 0
    hr += r.home_runs || 0
    rbi += r.rbi || 0
    runs += r.runs || 0
    sb += r.stolen_bases || 0
    bb += r.walks || 0
    k += r.strikeouts || 0
    war += r.offensive_war || 0
    hbp += r.hit_by_pitch || 0
    sf += r.sacrifice_flies || 0
    const singles = (r.hits || 0) - (r.doubles || 0) - (r.triples || 0) - (r.home_runs || 0)
    tb += singles + 2*(r.doubles || 0) + 3*(r.triples || 0) + 4*(r.home_runs || 0)
    if (r.woba != null) woba_num += Number(r.woba) * (r.plate_appearances || 0)
    if (r.wrc_plus != null) wrc_num += Number(r.wrc_plus) * (r.plate_appearances || 0)
  })
  return {
    pa, ab, h, hr, rbi, runs, sb, bb, k, war,
    avg: ab > 0 ? h / ab : 0,
    obp: (ab + bb + hbp + sf) > 0 ? (h + bb + hbp) / (ab + bb + hbp + sf) : 0,
    slg: ab > 0 ? tb / ab : 0,
    woba: pa > 0 ? woba_num / pa : 0,
    wrcPlus: pa > 0 ? wrc_num / pa : null,
  }
}

function aggregatePitching(rows) {
  let w = 0, l = 0, h = 0, bb = 0, k = 0, hr = 0, war = 0
  let ip = 0, er = 0, hits_allowed = 0, walks_allowed = 0
  let bf = 0
  rows.forEach(r => {
    w += r.wins || 0
    l += r.losses || 0
    bb += r.walks || 0
    k += r.strikeouts || 0
    hr += r.home_runs_allowed || 0
    war += r.pitching_war || 0
    ip += Number(r.innings_pitched || 0)
    er += r.earned_runs || 0
    hits_allowed += r.hits_allowed || 0
    walks_allowed += r.walks || 0
    bf += r.batters_faced || 0
  })
  return {
    w, l, h: hits_allowed, bb, k, hr, war, ip,
    era: ip > 0 ? (er * 9) / ip : 0,
    whip: ip > 0 ? (hits_allowed + walks_allowed) / ip : 0,
    baa: bf > 0 ? hits_allowed / (bf - walks_allowed) : 0,
  }
}
