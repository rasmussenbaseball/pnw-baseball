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

# The season AFTER the current one: where a normal "this cycle" commitment
# lands (a player leaving after CURRENT_SEASON plays NEXT_SEASON elsewhere).
NEXT_SEASON = CURRENT_SEASON + 1

# The transfer cycle that is currently OPEN. Trackers (transfer portal, WCL
# portal, JUCO) default to this year; players added to a portal today belong
# to it; a commitment made today is for PORTAL_SEASON + 1 unless the editor
# says otherwise. It is the season whose roster is being built NEXT, so it
# runs one ahead of CURRENT_SEASON in the offseason (fall 2026: CURRENT 2026,
# PORTAL 2027) and equal to it during the season. Bump it every fall once
# the summer portal has closed, at the same time the trackers roll over.
PORTAL_SEASON = 2027

# The most recent WCL (summer) season that has data. Summer endpoints
# default to THIS, not CURRENT_SEASON: summer runs June-August, so in
# January when CURRENT_SEASON becomes 2027 the 2027 summer does not exist
# yet and every WCL page would come up empty. Bump it when the next WCL
# season starts in June.
SUMMER_SEASON = 2026

# The season the player/team projections point at. Projections are
# published in the fall for the NEXT spring, so this runs one ahead of
# CURRENT_SEASON in the offseason. Bump it after the season ends and a new
# projection run targets the following year. "Actuals" in projection
# writeups are PROJECTION_SEASON - 1.
PROJECTION_SEASON = 2027

# The high-school class currently being recruited / committing. Fall 2026 =
# the class of 2027 (the class of 2026 has already enrolled). Bump it each
# summer once the previous class has arrived on campus. Frontend mirror:
# seasons.js RECRUITING_GRAD_YEAR.
RECRUITING_GRAD_YEAR = 2027
