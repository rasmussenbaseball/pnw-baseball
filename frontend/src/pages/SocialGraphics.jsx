import { useState, useRef, useEffect, useCallback, forwardRef } from 'react'
import { useApi, useDivisions, useConferences } from '../hooks/useApi'
import { SEASONS, CURRENT_SEASON } from '../lib/seasons'

// ─── Fixed 1080x1080 ───
const SIZE = { w: 1080, h: 1080 }

// ─── Card themes ───
// Every scheme is dark (white text). A theme is defined by three gradient
// stops (160deg, at 0% / 35% / 100%), an accent color used for the top-3
// highlight + glow, and the RGB triples that drive the decorative orbs and
// the top-3 row tint. buildTheme() expands a palette into the full object
// the preview card AND the canvas exporter consume, so both stay in sync.
const SHARED_TEXT = {
  textPrimary: '#ffffff',
  textSecondary: 'rgba(255,255,255,0.45)',
  textMuted: 'rgba(255,255,255,0.25)',
  border: 'rgba(255,255,255,0.08)',
  rowAlt: 'rgba(255,255,255,0.025)',
}

const THEMES = [
  { id: 'teal',     label: 'Midnight Teal', stops: ['#0a1628', '#0f2744', '#00687a'],
    accent: '#7dd3fc', accentRGB: '125,211,252', highlightRGB: '0,138,158',
    orb1RGB: '0,104,122', orb2RGB: '0,138,158', mainStat: '#e0f2fe' },
  { id: 'crimson',  label: 'Crimson Night', stops: ['#1a0a0f', '#2d0f1a', '#7a1f2b'],
    accent: '#fca5a5', accentRGB: '252,165,165', highlightRGB: '180,40,60',
    orb1RGB: '122,31,43', orb2RGB: '158,40,55', mainStat: '#fee2e2' },
  { id: 'forest',   label: 'Forest', stops: ['#07150f', '#0f2a1e', '#1f7a52'],
    accent: '#6ee7b7', accentRGB: '110,231,183', highlightRGB: '31,122,82',
    orb1RGB: '15,90,60', orb2RGB: '31,122,82', mainStat: '#d1fae5' },
  { id: 'royal',    label: 'Royal Purple', stops: ['#140a28', '#241046', '#5b21b6'],
    accent: '#c4b5fd', accentRGB: '196,181,253', highlightRGB: '91,33,182',
    orb1RGB: '70,30,130', orb2RGB: '91,33,182', mainStat: '#ede9fe' },
  { id: 'graphite', label: 'Graphite', stops: ['#0b0e14', '#1a1f2b', '#36404f'],
    accent: '#cbd5e1', accentRGB: '203,213,225', highlightRGB: '90,104,128',
    orb1RGB: '54,64,79', orb2RGB: '90,104,128', mainStat: '#e2e8f0' },
]

function buildTheme(palette) {
  const [c0, c1, c2] = palette.stops
  return {
    ...SHARED_TEXT,
    id: palette.id,
    label: palette.label,
    stops: palette.stops,            // raw, for canvas gradient
    bg: `linear-gradient(160deg, ${c0} 0%, ${c1} 35%, ${c2} 100%)`,
    accent: palette.accent,
    accentRGB: palette.accentRGB,
    accentGlow: `rgba(${palette.accentRGB},0.3)`,
    highlightRGB: palette.highlightRGB,
    highlight: `rgba(${palette.highlightRGB},`,   // suffix `${opacity})`
    orb1RGB: palette.orb1RGB,
    orb2RGB: palette.orb2RGB,
    orb1: `rgba(${palette.orb1RGB},0.3)`,
    orb2: `rgba(${palette.orb2RGB},0.15)`,
    mainStat: palette.mainStat,
  }
}

// ─── All available stats with metadata ───
const ALL_BATTING_STATS = [
  { key: 'wrc_plus',     label: 'wRC+',   format: 'int',  dir: 'desc' },
  { key: 'batting_avg',  label: 'AVG',    format: 'avg',  dir: 'desc' },
  { key: 'home_runs',    label: 'HR',     format: 'int',  dir: 'desc' },
  { key: 'stolen_bases', label: 'SB',     format: 'int',  dir: 'desc' },
  { key: 'woba',         label: 'wOBA',   format: 'avg',  dir: 'desc' },
  { key: 'wobacon',      label: 'wOBACON',format: 'avg',  dir: 'desc' },
  { key: 'offensive_war',label: 'oWAR',   format: 'war',  dir: 'desc' },
  { key: 'on_base_pct',  label: 'OBP',    format: 'avg',  dir: 'desc' },
  { key: 'slugging_pct', label: 'SLG',    format: 'avg',  dir: 'desc' },
  { key: 'ops',          label: 'OPS',    format: 'avg',  dir: 'desc' },
  { key: 'iso',          label: 'ISO',    format: 'avg',  dir: 'desc' },
  { key: 'hits',         label: 'H',      format: 'int',  dir: 'desc' },
  { key: 'runs',         label: 'R',      format: 'int',  dir: 'desc' },
  { key: 'rbi',          label: 'RBI',    format: 'int',  dir: 'desc' },
  { key: 'doubles',      label: '2B',     format: 'int',  dir: 'desc' },
  { key: 'triples',      label: '3B',     format: 'int',  dir: 'desc' },
  { key: 'walks',        label: 'BB',     format: 'int',  dir: 'desc' },
  { key: 'hit_by_pitch', label: 'HBP',    format: 'int',  dir: 'desc' },
  { key: 'strikeouts',   label: 'SO',     format: 'int',  dir: 'asc'  },
  { key: 'at_bats',      label: 'AB',     format: 'int',  dir: 'desc' },
  { key: 'caught_stealing', label: 'CS',  format: 'int',  dir: 'asc'  },
  { key: 'sacrifice_flies', label: 'SF',  format: 'int',  dir: 'desc' },
  { key: 'babip',        label: 'BABIP',  format: 'avg',  dir: 'desc' },
  { key: 'bb_pct',       label: 'BB%',    format: 'pct',  dir: 'desc' },
  { key: 'k_pct',        label: 'K%',     format: 'pct',  dir: 'asc'  },
  { key: 'wraa',         label: 'wRAA',   format: 'war',  dir: 'desc' },
  { key: 'wrc',          label: 'wRC',    format: 'war',  dir: 'desc' },
  { key: 'plate_appearances', label: 'PA', format: 'int', dir: 'desc' },
  { key: 'games',        label: 'G',      format: 'int',  dir: 'desc' },
]

const ALL_PITCHING_STATS = [
  { key: 'fip_plus',     label: 'FIP+',   format: 'int',  dir: 'desc' },
  { key: 'era',          label: 'ERA',    format: 'era',  dir: 'asc'  },
  { key: 'era_plus',     label: 'ERA+',   format: 'int',  dir: 'desc' },
  { key: 'strikeouts',   label: 'K',      format: 'int',  dir: 'desc' },
  { key: 'pitching_war', label: 'pWAR',   format: 'war',  dir: 'desc' },
  { key: 'fip',          label: 'FIP',    format: 'era',  dir: 'asc'  },
  { key: 'whip',         label: 'WHIP',   format: 'era',  dir: 'asc'  },
  { key: 'k_pct',        label: 'K%',     format: 'pct',  dir: 'desc' },
  { key: 'bb_pct',       label: 'BB%',    format: 'pct',  dir: 'asc'  },
  { key: 'xfip',         label: 'xFIP',   format: 'era',  dir: 'asc'  },
  { key: 'siera',        label: 'SIERA',  format: 'era',  dir: 'asc'  },
  { key: 'innings_pitched', label: 'IP',  format: 'ip',   dir: 'desc' },
  { key: 'wins',         label: 'W',      format: 'int',  dir: 'desc' },
  { key: 'losses',       label: 'L',      format: 'int',  dir: 'asc'  },
  { key: 'saves',        label: 'SV',     format: 'int',  dir: 'desc' },
  { key: 'k_per_9',      label: 'K/9',    format: 'era',  dir: 'desc' },
  { key: 'bb_per_9',     label: 'BB/9',   format: 'era',  dir: 'asc'  },
  { key: 'h_per_9',      label: 'H/9',    format: 'era',  dir: 'asc'  },
  { key: 'hr_per_9',     label: 'HR/9',   format: 'era',  dir: 'asc'  },
  { key: 'k_bb_ratio',   label: 'K/BB',   format: 'era',  dir: 'desc' },
  { key: 'babip_against',label: 'BABIP',  format: 'avg',  dir: 'asc'  },
  { key: 'baa',          label: 'BAA',    format: 'avg',  dir: 'asc'  },
  { key: 'lob_pct',      label: 'LOB%',   format: 'pct',  dir: 'desc' },
  { key: 'quality_starts',label: 'QS',    format: 'int',  dir: 'desc' },
  { key: 'complete_games',label: 'CG',    format: 'int',  dir: 'desc' },
  { key: 'shutouts',     label: 'SHO',    format: 'int',  dir: 'desc' },
  { key: 'games',        label: 'G',      format: 'int',  dir: 'desc' },
  { key: 'games_started',label: 'GS',     format: 'int',  dir: 'desc' },
  { key: 'era_minus',    label: 'ERA-',   format: 'int',  dir: 'asc'  },
  { key: 'kwera',        label: 'kwERA',  format: 'era',  dir: 'asc'  },
  { key: 'k_bb_pct',     label: 'K-BB%',  format: 'pct',  dir: 'desc' },
]

const ALL_TEAM_BATTING_STATS = [
  { key: 'total_hr',      label: 'HR',     format: 'int',  dir: 'desc' },
  { key: 'team_avg',      label: 'AVG',    format: 'avg',  dir: 'desc' },
  { key: 'total_runs',    label: 'R',      format: 'int',  dir: 'desc' },
  { key: 'total_rbi',     label: 'RBI',    format: 'int',  dir: 'desc' },
  { key: 'total_sb',      label: 'SB',     format: 'int',  dir: 'desc' },
  { key: 'total_hits',    label: 'H',      format: 'int',  dir: 'desc' },
  { key: 'team_obp',      label: 'OBP',    format: 'avg',  dir: 'desc' },
  { key: 'team_slg',      label: 'SLG',    format: 'avg',  dir: 'desc' },
  { key: 'team_ops',      label: 'OPS',    format: 'avg',  dir: 'desc' },
  { key: 'avg_woba',      label: 'wOBA',   format: 'avg',  dir: 'desc' },
  { key: 'avg_wrc_plus',  label: 'wRC+',   format: 'int',  dir: 'desc' },
  { key: 'avg_iso',       label: 'ISO',    format: 'avg',  dir: 'desc' },
  { key: 'total_owar',    label: 'oWAR',   format: 'war',  dir: 'desc' },
]

const ALL_TEAM_PITCHING_STATS = [
  { key: 'team_era',      label: 'ERA',    format: 'era',  dir: 'asc'  },
  { key: 'team_whip',     label: 'WHIP',   format: 'era',  dir: 'asc'  },
  { key: 'avg_fip',       label: 'FIP',    format: 'era',  dir: 'asc'  },
  { key: 'avg_fip_plus',  label: 'FIP+',   format: 'int',  dir: 'desc' },
  { key: 'avg_era_plus',  label: 'ERA+',   format: 'int',  dir: 'desc' },
  { key: 'avg_xfip',      label: 'xFIP',   format: 'era',  dir: 'asc'  },
  { key: 'total_k',       label: 'K',      format: 'int',  dir: 'desc' },
  { key: 'total_pwar',    label: 'pWAR',   format: 'war',  dir: 'desc' },
  { key: 'total_ip',      label: 'IP',     format: 'ip',   dir: 'desc' },
  { key: 'pitching_k_pct',  label: 'K%',   format: 'pct',  dir: 'desc' },
  { key: 'pitching_bb_pct', label: 'BB%',  format: 'pct',  dir: 'asc'  },
]

const ALL_TEAM_COMBINED_STATS = [
  { key: 'total_war',     label: 'WAR',    format: 'war',  dir: 'desc' },
]

// WAR leaderboard rows carry both batting and pitching components (a
// pitcher's hitting fields are null and vice-versa — extra cols render "-").
const ALL_WAR_STATS = [
  { key: 'total_war',        label: 'WAR',    format: 'war', dir: 'desc' },
  { key: 'offensive_war',    label: 'oWAR',   format: 'war', dir: 'desc' },
  { key: 'pitching_war',     label: 'pWAR',   format: 'war', dir: 'desc' },
  { key: 'war_per_pa',       label: 'WAR/PA', format: 'avg', dir: 'desc' },
  { key: 'war_per_ip',       label: 'WAR/IP', format: 'avg', dir: 'desc' },
  { key: 'wrc_plus',         label: 'wRC+',   format: 'int', dir: 'desc' },
  { key: 'woba',             label: 'wOBA',   format: 'avg', dir: 'desc' },
  { key: 'wobacon',          label: 'wOBACON',format: 'avg', dir: 'desc' },
  { key: 'batting_avg',      label: 'AVG',    format: 'avg', dir: 'desc' },
  { key: 'plate_appearances',label: 'PA',     format: 'int', dir: 'desc' },
  { key: 'era',              label: 'ERA',    format: 'era', dir: 'asc'  },
  { key: 'era_plus',         label: 'ERA+',   format: 'int', dir: 'desc' },
  { key: 'fip',              label: 'FIP',    format: 'era', dir: 'asc'  },
  { key: 'fip_plus',         label: 'FIP+',   format: 'int', dir: 'desc' },
  { key: 'innings_pitched',  label: 'IP',     format: 'ip',  dir: 'desc' },
  { key: 'k_per_9',          label: 'K/9',    format: 'era', dir: 'desc' },
  { key: 'whip',             label: 'WHIP',   format: 'era', dir: 'asc'  },
  { key: 'wins',             label: 'W',      format: 'int', dir: 'desc' },
]

// ─── Fielding (/leaderboards/fielding) ───
const ALL_FIELDING_STATS = [
  { key: 'fielding_pct',          label: 'FLD%',  format: 'avg', dir: 'desc' },
  { key: 'range_factor',          label: 'RF/9',  format: 'era', dir: 'desc' },
  { key: 'putouts',               label: 'PO',    format: 'int', dir: 'desc' },
  { key: 'assists',               label: 'A',     format: 'int', dir: 'desc' },
  { key: 'errors',                label: 'E',     format: 'int', dir: 'asc'  },
  { key: 'double_plays',          label: 'DP',    format: 'int', dir: 'desc' },
  { key: 'triple_plays',          label: 'TP',    format: 'int', dir: 'desc' },
  { key: 'total_chances',         label: 'TC',    format: 'int', dir: 'desc' },
  { key: 'innings',               label: 'INN',   format: 'era', dir: 'desc' },
  { key: 'games',                 label: 'G',     format: 'int', dir: 'desc' },
  { key: 'games_started',         label: 'GS',    format: 'int', dir: 'desc' },
  { key: 'pickoffs',              label: 'PK',    format: 'int', dir: 'desc' },
  // Catcher
  { key: 'caught_stealing_by',    label: 'CS',    format: 'int', dir: 'desc' },
  { key: 'stolen_bases_against',  label: 'SBA',   format: 'int', dir: 'asc'  },
  { key: 'cs_pct',                label: 'CS%',   format: 'avg', dir: 'desc' },
  { key: 'passed_balls',          label: 'PB',    format: 'int', dir: 'asc'  },
]

// ─── Relievers / Clutch (/leaderboards/relievers). IP is stored as outs;
// WPA is signed. Both get bespoke formats. `sort` differs from `key` for IP.
const ALL_RELIEVER_STATS = [
  { key: 'wpa',       sort: 'wpa',       label: 'WPA',    format: 'wpa',     dir: 'desc' },
  { key: 'geg',       label: 'GEG',    format: 'int',     dir: 'desc' },
  { key: 'goose_pct', label: 'Goose%', format: 'pct',     dir: 'desc' },
  { key: 'brk',       label: 'BRK',    format: 'int',     dir: 'asc'  },
  { key: 'opp',       label: 'OPP',    format: 'int',     dir: 'desc' },
  { key: 'app',       label: 'App',    format: 'int',     dir: 'desc' },
  { key: 'outs',      sort: 'ip',      label: 'IP',     format: 'outs_ip', dir: 'desc' },
  { key: 'bf',        label: 'BF',     format: 'int',     dir: 'desc' },
  { key: 'k_pct',     label: 'K%',     format: 'pct',     dir: 'desc' },
  { key: 'bb_pct',    label: 'BB%',    format: 'pct',     dir: 'asc'  },
  { key: 'ra9',       label: 'RA9',    format: 'era',     dir: 'asc'  },
  { key: 'whip',      label: 'WHIP',   format: 'era',     dir: 'asc'  },
  { key: 'k',         label: 'K',      format: 'int',     dir: 'desc' },
  { key: 'bb',        label: 'BB',     format: 'int',     dir: 'asc'  },
  { key: 'h',         label: 'H',      format: 'int',     dir: 'asc'  },
  { key: 'r',         label: 'R',      format: 'int',     dir: 'asc'  },
]

// ─── Hitting PBP (/leaderboards/batting-pbp) ───
const ALL_BATTING_PBP_STATS = [
  { key: 'whiff_pct',      label: 'Whiff%',  format: 'pct', dir: 'asc'  },
  { key: 'contact_pct',    label: 'Contact%',format: 'pct', dir: 'desc' },
  { key: 'swing_pct',      label: 'Swing%',  format: 'pct', dir: 'desc' },
  { key: 'fb_pct',         label: 'FB%',     format: 'pct', dir: 'desc' },
  { key: 'air_pull_pct',   label: 'AirPull%',format: 'pct', dir: 'desc' },
  { key: 'putaway_pct',    label: 'PA-K%',   format: 'pct', dir: 'asc'  },
  { key: 'pitches_per_pa', label: 'P/PA',    format: 'era', dir: 'desc' },
  { key: 'tracked_pa',     label: 'PA',      format: 'int', dir: 'desc' },
  { key: 'pitches',        label: 'Pit',     format: 'int', dir: 'desc' },
  { key: 'swings',         label: 'Sw',      format: 'int', dir: 'desc' },
]

// ─── Pitching PBP (/leaderboards/pitching-pbp). tracked_pa = BF. ───
const ALL_PITCHING_PBP_STATS = [
  { key: 'whiff_pct',              label: 'Whiff%', format: 'pct', dir: 'desc' },
  { key: 'strike_pct',             label: 'Str%',   format: 'pct', dir: 'desc' },
  { key: 'first_pitch_strike_pct', label: 'F-Str%', format: 'pct', dir: 'desc' },
  { key: 'called_strike_pct',      label: 'CSt%',   format: 'pct', dir: 'desc' },
  { key: 'contact_pct',            label: 'Contact%',format:'pct', dir: 'asc'  },
  { key: 'gb_pct',                 label: 'GB%',    format: 'pct', dir: 'desc' },
  { key: 'putaway_pct',            label: 'Putaway%',format:'pct', dir: 'desc' },
  { key: 'on_or_out_3_pct',        label: 'OO3%',   format: 'pct', dir: 'desc' },
  { key: 'pitches_per_pa',         label: 'P/BF',   format: 'era', dir: 'asc'  },
  { key: 'tracked_pa',             label: 'BF',     format: 'int', dir: 'desc' },
  { key: 'pitches',                label: 'Pit',    format: 'int', dir: 'desc' },
  { key: 'swings',                 label: 'Sw',     format: 'int', dir: 'desc' },
]

// ─── Category metadata: endpoint + which filters each one supports.
// Filters that an endpoint doesn't accept are hidden AND never sent, so we
// never mis-rank by passing an ignored param. sampleParam/sampleLabel drive
// the "Min ___" input; sampleDefault keeps small-sample noise off boards
// that have no qualified toggle (PBP / fielding / relievers).
const CATEGORIES = [
  { id: 'batting',      label: 'Batting',  endpoint: '/leaderboards/batting',      kind: 'player',
    division: true, conf: true, state: true, confOnly: true, posGroup: true, qualified: true, year: true,
    sampleParam: 'min_pa', sampleLabel: 'PA', sampleDefault: 0 },
  { id: 'pitching',     label: 'Pitching', endpoint: '/leaderboards/pitching',     kind: 'player',
    division: true, conf: true, state: true, confOnly: true, qualified: true, year: true,
    sampleParam: 'min_ip', sampleLabel: 'IP', sampleDefault: 0 },
  { id: 'fielding',     label: 'Fielding', endpoint: '/leaderboards/fielding',     kind: 'player',
    division: true, conf: true, state: true, posExact: true, year: true,
    sampleParam: 'min_games', sampleLabel: 'G', sampleDefault: 5 },
  { id: 'batting_pbp',  label: 'Hit PBP',  endpoint: '/leaderboards/batting-pbp',  kind: 'player',
    division: true, conf: true, state: true, year: true,
    sampleParam: 'min_pa', sampleLabel: 'PA', sampleDefault: 30 },
  { id: 'pitching_pbp', label: 'Pit PBP',  endpoint: '/leaderboards/pitching-pbp', kind: 'player',
    division: true, conf: true, state: true, year: true,
    sampleParam: 'min_bf', sampleLabel: 'BF', sampleDefault: 40 },
  { id: 'relievers',    label: 'Bullpen',  endpoint: '/leaderboards/relievers',    kind: 'player',
    division: true, conf: true, state: true, year: true,
    sampleParam: 'min_bf', sampleLabel: 'BF', sampleDefault: 20 },
  { id: 'war',          label: 'WAR',      endpoint: '/leaderboards/war',          kind: 'player',
    division: true, conf: true, confOnly: true, posGroup: true, qualified: true, year: true,
    sampleParam: 'min_pa_ip', sampleLabel: 'PA/IP', sampleDefault: 0 },
  // Clubs are membership boards (every qualifier, not a top-N cut). They
  // hit /leaderboards/clubs with a `club` id and render ALL members.
  { id: 'clubs',        label: 'Clubs',    endpoint: '/leaderboards/clubs',        kind: 'player',
    club: true, division: true, conf: true, state: true, year: true, sampleParam: null },
  { id: 'teams',        label: 'Teams',    endpoint: '/leaderboards/teams',        kind: 'team',
    division: true, sampleParam: null },
  { id: 'team_batting_pbp',  label: 'Tm Hit PBP', endpoint: '/leaderboards/team-batting-pbp',  kind: 'team',
    division: true, conf: true, state: true,
    sampleParam: 'min_pa', sampleLabel: 'PA', sampleDefault: 200 },
  { id: 'team_pitching_pbp', label: 'Tm Pit PBP', endpoint: '/leaderboards/team-pitching-pbp', kind: 'team',
    division: true, conf: true, state: true,
    sampleParam: 'min_bf', sampleLabel: 'BF', sampleDefault: 200 },
]
const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]))

// Server-side sort whitelists (mirror routes.py). A stat can only be the
// MAIN (ranked-by) stat if its sort key is here; otherwise the backend would
// silently fall back to its default sort and the board would be mis-ranked.
// Extra (display-only) columns can be ANY returned field.
const SORTABLE = {
  batting: new Set(['babip','batting_avg','bb_pct','doubles','hits','home_runs','iso','k_pct','offensive_war','on_base_pct','ops','plate_appearances','rbi','runs','slugging_pct','stolen_bases','strikeouts','triples','walks','woba','wobacon','wrc_plus']),
  pitching: new Set(['baa','babip_against','bb_pct','bb_per_9','era','era_minus','era_plus','fip','fip_plus','hr_per_9','innings_pitched','k_bb_pct','k_bb_ratio','k_pct','k_per_9','kwera','lob_pct','losses','pitching_war','quality_starts','saves','siera','strikeouts','whip','wins','xfip']),
  war: new Set(['batting_avg','era','era_minus','era_plus','fip','fip_plus','innings_pitched','k_per_9','offensive_war','pitching_war','plate_appearances','total_war','war_per_ip','war_per_pa','whip','wins','woba','wobacon','wrc_plus']),
  teams: new Set(['avg_bb_pct','avg_era_plus','avg_fip','avg_fip_plus','avg_iso','avg_k_pct','avg_woba','avg_wrc_plus','avg_xfip','pitching_bb_pct','pitching_k_pct','team_avg','team_era','team_obp','team_ops','team_slg','team_whip','total_hits','total_hr','total_ip','total_k','total_owar','total_pwar','total_rbi','total_runs','total_sb','total_war']),
  fielding: new Set(['assists','caught_stealing_by','cs_pct','double_plays','errors','fielding_pct','games','games_started','innings','passed_balls','pickoffs','putouts','range_factor','stolen_bases_against','total_chances','triple_plays']),
  relievers: new Set(['app','bb','bb_pct','bf','brk','geg','goose_pct','h','ip','k','k_pct','opp','r','ra9','whip','wpa']),
  batting_pbp: new Set(['air_pull_pct','contact_pct','fb_pct','pitches','pitches_per_pa','putaway_pct','swing_pct','swings','tracked_pa','whiff_pct']),
  pitching_pbp: new Set(['called_strike_pct','contact_pct','first_pitch_strike_pct','gb_pct','on_or_out_3_pct','pitches','pitches_per_pa','putaway_pct','strike_pct','swings','tracked_pa','whiff_pct']),
}
// Team-PBP boards rank by the same keys as their per-player counterparts.
SORTABLE.team_batting_pbp = SORTABLE.batting_pbp
SORTABLE.team_pitching_pbp = SORTABLE.pitching_pbp

// ─── Stat presets for quick access ───
const STAT_PRESETS = {
  batting: [
    { key: 'wrc_plus',     label: 'wRC+',   sort: 'wrc_plus',     dir: 'desc', format: 'int',  title: 'wRC+ Leaders', endpoint: '/leaderboards/batting',
      extra: [
        { key: 'batting_avg', label: 'AVG', format: 'avg' },
        { key: 'on_base_pct', label: 'OBP', format: 'avg' },
        { key: 'slugging_pct', label: 'SLG', format: 'avg' },
        { key: 'woba', label: 'wOBA', format: 'avg' },
        { key: 'bb_pct', label: 'BB%', format: 'pct' },
      ] },
    { key: 'batting_avg',  label: 'AVG',    sort: 'batting_avg',  dir: 'desc', format: 'avg',  title: 'Batting Avg Leaders', endpoint: '/leaderboards/batting',
      extra: [
        { key: 'hits', label: 'H', format: 'int' },
        { key: 'on_base_pct', label: 'OBP', format: 'avg' },
        { key: 'slugging_pct', label: 'SLG', format: 'avg' },
        { key: 'wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'plate_appearances', label: 'PA', format: 'int' },
      ] },
    { key: 'home_runs',    label: 'HR',     sort: 'home_runs',    dir: 'desc', format: 'int',  title: 'Home Run Leaders', endpoint: '/leaderboards/batting',
      extra: [
        { key: 'slugging_pct', label: 'SLG', format: 'avg' },
        { key: 'iso', label: 'ISO', format: 'avg' },
        { key: 'wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'rbi', label: 'RBI', format: 'int' },
        { key: 'plate_appearances', label: 'PA', format: 'int' },
      ] },
    { key: 'stolen_bases',  label: 'SB',    sort: 'stolen_bases', dir: 'desc', format: 'int',  title: 'Stolen Base Leaders', endpoint: '/leaderboards/batting',
      extra: [
        { key: 'batting_avg', label: 'AVG', format: 'avg' },
        { key: 'on_base_pct', label: 'OBP', format: 'avg' },
        { key: 'runs', label: 'R', format: 'int' },
        { key: 'wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'plate_appearances', label: 'PA', format: 'int' },
      ] },
    { key: 'woba',          label: 'wOBA',  sort: 'woba',         dir: 'desc', format: 'avg',  title: 'wOBA Leaders', endpoint: '/leaderboards/batting',
      extra: [
        { key: 'batting_avg', label: 'AVG', format: 'avg' },
        { key: 'wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'ops', label: 'OPS', format: 'avg' },
        { key: 'bb_pct', label: 'BB%', format: 'pct' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
      ] },
    { key: 'offensive_war', label: 'oWAR',  sort: 'offensive_war', dir: 'desc', format: 'war', title: 'Offensive WAR Leaders', endpoint: '/leaderboards/batting',
      extra: [
        { key: 'wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'woba', label: 'wOBA', format: 'avg' },
        { key: 'batting_avg', label: 'AVG', format: 'avg' },
        { key: 'home_runs', label: 'HR', format: 'int' },
        { key: 'plate_appearances', label: 'PA', format: 'int' },
      ] },
  ],
  pitching: [
    { key: 'fip_plus',     label: 'FIP+',   sort: 'fip_plus',     dir: 'desc', format: 'int',  title: 'FIP+ Leaders', endpoint: '/leaderboards/pitching',
      extra: [
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'fip', label: 'FIP', format: 'era' },
        { key: 'xfip', label: 'xFIP', format: 'era' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { key: 'era',           label: 'ERA',    sort: 'era',          dir: 'asc',  format: 'era',  title: 'ERA Leaders', endpoint: '/leaderboards/pitching',
      extra: [
        { key: 'fip', label: 'FIP', format: 'era' },
        { key: 'whip', label: 'WHIP', format: 'era' },
        { key: 'fip_plus', label: 'FIP+', format: 'int' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { key: 'era_plus',      label: 'ERA+',   sort: 'era_plus',     dir: 'desc', format: 'int',  title: 'ERA+ Leaders', endpoint: '/leaderboards/pitching',
      extra: [
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'fip', label: 'FIP', format: 'era' },
        { key: 'fip_plus', label: 'FIP+', format: 'int' },
        { key: 'bb_pct', label: 'BB%', format: 'pct' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { key: 'strikeouts',    label: 'K',      sort: 'strikeouts',   dir: 'desc', format: 'int',  title: 'Strikeout Leaders', endpoint: '/leaderboards/pitching',
      extra: [
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'bb_pct', label: 'BB%', format: 'pct' },
        { key: 'fip_plus', label: 'FIP+', format: 'int' },
        { key: 'siera', label: 'SIERA', format: 'era' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { key: 'pitching_war',  label: 'pWAR',   sort: 'pitching_war', dir: 'desc', format: 'war',  title: 'Pitching WAR Leaders', endpoint: '/leaderboards/pitching',
      extra: [
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'fip_plus', label: 'FIP+', format: 'int' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'xfip', label: 'xFIP', format: 'era' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { key: 'fip',           label: 'FIP',    sort: 'fip',          dir: 'asc',  format: 'era',  title: 'FIP Leaders', endpoint: '/leaderboards/pitching',
      extra: [
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'fip_plus', label: 'FIP+', format: 'int' },
        { key: 'xfip', label: 'xFIP', format: 'era' },
        { key: 'siera', label: 'SIERA', format: 'era' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { key: 'saves',         label: 'SV',     sort: 'saves',        dir: 'desc', format: 'int',  title: 'Saves Leaders', endpoint: '/leaderboards/pitching',
      extra: [
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'whip', label: 'WHIP', format: 'era' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'fip', label: 'FIP', format: 'era' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
      ] },
    { key: 'wins',          label: 'W',      sort: 'wins',         dir: 'desc', format: 'int',  title: 'Wins Leaders', endpoint: '/leaderboards/pitching',
      extra: [
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
        { key: 'strikeouts', label: 'K', format: 'int' },
        { key: 'fip_plus', label: 'FIP+', format: 'int' },
        { key: 'whip', label: 'WHIP', format: 'era' },
      ] },
  ],
  war: [
    { key: 'total_war',    label: 'WAR',    sort: 'total_war',    dir: 'desc', format: 'war',  title: 'WAR Leaders', endpoint: '/leaderboards/war',
      extra: [
        { key: 'offensive_war', label: 'oWAR', format: 'war' },
        { key: 'pitching_war', label: 'pWAR', format: 'war' },
        { key: 'wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'era', label: 'ERA', format: 'era' },
      ] },
    { key: 'offensive_war', label: 'oWAR',  sort: 'offensive_war', dir: 'desc', format: 'war', title: 'Offensive WAR Leaders', endpoint: '/leaderboards/war',
      extra: [
        { key: 'wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'woba', label: 'wOBA', format: 'avg' },
        { key: 'batting_avg', label: 'AVG', format: 'avg' },
        { key: 'plate_appearances', label: 'PA', format: 'int' },
      ] },
    { key: 'pitching_war',  label: 'pWAR',  sort: 'pitching_war', dir: 'desc', format: 'war', title: 'Pitching WAR Leaders', endpoint: '/leaderboards/war',
      extra: [
        { key: 'era', label: 'ERA', format: 'era' },
        { key: 'fip_plus', label: 'FIP+', format: 'int' },
        { key: 'innings_pitched', label: 'IP', format: 'ip' },
        { key: 'whip', label: 'WHIP', format: 'era' },
      ] },
  ],
  // Membership clubs. `clubId` + threshold fields are sent to /leaderboards/clubs.
  // `sort` here is only used to vary useApi deps between presets (the server
  // orders by its own club logic). All members render — no top-N cut.
  clubs: [
    { key: 'home_runs', clubId: 'hr_sb', label: 'HR', sort: 'home_runs', dir: 'desc', format: 'int',
      title: '10/10 Club', endpoint: '/leaderboards/clubs', hrMin: 10, sbMin: 10,
      criteria: '10+ HR & 10+ SB',
      extra: [
        { key: 'stolen_bases', label: 'SB', format: 'int' },
        { key: 'batting_avg', label: 'AVG', format: 'avg' },
        { key: 'ops', label: 'OPS', format: 'avg' },
        { key: 'rbi', label: 'RBI', format: 'int' },
        { key: 'games', label: 'G', format: 'int' },
      ] },
    { key: 'games', clubId: 'ironman', label: 'G', sort: 'games', dir: 'desc', format: 'int',
      title: 'Baseball Ironmen', endpoint: '/leaderboards/clubs', minTeamGames: 20,
      criteria: 'Played every team game',
      extra: [
        { key: 'batting_avg', label: 'AVG', format: 'avg' },
        { key: 'ops', label: 'OPS', format: 'avg' },
        { key: 'home_runs', label: 'HR', format: 'int' },
        { key: 'rbi', label: 'RBI', format: 'int' },
        { key: 'stolen_bases', label: 'SB', format: 'int' },
      ] },
  ],
  teams: [
    { key: 'total_hr',     label: 'HR',     sort: 'total_hr',     dir: 'desc', format: 'int',  title: 'Team HR Leaders', endpoint: '/leaderboards/teams',
      extra: [
        { key: 'team_slg', label: 'SLG', format: 'avg' },
        { key: 'total_runs', label: 'R', format: 'int' },
        { key: 'avg_wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'avg_iso', label: 'ISO', format: 'avg' },
      ] },
    { key: 'team_avg',     label: 'AVG',    sort: 'team_avg',     dir: 'desc', format: 'avg',  title: 'Team AVG Leaders', endpoint: '/leaderboards/teams',
      extra: [
        { key: 'team_obp', label: 'OBP', format: 'avg' },
        { key: 'team_slg', label: 'SLG', format: 'avg' },
        { key: 'total_hits', label: 'H', format: 'int' },
        { key: 'avg_wrc_plus', label: 'wRC+', format: 'int' },
      ] },
    { key: 'team_era',     label: 'ERA',    sort: 'team_era',     dir: 'asc',  format: 'era',  title: 'Team ERA Leaders', endpoint: '/leaderboards/teams',
      extra: [
        { key: 'team_whip', label: 'WHIP', format: 'era' },
        { key: 'avg_fip', label: 'FIP', format: 'era' },
        { key: 'total_k', label: 'K', format: 'int' },
        { key: 'total_ip', label: 'IP', format: 'ip' },
      ] },
    { key: 'total_war',    label: 'WAR',    sort: 'total_war',    dir: 'desc', format: 'war',  title: 'Team WAR Leaders', endpoint: '/leaderboards/teams',
      extra: [
        { key: 'total_owar', label: 'oWAR', format: 'war' },
        { key: 'total_pwar', label: 'pWAR', format: 'war' },
        { key: 'avg_wrc_plus', label: 'wRC+', format: 'int' },
        { key: 'team_era', label: 'ERA', format: 'era' },
      ] },
    { key: 'total_runs',   label: 'R',      sort: 'total_runs',   dir: 'desc', format: 'int',  title: 'Team Runs Leaders', endpoint: '/leaderboards/teams',
      extra: [
        { key: 'team_avg', label: 'AVG', format: 'avg' },
        { key: 'total_hr', label: 'HR', format: 'int' },
        { key: 'total_rbi', label: 'RBI', format: 'int' },
        { key: 'team_obp', label: 'OBP', format: 'avg' },
      ] },
    { key: 'total_sb',     label: 'SB',     sort: 'total_sb',     dir: 'desc', format: 'int',  title: 'Team SB Leaders', endpoint: '/leaderboards/teams',
      extra: [
        { key: 'team_avg', label: 'AVG', format: 'avg' },
        { key: 'total_runs', label: 'R', format: 'int' },
        { key: 'team_obp', label: 'OBP', format: 'avg' },
        { key: 'avg_wrc_plus', label: 'wRC+', format: 'int' },
      ] },
  ],
  fielding: [
    { key: 'fielding_pct', label: 'FLD%', sort: 'fielding_pct', dir: 'desc', format: 'avg', title: 'Fielding % Leaders', endpoint: '/leaderboards/fielding',
      extra: [
        { key: 'total_chances', label: 'TC', format: 'int' },
        { key: 'putouts', label: 'PO', format: 'int' },
        { key: 'assists', label: 'A', format: 'int' },
        { key: 'errors', label: 'E', format: 'int' },
      ] },
    { key: 'range_factor', label: 'RF/9', sort: 'range_factor', dir: 'desc', format: 'era', title: 'Range Factor Leaders', endpoint: '/leaderboards/fielding',
      extra: [
        { key: 'putouts', label: 'PO', format: 'int' },
        { key: 'assists', label: 'A', format: 'int' },
        { key: 'double_plays', label: 'DP', format: 'int' },
        { key: 'fielding_pct', label: 'FLD%', format: 'avg' },
      ] },
    { key: 'double_plays', label: 'DP', sort: 'double_plays', dir: 'desc', format: 'int', title: 'Double Play Leaders', endpoint: '/leaderboards/fielding',
      extra: [
        { key: 'putouts', label: 'PO', format: 'int' },
        { key: 'assists', label: 'A', format: 'int' },
        { key: 'fielding_pct', label: 'FLD%', format: 'avg' },
        { key: 'games', label: 'G', format: 'int' },
      ] },
    { key: 'assists', label: 'A', sort: 'assists', dir: 'desc', format: 'int', title: 'Assist Leaders', endpoint: '/leaderboards/fielding',
      extra: [
        { key: 'putouts', label: 'PO', format: 'int' },
        { key: 'errors', label: 'E', format: 'int' },
        { key: 'double_plays', label: 'DP', format: 'int' },
        { key: 'fielding_pct', label: 'FLD%', format: 'avg' },
      ] },
    { key: 'cs_pct', label: 'CS%', sort: 'cs_pct', dir: 'desc', format: 'avg', title: 'Catcher CS% Leaders', endpoint: '/leaderboards/fielding',
      extra: [
        { key: 'caught_stealing_by', label: 'CS', format: 'int' },
        { key: 'stolen_bases_against', label: 'SBA', format: 'int' },
        { key: 'passed_balls', label: 'PB', format: 'int' },
        { key: 'fielding_pct', label: 'FLD%', format: 'avg' },
      ] },
  ],
  relievers: [
    { key: 'wpa', label: 'WPA', sort: 'wpa', dir: 'desc', format: 'wpa', title: 'Relief WPA Leaders', endpoint: '/leaderboards/relievers',
      extra: [
        { key: 'outs', label: 'IP', format: 'outs_ip' },
        { key: 'app', label: 'App', format: 'int' },
        { key: 'geg', label: 'GEG', format: 'int' },
        { key: 'goose_pct', label: 'Goose%', format: 'pct' },
      ] },
    { key: 'geg', label: 'GEG', sort: 'geg', dir: 'desc', format: 'int', title: 'Goose Egg Leaders', endpoint: '/leaderboards/relievers',
      extra: [
        { key: 'opp', label: 'OPP', format: 'int' },
        { key: 'goose_pct', label: 'Goose%', format: 'pct' },
        { key: 'brk', label: 'BRK', format: 'int' },
        { key: 'wpa', label: 'WPA', format: 'wpa' },
      ] },
    { key: 'goose_pct', label: 'Goose%', sort: 'goose_pct', dir: 'desc', format: 'pct', title: 'Goose% Leaders', endpoint: '/leaderboards/relievers',
      extra: [
        { key: 'geg', label: 'GEG', format: 'int' },
        { key: 'opp', label: 'OPP', format: 'int' },
        { key: 'outs', label: 'IP', format: 'outs_ip' },
        { key: 'wpa', label: 'WPA', format: 'wpa' },
      ] },
    { key: 'k_pct', label: 'K%', sort: 'k_pct', dir: 'desc', format: 'pct', title: 'Relief K% Leaders', endpoint: '/leaderboards/relievers',
      extra: [
        { key: 'bb_pct', label: 'BB%', format: 'pct' },
        { key: 'ra9', label: 'RA9', format: 'era' },
        { key: 'whip', label: 'WHIP', format: 'era' },
        { key: 'bf', label: 'BF', format: 'int' },
      ] },
    { key: 'ra9', label: 'RA9', sort: 'ra9', dir: 'asc', format: 'era', title: 'Lowest Relief RA9', endpoint: '/leaderboards/relievers',
      extra: [
        { key: 'whip', label: 'WHIP', format: 'era' },
        { key: 'k_pct', label: 'K%', format: 'pct' },
        { key: 'bb_pct', label: 'BB%', format: 'pct' },
        { key: 'outs', label: 'IP', format: 'outs_ip' },
      ] },
  ],
  batting_pbp: [
    { key: 'whiff_pct', label: 'Whiff%', sort: 'whiff_pct', dir: 'asc', format: 'pct', title: 'Lowest Whiff% (Best Contact)', endpoint: '/leaderboards/batting-pbp',
      extra: [
        { key: 'contact_pct', label: 'Contact%', format: 'pct' },
        { key: 'swing_pct', label: 'Swing%', format: 'pct' },
        { key: 'pitches_per_pa', label: 'P/PA', format: 'era' },
        { key: 'tracked_pa', label: 'PA', format: 'int' },
      ] },
    { key: 'contact_pct', label: 'Contact%', sort: 'contact_pct', dir: 'desc', format: 'pct', title: 'Contact% Leaders', endpoint: '/leaderboards/batting-pbp',
      extra: [
        { key: 'whiff_pct', label: 'Whiff%', format: 'pct' },
        { key: 'swing_pct', label: 'Swing%', format: 'pct' },
        { key: 'fb_pct', label: 'FB%', format: 'pct' },
        { key: 'tracked_pa', label: 'PA', format: 'int' },
      ] },
    { key: 'air_pull_pct', label: 'AirPull%', sort: 'air_pull_pct', dir: 'desc', format: 'pct', title: 'Air-Pull% Leaders', endpoint: '/leaderboards/batting-pbp',
      extra: [
        { key: 'fb_pct', label: 'FB%', format: 'pct' },
        { key: 'contact_pct', label: 'Contact%', format: 'pct' },
        { key: 'swing_pct', label: 'Swing%', format: 'pct' },
        { key: 'tracked_pa', label: 'PA', format: 'int' },
      ] },
    { key: 'swing_pct', label: 'Swing%', sort: 'swing_pct', dir: 'desc', format: 'pct', title: 'Most Aggressive (Swing%)', endpoint: '/leaderboards/batting-pbp',
      extra: [
        { key: 'whiff_pct', label: 'Whiff%', format: 'pct' },
        { key: 'contact_pct', label: 'Contact%', format: 'pct' },
        { key: 'pitches_per_pa', label: 'P/PA', format: 'era' },
        { key: 'tracked_pa', label: 'PA', format: 'int' },
      ] },
    { key: 'pitches_per_pa', label: 'P/PA', sort: 'pitches_per_pa', dir: 'desc', format: 'era', title: 'Most Pitches Seen / PA', endpoint: '/leaderboards/batting-pbp',
      extra: [
        { key: 'swing_pct', label: 'Swing%', format: 'pct' },
        { key: 'whiff_pct', label: 'Whiff%', format: 'pct' },
        { key: 'tracked_pa', label: 'PA', format: 'int' },
        { key: 'pitches', label: 'Pit', format: 'int' },
      ] },
  ],
  pitching_pbp: [
    { key: 'whiff_pct', label: 'Whiff%', sort: 'whiff_pct', dir: 'desc', format: 'pct', title: 'Whiff% Leaders', endpoint: '/leaderboards/pitching-pbp',
      extra: [
        { key: 'strike_pct', label: 'Str%', format: 'pct' },
        { key: 'contact_pct', label: 'Contact%', format: 'pct' },
        { key: 'putaway_pct', label: 'Putaway%', format: 'pct' },
        { key: 'tracked_pa', label: 'BF', format: 'int' },
      ] },
    { key: 'strike_pct', label: 'Strike%', sort: 'strike_pct', dir: 'desc', format: 'pct', title: 'Strike% Leaders', endpoint: '/leaderboards/pitching-pbp',
      extra: [
        { key: 'first_pitch_strike_pct', label: 'F-Str%', format: 'pct' },
        { key: 'whiff_pct', label: 'Whiff%', format: 'pct' },
        { key: 'called_strike_pct', label: 'CSt%', format: 'pct' },
        { key: 'tracked_pa', label: 'BF', format: 'int' },
      ] },
    { key: 'first_pitch_strike_pct', label: 'F-Str%', sort: 'first_pitch_strike_pct', dir: 'desc', format: 'pct', title: 'First-Pitch Strike% Leaders', endpoint: '/leaderboards/pitching-pbp',
      extra: [
        { key: 'strike_pct', label: 'Str%', format: 'pct' },
        { key: 'whiff_pct', label: 'Whiff%', format: 'pct' },
        { key: 'putaway_pct', label: 'Putaway%', format: 'pct' },
        { key: 'tracked_pa', label: 'BF', format: 'int' },
      ] },
    { key: 'gb_pct', label: 'GB%', sort: 'gb_pct', dir: 'desc', format: 'pct', title: 'Ground-Ball% Leaders', endpoint: '/leaderboards/pitching-pbp',
      extra: [
        { key: 'strike_pct', label: 'Str%', format: 'pct' },
        { key: 'whiff_pct', label: 'Whiff%', format: 'pct' },
        { key: 'contact_pct', label: 'Contact%', format: 'pct' },
        { key: 'tracked_pa', label: 'BF', format: 'int' },
      ] },
    { key: 'putaway_pct', label: 'Putaway%', sort: 'putaway_pct', dir: 'desc', format: 'pct', title: 'Putaway% Leaders', endpoint: '/leaderboards/pitching-pbp',
      extra: [
        { key: 'whiff_pct', label: 'Whiff%', format: 'pct' },
        { key: 'strike_pct', label: 'Str%', format: 'pct' },
        { key: 'on_or_out_3_pct', label: 'OO3%', format: 'pct' },
        { key: 'tracked_pa', label: 'BF', format: 'int' },
      ] },
  ],
  team_batting_pbp: [
    { key: 'whiff_pct', label: 'Whiff%', sort: 'whiff_pct', dir: 'asc', format: 'pct', title: 'Best Team Contact (Lowest Whiff%)', endpoint: '/leaderboards/team-batting-pbp',
      extra: [
        { key: 'contact_pct', label: 'Contact%', format: 'pct' },
        { key: 'swing_pct', label: 'Swing%', format: 'pct' },
        { key: 'pitches_per_pa', label: 'P/PA', format: 'era' },
        { key: 'tracked_pa', label: 'PA', format: 'int' },
      ] },
    { key: 'contact_pct', label: 'Contact%', sort: 'contact_pct', dir: 'desc', format: 'pct', title: 'Team Contact% Leaders', endpoint: '/leaderboards/team-batting-pbp',
      extra: [
        { key: 'whiff_pct', label: 'Whiff%', format: 'pct' },
        { key: 'swing_pct', label: 'Swing%', format: 'pct' },
        { key: 'fb_pct', label: 'FB%', format: 'pct' },
        { key: 'tracked_pa', label: 'PA', format: 'int' },
      ] },
    { key: 'swing_pct', label: 'Swing%', sort: 'swing_pct', dir: 'desc', format: 'pct', title: 'Most Aggressive Teams (Swing%)', endpoint: '/leaderboards/team-batting-pbp',
      extra: [
        { key: 'whiff_pct', label: 'Whiff%', format: 'pct' },
        { key: 'contact_pct', label: 'Contact%', format: 'pct' },
        { key: 'pitches_per_pa', label: 'P/PA', format: 'era' },
        { key: 'tracked_pa', label: 'PA', format: 'int' },
      ] },
    { key: 'air_pull_pct', label: 'AirPull%', sort: 'air_pull_pct', dir: 'desc', format: 'pct', title: 'Team Air-Pull% Leaders', endpoint: '/leaderboards/team-batting-pbp',
      extra: [
        { key: 'fb_pct', label: 'FB%', format: 'pct' },
        { key: 'contact_pct', label: 'Contact%', format: 'pct' },
        { key: 'swing_pct', label: 'Swing%', format: 'pct' },
        { key: 'tracked_pa', label: 'PA', format: 'int' },
      ] },
  ],
  team_pitching_pbp: [
    { key: 'strike_pct', label: 'Strike%', sort: 'strike_pct', dir: 'desc', format: 'pct', title: 'Team Strike% Leaders', endpoint: '/leaderboards/team-pitching-pbp',
      extra: [
        { key: 'first_pitch_strike_pct', label: 'F-Str%', format: 'pct' },
        { key: 'whiff_pct', label: 'Whiff%', format: 'pct' },
        { key: 'called_strike_pct', label: 'CSt%', format: 'pct' },
        { key: 'tracked_pa', label: 'BF', format: 'int' },
      ] },
    { key: 'whiff_pct', label: 'Whiff%', sort: 'whiff_pct', dir: 'desc', format: 'pct', title: 'Team Whiff% Leaders', endpoint: '/leaderboards/team-pitching-pbp',
      extra: [
        { key: 'strike_pct', label: 'Str%', format: 'pct' },
        { key: 'contact_pct', label: 'Contact%', format: 'pct' },
        { key: 'putaway_pct', label: 'Putaway%', format: 'pct' },
        { key: 'tracked_pa', label: 'BF', format: 'int' },
      ] },
    { key: 'first_pitch_strike_pct', label: 'F-Str%', sort: 'first_pitch_strike_pct', dir: 'desc', format: 'pct', title: 'Team First-Pitch Strike% Leaders', endpoint: '/leaderboards/team-pitching-pbp',
      extra: [
        { key: 'strike_pct', label: 'Str%', format: 'pct' },
        { key: 'whiff_pct', label: 'Whiff%', format: 'pct' },
        { key: 'putaway_pct', label: 'Putaway%', format: 'pct' },
        { key: 'tracked_pa', label: 'BF', format: 'int' },
      ] },
    { key: 'gb_pct', label: 'GB%', sort: 'gb_pct', dir: 'desc', format: 'pct', title: 'Team Ground-Ball% Leaders', endpoint: '/leaderboards/team-pitching-pbp',
      extra: [
        { key: 'strike_pct', label: 'Str%', format: 'pct' },
        { key: 'whiff_pct', label: 'Whiff%', format: 'pct' },
        { key: 'contact_pct', label: 'Contact%', format: 'pct' },
        { key: 'tracked_pa', label: 'BF', format: 'int' },
      ] },
  ],
}

// ─── Position filter options ───
const POSITION_GROUPS = [
  { value: 'IF', label: 'Infield' },
  { value: 'OF', label: 'Outfield' },
  { value: 'C',  label: 'Catcher' },
  { value: 'P',  label: 'Pitcher' },
  { value: 'UT', label: 'UT/DH' },
]
const INDIVIDUAL_POSITIONS = [
  { value: 'SS', label: 'SS' },
  { value: '2B', label: '2B' },
  { value: '3B', label: '3B' },
  { value: '1B', label: '1B' },
  { value: 'CF', label: 'CF' },
  { value: 'LF', label: 'LF' },
  { value: 'RF', label: 'RF' },
  { value: 'DH', label: 'DH' },
]

// ─── Format helpers ───
function fmt(val, format) {
  if (val == null || val === '') return '-'
  switch (format) {
    case 'avg': return Number(val).toFixed(3).replace(/^0/, '')
    case 'era': return Number(val).toFixed(2)
    case 'pct': return (Number(val) * 100).toFixed(1) + '%'
    case 'ip':  return Number(val).toFixed(1)
    case 'war': return Number(val).toFixed(1)
    case 'wpa': return (Number(val) >= 0 ? '+' : '') + Number(val).toFixed(2)
    case 'outs_ip': { const o = Math.round(Number(val)); return `${Math.floor(o / 3)}.${o % 3}` }
    case 'int': return Math.round(Number(val)).toString()
    default: return String(val)
  }
}

// ─── Canvas Export Helpers ───
async function loadExportImage(src) {
  if (!src) return null
  const isExternal = src.startsWith('http') && !src.includes(window.location.hostname)
  const url = isExternal
    ? `/api/v1/proxy-image?url=${encodeURIComponent(src)}`
    : src.startsWith('/') ? src : src
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

// ─── Helper: get available stats list for custom picker ───
// (every returned field is fair game as a DISPLAY / extra column)
function getAvailableStats(category) {
  switch (category) {
    case 'batting':      return ALL_BATTING_STATS
    case 'pitching':     return ALL_PITCHING_STATS
    case 'war':          return ALL_WAR_STATS
    case 'teams':        return [...ALL_TEAM_BATTING_STATS, ...ALL_TEAM_PITCHING_STATS, ...ALL_TEAM_COMBINED_STATS]
    case 'fielding':     return ALL_FIELDING_STATS
    case 'relievers':    return ALL_RELIEVER_STATS
    case 'batting_pbp':
    case 'team_batting_pbp':  return ALL_BATTING_PBP_STATS
    case 'pitching_pbp':
    case 'team_pitching_pbp': return ALL_PITCHING_PBP_STATS
    default:             return []
  }
}

// Stats valid as the MAIN (ranked-by) stat — the sort key must be in the
// endpoint's server-side whitelist or the ranking would silently break.
function getSortableStats(category) {
  const allow = SORTABLE[category]
  if (!allow) return getAvailableStats(category)
  return getAvailableStats(category).filter(s => allow.has(s.sort || s.key))
}

// ─── Determine if we should use 2-column layout ───
function useTwoColumns(count) {
  return count >= 15
}

// Count options
const COUNT_OPTIONS = [5, 10, 15, 20, 25, 30, 40, 50]

// ─── The main component ───
export default function SocialGraphics() {
  const cardRef = useRef(null)

  // ─── State ───
  const [category, setCategory] = useState('batting')
  const [presetIdx, setPresetIdx] = useState(0)
  const [count, setCount] = useState(10)
  const [season, setSeason] = useState(CURRENT_SEASON)
  const [divisionId, setDivisionId] = useState(null)
  const [conferenceId, setConferenceId] = useState(null)
  const [conferenceOnly, setConferenceOnly] = useState(false)
  const [positionFilter, setPositionFilter] = useState('')
  const [stateFilter, setStateFilter] = useState('')
  const [yearFilter, setYearFilter] = useState('')
  const [minSample, setMinSample] = useState('')
  const [customTitle, setCustomTitle] = useState('')
  const [exporting, setExporting] = useState(false)
  const [qualified, setQualified] = useState(true)
  const [mode, setMode] = useState('preset') // 'preset' or 'custom'
  const [themeId, setThemeId] = useState('teal')

  // Custom stat picker state
  const [customMainStat, setCustomMainStat] = useState('')
  const [customExtraCols, setCustomExtraCols] = useState([])

  const { data: divisions } = useDivisions()
  const { data: conferences } = useConferences(divisionId)
  const cat = CATEGORY_BY_ID[category]
  const preset = STAT_PRESETS[category]?.[presetIdx] || STAT_PRESETS[category]?.[0]
  const theme = buildTheme(THEMES.find(t => t.id === themeId) || THEMES[0])

  // Reset preset index + category-specific filters when switching categories.
  useEffect(() => {
    setPresetIdx(0)
    setCustomMainStat('')
    setCustomExtraCols([])
    setMode('preset')
    setPositionFilter('')
    // Seed the Min-sample input with this category's sensible default so
    // boards without a qualified toggle (PBP/fielding/relievers) aren't
    // flooded with tiny-sample players.
    const c = CATEGORY_BY_ID[category]
    setMinSample(c?.sampleDefault ? String(c.sampleDefault) : '')
  }, [category])

  // Reset conference when division changes
  useEffect(() => {
    setConferenceId(null)
    setConferenceOnly(false)
  }, [divisionId])

  // ─── Build the active stat config (preset or custom) ───
  const activeConfig = (() => {
    if (mode === 'custom' && customMainStat) {
      const allStats = getAvailableStats(category)
      const mainDef = allStats.find(s => s.key === customMainStat)
      if (!mainDef) return preset
      return {
        key: mainDef.key,
        label: mainDef.label,
        sort: mainDef.sort || mainDef.key,
        dir: mainDef.dir,
        format: mainDef.format,
        title: `${mainDef.label} Leaders`,
        endpoint: cat.endpoint,
        extra: customExtraCols.map(k => {
          const def = allStats.find(s => s.key === k)
          return def ? { key: def.key, label: def.label, format: def.format } : null
        }).filter(Boolean),
      }
    }
    return preset
  })()

  // Build API params from the category's capabilities so we never send a
  // filter the endpoint doesn't accept (which could silently mis-rank).
  const apiParams = {
    season,
    sort_by: activeConfig.sort,
    sort_dir: activeConfig.dir,
    // Clubs are membership boards: fetch every member (high cap), then
    // render all of them. Ranked boards keep the chosen top-N limit.
    limit: cat.club ? 200 : count,
    ...(cat.division && divisionId && { division_id: divisionId }),
    ...(cat.conf && conferenceId && { conference_id: conferenceId }),
    ...(cat.state && stateFilter && { state: stateFilter }),
    ...(cat.confOnly && conferenceOnly && { conference_only: true }),
    ...(cat.year && yearFilter && { year_in_school: yearFilter }),
    ...(cat.posGroup && positionFilter && { position_group: positionFilter }),
    ...(cat.posExact && positionFilter && { position: positionFilter }),
    ...(cat.club && { club: activeConfig.clubId }),
    ...(cat.club && activeConfig.clubId === 'hr_sb' && { hr_min: activeConfig.hrMin ?? 10, sb_min: activeConfig.sbMin ?? 10 }),
    ...(cat.club && activeConfig.clubId === 'ironman' && { min_team_games: activeConfig.minTeamGames ?? 20 }),
  }

  // Sample-size floor / qualified toggle.
  const sampleNum = minSample !== '' && minSample != null ? Number(minSample) : null
  if (cat.qualified && qualified) {
    apiParams.qualified = true
  } else if (cat.sampleParam === 'min_pa_ip') {
    if (sampleNum != null) { apiParams.min_pa = sampleNum; apiParams.min_ip = sampleNum }
  } else if (cat.sampleParam) {
    if (sampleNum != null) apiParams[cat.sampleParam] = sampleNum
  }

  const { data: rawData, loading } = useApi(activeConfig.endpoint, apiParams, [
    season, activeConfig.sort, activeConfig.dir, count, divisionId, conferenceId, conferenceOnly,
    stateFilter, yearFilter, minSample, activeConfig.endpoint, qualified, positionFilter,
    category, presetIdx
  ])

  const items = Array.isArray(rawData) ? rawData : rawData?.data || []
  const isTeamMode = cat.kind === 'team'
  // Only the season-stats Teams board carries W-L; the team-PBP boards
  // don't, so the record column shows only when rows actually have it.
  const showRecord = isTeamMode && items.some(p => p.wins != null)

  // Clubs show EVERY member (no top-N cut); ranked boards use the chosen count.
  // The 2-column layout + extra-column stripping derive from this count.
  const renderCount = cat.club ? items.length : count
  const isTwoCol = useTwoColumns(renderCount)
  const effectiveConfig = isTwoCol ? { ...activeConfig, extra: [] } : activeConfig

  const divLabel = divisionId
    ? (divisions || []).find(d => d.id === Number(divisionId))?.name || ''
    : 'PNW'
  const confLabel = conferenceId
    ? (conferences || []).find(c => c.id === Number(conferenceId))?.abbreviation || ''
    : ''
  const posLabel = positionFilter ? ` ${positionFilter}` : ''
  const scopeLabel = confLabel || divLabel
  // Clubs get a clean "<scope> <Club Name>" title (no "Top N"); ranked boards keep "Top N".
  const titleText = customTitle || (cat.club
    ? `${scopeLabel} ${activeConfig.title}`
    : `Top ${count} ${scopeLabel}${posLabel} ${activeConfig.title}`)
  const subtitle = `${season} Season`
    + (cat.club && activeConfig.criteria ? ` · ${activeConfig.criteria}` : '')
    + (cat.year && yearFilter ? ` · ${yearFilter} Only` : '')
    + (cat.state && stateFilter ? ` · ${stateFilter}` : '')
    + (cat.confOnly && conferenceOnly ? ' · Conf. Games' : '')
    + (cat.qualified && !qualified ? ' · Unqualified' : '')

  // Footer note (bottom-right): club member count vs qualified vs min-sample vs team.
  const footerNote = cat.club
    ? `${items.length} ${items.length === 1 ? 'member' : 'members'}`
    : (cat.qualified && qualified)
      ? 'Qualified'
      : (cat.sampleParam && sampleNum != null)
        ? `Min ${sampleNum} ${cat.sampleLabel}`
        : isTeamMode
          ? 'Team Stats'
          : 'All players'

  // ─── Export handler ───
  const handleExport = useCallback(async () => {
    if (!items.length) return
    setExporting(true)
    try {
      const dpr = 2
      const w = SIZE.w, h = SIZE.h
      const config = effectiveConfig
      const extraCols = config.extra || []
      const twoCol = isTwoCol

      const headerH = h * 0.13
      const footerH = 36
      const bodyPadY = Math.floor(w * 0.012)
      const bodyH = h - headerH - footerH - bodyPadY * 2
      const colHeaderH = 20

      const columns = twoCol ? 2 : 1
      const colGap = twoCol ? 12 : 0
      const colWidth = twoCol ? (w - colGap - Math.floor(w * 0.035) * 2) / 2 : w - Math.floor(w * 0.035) * 2
      const itemsPerCol = Math.max(1, Math.ceil(renderCount / columns))
      const rowH = Math.floor((bodyH - colHeaderH) / itemsPerCol)

      const fontSize = twoCol
        ? Math.min(Math.max(Math.floor(colWidth / 28), 10), 16)
        : Math.min(Math.max(Math.floor(w / 55), 13), 22)
      const titleSize = Math.min(Math.max(Math.floor(w / 26), 20), 38)
      const subtitleSz = Math.max(Math.floor(titleSize * 0.38), 10)
      const rankSize = twoCol ? fontSize : Math.max(fontSize + 2, 16)
      const logoSize = Math.min(Math.floor(rowH * 0.6), twoCol ? 22 : 32)
      const mainStatW = twoCol ? Math.floor(colWidth * 0.18) : Math.floor(w * 0.10)
      const extraW = Math.floor(w * 0.09)
      const rankW = twoCol ? Math.floor(colWidth * 0.07) : Math.floor(w * 0.045)
      const logoW = logoSize + (twoCol ? 4 : 8)
      const recordW = showRecord ? (twoCol ? Math.floor(colWidth * 0.14) : Math.floor(w * 0.08)) : 0
      const bodyPadX = Math.floor(w * 0.035)
      const rowPadX = Math.floor(w * 0.008)
      const headerPadX = Math.floor(w * 0.04)
      const font = 'Inter, Helvetica Neue, sans-serif'

      // Pre-load all images in parallel
      const [faviconImg, ...logoImgs] = await Promise.all([
        loadExportImage('/favicon.png'),
        ...items.slice(0, renderCount).map(p => loadExportImage(p.logo_url))
      ])

      // Create canvas
      const canvas = document.createElement('canvas')
      canvas.width = w * dpr
      canvas.height = h * dpr
      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)

      // ─── Background gradient ───
      const ang = 160 * Math.PI / 180
      const sinA = Math.sin(ang), cosA = Math.cos(ang)
      const halfDiag = (Math.abs(w * sinA) + Math.abs(h * cosA)) / 2
      const cxG = w / 2, cyG = h / 2
      const grad = ctx.createLinearGradient(
        cxG - halfDiag * sinA, cyG + halfDiag * cosA,
        cxG + halfDiag * sinA, cyG - halfDiag * cosA
      )
      grad.addColorStop(0, theme.stops[0])
      grad.addColorStop(0.35, theme.stops[1])
      grad.addColorStop(1, theme.stops[2])
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)

      // ─── Decorative orbs ───
      const orb1 = ctx.createRadialGradient(w - 80, 80, 0, w - 80, 80, 200)
      orb1.addColorStop(0, `rgba(${theme.orb1RGB},0.3)`)
      orb1.addColorStop(0.7, `rgba(${theme.orb1RGB},0)`)
      orb1.addColorStop(1, `rgba(${theme.orb1RGB},0)`)
      ctx.fillStyle = orb1
      ctx.fillRect(0, 0, w, h)

      const orb2 = ctx.createRadialGradient(70, h - 70, 0, 70, h - 70, 150)
      orb2.addColorStop(0, `rgba(${theme.orb2RGB},0.15)`)
      orb2.addColorStop(0.7, `rgba(${theme.orb2RGB},0)`)
      orb2.addColorStop(1, `rgba(${theme.orb2RGB},0)`)
      ctx.fillStyle = orb2
      ctx.fillRect(0, 0, w, h)

      // ─── Header ───
      const headerPadTop = Math.floor(headerH * 0.10)
      let curY = headerPadTop

      const nwLogoSz = Math.floor(titleSize * 0.7)
      if (faviconImg) {
        drawImageContain(ctx, faviconImg, headerPadX, curY, nwLogoSz, nwLogoSz)
      }
      const nwbbText = 'NWBB STATS'
      const nwbbFontSize = Math.floor(titleSize * 0.32)
      ctx.font = `800 ${nwbbFontSize}px ${font}`
      ctx.fillStyle = theme.textSecondary
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      const nwbbX = headerPadX + nwLogoSz + 8
      const nwbbSpacing = nwbbFontSize * 0.15
      let charX = nwbbX
      for (const ch of nwbbText) {
        ctx.fillText(ch, charX, curY + nwLogoSz / 2)
        charX += ctx.measureText(ch).width + nwbbSpacing
      }

      curY += nwLogoSz + 4

      // Title
      ctx.font = `900 ${titleSize}px ${font}`
      ctx.fillStyle = '#ffffff'
      ctx.textBaseline = 'top'
      ctx.shadowColor = theme.accentGlow
      ctx.shadowBlur = 40
      ctx.fillText(titleText, headerPadX, curY)
      ctx.shadowBlur = 0
      ctx.shadowColor = 'transparent'

      curY += titleSize * 1.2 + 2

      // Subtitle
      ctx.font = `500 ${subtitleSz}px ${font}`
      ctx.fillStyle = theme.textSecondary
      ctx.textBaseline = 'top'
      ctx.fillText(subtitle, headerPadX, curY)

      // Header bottom border
      ctx.strokeStyle = theme.border
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, headerH)
      ctx.lineTo(w, headerH)
      ctx.stroke()

      // ─── Column headers + Data rows ───
      const bodyStartY = headerH + bodyPadY

      // Draw column headers for each column
      for (let col = 0; col < columns; col++) {
        const colX = bodyPadX + col * (colWidth + colGap)
        const colLeftPad = colX + rowPadX + 3 + rankW + logoW + 4

        ctx.font = `700 ${Math.floor(fontSize * 0.6)}px ${font}`
        ctx.fillStyle = theme.textMuted
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'left'
        ctx.fillText(isTeamMode ? 'TEAM' : 'PLAYER', colLeftPad, bodyStartY + colHeaderH / 2)

        // Stat headers from right
        let hdrX = colX + colWidth - rowPadX
        if (!twoCol) {
          for (let ei = extraCols.length - 1; ei >= 0; ei--) {
            ctx.textAlign = 'right'
            ctx.fillText(extraCols[ei].label, hdrX, bodyStartY + colHeaderH / 2)
            hdrX -= extraW
          }
        }
        ctx.textAlign = 'right'
        ctx.fillText(config.label, hdrX, bodyStartY + colHeaderH / 2)
      }

      const rowStartY = bodyStartY + colHeaderH

      for (let i = 0; i < Math.min(renderCount, items.length); i++) {
        const p = items[i]
        const name = isTeamMode
          ? (p.short_name || p.name || '-')
          : (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : p.name || '-')
        const teamName = isTeamMode
          ? (p.conference_abbrev || '')
          : (p.team_short || p.short_name || p.team_name || '')
        const level = p.division_level || ''
        const mainVal = p[config.key] ?? p[config.sort]
        const isTop3 = i < 3

        const col = twoCol ? Math.floor(i / itemsPerCol) : 0
        const rowInCol = twoCol ? i % itemsPerCol : i
        const colX = bodyPadX + col * (colWidth + colGap)
        const rowY = rowStartY + rowInCol * rowH
        const rowLeft = colX
        const rowWidth = colWidth

        // Row background
        if (isTop3 && !twoCol) {
          const opacity = (0.22 - i * 0.05)
          ctx.fillStyle = `${theme.highlight}${opacity})`
          canvasRoundRect(ctx, rowLeft, rowY, rowWidth, rowH, 6)
          ctx.fill()
          ctx.fillStyle = theme.accent
          ctx.fillRect(rowLeft, rowY + 2, 3, rowH - 4)
        } else if (rowInCol % 2 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.025)'
          canvasRoundRect(ctx, rowLeft, rowY, rowWidth, rowH, twoCol ? 4 : 6)
          ctx.fill()
        }

        let cellX = rowLeft + rowPadX + 3
        const cellCY = rowY + rowH / 2

        // Rank
        ctx.font = `900 ${rankSize}px ${font}`
        ctx.fillStyle = (isTop3 && !twoCol) ? theme.accent : theme.textMuted
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(i + 1), cellX + rankW / 2, cellCY)
        cellX += rankW

        // Logo
        const logoImg = logoImgs[i]
        if (logoImg) {
          drawImageContain(ctx, logoImg, cellX + 2, cellCY - logoSize / 2, logoSize, logoSize)
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.08)'
          canvasRoundRect(ctx, cellX + 2, cellCY - logoSize / 2, logoSize, logoSize, 3)
          ctx.fill()
          ctx.font = `700 ${Math.floor(logoSize * 0.35)}px ${font}`
          ctx.fillStyle = theme.textMuted
          ctx.textAlign = 'center'
          ctx.fillText((isTeamMode ? (p.short_name || p.name) : teamName).slice(0, 3), cellX + 2 + logoSize / 2, cellCY)
        }
        cellX += logoW

        // Name + team/level
        const nameX = cellX + 3
        const statsEndX = colX + colWidth - rowPadX
        const nameMaxW = statsEndX - (twoCol ? mainStatW : extraCols.length * extraW + mainStatW) - recordW - nameX - 8

        if (twoCol) {
          // Single line: name + team on same line
          ctx.font = `700 ${fontSize}px ${font}`
          ctx.fillStyle = '#ffffff'
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          const displayName = truncText(ctx, name, nameMaxW * 0.6)
          ctx.fillText(displayName, nameX, cellCY)
          const nameW = ctx.measureText(displayName + ' ').width
          ctx.font = `500 ${Math.floor(fontSize * 0.75)}px ${font}`
          ctx.fillStyle = theme.textSecondary
          ctx.fillText(truncText(ctx, teamName, nameMaxW * 0.35), nameX + nameW, cellCY)
        } else {
          // Two lines: name on top, team below
          const subFontSize = Math.floor(fontSize * 0.68)
          const lineGap = Math.floor(fontSize * 0.15)
          const totalTextH = fontSize + subFontSize + lineGap
          const nameY = cellCY - totalTextH / 2 + fontSize / 2
          const teamY = nameY + fontSize / 2 + lineGap + subFontSize / 2

          ctx.font = `700 ${fontSize}px ${font}`
          ctx.fillStyle = '#ffffff'
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          ctx.fillText(truncText(ctx, name, nameMaxW), nameX, nameY)

          ctx.font = `500 ${subFontSize}px ${font}`
          ctx.fillStyle = theme.textSecondary
          ctx.fillText(teamName, nameX, teamY)
          if (level) {
            const tw = ctx.measureText(teamName).width
            ctx.font = `600 ${Math.floor(fontSize * 0.55)}px ${font}`
            ctx.fillStyle = theme.textMuted
            ctx.fillText(level, nameX + tw + 5, teamY)
          }
        }

        // Stats from right edge
        let sX = statsEndX
        if (!twoCol) {
          for (let ei = extraCols.length - 1; ei >= 0; ei--) {
            ctx.font = `500 ${Math.floor(fontSize * 0.75)}px ${font}`
            ctx.fillStyle = theme.textSecondary
            ctx.textAlign = 'right'
            ctx.fillText(fmt(p[extraCols[ei].key], extraCols[ei].format), sX, cellCY)
            sX -= extraW
          }
        }

        // Main stat
        const mainFontSize = twoCol ? Math.floor(fontSize * 1.1) : Math.floor(fontSize * 1.25)
        ctx.font = `900 ${mainFontSize}px ${font}`
        ctx.fillStyle = (isTop3 && !twoCol) ? theme.accent : theme.mainStat
        ctx.textAlign = 'right'
        if (isTop3 && !twoCol) { ctx.shadowColor = theme.accentGlow; ctx.shadowBlur = 20 }
        ctx.fillText(fmt(mainVal, config.format), sX, cellCY)
        ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'
        sX -= mainStatW

        // Record (season-stats Teams board only)
        if (showRecord) {
          ctx.font = `600 ${Math.floor(fontSize * 0.75)}px ${font}`
          ctx.fillStyle = theme.textSecondary
          ctx.textAlign = 'right'
          ctx.fillText(`${p.wins ?? 0}-${p.losses ?? 0}`, sX, cellCY)
        }
      }

      // ─── Footer ───
      const footerY = h - footerH
      ctx.strokeStyle = theme.border
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, footerY)
      ctx.lineTo(w, footerY)
      ctx.stroke()

      ctx.font = `500 ${Math.floor(fontSize * 0.58)}px ${font}`
      ctx.fillStyle = theme.textMuted
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText('nwbaseballstats.com', headerPadX, footerY + footerH / 2)

      ctx.textAlign = 'right'
      ctx.font = `400 ${Math.floor(fontSize * 0.52)}px ${font}`
      ctx.fillText(footerNote, w - headerPadX, footerY + footerH / 2)

      // ─── Download ───
      const link = document.createElement('a')
      link.download = cat.club
        ? `nwbb-${activeConfig.clubId}-${season}.png`
        : `nwbb-${activeConfig.key}-top${renderCount}-${season}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed. Check console for details')
    } finally {
      setExporting(false)
    }
  }, [items, effectiveConfig, activeConfig, renderCount, cat.club, season, theme, isTeamMode, showRecord, footerNote, titleText, subtitle, isTwoCol])

  const scale = Math.min(600 / SIZE.w, 800 / SIZE.h)

  // Toggle a custom extra col on/off (max 5)
  const toggleExtraCol = (key) => {
    setCustomExtraCols(prev => {
      if (prev.includes(key)) return prev.filter(k => k !== key)
      if (prev.length >= 5) return prev
      return [...prev, key]
    })
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">Social Graphics</h1>
      <p className="text-sm text-gray-500 mb-5">
        Create shareable leaderboard images (1080×1080).
      </p>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* ═══ LEFT: Controls ═══ */}
        <div className="lg:w-80 shrink-0 space-y-4">
          {/* Category */}
          <div className="bg-white rounded-lg shadow-sm border p-4">
            <label className="block text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Category</label>
            <div className="grid grid-cols-3 gap-1">
              {CATEGORIES.map(c => (
                <button key={c.id} onClick={() => setCategory(c.id)}
                  className={`px-2 py-1.5 text-xs font-semibold rounded transition-all
                    ${category === c.id ? 'bg-nw-teal text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >{c.label}</button>
              ))}
            </div>

            {/* Mode toggle (preset vs custom) — clubs are preset-only */}
            {!cat.club && (
              <>
                <label className="block text-xs font-semibold text-gray-500 mt-3 mb-2 uppercase tracking-wide">Mode</label>
                <div className="flex gap-1">
                  <button onClick={() => setMode('preset')}
                    className={`flex-1 px-2 py-1.5 text-xs font-semibold rounded transition-all
                      ${mode === 'preset' ? 'bg-nw-teal text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                  >Presets</button>
                  <button onClick={() => setMode('custom')}
                    className={`flex-1 px-2 py-1.5 text-xs font-semibold rounded transition-all
                      ${mode === 'custom' ? 'bg-nw-teal text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                  >Custom</button>
                </div>
              </>
            )}

            {/* Preset stat buttons (Club selector for the clubs category) */}
            {mode === 'preset' && (
              <>
                <label className="block text-xs font-semibold text-gray-500 mt-3 mb-2 uppercase tracking-wide">{cat.club ? 'Club' : 'Stat'}</label>
                <div className="flex flex-wrap gap-1">
                  {STAT_PRESETS[category].map((p, i) => (
                    <button key={p.key} onClick={() => setPresetIdx(i)}
                      className={`px-2.5 py-1 text-xs font-semibold rounded transition-all
                        ${presetIdx === i ? 'bg-nw-teal text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                    >{cat.club ? p.title : p.label}</button>
                  ))}
                </div>
              </>
            )}

            {/* Custom stat picker */}
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
                              ? 'bg-nw-teal text-white shadow'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}
                            ${!customExtraCols.includes(s.key) && customExtraCols.length >= 5 ? 'opacity-40 cursor-not-allowed' : ''}`}
                        >{s.label}</button>
                      ))}
                    </div>
                  </>
                )}
                {isTwoCol && (
                  <p className="text-xs text-amber-600 mt-2">Extra columns hidden in 2-column layout (15+ players).</p>
                )}
              </>
            )}
          </div>

          {/* Color scheme */}
          <div className="bg-white rounded-lg shadow-sm border p-4">
            <label className="block text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Color Scheme</label>
            <div className="grid grid-cols-5 gap-2">
              {THEMES.map(t => {
                const [a, b, c] = t.stops
                return (
                  <button key={t.id} onClick={() => setThemeId(t.id)} title={t.label}
                    className={`h-9 rounded-md border-2 transition-all ${themeId === t.id ? 'border-nw-teal ring-2 ring-nw-teal/30 scale-105' : 'border-gray-200 hover:border-gray-300'}`}
                    style={{ background: `linear-gradient(135deg, ${a} 0%, ${b} 45%, ${c} 100%)` }}
                  />
                )
              })}
            </div>
            <div className="text-[11px] text-gray-400 mt-1.5">{(THEMES.find(t => t.id === themeId) || THEMES[0]).label}</div>
          </div>

          {/* Filters */}
          <div className="bg-white rounded-lg shadow-sm border p-4 space-y-3">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide">Filters</label>

            <div>
              <label className="text-xs text-gray-500">Season</label>
              <select value={season} onChange={e => setSeason(+e.target.value)}
                className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                {SEASONS.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>

            {cat.division && (
              <div>
                <label className="text-xs text-gray-500">Division</label>
                <select value={divisionId || ''} onChange={e => setDivisionId(e.target.value || null)}
                  className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                  <option value="">All Divisions</option>
                  {(divisions || []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
            )}

            {/* Conference filter */}
            {cat.conf && (
              <div>
                <label className="text-xs text-gray-500">Conference</label>
                <select value={conferenceId || ''} onChange={e => setConferenceId(e.target.value || null)}
                  className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                  <option value="">All Conferences</option>
                  {(conferences || []).map(c => <option key={c.id} value={c.id}>{c.abbreviation || c.name}</option>)}
                </select>
              </div>
            )}

            {/* State filter */}
            {cat.state && (
              <div>
                <label className="text-xs text-gray-500">State</label>
                <select value={stateFilter} onChange={e => setStateFilter(e.target.value)}
                  className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                  <option value="">All States</option>
                  {['WA', 'OR', 'ID', 'MT', 'BC'].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            )}

            {/* Conference games only toggle */}
            {cat.confOnly && (
              <div className="flex items-center justify-between">
                <label className="text-xs text-gray-500">Conference Games Only</label>
                <button
                  onClick={() => setConferenceOnly(!conferenceOnly)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${conferenceOnly ? 'bg-nw-teal' : 'bg-gray-300'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${conferenceOnly ? 'left-5' : 'left-0.5'}`} />
                </button>
              </div>
            )}

            {/* Position filter — group (batting/war) or exact (fielding) */}
            {(cat.posGroup || cat.posExact) && (
              <div>
                <label className="text-xs text-gray-500">Position</label>
                <select value={positionFilter} onChange={e => setPositionFilter(e.target.value)}
                  className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                  <option value="">All Positions</option>
                  {cat.posGroup && (
                    <>
                      <optgroup label="Position Groups">
                        {POSITION_GROUPS.map(pg => <option key={pg.value} value={pg.value}>{pg.label}</option>)}
                      </optgroup>
                      <optgroup label="Individual Positions">
                        {INDIVIDUAL_POSITIONS.map(pos => <option key={pos.value} value={pos.value}>{pos.label}</option>)}
                      </optgroup>
                    </>
                  )}
                  {cat.posExact && ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'].map(pos => (
                    <option key={pos} value={pos}>{pos}</option>
                  ))}
                </select>
              </div>
            )}

            {cat.year && (
              <div>
                <label className="text-xs text-gray-500">Class Year</label>
                <select value={yearFilter} onChange={e => setYearFilter(e.target.value)}
                  className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                  <option value="">All</option>
                  {['Fr', 'So', 'Jr', 'Sr'].map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            )}

            {/* Qualified toggle */}
            {cat.qualified && (
              <div className="flex items-center justify-between">
                <label className="text-xs text-gray-500">Qualified Only</label>
                <button
                  onClick={() => setQualified(!qualified)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${qualified ? 'bg-nw-teal' : 'bg-gray-300'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${qualified ? 'left-5' : 'left-0.5'}`} />
                </button>
              </div>
            )}

            {/* Min sample — always for boards without a qualified toggle,
                or when qualified is turned off. */}
            {cat.sampleParam && !(cat.qualified && qualified) && (
              <div>
                <label className="text-xs text-gray-500">Min {cat.sampleLabel}</label>
                <input type="number" value={minSample} onChange={e => setMinSample(e.target.value)}
                  placeholder="0"
                  className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm" />
              </div>
            )}

            {/* Clubs show every member; ranked boards pick a top-N count. */}
            {cat.club ? (
              <div>
                <label className="text-xs text-gray-500"># Players</label>
                <div className="w-full mt-0.5 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-sm text-gray-600">
                  All members ({items.length})
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-xs text-gray-500"># {isTeamMode ? 'Teams' : 'Players'}</label>
                  <select value={count} onChange={e => setCount(+e.target.value)}
                    className="w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                    {COUNT_OPTIONS.map(n => <option key={n} value={n}>Top {n}</option>)}
                  </select>
                </div>
              </div>
            )}

            {isTwoCol && (
              <p className="text-xs text-gray-400">
                Two-column layout active ({renderCount} {isTeamMode ? 'teams' : 'players'}). Main stat only.
              </p>
            )}
            {cat.club && items.length === 0 && !loading && (
              <p className="text-xs text-amber-600">No players meet this club's criteria for the current filters.</p>
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
              className="w-full py-2.5 rounded-lg bg-nw-teal text-white font-bold text-sm
                hover:bg-nw-teal-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                flex items-center justify-center gap-2"
            >
              {exporting ? (
                <><Spinner /> Exporting...</>
              ) : (
                <><DownloadIcon /> Download PNG</>
              )}
            </button>
          </div>
        </div>

        {/* ═══ RIGHT: Card Preview ═══ */}
        <div className="flex-1 flex flex-col items-center">
          <div className="text-xs text-gray-400 mb-2">Preview (1080×1080)</div>

          <div style={{
            width: SIZE.w * scale,
            height: SIZE.h * scale,
            overflow: 'hidden',
            borderRadius: 8,
            boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          }}>
            <div style={{
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              width: SIZE.w,
              height: SIZE.h,
            }}>
              <LeaderCard
                ref={cardRef}
                items={items}
                config={effectiveConfig}
                title={titleText}
                subtitle={subtitle}
                size={SIZE}
                loading={loading}
                count={renderCount}
                theme={theme}
                isTeamMode={isTeamMode}
                showRecord={showRecord}
                footerNote={footerNote}
                twoCol={isTwoCol}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// The preview card component
// ═══════════════════════════════════════════════════════════

const LeaderCard = forwardRef(function LeaderCard(
  { items, config, title, subtitle, size, loading, count, theme, isTeamMode, showRecord, footerNote, twoCol },
  ref
) {
  const w = size.w
  const h = size.h
  const extraCols = config.extra || []

  // ─── Dynamic sizing ───
  const headerH = h * 0.13
  const footerH = 36
  const bodyPadY = Math.floor(w * 0.012)
  const bodyH = h - headerH - footerH - bodyPadY * 2
  const colHeaderH = 20

  const columns = twoCol ? 2 : 1
  const colGap = twoCol ? 12 : 0
  const bodyPadX = Math.floor(w * 0.035)
  const colWidth = twoCol ? (w - colGap - bodyPadX * 2) / 2 : w - bodyPadX * 2
  const itemsPerCol = Math.max(1, Math.ceil(count / columns))
  const rowH = Math.floor((bodyH - colHeaderH) / itemsPerCol)

  const fontSize = twoCol
    ? Math.min(Math.max(Math.floor(colWidth / 28), 10), 16)
    : Math.min(Math.max(Math.floor(w / 55), 13), 22)
  const titleSize = Math.min(Math.max(Math.floor(w / 26), 20), 38)
  const subtitleSize = Math.max(Math.floor(titleSize * 0.38), 10)
  const rankSize = twoCol ? fontSize : Math.max(fontSize + 2, 16)

  const logoSize = Math.min(Math.floor(rowH * 0.6), twoCol ? 22 : 32)
  const mainStatW = twoCol ? Math.floor(colWidth * 0.18) : Math.floor(w * 0.10)
  const extraW = Math.floor(w * 0.09)
  const rankW = twoCol ? Math.floor(colWidth * 0.07) : Math.floor(w * 0.045)
  const logoW = logoSize + (twoCol ? 4 : 8)
  const recordW = showRecord ? (twoCol ? Math.floor(colWidth * 0.14) : Math.floor(w * 0.08)) : 0

  return (
    <div
      ref={ref}
      style={{
        width: w,
        height: h,
        background: theme.bg,
        fontFamily: "'Inter', 'Helvetica Neue', system-ui, sans-serif",
        color: theme.textPrimary,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Decorative elements */}
      <div style={{
        position: 'absolute', top: -120, right: -120,
        width: 400, height: 400,
        borderRadius: '50%',
        background: `radial-gradient(circle, ${theme.orb1} 0%, transparent 70%)`,
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute', bottom: -80, left: -80,
        width: 300, height: 300,
        borderRadius: '50%',
        background: `radial-gradient(circle, ${theme.orb2} 0%, transparent 70%)`,
        pointerEvents: 'none',
      }} />

      {/* ─── Header ─── */}
      <div style={{
        height: headerH,
        padding: `${Math.floor(headerH * 0.10)}px ${Math.floor(w * 0.04)}px`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        borderBottom: `2px solid ${theme.border}`,
        position: 'relative',
        zIndex: 1,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <img
            src="/favicon.png"
            alt=""
            style={{ width: Math.floor(titleSize * 0.7), height: Math.floor(titleSize * 0.7), borderRadius: 3 }}
            crossOrigin="anonymous"
          />
          <span style={{
            fontSize: Math.floor(titleSize * 0.32),
            fontWeight: 800,
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            color: theme.textSecondary,
          }}>NWBB Stats</span>
        </div>
        <div style={{
          fontSize: titleSize,
          fontWeight: 900,
          lineHeight: 1.05,
          letterSpacing: '-0.02em',
          color: '#ffffff',
          textShadow: `0 0 40px ${theme.accentGlow}, 0 1px 2px rgba(0,0,0,0.3)`,
        }}>
          {title}
        </div>
        <div style={{
          fontSize: subtitleSize,
          color: theme.textSecondary,
          fontWeight: 500,
          marginTop: 1,
          letterSpacing: '0.05em',
        }}>
          {subtitle}
        </div>
      </div>

      {/* ─── Body / Rows ─── */}
      <div style={{
        flex: 1,
        padding: `${bodyPadY}px ${bodyPadX}px`,
        display: 'flex',
        gap: colGap,
        position: 'relative',
        zIndex: 1,
      }}>
        {Array.from({ length: columns }).map((_, colIdx) => {
          const startIdx = colIdx * itemsPerCol
          const colItems = items.slice(startIdx, startIdx + itemsPerCol)

          return (
            <div key={colIdx} style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              {/* Column header */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                height: colHeaderH,
                padding: `0 ${Math.floor(w * 0.008)}px`,
                paddingLeft: Math.floor(w * 0.008) + 3 + rankW + logoW + 4,
                fontSize: Math.floor(fontSize * 0.6),
                fontWeight: 700,
                color: theme.textMuted,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}>
                <span style={{ flex: 1 }}>{isTeamMode ? 'Team' : 'Player'}</span>
                {showRecord && <span style={{ width: recordW, textAlign: 'right' }}>Rec</span>}
                <span style={{ width: mainStatW, textAlign: 'right' }}>{config.label}</span>
                {!twoCol && extraCols.map(col => (
                  <span key={col.key} style={{ width: extraW, textAlign: 'right' }}>{col.label}</span>
                ))}
              </div>

              {loading ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.4 }}>
                  Loading...
                </div>
              ) : (
                colItems.map((p, rowIdx) => {
                  const globalIdx = startIdx + rowIdx
                  const name = isTeamMode
                    ? (p.short_name || p.name || '-')
                    : (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : p.name || '-')
                  const team = isTeamMode
                    ? (p.conference_abbrev || '')
                    : (p.team_short || p.short_name || p.team_name || '')
                  const level = p.division_level || ''
                  const logoUrl = p.logo_url || ''
                  const mainVal = p[config.key] ?? p[config.sort]
                  const isTop3 = globalIdx < 3 && !twoCol

                  return (
                    <div
                      key={p.id || p.player_id || p.team_id || globalIdx}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        height: rowH,
                        padding: `0 ${Math.floor(w * 0.008)}px`,
                        borderRadius: twoCol ? 4 : 6,
                        background: isTop3
                          ? `linear-gradient(90deg, ${theme.highlight}${(0.22 - globalIdx * 0.05).toFixed(2)}) 0%, ${theme.highlight}0.04) 100%)`
                          : rowIdx % 2 === 0
                            ? theme.rowAlt
                            : 'transparent',
                        borderLeft: isTop3 ? `3px solid ${theme.accent}` : '3px solid transparent',
                      }}
                    >
                      {/* Rank */}
                      <span style={{
                        width: rankW,
                        fontSize: rankSize,
                        fontWeight: 900,
                        color: isTop3 ? theme.accent : theme.textMuted,
                        fontFeatureSettings: '"tnum"',
                        textAlign: 'center',
                        flexShrink: 0,
                      }}>
                        {globalIdx + 1}
                      </span>

                      {/* Team logo */}
                      <div style={{
                        width: logoW,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}>
                        {logoUrl ? (
                          <img
                            src={logoUrl}
                            alt=""
                            style={{
                              width: logoSize,
                              height: logoSize,
                              objectFit: 'contain',
                              borderRadius: 2,
                              opacity: 0.9,
                            }}
                            crossOrigin="anonymous"
                          />
                        ) : (
                          <div style={{
                            width: logoSize,
                            height: logoSize,
                            borderRadius: 3,
                            background: 'rgba(255,255,255,0.08)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: Math.floor(logoSize * 0.35),
                            fontWeight: 700,
                            color: theme.textMuted,
                          }}>
                            {(isTeamMode ? p.short_name || p.name : team).slice(0, 3)}
                          </div>
                        )}
                      </div>

                      {/* Name info */}
                      <div style={{ flex: 1, minWidth: 0, paddingLeft: 3, display: 'flex', flexDirection: twoCol ? 'row' : 'column', justifyContent: twoCol ? 'flex-start' : 'center', alignItems: twoCol ? 'center' : 'flex-start', gap: twoCol ? 4 : 0 }}>
                        <div style={{
                          fontSize: fontSize,
                          fontWeight: 700,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          lineHeight: twoCol ? 1.2 : 1.5,
                          ...(twoCol ? { maxWidth: '60%' } : { padding: '3px 0' }),
                        }}>
                          {name}
                        </div>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          lineHeight: 1.2,
                        }}>
                          <span style={{
                            fontSize: Math.floor(fontSize * (twoCol ? 0.8 : 0.68)),
                            color: theme.textSecondary,
                            fontWeight: 500,
                            whiteSpace: 'nowrap',
                          }}>
                            {team}
                          </span>
                          {!twoCol && level && (
                            <span style={{
                              fontSize: Math.floor(fontSize * 0.55),
                              fontWeight: 600,
                              color: theme.textMuted,
                              letterSpacing: '0.04em',
                            }}>
                              {level}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Record (season-stats Teams board only) */}
                      {showRecord && (
                        <div style={{
                          width: recordW,
                          textAlign: 'right',
                          fontSize: Math.floor(fontSize * 0.75),
                          fontWeight: 600,
                          color: theme.textSecondary,
                          fontFeatureSettings: '"tnum"',
                          flexShrink: 0,
                        }}>
                          {p.wins ?? 0}-{p.losses ?? 0}
                        </div>
                      )}

                      {/* Main stat (big) */}
                      <div style={{
                        width: mainStatW,
                        textAlign: 'right',
                        fontSize: Math.floor(fontSize * (twoCol ? 1.1 : 1.25)),
                        fontWeight: 900,
                        fontFeatureSettings: '"tnum"',
                        color: isTop3 ? theme.accent : theme.mainStat,
                        textShadow: isTop3 ? `0 0 20px ${theme.accentGlow}` : 'none',
                        flexShrink: 0,
                      }}>
                        {fmt(mainVal, config.format)}
                      </div>

                      {/* Extra stat columns (single column layout only) */}
                      {!twoCol && extraCols.map(col => (
                        <div key={col.key} style={{
                          width: extraW,
                          textAlign: 'right',
                          fontSize: Math.floor(fontSize * 0.75),
                          fontWeight: 500,
                          color: theme.textSecondary,
                          fontFeatureSettings: '"tnum"',
                          flexShrink: 0,
                        }}>
                          {fmt(p[col.key], col.format)}
                        </div>
                      ))}
                    </div>
                  )
                })
              )}
            </div>
          )
        })}
      </div>

      {/* ─── Footer ─── */}
      <div style={{
        height: footerH,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `0 ${Math.floor(w * 0.04)}px`,
        borderTop: `1px solid ${theme.border}`,
        position: 'relative',
        zIndex: 1,
      }}>
        <span style={{
          fontSize: Math.floor(fontSize * 0.58),
          color: theme.textMuted,
          fontWeight: 500,
        }}>
          nwbaseballstats.com
        </span>
        <span style={{
          fontSize: Math.floor(fontSize * 0.52),
          color: theme.textMuted,
          fontWeight: 400,
        }}>
          {footerNote}
        </span>
      </div>
    </div>
  )
})

// ─── Tiny icons ───
function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 2v8M4 7l4 4 4-4M3 13h10" />
    </svg>
  )
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
      <circle cx="8" cy="8" r="6" opacity="0.3" />
      <path d="M8 2a6 6 0 0 1 6 6" />
    </svg>
  )
}
