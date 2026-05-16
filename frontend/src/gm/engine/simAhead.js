/**
 * Sim-ahead helpers: snapshot relevant state, advance N weeks, and produce
 * per-week diffs (rating changes, happiness shifts, GPA, budget, record).
 *
 * Designed to be called from the Dashboard "Sim to milestone" controls.
 */

import { playerOverall, playerPotentialOverall } from './playerRating'
import { advanceWeek, advanceOffseasonWeek, simWeek } from './season'
import { seedFromPear } from './rankings'
import { offseasonPhase } from './calendar'
import { happinessLevel } from './happiness'

/**
 * Capture the slice of save state we want to diff. Keep this small — full save
 * snapshots are expensive and most fields are noise.
 *
 * @param {import('./types.js').SaveState} save
 */
export function snapshotState(save) {
  const team = save.teams[save.userSchoolId]
  const players = team.rosterPlayerIds.map(id => save.players[id]).filter(Boolean)
  const byId = {}
  for (const p of players) {
    // Capture the FULL rating block so we can render a per-stat diff in the
    // week recap. Shallow copy is enough; ratings are flat numbers.
    const ratings = p.isPitcher ? { ...(p.pitcher || {}) } : { ...(p.hitter || {}) }
    byId[p.id] = {
      name: `${p.firstName} ${p.lastName}`,
      pos: p.isPitcher ? 'P' : p.primaryPosition,
      classYear: (p.redshirtUsed ? 'RS-' : '') + p.classYear,
      ovr: playerOverall(p),
      pot: playerPotentialOverall(p),
      happiness: p.happiness?.value ?? 60,
      gpa: p.gpa ?? null,
      isPitcher: !!p.isPitcher,
      ratings,
    }
  }
  return {
    week: save.calendar.week,
    seasonWeek: save.calendar.seasonWeek,
    offseasonWeek: save.calendar.offseasonWeek,
    mode: save.calendar.mode,
    players: byId,
    budget: save.budget?.totalAthleticBudget ?? 0,
    jobSecurity: save.budget?.jobSecurity ?? 50,
    ap: save.ap?.currentWeek ?? 0,
    wins: team.wins,
    losses: team.losses,
    runDiff: team.runDiff,
  }
}

/**
 * Diff two snapshots into something the UI can render.
 *
 * Players with no meaningful change are dropped. Players who appeared or
 * disappeared between snapshots (transfers / graduations) are noted.
 */
export function diffSnapshots(before, after) {
  const ovrChanges = []
  const happinessChanges = []
  const gpaChanges = []
  const departed = []
  const arrived = []

  for (const [id, b] of Object.entries(before.players)) {
    const a = after.players[id]
    if (!a) {
      departed.push({ id, ...b })
      continue
    }
    const ovrDelta = a.ovr - b.ovr
    if (ovrDelta !== 0) {
      // Compute per-stat diff so the recap row can show WHICH ratings moved.
      const statDiffs = []
      const bRatings = b.ratings || {}
      const aRatings = a.ratings || {}
      for (const k of Object.keys(aRatings)) {
        if (k.startsWith('velocity')) continue   // velo is a measurable, not a 0-99 rating
        const bv = bRatings[k]
        const av = aRatings[k]
        if (typeof bv !== 'number' || typeof av !== 'number') continue
        const d = av - bv
        if (Math.abs(d) >= 0.5) {
          statDiffs.push({ stat: k, before: bv, after: av, delta: d })
        }
      }
      statDiffs.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
      ovrChanges.push({
        id, name: a.name, pos: a.pos, isPitcher: a.isPitcher,
        before: b.ovr, after: a.ovr, delta: ovrDelta,
        statDiffs,
      })
    }
    const hDelta = a.happiness - b.happiness
    if (Math.abs(hDelta) >= 3) happinessChanges.push({
      id, name: a.name, pos: a.pos,
      before: b.happiness, after: a.happiness, delta: hDelta,
      beforeLevel: happinessLevel(b.happiness),
      afterLevel: happinessLevel(a.happiness),
    })
    if (b.gpa != null && a.gpa != null && Math.abs(a.gpa - b.gpa) >= 0.02) {
      gpaChanges.push({ id, name: a.name, before: b.gpa, after: a.gpa, delta: a.gpa - b.gpa })
    }
  }
  for (const [id, a] of Object.entries(after.players)) {
    if (!before.players[id]) arrived.push({ id, ...a })
  }

  // Sort by absolute delta so the biggest movers float to the top.
  ovrChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  happinessChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  gpaChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  return {
    fromWeek: before.week,
    toWeek: after.week,
    fromMode: before.mode,
    toMode: after.mode,
    fromOffseasonWeek: before.offseasonWeek,
    toOffseasonWeek: after.offseasonWeek,
    fromSeasonWeek: before.seasonWeek,
    toSeasonWeek: after.seasonWeek,
    ovrChanges, happinessChanges, gpaChanges,
    departed, arrived,
    budgetDelta: after.budget - before.budget,
    jobSecurityDelta: after.jobSecurity - before.jobSecurity,
    recordDelta: { w: after.wins - before.wins, l: after.losses - before.losses },
    runDiffDelta: after.runDiff - before.runDiff,
  }
}

/**
 * Advance exactly one week. Used both by the existing "Sim Next Week" button
 * and by the multi-week sim-ahead loop. Returns the new snapshot.
 */
export function tickOneWeek(save) {
  if (save.calendar.mode === 'OFFSEASON') {
    advanceOffseasonWeek(save)
  } else if (save.calendar.mode === 'SEASON') {
    const ratings = seedFromPear(save.schools, save.conferences)
    simWeek(save, save.schedule, ratings)
    advanceWeek(save, save.schedule)
  }
  return snapshotState(save)
}

/**
 * Sim multiple weeks. Caller passes `weeks` (positive integer) or a `untilFn`
 * predicate that receives the post-tick snapshot and returns true to stop.
 *
 * Returns:
 *   - finalSnapshot
 *   - weeklyDiffs: array of per-week diffs (one entry per tick), oldest first
 *   - aggregateDiff: a single diff from the start snapshot to the final snapshot
 */
export function simAhead(save, { weeks, untilFn, maxWeeks = 26 } = {}) {
  const start = snapshotState(save)
  const weeklyDiffs = []
  let prev = start
  let count = 0
  let stoppedReason = null
  const limit = Math.min(maxWeeks, weeks ?? maxWeeks)

  while (count < limit) {
    // HARD STOP before triggering postseason. advanceWeek runs the full
    // postseason + end-of-year machinery synchronously (all conference
    // tournaments, all-team development, MLB draft, transfers, academics,
    // budget review, portal gen) — that can lock the main thread for many
    // seconds with 199 schools. Better to leave the user at seasonWeek=13
    // and let them click "Advance Week" once manually to trigger it.
    if (save.calendar.mode === 'SEASON' && (save.calendar.seasonWeek ?? 0) >= 13) {
      stoppedReason = 'postseason_boundary'
      break
    }
    // HARD STOP before Prospect Camp (Wk 13). The user MUST run their camp
    // — sim-ahead never silently skips it.
    if ((save.calendar.weekOfYear ?? 0) === 12) {
      // We're sitting at wk 12. The NEXT tick would land on wk 13 (camp).
      // Stop if the user hasn't held this year's camp yet.
      if (save.prospectCamp?.year !== save.calendar.year) {
        stoppedReason = 'prospect_camp_boundary'
        break
      }
    }
    const next = tickOneWeek(save)
    weeklyDiffs.push(diffSnapshots(prev, next))
    prev = next
    count++
    if (untilFn && untilFn(next)) break
    if (next.mode === 'POSTSEASON') break
    // After the tick: stop if the user has unplayed games this week so they
    // can play them live OR explicitly auto-sim. Avoids the "I just simmed
    // past 4 unplayed scrim weeks" trap.
    if (hasUnplayedUserGamesThisWeek(save)) {
      stoppedReason = 'user_games_pending'
      break
    }
  }
  return {
    weeksAdvanced: count,
    weeklyDiffs,
    aggregateDiff: diffSnapshots(start, prev),
    finalSnapshot: prev,
    stoppedReason,
  }
}

/**
 * Build a list of "Sim to X" presets based on where the calendar currently is.
 * Each preset is { key, label, untilFn, est } where est is an estimated # of
 * weeks (for the button label).
 */
export function simPresets(save) {
  const cal = save.calendar
  const presets = []
  presets.push({ key: '1WK', label: 'Sim 1 week', est: 1, untilFn: () => true })

  if (cal.mode === 'OFFSEASON') {
    const ow = cal.offseasonWeek
    if (ow < 5) {
      presets.push({ key: 'TO_FALL', label: 'Sim to Fall Camp', est: 5 - ow, untilFn: snap => snap.offseasonWeek >= 5 })
    }
    if (ow < 14) {
      presets.push({ key: 'TO_TRAIN', label: 'Sim to Training Period (Nov)', est: 14 - ow, untilFn: snap => snap.offseasonWeek >= 14 })
    }
    if (ow < 22) {
      presets.push({ key: 'TO_SPRING', label: 'Sim to Spring Practice', est: 22 - ow, untilFn: snap => snap.offseasonWeek >= 22 })
    }
    presets.push({ key: 'TO_SEASON', label: 'Sim to Opening Day', est: 27 - ow, untilFn: snap => snap.mode === 'SEASON' })
  } else if (cal.mode === 'SEASON') {
    const sw = cal.seasonWeek || 1
    presets.push({ key: '3WK', label: 'Sim 3 weeks', est: 3, untilFn: null, weeks: 3 })
    presets.push({ key: 'TO_CONF', label: 'Sim to Conference Open (Wk 4)', est: Math.max(0, 4 - sw), untilFn: snap => snap.seasonWeek >= 4, hideIf: sw >= 4 })
    // Stops at seasonWeek=13 (one game-week before postseason). Avoids the
    // long synchronous postseason+end-of-year tick that hangs the browser.
    presets.push({
      key: 'TO_END',
      label: 'Sim to Week 13',
      est: Math.max(0, 13 - sw),
      untilFn: snap => snap.seasonWeek >= 13,
      hideIf: sw >= 13,
    })
  }

  return presets.filter(p => !p.hideIf)
}

/**
 * Does the user have any unplayed games scheduled for the current week-of-
 * year? Fall scrimmages (offseason wks 9-13) and regular-season games both
 * count.
 */
function hasUnplayedUserGamesThisWeek(save) {
  const wk = save.calendar.weekOfYear
  const sw = save.calendar.seasonWeek
  const userId = save.userSchoolId
  for (const g of save.schedule || []) {
    if (g.played) continue
    if (g.type === 'BYE' || g.awayId === '__BYE__') continue
    if (g.homeId !== userId && g.awayId !== userId) continue
    if (g.seasonWeek === sw && sw != null) return true
    if (g.weekOfYear === wk && wk != null) return true
  }
  return false
}

/** Render-friendly phase label for a snapshot (used in diff cards). */
export function phaseLabel(snap) {
  if (snap.mode === 'OFFSEASON') return offseasonPhase(snap.offseasonWeek) + ' — Wk ' + snap.offseasonWeek
  if (snap.mode === 'SEASON') return 'Season Wk ' + snap.seasonWeek
  if (snap.mode === 'POSTSEASON') return 'Postseason'
  return ''
}
