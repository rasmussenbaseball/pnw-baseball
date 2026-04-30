// BullpenSheet — single-page coaching tool for managing the staff.
//
// Layout (US Letter portrait):
//   ┌─────────────────────────────────────────────────────────────┐
//   │  HEADER: team logo + name + conference + season             │
//   ├─────────────────────────────────────────────────────────────┤
//   │  PITCHER ROSTER TABLE                                       │
//   │  Every pitcher with: IP, ERA, K%, BB%, Whf%, GB%, HR/PA,    │
//   │  BAA, Stk%, FPS%, Put%, wOBA vL, wOBA vR, wOBA RISP,        │
//   │  Last G Pitches                                             │
//   ├─────────────────────────────────────────────────────────────┤
//   │  SITUATIONAL LEADERBOARDS (3-col grid, top 5 each)          │
//   │  Best @ Home  │  Best @ Road  │  Best vs LHH                │
//   │  Best vs RHH  │  Bases Empty  │  Runners On                 │
//   │  Late & Close │                                             │
//   ├─────────────────────────────────────────────────────────────┤
//   │  NOTES (fills remaining vertical space, like other PDFs)    │
//   └─────────────────────────────────────────────────────────────┘
//
// All values color-coded green/red by college-baseball thresholds so
// a coach can scan it under dugout lights.

import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useApi, useTeams } from '../hooks/useApi'
import { useNavigate } from 'react-router-dom'


const SEASON = 2026


// ─────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────
const fmt = {
  rate: v => v == null ? '–' : Number(v).toFixed(3).replace(/^0\./, '.').replace(/^-0\./, '-.'),
  pct:  v => v == null ? '–' : `${(Number(v) * 100).toFixed(1)}%`,
  era:  v => v == null ? '–' : Number(v).toFixed(2),
  ip:   v => v == null ? '–' : Number(v).toFixed(1),
  int:  v => v == null ? '–' : Math.round(Number(v)),
}


// ─────────────────────────────────────────────────────────────
// Threshold table — same idea as PlayerCardPDF but tuned for
// pitcher-side stats (lower opp_woba/baa/era is good).
// ─────────────────────────────────────────────────────────────
const T = {
  era:        { good: 3.00, mid: [3.00, 4.50], bad: 5.50, dir: 'lower'  },
  fip:        { good: 3.20, mid: [3.20, 4.50], bad: 5.50, dir: 'lower'  },
  whip:       { good: 1.10, mid: [1.10, 1.40], bad: 1.60, dir: 'lower'  },
  k_pct:      { good: 0.25, mid: [0.18, 0.25], bad: 0.14, dir: 'higher' },
  bb_pct:     { good: 0.06, mid: [0.06, 0.10], bad: 0.13, dir: 'lower'  },
  whiff_pct:  { good: 0.30, mid: [0.22, 0.30], bad: 0.18, dir: 'higher' },
  gb_pct:     { good: 0.50, mid: [0.40, 0.50], bad: 0.32, dir: 'higher' },
  hr_pa_pct:  { good: 0.020, mid: [0.020, 0.035], bad: 0.045, dir: 'lower' },
  baa:        { good: 0.220, mid: [0.220, 0.270], bad: 0.300, dir: 'lower' },
  strike_pct: { good: 0.66, mid: [0.60, 0.66], bad: 0.56, dir: 'higher' },
  fps_pct:    { good: 0.62, mid: [0.55, 0.62], bad: 0.50, dir: 'higher' },
  putaway_pct:{ good: 0.22, mid: [0.16, 0.22], bad: 0.13, dir: 'higher' },
  woba:       { good: 0.290, mid: [0.290, 0.340], bad: 0.380, dir: 'lower' },
}

function thresholdScore(key, v) {
  if (v == null) return null
  const t = T[key]
  if (!t) return null
  const flip = t.dir === 'lower'
  const good = t.good, bad = t.bad
  const [midLo, midHi] = t.mid
  if (flip) {
    if (v <= good) return 90
    if (v >= bad) return 10
    if (v <= midLo) return 70
    if (v <= midHi) return 50
    return 30
  } else {
    if (v >= good) return 90
    if (v <= bad) return 10
    if (v >= midHi) return 70
    if (v >= midLo) return 50
    return 30
  }
}

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

// Color hand-of-throw — red lefties, blue righties. Matches scouting
// sheet convention.
function handColor(throws) {
  if ((throws || '').toUpperCase() === 'L') return '#c0392b'
  if ((throws || '').toUpperCase() === 'R') return '#1f4e8c'
  return '#374151'
}


// ─────────────────────────────────────────────────────────────
// Color-coded table cell — value formatted + bg shaded by score.
// ─────────────────────────────────────────────────────────────
function Cell({ value, statKey, formatter = fmt.pct }) {
  const score = statKey ? thresholdScore(statKey, value) : null
  const bg = score != null ? scoreColor(score, 0.85) : undefined
  return (
    <td className="px-1 py-0.5 text-right tabular-nums whitespace-nowrap">
      <span className="px-1 rounded" style={bg ? { backgroundColor: bg } : undefined}>
        {formatter(value)}
      </span>
    </td>
  )
}


// ─────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────
export default function BullpenSheet() {
  const { teamId: paramTeamId } = useParams()
  const navigate = useNavigate()
  const { data: teamsData } = useTeams()
  const teams = Array.isArray(teamsData) ? teamsData : []

  const teamId = paramTeamId ? parseInt(paramTeamId, 10) : null
  const { data, loading, error } = useApi(
    teamId ? `/portal/bullpen-sheet/${teamId}` : null,
    { season: SEASON },
    [teamId]
  )

  // Tab title for sane PDF filename
  useEffect(() => {
    if (data?.team) {
      const safe = (s) => (s || '').replace(/[^A-Za-z0-9]/g, '')
      document.title = `${safe(data.team.short_name || data.team.name)}_BullpenSheet_${SEASON}`
    }
  }, [data])

  // Team picker fallback when no team in URL
  if (!teamId) {
    const grouped = {}
    for (const t of teams) {
      const k = t.conference_abbrev || t.conference_name || 'Other'
      if (!grouped[k]) grouped[k] = []
      grouped[k].push(t)
    }
    return (
      <div className="max-w-xl mx-auto px-4 py-8">
        <h1 className="text-xl font-bold text-portal-purple-dark mb-2">Bullpen Sheet</h1>
        <p className="text-sm text-gray-600 mb-4">Pick a team to load its bullpen sheet.</p>
        <select
          onChange={(e) => e.target.value && navigate(`/portal/bullpen-sheet/${e.target.value}`)}
          className="rounded border border-gray-300 px-3 py-2 text-sm bg-white text-gray-900 w-full"
        >
          <option value="">— pick a team —</option>
          {Object.keys(grouped).sort().map(g => (
            <optgroup key={g} label={g}>
              {grouped[g]
                .slice()
                .sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name))
                .map(t => (
                  <option key={t.id} value={t.id}>{t.short_name || t.name}</option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>
    )
  }

  if (loading || !data) {
    return <div className="p-8 text-gray-500 animate-pulse">Loading…</div>
  }
  if (error) {
    return <div className="p-8 text-rose-600">Could not load bullpen sheet.</div>
  }

  const team = data.team || {}
  const pitchers = data.pitchers || []
  const leaderboards = data.leaderboards || {}

  return (
    <div className="bullpen-sheet-page mx-auto px-3 py-4 max-w-[860px] print:px-0 print:py-0 print:max-w-none">
      {/* Toolbar — hidden on print */}
      <div className="flex items-center justify-between gap-3 mb-3 print:hidden">
        <h1 className="text-xl font-bold text-portal-purple-dark">
          Bullpen Sheet — {team.short_name || team.name}
        </h1>
        <button
          onClick={() => window.print()}
          className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                     bg-portal-purple text-portal-cream hover:bg-portal-purple-dark"
        >
          Print / Save as PDF
        </button>
      </div>

      <section className="bullpen-page">
        <SheetHeader team={team} season={data.season} pitcherCount={pitchers.length} />
        <RosterTable pitchers={pitchers} />
        <Leaderboards leaderboards={leaderboards} />
        <div className="sheet-notes mt-2">
          <div className="sheet-notes-label">Notes</div>
        </div>
      </section>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────
function SheetHeader({ team, season, pitcherCount }) {
  return (
    <div className="flex items-center gap-3 border-b-2 border-portal-purple pb-1.5 mb-2">
      {team.logo_url && (
        <img src={team.logo_url} alt="" className="h-10 w-10 object-contain" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 leading-none">
          {team.conference_abbrev || ''} · {team.division_level || ''} · {season}
        </div>
        <div className="text-base font-bold text-portal-purple-dark leading-tight truncate">
          {team.name || team.short_name}
        </div>
      </div>
      <div className="text-right">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 leading-none">
          BULLPEN SHEET
        </div>
        <div className="text-base font-bold text-portal-purple-dark leading-tight">
          {pitcherCount} pitchers
        </div>
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────
// Pitcher roster table — every pitcher, all the rate stats,
// splits, last-outing pitch count.
// ─────────────────────────────────────────────────────────────
function RosterTable({ pitchers }) {
  if (!pitchers.length) {
    return <div className="text-center text-gray-400 italic py-6 text-sm">No pitchers found.</div>
  }
  return (
    <div className="border border-gray-200 rounded overflow-hidden">
      <div className="bg-portal-purple text-portal-cream text-[9.5px] px-2 py-1 font-bold uppercase tracking-widest">
        Roster · sorted by IP
      </div>
      <table className="w-full text-[9.5px] leading-tight tabular-nums">
        <thead className="bg-gray-50 text-gray-600 font-semibold">
          <tr>
            {['#','Name','T','IP','ERA','K%','BB%','Whf%','GB%','HR/PA','BAA',
              'Stk%','FPS%','Put%','wOBA vR','wOBA vL','wOBA RISP','Last G']
              .map(h => (
                <th key={h} className="px-1 py-1 text-right border-b border-gray-200 first:text-left text-[8.5px] whitespace-nowrap">
                  {h}
                </th>
              ))}
          </tr>
        </thead>
        <tbody>
          {pitchers.map(p => (
            <tr key={p.player_id} className="border-b border-gray-100 last:border-0">
              <td className="px-1 py-0.5 text-right text-gray-500">{p.jersey_number || '–'}</td>
              <td className="px-1 py-0.5 text-left font-bold whitespace-nowrap"
                  style={{ color: handColor(p.throws) }}>
                {p.first_name?.[0]}. {p.last_name}
              </td>
              <td className="px-1 py-0.5 text-center text-gray-500">{p.throws || '–'}</td>
              <td className="px-1 py-0.5 text-right">{fmt.ip(p.ip)}</td>
              <Cell value={p.era}        statKey="era"        formatter={fmt.era} />
              <Cell value={p.k_pct}      statKey="k_pct"      formatter={fmt.pct} />
              <Cell value={p.bb_pct}     statKey="bb_pct"     formatter={fmt.pct} />
              <Cell value={p.whiff_pct}  statKey="whiff_pct"  formatter={fmt.pct} />
              <Cell value={p.gb_pct}     statKey="gb_pct"     formatter={fmt.pct} />
              <Cell value={p.hr_pa_pct}  statKey="hr_pa_pct"  formatter={fmt.pct} />
              <Cell value={p.baa}        statKey="baa"        formatter={fmt.rate} />
              <Cell value={p.strike_pct} statKey="strike_pct" formatter={fmt.pct} />
              <Cell value={p.fps_pct}    statKey="fps_pct"    formatter={fmt.pct} />
              <Cell value={p.putaway_pct} statKey="putaway_pct" formatter={fmt.pct} />
              <Cell value={p.woba_vs_rhh} statKey="woba"      formatter={fmt.rate} />
              <Cell value={p.woba_vs_lhh} statKey="woba"      formatter={fmt.rate} />
              <Cell value={p.woba_risp}   statKey="woba"      formatter={fmt.rate} />
              <td className="px-1 py-0.5 text-right whitespace-nowrap">
                {p.last_game_pitches != null ? (
                  <span className="text-gray-700">
                    {p.last_game_pitches}p
                    {p.last_game_opp_short && (
                      <span className="text-gray-400 ml-0.5">
                        @{p.last_game_opp_short}
                      </span>
                    )}
                  </span>
                ) : <span className="text-gray-400">–</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────
// Situational leaderboards — 3-col grid, top 5 by lowest wOBA.
// ─────────────────────────────────────────────────────────────
const LEADERBOARD_DEFS = [
  { key: 'home',         label: 'Best @ Home' },
  { key: 'road',         label: 'Best @ Road' },
  { key: 'vs_lhh',       label: 'Best vs LHH' },
  { key: 'vs_rhh',       label: 'Best vs RHH' },
  { key: 'bases_empty',  label: 'Bases Empty' },
  { key: 'runners_on',   label: 'Runners On' },
  { key: 'late_close',   label: 'Late & Close' },
]


function Leaderboards({ leaderboards }) {
  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-widest text-portal-purple-dark font-bold mb-1">
        Situational Leaderboards <span className="text-gray-400 font-normal">· top 5 by opponent wOBA · min 5 PA</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {LEADERBOARD_DEFS.map(def => (
          <Leaderboard
            key={def.key}
            label={def.label}
            rows={leaderboards[def.key] || []}
          />
        ))}
      </div>
    </div>
  )
}


function Leaderboard({ label, rows }) {
  return (
    <div className="border border-gray-200 rounded overflow-hidden">
      <div className="bg-portal-purple/90 text-portal-cream text-[9px] px-1.5 py-0.5 font-bold uppercase tracking-widest">
        {label}
      </div>
      {!rows.length ? (
        <div className="text-[9px] text-gray-400 italic px-2 py-1.5">No qualifiers yet.</div>
      ) : (
        <table className="w-full text-[8.5px] leading-tight tabular-nums">
          <thead className="bg-gray-50 text-gray-500 font-semibold">
            <tr>
              <th className="px-1 py-0.5 text-left">Pitcher</th>
              <th className="px-1 py-0.5 text-right">PA</th>
              <th className="px-1 py-0.5 text-right">wOBA</th>
              <th className="px-1 py-0.5 text-right">K%</th>
              <th className="px-1 py-0.5 text-right">BB%</th>
              <th className="px-1 py-0.5 text-right">Whf%</th>
              <th className="px-1 py-0.5 text-right">Stk%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.player_id} className="border-t border-gray-100">
                <td className="px-1 py-0.5 text-left font-bold whitespace-nowrap"
                    style={{ color: handColor(r.throws) }}>
                  {r.first_name?.[0]}. {r.last_name}
                </td>
                <td className="px-1 py-0.5 text-right text-gray-500">{r.pa}</td>
                <Cell value={r.woba}       statKey="woba"       formatter={fmt.rate} />
                <Cell value={r.k_pct}      statKey="k_pct"      formatter={fmt.pct} />
                <Cell value={r.bb_pct}     statKey="bb_pct"     formatter={fmt.pct} />
                <Cell value={r.whiff_pct}  statKey="whiff_pct"  formatter={fmt.pct} />
                <Cell value={r.strike_pct} statKey="strike_pct" formatter={fmt.pct} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
