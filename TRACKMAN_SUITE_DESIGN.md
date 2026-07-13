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

## Phase 2 — Leaderboards + Player Lab (Trevor's ANALYZE section)

- Leaderboards: rank the roster by category (two-strike whiff%, Contact+,
  IVB, zone contact%, chase discipline) with minimum-sample gates.
- Player Lab: single-player deep dive — pitch movement plot (IVB × HB
  scatter by pitch type), location heatmaps by count, velo trends across
  sessions, per-session log.
- Confidence filter toggle (drop Low-confidence measurements, show data
  readiness % like the prototype).
- Roster linking: match "Last, First" + team code to our players table
  (reuse the Rapsodo link endpoint pattern) so suite data can surface on
  player profiles later.

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

## Related but separate

- `trackman_pitches` (existing table) is the PDF-vision pipeline for summer
  session reports → TrackManCard on profiles. Different source, different
  grain (aggregated). Do not merge; a later phase may reconcile.
- Rapsodo Lab handles bullpen-only Rapsodo CSVs. The suites stay separate
  (different devices, different columns), sharing UI patterns only.
