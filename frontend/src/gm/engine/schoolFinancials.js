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
  // NWAC schools share a generic default (all JUCOs are ~equivalent)
  if (level === 'NWAC') return FINANCIALS.NWAC_TUITION?.default || null
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
 * Compute the full line-item breakdown of a school's baseball budget.
 * Returns dollar amounts by category that sum to totalBudget.
 */
export function lineItemBudget(school) {
  if (!school) return null
  const fin = financialsFor(school.id, school.level)
  if (!fin) return null
  const alloc = allocationsFor(school.level)
  const total = fin.totalBudget
  const out = { totalBudget: total }
  for (const [cat, pct] of Object.entries(alloc)) {
    out[cat] = Math.round(total * pct)
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
    school.facilitiesBudget = breakdown.facilities
    school.operationsBudget = breakdown.operations
  }
  return school
}
