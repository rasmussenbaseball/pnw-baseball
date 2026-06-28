// WclLeaderboardGraphic — /graphics/wcl-leaderboards
//
// The summer-league (WCL) sibling of the spring leaderboard graphic
// (SocialGraphics.jsx at /graphics). Same MECHANISM as spring — category
// switcher, stat presets, a full custom mode (main stat + extra columns),
// qualified / min-sample / count / custom-title controls, and a fixed
// 1080×1080 PNG export — but rendered in the WCL visual identity shared
// with WclRecapGraphic / WclGameRecapGraphic: cream paper background,
// navy header band with a gold rule, white stat-row cards, gold rank
// medallions, and the navy footer strip.
//
// Unlike spring (DOM preview + separate canvas exporter kept in sync by
// hand), this page renders ONE canvas and uses it for both the live
// preview and the download — the WCL graphics family convention — so the
// preview can never drift from the exported PNG.
//
// Categories: batting / pitching / teams only. Spring's fielding,
// bullpen (goose eggs / WPA), WAR-combined, clubs, and team-PBP boards
// have no summer equivalents yet: there are no summer reliever/WPA or
// club endpoints, and the summer fielding endpoint is a thin
// chances-only board that doesn't fit this graphic. Add categories here
// when those endpoints land.

import { useState, useRef, useEffect, useCallback } from 'react'
import { useApi } from '../hooks/useApi'

// ─── Fixed 1080×1080 ───
const SIZE = { w: 1080, h: 1080 }

// Summer seasons with WCL data (summer scraping started in 2024).
// There's no summer entry in lib/seasons.js — the backend exposes
// /summer/seasons if this ever needs to be dynamic. Newest first.
const SUMMER_SEASONS = [2026, 2025, 2024]
const CURRENT_SUMMER_SEASON = 2026

// ─── WCL color constants (same hexes as WclRecapGraphic.jsx) ───
const WCL = {
  navy: '#14365c',
  navyDark: '#0d2240',
  blue: '#1f5485',
  gold: '#c9a44c',
  goldDeep: '#a9842f',
  goldLight: '#e2c577',
  cream: '#f6f1e3',
}

// ─── Themes ───
// All WCL-flavored (no spring teal). buildTheme() expands a palette into
// the object the canvas renderer consumes — same pattern as spring's
// THEMES/buildTheme, adapted to the light-paper identity.
const THEMES = [
  {
    id: 'classic', label: 'Summer Classic',
    // light cream paper + grain, navy header, white cards
    bgStops: [WCL.cream, WCL.cream], grain: true, grainDark: 'rgba(20,54,92,0.05)', grainLight: 'rgba(255,255,255,0.6)',
    headerStops: [WCL.navy, WCL.blue], headerRule: WCL.gold,
    kicker: WCL.goldLight, headerText: '#ffffff', headerSub: 'rgba(255,255,255,0.85)',
    card: '#ffffff', cardBorder: 'rgba(20,54,92,0.16)', cardAccent: WCL.navy,
    text: '#1a1a1a', name: WCL.navy, secondary: '#5a5a5a', muted: '#8a8a8a',
    colHeader: WCL.goldDeep, mainStat: WCL.navy, mainStatTop3: WCL.goldDeep,
    medals: [WCL.gold, WCL.goldLight, WCL.goldDeep], medalText: WCL.navyDark, medalRing: WCL.navyDark,
    rank: '#9a9483', logoFallback: '#e8e4d6',
    footerBg: WCL.navyDark, footerText: '#ffffff', footerMuted: 'rgba(255,255,255,0.7)',
  },
  {
    id: 'navy', label: 'Navy Night',
    // deep navy field, cream text, gold accents — the "away jersey"
    bgStops: [WCL.navyDark, WCL.navy, WCL.blue], grain: false,
    headerStops: [WCL.navyDark, WCL.navyDark], headerRule: WCL.gold,
    kicker: WCL.goldLight, headerText: '#ffffff', headerSub: 'rgba(246,241,227,0.75)',
    card: 'rgba(246,241,227,0.07)', cardBorder: 'rgba(226,197,119,0.28)', cardAccent: WCL.gold,
    text: WCL.cream, name: WCL.cream, secondary: 'rgba(246,241,227,0.6)', muted: 'rgba(246,241,227,0.4)',
    colHeader: WCL.goldLight, mainStat: WCL.goldLight, mainStatTop3: WCL.goldLight,
    medals: [WCL.gold, WCL.goldLight, WCL.goldDeep], medalText: WCL.navyDark, medalRing: WCL.goldLight,
    rank: 'rgba(246,241,227,0.45)', logoFallback: 'rgba(246,241,227,0.12)',
    footerBg: 'rgba(0,0,0,0.35)', footerText: WCL.cream, footerMuted: 'rgba(246,241,227,0.6)',
  },
  {
    id: 'sunset', label: 'Golden Hour',
    // warm cream→gold wash, navy ink, navy medallions for contrast
    bgStops: [WCL.cream, '#f0e3c2', WCL.goldLight], grain: true, grainDark: 'rgba(169,132,47,0.07)', grainLight: 'rgba(255,255,255,0.55)',
    headerStops: [WCL.navy, WCL.navyDark], headerRule: WCL.goldDeep,
    kicker: WCL.goldLight, headerText: '#ffffff', headerSub: 'rgba(255,255,255,0.85)',
    card: 'rgba(255,255,255,0.92)', cardBorder: 'rgba(169,132,47,0.35)', cardAccent: WCL.goldDeep,
    text: '#1a1a1a', name: WCL.navy, secondary: '#6a6048', muted: '#94855e',
    colHeader: WCL.navy, mainStat: WCL.navy, mainStatTop3: WCL.navy,
    medals: [WCL.navy, WCL.blue, WCL.navyDark], medalText: WCL.goldLight, medalRing: WCL.goldDeep,
    rank: '#94855e', logoFallback: '#efe7cf',
    footerBg: WCL.navy, footerText: '#ffffff', footerMuted: 'rgba(255,255,255,0.7)',
  },
  {
    id: 'stealth', label: 'Stealth × NWBB',
    // Co-branded with Stealth Batting Gloves ("Dominate in Silence"): dark
    // charcoal field, chrome/silver accents, silver medallions. The footer
    // becomes a sponsor band (logo + URL + promo). NWBB branding stays in the
    // header + footer bottom line.
    bgStops: ['#17181c', '#0b0b0e'], grain: false,
    headerStops: ['#26282e', '#121319'], headerRule: '#c2c6cc',
    kicker: '#b9bdc4', headerText: '#ffffff', headerSub: 'rgba(255,255,255,0.72)',
    card: 'rgba(255,255,255,0.05)', cardBorder: 'rgba(196,200,206,0.22)', cardAccent: '#c2c6cc',
    text: '#eef0f2', name: '#ffffff', secondary: 'rgba(238,240,242,0.62)', muted: 'rgba(238,240,242,0.4)',
    colHeader: '#aab0b8', mainStat: '#eef0f2', mainStatTop3: '#ffffff',
    medals: ['#e9ebee', '#c2c6cc', '#8d9298'], medalText: '#15161a', medalRing: '#e9ebee',
    rank: 'rgba(238,240,242,0.4)', logoFallback: 'rgba(255,255,255,0.1)',
    footerBg: '#0a0a0d', footerText: '#e9ebee', footerMuted: 'rgba(233,235,238,0.55)',
    sponsor: true, sponsorAccent: '#c8ccd2', sponsorPill: '#d7dbe0', sponsorPillText: '#101114',
  },
]

function buildTheme(palette) {
  const stops = palette.bgStops
  return {
    ...palette,
    // CSS gradient for the theme swatch buttons
    swatch: stops.length > 1
      ? `linear-gradient(135deg, ${stops.join(', ')})`
      : stops[0],
  }
}

// ─── All available stats with metadata ───
// Covers every field the summer endpoints return. `dir` is the natural
// leaderboard direction (asc = lower is better). All keys below are in
// the backend sort whitelists, so any of them can be the main stat.
const ALL_SUMMER_BATTING_STATS = [
  { key: 'batting_avg',       label: 'AVG',     format: 'avg', dir: 'desc' },
  { key: 'on_base_pct',       label: 'OBP',     format: 'avg', dir: 'desc' },
  { key: 'slugging_pct',      label: 'SLG',     format: 'avg', dir: 'desc' },
  { key: 'ops',               label: 'OPS',     format: 'avg', dir: 'desc' },
  { key: 'woba',              label: 'wOBA',    format: 'avg', dir: 'desc' },
  { key: 'wobacon',           label: 'wOBACON', format: 'avg', dir: 'desc' },
  { key: 'wrc_plus',          label: 'wRC+',    format: 'int', dir: 'desc' },
  { key: 'wraa',              label: 'wRAA',    format: 'war', dir: 'desc' },
  { key: 'wrc',               label: 'wRC',     format: 'war', dir: 'desc' },
  { key: 'iso',               label: 'ISO',     format: 'avg', dir: 'desc' },
  { key: 'babip',             label: 'BABIP',   format: 'avg', dir: 'desc' },
  { key: 'offensive_war',     label: 'oWAR',    format: 'war', dir: 'desc' },
  { key: 'home_runs',         label: 'HR',      format: 'int', dir: 'desc' },
  { key: 'hits',              label: 'H',       format: 'int', dir: 'desc' },
  { key: 'doubles',           label: '2B',      format: 'int', dir: 'desc' },
  { key: 'triples',           label: '3B',      format: 'int', dir: 'desc' },
  { key: 'runs',              label: 'R',       format: 'int', dir: 'desc' },
  { key: 'rbi',               label: 'RBI',     format: 'int', dir: 'desc' },
  { key: 'stolen_bases',      label: 'SB',      format: 'int', dir: 'desc' },
  { key: 'caught_stealing',   label: 'CS',      format: 'int', dir: 'asc'  },
  { key: 'walks',             label: 'BB',      format: 'int', dir: 'desc' },
  { key: 'intentional_walks', label: 'IBB',     format: 'int', dir: 'desc' },
  { key: 'hit_by_pitch',      label: 'HBP',     format: 'int', dir: 'desc' },
  { key: 'strikeouts',        label: 'SO',      format: 'int', dir: 'asc'  },
  { key: 'sacrifice_flies',   label: 'SF',      format: 'int', dir: 'desc' },
  { key: 'sacrifice_bunts',   label: 'SH',      format: 'int', dir: 'desc' },
  { key: 'grounded_into_dp',  label: 'GIDP',    format: 'int', dir: 'asc'  },
  { key: 'bb_pct',            label: 'BB%',     format: 'pct', dir: 'desc' },
  { key: 'k_pct',             label: 'K%',      format: 'pct', dir: 'asc'  },
  { key: 'plate_appearances', label: 'PA',      format: 'int', dir: 'desc' },
  { key: 'at_bats',           label: 'AB',      format: 'int', dir: 'desc' },
  { key: 'games',             label: 'G',       format: 'int', dir: 'desc' },
  { key: 'games_started',     label: 'GS',      format: 'int', dir: 'desc' },
  // Plate-discipline rates derived from summer PBP
  { key: 'swing_pct',         label: 'Swing%',  format: 'pct', dir: 'desc' },
  { key: 'contact_pct',       label: 'Contact%',format: 'pct', dir: 'desc' },
  { key: 'whiff_pct',         label: 'Whiff%',  format: 'pct', dir: 'asc'  },
  { key: 'air_pull_pct',      label: 'AirPull%',format: 'pct', dir: 'desc' },
]

const ALL_SUMMER_PITCHING_STATS = [
  { key: 'era',               label: 'ERA',     format: 'era', dir: 'asc'  },
  { key: 'whip',              label: 'WHIP',    format: 'era', dir: 'asc'  },
  { key: 'fip',               label: 'FIP',     format: 'era', dir: 'asc'  },
  { key: 'strikeouts',        label: 'K',       format: 'int', dir: 'desc' },
  { key: 'walks',             label: 'BB',      format: 'int', dir: 'asc'  },
  { key: 'k_pct',             label: 'K%',      format: 'pct', dir: 'desc' },
  { key: 'bb_pct',            label: 'BB%',     format: 'pct', dir: 'asc'  },
  { key: 'k_per_9',           label: 'K/9',     format: 'era', dir: 'desc' },
  { key: 'bb_per_9',          label: 'BB/9',    format: 'era', dir: 'asc'  },
  { key: 'h_per_9',           label: 'H/9',     format: 'era', dir: 'asc'  },
  { key: 'hr_per_9',          label: 'HR/9',    format: 'era', dir: 'asc'  },
  { key: 'k_bb_ratio',        label: 'K/BB',    format: 'era', dir: 'desc' },
  { key: 'babip_against',     label: 'BABIP',   format: 'avg', dir: 'asc'  },
  { key: 'pitching_war',      label: 'pWAR',    format: 'war', dir: 'desc' },
  { key: 'innings_pitched',   label: 'IP',      format: 'ip',  dir: 'desc' },
  { key: 'wins',              label: 'W',       format: 'int', dir: 'desc' },
  { key: 'losses',            label: 'L',       format: 'int', dir: 'asc'  },
  { key: 'saves',             label: 'SV',      format: 'int', dir: 'desc' },
  { key: 'games',             label: 'G',       format: 'int', dir: 'desc' },
  { key: 'games_started',     label: 'GS',      format: 'int', dir: 'desc' },
  { key: 'complete_games',    label: 'CG',      format: 'int', dir: 'desc' },
  { key: 'shutouts',          label: 'SHO',     format: 'int', dir: 'desc' },
  { key: 'batters_faced',     label: 'BF',      format: 'int', dir: 'desc' },
  { key: 'hits_allowed',      label: 'H',       format: 'int', dir: 'asc'  },
  { key: 'runs_allowed',      label: 'R',       format: 'int', dir: 'asc'  },
  { key: 'earned_runs',       label: 'ER',      format: 'int', dir: 'asc'  },
  { key: 'home_runs_allowed', label: 'HR',      format: 'int', dir: 'asc'  },
  { key: 'hit_batters',       label: 'HB',      format: 'int', dir: 'asc'  },
  { key: 'wild_pitches',      label: 'WP',      format: 'int', dir: 'asc'  },
  // Pitch-level rates derived from summer PBP
  { key: 'whiff_pct',         label: 'Whiff%',  format: 'pct', dir: 'desc' },
  { key: 'csw_pct',           label: 'CSW%',    format: 'pct', dir: 'desc' },
  { key: 'strike_pct',        label: 'Strike%', format: 'pct', dir: 'desc' },
  { key: 'f_strike_pct',      label: 'F-Str%',  format: 'pct', dir: 'desc' },
]

// Team aggregates from /summer/leaderboards/team-stats
const ALL_SUMMER_TEAM_STATS = [
  { key: 'team_avg',         label: 'AVG',     format: 'avg', dir: 'desc' },
  { key: 'team_obp',         label: 'OBP',     format: 'avg', dir: 'desc' },
  { key: 'team_slg',         label: 'SLG',     format: 'avg', dir: 'desc' },
  { key: 'team_ops',         label: 'OPS',     format: 'avg', dir: 'desc' },
  { key: 'avg_woba',         label: 'wOBA',    format: 'avg', dir: 'desc' },
  { key: 'total_hr',         label: 'HR',      format: 'int', dir: 'desc' },
  { key: 'total_runs',       label: 'R',       format: 'int', dir: 'desc' },
  { key: 'runs_per_game',    label: 'R/G',     format: 'era', dir: 'desc' },
  { key: 'total_rbi',        label: 'RBI',     format: 'int', dir: 'desc' },
  { key: 'total_hits',       label: 'H',       format: 'int', dir: 'desc' },
  { key: 'total_sb',         label: 'SB',      format: 'int', dir: 'desc' },
  { key: 'bat_bb_pct',       label: 'BB%',     format: 'pct', dir: 'desc' },
  { key: 'bat_k_pct',        label: 'K%',      format: 'pct', dir: 'asc'  },
  { key: 'total_owar',       label: 'oWAR',    format: 'war', dir: 'desc' },
  { key: 'team_era',         label: 'ERA',     format: 'era', dir: 'asc'  },
  { key: 'team_whip',        label: 'WHIP',    format: 'era', dir: 'asc'  },
  { key: 'avg_fip',          label: 'FIP',     format: 'era', dir: 'asc'  },
  { key: 'total_k',          label: 'K',       format: 'int', dir: 'desc' },
  { key: 'total_bb_allowed', label: 'BB (P)',  format: 'int', dir: 'asc'  },
  { key: 'k_per_9',          label: 'K/9',     format: 'era', dir: 'desc' },
  { key: 'bb_per_9',         label: 'BB/9',    format: 'era', dir: 'asc'  },
  { key: 'pit_k_pct',        label: 'K% (P)',  format: 'pct', dir: 'desc' },
  { key: 'pit_bb_pct',       label: 'BB% (P)', format: 'pct', dir: 'asc'  },
  { key: 'total_ip',         label: 'IP',      format: 'ip',  dir: 'desc' },
  { key: 'total_pwar',       label: 'pWAR',    format: 'war', dir: 'desc' },
  { key: 'total_war',        label: 'WAR',     format: 'war', dir: 'desc' },
  { key: 'wins',             label: 'W',       format: 'int', dir: 'desc' },
]

// ─── Category metadata (mirrors spring's CATEGORIES shape) ───
const CATEGORIES = [
  { id: 'batting',  label: 'Batting',  endpoint: '/summer/leaderboards/batting',    kind: 'player',
    team: true, qualified: true, sampleParam: 'min_pa', sampleLabel: 'PA', sampleDefault: 20 },
  { id: 'pitching', label: 'Pitching', endpoint: '/summer/leaderboards/pitching',   kind: 'player',
    team: true, qualified: true, sampleParam: 'min_ip', sampleLabel: 'IP', sampleDefault: 10 },
  { id: 'teams',    label: 'Teams',    endpoint: '/summer/leaderboards/team-stats', kind: 'team',
    sampleParam: null },
]
const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]))

// Backend sort whitelists (mirror summer.py valid_sorts). Every stat in
// the lists above is server-sortable, so the whitelist is the full key
// set — kept explicit anyway so a future display-only column can't
// silently become a mis-ranked main stat (the spring SORTABLE pattern).
const SORTABLE = {
  batting:  new Set(ALL_SUMMER_BATTING_STATS.map(s => s.key)),
  pitching: new Set(ALL_SUMMER_PITCHING_STATS.map(s => s.key)),
  teams:    new Set(ALL_SUMMER_TEAM_STATS.map(s => s.key)),
}

// ─── Stat presets (the spirit of spring's presets, summer-flavored) ───
// `name` is the short button label; `title` is the graphic headline.
const STAT_PRESETS = {
  batting: [
    { name: 'Slash', key: 'batting_avg', label: 'AVG', sort: 'batting_avg', dir: 'desc', format: 'avg', title: 'Batting Average Leaders',
      extra: [
        { key: 'on_base_pct', label: 'OBP', format: 'avg' },
        { key: 'slugging_pct', label: 'SLG', format: 'avg' },
        { key: 'ops', label: 'OPS', format: 'avg' },
        { key: 'hits', label: 'H', format: 'int' },
        { key: 'plate_appearances', label: 'PA', format: 'int' },
      ] },
    { name: 'Power', key: 'home_runs', label: 'HR', sort: 'home_runs', dir: 'desc', format: 'int', title: 'Home Run Leaders',
      extra: [
        { key: 'slugging_pct', label: 'SLG', format: 'avg' },
        { key: 'iso', label: 'ISO', format: 'avg' },
        { key: 'rbi', label: 'RBI', format: 'int' },
        { key: 'runs', label: 'R', format: 'int' },
        { key: 'plate_appearances', label: 'PA', format: 'int' },
      ] },
    { name: 'Speed', key: 'stolen_bases', label: 'SB', sort: 'stolen_bases', dir: 'desc', format: 'int', title: 'Stolen Base Leaders',
      extra: [
        { key: 'batting_avg', label: 'AVG', format: 'avg' },
        { key: 'on_base_pct', label: 'OBP', format: 'avg' },
        { key: 'runs', label: 'R', format: 'int' },
        { key: 'caught_stealing', label: 'CS', format: 'int' },
        { key: 'plate_appearances', label: 'PA', format: 'int' },
      ] },
    { name: 'Discipline', key: 'contact_pct', label: 'Contact%', sort: 'contact_pct', dir: 'desc', format: 'pct', title: 'Contact% Leaders',
      extra: [
        { key: 'whiff_pct', label: 'Whiff%', format: 'pct' },
        { key: 'swing_pct', label: 'Swing%', format: 'pct' },
        { key: 'bb_pct', label: 'BB%', format: 'pct' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'plate_appearances', label: 'PA', format: 'int' },
      ] },
    { name: 'Advanced', key: 'woba', label: 'wOBA', sort: 'woba', dir: 'desc', format: 'avg', title: 'wOBA Leaders',
      extra: [
        { key: 'wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'ops', label: 'OPS', format: 'avg' },
        { key: 'iso', label: 'ISO', format: 'avg' },
        { key: 'bb_pct', label: 'BB%', format: 'pct' },
        { key: 'plate_appearances', label: 'PA', format: 'int' },
      ] },
  ],
  pitching: [
    { name: 'ERA', key: 'era', label: 'ERA', sort: 'era', dir: 'asc', format: 'era', title: 'ERA Leaders',
      extra: [
        { key: 'whip', label: 'WHIP', format: 'era' },
        { key: 'fip', label: 'FIP', format: 'era' },
        { key: 'strikeouts', label: 'K', format: 'int' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { name: 'Strikeouts', key: 'strikeouts', label: 'K', sort: 'strikeouts', dir: 'desc', format: 'int', title: 'Strikeout Leaders',
      extra: [
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'bb_pct', label: 'BB%', format: 'pct' },
        { key: 'k_per_9', label: 'K/9', format: 'era' },
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { name: 'WHIP', key: 'whip', label: 'WHIP', sort: 'whip', dir: 'asc', format: 'era', title: 'WHIP Leaders',
      extra: [
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'h_per_9', label: 'H/9', format: 'era' },
        { key: 'bb_per_9', label: 'BB/9', format: 'era' },
        { key: 'k_bb_ratio', label: 'K/BB', format: 'era' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { name: 'Whiffs', key: 'whiff_pct', label: 'Whiff%', sort: 'whiff_pct', dir: 'desc', format: 'pct', title: 'Whiff% Leaders',
      extra: [
        { key: 'csw_pct', label: 'CSW%', format: 'pct' },
        { key: 'strike_pct', label: 'Strike%', format: 'pct' },
        { key: 'f_strike_pct', label: 'F-Str%', format: 'pct' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { name: 'Advanced', key: 'fip', label: 'FIP', sort: 'fip', dir: 'asc', format: 'era', title: 'FIP Leaders',
      extra: [
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'bb_pct', label: 'BB%', format: 'pct' },
        { key: 'pitching_war', label: 'pWAR', format: 'war' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { name: 'Saves', key: 'saves', label: 'SV', sort: 'saves', dir: 'desc', format: 'int', title: 'Saves Leaders',
      extra: [
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'whip', label: 'WHIP', format: 'era' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'games', label: 'G', format: 'int' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
  ],
  teams: [
    { name: 'Batting', key: 'team_avg', label: 'AVG', sort: 'team_avg', dir: 'desc', format: 'avg', title: 'Team Batting Leaders',
      extra: [
        { key: 'team_obp', label: 'OBP', format: 'avg' },
        { key: 'team_slg', label: 'SLG', format: 'avg' },
        { key: 'team_ops', label: 'OPS', format: 'avg' },
        { key: 'total_hr', label: 'HR', format: 'int' },
      ] },
    { name: 'Power', key: 'total_hr', label: 'HR', sort: 'total_hr', dir: 'desc', format: 'int', title: 'Team Home Run Leaders',
      extra: [
        { key: 'team_slg', label: 'SLG', format: 'avg' },
        { key: 'total_runs', label: 'R', format: 'int' },
        { key: 'runs_per_game', label: 'R/G', format: 'era' },
        { key: 'team_ops', label: 'OPS', format: 'avg' },
      ] },
    { name: 'Run Prod.', key: 'runs_per_game', label: 'R/G', sort: 'runs_per_game', dir: 'desc', format: 'era', title: 'Team Run Production',
      extra: [
        { key: 'total_runs', label: 'R', format: 'int' },
        { key: 'team_avg', label: 'AVG', format: 'avg' },
        { key: 'team_obp', label: 'OBP', format: 'avg' },
        { key: 'total_sb', label: 'SB', format: 'int' },
      ] },
    { name: 'Pitching', key: 'team_era', label: 'ERA', sort: 'team_era', dir: 'asc', format: 'era', title: 'Team Pitching Leaders',
      extra: [
        { key: 'team_whip', label: 'WHIP', format: 'era' },
        { key: 'total_k', label: 'K', format: 'int' },
        { key: 'bb_per_9', label: 'BB/9', format: 'era' },
        { key: 'total_ip', label: 'IP', format: 'ip' },
      ] },
    { name: 'WAR', key: 'total_war', label: 'WAR', sort: 'total_war', dir: 'desc', format: 'war', title: 'Team WAR Leaders',
      extra: [
        { key: 'total_owar', label: 'oWAR', format: 'war' },
        { key: 'total_pwar', label: 'pWAR', format: 'war' },
        { key: 'team_ops', label: 'OPS', format: 'avg' },
        { key: 'team_era', label: 'ERA', format: 'era' },
      ] },
  ],
}

// ─── Format helper (copied from SocialGraphics.jsx, which doesn't export it) ───
function fmt(val, format) {
  if (val == null || val === '') return '-'
  switch (format) {
    case 'avg': return Number(val).toFixed(3).replace(/^0/, '')
    case 'era': return Number(val).toFixed(2)
    case 'pct': return (Number(val) * 100).toFixed(1) + '%'
    case 'ip':  return Number(val).toFixed(1)
    case 'war': return Number(val).toFixed(1)
    case 'int': return Math.round(Number(val)).toString()
    default: return String(val)
  }
}

// ─── Canvas helpers (copied from SocialGraphics.jsx — not exported there) ───
async function loadExportImage(src) {
  if (!src) return null
  const isExternal = src.startsWith('http') && !src.includes(window.location.hostname)
  const url = isExternal
    ? `/api/v1/proxy-image?url=${encodeURIComponent(src)}`
    : src
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const blob = await resp.blob()
    const objectUrl = URL.createObjectURL(blob)
    return await new Promise((resolve) => {
      const img = new Image()
      img.onload = () => { resolve(img); URL.revokeObjectURL(objectUrl) }
      img.onerror = () => { resolve(null); URL.revokeObjectURL(objectUrl) }
      img.src = objectUrl
    })
  } catch {
    return null
  }
}

function drawImageContain(ctx, img, x, y, boxW, boxH) {
  if (!img) return
  const scale = Math.min(boxW / img.width, boxH / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, x + (boxW - dw) / 2, y + (boxH - dh) / 2, dw, dh)
}

function canvasRoundRect(ctx, x, y, w, h, r) {
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

function truncText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 0 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1)
  return t + '…'
}

// Logo cache so re-renders (theme/title tweaks) don't refetch images.
const logoCache = {}
function loadLogoCached(src) {
  if (!src) return Promise.resolve(null)
  if (!logoCache[src]) logoCache[src] = loadExportImage(src)
  return logoCache[src]
}

// Tiny deterministic PRNG so the paper-grain speckle is stable across
// redraws (no shimmering when the user toggles options).
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function getAvailableStats(category) {
  switch (category) {
    case 'batting':  return ALL_SUMMER_BATTING_STATS
    case 'pitching': return ALL_SUMMER_PITCHING_STATS
    case 'teams':    return ALL_SUMMER_TEAM_STATS
    default:         return []
  }
}

function getSortableStats(category) {
  const allow = SORTABLE[category]
  if (!allow) return getAvailableStats(category)
  return getAvailableStats(category).filter(s => allow.has(s.key))
}

// Same 2-column breakpoint as spring
function useTwoColumns(count) {
  return count >= 15
}

const COUNT_OPTIONS = [5, 10, 15, 20, 25, 30, 40, 50]

const FONT = "-apple-system, 'Inter', 'Helvetica Neue', sans-serif"

// ════════════════════════════════════════════════════════════════
// Canvas renderer — one drawing pipeline for preview AND export.
// Layout math (columns, row heights, font scaling) mirrors the spring
// exporter in SocialGraphics.jsx; the visual treatment is WCL.
// ════════════════════════════════════════════════════════════════
// Stealth Batting Gloves co-brand footer band: the transparent silver wordmark
// (with its "Dominate in Silence" tagline), the partner URL, and the promo code —
// while keeping NWBB's own URL on the bottom line so both brands are present.
async function drawSponsorFooter(ctx, w, fy, fh, theme, footerNote) {
  const padX = 44
  // chrome divider at the top of the band
  ctx.fillStyle = theme.sponsorAccent
  ctx.fillRect(0, fy, w, 2)

  // Stealth wordmark (transparent PNG, silver) — prominent, left
  const mark = await loadLogoCached('/stealth/wordmark.png')
  const markH = 50, markW = markH * (1571 / 456)
  if (mark) {
    drawImageContain(ctx, mark, padX, fy + 18, markW, markH)
  } else {
    ctx.fillStyle = theme.footerText
    ctx.font = `900 32px ${FONT}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText('STEALTH', padX, fy + 52)
  }

  // Promo pill (right): USE CODE NWBB · 15% OFF
  const promo = 'USE CODE NWBB · 15% OFF'
  ctx.font = `800 17px ${FONT}`
  ctx.textBaseline = 'middle'
  const pw = ctx.measureText(promo).width + 30
  const ph = 32, px = w - padX - pw, py = fy + 22
  ctx.fillStyle = theme.sponsorPill
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(px, py, pw, ph, 7); ctx.fill() }
  else { ctx.fillRect(px, py, pw, ph) }
  ctx.fillStyle = theme.sponsorPillText
  ctx.textAlign = 'center'
  ctx.fillText(promo, px + pw / 2, py + ph / 2 + 1)

  // Partner URL under the pill (right)
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = theme.sponsorAccent
  ctx.font = `700 16px ${FONT}`
  ctx.textAlign = 'right'
  ctx.fillText('stealthbattinggloves.com', w - padX, fy + 86)

  // NWBB stays present on the bottom line
  ctx.fillStyle = theme.footerMuted
  ctx.font = `600 13px ${FONT}`
  ctx.textAlign = 'left'
  ctx.fillText('nwbaseballstats.com/summer  ·  @nwbbstats', padX, fy + fh - 16)
  if (footerNote) {
    ctx.textAlign = 'right'
    ctx.fillText(footerNote, w - padX, fy + fh - 16)
  }
}

async function renderBoard(canvas, opts) {
  const { items, config, title, subtitle, footerNote, theme, isTeamMode,
          count, twoCol, showRecord, loading } = opts
  const w = SIZE.w, h = SIZE.h
  const dpr = 2
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  // ── Background (flat cream or vertical wash) + paper grain ──
  if (theme.bgStops.length > 1) {
    const g = ctx.createLinearGradient(0, 0, 0, h)
    theme.bgStops.forEach((c, i) => g.addColorStop(i / (theme.bgStops.length - 1), c))
    ctx.fillStyle = g
  } else {
    ctx.fillStyle = theme.bgStops[0]
  }
  ctx.fillRect(0, 0, w, h)

  if (theme.grain) {
    const rand = mulberry32(20260612)
    for (let i = 0; i < 1600; i++) {
      const x = rand() * w, y = rand() * h, s = rand() < 0.5 ? 1 : 2
      ctx.fillStyle = rand() < 0.5 ? theme.grainDark : theme.grainLight
      ctx.fillRect(x, y, s, s)
    }
  }

  // ── Header band: navy gradient + gold rule (the WCL family header) ──
  const headerH = 150
  const hg = ctx.createLinearGradient(0, 0, w, headerH)
  theme.headerStops.forEach((c, i) =>
    hg.addColorStop(theme.headerStops.length > 1 ? i / (theme.headerStops.length - 1) : 0, c))
  ctx.fillStyle = hg
  ctx.fillRect(0, 0, w, headerH)
  // gold accent rule
  ctx.fillStyle = theme.headerRule
  ctx.fillRect(0, headerH - 6, w, 6)

  const padX = 48
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = theme.kicker
  ctx.font = `900 15px ${FONT}`
  ctx.fillText('WEST COAST LEAGUE · LEADERBOARDS', padX, 48)

  // Title — shrink-to-fit so long custom titles never clip
  let titleSize = 44
  ctx.font = `900 ${titleSize}px ${FONT}`
  while (titleSize > 24 && ctx.measureText(title).width > w - padX * 2 - 200) {
    titleSize -= 2
    ctx.font = `900 ${titleSize}px ${FONT}`
  }
  ctx.fillStyle = theme.headerText
  ctx.fillText(title, padX, 102)

  ctx.fillStyle = theme.headerSub
  ctx.font = `600 17px ${FONT}`
  ctx.fillText(subtitle, padX, 130)

  // Brand mark top-right (favicon + NWBB STATS), like the spring header
  const favicon = await loadLogoCached('/favicon.png')
  ctx.textAlign = 'right'
  ctx.font = `800 14px ${FONT}`
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  const brand = 'NWBB STATS'
  ctx.fillText(brand, w - padX, 50)
  if (favicon) {
    const bw = ctx.measureText(brand).width
    drawImageContain(ctx, favicon, w - padX - bw - 30, 36, 22, 22)
  }

  // ── Footer strip. The sponsor themes (Stealth) get a taller co-brand band. ──
  const footerH = theme.sponsor ? 132 : 56
  const footerY = h - footerH
  ctx.fillStyle = theme.footerBg
  ctx.fillRect(0, footerY, w, footerH)
  if (theme.sponsor) {
    await drawSponsorFooter(ctx, w, footerY, footerH, theme, footerNote)
  } else {
    ctx.fillStyle = theme.footerText
    ctx.font = `700 15px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText('nwbaseballstats.com/summer', 40, footerY + 35)
    ctx.font = `500 13px ${FONT}`
    ctx.fillStyle = theme.footerMuted
    ctx.textAlign = 'right'
    ctx.fillText('@nwbbstats', w - 40, footerY + 35)
    if (footerNote) {
      ctx.textAlign = 'center'
      ctx.fillText(footerNote, w / 2, footerY + 35)
    }
  }

  // ── Body geometry (same math shape as the spring exporter) ──
  const bodyPadX = 36
  const bodyTop = headerH + 16
  const bodyBottom = footerY - 14
  const colHeaderH = 26
  const bodyH = bodyBottom - bodyTop - colHeaderH

  const renderCount = Math.min(count, Math.max(items.length, 1))
  const columns = twoCol ? 2 : 1
  const colGap = twoCol ? 14 : 0
  const colWidth = (w - bodyPadX * 2 - colGap * (columns - 1)) / columns
  const itemsPerCol = Math.max(1, Math.ceil(renderCount / columns))
  const rowGap = twoCol ? 6 : Math.min(10, Math.max(4, Math.floor(60 / itemsPerCol) + 2))
  const rowH = Math.floor((bodyH - rowGap * (itemsPerCol - 1)) / itemsPerCol)

  const fontSize = twoCol
    ? Math.min(Math.max(Math.floor(colWidth / 28), 10), 16)
    : Math.min(Math.max(Math.floor(w / 55), 13), 22)
  const rankSize = twoCol ? fontSize : Math.max(fontSize + 2, 16)
  const logoSize = Math.min(Math.floor(rowH * 0.62), twoCol ? 24 : 36)
  const mainStatW = twoCol ? Math.floor(colWidth * 0.2) : Math.floor(w * 0.11)
  const extraW = Math.floor(w * 0.095)
  const rankW = twoCol ? Math.floor(colWidth * 0.09) : Math.floor(w * 0.052)
  const logoW = logoSize + (twoCol ? 6 : 10)
  const recordW = showRecord ? (twoCol ? Math.floor(colWidth * 0.14) : Math.floor(w * 0.075)) : 0
  const rowPadX = twoCol ? 8 : 14
  const extraCols = twoCol ? [] : (config.extra || [])

  if (loading || !items.length) {
    ctx.fillStyle = theme.name
    ctx.font = `700 22px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(loading ? 'Loading…' : 'No data for these filters', w / 2, (bodyTop + bodyBottom) / 2)
    return
  }

  // Pre-load all row logos in parallel (proxy-image handles external URLs)
  const logoImgs = await Promise.all(
    items.slice(0, renderCount).map(p => loadLogoCached(p.logo_url))
  )

  // ── Column headers ──
  for (let col = 0; col < columns; col++) {
    const colX = bodyPadX + col * (colWidth + colGap)
    ctx.font = `800 ${Math.max(Math.floor(fontSize * 0.62), 10)}px ${FONT}`
    ctx.fillStyle = theme.colHeader
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const hy = bodyTop + colHeaderH / 2 - 4
    ctx.fillText(isTeamMode ? 'TEAM' : 'PLAYER', colX + rowPadX + rankW + logoW, hy)
    let hx = colX + colWidth - rowPadX
    ctx.textAlign = 'right'
    for (let ei = extraCols.length - 1; ei >= 0; ei--) {
      ctx.fillText(extraCols[ei].label.toUpperCase(), hx, hy)
      hx -= extraW
    }
    ctx.fillText(config.label.toUpperCase(), hx, hy)
    hx -= mainStatW
    if (showRecord) ctx.fillText('REC', hx, hy)
  }

  // ── Rows: white cards with accent bar + gold medallions for top 3 ──
  const rowStartY = bodyTop + colHeaderH
  for (let i = 0; i < Math.min(renderCount, items.length); i++) {
    const p = items[i]
    const name = isTeamMode
      ? (p.short_name || p.name || '-')
      : (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : p.name || '-')
    const subText = isTeamMode
      ? (p.name && p.name !== p.short_name ? p.name : '')
      : (p.team_short || p.team_name || '')
    const collegeText = !isTeamMode && p.college ? p.college : ''
    const mainVal = p[config.key] ?? p[config.sort]
    const isTop3 = i < 3

    const col = twoCol ? Math.floor(i / itemsPerCol) : 0
    const rowInCol = twoCol ? i % itemsPerCol : i
    const x = bodyPadX + col * (colWidth + colGap)
    const y = rowStartY + rowInCol * (rowH + rowGap)
    const r = twoCol ? 8 : 12

    // card
    ctx.fillStyle = theme.card
    canvasRoundRect(ctx, x, y, colWidth, rowH, r)
    ctx.fill()
    ctx.strokeStyle = isTop3 ? theme.medals[i] : theme.cardBorder
    ctx.lineWidth = isTop3 ? 2 : 1
    ctx.stroke()
    // left accent bar (gold for top 3, navy/gold theme accent otherwise)
    ctx.save()
    canvasRoundRect(ctx, x, y, colWidth, rowH, r)
    ctx.clip()
    ctx.fillStyle = isTop3 ? theme.medals[i] : theme.cardAccent
    ctx.fillRect(x, y, 5, rowH)
    ctx.restore()

    let cellX = x + rowPadX
    const cy = y + rowH / 2

    // rank: gold medallion circle for top 3, plain number otherwise
    if (isTop3 && !twoCol) {
      const mr = Math.min(rowH * 0.3, 17)
      ctx.beginPath()
      ctx.arc(cellX + rankW / 2, cy, mr, 0, Math.PI * 2)
      ctx.fillStyle = theme.medals[i]
      ctx.fill()
      ctx.strokeStyle = theme.medalRing
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.fillStyle = theme.medalText
      ctx.font = `900 ${Math.floor(mr * 1.05)}px ${FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(i + 1), cellX + rankW / 2, cy + 1)
    } else {
      ctx.font = `900 ${rankSize}px ${FONT}`
      ctx.fillStyle = isTop3 ? theme.medals[i] : theme.rank
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(i + 1), cellX + rankW / 2, cy)
    }
    cellX += rankW

    // logo
    const logoImg = logoImgs[i]
    if (logoImg) {
      drawImageContain(ctx, logoImg, cellX, cy - logoSize / 2, logoSize, logoSize)
    } else {
      ctx.fillStyle = theme.logoFallback
      canvasRoundRect(ctx, cellX, cy - logoSize / 2, logoSize, logoSize, 4)
      ctx.fill()
      ctx.font = `700 ${Math.floor(logoSize * 0.35)}px ${FONT}`
      ctx.fillStyle = theme.muted
      ctx.textAlign = 'center'
      ctx.fillText((subText || name).slice(0, 3).toUpperCase(), cellX + logoSize / 2, cy)
    }
    cellX += logoW

    // name + sub line
    const statsEndX = x + colWidth - rowPadX
    const nameMaxW = statsEndX - (extraCols.length * extraW + mainStatW) - recordW - cellX - 10

    if (twoCol) {
      ctx.font = `700 ${fontSize}px ${FONT}`
      ctx.fillStyle = theme.name
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      const dn = truncText(ctx, name, nameMaxW * 0.62)
      ctx.fillText(dn, cellX, cy)
      const nw = ctx.measureText(dn + ' ').width
      ctx.font = `500 ${Math.floor(fontSize * 0.78)}px ${FONT}`
      ctx.fillStyle = theme.secondary
      ctx.fillText(truncText(ctx, subText, Math.max(nameMaxW - nw, 0)), cellX + nw, cy)
    } else {
      const subSize = Math.floor(fontSize * 0.68)
      const gap = Math.floor(fontSize * 0.2)
      const nameY = subText || collegeText ? cy - (subSize + gap) / 2 : cy
      ctx.font = `700 ${fontSize}px ${FONT}`
      ctx.fillStyle = theme.name
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(truncText(ctx, name, nameMaxW), cellX, nameY)
      if (subText || collegeText) {
        const teamY = nameY + fontSize / 2 + gap + subSize / 2
        ctx.font = `500 ${subSize}px ${FONT}`
        ctx.fillStyle = theme.secondary
        const st = truncText(ctx, subText, nameMaxW * 0.6)
        ctx.fillText(st, cellX, teamY)
        if (collegeText) {
          const tw = ctx.measureText(st + ' ').width
          ctx.font = `600 ${Math.floor(fontSize * 0.56)}px ${FONT}`
          ctx.fillStyle = theme.muted
          ctx.fillText(truncText(ctx, collegeText, nameMaxW - tw - 6), cellX + tw + 6, teamY)
        }
      }
    }

    // stats from the right edge: extras → main stat → record
    let sX = statsEndX
    ctx.textBaseline = 'middle'
    for (let ei = extraCols.length - 1; ei >= 0; ei--) {
      ctx.font = `500 ${Math.floor(fontSize * 0.78)}px ${FONT}`
      ctx.fillStyle = theme.secondary
      ctx.textAlign = 'right'
      ctx.fillText(fmt(p[extraCols[ei].key], extraCols[ei].format), sX, cy)
      sX -= extraW
    }
    ctx.font = `900 ${Math.floor(fontSize * (twoCol ? 1.1 : 1.3))}px ${FONT}`
    ctx.fillStyle = isTop3 ? theme.mainStatTop3 : theme.mainStat
    ctx.textAlign = 'right'
    ctx.fillText(fmt(mainVal, config.format), sX, cy)
    sX -= mainStatW
    if (showRecord) {
      ctx.font = `600 ${Math.floor(fontSize * 0.78)}px ${FONT}`
      ctx.fillStyle = theme.secondary
      ctx.fillText(`${p.wins ?? 0}-${p.losses ?? 0}`, sX, cy)
    }
  }
}

// ════════════════════════════════════════════════════════════════
// The page component
// ════════════════════════════════════════════════════════════════
export default function WclLeaderboardGraphic() {
  const canvasRef = useRef(null)

  // ─── State (mirrors SocialGraphics) ───
  const [category, setCategory] = useState('batting')
  const [presetIdx, setPresetIdx] = useState(0)
  const [count, setCount] = useState(10)
  const [season, setSeason] = useState(CURRENT_SUMMER_SEASON)
  const [teamId, setTeamId] = useState('')
  const [qualified, setQualified] = useState(true)
  const [minSample, setMinSample] = useState('')
  const [customTitle, setCustomTitle] = useState('')
  const [mode, setMode] = useState('preset')   // 'preset' | 'custom'
  const [themeId, setThemeId] = useState('classic')
  const [exporting, setExporting] = useState(false)

  // Custom stat picker state
  const [customMainStat, setCustomMainStat] = useState('')
  const [customExtraCols, setCustomExtraCols] = useState([])

  const cat = CATEGORY_BY_ID[category]
  const preset = STAT_PRESETS[category]?.[presetIdx] || STAT_PRESETS[category]?.[0]
  const theme = buildTheme(THEMES.find(t => t.id === themeId) || THEMES[0])

  const { data: teams } = useApi('/summer/teams', { league: 'WCL' })

  // Reset preset + per-category controls on category switch
  useEffect(() => {
    setPresetIdx(0)
    setCustomMainStat('')
    setCustomExtraCols([])
    setMode('preset')
    setTeamId('')
    const c = CATEGORY_BY_ID[category]
    setMinSample(c?.sampleDefault ? String(c.sampleDefault) : '')
  }, [category])

  // ─── Active stat config (preset or custom) ───
  const activeConfig = (() => {
    if (mode === 'custom' && customMainStat) {
      const allStats = getAvailableStats(category)
      const mainDef = allStats.find(s => s.key === customMainStat)
      if (!mainDef) return preset
      return {
        key: mainDef.key,
        label: mainDef.label,
        sort: mainDef.key,
        dir: mainDef.dir,
        format: mainDef.format,
        title: `${mainDef.label} Leaders`,
        extra: customExtraCols.map(k => {
          const def = allStats.find(s => s.key === k)
          return def ? { key: def.key, label: def.label, format: def.format } : null
        }).filter(Boolean),
      }
    }
    return preset
  })()

  // ─── API params (only what each summer endpoint accepts) ───
  const sampleNum = minSample !== '' && minSample != null ? Number(minSample) : null
  const apiParams = {
    league: 'WCL',
    season,
    sort_by: activeConfig.sort,
    sort_dir: activeConfig.dir,
    limit: count,
    ...(cat.team && teamId && { team_id: teamId }),
  }
  if (cat.qualified && qualified) {
    apiParams.qualified = true
  } else if (cat.sampleParam && sampleNum != null) {
    apiParams[cat.sampleParam] = sampleNum
  }

  const { data: rawData, loading } = useApi(cat.endpoint, apiParams, [
    season, activeConfig.sort, activeConfig.dir, count, teamId,
    minSample, qualified, category, presetIdx, mode, customMainStat,
  ])
  const items = Array.isArray(rawData) ? rawData : rawData?.data || []

  const isTeamMode = cat.kind === 'team'
  const showRecord = isTeamMode && items.some(p => p.wins != null)
  const isTwoCol = useTwoColumns(count)
  const effectiveConfig = isTwoCol ? { ...activeConfig, extra: [] } : activeConfig

  const teamLabel = teamId
    ? (teams || []).find(t => String(t.id) === String(teamId))?.short_name || ''
    : ''
  const titleText = customTitle || (isTeamMode
    ? `WCL ${activeConfig.title}`
    : `Top ${count} WCL ${activeConfig.title}`)
  const subtitle = `${season} West Coast League`
    + (teamLabel ? ` · ${teamLabel}` : '')
    + (cat.qualified && !qualified ? ' · Unqualified' : '')
  const footerNote = (cat.qualified && qualified)
    ? 'Qualified'
    : (cat.sampleParam && sampleNum != null)
      ? `Min ${sampleNum} ${cat.sampleLabel}`
      : isTeamMode
        ? 'Team Stats'
        : 'All players'

  // ─── Render the canvas whenever inputs change ───
  // Async draws can overlap (logo loads await), so a token guards stale
  // renders from painting over newer ones.
  const renderToken = useRef(0)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const token = ++renderToken.current
    renderBoard(canvas, {
      items, config: effectiveConfig, title: titleText, subtitle, footerNote,
      theme, isTeamMode, count, twoCol: isTwoCol, showRecord, loading,
    }).then(() => {
      // nothing to do — last write wins thanks to the token check below
    }).catch(err => console.error('WCL board render failed:', err))
    return () => { if (renderToken.current === token) renderToken.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, loading, themeId, titleText, subtitle, footerNote, isTwoCol,
      count, showRecord, isTeamMode, JSON.stringify(effectiveConfig)])

  // ─── Export (same canvas the preview shows) ───
  const handleExport = useCallback(() => {
    if (!canvasRef.current || !items.length) return
    setExporting(true)
    try {
      const a = document.createElement('a')
      a.download = `wcl-${activeConfig.key}-top${count}-${season}.png`
      a.href = canvasRef.current.toDataURL('image/png')
      a.click()
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed. Check console for details')
    } finally {
      setExporting(false)
    }
  }, [items.length, activeConfig.key, count, season])

  // Toggle a custom extra col on/off (max 5 — same cap as spring)
  const toggleExtraCol = (key) => {
    setCustomExtraCols(prev => {
      if (prev.includes(key)) return prev.filter(k => k !== key)
      if (prev.length >= 5) return prev
      return [...prev, key]
    })
  }

  const scale = Math.min(600 / SIZE.w, 800 / SIZE.h)

  return (
    <div>
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">WCL Leaderboard Graphics</h1>
      <p className="text-sm text-gray-500 mb-5">
        Shareable West Coast League player and team stat cards (1080×1080).
      </p>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* ═══ LEFT: Controls ═══ */}
        <div className="lg:w-80 shrink-0 space-y-4">
          {/* Category + mode + stat */}
          <div className="bg-white rounded-lg shadow-sm border p-4">
            <label className="block text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Category</label>
            <div className="grid grid-cols-3 gap-1">
              {CATEGORIES.map(c => (
                <button key={c.id} onClick={() => setCategory(c.id)}
                  className={`px-2 py-1.5 text-xs font-semibold rounded transition-all
                    ${category === c.id ? 'bg-[#14365c] text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >{c.label}</button>
              ))}
            </div>

            <label className="block text-xs font-semibold text-gray-500 mt-3 mb-2 uppercase tracking-wide">Mode</label>
            <div className="flex gap-1">
              <button onClick={() => setMode('preset')}
                className={`flex-1 px-2 py-1.5 text-xs font-semibold rounded transition-all
                  ${mode === 'preset' ? 'bg-[#14365c] text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >Presets</button>
              <button onClick={() => setMode('custom')}
                className={`flex-1 px-2 py-1.5 text-xs font-semibold rounded transition-all
                  ${mode === 'custom' ? 'bg-[#14365c] text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >Custom</button>
            </div>

            {mode === 'preset' && (
              <>
                <label className="block text-xs font-semibold text-gray-500 mt-3 mb-2 uppercase tracking-wide">Board</label>
                <div className="flex flex-wrap gap-1">
                  {STAT_PRESETS[category].map((p, i) => (
                    <button key={p.key} onClick={() => setPresetIdx(i)}
                      className={`px-2.5 py-1 text-xs font-semibold rounded transition-all
                        ${presetIdx === i ? 'bg-[#c9a44c] text-[#0d2240] shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                    >{p.name}</button>
                  ))}
                </div>
              </>
            )}

            {mode === 'custom' && (
              <>
                <label className="block text-xs font-semibold text-gray-500 mt-3 mb-2 uppercase tracking-wide">Main Stat (ranked by)</label>
                <select value={customMainStat} onChange={e => setCustomMainStat(e.target.value)}
                  className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm">
                  <option value="">Select stat...</option>
                  {getSortableStats(category).map(s => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>

                {!isTwoCol && (
                  <>
                    <label className="block text-xs font-semibold text-gray-500 mt-3 mb-2 uppercase tracking-wide">
                      Extra Columns ({customExtraCols.length}/5)
                    </label>
                    <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                      {getAvailableStats(category).filter(s => s.key !== customMainStat).map(s => (
                        <button key={s.key} onClick={() => toggleExtraCol(s.key)}
                          className={`px-2 py-0.5 text-xs rounded transition-all
                            ${customExtraCols.includes(s.key)
                              ? 'bg-[#14365c] text-white shadow'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}
                            ${!customExtraCols.includes(s.key) && customExtraCols.length >= 5 ? 'opacity-40 cursor-not-allowed' : ''}`}
                        >{s.label}</button>
                      ))}
                    </div>
                  </>
                )}
                {isTwoCol && (
                  <p className="text-xs text-amber-600 mt-2">Extra columns hidden in 2-column layout (15+ rows).</p>
                )}
              </>
            )}
          </div>

          {/* Theme */}
          <div className="bg-white rounded-lg shadow-sm border p-4">
            <label className="block text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Theme</label>
            <div className="grid grid-cols-4 gap-2">
              {THEMES.map(t => (
                <button key={t.id} onClick={() => setThemeId(t.id)} title={t.label}
                  className={`h-9 rounded-md border-2 transition-all relative overflow-hidden
                    ${themeId === t.id ? 'border-[#c9a44c] ring-2 ring-[#c9a44c]/40 scale-105' : 'border-gray-200 hover:border-gray-300'}`}
                  style={{ background: buildTheme(t).swatch }}
                >
                  <span className="absolute inset-x-0 top-0 h-2" style={{ background: t.headerStops[0] }} />
                  <span className="absolute inset-x-0 top-2 h-0.5" style={{ background: t.headerRule }} />
                </button>
              ))}
            </div>
            <div className="text-[11px] text-gray-400 mt-1.5">{(THEMES.find(t => t.id === themeId) || THEMES[0]).label}</div>
          </div>

          {/* Stealth Batting Gloves co-brand promo (shown with the Stealth theme) */}
          {themeId === 'stealth' && (
            <div className="rounded-lg border border-gray-700 bg-gradient-to-b from-[#17181c] to-[#0b0b0e] p-4 text-center shadow-sm">
              <img src="/stealth/wordmark.png" alt="Stealth Batting Gloves — Dominate in Silence"
                className="mx-auto h-14 w-auto object-contain" />
              <a href="https://stealthbattinggloves.com" target="_blank" rel="noopener noreferrer"
                className="mt-2 inline-block text-sm font-semibold text-gray-200 underline decoration-gray-500 underline-offset-2 hover:text-white">
                stealthbattinggloves.com
              </a>
              <div className="mt-3 rounded-md bg-gradient-to-r from-[#d7dbe0] to-[#aab0b8] px-3 py-2">
                <span className="text-sm font-extrabold tracking-wide text-[#101114]">USE CODE NWBB FOR 15% OFF</span>
              </div>
              <p className="mt-2 text-[10px] uppercase tracking-[0.15em] text-gray-500">
                NW Baseball Stats × Stealth Batting Gloves
              </p>
            </div>
          )}

          {/* Filters */}
          <div className="bg-white rounded-lg shadow-sm border p-4 space-y-3">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">Filters</label>

            <div>
              <label className="text-xs text-gray-500">Season</label>
              <select value={season} onChange={e => setSeason(+e.target.value)}
                className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                {SUMMER_SEASONS.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>

            {cat.team && (
              <div>
                <label className="text-xs text-gray-500">Team</label>
                <select value={teamId} onChange={e => setTeamId(e.target.value)}
                  className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                  <option value="">All Teams</option>
                  {(teams || []).map(t => <option key={t.id} value={t.id}>{t.short_name || t.name}</option>)}
                </select>
              </div>
            )}

            {cat.qualified && (
              <div className="flex items-center justify-between">
                <label className="text-xs text-gray-500">Qualified Only</label>
                <button
                  onClick={() => setQualified(!qualified)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${qualified ? 'bg-[#14365c]' : 'bg-gray-300'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${qualified ? 'left-5' : 'left-0.5'}`} />
                </button>
              </div>
            )}

            {cat.sampleParam && !(cat.qualified && qualified) && (
              <div>
                <label className="text-xs text-gray-500">Min {cat.sampleLabel}</label>
                <input type="number" value={minSample} onChange={e => setMinSample(e.target.value)}
                  placeholder="0"
                  className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm" />
              </div>
            )}

            <div>
              <label className="text-xs text-gray-500"># {isTeamMode ? 'Teams' : 'Players'}</label>
              <select value={count} onChange={e => setCount(+e.target.value)}
                className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                {COUNT_OPTIONS.map(n => <option key={n} value={n}>Top {n}</option>)}
              </select>
            </div>

            {isTwoCol && (
              <p className="text-xs text-gray-400">
                Two-column layout active ({count} {isTeamMode ? 'teams' : 'players'}). Main stat only.
              </p>
            )}
          </div>

          {/* Export */}
          <div className="bg-white rounded-lg shadow-sm border p-4 space-y-3">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">Export</label>

            <div>
              <label className="text-xs text-gray-500">Custom Title (optional)</label>
              <input type="text" value={customTitle} onChange={e => setCustomTitle(e.target.value)}
                placeholder={titleText} maxLength={60}
                className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm" />
            </div>

            <button
              onClick={handleExport}
              disabled={exporting || loading || !items.length}
              className="w-full py-2.5 rounded-lg bg-[#14365c] text-white font-bold text-sm
                hover:bg-[#0d2240] transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                flex items-center justify-center gap-2"
            >
              {exporting ? 'Exporting...' : 'Download PNG'}
            </button>
          </div>
        </div>

        {/* ═══ RIGHT: Canvas preview (the same canvas that exports) ═══ */}
        <div className="flex-1 flex flex-col items-center">
          <div className="text-xs text-gray-400 mb-2">Preview (1080×1080)</div>
          <div style={{
            width: SIZE.w * scale,
            maxWidth: '100%',
            borderRadius: 8,
            overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(13,34,64,0.25)',
          }}>
            <canvas
              ref={canvasRef}
              style={{ width: '100%', height: 'auto', display: 'block' }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
