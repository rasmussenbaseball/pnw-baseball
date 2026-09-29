// Single source of truth for which seasons the site has data for.
//
// As historical seasons get backfilled, update the arrays here and every
// year filter / selector across the site picks it up automatically.
//
//   SEASONS     — every season with at least season-total stats (the full
//                 list a year filter/dropdown should offer).
//   PBP_SEASONS — seasons with full game-level + play-by-play data, i.e.
//                 the ones where advanced per-game features work (pitch-level
//                 cards, per-game charts, WPA, goose eggs, rolling stats).
//                 2025 is being backfilled; add older years as they land.
//   CURRENT_SEASON / DEFAULT_SEASON — the season pages default to.

export const CURRENT_SEASON = 2026
export const DEFAULT_SEASON = CURRENT_SEASON

// The season after the current one: where a normal commitment lands.
export const NEXT_SEASON = CURRENT_SEASON + 1

// The transfer cycle that is currently OPEN (mirrors backend config.py
// PORTAL_SEASON). Trackers default to it, portal adds belong to it, and a
// commitment made today is for PORTAL_SEASON + 1 unless the editor picks
// another year. Runs one ahead of CURRENT_SEASON in the offseason. Bump it
// every fall once the summer portal has closed.
export const PORTAL_SEASON = 2027

// Years a tracker's season selector offers (open cycle first).
export const TRACKER_SEASONS = [PORTAL_SEASON, ...[2026, 2025, 2024].filter((y) => y < PORTAL_SEASON)]

// Seasons a commitment can be entered for (arrival season at the new school).
export const COMMIT_SEASONS = [PORTAL_SEASON + 1, PORTAL_SEASON]

// The most recent WCL (summer) season with data (mirrors backend config.py
// SUMMER_SEASON). Summer pages default to THIS, not CURRENT_SEASON: summer
// runs June-August, so bumping CURRENT_SEASON in January must not make the
// WCL pages ask for a summer that has not happened yet. Bump it in June
// when the next WCL season starts.
export const SUMMER_SEASON = 2026

// Summer seasons the WCL graphics / stats pickers offer, newest first.
export const SUMMER_SEASONS = [2026, 2025, 2024]

// The season projections point at (mirrors backend PROJECTION_SEASON).
// Projections are published in the fall for the NEXT spring, so this runs
// one ahead of CURRENT_SEASON in the offseason. "Actuals" shown next to a
// projection are PROJECTION_SEASON - 1.
export const PROJECTION_SEASON = 2027

// The high-school class currently being recruited / committing (mirrors
// backend RECRUITING_GRAD_YEAR). Fall 2026 = the class of 2027; the class
// of 2026 has already enrolled. Bump it each summer.
export const RECRUITING_GRAD_YEAR = 2027

// Class years the recruiting pages let you flip between (current class
// first, then the class that just enrolled).
export const GRAD_YEARS = [RECRUITING_GRAD_YEAR, RECRUITING_GRAD_YEAR - 1]

// "2027-28" style label for a season (the academic year it belongs to).
export function academicYear(season) {
  const y = Number(season)
  return `${y - 1}-${String(y).slice(2)}`
}

// Newest-first so dropdowns list the current year at the top.
export const SEASONS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018]

export const PBP_SEASONS = [2026, 2025, 2024]

export function isValidSeason(year) {
  return SEASONS.includes(Number(year))
}

// Coerce an arbitrary value (e.g. a URL ?season= param) to a known season,
// falling back to the default when it's missing or unrecognized.
export function clampSeason(year) {
  const n = Number(year)
  return isValidSeason(n) ? n : DEFAULT_SEASON
}

// Whether a season has play-by-play-derived data available.
export function hasPbp(year) {
  return PBP_SEASONS.includes(Number(year))
}
