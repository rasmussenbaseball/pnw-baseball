/**
 * Comprehensive budget system.
 *
 * Each program has an annual athletic-program budget. The user allocates that
 * total across 10 categories. Going over reduces job security AND shrinks
 * next year's budget. See ../docs/budget.md.
 */

/** @typedef {import('./types.js').School} School */

export const BUDGET_CATEGORIES = [
  'scholarships',
  'coachingSalaries',
  'travel',
  'equipment',
  'uniforms',
  'meals',
  'facilities',
  'medical',
  'recruiting',
  // 'misc' removed — every slider should have a concrete game effect.
]

/**
 * LEVEL-AWARE default allocations. Each block is % of total athletic budget
 * across the 10 categories. Sums to 1.0 within each level.
 *
 * Real-world EADA reports show wildly different splits at different levels:
 *   - D1 P5: 30% coaching, 30% scholarship, 12% travel, big ops budgets
 *   - D2:    22% coaching, 40% scholarship — heaviest schol-percent tier
 *   - D3:    NO athletic scholarships at all. Money redistributes to
 *            coaching (38%), travel (20%, often charter flights/buses),
 *            facilities (10%) and equipment.
 *   - NAIA:  scholarship-heavy (55%) with tight coaching pool — most
 *            programs are 1 HC + 2 PT assistants.
 *   - NWAC:  JUCO commuter culture. No scholarships. Big coaching share
 *            (42%) because 1-2 paid coaches eat most of the budget;
 *            heavy travel (25%) covers long-haul bus league.
 *
 * If a level isn't listed, falls back to NAIA.
 */
const LEVEL_DEFAULT_ALLOCATION = {
  D1: {
    scholarships:     0.30,
    coachingSalaries: 0.30,
    travel:           0.12,
    equipment:        0.04,
    uniforms:         0.02,
    meals:            0.03,
    facilities:       0.09,
    medical:          0.04,
    recruiting:       0.06,
  },
  D2: {
    scholarships:     0.40,
    coachingSalaries: 0.22,
    travel:           0.12,
    equipment:        0.05,
    uniforms:         0.02,
    meals:            0.03,
    facilities:       0.05,
    medical:          0.03,
    recruiting:       0.08,
  },
  D3: {
    scholarships:     0.00,    // ZERO athletic aid at D3
    coachingSalaries: 0.38,
    travel:           0.20,
    equipment:        0.08,
    uniforms:         0.03,
    meals:            0.04,
    facilities:       0.13,
    medical:          0.04,
    recruiting:       0.10,
  },
  NAIA: {
    scholarships:     0.54,
    coachingSalaries: 0.19,
    travel:           0.14,
    equipment:        0.027,
    uniforms:         0.014,
    meals:            0.025,
    facilities:       0.034,
    medical:          0.013,
    recruiting:       0.017,
  },
  NWAC: {
    scholarships:     0.00,    // ZERO at JUCO
    coachingSalaries: 0.42,
    travel:           0.25,
    equipment:        0.08,
    uniforms:         0.03,
    meals:            0.05,
    facilities:       0.06,
    medical:          0.03,
    recruiting:       0.08,
  },
}

/** Legacy export — defaults to NAIA. Kept for any old callers. */
const DEFAULT_ALLOCATION = LEVEL_DEFAULT_ALLOCATION.NAIA

export function defaultAllocationForLevel(level) {
  return LEVEL_DEFAULT_ALLOCATION[level] || LEVEL_DEFAULT_ALLOCATION.NAIA
}

/**
 * Level-aware "friendly guidance" target ranges (% of total). Different
 * levels have different healthy bands because D3 + NWAC have NO scholarship
 * spend, so 0% there is correct (not 50%).
 *
 * Resolves via getBudgetGuidance(level) — fall through to NAIA-style if no
 * level on the school.
 */
const GUIDANCE_BY_LEVEL = {
  D1: {
    scholarships:     { min: 0.25, max: 0.34, note: 'NCAA D1 11.7 schol equivalents; can spread thin or stack.' },
    coachingSalaries: { min: 0.26, max: 0.34, note: 'HC + 2-3 paid assistants + operations staff.' },
    travel:           { min: 0.10, max: 0.16, note: 'Charter flights for distant series; weekend bus trips.' },
    equipment:        { min: 0.03, max: 0.05, note: 'Pro-quality gear; big bat budget.' },
    uniforms:         { min: 0.01, max: 0.03, note: 'Multiple jersey sets; alts.' },
    meals:            { min: 0.02, max: 0.04, note: 'Full training table + travel meals.' },
    facilities:       { min: 0.07, max: 0.12, note: 'Indoor facility, dedicated S&C, video room.' },
    medical:          { min: 0.03, max: 0.05, note: 'Full-time ATC + sports med staff.' },
    recruiting:       { min: 0.04, max: 0.08, note: 'National recruiting; showcase camps; flights.' },
  },
  D2: {
    scholarships:     { min: 0.35, max: 0.45, note: '9 NCAA schol equivalents — big share of budget.' },
    coachingSalaries: { min: 0.18, max: 0.26, note: '1 HC + 1-2 paid assistants.' },
    travel:           { min: 0.10, max: 0.16, note: 'Mostly bus; occasional flight.' },
    equipment:        { min: 0.04, max: 0.06, note: 'Solid mid-tier gear.' },
    uniforms:         { min: 0.01, max: 0.025, note: 'Home/away/alt.' },
    meals:            { min: 0.02, max: 0.04, note: 'Training table + road meals.' },
    facilities:       { min: 0.04, max: 0.07, note: 'Field upkeep + cages.' },
    medical:          { min: 0.02, max: 0.04, note: 'PT athletic trainer.' },
    recruiting:       { min: 0.05, max: 0.10, note: 'Regional recruiting; some flights.' },
  },
  D3: {
    scholarships:     { min: 0.0, max: 0.0, note: 'NO athletic scholarships at D3. This slot stays at zero.' },
    coachingSalaries: { min: 0.32, max: 0.44, note: 'Coaching is the biggest line item without schol $.' },
    travel:           { min: 0.16, max: 0.24, note: 'D3 travel is big — buses for full conference series.' },
    equipment:        { min: 0.06, max: 0.10, note: 'Where the saved schol $ goes — top-end bats + bullpens.' },
    uniforms:         { min: 0.02, max: 0.04, note: 'D3 programs treat unis like premium gear.' },
    meals:            { min: 0.03, max: 0.05, note: 'Training-table funding to compete with private aid.' },
    facilities:       { min: 0.10, max: 0.16, note: 'Indoor/turf field — D3 facility race is real.' },
    medical:          { min: 0.03, max: 0.05, note: 'Shared ATC across athletics.' },
    recruiting:       { min: 0.08, max: 0.14, note: 'No schol = relationship-heavy recruiting; visits matter.' },
  },
  NAIA: {
    scholarships:     { min: 0.50, max: 0.62, note: 'Biggest lever. Wins recruiting battles.' },
    coachingSalaries: { min: 0.16, max: 0.24, note: 'Pay for quality coaches.' },
    travel:           { min: 0.10, max: 0.18, note: 'Weekend bus trips + flights for distant series.' },
    equipment:        { min: 0.02, max: 0.04, note: 'Bats, helmets, gloves, baseballs.' },
    uniforms:         { min: 0.01, max: 0.025, note: 'Home/away/alt jerseys, hats.' },
    meals:            { min: 0.02, max: 0.04, note: 'Game-day meals; nutrition. Affects injury risk.' },
    facilities:       { min: 0.025, max: 0.05, note: 'Field upkeep, weight room, indoor cages.' },
    medical:          { min: 0.005, max: 0.02, note: 'Athletic trainer + supplies. Cuts injury recovery time.' },
    recruiting:       { min: 0.01, max: 0.025, note: 'Travel + camps + visits. Boosts recruiting AP.' },
  },
  NWAC: {
    scholarships:     { min: 0.0, max: 0.0, note: 'JUCO — no athletic scholarships. Stays at zero.' },
    coachingSalaries: { min: 0.38, max: 0.48, note: 'Often 1-2 paid coaches; eats most of the budget.' },
    travel:           { min: 0.20, max: 0.30, note: 'NWAC bus league — long hauls every weekend.' },
    equipment:        { min: 0.06, max: 0.10, note: 'Field gear + practice balls.' },
    uniforms:         { min: 0.02, max: 0.04, note: 'Modest jersey budget.' },
    meals:            { min: 0.03, max: 0.06, note: 'Road meals are a real cost.' },
    facilities:       { min: 0.04, max: 0.08, note: 'Often shared with high school / city; minimal upkeep.' },
    medical:          { min: 0.02, max: 0.04, note: 'Per-event coverage; rare full-time ATC.' },
    recruiting:       { min: 0.05, max: 0.10, note: 'Regional only; depends on coach pipeline.' },
  },
}

export function getBudgetGuidance(level) {
  return GUIDANCE_BY_LEVEL[level] || GUIDANCE_BY_LEVEL.NAIA
}

/**
 * Legacy NAIA-default export. Kept for back-compat with components that
 * haven't been updated to level-aware guidance yet.
 */
export const BUDGET_GUIDANCE = GUIDANCE_BY_LEVEL.NAIA

/**
 * Given a school + resource tier, build the default budget shape.
 * If actualCoachPayroll is provided, the coachingSalaries allocation is set
 * to that value (and the other categories proportionally adjusted) so the
 * budget reflects what's actually being paid out — not a static 16%.
 *
 * Total budget priority:
 *   1. school.totalAthleticBudget   (set by applyRealFinancials — most accurate)
 *   2. scholarshipPool / scholarship-fraction (legacy path; works for NAIA/D1/D2)
 *   3. level-default fallback (D3 + NWAC have no scholarship pool, must
 *      derive total from a fixed default)
 *
 * @param {School} school
 * @param {number} [actualCoachPayroll]
 * @returns {import('./types.js').BudgetState}
 */
export function defaultBudgetForSchool(school, actualCoachPayroll = null) {
  const level = school.level || 'NAIA'
  const levelAlloc = defaultAllocationForLevel(level)
  const pool = school.scholarshipPool || 0

  // ── Total budget resolution ──────────────────────────────────────────
  let total
  if (school.totalAthleticBudget && school.totalAthleticBudget > 0) {
    // Best case: researched real-world number is already on the school.
    total = school.totalAthleticBudget
  } else if (pool > 0 && (levelAlloc.scholarships || 0) > 0) {
    // Legacy: derive from scholarship pool. Only valid when both are non-zero.
    total = Math.round(pool / levelAlloc.scholarships)
  } else {
    // No real budget AND no scholarship anchor (D3 / NWAC with synthetic
    // school). Use a level-default total so the budget isn't $0.
    const LEVEL_DEFAULT_TOTAL = {
      D1:    1_300_000,
      D2:      380_000,
      D3:      220_000,
      NAIA:    170_000,
      NWAC:     55_000,
    }
    total = LEVEL_DEFAULT_TOTAL[level] || LEVEL_DEFAULT_TOTAL.NAIA
  }

  /** @type {Object<string, number>} */
  const allocations = {}
  for (const cat of BUDGET_CATEGORIES) {
    allocations[cat] = Math.round(total * (levelAlloc[cat] || 0))
  }
  // If there's a real scholarship pool, anchor scholarships to it and
  // proportionally redistribute the OTHER categories so the total still
  // matches. Without this, rounding drift makes the displayed scholarship
  // line disagree with the school.scholarshipPool number on Recruiting.
  if (pool > 0 && levelAlloc.scholarships > 0) {
    const oldSchol = allocations.scholarships
    const delta = pool - oldSchol
    allocations.scholarships = pool
    const others = BUDGET_CATEGORIES.filter(c => c !== 'scholarships')
    const otherTotal = others.reduce((s, c) => s + allocations[c], 0)
    if (otherTotal > 0) {
      for (const c of others) {
        const share = allocations[c] / otherTotal
        allocations[c] = Math.max(0, Math.round(allocations[c] - delta * share))
      }
    }
  } else {
    // No scholarship pool — force the slot to zero. D3 + NWAC stay at 0.
    allocations.scholarships = 0
  }

  // ── Travel floor ─────────────────────────────────────────────────────
  // Travel can never drop below the realistic per-level minimum cost of
  // actually running the schedule. If the proportional split landed below
  // the floor, raise travel to the floor and pull the shortfall from
  // coachingSalaries (the next-largest discretionary line).
  const TRAVEL_FLOOR_BY_LEVEL = {
    D1: 80000, D2: 45000, D3: 38000, NAIA: 40000, NWAC: 25000,
  }
  const travelFloor = TRAVEL_FLOOR_BY_LEVEL[level] || 30000
  if (allocations.travel < travelFloor) {
    const shortfall = travelFloor - allocations.travel
    const reclaim = Math.min(shortfall, allocations.coachingSalaries || 0)
    allocations.coachingSalaries = (allocations.coachingSalaries || 0) - reclaim
    allocations.travel = (allocations.travel || 0) + reclaim
  }
  // If we know the actual coach payroll, override the coachingSalaries slot
  // and steal/give back proportionally from the other categories so the total
  // still matches.
  if (actualCoachPayroll != null && actualCoachPayroll > 0) {
    const targetCoach = actualCoachPayroll
    const oldCoach = allocations.coachingSalaries
    const delta = targetCoach - oldCoach
    allocations.coachingSalaries = targetCoach
    const others = BUDGET_CATEGORIES.filter(c => c !== 'coachingSalaries')
    const otherTotal = others.reduce((s, c) => s + allocations[c], 0)
    if (otherTotal > 0) {
      for (const c of others) {
        const share = allocations[c] / otherTotal
        allocations[c] = Math.max(0, Math.round(allocations[c] - delta * share))
      }
    }
  }
  return {
    totalAthleticBudget: total,
    allocations,
    actuallySpent: BUDGET_CATEGORIES.reduce((acc, c) => { acc[c] = 0; return acc }, {}),
    overBudgetWarning: false,
    jobSecurity: 50,
    yearsAtSchool: 0,
  }
}

/**
 * Re-balance allocations so they sum to the total. The user adjusts one
 * category; this function proportionally adjusts the others.
 *
 * @param {Object<string,number>} allocations
 * @param {string} changedCategory
 * @param {number} newAmount
 * @param {number} total
 * @returns {Object<string,number>}
 */
export function rebalanceAllocations(allocations, changedCategory, newAmount, total) {
  const next = { ...allocations, [changedCategory]: Math.max(0, Math.min(total, newAmount)) }
  const otherTotal = BUDGET_CATEGORIES
    .filter(c => c !== changedCategory)
    .reduce((s, c) => s + allocations[c], 0)
  const remaining = total - next[changedCategory]
  if (otherTotal === 0) return next
  for (const c of BUDGET_CATEGORIES) {
    if (c === changedCategory) continue
    const proportion = allocations[c] / otherTotal
    next[c] = Math.round(remaining * proportion)
  }
  // Fix rounding drift
  const sum = BUDGET_CATEGORIES.reduce((s, c) => s + next[c], 0)
  const drift = total - sum
  if (drift !== 0) next[changedCategory] += drift
  return next
}

/**
 * @param {import('./types.js').BudgetState} budget
 * @returns {number} $ over budget (negative if under)
 */
export function overBudgetAmount(budget) {
  const spent = BUDGET_CATEGORIES.reduce((s, c) => s + (budget.actuallySpent[c] || 0), 0)
  return spent - budget.totalAthleticBudget
}

/**
 * Apply the annual review: compute job security delta, next-year budget adjust.
 *
 * @param {import('./types.js').BudgetState} budget
 * @param {{ wins: number, losses: number, confChampion: boolean, postseasonAppearance: boolean }} seasonResult
 * @returns {{ newBudget: import('./types.js').BudgetState, news: string[] }}
 */
export function annualReview(budget, seasonResult) {
  const gamesPlayed = seasonResult.wins + seasonResult.losses
  const winPct = gamesPlayed > 0 ? seasonResult.wins / gamesPlayed : 0.5
  const winRateAbove500 = winPct - 0.5

  const over = overBudgetAmount(budget)
  const overRatio = over > 0 ? over / Math.max(1, budget.totalAthleticBudget) : 0

  // Job security delta
  let jsDelta = 0
  jsDelta += winRateAbove500 * 30
  jsDelta -= overRatio * 30
  if (seasonResult.confChampion) jsDelta += 15
  if (seasonResult.postseasonAppearance) jsDelta += 10
  if (winPct < 0.4) jsDelta -= 6
  if (winPct < 0.3) jsDelta -= 10

  const newJobSecurity = Math.max(0, Math.min(100, budget.jobSecurity + jsDelta))

  // Next year budget adjust
  let budgetAdjustPct = 0
  if (seasonResult.confChampion) budgetAdjustPct += 0.08
  if (seasonResult.postseasonAppearance) budgetAdjustPct += 0.04
  if (winPct >= 0.6 && overRatio === 0) budgetAdjustPct += 0.03
  if (overRatio > 0) budgetAdjustPct -= Math.min(0.15, overRatio * 1.5)
  if (winPct < 0.35) budgetAdjustPct -= 0.04

  // Calculate rollover from unused $ — CAPPED AT 25% of total budget
  const spent = BUDGET_CATEGORIES.reduce((s, c) => s + (budget.actuallySpent[c] || 0), 0)
  const rolloverCap = budget.totalAthleticBudget * 0.25
  const unusedRaw = Math.max(0, budget.totalAthleticBudget - spent)
  const unused = Math.min(unusedRaw, rolloverCap)
  const cappedAmount = unusedRaw - unused   // $ that didn't roll over

  const newTotal = Math.round(budget.totalAthleticBudget * (1 + budgetAdjustPct) + unused)
  const totalDelta = newTotal - budget.totalAthleticBudget

  // Reset spent counters + scale allocations to new total
  const newAllocations = {}
  for (const c of BUDGET_CATEGORIES) {
    const ratio = budget.allocations[c] / Math.max(1, budget.totalAthleticBudget)
    newAllocations[c] = Math.round(newTotal * ratio)
  }
  const news = []
  if (seasonResult.confChampion) news.push('Conference championship AD approved 8% budget bump for next year.')
  if (seasonResult.postseasonAppearance) news.push('NAIA postseason appearance +4% budget next year.')
  if (overRatio > 0) news.push(`Over budget by $${(over / 1000).toFixed(1)}K (${(overRatio * 100).toFixed(1)}%) — AD displeased. Job security .`)
  if (newJobSecurity < 25) news.push('You are on the hot seat. Next year is critical.')
  if (unused > 0) {
    news.push(`$${(unused / 1000).toFixed(1)}K unused budget rolled over to next year.`)
  }
  if (cappedAmount > 0) {
    news.push(`$${(cappedAmount / 1000).toFixed(1)}K of unused budget exceeded the 25% rollover cap — returned to the school.`)
  }
  if (totalDelta !== 0) {
    news.push(`Budget ${totalDelta > 0 ? 'increased' : 'cut'} by $${Math.abs(totalDelta / 1000).toFixed(1)}K to $${(newTotal / 1000).toFixed(0)}K.`)
  }

  return {
    newBudget: {
      totalAthleticBudget: newTotal,
      allocations: newAllocations,
      actuallySpent: BUDGET_CATEGORIES.reduce((a, c) => { a[c] = 0; return a }, {}),
      overBudgetWarning: false,
      jobSecurity: newJobSecurity,
      yearsAtSchool: (budget.yearsAtSchool || 0) + 1,
    },
    news,
  }
}

/**
 * Apply category-level effects to gameplay metrics. Called when computing
 * sim modifiers, recruiting AP, injury rolls, etc.
 *
 * Returns a dict of modifiers based on how the user's allocation compares
 * to their tier-default allocation.
 *
 * @param {import('./types.js').BudgetState} budget
 * @returns {{
 *   equipmentBump: number,        // +/- effective OVR points on team
 *   mealsInjuryReduction: number, // % reduction in injury risk
 *   facilitiesDrift: number,      // +/- to facility rating per year
 *   medicalRecovery: number,      // % speedup to recovery from injury
 *   recruitingAPBoost: number,    // +/- AP per recruiting week
 * }}
 */
export function budgetCategoryEffects(budget, level = 'NAIA') {
  const effects = {
    equipmentBump: 0,
    mealsInjuryReduction: 0,
    facilitiesDrift: 0,
    medicalRecovery: 0,
    recruitingAPBoost: 0,
  }
  if (!budget || !budget.allocations) return effects

  const total = budget.totalAthleticBudget || 1
  const defaultPct = defaultAllocationForLevel(level)

  // Compute ratios safely. For categories whose level-default is 0% (e.g.
  // scholarships at D3/NWAC), the division would be NaN/∞ — clamp to 1.0
  // so those rows are treated as "neutral" and don't blow up downstream.
  const ratios = {}
  for (const c of BUDGET_CATEGORIES) {
    const defPct = defaultPct[c] || 0
    if (defPct <= 0) { ratios[c] = 1.0; continue }
    ratios[c] = budget.allocations[c] / total / defPct
  }

  // Each over/under-allocation has a linear effect, clipped
  effects.equipmentBump = clamp((ratios.equipment - 1) * 2, -2, 2)
  effects.mealsInjuryReduction = clamp((ratios.meals - 1) * 0.15, -0.15, 0.20)
  effects.facilitiesDrift = clamp((ratios.facilities - 1) * 1.5, -1.5, 2)
  effects.medicalRecovery = clamp((ratios.medical - 1) * 0.25, -0.25, 0.30)
  effects.recruitingAPBoost = Math.round(clamp((ratios.recruiting - 1) * 4, -3, 5))

  return effects
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// ─── Budget presets (Wk 3 tutorial picker) ─────────────────────────────────
//
// Each preset returns a full set of category percentages. Travel is OMITTED
// from the preset since it's locked from the user's actual schedule travel
// cost. The remaining non-travel categories rebalance to fill the gap.

/** @typedef {{ key: string, label: string, blurb: string, allocations: Object<string, number> }} BudgetPreset */

/** @type {BudgetPreset[]} */
export const BUDGET_PRESETS = [
  {
    key: 'BALANCED',
    label: 'Balanced',
    blurb: 'Even mix — no category neglected. Safe default for a program with no clear weakness.',
    allocations: {
      scholarships: 0.57, coachingSalaries: 0.18, equipment: 0.03, uniforms: 0.015,
      meals: 0.025, facilities: 0.035, medical: 0.015, recruiting: 0.02,
    },
  },
  {
    key: 'DEV_FOCUSED',
    label: 'Dev-focused',
    blurb: 'Heavy facilities, S&C, meals. Trade off recruiting for faster player growth — pays off over years.',
    allocations: {
      scholarships: 0.52, coachingSalaries: 0.18, equipment: 0.04, uniforms: 0.015,
      meals: 0.04, facilities: 0.065, medical: 0.025, recruiting: 0.015,
    },
  },
  {
    key: 'RECRUIT_FOCUSED',
    label: 'Recruiting-focused',
    blurb: 'Big scholarship + recruiting pools. Aggressive talent acquisition; lighter player-dev infrastructure.',
    allocations: {
      scholarships: 0.62, coachingSalaries: 0.17, equipment: 0.025, uniforms: 0.015,
      meals: 0.02, facilities: 0.025, medical: 0.01, recruiting: 0.04,
    },
  },
  {
    key: 'WIN_NOW',
    label: 'Win-now',
    blurb: 'Heavy travel cushion + meals + medical. Senior-laden teams that need to peak THIS year.',
    allocations: {
      scholarships: 0.55, coachingSalaries: 0.18, equipment: 0.035, uniforms: 0.02,
      meals: 0.035, facilities: 0.025, medical: 0.025, recruiting: 0.015,
    },
  },
  {
    key: 'PINCH_PENNIES',
    label: 'Pinch pennies',
    blurb: 'Bare minimum on extras, banked $ rolls over to next year. Use when rebuilding or saving up.',
    allocations: {
      scholarships: 0.55, coachingSalaries: 0.16, equipment: 0.02, uniforms: 0.01,
      meals: 0.015, facilities: 0.02, medical: 0.005, recruiting: 0.01,
    },
  },
  {
    key: 'STRONG_COACHING',
    label: 'Strong coaching',
    blurb: 'Top-of-market salaries to keep + attract elite assistants. Drives weekly AP and dev quality.',
    allocations: {
      scholarships: 0.54, coachingSalaries: 0.24, equipment: 0.025, uniforms: 0.015,
      meals: 0.025, facilities: 0.03, medical: 0.015, recruiting: 0.02,
    },
  },
]

/**
 * Apply a preset to the user's budget. Travel allocation is preserved (it
 * comes from the actual schedule and is locked). Other categories are
 * rebalanced to fit the remaining $.
 *
 * Level-aware: at D3 + NWAC the scholarship slot is forced to $0 (those
 * levels don't grant athletic aid) and the preset's scholarship ratio is
 * redistributed across the OTHER categories proportionally.
 *
 * @param {import('./types.js').BudgetState} budget
 * @param {BudgetPreset} preset
 * @param {string} [level]
 */
export function applyBudgetPreset(budget, preset, level = 'NAIA') {
  const total = budget.totalAthleticBudget
  const travelAllocation = budget.allocations.travel || 0
  const remainingTotal = total - travelAllocation
  if (remainingTotal <= 0) return budget
  const noScholarship = level === 'D3' || level === 'NWAC'

  // Working copy of preset ratios — strip the scholarship line at levels
  // that don't permit it, so the rest gets the full non-travel pot.
  /** @type {Object<string, number>} */
  const ratios = { ...preset.allocations }
  if (noScholarship && 'scholarships' in ratios) {
    delete ratios.scholarships
  }
  const sumRatios = Object.values(ratios).reduce((s, v) => s + v, 0)
  const next = { ...budget.allocations, travel: travelAllocation }
  if (noScholarship) next.scholarships = 0
  for (const [cat, ratio] of Object.entries(ratios)) {
    next[cat] = Math.round(remainingTotal * (ratio / sumRatios))
  }
  // Drift cleanup — toss into the LARGEST non-locked category to avoid
  // breaking the scholarship=0 invariant at D3/NWAC.
  const sum = BUDGET_CATEGORIES.reduce((s, c) => s + (next[c] || 0), 0)
  const drift = total - sum
  if (drift !== 0) {
    if (noScholarship) next.coachingSalaries = Math.max(0, (next.coachingSalaries || 0) + drift)
    else next.scholarships = Math.max(0, (next.scholarships || 0) + drift)
  }
  return { ...budget, allocations: next }
}

/**
 * Lock the travel allocation onto the budget from the actual scheduled
 * games' travel costs. Caller passes in the cost (so we avoid circular
 * imports inside this module).
 *
 * @param {import('./types.js').BudgetState} budget
 * @param {number} travelCost
 */
export function lockTravelAllocation(budget, travelCost) {
  const allocations = { ...budget.allocations, travel: Math.round(travelCost) }
  return { ...budget, allocations, travelLocked: true }
}

/**
 * Mark the budget as locked-in for the current year. After this, the Wk 3
 * tutorial gate clears and the dashboard "Set budget" requirement resolves.
 */
export function lockBudgetForYear(budget, year) {
  return { ...budget, locked: { year } }
}

/** Is the user over budget? Returns the amount or 0. */
export function budgetOverage(budget) {
  const allocated = BUDGET_CATEGORIES.reduce((s, c) => s + (budget.allocations[c] || 0), 0)
  return Math.max(0, allocated - budget.totalAthleticBudget)
}

/**
 * Extended sim-relevant effects derived from budget allocations. Adds onto
 * the legacy budgetCategoryEffects (equipment, meals, facilities, medical,
 * recruiting); also returns the dev / injury / stamina / academic / sports-
 * med modifiers used by sim.js + development.js.
 *
 * Returns multipliers/deltas that downstream code reads. 1.0 = baseline.
 *
 * @param {import('./types.js').BudgetState} budget
 */
export function extendedBudgetEffects(budget, level = 'NAIA') {
  const base = budgetCategoryEffects(budget, level)
  if (!budget || !budget.allocations) {
    return { ...base, devMultiplier: 1, injuryMultiplier: 1, staminaBoost: 0, gpaFloor: 0, recoveryMultiplier: 1, recruitPoolMultiplier: 1 }
  }
  const total = budget.totalAthleticBudget || 1
  // Level-aware "expected" %ages for the gameplay-driver categories.
  const levelAlloc = defaultAllocationForLevel(level)
  const def = {
    facilities: levelAlloc.facilities || 0.035,
    equipment:  levelAlloc.equipment  || 0.03,
    meals:      levelAlloc.meals      || 0.025,
    medical:    levelAlloc.medical    || 0.015,
    recruiting: levelAlloc.recruiting || 0.02,
  }
  const r = {}
  for (const k of Object.keys(def)) {
    const d = def[k] || 0
    if (d <= 0) { r[k] = 1.0; continue }
    r[k] = (budget.allocations[k] || 0) / total / d
  }
  return {
    ...base,
    // Facilities offseason development rate. ±20% range.
    devMultiplier: clamp(1 + (r.facilities - 1) * 0.20, 0.80, 1.25),
    // Equipment injury risk. Cheaper gear = more nicks. ±25%.
    injuryMultiplier: clamp(1 - (r.equipment - 1) * 0.25, 0.75, 1.40),
    // Meals stamina + day-to-day durability. Adds up to +3 to pitcher stamina.
    staminaBoost: clamp((r.meals - 1) * 3, -2, 3),
    // Academic support comes from misc + meals combined — affects team GPA floor.
    gpaFloor: clamp((r.meals - 1) * 0.10, -0.15, 0.15),
    // Medical recovery speed. Already in base.medicalRecovery; surface a
    // multiplier flavor for downstream code.
    recoveryMultiplier: clamp(1 + base.medicalRecovery, 0.75, 1.30),
    // Recruiting pool size + closing rate.
    recruitPoolMultiplier: clamp(1 + (r.recruiting - 1) * 0.30, 0.80, 1.40),
  }
}
