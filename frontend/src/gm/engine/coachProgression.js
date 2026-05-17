/**
 * Head-coach progression.
 *
 * The user's HC earns "upgrade points" when the program performs well —
 * wins, postseason runs, MLB draft picks, end-of-year awards. The user
 * spends those points to bump one of the four coach ratings (developer,
 * motivator, recruiter, tactician) by +1 each, up to a cap of 99.
 *
 * AI coaches don't use this system — their ratings drift naturally with
 * tenure + program results, handled elsewhere.
 *
 * State shape:
 *   coach.upgradePoints              integer, currently unspent
 *   coach.upgradePointsEarned        running total across the dynasty
 *   coach.upgradePointsSpent         running total spent
 *   coach.upgradeHistory[]           audit log of every grant/spend
 */

const RATING_CAP = 99
const POINTS_PER_RATING = 1   // 1 point = +1 rating

/** Award upgrade points to the user's head coach. */
export function awardCoachUpgradePoints(state, points, reason) {
  if (!state) return
  const team = state.teams?.[state.userSchoolId]
  if (!team) return
  const coach = state.coaches?.[team.headCoachId]
  if (!coach) return
  coach.upgradePoints = (coach.upgradePoints || 0) + points
  coach.upgradePointsEarned = (coach.upgradePointsEarned || 0) + points
  if (!coach.upgradeHistory) coach.upgradeHistory = []
  coach.upgradeHistory.push({
    kind: 'earn',
    points,
    reason,
    year: state.calendar?.year,
    week: state.calendar?.weekOfYear,
  })
  // Surface in newsfeed if it's a meaningful chunk
  if (points >= 5) {
    state.newsfeed.unshift({
      id: `hc_pts_${state.calendar?.year}_${state.calendar?.weekOfYear}_${Math.random().toString(36).slice(2, 5)}`,
      year: state.calendar?.year, week: state.calendar?.weekOfYear, type: 'AWARD',
      headline: `Coach upgrade: +${points} development points (${reason}).`,
    })
  }
}

/**
 * Spend N points to bump a single coach rating by +1 per point.
 * Returns { ok: boolean, error?: string }.
 */
export function spendCoachUpgradePoints(state, ratingKey, points = 1) {
  const team = state.teams?.[state.userSchoolId]
  if (!team) return { ok: false, error: 'No team.' }
  const coach = state.coaches?.[team.headCoachId]
  if (!coach) return { ok: false, error: 'No head coach.' }
  if (!['developer', 'motivator', 'recruiter', 'tactician'].includes(ratingKey)) {
    return { ok: false, error: 'Unknown rating.' }
  }
  const available = coach.upgradePoints || 0
  if (available < points) return { ok: false, error: `Need ${points} pts, only have ${available}.` }
  const cur = coach[ratingKey] || 50
  const bump = points * POINTS_PER_RATING
  if (cur + bump > RATING_CAP) {
    return { ok: false, error: `Rating capped at ${RATING_CAP}. Can only add ${RATING_CAP - cur}.` }
  }
  coach[ratingKey] = cur + bump
  coach.upgradePoints = available - points
  coach.upgradePointsSpent = (coach.upgradePointsSpent || 0) + points
  if (!coach.upgradeHistory) coach.upgradeHistory = []
  coach.upgradeHistory.push({
    kind: 'spend',
    ratingKey,
    points,
    bumpedTo: coach[ratingKey],
    year: state.calendar?.year,
    week: state.calendar?.weekOfYear,
  })
  return { ok: true, newRating: coach[ratingKey], pointsLeft: coach.upgradePoints }
}

// ─── Earning rules (called from event hooks) ────────────────────────────────

/** Per-game outcome — call after each simulated user game. */
export function awardForGameResult(state, won, opponentRank = null, isConf = false) {
  if (!won) return
  let pts = 2
  if (isConf) pts += 1
  if (opponentRank && opponentRank <= 25) pts += 2
  if (opponentRank && opponentRank <= 10) pts += 1
  awardCoachUpgradePoints(state, pts, `Win${isConf ? ' (conf)' : ''}${opponentRank ? ` over #${opponentRank}` : ''}`)
}

/** Postseason — called when the user advances or wins a round. */
export function awardForPostseason(state, kind) {
  const grant = {
    CONF_TOURNAMENT_WIN: 12,
    OPENING_ROUND_ADVANCE: 8,
    OPENING_ROUND_WIN: 15,
    WORLD_SERIES_APPEARANCE: 18,
    WORLD_SERIES_WIN: 30,
  }[kind]
  if (!grant) return
  awardCoachUpgradePoints(state, grant, kind.replaceAll('_', ' ').toLowerCase())
}

/** End-of-year — called once per spring after the season wraps. */
export function awardForEndOfYearHonors(state, { firstTeam = 0, secondTeam = 0, goldGlove = 0, draftPicks = 0 }) {
  if (firstTeam > 0)  awardCoachUpgradePoints(state, firstTeam * 3, `${firstTeam} All-Conf 1st team`)
  if (secondTeam > 0) awardCoachUpgradePoints(state, secondTeam * 2, `${secondTeam} All-Conf 2nd team`)
  if (goldGlove > 0)  awardCoachUpgradePoints(state, goldGlove * 3, `${goldGlove} Gold Glove`)
  if (draftPicks > 0) awardCoachUpgradePoints(state, draftPicks * 5, `${draftPicks} MLB Draft pick${draftPicks > 1 ? 's' : ''}`)
}
