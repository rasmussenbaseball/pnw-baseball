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
import { STATE_TO_REGION } from './regions'

/**
 * Funding tier → resource tier + scholarship pool + budget. LEVEL-AWARE —
 * Nate's audit: an NWAC junior college can't have a $2M athletic budget
 * the way a D1 powerhouse does. Each tier is realistic to its level.
 *
 *   NWAC (JUCO): $0 scholarships ALWAYS (no athletic aid at JUCO).
 *                Budgets $80K-300K — operations + travel + equipment only.
 *   D3:          $0 scholarships ALWAYS (NCAA rule). Budgets $150K-600K.
 *                Spend goes to facilities + coaching + travel.
 *   NAIA:        Some athletic aid allowed but small. $0-200K pool,
 *                $150K-800K budgets.
 *   D2:          Moderate scholarships ($30K-300K), $400K-1.5M budgets.
 *   D1:          The full range — $50K-1M scholarship pool,
 *                $400K-3M budgets.
 *
 * Per Nate (June 2026): tier numbers must match how real programs at
 * that level actually operate. An "Elite" NWAC team is still capped by
 * what NWAC budgets look like in the real world.
 */
const FUNDING_BY_LEVEL = {
  NWAC: {
    STARTUP:    { resourceTier: 'SHOESTRING',  scholarshipPool: 0, totalBudget:  60000, ph: 16, label: 'Startup ($60K budget — JUCO bootstrap)' },
    GRASSROOTS: { resourceTier: 'SHOESTRING',  scholarshipPool: 0, totalBudget: 110000, ph: 22, label: 'Community-Funded ($110K — basic operations)' },
    MID:        { resourceTier: 'SHOESTRING',  scholarshipPool: 0, totalBudget: 180000, ph: 32, label: 'Established JUCO ($180K — solid program)' },
    WELL_FUNDED:{ resourceTier: 'MID',         scholarshipPool: 0, totalBudget: 260000, ph: 44, label: 'Top NWAC ($260K — facility upgrades)' },
    ELITE:      { resourceTier: 'MID',         scholarshipPool: 0, totalBudget: 320000, ph: 52, label: 'Flagship NWAC ($320K — max realistic JUCO)' },
  },
  D3: {
    STARTUP:    { resourceTier: 'SHOESTRING',  scholarshipPool: 0, totalBudget: 120000, ph: 18, label: 'Startup ($120K — DIY operation)' },
    GRASSROOTS: { resourceTier: 'SHOESTRING',  scholarshipPool: 0, totalBudget: 220000, ph: 26, label: 'Grassroots ($220K — small private LAC)' },
    MID:        { resourceTier: 'MID',         scholarshipPool: 0, totalBudget: 360000, ph: 38, label: 'Mid-Major ($360K — solid D3 program)' },
    WELL_FUNDED:{ resourceTier: 'WELL_FUNDED', scholarshipPool: 0, totalBudget: 520000, ph: 52, label: 'Well-Funded ($520K — strong alumni support)' },
    ELITE:      { resourceTier: 'WELL_FUNDED', scholarshipPool: 0, totalBudget: 720000, ph: 64, label: 'Elite ($720K — top D3 program)' },
  },
  NAIA: {
    STARTUP:    { resourceTier: 'SHOESTRING',  scholarshipPool:      0, totalBudget: 140000, ph: 18, label: 'Startup ($140K, no scholarships)' },
    GRASSROOTS: { resourceTier: 'SHOESTRING',  scholarshipPool:  35000, totalBudget: 240000, ph: 26, label: 'Grassroots ($240K, $35K pool)' },
    MID:        { resourceTier: 'MID',         scholarshipPool:  85000, totalBudget: 420000, ph: 38, label: 'Mid-Major ($420K, $85K pool)' },
    WELL_FUNDED:{ resourceTier: 'WELL_FUNDED', scholarshipPool: 150000, totalBudget: 620000, ph: 52, label: 'Well-Funded ($620K, $150K pool)' },
    ELITE:      { resourceTier: 'WELL_FUNDED', scholarshipPool: 220000, totalBudget: 850000, ph: 64, label: 'Elite ($850K, $220K pool)' },
  },
  D2: {
    STARTUP:    { resourceTier: 'SHOESTRING',  scholarshipPool:  30000, totalBudget: 280000, ph: 18, label: 'Startup ($280K, $30K pool)' },
    GRASSROOTS: { resourceTier: 'SHOESTRING',  scholarshipPool:  75000, totalBudget: 460000, ph: 26, label: 'Grassroots ($460K, $75K pool)' },
    MID:        { resourceTier: 'MID',         scholarshipPool: 150000, totalBudget: 720000, ph: 38, label: 'Mid-Major ($720K, $150K pool)' },
    WELL_FUNDED:{ resourceTier: 'WELL_FUNDED', scholarshipPool: 240000, totalBudget: 1100000, ph: 52, label: 'Well-Funded ($1.1M, $240K pool)' },
    ELITE:      { resourceTier: 'WELL_FUNDED', scholarshipPool: 320000, totalBudget: 1500000, ph: 64, label: 'Elite ($1.5M, $320K pool)' },
  },
  D1: {
    STARTUP:    { resourceTier: 'SHOESTRING',  scholarshipPool:  60000, totalBudget: 380000, ph: 18, label: 'Startup ($380K, $60K pool)' },
    GRASSROOTS: { resourceTier: 'MID',         scholarshipPool: 180000, totalBudget: 700000, ph: 26, label: 'Grassroots ($700K, $180K pool)' },
    MID:        { resourceTier: 'WELL_FUNDED', scholarshipPool: 350000, totalBudget: 1100000, ph: 38, label: 'Mid-Major ($1.1M, $350K pool)' },
    WELL_FUNDED:{ resourceTier: 'WELL_FUNDED', scholarshipPool: 580000, totalBudget: 1700000, ph: 52, label: 'Well-Funded ($1.7M, $580K pool)' },
    ELITE:      { resourceTier: 'D1_LITE',     scholarshipPool: 850000, totalBudget: 2600000, ph: 65, label: 'Elite ($2.6M, $850K pool)' },
  },
}

/** Backward-compatible default for callers that didn't pass a level. */
const FUNDING_PRESETS = FUNDING_BY_LEVEL.NAIA

/** Look up funding preset for a level. Falls back to NAIA if level is unknown. */
function fundingForLevel(level, tier) {
  const table = FUNDING_BY_LEVEL[level] || FUNDING_BY_LEVEL.NAIA
  return table[tier] || table.GRASSROOTS
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
  const level = input.level
  const funding = fundingForLevel(level, tier)
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

  // Coaching budget — mirror buildSyntheticSchool's per-level defaults so
  // budget screens read a real number instead of undefined.
  const coachingBudget = level === 'D1' ? (funding.ph >= 75 ? 2_500_000 : 800_000)
    : level === 'D2' ? 350_000
    : level === 'D3' ? 200_000
    : level === 'NWAC' ? 80_000
    : 150_000   // NAIA

  // IMPORTANT: field names below must match buildSyntheticSchool exactly
  // (tuitionPerYear, roomAndBoardPerYear, academicReputation, engine region
  // codes, rank mirrored into pearRank). The first version of this builder
  // used its own names (tuition, academicRating, region 'NORTHWEST') and the
  // engine silently read undefined: $NaN scholarships, dead proximity
  // recruiting, wrong Team OVR. normalizeExpansionSchool() below migrates
  // saves created during that window.
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
    pearRating: 0,
    // expectedTeamOvr reads `pearRank` for every level (NWAC's ppiRank is
    // mirrored in, same as buildSyntheticSchool does).
    pearRank: startingRank,
    ppiRank:  level === 'NWAC' ? startingRank : null,
    // Financials. Override any conf-default with the user's chosen tier.
    resourceTier: funding.resourceTier,
    scholarshipPool: funding.scholarshipPool,
    totalAthleticBudget: funding.totalBudget,
    coachingBudget,
    tuitionPerYear: Math.round(tuition),
    inStateDiscount: level === 'D1' ? 0.5 : 1.0,
    roomAndBoardPerYear: level === 'NWAC' ? 0 : 12000,   // JUCOs are commuter heavy
    // Facility / culture: low for a startup, scales with tier.
    facilityRating: tier === 'STARTUP' ? 25 : tier === 'GRASSROOTS' ? 38 : tier === 'MID' ? 55 : tier === 'WELL_FUNDED' ? 72 : 85,
    academicReputation: 65,   // neutral middle — academic rep follows different signals
    cultureRating: 60,
    nilPotential: tier === 'ELITE' ? 70 : tier === 'WELL_FUNDED' ? 50 : 35,
    metroSize: 'small',
    // Display flags.
    isExpansion: true,
    isStartupProgram: !!input.storyMode || tier === 'STARTUP',
    colors,
    // Recruiting region — engine codes ('NW', 'SW', ...) from regions.js.
    // Expansion teams are PNW-locked so this is always 'NW' today.
    region: STATE_TO_REGION[input.state.trim().toUpperCase().slice(0, 2)] || 'NW',
  }
}

/**
 * Migrate an expansion school saved by the first (mis-named-fields) version
 * of buildExpansionSchool to the engine's School contract. Safe to call on
 * any school object — returns the same reference, mutated only when the old
 * field names are present. Wired into migrateSave in save.js.
 */
export function normalizeExpansionSchool(school) {
  if (!school || !school.isExpansion) return school
  if (school.tuitionPerYear == null && school.tuition != null) {
    school.tuitionPerYear = Math.round(school.tuition)
    delete school.tuition
  }
  if (school.roomAndBoardPerYear == null && school.roomAndBoard != null) {
    school.roomAndBoardPerYear = school.level === 'NWAC' ? 0 : school.roomAndBoard
    delete school.roomAndBoard
  }
  if (school.academicReputation == null && school.academicRating != null) {
    school.academicReputation = school.academicRating
    delete school.academicRating
  }
  if (school.pearRank == null && school.ppiRank != null) {
    school.pearRank = school.ppiRank
  }
  if (school.coachingBudget == null) {
    school.coachingBudget = school.level === 'D1' ? 800_000
      : school.level === 'D2' ? 350_000
      : school.level === 'D3' ? 200_000
      : school.level === 'NWAC' ? 80_000
      : 150_000
  }
  if (school.pearRating == null) school.pearRating = 0
  if (school.metroSize == null) school.metroSize = 'small'
  // Old builder wrote long-form regions ('NORTHWEST'); engine uses 'NW' codes.
  if (school.region && !['NW', 'SW', 'South', 'MW', 'SE', 'NE', 'W'].includes(school.region)) {
    school.region = STATE_TO_REGION[school.state] || 'NW'
  }
  return school
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

/** Re-export the preset maps for UI consumption.
 *  FUNDING_BY_LEVEL is the canonical source of truth — each level has its
 *  own tier scale (NWAC budgets are way smaller than D1). FUNDING_PRESETS
 *  stays exported for backward compatibility but reflects the NAIA scale. */
export { FUNDING_PRESETS, FUNDING_BY_LEVEL, fundingForLevel }

/** PNW states — the GAME scope. Expansion teams are HARD-LIMITED to these
 *  (per Nate, June 2026). British Columbia (BC) included for UBC parity. */
export const PNW_STATES = ['WA', 'OR', 'ID', 'MT', 'BC']

/** Validation helper for UI — returns null if input is valid, otherwise an
 *  error string suitable for a toast.
 *
 *  Per Nate (June 2026): expansion teams are HARD-LIMITED to PNW states.
 *  The game's whole scope is PNW + travel costs assume regional play, so
 *  a team based outside WA/OR/ID/MT/BC isn't allowed regardless of level.
 *  The city field stays free-text — they can pick any PNW city. */
export function validateExpansionInput(input) {
  if (!input) return 'Missing expansion form.'
  if (!input.name || input.name.trim().length < 3) return 'Team name needs at least 3 characters.'
  if (input.name.trim().length > 40) return 'Team name is too long (max 40 chars).'
  if (!input.city || input.city.trim().length < 2) return 'City is required.'
  if (!input.state) return 'Pick a state.'
  const stateUp = input.state.trim().toUpperCase()
  if (!PNW_STATES.includes(stateUp)) {
    return `Expansion teams must be based in the PNW (${PNW_STATES.join(', ')}).`
  }
  if (!input.level) return 'Pick a level (D1, D2, D3, NAIA, or NWAC).'
  if (!input.conferenceId) return 'Pick a conference / region to join.'
  if (input.fundingTier) {
    const table = FUNDING_BY_LEVEL[input.level]
    if (table && !table[input.fundingTier]) return 'Invalid funding tier for this level.'
  }
  return null
}

/** Labels for the PNW state dropdown. */
export const PNW_STATE_OPTIONS = [
  { code: 'WA', label: 'Washington' },
  { code: 'OR', label: 'Oregon' },
  { code: 'ID', label: 'Idaho' },
  { code: 'MT', label: 'Montana' },
  { code: 'BC', label: 'British Columbia' },
]
