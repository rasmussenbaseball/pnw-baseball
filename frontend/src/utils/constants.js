/**
 * Shared frontend constants.
 *
 * CURRENT_SEASON: the season year used as the default for API hooks
 * in src/hooks/useApi.js. When the 2026 season ends and 2027 stats
 * begin rolling in, update this ONE value (and no other hook files)
 * to flip the whole data layer over.
 *
 * Note: this constant is intentionally NOT used for every "2026" in
 * the frontend. Page titles, copy-text references, draft-class labels,
 * and date strings in e.g. About.jsx are left as literals because they
 * carry season context that does not always mean "current season."
 */
export const CURRENT_SEASON = 2026
