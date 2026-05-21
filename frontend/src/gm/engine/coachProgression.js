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

/**
 * AUTO MODE: spend all available upgrade points, spreading them evenly across
 * the four coach ratings. "Evenly" = always raise the LOWEST-rated non-capped
 * stat, so the four ratings stay as balanced as possible. Returns the number
 * of points spent.
 */
export function autoUpgradeCoach(state) {
  const team = state.teams?.[state.userSchoolId]
  if (!team) return 0
  const coach = state.coaches?.[team.headCoachId]
  if (!coach) return 0
  const keys = ['developer', 'motivator', 'recruiter', 'tactician']
  let spent = 0
  // Guard against an infinite loop if every stat is capped.
  while ((coach.upgradePoints || 0) > 0) {
    const open = keys.filter(k => (coach[k] || 50) < RATING_CAP)
    if (open.length === 0) break
    open.sort((a, b) => (coach[a] || 50) - (coach[b] || 50))
    const res = spendCoachUpgradePoints(state, open[0], 1)
    if (!res.ok) break
    spent++
  }
  return spent
}

// ─── Earning rules (called from event hooks) ────────────────────────────────

/**
 * Per-game outcome — call after each simulated user game.
 *
 * Tuned DOWN (May 2026): a routine win is worth 1 point (was 2 + a flat conf
 * bonus, which handed out ~6-7 points in a single 2-1 conference week — way
 * too fast). Now a typical 2-win week earns 2 points; the only premium left is
 * for genuinely big wins over nationally-ranked opponents, so points still
 * feel earned but accumulate at a much slower clip. Postseason runs + end-of-
 * year honors remain the real engine for upgrade points.
 */
export function awardForGameResult(state, won, opponentRank = null, isConf = false) {
  if (!won) return
  // Points are SCARCE. Routine wins earn nothing; only a win over a top-10
  // national team earns a single point (the season baseline + postseason +
  // honors are the real engine).
  if (!(opponentRank && opponentRank <= 10)) return
  awardCoachUpgradePoints(state, 1, `Win over #${opponentRank}`)
}

/** Postseason — called when the user advances or wins a round. */
export function awardForPostseason(state, kind) {
  // Scaled down (May 2026) so a deep postseason run is meaningful but not the
  // bulk of a coach's yearly points. Winning it all ≈ +14 across the bracket.
  const grant = {
    CONF_TOURNAMENT_WIN: 1,
    OPENING_ROUND_ADVANCE: 1,
    OPENING_ROUND_WIN: 1,
    WORLD_SERIES_APPEARANCE: 2,
    WORLD_SERIES_WIN: 2,
  }[kind]
  if (!grant) return
  awardCoachUpgradePoints(state, grant, kind.replaceAll('_', ' ').toLowerCase())
}

/** End-of-year — called once per spring after the season wraps. Honors are a
 * small bonus on top of the record-scaled season baseline. */
export function awardForEndOfYearHonors(state, { firstTeam = 0, secondTeam = 0, goldGlove = 0, draftPicks = 0 }) {
  if (firstTeam > 0)  awardCoachUpgradePoints(state, firstTeam, `${firstTeam} All-Conf 1st team`)
  if (draftPicks > 0) awardCoachUpgradePoints(state, draftPicks, `${draftPicks} MLB Draft pick${draftPicks > 1 ? 's' : ''}`)
  // 2nd team + Gold Glove no longer grant coach points (they piled up fast on
  // a loaded roster); the season baseline + 1st-team + draft cover honors.
}

/**
 * Per-season coaching baseline — the BULK of a coach's yearly upgrade points,
 * scaled by the team's record. Targets Nate's range: a great team (~40+ wins)
 * ≈ 18 baseline, a bad team (~12 wins) ≈ 9-10. With the (small) postseason +
 * honors bonuses on top, a great coach lands ~25/yr and a poor one ~10/yr.
 * Call once per season.
 */
export function awardSeasonCoachingBaseline(state) {
  const team = state.teams?.[state.userSchoolId]
  if (!team) return
  const wins = team.wins || 0
  // Floor of 7 (coaching a full season) + ~0.28/win, capped at 18.
  const pts = Math.max(7, Math.min(18, Math.round(7 + wins * 0.28)))
  awardCoachUpgradePoints(state, pts, `Season coaching (${wins} wins)`)
}
