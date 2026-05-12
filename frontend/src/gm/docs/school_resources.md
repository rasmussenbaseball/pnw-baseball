# School Resources — Tuition, Scholarships, Facilities

**Goal:** every NAIA school has different resources, and that affects who they recruit and how hard they compete. We model this as **per-school numeric data** that's the same shape for all 199 programs but with varied values.

NAIA is the wild west — tiny private schools with $40K tuition, state schools with $8K tuition, religious schools with $25K but huge donor money, etc. Resources are a real strategic variable.

## What each school carries

```ts
type SchoolResources = {
  // Cost side (drives recruiting math)
  tuitionPerYear: number       // $ sticker price for tuition + fees
  roomAndBoardPerYear: number  // $ standard double-room + meal plan

  // Recruiting capacity
  scholarshipPool: number      // $ annual athletic aid for baseball
                               //  ≈ 12 × (tuition + room+board) for a fully-funded program
                               //  but many programs run partial (4-6 equivalencies' worth)

  // Strength markers (drive both initial roster quality and recruit fit scores)
  facilityRating: number       // 0-100. Stadium, indoor batting facility, weight room
  programHistory: number       // 0-100. Recent W-L, championships, polls
  academicReputation: number   // 0-100. Drives `academics` preference dim

  // Geographic
  state: string                // 2-letter
  region: 'NE' | 'SE' | 'MW' | 'SW' | 'W' | 'NW'  // for region affinity math
  metroSize: 'rural' | 'small' | 'medium' | 'large'  // affects appeal to certain recruits

  // Resource tier (a coarse summary that drives default budgeting)
  resourceTier: 'D1_LITE' | 'WELL_FUNDED' | 'MID' | 'SHOESTRING'
}
```

## How we get the numbers (since we don't have a real dataset)

Three sources, in order of preference:

1. **PEAR ratings** (or Massey) for `programHistory` and to set starting on-field strength. **Open: how do we get this data into the JSON?** (See ongoing question in README.)
2. **Public IPEDS data** for tuition + room/board — but that's an offline data exercise. For v1 we estimate from school type:
   - Private religious small school: $24-32K tuition, $9-12K R&B (e.g. Tennessee Wesleyan, Tabor)
   - Private secular small school: $30-40K, $10-13K (Loyola NO, Hope International)
   - State school: $7-15K tuition, $8-10K R&B (Lewis-Clark State, Bismarck State)
   - HBCU: $10-18K, $8-11K (Dillard, Fisk)
3. **Hand-coded `resourceTier` and `facilityRating`** for the ~30 programs that are nationally known (Lewis-Clark, Tennessee Wesleyan, Oklahoma City, etc.). Rest are tier-assigned by heuristic (state schools = MID, well-known privates = WELL_FUNDED, etc.).

## Resource tier defaults

| Tier            | Defaults (typical)                                                       |
| --------------- | ------------------------------------------------------------------------ |
| `D1_LITE`       | Stadium upgraded, full scholarship funding, top facilities. ~5% of NAIA. |
| `WELL_FUNDED`   | Solid stadium, ~10-12 equivalencies funded, good indoor. ~25% of NAIA.   |
| `MID`           | Standard college park, ~6-9 equivalencies funded, basic indoor. ~50%.    |
| `SHOESTRING`    | Modest field, ~3-5 equivalencies funded, no real indoor. ~20%.           |

Tier sets defaults for `scholarshipPool`, `facilityRating`, and baseline `programHistory`. A coach can over-perform their tier (and there's narrative juice in that).

## How tuition drives the fit_score

A recruit's `financial` preference dimension scores each school as:

```
financial_score(school, recruit, offer$) =
  100 - normalize(
    (school.tuitionPerYear + school.roomAndBoardPerYear) - offer$
  )
```

So:
- Tennessee Wesleyan ($30K total) offering $25K scholarship → $5K out-of-pocket → high financial score
- Same recruit, OKC ($35K total) offering $25K → $10K out-of-pocket → lower financial score
- Same recruit, LSU-Alexandria ($10K total) offering $5K → $5K out-of-pocket → same as TWU even though offer is half the $

This is the trick: **cheap state schools can compete with rich privates on financial fit using less $.** Tactical depth.

## Scholarship pool dynamics

Each school's `scholarshipPool` starts at `12 × (tuitionPerYear + roomAndBoardPerYear)` for fully-funded programs, scaled down by tier:

| Tier            | Funded equivalencies | $ Pool example (using $30K cost)          |
| --------------- | -------------------- | ----------------------------------------- |
| `D1_LITE`       | 12.0                 | $360K                                     |
| `WELL_FUNDED`   | 10.5                 | $315K                                     |
| `MID`           | 7.5                  | $225K                                     |
| `SHOESTRING`    | 4.0                  | $120K                                     |

These are caps — programs can't offer more aid than their pool. Returning players consume the pool ($-amount of their existing scholarship), so the pool replenishes each year by the value of players who graduate or transfer out, **minus** the value of any new scholarships you commit.

This means a coach who over-recruits one year is short the next year. Realistic constraint.

## Facility rating

`facilityRating` (0-100) drives the `facilities` recruit preference dimension. Things factored:

- Stadium quality (lights, turf, capacity)
- Indoor batting facility (huge differentiator at NAIA)
- Weight room
- Locker room / clubhouse
- Training/medical

A coach can't change this in v1 (it's institutional). v2 adds capital projects.

## Generating the starting world

When a new dynasty starts, we:
1. Load `schools.json` (already has 199 schools with name/city/state/conference)
2. Apply `resourceTier` per school (hand-coded for ~30 known, heuristic for rest)
3. Derive `tuitionPerYear`, `roomAndBoard`, `scholarshipPool`, `facilityRating` from tier + school type
4. Apply `programHistory` from PEAR/proxy data
5. Generate roster strength proportional to `programHistory + facilityRating`

This is what makes Lewis-Clark State start strong (D1-lite, top facility, top program history) and a brand-new Frontier Conference team start weaker.

## Resource estimates for v1 — a 30-school hand-coded list

For credibility we hand-code resources for the most-recognized ~30 NAIA programs. Rough draft (will need verification with Nate):

| School                  | Tier         | Tuition | R&B  | Notes                                  |
| ----------------------- | ------------ | ------- | ---- | -------------------------------------- |
| Lewis-Clark State (ID)  | D1_LITE      | $7K     | $9K  | Multi-time champ, top facility         |
| Tennessee Wesleyan (TN) | D1_LITE      | $28K    | $11K | Recent powerhouse                      |
| Oklahoma City (OK)      | D1_LITE      | $30K    | $11K | Historic power, polished               |
| Hope International (CA) | WELL_FUNDED  | $35K    | $13K | SoCal pipeline                         |
| Tabor College (KS)      | WELL_FUNDED  | $30K    | $10K | Strong baseball culture                |
| Faulkner (AL)           | WELL_FUNDED  | $27K    | $10K |                                        |
| LSU-Shreveport (LA)     | WELL_FUNDED  | $8K     | $9K  | State price, well-run program          |
| LSU-Alexandria (LA)     | WELL_FUNDED  | $8K     | $9K  |                                        |
| Bushnell (OR)           | MID          | $32K    | $13K |                                        |
| Corban (OR)             | MID          | $33K    | $12K |                                        |
| College of Idaho (ID)   | WELL_FUNDED  | $34K    | $13K |                                        |
| British Columbia (BC)   | WELL_FUNDED  | $7K CDN | $13K | International tuition rate for non-CDN |
| Indiana Wesleyan (IN)   | WELL_FUNDED  | $30K    | $11K |                                        |
| Bellevue (NE)           | MID          | $8K     | $10K | State price                            |
| Texas Wesleyan (TX)     | WELL_FUNDED  | $29K    | $10K |                                        |
| ...                     | ...          | ...     | ...  |                                        |

This list needs Nate's input — he knows NAIA better than I do.

## Open questions

- **S1.** What's the right source for tuition/R&B data? IPEDS works but is offline; do you want me to seed by hand or write a one-time scraper?
- **S2.** Do programs ever get *more* funded over time in v1 (donations, success-driven), or is funding static for the dynasty? Default: static for v1, dynamic in v2.
- **S3.** Is `facilityRating` a single number or a breakdown (stadium, indoor, weight room separately)? Default: single number for v1, with optional breakdown later.
- **S4.** For Canadian schools (e.g. UBC) — how do you want to handle currency? Default: convert to USD at $1 CDN = $0.73, ignore FX volatility.
