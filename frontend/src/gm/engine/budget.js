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
  'misc',
]

/**
 * Default % allocation across the 10 categories. Sums to 1.0.
 */
const DEFAULT_ALLOCATION = {
  scholarships:      0.44,
  coachingSalaries:  0.16,
  travel:            0.14,
  equipment:         0.07,
  uniforms:          0.03,
  meals:             0.05,
  facilities:        0.05,
  medical:           0.02,
  recruiting:        0.02,
  misc:              0.02,
}

/**
 * Tier-based total annual baseball-program budgets ($).
 * Realistic ranges for NAIA programs (see ../docs/budget.md).
 */
const TIER_TOTAL_BUDGET = {
  D1_LITE:     1000000,
  WELL_FUNDED: 525000,
  MID:         275000,
  SHOESTRING:  140000,
}

/**
 * Given a school + resource tier, build the default budget shape.
 * @param {School} school
 * @returns {import('./types.js').BudgetState}
 */
export function defaultBudgetForSchool(school) {
  const total = TIER_TOTAL_BUDGET[school.resourceTier] || TIER_TOTAL_BUDGET.MID
  /** @type {Object<string, number>} */
  const allocations = {}
  for (const cat of BUDGET_CATEGORIES) {
    allocations[cat] = Math.round(total * DEFAULT_ALLOCATION[cat])
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
  if (seasonResult.confChampion) news.push('Conference championship → AD approved 8% budget bump for next year.')
  if (seasonResult.postseasonAppearance) news.push('NAIA postseason appearance → +4% budget next year.')
  if (overRatio > 0) news.push(`Over budget by $${(over / 1000).toFixed(1)}K (${(overRatio * 100).toFixed(1)}%) — AD displeased. Job security ↓.`)
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
export function budgetCategoryEffects(budget) {
  const effects = {
    equipmentBump: 0,
    mealsInjuryReduction: 0,
    facilitiesDrift: 0,
    medicalRecovery: 0,
    recruitingAPBoost: 0,
  }
  if (!budget || !budget.allocations) return effects

  const total = budget.totalAthleticBudget || 1
  const defaultPct = DEFAULT_ALLOCATION

  const ratios = {}
  for (const c of BUDGET_CATEGORIES) {
    ratios[c] = budget.allocations[c] / total / defaultPct[c]  // 1.0 = matches default; 2.0 = double
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
