// PortalHome — the Coach & Scouting Portal landing page.
//
// Rather than a single team-tailored dashboard, this is a LAUNCHER: a
// gallery of small preview cards, one per portal tool, grouped by the
// same sections as the portal nav (Coaching Tools / Opponent Scouting /
// PDFs & Printables). Each card shows a lightweight SVG mock of what the
// tool produces so the whole toolkit is visible at a glance. The
// team-specific tools still prompt for a focus team when you open them;
// the home itself doesn't require one.

import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { usePortalTeam } from '../context/PortalTeamContext'

// Portal palette (matches tailwind.config.js)
const INK = '#1d1f4d', INK2 = '#2c2f6b', GOLD = '#8e7553', GOLDL = '#a89070'
const CREAM = '#f5f3ef', REDP = '#d63e3e', BLUEP = '#1d4ed8'
const PAPER = '#fbfaf8', LINE = '#e7e3da'

// ── Tool preview mocks (static SVG — no data, so the home needs no team) ──
const frame = 'w-full h-full'

function PvTrends() {
  return (
    <svg viewBox="0 0 240 120" className={frame} preserveAspectRatio="xMidYMid slice">
      <rect width="240" height="120" fill={PAPER} />
      {[34, 60, 86].map(y => <line key={y} x1="14" y1={y} x2="226" y2={y} stroke="#efece6" strokeWidth="1" />)}
      <polyline points="14,96 55,82 96,88 137,54 178,60 226,32" fill="none" stroke={INK} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
      <polyline points="14,102 55,94 96,72 137,76 178,50 226,56" fill="none" stroke={GOLD} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" opacity="0.85" />
      <circle cx="226" cy="32" r="3.5" fill={INK} />
      <circle cx="226" cy="56" r="3" fill={GOLD} />
    </svg>
  )
}

function PvLineup() {
  return (
    <svg viewBox="0 0 240 120" className={frame} preserveAspectRatio="xMidYMid slice">
      <rect width="240" height="120" fill={PAPER} />
      {[0, 1, 2, 3, 4].map(i => {
        const y = 14 + i * 20
        return (
          <g key={i}>
            <circle cx="28" cy={y + 7} r="7.5" fill={INK} />
            <text x="28" y={y + 10.5} fontSize="9" fill={CREAM} textAnchor="middle" fontWeight="700">{i + 1}</text>
            <rect x="46" y={y + 2} width={118 - i * 9} height="10" rx="3" fill={LINE} />
            <rect x="178" y={y + 2} width="34" height="10" rx="3" fill={i < 2 ? GOLDL : LINE} />
          </g>
        )
      })}
    </svg>
  )
}

function PvRapsodo() {
  const dots = [[150, 40, REDP], [165, 52, REDP], [92, 78, BLUEP], [80, 90, BLUEP], [120, 64, GOLD], [108, 55, GOLD]]
  return (
    <svg viewBox="0 0 240 120" className={frame} preserveAspectRatio="xMidYMid slice">
      <rect width="240" height="120" fill={PAPER} />
      <line x1="120" y1="14" x2="120" y2="106" stroke="#ded8cd" strokeWidth="1.5" />
      <line x1="36" y1="60" x2="204" y2="60" stroke="#ded8cd" strokeWidth="1.5" />
      {dots.map(([x, y, c], i) => <circle key={i} cx={x} cy={y} r="6" fill={c} opacity="0.85" />)}
    </svg>
  )
}

function PvBars({ vals = [88, 64, 41, 73, 22] }) {
  return (
    <svg viewBox="0 0 240 120" className={frame} preserveAspectRatio="xMidYMid slice">
      <rect width="240" height="120" fill={PAPER} />
      {vals.map((v, i) => {
        const y = 12 + i * 20
        const w = 28 + (v / 100) * 168
        const t = v / 100
        const r = Math.round(255 * (1 - Math.max(0, t - 0.5) * 2))
        const fill = t >= 0.5 ? `rgb(${214 + (255 - 214) * (1 - (t - 0.5) * 2)},62,62)` : `rgb(${r},${Math.round(120 + 100 * (1 - t * 2))},230)`
        return (
          <g key={i}>
            <rect x="14" y={y} width="196" height="11" rx="5.5" fill="#efece6" />
            <rect x="14" y={y} width={w} height="11" rx="5.5" fill={t >= 0.6 ? REDP : t >= 0.4 ? GOLD : BLUEP} opacity="0.9" />
          </g>
        )
      })}
    </svg>
  )
}

function PvMatchup() {
  const out = [REDP, '#cdd5e6', REDP, GOLD, '#cdd5e6', REDP, REDP, '#cdd5e6']
  return (
    <svg viewBox="0 0 240 120" className={frame} preserveAspectRatio="xMidYMid slice">
      <rect width="240" height="120" fill={PAPER} />
      <circle cx="40" cy="44" r="16" fill={INK} />
      <text x="40" y="48" fontSize="12" fill={CREAM} textAnchor="middle" fontWeight="700">B</text>
      <text x="120" y="48" fontSize="11" fill={GOLD} textAnchor="middle" fontWeight="700">vs</text>
      <circle cx="200" cy="44" r="16" fill={INK2} />
      <text x="200" y="48" fontSize="12" fill={CREAM} textAnchor="middle" fontWeight="700">P</text>
      {out.map((c, i) => <rect key={i} x={20 + i * 26} y="82" width="18" height="18" rx="4" fill={c} />)}
    </svg>
  )
}

function PvPlayerScout() {
  return (
    <svg viewBox="0 0 240 120" className={frame} preserveAspectRatio="xMidYMid slice">
      <rect width="240" height="120" fill={PAPER} />
      <circle cx="46" cy="44" r="26" fill="#e7e3da" />
      <circle cx="46" cy="36" r="9" fill={INK2} />
      <path d="M28 60 a18 14 0 0 1 36 0 z" fill={INK2} />
      <rect x="86" y="22" width="108" height="11" rx="4" fill={INK} />
      <rect x="86" y="40" width="78" height="8" rx="4" fill={LINE} />
      {[70, 86, 102].map((y, i) => (
        <g key={i}>
          <rect x="86" y={y} width="120" height="8" rx="4" fill="#efece6" />
          <rect x="86" y={y} width={[100, 64, 84][i]} height="8" rx="4" fill={GOLD} opacity="0.85" />
        </g>
      ))}
    </svg>
  )
}

function PvPdfs() {
  return (
    <svg viewBox="0 0 240 120" className={frame} preserveAspectRatio="xMidYMid slice">
      <rect width="240" height="120" fill={PAPER} />
      <rect x="78" y="26" width="84" height="76" rx="6" fill="#fff" stroke={LINE} strokeWidth="2" transform="rotate(-8 120 64)" />
      <rect x="86" y="22" width="84" height="76" rx="6" fill="#fff" stroke={LINE} strokeWidth="2" transform="rotate(4 120 60)" />
      <g transform="rotate(4 120 60)">
        {[34, 46, 58, 70].map(y => <rect key={y} x="96" y={y} width={y === 70 ? 40 : 64} height="6" rx="3" fill={LINE} />)}
      </g>
      <circle cx="150" cy="92" r="15" fill={GOLD} />
      <path d="M150 85 v12 M145 92 l5 5 l5 -5" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PvSheet({ rows = 6 }) {
  return (
    <svg viewBox="0 0 240 120" className={frame} preserveAspectRatio="xMidYMid slice">
      <rect width="240" height="120" fill={PAPER} />
      <rect x="40" y="12" width="160" height="96" rx="6" fill="#fff" stroke={LINE} strokeWidth="2" />
      <rect x="40" y="12" width="160" height="18" rx="6" fill={INK} />
      {Array.from({ length: rows }).map((_, i) => {
        const y = 38 + i * 11
        return (
          <g key={i}>
            <rect x="48" y={y} width="60" height="6" rx="3" fill={i % 2 ? LINE : '#d8d2c6'} />
            <rect x="118" y={y} width="22" height="6" rx="3" fill="#e7e3da" />
            <rect x="150" y={y} width="22" height="6" rx="3" fill="#e7e3da" />
            <rect x="182" y={y} width="10" height="6" rx="3" fill={GOLDL} />
          </g>
        )
      })}
    </svg>
  )
}

function PvBullpen() {
  return (
    <svg viewBox="0 0 240 120" className={frame} preserveAspectRatio="xMidYMid slice">
      <rect width="240" height="120" fill={PAPER} />
      <rect x="34" y="12" width="172" height="96" rx="6" fill="#fff" stroke={LINE} strokeWidth="2" />
      {[0, 1, 2, 3, 4].map(i => {
        const y = 22 + i * 17
        return (
          <g key={i}>
            <circle cx="48" cy={y + 6} r="5.5" fill={INK2} />
            <rect x="60" y={y + 1} width="60" height="9" rx="3" fill={LINE} />
            <rect x="128" y={y + 1} width="68" height="9" rx="3" fill="#efece6" />
            <rect x="128" y={y + 1} width={[58, 30, 46, 22, 50][i]} height="9" rx="3" fill={i === 0 ? REDP : GOLD} opacity="0.85" />
          </g>
        )
      })}
    </svg>
  )
}

function PvCatcherCards() {
  return (
    <svg viewBox="0 0 240 120" className={frame} preserveAspectRatio="xMidYMid slice">
      <rect width="240" height="120" fill={PAPER} />
      {[[60, 30], [142, 30], [60, 70], [142, 70]].map(([x, y], i) => (
        <g key={i}>
          <rect x={x - 18} y={y - 14} width="56" height="36" rx="5" fill="#fff" stroke={LINE} strokeWidth="2" />
          <rect x={x - 18} y={y - 14} width="56" height="9" rx="5" fill={INK} />
          <rect x={x - 12} y={y + 2} width="30" height="5" rx="2.5" fill={LINE} />
          <rect x={x - 12} y={y + 11} width="20" height="5" rx="2.5" fill={GOLDL} />
        </g>
      ))}
    </svg>
  )
}

function PvPlayerCard() {
  return (
    <svg viewBox="0 0 240 120" className={frame} preserveAspectRatio="xMidYMid slice">
      <rect width="240" height="120" fill={PAPER} />
      <rect x="70" y="10" width="100" height="100" rx="8" fill="#fff" stroke={LINE} strokeWidth="2" />
      <rect x="70" y="10" width="100" height="20" rx="8" fill={INK} />
      <path d="M120 92 L92 56 A36 36 0 0 1 148 56 Z" fill="#eee7da" />
      <line x1="120" y1="92" x2="92" y2="56" stroke={LINE} strokeWidth="1" />
      <line x1="120" y1="92" x2="148" y2="56" stroke={LINE} strokeWidth="1" />
      {[[104, 64, REDP], [132, 66, BLUEP], [118, 52, GOLD], [110, 76, REDP]].map(([x, y, c], i) => <circle key={i} cx={x} cy={y} r="3.2" fill={c} />)}
    </svg>
  )
}

function PvBulkCards() {
  return (
    <svg viewBox="0 0 240 120" className={frame} preserveAspectRatio="xMidYMid slice">
      <rect width="240" height="120" fill={PAPER} />
      {[[-14, 10], [0, 4], [14, -2]].map(([dx, dy], i) => (
        <rect key={i} x={92 + dx} y={28 + dy} width="64" height="74" rx="6" fill="#fff" stroke={LINE} strokeWidth="2" transform={`rotate(${(i - 1) * 6} 120 64)`} />
      ))}
      <g transform="rotate(6 120 64)">
        <rect x={106} y={22} width="64" height="16" rx="6" fill={GOLD} />
        {[44, 54, 64, 74].map(y => <rect key={y} x="114" y={y} width={y === 74 ? 28 : 48} height="5" rx="2.5" fill={LINE} />)}
      </g>
    </svg>
  )
}

function PvBracket() {
  return (
    <svg viewBox="0 0 240 120" className={frame} preserveAspectRatio="xMidYMid slice">
      <rect width="240" height="120" fill={PAPER} />
      {[24, 44, 76, 96].map(y => <rect key={y} x="20" y={y - 5} width="44" height="9" rx="3" fill={LINE} />)}
      {[34, 86].map(y => <rect key={y} x="96" y={y - 5} width="44" height="9" rx="3" fill="#d8d2c6" />)}
      <rect x="172" y="55" width="48" height="11" rx="4" fill={GOLD} />
      <path d="M64 24 H80 V34 H96 M64 44 H80 V34 M64 76 H80 V86 H96 M64 96 H80 V86 M140 34 H156 V60 H172 M140 86 H156 V60" fill="none" stroke="#cfc8bb" strokeWidth="1.6" />
    </svg>
  )
}

// ── Tool catalog (mirrors the portal nav) ──
const SECTIONS = [
  {
    label: 'Coaching Tools',
    blurb: 'Plan around an opponent and tighten your own staff.',
    tools: [
      { to: '/portal/trends', label: 'Trends', desc: 'Lineups, rotation & bullpen usage scouting over time.', Preview: PvTrends },
      { to: '/portal/lineup-helper', label: 'Lineup Helper', desc: 'Optimal batting orders vs RHP / vs LHP, plus the bench.', Preview: PvLineup },
      { to: '/portal/rapsodo', label: 'Rapsodo Lab', desc: 'Upload bullpen CSVs for cleaned pitch profiles & movement.', Preview: PvRapsodo },
    ],
  },
  {
    label: 'Opponent Scouting',
    blurb: 'Know who you are facing, down to the plate appearance.',
    tools: [
      { to: '/portal/team-scouting', label: 'Team Scouting', desc: 'Full team report — every stat with percentile context.', Preview: PvBars },
      { to: '/portal/historic', label: 'Historic Matchups', desc: 'Per-PA matchup history vs a specific opponent.', Preview: PvMatchup },
      { to: '/portal/player-scouting', label: 'Player Scouting', desc: 'Individual scouting reports on any hitter or pitcher.', Preview: PvPlayerScout },
    ],
  },
  {
    label: 'PDFs & Printables',
    blurb: 'Dugout-ready paper you can print the morning of a game.',
    tools: [
      { to: '/portal/pdfs', label: 'All PDFs', desc: 'Pickers for every printable PDF in one place.', Preview: PvPdfs },
      { to: '/portal/scouting-sheet', label: 'Scouting Sheet', desc: 'Hitter + pitcher rosters with conference percentiles.', Preview: PvSheet },
      { to: '/portal/bullpen-sheet', label: 'Bullpen Sheet', desc: 'Pitcher roster + situational leaderboards for in-game calls.', Preview: PvBullpen },
      { to: '/portal/catcher-cards', label: 'Catcher Cards', desc: 'Pocket 5×2 pitch-calling cards (top 14 opposing hitters).', Preview: PvCatcherCards },
      { to: '/portal/pdfs', label: 'Player Card', desc: 'One-page Statcast-style profile: spray chart, percentiles, splits.', Preview: PvPlayerCard },
      { to: '/portal/pdfs', label: 'Bulk Player Cards', desc: 'Print cards for an entire roster (or a subset) in one job.', Preview: PvBulkCards },
      { to: '/portal/nwac-tournament-sheet', label: 'NWAC Tournament Sheet', desc: 'Bracket-ready field report for the NWAC championship.', Preview: PvBracket },
    ],
  },
]


function ToolCard({ to, label, desc, Preview }) {
  return (
    <Link
      to={to}
      className="group flex flex-col rounded-xl overflow-hidden bg-white dark:bg-gray-800
                 border border-gray-200 dark:border-gray-700 shadow-sm
                 hover:shadow-lg hover:-translate-y-0.5 hover:border-portal-accent
                 transition-all duration-150"
    >
      <div className="relative h-28 bg-portal-cream dark:bg-gray-900/40 border-b border-gray-100 dark:border-gray-700">
        <Preview />
        <span className="absolute top-2 right-2 text-[10px] font-bold uppercase tracking-wider
                         text-portal-accent opacity-0 group-hover:opacity-100 transition-opacity">
          Open →
        </span>
      </div>
      <div className="p-3.5">
        <h3 className="text-[15px] font-bold text-portal-purple dark:text-portal-accent-light leading-tight">
          {label}
        </h3>
        <p className="mt-1 text-[12px] leading-snug text-gray-500 dark:text-gray-400">
          {desc}
        </p>
      </div>
    </Link>
  )
}


export default function PortalHome() {
  const { team } = usePortalTeam()

  useEffect(() => {
    document.title = 'Coaching Portal · NW Baseball Stats'
  }, [])

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-5 py-6">
      {/* Hero */}
      <div className="rounded-2xl bg-gradient-to-br from-portal-purple to-portal-purple-dark
                      text-portal-cream px-5 sm:px-8 py-6 sm:py-7 shadow-md">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-portal-accent-light">
              Coach &amp; Scouting Portal
            </p>
            <h1 className="mt-1 text-2xl sm:text-3xl font-bold leading-tight">
              Your whole toolkit, in one place
            </h1>
            <p className="mt-2 text-sm text-portal-cream/70 max-w-xl">
              Every coaching and scouting tool below. Open one to dig in — the
              team-specific tools will use your focus team automatically.
            </p>
          </div>
          {team && (
            <div className="flex items-center gap-2 bg-portal-purple-light/50 rounded-full pl-1.5 pr-3 py-1.5">
              {team.logo_url && (
                <img src={team.logo_url} alt="" className="h-7 w-7 object-contain rounded-full bg-white p-0.5" />
              )}
              <div className="leading-tight">
                <div className="text-[10px] uppercase tracking-wide text-portal-cream/60">Focus team</div>
                <div className="text-sm font-semibold">{team.short_name || team.name}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Tool sections */}
      {SECTIONS.map(section => (
        <section key={section.label} className="mt-8">
          <div className="flex items-baseline gap-3 mb-3">
            <h2 className="text-lg font-bold text-portal-purple dark:text-gray-100">{section.label}</h2>
            <span className="text-[13px] text-gray-400 dark:text-gray-500 hidden sm:inline">{section.blurb}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {section.tools.map((t, i) => <ToolCard key={t.label + i} {...t} />)}
          </div>
        </section>
      ))}
    </div>
  )
}
