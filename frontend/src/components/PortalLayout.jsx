// PortalLayout — wrapper for the Coach & Scouting Portal.
//
// Provides the portal-specific themed header on top of any portal
// page. Stores the user's selected primary team in localStorage
// (key: 'portalPrimaryTeam') so other portal pages can read it via
// the usePortalTeam hook.
//
// Visual identity:
//   - Background: portal-cream (off-white) for content surface
//   - Header: portal-purple (deep indigo)
//   - Accent: portal-accent (antique gold)
// The main-site components rendered inside the portal still use
// their own teal/green palette internally — that's by design,
// the portal "frames" them with the dark theme.

import { useEffect } from 'react'
import PortalHeader from './PortalHeader'
import { PortalTeamProvider } from '../context/PortalTeamContext'
import PortalTeamGate from './PortalTeamGate'
import { ensureGoogleFonts } from '../lib/loadFonts'


// PortalLayout takes its content via the `children` prop now. Each
// portal route declares <PortalLayout><Page /></PortalLayout> directly
// in App.jsx — simpler than nested routes + Outlet, and easier to
// reason about when routes don't render as expected.
// `lightOnly` keeps the surface light regardless of the site dark-mode
// toggle. Used for the printable PDF pages (scouting sheet, bullpen
// sheet, catcher cards, player cards, tournament sheet) which are
// designed to render as white paper — darkening them would fight the
// print output.
export default function PortalLayout({ children, lightOnly = false }) {
  // Outfit (the portal typeface) loads here, not in index.html — most
  // site visitors never enter the portal.
  useEffect(() => {
    ensureGoogleFonts('portal-fonts', 'family=Outfit:wght@400;500;600;700')
  }, [])
  return (
    <PortalTeamProvider>
      {/* font-portal cascades the Outfit typeface to everything inside
          the portal — header, home page, plus all wrapped pages.
          Interactive pages follow the site dark-mode toggle (cream in
          light, gray-900 in dark) and the default text color flips with
          it. Print pages pass lightOnly so they always stay paper-white. */}
      <div className={`min-h-screen font-portal ${
        lightOnly
          ? 'bg-portal-cream text-gray-900'
          : 'bg-portal-cream dark:bg-gray-900 text-gray-900 dark:text-gray-100'
      }`}>
        <PortalHeader />
        <PortalTeamGate>
          <main>
            {children}
          </main>
        </PortalTeamGate>
      </div>
    </PortalTeamProvider>
  )
}
