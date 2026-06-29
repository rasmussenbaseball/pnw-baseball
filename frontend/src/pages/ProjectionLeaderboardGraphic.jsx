// ProjectionLeaderboardGraphic — /projections/graphic
//
// 2027-projection leaderboard cards, built on the same single-canvas engine and
// visual identity as the WCL / spring leaderboard graphics (WclLeaderboardGraphic):
// fixed 1080×1080, header band + accent rule, white stat-row cards, medallions for
// the top 3, team logos, footer strip. One canvas feeds both preview and PNG export.
//
// Projection-specific: side (hitting/pitching/teams), LEVEL filter (All/D1…/JUCO),
// qualifier (min PA/IP), count, stat presets + full custom mode (main stat + up to 5
// extra columns), themes, custom title — plus a "Biggest Gains" mode that ranks the
// largest 2026→2027 improvement in any stat (breakout candidates).
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useProjectionPlayerLeaders, useProjectionTeamLeaders } from '../hooks/useApi'

const SIZE = { w: 1080, h: 1080 }
const SEASON = 2027
const LEVELS = ['All', 'D1', 'D2', 'D3', 'NAIA', 'JUCO']
const FONT = "-apple-system, 'Inter', 'Helvetica Neue', sans-serif"

// ─── Palette ───
const C = {
  navy: '#13294b', navyDark: '#0b1a33', blue: '#1f4f7a',
  teal: '#0d7d76', tealDeep: '#0a5f5a', tealLight: '#5fd0c7',
  gold: '#c9a44c', goldDeep: '#a9842f', goldLight: '#e2c577',
  cream: '#f6f3ea', maroon: '#7c2740', maroonDeep: '#5b1b2e',
}

// ─── Themes (same shape buildTheme/renderBoard consume) ───
const THEMES = [
  {
    id: 'classic', label: 'Cream Classic',
    bgStops: [C.cream, C.cream], grain: true, grainDark: 'rgba(19,41,75,0.05)', grainLight: 'rgba(255,255,255,0.6)',
    headerStops: [C.navy, C.blue], headerRule: C.gold,
    kicker: C.goldLight, headerText: '#ffffff', headerSub: 'rgba(255,255,255,0.85)',
    card: '#ffffff', cardBorder: 'rgba(19,41,75,0.16)', cardAccent: C.navy,
    text: '#1a1a1a', name: C.navy, secondary: '#5a5a5a', muted: '#8a8a8a',
    colHeader: C.goldDeep, mainStat: C.navy, mainStatTop3: C.goldDeep,
    medals: [C.gold, C.goldLight, C.goldDeep], medalText: C.navyDark, medalRing: C.navyDark,
    rank: '#9a9483', logoFallback: '#e8e4d6',
    footerBg: C.navyDark, footerText: '#ffffff', footerMuted: 'rgba(255,255,255,0.7)',
  },
  {
    id: 'teal', label: 'PNW Teal',
    bgStops: [C.cream, '#e7f1ef'], grain: true, grainDark: 'rgba(13,125,118,0.06)', grainLight: 'rgba(255,255,255,0.6)',
    headerStops: [C.tealDeep, C.teal], headerRule: C.goldLight,
    kicker: '#cdeee9', headerText: '#ffffff', headerSub: 'rgba(255,255,255,0.85)',
    card: '#ffffff', cardBorder: 'rgba(13,125,118,0.2)', cardAccent: C.teal,
    text: '#16302d', name: C.tealDeep, secondary: '#4a625f', muted: '#84948f',
    colHeader: C.tealDeep, mainStat: C.tealDeep, mainStatTop3: C.goldDeep,
    medals: [C.gold, C.goldLight, C.goldDeep], medalText: C.navyDark, medalRing: C.tealDeep,
    rank: '#9aa8a4', logoFallback: '#dcebe8',
    footerBg: C.tealDeep, footerText: '#ffffff', footerMuted: 'rgba(255,255,255,0.7)',
  },
  {
    id: 'midnight', label: 'Midnight Navy',
    bgStops: [C.navyDark, C.navy, C.blue], grain: false,
    headerStops: [C.navyDark, C.navyDark], headerRule: C.gold,
    kicker: C.goldLight, headerText: '#ffffff', headerSub: 'rgba(246,243,234,0.75)',
    card: 'rgba(246,243,234,0.07)', cardBorder: 'rgba(226,197,119,0.28)', cardAccent: C.gold,
    text: C.cream, name: C.cream, secondary: 'rgba(246,243,234,0.6)', muted: 'rgba(246,243,234,0.4)',
    colHeader: C.goldLight, mainStat: C.goldLight, mainStatTop3: C.goldLight,
    medals: [C.gold, C.goldLight, C.goldDeep], medalText: C.navyDark, medalRing: C.goldLight,
    rank: 'rgba(246,243,234,0.45)', logoFallback: 'rgba(246,243,234,0.12)',
    footerBg: 'rgba(0,0,0,0.35)', footerText: C.cream, footerMuted: 'rgba(246,243,234,0.6)',
  },
  {
    id: 'maroon', label: 'Maroon',
    bgStops: [C.maroonDeep, C.maroon], grain: false,
    headerStops: [C.maroonDeep, C.maroonDeep], headerRule: C.goldLight,
    kicker: C.goldLight, headerText: '#ffffff', headerSub: 'rgba(253,242,245,0.78)',
    card: 'rgba(253,242,245,0.07)', cardBorder: 'rgba(226,197,119,0.3)', cardAccent: C.goldLight,
    text: '#fdf2f5', name: '#fdf2f5', secondary: 'rgba(253,242,245,0.62)', muted: 'rgba(253,242,245,0.4)',
    colHeader: C.goldLight, mainStat: '#ffffff', mainStatTop3: C.goldLight,
    medals: [C.gold, C.goldLight, C.goldDeep], medalText: C.maroonDeep, medalRing: C.goldLight,
    rank: 'rgba(253,242,245,0.45)', logoFallback: 'rgba(253,242,245,0.12)',
    footerBg: 'rgba(0,0,0,0.32)', footerText: '#fdf2f5', footerMuted: 'rgba(253,242,245,0.6)',
  },
  {
    id: 'forest', label: 'Evergreen',
    bgStops: ['#0a2218', '#123d2b'], grain: false,
    headerStops: ['#0f4630', '#0b2f20'], headerRule: C.goldLight,
    kicker: '#bff0d6', headerText: '#ffffff', headerSub: 'rgba(232,245,238,0.78)',
    card: 'rgba(232,245,238,0.07)', cardBorder: 'rgba(110,224,170,0.26)', cardAccent: '#6ee0aa',
    text: '#eafaf1', name: '#eafaf1', secondary: 'rgba(232,245,238,0.6)', muted: 'rgba(232,245,238,0.4)',
    colHeader: '#9ff0c8', mainStat: '#9ff0c8', mainStatTop3: C.goldLight,
    medals: [C.gold, C.goldLight, C.goldDeep], medalText: '#0a2218', medalRing: '#6ee0aa',
    rank: 'rgba(232,245,238,0.45)', logoFallback: 'rgba(232,245,238,0.12)',
    footerBg: 'rgba(0,0,0,0.35)', footerText: '#eafaf1', footerMuted: 'rgba(232,245,238,0.6)',
  },
  {
    id: 'crimson', label: 'Crimson',
    bgStops: ['#fbf4f2', '#f4e4e0'], grain: true, grainDark: 'rgba(123,19,32,0.06)', grainLight: 'rgba(255,255,255,0.6)',
    headerStops: ['#9b1c2e', '#7a1322'], headerRule: C.goldLight,
    kicker: '#f4cdbf', headerText: '#ffffff', headerSub: 'rgba(255,255,255,0.85)',
    card: '#ffffff', cardBorder: 'rgba(123,19,32,0.18)', cardAccent: '#9b1c2e',
    text: '#2a1316', name: '#8a1626', secondary: '#6a4a4a', muted: '#9a7a7a',
    colHeader: '#8a1626', mainStat: '#8a1626', mainStatTop3: C.goldDeep,
    medals: [C.gold, C.goldLight, C.goldDeep], medalText: '#2a1316', medalRing: '#8a1626',
    rank: '#b09a9a', logoFallback: '#efe2df',
    footerBg: '#5e0f1b', footerText: '#ffffff', footerMuted: 'rgba(255,255,255,0.7)',
  },
  {
    id: 'slate', label: 'Steel',
    bgStops: ['#0f1722', '#1c2a3a'], grain: false,
    headerStops: ['#1c2a3a', '#243447'], headerRule: '#7dd3fc',
    kicker: '#bfe6fb', headerText: '#ffffff', headerSub: 'rgba(226,236,245,0.78)',
    card: 'rgba(226,236,245,0.06)', cardBorder: 'rgba(125,211,252,0.24)', cardAccent: '#7dd3fc',
    text: '#eef4fa', name: '#eef4fa', secondary: 'rgba(226,236,245,0.6)', muted: 'rgba(226,236,245,0.4)',
    colHeader: '#a9dcf7', mainStat: '#a9dcf7', mainStatTop3: '#7dd3fc',
    medals: [C.gold, C.goldLight, C.goldDeep], medalText: '#0f1722', medalRing: '#7dd3fc',
    rank: 'rgba(226,236,245,0.45)', logoFallback: 'rgba(226,236,245,0.1)',
    footerBg: 'rgba(0,0,0,0.4)', footerText: '#eef4fa', footerMuted: 'rgba(226,236,245,0.6)',
  },
  {
    id: 'royal', label: 'Royal Blue',
    bgStops: ['#f3f6fc', '#e4ebf7'], grain: true, grainDark: 'rgba(30,58,138,0.06)', grainLight: 'rgba(255,255,255,0.6)',
    headerStops: ['#1e3a8a', '#172f70'], headerRule: C.goldLight,
    kicker: '#c7d6f5', headerText: '#ffffff', headerSub: 'rgba(255,255,255,0.85)',
    card: '#ffffff', cardBorder: 'rgba(30,58,138,0.18)', cardAccent: '#1e3a8a',
    text: '#131c33', name: '#1e3a8a', secondary: '#4a5570', muted: '#8590aa',
    colHeader: '#1e3a8a', mainStat: '#1e3a8a', mainStatTop3: C.goldDeep,
    medals: [C.gold, C.goldLight, C.goldDeep], medalText: '#131c33', medalRing: '#1e3a8a',
    rank: '#9aa3bd', logoFallback: '#e3e9f4',
    footerBg: '#14245c', footerText: '#ffffff', footerMuted: 'rgba(255,255,255,0.7)',
  },
  {
    id: 'sunset', label: 'Sunset',
    bgStops: ['#fdf6ee', '#fbe8d4'], grain: true, grainDark: 'rgba(194,82,14,0.06)', grainLight: 'rgba(255,255,255,0.55)',
    headerStops: ['#c2520e', '#9c3f08'], headerRule: '#ffd9a0',
    kicker: '#ffe0bf', headerText: '#ffffff', headerSub: 'rgba(255,255,255,0.85)',
    card: '#ffffff', cardBorder: 'rgba(194,82,14,0.2)', cardAccent: '#c2520e',
    text: '#2e1a0e', name: '#a8470c', secondary: '#6a513c', muted: '#9a8067',
    colHeader: '#a8470c', mainStat: '#a8470c', mainStatTop3: '#9c3f08',
    medals: [C.gold, C.goldLight, C.goldDeep], medalText: '#2e1a0e', medalRing: '#c2520e',
    rank: '#b59c84', logoFallback: '#f0e3d2',
    footerBg: '#7a3206', footerText: '#ffffff', footerMuted: 'rgba(255,255,255,0.7)',
  },
  {
    id: 'mono', label: 'Mono',
    bgStops: ['#161618', '#242427'], grain: false,
    headerStops: ['#242427', '#0e0e10'], headerRule: '#d6d8dc',
    kicker: '#b8babf', headerText: '#ffffff', headerSub: 'rgba(238,239,241,0.72)',
    card: 'rgba(255,255,255,0.05)', cardBorder: 'rgba(214,216,220,0.22)', cardAccent: '#d6d8dc',
    text: '#eef0f2', name: '#ffffff', secondary: 'rgba(238,239,241,0.62)', muted: 'rgba(238,239,241,0.4)',
    colHeader: '#aeb1b7', mainStat: '#eef0f2', mainStatTop3: '#ffffff',
    medals: ['#e9ebee', '#c2c6cc', '#8d9298'], medalText: '#161618', medalRing: '#e9ebee',
    rank: 'rgba(238,239,241,0.4)', logoFallback: 'rgba(255,255,255,0.1)',
    footerBg: '#0c0c0e', footerText: '#eef0f2', footerMuted: 'rgba(238,239,241,0.55)',
  },
  {
    id: 'chaptrains-dark', label: 'ChapTrains · Night',
    bgStops: ['#0a0f16', '#111d2b'], grain: false,
    headerStops: ['#0f1c2c', '#0a0f16'], headerRule: '#8fd0f2',
    kicker: '#bfe4fa', headerText: '#ffffff', headerSub: 'rgba(231,240,247,0.72)',
    card: 'rgba(255,255,255,0.05)', cardBorder: 'rgba(143,208,242,0.26)', cardAccent: '#8fd0f2',
    text: '#eef4f9', name: '#ffffff', secondary: 'rgba(231,240,247,0.62)', muted: 'rgba(231,240,247,0.4)',
    colHeader: '#a9dcf7', mainStat: '#bfe6fa', mainStatTop3: '#8fd0f2',
    medals: ['#8fd0f2', '#bfe6fa', '#5a9fd0'], medalText: '#08121c', medalRing: '#8fd0f2',
    rank: 'rgba(231,240,247,0.4)', logoFallback: 'rgba(255,255,255,0.1)',
    footerBg: '#070b11', footerText: '#eef4f9', footerMuted: 'rgba(231,240,247,0.55)',
    sponsor: 'chaptrains', sponsorAccent: '#8fd0f2', sponsorPill: '#8fd0f2', sponsorPillText: '#08121c',
  },
  {
    id: 'chaptrains-light', label: 'ChapTrains · Day',
    bgStops: ['#f4f9fd', '#e3eef7'], grain: true, grainDark: 'rgba(20,50,90,0.06)', grainLight: 'rgba(255,255,255,0.6)',
    headerStops: ['#14253b', '#0e1b2c'], headerRule: '#8fd0f2',
    kicker: '#bfe4fa', headerText: '#ffffff', headerSub: 'rgba(255,255,255,0.85)',
    card: '#ffffff', cardBorder: 'rgba(20,50,90,0.16)', cardAccent: '#2a6ea3',
    text: '#13202e', name: '#1f5680', secondary: '#4a5a6a', muted: '#85929e',
    colHeader: '#1f5680', mainStat: '#1f5680', mainStatTop3: '#2a6ea3',
    medals: [C.gold, C.goldLight, C.goldDeep], medalText: '#13202e', medalRing: '#2a6ea3',
    rank: '#9aa6b2', logoFallback: '#e3ebf3',
    footerBg: '#0e1b2c', footerText: '#ffffff', footerMuted: 'rgba(255,255,255,0.7)',
    sponsor: 'chaptrains', sponsorAccent: '#8fd0f2', sponsorPill: '#8fd0f2', sponsorPillText: '#0e1b2c',
  },
]
function buildTheme(p) {
  return { ...p, swatch: p.bgStops.length > 1 ? `linear-gradient(135deg, ${p.bgStops.join(', ')})` : p.bgStops[0] }
}

// ─── Stat catalogs (key = projection field, dir = leaderboard direction) ───
const HIT_STATS = [
  { key: 'wOBA', label: 'wOBA', format: 'avg', dir: 'desc' },
  { key: 'OPS', label: 'OPS', format: 'avg', dir: 'desc' },
  { key: 'AVG', label: 'AVG', format: 'avg', dir: 'desc' },
  { key: 'OBP', label: 'OBP', format: 'avg', dir: 'desc' },
  { key: 'SLG', label: 'SLG', format: 'avg', dir: 'desc' },
  { key: 'iso', label: 'ISO', format: 'avg', dir: 'desc' },
  { key: 'wobacon', label: 'wOBACON', format: 'avg', dir: 'desc' },
  { key: 'HR', label: 'HR', format: 'int', dir: 'desc' },
  { key: 'R', label: 'R', format: 'int', dir: 'desc' },
  { key: 'RBI', label: 'RBI', format: 'int', dir: 'desc' },
  { key: 'BB', label: 'BB', format: 'int', dir: 'desc' },
  { key: 'bb_pct', label: 'BB%', format: 'pct', dir: 'desc' },
  { key: 'k_pct', label: 'K%', format: 'pct', dir: 'asc' },
  // PBP / plate-skill rates
  { key: 'p_airpull', label: 'AirPull%', format: 'pct', dir: 'desc' },
  { key: 'p_ld', label: 'LD%', format: 'pct', dir: 'desc' },
  { key: 'p_gb', label: 'GB%', format: 'pct', dir: 'desc' },
  { key: 'p_swing', label: 'Swing%', format: 'pct', dir: 'desc' },
  { key: 'p_whiff', label: 'Whiff%', format: 'pct', dir: 'asc' },
  { key: 'WAR', label: 'WAR', format: 'war', dir: 'desc' },
  { key: 'PT', label: 'PA', format: 'int', dir: 'desc' },
]
const PIT_STATS = [
  { key: 'ERA', label: 'ERA', format: 'era', dir: 'asc' },
  { key: 'FIP', label: 'FIP', format: 'era', dir: 'asc' },
  { key: 'WHIP', label: 'WHIP', format: 'era', dir: 'asc' },
  { key: 'K_pct', label: 'K%', format: 'pct', dir: 'desc' },
  { key: 'BB_pct', label: 'BB%', format: 'pct', dir: 'asc' },
  { key: 'HR9', label: 'HR/9', format: 'era', dir: 'asc' },
  { key: 'opp_avg', label: 'Opp AVG', format: 'avg', dir: 'asc' },
  // PBP / pitch-shape rates
  { key: 'p_whiff', label: 'Whiff%', format: 'pct', dir: 'desc' },
  { key: 'p_strike', label: 'Strike%', format: 'pct', dir: 'desc' },
  { key: 'p_gb', label: 'GB%', format: 'pct', dir: 'desc' },
  { key: 'p_fb', label: 'FB%', format: 'pct', dir: 'asc' },
  { key: 'WAR', label: 'WAR', format: 'war', dir: 'desc' },
  { key: 'IP', label: 'IP', format: 'ip', dir: 'desc' },
]
// stats with no 2026 baseline (can't be a "Biggest Gains" stat)
const NO_GAIN = new Set(['WAR', 'PT', 'IP', 'BF', 'wobacon'])
const TEAM_STATS = [
  { key: 'AVG', label: 'AVG', format: 'avg', dir: 'desc' },
  { key: 'OBP', label: 'OBP', format: 'avg', dir: 'desc' },
  { key: 'SLG', label: 'SLG', format: 'avg', dir: 'desc' },
  { key: 'OPS', label: 'OPS', format: 'avg', dir: 'desc' },
  { key: 'wOBA', label: 'wOBA', format: 'avg', dir: 'desc' },
  { key: 'HR', label: 'HR', format: 'int', dir: 'desc' },
  { key: 'R', label: 'R', format: 'int', dir: 'desc' },
  { key: 'RBI', label: 'RBI', format: 'int', dir: 'desc' },
  { key: 'oWAR', label: 'oWAR', format: 'war', dir: 'desc' },
  { key: 'ERA', label: 'ERA', format: 'era', dir: 'asc' },
  { key: 'WHIP', label: 'WHIP', format: 'era', dir: 'asc' },
  { key: 'FIP', label: 'FIP', format: 'era', dir: 'asc' },
  { key: 'K_pct', label: 'K%', format: 'pct', dir: 'desc' },
  { key: 'BB_pct', label: 'BB%', format: 'pct', dir: 'asc' },
  { key: 'HR9', label: 'HR/9', format: 'era', dir: 'asc' },
  { key: 'pWAR', label: 'pWAR', format: 'war', dir: 'desc' },
]
const CATALOG = { bat: HIT_STATS, pit: PIT_STATS, teams: TEAM_STATS }

const CATEGORIES = [
  { id: 'bat', label: 'Hitting', kind: 'player', side: 'bat', sampleLabel: 'PA', sampleDefault: 100 },
  { id: 'pit', label: 'Pitching', kind: 'player', side: 'pit', sampleLabel: 'IP', sampleDefault: 20 },
  { id: 'teams', label: 'Teams', kind: 'team' },
]
const CAT_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]))

const PRESETS = {
  bat: [
    { name: 'Advanced', key: 'wOBA', title: 'wOBA Leaders', extra: ['OPS', 'iso', 'bb_pct', 'k_pct', 'PT'] },
    { name: 'Slash', key: 'AVG', title: 'Batting Average Leaders', extra: ['OBP', 'SLG', 'OPS', 'PT'] },
    { name: 'Power', key: 'HR', title: 'Home Run Leaders', extra: ['SLG', 'iso', 'RBI', 'R', 'PT'] },
    { name: 'On-Base', key: 'OBP', title: 'On-Base Leaders', extra: ['bb_pct', 'k_pct', 'AVG', 'PT'] },
    { name: 'Value', key: 'WAR', title: 'Position-Player WAR Leaders', extra: ['wOBA', 'OPS', 'HR', 'PT'] },
  ],
  pit: [
    { name: 'ERA', key: 'ERA', title: 'ERA Leaders', extra: ['FIP', 'WHIP', 'K_pct', 'IP'] },
    { name: 'Strikeouts', key: 'K_pct', title: 'Strikeout-Rate Leaders', extra: ['BB_pct', 'WHIP', 'ERA', 'IP'] },
    { name: 'WHIP', key: 'WHIP', title: 'WHIP Leaders', extra: ['ERA', 'FIP', 'opp_avg', 'IP'] },
    { name: 'FIP', key: 'FIP', title: 'FIP Leaders', extra: ['ERA', 'K_pct', 'BB_pct', 'HR9', 'IP'] },
    { name: 'Value', key: 'WAR', title: 'Pitching WAR Leaders', extra: ['ERA', 'FIP', 'K_pct', 'IP'] },
  ],
  teams: [
    { name: 'Batting', key: 'OPS', title: 'Team Batting Leaders', extra: ['AVG', 'OBP', 'SLG', 'HR'] },
    { name: 'Power', key: 'HR', title: 'Team Home Run Leaders', extra: ['SLG', 'R', 'RBI', 'OPS'] },
    { name: 'Pitching', key: 'ERA', title: 'Team Pitching Leaders', extra: ['WHIP', 'FIP', 'K_pct', 'HR9'] },
    { name: 'Run Prev.', key: 'WHIP', title: 'Team WHIP Leaders', extra: ['ERA', 'FIP', 'BB_pct', 'K_pct'] },
    { name: 'Value', key: 'oWAR', title: 'Team WAR Leaders', extra: ['pWAR', 'OPS', 'ERA', 'HR'] },
  ],
}

// ─── Format helper (same as the WCL/spring exporter) ───
function fmt(val, format) {
  if (val == null || val === '') return '-'
  switch (format) {
    case 'avg': return Number(val).toFixed(3).replace(/^0/, '')
    case 'era': return Number(val).toFixed(2)
    case 'pct': return (Number(val) * 100).toFixed(1) + '%'
    case 'ip': return Number(val).toFixed(1)
    case 'war': return Number(val).toFixed(1)
    case 'int': return Math.round(Number(val)).toString()
    default: return String(val)
  }
}

// ─── Canvas helpers (copied from the WCL exporter) ───
async function loadExportImage(src) {
  if (!src) return null
  const isExternal = src.startsWith('http') && !src.includes(window.location.hostname)
  const url = isExternal ? `/api/v1/proxy-image?url=${encodeURIComponent(src)}` : src
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
  } catch { return null }
}
function drawImageContain(ctx, img, x, y, boxW, boxH) {
  if (!img) return
  const scale = Math.min(boxW / img.width, boxH / img.height)
  const dw = img.width * scale, dh = img.height * scale
  ctx.drawImage(img, x + (boxW - dw) / 2, y + (boxH - dh) / 2, dw, dh)
}
function canvasRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath()
}
function truncText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 0 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1)
  return t + '…'
}
const logoCache = {}
function loadLogoCached(src) {
  if (!src) return Promise.resolve(null)
  if (!logoCache[src]) logoCache[src] = loadExportImage(src)
  return logoCache[src]
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const useTwoColumns = (count) => count >= 15

// signed delta string for the Biggest-Gains main column
function fmtGain(d, format) {
  if (d == null) return '-'
  const s = d > 0 ? '+' : d < 0 ? '-' : ''
  const a = Math.abs(d)
  if (format === 'pct') return `${s}${(a * 100).toFixed(1)}pt`
  if (format === 'int') return `${s}${Math.round(a)}`
  if (format === 'avg') return `${s}${a.toFixed(3).replace(/^0/, '')}`
  return `${s}${a.toFixed(2)}`
}

// ════════════════════════════════════════════════════════════════
// Canvas renderer — one pipeline for preview AND export (WCL engine).
// ════════════════════════════════════════════════════════════════
// ChapTrains co-brand footer band. He has no logo, so his Instagram handle IS the
// mark — set big and centered as the focal point, with the value-prop + promo around
// it and NWBB's own branding kept on the left.
function drawChapTrainsFooter(ctx, w, fy, fh, theme, footerNote) {
  const padX = 44, cx = w / 2
  ctx.fillStyle = theme.sponsorAccent; ctx.fillRect(0, fy, w, 3)   // accent rule

  // LEFT: NWBB mark + qualifier note
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = theme.footerText; ctx.font = `800 17px ${FONT}`
  ctx.fillText('NWBB STATS', padX, fy + 47)
  ctx.fillStyle = theme.footerMuted; ctx.font = `700 13px ${FONT}`
  ctx.fillText('nwbaseballstats.com' + (footerNote ? '  ·  ' + footerNote : ''), padX, fy + 71)

  // CENTER (focal): the @handle, big, with kicker above + tagline below
  ctx.textAlign = 'center'
  ctx.fillStyle = theme.footerMuted; ctx.font = `800 14px ${FONT}`
  ctx.fillText('TRAINING PARTNER', cx, fy + 27)
  ctx.fillStyle = theme.sponsorAccent; ctx.font = `900 46px ${FONT}`
  ctx.fillText('@chaptrains', cx, fy + 73)
  ctx.fillStyle = theme.footerText; ctx.font = `600 15px ${FONT}`
  ctx.fillText('Personal training · trusted by dozens of PNW ballplayers', cx, fy + 99)

  // RIGHT: promo pill + line
  ctx.textBaseline = 'middle'; ctx.font = `800 15px ${FONT}`
  const promo = "DM 'NWBB' · 50% OFF"
  const pw = ctx.measureText(promo).width + 28, ph = 36
  const px = w - padX - pw, py = fy + 30
  ctx.fillStyle = theme.sponsorPill; canvasRoundRect(ctx, px, py, pw, ph, 8); ctx.fill()
  ctx.fillStyle = theme.sponsorPillText; ctx.textAlign = 'center'
  ctx.fillText(promo, px + pw / 2, py + ph / 2 + 1)
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'right'
  ctx.fillStyle = theme.footerMuted; ctx.font = `700 13px ${FONT}`
  ctx.fillText('your first month of training', w - padX, py + ph + 20)
}

async function renderBoard(canvas, opts) {
  const { items, config, title, subtitle, footerNote, theme, isTeamMode, count, twoCol, loading } = opts
  const w = SIZE.w, h = SIZE.h, dpr = 2
  canvas.width = w * dpr; canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  // background + grain
  if (theme.bgStops.length > 1) {
    const g = ctx.createLinearGradient(0, 0, 0, h)
    theme.bgStops.forEach((c, i) => g.addColorStop(i / (theme.bgStops.length - 1), c))
    ctx.fillStyle = g
  } else ctx.fillStyle = theme.bgStops[0]
  ctx.fillRect(0, 0, w, h)
  if (theme.grain) {
    const rand = mulberry32(20270129)
    for (let i = 0; i < 1600; i++) {
      const x = rand() * w, y = rand() * h, s = rand() < 0.5 ? 1 : 2
      ctx.fillStyle = rand() < 0.5 ? theme.grainDark : theme.grainLight
      ctx.fillRect(x, y, s, s)
    }
  }

  // header band
  const headerH = 150
  const hg = ctx.createLinearGradient(0, 0, w, headerH)
  theme.headerStops.forEach((c, i) => hg.addColorStop(theme.headerStops.length > 1 ? i / (theme.headerStops.length - 1) : 0, c))
  ctx.fillStyle = hg; ctx.fillRect(0, 0, w, headerH)
  ctx.fillStyle = theme.headerRule; ctx.fillRect(0, headerH - 6, w, 6)

  const padX = 48
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = theme.kicker
  ctx.font = `900 15px ${FONT}`
  ctx.fillText('PNW BASEBALL · 2027 PROJECTIONS', padX, 48)

  let titleSize = 44
  ctx.font = `900 ${titleSize}px ${FONT}`
  while (titleSize > 24 && ctx.measureText(title).width > w - padX * 2 - 200) {
    titleSize -= 2; ctx.font = `900 ${titleSize}px ${FONT}`
  }
  ctx.fillStyle = theme.headerText; ctx.fillText(title, padX, 102)
  ctx.fillStyle = theme.headerSub; ctx.font = `600 17px ${FONT}`
  ctx.fillText(subtitle, padX, 130)

  // brand mark top-right
  const favicon = await loadLogoCached('/favicon.png')
  ctx.textAlign = 'right'; ctx.font = `800 14px ${FONT}`
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  const brand = 'NWBB STATS'
  ctx.fillText(brand, w - padX, 50)
  if (favicon) drawImageContain(ctx, favicon, w - padX - ctx.measureText(brand).width - 30, 36, 22, 22)

  // footer strip — a taller co-brand band for sponsor themes
  const footerH = theme.sponsor ? 122 : 56, footerY = h - footerH
  ctx.fillStyle = theme.footerBg; ctx.fillRect(0, footerY, w, footerH)
  if (theme.sponsor === 'chaptrains') {
    drawChapTrainsFooter(ctx, w, footerY, footerH, theme, footerNote)
  } else {
    ctx.fillStyle = theme.footerText; ctx.font = `700 15px ${FONT}`
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText('nwbaseballstats.com', 40, footerY + 35)
    ctx.font = `500 13px ${FONT}`; ctx.fillStyle = theme.footerMuted
    ctx.textAlign = 'right'; ctx.fillText('@nwbbstats', w - 40, footerY + 35)
    if (footerNote) { ctx.textAlign = 'center'; ctx.fillText(footerNote, w / 2, footerY + 35) }
  }

  // body geometry
  const bodyPadX = 36, bodyTop = headerH + 16, bodyBottom = footerY - 14, colHeaderH = 26
  const bodyH = bodyBottom - bodyTop - colHeaderH
  const renderCount = Math.min(count, Math.max(items.length, 1))
  const columns = twoCol ? 2 : 1, colGap = twoCol ? 14 : 0
  const colWidth = (w - bodyPadX * 2 - colGap * (columns - 1)) / columns
  const itemsPerCol = Math.max(1, Math.ceil(renderCount / columns))
  const rowGap = twoCol ? 6 : Math.min(10, Math.max(4, Math.floor(60 / itemsPerCol) + 2))
  const rowH = Math.floor((bodyH - rowGap * (itemsPerCol - 1)) / itemsPerCol)
  const fontSize = twoCol ? Math.min(Math.max(Math.floor(colWidth / 28), 10), 16) : Math.min(Math.max(Math.floor(w / 55), 13), 22)
  const rankSize = twoCol ? fontSize : Math.max(fontSize + 2, 16)
  const logoSize = Math.min(Math.floor(rowH * 0.62), twoCol ? 24 : 36)
  const mainStatW = twoCol ? Math.floor(colWidth * 0.2) : Math.floor(w * 0.12)
  const extraW = Math.floor(w * 0.095)
  const rankW = twoCol ? Math.floor(colWidth * 0.09) : Math.floor(w * 0.052)
  const logoW = logoSize + (twoCol ? 6 : 10)
  const rowPadX = twoCol ? 8 : 14
  const extraCols = twoCol ? [] : (config.extra || [])

  if (loading || !items.length) {
    ctx.fillStyle = theme.name; ctx.font = `700 22px ${FONT}`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(loading ? 'Loading…' : 'No data for these filters', w / 2, (bodyTop + bodyBottom) / 2)
    return
  }

  const logoImgs = await Promise.all(items.slice(0, renderCount).map(p => loadLogoCached(p.logo_url)))

  // column headers
  for (let col = 0; col < columns; col++) {
    const colX = bodyPadX + col * (colWidth + colGap)
    ctx.font = `800 ${Math.max(Math.floor(fontSize * 0.62), 10)}px ${FONT}`
    ctx.fillStyle = theme.colHeader; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    const hy = bodyTop + colHeaderH / 2 - 4
    ctx.fillText(isTeamMode ? 'TEAM' : 'PLAYER', colX + rowPadX + rankW + logoW, hy)
    let hx = colX + colWidth - rowPadX; ctx.textAlign = 'right'
    for (let ei = extraCols.length - 1; ei >= 0; ei--) { ctx.fillText(extraCols[ei].label.toUpperCase(), hx, hy); hx -= extraW }
    ctx.fillText(config.label.toUpperCase(), hx, hy)
  }

  // rows
  const rowStartY = bodyTop + colHeaderH
  for (let i = 0; i < Math.min(renderCount, items.length); i++) {
    const p = items[i]
    const name = p.name || '-'
    const subText = p.team_short || ''
    const collegeText = p.college || ''
    const mainVal = p[config.key]
    const isTop3 = i < 3
    const col = twoCol ? Math.floor(i / itemsPerCol) : 0
    const rowInCol = twoCol ? i % itemsPerCol : i
    const x = bodyPadX + col * (colWidth + colGap)
    const y = rowStartY + rowInCol * (rowH + rowGap)
    const r = twoCol ? 8 : 12

    ctx.fillStyle = theme.card; canvasRoundRect(ctx, x, y, colWidth, rowH, r); ctx.fill()
    ctx.strokeStyle = isTop3 ? theme.medals[i] : theme.cardBorder; ctx.lineWidth = isTop3 ? 2 : 1; ctx.stroke()
    ctx.save(); canvasRoundRect(ctx, x, y, colWidth, rowH, r); ctx.clip()
    ctx.fillStyle = isTop3 ? theme.medals[i] : theme.cardAccent; ctx.fillRect(x, y, 5, rowH); ctx.restore()

    let cellX = x + rowPadX
    const cy = y + rowH / 2
    if (isTop3 && !twoCol) {
      const mr = Math.min(rowH * 0.3, 17)
      ctx.beginPath(); ctx.arc(cellX + rankW / 2, cy, mr, 0, Math.PI * 2)
      ctx.fillStyle = theme.medals[i]; ctx.fill()
      ctx.strokeStyle = theme.medalRing; ctx.lineWidth = 1.5; ctx.stroke()
      ctx.fillStyle = theme.medalText; ctx.font = `900 ${Math.floor(mr * 1.05)}px ${FONT}`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), cellX + rankW / 2, cy + 1)
    } else {
      ctx.font = `900 ${rankSize}px ${FONT}`; ctx.fillStyle = isTop3 ? theme.medals[i] : theme.rank
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), cellX + rankW / 2, cy)
    }
    cellX += rankW

    const logoImg = logoImgs[i]
    if (logoImg) drawImageContain(ctx, logoImg, cellX, cy - logoSize / 2, logoSize, logoSize)
    else {
      ctx.fillStyle = theme.logoFallback; canvasRoundRect(ctx, cellX, cy - logoSize / 2, logoSize, logoSize, 4); ctx.fill()
      ctx.font = `700 ${Math.floor(logoSize * 0.35)}px ${FONT}`; ctx.fillStyle = theme.muted; ctx.textAlign = 'center'
      ctx.fillText((subText || name).slice(0, 3).toUpperCase(), cellX + logoSize / 2, cy)
    }
    cellX += logoW

    const statsEndX = x + colWidth - rowPadX
    const nameMaxW = statsEndX - (extraCols.length * extraW + mainStatW) - cellX - 10
    if (twoCol) {
      ctx.font = `700 ${fontSize}px ${FONT}`; ctx.fillStyle = theme.name; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      const dn = truncText(ctx, name, nameMaxW * 0.62); ctx.fillText(dn, cellX, cy)
      const nw = ctx.measureText(dn + ' ').width
      ctx.font = `500 ${Math.floor(fontSize * 0.78)}px ${FONT}`; ctx.fillStyle = theme.secondary
      ctx.fillText(truncText(ctx, subText, Math.max(nameMaxW - nw, 0)), cellX + nw, cy)
    } else {
      const subSize = Math.floor(fontSize * 0.68), gap = Math.floor(fontSize * 0.2)
      const nameY = subText || collegeText ? cy - (subSize + gap) / 2 : cy
      ctx.font = `700 ${fontSize}px ${FONT}`; ctx.fillStyle = theme.name; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(truncText(ctx, name, nameMaxW), cellX, nameY)
      if (subText || collegeText) {
        const teamY = nameY + fontSize / 2 + gap + subSize / 2
        ctx.font = `500 ${subSize}px ${FONT}`; ctx.fillStyle = theme.secondary
        const st = truncText(ctx, subText, nameMaxW * 0.6); ctx.fillText(st, cellX, teamY)
        if (collegeText) {
          const tw = ctx.measureText(st + ' ').width
          ctx.font = `600 ${Math.floor(fontSize * 0.56)}px ${FONT}`; ctx.fillStyle = theme.muted
          ctx.fillText(truncText(ctx, collegeText, nameMaxW - tw - 6), cellX + tw + 6, teamY)
        }
      }
    }

    let sX = statsEndX; ctx.textBaseline = 'middle'
    for (let ei = extraCols.length - 1; ei >= 0; ei--) {
      ctx.font = `500 ${Math.floor(fontSize * 0.78)}px ${FONT}`; ctx.fillStyle = theme.secondary; ctx.textAlign = 'right'
      ctx.fillText(fmt(p[extraCols[ei].key], extraCols[ei].format), sX, cy); sX -= extraW
    }
    ctx.font = `900 ${Math.floor(fontSize * (twoCol ? 1.1 : 1.3))}px ${FONT}`
    ctx.fillStyle = isTop3 ? theme.mainStatTop3 : theme.mainStat; ctx.textAlign = 'right'
    ctx.fillText(fmt(mainVal, config.format), sX, cy)
  }
}

// ════════════════════════════════════════════════════════════════
// Component
// ════════════════════════════════════════════════════════════════
const ipNum = (ip) => { if (ip == null) return 0; const w = Math.floor(ip); const f = Math.round((ip - w) * 10); return w + (f >= 1 ? f / 3 : 0) }

export default function ProjectionLeaderboardGraphic() {
  const canvasRef = useRef(null)
  const [category, setCategory] = useState('bat')
  const [level, setLevel] = useState('All')
  const [mode, setMode] = useState('leaders')        // leaders | gains | every
  const [presetIdx, setPresetIdx] = useState(0)
  const [statMode, setStatMode] = useState('preset') // preset | custom
  const [customMain, setCustomMain] = useState('')
  const [customExtra, setCustomExtra] = useState([])
  const [count, setCount] = useState(10)
  const [qualified, setQualified] = useState(true)
  const [minSample, setMinSample] = useState('')
  const [min2026, setMin2026] = useState('')   // Biggest-Gains: min 2026 sample
  const [customTitle, setCustomTitle] = useState('')
  const [themeId, setThemeId] = useState('classic')

  const cat = CAT_BY_ID[category]
  const isTeam = cat.kind === 'team'
  const catalog = CATALOG[category]
  const theme = buildTheme(THEMES.find(t => t.id === themeId) || THEMES[0])

  const { data: playerData, loading: pLoading } = useProjectionPlayerLeaders(isTeam ? 'bat' : cat.side, SEASON)
  const { data: teamData, loading: tLoading } = useProjectionTeamLeaders(SEASON)
  const loading = isTeam ? tLoading : pLoading

  // reset per-category bits on switch
  useEffect(() => {
    setPresetIdx(0); setStatMode('preset'); setCustomMain(''); setCustomExtra([])
    setMinSample(cat?.sampleDefault ? String(cat.sampleDefault) : '')
    if (CAT_BY_ID[category].kind === 'team' && mode !== 'leaders') setMode('leaders')
  }, [category]) // eslint-disable-line

  const preset = PRESETS[category]?.[presetIdx] || PRESETS[category]?.[0]
  const statDef = (key) => catalog.find(s => s.key === key)
  // the active main stat (preset or custom). In Gains mode a stat with no 2026
  // baseline (WAR/PA/IP…) can't be diffed, so fall back to the first gainable stat.
  let mainKey = statMode === 'custom' && customMain ? customMain : preset.key
  if (mode === 'gains' && NO_GAIN.has(mainKey)) mainKey = catalog.find(s => !NO_GAIN.has(s.key))?.key || mainKey
  const mainDef = statDef(mainKey) || catalog[0]
  const extraKeys = statMode === 'custom' ? customExtra : preset.extra
  const statChoices = (mode === 'gains') ? catalog.filter(s => !NO_GAIN.has(s.key)) : catalog

  // build the raw pool (level + qualifier filtered)
  const pool = useMemo(() => {
    if (isTeam) {
      return (teamData || [])
        .filter(t => level === 'All' || t.level === level)
        .map(t => ({
          name: t.short_name, team_short: t.level, logo_url: t.logo_url, level: t.level,
          ...(t.hitting || {}), ...(t.pitching ? { ERA: t.pitching.ERA, WHIP: t.pitching.WHIP, FIP: t.pitching.FIP, K_pct: t.pitching.K_pct, BB_pct: t.pitching.BB_pct, HR9: t.pitching.HR9, pWAR: t.pitching.WAR } : {}),
          oWAR: t.hitting?.WAR,
        }))
    }
    const minN = minSample !== '' ? Number(minSample) : (cat.sampleDefault || 0)
    let r = (playerData?.players || []).filter(p => level === 'All' || p.level === level)
    if (qualified) r = r.filter(p => cat.side === 'bat' ? (p.PT || 0) >= minN : ipNum(p.IP) >= minN)
    return r.map(p => ({ ...p, name: p.name, team_short: p.team, college: p.level, logo_url: p.logo_url }))
  }, [isTeam, teamData, playerData, level, qualified, minSample, cat])

  // shape items + config for the active mode
  const { items, config, title, subtitle, footerNote } = useMemo(() => {
    const lvlLabel = level === 'All' ? 'PNW' : level
    const sideLabel = isTeam ? 'Teams' : cat.side === 'bat' ? 'Hitters' : 'Pitchers'
    const qualNote = isTeam ? `${pool.length} teams` : qualified ? `Min ${minSample || cat.sampleDefault} ${cat.sampleLabel}` : 'All players'
    const sub = `${SEASON} projected · ${lvlLabel} ${sideLabel}`

    if (mode === 'every' && !isTeam) {
      const rows = catalog.map(s => {
        const v = pool.filter(p => p[s.key] != null)
        v.sort((a, b) => s.dir === 'asc' ? a[s.key] - b[s.key] : b[s.key] - a[s.key])
        const top = v[0]
        if (!top) return null
        return { name: s.label, team_short: top.name, college: top.team, logo_url: top.logo_url, _v: fmt(top[s.key], s.format) }
      }).filter(Boolean)
      return {
        items: rows, config: { key: '_v', label: 'Leader', format: 'raw', extra: [] },
        title: customTitle || `Projected Best ${sideLabel}`, subtitle: `${sub} · top in every stat`, footerNote: qualNote,
      }
    }

    if (mode === 'gains' && !isTeam) {
      // 2026 baseline: PBP rates from the projection's *_prev field, box stats from
      // the 2026 actuals (`a`). A player with NO 2026 (or a 0 in the stat) is excluded
      // — a .000→.245 jump is a small-sample artifact, not a breakout.
      const isPbp = mainKey.startsWith('p_')
      const base26 = (p) => isPbp ? p[mainKey + '_prev'] : (p.a ? p.a[mainKey] : null)
      const samp26 = (p) => cat.side === 'bat' ? (p.a?.PT || 0) : ipNum(p.a?.IP)
      const minN26 = min2026 !== '' ? Number(min2026) : (cat.side === 'bat' ? 50 : 10)
      const v = pool.filter(p => {
        const b = base26(p)
        return b != null && b !== 0 && p[mainKey] != null && samp26(p) >= minN26
      }).map(p => ({ ...p, _b26: base26(p), _gn: p[mainKey] - base26(p) }))
      // improvement direction: for "lower is better" stats a gain is a DECREASE
      v.sort((a, b) => mainDef.dir === 'asc' ? a._gn - b._gn : b._gn - a._gn)
      const items = v.map(p => ({ ...p, _y26: p._b26, _y27: p[mainKey], _gain: fmtGain(p._gn, mainDef.format) }))
      return {
        items, config: { key: '_gain', label: `${mainDef.label} +/-`, format: 'raw', extra: [{ key: '_y26', label: '2026', format: mainDef.format }, { key: '_y27', label: '2027', format: mainDef.format }] },
        title: customTitle || `Projected Biggest ${mainDef.label} Gains`, subtitle: `${sub} · 2026 → 2027`,
        footerNote: `Min ${minN26} 2026 ${cat.sampleLabel}`,
      }
    }

    // leaders (default; the only team mode)
    const v = [...pool].filter(p => p[mainKey] != null)
    v.sort((a, b) => mainDef.dir === 'asc' ? a[mainKey] - b[mainKey] : b[mainKey] - a[mainKey])
    const extra = (extraKeys || []).map(k => { const d = statDef(k); return d ? { key: d.key, label: d.label, format: d.format } : null }).filter(Boolean)
    const ttl = customTitle || (isTeam ? `Projected ${preset.title || `${mainDef.label} Leaders`}` : `Projected Top ${count} ${mainDef.label}`)
    return {
      items: v, config: { key: mainKey, label: mainDef.label, format: mainDef.format, extra },
      title: ttl, subtitle: sub, footerNote: qualNote,
    }
  }, [pool, mode, mainKey, mainDef, extraKeys, catalog, isTeam, cat, level, qualified, minSample, min2026, count, customTitle, preset, statMode])

  const isTwoCol = useTwoColumns(count)
  const effConfig = isTwoCol ? { ...config, extra: [] } : config

  const renderToken = useRef(0)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const token = ++renderToken.current
    renderBoard(canvas, { items, config: effConfig, title, subtitle, footerNote, theme, isTeamMode: isTeam, count, twoCol: isTwoCol, loading })
      .catch(err => console.error('projection board render failed:', err))
    return () => { if (renderToken.current === token) renderToken.current++ }
  }, [items, loading, themeId, title, subtitle, footerNote, isTwoCol, count, isTeam, JSON.stringify(effConfig)]) // eslint-disable-line

  const download = useCallback(() => {
    if (!canvasRef.current || !items.length) return
    const a = document.createElement('a')
    a.download = `nwbb-proj-${category}-${mode}-${mainKey}-${level}.png`
    a.href = canvasRef.current.toDataURL('image/png'); a.click()
  }, [items.length, category, mode, mainKey, level])

  const toggleExtra = (k) => setCustomExtra(prev => prev.includes(k) ? prev.filter(x => x !== k) : prev.length >= 5 ? prev : [...prev, k])

  const Chip = ({ active, onClick, children, sm }) => (
    <button onClick={onClick}
      className={`${sm ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs'} font-semibold rounded transition-all
        ${active ? 'bg-nw-teal text-white shadow' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
      {children}
    </button>
  )

  return (
    <div className="max-w-screen-xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">Projection Leaderboard Graphics</h1>
      <p className="text-sm text-gray-500 mb-5">Shareable 2027-projection stat cards (1080×1080), in the leaderboard-graphic style. Pick a stat or build a custom one, filter by level, or rank the biggest projected breakouts.</p>

      <div className="flex flex-col lg:flex-row gap-6">
        <div className="lg:w-80 shrink-0 space-y-3">
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border dark:border-gray-700 p-3 space-y-3">
            <div>
              <div className="text-[11px] font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">Category</div>
              <div className="grid grid-cols-3 gap-1">{CATEGORIES.map(c => <Chip key={c.id} active={category === c.id} onClick={() => setCategory(c.id)}>{c.label}</Chip>)}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">Level</div>
              <div className="flex flex-wrap gap-1">{LEVELS.map(lv => <Chip key={lv} sm active={level === lv} onClick={() => setLevel(lv)}>{lv}</Chip>)}</div>
            </div>
            {!isTeam && (
              <div>
                <div className="text-[11px] font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">Mode</div>
                <div className="flex gap-1">
                  <Chip active={mode === 'leaders'} onClick={() => setMode('leaders')}>Leaders</Chip>
                  <Chip active={mode === 'gains'} onClick={() => {
                    setMode('gains')
                    if (NO_GAIN.has(mainKey)) {
                      if (statMode === 'custom') setCustomMain(catalog.find(s => !NO_GAIN.has(s.key)).key)
                      else setPresetIdx(Math.max(0, (PRESETS[category] || []).findIndex(p => !NO_GAIN.has(p.key))))
                    }
                  }}>Biggest Gains</Chip>
                  <Chip active={mode === 'every'} onClick={() => setMode('every')}>Every Stat</Chip>
                </div>
              </div>
            )}
          </div>

          {mode !== 'every' && (
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border dark:border-gray-700 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Stat</div>
                <div className="flex gap-1">
                  <Chip sm active={statMode === 'preset'} onClick={() => setStatMode('preset')}>Preset</Chip>
                  <Chip sm active={statMode === 'custom'} onClick={() => setStatMode('custom')}>Custom</Chip>
                </div>
              </div>
              {statMode === 'preset' ? (
                <div className="flex flex-wrap gap-1">{(PRESETS[category] || []).map((p, i) => ({ p, i })).filter(({ p }) => mode !== 'gains' || !NO_GAIN.has(p.key)).map(({ p, i }) => <Chip key={p.name} sm active={presetIdx === i} onClick={() => setPresetIdx(i)}>{p.name}</Chip>)}</div>
              ) : (
                <>
                  <select value={mainKey} onChange={e => setCustomMain(e.target.value)} className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm">
                    {statChoices.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                  {mode === 'leaders' && (
                    <div>
                      <div className="text-[11px] text-gray-500 mb-1">Extra columns ({customExtra.length}/5)</div>
                      <div className="flex flex-wrap gap-1">{catalog.filter(s => s.key !== mainKey).map(s => <Chip key={s.key} sm active={customExtra.includes(s.key)} onClick={() => toggleExtra(s.key)}>{s.label}</Chip>)}</div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border dark:border-gray-700 p-3 space-y-3">
            <div>
              <div className="text-[11px] font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">How many</div>
              <div className="flex flex-wrap gap-1">{[5, 10, 15, 20, 25, 30, 40, 50].map(n => <Chip key={n} sm active={count === n} onClick={() => setCount(n)}>{n}</Chip>)}</div>
            </div>
            {!isTeam && (
              <div>
                <div className="text-[11px] font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">Qualifier</div>
                <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 mb-2">
                  <input type="checkbox" checked={qualified} onChange={e => setQualified(e.target.checked)} /> Qualified only
                </label>
                {qualified && (
                  <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                    <span>Min {cat.sampleLabel}</span>
                    <input type="number" value={minSample} placeholder={String(cat.sampleDefault)} onChange={e => setMinSample(e.target.value)}
                      className="w-20 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1" />
                  </div>
                )}
                {mode === 'gains' && (
                  <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 mt-2 pt-2 border-t border-gray-100 dark:border-gray-800">
                    <span title="Players with fewer than this many 2026 PA/IP are excluded — keeps small-sample flukes (e.g. .000 → .245) off the breakout list.">Min 2026 {cat.sampleLabel}</span>
                    <input type="number" value={min2026} placeholder={cat.side === 'bat' ? '50' : '10'} onChange={e => setMin2026(e.target.value)}
                      className="w-20 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1" />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border dark:border-gray-700 p-3 space-y-3">
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Theme</div>
                <div className="text-[11px] text-gray-500">{theme.label}{theme.sponsor ? ' · sponsor' : ''}</div>
              </div>
              <div className="flex flex-wrap gap-2">{THEMES.map(t => (
                <button key={t.id} onClick={() => setThemeId(t.id)} title={t.label}
                  className={`h-8 w-8 rounded-full border-2 relative ${themeId === t.id ? 'border-nw-teal' : 'border-transparent'}`}
                  style={{ background: t.bgStops.length > 1 ? `linear-gradient(135deg, ${t.bgStops[0]}, ${t.headerStops[0]})` : t.bgStops[0] }}>
                  {t.sponsor && <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full" style={{ background: t.sponsorAccent, border: '1px solid #fff' }} />}
                </button>
              ))}</div>
            </div>
            <input value={customTitle} onChange={e => setCustomTitle(e.target.value)} placeholder="Custom title (optional)"
              className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm" />
          </div>

          <button onClick={download} disabled={!items.length}
            className="w-full py-2.5 rounded-md bg-nw-teal text-white font-semibold text-sm hover:bg-nw-teal/90 disabled:opacity-50">⬇ Download PNG</button>
        </div>

        <div className="flex-1 min-w-0">
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-4 flex justify-center">
            <canvas ref={canvasRef} className="w-full h-auto rounded shadow" style={{ maxWidth: 540, aspectRatio: '1 / 1' }} />
          </div>
        </div>
      </div>
    </div>
  )
}
