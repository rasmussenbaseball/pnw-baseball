# NAIA Baseball — Rules of the Road

Source: research-pass May 2026, pieced together from training-data knowledge + cross-checked conference/Wikipedia pages where reachable. **Verify the load-bearing numbers (scholarship cap, season-game cap, postseason bracket size, transfer rules) against playnaia.org before locking them into game systems.**

This doc captures the real-world rules. `attributes.md`, `sim.md`, `recruiting.md`, and `calendar.md` then decide which rules the game enforces vs. abstracts away.

## Roster

- **No hard cap.** NAIA does not legislate a roster ceiling. Programs typically carry **35–55 players**, driven by budget, dorm space, and partial-scholarship math.
- **Travel rosters** vary by conference; the NAIA postseason has a declared championship roster (historically ~30).
- **No limits** on number of freshmen, transfers, or international players (subject to institutional admissions + F-1 visa logistics).

**Game decision:** the handoff calls for a 35-man roster. That's slightly small for real NAIA but makes UI manageable. We'll use 35 as the active-roster cap and treat anyone above that as a "redshirt list" that practices but doesn't play.

## Eligibility

- **10 semesters / 15 quarters** of attendance to use **4 seasons of competition.** Clock starts at first full-time enrollment anywhere, including JUCO.
- **A "season of competition" is charged for any game appearance** — no NCAA-style "play in 4 games and keep your redshirt" window. To redshirt, sit out entirely.
- **No separate medical redshirt category** — hardship/eligibility waivers fill the same role.

**Game decision:** model class year (FR/SO/JR/SR), seasons used (0–4), and semesters used (0–10). Redshirt = +1 semester, +0 seasons.

## Scholarships

- **12 full equivalencies** for baseball (verify; this has been the standard).
- **Pure equivalencies** — split however you want. No NAIA-wide minimum % per player (unlike old NCAA D1 rule).
- Academic eligibility is institutional (full-time enrollment, 24/36-hour rules, ~2.0 GPA progress).

**Game decision:** v2 budget system models 12 equivalencies as a scholarship pool. For v1 we abstract this — every player on the 35-man is assumed to be on some kind of aid; we don't track $.

## Recruiting

- **No NLI program in NAIA.** NAIA has its own Letter of Intent administered by conference + the financial-aid letter. Verbal commitments flip more often than NCAA.
- **No contact periods.** NAIA coaches can contact recruits effectively year-round (limited only by high-school federation rules on the recruit's side).
- **Official visits**: NAIA permits paid visits with little red tape, no national cap on visit count.

**Game decision:** model recruiting as week-by-week through the offseason with a fixed action budget (visits, calls, scout trips). Cycle ends in commitment, no NLI signing-day moment.

## Transfers

- **NAIA→NAIA:** written release historically required; one-year residency for non-released transfers; recent rule relaxation allows immediate eligibility for most. **VERIFY current bylaw.**
- **NAIA→NCAA** governed by NCAA. NAIA seasons count against NCAA eligibility.
- **JUCO→NAIA** is the dominant feeder. JUCO time uses the 10-semester clock.

**Game decision:** v1 includes transfer-portal-style inbound transfers each offseason. NAIA→NAIA transfers immediately eligible. JUCO transfers arrive with 0–2 seasons used.

## Season structure

- **55-game regular-season cap.** Typical schedule is weekend 3-game series (Fri DH + Sat, or Fri + Sat DH) plus midweek non-conference singles.
- **Conference tournaments**: most conferences run one; format varies (commonly 4–8 team double-elimination). Winning often grants the auto-bid.
- **NAIA Opening Round**: 40 teams in 10 four-team double-elim brackets at host sites. Winners advance.
- **Avista NAIA World Series**: 10 teams at Harris Field, Lewiston, ID. Late May / early June. Two five-team pools → championship game. (Verify current format.)

**Game decision:** 50–55 game regular season with weekend series + midweek games. Conference tournament + Opening Round + Avista World Series modeled at full fidelity.

## Eligibility quirks worth noting

- **COVID extra year** (spring-2020 cohort) is mostly aged out by 2025-26.
- **Mid-year enrollees** allowed, semester counts immediately.
- **International amateur competition can charge seasons** — surprise to many recruits.
- **Two-sport athletes** more common than D1.

## What's different about NAIA vs. NCAA for a sim

- **Budget realism.** Travel is bus-heavy and regional. Facilities investment matters more relatively.
- **Recruiting geography is regional.** ~300-mile radius + JUCO + international pipelines (Dominican, Venezuelan, Australian).
- **Roster turnover is high.** Partial-scholarship math + permissive transfers → 25–40% annual turnover is normal. Roster construction is closer to JUCO than D1.
- **Two-way players common.** Partial scholarships reward versatility.
- **Recruiting cadence is faster, less regulated.**
- **Postseason ceiling = Avista World Series.**

## Open questions for verification

1. Current scholarship cap (12 confirmed in training data, but NAIA reviews periodically)
2. Current NAIA→NAIA transfer residency rule
3. Current World Series bracket format
4. Whether there's a roster declaration deadline mid-season
