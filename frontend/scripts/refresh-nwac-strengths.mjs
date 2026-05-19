/**
 * One-off: refresh NWAC team strength values in non_naia_teams.json using
 * live 2026 PPI rankings from the NWBB Stats API. Our previous data was
 * stale (Bellevue was showing as #3 when current PPI puts them at #12).
 *
 * Formula: strength = (PPI - 50) / 3.3  (matches the existing PEAR mapping)
 *
 * Run with: cd frontend && node scripts/refresh-nwac-strengths.mjs
 */
import fs from 'node:fs'

// Live 2026 PPI snapshot (pulled May 19, 2026 from nwbaseballstats.com).
// Keys are the team's `id` in non_naia_teams.json.
const LIVE_PPI = {
  'nwac-everett':           77.1,
  'nwac-lower-columbia':    72.1,
  'nwac-lane':              71.8,
  'nwac-spokane':           67.2,
  'nwac-linn-benton':       67.1,
  'nwac-edmonds':           65.0,
  'nwac-yakima-valley':     63.4,
  'nwac-pierce':            62.3,
  'nwac-wenatchee-valley':  58.0,
  'nwac-columbia-basin':    56.6,
  'nwac-treasure-valley':   50.3,
  'nwac-bellevue':          49.5,
  'nwac-mt-hood':           49.3,
  'nwac-clark':             49.2,
  'nwac-umpqua':            48.7,
  'nwac-tacoma':            48.6,
  'nwac-sw-oregon':         46.9,
  'nwac-centralia':         45.0,
  'nwac-olympic':           44.9,
  'nwac-shoreline':         44.5,
  'nwac-clackamas':         39.9,
  'nwac-blue-mountain':     36.9,
  'nwac-chemeketa':         36.7,
  'nwac-big-bend':          34.6,
  'nwac-walla-walla':       34.6,
  'nwac-skagit-valley':     32.7,
  'nwac-douglas':           25.7,
  'nwac-grays-harbor':      21.4,
}

const FILE = 'src/gm/data/non_naia_teams.json'
const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))

let updated = 0
let missingInLive = []
for (const div of raw.divisions || []) {
  for (const t of div.teams || []) {
    if (!t.id?.startsWith('nwac-')) continue
    const ppi = LIVE_PPI[t.id]
    if (ppi == null) {
      missingInLive.push(t.id)
      continue
    }
    const newStrength = Math.round((ppi - 50) / 3.3 * 100) / 100
    const ppiRank = Object.entries(LIVE_PPI).sort((a, b) => b[1] - a[1]).findIndex(([id]) => id === t.id) + 1
    t.strength = newStrength
    t.ppi = ppi
    t.ppiRank = ppiRank
    updated++
  }
}

fs.writeFileSync(FILE, JSON.stringify(raw, null, 2) + '\n')
console.log(`Updated ${updated} NWAC strength values from live PPI`)
if (missingInLive.length > 0) {
  console.log(`Not in live data (likely didn't field a 2026 team):`)
  for (const id of missingInLive) console.log('  ·', id)
}
