// PortalHeader — themed nav for the Coach & Scouting Portal.
//
// Sections:
//   - Home (links to /portal)
//   - Coaching Tools dropdown → Trends
//   - Opponent Scouting dropdown → Historic Matchups, Player Scouting
//   - PDFs dropdown (empty for now — placeholder)
//
// Right side:
//   - Current team chip (with logo + "Switch" button)
//   - "Back to Main Site" link
//
// Colors are deliberately darker / heavier than the main site so the
// portal feels like a different surface entirely.

import { useState, useRef, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { usePortalTeam } from '../context/PortalTeamContext'


const NAV_SECTIONS = [
  {
    label: 'Coaching Tools',
    items: [
      { to: '/portal/trends', label: 'Trends',
        desc: 'Lineups, rotation & bullpen scouting' },
      { to: '/portal/lineup-helper', label: 'Lineup Helper',
        desc: 'Optimal vs RHP / vs LHP batting orders + bench' },
    ],
  },
  {
    label: 'Opponent Scouting',
    items: [
      { to: '/portal/team-scouting', label: 'Team Scouting',
        desc: 'Full team report — every stat with percentile context' },
      { to: '/portal/historic', label: 'Historic Matchups',
        desc: 'Per-PA matchup history vs an opponent' },
      { to: '/portal/player-scouting', label: 'Player Scouting',
        desc: 'Individual scouting reports' },
    ],
  },
  {
    label: 'PDFs',
    items: [
      { to: '/portal/scouting-sheet', label: 'Scouting Sheet',
        desc: 'Printable hitter + pitcher rosters with conference percentiles' },
    ],
  },
]


export default function PortalHeader() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()

  // Close mobile menu on route change
  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  return (
    <header className="bg-portal-purple text-portal-cream shadow-md">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between h-[72px] gap-3">
          <PortalLogo />
          <nav className="hidden md:flex items-center gap-1">
            <Link
              to="/portal"
              className="px-3 py-2 rounded text-sm font-medium
                         hover:bg-portal-purple-light transition-colors"
            >
              Home
            </Link>
            {NAV_SECTIONS.map(section => (
              <NavDropdown key={section.label} section={section} />
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <CurrentTeamChip />
            <Link
              to="/"
              className="hidden sm:inline-block text-xs px-3 py-1.5 rounded
                         border border-portal-cream/30
                         text-portal-cream hover:bg-portal-purple-light
                         transition-colors whitespace-nowrap"
            >
              ← Main Site
            </Link>
            {/* Hamburger — mobile only */}
            <button
              type="button"
              onClick={() => setMobileOpen(o => !o)}
              className="md:hidden p-2 rounded hover:bg-portal-purple-light transition-colors"
              aria-label="Open navigation menu"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                {mobileOpen ? (
                  <>
                    <line x1="6" y1="6" x2="18" y2="18" />
                    <line x1="6" y1="18" x2="18" y2="6" />
                  </>
                ) : (
                  <>
                    <line x1="4" y1="6" x2="20" y2="6" />
                    <line x1="4" y1="12" x2="20" y2="12" />
                    <line x1="4" y1="18" x2="20" y2="18" />
                  </>
                )}
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Mobile menu drawer */}
      {mobileOpen && (
        <nav className="md:hidden border-t border-portal-cream/20 bg-portal-purple">
          <div className="max-w-7xl mx-auto px-4 py-2 space-y-1">
            <Link
              to="/portal"
              className="block px-3 py-2 rounded text-sm font-semibold
                         hover:bg-portal-purple-light"
            >
              Home
            </Link>
            {NAV_SECTIONS.map(section => (
              <div key={section.label} className="pt-2">
                <div className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider opacity-70">
                  {section.label}
                </div>
                {section.items.length === 0 ? (
                  <div className="px-3 py-1.5 text-sm opacity-50 italic">Coming soon</div>
                ) : (
                  section.items.map(item => (
                    <Link
                      key={item.to}
                      to={item.to}
                      className="block px-3 py-2 rounded text-sm
                                 hover:bg-portal-purple-light"
                    >
                      <div className="font-medium">{item.label}</div>
                      {item.desc && (
                        <div className="text-[11px] opacity-70 leading-snug">{item.desc}</div>
                      )}
                    </Link>
                  ))
                )}
              </div>
            ))}
            <Link
              to="/"
              className="block mt-3 px-3 py-2 rounded text-sm border border-portal-cream/30 text-center
                         hover:bg-portal-purple-light"
            >
              ← Main Site
            </Link>
          </div>
        </nav>
      )}
    </header>
  )
}


function PortalLogo() {
  return (
    <Link to="/portal" className="flex items-center gap-3 shrink-0">
      <img
        src="/images/nw-portal-logo.png"
        alt="NW"
        className="h-12 w-auto object-contain"
        onError={(e) => { e.currentTarget.style.display = 'none' }}
      />
      <span className="hidden md:inline text-portal-cream text-base sm:text-lg
                       font-medium tracking-wide leading-none">
        Coaching &amp; Scouting Portal
      </span>
    </Link>
  )
}


function NavDropdown({ section }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const location = useLocation()

  // Close on route change
  useEffect(() => {
    setOpen(false)
  }, [location.pathname])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const empty = section.items.length === 0

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !empty && setOpen(!open)}
        className={`px-3 py-2 rounded text-sm font-medium
                    transition-colors flex items-center gap-1
                    ${empty ? 'opacity-50 cursor-not-allowed' :
                      'hover:bg-portal-purple-light'}`}
        disabled={empty}
        title={empty ? 'Coming soon' : undefined}
      >
        {section.label}
        {!empty && <span className="text-[9px] opacity-70">▼</span>}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 min-w-[260px] z-50
                        bg-white text-gray-900 rounded-lg shadow-lg border
                        border-gray-200 py-1.5">
          {section.items.map(item => (
            <Link
              key={item.to}
              to={item.to}
              className="block px-3 py-2 hover:bg-portal-purple/5
                         transition-colors"
            >
              <div className="text-sm font-semibold text-portal-purple">
                {item.label}
              </div>
              <div className="text-[11px] text-gray-500 mt-0.5">
                {item.desc}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}


function CurrentTeamChip() {
  const { team, clearTeam } = usePortalTeam()
  if (!team) return null
  return (
    <div className="hidden sm:flex items-center gap-2 bg-portal-purple-light/40
                    rounded-full pl-1 pr-2 py-1">
      {team.logo_url && (
        <img src={team.logo_url} alt=""
             className="h-6 w-6 object-contain rounded-full bg-white p-0.5" />
      )}
      <span className="text-xs font-semibold text-portal-cream max-w-[120px] truncate">
        {team.short_name || team.name}
      </span>
      <button
        onClick={clearTeam}
        title="Switch focus team"
        className="text-[10px] px-1.5 py-0.5 rounded bg-portal-accent
                   text-portal-purple-dark font-bold hover:bg-portal-accent-light
                   transition-colors"
      >
        switch
      </button>
    </div>
  )
}
