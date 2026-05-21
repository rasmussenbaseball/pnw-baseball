/**
 * Shared tournament-bracket data and resolution logic.
 *
 * Extracted from TournamentBracketGraphic.jsx so both the canvas graphic
 * (graphics page) and the interactive homepage bracket can use the same
 * tournament definitions and the same DB-score resolution. Canvas-only
 * concerns (palette, image cache, renderer) stay in the graphic component.
 */

const API_BASE = '/api/v1'

export const TOURNAMENTS = {
  ccc_2026: {
    label: 'CCC Tournament',
    sub: 'May 1 to 4, Lewis-Clark State',
    season: 2026,
    formatLabel: 'Double-elimination bracket',
    seeds: [
      { seed: 1, team_id: 22,   name: 'Lewis-Clark State' },
      { seed: 2, team_id: 5720, name: 'British Columbia' },
      { seed: 3, team_id: 21,   name: 'College of Idaho' },
      { seed: 4, team_id: 24,   name: 'Bushnell' },
      { seed: 5, team_id: 20,   name: 'Oregon Tech' },
    ],
    games: [
      { num: 1, iso: '2026-05-01', day: 'Fri May 1', time: '11:00 AM', home: { ref: 'seed', val: 4 },     away: { ref: 'seed', val: 5 } },
      { num: 2, iso: '2026-05-01', day: 'Fri May 1', time: '2:30 PM',  home: { ref: 'seed', val: 2 },     away: { ref: 'seed', val: 3 } },
      { num: 3, iso: '2026-05-01', day: 'Fri May 1', time: '6:00 PM',  home: { ref: 'seed', val: 1 },     away: { ref: 'winner', game: 1 } },
      { num: 4, iso: '2026-05-02', day: 'Sat May 2', time: '11:00 AM', home: { ref: 'loser',  game: 1 },  away: { ref: 'loser',  game: 2 } },
      { num: 5, iso: '2026-05-02', day: 'Sat May 2', time: '2:30 PM',  home: { ref: 'winner', game: 2 },  away: { ref: 'winner', game: 3 } },
      { num: 6, iso: '2026-05-02', day: 'Sat May 2', time: '6:00 PM',  home: { ref: 'loser',  game: 3 },  away: { ref: 'winner', game: 4 } },
      { num: 7, iso: '2026-05-03', day: 'Sun May 3', time: '11:00 AM', home: { ref: 'winner', game: 6 },  away: { ref: 'loser',  game: 5 } },
      { num: 8, iso: '2026-05-03', day: 'Sun May 3', time: '2:30 PM',  home: { ref: 'winner', game: 7 },  away: { ref: 'winner', game: 5 } },
      { num: 9, iso: '2026-05-04', day: 'Mon May 4', time: '11:00 AM', home: { ref: 'winner', game: 7 },  away: { ref: 'winner', game: 5 }, ifNecessary: true },
    ],
    // CCC layout — 4 columns wide:
    //   Col 1: G1 (WB R1 play-in)         + G4 (LB R1)
    //   Col 2: G2, G3 (WB R2 / QF byes)   + G6 (LB R2)
    //   Col 3: G5 (WB Final)              + G7 (LB Final)
    //   Col 4: G8 + G9 (Championship)
    layout: {
      1: { x: 60,   y: 400, w: 380, h: 120 },
      2: { x: 500,  y: 240, w: 380, h: 120 },
      3: { x: 500,  y: 400, w: 380, h: 120 },
      5: { x: 940,  y: 320, w: 380, h: 120 },
      8: { x: 1380, y: 540, w: 380, h: 130 },
      9: { x: 1380, y: 685, w: 380, h: 40  },
      4: { x: 60,   y: 720, w: 380, h: 120 },
      6: { x: 500,  y: 760, w: 380, h: 120 },
      7: { x: 940,  y: 800, w: 380, h: 120 },
    },
    connections: [
      { from: 1, to: 3 },
      { from: 2, to: 5 },
      { from: 3, to: 5 },
      { from: 5, to: 8 },
      { from: 4, to: 6 },
      { from: 6, to: 7 },
      { from: 7, to: 8 },
    ],
    sectionLabels: [
      { text: "WINNER'S BRACKET", x: 60,   y: 210, w: 1000 },
      { text: "CHAMPIONSHIP",     x: 1380, y: 510, w: 380, centered: true },
      { text: "LOSER'S BRACKET",  x: 60,   y: 690, w: 1000 },
    ],
    championshipGames: [8],
  },
  nwc_2026: {
    label: 'NWC Tournament',
    sub: 'May 8 — Paul Merkel Field, Spokane (Whitworth)',
    season: 2026,
    formatLabel: 'Single-elimination tournament — all games at #1 seed',
    seeds: [
      { seed: 1, team_id: 13, name: 'Whitworth' },
      { seed: 2, team_id: 14, name: 'Linfield' },
      { seed: 3, team_id: 15, name: 'Lewis & Clark' },
      { seed: 4, team_id: 10, name: 'Puget Sound' },
    ],
    games: [
      { num: 1, iso: '2026-05-08', day: 'Fri May 8', time: '9:30 AM',
        home: { ref: 'seed', val: 2 }, away: { ref: 'seed', val: 3 } },
      { num: 2, iso: '2026-05-08', day: 'Fri May 8', time: '12:30 PM',
        home: { ref: 'seed', val: 1 }, away: { ref: 'seed', val: 4 } },
      { num: 3, iso: '2026-05-08', day: 'Fri May 8', time: '3:30 PM',
        home: { ref: 'winner', game: 1 }, away: { ref: 'winner', game: 2 } },
    ],
    // NWC 2026 layout — single-elimination, 3 games. Two semis on left,
    // championship on right.
    layout: {
      1: { x: 250, y: 360, w: 480, h: 150 },   // semi 1: #2 vs #3
      2: { x: 250, y: 580, w: 480, h: 150 },   // semi 2: #1 vs #4
      3: { x: 1100, y: 470, w: 520, h: 160 },  // championship
    },
    connections: [
      { from: 1, to: 3 },
      { from: 2, to: 3 },
    ],
    sectionLabels: [
      { text: 'SEMIFINALS', x: 250,  y: 320, w: 480 },
      { text: 'CHAMPIONSHIP', x: 1100, y: 430, w: 520, centered: true },
    ],
    championshipGames: [3],
  },
  gnac_2026: {
    label: 'GNAC Tournament',
    sub: 'May 7 to 8, Vail Field — Nampa, ID',
    season: 2026,
    formatLabel: 'Round-robin format · Day 2 schedule depends on Day 1 results',
    seeds: [
      { seed: 1, team_id: 9, name: 'Northwest Nazarene' },
      { seed: 2, team_id: 7, name: 'Montana State Billings' },
      { seed: 3, team_id: 8, name: 'Western Oregon' },
    ],
    games: [
      // Day 1 — fixed round-robin matchups
      { num: 1, iso: '2026-05-07', day: 'Thu May 7', time: '1:00 PM',
        home: { ref: 'seed', val: 2 }, away: { ref: 'seed', val: 3 } },
      { num: 2, iso: '2026-05-07', day: 'Thu May 7', time: '4:00 PM',
        home: { ref: 'seed', val: 1 }, away: { ref: 'seed', val: 3 } },
      { num: 3, iso: '2026-05-07', day: 'Thu May 7', time: '7:00 PM',
        home: { ref: 'seed', val: 1 }, away: { ref: 'seed', val: 2 } },
      // Day 2 scenario A: 1-1-1 three-way tie
      // Internal nums 4 + 5; rendered as 'G4' / 'G5'.
      { num: 4, iso: '2026-05-08', day: 'Fri May 8', time: '3:00 PM',
        displayLabel: 'G4',
        home: { ref: 'seed', val: 2 }, away: { ref: 'seed', val: 3 } },
      { num: 5, iso: '2026-05-08', day: 'Fri May 8', time: '6:00 PM',
        displayLabel: 'G5',
        home: { ref: 'seed', val: 1 }, away: { ref: 'winner', game: 4 } },
      // Day 2 scenario B: one team finishes 2-0
      // Internal nums 6 + 7; both rendered as 'G4' / 'G5'.
      // Teams aren't known in advance so they use placeholder refs.
      { num: 6, iso: '2026-05-08', day: 'Fri May 8', time: '3:00 PM',
        displayLabel: 'G4',
        home: { ref: 'placeholder', name: '2-0 Team' },
        away: { ref: 'placeholder', name: '1-1 Team' } },
      { num: 7, iso: '2026-05-08', day: 'Fri May 8', time: '~6:30 PM',
        displayLabel: 'G5',
        home: { ref: 'placeholder', name: '2-0 Team' },
        away: { ref: 'placeholder', name: '1-1 Team' },
        ifNecessary: true },
    ],
    // GNAC layout — fundamentally different shape than a bracket.
    // Top row: three Day 1 round-robin tiles spanning the full canvas.
    // Bottom: two scenario panels side by side, each with G4 + G5.
    layout: {
      // Day 1 (top row, 3 games across)
      1: { x: 80,   y: 320, w: 540, h: 150 },
      2: { x: 690,  y: 320, w: 540, h: 150 },
      3: { x: 1300, y: 320, w: 540, h: 150 },
      // Scenario A — left panel (1-1-1 tie path)
      4: { x: 100, y: 620, w: 800, h: 140 },
      5: { x: 100, y: 800, w: 800, h: 140 },
      // Scenario B — right panel (one team at 2-0 path)
      6: { x: 1020, y: 620, w: 800, h: 140 },
      7: { x: 1020, y: 800, w: 800, h: 40  },
    },
    // Round-robin format has no bracket lines. Scenario A's G5 is "Winner
    // of G4 vs #1", which the team-name resolver handles via the 'winner'
    // ref — no line needed.
    connections: [],
    sectionLabels: [
      { text: 'DAY 1 — ROUND ROBIN — THU MAY 7', x: 0, y: 290, w: CANVAS_W, centered: true },
      { text: 'IF THREE-WAY TIE (1-1-1) AFTER DAY 1', x: 100,  y: 590, w: 800, centered: true },
      { text: 'IF ONE TEAM AT 2-0 AFTER DAY 1',       x: 1020, y: 590, w: 800, centered: true },
    ],
    championshipGames: [5, 6],
  },

  // ───────────────────────────────────────────────────────────────
  // NWAC SUPER REGIONALS — May 15 to 16, 2026
  //
  // Four super regionals, each hosted by the #2 seed of a conference.
  // Each has 3 teams: the #2 host (bye to the BO3 final) plus two
  // teams that play a single-elim play-in (one #3 and one #4 from
  // different conferences). Winners advance to the NWAC Championships.
  //
  // The #1 seed from each conference (N1, S1, E1, W1) gets a direct bye
  // to the championships and is shown in the byes strip at the top.
  //
  // Note: NWAC posted the play-in box scores on a URL that our
  // GH-Action scraper doesn't traverse, so those four games aren't in
  // our DB. The play-in cards use a `fallbackResult` field with scores
  // read from the official 2026 NWAC Super Regional bracket PDF.
  //
  // 2026 results: all 4 #2 hosts swept the BO3 finals 2-0; play-in
  // winners (S3 Umpqua, N4 Shoreline, S4 Mt. Hood, N3 Bellevue) lost.
  // ───────────────────────────────────────────────────────────────
  nwac_super_regionals_2026: {
    label: 'NWAC Super Regionals',
    sub: 'May 15 to 16, 2026 — Four regional host sites',
    season: 2026,
    formatLabel: 'Single-elim play-in then Best-of-3 series at each host',
    seeds: [
      // North conference
      { seed: 1,  seedLabel: 'N1', team_id: 28, name: 'Everett' },
      { seed: 2,  seedLabel: 'N2', team_id: 27, name: 'Edmonds' },
      { seed: 3,  seedLabel: 'N3', team_id: 25, name: 'Bellevue' },
      { seed: 4,  seedLabel: 'N4', team_id: 31, name: 'Shoreline' },
      // South conference
      { seed: 5,  seedLabel: 'S1', team_id: 44, name: 'Linn-Benton' },
      { seed: 6,  seedLabel: 'S2', team_id: 43, name: 'Lane' },
      { seed: 7,  seedLabel: 'S3', team_id: 47, name: 'Umpqua' },
      { seed: 8,  seedLabel: 'S4', team_id: 45, name: 'Mt. Hood' },
      // East conference
      { seed: 9,  seedLabel: 'E1', team_id: 35, name: 'Spokane' },
      { seed: 10, seedLabel: 'E2', team_id: 38, name: 'Wenatchee Valley' },
      { seed: 11, seedLabel: 'E3', team_id: 34, name: 'Columbia Basin' },
      { seed: 12, seedLabel: 'E4', team_id: 39, name: 'Yakima Valley' },
      // West conference
      { seed: 13, seedLabel: 'W1', team_id: 52, name: 'Lower Columbia' },
      { seed: 14, seedLabel: 'W2', team_id: 30, name: 'Pierce' },
      { seed: 15, seedLabel: 'W3', team_id: 53, name: 'Tacoma' },
      { seed: 16, seedLabel: 'W4', team_id: 49, name: 'Clark' },
    ],
    games: [
      // 4 rows, 3 cards each: Play-in (single elim) → BO3 G1 → BO3 G2.
      // Play-ins are hardcoded via fallbackResult since their box scores
      // aren't in our DB.
      // ─ NORTH @ Edmonds: Umpqua advances, Edmonds wins BO3 2-0 ─
      { num: 1, iso: '2026-05-15', day: 'Fri May 15', time: 'Play-in · 12:00 PM',
        home: { ref: 'seed', val: 7 }, away: { ref: 'seed', val: 16 },
        fallbackResult: { home_score: 5, away_score: 0 } },             // S3 Umpqua 5, W4 Clark 0
      { num: 2, iso: '2026-05-15', day: 'Fri May 15', time: 'BO3 Game 1',
        home: { ref: 'seed', val: 2 }, away: { ref: 'seed', val: 7 } },  // resolves from DB
      { num: 3, iso: '2026-05-16', day: 'Sat May 16', time: 'BO3 Game 2',
        home: { ref: 'seed', val: 2 }, away: { ref: 'seed', val: 7 } },

      // ─ EAST @ Wenatchee Valley: Shoreline advances, Wenatchee wins BO3 2-0 ─
      { num: 4, iso: '2026-05-15', day: 'Fri May 15', time: 'Play-in · 1:00 PM',
        home: { ref: 'seed', val: 4 }, away: { ref: 'seed', val: 15 },
        fallbackResult: { home_score: 12, away_score: 5 } },            // N4 Shoreline 12, W3 Tacoma 5
      { num: 5, iso: '2026-05-15', day: 'Fri May 15', time: 'BO3 Game 1',
        home: { ref: 'seed', val: 10 }, away: { ref: 'seed', val: 4 } },
      { num: 6, iso: '2026-05-16', day: 'Sat May 16', time: 'BO3 Game 2',
        home: { ref: 'seed', val: 10 }, away: { ref: 'seed', val: 4 } },

      // ─ WEST @ Pierce: Mt. Hood advances (F/11), Pierce wins BO3 2-0 ─
      { num: 7, iso: '2026-05-15', day: 'Fri May 15', time: 'Play-in · 12:00 PM',
        home: { ref: 'seed', val: 8 }, away: { ref: 'seed', val: 11 },
        fallbackResult: { home_score: 5, away_score: 4 } },             // S4 Mt. Hood 5, E3 Columbia Basin 4 (F/11)
      { num: 8, iso: '2026-05-15', day: 'Fri May 15', time: 'BO3 Game 1',
        home: { ref: 'seed', val: 14 }, away: { ref: 'seed', val: 8 } },
      { num: 9, iso: '2026-05-16', day: 'Sat May 16', time: 'BO3 Game 2',
        home: { ref: 'seed', val: 14 }, away: { ref: 'seed', val: 8 } },

      // ─ SOUTH @ Lane: Bellevue advances, Lane wins BO3 2-0 ─
      { num: 10, iso: '2026-05-15', day: 'Fri May 15', time: 'Play-in · 12:00 PM',
        home: { ref: 'seed', val: 3 }, away: { ref: 'seed', val: 12 },
        fallbackResult: { home_score: 12, away_score: 8 } },            // N3 Bellevue 12, E4 Yakima Valley 8
      { num: 11, iso: '2026-05-15', day: 'Fri May 15', time: 'BO3 Game 1',
        home: { ref: 'seed', val: 6 }, away: { ref: 'seed', val: 3 } },
      { num: 12, iso: '2026-05-16', day: 'Sat May 16', time: 'BO3 Game 2',
        home: { ref: 'seed', val: 6 }, away: { ref: 'seed', val: 3 } },
    ],
    // 4 rows × 3 cards layout. Each row is one super regional. Cards are
    // 480w × 130h, x-positions 100 / 610 / 1120, gap 30. Row pitch 200.
    layout: {
      // Row 1: North @ Edmonds
      1: { x: 100,  y: 270, w: 480, h: 130 },
      2: { x: 610,  y: 270, w: 480, h: 130 },
      3: { x: 1120, y: 270, w: 480, h: 130 },
      // Row 2: East @ Wenatchee Valley
      4: { x: 100,  y: 470, w: 480, h: 130 },
      5: { x: 610,  y: 470, w: 480, h: 130 },
      6: { x: 1120, y: 470, w: 480, h: 130 },
      // Row 3: West @ Pierce
      7: { x: 100,  y: 670, w: 480, h: 130 },
      8: { x: 610,  y: 670, w: 480, h: 130 },
      9: { x: 1120, y: 670, w: 480, h: 130 },
      // Row 4: South @ Lane
      10: { x: 100,  y: 870, w: 480, h: 130 },
      11: { x: 610,  y: 870, w: 480, h: 130 },
      12: { x: 1120, y: 870, w: 480, h: 130 },
    },
    connections: [
      // Each regional: Play-in → BO3 G1 → BO3 G2
      { from: 1, to: 2 },   { from: 2, to: 3 },
      { from: 4, to: 5 },   { from: 5, to: 6 },
      { from: 7, to: 8 },   { from: 8, to: 9 },
      { from: 10, to: 11 }, { from: 11, to: 12 },
    ],
    sectionLabels: [
      // Byes strip
      { text: 'AUTO-ADVANCED TO CHAMPIONSHIPS:  N1 EVERETT  ·  S1 LINN-BENTON  ·  E1 SPOKANE  ·  W1 LOWER COLUMBIA',
        x: 0, y: 220, w: CANVAS_W, centered: true },
      // Per-row headers (one per regional)
      { text: 'NORTH SUPER REGIONAL — @ EDMONDS  ·  Edmonds advances',
        x: 100, y: 245, w: 1500, centered: false },
      { text: 'EAST SUPER REGIONAL — @ WENATCHEE VALLEY  ·  Wenatchee Valley advances',
        x: 100, y: 445, w: 1500, centered: false },
      { text: 'WEST SUPER REGIONAL — @ PIERCE  ·  Pierce advances',
        x: 100, y: 645, w: 1500, centered: false },
      { text: 'SOUTH SUPER REGIONAL — @ LANE  ·  Lane advances',
        x: 100, y: 845, w: 1500, centered: false },
    ],
    championshipGames: [3, 6, 9, 12],  // The deciding (BO3 G2) cards get gold
  },

  // ───────────────────────────────────────────────────────────────
  // NWAC CHAMPIONSHIPS — May 21 to 25, 2026 @ Lower Columbia
  //
  // Eight-team double elimination. The four #1 seeds (one per conference)
  // get byes through super regionals and enter here directly; their
  // round-1 opponents are the four super regional winners. Super regional
  // winners are placeholders until those games complete.
  // ───────────────────────────────────────────────────────────────
  nwac_championships_2026: {
    label: 'NWAC Championships',
    sub: 'May 21 to 25, 2026 — Lower Columbia College, Longview, WA',
    season: 2026,
    formatLabel: 'Double-elimination bracket (8 teams)',
    seeds: [
      // Top half: the four conference #1 seeds (received byes through SR)
      { seed: 1, seedLabel: 'N1',  team_id: 28, name: 'Everett' },
      { seed: 2, seedLabel: 'S1',  team_id: 44, name: 'Linn-Benton' },
      { seed: 3, seedLabel: 'E1',  team_id: 35, name: 'Spokane' },
      { seed: 4, seedLabel: 'W1',  team_id: 52, name: 'Lower Columbia' },
      // Bottom half: the four Super Regional winners (all #2 hosts, swept 2-0)
      { seed: 5, seedLabel: 'WSR', team_id: 30, name: 'Pierce' },
      { seed: 6, seedLabel: 'ESR', team_id: 38, name: 'Wenatchee Valley' },
      { seed: 7, seedLabel: 'SSR', team_id: 43, name: 'Lane' },
      { seed: 8, seedLabel: 'NSR', team_id: 27, name: 'Edmonds' },
    ],
    games: [
      // ── WB Round 1 (Thu May 21) — #1 seeds vs SR winners ──
      { num: 1, iso: '2026-05-21', day: 'Thu May 21', time: '9:35 AM',
        home: { ref: 'seed', val: 1 }, away: { ref: 'seed', val: 5 } },  // N1 vs WSR
      { num: 2, iso: '2026-05-21', day: 'Thu May 21', time: '12:35 PM',
        home: { ref: 'seed', val: 2 }, away: { ref: 'seed', val: 6 } },  // S1 vs ESR
      { num: 3, iso: '2026-05-21', day: 'Thu May 21', time: '4:35 PM',
        home: { ref: 'seed', val: 3 }, away: { ref: 'seed', val: 7 } },  // E1 vs SSR
      { num: 4, iso: '2026-05-21', day: 'Thu May 21', time: '7:35 PM',
        home: { ref: 'seed', val: 4 }, away: { ref: 'seed', val: 8 } },  // W1 vs NSR
      // ── LB Round 1 (Fri May 22) — losers of WB R1 ──
      { num: 5, iso: '2026-05-22', day: 'Fri May 22', time: '9:35 AM',
        home: { ref: 'loser', game: 1 }, away: { ref: 'loser', game: 2 } },
      { num: 6, iso: '2026-05-22', day: 'Fri May 22', time: '12:35 PM',
        home: { ref: 'loser', game: 3 }, away: { ref: 'loser', game: 4 } },
      // ── WB Round 2 (Fri May 22) ──
      { num: 7, iso: '2026-05-22', day: 'Fri May 22', time: '4:35 PM',
        home: { ref: 'winner', game: 1 }, away: { ref: 'winner', game: 2 } },
      { num: 8, iso: '2026-05-22', day: 'Fri May 22', time: '7:35 PM',
        home: { ref: 'winner', game: 3 }, away: { ref: 'winner', game: 4 } },
      // ── LB Round 2 (Sat May 23) ──
      { num: 9,  iso: '2026-05-23', day: 'Sat May 23', time: '11:00 AM',
        home: { ref: 'winner', game: 5 }, away: { ref: 'loser', game: 7 } },
      { num: 10, iso: '2026-05-23', day: 'Sat May 23', time: '2:00 PM',
        home: { ref: 'winner', game: 6 }, away: { ref: 'loser', game: 8 } },
      // ── WB Final (Sat May 23) ──
      { num: 11, iso: '2026-05-23', day: 'Sat May 23', time: '5:35 PM',
        home: { ref: 'winner', game: 7 }, away: { ref: 'winner', game: 8 } },
      // ── LB Round 3 (Sun May 24) — default pairing per NWAC rules ──
      { num: 12, iso: '2026-05-24', day: 'Sun May 24', time: '12:00 PM',
        home: { ref: 'winner', game: 9 }, away: { ref: 'loser', game: 11 } },
      // ── LB Final (Sun May 24) ──
      { num: 13, iso: '2026-05-24', day: 'Sun May 24', time: '4:05 PM',
        home: { ref: 'winner', game: 10 }, away: { ref: 'winner', game: 12 } },
      // ── Championship Final (Sun May 24) ──
      { num: 14, iso: '2026-05-24', day: 'Sun May 24', time: '7:30 PM',
        home: { ref: 'winner', game: 11 }, away: { ref: 'winner', game: 13 } },
      // ── If Necessary (Mon May 25) ──
      { num: 15, iso: '2026-05-25', day: 'Mon May 25', time: '3:35 PM',
        home: { ref: 'winner', game: 11 }, away: { ref: 'winner', game: 13 },
        ifNecessary: true },
    ],
    layout: {
      // ── Winner's Bracket (top half) ──
      // Col 1 — WB R1, 4 cards stacked
      1: { x: 60,   y: 240, w: 320, h: 78 },
      2: { x: 60,   y: 326, w: 320, h: 78 },
      3: { x: 60,   y: 412, w: 320, h: 78 },
      4: { x: 60,   y: 498, w: 320, h: 78 },
      // Col 2 — WB R2, 2 cards (positioned between feeders)
      7: { x: 430,  y: 283, w: 320, h: 78 },
      8: { x: 430,  y: 455, w: 320, h: 78 },
      // Col 3 — WB Final
      11: { x: 800, y: 369, w: 320, h: 78 },
      // Col 4 — Championship + If Necessary
      14: { x: 1480, y: 369, w: 360, h: 90 },
      15: { x: 1480, y: 475, w: 360, h: 34 },
      // ── Loser's Bracket (bottom half) ──
      // Col 1 — LB R1 (2 cards)
      5: { x: 60,   y: 660, w: 320, h: 78 },
      6: { x: 60,   y: 758, w: 320, h: 78 },
      // Col 2 — LB R2 (2 cards)
      9:  { x: 430, y: 660, w: 320, h: 78 },
      10: { x: 430, y: 758, w: 320, h: 78 },
      // Col 3 — LB R3
      12: { x: 800, y: 709, w: 320, h: 78 },
      // Col 4 — LB Final
      13: { x: 1170, y: 709, w: 320, h: 78 },
    },
    connections: [
      // WB
      { from: 1, to: 7 },
      { from: 2, to: 7 },
      { from: 3, to: 8 },
      { from: 4, to: 8 },
      { from: 7, to: 11 },
      { from: 8, to: 11 },
      { from: 11, to: 14 },
      // LB
      { from: 5, to: 9 },
      { from: 6, to: 10 },
      { from: 9, to: 12 },
      { from: 12, to: 13 },
      { from: 10, to: 13 },
      { from: 13, to: 14 },
    ],
    sectionLabels: [
      { text: "WINNER'S BRACKET", x: 60, y: 220, w: 1100 },
      { text: "LOSER'S BRACKET",  x: 60, y: 640, w: 1100 },
      { text: 'CHAMPIONSHIP',     x: 1480, y: 340, w: 360, centered: true },
    ],
    championshipGames: [14],
  },

  // ───────────────────────────────────────────────────────────────
  // NWAC FULL PLAYOFF BRACKET — combined super regionals + championships
  //
  // Compact view: super regional column on the far left feeds into the
  // championship bracket on the right. Tightest layout of the three.
  // ───────────────────────────────────────────────────────────────
  nwac_full_2026: {
    label: 'NWAC Playoff Bracket',
    sub: 'May 15 to 25, 2026 — Super Regionals → Championships',
    season: 2026,
    formatLabel: 'Super regionals at four host sites → 8-team double elim at Lower Columbia',
    // The compact bracket uses shortened display names for teams whose full
    // names would overflow narrow cards. The standalone super-regionals and
    // championships brackets keep the full names.
    seeds: [
      { seed: 1,  seedLabel: 'N1', team_id: 28, name: 'Everett' },
      { seed: 2,  seedLabel: 'N2', team_id: 27, name: 'Edmonds' },
      { seed: 3,  seedLabel: 'N3', team_id: 25, name: 'Bellevue' },
      { seed: 4,  seedLabel: 'N4', team_id: 31, name: 'Shoreline' },
      { seed: 5,  seedLabel: 'S1', team_id: 44, name: 'Linn-Benton' },
      { seed: 6,  seedLabel: 'S2', team_id: 43, name: 'Lane' },
      { seed: 7,  seedLabel: 'S3', team_id: 47, name: 'Umpqua' },
      { seed: 8,  seedLabel: 'S4', team_id: 45, name: 'Mt. Hood' },
      { seed: 9,  seedLabel: 'E1', team_id: 35, name: 'Spokane' },
      { seed: 10, seedLabel: 'E2', team_id: 38, name: 'Wenatchee' },
      { seed: 11, seedLabel: 'E3', team_id: 34, name: 'Col. Basin' },
      { seed: 12, seedLabel: 'E4', team_id: 39, name: 'Yakima' },
      { seed: 13, seedLabel: 'W1', team_id: 52, name: 'Lower Col.' },
      { seed: 14, seedLabel: 'W2', team_id: 30, name: 'Pierce' },
      { seed: 15, seedLabel: 'W3', team_id: 53, name: 'Tacoma' },
      { seed: 16, seedLabel: 'W4', team_id: 49, name: 'Clark' },
    ],
    // Game numbering: G101-G108 = super regionals (4 series × 2 games each
    // since the 2026 NWAC ran direct BO3 with no play-in), G1-G15 = championships.
    // Numbering >100 keeps refs unambiguous when both brackets share one array.
    //
    // SR layout pairs by region (Game 1 + Game 2 of each series):
    //   West:  G105 G106 — Pierce host vs Mt. Hood (Pierce swept 2-0)
    //   East:  G103 G104 — Wenatchee host vs Shoreline (Wenatchee swept 2-0)
    //   South: G107 G108 — Lane host vs Bellevue (Lane swept 2-0)
    //   North: G101 G102 — Edmonds host vs Umpqua (Edmonds swept 2-0)
    games: [
      // ─ Super Regionals ─ (all 4 hosts swept the series 2-0)
      // North SR @ Edmonds — Edmonds (seed 2) vs Umpqua (seed 7)
      { num: 101, iso: '2026-05-15', day: 'Fri May 15', time: 'Game 1',
        home: { ref: 'seed', val: 2 }, away: { ref: 'seed', val: 7 } },
      { num: 102, iso: '2026-05-16', day: 'Sat May 16', time: 'Game 2',
        home: { ref: 'seed', val: 2 }, away: { ref: 'seed', val: 7 } },
      // East SR @ Wenatchee Valley — Wenatchee (seed 10) vs Shoreline (seed 4)
      { num: 103, iso: '2026-05-15', day: 'Fri May 15', time: 'Game 1',
        home: { ref: 'seed', val: 10 }, away: { ref: 'seed', val: 4 } },
      { num: 104, iso: '2026-05-16', day: 'Sat May 16', time: 'Game 2',
        home: { ref: 'seed', val: 10 }, away: { ref: 'seed', val: 4 } },
      // West SR @ Pierce — Pierce (seed 14) vs Mt. Hood (seed 8)
      { num: 105, iso: '2026-05-15', day: 'Fri May 15', time: 'Game 1',
        home: { ref: 'seed', val: 14 }, away: { ref: 'seed', val: 8 } },
      { num: 106, iso: '2026-05-16', day: 'Sat May 16', time: 'Game 2',
        home: { ref: 'seed', val: 14 }, away: { ref: 'seed', val: 8 } },
      // South SR @ Lane — Lane (seed 6) vs Bellevue (seed 3)
      { num: 107, iso: '2026-05-15', day: 'Fri May 15', time: 'Game 1',
        home: { ref: 'seed', val: 6 }, away: { ref: 'seed', val: 3 } },
      { num: 108, iso: '2026-05-16', day: 'Sat May 16', time: 'Game 2',
        home: { ref: 'seed', val: 6 }, away: { ref: 'seed', val: 3 } },
      // ─ Championships WB R1 — #1 seeds vs SR winners (known) ─
      // Refs are direct seed lookups because the SR is complete and
      // winners are the host #2 seeds.
      { num: 1, iso: '2026-05-21', day: 'Thu May 21', time: '9:35 AM',
        home: { ref: 'seed', val: 1 },  away: { ref: 'seed', val: 14 } },  // N1 Everett vs W2 Pierce (WSR)
      { num: 2, iso: '2026-05-21', day: 'Thu May 21', time: '12:35 PM',
        home: { ref: 'seed', val: 5 },  away: { ref: 'seed', val: 10 } },  // S1 Linn-Benton vs E2 Wenatchee (ESR)
      { num: 3, iso: '2026-05-21', day: 'Thu May 21', time: '4:35 PM',
        home: { ref: 'seed', val: 9 },  away: { ref: 'seed', val: 6 } },   // E1 Spokane vs S2 Lane (SSR)
      { num: 4, iso: '2026-05-21', day: 'Thu May 21', time: '7:35 PM',
        home: { ref: 'seed', val: 13 }, away: { ref: 'seed', val: 2 } },   // W1 Lower Columbia vs N2 Edmonds (NSR)
      { num: 5, iso: '2026-05-22', day: 'Fri May 22', time: '9:35 AM',
        home: { ref: 'loser', game: 1 }, away: { ref: 'loser', game: 2 } },
      { num: 6, iso: '2026-05-22', day: 'Fri May 22', time: '12:35 PM',
        home: { ref: 'loser', game: 3 }, away: { ref: 'loser', game: 4 } },
      { num: 7, iso: '2026-05-22', day: 'Fri May 22', time: '4:35 PM',
        home: { ref: 'winner', game: 1 }, away: { ref: 'winner', game: 2 } },
      { num: 8, iso: '2026-05-22', day: 'Fri May 22', time: '7:35 PM',
        home: { ref: 'winner', game: 3 }, away: { ref: 'winner', game: 4 } },
      { num: 9,  iso: '2026-05-23', day: 'Sat May 23', time: '11:00 AM',
        home: { ref: 'winner', game: 5 }, away: { ref: 'loser', game: 7 } },
      { num: 10, iso: '2026-05-23', day: 'Sat May 23', time: '2:00 PM',
        home: { ref: 'winner', game: 6 }, away: { ref: 'loser', game: 8 } },
      { num: 11, iso: '2026-05-23', day: 'Sat May 23', time: '5:35 PM',
        home: { ref: 'winner', game: 7 }, away: { ref: 'winner', game: 8 } },
      { num: 12, iso: '2026-05-24', day: 'Sun May 24', time: '12:00 PM',
        home: { ref: 'winner', game: 9 }, away: { ref: 'loser', game: 11 } },
      { num: 13, iso: '2026-05-24', day: 'Sun May 24', time: '4:05 PM',
        home: { ref: 'winner', game: 10 }, away: { ref: 'winner', game: 12 } },
      { num: 14, iso: '2026-05-24', day: 'Sun May 24', time: '7:30 PM',
        home: { ref: 'winner', game: 11 }, away: { ref: 'winner', game: 13 } },
      { num: 15, iso: '2026-05-25', day: 'Mon May 25', time: '3:35 PM',
        home: { ref: 'winner', game: 11 }, away: { ref: 'winner', game: 13 },
        ifNecessary: true },
    ],
    // ── Layout (1920×1080) ──
    // 7 columns of 230-wide cards (cards are 90h so logos are visible),
    // with the championship column wider for emphasis. Row pitch is 105
    // so cards have a 15px gap.
    //
    // Vertical alignment — important: SR rows on the left line up
    // horizontally with the championship round-1 games they feed:
    //   Row 1 (y=255) → West SR (G105/G106) → G1
    //   Row 2 (y=360) → East SR (G103/G104) → G2
    //   Row 3 (y=465) → South SR (G107/G108) → G3
    //   Row 4 (y=570) → North SR (G101/G102) → G4
    layout: {
      // ── Super Regionals (cols 1+2) ──
      105: { x: 20,  y: 255, w: 230, h: 90 },
      106: { x: 270, y: 255, w: 230, h: 90 },
      103: { x: 20,  y: 360, w: 230, h: 90 },
      104: { x: 270, y: 360, w: 230, h: 90 },
      107: { x: 20,  y: 465, w: 230, h: 90 },
      108: { x: 270, y: 465, w: 230, h: 90 },
      101: { x: 20,  y: 570, w: 230, h: 90 },
      102: { x: 270, y: 570, w: 230, h: 90 },
      // ── Championships — Winner's Bracket (top half) ──
      1: { x: 520,  y: 255, w: 230, h: 90 },     // col 3
      2: { x: 520,  y: 360, w: 230, h: 90 },
      3: { x: 520,  y: 465, w: 230, h: 90 },
      4: { x: 520,  y: 570, w: 230, h: 90 },
      7: { x: 770,  y: 308, w: 230, h: 90 },     // col 4 — between G1 & G2
      8: { x: 770,  y: 518, w: 230, h: 90 },     //         between G3 & G4
      11:{ x: 1020, y: 413, w: 230, h: 90 },     // col 5 — WB Final
      14:{ x: 1520, y: 413, w: 280, h: 90 },     // col 7 — Championship (wider, gold)
      15:{ x: 1520, y: 515, w: 280, h: 32 },     //         If necessary
      // ── Championships — Loser's Bracket (bottom half) ──
      5: { x: 520,  y: 720, w: 230, h: 80 },     // col 3
      6: { x: 520,  y: 815, w: 230, h: 80 },
      9: { x: 770,  y: 720, w: 230, h: 80 },     // col 4
      10:{ x: 770,  y: 815, w: 230, h: 80 },
      12:{ x: 1020, y: 768, w: 230, h: 80 },     // col 5 — LB R3
      13:{ x: 1270, y: 768, w: 230, h: 80 },     // col 6 — LB Final
    },
    connections: [
      // SR
      { from: 101, to: 102 },
      { from: 103, to: 104 },
      { from: 105, to: 106 },
      { from: 107, to: 108 },
      // SR → Championships
      { from: 106, to: 1 },
      { from: 104, to: 2 },
      { from: 108, to: 3 },
      { from: 102, to: 4 },
      // WB
      { from: 1, to: 7 },
      { from: 2, to: 7 },
      { from: 3, to: 8 },
      { from: 4, to: 8 },
      { from: 7, to: 11 },
      { from: 8, to: 11 },
      { from: 11, to: 14 },
      // LB
      { from: 5, to: 9 },
      { from: 6, to: 10 },
      { from: 9, to: 12 },
      { from: 12, to: 13 },
      { from: 10, to: 13 },
      { from: 13, to: 14 },
    ],
    sectionLabels: [
      // Top-of-bracket section headers
      { text: 'SUPER REGIONALS — MAY 15-16',
        x: 20,  y: 230, w: 480,  centered: true },
      { text: "CHAMPIONSHIPS — WINNER'S BRACKET",
        x: 520, y: 230, w: 1280, centered: true },
      // Above the loser's bracket row
      { text: "CHAMPIONSHIPS — LOSER'S BRACKET",
        x: 520, y: 695, w: 980,  centered: true },
      // Marker above the championship final
      { text: 'CHAMPIONSHIP',
        x: 1520, y: 393, w: 280, centered: true },
    ],
    // Only the actual title game gets the gold border. The BO3 super-regional
    // finals are regular cards.
    championshipGames: [14],
  },
}

// ────────────────────────────────────────────
// Tournament resolution: match bracket games to DB rows, chain winners/losers
// ────────────────────────────────────────────

export async function fetchTournamentGames(tournament) {
  const dates = [...new Set(tournament.games.map((g) => g.iso).filter(Boolean))]
  const all = []
  await Promise.all(
    dates.map(async (iso) => {
      try {
        const res = await fetch(`${API_BASE}/games/by-date?date=${iso}`)
        if (!res.ok) return
        const data = await res.json()
        // Endpoint returns { games: [...] }, but tolerate a bare array too.
        const games = Array.isArray(data)
          ? data
          : (Array.isArray(data?.games) ? data.games : [])
        if (games.length) all.push(...games)
      } catch {
        /* skip */
      }
    })
  )
  return all
}

export function resolveBracket(tournament, dbGames) {
  const seedMap = {}
  for (const s of tournament.seeds) seedMap[s.seed] = s

  // Index DB games by date + sorted team-id pair.
  // Bracket "home/away" is positional, not literal hosting, so we match
  // unordered pairs and re-map scores afterward.
  const dbByKey = new Map()
  for (const g of dbGames) {
    if (!g || !g.home_team_id || !g.away_team_id) continue
    const pair = [g.home_team_id, g.away_team_id].sort((a, b) => a - b).join('-')
    const key = `${g.game_date}|${pair}`
    const existing = dbByKey.get(key)
    if (!existing || (g.status === 'final' && existing.status !== 'final')) {
      dbByKey.set(key, g)
    }
  }

  function resolveRef(ref, outcomes) {
    if (!ref) return null
    if (ref.ref === 'seed')   return seedMap[ref.val]?.team_id || null
    if (ref.ref === 'winner') return outcomes.get(ref.game)?.winner_id || null
    if (ref.ref === 'loser')  return outcomes.get(ref.game)?.loser_id  || null
    return null
  }

  const outcomes = new Map()
  for (const g of tournament.games) {
    const homeId = resolveRef(g.home, outcomes)
    const awayId = resolveRef(g.away, outcomes)
    const outcome = {
      home_team_id: homeId,
      away_team_id: awayId,
      status: null,
      home_score: null,
      away_score: null,
      winner_id: null,
      loser_id:  null,
      db_game_id: null,
    }
    if (homeId && awayId && g.iso) {
      const pair = [homeId, awayId].sort((a, b) => a - b).join('-')
      const db = dbByKey.get(`${g.iso}|${pair}`)
      if (db) {
        outcome.db_game_id = db.id
        outcome.status = db.status
        if (db.status === 'final' && db.home_score != null && db.away_score != null) {
          // Map DB scores back to bracket-home/away order.
          const dbHomeIsBracketHome = db.home_team_id === homeId
          outcome.home_score = dbHomeIsBracketHome ? db.home_score : db.away_score
          outcome.away_score = dbHomeIsBracketHome ? db.away_score : db.home_score
          if (outcome.home_score > outcome.away_score) {
            outcome.winner_id = homeId
            outcome.loser_id  = awayId
          } else if (outcome.away_score > outcome.home_score) {
            outcome.winner_id = awayId
            outcome.loser_id  = homeId
          }
        }
      }
    }
    // Fallback: if we don't have a DB-resolved final and the game entry
    // carries an explicit `fallbackResult`, use those scores. Used for
    // games that didn't make it into our scraper (e.g. NWAC noon play-ins
    // posted on a URL outside the GH-Action's normal traversal).
    if (outcome.home_score == null && g.fallbackResult && homeId && awayId) {
      outcome.home_score = g.fallbackResult.home_score
      outcome.away_score = g.fallbackResult.away_score
      outcome.status = g.fallbackResult.status || 'final'
      if (outcome.home_score > outcome.away_score) {
        outcome.winner_id = homeId
        outcome.loser_id  = awayId
      } else if (outcome.away_score > outcome.home_score) {
        outcome.winner_id = awayId
        outcome.loser_id  = homeId
      }
    }
    outcomes.set(g.num, outcome)
  }
  return outcomes
}

export function shortLabelForRef(ref, seedMap, outcomes, seeds) {
  if (ref.ref === 'seed') {
    const s = seedMap[ref.val]
    // seedLabel lets a tournament show conference-prefixed seeds like "N1"
    // / "W2" without breaking the integer-keyed seed map used for refs.
    return { name: s?.name || `Seed ${ref.val}`, seed: s?.seedLabel || ref.val, team_id: s?.team_id }
  }
  if (ref.ref === 'winner' || ref.ref === 'loser') {
    const o = outcomes?.get(ref.game)
    const tid = ref.ref === 'winner' ? o?.winner_id : o?.loser_id
    if (tid) {
      const s = seeds.find((x) => x.team_id === tid)
      return { name: s?.name || `Team ${tid}`, seed: s?.seedLabel || s?.seed, team_id: tid }
    }
    return { name: `${ref.ref === 'winner' ? 'Winner' : 'Loser'} G${ref.game}`, placeholder: true }
  }
  if (ref.ref === 'placeholder') {
    // Static placeholder for slots whose team can't be derived from previous
    // games (e.g. GNAC scenario B: "2-0 Team" / "1-1 Team", which depend on
    // round-robin standings that don't fit the winner/loser model).
    return { name: ref.name || '???', placeholder: true }
  }
  return { name: '???', placeholder: true }
}
