# Player Transfers — Outbound

**Goal:** model the wild-west NAIA reality that players come *and go* constantly. Stars chase D1 offers. Buried bench players look for playing time elsewhere. Disgruntled guys take their year of remaining eligibility to a rival.

This doc covers **outbound** transfers (players leaving your program or any other simulated program). For inbound transfers see `recruiting.md` — the NAIA→NAIA portal pool there is literally populated by this doc's mechanism.

## When transfer decisions get made

End of every season, every player on every roster gets a **transfer evaluation**. The evaluation happens during the offseason engine tick, before the new recruiting cycle opens.

For each player, compute three numbers:

- `satisfactionScore` — how happy are they at their current school?
- `nextLevelAppeal` — are they good enough to play higher up?
- `transferRisk` — probability they actually leave

## satisfactionScore (0–100)

Inputs:
- **Playing time** (huge weight): % of team's PA or IP they got. < 20% = unhappy.
- **Win record**: team won = bump up. Team lost a lot = small drag.
- **Position depth** in front of them next year (returning players ahead of them).
- **Coach motivator rating**: +5 if motivator > 80.
- **Class year**: SR-1 (final year remaining) = more locked in. FR = most mobile.
- **Home distance**: nostalgic players more likely to leave for home.
- **Scholarship $ they're on**: getting paid = sticky.

Returns 0–100 where higher = more satisfied = less likely to transfer.

## nextLevelAppeal (-100 to +100)

A player's "transfer up" math. Positive means they could plausibly play higher up:
```
appeal = (player.overall_rating - 70) * 1.5 + (player.potential_overall - player.overall_rating) * 1.0
```

- A 90-rated player has `appeal = +30` → realistic D1 target
- A 70-rated player has `appeal = 0` → no D1 interest, but other NAIA programs would have him
- A 50-rated player has `appeal = -30` → at risk of having no portal market

Negative appeal means they can't move up, but they can still move sideways or down.

## transferRisk

```
risk = base_risk
     + (40 - satisfactionScore) * 0.8        // unhappy → risky
     + appeal * 0.3                          // talented → risky (D1 will call)
     + class_year_factor                     // FR most mobile, SR least
     - coach.motivator * 0.2                 // good coach retains
```

Roll a random number. If `random(0,100) < risk` → player declares transfer intent.

Base rates target ~20-35% annual roster turnover (matches real NAIA).

## Where do they go?

A player who declares transfer intent enters a **destination decision** the same offseason. We sample a destination based on `appeal`:

| Appeal           | Destination distribution                                         |
| ---------------- | ---------------------------------------------------------------- |
| +20 or higher    | 60% D1 portal (gone from sim) / 25% top-tier NAIA / 15% mid NAIA |
| +5 to +20        | 15% D1 / 50% mid-tier NAIA / 30% other NAIA / 5% JUCO            |
| -5 to +5         | 5% D1 (long shot) / 30% NAIA upgrade / 50% NAIA lateral / 15% JUCO / quits |
| Below -5         | 10% NAIA lateral / 30% JUCO / 30% pro indy / 30% quits baseball   |

(D2/D3 transfers exist but we abstract those into "D1" for simplicity — leaving the sim either way for v1.)

### D1 transfers (`appeal >= +20`, rolled D1)

- **Leave the simulated world.** They're gone from our 199 NAIA schools.
- Show up on the newsfeed: "John Smith (your 2B last year) signed with TCU."
- Track in a "Coaching tree / alumni" stats page: which D1 program, did they make it.

### NAIA→NAIA transfers

- Become part of the **NAIA Transfer Portal pool** for next offseason's recruiting (see `recruiting.md`)
- **Cannot transfer within their own conference** — this is a real NAIA rule and the destination sampler enforces it
- They enter the pool with a **destination preference** — typically a program 1–2 tiers above their current one
- Other programs (including you, if you're not in their conference) can recruit them like any other portal target
- Eventually sign with someone; appear on that program's roster

### JUCO transfers (back down to JUCO)

- Leave the sim (they go play JUCO, may come back to the JUCO recruiting pool the next year)
- Rare path; usually freshmen who didn't take the next step

### Quits / pro / other

- Leave the sim entirely

## "Disgruntled" mechanic — you get warned

The game gives the user signals **before** the transfer decision finalizes:

- If `satisfactionScore < 40` after the regular season, the player appears on a **"Retention Watch"** sidebar with a reason ("not enough playing time", "wants to play closer to home", "coachable but feels overlooked")
- The user can attempt **retention actions** during a 1-week window after the season:
  - **Promise playing time** — bumps satisfaction; costs nothing but locks you to a future lineup decision
  - **Sweeten scholarship $** — bumps satisfaction; costs $ from next year's pool
  - **One-on-one meeting** — coach.motivator-modulated retention bump
- Then the engine re-rolls transferRisk with the new satisfaction

This is dynasty *narrative* — your top players threatening to leave each year, you deciding who to keep.

## The other side: incoming portal feels different

Because the portal pool is populated by departing real (simulated) players from other programs, **you'll know things about them**:
- Their previous program (visible)
- Their previous-year stats (visible)
- Their `appeal` and `satisfactionScore` (hidden — you scout to learn)
- Why they left (rumor; visible to the user as "wanted more playing time" / "team didn't make the postseason" / etc.)

This is a feature of the wild-west design: real-tier-level porousness between programs.

## Stars to D1 — they're gone, but visible

The newsfeed surfaces D1 departures of your players prominently. Track a per-coach alumni table:

```
Players you've sent to D1: 7
Players who made D1 rosters: 5
Players who got drafted (v2+): 0
```

This is a long-term coaching legacy stat — a recruiting tool, even.

## Eligibility math

NAIA→NAIA transfer: immediately eligible (per current rule; verify, see `rules.md`).
NAIA→D1: leaves the sim, NCAA rules apply on their side (not modeled).
The transferring player's clock continues — they don't reset semesters.

## Edge cases

- **SR-1 players almost never transfer.** Senior with final year left = locked in 95% of the time.
- **Two-way players** evaluate using whichever side of the ball they're stronger on for `appeal`.
- **Players the coach cut** (extra roster from over-signing) automatically enter the NAIA portal with `appeal` based on their rating.

## Open questions

- **T1.** Should D1 departures show up periodically with a "would you take a transfer back from them" mechanic (a star spends a year at D1, bombs out, comes back)? Default: yes, but rare — 1-2 per year across the entire sim.
- **T2.** Do you want a "loyalty" intangible attribute on players (some guys never leave, some are mercenary)? Default: yes, hidden — wraps into `satisfactionScore` math.
- **T3.** When a player transfers OUT, does the user see exactly where they signed? Default: yes — it's narrative gold.
- **T4.** Should "graduating SRs" be modeled as a separate category from "transfers out" since they leave too? Default: separate — graduations are predictable, transfers are surprises.
