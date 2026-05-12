# Recruiting Loop

**Goal:** capture what makes NAIA recruiting *feel* like NAIA — wild west, three pipelines (HS / JUCO / transfer portal), partial-scholarship math, regional ties — while modeling the recruit preference system that EA College Football popularized.

This is the largest single feature in v1.

## What NAIA recruiting is actually like

(See `rules.md` for citations.)

- **No NLI program**, no contact periods, no signing-day moment in the NCAA sense.
- **Three pipelines**: HS seniors, JUCO transfers, NAIA→NAIA transfers (and a small D1→NAIA portal trickle).
- **Recruiting geography is regional** — ~300-mile bus radius + JUCO and international pipelines.
- **12 scholarship equivalencies**, split however the coach wants — this directly trades against **tuition cost** at each school (a player at Tennessee Wesleyan needs a different $ offer than the same player at Oklahoma Wesleyan because tuition + room+board differ).
- **Roster churn of 25–40% annually** is normal.

## The three recruit pools

Generated at the start of each offseason:

| Pool             | Pool size | When they decide       | Notes                                                          |
| ---------------- | --------- | ---------------------- | -------------------------------------------------------------- |
| **HS seniors**   | ~600      | Most by Oct, late ones into Apr | Highest variance — biggest potential, biggest bust risk    |
| **JUCO transfers** | ~250    | Mostly May–June (after their spring) | Fictional players from real JUCO teams (see `data/juco_teams.json`). Lower variance |
| **NAIA→NAIA portal** | varies — populated by departing players from other programs each year   | Rolling, late Apr–Jul     | **Cannot transfer within their own conference** (NAIA rule). Mid-grade typically |
| **D1→NAIA portal** | ~15     | Rolling                | Rare. Former D1 guys looking to reset                          |

(See `transfers.md` for how the NAIA→NAIA portal is populated — it's the outbound side of someone else's roster.)

## What every recruit has

```ts
type Recruit = {
  id: string
  firstName: string; lastName: string
  hometown: { city: string; state: string }
  pool: 'HS_SR' | 'JUCO' | 'NAIA_TRANSFER' | 'D1_TRANSFER'
  primaryPosition: Position
  positions: Position[]
  bats: 'L' | 'R' | 'S'; throws: 'L' | 'R'

  trueRatings: Player['hitter'] & Player['pitcher']   // hidden
  truePotential: ...                                  // hidden

  // What each program sees right now (per scouting team):
  scoutGrades: Map<schoolId, ScoutGrade>

  // EA-College-Football-style preferences — what they want in a school
  preferences: RecruitPreferences

  // State
  status: 'open' | 'interested' | 'visiting' | 'verbal' | 'signed' | 'lost'
  interestedSchools: schoolId[]    // programs actively recruiting them
  verbalTo: schoolId | null
  signedTo: schoolId | null
}
```

## EA-style recruit preferences

Each recruit has **8 preference dimensions**, each weighted 0–10 (so they sum to a personality). These drive the "fit score" that, combined with interest, decides commitment.

| Dimension              | What it means / how schools score                                              |
| ---------------------- | ------------------------------------------------------------------------------ |
| `financial`            | Wants low cost of attendance — tuition + room/board net of scholarship $       |
| `proximity`            | Wants to be close to home (boost decays with distance, in miles)               |
| `playing_time`         | Wants depth-chart opportunity (boost if your roster is thin at their position) |
| `program_history`      | Wants a winning program (recent W-L, championships, polls)                     |
| `facilities`           | Wants nice facilities (school's facility rating, see `school_resources.md`)    |
| `academics`            | Wants academic reputation / specific majors                                    |
| `coaching`             | Wants a strong coach (coach's `developer` + `motivator` ratings)               |
| `pipeline_fit`         | Wants a coach with ties to their region/demographic (see `coaches.md`)         |

A recruit might be `{ financial: 9, proximity: 7, playing_time: 5, program_history: 2, facilities: 1, academics: 4, coaching: 3, pipeline_fit: 6 }` — a kid who needs money, wants to stay home, and trusts coaches with local ties.

**Hidden:** the recruit's preference weights are hidden initially. Scouting reveals 1–2 dimensions clearly; the rest you infer from their visit behavior.

### Fit score calculation

For each (school, recruit) pair:
```
fit_score = Σ over dimensions d:
  recruit.preferences[d] * school.score_on(d, coach, current_roster)
```

`school.score_on('financial', ...)` = scholarship offer dollars + state-of-residence in-state tuition discount, scaled.
`school.score_on('proximity', ...)` = sigmoid of distance from recruit's hometown.
`school.score_on('coaching', ...)` = (coach.developer + coach.motivator) / 2.
`school.score_on('pipeline_fit', ...)` = does this coach have a pipeline that matches the recruit's region/demographic.
etc.

## The recruiting calendar (12 meaningful weeks)

Same shape as before — 12 weeks across June through May — but **pool unlocks** differ:

```
Week 1 (Jun):   HS pool opens. NAIA→NAIA portal opens.
Week 2:         Summer ball reports (v2 hook for current players)
Week 3-4:       Heavy scout-trip phase. D1→NAIA portal trickle begins.
Week 5 (Aug):   JUCO portal opens (early-decision JUCOs).
Week 6:         Early HS verbals start.
Week 7 (Oct):   Fall workouts (v2 hook)
Week 8 (Nov):   Most HS verbals lock.
Week 9 (Feb):   Spring previews; JUCO interest crystallizes.
Week 10 (Apr):  JUCO decision window opens (their spring's wrapping up).
Week 11 (May):  Late JUCO + late HS signings.
Week 12 (May):  Signing day. Roster finalized.
```

## Action Points (NOT a recruiting-only budget — see action_points.md)

Recruiting actions spend from the **same AP pool** that funds practice, team boosts, and program-building. Recruiting is one of several categories of action. See `action_points.md` for the full AP system.

Recruiting actions and AP costs:

| Action                            | AP cost | Effect                                                       |
| --------------------------------- | ------- | ------------------------------------------------------------ |
| Phone call                        | 1       | Small interest bump; small fog reduction                     |
| Scout trip (regional)             | 3       | Big fog reduction; small interest bump                       |
| Scout trip (out of region)        | 5       | Same, costs more if outside coach's `regions[]`              |
| Home visit                        | 5       | Big interest bump; medium fog reduction                      |
| Campus visit (paid)               | 6       | Largest interest bump; reveals ratings + 1 preference dim    |
| **Scholarship offer**             | 0       | Lock $ commitment. Pulls from your scholarship pool. Biggest interest bump |
| **Sweeten offer ($ increase)**    | 0       | Pulls more $. For flipping a recruit late                    |
| Compete (when verbal'd elsewhere) | 2       | Attempt to flip a player who's verbal'd to a rival           |

**Pipeline fit modifier:** if a recruit is from your coach's `regions[]` or matches a `pipelines[]` flag, all action costs drop 1 AP and effects are amplified 1.3×. This is the meat of why coach affinity matters.

## The scholarship-dollars-to-recruit-money loop (v1!)

This is the part that just moved from v2 → v1 per Nate's direction.

Each school has:
- `tuitionPerYear` (estimated; see `school_resources.md`)
- `roomAndBoardPerYear` (estimated)
- `scholarshipPool` — annual $ budget for athletic aid (the equivalency of 12 full scholarships, but expressed as $)

Each recruit has:
- A `costToAttend` (= tuition + room/board — what they pay out of pocket if zero aid)
- An expected scholarship $ ask, set by their `financial` preference weight + their rating quality

You make a `Scholarship offer` to a recruit by picking a $ amount. That subtracts from your `scholarshipPool` for the year. If the offer plus their `financial` preference math beats other suitors, your `financial` dimension score on that recruit goes way up.

**Constraint:** can't offer more than your remaining `scholarshipPool`. This forces hard choices — do you offer the top recruit a near-full ride and run out of $ for a 4th pitcher, or split it across 4 mid-tier guys?

Scholarship pool resets each year, but rolls over commitments (returning players consume their portion).

## Coach affinity (region + demographic pipelines)

Each coach has:
- `regions: string[]` — e.g. `['TX', 'OK', 'LA', 'AR']` — states where they recruit better
- `pipelines: PipelineFlag[]` — e.g. `['NWAC', 'TX_JUCO', 'DR_INTL', 'FL_HS']` — demographic/competitive pipelines they have ties to

When recruiting:
- If recruit's `hometown.state` ∈ coach.regions → +20% interest from your actions, AP discount on visits
- If recruit's `pool == 'JUCO' && previousSchool ∈ NWAC` and coach has `NWAC` pipeline → similar boost

This is how we model "some teams love NWAC players, some don't" — it falls out of pipeline flags, not a hard-coded preference.

See `coaches.md` for the full coach attribute model.

## Recruit-type bias (some coaches love freshmen, some love transfers)

A coach has a `recruiter_type`:

- `HS_GRINDER` — bonus actions cheap on HS recruits, penalty AP on transfer portal
- `JUCO_HUNTER` — bonus on JUCO actions, especially with matching pipeline
- `PORTAL_PRO` — bonus on NAIA→NAIA and D1→NAIA portal
- `BALANCED` — no bonus, no penalty (most coaches)

This matches the "some teams love recruiting freshmen, some mostly recruit transfers" line.

## Scouting fog (unchanged from prior version)

- No scouting: ratings ± 15
- 1+ scout trip: ratings ± 8
- 2+ scout trips OR campus visit: ratings ± 3
- Preference dimensions: hidden until first home or campus visit (then 1–2 revealed)

## Decision logic

End of each week, recruits with **multi-program interest > 70** and **at least one $ offer outstanding** enter the **decision phase**:
- Compute `fit_score` × `interest_weight` for each interested school
- Recruit verbals to the highest combined score
- Other programs can try to flip with `Compete` actions until signing day

## Signing day (week 12)

All verbals lock. Anyone you've signed enrolls next August.

## Class limits

Soft cap: total roster ≤ 35. If you sign more, lowest-grade signees get cut in fall workouts.

Hard cap: scholarship $ committed ≤ scholarshipPool.

## UI surfaces

- **Big board** — filterable list of recruits, scout grades, fit estimate, $ asked, status
- **Coach affinity overlay** — shows which recruits match your regions/pipelines (visual highlight on the board)
- **Recruit detail** — fog ratings, revealed preference dimensions, offer history, rival activity feed
- **Scholarship pool widget** — running $ balance, committed vs. remaining
- **Calendar** — AP budget, current week, signing-day countdown
- **Class summary** — signed roster vs. position gaps + scholarship $ spent

## Resolved questions

- **Q8 (action-point budget):** yes, modified by coach `recruiter` rating
- **Q9 (visible competition):** yes — newsfeed for rival actions
- **Q10 (international recruits):** stub for v1 — D1→NAIA portal models the rare flag transfer but no foreign-country recruits yet
- **Q11 (region-coded names):** name pool weighted by recruit's state (cheap implementation)

## Still open

- **R1.** What does the D1→NAIA portal pool look like? My default: ~15 players/year, rated 60–80, mostly seeking playing time. Confirm.
- **R2.** Does cost-of-attendance vary by in-state vs. out-of-state for NAIA? (For most NAIA schools tuition is sticker price either way — verify.)
- **R3.** Can the user negotiate scholarship $ in increments, or are there standard "tiers" (e.g. 25%, 50%, 75%, full)? Default: increments of $1,000.
- **R4.** Are there boosters / NIL in v1? Default: no — NAIA NIL is real but limited; keep v1 clean.
