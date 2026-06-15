"""Canonical recruiting constants shared by the scrapers/ingesters and the API.

RANKED_STATES is the set of player HOME states/provinces for which we have a
ranking source attached to a recruit:

  * BBNW (Baseball Northwest) ranks WA, OR, ID.
  * The PBR (Prep Baseball Report) rankings PDF covers WA, OR, CA, UT, NV, and
    Canada (players carry province codes AB / ON / BC).

A recruit whose home state is NOT in this set has no ranking data at all, so it
must be EXCLUDED from class-score math (treated as "no signal"), NOT penalized
as if it were a poorly-ranked player. The ingester and the API both import this
to make that exclusion consistent.
"""

# Union of the BBNW-ranked states (WA, OR, ID) and the PBR PDF states
# (WA, OR, CA, UT, NV + Canadian provinces AB, ON, BC).
RANKED_STATES = {
    "WA", "OR", "ID",        # BBNW
    "CA", "UT", "NV",        # PBR (US)
    "AB", "ON", "BC",        # PBR (Canada)
}
