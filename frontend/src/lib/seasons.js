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
