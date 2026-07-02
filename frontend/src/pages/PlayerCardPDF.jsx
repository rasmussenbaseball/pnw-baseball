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

import { useEffect, useRef } from 'react'
import ReportActions from '../components/ReportActions'
import { useParams, useSearchParams } from 'react-router-dom'
import {
  usePlayer,
  usePlayerPitchLevelStats,
  usePlayerPitchLevelStatsPitcher,
  usePlayerVsTeam,
  usePlayerRecentKs,
  usePlayerGameLogs,
} from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'
import SprayChart from '../components/SprayChart'
import { CURRENT_SEASON } from '../lib/seasons'
import { toneAttr } from '../lib/reportExport'


const SEASON = CURRENT_SEASON


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
            data-bar
            style={{ width: `${pct}%`, backgroundColor: pctColor(pct) }}
          />
        )}
        <div className="absolute inset-y-0 left-1/2 w-px bg-gray-300" />
      </div>
      <div className="text-[10px] tabular-nums w-12 text-right font-semibold" {...toneAttr(pct)}>
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
// Page wrapper (URL-driven) — the route entry point. Reads
// playerId from the URL and `?side=` from query, then defers
// the heavy lifting to <PlayerCard> below. The inner component
// accepts playerId/side as PROPS so the bulk view can stack
// many cards on one big print run without touching the URL.
// ───────────────────────────────────────────────────────────
export default function PlayerCardPDF() {
  const { playerId } = useParams()
  const [searchParams] = useSearchParams()
  const sideParam = searchParams.get('side')   // 'batting' | 'pitching' | null
  return (
    <PlayerCard
      playerId={playerId}
      sideParam={sideParam}
      showToolbar={true}
    />
  )
}


// ───────────────────────────────────────────────────────────
// PlayerCard — the actual one-page profile, parameterized by
// playerId + sideParam props. Used both by PlayerCardPDF (single
// view, with the print toolbar) and by BulkPlayerCards (many
// instances stacked, no per-card toolbar).
// ───────────────────────────────────────────────────────────
export function PlayerCard({ playerId, sideParam, showToolbar = true }) {
  const cardRef = useRef(null)
  const { data, loading, error } = usePlayer(playerId, null)
  const { data: hitterPbp } = usePlayerPitchLevelStats(playerId, SEASON)
  const { data: pitcherPbp } = usePlayerPitchLevelStatsPitcher(playerId, SEASON)
  // Portal team — when set, we fetch this player's stats vs that team
  // and render a vs-team panel in the leftover space below the
  // percentile bars. Skipped entirely when no portal team is set
  // (the panel falls back to a "set your team" prompt).
  const { team: portalTeam } = usePortalTeam()

  // Set the document title so the browser's "Save as PDF" dialog
  // pre-fills a useful filename like "Sharp_Andrew_Hitting_2026.pdf".
  // We don't restore on unmount — the next portal page's own
  // useEffect overrides this title, which is more reliable than
  // trying to capture/restore (React 18 effect double-invocation
  // could capture the player name as the "original" title).
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
    document.title = `${safe(data.player.last_name)}_${safe(data.player.first_name)}_${sideLabel}_${SEASON}`
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
      {/* Toolbar — hidden on print AND in bulk mode (the bulk page
          shows its own single Print button at the top instead of one
          per card). */}
      {showToolbar && (
        <div className="flex items-center justify-between gap-3 mb-3 print:hidden">
          <h1 className="text-lg font-bold text-portal-purple-dark">
            Player Card · {player.first_name} {player.last_name} ·{' '}
            <span className="capitalize">{side}</span>
          </h1>
          <ReportActions targetRef={cardRef}
            filename={`card_${player.last_name || 'player'}_${player.first_name || ''}_${side}`.replace(/\s+/g, '')} />
        </div>
      )}

      <section className="card-page" ref={cardRef}>
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

        {/* Notes panel — flex-grows to absorb any vertical space the
            content above didn't claim. Coaches get a clean spot to
            jot in-game observations on the printed sheet. */}
        <div className="sheet-notes mt-2">
          <div className="sheet-notes-label">Notes</div>
        </div>
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
// `filter` (custom card builder) locks the spray to one split so several fixed
// spray charts can be stacked. Default 'all' keeps the original interactive card.
const SPRAY_TITLES = { all: 'Spray Chart', vs_rhp: 'Spray vs RHP', vs_lhp: 'Spray vs LHP',
  vs_rhb: 'Opp Spray vs RHB', vs_lhb: 'Opp Spray vs LHB', xbh: 'XBH Spray', hr: 'HR Spray' }
function SprayPanel({ side, hitterPbp, pitcherPbp, player, filter = 'all' }) {
  // Hitter: own spray. Pitcher: opposing batters' spray vs this pitcher.
  const data = side === 'pitching' ? pitcherPbp?.opp_spray_chart : hitterPbp?.spray_chart
  const title = filter !== 'all'
    ? (SPRAY_TITLES[filter] || 'Spray Chart')
    : (side === 'pitching' ? 'Opp. Spray vs This Pitcher' : 'Spray Chart')
  // For the SprayChart component, `bats` controls pull/oppo orientation;
  // for pitcher mode we pass through but the spray chart's mode handles it.
  const bats = side === 'pitching' ? null : (player?.bats || 'R')
  const mode = side === 'pitching' ? 'pitcher' : 'hitter'
  return (
    <div className="border border-gray-200 rounded p-2 flex flex-col">
      <div className="text-[10px] uppercase tracking-widest text-portal-purple-dark font-bold mb-1">
        {title}
      </div>
      <div className="flex-1 min-h-[180px]">
        {data ? (
          <SprayChart data={data} bats={bats} mode={mode}
            defaultFilter={filter} staticFilter={filter !== 'all' ? filter : null} />
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
      {/* A real <table> (not a CSS grid) so html2canvas image export renders
          the rows correctly — grid auto-flow with fragment cells collapsed the
          rows in the saved PNG. */}
      <table className="w-full text-[9.5px] tabular-nums" style={{ borderCollapse: 'collapse' }}>
        <colgroup>
          <col />
          {cols.map(([k]) => <col key={k} style={{ width: '34px' }} />)}
        </colgroup>
        <thead>
          <tr>
            <th />
            {cols.map(([_, label]) => (
              <th key={label} className="text-[8.5px] text-gray-500 text-right font-bold pb-0.5">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.label}>
              <td className="text-gray-700 pr-1">{r.label}</td>
              {cols.map(([colKey]) => {
                const block = lookup(colKey)
                const raw = cellValue(block, r.keys)
                const score = r.threshold ? thresholdScore(r.threshold, raw) : null
                const bg = score != null ? scoreColor(score, 0.85) : undefined
                return (
                  <td key={colKey} className="text-right font-semibold">
                    <span className="px-1 rounded" {...toneAttr(score)} style={bg ? { backgroundColor: bg } : undefined}>
                      {r.fmt(raw)}
                    </span>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </MiniCard>
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
              <span className="font-semibold tabular-nums px-1 rounded" {...toneAttr(score)}
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
      <span className="font-semibold tabular-nums px-1 rounded" {...toneAttr(score)}
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
              <ColoredCell value={computeBaa(r)} statKey="opp_avg" formatter={fmt.rate} />
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

// Compute BAA from raw pitching_stats counts: H / (BF − BB − HBP).
// `pitching_stats` doesn't store opp_avg per season (only computed on
// the career rollup) so the table previously showed "–" for every
// per-season row. Falling back to this formula whenever opp_avg is
// null fills those gaps without a backend round-trip.
function computeBaa(r) {
  if (r?.opp_avg != null) return r.opp_avg
  const bf = r?.batters_faced
  const bb = r?.walks
  const hbp = r?.hit_batters
  const h = r?.hits_allowed
  if (bf == null || h == null) return null
  const denom = bf - (bb || 0) - (hbp || 0)
  return denom > 0 ? h / denom : null
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

// Reusable card blocks for the Custom Player Card builder (CustomPlayerCard.jsx).
// ═══════════════════════════════════════════════════════════
// NEW SCOUTING-REPORT BLOCKS (2026-07)
// Auto blocks derive from PBP/season data; report blocks take
// coach-entered config (cfg) from the builder.
// ═══════════════════════════════════════════════════════════

// ── "How to Attack" — auto-generated advance-scouting bullets ──
// For a HITTER card: how our pitchers should attack this opposing
// hitter. For a PITCHER card: how our hitters should attack this
// pitcher. Each candidate bullet carries a priority; we surface the
// most notable few. tone: exploit (green) / respect (amber) / note.
function buildAttackBullets(side, data, hitterPbp, pitcherPbp) {
  const out = []
  const push = (priority, tone, text) => out.push({ priority, tone, text })
  const num = v => (v == null ? null : Number(v))
  const pct = v => (v == null ? '–' : `${Math.round(Number(v) * 100)}%`)
  const rate = v => (v == null ? '–' : Number(v).toFixed(3).replace(/^0\./, '.'))
  const findK = (arr, k) => (Array.isArray(arr) ? arr.find(r => r.filter_key === k) : null)

  if (side === 'pitching') {
    const d = pitcherPbp?.discipline || {}
    const cp = pitcherPbp?.opp_contact_profile || {}
    const lr = pitcherPbp?.lr_splits || []
    const sit = pitcherPbp?.situational_splits || []
    const vR = findK(lr, 'vs_rhb'), vL = findK(lr, 'vs_lhb')
    const wR = num(vR?.opp_woba ?? vR?.woba), wL = num(vL?.opp_woba ?? vL?.woba)
    if (wR != null && wL != null && Math.abs(wR - wL) >= 0.045) {
      const weak = wR > wL ? 'RHH' : 'LHH'
      push(9, 'exploit', `Vulnerable vs ${weak} (${rate(Math.max(wR, wL))} wOBA) — stack ${weak === 'RHH' ? 'righties' : 'lefties'}.`)
    }
    const fps = num(d.first_pitch_strike_pct)
    if (fps != null && fps < 0.55) push(8, 'exploit', `Falls behind (${pct(fps)} first-pitch strikes) — be patient, work the count.`)
    else if (fps != null && fps >= 0.65) push(4, 'respect', `Attacks the zone early (${pct(fps)} FPS) — be ready to hit.`)
    const whiff = num(d.whiff_pct)
    if (whiff != null && whiff < 0.20) push(7, 'exploit', `Doesn't miss bats (${pct(whiff)} whiff) — put it in play, make him work.`)
    else if (whiff != null && whiff >= 0.30) push(6, 'respect', `Swing-and-miss stuff (${pct(whiff)} whiff) — shorten up with two strikes.`)
    const gb = num(cp.gb_pct), fb = num(cp.fb_pct)
    if (gb != null && gb >= 0.52) push(6, 'exploit', `Sinker/ground-ball type (${pct(gb)} GB) — get on top, drive it in the air.`)
    else if (fb != null && fb >= 0.45) push(5, 'exploit', `Fly-ball prone (${pct(fb)} FB) — look to elevate and do damage.`)
    const bb = num(d.bb_pct ?? vR?.bb_pct)
    if (bb != null && bb >= 0.11) push(5, 'exploit', `Command wavers (${pct(bb)} BB) — make him throw strikes.`)
    const risp = findK(sit, 'risp')
    const rw = num(risp?.opp_woba ?? risp?.woba)
    if (rw != null && rw >= 0.360) push(4, 'exploit', `Hittable with runners on (${rate(rw)} wOBA w/ RISP).`)
  } else {
    const d = hitterPbp?.discipline || {}
    const cp = hitterPbp?.contact_profile || {}
    const lr = hitterPbp?.lr_splits || []
    const sit = hitterPbp?.situational_splits || []
    const vR = findK(lr, 'vs_rhp'), vL = findK(lr, 'vs_lhp')
    const wR = num(vR?.woba), wL = num(vL?.woba)
    if (wR != null && wL != null && Math.abs(wR - wL) >= 0.045) {
      const weak = wR < wL ? 'RHP' : 'LHP'
      push(9, 'exploit', `Weaker vs ${weak} (${rate(Math.min(wR, wL))} wOBA) — favor ${weak === 'RHP' ? 'righties' : 'lefties'}.`)
    }
    const whiff = num(d.whiff_pct)
    const contact = num(d.contact_pct)
    if (whiff != null && whiff >= 0.30) push(8, 'exploit', `Swing-and-miss (${pct(whiff)} whiff) — expand out of the zone with two strikes.`)
    else if (contact != null && contact >= 0.85) push(7, 'respect', `Elite bat-to-ball (${pct(contact)} contact) — don't expect Ks, pitch to soft contact.`)
    const iso = num(vR?.iso ?? vL?.iso)
    const airPull = num(cp.air_pull_pct)
    if (airPull != null && airPull >= 0.20) push(7, 'respect', `Pull-side power (${pct(airPull)} air-pull) — avoid middle-in, work him away.`)
    else if (iso != null && iso <= 0.090) push(6, 'exploit', `Little power (${rate(iso)} ISO) — challenge in the zone, dare him to drive it.`)
    const kp = num(d.putaway_pct)
    if (kp != null && kp >= 0.24) push(5, 'exploit', `Chases the K (${pct(kp)} putaway) — bury the two-strike pitch.`)
    const bb = num(vR?.bb_pct ?? vL?.bb_pct)
    if (bb != null && bb >= 0.13) push(5, 'respect', `Patient (${pct(bb)} BB) — he'll take his walks, so throw strikes.`)
    const gb = num(cp.gb_pct)
    if (gb != null && gb >= 0.52) push(4, 'note', `Ground-ball heavy (${pct(gb)} GB) — set the infield.`)
    const risp = findK(sit, 'risp')
    const rw = num(risp?.woba)
    if (rw != null && rw >= 0.400) push(4, 'respect', `Dangerous with RISP (${rate(rw)} wOBA) — pitch carefully.`)
  }
  return out.sort((a, b) => b.priority - a.priority).slice(0, 5)
}

function TendenciesPanel({ side, hitterPbp, pitcherPbp, data }) {
  const bullets = buildAttackBullets(side, data, hitterPbp, pitcherPbp)
  const toneDot = { exploit: '#16a34a', respect: '#d97706', note: '#6b7280' }
  return (
    <MiniCard title={side === 'pitching' ? 'How to Attack (Pitcher)' : 'How to Attack (Hitter)'}>
      {bullets.length === 0 ? (
        <div className="text-[9.5px] text-gray-400 italic">Not enough play-by-play data for auto notes.</div>
      ) : (
        <ul className="space-y-1">
          {bullets.map((b, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span className="mt-[3px] w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: toneDot[b.tone] }} />
              <span className="text-[9.5px] text-gray-700 leading-snug">{b.text}</span>
            </li>
          ))}
        </ul>
      )}
    </MiniCard>
  )
}


// ── Season Trend — rolling sparkline from per-game logs ──
function TrendPanel({ playerId, side }) {
  const { data } = usePlayerGameLogs(playerId, SEASON)
  const isPitcher = side === 'pitching'
  const logs = isPitcher ? (data?.pitching || data?.pitching_logs) : (data?.batting || data?.batting_logs)
  const games = Array.isArray(logs) ? logs : []

  // Per-game metric: hitter OPS, pitcher game score (fallback: -ERA-ish).
  const series = []
  for (const g of games) {
    if (isPitcher) {
      const gs = g.game_score ?? g.gameScore
      if (gs != null) series.push(Number(gs))
    } else {
      const ab = Number(g.ab ?? g.at_bats ?? 0)
      const bb = Number(g.bb ?? g.walks ?? 0)
      const hbp = Number(g.hbp ?? g.hit_by_pitch ?? 0)
      const sf = Number(g.sf ?? g.sacrifice_flies ?? 0)
      const h = Number(g.h ?? g.hits ?? 0)
      const d2 = Number(g['2b'] ?? g.doubles ?? 0)
      const t3 = Number(g['3b'] ?? g.triples ?? 0)
      const hr = Number(g.hr ?? g.home_runs ?? 0)
      const pa = ab + bb + hbp + sf
      if (pa <= 0) continue
      const tb = (h - d2 - t3 - hr) + 2 * d2 + 3 * t3 + 4 * hr
      const obp = (h + bb + hbp) / pa
      const slg = ab > 0 ? tb / ab : 0
      series.push(obp + slg)
    }
  }

  const label = isPitcher ? 'Game Score' : 'OPS'
  if (series.length < 4) {
    return <MiniCard title={`Season Trend · ${label}`}><div className="text-[9.5px] text-gray-400 italic">Not enough games yet.</div></MiniCard>
  }

  // Rolling average (window 5, trailing) to smooth college noise.
  const win = Math.min(5, Math.max(3, Math.round(series.length / 6)))
  const roll = series.map((_, i) => {
    const s = Math.max(0, i - win + 1)
    const slice = series.slice(s, i + 1)
    return slice.reduce((a, b) => a + b, 0) / slice.length
  })

  const W = 250, H = 66, PAD = 4
  const all = series.concat(roll)
  const lo = Math.min(...all), hi = Math.max(...all)
  const span = hi - lo || 1
  const x = i => PAD + (i / (series.length - 1)) * (W - 2 * PAD)
  const y = v => (H - PAD) - ((v - lo) / span) * (H - 2 * PAD)
  const rollPath = roll.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const last = roll[roll.length - 1]
  const first = roll[0]
  const up = last >= first
  const fmtV = v => isPitcher ? Math.round(v) : v.toFixed(3).replace(/^0\./, '.')

  return (
    <MiniCard title={`Season Trend · ${label}`}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} className="block">
        {/* per-game dots */}
        {series.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r="1.3" fill="#cbd5e1" />
        ))}
        {/* rolling avg line */}
        <path d={rollPath} fill="none" stroke={up ? '#16a34a' : '#dc2626'} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="flex justify-between text-[8.5px] text-gray-500 mt-0.5">
        <span>{games.length} G · {win}-game avg</span>
        <span className="tabular-nums">start {fmtV(first)} → now <b className={up ? 'text-green-700' : 'text-rose-700'}>{fmtV(last)}</b></span>
      </div>
    </MiniCard>
  )
}


// ── Scouting Grades — 20-80 present/future + auto OFP ──
const HIT_TOOLS = [['hit', 'Hit'], ['power', 'Power'], ['run', 'Run'], ['arm', 'Arm'], ['field', 'Field']]
const PIT_TOOLS = [['fastball', 'Fastball'], ['breaking', 'Breaking'], ['changeup', 'Changeup'], ['command', 'Command']]
const gradeScore = g => (g == null ? null : Math.max(0, Math.min(100, ((Number(g) - 20) / 60) * 100)))
function ofpRole(ofp) {
  if (ofp == null) return ''
  if (ofp >= 70) return 'Elite / high-major'
  if (ofp >= 60) return 'Plus regular / D1'
  if (ofp >= 55) return 'Above-avg / D1'
  if (ofp >= 50) return 'Everyday / D1-D2'
  if (ofp >= 45) return 'Role player / D2-NAIA'
  if (ofp >= 40) return 'Depth / NAIA-JUCO'
  return 'Developmental'
}
function GradesPanel({ side, cfg }) {
  const tools = side === 'pitching' ? PIT_TOOLS : HIT_TOOLS
  const grades = cfg?.grades || {}
  const futures = tools.map(([k]) => Number(grades[k]?.f ?? grades[k]?.future)).filter(v => !Number.isNaN(v) && v > 0)
  const ofp = futures.length ? Math.round((futures.reduce((a, b) => a + b, 0) / futures.length) / 5) * 5 : null
  return (
    <MiniCard title="Scouting Grades (20-80)">
      <table className="w-full text-[9.5px] tabular-nums" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th />
            <th className="text-[8.5px] text-gray-500 text-center font-bold pb-0.5 w-8">P</th>
            <th className="text-[8.5px] text-gray-500 text-center font-bold pb-0.5 w-8">F</th>
          </tr>
        </thead>
        <tbody>
          {tools.map(([k, label]) => {
            const p = grades[k]?.p ?? grades[k]?.present
            const f = grades[k]?.f ?? grades[k]?.future
            return (
              <tr key={k}>
                <td className="text-gray-700 pr-1">{label}</td>
                {[p, f].map((g, i) => (
                  <td key={i} className="text-center font-semibold">
                    <span className="px-1 rounded inline-block min-w-[18px]" {...toneAttr(g ? gradeScore(g) : null)}
                      style={{ backgroundColor: g ? scoreColor(gradeScore(g), 0.8) : undefined }}>
                      {g || '–'}
                    </span>
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="flex items-center justify-between mt-1 pt-1 border-t border-gray-200">
        <span className="text-[9px] font-bold text-portal-purple-dark">OFP {ofp ?? '–'}</span>
        <span className="text-[8.5px] text-gray-500">{ofpRole(ofp)}</span>
      </div>
    </MiniCard>
  )
}


// ── Measurables — coach-entered, benchmark-shaded ──
// Benchmarks are APPROXIMATE college reference points (verify vs
// Perfect Game / PBR before treating as gospel). dir: lower/higher.
const MEAS = [
  { key: 'sixty', label: '60-yd dash', unit: 's', dir: 'lower', good: 6.6, mid: 6.9, bad: 7.2 },
  { key: 'home1b', label: 'Home to 1B', unit: 's', dir: 'lower', good: 4.10, mid: 4.25, bad: 4.45 },
  { key: 'exit', label: 'Exit velo', unit: '', dir: 'higher', good: 95, mid: 88, bad: 82 },
  { key: 'of_velo', label: 'OF velo', unit: '', dir: 'higher', good: 90, mid: 84, bad: 78 },
  { key: 'if_velo', label: 'IF velo', unit: '', dir: 'higher', good: 85, mid: 80, bad: 74 },
  { key: 'pop', label: 'Pop time', unit: 's', dir: 'lower', good: 1.95, mid: 2.05, bad: 2.20 },
  { key: 'c_velo', label: 'C velo', unit: '', dir: 'higher', good: 80, mid: 74, bad: 68 },
  { key: 'fb_velo', label: 'FB velo', unit: '', dir: 'higher', good: 92, mid: 87, bad: 82 },
]
const MEAS_BY_KEY = Object.fromEntries(MEAS.map(m => [m.key, m]))
function measScore(m, v) {
  if (v == null || v === '') return null
  const x = Number(v)
  if (Number.isNaN(x)) return null
  if (m.dir === 'lower') {
    if (x <= m.good) return 88
    if (x >= m.bad) return 12
    if (x <= m.mid) return 60
    return 32
  }
  if (x >= m.good) return 88
  if (x <= m.bad) return 12
  if (x >= m.mid) return 60
  return 32
}
function MeasurablesPanel({ player, cfg }) {
  const vals = cfg?.values || {}
  // Auto-seed height/weight from the player if the coach hasn't typed them.
  const ht = vals.height || player?.height
  const wt = vals.weight || player?.weight
  const rows = MEAS.filter(m => vals[m.key] != null && vals[m.key] !== '')
  return (
    <MiniCard title="Measurables">
      {(ht || wt) && (
        <div className="text-[9.5px] text-gray-700 mb-1 pb-1 border-b border-gray-100">
          {ht && <span className="mr-2"><b>Ht</b> {ht}</span>}
          {wt && <span><b>Wt</b> {wt}</span>}
        </div>
      )}
      {rows.length === 0 ? (
        <div className="text-[9px] text-gray-400 italic">Add measurables in the builder.</div>
      ) : rows.map(m => {
        const v = vals[m.key]
        const bg = scoreColor(measScore(m, v), 0.8)
        return (
          <div key={m.key} className="flex justify-between items-baseline border-b border-gray-100 last:border-0 py-0.5">
            <span className="text-gray-600 text-[9.5px]">{m.label}</span>
            <span className="font-semibold tabular-nums text-[9.5px] px-1 rounded" {...toneAttr(measScore(m, v))} style={{ backgroundColor: bg }}>
              {v}{m.unit}
            </span>
          </div>
        )
      })}
      <div className="text-[7.5px] text-gray-400 mt-1 italic">Shading vs approx. college benchmarks.</div>
    </MiniCard>
  )
}


// ── Scout's Take — narrative; blank ruled lines if empty (write-in) ──
function ScoutTakePanel({ cfg }) {
  const text = (cfg?.text || '').trim()
  return (
    <MiniCard title="Scout's Take">
      {text ? (
        <div className="text-[10px] text-gray-800 leading-snug whitespace-pre-wrap">{text}</div>
      ) : (
        <div className="pt-1">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="border-b border-gray-300 mt-3" style={{ height: '1px' }} />
          ))}
        </div>
      )}
    </MiniCard>
  )
}


// ── Notes — a titled blank box of ruled lines (great for bulk print) ──
function NotesLinesPanel({ cfg }) {
  const title = cfg?.title || 'Notes'
  const lines = Math.max(2, Math.min(8, Number(cfg?.lines) || 4))
  const text = (cfg?.text || '').trim()
  return (
    <MiniCard title={title}>
      {text ? (
        <div className="text-[10px] text-gray-800 leading-snug whitespace-pre-wrap">{text}</div>
      ) : (
        <div className="pt-1">
          {Array.from({ length: lines }).map((_, i) => (
            <div key={i} className="border-b border-gray-300 mt-3" style={{ height: '1px' }} />
          ))}
        </div>
      )}
    </MiniCard>
  )
}


export {
  CardHeader, PercentilePanel, SprayPanel, DisciplinePanel, BattedBallPanel,
  SplitsPanel, CountStatesPanel, SeasonStatsTable, SummerBallTable,
  RecentKsPanel, VsTeamPanel,
  TendenciesPanel, TrendPanel, GradesPanel, MeasurablesPanel,
  ScoutTakePanel, NotesLinesPanel,
  MEAS, MEAS_BY_KEY, HIT_TOOLS, PIT_TOOLS,
}
