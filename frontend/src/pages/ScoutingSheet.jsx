// ScoutingSheet — printable per-team roster sheet.
//
// One US Letter portrait page of hitters, one page of pitchers.
// Modeled on the 643 Charts scouting sheet but powered by NWBB Stats
// data:
//
//   HITTERS  (13 stats):
//     PA, wOBA vR, wOBA vL, GB% or FB%, K%, BB%, ISO, SB/SBA,
//     HR/FB, Contact%, First Pitch Swing%, Swing%, Putaway%
//
//   PITCHERS (12 stats):
//     IP, wOBA vR, wOBA vL, K%, BB%, Whiff%, ISO against,
//     BAA against, GB% or FB%, Strike%, FPS%, Putaway%
//
// Cells are shaded by percentile vs the team's CONFERENCE qualifier
// cohort (green = elite, white = avg, red = poor). Player names are
// red for lefties, blue for righties, purple for switch hitters.
// Each table has a totals row at the bottom showing the team's
// aggregate, percentile-ranked vs OTHER teams in the conference.
//
// Print: a "Print / Save PDF" button calls window.print(); the
// `@media print` rules in src/styles/index.css strip the portal
// chrome so each table prints on its own portrait page.

import { useNavigate, useParams } from 'react-router-dom'
import { useApi, useTeams } from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'


const SEASON = 2026


// ─────────────────────────────────────────────────────────
// Cell-shade palette — green→white→red (643 inspiration).
// 'neutral' direction always returns transparent.
// The server already inverts percentiles for lower-better
// stats, so high pct here means GOOD regardless of direction.
// ─────────────────────────────────────────────────────────
function pctColor(pct, direction = 'higher_better') {
  if (pct == null) return 'transparent'
  if (direction === 'neutral') return 'transparent'
  const p = Math.max(0, Math.min(100, pct)) / 100
  let r, g, b, a
  if (p >= 0.5) {
    const t = (p - 0.5) * 2
    r = Math.round(255 + (162 - 255) * t)
    g = Math.round(255 + (210 - 255) * t)
    b = Math.round(255 + (162 - 255) * t)
    a = 0.55 + 0.40 * t
  } else {
    const t = (0.5 - p) * 2
    r = Math.round(255 + (245 - 255) * t)
    g = Math.round(255 + (170 - 255) * t)
    b = Math.round(255 + (170 - 255) * t)
    a = 0.55 + 0.40 * t
  }
  return `rgba(${r},${g},${b},${a})`
}


function handColor(hand) {
  const h = (hand || '').toUpperCase()
  if (h === 'L') return '#c0392b'  // red
  if (h === 'R') return '#1f4e8c'  // blue
  if (h === 'B') return '#7d3c98'  // switch — purple
  return '#374151'                 // gray-700 fallback
}


const fmt = {
  int: v => (v == null ? '–' : Math.round(v)),
  rate: v => {
    if (v == null) return '–'
    const n = typeof v === 'string' ? parseFloat(v) : v
    return n.toFixed(3).replace(/^0\./, '.').replace(/^-0\./, '-.')
  },
  pct: v => (v == null ? '–' : `${(v * 100).toFixed(1)}%`),
  ip: v => {
    if (v == null) return '–'
    const n = typeof v === 'string' ? parseFloat(v) : v
    return n.toFixed(1)
  },
  raw: v => (v == null ? '–' : v),
  gbfb: row => {
    if (!row.gb_or_fb_type) return '–'
    return `${row.gb_or_fb_type} ${(row.gb_or_fb_value * 100).toFixed(1)}%`
  },
}


// 13 hitter stats. `direction: 'neutral'` keeps the cell gray (used
// only for GB/FB which is a "type tag" not a directional metric).
const HITTER_COLS = [
  { label: 'PA',      val: r => fmt.int(r.pa),                pctKey: 'pa' },
  { label: 'wOBA vR', val: r => fmt.rate(r.woba_vs_rhp),      pctKey: 'woba_vs_rhp' },
  { label: 'wOBA vL', val: r => fmt.rate(r.woba_vs_lhp),      pctKey: 'woba_vs_lhp' },
  { label: 'GB / FB', val: r => fmt.gbfb(r),                  pctKey: 'gb_or_fb_value', direction: 'neutral' },
  { label: 'K%',      val: r => fmt.pct(r.k_pct),             pctKey: 'k_pct' },
  { label: 'BB%',     val: r => fmt.pct(r.bb_pct),            pctKey: 'bb_pct' },
  { label: 'ISO',     val: r => fmt.rate(r.iso),              pctKey: 'iso' },
  { label: 'SB',      val: r => fmt.raw(r.sb_str),            pctKey: 'sb_made' },
  { label: 'HR/FB',   val: r => fmt.pct(r.hr_per_fb),         pctKey: 'hr_per_fb' },
  { label: 'Cont%',   val: r => fmt.pct(r.contact_pct),       pctKey: 'contact_pct' },
  { label: 'FPS%',    val: r => fmt.pct(r.first_pitch_swing_pct), pctKey: 'first_pitch_swing_pct' },
  { label: 'Sw%',     val: r => fmt.pct(r.swing_pct),         pctKey: 'swing_pct' },
  { label: 'Put%',    val: r => fmt.pct(r.putaway_pct),       pctKey: 'putaway_pct' },
]

const PITCHER_COLS = [
  { label: 'IP',      val: r => fmt.ip(r.ip),                 pctKey: 'ip' },
  { label: 'wOBA vR', val: r => fmt.rate(r.woba_vs_rhh),      pctKey: 'woba_vs_rhh' },
  { label: 'wOBA vL', val: r => fmt.rate(r.woba_vs_lhh),      pctKey: 'woba_vs_lhh' },
  { label: 'K%',      val: r => fmt.pct(r.k_pct),             pctKey: 'k_pct' },
  { label: 'BB%',     val: r => fmt.pct(r.bb_pct),            pctKey: 'bb_pct' },
  { label: 'Whf%',    val: r => fmt.pct(r.whiff_pct),         pctKey: 'whiff_pct' },
  { label: 'ISO',     val: r => fmt.rate(r.iso_against),      pctKey: 'iso_against' },
  { label: 'BAA',     val: r => fmt.rate(r.baa_against),      pctKey: 'baa_against' },
  { label: 'GB / FB', val: r => fmt.gbfb(r),                  pctKey: 'gb_or_fb_value', direction: 'neutral' },
  { label: 'Stk%',    val: r => fmt.pct(r.strike_pct),        pctKey: 'strike_pct' },
  { label: 'FPS%',    val: r => fmt.pct(r.fps_pct),           pctKey: 'fps_pct' },
  { label: 'Put%',    val: r => fmt.pct(r.putaway_pct),       pctKey: 'putaway_pct' },
]


// ─────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────
export default function ScoutingSheet() {
  const params = useParams()
  const navigate = useNavigate()
  const { team: portalTeam } = usePortalTeam()
  const teamId = params.teamId
    ? parseInt(params.teamId, 10)
    : portalTeam?.id

  const { data, loading, error } = useApi(
    teamId ? `/portal/scouting-sheet/${teamId}` : null,
    { season: SEASON },
    [teamId]
  )
  const { data: teamsList } = useTeams()

  // Teams sorted alphabetically and grouped by conference for the picker.
  const teamsByConf = (teamsList || []).reduce((acc, t) => {
    const k = t.conference_abbrev || t.conference_name || 'Other'
    if (!acc[k]) acc[k] = []
    acc[k].push(t)
    return acc
  }, {})

  if (!teamId) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <p className="text-gray-500 mb-4">
          Pick a team to load its scouting sheet.
        </p>
        <TeamPicker teamsByConf={teamsByConf} onPick={(id) => navigate(`/portal/scouting-sheet/${id}`)} />
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
  const teamHitterTotals  = data.team_hitter_totals  || null
  const teamPitcherTotals = data.team_pitcher_totals || null

  return (
    <div className="scouting-sheet-page mx-auto px-3 py-4 print:px-0 print:py-0">
      {/* Toolbar — hidden on print */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 print:hidden max-w-[820px] mx-auto">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-portal-purple-dark truncate">
            Scouting Sheet — {team.short_name || team.name}
          </h1>
          <p className="text-xs text-gray-500">
            Season {data.season} · {team.conference_abbrev || team.conference_name || 'Unranked'} ·
            {' '}{hitters.length} hitters · {pitchers.length} pitchers ·
            {' '}qualified {data.cohort_size?.hitters_qualified}H / {data.cohort_size?.pitchers_qualified}P
            {' '}of {data.cohort_size?.hitters}H / {data.cohort_size?.pitchers}P in conference
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TeamPicker
            teamsByConf={teamsByConf}
            currentId={teamId}
            onPick={(id) => navigate(`/portal/scouting-sheet/${id}`)}
            compact
          />
          <button
            onClick={() => window.print()}
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                       bg-portal-purple text-portal-cream hover:bg-portal-purple-dark"
          >
            Print / Save as PDF
          </button>
        </div>
      </div>

      {/* Page 1: HITTERS */}
      <section className="sheet-page max-w-[820px] mx-auto print:max-w-none">
        <SheetHeader team={team} season={data.season} side="HITTERS" count={hitters.length} />
        <RosterTable
          rows={hitters}
          cols={HITTER_COLS}
          handField="bats"
          totals={teamHitterTotals}
          totalsLabel="TEAM"
          totalsHint={teamHitterTotals?.n_teams ? `vs ${teamHitterTotals.n_teams} teams` : ''}
        />
        <SheetLegend kind="hitters" thresholds={data.thresholds} />
        <NotesPanel label="Notes" />
      </section>

      {/* Page break for print */}
      <div className="sheet-pagebreak" />

      {/* Page 2: PITCHERS */}
      <section className="sheet-page max-w-[820px] mx-auto print:max-w-none">
        <SheetHeader team={team} season={data.season} side="PITCHING STAFF" count={pitchers.length} />
        <RosterTable
          rows={pitchers}
          cols={PITCHER_COLS}
          handField="throws"
          totals={teamPitcherTotals}
          totalsLabel="TEAM"
          totalsHint={teamPitcherTotals?.n_teams ? `vs ${teamPitcherTotals.n_teams} teams` : ''}
        />
        <SheetLegend kind="pitchers" thresholds={data.thresholds} />
        <NotesPanel label="Notes" />
      </section>
    </div>
  )
}


// ─────────────────────────────────────────────────────────
// Team picker — grouped <select> across NWC / NWAC / CCC / etc.
// ─────────────────────────────────────────────────────────
function TeamPicker({ teamsByConf, currentId, onPick, compact = false }) {
  const groups = Object.keys(teamsByConf).sort()
  return (
    <select
      value={currentId || ''}
      onChange={(e) => {
        const id = parseInt(e.target.value, 10)
        if (Number.isFinite(id)) onPick(id)
      }}
      className={`rounded border border-gray-300 bg-white text-gray-900
                  ${compact ? 'px-2 py-1 text-xs' : 'px-3 py-2 text-sm'}`}
    >
      {!currentId && <option value="">— pick a team —</option>}
      {groups.map(g => (
        <optgroup key={g} label={g}>
          {teamsByConf[g]
            .slice()
            .sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name))
            .map(t => (
              <option key={t.id} value={t.id}>
                {t.short_name || t.name}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  )
}


// ─────────────────────────────────────────────────────────
// Sheet header — team logo + name on the left, side label
// (HITTERS / PITCHING STAFF) on the right.
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
// Roster table — row per player, optional team-totals row.
// Column widths use percentages so the same table fills both
// the on-screen 820px container and a printed portrait page.
// ─────────────────────────────────────────────────────────
function RosterTable({ rows, cols, handField, totals, totalsLabel, totalsHint }) {
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
    <table className="w-full border-collapse text-[9px] leading-tight tabular-nums table-fixed">
      <colgroup>
        <col style={{ width: '3%' }}  />  {/* # */}
        <col style={{ width: '15%' }} />  {/* Name */}
        <col style={{ width: '4%' }}  />  {/* Pos */}
        <col style={{ width: '3%' }}  />  {/* B/T */}
        {cols.map((_, i) => <col key={i} style={{ width: `${75 / cols.length}%` }} />)}
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
          const isLow = row.low_sample
          const lowSampleBg = 'rgba(229, 231, 235, 0.55)'
          return (
            <tr key={row.player_id || i}>
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

        {/* Team totals row — bold header band + percentile-shaded cells
            ranked vs OTHER teams in the conference. */}
        {totals && (
          <tr className="border-t-2 border-portal-purple-dark">
            <td className="text-right px-1 py-1 border border-portal-purple-dark bg-portal-purple/5 text-[8.5px] font-bold text-portal-purple-dark">
              ─
            </td>
            <td className="text-left px-1 py-1 border border-portal-purple-dark bg-portal-purple/5 text-[10px] font-bold text-portal-purple-dark uppercase tracking-wider"
                colSpan={3}
                title={totalsHint || ''}>
              {totalsLabel}
            </td>
            {cols.map(c => {
              const pct = totals.percentiles ? totals.percentiles[c.pctKey] : null
              const bg = pctColor(pct, c.direction || 'higher_better')
              return (
                <td key={c.label}
                    className="text-center px-0.5 py-1 border border-portal-purple-dark font-bold whitespace-nowrap"
                    style={{ backgroundColor: bg }}
                    title={pct != null ? `${pct}th percentile vs other teams` : undefined}>
                  {c.val(totals)}
                </td>
              )
            })}
          </tr>
        )}
      </tbody>
    </table>
  )
}


// ─────────────────────────────────────────────────────────
// Notes panel — flex-grow box that eats any leftover vertical
// space below the table.  On screen it stays a tidy ~80px tall;
// on print it stretches to fill the rest of the page so smaller
// rosters never leave a big white gap.
// ─────────────────────────────────────────────────────────
function NotesPanel({ label = 'Notes' }) {
  return (
    <div className="sheet-notes mt-2 min-h-[80px]">
      <div className="sheet-notes-label">{label}</div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────
// Legend strip below each table
// ─────────────────────────────────────────────────────────
function SheetLegend({ kind, thresholds }) {
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
        <span className="text-gray-400">(percentile vs conference qualifiers; team row vs other teams)</span>
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
