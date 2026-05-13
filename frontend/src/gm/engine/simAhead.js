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
    byId[p.id] = {
      name: `${p.firstName} ${p.lastName}`,
      pos: p.isPitcher ? 'P' : p.primaryPosition,
      classYear: (p.redshirtUsed ? 'RS-' : '') + p.classYear,
      ovr: playerOverall(p),
      pot: playerPotentialOverall(p),
      happiness: p.happiness?.value ?? 60,
      gpa: p.gpa ?? null,
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
    if (ovrDelta !== 0) ovrChanges.push({ id, name: a.name, pos: a.pos, before: b.ovr, after: a.ovr, delta: ovrDelta })
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
  const limit = Math.min(maxWeeks, weeks ?? maxWeeks)

  while (count < limit) {
    const next = tickOneWeek(save)
    weeklyDiffs.push(diffSnapshots(prev, next))
    prev = next
    count++
    if (untilFn && untilFn(next)) break
    // Safety: bail if we crossed into POSTSEASON or wrapped a year boundary.
    if (next.mode === 'POSTSEASON') break
  }
  return {
    weeksAdvanced: count,
    weeklyDiffs,
    aggregateDiff: diffSnapshots(start, prev),
    finalSnapshot: prev,
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
    presets.push({ key: '3WK', label: 'Sim 3 weeks', est: 3, untilFn: null, weeks: 3 })
    presets.push({ key: 'TO_CONF', label: 'Sim to Conference Open (Wk 4)', est: Math.max(0, 4 - (cal.seasonWeek || 0)), untilFn: snap => snap.seasonWeek >= 4, hideIf: (cal.seasonWeek || 0) >= 4 })
    presets.push({ key: 'TO_POST', label: 'Sim to end of regular season', est: 14 - (cal.seasonWeek || 1), untilFn: snap => snap.mode !== 'SEASON' })
  }

  return presets.filter(p => !p.hideIf)
}

/** Render-friendly phase label for a snapshot (used in diff cards). */
export function phaseLabel(snap) {
  if (snap.mode === 'OFFSEASON') return offseasonPhase(snap.offseasonWeek) + ' — Wk ' + snap.offseasonWeek
  if (snap.mode === 'SEASON') return 'Season Wk ' + snap.seasonWeek
  if (snap.mode === 'POSTSEASON') return 'Postseason'
  return ''
}
