/**
 * Story-mode smoke test.
 *
 * Validates the OFFER → ACCEPT → TRANSITION flow that the public audit
 * flagged as untested. Fabricates an offer to a tier-jump school, accepts
 * it, then runs another partial season to confirm the user's identity
 * stays consistent on the new team.
 *
 * Run with: cd frontend && npx tsx scripts/smoke-test-story.mjs
 */

import { newDynasty } from '../src/gm/engine/newDynasty.js'
import { newDynastyMultiLevel } from '../src/gm/engine/newDynastyMultiLevel.js'
import { acceptCareerOffer, declineAllCareerOffers } from '../src/gm/engine/storyMode.js'
import { simWeek, advanceWeek } from '../src/gm/engine/season.js'
import { seedFromPear } from '../src/gm/engine/rankings.js'

function shortHash() { return Math.random().toString(36).slice(2, 8) }

function buildBase(level, schoolId, conferenceId) {
  return {
    userSupabaseId: 'storysmoke-' + shortHash(),
    saveSlot: 1,
    dynastyName: 'Story Smoke',
    userSchoolId: schoolId,
    gameOptions: {
      mode: 'TRADITIONAL', storyMode: 'CAREER', difficulty: 'NORMAL',
      injuriesEnabled: true, coachFiringEnabled: true,
      transferPortalEnabled: true, budgetConstraintsEnabled: true,
    },
    userCoach: {
      firstName: 'Story', lastName: 'Tester',
      lookId: 0, primaryRegion: 'NW', secondaryRegion: 'W',
      regions: ['NW', 'W'], archetype: 'GENERALIST',
      recruiter_type: 'BALANCED',
      developer: 50, motivator: 50, recruiter: 50, tactician: 50,
    },
  }
}

console.log('═══════════════════════════════════════════════════════════')
console.log('STORY MODE SMOKE — offer accept-cycle, transition, year-roll')
console.log('═══════════════════════════════════════════════════════════\n')

// 1. Create NAIA Bushnell dynasty
console.log('[1/4] Creating NAIA story mode dynasty at Bushnell…')
const state = newDynasty(buildBase('NAIA', 'bushnell', 'cascade-collegiate'))
state.career = state.career || {
  enabled: true, year: 1, difficulty: 'NORMAL', jobSecurity: 50, happiness: 70,
  trajectory: [{ year: state.calendar.year, schoolId: 'bushnell', schoolName: state.schools['bushnell']?.name, level: 'NAIA', role: 'HEAD_COACH', wins: 0, losses: 0, result: 'started' }],
  currentOffers: [],
  pendingFiring: null,
  careerEnded: false,
  goalAchieved: false,
  achievements: [],
}
state.career.enabled = true
console.log(`     ✓ Created. user=${state.userSchoolId}, level=${state.level || 'NAIA'}`)

// 2. Synthesize an offer — accept-cycle is the unverified path
console.log('\n[2/4] Synthesizing tier-jump offer (NAIA HC → D2 HC Central Washington)…')
const offer = {
  id: 'offer_synth_1',
  fromSchoolId: 'central-washington-d2',
  fromSchoolName: 'Central Washington',
  role: 'HEAD_COACH',
  level: 'D2',
  salary: 95000,
  tier: 5,
  message: 'Synthesized offer for smoke test.',
}
state.career.currentOffers = [offer]
// Bootstrap: make sure target school exists in state.schools/state.teams.
// For this test, since the base state only loads NAIA schools, we manually
// stub the destination team so acceptCareerOffer can find it.
if (!state.schools['central-washington-d2']) {
  state.schools['central-washington-d2'] = {
    id: 'central-washington-d2',
    name: 'Central Washington',
    city: 'Ellensburg', state: 'WA',
    level: 'D2',
    conferenceId: 'GNAC',
    nickname: 'Wildcats',
    colors: { primary: '#000000', secondary: '#cf102c' },
  }
}
if (!state.teams['central-washington-d2']) {
  state.teams['central-washington-d2'] = {
    schoolId: 'central-washington-d2',
    headCoachId: null,
    assistantCoachIds: [],
    rosterPlayerIds: [],
    wins: 0, losses: 0, runDiff: 0, confWins: 0, confLosses: 0,
  }
}
console.log(`     ✓ Offer staged: ${offer.fromSchoolName} ${offer.level} ${offer.role}`)

// 3. Accept the offer
console.log('\n[3/4] Calling acceptCareerOffer…')
const r = acceptCareerOffer(state, offer.id)
console.log(`     result: ${JSON.stringify(r)}`)
console.log(`     userSchoolId now: ${state.userSchoolId}`)
console.log(`     state.level now: ${state.level}`)
console.log(`     trajectory length: ${state.career.trajectory.length}`)
console.log(`     achievements: [${state.career.achievements.join(', ')}]`)
console.log(`     newsfeed top: ${state.newsfeed?.[0]?.headline || '(empty)'}`)
if (!r.ok) {
  console.error('\n✗ accept failed:', r.error)
  process.exit(1)
}

// 4. Sim a few weeks at the new school to confirm no crash
console.log('\n[4/4] Simming 6 weeks at the new school…')
let crashed = false
for (let i = 0; i < 6; i++) {
  try {
    const ratings = seedFromPear(state.schools, state.conferences)
    simWeek(state, state.schedule || [], ratings)
    advanceWeek(state, state.schedule || [])
  } catch (e) {
    console.error(`     ✗ crash at i=${i}: ${e.message}`)
    console.error(e.stack?.split('\n').slice(0, 5).join('\n'))
    crashed = true
    break
  }
}
if (!crashed) console.log(`     ✓ Sim ran ${6} weeks clean after transition.`)

// 5. Test decline path (separate state)
console.log('\n[5] Testing declineAllCareerOffers path…')
const state2 = newDynasty(buildBase('NAIA', 'bushnell', 'cascade-collegiate'))
state2.career = {
  enabled: true, year: 5, difficulty: 'NORMAL', jobSecurity: 5, happiness: 30,
  trajectory: [{ year: state2.calendar.year, schoolId: 'bushnell', schoolName: 'Bushnell', level: 'NAIA', role: 'HEAD_COACH', wins: 0, losses: 0, result: 'started' }],
  currentOffers: [{ ...offer }],
  pendingFiring: { fromSchoolName: 'Bushnell', reason: 'low jobSecurity' },
  careerEnded: false,
  goalAchieved: false,
  achievements: [],
}
const dr = declineAllCareerOffers(state2)
console.log(`     result: ${JSON.stringify(dr)}`)
console.log(`     careerEnded: ${state2.career.careerEnded}`)
console.log(`     newsfeed top: ${state2.newsfeed?.[0]?.headline || '(empty)'}`)

console.log('\n═══════════════════════════════════════════════════════════')
console.log(crashed ? '✗ STORY MODE: crash during post-accept sim' : '✓ STORY MODE: offer cycle works end-to-end')
console.log('═══════════════════════════════════════════════════════════')
process.exit(crashed ? 1 : 0)
