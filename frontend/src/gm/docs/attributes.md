# Player Attribute System

**Goal:** MLB The Show-style 0–99 ratings, granular enough to feel like real player evaluation, coarse enough that the sim stays fast and ratings stay legible on a card.

## Ratings (current rating = `R`, hidden potential ceiling = `P`)

Every numeric attribute has two values: a **current** rating (`R`) and a hidden **potential ceiling** (`P`). Development moves `R` toward `P` over time. The user only ever sees `R` (and a fuzzy scout grade on `P` — see "Scouting fog" below).

### Hitter ratings (8)

| Attribute       | Scale | What it drives in the sim                                         |
| --------------- | ----- | ----------------------------------------------------------------- |
| `contact_l`     | 0–99  | BA / K rate vs LHP                                                |
| `contact_r`     | 0–99  | BA / K rate vs RHP                                                |
| `power_l`       | 0–99  | ISO / HR rate vs LHP                                              |
| `power_r`       | 0–99  | ISO / HR rate vs RHP                                              |
| `discipline`    | 0–99  | BB rate, K rate downward, plate approach                          |
| `speed`         | 0–99  | Infield singles, doubles on gappers, SB attempt rate              |
| `fielding`      | 0–99  | Out-conversion at the position they're playing                    |
| `arm`           | 0–99  | OF assists, IF cutoff accuracy, C pop time                        |

### Pitcher ratings (8)

| Attribute       | Scale | What it drives                                                    |
| --------------- | ----- | ----------------------------------------------------------------- |
| `stuff`         | 0–99  | Whiff rate, contact-quality suppression (combines velo + movement)|
| `control`       | 0–99  | BB rate, hit-batter rate                                          |
| `command`       | 0–99  | HR rate, leverage performance, ability to pitch to spots          |
| `stamina`       | 0–99  | Innings per outing before fatigue penalties kick in               |
| `vs_l`          | 0–99  | Modifier vs LHB                                                   |
| `vs_r`          | 0–99  | Modifier vs RHB                                                   |
| `composure`     | 0–99  | Performance in high-leverage / late innings                       |
| `durability`    | 0–99  | Day-to-day recovery, injury odds (v2)                             |

**Why "stuff" instead of velocity + 4 pitch grades:** the handoff says move fast. Pitch-level granularity (FB/SL/CB/CH each with their own grade) is cooler but multiplies the sim cost and rating-card complexity by ~5x. We can add pitch-arsenal flair later as a v2 cosmetic on the player card without it driving math.

**OPEN QUESTION (Q1 in the questions doc):** Nate wants confirmation on this. If he wants pitch-by-pitch fidelity, we replace `stuff` with `fastball`, `slider`, `curve`, `change` (0–99 each) and pick a sampled pitch per PA.

### Universal ratings (apply to both)

| Attribute       | Scale | Notes                                                             |
| --------------- | ----- | ----------------------------------------------------------------- |
| `potential`     | 0–99  | Hidden. Caps where `R` can grow to. Scouts see grades, not number.|
| `work_ethic`    | 0–99  | Hidden. Multiplier on offseason/inseason development.             |
| `clutch`        | 0–99  | Hidden. Light modifier on high-leverage outcomes. Bumped by coach's `motivator`. |
| `injury_prone`  | 0–99  | Hidden. v2 injury odds modifier.                                  |
| `loyalty`       | 0–99  | Hidden. Resistance to transferring out (see `transfers.md`).      |

### Two-way players

NAIA has lots of two-way players. The data model carries **both** hitter and pitcher rating blocks on every player; a flag (`isPitcher`, `isHitter`, `isTwoWay`) controls which the sim uses on a given day. For pure pitchers, the hitter block is auto-filled with weak ratings (their PA matters only for NL-style situations; if we use the DH everywhere, hitter block on a pitcher is decorative).

## Position eligibility

A player has a `primaryPosition` (one of: `C`, `1B`, `2B`, `SS`, `3B`, `LF`, `CF`, `RF`, `DH`, `SP`, `RP`) and a `positions` array of eligible spots. Position eligibility is fixed at generation (no in-game position changes for v1 — that's v2 polish).

Fielding rating is **position-adjusted** in the sim: a 70 `fielding` SS makes more plays than a 70 `fielding` 1B because the SS position multiplier is higher.

## Class year, eligibility clock

- `classYear`: `'FR'` | `'SO'` | `'JR'` | `'SR'`
- `seasonsUsed`: 0–4
- `semestersUsed`: 0–10
- `eligibilityStatus`: derived (`'eligible'` | `'redshirt'` | `'graduated'` | `'transferred'`)

## Generation

Two paths feed players into the world:

### 1. Initial roster generation (new dynasty)
For each school, generate ~35 players based on the school's **program strength** (a 0–100 score covering recent success, facilities, recruiting reputation). Stronger programs get higher mean ratings and higher mean potentials. Within a roster:

- ~9 starting position players + ~5 bench
- ~8 starting/long pitchers + ~5 bullpen
- ~3 redshirts / depth

Class mix targets roughly: 25% FR, 28% SO, 25% JR, 22% SR (NAIA is JUCO-heavy, so SO and JR transfers are common).

### 2. Recruit pool generation (offseason)
Each year generate a national recruit pool (~600 HS seniors + ~200 JUCO transfers). Each has hidden true ratings + hidden potential. Scouts reveal these through scouting (see `recruiting.md`).

## Rating distributions

Across all players in the world:
- **Mean rating around 50, stddev ~12.** Most players cluster 40–65.
- **Top players** (~top 5%) live in 75–90.
- **Generational** (~top 0.1%) can hit 90+. Rare and very rare.
- **Potential `P` ≥ `R` always.** Distribution: P − R averages 12 for FR, 8 for SO, 4 for JR, 1 for SR.

## Development

End of each season, every player gets a development pass:
- Move each `R` toward `P` by a small amount (~0–4 points), modulated by `work_ethic`, age, and playing time.
- Some chance of regression for SR-year players who didn't perform.
- Hidden `P` is **slightly stochastic** too — late bloomers and busts. Mostly stable but ±2 per year.

## Scouting fog

Coaches never see true ratings on recruits. They see a **scout grade** that's a noisy estimate of the true rating, where noise shrinks as scouting effort increases:

- Initial sight (no scouting): grade = true ± 15
- After one scout trip: ± 8
- After multiple trips + visits: ± 3
- Players on your own roster: true ratings revealed (you see them play every day)

This makes the recruiting loop a fog-of-war problem, not a number-shopping problem.

## Data model sketch

```ts
type Player = {
  id: string
  firstName: string
  lastName: string
  birthDate: string       // for age calculation
  hometown: { city: string; state: string }
  schoolId: string | null // null = still a recruit
  classYear: 'FR' | 'SO' | 'JR' | 'SR'
  seasonsUsed: number
  semestersUsed: number
  eligibilityStatus: 'eligible' | 'redshirt' | 'graduated' | 'transferred'

  primaryPosition: Position
  positions: Position[]
  bats: 'L' | 'R' | 'S'
  throws: 'L' | 'R'

  isPitcher: boolean
  isHitter: boolean

  hitter: {
    contact_l: number; contact_r: number
    power_l: number; power_r: number
    discipline: number; speed: number
    fielding: number; arm: number
  }

  pitcher: {
    stuff: number; control: number; command: number
    stamina: number; vs_l: number; vs_r: number
    composure: number; durability: number
  }

  hidden: {
    potential_hitter: Record<keyof Player['hitter'], number>
    potential_pitcher: Record<keyof Player['pitcher'], number>
    work_ethic: number
    clutch: number
    injury_prone: number
    loyalty: number
  }

  // Scholarship $ they're currently on (sticks year over year unless renegotiated)
  scholarship: {
    annualAmount: number    // $ awarded this year
    yearsCommitted: number  // how many years coach has guaranteed
  }
}
```

## Open questions for Nate

- **Q1.** Pitch-by-pitch (replace `stuff` with FB/SL/CB/CH) or aggregate `stuff` rating? Default: aggregate.
- **Q2.** Confirm 8 hitter + 8 pitcher attributes is right? Add intangibles like `baserunning_iq` or `bunt`? Default: keep tight.
- **Q3.** Do you want batter handedness splits to apply equally to all hitters, or should switch-hitters get a small bonus? Default: switch-hitters get +3 to the contact rating they'd otherwise have at a platoon disadvantage.
- **Q4.** Should `clutch` actually visibly affect outcomes, or stay subliminal? Default: small effect (±5% on high-leverage PA outcomes).
