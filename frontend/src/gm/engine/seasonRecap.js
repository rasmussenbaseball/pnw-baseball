/**
 * Season Recap — comprehensive end-of-year snapshot rendered as a big modal
 * the first time the user advances from Week 52 of one year into Week 1 of
 * the next. Built in `runEndOfYear` BEFORE that function clears the
 * postseason / roster archive / draft history, so we can compare last
 * season's regular-season roster against the now-aged-and-trimmed roster
 * and report:
 *
 *   - How the team finished (record, final rank, postseason result)
 *   - Whether they overperformed / underperformed vs preseason expectation
 *   - Who LEFT (graduated, drafted, transferred out)
 *   - Who JOINED (signed recruits + summer-portal in-bound)
 *   - Budget summary for the finished year
 *   - Recruiting class summary (count by position + class type)
 *
 * Stored on `state.lastSeasonRecap` — Dashboard reads + renders + clears it.
 */

import { playerOverall, playerPotentialOverall } from './playerRating'
import { seedFromPear } from './rankings'

/**
 * Pretty label for a userEliminatedAt stage value. We map both 3-round
 * (NAIA) and 4-round (D1/D2/D3) stage names through one helper so the recap
 * reads naturally regardless of level.
 */
function postseasonResultLabel(ps, userChamp, userNatChamp, level) {
  if (!ps || !ps.userQualified) return 'Missed the postseason'
  if (userNatChamp) return 'NATIONAL CHAMPIONS'
  if (userChamp) return 'Conference champion'
  const elim = ps.userEliminatedAt
  if (!elim) return 'Postseason qualifier'
  if (elim === 'REG_SEASON') return 'Missed the postseason'
  if (elim === 'CONF') return 'Lost in conference tournament'
  if (elim === 'REGIONAL') return level && level !== 'NAIA' ? 'Lost in NCAA Regional' : 'Lost in opening round'
  if (elim === 'SUPER') return 'Lost in Super Regional'
  if (elim === 'WS') {
    const wsName = level === 'D1' ? 'College World Series'
      : level === 'D2' ? 'D-II World Series'
      : level === 'D3' ? 'D-III World Series'
      : level === 'NWAC' ? 'NWAC Championship'
      : 'NAIA World Series'
    return `Reached the ${wsName}`
  }
  return 'Postseason qualifier'
}

/**
 * Build the comprehensive recap object. Caller is responsible for stashing
 * the return value onto state.lastSeasonRecap (it's a plain serializable
 * object — safe for LZ-string save).
 *
 * MUST be called from runEndOfYear BEFORE state.postseason / state.recruits /
 * state.playerStats get cleared.
 *
 * @param {import('./types.js').SaveState} state
 * @returns {object} recap payload
 */
export function buildSeasonRecap(state) {
  const userId = state.userSchoolId
  const userTeam = state.teams?.[userId]
  if (!userTeam) return null
  // advanceOneWeek already ticked state.calendar.year on the 52→1 rollover,
  // so the year that just finished is (year - 1).
  const finishedYear = (state.calendar?.year ?? 1) - 1
  const level = state.level || 'NAIA'

  // ── Record + ranks ──────────────────────────────────────────────────────
  const record = state.teamRecordArchive?.[finishedYear]?.[userId] || {
    wins: userTeam._lastSeason?.wins ?? 0,
    losses: userTeam._lastSeason?.losses ?? 0,
    runDiff: userTeam._lastSeason?.runDiff ?? 0,
  }
  const finalRank = state.nwbbRatings?.[userId]?.nationalRank ?? null
  const finalRating = state.nwbbRatings?.[userId]?.rating ?? null
  let expectedRank = null
  try {
    const pear = seedFromPear(state.schools, state.conferences)
    const order = Object.values(pear)
      .filter(r => state.schools?.[r.schoolId]?.level === level
        || (!state.schools?.[r.schoolId]?.level && level === 'NAIA'))
      .sort((a, b) => (b.overall_rating ?? 0) - (a.overall_rating ?? 0))
    const idx = order.findIndex(r => r.schoolId === userId)
    if (idx >= 0) expectedRank = idx + 1
  } catch (e) { /* skip — back-compat */ }

  let expectationTone = 'neutral'
  let expectationBlurb = ''
  if (typeof expectedRank === 'number' && typeof finalRank === 'number') {
    const gap = expectedRank - finalRank   // +N = finished N spots BETTER
    if (gap >= 12) { expectationTone = 'overperformed'; expectationBlurb = `Picked #${expectedRank} preseason, finished #${finalRank} — a breakout season.` }
    else if (gap <= -15) { expectationTone = 'underperformed'; expectationBlurb = `Picked #${expectedRank} preseason, finished #${finalRank} — a disappointing year by AD standards.` }
    else { expectationTone = 'neutral'; expectationBlurb = `Picked #${expectedRank} preseason, finished #${finalRank} — about where the program was projected.` }
  } else if (typeof finalRank === 'number') {
    expectationBlurb = `Finished the year ranked #${finalRank} nationally.`
  }

  // ── Postseason result ──────────────────────────────────────────────────
  const ps = state.postseason
  const postseasonLabel = postseasonResultLabel(ps, !!ps?.userChamp, !!ps?.userNatChamp, level)

  // ── Departures ─────────────────────────────────────────────────────────
  // Walk the roster as it was at the END of the regular season (snapshotted
  // into rosterArchive at wk39→40) and check each player's status now. Any
  // player no longer on the current rosterPlayerIds AND whose eligibility
  // changed counts as a departure.
  const archivedRoster = state.rosterArchive?.[finishedYear] || []
  const currentRosterIds = new Set(userTeam.rosterPlayerIds || [])
  const departed = {
    graduated: [],
    drafted: [],
    transferred: [],
    other: [],
  }
  for (const pid of archivedRoster) {
    if (currentRosterIds.has(pid)) continue   // still on the team
    const p = state.players?.[pid]
    if (!p) continue
    const ovr = playerOverall(p)
    const entry = {
      id: pid,
      name: `${p.firstName} ${p.lastName}`,
      classYear: p.classYear,
      pos: p.isPitcher ? 'P' : (p.primaryPosition || 'POS'),
      isPitcher: !!p.isPitcher,
      ovr,
    }
    const status = p.eligibilityStatus
    if (status === 'graduated') departed.graduated.push(entry)
    else if (status === 'drafted') {
      entry.round = p.draftedRound ?? null
      departed.drafted.push(entry)
    } else if (status === 'transferred') departed.transferred.push(entry)
    else departed.other.push(entry)
  }

  // ── Arrivals ───────────────────────────────────────────────────────────
  // Any player on the CURRENT roster who wasn't on the end-of-regular-season
  // archive is a new arrival. Bucket by FR signee vs portal transfer-in
  // (FR was already-signed when archive was taken if they hadn't joined
  // active roster yet, but joined via runClassFinalize — they don't appear
  // in archive). We detect "incoming portal" by checking the player object's
  // previousSchoolName field; recruits straight out of HS won't have it.
  const archivedSet = new Set(archivedRoster)
  const arrivals = []
  for (const pid of userTeam.rosterPlayerIds || []) {
    if (archivedSet.has(pid)) continue
    const p = state.players?.[pid]
    if (!p) continue
    const ovr = playerOverall(p)
    const pot = playerPotentialOverall(p)
    // Heuristic: a FRESHMAN with classYear=FR + no previousSchoolName is an
    // HS recruit. Anyone with a previousSchoolName came via transfer portal.
    const isTransferIn = !!p.previousSchoolName || (p.classYear && p.classYear !== 'FR')
    arrivals.push({
      id: pid,
      name: `${p.firstName} ${p.lastName}`,
      classYear: p.classYear,
      pos: p.isPitcher ? 'P' : (p.primaryPosition || 'POS'),
      isPitcher: !!p.isPitcher,
      ovr,
      pot,
      kind: isTransferIn ? 'TRANSFER' : 'RECRUIT',
      from: p.previousSchoolName || p.hometown?.city || null,
    })
  }
  // Sort arrivals by OVR desc — most impactful first
  arrivals.sort((a, b) => b.ovr - a.ovr)

  // ── Recruiting class summary (by position + class type) ────────────────
  const classSummary = {
    total: arrivals.length,
    pitchers: arrivals.filter(a => a.isPitcher).length,
    hitters: arrivals.filter(a => !a.isPitcher).length,
    recruits: arrivals.filter(a => a.kind === 'RECRUIT').length,
    transfers: arrivals.filter(a => a.kind === 'TRANSFER').length,
    avgOvr: arrivals.length > 0
      ? arrivals.reduce((s, a) => s + a.ovr, 0) / arrivals.length : null,
    topOvr: arrivals.length > 0 ? Math.max(...arrivals.map(a => a.ovr)) : null,
    avgPot: arrivals.length > 0
      ? arrivals.reduce((s, a) => s + a.pot, 0) / arrivals.length : null,
  }

  // ── Budget summary ─────────────────────────────────────────────────────
  // The pre-runBudgetReview budget snapshot is gone by now (runBudgetReview
  // overwrote with newBudget at wk46), so we report from the CURRENT
  // (post-review) budget — which is what the new year will operate on.
  const b = state.budget || null
  const budget = b ? {
    total: b.totalAthleticBudget || 0,
    jobSecurity: b.jobSecurity ?? 50,
    allocations: { ...(b.allocations || {}) },
  } : null

  // ── MLB Draft picks (user-team only) ───────────────────────────────────
  const allDraftPicks = state.draftResults?.[finishedYear] || []
  const userDraftPicks = allDraftPicks.filter(p => p.teamId === userId)
    .map(p => ({ name: p.name, pos: p.pos, round: p.round, isPitcher: p.isPitcher }))

  return {
    finishedYear,
    nextYear: state.calendar.year,
    level,
    schoolName: state.schools?.[userId]?.name || 'Team',
    record,
    finalRank,
    finalRating,
    expectedRank,
    expectationTone,
    expectationBlurb,
    postseasonLabel,
    confChamp: !!ps?.userChamp,
    natChamp: !!ps?.userNatChamp,
    departed,
    arrivals,
    classSummary,
    budget,
    userDraftPicks,
  }
}
