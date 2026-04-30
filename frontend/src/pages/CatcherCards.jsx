// CatcherCards — strict 2-inch × 5-inch printable scouting cards
// for a catcher to call pitches with.
//
// Spec from coach (immutable):
//   • EXACTLY 2 inches tall × 5 inches wide. Period.
//   • 2 cards per opposing team — 7 hitters per card → top 14 by PA
//   • Per row: # · Name (colored by handedness) · wOBA vR · wOBA vL ·
//     GB/FB (whichever larger) · K% · BB% · Sw% · FPS% · Cont% ·
//     ISO · SB · blank Notes column
//   • Every stat color-coded; clear lines between players
//   • Compact but legible
//
// Implementation: we reuse the existing scouting-sheet endpoint (it
// already returns every hitter with all the splits we need) and just
// slice the top 14 by PA on the client. Print uses a named @page rule
// so the saved PDF is a 2-page PDF with each page exactly 5×2 inches.

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApi, useTeams } from '../hooks/useApi'


const SEASON = 2026


// ───────────────────────────────────────────────────────────
// Formatters & coloring (mirrors scouting sheet conventions)
// ───────────────────────────────────────────────────────────
const fmt = {
  rate: v => v == null ? '–' : Number(v).toFixed(3).replace(/^0\./, '.').replace(/^-0\./, '-.'),
  pct:  v => v == null ? '–' : `${(Number(v) * 100).toFixed(0)}%`,
  pct1: v => v == null ? '–' : `${(Number(v) * 100).toFixed(1)}%`,
  int:  v => v == null ? '–' : Math.round(Number(v)),
  raw:  v => v == null ? '–' : v,
}


// Hitter-side thresholds — same calibration as the scouting sheet.
// dir='neutral' keeps cells gray (e.g. GB/FB pick — high or low isn't
// directionally good or bad).
const T = {
  woba:        { good: 0.380, mid: [0.310, 0.380], bad: 0.270, dir: 'higher' },
  k_pct:       { good: 0.15,  mid: [0.15, 0.22],   bad: 0.27,  dir: 'lower'  },
  bb_pct:      { good: 0.12,  mid: [0.07, 0.12],   bad: 0.05,  dir: 'higher' },
  iso:         { good: 0.180, mid: [0.110, 0.180], bad: 0.080, dir: 'higher' },
  contact_pct: { good: 0.82,  mid: [0.72, 0.82],   bad: 0.65,  dir: 'higher' },
  swing_pct:   { good: 0.50,  mid: [0.42, 0.55],   bad: 0.38,  dir: 'higher' },
  fps_pct:     { good: 0.55,  mid: [0.40, 0.55],   bad: 0.30,  dir: 'higher' },
  sb_made:     { good: 8,     mid: [3, 8],         bad: 1,     dir: 'higher' },
  // GB/FB pick — keep gray since neither direction is strictly good.
  gb_or_fb:    { dir: 'neutral' },
}

function thresholdScore(key, v) {
  if (v == null) return null
  const t = T[key]
  if (!t || t.dir === 'neutral') return null
  const flip = t.dir === 'lower'
  const good = t.good, bad = t.bad, [midLo, midHi] = t.mid
  if (flip) {
    if (v <= good) return 90
    if (v >= bad)  return 10
    if (v <= midLo) return 70
    if (v <= midHi) return 50
    return 30
  } else {
    if (v >= good) return 90
    if (v <= bad)  return 10
    if (v >= midHi) return 70
    if (v >= midLo) return 50
    return 30
  }
}

function scoreColor(score, alpha = 0.85) {
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

function handColor(bats) {
  const b = (bats || '').toUpperCase()
  if (b === 'L') return '#c0392b'  // red
  if (b === 'R') return '#1f4e8c'  // blue
  if (b === 'B') return '#7d3c98'  // purple — switch
  return '#374151'
}


// ───────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────
export default function CatcherCards() {
  const { teamId: paramTeamId } = useParams()
  const navigate = useNavigate()
  const { data: teamsData } = useTeams()
  const teams = Array.isArray(teamsData) ? teamsData : []

  const teamId = paramTeamId ? parseInt(paramTeamId, 10) : null
  const { data, loading, error } = useApi(
    teamId ? `/portal/scouting-sheet/${teamId}` : null,
    { season: SEASON },
    [teamId]
  )

  // Set tab title for sane PDF filename.
  useEffect(() => {
    if (data?.team) {
      const safe = (s) => (s || '').replace(/[^A-Za-z0-9]/g, '')
      document.title = `${safe(data.team.short_name || data.team.name)}_CatcherCards_${SEASON}`
    }
  }, [data])

  // Add a body class while this page is mounted so the print @page
  // rule kicks in (sized to 5"×2") and other PDF print rules
  // (which target US Letter portrait) stand down.
  useEffect(() => {
    document.body.classList.add('print-catcher-cards')
    return () => document.body.classList.remove('print-catcher-cards')
  }, [])

  // Top 14 hitters by PA, split into 2 groups of 7.
  const groups = useMemo(() => {
    const hitters = data?.hitters || []
    const top14 = [...hitters]
      .sort((a, b) => (b.pa || 0) - (a.pa || 0))
      .slice(0, 14)
    return [top14.slice(0, 7), top14.slice(7, 14)]
  }, [data])

  // No team selected yet — show a picker.
  if (!teamId) {
    const grouped = {}
    for (const t of teams) {
      const k = t.conference_abbrev || t.conference_name || 'Other'
      if (!grouped[k]) grouped[k] = []
      grouped[k].push(t)
    }
    return (
      <div className="max-w-xl mx-auto px-4 py-8">
        <h1 className="text-xl font-bold text-portal-purple-dark mb-2">Catcher Cards</h1>
        <p className="text-sm text-gray-600 mb-4">
          Pick the OPPOSING team — the cards will show their top 14 hitters.
        </p>
        <select
          onChange={(e) => e.target.value && navigate(`/portal/catcher-cards/${e.target.value}`)}
          className="rounded border border-gray-300 px-3 py-2 text-sm bg-white text-gray-900 w-full"
        >
          <option value="">— pick the opposing team —</option>
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
    return <div className="p-8 text-rose-600">Could not load catcher cards.</div>
  }

  const team = data.team || {}

  return (
    <div className="catcher-cards-page mx-auto px-4 py-4">
      {/* Toolbar — hidden on print */}
      <div className="flex items-center justify-between gap-3 mb-3 print:hidden">
        <div>
          <h1 className="text-xl font-bold text-portal-purple-dark">
            Catcher Cards — {team.short_name || team.name}
          </h1>
          <p className="text-xs text-gray-500">
            Each card is exactly 2 in tall × 5 in wide. Save as PDF, print at 100% scale, cut.
            7 hitters per card · top 14 by PA.
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

      {/* Cards stacked vertically. On screen they show at actual size
          (480×192 at 96dpi) so the coach sees what will print. */}
      <div className="space-y-4">
        {groups.map((hitters, i) => (
          <Card key={i} hitters={hitters} team={team} cardNumber={i + 1} totalCards={groups.length} />
        ))}
      </div>
    </div>
  )
}


// ───────────────────────────────────────────────────────────
// One card: 5" × 2" exactly. Renders 7 hitters in a tight table.
// ───────────────────────────────────────────────────────────
function Card({ hitters, team, cardNumber, totalCards }) {
  return (
    <div
      className="catcher-card border border-gray-700 bg-white"
      style={{ width: '5in', height: '2in', boxSizing: 'border-box' }}
    >
      <table
        className="w-full h-full table-fixed"
        style={{ fontSize: '7px', fontVariantNumeric: 'tabular-nums', borderCollapse: 'collapse' }}
      >
        <colgroup>
          <col style={{ width: '4%' }}  /> {/* # */}
          <col style={{ width: '17%' }} /> {/* Name */}
          <col style={{ width: '7%' }}  /> {/* vR */}
          <col style={{ width: '7%' }}  /> {/* vL */}
          <col style={{ width: '11%' }} /> {/* GB/FB */}
          <col style={{ width: '6%' }}  /> {/* K% */}
          <col style={{ width: '6%' }}  /> {/* BB% */}
          <col style={{ width: '6%' }}  /> {/* Sw% */}
          <col style={{ width: '6%' }}  /> {/* FPS% */}
          <col style={{ width: '7%' }}  /> {/* Cont% */}
          <col style={{ width: '7%' }}  /> {/* ISO */}
          <col style={{ width: '4%' }}  /> {/* SB */}
          <col style={{ width: '12%' }} /> {/* Notes */}
        </colgroup>
        <thead>
          <tr style={{ backgroundColor: '#1d1f4d', color: '#f5f3ef' }}>
            <th style={thHeaderStyle}>
              <span className="block">{(team.short_name || '').toUpperCase()}</span>
              <span className="block text-[5.5px] opacity-70">#{cardNumber}/{totalCards}</span>
            </th>
            <th style={thStyle}>Name</th>
            <th style={thStyle}>vR</th>
            <th style={thStyle}>vL</th>
            <th style={thStyle}>GB/FB</th>
            <th style={thStyle}>K%</th>
            <th style={thStyle}>BB%</th>
            <th style={thStyle}>Sw%</th>
            <th style={thStyle}>FPS%</th>
            <th style={thStyle}>Co%</th>
            <th style={thStyle}>ISO</th>
            <th style={thStyle}>SB</th>
            <th style={thStyle}>Notes</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 7 }).map((_, idx) => {
            const h = hitters[idx]
            return <Row key={idx} hitter={h} />
          })}
        </tbody>
      </table>
    </div>
  )
}


const thHeaderStyle = {
  fontSize: '6px',
  fontWeight: 700,
  textAlign: 'left',
  padding: '1px 2px',
  letterSpacing: '0.05em',
  borderRight: '1px solid #2c2f5e',
  lineHeight: 1,
}
const thStyle = {
  fontSize: '6.5px',
  fontWeight: 700,
  textAlign: 'center',
  padding: '1px 1px',
  letterSpacing: '0.03em',
  borderRight: '1px solid #2c2f5e',
  lineHeight: 1,
}

const tdStyle = {
  padding: '0 1px',
  borderRight: '1px solid #d1d5db',
  borderBottom: '1px solid #6b7280',  // strong divider between players
  textAlign: 'center',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}


function Row({ hitter }) {
  if (!hitter) {
    // Empty row — keep the table cells so the layout is consistent.
    return (
      <tr style={{ height: 'calc((2in - 24px) / 7)' }}>
        {Array.from({ length: 13 }).map((_, i) => (
          <td key={i} style={{ ...tdStyle }}>&nbsp;</td>
        ))}
      </tr>
    )
  }
  const gb = hitter.gb_or_fb_value
  const gbType = hitter.gb_or_fb_type
  const gbLabel = gbType ? `${gbType} ${(gb * 100).toFixed(0)}%` : '–'

  // Threshold-based bg per cell.
  const cellBg = (key, val) => {
    const score = thresholdScore(key, val)
    return score != null ? scoreColor(score, 0.85) : 'transparent'
  }

  return (
    <tr style={{ height: 'calc((2in - 24px) / 7)' }}>
      <td style={{ ...tdStyle, fontWeight: 700, color: '#6b7280' }}>
        {hitter.jersey_number || '–'}
      </td>
      <td style={{
        ...tdStyle, fontWeight: 700, color: handColor(hitter.bats),
        textAlign: 'left', paddingLeft: '2px',
      }}>
        {hitter.first_name?.[0]}. {hitter.last_name}
      </td>
      <td style={{ ...tdStyle, backgroundColor: cellBg('woba', hitter.woba_vs_rhp) }}>
        {fmt.rate(hitter.woba_vs_rhp)}
      </td>
      <td style={{ ...tdStyle, backgroundColor: cellBg('woba', hitter.woba_vs_lhp) }}>
        {fmt.rate(hitter.woba_vs_lhp)}
      </td>
      <td style={tdStyle}>{gbLabel}</td>
      <td style={{ ...tdStyle, backgroundColor: cellBg('k_pct', hitter.k_pct) }}>
        {fmt.pct(hitter.k_pct)}
      </td>
      <td style={{ ...tdStyle, backgroundColor: cellBg('bb_pct', hitter.bb_pct) }}>
        {fmt.pct(hitter.bb_pct)}
      </td>
      <td style={{ ...tdStyle, backgroundColor: cellBg('swing_pct', hitter.swing_pct) }}>
        {fmt.pct(hitter.swing_pct)}
      </td>
      <td style={{ ...tdStyle, backgroundColor: cellBg('fps_pct', hitter.first_pitch_swing_pct) }}>
        {fmt.pct(hitter.first_pitch_swing_pct)}
      </td>
      <td style={{ ...tdStyle, backgroundColor: cellBg('contact_pct', hitter.contact_pct) }}>
        {fmt.pct(hitter.contact_pct)}
      </td>
      <td style={{ ...tdStyle, backgroundColor: cellBg('iso', hitter.iso) }}>
        {fmt.rate(hitter.iso)}
      </td>
      <td style={{ ...tdStyle, backgroundColor: cellBg('sb_made', hitter.sb_made) }}>
        {hitter.sb_made ?? 0}
      </td>
      {/* Notes — intentionally blank for handwritten coach notes. */}
      <td style={tdStyle}>&nbsp;</td>
    </tr>
  )
}
