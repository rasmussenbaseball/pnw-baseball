/**
 * Display formatting helpers for GM UI.
 */

/**
 * Convert snake_case / SCREAMING_SNAKE_CASE → Title Case With Spaces.
 *   "power_l"     → "Power L"
 *   "HEAD_COACH"  → "Head Coach"
 *   "vs_r"        → "Vs R"
 */
export function prettyLabel(s) {
  if (!s) return ''
  return String(s).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/** Format dollars with K suffix: 47500 → "$47.5K", 1200000 → "$1.2M". */
export function moneyShort(n) {
  if (n == null) return '—'
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M'
  if (Math.abs(n) >= 1_000) return '$' + (n / 1_000).toFixed(1) + 'K'
  return '$' + Math.round(n).toLocaleString()
}
