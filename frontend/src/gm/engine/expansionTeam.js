/**
 * Expansion Team builder.
 *
 * Lets the user create a brand-new program (not from the pre-loaded PNW data)
 * and slot it into any level + conference (or NWAC region). The synthetic
 * school object matches the shape that the rest of the engine expects, with
 * sensible defaults for everything the user didn't pick.
 *
 * Per Nate (June 2026):
 *   - Story mode: forced into NWAC, low funding, no history. Brand-new
 *     JUCO program clawing for relevance.
 *   - Regular dynasty: pick any conference + funding tier.
 *
 * Usage:
 *   const school = buildExpansionSchool({
 *     name: 'Cascade Mariners',
 *     city: 'Bend', state: 'OR',
 *     nickname: 'Mariners',
 *     primaryColor: '#1a3f6b', secondaryColor: '#d4af37',
 *     level: 'NWAC',
 *     conferenceId: 'NWAC_SOUTH',
 *     fundingTier: 'SHOESTRING',
 *     storyMode: false,
 *   })
 *
 * The school can then be passed to newDynastyMultiLevel as `input.expansionSchool`
 * — the dynasty bootstrap will use this instead of the pre-loaded school for the
 * user's slot.
 */

import { generateStaff } from './coaches'

/** Funding tier → resource tier + scholarship pool (in $1000s). */
const FUNDING_PRESETS = {
  // Expansion teams are by definition NEW programs — even "ELITE" can't
  // touch the budgets of historical power programs. These tiers reflect
  // what a new program could realistically pull together year 1.
  STARTUP:      { resourceTier: 'SHOESTRING',  scholarshipPool:      0, totalBudget:   180000, ph: 18, label: 'Startup (bootstrap, no scholarships)' },
  GRASSROOTS:   { resourceTier: 'SHOESTRING',  scholarshipPool:  40000, totalBudget:   320000, ph: 24, label: 'Grassroots (donor-funded, minimal aid)' },
  MID:          { resourceTier: 'MID',         scholarshipPool: 120000, totalBudget:   650000, ph: 38, label: 'Mid-Major (solid base, partial scholarships)' },
  WELL_FUNDED:  { resourceTier: 'WELL_FUNDED', scholarshipPool: 280000, totalBudget:  1200000, ph: 52, label: 'Well-Funded (alumni support, full slate)' },
  ELITE:        { resourceTier: 'D1_LITE',     scholarshipPool: 520000, totalBudget:  2200000, ph: 65, label: 'Elite (deep-pocketed, NCAA scholarships)' },
}

/** Default tuition by level — match the buildSyntheticSchool defaults. */
const DEFAULT_TUITION = {
  D1:   30000,
  D2:   24000,
  D3:   48000,
  NAIA: 28000,
  NWAC: 6000,
}

/** Compute initial pearRank/ppiRank — slot the expansion team near the BOTTOM
 *  of its level so it starts as an underdog rather than overshadowing historical
 *  programs. Story mode forces dead-last. Other tiers shift toward middle.
 */
function startingRankForExpansion(level, fundingTier, storyMode) {
  // Heuristic bottom-of-the-pile rank per level (matches the rank-bucketed
  // PH mapping in newDynastyMultiLevel.buildSyntheticSchool):
  const lastRankByLevel = { D1: 308, D2: 256, D3: 384, NAIA: 208, NWAC: 25 }
  const last = lastRankByLevel[level] ?? 100
  if (storyMode || fundingTier === 'STARTUP') return last
  if (fundingTier === 'GRASSROOTS')  return Math.max(1, Math.round(last * 0.85))
  if (fundingTier === 'MID')         return Math.max(1, Math.round(last * 0.60))
  if (fundingTier === 'WELL_FUNDED') return Math.max(1, Math.round(last * 0.35))
  if (fundingTier === 'ELITE')       return Math.max(1, Math.round(last * 0.15))
  return last
}

/**
 * Build a synthetic School object suitable for slotting into the dynasty
 * world as a brand-new program. Defaults fill in anything the user didn't
 * customize.
 *
 * @param {{
 *   name: string,
 *   city: string,
 *   state: string,
 *   nickname?: string,
 *   primaryColor?: string,
 *   secondaryColor?: string,
 *   level: 'D1'|'D2'|'D3'|'NAIA'|'NWAC',
 *   conferenceId: string,
 *   fundingTier: keyof typeof FUNDING_PRESETS,
 *   storyMode?: boolean,
 *   seed?: number|string,
 * }} input
 * @returns {object}  School object matching the shape buildSyntheticSchool produces.
 */
export function buildExpansionSchool(input) {
  if (!input || !input.name || !input.city || !input.state) {
    throw new Error('Expansion team requires name, city, and state.')
  }
  if (!input.level) throw new Error('Expansion team requires a level.')
  if (!input.conferenceId) throw new Error('Expansion team requires a conference.')
  const tier = input.storyMode ? 'STARTUP' : (input.fundingTier || 'GRASSROOTS')
  const funding = FUNDING_PRESETS[tier] || FUNDING_PRESETS.GRASSROOTS
  const level = input.level
  const id = `exp_${slug(input.name)}_${Math.floor(Math.random() * 1e6).toString(36)}`

  // Tuition + scholarships scale to level + funding tier.
  const tuition = DEFAULT_TUITION[level] ?? 28000
  const startingRank = startingRankForExpansion(level, tier, !!input.storyMode)

  // Colors — fall back to a neutral slate so the team brand renders cleanly
  // even if the user didn't pick anything.
  const colors = {
    primary:   input.primaryColor   || '#334155',
    secondary: input.secondaryColor || '#fbbf24',
  }

  return {
    id,
    name: input.name.trim(),
    nickname: (input.nickname || '').trim() || 'Expansion',
    city: input.city.trim(),
    state: input.state.trim().toUpperCase().slice(0, 2),
    conferenceId: input.conferenceId,
    level,
    // Power-related fields. programHistory drives expectedTeamOvr (Team OVR
    // display) and recruiting allure. New programs start LOW — they have to
    // earn their reputation.
    programHistory: funding.ph,
    strength: 0,  // a neutral z-score; refit each year via the regular cycle.
    pearRank: level !== 'NWAC' ? startingRank : null,
    ppiRank:  level === 'NWAC' ? startingRank : null,
    // Financials. Override any conf-default with the user's chosen tier.
    resourceTier: funding.resourceTier,
    scholarshipPool: funding.scholarshipPool,
    totalAthleticBudget: funding.totalBudget,
    tuition,
    inStateDiscount: level === 'D1' ? 0.5 : 1.0,
    roomAndBoard: 12000,
    // Facility / culture: low for a startup, scales with tier.
    facilityRating: tier === 'STARTUP' ? 25 : tier === 'GRASSROOTS' ? 38 : tier === 'MID' ? 55 : tier === 'WELL_FUNDED' ? 72 : 85,
    academicRating: 65,   // neutral middle — academic rep follows different signals
    cultureRating: 60,
    nilPotential: tier === 'ELITE' ? 70 : tier === 'WELL_FUNDED' ? 50 : 35,
    // Display flags.
    isExpansion: true,
    isStartupProgram: !!input.storyMode || tier === 'STARTUP',
    colors,
    // Region for recruiting purposes. We don't auto-detect — just default
    // to the state's region; user can update later if we surface a UI for it.
    region: regionForState(input.state),
  }
}

/** State → broad recruiting region. Mirrors the existing region map. */
function regionForState(state) {
  const s = (state || '').toUpperCase().slice(0, 2)
  if (['WA', 'OR', 'ID', 'MT', 'WY', 'AK'].includes(s)) return 'NORTHWEST'
  if (['CA', 'NV', 'AZ', 'UT', 'HI'].includes(s))       return 'WEST'
  if (['TX', 'OK', 'NM', 'CO', 'KS', 'NE', 'AR', 'LA'].includes(s)) return 'SOUTHWEST'
  if (['ND', 'SD', 'MN', 'IA', 'WI', 'IL', 'IN', 'OH', 'MI', 'MO'].includes(s)) return 'MIDWEST'
  if (['FL', 'GA', 'AL', 'MS', 'TN', 'KY', 'SC', 'NC', 'VA', 'WV'].includes(s)) return 'SOUTHEAST'
  if (['NY', 'PA', 'NJ', 'CT', 'MA', 'RI', 'NH', 'VT', 'ME', 'MD', 'DE', 'DC'].includes(s)) return 'NORTHEAST'
  return 'NORTHWEST'   // default — most of the active PNW userbase
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
}

/**
 * After dynasty creation, give the expansion team a starting head coach +
 * assistants and slot them into state.coaches + state.teams. Mirrors what
 * generateStaff does for normal programs — wired through here so the
 * caller can do it explicitly when the dynasty bootstrap doesn't see the
 * school in its loop (e.g. if the conference's schoolIds were already
 * frozen).
 */
export function attachExpansionStaff(state, school, seed) {
  if (!state.coaches) state.coaches = {}
  if (!state.teams) state.teams = {}
  const team = state.teams[school.id]
  if (!team) return
  try {
    const { headCoach, assistants } = generateStaff(school, seed || 1)
    state.coaches[headCoach.id] = headCoach
    for (const a of assistants) state.coaches[a.id] = a
    if (!team.headCoachId) team.headCoachId = headCoach.id
    if (!team.assistantCoachIds || team.assistantCoachIds.length === 0) {
      team.assistantCoachIds = assistants.map(a => a.id)
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('attachExpansionStaff failed:', e)
  }
}

/** Re-export the preset map for UI consumption. */
export { FUNDING_PRESETS }

/** Validation helper for UI — returns null if input is valid, otherwise an
 *  error string suitable for a toast. */
export function validateExpansionInput(input) {
  if (!input) return 'Missing expansion form.'
  if (!input.name || input.name.trim().length < 3) return 'Team name needs at least 3 characters.'
  if (input.name.trim().length > 40) return 'Team name is too long (max 40 chars).'
  if (!input.city || input.city.trim().length < 2) return 'City is required.'
  if (!input.state || input.state.trim().length !== 2) return 'State must be a 2-letter code (e.g. WA).'
  if (!input.level) return 'Pick a level (D1, D2, D3, NAIA, or NWAC).'
  if (!input.conferenceId) return 'Pick a conference / region to join.'
  if (input.fundingTier && !FUNDING_PRESETS[input.fundingTier]) return 'Invalid funding tier.'
  return null
}
