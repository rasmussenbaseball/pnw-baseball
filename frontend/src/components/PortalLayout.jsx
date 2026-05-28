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

import PortalHeader from './PortalHeader'
import { PortalTeamProvider } from '../context/PortalTeamContext'
import PortalTeamGate from './PortalTeamGate'


// PortalLayout takes its content via the `children` prop now. Each
// portal route declares <PortalLayout><Page /></PortalLayout> directly
// in App.jsx — simpler than nested routes + Outlet, and easier to
// reason about when routes don't render as expected.
export default function PortalLayout({ children }) {
  return (
    <PortalTeamProvider>
      {/* font-portal cascades the Outfit typeface to everything inside
          the portal — header, home page, plus all wrapped pages
          (Trends, Historic, Player Scouting).
          text-gray-900 pins the default text color dark: the portal is
          a permanently-light cream surface, so without this it would
          inherit the dark-mode body color (gray-100) and any element
          without an explicit text color would turn light and vanish on
          the light boxes. Components with their own text-* / dark:text-*
          classes still override this default. */}
      <div className="min-h-screen bg-portal-cream font-portal text-gray-900">
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
