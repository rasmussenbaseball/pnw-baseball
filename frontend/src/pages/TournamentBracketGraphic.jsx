import { useState, useRef, useCallback, useEffect } from 'react'

const API_BASE = '/api/v1'

// ────────────────────────────────────────────
// Palette — teal background, brighter teal cards for contrast,
// gold championship accent so the trophy game stands out.
// ────────────────────────────────────────────
const PALETTE = {
  bg: '#062029',
  bgGradTop: '#082e3a',
  bgGradBottom: '#04181f',
  card: '#1a5f74',          // brighter than bg, real contrast
  cardEliminated: '#0f3e4a',
  cardChampionship: '#266b85',
  border: '#3aa3bd',        // brighter teal border for visibility
  borderBright: '#5fd4eb',
  championshipBorder: '#ffd54f',  // gold for the trophy game
  accent: '#5fd4eb',        // bright cyan for section labels
  accentDim: '#a7edff',
  textPrimary: '#ffffff',
  textSecondary: '#cef0fa',
  textMuted: 'rgba(255,255,255,0.50)',
  scoreBoxBorder: 'rgba(255,255,255,0.25)',
  scoreBoxBorderWinner: '#ffd54f',
  scoreBoxText: 'rgba(255,255,255,0.40)',
  connector: '#3aa3bd',
  ifNecessaryDim: 'rgba(255,255,255,0.12)',
  topStrip: 'rgba(0,0,0,0.45)',
  loserDim: 'rgba(255,255,255,0.45)',
}

// ────────────────────────────────────────────
// Canvas dimensions — 1920x1080 (16:9). Brackets flow left-to-right and
// need horizontal room.
// ────────────────────────────────────────────
const CANVAS_W = 1920
const CANVAS_H = 1080

// ────────────────────────────────────────────
// Tournament data
//
// Each tournament entry carries everything the renderer needs:
//   - seeds:           team_id + display name per seed
//   - games:           ordered list of games with home/away refs
//                      (refs can be { ref:'seed', val } / { ref:'winner', game } /
//                      { ref:'loser', game })
//   - layout:          { gameNum: { x, y, w, h } } absolute positions
//   - connections:     bracket-line list [{ from, to }]
//   - sectionLabels:   labels drawn on the canvas
//   - formatLabel:     subtitle under tournament name (e.g. "Double-elimination bracket")
//   - championshipGames: game numbers that get the gold border / championship styling
// ────────────────────────────────────────────

const TOURNAMENTS = {
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
  // Each has 3 teams: the #2 seed (host, bye to BO3 final) plus two
  // teams that play a single-elim play-in (one #3 / #4 from a different
  // conference). Winners advance to the NWAC Championships in Longview.
  //
  // The #1 seed from each conference (N1, S1, E1, W1) gets a direct bye
  // to the championships and is shown in the byes strip at the top.
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
      // ─ North Super Regional @ Edmonds ─
      { num: 1, iso: '2026-05-15', day: 'Fri May 15', time: 'Single Elim',
        home: { ref: 'seed', val: 7  }, away: { ref: 'seed', val: 16 } },     // S3 vs W4
      { num: 2, iso: null,         day: 'Fri-Sat May 15-16', time: 'Best of 3',
        home: { ref: 'seed', val: 2  }, away: { ref: 'winner', game: 1 } },   // N2 vs G1 winner
      // ─ East Super Regional @ Wenatchee Valley ─
      { num: 3, iso: '2026-05-15', day: 'Fri May 15', time: 'Single Elim',
        home: { ref: 'seed', val: 4  }, away: { ref: 'seed', val: 15 } },     // N4 vs W3
      { num: 4, iso: null,         day: 'Fri-Sat May 15-16', time: 'Best of 3',
        home: { ref: 'seed', val: 10 }, away: { ref: 'winner', game: 3 } },   // E2 vs G3 winner
      // ─ West Super Regional @ Pierce ─
      { num: 5, iso: '2026-05-15', day: 'Fri May 15', time: 'Single Elim',
        home: { ref: 'seed', val: 8  }, away: { ref: 'seed', val: 11 } },     // S4 vs E3
      { num: 6, iso: null,         day: 'Fri-Sat May 15-16', time: 'Best of 3',
        home: { ref: 'seed', val: 14 }, away: { ref: 'winner', game: 5 } },   // W2 vs G5 winner
      // ─ South Super Regional @ Lane ─
      { num: 7, iso: '2026-05-15', day: 'Fri May 15', time: 'Single Elim',
        home: { ref: 'seed', val: 12 }, away: { ref: 'seed', val: 3  } },     // E4 vs N3
      { num: 8, iso: null,         day: 'Fri-Sat May 15-16', time: 'Best of 3',
        home: { ref: 'seed', val: 6  }, away: { ref: 'winner', game: 7 } },   // S2 vs G7 winner
    ],
    // 2x2 grid layout — each quadrant has the play-in card on the left
    // and the best-of-3 card on the right, connected.
    layout: {
      // Top-left: North
      1: { x: 80,   y: 340, w: 380, h: 130 },
      2: { x: 520,  y: 340, w: 380, h: 130 },
      // Top-right: East
      3: { x: 1020, y: 340, w: 380, h: 130 },
      4: { x: 1460, y: 340, w: 380, h: 130 },
      // Bottom-left: West
      5: { x: 80,   y: 780, w: 380, h: 130 },
      6: { x: 520,  y: 780, w: 380, h: 130 },
      // Bottom-right: South
      7: { x: 1020, y: 780, w: 380, h: 130 },
      8: { x: 1460, y: 780, w: 380, h: 130 },
    },
    connections: [
      { from: 1, to: 2 },
      { from: 3, to: 4 },
      { from: 5, to: 6 },
      { from: 7, to: 8 },
    ],
    sectionLabels: [
      // Byes strip
      { text: 'AUTO-ADVANCED TO CHAMPIONSHIPS:  N1 EVERETT  ·  S1 LINN-BENTON  ·  E1 SPOKANE  ·  W1 LOWER COLUMBIA',
        x: 0, y: 240, w: CANVAS_W, centered: true },
      // Regional headers
      { text: 'NORTH SUPER REGIONAL — @ EDMONDS',
        x: 80,   y: 305, w: 820, centered: true },
      { text: 'EAST SUPER REGIONAL — @ WENATCHEE VALLEY',
        x: 1020, y: 305, w: 820, centered: true },
      { text: 'WEST SUPER REGIONAL — @ PIERCE',
        x: 80,   y: 745, w: 820, centered: true },
      { text: 'SOUTH SUPER REGIONAL — @ LANE',
        x: 1020, y: 745, w: 820, centered: true },
      // Champion advances label
      { text: 'NORTH CHAMP →', x: 80,   y: 490, w: 820, centered: true },
      { text: 'EAST CHAMP →',  x: 1020, y: 490, w: 820, centered: true },
      { text: 'WEST CHAMP →',  x: 80,   y: 930, w: 820, centered: true },
      { text: 'SOUTH CHAMP →', x: 1020, y: 930, w: 820, centered: true },
    ],
    championshipGames: [2, 4, 6, 8],  // BO3 finals get the gold treatment
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
      { seed: 1, seedLabel: 'N1', team_id: 28, name: 'Everett' },
      { seed: 2, seedLabel: 'S1', team_id: 44, name: 'Linn-Benton' },
      { seed: 3, seedLabel: 'E1', team_id: 35, name: 'Spokane' },
      { seed: 4, seedLabel: 'W1', team_id: 52, name: 'Lower Columbia' },
    ],
    games: [
      // ── WB Round 1 (Thu May 21) — #1 seeds vs SR winners ──
      { num: 1, iso: '2026-05-21', day: 'Thu May 21', time: '9:35 AM',
        home: { ref: 'seed', val: 1 }, away: { ref: 'placeholder', name: 'WSR Winner' } },
      { num: 2, iso: '2026-05-21', day: 'Thu May 21', time: '12:35 PM',
        home: { ref: 'seed', val: 2 }, away: { ref: 'placeholder', name: 'ESR Winner' } },
      { num: 3, iso: '2026-05-21', day: 'Thu May 21', time: '4:35 PM',
        home: { ref: 'seed', val: 3 }, away: { ref: 'placeholder', name: 'SSR Winner' } },
      { num: 4, iso: '2026-05-21', day: 'Thu May 21', time: '7:35 PM',
        home: { ref: 'seed', val: 4 }, away: { ref: 'placeholder', name: 'NSR Winner' } },
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
      { seed: 10, seedLabel: 'E2', team_id: 38, name: 'Wenatchee Valley' },
      { seed: 11, seedLabel: 'E3', team_id: 34, name: 'Columbia Basin' },
      { seed: 12, seedLabel: 'E4', team_id: 39, name: 'Yakima Valley' },
      { seed: 13, seedLabel: 'W1', team_id: 52, name: 'Lower Columbia' },
      { seed: 14, seedLabel: 'W2', team_id: 30, name: 'Pierce' },
      { seed: 15, seedLabel: 'W3', team_id: 53, name: 'Tacoma' },
      { seed: 16, seedLabel: 'W4', team_id: 49, name: 'Clark' },
    ],
    // Game numbering: G101-G108 = super regionals (1-8), G1-G15 = championships.
    // Using >100 keeps the chained refs unambiguous since both brackets are
    // in the same `games` array.
    games: [
      // ─ Super Regionals ─
      { num: 101, iso: '2026-05-15', day: 'Fri May 15', time: 'Single Elim',
        home: { ref: 'seed', val: 7  }, away: { ref: 'seed', val: 16 } },
      { num: 102, iso: null, day: 'May 15-16', time: 'Best of 3',
        home: { ref: 'seed', val: 2  }, away: { ref: 'winner', game: 101 } },
      { num: 103, iso: '2026-05-15', day: 'Fri May 15', time: 'Single Elim',
        home: { ref: 'seed', val: 4  }, away: { ref: 'seed', val: 15 } },
      { num: 104, iso: null, day: 'May 15-16', time: 'Best of 3',
        home: { ref: 'seed', val: 10 }, away: { ref: 'winner', game: 103 } },
      { num: 105, iso: '2026-05-15', day: 'Fri May 15', time: 'Single Elim',
        home: { ref: 'seed', val: 8  }, away: { ref: 'seed', val: 11 } },
      { num: 106, iso: null, day: 'May 15-16', time: 'Best of 3',
        home: { ref: 'seed', val: 14 }, away: { ref: 'winner', game: 105 } },
      { num: 107, iso: '2026-05-15', day: 'Fri May 15', time: 'Single Elim',
        home: { ref: 'seed', val: 12 }, away: { ref: 'seed', val: 3  } },
      { num: 108, iso: null, day: 'May 15-16', time: 'Best of 3',
        home: { ref: 'seed', val: 6  }, away: { ref: 'winner', game: 107 } },
      // ─ Championships (WB R1 referencing SR winners) ─
      { num: 1, iso: '2026-05-21', day: 'Thu May 21', time: '9:35 AM',
        home: { ref: 'seed', val: 1 }, away: { ref: 'winner', game: 106 } },   // N1 vs WSR
      { num: 2, iso: '2026-05-21', day: 'Thu May 21', time: '12:35 PM',
        home: { ref: 'seed', val: 5 }, away: { ref: 'winner', game: 104 } },   // S1 vs ESR
      { num: 3, iso: '2026-05-21', day: 'Thu May 21', time: '4:35 PM',
        home: { ref: 'seed', val: 9 }, away: { ref: 'winner', game: 108 } },   // E1 vs SSR
      { num: 4, iso: '2026-05-21', day: 'Thu May 21', time: '7:35 PM',
        home: { ref: 'seed', val: 13 }, away: { ref: 'winner', game: 102 } },  // W1 vs NSR
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
    layout: {
      // ── Super Regionals stacked on far left ──
      101: { x: 40,  y: 245, w: 220, h: 58 },
      102: { x: 280, y: 245, w: 220, h: 58 },
      103: { x: 40,  y: 335, w: 220, h: 58 },
      104: { x: 280, y: 335, w: 220, h: 58 },
      105: { x: 40,  y: 425, w: 220, h: 58 },
      106: { x: 280, y: 425, w: 220, h: 58 },
      107: { x: 40,  y: 515, w: 220, h: 58 },
      108: { x: 280, y: 515, w: 220, h: 58 },
      // ── Championships WB ──
      1: { x: 560,  y: 245, w: 230, h: 60 },
      2: { x: 560,  y: 335, w: 230, h: 60 },
      3: { x: 560,  y: 425, w: 230, h: 60 },
      4: { x: 560,  y: 515, w: 230, h: 60 },
      7: { x: 830,  y: 290, w: 230, h: 60 },
      8: { x: 830,  y: 470, w: 230, h: 60 },
      11:{ x: 1100, y: 380, w: 230, h: 60 },
      14:{ x: 1620, y: 380, w: 240, h: 78 },
      15:{ x: 1620, y: 472, w: 240, h: 30 },
      // ── Championships LB ──
      5: { x: 560,  y: 700, w: 230, h: 60 },
      6: { x: 560,  y: 800, w: 230, h: 60 },
      9: { x: 830,  y: 700, w: 230, h: 60 },
      10:{ x: 830,  y: 800, w: 230, h: 60 },
      12:{ x: 1100, y: 750, w: 230, h: 60 },
      13:{ x: 1370, y: 750, w: 230, h: 60 },
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
      { text: 'BYES → CHAMPIONSHIPS:  N1 EVERETT  ·  S1 LINN-BENTON  ·  E1 SPOKANE  ·  W1 LOWER COLUMBIA',
        x: 0, y: 220, w: CANVAS_W, centered: true },
      { text: 'SUPER REGIONALS (MAY 15-16)', x: 40, y: 660, w: 460, centered: true },
      { text: 'CHAMPIONSHIPS — LOWER COLUMBIA (MAY 21-25)', x: 560, y: 660, w: 1300, centered: true },
      { text: 'CHAMPIONSHIP', x: 1620, y: 358, w: 240, centered: true },
    ],
    championshipGames: [14, 102, 104, 106, 108],
  },
}

// ────────────────────────────────────────────
// Image cache + helpers
// ────────────────────────────────────────────

const imgCache = {}
function loadImage(src) {
  if (!src) return Promise.reject('no src')
  if (imgCache[src]) return imgCache[src]
  const p = new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
  imgCache[src] = p
  return p
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

// ────────────────────────────────────────────
// Tournament resolution: match bracket games to DB rows, chain winners/losers
// ────────────────────────────────────────────

async function fetchTournamentGames(tournament) {
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

function resolveBracket(tournament, dbGames) {
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
    outcomes.set(g.num, outcome)
  }
  return outcomes
}

function shortLabelForRef(ref, seedMap, outcomes, seeds) {
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

// ────────────────────────────────────────────
// Renderer
// ────────────────────────────────────────────

async function renderBracket(canvas, tournament, teamLogoMap, outcomes) {
  const W = CANVAS_W, H = CANVAS_H
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  // Background — vertical teal gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H)
  bgGrad.addColorStop(0, PALETTE.bgGradTop)
  bgGrad.addColorStop(1, PALETTE.bgGradBottom)
  ctx.fillStyle = bgGrad
  ctx.fillRect(0, 0, W, H)

  // Header bar
  const headerH = 72
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, W, headerH)
  ctx.fillStyle = PALETTE.accent
  ctx.fillRect(0, headerH - 3, W, 3)

  // NW logo on left
  try {
    const nwImg = await loadImage('/images/nw-logo-white.png')
    const a = nwImg.naturalWidth / nwImg.naturalHeight
    const size = 44
    let dw = size, dh = size
    if (a >= 1) dh = size / a; else dw = size * a
    ctx.drawImage(nwImg, 24, (headerH - 3 - dh) / 2, dw, dh)
  } catch { /* skip */ }

  // Header title
  ctx.fillStyle = PALETTE.textPrimary
  ctx.font = 'bold 22px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('NW BASEBALL STATS', 84, (headerH - 3) / 2)

  ctx.textAlign = 'right'
  ctx.fillStyle = PALETTE.accentDim
  ctx.font = '15px system-ui, sans-serif'
  ctx.fillText('nwbaseballstats.com', W - 24, (headerH - 3) / 2)

  // Title + subtitle (centered)
  ctx.textAlign = 'center'
  ctx.fillStyle = PALETTE.textPrimary
  ctx.font = 'bold 64px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.fillText(tournament.label.toUpperCase(), W / 2, headerH + 64)

  ctx.fillStyle = PALETTE.accentDim
  ctx.font = '24px system-ui, sans-serif'
  ctx.fillText(tournament.sub, W / 2, headerH + 110)

  ctx.fillStyle = PALETTE.textMuted
  ctx.font = 'italic 16px system-ui, sans-serif'
  ctx.fillText(tournament.formatLabel || 'Double-elimination bracket', W / 2, headerH + 138)

  // Section labels — sourced from tournament data so each format can lay out
  // its own labels (winner's/loser's/championship for double-elim brackets,
  // round-robin sections for GNAC, etc.).
  for (const lbl of (tournament.sectionLabels || [])) {
    drawSectionLabel(ctx, lbl.text, lbl.x, lbl.y, lbl.w, !!lbl.centered)
  }

  // Build maps for game lookup
  const seedMap = {}
  for (const s of tournament.seeds) seedMap[s.seed] = s
  const championshipGames = new Set(tournament.championshipGames || [])

  // Draw connector lines first (so cards sit on top)
  ctx.strokeStyle = PALETTE.connector
  ctx.lineWidth = 3
  ctx.lineJoin = 'round'
  for (const conn of (tournament.connections || [])) {
    const a = tournament.layout[conn.from]
    const b = tournament.layout[conn.to]
    if (!a || !b) continue
    drawConnector(ctx, a, b)
  }

  // Draw all game cards
  for (const g of tournament.games) {
    const pos = tournament.layout[g.num]
    if (!pos) continue
    if (g.ifNecessary) {
      await drawIfNecessaryCard(ctx, g, pos)
    } else {
      await drawGameCard(ctx, g, pos, seedMap, teamLogoMap, outcomes, tournament.seeds, championshipGames)
    }
  }

  // Footer
  const anyFinal = outcomes && [...outcomes.values()].some((o) => o.status === 'final')
  ctx.fillStyle = PALETTE.textMuted
  ctx.font = '15px system-ui, sans-serif'
  ctx.textAlign = 'center'
  const footerText = anyFinal
    ? 'Bracket format · Final scores update automatically as games complete'
    : 'Bracket format · Final scores will populate when games complete'
  ctx.fillText(footerText, W / 2, H - 28)
}

function drawSectionLabel(ctx, text, x, y, w, centered = false) {
  ctx.fillStyle = PALETTE.accent
  ctx.font = 'bold 22px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  if (centered) {
    ctx.textAlign = 'center'
    ctx.fillText(text, x + w / 2, y)
  } else {
    ctx.textAlign = 'left'
    ctx.fillText(text, x, y)
  }
  // Subtle underline accent
  ctx.fillStyle = PALETTE.accent
  if (centered) {
    const tw = ctx.measureText(text).width
    ctx.fillRect(x + (w - tw) / 2, y + 16, tw, 2)
  } else {
    ctx.fillRect(x, y + 16, ctx.measureText(text).width, 2)
  }
}

function drawConnector(ctx, a, b) {
  // Draw a stepped connector from right edge of `a` (mid-height) to left edge of `b` (mid-height).
  const x1 = a.x + a.w
  const y1 = a.y + a.h / 2
  const x2 = b.x
  const y2 = b.y + b.h / 2
  const midX = (x1 + x2) / 2
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(midX, y1)
  ctx.lineTo(midX, y2)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

async function drawGameCard(ctx, game, pos, seedMap, teamLogoMap, outcomes, seeds, championshipGames) {
  const { x, y, w, h } = pos
  const isChamp = championshipGames ? championshipGames.has(game.num) : false

  // Card bg
  ctx.fillStyle = isChamp ? PALETTE.cardChampionship : PALETTE.card
  roundRect(ctx, x, y, w, h, 10)
  ctx.fill()

  // Card border — gold for the championship, bright teal for the rest
  ctx.strokeStyle = isChamp ? PALETTE.championshipBorder : PALETTE.border
  ctx.lineWidth = isChamp ? 2.5 : 1.6
  ctx.stroke()

  // Top strip with game number + time + day
  const stripH = 28
  ctx.fillStyle = PALETTE.topStrip
  roundRect(ctx, x, y, w, stripH, 10)
  ctx.fill()
  ctx.fillRect(x, y + 14, w, stripH - 14)

  // Game number badge — use displayLabel override if present (e.g. GNAC
  // scenario B uses 'G4' / 'G5' as labels even though their internal nums
  // are 6 / 7 to keep the outcomes Map keys unique).
  ctx.fillStyle = isChamp ? PALETTE.championshipBorder : PALETTE.accent
  ctx.font = 'bold 14px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(game.displayLabel || `G${game.num}`, x + 12, y + 14)

  // Day + time (or "FINAL" badge if game is over)
  const outcome = outcomes?.get(game.num)
  const isFinal = outcome?.status === 'final'
  ctx.fillStyle = PALETTE.textSecondary
  ctx.font = '13px system-ui, sans-serif'
  ctx.fillText(`${game.day} · ${game.time}`, x + 46, y + 14)

  if (isFinal) {
    // FINAL pill on the right of the strip
    const pillW = 50, pillH = 18
    const pillX = x + w - pillW - 10
    const pillY = y + (stripH - pillH) / 2
    ctx.fillStyle = PALETTE.accent
    roundRect(ctx, pillX, pillY, pillW, pillH, 4)
    ctx.fill()
    ctx.fillStyle = '#062029'
    ctx.font = 'bold 11px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('FINAL', pillX + pillW / 2, y + 14)
  }

  // Two team rows
  const homeRef = shortLabelForRef(game.home, seedMap, outcomes, seeds)
  const awayRef = shortLabelForRef(game.away, seedMap, outcomes, seeds)
  const rowTop = y + stripH
  const rowH = (h - stripH) / 2

  const homeScore = outcome?.home_score
  const awayScore = outcome?.away_score
  const winnerId = outcome?.winner_id || null
  const homeIsWinner = isFinal && winnerId && homeRef.team_id === winnerId
  const awayIsWinner = isFinal && winnerId && awayRef.team_id === winnerId

  await drawTeamRow(ctx, awayRef, x, rowTop,         w, rowH, teamLogoMap, awayScore, awayIsWinner, isFinal && !awayIsWinner)
  // Divider line between teams
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x + 10, rowTop + rowH)
  ctx.lineTo(x + w - 10, rowTop + rowH)
  ctx.stroke()
  await drawTeamRow(ctx, homeRef, x, rowTop + rowH, w, rowH, teamLogoMap, homeScore, homeIsWinner, isFinal && !homeIsWinner)
}

async function drawIfNecessaryCard(ctx, game, pos) {
  const { x, y, w, h } = pos
  ctx.fillStyle = 'rgba(255,255,255,0.05)'
  roundRect(ctx, x, y, w, h, 6)
  ctx.fill()
  ctx.strokeStyle = PALETTE.ifNecessaryDim
  ctx.lineWidth = 1.2
  ctx.setLineDash([5, 4])
  ctx.stroke()
  ctx.setLineDash([])

  ctx.fillStyle = PALETTE.textMuted
  ctx.font = 'italic 14px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const label = game.displayLabel || `G${game.num}`
  ctx.fillText(`${label} · ${game.day} ${game.time} (if necessary)`, x + w / 2, y + h / 2)
}

async function drawTeamRow(ctx, teamRef, x, y, w, h, teamLogoMap, score, isWinner, isLoser) {
  // Logo or placeholder
  const logoSize = Math.min(h - 12, 38)
  const logoX = x + 10
  const logoY = y + (h - logoSize) / 2

  // Save alpha so we can dim losers
  const prevAlpha = ctx.globalAlpha
  if (isLoser) ctx.globalAlpha = 0.55

  if (teamRef.team_id) {
    const url = teamLogoMap.get(teamRef.team_id)
    if (url) {
      try {
        const img = await loadImage(url)
        const a = img.naturalWidth / img.naturalHeight
        let dw = logoSize, dh = logoSize
        if (a >= 1) dh = logoSize / a; else dw = logoSize * a
        ctx.drawImage(img, logoX + (logoSize - dw) / 2, logoY + (logoSize - dh) / 2, dw, dh)
      } catch { /* skip */ }
    }
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.10)'
    ctx.beginPath()
    ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2 - 1, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = PALETTE.textMuted
    ctx.font = 'bold 18px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('?', logoX + logoSize / 2, logoY + logoSize / 2)
  }

  // Seed badge — width auto-fits the text so "N1", "W2", etc. don't overflow.
  const afterLogoX = logoX + logoSize + 12
  let nameStartX = afterLogoX
  if (teamRef.seed) {
    ctx.font = 'bold 13px system-ui, sans-serif'
    const seedText = `#${teamRef.seed}`
    const tw = ctx.measureText(seedText).width
    const seedW = Math.max(28, Math.ceil(tw) + 12)
    ctx.fillStyle = PALETTE.border
    roundRect(ctx, afterLogoX, y + h / 2 - 12, seedW, 24, 4)
    ctx.fill()
    ctx.fillStyle = PALETTE.textPrimary
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(seedText, afterLogoX + seedW / 2, y + h / 2)
    nameStartX = afterLogoX + seedW + 10
  }

  // Team name (truncate if too long)
  ctx.fillStyle = teamRef.placeholder ? PALETTE.textMuted : PALETTE.textPrimary
  ctx.font = teamRef.placeholder
    ? 'italic 17px system-ui, sans-serif'
    : (isWinner ? 'bold 20px system-ui, sans-serif' : 'bold 19px system-ui, sans-serif')
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  let displayName = teamRef.name
  const scoreBoxW = 50
  const maxNameW = w - (nameStartX - x) - scoreBoxW - 22
  while (ctx.measureText(displayName).width > maxNameW && displayName.length > 4) {
    displayName = displayName.slice(0, -1)
  }
  if (displayName !== teamRef.name) displayName = displayName.trimEnd() + '…'
  ctx.fillText(displayName, nameStartX, y + h / 2)

  // Score box on right
  const scoreBoxH = 30
  const scoreBoxX = x + w - scoreBoxW - 10
  const scoreBoxY = y + (h - scoreBoxH) / 2

  // Restore alpha for the score box itself (don't dim the winner score by accident,
  // and the loser score should still be readable but slightly muted via alpha above).
  if (isWinner) {
    // Filled gold-bordered box for the winner
    ctx.fillStyle = 'rgba(255,213,79,0.15)'
    roundRect(ctx, scoreBoxX, scoreBoxY, scoreBoxW, scoreBoxH, 5)
    ctx.fill()
    ctx.strokeStyle = PALETTE.scoreBoxBorderWinner
    ctx.lineWidth = 1.8
    ctx.stroke()
  } else {
    ctx.strokeStyle = PALETTE.scoreBoxBorder
    ctx.lineWidth = 1.2
    roundRect(ctx, scoreBoxX, scoreBoxY, scoreBoxW, scoreBoxH, 5)
    ctx.stroke()
  }

  if (score != null) {
    ctx.fillStyle = isWinner ? PALETTE.championshipBorder : PALETTE.textPrimary
    ctx.font = isWinner ? 'bold 22px system-ui, sans-serif' : 'bold 20px system-ui, sans-serif'
  } else {
    ctx.fillStyle = PALETTE.scoreBoxText
    ctx.font = 'bold 18px system-ui, sans-serif'
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(score != null ? String(score) : '-', scoreBoxX + scoreBoxW / 2, scoreBoxY + scoreBoxH / 2)

  // Restore alpha
  ctx.globalAlpha = prevAlpha
}

// ────────────────────────────────────────────
// Page
// ────────────────────────────────────────────

export default function TournamentBracketGraphic() {
  const [selectedKey, setSelectedKey] = useState('ccc_2026')
  const [teamLogoMap, setTeamLogoMap] = useState(new Map())
  const [outcomes, setOutcomes] = useState(new Map())
  const [rendered, setRendered] = useState(false)
  const [error, setError] = useState(null)
  const canvasRef = useRef(null)

  const tournament = TOURNAMENTS[selectedKey]

  // Fetch team logos
  useEffect(() => {
    let cancelled = false
    async function fetchLogos() {
      const map = new Map()
      try {
        await Promise.all(tournament.seeds.map(async (s) => {
          try {
            const res = await fetch(`${API_BASE}/teams/${s.team_id}`)
            if (!res.ok) return
            const team = await res.json()
            if (team.logo_url) map.set(s.team_id, team.logo_url)
          } catch { /* skip */ }
        }))
        if (!cancelled) setTeamLogoMap(map)
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }
    fetchLogos()
    return () => { cancelled = true }
  }, [selectedKey, tournament.seeds])

  // Fetch tournament game results and resolve bracket
  useEffect(() => {
    let cancelled = false
    async function fetchScores() {
      try {
        const dbGames = await fetchTournamentGames(tournament)
        const resolved = resolveBracket(tournament, dbGames)
        if (!cancelled) setOutcomes(resolved)
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }
    fetchScores()
    return () => { cancelled = true }
  }, [selectedKey, tournament])

  const generate = useCallback(async () => {
    if (!canvasRef.current) return
    await renderBracket(canvasRef.current, tournament, teamLogoMap, outcomes)
    setRendered(true)
  }, [tournament, teamLogoMap, outcomes])

  useEffect(() => { generate() }, [generate])

  const download = () => {
    if (!canvasRef.current) return
    const link = document.createElement('a')
    link.download = `${selectedKey}-bracket.png`
    link.href = canvasRef.current.toDataURL('image/png')
    link.click()
  }

  // Quick status read-out for the page (so the user can see what populated)
  const finalCount = [...outcomes.values()].filter((o) => o.status === 'final').length
  const totalNonOptional = tournament.games.filter((g) => !g.ifNecessary).length

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Conference Tournament Bracket</h1>
      <p className="text-sm text-gray-500 mb-5">
        Generate a shareable bracket graphic for a conference tournament. Final scores
        and matchups update automatically as games complete in the database.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={selectedKey}
          onChange={(e) => setSelectedKey(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-nw-teal"
        >
          {Object.entries(TOURNAMENTS).map(([key, t]) => (
            <option key={key} value={key}>{t.label} ({t.season})</option>
          ))}
        </select>

        <button
          type="button"
          onClick={download}
          disabled={!rendered}
          className="px-4 py-2 rounded-lg bg-nw-teal text-white text-sm font-semibold
                     hover:bg-pnw-slate disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Download PNG
        </button>

        <span className="text-xs text-gray-500">
          {finalCount} of {totalNonOptional} games final
        </span>
      </div>

      {error && <p className="text-sm text-red-700 mb-3">{error}</p>}

      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-3">
        <canvas
          ref={canvasRef}
          className="w-full max-w-full h-auto rounded-lg"
          style={{ aspectRatio: '16 / 9' }}
        />
      </div>

      <p className="text-xs text-gray-500 mt-3">
        1920 x 1080 PNG (16:9). Great for Twitter, Facebook, and link
        previews. Instagram will crop unless posted as a landscape feed image.
        Click Download PNG to save.
      </p>
    </div>
  )
}
