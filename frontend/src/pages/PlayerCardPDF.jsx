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

import { useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import {
  usePlayer,
  usePlayerPitchLevelStats,
  usePlayerPitchLevelStatsPitcher,
  usePlayerVsTeam,
  usePlayerRecentKs,
} from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'
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


// Hitter percentile metric set — exactly matches BATTING_PERCENTILE_METRICS_2026
// in PlayerDetail.jsx so the PDF mirrors what the user sees on screen.
const HITTER_METRICS = [
  { key: 'offensive_war', label: 'WAR',      fmt: v => fmt.war(v) },
  { key: 'wrc_plus',      label: 'wRC+',     fmt: v => v != null ? Math.round(v) : '–' },
  { key: 'iso',           label: 'ISO',      fmt: v => fmt.rate(v) },
  { key: 'hr_pa_pct',     label: 'HR/PA',    fmt: v => fmt.pct(v) },
  { key: 'sb_per_pa',     label: 'SB/PA',    fmt: v => fmt.pct(v) },
  { key: 'k_pct',         label: 'K%',       fmt: v => fmt.pct(v) },
  { key: 'bb_pct',        label: 'BB%',      fmt: v => fmt.pct(v) },
  { key: 'contact_pct',   label: 'Contact%', fmt: v => fmt.pct(v) },
  { key: 'air_pull_pct',  label: 'AirPull%', fmt: v => fmt.pct(v) },
  { key: 'wpa',           label: 'WPA',      fmt: v => v != null ? Number(v).toFixed(2) : '–' },
]

const PITCHER_METRICS = [
  { key: 'pitching_war',           label: 'WAR',         fmt: v => fmt.war(v) },
  { key: 'k_pct',                  label: 'K%',          fmt: v => fmt.pct(v) },
  { key: 'bb_pct',                 label: 'BB%',         fmt: v => fmt.pct(v) },
  { key: 'fip',                    label: 'FIP',         fmt: v => fmt.era(v) },
  { key: 'siera',                  label: 'SIERA',       fmt: v => fmt.era(v) },
  { key: 'hr_pa_pct',              label: 'HR/PA',       fmt: v => fmt.pct(v) },
  { key: 'opp_woba',               label: 'opp wOBA',    fmt: v => fmt.rate(v) },
  { key: 'strike_pct',             label: 'Strike%',     fmt: v => fmt.pct(v) },
  { key: 'first_pitch_strike_pct', label: 'FPS%',        fmt: v => fmt.pct(v) },
  { key: 'whiff_pct',              label: 'Whiff%',      fmt: v => fmt.pct(v) },
  { key: 'opp_air_pull_pct',       label: 'opp AirPull', fmt: v => fmt.pct(v) },
  { key: 'wpa',                    label: 'WPA',         fmt: v => v != null ? Number(v).toFixed(2) : '–' },
]


// ───────────────────────────────────────────────────────────
// Threshold-based color coding for cells that don't have an
// explicit percentile attached. Each entry maps a stat key to
// (good_threshold, mid_range, bad_threshold) and a direction —
// `higher_better` means values above good_threshold get green,
// values below bad_threshold get red. `lower_better` flips it.
// Values in between get scaled white→green / white→red.
// ───────────────────────────────────────────────────────────
const STAT_THRESHOLDS = {
  // Hitter — overall slash & rate stats
  batting_avg:  { good: 0.310, mid: [0.250, 0.310], bad: 0.225, dir: 'higher' },
  on_base_pct:  { good: 0.400, mid: [0.330, 0.400], bad: 0.300, dir: 'higher' },
  slugging_pct: { good: 0.480, mid: [0.380, 0.480], bad: 0.340, dir: 'higher' },
  woba:         { good: 0.400, mid: [0.330, 0.400], bad: 0.300, dir: 'higher' },
  iso:          { good: 0.180, mid: [0.110, 0.180], bad: 0.080, dir: 'higher' },
  ops:          { good: 0.880, mid: [0.700, 0.880], bad: 0.620, dir: 'higher' },
  wrc_plus:     { good: 130,   mid: [90, 130],     bad: 75,    dir: 'higher' },
  k_pct:        { good: 0.15,  mid: [0.15, 0.22],  bad: 0.27,  dir: 'lower'  },
  bb_pct:       { good: 0.12,  mid: [0.07, 0.12],  bad: 0.05,  dir: 'higher' },
  hr_per_pa:    { good: 0.04,  mid: [0.02, 0.04],  bad: 0.01,  dir: 'higher' },
  hr_per_fb:    { good: 0.18,  mid: [0.08, 0.18],  bad: 0.04,  dir: 'higher' },
  contact_pct:  { good: 0.82,  mid: [0.72, 0.82],  bad: 0.65,  dir: 'higher' },
  swing_pct:    { good: 0.50,  mid: [0.42, 0.55],  bad: 0.38,  dir: 'higher' },
  whiff_pct:    { good: 0.18,  mid: [0.18, 0.28],  bad: 0.32,  dir: 'lower'  },
  fps_pct:      { good: 0.65,  mid: [0.55, 0.65],  bad: 0.50,  dir: 'higher' },
  // Putaway% means different things on each side, so split into two
  // keyed thresholds. Hitter view: lower (avoiding the 2-strike K) is
  // green. Pitcher view: higher (finishing batters) is green.
  putaway_pct_hitter:  { good: 0.15, mid: [0.15, 0.22], bad: 0.27, dir: 'lower'  },
  putaway_pct_pitcher: { good: 0.22, mid: [0.16, 0.22], bad: 0.13, dir: 'higher' },
  air_pull_pct: { good: 0.22,  mid: [0.12, 0.22],  bad: 0.08,  dir: 'higher' },
  pull_pct:     { good: 0.45,  mid: [0.35, 0.45],  bad: 0.30,  dir: 'higher' },
  babip:        { good: 0.350, mid: [0.290, 0.350], bad: 0.260, dir: 'higher' },
  // Batted-ball share — neutral (no good/bad), shown gray
  gb_pct:       { dir: 'neutral' },
  fb_pct:       { dir: 'neutral' },
  ld_pct:       { good: 0.22,  mid: [0.16, 0.22],  bad: 0.12,  dir: 'higher' },
  pu_pct:       { good: 0.05,  mid: [0.05, 0.10],  bad: 0.13,  dir: 'lower'  },
  // Pitcher — opponent slash + own rate stats
  era:          { good: 3.00,  mid: [3.00, 4.50],  bad: 5.50,  dir: 'lower'  },
  fip:          { good: 3.20,  mid: [3.20, 4.50],  bad: 5.50,  dir: 'lower'  },
  siera:        { good: 3.40,  mid: [3.40, 4.40],  bad: 5.20,  dir: 'lower'  },
  whip:         { good: 1.10,  mid: [1.10, 1.40],  bad: 1.60,  dir: 'lower'  },
  k_per_9:      { good: 11,    mid: [8, 11],       bad: 6,     dir: 'higher' },
  bb_per_9:     { good: 2.5,   mid: [2.5, 4.0],    bad: 5.0,   dir: 'lower'  },
  hr_per_9:     { good: 0.6,   mid: [0.6, 1.2],    bad: 1.6,   dir: 'lower'  },
  opp_avg:      { good: 0.220, mid: [0.220, 0.270], bad: 0.300, dir: 'lower' },
  opp_woba:     { good: 0.290, mid: [0.290, 0.340], bad: 0.380, dir: 'lower' },
  opp_iso:      { good: 0.100, mid: [0.100, 0.150], bad: 0.180, dir: 'lower' },
  strike_pct:   { good: 0.66,  mid: [0.60, 0.66],  bad: 0.56,  dir: 'higher' },
  first_pitch_strike_pct: { good: 0.62, mid: [0.55, 0.62], bad: 0.50, dir: 'higher' },
  called_strike_pct:      { good: 0.20, mid: [0.16, 0.20], bad: 0.13, dir: 'higher' },
  pitches_per_pa:         { good: 3.5,  mid: [3.5, 4.0],   bad: 4.2,  dir: 'lower' },
}

// Map a value to a 0-100 percentile-like score using the threshold
// ramp. Returns null when there's no value or the stat is neutral.
function thresholdScore(statKey, value) {
  if (value == null) return null
  const t = STAT_THRESHOLDS[statKey]
  if (!t || t.dir === 'neutral') return null
  const v = Number(value)
  const flip = t.dir === 'lower'
  const norm = flip ? -v : -v + 0  // sign convention: bigger raw = bigger score
  // We just compare against thresholds directly; convert each into a
  // 0–100 score based on linear interpolation between bad/mid/good.
  const good = t.good
  const bad = t.bad
  const [midLo, midHi] = t.mid
  let score
  if (flip) {
    // lower_better: v ≤ good → 100, v ≥ bad → 0
    if (v <= good) score = 90
    else if (v >= bad) score = 10
    else if (v <= midLo) score = 70
    else if (v <= midHi) score = 50
    else score = 30
  } else {
    // higher_better
    if (v >= good) score = 90
    else if (v <= bad) score = 10
    else if (v >= midHi) score = 70
    else if (v >= midLo) score = 50
    else score = 30
  }
  return score
}

// Convert a 0–100 score into a Savant red→white→blue rgba.
function scoreColor(score, alpha = 0.8) {
  if (score == null) return 'transparent'
  const p = Math.max(0, Math.min(100, score)) / 100
  let r, g, b
  if (p >= 0.5) {
    const t = (p - 0.5) * 2
    r = Math.round(255 + (162 - 255) * t)
    g = Math.round(255 + (210 - 255) * t)
    b = Math.round(255 + (162 - 255) * t)
  } else {
    const t = (0.5 - p) * 2
    r = Math.round(255 + (245 - 255) * t)
    g = Math.round(255 + (170 - 255) * t)
    b = Math.round(255 + (170 - 255) * t)
  }
  return `rgba(${r},${g},${b},${alpha})`
}


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
  // Portal team — when set, we fetch this player's stats vs that team
  // and render a vs-team panel in the leftover space below the
  // percentile bars. Skipped entirely when no portal team is set
  // (the panel falls back to a "set your team" prompt).
  const { team: portalTeam } = usePortalTeam()

  // Set the document title so the browser's "Save as PDF" dialog
  // pre-fills a useful filename instead of "NW Baseball Stats..." for
  // every download. Format: "Sharp_Andrew_Hitting_2026.pdf". Restore
  // the original title on unmount so we don't pollute other pages.
  // IMPORTANT: this useEffect must live above the early-return guards
  // below — React requires hooks to run in the same order every
  // render (Rules of Hooks).
  useEffect(() => {
    if (!data?.player) return
    const safe = (s) => (s || '').replace(/[^A-Za-z0-9]/g, '')
    const battingStats = Array.isArray(data.batting_stats) ? data.batting_stats : []
    const pitchingStats = Array.isArray(data.pitching_stats) ? data.pitching_stats : []
    const totBatWar = battingStats.reduce((s, r) => s + (r.offensive_war || 0), 0)
    const totPitWar = pitchingStats.reduce((s, r) => s + (r.pitching_war || 0), 0)
    const fallback = pitchingStats.length && (totPitWar > totBatWar || !battingStats.length)
      ? 'pitching' : 'batting'
    const effectiveSide = sideParam || fallback
    const sideLabel = effectiveSide === 'pitching' ? 'Pitching' : 'Hitting'
    const orig = document.title
    document.title = `${safe(data.player.last_name)}_${safe(data.player.first_name)}_${sideLabel}_${SEASON}`
    return () => { document.title = orig }
  }, [data, sideParam])

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

        <div className="grid grid-cols-[1fr_1.1fr] gap-3 mt-2 items-stretch">
          {/* Left column: percentile bars on top, vs-team panel below
              fills the remaining vertical space so the column matches
              the spray chart's height. */}
          <div className="flex flex-col gap-2">
            <PercentilePanel
              side={side}
              battingPercentiles={batting_percentiles}
              pitchingPercentiles={pitching_percentiles}
            />
            <VsTeamPanel
              playerId={playerId}
              side={side}
              portalTeam={portalTeam}
            />
          </div>
          <SprayPanel side={side} hitterPbp={hitterPbp} pitcherPbp={pitcherPbp} player={player} />
        </div>

        <div className="grid grid-cols-4 gap-2 mt-2">
          <DisciplinePanel side={side} hitterPbp={hitterPbp} pitcherPbp={pitcherPbp} />
          <BattedBallPanel side={side} hitterPbp={hitterPbp} pitcherPbp={pitcherPbp} />
          <SplitsPanel side={side} hitterPbp={hitterPbp} pitcherPbp={pitcherPbp} />
          <CountStatesPanel side={side} hitterPbp={hitterPbp} pitcherPbp={pitcherPbp} />
        </div>

        <SeasonStatsTable side={side} battingStats={battingStats} pitchingStats={pitchingStats} />

        <SummerBallTable
          side={side}
          summerBatting={summerBatting}
          summerPitching={summerPitching}
        />

        <RecentKsPanel playerId={playerId} side={side} portalTeam={portalTeam} />
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
  // Each row: [label, raw_value, stat_key]. stat_key drives color coding
  // via thresholdScore(); label and raw_value are for display.
  const rows = side === 'pitching' ? [
    ['Strike%',   pitcherPbp?.discipline?.strike_pct,             'strike_pct'],
    ['FPS%',      pitcherPbp?.discipline?.first_pitch_strike_pct, 'first_pitch_strike_pct'],
    ['Whiff%',    pitcherPbp?.discipline?.whiff_pct,              'whiff_pct'],
    ['Putaway%',  pitcherPbp?.discipline?.putaway_pct,            'putaway_pct_pitcher'],
    ['Called K%', pitcherPbp?.discipline?.called_strike_pct,      'called_strike_pct'],
    ['P/PA',      pitcherPbp?.discipline?.pitches_per_pa,         'pitches_per_pa'],
  ] : [
    ['Contact%',  hitterPbp?.discipline?.contact_pct,             'contact_pct'],
    ['Swing%',    hitterPbp?.discipline?.swing_pct,               'swing_pct'],
    ['Whiff%',    hitterPbp?.discipline?.whiff_pct,               'whiff_pct'],
    ['FPSwing%',  hitterPbp?.discipline?.first_pitch_swing_pct,    null],
    ['Putaway%',  hitterPbp?.discipline?.putaway_pct,             'putaway_pct_hitter'],
    ['0-0 BIP%',  hitterPbp?.discipline?.zero_zero_bip_pct,        null],
  ]
  return (
    <MiniCard title="Plate Discipline">
      {rows.map(([label, val, key]) => (
        <StatLine key={label} label={label}
          rawValue={val}
          statKey={key}
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
      <StatLine label={`${prefix}GB%`}  rawValue={cp?.gb_pct} statKey="gb_pct" value={fmt.pct(cp?.gb_pct)} />
      <StatLine label={`${prefix}FB%`}  rawValue={cp?.fb_pct} statKey="fb_pct" value={fmt.pct(cp?.fb_pct)} />
      <StatLine label={`${prefix}LD%`}  rawValue={cp?.ld_pct} statKey="ld_pct" value={fmt.pct(cp?.ld_pct)} />
      <StatLine label={`${prefix}PU%`}  rawValue={cp?.pu_pct} statKey="pu_pct" value={fmt.pct(cp?.pu_pct)} />
      {side !== 'pitching' && (
        <>
          <StatLine label="Pull%"    rawValue={cp?.pull_pct}     statKey="pull_pct"     value={fmt.pct(cp?.pull_pct)} />
          <StatLine label="AirPull%" rawValue={cp?.air_pull_pct} statKey="air_pull_pct" value={fmt.pct(cp?.air_pull_pct)} />
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
  // Filter keys must match the backend's lr_splits payload exactly.
  // Pitcher endpoint uses vs_rhb/vs_lhb (B for batter), hitter uses
  // vs_rhp/vs_lhp (P for pitcher). Mixing these up nukes the column.
  const cols = isPitcher
    ? [['vs_rhb', 'vR'], ['vs_lhb', 'vL'], ['risp', 'RISP']]
    : [['vs_rhp', 'vR'], ['vs_lhp', 'vL'], ['risp', 'RISP']]
  // For each column key, look in lr_splits first, then situational.
  const lookup = key => findSplit(lrSplits, key) || findSplit(sitSplits, key)
  const rows = isPitcher
    ? [
        { keys: ['opp_woba','woba'], label: 'opp wOBA', fmt: fmt.rate, threshold: 'opp_woba' },
        { keys: ['opp_iso','iso'],   label: 'opp ISO',  fmt: fmt.rate, threshold: 'opp_iso'  },
        { keys: ['k_pct'],           label: 'K%',       fmt: fmt.pct,  threshold: null       },
        { keys: ['bb_pct'],          label: 'BB%',      fmt: fmt.pct,  threshold: null       },
      ]
    : [
        { keys: ['woba'],        label: 'wOBA',    fmt: fmt.rate, threshold: 'woba'        },
        { keys: ['iso'],         label: 'ISO',     fmt: fmt.rate, threshold: 'iso'         },
        { keys: ['contact_pct'], label: 'Contact%', fmt: fmt.pct, threshold: 'contact_pct' },
        { keys: ['k_pct'],       label: 'K%',      fmt: fmt.pct,  threshold: 'k_pct'       },
        { keys: ['bb_pct'],      label: 'BB%',     fmt: fmt.pct,  threshold: 'bb_pct'      },
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
              const raw = cellValue(block, r.keys)
              const score = r.threshold ? thresholdScore(r.threshold, raw) : null
              const bg = score != null ? scoreColor(score, 0.85) : undefined
              return (
                <div key={colKey} className="text-right tabular-nums font-semibold">
                  <span className="px-1 rounded" style={bg ? { backgroundColor: bg } : undefined}>
                    {r.fmt(raw)}
                  </span>
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
// Recent K's — for hitter cards, the pitchers who've struck this
// hitter out most recently (in chronological order, newest first).
// For pitcher cards, the batters this pitcher has K'd most recently.
// Sits at the bottom of the page in a 2-column compact list to fill
// any vertical space the season-stats / summer-ball blocks didn't
// claim.
// ───────────────────────────────────────────────────────────
function RecentKsPanel({ playerId, side, portalTeam }) {
  // The panel is gated on having a portal team selected — the whole
  // point is "K's vs MY team", not "recent K's anywhere". Render
  // nothing when the user hasn't picked a team.
  const teamId = portalTeam?.id || null
  const { data, loading } = usePlayerRecentKs(playerId, side, teamId, undefined, 30)
  if (!teamId) return null
  const ks = data?.strikeouts || []
  if (loading || !ks.length) return null
  const isPitcher = side === 'pitching'
  const teamLabel = portalTeam.short_name || portalTeam.name || 'team'

  const formatDate = (iso) => {
    if (!iso) return ''
    try {
      const d = new Date(iso + 'T12:00:00')  // noon UTC to avoid TZ shift
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    } catch { return iso }
  }
  const formatType = (t) =>
    t === 'strikeout_swinging' ? 'K (swinging)' :
    t === 'strikeout_looking'  ? 'K (looking)'  : 'K'
  const formatCount = (b, s) => `${b ?? 0}-${s ?? 0}`

  // Split into 2 columns so the panel reads left-to-right top-to-bottom
  // like a card; left column is the most-recent half.
  const half = Math.ceil(ks.length / 2)
  const left = ks.slice(0, half)
  const right = ks.slice(half)

  // Header text: "Strikeouts vs <my team>" — directional regardless of
  // side. Hitter card → pitchers from MY team that K'd him.
  // Pitcher card → batters from MY team this pitcher K'd.
  const headerLabel = isPitcher
    ? `${teamLabel} Hitters K'd by This Pitcher`
    : `Pitchers from ${teamLabel} Who Struck Him Out`
  const oppHeader = isPitcher ? 'Hitter' : 'Pitcher'

  const renderRow = (k, i) => (
    <div key={i}
         className="grid grid-cols-[60px_1fr_60px_70px] items-baseline gap-1 py-0.5
                    border-b border-gray-100 last:border-0 text-[9px]">
      <span className="text-gray-500 tabular-nums">{formatDate(k.game_date)}</span>
      <span className="font-semibold text-gray-800 truncate" title={k.opponent_name}>
        {k.opponent_name}
        {k.opponent_team_short && (
          <span className="text-gray-400 font-normal ml-1">({k.opponent_team_short})</span>
        )}
      </span>
      <span className="text-rose-700 font-bold whitespace-nowrap">{formatType(k.result_type)}</span>
      <span className="text-gray-400 tabular-nums text-right">
        {formatCount(k.balls_before, k.strikes_before)}
        {k.pitch_sequence ? <span className="text-gray-300 ml-1">{k.pitch_sequence}</span> : null}
      </span>
    </div>
  )

  return (
    <div className="mt-2 border border-gray-200 rounded overflow-hidden">
      <div className="bg-portal-purple text-portal-cream text-[9.5px] px-2 py-1 font-bold uppercase tracking-widest flex justify-between">
        <span>{headerLabel}</span>
        <span className="text-[8.5px] text-portal-cream/70 font-normal normal-case tracking-normal">
          most recent first · {oppHeader} · count + sequence
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 px-2 py-1">
        <div>{left.map(renderRow)}</div>
        <div>{right.map(renderRow)}</div>
      </div>
    </div>
  )
}


// ───────────────────────────────────────────────────────────
// Vs-Team panel — when the user has a portal team set, show this
// player's stats against that team's pitchers (or, for a pitcher
// card, against that team's hitters). Renders an overall slash line
// + the top 3 individual matchups by sample size.
//
// Sits in the leftover vertical space below the percentile bars and
// `flex-1` grows to match the spray chart's height.
// ───────────────────────────────────────────────────────────
function VsTeamPanel({ playerId, side, portalTeam }) {
  const teamId = portalTeam?.id || null
  const { data, loading } = usePlayerVsTeam(playerId, teamId, side)
  const teamLabel = portalTeam?.short_name || portalTeam?.name || 'your team'

  // Empty state — no portal team selected
  if (!teamId) {
    return (
      <div className="border border-dashed border-gray-300 rounded p-2 flex-1 flex items-center justify-center text-center">
        <div className="text-[9px] text-gray-400 leading-tight">
          Set your team in the portal to see this player's history vs your roster.
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="border border-gray-200 rounded p-2 flex-1 animate-pulse">
        <div className="text-[10px] uppercase tracking-widest text-portal-purple-dark font-bold mb-1">
          Vs {teamLabel}…
        </div>
      </div>
    )
  }

  if (!data || !data.overall) {
    return (
      <div className="border border-gray-200 rounded p-2 flex-1">
        <div className="text-[10px] uppercase tracking-widest text-portal-purple-dark font-bold mb-1">
          Vs {teamLabel}
        </div>
        <div className="text-[9.5px] text-gray-500 italic mt-2">
          No PA recorded against {teamLabel} this season.
        </div>
      </div>
    )
  }

  const isPitcher = side === 'pitching'
  const o = data.overall
  const matchups = data.matchups || []

  // Sort matchups: best for the *opposing coach* first.
  // For HITTER cards (pitcher matchups), opposing coach wants pitchers
  //   who held this guy down → low wOBA = "best"
  // For PITCHER cards (hitter matchups), opposing coach wants hitters
  //   who got to this pitcher → high wOBA = "best"
  const bestSorted = [...matchups].sort((a, b) =>
    isPitcher ? (b.woba - a.woba) : (a.woba - b.woba))
  const worstSorted = [...matchups].sort((a, b) =>
    isPitcher ? (a.woba - b.woba) : (b.woba - a.woba))
  const topN = 3

  const renderMiniRow = (m) => {
    const score = thresholdScore(isPitcher ? 'opp_woba' : 'woba', m.woba)
    const bg = score != null ? scoreColor(score, 0.85) : undefined
    return (
      <div key={m.player_id}
           className="flex justify-between items-baseline border-b border-gray-100 last:border-0 py-0.5">
        <span className="text-gray-700 truncate text-[9.5px]">{m.name}</span>
        <div className="flex items-baseline gap-1.5 shrink-0">
          <span className="font-semibold tabular-nums px-1 rounded text-[9.5px]"
                style={bg ? { backgroundColor: bg } : undefined}>
            {fmt.rate(m.woba)}
          </span>
          <span className="text-[8.5px] text-gray-400 tabular-nums w-12 text-right">
            {m.h}/{m.ab} · {m.pa}pa
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="border border-gray-200 rounded p-2 flex-1 flex flex-col">
      {/* Header — bold so coaches scan to it fast */}
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-[10px] uppercase tracking-widest text-portal-purple-dark font-bold">
          Vs {teamLabel}
        </div>
        <div className="text-[8.5px] text-gray-400">
          {data.games} {data.games === 1 ? 'game' : 'games'}
        </div>
      </div>

      {/* Overall line — compact 2-row stat strip */}
      <div className="bg-portal-purple/5 border border-portal-purple/15 rounded px-2 py-1 mb-1.5">
        <div className="flex justify-between text-[9px] text-gray-500 leading-none mb-0.5 font-bold uppercase tracking-wider">
          <span>{o.pa} PA · {o.h}-{o.ab}</span>
          <span>{isPitcher ? 'Allowed' : 'Slash'}</span>
        </div>
        <div className="grid grid-cols-6 gap-1 text-[9.5px] tabular-nums">
          <Cell label="AVG"  val={o.avg}  fmt={fmt.rate} stat="batting_avg"  flip={isPitcher} />
          <Cell label="OBP"  val={o.obp}  fmt={fmt.rate} stat="on_base_pct"  flip={isPitcher} />
          <Cell label="SLG"  val={o.slg}  fmt={fmt.rate} stat="slugging_pct" flip={isPitcher} />
          <Cell label="wOBA" val={o.woba} fmt={fmt.rate} stat={isPitcher ? 'opp_woba' : 'woba'} />
          <Cell label="K%"   val={o.k_pct} fmt={fmt.pct}  stat="k_pct" flip={!isPitcher} />
          <Cell label="BB%"  val={o.bb_pct} fmt={fmt.pct} stat="bb_pct" flip={isPitcher} />
        </div>
      </div>

      {/* Top matchups — best vs worst for the opposing coach */}
      <div className="grid grid-cols-2 gap-1.5 flex-1 overflow-hidden">
        <div>
          <div className="text-[9px] font-bold uppercase tracking-wider text-emerald-700 mb-0.5">
            {isPitcher ? 'Hot Hitters' : 'Best Pitchers'}
          </div>
          {bestSorted.slice(0, topN).map(renderMiniRow)}
        </div>
        <div>
          <div className="text-[9px] font-bold uppercase tracking-wider text-rose-700 mb-0.5">
            {isPitcher ? 'Cold Hitters' : 'Worst Pitchers'}
          </div>
          {worstSorted.slice(0, topN).map(renderMiniRow)}
        </div>
      </div>
    </div>
  )
}

// Tiny stat strip cell. `flip` swaps the threshold direction (used so
// e.g. K% looks bad on a hitter card but good on a pitcher card).
function Cell({ label, val, fmt: fmter, stat, flip = false }) {
  // For a "flip", we flip the score around 50.
  let score = stat ? thresholdScore(stat, val) : null
  if (flip && score != null) score = 100 - score
  const bg = score != null ? scoreColor(score, 0.85) : undefined
  return (
    <div className="flex flex-col items-center">
      <span className="text-[8px] text-gray-500 leading-none">{label}</span>
      <span className="font-semibold tabular-nums px-1 rounded leading-tight"
            style={bg ? { backgroundColor: bg } : undefined}>
        {fmter(val)}
      </span>
    </div>
  )
}


// ───────────────────────────────────────────────────────────
// Count States — Hitter's / Neutral / Pitcher's / 2-strike.
// Compact mini-card with wOBA + sample size per count state.
// ───────────────────────────────────────────────────────────
function CountStatesPanel({ side, hitterPbp, pitcherPbp }) {
  const states = (side === 'pitching' ? pitcherPbp?.count_states : hitterPbp?.count_states) || []
  const isPitcher = side === 'pitching'
  // Picks: hitters, neutral, pitchers, two_strike
  const wanted = ['hitters', 'neutral', 'pitchers', 'two_strike']
  const labels = { hitters: "Hitter's", neutral: 'Neutral', pitchers: "Pitcher's", two_strike: '2-Strike' }
  return (
    <MiniCard title="Count States">
      {wanted.map(k => {
        const block = states.find(s => s.filter_key === k)
        const woba = block?.woba ?? null
        const score = thresholdScore(isPitcher ? 'opp_woba' : 'woba', woba)
        const bg = score != null ? scoreColor(score, 0.85) : undefined
        return (
          <div key={k} className="flex justify-between items-baseline border-b border-gray-100 last:border-0 py-0.5">
            <span className="text-gray-600 text-[9px]">{labels[k]}</span>
            <div className="flex items-baseline gap-1">
              <span className="font-semibold tabular-nums px-1 rounded"
                    style={bg ? { backgroundColor: bg } : undefined}>
                {fmt.rate(woba)}
              </span>
              <span className="text-[8px] text-gray-400 tabular-nums">
                {block?.pa ?? 0}pa
              </span>
            </div>
          </div>
        )
      })}
    </MiniCard>
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

function StatLine({ label, value, statKey, rawValue }) {
  // If a statKey is given, color-code the value based on the threshold
  // table so coaches get a quick read on each stat without having to
  // remember what's good for college baseball. Pass `rawValue` (the
  // numeric value before formatting) when the displayed `value` is a
  // pre-formatted string like "30.5%".
  const score = statKey != null ? thresholdScore(statKey, rawValue ?? value) : null
  const bg = score != null ? scoreColor(score, 0.85) : undefined
  return (
    <div className="flex justify-between items-baseline border-b border-gray-100 last:border-0 py-0.5">
      <span className="text-gray-600">{label}</span>
      <span className="font-semibold tabular-nums px-1 rounded"
            style={bg ? { backgroundColor: bg } : undefined}>
        {value}
      </span>
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


// Tiny helper: render a number cell with threshold-based shading.
function ColoredCell({ value, statKey, formatter, className = '' }) {
  const score = statKey ? thresholdScore(statKey, value) : null
  const bg = score != null ? scoreColor(score, 0.85) : undefined
  return (
    <td className={`px-1.5 py-1 text-right tabular-nums ${className}`}>
      <span className="px-1 rounded" style={bg ? { backgroundColor: bg } : undefined}>
        {formatter ? formatter(value) : (value ?? '–')}
      </span>
    </td>
  )
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
              <ColoredCell value={r.batting_avg}  statKey="batting_avg"  formatter={fmt.rate} />
              <ColoredCell value={r.on_base_pct}  statKey="on_base_pct"  formatter={fmt.rate} />
              <ColoredCell value={r.slugging_pct} statKey="slugging_pct" formatter={fmt.rate} />
              <ColoredCell value={r.woba}         statKey="woba"         formatter={fmt.rate} />
              <ColoredCell value={r.wrc_plus}     statKey="wrc_plus"
                formatter={v => v != null ? Math.round(v) : '–'} />
              <td className="px-1.5 py-1 text-right font-semibold tabular-nums">{fmt.war(r.offensive_war)}</td>
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
              <ColoredCell value={r.era}  statKey="era"  formatter={fmt.era} />
              <ColoredCell value={r.fip}  statKey="fip"  formatter={fmt.era} />
              <ColoredCell value={r.whip} statKey="whip" formatter={fmt.era} />
              <td className="px-1.5 py-1 text-right">{fmt.ip(r.innings_pitched)}</td>
              <td className="px-1.5 py-1 text-right">{r.hits_allowed || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.walks || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.strikeouts || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.home_runs_allowed || 0}</td>
              <td className="px-1.5 py-1 text-right">{r.k_pct != null ? `${(r.k_pct * 100).toFixed(1)}%` : '–'}</td>
              <td className="px-1.5 py-1 text-right">{r.bb_pct != null ? `${(r.bb_pct * 100).toFixed(1)}%` : '–'}</td>
              <ColoredCell value={r.opp_avg} statKey="opp_avg" formatter={fmt.rate} />
              <td className="px-1.5 py-1 text-right font-semibold tabular-nums">{fmt.war(r.pitching_war)}</td>
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
