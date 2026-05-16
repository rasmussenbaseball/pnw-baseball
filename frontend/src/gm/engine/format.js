/**
 * Display formatting helpers for GM UI.
 */

/**
 * Convert snake_case / SCREAMING_SNAKE_CASE Title Case With Spaces.
 *   "power_l"     "Power L"
 *   "HEAD_COACH"  "Head Coach"
 *   "vs_r"        "Vs R"
 */
export function prettyLabel(s) {
  if (!s) return ''
  return String(s).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Display position — unifies SP/RP to "P" since the coach decides who
 * starts vs. relieves based on stamina + stuff at sim time.
 */
export function displayPosition(pos) {
  if (pos === 'SP' || pos === 'RP') return 'P'
  return pos
}

/**
 * Display class year — prefixes "RS-" if the player has used a redshirt year.
 *   FR + redshirtUsed "RS-FR"
 */
export function displayClassYear(player) {
  if (!player) return ''
  return (player.redshirtUsed ? 'RS-' : '') + player.classYear
}

/** Format dollars with K suffix: 47500 "$47.5K", 1200000 "$1.2M". */
export function moneyShort(n) {
  if (n == null) return '—'
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M'
  if (Math.abs(n) >= 1_000) return '$' + (n / 1_000).toFixed(1) + 'K'
  return '$' + Math.round(n).toLocaleString()
}
