// PortalHome — landing page of the Coach & Scouting Portal.
// Intentionally minimal for now; will fill in with custom content later.
// Once the user has selected a primary team via PortalTeamGate, they
// land here and can navigate to specific tools via the header.

import { Link } from 'react-router-dom'
import { usePortalTeam } from '../context/PortalTeamContext'


export default function PortalHome() {
  const { team } = usePortalTeam()

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      {/* Hero */}
      <div className="bg-portal-purple text-portal-cream rounded-xl p-6 sm:p-8 mb-6 shadow-md">
        <div className="text-[10px] uppercase tracking-widest text-portal-accent font-semibold mb-2">
          Coach &amp; Scouting Portal
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold mb-2">
          Welcome back{team ? `, ${team.short_name || team.name} staff` : ''}.
        </h1>
        <p className="text-sm text-portal-cream/80 max-w-2xl">
          Tools and reports tailored for coaches and scouts. Choose a section
          from the header to dig into opponent matchups, player tendencies,
          and downloadable scouting documents.
        </p>
      </div>

      {/* Section cards (placeholder grid) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SectionCard
          title="Coaching Tools"
          description="Lineups, rotation patterns, bullpen usage."
          link="/portal/trends"
          linkLabel="Open Trends →"
        />
        <SectionCard
          title="Opponent Scouting"
          description="Per-PA matchup history and individual scouting reports."
          link="/portal/historic"
          linkLabel="Historic Matchups →"
        />
        <SectionCard
          title="PDFs"
          description="Downloadable scouting documents."
          link={null}
          linkLabel="Coming soon"
        />
      </div>
    </div>
  )
}


function SectionCard({ title, description, link, linkLabel }) {
  const cardClasses = 'bg-white border border-gray-200 rounded-lg p-5 hover:shadow-md transition-shadow'
  const inner = (
    <>
      <div className="text-[10px] uppercase tracking-widest text-portal-accent font-semibold mb-1">
        {title}
      </div>
      <p className="text-sm text-gray-600 mb-3 leading-relaxed">
        {description}
      </p>
      <span className={`text-xs font-semibold ${link ? 'text-portal-purple' : 'text-gray-400'}`}>
        {linkLabel}
      </span>
    </>
  )
  return link ? (
    <Link to={link} className={cardClasses}>{inner}</Link>
  ) : (
    <div className={`${cardClasses} cursor-not-allowed opacity-70`}>{inner}</div>
  )
}
