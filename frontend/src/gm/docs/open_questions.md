# Open Questions for Nate

Where my defaults are good, just say "defaults fine." Where I have a concrete recommendation, I've marked it 👉.

## What I built while you were out (just so you know)

1. **PNW data pass** — non-NAIA teams file (D1/D2/D3/NWAC PNW) at `data/non_naia_teams.json`. 22 NWAC teams, 7 PNW D1, 5 PNW D2, 9 PNW D3.
2. **Custom predictive ranking algorithm** (`docs/rankings.md`) — replaces NAIA RPI/BoChip. PEAR-style iterative SOS-adjusted three-pillar (offense / pitching / defense) with a global overall rating.
3. **Postseason design** (`docs/postseason.md`) — 46-team field, 30 auto-bids, 16 at-large selected by **our** rankings (not NAIA's). Opening Round → Avista NAIA WS at Lewiston.
4. **PA-level sim engine** + season loop. Two tiers — full PA-by-PA for your team's games, fast monte-carlo for the rest of the league.
5. **Schedule generator** — predetermined conference schedule (round-robin 3-game series across 10 conference weeks), open non-conf weeks for user to fill.
6. **Refocused NewDynasty to Bushnell-only** with mode picker (Traditional / Custom) and toggles for injuries / coach firing / portal / budget.
7. **Logo placeholder system** — circular monogram from initials in team colors. Drop-in replacement when real logos exist.
8. **Rankings, Standings, Schedule pages** + "Sim next week" button on Dashboard.
9. Game starts **summer 2026 offseason → fall ball → spring 2027 season** (matches your timing).
10. **PEAR data is live** — pulled from `https://pearatings.com/api/naia-cbase/stats?season=2026` (their JSON API), 208 teams with full offensive / pitching / fielding z-scores.

## Decisions I made for you (course-correct any of these)

- **Bushnell is locked as the only choice in v1.5**, architecture preserved for expansion. The 198 other schools are still in the world (as opponents).
- **PNW teams included as opponents:** all 9 PNW NAIA (Cascade Collegiate) + 22 NWAC JUCOs + 7 D1 + 5 D2 + 9 D3. Other 190 NAIA programs simulated in the background for ranking purposes.
- **2027 schedule auto-builds with conference round-robin** + 6 auto-filled non-conf games (regional opponents of similar strength). You can edit on the schedule page.
- **Save model: 3 slots per user, localStorage** keyed by Supabase id.
- **Default Traditional mode = HARD difficulty + injuries on + coach firing on**. Custom mode defaults to NORMAL + injuries on + no firing.
- **D1/D2/D3 non-conference scheduling UI hooks exist but aren't wired yet** — the data is there, the opponent picker currently only lists NAIA. Easy to flip on; flagged below.

## Blockers — your input genuinely needed

### Data + scope
- **Q-SCOPE-1:** PNW NAIA scope. I've assumed "PNW NAIA = Cascade Collegiate Conference" (BC, Bushnell, College of Idaho, Corban, Eastern Oregon, Lewis-Clark State, Oregon Tech, Warner Pacific). Should I add anyone outside Cascade? (e.g. Multnomah, Northwest University if they have programs)
- **Q-SCOPE-2:** Beyond PNW, when we expand, which region next? My lean is **California (Cal Pacific + GSAC)** since geographic adjacency, but you might prefer **Texas/SW** for talent density.

### Rankings + postseason
- **RK1:** SOS weight in the algorithm. 👉 **0.4** (meaningful but not dominant). Stronger weight = bigger penalty for weak conferences.
- **RK2:** Re-rank cadence — weekly during season, or only at checkpoints? 👉 **Weekly**.
- **RK3:** Should the pillar weights (offense + pitching + 0.5×defense) be user-tunable on the Rankings page? 👉 **Toggle for advanced users**.
- **PS1:** Auto-bid distribution — I have 30 across 21 conferences (top 9 conferences send 2). Are the right conferences sending 2? See `postseason.md`.
- **PS4:** Avista WS bracket format. NAIA uses two pool play groups → semis → final. 👉 **Use double-elim 10-team for v1**, switch to real pool format in v2.

### Scheduling
- **SCH1:** Default non-conference auto-fill — I picked **6 opponents** at random from similar-strength regional teams. Better: let user choose number? Default opponent strength preference? 👉 **6 games is reasonable; let user replace any of them on the Schedule page**.
- **SCH2:** Should D1/D2/D3/JUCO opponents be schedulable from day one or behind a toggle? 👉 **Day one** — they're a meaningful part of the real NAIA non-conference experience.
- **SCH3:** How exact are conference rivalries? Some NAIA conferences have travel partners or special weekend rivalry games. Default: pure round-robin. Adjust later if needed.

### Sim
- **SIM1:** Game pace. Currently PA-level sim is fast (~10ms/game on my mental model). Should there be a **play-by-play viewer** for your games, or just final score? 👉 **Final score + boxscore for v1.5**, PBP viewer later.
- **SIM2:** Pitcher rotation. I'm naively rotating after ~25 PAs. Should there be explicit **5-man rotation + bullpen depth chart** UI? 👉 **Yes for v2.0** (after the core loop works).
- **SIM3:** Doubleheaders + weekend series — currently I generate 3 games per series across Fri/Sat/Sun. NAIA reality has a lot of Fri+Sat DH then Sun single. Should I model this? 👉 **Yes** if you want true realism; defaults work for game play purposes.

### Logos
- **LOGO1:** Logo system works as monogram placeholder. For Bushnell + a handful of marquee programs, would you like real logo files? If you have them, drop into `frontend/public/gm/logos/{schoolId}.png` and I'll wire up the lookup.

### Game options
- **GO1:** Other game options worth adding? Current toggles: injuries, coach firing, portal, budget. Candidates I'm thinking about:
  - **Realistic injuries** vs **arcade injuries** (frequency knob)
  - **NIL on / off**
  - **Hot starts / dynasty rivals** — random "this year, school X is having a moment" events
  - **Coach lifespan** (retirement age)
  - **Conference realignment** (allow conferences to gain/lose members over time)

### Postseason quirks
- **PS6:** Conference tournament structure. I have **4-team double-elim for v1** for all conferences. NAIA conferences vary (4, 6, 8 teams). 👉 **Adjust per conference based on their size and `typicalNationalQualifiers`**.

## Less urgent but on my radar

- Recruiting board UI (the design doc is done; just need to build the UI)
- Practice/lift/meals (v2; hooks already declared in the engine)
- AP spending UI for actions other than recruiting (the engine supports it, no UI yet)
- Player development tick at end of season
- Transfer portal evaluation (engine designed, not wired)
- Schedule auto-fill should consider rest days between travel-heavy weekends
- Visualization / charts on the Rankings + Standings page
