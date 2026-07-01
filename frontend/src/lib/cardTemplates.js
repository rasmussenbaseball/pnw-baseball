/**
 * Saved custom-card templates — localStorage persistence.
 *
 * A template is a named block layout the coach can reuse and, crucially, feed
 * into bulk card generation so an entire roster prints in one consistent
 * format. Stored client-side (per browser/origin) — zero backend cost. If
 * coaches later want cross-device or team sharing, promote this to a backend
 * table like recruiting_boards.
 *
 * Shape:
 *   { id, name, blocks: [{ type, w, filter?, ...cfg }], sidePref, updatedAt }
 * sidePref: 'auto' | 'batting' | 'pitching' — 'auto' derives from career WAR
 * (essential for bulk runs over a mixed roster of hitters and pitchers).
 */

const KEY = 'nwbb_card_templates_v1'

function read() {
  try {
    const raw = window.localStorage.getItem(KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function write(arr) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(arr))
  } catch (e) {
    console.error('Could not save card templates', e)
  }
}

// Strip the transient uid from live blocks before persisting.
function cleanBlocks(blocks) {
  return (blocks || []).map(({ uid, ...rest }) => rest)  // eslint-disable-line no-unused-vars
}

export function loadTemplates() {
  return read().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export function getTemplate(id) {
  return read().find(t => t.id === id) || null
}

// Create or overwrite by name (case-insensitive). Returns the saved template.
export function saveTemplate({ name, blocks, sidePref = 'auto', now }) {
  const clean = { name: name.trim(), blocks: cleanBlocks(blocks), sidePref, updatedAt: now || 0 }
  const all = read()
  const idx = all.findIndex(t => t.name.toLowerCase() === clean.name.toLowerCase())
  let saved
  if (idx >= 0) {
    saved = { ...all[idx], ...clean }
    all[idx] = saved
  } else {
    saved = { id: `tpl_${Math.abs(hashName(clean.name))}_${(now || 0)}`, ...clean }
    all.push(saved)
  }
  write(all)
  return saved
}

export function deleteTemplate(id) {
  write(read().filter(t => t.id !== id))
}

// Small deterministic hash so ids don't rely on Math.random (unavailable in
// some sandboxes) — name + timestamp keeps them unique enough.
function hashName(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return h
}
