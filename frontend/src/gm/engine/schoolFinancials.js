/**
 * Real-world PNW school financials lookup.
 *
 * Replaces the synthetic "guess based on level" budget defaults with
 * researched figures for every PNW program in our universe.
 *
 * Data source: pnw_school_financials.json — tuition, room/board, total
 * baseball budget, scholarship pool, and the % allocation across the
 * 8 line-item categories (coaching, scholarships, travel, recruiting,
 * equipment, facilities, operations, other).
 *
 * Falls back to level-based defaults for any program NOT in the file
 * (typically non-PNW national opponents the user can schedule against
 * but won't ever coach).
 */

import data from '../data/pnw_school_financials.json'

const FINANCIALS = data.tuitionAndBudget || {}
const ALLOCATIONS = data.budgetAllocations || {}

/**
 * Find the financials block for a given school by id + level.
 * Returns { tuition, inStateDiscount, roomAndBoard, totalBudget, scholarshipPool }
 * or null if no entry exists.
 */
export function financialsFor(schoolId, level) {
  if (!schoolId) return null
  // NWAC: per-school tiered budgets (Bellevue + Lower Columbia ~ $80K, the
  // smallest commuter schools ~ $35K). Fall through to the NWAC default if
  // we don't have a specific entry for this school.
  if (level === 'NWAC') {
    const bucket = FINANCIALS.NWAC
    if (!bucket) return null
    return bucket[schoolId] || bucket.default || null
  }
  const bucket = FINANCIALS[level]
  if (!bucket) return null
  return bucket[schoolId] || null
}

/**
 * Allocation percentages per category for the given level.
 * Returns { coaching, scholarships, travel, recruiting, equipment, facilities, operations, other }.
 */
export function allocationsFor(level) {
  return ALLOCATIONS[level] || ALLOCATIONS.NAIA
}

/**
 * Per-level TRAVEL FLOOR. A road series costs real money regardless of
 * total budget — bus rental + hotel + meals for a single weekend trip is
 * ~$2.5K, and PNW programs typically have 8-12 road series per year.
 * Without these floors, smaller programs would have travel allocations of
 * $5-15K, which is below the actual cost of running their schedule. The
 * floor prevents that nonsense and gets borrowed from the next-largest
 * spend bucket (coaching) when needed.
 */
const TRAVEL_FLOOR_BY_LEVEL = {
  D1:   80000,   // charter flights for distant series
  D2:   45000,
  D3:   38000,   // bus-heavy but every Northwest Conf road trip is a real cost
  NAIA: 40000,
  NWAC: 25000,   // long-haul bus league, schools are spread across two states
}

export function travelFloorForLevel(level) {
  return TRAVEL_FLOOR_BY_LEVEL[level] || 30000
}

/**
 * Compute the full line-item breakdown of a school's baseball budget.
 *
 * Approach (after May 2026 reconciliation):
 *   - `scholarships` is anchored to the school's researched scholarshipPool
 *     (or zero at D3/NWAC).
 *   - The REMAINING $ (totalBudget - scholarshipPool) splits across the
 *     other categories via `budgetAllocations[level]` percentages, which
 *     sum to 1.0 within each level.
 *   - TRAVEL FLOOR enforcement: if the computed travel allocation falls
 *     below the per-level realistic floor, raise it to the floor and
 *     reclaim the difference from coaching (the next-largest line).
 *
 * This guarantees:
 *   (1) Scholarships line matches the recruiting page's pool exactly.
 *   (2) Travel never drops below what it physically costs to play the
 *       schedule (so a $440K NAIA program doesn't show $11K travel — it
 *       shows $40K minimum, with coaching absorbing the difference).
 *   (3) D3 + NWAC don't get a confusing "48% scholarships" split when
 *       their actual schol pool is $0.
 */
export function lineItemBudget(school) {
  if (!school) return null
  const fin = financialsFor(school.id, school.level)
  if (!fin) return null
  const alloc = allocationsFor(school.level)
  const total = fin.totalBudget || 0
  const pool = fin.scholarshipPool || 0
  const remaining = Math.max(0, total - pool)
  const out = { totalBudget: total, scholarships: pool }
  for (const [cat, pct] of Object.entries(alloc)) {
    if (cat.startsWith('_')) continue
    out[cat] = Math.round(remaining * pct)
  }
  // Travel floor enforcement — pull the shortfall from coaching.
  const floor = travelFloorForLevel(school.level)
  if (out.travel < floor) {
    const shortfall = floor - out.travel
    const reclaim = Math.min(shortfall, out.coaching || 0)
    out.coaching = (out.coaching || 0) - reclaim
    out.travel = (out.travel || 0) + reclaim
  }
  return out
}

/**
 * Apply real financials to a school object (mutates).
 * Called during dynasty creation so the school's tuitionPerYear,
 * roomAndBoardPerYear, scholarshipPool, and coachingBudget match
 * the researched values.
 *
 * If no entry exists for the school, leaves the synthetic defaults in place.
 *
 * @param {object} school
 * @returns {object} the same school, mutated
 */
export function applyRealFinancials(school) {
  if (!school) return school
  const fin = financialsFor(school.id, school.level)
  if (!fin) return school   // not in our PNW data — keep synthetic defaults
  school.tuitionPerYear = fin.tuition
  school.outOfStateTuition = fin.tuition
  school.inStateTuition = Math.round(fin.tuition * (fin.inStateDiscount ?? 1.0))
  school.roomAndBoardPerYear = fin.roomAndBoard
  school.scholarshipPool = fin.scholarshipPool
  school.totalAthleticBudget = fin.totalBudget
  // Coaching budget is one of the line items
  const breakdown = lineItemBudget(school)
  if (breakdown) {
    school.coachingBudget = breakdown.coaching
    school.travelBudget = breakdown.travel
    school.recruitingBudget = breakdown.recruiting
    school.equipmentBudget = breakdown.equipment
    school.uniformsBudget = breakdown.uniforms || 0
    school.mealsBudget = breakdown.meals || 0
    school.facilitiesBudget = breakdown.facilities
    school.medicalBudget = breakdown.medical || 0
    school.operationsBudget = breakdown.operations || 0
  }
  return school
}
