# Budget System

**Goal:** budgeting is a central strategic mechanic. Each season the coach has a total athletic-program budget that must be allocated across categories. Going over hurts job security and shrinks next year's budget. The choices are real: do you splurge on equipment so the team feels D1, or stretch every dollar on scholarships? Do you fly to Florida week-1 or play locally?

## Annual budget categories

| Category              | What it covers                                                          | Typical % of program budget |
| --------------------- | ----------------------------------------------------------------------- | --------------------------- |
| `scholarships`        | Athletic aid to players (the 12-equivalency pool, as $)                 | 38–48%                      |
| `coachingSalaries`    | Head coach + assistant salaries                                         | 12–18%                      |
| `travel`              | Bus/flight/hotel/per diem for all away trips                            | 12–20%                      |
| `equipment`           | Bats (team-bought), gloves (team-bought), balls, helmets, catcher gear  | 5–9%                        |
| `uniforms`            | Game jerseys, batting practice, travel polos, hats                      | 2–4%                        |
| `meals`               | Training table, post-game, travel meals beyond per diem                 | 3–7%                        |
| `facilities`          | Field maintenance, indoor batting cage upkeep, weight room              | 4–8%                        |
| `medical`             | Trainers, rehab, equipment, insurance contribution                      | 2–4%                        |
| `recruiting`          | Phone, scout trips, on-campus visit hosting, signing-day                | 2–5%                        |
| `misc`                | Awards, banquets, team-building, contingency                            | 1–3%                        |

These percentages are typical defaults; the user is free to reallocate within their total.

## Realistic total program budgets (per resource tier)

These are estimates I derived from NAIA reality. Adjust if you know better.

| Tier            | Total annual baseball budget | Sample programs                                |
| --------------- | ---------------------------- | ---------------------------------------------- |
| `D1_LITE`       | $850K – $1.2M                | Lewis-Clark State, Tennessee Wesleyan, OK City |
| `WELL_FUNDED`   | $400K – $700K                | Bushnell, Tabor, LSU-Shreveport                |
| `MID`           | $200K – $400K                | Eastern Oregon, Warner Pacific                 |
| `SHOESTRING`    | $90K – $200K                 | smaller programs without dedicated baseball funding |

## Bushnell (Cascade, WELL_FUNDED) — realistic budget seed

Based on tier defaults + Cascade's typical mid-cost travel (lots of in-conf bus trips, occasional Cal/AZ flights):

```
Total program budget          $525,000
├─ Scholarships               $235,000   (45%, 7.5 equivalencies on $32K cost-of-attendance)
├─ Coaching salaries          $ 82,000   (HC + 3 assistants)
├─ Travel                     $ 75,000   (14%, dominated by 2-3 flights/year)
├─ Equipment                  $ 35,000   (bats, gloves, balls)
├─ Uniforms                   $ 18,000
├─ Meals                      $ 28,000
├─ Facilities                 $ 25,000
├─ Medical                    $ 12,000
├─ Recruiting                 $ 10,000
└─ Misc                       $  5,000
```

The user can reallocate within this total. Going over total triggers a job-security penalty.

## Spending consequences

Each category produces an effect when the user chooses to invest more than tier-default:

| Category +investment effect                              | Negative if underinvested                          |
| -------------------------------------------------------- | -------------------------------------------------- |
| `equipment` ↑ → small in-game performance bump (+1 OVR effective) | Equipment cuts → tiny K-rate bump (rust)   |
| `uniforms` ↑ → recruiting `facilities` score +2          | Cheap uniforms → recruiting morale −1              |
| `meals` ↑ → durability +2, injury risk −10%              | Cheap meals → injury risk +10%, durability −2      |
| `facilities` ↑ → facility rating drift +1/year           | Underinvest → facility rating drift −1             |
| `medical` ↑ → injury recovery time −20%, injury risk −5% | Underinvest → games-missed-per-injury +30%         |
| `recruiting` ↑ → +5 AP/week during recruiting season     | Underinvest → −3 AP/week during recruiting         |
| `coachingSalaries` ↑ → can hire/retain better assistants | Cuts → assistants leave, lose talent in pipelines  |
| `travel` over budget → job-security penalty next year    | Under budget travel → fine, but limits scheduling  |

(For v1.5 we wire the easier effects — equipment OVR bump, meals injury, recruiting AP, facility drift. Deeper integrations come later.)

## Job security

Each year the user accumulates a **job security score** (0-100, starts at 50 for a new hire):

```
job_security += win_rate_above_500 * 8
job_security -= losing_seasons_in_row * 6
job_security += postseason_appearances * 10
job_security += conference_championships * 15
job_security -= over_budget_amount / total_budget * 30
job_security += loyal_recruiting_class_signed * 4
```

Below 25 → "hot seat" warning event. Below 10 → fired at end of season (if `coachFiringEnabled`). Above 80 → renewed contract bonus + small budget increase the next year.

**Going over budget reduces job security AND shrinks next year's budget** (each $ over = $0.50 cut next year, up to 20% reduction).

## Multi-year dynamics

Each year the AD reviews the program. Outcomes:
- **Winning + on budget:** budget increases 3–5% next year (donor money flows)
- **Winning + over budget:** budget flat or +1% (AD impressed but worried)
- **Losing + on budget:** budget flat (everyone holds breath)
- **Losing + over budget:** budget −5 to −15% AND job-security hit
- **Postseason champion:** one-time 10% budget bump + facility-rating bump

This is what makes the long-term dynasty interesting — early splurging can pay off, or it can sink you.

## Implementation map

- `engine/budget.js` — defaults + allocation logic + over-budget detection
- `engine/jobSecurity.js` (or in budget) — tracks job security score, fires user if below threshold
- `pages/gm/Budget.jsx` — UI for allocating across categories
- Hook on offseason tick — annual review, budget update, news event
