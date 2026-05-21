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
  // Realism cap: a full 4-game series with a hot bat playing every game can
  // legitimately reach ~20-22 AB (5 PA × 4 games). Only disqualify lines well
  // beyond that (>26 AB ≈ 6+ games), which only happen when a team got
  // double-booked into two series that week — a scheduling artifact that would
  // otherwise produce an impossible "11-for-28" Player of the Week.
  if ((s.ab || 0) > 26) return -Infinity
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
  // Realism cap: a weekend Pitcher-of-the-Week threw ONE strong start (~6-8
  // IP). With the leverage-based hook a starter rarely exceeds ~24 outs, so
  // anything past ~25 outs (8.1 IP) means the arm pitched in TWO games that
  // weekend (start + relief) — not a believable POTW line. Disqualify those.
  if (outs > 25) return -Infinity
  return outs - (s.er || 0) * 3 - (s.bb || 0) * 1.5 - (s.hr || 0) * 4 + (s.k || 0) * 0.5
}

// Minimum WEEK score to merit a Player-of-the-Week. Prevents embarrassing
// winners (a 1-for-15 hitter, or a 5.1-IP / 5-ER pitcher) from "winning" in a
// thin week where few teams played — better to award nobody than a bad line.
// A real POTW week (e.g. 7+ total bases, or a 6-IP/2-ER quality start) clears
// these comfortably at every level.
const MIN_HITTER_WEEK_SCORE = 7
const MIN_PITCHER_WEEK_SCORE = 8

/**
 * Pick the best player matching `predicate` from a stats map using `scoreFn`.
 * Returns { playerId, score, stats } or null. `minScore` gates out weak
 * winners — if the best qualifier doesn't clear it, nobody wins.
 */
function pickBest(weeklyStats, predicate, scoreFn, minScore = -Infinity) {
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
  return bestScore >= minScore ? best : null
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
  // Each Player-of-the-Week is a small +1 to every rating in the relevant
  // block (was +3 for NAIA — far too much, a repeat winner ballooned to 99).
  // Conf POTW and NAIA POTW each give +1, so winning both in a week stacks to
  // +2 total, per Nate.
  const bump = 1
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
  // Coach upgrade points — points should be SCARCE (per Nate). A weekly
  // conference POTW is flavor (0 coach points); only the national POTW grants
  // a single point.
  const pts = scope === 'NAIA' ? 1 : 0
  if (pts > 0) {
    awardCoachUpgradePoints(state, pts,
      `National ${kind === 'HITTER' ? 'Hitter' : 'Pitcher'} of the Week (${p.firstName} ${p.lastName})`,
    )
  }
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

  // CONFERENCE-ONLY awards (per Nate): no national/NAIA Player of the Week —
  // only conference Hitter/Pitcher of the Week honors.
  // Conference winners — one set per conference
  const confWinners = {}
  for (const confId of Object.keys(state.conferences || {})) {
    confWinners[confId] = {
      hitter: pickBest(weekly,
        (s) => !s.isPitcher && playerConf[s.playerId] === confId,
        hitterWeekScore, MIN_HITTER_WEEK_SCORE),
      pitcher: pickBest(weekly,
        (s) => s.isPitcher && playerConf[s.playerId] === confId,
        pitcherWeekScore, MIN_PITCHER_WEEK_SCORE),
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
    // NOTE: the rating reward + newsfeed + popup are applied at REVEAL time
    // (next week — see revealWeeklyAwards), not here, so POTW is announced the
    // following week like real life.
  }

  for (const [confId, w] of Object.entries(confWinners)) {
    const conf = state.conferences[confId]
    record('CONF', 'HITTER',  w.hitter,  conf?.name || conf?.abbreviation)
    record('CONF', 'PITCHER', w.pitcher, conf?.name || conf?.abbreviation)
  }

  // DEFERRED REVEAL (per Nate): don't surface this week's POTW yet — queue it
  // so it's announced when the user sims the NEXT week ("last week's POTW").
  // revealWeeklyAwards (called at the start of the next game-week tick) does
  // the newsfeed push, the rating rewards, the history store, and flags any
  // user-team winners for a popup.
  state._pendingPotw = {
    year: state.calendar?.year ?? 0,
    week: state.calendar?.weekOfYear ?? 0,
    out,
  }

  return out
}

/**
 * Reveal the PREVIOUS week's queued Player-of-the-Week awards: applies the
 * small rating rewards, posts the newsfeed lines, stores them in
 * weeklyAwardsHistory for the Dashboard widget, and stashes any user-team
 * winners on state._potwUserWinners so the Dashboard can pop a celebratory
 * modal. Safe to call every game-week tick (no-op when nothing is queued).
 */
export function revealWeeklyAwards(state) {
  const pend = state._pendingPotw
  if (!pend || !Array.isArray(pend.out) || pend.out.length === 0) {
    state._pendingPotw = null
    return []
  }
  const { year: yr, week: wk, out } = pend
  const userTeam = state.teams?.[state.userSchoolId]
  const userConfId = state.schools?.[state.userSchoolId]?.conferenceId
  const userWinners = []

  for (const a of out) {
    // Apply the (small, +1) rating reward to the user's player + coach points.
    rewardUserPlayer(state, a.playerId, a.kind, a.scope)

    const isUserConf = a.scope === 'CONF' && a.conferenceName === state.conferences?.[userConfId]?.name
    const isNaia = a.scope === 'NAIA'
    const isYours = !!userTeam?.rosterPlayerIds?.includes(a.playerId)
    if (isYours && (isNaia || a.scope === 'CONF')) userWinners.push(a)
    // Newsfeed: only the user's conference + national winners (too noisy otherwise)
    if (!isUserConf && !isNaia) continue
    // National label adapts to the dynasty's level (NAIA / D2 / D1 / D3 / NWAC).
    const natLabel = (state.level && state.level !== 'NAIA') ? state.level : 'NAIA'
    const scopeLabel = a.scope === 'NAIA' ? natLabel : (a.conferenceName || 'Conf')
    const kindLabel = a.kind === 'HITTER' ? 'Hitter' : 'Pitcher'
    state.newsfeed = state.newsfeed || []
    state.newsfeed.unshift({
      id: `award_${a.playerId}_${a.scope}_${a.kind}_${yr}_${wk}`,
      year: yr, week: wk, type: 'AWARD',
      headline: `${scopeLabel} ${kindLabel} of the Week: ${a.playerName} (${a.schoolName}) — ${a.statsLine}${isYours ? ' [your player]' : ''}`,
      payload: { playerId: a.playerId, scope: a.scope, kind: a.kind },
      big: isYours,
    })
  }

  // Persist into state.weeklyAwardsHistory for the Dashboard widget (revealed
  // a week late, matching the delayed announcement).
  if (!state.weeklyAwardsHistory) state.weeklyAwardsHistory = {}
  if (!state.weeklyAwardsHistory[yr]) state.weeklyAwardsHistory[yr] = {}
  state.weeklyAwardsHistory[yr][wk] = out

  // Stash user winners (deduped by player+scope+kind) for the Dashboard popup.
  if (userWinners.length > 0) {
    state._potwUserWinners = [
      ...(state._potwUserWinners || []),
      ...userWinners.map(a => ({
        playerId: a.playerId, playerName: a.playerName, schoolName: a.schoolName,
        scope: a.scope, kind: a.kind, statsLine: a.statsLine, week: wk,
      })),
    ]
  }
  state._pendingPotw = null
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
