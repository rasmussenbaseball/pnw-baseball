# Calendar / Week Loop

**Goal:** the heartbeat of the game. Every player action happens within a week; the season + offseason is just a sequence of weeks. Designed so v2 features (practice, lift, meals, injuries, budget) drop in as **hooks on the weekly tick** without restructuring v1.

## The week is the atomic unit

A "week" in-game is **one tick of the engine**. The game has three modes of week:

| Mode      | When                  | What happens                                                              |
| --------- | --------------------- | ------------------------------------------------------------------------- |
| **Season**    | Feb → late May        | Games played, lineups set, pitchers rest                                  |
| **Postseason**| Late May → early June | Conference tournament, Opening Round, Avista WS                           |
| **Offseason** | June → Jan            | Recruiting weeks; eligibility/grad/transfer churn; player development     |

A full **year** is ~50 weeks split roughly:
- 16 season weeks
- 2 postseason weeks
- 32 offseason weeks (compressed into 12 *meaningful* recruiting weeks for v1; the rest auto-advance)

## The user's loop

The user lives in a "command center" dashboard that shows:
- Current date / week / mode
- A big **"Sim to next event"** button (the dominant interaction)
- Quick links to: Roster, Lineups, Schedule, Recruiting, News

"Next event" is mode-dependent:
- Season mode: **next game day** (the user can also "Sim through end of week" or "Sim entire season")
- Offseason mode: **end of recruiting week**
- Anytime: the user can pause if there's a forced decision (injury, recruit decommitting, transfer offer)

## Season week breakdown (in detail)

Real NAIA weeks have:
- Tuesday or Wednesday midweek game (single, sometimes DH)
- Friday-Saturday-Sunday weekend series (3-game, sometimes 4)

Sim breakdown of one season week:
```
Monday:    Travel / practice (v2 hook — practice schedule affects fatigue/dev)
Tuesday:   Midweek game (50% of weeks)
Wednesday: Practice (v2 hook)
Thursday:  Travel for weekend series
Friday:    Game 1 of weekend series
Saturday:  Game 2 (often DH)
Sunday:    Game 3
```

Pitcher rest ticks every day. Practice (v2) ticks fatigue gain/loss for hitters.

## Offseason week breakdown

12 *meaningful* recruiting weeks span June → late May. We auto-advance through the parts where nothing is happening. The user-facing rhythm:

```
Week 1 (June):  Recruiting opens, HS class freshly eligible
Week 2:         Summer ball reports for current players (v2 hook)
Week 3-4:       Heavy scout-trip phase
Week 5:         JUCO transfer portal opens (v2 hook)
Week 6:         Early signings start
Week 7:         Fall workouts begin (v2 hook — practice/lift/meals come in here)
Week 8 (Oct):   Halftime — mid-cycle check-in
Week 9 (Nov):   Most HS verbals lock
Week 10 (Mar):  JUCO decision window opens (their spring's almost done)
Week 11 (Apr):  Late JUCO signings
Week 12 (May):  Signing day. Roster finalized.
```

## Weekly tick — abstract pipeline

This is the v1 shape. Every Monday-of-week, the engine runs:

```ts
function tickWeek(state: SaveState): SaveState {
  // 1. Update player status (rest days, semesters, eligibility)
  for (const p of state.allPlayers) {
    tickPlayer(p, state.calendar)
  }

  // 2. Run mode-specific logic
  if (state.calendar.mode === 'SEASON') {
    runWeekOfGames(state)
  } else if (state.calendar.mode === 'POSTSEASON') {
    runPostseasonRound(state)
  } else {
    runOffseasonWeek(state)
  }

  // 3. v2 HOOKS — declared but no-op for v1
  applyPracticeEffects(state)       // v2: practice schedule affects fatigue/dev/injury
  applyLiftingEffects(state)        // v2: lifting affects strength/durability
  applyMealsEffects(state)          // v2: nutrition affects recovery/development
  rollInjuries(state)               // v2: injury rolls modulated by intensity/durability
  applyBudgetEffects(state)         // v2: budget pays for travel/facilities/staff

  // 4. Advance calendar
  state.calendar.week += 1
  return state
}
```

The v2 hooks are **literally declared functions in the engine** that return the state unchanged in v1. That way when v2 lands, we wire them up without touching the tick pipeline.

## Forced-decision moments (engine pauses for user)

Some events break the auto-sim:

- **Injury to a starter** in your top-9 or top-5 rotation → pause, present a lineup decision
- **Recruit verbal flips** → pause, surface a notification
- **Inbound transfer interest** → pause, decide whether to recruit them
- **Postseason elimination or championship** → pause, season summary

These prevent the user from blowing through important moments by clicking "sim to end of season".

## Save snapshots

The engine snapshots `SaveState` to localStorage:
- After every **week tick** (so you can never lose more than one week)
- After major events (signing day, postseason exits)
- Manual save on demand

Three save slots per user (UX call). Save format is JSON, gzipped if size requires.

## v2 hook points (declared but inert in v1)

| Hook                       | v2 system        | Inputs needed                                            |
| -------------------------- | ---------------- | -------------------------------------------------------- |
| `applyPracticeEffects`     | Practice schedule| Hours/week, intensity, drill mix                         |
| `applyLiftingEffects`      | Strength program | Lift days/week, intensity                                |
| `applyMealsEffects`        | Nutrition        | Meal quality (cafeteria, training table, post-workout)   |
| `rollInjuries`             | Injury system    | Practice intensity + durability + age + injury_prone     |
| `applyBudgetEffects`       | Budget           | $ allocated to facilities, travel, staff, meals          |
| `applyStaffEffects`        | Coaching staff   | Pitching coach / hitting coach / S&C coach hires         |

These all hook into the same `tickWeek` pipeline. v1 ships with them stubbed; v2 fills them in.

## Calendar data model

```ts
type Calendar = {
  year: number               // in-game year, starting from 2026
  week: number               // 1-50
  mode: 'SEASON' | 'POSTSEASON' | 'OFFSEASON'
  seasonWeek: number | null  // 1-16 if in SEASON
  offseasonWeek: number | null  // 1-12 if in OFFSEASON
  forcedPause: ForcedPause | null
}
```

## Open questions for Nate

- **Q12.** Confirm 12 meaningful offseason weeks (vs more granular)? Default: 12.
- **Q13.** Should the user have any tools during the auto-advanced (non-recruiting) weeks, or do we truly fast-forward? Default: fast-forward; news/decisions resume at next recruiting week.
- **Q14.** Are there in-game years that should feel different (e.g. a "House settlement" event, a coaching turnover at a rival)? Default: keep it simple — all years are the same shape for v1.
