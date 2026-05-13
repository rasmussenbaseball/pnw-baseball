/**
 * Scholarship pool accounting.
 *
 * Each NAIA program funds N "equivalencies" (scholarship-equivalents) per
 * year — usually 5-12 in baseball. We track that as `school.scholarshipPool`
 * ($ amount). Current players hold most of it, and only money freed by
 * departing players (seniors, transfers out, dismissals) becomes available
 * for new recruits each cycle.
 *
 * This module is the single source of truth for "what can I still offer?"
 */

/**
 * Sum scholarship $ currently committed to the user's roster.
 * Only counts eligible/active players (not graduated/dismissed/transferred).
 *
 * @param {import('./types.js').Team} team
 * @param {Object<string, import('./types.js').Player>} players
 * @returns {number}
 */
export function committedScholarships(team, players) {
  if (!team) return 0
  let total = 0
  for (const id of team.rosterPlayerIds) {
    const p = players[id]
    if (!p) continue
    if (p.eligibilityStatus === 'graduated' || p.eligibilityStatus === 'dismissed') continue
    total += p.scholarship?.annualAmount || 0
  }
  return total
}

/**
 * Sum scholarship $ on outstanding live recruit offers (not yet signed).
 *
 * @param {Object<string, import('./types.js').Recruit>} recruits
 * @param {string} userSchoolId
 */
export function liveOfferTotal(recruits, userSchoolId) {
  if (!recruits) return 0
  let total = 0
  for (const r of Object.values(recruits)) {
    if (r.status === 'signed' || r.status === 'lost') continue
    if (r.liveOffer && r.liveOffer.schoolId === userSchoolId) {
      total += r.liveOffer.amount || 0
    }
  }
  return total
}

/**
 * Sum scholarship $ already signed (recruits who said yes — money locks in
 * when they enroll next fall).
 */
export function signedRecruitTotal(recruits, userSchoolId) {
  if (!recruits) return 0
  let total = 0
  for (const r of Object.values(recruits)) {
    if (r.status !== 'signed' || r.signedTo !== userSchoolId) continue
    total += r.liveOffer?.amount || 0
  }
  return total
}

/**
 * Sum scholarship $ on graduating seniors (classYear === 'SR').
 * Returns { dollars, count }.
 */
export function graduatingSeniorScholarships(team, players) {
  if (!team) return { dollars: 0, count: 0 }
  let dollars = 0
  let count = 0
  for (const id of team.rosterPlayerIds) {
    const p = players[id]
    if (!p) continue
    if (p.classYear === 'SR') {
      count++
      dollars += p.scholarship?.annualAmount || 0
    }
  }
  return { dollars, count }
}

/**
 * Full scholarship snapshot for the user's program. NEXT-YEAR-FOCUSED:
 * scholarships freed by graduating seniors are the actual new $ available
 * to recruit with. The "available" number reflects next year's reality.
 *
 * @param {import('./types.js').SaveState} save
 * @returns {{
 *   pool: number,
 *   committedPlayers: number,
 *   returningCommitted: number,
 *   graduatingSeniors: number,
 *   graduatingDollars: number,
 *   signedRecruits: number,
 *   pendingOffers: number,
 *   nextYearAvailable: number,
 * }}
 */
export function scholarshipSnapshot(save) {
  const school = save.schools[save.userSchoolId]
  const team = save.teams[save.userSchoolId]
  const pool = school?.scholarshipPool || 0
  const committedPlayers = committedScholarships(team, save.players)
  const { dollars: graduatingDollars, count: graduatingSeniors } =
    graduatingSeniorScholarships(team, save.players)
  const returningCommitted = committedPlayers - graduatingDollars
  const signedRecruits = signedRecruitTotal(save.recruits || {}, save.userSchoolId)
  const pendingOffers = liveOfferTotal(save.recruits || {}, save.userSchoolId)
  // Next year: pool minus what returning players hold minus what's already
  // signed for the incoming class minus what's tied up in live offers.
  const nextYearAvailable = Math.max(0, pool - returningCommitted - signedRecruits - pendingOffers)
  return {
    pool,
    committedPlayers,
    returningCommitted,
    graduatingSeniors,
    graduatingDollars,
    signedRecruits,
    pendingOffers,
    nextYearAvailable,
    // Back-compat aliases for older callers
    committed: committedPlayers + signedRecruits,
    available: nextYearAvailable,
    percentUsed: pool > 0 ? (returningCommitted + signedRecruits + pendingOffers) / pool : 0,
  }
}
