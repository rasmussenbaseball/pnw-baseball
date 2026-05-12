/**
 * Save/load — localStorage I/O.
 *
 * Keyed by Supabase user id so a dynasty travels with the account on the
 * same browser. 3 save slots per user.
 *
 * Format: JSON. We don't compress yet; full save size is a few MB.
 *
 * Save schema is versioned; any breaking shape changes bump SAVE_VERSION
 * and add a migration in `migrateSave`.
 */

export const SAVE_VERSION = 1

const KEY_PREFIX = 'naia-gm-save'

/**
 * Build the localStorage key for a given user + slot.
 */
function storageKey(userId, slot) {
  return `${KEY_PREFIX}:${userId || 'guest'}:${slot}`
}

/**
 * Save the state to localStorage at the given slot.
 * @param {import('./types.js').SaveState} state
 */
export function saveDynasty(state) {
  const key = storageKey(state.userSupabaseId, state.saveSlot)
  state.lastSavedAt = new Date().toISOString()
  state.saveVersion = SAVE_VERSION
  try {
    localStorage.setItem(key, JSON.stringify(state))
    return { ok: true }
  } catch (err) {
    console.error('[gm/save] saveDynasty failed', err)
    return { ok: false, error: err.message }
  }
}

/**
 * Load a save at a given slot.
 * @param {string} userId
 * @param {number} slot   1-3
 * @returns {import('./types.js').SaveState | null}
 */
export function loadDynasty(userId, slot) {
  const key = storageKey(userId, slot)
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const data = JSON.parse(raw)
    return migrateSave(data)
  } catch (err) {
    console.error('[gm/save] loadDynasty failed', err)
    return null
  }
}

/**
 * List all saves for a given user. Returns an array of slim metadata records
 * so the dynasty-list UI can render quickly without loading full saves.
 * @param {string} userId
 * @returns {Array<{ slot: number, dynastyName: string, userSchoolId: string, year: number, week: number, lastSavedAt: string }>}
 */
export function listDynasties(userId) {
  const out = []
  for (let slot = 1; slot <= 3; slot++) {
    const save = loadDynasty(userId, slot)
    if (save) {
      out.push({
        slot,
        dynastyName: save.dynastyName,
        userSchoolId: save.userSchoolId,
        year: save.calendar.year,
        week: save.calendar.week,
        lastSavedAt: save.lastSavedAt,
      })
    }
  }
  return out
}

/**
 * Delete a dynasty.
 * @param {string} userId
 * @param {number} slot
 */
export function deleteDynasty(userId, slot) {
  try {
    localStorage.removeItem(storageKey(userId, slot))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * Migrate older save formats forward. v1 is the starting version, no
 * migrations needed yet — just a hook.
 */
function migrateSave(data) {
  if (!data.saveVersion) data.saveVersion = 1
  // Add migrations here when SAVE_VERSION bumps.
  return data
}
