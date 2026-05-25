/**
 * Pixelated 2-letter monogram team logos (per Nate, May 2026 — visuals
 * overhaul).
 *
 * PNW programs (57 teams):
 *   - 2-letter abbreviation pulled from TEAM_BRAND in data/teamBrand.js
 *   - Square tile with the team's PRIMARY color as background and SECONDARY
 *     color as the letter color
 *   - Pixel-display font (font-pixel-display) for the retro look
 *   - Thin secondary-color outline ring on the tile
 *
 * Non-PNW teams (1,100+):
 *   - Single white letter (first letter of the team name) on a neutral
 *     dark-slate tile. Same shape + font as PNW logos so they slot in
 *     visually without each carrying bespoke branding.
 *
 * Contract is unchanged from the previous component: pass `school` (or
 * any object with id + name), get back a rendered logo. Every existing
 * <TeamLogo school={...} size={n} /> call site keeps working.
 */

import { TEAM_BRAND, brandAbbr } from '../data/teamBrand'

// Neutral fallback for any non-PNW team. Dark slate matches the rest of
// the GM screen palette so single-letter logos still feel like the same
// product, just without team-specific branding.
const NON_PNW_BG = '#1F2937'      // pnw-slate-ish dark
const NON_PNW_FG = '#FFFFFF'

export default function TeamLogo({ school, size = 32, className = '' }) {
  if (!school) return null

  const brand = TEAM_BRAND[school.id]
  const isPnw = !!brand
  const abbr = isPnw ? brand.abbr : brandAbbr(school.id, school.name || school.nickname)
  const primary = isPnw ? brand.primary : NON_PNW_BG
  const secondary = isPnw ? brand.secondary : NON_PNW_FG

  // Two letters need a smaller font than one. Pixel fonts are wide.
  const len = abbr.length || 1
  const fontSize = Math.max(8, Math.round(size * (len === 1 ? 0.58 : 0.46)))

  // Tile shape: square with slightly rounded corners (~12% radius).
  // This is the "pixel chip" look — no circle, no soft edges.
  const radius = Math.max(2, Math.round(size * 0.12))

  // Outline: thin secondary-color border for definition. When the primary
  // is very light (white, near-white) we add an inner darkish ring instead
  // so the logo doesn't disappear on light surfaces.
  const isLightPrimary = isVeryLight(primary)
  const ringColor = isLightPrimary ? '#1F2937' : secondary
  const ringWidth = Math.max(1, Math.round(size * 0.06))

  return (
    <span
      className={`inline-flex items-center justify-center font-pixel-display shrink-0 select-none ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: primary,
        color: secondary,
        border: `${ringWidth}px solid ${ringColor}`,
        borderRadius: radius,
        fontSize,
        lineHeight: 1,
        letterSpacing: '0.02em',
        // Crisp pixel rendering on retina displays.
        imageRendering: 'pixelated',
        // Subtle inset shadow + outer shadow to give the tile depth without
        // breaking the flat pixel-art feel.
        boxShadow: `inset 0 -${Math.max(1, Math.round(size * 0.06))}px 0 rgba(0,0,0,0.20)`,
      }}
      aria-label={school.name}
      title={school.name}
    >
      {abbr}
    </span>
  )
}

/** Hex luminance helper — used to swap the ring color so logos like
 * Wenatchee Valley (white background) still have a visible outline. */
function isVeryLight(hex) {
  if (!hex || typeof hex !== 'string') return false
  const m = hex.replace('#', '')
  if (m.length !== 6) return false
  const r = parseInt(m.slice(0, 2), 16)
  const g = parseInt(m.slice(2, 4), 16)
  const b = parseInt(m.slice(4, 6), 16)
  // Standard relative-luminance approximation (0-255 scale).
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  return lum > 220
}
