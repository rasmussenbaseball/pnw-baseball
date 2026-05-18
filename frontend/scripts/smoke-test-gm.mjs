/**
 * GM smoke test — creates a dynasty, sims a full season, dumps stats per level.
 *
 * Runs the actual engine modules end-to-end so it catches real sim bugs (not just
 * surface UI ones). Validates that NAIA / NWAC / D1 produce different league
 * averages in roughly the right ballpark vs real college baseball.
 *
 * Run with:  cd frontend && npx tsx scripts/smoke-test-gm.mjs
 */

import { newDynasty } from '../src/gm/engine/newDynasty.js'
import { newDynastyMultiLevel } from '../src/gm/engine/newDynastyMultiLevel.js'
import { advanceWeek, simWeek } from '../src/gm/engine/season.js'
import { seedFromPear } from '../src/gm/engine/rankings.js'
import { leagueAverages, computeBatting, computePitching } from '../src/gm/engine/advancedStats.js'
import { synthesizeLeagueStats } from '../src/gm/engine/leagueStats.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function shortHash() {
  return Math.random().toString(36).slice(2, 8)
}

function buildBase(level, schoolId, conferenceId, name = 'Test') {
  return {
    userSupabaseId: 'smoke-' + shortHash(),
    saveSlot: 1,
    dynastyName: 'Smoke Test',
    userSchoolId: schoolId,
    gameOptions: {
      mode: 'TRADITIONAL', storyMode: 'REGULAR', difficulty: 'NORMAL',
      injuriesEnabled: true, coachFiringEnabled: true,
      transferPortalEnabled: true, budgetConstraintsEnabled: true,
    },
    userCoach: {
      firstName: 'Smoke', lastName: 'Tester',
      lookId: 0, primaryRegion: 'NW', secondaryRegion: 'W',
      regions: ['NW', 'W'], archetype: 'GENERALIST',
      recruiter_type: 'BALANCED',
      developer: 50, motivator: 50, recruiter: 50, tactician: 50,
    },
  }
}

function aggregateLeague(state) {
  // Returns league-wide hitting + pitching aggregates. Sim only writes
  // playerStats for the USER'S games (one team at a time). To get league
  // averages we synthesize the rest of the league via synthesizeLeagueStats
  // which back-computes everyone's lines from ratings + games played.
  let leagueStats = {}
  try {
    leagueStats = synthesizeLeagueStats(state, state.calendar?.year, state.rngSeed || 1)
  } catch (e) {
    console.warn('synthesizeLeagueStats failed:', e.message)
    leagueStats = state.playerStats || {}
  }
  // Merge real + synthesized — real wins (user's actual games), synthesized
  // fills in everyone else.
  const merged = { ...leagueStats, ...(state.playerStats || {}) }
  let pa = 0, ab = 0, h = 0, d = 0, t = 0, hr = 0, bb = 0, hbp = 0, k = 0
  let outs = 0, er = 0, pBB = 0, pK = 0, pHR = 0
  let nHitters = 0, nPitchers = 0
  for (const [key, row] of Object.entries(merged)) {
    if (key.startsWith('p_')) {
      outs += row.outs || 0
      er += row.er || 0
      pBB += row.bb || 0
      pK += row.k || 0
      pHR += row.hr || 0
      if (row.outs) nPitchers++
    } else {
      pa += row.pa || 0
      ab += row.ab || 0
      h += row.h || 0
      d += row.d || 0
      t += row.t || 0
      hr += row.hr || 0
      bb += row.bb || 0
      hbp += row.hbp || 0
      k += row.k || 0
      if (row.ab) nHitters++
    }
  }
  const ip = outs / 3
  return {
    nHitters, nPitchers,
    avg: ab > 0 ? h / ab : 0,
    obp: (ab + bb + hbp) > 0 ? (h + bb + hbp) / (ab + bb + hbp) : 0,
    slg: ab > 0 ? (h + d + 2 * t + 3 * hr) / ab : 0,
    hrPerGame: nHitters > 0 ? hr / (nHitters / 9) / Math.max(1, (pa / (nHitters * 4.3))) : 0,
    kPctH: pa > 0 ? k / pa : 0,
    era: ip > 0 ? er * 9 / ip : 0,
    whip: ip > 0 ? (pBB + h) / ip : 0,
    kPer9: ip > 0 ? pK * 9 / ip : 0,
    pa, ab, h, hr, ip,
  }
}

function simSeasonForState(state, weeksToSim = 18) {
  // Advance up to week 39 (end of regular season). Cap at 18 calendar weeks.
  let i = 0
  while (i < weeksToSim && (state.calendar?.weekOfYear ?? 0) < 40) {
    try {
      const ratings = seedFromPear(state.schools, state.conferences)
      simWeek(state, state.schedule || [], ratings)
      advanceWeek(state, state.schedule || [])
    } catch (e) {
      console.error('sim crash at wk', state.calendar?.weekOfYear, e.message)
      return { ok: false, week: state.calendar?.weekOfYear, error: e.message }
    }
    i++
  }
  return { ok: true, finalWeek: state.calendar?.weekOfYear, weeksSimmed: i }
}

function report(level, label, state, simResult) {
  if (!simResult.ok) {
    return { level, label, error: simResult.error, week: simResult.week }
  }
  const agg = aggregateLeague(state)
  const lg = leagueAverages(state)
  return {
    level, label,
    finalWeek: simResult.finalWeek,
    rosters: Object.keys(state.teams || {}).length,
    scheduleGames: (state.schedule || []).length,
    playedGames: (state.schedule || []).filter(g => g.played).length,
    league: {
      avg: agg.avg.toFixed(3),
      obp: agg.obp.toFixed(3),
      slg: agg.slg.toFixed(3),
      ops: (agg.obp + agg.slg).toFixed(3),
      kPct: (agg.kPctH * 100).toFixed(1) + '%',
      era: agg.era.toFixed(2),
      whip: agg.whip.toFixed(2),
      kPer9: agg.kPer9.toFixed(1),
      leagueWoba: lg.leagueWoba.toFixed(3),
      leagueEra: lg.leagueEra.toFixed(2),
    },
    counts: {
      hitters: agg.nHitters,
      pitchers: agg.nPitchers,
      totalPA: agg.pa,
      totalIP: agg.ip.toFixed(0),
    },
  }
}

// ─── Reference: real-world college baseball averages ──────────────────────
// Sources: NCAA D1 stats annual, NAIA stats, NWAC stats.
const REAL_WORLD = {
  D1:   { avg: 0.282, ops: 0.785, era: 5.20, kPer9: 9.1, label: 'NCAA D1 2024' },
  D2:   { avg: 0.285, ops: 0.795, era: 5.50, kPer9: 8.6, label: 'NCAA D2 2024' },
  D3:   { avg: 0.300, ops: 0.830, era: 5.95, kPer9: 7.8, label: 'NCAA D3 2024' },
  NAIA: { avg: 0.295, ops: 0.820, era: 5.80, kPer9: 8.2, label: 'NAIA 2024' },
  NWAC: { avg: 0.293, ops: 0.815, era: 5.65, kPer9: 8.0, label: 'NWAC 2024' },
}

// ─── Main ───────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════')
console.log('GM SMOKE TEST — creating dynasties + simming full seasons')
console.log('═══════════════════════════════════════════════════════════')

const results = []

// 1. NAIA dynasty at Bushnell
console.log('\n[1/3] Creating NAIA dynasty at Bushnell...')
try {
  const naiaState = newDynasty(buildBase('NAIA', 'bushnell', 'cascade-collegiate'))
  console.log(`     Created. ${Object.keys(naiaState.schools).length} schools, ${Object.keys(naiaState.players).length} players.`)
  const sim = simSeasonForState(naiaState, 18)
  results.push(report('NAIA', 'Bushnell', naiaState, sim))
  console.log(`     Sim done — ${sim.weeksSimmed} weeks, ended on week ${sim.finalWeek}.`)
} catch (e) {
  results.push({ level: 'NAIA', label: 'Bushnell', crashed: true, error: e.message, stack: e.stack?.slice(0, 200) })
  console.error('     CRASHED:', e.message)
}

// 2. NWAC dynasty at Bellevue (correct ID is nwac-bellevue)
console.log('\n[2/3] Creating NWAC dynasty at Bellevue CC...')
try {
  const nwacState = newDynastyMultiLevel({
    ...buildBase('NWAC', 'nwac-bellevue', 'NWAC_NORTH'),
    level: 'NWAC', conferenceId: 'NWAC_NORTH',
  })
  console.log(`     Created. ${Object.keys(nwacState.schools).length} schools, ${Object.keys(nwacState.players).length} players.`)
  const sim = simSeasonForState(nwacState, 18)
  results.push(report('NWAC', 'Bellevue CC', nwacState, sim))
  console.log(`     Sim done — ${sim.weeksSimmed} weeks, ended on week ${sim.finalWeek}.`)
} catch (e) {
  results.push({ level: 'NWAC', label: 'Bellevue CC', crashed: true, error: e.message, stack: e.stack?.slice(0, 200) })
  console.error('     CRASHED:', e.message)
}

// 3. D1 dynasty at Oregon
console.log('\n[3/3] Creating D1 dynasty at Oregon...')
try {
  const d1State = newDynastyMultiLevel({
    ...buildBase('D1', 'oregon-d1', 'BIG_TEN'),
    level: 'D1', conferenceId: 'BIG_TEN',
  })
  console.log(`     Created. ${Object.keys(d1State.schools).length} schools, ${Object.keys(d1State.players).length} players.`)
  const sim = simSeasonForState(d1State, 18)
  results.push(report('D1', 'Oregon', d1State, sim))
  console.log(`     Sim done — ${sim.weeksSimmed} weeks, ended on week ${sim.finalWeek}.`)
} catch (e) {
  results.push({ level: 'D1', label: 'Oregon', crashed: true, error: e.message, stack: e.stack?.slice(0, 200) })
  console.error('     CRASHED:', e.message)
}

// ─── Report ─────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════')
console.log('RESULTS')
console.log('═══════════════════════════════════════════════════════════')
for (const r of results) {
  console.log(`\n${r.level} — ${r.label}`)
  if (r.crashed) {
    console.log('  ❌ CRASHED:', r.error)
    console.log('     stack:', r.stack)
    continue
  }
  if (r.error) {
    console.log('  ⚠️ sim halted at week', r.week, ':', r.error)
    continue
  }
  const real = REAL_WORLD[r.level]
  console.log(`  rosters: ${r.rosters}, schedule games: ${r.scheduleGames}, played: ${r.playedGames}`)
  console.log(`  hitters: ${r.counts.hitters}, pitchers: ${r.counts.pitchers}, total PA: ${r.counts.totalPA}, total IP: ${r.counts.totalIP}`)
  console.log(`  AVG ${r.league.avg}  (real ${real.avg.toFixed(3)})`)
  console.log(`  OPS ${r.league.ops}  (real ${real.ops.toFixed(3)})`)
  console.log(`  ERA ${r.league.era}  (real ${real.era.toFixed(2)})`)
  console.log(`  K/9 ${r.league.kPer9} (real ${real.kPer9.toFixed(1)})`)
  console.log(`  K%  ${r.league.kPct}`)
  console.log(`  WHIP ${r.league.whip}`)
  // Flag big mismatches
  const avgErr = Math.abs(parseFloat(r.league.avg) - real.avg)
  const opsErr = Math.abs(parseFloat(r.league.ops) - real.ops)
  const eraErr = Math.abs(parseFloat(r.league.era) - real.era)
  const flags = []
  if (avgErr > 0.035) flags.push(`AVG off by ${avgErr.toFixed(3)}`)
  if (opsErr > 0.080) flags.push(`OPS off by ${opsErr.toFixed(3)}`)
  if (eraErr > 1.50) flags.push(`ERA off by ${eraErr.toFixed(2)}`)
  if (flags.length > 0) console.log(`  ⚠️ ${flags.join('  ·  ')}`)
  else console.log(`  ✓ within range of real-world ${real.label}`)
}
console.log('\n═══════════════════════════════════════════════════════════')
