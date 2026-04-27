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

import { Outlet, Link, useLocation } from 'react-router-dom'
import PortalHeader from './PortalHeader'
import { PortalTeamProvider } from '../context/PortalTeamContext'
import PortalTeamGate from './PortalTeamGate'


export default function PortalLayout() {
  return (
    <PortalTeamProvider>
      <div className="min-h-screen bg-portal-cream">
        <PortalHeader />
        <PortalTeamGate>
          <main>
            <Outlet />
          </main>
        </PortalTeamGate>
      </div>
    </PortalTeamProvider>
  )
}
