/**
 * PNW team audit.
 *
 * Walks every PNW school at every level, verifies data completeness (colors,
 * location, tuition, conference), creates a dynasty at that level, and
 * reports the starting OVR range of each team's roster.
 *
 * Run with: cd frontend && npx tsx scripts/pnw-team-audit.mjs
 */

import { newDynasty } from '../src/gm/engine/newDynasty.js'
import { newDynastyMultiLevel } from '../src/gm/engine/newDynastyMultiLevel.js'
import { pnwProgramsAtLevel } from '../src/gm/engine/pnwPlayoffs.js'
import { playerOverall } from '../src/gm/engine/playerRating.js'
import pnwFinancials from '../src/gm/data/pnw_school_financials.json'
import schoolsRaw from '../src/gm/data/schools.json'

const baseInput = {
  userSupabaseId: 'audit',
  saveSlot: 1,
  dynastyName: 'Audit',
  gameOptions: {
    mode: 'TRADITIONAL', storyMode: 'REGULAR', difficulty: 'NORMAL',
    injuriesEnabled: false, coachFiringEnabled: false,
    transferPortalEnabled: false, budgetConstraintsEnabled: false,
  },
  userCoach: {
    firstName: 'Audit', lastName: 'Tester',
    lookId: 0, primaryRegion: 'NW', secondaryRegion: 'W',
    regions: ['NW', 'W'], archetype: 'GENERALIST',
    recruiter_type: 'BALANCED',
    developer: 50, motivator: 50, recruiter: 50, tactician: 50,
  },
}

function makeState(level, schoolId, conferenceId) {
  const input = { ...baseInput, userSchoolId: schoolId }
  if (level === 'NAIA') {
    return newDynasty({ ...input, dynastyName: `Audit ${level} ${schoolId}` })
  }
  return newDynastyMultiLevel({ ...input, level, conferenceId, dynastyName: `Audit ${level} ${schoolId}` })
}

function rosterOvrStats(state, schoolId) {
  const team = state.teams[schoolId]
  if (!team) return null
  const ovrs = (team.rosterPlayerIds || [])
    .map(id => state.players[id])
    .filter(Boolean)
    .map(p => playerOverall(p))
    .filter(o => typeof o === 'number')
    .sort((a, b) => b - a)
  if (ovrs.length === 0) return null
  const top9 = ovrs.slice(0, 9).reduce((s, x) => s + x, 0) / Math.min(9, ovrs.length)
  return {
    count: ovrs.length,
    high: ovrs[0],
    low: ovrs[ovrs.length - 1],
    avg: Math.round(ovrs.reduce((s, x) => s + x, 0) / ovrs.length),
    top9: Math.round(top9),
    topPitcherCount: ovrs.filter(o => o >= 75).length,
  }
}

const LEVELS = ['NAIA', 'D1', 'D2', 'D3', 'NWAC']
const out = { perTeam: [], gaps: [] }

console.log('═══════════════════════════════════════════════════════════════')
console.log('PNW TEAM AUDIT — data completeness + starting OVR ranges')
console.log('═══════════════════════════════════════════════════════════════\n')

for (const level of LEVELS) {
  const programs = pnwProgramsAtLevel(level)
  console.log(`\n──── ${level} (${programs.length} programs) ────────────────────────`)
  // Cache one dynasty per conference; opening one creates rosters for the whole level
  const stateByConf = {}
  for (const p of programs) {
    const conf = p.conferenceId
    if (!stateByConf[conf]) {
      try {
        stateByConf[conf] = makeState(level, p.id, conf)
      } catch (e) {
        out.gaps.push({ level, schoolId: p.id, problem: 'CREATE_FAILED: ' + e.message })
        continue
      }
    }
    const state = stateByConf[conf]
    const school = state.schools[p.id]
    const team = state.teams[p.id]
    const fin = (pnwFinancials.tuitionAndBudget?.[level] || {})[p.id]
    const issues = []
    if (!school) issues.push('NO SCHOOL ROW')
    if (!school?.colors?.primary) issues.push('no colors')
    if (!school?.city || !school?.state) issues.push('no city/state')
    if (!school?.conferenceId) issues.push('no conferenceId')
    if (!school?.nickname && level !== 'NWAC') issues.push('no nickname')
    if (!fin) issues.push('NO FINANCIAL DATA')
    else {
      if (!fin.tuition) issues.push('no tuition')
      if (!fin.totalBudget) issues.push('no totalBudget')
    }
    if (!team) issues.push('NO TEAM (no roster)')
    const ovrStats = team ? rosterOvrStats(state, p.id) : null
    const ovrLine = ovrStats
      ? `OVR ${ovrStats.low}-${ovrStats.high} (avg ${ovrStats.avg}, top9 ${ovrStats.top9}, n=${ovrStats.count})`
      : 'no roster'
    const flag = issues.length === 0 ? '✓' : '⚠'
    const status = issues.length > 0 ? ` ⚠ ${issues.join(', ')}` : ''
    console.log(`  ${flag} ${p.name.padEnd(28)} ${ovrLine}${status}`)
    out.perTeam.push({ level, schoolId: p.id, name: p.name, conf, ovrStats, issues })
    if (issues.length > 0) {
      out.gaps.push({ level, schoolId: p.id, name: p.name, issues })
    }
  }
}

console.log('\n═══════════════════════════════════════════════════════════════')
console.log(`SUMMARY: ${out.perTeam.length} programs audited, ${out.gaps.length} with data gaps`)
console.log('═══════════════════════════════════════════════════════════════')
if (out.gaps.length > 0) {
  console.log('\nGaps:')
  for (const g of out.gaps) {
    console.log(`  · ${g.level} ${g.name || g.schoolId}: ${(g.issues || [g.problem]).join(' / ')}`)
  }
}
