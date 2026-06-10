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
  // EXPANSION TEAMS (per Nate, June 2026): user-defined schools carry
  // colors directly on school.colors. TEAM_BRAND lookup won't have them,
  // so honor the user's pick instead of falling back to the neutral
  // white-on-slate template. Same logic for any custom school added at
  // runtime that includes a colors block.
  const userColors = school.colors
  const hasCustomColors = !!(userColors && (userColors.primary || userColors.secondary))
  const abbr = isPnw ? brand.abbr : brandAbbr(school.id, school.name || school.nickname)
  const fill = isPnw
    ? brand.primary
    : (hasCustomColors ? (userColors.primary || NON_PNW_FILL) : NON_PNW_FILL)
  const stroke = isPnw
    ? brand.secondary
    : (hasCustomColors ? (userColors.secondary || NON_PNW_STROKE) : NON_PNW_STROKE)

  // Letter sizing — pixel fonts are wide, longer abbrs need a smaller
  // glyph so the logo lands at roughly the same visual footprint
  // regardless of character count (1, 2, or 3 letters all fit the same
  // tile size). L&C is 3 chars including the ampersand.
  const len = abbr.length || 1
  const scale = len <= 1 ? 0.80
    : len === 2 ? 0.60
    : len === 3 ? 0.44
    : 0.36
  const fontSize = Math.max(8, Math.round(size * scale))

  // Outline width scales with BOTH logo size AND abbr length. 3-letter
  // codes (OSU, WSU, UBC, COI, OIT, MSB, PLU, UPS, EOU, CWU, SMU, NNU,
  // WOU, L&C) have thinner letters than 2-letter codes at the same tile
  // size — so we ALSO need a thinner stroke or the outline overwhelms
  // the letter shape (per Nate — "3 letter teams have too heavy of a
  // shadow").
  //   1-char: 6% of size (1-3px range)
  //   2-char: 5% (1-3px)
  //   3-char: 3% (1-2px)
  //   4-char: 2.5% (1-2px) — L&C with the ampersand
  const strokeScale = len <= 1 ? 0.06
    : len === 2 ? 0.05
    : len === 3 ? 0.03
    : 0.025
  const strokeWidth = Math.max(1, Math.min(3, Math.round(size * strokeScale)))

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
