# NAIA Baseball GM — Design Docs

Foundation docs for v1.5. Each is a self-contained design pass with **OPEN QUESTIONS for Nate** at the end.

## **→ All open questions: [open_questions.md](./open_questions.md)** (single page)

## Read in this order

1. **[rules.md](./rules.md)** — real NAIA rules with confidence markers
2. **[attributes.md](./attributes.md)** — player rating model
3. **[school_resources.md](./school_resources.md)** — per-school tuition, scholarship pool, facilities
4. **[coaches.md](./coaches.md)** — head coach + assistants, salaries, attribute model
5. **[action_points.md](./action_points.md)** — the central week-to-week mechanic
6. **[recruiting.md](./recruiting.md)** — 3-pool recruiting + EA-style preferences + coach affinity
7. **[transfers.md](./transfers.md)** — outbound transfer mechanics (intra-conf forbidden)
8. **[sim.md](./sim.md)** — PA-level sim engine + two-tier season sim
9. **[rankings.md](./rankings.md)** *(new)* — predictive SOS-adjusted ranking algorithm (replaces NAIA RPI/BoChip)
10. **[postseason.md](./postseason.md)** *(new)* — 46-team field, auto + at-large by our rankings, Avista WS
11. **[calendar.md](./calendar.md)** — weekly tick. v2 hooks declared

## Resolved direction (latest)

- ✅ Game scope: **Bushnell only for v1.5**, PNW NAIA + NWAC + PNW D1/D2/D3 as opponents
- ✅ Game timing: starts **summer 2026 offseason → fall ball → spring 2027 season**
- ✅ PEAR data: **live via `pearatings.com/api/naia-cbase/stats`** (208 teams, full o/p/d z-scores)
- ✅ Custom predictive ranking algorithm (PEAR-style iterative SOS)
- ✅ NAIA playoff format: 46 teams, 30 auto-bids + 16 at-large **selected by our rankings, not RPI/BoChip**
- ✅ Schedule: conference predetermined; user fills non-conference (incl. D1/D2/D3/JUCO)
- ✅ Logo system: **monogram-from-initials placeholder** (real logo files drop-in later)
- ✅ Game modes: **Traditional** (hard, injuries on, coach firing on) and **Custom** (toggles)

## What's playable end-to-end right now

`/gm` (dynasty list) → `/gm/new` (Bushnell + mode + coach) → `/gm/dashboard` →
`/gm/roster`, `/gm/schedule`, `/gm/standings`, `/gm/rankings`. Sim next week from the
Dashboard or Schedule.

## What's in the repo right now

```
frontend/src/
  pages/gm/
    GMHome.jsx              Dynasty list w/ logos
    NewDynasty.jsx          4-step wizard: program → mode → coach → confirm
    Dashboard.jsx           Hub: school + AP + coach + next game + sim button
    Roster.jsx              35-man roster table, position filters
    Schedule.jsx            Schedule + sim + opponent picker (NAIA/D1/D2/D3/NWAC)
    Standings.jsx           Conference standings
    Rankings.jsx            National top-N by overall/offense/pitching/defense/SOS
  gm/
    docs/                   ← you are here
    engine/
      types.js              JSDoc type definitions
      rng.js                seeded mulberry32 PRNG
      names.js              first/last name pools
      loadSchools.js        schools.json + PEAR + tier heuristics → hydrated Schools
      coaches.js            staff generator
      generate.js           35-man roster generator
      save.js               localStorage I/O (3 slots, versioned)
      newDynasty.js         world bootstrap + schedule + initial AP/budget
      rankings.js           predictive SOS-adjusted ranking
      schedule.js           conference round-robin + non-conf scheduler
      sim.js                PA-level + fast sim
      season.js             weekly sim loop (handles non-NAIA opponents)
    data/
      schools.json          199 NAIA programs / 21 conferences
      pear_ratings_2026.json  208 NAIA teams from PEAR JSON API
      juco_teams.json       130 real JUCO team names
      non_naia_teams.json   PNW D1/D2/D3/NWAC for non-conf scheduling
    components/
      TeamLogo.jsx          Monogram-from-initials logo placeholder
```

Plus:
- `App.jsx` — all `/gm/*` routes wired
- `Header.jsx` — "GM" nav entry
- Branch: `gm-v1` (uncommitted)
- Build: passing (`npm run build` → 984 modules, exit 0)

## Implementation map — what's done, what's next

**Done:**
1. ✅ Types in `engine/types.js`
2. ✅ Seeded PRNG (`engine/rng.js`)
3. ✅ PEAR + schools loader + tier heuristics
4. ✅ Name pools + coach generator
5. ✅ Player generator (35-man rosters)
6. ✅ Save manager (3 slots)
7. ✅ New Dynasty wizard (Bushnell + modes)
8. ✅ Roster page
9. ✅ Schedule generator + Schedule page + opponent picker (NAIA + D1/D2/D3/NWAC)
10. ✅ PA-level sim + fast sim
11. ✅ Season loop + sim-next-week button
12. ✅ Predictive ranking algorithm + Rankings page
13. ✅ Standings page
14. ✅ Logo placeholder system

**Next big chunks:**
15. Recruit pool generator (HS + JUCO from `juco_teams.json` + portal)
16. Recruiting page + AP / scholarship $ widget
17. End-of-season transfer evaluation + Retention Watch
18. Practice / lift / meals AP-spend UIs
19. Postseason simulator (Opening Round + Avista WS bracket)
20. Player stat tracking (per-PA accumulation, not just team-level)
21. Coach turnover events (HC poached, assistants leave)
22. Pitcher rotation + bullpen depth chart UI
23. Game play-by-play viewer
24. Real logo files for marquee programs
