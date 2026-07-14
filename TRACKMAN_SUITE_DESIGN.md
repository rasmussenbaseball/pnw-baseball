# TrackMan Suite — Design & Roadmap

Coach-portal workspace for raw TrackMan game data. Coaches upload the CSVs
their TrackMan unit produces and the suite turns them into arsenals, contact
quality, leaderboards, and practice-planning answers.

Outline by intern Trevor Kazahaya (prototype: nwbb-trackman-suite.kaza5986.chatgpt.site,
July 2026). Data model validated against Bushnell's Hamlin SC corpus:
45 CSVs, Sept 2025 - Feb 2026, 12,623 rows → 10,504 unique pitches across
38 sessions (20 real games, 13 scrimmages, 5 BP).

## The data

TrackMan V3 game export: one CSV per session recording, 167 columns, one row
per pitch. Key groups:

| Group | Columns |
|---|---|
| Context | PitchNo, PA/PitchOfPA, Inning, Outs, Balls, Strikes, Pitcher/Batter/Catcher + ids + handedness + team codes |
| Tags & results | TaggedPitchType (human), AutoPitchType (TrackMan), PitchCall, KorBB, PlayResult, TaggedHitType |
| Pitch metrics | RelSpeed, SpinRate/Axis, Tilt, RelHeight/Side, Extension, VertBreak, InducedVertBreak, HorzBreak, PlateLoc, ZoneSpeed, VAA/HAA, EffectiveVelo |
| Batted ball | ExitSpeed, Angle, Direction, Distance, Bearing, HangTime, HitSpinRate |
| Catcher | ThrowSpeed, PopTime, ExchangeTime, TimeToBase |
| Confidence | Per-measurement High/Medium/Low (release, location, movement, hit launch/landing) |
| Physics | pfx, trajectory polynomial coefficients (NOT stored — stays in the file) |

Gotchas learned from the corpus:
- **Files duplicate.** Same GameID appears in re-downloads and split files.
  Dedupe on PitchUID (globally unique); sessions merge by GameID.
- **'Undefined' is TrackMan's null** for enums; blanks for unmeasured numbers.
- **Session types differ in shape.** BP files have no PitchCall/PlayResult/
  pitch tags and blank pitchers (machine); "Private" sessions are either real
  games (opponent team codes like GEO_FOX) or intrasquads (SIM_UNI).
- Names are "Last, First" with TrackMan's own player ids; team codes like
  BUS_BEA. Roster linking to our players table is a later phase (same
  pattern as Rapsodo's link flow).

## Architecture

Mirrors the Rapsodo Lab: private per-coach workspace, owner_user_id scoping
on every row and endpoint, coach tier gate.

- `backend/app/stats/trackman_parse.py` — CSV parsing, normalization, derived
  flags (is_in_zone / is_swing / is_whiff / is_contact / is_chase; zone =
  |side| ≤ 0.83 ft, 1.5-3.5 ft height), session-type classification.
- `backend/app/api/trackman_suite.py` — tables + endpoints.
  - `tm_sessions` (owner, game_id UNIQUE per owner, date, type, teams, counts)
  - `tm_pitches` (owner, session FK CASCADE, ~70 typed columns, UNIQUE(owner, pitch_uid))
- `frontend/src/pages/TrackmanSuite.jsx` — portal page at `/portal/trackman`.

## Phase 1 — SHIPPED (2026-07-13)

- Multi-file CSV upload with per-file report; PitchUID dedupe (re-upload safe).
- Session library: date, type badge (Game/Scrimmage/BP), matchup, pitch/BBE
  counts, delete.
- **Pitching**: per-pitcher arsenal — usage, velo/max, spin, IVB/HB, extension,
  zone%, whiff%, chase%, CSW%, EV against — with context filter
  (games / scrimmages / live / everything) and team filter.
- **Hitting**: per-batter EV, max EV, hard-hit% (90+ mph), whiff%, chase%,
  split live vs BP with the **transfer gap** (live HH% minus BP HH%) — the
  centerpiece of Trevor's outline.

## Phase 2 — SHIPPED (2026-07-13): Player Lab + Leaderboards

- **Player Lab** (`/trackman/pitchers/detail`): Savant-style pitcher deep
  dive. Percentile sliders (blue-red, dot with rank) computed against the
  coach's OWN corpus (every arm with 50+ pitches — "your league"), across
  velo / FB IVB / spin / extension / zone% / whiff% / chase% / CSW% / EV
  against. Movement plot (catcher's view, per-pitch dots + type-average
  markers), release-point plot, 5x5 location heatmaps per pitch type with
  the K-zone box, pitch-selection-by-count matrix (12 counts, top 2 types),
  per-session velocity trend lines. Reachable from any Pitching-tab card.
- **Leaderboards** (`/trackman/leaderboards`): 11 pitching categories
  (avg/max FB velo, FB IVB, spin, extension, whiff%, CSW%, zone%, chase%,
  2K whiff%, EV against) + 8 hitting (avg/max EV, hard-hit%, sweet-spot
  8-32°, zone contact%, whiff%, chase%, max distance), each with its own
  minimum-sample gate, side + context filters.

Still open from the original Phase 2 list (now Phase 2.5):
- Confidence filter toggle (drop Low-confidence rows, show readiness %).
- Roster linking to our players table (Rapsodo link-endpoint pattern).
- Hitter Lab (batter version of the deep dive: swing decisions by zone,
  contact heatmaps, spray from Direction/Bearing).

## Phase 3 — Session Review + Reports (Trevor's REVIEW section)

- Session Review: one session's story — box-score-ish summary, per-pitcher
  lines, notable BBEs, staff notes (highlights/concerns text fields).
- Coach Reports: exportable weekly summary (ReportActions PDF/PNG pattern,
  B&W mode with data-tone like the other portal reports).
- Catcher metrics view: pop times, exchange, throw speed (the data is
  already stored).

## Phase 4 — Coach decisions (Trevor's decision queue)

- Suggested "decisions" generated from data gaps (e.g. transfer-gap flags,
  usage vs whiff mismatches), staff approve/dismiss queue, approved
  decisions attach to reports. Needs product thought before building —
  revisit with Nate + Trevor after Phases 2-3 are in coaches' hands.

## Competitive reference — 6-4-3 Charts TrackMan SYNC (researched 2026-07-13)

What 6-4-3 offers (600+ programs), to meet or beat feature-by-feature:
Pitch Highlighter (location + BIP + discipline tables) · Pitcher Arsenal
(K-zone, movement, spin direction, release, extension vs height,
percentiles vs collegiate peers) · Zone Illustration (9-zone hitter
tendencies, 7 layout options) · All Sprays (filterable batted-ball charts)
· Game Replay · 3D Field Render (tunneling) · Pitch Sequencing (count
plinko, two-pitch combos, at/through-count wOBA) · Heatmaps (3 palettes;
swing, whiff, two-strike, batted-ball) · Catcher Defense (Framing+ on the
shadow zone) · Umpire Reports · Team Stats tables (PDF/CSV/XLS export) ·
Defensive Shift Model (xBA/xSLG/xwOBAcon vs configurations) · Models:
Stuff+, Command+, xRV+, Swing Decision, Bat Speed · National leaderboards
with split types + custom minimums · Saveable filters · Portable-unit
interfaces · Synergy video pairing.

Our edges to press: (1) their percentiles compare to national collegiate
peers, ours can ALSO grade within the coach's own corpus and, later,
against our PNW-wide scraped baselines per level (D1-NWAC) — a comparison
set 6-4-3 doesn't have; (2) the suite lives NEXT TO Series Planner /
Alignments / PBP scouting in one portal; (3) transfer-gap (BP vs game) is
a practice-planning answer SYNC doesn't lead with; (4) price.

Future tool ideas drawn from this research (post-Phase 3 candidates):
pitch sequencing view (count plinko + two-pitch combo outcomes), Stuff+/
Command+-style pitch grades trained on our corpus, catcher framing on the
shadow zone (we store PopTime/loc/call already), umpire zone reports,
spray charts from Direction/Bearing, saved-filter workspaces, PDF exports
via ReportActions (B&W data-tone convention).

## Related but separate

- `trackman_pitches` (existing table) is the PDF-vision pipeline for summer
  session reports → TrackManCard on profiles. Different source, different
  grain (aggregated). Do not merge; a later phase may reconcile.
- Rapsodo Lab handles bullpen-only Rapsodo CSVs. The suites stay separate
  (different devices, different columns), sharing UI patterns only.
