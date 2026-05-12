# Simulation Engine — Plate Appearance Level

**Goal:** simulate a game in ~5-15ms so a full 50-game season + postseason runs in under 2 seconds. Outcomes should be realistic enough that good rosters win more, but stochastic enough that upsets happen.

## Granularity decision

**Plate appearance level.** Each PA produces one of:

`K | BB | HBP | 1B | 2B | 3B | HR | OUT(type)`

where OUT type is `groundout`, `flyout`, `lineout`, or `popout` (for fielding/baserunning logic).

Why not pitch-by-pitch: 4–6× slower with no UI to react to it.
Why not inning-by-inning: too coarse to compute realistic individual stats.

**OPEN QUESTION (Q2 in questions doc):** confirm PA level. If Nate ever wants pitch-by-pitch as a "watch this game" mode, we keep the engine layered so PA outcomes can be re-derived from pitch outcomes later.

## The PA function

```ts
function simPA(
  batter: Player,
  pitcher: Player,
  ctx: PAContext,
  rng: RNG
): PAOutcome
```

`PAContext` carries: inning, outs, baserunners, score differential, defensive ratings of the 9 fielders, park factor (v2), weather (v2), pitcher fatigue.

### Step 1 — base probabilities

Take a baseline NAIA outcome distribution (approximate league rates):

| Outcome | League rate |
| ------- | ----------- |
| K       | 22%         |
| BB      | 10%         |
| HBP     | 1%          |
| 1B      | 16%         |
| 2B      | 5%          |
| 3B      | 0.5%        |
| HR      | 3.5%        |
| Out     | 42%         |

(NAIA stat lines run a bit higher K and HR rate than D1; tune these against real 2025 NAIA aggregate stats when we plug them in.)

### Step 2 — apply rating modifiers

Each rating shifts the relevant probability via a sigmoid-mapped log-odds adjustment:

```
logitAdjust = α * ((batterRating - 50) - (pitcherRating - 50)) / 50
```

with per-outcome weights:

- **K rate:** −α(batter discipline) + α(batter contact_x) − α(pitcher stuff) − α(pitcher vs_x), where x is L/R based on batter handedness
- **BB rate:** +α(batter discipline) − α(pitcher control)
- **HBP rate:** −α(pitcher control) × 0.3 (small effect)
- **HR rate:** +α(batter power_x) + α(pitcher command, inverted) − α(pitcher stuff) × 0.5
- **1B rate:** +α(batter contact_x) + α(batter speed) × 0.2 − α(pitcher stuff)
- **2B/3B rates:** +α(batter power_x) × 0.4 + α(batter speed) × 0.3
- **Out rate:** residual (whatever isn't allocated above)

α is a global tuning constant (~0.6 to start) controlling how much ratings matter. Higher α = ratings dominate, lower = more variance.

### Step 3 — composure + clutch + fatigue modifiers

Apply context-sensitive tweaks:

- **High leverage (LI > 1.5):** apply `clutch` and `composure` modifiers (±5% on outcome distribution).
- **Pitcher fatigue:** every PA past their stamina threshold, multiply `stuff` and `control` by a decay factor.
- **Times through order:** 3rd time through the order, pitcher's `stuff` drops ~5%.
- **Park factor (v2):** ±10% on HR rate based on park.

### Step 4 — sample the outcome

Normalize the adjusted probabilities to sum to 1, then sample using the RNG.

### Step 5 — for OUTs, sample out type + fielding outcome

- Sample whether OUT is GB, FB, LD, PU based on batter contact profile.
- For GB: defensive `fielding` + `arm` at the responsible position decides if it's converted or becomes a hit (error/infield single). Pre-positioned fielders modeled v2.
- For FB/LD: range-based OF conversion.

### Step 6 — baserunning

For hits, advance runners with a deterministic but speed-sensitive rule:
- Single → R1→R2, R2→3rd or home depending on hit location + speed, R3→home
- Double → R1→3rd or home, R2/R3 → home
- Sample steal attempts at appropriate counts based on R1.speed and pitcher hold rating (v2; for v1 fixed at 70).

## Game-level loop

```ts
function simGame(home: Team, away: Team, rng: RNG): GameResult {
  // Set lineups (use user's lineup or AI default)
  // Set starting pitchers
  // For each half-inning until game ends:
  //   For each batter PA:
  //     simPA(...) → update boxscore, base/out state
  //   Manage pitching changes (AI follows usage rules)
  //   Check for game end
  // Return: final score, boxscore, individual stats, win prob graph (v2)
}
```

## Pitching usage (AI manager)

The opposing team's AI manager follows simple rules:
- Starter goes until: pitch count > 90 OR stamina exhausted OR opponent has scored 4+ in the inning OR 7th+ inning
- Setup man in the 7th-8th if available
- Closer in the 9th with lead ≤ 3
- For the user, the user sets the bullpen depth chart and the AI uses it for their team (manual relief mid-game = v2)

## Pitcher rest/fatigue between games

Each appearance generates fatigue points. Pitchers need 1–4 days to fully recover depending on pitch count. We track `restDaysSince` and apply a stuff/control penalty if a pitcher pitches on insufficient rest.

This is what makes the rotation actually matter: a 5-man rotation works for a weekend series + midweek, but if you over-pitch your ace you'll have to start a worse pitcher.

## Season / postseason orchestration

```ts
function simSeason(league: League, seed: number) {
  const schedule = buildSchedule(league.teams)
  for (const day of schedule.days) {
    for (const game of day.games) {
      simGame(game.home, game.away, makeRng(seed, game.id))
      updateStandings(...)
      updatePlayerStats(...)
      tickPitcherRest(...)
    }
  }
  return runPostseason(league, seed)
}
```

Schedule builder produces ~50 games:
- 30 conference games (3-game weekend series within conference)
- 15 non-conference (regional travel partners)
- 5 midweek games scattered

## Performance budget

Target: < 2s for full season + postseason on a mid-range laptop.

Math:
- ~200 teams × 50 games each = 10,000 games per simmed season (but only ones involving your team need full fidelity; opponents' non-relevant games can use fast-sim that just produces a final score from team strength)
- Full-fidelity sim: ~80 PA per game × ~10ms = 800ms ➝ that's per game, too slow

**Two-tier sim:**
- **Full sim** for games involving your team (and postseason): full PA-by-PA, generates boxscore + stats
- **Fast sim** for other teams' games: monte carlo from team strength rolls, produces just a final score and basic team stats

10,000 fast sims × ~0.2ms = 2s ✓
~55 full sims × ~10ms = 0.5s ✓

## Reproducibility

Seeded PRNG (`mulberry32` or similar) keyed by `(saveId, season, day, gameId, paIndex)`. This means re-running a sim with the same inputs gives the same outputs — crucial for debugging "wait, why did my ace just get rocked".

## Open questions for Nate

- **Q5.** Confirm 50-game schedule (vs the real 55-game cap)? My recommendation: 50 for v1 keeps things snappy; we can bump to 55 once perf is dialed.
- **Q6.** Should the user be able to watch a game play out with a tick/play log, or is "click sim, see final result" enough for v1? Default: text play log on a side panel, can be skipped.
- **Q7.** How much defensive realism for v1? Sub-options: (a) just position fielding rating, (b) add `arm` for OF assists and double plays, (c) add positioning/shifts. Default: (a) + simple (b). Shifts in v2.
