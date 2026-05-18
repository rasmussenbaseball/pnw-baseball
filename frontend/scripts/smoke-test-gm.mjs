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
import { resolveEvent } from '../src/gm/engine/randomEvents.js'

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

function simSeasonForState(state, weeksToSim = 52) {
  // Advance through a full year (52 weeks) including postseason + offseason
  // events. Surfaces crashes in any week's hook.
  let i = 0
  const startYear = state.calendar?.year
  const crashes = []
  const tStart = Date.now()
  while (i < weeksToSim) {
    const wk = state.calendar?.weekOfYear ?? 0
    const yr = state.calendar?.year ?? startYear
    if (i % 5 === 0) {
      const elapsed = ((Date.now() - tStart) / 1000).toFixed(1)
      console.log(`     · week ${i}/${weeksToSim}  (calendar: yr${yr} wk${wk}, ${elapsed}s elapsed)`)
    }
    try {
      const ratings = seedFromPear(state.schools, state.conferences)
      simWeek(state, state.schedule || [], ratings)
      advanceWeek(state, state.schedule || [])
    } catch (e) {
      crashes.push({ year: yr, week: wk, error: e.message })
      console.error(`     ✗ sim crashed at year ${yr} wk ${wk}:`, e.message)
      console.error(e.stack?.split('\n').slice(0, 6).join('\n'))
      return { ok: false, week: wk, year: yr, error: e.message, crashes, weeksSimmed: i }
    }
    // Resolve a pending event if one fires so subsequent advances aren't
    // blocked by the modal.
    if (state.pendingEvent) {
      const choice = state.pendingEvent.choices?.[0]
      if (choice) {
        try {
          resolveEvent(state, choice.id)
        } catch (e) {
          crashes.push({ year: yr, week: wk, event: state.pendingEvent.templateId, error: e.message })
          console.error(`     ✗ event crashed: ${state.pendingEvent.templateId} → ${e.message}`)
          console.error(e.stack?.split('\n').slice(0, 5).join('\n'))
        }
      }
    }
    i++
  }
  return { ok: true, finalWeek: state.calendar?.weekOfYear, finalYear: state.calendar?.year, weeksSimmed: i, crashes }
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
// Pulled directly from nwbaseballstats.com /api/v1/team-stats?season=2025
// May 2026 — these are the actual aggregated league averages from the
// public data, not estimates.
const REAL_WORLD = {
  D1:   { avg: 0.277, ops: 0.818, era: 5.59, kPer9: 8.4, label: 'NCAA D1 2025' },
  D2:   { avg: 0.292, ops: 0.798, era: 6.32, kPer9: 6.7, label: 'NCAA D2 2025' },
  D3:   { avg: 0.280, ops: 0.786, era: 5.76, kPer9: 7.3, label: 'NCAA D3 2025' },
  NAIA: { avg: 0.294, ops: 0.857, era: 6.54, kPer9: 7.4, label: 'NAIA 2025' },
  NWAC: { avg: 0.246, ops: 0.672, era: 4.57, kPer9: 7.1, label: 'NWAC 2025' },
}

// ─── Main ───────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════')
console.log('GM SMOKE TEST — creating dynasties + simming full seasons')
console.log('═══════════════════════════════════════════════════════════')

// LEVELS env var lets you scope to one or more levels for debugging:
//   LEVELS=NAIA npx tsx scripts/smoke-test-gm.mjs
//   LEVELS=NAIA,D1 npx tsx scripts/smoke-test-gm.mjs
// WEEKS env var caps the per-level week count (default 52)
const RUN_LEVELS = (process.env.LEVELS || 'NAIA,NWAC,D1,D2,D3').split(',').map(s => s.trim().toUpperCase())
const RUN_WEEKS = parseInt(process.env.WEEKS || '52', 10)
function shouldRun(lvl) { return RUN_LEVELS.includes(lvl) }
console.log(`Scoping to levels: ${RUN_LEVELS.join(', ')}; weeks=${RUN_WEEKS}`)

const results = []

// 1. NAIA dynasty at Bushnell
if (shouldRun('NAIA')) {
  console.log('\n[1/5] Creating NAIA dynasty at Bushnell...')
  try {
    const naiaState = newDynasty(buildBase('NAIA', 'bushnell', 'cascade-collegiate'))
    console.log(`     Created. ${Object.keys(naiaState.schools).length} schools, ${Object.keys(naiaState.players).length} players.`)
    const sim = simSeasonForState(naiaState, RUN_WEEKS)
    results.push(report('NAIA', 'Bushnell', naiaState, sim))
    console.log(`     Sim done — ${sim.weeksSimmed} weeks, ended on week ${sim.finalWeek}.`)
  } catch (e) {
    results.push({ level: 'NAIA', label: 'Bushnell', crashed: true, error: e.message, stack: e.stack?.slice(0, 200) })
    console.error('     CRASHED:', e.message)
  }
}

// 2. NWAC dynasty at Bellevue
if (shouldRun('NWAC')) {
  console.log('\n[2/5] Creating NWAC dynasty at Bellevue CC...')
  try {
    const nwacState = newDynastyMultiLevel({
      ...buildBase('NWAC', 'nwac-bellevue', 'NWAC_NORTH'),
      level: 'NWAC', conferenceId: 'NWAC_NORTH',
    })
    console.log(`     Created. ${Object.keys(nwacState.schools).length} schools, ${Object.keys(nwacState.players).length} players.`)
    const sim = simSeasonForState(nwacState, RUN_WEEKS)
    results.push(report('NWAC', 'Bellevue CC', nwacState, sim))
    console.log(`     Sim done — ${sim.weeksSimmed} weeks, ended on week ${sim.finalWeek}.`)
  } catch (e) {
    results.push({ level: 'NWAC', label: 'Bellevue CC', crashed: true, error: e.message, stack: e.stack?.slice(0, 200) })
    console.error('     CRASHED:', e.message)
  }
}

// 3. D1 dynasty at Oregon
if (shouldRun('D1')) {
  console.log('\n[3/5] Creating D1 dynasty at Oregon...')
  try {
    const d1State = newDynastyMultiLevel({
      ...buildBase('D1', 'oregon-d1', 'BIG_TEN'),
      level: 'D1', conferenceId: 'BIG_TEN',
    })
    console.log(`     Created. ${Object.keys(d1State.schools).length} schools, ${Object.keys(d1State.players).length} players.`)
    const sim = simSeasonForState(d1State, RUN_WEEKS)
    results.push(report('D1', 'Oregon', d1State, sim))
    console.log(`     Sim done — ${sim.weeksSimmed} weeks, ended on week ${sim.finalWeek}.`)
  } catch (e) {
    results.push({ level: 'D1', label: 'Oregon', crashed: true, error: e.message, stack: e.stack?.slice(0, 200) })
    console.error('     CRASHED:', e.message)
  }
}

// 4. D2 dynasty at Central Washington
if (shouldRun('D2')) {
  console.log('\n[4/5] Creating D2 dynasty at Central Washington...')
  try {
    const d2State = newDynastyMultiLevel({
      ...buildBase('D2', 'central-washington-d2', 'GNAC'),
      level: 'D2', conferenceId: 'GNAC',
    })
    console.log(`     Created. ${Object.keys(d2State.schools).length} schools, ${Object.keys(d2State.players).length} players.`)
    const sim = simSeasonForState(d2State, RUN_WEEKS)
    results.push(report('D2', 'Central Washington', d2State, sim))
    console.log(`     Sim done — ${sim.weeksSimmed} weeks, ended on week ${sim.finalWeek}.`)
  } catch (e) {
    results.push({ level: 'D2', label: 'Central Washington', crashed: true, error: e.message, stack: e.stack?.slice(0, 200) })
    console.error('     CRASHED:', e.message)
  }
}

// 5. D3 dynasty at Whitworth
if (shouldRun('D3')) {
  console.log('\n[5/5] Creating D3 dynasty at Whitworth...')
  try {
    const d3State = newDynastyMultiLevel({
      ...buildBase('D3', 'whitworth-d3', 'NWC'),
      level: 'D3', conferenceId: 'NWC',
    })
    console.log(`     Created. ${Object.keys(d3State.schools).length} schools, ${Object.keys(d3State.players).length} players.`)
    const sim = simSeasonForState(d3State, RUN_WEEKS)
    results.push(report('D3', 'Whitworth', d3State, sim))
    console.log(`     Sim done — ${sim.weeksSimmed} weeks, ended on week ${sim.finalWeek}.`)
  } catch (e) {
    results.push({ level: 'D3', label: 'Whitworth', crashed: true, error: e.message, stack: e.stack?.slice(0, 200) })
    console.error('     CRASHED:', e.message)
  }
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
  // Compute deviations + flag against TIGHT tolerances (sim engine is the
  // heart of the site; loose tolerances hide real bugs).
  const avgErr = parseFloat(r.league.avg) - real.avg
  const opsErr = parseFloat(r.league.ops) - real.ops
  const eraErr = parseFloat(r.league.era) - real.era
  const k9Err = parseFloat(r.league.kPer9) - real.kPer9
  const sgn = (x) => x > 0 ? '+' : ''
  console.log(`  Δ:  AVG ${sgn(avgErr)}${avgErr.toFixed(3)}  ·  OPS ${sgn(opsErr)}${opsErr.toFixed(3)}  ·  ERA ${sgn(eraErr)}${eraErr.toFixed(2)}  ·  K/9 ${sgn(k9Err)}${k9Err.toFixed(1)}`)
  const flags = []
  if (Math.abs(avgErr) > 0.020) flags.push(`AVG off by ${avgErr.toFixed(3)}`)
  if (Math.abs(opsErr) > 0.035) flags.push(`OPS off by ${opsErr.toFixed(3)}`)
  if (Math.abs(eraErr) > 0.50)  flags.push(`ERA off by ${eraErr.toFixed(2)}`)
  if (Math.abs(k9Err) > 0.7)    flags.push(`K/9 off by ${k9Err.toFixed(1)}`)
  if (flags.length > 0) console.log(`  ⚠️ ${flags.join('  ·  ')}`)
  else console.log(`  ✓ tight match to real-world ${real.label}`)
}
console.log('\n═══════════════════════════════════════════════════════════')
