# Action Points — The Week-to-Week Engine

**Goal:** Action Points (AP) are the **primary mechanic** of the week-to-week game. Every non-game decision spends AP. AP earned per week is driven by your full coaching staff (HC + assistants) and team performance. AP spent shapes the development of the team and program.

This is the core engagement loop.

## What AP represents

AP abstracts the coaching staff's **time and energy** across the week. A 3-coach staff has less capacity than a 7-coach staff. A program riding momentum has more capacity than one mired in chaos. Where you spend that capacity is the strategic heart of the game.

## AP earned per week

Computed at the start of every week:

```
AP_per_week =
    base_AP                                        // 20 baseline
  + sum(staff_rating_contributions)               // varies by staff size + quality
  + team_performance_modifier                    // +/- based on streak, ranking
  + tier_bonus                                   // facility/program tier
```

### `staff_rating_contributions`

Each coach contributes AP based on their ratings, with **diminishing returns** so you can't infinitely hire mediocre coaches:

```
contribution(coach) = (avg_of_coach_ratings - 50) * 0.4 * role_multiplier
```

| Coach role            | Role multiplier | Notes                                              |
| --------------------- | --------------- | -------------------------------------------------- |
| Head Coach            | 1.5             | Always present; counted once                       |
| Pitching Coach        | 1.0             |                                                    |
| Hitting Coach         | 1.0             |                                                    |
| Bench Coach           | 0.8             | Tactician-heavy                                    |
| Recruiting Coordinator | 1.0            | Heavy `recruiter`                                  |
| Strength & Conditioning | 0.7           | `developer` for v2 lift system                     |
| Director of Operations | 0.6           | Admin lift, scheduling                             |

A typical 3-coach staff: HC + Pitching + Hitting → roughly +18 AP from staff (well-rated). A 7-coach staff: ~+30 AP.

So a small staff with a strong HC might run **35 AP/week**; a full staff at a top program might run **55 AP/week**.

### `team_performance_modifier`

| Situation                           | AP modifier      |
| ----------------------------------- | ---------------- |
| 5+ game win streak                  | +3               |
| 5+ game losing streak               | -3               |
| In NAIA Top 25 polls                | +2               |
| Just won a series                   | +1 (next week)   |
| Just got swept                      | -1 (next week)   |
| Won conference championship         | +5 (next 4 weeks)|
| Major recruit verbal'd to you       | +2 (next week)   |
| Star player transferred out         | -2 (next week)   |

Caps: total performance modifier capped at ±8.

### `tier_bonus`

Schools at higher `resourceTier` start with a small baseline bump (better facilities mean less of the staff's time is firefighting):

| Tier         | Bonus AP |
| ------------ | -------- |
| `D1_LITE`    | +4       |
| `WELL_FUNDED` | +2      |
| `MID`        | 0        |
| `SHOESTRING` | -2       |

## What AP can be spent on

Categorized. Most actions cost 1–6 AP. The big-ticket items cost 8–15 AP.

### Recruiting actions (see `recruiting.md`)

| Action                            | AP cost | Notes                          |
| --------------------------------- | ------- | ------------------------------ |
| Phone call                        | 1       |                                |
| Scout trip (in-region)            | 3       |                                |
| Scout trip (out-of-region)        | 5       |                                |
| Home visit                        | 5       |                                |
| Campus visit                      | 6       |                                |
| Compete (flip from rival)         | 2       |                                |
| Sweeten scholarship $             | 0       | (Costs $ from your pool)       |

### Player development actions

| Action                            | AP cost | Effect                                                       |
| --------------------------------- | ------- | ------------------------------------------------------------ |
| Position-group practice           | 2       | +0.5 dev to one rating across all players at that position   |
| Individual workout                | 1       | +1.0 dev to one rating for one player                        |
| Pitching bullpen session          | 1       | +1.0 dev to one rating for one pitcher                       |
| Position change drilling          | 4       | Slowly add a new position to a player's `positions[]`        |
| Bat speed program                 | 3       | +1.0 dev to power_l + power_r for one player                 |
| Plate discipline drills           | 3       | +1.0 dev to discipline for one player                        |
| Defensive boot camp (team)        | 8       | +0.3 dev to fielding across the whole roster                 |
| Strength block                    | 6       | Small durability bump across roster (v2 lift hook)           |

Development is the **primary path to building stars from mid-grade recruits** — these actions accumulate small dev gains that compound across a player's 4-year career.

### Team-boost actions (temporary)

| Action                            | AP cost | Effect                                                       |
| --------------------------------- | ------- | ------------------------------------------------------------ |
| Film study (vs upcoming opponent) | 4       | +5% to next series' batter discipline + pitcher command      |
| Big-series motivation             | 6       | +3 to clutch + composure for one weekend                     |
| Special travel package            | 5       | Cancel out fatigue penalty for a long road trip              |
| Bullpen day                       | 3       | Reset rest for 2 pitchers (one-time use)                     |
| Pep rally                         | 2       | Team chemistry bump for one game                             |
| Closed practice                   | 4       | Fix a slumping player (resets a hidden "slump" flag, v2)     |

These are the "spend AP for a big series" lever — used to surge in a key conference matchup.

### Program-building actions

| Action                            | AP cost | Effect                                                       |
| --------------------------------- | ------- | ------------------------------------------------------------ |
| Media / branding push             | 5       | +2 to program_history rating drift (slow)                    |
| Booster meeting                   | 4       | +5% to next year's scholarship pool                          |
| Camps & clinics                   | 8       | Generates 3-5 new HS recruits with regional pipeline tag     |
| International scout trip          | 12      | Generates 1-2 international recruits (v2 unlock)             |
| Hire/fire scouting analyst        | varies  | Sets up specialized recruiting tools (v2 polish)             |

### Staff actions

| Action                            | AP cost | Effect                                                       |
| --------------------------------- | ------- | ------------------------------------------------------------ |
| Interview assistant coach         | 3       | View 3-5 available coaches with their ratings                |
| Hire assistant coach              | 0       | (Costs $ from your coaching budget)                          |
| Fire assistant coach              | 0       | (Frees salary $; cost: morale dip)                           |
| Coach development                 | 4       | +1 to one rating of one of your assistants                   |

### Off-the-field actions

| Action                            | AP cost | Effect                                                       |
| --------------------------------- | ------- | ------------------------------------------------------------ |
| Academic check-in                 | 2       | Reduce risk of eligibility issues (v2)                       |
| Team-building event               | 3       | Team chemistry bump                                          |
| Conditioning emphasis             | 4       | Reduce injury risk for next 4 weeks (v2)                     |
| Address a problem player          | 5       | Boost loyalty +5 for a player on the Retention Watch list    |

## Spending strategy

The user has more potential actions than AP. The strategic question every week is:
- Do I pump my recruiting board to land the prospect everyone's chasing?
- Do I develop my own players who could be stars in two years?
- Do I spend on next weekend's big rival series?
- Do I do program-building work that pays off in 2-3 years?

This is the **dynasty-building game loop**. AP forces tradeoffs.

## Carryover and decay

- Unspent AP **does not carry over** (use it or lose it). This prevents hoarding.
- Persistent boosts from actions (like media-push program-history drift) don't decay — they're permanent small ratchets.
- Temporary boosts (clutch/composure for a series) decay after their stated duration.

## During the season vs offseason

**In-season:** AP is dominated by team-boost + practice actions. Recruiting is a smaller share.

**Offseason:** AP is dominated by recruiting + development + program-building. Team-boost actions are unavailable.

The full year of AP spending shapes whether your team improves or stagnates.

## Coaching budget — the $ side

Separate from AP, the user has an annual **coaching budget** ($ allocated to coach salaries). This drives:
- How many assistant coaches you can afford (3–7 typical)
- Quality of coaches you can attract
- Risk of losing your best assistants to better-paid jobs

The user splits an overall athletics budget between **scholarships** ($ for players) and **coaching salaries** ($ for staff). Both pull from a shared pool. See `school_resources.md` for the pool size logic and `coaches.md` for how salary affects hiring.

## Coach-rating → AP feedback loop

A virtuous cycle that's important to the game's progression:
- Better/more coaches → more AP/week
- More AP → more development + better recruiting
- Better development + recruiting → better team
- Better team → performance bonus → more AP
- More AP allows you to afford and develop even better coaches

This is what makes a multi-year dynasty fun: you're not just compounding wins, you're compounding *capacity*.

## Open questions

- **A1.** Should AP have a soft cap (e.g. max 80/week to prevent runaway compounding)? Default: **yes, cap at 80.**
- **A2.** Should there be a "burnout" debuff if a coach is loaded with too many actions (sustained 100%+ spending)? Default: no for v1, maybe v2.
- **A3.** Some actions feel they should require certain coaches on staff (e.g. "Bat speed program" needs a Hitting Coach). Do you want that hard prerequisite or just a quality modifier? Default: **soft modifier** — without a Hitting Coach the action still works but is less effective.
- **A4.** Is "AP unused at end of season" lost, or converted to a small offseason bonus? Default: **lost** — forces decisions.
- **A5.** Can the user buy AP with $? Default: **no** — keeps the game economy honest.
