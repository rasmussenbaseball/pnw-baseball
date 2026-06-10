"""
App-wide configuration constants.

CURRENT_SEASON is the ONE place the backend learns what "the current
season" is. When the 2027 season starts, bump this single value and every
endpoint default / current-season fallback flips over with it.

(The frontend has its own single source of truth in
frontend/src/lib/seasons.js — bump that too, one constant per layer.)

Deliberately NOT covered by this constant: genuinely historical literals
(pinned tournament fields like NWAC_2026_CHAMP_SEEDS, summer-league
defaults that point at the most recent completed summer season, table
names, date strings, and copy text).
"""

CURRENT_SEASON = 2026
