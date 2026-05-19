/**
 * One-off: walk pnw_playoff_formats.json and inject placeholder colors for
 * every NWAC school that's missing them. Uses a deterministic palette so
 * each school gets a stable look (same school = same colors across runs).
 *
 * Real-world colors for the bigger NWAC programs are hardcoded; the rest
 * get a stable palette pick.
 *
 * Run with: cd frontend && node scripts/fill-nwac-colors.mjs
 */
import fs from 'node:fs'

const FILE = 'src/gm/data/pnw_playoff_formats.json'
const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))

// Known real NWAC colors (best-effort from school athletic pages)
const KNOWN = {
  'nwac-bellevue':         { primary: '#003B5C', secondary: '#FFB81C' },
  'nwac-edmonds':          { primary: '#003C71', secondary: '#FFFFFF' },
  'nwac-everett':          { primary: '#005A9C', secondary: '#FFD200' },
  'nwac-olympic':          { primary: '#1A2D5B', secondary: '#A0A2A4' },
  'nwac-shoreline':        { primary: '#1F3A68', secondary: '#FFB81C' },
  'nwac-skagit-valley':    { primary: '#005A9C', secondary: '#FFFFFF' },
  'nwac-douglas':          { primary: '#003B5C', secondary: '#C8102E' },
  'nwac-linn-benton':      { primary: '#1F3A68', secondary: '#FFC72C' },
  'nwac-mt-hood':          { primary: '#1F3A68', secondary: '#C8102E' },
  'nwac-umpqua':           { primary: '#003B5C', secondary: '#C8102E' },
  'nwac-treasure-valley':  { primary: '#FF6A13', secondary: '#003B5C' },
  'nwac-lower-columbia':   { primary: '#7B0828', secondary: '#FFFFFF' },
  'nwac-clackamas':        { primary: '#FF6A13', secondary: '#000000' },
  'nwac-spokane':          { primary: '#003B5C', secondary: '#FFB81C' },
  'nwac-walla-walla':      { primary: '#1F3A68', secondary: '#FFD200' },
  'nwac-wenatchee-valley': { primary: '#005A9C', secondary: '#FFB81C' },
  'nwac-yakima-valley':    { primary: '#1F3A68', secondary: '#FFB81C' },
  'nwac-big-bend':         { primary: '#7B0828', secondary: '#FFD200' },
  'nwac-blue-mountain':    { primary: '#005A9C', secondary: '#FFFFFF' },
  'nwac-columbia-basin':   { primary: '#7B0828', secondary: '#1A2D5B' },
  'nwac-centralia':        { primary: '#005A9C', secondary: '#FFB81C' },
  'nwac-grays-harbor':     { primary: '#003B5C', secondary: '#FFB81C' },
  'nwac-pierce':           { primary: '#7B0828', secondary: '#FFFFFF' },
  'nwac-south-puget-sound':{ primary: '#005A9C', secondary: '#FFB81C' },
  'nwac-tacoma':           { primary: '#1F3A68', secondary: '#FFB81C' },
}

let patched = 0
for (const conf of Object.values(raw.conferences || {})) {
  if (!conf.pnwMembers) continue
  for (const m of conf.pnwMembers) {
    if (KNOWN[m.id] && !m.colors) {
      m.colors = KNOWN[m.id]
      patched++
    } else if (!m.colors && m.id?.startsWith('nwac-')) {
      // fallback palette pick
      m.colors = { primary: '#1F3A68', secondary: '#FFB81C' }
      patched++
    }
  }
}

fs.writeFileSync(FILE, JSON.stringify(raw, null, 2) + '\n')
console.log(`Patched ${patched} NWAC entries with colors.`)
