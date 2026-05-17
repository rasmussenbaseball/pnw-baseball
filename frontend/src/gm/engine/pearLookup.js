/**
 * Shared PEAR team-name matcher used by both rankings.js and nwbbRating.js.
 *
 * Originally lived inside rankings.js — extracted here so the NWBB rating
 * engine can read the same name-normalization rules without re-importing
 * the JSON or duplicating the alias table.
 *
 * Source: see rankings.js for the rationale on each normalize step + alias.
 */

function normalize(name) {
  if (!name) return ''
  let s = name.toLowerCase()
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bst\.\b/g, 'st')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/&/g, 'and')
    .replace(/\bstate\b/g, '')
    .replace(/\buniversity\b/g, '')
    .replace(/\bcollege\b/g, '')
    .replace(/\bchristian\b/g, '')
    .replace(/\binternational\b/g, '')
  s = s.replace(/\s+st\b/, '')
  return s.replace(/[^a-z0-9]/g, '').trim()
}

const PEAR_ALIASES = {
  'mount-vernon-nazarene': 'Mount Vernon (OH)',
  'iu-east': 'Indiana East',
  'iu-southeast': 'Indiana Southeast',
  'iu-south-bend': 'IU South Bend',
  'loyola-no': 'Loyola (LA)',
  'oklahoma-panhandle': 'Panhandle State',
  'unoh': 'Northwestern (OH)',
  'columbia-international': 'CIU (SC)',
  'rochester-christian': 'Rochester (MI)',
  'hesston': 'Hesston College',
  'new-college-fl': 'New College (FL)',
  'webber-international': 'Webber (FL)',
  'blue-mountain-christian': 'Blue Mountain (MS)',
  'bismarck-state': 'Bismarck St',
  'calumet-st-joseph': 'Calumet (IN)',
  'our-lady-lake': 'Our Lady Lake',
  'voorhees': 'Voorhees University',
}

/**
 * Build a normalized-name → PEAR row lookup from the raw PEAR JSON. Pass
 * the cached result into `pearForSchoolWith`.
 */
export function makePearLookup(pearRaw) {
  const out = {}
  for (const row of pearRaw?.stats || []) {
    out[normalize(row.Team)] = row
  }
  return out
}

/**
 * Resolve a school object to its PEAR row using a precomputed lookup. Same
 * matching logic as the inlined version in rankings.js (alias → name →
 * Saint→St → "name (state)").
 */
export function pearForSchoolWith(school, lookup) {
  if (!school || !lookup) return null
  if (PEAR_ALIASES[school.id]) {
    const key = normalize(PEAR_ALIASES[school.id])
    if (lookup[key]) return lookup[key]
  }
  const tries = [
    school.name,
    school.name.replace(/\bSaint\b/g, 'St.'),
    `${school.name} (${school.state})`,
  ]
  for (const t of tries) {
    const key = normalize(t)
    if (lookup[key]) return lookup[key]
  }
  return null
}
