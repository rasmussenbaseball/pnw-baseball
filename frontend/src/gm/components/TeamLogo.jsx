/**
 * Placeholder team logo: a circular monogram from the team's initials,
 * filled with the team's primary color and outlined in the secondary color.
 *
 * When real logo files are added later, replace this with an <img> path
 * lookup (e.g. /gm/logos/{schoolId}.png). The contract is the same:
 * pass a school (or anything with name/colors), get back a rendered logo.
 */

export default function TeamLogo({ school, size = 32, className = '' }) {
  if (!school) return null

  const initials = computeInitials(school.name || school.nickname || '?')
  const primary = school.colors?.primary || '#1F2937'
  const secondary = school.colors?.secondary || '#FFFFFF'

  // Font size scales with circle size
  const fontSize = Math.max(10, Math.round(size * 0.42))

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-bold shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: primary,
        color: secondary,
        border: `2px solid ${secondary}`,
        fontSize,
        lineHeight: 1,
        letterSpacing: '-0.02em',
      }}
      aria-label={school.name}
      title={school.name}
    >
      {initials}
    </span>
  )
}

function computeInitials(name) {
  const cleaned = name
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(of|the|and|at|in|st\.?|saint)\b/gi, '')
    .trim()
  const words = cleaned.split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}
