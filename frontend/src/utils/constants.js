/**
 * Shared frontend constants.
 *
 * CURRENT_SEASON: the season year used as the default for API hooks
 * in src/hooks/useApi.js. The actual value lives in src/lib/seasons.js —
 * this file re-exports it so older imports keep working and there is
 * exactly ONE place to bump when a new season starts.
 *
 * Note: this constant is intentionally NOT used for every "2026" in
 * the frontend. Page titles, copy-text references, draft-class labels,
 * and date strings in e.g. About.jsx are left as literals because they
 * carry season context that does not always mean "current season."
 */
export { CURRENT_SEASON } from '../lib/seasons'
