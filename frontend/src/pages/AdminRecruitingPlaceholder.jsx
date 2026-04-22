import Placeholder from './Placeholder'

// Placeholder stub for the admin-only /recruiting/breakdowns route.
// Distinct from RecruitingBreakdown.jsx (singular) which is the real
// auth-required recruiting page. When this admin feature is built out,
// replace this file with the real component and rename the route.
export default function AdminRecruitingPlaceholder() {
  return (
    <Placeholder
      title="Recruiting Breakdowns"
      description="Detailed recruiting analysis and breakdowns by region, position, and more. Coming soon!"
    />
  )
}
