/**
 * Outlined pixel-letter team logos (per Nate, May 2026 — visuals
 * iteration 2). No background tile — the 2-letter abbreviation renders
 * directly with the team's PRIMARY color as the letter fill and the
 * SECONDARY color as the outline stroke. "Press Start 2P" pixel font.
 *
 * PNW programs (57 teams):
 *   - 2-letter abbreviation from TEAM_BRAND in data/teamBrand.js
 *   - Primary color = letter fill, secondary color = outline stroke
 *
 * Non-PNW teams (1,100+):
 *   - Single white letter (first letter of name) with a thin dark
 *     outline so it stays legible on both light + dark surfaces.
 *
 * Contract unchanged — pass `school`, get back a rendered logo at the
 * requested `size`. Every existing <TeamLogo school={...} size={n} />
 * call site keeps working.
 */

import { TEAM_BRAND, brandAbbr } from '../data/teamBrand'

// Neutral outline for non-PNW (lets the white letter sit on either
// light or dark backgrounds).
const NON_PNW_FILL = '#FFFFFF'
const NON_PNW_STROKE = '#1F2937'   // pnw-slate-ish dark

export default function TeamLogo({ school, size = 32, className = '' }) {
  if (!school) return null

  const brand = TEAM_BRAND[school.id]
  const isPnw = !!brand
  const abbr = isPnw ? brand.abbr : brandAbbr(school.id, school.name || school.nickname)
  const fill = isPnw ? brand.primary : NON_PNW_FILL
  const stroke = isPnw ? brand.secondary : NON_PNW_STROKE

  // Letter sizing — pixel fonts are wide, 2-letter abbrs need a smaller
  // glyph than a single letter so the logo lands at roughly the same
  // visual footprint regardless of how many characters it has.
  const len = abbr.length || 1
  const fontSize = Math.max(10, Math.round(size * (len === 1 ? 0.80 : 0.60)))

  // Outline width scales with logo size — at tiny sizes (≤16px) a 1px
  // stroke is plenty; at large sizes (64px team-banner) the outline
  // needs to be thicker to still read as an "outline" instead of a
  // hairline. Caps at 3px so the letter shape stays readable.
  const strokeWidth = Math.max(1, Math.min(3, Math.round(size * 0.05)))

  return (
    <span
      className={`inline-flex items-center justify-center font-pixel-display shrink-0 select-none ${className}`}
      style={{
        width: size,
        height: size,
        color: fill,
        fontSize,
        lineHeight: 1,
        letterSpacing: '0.02em',
        // -webkit-text-stroke is the cleanest cross-browser way to draw
        // an outline on text. Supported in Chrome / Safari / Firefox 49+
        // / Edge. Paints the stroke OUTSIDE the letter shape.
        WebkitTextStroke: `${strokeWidth}px ${stroke}`,
      }}
      aria-label={school.name}
      title={school.name}
    >
      {abbr}
    </span>
  )
}
