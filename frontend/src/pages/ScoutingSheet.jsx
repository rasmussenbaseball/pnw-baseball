// ScoutingSheet — printable per-team roster sheet.
//
// One US Letter page of hitters, one page of pitchers.  Matches the
// 643 Charts visual format but powered by NWBB Stats data:
//
//   HITTERS  (13 stats):
//     PA, wOBA vR, wOBA vL, GB% or FB%, K%, BB%, ISO, SB/SBA,
//     HR/FB, Contact%, First Pitch Swing%, Swing%, Putaway%
//
//   PITCHERS (11 stats):
//     IP, wOBA vR, wOBA vL, K%, BB%, Whiff%, ISO against,
//     BAA against, GB% or FB%, Strike%, FPS%
//
// Cells are shaded by percentile vs the team's conference cohort
// (green = elite, white = avg, red = poor).  Player names are red
// for lefties, blue for righties, purple for switch hitters.
//
// Print: a "Print / Save PDF" button calls window.print(); the
// `@media print` rules in src/styles/index.css strip the portal
// chrome so each table prints on its own page.

import { useParams } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'


// Default season is 2026 — same as the rest of the portal.
const SEASON = 2026


// ─────────────────────────────────────────────────────────
// Cell-shade palette — green→white→red gradient.  Mirrors
// the 643 Charts inspiration (good = green, bad = red).
// Pass `direction='neutral'` for stats that should always
// stay gray (e.g. GB%/FB% pick — high or low isn't "good").
// ─────────────────────────────────────────────────────────
function pctColor(pct, direction = 'higher_better') {
  if (pct == null) return 'transparent'
  if (direction === 'neutral') return 'transparent'
  // For 'lower_better' the percentile is already inverted server-side;
  // the value here is "how good is this", so high pct = green either way.
  const p = Math.max(0, Math.min(100, pct)) / 100
  let r, g, b, a
  if (p >= 0.5) {
    // green half: white (255,255,255) → green (162,210,162)
    const t = (p - 0.5) * 2
    r = Math.round(255 + (162 - 255) * t)
    g = Math.round(255 + (210 - 255) * t)
    b = Math.round(255 + (162 - 255) * t)
    a = 0.55 + 0.40 * t  // softer near the middle, stronger at the extreme
  } else {
    // red half: white (255,255,255) → red (245,170,170)
    const t = (0.5 - p) * 2
    r = Math.round(255 + (245 - 255) * t)
    g = Math.round(255 + (170 - 255) * t)
    b = Math.round(255 + (170 - 255) * t)
    a = 0.55 + 0.40 * t
  }
  return `rgba(${r},${g},${b},${a})`
}


// Player name color — red for lefties, blue for righties, purple
// for switch hitters.  Mirrors the 643 sheet convention.
function handColor(hand) {
  const h = (hand || '').toUpperCase()
  if (h === 'L') return '#c0392b'  // red
  if (h === 'R') return '#1f4e8c'  // blue
  if (h === 'B') return '#7d3c98'  // switch — purple blend
  return '#374151'                 // gray-700 fallback
}


// ─────────────────────────────────────────────────────────
// Cell formatters
// ─────────────────────────────────────────────────────────
const fmt = {
  int: v => (v == null ? '–' : Math.round(v)),
  rate: v => (v == null ? '–' : v.toFixed(3).replace(/^0\./, '.').replace(/^-0\./, '-.')),
  pct: v => (v == null ? '–' : `${(v * 100).toFixed(1)}%`),
  pct0: v => (v == null ? '–' : `${(v * 100).toFixed(0)}%`),
  ip: v => {
    if (v == null) return '–'
    // Postgres NUMERIC comes through as a string sometimes
    const n = typeof v === 'string' ? parseFloat(v) : v
    return n.toFixed(1)
  },
  raw: v => (v == null ? '–' : v),
  gbfb: row => {
    if (!row.gb_or_fb_type) return '–'
    return `${row.gb_or_fb_type} ${(row.gb_or_fb_value * 100).toFixed(1)}%`
  },
}


// ─────────────────────────────────────────────────────────
// Hitter columns spec
// `pctKey` selects which entry from row.percentiles drives the
// cell color; `direction` is 'neutral' for stats that should be
// gray no matter the percentile rank.
// ─────────────────────────────────────────────────────────
const HITTER_COLS = [
  { label: 'PA',          val: r => fmt.int(r.pa),                pctKey: 'pa',                    width: 28  },
  { label: 'wOBA vR',     val: r => fmt.rate(r.woba_vs_rhp),      pctKey: 'woba_vs_rhp',           width: 38  },
  { label: 'wOBA vL',     val: r => fmt.rate(r.woba_vs_lhp),      pctKey: 'woba_vs_lhp',           width: 38  },
  { label: 'GB / FB',     val: r => fmt.gbfb(r),                  pctKey: 'gb_or_fb_value',        width: 50, direction: 'neutral' },
  { label: 'K%',          val: r => fmt.pct(r.k_pct),             pctKey: 'k_pct',                 width: 38  },
  { label: 'BB%',         val: r => fmt.pct(r.bb_pct),            pctKey: 'bb_pct',                width: 38  },
  { label: 'ISO',         val: r => fmt.rate(r.iso),              pctKey: 'iso',                   width: 38  },
  { label: 'SB',          val: r => fmt.raw(r.sb_str),            pctKey: 'sb_made',               width: 32  },
  { label: 'HR/FB',       val: r => fmt.pct(r.hr_per_fb),         pctKey: 'hr_per_fb',             width: 42  },
  { label: 'Cont%',       val: r => fmt.pct(r.contact_pct),       pctKey: 'contact_pct',           width: 38  },
  { label: 'FPS%',        val: r => fmt.pct(r.first_pitch_swing_pct), pctKey: 'first_pitch_swing_pct', width: 38, direction: 'neutral' },
  { label: 'Sw%',         val: r => fmt.pct(r.swing_pct),         pctKey: 'swing_pct',             width: 38, direction: 'neutral' },
  { label: 'Put%',        val: r => fmt.pct(r.putaway_pct),       pctKey: 'putaway_pct',           width: 38  },
]

const PITCHER_COLS = [
  { label: 'IP',          val: r => fmt.ip(r.ip),                 pctKey: 'ip',                    width: 36  },
  { label: 'wOBA vR',     val: r => fmt.rate(r.woba_vs_rhh),      pctKey: 'woba_vs_rhh',           width: 42  },
  { label: 'wOBA vL',     val: r => fmt.rate(r.woba_vs_lhh),      pctKey: 'woba_vs_lhh',           width: 42  },
  { label: 'K%',          val: r => fmt.pct(r.k_pct),             pctKey: 'k_pct',                 width: 42  },
  { label: 'BB%',         val: r => fmt.pct(r.bb_pct),            pctKey: 'bb_pct',                width: 42  },
  { label: 'Whf%',        val: r => fmt.pct(r.whiff_pct),         pctKey: 'whiff_pct',             width: 42  },
  { label: 'ISO',         val: r => fmt.rate(r.iso_against),      pctKey: 'iso_against',           width: 42  },
  { label: 'BAA',         val: r => fmt.rate(r.baa_against),      pctKey: 'baa_against',           width: 42  },
  { label: 'GB / FB',     val: r => fmt.gbfb(r),                  pctKey: 'gb_or_fb_value',        width: 56, direction: 'neutral' },
  { label: 'Stk%',        val: r => fmt.pct(r.strike_pct),        pctKey: 'strike_pct',            width: 42  },
  { label: 'FPS%',        val: r => fmt.pct(r.fps_pct),           pctKey: 'fps_pct',               width: 42  },
]


// ─────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────
export default function ScoutingSheet() {
  // teamId can come from the URL (when linked from an index/picker) or
  // fall back to the user's selected portal team.
  const params = useParams()
  const { team: portalTeam } = usePortalTeam()
  const teamId = params.teamId
    ? parseInt(params.teamId, 10)
    : portalTeam?.id

  const { data, loading, error } = useApi(
    teamId ? `/portal/scouting-sheet/${teamId}` : null,
    { season: SEASON },
    [teamId]
  )

  if (!teamId) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <p className="text-gray-500">Select a team in the portal header to load a scouting sheet.</p>
      </div>
    )
  }
  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="text-gray-500 animate-pulse">Loading scouting sheet…</div>
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="text-rose-600">Could not load scouting sheet.</div>
      </div>
    )
  }

  const team = data.team || {}
  const hitters = data.hitters || []
  const pitchers = data.pitchers || []

  return (
    <div className="scouting-sheet-page max-w-[820px] mx-auto px-3 py-4 print:px-0 print:py-0 print:max-w-none">
      {/* Toolbar — hidden on print */}
      <div className="flex items-center justify-between gap-3 mb-3 print:hidden">
        <div>
          <h1 className="text-xl font-bold text-portal-purple-dark">
            Scouting Sheet — {team.short_name || team.name}
          </h1>
          <p className="text-xs text-gray-500">
            Season {data.season} · {team.conference_abbrev || team.conference_name || 'Unranked'} ·
            {' '}{hitters.length} hitters · {pitchers.length} pitchers ·
            {' '}qualified {data.cohort_size?.hitters_qualified}H / {data.cohort_size?.pitchers_qualified}P
            {' '}of {data.cohort_size?.hitters}H / {data.cohort_size?.pitchers}P in conference
          </p>
        </div>
        <button
          onClick={() => window.print()}
          className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                     bg-portal-purple text-portal-cream hover:bg-portal-purple-dark"
        >
          Print / Save as PDF
        </button>
      </div>

      {/* Page 1: HITTERS */}
      <section className="sheet-page">
        <SheetHeader team={team} season={data.season} side="HITTERS" count={hitters.length} />
        <RosterTable rows={hitters} cols={HITTER_COLS} handField="bats" />
        <SheetLegend kind="hitters" thresholds={data.thresholds} />
      </section>

      {/* Page break for print */}
      <div className="sheet-pagebreak" />

      {/* Page 2: PITCHERS */}
      <section className="sheet-page">
        <SheetHeader team={team} season={data.season} side="PITCHING STAFF" count={pitchers.length} />
        <RosterTable rows={pitchers} cols={PITCHER_COLS} handField="throws" />
        <SheetLegend kind="pitchers" thresholds={data.thresholds} />
      </section>
    </div>
  )
}


// ─────────────────────────────────────────────────────────
// Header banner — team logo, name, conference, season
// ─────────────────────────────────────────────────────────
function SheetHeader({ team, season, side, count }) {
  return (
    <div className="flex items-center gap-3 border-b-2 border-portal-purple pb-1.5 mb-2">
      {team.logo_url && (
        <img src={team.logo_url} alt="" className="h-10 w-10 object-contain" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 leading-none">
          {team.conference_abbrev || team.conference_name || 'Independent'} · {season}
        </div>
        <div className="text-base font-bold text-portal-purple-dark leading-tight truncate">
          {team.name || team.short_name}
        </div>
      </div>
      <div className="text-right">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 leading-none">
          {side}
        </div>
        <div className="text-base font-bold text-portal-purple-dark leading-tight">
          {count} players
        </div>
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────
// Roster table — one row per player, dense, color-shaded
// ─────────────────────────────────────────────────────────
function RosterTable({ rows, cols, handField }) {
  if (!rows.length) {
    return <div className="text-center text-gray-400 italic py-6 text-sm">No players found.</div>
  }
  // Sort by jersey_number numerically when possible, else by last name.
  const sorted = [...rows].sort((a, b) => {
    const ja = parseInt(a.jersey_number, 10)
    const jb = parseInt(b.jersey_number, 10)
    if (Number.isFinite(ja) && Number.isFinite(jb)) return ja - jb
    if (Number.isFinite(ja)) return -1
    if (Number.isFinite(jb)) return 1
    return (a.last_name || '').localeCompare(b.last_name || '')
  })

  return (
    <table className="w-full border-collapse text-[9px] leading-tight tabular-nums">
      <colgroup>
        <col style={{ width: 24 }} />   {/* # */}
        <col style={{ width: 130 }} />  {/* Name */}
        <col style={{ width: 28 }} />   {/* Pos */}
        <col style={{ width: 18 }} />   {/* B/T */}
        {cols.map((c, i) => <col key={i} style={{ width: c.width }} />)}
      </colgroup>
      <thead>
        <tr className="bg-portal-purple text-portal-cream">
          <th className="text-right px-1 py-1 border border-portal-purple-dark text-[8.5px]">#</th>
          <th className="text-left  px-1 py-1 border border-portal-purple-dark text-[8.5px]">Name</th>
          <th className="text-left  px-0.5 py-1 border border-portal-purple-dark text-[8.5px]">Pos</th>
          <th className="text-center px-0.5 py-1 border border-portal-purple-dark text-[8.5px]">{handField === 'bats' ? 'B' : 'T'}</th>
          {cols.map(c => (
            <th key={c.label}
                className="text-center px-0.5 py-1 border border-portal-purple-dark text-[8.5px] font-semibold whitespace-nowrap">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row, i) => {
          // Low-sample rows get a uniform neutral gray on every stat
          // cell + an italic name and a leading dagger so coaches can
          // still see the player but know the numbers are noisy.
          const isLow = row.low_sample
          const lowSampleBg = 'rgba(229, 231, 235, 0.55)'  // gray-200 ~55%
          return (
            <tr key={row.player_id || i} className={isLow ? 'opacity-90' : ''}>
              <td className="text-right px-1 py-0.5 border border-gray-200 text-gray-500">
                {row.jersey_number || '–'}
              </td>
              <td className={`text-left px-1 py-0.5 border border-gray-200 font-bold whitespace-nowrap overflow-hidden text-ellipsis ${isLow ? 'italic' : ''}`}
                  style={{ color: handColor(row[handField]) }}
                  title={`${row.first_name || ''} ${row.last_name || ''}`.trim() + (isLow ? ' (low sample)' : '')}>
                {isLow && <span className="text-gray-400 mr-0.5">†</span>}
                {row.first_name?.[0]}. {row.last_name}
              </td>
              <td className="text-left px-0.5 py-0.5 border border-gray-200 text-gray-600">
                {row.position || '–'}
              </td>
              <td className="text-center px-0.5 py-0.5 border border-gray-200 text-gray-600">
                {row[handField] || '–'}
              </td>
              {cols.map(c => {
                const pct = row.percentiles ? row.percentiles[c.pctKey] : null
                const bg = isLow
                  ? lowSampleBg
                  : pctColor(pct, c.direction || 'higher_better')
                return (
                  <td key={c.label}
                      className="text-center px-0.5 py-0.5 border border-gray-200 whitespace-nowrap"
                      style={{ backgroundColor: bg }}
                      title={isLow
                        ? 'Below qualifier — not ranked'
                        : (pct != null ? `${pct}th percentile` : undefined)}>
                    {c.val(row)}
                  </td>
                )
              })}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}


// ─────────────────────────────────────────────────────────
// Legend strip below each table — key for the percentile
// shading + the player-name handedness coloring.
// ─────────────────────────────────────────────────────────
function SheetLegend({ kind, thresholds }) {
  // Sample-size minimum for the qualifier — falls back to sane
  // defaults if the backend payload didn't include the threshold.
  const minStr = kind === 'hitters'
    ? `< ${thresholds?.hitter_min_pa ?? 25} PA`
    : `< ${thresholds?.pitcher_min_ip ?? 5} IP`
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-[8px] text-gray-500 leading-none">
      <div className="flex items-center gap-1.5">
        <span>Shading:</span>
        <span className="inline-block w-4 h-2.5" style={{ backgroundColor: 'rgba(245,170,170,0.95)' }} />
        <span>poor</span>
        <span className="inline-block w-4 h-2.5 border border-gray-200 bg-white" />
        <span>avg</span>
        <span className="inline-block w-4 h-2.5" style={{ backgroundColor: 'rgba(162,210,162,0.95)' }} />
        <span>elite</span>
        <span className="text-gray-400">(percentile vs conference qualifiers)</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span>Name:</span>
        <span className="font-bold" style={{ color: '#c0392b' }}>{kind === 'hitters' ? 'LHH' : 'LHP'}</span>
        <span className="font-bold" style={{ color: '#1f4e8c' }}>{kind === 'hitters' ? 'RHH' : 'RHP'}</span>
        {kind === 'hitters' && <span className="font-bold" style={{ color: '#7d3c98' }}>SH</span>}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-4 h-2.5" style={{ backgroundColor: 'rgba(229,231,235,0.55)' }} />
        <span className="text-gray-400">† = low sample ({minStr}); not ranked</span>
      </div>
    </div>
  )
}
