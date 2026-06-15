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
    "ON",                    # PBR (Canada) — the only province with real coverage
}
# BC and AB are intentionally OUT: the PBR PDF carries essentially no ranked
# BC/AB commits, so an unranked BC/AB player has no ranking source at all.
# Baselining him would drag Canada-heavy classes down for data we never had;
# instead he is excluded from class math (no signal), like HI/MT/CO. A BC/AB
# player who IS individually ranked still scores normally — this set only
# governs the unranked baseline.
