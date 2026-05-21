// NWACTournamentSheet — cross-team scouting board for the 8 teams in
// the NWAC Championships (Longview, WA).
//
// Two ranked-by-WAR boards: every PITCHER across the field first,
// then every HITTER. Each board is paginated into landscape US Letter
// pages. Stat cells are percentile-shaded green→white→red against the
// championship field; bio columns (Team, Yr, Ht, Wt, Commitment) sit
// to the left. Player names colored by handedness.
//
// Landscape print: a dynamically-injected @page rule (mounted only
// while this page is) flips the print to letter landscape and strips
// the portal chrome, so the saved PDF is a clean multi-page board.

import { useEffect } from 'react'
import { useApi } from '../hooks/useApi'

const SEASON = 2026

// Rows per printed page — tuned so a landscape US Letter page fills
// without overflowing into a blank page.
const ROWS_PER_PAGE = 26


// ─────────────────────────────────────────────────────────
// Percentile cell shade — green→white→red (matches scouting sheet).
// The server already orients percentiles so HIGH pct = GOOD.
// 'neutral' direction stays transparent (e.g. GS — a role marker).
// ─────────────────────────────────────────────────────────
function pctColor(pct, direction = 'higher_better') {
  if (pct == null || direction === 'neutral') return 'transparent'
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
  return '#374151'
}

// Height comes in many scraped shapes: "6-0", "6' 4", "6'3", "6'0\"",
// "5'10''", "5-11". Normalize to a tidy 6'3" display; fall back to raw.
function fmtHeight(h) {
  if (!h) return '–'
  const m = String(h).match(/(\d+)\D+(\d+)/)
  if (m) return `${m[1]}'${m[2]}"`
  return String(h)
}

const fmt = {
  war: v => (v == null ? '–' : Number(v).toFixed(2)),
  dec2: v => (v == null ? '–' : Number(v).toFixed(2)),
  rate: v => {
    if (v == null) return '–'
    return Number(v).toFixed(3).replace(/^0\./, '.').replace(/^-0\./, '-.')
  },
  pct: v => (v == null ? '–' : `${(Number(v) * 100).toFixed(1)}%`),
  ip: v => (v == null ? '–' : Number(v).toFixed(1)),
  int: v => (v == null ? '–' : Math.round(Number(v))),
}


// Stat columns (color-shaded). Bio columns are rendered separately.
const HITTER_COLS = [
  { label: 'WAR',  val: r => fmt.war(r.offensive_war), pctKey: 'offensive_war', width: '4.6%' },
  { label: 'wRC+', val: r => fmt.int(r.wrc_plus),      pctKey: 'wrc_plus',      width: '4.6%' },
  { label: 'AVG',  val: r => fmt.rate(r.batting_avg),  pctKey: 'batting_avg',   width: '4.6%' },
  { label: 'OBP',  val: r => fmt.rate(r.on_base_pct),  pctKey: 'on_base_pct',   width: '4.6%' },
  { label: 'SLG',  val: r => fmt.rate(r.slugging_pct), pctKey: 'slugging_pct',  width: '4.6%' },
  { label: 'SB',   val: r => fmt.int(r.sb),            pctKey: 'sb',            width: '4.2%' },
  { label: 'HR',   val: r => fmt.int(r.hr),            pctKey: 'hr',            width: '4.2%' },
  { label: 'K%',   val: r => fmt.pct(r.k_pct),         pctKey: 'k_pct',         width: '4.8%' },
  { label: 'BB%',  val: r => fmt.pct(r.bb_pct),        pctKey: 'bb_pct',        width: '4.8%' },
  { label: 'ISO',  val: r => fmt.rate(r.iso),          pctKey: 'iso',           width: '4.6%' },
  { label: 'Sw%',  val: r => fmt.pct(r.swing_pct),     pctKey: 'swing_pct',     width: '4.8%' },
  { label: 'Ct%',  val: r => fmt.pct(r.contact_pct),   pctKey: 'contact_pct',   width: '4.8%' },
]

const PITCHER_COLS = [
  { label: 'WAR',   val: r => fmt.war(r.pitching_war), pctKey: 'pitching_war', width: '4.6%' },
  { label: 'IP',    val: r => fmt.ip(r.ip),            pctKey: 'ip',           width: '4.4%' },
  { label: 'GS',    val: r => fmt.int(r.gs),           pctKey: 'gs',           width: '3.6%', direction: 'neutral' },
  { label: 'ERA',   val: r => fmt.dec2(r.era),         pctKey: 'era',          width: '4.6%' },
  { label: 'FIP',   val: r => fmt.dec2(r.fip),         pctKey: 'fip',          width: '4.6%' },
  { label: 'SIERA', val: r => fmt.dec2(r.siera),       pctKey: 'siera',        width: '5.0%' },
  { label: 'BAA',   val: r => fmt.rate(r.baa),         pctKey: 'baa',          width: '4.6%' },
  { label: 'K%',    val: r => fmt.pct(r.k_pct),        pctKey: 'k_pct',        width: '4.8%' },
  { label: 'BB%',   val: r => fmt.pct(r.bb_pct),       pctKey: 'bb_pct',       width: '4.8%' },
  { label: 'Whf%',  val: r => fmt.pct(r.whiff_pct),    pctKey: 'whiff_pct',    width: '4.8%' },
  { label: 'Stk%',  val: r => fmt.pct(r.strike_pct),   pctKey: 'strike_pct',   width: '4.8%' },
  { label: 'Put%',  val: r => fmt.pct(r.putaway_pct),  pctKey: 'putaway_pct',  width: '4.8%' },
]


export default function NWACTournamentSheet() {
  const { data, loading, error } = useApi('/portal/nwac-tournament-sheet', { season: SEASON }, [])

  // Landscape print rules — mounted only while this page is visible so
  // the rest of the portal keeps its letter-portrait @page default.
  useEffect(() => {
    document.body.classList.add('print-nwac-tourney')
    const style = document.createElement('style')
    style.id = 'nwac-tourney-print-style'
    style.textContent = `
      @media print {
        @page { size: letter landscape; margin: 0.35in; }
        body { background: white; }
        body * { visibility: hidden; }
        .nwac-tourney-sheet,
        .nwac-tourney-sheet * { visibility: visible; }
        .nwac-tourney-sheet {
          position: absolute;
          left: 0; top: 0;
          width: 100%;
          padding: 0; margin: 0;
        }
        .nwac-tourney-sheet .tourney-page {
          page-break-after: always;
          break-after: page;
        }
        .nwac-tourney-sheet .tourney-page:last-child {
          page-break-after: auto;
          break-after: auto;
        }
        .nwac-tourney-sheet table { font-size: 8.5px; }
        .nwac-tourney-sheet table td,
        .nwac-tourney-sheet table th {
          padding-top: 2.5px;
          padding-bottom: 2.5px;
        }
        .nwac-tourney-sheet,
        .nwac-tourney-sheet * {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
      }
    `
    document.head.appendChild(style)
    return () => {
      document.body.classList.remove('print-nwac-tourney')
      const el = document.getElementById('nwac-tourney-print-style')
      if (el) el.remove()
    }
  }, [])

  useEffect(() => {
    document.title = `NWAC_Championship_Board_${SEASON}`
  }, [])

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="text-gray-500 animate-pulse">Loading championship board…</div>
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="text-rose-600">Could not load the tournament board.</div>
      </div>
    )
  }

  const pitchers = data.pitchers || []
  const hitters = data.hitters || []
  const teams = data.teams || []

  // Split each board into page-sized chunks.
  const pitcherPages = chunk(pitchers, ROWS_PER_PAGE)
  const hitterPages = chunk(hitters, ROWS_PER_PAGE)

  return (
    <div className="nwac-tourney-sheet mx-auto px-3 py-4 print:px-0 print:py-0">
      {/* Toolbar — hidden on print */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 print:hidden max-w-[1100px] mx-auto">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-portal-purple-dark">
            NWAC Championship Board · {data.season}
          </h1>
          <p className="text-xs text-gray-500">
            8 teams · {pitchers.length} pitchers + {hitters.length} hitters ·
            {' '}ranked by WAR · shaded vs the championship field
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
            {teams.map(t => (
              <span key={t.id} className="flex items-center gap-1 text-[11px] text-gray-600">
                {t.logo_url && <img src={t.logo_url} alt="" className="h-4 w-4 object-contain" />}
                {t.short_name}
              </span>
            ))}
          </div>
        </div>
        <button
          onClick={() => window.print()}
          className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                     bg-portal-purple text-portal-cream hover:bg-portal-purple-dark"
        >
          Print / Save as PDF
        </button>
      </div>

      {/* PITCHERS */}
      {pitcherPages.map((rows, i) => (
        <BoardPage
          key={`p${i}`}
          title="NWAC Championship Pitchers"
          subtitle={`Ranked by WAR · page ${i + 1} of ${pitcherPages.length}`}
          rows={rows}
          cols={PITCHER_COLS}
          handField="throws"
          showLegend={i === pitcherPages.length - 1}
          thresholds={data.thresholds}
          kind="pitchers"
        />
      ))}

      {/* HITTERS */}
      {hitterPages.map((rows, i) => (
        <BoardPage
          key={`h${i}`}
          title="NWAC Championship Hitters"
          subtitle={`Ranked by WAR · page ${i + 1} of ${hitterPages.length}`}
          rows={rows}
          cols={HITTER_COLS}
          handField="bats"
          showLegend={i === hitterPages.length - 1}
          thresholds={data.thresholds}
          kind="hitters"
        />
      ))}
    </div>
  )
}


function chunk(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out.length ? out : [[]]
}


// ─────────────────────────────────────────────────────────
// One printable page: header + a chunk of the ranked board.
// ─────────────────────────────────────────────────────────
function BoardPage({ title, subtitle, rows, cols, handField, showLegend, thresholds, kind }) {
  return (
    <section className="tourney-page max-w-[1100px] mx-auto print:max-w-none mb-8 print:mb-0">
      <div className="flex items-end justify-between border-b-2 border-portal-purple pb-1.5 mb-2">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 leading-none">
            NWAC Championships · Longview, WA
          </div>
          <div className="text-base font-bold text-portal-purple-dark leading-tight">
            {title}
          </div>
        </div>
        <div className="text-[10px] uppercase tracking-widest text-gray-500">
          {subtitle}
        </div>
      </div>

      <BoardTable rows={rows} cols={cols} handField={handField} />

      {showLegend && <BoardLegend kind={kind} thresholds={thresholds} />}
    </section>
  )
}


function BoardTable({ rows, cols, handField }) {
  if (!rows.length) {
    return <div className="text-center text-gray-400 italic py-6 text-sm">No players.</div>
  }
  return (
    <table className="w-full border-collapse text-[9px] leading-tight tabular-nums table-fixed">
      <colgroup>
        <col style={{ width: '2.6%' }} />  {/* rank */}
        <col style={{ width: '4.5%' }} />  {/* team */}
        <col style={{ width: '2.6%' }} />  {/* # */}
        <col style={{ width: '12%' }}  />  {/* name */}
        <col style={{ width: '3%' }}   />  {/* B/T */}
        <col style={{ width: '3%' }}   />  {/* Yr */}
        <col style={{ width: '4%' }}   />  {/* Ht */}
        <col style={{ width: '3.5%' }} />  {/* Wt */}
        <col style={{ width: '9%' }}   />  {/* Commit */}
        {cols.map((c, i) => (
          <col key={i} style={{ width: c.width }} />
        ))}
      </colgroup>
      <thead>
        <tr className="bg-portal-purple text-portal-cream">
          <th className="text-right  px-1 py-1 border border-portal-purple-dark text-[8.5px]">#</th>
          <th className="text-center px-0.5 py-1 border border-portal-purple-dark text-[8.5px]">Tm</th>
          <th className="text-right  px-0.5 py-1 border border-portal-purple-dark text-[8.5px]">No.</th>
          <th className="text-left   px-1 py-1 border border-portal-purple-dark text-[8.5px]">Name</th>
          <th className="text-center px-0.5 py-1 border border-portal-purple-dark text-[8.5px]">{handField === 'bats' ? 'B' : 'T'}</th>
          <th className="text-center px-0.5 py-1 border border-portal-purple-dark text-[8.5px]">Yr</th>
          <th className="text-center px-0.5 py-1 border border-portal-purple-dark text-[8.5px]">Ht</th>
          <th className="text-center px-0.5 py-1 border border-portal-purple-dark text-[8.5px]">Wt</th>
          <th className="text-left   px-1 py-1 border border-portal-purple-dark text-[8.5px]">Commit</th>
          {cols.map(c => (
            <th key={c.label}
                className="text-center px-0.5 py-1 border border-portal-purple-dark text-[8.5px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const isLow = row.low_sample
          const lowBg = 'rgba(229,231,235,0.55)'
          return (
            <tr key={row.player_id || i}>
              <td className="text-right px-1 py-0.5 border border-gray-200 text-gray-400 font-mono">
                {row.rank}
              </td>
              <td className="text-center px-0.5 py-0.5 border border-gray-200">
                {row.team_logo
                  ? <img src={row.team_logo} alt="" title={row.team_short}
                         className="h-3.5 w-3.5 object-contain inline-block"
                         onError={(e) => { e.currentTarget.style.display = 'none' }} />
                  : <span className="text-[8px] text-gray-500">{row.team_short}</span>}
              </td>
              <td className="text-right px-0.5 py-0.5 border border-gray-200 text-gray-500">
                {row.jersey_number || '–'}
              </td>
              <td className={`text-left px-1 py-0.5 border border-gray-200 font-bold whitespace-nowrap overflow-hidden text-ellipsis ${isLow ? 'italic' : ''}`}
                  style={{ color: handColor(row[handField]) }}
                  title={`${row.first_name || ''} ${row.last_name || ''}`.trim()}>
                {isLow && <span className="text-gray-400 mr-0.5">†</span>}
                {row.first_name?.[0]}. {row.last_name}
              </td>
              <td className="text-center px-0.5 py-0.5 border border-gray-200 text-gray-600">
                {row[handField] || '–'}
              </td>
              <td className="text-center px-0.5 py-0.5 border border-gray-200 text-gray-600">
                {row.year_in_school || '–'}
              </td>
              <td className="text-center px-0.5 py-0.5 border border-gray-200 text-gray-600 whitespace-nowrap">
                {fmtHeight(row.height)}
              </td>
              <td className="text-center px-0.5 py-0.5 border border-gray-200 text-gray-600">
                {row.weight || '–'}
              </td>
              <td className="text-left px-1 py-0.5 border border-gray-200 whitespace-nowrap overflow-hidden text-ellipsis"
                  title={row.commitment || ''}
                  style={{ color: row.commitment ? '#15803d' : '#9ca3af' }}>
                {row.commitment || '–'}
              </td>
              {cols.map(c => {
                const pct = row.percentiles ? row.percentiles[c.pctKey] : null
                const bg = isLow ? lowBg : pctColor(pct, c.direction || 'higher_better')
                return (
                  <td key={c.label}
                      className="text-center px-0.5 py-0.5 border border-gray-200 whitespace-nowrap overflow-hidden text-ellipsis"
                      style={{ backgroundColor: bg }}
                      title={isLow ? 'Below qualifier, not ranked'
                                   : (pct != null && c.direction !== 'neutral' ? `${pct}th pct` : undefined)}>
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


function BoardLegend({ kind, thresholds }) {
  const minStr = kind === 'hitters'
    ? `< ${thresholds?.hitter_min_pa ?? 25} PA`
    : `< ${thresholds?.pitcher_min_ip ?? 5} IP`
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[8px] text-gray-500 leading-none">
      <div className="flex items-center gap-1.5">
        <span>Shading:</span>
        <span className="inline-block w-4 h-2.5" style={{ backgroundColor: 'rgba(245,170,170,0.95)' }} />
        <span>poor</span>
        <span className="inline-block w-4 h-2.5 border border-gray-200 bg-white" />
        <span>avg</span>
        <span className="inline-block w-4 h-2.5" style={{ backgroundColor: 'rgba(162,210,162,0.95)' }} />
        <span>elite</span>
        <span className="text-gray-400">(percentile vs the 8-team championship field)</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span>Name:</span>
        <span className="font-bold" style={{ color: '#c0392b' }}>{kind === 'hitters' ? 'LHH' : 'LHP'}</span>
        <span className="font-bold" style={{ color: '#1f4e8c' }}>{kind === 'hitters' ? 'RHH' : 'RHP'}</span>
        {kind === 'hitters' && <span className="font-bold" style={{ color: '#7d3c98' }}>SH</span>}
      </div>
      <div className="flex items-center gap-1.5">
        <span style={{ color: '#15803d' }} className="font-semibold">Green text = committed</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-4 h-2.5" style={{ backgroundColor: 'rgba(229,231,235,0.55)' }} />
        <span className="text-gray-400">† = low sample ({minStr}); not ranked</span>
      </div>
    </div>
  )
}
