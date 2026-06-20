// Display-only standardization for messy summer/WCL roster fields (Pointstreak
// feeds inconsistent casing + class-year formats). Non-destructive — these only
// affect how values render, not the stored data.

// Title-case a single name token, but leave already-correct mixed-case names
// alone (McFeely, DeWitt, O'Rourke) and keep short all-caps initials (JJ, AJ).
function fixToken(tok) {
  if (!tok) return tok
  const isAllCaps = tok === tok.toUpperCase()
  const isAllLower = tok === tok.toLowerCase()
  if (!isAllCaps && !isAllLower) return tok            // McFeely, DeVito, O'Brien — already good
  if (isAllCaps && tok.replace(/[.\s]/g, '').length <= 2) return tok  // initials: JJ, AJ, T.J.
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s)
  // handle hyphens and apostrophes (Smith-Jones, O'Rourke)
  let t = tok.toLowerCase().split('-').map(part => part.split("'").map(cap).join("'")).join('-')
  // Scottish/Irish "Mc" prefix (McGill, McLain)
  t = t.replace(/\bMc([a-z])/g, (_, c) => 'Mc' + c.toUpperCase())
  return t
}

export function titleName(first, last) {
  const fix = (s) => (s || '').split(/\s+/).map(fixToken).join(' ').trim()
  return `${fix(first)} ${fix(last)}`.trim()
}

const YR_MAP = {
  'freshman': 'Fr.', 'fr': 'Fr.', 'fr.': 'Fr.', 'inc. fr': 'Fr.', 'inc fr': 'Fr.', 'incoming freshman': 'Fr.',
  'sophomore': 'So.', 'so': 'So.', 'so.': 'So.',
  'junior': 'Jr.', 'jr': 'Jr.', 'jr.': 'Jr.',
  'senior': 'Sr.', 'sr': 'Sr.', 'sr.': 'Sr.',
  'graduate': 'Gr.', 'grad': 'Gr.', 'gr': 'Gr.', 'gr.': 'Gr.',
  'red shirt freshman': 'R-Fr.', 'rs fr': 'R-Fr.', 'r-fr.': 'R-Fr.', 'rs freshman': 'R-Fr.',
  'rs so': 'R-So.', 'r-so.': 'R-So.', 'rs jr': 'R-Jr.', 'r-jr.': 'R-Jr.', 'rs sr': 'R-Sr.', 'r-sr.': 'R-Sr.',
}
export function fmtYr(y) {
  if (!y) return ''
  return YR_MAP[String(y).trim().toLowerCase()] || y
}
