# Coaching Staff — Head Coach + Assistants

**Goal:** the head coach (the user) builds and maintains a staff of 3–7 assistants. Hiring, firing, paying, retaining. Staff size and quality drives AP/week (see `action_points.md`). Assistants can leave for better jobs.

Inspired by NCAA Football 25's coach archetypes + the assistant-coach-as-skill-tree model.

## Coach data model

```ts
type Coach = {
  id: string
  firstName: string; lastName: string
  age: number

  schoolId: string
  role: CoachRole
  yearsAtSchool: number
  yearsInRole: number   // years in this specific role/title

  // Core ratings (0-99 each)
  developer: number
  motivator: number
  recruiter: number
  tactician: number

  // Archetype
  recruiter_type: 'HS_GRINDER' | 'JUCO_HUNTER' | 'PORTAL_PRO' | 'BALANCED'

  // Affinity
  regions: string[]            // 2-letter state codes
  pipelines: PipelineFlag[]

  // Compensation
  salary: number               // $ per year
  contractYearsRemaining: number

  // Hidden / generated traits
  ambition: number             // 0-99; hidden. Drives jump-to-MLB / D1 risk
  loyalty: number              // 0-99; hidden. Resistance to leaving
}

type CoachRole =
  | 'HEAD_COACH'
  | 'PITCHING_COACH'
  | 'HITTING_COACH'
  | 'BENCH_COACH'
  | 'RECRUITING_COORDINATOR'
  | 'STRENGTH_CONDITIONING'
  | 'DIRECTOR_OF_OPERATIONS'

type PipelineFlag =
  | 'NWAC' | 'CALIFORNIA_JUCO' | 'TEXAS_JUCO' | 'FLORIDA_JUCO' | 'MIDWEST_JUCO'
  | 'PUERTO_RICO' | 'DOMINICAN_REPUBLIC' | 'VENEZUELA' | 'AUSTRALIA' | 'JAPAN'
  | 'D1_PORTAL' | 'HBCU' | 'JUCO_GENERAL'
```

## Staff size

User chooses how many assistants to hire, subject to coaching budget:
- **3 coaches** = HC + Pitching + Hitting (bare minimum, viable at SHOESTRING tier)
- **5 coaches** = Above + Bench + Recruiting Coordinator (standard)
- **7 coaches** = Above + S&C + Director of Operations (top programs)

Each coach beyond the minimum costs $25K–$80K/year depending on quality and role. The coaching budget tradeoff: every $ on coaches is a $ NOT in the scholarship pool.

## How each rating affects gameplay

Same as the prior version — the four core ratings drive specific systems:

### `developer`
End-of-season + in-season player rating progression. **Pitching coach's `developer` only applies to pitchers; hitting coach's only to hitters.** Other roles' `developer` applies team-wide at a smaller rate.

### `motivator`
Bumps players' effective `clutch`/`composure` and team chemistry. **Head coach's motivator weighted highest;** assistants contribute at 50% rate.

### `recruiter`
Modifies AP per week (see `action_points.md`). Recruiting Coordinator's `recruiter` weighted highest.

### `tactician`
Drives AI manager decisions when sim auto-decides. **Bench coach's tactician weighted highest;** HC's a close second.

**Aggregate rule:** for each system above, the *highest-rated specialist on staff* drives the floor, and the others contribute small additive bumps. So hiring a great pitching coach is meaningfully better than spreading the $ across two mediocre ones.

## Archetype and affinity (HC-driven, assistants amplify)

The **head coach's** archetype is the dominant one — it shapes the program's identity (HS_GRINDER, JUCO_HUNTER, PORTAL_PRO, BALANCED).

Assistant coaches can have *different* archetypes:
- If an assistant's archetype matches the HC's, the program archetype is amplified
- If they differ, the program is more balanced but slightly less specialized

Affinity (`regions[]`, `pipelines[]`):
- The program's combined affinity is the UNION of all staff affinities
- This means hiring a coach with a complementary region/pipeline literally opens new recruiting pipelines

Example: HC has `regions: ['OR', 'WA', 'ID']` + `pipelines: ['NWAC']`. You hire a recruiting coordinator with `regions: ['CA', 'AZ']` + `pipelines: ['CALIFORNIA_JUCO']`. Your program now recruits effectively across 5 states + two pipelines.

This makes assistant hiring strategic, not just a budget exercise.

## Hiring assistants

**Process:**
1. User spends 3 AP on "Interview assistant coach for role X"
2. The engine generates 3–5 candidates with varying ratings, archetypes, affinities, and salary demands
3. User reviews their cards (similar to a recruit card — but with $ ask visible)
4. User picks one (or none) and signs them to a contract (1, 2, or 3 years)

**Salary ranges by quality:**

| Coach quality (avg ratings) | Typical salary range  |
| --------------------------- | --------------------- |
| 75+ (top tier)              | $80K–$200K            |
| 60–74 (above average)       | $40K–$90K             |
| 50–59 (average)             | $25K–$50K             |
| Below 50 (developmental)    | $15K–$30K             |

Top-tier assistants are rare and ambitious — they'll often demand 1-year contracts so they can move up quickly.

## Firing assistants

User can fire any assistant at any time:
- Costs $ to buy out remaining contract (if applicable)
- Team morale dip for 2 weeks (small)
- Frees salary $ for next hire

## Coaches leaving you

Each offseason, every assistant rolls a **stay/leave decision**:

```
leave_chance =
    base_chance(5%)
  + (coach.ambition / 200)     // ambitious coaches more mobile
  - (coach.loyalty / 200)      // loyal ones stay
  - (program_strength / 200)   // winning helps retention
  - (raise_recently / 100)     // gave them a raise this offseason? -1%
  + (yearsInRole / 30)         // restless after long tenure
```

Destinations (if they leave):
- **D1 college** (40%) — most common; they're moving up
- **Another NAIA HC job** (25%) — promoted, especially for great assistants
- **MLB org** (15%) — pro scout / minor league coach
- **Lateral NAIA assistant** (15%) — usually for $ reasons
- **Retirement / leave baseball** (5%) — older coaches

**The head coach (the user) can also be poached.** Every 3 years there's a small chance you get an offer from a D1 program. Accepting starts a new dynasty at the new school; declining keeps you at NAIA. (v1 surfaces this as a narrative event; doesn't actually let you accept until v2.)

## Compensation budgeting (the $ side)

Each year the user splits the **athletic budget** between:
- **Scholarship pool** (player aid)
- **Coaching salaries** (staff)

These pull from the same pool. The split is the user's call. A simple control:
- Slider from 0% to 60% on coaches; remainder goes to scholarships
- Default starts at 25% on coaches

Larger programs (higher `resourceTier`) have a bigger total pool. Same percentage split → more $ in absolute terms.

**Tradeoff design:** if you spend too much on coaches you can't offer competitive scholarships and lose recruits. If you spend too little, you don't have a real staff and your AP/week is anemic.

## User's coach (the player)

When starting a new dynasty:
1. Pick your school
2. Create your HC profile:
   - Name (default from Supabase, editable)
   - Pick 3-5 `regions` you have ties to
   - Pick 0-3 `pipelines` you have ties to
   - Pick your `recruiter_type` archetype
   - Distribute starting points: baseline 40+40+40+40 + 90 to distribute = 250 total
3. Inherit current staff at your school (random gen for non-user programs)
4. Decide: keep them, fire & rehire, or restructure roster

Your HC's ratings improve over a successful career (developer +1 per championship; motivator +1 per top-10 finish; recruiter +1 per signing-class win; tactician +1 per upset win in postseason). They also drift down slowly during losing seasons.

## Generating other programs' staffs

Same rough algorithm as before:
- Each program gets a HC sampled from a distribution biased by `programHistory`
- HC archetype biased by `resourceTier`
- HC affinity biased by geography
- Assistants generated based on `resourceTier` (SHOESTRING gets 3 coaches, D1_LITE gets 6-7)
- The world is populated with ~1000 coach profiles total across the league

Coaches don't show up on a "free agent" board — they're either employed somewhere or generated fresh when you interview.

## Open questions

- **C1.** Coach rating drift on losing seasons? Default: **yes**, small (-1/yr on average).
- **C2.** Coaching tree (assistants → HC role tracking, like Madden)? Default: **track it**, surface as "your coaching tree" stat page.
- **C3.** Multi-year HC contracts for the user — should you sign a contract with the school and risk being fired if you underperform? Default: **yes** in v2, no in v1 (user has tenure).
- **C4.** Can you poach assistants from other NAIA programs directly? Default: **yes** — costs $$$, but you can target known coaches.
- **C5.** Should the "buy out remaining contract" cost be calculated? Default: 50% of remaining $ owed.
- **C6.** International coaches (e.g. Dominican former pro signed as your DR pipeline guy)? Default: **stub for v2**.
