# Ranking Algorithm — Predictive, SOS-Adjusted

**Goal:** rank every NAIA program 1-N by *who would beat whom*, not by who has the prettiest record. Replaces NAIA's RPI/BoChip (which Nate hates). Inspired by how PEAR builds its `Rating`, `NET_Score`, and z-score WARs.

## The problem with raw records

A team with a 1.50 ERA in a conference of weak hitters isn't the best pitching team in the country. A team batting .350 against bad opposing pitching isn't the best lineup. RPI partially fixes this by adding SOS, but it's a crude weighting and missing the predictive piece.

Our ranking has to answer: **"On a neutral field, against a generic opponent, how many runs would Team A score and allow per game?"**

## Three pillars

Every team gets three component ratings, each centered on 0 with stddev 1 (so they're comparable):

1. **Offense rating** — runs/PA produced, **SOS-adjusted against opposing pitchers faced**
2. **Pitching rating** — runs/PA allowed, **SOS-adjusted against opposing hitters faced**
3. **Defense rating** — field outs above expected (BABIP-style), **SOS-adjusted**

Combined into a single `overall_rating` by summing them, then standardizing.

## Computation (offline, after season)

The math runs on aggregated game data, not single PAs. For each team:

### Offense

```
raw_offense = team's OPS over the season   (or wOBA if available)

opposing_pitching_quality = average of opposing pitchers' raw_pitching ratings
                           weighted by PAs faced

sos_offense_adj = avg_NAIA_pitching - opposing_pitching_quality

offense_rating = (raw_offense - mean_NAIA_OPS) / stddev_NAIA_OPS + sos_offense_adj * weight_sos
```

`weight_sos` is the dial — high values penalize cherry-picking schedules.

### Pitching (same shape)

```
raw_pitching = team's runs allowed / game  (or FIP if we model it)

opposing_offense_quality = avg of opposing offense ratings weighted by PAs

sos_pitching_adj = avg_NAIA_offense - opposing_offense_quality

pitching_rating = (mean_NAIA_RA - raw_pitching) / stddev_NAIA_RA + sos_pitching_adj * weight_sos
```

### Defense

```
raw_defense = team's BABIP-against (low = good) adjusted for park
defense_rating = (mean_NAIA_BABIP - raw_defense) / stddev_NAIA_BABIP + sos_pitching_adj * weight_sos
```

### Overall

```
overall_rating = (offense_rating + pitching_rating + defense_rating * 0.5)
```

Defense weighted half because in baseball, defense matters but less than O & P. Tunable.

## Iterative resolution (critical)

The pillars depend on each other (offense's SOS depends on opposing pitching ratings, which depend on THEIR opposing offense, etc.). We resolve by iteration:

```
ratings = initialize from raw stats (no SOS adjustment)
for i in 1..15:
   ratings_new = recompute each team's rating using current opponents' ratings
   if max_delta(ratings_new, ratings) < epsilon: break
   ratings = ratings_new
```

This converges in 10-15 iterations to a fixed-point estimate. Same trick PEAR and Massey use.

## In-game initial seed (Year 1)

For the very first season (which starts summer 2026 → spring 2027 in the sim), we don't have simulated game data yet. **We seed directly from PEAR's 2025-26 final values:**

| In-game pillar          | Seeded from PEAR field    |
| ----------------------- | ------------------------- |
| `offense_rating`        | `oWAR_z`                  |
| `pitching_rating`       | `pWAR_z`                  |
| `defense_rating`        | `fWAR` (re-z-scored)      |
| `overall_rating`        | `Rating`                  |
| `sos_index`             | `SOS` rank, normalized    |

These seed values then drive Year 1 sim outcomes. After Year 1's games are played, the algorithm recomputes from the simulated season — giving us a *new* ranking that reflects how our world evolved (and your dynasty's impact).

## What gets displayed

- **Overall national rankings** (1 to ~200): sortable by overall, offense, pitching, defense, SOS
- **Conference standings**: traditional W-L within conference + overall rating column
- **Resume page**: Q1/Q2/Q3/Q4 records (like PEAR), but with our SOS adjusted opponent-quality bands
- **Comparison tool**: pick two teams, see all three pillar matchups + projected matchup outcome

## NAIA postseason selection (auto-bid + at-large)

See `postseason.md` for the full selection algorithm. Short version: 30 auto-bids (top 2 from each conference + tiebreakers), 16 at-large bids by our **overall ranking** (not RPI/BoChip). 46-team field, 10 sites (six 5-team brackets, four 4-team brackets), winners advance to Avista NAIA World Series at Harris Field in Lewiston.

## Open questions

- **RK1.** SOS weight (`weight_sos`)? Default: **0.4** — meaningful but not dominant.
- **RK2.** Re-rank during the season (live) or only at certain checkpoints? Default: **weekly during season**.
- **RK3.** Should pillar weights (3 components → overall) be user-tunable for the "Rankings" page? Default: **show fixed default + a "custom weights" toggle**.
- **RK4.** How do non-NAIA opponents (D1/D2/D3) factor into a NAIA team's SOS? Default: **use their division-adjusted strength** — beating a D1 team is worth a *lot* more SOS than beating an NWAC JUCO.
