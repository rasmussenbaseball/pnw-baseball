# NAIA Postseason — Selection + Bracket

**Goal:** model the real NAIA postseason format (46-team field, Opening Round, Avista World Series at Lewiston) but use **our own predictive ranking algorithm** (`rankings.md`) for selection — not the actual NAIA's RPI/BoChip.

## Real-world format (2026)

- **46-team field**
- **30 automatic bids** — conference champions + (typically) runners-up
- **15 at-large bids** by national selection committee
- **+1 host slot** if any
- **10 Opening Round sites**: six 5-team brackets, four 4-team brackets
- **Format**: double-elimination at each Opening Round site
- **World Series**: 10 winners advance to Harris Field, Lewiston, ID
- **Window**: Opening Round May 11–14; World Series begins ~May 22

## In-game selection algorithm

**Auto-bids (30 total):**

For each of 21 conferences sponsoring baseball, the conference tournament generates 1–2 auto-bids:
- **Tournament champion** → auto-bid (always)
- **Tournament runner-up** → auto-bid (only for conferences with `typicalNationalQualifiers >= 2` or based on conference strength tier)

Conferences with weaker `typicalNationalQualifiers = 1` send only their champion. Top conferences send champ + runner-up.

If a single team wins both regular-season and tournament (common), the runner-up doesn't necessarily get a bid — only if their conference earns 2.

**Target: 30 auto-bids across all 21 conferences.** Tunable.

**At-large bids (15-16 total):**

After auto-bids are awarded, the **selection algorithm** picks the next 15-16 teams by **our overall ranking**:

```
candidates = all teams NOT already in via auto-bid
candidates.sort(by overall_rating DESC)
at_large = candidates.slice(0, 16)
```

This is the part that differs from NAIA reality — we explicitly use the predictive ranking, not RPI. Teams from weak conferences with great records but bad SOS *won't* get in over a 30-20 team from a tough conference.

**Total field: 46 teams.**

## Bracket construction

Once 46 teams are selected, we group into 10 Opening Round sites:

1. Rank all 46 by `overall_rating`
2. Seed 1-10 are **hosts** (also get the bracket #1 seed at their site)
3. Remaining 36 teams are distributed across the 10 sites:
   - First, 6 sites get **5 teams** (seed + 4 others)
   - Then 4 sites get **4 teams** (seed + 3 others)
4. **Geographic balancing** — teams placed at the geographically nearest site when possible (cuts travel)
5. **Conference protection** — avoid putting two teams from the same conference at the same site (when possible)
6. Within a bracket, lower-ranked teams seeded 2-5

## Opening Round sim

Each bracket is double-elimination. Simulated using the standard `simGame` (PA-level) with rest tracking.

- 5-team double-elim ≈ 7-10 games over 4 days
- 4-team double-elim ≈ 6-7 games over 4 days
- Pitcher fatigue tracked across multi-day tournament — your ace's rest day matters

10 winners advance.

## Avista NAIA World Series (Lewiston, ID)

10 teams at Harris Field. Format varies by year. Current spec uses:
- **2 pools of 5** (round-robin or double-elim)
- **Top 2 from each pool** advance to single-elim semifinals
- **Championship game**

We model the format as double-elim 10-team for simplicity in v1, with the option to switch to the real pool format in v2.

## What the user sees

- **Selection Show** — a week-12-of-season news event with the full bracket revealed
- **Bracket page** — visual bracket showing all 10 sites + WS
- **Forced-pause** on each Opening Round game day (sim mode) or auto-play through
- **WS celebration** if you win

## NAIA host site selection

The 10 sites in real life are pre-selected before the postseason. We pick the 10 highest-ranked seeds, with a tie-breaker for facility rating + geographic spread. Hand-coded "Lewiston" never hosts an Opening Round (it's the WS site).

## Open questions

- **PS1.** How exact should we be on the auto-bid distribution? Default: 30 across 21 confs, with top 9 confs sending 2 and the rest sending 1. Adjust if needed.
- **PS2.** Do you want a **Selection Sunday** newsfeed event with bracket reveal animation? Default: **yes, prominent UI moment**.
- **PS3.** If user's team misses, do we show what they would've needed? Default: **yes, a "first four out" / "needed X more wins" callout**.
- **PS4.** WS format — real-world pool play, or double-elim 10-team? Default: **double-elim** for v1.
- **PS5.** Conference tournament structure — do all 21 run the same way (4-team double-elim, 6-team double-elim, etc.)? Default: **4-team double-elim for v1**, expand by conference in v2.
