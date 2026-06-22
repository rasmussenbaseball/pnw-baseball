# Rapsodo Pitch-Profiling Tool — Design & Plan

Coach/Scout Portal tool that ingests Rapsodo bullpen CSVs, builds multi-session
pitcher profiles, tracks development trends, and suggests arsenal improvements.

Status: design draft (2026-06-22). Not yet built.

---

## 1. Why build this (the opportunity)

Rapsodo gives a coach a *per-pitch spreadsheet* and some single-session PDF charts.
It does three things badly that we can do well:

1. **Trusts its own labels.** Rapsodo's auto pitch-type classification is noisy. In the
   two sample files, fastball-shaped pitches were labeled "Slider" and "ChangeUp," and
   72 mph lobs were labeled "Fastball." Any analysis built on the raw `Pitch Type`
   column inherits that garbage. **We re-classify from movement/velo/spin.**
2. **No memory.** Each CSV is a standalone session. Coaches can't see "is this kid's
   fastball carrying more than it did in October?" without manually diffing
   spreadsheets. **We persist sessions and trend them per player.**
3. **No interpretation.** Rapsodo shows numbers; it doesn't tell a 19-year-old that his
   fastball is sitting in the dead zone, or that his arsenal has no glove-side weapon.
   **We turn shapes into plain-English coaching.**

Plus device fragmentation (below) means even reading the CSVs correctly is non-trivial —
a normalization layer is itself a product advantage.

### Known Rapsodo shortcomings to caveat in-product
- **Seam-shifted wake (SSW):** Rapsodo *infers* movement from spin rather than measuring
  the whole flight, so it struggles with SSW pitches (elite sinkers, some changeups). The
  `SSW VB`/`SSW HB` columns only exist on the PRO 3.0 and are blank far more often than not.
  We treat SSW as an estimate, gate it on spin confidence, and never present it as truth.
- **Inferred vs measured break:** two Rapsodo units can disagree on the same sinker. We
  surface spin confidence and sample size, and never report a single pitch as gospel.
- **It's spin-first:** great at spin rate/axis/efficiency, weaker at true trajectory than
  Trackman/Hawkeye. Our copy should frame outputs as "shape tendencies," not physics truth.

---

## 2. What the two sample files taught us (data reality)

| | File 1 — Lucas Huynh | File 2 — Oliver Duthie |
|---|---|---|
| Device serial | `RCE20ZBKL06R` | `MTD-21114TA5334` (PRO 2.0) |
| `VB/HB (spin)` | **populated** | **blank (`-`)** |
| `Gyro Degree` | populated | populated |
| `Intent Type` | `-` (untagged) | `high_intent` (every pitch) |
| `Release Extension` | `0` | `-` |
| Handedness (inferred) | **RHP** (FB HB ≈ +14, arm side) | **LHP** (FB HB ≈ −18, arm side) |
| Session quality | casual — velo 65–91, lots of lobs | clean — max-effort, tight velo band |

**The headline finding: Rapsodo exports are heterogeneous.** Different device generations
and subscription tiers populate different columns. The two files don't even agree on which
break columns exist. **The ingestion layer must normalize to a common movement basis, not
assume a fixed schema.**

Concrete per-player reads (what the tool should automatically conclude):

- **Lucas (RHP):** True fastball cluster ≈ 89–91 mph, ~13" IVB / ~14.5" HB, tilt ~1:30,
  90–100% spin eff. That's a **textbook dead-zone fastball** (IVB ≈ HB, ~45° up-and-arm-side
  vector that hitters barrel). His secondaries are a soft ~74 mph slurve and an inconsistent
  arm-side change. Half the session is sub-80 mph and mislabeled — **flag as low-intent /
  unreliable** and analyze only the high-effort cluster.
- **Oliver (LHP):** Fastball ≈ 84–88 mph, 2000–2280 spin, 94–99% eff, tilt ~10:30, good
  arm-side ride. Changeup ≈ 74 mph, ~8.5" *less* IVB than the FB, same arm-side line —
  **a genuinely good, well-tunneled changeup.** "Cutter" ≈ 80 mph but barely cuts (HB ~ −3,
  near zero glove side). **Arsenal gap: no real glove-side or depth weapon** — recommend a
  gyro slider or sweeper.

Both reads are things a coach would pay for, and both are derivable from the CSV today.

### Per-pitch data-quality flags the parser must emit
- Rows where `Pitch Type` or break fields are `-` → failed read, drop from analysis.
- Rows with partial reads (velo present, spin/eff `-`) → keep velo, exclude from shape.
- `Spin Confidence` low (≤0.5) → down-weight; exclude from cluster centroids.
- Untagged / low-velo pitches in an otherwise high-velo session → likely warmup; segment out.

---

## 3. Column dictionary & normalization

Header rows: the real header is on CSV row 5 (rows 1–4 are blank + `Player ID:` / `Player
Name:`). Parser must skip to the `"No","Date",...` line.

Movement basis priority (pick the best available per row, record which we used):
1. `VB (spin)` / `HB (spin)` — Magnus-only, ≈ Statcast **IVB/HB**. **Preferred.**
2. `VB (trajectory)` / `HB (trajectory)` — total observed break (PRO 2.0 primary). Use when
   spin break is absent (Oliver). Tag the source so we don't compare spin-IVB to traj-IVB
   blindly across pitchers.
3. `SSW VB/HB` — residual estimate, display-only, never a primary axis.

Sign convention (critical): Rapsodo HB is a **fixed frame** — negative = breaks left,
positive = right — so it **flips by handedness**. Internally we normalize everything to
**arm-side-positive (pitcher's POV)** and store inferred handedness, or every left-hander
mislabels.

Handedness inference: classify the primary fastball cluster, read its HB sign in the raw
fixed frame → **positive ⇒ RHP, negative ⇒ LHP**. Cross-check with spin-direction clock
(RHP FB ~12–2:00, LHP FB ~10–12:00) and release-side sign.

Key derived fields:
- **Active/True spin** = total spin × spin efficiency (the part that makes movement).
- **Spin efficiency ↔ gyro degree** are inverses: `efficiency ≈ cos(gyro°)`. Verify against
  paired columns in real data.
- **Bauer Units** = spin ÷ velo (screening only; high BU on a tilted axis ≠ ride).
- **Tilt** from the spin-direction clock; convert to degrees for math, show as clock to coaches.
- `Intent Type` is a **user tag, not a measurement** — use only for session segmentation.

---

## 4. The analytics engine

### 4a. Pitch re-classification (do NOT trust `Pitch Type`)
Cluster a session's reliable pitches by velo + movement + spin eff + tilt, then label each
cluster from rules:

| Pitch | Spin eff | Gyro° | Shape signature |
|---|---|---|---|
| 4-seam (ride) | ≥90% | ~0–30 | high IVB (≥17 elite), tilt 12:00–12:30 |
| Sinker/2-seam | 60–90% | low | low IVB, ≥15–18" arm-side run, tilt ~3:00 |
| Cutter | 40–65% | moderate | ~7–10" IVB, small glove-side HB |
| Gyro slider | <10–20% | ~90 | ~0" IVB, near-zero HB |
| Sweeper | high | low | big glove-side sweep |
| Curveball | 50–80% | low | negative IVB (depth) + glove side |
| Changeup | varies | low | arm-side, ≥8" less IVB than FB, ~8–10 mph slower |

This is also where we tell a coach "the pitch you call a slider is really a cutter."

### 4b. Movement profile (the flagship visual)
HB (arm-side →) on x, IVB (ride ↑) on y, pitcher's POV. Each pitch = a cluster; cluster
*tightness* is itself a quality/consistency metric. Overlays: arm-slot-relative **dead zone**,
MLB/conference benchmark ghosts, and empty-quadrant gap callouts.

### 4c. Benchmarks
Hard-code MLB averages by pitch type as reference ghosts, but **compute our own NWBB/
conference percentiles** from collected sessions over time (don't hard-code college numbers —
they're program-specific and we'll have real data). Mirrors how `/percentiles` already works.

### 4d. Suggestion engine (rules, with caveats)
Each suggestion = trigger + plain-English coaching + confidence + a "pending command/feel"
caveat. Examples encoded directly from the research:

- **Dead-zone fastball** (IVB ≈ HB for the arm slot): "Your heater's ride and run cancel out
  — hitters see it flat. Either get on top for more carry (tilt → 12:30, raise IVB) or lean
  into a sinker (drop the axis to ~3:00, add run)."
- **No arm-side / no glove-side weapon** (all secondaries one direction): recommend the
  missing side (changeup/sinker, or sweeper/gyro slider).
- **FB↔SL non-separation** (close velo + movement, no spin mirror): tighten the slider to a
  harder gyro, or add a second breaker for a lower/wider shape.
- **Changeup not separating** (<6 mph gap or <8" IVB gap from FB): add velo gap / kill spin.
- **Mislabeled pitch** (cutter masquerading as slider, gyro ball as sweeper).
- **Spin-mirror opportunities** (FB↔CB ~180°, SL↔CH ~90°) for tunneling.
- **Flat-VAA + high-IVB + low slot** → "live at the top of the zone."

**Caveats baked in (the credibility layer):** shape ≠ pitch — command, grip feasibility
(pronator vs supinator), and arm health gate everything. Benchmarks are references, not
goals. The dead zone is arm-slot-relative, not absolute. Require adequate sample size before
concluding. Every suggestion is a *direction to explore with a pitching coach*, not a promise.

### 4e. Development trends (multi-session)
Per player, trend velo (mean + consistency), spin rate, **spin efficiency**, IVB/HB centroid
& spread, release std-dev (the tunneling/command metric), Bauer Units, VAA. Signal vs noise
guardrails: a sustained **+1–2 mph mean**, **5–10% efficiency**, or **2"+ IVB** shift that
holds across sessions is real; smaller is noise. Show confidence bands; suppress conclusions
on small samples. Flag "spin surging" as possibly grip/measurement artifact.

---

## 5. Product / UX

Lives in the Coach/Scout Portal at `/portal/rapsodo` behind `RequirePortalAccess`
(coach tier). Screens:

1. **Upload & review** — drag a session CSV, see matched players + per-pitch QC flags,
   confirm before saving. Mirrors the article-image upload pattern.
2. **Session view** — one bullpen: movement plot, re-classified arsenal table, auto-summary,
   data-quality banner (intent, confidence, sample size).
3. **Player profile** — the centerpiece. Aggregated arsenal across all sessions, movement
   plot with benchmark ghosts, arsenal grades, the suggestion list, and development trend
   charts. This is the "full profile for coaches" the project is really about.
4. **Roster hub** — list of pitchers with Rapsodo data, sortable by metrics, for scouting.

Charts: native SVG / Chart.js scatter (matches existing `PitchLevelStatsCard` movement plot
and `SprayChart`). Recharts for trend lines.

---

## 6. Architecture (mirror the TrackMan pipeline exactly)

The TrackMan pitch-shape pipeline is the proven analog — copy its patterns, don't reinvent.

- **DB:** three owner-scoped tables (column types modeled on `scripts/trackman/schema.sql`;
  apply SQL via Supabase, no migrations folder):
  - `rapsodo_players` — one row per `(owner_user_id, rapsodo_player_id)`: display name,
    inferred handedness, optional `team_id` tag, optional nullable `players_id` enrichment
    link. The coach's private roster.
  - `rapsodo_sessions` — one row per uploaded CSV: `owner_user_id`, `rapsodo_player_id`,
    session date, device serial + generation, intent tags, source filename, QC summary.
  - `rapsodo_pitches` — per-pitch grain (we re-cluster and trend, so no per-type aggregate):
    session FK plus the normalized fields `parse.py` already emits.
- **Ingestion:** `scripts/rapsodo/parse.py` already returns DB-ready dicts. Ingest just stamps
  `owner_user_id`, upserts the `rapsodo_players` row by Rapsodo id, and inserts session +
  pitches. **No fuzzy roster matching** (that was the TrackMan model; here the Rapsodo Player
  ID is the key). Optional: attempt a name match to `players` and store `players_id` if confident.
- **Upload endpoint:** `POST /portal/rapsodo/upload` (FastAPI `UploadFile`), pattern from
  `articles.py:565`. Resolve `owner_user_id` from the auth dependency → parse → QC → insert
  under that owner → return QC report. Optionally archive the raw CSV in Supabase Storage at
  `rapsodo/{user_id}/...` (same per-user path pattern as article images).
- **API:** new `rapsodo.py` router (register in `main.py`), tier `coach`, **every read
  filtered by `owner_user_id = current_user`**: `GET /rapsodo/players` (roster),
  `GET /rapsodo/players/{rapsodo_id}` (profile across sessions), `GET /rapsodo/sessions`,
  `GET /rapsodo/sessions/{id}`.
- **Frontend:** `RapsodoAnalyzer.jsx` page under `/portal/rapsodo` in `App.jsx`, wrapped in
  `RequirePortalAccess` + `PortalLayout`; data via `useApi()`.
- **DB access:** `from app.models.database import get_connection` (psycopg2, RealDictCursor).

### Tenancy & ownership (REVISED 2026-06-22 — this is a multi-tenant coaching tool)

This is **not** a "match Rapsodo players to our roster" feature. It is a private, per-coach
workspace: a coach (e.g. UBC) uploads their session files and sees breakdowns of *their*
players, whether or not those players exist in nwbaseballstats.com's database.

- **Ownership key = the uploader's Supabase user UUID** (the `user_favorites` / article
  `author_id` pattern). Every Rapsodo row carries `owner_user_id`. This works for *any* org,
  including ones not in our `teams` table (travel ball, out-of-region schools, private
  facilities). We do **not** key ownership off `teams.team_id`.
- **Player identity = Rapsodo's own `Player ID`, scoped to the owner.** Rapsodo assigns a
  stable per-player id (656225 Lucas, 934303 Oliver). A player is unique by
  `(owner_user_id, rapsodo_player_id)`. **No roster matching required** — the whole point is
  it works for players we've never heard of.
- **Optional team tag:** if the coach has set `user_profiles.affiliated_team_id`, stamp it on
  their sessions so a future "whole UBC staff shares one data pool" view is a small additive
  step (reads widen from `owner_user_id = me` to `OR team_id = my_affiliated_team`). Not
  required for v1.
- **Optional enrichment link:** if a Rapsodo player confidently name-matches a row in our
  `players` table, store a nullable `players_id` so we *can* surface their spring stats. Pure
  bonus; never a dependency, never blocks ingest.

Scope (DECIDED 2026-06-22): **v1 = data layer + movement plot first.** Parser → schema →
re-classification → movement profile → player profile. The suggestion engine (§4d) comes
after the data layer is trusted. Sharing is **private-to-uploader** in v1 (team-pool sharing
is the optional next step above).

---

## 7. Phased build plan

1. **Parser + normalizer** (standalone, testable on the two sample files): handle both device
   schemas, skip header rows, normalize movement basis, infer handedness, emit QC flags.
   Prove it against Lucas + Oliver.
2. **Schema + ingest script + manual upload of the two files** (local, dry-run first).
3. **Re-classification + movement profile + benchmarks** — get the flagship plot right.
4. **API + portal page** (session view first, then player profile).
5. **Suggestion engine** (start with 3–4 highest-confidence rules: dead zone, arsenal gap,
   mislabeled pitch, changeup separation).
6. **Multi-session trends.**
7. **Upload UI** for coaches to self-serve (vs. us running the script).

Ship value early: by step 4 a coach can already see a clean, re-classified movement plot —
better than Rapsodo's own output.

---

## 8. Open decisions (for Nate)

- **Players:** are these pitchers in `summer_players`, the spring `players` roster, both, or
  neither yet? Drives the linkage model. (Some may be recruits with no DB row.)
- **Who uploads:** coaches self-serve via the site, or Nate runs an ingest script and they
  just view? (Phase 7 vs. earlier.)
- **Scope of v1:** clean read + movement plot + profile first, and add the suggestion engine
  once the data layer is trusted? (Recommended.)
- **Visibility tier:** `coach` (portal) vs. `dev` while we validate, like TrackMan started.
