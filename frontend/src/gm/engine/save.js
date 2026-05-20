/**
 * Save/load — localStorage I/O with LZ-string compression.
 *
 * Keyed by Supabase user id so a dynasty travels with the account on the
 * same browser. 3 save slots per user.
 *
 * Why compression: a full world (199 schools × 35 players + ~1K coaches +
 * full schedule + recruit pool) is ~6MB uncompressed. localStorage has a
 * 5MB per-origin quota. LZ-string knocks the typical save down to ~600-900KB,
 * comfortably under the quota.
 *
 * Save schema is versioned; any breaking shape changes bump SAVE_VERSION
 * and add a migration in `migrateSave`.
 */

import LZString from 'lz-string'

export const SAVE_VERSION = 1

// Current prefix (post-rebrand). Older "naia-gm-save" saves are auto-migrated
// to this prefix the first time loadDynasty() or listDynasties() touches them.
const KEY_PREFIX = 'pnw-coach-sim'
const LEGACY_KEY_PREFIX = 'naia-gm-save'
const COMPRESSION_MARKER = 'LZ:'

/**
 * Build the localStorage key for a given user + slot.
 */
function storageKey(userId, slot) {
  return `${KEY_PREFIX}:${userId || 'guest'}:${slot}`
}

function legacyStorageKey(userId, slot) {
  return `${LEGACY_KEY_PREFIX}:${userId || 'guest'}:${slot}`
}

/**
 * If the new prefix has no entry but the legacy prefix does, copy the legacy
 * blob over to the new prefix (one-time migration on read). We leave the
 * legacy key in place as a safety net — it's a tiny LZ-compressed blob and
 * users can clear it via the dynasty-delete UI if needed.
 */
function migrateLegacyKey(userId, slot) {
  try {
    const newKey = storageKey(userId, slot)
    if (typeof localStorage === 'undefined') return null
    const existing = localStorage.getItem(newKey)
    if (existing) return existing
    const legacyKey = legacyStorageKey(userId, slot)
    const legacy = localStorage.getItem(legacyKey)
    if (!legacy) return null
    localStorage.setItem(newKey, legacy)
    return legacy
  } catch {
    return null
  }
}

/**
 * Save the state to localStorage at the given slot.
 * Compressed with LZ-string (UTF16 variant ~ 50-70% size reduction).
 *
 * @param {import('./types.js').SaveState} state
 */
export function saveDynasty(state) {
  const key = storageKey(state.userSupabaseId, state.saveSlot)
  state.lastSavedAt = new Date().toISOString()
  state.saveVersion = SAVE_VERSION
  try {
    const json = JSON.stringify(state)
    const compressed = COMPRESSION_MARKER + LZString.compressToUTF16(json)
    localStorage.setItem(key, compressed)
    return { ok: true, sizeKb: Math.round(compressed.length / 1024) }
  } catch (err) {
    console.error('[gm/save] saveDynasty failed', err)
    if (err.name === 'QuotaExceededError') {
      return {
        ok: false,
        error: `Save quota exceeded (${err.message}). Try deleting one of your other dynasties.`,
      }
    }
    return { ok: false, error: err.message }
  }
}

/**
 * Load a save at a given slot. Backward-compatible with uncompressed saves
 * (if anyone has any leftover) — the COMPRESSION_MARKER prefix tells us.
 *
 * @param {string} userId
 * @param {number} slot   1-3
 * @returns {import('./types.js').SaveState | null}
 */
export function loadDynasty(userId, slot) {
  const key = storageKey(userId, slot)
  try {
    let raw = localStorage.getItem(key)
    if (!raw) {
      raw = migrateLegacyKey(userId, slot)
    }
    if (!raw) return null
    let json
    if (raw.startsWith(COMPRESSION_MARKER)) {
      json = LZString.decompressFromUTF16(raw.slice(COMPRESSION_MARKER.length))
      if (!json) {
        console.error('[gm/save] failed to decompress save — corrupted?')
        return null
      }
    } else {
      // Uncompressed legacy save
      json = raw
    }
    const data = JSON.parse(json)
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
      // Resolve display info from the save's OWN schools map so non-NAIA
      // dynasties (D1/D2/D3/NWAC) — whose school ids aren't in the global
      // NAIA schools table — show their real name instead of "Unknown school".
      const school = save.schools?.[save.userSchoolId]
      const conf = school ? save.conferences?.[school.conferenceId] : null
      out.push({
        slot,
        dynastyName: save.dynastyName,
        userSchoolId: save.userSchoolId,
        schoolName: school?.name || null,
        schoolNickname: school?.nickname || null,
        schoolColors: school?.colors || null,
        confAbbr: conf?.abbreviation || null,
        level: save.level || 'NAIA',
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
    // Also clear any legacy-prefix copy so a stale naia-gm-save: entry can't
    // resurrect this slot on the next migration pass.
    localStorage.removeItem(legacyStorageKey(userId, slot))
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
