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
 * Full scholarship snapshot for the user's program.
 *
 * @param {import('./types.js').SaveState} save
 * @returns {{
 *   pool: number,
 *   committed: number,
 *   committedPlayers: number,
 *   pendingOffers: number,
 *   signedRecruits: number,
 *   available: number,
 *   percentUsed: number,
 * }}
 */
export function scholarshipSnapshot(save) {
  const school = save.schools[save.userSchoolId]
  const team = save.teams[save.userSchoolId]
  const pool = school?.scholarshipPool || 0
  const committedPlayers = committedScholarships(team, save.players)
  const pendingOffers = liveOfferTotal(save.recruits || {}, save.userSchoolId)
  const signedRecruits = signedRecruitTotal(save.recruits || {}, save.userSchoolId)
  const committed = committedPlayers + signedRecruits
  const available = Math.max(0, pool - committed - pendingOffers)
  return {
    pool,
    committed,
    committedPlayers,
    pendingOffers,
    signedRecruits,
    available,
    percentUsed: pool > 0 ? (committed + pendingOffers) / pool : 0,
  }
}
