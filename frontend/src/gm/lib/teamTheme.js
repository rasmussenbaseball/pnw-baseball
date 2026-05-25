/**
 * Team-aware theming — derive accent colors + accessible foreground
 * colors from the user's selected program. Replaces the hard-coded NW
 * teal/yellow palette throughout the GM screens with the player's
 * actual school colors.
 *
 * Usage:
 *   import { applyTeamTheme } from '../../gm/lib/teamTheme'
 *   useEffect(() => { applyTeamTheme(save?.userSchoolId) }, [save])
 *
 * Stamps the following CSS variables onto <html>:
 *   --team-primary       team's primary hex
 *   --team-primary-fg    white or dark slate, whichever has contrast against primary
 *   --team-secondary     team's secondary hex
 *   --team-secondary-fg  white or dark slate, whichever has contrast against secondary
 *   --team-primary-dim   primary darkened by ~20% (for gradients)
 *   --team-accent        whichever of primary/secondary makes a better "accent"
 *                        color (avoiding white/near-black which read as flat)
 *   --team-accent-fg     readable text on the accent color
 *
 * Falls back to the original PNW teal palette if no PNW team is selected
 * (e.g. user picked a non-PNW school or there's no save yet).
 */

import { TEAM_BRAND } from '../data/teamBrand'

// Fallback (original NW teal palette).
const FALLBACK = {
  primary: '#00687a',
  secondary: '#FFD200',
}

/** 0-255 luminance proxy for a hex color. */
function luminance(hex) {
  if (!hex || typeof hex !== 'string') return 128
  const m = hex.replace('#', '')
  if (m.length !== 6) return 128
  const r = parseInt(m.slice(0, 2), 16)
  const g = parseInt(m.slice(2, 4), 16)
  const b = parseInt(m.slice(4, 6), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** True if the color is bright enough that black text reads on it. */
function isLight(hex) { return luminance(hex) > 165 }

/** Best foreground color for a given background. */
function fgFor(bg) { return isLight(bg) ? '#1a1a2e' : '#FFFFFF' }

/** Darken a hex by `amt` percentage (0-1). Used for gradient endpoints. */
function darken(hex, amt = 0.2) {
  if (!hex || typeof hex !== 'string') return hex
  const m = hex.replace('#', '')
  if (m.length !== 6) return hex
  const r = Math.max(0, Math.round(parseInt(m.slice(0, 2), 16) * (1 - amt)))
  const g = Math.max(0, Math.round(parseInt(m.slice(2, 4), 16) * (1 - amt)))
  const b = Math.max(0, Math.round(parseInt(m.slice(4, 6), 16) * (1 - amt)))
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')
}

/**
 * Pick the better of primary/secondary to use as the "accent" highlight
 * (selected tabs, key buttons, focus rings). We avoid using a near-white
 * or pure-black secondary as an accent — those read flat in a UI — so
 * if the secondary is one of those, we fall back to the primary.
 */
function pickAccent(primary, secondary) {
  const lp = luminance(primary)
  const ls = luminance(secondary)
  // If secondary is too washed-out (white-ish) or too pure-black, use primary.
  if (ls > 235 || ls < 20) return primary
  return secondary
}

/** Build the theme object from a school id. */
export function getTeamTheme(schoolId) {
  const brand = TEAM_BRAND[schoolId]
  const primary = brand?.primary || FALLBACK.primary
  const secondary = brand?.secondary || FALLBACK.secondary
  const accent = pickAccent(primary, secondary)
  return {
    primary,
    primaryFg: fgFor(primary),
    primaryDim: darken(primary, 0.25),
    secondary,
    secondaryFg: fgFor(secondary),
    accent,
    accentFg: fgFor(accent),
    isPnw: !!brand,
  }
}

/**
 * Apply the team theme to <html> as CSS variables. Components reference
 * them via `style={{ background: 'var(--team-primary)' }}` or via the
 * Tailwind `pnw-green` / `pnw-slate` aliases (rewired to read these vars
 * in tailwind.config.js).
 */
export function applyTeamTheme(schoolId) {
  if (typeof document === 'undefined') return
  const t = getTeamTheme(schoolId)
  const root = document.documentElement
  root.style.setProperty('--team-primary', t.primary)
  root.style.setProperty('--team-primary-fg', t.primaryFg)
  root.style.setProperty('--team-primary-dim', t.primaryDim)
  root.style.setProperty('--team-secondary', t.secondary)
  root.style.setProperty('--team-secondary-fg', t.secondaryFg)
  root.style.setProperty('--team-accent', t.accent)
  root.style.setProperty('--team-accent-fg', t.accentFg)
}

/** Clear the team theme (e.g. when leaving the GM section). */
export function clearTeamTheme() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const v of ['--team-primary', '--team-primary-fg', '--team-primary-dim',
    '--team-secondary', '--team-secondary-fg', '--team-accent', '--team-accent-fg']) {
    root.style.removeProperty(v)
  }
}
