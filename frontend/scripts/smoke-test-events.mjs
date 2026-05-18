/**
 * Random-events smoke test.
 *
 * Loops over every template in EVENT_CATALOG, builds a card, then applies
 * EACH choice. Catches any apply() that crashes (the actual production
 * bug class — broken event handler bricks a save).
 *
 * Run with: cd frontend && npx tsx scripts/smoke-test-events.mjs
 */

import { newDynasty } from '../src/gm/engine/newDynasty.js'
import { EVENT_CATALOG, resolveEvent } from '../src/gm/engine/randomEvents.js'
import { makeRng } from '../src/gm/engine/rng.js'

function shortHash() { return Math.random().toString(36).slice(2, 8) }

function buildBase() {
  return {
    userSupabaseId: 'evtsmoke-' + shortHash(),
    saveSlot: 1,
    dynastyName: 'Event Smoke',
    userSchoolId: 'bushnell',
    gameOptions: {
      mode: 'TRADITIONAL', storyMode: 'CAREER', difficulty: 'NORMAL',
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

// Deep-clone via JSON. Sufficient for state since it's all plain data.
function cloneState(s) {
  // Skip player photo / coach face URLs that might break — they're strings
  // anyway, so JSON serializes fine.
  return JSON.parse(JSON.stringify(s))
}

const baseState = newDynasty(buildBase())
// Enable career so condition checks pass
baseState.career = { enabled: true, year: 1, jobSecurity: 50, happiness: 70 }
baseState.eventCooldown = { recentTemplateIds: [] }
baseState.eventHistory = []
// Set to spring so OFFSEASON-only condition tests still run others
baseState.calendar.mode = 'SEASON'
baseState.calendar.weekOfYear = 32   // mid-spring
baseState.calendar.year = 2026

const results = { templates: 0, choices: 0, builderFail: 0, applyFail: 0, errors: [] }
const totalTemplates = Object.keys(EVENT_CATALOG).length
console.log(`Testing ${totalTemplates} random-event templates…\n`)

for (const [key, tmpl] of Object.entries(EVENT_CATALOG)) {
  results.templates++
  const trial = cloneState(baseState)
  const rng = makeRng('evtsmoke', tmpl.id, Math.random())
  let card = null
  try {
    if (tmpl.condition && !tmpl.condition(trial)) {
      // Loosen — for smoke we want every template to attempt regardless
      // of dynamic condition (no on-roster injuries etc).
    }
    card = tmpl.builder(trial, rng)
  } catch (e) {
    results.builderFail++
    results.errors.push({ id: tmpl.id, phase: 'builder', error: e.message })
    console.error(`  ✗ ${key} BUILDER threw: ${e.message}`)
    continue
  }
  if (!card) {
    // Builder returned null (e.g. no players on roster matched). Skip
    // silently — the production code also handles this gracefully.
    continue
  }
  if (!card.choices || card.choices.length === 0) {
    console.warn(`  ⚠ ${key} produced no choices`)
    continue
  }
  // Apply EACH choice in a fresh clone
  for (const choice of card.choices) {
    results.choices++
    const cloneForChoice = cloneState(trial)
    cloneForChoice.pendingEvent = JSON.parse(JSON.stringify(card))
    // Re-attach apply functions (lost through JSON)
    // resolveEvent calls choice.apply directly — so we need to bypass
    // resolveEvent and call apply directly using the original choice.
    try {
      choice.apply(cloneForChoice, makeRng('evtsmoke_choice', tmpl.id, choice.id))
    } catch (e) {
      results.applyFail++
      results.errors.push({ id: tmpl.id, choiceId: choice.id, phase: 'apply', error: e.message })
      console.error(`  ✗ ${key}.${choice.id} APPLY threw: ${e.message}`)
    }
  }
  process.stdout.write('.')
  if (results.templates % 50 === 0) process.stdout.write('\n')
}

console.log('\n\n═══════════════════════════════════════════════════════')
console.log('RESULTS')
console.log('═══════════════════════════════════════════════════════')
console.log(`Templates tested: ${results.templates}`)
console.log(`Choices tested:   ${results.choices}`)
console.log(`Builder failures: ${results.builderFail}`)
console.log(`Apply failures:   ${results.applyFail}`)
if (results.errors.length > 0) {
  console.log('\nErrors:')
  for (const e of results.errors) {
    console.log(`  • ${e.id}${e.choiceId ? '.' + e.choiceId : ''} (${e.phase}): ${e.error}`)
  }
  process.exit(1)
} else {
  console.log('\n✓ All event templates + choices fired clean.')
}
