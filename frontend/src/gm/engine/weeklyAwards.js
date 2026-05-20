/**
 * Conference + NAIA Hitter / Pitcher of the Week.
 *
 * Computed at the end of every regular-season simWeek tick. Picks the
 * best hitter + best pitcher from the games that were just played, at
 * two scopes:
 *   - Conference: best in the user's conference only (and each other conf)
 *   - NAIA national: best across the whole league
 *
 * Player reward: if a user's player wins ANY of the four (conf or NAIA
 * hitter/pitcher), they get a small permanent rating bump on the relevant
 * pillar (+0.5 contact for a hitter award, +0.5 stuff for a pitcher award),
 * the coach gets +1 upgrade point for the conf award + an extra +1 for a
 * NAIA award.
 *
 * Awards are pushed to state.newsfeed as headlines and also accumulated
 * into state.weeklyAwardsHistory[year][weekOfYear] so the Dashboard can
 * surface a "this week's awards" widget.
 */

import { awardCoachUpgradePoints } from './coachProgression'

/**
 * Score a hitter's WEEK (not season). Higher = better.
 * Heuristic: total bases + walks/hbp + RBIs - strikeouts × 0.4.
 * Minimum 4 plate appearances to qualify.
 */
function hitterWeekScore(s) {
  const pa = s.pa || 0
  if (pa < 4) return -Infinity
  // Realism cap: a normal weekend is a 3-4 game series (~12-18 AB). A line far
  // beyond that means the team got double-booked into two series that week (a
  // scheduling artifact) — disqualify those so Player of the Week reflects a
  // real weekend, not a double-counted "11-for-28".
  if ((s.ab || 0) > 20) return -Infinity
  const singles = (s.h || 0) - (s.d || 0) - (s.t || 0) - (s.hr || 0)
  const tb = singles + (s.d || 0) * 2 + (s.t || 0) * 3 + (s.hr || 0) * 4
  return tb + (s.bb || 0) + (s.hbp || 0) + (s.rbi || 0) * 0.6 - (s.k || 0) * 0.4
}

/**
 * Score a pitcher's WEEK. Higher = better.
 * Heuristic: K rate bonus + outs - earned runs × 3 - walks × 1.5 - HRs × 4.
 * Minimum 5 IP (15 outs) to qualify.
 */
function pitcherWeekScore(s) {
  const outs = s.outs || 0
  if (outs < 15) return -Infinity
  // Realism cap: one pitcher won't legitimately throw more than ~10 IP (30
  // outs) in a weekend. More than that is a double-booked-team artifact (the
  // 16+ IP weekly lines) — disqualify so awards stay believable.
  if (outs > 30) return -Infinity
  return outs - (s.er || 0) * 3 - (s.bb || 0) * 1.5 - (s.hr || 0) * 4 + (s.k || 0) * 0.5
}

/**
 * Pick the best player matching `predicate` from a stats map using `scoreFn`.
 * Returns { playerId, score, stats } or null.
 */
function pickBest(weeklyStats, predicate, scoreFn) {
  let best = null
  let bestScore = -Infinity
  for (const [key, stats] of Object.entries(weeklyStats || {})) {
    if (!predicate(stats)) continue
    const score = scoreFn(stats)
    if (score > bestScore) {
      bestScore = score
      best = { playerId: stats.playerId, score, stats }
    }
  }
  return best
}

/**
 * Apply award rewards to a user's player + coach.
 *
 * Magnitude per Nate (May 2026):
 *   - Conference POTW: +1 to EVERY rating in the relevant block
 *   - NAIA national POTW: +3 to EVERY rating in the relevant block
 *
 * Hitters bump every hitter stat (contact_l/r, power_l/r, discipline,
 * speed, fielding, arm, composure, durability). Pitchers bump every
 * pitcher stat (stuff, control, command, stamina, vs_l, vs_r,
 * composure, durability). Awards stack across the season so a perennial
 * player-of-the-week winner sees big growth.
 *
 * Coach upgrade points: +1 for conf, +2 more for NAIA national.
 */
function rewardUserPlayer(state, playerId, kind, scope) {
  const p = state.players?.[playerId]
  if (!p) return
  const isUser = state.teams?.[state.userSchoolId]?.rosterPlayerIds?.includes(playerId)
  if (!isUser) return
  const bump = scope === 'NAIA' ? 3 : 1
  if (kind === 'HITTER' && p.hitter) {
    for (const key of Object.keys(p.hitter)) {
      if (typeof p.hitter[key] === 'number') {
        p.hitter[key] = Math.min(99, p.hitter[key] + bump)
      }
    }
  } else if (kind === 'PITCHER' && p.pitcher) {
    for (const key of Object.keys(p.pitcher)) {
      if (typeof p.pitcher[key] === 'number') {
        p.pitcher[key] = Math.min(99, p.pitcher[key] + bump)
      }
    }
  }
  // Coach upgrade points
  awardCoachUpgradePoints(state, scope === 'NAIA' ? 2 : 1,
    `${scope === 'NAIA' ? 'NAIA' : 'Conf'} ${kind === 'HITTER' ? 'Hitter' : 'Pitcher'} of the Week (${p.firstName} ${p.lastName})`,
  )
}

/**
 * Compute + apply weekly awards. Called from season.simWeek at the end of
 * each regular-season week. Reads state.weeklyStats (per-week aggregate
 * the same shape as state.playerStats — populated by simWeek).
 *
 * @returns {Array<{ scope, kind, playerId, playerName, schoolId, schoolName, conferenceName, statsLine }>}
 */
export function computeWeeklyAwards(state) {
  const weekly = state.weeklyStats || {}
  // Skip when nobody played this week (e.g. bye week, fall scrimmage weeks)
  if (Object.keys(weekly).length === 0) return []

  const playerById = state.players || {}
  // Build a playerId → conferenceId map so we can scope conference awards
  const playerConf = {}
  for (const team of Object.values(state.teams || {})) {
    const confId = state.schools?.[team.schoolId]?.conferenceId
    if (!confId) continue
    for (const pid of (team.rosterPlayerIds || [])) playerConf[pid] = confId
  }

  // NAIA-wide winners
  const naiaHitter = pickBest(weekly,
    (s) => !s.isPitcher && playerById[s.playerId],
    hitterWeekScore)
  const naiaPitcher = pickBest(weekly,
    (s) => s.isPitcher && playerById[s.playerId],
    pitcherWeekScore)

  // Conference winners — one set per conference
  const confWinners = {}
  for (const confId of Object.keys(state.conferences || {})) {
    confWinners[confId] = {
      hitter: pickBest(weekly,
        (s) => !s.isPitcher && playerConf[s.playerId] === confId,
        hitterWeekScore),
      pitcher: pickBest(weekly,
        (s) => s.isPitcher && playerConf[s.playerId] === confId,
        pitcherWeekScore),
    }
  }

  // Build award records + apply rewards
  const out = []
  function record(scope, kind, winner, conferenceName) {
    if (!winner) return
    const p = playerById[winner.playerId]
    if (!p) return
    const schoolId = playerConf[winner.playerId]
      ? state.conferences[playerConf[winner.playerId]]?.schoolIds?.find(sid =>
          state.teams[sid]?.rosterPlayerIds?.includes(winner.playerId))
      : null
    const school = state.schools?.[schoolId]
    const line = formatStatLine(winner.stats, kind)
    out.push({
      scope, kind,
      playerId: winner.playerId,
      playerName: `${p.firstName} ${p.lastName}`,
      schoolId, schoolName: school?.name || '',
      conferenceName: conferenceName || '',
      statsLine: line,
    })
    rewardUserPlayer(state, winner.playerId, kind, scope)
  }

  // NAIA national first (higher-profile)
  record('NAIA', 'HITTER',  naiaHitter,  null)
  record('NAIA', 'PITCHER', naiaPitcher, null)
  for (const [confId, w] of Object.entries(confWinners)) {
    const conf = state.conferences[confId]
    record('CONF', 'HITTER',  w.hitter,  conf?.name || conf?.abbreviation)
    record('CONF', 'PITCHER', w.pitcher, conf?.name || conf?.abbreviation)
  }

  // Push to newsfeed (only the user's conference + NAIA winners — too noisy
  // to surface every conference's POTW every week)
  const userConfId = state.schools?.[state.userSchoolId]?.conferenceId
  for (const a of out) {
    const isUserConf = a.scope === 'CONF' && a.conferenceName === state.conferences?.[userConfId]?.name
    const isNaia = a.scope === 'NAIA'
    if (!isUserConf && !isNaia) continue
    const userTeam = state.teams?.[state.userSchoolId]
    const isYours = userTeam?.rosterPlayerIds?.includes(a.playerId)
    const scopeLabel = a.scope === 'NAIA' ? 'NAIA' : (a.conferenceName || 'Conf')
    const kindLabel = a.kind === 'HITTER' ? 'Hitter' : 'Pitcher'
    state.newsfeed.unshift({
      id: `award_${a.playerId}_${a.scope}_${a.kind}_${state.calendar?.year}_${state.calendar?.weekOfYear}`,
      year: state.calendar?.year, week: state.calendar?.week, type: 'AWARD',
      headline: `${scopeLabel} ${kindLabel} of the Week: ${a.playerName} (${a.schoolName}) — ${a.statsLine}${isYours ? ' [your player]' : ''}`,
      payload: { playerId: a.playerId, scope: a.scope, kind: a.kind },
      big: isYours,
    })
  }

  // Persist into state.weeklyAwardsHistory for the Dashboard widget
  if (!state.weeklyAwardsHistory) state.weeklyAwardsHistory = {}
  const yr = state.calendar?.year ?? 0
  const wk = state.calendar?.weekOfYear ?? 0
  if (!state.weeklyAwardsHistory[yr]) state.weeklyAwardsHistory[yr] = {}
  state.weeklyAwardsHistory[yr][wk] = out

  return out
}

/** "5-for-12, 2 HR, 6 RBI, 2 BB" or "8.2 IP, 0 ER, 11 K, 1 BB" */
function formatStatLine(s, kind) {
  if (kind === 'HITTER') {
    const ab = s.ab || 0
    const h = s.h || 0
    const parts = [`${h}-for-${ab}`]
    if (s.hr) parts.push(`${s.hr} HR`)
    if (s.t) parts.push(`${s.t} 3B`)
    if (s.d) parts.push(`${s.d} 2B`)
    if (s.rbi) parts.push(`${s.rbi} RBI`)
    if (s.bb) parts.push(`${s.bb} BB`)
    return parts.join(', ')
  }
  // Pitcher
  const ip = `${Math.floor((s.outs || 0) / 3)}.${(s.outs || 0) % 3}`
  const parts = [`${ip} IP`]
  parts.push(`${s.er || 0} ER`)
  parts.push(`${s.k || 0} K`)
  if (s.bb) parts.push(`${s.bb} BB`)
  if (s.h) parts.push(`${s.h} H`)
  return parts.join(', ')
}
